import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const titles=JSON.parse(fs.readFileSync('data/film-titles.json','utf8'));
const names=JSON.parse(fs.readFileSync('data/person-names.json','utf8'));
const dictionaryTitle=titles.find(film=>film.id==='28nq').title;
const verified=names.find(person=>person.status==='verified');
const provisional=names.find(person=>person.id==='actor/delia-enea');
const source='https://www.wikidata.org/wiki/Q1';
const ctx=vm.createContext({FILM_TITLE_DICTIONARY:titles,PERSON_NAME_DICTIONARY:names,Date,Map,Set,JSON,Object,URL,URLSearchParams,AbortSignal,structuredClone,fetch:async()=>({ok:true,json:async()=>({results:{bindings:[]}})}),Response,Request});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/sources.js','utf8'),ctx);
const {applyCachedTitle,applyCachedPersonName,applyReviewedPerson,applyReviewedTitle,reviewedPeople,metadataLocalizationMode,localizeFilmTitles,localizePeople,applyEpgLocalization,presentLocalized}=ctx;

// LIFECYCLE_LOCALIZATION selects the metadata sync's localization only, default off; the retired path tokens are inert.
assert.equal(metadataLocalizationMode({}),'off');
assert.equal(metadataLocalizationMode({LIFECYCLE_LOCALIZATION:'on:programme,on:watchlist,on:epg'}),'off');
assert.equal(metadataLocalizationMode({LIFECYCLE_LOCALIZATION:'shadow,on'}),'off');
assert.equal(metadataLocalizationMode({LIFECYCLE_LOCALIZATION:'on'}),'off');
assert.equal(metadataLocalizationMode({LIFECYCLE_LOCALIZATION:'nope:metadata'}),'off');
assert.equal(metadataLocalizationMode({LIFECYCLE_LOCALIZATION:['on:metadata']}),'off');
assert.equal(metadataLocalizationMode({LIFECYCLE_LOCALIZATION:'on:epg, on:metadata'}),'on');
assert.equal(metadataLocalizationMode({LIFECYCLE_LOCALIZATION:'shadow:metadata'}),'shadow');
assert.equal(metadataLocalizationMode({LIFECYCLE_LOCALIZATION:'on:metadata,shadow:metadata'}),'shadow');
assert.equal(metadataLocalizationMode({LIFECYCLE_LOCALIZATION:'shadow:metadata,on:metadata'}),'on');

const reviewed={id:'28nq',tmdbId:'1656',title:dictionaryTitle,titleRu:dictionaryTitle,titleStatus:'verified',original:'The Legend of Zorro',aliases:['The Legend of Zorro']};
applyCachedTitle(reviewed,{tmdbId:'1656',title:'Другое название',status:'provisional',sources:[source]},'on');
assert.equal(reviewed.title,dictionaryTitle);
assert.equal(reviewed.titleRu,dictionaryTitle);
assert.equal(reviewed.titleStatus,'verified');
assert.equal(reviewed.aliases.includes('Другое название'),true);

const mismatched={id:'28nq',tmdbId:'9999999',title:dictionaryTitle,titleRu:dictionaryTitle,titleStatus:'verified',original:'The Legend of Zorro',aliases:[]};
applyCachedTitle(mismatched,{tmdbId:'9999999',title:'Чужое',status:'provisional',sources:[source]},'on');
assert.equal(mismatched.title,dictionaryTitle);
assert.equal(mismatched.titleStatus,'verified');

const claimed={id:'fresh',tmdbId:'1',title:'English',original:'English',aliases:['English']};
applyCachedTitle(claimed,{tmdbId:'1',title:'Из кэша',status:'verified',sources:[source]},'on');
assert.equal(claimed.title,'Из кэша');
assert.equal(claimed.titleRu,'Из кэша');
assert.equal(claimed.titleStatus,'provisional');
const drafted={id:'fresh',tmdbId:'1',title:'English',original:'English',aliases:['English']};
applyCachedTitle(drafted,{tmdbId:'1',title:'Черновик',status:'provisional',sources:[source]},'on');
assert.equal(drafted.title,'Черновик');
assert.equal(drafted.titleRu,'Черновик');
assert.equal(drafted.titleStatus,'provisional');
const legacyClaimed={id:'fresh',tmdbId:'1',title:'English',original:'English',aliases:[]};
applyCachedTitle(legacyClaimed,{tmdbId:'1',title:'Из кэша',status:'verified',sources:[source]});
assert.equal(legacyClaimed.title,'Из кэша');
assert.equal(legacyClaimed.titleStatus,'verified');

