// AIR-387: the permanent catalog film lookup `GET /api/catalog/film/<tmdbId>`. One verified TMDB movie of the catalog, whatever its shows,
// prediction or the watchlist say. Read-only: no R2/D1 write, no outbound request. Local stand-ins only, nothing calls Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {installViewIndexFixture} from './view-index-fixture.mjs';
import {webcrypto,createHash} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {d1Standin} from './d1-standin.mjs';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import * as PublishedEpgModule from '../src/published-epg.js';
import {sqliteSync} from './sqlite-session.mjs';

// ---- 1. readFilmAdmission against a real schema (sqlite stand-in) ----
// ADR 0162: a ratings marker that is not d1/open is refused, so the full-chain fixtures serve the (empty) ratings domain from D1.
const RATINGS_D1="\nUPDATE ratings_domain_authority SET mode='d1', cutover='open' WHERE id=1;";
// The prediction domain likewise: a fixture that serves the R2 view index's forecasts (3g) stands for the uninstalled local domain, so its tables are dropped; the others serve it from D1.
const PREDICTION_D1="\nUPDATE prediction_domain_authority SET mode='d1' WHERE id=1;";
const PREDICTION_BARE="\n"+['prediction_domain_intent','prediction_run','prediction_lease','prediction_queue','prediction_lineage','prediction_pointer','prediction_fingerprint','prediction_profile','prediction_domain_cas','prediction_domain_authority'].map(name=>'DROP TABLE IF EXISTS '+name+';').join('\n');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-catalog-film-'));
let databases=0;const seen=[];
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=11).sort();
const migrated=()=>{
 const file=path.join(root,'film-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return d1Standin(file,{onQuery:async text=>{seen.push(text);}});
};
const open=db=>db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
const lit=value=>"'"+String(value).replace(/'/g,"''")+"'";
const admit=(db,filmId,tmdb,{state='current',kind='movie',identity='tmdb:'+tmdb,film}={})=>{
 const payload=film||{id:filmId,tmdbId:String(tmdb),canonicalIdentity:identity,title:'Film '+filmId,original:'Original '+filmId,year:2020,genres:['Драма'],directors:[],actors:[],shows:[]};
 db.sql(`INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, generation, state, payload_json) VALUES (${lit(filmId)},${lit(tmdb)},${lit(kind)},${lit(identity)},1,${lit(state)},${lit(JSON.stringify(payload))})`);
};
const env=db=>({DB:db,BUCKET:{async get(){throw new Error('R2 must not be read by the admission lookup');}},discoveryLease:null});

{
 const db=migrated();
 // ADR 0162: a Discovery marker in mode r2 (the migration's value) is refused, not read as the R2 objects.
 await assert.rejects(()=>Authority.readFilmAdmission(env(db),'7'),error=>error.code==='discovery_unavailable');
 open(db);
 admit(db,'tmdb_7',7);admit(db,'tmdb_8',8,{state:'superseded'});admit(db,'tmdb_tv_9',9,{kind:'tv',identity:'tmdb_tv:9'});admit(db,'tmdb_10',10,{state:'pending'});
 const found=await Authority.readFilmAdmission(env(db),'7');
 assert.equal(found.handled,true);assert.deepEqual(found.records.map(r=>[r.filmId,r.state,r.canonicalIdentity,r.tmdbId]),[['tmdb_7','current','tmdb:7','7']]);
 assert.equal(found.records[0].film.title,'Film tmdb_7');
 assert.deepEqual((await Authority.readFilmAdmission(env(db),'8')).records.map(r=>r.state),['superseded'],'a superseded film is reported, not hidden');
 assert.deepEqual((await Authority.readFilmAdmission(env(db),'11')).records,[],'an unknown id has no record');
 assert.deepEqual((await Authority.readFilmAdmission(env(db),'9')).records,[],'a TV id of the same number is another namespace');
 // Only one indexed row is read: the one table read is filtered by media kind and TMDB id, never a scan of the catalog.
 seen.length=0;await Authority.readFilmAdmission(env(db),'7');
 const admissionReads=seen.filter(text=>/FROM discovery_admission/.test(text)&&!/state='pending' LIMIT 1/.test(text));
 assert.equal(admissionReads.length,1,'one catalog read');
 assert.match(admissionReads[0],/WHERE media_kind='movie' AND tmdb_id='7'/,'by identity');
 assert.ok(seen.every(text=>!/^\s*(INSERT|UPDATE|DELETE)/i.test(text)),'only reads');
 for(const bad of ['0','-1','1.5','007','abc','','1234567890123','7 OR 1=1'])await assert.rejects(()=>Authority.readFilmAdmission(env(db),bad),error=>error.code==='discovery_conflict','rejected: '+bad);
 // Fail closed: a held cutover (refused outright), a catalog load in progress.
 db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");
 await assert.rejects(()=>Authority.readFilmAdmission(env(db),'7'),error=>error.code==='discovery_unavailable','a held cutover is refused (ADR 0162)');
 db.sql("UPDATE discovery_authority SET cutover='open' WHERE id=1");
 db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
 await assert.rejects(()=>Authority.readFilmAdmission(env(db),'7'),error=>error.code==='discovery_incomplete','a transfer that is not a ledger seal is not readable');
 db.sql("UPDATE discovery_transfer SET state='idle' WHERE id=1");
 assert.equal((await Authority.readFilmAdmission(env(db),'7')).records.length,1,'readable again');
 const outage={prepare(){throw new Error('d1 down');}};
 await assert.rejects(()=>Authority.readFilmAdmission({DB:outage},'7'),error=>error.code==='discovery_unavailable','an outage is unavailable, never absent');
 // The lookup writes nothing.
 assert.equal(db.calls.batches,0,'no batch');
}

// ---- 2. the route through the Worker ----
const records=new Map();let puts=[],fetches=[];
const reads=[];
const bucket={
 async get(key){reads.push(key);return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key)),text:async()=>JSON.stringify(records.get(key))}:null;},
 async put(key,value){records.set(key,JSON.parse(value));puts.push(key);return {etag:'e'};},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key,customMetadata:{}})),truncated:false};}
};
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ctx);
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader','const {database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n'),ctx);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),ctx);
vm.runInContext(scoped('src/prediction-d1.js','PredictionD1'),ctx);vm.runInContext(scoped('src/ratings-d1.js','RatingsD1'),ctx);
for(const file of ['src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js',process.env.CATALOG_WORKER_FILE||'src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
installViewIndexFixture(ctx);
const worker=ctx.worker,constant=name=>vm.runInContext(name,ctx);
const envW={BUCKET:bucket,FILM_PERSON_DB_OPTIONAL:'standin'};
const get=async id=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/film/'+id),envW,{waitUntil(){}});return {status:r.status,body:await r.json()};};
const hour=3600000,now=Date.now(),G1='22222222-2222-4222-8222-222222222222',G0='11111111-1111-4111-8111-111111111111';
const profile={version:1,profileHash:'p1'};
const prediction=(extra={})=>({predictedRating:4.5,probability4Plus:.74,confidence:'high',matchSignals:['Investigation'],mainRisk:'Slow start',moodLabels:['мрачный','напряжённый'],tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1,...extra});
const fingerprint={fingerprintHash:'f',plotMechanics:['investigation'],moodLabels:['мрачный'],execution:{payoff:'strong',pacing:'unknown'}};
const stored=(extra={})=>({prediction:prediction(extra),fingerprintHash:'f',impactFeatures:{fingerprintHash:'f',fingerprintSchemaVersion:1,fingerprintPromptVersion:1},fingerprint});
const show=(start,extra={})=>({channelId:'c1',channel:'One',start,end:start+2*hour,...extra});
const catalogFilm=(id,tmdb,extra={})=>({id,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:'Film '+id,original:'Original '+id,year:2020,runtime:100,genres:['Драма'],poster:'https://image.tmdb.org/t/p/w342/'+id+'.jpg',url:'https://www.themoviedb.org/movie/'+tmdb,directors:[{id:'tmdb_director/1',name:'Режиссёр'}],actors:[{id:'tmdb_actor/2',name:'Актёр'}],shows:[],showsProgrammeRunId:G1,...extra});
function seed(catalog){
 records.clear();puts=[];fetches.length=0;
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:G1});
 for(const key of ['programme.json','epg/generations/'+G1+'/programme.json'])records.set(key,{runId:G1,updatedAt:new Date(now).toISOString(),watchlistCount:0,films:[],stats:{}});
 records.set('watchlist.json',{updatedAt:new Date(now).toISOString(),films:[]});
 records.set(constant('profileKey'),profile);
 records.set(constant('ENRICHMENT_KEY')+'view-index.json',{tmdb_7:stored(),tmdb_8:stored({tasteProfileHash:'old'}),tmdb_13:stored()});
 for(const key of ['epg/discovered-films.json','epg/generations/'+G1+'/discovered-films.json'])records.set(key,structuredClone(catalog));
}
const base={
 tmdb_7:catalogFilm('tmdb_7',7,{shows:[show(now-hour),show(now+2*hour,{channelId:'c2',channel:'Two'})]}),
 tmdb_8:catalogFilm('tmdb_8',8,{shows:[show(now-hour)]}),                       // stale prediction
 tmdb_9:catalogFilm('tmdb_9',9,{shows:[]}),                                     // no shows, no prediction stored
 tmdb_10:catalogFilm('tmdb_10',10,{shows:[show(now-200*hour)]}),                // an old show, far outside any window
 tmdb_11:catalogFilm('tmdb_11',11,{canonicalIdentity:null}),                    // unverified identity
 tmdb_12:catalogFilm('tmdb_12',12,{showsProgrammeRunId:G0,shows:[show(now-hour)]}), // shows of an earlier generation
 tmdb_13:catalogFilm('tmdb_13',13,{shows:[show(now-hour)]}),
 tmdb_14:catalogFilm('tmdb_14',13,{shows:[show(now-hour)]}),                    // same verified identity, another id
};
{
 seed(base);
 let r=await get('7');
 assert.equal(r.status,200);assert.equal(r.body.status,'found');assert.equal(r.body.programmeRunId,G1);
 const film=r.body.film;
 assert.deepEqual([film.id,film.tmdbId,film.canonicalIdentity,film.title,film.year,film.runtime],['tmdb_7','7','tmdb:7','Film tmdb_7',2020,100]);
 assert.match(film.url,/themoviedb\.org\/movie\/7/);assert.equal(Object.hasOwn(film,'letterboxdUrl'),false);
 assert.deepEqual(film.directors,[{id:'tmdb_director/1',name:'Режиссёр'}]);assert.equal(film.shows.length,2);assert.equal(film.shows[0].status,'on_air');assert.equal(film.shows[1].status,'future');
 assert.equal(film.availableNow,false,'the first show is on air: no ready recording yet');assert.equal(film.availableUntil,null);assert.equal(film.nextStart,film.shows[1].start);
 // AIR-433 (ADR 0114): the film page entry carries the film-level availability beside the legacy fields. This fixture's first show started an hour ago and runs two
 // hours, so it is on air: the film is `soon`, ready at the END of that show, and the repeat in two hours does not change that (the archive case is in catalog-available.mjs).
 assert.equal(film.availability.state,'soon');assert.equal(film.availability.label,'Скоро');assert.equal(film.availability.onAir,true);assert.equal(film.availability.appearsAt,film.shows[0].end);assert.equal(film.availability.archiveUntil,null);
 assert.equal(film.prediction.predictedRating,4.5);assert.deepEqual(film.fingerprint.plotMechanics,['investigation']);
 // The permanent page does not need a current window, a prediction floor or an empty watchlist.
 r=await get('10');assert.equal(r.status,200);assert.equal(r.body.film.shows.length,1,'an old show is still this film\'s show for the current generation');assert.deepEqual([r.body.film.shows[0].status,r.body.film.availability.state,r.body.film.availableNow,r.body.film.availableUntil],['expired','unavailable',false,null],'the 72 h window counted from the start is over');assert.equal(r.body.film.prediction,null,'no stored prediction: none invented');
 // owner decisions of 2026-11-11 (AIR-433): the same lifecycle as the list: the end is the EPG end, else start + runtime, else unknown.
 {
  const run=(id,runtime,shows)=>catalogFilm('tmdb_'+id,id,{runtime,shows});
  seed({...base,tmdb_20:run(20,100,[{channelId:'c1',channel:'One',start:now-hour}]),tmdb_21:run(21,null,[{channelId:'c1',channel:'One',start:now-hour}]),tmdb_22:run(22,100,[{channelId:'c1',channel:'One',start:now-3*hour}]),tmdb_23:run(23,100,[{channelId:'c1',channel:'One',start:now+3*hour}])});
  const one=async id=>(await get(id)).body.film;
  let f=await one('20');assert.deepEqual([f.shows[0].status,f.shows[0].end,f.shows[0].effectiveEnd,f.availability.state,f.availability.appearsAt,f.availability.appearsAtEstimated,f.availableNow],['on_air',null,now-hour+100*60000,'soon',now-hour+100*60000,true,false],'no EPG end: start + runtime');
  f=await one('21');assert.deepEqual([f.shows[0].status,f.shows[0].effectiveEnd,f.availability.state,f.availableNow,f.availableUntil],['unknown',null,'unavailable',false,null],'no end and no runtime: unknown, nothing invented');
  f=await one('22');assert.deepEqual([f.shows[0].status,f.availability.state,f.availableNow,f.availableUntil],['archive','available',true,new Date(now-3*hour+72*hour).toISOString()],'ended by its runtime: ready');
  f=await one('23');assert.deepEqual([f.shows[0].status,f.availability.state,f.availability.appearsAt,f.availableNow],['future','soon',now+3*hour+100*60000,false]);
  seed({...base,tmdb_24:run(24,100,[{channelId:'c1',channel:'One',start:now-hour,end:null}])});f=await one('24');assert.deepEqual([f.shows[0].end,f.shows[0].effectiveEnd,f.shows[0].status],[null,now-hour+100*60000,'on_air'],'an explicit EPG end null stays null, never 0');
  seed(base);
 }
 r=await get('9');assert.equal(r.status,200);assert.deepEqual(r.body.film.shows,[]);assert.equal(r.body.film.availability.state,'unavailable','no shows: unavailable');assert.equal(r.body.film.availableUntil,null);assert.equal(r.body.film.nextStart,null);assert.equal(r.body.film.availableNow,false,'zero shows is a valid film page');
 r=await get('8');assert.equal(r.status,200);assert.deepEqual([r.body.film.prediction.stale,typeof r.body.film.prediction.staleReason,r.body.film.prediction.predictedRating],[true,'string',4.5],'AIR-475: a stale forecast is shown, marked with the evaluator\'s reason');assert.deepEqual(r.body.film.fingerprint.plotMechanics,['investigation'],'the stored fingerprint is shown whatever the forecast\'s freshness');assert.equal(r.body.film.prediction.compatibility,undefined,'no compatibility claim on a stale verdict');
 r=await get('12');assert.equal(r.status,200);assert.deepEqual(r.body.film.shows,[],'shows of an earlier generation are not availability now');
 // States.
 r=await get('999');assert.deepEqual([r.status,r.body.status],[404,'absent']);
 r=await get('11');assert.deepEqual([r.status,r.body.status],[409,'conflict'],'a record that does not verify its identity fails closed');
 r=await get('13');assert.equal(r.status,409,'two current records of one identity are not guessed between');

 // AIR-531: the HTML document `/film/<id>` carries the status the page will show. Same read-only lookup as the API, GET and HEAD alike, no write.
 vm.runInContext("var ASSETS={'/':{type:'text/html',body:'<!doctype html><title>shell</title>'}};",ctx);
 {
  const doc=async(id,method='GET')=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/film/'+id,{method}),envW,{waitUntil(){}});return {status:r.status,text:await r.text(),cache:r.headers.get('Cache-Control')};};
  for(const method of ['GET','HEAD']){
   let d=await doc('tmdb_999',method);assert.equal(d.status,404,method+': an absent TMDB permalink is 404');assert.equal(d.text.includes('shell'),method==='GET','the shell is served on GET only');assert.equal(d.cache,'no-store');
   d=await doc('tmdb_11',method);assert.equal(d.status,409,method+': a conflicting identity is 409');
   d=await doc('tmdb_7',method);assert.equal(d.status,200,method+': a verified catalog Film is 200');assert.equal(d.cache,'no-cache');
   d=await doc('tmdb_0',method);assert.equal(d.status,404,method+': a malformed TMDB permalink is 404');
  }
 }
 for(const bad of ['0','abc','-1','7.5','007','1234567890123','%E0%A4%A']){r=await get(bad);assert.deepEqual([r.status,r.body.status],[400,'invalid'],'invalid: '+bad);}
 // The film is still found when the watchlist, a rating or the profile say nothing about it.
 const index=records.get(constant('ENRICHMENT_KEY')+'view-index.json');index.tmdb_7.actualRating=5;index.tmdb_7.watchlist=true;records.set(constant('ENRICHMENT_KEY')+'view-index.json',index);
 r=await get('7');assert.equal(r.status,200,'a rated or watchlisted film still has its page');assert.deepEqual([r.body.film.actualRating,r.body.film.watched],[5,false],'AIR-475: the known rating is shown; a rating is not a watched mark and a watched mark is not inferred from it');
 // Optional context degrades honestly: no profile, no programme copy, no index.
 records.delete(constant('profileKey'));r=await get('7');assert.equal(r.status,200);assert.equal(r.body.film.prediction,null,'no profile, no current prediction');assert.equal(r.body.film.shows.length,2);
 seed(base);records.delete('epg/generations/'+G1+'/programme.json');r=await get('7');assert.equal(r.status,200);assert.deepEqual(r.body.film.shows,[],'no programme copy to pin: no availability claimed');assert.ok(r.body.degraded.includes('programme'));
 // A Letterboxd link only when stored records prove it.
 seed(base);records.set('metadata.json',{'heat-1995':{id:'heat-1995',tmdbId:'7',url:'https://letterboxd.com/film/heat-1995/'}});
 r=await get('7');assert.equal(r.body.film.letterboxdUrl,'https://letterboxd.com/film/heat-1995/');assert.match(r.body.film.url,/themoviedb\.org/);
 r=await get('9');assert.equal(Object.hasOwn(r.body.film,'letterboxdUrl'),false);
 // No write, no outbound request, whatever the answer.
 assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
}

// ---- 3. Discovery on D1: the states of the admission map to the answers ----
{
 const answer=(handled,list)=>{vm.runInContext('globalThis.DiscoveryAuthority={ownsKey:()=>false,readAuthority:async()=>({held:false,ready:false}),routeRead:async()=>({handled:false}),readFilmAdmission:async()=>__stub()}',ctx);ctx.__stub=async()=>({handled,records:list});};
 const rec=(filmId,state,tmdb=7,over={})=>({filmId,state,canonicalIdentity:'tmdb:'+tmdb,tmdbId:String(tmdb),film:catalogFilm(filmId,tmdb,over)});
 seed({});
 answer(true,[rec('tmdb_7','current')]);let r=await get('7');assert.equal(r.status,200);assert.equal(r.body.film.id,'tmdb_7');
 answer(true,[]);r=await get('7');assert.deepEqual([r.status,r.body.status],[404,'absent']);
 answer(true,[rec('tmdb_7','superseded')]);r=await get('7');assert.deepEqual([r.status,r.body.status],[410,'retired']);
 {const r2=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/film/tmdb_7'),envW,{waitUntil(){}});assert.equal(r2.status,410,'AIR-531: a retired Film permalink document is 410');const r3=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/film/tmdb_7',{method:'HEAD'}),envW,{waitUntil(){}});assert.equal(r3.status,410,'HEAD is 410 too');}
 answer(true,[rec('tmdb_7','superseded'),rec('tmdb_7b','current')]);r=await get('7');assert.deepEqual([r.status,r.body.film?.id],[200,'tmdb_7b'],'the current record is the film; a superseded sibling is history');
 answer(true,[{...rec('other-id','current'),film:catalogFilm('tmdb_7',7)}]);r=await get('7');assert.equal(r.status,409,'a payload whose own id is not the row id is a conflict');
 answer(true,[rec('tmdb_7','current',7,{canonicalIdentity:'tmdb:8'})]);r=await get('7');assert.equal(r.status,409,'a payload whose identity disagrees with the row');
 answer(true,[rec('tmdb_7','pending')]);r=await get('7');assert.deepEqual([r.status,r.body.status],[503,'unavailable'],'a pending admission is being updated, not absent');
 for(const code of ['discovery_fence','discovery_incomplete','discovery_unavailable','discovery_not_authoritative']){ctx.__stub=async()=>{const error=new Error(code);error.code=code;throw error;};r=await get('7');assert.deepEqual([r.status,r.body.status,r.body.reason],[503,'unavailable',code],code);}
 ctx.__stub=async()=>{throw new Error('boom');};r=await get('7');assert.deepEqual([r.status,r.body.status],[500,'error'],'an unknown failure is an error, not an absence');
 assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
}

