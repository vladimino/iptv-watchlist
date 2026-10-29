import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,failKey='',failProducedNext=false;
const env={BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;if(key===failKey){failKey='';throw new Error('Storage checkpoint interrupted')}if(failProducedNext&&key.startsWith('enrichment/run-diagnostics/')){const parsed=JSON.parse(value);if(parsed.steps?.some(step=>step.step==='next'&&step.outcome==='produced'))throw new Error('finish diagnostic failed');}records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)}},list:async({prefix=''})=>({objects:[...records.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false})}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
ctx.env=env;const call=code=>vm.runInContext(code,ctx);
async function api(path,body,method='POST',headers={}){const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,requestId:response.headers.get('X-Request-Id'),data:await response.json()};}
const film=(id,start)=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,'')||id,genres:[],actors:[],directors:[],shows:[{start}]});
const execution=Object.fromEntries(Object.entries(call('EXECUTION')).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']},prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'MODEL-OUTPUT-CANARY',moodLabels:['мрачный','напряжённый']};
function boot(ids){records.clear();etags.clear();revision=0;failKey='';failProducedNext=false;records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});records.set('sync.json',{runId:'test',stage:'complete'});const catalog={};for(const id of ids)catalog[id]=film(id,Date.now());records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',catalog);}
const diagnostic=runId=>[...records.values()].find(value=>value?.runId===runId&&Array.isArray(value.steps));
const events=()=>[...records.keys()].filter(key=>key.startsWith('events/items/')&&!key.includes('prediction-start-'));
const secret=/Bearer|token|prompt|stack|MODEL-OUTPUT-CANARY|tmdb_88/i;

boot(['tmdb_8801','tmdb_8802']);
let start=await api('start',{scope:'watchlist_all',mode:'queued'});assert.equal(start.status,200);assert.equal(start.data.status,'running');assert.equal(start.data.delivery,'unconfirmed');assert.equal(start.requestId,start.data.requestId);
failKey='enrichment/prediction-queue.json';
let next=await api('next',{runId:start.data.runId});
assert.equal(next.status,502);assert.equal(next.data.error,'storage_error');assert.equal(next.data.delivery,'unconfirmed');assert.equal(next.requestId,next.data.requestId);
let run=records.get('enrichment/runs/'+start.data.runId+'.json');assert.ok(run.firstNextAt);
let row=diagnostic(start.data.runId);
assert.equal(row.lastAttemptedStep,'next');assert.equal(row.lastCompletedStep,'start');assert.equal(row.serverFault.origin,'worker');assert.equal(row.serverFault.httpStatus,502);assert.equal(row.serverFault.errorClass,'storage_error');
const failedNext=row.steps.find(step=>step.step==='next');assert.equal(failedNext.outcome,'failed');assert.equal(failedNext.observedBy,'server');assert.equal(failedNext.delivery,'unconfirmed');assert.equal(failedNext.completedAt,null);assert.equal(row.callerFault,null);
assert.doesNotMatch(JSON.stringify(row),secret);

boot(['tmdb_8803']);
start=await api('start',{scope:'watchlist_all',mode:'queued'});
next=await api('next',{runId:start.data.runId},'POST',{'X-Request-Id':'client-step-1'});
assert.equal(next.status,200);assert.equal(next.requestId,'client-step-1');assert.equal(next.data.requestId,'client-step-1');assert.equal(next.data.delivery,'unconfirmed');
const echoed=await api('next',{runId:start.data.runId},'POST',{'X-Request-Id':'not valid'});
assert.match(echoed.requestId,/^[A-Za-z0-9_-]{1,80}$/);assert.notEqual(echoed.requestId,'not valid');
const beforeExternal=events().length;
let done=await api('complete',{runId:start.data.runId,reason:'api_error',fault:{origin:'model_provider',failedStep:'next',providerErrorCode:'provider_timeout',httpStatus:503,receivedRequestId:'client-step-1'}});
assert.equal(done.status,200);assert.equal(done.data.stopReason,'api_error');assert.equal(done.data.delivery,'unconfirmed');
row=diagnostic(start.data.runId);
assert.equal(row.stopReason,'api_error');assert.equal(row.callerFault.reportedBy,'caller');assert.equal(row.callerFault.attribution,'caller_reported');assert.equal(row.callerFault.origin,'model_provider');assert.equal(row.callerFault.failedStep,'next');assert.equal(row.callerFault.providerErrorCode,'provider_timeout');assert.equal(row.callerFault.httpStatus,503);assert.equal(row.serverFault,null);
assert.equal(row.steps.find(step=>step.step==='next'&&step.requestId==='client-step-1').delivery,'unconfirmed');
const status=await api('status',undefined,'GET');
assert.equal(status.data.diagnostics.attribution,'caller_reported');assert.equal(status.data.diagnostics.steps.find(step=>step.requestId==='client-step-1').callerAcknowledged,true);assert.equal(status.data.diagnostics.delivery,'unconfirmed');
const listed=(await api('runs?limit=10',undefined,'GET')).data.runs.find(item=>item.runId===start.data.runId);
assert.equal(listed.steps.find(step=>step.requestId==='client-step-1').callerAcknowledged,true);
const again=await api('complete',{runId:start.data.runId,reason:'api_error',fault:{origin:'transport',failedStep:'complete',providerErrorCode:'dropped',httpStatus:504,receivedRequestId:'other-client'}});
assert.equal(again.data.status,'partial');assert.equal(diagnostic(start.data.runId).callerFault.origin,'model_provider');assert.equal(events().length,beforeExternal+1);
assert.doesNotMatch(JSON.stringify(diagnostic(start.data.runId)),secret);assert.doesNotMatch(JSON.stringify(events().map(key=>records.get(key))),/provider_timeout|Bearer|token|prompt|stack/i);

