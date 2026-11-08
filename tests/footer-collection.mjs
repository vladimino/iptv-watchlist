// AIR-389: the collection and "new and interesting" blocks of the compact footer. Fixtures only; the route is a pure read.
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
const now=Date.parse('2026-10-13T09:30:00Z');
class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const context=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date:Clock,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,INITIAL_PERSONAL_RATINGS:{}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);

const pred=(id,rating,{probability=.8,confidence='high',version=7,profileHash='profile-7',extra={}}={})=>({fingerprintHash:'fp-'+id,impactFeatures:{fingerprintHash:'fp-'+id,fingerprintSchemaVersion:1,fingerprintPromptVersion:1},prediction:{predictedRating:rating,probability4Plus:probability,confidence,tasteProfileVersion:version,tasteProfileHash:profileHash,fingerprintHash:'fp-'+id,fingerprintSchemaVersion:1,predictionPromptVersion:1,...extra}});
const film=(id,tmdbId,extra={})=>({id,tmdbId:tmdbId==null?undefined:String(tmdbId),title:id,original:id,year:2020,genres:[],actors:[],directors:[],shows:[],...extra});
const verified=(id,tmdbId,extra={})=>({...film(id,tmdbId,extra),canonicalIdentity:'tmdb:'+tmdbId});
function seed({catalog={},watchlist=[],programme=[],index={},metadata={},profile=true,seedRatings={},watchlistObject}={}){
 records.clear();writes.length=0;context.INITIAL_PERSONAL_RATINGS=seedRatings;
 if(profile)records.set('enrichment/profile/current.json',{version:7,updatedAt:'2026-10-12T18:00:00Z',profileHash:'profile-7',profile:{}});
 records.set('programme.json',{runId:'programme-1',updatedAt:'2026-10-13T08:00:00Z',watchlistCount:watchlist.length,films:programme,stats:{}});
 records.set('epg/discovered-films.json',catalog);
 if(watchlistObject!==null)records.set('watchlist.json',watchlistObject||{updatedAt:'2026-10-13T07:55:00Z',films:watchlist});
 if(metadata!==null)records.set('metadata.json',metadata);
 records.set('enrichment/view-index.json',index);
}
const read=async()=>{const response=await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env);assert.equal(response.status,200);return response.json();};

// ---- Collection ----
seed();
let data=await read();
assert.deepEqual(data.collection,{state:'ok',total:0,watched:0,rated:0,watchlist:0},'an empty collection is zeros with a known state');
assert.deepEqual(data.recommendations.newUnseen,{state:'ok',rating40to44:0,rating45plus:0});

// Overlap, not sum: one film is watchlisted, watched and rated at once; the same film appears under a Letterboxd id and a catalog id.
seed({
 watchlist:[film('lid-a',1),film('lid-b',2),film('lid-c',null)],programme:[film('lid-a',1)],
 catalog:{tmdb_1:verified('tmdb_1',1),tmdb_5:verified('tmdb_5',5),tmdb_6:verified('tmdb_6',6)},
 index:{'lid-a':{watched:true,actualRating:4.5},'lid-b':{watched:true},'lid-z':{actualRating:3},tmdb_6:{watched:true},'lid-orphan':{watched:true,actualRating:2}},
});
data=await read();
// Films: lid-a=tmdb:1 (with catalog tmdb_1), lid-b=tmdb:2, lid-c (no tmdb) = id:lid-c, tmdb_5, tmdb_6, lid-z (unlinked) , lid-orphan (unlinked).
assert.deepEqual(data.collection,{state:'ok',total:7,watched:4,rated:3,watchlist:3},JSON.stringify(data.collection));
assert.ok(data.collection.watched<=data.collection.total&&data.collection.rated<=data.collection.total&&data.collection.watchlist<=data.collection.total,'no counter exceeds the total');
assert.ok(data.collection.watchlist+data.collection.watched>data.collection.total-1,'counters overlap and are not a partition');

