// Read-only catalog of available films outside the watchlist: pinned generation, verified identity, real shows in
// the 72h catch-up or next 24h, current prediction for the current profile, watchlist and rating exclusions,
// one entry per canonical identity, no storage write and no outbound request.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const records=new Map();let puts=[],fetches=[];
const bucket={
 async get(key){return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value){records.set(key,JSON.parse(value));puts.push(key);return {etag:'e'};},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key,customMetadata:{}})),truncated:false};}
};
const env={BUCKET:bucket};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{tmdb_17:3.5},
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),context);
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker,constant=name=>vm.runInContext(name,context);
const get=async()=>{const response=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/available'),env,{waitUntil(){}});return {status:response.status,body:await response.json()};};

const hour=3600000,now=Date.now(),G0='11111111-1111-4111-8111-111111111111',G1='22222222-2222-4222-8222-222222222222',G2='33333333-3333-4333-8333-333333333333';
const profile={version:1,profileHash:'p1'};
const prediction=(extra={})=>({predictedRating:4.5,probability4Plus:.74,confidence:'high',matchSignals:['Investigation'],mainRisk:'Slow start',moodLabels:['мрачный','напряжённый'],tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1,...extra});
const fingerprint={fingerprintHash:'f',plotMechanics:['investigation'],moodLabels:['мрачный'],execution:{payoff:'strong',pacing:'unknown'}};
const current=(extra={})=>({prediction:prediction(extra),fingerprintHash:'f',impactFeatures:{fingerprintHash:'f',fingerprintSchemaVersion:1,fingerprintPromptVersion:1},fingerprint});
const show=(start,extra={})=>({channelId:'c1',channel:'One',start,end:start+2*hour,...extra});
const film=(id,tmdbId,shows,extra={})=>({id,tmdbId:String(tmdbId),canonicalIdentity:'tmdb:'+tmdbId,title:'Film '+id,original:'Original '+id,year:2020,runtime:100,genres:['Драма'],poster:'https://image.tmdb.org/t/p/w342/'+id+'.jpg',url:'https://www.themoviedb.org/movie/'+tmdbId,synopsis:'SYNOPSIS-'+id,aliases:['ALIAS-'+id],directors:[{id:'tmdb_director/1',name:'Director',original:'Director'}],actors:[{id:'tmdb_actor/2',name:'Actor',original:'Actor'}],shows,showsProgrammeRunId:G1,discoveredAt:new Date(now-86400000).toISOString(),...extra});

const CATALOG_KEYS=['epg/discovered-films.json','epg/generations/'+G1+'/discovered-films.json'],PROGRAMME_KEYS=['programme.json','epg/generations/'+G1+'/programme.json'];
const setCatalog=value=>{for(const key of CATALOG_KEYS)records.set(key,structuredClone(value));};
const catalogRecord=id=>records.get('epg/generations/'+G1+'/discovered-films.json')[id];
const setCatalogShows=(id,shows)=>{for(const key of CATALOG_KEYS)records.get(key)[id].shows=structuredClone(shows);};
function seed(){
 records.clear();puts=[];fetches.length=0;
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:G1});
 for(const key of PROGRAMME_KEYS)records.set(key,{runId:G1,updatedAt:new Date(now).toISOString(),watchlistCount:1,films:[{id:'w1',tmdbId:'42',title:'Watchlist Film',shows:[show(now-hour)]}],stats:{}});
 records.set('watchlist.json',{updatedAt:new Date(now).toISOString(),films:[{id:'w1',tmdbId:'42',title:'Watchlist Film'},{id:'w2',tmdbId:'43',title:'Unscheduled watchlist film'}]});
 records.set(constant('profileKey'),profile);
 setCatalog({
  tmdb_42:film('tmdb_42',42,[show(now-hour)]),                                   // watchlist identity by tmdb id
  tmdb_43:film('tmdb_43',43,[show(now-hour)]),                                   // watchlist identity without a programme show
  tmdb_7:film('tmdb_7',7,[show(now-3*hour),show(now+2*hour,{channelId:'c2',channel:'Two'}),show(now-3*hour)]),
  tmdb_8:film('tmdb_8',8,[show(now-hour)]),                                      // stale prediction
  tmdb_9:film('tmdb_9',9,[]),                                                      // no shows
  tmdb_10:film('tmdb_10',10,[show(now-hour)],{showsProgrammeRunId:G0}),           // shows of an earlier generation
  tmdb_11:film('tmdb_11',11,[show(now-hour)]),                                    // rated
  tmdb_13:film('tmdb_13',13,[show(now-72*hour-60000),show(now+24*hour+60000)]),   // both shows just outside the window
  tmdb_14:film('tmdb_14',7,[show(now-10*hour)]),                                  // same identity as tmdb_7, earlier availability
  tmdb_15:film('tmdb_15',15,[show(now+23*hour)]),                                 // future only
  tmdb_16:film('tmdb_16',16,[show(now-hour)],{canonicalIdentity:null}),           // unverified identity
  tmdb_17:film('tmdb_17',17,[show(now-hour)]),                                    // rated through the seed only
  tmdb_18:film('tmdb_18',18,[show(now-30*60000)]),                                // on air
  tmdb_19:film('tmdb_19',19,[show(now-hour)]),                                    // no prediction at all
 });
 records.set(constant('ENRICHMENT_KEY')+'view-index.json',{
  tmdb_42:current(),tmdb_43:current(),tmdb_7:current(),tmdb_8:current({tasteProfileHash:'old'}),tmdb_9:current(),tmdb_10:current(),tmdb_11:{...current(),actualRating:4},tmdb_13:current(),tmdb_14:current(),tmdb_15:current(),tmdb_16:current(),tmdb_17:current(),tmdb_18:current(),
 });
}

