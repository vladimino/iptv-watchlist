// AIR-374 P4b / ADR 0099, owner decisions 3 and 4 (11 Nov 2026): the marker-gated, fail-closed titles.json consumers GET /api/programme and GET /api/watchlist and their one bundled D1
// helper (catalogTitlesFromD1, catalogReaderStill in src/canonical-catalog-reader.js) on the real migration chain over the sqlite3-CLI D1 stand-in, through the Worker's own routes (vm-scoped).
// Marker states: legacy, r2, prepared, open, held, unknown (malformed row, missing companion table, failed read). Nothing here touches Cloudflare, R2 or production.
// CATALOG_TITLES_READER_FILE / CATALOG_TITLES_WORKER_FILE point the test at a mutant copy (tests/canonical-catalog-titles-mutation.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const READER_FILE=process.env.CATALOG_TITLES_READER_FILE||'src/canonical-catalog-reader.js',WORKER_FILE=process.env.CATALOG_TITLES_WORKER_FILE||'src/worker.js';
// The mutation check sets CATALOG_TITLES_ONLY=mutant: the byte-identity sweep (1) and the registry scan (6) are skipped there, they exercise no mutated guard.
const ONLY=process.env.CATALOG_TITLES_ONLY||'';
const IMPORT='const {database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-canonical-titles-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const TO_OPEN="UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;",TO_HELD="UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;",TO_REOPEN="UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1;";
const MARKER={r2:'',prepared:VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;"};
MARKER.open=MARKER.prepared+TO_OPEN;MARKER.held=MARKER.open+TO_HELD;
const T='2026-11-07T10:00:00.000Z';
// The Films: lid-spelled, tmdb-spelled, numeric tmdbId, a tmdb mismatch, a reviewed row (not a provisional title), a row without a trusted tmdb claim, a Film D1 does not hold.
const FILMS=[
 {id:'zzlid1',tmdbId:'4101',title:'Original One',original:'Original One',year:2020},
 {id:'tmdb_4102',tmdbId:'4102',title:'Original Two',original:'Original Two',year:2021},
 {id:'zznum5',tmdbId:4105,title:'Original Five',original:'Original Five',year:2019},
 {id:'zzmis4',tmdbId:'4104',title:'Original Four',original:'Original Four',year:2018},
 {id:'zzrev6',tmdbId:'4106',title:'Original Six',original:'Original Six',year:2017},
 {id:'zzuntr7',tmdbId:'4107',title:'Original Seven',original:'Original Seven',year:2016},
 {id:'zznone8',tmdbId:'4108',title:'Original Eight',original:'Original Eight',year:2015},
 {id:'zzdim9',tmdbId:'4109',title:'Original Nine',original:'Original Nine',year:2014},
 {id:'zzconf12',tmdbId:'4112',title:'Original Twelve',original:'Original Twelve',year:2013},
 {id:'tmdb_4110',tmdbId:'4110',title:'Original Ten',original:'Original Ten',year:2012},
 {id:'zzwl13',tmdbId:'4113',title:'Original Thirteen',original:'Original Thirteen',year:2011},
];
const WATCHLIST_ONLY=new Set(['zzwl13']);
// [document id, D1 film id, localization status, value, sources, tmdb claim in D1, claim trusted, claim conflicting, dimension]
const ROWS=[
 ['zzlid1','film:zzlid1','provisional','Один','["https://www.wikidata.org/wiki/Q1"]','4101'],
 ['tmdb_4102','film:tmdb:4102','provisional','Два','null','4102'],
 ['zznum5','film:zznum5','provisional','Пять','["s5"]','4105'],
 ['zzmis4','film:zzmis4','provisional','Четыре','["s4"]','9999'],
 ['zzrev6','film:zzrev6','reviewed','Шесть','["s6"]','4106'],
 ['zzuntr7','film:zzuntr7','provisional','Семь','["s7"]','4107',0,0],
 // a provisional value in another dimension is not a title; a trusted but conflicting claim is no claim; both spellings of one Film: the id's own spelling wins
 ['zzdim9','film:zzdim9','provisional','Девять','["s9"]','4109',1,0,'identity'],
 ['zzconf12','film:zzconf12','provisional','Двенадцать','["s12"]','4112',1,1],
 ['tmdb_4110','film:tmdb_4110','provisional','Десять свой','["s10"]',null],
 ['tmdb_4110','film:tmdb:4110','provisional','Десять tmdb','["s10b"]','4110'],
 ['zzwl13','film:zzwl13','provisional','Тринадцать','["s13"]','4113'],
];
const trustedClaim=row=>row[5]&&(row[6]??1)===1&&(row[7]??0)===0;
const seedSql=()=>{
 const out=[];
 for(const [doc,id] of ROWS){const f=FILMS.find(x=>x.id===doc);out.push(`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('${id}',1,NULL,'${f.original}','${T}');`);}
 for(const [,id,status,value,sources,tmdb,trusted=1,conflicting=0,dimension='localization'] of ROWS){
  const prov=JSON.stringify({value,sources:JSON.parse(sources)}).replace(/'/g,"''");
  out.push(`INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,updated_at) VALUES ('${id}','${dimension}','${status}','wikidata','provisional','${prov}','${value}',NULL,'${T}');`);
  if(tmdb)out.push(`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('${id}','tmdb','${tmdb}',${trusted},${conflicting},NULL);`);
 }
 return out.join('\n');
};
// The R2 titles.json that holds exactly the rows D1 holds (the projector's source), as the Worker's R2 path reads it.
const titlesJson=()=>{const out={};for(const row of ROWS){const [id,film,status,value,sources,tmdb,,,dimension='localization']=row;if(status!=='provisional'||dimension!=='localization'||id==='tmdb_4110')continue;out[id]={title:value,...(trustedClaim(row)?{tmdbId:typeof FILMS.find(f=>f.id===id).tmdbId==='number'?Number(tmdb):tmdb}:{}),status:'provisional',sources:JSON.parse(sources)};}return out;};

let n=0;const BASE=new Map();
function database(state){
 const file=path.join(root,'t-'+(n++)+'.sqlite');
 const upTo=state==='legacy'?names.findIndex(name=>name.startsWith('0013')):names.length;
 if(!BASE.has(upTo)){const shared=process.env.CANONICAL_CATALOG_BASE_DIR,base=path.join(shared||root,'base-titles-'+upTo+'.sqlite');if(!(shared&&fs.existsSync(base)))sqlite(base,names.slice(0,upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));BASE.set(upTo,base);}
 fs.copyFileSync(BASE.get(upTo),file);
 sqlite(file,seedSql());
 if(state==='unknown-row'){sqlite(file,MARKER.prepared);sqlite(file,'DROP TRIGGER film_person_authority_no_delete;DELETE FROM film_person_authority;');}
 else if(state==='unknown-table')sqlite(file,'DROP TABLE film_person_cas;');
 else if(MARKER[state])sqlite(file,MARKER[state]);
 return file;
}
const standin=(file,state,extra={})=>d1Standin(file,{...extra,...(state==='unknown-read'?{rewrite:sql=>/FROM film_person_authority/.test(sql)?'SELECT nope FROM nowhere':sql}:{})});

// ---- the Worker routes (vm-scoped; the reader is the bundled copy) ----
const G1='22222222-2222-4222-8222-222222222222';
const records=new Map(),reads=[];let onR2=null;
const bucket={
 async get(key){reads.push(key);if(onR2)await onR2(key);return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key)),text:async()=>JSON.stringify(records.get(key))}:null;},
 async put(){throw new Error('no R2 write from a GET');},
 async list(){return {objects:[],truncated:false};}
};
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},fetch:async()=>new Response('unexpected',{status:599})});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ctx);
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);vm.runInContext(scopedReplacing(READER_FILE,'CanonicalCatalogReader',IMPORT),ctx);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),ctx);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/migration-export.js','src/filter-presets.js',WORKER_FILE])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const worker=ctx.worker;
function seed(films=FILMS,titles=titlesJson()){
 records.clear();reads.length=0;onR2=null;
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:G1});
 const programme=films.filter(f=>!WATCHLIST_ONLY.has(f.id));
 for(const key of ['programme.json','epg/generations/'+G1+'/programme.json'])records.set(key,{runId:G1,updatedAt:T,watchlistCount:films.length,films:structuredClone(programme),stats:{}});
 records.set('watchlist.json',{updatedAt:T,films:structuredClone(films)});
 records.set('titles.json',titles);
}
const ask=async(route,env)=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev'+route),{BUCKET:bucket,...env},{waitUntil(){}});return {status:r.status,text:await r.text()};};
const ROUTES=['/api/programme','/api/watchlist'];
const parse=r=>JSON.parse(r.text);
const REFUSAL={held:'film_person_held','unknown-row':'film_person_unavailable','unknown-table':'film_person_unavailable','unknown-read':'film_person_unavailable'};

