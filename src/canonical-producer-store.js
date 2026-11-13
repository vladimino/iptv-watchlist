// AIR-374 S4-3 (ADR 0128, Accepted as DESIGN; table of S4-2 / migration 0020, applied in production on 13 Nov 2026). The STORE LAYER of the durable EPG canonical producer pass: the only module that writes `canonical_producer_run` and
// `canonical_producer_unit_result`. DORMANT: nothing in the Worker imports it, it is not bundled (build.mjs is unchanged), `epgSync` does not call it and no route, job, cron or Task does. The decisions live in the pure S4-1 module
// (src/canonical-producer-run.js: `resumeDecision`, `strikeStep`, `failureWrite`, `mintDictionaryVersion`); this module turns each decision into ONE fenced D1 batch and names its failure.
// What is here, by ADR 0128 decision:
//   4  `openEpgRun`, `mintDictionaryRun`   create or resume a run by compare-and-set (insert-or-ignore then read back; parallel planners converge on one row), replay on a changed fingerprint (pass_no + 1, cursor and strike cleared), and the
//                                          guarded dictionary INSERT (seq = latest + 1, reuse on an equal digest, a lost race re-reads and decides again).
//   7  `commitStrike`                      a strike write: ONLY the strike columns, compare-and-set on the run revision.
//   5  `commitSlice`                       ONE batch: marker fence, run revision (compare-and-set), the failure results of the slice (insert, update or supersede, as `failureWrite` decided), the counts and the new cursor.
//   11 `commitPassComplete`                the only writer of `applied_generation`, in the batch that sets `pass_state='passed'` and `open_at_completion`.
//   6  `commitStop`                        a systemic stop: pass_state `stopped` and `stopped_by`, no strike column and no cursor touched.
//   8  `dueResults`, `settleResult`        the due live results the retry pass takes (owner `unit` only, ordered by next_attempt_at then key) and the terminal settle (compare-and-set on state and attempts).
// Dormancy and fences (decision 13): every writer reads the marker ONCE through `writerRoute` and, below `open`, returns `skipped` after that read; `held` and an unreadable marker throw. Every batch starts with the marker fence (`d1`/`open`/the
// generation read) and the SQL triggers of the tables refuse any write outside `open`, so at `prepared` the tables stay empty even against a code defect. A failed batch is classified from the stored state (a moved marker is
// `film_person_fence`, a lost compare-and-set `producer_cas_lost`, a refused slice or strike `producer_slice_commit_failed` / `producer_strike_commit_failed`, a missing table `producer_store_missing`, anything else `producer_transport`) and
// changes nothing. No receipt, no canonical Film or Person row, no R2 and no network is touched here, and nothing here reads a flag.
import {database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';
import {writerRoute} from './canonical-writer-route.js';
import {LIVE_STATES,NO_STRIKE,ORIGINS,PRODUCER_PLAN_VERSION,TERMINAL_STATES,canTransition,keyOfRow,mintDictionaryVersion,resumeDecision} from './canonical-producer-run.js';

export const SLICE_STATEMENT_CAP=48;
export const DUE_LIMIT_MAX=50;
const {assertSql,FENCE}=fenced;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const DIGEST=/^[0-9a-f]{64}$/;
const invalid=()=>failed('film_person_invalid');
const RUN_COLUMNS='origin,run_key,seq,prev_seq,snapshot_digest,source_generation,applied_generation,pass_no,plan_version,fingerprint,unit_count,cursor_kind,cursor_id,pass_state,stopped_by,strike_kind,strike_id,strike_digest,strike_class,strike_count,n_applied,n_noop,n_kept,n_failed,open_at_completion,marker_generation,revision,created_at,updated_at,completed_at';
const RESULT_COLUMNS='origin,run_key,pass_no,kind,unit_id,fingerprint,unit_digest,state,retry_owner,request_id,code,attempts,prereq_stamp,next_attempt_at,settled_by,created_at,updated_at,settled_at';
const casRun=(run)=>[assertSql('EXISTS (SELECT 1 FROM canonical_producer_run WHERE origin=? AND run_key=? AND revision=?)'),[run.origin,run.run_key,run.revision]];
const changesOne=()=>[assertSql('changes()=1'),[]];
const fence=gate=>[FENCE,[gate.generation]];

// The marker route, once. Returns {open:false} below `open` (the caller returns `skipped`), otherwise the generation the batches are fenced with.
async function routeOf(env){
 const route=await writerRoute(env);
 return route.writer==='canonical'?{open:true,generation:route.generation}:{open:false};
}
const SKIPPED=Object.freeze({state:'skipped',reason:'projector_is_writer'});

// A failed batch, named from what is stored now. `cause` says which write it was.
async function refuse(env,gate,error,cause,run){
 const message=String(error?.message||error);
 if(/no such table: canonical_producer/i.test(message))return failed('producer_store_missing',error);
 if(/canonical_producer_not_open|canonical_producer_stale_generation/i.test(message))return failed('film_person_fence',error);
 if(/CHECK constraint failed|canonical_producer_|UNIQUE constraint failed|FOREIGN KEY constraint failed/i.test(message)){
  let again;
  try{again=await readAuthority(env);}catch{return failed('producer_marker_unreadable',error);}
  if(again.state!=='open'||again.generation!==gate.generation)return failed('film_person_fence',error);
  // The run row this write was built from: when its revision moved (or the row is gone) the compare-and-set was lost, whatever else the batch held.
  if(run){
   let stored;
   try{stored=await one(database(env),'SELECT revision FROM canonical_producer_run WHERE origin=? AND run_key=?',[run.origin,run.run_key]);}catch{return failed('producer_run_unreadable',error);}
   if(!stored||stored.revision!==run.revision)return failed('producer_cas_lost',error);
  }
  return failed({cas:'producer_cas_lost',slice:'producer_slice_commit_failed',strike:'producer_strike_commit_failed'}[cause]||'producer_cas_lost',error);
 }
 return failed('producer_transport',error);
}
async function commit(env,gate,statements,cause,run){
 const db=database(env);
 if(!db||typeof db.batch!=='function')throw failed('producer_transport');
 if(statements.length>SLICE_STATEMENT_CAP)throw failed('film_person_bounded');
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));}
 catch(error){throw await refuse(env,gate,error,cause,run);}
}

