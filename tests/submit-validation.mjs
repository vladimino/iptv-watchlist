// AIR-152: prediction_submit schema rejections name the field and the violation from a closed
// vocabulary, the same contract GET /api/enrichment/schema publishes for preflight. Retry and
// lease semantics are unchanged; no payload text, title or secret leaves the request.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,failKey='';const logs=[];
const env={BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;if(key===failKey){failKey='';throw new Error('Storage checkpoint interrupted TITLE-CANARY');}records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},list:async()=>({objects:[],truncated:false})}};
const capture={log:(...args)=>logs.push(args.map(String).join(' ')),error:(...args)=>logs.push(args.map(String).join(' ')),warn:(...args)=>logs.push(args.map(String).join(' '))};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:capture});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
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
assert.match(schema.rules.join(' '),/contract before prediction_submit/);
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

// 2. Submit: missing moodLabels, invalid enums, wrong prediction types, missing prediction, missing fingerprint, caller report, valid payload.
boot(['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5','tmdb_6','tmdb_7']);
const start=(await api('start',{scope:'watchlist_all',mode:'queued'})).data;assert.equal(start.status,'running');
const next=(await api('next',{runId:start.runId,batchSize:7})).data;const ids=next.items.map(item=>item.filmId);assert.equal(ids.length,7);
const submit=item=>api('submit',{runId:start.runId,items:[item]});
let r=(await submit({filmId:ids[0],fingerprint:{...noMood,strengths:['PAYLOAD-CANARY plan']},prediction})).data;
assert.equal(r.results[0].status,'retryable_failure');assert.equal(r.results[0].error,'parse_error');assert.equal(r.results[0].failureScope,'item');assert.equal(r.results[0].retryable,true);assert.ok(r.results[0].retryAt>Date.now());
assert.deepEqual(r.results[0].validation,{stage:'fingerprint_schema',reportedBy:'worker',issues:[{path:'fingerprint.moodLabels',code:'required'}]});
assert.equal(records.has('enrichment/films/'+ids[0]+'/fingerprint.json'),false);assert.equal(r.mustComplete,false);assert.equal(r.status,'running');
r=(await submit({filmId:ids[1],fingerprint:{...badEnums,risks:['PAYLOAD-CANARY risk']},prediction})).data;
assert.deepEqual(codes(r.results[0].validation.issues),['fingerprint.execution.payoff invalid_enum','fingerprint.execution.hero_vulnerability invalid_enum']);assert.equal(r.results[0].validation.stage,'fingerprint_schema');
r=(await submit({filmId:ids[2],fingerprint,prediction:{...badTypes,matchSignals:['PAYLOAD-CANARY']}})).data;
assert.equal(r.results[0].validation.stage,'prediction_schema');assert.deepEqual(codes(r.results[0].validation.issues),['prediction.predictedRating invalid_type','prediction.probability4Plus out_of_range','prediction.confidence invalid_enum','prediction.mainRisk invalid_type','prediction.moodLabels too_few']);
assert.ok(records.has('enrichment/films/'+ids[2]+'/fingerprint.json'),'a valid fingerprint is saved even when the prediction is rejected');assert.equal(records.has('enrichment/films/'+ids[2]+'/predictions.json'),false);
r=(await submit({filmId:ids[3],fingerprint})).data;
assert.deepEqual(r.results[0].validation,{stage:'prediction_schema',reportedBy:'worker',issues:[{path:'prediction',code:'required'}]});
r=(await submit({filmId:ids[4],prediction})).data;
assert.deepEqual(r.results[0].validation,{stage:'fingerprint_missing',reportedBy:'worker',issues:[{path:'fingerprint',code:'required'}]});assert.equal(r.results[0].error,'parse_error');
assert.equal(r.mustComplete,true,'five consecutive distinct format failures still stop the run');assert.equal(r.stopReason,'format_error_storm');
// Validation summaries persist on the run and the queue retries with the same closed vocabulary.
let run=records.get('enrichment/runs/'+start.runId+'.json'),queue=records.get('enrichment/prediction-queue.json');
assert.deepEqual(run.failures[ids[0]].validation.issues,[{path:'fingerprint.moodLabels',code:'required'}]);assert.equal(run.failures[ids[0]].kind,'parse_error');assert.equal(run.failures[ids[0]].scope,'item');
assert.deepEqual(codes(queue.retries[ids[1]].validation.issues),['fingerprint.execution.payoff invalid_enum','fingerprint.execution.hero_vulnerability invalid_enum']);assert.equal(queue.retries[ids[1]].attempts,1);assert.equal(queue.retries[ids[1]].kind,'parse_error');
assert.equal(queue.retries[ids[4]].validation.stage,'fingerprint_missing');
assert.deepEqual(run.itemValidation.stages.map(stage=>stage.stage),['fingerprint_schema','fingerprint_schema','prediction_schema','prediction_schema','fingerprint_missing']);assert.deepEqual(Object.keys(run.itemValidation.stages[0]),['stage','reportedBy'],'AIR-88 stage entries are unchanged');
assert.doesNotMatch(stored(),secret);assert.doesNotMatch(logs.join('\n'),secret);
await api('complete',{runId:start.runId,reason:'format_error_storm'});