const kept={id:verified.id,name:'Other Name',original:verified.original,nameStatus:'verified',aliases:[],nameVerificationBasis:'owner'};
applyCachedPersonName(kept,{name:'Автоматическое',original:verified.original},'on');
assert.equal(kept.name,'Other Name');
assert.equal(kept.nameStatus,'verified');
assert.equal(kept.nameVerificationBasis,'owner');
assert.equal(kept.aliases.includes('Автоматическое'),true);

const ownerPerson={id:verified.id,name:'Своё имя',original:verified.original,nameStatus:'verified',nameAuthority:'owner',aliases:[]};
applyReviewedPerson(ownerPerson,'on');
assert.equal(ownerPerson.name,'Своё имя');
assert.equal(ownerPerson.nameStatus,'verified');
assert.equal(ownerPerson.nameConflicts.length,1);
assert.equal(ownerPerson.nameConflicts[0].value,verified.name);
assert.equal(ownerPerson.nameConflicts[0].reason,'owner_kept');
assert.equal(ownerPerson.aliases.includes(verified.name),true);
const ownerPersonJson=JSON.stringify(ownerPerson);
applyReviewedPerson(ownerPerson,'on');
assert.equal(JSON.stringify(ownerPerson),ownerPersonJson);
const replacedPerson={id:verified.id,name:'Своё имя',original:verified.original,nameStatus:'verified',aliases:[]};
applyReviewedPerson(replacedPerson);
assert.equal(replacedPerson.name,verified.name);
const priorPerson={id:verified.id,name:'Старое словарное',original:verified.original,nameStatus:'verified',nameVerificationBasis:verified.verification_basis,nameSource:verified.source_url??null,aliases:[]};
applyReviewedPerson(priorPerson,'on');
assert.equal(priorPerson.name,verified.name);
assert.equal(priorPerson.nameConflicts,undefined);
assert.equal(priorPerson.aliases.includes('Старое словарное'),true);
const unknownPerson={id:verified.id,name:'Чужое имя',original:verified.original,nameStatus:'verified',aliases:[]};
applyReviewedPerson(unknownPerson,'on');
assert.equal(unknownPerson.name,'Чужое имя');
assert.equal(unknownPerson.nameConflicts.length,1);
assert.equal(unknownPerson.nameConflicts[0].reason,'unresolved');
assert.equal(unknownPerson.nameConflicts[0].authority,'unknown');
applyReviewedPerson(unknownPerson,'on');
assert.equal(unknownPerson.nameConflicts.length,1);

const transcribed={id:provisional.id,name:provisional.original,original:provisional.original};
applyReviewedPerson(transcribed,'on');
assert.equal(transcribed.name,provisional.name);
assert.equal(transcribed.nameStatus,'provisional');
const missingPerson={id:provisional.id,name:provisional.original,original:provisional.original};
applyReviewedPerson(missingPerson);
assert.equal(missingPerson.name,provisional.name);
assert.equal(missingPerson.nameStatus,'provisional');

