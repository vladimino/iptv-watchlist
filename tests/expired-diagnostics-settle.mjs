import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,writes=[],listFail=false,getFailKey='';
const env={BUCKET:{
 async get(key){if(getFailKey&&key===getFailKey)throw new Error('diagnostic get interrupted');return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));writes.push(key);return {etag:etags.get(key)};},
 async list({prefix='',limit=1000,cursor}={}){
  if(listFail)throw new Error('diagnostic list interrupted');
  const keys=[...records.keys()].filter(k=>k.startsWith(prefix)).sort();
  let start=0;if(cursor){const i=keys.indexOf(cursor);start=i<0?keys.length:i+1;}
  const slice=keys.slice(start,start+limit);
  return {objects:slice.map(key=>({key})),truncated:start+slice.length<keys.length,cursor:slice.at(-1)||cursor||null};
 }
}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
ctx.env=env;const call=(code)=>vm.runInContext(code,ctx);
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()}}
const film=(id,start)=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,'')||id,genres:[],actors:[],directors:[],shows:[{start}]});
let clockTime=Date.parse('2026-10-12T10:00:00Z');class Clock extends Date{constructor(...args){super(...(args.length?args:[clockTime]));}static now(){return clockTime;}}ctx.Date=Clock;
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});records.set('sync.json',{runId:'test',stage:'complete'});
records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',{tmdb_1:film('tmdb_1',clockTime),tmdb_2:film('tmdb_2',clockTime)});
const prefix=call('RUN_DIAGNOSTICS_PREFIX'),settleKey=call('RUN_DIAGNOSTICS_SETTLE_KEY'),limit=call('RUN_DIAGNOSTICS_SETTLE_LIMIT');
assert.equal(limit,100);
const diagnosticKey=(id,at)=>call('diagnosticKey('+JSON.stringify(id)+','+JSON.stringify(at)+')');
const stale=new Date(clockTime-60*60000).toISOString();
const expiredId='hist-expired';
const expiredKey=diagnosticKey(expiredId,'2020-01-01T00:00:00.000Z');
for(let i=0;i<110;i++){
 const at=new Date(clockTime-i*60000).toISOString(),id='hist-'+String(i).padStart(3,'0');
 records.set(diagnosticKey(id,at),{runId:id,state:'completed',startedAt:at,endedAt:at,leaseExpiredAt:at,leaseAcquiredAt:at,stopReason:'queue_empty'});
}
records.set(expiredKey,{runId:expiredId,state:'running',startedAt:'2020-01-01T00:00:00.000Z',leaseAcquiredAt:stale,leaseExpiredAt:stale});
records.set('enrichment/runs/'+expiredId+'.json',{runId:expiredId,status:'running',createdAt:'2020-01-01T00:00:00.000Z',selectedIds:[],results:{},failures:{}});
const sorted=[...records.keys()].filter(k=>k.startsWith(prefix)).sort();
assert(sorted.length>=111);assert.equal(sorted.indexOf(expiredKey)>=limit,true,'expired diagnostic is beyond the first settle page');

const startRun=async()=>{clockTime+=1000;return (await api('start',{scope:'watchlist_all',trigger:'scheduled'})).data;};
const complete=async(runId)=>{const n=(await api('next',{runId,batchSize:1})).data;if(n.mustComplete){await api('complete',{runId,reason:n.stopReason||'quota'});return;}await api('complete',{runId,reason:'quota'});};

writes.length=0;listFail=true;let first=await startRun();assert.equal(first.status,'running');assert.equal(records.get('enrichment/runs/'+expiredId+'.json').status,'running');assert.equal(records.get(settleKey),undefined);listFail=false;await complete(first.runId);

writes.length=0;getFailKey=sorted[0];first=await startRun();assert.equal(first.status,'running');assert.equal(records.get('enrichment/runs/'+expiredId+'.json').status,'running');assert.equal(records.get(settleKey),undefined);getFailKey='';await complete(first.runId);

writes.length=0;first=await startRun();assert.equal(first.status,'running');assert.equal(records.get('enrichment/runs/'+expiredId+'.json').status,'running');
const cursor=records.get(settleKey);assert.ok(cursor?.cursor);assert.equal(writes.filter(k=>k===expiredKey||k==='enrichment/runs/'+expiredId+'.json').length,0);
const projected=call('projectedDiagnostic('+JSON.stringify(records.get(expiredKey))+')');
assert.equal(projected.state,'interrupted');assert.equal(projected.stopReason,'lease_expired');
assert.equal(records.get(expiredKey).state,'running');
await complete(first.runId);

writes.length=0;const second=await startRun();assert.equal(second.status,'running');
assert.equal(records.get('enrichment/runs/'+expiredId+'.json').status,'interrupted');
assert.equal(records.get('enrichment/runs/'+expiredId+'.json').stopReason,'lease_expired');
const settledWrites=writes.filter(k=>k===expiredKey||k==='enrichment/runs/'+expiredId+'.json');
assert.ok(settledWrites.length>=1);
await complete(second.runId);

writes.length=0;const third=await startRun();assert.equal(third.status,'running');
assert.equal(writes.filter(k=>k===expiredKey||k==='enrichment/runs/'+expiredId+'.json').length,0,'already-settled rows are not rewritten');
await complete(third.runId);

console.log('Expired diagnostic settle: one page per start, resume past 100, list/get errors do not block admission, settled rows are idempotent');