// 3. A caller-reported failure, a valid payload, idempotent re-delivery and a storage failure.
boot(['tmdb_11','tmdb_12','tmdb_13']);
const second=(await api('start',{scope:'watchlist_all',mode:'queued'})).data;const batch=(await api('next',{runId:second.runId,batchSize:3})).data.items.map(item=>item.filmId);
r=(await api('submit',{runId:second.runId,items:[{filmId:batch[0],failure:{kind:'validation_error'}}]})).data;
assert.deepEqual(r.results[0].validation,{stage:'caller_reported',reportedBy:'caller',issues:[]});assert.equal(r.results[0].error,'parse_error');
const again=(await api('submit',{runId:second.runId,items:[{filmId:batch[0],fingerprint,prediction}]})).data;
assert.equal(again.results[0].status,'retryable_failure');assert.deepEqual(again.results[0].validation,{stage:'caller_reported',reportedBy:'caller',issues:[]});assert.equal(records.get('enrichment/prediction-queue.json').retries[batch[0]].attempts,1,'re-delivery does not add an attempt');
r=(await api('submit',{runId:second.runId,items:[{filmId:batch[1],fingerprint,prediction}]})).data;
assert.equal(r.results[0].status,'created');assert.equal('validation' in r.results[0],false);assert.equal(records.get('enrichment/films/'+batch[1]+'/predictions.json').current.predictedRating,3.5);
failKey='enrichment/films/'+batch[2]+'/predictions.json';
r=(await api('submit',{runId:second.runId,items:[{filmId:batch[2],fingerprint,prediction}]})).data;
assert.equal(r.results[0].status,'failed');assert.equal(r.results[0].error,'storage_error');assert.equal(r.results[0].failureScope,'run');assert.equal('validation' in r.results[0],false,'a system failure is not a schema violation');assert.equal(r.stopReason,'storage_error');
run=records.get('enrichment/runs/'+second.runId+'.json');assert.equal('validation' in run.failures[batch[2]],false);assert.equal(run.failures[batch[2]].kind,'storage_error');
assert.doesNotMatch(stored(),secret);assert.doesNotMatch(JSON.stringify(r),secret);assert.doesNotMatch(logs.join('\n'),secret);

// 4. The runner contract advertises the preflight and the report channel.
const runner=(await api('runner',undefined,'GET')).data;
assert.deepEqual(runner.itemFailures.validation.stages,['caller_reported','fingerprint_schema','fingerprint_missing','prediction_schema']);assert.deepEqual(runner.itemFailures.validation.issueCodes,schema.contract.issueCodes);
assert.ok(runner.instructions.some(line=>/results\[\]\.validation\.issues/.test(line)));
assert.equal(runner.itemFailures.retryable,true);assert.equal(runner.itemFailures.stopAfterConsecutive,5);

