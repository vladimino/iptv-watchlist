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
 records.set('sync.json',{runId:'programme-1',stage:'complete',updatedAt:'2026-11-16T11:00:00Z',ratingObservedAt:'2026-11-16T11:00:00Z',completedAt:'2026-11-16T11:00:00Z'});
 records.set('epg/discovery-status.json',{stage:'complete',programmeRunId:'programme-1',finishedAt:'2026-11-16T11:00:00Z',error:null});
 records.set('epg/resolver-continuation.json',{stage:'complete',programmeRunId:'programme-1',at:'2026-11-16T11:00:00Z',reason:null});
 records.set('epg/discovery-resolution.json',{});
}
function eligibleQueue(){
 records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:1,coldCount:0,hotPending:['watch-c'],coldPending:[],pending:['watch-c'],priorityCount:1,coldRemaining:0,retries:{},work:{'watch-c':{requiredWork:'prediction_only'}}});
}
function deferredQueue(){
 records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:1,coldCount:0,hotPending:['watch-c'],coldPending:[],pending:['watch-c'],priorityCount:1,coldRemaining:0,retries:{'watch-c':{attempts:1,retryAt:now+3600000,retryable:true,scope:'item',kind:'parse_error'}},work:{'watch-c':{requiredWork:'prediction_only'}}});
}
function unreadQueue(){
 records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:1,coldCount:1,priorityCount:1,coldRemaining:1,pending:['watch-c']});
}
function emptyQueue(){
 records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:0,coldCount:0,hotPending:[],coldPending:[],pending:[],priorityCount:0,coldRemaining:0,retries:{}});
}
function diagKey(runId,at){return 'enrichment/run-diagnostics/'+String(9999999999999-Date.parse(at)).padStart(13,'0')+'-'+runId+'.json';}
function clearRuns(){
 records.delete('enrichment/latest-run.json');
 for(const key of [...records.keys()].filter(key=>key.startsWith('enrichment/run-diagnostics/')))records.delete(key);
}
function putRun({runId,status,reason,startedAt,endedAt,added,updated=0,failed=0,latest=false}){
 const results={};for(let i=0;i<added;i++)results['film-'+runId+'-a'+i]='created';
 for(let i=0;i<updated;i++)results['film-'+runId+'-u'+i]='recalculated';
 const failures={};for(let i=0;i<failed;i++)failures['fail-'+i]={kind:'parse_error'};
 const row={runId,status,trigger:'scheduled',createdAt:startedAt,completedAt:endedAt,stopReason:reason,reason,selectedIds:Object.keys(results),results,failures,selectionKind:{},batchCount:1};
 if(latest)records.set('enrichment/latest-run.json',row);
 records.set(diagKey(runId,startedAt),{runId,trigger:'scheduled',startedAt,endedAt,state:status==='complete'?'completed':status==='partial'?'blocked':status,stopReason:reason,added,updated,failed});
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
// AIR-596 (ADR 0210): three runs abandoned without a film 20 minutes after the last progress are the proven orphan chain, worded like the Monitor's verdict.
const thrice=await footer();
assert.equal(sourceOf(thrice,'predictions').code,'prediction_no_recent_progress');
// The productive time_budget run has no firstSubmitAt in this fixture: it is dated by its start (a lower bound), never by its end.
assert.equal(sourceOf(thrice,'predictions').lastSuccessAt,'2026-11-16T12:34:00.000Z');
records.delete(diagKey('run-1404','2026-11-16T13:04:00Z'));
const twice=await footer();
assert.equal(sourceOf(twice,'predictions').code,'prediction_runs_interrupted');
assert.notEqual(sourceOf(twice,'predictions').code,'prediction_blocked');
assert.equal(twice.integrations.aggregate,'attention');
assert.equal(twice.lastRun.status,'blocked');

clearRuns();
putRun({runId:'run-old',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T06:00:00Z',endedAt:'2026-11-16T06:10:00Z',added:5});
putRun({runId:'run-late',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:04:00Z',endedAt:'2026-11-16T13:04:00Z',added:0,latest:true});
eligibleQueue();
const stall=await footer();
assert.equal(sourceOf(stall,'predictions').code,'prediction_no_recent_progress');
assert.notEqual(sourceOf(stall,'predictions').code,'prediction_blocked');
assert.equal(stall.integrations.aggregate,'attention');

clearRuns();
eligibleQueue();
putRun({runId:'run-ok',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T11:10:00Z',endedAt:'2026-11-16T11:18:00Z',added:4});
putRun({runId:'run-quota-unresolved',status:'partial',reason:'quota',startedAt:'2026-11-16T12:00:00Z',endedAt:'2026-11-16T12:01:00Z',added:0});
putRun({runId:'run-after-quota',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:04:00Z',endedAt:'2026-11-16T13:04:00Z',added:0,latest:true});
const quotaThenKill=await footer();
assert.equal(sourceOf(quotaThenKill,'predictions').code,'prediction_blocked','an unresolved quota survives a later unsuccessful interrupt');
assert.equal(sourceOf(quotaThenKill,'predictions').state,'degraded');
assert.equal(quotaThenKill.lastRun.reason,'external_termination');
assert.equal(quotaThenKill.integrations.aggregate,'attention');

clearRuns();
eligibleQueue();
putRun({runId:'run-ok2',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T11:10:00Z',endedAt:'2026-11-16T11:18:00Z',added:4});
putRun({runId:'run-quota-then',status:'partial',reason:'quota',startedAt:'2026-11-16T12:00:00Z',endedAt:'2026-11-16T12:01:00Z',added:0});
putRun({runId:'run-recovered',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T12:40:00Z',endedAt:'2026-11-16T12:50:00Z',added:2,latest:true});
const recovered=await footer();
assert.equal(sourceOf(recovered,'predictions').code,'ok','later added work clears a hard stop');
assert.equal(sourceOf(recovered,'predictions').state,'healthy');
assert.equal(recovered.integrations.aggregate,'healthy');

clearRuns();
eligibleQueue();
putRun({runId:'run-fail1',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T12:00:00Z',endedAt:'2026-11-16T12:10:00Z',added:0,failed:3});
putRun({runId:'run-fail2',status:'complete',reason:'manifest_spent',startedAt:'2026-11-16T12:20:00Z',endedAt:'2026-11-16T12:30:00Z',added:0,failed:2});
putRun({runId:'run-fail-kill',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:04:00Z',endedAt:'2026-11-16T13:04:00Z',added:0,latest:true});
const failedOnly=await footer();
assert.notEqual(sourceOf(failedOnly,'predictions').state,'healthy','failed-only completes with writer stopReasons are not recovery');
assert.notEqual(sourceOf(failedOnly,'predictions').code,'ok');
assert.equal(sourceOf(failedOnly,'predictions').code,'prediction_no_recent_progress');

clearRuns();
eligibleQueue();
putRun({runId:'run-before-quota',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T11:10:00Z',endedAt:'2026-11-16T11:18:00Z',added:4});
putRun({runId:'run-quota-mid',status:'partial',reason:'quota',startedAt:'2026-11-16T12:00:00Z',endedAt:'2026-11-16T12:01:00Z',added:0});
putRun({runId:'run-failed-complete',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T12:20:00Z',endedAt:'2026-11-16T12:30:00Z',added:0,failed:4});
putRun({runId:'run-after-failed-complete',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:04:00Z',endedAt:'2026-11-16T13:04:00Z',added:0,latest:true});
const quotaFailedComplete=await footer();
assert.equal(sourceOf(quotaFailedComplete,'predictions').code,'prediction_blocked','a failed-only eligible_queue_empty complete does not clear quota');
assert.equal(quotaFailedComplete.lastRun.reason,'external_termination');

clearRuns();
eligibleQueue();
putRun({runId:'run-drained',status:'complete',reason:'queue_empty',startedAt:'2026-11-16T12:40:00Z',endedAt:'2026-11-16T12:50:00Z',added:0,failed:0,latest:true});
emptyQueue();
const drained=await footer();
assert.equal(sourceOf(drained,'predictions').state,'healthy','a drained complete with no added films is still progress');
assert.equal(sourceOf(drained,'predictions').code,'ok');

clearRuns();
eligibleQueue();
putRun({runId:'run-ancient',status:'partial',reason:'external_termination',startedAt:'2026-11-16T05:00:00Z',endedAt:'2026-11-16T05:01:00Z',added:0,latest:true});
const noPrior=await footer();
assert.equal(sourceOf(noPrior,'predictions').code,'prediction_no_recent_progress','an old attempt with no prior success and eligible work is a stall, not unknown forever');
assert.equal(sourceOf(noPrior,'predictions').state,'degraded');

clearRuns();
eligibleQueue();
putRun({runId:'run-first-kill',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:04:00Z',endedAt:'2026-11-16T13:04:00Z',added:0,latest:true});
const firstRecent=await footer();
assert.equal(sourceOf(firstRecent,'predictions').code,'no_data','a single recent interrupt without prior progress is unknown, not blocked');
assert.notEqual(sourceOf(firstRecent,'predictions').code,'prediction_blocked');

clearRuns();
deferredQueue();
putRun({runId:'run-ok3',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T12:12:00Z',endedAt:'2026-11-16T12:20:00Z',added:3});
putRun({runId:'run-deferred-kill',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:04:00Z',endedAt:'2026-11-16T13:04:00Z',added:0,latest:true});
const deferred=await footer();
assert.equal(sourceOf(deferred,'predictions').state,'healthy','a deferred-only queue is not eligible-now stall');
assert.notEqual(sourceOf(deferred,'predictions').code,'prediction_runs_interrupted');

clearRuns();
unreadQueue();
putRun({runId:'run-ok4',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T12:12:00Z',endedAt:'2026-11-16T12:20:00Z',added:3});
putRun({runId:'run-unread-kill',status:'partial',reason:'external_termination',startedAt:'2026-11-16T13:04:00Z',endedAt:'2026-11-16T13:04:00Z',added:0,latest:true});
const unread=await footer();
// AIR-596 review (ADR 0182 decision 4): an unreadable split neither invents eligible work (no outage) nor is healthy: it is unknown, with the last success kept.
assert.deepEqual([sourceOf(unread,'predictions').state,sourceOf(unread,'predictions').code,sourceOf(unread,'predictions').lastSuccessAt],['unknown','no_data','2026-11-16T12:20:00.000Z'],'an unreadable queue does not invent eligible work and is not healthy');
assert.notEqual(sourceOf(unread,'predictions').code,'prediction_blocked');

clearRuns();
eligibleQueue();
putRun({runId:'run-ok5',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T12:12:00Z',endedAt:'2026-11-16T12:20:00Z',added:3});
putRun({runId:'run-busy',status:'partial',reason:'already_running',startedAt:'2026-11-16T13:04:00Z',endedAt:'2026-11-16T13:04:00Z',added:0,latest:true});
const overlap=await footer();
assert.equal(sourceOf(overlap,'predictions').state,'healthy','already_running after recent progress is not a hard stop');
assert.notEqual(sourceOf(overlap,'predictions').code,'prediction_blocked');

// AIR-556. The 20 Nov 2026 incident: the last productive batch was at 04:54 and nothing started since; 3740 films are eligible. The Footer must not say "works".
const bigQueue=count=>{const ids=Array.from({length:count},(_,index)=>'q'+index);records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:count,coldCount:0,hotPending:ids,coldPending:[],pending:ids,priorityCount:count,coldRemaining:0,retries:{},work:{}});};
const setNow=value=>{now=Date.parse(value);};
{
 const savedNow=now;
 clearRuns();bigQueue(3740);
 putRun({runId:'run-0454',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T04:46:00Z',endedAt:'2026-11-16T04:54:00Z',added:5,latest:true});
 setNow('2026-11-16T09:46:00Z');
 const incident=await footer();
 const entry=sourceOf(incident,'predictions');
 assert.equal(entry.state,'degraded','4 h 52 min without a productive batch is not healthy');
 assert.equal(entry.code,'prediction_no_recent_progress');
 assert.equal(entry.lastSuccessAt,'2026-11-16T04:54:00.000Z','the last success is shown as history, not as current health');
 assert.equal(incident.integrations.aggregate,'attention','the automation aggregate is not healthy');
 assert.notEqual(entry.code,'ok');
 assert.ok(!/api_error|auth|missed/i.test(JSON.stringify(entry)),'the Worker claims nothing about why');
 // The limit is 60 minutes: 59 minutes after progress is healthy, 61 is not (a Task start is at most about 29 minutes apart, so four slots can miss).
 setNow('2026-11-16T05:53:00Z');assert.equal(sourceOf(await footer(),'predictions').state,'healthy','59 minutes after progress');
 setNow('2026-11-16T05:55:00Z');assert.equal(sourceOf(await footer(),'predictions').state,'degraded','61 minutes after progress');
 // A heartbeat-like noop (`already_running`) newer than the last progress is not progress.
 putRun({runId:'run-busy-0900',status:'partial',reason:'already_running',startedAt:'2026-11-16T09:40:00Z',endedAt:'2026-11-16T09:40:00Z',added:0,latest:true});
 setNow('2026-11-16T09:46:00Z');assert.equal(sourceOf(await footer(),'predictions').state,'degraded','an already_running start is not new progress');
 // Nothing eligible (drained) or everything deferred by its own retry time is not a stall, whatever the age of the last batch.
 emptyQueue();assert.equal(sourceOf(await footer(),'predictions').state,'healthy','drained queue');
 records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:1,coldCount:0,hotPending:['x'],coldPending:[],pending:['x'],priorityCount:1,coldRemaining:0,retries:{x:{attempts:1,retryAt:now+3600000,retryable:true,scope:'item',kind:'parse_error'}},work:{}});
 assert.equal(sourceOf(await footer(),'predictions').state,'healthy','eligibleNow 0 with a future retry');
 // Cold-only work is eligible work too.
 const ids=Array.from({length:50},(_,index)=>'c'+index);records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:0,coldCount:50,hotPending:[],coldPending:ids,pending:ids,priorityCount:0,coldRemaining:50,retries:{},work:{}});
 assert.equal(sourceOf(await footer(),'predictions').state,'degraded','cold-only eligible work with no progress');
 // Recovery: a productive batch clears it at once.
 putRun({runId:'run-0946',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T09:40:00Z',endedAt:'2026-11-16T09:45:00Z',added:4,latest:true});
 assert.equal(sourceOf(await footer(),'predictions').state,'healthy','delay, failure and recovery');
 now=savedNow;
}

// AIR-556: a live run younger than the 60-minute limit is running only while nothing is proven; an older live lease is not evidence of progress.
// AIR-596 (ADR 0210): five hours after the last progress a young live run no longer hides the silence.
{
 const savedNow=now;
 clearRuns();bigQueue(200);
 putRun({runId:'run-before',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T04:46:00Z',endedAt:'2026-11-16T04:54:00Z',added:5});
 const live=(startedAt)=>{records.set('enrichment/latest-run.json',{runId:'run-live',status:'running',createdAt:startedAt,trigger:'scheduled',selectedIds:[],results:{},failures:{}});records.set('enrichment/runner-lease.json',{runId:'run-live',expiresAt:now+10*60000,heartbeatAt:new Date(now).toISOString()});};
 setNow('2026-11-16T09:46:00Z');
 live('2026-11-16T09:30:00Z');
 {const source=sourceOf(await footer(),'predictions');assert.equal(source.state,'degraded','a 16-minute live run does not hide five hours without progress');assert.equal(source.code,'prediction_no_recent_progress');assert.equal(source.lastSuccessAt,'2026-11-16T04:54:00.000Z','the last confirmed success stays visible');}
 putRun({runId:'run-recent',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T09:12:00Z',endedAt:'2026-11-16T09:20:00Z',added:2});
 assert.equal(sourceOf(await footer(),'predictions').state,'running','a 16-minute live run 26 minutes after progress is running');
 records.delete(diagKey('run-recent','2026-11-16T09:12:00Z'));
 live('2026-11-16T08:00:00Z');
 assert.equal(sourceOf(await footer(),'predictions').state,'degraded','a lease held for 106 minutes without a finished batch does not hide the missing progress');
 records.delete('enrichment/runner-lease.json');
 now=savedNow;
}

// AIR-556 review counterexamples (PR 810).
{
 const savedNow=now;
 // 1. A completed batch that only settled `already_current` films (manifest_spent) or a retry_backoff noop is not progress while the backlog stays eligible.
 for(const reason of ['manifest_spent','retry_backoff']){
  clearRuns();bigQueue(3740);
  putRun({runId:'run-real',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T04:46:00Z',endedAt:'2026-11-16T04:54:00Z',added:5});
  putRun({runId:'run-'+reason,status:'complete',reason,startedAt:'2026-11-16T09:30:00Z',endedAt:'2026-11-16T09:40:00Z',added:0,updated:0,failed:0,latest:true});
  setNow('2026-11-16T09:46:00Z');
  const entry=sourceOf(await footer(),'predictions');
  assert.equal(entry.state,'degraded',reason+' with zero created or recalculated films is not progress');
  assert.equal(entry.lastSuccessAt,'2026-11-16T04:54:00.000Z');
 }
 // A global drained completion (queue_empty) still proves an empty queue at that time, and a genuine batch is still progress.
 clearRuns();bigQueue(50);
 putRun({runId:'run-drained',status:'complete',reason:'queue_empty',startedAt:'2026-11-16T09:30:00Z',endedAt:'2026-11-16T09:40:00Z',added:0,latest:true});
 setNow('2026-11-16T09:46:00Z');assert.equal(sourceOf(await footer(),'predictions').state,'healthy','queue_empty is a verified global drain');
 // 2. Recalculated work survives the checkpoint/latest-run merge: a checkpoint written without `updated` plus a latest run with four recalculations and one failure.
 clearRuns();bigQueue(3740);
 putRun({runId:'run-recalc',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T09:30:00Z',endedAt:'2026-11-16T09:40:00Z',added:0,updated:4,failed:1,latest:true});
 const checkpoint=records.get(diagKey('run-recalc','2026-11-16T09:30:00Z'));delete checkpoint.updated;
 setNow('2026-11-16T09:46:00Z');
 const recalculated=sourceOf(await footer(),'predictions');
 assert.notEqual(recalculated.code,'prediction_no_recent_progress','four recalculated films are progress even though the checkpoint has no `updated`');
 assert.equal(recalculated.state,'healthy','one failed item beside four saved predictions is not a pipeline problem');
 assert.equal(recalculated.lastSuccessAt,'2026-11-16T09:40:00.000Z');
 // Mixed: recalculated plus failed, and a failed-only run is still not progress.
 clearRuns();bigQueue(3740);
 putRun({runId:'run-failed-only',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T09:30:00Z',endedAt:'2026-11-16T09:40:00Z',added:0,updated:0,failed:3,latest:true});
 assert.notEqual(sourceOf(await footer(),'predictions').state,'healthy','failed-only is not progress');
 // 3. A live lease whose run has no provable start never hides a long silence.
 clearRuns();bigQueue(3740);
 putRun({runId:'run-before',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T04:46:00Z',endedAt:'2026-11-16T04:54:00Z',added:5});
 records.set('enrichment/latest-run.json',{runId:'run-live',status:'running',trigger:'scheduled',selectedIds:[],results:{},failures:{}});
 records.set('enrichment/runner-lease.json',{runId:'run-live',expiresAt:now+10*60000,heartbeatAt:new Date(now).toISOString()});
 assert.equal(sourceOf(await footer(),'predictions').state,'degraded','a live lease without a start time is not "running"');
 records.delete('enrichment/runner-lease.json');
 now=savedNow;
}

// AIR-556 (owner follow-up): per-film failures are classified apart from pipeline health.
{
 const savedNow=now;
 const entryOf=async()=>sourceOf(await footer(),'predictions');
 // Mixed success: 4 saved, 1 failed, progress fresh: normal health, aggregate healthy, the item failure stays in lastRun.
 clearRuns();bigQueue(500);
 putRun({runId:'run-mixed',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T09:30:00Z',endedAt:'2026-11-16T09:40:00Z',added:4,updated:0,failed:1,latest:true});
 setNow('2026-11-16T09:46:00Z');
 const mixedBody=await footer();
 assert.equal(sourceOf(mixedBody,'predictions').state,'healthy');assert.equal(sourceOf(mixedBody,'predictions').code,'ok');
 assert.equal(mixedBody.integrations.aggregate,'healthy','an expected item failure does not raise the automation aggregate');
 assert.equal(mixedBody.lastRun.added,4);assert.equal(mixedBody.lastRun.failed,1,'the item failure stays visible in the latest-run details');
 // Failed-only with fresh earlier progress: no invented outage, no invented progress (lastSuccessAt stays the earlier batch).
 clearRuns();bigQueue(500);
 putRun({runId:'run-good',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T09:10:00Z',endedAt:'2026-11-16T09:20:00Z',added:3});
 putRun({runId:'run-allfail',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T09:30:00Z',endedAt:'2026-11-16T09:40:00Z',added:0,updated:0,failed:5,latest:true});
 const failedFresh=await entryOf();
 assert.equal(failedFresh.state,'healthy','a failed-only batch does not assert an outage by its failure count');
 assert.equal(failedFresh.lastSuccessAt,'2026-11-16T09:20:00.000Z','and does not become progress');
 // The shared 60-minute rule then decides: 61 minutes after the last progress it is no confirmed progress.
 setNow('2026-11-16T10:22:00Z');
 assert.equal((await entryOf()).code,'prediction_no_recent_progress');
 // Failed-only history with no progress at all: unknown while the evidence is younger than 60 minutes, no confirmed progress after.
 clearRuns();bigQueue(500);
 putRun({runId:'run-onlyfail',status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T09:30:00Z',endedAt:'2026-11-16T09:40:00Z',added:0,updated:0,failed:5,latest:true});
 setNow('2026-11-16T09:46:00Z');
 const young=await entryOf();assert.equal(young.state,'unknown');assert.equal(young.code,'no_data');
 setNow('2026-11-16T10:35:00Z');assert.equal((await entryOf()).code,'prediction_no_recent_progress');
 // Systemic stops keep degrading, whatever else the batch did, and repeated interruptions keep degrading.
 for(const reason of ['api_error','quota','model_unavailable','storage_error','format_error_storm']){
  clearRuns();bigQueue(500);
  putRun({runId:'run-before-'+reason,status:'complete',reason:'eligible_queue_empty',startedAt:'2026-11-16T09:10:00Z',endedAt:'2026-11-16T09:20:00Z',added:3});
  putRun({runId:'run-stop-'+reason,status:'partial',reason,startedAt:'2026-11-16T09:30:00Z',endedAt:'2026-11-16T09:40:00Z',added:0,latest:true});
  setNow('2026-11-16T09:46:00Z');
  const stop=await entryOf();assert.equal(stop.state,'degraded',reason);assert.equal(stop.code,'prediction_blocked',reason);
 }
 clearRuns();bigQueue(500);
 putRun({runId:'run-i1',status:'partial',reason:'external_termination',startedAt:'2026-11-16T09:20:00Z',endedAt:'2026-11-16T09:21:00Z',added:0});
 putRun({runId:'run-i2',status:'partial',reason:'external_termination',startedAt:'2026-11-16T09:30:00Z',endedAt:'2026-11-16T09:31:00Z',added:0,latest:true});
 assert.equal((await entryOf()).code,'prediction_runs_interrupted','repeated interruptions keep their degradation');
 now=savedNow;
}
