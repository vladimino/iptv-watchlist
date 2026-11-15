import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

// AIR-496: a TMDB Movies concert recording is not a Film admission. Title screening still
// leaves Live/Concert titles as candidates; the detail gate withholds verification.
function harness(response){
 const records=new Map(),etags=new Map();let revision=0,calls=0;
 const env={TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}}};
 const live=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,TextDecoder,ReadableStream,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async input=>{calls++;return response(String(input));}});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),live);
 live.env=env;live.records=records;live.calls=()=>calls;
 return live;
}
const now=Date.now();
const show={channelId:'c1',channel:'Кино',start:now,end:now+82*60000};
const partsLive=harness(()=>new Response('{}'));
const candidate=(title,year,duration,extra={})=>{
 const parts=vm.runInContext('epgTitleParts('+JSON.stringify(title)+')',partsLive);
 return {key:parts.normalizedTitle+'|'+(year??''),title:parts.title,normalizedTitle:parts.normalizedTitle,year:year??parts.year,duration,durations:[duration],seenInLatestSnapshot:true,shows:[{...show,end:now+duration*60000}],lastAiring:now,airings:1,...extra};
};
function movieDetail(id,title,year,runtime,genres){
 const cards=genres.map(genre=>typeof genre==='object'?genre:{name:genre});
 return new Response(JSON.stringify({id:Number(id),title,original_title:title,release_date:year+'-01-01',runtime,overview:'A synopsis',genres:cards,poster_path:'/poster.jpg',credits:{crew:[{id:1,name:'Director',job:'Director'}],cast:[{id:2,name:'Artist'}]},translations:{translations:[]},alternative_titles:{titles:[]}}));
}
function searchHit(id,title,year){
 return new Response(JSON.stringify({total_pages:1,results:[{id:Number(id),title,original_title:title,release_date:year+'-01-01'}]}));
}
async function resolve(item,movies){
 const live=harness(url=>{
  for(const movie of movies){
   if(url.includes('/movie/'+movie.id+'?'))return movieDetail(movie.id,movie.title,movie.year,movie.runtime,movie.genres);
  }
  if(url.includes('/search/movie?')&&movies[0])return searchHit(movies[0].id,movies[0].title,movies[0].year);
  return new Response(JSON.stringify({total_pages:1,results:[]}));
 });
 live.records.set('programme.json',{runId:'run-1',films:[]});
 live.records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:[item]});
 live.records.set('epg/discovered-films.json',{});
 live.records.set('enrichment/profile/current.json',{version:1,profileHash:'hash'});
 const result=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',live);
 return {live,result,records:live.records};
}

assert.equal(vm.runInContext("nonFilmEPGReason('Robbie Williams: Live at the Apple Music Festival')",harness(()=>new Response('{}'))),null);
assert.equal(vm.runInContext("nonFilmEPGReason('Rieu Royale - André Rieu Coronation Concert Live in Amsterdam')",harness(()=>new Response('{}'))),null);
assert.equal(vm.runInContext("nonFilmEPGReason('Stop Making Sense')",harness(()=>new Response('{}'))),null);

const stamp=ms=>{const d=new Date(ms);return d.toISOString().slice(0,19).replace(/[-T:]/g,'')+' +0000';};
const xml=`<tv><channel id="c1"><display-name>Кино</display-name></channel>
<programme start="${stamp(now)}" stop="${stamp(now+82*60000)}" channel="c1"><title>Robbie Williams: Live at the Apple Music Festival</title><category>Концерт</category></programme>
<programme start="${stamp(now+3600000)}" stop="${stamp(now+3600000+140*60000)}" channel="c1"><title>Rieu Royale - André Rieu Coronation Concert Live in Amsterdam</title><category>Music</category></programme>
<programme start="${stamp(now+7200000)}" stop="${stamp(now+7200000+88*60000)}" channel="c1"><title>Stop Making Sense</title><category>Фильм</category></programme>
<programme start="${stamp(now+10800000)}" stop="${stamp(now+10800000+170*60000)}" channel="c1"><title>Схватка (1995)</title><category>Фильм</category></programme>
</tv>`;
const scanLive=harness(()=>new Response('{}'));
scanLive.xml=xml;scanLive.now=now;
const scan=await vm.runInContext('scanEPG(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(xml));c.close();}}),[],now)',scanLive);
const scanned=new Map(scan.discovery.map(item=>[item.title,item]));
assert(scanned.has('Robbie Williams: Live at the Apple Music Festival'));
assert(scanned.has('Rieu Royale - André Rieu Coronation Concert Live in Amsterdam'));
assert(scanned.has('Stop Making Sense'));
assert(scanned.has('Схватка'));
assert.equal(scanned.get('Robbie Williams: Live at the Apple Music Festival').categories.join('|'),'Концерт');
assert.equal(scan.stats.filteredNonMovies,0);

const robbie=await resolve(candidate('Robbie Williams: Live at the Apple Music Festival',2016,82,{categories:['Концерт']}),[{id:1326142,title:'Robbie Williams: Live at the Apple Music Festival',year:2016,runtime:82,genres:[{id:10402,name:'Музыка'}]}]);
assert.equal(robbie.records.get('epg/discovery-resolution.json')['robbie williams live at the apple music festival|2016'].status,'no_confident_match');
assert.equal(robbie.records.get('epg/discovery-resolution.json')['robbie williams live at the apple music festival|2016'].reason,'concert_recording');
assert.equal(robbie.records.get('epg/discovered-films.json').tmdb_1326142,undefined);
assert.equal(robbie.records.get('epg/discovery-score-preview.json').items['robbie williams live at the apple music festival|2016'].outcome,'candidate_decision');
assert.equal(robbie.records.get('programme.json').runId,'run-1');
const robbieQueue=robbie.records.get('enrichment/prediction-queue.json');
assert.ok(!robbieQueue||!(robbieQueue.hotPending||[]).includes('tmdb_1326142'));
assert.ok(!robbieQueue||!(robbieQueue.pending||[]).includes('tmdb_1326142'));

