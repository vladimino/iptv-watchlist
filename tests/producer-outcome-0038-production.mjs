// AIR-594 / ADR 0208: the owner-only operator of migration 0038 (scripts/producer-outcome-0038-production.mjs). Offline only: sqlite stand-ins over the real
// migration chain. No production database is opened, no credential is used, nothing is applied anywhere.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {migrated,sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {D1Error} from '../scripts/d1-backfill.mjs';
import * as Op from '../scripts/producer-outcome-0038-production.mjs';
import {OUTCOME_TRIGGERS} from '../src/canonical-producer-events.js';

const sha=Op.migrationSha256();
assert.equal(sha,createHash('sha256').update(fs.readFileSync('migrations/0038_canonical_producer_outcome.sql')).digest('hex'),'the pin is the SHA-256 of the exact bytes');
assert.equal(Op.approved(),true,'the merged file is the approved one');
assert.equal(Op.migrationSql().length,11,'guard, table, index, six triggers, downgrade trigger, version update');
assert.deepEqual(Object.keys(Op.expectedObjects()).sort(),[Op.TABLE,Op.INDEX,...OUTCOME_TRIGGERS].sort());
const stop=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason,String(error.reason));return error;}assert.fail('expected '+reason);};
const tracker=()=>{const states=[];return {states,track:state=>states.push(state)};};
const A=(...args)=>['node','op',...args];
const MID=Date.parse('2026-11-24T13:30:00.000Z'),AT='2026-11-24T13:00:00.000Z';
const at=ms=>()=>ms;
// A clock that answers each call in turn (the last value repeats): the start, the decision, the write boundary.
const steps=(...values)=>{let i=0;return ()=>values[Math.min(i++,values.length-1)];};
const T=text=>Date.parse('2026-11-24T'+text+'Z');

// ---- arguments ----
assert.deepEqual(Op.parseArgs(A()),{report:{configured:false,writes:false,writeState:'none'}},'default is a read-only no-op report');
assert.equal(Op.parseArgs(A('--target','iptv')).command,'status');
for(const bad of [A('--apply'),A('--status','--apply','--target','iptv'),A('--target','other'),A('--target','iptv','--apply'),A('--target','iptv','--apply','--confirm','status','--migration-sha256',sha),
 A('--target','iptv','--apply','--confirm','apply','--migration-sha256','short'),A('--target','iptv','--status','--confirm','apply'),A('--target','iptv','--bogus','x')])
 assert.throws(()=>Op.parseArgs(bad),error=>error.name==='OperatorStop',JSON.stringify(bad));
assert.deepEqual(Op.parseArgs(A('--target','iptv','--apply','--confirm','apply','--migration-sha256',sha)),{command:'apply',params:{migrationSha256:sha}});
// Changed bytes are never approved, whatever the caller pins.
assert.equal(Op.approved(Buffer.from(fs.readFileSync('migrations/0038_canonical_producer_outcome.sql','utf8')+'\n')),false);
assert.throws(()=>Op.migrationSql(Buffer.from('SELECT 1;')),error=>error.reason==='migration_not_approved');

