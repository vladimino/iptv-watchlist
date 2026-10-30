// GET /api/admin/*: one published snapshot (pointer, generation programme, pointer again, titles.json, people.json), an
// opaque pin over that version tuple, bounded pages of the pure query library, and the negative cases of the read contract.
// No bucket listing, no root programme.json, no write, no outbound request, no lease or ledger read.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {bundleAdminQuery} from '../src/admin/bundle.js';

const source=fs.readFileSync('src/admin/read.js','utf8');
assert.doesNotMatch(source,/loadJSON|saveJSON|recoverStopEvents|enrichmentView|BUCKET\.(?:put|list|delete|head)|\.put\(|\.list\(|\.delete\(|\bfetch\(|waitUntil|resolver-lease|resolver-continuation|discovery-latest|discovery-resolution|discovered-films|enrichment\/|get\('programme\.json'|\.prepare\(/,'the admin read never writes, lists, falls back or reaches another store');
assert.match(fs.readFileSync('src/worker.js','utf8'),/url\.pathname\.startsWith\('\/api\/admin\/'\)\)return await adminReadRoute\(request,env,url\)/);
const build=fs.readFileSync('build.mjs','utf8');
assert.match(build,/bundleAdminQuery\(fs\.readFileSync\('src\/domain\/admin-query\.js','utf8'\)\)/);
assert.match(build,/src\/admin\/read\.js/);
assert.ok(build.indexOf('src/admin/read.js')<build.indexOf("src/worker.js','utf8'));"),'the read module is loaded before the Worker entry');

// R2 stand-in with etags, upload times and counters.
const records=new Map(),etags=new Map(),uploaded=new Map();
let gets=[],parses=0,puts=[],lists=0,fetches=[];
let pointerSequence=null;
const bucket={
 async get(key){
  gets.push(key);
  if(key===POINTER&&pointerSequence&&pointerSequence.length){const next=pointerSequence.shift();records.set(POINTER,next.body);etags.set(POINTER,next.etag);}
  if(!records.has(key))return null;
  const text=JSON.stringify(records.get(key)),etag=etags.get(key);
  return {etag,uploaded:uploaded.has(key)?uploaded.get(key):undefined,json:async()=>{parses++;return JSON.parse(text);},text:async()=>{parses++;return text;}};
 },
 async put(key){puts.push(key);},
 async delete(key){puts.push('delete:'+key);},
 async list(){lists++;return {objects:[],truncated:false};},
};
const env={BUCKET:bucket};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,atob,btoa,crypto:webcrypto,console,setTimeout,structuredClone,
 ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 FILM_TITLE_DICTIONARY:[{id:'d5',tmdbId:'555',original:'Dict Film',title:'Словарный фильм',sources:['https://www.wikidata.org/wiki/Q1'],aliases:['Из словаря'],status:'verified'}],
 PERSON_NAME_DICTIONARY:[{id:'director/alex-brewer',original:'Alex Brewer',name:'Алекс Брюэр',aliases:[],status:'verified',verification_basis:'user_supplied',source_url:null}],
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
for(const file of ['src/domain/film-person.js','src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/prediction-quality.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/migration-export.js','src/filter-presets.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
vm.runInContext(bundleAdminQuery(fs.readFileSync('src/domain/admin-query.js','utf8')),context);
vm.runInContext(source,context);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker;
const resetCache=()=>vm.runInContext('ADMIN_SNAPSHOT_CACHE=null',context);

const POINTER='epg/published-generation.json',G1='11111111-1111-4111-8111-111111111111',G2='22222222-2222-4222-8222-222222222222';
const programmeKey=run=>'epg/generations/'+run+'/programme.json';
const AT='2026-10-29T10:00:00.000Z',day=86400000;
const iso=offsetDays=>new Date(Date.parse(AT)+offsetDays*day).toISOString();
const director={id:'director/alex-brewer',name:'Алекс Брюэр',original:'Alex Brewer'};
const mira={id:'actor/mira-sol',name:'Мира Соль',original:'Mira Sol'};
const noName={id:'actor/no-name',name:'No Name',original:'No Name',nameConflicts:[{value:'Безымянный',source:'dictionary',reason:'unresolved',authority:'unknown'}]};
function programmeOf(run){
 const films=[
  {id:'H11k',tmdbId:'1137844',title:'Мэйдэй',original:'Mayday',titleRu:'Мэйдэй',titleStatus:'verified',year:2026,metadataAt:iso(-2),synopsis:'s',peopleVersion:1,directors:[director],actors:[mira],shows:[{channelId:'c1',channel:'One',start:Date.parse(AT)-3600000,end:Date.parse(AT)}]},
  {id:'q2',tmdbId:'900002',title:'Тихая гавань',original:'Quiet Harbor',titleRu:'Тихая гавань',titleStatus:'provisional',year:2018,metadataAt:iso(-40),synopsis:'s',peopleVersion:1,directors:[],actors:[noName],shows:[]},
  {id:'b3',title:'Blank Reel',original:'Blank Reel',year:2024,directors:[],actors:[],shows:[]},
  {id:'c4',tmdbId:'900004',title:'Мой конфликт',original:'Conflict',titleRu:'Мой конфликт',titleStatus:'verified',titleConflicts:[{value:'Конфликт',source:'dictionary',reason:'owner_kept',authority:'owner'}],metadataAt:iso(-1),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
  {id:'d5',tmdbId:'555',title:'Dict Film',original:'Dict Film',metadataAt:iso(-1),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
  {id:'e6',tmdbId:'666',title:'Другое название',original:'Orig Title',metadataAt:iso(-1),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
 ];
 for(let index=0;index<30;index++)films.push({id:'p'+String(index).padStart(2,'0'),tmdbId:String(7000+index),title:'Маяк '+index,original:'Beacon '+index,titleRu:'Маяк '+index,titleStatus:'verified',metadataAt:iso(-1),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]});
 return {runId:run,updatedAt:AT,watchlistCount:films.length,films,people:{directors:[director],actors:[mira,noName]},stats:{}};
}
function seed({run=G1}={}){
 records.clear();etags.clear();uploaded.clear();gets=[];parses=0;puts=[];lists=0;fetches=[];pointerSequence=null;resetCache();
 records.set(POINTER,{phase:'published',programmeRunId:run,publishedAt:AT});etags.set(POINTER,'ptr-'+run);uploaded.set(POINTER,new Date(AT));
 records.set(programmeKey(run),programmeOf(run));etags.set(programmeKey(run),'prog-'+run);uploaded.set(programmeKey(run),new Date(AT));
 records.set('programme.json',{runId:'root-must-not-be-read',films:[]});etags.set('programme.json','root');
 records.set('titles.json',{q2:{tmdbId:'900002',title:'Тихая гавань',status:'provisional',sources:['https://www.wikidata.org/wiki/Q2']}});etags.set('titles.json','titles-1');uploaded.set('titles.json',new Date(AT));
 records.set('people.json',{'actor/mira-sol':{name:'Мира Соль',original:'Mira Sol'}});etags.set('people.json','people-1');uploaded.set('people.json',new Date(AT));
}
const call=async(path,init)=>{const response=await worker.fetch(new Request('https://iptv.example'+path,init),env,{waitUntil(){throw new Error('background work on a GET');}});return {status:response.status,body:await response.json()};};
const SNAPSHOT_KEYS=[POINTER,programmeKey(G1),POINTER,'titles.json','people.json'];

// 1. Overview: five reads in the contract order, no list, no write, no request; counts and available queues.
seed();
let r=await call('/api/admin/overview');
assert.equal(r.status,200,JSON.stringify(r.body));
assert.deepEqual(gets,SNAPSHOT_KEYS);
assert.equal(lists,0);assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
assert.equal(typeof r.body.pin,'string');
assert.equal(r.body.snapshot.programmeRunId,G1);
assert.equal(r.body.snapshot.programmeUpdatedAt,AT);
assert.equal(r.body.snapshot.skew,false);assert.deepEqual(r.body.snapshot.skewReasons,[]);
assert.deepEqual(r.body.counts,{films:36,people:3});
assert.deepEqual(r.body.unavailableQueues,['fingerprint-not-current','prediction-not-current']);
const queue=(kind,code)=>r.body.queues.find(item=>item.kind===kind&&item.code===code).count;
assert.equal(queue('film','localization-missing'),2,'b3 and e6');
assert.equal(queue('film','localization-provisional'),1);
assert.equal(queue('film','localization-conflict'),1);
assert.equal(queue('film','identity-unresolved'),1);
assert.equal(queue('film','metadata-stale'),1);
assert.equal(queue('film','metadata-missing'),1);
assert.equal(queue('person','localization-missing'),1);
assert.equal(queue('person','localization-conflict'),1);
assert.equal(r.body.queues.some(item=>item.code==='fingerprint-not-current'||item.code==='prediction-not-current'),false);
const pin=r.body.pin;

// 2. Search: a projection, not the programme record.
r=await call('/api/admin/films?q=mayday');
assert.equal(r.status,200);
assert.equal(r.body.pin,pin);
assert.equal(r.body.limit,25);assert.equal(r.body.query,'mayday');assert.equal(r.body.queue,null);assert.equal(r.body.nextCursor,null);
assert.equal(r.body.items.length,1);
const mayday=r.body.items[0];
assert.equal(mayday.id,'film:H11k');assert.equal(mayday.storedId,'H11k');assert.equal(mayday.canonicalIdentity,'tmdb:1137844');
assert.equal(mayday.preferred,'Мэйдэй');assert.equal(mayday.originalTitle,'Mayday');assert.equal(mayday.year,2026);
assert.equal(mayday.localization.status,'reviewed');assert.equal(mayday.identity.status,'resolved');assert.equal(mayday.metadata.status,'fresh');
assert.deepEqual(mayday.externalIds.map(item=>[item.scheme,item.value,item.trusted]),[['letterboxd','H11k',true],['tmdb','1137844',true]]);
assert.equal(mayday.rank,2);assert.equal(mayday.collision,false);
for(const key of ['fingerprint','prediction','predictionHistory','shows','synopsis','directors','actors'])assert.equal(Object.hasOwn(mayday,key),false,key+' is not on the record');
r=await call('/api/admin/films?q=1137844');assert.equal(r.body.items[0].rank,0,'external id rank');
r=await call('/api/admin/films?q=словарный');
assert.equal(r.body.items[0].id,'film:d5');assert.equal(r.body.items[0].localization.status,'reviewed');assert.equal(r.body.items[0].preferred,'Словарный фильм');
r=await call('/api/admin/films?q=другое');
assert.equal(r.body.items[0].id,'film:e6');assert.equal(r.body.items[0].epgTitle,'Другое название');
assert.ok(r.body.items[0].aliases.some(alias=>alias.value==='Другое название'&&alias.provenance.source==='epg'));
r=await call('/api/admin/films?q=conflict');
assert.deepEqual(r.body.items[0].localizationConflicts,[{value:'Конфликт',source:'dictionary',reason:'owner_kept',authority:'owner'}]);
r=await call('/api/admin/films?q=blank');
assert.equal(r.body.items[0].identity.status,'unresolved');assert.equal(r.body.items[0].localization.status,'missing');assert.equal(r.body.items[0].metadata.status,'missing');assert.equal(r.body.items[0].canonicalIdentity,null);
r=await call('/api/admin/films?q=нет такого');assert.equal(r.status,200);assert.deepEqual(r.body.items,[]);assert.equal(r.body.nextCursor,null);

// 3. People: dictionary, provisional cache, missing; role ids with a slash in the detail path.
r=await call('/api/admin/people?q=sol');
assert.equal(r.body.items.length,1);
const sol=r.body.items[0];
assert.equal(sol.id,'person:actor/mira-sol');assert.equal(sol.roleId,'actor/mira-sol');assert.equal(sol.preferred,'Мира Соль');assert.equal(sol.localization.status,'provisional');assert.equal(sol.original,'Mira Sol');
assert.ok(sol.aliases.some(alias=>alias.value==='Mira Sol'&&alias.provenance.source==='letterboxd'));
r=await call('/api/admin/people?q=brewer');assert.equal(r.body.items[0].localization.status,'reviewed');assert.equal(r.body.items[0].preferred,'Алекс Брюэр');
r=await call('/api/admin/people?queue=localization-missing');assert.deepEqual(r.body.items.map(item=>item.id),['person:actor/no-name']);
assert.deepEqual(r.body.items[0].localizationConflicts,[{value:'Безымянный',source:'dictionary',reason:'unresolved',authority:'unknown'}]);
r=await call('/api/admin/people/person:actor/mira-sol');assert.equal(r.status,200);assert.equal(r.body.kind,'person');assert.equal(r.body.item.id,'person:actor/mira-sol');
r=await call('/api/admin/people/'+encodeURIComponent('person:actor/mira-sol'));assert.equal(r.status,200);assert.equal(r.body.item.id,'person:actor/mira-sol');
r=await call('/api/admin/films/film:H11k');assert.equal(r.status,200);assert.equal(r.body.kind,'film');assert.equal(r.body.item.id,'film:H11k');assert.equal(r.body.pin,pin);
r=await call('/api/admin/films/film:missing');assert.equal(r.status,404);assert.equal(r.body.error,'not_found');assert.equal(r.body.pin,pin);
r=await call('/api/admin/films/'+'x'.repeat(201));assert.equal(r.status,404);
r=await call('/api/admin/films/%E0%A4%A');assert.equal(r.status,404);

// 4. Queues, and a search narrowed by a queue.
r=await call('/api/admin/films?queue=localization-missing');assert.deepEqual(r.body.items.map(item=>item.id),['film:b3','film:e6']);
assert.equal(Object.hasOwn(r.body.items[0],'rank'),false);
r=await call('/api/admin/films?queue=metadata-stale');assert.deepEqual(r.body.items.map(item=>item.id),['film:q2']);
r=await call('/api/admin/films?queue=localization-conflict');assert.deepEqual(r.body.items.map(item=>item.id),['film:c4']);
r=await call('/api/admin/films?q=blank&queue=localization-missing');assert.deepEqual(r.body.items.map(item=>item.id),['film:b3']);
r=await call('/api/admin/films?q=beacon&queue=localization-missing');assert.deepEqual(r.body.items,[]);
r=await call('/api/admin/films?queue=not-a-queue');assert.equal(r.status,400);assert.equal(r.body.error,'unknown_queue');
r=await call('/api/admin/people?queue=identity-unresolved');assert.equal(r.status,400);assert.equal(r.body.error,'unknown_queue');
r=await call('/api/admin/films?queue=fingerprint-not-current');assert.equal(r.status,400);assert.equal(r.body.error,'queue_unavailable');
r=await call('/api/admin/films?queue=prediction-not-current');assert.equal(r.status,400);assert.equal(r.body.error,'queue_unavailable');

// 5. Limit: omitted is 25, present must be an integer 1-25, and the library is not reached otherwise.
gets=[];
r=await call('/api/admin/films?q=beacon');assert.equal(r.body.items.length,25);assert.equal(r.body.limit,25);assert.equal(typeof r.body.nextCursor,'string');
for(const value of ['0','26','1.5','abc','','-1','25.0','+5',' 5']){gets=[];r=await call('/api/admin/films?q=beacon&limit='+encodeURIComponent(value));assert.equal(r.status,400,value);assert.equal(r.body.error,'invalid_limit');assert.deepEqual(gets,[],'no read for limit '+JSON.stringify(value));}
r=await call('/api/admin/films?q=beacon&limit=1');assert.equal(r.body.items.length,1);
r=await call('/api/admin/films?q=beacon&limit=25');assert.equal(r.body.items.length,25);
const walked=[];let cursor=null,pages=0;
do{r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(pin)+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(r.status,200,JSON.stringify(r.body));walked.push(...r.body.items.map(item=>item.id));cursor=r.body.nextCursor;pages++;}while(cursor);
assert.equal(pages,6);assert.equal(new Set(walked).size,30);
assert.deepEqual(walked.slice(0,3),['film:p00','film:p01','film:p02'],'rank, then id');
r=await call('/api/admin/films?q=beacon&cursor=garbage');assert.equal(r.status,400);assert.equal(r.body.error,'stale_cursor');assert.equal(Object.hasOwn(r.body,'items'),false);
r=await call('/api/admin/films?q=beacon&cursor='+encodeURIComponent('~'+'x'.repeat(4000)));assert.equal(r.status,400);assert.equal(r.body.error,'stale_cursor');
r=await call('/api/admin/films?q=beacon&limit=5');const first=r.body.nextCursor;
r=await call('/api/admin/films?q=beacon&limit=4&cursor='+encodeURIComponent(first));assert.equal(r.status,400);assert.equal(r.body.error,'stale_cursor','another limit');
r=await call('/api/admin/films?q=маяк&limit=5&cursor='+encodeURIComponent(first));assert.equal(r.status,400);assert.equal(r.body.error,'stale_cursor','another query');

// 6. Query validation at the HTTP boundary, before any read.
for(const path of ['/api/admin/films','/api/admin/people','/api/admin/films?q=','/api/admin/films?q=%20%20','/api/admin/films?q='+'a'.repeat(201),'/api/admin/films?q=...']){gets=[];r=await call(path);assert.equal(r.status,400,path);assert.equal(r.body.error,'invalid_query',path);}
assert.deepEqual(gets,SNAPSHOT_KEYS,'a query of punctuation only is refused by the library after the read');
r=await call('/api/admin/films?q='+'a'.repeat(200)+'&limit=1');assert.equal(r.status,200,'200 characters are accepted');
r=await call('/api/admin/films?q=beacon&pin=garbage');assert.equal(r.status,400);assert.equal(r.body.error,'invalid_pin');
r=await call('/api/admin/films?q=beacon&pin='+encodeURIComponent('1|a|b'));assert.equal(r.status,400);assert.equal(r.body.error,'invalid_pin');
r=await call('/api/admin/overview',{method:'POST'});assert.equal(r.status,405);assert.equal(r.body.error,'method_not_allowed');
r=await call('/api/admin/other');assert.equal(r.status,404);assert.equal(r.body.error,'not_found');
r=await call('/api/admin/');assert.equal(r.status,404);

// 7. Stale pin: a changed titles.json, people.json or generation refuses the old pin and its cursors; no items are filled.
seed();r=await call('/api/admin/films?q=beacon&limit=5');const pinA=r.body.pin,cursorA=r.body.nextCursor;
assert.equal(r.body.snapshot.programmeRunId,G1);
etags.set('titles.json','titles-2');
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(pinA));assert.equal(r.status,409);assert.equal(r.body.error,'stale_pin');assert.equal(Object.hasOwn(r.body,'items'),false);
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(pinA)+'&cursor='+encodeURIComponent(cursorA));assert.equal(r.status,409);assert.equal(r.body.error,'stale_pin');
r=await call('/api/admin/films?q=beacon&limit=5&cursor='+encodeURIComponent(cursorA));assert.equal(r.status,400);assert.equal(r.body.error,'stale_cursor','the cursor of an older titles version without a pin');
r=await call('/api/admin/films/film:H11k?pin='+encodeURIComponent(pinA));assert.equal(r.status,409);
r=await call('/api/admin/overview?pin='+encodeURIComponent(pinA));assert.equal(r.status,409);
r=await call('/api/admin/films?q=beacon&limit=5');assert.equal(r.status,200);const pinB=r.body.pin;assert.notEqual(pinB,pinA);
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(pinB)+'&cursor='+encodeURIComponent(r.body.nextCursor));assert.equal(r.status,200);assert.equal(r.body.items.length,5);
etags.set('people.json','people-2');
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(pinB));assert.equal(r.status,409);assert.equal(r.body.error,'stale_pin','people.json alone');
r=await call('/api/admin/films?q=beacon&limit=5');const pinC=r.body.pin,cursorC=r.body.nextCursor;
records.set(POINTER,{phase:'published',programmeRunId:G2,publishedAt:iso(1)});etags.set(POINTER,'ptr-'+G2);
records.set(programmeKey(G2),{...programmeOf(G2),updatedAt:iso(1)});etags.set(programmeKey(G2),'prog-'+G2);uploaded.set(programmeKey(G2),new Date(iso(1)));
gets=[];
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(pinC)+'&cursor='+encodeURIComponent(cursorC));assert.equal(r.status,409);assert.equal(r.body.error,'stale_pin','page 2 of generation A is not filled from generation B');
assert.equal(gets.includes(programmeKey(G1)),false,'the old generation is not read once the pointer moved');
r=await call('/api/admin/films?q=beacon&limit=5');assert.equal(r.status,200);assert.equal(r.body.snapshot.programmeRunId,G2);
assert.equal(gets.includes('programme.json'),false,'root programme.json is never read');
seed();r=await call('/api/admin/films?q=beacon&limit=5');const pinD=r.body.pin,cursorD=r.body.nextCursor;
etags.set(programmeKey(G1),'prog-rewritten');
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(pinD)+'&cursor='+encodeURIComponent(cursorD));assert.equal(r.status,409,'a rewritten programme object of the same run id');

// 8. Skew is diagnostic: older dictionaries and missing clocks still return the page and the next page.
seed();uploaded.set('titles.json',new Date(iso(-3)));
r=await call('/api/admin/films?q=beacon&limit=5');assert.equal(r.status,200);assert.equal(r.body.snapshot.skew,true);assert.deepEqual(r.body.snapshot.skewReasons,['dictionary_older']);
assert.equal(r.body.snapshot.titlesUpdatedAt,iso(-3));
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(r.body.pin)+'&cursor='+encodeURIComponent(r.body.nextCursor));assert.equal(r.status,200);assert.equal(r.body.items.length,5);
seed();uploaded.set('titles.json',new Date(iso(2)));uploaded.set('people.json',new Date(iso(3)));
r=await call('/api/admin/overview');assert.deepEqual(r.body.snapshot.skewReasons,['titles_newer','people_newer']);
seed();uploaded.delete('people.json');
r=await call('/api/admin/films?q=beacon&limit=5');assert.equal(r.status,200);assert.deepEqual(r.body.snapshot.skewReasons,['timestamp_missing']);assert.equal(r.body.snapshot.peopleUpdatedAt,null);
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(r.body.pin)+'&cursor='+encodeURIComponent(r.body.nextCursor));assert.equal(r.status,200,'the pin matches on versions, not clocks');
seed();records.delete('titles.json');records.delete('people.json');
r=await call('/api/admin/films?q=sol');assert.equal(r.status,200);assert.deepEqual(r.body.snapshot.skewReasons,['dictionary_missing']);assert.equal(r.body.snapshot.titlesUpdatedAt,null);
r=await call('/api/admin/people?q=sol');assert.equal(r.body.items[0].localization.status,'missing','no dictionary, no cache name');
assert.ok(r.body.pin.endsWith('||'),'absent dictionaries carry empty versions in the pin');
r=await call('/api/admin/people?q=sol&pin='+encodeURIComponent(r.body.pin));assert.equal(r.status,200);
seed();records.set('titles.json',{updatedAt:iso(-1),q2:records.get('titles.json').q2});
r=await call('/api/admin/overview');assert.equal(r.body.snapshot.titlesUpdatedAt,iso(-1),'a document clock wins over the upload time');

// 9. Unavailable programme: pointer missing, not published, generation object missing or of another run; root programme.json is not a fallback.
for(const [name,mutate] of [
 ['pointer missing',()=>records.delete(POINTER)],
 ['pointer staging',()=>records.set(POINTER,{phase:'staging',programmeRunId:G1})],
 ['pointer without run id',()=>records.set(POINTER,{phase:'published'})],
 ['pointer with an unsafe run id',()=>records.set(POINTER,{phase:'published',programmeRunId:'../programme'})],
 ['generation object missing',()=>records.delete(programmeKey(G1))],
 ['generation object of another run',()=>records.get(programmeKey(G1)).runId=G2],
]){
 seed();mutate();
 r=await call('/api/admin/films?q=beacon');
 assert.equal(r.status,503,name);assert.equal(r.body.error,'programme_unavailable',name);assert.equal(Object.hasOwn(r.body,'items'),false);
 assert.equal(gets.includes('programme.json'),false,name+': root programme.json');
 assert.equal(gets.some(key=>key.startsWith('epg/generations/../')),false,name);
 assert.deepEqual(puts,[]);assert.equal(lists,0);
}
seed();const realGet=bucket.get;bucket.get=async()=>{throw new Error('R2 is down');};
r=await call('/api/admin/films?q=beacon');assert.equal(r.status,503);assert.equal(r.body.error,'storage_unavailable');
bucket.get=realGet;

// 10. The pointer moves between the two reads: one retry, then a failure that names the pin state.
seed();
records.set(programmeKey(G2),{...programmeOf(G2),updatedAt:iso(1)});etags.set(programmeKey(G2),'prog-'+G2);uploaded.set(programmeKey(G2),new Date(iso(1)));
pointerSequence=[{body:{phase:'published',programmeRunId:G1},etag:'ptr-'+G1},{body:{phase:'published',programmeRunId:G2},etag:'ptr-'+G2}];
r=await call('/api/admin/films?q=beacon&limit=5');
assert.equal(r.status,200,JSON.stringify(r.body)+' '+JSON.stringify(gets));assert.equal(r.body.snapshot.programmeRunId,G2);
assert.deepEqual(gets,[POINTER,programmeKey(G1),POINTER,POINTER,programmeKey(G2),POINTER,'titles.json','people.json']);
seed();records.set(programmeKey(G2),{...programmeOf(G2),updatedAt:iso(1)});etags.set(programmeKey(G2),'prog-'+G2);
pointerSequence=[{body:{phase:'published',programmeRunId:G1},etag:'a'},{body:{phase:'published',programmeRunId:G2},etag:'b'},{body:{phase:'published',programmeRunId:G1},etag:'c'},{body:{phase:'published',programmeRunId:G2},etag:'d'}];
r=await call('/api/admin/films?q=beacon&limit=5');assert.equal(r.status,503);assert.equal(r.body.error,'programme_unavailable');
assert.equal(gets.filter(key=>key===POINTER).length,4,'two attempts, two pointer reads each');
seed();records.set(programmeKey(G2),{...programmeOf(G2),updatedAt:iso(1)});etags.set(programmeKey(G2),'prog-'+G2);
r=await call('/api/admin/overview');const pinE=r.body.pin;
pointerSequence=[{body:{phase:'published',programmeRunId:G1},etag:'a'},{body:{phase:'published',programmeRunId:G2},etag:'b'},{body:{phase:'published',programmeRunId:G1},etag:'c'},{body:{phase:'published',programmeRunId:G2},etag:'d'}];
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(pinE));assert.equal(r.status,409);assert.equal(r.body.error,'stale_pin');
seed();pointerSequence=[{body:{phase:'published',programmeRunId:G1},etag:'ptr-'+G1},{body:{phase:'published',programmeRunId:G1},etag:'ptr-rewritten'}];
r=await call('/api/admin/overview');assert.equal(r.status,200,'a rewritten pointer of the same run retries once and succeeds');

