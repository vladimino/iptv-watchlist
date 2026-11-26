// AIR-499: marker-gated admin titles.json/people.json snapshot, limbo, health and letterboxd-archive metadata.json.
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
import {exportArchive} from './fixtures/letterboxd-archive.mjs';

const IMPORT='const {CREDIT_SELECTION_SQL,database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-canonical-admin-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const TO_OPEN="UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;",TO_HELD="UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;";
const MARKER={r2:'',prepared:VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;"};
MARKER.open=MARKER.prepared+TO_OPEN;MARKER.held=MARKER.open+TO_HELD;
const T='2026-11-16T10:00:00.000Z';
const SEED=`
INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:h95',1,'tmdb:7','Heat','${T}');
INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES
 ('film:h95',1,1995,NULL,NULL,NULL,'https://letterboxd.com/film/heat-1995/','[]',NULL,'{}',NULL,NULL,'${T}');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES
 ('film:h95','letterboxd','h95',1,0,NULL),
 ('film:h95','tmdb','7',1,0,NULL);
INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,updated_at) VALUES
 ('film:h95','localization','provisional','wikidata','p','{"sources":[]}',N'Жара','automatic','${T}');
INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:actor/mira-sol','actor/mira-sol',1,'${T}');
INSERT INTO person_dimension (person_id,dimension,status,source,source_version,provenance_json,value,authority,updated_at) VALUES
 ('person:actor/mira-sol','localization','reviewed','wikidata','p',NULL,N'Мира D1','automatic','${T}');
`.replace("N'Жара'","'Жара'").replace("N'Мира D1'","'Мира D1'");

let n=0;const BASE=new Map();
function database(state){
 const file=path.join(root,'a-'+(n++)+'.sqlite');
 const upTo=state==='legacy'?names.findIndex(name=>name.startsWith('0013')):names.length;
 if(!BASE.has(upTo)){const shared=process.env.CANONICAL_CATALOG_BASE_DIR,base=path.join(shared||root,'base-admin-'+upTo+'.sqlite');if(!(shared&&fs.existsSync(base)))sqlite(base,names.slice(0,upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));BASE.set(upTo,base);}
 fs.copyFileSync(BASE.get(upTo),file);
 if(state!=='legacy')sqlite(file,SEED);
 if(state==='unknown-read'){sqlite(file,MARKER.prepared);}
 else if(MARKER[state])sqlite(file,MARKER[state]);
 return file;
}
const standin=(file,state,extra={})=>d1Standin(file,{...extra,...(state==='unknown-read'?{rewrite:sql=>/FROM film_person_authority/.test(sql)?'SELECT nope FROM nowhere':sql}:{})});

const G1='22222222-2222-4222-8222-222222222222';
const ORIGIN='https://iptv.vladimino.workers.dev';
const records=new Map(),reads=[];
const bucket={
 async get(key){
  reads.push(key);
  if(!records.has(key))return null;
  const value=records.get(key),text=JSON.stringify(value);
  return {etag:'e-'+key,uploaded:new Date(T),json:async()=>structuredClone(value),text:async()=>text,body:{cancel:async()=>{}},size:text.length};
 },
 async put(){throw new Error('no R2 write from a GET');},
 async list(){return {objects:[],truncated:false};}
};
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,ArrayBuffer,atob,btoa,crypto:webcrypto,console,setTimeout,structuredClone,Number,Math,FormData,File,Blob,ReadableStream,DecompressionStream,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},FILM_TITLE_DICTIONARY:[],PERSON_NAME_DICTIONARY:[],fetch:async()=>new Response('unexpected',{status:599})});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ctx);
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);
vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader',IMPORT),ctx);
vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),ctx);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/prediction-quality.js','src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js'])vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
vm.runInContext(scoped('src/domain/admin-query.js','AdminQuery'),ctx);
vm.runInContext(fs.readFileSync('src/admin/owner-reviews.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('src/admin/read.js','utf8'),ctx);
vm.runInContext(scoped('src/domain/data-health.js','DataHealth'),ctx);
vm.runInContext(fs.readFileSync('src/admin/health.js','utf8'),ctx);
vm.runInContext(scoped('src/domain/discovery-observation-index.js','DiscoveryIndex'),ctx);
vm.runInContext(scoped('src/domain/limbo-inventory.js','LimboInventory'),ctx);
vm.runInContext(fs.readFileSync('src/admin/limbo.js','utf8'),ctx);
for(const [file,name] of [['src/letterboxd-export.js','LetterboxdExport'],['src/letterboxd-match.js','LetterboxdMatch'],['src/domain/letterboxd-archive-zip.js','LetterboxdArchiveZip'],['src/domain/letterboxd-archive-preview.js','LetterboxdArchivePreview'],['src/domain/letterboxd-archive-apply.js','LetterboxdArchiveApply'],['src/domain/admin-actions.js','AdminActions'],['src/domain/letterboxd-rated-admission.js','LetterboxdRatedAdmission']])vm.runInContext(scoped(file,name),ctx);
vm.runInContext(fs.readFileSync('src/admin/letterboxd-archive.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('src/admin/letterboxd-archive-apply.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),ctx);
installViewIndexFixture(ctx);
const worker=ctx.worker;

function seedAdmin(){
 records.clear();reads.length=0;
 vm.runInContext('ADMIN_SNAPSHOT_CACHE=null;ADMIN_LIMBO_CACHE=null',ctx);
 const mira={id:'actor/mira-sol',name:'Мира Соль',original:'Mira Sol'};
 const film={id:'h95',tmdbId:'7',title:'Heat',original:'Heat',year:1995,directors:[],actors:[mira],shows:[]};
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:G1,publishedAt:T});
 records.set('epg/generations/'+G1+'/programme.json',{runId:G1,updatedAt:T,watchlistCount:1,films:[film],people:{directors:[],actors:[mira]},stats:{}});
 records.set('titles.json',{q2:{title:'Stale R2'}});
 records.set('people.json',{'actor/mira-sol':{name:'Stale R2',original:'Mira Sol'}});
 records.set('metadata.json',{h95:{id:'h95',tmdbId:'7',title:'Stale R2',original:'Heat',year:1995}});
 records.set('admin/owner-reviews.json',{contractVersion:1,films:{},people:{}});
 records.set(vm.runInContext('profileKey',ctx),{version:1,profileHash:'p1'});
 records.set(vm.runInContext('ENRICHMENT_KEY',ctx)+'view-index.json',{});
 records.set(vm.runInContext('predictionQueueKey',ctx),{pending:[]});
 records.set('epg/generations/'+G1+'/discovered-films.json',{});
}

