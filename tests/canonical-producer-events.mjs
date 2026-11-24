// AIR-594: Canonical Producer outcome reports in the Events Log (`type: canonical_producer`). The pure decisions, the R2 ledger (create-only journal put,
// bounded outbox, baseline, concurrent ticks) and the hourly reconcile over the real migrations in SQLite: one event per logical pass P:g or per recorded
// stop (P, epoch), reported BEFORE the reconcile moves the chain, never for a handoff, a takeover or a pending chain, and never retroactively.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {makeBucket} from './ratings-harness.mjs';
import * as Chain from '../src/canonical-producer-chain.js';
import * as Events from '../src/canonical-producer-events.js';
import {reconcileProducerChain} from '../src/canonical-producer-workflow.js';

const LEDGER=Events.PRODUCER_EVENT_LEDGER_KEY;
const H=3600000,iso=ms=>new Date(ms).toISOString();
const T0=Date.parse('2026-11-25T08:00:00.000Z');
const items=bucket=>[...bucket.records.keys()].filter(key=>key.startsWith('events/items/')).sort();
const itemOf=(bucket,id)=>{const key=items(bucket).find(k=>k.endsWith('-'+id+'.json'));return key?bucket.value(key):null;};

// ---- 1. Pure decisions -----------------------------------------------------------------------------------------------------
const UUIDP='4562e2d8-14f7-4497-a4d7-270e0a975fe9';
const chainRow=over=>({programme_run_id:UUIDP,input_generation:10,owner_epoch:3,owner_state:'complete',handoff_count:2,takeover_count:1,relaunch_count:0,reopen_count:1,rebase_count:0,recovery_attempts:0,
 stopped_by:null,recovery_class:null,streak_started_at:null,updated_at:'2026-11-25T09:00:00.000Z',created_at:'2026-11-25T07:00:00.000Z',...over});
