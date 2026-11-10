// POST /api/catalog/watched checks the film against the published generation's catalog with the same pinned, authority-aware read as
// GET /api/catalog/available (`catalogGenerationCopy`). With Discovery on D1 the generation catalog lives in D1 and there is no R2 copy,
// so a direct R2 read refused every real film with film_not_in_catalog. Local sqlite D1 stand-in and in-memory bucket; nothing is
// production, no provider is called. Fails closed: no R2 fallback and no owner-fact write when the catalog cannot be confirmed.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {scoped} from '../scripts/bundle-scope.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-catalog-watched-'));let databases=0;
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const lit=value=>"'"+String(value).replace(/'/g,"''")+"'";
function migrated(options={}){
 const file=path.join(root,'w-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return d1Standin(file,options);
}
const G1='11111111-1111-4111-8111-111111111111',G2='22222222-2222-4222-8222-222222222222',ORIGIN='https://iptv.vladimino.workers.dev',hour=3600000,now=Date.now();
const records=new Map();let puts=[],gets=[],pointerReads=0,onPointerRead=null;
const bucket={
 async get(key){
  gets.push(key);
  if(key==='epg/published-generation.json'){pointerReads++;if(onPointerRead)onPointerRead(pointerReads);}
  return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key))}:null;
 },
 async put(key,value){records.set(key,JSON.parse(value));puts.push(key);return {etag:'e'};},
 async delete(key){puts.push('delete:'+key);records.delete(key);},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key,customMetadata:{}})),truncated:false};}
};
const world=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 fetch:async()=>{throw new Error('unexpected outbound request');}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),world);
vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8'),world);
vm.runInContext(scoped('src/discovery-authority.js','DiscoveryAuthority'),world);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/migration-export.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),world);
const worker=world.worker,constant=name=>vm.runInContext(name,world);

const film=(n,extra={})=>({id:'tmdb_'+n,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,title:'Film '+n,original:'Film '+n,year:2000,runtime:100,genres:[],poster:null,url:null,directors:[],actors:[],shows:[{channelId:'c1',channel:'One',start:now-hour,end:now+hour}],showsProgrammeRunId:G1,...extra});
const current={prediction:{predictedRating:4.5,probability4Plus:.9,confidence:'high',matchSignals:[],mainRisk:null,tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1},fingerprintHash:'f',impactFeatures:{fingerprintHash:'f',fingerprintSchemaVersion:1,fingerprintPromptVersion:1},fingerprint:{fingerprintHash:'f',plotMechanics:[],execution:{}}};
function seedBucket({withR2Catalog=null}={}){
 records.clear();puts=[];gets=[];pointerReads=0;onPointerRead=null;
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:G1});
 for(const key of ['programme.json','epg/generations/'+G1+'/programme.json'])records.set(key,{runId:G1,updatedAt:new Date(now).toISOString(),watchlistCount:0,films:[],stats:{}});
 records.set('watchlist.json',{films:[]});
 records.set(constant('profileKey'),{version:1,profileHash:'p1'});
 records.set(constant('ENRICHMENT_KEY')+'view-index.json',Object.fromEntries([10,11,12].map(n=>['tmdb_'+n,current])));
 if(withR2Catalog)records.set('epg/generations/'+G1+'/discovered-films.json',withR2Catalog);
}
function admit(db,item,{state='current'}={}){
 db.sql(`INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, generation, state, payload_json) VALUES (${lit(item.id)},${lit(item.tmdbId)},'movie',${lit(item.canonicalIdentity)},1,${lit(state)},${lit(JSON.stringify(item))})`);
}
function d1World(options){
 const db=migrated(options);
 db.sql(`UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id=${lit(G1)}, published_programme_run_id=${lit(G1)} WHERE id=1`);
 admit(db,film(10));admit(db,film(11));admit(db,film(12),{state:'pending'});admit(db,film(13),{state:'superseded'});
 return db;
}
const post=async(env,body)=>{
 const response=await worker.fetch(new Request(ORIGIN+'/api/catalog/watched',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(body)}),env,{waitUntil(){}});
 return {status:response.status,body:await response.json()};
};
const available=async env=>{const response=await worker.fetch(new Request(ORIGIN+'/api/catalog/available'),env,{waitUntil(){}});return {status:response.status,body:await response.json()};};
const factWrites=()=>puts.filter(key=>key.startsWith('letterboxd/facts/'));
const refusedWithoutWrite=(r,status,code,label)=>{assert.equal(r.status,status,label+': '+JSON.stringify(r.body));assert.equal(r.body.code,code,label);assert.deepEqual(factWrites(),[],label+': no owner fact written');};
const noR2Catalog=label=>assert.ok(!gets.some(key=>/discovered-films\.json$/.test(key)),label+': the catalog is never read from R2');

