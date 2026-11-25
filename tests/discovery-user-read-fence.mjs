// AIR-493. User catalog and enrichment reads must survive unrelated Discovery generation bumps
// (continuation / status / Workflow). Multi-page decision reads still fail closed. Local sqlite
// D1 stand-in only: no Cloudflare, TMDB, production D1 or R2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {d1Standin} from './d1-standin.mjs';
import {scoped,scopedEpgPriority,scopedDiscoveryAuthority,loadDiscoveryAuthority} from '../scripts/bundle-scope.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {nonFunctional} from './suite-gate.mjs';
import {installViewIndexFixture} from './view-index-fixture.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-user-read-fence-'));
let databases=0;
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const lit=value=>"'"+String(value).replace(/'/g,"''")+"'";
const RUN='11111111-1111-4111-8111-111111111111';
const ORIGIN='https://iptv.vladimino.workers.dev';
const now=Date.now(),hour=3600000;
function migrated(options={}){
 const file=path.join(root,'u-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return {file,db:d1Standin(file,options)};
}
const film=(n,extra={})=>({id:'tmdb_'+n,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,title:'Film '+n,original:'Film '+n,year:2000,runtime:100,genres:[],poster:null,url:null,directors:[],actors:[],shows:[{channelId:'c1',channel:'One',start:now-hour,end:now+hour}],showsProgrammeRunId:RUN,...extra});
function admit(db,item,{state='current'}={}){
 db.sql(`INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, programme_run_id, generation, state, payload_json) VALUES (${lit(item.id)},${lit(item.tmdbId)},'movie',${lit(item.canonicalIdentity)},${lit(RUN)},1,${lit(state)},${lit(JSON.stringify(item))})`);
}
function open(db){
 db.sql(`UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id=${lit(RUN)}, published_programme_run_id=${lit(RUN)} WHERE id=1`);
}

{
 const {db}=migrated({onQuery:async text=>{
  if(/FROM discovery_admission WHERE state='current'/.test(text)){
   try{await Authority.writeContinuation({DB:db},{programmeRunId:RUN,hop:'unrelated'});}catch{/* a paused writer still leaves the extra generation bump below */}
   db.sql(`UPDATE discovery_status SET payload_json=${lit(JSON.stringify({stage:'running'}))} WHERE id=1`);
   db.sql('UPDATE discovery_authority SET generation=generation+1 WHERE id=1');
  }
 }});
 open(db);admit(db,film(10));admit(db,film(11));
 const env={DB:db,BUCKET:{async get(){return null;},async put(){throw new Error('r2 write');}}};
 const before=await Authority.readAuthority(env);
 const catalog=await Authority.routeRead(env,'epg/discovered-films.json');
 const after=await Authority.readAuthority(env);
 assert.equal(catalog.handled,true);
 assert.deepEqual(Object.keys(catalog.value).sort(),['tmdb_10','tmdb_11']);
 assert.ok(after.generation>before.generation,'unrelated writes still move the global generation');
 const filmPage=await Authority.readFilmAdmission(env,'10');
 assert.equal(filmPage.handled,true);
 assert.equal(filmPage.records[0].filmId,'tmdb_10');
}

{
 const {db}=migrated({onQuery:async text=>{
  if(/FROM discovery_decision WHERE observation_key>/.test(text))db.sql('UPDATE discovery_authority SET generation=generation+1 WHERE id=1');
 }});
 open(db);
 const hash=await Authority.decisionHash({status:'needs_verification',attempts:1});
 const payload=JSON.stringify({status:'needs_verification',attempts:1}).replace(/'/g,"''");
 const rows=[];
 for(let i=0;i<1001;i++)rows.push(`('k${String(i).padStart(4,'0')}','${RUN}',1,'needs_verification',1,'${hash}','${payload}')`);
 db.sql('INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, decision_hash, payload_json) VALUES '+rows.join(','));
 await assert.rejects(()=>Authority.routeRead({DB:db},'epg/discovery-resolution.json'),error=>error.code==='discovery_fence');
}

{
 const {db}=migrated({onQuery:async text=>{
  if(/FROM discovery_admission WHERE state='current'/.test(text))db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
 }});
 open(db);admit(db,film(10));
 await assert.rejects(()=>Authority.routeRead({DB:db},'epg/discovered-films.json'),error=>error.code==='discovery_fence');
}
{
 const {db}=migrated({onQuery:async text=>{
  if(/FROM discovery_admission WHERE state='current'/.test(text))db.sql("UPDATE discovery_authority SET programme_run_id='22222222-2222-4222-8222-222222222222' WHERE id=1");
 }});
 open(db);admit(db,film(10));
 await assert.rejects(()=>Authority.routeRead({DB:db},'epg/discovered-films.json'),error=>error.code==='discovery_fence');
}
{
 const {db}=migrated();open(db);admit(db,film(10));
 db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");
 await assert.rejects(()=>Authority.routeRead({DB:db},'epg/discovered-films.json'),error=>error.code==='discovery_unavailable','a held cutover is refused by routeRead (ADR 0162)');
 await assert.rejects(()=>Authority.readFilmAdmission({DB:db},'10'),error=>error.code==='discovery_unavailable');
}

function catalogReplaceAba(db){
 db.sql("UPDATE discovery_transfer SET state='loading', batches=batches+1 WHERE id=1");
 db.sql("UPDATE discovery_admission SET state='pending' WHERE state='current'");
 db.sql("UPDATE discovery_transfer SET state='committed', batches=batches+1 WHERE id=1");
}
function isCatalogAdmissionRead(text){
 return /FROM discovery_admission WHERE state='current' ORDER BY film_id/.test(text)
  || /FROM discovery_admission WHERE media_kind='movie' AND tmdb_id=/.test(text);
}

{
 const {db}=migrated({onQuery:async text=>{if(isCatalogAdmissionRead(text))catalogReplaceAba(db);}});
 open(db);admit(db,film(10));admit(db,film(11));
 await assert.rejects(()=>Authority.routeRead({DB:db},'epg/discovered-films.json'),error=>error.code==='discovery_fence');
 await assert.rejects(()=>Authority.readFilmAdmission({DB:db},'10'),error=>error.code==='discovery_fence');
}

const records=new Map();
const bucket={
 async get(key){return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key))}:null;},
 async put(){throw new Error('r2 write');},
 async delete(){throw new Error('r2 delete');},
 async list(){return {objects:[],truncated:false};}
};
const world=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 fetch:async()=>{throw new Error('unexpected outbound request');}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),world);
vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8'),world);
vm.runInContext(scopedEpgPriority(),world);loadDiscoveryAuthority(script=>vm.runInContext(script,world));
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),world);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),world);
installViewIndexFixture(world);
const worker=world.worker,constant=name=>vm.runInContext(name,world);
const current={prediction:{predictedRating:4.5,probability4Plus:.9,confidence:'high',matchSignals:[],mainRisk:null,tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1},fingerprintHash:'f',impactFeatures:{fingerprintHash:'f',fingerprintSchemaVersion:1,fingerprintPromptVersion:1},fingerprint:{fingerprintHash:'f',plotMechanics:[],execution:{}}};
function seedBucket(){
 records.clear();
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:RUN});
 for(const key of ['programme.json','epg/generations/'+RUN+'/programme.json'])records.set(key,{runId:RUN,updatedAt:new Date(now).toISOString(),watchlistCount:0,films:[],stats:{}});
 records.set('watchlist.json',{films:[]});
 records.set(constant('profileKey'),{version:1,profileHash:'p1'});
 records.set(constant('ENRICHMENT_KEY')+'view-index.json',{tmdb_10:current,tmdb_11:current});
 records.set('epg/generations/'+RUN+'/discovered-films.json',{tmdb_99:film(99)});
}
async function get(path,env){
 const response=await worker.fetch(new Request(ORIGIN+path),env,{waitUntil(){}});
 return {status:response.status,headers:response.headers,body:await response.json()};
}