const runRow=over=>({origin:'epg',run_key:UUIDP+':10',source_generation:UUIDP+':10',pass_no:1,unit_count:10,n_applied:4,n_noop:3,n_kept:2,n_failed:1,pass_state:'passed',open_at_completion:0,
 created_at:'2026-11-25T07:10:00.000Z',completed_at:'2026-11-25T08:55:00.000Z',...over});
{
 assert.equal(Events.programmeToken(UUIDP),'4562e2d814f74497a4d7270e0a975fe9','a canonical UUID is kept whole, without dashes');
 assert.notEqual(Events.programmeToken('run-p'),Events.programmeToken('runp'),'a non-UUID id carries a hash of the exact value: no two ids collide by spelling');
 assert.equal(Events.chainOutcome(chainRow({owner_state:'complete'})),'passed');
 assert.equal(Events.chainOutcome(chainRow({owner_state:'stopped'})),'stopped');
 for(const state of ['pending','active','released','superseded'])assert.equal(Events.chainOutcome(chainRow({owner_state:state})),null,state+' is not an outcome of its own');
 assert.equal(Events.producerEventId(chainRow(),'passed'),'canonical_producer-4562e2d814f74497a4d7270e0a975fe9-g10-passed','a pass is one per (P, g)');
 assert.equal(Events.producerEventId(chainRow(),'stopped'),'canonical_producer-4562e2d814f74497a4d7270e0a975fe9-e3-stopped','a stop is one per (P, owner epoch)');
 assert.notEqual(Events.producerEventId(chainRow({owner_epoch:4}),'stopped'),Events.producerEventId(chainRow(),'stopped'),'a stop after a recovery (new epoch) is a new event');

 // Mixed counts and a pass with one failed unit.
 const mixed=Events.producerEvent({chain:chainRow(),run:runRow(),outcome:'passed'});
 assert.equal(mixed.type,'canonical_producer');assert.equal(mixed.at,'2026-11-25T08:55:00.000Z','a pass is dated by the run completion');
 assert.deepEqual([mixed.unitCount,mixed.processed,mixed.applied,mixed.noop,mixed.kept,mixed.failed,mixed.remaining,mixed.openResults],[10,10,4,3,2,1,0,0]);
 assert.equal(mixed.durationMs,105*60000);assert.equal(mixed.inputGeneration,10);assert.equal(mixed.passNo,1);
 assert.deepEqual(mixed.chain,{epoch:3,handoffs:2,takeovers:1,relaunches:0,reopens:1,rebases:0,recoveryAttempts:0});
 assert.equal(mixed.reason,null);assert.equal(mixed.recovery,null);
 // Zero / no-op pass.
 const zero=Events.producerEvent({chain:chainRow(),run:runRow({unit_count:0,n_applied:0,n_noop:0,n_kept:0,n_failed:0}),outcome:'passed'});
 assert.deepEqual([zero.unitCount,zero.processed,zero.remaining,zero.failed],[0,0,0,0]);
 // A run that is not this chain's (P, g) is never used: the numbers are unknown, not zero.
 const foreign=Events.producerEvent({chain:chainRow(),run:runRow({source_generation:UUIDP+':9'}),outcome:'passed'});
 assert.equal(foreign.runRecorded,false);assert.equal(foreign.processed,null);assert.equal(foreign.at,'2026-11-25T09:00:00.000Z');
 // A stop before any run row: every number unknown.
 const early=Events.producerEvent({chain:chainRow({owner_state:'stopped',stopped_by:'producer_identity_unresolved',recovery_class:'fail_closed'}),run:null,outcome:'stopped'});
 assert.equal(early.runRecorded,false);assert.deepEqual([early.unitCount,early.processed,early.remaining,early.durationMs],[null,null,null,null]);
 assert.equal(early.reason,'producer_identity_unresolved');assert.equal(early.recovery,'owner');assert.equal(early.recoveryClass,'fail_closed');
 // A stop in the first pass knows its remainder; a replayed pass (pass 2, counters kept) does not.
 const firstPass=Events.producerEvent({chain:chainRow({owner_state:'stopped',stopped_by:'producer_cas_lost',recovery_class:'transient'}),run:runRow({pass_state:'stopped',n_applied:2,n_noop:1,n_kept:0,n_failed:0,completed_at:null,open_at_completion:null}),outcome:'stopped'});
 assert.equal(firstPass.remaining,7);assert.equal(firstPass.recovery,'automatic');assert.equal(firstPass.openResults,null);assert.equal(firstPass.at,'2026-11-25T09:00:00.000Z');
 const replayed=Events.producerEvent({chain:chainRow({owner_state:'stopped',stopped_by:'producer_cas_lost',recovery_class:'transient'}),run:runRow({pass_no:2,pass_state:'stopped',n_applied:9,n_noop:6,completed_at:null}),outcome:'stopped'});
 assert.equal(replayed.remaining,null,'a replayed pass keeps counting: its remainder is unknown, never guessed');
 // Recovery mirrors recoverChain: class, attempt cap and 24 h streak window.
 const caps={attempts:5,windowMs:24*H};
 assert.equal(Events.recoveryOf({recovery_class:'transient',recovery_attempts:4},'2026-11-25T09:00:00.000Z',caps),'automatic');
 assert.equal(Events.recoveryOf({recovery_class:'transient',recovery_attempts:5},'2026-11-25T09:00:00.000Z',caps),'owner','attempts used up: held');
 assert.equal(Events.recoveryOf({recovery_class:'receipt',recovery_attempts:0,streak_started_at:'2026-11-24T08:00:00.000Z'},'2026-11-25T09:00:00.000Z',caps),'owner','streak window over: held');
 assert.equal(Events.recoveryOf({recovery_class:'authority',recovery_attempts:99},'2026-11-25T09:00:00.000Z',caps),'automatic');
 for(const klass of ['terminal','fail_closed','exhausted'])assert.equal(Events.recoveryOf({recovery_class:klass},'2026-11-25T09:00:00.000Z',caps),'owner');
 assert.equal(Events.producerEvent({chain:chainRow({owner_state:'stopped',stopped_by:'Bad Code<script>'}),outcome:'stopped'}).reason,null,'only a lowercase code is kept');
 const cut=Events.producerEvent({chain:chainRow({owner_state:'superseded'}),run:runRow({pass_state:'passing',completed_at:null,open_at_completion:null}),outcome:'superseded',priorState:'active'});
 assert.equal(cut.reason,'newer_publication');assert.equal(cut.priorState,'active');assert.equal(cut.recovery,'none');
 assert.ok(!JSON.stringify(mixed).includes('fingerprint')&&!JSON.stringify(mixed).includes(UUIDP),'no fingerprint and no full programme run id in the payload');
}