// 1. Existing runtime: legacy, r2 and prepared are byte-identical to each other and to an environment with no database at all; the R2 mirror is read.
if(ONLY!=='mutant'){
 seed();
 const base={};for(const route of ROUTES){seed();base[route]=await ask(route,{});assert.equal(base[route].status,200,route);assert.ok(reads.includes('titles.json'),route+' reads the R2 mirror with no database');}
 const shown=parse(base['/api/watchlist']).films;
 assert.equal(shown.find(f=>f.id==='zzlid1').title,'Один','the cached title is applied');
 assert.equal(shown.find(f=>f.id==='zzmis4').title,'Original Four','a tmdb mismatch is not applied');
 for(const state of ['legacy','r2','prepared'])for(const route of ROUTES){
  seed();const r=await ask(route,{DB:standin(database(state),state)});
  assert.deepEqual(r,base[route],state+' '+route+' is byte-identical to the unchanged runtime');assert.ok(reads.includes('titles.json'),state+' reads the R2 mirror');
 }
}

// 2. The same data at `open` from D1: equal to the R2 answer, and the frozen mirror is never read. Named differences: none on this fixture.
{
 for(const route of ROUTES){
  seed();const r2=await ask(route,{DB:standin(database('r2'),'r2')});
  seed();const open=await ask(route,{DB:standin(database('open'),'open')});
  assert.equal(open.status,200,route);
  assert.deepEqual(parse(open),parse(r2),route+': D1 at open equals the R2 path at the same data');
  assert.equal(open.text,r2.text,route+': and byte for byte');
  assert.ok(!reads.includes('titles.json'),route+': the frozen mirror titles.json is not read at open');
  assert.ok(reads.some(key=>key.includes('watchlist.json')||key.includes('programme.json')),route+': the independent EPG mirrors stay R2');
 }
 seed();const open=await ask('/api/programme',{DB:standin(database('open'),'open')});
 const films=parse(open).films;
 assert.equal(films.find(f=>f.id==='zzlid1').title,'Один');
 assert.equal(films.find(f=>f.id==='tmdb_4102').title,'Два','a tmdb-spelled Film resolves');
 assert.equal(films.find(f=>f.id==='zznum5').title,'Пять','a numeric document tmdbId matches the numeric-typed claim');
 assert.equal(films.find(f=>f.id==='zzmis4').title,'Original Four','a tmdb mismatch is not applied');
 assert.equal(films.find(f=>f.id==='zzrev6').title,'Original Six','a reviewed row is not a provisional cache title');
 assert.equal(films.find(f=>f.id==='zzuntr7').title,'Original Seven','no trusted tmdb claim, no applied title');
 assert.equal(films.find(f=>f.id==='zznone8').title,'Original Eight','a Film D1 does not hold');
 assert.equal(films.find(f=>f.id==='zzdim9').title,'Original Nine','a provisional value of another dimension is not a title');
 assert.equal(films.find(f=>f.id==='zzconf12').title,'Original Twelve','a conflicting claim is no claim');
 assert.equal(films.find(f=>f.id==='tmdb_4110').title,'Original Ten','the id\'s own spelling wins over the tmdb spelling');
 assert.equal(films.find(f=>f.id==='zzwl13').title,'Тринадцать','a watchlist-only Film is resolved on the programme route');
}

