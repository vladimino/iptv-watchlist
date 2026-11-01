// AIR-54: the owner confirmation writes one R2 object, the admin projection and the programme read both show it,
// and a conflict, a reused request id or an incomplete role set does not write a partial record.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,atob,btoa,crypto:webcrypto,console,setTimeout,structuredClone,
 ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 FILM_TITLE_DICTIONARY:[],
 PERSON_NAME_DICTIONARY:[{id:'actor/delia-enea',original:'Delia Enea',name:'Делия Энеа',aliases:['Делия Энея'],status:'verified',verification_basis:'user_supplied',source_url:'https://ru.wikipedia.org/wiki/Delia_Enea'}],
 fetch:async()=>{throw new Error('the name editor makes no outbound request');}});
for(const file of ['src/domain/film-person.js','src/domain/person-name-review.js','src/sources.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
vm.runInContext(scoped('src/domain/admin-query.js','AdminQuery'),context);
vm.runInContext(fs.readFileSync('src/admin/owner-reviews.js','utf8'),context);
vm.runInContext(fs.readFileSync('src/admin/read.js','utf8'),context);
vm.runInContext(fs.readFileSync('src/admin/person-name-route.js','utf8'),context);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker;
const resetCache=()=>vm.runInContext('ADMIN_SNAPSHOT_CACHE=null',context);

const records=new Map(),etags=new Map();
let revision=0,puts=[],fault=null;
const bucket={
 async get(key){
  if(key==='admin/owner-reviews.json'&&fault&&puts.length>fault.after){
   const kind=fault.kind;fault=null;
   if(kind==='throw')throw new Error('readback failed');
   if(kind==='corrupt')return {etag:'corrupt',uploaded:new Date('2026-10-31T10:00:00.000Z'),json:async()=>({contractVersion:99}),text:async()=>'{"contractVersion":99}'};
   if(kind==='stale')return null;
   if(kind==='mismatch'){
    const body=structuredClone(records.get(key));
    const role=body.people['person:director/mira-sol'];
    role.localization={...role.localization,value:'Чужое имя'};
    role.nameReviews=[];
    return {etag:etags.get(key),uploaded:new Date('2026-10-31T10:00:00.000Z'),json:async()=>body,text:async()=>JSON.stringify(body)};
   }
  }
  if(!records.has(key))return null;
  const etag=etags.get(key);
  return {etag,uploaded:new Date('2026-10-31T10:00:00.000Z'),json:async()=>structuredClone(records.get(key)),text:async()=>JSON.stringify(records.get(key))};
 },
 async put(key,value,options={}){
  const guard=options.onlyIf||{};
  if(guard.etagDoesNotMatch==='*'&&records.has(key))return null;
  if(guard.etagMatches&&guard.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));
  etags.set(key,'rev-'+String(++revision));
  puts.push(key);
  return {etag:etags.get(key)};
 },
 async delete(){throw new Error('delete');},
 async list(){throw new Error('list');},
};
const env={BUCKET:bucket};
const ORIGIN='https://iptv.example';
const call=async(path,init={})=>{
 const headers=new Headers(init.headers||{});
 if(init.body&&!headers.has('Origin'))headers.set('Origin',ORIGIN);
 const response=await worker.fetch(new Request(ORIGIN+path,{...init,headers}),env,{waitUntil(){throw new Error('background work');}});
 const text=await response.text();
 return {status:response.status,body:text?JSON.parse(text):null};
};

const RUN='11111111-1111-4111-8111-111111111111';
const AT='2026-10-31T10:00:00.000Z';
const mira={id:'actor/mira-sol',name:'Mira Sol',original:'Mira Sol'};
const miraDirector={id:'director/mira-sol',name:'Mira Sol',original:'Mira Sol'};
const delia={id:'actor/delia-enea',name:'Делия Энеа',original:'Delia Enea'};
const films=[
 {id:'one',title:'One',original:'One',directors:[],actors:[mira,delia],shows:[]},
 {id:'two',title:'Two',original:'Two',directors:[miraDirector],actors:[mira],shows:[]},
];
function seed(){
 records.clear();etags.clear();puts=[];revision=0;resetCache();
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:RUN,publishedAt:AT});etags.set('epg/published-generation.json','ptr');
 const programme={runId:RUN,updatedAt:AT,watchlistCount:films.length,films,people:{directors:[miraDirector],actors:[mira,delia]},stats:{}};
 records.set('epg/generations/'+RUN+'/programme.json',programme);etags.set('epg/generations/'+RUN+'/programme.json','prog');
 records.set('programme.json',structuredClone(programme));etags.set('programme.json','root');
 records.set('titles.json',{});etags.set('titles.json','titles');
 records.set('people.json',{});etags.set('people.json','people');
}
seed();
const detail=await call('/api/admin/people/person:actor/mira-sol');
assert.equal(detail.status,200);
assert.equal(detail.body.item.nameReview.personId,'person:actor/mira-sol');
assert.equal(puts.length,0,'a person read does not write');
const version=detail.body.item.nameReview.version;
const director=await call('/api/admin/people/person:director/mira-sol');
const directorVersion=director.body.item.nameReview.version;
assert.ok((detail.body.item.nameReview.collisions||[]).some(item=>item.id==='person:director/mira-sol'),'the other role is a collision, not a merge');

