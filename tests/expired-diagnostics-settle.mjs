import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,writes=[],listFail=false,getFailKey='',putFailKey='',skipDiagnosticPuts=false;
const env={BUCKET:{
 async get(key){if(getFailKey&&key.includes(getFailKey))throw new Error('diagnostic get interrupted');return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  if(putFailKey&&key===putFailKey)throw new Error('diagnostic put interrupted');
  if(skipDiagnosticPuts&&key.startsWith('enrichment/run-diagnostics/')&&key!=='enrichment/run-diagnostics-settle.json')return {etag:'skipped'};
  const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));writes.push(key);return {etag:etags.get(key)};
 },
 async list({prefix='',limit=1000,cursor}={}){
  if(listFail&&prefix.startsWith('enrichment/run-diagnostics'))throw new Error('diagnostic list interrupted');
  const keys=[...records.keys()].filter(k=>k.startsWith(prefix)).sort();
  let start=0;if(cursor){const i=keys.indexOf(cursor);start=i<0?keys.length:i+1;}
  const slice=keys.slice(start,start+limit);
  return {objects:slice.map(key=>({key})),truncated:start+slice.length<keys.length,cursor:slice.at(-1)||cursor||null};
 }
}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,env});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const call=(code)=>vm.runInContext(code,ctx);
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};}
const film=(id,start)=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,'')||id,genres:[],actors:[],directors:[],shows:[{start}]});
let clockTime=Date.parse('2026-10-12T10:00:00Z');class Clock extends Date{constructor(...args){super(...(args.length?args:[clockTime]));}static now(){return clockTime;}}ctx.Date=Clock;
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});records.set('sync.json',{runId:'test',stage:'complete'});
records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',{tmdb_1:film('tmdb_1',clockTime),tmdb_2:film('tmdb_2',clockTime)});
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
records.set('enrichment/runs/'+expiredId+'.json',{runId:expiredId,status:'running',createdAt:'2020-01-01T00:00:00.000Z',selectedIds:[],results:{},failures:{}});
const sorted=[...records.keys()].filter(k=>k.startsWith(prefix)).sort();
assert.ok(sorted.length>=492);assert.ok(sorted.indexOf(expiredKey)>=limit,'expired diagnostic is beyond the first settle page');

const startRun=async()=>{clockTime+=1000;const r=await api('start',{scope:'watchlist_all',trigger:'scheduled'});assert.equal(r.data.status,'running',JSON.stringify(r.data).slice(0,300));return r.data;};
const complete=async(runId)=>{const n=(await api('next',{runId,batchSize:1})).data;if(n.mustComplete)return api('complete',{runId,reason:n.stopReason||'quota'});return api('complete',{runId,reason:'quota'});};
const replayComplete=async(runId)=>api('complete',{runId,reason:'quota'});

writes.length=0;const first=await startRun();
assert.equal(records.get('enrichment/runs/'+expiredId+'.json').status,'running','start does not walk historic diagnostics');
assert.equal(records.get(settleKey),undefined,'start writes no settle cursor');
assert.equal(writes.filter(k=>k===expiredKey||k==='enrichment/runs/'+expiredId+'.json').length,0);

listFail=true;const failedList=await complete(first.runId);assert.equal(failedList.status,200,'list failure does not fail complete');
assert.equal(records.get(settleKey),undefined);assert.equal(records.get('enrichment/runs/'+expiredId+'.json').status,'running');
assert.ok(['complete','partial'].includes(failedList.data.status),failedList.data.status);listFail=false;

const second=await startRun();
getFailKey='-hist-0000.json';
const failedGet=await complete(second.runId);assert.equal(failedGet.status,200,'get failure does not fail complete');
assert.equal(records.get(settleKey),undefined);getFailKey='';

const third=await startRun();const thirdDone=await complete(third.runId);
assert.ok(records.get(settleKey)?.cursor,'a successful complete advances the settle cursor');
const replayThird=await replayComplete(third.runId);
assert.equal(replayThird.status,200);assert.equal(replayThird.data.status,thirdDone.data.status,'already-complete remains idempotent');
assert.equal(records.get('enrichment/runs/'+expiredId+'.json').status,'running','ten rows do not yet reach the expired key');
const afterThird=records.get(settleKey).cursor;

putFailKey=settleKey;const fourth=await startRun();const failedPut=await complete(fourth.runId);
assert.equal(failedPut.status,200,'put failure does not fail complete');
assert.equal(records.get(settleKey).cursor,afterThird,'put failure leaves the cursor in place');
putFailKey='enrichment/runs/'+expiredId+'.json';
const fifth=await startRun();const failedRunPut=await complete(fifth.runId);
assert.equal(failedRunPut.status,200);assert.equal(records.get('enrichment/runs/'+expiredId+'.json').status,'running');
putFailKey='';

const live=await startRun();
const liveDiagKey=[...records.keys()].find(k=>k.startsWith(prefix)&&k.endsWith('-'+live.runId+'.json'));
assert.ok(liveDiagKey);
const staleDiagExpiry=records.get(liveDiagKey).leaseExpiredAt;
skipDiagnosticPuts=true;
clockTime+=14*60000;
const beat=await api('heartbeat',{runId:live.runId});
skipDiagnosticPuts=false;
assert.equal(beat.status,200,JSON.stringify(beat.data).slice(0,300));
assert.equal(records.get(liveDiagKey).leaseExpiredAt,staleDiagExpiry,'heartbeat lease renew without diagnostic checkpoint');
clockTime+=2*60000;
const sweepDuringGap=await replayComplete(first.runId);
assert.equal(sweepDuringGap.status,200);
assert.equal(records.get('enrichment/runs/'+live.runId+'.json').status,'running','live holder is not interrupted by a stale diagnostic timestamp');
assert.equal(records.get(liveDiagKey).state,'running');
assert.equal(records.get('enrichment/runner-lease.json').runId,live.runId);
await complete(live.runId);

let pages=0;
while(records.get('enrichment/runs/'+expiredId+'.json').status==='running'&&pages<80){
 pages++;
 const run=await startRun();
 await complete(run.runId);
}
assert.equal(records.get('enrichment/runs/'+expiredId+'.json').status,'interrupted','route-level completes walk the cursor to the expired row');
assert.equal(records.get('enrichment/runs/'+expiredId+'.json').stopReason,'lease_expired');
const projected=call('projectedDiagnostic('+JSON.stringify(records.get(expiredKey))+')');
assert.equal(projected.state,'interrupted');assert.equal(projected.stopReason,'lease_expired');

const cursorAfterSettle=records.get(settleKey)?.cursor;
const sixth=await startRun();await complete(sixth.runId);
assert.equal(records.get('enrichment/runs/'+expiredId+'.json').status,'interrupted');
assert.equal(records.get('enrichment/runs/'+expiredId+'.json').stopReason,'lease_expired','already-settled rows stay settled');

records.delete(settleKey);
const wrapRun=await startRun();await complete(wrapRun.runId);
assert.ok(records.get(settleKey)?.cursor||records.get(settleKey)?.cursor===null);
let wrap=0;
while(records.get(settleKey)?.cursor&&wrap<80){wrap++;const run=await startRun();await complete(run.runId);}
assert.equal(records.get(settleKey).cursor,null,'last page stores a null cursor');
const wrapAgain=await startRun();await complete(wrapAgain.runId);
assert.ok(records.get(settleKey).cursor,'the next complete lists from the start of the prefix again');

console.log('Expired diagnostic settle: start skips history; complete pages via the route, list/get/put errors do not fail complete, live lease holder is fenced, settled rows are idempotent, cursor wraps');
