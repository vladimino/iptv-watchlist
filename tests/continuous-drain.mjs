import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,failKey='',writes=[];
const env={BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;if(key===failKey){failKey='';throw new Error('Storage checkpoint interrupted')}records.set(key,JSON.parse(value));etags.set(key,String(++revision));writes.push(key);return {etag:etags.get(key)}},list:async()=>({objects:[],truncated:false})}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
ctx.env=env;const call=(code)=>vm.runInContext(code,ctx);
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()}}
const now=Date.now(),film=(id,start,extra={})=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,'')||id,genres:[],actors:[],directors:[],shows:start===null?[]:[{start}],...extra});
const execution=Object.fromEntries(Object.entries(call('EXECUTION')).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']},prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});records.set('sync.json',{runId:'test',stage:'complete'});

ctx.aliasReport={films:[film('alias_one',now,{tmdbId:42}),film('alias_two',now,{tmdbId:42})]};ctx.aliasCatalog={tmdb_42:film('tmdb_42',now,{tmdbId:42})};assert.equal(call('allEnrichmentFilms(aliasReport,aliasCatalog)').length,1);
// Direct compare-and-swap race exercises the persistent lease, independently of the short writer lock.
ctx.firstOwner='race-a';ctx.secondOwner='race-b';
const [l1,l2]=await Promise.all([call("runnerLease(env,firstOwner,'acquire')"),call("runnerLease(env,secondOwner,'acquire')")]);
assert.equal([l1,l2].filter(x=>x.status==='owned').length,1);assert.equal([l1,l2].filter(x=>x.status==='already_running').length,1);
const owner=l1.status==='owned'?'race-a':'race-b';ctx.owner=owner;await call("runnerLease(env,owner,'release')");
// After release a new owner acquires; an expired lease is taken over atomically and names the run it recovered (the batch start settles that run).
ctx.third='race-c';const reacquired=await call("runnerLease(env,third,'acquire')");assert.equal(reacquired.status,'owned');
records.get('enrichment/runner-lease.json').expiresAt=0;ctx.fourth='race-d';const takeover=await call("runnerLease(env,fourth,'acquire')");assert.equal(takeover.status,'owned');assert.equal(takeover.recoveredRunId,'race-c');
// AIR-452 (ADR 0162): the continuous next/submit drain of this file drove the retired v5 runner on R2. Batch runner v2 runs only with D1 prediction authority;
// its already_running, heartbeat, lease takeover, fencing, events and manifest_spent completion are covered by the prediction-batch-* tests.
console.log('Continuous drain: alias dedupe, atomic runner lease acquisition, release and expired-lease takeover passed');
