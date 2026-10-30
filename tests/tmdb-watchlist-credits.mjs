// AIR-286: TMDB credits for watchlist Films. A D1 stand-in runs the real migrations in the sqlite3 CLI and serves the script's
// all/run/transaction calls; TMDB is a local fetch stub. Proves the discovery id and name format, the fetch stop rules, the
// plan, the write (ordinals after the existing credits, nothing else touched), idempotency and the coCredit pairs it creates.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {renderSql} from '../scripts/d1-backfill.mjs';
import {ALIAS_PROVENANCE,applyPlan,buildPlan,coCreditReview,creditSource,fetchCredits,readSources,filmStatements,tmdbCredits,tmdbPath,watchlistFilms} from '../scripts/tmdb-watchlist-credits.mjs';

const source=fs.readFileSync('scripts/tmdb-watchlist-credits.mjs','utf8');
assert.doesNotMatch(source,/\bBUCKET\b|wrangler|env\.DB\b|\bDELETE\b|\bUPDATE\b|DO UPDATE|REPLACE INTO/,'the script only adds rows, never R2, never a Worker binding');
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/tmdb-watchlist-credits/);
// The same request and person format as discovery.
const discovery=fs.readFileSync('src/discovery.js','utf8');
assert.match(discovery,/append_to_response=credits/);
assert.match(discovery,/slice\(0,10\)\.map\(person=>\(\{id:prefix\+'\/'\+person\.id,name:person\.name/);
assert.equal(tmdbPath('949'),'movie/949?language=ru-RU&append_to_response=credits');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-tmdb-credits-')),file=path.join(root,'d1.sqlite'),dir=path.join(root,'private');
const sqlite=(sql,json=false)=>{const r=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity'])sqlite(fs.readFileSync('migrations/'+name+'.sql','utf8'));
const db={statements:0,batches:0,buffer:null,
 async all(sql,params=[]){const out=sqlite(renderSql(sql,params)+';',true).trim();return out?JSON.parse(out):[];},
 async run(sql,params=[]){const text=renderSql(sql,params)+';';if(this.buffer){this.buffer.push(text);return;}this.statements++;sqlite(text);},
 async transaction(fn){this.buffer=[];try{await fn();if(this.buffer.length){this.batches++;this.statements+=this.buffer.length;sqlite('BEGIN;\n'+this.buffer.join('\n')+'\nCOMMIT;');}}finally{this.buffer=null;}}};
const rows=sql=>{const out=sqlite(sql,true).trim();return out?JSON.parse(out):[];};

const T='2026-10-29T00:00:00.000Z';
sqlite(`
INSERT INTO film VALUES('film:lb:heat',1,'tmdb:949','Heat','${T}'),('film:lb:ronin',1,'tmdb:8195','Ronin','${T}'),('film:lb:nolink',1,NULL,'Unlinked','${T}'),('film:lb:gone',1,'tmdb:404','Gone','${T}'),('film:tmdb:500',1,'tmdb:500','Catalog','${T}');
INSERT INTO film_external_id VALUES('film:lb:heat','letterboxd','heat',1,0,NULL),('film:lb:heat','tmdb','949',1,0,NULL),('film:lb:ronin','letterboxd','ronin',1,0,NULL),('film:lb:ronin','tmdb','8195',1,0,NULL),('film:lb:nolink','letterboxd','nolink',1,0,NULL),('film:lb:nolink','tmdb','77',0,1,NULL),('film:lb:gone','letterboxd','gone',1,0,NULL),('film:lb:gone','tmdb','404',1,0,NULL),('film:tmdb:500','tmdb','500',1,0,NULL);
INSERT INTO watchlist_film VALUES('film:lb:heat','${T}'),('film:lb:ronin','${T}'),('film:lb:nolink','${T}'),('film:lb:gone','${T}');
INSERT INTO person VALUES('person:director/michael-mann','director/michael-mann',1,'${T}'),('person:actor/al-pacino','actor/al-pacino',1,'${T}'),('person:actor/robert-de-niro','actor/robert-de-niro',1,'${T}'),('person:director/john-frankenheimer','director/john-frankenheimer',1,'${T}'),('person:tmdb_actor/380','tmdb_actor/380',1,'${T}');
INSERT INTO person_alias VALUES('person:director/michael-mann','name','Michael Mann',NULL),('person:actor/al-pacino','name','Al Pacino',NULL),('person:actor/robert-de-niro','name','Robert De Niro',NULL),('person:director/john-frankenheimer','name','John Frankenheimer',NULL),('person:tmdb_actor/380','name','Роберт Де Ниро','{"source":"letterboxd"}');
INSERT INTO person_dimension(person_id,dimension,status,value,updated_at) VALUES('person:director/michael-mann','localization','provisional','Майкл Манн','${T}'),('person:actor/robert-de-niro','localization','provisional','Роберт Де Ниро','${T}'),('person:actor/al-pacino','localization','missing',NULL,'${T}');
INSERT INTO film_person_credit VALUES('film:lb:heat','person:director/michael-mann','director',0),('film:lb:heat','person:actor/al-pacino','actor',0),('film:lb:heat','person:actor/robert-de-niro','actor',1),('film:lb:ronin','person:director/john-frankenheimer','director',0),('film:lb:ronin','person:actor/robert-de-niro','actor',0),('film:tmdb:500','person:tmdb_actor/380','actor',0);
INSERT INTO profile_version(version,profile_hash,created_at,r2_key,content_sha256) VALUES(1,'h','${T}','k','s');
INSERT INTO prediction_current(film_id,taste_profile_version,predicted_rating,updated_at) VALUES('film:lb:heat',1,4.5,'${T}');
INSERT INTO actual_rating VALUES('film:lb:ronin',4.0,'letterboxd','${T}');
`);

// Watchlist Films: a Letterboxd id and exactly one trusted, non-conflicting TMDB id. The catalog Film is not one of them.
const listed=await watchlistFilms(db);
assert.deepEqual(listed.films,[{filmId:'film:lb:gone',tmdbId:'404'},{filmId:'film:lb:heat',tmdbId:'949'},{filmId:'film:lb:ronin',tmdbId:'8195'}]);
assert.deepEqual(listed.skipped,[{filmId:'film:lb:nolink',reason:'no_trusted_tmdb_id'}]);

// Discovery's person format: first ten of each role in TMDB order, one credit per person and role.
const cast=Array.from({length:12},(_,i)=>({id:1000+i,name:'Актёр '+i}));
const heat={id:949,credits:{crew:[{id:638,name:'Майкл Манн',job:'Director'},{id:638,name:'Майкл Манн',job:'Writer'},{id:7,name:'Someone',job:'Producer'}],cast:[{id:1158,name:'Аль Пачино'},{id:380,name:'Роберт Де Ниро'},{id:1158,name:'Аль Пачино'},...cast.slice(0,4)]}};
const ronin={id:8195,credits:{crew:[{id:9000,name:'Джон Франкенхаймер',job:'Director'}],cast:[{id:380,name:'Роберт Де Ниро'},{id:9001,name:''}]}};
let credits=tmdbCredits(heat);
assert.deepEqual(credits.director,[{roleId:'tmdb_director/638',personId:'person:tmdb_director/638',name:'Майкл Манн'}]);
assert.deepEqual(credits.actor.map(item=>item.roleId),['tmdb_actor/1158','tmdb_actor/380','tmdb_actor/1000','tmdb_actor/1001','tmdb_actor/1002','tmdb_actor/1003']);
assert.equal(tmdbCredits({credits:{cast}}).actor.length,10);
assert.equal(tmdbCredits(ronin).actor[1].name,null);

// Fetch: discovery pace, bearer token, raw response saved privately; 404 booked and skipped, 429 stops, a saved Film is reused.
const calls=[],answers={'404':{status:404},'949':{status:200,body:heat},'8195':{status:200,body:ronin}};
const fetchImpl=async(url,init)=>{calls.push({url,auth:init.headers.Authorization});const id=url.match(/(?:movie|tv)\/(\d+)\?/)[1],a=answers[id];return new Response(a.body?JSON.stringify(a.body):'{}',{status:a.status,headers:{'Retry-After':'30'}});};
const sleeps=[];
let report=await fetchCredits({films:listed.films,dir,token:'tok',fetchImpl,sleep:async ms=>{sleeps.push(ms);},now:()=>new Date(T)});
assert.deepEqual({fetched:report.fetched,reused:report.reused,notFound:report.notFound.map(f=>f.filmId),stopped:report.stopped},{fetched:2,reused:0,notFound:['film:lb:gone'],stopped:null});
assert.deepEqual(sleeps,[200,200,200]);
assert.ok(calls.every(call=>call.auth==='Bearer tok'&&call.url.startsWith('https://api.themoviedb.org/3/movie/')&&call.url.endsWith('?language=ru-RU&append_to_response=credits')));
assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'tmdb','949.json'),'utf8')).response.id,949);
assert.equal((fs.statSync(path.join(dir,'tmdb','949.json')).mode&0o777),0o600);
calls.length=0;
report=await fetchCredits({films:listed.films,dir,token:'tok',fetchImpl,intervalMs:0});
assert.equal(report.reused,3);assert.equal(calls.length,0,'a saved answer, the 404 included, is never asked again');
fs.rmSync(path.join(dir,'tmdb','404.json'));
answers['404']={status:429};
report=await fetchCredits({films:listed.films,dir,token:'tok',fetchImpl,intervalMs:0});
assert.deepEqual(report.stopped,{reason:'rate_limited',filmId:'film:lb:gone',retryAfter:'30'});
// A transient failure is retried twice, then the run stops; nothing loops.
answers['404']={status:503};calls.length=0;
report=await fetchCredits({films:listed.films,dir,token:'tok',fetchImpl,intervalMs:0});
assert.equal(report.stopped.reason,'http_503');assert.equal(calls.length,3);
calls.length=0;
report=await fetchCredits({films:listed.films,dir,token:'tok',fetchImpl:async()=>{calls.push(1);throw new Error('reset');},intervalMs:0});
assert.equal(report.stopped.reason,'network');assert.equal(calls.length,3);
answers['404']={status:404};await fetchCredits({films:listed.films,dir,token:'tok',fetchImpl,intervalMs:0});
await assert.rejects(fetchCredits({films:listed.films,dir,token:'',fetchImpl,intervalMs:0}),{reason:'configuration'});

