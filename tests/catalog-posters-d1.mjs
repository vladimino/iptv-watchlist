// AIR-515. With Discovery on D1 (mode d1, cutover open) catalog poster hydration reads and writes the `discovery_admission` rows and
// nothing in R2 that holds the catalog. Real sqlite (D1 stand-in); no Cloudflare, TMDB or production access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {scoped} from '../scripts/bundle-scope.mjs';
import {runPosterSweep} from '../src/admin/posters-run.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-poster-d1-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'].map(name=>name+'.sql');
let databases=0;
const migrated=()=>{
 const file=path.join(root,'posters-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 const db=d1Standin(file);
 db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 return db;
};
const POSTER='https://image.tmdb.org/t/p/w342';
const RUN='11111111-1111-4111-8111-111111111111';
const film=(id,tmdbId,extra={})=>({id,tmdbId:String(tmdbId),canonicalIdentity:'tmdb:'+tmdbId,title:'Film '+id,year:2001,poster:null,...extra});
const stored=(db,id)=>JSON.parse(db.sql("SELECT payload_json FROM discovery_admission WHERE film_id='"+id+"'")[0].payload_json);
const withLease=async(db,body)=>{
 const bucket=new MemoryBucket();
 await bucket.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:RUN}));
 const env={DB:db,BUCKET:bucket,discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 await Authority.replaceLedger(env,{programmeRunId:RUN,items:[]});
 return {env,bucket};
};

// 1. The writer: written, duplicate, identity guards.
{
 const db=migrated();const {env}=await withLease(db);
 await Authority.replaceCatalog(env,{tmdb_1:film('tmdb_1',1),tmdb_2:film('tmdb_2',2,{poster:POSTER+'/kept.jpg'}),tmdb_3:film('tmdb_3',3)});
 const rows=[{filmId:'tmdb_1',tmdbId:'1',poster:POSTER+'/one.jpg'},{filmId:'tmdb_2',tmdbId:'2',poster:POSTER+'/other.jpg'},{filmId:'tmdb_3',tmdbId:'99',poster:POSTER+'/three.jpg'},{filmId:'tmdb_404',tmdbId:'404',poster:POSTER+'/x.jpg'}];
 const result=await Authority.applyPosters(env,rows,{lease:env.discoveryLease});
 assert.deepEqual(result.status,{tmdb_1:'written',tmdb_2:'present',tmdb_3:'changed',tmdb_404:'changed'});
 assert.equal(stored(db,'tmdb_1').poster,POSTER+'/one.jpg');
 assert.equal(stored(db,'tmdb_2').poster,POSTER+'/kept.jpg');
 assert.equal(stored(db,'tmdb_3').poster,null);
 assert.equal(stored(db,'tmdb_1').title,'Film tmdb_1');
 // A repeat (a lost response) is already present and writes nothing.
 const before=db.sql('SELECT generation FROM discovery_authority')[0].generation;
 const again=await Authority.applyPosters(env,rows.slice(0,1),{lease:env.discoveryLease});
 assert.deepEqual(again.status,{tmdb_1:'present'});assert.equal(again.batches,0);
 assert.equal(db.sql('SELECT generation FROM discovery_authority')[0].generation,before);
 // A superseded row is never written.
 db.sql("UPDATE discovery_admission SET state='superseded' WHERE film_id='tmdb_3'");
 assert.deepEqual((await Authority.applyPosters(env,[{filmId:'tmdb_3',tmdbId:'3',poster:POSTER+'/three.jpg'}],{lease:env.discoveryLease})).status,{tmdb_3:'changed'});
 // Bad input and a missing lease fail closed.
 await assert.rejects(()=>Authority.applyPosters(env,[{filmId:'tmdb_1',tmdbId:'1',poster:'http://x/y.jpg'}],{lease:env.discoveryLease}),{code:'discovery_conflict'});
 await assert.rejects(()=>Authority.applyPosters({...env,discoveryLease:null},rows,{}),{code:'discovery_lease'});
 // Another generation or a lost lease: the batch is refused whole.
 db.sql("UPDATE discovery_admission SET state='current', payload_json=json_set(payload_json,'$.poster',NULL) WHERE film_id='tmdb_3'");
 await assert.rejects(()=>Authority.applyPosters(env,[{filmId:'tmdb_3',tmdbId:'3',poster:POSTER+'/a.jpg'}],{lease:env.discoveryLease,programmeRunId:'22222222-2222-4222-8222-222222222222'}),{code:'discovery_fence'});
 db.sql("UPDATE discovery_lease SET expires_at=1 WHERE id=1");
 await assert.rejects(()=>Authority.applyPosters(env,[{filmId:'tmdb_3',tmdbId:'3',poster:POSTER+'/a.jpg'}],{lease:env.discoveryLease}),{code:'discovery_fence'});
 assert.equal(stored(db,'tmdb_3').poster??null,null);
}

