import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,failKey='',writes=[];
const env={BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;if(key===failKey){failKey='';throw new Error('Storage checkpoint interrupted')}records.set(key,JSON.parse(value));etags.set(key,String(++revision));writes.push(key);return {etag:etags.get(key)}},list:async()=>({objects:[],truncated:false})}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
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
let catalog={};for(let i=1;i<=56;i++)catalog['tmdb_'+i]=film('tmdb_'+i,now);
records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',catalog);
const concurrent=await Promise.all([api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}}),api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}})]);assert.equal(concurrent.filter(x=>x.data.status==='already_running').length,1);let start=concurrent.find(x=>x.data.status==='running').data;
assert.equal(start.deadlineAt,null);assert.equal(start.batchSize,12);
let second=(await api('start',{scope:'watchlist_all'})).data;assert.equal(second.status,'already_running');assert.equal(second.runId,start.runId);
const oldLease=structuredClone(records.get('enrichment/runner-lease.json'));records.get('enrichment/runner-lease.json').expiresAt=Date.now()+1000;
assert.equal((await api('heartbeat',{runId:start.runId})).status,200);assert(records.get('enrichment/runner-lease.json').expiresAt>oldLease.expiresAt-1000);
let submitted=0,finalNext;
while(submitted<100){const n=(await api('next',{runId:start.runId,batchSize:20})).data;if(n.mustComplete){finalNext=n;break;}assert(n.items.length>0);for(const item of n.items){const r=(await api('submit',{runId:start.runId,items:[{filmId:item.filmId,fingerprint,prediction}]})).data;assert(!r.mustComplete);submitted++;if(submitted===10)assert.equal([...records.keys()].filter(k=>k.startsWith('events/items/')&&!k.includes('prediction-start-')).length,0);}}
assert.equal(submitted,56);assert.equal(finalNext.stopReason,'queue_empty');
const running=records.get('enrichment/runs/'+start.runId+'.json');assert(running.batchCount>=5);assert.equal(running.hotRemaining,0);
const progress=[...records].filter(([k])=>k.startsWith('events/items/')&&!k.includes('prediction-start-'));assert.equal(progress.length,1);assert.equal(progress[0][1].added,50);
let completed=(await api('complete',{runId:start.runId,reason:'queue_empty'})).data;assert.equal(completed.added,56);assert.equal(completed.status,'complete');assert.equal(records.get('enrichment/runner-lease.json').expiresAt,0);
assert.equal((await api('start',{scope:'watchlist_all'})).data.status,'noop');assert.equal([...records.keys()].filter(k=>k.startsWith('events/items/')&&!k.includes('prediction-start-')).length,2);
// A partial crash retains predictions. Expired TTL enables a new owner; the old owner is fenced.
catalog.tmdb_100=film('tmdb_100',now);catalog.tmdb_101=film('tmdb_101',now);records.set('epg/discovered-films.json',catalog);
start=(await api('start',{scope:'watchlist_all',batchSize:1})).data;let n=(await api('next',{runId:start.runId,batchSize:1})).data;let saved=n.items[0].filmId;await api('submit',{runId:start.runId,items:[{filmId:saved,fingerprint,prediction}]});const frozen=structuredClone(records.get('enrichment/films/'+saved+'/predictions.json'));
records.get('enrichment/runner-lease.json').expiresAt=0;
second=(await api('start',{scope:'watchlist_all'})).data;assert.notEqual(second.runId,start.runId);assert.equal(records.get('enrichment/runs/'+start.runId+'.json').stopReason,'lease_expired');
assert.equal((await api('submit',{runId:start.runId,items:[{filmId:saved,prediction}]})).status,409);n=(await api('next',{runId:second.runId,batchSize:20})).data;assert(!n.items.some(x=>x.filmId===saved));assert.deepEqual(records.get('enrichment/films/'+saved+'/predictions.json'),frozen);
await api('complete',{runId:second.runId,reason:'quota Bearer secret'});assert.equal(records.get('enrichment/runner-lease.json').expiresAt,0);assert(!JSON.stringify([...records]).includes('secret'));
// New hot preempts cold at the next batch. No rerun for a repeated timeslot.
catalog={tmdb_200:film('tmdb_200',now-10*86400000),tmdb_201:film('tmdb_201',now-10*86400000)};records.set('epg/discovered-films.json',catalog);
start=(await api('start',{scope:'watchlist_all',batchSize:1})).data;n=(await api('next',{runId:start.runId,batchSize:1})).data;await api('submit',{runId:start.runId,items:[{filmId:n.items[0].filmId,fingerprint,prediction}]});catalog.tmdb_202=film('tmdb_202',now-71.9*3600000);records.set('epg/discovered-films.json',catalog);n=(await api('next',{runId:start.runId,batchSize:1})).data;assert.equal(n.items[0].filmId,'tmdb_202');
// Time-based progress before 50 results and real storage failure signal.
records.get('enrichment/runs/'+start.runId+'.json').lastProgressAt=new Date(now-31*60000).toISOString();await api('heartbeat',{runId:start.runId});n=(await api('next',{runId:start.runId,batchSize:1})).data;const beforeEvents=[...records.keys()].filter(k=>k.startsWith('events/items/')&&!k.includes('prediction-start-')).length;
failKey='enrichment/films/'+n.items[0].filmId+'/predictions.json';const failure=(await api('submit',{runId:start.runId,items:[{filmId:n.items[0].filmId,fingerprint,prediction}]})).data;assert.equal(failure.mustComplete,true);assert.equal(failure.stopReason,'storage_error');await api('complete',{runId:start.runId,reason:failure.stopReason});assert.equal(records.get('enrichment/runner-lease.json').expiresAt,0);assert.equal([...records.keys()].filter(k=>k.startsWith('events/items/')&&!k.includes('prediction-start-')).length,beforeEvents+1);
console.log('Continuous drain: atomic acquisition, already_running, heartbeat, 56 films/multiple batches to empty, 50-result/30-minute events, TTL takeover, stale owner fencing, checkpoints/cache reuse, hot preemption and quota/storage stop passed');
