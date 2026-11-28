// AIR-607 / ADR 0219 decisions 2 and 3: the operator contract that activates the RATED Catalog Enrichment scope (src/catalog-enrichment-activation.js) on the real migrated schema: refusal before any write, the fail-closed
// preflight (held authority, the whole schema, a live lease), the approved envelope asserted at the insert, on every bootstrap page and at the final control commit (controlled interleavings), outcome classification (lost reply,
// unreadable commit), the strict noop and recovery, and the wake of already-runnable work through the existing protocol. The module is dormant (nothing imports it); the production operation needs its own owner GO.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as A from '../src/catalog-enrichment-activation.js';
import * as S from '../src/catalog-enrichment-store.js';
import * as B from '../src/catalog-enrichment-bootstrap.js';
import * as W from '../src/catalog-enrichment-workflow.js';

const T='2026-11-28T10:00:00.000Z';
const OLD='2026-10-01T00:00:00.000Z',CUTOFF='2026-11-01T00:00:00.000Z',NEW='2026-11-10T00:00:00.000Z',LATER='2026-11-29T00:00:00.000Z';
const GO='https://trello.com/c/Daq02gYy#comment-owner-go';
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=String(r.stdout).trim();return o?JSON.parse(o):[];};
const pad=n=>String(n).padStart(4,'0');
const admission=(i,verified,at=T)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:r${pad(i)}',2,NULL,'R','${at}');INSERT INTO film_external_id VALUES ('film:r${pad(i)}','tmdb','${1000+i}',1,0,NULL);INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:r${pad(i)}','${1000+i}','code${i}','${'a'.repeat(64)}','T',2000,'k','tmdb_${1000+i}','${verified}','q','${at}');`;
// 130 rated admissions: 30 before the cutoff and 100 at or after it; the inbox is emptied (no scope was active when they were inserted). `upTo` builds an older complete schema (47: provenance absent).
function world({open=true,upTo=Infinity,held=false,films=true}={}){
 const file=migrated(upTo);
 if(open)sql(file,OPEN);
 if(held)sql(file,"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1;");
 if(films){
  sql(file,Array.from({length:30},(_,i)=>admission(i,OLD)).join('')+Array.from({length:100},(_,i)=>admission(30+i,NEW)).join(''));
  sql(file,'DELETE FROM enrichment_signal;');
 }
 return {file,env:{DB:d1Standin(file)}};
}
// A D1 binding that runs `before(statements)` before and `after(statements)` after every batch (an `after` that throws is a committed batch whose reply was lost), and can go blind on the control table.
// `window` runs ONCE, in the gap after the last bootstrap page and before the final control read and commit.
function interleaved(file,{before=null,after=null,binding=null,window=null}={}){
 const real=d1Standin(file);
 const state={blind:false,batches:0,armed:false};
 const DB={...real,prepare(text){if(state.blind&&/catalog_enrichment_control/.test(text))throw new Error('d1 unavailable');if(window&&state.armed&&/FROM catalog_enrichment_control WHERE id=1/.test(text)){state.armed=false;window();}return real.prepare(text);},async batch(statements){state.batches++;if(before)await before(statements,state);const out=await real.batch(statements);if(isLastPage(statements))state.armed=true;if(after)await after(statements,state);return out;}};
 return {env:{DB,...(binding?{CATALOG_ENRICHMENT_WORKFLOW:binding}:{})},state};
}
const op=(over={})=>({cutoffAt:CUTOFF,by:'operator:AIR-607',at:T,goReference:GO,...over});
const snapshot=file=>JSON.stringify([rows(file,'SELECT * FROM catalog_enrichment_scope'),rows(file,'SELECT * FROM catalog_enrichment_control'),rows(file,'SELECT subject,state,version FROM enrichment_signal ORDER BY subject'),rows(file,'SELECT * FROM film_person_authority')]);
const isScopeInsert=statements=>/INSERT INTO catalog_enrichment_scope/.test(statements[0].text);
const isPage=statements=>/INSERT INTO enrichment_signal/.test(statements[0].text)||/UPDATE catalog_enrichment_scope SET bootstrap_cursor/.test(statements.at(-1).text);
const isLastPage=statements=>/UPDATE catalog_enrichment_scope SET bootstrap_cursor/.test(statements.at(-1).text)&&/'done'/.test(statements.at(-1).text);
const isControl=statements=>statements.some(item=>/^UPDATE catalog_enrichment_control SET state='active'/.test(item.text));
const controlRow=file=>rows(file,'SELECT state,generation,revision,updated_by FROM catalog_enrichment_control')[0]||null;

// ---- invalid input refuses before any read or write ----
{
 const {file,env}=world();
 const before=snapshot(file);
 for(const [over,code] of [
  [{cutoffAt:'2026-11-01'},'invalid_cutoff'],[{cutoffAt:null},'invalid_cutoff'],[{cutoffAt:LATER},'cutoff_in_future'],
  [{cutoffAt:'2026-13-45T00:00:00.000Z'},'invalid_cutoff'],[{cutoffAt:'2026-02-31T00:00:00.000Z'},'invalid_cutoff'],[{at:'2026-99-99T10:00:00.000Z'},'invalid_time'],
  [{goReference:undefined},'go_reference_missing'],[{goReference:'owner said yes'},'go_reference_missing'],
  [{by:''},'invalid_operator'],[{by:'x'.repeat(121)},'invalid_operator'],[{at:'now'},'invalid_time'],
  [{by:'x'.repeat(100),goReference:'https://trello.com/c/Daq02gYy#comment-'+'a'.repeat(80)},'actor_too_long']
 ]){
  const out=await A.activateRated(env,op(over));
  assert.equal(out.outcome,'refused');assert.ok(out.problems.includes(code),code+': '+JSON.stringify(out.problems));
  assert.deepEqual(out.effects,{scopeInserted:false,bootstrapRows:0});
 }
 assert.equal(snapshot(file),before,'a refused input writes nothing');
}

// ---- the preflight is fail closed; an initial refusal changes no scope, signal or control ----
const refused=async(label,{file,env},expected,over={})=>{
 const before=snapshot(file);
 const out=await A.activateRated(env,op(over));
 assert.equal(out.outcome,'refused',label+': '+JSON.stringify(out));
 assert.deepEqual(out.problems,expected,label);
 assert.equal(snapshot(file),before,label+': nothing was written');
 return out;
};
{
 // the marker is not open: r2/prepared (the fixture before the flip) and a VALID d1/held marker, which readAuthority serves with open:false
 await refused('r2 marker',world({open:false}),['film_person_marker_not_open']);
 const held=world({held:true});
 assert.deepEqual(rows(held.file,'SELECT mode,cutover FROM film_person_authority'),[{mode:'d1',cutover:'held'}],'a valid held marker');
 const out=await refused('held marker',held,['film_person_marker_not_open']);
 assert.deepEqual(out.facts.filmPersonMarker,{state:'held',generation:3},'the real state and generation are reported');
}
{
 const world1=world();
 sql(world1.file,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('catalog_enrichment','lease-live-0001','2026-11-28T10:04:00.000Z','2026-11-28T09:59:00.000Z')");
 const out=await refused('a live lease',world1,['lease_held']);
 assert.deepEqual(out.facts.lease,{until:'2026-11-28T10:04:00.000Z'});
 // an expired lease is not an owner
 sql(world1.file,"UPDATE projection_run SET lease_until='2026-11-28T09:00:00.000Z' WHERE projection='catalog_enrichment'");
 assert.equal((await A.ratedActivationPreflight(world1.env,{cutoffAt:CUTOFF,now:T})).ok,true,'an expired lease does not block');
}
{
 const w=world();
 sql(w.file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('c3a',1,1,NULL,1,'${T}')`);
 await refused('another scope',w,['other_scope_present']);
 const s=world();
 sql(s.file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_ref,armed_at,attempts) VALUES ('admitted','tmdb:1','discovery','',1,0,'staged','x','${T}',0)`);
 await refused('a staged signal',s,['stale_staged_signals']);
 const c=world();
 assert.equal((await S.activateControl(c.env,{expectedRevision:0,by:'x',at:T})).outcome,'applied');
 await refused('an active control with no scope',c,['active_configuration_mismatch']);
}
{
 // the whole relevant schema: a missing producer table, the shared upstream coordination, the lease table and the operation-key column, each at an otherwise complete latest schema
 for(const table of ['catalog_enrichment_tick','catalog_enrichment_unit_generation','upstream_cooldown','upstream_coordination']){
  const w=world();
  sql(w.file,`DROP TABLE ${table};`);
  const out=await refused('missing '+table,w,['schema_not_applied']);
  assert.deepEqual(out.facts.missingTables,[table]);
 }
 const w=world();
 sql(w.file,"DROP TABLE projection_run;");
 assert.deepEqual((await refused('missing projection_run',w,['schema_not_applied'])).facts.missingTables,['projection_run']);
 const k=world();
 for(const index of rows(k.file,"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='canonical_write_receipt' AND sql LIKE '%operation_key%'"))sql(k.file,`DROP INDEX ${index.name};`);
 for(const trigger of rows(k.file,"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='canonical_write_receipt' AND sql LIKE '%operation_key%'"))sql(k.file,`DROP TRIGGER ${trigger.name};`);
 sql(k.file,'ALTER TABLE canonical_write_receipt DROP COLUMN operation_key;');
 const out=await refused('missing operation_key',k,['schema_not_applied']);
 assert.equal(out.facts.operationKey,false);
 const below=world({upTo:46,films:false});
 assert.deepEqual((await A.activateRated(below.env,op())).problems,['schema_not_applied'],'a schema below the producer\'s refuses');
}

// ---- the whole activation on the latest schema AND on a complete v47 with the provenance schema absent ----
for(const upTo of [Infinity,47]){
 const {file,env}=world({upTo});
 const generation=rows(file,'SELECT generation FROM film_person_authority')[0].generation;
 assert.equal((await S.readControl(env)).state,'inactive');
 const out=await A.activateRated(env,op({pageSize:40}));
 assert.equal(out.outcome,'activated',JSON.stringify(out.problems||out));
 assert.deepEqual(out.effects,{scopeInserted:true,bootstrapRows:100});
 assert.deepEqual([out.bootstrap.outcome,out.bootstrap.rows,out.bootstrap.pages],['done',100,3]);
 assert.deepEqual(out.scopes,[{scope:'rated',activated:1,enabled:1,cutoffAt:CUTOFF,bootstrapState:'done',revision:1}],'exactly the rated scope with the approved cutoff');
 assert.equal(out.onlyRatedScope,true);
 assert.equal(out.control.state,'active');assert.ok(out.control.generation>=1&&out.control.revision>=2);
 assert.equal(out.control.updatedBy,'operator:AIR-607 go:'+GO,'the control records who and the exact GO, untruncated');
 assert.deepEqual([out.qualifyingAdmissions,out.ratedSignals],[100,100],'every qualifying admission has its signal; rows before the cutoff have none');
 assert.deepEqual(out.signals,[{source:'rated',state:'pending',count:100}]);
 assert.deepEqual(out.wake,{outcome:'deferred',reason:'no_workflow_binding'},'with no Workflow binding the safety net wakes it; the activation stays applied');
 assert.equal(rows(file,'SELECT generation FROM film_person_authority')[0].generation,generation,'the authority marker was not touched');
 assert.deepEqual(rows(file,'SELECT scope FROM catalog_enrichment_scope'),[{scope:'rated'}],'no discovery, c3a or c3b scope');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE subject IN ('tmdb:1000','tmdb:1029')")[0].n,0,'a pre-cutoff admission is not eligible');
 // the same call again changes nothing
 const before=snapshot(file);
 const again=await A.activateRated(env,op());
 assert.deepEqual([again.outcome,again.reason],['noop','already_active']);
 assert.equal(snapshot(file),before);
 // a different cutoff after activation never changes anything either
 const other=await A.activateRated(env,op({cutoffAt:OLD}));
 assert.equal(other.outcome,'refused');assert.deepEqual(other.problems,['active_configuration_mismatch']);
 assert.equal(snapshot(file),before);
 // the live trigger: an admission verified after the activation emits its own signal
 sql(file,admission(500,'2026-11-28T11:00:00.000Z','2026-11-28T11:00:00.000Z'));
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE subject='tmdb:1500' AND state='pending'")[0].n,1,'a new rated admission is eligible from day one');
 assert.deepEqual([(await A.readActivation(env)).qualifyingAdmissions,(await A.readActivation(env)).ratedSignals],[101,101]);
}

// ---- the approved envelope is asserted at every write boundary ----
{
 // the marker moves between the preflight and the scope insert: the guarded insert applies nothing
 const {file}=world();
 const {env}=interleaved(file,{before:async(statements)=>{if(isScopeInsert(statements))sql(file,"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1;");}});
 const out=await A.activateRated(env,op());
 assert.equal(out.outcome,'refused');assert.deepEqual(out.problems,['scope_not_written']);
 assert.deepEqual(out.effects,{scopeInserted:false,bootstrapRows:0});
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_scope')[0].n,0);assert.equal(controlRow(file),null);assert.equal(rows(file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,0);
}
{
 // a staged signal appears between the preflight and the insert
 const {file}=world();
 const {env}=interleaved(file,{before:async(statements)=>{if(isScopeInsert(statements))sql(file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_ref,armed_at,attempts) VALUES ('admitted','tmdb:9','discovery','',1,0,'staged','x','${T}',0)`);}});
 const out=await A.activateRated(env,op());
 assert.deepEqual([out.outcome,out.problems],['refused',['scope_not_written']]);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_scope')[0].n,0);
}
{
 // a live lease appears between the preflight and the insert
 const {file}=world();
 const {env}=interleaved(file,{before:async(statements)=>{if(isScopeInsert(statements))sql(file,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('catalog_enrichment','lease-live-0002','2026-11-28T10:04:00.000Z','2026-11-28T09:59:00.000Z')");}});
 const out=await A.activateRated(env,op());
 assert.deepEqual([out.outcome,out.problems],['refused',['scope_not_written']]);
}
{
 // the scope configuration changes BETWEEN bootstrap pages (its revision moves): the next page stops instead of adopting it
 const {file}=world();
 let pages=0;
 const {env}=interleaved(file,{after:async(statements)=>{if(isPage(statements)&&++pages===1)sql(file,"UPDATE catalog_enrichment_scope SET revision=revision+1 WHERE scope='rated';");}});
 const out=await A.activateRated(env,op({pageSize:40}));
 assert.deepEqual([out.outcome,out.reason],['stopped','revision_moved']);
 assert.deepEqual(out.effects,{scopeInserted:true,bootstrapRows:40},'the committed first page is reported, not hidden');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,40,'only the first page was written');
 assert.equal(controlRow(file),null,'the control was never activated');

 // and a page that would START under a changed configuration stops on the pin, writing nothing
 const pinned=await B.bootstrapPage({DB:d1Standin(file)},{scope:'rated',at:T,pageSize:40,pin:{revision:1,cutoffAt:CUTOFF}});
 assert.deepEqual([pinned.outcome,pinned.reason,pinned.rows],['stopped','configuration_changed',0]);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,40);
}
{
 const {file}=world();
 let pages=0;
 const {env}=interleaved(file,{before:async(statements)=>{if(isPage(statements)&&++pages===2)sql(file,`UPDATE catalog_enrichment_scope SET cutoff_at='${OLD}' WHERE scope='rated';`);}});
 const out=await A.activateRated(env,op({pageSize:40}));
 assert.equal(out.outcome,'stopped');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,40,'the page read at the old cutoff wrote nothing under the new one');
 assert.equal(controlRow(file),null);
}
{
 // after the last page and before the control commit: another scope, a disabled rated scope, a staged signal, a held marker, a live lease
 const variants=[
  ['another scope',`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('discovery',1,1,NULL,1,'${T}')`],
  ['rated disabled',"UPDATE catalog_enrichment_scope SET enabled=0,revision=revision+1 WHERE scope='rated'"],
  ['rated cutoff changed',`UPDATE catalog_enrichment_scope SET cutoff_at='${OLD}',revision=revision+1 WHERE scope='rated'`],
  ['a staged signal',`INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_ref,armed_at,attempts) VALUES ('admitted','tmdb:9','discovery','',1,0,'staged','x','${T}',0)`],
  ['a held marker',"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1"],
  ['a live lease',"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('catalog_enrichment','lease-live-0003','2026-11-28T10:04:00.000Z','2026-11-28T09:59:00.000Z')"]
 ];
 for(const [label,change] of variants){
  const {file}=world();
  const {env}=interleaved(file,{window:()=>sql(file,change)});
  const out=await A.activateRated(env,op({pageSize:40}));
  assert.deepEqual([out.outcome,out.reason],['stopped','control_guard_failed'],label);
  assert.equal(controlRow(file),null,label+': the global control was never enabled');
  assert.deepEqual(out.effects,{scopeInserted:true,bootstrapRows:100},label+': partial effects are reported');
 }
}
{
 // the control commit applied but its reply was lost: read back, reported as activated with the note, never a false failure
 const {file}=world();
 const {env}=interleaved(file,{after:async(statements)=>{if(isControl(statements))throw new Error('reply lost');}});
 const out=await A.activateRated(env,op({pageSize:40}));
 assert.deepEqual([out.outcome,out.note],['activated','commit_reply_lost']);
 assert.equal(controlRow(file).state,'active');
}
{
 // the control commit's outcome cannot be read back: uncertain, not activated and not failed
 const {file}=world();
 const {env,state}=interleaved(file,{after:async(statements,s)=>{if(isControl(statements)){s.blind=true;throw new Error('reply lost');}}});
 const out=await A.activateRated(env,op({pageSize:40}));
 assert.deepEqual([out.outcome,out.reason],['uncertain','control_outcome_unknown']);
 assert.equal(state.blind,true);
 assert.equal(controlRow(file).state,'active','the commit did land; only the caller could not see it');
}

{
 // a scope change that lands in the last page's own commit window is caught by that page's readback, before the control is ever read
 for(const [label,change] of [['rated disabled',"UPDATE catalog_enrichment_scope SET enabled=0,revision=revision+1 WHERE scope='rated'"],['cutoff changed',`UPDATE catalog_enrichment_scope SET cutoff_at='${OLD}',revision=revision+1 WHERE scope='rated'`]]){
  const {file}=world();
  const {env}=interleaved(file,{after:async(statements)=>{if(isLastPage(statements))sql(file,change);}});
  const out=await A.activateRated(env,op({pageSize:40}));
  assert.deepEqual([out.outcome,out.reason],['stopped','revision_moved'],label);
  assert.equal(controlRow(file),null,label);
 }
}

// ---- resumable: a stopped bootstrap leaves the control inactive; the same call resumes from the stored cursor ----
{
 const {file,env}=world();
 const first=await A.activateRated(env,op({pageSize:40,maxPages:1}));
 assert.deepEqual([first.outcome,first.reason],['stopped','bootstrap_incomplete']);
 assert.equal((await S.readControl(env)).state,'inactive','the producer stays off until the bootstrap is done');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,40);
 // a different cutoff never continues someone else's activation
 const wrong=await A.activateRated(env,op({cutoffAt:OLD,pageSize:40}));
 assert.equal(wrong.outcome,'refused');assert.ok(wrong.problems.includes('scope_cutoff_mismatch'));
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,40);
 // an interrupted activation is resumed, not restarted
 const second=await A.activateRated(env,op({pageSize:40}));
 assert.equal(second.outcome,'activated');
 assert.deepEqual(second.effects,{scopeInserted:false,bootstrapRows:60});
 assert.deepEqual([second.qualifyingAdmissions,second.ratedSignals],[100,100]);
 assert.ok(rows(file,'SELECT version FROM enrichment_signal').every(row=>row.version===1),'the resume never re-arms a signal');
 assert.equal(rows(file,"SELECT revision FROM catalog_enrichment_scope WHERE scope='rated'")[0].revision,1,'the scope revision is unchanged by the bootstrap');
}
{
 // the bootstrap finished but the control commit was refused (a drainer lease appeared): no control row exists yet; once the lease is gone the same call goes straight to the commit and initializes the absent row in the same guarded batch
 const {file}=world();
 const {env}=interleaved(file,{window:()=>sql(file,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('catalog_enrichment','lease-live-0009','2026-11-28T10:04:00.000Z','2026-11-28T09:59:00.000Z')")});
 const first=await A.activateRated(env,op({pageSize:40}));
 assert.deepEqual([first.outcome,first.reason],['stopped','control_guard_failed']);
 assert.equal(controlRow(file),null,'neither the absent row nor an active control was written');
 assert.equal(rows(file,"SELECT bootstrap_state FROM catalog_enrichment_scope WHERE scope='rated'")[0].bootstrap_state,'done');
 sql(file,"UPDATE projection_run SET lease_id=NULL,lease_until=NULL WHERE projection='catalog_enrichment'");
 const second=await A.activateRated(env,op({pageSize:40}));
 assert.equal(second.outcome,'activated');
 assert.deepEqual(second.effects,{scopeInserted:false,bootstrapRows:0},'nothing is bootstrapped twice');
 assert.equal(controlRow(file).state,'active');
}

// ---- noop is strict, and recovery never strands an unfinished bootstrap ----
{
 const {file,env}=world();
 assert.equal((await A.activateRated(env,op({pageSize:40}))).outcome,'activated');
 // active, but another scope exists: not the approved rated-only configuration
 sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('discovery',1,1,NULL,1,'${T}')`);
 const mismatch=await A.activateRated(env,op());
 assert.deepEqual([mismatch.outcome,mismatch.problems],['refused',['active_configuration_mismatch']]);
 // active, but rated was disabled
 const {file:file2,env:env2}=world();
 assert.equal((await A.activateRated(env2,op({pageSize:40}))).outcome,'activated');
 sql(file2,"UPDATE catalog_enrichment_scope SET enabled=0,revision=revision+1 WHERE scope='rated'");
 assert.deepEqual((await A.activateRated(env2,op())).problems,['active_configuration_mismatch'],'matching cutoff and done bootstrap are not enough');
}
{
 // an applied activation whose bootstrap was left unfinished is recovered by the same call, with the wake
 const {file,env}=world();
 assert.equal((await A.activateRated(env,op({pageSize:40}))).outcome,'activated');
 sql(file,"DELETE FROM enrichment_signal;UPDATE catalog_enrichment_scope SET bootstrap_state='none',bootstrap_cursor=NULL WHERE scope='rated';");
 const out=await A.activateRated(env,op({pageSize:40}));
 assert.deepEqual([out.outcome,out.reason],['noop','bootstrap_recovered']);
 assert.deepEqual([out.ratedSignals,out.effects.bootstrapRows],[100,100],'the pending bootstrap was finished, not stranded');
}

// ---- the wake: already-runnable work is started after the final commit through the existing protocol; a lost wake is recovered ----
{
 // qualifying existing admissions and NO later causal event: the activation itself wakes the drainer, after the control is active
 const {file}=world();
 const created=[];
 const binding={async create({id}){created.push({id,control:controlRow(file)?.state});},async get(){throw new Error('no instance');}};
 const {env}=interleaved(file,{binding});
 const out=await A.activateRated(env,op({pageSize:40}));
 assert.equal(out.outcome,'activated');
 assert.deepEqual([out.wake.outcome,out.wake.mode],['kicked','created']);
 assert.deepEqual(created,[{id:'ce-00000001',control:'active'}],'exactly one instance, created only after the control was active');
 // a repeated call is a noop and wakes again through the same protocol (the run record already names a live owner)
 const again=await A.activateRated(env,op());
 assert.deepEqual([again.outcome,again.wake.outcome],['noop','kicked']);
 assert.equal(created.length,1,'the running owner is not duplicated');
}
{
 // a wake that throws leaves the activation applied; the repeated call wakes again
 const {file,env}=world();
 let fail=true;
 const kick=async()=>{if(fail)throw new Error('kick failed');return {kicked:true,mode:'event'};};
 const out=await A.activateRated(env,op({pageSize:40}),{kick});
 assert.deepEqual([out.outcome,out.wake.outcome],['activated','failed']);
 assert.equal(controlRow(file).state,'active','a failed wake never undoes the activation');
 fail=false;
 const again=await A.activateRated(env,op(),{kick});
 assert.deepEqual([again.outcome,again.wake.outcome],['noop','kicked']);
 // a refusal to wake is reported as such
 const refusedKick=await A.activateRated(env,op(),{kick:async()=>({kicked:false,reason:'contended'})});
 assert.deepEqual(refusedKick.wake,{outcome:'not_kicked',reason:'contended'});
}
{
 // a LOST kick: the pending bootstrap work is runnable, nothing else will ever write, and the existing reconcile (the cron's body) starts the drainer
 const {file}=world();
 const created=[];
 const binding={async create({id}){created.push(id);},async get(){throw new Error('no instance');}};
 const {env}=interleaved(file,{binding});
 const out=await A.activateRated(env,op({pageSize:40}),{kick:async()=>({kicked:false,reason:'lost'})});
 assert.deepEqual([out.outcome,out.wake.outcome],['activated','not_kicked']);
 assert.deepEqual(created,[],'no instance was started by the lost kick');
 const reconciled=await W.reconcile(env,{});
 assert.deepEqual([reconciled.reconciled,reconciled.kicked,reconciled.mode],[true,true,'created'],'the reconcile safety net starts it');
 assert.deepEqual(created,['ce-00000001']);
}

// ---- dormant: nothing in the Worker or any other module imports the activation, and the bundle does not carry it ----
{
 const importers=[];
 for(const name of fs.readdirSync('src'))if(name.endsWith('.js')&&name!=='catalog-enrichment-activation.js'&&fs.readFileSync('src/'+name,'utf8').includes('catalog-enrichment-activation'))importers.push(name);
 assert.deepEqual(importers,[],'the activation is reachable only from the owner\'s production operation');
 assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/catalog-enrichment-activation/);
 assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/11-59\/15/,'the reconcile cron is a separate versioned configuration change');
}
console.log('catalog enrichment activation: ok');