// Plan: reads only; new persons, a reused existing person, ordinals after the existing credits, and the coCredit pairs.
const before=rows('select count(*) n from film_person_credit')[0].n;
let plan=await buildPlan({db,dir});
assert.equal(rows('select count(*) n from film_person_credit')[0].n,before,'plan writes nothing');
assert.deepEqual(plan.missing,[]);assert.deepEqual(plan.notFound,[{filmId:'film:lb:gone',tmdbId:'404'}]);
assert.deepEqual(plan.totals,{films:3,skippedFilms:1,missingArtifacts:0,notFound:1,plannedFilms:2,tvSources:0,tmdbCredits:10,existingTmdbCredits:0,newCredits:10,newPersons:8,newAliases:7,reusedPersons:1,unnamedPersons:1,filmsWithoutTmdbCredits:0,expectedPairs:2});
const heatPlan=plan.films.find(film=>film.filmId==='film:lb:heat');
assert.deepEqual(heatPlan.writes.slice(0,3).map(w=>[w.personId,w.role,w.ordinal,w.newPerson]),[['person:tmdb_director/638','director',1,true],['person:tmdb_actor/1158','actor',2,true],['person:tmdb_actor/380','actor',3,false]]);
// Same Film, same role, same name only: Mann through his accepted localization, De Niro on both Films. Pacino and
// Frankenheimer have no accepted Russian name, so their TMDB credits are no proof; the plan never matches by name alone.
assert.deepEqual(plan.expectedPairs.map(p=>[p.letterboxd,p.tmdb,p.role,p.name,p.films.length]).sort(),[
 ['person:actor/robert-de-niro','person:tmdb_actor/380','actor','Роберт Де Ниро',2],
 ['person:director/michael-mann','person:tmdb_director/638','director','Майкл Манн',1]]);
