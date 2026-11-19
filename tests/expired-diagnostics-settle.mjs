// AIR-415 / AIR-486: expired run diagnostics are settled eventually, one small list page per authorized complete, with a durable resume cursor; a start
// never walks the history. Since ADR 0167 the runs are batch runner v2 runs over D1 prediction authority, as production runs them; the run records are D1 rows
// and the diagnostic rows, the settle cursor and the lease mirror stay in R2. Local stand-ins only.
import vm from 'node:vm';import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
const w=await flowWorld({films:2});
const records=w.records,env=w.env,ctx=w.ctx;ctx.env=env;
let writes=[],listFail=false,getFailKey='',putFailKey='',runSaveFail='',skipDiagnosticPuts=false;
{const bucket=env.BUCKET,get=bucket.get,put=bucket.put;
 bucket.get=async key=>{if(getFailKey&&key.includes(getFailKey))throw new Error('diagnostic get interrupted');return get.call(bucket,key);};
 bucket.put=async(key,value,options)=>{
  if(putFailKey&&key===putFailKey)throw new Error('diagnostic put interrupted');
  if(skipDiagnosticPuts&&key.startsWith('enrichment/run-diagnostics/')&&key!=='enrichment/run-diagnostics-settle.json')return {etag:'skipped'};
  const saved=await put.call(bucket,key,value,options);if(saved)writes.push(key);return saved;};
 bucket.list=async({prefix='',limit=1000,cursor}={})=>{
  if(listFail&&prefix.startsWith('enrichment/run-diagnostics'))throw new Error('diagnostic list interrupted');
  const keys=[...records.keys()].filter(k=>k.startsWith(prefix)).sort();
  let start=0;if(cursor){const i=keys.indexOf(cursor);start=i<0?keys.length:i+1;}
  const slice=keys.slice(start,start+limit);
  return {objects:slice.map(key=>({key})),truncated:start+slice.length<keys.length,cursor:slice.at(-1)||cursor||null};};}
// A D1 run-record write that fails: the way an interrupted settle of the expired run is simulated.
{const original=ctx.PredictionD1;ctx.PredictionD1={...original,saveMutable:async(...a)=>{if(runSaveFail&&a[1]===runSaveFail)throw new Error('run save interrupted');return original.saveMutable(...a);}};}
const call=code=>vm.runInContext(code,ctx);
const api=async(path,body,method='POST')=>{const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};};
let clockTime=Date.now();class Clock extends Date{constructor(...args){super(...(args.length?args:[clockTime]));}static now(){return clockTime;}}ctx.Date=Clock;
assert.equal((await api('queue/reconcile',{})).status,200);
const runRow=id=>{const row=sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+id+"'")[0];return row?JSON.parse(row.d):null;};
const lease=()=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);
const prefix=call('RUN_DIAGNOSTICS_PREFIX'),settleKey=call('RUN_DIAGNOSTICS_SETTLE_KEY'),limit=call('RUN_DIAGNOSTICS_SETTLE_LIMIT');
assert.equal(limit,10);
const diagnosticKey=(id,at)=>call('diagnosticKey('+JSON.stringify(id)+','+JSON.stringify(at)+')');
const stale=new Date(clockTime-60*60000).toISOString();
function plantCompleted(n){
 for(let i=0;i<n;i++){
  const at=new Date(clockTime-(i+1)*60000).toISOString(),id='hist-'+String(i).padStart(4,'0');
  records.set(diagnosticKey(id,at),{runId:id,state:'completed',startedAt:at,endedAt:at,leaseExpiredAt:at,leaseAcquiredAt:at,stopReason:'queue_empty'});
 }
}
const expiredId='hist-expired';
const expiredKey=diagnosticKey(expiredId,'2020-01-01T00:00:00.000Z');
plantCompleted(491);
records.set(expiredKey,{runId:expiredId,state:'running',startedAt:'2020-01-01T00:00:00.000Z',leaseAcquiredAt:stale,leaseExpiredAt:stale});
{const stored={runId:expiredId,protocol:'batch_v2',status:'running',createdAt:'2020-01-01T00:00:00.000Z',selectedIds:[],results:{},failures:{}};sql(w.file,"INSERT INTO prediction_run (run_id, latest, updated_at, document_json) VALUES ('"+expiredId+"', 0, '"+stored.createdAt+"', '"+JSON.stringify(stored).replace(/'/g,"''")+"')");}
const sorted=[...records.keys()].filter(k=>k.startsWith(prefix)).sort();
assert.ok(sorted.length>=492);assert.ok(sorted.indexOf(expiredKey)>=limit,'expired diagnostic is beyond the first settle page');

const startRun=async()=>{clockTime+=1000;const r=await api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:1});assert.equal(r.data.status,'running',JSON.stringify(r.data).slice(0,300));return r.data;};
const complete=async(runId)=>api('complete',{runId,reason:'quota'});
const replayComplete=async(runId)=>api('complete',{runId,reason:'quota'});