// 1. Eligibility: exactly the verified, unrated, catalog-only films with current predictions and real shows of the pinned generation inside the window.
seed();
let r=await get();
assert.equal(r.status,200,JSON.stringify(r.body));
assert.equal(r.body.programmeRunId,G1);assert.equal(r.body.pinned,true);assert.deepEqual(r.body.profile,{version:1});
assert.equal(Date.parse(r.body.window.to)-Date.parse(r.body.window.from),96*hour);
assert.deepEqual(r.body.films.map(f=>f.id),['tmdb_18','tmdb_7','tmdb_15'],'ordered by availableUntil, then id');
assert.equal(r.body.total,3);
const seven=r.body.films[1];
assert.deepEqual(Object.keys(seven).sort(),['actors','availability','availableNow','availableUntil','canonicalIdentity','directors','fingerprint','genres','id','nextStart','original','poster','prediction','runtime','shows','title','tmdbId','url','year']);
assert.doesNotMatch(JSON.stringify(r.body),/SYNOPSIS-|ALIAS-|tasteProfileHash|moodLabels/,'minimal display DTO: no synopsis, aliases or raw prediction internals');
assert.deepEqual(seven.shows.map(s=>[s.channelId,s.status]),[['c1','archive'],['c2','future']],'duplicate show collapsed, statuses derived from the clock');
assert.equal(seven.availableNow,true);assert.equal(seven.nextStart,now+2*hour);assert.equal(seven.availableUntil,new Date(now+2*hour+72*hour).toISOString());
assert.deepEqual(seven.prediction,{predictedRating:4.5,probability4Plus:.74,confidence:'high',matchSignals:['Investigation'],mainRisk:'Slow start',moodIds:seven.prediction.moodIds});
assert.ok(seven.prediction.moodIds.length>0,'mood ids come from the canonical mood facet');
assert.deepEqual(seven.fingerprint,{plotMechanics:['investigation'],moodIds:seven.prediction.moodIds,execution:{payoff:'strong'}},'fingerprint facet omits unknown execution values');
assert.deepEqual(seven.directors,[{id:'tmdb_director/1',name:'Director'}]);assert.deepEqual(seven.actors,[{id:'tmdb_actor/2',name:'Actor'}]);
assert.equal(seven.canonicalIdentity,'tmdb:7');assert.equal(seven.tmdbId,'7');assert.equal(seven.poster,'https://image.tmdb.org/t/p/w342/tmdb_7.jpg');
const eighteen=r.body.films[0];
assert.deepEqual(eighteen.shows.map(s=>s.status),['on_air']);assert.equal(eighteen.availableNow,true);assert.equal(eighteen.nextStart,null);
const fifteen=r.body.films[2];
assert.deepEqual(fifteen.shows.map(s=>s.status),['future']);assert.equal(fifteen.availableNow,false);assert.equal(fifteen.nextStart,now+23*hour);
assert.deepEqual(r.body.channels,[{channelId:'c1',channel:'One',films:3},{channelId:'c2',channel:'Two',films:1}]);
assert.deepEqual(puts,[],'a read writes nothing, including the ratings seed');assert.deepEqual(fetches,[]);
assert.equal(records.get(constant('ENRICHMENT_KEY')+'view-index.json').tmdb_17.actualRating,undefined,'the seed stays in memory');

