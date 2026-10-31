// AIR-275 phase 1: read-only relational views over D1. A D1 stand-in runs the real migrations in the sqlite3 CLI and serves
// the Worker's prepare().bind().all() calls; the route module is loaded as the Worker bundle loads it.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {scopePersonIdentity} from '../scripts/bundle-scope.mjs';

const source=fs.readFileSync('src/catalog-d1.js','utf8');
assert.doesNotMatch(source,/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i,'the D1 catalog views never write');
assert.doesNotMatch(source,/\bBUCKET\b/,'the D1 catalog views never read R2');
assert.match(fs.readFileSync('build.mjs','utf8'),/src\/catalog-d1\.js/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/\/api\/d1\/'\)\)return await catalogD1Route/);
assert.match(fs.readFileSync('wrangler.jsonc','utf8'),/"binding": "DB",\s*"database_name": "iptv"/);

const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'iptv-catalog-d1-')),'d1.sqlite');
const sqlite=(sql,json=false)=>{const r=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
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

const ctx=vm.createContext({Response,URL,JSON,Promise,Number,String,Math});
// The status view also reports the enrichment projector (ADR 0056); its read-only status function comes from its own module.
vm.runInContext("const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8'}});\n"+fs.readFileSync('src/d1-enrichment.js','utf8')+'\n'+scopePersonIdentity(['src/domain/canonical-person.js','src/domain/person-identity-projection.js'])+'\n'+source+'\nglobalThis.route=catalogD1Route;',ctx);
const get=async(p,env={DB},method='GET')=>{const res=await ctx.route(new Request('https://iptv.test/api/d1/'+p,{method}),env,new URL('https://iptv.test/api/d1/'+p));return {status:res.status,body:await res.json()};};

// status
let r=await get('status');
assert.equal(r.status,200);
assert.deepEqual({...r.body},{source:'d1',authoritative:false,films:3,persons:8,credits:5,candidates:0,predictions:1,ratings:1,lastImport:T,schemaVersion:3,projector:{mode:'off',schema:false,schemaVersion:3,projectionTables:[]}});
// persons: search by original name, by localized name, role filter, keyset paging
r=await get('persons?q=Pacino');assert.deepEqual(r.body.items.map(x=>x.id),['person:actor/al-pacino','person:tmdb_actor/555']);assert.equal(r.body.items[0].localName,'Аль Пачино');assert.equal(r.body.items[0].films,1);
r=await get('persons?q='+encodeURIComponent('Пачино'));assert.deepEqual(r.body.items.map(x=>x.id),['person:actor/al-pacino']);
r=await get('persons?role=director');assert.deepEqual(r.body.items.map(x=>x.id),['person:director/michael-mann','person:tmdb_director/1032']);assert.equal(r.body.items[0].films,3);
r=await get('persons?source=tmdb');assert.deepEqual(r.body.items.map(x=>[x.id,x.source,x.key]),[['person:tmdb_actor/1032','tmdb','1032'],['person:tmdb_actor/555','tmdb','555'],['person:tmdb_director/1032','tmdb','1032']]);
r=await get('persons?source=letterboxd&role=director');assert.deepEqual(r.body.items.map(x=>x.id),['person:director/michael-mann']);
r=await get('persons?limit=2');assert.equal(r.body.items.length,2);assert.equal(r.body.nextCursor,r.body.items[1].id);
const second=await get('persons?limit=2&cursor='+encodeURIComponent(r.body.nextCursor));assert.ok(second.body.items.every(x=>x.id>r.body.nextCursor));
const all=await get('persons?limit=100');assert.equal(all.body.items.length,8);assert.equal(all.body.nextCursor,null);
// person detail: filmography with localized title, year, prediction, rating, watchlist flag; the same slug under the other role
r=await get('persons/director/michael-mann');
assert.equal(r.status,200);assert.equal(r.body.name,'Michael Mann');assert.equal(r.body.key,'michael-mann');assert.equal(r.body.source,'letterboxd');
assert.deepEqual(r.body.sameSlug,['person:actor/michael-mann'],'the TMDB id 1032 is another source, not the same key');
assert.deepEqual(r.body.coCredited,[{id:'person:tmdb_director/1032',films:1}],'same name, same role, same Film: the provable cross-source match');
assert.deepEqual(r.body.nameOnlyOtherSource,['person:tmdb_actor/1032'],'a name alone stays a candidate');
assert.deepEqual(r.body.films.map(f=>[f.id,f.title,f.year,f.predicted,f.rating,f.inWatchlist]),[['film:tmdb:2','Collateral',2004,null,null,true],['film:tmdb:1','Схватка',1995,4.5,4,false],['film:tmdb:3','Ronin',null,null,null,false]]);
r=await get('persons/actor/al-pacino');assert.deepEqual(r.body.externalIds,[{scheme:'letterboxd-role',value:'actor/al-pacino',trusted:false,conflicting:false}]);
assert.equal((await get('persons/actor/nobody')).status,404);
r=await get('persons/tmdb_director/1032');assert.equal(r.body.source,'tmdb');assert.deepEqual(r.body.sameSlug,['person:tmdb_actor/1032']);assert.deepEqual(r.body.coCredited,[{id:'person:director/michael-mann',films:1}]);assert.deepEqual(r.body.nameOnlyOtherSource,[]);assert.deepEqual(r.body.films.map(f=>f.id),['film:tmdb:3']);
// film detail: credits with names, genres, ids; a retired id answers with its redirect
r=await get('films/tmdb:1');
assert.equal(r.body.title,'Схватка');assert.equal(r.body.originalTitle,'Heat');assert.deepEqual(r.body.genres,['crime']);
assert.deepEqual(r.body.credits.map(c=>[c.id,c.role,c.localName]),[['person:director/michael-mann','director','Майкл Манн'],['person:actor/al-pacino','actor','Аль Пачино']]);
assert.equal(r.body.prediction.predicted,4.5);assert.equal(r.body.rating.rating,4);assert.deepEqual(r.body.externalIds,[{scheme:'tmdb',value:'1',trusted:true,conflicting:false}]);
assert.deepEqual((await get('films/old')).body,{redirect:'film:tmdb:1'});
assert.equal((await get('films/tmdb:9')).status,404);
// review queues
r=await get('persons/review');
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
assert.equal((await get('persons/director/michael-mann')).body.name,'Michael Mann','the filmography route is unchanged');
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
const started=Date.now();
for(let n=0;n<20;n++)await get('persons/actor/al-pacino/identity');
const elapsed=Date.now()-started;
assert.ok(elapsed<5000,`20 identity reads took ${elapsed}ms`);
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
r=await get('persons/actor/wide/identity',{DB:watched.db});
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
r=await get('persons/actor/crowd/identity',{DB:watched.db});
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
r=await get('persons/actor/popular/identity',{DB:watched.db});
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
console.log('Catalog D1 views: read-only source, status, person search/paging/role, filmography with same-slug link, film credits and redirect, TMDB persons and source filter, co-credit evidence vs name-only candidates, four review queues, method/binding/404 guards passed');