// ---- 2. The ledger: baseline, create-only put, outbox, lost response, concurrent tick -----------------------------------------
{
 const bucket=makeBucket(),env={BUCKET:bucket};
 const old=Events.producerEvent({chain:chainRow({owner_state:'stopped',stopped_by:'producer_cas_lost',recovery_class:'transient',updated_at:iso(T0-H)}),outcome:'stopped'});
 let s=Events.producerEventSession(env,{nowMs:T0});
 assert.equal(await s.wanted(chainRow({owner_state:'stopped',updated_at:iso(T0-H)}),'stopped'),false,'an outcome older than the first ledger is never reported (no retroactive events)');
 assert.equal(await s.record(old),'known');
 await s.finish();
 assert.equal(items(bucket).length,0);
 const ledger=bucket.value(LEDGER);assert.equal(ledger.baselineAt,iso(T0));assert.ok(ledger.settled.includes(old.id));

 const fresh=Events.producerEvent({chain:chainRow({owner_epoch:7,owner_state:'stopped',stopped_by:'producer_cas_lost',recovery_class:'transient',updated_at:iso(T0+10*60000)}),outcome:'stopped'});
 s=Events.producerEventSession(env,{nowMs:T0+H});
 assert.equal(await s.wanted(chainRow({owner_epoch:7,owner_state:'stopped',updated_at:iso(T0+10*60000)}),'stopped'),true);
 assert.equal(await s.record(fresh),'recorded');
 await s.finish();
 assert.equal(items(bucket).length,1);
 const key=items(bucket)[0];
 assert.equal(key,'events/items/'+String(9999999999999-Date.parse(fresh.at)).padStart(13,'0')+'-'+fresh.id+'.json','the journal key follows the frozen `at` and the id');
 // A duplicate observation (the next hourly tick, the same stopped chain) writes nothing.
 const before=bucket.writes().length;
 s=Events.producerEventSession(env,{nowMs:T0+2*H});
 assert.equal(await s.wanted(chainRow({owner_epoch:7,owner_state:'stopped',updated_at:iso(T0+10*60000)}),'stopped'),false);
 assert.equal(await s.record(fresh),'known');
 await s.finish();
 assert.equal(bucket.writes().length,before,'a repeated tick does not write the journal or the ledger');

 // Journal outage: the event is queued (the ledger write happens at once), later drained, delivered exactly once.
 const out=Events.producerEvent({chain:chainRow({owner_epoch:8,owner_state:'stopped',stopped_by:'producer_transport',recovery_class:'transient',updated_at:iso(T0+3*H)}),outcome:'stopped'});
 bucket.hooks.beforePut=async target=>{if(target.startsWith('events/items/'))throw new Error('r2 down');};
 s=Events.producerEventSession(env,{nowMs:T0+3*H});
 assert.equal(await s.record(out),'queued');
 assert.equal(bucket.value(LEDGER).pending.length,1,'queued in the outbox before the call returns');
 await s.finish();
 assert.equal(bucket.value(LEDGER).pending[0].attempts,1,'the same tick does not retry what it just attempted');
 s=Events.producerEventSession(env,{nowMs:T0+4*H});await s.finish();
 assert.equal(bucket.value(LEDGER).pending[0].attempts,2,'bounded retries: one attempt per tick');
 bucket.hooks.beforePut=null;
 s=Events.producerEventSession(env,{nowMs:T0+5*H});const stats=await s.finish();
 assert.equal(stats.drained,1);assert.equal(bucket.value(LEDGER).pending.length,0);assert.ok(itemOf(bucket,out.id));
 assert.deepEqual(itemOf(bucket,out.id),out,'the frozen payload is what reaches the journal');

 // Lost response: the journal wrote the object but the caller saw an error. The retry finds the key (create-only) and writes no second item.
 const lostResponse=Events.producerEvent({chain:chainRow({owner_epoch:9,owner_state:'stopped',stopped_by:'producer_transport',recovery_class:'transient',updated_at:iso(T0+6*H)}),outcome:'stopped'});
 const realPut=bucket.put.bind(bucket);let once=true;
 bucket.put=async(k,v,o)=>{const r=await realPut(k,v,o);if(once&&k.startsWith('events/items/')){once=false;throw new Error('response lost');}return r;};
 s=Events.producerEventSession(env,{nowMs:T0+6*H});
 assert.equal(await s.record(lostResponse),'recorded','the second try finds the item and counts it delivered');
 await s.finish();
 bucket.put=realPut;
 assert.equal(items(bucket).filter(k=>k.includes(lostResponse.id)).length,1,'one journal item, no duplicate');

 // Concurrent ticks: a lost ledger compare-and-swap is merged, nothing settled by the other side is lost.
 const a=Events.producerEventSession(env,{nowMs:T0+7*H}),b=Events.producerEventSession(env,{nowMs:T0+7*H});
 const ea=Events.producerEvent({chain:chainRow({owner_epoch:10,owner_state:'stopped',stopped_by:'producer_transport',recovery_class:'transient',updated_at:iso(T0+7*H)}),outcome:'stopped'});
 const eb=Events.producerEvent({chain:chainRow({owner_epoch:11,owner_state:'stopped',stopped_by:'producer_transport',recovery_class:'transient',updated_at:iso(T0+7*H)}),outcome:'stopped'});
 await a.record(ea);await b.record(eb);await a.finish();await b.finish();
 const merged=bucket.value(LEDGER);
 assert.ok(merged.settled.includes(ea.id)&&merged.settled.includes(eb.id),'both ticks settled ids survive the compare-and-swap race');

 // Outbox at its bound: the newest is counted lost and logged, nothing is evicted.
 bucket.hooks.beforePut=async target=>{if(target.startsWith('events/items/'))throw new Error('r2 down');};
 const logs=[];
 s=Events.producerEventSession(env,{nowMs:T0+8*H,log:line=>logs.push(line)});
 for(let i=0;i<Events.PRODUCER_EVENT_PENDING_MAX;i++)assert.equal(await s.record(Events.producerEvent({chain:chainRow({owner_epoch:100+i,owner_state:'stopped',stopped_by:'producer_transport',recovery_class:'transient',updated_at:iso(T0+8*H)}),outcome:'stopped'})),'queued');
 assert.equal(await s.record(Events.producerEvent({chain:chainRow({owner_epoch:999,owner_state:'stopped',stopped_by:'producer_transport',recovery_class:'transient',updated_at:iso(T0+8*H)}),outcome:'stopped'})),'lost');
 await s.finish();
 assert.equal(bucket.value(LEDGER).pending.length,Events.PRODUCER_EVENT_PENDING_MAX);assert.equal(bucket.value(LEDGER).lost,1);
 assert.ok(logs.some(line=>line.event==='canonical_producer_event_lost'&&line.reason==='outbox_full'));
 bucket.hooks.beforePut=null;
 s=Events.producerEventSession(env,{nowMs:T0+9*H});await s.finish();
 assert.equal(bucket.value(LEDGER).pending.length,Events.PRODUCER_EVENT_PENDING_MAX-Events.PRODUCER_EVENT_DRAIN_MAX,'the drain is bounded per tick');

 // An unreadable ledger: nothing is written and nothing is decided (no baseline can be proven).
 const dark=makeBucket();dark.hooks.beforeGet=async()=>{throw new Error('r2 down');};
 s=Events.producerEventSession({BUCKET:dark},{nowMs:T0});
 assert.equal(await s.wanted(chainRow({owner_state:'stopped',updated_at:iso(T0+H)}),'stopped'),false);
 assert.equal(await s.record(fresh),'unavailable');
 const st=await s.finish();assert.equal(st.unreadable,true);assert.equal(dark.writes().length,0);
}

