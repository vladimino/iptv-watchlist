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
let revision=0,puts=[];
const bucket={
 async get(key){
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
assert.ok(renamed.body.nameReview.heldConflicts>=1,'the dictionary value is held, not applied over the owner');
assert.equal(renamed.body.nameReview.preferred.value,'Делия Енеа');
assert.equal(renamed.body.nameReview.preferred.authority,'owner');
assert.equal(records.get('admin/owner-reviews.json').films['kept-film'].filmId,'film:kept','a person write copies the film map');
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

console.log('Person name editor: confirm, replay, conflict, role link, programme overlay and held dictionary passed');
