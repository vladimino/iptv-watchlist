// AIR-572 (production 24 Nov 2026): the Producer instance budget of ADR 0141 D5 on the REAL Workflow path. Fixture and helpers: canonical-producer-budget-lib.mjs.
import assert from 'node:assert/strict';
import * as Fence from '../src/canonical-producer-fence.js';
import * as Chain from '../src/canonical-producer-chain.js';
import {AT,P,one,rows,sqlite,producerFixture,producerWorld,driveChain,runRow} from './canonical-producer-budget-lib.mjs';

{
 const world=producerWorld();
 const {file}=world;
 const first=await driveChain(world,{generation:10});
 assert.equal(first.last.state,'complete',JSON.stringify(first.last));
 assert.ok(first.instances>1,'the default headroom needs several instances for this plan ('+first.instances+')');
 assert.ok(first.reasons.has('budget'),'the instances hand over on the budget, never producer_budget_infeasible');
 assert.notEqual(one(file,'SELECT release_pin FROM canonical_producer_chain'),null,'the first invocation pinned the releases (and its hand-off won the CAS)');
 let r=runRow(file);
 assert.equal(r.pass_state,'passed');assert.equal(r.done,r.unit_count,'every unit has a durable outcome');
 assert.ok(r.n_failed>=1,'the over-cap Film is a durable planner refusal');
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM film WHERE id NOT LIKE 'film:tmdb:%'")),0,'no shadow Film');
 assert.equal(one(file,"SELECT group_concat(film_id) FROM watchlist_film"),'film:tmdb:999','sync/1: the Producer wrote no membership');
 // The next publication (a NEW programme run, as production publishes): cheap no-ops first, then the last films with changed credits (expensive), and the live refusals of
 // generation 10 to supersede: same bound, the new chain completes.
 assert.equal(sqlite(file,producerFixture(file,11,{changed:8,run:'run-q'})).status,0);
 const second=await driveChain(world,{generation:11,programmeRunId:'run-q'});
 assert.equal(second.last.state,'complete',JSON.stringify(second.last));
 r=runRow(file,'run-q');
 assert.equal(r.pass_state,'passed');assert.equal(r.done,r.unit_count);
 assert.ok(r.n_noop>0&&r.n_applied>0,'the second generation mixes no-ops and changes');
 assert.equal(one(file,"SELECT group_concat(film_id) FROM watchlist_film"),'film:tmdb:999','sync/1: membership untouched across both generations');
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_producer_unit_result WHERE run_key='epg:run-p:10' AND state NOT IN ('superseded','settled','abandoned')")),0,'the earlier generation results are superseded by the sweep');
}
// A real receipt backlog: three receipt batches commit and lose their response, so units fail on transport, receipts stay open, and the reconcile of the next invocations
// (the drain at the start and before the completion, both admitted per page) settles them. Default and narrow limits; the bound and the ceilings hold, the chain completes, no open receipt.
for(const limitCalls of [undefined,1700]){
 const world=producerWorld({loseReceiptResponses:3});
 const out=await driveChain(world,{generation:10,limitCalls,recover:true});
 assert.ok(out.recovered>=1,'the transport stops were recovered by the reconcile path');
 assert.equal(world.lost.count,3,'three responses were lost: '+JSON.stringify(out.last)+' '+JSON.stringify(rows(world.file,"SELECT owner_state,stopped_by,recovery_class FROM canonical_producer_chain")));
 assert.equal(out.last.state,'complete',JSON.stringify(out.last));
 assert.equal(Number(one(world.file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE origin='epg' AND state IN ('pending','failed','unknown')")),0,'every receipt is terminal');
 const r=runRow(world.file);
 assert.equal(r.pass_state,'passed');assert.equal(r.done,r.unit_count);
}
// Infeasible: an instance whose fixed part plus ONE operation and the end reserve cannot fit stops `producer_budget_infeasible` (fail_closed) without a successor and without a write
// to the run.
{
 const world=producerWorld();
 const out=await driveChain(world,{generation:10,limitCalls:300,maxInstances:1});
 assert.equal(out.last.state,'stopped');assert.equal(out.last.code,'producer_budget_infeasible');
 assert.equal(world.created.length,0,'no successor');
 assert.equal(one(world.file,'SELECT recovery_class FROM canonical_producer_chain'),'fail_closed');
 assert.equal(Number(one(world.file,'SELECT COUNT(*) FROM canonical_producer_run')),0,'nothing applied');
}

// Replay safety (review of PR #967): the instance meter lives in one execution only. A `work` step that runs again for the same epoch never redoes the work: it stops the chain
// `producer_work_replayed` (transient) after refreshing the fence under the owner proof, and the existing hourly recoverChain relaunches it into a NEW epoch with a fresh budget.
// Case 1: the instance is replayed with FRESH memory and the cached nonce and claim, after its first attempt committed durable slices and then failed (the hand-off batch is lost
// before it runs). Case 2: the step is retried in the SAME memory.
const { runProducerWorkflow } = await import('../src/canonical-producer-workflow.js');
const cachedSteps=()=>{const cache=new Map();return {cache,do:async(name,fn)=>{if(cache.has(name))return cache.get(name);const value=name==='nonce'?crypto.randomUUID():await fn();cache.set(name,value);return value;}};};
const runState=file=>rows(file,"SELECT n_applied,n_noop,n_kept,n_failed,cursor_kind,cursor_id,revision,unit_count FROM canonical_producer_run WHERE run_key='epg:run-p:10'")[0];
for(const memory of ['fresh','same']){
 const world=producerWorld();
 const {env,file,meter}=world;
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const claimRevision=()=>Number(JSON.parse(JSON.stringify(steps.cache.get('claim')?.chain?.revision??0)));
 const steps=cachedSteps();
 world.failBatch=list=>list.some(item=>/handoff_count=handoff_count\+1/.test(item?.text||''));
 let first;
 if(memory==='fresh'){
  await assert.rejects(()=>runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch},steps,{hold:false}),error=>error?.code==='producer_transport');
  assert.equal(steps.cache.has('work'),false,'the failed work step is not cached');
 }else{
  // The runtime retries the failed step once in the same execution (same closure, same meter).
  let retried=false;
  const retrying={cache:steps.cache,do:async(name,fn)=>{try{return await steps.do(name,fn);}catch(error){if(name!=='work'||retried)throw error;retried=true;return steps.do(name,fn);}}};
  first=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch},retrying,{hold:false});
  assert.equal(retried,true);
  assert.deepEqual(first,{state:'stopped',code:'producer_work_replayed'});
 }
 const chain=rows(file,"SELECT owner_epoch,owner_state,revision,stopped_by,recovery_class FROM canonical_producer_chain")[0];
 const before=runState(file);
 assert.ok(before.n_applied+before.n_noop+before.n_kept+before.n_failed>0,'the failed attempt committed durable slices');
 if(memory==='fresh'){
  assert.equal(chain.owner_state,'active');assert.equal(chain.owner_epoch,1);
  assert.ok(chain.revision>claimRevision(),'the attempt moved the chain revision past the claim');
  // The instance is replayed: fresh memory, the cached nonce and claim (their stale revision), the same epoch.
  const spentBefore=meter.calls;
  const again=await runProducerWorkflow(env,{programmeRunId:P,epoch:1},steps,{hold:false});
  assert.deepEqual(again,{state:'stopped',code:'producer_work_replayed'},'no stale CAS: the fence was refreshed under the owner proof');
  assert.ok(meter.calls-spentBefore<=Fence.CHAIN_COST.end,'the re-entry spends at most the end reserve ('+(meter.calls-spentBefore)+')');
 }
 assert.deepEqual(runState(file),before,'the re-entry wrote no unit outcome, cursor or counter');
 const stopped=rows(file,"SELECT owner_state,stopped_by,recovery_class,owner_epoch FROM canonical_producer_chain")[0];
 assert.deepEqual(stopped,{owner_state:'stopped',stopped_by:'producer_work_replayed',recovery_class:'transient',owner_epoch:1});
 // The existing reconciliation relaunches it into a new epoch after the backoff, and the chain completes without a duplicated or lost outcome.
 const row=await Chain.readChain(env,P);
 const t=Date.parse(row.next_attempt_at)+1000;
 assert.equal((await Chain.recoverChain(env,{chain:row,generation:10,at:new Date(t).toISOString(),nowMs:t})).state,'pending');
 const rest=await driveChain(world,{generation:10});
 assert.equal(rest.last.state,'complete',JSON.stringify(rest.last));
 const done=runRow(file);
 assert.equal(done.pass_state,'passed');assert.equal(done.done,done.unit_count,'every unit counted exactly once');
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_producer_unit_result WHERE run_key='epg:run-p:10' AND state IN ('open','refused_permanent','refused_recoverable')")),Number(one(file,"SELECT COUNT(DISTINCT kind||unit_id) FROM canonical_producer_unit_result WHERE run_key='epg:run-p:10' AND state IN ('open','refused_permanent','refused_recoverable')")),'one live result per unit');
 assert.ok(Number(one(file,'SELECT owner_epoch FROM canonical_producer_chain'))>=2,'completed in a later epoch');
 assert.equal(one(file,"SELECT group_concat(film_id) FROM watchlist_film"),'film:tmdb:999');
}
