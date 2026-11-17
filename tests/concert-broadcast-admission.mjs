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

// A TMDB documentary and a recording of a real concert are not Film admissions. Title screening
// still leaves Live/Concert titles as candidates; the detail gate withholds verification.
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
function movieDetail(id,title,year,runtime,genres,overview='A synopsis'){
 const cards=genres.map(genre=>typeof genre==='object'?genre:{name:genre});
 return new Response(JSON.stringify({id:Number(id),title,original_title:title,release_date:year+'-01-01',runtime,overview,genres:cards,poster_path:'/poster.jpg',credits:{crew:[{id:1,name:'Director',job:'Director'}],cast:[{id:2,name:'Artist'}]},translations:{translations:[]},alternative_titles:{titles:[]}}));
}
function searchHit(id,title,year){
 return new Response(JSON.stringify({total_pages:1,results:[{id:Number(id),title,original_title:title,release_date:year+'-01-01'}]}));
}
async function resolve(item,movies){
 const live=harness(url=>{
  for(const movie of movies){
   if(url.includes('/movie/'+movie.id+'?'))return movieDetail(movie.id,movie.title,movie.year,movie.runtime,movie.genres,movie.overview);
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

function withheld(records,key,id,reason){
 const decision=records.get('epg/discovery-resolution.json')[key];
 assert.equal(decision.status,reason==='concert_recording_ambiguous'?'needs_verification':'no_confident_match',key);
 assert.equal(decision.reason,reason,key);
 assert.equal(records.get('epg/discovered-films.json')['tmdb_'+id],undefined,key);
 assert.equal(records.get('epg/discovery-score-preview.json').items[key].reason,reason,key);
 const queue=records.get('enrichment/prediction-queue.json');
 assert.ok(!queue||!(queue.hotPending||[]).includes('tmdb_'+id),key);
 assert.ok(!queue||!(queue.pending||[]).includes('tmdb_'+id),key);
 assert.equal(records.get('programme.json').runId,'run-1',key);
 assert.deepEqual(records.get('programme.json').films,[],key);
 assert.equal(records.has('epg/published-generation.json'),false,key);
}
function admitted(records,key,id){
 assert.equal(records.get('epg/discovery-resolution.json')[key].status,'verified',key);
 assert.equal(records.get('epg/discovered-films.json')['tmdb_'+id].canonicalIdentity,'tmdb:'+id,key);
 assert.ok(records.get('enrichment/prediction-queue.json').hotPending.includes('tmdb_'+id),key);
 assert.equal(records.get('programme.json').runId,'run-1',key);
 assert.equal(records.has('epg/published-generation.json'),false,key);
}
for(const categories of [['Концерт'],['Фильм'],[]]){
 const sense=await resolve(candidate('Stop Making Sense',1984,88,{categories}),[{id:841,title:'Stop Making Sense',year:1984,runtime:88,genres:[{id:99,name:'Documentary'},{id:10402,name:'Music'}]}]);
 withheld(sense.records,'stop making sense|1984',841,'documentary_excluded');
}
const solo=await resolve(candidate('Free Solo',2018,100,{categories:['Фильм']}),[{id:51497,title:'Free Solo',year:2018,runtime:100,genres:[{id:99,name:'Documentary'}]}]);
withheld(solo.records,'free solo|2018',51497,'documentary_excluded');
const soloBare=await resolve(candidate('Free Solo',2018,100),[{id:51497,title:'Free Solo',year:2018,runtime:100,genres:[{id:99,name:'Documentary'}]}]);
withheld(soloBare.records,'free solo|2018',51497,'documentary_excluded');
const crimeDoc=await resolve(candidate('The Thin Blue Line',1988,103,{categories:['Фильм']}),[{id:11606,title:'The Thin Blue Line',year:1988,runtime:103,genres:[{id:99,name:'Documentary'},{id:80,name:'Crime'}]}]);
withheld(crimeDoc.records,'the thin blue line|1988',11606,'documentary_excluded');
const historyDoc=await resolve(candidate('They Shall Not Grow Old',2018,99),[{id:514754,title:'They Shall Not Grow Old',year:2018,runtime:99,genres:[{id:99,name:'Documentary'},{id:36,name:'History'}]}]);
withheld(historyDoc.records,'they shall not grow old|2018',514754,'documentary_excluded');
for(const categories of [[],['Фильм']]){
 const pompeii=await resolve(candidate('Pink Floyd Live At Pompeii',1972,92,{categories}),[{id:18648,title:'Pink Floyd Live At Pompeii',year:1972,runtime:92,genres:[{id:10402,name:'Music'}]}]);
 withheld(pompeii.records,'pink floyd live at pompeii|1972',18648,'concert_recording');
}
const heat=await resolve(candidate('Heat',1995,170),[{id:949,title:'Heat',year:1995,runtime:170,genres:[{id:18,name:'Drama'},{id:80,name:'Crime'}]}]);
admitted(heat.records,'heat|1995','949');
const bohemian=await resolve(candidate('Bohemian Rhapsody',2018,134,{categories:['Фильм']}),[{id:424694,title:'Bohemian Rhapsody',year:2018,runtime:134,genres:[{id:18,name:'Drama'},{id:10402,name:'Music'}],overview:'The story of Freddie Mercury and Queen, including their Live Aid concert.'}]);
admitted(bohemian.records,'bohemian rhapsody|2018','424694');
const liveTitle=await resolve(candidate('Live by Night',2016,129),[{id:259693,title:'Live by Night',year:2016,runtime:129,genres:[{id:80,name:'Crime'},{id:18,name:'Drama'}]}]);
admitted(liveTitle.records,'live by night|2016','259693');
const fictionMusic=await resolve(candidate('Rhythm of the Road',2011,100),[{id:88001,title:'Rhythm of the Road',year:2011,runtime:100,genres:[{id:10402,name:'Music'}],overview:'A fictional band spends a summer writing songs.'}]);
admitted(fictionMusic.records,'rhythm of the road|2011','88001');
const ambiguous=await resolve(candidate('The Concert',2009,119,{categories:['Фильм']}),[{id:19406,title:'The Concert',year:2009,runtime:119,genres:[{id:10402,name:'Music'}],overview:'A synopsis.'}]);
withheld(ambiguous.records,'the concert|2009',19406,'concert_recording_ambiguous');
const tvMovie=await resolve(candidate('Made For Television',1999,96,{categories:['Концерт']}),[{id:7001,title:'Made For Television',year:1999,runtime:96,genres:[{id:10770,name:'TV Movie'}]}]);
admitted(tvMovie.records,'made for television|1999','7001');
const tvConcert=await resolve(candidate('Hall Live at the Arena',1998,90,{categories:['Концерт']}),[{id:7102,title:'Hall Live at the Arena',year:1998,runtime:90,genres:[{id:10770,name:'TV Movie'}],overview:'A filmed live performance of the tour.'}]);
withheld(tvConcert.records,'hall live at the arena|1998',7102,'concert_recording');
for(const categories of [['Фильм'],[]]){
 const tvProven=await resolve(candidate('Hall Live at the Arena',1998,90,{categories}),[{id:7104,title:'Hall Live at the Arena',year:1998,runtime:90,genres:[{id:10770,name:'TV Movie'}],overview:'A filmed live performance of the tour.'}]);
 withheld(tvProven.records,'hall live at the arena|1998',7104,'concert_recording');
}
const tvEmptyGenre=await resolve(candidate('Hall Live at the Arena',1998,90,{categories:['Фильм']}),[{id:7108,title:'Hall Live at the Arena',year:1998,runtime:90,genres:[],overview:'A filmed live performance of the tour.'}]);
withheld(tvEmptyGenre.records,'hall live at the arena|1998',7108,'concert_recording');
const tvTitleOnly=await resolve(candidate('Hall Live at the Arena',1998,90,{categories:['Фильм']}),[{id:7109,title:'Hall Live at the Arena',year:1998,runtime:90,genres:[{id:10770,name:'TV Movie'}],overview:'A synopsis.'}]);
admitted(tvTitleOnly.records,'hall live at the arena|1998','7109');
const summer=await resolve(candidate('Summer Notes',2014,102,{categories:['Фильм']}),[{id:88011,title:'Summer Notes',year:2014,runtime:102,genres:[{id:10402,name:'Music'}],overview:'Two musicians live in Paris and form a band.'}]);
admitted(summer.records,'summer notes|2014','88011');
const quiet=await resolve(candidate('Quiet Days',2014,102,{categories:['Фильм']}),[{id:88012,title:'Quiet Days',year:2014,runtime:102,genres:[{id:10402,name:'Music'}],overview:'The singers live above the club and write songs.'}]);
admitted(quiet.records,'quiet days|2014','88012');

{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-air-501-'));
 const file=path.join(root,'d1.sqlite');
 const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
 const applied=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(applied.status!==0)throw new Error(applied.stderr||'migration failed');
 sqliteSync(['-bail',file],{input:"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1;",encoding:'utf8'});
 const RUN='run-501';
 const db=d1Standin(file);
 const env={DB:db,BUCKET:new MemoryBucket(),discoveryLease:null,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
 const lease=(await Authority.acquireLease(env,{programmeRunId:RUN})).lease;
 env.discoveryLease=lease;
 const catalog=[
  {id:1326142,title:'Robbie Williams: Live at the Apple Music Festival',year:2016,runtime:82,genres:[{id:10402,name:'Музыка'}],categories:['Концерт']},
  {id:51497,title:'Free Solo',year:2018,runtime:100,genres:[{id:99,name:'Documentary'}],categories:['Фильм']},
  {id:18648,title:'Pink Floyd Live At Pompeii',year:1972,runtime:92,genres:[{id:10402,name:'Music'}],categories:[]},
  {id:424694,title:'Bohemian Rhapsody',year:2018,runtime:134,genres:[{id:18,name:'Drama'},{id:10402,name:'Music'}],categories:['Фильм'],overview:'The story of Freddie Mercury and Queen, including their Live Aid concert.'},
  {id:7104,title:'Hall Live at the Arena',year:1998,runtime:90,genres:[{id:10770,name:'TV Movie'}],categories:['Фильм'],overview:'A filmed live performance of the tour.'},
  {id:7106,title:'Hall Live at the Arena',year:1997,runtime:90,genres:[{id:10770,name:'TV Movie'}],categories:[],overview:'A filmed live performance of the tour.'},
  {id:7108,title:'Hall Live at the Arena',year:1996,runtime:90,genres:[],categories:['Фильм'],overview:'A filmed live performance of the tour.'}
 ];
 const items=catalog.map(movie=>candidate(movie.title,movie.year,movie.runtime,{categories:movie.categories}));
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease,items:(async function*(){for(const item of items)yield item;})()});
 const context=vm.createContext({console,Date,Promise,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
  fetch(url){const text=decodeURIComponent(String(url)).replace(/\+/g,' ');const movie=catalog.find(item=>text.includes('/movie/'+item.id)||(text.includes(item.title)&&(text.includes('year='+item.year)||!text.includes('search/movie'))));if(!movie)return Promise.resolve(new Response(JSON.stringify({results:[]}),{status:200}));if(text.includes('/movie/'+movie.id))return Promise.resolve(movieDetail(movie.id,movie.title,movie.year,movie.runtime,movie.genres,movie.overview));return Promise.resolve(searchHit(movie.id,movie.title,movie.year));},
  DiscoveryAuthority:Authority,pinEpg:async value=>value,refreshPredictionQueue:async()=>null,
  loadJSON:async(target,key)=>{if(key==='programme.json')return {runId:RUN,films:[]};if(key==='epg/published-generation.json')return {phase:'published',programmeRunId:RUN};const routed=await Authority.routeRead(target,key);return routed.handled?routed.value:null;},
  saveJSON:async(target,key,value)=>{const routed=await Authority.routeWrite(target,key,value);if(!routed.handled)throw new Error('not stored');}});
 for(const fileName of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(fileName,'utf8'),context);
 const result=await context.resolveDiscoveryChunk(env,{films:[]},8,lease);
 assert.equal(result.paged,true);
 assert.equal(result.error,null);
 const stored=(await Authority.routeRead(env,'epg/discovery-resolution.json')).value;
 const admissions=(await Authority.routeRead(env,'epg/discovered-films.json')).value||{};
 assert.equal(stored[items[0].key].reason,'concert_recording');
 assert.equal(stored[items[1].key].reason,'documentary_excluded');
 assert.equal(stored[items[2].key].reason,'concert_recording');
 assert.equal(stored[items[3].key].status,'verified');
 assert.equal(admissions.tmdb_1326142,undefined);
 assert.equal(admissions.tmdb_51497,undefined);
 assert.equal(admissions.tmdb_18648,undefined);
 assert.equal(admissions.tmdb_424694.canonicalIdentity,'tmdb:424694');
 assert.equal(stored['hall live at the arena|1998'].reason,'concert_recording');
 assert.equal(admissions.tmdb_7104,undefined);
 assert.equal(stored['hall live at the arena|1997'].reason,'concert_recording');
 assert.equal(admissions.tmdb_7106,undefined);
 assert.equal(stored['hall live at the arena|1996'].reason,'concert_recording');
 assert.equal(admissions.tmdb_7108,undefined);
 const authority=db.sql("SELECT mode, cutover, programme_run_id FROM published_epg_authority WHERE id=1")[0];
 assert.equal(authority.mode,'r2');
 assert.equal(authority.programme_run_id,null);
 assert.equal(db.sql('SELECT COUNT(*) AS n FROM prediction_queue')[0].n,0);
 assert.equal(db.sql("SELECT COUNT(*) AS n FROM published_epg_show")[0].n,0);
 await Authority.releaseLease(env,lease);
}

const queueCatalog={
 tmdb_1:{id:'tmdb_1',tmdbId:'1',title:'A Life',genres:['документальный']},
 tmdb_2:{id:'tmdb_2',tmdbId:'2',title:'Hall Live at Arena',genres:['музыка'],overview:'A concert recording filmed live on stage.'},
 tmdb_3:{id:'tmdb_3',tmdbId:'3',title:'A Drama',genres:['драма']},
};
const queued=vm.runInContext('allEnrichmentFilms('+JSON.stringify({films:[{id:'tmdb_1',tmdbId:'1',title:'A Life',genres:['документальный']}]})+','+JSON.stringify(queueCatalog)+')',partsLive);
assert.equal(queued.length,1);
assert.equal(String(queued[0].id),'tmdb_3');

console.log('Documentary and concert-recording admission: excluded identities withheld on R2 and D1, fiction admitted, EPG generation unchanged');
