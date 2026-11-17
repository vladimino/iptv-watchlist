// Run diagnostics of batch runner v2 runs (ADR 0162; D1 prediction authority, as production runs it): a failed step, a caller-reported fault, an unattributed
// api_error, a clean completion, a duplicate complete, a lease loss, item validation stages and a dropped finish write. Nothing secret, no model output and no
// film id reaches a diagnostic row. Local stand-ins only.
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

let w,failRunSave=false,failProducedHeartbeat=false;
async function boot(films){
 w=await flowWorld({films});failRunSave=false;failProducedHeartbeat=false;
 const bucket=w.env.BUCKET,put=bucket.put;
 bucket.list=async({prefix='',limit=1000}={})=>({objects:[...w.records.keys()].filter(key=>key.startsWith(prefix)).sort().slice(0,limit).map(key=>({key})),truncated:false});
 bucket.put=async(key,value,options)=>{if(failProducedHeartbeat&&key.startsWith('enrichment/run-diagnostics/')){const parsed=JSON.parse(value);if(parsed.steps?.some(step=>step.step==='heartbeat'&&step.outcome==='produced'))throw new Error('finish write dropped');}return put.call(bucket,key,value,options);};
 // One run-record write that fails: the way a storage failure inside a step is simulated.
 const original=w.ctx.PredictionD1;w.ctx.PredictionD1={...original,saveMutable:async(...a)=>{if(failRunSave&&/^enrichment\/runs\//.test(a[1])){failRunSave=false;throw new Error('Storage checkpoint interrupted');}return original.saveMutable(...a);}};
 assert.equal((await w.api('queue/reconcile',{})).status,200);
}
async function api(path,body,method='POST',headers={}){const response=await w.ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),w.env);return {status:response.status,requestId:response.headers.get('X-Request-Id'),data:await response.json()};}
const startRun=async(extra={})=>{const r=await api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...extra});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.status,'running');return r;};
const runStatus=id=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+id+"'")[0].d).status;
const diagnostic=runId=>[...w.records.values()].find(value=>value?.runId===runId&&Array.isArray(value.steps));
const events=()=>[...w.records.keys()].filter(key=>key.startsWith('events/items/'));
const secret=/Bearer|token|prompt|stack|MODEL-OUTPUT-CANARY|tmdb_/i;
const canary=()=>({...w.prediction,mainRisk:'MODEL-OUTPUT-CANARY'});

// A step whose storage write fails: 502 storage_error, observed by the server, delivery unconfirmed.
await boot(2);
let start=await startRun();assert.equal(start.data.delivery,'unconfirmed');assert.equal(start.requestId,start.data.requestId);
failRunSave=true;
let beat=await api('heartbeat',{runId:start.data.runId});
assert.equal(beat.status,502);assert.equal(beat.data.error,'storage_error');assert.equal(beat.data.delivery,'unconfirmed');assert.equal(beat.requestId,beat.data.requestId);
let row=diagnostic(start.data.runId);
assert.equal(row.lastAttemptedStep,'heartbeat');assert.equal(row.lastCompletedStep,'start');assert.equal(row.serverFault.origin,'worker');assert.equal(row.serverFault.httpStatus,502);assert.equal(row.serverFault.errorClass,'storage_error');
const failed=row.steps.find(step=>step.step==='heartbeat');assert.equal(failed.outcome,'failed');assert.equal(failed.observedBy,'server');assert.equal(failed.delivery,'unconfirmed');assert.equal(failed.completedAt,null);assert.equal(row.callerFault,null);
assert.doesNotMatch(JSON.stringify(row),secret);