{
 seedBucket();
 const {db}=migrated({onQuery:async text=>{
  if(/FROM discovery_admission WHERE state='current'/.test(text)){
   try{await Authority.writeContinuation({DB:db},{programmeRunId:RUN,step:'chunk'});}catch{/* generation bump below is the Workflow analogue */}
   db.sql('UPDATE discovery_authority SET generation=generation+1 WHERE id=1');
  }
 }});
 open(db);admit(db,film(10));admit(db,film(11));
 const env={DB:db,BUCKET:bucket};
 const available=await get('/api/catalog/available',env);
 assert.equal(available.status,200,JSON.stringify(available.body));
 assert.ok(Array.isArray(available.body.films));
 assert.ok(!available.body.films.some(item=>item.id==='tmdb_99'),'no R2 catalog fallback');
 const view=await get('/api/enrichment/view',env);
 assert.equal(view.status,200,JSON.stringify(view.body).slice(0,200));
 assert.equal(typeof view.body.films,'object');
 assert.ok(view.body.films.tmdb_10);
}

{
 seedBucket();
 const {db}=migrated({onQuery:async text=>{
  if(/FROM discovery_admission WHERE state='current'/.test(text))db.sql("UPDATE discovery_authority SET programme_run_id='22222222-2222-4222-8222-222222222222' WHERE id=1");
 }});
 open(db);admit(db,film(10));
 const refused=await get('/api/catalog/available',{DB:db,BUCKET:bucket});
 assert.equal(refused.status,503);
 assert.equal(refused.body.code,'discovery_fence');
 assert.equal(refused.headers.get('Retry-After'),'1');
 assert.equal(refused.body.films,undefined,'never a 200 empty list');
}

