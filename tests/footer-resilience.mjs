// AIR-389 production incident: GET /api/enrichment/footer/status answered 502 `{"error":"discovery_incomplete"}` (32 bytes) while the Discovery transfer was
// `loading`, and the same GET ran PublishedEpg.repairMirrors (an R2 write, twice in parallel) when a D1 generation was published. The footer must stay readable
// when a source is closed, failing or silent, must never write, and must show unknown values as null. A real D1-published generation (migrations applied, sqlite
// D1 stand-in) is used; nothing here calls Cloudflare, TMDB or production.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {scoped,scopedEpgPriority,scopedDiscoveryAuthority} from '../scripts/bundle-scope.mjs';
import * as PublishedEpgModule from '../src/published-epg.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-footer-resilience-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>name.slice(0,-4)).sort();
const G='22222222-2222-4222-8222-222222222222',now=Date.now(),hour=3600000;
let databases=0;
const mkdb=()=>{
 const seen=[];const db=d1Standin(path.join(root,'f'+(databases++)+'.sqlite'),{onQuery:async text=>{seen.push(text);}});
 for(const migration of names)db.sql(fs.readFileSync('migrations/'+migration+'.sql','utf8'));
 db.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
 db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 return {db,seen};
};
async function published(db){
 const mem=new Map(),bucket={async get(k){return mem.has(k)?{etag:'e',json:async()=>structuredClone(mem.get(k))}:null;},async put(k,v){mem.set(k,JSON.parse(v));return {etag:'e'};},async list(){return {objects:[],truncated:false};}};
 const film={id:'lid-w',tmdbId:'42',title:'Watch',original:'Watch',year:2020,genres:[],actors:[],directors:[],shows:[]};
 const r=await PublishedEpgModule.publishGeneration({DB:db,BUCKET:bucket},{programmeRunId:G,phase:'published',expectedProgrammeRunId:null,programme:{runId:G,updatedAt:new Date(now).toISOString(),watchlistCount:1,films:[film]},watchlist:{updatedAt:new Date(now).toISOString(),films:[film]}},{now});
 assert.equal(r.pointed,true,'a real D1-published generation');
}
const logs=[];
function worldFor({d1=true}={}){
 const world=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
  console:{error:(...args)=>logs.push(args.join(' ')),log(){},warn(){}},fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),world);
 if(d1){vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),world);vm.runInContext(scopedEpgPriority(),world);vm.runInContext(scopedDiscoveryAuthority(),world);}
 for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),world);
 return world;
}
const fetches=[];
const profile={version:7,updatedAt:'2026-10-12T18:00:00Z',profileHash:'p',profile:{}};
// A bucket whose compatibility mirrors are missing (or stale) and that fails the test on any write. `faulty` keys throw, `silent` keys never answer.
function bucketFor({mirrors='missing',faulty=[],silent=[]}={}){
 const mem=new Map([['enrichment/profile/current.json',profile],['enrichment/view-index.json',{}],['metadata.json',{}]]);
 if(mirrors==='stale'){mem.set('epg/published-generation.json',{phase:'published',programmeRunId:'11111111-1111-4111-8111-aaaaaaaaaaaa'});mem.set('programme.json',{runId:'old',films:[]});}
 const writes=[];
 return {writes,bucket:{
  async get(key){if(faulty.includes(key))throw new Error('r2 fault '+key);if(silent.includes(key))return new Promise(()=>{});return mem.has(key)?{etag:'e',json:async()=>structuredClone(mem.get(key))}:null;},
  async put(key){writes.push('put:'+key);throw new Error('R2 write in a GET: '+key);},async delete(key){writes.push('delete:'+key);throw new Error('R2 delete in a GET: '+key);},
  async list(){return {objects:[],truncated:false};},async head(key){return mem.has(key)?{etag:'e'}:null;}}};
}
const footer=async(world,env)=>{const response=await world.worker.fetch(new Request('https://iptv.example/api/enrichment/footer/status'),env,{waitUntil(){}});const text=await response.text();return {status:response.status,length:text.length,body:JSON.parse(text)};};
const LEGACY=['schemaVersion','generatedAt','profile','coverage','predictions','epgTmdb','watchlist','lastRun','integrations'];