// 1. D1-owned generation catalog, no R2 copy: GET finds the film, POST marks and unmarks it.
{
 seedBucket();const db=d1World();const env={DB:db,BUCKET:bucket};
 const finds=await available(env);
 assert.equal(finds.status,200,JSON.stringify(finds.body));
 const offered=finds.body.films.map(item=>item.id).filter(id=>id.startsWith('tmdb_')).sort();
 assert.deepEqual(offered,['tmdb_10','tmdb_11'],'GET offers the verified current films of the D1 catalog');
 // GET and POST agree: every film the Finds list offers can be marked, and a film it does not offer is refused.
 for(const id of offered){
  const on=await post(env,{tmdbId:id.slice(5),watched:true});
  assert.equal(on.status,200,id+' '+JSON.stringify(on.body));assert.deepEqual(on.body,{outcome:'saved',watched:true});
 }
 assert.ok(factWrites().length>0,'the owner fact is written');
 const off=await post(env,{tmdbId:'10',watched:false});
 assert.deepEqual([off.status,off.body],[200,{outcome:'saved',watched:false}],'Undo works on the D1 catalog');
 noR2Catalog('D1 mode');
 for(const [tmdbId,why] of [['99','unknown'],['12','pending admission'],['13','superseded admission']]){
  puts=[];refusedWithoutWrite(await post(env,{tmdbId,watched:true}),409,'film_not_in_catalog',why);
 }
}

// 2. Fail closed: held cutover, unfinished transfer, generation mismatch, D1 outage. No R2 fallback, no write, an honest code.
{
 const stale={tmdb_10:film(10)};
 {seedBucket({withR2Catalog:stale});const db=d1World();db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");
  refusedWithoutWrite(await post({DB:db,BUCKET:bucket},{tmdbId:'10',watched:true}),503,'discovery_fence','held cutover');noR2Catalog('held');}
 {seedBucket({withR2Catalog:stale});const db=d1World();db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
  refusedWithoutWrite(await post({DB:db,BUCKET:bucket},{tmdbId:'10',watched:true}),503,'discovery_incomplete','transfer loading');noR2Catalog('loading');}
 {seedBucket({withR2Catalog:stale});const db=d1World();db.sql(`UPDATE discovery_authority SET programme_run_id=${lit(G2)} WHERE id=1`);
  refusedWithoutWrite(await post({DB:db,BUCKET:bucket},{tmdbId:'10',watched:true}),503,'catalog_generation_unavailable','authority on another generation (a stale R2 copy is not used)');noR2Catalog('mismatch');}
 {seedBucket({withR2Catalog:stale});const db=d1World();const broken={...db,prepare(sql){if(/discovery_authority/.test(sql))throw new Error('D1_ERROR: outage');return db.prepare(sql);}};
  refusedWithoutWrite(await post({DB:broken,BUCKET:bucket},{tmdbId:'10',watched:true}),503,'discovery_unavailable','D1 outage');noR2Catalog('outage');}
 {seedBucket({withR2Catalog:stale});records.delete('epg/published-generation.json');const db=d1World();
  refusedWithoutWrite(await post({DB:db,BUCKET:bucket},{tmdbId:'10',watched:true}),503,'catalog_not_published','no publication');}
}

