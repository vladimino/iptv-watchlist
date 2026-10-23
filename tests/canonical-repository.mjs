import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createCanonicalRepository} from '../src/canonical-repository.js';

const source=fs.readFileSync('src/canonical-repository.js','utf8');
assert.doesNotMatch(source,/d1_databases|\bBUCKET\b|\bfetch\b|\bwrangler\b|INSERT INTO candidate|INSERT INTO programme_generation|INSERT INTO score_result|INSERT INTO prediction_history/);
assert.doesNotMatch(source,/film-person/);
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/canonical-repository/);
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/canonical-repository/);
assert.doesNotMatch(fs.readFileSync('src/domain/film-person.js','utf8'),/canonical-repository/);

const domain=vm.createContext({Date,Map,Set,JSON});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\nglobalThis.contract={filmView,personView,linkFilms,applyAutomaticLocalization};',domain);
const {filmView,personView,linkFilms,applyAutomaticLocalization}=domain.contract;

const NOW='2026-10-13T09:30:00.000Z';
const FRESH='2026-10-01T09:30:00.000Z';
const LATER='2026-10-14T09:30:00.000Z';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-canonical-repo-'));
const database=path.join(root,'canonical.sqlite');
exec(database,'PRAGMA foreign_keys=ON;\n'+fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
const db=openSqlite(database);
const repo=createCanonicalRepository(db);

function facts(extra={}){return {now:NOW,metadata:{present:true,metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsisPresent:true},fingerprint:{present:false},prediction:{present:false},title:{original:'The Legend of Zorro'},...extra};}
const dictionary={title:'Легенда Зорро',status:'verified',tmdbId:'1656',sources:['dictionary']};
const metadata={schemaVersion:1,year:2005,runtime:129,synopsis:'A sequel.',genres:['adventure'],peopleVersion:1,payload:{letterboxdId:'28nq'},updatedAt:NOW};
const catalog=filmView(facts({localId:'film:tmdb:1656',tmdbId:'1656',decision:{status:'verified'},title:{original:'The Legend of Zorro',dictionary}}));
const letterboxd=filmView(facts({letterboxdId:'28nq',title:{original:'The Legend of Zorro',provisional:{title:'Зорро'}}}));
const person=personView({roleId:'director/legend',original:'Martin Campbell',now:NOW,dictionary:{name:'Мартин Кэмпбелл',status:'verified',source:'dictionary'}});
const director={personId:person.id,role:'director',ordinal:0};

await repo.savePerson({person});
await repo.saveFilm({film:catalog,watchlist:true,metadata});
await repo.saveFilm({film:letterboxd,watchlist:false,metadata,credits:[director]});
const linked=linkFilms(letterboxd,catalog,LATER,{verified:true});
assert.equal(linked.ok,true);
assert.equal(linked.survivor.id,'film:28nq');
assert.equal(JSON.stringify(linked.redirect),JSON.stringify({from:'film:tmdb:1656',to:'film:28nq',at:LATER}));
const merged=await repo.applyLink({survivor:linked.survivor,redirect:linked.redirect,metadata,credits:[director]});
assert.equal(merged.id,'film:28nq');
assert.equal(merged.canonicalIdentity,'tmdb:1656');
assert.equal(merged.dimensions.localization.status,'reviewed');
assert.equal(merged.dimensions.localization.value,'Легенда Зорро');
assert.equal(merged.watchlist,true);
assert.equal(merged.metadata.year,2005);
assert.deepEqual(merged.credits,[director]);
assert.equal(merged.externalIds.find(item=>item.scheme==='tmdb'&&item.value==='1656').trusted,true);
const followed=await repo.readFilm('film:tmdb:1656');
assert.equal(followed.id,'film:28nq');
assert.equal(followed.redirectedFrom,'film:tmdb:1656');
const afterMerge=await counts();
await repo.applyLink({survivor:linked.survivor,redirect:linked.redirect,metadata,credits:[director]});
assert.deepEqual(await counts(),afterMerge);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film"),1);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film WHERE id='film:tmdb:1656'"),0);

const conflicting=filmView(facts({letterboxdId:'conflict',conflictingTmdbIds:['1656','999']}));
const storedConflict=await repo.saveFilm({film:conflicting});
assert.equal(storedConflict.canonicalIdentity,null);
assert.equal(storedConflict.dimensions.identity.status,'ambiguous');
assert.equal(storedConflict.externalIds.filter(item=>item.scheme==='tmdb'&&item.conflicting&&!item.trusted).length,2);
const occupied=filmView(facts({letterboxdId:'other',tmdbId:'1656',decision:{status:'verified'},title:{original:'The Legend of Zorro',dictionary}}));
await assert.rejects(()=>repo.saveFilm({film:occupied}),/identity_collision/);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film WHERE id='film:other'"),0);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film_redirect"),1);