// A TMDB key and a Letterboxd id of the same film count once only when stored records link them.
seed({watchlist:[film('lid-a',1)],catalog:{tmdb_1:verified('tmdb_1',1)},index:{'lid-a':{watched:true},tmdb_1:{actualRating:4}}});
data=await read();
assert.deepEqual([data.collection.total,data.collection.watched,data.collection.rated],[1,1,1],'one film under two ids, linked by the stored lid->tmdb record');
seed({watchlist:[film('lid-a',null)],catalog:{tmdb_1:verified('tmdb_1',1)},index:{'lid-a':{watched:true},tmdb_1:{actualRating:4}}});
data=await read();
assert.deepEqual([data.collection.total,data.collection.watched,data.collection.rated],[2,1,1],'without a stored link nothing is merged: no TMDB↔LID is invented');
// A Letterboxd id with two different TMDB ids links to neither.
seed({watchlist:[film('lid-a',1)],programme:[film('lid-a',2)],catalog:{tmdb_1:verified('tmdb_1',1),tmdb_2:verified('tmdb_2',2)},index:{'lid-a':{watched:true}}});
data=await read();
assert.deepEqual([data.collection.total,data.collection.watched],[3,1],'a conflicting lid stays its own film');

// Ratings without any Diary or view-index entry come from the compiled seed.
seed({seedRatings:{'lid-seed':4,'lid-seed2':5},index:{}});
data=await read();
assert.deepEqual([data.collection.rated,data.collection.watched,data.collection.total],[2,0,2],'seeded ratings count as rated films; no watched fact is invented from a rating');
// An explicit null rating in the index wins over the seed.
seed({seedRatings:{'lid-x':4},index:{'lid-x':{actualRating:null}}});
data=await read();
assert.equal(data.collection.rated,0);
// "Not on the watchlist" and "no Diary" are not watched.
seed({watchlist:[film('lid-a',1)],catalog:{tmdb_9:verified('tmdb_9',9)},index:{}});
data=await read();
assert.deepEqual([data.collection.watched,data.collection.rated],[0,0],'no facts means zero watched, with a known state');
// A TV id is its own namespace.
seed({index:{'tmdb_tv_5':{watched:true},tmdb_5:{watched:true}}});
data=await read();
assert.equal(data.collection.watched,2,'tmdb_tv_5 is not tmdb:5');

// Unavailable sources are unknown, never 0.
seed({watchlistObject:null});
data=await read();
assert.deepEqual(data.collection,{state:'unknown',total:null,watched:null,rated:null,watchlist:null},'no watchlist object: unknown');
seed({watchlistObject:{films:'nope'}});
data=await read();assert.equal(data.collection.state,'unknown');
seed({});records.delete('enrichment/view-index.json');
data=await read();assert.equal(data.collection.state,'unknown','no view index: unknown');assert.equal(data.recommendations.newUnseen.state,'unknown');

// Ratings are numbers. null, '', false and strings are not ratings, in the index and in the compiled seed, and a cleared rating never excludes a candidate.
seed({seedRatings:{'lid-null':null,'lid-empty':'','lid-false':false,'lid-string':'4','lid-nan':NaN,'lid-ok':3.5,'lid-zero':0},index:{'lid-idx-null':{actualRating:null},'lid-idx-empty':{actualRating:''},'lid-idx-false':{actualRating:false},'lid-idx-ok':{actualRating:5}}});
data=await read();
assert.equal(data.collection.rated,3,'only 3.5, 0 (a real, finite number) and 5 are ratings: '+JSON.stringify(data.collection));
seed({catalog:{tmdb_60:verified('tmdb_60',60)},metadata:{'lid-60':{id:'lid-60',tmdbId:'60'}},index:{tmdb_60:pred('60',4.8),'lid-60':{actualRating:null}},seedRatings:{'lid-60':null}});
data=await read();
assert.equal(data.recommendations.newUnseen.rating45plus,1,'a cleared (null) rating, in the index or the seed, does not exclude a new film');
seed({catalog:{tmdb_60:verified('tmdb_60',60)},metadata:{'lid-60':{id:'lid-60',tmdbId:'60'}},index:{tmdb_60:pred('60',4.8)},seedRatings:{'lid-60':''}});
data=await read();assert.equal(data.recommendations.newUnseen.rating45plus,1,'an empty seed value is not a rating');
seed({catalog:{tmdb_60:verified('tmdb_60',60)},metadata:{'lid-60':{id:'lid-60',tmdbId:'60'}},index:{tmdb_60:pred('60',4.8)},seedRatings:{'lid-60':4}});
data=await read();assert.equal(data.recommendations.newUnseen.rating45plus,0,'a real seeded rating on the linked id excludes it');