// ---- 3. The hourly reconcile over the real schema --------------------------------------------------------------------------
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-producer-events-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r;};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'t.sqlite');
sqlite(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
let n=0;
const P='run-p',SHA='a'.repeat(64);
function database(){
 const file=path.join(root,'c-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;"+
  "UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
 publish(file,P,10);
 return file;
}
function publish(file,programmeRunId,generation){
 sqlite(file,"INSERT OR IGNORE INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('"+programmeRunId+"','published','"+iso(T0)+"','"+SHA+"','"+iso(T0)+"');"+
  "UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='"+programmeRunId+"',generation="+generation+" WHERE id=1;");
}
const chainOf=(file,p=P)=>rows(file,"SELECT * FROM canonical_producer_chain WHERE programme_run_id='"+p+"'")[0];
const setChain=(file,sets,p=P)=>sqlite(file,'UPDATE canonical_producer_chain SET '+sets+",revision=revision+1 WHERE programme_run_id='"+p+"'");
function makeRun(file,label,{units=6,applied=0,noop=0,kept=0,failed=0,created=iso(T0)}={}){
 sqlite(file,"INSERT INTO canonical_producer_run (origin,run_key,source_generation,pass_no,plan_version,fingerprint,unit_count,pass_state,marker_generation,revision,created_at,updated_at) VALUES ('epg','"+label+"','"+label+"',1,1,'"+SHA+"',"+units+",'passing',2,1,'"+created+"','"+created+"')");
 if(applied+noop+kept+failed)sqlite(file,"UPDATE canonical_producer_run SET n_applied="+applied+",n_noop="+noop+",n_kept="+kept+",n_failed="+failed+",cursor_kind='film',cursor_id='film:x',revision=revision+1 WHERE run_key='"+label+"'");
}
const passRun=(file,label,at,open=0)=>sqlite(file,"UPDATE canonical_producer_run SET pass_state='passed',applied_generation=source_generation,open_at_completion="+open+",completed_at='"+at+"',updated_at='"+at+"',revision=revision+1 WHERE run_key='"+label+"'");
const stopRun=(file,label,code,at)=>sqlite(file,"UPDATE canonical_producer_run SET pass_state='stopped',stopped_by='"+code+"',updated_at='"+at+"',revision=revision+1 WHERE run_key='"+label+"'");
function envOf(file,bucket,created=[]){return {DB:d1Standin(file),BUCKET:bucket,PRODUCER_WORKFLOW:{create:async({id})=>{created.push(id);}}};}
const tick=(env,ms)=>reconcileProducerChain(env,{now:ms,hold:false});

// 3a. First tick establishes the baseline; a stop recorded earlier (the P518 case) is never reported, even though it is then recovered.
{
 const file=database(),bucket=makeBucket(),env=envOf(file,bucket);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:iso(T0-2*H),nowMs:T0-2*H});
 setChain(file,"owner_state='stopped',stopped_by='producer_cas_lost',recovery_class='transient',next_attempt_at='"+iso(T0-H)+"',updated_at='"+iso(T0-90*60000)+"'");
 const out=await tick(env,T0);
 assert.equal(out.recover,1,'the reconcile still recovers the chain');
 assert.equal(items(bucket).length,0,'no retroactive event for an outcome before the reporter existed');
 assert.equal(bucket.value(LEDGER).baselineAt,iso(T0));
}

