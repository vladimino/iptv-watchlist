// AIR-548 (ADR 0180): a real batch v2 `batch_start` turned away by a live runner lease leaves exactly one neutral `batch_v2_skipped` Event, on both refusal paths
// (the early lease check and the lease acquire). Covered: one Event per distinct request, a replayed request id is one journal item with the same time, a different
// request id is another Event, 409 / dry run / lease statuses other than `already_running` write none, the answer and the stored runner are untouched, a journal outage
// never changes the answer and is recovered by the outbox of the next successful start, and the successful runner keeps its single terminal Event. Local stand-ins only.
import vm from 'node:vm';import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
const w=await flowWorld({films:8});assert.equal((await w.api('queue/reconcile',{})).status,200);
const records=w.records,env=w.env,ctx=w.ctx;ctx.env=env;
let blocked=()=>false;
let lostAck=()=>false,headDown=false;
{const bucket=env.BUCKET,put=bucket.put,head=bucket.head;
 bucket.put=async(key,value,options)=>{if(blocked(key,options))throw new Error('storage outage');const saved=await put.call(bucket,key,value,options);if(lostAck(key))throw new Error('acknowledgement lost');return saved;};
 bucket.head=async key=>{if(headDown)throw new Error('head outage');return head.call(bucket,key);};
 bucket.delete=async key=>{records.delete(key);};
 bucket.list=async({prefix=''})=>({objects:[...records.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false});}
const call=code=>vm.runInContext(code,ctx);
const api=async(path,body,{method='POST',requestId=null}={})=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json',...(requestId?{'X-Request-Id':requestId}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};};
const STOP=call('STOP_EVENT_PREFIX'),OUTBOX=call('EVENT_OUTBOX_KEY');
const journal=()=>[...records].filter(([key])=>key.startsWith('events/items/')).map(([,value])=>value);
const skipped=()=>journal().filter(event=>event.presentation==='batch_v2_skipped');
const start=(requestId,extra={})=>api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:2,...extra},{requestId});
// Invariant (review of PR #805): a parked, undelivered skipped record always has an outbox index entry, so it can never be orphaned.
const orphans=()=>[...records].filter(([k,v])=>k.startsWith(STOP+'skipped-')&&!v.delivered&&!(records.get(OUTBOX)?.pending||{})[k]).map(([k])=>k);
const filmTables=()=>JSON.stringify(sql(w.file,'SELECT * FROM prediction_run'))+JSON.stringify(sql(w.file,"SELECT * FROM prediction_lease"))+JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue'));

// 1. A live holder turns the request away: the answer is the existing one, one neutral Event is in the journal, the stored runner is unchanged.
const holder=await start('req-holder');assert.equal(holder.data.status,'running');const runId=holder.data.runId;
assert.equal(skipped().length,0,'a successful start writes no skipped Event');
const state0=filmTables();
const first=await start('req-skip-1');
assert.equal(first.status,200);assert.equal(first.data.status,'already_running');assert.equal(first.data.runId,runId);assert.ok(!first.data.films);
assert.equal(filmTables(),state0,'a skipped start changes no run, lease or queue');
{const events=skipped();assert.equal(events.length,1,'one Event');const e=events[0];
 assert.equal(e.id,'enrichment-skipped-req-skip-1');assert.equal(e.type,'enrichment');assert.equal(e.stage,'skipped');assert.equal(e.reason,'already_running');assert.equal(e.protocol,'batch_v2');
 assert.equal(e.requestId,'req-skip-1');assert.equal(e.trigger,'scheduled');assert.equal(e.holderRunId,runId);assert.ok(Number.isFinite(e.holderAgeMs)&&e.holderAgeMs>=0);
 assert.ok(!('runId' in e)&&!('added' in e)&&!('processed' in e)&&!('details' in e)&&!('queueSchemaVersion' in e),'no run identity and no processed count is claimed');
 assert.ok(Number.isFinite(Date.parse(e.at)));
 assert.equal(records.get(STOP+'skipped-req-skip-1.json').delivered,true,'the durable record is delivered');
 assert.deepEqual(Object.keys(records.get(OUTBOX)?.pending||{}),[],'a delivered Event leaves nothing in the outbox index');
 // GET /api/events returns it and writes nothing
 const before=records.size,read=await ctx.worker.fetch(new Request('https://site.example/api/events'),env),body=await read.json();
 assert.equal(read.status,200);assert.ok((body.events||body).some(x=>x.id===e.id&&x.presentation==='batch_v2_skipped'));assert.equal(records.size,before,'the read writes nothing');}

