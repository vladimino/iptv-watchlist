// AIR-594 / ADR 0208 (Accepted, option B). Canonical Producer outcome reports: the outcome row is written LAST and asserted in the same D1 batch as the
// transition (pass, stop, in-flight supersede, fenced held), on the real migrations in SQLite and the real Workflow and reconcile; the schema probe (absent,
// active, inconsistent, unreadable); indefinite retention; the bounded, fair, idempotent drain to the R2 Events Log; the Monitor fact; the Events screen.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {makeBucket} from './ratings-harness.mjs';
import * as Chain from '../src/canonical-producer-chain.js';
import * as Store from '../src/canonical-producer-store.js';
import * as Events from '../src/canonical-producer-events.js';
import {reconcileProducerChain,runProducerWorkflow} from '../src/canonical-producer-workflow.js';

const H=3600000,iso=ms=>new Date(ms).toISOString();
const AT='2026-11-25T08:00:00.000Z',T0=Date.parse(AT);
const P='run-p',SHA='a'.repeat(64);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-producer-outcome-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r;};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const tryWrite=(file,text)=>sqliteSync(['-bail',file],{input:text,encoding:'utf8'});
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.equal(files[files.length-1],'0038_canonical_producer_outcome.sql','0038 is the last migration of the chain');
function template(upTo){
 const file=path.join(root,'t-'+upTo+'.sqlite');
 sqlite(file,files.filter(name=>Number(name.slice(0,4))<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 return file;
}
const T38=template(38),T37=template(37);
let n=0;
function database(base=T38){
 const file=path.join(root,'c-'+(n++)+'.sqlite');
 fs.copyFileSync(base,file);
 sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
 publish(file,P,10);
 return file;
}
function publish(file,programmeRunId,generation){
 sqlite(file,"INSERT OR IGNORE INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('"+programmeRunId+"','published','"+AT+"','"+SHA+"','"+AT+"');"+
  "UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='"+programmeRunId+"',generation="+generation+" WHERE id=1;");
}
// The sealed EPG documents of one published run (one Film), and the receipt baseline the Producer needs: the real Workflow then completes a pass.
function seedPass(file,{lid=null}={}){
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 const id=lid||'tmdb_1';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\""+id+"\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\""+id+"\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'"+id+"'),('run-p','programme',0,'"+id+"')");
}
const outcomes=file=>rows(file,'SELECT * FROM canonical_producer_outcome ORDER BY id');
const chainOf=(file,p=P)=>rows(file,"SELECT * FROM canonical_producer_chain WHERE programme_run_id='"+p+"'")[0];
const setChain=(file,sets,p=P)=>sqlite(file,'UPDATE canonical_producer_chain SET '+sets+",revision=revision+1 WHERE programme_run_id='"+p+"'");
const envOf=(file,bucket=makeBucket(),created=[])=>({DB:d1Standin(file),BUCKET:bucket,PRODUCER_WORKFLOW:{create:async({id})=>{created.push(id);}}});
const step=nonce=>({do:(name,fn)=>name==='nonce'?Promise.resolve(nonce):fn()});
const items=bucket=>[...bucket.records.keys()].filter(key=>key.startsWith('events/items/')).sort();
const itemOf=(bucket,id)=>{const key=items(bucket).find(k=>k.endsWith('-'+id+'.json'));return key?bucket.value(key):null;};
const id=(outcome,k,p=P)=>Events.outcomeId(p,outcome,k);
async function claimed(env,{nonce='bbbbbbbb-0000-0000-0000-000000000000',generation=10,outcomes=true}={}){
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation,at:AT,nowMs:T0});
 const owned=await Chain.claimChain(env,{programmeRunId:P,epoch:launched.chain.owner_epoch,instanceId:launched.chain.owner_instance,nonce,generation,revision:launched.chain.revision,at:AT,nowMs:T0});
 return {kind:'chain',programmeRunId:P,epoch:owned.chain.owner_epoch,nonce,inputGeneration:generation,revision:owned.chain.revision,outcomes};
}