// 3b. Recoverable stop, then a later success in the same P:g: two events, the stop first (before the recovery), no duplicate on repeated ticks, none per handoff.
{
 const file=database(),bucket=makeBucket(),created=[],env=envOf(file,bucket,created);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:iso(T0),nowMs:T0});
 await tick(env,T0+60000);
 assert.equal(items(bucket).length,0,'a pending chain is not an outcome');
 makeRun(file,P+':10',{units:6,applied:1,noop:1});
 // A handoff (epoch 2, pending) and a renewal are not outcomes.
 setChain(file,"owner_epoch=2,owner_instance='pw_x_2',owner_state='pending',handoff_count=handoff_count+1,lease_expires_at='"+iso(T0+3*H)+"',updated_at='"+iso(T0+5*60000)+"'");
 await tick(env,T0+10*60000);
 assert.equal(items(bucket).length,0,'no event per handoff');
 // The owner of epoch 2 stops with a transient code; the run row is stopped too.
 stopRun(file,P+':10','producer_cas_lost',iso(T0+20*60000));
 setChain(file,"owner_state='stopped',stopped_by='producer_cas_lost',recovery_class='transient',streak_started_at='"+iso(T0+20*60000)+"',next_attempt_at='"+iso(T0+30*60000)+"',updated_at='"+iso(T0+20*60000)+"'");
 const out=await tick(env,T0+H);
 assert.equal(out.recover,1,'recovered into a new epoch in the same tick');
 assert.equal(chainOf(file).owner_epoch,3);
 const stopId='canonical_producer-'+Events.programmeToken(P)+'-e2-stopped';
 const stop=itemOf(bucket,stopId);
 assert.ok(stop,'the stop was reported before the recovery erased it from the chain row');
 assert.equal(stop.at,iso(T0+20*60000));assert.equal(stop.reason,'producer_cas_lost');assert.equal(stop.recovery,'automatic');
 assert.deepEqual([stop.unitCount,stop.processed,stop.remaining],[6,2,4]);
 await tick(env,T0+2*H);
 assert.equal(items(bucket).length,1,'nothing new while the chain runs');
 assert.equal(chainOf(file).owner_epoch,4,'the pending epoch 3 lapsed and was taken over: a takeover is not an outcome either');
 // Epoch 3 completes the pass (the chain complete and the run passed in one batch).
 sqlite(file,"UPDATE canonical_producer_run SET pass_state='passing',stopped_by=NULL,revision=revision+1 WHERE run_key='"+P+":10'");
 sqlite(file,"UPDATE canonical_producer_run SET n_applied=3,n_noop=3,cursor_id='film:z',revision=revision+1 WHERE run_key='"+P+":10'");
 passRun(file,P+':10',iso(T0+150*60000));
 setChain(file,"owner_state='complete',claim_nonce='aaaaaaaa-0000-0000-0000-000000000000',updated_at='"+iso(T0+150*60000)+"'");
 await tick(env,T0+3*H);
 const passId='canonical_producer-'+Events.programmeToken(P)+'-g10-passed';
 const pass=itemOf(bucket,passId);
 assert.ok(pass,'the later success of the same P:g is its own event');
 assert.equal(pass.at,iso(T0+150*60000));assert.deepEqual([pass.unitCount,pass.processed,pass.remaining,pass.failed,pass.openResults],[6,6,0,0,0]);
 assert.equal(pass.chain.epoch,4);assert.equal(pass.chain.handoffs,1);assert.equal(pass.chain.takeovers,1);assert.equal(pass.chain.recoveryAttempts,1);
 for(const hour of [4,5,6])await tick(env,T0+hour*H);
 assert.equal(items(bucket).length,2,'a lasting complete state is reported once');
}