// ---- reads ----
export async function readRun(env,{origin,runKey}={}){
 if(!ORIGINS.includes(origin)||typeof runKey!=='string'||!runKey)throw invalid();
 try{return (await one(database(env),'SELECT '+RUN_COLUMNS+' FROM canonical_producer_run WHERE origin=? AND run_key=?',[origin,runKey]))||null;}
 catch(error){throw /no such table/i.test(String(error?.message))?failed('producer_store_missing',error):failed('producer_run_unreadable',error);}
}
// The newest dictionary run (highest seq), or null.
export async function latestDictionaryRun(env){
 try{return (await one(database(env),"SELECT run_key,seq,snapshot_digest,pass_state FROM canonical_producer_run WHERE origin='dictionary' ORDER BY seq DESC LIMIT 1"))||null;}
 catch(error){throw /no such table/i.test(String(error?.message))?failed('producer_store_missing',error):failed('producer_run_unreadable',error);}
}
// The live result of one unit of a run (at most one by the partial unique index), or null.
export async function liveResult(env,{origin,runKey,kind,unitId}){
 return (await one(database(env),'SELECT '+RESULT_COLUMNS+' FROM canonical_producer_unit_result WHERE origin=? AND run_key=? AND kind=? AND unit_id=? AND state IN ('+LIVE_STATES.map(()=>'?').join(',')+')',[origin,runKey,kind,unitId,...LIVE_STATES]))||null;
}
// The due LIVE results the retry pass may take: owner `unit`, state open or recoverable, next_attempt_at <= now, ordered by next_attempt_at then key. At most DUE_LIMIT_MAX. Read-only.
export async function dueResults(env,{now,limit=DUE_LIMIT_MAX}={}){
 if(typeof now!=='string'||!Number.isFinite(Date.parse(now)))throw invalid();
 const cap=Math.min(Math.max(Number(limit)||1,1),DUE_LIMIT_MAX);
 try{
  return await many(database(env),"SELECT "+RESULT_COLUMNS+" FROM canonical_producer_unit_result WHERE retry_owner='unit' AND state IN ('open','refused_recoverable') AND next_attempt_at<=? ORDER BY next_attempt_at,origin,run_key,pass_no,kind,unit_id LIMIT ?",[now,cap]);
 }catch(error){throw /no such table/i.test(String(error?.message))?failed('producer_store_missing',error):failed('producer_run_unreadable',error);}
}