// ---- 1. Schema: shape, indefinite retention, immutable payload, one-way delivery, marker fence -----------------------------
{
 assert.equal(rows(T38,'SELECT version FROM schema_contract WHERE id=1')[0].version,38);
 const file=database();
 const insert=(over='')=>"INSERT INTO canonical_producer_outcome (id,programme_run_id,input_generation,outcome,owner_epoch,at,run_recorded,state,attempts,next_attempt_at,created_at"+over;
 sqlite(file,insert(") VALUES ('canonical_producer-x-e1-stopped','run-p',10,'stopped',1,'"+AT+"',0,'pending',0,'"+AT+"','"+AT+"')"));
 assert.notEqual(tryWrite(file,insert(") VALUES ('canonical_producer-x-e2-stopped','run-p',10,'stopped',2,'"+AT+"',0,'delivered',0,'"+AT+"','"+AT+"')")).status,0,'birth shape: pending only');
 assert.match(tryWrite(file,"DELETE FROM canonical_producer_outcome").stderr,/canonical_producer_outcome_delete/,'no row is ever deleted');
 assert.match(tryWrite(file,"UPDATE canonical_producer_outcome SET at='2026-11-25T09:00:00.000Z'").stderr,/canonical_producer_outcome_immutable/,'the frozen payload never changes');
 assert.match(tryWrite(file,"UPDATE canonical_producer_outcome SET input_generation=11").stderr,/canonical_producer_outcome_immutable/);
 sqlite(file,"UPDATE canonical_producer_outcome SET state='delivered',delivered_at='"+AT+"',attempts=1");
 assert.match(tryWrite(file,"UPDATE canonical_producer_outcome SET state='pending',delivered_at=NULL").stderr,/canonical_producer_outcome_delivery/,'delivered stays delivered');
 assert.match(tryWrite(file,"UPDATE canonical_producer_outcome SET attempts=0").stderr,/canonical_producer_outcome_delivery/,'attempts never fall');
 assert.notEqual(tryWrite(file,insert(",stopped_by) VALUES ('canonical_producer-x-e3-stopped','run-p',10,'stopped',3,'"+AT+"',0,'pending',0,'"+AT+"','"+AT+"','Bad Code')")).status,0,'codes only');
 assert.notEqual(tryWrite(file,insert(",n_applied) VALUES ('canonical_producer-x-e4-stopped','run-p',10,'stopped',4,'"+AT+"',0,'pending',0,'"+AT+"','"+AT+"',3)")).status,0,'no counters without a run');
 sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 assert.match(tryWrite(file,insert(") VALUES ('canonical_producer-x-e5-stopped','run-p',10,'stopped',5,'"+AT+"',0,'pending',0,'"+AT+"','"+AT+"')")).stderr,/canonical_producer_not_open/,'writes only at d1/open');
 // A version-37 database refuses nothing but another 0038, and 0038 refuses anything but a complete 37.
 const wrong=path.join(root,'wrong.sqlite');fs.copyFileSync(template(36),wrong);
 const refused=tryWrite(wrong,fs.readFileSync('migrations/0038_canonical_producer_outcome.sql','utf8'));
 assert.notEqual(refused.status,0);assert.equal(rows(wrong,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='canonical_producer_outcome'")[0].n,0,'refused before any table');
 // Indefinite retention in code too: no statement in src deletes an outcome row.
 for(const name of fs.readdirSync('src').filter(f=>f.endsWith('.js')))assert.doesNotMatch(fs.readFileSync('src/'+name,'utf8'),/DELETE\s+FROM\s+canonical_producer_outcome/i,name+' deletes no outcome row');
}

// ---- 2. Probe ----------------------------------------------------------------------------------------------------------------
{
 assert.equal(await Events.readOutcomeSchema({DB:d1Standin(database())}),'active');
 assert.equal(await Events.readOutcomeSchema({DB:d1Standin(database(T37))}),'absent','version 37 without the table is the proven absent schema');
 const odd=database(T37);sqlite(odd,'CREATE TABLE canonical_producer_outcome (id TEXT)');
 await assert.rejects(()=>Events.readOutcomeSchema({DB:d1Standin(odd)}),error=>error.code==='producer_outcome_schema_invalid','a table without its version is inconsistent, never absent');
 await assert.rejects(()=>Events.readOutcomeSchema({DB:{prepare:()=>{throw new Error('d1 down');}}}),error=>error.code==='producer_outcome_schema_unreadable','a failed read is never absent');
}

// ---- 3. The real Workflow: passed (last in the completion batch) and a stop before any run row ---------------------------------
{
 const file=database();seedPass(file);
 const env=envOf(file);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:T0});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:1},step('33333333-3333-3333-3333-333333333333'),{hold:false});
 assert.equal(result.state,'complete');
 const [row]=outcomes(file);
 const run=rows(file,"SELECT * FROM canonical_producer_run WHERE origin='epg'")[0];
 assert.equal(row.id,id('passed',10));assert.equal(row.outcome,'passed');assert.equal(row.state,'pending');assert.equal(row.attempts,0);
 assert.equal(row.at,run.completed_at,'the row reads the completion time the run update just wrote');
 assert.equal(row.open_at_completion,run.open_at_completion,'and the open count, written in the same batch before it');
 assert.deepEqual([row.run_recorded,row.unit_count,row.n_applied+row.n_noop+row.n_kept+row.n_failed],[1,run.unit_count,run.n_applied+run.n_noop+run.n_kept+run.n_failed]);
 assert.equal(row.owner_epoch,1);
 // The hourly reconcile delivers it once; later ticks write nothing.
 const bucket=env.BUCKET;
 await reconcileProducerChain(env,{now:T0+H,hold:false});
 const event=itemOf(bucket,row.id);
 assert.ok(event,'delivered to events/items/');assert.equal(event.outcome,'passed');assert.equal(event.remaining,0);assert.equal(event.at,row.at);
 assert.equal(outcomes(file)[0].state,'delivered');
 const before=bucket.writes().length;
 for(const hour of [2,3])await reconcileProducerChain(env,{now:T0+hour*H,hold:false});
 assert.equal(bucket.writes().length,before,'a lasting complete state writes nothing more');
 assert.equal(outcomes(file).length,1,'kept, not deleted');
}
{
 // An unresolved Letterboxd lid stops the chain while the plan is formed: no run row yet, so the counters are NULL, never 0; fail_closed needs the owner.
 const file=database();seedPass(file,{lid:'lidx'});
 const env=envOf(file);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:T0});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:1},step('44444444-4444-4444-4444-444444444444'),{hold:false});
 assert.equal(result.state,'stopped');assert.equal(result.code,'producer_identity_unresolved');
 const [row]=outcomes(file);
 assert.equal(row.id,id('stopped',1));assert.equal(row.run_recorded,0);
 assert.deepEqual([row.unit_count,row.n_applied,row.n_failed,row.pass_no],[null,null,null,null]);
 assert.equal(row.stopped_by,'producer_identity_unresolved');assert.equal(row.recovery_class,'fail_closed');assert.equal(row.recovery,'owner');
 const event=Events.outcomeEvent(row);assert.equal(event.runRecorded,false);assert.equal(event.processed,null);assert.equal(event.remaining,null);
}

