// AIR-499: marker-gated metadata.json consumers GET /api/catalog/film/<id>, GET /api/catalog/available and ratingsFilmLabels.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {installViewIndexFixture} from './view-index-fixture.mjs';
import {webcrypto} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const IMPORT='const {CREDIT_SELECTION_SQL,database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-canonical-meta-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const TO_OPEN="UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;",TO_HELD="UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;";
const MARKER={r2:'',prepared:VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;"};
MARKER.open=MARKER.prepared+TO_OPEN;MARKER.held=MARKER.open+TO_HELD;
const T='2026-11-16T10:00:00.000Z';
const SEED=`
INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES
 ('film:heat-1995',1,'tmdb:7','Heat','${T}'),
 ('film:orphan',1,NULL,'No Title','${T}');
INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES
 ('film:heat-1995',1,1995,NULL,NULL,'https://a.example/p.jpg','https://letterboxd.com/film/heat-1995/','[]',NULL,'{}',NULL,NULL,'${T}');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES
 ('film:heat-1995','letterboxd','heat-1995',1,0,NULL),
 ('film:heat-1995','tmdb','7',1,0,NULL);
INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,updated_at) VALUES
 ('film:heat-1995','localization','provisional','wikidata','p','{"sources":[]}',N'Жара','automatic','${T}');
`.replace("N'Жара'","'Жара'");

let n=0;const BASE=new Map();
function database(state){
 const file=path.join(root,'m-'+(n++)+'.sqlite');
 const upTo=state==='legacy'?names.findIndex(name=>name.startsWith('0013')):names.length;
 if(!BASE.has(upTo)){const shared=process.env.CANONICAL_CATALOG_BASE_DIR,base=path.join(shared||root,'base-meta-'+upTo+'.sqlite');if(!(shared&&fs.existsSync(base)))sqlite(base,names.slice(0,upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));BASE.set(upTo,base);}
 fs.copyFileSync(BASE.get(upTo),file);
 if(state!=='legacy')sqlite(file,SEED);
 if(state==='unknown-row'){sqlite(file,MARKER.prepared);sqlite(file,'DROP TRIGGER film_person_authority_no_delete;DELETE FROM film_person_authority;');}
 else if(state==='unknown-table')sqlite(file,'DROP TABLE film_person_cas;');
 else if(MARKER[state])sqlite(file,MARKER[state]);
 return file;
}
const standin=(file,state,extra={})=>d1Standin(file,{...extra,...(state==='unknown-read'?{rewrite:sql=>/FROM film_person_authority/.test(sql)?'SELECT nope FROM nowhere':sql}:{})});

const G1='22222222-2222-4222-8222-222222222222';
const records=new Map(),reads=[];let onR2=null;
const bucket={
 async get(key){reads.push(key);if(onR2)await onR2(key);return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key)),text:async()=>JSON.stringify(records.get(key)),size:JSON.stringify(records.get(key)).length}:null;},
 async put(){throw new Error('no R2 write from a GET');},
 async list(){return {objects:[],truncated:false};}
};
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},fetch:async()=>new Response('unexpected',{status:599})});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ctx);
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader',IMPORT),ctx);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),ctx);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
installViewIndexFixture(ctx);
const worker=ctx.worker;