// 3. held and unknown: a typed 503 before any R2 read (nothing silently served from R2).
for(const state of ['held','unknown-row','unknown-table','unknown-read'])for(const route of ROUTES){
 seed();const r=await ask(route,{DB:standin(database(state),state)});
 assert.equal(r.status,503,state+' '+route);
 assert.deepEqual(parse(r),{error:'storage_unavailable',reason:REFUSAL[state]},state+' '+route);
 assert.deepEqual(reads,[],state+' '+route+': no R2 object is touched');
}

// 4. The marker moves mid-read. prepared -> open (and r2 -> prepared) between the gate and the end of the R2 reads is a 503, never a stale R2 answer; open -> held and a
// held-then-reopened generation also refuse (the generation is compared, not only the state).
for(const route of ROUTES){
 {const file=database('prepared');seed();onR2=async key=>{if(key==='titles.json')sqlite(file,TO_OPEN);};
  const r=await ask(route,{DB:standin(file,'prepared')});assert.equal(r.status,503,route+' prepared->open');assert.deepEqual(parse(r),{error:'storage_unavailable',reason:'film_person_generation_moved'},route);}
 {const file=database('r2');seed();onR2=async key=>{if(key==='titles.json')sqlite(file,MARKER.prepared);};
  const r=await ask(route,{DB:standin(file,'r2')});assert.equal(r.status,503,route+' r2->prepared');assert.equal(parse(r).reason,'film_person_generation_moved');}
 {const file=database('open');seed();let flipped=false;
  const r=await ask(route,{DB:standin(file,'open',{onQuery:async text=>{if(!flipped&&/json_each/.test(text)){flipped=true;sqlite(file,TO_HELD);}}})});
  assert.ok(flipped);assert.equal(r.status,503,route+' open->held');assert.equal(parse(r).reason,'film_person_generation_moved');}
 {const file=database('open');seed();let flipped=false;
  const r=await ask(route,{DB:standin(file,'open',{onQuery:async text=>{if(!flipped&&/json_each/.test(text)){flipped=true;sqlite(file,TO_HELD+TO_REOPEN);}}})});
  assert.ok(flipped);assert.equal(r.status,503,route+' held then reopened');assert.equal(parse(r).reason,'film_person_generation_moved','the generation is compared, not only the state');}
}

