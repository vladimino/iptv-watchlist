// AIR-152: submit schema rejections name the field and the violation from a closed vocabulary, the same contract GET /api/enrichment/schema publishes for
// preflight. Since ADR 0167 the submit is the batch runner v2 `batch_submit` (D1 mode, sections 2, 3 and 6); the pure validators, the runner contract and the
// film diagnostics (sections 1, 4 and 5) need no runner. Retry and lease semantics are unchanged; no payload text, title or secret leaves the request.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {installViewIndexFixture} from './view-index-fixture.mjs';
const records=new Map(),etags=new Map();let revision=0,failKey='';const logs=[];
const env={BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;if(key===failKey){failKey='';throw new Error('Storage checkpoint interrupted TITLE-CANARY');}records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},list:async()=>({objects:[],truncated:false})}};
const capture={log:(...args)=>logs.push(args.map(String).join(' ')),error:(...args)=>logs.push(args.map(String).join(' ')),warn:(...args)=>logs.push(args.map(String).join(' '))};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:capture});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
installViewIndexFixture(ctx);
ctx.env=env;const call=code=>vm.runInContext(code,ctx),plain=value=>JSON.parse(JSON.stringify(value));
// Values crossing the vm boundary are JSON round-tripped so deepEqual compares structure, not realm prototypes.
const fp=value=>plain(call('fingerprintIssues')(value)),pp=value=>plain(call('predictionIssues')(value));
async function api(path,body,method='POST'){const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};}
const film=id=>({id,title:'Heat '+id,original:id,year:1995,tmdbId:id.replace(/\D/g,''),genres:[],actors:[],directors:[],shows:[{start:Date.now()}]});
const EXECUTION=plain(call('EXECUTION'));
const execution=Object.fromEntries(Object.entries(EXECUTION).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['heist','investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
const secret=/TITLE-CANARY|PAYLOAD-CANARY|Storage checkpoint interrupted|Bearer|token|Invalid fingerprint|Invalid prediction/i;
function boot(ids){records.clear();etags.clear();revision=0;failKey='';logs.length=0;records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});records.set('sync.json',{runId:'test',stage:'complete'});const catalog={};for(const id of ids)catalog[id]=film(id);records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',catalog);}
const codes=issues=>issues.map(issue=>issue.path+' '+issue.code);
const stored=()=>JSON.stringify([...records].filter(([key])=>!/\/(fingerprint|predictions)\.json$/.test(key)));

// 1. The schema contract is the validator: a generic evaluator over the published JSON reproduces the server's issues.
const schema=(await api('schema',undefined,'GET')).data;
assert.equal(schema.contract.version,1);assert.deepEqual(schema.contract.issueCodes,plain(call('ISSUE_CODES')));
assert.deepEqual(schema.contract.fingerprint.rules.execution.fields,EXECUTION);assert.deepEqual(schema.contract.fingerprint.rules.execution.required,schema.fingerprint.requiredExecution);
assert.equal(schema.contract.fingerprint.rules.moodLabels.minItems,2);assert.equal(schema.contract.prediction.rules.predictedRating.step,.5);
assert.match(schema.rules.join(' '),/contract before prediction_batch_submit/);
function preflight(root,rules,value){
 const issues=[],add=(path,code)=>issues.push({path,code});if(value===undefined){add(root,'required');return issues;}if(!value||typeof value!=='object'||Array.isArray(value)){add(root,'invalid_type');return issues;}
 for(const [field,rule] of Object.entries(rules)){const path=root+'.'+field,x=value[field];
  if(rule.kind==='const'){if(x===undefined)add(path,'required');else if(x!==rule.value)add(path,'invalid_version');}
  else if(rule.kind==='enum'){if(x===undefined)add(path,'required');else if(typeof x!=='string')add(path,'invalid_type');else if(!rule.values.includes(x))add(path,'invalid_enum');}
  else if(rule.kind==='enum_list'){if(x===undefined)add(path,'required');else if(!Array.isArray(x)||x.some(v=>typeof v!=='string'))add(path,'invalid_type');else if(x.some(v=>!rule.values.includes(v)))add(path,'invalid_enum');}
  else if(rule.kind==='enum_object'){if(x===undefined)add(path,'required');else if(!x||typeof x!=='object')add(path,'invalid_type');else for(const [key,values] of Object.entries(rule.fields)){const v=x[key];if(v===undefined){if(rule.required.includes(key))add(path+'.'+key,'required');}else if(typeof v!=='string')add(path+'.'+key,'invalid_type');else if(!values.includes(v))add(path+'.'+key,'invalid_enum');}}
  else if(rule.kind==='text_list'||rule.kind==='ref_list'){if(x===undefined)add(path,'required');else if(!Array.isArray(x))add(path,'invalid_type');else{if(x.length<(rule.minItems||0))add(path,'too_few');else if(x.length>rule.maxItems)add(path,'too_many');if(x.some(v=>typeof v!=='string'))add(path,'invalid_type');else if(rule.kind==='text_list'&&x.some(v=>!v.trim()))add(path,'empty');else if(x.some(v=>v.length>rule.maxLength))add(path,'too_long');else if(rule.kind==='ref_list'&&x.some(v=>!/^https:\/\//.test(v)&&v!=='model_knowledge'))add(path,'invalid_ref');}}
  else if(rule.kind==='number'){if(x===undefined)add(path,'required');else if(typeof x!=='number'||!Number.isFinite(x))add(path,'invalid_type');else if(x<rule.min||x>rule.max)add(path,'out_of_range');else if(rule.step&&(x/rule.step)%1!==0)add(path,'invalid_step');}
  else if(rule.kind==='text'){if(x==null){if(!rule.nullable)add(path,'required');}else if(typeof x!=='string')add(path,'invalid_type');else if(!x.trim())add(path,'empty');else if(x.length>rule.maxLength)add(path,'too_long');}
  else assert.fail('unknown rule kind '+rule.kind);}
 return issues;
}
const {moodLabels:_dropped,...noMood}=fingerprint;
const badEnums={...fingerprint,execution:{...execution,payoff:'medium',hero_vulnerability:'medium'}};
const badTypes={predictedRating:'nope',probability4Plus:2,confidence:'sure',matchSignals:'one',mainRisk:42,moodLabels:['x']};
const samples=[[noMood,'fingerprint'],[badEnums,'fingerprint'],[fingerprint,'fingerprint'],[{...fingerprint,fingerprintSchemaVersion:2,plotMechanics:['heist',7],sourceRefs:['ftp://x'],strengths:[' ']},'fingerprint'],[badTypes,'prediction'],[prediction,'prediction'],[{...prediction,predictedRating:4.2,mainRisk:null},'prediction'],[undefined,'prediction'],[[],'fingerprint']];
for(const [sample,root] of samples){const server=root==='fingerprint'?fp(sample):pp(sample);assert.deepEqual(server,preflight(root,schema.contract[root].rules,sample),JSON.stringify(sample));for(const issue of server){assert.ok(schema.contract.issueCodes.includes(issue.code));assert.match(issue.path,/^(fingerprint|prediction)(\.[A-Za-z0-9_]+){0,2}$/);}}
assert.deepEqual(codes(fp(noMood)),['fingerprint.moodLabels required']);
assert.deepEqual(codes(fp(badEnums)),['fingerprint.execution.payoff invalid_enum','fingerprint.execution.hero_vulnerability invalid_enum']);
assert.deepEqual(codes(pp(badTypes)),['prediction.predictedRating invalid_type','prediction.probability4Plus out_of_range','prediction.confidence invalid_enum','prediction.matchSignals invalid_type','prediction.mainRisk invalid_type','prediction.moodLabels too_few']);
assert.deepEqual(fp(fingerprint),[]);assert.deepEqual(pp(prediction),[]);
assert.deepEqual(codes(fp({...fingerprint,strengths:Array.from({length:8},()=>'x'.repeat(500)),risks:Array.from({length:8},()=>'y'.repeat(500)),sourceRefs:Array.from({length:8},()=>'https://'+'z'.repeat(490))})),['fingerprint too_large'],'the size cap applies only to an otherwise valid fingerprint');
assert.equal(call('validateFingerprint')(badEnums),'Invalid fingerprint.execution.payoff invalid_enum, fingerprint.execution.hero_vulnerability invalid_enum');assert.equal(call('validatePrediction')(prediction),null);

// Batch v2 worlds (D1 mode): the run record, the queue and the film tables are rows of the sqlite stand-in.
const v2=async n=>{const w=await flowWorld({films:n});const {start}=await w.reconcileAndStart();assert.equal(start.status,200,JSON.stringify(start.data).slice(0,200));return {w,m:start.data,ids:start.data.films.map(f=>f.filmId)};};
const v2Submit=(x,items)=>x.w.api('batch/submit',{runId:x.m.runId,epoch:x.m.lease.epoch,items});
const v2Run=x=>JSON.parse(sql(x.w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+x.m.runId+"'")[0].d);
const v2Queue=x=>JSON.parse(sql(x.w.file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
const v2Films=(x,table)=>sql(x.w.file,'SELECT film_id FROM '+table+' ORDER BY film_id').map(r=>r.film_id);
// The runner lease row has a `token` column and the stored manifest quotes the schema contract, so the batch worlds check the canaries and messages only.
const v2Secret=/TITLE-CANARY|PAYLOAD-CANARY|Storage checkpoint interrupted|Bearer|Invalid fingerprint|Invalid prediction/i;
const v2Stored=x=>JSON.stringify(['prediction_run','prediction_queue','prediction_lease'].map(t=>sql(x.w.file,'SELECT * FROM '+t)))+JSON.stringify([...x.w.records].filter(([key])=>!/\/(fingerprints|predictions)\//.test(key)));

// 2. Submit: missing moodLabels, invalid enums, wrong prediction types, missing prediction, missing fingerprint. Five consecutive distinct format failures stop the run.
{
 const x=await v2(7),ids=x.ids;assert.equal(ids.length,7);
 const r=(await v2Submit(x,[{filmId:ids[0],fingerprint:{...noMood,strengths:['PAYLOAD-CANARY plan']},prediction},{filmId:ids[1],fingerprint:{...badEnums,risks:['PAYLOAD-CANARY risk']},prediction},{filmId:ids[2],fingerprint,prediction:{...badTypes,matchSignals:['PAYLOAD-CANARY']}},{filmId:ids[3],fingerprint},{filmId:ids[4],prediction}])).data;
 const by=Object.fromEntries(r.results.map(item=>[item.filmId,item]));
 assert.equal(by[ids[0]].status,'validation_failure');assert.equal(by[ids[0]].error,'parse_error');assert.equal(by[ids[0]].retryable,true);assert.ok(by[ids[0]].retryAt>Date.now());
 assert.deepEqual(by[ids[0]].validation,{stage:'fingerprint_schema',reportedBy:'worker',issues:[{path:'fingerprint.moodLabels',code:'required'}]});
 assert.deepEqual(codes(by[ids[1]].validation.issues),['fingerprint.execution.payoff invalid_enum','fingerprint.execution.hero_vulnerability invalid_enum']);assert.equal(by[ids[1]].validation.stage,'fingerprint_schema');
 assert.equal(by[ids[2]].validation.stage,'prediction_schema');assert.deepEqual(codes(by[ids[2]].validation.issues),['prediction.predictedRating invalid_type','prediction.probability4Plus out_of_range','prediction.confidence invalid_enum','prediction.mainRisk invalid_type','prediction.moodLabels too_few']);
 assert.deepEqual(by[ids[3]].validation,{stage:'prediction_schema',reportedBy:'worker',issues:[{path:'prediction',code:'required'}]});
 assert.deepEqual(by[ids[4]].validation,{stage:'fingerprint_missing',reportedBy:'worker',issues:[{path:'fingerprint',code:'required'}]});assert.equal(by[ids[4]].error,'parse_error');
 assert.ok(!v2Films(x,'prediction_fingerprint').includes(ids[0]),'an invalid fingerprint is not saved');
 assert.ok(v2Films(x,'prediction_fingerprint').includes(ids[2]),'a valid fingerprint is saved even when the prediction is rejected');assert.deepEqual(v2Films(x,'prediction_pointer'),[]);
 assert.equal(r.mustComplete,true,'five consecutive distinct format failures stop the run');assert.equal(r.stopReason,'format_error_storm');
 // Validation summaries persist on the run and the queue retries with the same closed vocabulary.
 const run=v2Run(x),queue=v2Queue(x);
 assert.deepEqual(run.failures[ids[0]].validation.issues,[{path:'fingerprint.moodLabels',code:'required'}]);assert.equal(run.failures[ids[0]].kind,'parse_error');assert.equal(run.failures[ids[0]].scope,'item');
 assert.deepEqual(codes(queue.retries[ids[1]].validation.issues),['fingerprint.execution.payoff invalid_enum','fingerprint.execution.hero_vulnerability invalid_enum']);assert.equal(queue.retries[ids[1]].attempts,1);assert.equal(queue.retries[ids[1]].kind,'parse_error');
 assert.equal(queue.retries[ids[4]].validation.stage,'fingerprint_missing');
 assert.deepEqual(run.itemValidation.stages.map(stage=>stage.stage),['fingerprint_schema','fingerprint_schema','prediction_schema','prediction_schema','fingerprint_missing']);assert.deepEqual(Object.keys(run.itemValidation.stages[0]),['stage','reportedBy'],'AIR-88 stage entries are unchanged');
 assert.doesNotMatch(v2Stored(x),v2Secret);assert.doesNotMatch(x.w.logs.join('\n'),secret);
 const stopped=await x.w.api('complete',{runId:x.m.runId,reason:'format_error_storm'});assert.equal(stopped.status,200,JSON.stringify(stopped.data).slice(0,200));
}

// 3. A caller-reported failure, a valid payload and idempotent re-delivery.
{
 const x=await v2(3),batch=x.ids;
 let r=(await v2Submit(x,[{filmId:batch[0],failure:{kind:'validation_error',reason:'insufficient_evidence'}}])).data;
 assert.equal(r.results[0].validation.stage,'caller_reported');assert.equal(r.results[0].validation.reportedBy,'caller');assert.deepEqual(r.results[0].validation.issues,[]);assert.equal(r.results[0].error,'parse_error');
 const again=(await v2Submit(x,[{filmId:batch[0],failure:{kind:'validation_error',reason:'insufficient_evidence'}}])).data;
 assert.equal(again.results[0].status,'validation_failure');assert.equal(again.results[0].replayed,true);assert.equal(v2Queue(x).retries[batch[0]].attempts,1,'re-delivery does not add an attempt');
 r=(await v2Submit(x,[{filmId:batch[1],fingerprint,prediction}])).data;
 assert.equal(r.results[0].status,'created');assert.equal('validation' in r.results[0],false);assert.deepEqual(v2Films(x,'prediction_pointer'),[batch[1]]);
 assert.doesNotMatch(v2Stored(x),v2Secret);assert.doesNotMatch(JSON.stringify(r),secret);assert.doesNotMatch(x.w.logs.join('\n'),secret);
}

// 4. The runner contract names batch runner v2 as the only protocol and the report channel of item failures.
const runner=(await api('runner',undefined,'GET')).data;
assert.equal(runner.protocol,'batch_v2');assert.deepEqual(runner.retiredProtocols,['v5']);assert.equal(runner.batchRunner.start,'/api/enrichment/batch/start');
assert.deepEqual(runner.itemFailures.validation.issueCodes,schema.contract.issueCodes);assert.match(runner.itemFailures.validation.reportedVia,/results\[\]\.validation/);
// AIR-452 follow-up: the schema contract names the batch v2 submit, never the retired v5 /api/enrichment/submit route.
assert.match(schema.contract.reportedVia,/^POST \/api\/enrichment\/batch\/submit .*prediction_batch_submit.*results\[\]\.validation/);assert.ok(!/\/api\/enrichment\/submit\b/.test(JSON.stringify(schema)),'schema names no retired v5 submit route');
assert.equal(runner.itemFailures.retryable,true);assert.ok(!JSON.stringify(runner).includes('/api/enrichment/next')&&!JSON.stringify(runner).includes('/api/enrichment/submit"'),'no retired v5 route is advertised');

// 5. Film diagnostics return the stored summary and drop anything outside the vocabulary (a stored queue with seeded retry records; no run is needed).
boot(['tmdb_11','tmdb_12','tmdb_13']);assert.equal((await api('queue/reconcile',{})).status,200);
const queueRecord=records.get('enrichment/prediction-queue.json');queueRecord.retries||={};const retries=queueRecord.retries;const second={runId:'run-diagnostics'};
retries['tmdb_11']={kind:'parse_error',scope:'item',attempts:1,failedAt:Date.now()-1000,retryAt:Date.now()+3600000,lastRunId:second.runId,validation:{stage:'caller_reported',reportedBy:'caller',issues:[]}};
retries['tmdb_12']={kind:'parse_error',scope:'item',attempts:1,failedAt:Date.now()-1000,retryAt:Date.now()+3600000,lastRunId:second.runId,validation:{stage:'fingerprint_schema',reportedBy:'worker',issues:[{path:'fingerprint.execution.payoff',code:'invalid_enum'},{path:'fingerprint.strengths TITLE-CANARY',code:'too_long'},{path:'fingerprint.moodLabels',code:'Bearer secret'},'text']}};
retries['tmdb_13']={kind:'parse_error',scope:'item',attempts:1,failedAt:Date.now()-1000,retryAt:Date.now()+3600000,lastRunId:second.runId,validation:{stage:'TITLE-CANARY',reportedBy:'model',issues:'not a list'}};
const snapshot=await call('loadPredictionDiagnosticSnapshot')(env,'tmdb_12');
const diagnostic=plain(call('predictionFilmDiagnostic')(snapshot,'tmdb_12',Date.now()));
assert.deepEqual(diagnostic.retry.validation,{stage:'fingerprint_schema',reportedBy:'worker',issues:[{path:'fingerprint.execution.payoff',code:'invalid_enum'}]});
const tampered=plain(call('predictionFilmDiagnostic')(await call('loadPredictionDiagnosticSnapshot')(env,'tmdb_13'),'tmdb_13',Date.now()));
assert.deepEqual(tampered.retry.validation,{stage:'unknown',reportedBy:null,issues:[]});
assert.equal(call('predictionFilmDiagnostic')(await call('loadPredictionDiagnosticSnapshot')(env,'tmdb_11'),'tmdb_11',Date.now()).retry.validation.stage,'caller_reported');
assert.doesNotMatch(JSON.stringify([diagnostic,tampered]),secret);
// 6. A sequence of groups: a malformed first film is named precisely, the following valid films are saved, the run completes normally, and the malformed film
// stays deferred with its original retry record. No format_error_storm from unrelated items.
{
 const x=await v2(5),ids=x.ids,malformedId=ids[0];
 let r=(await v2Submit(x,[{filmId:malformedId,fingerprint:{...badEnums,strengths:['PAYLOAD-CANARY']},prediction}])).data;
 assert.equal(r.results[0].status,'validation_failure');assert.deepEqual(codes(r.results[0].validation.issues),['fingerprint.execution.payoff invalid_enum','fingerprint.execution.hero_vulnerability invalid_enum']);assert.equal(r.mustComplete,false);assert.equal(r.status,'running');
 const originalRetry=structuredClone(v2Queue(x).retries[malformedId]);assert.equal(originalRetry.attempts,1);assert.ok(originalRetry.retryAt>Date.now());
 const saved=[];
 for(const filmId of ids.slice(1)){r=(await v2Submit(x,[{filmId,fingerprint,prediction}])).data;assert.equal(r.results[0].status,'created');assert.equal(r.mustComplete,false);assert.equal(r.stopReason,null);saved.push(filmId);assert.equal(r.added,saved.length,'coverage progresses despite the deferred film');}
 const finished=await x.w.api('complete',{runId:x.m.runId});
 assert.equal(finished.status,200,JSON.stringify(finished.data).slice(0,300));assert.equal(finished.data.status,'complete');assert.deepEqual(finished.data.counts,{created:4,recalculated:0,failed:1,pending:0});assert.notEqual(finished.data.stopReason,'format_error_storm');
 assert.deepEqual(v2Films(x,'prediction_pointer'),[...saved].sort());assert.ok(!v2Films(x,'prediction_fingerprint').includes(malformedId));
 const queue=v2Queue(x);assert.deepEqual(queue.retries[malformedId],originalRetry,'the deferred film keeps its original retry record: attempts, retryAt, validation');
 assert.ok(queue.hotPending.includes(malformedId),'the deferred film is still outstanding');assert.deepEqual(call('queueReadyIds')(queue),[],'and not eligible before retryAt');
 const run=v2Run(x);assert.equal(run.formatFailureStreak,0,'valid films reset the consecutive-failure streak');assert.equal(Object.keys(run.failures).length,1);
 assert.doesNotMatch(v2Stored(x),v2Secret);assert.doesNotMatch(x.w.logs.join('\n'),secret);
}

console.log('Submit validation (batch v2, D1): contract-driven preflight parity, missing moodLabels, invalid enums, wrong types, missing prediction and fingerprint, format storm, caller report, valid payload, idempotent re-delivery, v2-only runner contract, sanitized film diagnostics and a sequence with one deferred film passed');