// S4-4: the newest run of origin `epg` (by creation time, then key), or null. Read-only; the input of `canonicalFreshness`.
export async function latestEpgRun(env){
 try{return (await one(database(env),"SELECT "+RUN_COLUMNS+" FROM canonical_producer_run WHERE origin='epg' ORDER BY created_at DESC,run_key DESC LIMIT 1"))||null;}
 catch(error){throw /no such table/i.test(String(error?.message))?failed('producer_store_missing',error):failed('producer_run_unreadable',error);}
}
// S4-4: the number of LIVE membership-affecting results (kind `film_facts`, origin `epg`, any run): the third input of `canonicalFreshness` and the `open_at_completion` of a pass. Read-only.
export async function liveMembershipCount(env){
 try{
  const row=await one(database(env),"SELECT COUNT(*) AS n FROM canonical_producer_unit_result WHERE origin='epg' AND kind='film_facts' AND state IN ("+LIVE_STATES.map(()=>'?').join(',')+')',[...LIVE_STATES]);
  return Number(row?.n??0);
 }catch(error){throw /no such table/i.test(String(error?.message))?failed('producer_store_missing',error):failed('producer_run_unreadable',error);}
}

// ---- run lifecycle ----
const INSERT_EPG="INSERT INTO canonical_producer_run (origin,run_key,source_generation,pass_no,plan_version,fingerprint,unit_count,pass_state,marker_generation,revision,created_at,updated_at) VALUES ('epg',?,?,1,?,?,?,'passing',?,1,?,?) ON CONFLICT(origin,run_key) DO NOTHING";
// Create or resume the run of one EPG event. input: {runKey (the EPG event id), sourceGeneration (the published generation the plan was built from), planVersion?, fingerprint, units (the ORDERED entries the fingerprint covers), at}.
// Returns {state:'skipped'} below `open`, else {state:'created'|'resume'|'replay', run, startIndex}. A fingerprint that differs from the stored one is ONE compare-and-set (pass_no + 1, the new fingerprint, cursor and strike cleared); a run whose pass
// already completed with an applied claim is never replayed (`producer_cas_lost`: the claim belongs to the plan it was completed for).
export async function openEpgRun(env,{runKey,sourceGeneration,planVersion=PRODUCER_PLAN_VERSION,fingerprint,units,at}={}){
 if(typeof runKey!=='string'||!runKey||runKey.length>160||typeof sourceGeneration!=='string'||!sourceGeneration||sourceGeneration.length>200||!DIGEST.test(fingerprint||'')||!Array.isArray(units)||typeof at!=='string'||!Number.isInteger(planVersion)||planVersion<1)throw invalid();
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),[INSERT_EPG,[runKey,sourceGeneration,planVersion,fingerprint,units.length,gate.generation,at,at]]],'cas');
 const stored=await readRun(env,{origin:'epg',runKey});
 if(!stored)throw failed('producer_run_unreadable');
 // The source generation is part of the run identity (ADR 0128): an existing run of this event that was planned for another generation is never resumed or replayed (the claim written at pass completion would name the wrong generation).
 if(stored.source_generation!==sourceGeneration)throw failed('producer_source_generation_mismatch');
 const created=stored.revision===1&&stored.created_at===at&&stored.fingerprint===fingerprint&&stored.pass_no===1&&stored.cursor_id===null;
 const decision=resumeDecision({stored,fingerprint,units});
 if(decision.action==='resume')return {state:created?'created':'resume',run:stored,startIndex:decision.startIndex};
 if(stored.applied_generation!==null)throw failed('producer_cas_lost');
 await commit(env,gate,[
  fence(gate),casRun(stored),
  ["UPDATE canonical_producer_run SET pass_no=?,fingerprint=?,plan_version=?,unit_count=?,cursor_kind=NULL,cursor_id=NULL,strike_kind=NULL,strike_id=NULL,strike_digest=NULL,strike_class=NULL,strike_count=0,pass_state='passing',stopped_by=NULL,revision=revision+1,updated_at=? WHERE origin='epg' AND run_key=? AND revision=?",[decision.pass_no,fingerprint,planVersion,units.length,at,runKey,stored.revision]],
  changesOne(),
 ],'cas',stored);
 return {state:'replay',run:await readRun(env,{origin:'epg',runKey}),startIndex:0};
}