// 3. Fence between validation and the write: a generation or authority change after the film was verified writes nothing.
{
 seedBucket();const db=d1World();
 onPointerRead=count=>{if(count===2)records.set('epg/published-generation.json',{phase:'published',programmeRunId:G2});};
 refusedWithoutWrite(await post({DB:db,BUCKET:bucket},{tmdbId:'10',watched:true}),503,'catalog_generation_changed','publication moved after the check');
}
// The Discovery authority changing after the film was verified, with the publication and the programme run unchanged: nothing is written.
for(const [label,sql,code] of [
 ['cutover held',"UPDATE discovery_authority SET cutover='held' WHERE id=1",'discovery_fence'],
 ['authority D1/open to R2/open, same run',"UPDATE discovery_authority SET mode='r2' WHERE id=1",'catalog_generation_changed'],
 ['D1 generation advanced, same run',"UPDATE discovery_authority SET generation=generation+1 WHERE id=1",'catalog_generation_changed'],
 ['transfer loading, same run',"UPDATE discovery_transfer SET state='loading' WHERE id=1",'discovery_incomplete'],
]){
 seedBucket();const db=d1World();let flipped=false;
 onPointerRead=count=>{if(count===2&&!flipped){flipped=true;db.sql(sql);}};
 refusedWithoutWrite(await post({DB:db,BUCKET:bucket},{tmdbId:'10',watched:true}),503,code,label);assert.ok(flipped,label+': changed between the check and the write');
 assert.equal(records.get('epg/published-generation.json').programmeRunId,G1,label+': the publication did not move');
}
// Stable authority: the same request with no change in between writes.
{
 seedBucket();const db=d1World();
 const ok=await post({DB:db,BUCKET:bucket},{tmdbId:'10',watched:true});assert.deepEqual([ok.status,ok.body],[200,{outcome:'saved',watched:true}],'stable D1');
}

// 4. Discovery still R2-owned: the generation's own R2 copy is read as before; an absent copy is unavailability, not a missing film.
{
 seedBucket({withR2Catalog:{tmdb_10:film(10)}});
 const ok=await post({BUCKET:bucket},{tmdbId:'10',watched:true});assert.deepEqual([ok.status,ok.body],[200,{outcome:'saved',watched:true}]);
 const withDb=await post({DB:migrated(),BUCKET:bucket},{tmdbId:'10',watched:false});assert.deepEqual([withDb.status,withDb.body],[200,{outcome:'saved',watched:false}],'a D1 binding with Discovery on r2 reads R2');
 {const db=migrated();let flipped=false;
  seedBucket({withR2Catalog:{tmdb_10:film(10)}});
  onPointerRead=count=>{if(count===2&&!flipped){flipped=true;db.sql(`UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id=${lit(G1)} WHERE id=1`);}};
  refusedWithoutWrite(await post({DB:db,BUCKET:bucket},{tmdbId:'10',watched:true}),503,'catalog_generation_changed','R2 to D1 after the R2 read');assert.ok(flipped);
  seedBucket({withR2Catalog:{tmdb_10:film(10)}});}
 puts=[];refusedWithoutWrite(await post({BUCKET:bucket},{tmdbId:'99',watched:true}),409,'film_not_in_catalog','unknown film');
 seedBucket();refusedWithoutWrite(await post({BUCKET:bucket},{tmdbId:'10',watched:true}),503,'catalog_generation_unavailable','no copy at all');
}

// 5. The client shows no success for a refusal: only an ok answer with a boolean `watched` is a success; 409 and 503 become the card's error.
{
 const app=fs.readFileSync('public/app.js','utf8');
 const body=app.slice(app.indexOf('async function postWatchedMark'),app.indexOf('async function markFindWatched'));
 assert.match(body,/!response\.ok\|\|!data\|\|typeof data\.watched!=='boolean'\)throw new Error\(/,'a refusal throws instead of returning');
 assert.match(body,/film_not_in_catalog'\?[^:]+:'Не удалось сохранить, попробуй ещё раз'/,'an unavailable answer (503) is the generic retry error, never the missing-film message');
}
console.log('Catalog watched: POST reads the pinned, authority-aware generation catalog (D1 without an R2 copy, R2 as before), agrees with GET, and fails closed with honest codes and no write');
