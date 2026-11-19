// Runner lease recovery on batch runner v2 (ADR 0122, ADR 0167): the shared 12-minute lease, heartbeat renewal, an atomic takeover of an expired lease by one of two
// concurrent starts, the interrupted predecessor, no expired-stop Event (a v2 run writes no resume Event, ADR 0146), saved forecasts reused and a stale owner fenced. D1 prediction authority, as production runs it;
// local stand-ins only.
import assert from 'node:assert/strict';import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const w=await flowWorld({films:3});assert.equal((await w.api('queue/reconcile',{})).status,200);
const start=body=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...body});
const lease=()=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);
const expire=()=>{const doc=lease();doc.expiresAt=1;sql(w.file,"UPDATE prediction_lease SET expires_at=1, document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");};
const run=id=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+id+"'")[0].d);
const events=()=>[...w.records].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v);
const status=async()=>(await w.ctx.worker.fetch(new Request('https://site.example/api/enrichment/status'),w.env)).json();
const near=(value,expected,slack=5000)=>assert.ok(Math.abs(value-expected)<=slack,value+' is not about '+expected);

assert.equal(vm.runInContext('RUNNER_LEASE_TTL',w.ctx),12*60000);
const first=(await start({manifestSize:2})).data;assert.equal(first.status,'running');near(lease().expiresAt-Date.now(),12*60000);
for(let i=0;i<3;i++){const before=lease().expiresAt;const hb=await w.api('heartbeat',{runId:first.runId});assert.equal(hb.status,200);assert.ok(lease().expiresAt>=before);near(lease().expiresAt-Date.now(),12*60000);assert.equal((await start()).data.status,'already_running');}
const savedId=first.films[0].filmId;
const submitted=await w.api('batch/submit',{runId:first.runId,epoch:first.lease.epoch,items:[{filmId:savedId,fingerprint:w.fingerprint,prediction:w.prediction}]});
assert.equal(submitted.data.results[0].status,'created');
const pointer=()=>sql(w.file,"SELECT * FROM prediction_pointer WHERE film_id='"+savedId+"'");const saved=JSON.stringify(pointer());

// The lease expires. Two concurrent starts: exactly one takes over (epoch + 1), the other is turned away; the predecessor is interrupted and recoverable.
expire();
const race=await Promise.all([start(),start()]);
assert.equal(race.filter(x=>x.data.status==='running').length,1,JSON.stringify(race.map(x=>x.data.status)));
assert.ok(race.some(x=>['already_running','busy'].includes(x.data.status)));
const resumed=race.find(x=>x.data.status==='running').data;
assert.notEqual(resumed.runId,first.runId);assert.equal(resumed.lease.epoch,first.lease.epoch+1);assert.equal(lease().runId,resumed.runId);
const old=run(first.runId);assert.equal(old.status,'interrupted');assert.equal(old.recoverable,true);assert.equal(old.recoveredByRunId,resumed.runId);
assert.equal(events().filter(e=>e.reason==='lease_expired').length,0,'an expired lease is a resume, not a stop Event');
const live=await status();assert.equal(live.state,'running');assert.equal(live.runId,resumed.runId);
assert.ok(!resumed.films.some(f=>f.filmId===savedId),'the saved forecast is reused, not regenerated');assert.equal(JSON.stringify(pointer()),saved);