// The dictionary version: reuse the latest run when its snapshot digest is equal, else mint seq = latest + 1 in ONE guarded INSERT (the trigger and the unique (origin, seq) index refuse a gap, a duplicate and an equal-digest mint). A lost race re-reads
// and decides again (at most twice). input: {snapshotDigest, planVersion?, fingerprint, unitCount, at}. Returns {state:'skipped'} below `open`, else {state:'reuse'|'minted', run}. The previous run is marked `superseded` in the same batch.
export async function mintDictionaryRun(env,{snapshotDigest,planVersion=PRODUCER_PLAN_VERSION,fingerprint,unitCount,at}={}){
 if(!DIGEST.test(snapshotDigest||'')||!DIGEST.test(fingerprint||'')||!Number.isInteger(unitCount)||unitCount<0||typeof at!=='string'||!Number.isInteger(planVersion)||planVersion<1)throw invalid();
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 for(let attempt=0;attempt<3;attempt++){
  const latest=await latestDictionaryRun(env);
  const verdict=mintDictionaryVersion({latest:latest&&{seq:latest.seq,run_key:latest.run_key,snapshot_digest:latest.snapshot_digest},snapshotDigest});
  if(verdict.action==='reuse')return {state:'reuse',run:await readRun(env,{origin:'dictionary',runKey:verdict.run_key})};
  const statements=[fence(gate)];
  if(verdict.supersedes)statements.push(["UPDATE canonical_producer_run SET pass_state='superseded',revision=revision+1,updated_at=? WHERE origin='dictionary' AND run_key=? AND pass_state<>'superseded'",[at,verdict.supersedes]]);
  statements.push(["INSERT INTO canonical_producer_run (origin,run_key,seq,prev_seq,snapshot_digest,pass_no,plan_version,fingerprint,unit_count,pass_state,marker_generation,revision,created_at,updated_at) VALUES ('dictionary',?,?,?,?,1,?,?,?,'passing',?,1,?,?)",[verdict.run_key,verdict.seq,verdict.prev_seq,snapshotDigest,planVersion,fingerprint,unitCount,gate.generation,at,at]]);
  try{await commit(env,gate,statements,'cas');}
  catch(error){
   // A lost race (the version was minted by another planner between the read and the INSERT): read again and decide again. Any other failure propagates.
   if(error?.code==='producer_cas_lost'&&attempt<2)continue;
   throw error;
  }
  return {state:'minted',run:await readRun(env,{origin:'dictionary',runKey:verdict.run_key})};
 }
 throw failed('producer_cas_lost');
}

// ---- strike, slice, completion, stop ----
const STRIKE_SET='strike_kind=?,strike_id=?,strike_digest=?,strike_class=?,strike_count=?';
const strikeParams=strike=>[strike.strike_kind??null,strike.strike_id??null,strike.strike_digest??null,strike.strike_class??null,strike.strike_count??0];
// A strike-eligible failure of a unit, recorded ONLY in the strike columns (the cursor does not move). `next` is the `run` of `strikeStep(...)` with action 'strike'.
export async function commitStrike(env,{run,next,at}={}){
 if(!plain(run)||!plain(next)||!Number.isInteger(next.strike_count)||next.strike_count<1||next.strike_count>2||typeof at!=='string')throw invalid();
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),casRun(run),
  ['UPDATE canonical_producer_run SET '+STRIKE_SET+',revision=revision+1,updated_at=? WHERE origin=? AND run_key=? AND revision=?',[...strikeParams(next),at,run.origin,run.run_key,run.revision]],changesOne()],'strike',run);
 return {state:'committed',run:await readRun(env,{origin:run.origin,runKey:run.run_key})};
}