// ---- 4. A stop with a run row; eligibility at the stop; a later held at the current revision (once); owner stops get no held ---
{
 const file=database(),env=envOf(file);
 const fence=await claimed(env);
 env.producerFence=fence;
 const opened=await Store.openEpgRun(env,{runKey:'epg:run-p:10',sourceGeneration:'run-p:10',fingerprint:SHA,units:[{kind:'film_facts',id:'film:tmdb:1'},{kind:'film_facts',id:'film:tmdb:2'}],at:AT});
 await Store.commitSlice(env,{run:opened.run,next:{cursor_kind:'film_facts',cursor_id:'film:tmdb:1'},counts:{applied:1},at:AT});
 // The streak started 23 h 55 min before the stop: eligible AT THE STOP, though the 24 h window closes minutes later.
 setChain(file,"streak_started_at='"+iso(T0-(24*60-5)*60000)+"'");
 fence.revision=chainOf(file).revision;
 await Chain.stopChain(env,{fence,revision:fence.revision,at:AT,stoppedBy:'producer_cas_lost'});
 let [row]=outcomes(file);
 assert.equal(row.id,id('stopped',1));assert.equal(row.recovery,'eligible','eligible at the stop, never promised');
 assert.deepEqual([row.run_recorded,row.unit_count,row.n_applied,row.pass_no],[1,2,1,1]);
 const stopEvent=Events.outcomeEvent(row);assert.equal(stopEvent.remaining,1);
 // The reconcile one hour later: the window is over, recoverChain holds it. One held row, fenced at the current revision, written once.
 const out=await reconcileProducerChain(env,{now:T0+H,hold:false});
 assert.equal(out.held,1);assert.equal(chainOf(file).owner_state,'stopped','held, not resumed');
 assert.equal(outcomes(file).find(r=>r.outcome==='held').id,id('held',1));
 for(const hour of [2,3])await reconcileProducerChain(env,{now:T0+hour*H,hold:false});
 assert.equal(outcomes(file).filter(r=>r.outcome==='held').length,1,'stable identity: one held row however many ticks');
 const heldEvent=itemOf(env.BUCKET,id('held',1));assert.ok(heldEvent);assert.equal(heldEvent.recovery,'owner');
 // A held insert guarded by a revision that moved writes nothing (the fence), and its absence is not an error of the batch.
 const file2=database(),env2=envOf(file2);
 const f2=await claimed(env2);
 await Chain.stopChain(env2,{fence:f2,revision:f2.revision,at:AT,stoppedBy:'producer_transport'});
 const stale={...chainOf(file2)};setChain(file2,"updated_at='"+AT+"'");
 await assert.rejects(()=>Chain.recordHeldOutcome(env2,{chain:stale,at:iso(T0+H)}),'a stale revision fails the guarded batch');
 assert.equal(outcomes(file2).filter(r=>r.outcome==='held').length,0);
 // A stop that needed the owner from the start (attempts used up) gets no held report.
 const file3=database(),env3=envOf(file3);
 const f3=await claimed(env3);
 setChain(file3,'recovery_attempts=5');f3.revision=chainOf(file3).revision;
 await Chain.stopChain(env3,{fence:f3,revision:f3.revision,at:AT,stoppedBy:'producer_transport'});
 assert.equal(outcomes(file3)[0].recovery,'owner');
 await reconcileProducerChain(env3,{now:T0+H,hold:false});
 assert.equal(outcomes(file3).filter(r=>r.outcome==='held').length,0,'an owner stop is already the last word');
}