// 5. Film diagnostics return the stored summary and drop anything outside the vocabulary.
const retries=records.get('enrichment/prediction-queue.json').retries;
retries['tmdb_12']={kind:'parse_error',scope:'item',attempts:1,failedAt:Date.now()-1000,retryAt:Date.now()+3600000,lastRunId:second.runId,validation:{stage:'fingerprint_schema',reportedBy:'worker',issues:[{path:'fingerprint.execution.payoff',code:'invalid_enum'},{path:'fingerprint.strengths TITLE-CANARY',code:'too_long'},{path:'fingerprint.moodLabels',code:'Bearer secret'},'text']}};
retries['tmdb_13']={kind:'parse_error',scope:'item',attempts:1,failedAt:Date.now()-1000,retryAt:Date.now()+3600000,lastRunId:second.runId,validation:{stage:'TITLE-CANARY',reportedBy:'model',issues:'not a list'}};
const snapshot=await call('loadPredictionDiagnosticSnapshot')(env,'tmdb_12');
const diagnostic=plain(call('predictionFilmDiagnostic')(snapshot,'tmdb_12',Date.now()));
assert.deepEqual(diagnostic.retry.validation,{stage:'fingerprint_schema',reportedBy:'worker',issues:[{path:'fingerprint.execution.payoff',code:'invalid_enum'}]});
const tampered=plain(call('predictionFilmDiagnostic')(await call('loadPredictionDiagnosticSnapshot')(env,'tmdb_13'),'tmdb_13',Date.now()));
assert.deepEqual(tampered.retry.validation,{stage:'unknown',reportedBy:null,issues:[]});
assert.equal(call('predictionFilmDiagnostic')(await call('loadPredictionDiagnosticSnapshot')(env,'tmdb_11'),'tmdb_11',Date.now()).retry.validation.stage,'caller_reported');
assert.doesNotMatch(JSON.stringify([diagnostic,tampered]),secret);
// 6. Scheduled-style sequence (one film per next, as the MCP runner does): a malformed first item is named
// precisely, the following valid films are saved, the run completes normally, and the malformed film stays
// deferred with its original retry record. No format_error_storm from unrelated items.
boot(['tmdb_31','tmdb_32','tmdb_33','tmdb_34','tmdb_35']);
const scheduled=(await api('start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'})).data;assert.equal(scheduled.status,'running');assert.equal(scheduled.trigger,'scheduled');
const seen=[],saved=[];let malformedId=null,originalRetry=null,step;
for(let i=0;i<10;i++){step=(await api('next',{runId:scheduled.runId,batchSize:1})).data;if(step.mustComplete)break;assert.equal(step.items.length,1);const {filmId}=step.items[0];assert.ok(!seen.includes(filmId),'a deferred film is not offered again in the same run');seen.push(filmId);
 if(seen.length===1){malformedId=filmId;r=(await api('submit',{runId:scheduled.runId,items:[{filmId,fingerprint:{...badEnums,strengths:['PAYLOAD-CANARY']},prediction}]})).data;
  assert.equal(r.results[0].status,'retryable_failure');assert.deepEqual(codes(r.results[0].validation.issues),['fingerprint.execution.payoff invalid_enum','fingerprint.execution.hero_vulnerability invalid_enum']);assert.equal(r.mustComplete,false);assert.equal(r.status,'running');
  originalRetry=structuredClone(records.get('enrichment/prediction-queue.json').retries[filmId]);assert.equal(originalRetry.attempts,1);assert.ok(originalRetry.retryAt>Date.now());}
 else{r=(await api('submit',{runId:scheduled.runId,items:[{filmId,fingerprint,prediction}]})).data;assert.equal(r.results[0].status,'created');assert.equal('validation' in r.results[0],false);assert.equal(r.mustComplete,false);assert.equal(r.stopReason,null);saved.push(filmId);assert.equal(r.added,saved.length,'coverage progresses despite the deferred film');}}
assert.equal(step.mustComplete,true);assert.equal(step.stopReason,'eligible_queue_empty','the deferred film is the only outstanding work');assert.equal(saved.length,4);assert.equal(seen.length,5);
const finished=(await api('complete',{runId:scheduled.runId,reason:step.stopReason})).data;
assert.equal(finished.status,'complete');assert.equal(finished.stopReason,'eligible_queue_empty');assert.equal(finished.reason,null);assert.deepEqual(finished.counts,{created:4,recalculated:0,failed:1,pending:0});assert.notEqual(finished.stopReason,'format_error_storm');
for(const id of saved)assert.equal(records.get('enrichment/films/'+id+'/predictions.json').current.predictedRating,3.5);assert.equal(records.has('enrichment/films/'+malformedId+'/fingerprint.json'),false);
const afterRetry=records.get('enrichment/prediction-queue.json').retries[malformedId];
assert.deepEqual(afterRetry,originalRetry,'the deferred film keeps its original retry record: attempts, retryAt, validation');
assert.ok(records.get('enrichment/prediction-queue.json').hotPending.includes(malformedId),'the deferred film is still outstanding');assert.deepEqual(call('queueReadyIds')(records.get('enrichment/prediction-queue.json')),[],'and not eligible before retryAt');
run=records.get('enrichment/runs/'+scheduled.runId+'.json');assert.equal(run.formatFailureStreak,0,'valid films reset the consecutive-failure streak');assert.equal(Object.keys(run.failures).length,1);
assert.doesNotMatch(stored(),secret);assert.doesNotMatch(logs.join('\n'),secret);

console.log('Submit validation: contract-driven preflight parity, missing moodLabels, invalid enums, wrong types, missing prediction and fingerprint, caller report, valid payload, idempotent re-delivery, storage failure, runner contract, sanitized film diagnostics and a scheduled-style sequence with one deferred film passed');