{
 seedBucket();
 const {db}=migrated();open(db);admit(db,film(10));admit(db,film(12),{state:'pending'});
 db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
 const loading=await get('/api/catalog/available',{DB:db,BUCKET:bucket});
 assert.equal(loading.status,503,JSON.stringify(loading.body));
 assert.equal(loading.body.code,'discovery_incomplete');
}

{
 seedBucket();
 const {db}=migrated({onQuery:async text=>{if(isCatalogAdmissionRead(text))catalogReplaceAba(db);}});
 open(db);admit(db,film(10));admit(db,film(11));
 const aba=await get('/api/catalog/available',{DB:db,BUCKET:bucket});
 assert.equal(aba.status,503,JSON.stringify(aba.body));
 assert.equal(aba.body.code,'discovery_fence');
 assert.equal(aba.body.films,undefined,'ABA empty catalog is never HTTP 200');
 assert.ok(!aba.body.films,'no R2 fallback after a catalog replace ABA');
 const abaView=await get('/api/enrichment/view',{DB:db,BUCKET:bucket});
 assert.equal(abaView.status,503,JSON.stringify(abaView.body).slice(0,200));
 assert.equal(abaView.body.code,'discovery_fence');
}

{
 seedBucket();
 const {db}=migrated();open(db);admit(db,film(10));
 db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");
 const heldCatalog=await get('/api/catalog/available',{DB:db,BUCKET:bucket});
 assert.equal(heldCatalog.status,503,JSON.stringify(heldCatalog.body));
 assert.equal(heldCatalog.body.code,'discovery_unavailable');
 assert.ok(!heldCatalog.body.films,'held catalog GET does not serve the R2 mirror');
 const heldView=await get('/api/enrichment/view',{DB:db,BUCKET:bucket});
 assert.equal(heldView.status,503,JSON.stringify(heldView.body).slice(0,200));
 assert.equal(heldView.body.code,'discovery_unavailable');
 assert.equal(heldView.body.films,undefined,'held enrichment view does not serve the R2 catalog');
}

{
 const started=Date.now();
 seedBucket();
 const {db}=migrated({onQuery:async text=>{
  if(/FROM discovery_admission WHERE state='current'/.test(text)){
   await new Promise(resolve=>setTimeout(resolve,80));
   try{await Authority.writeContinuation({DB:db},{programmeRunId:RUN,slow:true});}catch{db.sql('UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}
  }
 }});
 open(db);admit(db,film(10));
 const slow=await get('/api/catalog/available',{DB:db,BUCKET:bucket});
 assert.equal(slow.status,200,JSON.stringify(slow.body));
 nonFunctional('discovery-user-read-fence-slow-catalog',()=>{assert.ok(Date.now()-started>=80,'the catalog SELECT was delayed');});
}

console.log('AIR-493 user catalog/enrichment reads: unrelated generation bumps stay 200; paged decisions, loading, held and EPG pin changes fail closed; HTTP 503 not 502');