// ---- 3b. A missing source is not an absence ----
{
 vm.runInContext('globalThis.DiscoveryAuthority=undefined',ctx);
 seed({});
 records.delete('epg/discovered-films.json');records.delete('epg/generations/'+G1+'/discovered-films.json');
 let r=await get('7');
 assert.deepEqual([r.status,r.body.status,r.body.reason],[503,'unavailable','discovery_unavailable'],'a missing shared catalog object is unreadable, not "never admitted"');
 records.set('epg/discovered-films.json',[]);r=await get('7');
 assert.deepEqual([r.status,r.body.status],[503,'unavailable'],'a malformed catalog object is unreadable too');
 records.set('epg/discovered-films.json',{});r=await get('7');
 assert.deepEqual([r.status,r.body.status],[404,'absent'],'an existing, empty catalog is a real absence');
 assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
}

// ---- 3c. A D1-published generation: the GET never repairs the R2 mirrors, writes D1 or asks a provider ----
{
 const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>name.slice(0,-4)).sort();
 const mkdb=name=>{
  const file=path.join(root,name+'.sqlite');const statementsSeen=[];
  const db=d1Standin(file,{onQuery:async text=>{statementsSeen.push(text);}});
  for(const migration of names)db.sql(fs.readFileSync('migrations/'+migration+'.sql','utf8'));
  return {db,statementsSeen};
 };
 const {db,statementsSeen}=mkdb('published');
 db.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
 // ADR 0162: the Film/Person marker is served only at d1 / open.
 db.sql("UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
 const seeding=new Map(),seedBucket={async get(key){return seeding.has(key)?{etag:'e',json:async()=>structuredClone(seeding.get(key))}:null;},async put(key,value){seeding.set(key,JSON.parse(value));return {etag:'e'};},async list(){return {objects:[],truncated:false};}};
 const published=await PublishedEpgModule.publishGeneration({DB:db,BUCKET:seedBucket},{programmeRunId:G1,phase:'published',expectedProgrammeRunId:null,programme:{runId:G1,updatedAt:new Date(now).toISOString(),watchlistCount:0,films:[]},watchlist:{updatedAt:new Date(now).toISOString(),films:[]}},{now});
 assert.equal(published.pointed,true,'the fixture is a real D1-published generation');
 // Production reads through a bucket whose compatibility mirrors are missing (and, in the second run, stale: another run's pointer).
 for(const mirrors of ['missing','stale']){
  const mem=new Map();
  if(mirrors==='stale'){mem.set('epg/published-generation.json',{phase:'published',programmeRunId:'11111111-1111-4111-8111-aaaaaaaaaaaa'});mem.set('programme.json',{runId:'old',films:[]});}
  for(const key of ['epg/discovered-films.json','epg/generations/'+G1+'/discovered-films.json'])mem.set(key,{tmdb_7:catalogFilm('tmdb_7',7,{shows:[show(now-hour)]})});
  mem.set(constant('profileKey'),profile);mem.set(constant('ENRICHMENT_KEY')+'view-index.json',{tmdb_7:stored()});
  const writes=[];
  const spy={async get(key){return mem.has(key)?{etag:'e',json:async()=>structuredClone(mem.get(key))}:null;},async put(key){writes.push('put:'+key);throw new Error('R2 write in a GET: '+key);},async delete(key){writes.push('delete:'+key);throw new Error('R2 delete in a GET: '+key);},async list(){return {objects:[],truncated:false};},async head(key){return mem.has(key)?{etag:'e'}:null;}};
  const world=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
   fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
  vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),world);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),world);vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader','const {database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n'),world);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),world);
  vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),world);
  vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),world);
  for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),world);
  fetches.length=0;
  const callsBefore={batches:db.calls.batches,statements:db.calls.statements};statementsSeen.length=0;
  const response=await world.worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/film/7'),{DB:db,BUCKET:spy},{waitUntil(){}});
  const body=await response.json();
  assert.equal(response.status,200,mirrors+' mirrors: '+JSON.stringify(body));
  assert.equal(body.status,'found');assert.equal(body.film.tmdbId,'7');
  assert.equal(body.programmeRunId,G1,'the answer is pinned to the D1 generation, not to the stale or missing mirror');
  assert.deepEqual(writes,[],mirrors+' mirrors: no R2 put or delete in a GET');
  assert.equal(db.calls.batches,callsBefore.batches,'no D1 batch');assert.equal(db.calls.statements,callsBefore.statements,'no D1 statement written');
  assert.ok(statementsSeen.length>0&&statementsSeen.every(text=>/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)),'only reads reached D1: '+statementsSeen.filter(text=>!/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)).join(' | '));
  assert.deepEqual(fetches,[],'no provider request');
 }

 // AIR-531 review: the HTML document status against a real D1-published generation. Members of both kinds are 200 whatever the catalog says (the SPA resolves them first),
 // an id that is no member is 404, a TMDB permalink with no member falls to the bounded catalog identity (absent 404), and an unreadable generation or catalog is 200 (never absence).
 {
  const {db:docDb,statementsSeen:docSeen}=mkdb('published-doc');
  docDb.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
  // ADR 0162: Discovery is served from D1 only: the production state is d1/open with the Film admitted there (not the R2 shared object).
  open(docDb);admit(docDb,'tmdb_7',7);
  // ADR 0162: Film/Person is served from D1 only (as the `published` fixture above): without an open marker the catalog is unreadable and every absence would be an unknown, i.e. 200.
  docDb.sql("UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
  const docMem=new Map(),docBucket={async get(key){return docMem.has(key)?{etag:'e',json:async()=>structuredClone(docMem.get(key))}:null;},async put(key,value){docMem.set(key,JSON.parse(value));return {etag:'e'};},async list(){return {objects:[],truncated:false};},async head(key){return docMem.has(key)?{etag:'e'}:null;}};
  const member=id=>({id,title:'T '+id,original:'T '+id,year:2001,runtime:100,genres:[],directors:[],actors:[],shows:[]});
  const docPublished=await PublishedEpgModule.publishGeneration({DB:docDb,BUCKET:docBucket},{programmeRunId:G1,phase:'published',expectedProgrammeRunId:null,programme:{runId:G1,updatedAt:new Date(now).toISOString(),watchlistCount:1,films:[member('heat-1995'),member('tmdb_555'),{...member('alias-777'),tmdbId:'777',tmdbLink:{status:'resolved',link:{type:'movie',id:'777'}}},{...member('twin-a'),tmdbId:'888',tmdbLink:{status:'resolved',link:{type:'movie',id:'888'}}},{...member('twin-b'),tmdbId:'888',tmdbLink:{status:'resolved',link:{type:'movie',id:'888'}}},{...member('weak-889'),tmdbId:'889',tmdbLink:{status:'pending',link:{type:'movie',id:'889'}}}]},watchlist:{updatedAt:new Date(now).toISOString(),films:[member('only-watchlist'),member('tmdb_556')]}},{now});
  assert.equal(docPublished.pointed,true);
  const world=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{'/':{type:'text/html',body:'<!doctype html><title>shell</title>'}},INITIAL_PERSONAL_RATINGS:{},
   fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
  vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),world);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),world);vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader','const {database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n'),world);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),world);
  vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),world);
  vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),world);
  for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),world);
  world.DiscoveryAuthority=Authority;
  const doc=async(id,method='GET',env={DB:docDb,BUCKET:docBucket})=>{const r=await world.worker.fetch(new Request('https://iptv.vladimino.workers.dev/film/'+id,{method}),env,{waitUntil(){}});return {status:r.status,text:await r.text()};};
  for(const method of ['GET','HEAD']){
   assert.equal((await doc('heat-1995',method)).status,200,method+': a programme member is 200');
   assert.equal((await doc('only-watchlist',method)).status,200,method+': a watchlist member is 200');
   assert.equal((await doc('tmdb_555',method)).status,200,method+': a programme member that is a TMDB permalink is 200 although the catalog does not hold it');
   assert.equal((await doc('tmdb_556',method)).status,200,method+': a watchlist member that is a TMDB permalink is 200');
   assert.equal((await doc('tmdb_777',method)).status,200,method+': a published film that owns the TMDB id through its trusted link is 200 although the catalog holds no such film');
   assert.equal((await doc('tmdb_888',method)).status,409,method+': two published owners of one TMDB id are a conflict, as in the page');
   assert.equal((await doc('tmdb_889',method)).status,404,method+': an untrusted link is no owner');
   assert.equal((await doc('blablabla',method)).status,404,method+': an id that is no member is 404');
   assert.equal((await doc('tmdb_999',method)).status,404,method+': an absent TMDB permalink with no member is 404');
  }
  // AIR-531 review 2: the sealed documents change in place within one run (`saveWatchlist`, `patchProgramme`) and advance the generation; the owner map and the status follow.
  {
   const PE=vm.runInContext('PublishedEpg',world),env={DB:docDb,BUCKET:docBucket};
   const linked=(id,t)=>({...member(id),tmdbId:t,tmdbLink:{status:'resolved',link:{type:'movie',id:t}}});
   const watch=films=>({updatedAt:new Date(now).toISOString(),films});
   assert.equal((await doc('tmdb_777')).status,200,'warm: one owner');
   const gen0=(await PE.currentGeneration(env)).generation;
   const saved=await PE.saveWatchlist(env,watch([member('only-watchlist'),member('tmdb_556'),linked('twin-777','777')]),{now});
   assert.ok(saved,'the watchlist is replaced in place');
   assert.ok((await PE.currentGeneration(env)).generation>gen0,'a replacement in the same run advances the generation');
   assert.equal((await doc('tmdb_777')).status,409,'same run, new owner: the cached map is not served; two owners are a conflict');
   // The page answers a conflict of two owners before the catalog: a Film the catalog holds (tmdb_7) is 409 too.
   await PE.saveWatchlist(env,watch([member('only-watchlist'),member('tmdb_556'),linked('twin-7a','7'),linked('twin-7b','7')]),{now});
   assert.equal((await doc('tmdb_7')).status,409,'two owners and a catalog hit: 409, as the page');
   assert.equal((await doc('tmdb_777')).status,200,'the removed second owner leaves one owner (the programme film): 200');
   await PE.saveWatchlist(env,watch([member('only-watchlist'),member('tmdb_556')]),{now});
   assert.equal((await doc('tmdb_7')).status,200,'no owner: the catalog Film is 200 again');
   // A read that sees the generation move is unknown, never an absence.
   const live=await PE.currentGeneration(env);
   await assert.rejects(()=>PE.memberTmdbOwners(env,live.programmeRunId,live.generation-1),/published_epg_fence/,'a stale generation is fenced');
  }
  assert.ok((await doc('heat-1995')).text.includes('shell'),'the shell is still served on GET');
  // An unreadable catalog is no proof of absence either: the same published generation with Film/Person not open (the fixture state that hid this once) answers 200 for an absent TMDB id,
  // while an id that is a known non-member (the published side was read completely) is still 404.
  {
   const {db:closedDb}=mkdb('published-doc-closed');
   closedDb.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
   open(closedDb);
   const closedMem=new Map(),closedBucket={async get(key){return closedMem.has(key)?{etag:'e',json:async()=>structuredClone(closedMem.get(key))}:null;},async put(key,value){closedMem.set(key,JSON.parse(value));return {etag:'e'};},async list(){return {objects:[],truncated:false};},async head(key){return closedMem.has(key)?{etag:'e'}:null;}};
   const closedPublished=await PublishedEpgModule.publishGeneration({DB:closedDb,BUCKET:closedBucket},{programmeRunId:G1,phase:'published',expectedProgrammeRunId:null,programme:{runId:G1,updatedAt:new Date(now).toISOString(),watchlistCount:0,films:[member('heat-1995')]},watchlist:{updatedAt:new Date(now).toISOString(),films:[]}},{now});
   assert.equal(closedPublished.pointed,true);
   const closedEnv={DB:closedDb,BUCKET:closedBucket};
   const api=await world.worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/film/889'),closedEnv,{waitUntil(){}});
   assert.deepEqual([api.status,(await api.json()).reason],[503,'film_person_unavailable'],'the fixture state: the catalog cannot answer');
   assert.equal((await doc('tmdb_889','GET',closedEnv)).status,200,'an unreadable catalog is unknown: 200, not 404');
   assert.equal((await doc('tmdb_889','HEAD',closedEnv)).status,200,'HEAD too');
   assert.equal((await doc('blablabla','GET',closedEnv)).status,404,'a complete published read still proves a non-member');
  }
  // A generation that cannot be read is no proof of absence: the shell is served and the page decides.
  assert.equal((await doc('blablabla','GET',{DB:{prepare(){throw new Error('d1 down');}},BUCKET:docBucket})).status,200,'an unreadable generation fails open for a programme id');
  // The owners are asked before the catalog (as the page does), so the first TMDB request of a generation reads the sealed documents once; a warm one reads no document row.
  const documentReads=()=>docSeen.filter(text=>/published_epg_document/.test(text)).length;
  docSeen.length=0;assert.equal((await doc('tmdb_7')).status,200,'a catalog Film is 200');
  const cold=documentReads();assert.ok(cold>0,'cold: the sealed documents are read for the owner map');
  assert.equal((await doc('tmdb_7')).status,200);assert.equal(documentReads(),cold,'warm: no further document read for the same generation');
  assert.ok(docSeen.every(text=>/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)),'only reads reached D1');
  const memberProbe=docSeen.filter(text=>/SELECT 1 AS hit FROM published_epg_member/.test(text));
  assert.ok(memberProbe.length>0&&memberProbe.every(text=>/kind IN/.test(text)),'the membership probe names both kinds so it follows the (run, kind, film) index');
 }
}

