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
// AIR-275 phase 2 (ADR 0054): the Worker carries the repository in its own scope for the enrichment projector only.
assert.match(fs.readFileSync('build.mjs','utf8'),/scoped\('src\/canonical-repository\.js','CanonicalRepository'\)/);
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

const creditFilm=filmView(facts({letterboxdId:'credit-check'}));
await repo.saveFilm({film:creditFilm,credits:[director]});
const preservedCredits=await repo.saveFilm({film:creditFilm});
assert.equal(JSON.stringify(preservedCredits.credits),JSON.stringify([director]));
const clearedCredits=await repo.saveFilm({film:creditFilm,credits:[]});
assert.equal(clearedCredits.credits.length,0);

const hopDictionary={title:'Первый',status:'verified',tmdbId:'301',sources:['dictionary']};
const hopA=filmView(facts({localId:'film:hop-a',tmdbId:'301',decision:{status:'verified'},title:{original:'First',dictionary:hopDictionary}}));
const hopB=filmView(facts({localId:'film:hop-b',tmdbId:'302'}));
const hopC=filmView(facts({localId:'film:hop-c',tmdbId:'303'}));
const hopActor=personView({roleId:'actor/hop',original:'Hop Actor',now:NOW});
await repo.savePerson({person:hopActor});
await repo.saveFilm({film:hopA,credits:[director]});
const hopWeak={...hopA,localization:{...hopA.localization,status:'provisional',source:'wikidata',sourceVersion:'provisional',value:'Черновик',provenance:{value:'Черновик'},nextAction:'keep_provisional',updatedAt:LATER}};
const hopStored=await repo.saveFilm({film:hopWeak,credits:[director]});
assert.equal(hopStored.conflicts.some(item=>item.value==='Черновик'),true);
await repo.saveFilm({film:hopB,credits:[{personId:hopActor.id,role:'actor',ordinal:0}]});
await repo.saveFilm({film:hopC});
await repo.applyLink({survivor:hopB,redirect:{from:hopA.id,to:hopB.id,at:LATER}});
await repo.applyLink({survivor:hopC,redirect:{from:hopB.id,to:hopC.id,at:LATER}});
const reopenedHops=createCanonicalRepository(openSqlite(database));
const viaA=await reopenedHops.readFilm(hopA.id);
const viaB=await reopenedHops.readFilm(hopB.id);
assert.equal(viaA.id,'film:hop-c');
assert.equal(viaB.id,'film:hop-c');
assert.equal(viaA.redirectedFrom,hopA.id);
assert.equal(viaB.redirectedFrom,hopB.id);
assert.equal(viaA.conflicts.some(item=>item.value==='Черновик'),true);
assert.equal(viaB.conflicts.some(item=>item.value==='Черновик'),true);
assert.equal(viaA.aliases.some(item=>item.value==='Черновик'),true);
assert.equal(viaA.credits.some(item=>item.personId===director.personId&&item.role==='director'),true);
assert.equal(viaA.credits.some(item=>item.personId===hopActor.id&&item.role==='actor'),true);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film WHERE id IN ('film:hop-a','film:hop-b')"),0);
const beforeReplay=await repo.readFilm('film:hop-c');
const hopRedirects=await count(db,'SELECT COUNT(*) AS n FROM film_redirect');
await repo.applyLink({survivor:hopC,redirect:{from:hopB.id,to:hopC.id,at:LATER}});
const afterReplay=await repo.readFilm('film:hop-c');
assert.equal(JSON.stringify(afterReplay),JSON.stringify(beforeReplay));
const reopenedReplay=createCanonicalRepository(openSqlite(database));
assert.equal(JSON.stringify(await reopenedReplay.readFilm('film:hop-c')),JSON.stringify(beforeReplay));
assert.equal(recordBody(await reopenedReplay.readFilm(hopA.id)),recordBody(beforeReplay));
assert.equal(recordBody(await reopenedReplay.readFilm(hopB.id)),recordBody(beforeReplay));
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM film_redirect'),hopRedirects);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film WHERE id='film:hop-c'"),1);

