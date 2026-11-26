// AIR-374 P4 / ADR 0099, owner decisions 3 and 4 (11 Nov 2026): the marker-gated, fail-closed Film/Person catalog readers (src/canonical-catalog-reader.js, the /api/d1/* gate in
// src/catalog-d1.js) on the real migration chain over the sqlite3-CLI D1 stand-in. Marker states: legacy (contract below 13), r2, prepared, open, held, unknown (malformed row, missing
// companion table, failed read). The film-route fallback in the Worker is covered by tests/catalog-film.mjs. Nothing here touches the Worker's R2, Cloudflare or production.
// CANONICAL_CATALOG_READER_MODULE (a file URL) points the whole test at a mutant copy of the reader (tests/canonical-catalog-reader-mutation.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {scoped,scopedReplacing,scopePersonIdentity} from '../scripts/bundle-scope.mjs';
import {readAdmissions as readerAdmissions} from '../src/canonical-catalog-reader.js';
import {readAdmissions,loadAdmissionRows,ADMISSION_READ_CHUNK} from '../src/film-admission.js';
import {canonicalReaderMode} from '../src/canonical-read-model.js';
import {sqliteSync} from './sqlite-session.mjs';

const MODULE=process.env.CANONICAL_CATALOG_READER_MODULE;
// The mutation check points ONE target at the part of this file that exercises it (reader: sections 1 and 2; route: section 3); unset runs everything.
const ONLY=process.env.CANONICAL_CATALOG_READER_ONLY||'';
const reader=await import(MODULE||'../src/canonical-catalog-reader.js');
const READER_FILE=MODULE?fileURLToPath(MODULE):'src/canonical-catalog-reader.js';
const D1_FILE=process.env.CATALOG_D1_MODULE?fileURLToPath(process.env.CATALOG_D1_MODULE):'src/catalog-d1.js';
const IMPORT='const {database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-canonical-catalog-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const MARKER={r2:'',prepared:VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;"};
MARKER.open=MARKER.prepared+"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";
MARKER.held=MARKER.open+"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;";
let n=0;const BASE=new Map();
function database(state){
 const file=path.join(root,'cr-'+(n++)+'.sqlite');
 const upTo=state==='legacy'?names.findIndex(name=>name.startsWith('0013')):names.length;
 // The migration chain is replayed once per chain length; every fixture is a copy of that file (the chain is the slow part, not the marker moves).
 if(!BASE.has(upTo)){const shared=process.env.CANONICAL_CATALOG_BASE_DIR,base=path.join(shared||root,'base-'+upTo+'.sqlite');if(!(shared&&fs.existsSync(base)))sqlite(base,names.slice(0,upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));BASE.set(upTo,base);}
 fs.copyFileSync(BASE.get(upTo),file);
 if(state==='unknown-row'){sqlite(file,MARKER.prepared);sqlite(file,'DROP TRIGGER film_person_authority_no_delete;DELETE FROM film_person_authority;');}
 else if(state==='unknown-table')sqlite(file,'DROP TABLE film_person_cas;');
 else if(MARKER[state])sqlite(file,MARKER[state]);
 return file;
}
const STATES=['legacy','r2','prepared','open','held','unknown-row','unknown-table','unknown-read'];
const standin=(file,state,extra={})=>d1Standin(file,{...extra,...(state==='unknown-read'?{rewrite:sql=>/FROM film_person_authority/.test(sql)?'SELECT nope FROM nowhere':sql}:{})});
const code=expected=>error=>error.code===expected;
const refusal=state=>state==='held'?'film_person_held':'film_person_unavailable';