// ---- 3d. AIR-409: a canonical Film the verified archive admitted, absent from Discovery ----
{
 vm.runInContext('globalThis.DiscoveryAuthority=undefined',ctx);
 const ADM='letterboxd/admissions/verified-films.json',sha='a'.repeat(64);
 const entry=(tmdb,extra={})=>({tmdb:String(tmdb),sourceCode:'abc'+tmdb,archiveSha256:sha,verifiedAt:'2026-11-09T10:00:00.000Z',title:'Archive '+tmdb,year:1999,runtime:101,genres:['Драма'],directors:[{id:'tmdb_director/5',name:'Режиссёр'}],actors:[],...extra});
 const archive=films=>({schemaVersion:1,films});
 seed(base);
 records.set(ADM,archive({tmdb_300:entry(300),tmdb_7:entry(7,{title:'Archive wins nothing'}),tmdb_301:entry(301,{watchlist:true}),tmdb_302:entry(999),tmdb_303:entry(303,{sourceCode:'bad code!'}),tmdb_304:entry(304,{archiveSha256:'zz'}),tmdb_305:entry(305,{verifiedAt:'nope'})}));
 let r=await get('300');
 assert.equal(r.status,200);assert.equal(r.body.status,'found');
 assert.deepEqual([r.body.film.id,r.body.film.tmdbId,r.body.film.canonicalIdentity,r.body.film.title,r.body.film.year,r.body.film.runtime],['tmdb_300','300','tmdb:300','Archive 300',1999,101]);
 assert.deepEqual(r.body.film.shows,[],'no EPG, no shows');assert.equal(r.body.film.availableNow,false);assert.equal(r.body.film.prediction,null);
 assert.deepEqual(r.body.film.directors,[{id:'tmdb_director/5',name:'Режиссёр'}]);
 r=await get('7');assert.equal(r.body.film.title,'Film tmdb_7','a Film Discovery has is answered by Discovery, never overridden by the archive');
 for(const id of ['301','302','303','304','305','306']){r=await get(id);assert.deepEqual([r.status,r.body.status],[404,'absent'],'not a verified admission: '+id);}
 // A missing object admits nobody; an unreadable or malformed one is unavailable, never absent.
 records.delete(ADM);r=await get('300');assert.deepEqual([r.status,r.body.status],[404,'absent']);
 for(const bad of [[],{schemaVersion:2,films:{}},{schemaVersion:1,films:[]},{schemaVersion:1}]){records.set(ADM,bad);r=await get('300');assert.deepEqual([r.status,r.body.status,r.body.reason],[503,'unavailable','discovery_unavailable']);}
 // Discovery conflict, retired and unavailable are not rescued by the archive.
 records.set(ADM,archive({tmdb_13:entry(13),tmdb_11:entry(11)}));
 r=await get('13');assert.equal(r.status,409);r=await get('11');assert.equal(r.status,409);
 // Discovery authority on D1: absent falls through to the archive, a fence stays 503, retired stays 410.
 const answer=(handled,list)=>{vm.runInContext('globalThis.DiscoveryAuthority={ownsKey:()=>false,readAuthority:async()=>({held:false,ready:false}),routeRead:async()=>({handled:false}),readFilmAdmission:async()=>__stub()}',ctx);ctx.__stub=async()=>({handled,records:list});};
 records.set(ADM,archive({tmdb_300:entry(300)}));
 answer(true,[]);r=await get('300');assert.deepEqual([r.status,r.body.film?.id],[200,'tmdb_300']);
 answer(true,[{filmId:'tmdb_300',state:'superseded',canonicalIdentity:'tmdb:300',tmdbId:'300',film:catalogFilm('tmdb_300',300)}]);r=await get('300');assert.equal(r.status,410,'retired in Discovery stays retired');
 ctx.__stub=async()=>{const error=new Error('f');error.code='discovery_fence';throw error;};r=await get('300');assert.deepEqual([r.status,r.body.reason],[503,'discovery_fence']);
 vm.runInContext('globalThis.DiscoveryAuthority=undefined',ctx);
 assert.deepEqual(puts,[],'read only');assert.deepEqual(fetches,[],'no outbound request');
}