const {db,seen}=mkdb();
await published(db);
const world=worldFor();

// ---- 1. The normal state: no write of any kind, from either source of mirrors ----
for(const mirrors of ['missing','stale']){
 const {bucket,writes}=bucketFor({mirrors});
 const before={batches:db.calls.batches,statements:db.calls.statements};seen.length=0;fetches.length=0;
 const r=await footer(world,{DB:db,BUCKET:bucket});
 assert.equal(r.status,200,mirrors+' mirrors: '+JSON.stringify(r.body));
 for(const key of LEGACY)assert.ok(Object.hasOwn(r.body,key),'legacy field kept: '+key);
 assert.deepEqual(writes,[],mirrors+' mirrors: no R2 put or delete in a GET (no repairMirrors, not twice in parallel)');
 assert.equal(db.calls.batches,before.batches,'no D1 batch');assert.equal(db.calls.statements,before.statements,'no D1 statement written');
 assert.ok(seen.length>0&&seen.every(text=>/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)),'only reads reached D1: '+seen.filter(text=>!/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)).join(' | '));
 assert.deepEqual(fetches,[],'no provider request');
 assert.equal(Object.hasOwn(r.body,'degraded'),false,'a healthy footer names no degraded source');
 assert.equal(r.body.watchlist.films,1,'the programme and the watchlist are read from the D1 generation');
}