const ownerFilm={id:'28nq',tmdbId:'1656',title:'Своё',titleRu:'Своё',titleStatus:'verified',titleAuthority:'owner',original:'The Legend of Zorro',aliases:[]};
applyReviewedTitle(ownerFilm,'on');
assert.equal(ownerFilm.title,'Своё');
assert.equal(ownerFilm.titleRu,'Своё');
assert.equal(ownerFilm.titleStatus,'verified');
assert.equal(ownerFilm.titleConflicts.length,1);
assert.equal(ownerFilm.titleConflicts[0].value,dictionaryTitle);
assert.equal(ownerFilm.titleConflicts[0].reason,'owner_kept');
assert.equal(ownerFilm.aliases.includes(dictionaryTitle),true);
const ownerFilmJson=JSON.stringify(ownerFilm);
applyReviewedTitle(ownerFilm,'on');
assert.equal(JSON.stringify(ownerFilm),ownerFilmJson);
const replacedFilm={id:'28nq',tmdbId:'1656',title:'Своё',titleRu:'Своё',titleStatus:'verified',original:'The Legend of Zorro',aliases:[]};
applyReviewedTitle(replacedFilm);
assert.equal(replacedFilm.title,dictionaryTitle);
assert.equal(replacedFilm.titleStatus,'verified');
const dictionaryRow=titles.find(film=>film.id==='28nq');
const priorFilm={id:'28nq',tmdbId:'1656',title:'Старый словарь',titleRu:'Старый словарь',titleStatus:'verified',titleSources:dictionaryRow.sources,original:'The Legend of Zorro',aliases:[]};
applyReviewedTitle(priorFilm,'on');
assert.equal(priorFilm.title,dictionaryTitle);
assert.equal(priorFilm.titleConflicts,undefined);
assert.equal(priorFilm.aliases.includes('Старый словарь'),true);
const unknownFilm={id:'28nq',tmdbId:'1656',title:'Неизвестное',titleRu:'Неизвестное',titleStatus:'verified',original:'The Legend of Zorro',aliases:[]};
applyReviewedTitle(unknownFilm,'on');
assert.equal(unknownFilm.title,'Неизвестное');
assert.equal(unknownFilm.titleConflicts.length,1);
assert.equal(unknownFilm.titleConflicts[0].reason,'unresolved');
assert.equal(unknownFilm.titleConflicts[0].authority,'unknown');
applyReviewedTitle(unknownFilm,'on');
assert.equal(unknownFilm.titleConflicts.length,1);

const missingFilm={id:'28nq',tmdbId:'1656',title:'English',original:'The Legend of Zorro',aliases:[]};
applyReviewedTitle(missingFilm,'on');
assert.equal(missingFilm.title,dictionaryTitle);
assert.equal(missingFilm.titleStatus,'verified');
const draftFilm={id:'28nq',tmdbId:'1656',title:'Черновик',titleRu:'Черновик',titleStatus:'provisional',original:'The Legend of Zorro',aliases:[]};
applyReviewedTitle(draftFilm,'on');
assert.equal(draftFilm.title,dictionaryTitle);
assert.equal(draftFilm.titleStatus,'verified');

const ownerReviewedPerson={id:verified.id,name:'Своё reviewed',original:verified.original,nameStatus:'reviewed',nameAuthority:'owner',aliases:[]};
applyReviewedPerson(ownerReviewedPerson,'on');
assert.equal(ownerReviewedPerson.name,'Своё reviewed');
assert.equal(ownerReviewedPerson.nameStatus,'reviewed');
assert.equal(ownerReviewedPerson.nameAuthority,'owner');
assert.equal(ownerReviewedPerson.nameConflicts.length,1);
assert.equal(ownerReviewedPerson.nameConflicts[0].value,verified.name);
assert.equal(ownerReviewedPerson.nameConflicts[0].reason,'owner_kept');
assert.equal(ownerReviewedPerson.nameConflicts[0].authority,'owner');
assert.equal(ownerReviewedPerson.aliases.includes(verified.name),true);
const ownerReviewedPersonJson=JSON.stringify(ownerReviewedPerson);
applyReviewedPerson(ownerReviewedPerson,'on');
assert.equal(JSON.stringify(ownerReviewedPerson),ownerReviewedPersonJson);
const dictionaryReviewedPerson={id:verified.id,name:'Старое reviewed',original:verified.original,nameStatus:'reviewed',nameAuthority:'dictionary',aliases:[]};
applyReviewedPerson(dictionaryReviewedPerson,'on');
assert.equal(dictionaryReviewedPerson.name,verified.name);
assert.equal(dictionaryReviewedPerson.nameConflicts,undefined);
assert.equal(dictionaryReviewedPerson.aliases.includes('Старое reviewed'),true);
const basisReviewedPerson={id:verified.id,name:'Старое основание',original:verified.original,nameStatus:'reviewed',nameVerificationBasis:verified.verification_basis,nameSource:verified.source_url??null,aliases:[]};
applyReviewedPerson(basisReviewedPerson,'on');
assert.equal(basisReviewedPerson.name,verified.name);
assert.equal(basisReviewedPerson.nameConflicts,undefined);
assert.equal(basisReviewedPerson.aliases.includes('Старое основание'),true);
const unknownReviewedPerson={id:verified.id,name:'Чужое reviewed',original:verified.original,nameStatus:'reviewed',aliases:[]};
applyReviewedPerson(unknownReviewedPerson,'on');
assert.equal(unknownReviewedPerson.name,'Чужое reviewed');
assert.equal(unknownReviewedPerson.nameStatus,'reviewed');
assert.equal(unknownReviewedPerson.nameConflicts.length,1);
assert.equal(unknownReviewedPerson.nameConflicts[0].reason,'unresolved');
assert.equal(unknownReviewedPerson.nameConflicts[0].authority,'unknown');
applyReviewedPerson(unknownReviewedPerson,'on');
assert.equal(unknownReviewedPerson.nameConflicts.length,1);