function seedCatalog(){
 records.clear();reads.length=0;onR2=null;
 const now=Date.now(),hour=3600000;
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:G1});
 const film={id:'tmdb_7',tmdbId:'7',canonicalIdentity:'tmdb:7',title:'Heat',original:'Heat',year:1995,runtime:170,genres:[],poster:null,url:'https://www.themoviedb.org/movie/7',directors:[],actors:[],shows:[{channelId:'c1',channel:'One',start:now-hour,end:now+hour}],showsProgrammeRunId:G1};
 for(const key of ['epg/discovered-films.json','epg/generations/'+G1+'/discovered-films.json'])records.set(key,{tmdb_7:structuredClone(film)});
 for(const key of ['programme.json','epg/generations/'+G1+'/programme.json'])records.set(key,{runId:G1,updatedAt:T,watchlistCount:0,films:[],stats:{}});
 records.set('watchlist.json',{updatedAt:T,films:[]});
 records.set('metadata.json',{'heat-1995':{id:'heat-1995',tmdbId:'7',poster:'https://r2.example/stale.jpg',url:'https://letterboxd.com/film/heat-1995/',year:1995,title:'Stale'}});
 records.set('titles.json',{'heat-1995':{title:'From titles',tmdbId:'7',status:'provisional',sources:null}});
 records.set(vm.runInContext('profileKey',ctx),{version:1,profileHash:'p1'});
 records.set(vm.runInContext('ENRICHMENT_KEY',ctx)+'view-index.json',{tmdb_7:{prediction:{predictedRating:4,probability4Plus:.5,confidence:'high',matchSignals:[],mainRisk:null,tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1},fingerprintHash:'f',impactFeatures:{fingerprintHash:'f',fingerprintSchemaVersion:1,fingerprintPromptVersion:1},fingerprint:{fingerprintHash:'f',plotMechanics:[],moodLabels:[],execution:{}}}});
}

const ask=async(route,env)=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev'+route),{BUCKET:bucket,...env},{waitUntil(){}});return {status:r.status,body:await r.json()};};
const getFilm=async(id,env)=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/film/'+id),{BUCKET:bucket,...env},{waitUntil(){}});return {status:r.status,body:await r.json()};};

{
 seedCatalog();reads.length=0;
 const prepared=await getFilm('7',{DB:standin(database('prepared'),'prepared')});
 assert.equal(prepared.status,503,'prepared is not served (ADR 0162)');
 assert.ok(!reads.includes('metadata.json'),'prepared never reads metadata.json');
}
{
 seedCatalog();
 const open=await getFilm('7',{DB:standin(database('open'),'open')});
 assert.equal(open.status,200);
 assert.ok(!reads.includes('metadata.json'),'open does not read frozen metadata.json');
 assert.equal(open.body.film.poster,'https://a.example/p.jpg','D1 poster');
 assert.equal(open.body.film.letterboxdUrl,'https://letterboxd.com/film/heat-1995/');
}
{
 seedCatalog();
 const held=await getFilm('7',{DB:standin(database('held'),'held')});
 assert.equal(held.status,503);
 assert.equal(held.body.reason,'film_person_held');
 assert.ok(!reads.includes('metadata.json'),'held never falls back to R2 metadata.json');
}
{
 seedCatalog();
 const unread=await getFilm('7',{DB:standin(database('unknown-read'),'unknown-read')});
 assert.equal(unread.status,503);
 assert.equal(unread.body.reason,'film_person_unavailable');
}

{
 seedCatalog();
 const prepared=await ask('/api/catalog/available',{DB:standin(database('prepared'),'prepared')});
 assert.equal(prepared.status,503,'prepared is not served (ADR 0162)');
}
{
 seedCatalog();
 const open=await ask('/api/catalog/available',{DB:standin(database('open'),'open')});
 assert.equal(open.status,200);
 assert.ok(!reads.includes('metadata.json'),'available at open skips frozen metadata.json');
 const heat=open.body.films.find(f=>f.tmdbId==='7');
 assert.ok(heat);
 assert.equal(heat.poster,'https://a.example/p.jpg');
}
{
 seedCatalog();
 const held=await ask('/api/catalog/available',{DB:standin(database('held'),'held')});
 assert.equal(held.status,503);
 assert.equal(held.body.reason,'film_person_held');
}

