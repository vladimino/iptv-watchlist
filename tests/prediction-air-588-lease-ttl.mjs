// AIR-588 (owner containment, 24 Nov 2026): the runner lease TTL is 12 minutes for the four quarter-hour Tasks. Offline: the real Worker over a sqlite D1 stand-in and an
// in-memory R2, labelled Task starts as production runs them. Elapsed silence is simulated by moving the stored lease (expiry and its last write) back in time; every renewal,
// refusal, takeover and fence below is the real code on the real clock. No production call, no Scheduled Task, no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const MIN=60000,TTL=12*MIN;
const near=(value,expected,slack=5000,label='')=>assert.ok(Math.abs(value-expected)<=slack,label+' '+value+' is not about '+expected);
const make=async(films=12)=>{
 const w=await flowWorld({films});assert.equal((await w.api('queue/reconcile',{})).status,200);
 const lease=()=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);
 const write=doc=>sql(w.file,"UPDATE prediction_lease SET expires_at="+Number(doc.expiresAt)+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");
 // `minutes` of silence since the lease's last write, which was made under `ttl` (the TTL of the Worker that wrote it)
 const silence=(minutes,ttl=TTL)=>{const doc=lease(),at=Date.now()-minutes*MIN;doc.heartbeatAt=new Date(at).toISOString();doc.expiresAt=at+ttl;write(doc);};
 const start=(taskId,extra={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:3,taskId,...extra});
 const pointers=()=>sql(w.file,'SELECT COUNT(*) AS n FROM prediction_pointer')[0].n;
 const run=id=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+id+"'")[0].d);
 const timing=()=>w.logs.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(l=>l?.event==='prediction_step_timing'&&l.step==='batch_start').at(-1);
 const skippedFor=holder=>[...w.records].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v).filter(e=>e?.presentation==='batch_v2_skipped'&&e.holderRunId===holder);
 const item=film=>({filmId:film.filmId,...(film.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction});
 return {w,lease,write,silence,start,pointers,run,timing,skippedFor,item};
};

// 0. The constant, the published contract, the start answer and the MCP description say 12 minutes; the other clocks are unchanged.
{
 const t=await make();const {w}=t;
 assert.equal(vm.runInContext('RUNNER_LEASE_TTL',w.ctx),TTL);
 for(const [name,value] of [['START_CLAIM_TTL_MS',180000],['READY_LEASE_TTL_MS',180000],['BATCH_GATE_TTL_MS',60000],['PRIORITY_WINDOW_REEVAL_MS',15*MIN],['ORDERING_MAX_LAG_MS',90*MIN]])assert.equal(vm.runInContext(name,w.ctx),value,name+' unchanged');
 const contract=JSON.parse(JSON.stringify(vm.runInContext('predictionRunnerContract()',w.ctx)));
 assert.equal(contract.leaseTtlMs,720000);assert.ok(contract.instructions.some(line=>/Lease TTL is 12 minutes/.test(line)),'the runner instructions name 12 minutes');
 assert.ok(!JSON.stringify(contract).includes('Lease TTL is 15'));
 const r=await t.start('task00');assert.equal(r.data.status,'running');assert.equal(r.data.lease.ttlMs,720000);near(r.data.lease.expiresAt-Date.now(),TTL,5000,'start expiry');
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 const heartbeat=vm.runInContext('MCP_TOOLS',w.ctx).find(tool=>tool.name==='prediction_heartbeat');
 assert.match(heartbeat.description,/12-minute lease/);assert.match(heartbeat.description,/at least every 5 minutes/);
}

// 1. Before the expiry the owner keeps the run: heartbeat, hold and submit after 11 minutes of silence each restore a full 12 minutes and keep the epoch; 5-minute heartbeats keep a run
// alive for 30 simulated minutes while every rival Task is turned away.
{
 const t=await make();const {w}=t;
 const m=(await t.start('task00')).data;assert.equal(m.status,'running');const epoch=m.lease.epoch;
 t.silence(11);assert.equal((await t.start('task15')).data.status,'already_running','11 minutes of silence: still the owner');
 let beat=await w.api('heartbeat',{runId:m.runId});assert.equal(beat.status,200);assert.equal(beat.data.epoch,epoch);near(t.lease().expiresAt-Date.now(),TTL,5000,'heartbeat renewal');
 for(let i=0;i<6;i++){t.silence(5);assert.equal((await t.start(i%2?'task30':'task45')).data.status,'already_running','round '+i);beat=await w.api('heartbeat',{runId:m.runId});assert.equal(beat.status,200);assert.equal(beat.data.epoch,epoch);near(t.lease().expiresAt-Date.now(),TTL,5000,'5-minute heartbeat');}
 t.silence(11);
 const hold=await w.api('batch/hold',{runId:m.runId,epoch,items:[t.item(m.films[0])]});assert.equal(hold.status,200,JSON.stringify(hold.data).slice(0,200));near(t.lease().expiresAt-Date.now(),TTL,5000,'hold renewal');
 t.silence(11);const before=t.pointers();
 const sub=await w.api('batch/submit',{runId:m.runId,epoch,items:[t.item(m.films[1])]});
 assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,200));assert.equal(sub.data.results[0].status,'created');assert.equal(t.pointers(),before+1);near(t.lease().expiresAt-Date.now(),TTL,5000,'submit renewal');
 assert.equal(t.lease().runId,m.runId);assert.equal(t.lease().epoch,epoch);
}