assert.ok(filmStatements(heatPlan,T).every(([sql])=>/^INSERT INTO (person|person_alias|film_person_credit) /.test(sql)));

// Apply: one batch per Film, only additions, ordinals after the existing credits; nothing else changes.
const snapshot=table=>rows(`select * from ${table} order by 1,2`);
const untouched=['film','film_external_id','film_dimension','person_dimension','person_external_id','watchlist_film','prediction_current','actual_rating'].map(table=>[table,snapshot(table)]);
const reviewBefore=await coCreditReview(db);
assert.equal(reviewBefore.totals.coCredit,0);
const applied=await applyPlan({db,plan,now:()=>new Date(T)});
assert.deepEqual(applied,{films:2,statements:25});assert.equal(db.batches,2);
for(const [table,rowsBefore] of untouched)assert.deepEqual(snapshot(table),rowsBefore,table);
assert.deepEqual(rows(`select person_id,role,ordinal from film_person_credit where film_id='film:lb:heat' order by role desc,ordinal`).map(r=>[r.person_id,r.ordinal]),[
 ['person:director/michael-mann',0],['person:tmdb_director/638',1],['person:actor/al-pacino',0],['person:actor/robert-de-niro',1],['person:tmdb_actor/1158',2],['person:tmdb_actor/380',3],['person:tmdb_actor/1000',4],['person:tmdb_actor/1001',5],['person:tmdb_actor/1002',6],['person:tmdb_actor/1003',7]]);
