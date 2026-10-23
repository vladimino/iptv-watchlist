import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),writes=[];
const env={BUCKET:{
 async get(key){return records.has(key)?{etag:'test',json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value){writes.push(key);records.set(key,JSON.parse(value));return {etag:'test'};},
 async list(){return {objects:[],truncated:false};}
}};
let now=Date.parse('2026-10-13T09:30:00Z');
class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const context=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date:Clock,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);

const current=id=>({fingerprintHash:'fp-'+id,prediction:{tasteProfileVersion:7,tasteProfileHash:'profile-7',fingerprintHash:'fp-'+id,fingerprintSchemaVersion:1,predictionPromptVersion:1}});
const film=(id,tmdbId,shows=[])=>({id,tmdbId:String(tmdbId),title:id,original:id,year:2020,genres:[],actors:[],directors:[],shows});
records.set('enrichment/profile/current.json',{version:7,updatedAt:'2026-10-12T18:00:00Z',profileHash:'profile-7',profile:{}});
records.set('programme.json',{runId:'programme-1',updatedAt:'2026-10-13T08:00:00Z',watchlistUpdatedAt:'2026-10-13T07:55:00Z',watchlistCount:3,films:[film('watch-a',1,[{start:now}]),film('watch-b',2,[{start:now+3600000}]),film('watch-c',3,[])],stats:{epgStart:now-72*3600000,epgEnd:now+24*3600000,channels:42,scanned:12345,titleMissing:1,titleProvisional:2,metadataMissing:0}});
records.set('epg/discovered-films.json',{
 duplicate_a:film('cache-a',1,[{start:now-3600000}]),
 duplicate_b:film('cache-b',2,[{start:now+1800000}]),
 cache_d:film('cache-d',4,[])
});
records.set('enrichment/view-index.json',{'watch-a':current('a'),'cache-a':current('duplicate-a'),'cache-b':current('b'),'cache-d':current('d')});
records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:2,coldCount:2,coldWithoutPrediction:1,hotPredicted:2,profileVersion:7,programmeRunId:'programme-1',refreshedAt:'2026-10-13T09:00:00Z',pending:['watch-c'],hotPending:[],coldPending:['watch-c'],priorityCount:0,coldRemaining:1,urgentCount:0,priority:{},retries:{},lastBatch:null,lastCheckAt:null,metrics:{},discovery:null});
records.set('enrichment/latest-run.json',{runId:'run-1',status:'complete',trigger:'scheduled',createdAt:'2026-10-13T09:00:00Z',completedAt:'2026-10-13T09:08:00Z',stopReason:'queue_empty',selectedIds:['watch-a'],results:{'watch-a':'created'},failures:{},selectionKind:{'watch-a':'hot'},batchCount:1});
records.set('epg/discovery-latest.json',{programmeRunId:'programme-1',items:[{key:'known',title:'Known film',seenInLatestSnapshot:true,shows:[{channelId:'a',start:now}]},{key:'pending',title:'Pending film',seenInLatestSnapshot:true,shows:[{channelId:'b',start:now}]},{key:'old',title:'Old film',seenInLatestSnapshot:false,lastAiring:now-10*86400000,shows:[]}]});
records.set('epg/discovery-resolution.json',{known:{status:'verified',tmdbId:'1'}});