// 2. The exclusions, one by one: each excluded film is absent for exactly its reason.
for(const [id,reason] of [['tmdb_42','watchlist identity'],['tmdb_43','watchlist identity without a programme show'],['tmdb_8','stale prediction'],['tmdb_9','no shows'],['tmdb_10','shows of an earlier generation'],['tmdb_11','rated'],['tmdb_13','shows outside the window'],['tmdb_14','duplicate identity with earlier availability'],['tmdb_16','unverified identity'],['tmdb_17','seeded rating'],['tmdb_19','no prediction']])assert.ok(!r.body.films.some(f=>f.id===id),id+' excluded: '+reason);
// The duplicate identity keeps the entry with the later availability, whichever id it has.
seed();setCatalogShows('tmdb_14',[show(now+5*hour)]);
r=await get();assert.deepEqual(r.body.films.filter(f=>f.canonicalIdentity==='tmdb:7').map(f=>f.id),['tmdb_14']);
// An archive show that expires moves the film out without any storage change.
seed();setCatalogShows('tmdb_7',[show(now-71*hour-59*60000)]);setCatalogShows('tmdb_14',[]);setCatalogShows('tmdb_15',[]);
r=await get();assert.ok(r.body.films.some(f=>f.id==='tmdb_7'),'one minute before the 72h boundary the film is still available');
setCatalogShows('tmdb_7',[show(now-72*hour-60000)]);
r=await get();assert.ok(!r.body.films.some(f=>f.id==='tmdb_7'),'one minute after the 72h boundary it is gone');
setCatalogShows('tmdb_7',[show(now+23*hour+59*60000)]);
r=await get();assert.ok(r.body.films.some(f=>f.id==='tmdb_7'),'one minute before the 24h horizon the film is offered as future');
setCatalogShows('tmdb_7',[show(now+24*hour+60000)]);
r=await get();assert.ok(!r.body.films.some(f=>f.id==='tmdb_7'),'one minute past the 24h horizon it is not');

// 3. Profile freshness: a new profile version makes every stored prediction stale, so nothing is offered.
seed();records.set(constant('profileKey'),{version:2,profileHash:'p2'});
r=await get();assert.equal(r.status,200);assert.deepEqual(r.body.films,[]);assert.equal(r.body.total,0);assert.deepEqual(r.body.profile,{version:2});
seed();records.delete(constant('profileKey'));
r=await get();assert.equal(r.status,200);assert.deepEqual(r.body.films,[]);assert.equal(r.body.profile,null,'without a profile no prediction is current');