writes.length=0;const first=await startRun();
assert.equal(runRow(expiredId).status,'running','start does not walk historic diagnostics');
assert.equal(records.get(settleKey),undefined,'start writes no settle cursor');
assert.equal(writes.filter(k=>k===expiredKey||k==='enrichment/runs/'+expiredId+'.json').length,0);

listFail=true;const failedList=await complete(first.runId);assert.equal(failedList.status,200,'list failure does not fail complete');
assert.equal(records.get(settleKey),undefined);assert.equal(runRow(expiredId).status,'running');
assert.ok(['complete','partial'].includes(failedList.data.status),failedList.data.status);listFail=false;

const second=await startRun();
getFailKey='-hist-0000.json';
const failedGet=await complete(second.runId);assert.equal(failedGet.status,200,'get failure does not fail complete');
assert.equal(records.get(settleKey),undefined);getFailKey='';

const third=await startRun();const thirdDone=await complete(third.runId);
assert.ok(records.get(settleKey)?.cursor,'a successful complete advances the settle cursor');
const replayThird=await replayComplete(third.runId);
assert.equal(replayThird.status,200);assert.equal(replayThird.data.status,thirdDone.data.status,'already-complete remains idempotent');
assert.equal(runRow(expiredId).status,'running','ten rows do not yet reach the expired key');
const afterThird=records.get(settleKey).cursor;

putFailKey=settleKey;const fourth=await startRun();const failedPut=await complete(fourth.runId);
assert.equal(failedPut.status,200,'put failure does not fail complete');
assert.equal(records.get(settleKey).cursor,afterThird,'put failure leaves the cursor in place');
putFailKey='';runSaveFail='enrichment/runs/'+expiredId+'.json';
const fifth=await startRun();const failedRunPut=await complete(fifth.runId);
assert.equal(failedRunPut.status,200);assert.equal(runRow(expiredId).status,'running');
runSaveFail='';

const live=await startRun();
const liveDiagKey=[...records.keys()].find(k=>k.startsWith(prefix)&&k.endsWith('-'+live.runId+'.json'));
assert.ok(liveDiagKey);
const staleDiagExpiry=records.get(liveDiagKey).leaseExpiredAt;
skipDiagnosticPuts=true;
clockTime+=11*60000;
const beat=await api('heartbeat',{runId:live.runId});
skipDiagnosticPuts=false;
assert.equal(beat.status,200,JSON.stringify(beat.data).slice(0,300));
assert.equal(records.get(liveDiagKey).leaseExpiredAt,staleDiagExpiry,'heartbeat lease renew without diagnostic checkpoint');
clockTime+=2*60000;
const sweepDuringGap=await replayComplete(first.runId);
assert.equal(sweepDuringGap.status,200);
assert.equal(runRow(live.runId).status,'running','live holder is not interrupted by a stale diagnostic timestamp');
assert.equal(records.get(liveDiagKey).state,'running');
assert.equal(lease().runId,live.runId);
await complete(live.runId);

let pages=0;
while(runRow(expiredId).status==='running'&&pages<80){
 pages++;
 const run=await startRun();
 await complete(run.runId);
}
assert.equal(runRow(expiredId).status,'interrupted','route-level completes walk the cursor to the expired row');
assert.equal(runRow(expiredId).stopReason,'lease_expired');
const projected=call('projectedDiagnostic('+JSON.stringify(records.get(expiredKey))+')');
assert.equal(projected.state,'interrupted');assert.equal(projected.stopReason,'lease_expired');

const cursorAfterSettle=records.get(settleKey)?.cursor;
const sixth=await startRun();await complete(sixth.runId);
assert.equal(runRow(expiredId).status,'interrupted');
assert.equal(runRow(expiredId).stopReason,'lease_expired','already-settled rows stay settled');

records.delete(settleKey);
const wrapRun=await startRun();await complete(wrapRun.runId);
assert.ok(records.get(settleKey)?.cursor||records.get(settleKey)?.cursor===null);
let wrap=0;
while(records.get(settleKey)?.cursor&&wrap<80){wrap++;const run=await startRun();await complete(run.runId);}
assert.equal(records.get(settleKey).cursor,null,'last page stores a null cursor');
const wrapAgain=await startRun();await complete(wrapAgain.runId);
assert.ok(records.get(settleKey).cursor,'the next complete lists from the start of the prefix again');

console.log('Expired diagnostic settle (batch v2): start skips history; complete pages via the route, list/get/put errors do not fail complete, live lease holder is fenced, settled rows are idempotent, cursor wraps');