// ---- 5. Supersede: in flight (one row, pre-state kept), complete or stopped (none); atomicity both ways -----------------------
{
 const file=database(),env=envOf(file);
 const fence=await claimed(env);
 env.producerFence=fence;
 const opened=await Store.openEpgRun(env,{runKey:'epg:run-p:10',sourceGeneration:'run-p:10',fingerprint:SHA,units:[{kind:'film_facts',id:'film:tmdb:1'},{kind:'film_facts',id:'film:tmdb:2'},{kind:'film_facts',id:'film:tmdb:3'}],at:AT});
 await Store.commitSlice(env,{run:opened.run,next:{cursor_kind:'film_facts',cursor_id:'film:tmdb:1'},counts:{noop:1},at:AT});
 publish(file,'run-q',11);
 const out=await reconcileProducerChain(env,{now:T0+H,hold:false});
 assert.equal(out.supersede,1);assert.equal(chainOf(file).owner_state,'superseded');
 const [row]=outcomes(file).filter(r=>r.outcome==='superseded');
 assert.equal(row.id,id('superseded',1));assert.equal(row.prior_state,'active');assert.equal(row.at,iso(T0+H));assert.equal(row.recovery,'none');
 const event=itemOf(env.BUCKET,row.id);assert.equal(event.priorState,'active');assert.deepEqual([event.processed,event.remaining],[1,2]);
}
{
 // A complete chain of an older run is superseded without a row (its outcome row already exists, or it ended before activation).
 {
  const file=database(),env=envOf(file);
  await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:T0});
  setChain(file,"owner_state='complete'");
  publish(file,'run-q',11);
  await reconcileProducerChain(env,{now:T0+H,hold:false});
  assert.equal(chainOf(file).owner_state,'superseded');
  assert.equal(outcomes(file).length,0,'complete: no superseded row');
 }
 // A stopped chain of an older run: no superseded and no held row. (Pre-existing, unchanged here: the chain table's CHECK `stopped_by IS NULL OR owner_state =
 // 'stopped'` refuses the hourly supersede of a stopped chain, so it stays stopped; the outcome path adds nothing either way.)
 {
  const file=database(),env=envOf(file);
  await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:T0});
  setChain(file,"owner_state='stopped',stopped_by='producer_transport',recovery_class='transient'");
  publish(file,'run-q',11);
  const out=await reconcileProducerChain(env,{now:T0+H,hold:false});
  assert.equal(out.skipped,1);
  assert.equal(outcomes(file).length,0,'stopped: no superseded and no held row');
 }
}
{
 // Unknown commit: the batch commits and the reply is lost. The chain and its row committed together; the next tick delivers it.
 const file=database(),env=envOf(file);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:T0});
 publish(file,'run-q',11);
 const real=env.DB.batch.bind(env.DB);let lose=true;
 env.DB.batch=async statements=>{const out=await real(statements);if(lose&&statements.length>=4){lose=false;throw new Error('network: reply lost');}return out;};
 const first=await reconcileProducerChain(env,{now:T0+H,hold:false});
 assert.equal(first.skipped,1,'the reconcile saw a failure');
 assert.equal(chainOf(file).owner_state,'superseded');
 assert.equal(outcomes(file).filter(r=>r.outcome==='superseded').length,1,'the outcome committed with the supersede: no window');
 env.DB.batch=real;
 await reconcileProducerChain(env,{now:T0+2*H,hold:false});
 assert.ok(itemOf(env.BUCKET,id('superseded',1)),'delivered by a later tick');
}
{
 // A conflicting row already under that id: the insert fails and rolls the supersede back; the chain stays as it was.
 const file=database(),env=envOf(file);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:T0});
 sqlite(file,"INSERT INTO canonical_producer_outcome (id,programme_run_id,input_generation,outcome,owner_epoch,at,run_recorded,prior_state,state,attempts,next_attempt_at,created_at) VALUES ('"+id('superseded',1)+"','run-p',10,'superseded',1,'"+AT+"',0,'pending','pending',0,'"+AT+"','"+AT+"')");
 publish(file,'run-q',11);
 await reconcileProducerChain(env,{now:T0+H,hold:false});
 assert.equal(chainOf(file).owner_state,'pending','an invariant failure is never committed silently');
}
{
 // A failed stop batch (the outcome insert refused) rolls the stop back: the chain stays active and follows the existing fenced recovery (lease, takeover).
 const file=database(),env=envOf(file);
 const fence=await claimed(env);
 sqlite(file,"INSERT INTO canonical_producer_outcome (id,programme_run_id,input_generation,outcome,owner_epoch,at,run_recorded,state,attempts,next_attempt_at,created_at) VALUES ('"+id('stopped',1)+"','run-p',10,'stopped',1,'"+AT+"',0,'pending',0,'"+AT+"','"+AT+"')");
 await assert.rejects(()=>Chain.stopChain(env,{fence,revision:fence.revision,at:AT,stoppedBy:'producer_transport'}));
 assert.equal(chainOf(file).owner_state,'active');
}