const post=(body,headers)=>call('/api/admin/people/'+encodeURIComponent(body.personId)+'/name-review',{method:'POST',headers:{'Content-Type':'application/json','X-IPTV-Admin-Action':'person_name_review',...headers},body:JSON.stringify(body)});
const command={personId:'person:actor/mira-sol',requestId:'req-mira-1',mode:'manual',value:'Мира Соль',expectedVersion:version,roles:[{id:'person:director/mira-sol',expectedVersion:directorVersion}]};
const saved=await post(command);
assert.equal(saved.status,200,JSON.stringify(saved.body));
assert.equal(saved.body.changed,true);
assert.deepEqual(puts,['admin/owner-reviews.json']);
assert.equal(saved.body.nameReview.preferred.value,'Мира Соль');
assert.equal(saved.body.nameReview.preferred.status,'reviewed');
assert.equal(saved.body.nameReview.preferred.authority,'owner');
const stored=records.get('admin/owner-reviews.json');
assert.equal(stored.contractVersion,1);
assert.deepEqual(stored.films,{});
assert.equal(stored.people['person:actor/mira-sol'].localization.value,'Мира Соль');
assert.equal(stored.people['person:director/mira-sol'].localization.value,'Мира Соль');
assert.equal(stored.people['person:actor/mira-sol'].id,undefined,'the person id is the map key, not a stored identity');
assert.ok(stored.people['person:actor/mira-sol'].roleLinks.some(link=>link.id==='person:director/mira-sol'));
assert.ok(stored.people['person:director/mira-sol'].roleLinks.some(link=>link.id==='person:actor/mira-sol'));

const again=await post(command);
assert.equal(again.status,200);
assert.equal(again.body.idempotent,true);
assert.deepEqual(puts,['admin/owner-reviews.json'],'a retry of the same request does not write again');

const reused=await post({...command,value:'Другая Мира'});
assert.equal(reused.status,409);
assert.equal(reused.body.error,'request_id_reused');
assert.equal(puts.length,1);

const conflict=await post({...command,requestId:'req-mira-2',expectedVersion:'name-review:1:stale'});
assert.equal(conflict.status,412);
assert.equal(conflict.body.error,'version_conflict');
assert.equal(puts.length,1);

const unrelated=await post({personId:'person:actor/mira-sol',requestId:'req-mira-3',mode:'manual',value:'Мира Соль',expectedVersion:saved.body.version,roles:[{id:'person:actor/delia-enea',expectedVersion:directorVersion}]});
assert.equal(unrelated.status,400);
assert.equal(unrelated.body.error,'unrelated_role');
assert.equal(puts.length,1);

