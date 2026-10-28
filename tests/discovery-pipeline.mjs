import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,failDecision=false,calls=[];
const env={TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;if(failDecision&&key==='epg/discovery-resolution.json'){failDecision=false;throw new Error('checkpoint interrupted');}records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},list:async()=>({objects:[],truncated:false})}};
let responseMode='normal';
const movie={id:42,title:'Горячий фильм',original_title:'Hot Film',release_date:'2020-01-01',runtime:100,genres:[],credits:{crew:[],cast:[]},translations:{translations:[{iso_639_1:'uk',data:{title:'Гарячий фільм'}}]}};
const context=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async url=>{calls.push(String(url));if(responseMode==='429')return new Response('{}',{status:429,headers:{'Retry-After':'30'}});return new Response(JSON.stringify(String(url).includes('/search/')?{total_pages:1,results:[movie]}:movie));}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
context.env=env;
const now=Date.now(),candidate=(title,year,lastAiring)=>({key:title.toLowerCase()+'|'+year,title,normalizedTitle:title.toLowerCase(),year,duration:100,durations:[100],firstAiring:lastAiring,lastAiring,airings:1,shows:[{channelId:'test',channel:'Test',start:lastAiring,end:lastAiring+7200000}]}),hot=candidate('Hot Film',2020,now),cold=candidate('Cold Film',2020,now-10*86400000),report={runId:'test',updatedAt:new Date(now-5*86400000).toISOString(),films:[]};
records.set('programme.json',report);records.set('enrichment/profile/current.json',{version:1,profileHash:'p'});
// Use actual key constant rather than a duplicated contract in fixtures.
const profileKey=vm.runInContext('profileKey',context);records.set(profileKey,{version:1,profileHash:'p'});
records.set('epg/discovery-latest.json',{programmeRunId:'test',items:[cold,hot]});context.report=report;
let result=await vm.runInContext('resolveDiscoveryBatch(env,report,1)',context);
assert.equal(result.added,1);assert(calls[0].includes('Hot+Film'),'hot title bypasses a cold candidate at the head of the source');assert.equal(records.get('epg/discovered-films.json').tmdb_42.canonicalIdentity,'tmdb:42');
const queueKey=vm.runInContext('predictionQueueKey',context);assert.deepEqual(records.get(queueKey).pending,['tmdb_42']);
// A translated alias is scored from the index and verified by one detail read; a yearless short title is ambiguous without any read. No second entity either way.
records.get('epg/discovery-latest.json').items.push(candidate('Гарячий фільм',2020,now),candidate('Hot Film',null,now));calls=[];
result=await vm.runInContext('resolveDiscoveryBatch(env,report,2)',context);assert.equal(result.checked,2);assert.equal(result.reused,0);assert.equal(calls.length,1);assert(calls[0].includes('/movie/42'));assert.equal(records.get('epg/discovery-resolution.json')['гарячий фільм|2020'].identitySource,'tmdb_detail');assert.equal(records.get('epg/discovery-resolution.json')['hot film|null'].status,'ambiguous');assert.equal(Object.keys(records.get('epg/discovered-films.json')).length,1);
// Expiration doesn't delete cached film identity or prediction metadata; it only defers forecast work.
const cached=records.get('epg/discovered-films.json').tmdb_42;cached.epgLastAiring=now-10*86400000;cached.shows=[];
await vm.runInContext('refreshPredictionQueue(env,report)',context);assert.equal(records.get(queueKey).pending.length,0);assert.equal(records.get(queueKey).coldWithoutPrediction,1);
// Promotion uses a verified alias and refreshes availability without a TMDB lookup.
// A historical showing stays in the ledger. It becomes actionable again only after a current broadcast.
const revived=records.get('epg/discovery-latest.json').items.find(item=>item.key===cold.key);revived.shows=[{channelId:'test',channel:'Test',start:now,end:now+7200000}];revived.lastAiring=now;revived.seenInLatestSnapshot=true;
calls=[];await vm.runInContext('resolveDiscoveryBatch(env,report,1)',context);assert.equal(records.get(queueKey).pending[0],'tmdb_42');assert.equal(calls.length,2,'only the unresolved current candidate requires TMDB; known hot aliases do not');
// A live lease rejects overlapping writers, and an expired lease can be recovered.
records.set('epg/resolver-lease.json',{id:'running',expiresAt:Date.now()+60000});assert.equal((await vm.runInContext('resolveDiscoveryBatch(env,report,1)',context)).stage,'busy');records.get('epg/resolver-lease.json').expiresAt=0;
// Interrupted decision persistence: the catalog write stands, and the next chunk re-verifies the recovered film from its alias with one detail read.
records.set('epg/discovery-latest.json',{programmeRunId:'test',items:[candidate('Hot Film',2020,now)]});records.set('epg/discovery-resolution.json',{});records.set('epg/discovered-films.json',{});failDecision=true;calls=[];
result=await vm.runInContext('resolveDiscoveryBatch(env,report,1)',context);assert.equal(result.stage,'partial');assert.equal(Object.keys(records.get('epg/discovered-films.json')).length,1);records.get('epg/discovery-status.json').retryAt=null;calls=[];
result=await vm.runInContext('resolveDiscoveryBatch(env,report,1)',context);assert.equal(result.checked,1);assert.equal(result.added,0);assert.equal(calls.length,1);assert.equal(records.get('epg/discovery-resolution.json')[hot.key].status,'verified');assert.equal(Object.keys(records.get('epg/discovered-films.json')).length,1);
// TMDB rate limits pause rather than marking a candidate as a non-film or losing its queue entry.
records.set('epg/discovery-latest.json',{programmeRunId:'test',items:[candidate('Other',2020,now)]});responseMode='429';calls=[];
result=await vm.runInContext('resolveDiscoveryBatch(env,report,1)',context);assert.equal(result.error,'TMDB HTTP 429');assert(result.retryAt);assert.equal(result.remaining,1);const count=calls.length;assert.equal((await vm.runInContext('resolveDiscoveryBatch(env,report,1)',context)).stage,'backoff');assert.equal(calls.length,count);
// A committed programme queues one discovery series. It does not dispatch a hop or keep a credential.
const tasks=[],dispatched=[];context.execution={waitUntil:p=>tasks.push(p),exports:{DiscoveryContinuation:{fetch:async(url,init)=>{dispatched.push({url,init});return new Response('{}');}}}};responseMode='normal';calls=[];
env.EPG_SITE_SERVICE_TOKEN='legacy-secret';const queued=await vm.runInContext('queueDiscovery(env,"epg_committed")',context);await Promise.all(tasks);delete env.EPG_SITE_SERVICE_TOKEN;
assert.equal(queued.state,'paused');assert.equal(queued.reason,'epg_committed');assert.equal(queued.remainingChunks,12);assert.equal(queued.nextAction,'continue');
assert.equal(calls.length,0);assert.deepEqual(dispatched,[]);assert.equal(records.get('epg/resolver-continuation.json').remainingChunks,12);assert(!JSON.stringify([...records]).includes('legacy-secret'));
assert.equal(vm.runInContext("nonFilmEPGReason('TV series Example')",context),'show_label');assert.equal(vm.runInContext("nonFilmEPGReason('Example episode 4')",context),null);assert.equal(vm.runInContext("nonFilmEPGReason('Example season 2 episode 4')",context),'episode_label');
console.log('Discovery pipeline: hot priority, alias/yearless reuse, canonical identity, cold deferral, promotion, leases, restart checkpoints, 429 backoff and queued continuation passed');
