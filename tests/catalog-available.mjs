// Read-only catalog of available films outside the watchlist: pinned generation, verified identity, real shows in
// the 72h catch-up or next 24h, current prediction for the current profile, watchlist and rating exclusions,
// one entry per canonical identity, no storage write and no outbound request.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map();let puts=[],fetches=[];
const bucket={
 async get(key){return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value){records.set(key,JSON.parse(value));puts.push(key);return {etag:'e'};},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key,customMetadata:{}})),truncated:false};}
};
const env={BUCKET:bucket};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{tmdb_17:3.5},
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker,constant=name=>vm.runInContext(name,context);
const get=async()=>{const response=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/available'),env,{waitUntil(){}});return {status:response.status,body:await response.json()};};

const hour=3600000,now=Date.now(),G0='11111111-1111-4111-8111-111111111111',G1='22222222-2222-4222-8222-222222222222',G2='33333333-3333-4333-8333-333333333333';
const profile={version:1,profileHash:'p1'};
const prediction=(extra={})=>({predictedRating:4.2,probability4Plus:.74,confidence:'high',matchSignals:['Investigation'],mainRisk:'Slow start',moodLabels:['мрачный','напряжённый'],tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1,...extra});
const fingerprint={fingerprintHash:'f',plotMechanics:['investigation'],moodLabels:['мрачный'],execution:{payoff:'strong',pacing:'unknown'}};
const current=(extra={})=>({prediction:prediction(extra),fingerprintHash:'f',fingerprint});
const show=(start,extra={})=>({channelId:'c1',channel:'One',start,end:start+2*hour,...extra});
const film=(id,tmdbId,shows,extra={})=>({id,tmdbId:String(tmdbId),canonicalIdentity:'tmdb:'+tmdbId,title:'Film '+id,original:'Original '+id,year:2020,runtime:100,genres:['Драма'],poster:'https://image.tmdb.org/t/p/w342/'+id+'.jpg',url:'https://www.themoviedb.org/movie/'+tmdbId,synopsis:'SYNOPSIS-'+id,aliases:['ALIAS-'+id],directors:[{id:'tmdb_director/1',name:'Director',original:'Director'}],actors:[{id:'tmdb_actor/2',name:'Actor',original:'Actor'}],shows,showsProgrammeRunId:G1,discoveredAt:new Date(now-86400000).toISOString(),...extra});

function seed(){
 records.clear();puts=[];fetches.length=0;
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:G1});
 records.set('programme.json',{runId:G1,updatedAt:new Date(now).toISOString(),watchlistCount:1,films:[{id:'w1',tmdbId:'42',title:'Watchlist Film',shows:[show(now-hour)]}],stats:{}});
 records.set('watchlist.json',{updatedAt:new Date(now).toISOString(),films:[{id:'w1',tmdbId:'42',title:'Watchlist Film'},{id:'w2',tmdbId:'43',title:'Unscheduled watchlist film'}]});
 records.set(constant('profileKey'),profile);
 records.set('epg/discovered-films.json',{
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
assert.deepEqual(Object.keys(seven).sort(),['actors','availableNow','availableUntil','canonicalIdentity','directors','fingerprint','genres','id','nextStart','original','poster','prediction','runtime','shows','title','tmdbId','url','year']);
assert.doesNotMatch(JSON.stringify(r.body),/SYNOPSIS-|ALIAS-|tasteProfileHash|moodLabels/,'minimal display DTO: no synopsis, aliases or raw prediction internals');
assert.deepEqual(seven.shows.map(s=>[s.channelId,s.status]),[['c1','archive'],['c2','future']],'duplicate show collapsed, statuses derived from the clock');
assert.equal(seven.availableNow,true);assert.equal(seven.nextStart,now+2*hour);assert.equal(seven.availableUntil,new Date(now+2*hour+72*hour).toISOString());
assert.deepEqual(seven.prediction,{predictedRating:4.2,probability4Plus:.74,confidence:'high',matchSignals:['Investigation'],mainRisk:'Slow start',moodIds:seven.prediction.moodIds});
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
seed();records.get('epg/discovered-films.json').tmdb_14.shows=[show(now+5*hour)];
r=await get();assert.deepEqual(r.body.films.filter(f=>f.canonicalIdentity==='tmdb:7').map(f=>f.id),['tmdb_14']);
// An archive show that expires moves the film out without any storage change.
seed();records.get('epg/discovered-films.json').tmdb_7.shows=[show(now-71*hour-59*60000)];records.get('epg/discovered-films.json').tmdb_14.shows=[];records.get('epg/discovered-films.json').tmdb_15.shows=[];
r=await get();assert.ok(r.body.films.some(f=>f.id==='tmdb_7'),'one minute before the 72h boundary the film is still available');
records.get('epg/discovered-films.json').tmdb_7.shows=[show(now-72*hour-60000)];
r=await get();assert.ok(!r.body.films.some(f=>f.id==='tmdb_7'),'one minute after the 72h boundary it is gone');
records.get('epg/discovered-films.json').tmdb_7.shows=[show(now+23*hour+59*60000)];
r=await get();assert.ok(r.body.films.some(f=>f.id==='tmdb_7'),'one minute before the 24h horizon the film is offered as future');
records.get('epg/discovered-films.json').tmdb_7.shows=[show(now+24*hour+60000)];
r=await get();assert.ok(!r.body.films.some(f=>f.id==='tmdb_7'),'one minute past the 24h horizon it is not');

// 3. Profile freshness: a new profile version makes every stored prediction stale, so nothing is offered.
seed();records.set(constant('profileKey'),{version:2,profileHash:'p2'});
r=await get();assert.equal(r.status,200);assert.deepEqual(r.body.films,[]);assert.equal(r.body.total,0);assert.deepEqual(r.body.profile,{version:2});
seed();records.delete(constant('profileKey'));
r=await get();assert.equal(r.status,200);assert.deepEqual(r.body.films,[]);assert.equal(r.body.profile,null,'without a profile no prediction is current');

// 4. Generation pin: the pointer names a generation whose programme is not in place yet, nothing is served from the older programme.
seed();records.set('epg/published-generation.json',{phase:'published',programmeRunId:G2});
r=await get();assert.equal(r.status,409);assert.deepEqual(r.body,{error:'Programme generation is not in place'});
// The generation copies are read through the pin, so a generation that is in place is served from its own files.
seed();records.set('epg/published-generation.json',{phase:'published',programmeRunId:G2});
records.set('epg/generations/'+G2+'/programme.json',{runId:G2,updatedAt:new Date(now).toISOString(),watchlistCount:1,films:[{id:'w1',tmdbId:'42',shows:[]}],stats:{}});
records.set('epg/generations/'+G2+'/discovered-films.json',{tmdb_7:film('tmdb_7',7,[show(now-hour)],{showsProgrammeRunId:G2}),tmdb_15:film('tmdb_15',15,[show(now+hour)],{showsProgrammeRunId:G1})});
r=await get();assert.equal(r.status,200);assert.equal(r.body.programmeRunId,G2);assert.deepEqual(r.body.films.map(f=>f.id),['tmdb_7'],'a catalog film whose shows still belong to the previous generation is not available in the new one');
// Without a published pointer the programme's own run id is the generation, and the response says it is not pinned.
seed();records.delete('epg/published-generation.json');
r=await get();assert.equal(r.status,200);assert.equal(r.body.pinned,false);assert.equal(r.body.programmeRunId,G1);assert.deepEqual(r.body.films.map(f=>f.id),['tmdb_18','tmdb_7','tmdb_15']);
// No programme at all.
seed();records.delete('programme.json');
r=await get();assert.equal(r.status,503);assert.deepEqual(r.body,{error:'No published programme'});
// A missing catalog or view index is an empty result, not an error.
seed();records.delete('epg/discovered-films.json');r=await get();assert.equal(r.status,200);assert.deepEqual(r.body.films,[]);
seed();records.delete(constant('ENRICHMENT_KEY')+'view-index.json');r=await get();assert.equal(r.status,200);assert.deepEqual(r.body.films,[]);
assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);

console.log('Catalog available: pinned generation, verified catalog-only identity, real shows inside the 72h/24h window with statuses, current prediction for the current profile, watchlist/rating/seed exclusions, one entry per identity, deterministic order, channel summary, generation pin and no side effects passed');
