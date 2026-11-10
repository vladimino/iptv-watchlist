// AIR-387: the permanent catalog film lookup `GET /api/catalog/film/<tmdbId>`. One verified TMDB movie of the catalog, whatever its shows,
// prediction or the watchlist say. Read-only: no R2/D1 write, no outbound request. Local stand-ins only, nothing calls Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {d1Standin} from './d1-standin.mjs';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as PublishedEpgModule from '../src/published-epg.js';

// ---- 1. readFilmAdmission against a real schema (sqlite stand-in) ----
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-catalog-film-'));
let databases=0;const seen=[];
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=11).sort();
const migrated=()=>{
 const file=path.join(root,'film-'+(databases++)+'.sqlite');
 const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
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
 // Discovery still on R2: the lookup is not authoritative here and says so.
 assert.deepEqual(await Authority.readFilmAdmission(env(db),'7'),{handled:false});
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
 // Fail closed: a held cutover, a catalog load in progress.
 db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");
 await assert.rejects(()=>Authority.readFilmAdmission(env(db),'7'),error=>error.code==='discovery_fence');
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
const bucket={
 async get(key){return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value){records.set(key,JSON.parse(value));puts.push(key);return {etag:'e'};},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key,customMetadata:{}})),truncated:false};}
};
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),ctx);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/migration-export.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const worker=ctx.worker,constant=name=>vm.runInContext(name,ctx);
const envW={BUCKET:bucket};
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
 assert.equal(film.availableNow,true);assert.equal(film.nextStart,film.shows[1].start);
 assert.equal(film.prediction.predictedRating,4.5);assert.deepEqual(film.fingerprint.plotMechanics,['investigation']);
 // The permanent page does not need a current window, a prediction floor or an empty watchlist.
 r=await get('10');assert.equal(r.status,200);assert.equal(r.body.film.shows.length,1,'an old show is still this film\'s show for the current generation');assert.equal(r.body.film.prediction,null,'no stored prediction: none invented');
 r=await get('9');assert.equal(r.status,200);assert.deepEqual(r.body.film.shows,[]);assert.equal(r.body.film.availableUntil,null);assert.equal(r.body.film.nextStart,null);assert.equal(r.body.film.availableNow,false,'zero shows is a valid film page');
 r=await get('8');assert.equal(r.status,200);assert.equal(r.body.film.prediction,null,'a stale prediction is not shown');assert.equal(r.body.film.fingerprint,null);
 r=await get('12');assert.equal(r.status,200);assert.deepEqual(r.body.film.shows,[],'shows of an earlier generation are not availability now');
 // States.
 r=await get('999');assert.deepEqual([r.status,r.body.status],[404,'absent']);
 r=await get('11');assert.deepEqual([r.status,r.body.status],[409,'conflict'],'a record that does not verify its identity fails closed');
 r=await get('13');assert.equal(r.status,409,'two current records of one identity are not guessed between');
 for(const bad of ['0','abc','-1','7.5','007','1234567890123','%E0%A4%A']){r=await get(bad);assert.deepEqual([r.status,r.body.status],[400,'invalid'],'invalid: '+bad);}
 // The film is still found when the watchlist, a rating or the profile say nothing about it.
 const index=records.get(constant('ENRICHMENT_KEY')+'view-index.json');index.tmdb_7.actualRating=5;index.tmdb_7.watchlist=true;records.set(constant('ENRICHMENT_KEY')+'view-index.json',index);
 r=await get('7');assert.equal(r.status,200,'a rated or watchlisted film still has its page');assert.equal(Object.hasOwn(r.body.film,'actualRating'),false,'no rating is exposed');
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
  vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),world);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),world);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),world);
  vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),world);
  for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/migration-export.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),world);
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
 const fake=({version=16,marker={mode:'r2',cutover:'open',generation:0},external=[],redirects=[],broken=null,tables=true}={})=>({
  prepare(sql){
   const run=kind=>{
    if(broken&&broken.test(sql))throw new Error('d1 down');
    if(/FROM schema_contract/.test(sql))return kind==='first'?{version}:{results:[]};
    if(/sqlite_master/.test(sql))return {results:tables?['film_person_authority','film_person_cas','film_person_baseline','canonical_revision'].map(name=>({name})):[]};
    if(/FROM film_person_authority/.test(sql))return marker;
    if(/FROM film_person_cas/.test(sql))return {ok:1};
    if(/FROM film_person_baseline/.test(sql))return {state:'verified',reference:null};
    if(/FROM film_external_id/.test(sql))return {results:external};
    if(/FROM film_redirect/.test(sql))return redirects.length?{hit:1}:null;
    return kind==='first'?null:{results:[]};
   };
   return {bind:()=>({first:async()=>run('first'),all:async()=>{const out=run('all');return out&&out.results?out:{results:[]};}}),first:async()=>run('first'),all:async()=>{const out=run('all');return out&&out.results?out:{results:[]};}};
  }
 });
 const ask=async(db,id='300')=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/film/'+id),{BUCKET:bucket,DB:db},{waitUntil(){}});return {status:r.status,body:await r.json()};};
 seed(base);records.set(ADM,receipt(300));
 // Allowed R2 states: legacy (a contract below 13), r2 and prepared. An admitted Film whose projection is still pending is found.
 let r=await ask(fake({version:12}));assert.equal(r.status,200,'legacy');
 r=await ask(fake());assert.equal(r.status,200,'r2: the receipt is the R2 identity decision, a pending projection is still a Film');assert.equal(r.body.film.id,'tmdb_300');
 r=await ask(fake({marker:{mode:'prepared',cutover:'open',generation:1}}));assert.equal(r.status,200,'prepared');
 // The authority names D1 or is unreadable: never R2.
 r=await ask(fake({marker:{mode:'d1',cutover:'held',generation:2}}));assert.deepEqual([r.status,r.body.status,r.body.reason],[503,'unavailable','film_person_held'],'held fails closed');
 r=await ask(fake({marker:{mode:'d1',cutover:'open',generation:2}}));assert.deepEqual([r.status,r.body.status,r.body.reason],[503,'unavailable','film_person_not_open_read'],'open is D1 authority: the R2 receipt is not used');
 r=await ask(fake({marker:null}));assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'a missing marker row');
 r=await ask(fake({marker:{mode:'bogus',cutover:'open',generation:0}}));assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'a malformed marker');
 r=await ask(fake({tables:false}));assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'a missing companion table');
 r=await ask(fake({broken:/film_person_authority/}));assert.deepEqual([r.status,r.body.reason],[503,'film_person_unavailable'],'a failed marker read');
 // Discovery found answers without the Film authority being read.
 r=await ask(fake({marker:{mode:'d1',cutover:'held',generation:2}}),'7');assert.equal(r.status,200,'a Discovery Film is not gated here');
 // Canonical guards. The owner's R2 retirement, a D1 contradiction, a redirected Film.
 records.set(RET,{schemaVersion:1,retirements:[]});r=await ask(fake());assert.equal(r.status,200,'an empty retirements object retires nobody');
 records.set(RET,{schemaVersion:99,nonsense:true});r=await ask(fake());assert.deepEqual([r.status,r.body.reason],[503,'discovery_unavailable'],'an unreadable retirements object fails closed');
 const retire=movie=>({schemaVersion:1,retirements:[{filmId:'film:abc',lid:'abc',movieId:movie,tvId:555,evidence:{movieStatus:404,movieCheckedAt:'2026-11-01T00:00:00Z',letterboxdUrl:'https://letterboxd.com/film/abc/',link:'tv/555',linkCheckedAt:'2026-11-01T00:00:00Z',tvResponseId:555,tvCheckedAt:'2026-11-01T00:00:00Z'},confirmation:{by:'owner',at:'2026-11-01T00:00:00Z',source:'test'}}]});
 records.set(RET,retire(300));r=await ask(fake());assert.deepEqual([r.status,r.body.status],[410,'retired'],'the owner retired this TMDB movie id: a receipt does not resurrect it');
 records.set(RET,retire(301));r=await ask(fake());assert.equal(r.status,200,'another id retired: this Film is unaffected');
 records.delete(RET);
 r=await ask(fake({external:[{film_id:'film:a',trusted:1,conflicting:0},{film_id:'film:b',trusted:1,conflicting:0}]}));assert.equal(r.status,409,'two Films trust one TMDB id');
 r=await ask(fake({external:[{film_id:'film:a',trusted:0,conflicting:1}]}));assert.equal(r.status,409,'a conflicting external id');
 r=await ask(fake({external:[{film_id:'film:a',trusted:0,conflicting:0}]}));assert.equal(r.status,409,'only an untrusted, non-conflicting claim holds the identity');
 r=await ask(fake({external:[{film_id:'film:a',trusted:1,conflicting:0},{film_id:'film:b',trusted:0,conflicting:0}]}));assert.equal(r.status,409,'a trusted owner beside an untrusted claim of another Film');
 r=await ask(fake({external:[{film_id:'film:a',trusted:1,conflicting:0},{film_id:'film:a',trusted:0,conflicting:0}]}));assert.equal(r.status,409,'any claim that is not the owner\'s own trusted row, even on the same Film');
 r=await ask(fake({external:[{film_id:'film:a',trusted:1,conflicting:0},{film_id:'film:x',trusted:0,conflicting:0},{film_id:'film:y',trusted:0,conflicting:0},{film_id:'film:z',trusted:0,conflicting:0},{film_id:'film:v',trusted:0,conflicting:0},{film_id:'film:w',trusted:0,conflicting:1}]}));assert.equal(r.status,409,'six claims: none is masked by a row limit');
 r=await ask(fake({external:[{film_id:'film:a',trusted:1,conflicting:0}],redirects:['film:a']}));assert.equal(r.status,410,'the Film was merged into another');
 r=await ask(fake({external:[{film_id:'film:a',trusted:1,conflicting:0}]}));assert.equal(r.status,200,'one trusted, unredirected Film agrees with the receipt');
 r=await ask(fake({broken:/film_external_id/}));assert.deepEqual([r.status,r.body.reason],[503,'discovery_unavailable'],'a failed canonical guard is unavailable, never found');
 r=await ask(fake({broken:/film_redirect/,external:[{film_id:'film:a',trusted:1,conflicting:0}]}));assert.equal(r.status,503);
 assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
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