const ownerReviewedFilm={id:'28nq',tmdbId:'1656',title:'Своё reviewed',titleRu:'Своё reviewed',titleStatus:'reviewed',titleAuthority:'owner',original:'The Legend of Zorro',aliases:[]};
applyReviewedTitle(ownerReviewedFilm,'on');
assert.equal(ownerReviewedFilm.title,'Своё reviewed');
assert.equal(ownerReviewedFilm.titleRu,'Своё reviewed');
assert.equal(ownerReviewedFilm.titleStatus,'reviewed');
assert.equal(ownerReviewedFilm.titleAuthority,'owner');
assert.equal(ownerReviewedFilm.titleConflicts.length,1);
assert.equal(ownerReviewedFilm.titleConflicts[0].value,dictionaryTitle);
assert.equal(ownerReviewedFilm.titleConflicts[0].reason,'owner_kept');
assert.equal(ownerReviewedFilm.titleConflicts[0].authority,'owner');
assert.equal(ownerReviewedFilm.aliases.includes(dictionaryTitle),true);
const ownerReviewedFilmJson=JSON.stringify(ownerReviewedFilm);
applyReviewedTitle(ownerReviewedFilm,'on');
assert.equal(JSON.stringify(ownerReviewedFilm),ownerReviewedFilmJson);
const dictionaryReviewedFilm={id:'28nq',tmdbId:'1656',title:'Старый словарь',titleRu:'Старый словарь',titleStatus:'reviewed',titleAuthority:'dictionary',original:'The Legend of Zorro',aliases:[]};
applyReviewedTitle(dictionaryReviewedFilm,'on');
assert.equal(dictionaryReviewedFilm.title,dictionaryTitle);
assert.equal(dictionaryReviewedFilm.titleConflicts,undefined);
assert.equal(dictionaryReviewedFilm.aliases.includes('Старый словарь'),true);
const sourcesReviewedFilm={id:'28nq',tmdbId:'1656',title:'Старые источники',titleRu:'Старые источники',titleStatus:'reviewed',titleSources:dictionaryRow.sources,original:'The Legend of Zorro',aliases:[]};
applyReviewedTitle(sourcesReviewedFilm,'on');
assert.equal(sourcesReviewedFilm.title,dictionaryTitle);
assert.equal(sourcesReviewedFilm.titleConflicts,undefined);
assert.equal(sourcesReviewedFilm.aliases.includes('Старые источники'),true);
const unknownReviewedFilm={id:'28nq',tmdbId:'1656',title:'Неизвестное reviewed',titleRu:'Неизвестное reviewed',titleStatus:'reviewed',original:'The Legend of Zorro',aliases:[]};
applyReviewedTitle(unknownReviewedFilm,'on');
assert.equal(unknownReviewedFilm.title,'Неизвестное reviewed');
assert.equal(unknownReviewedFilm.titleRu,'Неизвестное reviewed');
assert.equal(unknownReviewedFilm.titleStatus,'reviewed');
assert.equal(unknownReviewedFilm.titleConflicts.length,1);
assert.equal(unknownReviewedFilm.titleConflicts[0].reason,'unresolved');
assert.equal(unknownReviewedFilm.titleConflicts[0].authority,'unknown');
applyReviewedTitle(unknownReviewedFilm,'on');
assert.equal(unknownReviewedFilm.titleConflicts.length,1);