// 2. Replay: the same request id is one journal item with the same time; another request id is another Event.
{const at=skipped()[0].at;
 const again=await start('req-skip-1');assert.equal(again.data.status,'already_running');
 assert.equal(skipped().length,1,'a replayed request id is not a second Event');assert.equal(skipped()[0].at,at,'the first record is read back: same time, same journal key');
 assert.equal([...records.keys()].filter(k=>k.startsWith('events/items/')&&k.endsWith('-enrichment-skipped-req-skip-1.json')).length,1);
 const other=await start('req-skip-2',{trigger:'manual'});assert.equal(other.data.status,'already_running');
 const events=skipped();assert.equal(events.length,2,'a different request id is not merged');assert.deepEqual(events.map(e=>e.requestId).sort(),['req-skip-1','req-skip-2']);
 assert.equal(events.find(e=>e.requestId==='req-skip-2').trigger,'manual');}

// 3. Not a skipped start: a dry run beside a live run, a refusal with 409 and a lease status other than already_running write no skipped Event.
{const before=skipped().length;
 const dry=await start('req-dry',{dryRun:true});assert.ok(['running','dry_run'].includes(dry.data.status)||dry.data.dryRun===true||dry.status===409,JSON.stringify(dry.data).slice(0,160));
 const bad=await api('batch/start',{scope:'watchlist_all',mode:'queued',manifestSize:-1},{requestId:'req-bad'});assert.ok(bad.status>=400);
 assert.equal(skipped().length,before,'a dry run and a rejected body write no skipped Event');}

// 4. The journal is down: the answer is the same already_running, the record is parked and noted, and the next successful start delivers it.
{blocked=key=>key.startsWith('events/items/');
 const out=await start('req-outage');assert.equal(out.status,200);assert.equal(out.data.status,'already_running');assert.equal(out.data.runId,runId,'a journal outage never changes the answer');
 blocked=()=>false;
 assert.equal(skipped().some(e=>e.requestId==='req-outage'),false,'not in the journal yet');
 const record=records.get(STOP+'skipped-req-outage.json');assert.ok(record&&record.event.presentation==='batch_v2_skipped'&&record.delivered===undefined,'parked, undelivered');
 assert.ok(records.get(OUTBOX)?.pending?.[STOP+'skipped-req-outage.json'],'noted in the outbox');
 // the holder ends: its terminal Event is the only Event of the run, and the next start delivers the parked skipped one
 assert.equal((await api('complete',{runId,reason:'quota'})).status,200);
 const terminal=journal().filter(e=>e.id==='enrichment-'+runId);assert.equal(terminal.length,1,'the successful runner keeps one terminal Event');
 const next=await start('req-next');assert.equal(next.data.status,'running',JSON.stringify(next.data).slice(0,160));
 const recovered=skipped().filter(e=>e.requestId==='req-outage');assert.equal(recovered.length,1,'recovered through the outbox');assert.equal(recovered[0].at,record.event.at,'same time as parked');
 assert.equal(records.get(STOP+'skipped-req-outage.json').delivered,true);assert.equal(records.get(OUTBOX)?.pending?.[STOP+'skipped-req-outage.json'],undefined,'it left the outbox');
 assert.equal(journal().filter(e=>e.id==='enrichment-'+runId).length,1,'still one terminal Event');
 assert.equal((await api('complete',{runId:next.data.runId,reason:'quota'})).status,200);}

