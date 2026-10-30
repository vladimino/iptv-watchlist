// GET /api/admin/limbo: the published snapshot of the admin read plus two bounded enrichment objects (the prediction queue
// and the view index), evaluated by the pure data health model and paged under an extended pin. Covers the card's cases:
// 14+ days without progress, a retry due tomorrow, progress today, projection lag, observations without a Film, a stale
// pin, missing evidence, a changing generation, partial pages, and no bucket listing, no write, no outbound request.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const source=fs.readFileSync('src/admin/limbo.js','utf8');
assert.doesNotMatch(source,/loadJSON|saveJSON|recoverStopEvents|enrichmentView|BUCKET\.(?:put|list|delete|head)|\.put\(|\.list\(|\.delete\(|\bfetch\(|waitUntil|resolver-lease|resolver-continuation|discovery-latest|discovery-resolution|discovered-films|enrichment\/films|get\('programme\.json'|\.prepare\(|readFilmState|refreshPredictionQueue/,'the limbo read never writes, lists, scans films, falls back or reaches another store');
assert.match(source,/ENRICHMENT_KEY\+'prediction-queue\.json'/);
assert.match(source,/ENRICHMENT_KEY\+'view-index\.json'/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/url\.pathname==='\/api\/admin\/limbo'\)return await adminLimboRoute\(request,env,url\)/);
const build=fs.readFileSync('build.mjs','utf8');
assert.match(build,/scoped\('src\/domain\/data-health\.js','DataHealth'\)/);
assert.match(build,/scoped\('src\/domain\/limbo-inventory\.js','LimboInventory'\)/);
assert.ok(build.indexOf('src/admin/read.js')<build.indexOf('src/admin/limbo.js')&&build.indexOf('src/admin/limbo.js')<build.indexOf("src/worker.js','utf8'));"),'the limbo module follows the read module and precedes the Worker entry');
assert.match(build,/assets\['\/admin\/limbo'\]/);
assert.match(build,/src\/admin\/limbo-client\.js/);

// R2 stand-in with etags and counters, as in the admin read test: every body is a real stream that must be consumed or cancelled.
const records=new Map(),etags=new Map(),uploaded=new Map();
let gets=[],puts=[],lists=0,fetches=[];
const streams={opened:[],consumed:[],cancelled:[]};
const bucket={
 async get(key){
  gets.push(key);
  if(!records.has(key))return null;
  const text=JSON.stringify(records.get(key)),etag=etags.get(key);
  streams.opened.push(key);
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(text));controller.close();},cancel(){streams.cancelled.push(key);}});
  const read=async()=>{const consumed=await new Response(body).text();streams.consumed.push(key);return consumed;};
  return {etag,uploaded:uploaded.has(key)?uploaded.get(key):undefined,body,json:async()=>JSON.parse(await read()),text:read};
 },
 async put(key){puts.push(key);},
 async delete(key){puts.push('delete:'+key);},
 async list(){lists++;return {objects:[],truncated:false};},
};
const env={BUCKET:bucket};
let clockNow=Date.parse('2026-10-30T12:00:00.000Z');
const FrozenDate=class extends Date{constructor(...args){super(...(args.length?args:[clockNow]));}static now(){return clockNow;}};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date:FrozenDate,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,atob,btoa,crypto:webcrypto,console,setTimeout,structuredClone,
 ASSETS:{},INITIAL_PERSONAL_RATINGS:{},FILM_TITLE_DICTIONARY:[],PERSON_NAME_DICTIONARY:[],
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
for(const file of ['src/domain/film-person.js','src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/prediction-quality.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/migration-export.js','src/filter-presets.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
vm.runInContext(scoped('src/domain/admin-query.js','AdminQuery'),context);
vm.runInContext(scoped('src/domain/data-health.js','DataHealth'),context);
vm.runInContext(scoped('src/domain/limbo-inventory.js','LimboInventory'),context);
vm.runInContext(fs.readFileSync('src/admin/read.js','utf8'),context);
vm.runInContext(source,context);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker;
const resetCache=()=>vm.runInContext('ADMIN_SNAPSHOT_CACHE=null;ADMIN_LIMBO_CACHE=null',context);

const POINTER='epg/published-generation.json',QUEUE='enrichment/prediction-queue.json',INDEX='enrichment/view-index.json';
const G1='11111111-1111-4111-8111-111111111111',G2='22222222-2222-4222-8222-222222222222';
const programmeKey=run=>'epg/generations/'+run+'/programme.json';
const NOW='2026-10-30T12:00:00.000Z',H=3600000,D=86400000;
const at=ms=>new Date(Date.parse(NOW)+ms).toISOString();
function programmeOf(run){
 const films=[
  {id:'fresh1',tmdbId:'1001',title:'Свежий',original:'Fresh One',titleRu:'Свежий',titleStatus:'verified',year:2026,metadataAt:at(-2*D),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
  {id:'stale2',tmdbId:'1002',title:'Старый',original:'Stale Two',titleRu:'Старый',titleStatus:'verified',year:2018,metadataAt:at(-40*D),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
  {id:'blank3',title:'Blank Reel',original:'Blank Reel',year:2024,directors:[],actors:[],shows:[]},
  {id:'stalled4',tmdbId:'1004',title:'Застрявший',original:'Stalled Four',titleRu:'Застрявший',titleStatus:'verified',year:2020,metadataAt:at(-D),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
  {id:'tomorrow5',tmdbId:'1005',title:'Завтра',original:'Tomorrow Five',titleRu:'Завтра',titleStatus:'verified',year:2021,metadataAt:at(-D),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
  {id:'today6',tmdbId:'1006',title:'Сегодня',original:'Today Six',titleRu:'Сегодня',titleStatus:'verified',year:2022,metadataAt:at(-D),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
  {id:'noevidence7',tmdbId:'1007',title:'Без данных',original:'No Evidence Seven',titleRu:'Без данных',titleStatus:'verified',year:2023,metadataAt:at(-D),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
  {id:'overdue8',tmdbId:'1008',title:'Просрочен',original:'Overdue Eight',titleRu:'Просрочен',titleStatus:'verified',year:2019,metadataAt:at(-D),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
  {id:'beyond9',tmdbId:'1009',title:'За пределом',original:'Beyond Nine',titleRu:'За пределом',titleStatus:'verified',year:2017,metadataAt:at(-D),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[]},
 ];
 for(let index=0;index<30;index++)films.push({id:'p'+String(index).padStart(2,'0'),tmdbId:String(7000+index),title:'Маяк '+index,original:'Beacon '+index,titleRu:'Маяк '+index,titleStatus:'verified',directors:[],actors:[],shows:[]});
 return {runId:run,updatedAt:at(-5*H),watchlistCount:films.length,films,people:{directors:[],actors:[]},stats:{}};
}
function queueOf(run){
 return {schemaVersion:3,programmeRunId:run,refreshedAt:at(-H),lastCheckAt:at(-H),lastBatch:{finishedAt:at(-H),stage:'complete',reason:null},
  hotPending:['stalled4','tomorrow5','today6','noevidence7','overdue8','beyond9'],coldPending:['tmdb_5551'],pending:['stalled4','tomorrow5','today6','noevidence7','overdue8','beyond9'],
  retries:{tomorrow5:{attempts:2,retryAt:Date.parse(NOW)+3*H,kind:'parse_error',scope:'item',failedAt:at(-2*H),lastRunId:'run-7'},beyond9:{attempts:1,retryAt:Date.parse(NOW)+D,kind:'parse_error',scope:'item',failedAt:at(-H),lastRunId:'run-8'},overdue8:{attempts:1,retryAt:Date.parse(NOW)-5*H,kind:'parse_error',scope:'item',failedAt:at(-6*H),lastRunId:'run-6'}},
  work:{stalled4:{class:'prediction_only',requiredWork:'prediction_only'},today6:{class:'fingerprint_and_prediction',requiredWork:'fingerprint_and_prediction'},noevidence7:{class:'missing',requiredWork:'fingerprint_and_prediction'}},
  priority:{},metrics:{}};
}
function indexOf(){
 return {
  stalled4:{fingerprintHash:'f4',prediction:{generatedAt:at(-20*D),predictedRating:3.5}},
  tomorrow5:{fingerprintHash:'f5',prediction:{generatedAt:at(-3*D)}},
  today6:{fingerprintHash:'f6',prediction:{generatedAt:at(-2*H)}},
  overdue8:{fingerprintHash:'f8',prediction:{generatedAt:at(-D)}},
  beyond9:{fingerprintHash:'f9',prediction:{generatedAt:at(-D)}},
  fresh1:{fingerprintHash:'f1',prediction:{generatedAt:at(-D)}},
  tmdb_5551:{fingerprintHash:'c1',prediction:{generatedAt:at(-30*D)}},
 };
}
function seed({run=G1,queueRun=run,queue=true,index=true}={}){
 records.clear();etags.clear();uploaded.clear();gets=[];puts=[];lists=0;fetches=[];resetCache();resetStreams();clockNow=Date.parse(NOW);
 records.set(POINTER,{phase:'published',programmeRunId:run,publishedAt:at(-5*H)});etags.set(POINTER,'ptr-'+run);uploaded.set(POINTER,new Date(NOW));
 records.set(programmeKey(run),programmeOf(run));etags.set(programmeKey(run),'prog-'+run);uploaded.set(programmeKey(run),new Date(NOW));
 records.set('programme.json',{runId:'root-must-not-be-read',films:[]});etags.set('programme.json','root');
 records.set('titles.json',{});etags.set('titles.json','titles-1');uploaded.set('titles.json',new Date(NOW));
 records.set('people.json',{});etags.set('people.json','people-1');uploaded.set('people.json',new Date(NOW));
 records.set('epg/discovery-resolution.json',{'must|not':{status:'needs_verification'}});etags.set('epg/discovery-resolution.json','ledger');
 if(queue){records.set(QUEUE,queueOf(queueRun));etags.set(QUEUE,'queue-1');uploaded.set(QUEUE,new Date(NOW));}
 if(index){records.set(INDEX,indexOf());etags.set(INDEX,'index-1');uploaded.set(INDEX,new Date(NOW));}
}
const openStreams=()=>streams.opened.length-streams.consumed.length-streams.cancelled.length;
const resetStreams=()=>{streams.opened.length=0;streams.consumed.length=0;streams.cancelled.length=0;};
const call=async(path,init)=>{const response=await worker.fetch(new Request('https://iptv.example'+path,init),env,{waitUntil(){throw new Error('background work on a GET');}});assert.equal(openStreams(),0,'every opened R2 body is consumed or cancelled after '+path);return {status:response.status,body:await response.json()};};
const SNAPSHOT_KEYS=[POINTER,programmeKey(G1),POINTER,'titles.json','people.json',QUEUE,INDEX];
const byId=(r,id)=>r.body.items.find(item=>item.id===id);
const q=object=>'?'+new URLSearchParams(object).toString();

// 1. The whole inventory: seven reads in order, no list, no write, no request, no ledger; the pin, the snapshot and the vocabularies.
seed();
let r=await call('/api/admin/limbo');
assert.equal(r.status,200,JSON.stringify(r.body));
assert.deepEqual(gets,SNAPSHOT_KEYS);
assert.equal(lists,0);assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
assert.ok(!gets.includes('epg/discovery-resolution.json')&&!gets.includes('programme.json'));
assert.match(r.body.pin,/^L1\|1%7C/);
assert.equal(r.body.snapshot.programmeRunId,G1);
assert.equal(r.body.snapshot.evaluatedAt,NOW);
assert.equal(r.body.snapshot.queuePresent,true);assert.equal(r.body.snapshot.queueRefreshedAt,at(-H));assert.equal(r.body.snapshot.queueProgrammeRunId,G1);assert.equal(r.body.snapshot.indexPresent,true);
assert.deepEqual(r.body.snapshot.sources,[POINTER,'epg/generations/<programmeRunId>/programme.json','titles.json','people.json',QUEUE,INDEX]);
assert.deepEqual(r.body.vocabulary.causes,['retry_eligible','stalled','backoff','pending','manual_review','stale_projection','external_archive','unknown']);
assert.equal(r.body.limit,25);assert.equal(r.body.kind,null);assert.equal(r.body.age,null);
assert.deepEqual(r.body.coverage.observations,{available:false,reason:'no_bounded_projection',detail:r.body.coverage.observations.detail});
assert.equal(r.body.coverage.films,'partial');
assert.equal(r.body.coverage.filmsObserved,40,'39 programme films and one catalog film from the queue');
assert.equal(r.body.total,r.body.counts.total);
assert.ok(r.body.total<=25?r.body.nextCursor===null:typeof r.body.nextCursor==='string');
const pin=r.body.pin;

// 2. The card's cases, one film each. Causes come from the health model's progress rule.
const all=[];let cursor=null;
do{r=await call('/api/admin/limbo'+q({pin,...(cursor?{cursor}:{})}));assert.equal(r.status,200,JSON.stringify(r.body));all.push(...r.body.items);cursor=r.body.nextCursor;}while(cursor);
assert.equal(new Set(all.map(item=>item.id)).size,all.length,'no duplicates across pages');
const find=id=>all.find(item=>item.id===id);
// 14+ days without progress: a queued film whose last prediction is 20 days old and has no retry is stalled.
const stalled=find('prediction/stuck/film:film:stalled4');
assert.ok(stalled,JSON.stringify(all.map(item=>item.id)));
assert.deepEqual([stalled.cause,stalled.kind,stalled.subsystem,stalled.reason,stalled.progress.status,stalled.age.days,stalled.film.title,stalled.film.storedId,stalled.film.inProgramme,stalled.links.film],['stalled','film','prediction','no_progress','stalled',20,'Застрявший','stalled4',true,'/admin?kind=film&id=film%3Astalled4']);
assert.equal(stalled.age.lastProgressAt,at(-20*D));
assert.deepEqual(stalled.action,{suggested:'investigate',code:'prediction_retry',eligible:false,reason:'already_queued'},'a queued film is not re-queued; the queue itself is the question');
assert.equal(stalled.film.identity.canonicalIdentity,'tmdb:1004');
assert.equal(find('fingerprint/stuck/film:film:stalled4'),undefined,'prediction_only work keeps the fingerprint current');
// Retry later: a retry inside the six-hour prediction cap is a valid backoff, never stuck; one scheduled a day ahead is beyond the policy.
const tomorrow=find('prediction/incomplete/film:film:tomorrow5');
assert.deepEqual([tomorrow.cause,tomorrow.progress.status,tomorrow.progress.retryAt,tomorrow.progress.attempts,tomorrow.diagnostics.failureReason,tomorrow.diagnostics.retryScope,tomorrow.diagnostics.lastRunId,tomorrow.action.reason],['backoff','waiting',at(3*H),2,'parse_error','item','run-7','in_backoff']);
const beyond=find('prediction/stuck/film:film:beyond9');
assert.deepEqual([beyond.cause,beyond.progress.status,beyond.reason,beyond.threshold.code],['retry_eligible','overdue','backoff_beyond_policy','predictionMaxBackoffMs']);
// Moved today: recent progress is pending, and the fingerprint work is listed beside the prediction.
const today=find('prediction/incomplete/film:film:today6');
assert.deepEqual([today.cause,today.progress.status,today.reason,today.age.days,today.action.reason],['pending','progressing','work_queued',0,'already_queued']);
const todayFingerprint=find('fingerprint/incomplete/film:film:today6');
assert.deepEqual([todayFingerprint.cause,todayFingerprint.reason,todayFingerprint.diagnostics.nextAction],['pending','work_queued','fingerprint_and_prediction']);
// Missing evidence: queued, no index entry, no retry: progress unknown and no eligibility claimed.
const noEvidence=find('prediction/incomplete/film:film:noevidence7');
assert.deepEqual([noEvidence.cause,noEvidence.progress.status,noEvidence.reason,noEvidence.age.ms,noEvidence.action.eligible,noEvidence.evidence.completeness],['unknown','unknown','work_queued',null,false,'complete']);
// Overdue retry: due five hours ago, beyond the two-hour grace, eligible now.
const overdue=find('prediction/stuck/film:film:overdue8');
assert.deepEqual([overdue.cause,overdue.progress.status,overdue.reason,overdue.progress.overdueMs,overdue.action],['retry_eligible','overdue','retry_overdue',5*H,{suggested:'bounded_action',code:'prediction_retry',eligible:true,reason:'eligible'}]);
// Metadata from the programme snapshot: stale and missing are actionable, fresh is silent.
const staleMeta=find('metadata/stale/film:film:stale2');
assert.deepEqual([staleMeta.cause,staleMeta.age.basis,staleMeta.age.days,staleMeta.action.code],['retry_eligible','freshness',40,'metadata_refresh']);
assert.equal(find('metadata/incomplete/film:film:blank3').cause,'retry_eligible');
assert.equal(all.some(item=>item.subjectId==='film:fresh1'),false,'a healthy film is not in limbo');
assert.equal(all.some(item=>item.subjectId==='film:blank3'&&item.subsystem==='identity'),false,'a Letterboxd film kept without TMDB is not an identity defect');
assert.equal(all.some(item=>item.subsystem==='poster'),false,'posters are not limbo items');
// A catalog film the programme does not carry: a minimal record with the queue's generation, no programme link claims.
const catalog=find('prediction/stuck/film:film:tmdb:5551');
assert.deepEqual([catalog.cause,catalog.film.storedId,catalog.film.inProgramme,catalog.film.title,catalog.film.identity.status,catalog.age.days],['stalled','tmdb_5551',false,null,null,30]);
assert.deepEqual([catalog.links.film,catalog.links.filmUnavailable],[null,'not_in_programme'],'the catalogue detail reads the programme only: no link that would answer 404');
assert.deepEqual([stalled.links.film,stalled.links.filmUnavailable],['/admin?kind=film&id=film%3Astalled4',null]);
// Every film link the inventory gives opens a record in the catalogue detail route.
for(const item of all.filter(entry=>entry.links.film)){const detail=await call('/api/admin/films/'+encodeURIComponent(item.film.id));assert.equal(detail.status,200,item.links.film);}
const missingDetail=await call('/api/admin/films/'+encodeURIComponent('film:tmdb:5551'));assert.equal(missingDetail.status,404,'the queue-only film really is absent from the catalogue detail');
// Counts cover the whole inventory and agree with the items.
assert.equal(r.body.counts.total,all.length);
assert.equal(r.body.counts.byCause.stalled,all.filter(item=>item.cause==='stalled').length);
assert.equal(r.body.counts.byKind.observation,0);
assert.deepEqual(r.body.context.map(issue=>[issue.id,issue.severity,issue.reason]),[['prediction_queue/incomplete/queue:prediction','info','work_pending']],'a fresh programme and a recently checked queue leave only the pending-work note');
assert.deepEqual(r.body.unread.map(entry=>entry.subsystem),['discovery','letterboxd_archive'],'what this read does not load is named, not shown as healthy');
assert.equal(r.body.thresholds.stalledMs,14*D);

// 3. Filters: by cause, subsystem, kind and age; unknown values are 400 before any read; observations are an honest empty list.
for(const path of ['/api/admin/limbo?cause=nope','/api/admin/limbo?subsystem=poster','/api/admin/limbo?kind=person','/api/admin/limbo?age=-1','/api/admin/limbo?age=366','/api/admin/limbo?age=1.5','/api/admin/limbo?age=abc','/api/admin/limbo?limit=0','/api/admin/limbo?limit=26','/api/admin/limbo?pin=garbage','/api/admin/limbo?pin='+encodeURIComponent('1|a|b|c|d|e')]){
 gets=[];r=await call(path);assert.equal(r.status,400,path);assert.deepEqual(gets,[],path+' cost no read');
}
assert.equal((await call('/api/admin/limbo?cause=nope')).body.error,'unknown_cause');
assert.equal((await call('/api/admin/limbo?subsystem=poster')).body.error,'unknown_subsystem');
assert.equal((await call('/api/admin/limbo?kind=person')).body.error,'unknown_kind');
assert.equal((await call('/api/admin/limbo?age=366')).body.error,'invalid_age');
assert.equal((await call('/api/admin/limbo?limit=26')).body.error,'invalid_limit');
assert.equal((await call('/api/admin/limbo?pin=garbage')).body.error,'invalid_pin');
r=await call('/api/admin/limbo?cause=backoff&pin='+encodeURIComponent(pin));
assert.deepEqual(r.body.items.map(item=>item.id),['prediction/incomplete/film:film:tomorrow5']);assert.equal(r.body.total,1);assert.equal(r.body.cause,'backoff');
assert.equal(r.body.counts.total,all.length,'counts stay those of the whole inventory');
r=await call('/api/admin/limbo?subsystem=metadata');
assert.ok(r.body.items.length>0&&r.body.items.every(item=>item.subsystem==='metadata'));
r=await call('/api/admin/limbo?kind=observation');
assert.equal(r.status,200);assert.deepEqual(r.body.items,[]);assert.equal(r.body.total,0);assert.equal(r.body.coverage.observations.available,false,'no observation is claimed healthy: the source is unavailable');
const walkAll=async path=>{const out=[];let next=null;do{const page=await call(path+(next?'&cursor='+encodeURIComponent(next):''));assert.equal(page.status,200,JSON.stringify(page.body));out.push(...page.body.items);next=page.body.nextCursor;}while(next);return out;};
const aged=await walkAll('/api/admin/limbo?age=14');
assert.ok(aged.some(item=>item.id==='prediction/stuck/film:film:stalled4'));
assert.ok(aged.some(item=>item.id==='prediction/incomplete/film:film:noevidence7'),'an unknown age is kept by an age filter');
assert.equal(aged.some(item=>item.id==='prediction/incomplete/film:film:today6'),false);
assert.ok(aged.every(item=>item.age.ms===null||item.age.ms>=14*D));
r=await call('/api/admin/limbo?age=0');assert.equal(r.body.total,all.length);
r=await call('/api/admin/limbo?cause=retry_eligible&subsystem=prediction&kind=film&age=0');
assert.deepEqual(r.body.items.map(item=>item.id),['prediction/stuck/film:film:beyond9','prediction/stuck/film:film:overdue8'],'an overdue retry and one scheduled beyond the policy cap are both retryable');

// 4. Partial pages: a cursor walks the filtered list under the pin without duplicates; another filter, limit or evaluation refuses it.
const walked=[];cursor=null;let pages=0;
do{r=await call('/api/admin/limbo'+q({limit:'2',pin,...(cursor?{cursor}:{})}));assert.equal(r.status,200,JSON.stringify(r.body));walked.push(...r.body.items.map(item=>item.id));cursor=r.body.nextCursor;pages++;}while(cursor);
assert.deepEqual(walked,all.map(item=>item.id));assert.equal(pages,Math.ceil(all.length/2));
r=await call('/api/admin/limbo?limit=2');const firstCursor=r.body.nextCursor;
r=await call('/api/admin/limbo?limit=3&cursor='+encodeURIComponent(firstCursor));assert.equal(r.status,400);assert.equal(r.body.error,'stale_cursor','another limit');
r=await call('/api/admin/limbo?limit=2&cause=backoff&cursor='+encodeURIComponent(firstCursor));assert.equal(r.status,400);assert.equal(r.body.error,'stale_cursor','another filter');
r=await call('/api/admin/limbo?cursor=garbage');assert.equal(r.status,400);assert.equal(r.body.error,'stale_cursor');
r=await call('/api/admin/limbo?cursor='+encodeURIComponent('x'.repeat(4001)));assert.equal(r.status,400);assert.equal(r.body.error,'stale_cursor');
// The clock moves between pages: the cursor carries the evaluation clock, so page two is cut from the same evaluation.
r=await call('/api/admin/limbo?limit=2');const page1=r.body.items.map(item=>item.id),cursor1=r.body.nextCursor;
clockNow+=3*D;
r=await call('/api/admin/limbo?limit=2&cursor='+encodeURIComponent(cursor1));assert.equal(r.status,200);
assert.equal(r.body.snapshot.evaluatedAt,NOW,'the evaluation clock of the first page is reused');
assert.deepEqual([...page1,...r.body.items.map(item=>item.id)],all.map(item=>item.id).slice(0,4));
r=await call('/api/admin/limbo?limit=2');assert.equal(r.body.snapshot.evaluatedAt,at(3*D),'a fresh first page evaluates at the current clock');
clockNow=Date.parse(NOW);

// 5. Stale pin: the queue changed under the held pin; the admin pin alone is not enough; the base objects still refuse too.
seed();r=await call('/api/admin/limbo?limit=5');const pinA=r.body.pin,cursorA=r.body.nextCursor;
etags.set(QUEUE,'queue-2');
r=await call('/api/admin/limbo?pin='+encodeURIComponent(pinA));assert.equal(r.status,409);assert.equal(r.body.error,'stale_pin');assert.equal(Object.hasOwn(r.body,'items'),false);
r=await call('/api/admin/limbo?limit=5&pin='+encodeURIComponent(pinA)+'&cursor='+encodeURIComponent(cursorA));assert.equal(r.status,409);
r=await call('/api/admin/limbo?limit=5&cursor='+encodeURIComponent(cursorA));assert.equal(r.status,400);assert.equal(r.body.error,'stale_cursor','a cursor of the older queue version without a pin');
r=await call('/api/admin/limbo?limit=5');assert.equal(r.status,200);const pinB=r.body.pin;assert.notEqual(pinB,pinA);
etags.set(INDEX,'index-2');
r=await call('/api/admin/limbo?pin='+encodeURIComponent(pinB));assert.equal(r.status,409,'the view index alone');
r=await call('/api/admin/limbo');const pinC=r.body.pin;
etags.set('titles.json','titles-2');
r=await call('/api/admin/limbo?pin='+encodeURIComponent(pinC));assert.equal(r.status,409,'a dictionary of the base snapshot');
const adminPin=(await call('/api/admin/overview')).body.pin;
r=await call('/api/admin/limbo?pin='+encodeURIComponent(adminPin));assert.equal(r.status,400);assert.equal(r.body.error,'invalid_pin','an admin pin is not a limbo pin');

// 6. Projection lag: the queue was built for the previous generation. Its films are stale projections, not eligible, and the context says so.
seed({queueRun:G2});
r=await call('/api/admin/limbo');
assert.equal(r.status,200);
assert.ok(r.body.context.some(issue=>issue.id==='prediction_queue/stale/queue:prediction'&&issue.reason==='projection_generation_differs'),JSON.stringify(r.body.context));
assert.equal(r.body.snapshot.queueProgrammeRunId,G2);
const lagging=await walkAll('/api/admin/limbo?limit=25');
const laggingCatalog=lagging.find(item=>item.id==='prediction/stuck/film:film:tmdb:5551');
assert.deepEqual([laggingCatalog.cause,laggingCatalog.action.reason,laggingCatalog.evidence.anomalies],['stale_projection','generation_changed',['projection_generation_differs']]);
// Fail closed: every per-film diagnosis derived from that queue is a stale projection, never an eligible action, even for a
// programme film of the published generation (its overdue retry, its stalled prediction, its queued work).
const queueDerived=lagging.filter(item=>item.subsystem==='prediction'||item.subsystem==='fingerprint');
assert.ok(queueDerived.length>=6,JSON.stringify(queueDerived.map(item=>item.id)));
for(const item of queueDerived){
 assert.equal(item.cause,'stale_projection',item.id);
 assert.deepEqual(item.action,{suggested:'wait',code:'reread_snapshot',eligible:false,reason:'generation_changed'},item.id);
 assert.ok(item.evidence.anomalies.includes('projection_generation_differs'),item.id);
}
for(const id of ['prediction/stuck/film:film:overdue8','prediction/stuck/film:film:beyond9','prediction/stuck/film:film:stalled4'])assert.ok(queueDerived.some(item=>item.id===id),id);
assert.equal(lagging.some(item=>item.action.eligible===true&&(item.subsystem==='prediction'||item.subsystem==='fingerprint')),false,'no queue-derived item is actionable');
// Programme-derived diagnoses of the published generation keep their own verdict.
const laggingMeta=lagging.find(item=>item.id==='metadata/stale/film:film:stale2');
assert.deepEqual([laggingMeta.cause,laggingMeta.action.eligible,laggingMeta.evidence.anomalies],['retry_eligible',true,[]]);
r=await walkAll('/api/admin/limbo?cause=stale_projection&limit=25');
assert.deepEqual(r.map(item=>item.id).sort(),queueDerived.map(item=>item.id).sort());

// 7. Changing generation: the pointer moves to a generation whose programme object is absent; no root fallback, no items.
seed();r=await call('/api/admin/limbo');const pinG1=r.body.pin;
records.set(POINTER,{phase:'published',programmeRunId:G2,publishedAt:NOW});etags.set(POINTER,'ptr-'+G2);
r=await call('/api/admin/limbo?pin='+encodeURIComponent(pinG1));assert.equal(r.status,503);assert.equal(r.body.error,'programme_unavailable');
assert.ok(!gets.includes('programme.json'));
records.set(programmeKey(G2),programmeOf(G2));etags.set(programmeKey(G2),'prog-'+G2);
r=await call('/api/admin/limbo?pin='+encodeURIComponent(pinG1));assert.equal(r.status,409);assert.equal(r.body.error,'stale_pin');
r=await call('/api/admin/limbo');assert.equal(r.status,200);assert.equal(r.body.snapshot.programmeRunId,G2);
assert.ok(r.body.context.some(issue=>issue.id==='prediction_queue/stale/queue:prediction'),'the queue of the old generation is now a stale projection');

// 8. Missing objects: no queue is reported as missing evidence, never as a clear queue; no index leaves predictions without a clock.
seed({queue:false});
r=await call('/api/admin/limbo');
assert.equal(r.status,200);
assert.equal(r.body.snapshot.queuePresent,false);
assert.ok(r.body.unread.some(entry=>entry.subsystem==='prediction_queue'&&entry.evidence==='object_missing'),JSON.stringify(r.body.unread));
assert.equal(r.body.context.some(issue=>issue.subsystem==='prediction_queue'),false,'an absent queue is unread, not a clear queue');
assert.equal(r.body.items.some(item=>item.subsystem==='prediction'),false,'without the queue no prediction state is observed');
assert.ok((await walkAll('/api/admin/limbo?limit=25')).some(item=>item.id==='metadata/stale/film:film:stale2'),'the programme part still answers');
r=await call('/api/admin/limbo');
assert.match(r.body.pin,/\|\|index-1$/,'a missing queue is an empty version in the pin');
seed({index:false});
r=await call('/api/admin/limbo');
assert.equal(r.body.snapshot.indexPresent,false);
const noIndex=(await walkAll('/api/admin/limbo?limit=25')).find(item=>item.id==='prediction/incomplete/film:film:stalled4');
assert.deepEqual([noIndex.cause,noIndex.progress.status,noIndex.reason],['unknown','unknown','work_queued'],'without the index the prediction has no clock and is not called stalled');

// 9. Unavailable programme and storage: the same codes as the admin read.
seed();records.delete(POINTER);resetCache();
r=await call('/api/admin/limbo');assert.equal(r.status,503);assert.equal(r.body.error,'programme_unavailable');
seed();const failing={...bucket,async get(key){gets.push(key);if(key===QUEUE)throw new Error('r2 down');return bucket.get(key);}};
const response=await worker.fetch(new Request('https://iptv.example/api/admin/limbo'),{BUCKET:failing},{waitUntil(){throw new Error('background');}});
assert.equal(response.status,503);assert.equal((await response.json()).error,'storage_unavailable');
seed();
r=await call('/api/admin/limbo',{method:'POST'});assert.equal(r.status,405);assert.equal(r.body.error,'method_not_allowed');

// 10. Warm isolate: the same tuple re-reads the seven versions and reuses the parsed bodies; a changed queue is reparsed alone.
seed();await call('/api/admin/limbo');
resetStreams();gets=[];
r=await call('/api/admin/limbo');
assert.deepEqual(gets,SNAPSHOT_KEYS);
assert.deepEqual(streams.consumed.sort(),[POINTER,POINTER],'only the pointers are parsed on a warm read');
assert.equal(streams.cancelled.length,5,'the five reused bodies are cancelled');
etags.set(QUEUE,'queue-3');resetStreams();
r=await call('/api/admin/limbo');
assert.deepEqual(streams.consumed.sort(),[POINTER,POINTER,QUEUE].sort());

console.log('Admin limbo API: reads, causes, filters, pages, stale pin, projection lag, changing generation, missing objects and warm isolate passed');