// 4. Generation pin, strict: the pointer names a generation whose programme copy is not in place yet; nothing is served
//    from the older programme, and the shared public keys are not a fallback even when they claim the new run id.
seed();records.set('epg/published-generation.json',{phase:'published',programmeRunId:G2});
r=await get();assert.equal(r.status,409);assert.deepEqual(r.body,{error:'Programme generation is not in place'});
seed();records.set('epg/published-generation.json',{phase:'published',programmeRunId:G2});records.get('programme.json').runId=G2;
r=await get();assert.equal(r.status,409,'a public programme.json that already carries the new run id is not the pinned copy');assert.deepEqual(r.body,{error:'Programme generation is not in place'});
seed();records.set('epg/published-generation.json',{phase:'published',programmeRunId:G2});
records.set('epg/generations/'+G2+'/programme.json',{runId:G2,updatedAt:new Date(now).toISOString(),watchlistCount:1,films:[{id:'w1',tmdbId:'42',shows:[]}],stats:{}});
for(const key of Object.keys(records.get('epg/discovered-films.json')))records.get('epg/discovered-films.json')[key].showsProgrammeRunId=G2;
r=await get();assert.equal(r.status,409,'a missing catalog copy fails closed even though the public catalog claims the new generation');assert.deepEqual(r.body,{error:'Catalog generation copy is not in place'});
assert.deepEqual(puts,[]);
// The generation copies are read through the pin, so a generation that is in place is served from its own files.
seed();records.set('epg/published-generation.json',{phase:'published',programmeRunId:G2});
records.set('epg/generations/'+G2+'/programme.json',{runId:G2,updatedAt:new Date(now).toISOString(),watchlistCount:1,films:[{id:'w1',tmdbId:'42',shows:[]}],stats:{}});
records.set('epg/generations/'+G2+'/discovered-films.json',{tmdb_7:film('tmdb_7',7,[show(now-hour)],{showsProgrammeRunId:G2}),tmdb_15:film('tmdb_15',15,[show(now+hour)],{showsProgrammeRunId:G1})});
r=await get();assert.equal(r.status,200);assert.equal(r.body.programmeRunId,G2);assert.deepEqual(r.body.films.map(f=>f.id),['tmdb_7'],'a catalog film whose shows still belong to the previous generation is not available in the new one');
// Without a published pointer the programme's own run id is the generation, and the response says it is not pinned.
seed();records.delete('epg/published-generation.json');
r=await get();assert.equal(r.status,200);assert.equal(r.body.pinned,false);assert.equal(r.body.programmeRunId,G1);assert.deepEqual(r.body.films.map(f=>f.id),['tmdb_18','tmdb_7','tmdb_15']);
// No programme at all: pinned, the generation copy is required (409); unpinned, 503.
seed();for(const key of PROGRAMME_KEYS)records.delete(key);
r=await get();assert.equal(r.status,409);assert.deepEqual(r.body,{error:'Programme generation is not in place'});
seed();records.delete('epg/published-generation.json');for(const key of PROGRAMME_KEYS)records.delete(key);
r=await get();assert.equal(r.status,503);assert.deepEqual(r.body,{error:'No published programme'});
// Unpinned, a missing catalog is an empty result; pinned, a missing catalog copy is a 409 (above). A missing view index is empty either way.
seed();records.delete('epg/published-generation.json');records.delete('epg/discovered-films.json');r=await get();assert.equal(r.status,200);assert.deepEqual(r.body.films,[]);
seed();records.delete(constant('ENRICHMENT_KEY')+'view-index.json');r=await get();assert.equal(r.status,200);assert.deepEqual(r.body.films,[]);
// The generation copies are what is read: a public catalog that differs from the pinned copy does not leak in.
seed();records.get('epg/discovered-films.json').tmdb_9.shows=[show(now-hour)];r=await get();assert.ok(!r.body.films.some(f=>f.id==='tmdb_9'),'the public copy is not consulted while a pointer is published');
assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);

// Poster fallback: a catalog record without its own TMDB poster reuses the stored Letterboxd poster of the same identity from metadata.json, never a constructed URL.
const posterless=()=>{for(const key of CATALOG_KEYS){records.get(key).tmdb_7.poster=null;records.get(key).tmdb_18.poster=null;records.get(key).tmdb_15.poster=null;}};
const posterOf=(body,id)=>body.films.find(f=>f.id===id).poster;
seed();posterless();r=await get();assert.equal(r.status,200);assert.equal(posterOf(r.body,'tmdb_7'),null,'without a metadata cache a missing poster stays null');assert.equal(posterOf(r.body,'tmdb_18'),null);
seed();posterless();records.set('metadata.json',{
 'heat-1995':{id:'heat-1995',tmdbId:'7',poster:'https://a.ltrbxd.com/resized/heat.jpg',title:'Heat'},          // same TMDB identity under a Letterboxd id
 tmdb_18:{id:'tmdb_18',tmdbId:null,poster:'https://a.ltrbxd.com/resized/eighteen.jpg'},                       // same stored id, no TMDB id recorded
 tmdb_15:{id:'tmdb_15',tmdbId:'99',poster:'https://a.ltrbxd.com/resized/other.jpg'},                          // same stored id but another TMDB identity
});
r=await get();
assert.equal(posterOf(r.body,'tmdb_7'),'https://a.ltrbxd.com/resized/heat.jpg','the cached poster of the same TMDB identity is reused');
assert.equal(posterOf(r.body,'tmdb_18'),'https://a.ltrbxd.com/resized/eighteen.jpg','the cached poster of the same stored id is reused when no TMDB id contradicts it');
assert.equal(posterOf(r.body,'tmdb_15'),null,'a cached record of the same id but another TMDB identity is not reused');
seed();records.set('metadata.json',{'heat-1995':{id:'heat-1995',tmdbId:'7',poster:'https://a.ltrbxd.com/resized/heat.jpg'}});
r=await get();assert.equal(posterOf(r.body,'tmdb_7'),'https://image.tmdb.org/t/p/w342/tmdb_7.jpg','the record\'s own TMDB poster wins over the cache');
seed();posterless();records.set('metadata.json',{
 a:{id:'a',tmdbId:'7',poster:'https://a.ltrbxd.com/resized/one.jpg'},b:{id:'b',tmdbId:'7',poster:'https://a.ltrbxd.com/resized/two.jpg'},   // two cached records disagree on the same TMDB id
 c:{id:'c',tmdbId:'18',poster:'http://insecure.example/18.jpg'},                                                                            // not an https asset
 d:{id:'d',tmdbId:'15',poster:'https://a.ltrbxd.com/resized/fifteen.jpg'},e:{id:'e',tmdbId:'15',poster:'https://a.ltrbxd.com/resized/fifteen.jpg'}, // two cached records agree
});
r=await get();
assert.equal(posterOf(r.body,'tmdb_7'),null,'disagreeing cached posters for one TMDB id are not used');
assert.equal(posterOf(r.body,'tmdb_18'),null,'a non-https cached value is not a poster');
assert.equal(posterOf(r.body,'tmdb_15'),'https://a.ltrbxd.com/resized/fifteen.jpg','agreeing cached posters for one TMDB id are reused');
assert.deepEqual(Object.keys(r.body.films[1]).sort(),['actors','availability','availableNow','availableUntil','canonicalIdentity','directors','fingerprint','genres','id','nextStart','original','poster','prediction','runtime','shows','title','tmdbId','url','year'],'the DTO shape is unchanged');
assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);