// ---- 6. Activation boundaries: absent schema (today), inconsistent and unreadable probes -------------------------------------
{
 const file=database(T37);seedPass(file);
 const env=envOf(file);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:T0});
 assert.equal((await runProducerWorkflow(env,{programmeRunId:P,epoch:1},step('55555555-5555-5555-5555-555555555555'),{hold:false})).state,'complete','before the apply: the same pass, no outcome');
 publish(file,'run-q',11);
 const out=await reconcileProducerChain(env,{now:T0+H,hold:false});
 assert.equal(out.outcomes,'absent');assert.equal(out.supersede,1);assert.equal(items(env.BUCKET).length,0,'nothing reported before activation');
}
{
 const file=database(T37);sqlite(file,'CREATE TABLE canonical_producer_outcome (id TEXT)');seedPass(file);
 const env=envOf(file);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:T0});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:1},step('66666666-6666-6666-6666-666666666666'),{hold:false});
 assert.deepEqual([result.state,result.code],['stopped','producer_outcome_schema_invalid'],'an inconsistent schema stops the chain on the record');
 assert.equal(chainOf(file).recovery_class,'fail_closed');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM canonical_producer_run")[0].n,0,'no work ran');
}
{
 const file=database();seedPass(file);
 const env=envOf(file);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:T0});
 const prepare=env.DB.prepare.bind(env.DB);
 env.DB.prepare=sql=>{if(/sqlite_master/.test(sql)&&/canonical_producer_outcome/.test(sql))throw new Error('d1 down');return prepare(sql);};
 const before=chainOf(file);
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:1},step('77777777-7777-7777-7777-777777777777'),{hold:false});
 assert.deepEqual([result.state,result.code],['error','producer_outcome_schema_unreadable']);
 const after=chainOf(file);
 assert.equal(after.owner_state,'active','claimed, then nothing: the lease lapses and the reconcile takes it over');
 assert.equal(after.revision,before.revision+1,'only the claim was written');
 // The reconcile with an unreadable probe never supersedes an in-flight chain (its outcome could not be written), and drains nothing.
 publish(file,'run-q',11);
 const out=await reconcileProducerChain(env,{now:T0+H,hold:false});
 assert.equal(out.outcomes,'producer_outcome_schema_unreadable');assert.equal(out.supersede,0);assert.equal(chainOf(file).owner_state,'active');
 env.DB.prepare=prepare;
 await reconcileProducerChain(env,{now:T0+2*H,hold:false});
 assert.equal(chainOf(file).owner_state,'superseded','the next readable tick supersedes it with its outcome');
 assert.equal(outcomes(file).filter(r=>r.outcome==='superseded').length,1);
}