// The metadata cache links identities no other record links: without it the blocks are unknown, never "ok".
const linked={catalog:{tmdb_41:verified('tmdb_41',41)},index:{tmdb_41:pred('41',4.8),'lid-41':{watched:true}}};
seed({...linked,metadata:{'lid-41':{id:'lid-41',tmdbId:'41'}}});
data=await read();assert.deepEqual(data.recommendations.newUnseen,{state:'ok',rating40to44:0,rating45plus:0},'with the metadata link the watched film is not new');
seed({...linked,metadata:null});
data=await read();
assert.equal(data.recommendations.newUnseen.state,'unknown','metadata absent: the watched film is not counted as new');assert.equal(data.recommendations.newUnseen.rating45plus,null);
assert.deepEqual(data.collection,{state:'unknown',total:null,watched:null,rated:null,watchlist:null},'metadata absent: the collection is unknown');
// An unreadable metadata object (a read that fails) is the same.
seed({...linked});records.set('metadata.json',{});
{
 const failing={BUCKET:{...env.BUCKET,async get(key){if(key==='metadata.json')throw new Error('r2 down');return env.BUCKET.get.call(env.BUCKET,key);}}};
 const response=await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),failing);
 assert.equal(response.status,200,'a metadata failure does not fail the footer');
 const failed=await response.json();
 assert.equal(failed.recommendations.newUnseen.state,'unknown');assert.equal(failed.collection.state,'unknown');
 assert.ok(failed.coverage&&failed.integrations,'the rest of the footer is intact');
}
// An empty, readable metadata cache is a real "nothing is linked".
seed({...linked,metadata:{}});
data=await read();assert.equal(data.collection.state,'ok');assert.equal(data.recommendations.newUnseen.rating45plus,1,'without a stored link the unlinked watched id is not taken for this film');
// A non-object metadata value is not readable.
seed({...linked,metadata:[]});data=await read();assert.equal(data.collection.state,'unknown');

// ---- New and interesting ----
const catalog4={
 tmdb_10:verified('tmdb_10',10),tmdb_11:verified('tmdb_11',11),tmdb_12:verified('tmdb_12',12),tmdb_13:verified('tmdb_13',13),tmdb_14:verified('tmdb_14',14),tmdb_15:verified('tmdb_15',15),
 tmdb_16:verified('tmdb_16',16),tmdb_17:verified('tmdb_17',17),tmdb_18:verified('tmdb_18',18),tmdb_19:verified('tmdb_19',19),tmdb_20:verified('tmdb_20',20),tmdb_21:verified('tmdb_21',21),
};
const unverified={...film('tmdb_30',30),canonicalIdentity:null};
seed({
 catalog:{...catalog4,tmdb_30:unverified},
 watchlist:[film('lid-w',16)],
 index:{
  tmdb_10:pred('10',4.0),                           // 4.0: lower range
  tmdb_11:pred('11',4.49),                          // still lower
  tmdb_12:pred('12',4.5),                           // upper range
  tmdb_13:pred('13',4.9),                           // upper
  tmdb_14:pred('14',3.9),                           // below the floor
  tmdb_15:pred('15',4.7,{probability:.69}),         // chance too low
  tmdb_16:pred('16',4.8),                           // on the watchlist (linked by stored id)
  tmdb_17:{...pred('17',4.8),watched:true},         // watched
  tmdb_18:{...pred('18',4.8),actualRating:3},       // rated
  tmdb_19:pred('19',4.8,{version:6,profileHash:'old'}), // not current for the profile
  tmdb_20:pred('20',4.8,{confidence:'low'}),        // low confidence
  tmdb_21:{...pred('21',4.8),watchlist:false},      // a watchlist fact, either value, is membership
  tmdb_30:pred('30',4.9),                           // unverified identity
 },
});
data=await read();
assert.deepEqual(data.recommendations.newUnseen,{state:'ok',rating40to44:2,rating45plus:2},JSON.stringify(data.recommendations.newUnseen));
// The thresholds do not overlap.
assert.equal(data.recommendations.newUnseen.rating40to44+data.recommendations.newUnseen.rating45plus,4);