// A conflict is sticky: once two cached records for one TMDB id disagree, no later record and no insertion order restores a poster.
const A='https://a.ltrbxd.com/resized/a.jpg',B='https://a.ltrbxd.com/resized/b.jpg';
const cacheFor=posters=>Object.fromEntries(posters.map((poster,index)=>['lid-'+index,{id:'lid-'+index,tmdbId:'7',poster}]));
for(const [order,expected] of [[[A,B,A],null],[[B,A,A],null],[[A,A,B],null],[[B,B,A,A],null],[[A,B,B,B],null],[[A,A,A],A],[[B],B]]){
 seed();posterless();records.set('metadata.json',cacheFor(order));r=await get();
 assert.equal(posterOf(r.body,'tmdb_7'),expected,'TMDB id order '+order.map(p=>p===A?'A':'B').join('/'));
}
// The same rule holds for the stored-id key: two cached records naming the same stored id with different posters stay conflicted.
for(const [order,expected] of [[[A,B,A],null],[[B,A,A],null],[[A,A],A]]){
 seed();posterless();records.set('metadata.json',Object.fromEntries(order.map((poster,index)=>['key-'+index,{id:'tmdb_18',tmdbId:null,poster}])));r=await get();
 assert.equal(posterOf(r.body,'tmdb_18'),expected,'stored id order '+order.map(p=>p===A?'A':'B').join('/'));
}
// A conflicted TMDB identity also blocks the stored-id path: a disagreement anywhere for the film's identity yields no poster.
seed();posterless();records.set('metadata.json',{tmdb_7:{id:'tmdb_7',tmdbId:'7',poster:A},x:{id:'x',tmdbId:'7',poster:B}});r=await get();
assert.equal(posterOf(r.body,'tmdb_7'),null,'the same stored id does not override a conflicted TMDB identity');
// Records without an https poster never take part in the agreement.
seed();posterless();records.set('metadata.json',{a:{id:'a',tmdbId:'7',poster:A},b:{id:'b',tmdbId:'7',poster:null},c:{id:'c',tmdbId:'7',poster:'http://insecure.example/b.jpg'}});r=await get();
assert.equal(posterOf(r.body,'tmdb_7'),A);