const ask=async(route,env,init)=>{const r=await worker.fetch(new Request(ORIGIN+route,init),{BUCKET:bucket,...env},{waitUntil(){}});return {status:r.status,body:await r.json()};};

async function preview(env,films){
 const bytes=exportArchive(films);
 const form=new FormData();
 form.append('archive',new File([bytes],'letterboxd-demo-user-2026-10-20-08-15-utc.zip',{type:'application/zip'}));
 const packed=new Request('https://encode.test/',{method:'POST',body:form});
 const encoded=new Uint8Array(await packed.arrayBuffer());
 const req=new Request(ORIGIN+'/api/admin/letterboxd-archive/preview',{method:'POST',headers:{'Content-Type':packed.headers.get('content-type'),'Content-Length':String(encoded.byteLength),Origin:ORIGIN},body:encoded});
 const r=await worker.fetch(req,{BUCKET:bucket,...env},{waitUntil(){}});
 return {status:r.status,body:await r.json()};
}

{
 seedAdmin();
 reads.length=0;
 const r=await ask('/api/admin/overview',{DB:standin(database('prepared'),'prepared')});
 assert.equal(r.status,503,'prepared is not served (ADR 0162)');
 assert.ok(!reads.includes('titles.json')&&!reads.includes('people.json'),'prepared reads no frozen mirror');
}

{
 seedAdmin();
 const r=await ask('/api/admin/overview',{DB:standin(database('open'),'open')});
 assert.equal(r.status,200,JSON.stringify(r.body).slice(0,400));
 assert.ok(!reads.includes('titles.json'),'open does not read frozen titles.json');
 assert.ok(!reads.includes('people.json'),'open does not read frozen people.json');
 assert.equal(r.body.snapshot.skew,false,'D1 dictionaries are generation-pinned, not timestamp_missing');
 assert.deepEqual(r.body.snapshot.skewReasons,[]);
}

{
 seedAdmin();
 const r=await ask('/api/admin/people/person%3Aactor%2Fmira-sol',{DB:standin(database('open'),'open')});
 assert.equal(r.status,200,JSON.stringify(r.body).slice(0,400));
 assert.equal(r.body.item.localization.status,'reviewed','D1 reviewed Person is not downgraded to provisional');
 assert.equal(r.body.item.localization.value,'Мира D1');
}