// The dead owner is fenced: its heartbeat, submit and late completion change nothing and cannot release the new owner's lease.
assert.equal((await w.api('heartbeat',{runId:first.runId})).status,409);
const late=await w.api('batch/submit',{runId:first.runId,epoch:first.lease.epoch,items:[{filmId:first.films[1].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});assert.notEqual(late.status,200);
await w.api('complete',{runId:first.runId,reason:'lease_expired'});
assert.equal(events().filter(e=>e.reason==='lease_expired').length,0);assert.equal(lease().runId,resumed.runId);assert.ok(lease().expiresAt>Date.now());
assert.equal(sql(w.file,"SELECT COUNT(*) AS n FROM prediction_pointer")[0].n,1,'the fenced submit wrote nothing');

// The 12-minute boundary. Elapsed time since the last renewal is simulated by moving the stored expiry; every renewal, takeover and refusal below uses the real clock and the real code.
const TTL=12*60000;
const elapse=minutes=>{const doc=lease();doc.expiresAt=Date.now()+TTL-minutes*60000;sql(w.file,"UPDATE prediction_lease SET expires_at="+doc.expiresAt+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");};
const pointers=()=>sql(w.file,"SELECT COUNT(*) AS n FROM prediction_pointer")[0].n;
const owner=resumed.runId,epoch=resumed.lease.epoch;
// 11 minutes without a renewal: still the owner's. A rival start is turned away; the owner's heartbeat restores the full TTL and keeps the epoch.
elapse(11);assert.equal((await start()).data.status,'already_running');
let beat=await w.api('heartbeat',{runId:owner});assert.equal(beat.status,200);assert.equal(beat.data.epoch,epoch);near(lease().expiresAt-Date.now(),TTL);
// A heartbeat every 5 minutes keeps a long run alive far beyond one TTL (30 simulated minutes): the TTL bounds the silence, not the run.
for(let i=0;i<6;i++){elapse(5);assert.equal((await start()).data.status,'already_running','silence of 5 minutes, round '+i);beat=await w.api('heartbeat',{runId:owner});assert.equal(beat.status,200);assert.equal(beat.data.epoch,epoch);near(lease().expiresAt-Date.now(),TTL);}
assert.equal(lease().runId,owner);
// A submit after 11 minutes of silence is accepted and renews the lease to a full TTL (the submit gate renews and clears it).
elapse(11);const before=pointers();
const alive=await w.api('batch/submit',{runId:owner,epoch,items:[{filmId:resumed.films[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});
assert.equal(alive.status,200,JSON.stringify(alive.data).slice(0,300));assert.equal(alive.data.results[0].status,'created');assert.equal(pointers(),before+1);near(lease().expiresAt-Date.now(),TTL);
// Silence past the TTL (12.5 minutes): the owner has lost the lease. Its heartbeat and a late submit are fenced and write nothing; one start takes over with epoch + 1; the owner's run, which learned of the loss through its heartbeat, is partial with lease_lost and keeps its committed film.
elapse(12.5);const frozen=pointers();
assert.equal((await w.api('heartbeat',{runId:owner})).status,409);
const stale=await w.api('batch/submit',{runId:owner,epoch,items:[{filmId:resumed.films[1].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});assert.notEqual(stale.status,200);assert.equal(pointers(),frozen,'the fenced late submit wrote nothing');
const second=(await start()).data;assert.equal(second.status,'running');assert.equal(second.lease.epoch,epoch+1);assert.equal(lease().runId,second.runId);
assert.equal(run(owner).status,'partial','the owner that learned of the loss settles its own run honestly');assert.equal(run(owner).stopReason,'lease_lost');assert.equal(run(owner).results[resumed.films[0].filmId],'created');assert.ok(!second.films.some(f=>f.filmId===resumed.films[0].filmId),'the film saved by the owner is not selected again');
// The replaced owner cannot commit even a film the new owner has not settled, and the new owner's lease is untouched by it.
const rival=await w.api('batch/submit',{runId:owner,epoch,items:[{filmId:second.films[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});assert.notEqual(rival.status,200);assert.equal(pointers(),frozen);assert.equal(lease().runId,second.runId);
console.log('Lease recovery (batch v2): 12-minute TTL renewed by heartbeat (every start, submit and heartbeat), alive at 11 minutes of silence, kept across 30 simulated minutes by 5-minute heartbeats, lost after 12.5 minutes with the stale owner fenced and nothing committed twice, already_running while held, one atomic takeover of an expired lease with epoch + 1, interrupted recoverable predecessor, no expired-stop Event, saved forecast reused and stale-owner heartbeat, submit and completion fenced passed');