// 5. The lease acquire path: no live lease at the early check, the lease refuses `already_running` at the acquire (a competing start won the race).
{const original=ctx.runnerLease,before=skipped().length;
 ctx.runnerLease=async(e,id,operation)=>operation==='acquire'?{status:'already_running',runId:'11111111-2222-4333-8444-555555555555',expiresAt:Date.now()+60000}:original(e,id,operation);
 try{const raced=await start('req-acquire');assert.equal(raced.status,200);assert.equal(raced.data.status,'already_running');assert.equal(raced.data.runId,'11111111-2222-4333-8444-555555555555');}finally{ctx.runnerLease=original;}
 const events=skipped();assert.equal(events.length,before+1,'the acquire-time refusal is recorded too');
 const e=events.find(x=>x.requestId==='req-acquire');assert.equal(e.holderRunId,'11111111-2222-4333-8444-555555555555');assert.equal(e.reason,'already_running');
 // any other lease status keeps its own answer and writes no Event
 ctx.runnerLease=async(e2,id,operation)=>operation==='acquire'?{status:'lease_lost'}:original(e2,id,operation);
 try{const lost=await start('req-lost');assert.equal(lost.data.status,'lease_lost');}finally{ctx.runnerLease=original;}
 assert.equal(skipped().length,before+1,'a status other than already_running is not a skipped start');}