// ---- 7. Delivery: journal outage, fairness, lost response, bounded drain -----------------------------------------------------
{
 const file=database(),env=envOf(file),bucket=env.BUCKET;
 const add=(epoch,at)=>sqlite(file,"INSERT INTO canonical_producer_outcome (id,programme_run_id,input_generation,outcome,owner_epoch,at,run_recorded,stopped_by,recovery_class,recovery,state,attempts,next_attempt_at,created_at) VALUES ('"+id('stopped',epoch)+"','run-p',10,'stopped',"+epoch+",'"+at+"',0,'producer_transport','transient','eligible','pending',0,'"+at+"','"+at+"')");
 for(let e=1;e<=10;e++)add(e,iso(T0+e*60000));
 // The journal refuses epoch 1 only: it moves one hour back, the others are delivered in order, at most 8 per tick.
 bucket.hooks.beforePut=async key=>{if(key.includes(id('stopped',1)))throw new Error('journal down');};
 let stats=await Events.drainOutcomes(env,{nowMs:T0+H});
 assert.deepEqual([stats.taken,stats.delivered,stats.failed],[8,7,1]);
 let row1=outcomes(file).find(r=>r.id===id('stopped',1));
 assert.equal(row1.state,'pending');assert.equal(row1.attempts,1);assert.equal(row1.next_attempt_at,iso(T0+2*H));
 stats=await Events.drainOutcomes(env,{nowMs:T0+H+60000});
 assert.deepEqual([stats.taken,stats.delivered],[2,2],'the failing row is not due again yet, so it cannot starve the rest');
 bucket.hooks.beforePut=null;
 stats=await Events.drainOutcomes(env,{nowMs:T0+2*H});
 assert.equal(stats.delivered,1);
 assert.equal(outcomes(file).every(r=>r.state==='delivered'),true);assert.equal(items(bucket).length,10);
 // A lost response: the journal wrote the object, the caller saw an error. The next try finds the key (create-only) and counts it delivered; one item.
 add(11,iso(T0+3*H));
 const realPut=bucket.put.bind(bucket);let once=true;
 bucket.put=async(k,v,o)=>{const r=await realPut(k,v,o);if(once&&k.startsWith('events/items/')){once=false;throw new Error('reply lost');}return r;};
 stats=await Events.drainOutcomes(env,{nowMs:T0+3*H});
 bucket.put=realPut;
 assert.equal(stats.delivered,1);assert.equal(items(bucket).filter(k=>k.includes(id('stopped',11))).length,1);
 // A replayed drain (the delivered row already moved) writes no second item.
 const before=items(bucket).length;
 await Events.drainOutcomes(env,{nowMs:T0+4*H});
 assert.equal(items(bucket).length,before);
 assert.equal(outcomes(file).length,11,'every row kept');
}