// A caller-reported fault: the request id is echoed or replaced, the fault is stored as the caller's claim, and a repeated complete keeps the first.
await boot(1);
start=await startRun();
beat=await api('heartbeat',{runId:start.data.runId},'POST',{'X-Request-Id':'client-step-1'});
assert.equal(beat.status,200);assert.equal(beat.requestId,'client-step-1');assert.equal(beat.data.requestId,'client-step-1');assert.equal(beat.data.delivery,'unconfirmed');
const echoed=await api('heartbeat',{runId:start.data.runId},'POST',{'X-Request-Id':'not valid'});
assert.match(echoed.requestId,/^[A-Za-z0-9_-]{1,80}$/);assert.notEqual(echoed.requestId,'not valid');
const beforeExternal=events().length;
let done=await api('complete',{runId:start.data.runId,reason:'api_error',fault:{origin:'model_provider',failedStep:'heartbeat',providerErrorCode:'provider_timeout',httpStatus:503,receivedRequestId:'client-step-1'}});
assert.equal(done.status,200);assert.equal(done.data.stopReason,'api_error');assert.equal(done.data.delivery,'unconfirmed');
row=diagnostic(start.data.runId);
assert.equal(row.stopReason,'api_error');assert.equal(row.callerFault.reportedBy,'caller');assert.equal(row.callerFault.attribution,'caller_reported');assert.equal(row.callerFault.origin,'model_provider');assert.equal(row.callerFault.failedStep,'heartbeat');assert.equal(row.callerFault.providerErrorCode,'provider_timeout');assert.equal(row.callerFault.httpStatus,503);assert.equal(row.serverFault,null);
assert.equal(row.steps.find(step=>step.step==='heartbeat'&&step.requestId==='client-step-1').delivery,'unconfirmed');
const status=await api('status',undefined,'GET');
assert.equal(status.data.diagnostics.attribution,'caller_reported');assert.equal(status.data.diagnostics.steps.find(step=>step.requestId==='client-step-1').callerAcknowledged,true);assert.equal(status.data.diagnostics.delivery,'unconfirmed');
const listed=(await api('runs?limit=10',undefined,'GET')).data.runs.find(item=>item.runId===start.data.runId);
assert.equal(listed.steps.find(step=>step.requestId==='client-step-1').callerAcknowledged,true);
const again=await api('complete',{runId:start.data.runId,reason:'api_error',fault:{origin:'transport',failedStep:'complete',providerErrorCode:'dropped',httpStatus:504,receivedRequestId:'other-client'}});
assert.equal(again.data.status,'partial');assert.equal(diagnostic(start.data.runId).callerFault.origin,'model_provider');assert.equal(events().length,beforeExternal+1);
assert.doesNotMatch(JSON.stringify(diagnostic(start.data.runId)),secret);assert.doesNotMatch(JSON.stringify(events().map(key=>w.records.get(key))),/provider_timeout|Bearer|token|prompt|stack/i);

// An api_error without a fault is external and unattributed, never the Worker's.
await boot(1);
start=await startRun();
done=await api('complete',{runId:start.data.runId,reason:'api_error'});
row=diagnostic(start.data.runId);
assert.equal(row.stopReason,'api_error');assert.equal(row.callerFault.attribution,'external_unattributed');assert.equal(row.callerFault.origin,'unknown');assert.equal(row.callerFault.reportedBy,null);assert.equal(row.callerFault.errorClass,'unknown');assert.equal(row.serverFault,null);assert.notEqual(row.callerFault.origin,'worker');

// An invalid fault is refused whole; the run keeps running.
await boot(1);
start=await startRun();
const rejected=await api('complete',{runId:start.data.runId,reason:'api_error',fault:{origin:'model_provider',providerErrorCode:'Bearer secret',httpStatus:503}});
assert.equal(rejected.status,400);assert.equal(runStatus(start.data.runId),'running');assert.equal(diagnostic(start.data.runId).callerFault,null);assert.equal(diagnostic(start.data.runId).stopReason,null);
assert.doesNotMatch(JSON.stringify(diagnostic(start.data.runId)),/Bearer|secret|stack/i);

// A clean completion: no fault, no failed step, no film id; a duplicate complete with a late fault changes nothing.
await boot(1);
start=await startRun();
const filmId=start.data.films[0].filmId;
const submitted=await api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[{filmId,fingerprint:w.fingerprint,prediction:canary()}]});
assert.equal(submitted.data.results[0].status,'created');
done=await api('complete',{runId:start.data.runId});
assert.equal(done.data.status,'complete');assert.equal(done.data.stopReason,'queue_empty');
row=diagnostic(start.data.runId);
assert.equal(row.callerFault,null);assert.equal(row.serverFault,null);assert.equal(row.lastAttemptedStep,'complete');assert.equal(row.lastCompletedStep,'complete');
assert.equal(row.steps.some(step=>step.outcome==='failed'||step.errorClass),false);
assert.doesNotMatch(JSON.stringify(row),secret);assert.equal(JSON.stringify(row).includes(filmId),false);
const duplicate=await api('complete',{runId:start.data.runId,fault:{origin:'orchestrator',failedStep:'complete',providerErrorCode:'late',httpStatus:500}});
assert.equal(duplicate.data.status,'complete');assert.equal(diagnostic(start.data.runId).callerFault,null);