// 4b. The LAST async boundary. The marker moves while the route awaits the owner-review read or the sync.json read, AFTER the titles were read: still a 503 and never a stale 200,
// on both routes, on the open path and on the legacy/r2/prepared path, whatever the move. The empty watchlist answer (a normal 200 shape) is fenced the same way.
{
 const FLIPS=[['prepared',TO_OPEN],['r2',MARKER.prepared],['open',TO_HELD],['open',TO_HELD+TO_REOPEN]];
 const HOOKS={'/api/programme':['admin/owner-reviews.json','sync.json'],'/api/watchlist':['admin/owner-reviews.json']};
 for(const route of ROUTES)for(const hook of HOOKS[route])for(const [state,sql] of FLIPS){
  const file=database(state);seed();let flipped=false;
  onR2=async key=>{if(key===hook&&!flipped){flipped=true;sqlite(file,sql);}};
  const r=await ask(route,{DB:standin(file,state)});
  assert.ok(flipped,route+' '+hook+' '+state);
  assert.equal(r.status,503,route+' '+hook+' '+state+': no stale 200');
  assert.deepEqual(parse(r),{error:'storage_unavailable',reason:'film_person_generation_moved'},route+' '+hook+' '+state);
 }
 for(const [state,sql] of FLIPS){
  const file=database(state);seed();records.delete('watchlist.json');for(const key of ['programme.json','epg/generations/'+G1+'/programme.json'])records.get(key).watchlistCount=99;
  let flipped=false;onR2=async key=>{if(key.includes('programme.json')&&!flipped){flipped=true;sqlite(file,sql);}};
  const r=await ask('/api/watchlist',{DB:standin(file,state)});
  assert.ok(flipped,'empty '+state);assert.equal(r.status,503,'the empty answer is fenced: '+state);
 }
 {const file=database('r2');seed();records.delete('watchlist.json');for(const key of ['programme.json','epg/generations/'+G1+'/programme.json'])records.get(key).watchlistCount=99;
  const r=await ask('/api/watchlist',{DB:standin(file,'r2')});assert.equal(r.status,200);assert.deepEqual(parse(r),{films:[]},'an unmoved marker answers the empty shape');}
 // The helper's own re-check (a direct call, no route behind it).
 const file=database('open');let flipped=false;
 const reader=vm.runInContext('CanonicalCatalogReader',ctx);
 await assert.rejects(()=>reader.catalogTitlesFromD1({DB:standin(file,'open',{onQuery:async text=>{if(!flipped&&/json_each/.test(text)){flipped=true;sqlite(file,TO_HELD);}}})},FILMS,{mode:'d1',state:'open',generation:2}),error=>error.code==='film_person_generation_moved');
}