// 2. A later admission or catalog replacement keeps a stored poster of the same identity, and never gives it to another one.
{
 const db=migrated();const {env}=await withLease(db);
 await Authority.replaceCatalog(env,{tmdb_1:film('tmdb_1',1),tmdb_2:film('tmdb_2',2)});
 await Authority.applyPosters(env,[{filmId:'tmdb_1',tmdbId:'1',poster:POSTER+'/one.jpg'},{filmId:'tmdb_2',tmdbId:'2',poster:POSTER+'/two.jpg'}],{lease:env.discoveryLease});
 await Authority.upsertAdmissions(env,{tmdb_1:film('tmdb_1',1,{title:'Renamed'})},{lease:env.discoveryLease});
 assert.equal(stored(db,'tmdb_1').poster,POSTER+'/one.jpg');assert.equal(stored(db,'tmdb_1').title,'Renamed');
 await Authority.replaceCatalog(env,{tmdb_1:film('tmdb_1',1),tmdb_2:film('tmdb_2',2,{poster:POSTER+'/new.jpg'})});
 assert.equal(stored(db,'tmdb_1').poster,POSTER+'/one.jpg','replaceCatalog keeps the poster');
 assert.equal(stored(db,'tmdb_2').poster,POSTER+'/new.jpg','an explicit https poster of the same identity replaces it');
 // An identity owned by another film id is refused and the poster stays where it was.
 const refused=await Authority.upsertAdmissions(env,{tmdb_9:film('tmdb_9',1)},{lease:env.discoveryLease});
 assert.deepEqual(refused.refused.map(item=>item.filmId),['tmdb_9']);
 assert.equal(stored(db,'tmdb_1').poster,POSTER+'/one.jpg');
}