// 3c. Event delivery failure plus normal recovery: the Producer is not held by the journal, the event arrives later, once.
{
 const file=database(),bucket=makeBucket(),created=[],env=envOf(file,bucket,created);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:iso(T0),nowMs:T0});
 await tick(env,T0+60000);
 setChain(file,"owner_state='stopped',stopped_by='producer_transport',recovery_class='transient',next_attempt_at='"+iso(T0+30*60000)+"',updated_at='"+iso(T0+20*60000)+"'");
 bucket.hooks.beforePut=async target=>{if(target.startsWith('events/items/'))throw new Error('journal down');};
 const out=await tick(env,T0+H);
 assert.equal(out.recover,1,'the recovery happens although the journal refused the event');
 assert.equal(created.length,1,'and the Workflow instance is created');
 assert.equal(items(bucket).length,0);
 assert.equal(bucket.value(LEDGER).pending.length,1,'the event waits in the outbox');
 bucket.hooks.beforePut=null;
 await tick(env,T0+2*H);
 assert.equal(items(bucket).length,1);assert.equal(bucket.value(LEDGER).pending.length,0);
 await tick(env,T0+3*H);
 assert.equal(items(bucket).length,1,'delivered exactly once');
}

// 3d. A newer publication: an in-flight chain is superseded (one interrupted event); a complete chain is reported as passed and its supersede adds nothing.
{
 const file=database(),bucket=makeBucket(),created=[],env=envOf(file,bucket,created);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:iso(T0),nowMs:T0});
 await tick(env,T0+60000);
 makeRun(file,P+':10',{units:8,applied:2,noop:1});
 setChain(file,"owner_state='active',claim_nonce='bbbbbbbb-0000-0000-0000-000000000000',lease_expires_at='"+iso(T0+3*H)+"',updated_at='"+iso(T0+10*60000)+"'");
 publish(file,'run-q',11);
 await tick(env,T0+H);
 assert.equal(chainOf(file).owner_state,'superseded');
 const cut=itemOf(bucket,'canonical_producer-'+Events.programmeToken(P)+'-e1-superseded');
 assert.ok(cut,'an interrupted pass is reported once');
 assert.equal(cut.outcome,'superseded');assert.equal(cut.priorState,'active');assert.equal(cut.at,iso(T0+H));assert.deepEqual([cut.processed,cut.remaining],[3,5]);
 // The new run's chain completes, then a third publication supersedes it: the pass is reported, the supersede of a complete chain is not.
 const Q='run-q';
 makeRun(file,Q+':11',{units:2,applied:2});
 passRun(file,Q+':11',iso(T0+90*60000),1);
 setChain(file,"owner_state='complete',updated_at='"+iso(T0+90*60000)+"'",Q);
 publish(file,'run-r',12);
 await tick(env,T0+2*H);
 assert.equal(chainOf(file,Q).owner_state,'superseded');
 const qPass=itemOf(bucket,'canonical_producer-'+Events.programmeToken(Q)+'-g11-passed');
 assert.ok(qPass,'the pass is reported before the supersede ends the chain');
 assert.equal(qPass.openResults,1,'an unclosed result is carried, so the pass is not a plain success');
 assert.ok(!items(bucket).some(k=>k.includes(Events.programmeToken(Q))&&k.includes('superseded')),'no second event for a chain that had already completed');
 assert.equal(items(bucket).length,2);
}

