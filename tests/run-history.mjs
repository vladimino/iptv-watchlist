import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,failKey='',writes=[],eventsUnavailable=false;
const env={BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;if(eventsUnavailable&&key.startsWith('events/items/'))throw new Error('Temporary events outage');if(key===failKey){failKey='';throw new Error('Storage checkpoint interrupted')}records.set(key,JSON.parse(value));etags.set(key,String(++revision));writes.push(key);return {etag:etags.get(key)}},list:async({prefix=''})=>({objects:[...records.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false})}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
ctx.env=env;const call=(code)=>vm.runInContext(code,ctx);
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()}}
const now=Date.now(),film=(id,start,extra={})=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,'')||id,genres:[],actors:[],directors:[],shows:start===null?[]:[{start}],...extra});
const execution=Object.fromEntries(Object.entries(call('EXECUTION')).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']},prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});records.set('sync.json',{runId:'test',stage:'complete'});





let clockTime=Date.parse('2026-10-12T10:00:00Z');class Clock extends Date{constructor(...args){super(...(args.length?args:[clockTime]));}static now(){return clockTime;}}ctx.Date=Clock;
const history=async(limit=100)=>(await api('runs?limit='+limit,undefined,'GET')).data.runs,find=async(id)=>(await history()).find(r=>r.runId===id),startRun=async()=>{clockTime+=1000;return (await api('start',{scope:'watchlist_all',trigger:'scheduled'})).data;};
const catalog={};for(let i=1;i<=8;i++)catalog['tmdb_'+i]=film('tmdb_'+i,clockTime);records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',catalog);
let a=await startRun();assert.equal((await find(a.runId)).startResult,'running');assert.equal((await find(a.runId)).firstNextAt,null);assert.equal((await find(a.runId)).leaseAcquiredAt,new Clock().toISOString());
const beforeEvents=[...records.keys()].filter(k=>k.startsWith('events/items/')).length;await startRun();let rows=await history();const concurrent=rows[0];assert.equal(concurrent.startResult,'already_running');assert.notEqual(concurrent.runId,a.runId);assert.equal(concurrent.leaseAcquiredAt,null);assert.equal([...records.keys()].filter(k=>k.startsWith('events/items/')).length,beforeEvents);assert.equal((await api('status',undefined,'GET')).data.currentRun.runId,a.runId);
// Death with a lease but before first next, observed even before the following trigger.
clockTime+=16*60000;let prior=await find(a.runId);assert.equal(prior.state,'interrupted');assert.equal(prior.stopReason,'lease_expired');assert.equal(prior.firstNextAt,null);assert.equal(prior.firstSubmitAt,null);
let b=await startRun();assert.equal(b.status,'running');assert.equal((await find(b.runId)).startResult,'recovered_stale_lease');
// Death after next but before any saved result.
clockTime+=1000;await api('next',{runId:b.runId,batchSize:3});prior=await find(b.runId);assert(prior.firstNextAt);assert.equal(prior.firstSubmitAt,null);clockTime+=16*60000;let c=await startRun();prior=await find(b.runId);assert.equal(prior.state,'interrupted');assert.equal(prior.stopReason,'lease_expired');assert.equal(prior.added,0);
// Several checkpoints followed by death retain actual counters and first successful-submit timestamp.
let n=(await api('next',{runId:c.runId,batchSize:3})).data;for(const item of n.items){clockTime+=1000;await api('submit',{runId:c.runId,items:[{filmId:item.filmId,fingerprint,prediction}]});}prior=await find(c.runId);assert.equal(prior.added,3);assert(prior.firstSubmitAt);clockTime+=16*60000;let d=await startRun();prior=await find(c.runId);assert.equal(prior.state,'interrupted');assert.equal(prior.added,3);assert.equal(prior.hotRemaining,5);
clockTime+=1000;await api('next',{runId:d.runId});await api('complete',{runId:d.runId,reason:'quota'});prior=await find(d.runId);assert.equal(prior.state,'blocked');assert.equal(prior.stopReason,'quota');assert(prior.endedAt);
// Normal completion, separated from active run and interrupted history.
let e=await startRun();while(true){n=(await api('next',{runId:e.runId})).data;if(n.mustComplete){await api('complete',{runId:e.runId,reason:n.stopReason});break;}for(const item of n.items){clockTime+=1000;await api('submit',{runId:e.runId,items:[{filmId:item.filmId,fingerprint,prediction}]});}}
prior=await find(e.runId);assert.equal(prior.state,'completed');assert.equal(prior.startResult,'running');assert.equal(prior.stopReason,'queue_empty');assert.equal(prior.added,5);assert(prior.batchesProcessed>=1);assert.equal((await api('status',undefined,'GET')).data.currentRun,null);
const example={runs:await history(3)};fs.mkdirSync('outputs',{recursive:true});fs.writeFileSync('outputs/run-history-example.json',JSON.stringify(example,null,2)+'\n');
for(let i=0;i<22;i++)await startRun();rows=await history(30);assert(rows.length>=20);for(let i=1;i<rows.length;i++)assert(rows[i-1].startedAt>=rows[i].startedAt);assert(rows.some(r=>r.runId===c.runId));assert.equal((await api('runs?limit=0',undefined,'GET')).status,400);assert(!/hash|Bearer|token|prompt|raw|stack/i.test(JSON.stringify(rows)));
console.log('Diagnostic history: normal/already_running/quota, all three crash stages, immutable counters, stale recovery, separate active run, newest-first and 20+ persistent records passed');
console.log(JSON.stringify(example,null,2));