// 2. 12.5 minutes of silence: the lease is lost. The owner's heartbeat is refused, its late submit is fenced and writes nothing, the next Task takes over with epoch + 1, and a film
// the first run already committed is not delivered or committed again.
{
 const t=await make();const {w}=t;
 const m=(await t.start('task00')).data;const epoch=m.lease.epoch;
 const sub=await w.api('batch/submit',{runId:m.runId,epoch,items:[t.item(m.films[0])]});assert.equal(sub.data.results[0].status,'created');
 t.silence(12.5);const frozen=t.pointers();
 assert.equal((await w.api('heartbeat',{runId:m.runId})).status,409,'the expired owner cannot renew');
 const late=await w.api('batch/submit',{runId:m.runId,epoch,items:[t.item(m.films[1])]});assert.notEqual(late.status,200);assert.equal(t.pointers(),frozen,'the fenced late submit wrote nothing');
 const next=(await t.start('task15')).data;
 assert.equal(next.status,'running');assert.equal(next.lease.epoch,epoch+1);assert.equal(t.lease().runId,next.runId);assert.equal(t.lease().taskId,'task15');
 assert.ok(!next.films.some(f=>f.filmId===m.films[0].filmId),'a committed film is not delivered again');
 const replay=await w.api('batch/submit',{runId:m.runId,epoch,items:[t.item(m.films[0])]});assert.notEqual(replay.status,200);assert.equal(t.pointers(),frozen,'nothing is committed twice');
}

// 3. The quarter-hour slots. A start that stops after its last write at +1 or +2 minutes frees the runner before the next slot (+15): that slot opens a new run with epoch + 1.
// A run that last wrote at +4 minutes or later still holds it at +15 (already_running): the shorter TTL removes the overlap only for runs that stop early, not every refusal.
{
 for(const [lastWrite,expected] of [[1,'running'],[2,'running'],[2.9,'running'],[4,'already_running'],[10,'already_running']]){
  const t=await make();const m=(await t.start('task00')).data;
  // now is the :15 slot; the abandoned run's last lease write was at :00 + lastWrite, under the 12-minute TTL
  t.silence(15-lastWrite);
  const slot=await t.start('task15');
  assert.equal(slot.data.status,expected,'last write at +'+lastWrite+' min');
  if(expected==='running'){assert.equal(slot.data.lease.epoch,m.lease.epoch+1);assert.notEqual(slot.data.runId,m.runId);}
  else assert.equal(slot.data.runId,m.runId,'the live holder is named');
 }
}

// 4. The transition from the 15-minute Worker: a lease written under 15 minutes keeps its stored expiry (never re-dated to 12); 13 minutes after its write it is still the holder's,
// and the age the refusal reports is the real 13 minutes (from the lease's last write), not 10 (expiry minus the new TTL). Its owner's next write gives it 12 minutes; past its
// stored 15-minute expiry it is taken over as usual.
{
 const t=await make();const {w}=t;
 const m=(await t.start('task00')).data;
 t.silence(13,15*MIN);const stored=t.lease().expiresAt;
 w.logs.length=0;
 const refused=await t.start('task15');assert.equal(refused.data.status,'already_running','a 15-minute lease is not shortened retroactively');assert.ok(!('heartbeatAt' in refused.data),'the answer is unchanged: no holder write time');assert.equal(t.lease().expiresAt,stored,'the stored expiry is untouched by a refusal');
 near(t.timing().notes.liveLeaseAgeMs,13*MIN,5000,'liveLeaseAgeMs on a 15-minute lease');
 const events=t.skippedFor(m.runId);assert.ok(events.length>=1,'a skipped Event names the holder');near(events.at(-1).holderAgeMs,13*MIN,5000,'holderAgeMs on a 15-minute lease');
 assert.equal((await w.api('heartbeat',{runId:m.runId})).status,200);near(t.lease().expiresAt-Date.now(),TTL,5000,'the next write uses 12 minutes');
 t.silence(15.5,15*MIN);
 const next=(await t.start('task30')).data;assert.equal(next.status,'running');assert.equal(next.lease.epoch,m.lease.epoch+1);
}
{
 // a holder whose document carries no heartbeatAt falls back to expiry minus the current TTL
 const t=await make();const {w}=t;
 const m=(await t.start('task00')).data;const doc=t.lease();delete doc.heartbeatAt;doc.expiresAt=Date.now()+TTL-3*MIN;t.write(doc);
 w.logs.length=0;assert.equal((await t.start('task15')).data.status,'already_running');near(t.timing().notes.liveLeaseAgeMs,3*MIN,5000,'fallback age');
 assert.ok(m.runId);
}
console.log('AIR-588 lease TTL 12 min: contract, renewals before expiry, 5-minute heartbeats, expiry and takeover with fences, quarter-hour slots, 15-minute leases kept and aged correctly');
