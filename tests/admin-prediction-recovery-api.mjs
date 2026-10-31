// GET /api/admin/prediction-recovery?film=<id>: the read-only recovery assessment of one stored film over the real
// prediction diagnostic loader. Covers the input checks, the pin (stable on identical reads, stale on any object change
// including a lease heartbeat, torn within one request), the verdicts through the Worker entry (ready, backoff, in
// flight, outside the catalog, no queue, no profile, a disagreeing snapshot), canary text that must not leave the
// Worker, and the absence of any write, listing, delete or outbound request.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const source=fs.readFileSync('src/admin/prediction-recovery.js','utf8');
assert.doesNotMatch(source,/saveJSON|mergeStoredJSON|refreshPredictionQueue|reconcile|BUCKET\.(?:put|list|delete|head)|\.put\(|\.list\(|\.delete\(|\bfetch\(|waitUntil|runnerLease\(|predictionWriter|\.prepare\(/,'the route never writes, lists, refreshes the queue, takes a lease or leaves the Worker');
assert.match(source,/const bucket=\{async get\(key\)\{/,'the loader sees a bucket that has nothing but get');
assert.match(fs.readFileSync('src/worker.js','utf8'),/url\.pathname==='\/api\/admin\/prediction-recovery'\)return await adminPredictionRecoveryRoute\(request,env,url\)/);
const build=fs.readFileSync('build.mjs','utf8');
assert.match(build,/scoped\('src\/domain\/prediction-recovery\.js','PredictionRecovery'\)/);
assert.ok(build.indexOf("src/prediction-diagnostics.js")<build.indexOf('src/admin/prediction-recovery.js')&&build.indexOf('src/admin/prediction-recovery.js')<build.indexOf("src/worker.js','utf8'));"),'the route follows the diagnostics and precedes the Worker entry');

const records=new Map(),etags=new Map();
let gets=[],writes=[],lists=0,fetches=[],failing=new Set(),bumpOnRead=null,version=0;
const set=(key,value)=>{records.set(key,value);etags.set(key,'"e'+(++version)+'"');};
const drop=key=>{records.delete(key);etags.delete(key);};
const bucket={
 async get(key){
  gets.push(key);
  if(failing.has(key)||failing.has('*'))throw new Error('R2 unavailable');
  if(!records.has(key))return null;
  const text=JSON.stringify(records.get(key)),etag=etags.get(key);
  if(bumpOnRead===key)etags.set(key,'"e'+(++version)+'"');
  return {etag,json:async()=>JSON.parse(text),text:async()=>text};
 },
 async put(key){writes.push('put:'+key);},
 async delete(key){writes.push('delete:'+key);},
 async list(){lists++;return {objects:[],truncated:false};},
 async head(key){writes.push('head:'+key);return null;},
};
const env={BUCKET:bucket};
const NOW='2026-10-31T09:00:00.000Z',H=3600000,M=60000;
let clockNow=Date.parse(NOW);
const at=ms=>new Date(clockNow+ms).toISOString();
const FrozenDate=class extends Date{constructor(...args){super(...(args.length?args:[clockNow]));}static now(){return clockNow;}};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date:FrozenDate,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,atob,btoa,crypto:webcrypto,console,setTimeout,structuredClone,encodeURIComponent,decodeURIComponent,
 ASSETS:{},INITIAL_PERSONAL_RATINGS:{},FILM_TITLE_DICTIONARY:[],PERSON_NAME_DICTIONARY:[],
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
for(const file of ['src/domain/film-person.js','src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/prediction-quality.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/migration-export.js','src/filter-presets.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
vm.runInContext(scoped('src/domain/admin-query.js','AdminQuery'),context);
vm.runInContext(scoped('src/domain/data-health.js','DataHealth'),context);
vm.runInContext(scoped('src/domain/limbo-inventory.js','LimboInventory'),context);
vm.runInContext(fs.readFileSync('src/admin/read.js','utf8'),context);
vm.runInContext(fs.readFileSync('src/admin/limbo.js','utf8'),context);
vm.runInContext(fs.readFileSync('src/prediction-diagnostics.js','utf8'),context);
vm.runInContext(scoped('src/domain/prediction-recovery.js','PredictionRecovery'),context);
vm.runInContext(source,context);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker;
const constant=name=>vm.runInContext(name,context);

const RUN='run-31',QUEUE='enrichment/prediction-queue.json',PROFILE='enrichment/profile/current.json',INDEX='enrichment/view-index.json';
const POINTER='epg/published-generation.json',PROGRAMME=`epg/generations/${RUN}/programme.json`,CATALOG=`epg/generations/${RUN}/discovered-films.json`;
const LEASE='enrichment/runner-lease.json',LATEST='enrichment/latest-run.json',FINGERPRINT='enrichment/films/w1/fingerprint.json',PREDICTIONS='enrichment/films/w1/predictions.json';
const READ_SET=[CATALOG,PROGRAMME,FINGERPRINT,PREDICTIONS,LATEST,QUEUE,PROFILE,LEASE,INDEX,POINTER].sort();
const CANARY=['CANARY-PROFILE-TEXT','CANARY-RISK','CANARY-PLOT','CANARY-TOKEN','CANARY-ISSUE'];
function seed(){
 records.clear();etags.clear();failing=new Set();bumpOnRead=null;
 set(POINTER,{phase:'published',programmeRunId:RUN});
 set(PROGRAMME,{runId:RUN,updatedAt:at(-5*H),films:[{id:'w1',tmdbId:'501',title:'Маяк',original:'Lighthouse',year:2019,genres:['drama'],directors:[],actors:[],shows:[]},{id:'w2',tmdbId:'502',title:'Другой',original:'Other',year:2020,directors:[],actors:[],shows:[]}],people:{directors:[],actors:[]},stats:{}});
 set(CATALOG,{});
 set(PROFILE,{version:4,profileHash:'hash-31',updatedAt:at(-2*H),profile:'CANARY-PROFILE-TEXT'});
 set(QUEUE,{schemaVersion:3,profileVersion:4,profileHash:'hash-31',programmeRunId:RUN,refreshedAt:at(-H),lastCheckAt:at(-H),lastBatch:{finishedAt:at(-90*M),stage:'complete',reason:null},hotPending:['w1'],coldPending:['w2'],pending:['w1'],priorityCount:1,retries:{}});
 set(INDEX,{});
 set(FINGERPRINT,{fingerprintSchemaVersion:constant('FINGERPRINT_SCHEMA_VERSION'),fingerprintHash:'fp-31',plotMechanics:['CANARY-PLOT']});
 set(PREDICTIONS,{current:{tasteProfileVersion:3,tasteProfileHash:'hash-old',fingerprintHash:'fp-31',fingerprintSchemaVersion:constant('FINGERPRINT_SCHEMA_VERSION'),mainRisk:'CANARY-RISK'}});
}
async function call(query,method='GET'){
 gets=[];
 const response=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/admin/prediction-recovery'+query,{method}),env,{waitUntil(){throw new Error('no background work');}});
 const text=await response.text();
 for(const canary of CANARY)assert.ok(!text.includes(canary),canary+' left the Worker');
 assert.equal(response.headers.get('Cache-Control'),'no-store');
 return {status:response.status,body:JSON.parse(text),text};
}
const queue=over=>({...records.get(QUEUE),...over});

// Input checks before any read.
seed();
for(const [query,status,code] of [['?film=w1','POST',405],['',null,400],['?film=',null,400],['?film=../x',null,400],['?film='+'a'.repeat(81),null,400],['?film=w1&pin=R1.zz',null,400],['?film=w1&pin=',null,400]]){
 const {status:got,body}=await call(query,status||'GET');
 assert.equal(got,code,query);
 assert.equal(body.error,code===405?'method_not_allowed':query.includes('pin')?'invalid_pin':'invalid_film',query);
 assert.deepEqual(gets,[],query+' read nothing');
}

// Ready in the hot lane, a recent queue check: wait for the scheduled run; the exact read set; no write of any kind.
seed();
const ready=await call('?film=w1');
assert.equal(ready.status,200);
assert.deepEqual([...new Set(gets)].sort(),READ_SET,'the read set: the diagnostic objects, the lease and the latest run');
assert.equal(ready.body.atomic,false);
assert.equal(ready.body.evaluatedAt,NOW);
assert.match(ready.body.pin,/^R1\.[0-9a-f]{32}$/);
assert.deepEqual(ready.body.sources,READ_SET.filter(key=>key!=='epg/discovered-films.json').sort((a,b)=>a.localeCompare(b,'en')));
const a=ready.body.assessment;
assert.equal(a.filmId,'w1');
assert.equal(a.status,'wait');
assert.equal(a.cause,'queued_ready');
assert.equal(a.nextExpected.kind,'scheduled_run');
assert.deepEqual(a.targetedAction,{available:false,capability:null,reason:'ordinary_schedule'});
assert.deepEqual(a.writer,{exists:false,decision:'no_go'});
assert.equal(a.facts.prediction.current,false);
assert.equal(a.facts.queue.lane,'hot');
assert.equal(a.evidence.completeness,'complete');
assert.deepEqual(a.missingPrerequisites,[]);
assert.equal(ready.body.snapshot.queue.lastActivityAt,at(-H));
assert.equal(ready.body.snapshot.profile.version,4);
assert.equal(ready.body.snapshot.runnerLease,'not_recorded');

// The pin: identical reads agree, a matching pin passes, any object change makes it stale.
const again=await call('?film=w1');
assert.equal(again.body.pin,ready.body.pin,'identical reads, identical pin');
assert.equal((await call('?film=w1&pin='+ready.body.pin)).status,200);
for(const [key,change] of [[QUEUE,()=>set(QUEUE,queue({lastCheckAt:at(-30*M)}))],[PROFILE,()=>set(PROFILE,{...records.get(PROFILE)})],[LEASE,()=>set(LEASE,{runId:'run-x',expiresAt:clockNow-M,heartbeatAt:at(-20*M)})],[PREDICTIONS,()=>drop(PREDICTIONS)]]){
 seed();
 const before=(await call('?film=w1')).body.pin;
 change();
 const stale=await call('?film=w1&pin='+before);
 assert.equal(stale.status,409,key+' change makes the pin stale');
 assert.equal(stale.body.error,'stale_pin');
 assert.notEqual((await call('?film=w1')).body.pin,before,key);
}
// A lease heartbeat alone (same content, new version) is a change.
seed();set(LEASE,{runId:'run-x',expiresAt:clockNow-M,heartbeatAt:at(-20*M)});
const leased=(await call('?film=w1')).body.pin;
set(LEASE,{...records.get(LEASE)});
assert.equal((await call('?film=w1&pin='+leased)).status,409);
// The pointer changing between its reads in one request: no later clean read can match that pin.
seed();bumpOnRead=POINTER;
const torn=(await call('?film=w1')).body.pin;
bumpOnRead=null;
const clean=(await call('?film=w1')).body.pin;
assert.equal((await call('?film=w1&pin='+torn)).status,409,'a torn read is never confirmed');
assert.equal((await call('?film=w1&pin='+clean)).status,200);

// Backoff, a due retry under repeated failures, sanitized retry details.
seed();
set(QUEUE,queue({retries:{w1:{attempts:2,retryAt:clockNow+3*H,kind:'Error: Bearer CANARY-TOKEN\nstack',scope:'item',failedAt:at(-2*H),lastRunId:'run-30',validation:{stage:'prediction_schema',issues:[{path:'mainRisk',code:'required',message:'CANARY-ISSUE'}]}}}}));
const backoff=(await call('?film=w1')).body.assessment;
assert.equal(backoff.cause,'retry_backoff');
assert.equal(backoff.nextExpected.at,at(3*H));
assert.equal(backoff.targetedAction.reason,'backoff_respected');
assert.equal(backoff.facts.retry.attempts,2);
set(QUEUE,queue({retries:{w1:{attempts:6,retryAt:clockNow-H,kind:'validation_error',scope:'item',failedAt:at(-7*H),lastRunId:'run-29'}}}));
const repeated=(await call('?film=w1')).body.assessment;
assert.equal(repeated.status,'investigate');
assert.equal(repeated.cause,'repeated_failures');
assert.equal(repeated.targetedAction.reason,'caller_contract');

// A live lease and a latest run that selected the film and has no result for it yet: in flight.
seed();
set(LEASE,{runId:'run-32',expiresAt:clockNow+10*M,heartbeatAt:at(-M)});
set(LATEST,{runId:'run-32',status:'running',selectedIds:['w1','w2'],results:{w2:{status:'added'}}});
const flight=(await call('?film=w1')).body;
assert.equal(flight.assessment.cause,'in_flight');
assert.deepEqual(flight.assessment.runner,{live:true,runId:'run-32',leaseExpiresAt:at(10*M),filmSelected:true});
assert.equal(flight.snapshot.runnerLease,'recorded');
set(LATEST,{runId:'run-32',status:'running',selectedIds:['w1','w2'],results:{w1:{status:'added'}}});
assert.equal((await call('?film=w1')).body.assessment.cause,'run_active');
clockNow+=11*M;
assert.equal((await call('?film=w1')).body.assessment.cause,'queued_ready','an expired lease is no run');
clockNow=Date.parse(NOW);

// Not in the programme, not in the catalog, not queued: an identity prerequisite, not a prediction problem.
seed();drop('enrichment/films/w9/fingerprint.json');
const outside=(await call('?film=w9')).body.assessment;
assert.equal(outside.cause,'not_in_catalog');
assert.deepEqual(outside.missingPrerequisites,['catalog_membership']);
// Without a catalog object anywhere, absence is not a fact.
drop(CATALOG);
const blind=(await call('?film=w9')).body.assessment;
assert.notEqual(blind.cause,'not_in_catalog');
assert.equal(blind.status,'blocked','a missing catalog is a disagreeing snapshot');

// No queue, an unreadable queue, no profile, a queue of another programme.
seed();drop(QUEUE);
let verdict=(await call('?film=w1')).body.assessment;
assert.equal(verdict.status,'unknown');assert.equal(verdict.cause,'queue_unavailable');
seed();failing.add(QUEUE);
verdict=(await call('?film=w1')).body.assessment;
assert.equal(verdict.cause,'queue_unavailable');
seed();drop(PROFILE);
verdict=(await call('?film=w1')).body.assessment;
assert.equal(verdict.status,'blocked');assert.equal(verdict.cause,'profile_missing');assert.deepEqual(verdict.missingPrerequisites,['taste_profile']);
seed();set(QUEUE,queue({programmeRunId:'run-30'}));
verdict=(await call('?film=w1')).body;
assert.equal(verdict.assessment.cause,'snapshot_partial');
assert.ok(verdict.snapshot.reasons.includes('queue_programme_differs'));
// The film files unreadable: unknown, never a guess.
seed();failing.add(PREDICTIONS);
verdict=(await call('?film=w1')).body.assessment;
assert.equal(verdict.status,'unknown');assert.equal(verdict.cause,'film_unreadable');
// An unreadable lease or run is partial evidence, not a run state.
seed();failing.add(LEASE);failing.add(LATEST);
verdict=(await call('?film=w1')).body;
assert.equal(verdict.assessment.cause,'queued_ready');
assert.deepEqual(verdict.assessment.evidence.missing,['runner_lease','latest_run']);
assert.equal(verdict.snapshot.runnerLease,'unavailable');
// Storage that fails as a whole.
seed();failing.add('*');
const down=await call('?film=w1');
assert.equal(down.status,200);
assert.equal(down.body.assessment.status,'unknown','an unreadable store is unknown, never a verdict');
assert.equal(down.body.assessment.cause,'film_unreadable');
assert.equal(down.body.snapshot.queue.status,'unavailable');
failing=new Set();
assert.equal((await call('?film=w1&pin='+down.body.pin)).status,409,'a failed read never confirms a later successful one');

assert.deepEqual(writes,[],'no put, delete or head');
assert.equal(lists,0,'no listing');
assert.deepEqual(fetches,[],'no outbound request');
console.log('Admin prediction recovery API: input checks, read set, pin and torn reads, verdicts, canaries, no write passed');