// ---- 3e. AIR-409 review: the Film/Person authority gate and the canonical guards ----
{
 vm.runInContext('globalThis.DiscoveryAuthority=undefined',ctx);
 const ADM='letterboxd/admissions/verified-films.json',RET='identity/tmdb-retirements.json',sha='b'.repeat(64);
 const receipt=tmdb=>({schemaVersion:1,films:{['tmdb_'+tmdb]:{tmdb:String(tmdb),sourceCode:'sc'+tmdb,archiveSha256:sha,verifiedAt:'2026-11-09T10:00:00.000Z',title:'Receipt '+tmdb,year:2001}}});
 // A D1 that answers the authority reads and the two guards; anything else is empty. `broken` names a statement that fails.
 const fake=({version=16,marker={mode:'r2',cutover:'open',generation:0},external=[],redirects=[],broken=null,tables=true,retired=false,admissions=[],drift=null,filmRow=null,credits=[]}={})=>({
  prepare(sql){
   const run=kind=>{
    if(broken&&broken.test(sql))throw new Error('d1 down');
    if(/FROM schema_contract/.test(sql))return kind==='first'?{version}:{results:[]};
    // AIR-532: the three marker rows are read with ONE statement after the table inventory; `drift` keeps its meaning.
    if(/AS marker_rows,/.test(sql)){const m=drift&&(drift.n=(drift.n||0)+1)>drift.after?drift.marker:marker;const row={mode:m?.mode,cutover:m?.cutover,generation:m?.generation,fence_ok:1,fence_rows:1,baseline_state:'verified',baseline_reference:null,marker_rows:m?1:0,baseline_rows:1};return kind==='first'?row:{results:[row]};}
    if(/sqlite_master/.test(sql))return {results:tables?['film_person_authority','film_person_cas','film_person_baseline','canonical_revision'].map(name=>({name})):[]};
    if(/FROM film_person_authority/.test(sql)){if(drift&&(drift.n=(drift.n||0)+1)>drift.after)return drift.marker;return marker;}
    if(/FROM film_person_cas/.test(sql))return {ok:1};
    if(/FROM film_person_baseline/.test(sql))return {state:'verified',reference:null};
    if(/FROM tmdb_retirement_decision/.test(sql))return kind==='first'?(retired?{hit:1}:null):{results:[]};
    if(/FROM film_rated_admission/.test(sql))return {results:admissions};
    if(/FROM film f LEFT JOIN film_metadata/.test(sql))return kind==='first'?filmRow:{results:filmRow?[filmRow]:[]};
    if(/FROM film_person_credit/.test(sql))return {results:credits};
    if(/FROM film_external_id/.test(sql))return {results:external};
    if(/FROM film_redirect/.test(sql))return redirects.length?{hit:1}:null;
    return kind==='first'?null:{results:[]};
   };
   return {bind:()=>({first:async()=>run('first'),all:async()=>{const out=run('all');return out&&out.results?out:{results:[]};}}),first:async()=>run('first'),all:async()=>{const out=run('all');return out&&out.results?out:{results:[]};}};
  }
 });
 const ask=async(db,id='300')=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/film/'+id),{BUCKET:bucket,DB:db},{waitUntil(){}});return {status:r.status,body:await r.json()};};
 seed(base);records.set(ADM,receipt(300));
 // ADR 0162: only d1 / open answers. A legacy contract (below 13), an r2 or prepared marker and a drifting generation are refused (503) and the R2 receipt is never read.
 let r=await ask(fake({version:12}));assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'legacy');
 reads.length=0;r=await ask(fake());assert.ok(!reads.includes(ADM),'r2 never reads the R2 receipt');assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'r2 is refused');
 reads.length=0;r=await ask(fake({marker:{mode:'prepared',cutover:'open',generation:1}}));assert.ok(!reads.includes(ADM));assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'prepared is refused');
 // The authority names D1 or is unreadable: never R2.
 r=await ask(fake({marker:{mode:'d1',cutover:'held',generation:2}}));assert.deepEqual([r.status,r.body.status,r.body.reason],[503,'unavailable','film_person_held'],'held fails closed');
 // AIR-374 P4: at open D1 answers (film_rated_admission, identity claims, redirects, the retirement ledger) and the R2 receipt and retirements object are never read.
 const OPEN={mode:'d1',cutover:'open',generation:2},adm={film_id:'film:tmdb:300',tmdb:'300',source_code:'sc300',archive_sha256:sha,title:'D1 300',year:2001,receipt_key:ADM,receipt_film_key:'tmdb_300',verified_at:'2026-11-09T10:00:00.000Z'},own=[{film_id:'film:tmdb:300',trusted:1,conflicting:0}];
 reads.length=0;
 r=await ask(fake({marker:OPEN}));assert.deepEqual([r.status,r.body.status],[404,'absent'],'open: no D1 Film is absent, the R2 receipt does not admit it');
 const canon={canonical_identity:'tmdb:300',original_title:'Original 300',year:1998,runtime:96,poster:'https://image.tmdb.org/t/p/w342/300.jpg',url:'https://www.themoviedb.org/movie/300',genres_json:'["Драма"]',title:'Каноническое 300'};
 r=await ask(fake({marker:OPEN,external:own}));assert.deepEqual([r.status,r.body.reason],[503,'canonical_read_unavailable'],'open: a trusted claim without its Film row is an inconsistent store, never absent');
 // AIR-475: a retained canonical Film is a Film with no Discovery record and no admission row; D1 metadata, localization and credits fill the page.
 r=await ask(fake({marker:OPEN,external:own,filmRow:canon,credits:[{role:'actor',role_id:'tmdb_actor/2',name:'Актёр'},{role:'director',role_id:'tmdb_director/1',name:'Режиссёр'},{role:'actor',role_id:'tmdb_actor/3',name:null}]}));
 assert.equal(r.status,200,'open: found from the canonical Film alone');
 assert.deepEqual([r.body.film.id,r.body.film.title,r.body.film.original,r.body.film.year,r.body.film.runtime,r.body.film.genres,r.body.film.poster],['tmdb_300','Каноническое 300','Original 300',1998,96,['Драма'],'https://image.tmdb.org/t/p/w342/300.jpg']);
 assert.deepEqual([r.body.film.directors,r.body.film.actors,r.body.film.shows,r.body.film.availableNow],[[{id:'tmdb_director/1',name:'Режиссёр'}],[{id:'tmdb_actor/2',name:'Актёр'}],[],false],'credits without a resolved name are omitted; no shows, no EPG');
 r=await ask(fake({marker:OPEN,external:own,filmRow:{...canon,canonical_identity:'tmdb:301'}}));assert.equal(r.status,409,'open: a Film recording another canonical identity is a conflict');
 r=await ask(fake({marker:OPEN,external:own,filmRow:{...canon,genres_json:'not json'}}));assert.deepEqual([r.status,r.body.reason],[503,'canonical_read_unavailable'],'open: unreadable stored genres fail closed');
 r=await ask(fake({marker:OPEN,external:own,filmRow:{...canon,title:null,original_title:null,year:null,runtime:null,poster:null,url:null,genres_json:'[]'}}));assert.deepEqual([r.status,r.body.film.title,r.body.film.year,r.body.film.genres],[200,null,null,[]],'open: a bare canonical Film is still a Film');
 r=await ask(fake({marker:OPEN,external:own,filmRow:{...canon,title:null,year:null},admissions:[adm]}));assert.deepEqual([r.status,r.body.film.title,r.body.film.year],[200,'D1 300',2001],'open: a rated admission only fills a missing title or year');
 r=await ask(fake({marker:OPEN,external:own,filmRow:canon,admissions:[adm]}));assert.deepEqual([r.status,r.body.film.title,r.body.film.year],[200,'Каноническое 300',1998],'open: canonical localization and metadata win over the admission row');
 r=await ask(fake({marker:OPEN,external:own,filmRow:canon,credits:Array.from({length:201},(_,i)=>({role:'actor',role_id:'tmdb_actor/'+i,name:'A'+i}))}));assert.deepEqual([r.status,r.body.film.actors.length],[200,200],'AIR-656 open: credits above the read bound are a bounded, honestly partial page, never a whole-film refusal');
 r=await ask(fake({marker:OPEN,external:own,filmRow:canon,credits:[{role:'actor',role_id:'tmdb_actor/9',name:null,alias_name:'Alias Actor'}]}));assert.deepEqual([r.status,r.body.film.actors],[200,[{id:'tmdb_actor/9',name:'Alias Actor'}]],'AIR-656 open: an alias-only Person is shown by its name alias');