const cachedPerson={id:'actor/cache-only',name:'Старое',nameStatus:'provisional',aliases:[],original:'Old',nameVerificationBasis:'kept'};
applyCachedPersonName(cachedPerson,{name:'Новое',original:'Old'},'on');
assert.equal(cachedPerson.name,'Новое');
assert.equal(cachedPerson.nameStatus,'provisional');
assert.equal(cachedPerson.nameSource,'wikidata');
assert.equal(cachedPerson.nameVerificationBasis,'kept');
assert.equal(cachedPerson.aliases.includes('Старое'),true);
const englishPerson={id:'actor/cache-only',name:'English',original:'English',aliases:[]};
applyCachedPersonName(englishPerson,{name:'Русское',original:'English'},'on');
assert.equal(englishPerson.name,'Русское');
assert.equal(englishPerson.nameStatus,'provisional');
assert.equal(englishPerson.nameSource,'wikidata');
assert.equal(englishPerson.aliases.includes('English'),true);

const carrier={id:'carrier',tmdbId:'1',title:'English',original:'English',directors:[],actors:[cachedPerson]};
const peopleCache={'actor/cache-only':{name:'Новое',original:'Old'}};
await localizePeople([carrier],peopleCache,'on');
applyEpgLocalization([carrier],peopleCache,'on');
reviewedPeople({films:[carrier]},'on');
assert.equal(cachedPerson.name,'Новое');
assert.equal(cachedPerson.nameStatus,'provisional');
assert.equal(cachedPerson.aliases.includes('Старое'),true);
const personSnapshot=JSON.stringify(cachedPerson);
await localizePeople([carrier],peopleCache,'on');
applyEpgLocalization([carrier],peopleCache,'on');
reviewedPeople({films:[carrier]},'on');
assert.equal(JSON.stringify(cachedPerson),personSnapshot);

const fresh={id:'fresh',tmdbId:'1',title:'English',original:'English',aliases:[],directors:[],actors:[]};
const titleCache={fresh:{tmdbId:'1',title:'Из кэша',status:'verified',sources:[source]}};
await localizeFilmTitles([fresh],titleCache,'on');
applyEpgLocalization([fresh],{},'on');
const viewed=presentLocalized({films:[fresh]},titleCache);
assert.equal(viewed.films[0].title,'Из кэша');
assert.equal(viewed.films[0].titleStatus,'provisional');
const freshSnapshot=JSON.stringify(fresh);
await localizeFilmTitles([fresh],titleCache,'on');
applyEpgLocalization([fresh],{});
presentLocalized({films:[fresh]},titleCache);
assert.equal(JSON.stringify(fresh),freshSnapshot);

