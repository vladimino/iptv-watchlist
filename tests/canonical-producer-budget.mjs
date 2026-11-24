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