assert.deepEqual(rows(`select * from person where id='person:tmdb_director/638'`),[{id:'person:tmdb_director/638',role_id:'tmdb_director/638',contract_version:1,updated_at:T}]);
assert.deepEqual(rows(`select * from person_alias where person_id='person:tmdb_director/638'`),[{person_id:'person:tmdb_director/638',kind:'name',value:'Майкл Манн',provenance_json:ALIAS_PROVENANCE}]);
assert.deepEqual(rows(`select value from person_alias where person_id='person:tmdb_actor/380'`),[{value:'Роберт Де Ниро'}],'an existing person keeps its own name');
assert.deepEqual(rows(`select count(*) n from person_alias where person_id='person:tmdb_actor/9001'`),[{n:0}],'no empty name is stored');

// The Worker's own coCredit query now shows exactly the planned pairs.
const reviewAfter=await coCreditReview(db);
assert.equal(reviewAfter.totals.coCredit,2);
assert.deepEqual(reviewAfter.coCredit.map(r=>[r.letterboxd,r.tmdb,r.role,r.films]),[['person:actor/robert-de-niro','person:tmdb_actor/380','actor',2],['person:director/michael-mann','person:tmdb_director/638','director',1]]);

// Idempotent: a new plan is empty and a repeated apply writes nothing.
const credited=rows('select count(*) n from film_person_credit')[0].n;
plan=await buildPlan({db,dir});
assert.equal(plan.totals.newCredits,0);assert.equal(plan.totals.existingTmdbCredits,10);assert.deepEqual(plan.films,[]);
assert.deepEqual(await applyPlan({db,plan}),{films:0,statements:0});
assert.equal(rows('select count(*) n from film_person_credit')[0].n,credited);
// Statements are no-ops on rows that exist, so an interrupted batch is completed and a replayed one adds nothing.
for(const [sql,params] of filmStatements(heatPlan,T))await db.run(sql,params);
assert.equal(rows('select count(*) n from film_person_credit')[0].n,credited);
// A person written without its name by an interrupted run gets the name on the next plan.
sqlite(`DELETE FROM person_alias WHERE person_id='person:tmdb_actor/1158'; DELETE FROM film_person_credit WHERE person_id='person:tmdb_actor/1158';`);
plan=await buildPlan({db,dir});
assert.deepEqual(plan.films.map(f=>f.writes.map(w=>[w.personId,w.newPerson,w.needsName])),[[['person:tmdb_actor/1158',false,true]]]);
await applyPlan({db,plan});
assert.deepEqual(rows(`select value from person_alias where person_id='person:tmdb_actor/1158'`),[{value:'Аль Пачино'}]);