// 5. Bounded and SELECT-only: one title statement whatever the size, no batch, no write; the cap fails closed.
{
 const bulk=Array.from({length:300},(_,i)=>({id:'zzbulk'+i,tmdbId:String(5000+i),title:'T'+i,original:'T'+i,year:2000}));
 const file=database('open');
 sqlite(file,bulk.map((f,i)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:${f.id}',1,NULL,'${f.original}','${T}');INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,updated_at) VALUES ('film:${f.id}','localization','provisional','wikidata','provisional','{"sources":null}','Р${i}',NULL,'${T}');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:${f.id}','tmdb','${f.tmdbId}',1,0,NULL);`).join('\n'));
 seed([...FILMS,...bulk]);
 const statements=[],d1=standin(file,'open',{onQuery:text=>{statements.push(text);}});
 const r=await ask('/api/programme',{DB:d1});
 assert.equal(r.status,200);
 assert.equal(parse(r).films.find(f=>f.id==='zzbulk299').title,'Р299');
 assert.equal(statements.filter(text=>/json_each/.test(text)).length,1,'ONE title statement for 300+ Films');
 assert.ok(statements.every(text=>/^\s*(SELECT|WITH)/i.test(text)),'SELECT only');
 assert.equal(d1.calls.batches,0,'no batch');
 assert.ok(statements.length<=20,'a bounded number of statements per request: '+statements.length);
 // The real catalogue is far above one statement: more than one chunk of ids is several bounded statements, a row in the LAST chunk is still found, and the answer equals the R2 path.
 {
  const CH=vm.runInContext('CanonicalCatalogReader',ctx).TITLE_READ_CHUNK;
  const filler=Array.from({length:CH+200},(_,i)=>({id:'zzc'+i,tmdbId:String(70000+i),title:'C'+i,original:'C'+i,year:2000}));
  const last=filler.at(-1),first=filler[0],big=database('open');
  sqlite(big,[first,last].map((f,i)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:${f.id}',1,NULL,'${f.original}','${T}');INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,updated_at) VALUES ('film:${f.id}','localization','provisional','wikidata','provisional','{"sources":null}','Ч${i}',NULL,'${T}');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:${f.id}','tmdb','${f.tmdbId}',1,0,NULL);`).join('\n'));
  const titles={...titlesJson(),[first.id]:{title:'Ч0',tmdbId:first.tmdbId,status:'provisional',sources:null},[last.id]:{title:'Ч1',tmdbId:last.tmdbId,status:'provisional',sources:null}};
  seed([...FILMS,...filler],titles);
  const seen=[];const open=await ask('/api/watchlist',{DB:standin(big,'open',{onQuery:text=>{seen.push(text);}})});
  assert.equal(open.status,200);assert.ok(!reads.includes('titles.json'));
  assert.ok(seen.filter(text=>/json_each/.test(text)).length>=2,'more than one bounded statement for the real catalogue size');
  assert.equal(parse(open).films.find(f=>f.id===last.id).title,'Ч1','a row in the last chunk is found');
  seed([...FILMS,...filler],titles);const r2=await ask('/api/watchlist',{DB:standin(database('r2'),'r2')});
  seed([...FILMS,...filler],titles);const again=await ask('/api/watchlist',{DB:standin(big,'open')});
  assert.equal(JSON.stringify(parse(again).films.map(f=>f.title).slice(-3)),JSON.stringify(parse(r2).films.map(f=>f.title).slice(-3)));
 }
 const reader=vm.runInContext('CanonicalCatalogReader',ctx),gate={mode:'d1',state:'open',generation:2},MAX=reader.TITLE_READ_MAX_FILMS;
 await assert.rejects(()=>reader.catalogTitlesFromD1({DB:standin(file,'open')},Array.from({length:MAX+1},(_,i)=>({id:'x'+i})),gate),error=>error.code==='canonical_read_unavailable','above the cap: closed, not partial');
 assert.deepEqual({...await reader.catalogTitlesFromD1({DB:standin(file,'open')},Array.from({length:MAX},(_,i)=>({id:'x'+i})),gate)},{},'at the cap: answered');
 await assert.rejects(()=>reader.catalogTitlesFromD1({DB:standin(file,'open')},FILMS,{mode:'existing',state:'prepared',generation:1}),error=>error.code==='canonical_read_not_authoritative','only an open gate reads D1');
 await assert.rejects(()=>reader.catalogTitlesFromD1({DB:{prepare(){throw new Error('d1 down');}}},FILMS,gate),error=>error.code==='canonical_read_unavailable','a failing read is closed');
 // A failing title statement at open is a typed 503 through the route, not an R2 answer.
 seed();const down=await ask('/api/watchlist',{DB:standin(file,'open',{rewrite:sql=>/json_each/.test(sql)?'SELECT nope FROM nowhere':sql})});
 assert.equal(down.status,503);assert.equal(parse(down).reason,'canonical_read_unavailable');assert.ok(!reads.includes('titles.json'));
 // An unreadable stored provenance is a closed read too, never a title without sources.
 const bad=database('open');sqlite(bad,"UPDATE film_dimension SET provenance_json='{bad' WHERE film_id='film:zzlid1';");
 seed();const broken=await ask('/api/watchlist',{DB:standin(bad,'open')});
 assert.equal(broken.status,503);assert.equal(parse(broken).reason,'canonical_read_unavailable');
}