// ---- 8. The Monitor fact: visibility only ------------------------------------------------------------------------------------
{
 const file=database();
 assert.deepEqual(await Events.readOutcomeDelivery({DB:d1Standin(file)}),{active:true,readable:true,pending:0,oldestPendingAt:null});
 sqlite(file,"INSERT INTO canonical_producer_outcome (id,programme_run_id,input_generation,outcome,owner_epoch,at,run_recorded,state,attempts,next_attempt_at,created_at) VALUES ('"+id('stopped',1)+"','run-p',10,'stopped',1,'"+AT+"',0,'pending',0,'"+AT+"','"+AT+"')");
 assert.deepEqual(await Events.readOutcomeDelivery({DB:d1Standin(file)}),{active:true,readable:true,pending:1,oldestPendingAt:AT});
 assert.deepEqual(await Events.readOutcomeDelivery({DB:d1Standin(database(T37))}),{active:false,readable:true,pending:null,oldestPendingAt:null});
 assert.equal((await Events.readOutcomeDelivery({DB:{prepare:()=>{throw new Error('down');}}})).readable,false);
 const {evaluateCanonicalProducer}=await import('../src/domain/monitor-policy.js');
 const base={held:false,readable:true,label:'run-p:10',run:{passState:'passed',sourceGeneration:'run-p:10',appliedGeneration:'run-p:10'},chain:{ownerState:'complete'}};
 const plain=evaluateCanonicalProducer(base,T0),seen=evaluateCanonicalProducer({...base,outcomeDelivery:{active:true,readable:true,pending:4,oldestPendingAt:AT}},T0);
 assert.equal(seen.state,plain.state);assert.deepEqual(seen.issues,plain.issues,'pending deliveries never change the verdict');
 assert.deepEqual(seen.facts.outcomeDelivery,{active:true,readable:true,pending:4,oldestPendingAt:AT},'shown as a fact');
}

