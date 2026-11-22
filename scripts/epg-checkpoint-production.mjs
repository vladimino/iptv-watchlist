#!/usr/bin/env node
// Production operator for the EPG checkpoint authority (ADR 0185, runbook docs/runbooks/epg-checkpoint-d1.md). Default is read-only `status`.
// Every state change is one named command with an exact fail-closed contract, a `--confirm <command>` token, the expected generation and a
// readback. Nothing is retried: after an unknown outcome the marker is read and reported, never replayed. Raw payloads are never printed:
// only sizes, ETags and SHA-256 digests. The D1 token goes only to the Cloudflare API and only for database iptv. No command resets a lease,
// restarts a Workflow, starts an EPG run or deletes a D1 row. Which command may run, and when, is decided by the owner-approved L3 plan.
//
//   status                                   read-only: schema, marker, run, orchestration, lease, pause, R2 identities, drain proof
//   apply         migration 0030 only        schema exactly 29, tables absent, no executing EPG step; none of the cutover evidence
//   hold          r2/open  G -> r2/held  G+1       (a1)
//   release-abort r2/held  G -> r2/open  G         (a2) no imported rows
//   import        rows from the frozen R2 objects  r2/held G, empty tables, identity equal to the one the owner approved
//   activate      r2/held  G -> d1/held  G+1       parity of the imported rows
//   release       d1/held  G -> d1/open  G         (b)
//   hold-rollback d1/open  G -> d1/held  G+1       (c) idle complete boundary with a certificate
//   export-rollback  D1 rows -> the two R2 objects, conditional PUT on the frozen ETags, readback
//   revert-authority d1/held G -> r2/held G+1      (d) only after both objects read back equal to the D1 rows; D1 rows are kept
//   release-rolled-back r2/held G -> r2/open G     (e)
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter,renderSql} from './d1-backfill.mjs';
import {createS3Store,InstallError,readInstallCredentials} from './r2-s3-store.mjs';
import {readCredentials} from './r2-snapshot-export.mjs';
import {BATCH_BYTES,BATCH_STATEMENTS,createPublishedBinding,migrationStatements,normalize,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import * as Checkpoint from '../src/epg-checkpoint-d1.js';
import {EPG_SCHEDULE,nextDailyDue} from '../src/domain/orchestration-policy.js';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const MIGRATION_PATH=path.join(ROOT,'migrations/0030_epg_checkpoint_authority.sql');
export const KEYS={sync:'sync.json',ingest:'watchlist-ingest.json'};
export const LIMITS=Checkpoint.LIMITS;
export const NEXT_START_MARGIN_MS=30*60*1000;
export const COMMANDS=['status','apply','hold','release-abort','import','activate','release','hold-rollback','export-rollback','revert-authority','release-rolled-back'];
const TABLES=['epg_checkpoint_authority','epg_checkpoint_cas','epg_checkpoint_run','epg_checkpoint_body','epg_checkpoint_film','epg_checkpoint_receipt','epg_ingest_status'];
const FENCE='UPDATE epg_checkpoint_cas SET ok=changes() WHERE id=1';
const GUARD=expression=>['INSERT INTO epg_checkpoint_cas (id, ok) SELECT 1, '+expression+' WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok'];
const sha256=value=>createHash('sha256').update(value).digest('hex');
const iso=ms=>new Date(ms).toISOString();
const GLOB_DAY=/^\d{4}-\d{2}-\d{2}$/;

async function one(binding,sql,params=[]){return (await binding.prepare(sql).bind(...params).first())??null;}
async function many(binding,sql,params=[]){return (await binding.prepare(sql).bind(...params).all()).results||[];}
async function batch(binding,statements){return binding.batch(statements.map(([sql,params])=>binding.prepare(sql).bind(...(params||[]))));}
const json=text=>{try{return JSON.parse(text);}catch{return undefined;}};

// ---- state (D1, read-only) ------------------------------------------------------------------------------------------------
export async function readState(binding){
 try{
  const version=Number((await one(binding,'SELECT version FROM schema_contract WHERE id=1'))?.version);
  const names=(await many(binding,"SELECT name FROM sqlite_master WHERE type='table'")).map(row=>row.name);
  const present=TABLES.filter(name=>names.includes(name));
  const state={schemaVersion:Number.isFinite(version)?version:null,tables:{present:present.length,expected:TABLES.length},marker:null,run:null,ingest:null,counts:null,orchestration:{},pause:null,published:null};
  if(present.length===TABLES.length){
   const triggers=(await many(binding,"SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('epg_checkpoint_cas_required','epg_checkpoint_run_order')")).length;
   state.triggers={present:triggers,expected:2};
   state.marker=await one(binding,'SELECT mode, generation, writes, (SELECT COUNT(*) FROM epg_checkpoint_cas WHERE id=1) AS cas FROM epg_checkpoint_authority WHERE id=1');
   state.run=await one(binding,'SELECT run_id, run_key, started_at, stage, seal_phase, queue_attempted, completed_at, has_error, revision, last_write_id, body_chunks, body_chars, body_sha256, watchlist_present, film_count, film_list_sha256 FROM epg_checkpoint_run WHERE id=1');
   state.ingest=await one(binding,'SELECT schema_version, last_success_at, failed_at, code, consecutive_failures, revision FROM epg_ingest_status WHERE id=1');
   state.counts=await one(binding,'SELECT (SELECT COUNT(*) FROM epg_checkpoint_run) AS run, (SELECT COUNT(*) FROM epg_checkpoint_body) AS body, (SELECT COUNT(*) FROM epg_checkpoint_film) AS film, (SELECT COUNT(*) FROM epg_checkpoint_receipt) AS receipt, (SELECT COUNT(*) FROM epg_ingest_status) AS ingest');
  }
  for(const row of await many(binding,'SELECT key, body, revision FROM epg_orchestration_document'))state.orchestration[row.key]={revision:Number(row.revision),body:json(row.body)??null};
  state.pause=await one(binding,'SELECT state FROM discovery_epg_priority WHERE id=1');
  state.published=await one(binding,'SELECT mode, cutover, generation, programme_run_id, finalized_run_id FROM published_epg_authority WHERE id=1');
  return state;
 }catch(error){if(error instanceof OperatorStop)throw error;throw new OperatorStop('unknown_state',3);}
}

// ---- R2 identities (no raw payload leaves this function except to the caller that parses it) --------------------------------
export async function readObject(store,key){
 let head;
 try{head=await store.head(key);}catch(error){throw normalize(error);}
 if(!head)return null;
 let got;
 try{got=await store.get(key);}catch(error){throw normalize(error);}
 if(!got)throw new OperatorStop('source_changed',3);
 const text=await got.text();
 const bytes=Buffer.byteLength(text,'utf8');
 if(got.etag!==head.etag||bytes!==head.size)throw new OperatorStop('source_changed',3);
 return {key,etag:head.etag,size:bytes,sha256:sha256(text),text};
}
export const publicIdentity=object=>object?{etag:object.etag,size:object.size,sha256:object.sha256}:null;
// Sizes only: what the owner needs for the budgets. A completed run has no watchlist, so no film figure exists for it.
export function measure(syncObject,ingestObject){
 const run=syncObject?json(syncObject.text):undefined;
 const out={syncBytes:syncObject?.size??null,ingestBytes:ingestObject?.size??null,stage:run&&typeof run==='object'?run.stage??null:null};
 if(run&&typeof run==='object'){
  const {watchlist,...rest}=run;
  out.bodyChars=JSON.stringify(rest).length;
  out.watchlist=Array.isArray(watchlist)?{films:watchlist.length,maxFilmChars:watchlist.reduce((max,film)=>Math.max(max,JSON.stringify(film).length),0)}:null;
 }
 return out;
}

// ---- the drain proof (pure) -------------------------------------------------------------------------------------------------
const madridDay=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
// The commit that introduced the D1 routing of the checkpoint (the merge of the dormant implementation). A deployed Worker built from this commit or a descendant knows the
// checkpoint tables and routes by the marker; an older one would read and write the frozen R2 objects after an activation.
export const ROUTING_COMMIT='28f6737b2f970a166437c384e0ad3aa2ae525504';
export const WORKFLOW_STATUSES=Object.freeze(['paused','queued','rollingBack','running','waiting','waitingForPause']);
// Local git proof, never an answer from the operator: `commit` exists here and `ancestor` is an ancestor of it (or equal). Anything unknown or ambiguous is `ok:false`.
export function commitContains(commit,ancestor=ROUTING_COMMIT,cwd=ROOT){
 if(!/^[0-9a-f]{40}$/.test(String(commit||'')))return {ok:false,reason:'commit_invalid'};
 const git=args=>spawnSync('git',args,{cwd,encoding:'utf8'});
 if(git(['cat-file','-e',commit+'^{commit}']).status!==0)return {ok:false,reason:'commit_unknown_locally'};
 if(git(['cat-file','-e',ancestor+'^{commit}']).status!==0)return {ok:false,reason:'routing_commit_unknown_locally'};
 const result=git(['merge-base','--is-ancestor',ancestor,commit]);
 return result.status===0?{ok:true}:{ok:false,reason:result.status===1?'not_a_descendant':'git_error'};
}
// `evidence` is what this tool cannot read with its D1 and R2 credentials, gathered by the operator with the Cloudflare GETs of the runbook: the terminal state of the EPG Workflow
// instance, the complete inventory of the non-terminal instances (every status, every page), and the current deployment (one version at 100%, the commit it was built from).
// The deployed version is NOT required to equal the version the finished instance ran: a finished instance is not made dangerous by a later deploy. What is required instead is that nothing
// that could write is running and that the deployed Worker is built from a commit that contains the D1 routing (`commitContainsRouting`, computed here with git, not asserted).
// The historical `control.versionId` is kept as immutable evidence and pinned by the compare-and-swap of the marker batch.
export function drainProof(state,{run,now,evidence={},journal={owed:false},nextStart=nextStartAfter(now),importable}){
 const failures=[];
 const today=madridDay(now);
 const lease=state.orchestration.lease?.body;
 if(!lease)failures.push('lease_unreadable');
 else if(lease.released!==true&&Date.parse(lease.expiresAt)>now)failures.push('step_lease_live');
 const control=state.orchestration.control?.body;
 if(!control||control.phase!=='done')failures.push('orchestration_not_done');
 if(state.orchestration.mode?.body?.mode!=='cloudflare')failures.push('orchestration_mode_not_cloudflare');
 // The next start must be known and at least the margin away; an unknown or past one refuses. A control record that names its own wake time is checked as a second, additional minimum margin (it is not required to equal the schedule).
 if(!Number.isFinite(nextStart))failures.push('next_start_unknown');
 else if(nextStart-now<NEXT_START_MARGIN_MS)failures.push('next_start_too_close');
 else if(control?.nextWakeAt!=null&&!(Date.parse(control.nextWakeAt)-now>=NEXT_START_MARGIN_MS))failures.push('next_start_too_close');
 if(state.pause?.state!=='clear')failures.push('discovery_pause_not_clear');
 const published=state.published;
 if(!run||run.stage!=='complete')failures.push('run_not_complete');
 else{
  if(run.watchlist!==undefined)failures.push('complete_run_has_watchlist');
  // A retained `error` is the history of an earlier attempt of the same run (the orchestrator says so); the proof is the completion receipt.
  if(!completionReceipt(run))failures.push('completion_receipt_unproven');
  if(run.runKey!==today)failures.push('run_not_current_day');
  if(pendingDebt(run)||journal.owed)failures.push('event_debt');
  if(journal.unreadable)failures.push('event_debt_unreadable');
 }
 if(importable===false)failures.push('r2_checkpoint_not_importable');
 if(control&&control.runKey!==today)failures.push('control_not_current_day');
 // One identity everywhere: the checkpoint run, the control record, the published programme and its certificate.
 if(!published||!published.programme_run_id||published.finalized_run_id!==published.programme_run_id||!run||!control||run.runId!==control.runId||control.runId!==published.programme_run_id)failures.push('run_identity_mismatch');
 // The Workflow instance: named, terminal, and the one the control record names.
 if(!evidence.workflowInstanceId||!evidence.workflowLiveness)failures.push('workflow_evidence_missing');
 else{
  if(!control||evidence.workflowInstanceId!==control.instanceId)failures.push('workflow_instance_mismatch');
  if(evidence.workflowLiveness!=='finished')failures.push('workflow_not_terminal');
 }
 // The historical version is evidence, pinned in the batch; it must be known, but it is not compared with the current deployment.
 if(!control||typeof control.versionId!=='string'||!control.versionId)failures.push('control_version_unknown');
 // The current deployment: one version at 100%, built from a commit that contains the D1 routing.
 if(!evidence.deployedVersionId||!evidence.deployedCommit||evidence.deploymentVersions===undefined||evidence.deploymentPercentage===undefined)failures.push('deployment_evidence_missing');
 else{
  if(String(evidence.deploymentVersions)!=='1'||String(evidence.deploymentPercentage)!=='100')failures.push('deployment_not_single_full');
  if(evidence.commitContainsRouting!==true)failures.push('deployed_commit_incompatible');
 }
 // No instance that could write: every non-terminal status was listed, completely, and none was found.
 const checked=String(evidence.instancesChecked??'').split(',').map(item=>item.trim()).filter(Boolean).sort();
 if(checked.length!==WORKFLOW_STATUSES.length||checked.some((item,index)=>item!==WORKFLOW_STATUSES[index])||evidence.instancesTotal===undefined||!/^\d+$/.test(String(evidence.instancesTotal)))failures.push('instances_inventory_incomplete');
 else if(Number(evidence.instancesTotal)!==0)failures.push('workflow_instances_active');
 return {ok:failures.length===0,failures};
}
// What a mutation must still find true inside its own batch: the exact records the proof was read from. The version pinned is the one the control record itself carries
// (immutable history), so a deploy after the proof does not move it and a rewrite of the record does.
export function proofFacts(state){
 const control=state.orchestration.control,lease=state.orchestration.lease;
 return {controlRevision:control?.revision??-1,leaseRevision:lease?.revision??-1,runKey:control?.body?.runKey??'',runId:control?.body?.runId??'',instanceId:control?.body?.instanceId??'',versionId:control?.body?.versionId??'',programmeRunId:state.published?.programme_run_id??''};
}

// The bounded event-owed semantics of the orchestrator (`journalOwed`, `handoverOwed`): explicit pending marks, an unfinished hand-over, and, once the watchlist
// event is fixed, the absence of its journal object. A retained `events` array alone is NOT debt: the Worker keeps it after a successful flush.
export function pendingDebt(run){
 if(run?.epgEventPending||run?.watchlistEventPending)return true;
 if(Array.isArray(run?.watchlistRemovalFilms)&&run.watchlistRemovalFilms.length)return true;
 const refs=Array.isArray(run?.removalRefs)?run.removalRefs:run?.removalRefs?[run.removalRefs]:[];
 if(refs.some(item=>Array.isArray(item?.films)&&item.films.length&&item.ref))return true;
 if(Array.isArray(run?.removalLookups)&&run.removalLookups.length)return true;
 return Array.isArray(run?.ratingPending)&&run.ratingPending.length>0&&(!run.ratingAttempt||run.ratingAttempt.state==='started');
}
export const journalKey=event=>event&&Number.isFinite(Date.parse(event.at))?'events/items/'+String(9999999999999-Date.parse(event.at)).padStart(13,'0')+'-'+event.id+'.json':null;
// Whether the fixed watchlist event's journal object exists in R2 (a HEAD, read-only). -> {owed} | {unreadable:true}
export async function journalState(run,store){
 if(!run?.watchlistEventFixed)return {owed:false};
 const key=journalKey((run.events||[]).find(item=>item?.type==='watchlist'));
 if(!key)return {owed:false};
 if(!store)return {unreadable:true};
 try{return {owed:!(await store.head(key))};}catch{return {unreadable:true};}
}
// The completion receipt the orchestrator accepts: `completedAt` when the record has the field (it must parse), else `updatedAt` only when no `error` is on the run.
export function completionReceipt(run){
 const receipt=Object.prototype.hasOwnProperty.call(run,'completedAt')?run.completedAt:(run.error?null:run.updatedAt);
 return typeof receipt==='string'&&Number.isFinite(Date.parse(receipt))?receipt:null;
}

// The only liveness rule of the schema-only apply: no executing EPG step. A live step lease, or a control record that says a step is starting, running or waiting, refuses.
export function applyBusy(state,now){
 const lease=state.orchestration.lease?.body;
 if(lease&&lease.released!==true&&Date.parse(lease.expiresAt)>now)return 'step_lease_live';
 const phase=state.orchestration.control?.body?.phase;
 if(['starting','running','waiting'].includes(phase))return 'epg_phase_'+phase;
 return null;
}

// The checkpoint contract of migration 0030, which later migrations (0031, 0032, ...) keep: every table, both triggers, the fence row and a readable marker. The commands
// after `--apply` need exactly this at any schema version from 30 on; a schema below 30, a missing or partial table set, a missing trigger or fence row or marker refuses.
export function checkpointSchemaReady(state){
 return Number.isInteger(state.schemaVersion)&&state.schemaVersion>=30
  &&state.tables.present===state.tables.expected
  &&state.triggers?.present===state.triggers?.expected&&state.triggers?.present>0
  &&Boolean(state.marker)&&Number(state.marker.cas)===1&&['r2','d1'].includes(state.marker.mode)&&['open','held'].includes(state.marker.writes);
}

// The next natural EPG start after `now`, from the same schedule definition the Worker uses (EPG_SCHEDULE, 17:00 Europe/Madrid, daylight saving aware). It is not read from the
// control record (`nextWakeAt` is null once the day's run is done) nor from `epg_status.dueAt` (that is today's due time, in the past after the run). null when it cannot be computed.
export function nextStartAfter(now){
 try{const next=nextDailyDue(now,EPG_SCHEDULE);return Number.isFinite(next)&&next>now?next:null;}catch{return null;}
}

// ---- the migration -------------------------------------------------------------------------------------------------------
export function applyDecision(state){
 if(state.tables.present&&state.tables.present!==state.tables.expected)return 'partial_schema';
 if(state.tables.present===state.tables.expected)return state.schemaVersion>=30?'already_applied':'partial_schema';
 if(state.schemaVersion!==29)return 'schema_unexpected';
 return 'apply';
}
export function migrationSql(){
 const statements=migrationStatements(fs.readFileSync(MIGRATION_PATH,'utf8'));
 if(!statements.length||statements.some(sql=>/\bCOMMIT\b|\bDROP\s+TABLE\b|\bINTO\s+(film|candidate|prediction_)/i.test(sql)))throw new OperatorStop('migration_refused',3);
 return statements;
}

// ---- transitions (section 3a of the plan): one guarded UPDATE of the marker each --------------------------------------------
const NO_LIVE_LEASE="NOT EXISTS (SELECT 1 FROM epg_orchestration_document WHERE key='lease' AND COALESCE(json_extract(body,'$.released'),0)=0 AND json_extract(body,'$.expiresAt')>?)";
// The durable H0 facts, re-asserted in the batch that moves the marker: a record that changed after the proof was read aborts the batch.
const H0_RECORDS="(SELECT COUNT(*) FROM epg_orchestration_document WHERE key='control' AND revision=? AND json_extract(body,'$.phase')='done' AND json_extract(body,'$.runKey')=? AND json_extract(body,'$.runId')=? AND json_extract(body,'$.instanceId')=? AND json_extract(body,'$.versionId')=?)=1 AND (SELECT COUNT(*) FROM epg_orchestration_document WHERE key='lease' AND revision=?)=1 AND (SELECT COUNT(*) FROM published_epg_authority WHERE programme_run_id=? AND finalized_run_id=programme_run_id)=1 AND (SELECT COUNT(*) FROM discovery_epg_priority WHERE state='clear')=1";
const H0=(ctx)=>[NO_LIVE_LEASE+' AND '+H0_RECORDS,[iso(ctx.now),ctx.proof.controlRevision,ctx.proof.runKey,ctx.proof.runId,ctx.proof.instanceId,ctx.proof.versionId,ctx.proof.leaseRevision,ctx.proof.programmeRunId]];
const EMPTY="(SELECT COUNT(*) FROM epg_checkpoint_run)=0 AND (SELECT COUNT(*) FROM epg_checkpoint_body)=0 AND (SELECT COUNT(*) FROM epg_checkpoint_film)=0 AND (SELECT COUNT(*) FROM epg_checkpoint_receipt)=0 AND (SELECT COUNT(*) FROM epg_ingest_status)=0";
const HAS_RUN='(SELECT COUNT(*) FROM epg_checkpoint_run)=1';
const authority=(mode,writes)=>"(SELECT COUNT(*) FROM epg_checkpoint_authority WHERE id=1 AND mode='"+mode+"' AND writes='"+writes+"' AND generation=?)=1";
const withH0=(mode,writes,extra='')=>ctx=>{const [expression,params]=H0(ctx);return [authority(mode,writes)+(extra?' AND '+extra:'')+' AND '+expression,[ctx.generation,...params]];};
export const TRANSITIONS={
 hold:{from:{mode:'r2',writes:'open'},to:{mode:'r2',writes:'held'},bump:true,predicate:withH0('r2','open')},
 'release-abort':{from:{mode:'r2',writes:'held'},to:{mode:'r2',writes:'open'},bump:false,predicate:ctx=>[authority('r2','held')+' AND '+EMPTY,[ctx.generation]]},
 activate:{from:{mode:'r2',writes:'held'},to:{mode:'d1',writes:'held'},bump:true,predicate:ctx=>[authority('r2','held')+' AND '+HAS_RUN+" AND (SELECT body_sha256 FROM epg_checkpoint_run)=? AND (SELECT stage FROM epg_checkpoint_run)='complete'",[ctx.generation,ctx.bodySha256]]},
 release:{from:{mode:'d1',writes:'held'},to:{mode:'d1',writes:'open'},bump:false,predicate:ctx=>[authority('d1','held')+' AND '+HAS_RUN+" AND (SELECT body_sha256 FROM epg_checkpoint_run)=?",[ctx.generation,ctx.bodySha256]]},
 'hold-rollback':{from:{mode:'d1',writes:'open'},to:{mode:'d1',writes:'held'},bump:true,predicate:withH0('d1','open',HAS_RUN+" AND (SELECT stage FROM epg_checkpoint_run)='complete' AND (SELECT queue_attempted FROM epg_checkpoint_run)=1")},
 'revert-authority':{from:{mode:'d1',writes:'held'},to:{mode:'r2',writes:'held'},bump:true,predicate:ctx=>[authority('d1','held'),[ctx.generation]]},
 'release-rolled-back':{from:{mode:'r2',writes:'held'},to:{mode:'r2',writes:'open'},bump:false,predicate:ctx=>[authority('r2','held'),[ctx.generation]]},
};
export function transitionStatements(name,{generation,now,bodySha256,proof}){
 const spec=TRANSITIONS[name];
 if(!spec)throw new OperatorStop('usage',2);
 if(!Number.isInteger(generation)||generation<0)throw new OperatorStop('usage',2);
 if((name==='hold'||name==='hold-rollback')&&!proof)throw new OperatorStop('drain_refused',3);
 const [expression,params]=spec.predicate({generation,now,bodySha256,proof});
 return [
  [...GUARD(expression),params],
  ['UPDATE epg_checkpoint_authority SET mode=?, writes=?, generation=? WHERE id=1 AND mode=? AND writes=? AND generation=?',[spec.to.mode,spec.to.writes,spec.bump?generation+1:generation,spec.from.mode,spec.from.writes,generation]],
  [FENCE,[]],
 ];
}
// Run one transition. The marker is read first and must equal the expected state; after the batch it is read back. An unknown outcome is reported, never replayed.
export async function transition(binding,name,{generation,now,bodySha256,proof},ctx={}){
 const spec=TRANSITIONS[name];
 const before=await one(binding,'SELECT mode, writes, generation, (SELECT COUNT(*) FROM epg_checkpoint_cas WHERE id=1) AS cas FROM epg_checkpoint_authority WHERE id=1');
 if(!before||Number(before.cas)!==1)throw new OperatorStop('marker_unreadable',3);
 if(before.mode!==spec.from.mode||before.writes!==spec.from.writes||Number(before.generation)!==generation)throw new OperatorStop('state_mismatch',3,{marker:{mode:before.mode,writes:before.writes,generation:Number(before.generation)}});
 const target={mode:spec.to.mode,writes:spec.to.writes,generation:spec.bump?generation+1:generation};
 const statements=transitionStatements(name,{generation,now,bodySha256,proof});
 if(ctx.track)ctx.track('unknown');
 let error=null;
 try{await batch(binding,statements);}catch(caught){error=caught;}
 const after=await one(binding,'SELECT mode, writes, generation FROM epg_checkpoint_authority WHERE id=1');
 const reached=after&&after.mode===target.mode&&after.writes===target.writes&&Number(after.generation)===target.generation;
 if(reached&&!error){if(ctx.track)ctx.track('committed');return {operation:name,marker:target};}
 if(reached&&error)throw new OperatorStop('write_uncertain',3,{marker:target,reachedByUnknownOutcome:true});
 if(!error){if(ctx.track)ctx.track('none');throw new OperatorStop('readback_mismatch',3);}
 const same=after&&after.mode===before.mode&&after.writes===before.writes&&Number(after.generation)===generation;
 if(ctx.track)ctx.track(same?'none':'unknown');
 throw new OperatorStop(same?'predicate_refused':'write_uncertain',3,{marker:after?{mode:after.mode,writes:after.writes,generation:Number(after.generation)}:null});
}

// ---- import --------------------------------------------------------------------------------------------------------------
function chunksOf(text){
 const out=[];let at=0;
 while(at<text.length){
  let end=Math.min(text.length,at+LIMITS.statementChars);
  if(end<text.length){const code=text.charCodeAt(end-1);if(code>=0xD800&&code<=0xDBFF)end--;}
  out.push(text.slice(at,end));at=end;
 }
 return out;
}
// Validates the frozen `sync.json` (a complete run) and `watchlist-ingest.json` and builds the rows. Anything the checkpoint schema would not
// accept is refused here, before a statement exists. The completion time is the body's own, else `updatedAt`, as `completeRun` does.
export function importPlan({syncText,ingestText,generation,now,writeId=randomUUID()}){
 const run=json(syncText);
 if(!run||typeof run!=='object'||Array.isArray(run))throw new OperatorStop('source_invalid',3,{key:KEYS.sync});
 if(typeof run.runId!=='string'||!run.runId||run.runId.length>100||typeof run.startedAt!=='string'||!Number.isFinite(Date.parse(run.startedAt)))throw new OperatorStop('source_invalid',3,{key:KEYS.sync});
 if(run.stage!=='complete')throw new OperatorStop('run_not_complete',3);
 if(run.watchlist!==undefined)throw new OperatorStop('complete_run_has_watchlist',3);
 if(run.runKey!==undefined&&run.runKey!==null&&(typeof run.runKey!=='string'||!GLOB_DAY.test(run.runKey)))throw new OperatorStop('source_invalid',3,{key:KEYS.sync});
 const completedAt=completionReceipt(run);
 if(typeof completedAt!=='string'||!Number.isFinite(Date.parse(completedAt)))throw new OperatorStop('source_invalid',3,{key:KEYS.sync});
 const body={...run,completedAt};
 const text=JSON.stringify(body);
 if(text.length>LIMITS.bodyChars)throw new OperatorStop('budget',3);
 const chunks=chunksOf(text);
 const bodySha256=sha256(text);
 const stamp=iso(now);
 let ingest=null;
 if(ingestText!=null){
  const doc=json(ingestText);
  const ok=doc&&typeof doc==='object'&&doc.schemaVersion===1&&['failedAt','lastSuccessAt'].every(k=>doc[k]==null||typeof doc[k]==='string')&&(doc.code==null||(typeof doc.code==='string'&&doc.code.length<=60));
  if(!ok)throw new OperatorStop('source_invalid',3,{key:KEYS.ingest});
  ingest={last_success_at:doc.lastSuccessAt??null,failed_at:doc.failedAt??null,code:doc.code??null};
 }
 const columns=[run.runId,run.runKey??null,run.startedAt,completedAt,run.error?1:0,writeId,chunks.length,text.length,bodySha256,stamp];
 const statements=[
  [...GUARD(authority('r2','held')+' AND '+EMPTY),[generation]],
  ["INSERT INTO epg_checkpoint_run (id, run_id, run_key, started_at, stage, seal_phase, queue_attempted, completed_at, has_error, revision, last_write_id, body_chunks, body_chars, body_sha256, watchlist_present, film_count, film_list_sha256, updated_at) VALUES (1,?,?,?,'complete',NULL,1,?,?,1,?,?,?,?,0,NULL,NULL,?)",columns],
  ...chunks.map((chunk,seq)=>['INSERT INTO epg_checkpoint_body (seq, text) VALUES (?,?)',[seq,chunk]]),
  ['INSERT INTO epg_checkpoint_receipt (write_id, run_id, revision, body_sha256, applied_at) VALUES (?,?,1,?,?)',[writeId,run.runId,bodySha256,stamp]],
  ...(ingest?[['INSERT INTO epg_ingest_status (id, schema_version, last_success_at, failed_at, code, consecutive_failures, revision, updated_at) VALUES (1,1,?,?,?,0,1,?)',[ingest.last_success_at,ingest.failed_at,ingest.code,stamp]]]:[]),
 ];
 return {statements,expected:{runId:run.runId,runKey:run.runKey??null,startedAt:run.startedAt,completedAt,hasError:run.error?1:0,chunks:chunks.length,chars:text.length,bodySha256,body,ingest,writeId}};
}
// Reads the imported rows and compares every field with the plan. Returns the list of mismatches (empty = parity).
export async function verifyImported(binding,expected){
 const mismatches=[];
 const run=await one(binding,'SELECT * FROM epg_checkpoint_run WHERE id=1');
 if(!run)return ['run_missing'];
 const want={run_id:expected.runId,run_key:expected.runKey,started_at:expected.startedAt,stage:'complete',seal_phase:null,queue_attempted:1,completed_at:expected.completedAt,has_error:expected.hasError,revision:1,body_chunks:expected.chunks,body_chars:expected.chars,body_sha256:expected.bodySha256,watchlist_present:0,film_count:null,film_list_sha256:null};
 for(const [key,value] of Object.entries(want))if(run[key]!==value)mismatches.push('run.'+key);
 const rows=await many(binding,'SELECT seq, text FROM epg_checkpoint_body ORDER BY seq');
 const text=rows.map(row=>row.text).join('');
 if(rows.length!==expected.chunks||rows.some((row,index)=>Number(row.seq)!==index)||text.length!==expected.chars||sha256(text)!==expected.bodySha256)mismatches.push('body');
 else if(JSON.stringify(json(text))!==JSON.stringify(expected.body))mismatches.push('body_content');
 const counts=await one(binding,'SELECT (SELECT COUNT(*) FROM epg_checkpoint_film) AS film, (SELECT COUNT(*) FROM epg_checkpoint_receipt WHERE write_id=? AND revision=1 AND body_sha256=?) AS receipt',[expected.writeId,expected.bodySha256]);
 if(Number(counts.film)!==0)mismatches.push('film_rows');
 if(Number(counts.receipt)!==1)mismatches.push('receipt');
 const ingest=await one(binding,'SELECT schema_version, last_success_at, failed_at, code, consecutive_failures, revision FROM epg_ingest_status WHERE id=1');
 if(expected.ingest){
  if(!ingest||ingest.last_success_at!==expected.ingest.last_success_at||ingest.failed_at!==expected.ingest.failed_at||ingest.code!==expected.ingest.code||Number(ingest.consecutive_failures)!==0||Number(ingest.schema_version)!==1)mismatches.push('ingest');
 }else if(ingest)mismatches.push('ingest_unexpected');
 return mismatches;
}

// The export image reconstructed from the retained D1 rows in ANY marker mode (the rows are kept after a revert). Verifies the body chunks against the run row.
export async function retainedDocuments(binding){
 const run=await one(binding,'SELECT run_id, stage, completed_at, body_chunks, body_chars, body_sha256, watchlist_present FROM epg_checkpoint_run WHERE id=1');
 if(!run||run.stage!=='complete'||Number(run.watchlist_present)!==0)throw new OperatorStop('retained_rows_unusable',3);
 const rows=await many(binding,'SELECT seq, text FROM epg_checkpoint_body ORDER BY seq');
 const text=rows.map(row=>row.text).join('');
 if(rows.length!==Number(run.body_chunks)||rows.some((row,index)=>Number(row.seq)!==index)||text.length!==Number(run.body_chars)||sha256(text)!==run.body_sha256)throw new OperatorStop('retained_rows_unusable',3);
 const ingest=await one(binding,'SELECT last_success_at, failed_at, code FROM epg_ingest_status WHERE id=1');
 if(!ingest)throw new OperatorStop('retained_rows_unusable',3);
 return {syncText:text,ingestText:JSON.stringify({schemaVersion:1,...(ingest.code?{code:ingest.code}:{}),failedAt:ingest.failed_at??null,lastSuccessAt:ingest.last_success_at??null})};
}
// ---- rollback export -----------------------------------------------------------------------------------------------------
// The two R2 documents a rolled-back Worker would read, derived from the D1 rows (a complete run only). Never the raw rows of another run.
export async function exportDocuments(binding){
 const loaded=await Checkpoint.loadRun(binding);
 if(!loaded.ok||!loaded.run)throw new OperatorStop('export_source_'+(loaded.reason||'absent'),3);
 if(loaded.run.stage!=='complete'||loaded.run.watchlist!==undefined)throw new OperatorStop('run_not_complete',3);
 const ingest=await Checkpoint.readIngest(binding);
 if(!ingest.ok)throw new OperatorStop('export_source_'+ingest.reason,3);
 const syncText=JSON.stringify(loaded.run);
 if(!ingest.status)throw new OperatorStop('export_source_ingest_absent',3);
 const {consecutiveFailures,...document}=ingest.status;
 const ingestText=JSON.stringify(document);
 return {syncText,ingestText};
}

// ---- command execution ----------------------------------------------------------------------------------------------------
const marker0=state=>state.marker?{mode:state.marker.mode,writes:state.marker.writes,generation:Number(state.marker.generation),cas:Number(state.marker.cas)}:null;
function requireMarker(state,mode,writes,generation){
 const m=marker0(state);
 if(!m||m.cas!==1)throw new OperatorStop('marker_unreadable',3);
 if(m.mode!==mode||m.writes!==writes||m.generation!==generation)throw new OperatorStop('state_mismatch',3,{marker:{mode:m.mode,writes:m.writes,generation:m.generation}});
}
function requireIdentity(object,etag,digest,key){
 if(!object)throw new OperatorStop('source_missing',3,{key});
 if(!etag||!digest||object.etag!==etag||object.sha256!==digest)throw new OperatorStop('identity_mismatch',3,{key,live:publicIdentity(object)});
}
// The run a drain proof looks at: the R2 object while the marker is r2, the verified D1 run while it is d1.
async function currentRun(binding,state,syncObject){
 if(state.marker?.mode==='d1'){const loaded=await Checkpoint.loadRun(binding);if(!loaded.ok)throw new OperatorStop('checkpoint_'+loaded.reason,3);return loaded.run;}
 const run=syncObject?json(syncObject.text):undefined;
 return run&&typeof run==='object'?run:null;
}

export async function execute(command,args,{binding,readStore,writeStoreFactory,now,ctx={}}){
 const clock=typeof now==='function'?now():now;
 const contains=ctx.commitContains||commitContains;
 const evidence={workflowInstanceId:args.workflowInstanceId,workflowLiveness:args.workflowLiveness,deployedVersionId:args.deployedVersionId,deployedCommit:args.deployedCommit,deploymentVersions:args.deploymentVersions,deploymentPercentage:args.deploymentPercentage,instancesChecked:args.instancesChecked,instancesTotal:args.instancesTotal,
  // Computed here with git from the commit the operator names; absent or unknown evidence is not "compatible".
  commitContainsRouting:args.deployedCommit?contains(args.deployedCommit).ok===true:undefined};
 const state=await readState(binding);
 const generation=args.generation;
 const readObjects=async()=>readStore?{sync:await readObject(readStore,KEYS.sync),ingest:await readObject(readStore,KEYS.ingest)}:null;
 // A stored R2 checkpoint that the import would refuse must stop the hold before it freezes anything: the same validation as the import, run without a write.
 const importableOf=objects=>{
  if(!objects?.sync||!objects?.ingest)return false;
  try{importPlan({syncText:objects.sync.text,ingestText:objects.ingest.text,generation:0,now:clock});return true;}catch{return false;}
 };
 const proofOf=async(run,importable)=>drainProof(state,{run,now:clock,evidence,journal:await journalState(run,readStore),importable});
 if(command==='status'){
  const objects=await readObjects();
  const run=objects||state.marker?.mode==='d1'?await currentRun(binding,state,objects?.sync).catch(()=>null):null;
  return {operation:'status',writes:false,writeState:'none',schemaVersion:state.schemaVersion,tables:state.tables,marker:marker0(state),run:state.run?{runId:state.run.run_id,stage:state.run.stage,revision:Number(state.run.revision),completedAt:state.run.completed_at,bodySha256:state.run.body_sha256}:null,counts:state.counts,ingest:state.ingest,orchestration:{mode:state.orchestration.mode?.body?.mode??null,phase:state.orchestration.control?.body?.phase??null,nextWakeAt:state.orchestration.control?.body?.nextWakeAt??null,leaseReleased:state.orchestration.lease?.body?.released??null,leaseExpiresAt:state.orchestration.lease?.body?.expiresAt??null},pause:state.pause?.state??null,published:state.published,nextStart:(()=>{const next=nextStartAfter(clock);return next===null?null:{at:iso(next),inMinutes:Math.floor((next-clock)/60000)};})(),r2:objects?{sync:publicIdentity(objects.sync),ingest:publicIdentity(objects.ingest),measure:measure(objects.sync,objects.ingest),importable:importableOf(objects)}:'not_configured',drain:objects||state.marker?.mode==='d1'?await proofOf(run,state.marker?.mode==='d1'?undefined:importableOf(objects)):'not_evaluated'};
 }
 if(command==='apply'){
  const decision=applyDecision(state);
  if(decision!=='apply')throw new OperatorStop(decision,3);
  // Schema only: the migration creates inert tables and a marker that keeps the R2 objects serving, and copies nothing. It therefore needs none of the cutover
  // evidence (a completed run of today, the Workflow version, the R2 identities). It only refuses while an EPG step is executing, so that no D1 write lands inside one.
  const busy=applyBusy(state,clock);
  if(busy)throw new OperatorStop('writer_active',3,{busy});
  if(ctx.track)ctx.track('unknown');
  try{await batch(binding,migrationSql().map(sql=>[sql,[]]));}
  catch{
   // The batch is atomic and the file guards itself (exactly v29 with the started tables). Read the state before saying anything about the outcome; never retry.
   let after=null;
   try{after=await readState(binding);}catch{after=null;}
   const untouched=Boolean(after)&&after.schemaVersion===29&&after.tables.present===0;
   if(ctx.track)ctx.track(untouched?'none':'unknown');
   throw new OperatorStop(untouched?'statement_failed':'write_uncertain',3,{schemaVersion:after?.schemaVersion??null,tables:after?.tables??null});
  }
  const after=await readState(binding);
  const m=marker0(after);
  if(after.schemaVersion!==30||after.tables.present!==after.tables.expected||!m||m.mode!=='r2'||m.writes!=='open'||m.generation!==0||m.cas!==1||after.counts.run+after.counts.body+after.counts.film+after.counts.receipt+after.counts.ingest!==0)throw new OperatorStop('readback_mismatch',3);
  if(ctx.track)ctx.track('committed');
  return {operation:'apply',writes:true,writeState:'committed',schemaVersion:30,marker:m};
 }
 if(!checkpointSchemaReady(state))throw new OperatorStop('schema_unexpected',3);
 if(command==='hold'){
  requireMarker(state,'r2','open',generation);
  const objects=await readObjects();
  if(!objects)throw new OperatorStop('source_missing',3);
  const proof=await proofOf(await currentRun(binding,state,objects.sync),importableOf(objects));
  if(!proof.ok)throw new OperatorStop('drain_refused',3,{failures:proof.failures});
  const done=await transition(binding,'hold',{generation,now:clock,proof:proofFacts(state)},ctx);
  return {...done,writes:true,writeState:'committed',waitBeforeCapture:'longer than the 2 s marker cache'};
 }
 if(command==='release-abort'){
  requireMarker(state,'r2','held',generation);
  const done=await transition(binding,command,{generation,now:clock},ctx);
  return {...done,writes:true,writeState:'committed'};
 }
 if(command==='release-rolled-back'){
  // Reopens writes on the R2 objects: both must be exactly the image the export wrote (the fingerprints the export reported), read fresh now.
  requireMarker(state,'r2','held',generation);
  const objects=await readObjects();
  requireIdentity(objects?.sync,args.syncEtag,args.syncSha256,KEYS.sync);
  requireIdentity(objects?.ingest,args.ingestEtag,args.ingestSha256,KEYS.ingest);
  // The caller's fingerprints say what the operator saw; they are not the proof. The proof is the export image reconstructed from the retained D1 rows.
  const retained=await retainedDocuments(binding);
  if(objects.sync.sha256!==sha256(retained.syncText)||objects.ingest.sha256!==sha256(retained.ingestText))throw new OperatorStop('export_mismatch',3,{r2:{sync:publicIdentity(objects.sync),ingest:publicIdentity(objects.ingest)}});
  const done=await transition(binding,command,{generation,now:clock},ctx);
  return {...done,writes:true,writeState:'committed',r2:{sync:publicIdentity(objects.sync),ingest:publicIdentity(objects.ingest)}};
 }
 if(command==='import'){
  requireMarker(state,'r2','held',generation);
  const objects=await readObjects();
  requireIdentity(objects?.sync,args.syncEtag,args.syncSha256,KEYS.sync);
  // Both keys are part of the approved H0 identity. A key that disappeared since is never a reason to import without it.
  requireIdentity(objects?.ingest,args.ingestEtag,args.ingestSha256,KEYS.ingest);
  const plan=importPlan({syncText:objects.sync.text,ingestText:objects.ingest.text,generation,now:clock});
  if(ctx.track)ctx.track('unknown');
  try{await batch(binding,plan.statements);}catch{
   // The receipt of THIS import (its own write id) is the only proof that the batch landed; rows from an earlier import prove nothing about this one.
   const landed=Number((await one(binding,'SELECT COUNT(*) AS n FROM epg_checkpoint_receipt WHERE write_id=?',[plan.expected.writeId]))?.n)===1;
   if(ctx.track)ctx.track(landed?'unknown':'none');
   throw new OperatorStop(landed?'write_uncertain':'predicate_refused',3,{receipt:landed});
  }
  const mismatches=await verifyImported(binding,plan.expected);
  if(mismatches.length)throw new OperatorStop('parity_mismatch',3,{mismatches});
  if(ctx.track)ctx.track('committed');
  return {operation:'import',writes:true,writeState:'committed',runId:plan.expected.runId,bodySha256:plan.expected.bodySha256,chunks:plan.expected.chunks,ingestImported:Boolean(plan.expected.ingest),parity:'verified'};
 }
 if(command==='activate'){
  requireMarker(state,'r2','held',generation);
  if(!state.run)throw new OperatorStop('import_missing',3);
  const objects=await readObjects();
  requireIdentity(objects?.sync,args.syncEtag,args.syncSha256,KEYS.sync);
  requireIdentity(objects?.ingest,args.ingestEtag,args.ingestSha256,KEYS.ingest);
  const plan=importPlan({syncText:objects.sync.text,ingestText:objects.ingest.text,generation,now:clock,writeId:state.run.last_write_id});
  const mismatches=await verifyImported(binding,plan.expected);
  if(mismatches.length)throw new OperatorStop('parity_mismatch',3,{mismatches});
  const done=await transition(binding,'activate',{generation,now:clock,bodySha256:plan.expected.bodySha256},ctx);
  const loaded=await Checkpoint.loadRun(binding);
  if(!loaded.ok||JSON.stringify(loaded.run)!==JSON.stringify(plan.expected.body))throw new OperatorStop('readback_mismatch',3,{marker:done.marker});
  return {...done,writes:true,writeState:'committed',parity:'verified'};
 }
 if(command==='release'){
  requireMarker(state,'d1','held',generation);
  if(!state.run)throw new OperatorStop('import_missing',3);
  // Reopens writes on the D1 rows: the frozen R2 images are unchanged and the rows still equal them (typed columns, body, receipt, ingest), read fresh now.
  const objects=await readObjects();
  requireIdentity(objects?.sync,args.syncEtag,args.syncSha256,KEYS.sync);
  requireIdentity(objects?.ingest,args.ingestEtag,args.ingestSha256,KEYS.ingest);
  const plan=importPlan({syncText:objects.sync.text,ingestText:objects.ingest.text,generation,now:clock,writeId:state.run.last_write_id});
  const mismatches=await verifyImported(binding,plan.expected);
  if(mismatches.length)throw new OperatorStop('parity_mismatch',3,{mismatches});
  const loaded=await Checkpoint.loadRun(binding);
  if(!loaded.ok||!loaded.run)throw new OperatorStop('checkpoint_'+(loaded.reason||'absent'),3);
  const done=await transition(binding,'release',{generation,now:clock,bodySha256:plan.expected.bodySha256},ctx);
  return {...done,writes:true,writeState:'committed'};
 }
 if(command==='hold-rollback'){
  requireMarker(state,'d1','open',generation);
  const run=await currentRun(binding,state,null);
  const proof=await proofOf(run);
  if(!proof.ok)throw new OperatorStop('drain_refused',3,{failures:proof.failures});
  const done=await transition(binding,'hold-rollback',{generation,now:clock,proof:proofFacts(state)},ctx);
  return {...done,writes:true,writeState:'committed'};
 }
 if(command==='export-rollback'||command==='revert-authority'){
  requireMarker(state,'d1','held',generation);
  const docs=await exportDocuments(binding);
  const target={sync:sha256(docs.syncText),ingest:docs.ingestText==null?null:sha256(docs.ingestText)};
  const current=await readObjects();
  if(command==='revert-authority'){
    if(current.sync?.sha256!==target.sync||(target.ingest!==null&&current.ingest?.sha256!==target.ingest))throw new OperatorStop('export_not_verified',3,{r2:{sync:publicIdentity(current.sync),ingest:publicIdentity(current.ingest)}});
    const done=await transition(binding,'revert-authority',{generation,now:clock},ctx);
    return {...done,writes:true,writeState:'committed',d1Rows:'retained, inactive'};
  }
  if(!args.frozenSyncEtag||!args.frozenIngestEtag)throw new OperatorStop('usage',2);
  const store=writeStoreFactory?writeStoreFactory(new Set([KEYS.sync,KEYS.ingest])):null;
  if(!store)throw new OperatorStop('configuration',2);
  const written=[];
  const one_=async(key,text,digest,frozen,object)=>{
   if(object?.sha256===digest)return 'already_equal';
   if(!object||object.etag!==frozen)throw new OperatorStop('foreign_writer',3,{key,live:publicIdentity(object)});
   if(ctx.track)ctx.track('unknown');
   let result;
   try{result=await store.put(key,text,{onlyIf:{etagMatches:frozen}});}
   catch{
    // Unknown outcome: read both objects and the marker right now and report them. Nothing is replayed; the next export call reads again before any write.
    let observed='unreadable';
    try{const seen=await readObjects();observed={sync:publicIdentity(seen.sync),ingest:publicIdentity(seen.ingest),syncEqualsExport:seen.sync?.sha256===target.sync,ingestEqualsExport:seen.ingest?.sha256===target.ingest};}catch{observed='unreadable';}
    const after=await one(binding,'SELECT mode, writes, generation FROM epg_checkpoint_authority WHERE id=1');
    throw new OperatorStop('write_uncertain',3,{key,observed,marker:after?{mode:after.mode,writes:after.writes,generation:Number(after.generation)}:null,classification:observed==='unreadable'?'unclassified':'observed'});
   }
   if(!result)throw new OperatorStop('foreign_writer',3,{key});
   written.push(key);return 'written';
  };
  const results={sync:await one_(KEYS.sync,docs.syncText,target.sync,args.frozenSyncEtag,current.sync)};
  if(docs.ingestText!=null)results.ingest=await one_(KEYS.ingest,docs.ingestText,target.ingest,args.frozenIngestEtag,current.ingest);
  let after;
  try{after=await readObjects();}catch{throw new OperatorStop('readback_unreadable',3,{results,written});}
  if(after.sync?.sha256!==target.sync||(target.ingest!==null&&after.ingest?.sha256!==target.ingest))throw new OperatorStop('readback_mismatch',3,{results});
  if(ctx.track)ctx.track(written.length?'committed':'none');
  return {operation:'export-rollback',writes:written.length>0,writeState:written.length?'committed':'none',results,r2:{sync:publicIdentity(after.sync),ingest:publicIdentity(after.ingest)},d1Rows:'retained, inactive'};
 }
 throw new OperatorStop('usage',2);
}

// ---- CLI ---------------------------------------------------------------------------------------------------------------
const VALUE_FLAGS={'--target':'target','--confirm':'confirm','--expect-generation':'generation','--sync-etag':'syncEtag','--sync-sha256':'syncSha256','--ingest-etag':'ingestEtag','--ingest-sha256':'ingestSha256','--frozen-sync-etag':'frozenSyncEtag','--frozen-ingest-etag':'frozenIngestEtag','--workflow-instance-id':'workflowInstanceId','--workflow-liveness':'workflowLiveness','--deployed-version-id':'deployedVersionId','--deployed-commit':'deployedCommit','--deployment-versions':'deploymentVersions','--deployment-percentage':'deploymentPercentage','--instances-checked':'instancesChecked','--instances-total':'instancesTotal'};
const H0_FLAGS=['workflowInstanceId','workflowLiveness','deployedVersionId','deployedCommit','deploymentVersions','deploymentPercentage','instancesChecked','instancesTotal'];
const IDENTITY_FLAGS=['syncEtag','syncSha256','ingestEtag','ingestSha256'];
const NEEDS={hold:['generation',...H0_FLAGS],'release-abort':['generation'],import:['generation',...IDENTITY_FLAGS],activate:['generation',...IDENTITY_FLAGS],release:['generation',...IDENTITY_FLAGS],'hold-rollback':['generation',...H0_FLAGS],'export-rollback':['generation','frozenSyncEtag','frozenIngestEtag'],'revert-authority':['generation'],'release-rolled-back':['generation',...IDENTITY_FLAGS],apply:[]};
const RETIRED_AFTER_H6=new Set(['hold-rollback','export-rollback','revert-authority','release-rolled-back']);
export function parseArgs(argv){
 const args=argv.slice(2),parsed={};
 const commands=args.filter(arg=>arg.startsWith('--')&&COMMANDS.includes(arg.slice(2)));
 if(commands.length>1)throw new OperatorStop('usage',2);
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(commands.includes(arg))continue;
  const name=VALUE_FLAGS[arg];
  const next=args[index+1];
  if(!name||next===undefined||next.startsWith('--')||parsed[name]!==undefined)throw new OperatorStop('usage',2);
  parsed[name]=next;index++;
 }
 const command=commands[0]?commands[0].slice(2):'status';
 if(parsed.target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {report:{configured:false,writes:false,writeState:'none'}};
 }
 if(parsed.target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_invalid',2);
 if(command==='status'){if(parsed.confirm!==undefined)throw new OperatorStop('usage',2);}
 else if(parsed.confirm!==command)throw new OperatorStop('confirm',2);
 if(parsed.generation!==undefined){if(!/^\d{1,9}$/.test(parsed.generation))throw new OperatorStop('usage',2);parsed.generation=Number(parsed.generation);}
 for(const need of NEEDS[command]||[])if(parsed[need]===undefined)throw new OperatorStop('usage',2);
 // AIR-551 H6: the Worker reads marker `r2` as closed, so a data rollback to the R2 objects would leave production refusing every checkpoint read and write.
 // The four rollback commands are retired at the command line (recovery is roll-forward in D1); `execute` keeps them for the offline suite only.
 if(RETIRED_AFTER_H6.has(command))throw new OperatorStop('retired_after_h6',2);
 return {command,args:parsed};
}
function readStoreOf(env,fetchImpl){
 const any=['R2_SNAPSHOT_ACCOUNT_ID','R2_SNAPSHOT_ACCESS_KEY_ID','R2_SNAPSHOT_SECRET_ACCESS_KEY','R2_SNAPSHOT_BUCKET'].some(name=>String(env[name]||'').trim());
 if(!any)return null;
 let credentials;
 try{credentials=readCredentials(env);}catch(error){throw normalize(error);}
 if(credentials.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
 if(credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
 return createS3Store({credentials,fetchImpl});
}
function writeStoreFactoryOf(env,fetchImpl){
 return allowed=>{
  let credentials;
  try{credentials=readInstallCredentials(env);}catch(error){throw error instanceof InstallError?new OperatorStop('configuration',2):normalize(error);}
  if(credentials.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
  if(credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
  return createS3Store({credentials,fetchImpl,allowedWrites:allowed});
 };
}
export async function runEpgCheckpointProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null}={}){
 const ctx={writeState:'none',bookmark:null};
 const track=state=>{ctx.writeState=state;};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  let binding,readStore,writeStoreFactory;
  if(deps){({binding,readStore,writeStoreFactory}=deps);}
  else{
   const target=productionTarget(env);
   const holder={writeState:'none'};
   const adapter=trackProductionWrites(createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl}),holder);
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=createPublishedBinding(adapter);
   ctx.bookmark=await readBookmark(target,fetchImpl);
   readStore=readStoreOf(env,fetchImpl);
   writeStoreFactory=writeStoreFactoryOf(env,fetchImpl);
  }
  const result=await execute(parsed.command,parsed.args,{binding,readStore,writeStoreFactory,now,ctx:{track}});
  return {exit:0,result:{...result,...(ctx.bookmark?{bookmark:ctx.bookmark}:{})}};
 }catch(error){
  const stop=normalize(error);
  const writeState=ctx.writeState==='committed'||ctx.writeState==='unknown'?ctx.writeState:'none';
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:writeState==='committed'?true:writeState==='unknown'?null:false,...(writeState!=='none'?{retry:false}:{}),...(stop.details&&Object.keys(stop.details).length?{details:stop.details}:{}),...(ctx.bookmark?{bookmark:ctx.bookmark}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runEpgCheckpointProduction();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