// 1. The gate (ADR 0162): d1 for open, a typed refusal for held and every other state (legacy, r2, prepared, unknown). Never R2. A not-installed domain is 'existing' only with the explicit stand-in.
if(ONLY!=='route')for(const state of STATES){
 const env={DB:standin(database(state),state)};
 if(state==='open')assert.equal((await reader.catalogReaderGate(env)).mode,'d1',state);
 else await assert.rejects(()=>reader.catalogReaderGate(env),code(refusal(state)),state);
}
if(ONLY!=='route'){
 const local={DB:standin(database('legacy'),'legacy'),FILM_PERSON_DB_OPTIONAL:'standin'};
 assert.equal((await reader.catalogReaderGate(local)).mode,'existing','the explicit local stand-in for a not installed domain');
 for(const state of ['r2','prepared'])await assert.rejects(()=>reader.catalogReaderGate({DB:standin(database(state),state),FILM_PERSON_DB_OPTIONAL:'standin'}),code('film_person_unavailable'),state+' stays refused even with the opt-in');
}
if(ONLY!=='route')assert.equal((await canonicalReaderMode({DB:d1Standin(database('open'))})).mode,'d1','the bulk read model shares the one gate');
if(ONLY!=='route'){
 assert.equal(await reader.canonicalMirrorsWritable({DB:standin(database('legacy'),'legacy'),FILM_PERSON_DB_OPTIONAL:'standin'}),true,'stand-in');
 for(const state of ['legacy','r2','prepared'])assert.equal(await reader.canonicalMirrorsWritable({DB:standin(database(state),state)}),false,state+': frozen mirrors are never written below open');
 assert.equal(await reader.canonicalMirrorsWritable({DB:standin(database('open'),'open')}),false,'open');
 for(const state of ['held','unknown-row','unknown-table','unknown-read'])assert.equal(await reader.canonicalMirrorsWritable({DB:standin(database(state),state)}),false,state);
 const file=database('open'),env={DB:d1Standin(file)};
 const stored={titles:1,people:1};
 const write=async(key)=>{if(!(await reader.canonicalMirrorsWritable(env)))return false;stored[key]=(stored[key]||0)+1;return true;};
 assert.equal(await write('titles'),false,'open skips titles.json');
 assert.equal(await write('people'),false,'open skips people.json');
 assert.deepEqual(stored,{titles:1,people:1});
 sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 assert.equal(await write('titles'),false,'held skips');
 const cutover=database('legacy'),cutoverEnv={DB:d1Standin(cutover),FILM_PERSON_DB_OPTIONAL:'standin'};
 assert.equal(await reader.canonicalMirrorsWritable(cutoverEnv),true,'the local stand-in may write the frozen mirrors');
 const inner=d1Standin(database('legacy'));
 const windowFail={prepare(sql){if(/FROM projector_window/.test(sql))throw new Error('D1 timeout');return inner.prepare(sql);}};
 assert.equal(await reader.canonicalMirrorsWritable({DB:windowFail,FILM_PERSON_DB_OPTIONAL:'standin'}),false,'unreadable projector_window is not permission to write');
 {
  const worker=fs.readFileSync('src/worker.js','utf8');
  const freeze=worker.slice(worker.indexOf('async function frozenCanonicalMirrorsLocked'),worker.indexOf('async function localizedTitleStore'));
  const save=worker.slice(worker.indexOf('async function epgStepGuard'),worker.indexOf('function confirmedHalfStar'));
  const puts=[];
  const env={
   epgStep:true,
   DB:windowFail,
   BUCKET:{put:async(name)=>{puts.push(name);return {etag:'e'};}},
  };
  const context=vm.createContext({env,CanonicalCatalogReader:{canonicalMirrorsWritable:reader.canonicalMirrorsWritable},EpgOrchestration:{assertStep:async()=>{}},JSON,undefined});
  vm.runInContext(freeze+'\n'+save+'\nthis.saveJSON=saveJSON;',context);
  const result=await vm.runInContext('saveJSON(env,"titles.json",{ok:true})',context);
  assert.equal(result.skipped,'canonical_mirror_frozen');
  assert.deepEqual(puts,[],'unreadable exclusive window: zero BUCKET.put');
 }
}

