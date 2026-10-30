// Finds exclude every film the owner has watched or rated by identity, whatever id the catalog record uses: watched-unrated
// films, ratings keyed by the Letterboxd id while the catalog uses tmdb_<n>, in index entries written before the facts model
// (legacy index) and in the projection from fact records; the retired LETTERBOXD_FACTS (ADR 0054) changes nothing. A namesake or remake is never suppressed by title, a conflicting stored id bridges nothing,
// and the GET writes nothing. Synthetic data only.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,puts=[],fetches=[];
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};},
 async delete(key){puts.push('delete:'+key);records.delete(key);},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key,customMetadata:{}})),truncated:false};}
};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',context);
const worker=context.worker,constant=name=>vm.runInContext(name,context),VIEW=constant('ENRICHMENT_KEY')+'view-index.json';
const get=async env=>{const response=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/available'),env,{waitUntil(){}});return {status:response.status,body:await response.json()};};
const ids=body=>body.films.map(film=>film.id).sort();

const hour=3600000,now=Date.now(),G1='22222222-2222-4222-8222-222222222222',profile={version:1,profileHash:'p1'};
const current=(rating=4.5)=>({prediction:{predictedRating:rating,probability4Plus:.9,confidence:'high',matchSignals:[],mainRisk:null,tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1},fingerprintHash:'f',impactFeatures:{fingerprintHash:'f',fingerprintSchemaVersion:1,fingerprintPromptVersion:1},fingerprint:{fingerprintHash:'f',plotMechanics:[],execution:{}}});
const film=(id,tmdbId,title,year)=>({id,tmdbId:String(tmdbId),canonicalIdentity:'tmdb:'+tmdbId,title,original:title,year,runtime:100,genres:[],poster:null,url:null,directors:[],actors:[],shows:[{channelId:'c1',channel:'One',start:now-hour,end:now+hour}],showsProgrammeRunId:G1});
const CATALOG={
 tmdb_593:film('tmdb_593',593,'Solaris',1972),   // rated, rating keyed by Letterboxd id "solaris-1972"
 tmdb_2103:film('tmdb_2103',2103,'Solaris',2002), // remake with the same title, never rated
 tmdb_700:film('tmdb_700',700,'Twin',2000),       // rated Letterboxd id whose stored TMDB ids disagree
 tmdb_801:film('tmdb_801',801,'Seen',2010),       // watched, not rated
 tmdb_802:film('tmdb_802',802,'Rated',2011),      // rated, fact record keyed by the Letterboxd id only
 tmdb_803:film('tmdb_803',803,'Unmarked',2012),   // owner set watched: false, no rating
 tmdb_804:film('tmdb_804',804,'Rerated',2013),    // owner set watched: false, rating kept
 tmdb_805:film('tmdb_805',805,'Plain',2014),      // nothing known
 tmdb_42:film('tmdb_42',42,'Rewatch',1999),       // watched and on the watchlist again
};
function seed({index={},metadata=null}={}){
 records.clear();etags.clear();puts=[];fetches.length=0;
 const put=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
 put('epg/published-generation.json',{phase:'published',programmeRunId:G1});
 put('epg/generations/'+G1+'/programme.json',{runId:G1,films:[{id:'rewatch-1999',tmdbId:'42',title:'Rewatch'}]});
 put('epg/generations/'+G1+'/discovered-films.json',CATALOG);
 put('watchlist.json',{films:[{id:'rewatch-1999',tmdbId:'42',title:'Rewatch'}]});
 put(constant('profileKey'),profile);
 put(VIEW,{...Object.fromEntries(Object.keys(CATALOG).map(id=>[id,current(5)])),...index});
 if(metadata)put('metadata.json',metadata);
}
const metadata={'solaris-1972':{id:'solaris-1972',tmdbId:'593',title:'Solaris',year:1972},twin:{id:'twin',tmdbId:'700'},'twin-copy':{id:'twin',tmdbId:'701'}};
const snapshot=()=>JSON.stringify([...records.entries()].sort());

// 1. Legacy index (entries written before the facts model): ratings keyed by Letterboxd ids. The stored TMDB id bridges the rating to the
// tmdb_<n> catalog record; a remake with the same title stays; a Letterboxd id with two stored TMDB ids bridges nothing.
{
 seed({metadata,index:{'solaris-1972':{actualRating:4},twin:{actualRating:3}}});
 const before=snapshot(),r=await get({BUCKET:bucket});
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.ok(!ids(r.body).includes('tmdb_593'),'rating keyed by the Letterboxd id excludes the tmdb_ catalog record');
 assert.ok(ids(r.body).includes('tmdb_2103'),'a remake with the same title is not suppressed');
 assert.ok(ids(r.body).includes('tmdb_700'),'a Letterboxd id whose stored TMDB ids disagree is not bridged');
 assert.ok(!ids(r.body).includes('tmdb_42'),'watchlist exclusion is unchanged');
 assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);assert.equal(snapshot(),before,'GET writes nothing');
}
// The bridge also comes from the watchlist and from a verified catalog record carrying the Letterboxd id.
{
 const catalog={...CATALOG,'solaris-1972':{...film('solaris-1972',593,'Solaris',1972)}};
 seed({index:{'solaris-1972':{actualRating:4}}});
 records.set('epg/generations/'+G1+'/discovered-films.json',catalog);
 const r=await get({BUCKET:bucket});
 assert.ok(!ids(r.body).some(id=>id==='tmdb_593'||id==='solaris-1972'),'both catalog records of the rated film are excluded');
 assert.ok(ids(r.body).includes('tmdb_2103'));
}
// An existing actualRating under the catalog id excludes as before; actualRating null (unrated watchlist entry) does not.
{
 seed({index:{tmdb_805:{...current(5),actualRating:null},tmdb_2103:{...current(5),actualRating:4.5}}});
 const r=await get({BUCKET:bucket});
 assert.ok(ids(r.body).includes('tmdb_805'));assert.ok(!ids(r.body).includes('tmdb_2103'));
}