// ---- 2. The incident: the Discovery transfer is loading (a ledger seal, then with a pending admission) ----
const admission=(state)=>db.sql(`INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, generation, state, payload_json) VALUES ('tmdb_9','9','movie','tmdb:9',1,'${state}','{"id":"tmdb_9","tmdbId":"9","canonicalIdentity":"tmdb:9"}')`);
for(const variant of ['ledger seal','pending admission','held cutover']){ // the first two are the incident
 if(variant==='ledger seal')db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
 if(variant==='pending admission')admission('pending');
 if(variant==='held cutover'){db.sql("DELETE FROM discovery_admission");db.sql("UPDATE discovery_transfer SET state='idle' WHERE id=1");db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");}
 const {bucket,writes}=bucketFor();
 const r=await footer(world,{DB:db,BUCKET:bucket});
 assert.equal(r.status,200,variant+': the footer stays readable instead of the generic 502 '+JSON.stringify(r.body).slice(0,120));
 assert.notEqual(r.length,32,variant+': not the 32-byte {"error":"discovery_incomplete"} of the incident');
 if(variant==='held cutover'){for(const key of LEGACY)assert.ok(Object.hasOwn(r.body,key),variant+': legacy field kept: '+key);assert.deepEqual(writes,[],variant+': no write');continue;} // routeRead serves the compatibility copy while a cutover is held, as before
 assert.ok(Array.isArray(r.body.degraded)&&r.body.degraded.includes('ledger'),variant+': the closed ledger is named: '+JSON.stringify(r.body.degraded));
 for(const key of LEGACY)assert.ok(Object.hasOwn(r.body,key),variant+': legacy field kept: '+key);
 // What needs the closed sources is unknown (null), never 0 or 100%.
 assert.deepEqual([r.body.epgTmdb.recognizedFilms,r.body.epgTmdb.pendingRecognition,r.body.epgTmdb.historicalUnresolved,r.body.epgTmdb.ledgerTotal],[null,null,null,null],variant+': ledger counts are unknown');
 if(r.body.degraded.includes('catalog')){
  assert.deepEqual(Object.values(r.body.coverage),Array(Object.keys(r.body.coverage).length).fill(null),variant+': coverage is unknown without the catalog');
  assert.equal(r.body.collection.state,'unknown',variant+': the collection is unknown without the catalog');assert.equal(r.body.recommendations.newUnseen.state,'unknown');
 }
 assert.deepEqual(writes,[],variant+': still no write');
 assert.equal(r.body.integrations.sources.find(source=>source.id==='resolver')?.state,'unknown',variant+': the resolver is unknown, not healthy and not an error');
}
db.sql("UPDATE discovery_authority SET cutover='open' WHERE id=1");

// ---- 3. A failing or silent optional source never takes the footer down ----
for(const key of ['enrichment/profile/current.json','enrichment/view-index.json','metadata.json','sync.json','enrichment/latest-run.json','enrichment/prediction-queue.json','watchlist-ingest.json']){
 const {bucket,writes}=bucketFor({faulty:[key]});
 const r=await footer(world,{DB:db,BUCKET:bucket});
 assert.equal(r.status,200,'a failing '+key+' does not fail the footer');
 assert.ok(Array.isArray(r.body.degraded)&&r.body.degraded.length>0,key+' is named as degraded: '+JSON.stringify(r.body.degraded));
 for(const field of LEGACY)assert.ok(Object.hasOwn(r.body,field),key+': legacy field kept: '+field);
 assert.deepEqual(writes,[]);
 // The coverage needs the taste profile and the view index: when either read fails the numbers are unknown, not 0 of N.
 if(key==='enrichment/profile/current.json'||key==='enrichment/view-index.json')for(const field of ['confirmedFilmsTotal','currentPredictionsTotal','windowFilmsTotal','windowCurrentPredictions','localPercent','windowPercent'])assert.equal(r.body.coverage[field],null,key+': coverage.'+field+' is unknown after a failed read');
}
// The metadata cache is what links identities: without it the new blocks are unknown, never "ok".
{const {bucket}=bucketFor({faulty:['metadata.json']});const r=await footer(world,{DB:db,BUCKET:bucket});assert.equal(r.body.collection.state,'unknown');assert.equal(r.body.recommendations.newUnseen.state,'unknown');}
// A source that never answers is cut off at the limit, and the footer answers.
{
 const {bucket}=bucketFor({silent:['sync.json','enrichment/latest-run.json']});
 const started=Date.now(),r=await footer(world,{DB:db,BUCKET:bucket,FOOTER_SOURCE_TIMEOUT_MS:60});const took=Date.now()-started;
 assert.equal(r.status,200,'a silent source does not hang the footer');assert.ok(took<3000,'bounded wait: '+took+' ms');
 assert.ok(r.body.degraded.includes('sync')&&r.body.degraded.includes('run'),'the silent sources are named: '+JSON.stringify(r.body.degraded));
}

// ---- 4. R2 mode (Discovery and the published EPG still on R2): fail-closed gaps the first review found ----
const r2=worldFor({d1:false});
const pred=(id,rating)=>({fingerprintHash:'fp-'+id,impactFeatures:{fingerprintHash:'fp-'+id,fingerprintSchemaVersion:1,fingerprintPromptVersion:1},prediction:{predictedRating:rating,probability4Plus:.9,confidence:'high',tasteProfileVersion:7,tasteProfileHash:'profile-7',fingerprintHash:'fp-'+id,fingerprintSchemaVersion:1,predictionPromptVersion:1}});
const verified=(id,tmdb)=>({id,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:id,original:id,year:2020,genres:[],actors:[],directors:[],shows:[]});
const r2Files=(over={})=>{
 const files=new Map([
  ['enrichment/profile/current.json',{version:7,updatedAt:'2026-10-12T18:00:00Z',profileHash:'profile-7',profile:{}}],
  ['enrichment/view-index.json',{tmdb_77:pred('77',4.8)}],
  ['programme.json',{runId:'p1',updatedAt:new Date(now).toISOString(),watchlistCount:0,films:[],stats:{}}],
  ['epg/discovered-films.json',{tmdb_77:verified('tmdb_77',77)}],
  ['watchlist.json',{updatedAt:new Date(now).toISOString(),films:[]}],['metadata.json',{}]]);
 for(const [key,value] of Object.entries(over)){if(value===undefined)files.delete(key);else files.set(key,value);}
 return {BUCKET:{async get(key){return files.has(key)?{etag:'e',json:async()=>structuredClone(files.get(key))}:null;},async put(){throw new Error('R2 write in a GET');},async list(){return {objects:[],truncated:false};}}};
};
const NULL_COVERAGE=['confirmedFilmsTotal','currentPredictionsTotal','windowFilmsTotal','windowCurrentPredictions','cacheOffWindowTotal','pendingOffWindowTotal','localPercent','windowPercent','windowPendingTotal'];
{
 // The control: with every source present the numbers are real.
 let r=await footer(r2,r2Files());
 assert.equal(r.status,200);assert.deepEqual([r.body.coverage.confirmedFilmsTotal,r.body.coverage.currentPredictionsTotal],[1,1]);
 assert.deepEqual(r.body.recommendations.newUnseen,{state:'ok',rating40to44:0,rating45plus:1},'a valid 4.5+ catalog prediction is counted');
 assert.equal(Object.hasOwn(r.body,'degraded'),false);
 // B2: a catalog or a programme that is simply absent is not an empty collection with 0 films and 100% coverage.
 for(const [label,over,name] of [['catalog absent',{'epg/discovered-films.json':undefined},'catalog_missing'],['programme absent',{'programme.json':undefined},'programme_missing']]){
  r=await footer(r2,r2Files(over));
  assert.equal(r.status,200,label);
  assert.ok(r.body.degraded.includes(name),label+': named in degraded: '+JSON.stringify(r.body.degraded));
  for(const key of NULL_COVERAGE)assert.equal(r.body.coverage[key],null,label+': coverage.'+key+' is unknown, not 0 or 100');
  assert.equal(r.body.collection.state,'unknown',label+': the collection is unknown');
  assert.equal(r.body.recommendations.newUnseen.state,'unknown',label+': the new-film count is unknown');
 }
 // B3: the programme takes part in the watchlist exclusion, so without it the new-film count is unknown, never a count that silently includes a watchlisted film.
 {
  const watchlisted={id:'lid-77',tmdbId:'77',title:'Watchlisted',original:'Watchlisted',year:2020,genres:[],actors:[],directors:[],shows:[],catalogOnly:false};
  const withProgramme=r2Files({'programme.json':{runId:'p1',updatedAt:new Date(now).toISOString(),watchlistCount:1,films:[watchlisted],stats:{}}});
  r=await footer(r2,withProgramme);
  assert.deepEqual(r.body.recommendations.newUnseen,{state:'ok',rating40to44:0,rating45plus:0},'with the programme, the watchlisted film (linked by the stored id) is not new');
  r=await footer(r2,r2Files({'programme.json':undefined}));
  assert.deepEqual(r.body.recommendations.newUnseen,{state:'unknown',rating40to44:null,rating45plus:null},'without the programme the same film is NOT counted as new: unknown');
  assert.ok(r.body.degraded.includes('programme_missing'));
 }
 // An absent view index or taste profile is not a measured "0 current predictions" either.
 for(const [label,over,name] of [['view index absent',{'enrichment/view-index.json':undefined},'index_missing'],['taste profile absent',{'enrichment/profile/current.json':undefined},'profile_missing']]){
  r=await footer(r2,r2Files(over));
  assert.equal(r.status,200,label);
  assert.ok(r.body.degraded.includes(name),label+': named in degraded: '+JSON.stringify(r.body.degraded));
  for(const key of NULL_COVERAGE)assert.equal(r.body.coverage[key],null,label+': coverage.'+key+' is unknown, not 0 of N');
  // The collection counts facts, not predictions: it needs the view index but not the taste profile.
  assert.equal(r.body.collection.state,name==='index_missing'?'unknown':'ok',label+': the collection follows the view index');
  assert.equal(r.body.recommendations.newUnseen.state,'unknown',label+': the new-film count is unknown');
 }
 // B1: a freshness rule that cannot be computed makes the new-film count unknown, never "no eligible film".
 const original=vm.runInContext('predictionFreshness',r2);
 try{
  vm.runInContext('predictionFreshness=async()=>{throw new Error("boom")}',r2);
  r=await footer(r2,r2Files());
  assert.equal(r.status,200);assert.ok(r.body.degraded.includes('freshness'),'freshness is named: '+JSON.stringify(r.body.degraded));
  assert.deepEqual(r.body.recommendations.newUnseen,{state:'unknown',rating40to44:null,rating45plus:null},'a failing freshness is unknown, not an authoritative 0');
  for(const key of NULL_COVERAGE)assert.equal(r.body.coverage[key],null,'coverage.'+key+' is unknown without freshness');
  vm.runInContext('predictionFreshness=()=>new Promise(()=>{})',r2);
  const started=Date.now();r=await footer(r2,{...r2Files(),FOOTER_SOURCE_TIMEOUT_MS:60});
  assert.ok(Date.now()-started<3000,'a hung freshness is cut off');assert.equal(r.status,200);
  assert.equal(r.body.recommendations.newUnseen.state,'unknown','a hung freshness is unknown too');assert.ok(r.body.degraded.includes('freshness'));
 }finally{vm.runInContext('predictionFreshness=__original',Object.assign(r2,{__original:original}));}
 r=await footer(r2,r2Files());assert.equal(r.body.recommendations.newUnseen.rating45plus,1,'the real freshness rule is restored');
}

// ---- 5. The log line carries only values shaped like an internal code ----
{
 const failWith=async(error,world=r2)=>{
  logs.length=0;
  const files=r2Files();
  const env={BUCKET:{...files.BUCKET,async get(key){if(key==='watchlist.json')throw error;return files.BUCKET.get(key);}}};
  const response=await world.worker.fetch(new Request('https://iptv.example/api/watchlist',{headers:{cookie:'secret=1',authorization:'Bearer secret-token'}}),env,{waitUntil(){}});
  return {status:response.status,logs:[...logs],line:logs.length?JSON.parse(logs[0]):null,raw:logs.join('\n')};
 };
 // An internal code passes, and so does the name of the error class.
 let r=await failWith(Object.assign(new Error('discovery_incomplete'),{code:'discovery_fence'}));
 assert.equal(r.status,502);assert.equal(r.logs.length,1,'one structured line');
 assert.deepEqual(Object.keys(r.line).sort(),['code','event','message','method','name','path']);
 assert.deepEqual([r.line.event,r.line.method,r.line.path,r.line.code,r.line.message,r.line.name],['route_error','GET','/api/watchlist','discovery_fence','discovery_incomplete','Error']);
 // Everything else is dropped: a film id, SQL, a path, a secret, a library message, a non-Error value, a code that is not code-shaped.
 const private_=['film:tmdb_1234567 failed','SELECT payload_json FROM discovery_admission WHERE film_id=\'x\'','epg/generations/22222222-2222-4222-8222-222222222222/programme.json is missing','Bearer abc.def.ghi rejected','D1_ERROR: no such table: film_person','Letterboxd lid heat-1995 not found','R2 write in a GET: programme.json','Discovery_Incomplete','x'.repeat(200)];
 for(const text of private_){
  r=await failWith(new Error(text));
  assert.equal(r.status,502,text.slice(0,30));assert.equal(r.logs.length,1);
  assert.equal(r.line.message,null,'a free-text message is not logged: '+text.slice(0,40));
  assert.equal(r.line.code,null);
  for(const fragment of ['tmdb_1234567','SELECT','discovery_admission','22222222','Bearer','heat-1995','no such table','programme.json','secret','cookie','authorization'])assert.ok(!r.raw.includes(fragment),'the log never carries: '+fragment);
 }
 r=await failWith(Object.assign(new Error('boom'),{code:'FILM tmdb_9 / secret'}));assert.equal(r.line.code,null,'a code that is not code-shaped is dropped');assert.ok(!r.raw.includes('secret'));
 r=await failWith(new TypeError('x is not a function'));assert.equal(r.line.name,'TypeError','the error class is kept');assert.equal(r.line.message,null);
 r=await failWith('a thrown string with a film id tmdb_5');assert.equal(r.status,502);assert.deepEqual([r.line.code,r.line.message,r.line.name],[null,null,null]);assert.ok(!r.raw.includes('tmdb_5'));
}
console.log('Footer resilience: a real D1-published generation never writes on a footer GET (missing or stale mirrors), a loading, pending or held Discovery transfer no longer turns the footer into a 502 and leaves ledger-dependent values unknown, failing and silent sources are named and bounded, and freshness or a missing programme/catalog make the new-film count and the coverage unknown, and the route-error log line carries only code-shaped values passed');