const resultInsert=row=>['INSERT INTO canonical_producer_unit_result ('+RESULT_COLUMNS+') VALUES ('+RESULT_COLUMNS.split(',').map(()=>'?').join(',')+')',RESULT_COLUMNS.split(',').map(column=>row[column]??null)];
function resultStatements(write){
 const out=[];
 if(write.supersede){
  const {key,patch}=write.supersede;
  out.push(["UPDATE canonical_producer_unit_result SET state=?,settled_by=?,settled_at=?,updated_at=?,next_attempt_at=NULL WHERE origin=? AND run_key=? AND pass_no=? AND kind=? AND unit_id=? AND state IN ("+LIVE_STATES.map(()=>'?').join(',')+')',[patch.state,patch.settled_by,patch.settled_at,patch.updated_at,key.origin,key.run_key,key.pass_no,key.kind,key.unit_id,...LIVE_STATES]],changesOne());
 }
 if(write.insert)out.push(resultInsert(write.insert));
 if(write.update){
  const {key,patch}=write.update;
  out.push(['UPDATE canonical_producer_unit_result SET state=?,code=?,attempts=?,prereq_stamp=?,next_attempt_at=?,updated_at=? WHERE origin=? AND run_key=? AND pass_no=? AND kind=? AND unit_id=? AND state IN ('+LIVE_STATES.map(()=>'?').join(',')+')',[patch.state,patch.code,patch.attempts,patch.prereq_stamp??null,patch.next_attempt_at??null,patch.updated_at,key.origin,key.run_key,key.pass_no,key.kind,key.unit_id,...LIVE_STATES]],changesOne());
 }
 return out;
}
// THE SLICE COMMIT (decision 5): one batch. run: the stored run row read for this slice; next: {cursor_kind, cursor_id, strike_kind?, strike_id?, strike_digest?, strike_class?, strike_count?} the new cursor and strike columns (the `run` of the `strikeStep`
// outcomes, folded over the slice); writes: the outputs of `failureWrite` ({insert}|{update}|{supersede,insert}|{none}); counts: {applied, noop, kept, failed}. A slice with no durable outcome is refused (the cursor only advances).
export async function commitSlice(env,{run,next,writes=[],counts={},at}={}){
 if(!plain(run)||!plain(next)||typeof next.cursor_kind!=='string'||typeof next.cursor_id!=='string'||!Array.isArray(writes)||typeof at!=='string')throw invalid();
 const delta={applied:0,noop:0,kept:0,failed:0,...counts};
 for(const value of Object.values(delta))if(!Number.isInteger(value)||value<0)throw invalid();
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const statements=[fence(gate),casRun(run)];
 for(const write of writes){
  if(!plain(write))throw invalid();
  for(const statement of resultStatements(write))statements.push(statement);
 }
 const strike=next.strike_count===undefined?{...NO_STRIKE}:next;
 statements.push(['UPDATE canonical_producer_run SET cursor_kind=?,cursor_id=?,'+STRIKE_SET+',n_applied=n_applied+?,n_noop=n_noop+?,n_kept=n_kept+?,n_failed=n_failed+?,revision=revision+1,updated_at=? WHERE origin=? AND run_key=? AND revision=?',
  [next.cursor_kind,next.cursor_id,...strikeParams(strike),delta.applied,delta.noop,delta.kept,delta.failed,at,run.origin,run.run_key,run.revision]],changesOne());
 await commit(env,gate,statements,'slice',run);
 return {state:'committed',run:await readRun(env,{origin:run.origin,runKey:run.run_key})};
}

// The pass-complete commit: the ONLY writer of `applied_generation` (an EPG run: equal to its `source_generation`) with `pass_state='passed'`, `open_at_completion` (the number of live membership-affecting results) and the completion time.
export async function commitPassComplete(env,{run,openAtCompletion,at}={}){
 if(!plain(run)||run.origin!=='epg'||typeof run.source_generation!=='string'||!Number.isInteger(openAtCompletion)||openAtCompletion<0||typeof at!=='string')throw invalid();
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),casRun(run),
  ["UPDATE canonical_producer_run SET pass_state='passed',applied_generation=source_generation,open_at_completion=?,completed_at=?,stopped_by=NULL,revision=revision+1,updated_at=? WHERE origin=? AND run_key=? AND revision=?",[openAtCompletion,at,at,run.origin,run.run_key,run.revision]],changesOne()],'slice',run);
 return {state:'committed',run:await readRun(env,{origin:run.origin,runKey:run.run_key})};
}