const held=applyAutomaticLocalization(linked.survivor,{status:'provisional',value:'Зорро по Викиданным',source:'wikidata',provenance:{value:'Зорро по Викиданным'}},LATER);
const reviewed=await repo.saveFilm({film:held,metadata,credits:[director],watchlist:true});
assert.equal(reviewed.dimensions.localization.status,'reviewed');
assert.equal(reviewed.dimensions.localization.value,'Легенда Зорро');
assert.equal(reviewed.conflicts.some(item=>item.reason==='untrusted_review'&&item.value==='Зорро по Викиданным'),true);
const weaker={...held,localization:{...held.localization,status:'provisional',source:'wikidata',sourceVersion:'provisional',value:'Другое название',provenance:{value:'Другое название'},nextAction:'keep_provisional',updatedAt:LATER}};
const kept=await repo.saveFilm({film:weaker,metadata,credits:[director],watchlist:true});
assert.equal(kept.dimensions.localization.status,'reviewed');
assert.equal(kept.dimensions.localization.value,'Легенда Зорро');
assert.equal(kept.conflicts.filter(item=>item.reason==='reviewed_kept').length,1);
assert.equal(kept.aliases.some(item=>item.value==='Другое название'),true);
const repeated=await repo.saveFilm({film:weaker,metadata,credits:[director],watchlist:true});
assert.equal(JSON.stringify(repeated),JSON.stringify(kept));
const afterReview=await counts();
await repo.saveFilm({film:weaker,metadata,credits:[director],watchlist:true});
assert.deepEqual(await counts(),afterReview);

const beforeFailure=await counts();
const broken=filmView(facts({localId:'film:tmdb:9999',tmdbId:'9999'}));
await assert.rejects(()=>repo.saveFilm({film:broken,credits:[{personId:'person:missing',role:'actor',ordinal:0}]}));
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film WHERE id='film:tmdb:9999'"),0);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film_person_credit WHERE film_id='film:tmdb:9999'"),0);
assert.deepEqual(await counts(),beforeFailure);
assert.equal(await repo.readPerson(person.id).then(item=>item.dimensions.localization.value),'Мартин Кэмпбелл');

const reopened=createCanonicalRepository(openSqlite(database));
assert.equal(JSON.stringify(await reopened.readFilm('film:28nq')),JSON.stringify(kept));
assert.equal((await reopened.readFilm('film:tmdb:1656')).id,'film:28nq');
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM candidate'),0);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM score_result'),0);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM programme_generation'),0);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM prediction_history'),0);

async function counts(){
 const names=['film','film_redirect','film_alias','film_external_id','localization_conflict','film_person_credit','film_dimension','watchlist_film','person','person_alias'];
 const rows=await Promise.all(names.map(name=>count(db,'SELECT COUNT(*) AS n FROM '+name)));
 return Object.fromEntries(names.map((name,index)=>[name,rows[index]]));
}
async function count(databaseHandle,sql){return (await databaseHandle.get(sql)).n;}
function openSqlite(file){
 const state={buffer:null};
 return {
  run(sql,params=[]){const statement=render(sql,params)+';';if(state.buffer)state.buffer.push(statement);else exec(file,statement);return Promise.resolve();},
  get(sql,params=[]){if(state.buffer)throw new Error('Read inside the canonical transaction');return Promise.resolve(query(file,sql,params)[0]??null);},
  all(sql,params=[]){if(state.buffer)throw new Error('Read inside the canonical transaction');return Promise.resolve(query(file,sql,params));},
  async transaction(fn){
   if(state.buffer)return fn();
   state.buffer=[];
   try{await fn();exec(file,'BEGIN;\n'+state.buffer.join('\n')+'\nCOMMIT;\n');}
   finally{state.buffer=null;}
  },
 };
}
function exec(file,sql){
 const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'sqlite failed');
}
function query(file,sql,params){
 const result=spawnSync('sqlite3',['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+render(sql,params)+';',encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'sqlite failed');
 const text=result.stdout.trim();
 return text?JSON.parse(text):[];
}
function render(sql,params=[]){
 let index=0;
 const text=sql.replace(/\?/g,()=>{if(index>=params.length)throw new Error('Missing SQL parameter');return literal(params[index++]);});
 if(index!==params.length)throw new Error('Unused SQL parameter');
 return text;
}
function literal(value){
 if(value==null)return 'NULL';
 if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('Bad SQL number');return String(value);}
 if(typeof value==='boolean')return value?'1':'0';
 return "'"+String(value).replaceAll("'","''")+"'";
}