// 2. The D1 fallback reader: only at open; every other state refuses before a catalog statement. There is no R2 handle in this environment at all.
if(ONLY!=='route'){
 const SHA='a'.repeat(64),T='2026-11-07T10:00:00.000Z',RK='letterboxd/admissions/verified-films.json';
 const film=id=>`('film:tmdb:${id}',1,'tmdb:${id}','Orig','${T}')`;
 const claimed=[304,305,306,307];
 const seed=`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ${[300,301,302,303,...claimed].map(film).join(',')};
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ${[300,301,302,303].map(id=>`('film:tmdb:${id}','tmdb','${id}',1,0,NULL)`).join(',')},('film:tmdb:300','tmdb','999',0,1,NULL),('film:tmdb:304','tmdb','304',0,0,NULL),('film:tmdb:305','tmdb','305',1,1,NULL),('film:tmdb:306','tmdb','306',1,0,NULL);
INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:300','300','sc300','${SHA}','D1 title',2001,'${RK}','tmdb_300','2026-11-01T09:00:00.000Z','r','${T}'),('film:tmdb:301','301','sc301','${SHA}',NULL,NULL,'${RK}','tmdb_301','2026-11-01T09:00:00.000Z','r','${T}'),('film:tmdb:306','307','sc307','${SHA}',NULL,NULL,'${RK}','tmdb_307','2026-11-01T09:00:00.000Z','r','${T}');
INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:303','film:tmdb:300','${T}');`;
 const file=database('open');sqlite(file,seed);
 sqlite(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other-308',1,'tmdb:999','Other','${T}');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:other-308','tmdb','308',1,0,NULL);`);
 const env={DB:d1Standin(file)};
 const ask=(tmdb,e=env)=>reader.catalogCanonicalFilmFromD1(e,tmdb);
 let r=await ask('300');assert.equal(r.state,'found');assert.deepEqual([r.film.id,r.film.title,r.film.year,r.film.shows.length],['tmdb_300','D1 title',2001,0]);
 r=await ask('301');assert.deepEqual([r.state,r.film.title,r.film.year],['found','Orig',null],'a title-less admission is still a Film, titled by the canonical original title');
 assert.equal((await ask('999')).state,'conflict','a conflicting claim of the typed id holds the identity');
 r=await ask('302');assert.deepEqual([r.state,r.film.id,r.film.title,r.film.original,r.film.year,r.film.shows.length],['found','tmdb_302','Orig','Orig',null,0],'AIR-475: a retained canonical Film with no admission row is a Film');
 assert.equal((await ask('12345')).state,'absent','no Film at all');
 assert.equal((await ask('308')).state,'conflict','AIR-475: a Film recording another canonical identity than its claim is never served');
 assert.equal((await ask('304')).state,'conflict','an untrusted claim is not the owner');
 assert.equal((await ask('305')).state,'conflict','a trusted but conflicting claim is not the owner');
 await assert.rejects(()=>ask('306'),code('canonical_read_unavailable'),'an admission row that names another tmdb id fails closed');
 assert.equal((await ask('303')).state,'retired','a redirect source');
 const decision=(request,kind,supersedes)=>`INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq,payload_json,recorded_at) VALUES ('${request}','film:tmdb:301','${kind}','abc','301','555','{}','{"by":"owner","at":"${T}","source":"t"}','owner_request',NULL,${supersedes},'{}','${T}');`;
 sqlite(file,decision('q1','retire','NULL'));
 assert.equal((await ask('301')).state,'retired','an unsuperseded retire decision retires the movie id');
 sqlite(file,decision('q2','restore','1'));
 assert.equal((await ask('301')).state,'found','an explicit restore lifts it');
 {
  // AIR-656: alias fallback, deterministic choice, omission, and a >200-credit cast that stays readable (partial, never refused).
  const big=database('open');
  const people=[['loc','Localized'],['alias-only',null],['two-alias',null],['none',null]];
  sqlite(big,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:400',1,'tmdb:400','Cast','${T}');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:400','tmdb','400',1,0,NULL);`);
  const ins=people.map(([k])=>`INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:actor/${k}','actor/${k}',1,'${T}');`).join('')
   +`INSERT INTO person_dimension (person_id,dimension,status,value,updated_at) VALUES ('person:actor/loc','localization','provisional','Localized','${T}');`
   +`INSERT INTO person_alias VALUES ('person:actor/loc','name','Zed Alias',NULL),('person:actor/alias-only','name','Only Alias',NULL),('person:actor/two-alias','name','Zeta',NULL),('person:actor/two-alias','name','Alpha',NULL);`
   +`INSERT INTO film_person_credit VALUES ${people.map(([k],i)=>`('film:tmdb:400','person:actor/${k}','actor',${i})`).join(',')};`;
  sqlite(big,ins);
  let r=await reader.catalogCanonicalFilmFromD1({DB:d1Standin(big)},'400');
  assert.deepEqual(r.film.actors.map(a=>a.name),['Localized','Only Alias','Alpha'],'localized wins, alias fallback, deterministic alias, nameless omitted, ordinal order');
  assert.equal(r.film.creditsPartial,undefined);
  const many=Array.from({length:260},(_,i)=>i);
  sqlite(big,many.map(i=>`INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:actor/b${i}','actor/b${i}',1,'${T}');INSERT INTO person_alias VALUES ('person:actor/b${i}','name','B ${i}',NULL);INSERT INTO film_person_credit VALUES ('film:tmdb:400','person:actor/b${i}','actor',${100+i});`).join('')+"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:director/d','director/d',1,'"+T+"');INSERT INTO person_alias VALUES ('person:director/d','name','The Director',NULL);INSERT INTO film_person_credit VALUES ('film:tmdb:400','person:director/d','director',0);");
  r=await reader.catalogCanonicalFilmFromD1({DB:d1Standin(big)},'400');
  assert.equal(r.state,'found','more than 200 credits is not a whole-film refusal');
  assert.equal(r.film.creditsPartial,true,'honest partial completeness');
  assert.deepEqual(r.film.directors.map(d=>d.name),['The Director'],'directors survive truncation');
  assert.equal(r.film.actors.length,198,'199 actor slots, one nameless omitted');
 }
 for(const bad of ['0','abc','1.5','007',301,null,'1234567890123'])await assert.rejects(()=>ask(bad),code('canonical_read_invalid'),'typed id only: '+String(bad));
 for(const state of STATES.filter(state=>state!=='open')){
  const seen=[],other={DB:standin(database(state),state,{onQuery:async text=>{seen.push(text);}})};
  const expected=refusal(state);
  await assert.rejects(()=>ask('300',other),code(expected),state+' refuses');
  assert.ok(seen.every(text=>!/film_rated_admission|film_external_id|tmdb_retirement_decision|film_redirect/.test(text)),state+' reads no catalog table');
 }
 {
  const moving=database('open');sqlite(moving,seed);let moved=false;
  const e={DB:d1Standin(moving,{onQuery:async text=>{if(!moved&&/FROM film_rated_admission/.test(text)){moved=true;sqlite(moving,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");}}})};
  await assert.rejects(()=>ask('300',e),code('film_person_generation_moved'),'a marker that moves during the read refuses the answer');
 }
 {
  // held and back to open within one read: the state is open again but the generation moved, so the answer is still refused
  const moving=database('open');sqlite(moving,seed);let moved=false;
  const e={DB:d1Standin(moving,{onQuery:async text=>{if(!moved&&/FROM film_rated_admission/.test(text)){moved=true;sqlite(moving,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1");}}})};
  await assert.rejects(()=>ask('300',e),code('film_person_generation_moved'),'a held-and-reopened marker (new generation) refuses the answer');
 }
 {
  // a failed admission read keeps its own typed code; a failed identity read is canonical_read_unavailable
  const e1={DB:d1Standin(file,{rewrite:sql=>/FROM film_rated_admission/.test(sql)?'SELECT nope FROM nowhere':sql})};
  await assert.rejects(()=>ask('300',e1),code('admission_unavailable'));
  const e2={DB:d1Standin(file,{rewrite:sql=>/FROM film_external_id/.test(sql)?'SELECT nope FROM nowhere':sql})};
  await assert.rejects(()=>ask('300',e2),code('canonical_read_unavailable'));
 }
 {
  const seen=[],e={DB:d1Standin(file,{onQuery:async text=>{seen.push(text);}})};
  await ask('300',e);await ask('301',e);
  assert.ok(seen.length>0&&seen.every(text=>/^\s*SELECT/i.test(text)),'only SELECT statements');assert.equal(e.DB.calls.batches,0,'no batch');
 }
 assert.equal(readAdmissions,readerAdmissions,'film-admission re-exports the one reader');assert.equal(typeof loadAdmissionRows,'function');assert.equal(ADMISSION_READ_CHUNK,80);
 await assert.rejects(()=>reader.readAdmissions({DB:d1Standin(database('prepared'))},['film:tmdb:300']),code('film_person_unavailable'));
 await assert.rejects(()=>readAdmissions({DB:d1Standin(database('held'))},['film:tmdb:300']),code('film_person_held'));
}

// 3. The /api/d1/* gate in the Worker scope: the route module is loaded as the Worker bundle loads it (owner-review overlay is reachable only through this route).
if(ONLY!=='reader'){
const ctx=vm.createContext({Response,Request,URL,JSON,Promise,Number,String,Math,Map,Set,Error});
vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);
vm.runInContext(scopedReplacing(READER_FILE,'CanonicalCatalogReader',IMPORT),ctx);
vm.runInContext("const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8'}});\n"+fs.readFileSync('src/d1-enrichment.js','utf8')+'\n'+scopePersonIdentity(['src/domain/canonical-person.js','src/domain/person-identity-projection.js'])+'\n'+fs.readFileSync(D1_FILE,'utf8')+'\nglobalThis.route=catalogD1Route;',ctx);
const T0='2026-10-29T00:00:00.000Z',PATHS=['status','persons','persons/director/michael-mann','persons/director/michael-mann/identity','persons/actor/solo/identity','films/tmdb:1','films/tmdb:9'];
const answers={};
for(const state of STATES){
 const file=database(state);
 sqlite(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:1',1,'tmdb:1','Heat','${T0}');INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:director/michael-mann','director/michael-mann',1,'${T0}');INSERT INTO person_alias VALUES ('person:director/michael-mann','name','Michael Mann',NULL);INSERT INTO film_person_credit VALUES ('film:tmdb:1','person:director/michael-mann','director',0);INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:actor/solo','actor/solo',1,'${T0}')${Array.from({length:45},(_,i)=>`,('person:actor/mm-${i}','actor/mm-${i}',1,'${T0}')`).join('')};INSERT INTO person_alias VALUES ('person:actor/solo','name','Only One',NULL)${Array.from({length:45},(_,i)=>`,('person:actor/mm-${i}','name','Michael Mann',NULL)`).join('')};`);
 let touched=0;
 const env={DB:standin(file,state),BUCKET:new Proxy({},{get(){touched++;throw new Error('R2 must not be read by /api/d1/*');}})};
 const get=async(p,method='GET')=>{const res=await ctx.route(new Request('https://iptv.test/api/d1/'+p,{method}),env,new URL('https://iptv.test/api/d1/'+p));return {status:res.status,text:await res.text()};};
 answers[state]={};
 for(const p of PATHS)answers[state][p]=await get(p);
 answers[state].post=await get('status','POST');
 assert.equal(touched,0,state+': no R2 access');
 if(state==='open'){
  // The marker moves AFTER the views' own reads: the gate at the start saw this state and generation; the answer is refused (typed 503, no stale body) because the marker is checked again
  // before it is returned. An unchanged marker answers byte-identically to the stored answer above.
  const held="UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1";
  const opened="UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1";
  const reopen="UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1";
  const scenarios=state==='open'?[['held',held,'film_person_held'],['held then reopened at a NEW generation',reopen,'film_person_generation_moved']]:[['opened (prepared to open)',opened,'film_person_generation_moved']];
  for(const p of ['status','persons/director/michael-mann/identity'])for(const [name,sql,reason] of scenarios){
   const copy=file+'.'+Math.random().toString(36).slice(2)+'.sqlite';fs.copyFileSync(file,copy);
   let moved=false,authorityReads=0;
   const e={DB:d1Standin(copy,{onQuery:async text=>{
    if(/FROM film_person_authority/.test(text)){authorityReads++;return;}
    if(!moved&&authorityReads>0&&/FROM (film|person)\b|COUNT\(/i.test(text)){moved=true;sqlite(copy,sql);}
   }}),BUCKET:env.BUCKET};
   const res=await ctx.route(new Request('https://iptv.test/api/d1/'+p),e,new URL('https://iptv.test/api/d1/'+p));
   const text=await res.text();
   assert.ok(moved,state+' '+p+' '+name+': the marker moved during the view reads');
   assert.equal(res.status,503,state+' '+p+' '+name+': refused');
   assert.deepEqual(JSON.parse(text),{error:'storage_unavailable',reason},state+' '+p+' '+name+': typed 503, never a stale body');
   assert.ok(!text.includes('authoritative'),state+' '+p+' '+name+': nothing of the stale view');
   fs.rmSync(copy,{force:true});
  }
  for(const p of ['status','persons/director/michael-mann/identity']){
   // an unchanged marker: the extra read changes nothing about the answer
   const copy=file+'.same.sqlite';fs.copyFileSync(file,copy);
   const res=await ctx.route(new Request('https://iptv.test/api/d1/'+p),{DB:d1Standin(copy),BUCKET:env.BUCKET},new URL('https://iptv.test/api/d1/'+p));
   assert.equal(await res.text(),answers[state][p].text,state+' '+p+': an unchanged marker answers byte-identically');fs.rmSync(copy,{force:true});
  }
 }
 assert.equal(answers[state].post.status,405,state+': a non-GET is not gated');
}
const body=(state,p)=>JSON.parse(answers[state][p].text);
for(const state of ['legacy','r2','prepared','held','unknown-row','unknown-table','unknown-read'])for(const p of PATHS){
 assert.equal(answers[state][p].status,503,state+' '+p);
 assert.deepEqual(body(state,p),{error:'storage_unavailable',reason:refusal(state)},state+' '+p+': a typed 503 and no catalog data');
}
// ADR 0162: legacy, r2 and prepared are refused above (503, no catalog data); only open answers.
{
 // The explicit local stand-in (a domain that is not installed) still answers, and says it is not authoritative.
 const legacyFile=database('legacy');
 const local={DB:standin(legacyFile,'legacy'),FILM_PERSON_DB_OPTIONAL:'standin',BUCKET:{}};
 const res=await ctx.route(new Request('https://iptv.test/api/d1/status'),local,new URL('https://iptv.test/api/d1/status'));
 assert.equal(res.status,200);assert.equal((await res.json()).authoritative,false,'stand-in: not authoritative');
}
for(const p of ['status','persons/director/michael-mann/identity','persons/actor/solo/identity'])assert.equal(body('open',p).authoritative,true,'open '+p);
assert.equal(body('open','persons/director/michael-mann/identity').bounded,true,'the namesake cap takes the bounded path');assert.equal(body('open','persons/actor/solo/identity').bounded,false,'a lone person takes the complete path');
assert.equal(answers.open['films/tmdb:9'].status,404);
assert.equal(body('open','persons').authoritative,undefined,'a view that never carried the flag does not gain one');

}

// 4. Static wiring: the one new bundled module, the allowlisted importers, and the modules that stay unbundled.
if(!ONLY){
 const build=fs.readFileSync('build.mjs','utf8');
 assert.match(build,/scopedReplacing\('src\/canonical-catalog-reader\.js','CanonicalCatalogReader'/,'build.mjs bundles the reader');
 for(const unbundled of ['canonical-producers','canonical-read-model','tmdb-retirement-decisions'])assert.ok(!build.includes('src/'+unbundled+'.js'),unbundled+' stays out of the bundle');
 assert.ok(build.includes("scopedImports('src/film-admission.js','CanonicalFilmAdmission'"),'AIR-499 bundles film-admission for rated_admission_retention');
 const importers=needle=>{const out=[];const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes(needle))out.push(full);}};walk('src');return out.sort();};
 assert.deepEqual(importers("from './canonical-catalog-reader.js'"),['src/canonical-producers.js','src/canonical-read-model.js','src/film-admission.js','src/letterboxd-claim-backfill.js'],'the explicit allowlist of the reader\'s importers (the owner-only claim backfill operator imports only the read-only `catalogStartedFilm` for its readback)');
 assert.deepEqual(importers('canonical-read-model'),[],'nothing in src imports the bulk read model, which is not bundled');
 const text=fs.readFileSync(READER_FILE,'utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\b(INSERT|UPDATE|DELETE|REPLACE)\b\s+(INTO|FROM)?\s*\w/.test(text)&&!/R2|BUCKET|fetch\(/.test(text),'the reader has no write statement and no R2 or network access');
 if(!MODULE)assert.deepEqual([...text.matchAll(/^import\s.*from\s+'([^']+)'/gm)].map(match=>match[1]),['./film-person-authority.js'],'it imports only the marker reader');
}
console.log('canonical-catalog-reader: the gate reads D1 only at open and fails closed (503, typed reason) for legacy, r2, prepared, held and every unknown state (ADR 0162; the explicit local stand-in is the only non-open answer); the D1 fallback reads admissions, identity claims, redirects and the retirement ledger with no R2 handle and refuses a marker that moves; /api/d1/* answers byte-identically before open and says authoritative:true only at open; the module is read-only and only the allowlisted importers name it');
