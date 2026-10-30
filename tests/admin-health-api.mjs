// GET /api/admin/health: the health snapshot from bounded single-object reads, evaluated by the pure data-health model
// and grouped for the owner page. No bucket listing, no lease or ledger read, no write, no outbound request; a
// source this read cannot open in a bounded way is unknown, never healthy.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const source=fs.readFileSync('src/admin/health.js','utf8');
assert.doesNotMatch(source,/loadJSON|saveJSON|recoverStopEvents|enrichmentView|BUCKET\.(?:put|list|delete|head)|\.put\(|\.list\(|\.delete\(|\bfetch\(|waitUntil|resolver-lease|discovery-latest|discovery-resolution|get\('programme\.json'|\.prepare\(|acquire|Lease\(/,'the health read never writes, lists, locks or reaches another store');
assert.match(fs.readFileSync('src/worker.js','utf8'),/url\.pathname==='\/api\/admin\/health'\)return await adminHealthRoute\(request,env,url\)/);
const build=fs.readFileSync('build.mjs','utf8');
assert.match(build,/scoped\('src\/domain\/data-health\.js','DataHealth'\)/);
assert.ok(build.indexOf("src/admin/read.js")<build.indexOf("src/admin/health.js")&&build.indexOf("src/admin/health.js")<build.indexOf("src/worker.js','utf8'));"),'read, health, then the Worker entry');

const records=new Map(),etags=new Map(),uploaded=new Map();
let gets=[],puts=[],lists=0,fetches=[];
const streams={opened:0,closed:0};
const bucket={
 async get(key){
  gets.push(key);
  if(!records.has(key))return null;
  const text=JSON.stringify(records.get(key));
  streams.opened++;
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(text));controller.close();},cancel(){streams.closed++;}});
  const read=async()=>{const value=await new Response(body).text();streams.closed++;return value;};
  return {etag:etags.get(key)||'e-'+key,uploaded:uploaded.get(key),body,json:async()=>JSON.parse(await read()),text:read};
 },
 async put(key){puts.push(key);},
 async delete(key){puts.push('delete:'+key);},
 async list(){lists++;return {objects:[],truncated:false};},
};
const env={BUCKET:bucket};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,atob,btoa,crypto:webcrypto,console,setTimeout,structuredClone,Number,Math,
 ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
for(const file of ['src/domain/film-person.js','src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/prediction-quality.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/migration-export.js','src/filter-presets.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
vm.runInContext(scoped('src/domain/admin-query.js','AdminQuery'),context);
vm.runInContext(fs.readFileSync('src/admin/read.js','utf8'),context);
vm.runInContext(scoped('src/domain/data-health.js','DataHealth'),context);
vm.runInContext(source,context);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker,constant=name=>vm.runInContext(name,context);
const resetCache=()=>vm.runInContext('ADMIN_SNAPSHOT_CACHE=null',context);

const POINTER='epg/published-generation.json',G1='11111111-1111-4111-8111-111111111111',G2='22222222-2222-4222-8222-222222222222';
const programmeKey=run=>'epg/generations/'+run+'/programme.json',catalogKey=run=>'epg/generations/'+run+'/discovered-films.json';
const VIEW_INDEX=constant('ENRICHMENT_KEY')+'view-index.json',PROFILE=constant('profileKey'),QUEUE=constant('predictionQueueKey'),CONTINUATION=constant('CONTINUATION_KEY');
const H=3600000,D=86400000,NOW=Date.now();
const ago=ms=>new Date(NOW-ms).toISOString(),ahead=ms=>new Date(NOW+ms).toISOString();
const HEALTH_KEYS=[POINTER,programmeKey(G1),POINTER,'titles.json','people.json',VIEW_INDEX,PROFILE,QUEUE,CONTINUATION,catalogKey(G1)];
const profile={version:1,profileHash:'p1'};
const prediction=(extra={})=>({predictedRating:4.2,probability4Plus:.7,confidence:'high',matchSignals:['x'],mainRisk:'y',moodLabels:['мрачный'],tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1,generatedAt:ago(2*D),...extra});
const fingerprint={fingerprintHash:'f',plotMechanics:['investigation'],moodLabels:['мрачный'],execution:{payoff:'strong',pacing:'unknown'}};
const current=(extra={})=>({prediction:prediction(extra),fingerprintHash:'f',impactFeatures:{fingerprintHash:'f',fingerprintSchemaVersion:1,fingerprintPromptVersion:1},fingerprint});
function film(id,extra){return {id,title:'Film '+id,original:'Film '+id,titleRu:'Фильм '+id,titleStatus:'verified',genres:['Драма'],metadataAt:ago(D),synopsis:'s',peopleVersion:1,directors:[],actors:[],shows:[],...extra};}
function seed(){
 records.clear();etags.clear();uploaded.clear();gets=[];puts=[];lists=0;fetches=[];streams.opened=0;streams.closed=0;resetCache();
 const films=[
  film('p00',{tmdbId:'7000',poster:'https://image.example/p00.jpg'}),             // everything current
  film('p01',{tmdbId:'7001',poster:'https://image.example/p01.jpg'}),             // stale prediction, old profile hash
  film('q2',{tmdbId:'900002',poster:null,metadataAt:ago(40*D)}),                   // queued, stale metadata, no poster
  film('b3',{titleRu:undefined,titleStatus:undefined,metadataAt:undefined,synopsis:undefined,peopleVersion:undefined}), // no TMDB id, no metadata
  film('c4',{tmdbId:'900004',titleConflicts:[{value:'Конфликт',source:'dictionary',reason:'owner_kept',authority:'owner'}]}), // retry beyond policy
  film('d5',{tmdbId:'900005'}),                                                    // retry inside backoff
 ];
 records.set(POINTER,{phase:'published',programmeRunId:G1,publishedAt:ago(5*H)});etags.set(POINTER,'ptr-1');
 records.set(programmeKey(G1),{runId:G1,updatedAt:ago(5*H),watchlistCount:films.length,films,people:{directors:[],actors:[]},stats:{}});etags.set(programmeKey(G1),'prog-1');
 records.set('titles.json',{});etags.set('titles.json','titles-1');
 records.set('people.json',{});etags.set('people.json','people-1');
 records.set(VIEW_INDEX,{p00:current(),p01:current({tasteProfileHash:'old'}),q2:{actualRating:3}});etags.set(VIEW_INDEX,'view-1');
 records.set(PROFILE,profile);etags.set(PROFILE,'profile-1');
 records.set(QUEUE,{schemaVersion:3,programmeRunId:G1,hotPending:['q2'],coldPending:['b3','c4','d5'],pending:['q2'],retries:{c4:{attempts:2,retryAt:NOW+10*H,failedAt:ago(H),kind:'model'},d5:{attempts:1,retryAt:NOW+H,failedAt:ago(H),kind:'quota'}},lastCheckAt:ago(H),lastBatch:{finishedAt:ago(H),stage:'complete'},refreshedAt:ago(H)});etags.set(QUEUE,'queue-1');
 records.set(CONTINUATION,{stage:'paused',reason:'chunk_budget',at:ago(H),nextCatchUpAt:ahead(H),retryAt:null,remainingChunks:3,programmeRunId:G1,hopId:'hop-1'});etags.set(CONTINUATION,'cont-1');
 records.set(catalogKey(G1),{tmdb_1:{id:'tmdb_1',tmdbId:'1',canonicalIdentity:'tmdb:1',poster:null},tmdb_2:{id:'tmdb_2',tmdbId:'2',canonicalIdentity:'tmdb:2',poster:'https://image.example/2.jpg'},tmdb_3:{id:'tmdb_3',tmdbId:'3',canonicalIdentity:null,poster:null}});etags.set(catalogKey(G1),'cat-1');
 records.set('programme.json',{runId:'root',films:[]});
}
const call=async(path,init)=>{const response=await worker.fetch(new Request('https://iptv.example'+path,init),env,{waitUntil(){throw new Error('background work on a GET');}});assert.equal(streams.opened,streams.closed,'every opened body is consumed or cancelled after '+path);return {status:response.status,body:await response.json()};};
const group=(body,predicate)=>body.health.groups.filter(predicate);
const oneGroup=(body,predicate,label)=>{const found=group(body,predicate);assert.equal(found.length,1,label+': '+JSON.stringify(found.map(item=>item.key)));return found[0];};

// 1. The bounded read: ten object reads in a fixed order, no list, no write, no request, and the admin pin.
seed();
let r=await call('/api/admin/health');
assert.equal(r.status,200,JSON.stringify(r.body).slice(0,400));
assert.deepEqual(gets,HEALTH_KEYS);
assert.deepEqual(r.body.reads,HEALTH_KEYS);
assert.equal(lists,0);assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
assert.equal(gets.includes('programme.json'),false);
const overview=await call('/api/admin/overview');
assert.equal(r.body.pin,overview.body.pin,'the health answer carries the admin snapshot pin');
assert.equal(r.body.snapshot.programmeRunId,G1);
const health=r.body.health;
assert.equal(health.schemaVersion,1);
assert.equal(health.scope.coverage.films,'complete');
assert.equal(health.scope.coverage.observations,'partial');
assert.deepEqual(health.scope.subjects,{films:6,observations:0});
assert.equal(Object.hasOwn(health.scope,'fields'),false,'per-film field lists stay out of the answer');
assert.deepEqual(health.scope.sources,{published:'observed',films:'observed',observations:'not_supplied',predictionQueue:'observed',discovery:'observed',posters:'observed',letterboxd:'not_supplied'});
assert.deepEqual(r.body.sources.observations.evidence,'not_supplied');
assert.match(r.body.sources.observations.reason,/resolution ledger/);
assert.match(r.body.sources.letterboxd.reason,/list the bucket/);
assert.equal(r.body.sources.viewIndex.entries,3);
assert.equal(r.body.sources.posters.catalogRecords,3);

// 2. Subsystems: observed ones carry their status, the two unbounded sources are unknown.
assert.equal(health.subsystems.programme.status,'clear');
assert.equal(health.subsystems.letterboxd_archive.status,'unknown');
assert.equal(health.subsystems.letterboxd_archive.evidence,'not_supplied');
assert.equal(health.subsystems.identity.status,'clear_in_scope','observations were not read, so identity cannot be clear');
assert.equal(health.subsystems.metadata.status,'attention');
assert.equal(health.subsystems.prediction.status,'attention');
assert.equal(health.subsystems.poster.status,'attention');
assert.equal(health.subsystems.discovery.status,'attention');
assert.equal(health.subsystems.prediction_queue.status,'attention');

// 3. Groups: ranked, with counts, samples and the action as the model states it.
const groups=health.groups;
assert.ok(groups.length>=6);
const rank={critical:0,warning:1,info:2};
for(let index=1;index<groups.length;index++)assert.ok(rank[groups[index-1].severity]<=rank[groups[index].severity],'groups keep the severity order');
const metadataMissing=oneGroup(r.body,item=>item.subsystem==='metadata'&&item.reason==='metadata_missing','metadata missing');
assert.equal(metadataMissing.severity,'warning');assert.deepEqual(metadataMissing.sample,['film:b3']);assert.equal(metadataMissing.issues,1);assert.equal(metadataMissing.action.code,'metadata_refresh');assert.equal(metadataMissing.action.eligible,true);
const metadataStale=oneGroup(r.body,item=>item.subsystem==='metadata'&&item.reason==='metadata_stale','metadata stale');
assert.deepEqual(metadataStale.sample,['film:q2']);assert.deepEqual(metadataStale.freshness,{stale:1});
assert.equal(group(r.body,item=>item.subsystem==='identity').length,0,'a Letterboxd film kept without TMDB is not an identity issue');
const localization=oneGroup(r.body,item=>item.subsystem==='localization','localization conflict');
assert.deepEqual(localization.sample,['film:c4']);assert.equal(localization.action.code,'manual_review');
const queuedPrediction=oneGroup(r.body,item=>item.subsystem==='prediction'&&item.reason==='work_queued','queued prediction');
assert.ok(queuedPrediction.sample.includes('film:q2'),'queue ids are re-keyed to the record ids');
assert.equal(queuedPrediction.action.reason,'already_queued');
const disagreement=oneGroup(r.body,item=>item.subsystem==='prediction'&&item.reason==='queue_disagreement','stale prediction the queue does not list');
assert.deepEqual(disagreement.sample,['film:p01']);
const beyond=oneGroup(r.body,item=>item.subsystem==='prediction'&&item.reason==='backoff_beyond_policy','retry beyond the policy cap');
assert.deepEqual(beyond.sample,['film:c4']);assert.equal(beyond.severity,'warning');assert.equal(beyond.category,'stuck');assert.equal(beyond.action.code,'prediction_retry');assert.equal(beyond.action.eligible,true);
const waiting=oneGroup(r.body,item=>item.subsystem==='prediction'&&item.reason==='retry_waiting','retry inside the backoff');
assert.deepEqual(waiting.sample,['film:d5']);assert.equal(waiting.severity,'info');assert.equal(waiting.action.reason,'in_backoff');assert.equal(typeof waiting.retryAt.earliest,'string');
const fingerprintQueued=group(r.body,item=>item.subsystem==='fingerprint');
assert.ok(fingerprintQueued.length>=1,'films without a fingerprint report under fingerprint');
assert.equal(group(r.body,item=>item.sample.includes('film:p00')).length,0,'a fully current film has no issue');
const posterFilm=oneGroup(r.body,item=>item.subsystem==='poster'&&item.reason==='poster_missing','film without poster');
assert.deepEqual(posterFilm.sample,['film:q2']);assert.equal(posterFilm.action.code,'poster_hydration');assert.equal(posterFilm.action.eligible,true);
const posterCatalog=oneGroup(r.body,item=>item.subsystem==='poster'&&item.reason==='posters_missing','catalog posters');
assert.equal(posterCatalog.affected,2);assert.equal(posterCatalog.subjectKind,'catalog');assert.equal(posterCatalog.action.eligible,true);
const discovery=oneGroup(r.body,item=>item.subsystem==='discovery','discovery gate');
assert.equal(discovery.reason,'retry_waiting');assert.equal(discovery.severity,'info');assert.equal(discovery.affected,3);
const queueWhole=group(r.body,item=>item.subsystem==='prediction_queue');
assert.equal(queueWhole.length,1);assert.equal(queueWhole[0].reason,'work_pending');
const archive=oneGroup(r.body,item=>item.subsystem==='letterboxd_archive','archive coverage');
assert.equal(archive.reason,'evidence_not_supplied');assert.equal(archive.subjectKind,'subsystem');assert.equal(archive.action.eligible,null);
assert.deepEqual(health.issues.map(item=>item.subject.kind).sort(),['archive','catalog','continuation','queue','subsystem'].filter(kind=>kind!=='archive'),'whole-object issues are returned in full');
assert.ok(health.issues.every(item=>item.subject.kind!=='film'));
for(const item of groups)assert.ok(item.sample.length<=10&&item.ids.length<=10);
assert.equal(health.counts.bySeverity.critical,0);

// 4. Missing sources: an absent view index or profile makes fingerprint and prediction unknown, not clear; an absent
// queue is a warning and weakens every film issue that needs it; an absent continuation or catalog copy is reported.
seed();records.delete(VIEW_INDEX);
r=await call('/api/admin/health');assert.equal(r.status,200);
assert.equal(r.body.health.subsystems.fingerprint.status,'unknown');assert.equal(r.body.health.subsystems.fingerprint.evidence,'object_missing');assert.equal(r.body.health.subsystems.fingerprint.derived,'view_index');
assert.equal(r.body.health.subsystems.prediction.status,'unknown');
assert.equal(group(r.body,item=>item.subsystem==='prediction'||item.subsystem==='fingerprint').length,0,'no envelope, no film issue, no false health');
assert.equal(r.body.sources.viewIndex.present,false);
seed();records.delete(PROFILE);
r=await call('/api/admin/health');assert.equal(r.body.health.subsystems.prediction.status,'unknown');assert.equal(r.body.sources.profile.present,false);
seed();records.delete(QUEUE);
r=await call('/api/admin/health');
const queueMissing=oneGroup(r.body,item=>item.subsystem==='prediction_queue','queue coverage');
assert.equal(queueMissing.reason,'evidence_object_missing');assert.equal(queueMissing.severity,'warning');
const weakened=oneGroup(r.body,item=>item.subsystem==='prediction'&&item.reason==='work_pending','pending without a queue');
assert.ok(weakened.missing.predictionQueue>=1);assert.equal(weakened.action.eligible,null);assert.equal(weakened.action.reason,'evidence_incomplete');
seed();records.delete(CONTINUATION);records.delete(catalogKey(G1));
r=await call('/api/admin/health');
assert.equal(oneGroup(r.body,item=>item.subsystem==='discovery','discovery coverage').reason,'evidence_object_missing');
assert.equal(r.body.sources.posters.present,false);
assert.equal(group(r.body,item=>item.subsystem==='poster'&&item.reason==='posters_missing').length,0);
assert.equal(r.body.health.subsystems.poster.status,'attention','the film without a poster still counts');

// 5. Generations and clocks: a queue of another generation, a stale programme, a future publication time.
seed();records.set(QUEUE,{...records.get(QUEUE),programmeRunId:G2});
r=await call('/api/admin/health');
assert.equal(oneGroup(r.body,item=>item.subsystem==='prediction_queue'&&item.reason==='projection_generation_differs','queue generation').severity,'warning');
seed();records.set(POINTER,{phase:'published',programmeRunId:G1,publishedAt:ago(3*D)});
r=await call('/api/admin/health');
const staleProgramme=oneGroup(r.body,item=>item.subsystem==='programme','stale programme');
assert.equal(staleProgramme.reason,'generation_stale');assert.equal(staleProgramme.action.code,'check_scheduled_tasks');
seed();records.set(POINTER,{phase:'published',programmeRunId:G1,publishedAt:ahead(D)});
r=await call('/api/admin/health');
assert.deepEqual(r.body.health.clock.anomalies,['clock_skew']);
assert.equal(oneGroup(r.body,item=>item.subsystem==='programme','future programme').reason,'progress_unknown');
seed();records.set(POINTER,{phase:'published',programmeRunId:G1});
r=await call('/api/admin/health');
assert.equal(r.body.health.published.publishedAt,records.get(programmeKey(G1)).updatedAt,'without a pointer clock the programme clock stands in');

// 6. Pin, method and failures follow the admin read contract.
seed();r=await call('/api/admin/health');const pin=r.body.pin;
r=await call('/api/admin/health?pin='+encodeURIComponent(pin));assert.equal(r.status,200);
etags.set('titles.json','titles-2');
r=await call('/api/admin/health?pin='+encodeURIComponent(pin));assert.equal(r.status,409);assert.equal(r.body.error,'stale_pin');assert.equal(Object.hasOwn(r.body,'health'),false);
r=await call('/api/admin/health');assert.equal(r.status,200);assert.notEqual(r.body.pin,pin);
r=await call('/api/admin/health?pin=garbage');assert.equal(r.status,400);assert.equal(r.body.error,'invalid_pin');
r=await call('/api/admin/health',{method:'POST'});assert.equal(r.status,405);
seed();records.delete(POINTER);
r=await call('/api/admin/health');assert.equal(r.status,503);assert.equal(r.body.error,'programme_unavailable');
seed();const realGet=bucket.get;bucket.get=async key=>{if(key===VIEW_INDEX)throw new Error('R2 is down');return realGet(key);};
r=await call('/api/admin/health');assert.equal(r.status,503);assert.equal(r.body.error,'storage_unavailable');
bucket.get=realGet;

// 7. An empty programme: no film issue, the observed whole-object subsystems clear, the unread ones unknown.
seed();records.set(programmeKey(G1),{runId:G1,updatedAt:ago(5*H),watchlistCount:0,films:[],people:{directors:[],actors:[]},stats:{}});
records.set(QUEUE,{schemaVersion:3,programmeRunId:G1,hotPending:[],coldPending:[],pending:[],retries:{},lastCheckAt:ago(H),lastBatch:{finishedAt:ago(H),stage:'noop'},refreshedAt:ago(H)});
records.set(CONTINUATION,{stage:'complete',reason:null,at:ago(H),remainingChunks:0,programmeRunId:G1});
records.set(catalogKey(G1),{tmdb_2:{id:'tmdb_2',tmdbId:'2',canonicalIdentity:'tmdb:2',poster:'https://image.example/2.jpg'}});
r=await call('/api/admin/health');assert.equal(r.status,200);
assert.deepEqual(r.body.health.groups.map(item=>item.reason),['evidence_not_supplied'],'only the unread archive remains, as unknown');
assert.equal(r.body.health.subsystems.prediction_queue.status,'clear');
assert.equal(r.body.health.subsystems.discovery.status,'clear');
assert.equal(r.body.health.subsystems.poster.status,'clear');
assert.equal(r.body.health.subsystems.identity.status,'clear_in_scope');
assert.equal(r.body.health.subsystems.letterboxd_archive.status,'unknown');
assert.deepEqual(puts,[]);assert.equal(lists,0);assert.deepEqual(fetches,[]);
console.log('Admin health API: bounded reads, grouped issues, unknown sources, generations, clocks, pin and failures passed');