// A fault on a normal completion is rejected and writes nothing.
await boot(1);
start=await startRun();
beat=await api('heartbeat',{runId:start.data.runId},'POST',{'X-Request-Id':'client-step-clean'});
await api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[{filmId:start.data.films[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});
const beforeClean=events().length;
const falseFault=await api('complete',{runId:start.data.runId,fault:{origin:'model_provider',failedStep:'heartbeat',providerErrorCode:'provider_timeout',httpStatus:503,receivedRequestId:'client-step-clean'}});
assert.equal(falseFault.status,400);assert.equal(runStatus(start.data.runId),'running');assert.equal(diagnostic(start.data.runId).callerFault,null);assert.equal(diagnostic(start.data.runId).stopReason,null);assert.equal(events().length,beforeClean);
const falseQueue=await api('complete',{runId:start.data.runId,reason:'queue_empty',fault:{origin:'model_provider',failedStep:'complete',providerErrorCode:'provider_timeout',httpStatus:503,receivedRequestId:'client-step-clean'}});
assert.equal(falseQueue.status,400);assert.equal(runStatus(start.data.runId),'running');assert.equal(diagnostic(start.data.runId).callerFault,null);assert.equal(events().length,beforeClean);
done=await api('complete',{runId:start.data.runId});
assert.equal(done.data.status,'complete');assert.equal(done.data.stopReason,'queue_empty');
const cleanStatus=await api('status',undefined,'GET');
assert.equal(cleanStatus.data.diagnostics.callerFault,null);assert.equal(cleanStatus.data.diagnostics.attribution,null);assert.equal(cleanStatus.data.diagnostics.steps.every(step=>step.callerAcknowledged===false),true);

// A receivedRequestId that names no issued step acknowledges nothing.
await boot(1);
start=await startRun();
await api('heartbeat',{runId:start.data.runId},'POST',{'X-Request-Id':'client-step-real'});
done=await api('complete',{runId:start.data.runId,reason:'api_error',fault:{origin:'transport',failedStep:'heartbeat',providerErrorCode:'dropped',httpStatus:504,receivedRequestId:'never-issued'}});
assert.equal(done.data.stopReason,'api_error');
row=diagnostic(start.data.runId);
assert.equal(row.callerFault.attribution,'caller_reported');assert.equal(row.callerFault.receivedRequestId,'never-issued');
assert.equal(row.steps.every(step=>step.delivery==='unconfirmed'),true);
const unknownStatus=await api('status',undefined,'GET');
assert.equal(unknownStatus.data.diagnostics.delivery,'unconfirmed');
assert.equal(unknownStatus.data.diagnostics.steps.every(step=>step.callerAcknowledged===false),true);
assert.equal(unknownStatus.data.diagnostics.steps.some(step=>step.requestId==='client-step-real'),true);

// A lost lease: 409 lease_lost, the other owner's lease untouched, a server-observed lease_lost fault.
await boot(1);
start=await startRun();
{const doc=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);doc.runId='another-owner';sql(w.file,"UPDATE prediction_lease SET document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");}
beat=await api('heartbeat',{runId:start.data.runId});
assert.equal(beat.status,409);assert.equal(beat.data.status,'lease_lost');assert.equal(JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d).runId,'another-owner');
row=diagnostic(start.data.runId);
assert.equal(row.serverFault.origin,'worker');assert.equal(row.serverFault.errorClass,'lease_lost');assert.equal(row.steps.find(step=>step.step==='heartbeat').outcome,'produced');assert.equal(row.steps.find(step=>step.step==='heartbeat').httpStatus,409);assert.equal(row.steps.find(step=>step.step==='heartbeat').delivery,'unconfirmed');

// Item validation stages of one batch submit: the stages name who reported each failure and no film id. A caller-reported failure with a reason does not count
// toward the format storm (AIR-487), so the three Worker-detected failures make the streak.
await boot(5);
start=await startRun();
const ids=start.data.films.map(film=>film.filmId);assert.equal(ids.length,5);
const storm=await api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[
 {filmId:ids[0],failure:{kind:'parse_error',reason:'json_unparseable'}},
 {filmId:ids[1],fingerprint:{},prediction:w.prediction},
 {filmId:ids[2],prediction:w.prediction},
 {filmId:ids[3],fingerprint:w.fingerprint,prediction:{...canary(),predictedRating:'nope'}},
 {filmId:ids[4],failure:{kind:'parse_error',reason:'json_unparseable'}}]});
assert.equal(storm.status,200,JSON.stringify(storm.data).slice(0,300));
const stopped=await api('complete',{runId:start.data.runId,reason:'api_error'});assert.equal(stopped.status,200);
const stored=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+start.data.runId+"'")[0].d);
assert.equal(stored.itemValidation.consecutive,3);
assert.deepEqual(stored.itemValidation.stages.map(stage=>stage.stage),['caller_reported','fingerprint_schema','fingerprint_missing','prediction_schema','caller_reported']);
assert.deepEqual(stored.itemValidation.stages.map(stage=>stage.reportedBy),['caller','worker','worker','worker','caller']);
row=diagnostic(start.data.runId);
assert.equal(row.itemValidation.consecutive,3);
const stages=JSON.stringify(row.itemValidation);for(const id of ids)assert.equal(stages.includes(id),false);assert.doesNotMatch(stages,/MODEL-OUTPUT-CANARY|Bearer|stack|title/i);

// A dropped finish write: the step answers normally and stays recorded as entered.
await boot(1);
start=await startRun();
failProducedHeartbeat=true;
beat=await api('heartbeat',{runId:start.data.runId});
assert.equal(beat.status,200);assert.equal(beat.data.delivery,'unconfirmed');
assert.equal(diagnostic(start.data.runId).steps.find(step=>step.step==='heartbeat').outcome,'entered');

console.log('Run diagnostics (batch v2): failed step, caller fault, unattributed api_error, clean completion, duplicate complete, lease loss, validation stages and a dropped finish write passed');