// ---- a production-shaped v37 world: Film/Person d1/open, published d1/open ----
function world({upTo=37}={}){
 const file=migrated(upTo);
 sql(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+'a'.repeat(64)+"','"+AT+"');UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='run-p',generation=518 WHERE id=1");
 return {file,db:d1Standin(file)};
}
const version=file=>Number(sql(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const objects=file=>sql(file,"SELECT name FROM sqlite_master WHERE name LIKE 'canonical_producer_outcome%' ORDER BY name").map(row=>row.name);
const chain=(file,state,lease)=>sql(file,"INSERT INTO canonical_producer_chain (programme_run_id,input_generation,owner_epoch,owner_instance,owner_state,lease_expires_at,revision,created_at,updated_at) VALUES ('run-p',518,1,'pw_1_1','pending','"+lease+"',1,'"+AT+"','"+AT+"')"+(state==='pending'?'':";UPDATE canonical_producer_chain SET owner_state='"+state+"',claim_nonce='aaaaaaaa-0000-0000-0000-000000000000',revision=revision+1"));

// status: read-only, decision apply, the runtime probe says absent.
{
 const {file,db}=world();
 const before=sql(file,"SELECT group_concat(name) n FROM sqlite_master")[0].n;
 const out=await Op.execute('status',{binding:db,clock:at(MID)});
 assert.equal(out.decision,'apply');assert.equal(out.writes,false);assert.equal(out.migrationSha256,sha);assert.equal(out.statements,11);
 assert.equal(out.schemaVersion,37);assert.equal(out.runtimeProbe,'absent');assert.deepEqual(out.outboxObjects,[]);assert.equal(out.neededTables,'6/6');
 assert.deepEqual(out.filmPersonAuthority,{mode:'d1',cutover:'open',generation:2});assert.equal(out.publishedAuthority.generation,518);
 assert.deepEqual(out.membershipAuthority,{mode:'producer',generation:0});assert.deepEqual(out.producer,{openChains:0,liveLeases:0,openStates:[]});
 assert.equal(sql(file,"SELECT group_concat(name) n FROM sqlite_master")[0].n,before,'status writes nothing');
}
// Decisions that refuse the apply.
{
 let w=world();chain(w.file,'active','2026-11-24T13:34:00.000Z');
 assert.equal((await Op.execute('status',{binding:w.db,clock:at(MID)})).decision,'producer_busy','a live owner lease: an instance may be mid-invocation');
 // The Producer's own boundary margin: an active lease that ended 10 s ago is still live (the reconcile would not take it over yet); one 20 s past it is not.
 w=world();chain(w.file,'active','2026-11-24T13:29:50.000Z');
 assert.equal((await Op.execute('status',{binding:w.db,clock:at(MID)})).decision,'producer_busy','inside the 15 s boundary margin');
 w=world();chain(w.file,'active','2026-11-24T13:29:40.000Z');
 const lapsed=await Op.execute('status',{binding:w.db,clock:at(MID)});
 assert.equal(lapsed.decision,'apply','an active lease past lease + margin is no running instance');assert.equal(lapsed.producer.liveLeases,0);assert.equal(lapsed.producer.openChains,1);
 // A pending chain is busy whatever its lease: its instance may claim it at any moment, and a lapsed one is taken over into a new pending one.
 w=world();chain(w.file,'pending','2026-11-24T12:00:00.000Z');
 assert.equal((await Op.execute('status',{binding:w.db,clock:at(MID)})).decision,'producer_busy','an expired pending claim is not proof that nothing can start');
 // The tick guard is inclusive on both sides, to the millisecond.
 w=world();
 for(const t of ['13:55:00.000','13:57:00.000','14:00:00.000','14:04:30.000','14:05:00.000'])assert.equal((await Op.execute('status',{binding:w.db,clock:at(T(t))})).decision,'hourly_tick_window',t);
 for(const t of ['13:54:59.999','14:05:00.001'])assert.equal((await Op.execute('status',{binding:w.db,clock:at(T(t))})).decision,'apply',t);
 w=world();sql(w.file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 assert.equal((await Op.execute('status',{binding:w.db,clock:at(MID)})).decision,'film_person_not_open');
 w=world();sql(w.file,'CREATE TABLE canonical_producer_outcome_scratch (x INTEGER)');
 const partial=await Op.execute('status',{binding:w.db,clock:at(MID)});
 assert.equal(partial.decision,'partial_schema','any outbox object at v37');assert.deepEqual(partial.outboxObjects,['table:canonical_producer_outcome_scratch']);
 w=world({upTo:36});
 assert.equal((await Op.execute('status',{binding:w.db,clock:at(MID)})).decision,'schema_unexpected');
 w=world();sql(w.file,'DELETE FROM schema_contract');
 assert.equal((await Op.execute('status',{binding:w.db,clock:at(MID)})).decision,'schema_contract_unexpected','no contract row is never an old version');
 for(const reason of ['producer_busy','hourly_tick_window']){
  const v=world();if(reason==='producer_busy')chain(v.file,'active','2026-11-24T13:34:00.000Z');
  const ctx=tracker();
  await stop(Op.execute('apply',{binding:v.db,ctx,params:{migrationSha256:sha},clock:at(reason==='producer_busy'?MID:T('14:01:00.000'))}),reason);
  assert.equal(version(v.file),37);assert.deepEqual(objects(v.file),[]);assert.deepEqual(ctx.states,[],'nothing was sent');
 }
 const v=world();
 await stop(Op.execute('apply',{binding:v.db,params:{migrationSha256:'0'.repeat(64)},clock:at(MID)}),'migration_sha256_mismatch');
 assert.equal(version(v.file),37);
}
// The quiet window is re-read at the write boundary: a preflight that crossed into the guard, or took longer than PREFLIGHT_MAX_MS, sends nothing.
{
 for(const [clock,reason] of [[steps(T('13:54:58.000'),T('13:54:59.000'),T('13:55:00.000')),'hourly_tick_window'],[steps(T('13:30:00.000'),T('13:30:01.000'),T('13:31:01.000')),'preflight_stale']]){
  const v=world();
  let batches=0;const counted={...v.db,prepare:text=>v.db.prepare(text),batch:statements=>{batches++;return v.db.batch(statements);}};
  const ctx=tracker();
  await stop(Op.execute('apply',{binding:counted,ctx,params:{migrationSha256:sha},clock}),reason);
  assert.equal(batches,0,reason+': nothing sent');assert.deepEqual(ctx.states,[]);assert.equal(version(v.file),37);
 }
 // Exactly at the limit is still fresh.
 const v=world();
 const ok=await Op.execute('apply',{binding:v.db,params:{migrationSha256:sha},clock:steps(T('13:30:00.000'),T('13:30:30.000'),T('13:31:00.000'))});
 assert.equal(ok.writeState,'committed');
}
// The apply: one atomic batch, never retried, then the readback; a second status reads already_applied.
{
 const {file,db}=world();
 const before=sql(file,"SELECT (SELECT COUNT(*) FROM canonical_producer_chain) c,(SELECT mode||'/'||cutover||'/'||generation FROM film_person_authority) f,(SELECT mode||'/'||generation FROM watchlist_membership_authority) m")[0];
 let batches=0;const counted={...db,prepare:text=>db.prepare(text),batch:statements=>{batches++;return db.batch(statements);}};
 const ctx=tracker();
 const out=await Op.execute('apply',{binding:counted,ctx,params:{migrationSha256:sha},clock:at(MID)});
 assert.equal(out.writeState,'committed');assert.equal(out.statements,11);assert.equal(batches,1,'one batch, never retried');assert.deepEqual(ctx.states,['unknown','committed']);
 assert.equal(out.after.schemaVersion,38);assert.equal(out.after.runtimeProbe,'active','the Worker probe reads the result as active');assert.equal(out.outboxRows,0);
 assert.deepEqual(out.after.outboxObjects,[...OUTCOME_TRIGGERS.map(name=>'trigger:'+name),'index:'+Op.INDEX,'table:'+Op.TABLE].sort());
 assert.equal(version(file),38);
 assert.deepEqual(sql(file,"SELECT (SELECT COUNT(*) FROM canonical_producer_chain) c,(SELECT mode||'/'||cutover||'/'||generation FROM film_person_authority) f,(SELECT mode||'/'||generation FROM watchlist_membership_authority) m")[0],before,'markers and counts unchanged');
 const again=await Op.execute('status',{binding:db,clock:at(MID)});
 assert.equal(again.decision,'already_applied');
 await stop(Op.execute('apply',{binding:db,params:{migrationSha256:sha},clock:at(MID)}),'already_applied');
 // A populated outbox is a valid applied schema: natural Producer rows never turn the status into anything else.
 sql(file,"INSERT INTO canonical_producer_outcome (id,programme_run_id,input_generation,outcome,owner_epoch,at,run_recorded,state,attempts,next_attempt_at,created_at) VALUES ('canonical_producer-x-e1-stopped','run-p',518,'stopped',1,'"+AT+"',0,'pending',0,'"+AT+"','"+AT+"')");
 assert.equal((await Op.execute('status',{binding:db,clock:at(MID)})).decision,'already_applied','rows are legitimate after the apply');
 // A version-38 database whose outbox lost a trigger is partial, never applied.
 sql(file,'DROP TRIGGER canonical_producer_outcome_no_delete');
 assert.equal((await Op.execute('status',{binding:db,clock:at(MID)})).decision,'partial_schema');
}
{
 // Same-name objects with another body pass the runtime probe (it checks names and columns) but never the exact CREATE comparison of the status.
 for(const damage of [
  "DROP TRIGGER canonical_producer_outcome_no_delete;CREATE TRIGGER canonical_producer_outcome_no_delete BEFORE DELETE ON canonical_producer_outcome BEGIN SELECT 1; END",
  "DROP INDEX canonical_producer_outcome_pending;CREATE INDEX canonical_producer_outcome_pending ON canonical_producer_outcome (at) WHERE state = 'pending'",
 ]){
  const {file,db}=world();
  await Op.execute('apply',{binding:db,params:{migrationSha256:sha},clock:at(MID)});
  sql(file,damage);
  const out=await Op.execute('status',{binding:db,clock:at(MID)});
  assert.equal(out.runtimeProbe,'active','the probe alone would pass');
  assert.equal(out.decision,'partial_schema',damage);assert.equal(out.outboxMismatches.length,1);
 }
}
// A refused statement with the state proven unchanged is statement_failed; anything unclear is write_uncertain. Neither is retried.
{
 const {file,db}=world();
 const refused={...db,prepare:text=>db.prepare(text),batch:async()=>{throw new D1Error('statement','refused');}};
 const ctx=tracker();
 await stop(Op.execute('apply',{binding:refused,ctx,params:{migrationSha256:sha},clock:at(MID)}),'statement_failed');
 assert.deepEqual(ctx.states,['unknown','none']);assert.equal(version(file),37);
}
{
 // A refused statement, but a marker moved meanwhile: the read-back state is not the recorded before-state, so it is not proof of nothing written.
 const {file,db}=world();
 const refused={...db,prepare:text=>db.prepare(text),batch:async()=>{sql(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");throw new D1Error('statement','refused');}};
 await stop(Op.execute('apply',{binding:refused,params:{migrationSha256:sha},clock:at(MID)}),'write_uncertain');
}
{
 const {file,db}=world();
 const lost={...db,prepare:text=>db.prepare(text),batch:async statements=>{await db.batch(statements);throw new D1Error('write_uncertain','lost');}};
 const ctx=tracker();
 const error=await stop(Op.execute('apply',{binding:lost,ctx,params:{migrationSha256:sha},clock:at(MID)}),'write_uncertain');
 assert.deepEqual(ctx.states,['unknown','unknown']);assert.equal(version(file),38,'the batch did commit: the uncertainty is about the reply');
 assert.equal(error.details.state.schemaVersion,38);
}
{
 // The batch commits, but the readback finds a marker moved under it (another writer): write_uncertain with the named problem, never a clean success.
 const {file,db}=world();
 const racing={...db,prepare:text=>db.prepare(text),batch:async statements=>{const out=await db.batch(statements);sql(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");return out;}};
 const error=await stop(Op.execute('apply',{binding:racing,params:{migrationSha256:sha},clock:at(MID)}),'write_uncertain');
 assert.ok(error.details.problems.includes('changed:filmPerson'));
}
// The CLI wrapper: a report without a target, and the outcome shape of a stop.
{
 assert.deepEqual(await Op.runProducerOutcome0038Production({argv:A()}),{exit:0,result:{configured:false,writes:false,writeState:'none'}});
 const w=world();chain(w.file,'active','2026-11-24T13:34:00.000Z');
 const out=await Op.runProducerOutcome0038Production({argv:A('--target','iptv','--apply','--confirm','apply','--migration-sha256',sha),deps:{binding:w.db},clock:at(MID)});
 assert.equal(out.result.reason,'producer_busy');assert.equal(out.result.writes,false);assert.equal(out.result.writeState,'none');
}
console.log('producer-outcome-0038-production: pinned bytes and shape, read-only status with the runtime probe, refusals (live lease, hourly tick window, partial or unexpected schema, marker not open, digest mismatch), one atomic never-retried apply with readback, statement_failed only when proven, write_uncertain otherwise');