{
 seedAdmin();
 const r=await ask('/api/admin/overview',{DB:standin(database('held'),'held')});
 assert.equal(r.status,503);
 assert.equal(r.body.reason,'film_person_held');
 assert.ok(!reads.includes('titles.json'));
}

{
 seedAdmin();
 const r=await ask('/api/admin/overview',{DB:standin(database('unknown-read'),'unknown-read')});
 assert.equal(r.status,503);
 assert.equal(r.body.reason,'film_person_unavailable');
}

{
 const file=database('open');seedAdmin();
 let gates=0;
 const env={BUCKET:bucket,DB:standin(file,'open',{onQuery:async text=>{if(/FROM film_person_authority/.test(text)){gates++;if(gates===4)sqlite(file,TO_HELD);}}})};
 const r=await ask('/api/admin/overview',env);
 assert.equal(r.status,503,'open admin rechecks the marker before a 200');
 assert.equal(r.body.reason,'film_person_generation_moved');
}

{
 seedAdmin();
 const r=await ask('/api/admin/health',{DB:standin(database('open'),'open')});
 assert.equal(r.status,200,JSON.stringify(r.body).slice(0,400));
 assert.ok(!reads.includes('titles.json'));
 assert.ok(Array.isArray(r.body.reads)&&r.body.reads.includes('film_dimension'));
 assert.equal(r.body.snapshot.skew,false);
}

{
 seedAdmin();
 const r=await ask('/api/admin/health',{DB:standin(database('held'),'held')});
 assert.equal(r.status,503);
 assert.equal(r.body.reason,'film_person_held');
}

{
 seedAdmin();
 const r=await ask('/api/admin/limbo',{DB:standin(database('open'),'open')});
 assert.equal(r.status,200,JSON.stringify(r.body).slice(0,400));
 assert.ok(!reads.includes('titles.json'),'open limbo does not read frozen titles.json');
 assert.ok(!reads.includes('people.json'));
 assert.equal(r.body.snapshot.skew,false);
}

{
 seedAdmin();
 const r=await ask('/api/admin/limbo',{DB:standin(database('held'),'held')});
 assert.equal(r.status,503);
 assert.equal(r.body.reason,'film_person_held');
}

{
 seedAdmin();
 const r=await preview({DB:standin(database('open'),'open')},[{code:'h95',name:'Heat',year:1995,watched:true,watchedDate:'2026-01-01'}]);
 assert.equal(r.status,200,JSON.stringify(r.body).slice(0,500));
 assert.ok(!reads.includes('metadata.json'),'open archive preview does not read frozen metadata.json');
 assert.equal(r.body.matching.byStatus.accepted,1,'English archive title matches D1 original, not only the Russian localization');
 assert.equal(r.body.matching.byStatus.conflict||0,0);
 assert.equal(r.body.matching.reasons?.stored_title_differs,undefined);
}

{
 seedAdmin();
 const r=await preview({DB:standin(database('held'),'held')},[{code:'h95',name:'Heat',year:1995,watched:true,watchedDate:'2026-01-01'}]);
 assert.equal(r.status,503);
 assert.equal(r.body.reason,'film_person_held');
 assert.ok(!reads.includes('metadata.json'));
}

{
 const file=database('open');seedAdmin();
 let gates=0;
 const env={DB:standin(file,'open',{onQuery:async text=>{if(/FROM film_person_authority/.test(text)){gates++;if(gates===6)sqlite(file,TO_HELD);}}})};
 const r=await preview(env,[{code:'h95',name:'Heat',year:1995,watched:true,watchedDate:'2026-01-01'}]);
 assert.equal(r.status,503,'preview rechecks the marker after lbaAttachBatches');
 assert.equal(r.body.reason,'film_person_generation_moved');
}

{
 const reader=await import('../src/canonical-catalog-reader.js');
 const env={DB:standin(database('open'),'open')};
 const names=await reader.catalogPeopleFromD1(env,['actor/mira-sol'],await reader.catalogReaderGate(env));
 assert.equal(names['actor/mira-sol'].name,'Мира D1');
 assert.equal(names['actor/mira-sol'].status,'reviewed');
 assert.equal(names.missing,undefined);
 const heat=await reader.catalogMetadataFromD1(env,['h95'],await reader.catalogReaderGate(env));
 assert.equal(heat.h95.title,'Жара');
 assert.equal(heat.h95.original,'Heat');
}

console.log('canonical-admin-dictionaries: admin snapshot/health/limbo/archive refuse prepared (ADR 0162), read bounded D1 at open, STOP on held/unreadable/generation move, and preserve original title, reviewed Person names and D1 skew');