// ---- 9. The Events screen ------------------------------------------------------------------------------------------------------
{
 const app=fs.readFileSync('public/app.js','utf8'),html=fs.readFileSync('public/index.html','utf8');
 const ctx=vm.createContext({URL,URLSearchParams,Set,Map,Date,Intl,document:{querySelector:()=>null,querySelectorAll:()=>[]},window:{location:{href:'https://iptv.example/'}}});
 vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+'\n'+app.replace(/init\(\);\s*$/,''),ctx);
 const status=event=>vm.runInContext('eventPresentationStatus('+JSON.stringify(event)+')',ctx);
 const card=event=>{ctx.ev=event;return vm.runInContext('eventHTML(ev)',ctx);};
 const rowOf=over=>({id:'canonical_producer-x-g10-passed',programme_run_id:'4562e2d8-14f7-4497-a4d7-270e0a975fe9',input_generation:10,outcome:'passed',owner_epoch:3,at:'2026-11-25T08:55:00.000Z',run_recorded:1,pass_no:1,unit_count:10,
  n_applied:5,n_noop:3,n_kept:2,n_failed:0,open_at_completion:0,run_created_at:'2026-11-25T07:10:00.000Z',stopped_by:null,recovery_class:null,recovery:null,prior_state:null,
  handoff_count:2,takeover_count:1,relaunch_count:0,reopen_count:0,rebase_count:0,recovery_attempts:0,...over});
 const base=Events.outcomeEvent(rowOf({}));
 assert.equal(status(base),'success');
 assert.equal(status({...base,failed:1}),'warning');assert.equal(status({...base,openResults:2}),'warning');assert.equal(status({...base,failed:null}),'warning');
 const stop=Events.outcomeEvent(rowOf({outcome:'stopped',run_recorded:0,pass_no:null,unit_count:null,n_applied:null,n_noop:null,n_kept:null,n_failed:null,open_at_completion:null,run_created_at:null,stopped_by:'producer_cas_lost',recovery_class:'transient',recovery:'eligible'}));
 assert.equal(status(stop),'interrupted');assert.equal(status({...stop,recovery:'owner'}),'error');assert.equal(status({...stop,recovery:null}),'warning');
 assert.equal(status({...stop,outcome:'held',recovery:'owner'}),'error');assert.equal(status({...base,outcome:'superseded'}),'interrupted');assert.equal(status({...base,outcome:'mystery'}),null);
 let h=card(base);
 assert.match(h,/Обогащение каталога завершено</);assert.match(h,/<dt>Обработано<\/dt><dd>10<\/dd>/);assert.match(h,/Поколение программы: 10 · проход 1/);assert.match(h,/Длительность: 1 ч 45 мин/);assert.doesNotMatch(h,/фильм/i);
 h=card(stop);
 assert.match(h,/допускает автоматический повтор/);assert.doesNotMatch(h,/продолжится автоматически/,'eligibility, never a promise');assert.match(h,/Если повтор не состоится, появится отдельное событие/);
 assert.match(h,/<dt>Обработано<\/dt><dd>неизвестно<\/dd>/);assert.match(h,/<code>producer_cas_lost<\/code>/);
 h=card({...stop,outcome:'held',recovery:'owner'});assert.match(h,/Автоматический повтор обогащения каталога не состоялся/);assert.match(h,/event-status-error/);
 h=card({...stop,reason:'<img src=x onerror=1>',recoveryClass:'<script>',chain:{epoch:'<b>'},unitCount:'7'});
 assert.doesNotMatch(h,/<img|<script|<b>|onerror/);assert.match(h,/<dt>Единиц в плане<\/dt><dd>неизвестно<\/dd>/);
 assert.ok(vm.runInContext("eventMatchesFilters({type:'canonical_producer',outcome:'held',recovery:'owner'},'canonical_producer','error')",ctx));
 assert.equal(vm.runInContext("withEventType('/events?result=error','canonical_producer')",ctx),'/events?result=error&type=canonical_producer');
 assert.match(html,/data-event-type="canonical_producer" aria-pressed="false">Обогащение каталога</);
}
console.log('canonical-producer-events: the outcome row commits last and asserted in the batch of its pass, stop, in-flight supersede or fenced held (null counters before a run), an absent schema writes none and an unreadable or inconsistent one fails closed, rows are kept forever and immutable, and the drain delivers each once, fairly and boundedly; the Monitor fact and the Events card follow');