boot(['tmdb_8804']);
start=await api('start',{scope:'watchlist_all',mode:'queued'});
await api('next',{runId:start.data.runId});
done=await api('complete',{runId:start.data.runId,reason:'api_error'});
row=diagnostic(start.data.runId);
assert.equal(row.stopReason,'api_error');assert.equal(row.callerFault.attribution,'external_unattributed');assert.equal(row.callerFault.origin,'unknown');assert.equal(row.callerFault.reportedBy,null);assert.equal(row.callerFault.errorClass,'unknown');assert.equal(row.serverFault,null);assert.notEqual(row.callerFault.origin,'worker');

boot(['tmdb_8805']);
start=await api('start',{scope:'watchlist_all',mode:'queued'});
const rejected=await api('complete',{runId:start.data.runId,reason:'api_error',fault:{origin:'model_provider',providerErrorCode:'Bearer secret',httpStatus:503}});
assert.equal(rejected.status,400);assert.equal(records.get('enrichment/runs/'+start.data.runId+'.json').status,'running');assert.equal(diagnostic(start.data.runId).callerFault,null);assert.equal(diagnostic(start.data.runId).stopReason,null);
assert.doesNotMatch(JSON.stringify(diagnostic(start.data.runId)),/Bearer|secret|stack/i);

boot(['tmdb_8806']);
start=await api('start',{scope:'watchlist_all',mode:'queued'});
next=await api('next',{runId:start.data.runId});
const submitted=await api('submit',{runId:start.data.runId,items:[{filmId:next.data.items[0].filmId,fingerprint,prediction}]});
assert.equal(submitted.data.results[0].status,'created');
done=await api('complete',{runId:start.data.runId});
assert.equal(done.data.status,'complete');assert.equal(done.data.stopReason,'queue_empty');
row=diagnostic(start.data.runId);
assert.equal(row.callerFault,null);assert.equal(row.serverFault,null);assert.equal(row.lastAttemptedStep,'complete');assert.equal(row.lastCompletedStep,'complete');
assert.equal(row.steps.some(step=>step.outcome==='failed'||step.errorClass),false);
assert.doesNotMatch(JSON.stringify(row),secret);assert.equal(JSON.stringify(row).includes(next.data.items[0].filmId),false);
const duplicate=await api('complete',{runId:start.data.runId,fault:{origin:'orchestrator',failedStep:'complete',providerErrorCode:'late',httpStatus:500}});
assert.equal(duplicate.data.status,'complete');assert.equal(diagnostic(start.data.runId).callerFault,null);

boot(['tmdb_8817']);
start=await api('start',{scope:'watchlist_all',mode:'queued'});
next=await api('next',{runId:start.data.runId},'POST',{'X-Request-Id':'client-step-clean'});
await api('submit',{runId:start.data.runId,items:[{filmId:next.data.items[0].filmId,fingerprint,prediction}]});
const beforeClean=events().length;
const falseFault=await api('complete',{runId:start.data.runId,fault:{origin:'model_provider',failedStep:'next',providerErrorCode:'provider_timeout',httpStatus:503,receivedRequestId:'client-step-clean'}});
assert.equal(falseFault.status,400);assert.equal(records.get('enrichment/runs/'+start.data.runId+'.json').status,'running');assert.equal(diagnostic(start.data.runId).callerFault,null);assert.equal(diagnostic(start.data.runId).stopReason,null);assert.equal(events().length,beforeClean);
const falseQueue=await api('complete',{runId:start.data.runId,reason:'queue_empty',fault:{origin:'model_provider',failedStep:'complete',providerErrorCode:'provider_timeout',httpStatus:503,receivedRequestId:'client-step-clean'}});
assert.equal(falseQueue.status,400);assert.equal(records.get('enrichment/runs/'+start.data.runId+'.json').status,'running');assert.equal(diagnostic(start.data.runId).callerFault,null);assert.equal(events().length,beforeClean);
done=await api('complete',{runId:start.data.runId});
assert.equal(done.data.status,'complete');assert.equal(done.data.stopReason,'queue_empty');
const cleanStatus=await api('status',undefined,'GET');
assert.equal(cleanStatus.data.diagnostics.callerFault,null);assert.equal(cleanStatus.data.diagnostics.attribution,null);assert.equal(cleanStatus.data.diagnostics.steps.every(step=>step.callerAcknowledged===false),true);