// A systemic stop: where it stopped and why, with NO strike column and NO cursor touched.
export async function commitStop(env,{run,stoppedBy,at}={}){
 if(!plain(run)||typeof stoppedBy!=='string'||!/^[a-z][a-z_0-9]{0,79}$/.test(stoppedBy)||typeof at!=='string')throw invalid();
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),casRun(run),
  ["UPDATE canonical_producer_run SET pass_state='stopped',stopped_by=?,revision=revision+1,updated_at=? WHERE origin=? AND run_key=? AND revision=?",[stoppedBy,at,run.origin,run.run_key,run.revision]],changesOne()],'slice',run);
 return {state:'committed',run:await readRun(env,{origin:run.origin,runKey:run.run_key})};
}

// ---- result settle ----
// The terminal settle of ONE live result, compare-and-set on its state and attempts (a row another path moved is refused, `producer_cas_lost`). state: settled | superseded | abandoned.
export async function settleResult(env,{row,state,settledBy,at}={}){
 if(!plain(row)||!TERMINAL_STATES.includes(state)||!canTransition(row.state,state)||typeof settledBy!=='string'||!/^[a-z][a-z_0-9]{0,63}$/.test(settledBy)||typeof at!=='string')throw invalid();
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const key=keyOfRow(row);
 await commit(env,gate,[fence(gate),
  ["UPDATE canonical_producer_unit_result SET state=?,settled_by=?,settled_at=?,updated_at=?,next_attempt_at=NULL WHERE origin=? AND run_key=? AND pass_no=? AND kind=? AND unit_id=? AND state=? AND attempts=?",[state,settledBy,at,at,key.origin,key.run_key,key.pass_no,key.kind,key.unit_id,row.state,row.attempts]],changesOne()],'cas');
 return {state:'committed'};
}

// S4-4: the in-place move of ONE live result (a reclassification or a deferred schedule), compare-and-set on its state and attempts; the identity columns and the owner never change. `patch` is the patch of `afterRetry` ('update') or
// `retryDecision` ('defer'); a terminal state goes through `settleResult`. Returns {state:'committed'} or {state:'skipped'} below `open`; a row another path moved is `producer_cas_lost`.
const PATCH_KEYS=['state','code','attempts','prereq_stamp','next_attempt_at','updated_at'];
export async function updateResult(env,{row,patch,at}={}){
 if(!plain(row)||!LIVE_STATES.includes(row.state)||!plain(patch)||typeof at!=='string'||Object.keys(patch).some(key=>!PATCH_KEYS.includes(key)))throw invalid();
 const next={...row,...patch};
 if(!LIVE_STATES.includes(next.state)||!Number.isInteger(next.attempts)||next.attempts<row.attempts)throw invalid();
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const key=keyOfRow(row);
 await commit(env,gate,[fence(gate),
  ['UPDATE canonical_producer_unit_result SET state=?,code=?,attempts=?,prereq_stamp=?,next_attempt_at=?,updated_at=? WHERE origin=? AND run_key=? AND pass_no=? AND kind=? AND unit_id=? AND attempts=? AND state=?',
   [next.state,next.code,next.attempts,next.prereq_stamp??null,next.next_attempt_at??null,patch.updated_at??at,key.origin,key.run_key,key.pass_no,key.kind,key.unit_id,row.attempts,row.state]],changesOne()],'cas');
 return {state:'committed'};
}

// S4-4: a stopped pass that a later step takes over is `passing` again (a strike or slice write on a `stopped` row is refused by the SQL trigger, which keeps a stop from touching a strike). ONE compare-and-set that touches only the state and
// `stopped_by`: no cursor, no strike column, no count. A run that is not `stopped` is refused (`film_person_invalid`: the caller reads the run first).
export async function commitResume(env,{run,at}={}){
 if(!plain(run)||run.pass_state!=='stopped'||typeof at!=='string')throw invalid();
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),casRun(run),
  ["UPDATE canonical_producer_run SET pass_state='passing',stopped_by=NULL,revision=revision+1,updated_at=? WHERE origin=? AND run_key=? AND revision=? AND pass_state='stopped'",[at,run.origin,run.run_key,run.revision]],changesOne()],'slice',run);
 return {state:'committed',run:await readRun(env,{origin:run.origin,runKey:run.run_key})};
}