const response=await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env);
assert.equal(response.status,200);
const data=await response.json(),coverage=data.coverage;
assert.deepEqual(coverage,{confirmedFilmsTotal:4,currentPredictionsTotal:3,windowFilmsTotal:2,windowCurrentPredictions:2,cacheOffWindowTotal:2,pendingOffWindowTotal:1,windowPendingTotal:0});
assert(coverage.currentPredictionsTotal<=coverage.confirmedFilmsTotal);
assert(coverage.windowFilmsTotal<=coverage.confirmedFilmsTotal);
assert(coverage.windowCurrentPredictions<=coverage.windowFilmsTotal);
assert.equal(coverage.confirmedFilmsTotal,4,'aliases and duplicate cache records count once per canonical TMDB film');
assert.equal(data.predictions.pendingOffWindow,1);
assert.equal(data.epgTmdb.cacheOffWindow,2);
assert.notEqual(data.predictions.pendingOffWindow,data.epgTmdb.cacheOffWindow,'cache outside the window is distinct from its pending prediction subset');
assert.equal(data.epgTmdb.recognizedFilms,1);
assert.equal(data.epgTmdb.pendingRecognition,1);
assert.equal(data.epgTmdb.historicalUnresolved,1);
assert.equal(data.epgTmdb.ledgerTotal,3);
assert.equal(data.lastRun.reason,'queue_empty');
assert.equal(writes.length,0,'footer status GET is read-only');
const sourceOf=(body,id)=>body.integrations.sources.find(item=>item.id===id);
assert.equal(sourceOf(data,'letterboxd_watchlist').state,'unknown');
assert.equal(sourceOf(data,'epg').state,'unknown');
assert.equal(sourceOf(data,'letterboxd_ratings').state,'off');
assert.equal(sourceOf(data,'letterboxd_ratings').code,'off');
assert.equal(sourceOf(data,'predictions').state,'healthy');
assert.equal(sourceOf(data,'resolver').state,'unknown');
assert.equal(data.integrations.sources.some(item=>item.id==='metadata'||/wikidata/i.test(JSON.stringify(item))),false);
assert.equal(data.integrations.aggregate,'attention');
records.set('sync.json',{stage:'complete',updatedAt:'2026-10-13T09:00:00Z'});
records.set('enrichment/ratings/status.json',{state:'healthy',lastSuccessAt:'2026-10-13T09:10:00Z',lastFailureAt:null,attempt:null});
records.set('epg/discovery-status.json',{stage:'complete',finishedAt:'2026-10-13T08:00:00Z',error:null});
records.set('epg/resolver-continuation.json',{stage:'complete',at:'2026-10-13T08:00:00Z'});
let healthy=await (await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json();
assert.equal(healthy.integrations.aggregate,'healthy');
assert.equal(healthy.integrations.attentionCount,0);
assert.equal(sourceOf(healthy,'epg').state,'healthy');
assert.equal(sourceOf(healthy,'letterboxd_ratings').state,'healthy');
assert.equal(sourceOf(healthy,'predictions').state,'healthy');
assert.equal(healthy.integrations.sources.some(item=>item.id==='metadata'),false);
records.set('enrichment/ratings/status.json',{state:'blocked',lastSuccessAt:'2026-10-01T09:00:00Z',lastFailureAt:'2026-10-13T08:00:00Z',attempt:{cause:'anti_bot',error:'https://letterboxd.example/films?token=secret stack'}});
let blocked=await (await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json();
assert.equal(sourceOf(blocked,'letterboxd_ratings').state,'degraded');
assert.equal(sourceOf(blocked,'letterboxd_ratings').code,'ratings_blocked');
assert.equal(sourceOf(blocked,'letterboxd_ratings').lastSuccessAt,'2026-10-01T09:00:00.000Z');
assert.equal(sourceOf(blocked,'letterboxd_ratings').lastFailureAt,'2026-10-13T08:00:00.000Z');
assert.equal(sourceOf(blocked,'predictions').state,'healthy');
assert.equal(sourceOf(blocked,'epg').state,'healthy');
assert.equal(blocked.integrations.aggregate,'attention');
assert.equal(blocked.integrations.failedCount,0);
assert.doesNotMatch(JSON.stringify(blocked.integrations),/https?:|token|stack|wikidata/i);
records.set('sync.json',{stage:'epg',updatedAt:'2026-10-13T09:20:00Z',error:'EPG HTTP 502 https://secret.example/guide.xml?token=abc'});
let epgFailed=await (await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json();
assert.equal(sourceOf(epgFailed,'epg').state,'failed');
assert.equal(sourceOf(epgFailed,'epg').code,'epg_http');
assert.equal(sourceOf(epgFailed,'epg').lastSuccessAt,'2026-10-13T08:00:00.000Z');
assert.equal(sourceOf(epgFailed,'epg').lastFailureAt,'2026-10-13T09:20:00.000Z');
assert.equal(sourceOf(epgFailed,'letterboxd_watchlist').state,'healthy');
assert.equal(sourceOf(epgFailed,'predictions').state,'healthy');
assert.equal(epgFailed.integrations.aggregate,'failed');
assert.doesNotMatch(JSON.stringify(epgFailed.integrations),/secret\.example|token=abc|stack/i);
records.set('sync.json',{stage:'complete',updatedAt:'2026-10-13T09:00:00Z'});
records.set('enrichment/ratings/status.json',{state:'healthy',lastSuccessAt:'2026-10-10T09:00:00Z',lastFailureAt:null,attempt:null});
let stale=await (await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json();
assert.equal(sourceOf(stale,'letterboxd_ratings').state,'stale');
assert.equal(sourceOf(stale,'letterboxd_ratings').lastSuccessAt,'2026-10-10T09:00:00.000Z');
assert.equal(sourceOf(stale,'letterboxd_ratings').lastFailureAt,null);
assert.equal(sourceOf(stale,'epg').state,'healthy');
records.set('enrichment/ratings/status.json',{state:'healthy',lastSuccessAt:'2026-10-13T09:10:00Z',lastFailureAt:null,attempt:null});
records.set('epg/resolver-continuation.json',{stage:'paused',reason:'backoff',retryAt:'2026-10-13T12:00:00Z',at:'2026-10-13T09:00:00Z'});
let paused=await (await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json();
assert.equal(sourceOf(paused,'resolver').state,'degraded');
assert.equal(sourceOf(paused,'resolver').code,'resolver_backoff');
assert.equal(sourceOf(paused,'letterboxd_ratings').state,'healthy');
assert.equal(sourceOf(paused,'predictions').state,'healthy');
records.get('programme.json').watchlistCount=10;records.get('programme.json').stats.titleMissing=0;records.get('programme.json').stats.titleProvisional=0;records.get('programme.json').stats.metadataMissing=1;
let quiet=await (await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json();
assert.equal(quiet.integrations.sources.some(item=>item.id==='metadata'),false);
records.get('programme.json').stats.metadataMissing=3;
let noisy=await (await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json();
assert.equal(sourceOf(noisy,'metadata').code,'metadata_attention');
assert.doesNotMatch(JSON.stringify(noisy.integrations),/wikidata/i);
records.delete('enrichment/ratings/status.json');records.delete('sync.json');
let missing=await (await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json();
assert.equal(sourceOf(missing,'letterboxd_ratings').state,'off');
assert.equal(sourceOf(missing,'letterboxd_watchlist').state,'unknown');
assert.equal(sourceOf(missing,'epg').state,'unknown');
assert.equal(sourceOf(missing,'epg').lastSuccessAt,null);
assert.equal(writes.length,0,'integration summary does not write');
console.log('Status footer API: canonical coverage, invariants, duplicate suppression, off-window distinction and read-only behavior passed');