// Coverage summary: where each returned poster came from, counted over the returned films only.
seed();r=await get();
assert.deepEqual(r.body.posterCoverage,{catalog:3,metadataCache:0,missing:0},'every returned film has its own catalog poster');
seed();posterless();r=await get();
assert.deepEqual(r.body.posterCoverage,{catalog:0,metadataCache:0,missing:3});
seed();posterless();records.set('metadata.json',{'heat-1995':{id:'heat-1995',tmdbId:'7',poster:A}});r=await get();
assert.deepEqual(r.body.posterCoverage,{catalog:0,metadataCache:1,missing:2});
assert.equal(r.body.posterCoverage.catalog+r.body.posterCoverage.metadataCache+r.body.posterCoverage.missing,r.body.total);
seed();for(const key of CATALOG_KEYS)records.get(key).tmdb_15.poster=null;r=await get();
assert.deepEqual(r.body.posterCoverage,{catalog:2,metadataCache:0,missing:1},'a duplicate identity that is not returned is not counted');
assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);

// A stored confidenceAssessment key is projected even when the value is null. Absence of the key leaves the DTO unchanged.
seed();
const assessmentHash='ab'.repeat(32);
const coverage={mechanicsAsserted:0,mechanicsSupported:0,keyApplicable:0,keyConcrete:0,keySupported:0,keyUnknown:0,keyNotApplicable:0,genrePresent:0,genreSupported:0};
const index=records.get(constant('ENRICHMENT_KEY')+'view-index.json');
index.tmdb_7.prediction.confidenceAssessment=null;
index.tmdb_18.prediction.confidenceAssessment={assessmentVersion:1,level:'medium',status:'evidenced',reasonCodes:['declared_source_not_verified'],coverage,fingerprintHash:assessmentHash};
r=await get();
const absent=r.body.films.find(film=>film.id==='tmdb_15').prediction;
const nulled=r.body.films.find(film=>film.id==='tmdb_7').prediction;
const carried=r.body.films.find(film=>film.id==='tmdb_18').prediction;
assert.equal(Object.hasOwn(absent,'confidenceAssessment'),false);
assert.equal(Object.hasOwn(absent,'fingerprintHash'),false);
assert.equal(Object.hasOwn(nulled,'confidenceAssessment'),true);
assert.equal(nulled.confidenceAssessment,null);
assert.equal(nulled.fingerprintHash,'f');
assert.equal(nulled.confidence,'high');
assert.equal(carried.confidenceAssessment.level,'medium');
assert.equal(carried.confidenceAssessment.fingerprintHash,assessmentHash);
assert.deepEqual(puts,[]);

// AIR-382: `letterboxdUrl` is an optional read-only field, present only when stored records prove the Letterboxd page of the TMDB film. `url` stays TMDB.
{
 const lb=slug=>'https://letterboxd.com/film/'+slug+'/';
 const field=(body,id)=>body.films.find(film=>film.id===id);
 // No metadata cache: no field at all, and `url` is untouched.
 seed();r=await get();assert.equal(r.status,200);
 assert.equal(Object.hasOwn(field(r.body,'tmdb_7'),'letterboxdUrl'),false,'no record, no field');
 assert.match(field(r.body,'tmdb_7').url,/themoviedb\.org/,'url stays the TMDB page');
 // One Letterboxd record with this TMDB id and a canonical URL proves it.
 seed();records.set('metadata.json',{'heat-1995':{id:'heat-1995',tmdbId:'7',url:lb('heat-1995')}});r=await get();
 assert.equal(field(r.body,'tmdb_7').letterboxdUrl,lb('heat-1995'));
 assert.equal(Object.hasOwn(field(r.body,'tmdb_18'),'letterboxdUrl'),false,'another film gets nothing');
 assert.match(field(r.body,'tmdb_7').url,/themoviedb\.org/);
 // Two different URLs for one TMDB id: conflicted for good, whatever the order.
 for(const order of [['a','b'],['b','a']]){
  seed();records.set('metadata.json',Object.fromEntries(order.map(k=>[k,{id:k,tmdbId:'7',url:lb(k)}])));r=await get();
  assert.equal(Object.hasOwn(field(r.body,'tmdb_7'),'letterboxdUrl'),false,'two URLs prove nothing');
 }
 // Two records with the same URL agree.
 seed();records.set('metadata.json',{a:{id:'a',tmdbId:'7',url:lb('same')},b:{id:'b',tmdbId:'7',url:lb('same')}});r=await get();
 assert.equal(field(r.body,'tmdb_7').letterboxdUrl,lb('same'));
 // A Letterboxd id that bridges to two TMDB ids is unproven.
 seed();records.set('metadata.json',{a:{id:'a',tmdbId:'7',url:lb('a')}});
 const wl=records.get('watchlist.json');wl.films.push({id:'a',tmdbId:'18',title:'Clash'});records.set('watchlist.json',wl);r=await get();
 assert.equal(Object.hasOwn(field(r.body,'tmdb_7'),'letterboxdUrl'),false,'an ambiguous Letterboxd id bridges nothing');
 // Malformed, TMDB-shaped or unsafe URLs are never exposed; a tmdb_ id is not a Letterboxd id; no record matches by title.
 for(const bad of ['https://www.themoviedb.org/movie/7','http://letterboxd.com/film/x/','https://letterboxd.com/film/x','https://letterboxd.com/film/X_y/','https://letterboxd.com.evil.example/film/x/','javascript:alert(1)',7,null]){
  seed();records.set('metadata.json',{x:{id:'x',tmdbId:'7',url:bad}});r=await get();
  assert.equal(Object.hasOwn(field(r.body,'tmdb_7'),'letterboxdUrl'),false,'rejected: '+String(bad));
 }
 seed();records.set('metadata.json',{tmdb_7:{id:'tmdb_7',tmdbId:'7',url:lb('x')}});r=await get();
 assert.equal(Object.hasOwn(field(r.body,'tmdb_7'),'letterboxdUrl'),false,'a TMDB-keyed record is not a Letterboxd identity');
 seed();records.set('metadata.json',{x:{id:'x',title:'Film tmdb_7',original:'Original tmdb_7',year:2020,url:lb('x')}});r=await get();
 assert.equal(Object.hasOwn(field(r.body,'tmdb_7'),'letterboxdUrl'),false,'a title or year match is not proof');
 assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
}