// Duplicate records of one identity count once, at the best current prediction.
seed({catalog:{tmdb_40:verified('tmdb_40',40),alias_40:{...verified('alias_40',40)}},index:{tmdb_40:pred('40',4.0),alias_40:pred('a40',4.8)}});
data=await read();
assert.deepEqual(data.recommendations.newUnseen,{state:'ok',rating40to44:0,rating45plus:1},'one film, the best current prediction decides the range');
// An unlinked watched fact under a Letterboxd id does not hide a catalog film (no invented link), a linked one does.
seed({catalog:{tmdb_41:verified('tmdb_41',41)},index:{tmdb_41:pred('41',4.8),'lid-41':{watched:true}}});
data=await read();assert.equal(data.recommendations.newUnseen.rating45plus,1,'an unlinked watched id is not taken for this film');
seed({catalog:{tmdb_41:verified('tmdb_41',41)},watchlist:[film('lid-41',41,{})],index:{tmdb_41:pred('41',4.8)}});
data=await read();assert.equal(data.recommendations.newUnseen.rating45plus,0,'on the watchlist through the stored link');
seed({catalog:{tmdb_41:verified('tmdb_41',41)},metadata:{'lid-41':{id:'lid-41',tmdbId:'41'}},index:{tmdb_41:pred('41',4.8),'lid-41':{watched:true}}});
data=await read();assert.equal(data.recommendations.newUnseen.rating45plus,0,'watched through a link the metadata cache stores');
// A changed taste profile makes every older prediction not current.
seed({catalog:{tmdb_42:verified('tmdb_42',42)},index:{tmdb_42:pred('42',4.8)}});
records.set('enrichment/profile/current.json',{version:8,updatedAt:'2026-10-13T08:00:00Z',profileHash:'profile-8',profile:{}});
data=await read();assert.deepEqual(data.recommendations.newUnseen,{state:'ok',rating40to44:0,rating45plus:0},'stale for the new taste version: not counted, not unknown');
// No profile: unknown.
seed({catalog:{tmdb_42:verified('tmdb_42',42)},index:{tmdb_42:pred('42',4.8)},profile:false});
data=await read();assert.equal(data.recommendations.newUnseen.state,'unknown');
// An unreadable watchlist makes the new-film count unknown rather than too large.
seed({catalog:{tmdb_42:verified('tmdb_42',42)},index:{tmdb_42:pred('42',4.8)},watchlistObject:null});
data=await read();assert.equal(data.recommendations.newUnseen.state,'unknown');

// ---- Read only, and the legacy fields stay ----
seed({catalog:catalog4,index:{tmdb_10:pred('10',4.2)},watchlist:[film('lid-w',1)]});
writes.length=0;data=await read();
assert.deepEqual(writes,[],'the footer GET writes nothing');
for(const key of ['schemaVersion','generatedAt','profile','coverage','predictions','epgTmdb','watchlist','lastRun','integrations'])assert.ok(Object.hasOwn(data,key),'legacy field kept: '+key);
assert.equal(data.schemaVersion,1);
console.log('Footer collection: one film per verified identity (no invented TMDB↔LID link), watched/rated/watchlist overlap and never exceed the total, unknown is not zero, new-film counts follow the Finds floor in two non-overlapping ranges and ignore watchlisted, consumed, stale, low-confidence and unverified films, and the route stays a read passed');
