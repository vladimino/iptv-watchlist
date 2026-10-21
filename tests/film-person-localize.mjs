import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const titles=JSON.parse(fs.readFileSync('data/film-titles.json','utf8'));
const names=JSON.parse(fs.readFileSync('data/person-names.json','utf8'));
const ctx=vm.createContext({FILM_TITLE_DICTIONARY:titles,PERSON_NAME_DICTIONARY:names,Date,Map,Set,JSON,Object});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/sources.js','utf8'),ctx);
const {applyCachedTitle,applyCachedPersonName,applyReviewedPerson}=ctx;

const reviewed={id:'28nq',tmdbId:'1656',title:'Легенда Зорро',titleRu:'Легенда Зорро',titleStatus:'verified',original:'The Legend of Zorro',aliases:['The Legend of Zorro']};
applyCachedTitle(reviewed,{tmdbId:'1656',title:'Другое название',status:'provisional',sources:['https://www.wikidata.org/wiki/Q1']});
assert.equal(reviewed.title,'Легенда Зорро');
assert.equal(reviewed.titleRu,'Легенда Зорро');
assert.equal(reviewed.titleStatus,'verified');
assert.equal(reviewed.aliases.includes('Другое название'),true);

const mismatched={id:'28nq',tmdbId:'9999999',title:'Легенда Зорро',titleRu:'Легенда Зорро',titleStatus:'verified',original:'The Legend of Zorro',aliases:[]};
applyCachedTitle(mismatched,{tmdbId:'9999999',title:'Чужое',status:'provisional',sources:['https://www.wikidata.org/wiki/Q1']});
assert.equal(mismatched.title,'Легенда Зорро');
assert.equal(mismatched.titleStatus,'verified');

const claimed={id:'fresh',tmdbId:'1',title:'English',original:'English',aliases:['English']};
applyCachedTitle(claimed,{tmdbId:'1',title:'Из кэша',status:'verified',sources:['https://www.wikidata.org/wiki/Q1']});
assert.equal(claimed.title,'English');
assert.equal(claimed.titleStatus,undefined);
applyCachedTitle(claimed,{tmdbId:'1',title:'Черновик',status:'provisional',sources:['https://www.wikidata.org/wiki/Q1']});
assert.equal(claimed.title,'Черновик');
assert.equal(claimed.titleRu,'Черновик');
assert.equal(claimed.titleStatus,'provisional');

const verified=names.find(person=>person.status==='verified');
const kept={id:verified.id,name:'Other Name',original:verified.original,nameStatus:'verified',aliases:[]};
applyCachedPersonName(kept,{name:'Автоматическое',original:verified.original});
assert.equal(kept.name,'Other Name');
assert.equal(kept.nameStatus,'verified');
assert.equal(kept.aliases.includes('Автоматическое'),true);

const provisional=names.find(person=>person.id==='actor/delia-enea');
const transcribed={id:provisional.id,name:provisional.original,original:provisional.original};
applyReviewedPerson(transcribed);
assert.equal(transcribed.name,provisional.name);
assert.equal(transcribed.nameStatus,'provisional');

const sources=fs.readFileSync('src/sources.js','utf8');
const worker=fs.readFileSync('src/worker.js','utf8');
for(const file of [sources,worker])assert.doesNotMatch(file,/filmView|readLifecycle|backfillLifecycle|invalidatePredictionForProfile|availabilityProjection/);
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/film-person-reader|film-person-backfill/);
console.log('Lifecycle localization guard passed.');
