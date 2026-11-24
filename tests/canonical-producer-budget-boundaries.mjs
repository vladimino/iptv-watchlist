// AIR-572 (production 24 Nov 2026): the Producer instance budget of ADR 0141 D5 on the REAL Workflow path: boundaries at narrow limits and the epoch cap. Fixture and helpers: canonical-producer-budget-lib.mjs.
import assert from 'node:assert/strict';
import * as Fence from '../src/canonical-producer-fence.js';
import * as Chain from '../src/canonical-producer-chain.js';
import {AT,P,one,rows,sqlite,producerFixture,producerWorld,driveChain,runRow} from './canonical-producer-budget-lib.mjs';

// Every boundary kind, deterministically: the next publication at a range of narrow limits. Across them an instance ends inside the sweep of the earlier results, a successor starts
// with the cursor past the last unit, and an instance ends at the completion (before or inside its receipt reconcile). Each run keeps the bound and completes.
{
 const traces=[];
 for(const limitCalls of [1500,1700]){
  const world=producerWorld();
  assert.equal((await driveChain(world,{generation:10})).last.state,'complete');
  // A backlog of earlier live results that the next plan covers (one per actor of films 1 to 24): the sweep must supersede all of them, page by page, inside the budget.
  const backlog=[];for(let i=1;i<=24;i++)for(let c=0;c<i%13&&i%5!==0;c++)backlog.push("('epg','epg:run-p:10',1,'person_mutation','person:actor/a"+(i*100+c)+"','"+'a'.repeat(64)+"','"+'b'.repeat(64)+"','refused_permanent','unit',NULL,'film_person_bounded',1,NULL,NULL,NULL,'"+AT+"','"+AT+"',NULL)");
  assert.equal(sqlite(world.file,"INSERT INTO canonical_producer_unit_result VALUES "+backlog.join(',')).status,0);
  assert.ok(backlog.length>100,'a backlog larger than two sweep pages ('+backlog.length+')');
  assert.equal(sqlite(world.file,producerFixture(world.file,11,{changed:8,run:'run-q'})).status,0);
  const out=await driveChain(world,{generation:11,limitCalls,programmeRunId:'run-q'});
  assert.equal(out.last.state,'complete','limit '+limitCalls+': '+JSON.stringify(out.last));
  const r=runRow(world.file,'run-q');
  assert.equal(r.pass_state,'passed');assert.equal(r.done,r.unit_count);
  assert.equal(Number(one(world.file,"SELECT COUNT(*) FROM canonical_producer_unit_result WHERE run_key='epg:run-p:10' AND state NOT IN ('superseded','settled','abandoned')")),0,'limit '+limitCalls+': the earlier results are superseded');
  traces.push(...out.trace);
 }
 assert.ok(traces.some(t=>/sweep_settle$/.test(t)),'an instance ran out of budget inside the sweep of the earlier results');
 assert.ok(traces.some(t=>/^invocation>receipt>sweep_read/.test(t)),'a successor started with the cursor past the last unit');
 assert.ok(traces.some(t=>/>complete$/.test(t)||/>complete>receipt$/.test(t)),'an instance ran out of budget at the completion');
}
// CHAIN_EPOCH_CAP: the same programme run re-published (a REOPEN keeps counting epochs) at a narrow limit exhausts the cap, and the hand-off the cap refuses STOPS the chain on the
// record (fail_closed) instead of answering a hand-off without a successor and leaving an active chain to a lapsing lease.
{
 const world=producerWorld();
 const {file}=world;
 assert.equal((await driveChain(world,{generation:10})).last.state,'complete');
 assert.equal(sqlite(file,producerFixture(file,11,{changed:8,run:'run-q'})).status,0);
 const first=await driveChain(world,{generation:11,limitCalls:1100,programmeRunId:'run-q'});
 assert.equal(first.last.state,'complete',JSON.stringify(first.last));
 assert.equal(sqlite(file,producerFixture(file,12,{changed:16,run:'run-q'})).status,0);
 const reopened=await Chain.reopenChain(world.env,{chain:await Chain.readChain(world.env,'run-q'),generation:12,at:AT,nowMs:Date.parse(AT)});
 assert.equal(reopened.state,'pending');
 const capped=await driveChain(world,{generation:12,limitCalls:1100,programmeRunId:'run-q'});
 assert.equal(capped.last.state,'stopped',JSON.stringify(capped.last));assert.equal(capped.last.code,'producer_chain_epoch_cap');
 assert.equal(one(file,"SELECT owner_state||'/'||stopped_by||'/'||recovery_class FROM canonical_producer_chain WHERE programme_run_id='run-q'"),'stopped/producer_chain_epoch_cap/fail_closed');
 assert.equal(Number(one(file,"SELECT owner_epoch FROM canonical_producer_chain WHERE programme_run_id='run-q'")),Fence.CHAIN_EPOCH_CAP);
 assert.equal(one(file,"SELECT group_concat(film_id) FROM watchlist_film"),'film:tmdb:999');
}