const ownerLive=[{id:'28nq',tmdbId:'1656',title:'Своё',titleRu:'Своё',titleStatus:'verified',original:'The Legend of Zorro',aliases:[],directors:[],actors:[]}];
// The metadata sync keeps its default-off legacy localization: no mode and 'off' are the same legacy result.
const offCopy=structuredClone(ownerLive),again=structuredClone(ownerLive);
await localizeFilmTitles(offCopy,{});
await localizeFilmTitles(again,{},'off');
assert.equal(JSON.stringify(offCopy),JSON.stringify(again));
assert.equal(offCopy[0].title,dictionaryTitle);
assert.equal(offCopy[0].titleConflicts,undefined);
// The EPG commit localizes through the domain rule whatever a caller passes: an unexplained verified title is kept
// with an unresolved conflict instead of being overwritten, and the result is one and the same for every legacy mode word.
const epgDomain=structuredClone(ownerLive);
applyEpgLocalization(epgDomain,{});
assert.equal(epgDomain[0].title,'Своё');
assert.equal(epgDomain[0].titleStatus,'verified');
assert.equal(epgDomain[0].titleConflicts.length,1);
assert.equal(epgDomain[0].titleConflicts[0].reason,'unresolved');
assert.equal(epgDomain[0].titleConflicts[0].value,dictionaryTitle);
assert.equal(epgDomain[0].aliases.includes(dictionaryTitle),true);
for(const stale of ['off','shadow','on',undefined,null]){const copy=structuredClone(ownerLive);applyEpgLocalization(copy,{},stale);assert.equal(JSON.stringify(copy),JSON.stringify(epgDomain));}
assert.equal(applyEpgLocalization.length,2);
assert.equal(presentLocalized.length,2);
const epgTitles=structuredClone(ownerLive);
await localizeFilmTitles(epgTitles,{},'on');
assert.equal(JSON.stringify(epgTitles),JSON.stringify(epgDomain));
assert.notEqual(JSON.stringify(epgDomain),JSON.stringify(offCopy));
// The reads apply the same rule; a caller's stale mode word changes nothing.
const readerDomain=presentLocalized({films:structuredClone(ownerLive)},{});
assert.equal(readerDomain.films[0].title,'Своё');
assert.equal(readerDomain.films[0].titleConflicts[0].reason,'unresolved');
for(const stale of ['off','shadow','on']){const copy=presentLocalized({films:structuredClone(ownerLive)},{},stale);assert.equal(JSON.stringify(copy),JSON.stringify(readerDomain));}
function assertUnits(count){assert.ok(count.films.mismatched<=count.films.compared);assert.ok(count.films.displayed<=count.films.mismatched);assert.ok(count.people.mismatched<=count.people.compared);assert.ok(count.people.displayed<=count.people.mismatched);assert.ok(count.cache.mismatched<=count.cache.compared);}
// shadow:metadata still measures the metadata sync's two localizations without changing the stored result.
const statusFilm=[{id:'fresh',tmdbId:'1',title:'English',original:'English',aliases:[],directors:[],actors:[]}];
const statusCache={fresh:{tmdbId:'1',title:'Из кэша',status:'verified',sources:[source]}};
const statusShadow=structuredClone(statusFilm),statusOff=structuredClone(statusFilm);
const statusCount=await localizeFilmTitles(statusShadow,structuredClone(statusCache),'shadow');
await localizeFilmTitles(statusOff,structuredClone(statusCache),'off');
assert.equal(JSON.stringify(statusShadow),JSON.stringify(statusOff));
assert.equal(statusOff[0].titleStatus,'verified');
assert.equal(statusCount.films.compared,1);
assert.equal(statusCount.films.mismatched,1);
assert.equal(statusCount.films.displayed,0);
assert.equal(statusCount.cache.mismatched,0);
assertUnits(statusCount);
const cachePerson={id:verified.id,name:'Своё имя',original:verified.original,nameStatus:'verified',nameAuthority:'owner',aliases:[]};
const cacheCount=await localizePeople([{id:'one',tmdbId:'1',title:'English',directors:[],actors:[cachePerson]}],{},'shadow');
assert.equal(cacheCount.films.compared,1);
assert.equal(cacheCount.cache.compared,1);
assert.equal(cacheCount.cache.mismatched,1);
assert.equal(cacheCount.people.compared,1);
assert.equal(cacheCount.people.mismatched,1);
assert.equal(cacheCount.people.displayed,1);
assertUnits(cacheCount);
// Owner-authored names survive the EPG commit and the reads with an owner_kept conflict; the legacy overwrite is gone.
const actorSamples=names.filter(person=>person.status==='verified').slice(0,3);
const actors=actorSamples.map(person=>({id:person.id,name:'Owner '+person.id,original:person.original,nameStatus:'verified',nameAuthority:'owner',aliases:[]}));
const many={id:'many',tmdbId:'9',title:'English',original:'English',aliases:[],directors:[],actors};
const stored={};for(const actor of actors)stored[actor.id]={name:'Кэш '+actor.id};
const manyEpg=structuredClone(many);
applyEpgLocalization([manyEpg],stored);
for(const [i,actor] of manyEpg.actors.entries()){assert.equal(actor.name,'Owner '+actorSamples[i].id);assert.equal(actor.nameConflicts.length,1);assert.equal(actor.nameConflicts[0].reason,'owner_kept');assert.equal(actor.aliases.includes(actorSamples[i].name),true);}
const peoplePayload={films:[{id:'fresh',tmdbId:'1',title:'English',original:'English',aliases:[],directors:[],actors:structuredClone(actors)}],people:{directors:[],actors:structuredClone(actors)}};
const peopleRead=presentLocalized(structuredClone(peoplePayload),{});
for(const list of [peopleRead.films[0].actors,peopleRead.people.actors])for(const [i,actor] of list.entries()){assert.equal(actor.name,'Owner '+actorSamples[i].id);assert.equal(actor.nameConflicts[0].reason,'owner_kept');assert.equal(actor.nameConflicts[0].authority,'owner');}

vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),ctx);
const run={};
ctx.recordLifecycle(run,'metadata','off',{films:{compared:1,mismatched:1,displayed:0},people:{compared:0,mismatched:0,displayed:0},cache:{compared:0,mismatched:0}});
assert.equal(run.lifecycleLocalization,undefined);
ctx.recordLifecycle(run,'metadata','shadow',{films:{compared:1,mismatched:1,displayed:1},people:{compared:0,mismatched:0,displayed:0},cache:{compared:1,mismatched:1}});
ctx.recordLifecycle(run,'metadata','shadow',{films:{compared:1,mismatched:0,displayed:0},people:{compared:2,mismatched:2,displayed:2},cache:{compared:0,mismatched:0}});
assert.equal(run.lifecycleLocalization.metadata.films.compared,2);
assert.equal(run.lifecycleLocalization.metadata.films.mismatched,1);
assert.equal(run.lifecycleLocalization.metadata.people.mismatched,2);
assert.equal(run.lifecycleLocalization.metadata.cache.mismatched,1);
assert.ok(run.lifecycleLocalization.metadata.films.mismatched<=run.lifecycleLocalization.metadata.films.compared);
const records=new Map();let puts=0;
const bucket={get:async key=>records.has(key)?{json:async()=>structuredClone(records.get(key))}:null,put:async()=>{puts++;}};
const generation={runId:'generation-1',updatedAt:'2026-01-01T00:00:00.000Z'};
function seed(film,cached){
 records.clear();puts=0;
 records.set('programme.json',{...generation,films:[film],watchlistCount:1});
 records.set('watchlist.json',{updatedAt:'2025-12-31T00:00:00.000Z',films:[film]});
 records.set('titles.json',cached||{});
}
// Every value the retired path tokens ever had, the absent variable, a bare word, garbage, and the metadata tokens.
const FLAGS=[undefined,'','on:programme,on:watchlist,on:epg','shadow:programme,shadow:watchlist,shadow:epg','off','on','shadow','nope','on:metadata','shadow:metadata'];
async function read(path,flag){
 const env={BUCKET:bucket,...(flag===undefined?{}:{LIFECYCLE_LOCALIZATION:flag})};
 const response=await ctx.worker.fetch(new Request('https://iptv.local'+path),env);
 const body=await response.json();
 return {status:response.status,body,header:response.headers.get('X-Lifecycle-Localization'),puts};
}
async function sameForEveryFlag(path,film,cached,check){
 let first=null;
 for(const flag of FLAGS){seed(film,cached);const result=await read(path,flag);assert.equal(result.status,200,path+' '+flag);assert.equal(result.header,null,path+' '+flag);assert.equal(result.puts,0,path+' '+flag);check(result.body,flag);const text=JSON.stringify(result.body);if(first===null)first=text;else assert.equal(text,first,path+' '+flag);}
 return JSON.parse(first);
}
const ownerActor={id:verified.id,name:'Своё имя',original:verified.original,nameStatus:'verified',nameAuthority:'owner',aliases:[]};
const ownerPayload={id:'28nq',tmdbId:'1656',title:'Своё',titleRu:'Своё',titleStatus:'verified',titleAuthority:'owner',original:'The Legend of Zorro',aliases:[],shows:[],directors:[],actors:[ownerActor]};
function ownerChecks(body){
 const film=body.films[0];
 assert.equal(film.title,'Своё');
 assert.equal(film.titleRu,'Своё');
 assert.equal(film.titleStatus,'verified');
 assert.equal(film.titleConflicts.length,1);
 assert.equal(film.titleConflicts[0].authority,'owner');
 assert.equal(film.titleConflicts[0].value,dictionaryTitle);
 assert.equal(film.aliases.includes(dictionaryTitle),true);
 assert.equal(film.actors[0].name,'Своё имя');
 assert.equal(film.actors[0].nameConflicts[0].reason,'owner_kept');
 assert.equal(film.actors[0].aliases.includes(verified.name),true);
}
// The published generation is read as pinned: its identity and timestamp are returned unchanged under every flag.
const ownerProgramme=await sameForEveryFlag('/api/programme',ownerPayload,null,body=>{ownerChecks(body);assert.equal(body.runId,generation.runId);assert.equal(body.updatedAt,generation.updatedAt);assert.equal(body.watchlistCount,1);});
assert.equal(ownerProgramme.films[0].shows.length,0);
await sameForEveryFlag('/api/watchlist',ownerPayload,null,body=>{ownerChecks(body);assert.equal(body.updatedAt,generation.updatedAt);});
// A cached automatic title goes through the guarded transition: applied, but never promoted to a reviewed status.
const cachePayload={id:'fresh',tmdbId:'1',title:'English',original:'English',aliases:[],shows:[],directors:[],actors:[]};
const cachedTitles={fresh:{tmdbId:'1',title:'Из кэша',status:'verified',sources:[source]}};
for(const path of ['/api/programme','/api/watchlist'])await sameForEveryFlag(path,cachePayload,cachedTitles,body=>{assert.equal(body.films[0].title,'Из кэша');assert.equal(body.films[0].titleRu,'Из кэша');assert.equal(body.films[0].titleStatus,'provisional');assert.equal(body.films[0].aliases.includes('English'),true);});
// A reviewed dictionary title wins over a competing cache entry, and the competing value is not kept as an alias.
const approved={id:'28nq',tmdbId:'1656',title:'English',original:'The Legend of Zorro',aliases:['English'],shows:[],directors:[],actors:[]};
const competing={'28nq':{tmdbId:'1656',title:'Чужой кэш',status:'provisional',sources:[source]}};
for(const path of ['/api/programme','/api/watchlist'])await sameForEveryFlag(path,approved,competing,body=>{assert.equal(body.films[0].title,dictionaryTitle);assert.equal(body.films[0].titleStatus,'verified');assert.equal(body.films[0].titleConflicts,undefined);assert.equal(body.films[0].aliases.includes('Чужой кэш'),false);assert.equal(body.films[0].aliases.includes('English'),true);});
// A mismatched TMDB identity in the cache is ignored by the reads.
const foreign={id:'fresh',tmdbId:'1',title:'English',original:'English',aliases:[],shows:[],directors:[],actors:[]};
for(const path of ['/api/programme','/api/watchlist'])await sameForEveryFlag(path,foreign,{fresh:{tmdbId:'2',title:'Не тот фильм',status:'provisional',sources:[source]}},body=>{assert.equal(body.films[0].title,'English');assert.equal(body.films[0].titleRu,undefined);});

const sources=fs.readFileSync('src/sources.js','utf8');
const worker=fs.readFileSync('src/worker.js','utf8');
for(const file of [sources,worker])assert.doesNotMatch(file,/filmView|readLifecycle|backfillLifecycle|invalidatePredictionForProfile|availabilityProjection/);
// The variable is read once, by the metadata sync; the EPG commit and the reads have no mode and no comparison header.
assert.doesNotMatch(sources,/function lifecycleMode|X-Lifecycle-Localization/);
assert.doesNotMatch(worker,/lifecycleMode\(|localizationResponse|X-Lifecycle-Localization|recordLifecycle\(run,'epg'/);
assert.equal((worker.match(/metadataLocalizationMode\(env\)/g)||[]).length,1);
const flagRead=worker.indexOf('metadataLocalizationMode(env)');
assert.ok(flagRead>worker.indexOf('async function metadataSync(')&&flagRead<worker.indexOf('async function epgSync('));
assert.doesNotMatch(worker.slice(worker.indexOf('async function epgSync(')),/LIFECYCLE_LOCALIZATION|localizationMode/);
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/film-person-backfill/);
console.log('Lifecycle localization guard passed.');
