import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,failKey='',writes=[],eventsUnavailable=false;
const env={BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;if(eventsUnavailable&&key.startsWith('events/items/'))throw new Error('Temporary events outage');if(key===failKey){failKey='';throw new Error('Storage checkpoint interrupted')}records.set(key,JSON.parse(value));etags.set(key,String(++revision));writes.push(key);return {etag:etags.get(key)}},list:async({prefix=''})=>({objects:[...records.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false})}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
ctx.env=env;const call=(code)=>vm.runInContext(code,ctx);
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()}}
const now=Date.now(),film=(id,start,extra={})=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,'')||id,genres:[],actors:[],directors:[],shows:start===null?[]:[{start}],...extra});
const execution=Object.fromEntries(Object.entries(call('EXECUTION')).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']},prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});records.set('sync.json',{runId:'test',stage:'complete'});





let clockTime=Date.now();class Clock extends Date{constructor(...args){super(...(args.length?args:[clockTime]));}static now(){return clockTime;}}ctx.Date=Clock;
const events=()=>[...records].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v);
records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',{tmdb_1:film('tmdb_1',now),tmdb_2:film('tmdb_2',now),tmdb_3:film('tmdb_3',now)});
assert.equal(call('RUNNER_LEASE_TTL'),15*60000);let start=(await api('start',{scope:'watchlist_all'})).data;
assert.equal(records.get('enrichment/runner-lease.json').expiresAt-clockTime,15*60000);
for(let i=0;i<3;i++){clockTime+=10*60000;assert.equal((await api('heartbeat',{runId:start.runId})).status,200);assert.equal(records.get('enrichment/runner-lease.json').expiresAt-clockTime,15*60000);assert.equal((await api('start',{scope:'watchlist_all'})).data.status,'already_running');}
let n=(await api('next',{runId:start.runId,batchSize:1})).data;const savedId=n.items[0].filmId;await api('submit',{runId:start.runId,items:[{filmId:savedId,fingerprint,prediction}]});const saved=structuredClone(records.get('enrichment/films/'+savedId+'/predictions.json'));
clockTime+=16*60000;const leaseWrites=writes.filter(k=>k==='enrichment/runner-lease.json').length;
const race=await Promise.all([api('start',{scope:'watchlist_all'}),api('start',{scope:'watchlist_all'})]);assert.equal(race.filter(x=>x.data.status==='running').length,1);assert.equal(race.filter(x=>x.data.status==='already_running').length,1);const resumed=race.find(x=>x.data.status==='running').data;
assert.notEqual(resumed.runId,start.runId);assert.equal(writes.filter(k=>k==='enrichment/runner-lease.json').length,leaseWrites+1);assert.equal(records.get('enrichment/runner-lease.json').runId,resumed.runId);assert.equal(records.get('enrichment/runs/'+start.runId+'.json').status,'interrupted');assert.equal(records.get('enrichment/runs/'+start.runId+'.json').recoverable,true);
assert.equal(events().filter(e=>e.stage==='resumed').length,1);assert.equal(events().filter(e=>e.reason==='lease_expired').length,0);
const live=(await api('status',undefined,'GET')).data;assert.equal(live.state,'running');assert.equal(live.runId,resumed.runId);assert.equal(live.lastHeartbeatAt,new Clock().toISOString());assert.equal(live.hotRemaining,2);assert.equal(live.added,0);
n=(await api('next',{runId:resumed.runId})).data;assert(!n.items.some(i=>i.filmId===savedId));assert.deepEqual(records.get('enrichment/films/'+savedId+'/predictions.json'),saved);
// Late cleanup by the dead owner cannot create a pause Event or release the new owner's lease.
await api('next',{runId:start.runId});await api('complete',{runId:start.runId,reason:'lease_expired'});assert.equal(events().filter(e=>e.reason==='lease_expired').length,0);assert.equal(records.get('enrichment/runner-lease.json').runId,resumed.runId);
// If recovery itself fails to create its run checkpoint, expose that genuine system stop.
clockTime+=16*60000;failKey='enrichment/latest-run.json';const failed=(await api('start',{scope:'watchlist_all'})).data;assert.equal(failed.status,'partial');assert.equal(failed.reason,'storage_error');assert.equal(events().filter(e=>e.reason==='storage_error').length,1);assert.equal((await api('status',undefined,'GET')).data.state,'blocked');assert.equal(events().filter(e=>e.stage==='resumed').length,1);
console.log('Lease recovery: 15-minute TTL with 10-minute heartbeat, atomic concurrent takeover, same-trigger running, saved forecast reuse, one resume/no expired-stop, stale-owner fencing and failed-recovery Event passed');