r=await ask(fake({marker:OPEN,external:own,admissions:[{...adm,tmdb:'301'}]}));assert.deepEqual([r.status,r.body.reason],[503,'canonical_read_unavailable'],'open: an admission row whose tmdb differs from the typed id fails closed');
 r=await ask(fake({marker:OPEN,external:own,filmRow:canon,admissions:[adm],retired:true}));assert.deepEqual([r.status,r.body.status],[410,'retired'],'open: the D1 retirement ledger');
 r=await ask(fake({marker:OPEN,external:own,filmRow:canon,admissions:[adm],redirects:['film:tmdb:300']}));assert.equal(r.status,410,'open: a redirect source is retired');
 r=await ask(fake({marker:OPEN,external:[...own,{film_id:'film:b',trusted:0,conflicting:0}],admissions:[adm]}));assert.equal(r.status,409,'open: a foreign claim is a conflict');
 r=await ask(fake({marker:OPEN,external:own,filmRow:canon,admissions:[adm],broken:/film_rated_admission/}));assert.deepEqual([r.status,r.body.reason],[503,'admission_unavailable'],'open: a failed admission read fails closed');
 r=await ask(fake({marker:OPEN,external:own,filmRow:canon,admissions:[adm],broken:/tmdb_retirement_decision/}));assert.deepEqual([r.status,r.body.reason],[503,'canonical_read_unavailable'],'open: a failed ledger read fails closed');
 r=await ask(fake({marker:OPEN,external:own,filmRow:canon,admissions:[adm],drift:{after:3,marker:{mode:'d1',cutover:'open',generation:3}}}));assert.deepEqual([r.status,r.body.reason],[503,'film_person_generation_moved'],'open: a marker that moves during the read refuses the answer');
 r=await ask(fake({marker:OPEN,external:own,filmRow:canon,admissions:[adm],drift:{after:3,marker:{mode:'d1',cutover:'held',generation:3}}}));assert.equal(r.status,503,'open then held mid-read');
 assert.ok(!reads.includes(ADM)&&!reads.includes(RET),'no silent R2 fallback: neither the receipt object nor the retirements object is read at open (reads: '+[...new Set(reads)].join(',')+')');
 r=await ask(fake({marker:null}));assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'a missing marker row');
 r=await ask(fake({marker:{mode:'bogus',cutover:'open',generation:0}}));assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'a malformed marker');
 r=await ask(fake({tables:false}));assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'a missing companion table');
 r=await ask(fake({broken:/film_person_authority/}));assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'a failed marker read');
 // AIR-499: optional metadata at held is typed STOP, not a Discovery-only 200 with R2 metadata.json.
 r=await ask(fake({marker:{mode:'d1',cutover:'held',generation:2}}),'7');assert.deepEqual([r.status,r.body.reason],[503,'film_person_held'],'held stops the film page before frozen metadata.json');
 // Canonical guards. The owner's R2 retirement, a D1 contradiction, a redirected Film.
 const fo=o=>fake({marker:OPEN,admissions:[adm],filmRow:canon,external:own,...o});
 // The R2 retirements object is never read at open (the D1 ledger decides); the R2-only retirement arm is gone with the r2 state (ADR 0162).
 r=await ask(fo({external:[{film_id:'film:a',trusted:1,conflicting:0},{film_id:'film:b',trusted:1,conflicting:0}]}));assert.equal(r.status,409,'two Films trust one TMDB id');
 r=await ask(fo({external:[{film_id:'film:a',trusted:0,conflicting:1}]}));assert.equal(r.status,409,'a conflicting external id');
 r=await ask(fo({external:[{film_id:'film:a',trusted:0,conflicting:0}]}));assert.equal(r.status,409,'only an untrusted, non-conflicting claim holds the identity');
 r=await ask(fo({external:[{film_id:'film:a',trusted:1,conflicting:0},{film_id:'film:b',trusted:0,conflicting:0}]}));assert.equal(r.status,409,'a trusted owner beside an untrusted claim of another Film');
 r=await ask(fo({external:[{film_id:'film:a',trusted:1,conflicting:0},{film_id:'film:a',trusted:0,conflicting:0}]}));assert.equal(r.status,409,'any claim that is not the owner\'s own trusted row, even on the same Film');
 r=await ask(fo({external:[{film_id:'film:a',trusted:1,conflicting:0},{film_id:'film:x',trusted:0,conflicting:0},{film_id:'film:y',trusted:0,conflicting:0},{film_id:'film:z',trusted:0,conflicting:0},{film_id:'film:v',trusted:0,conflicting:0},{film_id:'film:w',trusted:0,conflicting:1}]}));assert.equal(r.status,409,'six claims: none is masked by a row limit');
 r=await ask(fo({external:[{film_id:'film:a',trusted:1,conflicting:0}],redirects:['film:a']}));assert.equal(r.status,410,'the Film was merged into another');
 r=await ask(fo());assert.equal(r.status,200,'one trusted, unredirected Film agrees with the receipt');
 r=await ask(fo({broken:/film_external_id/}));assert.deepEqual([r.status,r.body.reason],[503,'canonical_read_unavailable'],'a failed canonical guard is unavailable, never found');
 r=await ask(fo({broken:/film_redirect/}));assert.equal(r.status,503);
 assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
}