// 6. The remaining-readers registry: simple and stable shape, and every runtime source file that names a mirror is accounted for.
if(ONLY!=='mutant'){
 const registry=vm.runInContext('CanonicalCatalogReader',ctx).CANONICAL_READER_REGISTRY;
 assert.ok(Array.isArray(registry)&&registry.length>0);
 for(const entry of registry){assert.deepEqual(Object.keys(entry).sort(),['class','file','moved','name']);assert.ok(['freeze','exception'].includes(entry.class),entry.name);assert.equal(typeof entry.moved,'boolean');assert.ok(fs.existsSync(entry.file),entry.file);}
 const moved=registry.filter(entry=>entry.moved).map(entry=>entry.name);
 for(const name of ['GET /api/programme titles.json','GET /api/watchlist titles.json'])assert.ok(moved.includes(name),name);
 assert.ok(registry.filter(entry=>entry.class==='exception').every(entry=>!entry.moved),'an exception is never "moved"');
 const accounted=new Set(registry.map(entry=>entry.file));
 // Not runtime readers of a mirror: the importer, backfill and diagnostic code, a text label, and the reader itself.
 const OTHER=new Set(['src/offline-importer.js','src/enrichment-projection.js','src/domain/film-person-backfill.js','src/domain/film-person-reader.js','src/canonical-catalog-reader.js','src/admin/letterboxd-archive-view.js','src/domain/film-person-diagnostics.js']);
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);
 const found=walk('src').filter(file=>file.endsWith('.js')&&/['"`](titles|people|metadata)\.json['"`]/.test(fs.readFileSync(file,'utf8')));
 assert.deepEqual(found.filter(file=>!accounted.has(file)&&!OTHER.has(file)),[],'a source file names a mirror but is neither in the registry nor a documented non-reader');
 // The routes use the gate for both consumers; the bundle carries the module.
 const text=fs.readFileSync('src/worker.js','utf8');
 assert.equal((text.match(/await localizedTitleStore\(env,pinned,gate,/g)||[]).length,2);
 assert.ok(fs.readFileSync('build.mjs','utf8').includes("scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader'"));
}
fs.rmSync(root,{recursive:true,force:true});
console.log('canonical-catalog-titles: ok');