boot(['tmdb_8818']);
start=await api('start',{scope:'watchlist_all',mode:'queued'});
next=await api('next',{runId:start.data.runId},'POST',{'X-Request-Id':'client-step-real'});
done=await api('complete',{runId:start.data.runId,reason:'api_error',fault:{origin:'transport',failedStep:'next',providerErrorCode:'dropped',httpStatus:504,receivedRequestId:'never-issued'}});
assert.equal(done.data.stopReason,'api_error');
row=diagnostic(start.data.runId);
assert.equal(row.callerFault.attribution,'caller_reported');assert.equal(row.callerFault.receivedRequestId,'never-issued');
assert.equal(row.steps.every(step=>step.delivery==='unconfirmed'),true);
const unknownStatus=await api('status',undefined,'GET');
assert.equal(unknownStatus.data.diagnostics.delivery,'unconfirmed');
assert.equal(unknownStatus.data.diagnostics.steps.every(step=>step.callerAcknowledged===false),true);
assert.equal(unknownStatus.data.diagnostics.steps.some(step=>step.requestId==='client-step-real'),true);

boot(['tmdb_8807']);
start=await api('start',{scope:'watchlist_all',mode:'queued'});
records.get('enrichment/runner-lease.json').runId='another-owner';
next=await api('next',{runId:start.data.runId});
assert.equal(next.status,409);assert.equal(next.data.status,'lease_lost');assert.equal(records.get('enrichment/runner-lease.json').runId,'another-owner');
row=diagnostic(start.data.runId);
assert.equal(row.serverFault.origin,'worker');assert.equal(row.serverFault.errorClass,'lease_lost');assert.equal(row.steps.find(step=>step.step==='next').outcome,'produced');assert.equal(row.steps.find(step=>step.step==='next').httpStatus,409);assert.equal(row.steps.find(step=>step.step==='next').delivery,'unconfirmed');

boot(['tmdb_8811','tmdb_8812','tmdb_8813','tmdb_8814','tmdb_8815']);
start=await api('start',{scope:'watchlist_all',mode:'queued'});
next=await api('next',{runId:start.data.runId,batchSize:5});
assert.equal(next.data.items.length,5);
const ids=next.data.items.map(item=>item.filmId);
await api('submit',{runId:start.data.runId,items:[{filmId:ids[0],failure:{kind:'parse_error'}}]});
await api('submit',{runId:start.data.runId,items:[{filmId:ids[1],fingerprint:{}}]});
await api('submit',{runId:start.data.runId,items:[{filmId:ids[2]}]});
await api('submit',{runId:start.data.runId,items:[{filmId:ids[3],fingerprint,prediction:{predictedRating:'nope'}}]});
const storm=await api('submit',{runId:start.data.runId,items:[{filmId:ids[4],failure:{kind:'parse_error'}}]});
assert.equal(storm.data.stopReason,'format_error_storm');assert.equal(storm.data.mustComplete,true);
row=diagnostic(start.data.runId);
assert.equal(row.itemValidation.consecutive,5);
assert.deepEqual(row.itemValidation.stages.map(stage=>stage.stage),['caller_reported','fingerprint_schema','fingerprint_missing','prediction_schema','caller_reported']);
assert.deepEqual(row.itemValidation.stages.map(stage=>stage.reportedBy),['caller','worker','worker','worker','caller']);
const stages=JSON.stringify(row.itemValidation);for(const id of ids)assert.equal(stages.includes(id),false);assert.doesNotMatch(stages,/MODEL-OUTPUT-CANARY|Bearer|stack|title/i);

boot(['tmdb_8816']);
start=await api('start',{scope:'watchlist_all',mode:'queued'});
failProducedNext=true;
next=await api('next',{runId:start.data.runId});
assert.equal(next.status,200);assert.ok(next.data.items.length);assert.equal(next.data.delivery,'unconfirmed');
assert.equal(diagnostic(start.data.runId).steps.find(step=>step.step==='next').outcome,'entered');

console.log('Run diagnostics: failed next, caller fault, unattributed api_error, clean completion, duplicate complete, lease loss, validation stages and a dropped finish write passed');