const noOrigin=await call('/api/admin/people/'+encodeURIComponent(command.personId)+'/name-review',{method:'POST',headers:{'Content-Type':'application/json','X-IPTV-Admin-Action':'person_name_review',Origin:''},body:JSON.stringify(command)});
assert.equal(noOrigin.status,403);
const noAction=await call('/api/admin/people/'+encodeURIComponent(command.personId)+'/name-review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)});
assert.equal(noAction.status,403);
assert.equal(noAction.body.error,'action_not_allowed');
const getRoute=await call('/api/admin/people/'+encodeURIComponent(command.personId)+'/name-review');
assert.equal(getRoute.status,405);
assert.equal(puts.length,1,'a refused request writes nothing');

const listed=await call('/api/admin/people?q='+encodeURIComponent('Мира Соль'));
assert.equal(listed.status,200);
assert.ok(listed.body.items.some(item=>item.id==='person:actor/mira-sol'));
assert.ok(listed.body.items.some(item=>item.id==='person:director/mira-sol'));
const byOld=await call('/api/admin/people?q=Mira');
assert.ok(byOld.body.items.some(item=>item.id==='person:actor/mira-sol'),'the previous name stays searchable as an alias');
const reviewedQueue=await call('/api/admin/people?queue=localization-reviewed'.replace('localization-reviewed','localization-missing'));
assert.ok(!reviewedQueue.body.items.some(item=>item.id==='person:actor/mira-sol'));

const programme=await call('/api/programme');
assert.equal(programme.status,200);
for(const film of programme.body.films)for(const person of [...film.actors,...film.directors])if(person.id==='actor/mira-sol'||person.id==='director/mira-sol')assert.equal(person.name,'Мира Соль',film.id+' '+person.id);
assert.equal(programme.body.films.filter(film=>film.actors.some(person=>person.id==='actor/mira-sol'&&person.name==='Мира Соль')).length,2,'both films show the saved name');
assert.equal(puts.length,1,'reading the programme does not write the review');

records.get('admin/owner-reviews.json').films['kept-film']={filmId:'film:kept',localization:{status:'reviewed',value:'Сохранённое'}};
resetCache();
const deliaDetail=await call('/api/admin/people/person:actor/delia-enea');
const renamed=await post({personId:'person:actor/delia-enea',requestId:'req-delia',mode:'manual',value:'Делия Енеа',expectedVersion:deliaDetail.body.item.nameReview.version});
assert.equal(renamed.status,200,JSON.stringify(renamed.body));
assert.equal(renamed.body.nameReview.heldConflicts,1,'the dictionary value is held once, not applied over the owner');
assert.equal(renamed.body.nameReview.version,renamed.body.version,'the answer token is the token just read back');
assert.equal(renamed.body.nameReview.preferred.value,'Делия Енеа');
assert.equal(renamed.body.nameReview.preferred.authority,'owner');
assert.equal(records.get('admin/owner-reviews.json').films['kept-film'].filmId,'film:kept','a person write copies the film map');
const deliaCommand={personId:'person:actor/delia-enea',requestId:'req-delia',mode:'manual',value:'Делия Енеа',expectedVersion:deliaDetail.body.item.nameReview.version};
const deliaPuts=puts.length;
const deliaReplay=await post(deliaCommand);
assert.equal(deliaReplay.status,200,JSON.stringify(deliaReplay.body));
assert.equal(deliaReplay.body.idempotent,true,'the same request reconciles after the dictionary hold');
assert.equal(puts.length,deliaPuts,'the replay does not write');
const deliaRead=await call('/api/admin/people/person:actor/delia-enea');
const deliaReadAgain=await call('/api/admin/people/person:actor/delia-enea');
assert.equal(deliaRead.body.item.nameReview.heldConflicts,1);
assert.equal(deliaReadAgain.body.item.nameReview.heldConflicts,1,'a repeated read does not grow conflicts');
assert.equal(deliaRead.body.item.localizationConflicts.length,deliaReadAgain.body.item.localizationConflicts.length);
assert.equal(records.get('admin/owner-reviews.json').people['person:actor/delia-enea'].localizationConflicts.length,1);
const deliaSecond=await post({personId:'person:actor/delia-enea',requestId:'req-delia-2',mode:'manual',value:'Делия Енея',expectedVersion:deliaReadAgain.body.item.nameReview.version});
assert.equal(deliaSecond.status,200,JSON.stringify(deliaSecond.body));
assert.equal(deliaSecond.body.changed,true,'a second edit still writes');
assert.equal(records.get('admin/owner-reviews.json').people['person:actor/delia-enea'].localizationConflicts.filter(item=>item.reason==='owner_kept'&&item.value==='Делия Энеа').length,1);
const deliaQueue=await call('/api/admin/people?queue=localization-conflict');
assert.ok(deliaQueue.body.items.some(item=>item.id==='person:actor/delia-enea'));

const broken={...structuredClone(stored),films:{'kept-film':{filmId:'film:kept',localization:{status:'reviewed',value:'Сохранённое'}}},people:{...stored.people,'person:director/mira-sol':{...stored.people['person:director/mira-sol'],localization:{...stored.people['person:director/mira-sol'].localization,value:'Чужое'},nameReviews:[]}}};
records.set('admin/owner-reviews.json',broken);etags.set('admin/owner-reviews.json','rev-diverged');resetCache();
const before=puts.length;
const diverged=await post(command);
assert.equal(diverged.status,409);
assert.equal(diverged.body.error,'review_incomplete');
assert.equal(puts.length,before,'a diverged role set is not overwritten');
assert.equal(records.get('admin/owner-reviews.json').people['person:director/mira-sol'].localization.value,'Чужое');
assert.equal(records.get('admin/owner-reviews.json').films['kept-film'].filmId,'film:kept','a refused write leaves the film map untouched');

async function expectUnverified(kind){
 seed();
 const opened=await call('/api/admin/people/person:actor/mira-sol');
 const openedDirector=await call('/api/admin/people/person:director/mira-sol');
 const body={personId:'person:actor/mira-sol',requestId:'req-readback-'+kind,mode:'manual',value:'Мира Соль',expectedVersion:opened.body.item.nameReview.version,roles:[{id:'person:director/mira-sol',expectedVersion:openedDirector.body.item.nameReview.version}]};
 fault={kind,after:puts.length};
 const saved=await post(body);
 assert.equal(fault,null,kind+' readback consumed the fault');
 assert.equal(saved.status,503,kind+' '+JSON.stringify(saved.body));
 assert.equal(saved.body.error,'storage_unavailable');
 assert.equal(saved.body.reason,'readback_failed');
 assert.notEqual(saved.body.ok,true,kind+' is not a confirmed save');
 assert.equal(saved.body.nameReview,undefined);
 const storedPeople=records.get('admin/owner-reviews.json').people;
 assert.equal(storedPeople['person:actor/mira-sol'].localization.value,'Мира Соль',kind+' still committed the primary name');
 assert.equal(storedPeople['person:director/mira-sol'].localization.value,'Мира Соль',kind+' still committed the linked role');
 const retry=await post(body);
 assert.equal(retry.status,200,kind+' retry '+JSON.stringify(retry.body));
 assert.equal(retry.body.idempotent,true,kind+' retry reconciles the committed request');
 assert.equal(puts.length,1,kind+' retry does not write again');
}
for(const kind of ['throw','corrupt','stale','mismatch'])await expectUnverified(kind);

seed();
const sandra={id:'actor/sandra-bullock',name:'Сандра Буллок',original:'Sandra Bullock',nameStatus:'provisional',nameSource:'wikidata',aliases:['Sandra Bullock']};
const programmeBody=structuredClone(records.get('epg/generations/'+RUN+'/programme.json'));
programmeBody.films.push({id:'three',title:'Three',original:'Three',directors:[],actors:[sandra],shows:[]},{id:'four',title:'Four',original:'Four',directors:[],actors:[structuredClone(sandra)],shows:[]});
programmeBody.people.actors.push(sandra);
records.set('epg/generations/'+RUN+'/programme.json',programmeBody);
records.set('programme.json',structuredClone(programmeBody));
records.set('people.json',{'actor/sandra-bullock':{name:'Сандра Буллок',original:'Sandra Bullock'}});
resetCache();
const sandraDetail=await call('/api/admin/people/person:actor/sandra-bullock');
assert.equal(sandraDetail.status,200,JSON.stringify(sandraDetail.body));
assert.equal(sandraDetail.body.item.nameReview.preferred.value,'Сандра Буллок');
assert.equal(sandraDetail.body.item.nameReview.preferred.status,'provisional');
assert.equal(sandraDetail.body.item.nameReview.original,'Sandra Bullock');
const sandraVersion=sandraDetail.body.item.nameReview.version;
const beforeSandra=puts.length;
const aliasBody={personId:'person:actor/sandra-bullock',requestId:'sandra-add',mode:'manual',value:'Сандра Баллок',basis:'устаревший вариант',expectedVersion:sandraVersion,effect:'add_alias'};
const aliasSaved=await post(aliasBody);
assert.equal(aliasSaved.status,200,JSON.stringify(aliasSaved.body));
assert.equal(aliasSaved.body.changed,true);
assert.equal(aliasSaved.body.nameReview.preferred.value,'Сандра Буллок');
assert.equal(aliasSaved.body.nameReview.preferred.status,'provisional');
assert.notEqual(aliasSaved.body.nameReview.preferred.authority,'owner');
assert.equal(aliasSaved.body.nameReview.reviews.find(entry=>entry.requestId==='sandra-add').effect,'alias_added');
assert.deepEqual(aliasSaved.body.nameReview.roleLinks,[]);
const sandraStored=records.get('admin/owner-reviews.json').people['person:actor/sandra-bullock'];
assert.equal(sandraStored.localization,null);
assert.equal(sandraStored.aliases.filter(alias=>alias.value==='Сандра Баллок').length,1);
assert.equal(records.get('admin/owner-reviews.json').films['kept-film'],undefined);
const sandraSearch=await call('/api/admin/people?q='+encodeURIComponent('Сандра Баллок'));
assert.ok(sandraSearch.body.items.some(item=>item.id==='person:actor/sandra-bullock'&&item.preferred==='Сандра Буллок'));
const sandraStill=await call('/api/admin/people?q='+encodeURIComponent('Сандра Буллок'));
assert.ok(sandraStill.body.items.some(item=>item.id==='person:actor/sandra-bullock'));
const aliasedProgramme=await call('/api/programme');
const sandraCredits=aliasedProgramme.body.films.flatMap(film=>[...film.actors,...film.directors]).filter(person=>person.id==='actor/sandra-bullock');
assert.equal(sandraCredits.length,2);
for(const person of sandraCredits){
 assert.equal(person.name,'Сандра Буллок');
 assert.notEqual(person.nameStatus,'reviewed');
 assert.ok((person.aliases||[]).includes('Сандра Баллок'));
}
const duplicateAlias=await post({...aliasBody,requestId:'sandra-add-2',expectedVersion:aliasSaved.body.version});
assert.equal(duplicateAlias.status,200,JSON.stringify(duplicateAlias.body));
assert.equal(duplicateAlias.body.changed,false);
assert.equal(duplicateAlias.body.reason,'duplicate_alias');
assert.equal(puts.length,beforeSandra+1);
const aliasReplay=await post(aliasBody);
assert.equal(aliasReplay.body.idempotent,true);
assert.equal(puts.length,beforeSandra+1);
const staleAlias=await post({...aliasBody,requestId:'sandra-stale',value:'Другая Сандра',expectedVersion:'name-review:1:stale'});
assert.equal(staleAlias.status,412);
const linkedAlias=await post({...aliasBody,requestId:'sandra-roles',value:'Ещё Сандра',expectedVersion:aliasSaved.body.version,roles:[{id:'person:director/mira-sol',expectedVersion:'x'}]});
assert.equal(linkedAlias.status,400);
assert.equal(linkedAlias.body.error,'roles_not_allowed');
assert.equal(puts.length,beforeSandra+1);
const promoted=await post({personId:'person:actor/sandra-bullock',requestId:'sandra-promote',mode:'manual',value:'Сандра Баллок',expectedVersion:aliasSaved.body.version,effect:'promote'});
assert.equal(promoted.status,200,JSON.stringify(promoted.body));
assert.equal(promoted.body.nameReview.preferred.value,'Сандра Баллок');
assert.equal(promoted.body.nameReview.preferred.authority,'owner');
assert.equal(promoted.body.nameReview.reviews.find(entry=>entry.requestId==='sandra-promote').effect,'preferred_changed');
const priorOption=promoted.body.nameReview.options.find(option=>option.value==='Сандра Буллок');
assert.equal(priorOption.provenance.previousPreferred,true);
assert.equal(priorOption.provenance.historicalSource,'wikidata');
const promotedProgramme=await call('/api/programme');
const promotedCredits=promotedProgramme.body.films.flatMap(film=>[...film.actors,...film.directors]).filter(person=>person.id==='actor/sandra-bullock');
assert.equal(promotedCredits.length,2);
for(const person of promotedCredits){
 assert.equal(person.name,'Сандра Баллок');
 assert.ok((person.aliases||[]).includes('Сандра Буллок'));
}
const restored=await post({personId:'person:actor/sandra-bullock',requestId:'sandra-restore',mode:'alias',value:'Сандра Буллок',expectedVersion:promoted.body.version,effect:'promote'});
assert.equal(restored.status,200,JSON.stringify(restored.body));
assert.equal(restored.body.nameReview.preferred.value,'Сандра Буллок');
assert.equal(restored.body.nameReview.options.find(option=>option.value==='Сандра Баллок').provenance.previousPreferred,true);

seed();
const bruce={id:'actor/bruce-willis',name:'Брюс Уиллис',original:'Bruce Willis',nameStatus:'provisional',nameSource:'wikidata',aliases:['Bruce Willis']};
const bruceProgramme=structuredClone(records.get('epg/generations/'+RUN+'/programme.json'));
bruceProgramme.films.push({id:'die-hard',title:'Die Hard',original:'Die Hard',directors:[],actors:[bruce],shows:[]});
bruceProgramme.people.actors.push(bruce);
records.set('epg/generations/'+RUN+'/programme.json',bruceProgramme);
records.set('programme.json',structuredClone(bruceProgramme));
records.set('people.json',{'actor/bruce-willis':{name:'Брюс Уиллис',original:'Bruce Willis'}});
resetCache();
const bruceOpened=await call('/api/admin/people/person:actor/bruce-willis');
assert.equal(bruceOpened.status,200,JSON.stringify(bruceOpened.body));
assert.equal(bruceOpened.body.item.nameReview.preferred.value,'Брюс Уиллис');
assert.equal(bruceOpened.body.item.nameReview.preferred.status,'provisional');
assert.equal(bruceOpened.body.item.nameReview.preferred.source,'wikidata');
assert.ok(bruceOpened.body.item.nameReview.options.some(option=>option.value==='Брюс Уиллис'));
const bruceAdds=puts.length;
const bruceAlias=await post({personId:'person:actor/bruce-willis',requestId:'bruce-add',mode:'manual',value:'Брюс Виллис',basis:'другая передача',expectedVersion:bruceOpened.body.item.nameReview.version,effect:'add_alias'});
assert.equal(bruceAlias.status,200,JSON.stringify(bruceAlias.body));
assert.equal(bruceAlias.body.changed,true);
assert.equal(bruceAlias.body.nameReview.preferred.value,'Брюс Уиллис');
assert.equal(bruceAlias.body.nameReview.preferred.status,'provisional');
assert.equal(bruceAlias.body.nameReview.preferred.source,'wikidata');
assert.notEqual(bruceAlias.body.nameReview.preferred.authority,'owner');
const bruceRead=await call('/api/admin/people/person:actor/bruce-willis');
const bruceOptions=bruceRead.body.item.nameReview.options.map(option=>option.value);
assert.ok(bruceOptions.includes('Брюс Уиллис')&&bruceOptions.includes('Брюс Виллис'));
assert.equal(bruceRead.body.item.nameReview.preferred.value,'Брюс Уиллис');
assert.equal(bruceRead.body.item.preferred,'Брюс Уиллис');
const bruceStored=records.get('admin/owner-reviews.json').people['person:actor/bruce-willis'];
assert.equal(bruceStored.localization,null);
assert.equal(bruceStored.aliases.filter(alias=>alias.value==='Брюс Виллис').length,1);
assert.equal(bruceStored.aliases.some(alias=>alias.value==='Брюс Уиллис'),false);
const bruceDuplicate=await post({personId:'person:actor/bruce-willis',requestId:'bruce-add-2',mode:'manual',value:'Брюс Виллис',expectedVersion:bruceRead.body.item.nameReview.version,effect:'add_alias'});
assert.equal(bruceDuplicate.status,200);
assert.equal(bruceDuplicate.body.changed,false);
assert.equal(bruceDuplicate.body.reason,'duplicate_alias');
assert.equal(puts.length,bruceAdds+1);
const brucePromoted=await post({personId:'person:actor/bruce-willis',requestId:'bruce-promote',mode:'alias',value:'Брюс Виллис',expectedVersion:bruceDuplicate.body.version,effect:'promote'});
assert.equal(brucePromoted.status,200,JSON.stringify(brucePromoted.body));
assert.equal(brucePromoted.body.nameReview.preferred.value,'Брюс Виллис');
assert.equal(brucePromoted.body.nameReview.options.find(option=>option.value==='Брюс Уиллис').provenance.previousPreferred,true);
const bruceRestored=await post({personId:'person:actor/bruce-willis',requestId:'bruce-restore',mode:'alias',value:'Брюс Уиллис',expectedVersion:brucePromoted.body.version,effect:'promote'});
assert.equal(bruceRestored.status,200,JSON.stringify(bruceRestored.body));
assert.equal(bruceRestored.body.nameReview.preferred.value,'Брюс Уиллис');
assert.equal(bruceRestored.body.nameReview.preferred.authority,'owner');
assert.ok(bruceRestored.body.nameReview.options.some(option=>option.value==='Брюс Виллис'&&option.provenance&&option.provenance.previousPreferred===true));

console.log('Person name editor: confirm, replay, conflict, role link, programme overlay, held dictionary and readback passed');