const rieuTitle='Rieu Royale - André Rieu Coronation Concert Live in Amsterdam';
const rieu=await resolve(candidate(rieuTitle,2013,140,{categories:['Music']}),[{id:238858,title:rieuTitle,year:2013,runtime:140,genres:[{id:10402,name:'Music'},{id:10770,name:'TV Movie'}]}]);
const rieuKey=rieu.records.get('epg/discovery-latest.json').items[0].key;
assert.equal(rieu.records.get('epg/discovery-resolution.json')[rieuKey].status,'no_confident_match');
assert.equal(rieu.records.get('epg/discovery-resolution.json')[rieuKey].reason,'concert_recording');
assert.equal(rieu.records.get('epg/discovered-films.json').tmdb_238858,undefined);
const rieuQueue=rieu.records.get('enrichment/prediction-queue.json');
assert.ok(!rieuQueue||!(rieuQueue.hotPending||[]).includes('tmdb_238858'));

const sense=await resolve(candidate('Stop Making Sense',1984,88,{categories:['Концерт']}),[{id:841,title:'Stop Making Sense',year:1984,runtime:88,genres:[{id:99,name:'Documentary'},{id:10402,name:'Music'}]}]);
assert.equal(sense.records.get('epg/discovery-resolution.json')['stop making sense|1984'].status,'verified');
assert.equal(sense.records.get('epg/discovered-films.json').tmdb_841.canonicalIdentity,'tmdb:841');
assert.ok(sense.records.get('enrichment/prediction-queue.json').hotPending.includes('tmdb_841'));

const heat=await resolve(candidate('Heat',1995,170),[{id:949,title:'Heat',year:1995,runtime:170,genres:[{id:18,name:'Drama'},{id:80,name:'Crime'}]}]);
assert.equal(heat.records.get('epg/discovery-resolution.json')['heat|1995'].status,'verified');
assert.equal(heat.records.get('epg/discovered-films.json').tmdb_949.tmdbId,'949');
assert.ok(heat.records.get('enrichment/prediction-queue.json').hotPending.includes('tmdb_949'));

const tvMovie=await resolve(candidate('Made For Television',1999,96),[{id:7001,title:'Made For Television',year:1999,runtime:96,genres:[{id:10770,name:'TV Movie'}]}]);
assert.equal(tvMovie.records.get('epg/discovery-resolution.json')['made for television|1999'].status,'verified');
const musicOnly=await resolve(candidate('Pink Floyd Live At Pompeii',1972,92),[{id:18648,title:'Pink Floyd Live At Pompeii',year:1972,runtime:92,genres:[{id:10402,name:'Music'}]}]);
assert.equal(musicOnly.records.get('epg/discovery-resolution.json')['pink floyd live at pompeii|1972'].status,'verified');

{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-air-496-'));
 const file=path.join(root,'d1.sqlite');
 const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
 const applied=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(applied.status!==0)throw new Error(applied.stderr||'migration failed');
 sqliteSync(['-bail',file],{input:"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1;",encoding:'utf8'});
 const RUN='run-496';
 const db=d1Standin(file);
 const env={DB:db,BUCKET:new MemoryBucket(),discoveryLease:null,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
 const lease=(await Authority.acquireLease(env,{programmeRunId:RUN})).lease;
 env.discoveryLease=lease;
 const item=candidate('Robbie Williams: Live at the Apple Music Festival',2016,82,{categories:['Концерт']});
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease,items:(async function*(){yield item;})()});
 const context=vm.createContext({console,Date,Promise,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
  fetch(url){const text=String(url);if(text.includes('/movie/1326142'))return Promise.resolve(movieDetail(1326142,'Robbie Williams: Live at the Apple Music Festival',2016,82,[{id:10402,name:'Музыка'}]));if(text.includes('/search/movie?'))return Promise.resolve(searchHit(1326142,'Robbie Williams: Live at the Apple Music Festival',2016));return Promise.resolve(new Response(JSON.stringify({results:[]}),{status:200}));},
  DiscoveryAuthority:Authority,pinEpg:async value=>value,refreshPredictionQueue:async()=>null,
  loadJSON:async(target,key)=>{if(key==='programme.json')return {runId:RUN,films:[]};if(key==='epg/published-generation.json')return {phase:'published',programmeRunId:RUN};const routed=await Authority.routeRead(target,key);return routed.handled?routed.value:null;},
  saveJSON:async(target,key,value)=>{const routed=await Authority.routeWrite(target,key,value);if(!routed.handled)throw new Error('not stored');}});
 for(const fileName of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(fileName,'utf8'),context);
 const result=await context.resolveDiscoveryChunk(env,{films:[]},4,lease);
 assert.equal(result.paged,true);
 const stored=(await Authority.routeRead(env,'epg/discovery-resolution.json')).value;
 assert.equal(stored[item.key].status,'no_confident_match');
 assert.equal(stored[item.key].reason,'concert_recording');
 const admissions=(await Authority.routeRead(env,'epg/discovered-films.json')).value||{};
 assert.equal(admissions.tmdb_1326142,undefined);
 await Authority.releaseLease(env,lease);
}

console.log('Concert broadcast admission: two TMDB concert recordings withheld, concert film and feature admitted, EPG Live/Concert titles unscreened');