// 6. Review of PR #805, failures of the journal, the outbox index and the park: the answer is unchanged, no record is orphaned, and no request id ever produces two journal items.
{
 assert.deepEqual(orphans(),[]);
 const h2=await start('req-h2');assert.equal(h2.data.status,'running',JSON.stringify(h2.data).slice(0,160));
 blocked=key=>key.startsWith('events/items/')||key===OUTBOX;
 const dual=await start('req-dual');assert.equal(dual.status,200);assert.equal(dual.data.status,'already_running');assert.equal(dual.data.runId,h2.data.runId);
 blocked=()=>false;
 assert.equal(records.has(STOP+'skipped-req-dual.json'),false,'an unindexed record whose delivery failed is removed again');assert.deepEqual(orphans(),[],'no orphaned record');
 assert.equal(skipped().some(e=>e.requestId==='req-dual'),false,'the limitation: journal and index both down loses this one Event, never the answer');
 // the index alone is down (review of PR #805, round 2): the record is still parked, the Event is journaled once and marked delivered, and a REPLAY of the same request id after the
 // index recovers, at a different clock millisecond, is still one journal item under the same key.
 blocked=key=>key===OUTBOX;const idx=await start('req-index-down');blocked=()=>false;assert.equal(idx.data.status,'already_running');
 {const stored=skipped().filter(e=>e.requestId==='req-index-down');assert.equal(stored.length,1,'journaled once');
  const parked=records.get(STOP+'skipped-req-index-down.json');assert.ok(parked&&parked.delivered===true&&parked.event.at===stored[0].at,'the record persisted the identity and the time');
  const keys=()=>[...records.keys()].filter(k=>k.startsWith('events/items/')&&k.endsWith('-enrichment-skipped-req-index-down.json'));
  const before=keys();assert.equal(before.length,1);
  await new Promise(r=>setTimeout(r,25));
  const replay=await start('req-index-down');assert.equal(replay.data.status,'already_running');
  assert.deepEqual(keys(),before,'the replay of the same request id wrote no second journal item and no new key');
  assert.equal(skipped().filter(e=>e.requestId==='req-index-down').length,1);assert.deepEqual(orphans(),[]);}
 // the index AND the journal are down for a request that is replayed after recovery: nothing was recorded, so the replay records it once
 blocked=key=>key.startsWith('events/items/')||key===OUTBOX;await start('req-dual-replay');blocked=()=>false;
 assert.equal(records.has(STOP+'skipped-req-dual-replay.json'),false,'the unindexed record was removed again');assert.equal(skipped().some(e=>e.requestId==='req-dual-replay'),false);
 await start('req-dual-replay');assert.equal(skipped().filter(e=>e.requestId==='req-dual-replay').length,1,'a replay after recovery records it exactly once');assert.deepEqual(orphans(),[]);
 // Review of PR #805, round 3: ambiguous journal outcomes must never lead to a second journal key for one request id.
 const itemKeys=id=>[...records.keys()].filter(k=>k.startsWith('events/items/')&&k.endsWith('-enrichment-skipped-'+id+'.json'));
 const replayOnce=async id=>{await new Promise(r=>setTimeout(r,25));const r=await start(id);assert.equal(r.data.status,'already_running');};
 // (a) index down; park and journal put succeed; EVERY `delivered` marker write fails: the item exists, the identity record is kept (never deleted), the replay reuses it
 {const id='req-amb-marker',rk=STOP+'skipped-'+id+'.json';
  blocked=(key,options)=>key===OUTBOX||(key===rk&&!options?.onlyIf);const first=await start(id);blocked=()=>false;assert.equal(first.data.status,'already_running');
  const before=itemKeys(id);assert.equal(before.length,1,'journaled once');const parked=records.get(rk);assert.ok(parked&&!parked.delivered,'the identity record is kept, marker not written');
  await replayOnce(id);assert.deepEqual(itemKeys(id),before,'the replay after recovery wrote no second journal key');assert.equal(records.get(rk).delivered,true,'the replay completed the marker');assert.equal(skipped().filter(e=>e.requestId===id).length,1);}
 // (b) index down; the journal put PERSISTS but its acknowledgement is lost (the write looks failed): a head proves the item present, so the record is kept and marked, never deleted
 {const id='req-amb-lostack',rk=STOP+'skipped-'+id+'.json';
  blocked=key=>key===OUTBOX;lostAck=key=>key.startsWith('events/items/')&&key.endsWith('-enrichment-skipped-'+id+'.json');const first=await start(id);blocked=()=>false;lostAck=()=>false;assert.equal(first.data.status,'already_running');
  const before=itemKeys(id);assert.equal(before.length,1);assert.equal(records.get(rk)?.delivered,true,'the item exists, so the record is kept and marked delivered');
  await replayOnce(id);assert.deepEqual(itemKeys(id),before,'one journal key after the replay');}
 // (c) index down; the journal put fails AND the head fails: the outcome is unknown, the record is kept (replay-safe); a replay after recovery reuses its `at`
 {const id='req-amb-unknown',rk=STOP+'skipped-'+id+'.json';
  blocked=key=>key===OUTBOX||key.startsWith('events/items/');headDown=true;const first=await start(id);blocked=()=>false;headDown=false;assert.equal(first.data.status,'already_running');
  const kept=records.get(rk);assert.ok(kept&&!kept.delivered,'an unknown outcome keeps the identity record');assert.equal(itemKeys(id).length,0);
  await replayOnce(id);assert.equal(itemKeys(id).length,1,'the replay journals it once');assert.equal(skipped().find(e=>e.requestId===id).at,kept.event.at,'with the identity of the first attempt');}
 // the park alone fails after the index entry: journaled directly, the entry is `absent` and leaves the index at the next sweep
 blocked=key=>key===STOP+'skipped-req-park-down.json';const pd=await start('req-park-down');blocked=()=>false;assert.equal(pd.data.status,'already_running');
 assert.equal(skipped().some(e=>e.requestId==='req-park-down'),false,'a failed park writes no journal item (no identity to deduplicate on)');assert.deepEqual(orphans(),[]);
 // the journal is down, the index works: parked and indexed; a LATER start with a different request id delivers it
 blocked=key=>key.startsWith('events/items/');const down=await start('req-journal-down');blocked=()=>false;assert.equal(down.data.status,'already_running');
 assert.ok(records.get(OUTBOX)?.pending?.[STOP+'skipped-req-journal-down.json'],'indexed');assert.equal(skipped().some(e=>e.requestId==='req-journal-down'),false);assert.deepEqual(orphans(),[]);
 assert.equal((await api('complete',{runId:h2.data.runId,reason:'quota'})).status,200);
 const later=await start('req-later');assert.equal(later.data.status,'running');
 assert.equal(skipped().filter(e=>e.requestId==='req-journal-down').length,1,'recovered by a later start with another request id');
 assert.deepEqual(Object.keys(records.get(OUTBOX)?.pending||{}),[],'every entry settled, the absent one included');assert.deepEqual(orphans(),[]);
 assert.equal((await api('complete',{runId:later.data.runId,reason:'quota'})).status,200);
}

console.log('Skipped Predictions start (AIR-548): one neutral Event per refused request on both paths, replay is one item, another request id is another, dry run, 409 and other lease statuses write none, a journal outage never changes the answer and the outbox recovers it, the runner keeps one terminal Event.');