// ---- 3f. AIR-475: a retained canonical Film opens by its permanent TMDB id at d1/open, with no Discovery record, no rated admission, no programme and no watchlist ----
{
 vm.runInContext('globalThis.DiscoveryAuthority=undefined',ctx);
 const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
 const base=path.join(root,'retained-base.sqlite');sql(base,names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')+RATINGS_D1+PREDICTION_D1);
 const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
 const OPEN=VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";
 const HELD=OPEN+"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;";
 const T='2026-11-14T00:00:00.000Z',q=value=>"'"+String(value).replace(/'/g,"''")+"'";
 // The five production examples of the card (14 Nov 2026): three retained films nobody lists any more, two controls Discovery holds. Every Film has a trusted, non-conflicting claim and a film_retention row; none has a rated admission.
 const FILMS={1423191:['Обитель зла','Resident Evil',2026,106],22004:['Чужая территория','Alien Territory',1992,98],1272837:['28 лет спустя: Храм костей','28 Years Later: The Bone Temple',2026,109],10750:['Игрушечные солдатики','Toy Soldiers',1991,112],1100988:['28 лет спустя','28 Years Later',2025,115]};
 const seedFilm=(id,[title,original,year,runtime],{credits=true}={})=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${id}',1,'tmdb:${id}',${q(original)},'${T}');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:${id}','tmdb','${id}',1,0);
INSERT INTO film_metadata (film_id,schema_version,year,runtime,poster,url,genres_json,payload_json,updated_at) VALUES ('film:tmdb:${id}',1,${year},${runtime},'https://image.tmdb.org/t/p/w342/${id}.jpg','https://www.themoviedb.org/movie/${id}','["Ужасы"]','{}','${T}');
INSERT INTO film_dimension (film_id,dimension,status,value,updated_at) VALUES ('film:tmdb:${id}','localization','provisional',${q(title)},'${T}');
INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:tmdb:${id}','watchlist_fact',0,'{}','r${id}','${T}','${T}');
${credits?`INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:director/d${id}','director/d${id}',1,'${T}'),('person:actor/a${id}','actor/a${id}',1,'${T}'),('person:actor/n${id}','actor/n${id}',1,'${T}');
INSERT INTO person_dimension (person_id,dimension,status,value,updated_at) VALUES ('person:director/d${id}','localization','provisional','Режиссёр ${id}','${T}'),('person:actor/a${id}','localization','reviewed','Актёр ${id}','${T}');
INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:tmdb:${id}','person:director/d${id}','director',0),('film:tmdb:${id}','person:actor/a${id}','actor',0),('film:tmdb:${id}','person:actor/n${id}','actor',1);`:''}`;
 const SEED=Object.entries(FILMS).map(([id,row])=>seedFilm(id,row)).join('\n');
 let counter=0;const statements=[];
 const mount=(marker,extra='')=>{const file=path.join(root,'retained-'+(counter++)+'.sqlite');fs.copyFileSync(base,file);sql(file,SEED+extra+marker);return {file,db:d1Standin(file,{onQuery:async text=>{statements.push(text);}})};};
 const ask=async(db,id)=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/film/'+id),{BUCKET:bucket,DB:db},{waitUntil(){}});return {status:r.status,body:await r.json()};};
 // Discovery (the R2 shared catalog here) holds only the two controls; the three retained films are in no Discovery object, no programme, no watchlist.
 seed({tmdb_10750:catalogFilm('tmdb_10750',10750,{title:'Игрушечные солдатики'}),tmdb_1100988:catalogFilm('tmdb_1100988',1100988,{title:'28 лет спустя'})});
 {
  const {db,file}=mount(OPEN);statements.length=0;
  for(const id of [1423191,22004,1272837]){
   const r=await ask(db,String(id)),[title,original,year,runtime]=FILMS[id];
   assert.equal(r.status,200,'retained film '+id+' opens: '+JSON.stringify(r.body));assert.equal(r.body.status,'found');
   assert.deepEqual([r.body.film.id,r.body.film.tmdbId,r.body.film.canonicalIdentity,r.body.film.title,r.body.film.original,r.body.film.year,r.body.film.runtime,r.body.film.genres],['tmdb_'+id,String(id),'tmdb:'+id,title,original,year,runtime,['Ужасы']]);
   assert.deepEqual([r.body.film.directors,r.body.film.actors],[[{id:'director/d'+id,name:'Режиссёр '+id}],[{id:'actor/a'+id,name:'Актёр '+id}]],'credits with a resolved name, the nameless one omitted');
   assert.deepEqual([r.body.film.shows,r.body.film.availableNow,r.body.film.nextStart,r.body.film.prediction],[[],false,null,null],'no current showing is normal; no prediction is invented');
   assert.equal(r.body.film.poster,'https://image.tmdb.org/t/p/w342/'+id+'.jpg');assert.match(r.body.film.url,/themoviedb\.org\/movie\//);
  }
  for(const id of [10750,1100988]){const r=await ask(db,String(id));assert.equal(r.status,200,'control '+id);assert.equal(r.body.film.id,'tmdb_'+id,'a Film Discovery holds still opens (Discovery wins; no duplicate)');assert.deepEqual(r.body.film.shows.length,0);}
  assert.ok(statements.length>0&&statements.every(text=>/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)),'only reads reached D1: '+statements.filter(text=>!/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)).join(' | '));
  /* the prediction and ratings authority markers are read in one read-only batch each: the SELECT-only assertion above covers every statement of it */
  // The film is not added to the watchlist, the programme or Finds, and no film row changes: the catalog GET writes nothing.
  assert.equal(sqliteSync(['-json',file,'SELECT (SELECT COUNT(*) FROM watchlist_film) w,(SELECT COUNT(*) FROM film) f'],{encoding:'utf8'}).stdout.replace(/\s/g,''),'[{"w":0,"f":5}]');
  assert.deepEqual([puts,fetches],[[],[]],'no R2 write, no provider request');
  // True absence, a missing frozen R2 object is not consulted, and an unknown id stays 404.
  assert.deepEqual([(await ask(db,'999999')).status,(await ask(db,'999999')).body.status],[404,'absent']);
 }
 {
  // Re-add: the same Film later enters the watchlist and the programme again; one canonical Film, one permalink, no duplicate row.
  const {db,file}=mount(OPEN,`INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:22004','${T}');`);
  const r=await ask(db,'22004');assert.equal(r.status,200,'a re-added Film is the same permalink');assert.equal(r.body.film.id,'tmdb_22004');
  assert.equal(sqliteSync(['-json',file,"SELECT COUNT(*) c FROM film WHERE id='film:tmdb:22004'"],{encoding:'utf8'}).stdout.replace(/\s/g,''),'[{"c":1}]');
 }
 {
  // The states stay what they are: conflict 409, redirect and retirement 410, held 503, an inconsistent claim 503.
  const extra=`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:rival',1,NULL,'Rival','${T}');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:rival','tmdb','22004',0,0);
INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:1272837','film:tmdb:1423191','${T}');
INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq,payload_json,recorded_at) VALUES ('ret1','film:tmdb:1423191','retire','abc','1423191','555','{}','{"by":"owner","at":"${T}","source":"t"}','owner_request',NULL,NULL,'{}','${T}');`;
  const {db}=mount(OPEN,extra);
  assert.deepEqual([(await ask(db,'22004')).status,(await ask(db,'1272837')).status,(await ask(db,'1423191')).status,(await ask(db,'1100988')).status],[409,410,410,200],'untrusted rival claim, redirect source, owner retirement, an untouched film');
  const held=mount(HELD);const r=await ask(held.db,'22004');assert.deepEqual([r.status,r.body.reason],[503,'film_person_held'],'held fails closed with no R2 fallback');
 }
 {
  // Review P1-3: the permalink of a canonical Film does not depend on Discovery's health. A Discovery reader that is held, loading, unreadable or not authoritative leaves the
  // answer to D1 while Film/Person is open; verified conflicts and retirements stay 409/410; a canonical absence, or a Film/Person marker that is not open, keeps the Discovery 503.
  const extra=`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:rival',1,NULL,'Rival','${T}');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:rival','tmdb','22004',0,0);
INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:1272837','film:tmdb:1423191','${T}');`;
  const open=mount(OPEN,extra),held=mount(HELD),prepared=mount(VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;");
  const fault=code=>{vm.runInContext('globalThis.DiscoveryAuthority={ownsKey:()=>false,readAuthority:async()=>({held:false,ready:false}),routeRead:async()=>({handled:false}),readFilmAdmission:async()=>__stub()}',ctx);ctx.__stub=async()=>{const error=new Error(code);error.code=code;throw error;};};
  for(const code of ['discovery_fence','discovery_incomplete','discovery_unavailable','discovery_not_authoritative']){
   fault(code);statements.length=0;
   let r=await ask(open.db,'10750');assert.deepEqual([r.status,r.body.status,r.body.film?.id,r.body.film?.title],[200,'found','tmdb_10750','Игрушечные солдатики'],code+': a retained Film opens while Discovery cannot answer');
   assert.deepEqual([r.body.film.shows,r.body.film.availableNow],[[],false],'no shows are taken from Discovery');
   assert.deepEqual([(await ask(open.db,'22004')).status,(await ask(open.db,'1272837')).status],[409,410],code+': a verified conflict and a redirect stay 409 and 410');
   r=await ask(open.db,'999999');assert.deepEqual([r.status,r.body.status,r.body.reason],[503,'unavailable',code],code+': a canonical absence does not turn an unreadable Discovery into absent');
   r=await ask(held.db,'10750');assert.deepEqual([r.status,r.body.reason],[503,code],code+': a held Film/Person marker keeps the Discovery refusal, never R2');
   r=await ask(prepared.db,'10750');assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],code+': a prepared marker is not served (ADR 0162)');
   assert.ok(statements.every(text=>/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)),code+': only reads');
  }
  vm.runInContext('globalThis.DiscoveryAuthority=undefined',ctx);
  ctx.__stub=undefined;
 }
 assert.deepEqual([puts,fetches],[[],[]]);
}

