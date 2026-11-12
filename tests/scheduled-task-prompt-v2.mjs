// AIR-449: the proposed Predictions batch runner v2 Scheduled Task prompt, its dry-run prompt and the A/B contract. The files are documentation only (no live Task exists), so this test keeps honest:
// the stated lengths and SHA-256, the tool names the texts mention, the generation steps shared byte for byte by both prompts, the exact MCP calls (through the real MCP tool handler, offline),
// the sample/result schema, the dry-run write freeze over group sizes 1 to 10, and the real partial-stop semantics of the bounded run. No model, network, production or Scheduled Task is involved.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

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

// 3. Tool names: every call the texts write exists and stays inside its vocabulary; the forbidden lists stay forbidden.
const mcp=fs.readFileSync('src/mcp.js','utf8');
const tools=new Set([...mcp.matchAll(/\{name:'([a-z_]+)',title:/g)].map(x=>x[1]));
const calls=text=>new Set([...text.matchAll(/\b((?:prediction|enrichment|epg|ratings)_[a-z_]+)\(/g)].map(x=>x[1]));
const forbiddenOf=text=>text.split('\n').find(l=>l.startsWith('ЗАПРЕЩЕНО:'));
const SCHEDULED_ALLOWED=new Set(['prediction_batch_start','prediction_batch_submit','prediction_heartbeat','prediction_complete']),DRY_ALLOWED=new Set(['prediction_batch_start','prediction_batch_submit']);
for(const [text,allowed,forbidden] of [[prompt,SCHEDULED_ALLOWED,['prediction_start','prediction_next','prediction_submit','prediction_validate','epg_sync_start','epg_sync_step','ratings_sync_start','ratings_sync_step']],[dry,DRY_ALLOWED,['prediction_start','prediction_next','prediction_submit','prediction_validate','prediction_heartbeat','prediction_complete','epg_sync_start','epg_sync_step','ratings_sync_start','ratings_sync_step']]]){
 const line=forbiddenOf(text);assert.ok(line,'forbidden list present');
 for(const t of forbidden){assert.ok(tools.has(t),t+' is a real tool');assert.ok(line.includes(t),t+' is forbidden');}
 for(const t of calls(text)){if(forbidden.includes(t)&&line.includes(t)&&!text.replace(line,'').includes(t+'('))continue;assert.ok(tools.has(t),t+' is a real MCP tool');assert.ok(allowed.has(t),t+' is outside the vocabulary');}
 for(const t of allowed)assert.ok(tools.has(t));
}
assert.ok(!/dryRun\s*:\s*true/.test(prompt.replace(forbiddenOf(prompt),'')),'the scheduled prompt never dry-runs');
assert.ok(dry.includes("prediction_batch_start({trigger:'manual',dryRun:true,pin:{filmIds:FILM_IDS}})")&&dry.includes("prediction_batch_submit({runId:'dry-run',epoch:1,dryRun:true,manifestHash,items})"),'the dry-run calls are the exact tested ones');
assert.ok(/\{\{SAMPLE_ID\}\}/.test(dry)&&/\{\{FILM_IDS\}\}/.test(dry)&&/\{\{GROUP_SIZE\}\}/.test(dry));
const enrich=fs.readFileSync('src/enrichment.js','utf8');
for(const reason of ['profile_changed','runner_aborted','quota','model_unavailable','model_error','api_error','storage_error','external_termination','time_budget'])assert.ok(enrich.includes("'"+reason+"'"),reason+' is a Worker stop reason');
const live=fs.readFileSync('docs/reference/scheduled-task-prompts/hourly-predictions-only.md','utf8').match(/---BEGIN PROMPT---\n([\s\S]*)\n---END PROMPT---/)[1];
assert.equal(sha(live),'fc0b4c1772f33398b4cb4e2eafda6e71b89c260befbee363e299acae4a388d44','the live hourly prompt text is unchanged');
assert.ok(!/trello\.com\/c\/[\s;)]/.test(doc),'no empty Trello link');

// 4. A small JSON Schema checker (the subset the contract uses) validates the sample and result records.
const schema=JSON.parse(fs.readFileSync('docs/reference/scheduled-task-prompts/batch-v2-ab.schema.json','utf8'));
const typeOf=v=>v===null?'null':Array.isArray(v)?'array':Number.isInteger(v)?'integer':typeof v;
function check(s,v,path='$'){
 const errors=[];const types=s.type===undefined?null:[].concat(s.type);
 if(s.const!==undefined&&v!==s.const)errors.push(path+' const');
 if(s.enum&&!s.enum.includes(v))errors.push(path+' enum');
 if(types&&!types.some(t=>t==='number'?typeof v==='number':typeOf(v)===t))return [path+' type '+typeOf(v)];
 if(typeof v==='number'){if(s.minimum!==undefined&&v<s.minimum)errors.push(path+' minimum');if(s.maximum!==undefined&&v>s.maximum)errors.push(path+' maximum');}
 if(typeof v==='string'){if(s.minLength!==undefined&&v.length<s.minLength)errors.push(path+' minLength');if(s.maxLength!==undefined&&v.length>s.maxLength)errors.push(path+' maxLength');if(s.pattern&&!new RegExp(s.pattern).test(v))errors.push(path+' pattern');}
 if(Array.isArray(v)){if(s.minItems!==undefined&&v.length<s.minItems)errors.push(path+' minItems');if(s.maxItems!==undefined&&v.length>s.maxItems)errors.push(path+' maxItems');if(s.uniqueItems&&new Set(v.map(x=>JSON.stringify(x))).size!==v.length)errors.push(path+' uniqueItems');if(s.items)v.forEach((x,i)=>errors.push(...check(s.items,x,path+'['+i+']')));}
 if(v&&typeof v==='object'&&!Array.isArray(v)){for(const k of s.required||[])if(!(k in v))errors.push(path+' missing '+k);for(const [k,x] of Object.entries(v)){if(s.properties?.[k])errors.push(...check(s.properties[k],x,path+'.'+k));else if(s.additionalProperties===false)errors.push(path+' extra '+k);}}
 return errors;
}
const validSample=x=>check(schema.$defs.sample,x),validResult=x=>check(schema.$defs.result,x);

// 5. The real MCP tool handler over the real Worker code, with a fresh world.
async function world(films){
 const w=await flowWorld({films});assert.equal((await w.api('queue/reconcile',{})).status,200);
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.call=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;const r=await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx);const res=r.result;return {isError:!!res.isError,data:res.isError?res.content[0].text:JSON.parse(res.content[0].text)};};
 return w;
}
const dump=f=>{const r=sqliteSync([f,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const snapshot=w=>JSON.stringify([[...w.records.entries()],dump(w.file)]);

// 5a. Dry run: the MCP schema needs a non-empty runId and a positive epoch even for a dry-run submit; the fixed synthetic pair satisfies it; nothing is written over a start and all ten group sizes.
{
 const w=await world(30);
 const sample={schemaVersion:1,sampleId:'fixture-sample-1',filmIds:['tmdb_3','tmdb_1','tmdb_12','tmdb_7','tmdb_9','tmdb_20','tmdb_5','tmdb_14','tmdb_2','tmdb_25','tmdb_8','tmdb_30'],frozenAt:'2026-11-12T00:00:00Z',source:'offline fixture'};
 assert.deepEqual(validSample(sample),[]);assert.ok(validSample({...sample,filmIds:['a','a']}).length,'duplicate ids rejected');assert.ok(validSample({...sample,extra:1}).length);
 const before=snapshot(w);
 const start=await w.call('prediction_batch_start',{trigger:'manual',dryRun:true,pin:{filmIds:sample.filmIds}});
 assert.ok(!start.isError,JSON.stringify(start.data).slice(0,200));const m=start.data;
 assert.equal(m.dryRun,true);assert.equal(m.runId,null);assert.deepEqual(m.films.map(f=>f.filmId),sample.filmIds,'pinned order');
 const missing=await w.call('prediction_batch_submit',{dryRun:true,manifestHash:m.manifestHash,items:[{filmId:m.films[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});
 assert.equal(missing.isError,true,'a dry-run submit without runId fails the MCP schema, as the review found');
 const noEpoch=await w.call('prediction_batch_submit',{runId:'dry-run',epoch:0,dryRun:true,items:[{filmId:m.films[0].filmId,prediction:w.prediction}]});assert.equal(noEpoch.isError,true);
 const results=[];
 for(let size=1;size<=10;size++){
  const films=[],calls=[];let g=0;
  for(let i=0;i<m.films.length;i+=size,g++){
   const group=m.films.slice(i,i+size),items=group.map(f=>({filmId:f.filmId,...(f.plan==='fingerprint_and_prediction'?{fingerprint:w.fingerprint}:{}),prediction:w.prediction,inputHash:f.inputHash}));
   const r=await w.call('prediction_batch_submit',{runId:'dry-run',epoch:1,dryRun:true,manifestHash:m.manifestHash,items});
   assert.ok(!r.isError,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.status,'dry_run');assert.equal(r.data.manifestHash,m.manifestHash,'the held manifest identity');
   calls.push({groupIndex:g,itemCount:items.length,bodyBytes:new TextEncoder().encode(JSON.stringify(items)).length,toolMs:null,ok:true});
   for(const [k,x] of r.data.results.entries())films.push({filmId:x.filmId,plan:group[k].plan,groupIndex:g,fingerprint:items[k].fingerprint??null,prediction:items[k].prediction,submitStatus:x.status,liveInput:x.liveInput,validation:x.validation||null,generationMs:null});
  }
  const result={schemaVersion:1,sampleId:sample.sampleId,groupSize:size,promptSha256:sha(dry),manifestHash:m.manifestHash,profile:{version:m.profile.version,hash:m.profile.hash},contract:{fingerprintSchemaVersion:m.contract.fingerprintSchemaVersion,fingerprintPromptVersion:m.contract.fingerprintPromptVersion,predictionPromptVersion:m.contract.predictionPromptVersion,registryDigest:m.contract.registryDigest},films,calls,telemetry:{model:null,tokens:null,quota:null,wallMs:null,unavailable:['model','tokens','quota','wallMs','generationMs','toolMs']}};
  assert.deepEqual(validResult(result),[],'result for group size '+size);assert.equal(films.length,sample.filmIds.length);assert.ok(films.every(f=>f.liveInput==='same'&&f.submitStatus==='would_write'));
  assert.equal(calls.length,Math.ceil(sample.filmIds.length/size));assert.ok(calls.every(c=>c.itemCount<=size));
  results.push(result);
 }
 assert.equal(new Set(results.map(r=>r.manifestHash)).size,1,'one frozen manifest for all ten passes');
 assert.ok(validResult({...results[0],groupSize:11}).length&&validResult({...results[0],telemetry:{...results[0].telemetry,extra:1}}).length&&validResult({...results[0],films:[]}).length,'the result schema rejects bad records');
 assert.equal(snapshot(w),before,'the dry run (start and all ten group sizes) wrote nothing to D1 or R2');
 assert.equal(sql(w.file,'SELECT COUNT(*) AS n FROM prediction_pointer')[0].n,0);
}

// 5b. The scheduled loop through the real MCP tools: one start, groups of at most 10, 100 films at most, per-film failures do not stop the run, a lost answer is replayed, then the bounded stop.
{
 const w=await world(130);
 const start=await w.call('prediction_batch_start',{trigger:'scheduled'});assert.ok(!start.isError,JSON.stringify(start.data).slice(0,200));
 const manifest=start.data;assert.equal(manifest.films.length,100,'the manifest stops at 100 films');
 const runId=manifest.runId;let epoch=manifest.lease.epoch;
 assert.equal((await w.call('prediction_batch_start',{trigger:'scheduled'})).data.status,'already_running','a second start never adopts the run');
 const ids=manifest.films.map(f=>f.filmId),badParse=ids[13],badContent=ids[27];
 const itemFor=id=>id===badParse?{filmId:id,failure:{kind:'parse_error'}}:id===badContent?{filmId:id,fingerprint:w.fingerprint,prediction:{...w.prediction,predictedRating:99}}:{filmId:id,fingerprint:w.fingerprint,prediction:w.prediction};
 const seen={};let groups=0;
 for(let i=0;i<ids.length;i+=10){
  const items=ids.slice(i,i+10).map(itemFor);groups++;
  const r=await w.call('prediction_batch_submit',{runId,epoch,items});assert.ok(!r.isError,JSON.stringify(r.data).slice(0,200));
  if(i===30){const again=await w.call('prediction_batch_submit',{runId,epoch,items});assert.ok(again.data.results.every(x=>x.replayed===true),'replay by the same body');}
  for(const x of r.data.results)seen[x.status]=(seen[x.status]||0)+1;
  epoch=r.data.epoch||epoch;
 }
 assert.equal(groups,10);assert.equal(seen.created,98);assert.equal(seen.validation_failure,2,'two failed films did not stop the run');
 const refused=await w.call('prediction_complete',{runId});assert.equal(refused.isError,true);assert.match(JSON.stringify(refused.data),/Queue not empty/,'a reasonless complete is refused while ready films remain');
 const done=await w.call('prediction_complete',{runId,reason:'time_budget'});assert.ok(!done.isError,JSON.stringify(done.data).slice(0,300));
 // The unavoidable current behaviour the owner must decide on: the bounded stop is a partial stop with a stop Event, although every selected film was written.
 assert.equal(done.data.status,'partial');assert.equal(done.data.stopReason,'time_budget');assert.equal(done.data.title,'Прогнозы приостановлены');
 const event=w.records.get('enrichment/stop-events/'+runId+'.json')?.event;assert.ok(event,'a stop Event is recorded');assert.equal(event.stage,'partial');assert.equal(event.title,'Прогнозы приостановлены');assert.equal(event.stopReason,'time_budget');
 assert.equal(sql(w.file,'SELECT COUNT(*) AS n FROM prediction_pointer')[0].n,98,'all valid films were written');
}
console.log('scheduled-task-prompt-v2 ok');
