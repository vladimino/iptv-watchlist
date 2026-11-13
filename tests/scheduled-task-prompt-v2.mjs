// AIR-449: the proposed Predictions batch runner v2 Scheduled Task prompt, its dry-run prompt and the A/B contract. The files are documentation only (no live Task exists), so this test keeps honest:
// the stated lengths and SHA-256, the tool names the texts mention, the generation steps shared byte for byte by both prompts, the exact MCP calls (through the real MCP tool handler, offline),
// the sample/result schema, the dry-run write freeze over group sizes 1 to 10, and the real partial-stop semantics of the bounded run. No model, network, production or Scheduled Task is involved.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {check} from './json-schema-lite.mjs';
import * as PredictionD1 from '../src/prediction-d1.js';
import {buildReport} from '../scripts/prediction-ab-report.mjs';

const file='docs/reference/scheduled-task-prompts/hourly-predictions-batch-v2.md';
const doc=fs.readFileSync(file,'utf8');
const block=(name)=>{const m=doc.match(new RegExp('---BEGIN '+name+'---\\n([\\s\\S]*?)\\n---END '+name+'---'));assert.ok(m,name+' markers present');return m[1];};
const prompt=block('PROMPT'),dry=block('DRY RUN PROMPT');
const sha=text=>createHash('sha256').update(text).digest('hex');

// 1. Headers state the real length and SHA-256 of both texts.
const stated=doc.match(/\*\*Text below:\*\* (\d+) characters, SHA-256 `([0-9a-f]{64})`/),statedDry=doc.match(/\*\*Dry run text\*\*[^\n]*?: (\d+) characters, SHA-256 `([0-9a-f]{64})`/);
assert.ok(stated&&statedDry,'headers state length and hash');
assert.equal(prompt.length,Number(stated[1]));assert.equal(sha(prompt),stated[2]);
assert.equal(dry.length,Number(statedDry[1]));assert.equal(sha(dry),statedDry[2]);