// AIR-433 (ADR 0114): the film-level availability beside the legacy fields. An archive wins over a repeat, a film on air or only ahead is `soon` and is
// ready at the END of the show, a show without an end is never a ready archive (the legacy per-show status still says `archive` for it), and the legacy
// fields keep their values.
{
 seed();
 setCatalogShows('tmdb_7',[show(now-3*hour),show(now+2*hour,{channelId:'c2',channel:'Two'})]);          // ended archive and a repeat in two hours
 setCatalogShows('tmdb_15',[show(now+23*hour,{end:now+25*hour})]);                                       // future only
 setCatalogShows('tmdb_18',[show(now-30*60000,{end:now+90*60000})]);                                     // on air, ends in 90 minutes
 setCatalogShows('tmdb_14',[]);
 r=await get();
 const by=id=>r.body.films.find(f=>f.id===id);
 assert.deepEqual(by('tmdb_7').availability,{state:'available',label:'Доступно',appearsAt:null,appearsAtKnown:null,archiveUntil:now-3*hour+72*hour,onAir:false},'archive plus a repeat stays available');
 assert.equal(by('tmdb_7').nextStart,now+2*hour,'the repeat is only the next start');assert.equal(by('tmdb_7').availableNow,true);
 assert.deepEqual(by('tmdb_15').availability,{state:'soon',label:'Скоро',appearsAt:now+25*hour,appearsAtKnown:true,archiveUntil:null,onAir:false},'future only: ready at the end of the show, not its start');
 assert.equal(by('tmdb_15').availableNow,false);assert.equal(by('tmdb_15').nextStart,now+23*hour);
 assert.deepEqual(by('tmdb_18').availability,{state:'soon',label:'Скоро',appearsAt:now+90*60000,appearsAtKnown:true,archiveUntil:null,onAir:true},'on air is not an archive until it ends');
 assert.equal(by('tmdb_18').availableNow,true,'the legacy availableNow is unchanged and still says true for a show that has started');
 assert.deepEqual(by('tmdb_18').shows.map(item=>item.status),['on_air']);
 // a show without an end: the legacy status says archive, the film is not available
 setCatalogShows('tmdb_18',[{channelId:'c1',channel:'One',start:now-hour}]);
 r=await get();
 assert.deepEqual(by('tmdb_18').shows.map(item=>item.status),['archive'],'the legacy per-show status is unchanged');
 assert.equal(by('tmdb_18').availability.state,'unavailable','no end is never a ready archive');
 assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
}

console.log('Catalog available: pinned generation, verified catalog-only identity, real shows inside the 72h/24h window with statuses, current prediction for the current profile, watchlist/rating/seed exclusions, one entry per identity, deterministic order, channel summary, generation pin and no side effects passed');
