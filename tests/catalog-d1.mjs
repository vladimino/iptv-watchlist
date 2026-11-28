// AIR-275 phase 1: read-only relational views over D1. A D1 stand-in runs the real migrations in the sqlite3 CLI and serves
// the Worker's prepare().bind().all() calls; the route module is loaded as the Worker bundle loads it.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {scoped,scopedReplacing,scopePersonIdentity} from '../scripts/bundle-scope.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {nonFunctional} from './suite-gate.mjs';

const source=fs.readFileSync('src/catalog-d1.js','utf8');
assert.doesNotMatch(source,/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i,'the D1 catalog views never write');
assert.doesNotMatch(source,/\bBUCKET\b/,'the D1 catalog views never read R2');
assert.match(fs.readFileSync('build.mjs','utf8'),/src\/catalog-d1\.js/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/\/api\/d1\/'\)\)return await catalogD1Route/);
assert.match(fs.readFileSync('wrangler.jsonc','utf8'),/"binding": "DB",\s*"database_name": "iptv"/);

const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'iptv-catalog-d1-')),'d1.sqlite');
const sqlite=(sql,json=false)=>{const r=sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity'])sqlite(fs.readFileSync('migrations/'+name+'.sql','utf8'));
const literal=v=>v==null?'NULL':typeof v==='number'?String(v):"'"+String(v).replace(/'/g,"''")+"'";
const DB={prepare(sql){return {bind(...params){let i=0;const text=sql.replace(/\?/g,()=>literal(params[i++]));if(i!==params.length)throw new Error('parameter count');
 return {async all(){const out=sqlite(text+';',true).trim();return {results:out?JSON.parse(out):[]};},async first(){return (await this.all()).results[0]??null;}};}};}};

const T='2026-10-29T00:00:00.000Z';
sqlite(`
INSERT INTO film VALUES('film:tmdb:1',1,'tmdb:1','Heat','${T}'),('film:tmdb:2',1,'tmdb:2','Collateral','${T}'),('film:tmdb:3',1,'tmdb:3','Ronin','${T}');
INSERT INTO film_metadata(film_id,schema_version,year,runtime,genres_json,payload_json,updated_at,url) VALUES('film:tmdb:1',1,1995,170,'["crime"]','{}','${T}','https://letterboxd.com/film/heat-1995/'),('film:tmdb:2',1,2004,120,'[]','{}','${T}',NULL);
INSERT INTO film_dimension(film_id,dimension,status,value,updated_at) VALUES('film:tmdb:1','localization','reviewed','Схватка','${T}'),('film:tmdb:2','localization','missing',NULL,'${T}');
INSERT INTO film_external_id VALUES('film:tmdb:1','tmdb','1',1,0,NULL);
INSERT INTO film_redirect VALUES('film:old','film:tmdb:1','${T}');
INSERT INTO watchlist_film VALUES('film:tmdb:2','${T}');
INSERT INTO person VALUES('person:director/michael-mann','director/michael-mann',1,'${T}'),('person:actor/michael-mann','actor/michael-mann',1,'${T}'),('person:actor/al-pacino','actor/al-pacino',1,'${T}'),('person:actor/john-smith','actor/john-smith',1,'${T}'),('person:actor/john-smith-1','actor/john-smith-1',1,'${T}'),('person:tmdb_director/1032','tmdb_director/1032',1,'${T}'),('person:tmdb_actor/1032','tmdb_actor/1032',1,'${T}'),('person:tmdb_actor/555','tmdb_actor/555',1,'${T}');
INSERT INTO person_alias VALUES('person:director/michael-mann','name','Michael Mann',NULL),('person:actor/michael-mann','name','Michael Mann',NULL),('person:actor/al-pacino','name','Al Pacino',NULL),('person:actor/john-smith','name','John Smith',NULL),('person:actor/john-smith-1','name','John Smith',NULL),('person:tmdb_director/1032','name','Майкл Манн',NULL),('person:tmdb_actor/1032','name','Майкл Манн',NULL),('person:tmdb_actor/555','name','Al Pacino',NULL);
INSERT INTO person_dimension(person_id,dimension,status,value,updated_at) VALUES('person:actor/al-pacino','localization','reviewed','Аль Пачино','${T}'),('person:director/michael-mann','localization','reviewed','Майкл Манн','${T}');
INSERT INTO person_external_id VALUES('person:actor/al-pacino','letterboxd-role','actor/al-pacino',0,0,NULL);
INSERT INTO film_person_credit VALUES('film:tmdb:3','person:tmdb_director/1032','director',0),('film:tmdb:3','person:director/michael-mann','director',1),('film:tmdb:1','person:director/michael-mann','director',0),('film:tmdb:2','person:director/michael-mann','director',0),('film:tmdb:1','person:actor/al-pacino','actor',0);
INSERT INTO profile_version(version,profile_hash,created_at,r2_key,content_sha256) VALUES(1,'h','${T}','k','s');
INSERT INTO prediction_current(film_id,taste_profile_version,predicted_rating,updated_at) VALUES('film:tmdb:1',1,4.5,'${T}');
INSERT INTO actual_rating VALUES('film:tmdb:1',4.0,'letterboxd','${T}');
INSERT INTO import_receipt VALUES('k','s','film','film:tmdb:1','${T}');
`);

const ctx=vm.createContext({Response,URL,JSON,Promise,Number,String,Math,Map,Set,Error});
// The status view also reports the enrichment projector (ADR 0056); its read-only status function comes from its own module.
vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);
vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader','const {CREDIT_SELECTION_SQL,database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n'),ctx);
vm.runInContext("const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8'}});\n"+fs.readFileSync('src/d1-enrichment.js','utf8')+'\n'+scopePersonIdentity(['src/domain/canonical-person.js','src/domain/person-identity-projection.js'])+'\n'+source+'\nglobalThis.route=catalogD1Route;',ctx);
const get=async(p,env={DB,FILM_PERSON_DB_OPTIONAL:'standin'},method='GET')=>{const res=await ctx.route(new Request('https://iptv.test/api/d1/'+p,{method}),env,new URL('https://iptv.test/api/d1/'+p));return {status:res.status,body:await res.json()};};

// status
let r=await get('status');
assert.equal(r.status,200);
assert.deepEqual({...r.body},{source:'d1',authoritative:false,films:3,persons:8,credits:5,candidates:0,predictions:1,ratings:1,lastImport:T,schemaVersion:3,projector:{mode:null,retired:true,schema:false,schemaVersion:3,projectionTables:[]}});
// AIR-689 (ADR 0223): the four operator views are retired with a typed 410 decided on the raw path, before the marker gate and before any storage access.
const GONE={error:'gone',reason:'d1_operator_view_retired'};
const retiredPaths=['persons','persons?q=Pacino&limit=2','persons/review','persons/review?limit=5','persons/director/michael-mann','persons/actor/al-pacino','persons/tmdb_director/1032','persons/tmdb_actor/555','films/tmdb:1','films/old','films/tmdb:9','films/tmdb_1','persons/actor/identity','persons/actor/%E0%A4%A','persons/actor/%zz','films/%E0%A4%A','films/%'];
for(const path of retiredPaths){r=await get(path);assert.equal(r.status,410,path);assert.deepEqual({...r.body},GONE,path);}
// No storage IO for a retired path: a binding that throws on any use, a missing binding, and a held or unreadable marker all still answer 410 (a retained path is gated as before).
let storageTouches=0;
const trapped=new Proxy({},{get(){storageTouches++;throw new Error('storage touched');}});
for(const env of [{DB:trapped},{},{DB:trapped,BUCKET:trapped},{DB}]){for(const path of retiredPaths){r=await get(path,env);assert.equal(r.status,410,path);assert.deepEqual({...r.body},GONE,path);}}
assert.equal(storageTouches,0,'a retired path touches no storage');
const gate503=await get('persons/actor/al-pacino/identity',{DB:trapped});
assert.equal(gate503.status,503,'a retained path stays behind the authority gate');
assert.ok(storageTouches>0,'the control: the retained path does read through the gate');
// HEAD and other methods keep 405; retired paths are not a method bypass.
for(const method of ['HEAD','POST','PUT','DELETE','PATCH']){for(const path of ['persons','persons/review','persons/director/michael-mann','films/tmdb:1']){assert.equal((await get(path,{DB},method)).status,405,method+' '+path);}}
// Unknown paths are not retired: 404 when the gates admit the request, 503 when the gate refuses. Only the exact shapes are matched.
for(const path of ['persons/','films','films/','films/a/b','persons/writer/x','persons/actor','persons/actor/','persons/review/','persons/review/extra','persons/actor/al-pacino/other','persons/actor/a/b/identity','nothing','']){r=await get(path);assert.equal(r.status,404,path);assert.deepEqual({...r.body},{error:'Not found'},path);}
assert.equal((await get('films/tmdb:1',{DB:trapped,FILM_PERSON_DB_OPTIONAL:undefined})).status,410);
assert.equal((await get('nothing',{DB:trapped})).status,503,'an unknown path keeps the 503 of a refused gate');
// The retained routes are not shadowed: status and identity (also for a person named like a route word) still answer.
assert.equal((await get('status')).status,200);
assert.equal((await get('persons/actor/review/identity')).status,404,'identity of an unknown person is still 404, not 410');
assert.equal((await get('persons/director/michael-mann/identity')).status,200);
// review queues
r={body:JSON.parse(JSON.stringify(await vm.runInContext('d1PersonReview',ctx)(DB,{})))};// the function the credits script loads through vm; its HTTP route is retired
assert.deepEqual({...r.body.totals},{crossRole:2,sharedName:2,sameName:1,coCredit:1},'one key under two roles is crossRole only');
assert.deepEqual(r.body.crossRole.map(x=>[x.human,x.ids.sort()]),[['letterboxd:michael-mann',['person:actor/michael-mann','person:director/michael-mann']],['tmdb:1032',['person:tmdb_actor/1032','person:tmdb_director/1032']]]);
assert.deepEqual(r.body.coCredit,[{letterboxd:'person:director/michael-mann',tmdb:'person:tmdb_director/1032',role:'director',name:'Майкл Манн',films:1}]);
assert.deepEqual(r.body.nameOnly.map(x=>[x.name,x.letterboxd,x.tmdb]),[['Al Pacino',['person:actor/al-pacino'],['person:tmdb_actor/555']]],'a name with Film evidence leaves the name-only queue');
assert.deepEqual(r.body.sameName.map(x=>[x.name,x.source,x.ids.sort(),x.count]),[['John Smith','letterboxd',['person:actor/john-smith','person:actor/john-smith-1'],2]]);
// person identity: the existing person route stays a filmography; this route is the derived reference
const peopleBefore=sqlite('select count(*) from person');
r=await get('persons/director/michael-mann/identity');
assert.equal(r.status,200);
assert.equal(r.body.authoritative,false);
assert.equal(r.body.bounded,false);
assert.equal(r.body.reference.state,'trusted');
assert.equal(r.body.reference.crossSource,'verified');
assert.deepEqual(r.body.reference.memberIds,['person:actor/michael-mann','person:director/michael-mann','person:tmdb_actor/1032','person:tmdb_director/1032']);
assert.deepEqual(r.body.films.director,{state:'trusted',crossSource:'verified',humanId:r.body.reference.humanId,watchlist:['film:tmdb:2'],catalog:['film:tmdb:1','film:tmdb:3']});
assert.deepEqual(r.body.films.actor.watchlist,[]);
assert.deepEqual(r.body.films.actor.catalog,[]);
assert.ok(r.body.reference.links.some(link=>link.basis==='co_credit'));
assert.ok(r.body.reference.links.some(link=>link.basis==='same_key'));
assert.deepEqual(r.body.limitations,['owner_decisions_not_stored','role_links_not_stored']);
const actorMann=await get('persons/actor/michael-mann/identity');
assert.equal(actorMann.body.reference.humanId,r.body.reference.humanId);
assert.deepEqual(actorMann.body.films.director.catalog,r.body.films.director.catalog);
assert.deepEqual(actorMann.body.films.director.watchlist,r.body.films.director.watchlist);
r=await get('persons/actor/al-pacino/identity');
assert.equal(r.body.reference.state,'ambiguous');
assert.deepEqual(r.body.reference.memberIds,['person:actor/al-pacino']);
assert.equal(r.body.reference.reviews.some(review=>review.reason==='name_only'),true);
assert.deepEqual(r.body.films.actor,{state:'ambiguous',crossSource:r.body.films.actor.crossSource,humanId:r.body.reference.humanId,watchlist:[],catalog:['film:tmdb:1']});
assert.deepEqual(r.body.films.director.watchlist,[]);
assert.deepEqual(r.body.films.director.catalog,[]);
r=await get('persons/actor/john-smith/identity');
assert.equal(r.body.reference.state,'ambiguous');
assert.deepEqual(r.body.reference.memberIds,['person:actor/john-smith']);
assert.equal(r.body.reference.reviews.some(review=>review.reason==='same_name'),true);
assert.deepEqual(r.body.films.actor.watchlist,[],'a shared name adds no film');
assert.deepEqual(r.body.films.actor.catalog,[]);
assert.equal(sqlite('select count(*) from person'),peopleBefore,'an identity read writes nothing');
assert.equal((await get('persons/director/michael-mann')).status,410,'the filmography route is retired');
// A retired movie id does not verify a film. A trusted TV id does, and it joins only the shared role.
sqlite(`
INSERT INTO film VALUES('film:tmdb:9',1,'tmdb:9','Retired','${T}'),('film:tv:1',1,'tmdb_tv:9687','The Odyssey','${T}'),('film:tmdb:8',1,'tmdb:8','Collision','${T}');
INSERT INTO film_external_id VALUES('film:tmdb:9','tmdb','17266',0,0,NULL),('film:tv:1','tmdb','17266',0,0,NULL),('film:tv:1','tmdb_tv','9687',1,0,NULL),('film:tmdb:8','tmdb','8',1,0,NULL),('film:tmdb:8','tmdb','80',1,0,NULL);
INSERT INTO person VALUES('person:actor/odyssey','actor/odyssey',1,'${T}'),('person:tmdb_actor/968','tmdb_actor/968',1,'${T}'),('person:actor/ann','actor/ann',1,'${T}'),('person:tmdb_actor/11','tmdb_actor/11',1,'${T}'),('person:tmdb_actor/12','tmdb_actor/12',1,'${T}'),('person:actor/clash','actor/clash',1,'${T}'),('person:tmdb_actor/70','tmdb_actor/70',1,'${T}');
INSERT INTO person_alias VALUES('person:actor/odyssey','name','Odysseus',NULL),('person:tmdb_actor/968','name','Odysseus',NULL),('person:actor/ann','name','Ann',NULL),('person:tmdb_actor/11','name','Ann',NULL),('person:tmdb_actor/12','name','Ann',NULL),('person:actor/clash','name','Clash',NULL),('person:tmdb_actor/70','name','Clash',NULL);
INSERT INTO film_person_credit VALUES('film:tmdb:9','person:actor/odyssey','actor',0),('film:tmdb:9','person:tmdb_actor/968','actor',1),('film:tv:1','person:actor/odyssey','actor',0),('film:tv:1','person:tmdb_actor/968','actor',1),('film:tmdb:1','person:actor/ann','actor',1),('film:tmdb:1','person:tmdb_actor/11','actor',2),('film:tmdb:1','person:tmdb_actor/12','actor',3),('film:tmdb:8','person:actor/clash','actor',0),('film:tmdb:8','person:tmdb_actor/70','actor',1);
INSERT INTO watchlist_film VALUES('film:tv:1','${T}');
`);
for(let n=0;n<200;n++)sqlite(`INSERT INTO person VALUES('person:actor/decoy-${n}','actor/decoy-${n}',1,'${T}');INSERT INTO person_alias VALUES('person:actor/decoy-${n}','name','Decoy ${n}',NULL);`);
r=await get('persons/actor/odyssey/identity');
assert.equal(r.body.reference.state,'trusted');
assert.equal(r.body.reference.crossSource,'verified');
assert.deepEqual(r.body.reference.memberIds,['person:actor/odyssey','person:tmdb_actor/968']);
assert.deepEqual(r.body.films.actor.watchlist,['film:tv:1']);
assert.deepEqual(r.body.films.actor.catalog,['film:tmdb:9'],'the retired movie stays a credit and does not have to be the verifying id');
r=await get('persons/actor/ann/identity');
assert.equal(r.body.reference.state,'ambiguous');
assert.deepEqual(r.body.reference.memberIds,['person:actor/ann']);
assert.equal(r.body.reference.reviews.some(review=>review.reason==='ambiguous_co_credit'),true);
assert.deepEqual(r.body.films.actor.catalog,['film:tmdb:1']);
assert.equal(r.body.films.actor.catalog.includes('film:tmdb:9'),false);
r=await get('persons/actor/clash/identity');
assert.equal(r.body.reference.crossSource,'none','two trusted ids leave the film unverified');
assert.deepEqual(r.body.reference.memberIds,['person:actor/clash']);
assert.deepEqual(r.body.films.actor.catalog,['film:tmdb:8']);
sqlite(`
INSERT INTO film VALUES('film:tmdb:7',1,NULL,'Newer','${T}');
INSERT INTO watchlist_film VALUES('film:tmdb:7','${T}');
INSERT INTO person VALUES('person:director/newer','director/newer',1,'${T}');
INSERT INTO person_alias VALUES('person:director/newer','name','Newer Director',NULL);
INSERT INTO film_person_credit VALUES('film:tmdb:7','person:director/newer','director',0);
`);
r=await get('persons/director/newer/identity');
assert.equal(r.body.reference.state,'unresolved','a watchlist film with no TMDB credit stays one record');
assert.deepEqual(r.body.reference.memberIds,['person:director/newer']);
assert.equal(r.body.reference.crossSource,'none');
assert.equal(r.body.reference.links.length,0);
assert.deepEqual(r.body.films.director.watchlist,['film:tmdb:7']);
assert.deepEqual(r.body.films.director.catalog,[]);
assert.deepEqual(r.body.films.actor.watchlist,[]);
await nonFunctional('catalog-d1-identity-read-latency',async()=>{
 const started=Date.now();
 for(let n=0;n<20;n++)await get('persons/actor/al-pacino/identity');
 const elapsed=Date.now()-started;
 assert.ok(elapsed<5000,`20 identity reads took ${elapsed}ms`);
});
assert.equal((await get('persons/actor/decoy-0/identity')).body.reference.memberIds.includes('person:actor/al-pacino'),false);
assert.equal((await get('persons/actor/nobody/identity')).status,404);
assert.equal((await get('persons/writer/ann/identity')).status,404);
assert.equal((await get('persons/actor/al-pacino/identity',{DB},'POST')).status,405);
assert.equal((await get('persons/actor/al-pacino/identity',{})).status,503);
sqlite(`
INSERT INTO film VALUES('film:retired:1',1,NULL,'Retired Only Film','${T}');
INSERT INTO film_external_id VALUES('film:retired:1','tmdb','17266',0,0,NULL);
INSERT INTO person VALUES('person:actor/retired-only','actor/retired-only',1,'${T}'),('person:tmdb_actor/77','tmdb_actor/77',1,'${T}'),('person:actor/pyotr','actor/pyotr',1,'${T}'),('person:actor/petr','actor/petr',1,'${T}');
INSERT INTO person_alias VALUES('person:actor/retired-only','name','Retired Only',NULL),('person:tmdb_actor/77','name','Retired Only',NULL),('person:actor/pyotr','name','Пётр',NULL),('person:actor/petr','name','Петр',NULL);
INSERT INTO film_person_credit VALUES('film:retired:1','person:actor/retired-only','actor',0),('film:retired:1','person:tmdb_actor/77','actor',1);
`);
r=await get('persons/actor/retired-only/identity');
assert.equal(r.body.reference.crossSource,'none','an untrusted retired movie id does not verify a coCredit');
assert.deepEqual(r.body.reference.memberIds,['person:actor/retired-only']);
assert.equal(r.body.reference.links.some(link=>link.basis==='co_credit'),false);
r=await get('persons/actor/pyotr/identity');
assert.equal(r.body.bounded,false);
assert.equal(r.body.reference.reviews.some(review=>review.reason==='same_name'),true,'ё and е still meet as a review');
assert.deepEqual(r.body.reference.memberIds,['person:actor/pyotr']);
const countTable=table=>Number(sqlite(`select count(*) from ${table}`));
const before={person:countTable('person'),film:countTable('film'),credit:countTable('film_person_credit')};
function watchDb(){
 const stats={creditRows:0,maxCredit:0,nameRows:0,maxName:0,unlimited:0};
 const db={prepare(sql){return {bind(...params){const statement=DB.prepare(sql).bind(...params);return {async all(){const out=await statement.all();const n=out.results.length;if(sql.includes('film_person_credit')){stats.creditRows+=n;if(n>stats.maxCredit)stats.maxCredit=n;if(!sql.includes('limit')&&n>IDENTITY_SENTINEL)stats.unlimited++;}if(sql.includes('limit')&&sql.includes('person_alias')){stats.nameRows+=n;if(n>stats.maxName)stats.maxName=n;}return out;},async first(){return (await this.all()).results[0]??null;}};}};}};
 return {db,stats};
}
const IDENTITY_SENTINEL=801;
const wideFilms=[],wideCredits=[];
for(let n=0;n<801;n++){wideFilms.push(`('film:wide:${n}',1,NULL,'Wide ${n}','${T}')`);wideCredits.push(`('film:wide:${n}','person:actor/wide','actor',0)`);}
sqlite(`
INSERT INTO person VALUES('person:actor/wide','actor/wide',1,'${T}'),('person:tmdb_actor/wide','tmdb_actor/wide',1,'${T}');
INSERT INTO person_alias VALUES('person:actor/wide','name','Wide Credit',NULL),('person:tmdb_actor/wide','name','Wide Credit',NULL);
INSERT INTO film VALUES ${wideFilms.join(',')};
INSERT INTO film_external_id VALUES('film:wide:800','tmdb','1800',1,0,NULL);
INSERT INTO film_person_credit VALUES ${wideCredits.join(',')},('film:wide:800','person:tmdb_actor/wide','actor',1);
`);
let watched=watchDb();
r=await get('persons/actor/wide/identity',{DB:watched.db,FILM_PERSON_DB_OPTIONAL:'standin'});
assert.equal(r.body.bounded,true);
assert.ok(r.body.limitations.includes('neighborhood_bounded'));
assert.deepEqual(r.body.reference.memberIds,['person:actor/wide']);
assert.equal(r.body.reference.crossSource,'none');
assert.equal(r.body.reference.links.some(link=>link.basis==='co_credit'),false);
assert.equal(r.body.films.actor.catalog.includes('film:wide:800'),false);
assert.ok(watched.stats.maxCredit<=801,`film probe returned ${watched.stats.maxCredit} rows`);
assert.ok(watched.stats.creditRows<=1602,`film reads returned ${watched.stats.creditRows} rows`);
assert.equal(watched.stats.unlimited,0);
const crowdPeople=[],crowdAliases=[],crowdCredits=[];
for(let n=0;n<401;n++){crowdPeople.push(`('person:actor/crowd-${n}','actor/crowd-${n}',1,'${T}')`);crowdAliases.push(`('person:actor/crowd-${n}','name','Crowd ${n}',NULL)`);crowdCredits.push(`('film:crowd','person:actor/crowd-${n}','actor',${n+2})`);}
sqlite(`
INSERT INTO film VALUES('film:crowd',1,'tmdb:9000','Crowd','${T}');
INSERT INTO film_external_id VALUES('film:crowd','tmdb','9000',1,0,NULL);
INSERT INTO person VALUES('person:actor/crowd','actor/crowd',1,'${T}'),('person:tmdb_actor/9000','tmdb_actor/9000',1,'${T}'),${crowdPeople.join(',')};
INSERT INTO person_alias VALUES('person:actor/crowd','name','Crowd Lead',NULL),('person:tmdb_actor/9000','name','Crowd Lead',NULL),${crowdAliases.join(',')};
INSERT INTO film_person_credit VALUES('film:crowd','person:actor/crowd','actor',0),('film:crowd','person:tmdb_actor/9000','actor',1),${crowdCredits.join(',')};
`);
watched=watchDb();
r=await get('persons/actor/crowd/identity',{DB:watched.db,FILM_PERSON_DB_OPTIONAL:'standin'});
assert.equal(r.body.bounded,true);
assert.ok(r.body.limitations.includes('neighborhood_bounded'));
assert.deepEqual(r.body.reference.memberIds,['person:actor/crowd']);
assert.equal(r.body.reference.crossSource,'none');
assert.equal(r.body.reference.links.some(link=>link.basis==='co_credit'),false);
assert.ok(watched.stats.maxCredit<=401,`witness probe returned ${watched.stats.maxCredit} rows`);
assert.equal(watched.stats.unlimited,0);
const alsoPeople=[],alsoAliases=[];
for(let n=0;n<41;n++){alsoPeople.push(`('person:actor/also-${n}','actor/also-${n}',1,'${T}')`);alsoAliases.push(`('person:actor/also-${n}','name','Popular Name',NULL)`);}
sqlite(`
INSERT INTO film VALUES('film:pop',1,'tmdb:9100','Popular','${T}');
INSERT INTO film_external_id VALUES('film:pop','tmdb','9100',1,0,NULL);
INSERT INTO person VALUES('person:actor/popular','actor/popular',1,'${T}'),('person:tmdb_actor/9100','tmdb_actor/9100',1,'${T}'),${alsoPeople.join(',')};
INSERT INTO person_alias VALUES('person:actor/popular','name','Popular Name',NULL),('person:tmdb_actor/9100','name','Popular Name',NULL),${alsoAliases.join(',')};
INSERT INTO film_person_credit VALUES('film:pop','person:actor/popular','actor',0),('film:pop','person:tmdb_actor/9100','actor',1);
`);
watched=watchDb();
r=await get('persons/actor/popular/identity',{DB:watched.db,FILM_PERSON_DB_OPTIONAL:'standin'});
assert.equal(r.body.bounded,true);
assert.deepEqual(r.body.limitations,['owner_decisions_not_stored','role_links_not_stored','namesakes_truncated','neighborhood_bounded']);
assert.deepEqual(r.body.reference.memberIds,['person:actor/popular']);
assert.equal(r.body.reference.crossSource,'none');
assert.equal(r.body.reference.links.some(link=>link.basis==='co_credit'),false);
assert.ok(watched.stats.maxName<=41,`namesake probe returned ${watched.stats.maxName} rows`);
assert.ok(watched.stats.nameRows<=41,`namesake reads returned ${watched.stats.nameRows} rows`);
assert.equal(countTable('person'),before.person+2+401+2+41+2);
assert.equal(countTable('film'),before.film+801+1+1);
assert.equal(countTable('film_person_credit'),before.credit+802+403+2);
// guards
assert.equal((await get('status',{DB},'POST')).status,405);
assert.equal((await get('status',{})).status,503);
assert.equal((await get('nope')).status,404);
// AIR-689 review P1: the owner-review overlay is a separate authority gate behind the Film/Person gate. The REAL src/owner-review-d1.js overlay (instrumented only to count calls) runs here with an admitted Film/Person
// stand-in and an owner-review domain that refuses (no marker tables, no owner-review stand-in flag): a retired GET is a 410 and never reaches the overlay; an unknown GET keeps the typed 503 owner_review_unavailable
// (the overlay refuses even a 404); a retained GET stays gated by it. With the owner-review stand-in admitted the same paths answer 404/200, so the 503 above is the overlay and nothing else.
{
 vm.runInContext(scoped('src/owner-review-d1.js','OwnerReviewReal'),ctx);
 const realOverlay=vm.runInContext('OwnerReviewReal.overlayCatalogResponse',ctx);
 let overlayCalls=0;
 ctx.OwnerReview={overlayCatalogResponse:(env,response)=>{overlayCalls++;return realOverlay(env,response);}};
 const refusing={DB,FILM_PERSON_DB_OPTIONAL:'standin'},admitted={DB,FILM_PERSON_DB_OPTIONAL:'standin',OWNER_REVIEW_DB_OPTIONAL:'standin'};
 const OWNER_503={error:'storage_unavailable',reason:'owner_review_unavailable'};
 for(const path of ['persons','persons/review','persons/director/michael-mann','films/tmdb:1','films/%E0%A4%A','persons/actor/%zz']){
  for(const env of [refusing,admitted]){const before=overlayCalls;r=await get(path,env);assert.equal(r.status,410,path);assert.deepEqual({...r.body},GONE,path);assert.equal(overlayCalls,before,'a retired GET never calls the owner-review overlay: '+path);}
 }
 overlayCalls=0;
 r=await get('nothing',refusing);assert.equal(r.status,503,'an unknown GET keeps the typed owner-review refusal');assert.deepEqual({...r.body},OWNER_503);assert.equal(overlayCalls,1);
 for(const path of ['status','persons/director/michael-mann/identity']){const before=overlayCalls;r=await get(path,refusing);assert.equal(r.status,503,path);assert.deepEqual({...r.body},OWNER_503,path);assert.equal(overlayCalls,before+1,'a retained GET is still gated by the overlay: '+path);}
 r=await get('nothing',admitted);assert.equal(r.status,404);assert.deepEqual({...r.body},{error:'Not found'});
 assert.equal((await get('status',admitted)).status,200);
 assert.equal((await get('persons/director/michael-mann/identity',admitted)).status,200);
 for(const method of ['HEAD','POST'])assert.equal((await get('persons/review',admitted,method)).status,405,method+' keeps the existing 405 with the overlay admitted');
 delete ctx.OwnerReview;
}
console.log('Catalog D1 views: read-only source, status, retired persons/films/review views answer a typed 410 before the gates and without storage IO, 405/404/503 unchanged, review queues still computed by d1PersonReview, identity and status retained');