const raceFilm=filmView(facts({letterboxdId:'race-film',title:{original:'Race',provisional:{title:'Предварительное'}}}));
await repo.saveFilm({film:raceFilm,credits:[director]});
const ownerValue='Название владельца';
const ownerFilm={...raceFilm,aliases:[...(raceFilm.aliases||[]),{kind:'title',value:'Заметка владельца',provenance:{source:'owner'}}],localization:{...raceFilm.localization,status:'reviewed',source:'owner',sourceVersion:'owner',value:ownerValue,provenance:{authority:'owner',value:ownerValue},nextAction:'keep_reviewed',updatedAt:LATER}};
const staleFilm={...raceFilm,localization:{...raceFilm.localization,status:'provisional',source:'wikidata',sourceVersion:'provisional',value:'Устаревшее',provenance:{value:'Устаревшее'},nextAction:'keep_provisional',updatedAt:LATER}};
db.beforeTransaction(async()=>{await repo.saveFilm({film:ownerFilm,credits:[director]});});
const raced=await repo.saveFilm({film:staleFilm});
assert.equal(raced.dimensions.localization.value,ownerValue);
assert.equal(raced.dimensions.localization.provenance.authority,'owner');
assert.equal(JSON.stringify(raced.credits),JSON.stringify([director]));
assert.equal(raced.aliases.some(item=>item.value==='Устаревшее'),true);
assert.equal(raced.aliases.some(item=>item.value==='Заметка владельца'),true);
assert.equal(raced.conflicts.filter(item=>item.reason==='owner_kept'&&item.value==='Устаревшее').length,1);
const dictionaryFilm={...ownerFilm,localization:{...ownerFilm.localization,source:'dictionary',sourceVersion:'verified',value:'Словарное название',provenance:{authority:'dictionary',value:'Словарное название',sources:['dictionary']},updatedAt:LATER}};
const afterDictionary=await repo.saveFilm({film:dictionaryFilm,credits:[director]});
assert.equal(afterDictionary.dimensions.localization.value,ownerValue);
assert.equal(afterDictionary.dimensions.localization.provenance.authority,'owner');
assert.equal(afterDictionary.aliases.some(item=>item.value==='Словарное название'),true);
assert.equal(afterDictionary.aliases.some(item=>item.value==='Заметка владельца'),true);
assert.equal(afterDictionary.conflicts.filter(item=>item.reason==='owner_kept'&&item.value==='Словарное название').length,1);

const racePerson=personView({roleId:'actor/race',original:'Race Person',now:NOW});
await repo.savePerson({person:racePerson});
const ownerPerson={...racePerson,aliases:[...(racePerson.aliases||[]),{kind:'name',value:'Заметка владельца',provenance:{source:'owner'}}],localization:{...racePerson.localization,status:'reviewed',source:'owner',sourceVersion:'owner',value:'Имя владельца',provenance:{authority:'owner',value:'Имя владельца'},nextAction:'keep_reviewed',updatedAt:LATER}};
const stalePerson={...racePerson,localization:{...racePerson.localization,status:'provisional',source:'wikidata',sourceVersion:'provisional',value:'Старое имя',provenance:{value:'Старое имя'},nextAction:'keep_provisional',updatedAt:LATER}};
db.beforeTransaction(async()=>{await repo.savePerson({person:ownerPerson});});
const racedPerson=await repo.savePerson({person:stalePerson});
assert.equal(racedPerson.dimensions.localization.value,'Имя владельца');
assert.equal(racedPerson.dimensions.localization.provenance.authority,'owner');
assert.equal(racedPerson.aliases.some(item=>item.value==='Старое имя'),true);
assert.equal(racedPerson.aliases.some(item=>item.value==='Заметка владельца'),true);
assert.equal(racedPerson.conflicts.filter(item=>item.reason==='owner_kept'&&item.value==='Старое имя').length,1);
const dictionaryPerson={...ownerPerson,localization:{...ownerPerson.localization,source:'dictionary',sourceVersion:'verified',value:'Словарное имя',provenance:{authority:'dictionary',value:'Словарное имя'},updatedAt:LATER}};
const heldPerson=await repo.savePerson({person:dictionaryPerson});
assert.equal(heldPerson.dimensions.localization.value,'Имя владельца');
assert.equal(heldPerson.dimensions.localization.provenance.authority,'owner');
assert.equal(heldPerson.aliases.some(item=>item.value==='Словарное имя'),true);
assert.equal(heldPerson.aliases.some(item=>item.value==='Заметка владельца'),true);
assert.equal(heldPerson.conflicts.filter(item=>item.reason==='owner_kept'&&item.value==='Словарное имя').length,1);

function recordBody(record){const {redirectedFrom,...body}=record;return JSON.stringify(body);}
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
  beforeTransaction(fn){state.beforeTransaction=fn;},
  async transaction(fn){
   if(state.buffer)return fn();
   if(state.beforeTransaction){const hook=state.beforeTransaction;state.beforeTransaction=null;await hook();}
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