// 3e. fail_closed before any run row (an identity refusal): an error report with unknown numbers; a lasting held stop is reported once.
{
 const file=database(),bucket=makeBucket(),env=envOf(file,bucket);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:iso(T0),nowMs:T0});
 await tick(env,T0+60000);
 setChain(file,"owner_state='stopped',stopped_by='producer_identity_unresolved',recovery_class='fail_closed',updated_at='"+iso(T0+5*60000)+"'");
 for(const hour of [1,2,3])await tick(env,T0+hour*H);
 assert.equal(items(bucket).length,1);
 const held=itemOf(bucket,'canonical_producer-'+Events.programmeToken(P)+'-e1-stopped');
 assert.equal(held.runRecorded,false);assert.equal(held.recovery,'owner');assert.equal(held.processed,null);assert.equal(held.unitCount,null);
}

// 3f. Dormant and held reconciles write nothing to R2.
{
 const file=database(),bucket=makeBucket(),env=envOf(file,bucket);
 assert.deepEqual(await reconcileProducerChain(env,{now:T0,hold:true}),{ran:false,reason:'held_by_delivery'});
 assert.equal(bucket.writes().length,0);
 assert.equal((await reconcileProducerChain({...env,PRODUCER_WORKFLOW:undefined},{now:T0,hold:false})).reason,'workflow_unavailable');
 assert.equal(bucket.writes().length,0);
}