// ---- 3g. AIR-475 production acceptance: the permanent page shows the owner's rating and watched mark, the stored forecast and its fingerprint of a retained Film, found through the verified D1 lid ----
{
 vm.runInContext('globalThis.DiscoveryAuthority=undefined',ctx);
 const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
 const base=path.join(root,'alias-base.sqlite');sql(base,names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')+RATINGS_D1+PREDICTION_BARE);
 const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
 const OPEN=VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";
 const T='2026-11-14T00:00:00.000Z',q=value=>"'"+String(value).replace(/'/g,"''")+"'";
 // Live-equivalent facts of the acceptance: tmdb -> lid pairs SEXE, 1BbQ, MwlA are trusted claims of one Film each; tmdb 10750 has a lid that another Film also claims (untrusted): a contested identity.
 const film=(id,title,original)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${id}',1,'tmdb:${id}',${q(original)},'${T}');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:${id}','tmdb','${id}',1,0);INSERT INTO film_dimension (film_id,dimension,status,value,updated_at) VALUES ('film:tmdb:${id}','localization','provisional',${q(title)},'${T}');`;
 const lid=(id,value,trusted=1)=>`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:${id}','letterboxd','${value}',${trusted},0);`;
 const SEED=film(1423191,'Обитель зла','Resident Evil')+lid(1423191,'SEXE')+film(22004,'Чужая территория','Alien Territory')+lid(22004,'1BbQ')+film(1272837,'28 лет спустя: Храм костей','The Bone Temple')+lid(1272837,'MwlA')
  +film(10750,'Игрушечные солдатики','Toy Soldiers')+lid(10750,'LID10750')+`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:rival',1,NULL,'Rival','${T}');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:rival','letterboxd','LID10750',0,0);`;
 let counter=0;const statements=[];
 const mount=marker=>{const file=path.join(root,'alias-'+(counter++)+'.sqlite');fs.copyFileSync(base,file);sql(file,SEED+marker);return d1Standin(file,{onQuery:async text=>{statements.push(text);}});};
 const ask=async(db,id)=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/film/'+id),{BUCKET:bucket,DB:db},{waitUntil(){}});return {status:r.status,body:await r.json()};};
 seed({tmdb_10750:catalogFilm('tmdb_10750',10750,{title:'Игрушечные солдатики'})});
 const indexKey=constant('ENRICHMENT_KEY')+'view-index.json';
 // The R2 view index as production has it: the TMDB spellings hold only watchlist facts, the lids hold the forecasts, the ratings and the watched marks.
 records.set(indexKey,{tmdb_1423191:{watchlist:true},tmdb_22004:{watchlist:true},tmdb_1272837:{watchlist:true},
  SEXE:{...stored(),actualRating:4.5,watched:true},'1BbQ':{...stored({tasteProfileHash:'old'}),actualRating:3.5,watched:true},MwlA:{...stored(),watched:true},LID10750:{...stored(),actualRating:2,watched:true}});
 // ADR 0162: ratings are D1 (d1/open), so the watched marks, ratings and watchlist facts of the view come from ratings_view, as in
 // production; the R2 view index keeps only the forecasts. These rows mirror the facts above.
 const view=(alias,fact,{watched=null,rating,watchlist=null}={})=>`INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('${alias}','${fact}',${watched===null?'NULL':watched?1:0},${rating===undefined?'NULL':rating},${watchlist===null?'NULL':watchlist?1:0},${rating===undefined?0:1},'${T}');`;
 const RATINGS=view('SEXE','lb-sexe',{watched:true,rating:4.5})+view('1BbQ','lb-1bbq',{watched:true,rating:3.5})+view('MwlA','lb-mwla',{watched:true})+view('LID10750','lb-10750',{watched:true,rating:2})
  +view('tmdb_1423191','lb-sexe',{watchlist:true})+view('tmdb_22004','lb-1bbq',{watchlist:true})+view('tmdb_1272837','lb-mwla',{watchlist:true});
 const db=mount(OPEN+RATINGS);statements.length=0;
 let r=await ask(db,'1423191');assert.equal(r.status,200,JSON.stringify(r.body));
 assert.deepEqual([r.body.film.actualRating,r.body.film.watched,r.body.film.prediction.predictedRating,r.body.film.prediction.compatibility,r.body.film.prediction.stale],[4.5,true,4.5,'current',undefined],'SEXE: rating, watched mark and the current forecast, reached through the verified lid');
 assert.deepEqual(r.body.film.fingerprint.plotMechanics,['investigation'],'the stored fingerprint is shown');assert.equal(r.body.film.prediction.tasteProfileVersion,1);assert.equal(r.body.degraded,undefined);
 r=await ask(db,'22004');assert.deepEqual([r.body.film.actualRating,r.body.film.watched,r.body.film.prediction.stale,typeof r.body.film.prediction.staleReason],[3.5,true,true,'string'],'1BbQ: a really stale forecast is marked with the evaluator\'s reason, the rating and mark are still shown');assert.ok(r.body.film.fingerprint,'the fingerprint is shown although the forecast is stale');
 r=await ask(db,'1272837');assert.deepEqual([r.body.film.actualRating,r.body.film.watched,r.body.film.prediction.predictedRating],[null,true,4.5],'MwlA: watched without a rating has no rating');
 // A contested lid is never used: no forecast, no rating, the degraded part is named; nothing is guessed from the title or a slug.
 r=await ask(db,'10750');assert.equal(r.status,200);assert.deepEqual([r.body.film.actualRating,r.body.film.watched,r.body.film.prediction],[null,false,null],'a contested identity shows none of the lid\'s facts');assert.ok(r.body.degraded.includes('identity'));
 assert.ok(statements.length>0&&statements.every(text=>/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)),'only reads reached D1');assert.deepEqual([puts,fetches],[[],[]],'no write, no provider request');
 // Below open there is no D1 identity: no alias, so the TMDB entry alone is read (the production defect, kept visible).
 const prepared=mount(VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;");
 r=await ask(prepared,'1423191');assert.equal(r.status,503,'below open nothing is served (ADR 0162)');
 // A held marker keeps failing closed (503), with no alias read.
 const held=mount(OPEN+"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;");r=await ask(held,'1423191');assert.deepEqual([r.status,r.body.reason],[503,'film_person_held']);
 // ADR 0162 (review of #742): a held ratings cutover is a 503, never the stale rating and watched mark of the R2 view index above.
 const ratingsHeld=mount(OPEN+RATINGS+"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1;");r=await ask(ratingsHeld,'1423191');
 assert.deepEqual([r.status,r.body.status,r.body.reason],[503,'unavailable','ratings_domain_not_authoritative'],'a held ratings cutover refuses the page: '+JSON.stringify(r.body));
}

// ---- 3h. AIR-475 review of the acceptance fix: with Film/Person, Ratings and Predictions ALL d1/open, the page shows the D1 forecast, fingerprint, rating and watched mark of the verified lid even when
// the R2 view index lacks the key (or is missing altogether), D1 overrides stale R2 display data, an unrated film with only a D1 forecast shows its forecast, a contested lid exposes nothing, and the history agrees ----
{
 vm.runInContext('globalThis.DiscoveryAuthority=undefined',ctx);
 const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
 const base=path.join(root,'domains-base.sqlite');sql(base,names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')+RATINGS_D1);
 const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
 const OPEN=VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";
 const DOMAINS="UPDATE prediction_domain_authority SET mode='d1' WHERE id=1;UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;";
 const T='2026-11-14T00:00:00.000Z',q=value=>"'"+String(value).replace(/'/g,"''")+"'",sha=text=>createHash('sha256').update(text).digest('hex');
 const film=(id,title,original)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${id}',1,'tmdb:${id}',${q(original)},'${T}');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:${id}','tmdb','${id}',1,0);INSERT INTO film_dimension (film_id,dimension,status,value,updated_at) VALUES ('film:tmdb:${id}','localization','provisional',${q(title)},'${T}');`;
 const lid=(id,value)=>`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:${id}','letterboxd','${value}',1,0);`;
 // The D1 forecast of a lid: pointer (display facts), fingerprint features and the immutable version body in R2.
 const forecast=(lidId,rating,hash='f')=>{
  const display={predictedRating:rating,probability4Plus:.74,confidence:'high',matchSignals:['Investigation'],mainRisk:'Slow start',moodLabels:['мрачный','напряжённый'],tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:hash,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,predictionPromptVersion:1,generatedAt:'2026-11-10T10:00:00.000Z',filmId:lidId,runId:'run-'+lidId,trigger:'scheduled'};
  const text=ctx.predictionVersionText(display),digest=sha(text),key=ctx.predictionVersionKey(lidId,digest);records.set(key,JSON.parse(text));
  const features={fingerprintHash:hash,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,invalidatedAt:null,plotMechanics:['investigation'],moodLabels:['мрачный'],execution:{payoff:'strong',pacing:'unknown'}};
  return `INSERT INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES (${q(lidId)},1,'p1',${q(hash)},1,1,${rating},'${key}','${digest}','${T}',${q(JSON.stringify(display))});INSERT INTO prediction_fingerprint (film_id,fingerprint_hash,schema_version,prompt_version,generated_at,invalidated_at,r2_key,content_sha256,features_json) VALUES (${q(lidId)},${q(hash)},1,1,'${T}',NULL,'fp/${lidId}','${'a'.repeat(64)}',${q(JSON.stringify(features))});`;
 };
 const view=(alias,watched,rating,known)=>`INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES (${q(alias)},'tmdb-x',${watched},${rating},NULL,${known},'${T}');`;
 const docs=(lidId,tmdb)=>{const put=(key,value)=>{const body=JSON.stringify(value);return `INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('${key}',0,${q(body)},'${sha(body)}','${T}');`;};
  return put('letterboxd/facts/links.json',{['tmdb:'+tmdb]:'tmdb-'+tmdb,['letterboxd:'+lidId]:'tmdb-'+tmdb})+put('letterboxd/facts/films/tmdb-'+tmdb+'.json',{schemaVersion:1,factKey:'tmdb-'+tmdb,links:{letterboxd:lidId,tmdb:String(tmdb)},redirectTo:null,migrating:null,watched:true,rating:{value:4.5,observedAt:'2026-11-10T00:00:00.000Z',source:'owner',sourceRef:null,observationId:'o1'},ratingHistory:[{kind:'first_observed',recordedAt:'2026-11-10T00:00:00.000Z',value:4.5,observedAt:'2026-11-10T00:00:00.000Z',source:'owner',sourceRef:null,observationId:'o1',previous:null}]})+put('letterboxd/diary/history.json',{schemaVersion:1,entries:{'viewing:77':{key:'viewing:77',source:'letterboxd_diary',identity:{type:'letterboxd_lid',value:lidId},aliases:[],firstObservedAt:'2026-11-10T00:00:00.000Z',observedAt:'2026-11-10T00:00:00.000Z',page:1,changes:[],keyBasis:'viewing_id',viewingId:'77',watchedDate:'2026-11-10',viewings:1,viewingsCertain:true,ratingAtEntry:4.5,ratingsAtEntry:[4.5],rewatch:false}}})+put('letterboxd/diary/state.json',{schemaVersion:1,lastOutcome:'complete',lastSuccessAt:'2026-11-16T16:01:14.000Z',coverage:{newestWatchedDate:'2026-11-10',oldestWatchedDate:'2010-01-01',reachedEnd:true},resumePage:null});};
 const SEED=film(1423191,'Обитель зла','Resident Evil')+lid(1423191,'SEXE')+film(22004,'Чужая территория','Alien Territory')+lid(22004,'1BbQ')+film(1272837,'Храм костей','The Bone Temple')+lid(1272837,'MwlA')
  +film(10750,'Игрушечные солдатики','Toy Soldiers')+lid(10750,'LID10750')+`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:rival',1,NULL,'Rival','${T}');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:rival','letterboxd','LID10750',0,0);`;
 seed({tmdb_10750:catalogFilm('tmdb_10750',10750,{title:'Игрушечные солдатики'})}); // clears the in-memory R2: every body below is written after it
 // The taste profile is a prediction-domain document too: with the domain d1 the active profile is the D1 row (its immutable body in R2), never the R2 current.json.
 const profileText=JSON.stringify({profileHash:'p1',version:1}),profileKey='enrichment/profile/versions/1.json';records.set(profileKey,JSON.parse(profileText));
 const PROFILE=`INSERT INTO prediction_profile (version,profile_hash,created_at,r2_key,content_sha256,lineage_json,active) VALUES (1,'p1','${T}','${profileKey}','${sha(profileText)}',NULL,1);`;
 const D1=PROFILE+forecast('SEXE',4.5)+view('SEXE',1,4.5,1)+docs('SEXE',1423191)+forecast('1BbQ',3.5)+forecast('MwlA',4)+view('MwlA',1,'NULL',0)+forecast('LID10750',5)+view('LID10750',1,5,1);
 const file=path.join(root,'domains-'+Math.random().toString(36).slice(2)+'.sqlite');fs.copyFileSync(base,file);sql(file,SEED+D1+OPEN+DOMAINS);
 const statements=[],db=d1Standin(file,{onQuery:async text=>{statements.push(text);}});
 const ask=async id=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/film/'+id),{BUCKET:bucket,DB:db},{waitUntil(){}});return {status:r.status,body:await r.json()};};
 const indexKey=constant('ENRICHMENT_KEY')+'view-index.json';
 // 1. No R2 view index at all: the D1 domains alone supply everything.
 records.delete(indexKey);statements.length=0;
 let r=await ask('1423191');assert.equal(r.status,200,JSON.stringify(r.body));
 assert.deepEqual([r.body.film.prediction.predictedRating,r.body.film.prediction.compatibility,r.body.film.actualRating,r.body.film.watched],[4.5,'current',4.5,true],'SEXE: forecast, rating and watched mark from D1 with no R2 index');
 assert.deepEqual(r.body.film.fingerprint.plotMechanics,['investigation'],'the D1 fingerprint is shown');
 // 2. An unrated film with only a D1 forecast (no ratings row at all): the forecast is shown, rating unknown, not watched.
 r=await ask('22004');assert.deepEqual([r.body.film.prediction.predictedRating,r.body.film.actualRating,r.body.film.watched],[3.5,null,false],'1BbQ: only a D1 forecast');assert.ok(r.body.film.fingerprint);
 // 3. An R2 index that exists but lacks the lid key, and one that holds stale display data: D1 decides.
 records.set(indexKey,{tmdb_1272837:{watchlist:true},MwlA:{...stored({predictedRating:1}),actualRating:1,watched:false}});
 r=await ask('1272837');assert.deepEqual([r.body.film.prediction.predictedRating,r.body.film.actualRating,r.body.film.watched],[4,null,true],'MwlA: D1 overrides the stale R2 display data (a watched mark with no known rating has no rating)');
 records.set(indexKey,{tmdb_1423191:{watchlist:true},unrelated:stored()});
 r=await ask('1423191');assert.deepEqual([r.body.film.prediction.predictedRating,r.body.film.actualRating],[4.5,4.5],'an R2 index without the lid key does not hide the D1 forecast');
 // 4. A contested lid exposes none of the foreign data, although D1 holds rows under that lid.
 r=await ask('10750');assert.equal(r.status,200);assert.deepEqual([r.body.film.prediction,r.body.film.actualRating,r.body.film.watched],[null,null,false],'a contested identity shows nothing of the foreign lid');assert.ok(r.body.degraded.includes('identity'));
 assert.ok(statements.length>0&&statements.every(text=>/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)),'only reads reached D1: '+statements.filter(text=>!/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)).join(' | '));assert.deepEqual([puts,fetches],[[],[]],'no write, no provider request');
 // 5. The history of the same Film agrees with the page: the same forecast, the same rating, the same viewing.
 const history=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/enrichment/history?filmId=tmdb_1423191'),{BUCKET:bucket,DB:db},{waitUntil(){}});const h=await history.json();
 assert.equal(history.status,200,JSON.stringify(h));
 assert.deepEqual([h.events.filter(e=>e.type==='prediction').map(e=>e.predictedRating),h.current.rating.value,h.events.filter(e=>e.type==='diary_viewing').map(e=>e.watchedDate)],[[4.5],4.5,['2026-11-10']],'the history shows the same forecast and rating as the page, and the D1 Diary viewing');
 // 6. An unreadable D1 domain is a 503, never a stale R2 answer.
 sql(file,'DROP TABLE prediction_fingerprint;');r=await ask('1423191');assert.deepEqual([r.status,r.body.status,r.body.reason],[503,'unavailable','prediction_domain_unavailable']);
}

// ---- 4. Method and routing guards ----
{
 seed(base);
 for(const method of ['POST','PUT','DELETE','PATCH']){
  const response=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/film/7',{method,headers:{origin:'https://iptv.vladimino.workers.dev','content-type':'application/json'},body:'{}'}),envW,{waitUntil(){}});
  assert.notEqual(response.status,200,method+' is not a read');
 }
 assert.deepEqual(puts,[]);
}
const source=fs.readFileSync('src/worker.js','utf8');
assert.match(source,/\/api\\\/catalog\\\/film\\\/\(\[\^\/\]\+\)\$/,'one prefix route, one id segment');
console.log('Catalog film: one indexed row, every state (found, absent, retired, conflict, unavailable, error, invalid), no window or eligibility rule, honest shows and prediction, optional Letterboxd proof, fail closed on a held, loading or broken authority, and no write or request passed');