// 3. The Worker: hydration and the admin read use D1 and never touch an R2 catalog object.
{
 const db=migrated();const {env,bucket}=await withLease(db);
 await Authority.replaceCatalog(env,{tmdb_1:film('tmdb_1',1),tmdb_2:film('tmdb_2',2,{poster:POSTER+'/kept.jpg'}),tmdb_3:film('tmdb_3',3),tmdb_4:film('tmdb_4',4),tmdb_6:film('tmdb_6',6)});
 await Authority.releaseLease(env,env.discoveryLease);env.discoveryLease=null;
 const r2Writes=[],r2Reads=[];
 const guarded={
  async get(key){r2Reads.push(key);return bucket.get(key);},
  async head(key){return bucket.head(key);},
  async put(key,body,options){r2Writes.push(key);return bucket.put(key,body,options);},
  async delete(){throw new Error('delete');},async list(){throw new Error('list');},
 };
 const fetches=[];let tmdb={};
 const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,atob,btoa,crypto:webcrypto,console,setTimeout,structuredClone,encodeURIComponent,decodeURIComponent,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},FILM_TITLE_DICTIONARY:[],PERSON_NAME_DICTIONARY:[],DiscoveryAuthority:Authority,
  fetch:async input=>{const url=String(input instanceof Request?input.url:input);fetches.push(url);const match=url.match(/\/movie\/(\d+)\?/);const reply=match?tmdb[match[1]]:null;if(typeof reply==='function')return reply();if(!reply)return new Response('x',{status:599});return new Response(JSON.stringify(reply),{status:200});}});
 vm.runInContext(scoped('src/domain/discovery-observation-index.js','DiscoveryIndex'),context);
 for(const file of ['src/domain/film-person.js','src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/prediction-quality.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 vm.runInContext(scoped('src/domain/admin-query.js','AdminQuery'),context);
 for(const file of ['src/admin/owner-reviews.js','src/admin/read.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 vm.runInContext(scoped('src/domain/data-health.js','DataHealth'),context);
 vm.runInContext(fs.readFileSync('src/admin/posters.js','utf8'),context);
 vm.runInContext(scoped('src/domain/limbo-inventory.js','LimboInventory'),context);
 vm.runInContext(fs.readFileSync('src/admin/limbo.js','utf8'),context);
 vm.runInContext(scoped('src/domain/admin-actions.js','AdminActions'),context);
 vm.runInContext(scoped('src/domain/discovery-identity-review.js','DiscoveryIdentity'),context);
 vm.runInContext(scoped('src/domain/discovery-recovery.js','DiscoveryRecovery'),context);
 vm.runInContext(fs.readFileSync('src/admin/discovery-recovery.js','utf8'),context);
 vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),context);
 vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),context);
 const base={...env,BUCKET:guarded,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
 const post=async(body,extra={})=>{const response=await context.worker.fetch(new Request('https://iptv.example/api/enrichment/catalog/posters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{...base,...extra},{waitUntil(){}});return {status:response.status,body:await response.json()};};
 const noR2Catalog=()=>assert.deepEqual(r2Writes.filter(key=>key.includes('discovered-films')),[]);

 // Dry run: D1 numbers, no TMDB, no writes.
 let r=await post({});
 assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.catalogRecords,5);assert.equal(r.body.missingPoster,4);assert.deepEqual(Array.from(r.body.ids),['tmdb_1','tmdb_3','tmdb_4','tmdb_6']);
 assert.deepEqual(fetches,[]);assert.deepEqual(r2Writes,[]);
 assert.ok(!r2Reads.some(key=>key.includes('discovered-films')),'no R2 catalog read');

 // Execution: hydrated into D1; no poster, mismatch, failure and 429 stay as before; R2 catalog untouched.
 tmdb={1:{id:1,poster_path:'/one.jpg'},3:{id:3,poster_path:null},4:()=>new Response('boom',{status:500}),6:{id:66,poster_path:'/other.jpg'}};
 r=await post({dryRun:false,limit:10});
 assert.equal(r.status,200,JSON.stringify(r.body));
 const byId=Object.fromEntries(r.body.outcomes.map(item=>[item.id,item.outcome]));
 assert.deepEqual(byId,{tmdb_1:'hydrated',tmdb_3:'no_poster_on_tmdb',tmdb_4:'tmdb_failed',tmdb_6:'tmdb_id_mismatch'});
 assert.deepEqual(r.body.writes.map(write=>[write.key,write.written,write.records]),[['discovery_admission',true,1]]);
 assert.deepEqual(r.body.outcomes.find(item=>item.id==='tmdb_1').writtenTo,['discovery_admission']);
 assert.equal(stored(db,'tmdb_1').poster,POSTER+'/one.jpg');assert.equal(stored(db,'tmdb_3').poster,null);
 noR2Catalog();
 assert.ok(r2Writes.every(key=>key==='epg/catalog-poster-negatives.json'),'only the negative index is written to R2: '+r2Writes);

 // Duplicate apply after a lost response: already_present (the stored poster is the same), no second write.
 tmdb={1:{id:1,poster_path:'/one.jpg'}};
 r=await post({dryRun:false,limit:10,recheck:['1']});
 assert.equal(r.body.outcomes[0].outcome,'not_eligible');

 // The same D1 value reaches the admin read and the Discovery catalog read.
 const admin=await context.worker.fetch(new Request('https://iptv.example/api/admin/posters',{headers:{'Cf-Access-Jwt-Assertion':'header.payload.signature'}}),base,{waitUntil(){}});
 const adminBody=await admin.json();
 assert.equal(admin.status,200,JSON.stringify(adminBody));
 assert.equal(adminBody.evidence.complete,true,JSON.stringify(adminBody.evidence));
 assert.equal(adminBody.catalogRecords,5);assert.equal(adminBody.withPoster,2);assert.deepEqual(adminBody.copies.map(copy=>copy.key),['discovery_admission']);
 assert.equal((await Authority.routeRead(env,'epg/discovered-films.json')).value.tmdb_1.poster,POSTER+'/one.jpg');
 assert.deepEqual(r2Writes.filter(key=>key.includes('discovered-films')),[]);

 // A competing admission writer between the TMDB answer and the write: the poster of the same identity survives.
 db.sql("UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.poster',NULL) WHERE film_id='tmdb_1'");
 tmdb={1:{id:1,poster_path:'/one.jpg'}};
 r=await post({dryRun:false,limit:1,cursor:''},{beforeCatalogPosterWrite:async()=>{db.sql("UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.poster','"+POSTER+"/rival.jpg') WHERE film_id='tmdb_1'");}});
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(r.body.outcomes[0].outcome,'already_present');assert.equal(stored(db,'tmdb_1').poster,POSTER+'/rival.jpg');

 // A generation change before the TMDB call fences the call (409) and writes nothing; D1 unavailable is a 503, never "no poster".
 const stale=await post({dryRun:false,expectedProgrammeRunId:'33333333-3333-4333-8333-333333333333'});
 assert.equal(stale.status,409);assert.equal(stale.body.generationChanged,true);
 db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");
 const held=await post({});
 assert.equal(held.status,503,JSON.stringify(held.body));
 noR2Catalog();
 // 4. Fail closed (review of AIR-515): an authority that is not d1/open is unavailable, never the R2 catalog. An R2 catalog object is seeded, and none is read or written.
 const seedR2=async()=>{for(const key of ['epg/discovered-films.json','epg/generations/'+RUN+'/discovered-films.json'])await bucket.put(key,JSON.stringify({tmdb_1:film('tmdb_1',1)}));};
 await seedR2();
 const adminGet=async extra=>{const response=await context.worker.fetch(new Request('https://iptv.example/api/admin/posters',{headers:{'Cf-Access-Jwt-Assertion':'header.payload.signature'}}),{...base,...extra},{waitUntil(){}});return {status:response.status,body:await response.json()};};
 const closedCases={
  'missing D1 binding':()=>({DB:undefined}),
  'schema missing':()=>({DB:d1Standin(path.join(root,'empty.sqlite'))}),
  'schema too old':()=>{const file=path.join(root,'old.sqlite');const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.slice(0,8).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});assert.equal(result.status,0);return {DB:d1Standin(file)};},
  'marker r2':()=>{db.sql("UPDATE discovery_authority SET mode='r2', cutover='open' WHERE id=1");return {};},
 };
 tmdb={1:{id:1,poster_path:'/one.jpg'}};
 for(const [name,arrange] of Object.entries(closedCases)){
  const extra=arrange();r2Reads.length=0;r2Writes.length=0;fetches.length=0;
  for(const body of [{},{dryRun:false,limit:5}]){
   const answer=await post(body,extra);
   assert.equal(answer.status,503,name+' '+JSON.stringify(body)+JSON.stringify(answer.body));assert.equal(answer.body.storageUnavailable,true,name);
  }
  const read=await adminGet(extra);assert.equal(read.status,503,name);
  assert.deepEqual(fetches,[],name+': no TMDB call');assert.deepEqual(r2Writes,[],name+': no R2 write');
  assert.ok(!r2Reads.some(key=>key.includes('discovered-films')),name+': no R2 catalog read');
 }
 db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");

 // 5. A D1 batch that fails after the dry run, TMDB and the lease is an uncertain write: 503 `writeUncertain`, no remembered answer saved, and the admin runner stops without a retry.
 db.sql("UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.poster',NULL) WHERE film_id='tmdb_1'");
 let armed=true;
 const flaky={prepare:sql=>db.prepare(sql),batch:async statements=>{if(armed&&statements.some(item=>String(item.text).includes("json_set(payload_json,'$.poster'")&&String(item.text).startsWith('UPDATE discovery_admission')))throw new Error('D1_ERROR: connection lost');return db.batch(statements);}};
 r2Writes.length=0;tmdb={1:{id:1,poster_path:'/one.jpg'},3:{id:3,poster_path:null}};
 const failed=await post({dryRun:false,limit:10},{DB:flaky});
 assert.equal(failed.status,503,JSON.stringify(failed.body));assert.equal(failed.body.writeUncertain,true);assert.ok(Array.isArray(failed.body.retryable)&&failed.body.retryable.includes('tmdb_1'));
 assert.ok(!r2Writes.includes('epg/catalog-poster-negatives.json'),'nothing remembered after an uncertain write');
 const receipt=await runPosterSweep({confirmation:{programmeRunId:RUN,limit:10,calls:5,cursor:null},now:Date.now,call:async body=>{const response=await post(body,{DB:flaky});return {ok:response.status===200,status:response.status,body:response.body};}});
 assert.equal(receipt.stop,'write_uncertain');assert.equal(receipt.calls.length,1,'no blind retry');
 armed=false;
}
console.log('catalog-posters-d1: ok');