{
 const file=database('open');seedCatalog();
 let gates=0;
 const env={BUCKET:bucket,DB:standin(file,'open',{onQuery:async text=>{if(/FROM film_person_authority/.test(text)){gates++;if(gates===2)sqlite(file,TO_HELD);}}})};
 const r=await getFilm('7',env);
 assert.equal(r.status,503);
 assert.equal(r.body.reason,'film_person_generation_moved');
}
{
 const file=database('open');seedCatalog();
 let gates=0;
 const env={BUCKET:bucket,DB:standin(file,'open',{onQuery:async text=>{if(/FROM film_person_authority/.test(text)){gates++;if(gates===3)sqlite(file,TO_HELD);}}})};
 const r=await getFilm('7',env);
 assert.equal(r.status,503,'open film rechecks the marker after predictionFreshness');
 assert.equal(r.body.reason,'film_person_generation_moved');
}
{
 const file=database('open');seedCatalog();
 let gates=0;
 const env={BUCKET:bucket,DB:standin(file,'open',{onQuery:async text=>{if(/FROM film_person_authority/.test(text)){gates++;if(gates===3)sqlite(file,TO_HELD);}}})};
 const r=await ask('/api/catalog/available',env);
 assert.equal(r.status,503,'available rechecks after predictionFreshness');
 assert.equal(r.body.reason,'film_person_generation_moved');
}

{
 seedCatalog();
 const env={BUCKET:bucket,DB:standin(database('open'),'open')};
 const map=await vm.runInContext('ratingsFilmLabels',ctx)(env,['heat-1995','tmdb_7','unknown']);
 assert.equal(map.get('heat-1995').title,'Жара');
 assert.equal(map.get('heat-1995').year,1995);
 assert.equal(map.get('heat-1995').tmdb,'7');
 assert.equal(map.get('tmdb_7').tmdb,'7');
 assert.equal(map.get('unknown').tmdb,null);
 assert.ok(!reads.includes('metadata.json'));
 assert.ok(!reads.includes('titles.json'));
}
{
 seedCatalog();
 const env={BUCKET:bucket,DB:standin(database('prepared'),'prepared')};
 await assert.rejects(()=>vm.runInContext('ratingsFilmLabels',ctx)(env,['heat-1995']),error=>error.code==='film_person_unavailable','prepared is not served (ADR 0162)');
}
{
 seedCatalog();
 records.set('metadata.json',{
  'heat-1995':{id:'heat-1995',tmdbId:'7',year:1995,title:'Stale'},
  'heat-dup':{id:'heat-1995',tmdbId:'8',year:1995,title:'Other'}
 });
 const env={BUCKET:bucket,DB:standin(database('prepared'),'prepared')};
 await assert.rejects(()=>vm.runInContext('ratingsFilmLabels',ctx)(env,['heat-1995']),error=>error.code==='film_person_unavailable');
}
{
 seedCatalog();
 await assert.rejects(()=>vm.runInContext('ratingsFilmLabels',ctx)({BUCKET:bucket,DB:standin(database('held'),'held')},['heat-1995']),error=>error.code==='film_person_held');
}

{
 const reader=await import('../src/canonical-catalog-reader.js');
 const env={DB:standin(database('open'),'open')};
 const gate=await reader.catalogReaderGate(env);
 const none=await reader.catalogMetadataFromD1(env,['missing-lid'],gate);
 assert.equal(none['missing-lid'],undefined,'absent optional facts are not a read error');
 const orphan=await reader.catalogMetadataFromD1(env,['orphan'],await reader.catalogReaderGate(env));
 assert.equal(orphan.orphan.tmdb,undefined);
 assert.equal(orphan.orphan.tmdbId,null);
 assert.equal(orphan.orphan.identityBlocked,undefined,'a missing TMDB claim is not identityBlocked');
 assert.equal(orphan.orphan.title,'No Title');
 assert.equal(orphan.orphan.original,'No Title');
}
{
 const file=database('open');
 sqlite(file,`
INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',1,NULL,'Other','${T}');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:other','tmdb','7',0,0,NULL);
`);
 const reader=await import('../src/canonical-catalog-reader.js');
 const env={DB:standin(file,'open')};
 const heat=await reader.catalogMetadataFromD1(env,['heat-1995'],await reader.catalogReaderGate(env));
 assert.equal(heat['heat-1995'].tmdbId,null,'an untrusted claim of the same TMDB id is a conflict, not ignored');
 assert.equal(heat['heat-1995'].identityBlocked,true);
}

console.log('canonical-catalog-metadata: film/available/ratings labels refuse prepared (ADR 0162), read bounded D1 at open, and STOP on held/unreadable/generation move without metadata.json fallback');