// 2. Projection from fact records: watched, watched-unrated and rated films under every alias.
{
 seed({metadata:{'rated-2011':{id:'rated-2011',tmdbId:'802'}}});
 const env={BUCKET:bucket},observedAt=new Date(now-hour).toISOString(),written=[];
 const facts=async(links,values,source='letterboxd_export')=>{
  const factKey=await Facts.linkFilm(env,links);
  const observations=[];for(const [fact,value] of Object.entries(values))observations.push({fact,observation:await Facts.observation({factKey,fact,value,observedAt,source,sourceRef:'synthetic'})});
  written.push((await Facts.recordObservations(env,factKey,links,observations)).record);
 };
 await facts({letterboxd:'seen-2010',tmdb:'801'},{watched:true,rating:null});
 await facts({letterboxd:'rated-2011'},{watched:true,rating:4});
 await facts({letterboxd:'unmarked-2012',tmdb:'803'},{watched:false},'owner');
 await facts({letterboxd:'rerated-2013',tmdb:'804'},{watched:false,rating:3.5},'owner');
 await facts({letterboxd:'rewatch-1999',tmdb:'42'},{watched:true,rating:5,watchlist:true});
 await Facts.projectRecords(env,written);
 const view=records.get(VIEW);
 assert.equal(view['seen-2010'].watched,true);assert.equal(view.tmdb_801.watched,true);assert.equal(view.tmdb_801.actualRating,null);
 assert.equal(view['rated-2011'].actualRating,4);assert.equal(view.tmdb_802.actualRating,undefined,'a record without a TMDB link projects under the Letterboxd id only');
 assert.equal(view.tmdb_801.prediction.predictedRating,5,'a 5.0 prediction is still stored for the watched film');
 const watchlist=JSON.stringify(records.get('watchlist.json'));
 for(const flag of [undefined,'on','off','On']){
  puts=[];const before=snapshot(),r=await get(flag===undefined?{BUCKET:bucket}:{BUCKET:bucket,LETTERBOXD_FACTS:flag});
  assert.equal(r.status,200);
  assert.deepEqual(ids(r.body),['tmdb_2103','tmdb_593','tmdb_700','tmdb_803','tmdb_805'],'flag '+flag+': watched, watched-unrated and rated films are excluded by identity');
  assert.ok(r.body.films.every(item=>item.prediction.predictedRating===5));
  assert.doesNotMatch(JSON.stringify(r.body),/actualRating|"watched"/,'DTO unchanged');
  assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);assert.equal(snapshot(),before,'flag '+flag+': GET writes nothing');
 }
 assert.equal(JSON.stringify(records.get('watchlist.json')),watchlist,'a rewatch stays on the watchlist');
 assert.equal(records.get('watchlist.json').films[0].id,'rewatch-1999');
}

// 3. No view index, no metadata, no fact records: the list is empty (nothing current), nothing is written.
{
 seed();records.delete(VIEW);
 const r=await get({BUCKET:bucket});
 assert.equal(r.status,200);assert.equal(r.body.total,0);assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
}
// No metadata and no facts, legacy index only: unrated films are offered, nothing is bridged or written.
{
 seed({index:{'solaris-1972':{actualRating:4}}});
 const r=await get({BUCKET:bucket});
 assert.ok(ids(r.body).includes('tmdb_593'),'without a stored TMDB id the Letterboxd id is matched by its own id only');
 assert.deepEqual(puts,[]);
}

console.log('catalog-available-user-facts: ok');