// 2. The generation steps 4, 5 and 6 are byte-identical in both prompts: an A/B changes grouping only.
const steps=text=>text.split('\n').filter(l=>/^[456]\. /.test(l));
assert.equal(steps(prompt).length,3);assert.deepEqual(steps(dry),steps(prompt),'identical generation instructions');
// Research quality: the reusable assessment schema instructions remain identical, while the production-only research gate is not silently added to the historical A/B template.
const step3a=text=>text.split('\n').filter(l=>l.startsWith('3а. '));
assert.equal(step3a(prompt).length,1);assert.deepEqual(step3a(dry),step3a(prompt),'identical research and assessment instructions');
const step3b=text=>text.split('\n').filter(l=>l.startsWith('3б. '));
assert.equal(step3b(prompt).length,1);assert.equal(step3b(dry).length,0,'the frozen A/B procedure does not inherit a new production-only research gate');
for(const needle of ['ОБЯЗАТЕЛЬНО сделай ВТОРОЙ','OPEN — НЕ READ','concreteExecutionFinding','gateStatus=limited','gateStatus=blocked','временного аудита','НЕ поля fingerprint','search_snippet'])assert.ok(step3b(prompt)[0].includes(needle),'S5-C quality gate: '+needle);
for(const needle of ['РУЧНУЮ проверку','rules.execution.fields','opposition_competence','НЕ strong','research.attempts','МАССИВ','sources[].usedFor','1–120 Unicode','prediction_batch_validate','Buffer, TextEncoder','НЕ заменяет','не прекращай весь run'])assert.ok(prompt.includes(needle),'production manual closed-schema guard: '+needle);
for(const [name,value] of [['production',prompt],['A/B dry-run',dry]])assert.ok(!/\b(?:AIR-\d+|ADR[ -]?\d+|S5-C)\b/.test(value),name+' executable prompt must be free of historical ticket/decision IDs');
assert.ok(/Для операций с IPTV используй ТОЛЬКО/.test(prompt)&&/для исследования фильмов используй доступные web search/i.test(prompt),'IPTV MCP boundary must allow independent film research');
assert.ok(/не второй поисковый проход/i.test(prompt),'research gate must not duplicate the search budget');
assert.ok(/search_snippet допустим БЕЗ прочтения страницы/.test(prompt)&&/source с access=search_snippet, даже если сама статья не открыта/.test(prompt),'a search snippet is a valid used source without a readable article, but does not count as read content');
assert.ok(/gateStatus=blocked \(при этом assessment\.research\.status=not_attempted\)/.test(prompt),'unavailable search audit is distinct from assessment research status');
for(const val of [prompt,dry])assert.ok(/attempted_found, но snippets сами по себе НЕ дают substantive quality gate/.test(val)&&/web_research в sources ЗАПРЕЩЁН/.test(val),'web_research snippets imply attempted_found, not substantive research and not blocked');
assert.ok(!/другой v2 Task или ещё не выключенный legacy/.test(prompt),'scheduled prompt cannot assume historic enabled state');
assert.ok(!/FROZEN_MANIFEST|tmdb_800815|5bd010a00102b73a9c8bd24ef67cb56ca17f86918aca7d4715de20752e5dca7e/.test(prompt),'production uses only the live batch manifest, never frozen S5-C test inputs');
assert.ok(/prediction_batch_start\(\{trigger:'scheduled', manifestSize\}\)/.test(prompt),'production starts its own scheduled batch manifest');
assert.ok(!/runId:['"]dry-run['"]|dryRun:true|\{\{FROZEN_MANIFEST\}\}/.test(prompt),'production never invokes dry-run transport or synthetic S5-C runId');
assert.ok(/prediction_batch_submit\(\{runId,epoch,items\}\)/.test(prompt),'production submit uses the owned live runId and epoch');
assert.ok(/prediction_batch_submit\(\{runId:'dry-run',epoch:1,dryRun:true/.test(dry),'separate A/B template retains frozen dry-run submit');
for(const needle of ['НЕ БОЛЕЕ 2 web search запросов','НЕ БОЛЕЕ 3 независимо написанных источников','Guardian, Letterboxd, Slant','3000 байт','research.status=not_attempted','search_snippet','attempted_found','НЕ внутри него'])assert.ok(step3a(prompt)[0].includes(needle),needle);
for(const key of ['assessmentVersion','ratingBasis','probability4PlusBasis','tasteSignals','risks','uncertainties','research','sources','conflicts','model','usedFor','access','handling','stance','anchor','severity'])assert.ok(step3a(prompt)[0].includes(key),'step 3а names '+key);
assert.ok(prompt.includes('{filmId,fingerprint,prediction,assessment,metadata}')&&dry.includes('{filmId,fingerprint,prediction,assessment,metadata}'),'preflight items carry the assessment');
for(const t of [prompt,dry])assert.ok(t.includes('assessment.sources ссылается на metadata:*')&&t.includes('prediction_only'),'a prediction_only preflight carries metadata when the assessment cites metadata tokens');
assert.ok(/5\+5/.test(prompt)&&/5\+5/.test(dry),'both prompts split a group over 56 KiB in advance, generationSize independent of the call size');
assert.ok(!/web search[^.]*доступен и подтверждён/i.test(prompt),'no confirmed Web Search availability claim');
// Runtime batching: generationSize=1 accumulates to submitBatchSize=5; several independent v2 Tasks share the lease.
assert.ok(/generationSize=1/.test(prompt)&&/submitBatchSize=5/.test(prompt)&&/накапливай до submitBatchSize/.test(prompt),'template accumulates generationSize=1 films to submitBatchSize');
assert.ok(/буфер достигнет submitBatchSize/.test(prompt)&&/накопленного буфера/.test(prompt),'scheduled loop names the submit buffer');
assert.ok(/несколько независимых почасовых v2 Tasks/.test(prompt)&&/already_running от другой Task/.test(prompt),'multi-Task lease sharing is explicit');
assert.ok(!/только активн\w* Predictions Task/i.test(prompt)&&!/only active Predictions Task/i.test(prompt),'no singleton active-Task claim');


// 3. Tool names: every call the texts write exists and stays inside its vocabulary; the forbidden lists stay forbidden.
const mcp=fs.readFileSync('src/mcp.js','utf8');
const tools=new Set([...mcp.matchAll(/\{name:'([a-z_]+)',title:/g)].map(x=>x[1]));
const calls=text=>new Set([...text.matchAll(/\b((?:prediction|enrichment|epg|ratings)_[a-z_]+)\(/g)].map(x=>x[1]));
const forbiddenOf=text=>text.split('\n').find(l=>l.startsWith('ЗАПРЕЩЕНО:'));
const SCHEDULED_ALLOWED=new Set(['prediction_batch_start','prediction_batch_validate','prediction_batch_submit','prediction_heartbeat','prediction_complete']),DRY_ALLOWED=new Set(['prediction_batch_validate','prediction_batch_submit']);
for(const [text,allowed,forbidden] of [[prompt,SCHEDULED_ALLOWED,['prediction_start','prediction_next','prediction_submit','prediction_validate','epg_sync_start','epg_sync_step','ratings_sync_start','ratings_sync_step']],[dry,DRY_ALLOWED,['prediction_batch_start','prediction_start','prediction_next','prediction_submit','prediction_validate','prediction_heartbeat','prediction_complete','epg_sync_start','epg_sync_step','ratings_sync_start','ratings_sync_step']]]){
 const line=forbiddenOf(text);assert.ok(line,'forbidden list present');
 for(const t of forbidden){assert.ok(tools.has(t),t+' is a real tool');assert.ok(line.includes(t),t+' is forbidden');}
 for(const t of calls(text)){if(forbidden.includes(t)&&line.includes(t)&&!text.replace(line,'').includes(t+'('))continue;assert.ok(tools.has(t),t+' is a real MCP tool');assert.ok(allowed.has(t),t+' is outside the vocabulary');}
 for(const t of allowed)assert.ok(tools.has(t));
}
assert.ok(!/dryRun\s*:\s*true/.test(prompt.replace(forbiddenOf(prompt),'')),'the scheduled prompt never dry-runs');
assert.ok(dry.includes("prediction_batch_submit({runId:'dry-run',epoch:1,dryRun:true,manifestHash,items})"),'the dry-run call is the exact tested one');
assert.ok(!/prediction_batch_start\(/.test(dry),'a pass never calls start: the manifest is frozen once (ADR 0122 decision 10)');
assert.ok(/prediction_batch_start В ЛЮБОМ виде/.test(forbiddenOf(dry)));
assert.ok(/\{\{SAMPLE_ID\}\}/.test(dry)&&/\{\{GROUP_SIZE\}\}/.test(dry)&&/FROZEN_MANIFEST=\{\{FROZEN_MANIFEST\}\}/.test(dry)&&!/\{\{FILM_IDS\}\}/.test(dry),'the pass takes the frozen manifest, not film ids to start from');
assert.ok(/manifest_invalid/.test(dry)&&/НЕ вызывай ни разу/.test(dry));
const at=(text,needle)=>text.indexOf(needle);
for(const [label,text] of [['scheduled',prompt],['dry run',dry]]){
 assert.ok(at(text,'prediction_batch_validate({items})')>=0&&at(text,'prediction_batch_validate({items})')<at(text,'prediction_batch_submit({runId'),label+': the preflight comes before the submit');
 assert.ok(/ОДНОЙ повторной предпроверки/.test(text)&&/НИКОГДА не выдумывай refs/.test(text)&&/в том числе stakes/.test(text),label+': bounded retry, no invented refs, no metadata-only execution quality');
 assert.ok(/failure:\{kind:'parse_error'\}/.test(text),label+': an unrepairable film is reported as a failure item');
}
assert.ok(/ОДНОЙ сквозной последовательности 0, 1, 2/.test(dry)&&/предпроверка 0, submit 1, следующая предпроверка 2, следующий submit 3/.test(dry)&&/ИМЕННО вызова prediction_batch_submit/.test(dry)&&/никогда вызова предпроверки/.test(dry),'one global callId sequence for every MCP call; a film names its submit call only');
assert.ok(!/присвой callId \(0, 1, 2… в порядке вызовов/.test(doc),'the old per-submit numbering is gone');
assert.ok(/preflight \{valid,attempts/.test(dry)&&/kind 'preflight'/.test(dry),'the dry-run prompt records the preflight per film and per call');
assert.ok(/failureReason/.test(dry)&&/insufficient_metadata/.test(dry)&&/insufficient_knowledge/.test(dry)&&/json_unparseable/.test(dry),'the dry-run prompt asks for an honest failureReason');
assert.ok(steps(prompt).join('\n').includes('НЕ добавляй и НЕ вычисляй fingerprint.sourceBasis')&&!/Вычисляй fingerprint\.sourceBasis/.test(doc),'ADR 0129: the model no longer computes the aggregate, in both prompts');
assert.ok(/observedProfileHash/.test(dry)&&/profile_moved/.test(dry)&&/not_submitted/.test(dry)&&/liveInput не same/.test(dry),'the dry-run prompt makes the per-submit profile check and the liveInput rule explicit');
assert.ok(!/trello\.com\/c\/XDyt4qIH\)\s*'s scope/.test(fs.readFileSync('docs/runbooks/prediction-batch-v2-dry-run-ab.md','utf8')),'AIR-450 is not linked to the AIR-449 card');
assert.ok(fs.readFileSync('docs/runbooks/prediction-batch-v2-dry-run-ab.md','utf8').includes('[AIR-450](https://trello.com/c/VPd21Y9d)'));
const enrich=fs.readFileSync('src/enrichment.js','utf8');
for(const reason of ['profile_changed','runner_aborted','quota','model_unavailable','model_error','api_error','storage_error','external_termination','time_budget'])assert.ok(enrich.includes("'"+reason+"'"),reason+' is a Worker stop reason');
const live=fs.readFileSync('docs/reference/scheduled-task-prompts/hourly-predictions-only.md','utf8').match(/---BEGIN PROMPT---\n([\s\S]*)\n---END PROMPT---/)[1];
assert.equal(sha(live),'fc0b4c1772f33398b4cb4e2eafda6e71b89c260befbee363e299acae4a388d44','the live hourly prompt text is unchanged');
assert.ok(!/trello\.com\/c\/[\s;)]/.test(doc),'no empty Trello link');
const header=doc.match(/\*\*Dry run text\*\*[^\n]*/)[0];
assert.ok(header.includes('{{FROZEN_MANIFEST}}')&&!header.includes('FILM_IDS'),'the header names the real placeholders');
const runbook=fs.readFileSync('docs/runbooks/prediction-batch-v2-dry-run-ab.md','utf8');
assert.ok(!/100 films fits one start/.test(runbook)&&/manifest_too_large/.test(runbook)&&/largestFilmBytes/.test(runbook),'the freeze step handles a size refusal');
assert.ok(/Report boundary/.test(runbook)&&/never to the repository/.test(runbook)&&!/may contain only[^.]*per-pass result records/.test(runbook),'raw per-pass outputs are private');

// 4. A small JSON Schema checker (the subset the contract uses) validates the sample and result records.
const schema=JSON.parse(fs.readFileSync('docs/reference/scheduled-task-prompts/batch-v2-ab.schema.json','utf8'));
const validSample=x=>check(schema.$defs.sample,x),validResult=x=>check(schema.$defs.result,x);

// 5. The real MCP tool handler over the real Worker code, with a fresh world.
async function world(films){
 const w=await flowWorld({films});assert.equal((await w.api('queue/reconcile',{})).status,200);
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.call=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;const r=await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx);const res=r.result;return {isError:!!res.isError,data:res.isError?res.content[0].text:JSON.parse(res.content[0].text)};};
 return w;
}
const hex=h=>/^[0-9a-f]{8,64}$/.test(String(h))?String(h):sha(String(h)).slice(0,16); // the flow world's stand-in profile hash is 'p'; production hashes are hex
const dump=f=>{const r=sqliteSync([f,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const snapshot=w=>JSON.stringify([[...w.records.entries()],dump(w.file)]);

// 5a. Dry run, as the runbook defines it: ONE freeze start produces the manifest, which is handed over as text (the private handoff) to ten independent clean-context passes.
// A pass calls only prediction_batch_submit(dryRun) with the manifest it was given: no start, no read. The MCP schema needs a non-empty runId and a positive epoch even for a dry-run submit.
{
 const w=await world(30);
 const sample={schemaVersion:1,sampleId:'fixture-sample-1',filmIds:['tmdb_3','tmdb_1','tmdb_12','tmdb_7','tmdb_9','tmdb_20','tmdb_5','tmdb_14','tmdb_2','tmdb_25','tmdb_8','tmdb_30'],frozenAt:'2026-11-12T00:00:00Z',source:'offline fixture',manifestHash:null};
 assert.deepEqual(validSample(sample),[]);assert.ok(validSample({...sample,filmIds:['a','a']}).length,'duplicate ids rejected');assert.ok(validSample({...sample,extra:1}).length);
 const before=snapshot(w);
 const starts=[],submits=[];const tracked=async(name,args)=>{(name==='prediction_batch_start'?starts:submits).push(name);return w.call(name,args);};
 // freeze step, once
 const start=await tracked('prediction_batch_start',{trigger:'manual',dryRun:true,pin:{filmIds:sample.filmIds}});
 assert.ok(!start.isError,JSON.stringify(start.data).slice(0,200));
 const frozenText=JSON.stringify(start.data);sample.manifestHash=start.data.manifestHash;assert.deepEqual(validSample(sample),[]);
 const frozen0=JSON.parse(frozenText);
 assert.equal(frozen0.dryRun,true);assert.equal(frozen0.runId,null);assert.deepEqual(frozen0.films.map(f=>f.filmId),sample.filmIds,'pinned order');
 // the handoff is complete: profile body, contract schema, metadata and the per-film input hash are in it, not only the ids and the hash
 assert.ok(frozen0.profile?.body&&frozen0.contract?.schema&&frozen0.manifestHash&&frozen0.films.every(f=>f.plan&&f.modelMetadata&&/^[0-9a-f]{24}$/.test(f.inputHash)),'the frozen manifest carries everything a pass needs');
 assert.ok(!fs.readdirSync('docs',{recursive:true}).some(f=>/frozen[-_]?manifest|batch[-_]?v2[-_]?manifest/i.test(String(f))),'no manifest record is stored in the repository docs');
 const results=[];
 for(let size=1;size<=10;size++){
  const m=JSON.parse(frozenText); // a clean context: the pass has only the text it was given
  assert.equal(m.dryRun===true&&m.runId===null&&/^[0-9a-f]{64}$/.test(m.manifestHash)&&!!m.profile.body&&!!m.contract.schema&&m.films.length>0,true,'step 1 of the prompt: the manifest is valid');
  const films=[],calls=[];let g=0;
  for(let i=0;i<m.films.length;i+=size,g++){
   const group=m.films.slice(i,i+size),items=group.map(f=>({filmId:f.filmId,...(f.plan==='fingerprint_and_prediction'?{fingerprint:w.fingerprint}:{}),prediction:w.prediction,inputHash:f.inputHash}));
   // step 7: the preflight first (the same objects, no inputHash), read-only; every film is valid here, so no correction and one attempt each
   const pre=await w.call('prediction_batch_validate',{items:items.map(({inputHash,...rest})=>rest)});assert.ok(!pre.isError,JSON.stringify(pre.data).slice(0,200));assert.equal(pre.data.valid,true);assert.deepEqual(pre.data.results.map(x=>x.filmId),group.map(f=>f.filmId),'bound to the films of the group, in order');
   calls.push({callId:2*g,kind:'preflight',groupIndex:g,itemCount:items.length,bodyBytes:new TextEncoder().encode(JSON.stringify(items.map(({inputHash,...rest})=>rest))).length,toolMs:null,ok:true,observedProfileHash:null});
   const missing=await w.call('prediction_batch_submit',{dryRun:true,manifestHash:m.manifestHash,items});if(g===0&&size===1)assert.equal(missing.isError,true,'a dry-run submit without runId fails the MCP schema');
   const r=await tracked('prediction_batch_submit',{runId:'dry-run',epoch:1,dryRun:true,manifestHash:m.manifestHash,items});
   assert.ok(!r.isError,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.status,'dry_run');assert.equal(r.data.manifestHash,m.manifestHash,'the frozen manifest identity');
   const observed=hex(r.data.profile.hash);assert.equal(observed,hex(m.profile.hash),'step 7: the profile in the answer is the manifest profile');
   calls.push({callId:2*g+1,kind:'submit',groupIndex:g,itemCount:items.length,bodyBytes:new TextEncoder().encode(JSON.stringify(items)).length,toolMs:null,ok:true,observedProfileHash:observed});
   for(const [k,x] of r.data.results.entries())films.push({filmId:x.filmId,plan:group[k].plan,groupIndex:g,callId:2*g+1,preflight:{valid:true,attempts:1,issues:[]},fingerprint:items[k].fingerprint??null,prediction:items[k].prediction,submitStatus:x.status,liveInput:x.liveInput,validation:x.validation||null,generationMs:null});
  }
  const result={schemaVersion:1,sampleId:sample.sampleId,groupSize:size,promptSha256:sha(dry),manifestHash:m.manifestHash,profile:{version:m.profile.version,hash:hex(m.profile.hash)},contract:{fingerprintSchemaVersion:m.contract.fingerprintSchemaVersion,fingerprintPromptVersion:m.contract.fingerprintPromptVersion,predictionPromptVersion:m.contract.predictionPromptVersion,registryDigest:hex(m.contract.registryDigest)},films,calls,telemetry:{model:null,tokens:null,quota:null,wallMs:null,unavailable:['model','tokens','quota','wallMs','generationMs','toolMs']}};
  assert.deepEqual(validResult(result),[],'result for group size '+size);assert.equal(films.length,sample.filmIds.length);assert.ok(films.every(f=>f.liveInput==='same'&&f.submitStatus==='would_write'));
  assert.deepEqual(calls.map(c=>c.callId),calls.map((c,i)=>i),'one global callId sequence in call order');assert.ok(films.every(f=>calls.find(c=>c.callId===f.callId).kind==='submit'),'every film names its submit call');
  assert.equal(calls.filter(c=>c.kind==='submit').length,Math.ceil(sample.filmIds.length/size));assert.equal(calls.filter(c=>c.kind==='preflight').length,Math.ceil(sample.filmIds.length/size),'one preflight per group, counted as an MCP call');assert.ok(calls.every(c=>c.itemCount<=size));
  results.push(result);
 }
 assert.equal(starts.length,1,'one start in total across all ten passes (ADR 0122 decision 10)');assert.ok(submits.length>=10);
 assert.equal(new Set(results.map(r=>r.manifestHash)).size,1,'one frozen manifest for all ten passes');assert.equal(results[0].manifestHash,sample.manifestHash);
 assert.ok(validResult({...results[0],groupSize:11}).length&&validResult({...results[0],telemetry:{...results[0].telemetry,extra:1}}).length&&validResult({...results[0],films:[]}).length,'the result schema rejects bad records');
 const noEpoch=await w.call('prediction_batch_submit',{runId:'dry-run',epoch:0,dryRun:true,items:[{filmId:frozen0.films[0].filmId,prediction:w.prediction}]});assert.equal(noEpoch.isError,true);
 assert.equal(snapshot(w),before,'the freeze start and all ten passes wrote nothing to D1 or R2');
 assert.equal(sql(w.file,'SELECT COUNT(*) AS n FROM prediction_pointer')[0].n,0);
}

// 5b. The scheduled loop through the real MCP tools: generationSize=1 accumulate → submitBatchSize=5 flush (AIR-463), per-film failures do not stop the run, a lost answer is replayed, then a normal manifest_spent complete while ready films remain.
{
 const w=await world(130);
 const start=await w.call('prediction_batch_start',{trigger:'scheduled',manifestSize:5});assert.ok(!start.isError,JSON.stringify(start.data).slice(0,200));
 const manifest=start.data;assert.equal(manifest.films.length,5,'the template selects five films');assert.equal(manifest.manifestSize,5);assert.equal(manifest.filmsSelected,5);
 const runId=manifest.runId;let epoch=manifest.lease.epoch;
 assert.equal((await w.call('prediction_batch_start',{trigger:'scheduled',manifestSize:5})).data.status,'already_running','a second start never adopts the run');
 const ids=manifest.films.map(f=>f.filmId),badParse=ids[1],badContent=ids[3];
 const itemFor=id=>id===badParse?{filmId:id,failure:{kind:'parse_error'}}:id===badContent?{filmId:id,fingerprint:w.fingerprint,prediction:{...w.prediction,predictedRating:99}}:{filmId:id,fingerprint:w.fingerprint,prediction:w.prediction};
 const generationSize=1,submitBatchSize=5,seen={};let flushes=0,preflights=0,flagged=[],buffer=[],submitItems=null;
 for(let i=0;i<ids.length;i+=generationSize){
  for(const id of ids.slice(i,i+generationSize))buffer.push(itemFor(id));
  const flush=buffer.length>=submitBatchSize||i+generationSize>=ids.length;
  if(!flush)continue;
  let items=buffer;buffer=[];flushes++;
  const candidates=items.filter(it=>!it.failure);
  if(candidates.length){const pre=await w.call('prediction_batch_validate',{items:candidates});preflights++;assert.ok(!pre.isError,JSON.stringify(pre.data).slice(0,200));
   for(const res of pre.data.results)if(!res.valid){flagged.push([res.filmId,res.prediction.issues.concat(res.fingerprint.issues).map(x=>x.path+' '+x.code)]);items=items.map(it=>it.filmId===res.filmId?{filmId:res.filmId,failure:{kind:'parse_error'}}:it);}}
  const r=await w.call('prediction_batch_submit',{runId,epoch,items});assert.ok(!r.isError,JSON.stringify(r.data).slice(0,200));
  if(flushes===1){submitItems=items;const again=await w.call('prediction_batch_submit',{runId,epoch,items});assert.ok(again.data.results.every(x=>x.replayed===true),'replay by the same body');}
  for(const x of r.data.results)seen[x.status]=(seen[x.status]||0)+1;
  epoch=r.data.epoch||epoch;
 }
 assert.equal(flushes,1,'one flush after accumulating five generationSize=1 films');assert.equal(submitItems.length,5);
 assert.equal(seen.created,3);assert.equal(seen.validation_failure,2,'two failure items did not stop the run');
 assert.deepEqual(flagged,[[badContent,['prediction.predictedRating out_of_range']]],'the preflight caught the bad candidate before any submit, with its issue');assert.equal(preflights,1,'one preflight per flush');
 const refused=await w.call('prediction_complete',{runId});assert.equal(refused.isError,true);assert.match(JSON.stringify(refused.data),/Queue not empty/,'a reasonless complete is refused while ready films remain');
 const done=await w.call('prediction_complete',{runId,reason:'manifest_spent'});assert.ok(!done.isError,JSON.stringify(done.data).slice(0,300));
 // AIR-463 / ADR 0136: spending the selected manifest is a normal complete, not a partial time_budget stop.
 assert.equal(done.data.status,'complete');assert.equal(done.data.stopReason,'manifest_spent');assert.ok(done.data.title!=='Прогнозы приостановлены');
 assert.ok((done.data.hotRemaining||0)+(done.data.coldRemaining||0)>0,'global outstanding remains after a short run');
 const eventKeys=()=>[...w.records.entries()].filter(([k,v])=>k.startsWith('events/items/')&&v?.id==='enrichment-'+runId);
 assert.equal(eventKeys().length,1,'exactly one persisted completion Event');
 const again=await w.call('prediction_complete',{runId,reason:'manifest_spent'});assert.ok(!again.isError);assert.equal(again.data.stopReason,'manifest_spent');
 assert.equal(eventKeys().length,1,'replay does not create a second Event key');
 const stopRec=w.records.get('enrichment/stop-events/'+runId+'.json');assert.ok(!stopRec||stopRec.event?.stage!=='partial','no false paused stop Event');
 assert.equal(sql(w.file,'SELECT COUNT(*) AS n FROM prediction_pointer')[0].n,3,'all valid films were written');
}

// 5c. A profile that moves between passes: following the dry-run prompt (step 7) a pass compares the answer's profile hash with the manifest's, stops with profile_moved and marks the rest not_submitted;
// the aggregator excludes the stale films from every metric. Writes are allowed here: the profile move itself is the test's setup, outside the dry run.
{
 const w=await world(20);const fz=(await w.call('prediction_batch_start',{trigger:'manual',dryRun:true})).data,ids=fz.films.map(f=>f.filmId).slice(0,6);
 const pinned=(await w.call('prediction_batch_start',{trigger:'manual',dryRun:true,pin:{filmIds:ids}})).data,m=pinned;
 const runPass=async size=>{
  const films=[],calls=[];let g=0,stopped=null;
  for(let i=0;i<m.films.length;i+=size,g++){
   const group=m.films.slice(i,i+size);
   if(stopped){for(const f of group)films.push({filmId:f.filmId,plan:f.plan,groupIndex:g,callId:null,fingerprint:null,prediction:null,submitStatus:'not_submitted',liveInput:'unknown',validation:null,generationMs:null});continue;}
   const items=group.map(f=>({filmId:f.filmId,fingerprint:w.fingerprint,prediction:w.prediction,inputHash:f.inputHash}));
   const r=await w.call('prediction_batch_submit',{runId:'dry-run',epoch:1,dryRun:true,manifestHash:m.manifestHash,items});assert.ok(!r.isError);
   const observed=hex(r.data.profile.hash);calls.push({callId:g,groupIndex:g,itemCount:items.length,bodyBytes:null,toolMs:null,ok:true,observedProfileHash:observed});
   for(const [k,res] of r.data.results.entries())films.push({filmId:res.filmId,plan:group[k].plan,groupIndex:g,callId:g,fingerprint:items[k].fingerprint,prediction:items[k].prediction,submitStatus:res.status,liveInput:res.liveInput,validation:null,generationMs:null});
   if(observed!==hex(m.profile.hash))stopped='profile_moved';
  }
  return {schemaVersion:1,sampleId:'fixture-sample-2',groupSize:size,promptSha256:sha(dry),manifestHash:m.manifestHash,profile:{version:m.profile.version,hash:hex(m.profile.hash)},contract:{fingerprintSchemaVersion:m.contract.fingerprintSchemaVersion,fingerprintPromptVersion:m.contract.fingerprintPromptVersion,predictionPromptVersion:m.contract.predictionPromptVersion,registryDigest:hex(m.contract.registryDigest)},stoppedReason:stopped,films,calls,telemetry:{model:null,tokens:null,quota:null,wallMs:null,unavailable:['model','tokens','quota','wallMs','generationMs','toolMs','bodyBytes']}};
 };
 const p1=await runPass(1);assert.equal(p1.stoppedReason,null);
 const next={version:2,profileHash:'p2',profile:{ratingScale:'Half stars',changed:true}};w.records.set('enrichment/profile/versions/2.json',next);await PredictionD1.saveMutable(w.env,'enrichment/profile/current.json',next);
 const p2=await runPass(2);assert.equal(p2.stoppedReason,'profile_moved','the pass stops at the first answer that names another profile');
 assert.equal(p2.calls.length,1);assert.ok(p2.films.filter(f=>f.submitStatus==='not_submitted').length===m.films.length-2);assert.deepEqual(check(schema.$defs.result,p2),[]);
 const rep=buildReport([p1,p2]);assert.equal(rep.perSize[0].comparableFilms,m.films.length);assert.equal(rep.perSize[1].comparableFilms,0,'nothing of the stale pass is compared');assert.equal(rep.perSize[1].excluded.staleProfile,2);assert.equal(rep.perSize[1].stoppedReason,'profile_moved');assert.ok(rep.unknown.includes('profile_moved'));
}
console.log('scheduled-task-prompt-v2 ok');
