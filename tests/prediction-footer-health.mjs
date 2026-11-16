import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),writes=[];
const env={BUCKET:{
 async get(key){return records.has(key)?{etag:'test',json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value){writes.push(key);records.set(key,JSON.parse(value));return {etag:'test'};},
 async list({prefix,limit}={}){const objects=[...records.keys()].filter(key=>!prefix||key.startsWith(prefix)).slice(0,limit||1000).map(key=>({key}));return {objects,truncated:false};}
}};
let now=Date.parse('2026-11-16T13:10:00Z');
class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const context=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date:Clock,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);

const film=(id,tmdbId)=>({id,tmdbId:String(tmdbId),title:id,original:id,year:2020,genres:[],actors:[],directors:[],shows:[{start:now}]});
const current=id=>({fingerprintHash:'fp-'+id,impactFeatures:{fingerprintHash:'fp-'+id,fingerprintSchemaVersion:1,fingerprintPromptVersion:1},prediction:{tasteProfileVersion:7,tasteProfileHash:'profile-7',fingerprintHash:'fp-'+id,fingerprintSchemaVersion:1,predictionPromptVersion:1}});
function seedHealthySources(){
 records.set('enrichment/profile/current.json',{version:7,updatedAt:'2026-11-16T10:00:00Z',profileHash:'profile-7',profile:{}});
 records.set('programme.json',{runId:'programme-1',updatedAt:'2026-11-16T11:00:00Z',watchlistUpdatedAt:'2026-11-16T11:00:00Z',watchlistCount:3,films:[film('watch-a',1),film('watch-b',2),film('watch-c',3)],stats:{epgStart:now-72*3600000,epgEnd:now+24*3600000,channels:2,scanned:10,titleMissing:0,titleProvisional:0,metadataMissing:0}});
 records.set('epg/discovered-films.json',{watch_a:film('watch-a',1),watch_b:film('watch-b',2),watch_c:film('watch-c',3)});
 records.set('enrichment/view-index.json',{'watch-a':current('a'),'watch-b':current('b')});
 records.set('sync.json',{stage:'complete',updatedAt:'2026-11-16T11:00:00Z',ratingObservedAt:'2026-11-16T11:00:00Z',completedAt:'2026-11-16T11:00:00Z'});
 records.set('epg/discovery-status.json',{stage:'complete',programmeRunId:'programme-1',finishedAt:'2026-11-16T11:00:00Z',error:null});
 records.set('epg/resolver-continuation.json',{stage:'complete',programmeRunId:'programme-1',at:'2026-11-16T11:00:00Z',reason:null});
 records.set('epg/discovery-resolution.json',{});
}
function eligibleQueue(){
 records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:1,coldCount:0,hotPending:['watch-c'],coldPending:[],pending:['watch-c'],priorityCount:1,coldRemaining:0,retries:{},work:{'watch-c':{requiredWork:'prediction_only'}}});
}
function diagKey(runId,at){return 'enrichment/run-diagnostics/'+String(9999999999999-Date.parse(at)).padStart(13,'0')+'-'+runId+'.json';}
function putRun({runId,status,reason,startedAt,endedAt,added,failed=0,latest=false}){
 const results={};for(let i=0;i<added;i++)results['film-'+runId+'-'+i]='created';
 const failures={};for(let i=0;i<failed;i++)failures['fail-'+i]={kind:'parse_error'};
 const row={runId,status,trigger:'scheduled',createdAt:startedAt,completedAt:endedAt,stopReason:reason,reason,selectedIds:Object.keys(results),results,failures,selectionKind:{},batchCount:1};
 if(latest)records.set('enrichment/latest-run.json',row);
 records.set(diagKey(runId,startedAt),{runId,trigger:'scheduled',startedAt,endedAt,state:status==='complete'?'completed':status==='partial'?'blocked':status,stopReason:reason,added,failed});
}
const sourceOf=(body,id)=>body.integrations.sources.find(item=>item.id===id);
const footer=async()=>{const response=await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env);assert.equal(response.status,200);return response.json();};

seedHealthySources();
eligibleQueue();
putRun({runId:'run-1210',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T11:10:00Z',endedAt:'2026-11-16T11:18:00Z',added:4});
putRun({runId:'run-1312',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T12:12:00Z',endedAt:'2026-11-16T12:20:00Z',added:3});
putRun({runId:'run-1334',status:'partial',reason:'time_budget',startedAt:'2026-11-16T12:34:00Z',endedAt:'2026-11-16T12:50:00Z',added:2});
putRun({runId:'run-1404',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:04:00Z',endedAt:'2026-11-16T13:04:00Z',added:0,latest:true});
const writesBefore=writes.length;
const production=await footer();
assert.equal(production.lastRun.status,'blocked');
assert.equal(production.lastRun.reason,'external_termination');
assert.equal(production.lastRun.added,0);
assert.equal(sourceOf(production,'predictions').state,'healthy');
assert.equal(sourceOf(production,'predictions').code,'ok');
assert.notEqual(sourceOf(production,'predictions').code,'prediction_blocked');
assert.equal(production.integrations.aggregate,'healthy');
assert.equal(production.integrations.attentionCount,0);
assert.equal(writes.length,writesBefore,'capability classification stays read-only');

putRun({runId:'run-quota',status:'partial',reason:'quota',startedAt:'2026-11-16T13:08:00Z',endedAt:'2026-11-16T13:08:00Z',added:0,latest:true});
const quota=await footer();
assert.equal(quota.lastRun.status,'blocked');
assert.equal(quota.lastRun.reason,'quota');
assert.equal(sourceOf(quota,'predictions').code,'prediction_blocked');
assert.equal(sourceOf(quota,'predictions').state,'degraded');
assert.equal(quota.integrations.aggregate,'attention');

records.delete(diagKey('run-quota','2026-11-16T13:08:00Z'));
putRun({runId:'run-1404b',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:02:00Z',endedAt:'2026-11-16T13:02:00Z',added:0});
putRun({runId:'run-1404c',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:06:00Z',endedAt:'2026-11-16T13:06:00Z',added:0,latest:true});
const twice=await footer();
assert.equal(sourceOf(twice,'predictions').code,'prediction_runs_interrupted');
assert.notEqual(sourceOf(twice,'predictions').code,'prediction_blocked');
assert.equal(twice.integrations.aggregate,'attention');
assert.equal(twice.lastRun.status,'blocked');

for(const key of [...records.keys()].filter(key=>key.startsWith('enrichment/run-diagnostics/')))records.delete(key);
putRun({runId:'run-old',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T06:00:00Z',endedAt:'2026-11-16T06:10:00Z',added:5});
putRun({runId:'run-late',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:04:00Z',endedAt:'2026-11-16T13:04:00Z',added:0,latest:true});
const stall=await footer();
assert.equal(sourceOf(stall,'predictions').code,'prediction_no_recent_progress');
assert.notEqual(sourceOf(stall,'predictions').code,'prediction_blocked');
assert.equal(stall.integrations.aggregate,'attention');