// A Film without a saved answer is missing, and --apply refuses to run on an incomplete artifact.
fs.renameSync(path.join(dir,'tmdb','404.json'),path.join(root,'404.json'));
assert.deepEqual((await buildPlan({db,dir})).missing,[{filmId:'film:lb:gone',tmdbId:'404'}]);
// A miniseries: the owner maps the Film to its TMDB TV entry in sources.json. Actors are the main cast, directors come
// from aggregate_credits; the Film's own TMDB id and identity stay untouched.
const tv={id:1457,credits:{cast:[{id:5472,name:'Колин Ферт'}],crew:[]},aggregate_credits:{cast:[],crew:[{id:126951,name:'Simon Langton',jobs:[{job:'Director'}]},{id:3,name:'Writer',jobs:[{job:'Writer'}]}]}};
assert.deepEqual(tmdbCredits(tv,'tv').director.map(item=>item.roleId),['tmdb_director/126951']);
assert.deepEqual(tmdbCredits(tv).director,[],'a movie never reads aggregate_credits');
assert.equal(creditSource({filmId:'film:lb:gone',tmdbId:'404'},{'film:lb:gone':'tv/1457'}).path,'tv/1457?language=ru-RU&append_to_response=credits,aggregate_credits');
assert.throws(()=>creditSource({filmId:'film:lb:gone',tmdbId:'404'},{'film:lb:gone':'movie/1'}),{reason:'configuration'});
fs.renameSync(path.join(root,'404.json'),path.join(dir,'tmdb','404.json'));
fs.writeFileSync(path.join(dir,'sources.json'),JSON.stringify({'film:lb:gone':'tv/1457'}));
assert.deepEqual(readSources(dir),{'film:lb:gone':'tv/1457'});
calls.length=0;answers['1457']={status:200,body:tv};
report=await fetchCredits({films:listed.films,dir,token:'tok',sources:readSources(dir),fetchImpl,intervalMs:0});
assert.deepEqual([report.fetched,report.reused,calls.map(c=>c.url.split('/3/')[1])],[1,2,['tv/1457?language=ru-RU&append_to_response=credits,aggregate_credits']]);
const identity=snapshot('film_external_id');
plan=await buildPlan({db,dir});
assert.equal(plan.totals.tvSources,1);assert.deepEqual(plan.notFound,[]);
assert.deepEqual(plan.films.map(f=>[f.filmId,f.source,f.writes.map(w=>[w.personId,w.ordinal])]),[['film:lb:gone','tv/1457',[['person:tmdb_director/126951',0],['person:tmdb_actor/5472',0]]]]);
await applyPlan({db,plan});
assert.deepEqual(snapshot('film_external_id'),identity,'the TV id is a credits source only');
assert.equal((await buildPlan({db,dir})).totals.newCredits,0);
// A saved response for the wrong movie stops the plan instead of crediting another Film.
fs.writeFileSync(path.join(dir,'tmdb','8195.json'),JSON.stringify({response:{id:1}}));
await assert.rejects(buildPlan({db,dir}),{reason:'artifact_mismatch'});
fs.rmSync(root,{recursive:true,force:true});
console.log('tmdb-watchlist-credits: ok');