// 11. Warm isolate: the same tuple re-reads the five versions and parses nothing; one changed dictionary re-parses that object only.
seed();
r=await call('/api/admin/overview');assert.equal(parses,5);
gets=[];parses=0;
r=await call('/api/admin/films?q=beacon&limit=5');
assert.deepEqual(gets,SNAPSHOT_KEYS);assert.equal(parses,2,'only the two small pointer reads are parsed for a held tuple');
etags.set('titles.json','titles-3');records.set('titles.json',{...records.get('titles.json'),H11k:{tmdbId:'1137844',title:'Мэйдэй (кэш)',status:'provisional'}});
gets=[];parses=0;
r=await call('/api/admin/films?q=mayday');
assert.deepEqual(gets,SNAPSHOT_KEYS);assert.equal(parses,3,'the two pointer reads and the changed dictionary; the programme body is reused');
assert.equal(r.body.items[0].localization.status,'reviewed','the reviewed title still wins over a cached one');
resetCache();gets=[];parses=0;
r=await call('/api/admin/films?q=mayday');assert.equal(parses,5,'a fresh isolate parses every object');

// 12. Empty etags: the version is a hash of the bytes, stable across reads.
seed();for(const key of records.keys())etags.set(key,'');
r=await call('/api/admin/overview');assert.equal(r.status,200);
const parts=r.body.pin.split('|').map(decodeURIComponent);
assert.equal(parts[2],createHash('sha256').update(JSON.stringify(records.get(POINTER))).digest('hex'));
assert.equal(parts[3],createHash('sha256').update(JSON.stringify(records.get(programmeKey(G1)))).digest('hex'));
const pinF=r.body.pin;
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(pinF));assert.equal(r.status,200);
records.set('titles.json',{...records.get('titles.json'),extra:{title:'x'}});
r=await call('/api/admin/films?q=beacon&limit=5&pin='+encodeURIComponent(pinF));assert.equal(r.status,409,'a changed body with an empty etag is a new version');

// 13. The page keeps the search in the URL contract: query and queue echo back, and an unknown route under /api/ still 404s.
seed();r=await call('/api/admin/people?q=sol&queue=localization-provisional');assert.equal(r.status,200);assert.deepEqual(r.body.items.map(item=>item.id),['person:actor/mira-sol']);assert.equal(r.body.queue,'localization-provisional');
assert.deepEqual(puts,[]);assert.equal(lists,0);assert.deepEqual(fetches,[]);
console.log('Admin read API: pinned snapshot, bounded pages, stale pin/cursor, skew, unavailable programme and warm reuse passed');