// ---- 4. The Events screen: result status, card, type filter ----------------------------------------------------------------
{
 const app=fs.readFileSync('public/app.js','utf8'),html=fs.readFileSync('public/index.html','utf8');
 const ctx=vm.createContext({URL,URLSearchParams,Set,Map,Date,Intl,document:{querySelector:()=>null,querySelectorAll:()=>[]},window:{location:{href:'https://iptv.example/'}}});
 vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+'\n'+app.replace(/init\(\);\s*$/,''),ctx);
 const status=event=>vm.runInContext('eventPresentationStatus('+JSON.stringify(event)+')',ctx);
 const card=event=>{ctx.ev=event;return vm.runInContext('eventHTML(ev)',ctx);};
 const base=Events.producerEvent({chain:chainRow(),run:runRow({n_failed:0,n_applied:5}),outcome:'passed'});
 assert.equal(status(base),'success');
 assert.equal(status({...base,failed:1}),'warning','a failed unit is never a success');
 assert.equal(status({...base,openResults:2}),'warning','unclosed results are never a success');
 assert.equal(status({...base,failed:null}),'warning','an unknown count is never a success');
 assert.equal(status({...base,outcome:'stopped',recovery:'automatic'}),'interrupted');
 assert.equal(status({...base,outcome:'stopped',recovery:'owner'}),'error');
 assert.equal(status({...base,outcome:'stopped',recovery:null}),'warning');
 assert.equal(status({...base,outcome:'superseded'}),'interrupted');
 assert.equal(status({...base,outcome:'mystery'}),null,'an unknown outcome has no result');
 let html1=card(base);
 assert.match(html1,/Обогащение каталога завершено</);assert.match(html1,/<dt>Единиц в плане<\/dt><dd>10<\/dd>/);assert.match(html1,/<dt>Обработано<\/dt><dd>10<\/dd>/);
 assert.match(html1,/<dt>Незакрытых результатов<\/dt><dd>0<\/dd>/);assert.match(html1,/Поколение программы: 10 · проход 1/);assert.match(html1,/Длительность: 1 ч 45 мин/);
 assert.match(html1,/event-status-success/);assert.doesNotMatch(html1,/фильм/i,'units are not called films');
 html1=card({...base,failed:2});assert.match(html1,/завершено с ошибками/);
 html1=card({...base,openResults:3});assert.match(html1,/остались незакрытые результаты/);
 const stop=Events.producerEvent({chain:chainRow({owner_state:'stopped',stopped_by:'producer_cas_lost',recovery_class:'transient'}),run:null,outcome:'stopped',caps:{attempts:5,windowMs:24*H}});
 html1=card(stop);
 assert.match(html1,/остановлено, продолжится автоматически/);assert.match(html1,/<dt>Обработано<\/dt><dd>неизвестно<\/dd>/);assert.match(html1,/числа неизвестны/);
 assert.match(html1,/<code>producer_cas_lost<\/code>/);assert.match(html1,/класс: <code>transient<\/code>/);assert.match(html1,/Штатное восстановление/);assert.match(html1,/event-status-interrupted/);
 html1=card({...stop,recovery:'owner',recoveryClass:'fail_closed'});assert.match(html1,/нужно решение владельца/);assert.match(html1,/event-status-error/);
 html1=card({...stop,reason:'<img src=x onerror=1>',recoveryClass:'<script>',chain:{epoch:'<b>'},unitCount:'7'});
 assert.doesNotMatch(html1,/<img|<script|<b>|onerror/);assert.match(html1,/Код остановки: не указан/);assert.match(html1,/<dt>Единиц в плане<\/dt><dd>неизвестно<\/dd>/,'a string is not a count');
 html1=card({...base,outcome:'superseded',reason:'newer_publication'});assert.match(html1,/прервано: вышла новая программа/);
 html1=card({...base,passNo:2});assert.match(html1,/включают более ранние проходы/);
 assert.ok(vm.runInContext("eventMatchesType({type:'canonical_producer'},'canonical_producer')&&!eventMatchesType({type:'canonical_producer'},'discovery')&&eventMatchesType({type:'canonical_producer'},'all')",ctx));
 assert.ok(vm.runInContext("eventMatchesFilters({type:'canonical_producer',outcome:'stopped',recovery:'owner'},'canonical_producer','error')",ctx),'both filters combine');
 assert.equal(vm.runInContext("eventTypeFrom('?type=canonical_producer&result=error')",ctx),'canonical_producer','deep link');
 assert.equal(vm.runInContext("withEventType('/events?result=error','canonical_producer')",ctx),'/events?result=error&type=canonical_producer');
 assert.match(html,/data-event-type="canonical_producer" aria-pressed="false">Обогащение каталога</);
}
console.log('canonical-producer-events: one event per pass P:g or recorded stop (P, epoch), reported before the reconcile moves the chain, no retroactive or per-handoff events, journal failures queued and drained once, superseded in-flight passes interrupted, and the card, result and both filters on the Events screen');
