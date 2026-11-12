// AIR-449: the proposed Predictions batch runner v2 Scheduled Task prompt. The file is documentation only (no live Task exists), so this test keeps three things honest:
// the stated length and SHA-256, the tool names the text mentions (they must be real MCP tools, and the forbidden ones must stay forbidden), and a simulated client run that follows the
// prompt's loop on the real Worker code with a fake generator (no model, no network, no Scheduled Task).
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {flowWorld} from './prediction-d1-flow-lib.mjs';

const file='docs/reference/scheduled-task-prompts/hourly-predictions-batch-v2.md';
const doc=fs.readFileSync(file,'utf8');
const m=doc.match(/---BEGIN PROMPT---\n([\s\S]*)\n---END PROMPT---/);
assert.ok(m,'prompt markers present');
const prompt=m[1];

// 1. Header matches the text.
const stated=doc.match(/\*\*Text below:\*\* (\d+) characters, SHA-256 `([0-9a-f]{64})`/);
assert.ok(stated,'header states length and hash');
assert.equal(prompt.length,Number(stated[1]),'stated character count');
assert.equal(createHash('sha256').update(prompt).digest('hex'),stated[2],'stated SHA-256');

// 2. Tool names: every tool the prompt tells the Task to call exists; the forbidden ones are in the FORBIDDEN list and are not instructed anywhere else.
const mcp=fs.readFileSync('src/mcp.js','utf8');
const tools=new Set([...mcp.matchAll(/\{name:'([a-z_]+)',title:/g)].map(x=>x[1]));
const FORBIDDEN=['prediction_start','prediction_next','prediction_submit','prediction_validate','epg_sync_start','epg_sync_step','ratings_sync_start','ratings_sync_step'];
const forbiddenLine=prompt.split('\n').find(l=>l.startsWith('ЗАПРЕЩЕНО:'));
assert.ok(forbiddenLine,'forbidden list present');
for(const t of FORBIDDEN){assert.ok(tools.has(t),t+' is a real tool');assert.ok(forbiddenLine.includes(t),t+' is forbidden');}
const allowed=new Set(['prediction_batch_start','prediction_batch_submit','prediction_heartbeat','prediction_complete','enrichment_runner','enrichment_status','enrichment_queue']);
const called=new Set([...prompt.matchAll(/\b((?:prediction|enrichment|epg|ratings)_[a-z_]+)\(/g)].map(x=>x[1])); // a call written as name(...)
for(const t of called){assert.ok(tools.has(t),t+' called in the prompt must be a real MCP tool');assert.ok(allowed.has(t),t+' is not part of the v2 vocabulary');}
for(const t of ['enrichment_runner','enrichment_status','enrichment_queue'])assert.ok(prompt.includes(t),t+' is read by the Task');
for(const t of allowed)assert.ok(tools.has(t),t+' exists');
assert.ok(!/dryRun\s*:\s*true/.test(prompt.replace(/ЗАПРЕЩЕНО:[^\n]*/,'')),'the scheduled prompt never dry-runs');
assert.ok(/НИКОГДА не изменяй собственный prompt/.test(prompt)&&/prediction_batch_start\(\{trigger:'scheduled'\}\) ровно один раз/.test(prompt));
// every allowed complete reason named in the prompt is accepted by the Worker
const enrich=fs.readFileSync('src/enrichment.js','utf8');
for(const reason of ['profile_changed','runner_aborted','quota','model_unavailable','model_error','api_error','storage_error','external_termination'])assert.ok(enrich.includes("'"+reason+"'"),reason+' is a Worker stop reason');
// the live prompt is untouched by this delivery
const live=fs.readFileSync('docs/reference/scheduled-task-prompts/hourly-predictions-only.md','utf8').match(/---BEGIN PROMPT---\n([\s\S]*)\n---END PROMPT---/)[1];
assert.equal(createHash('sha256').update(live).digest('hex'),'fc0b4c1772f33398b4cb4e2eafda6e71b89c260befbee363e299acae4a388d44','the live hourly prompt text is unchanged');

// 3. Simulated client run, following the prompt: one start, groups of at most 10, at most 100 films, per-film failures do not stop the run, a lost answer is replayed with the same body, then complete.
const w=await flowWorld({films:130});
assert.equal((await w.api('queue/reconcile',{})).status,200);
const started=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});
assert.equal(started.status,200,JSON.stringify(started.data).slice(0,200));
const manifest=started.data;assert.equal(manifest.films.length,100,'the manifest stops at 100 films');
const runId=manifest.runId;let epoch=manifest.lease.epoch;
const second=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});
assert.equal(second.data.status,'already_running','a second start never adopts the run');
const ids=manifest.films.map(f=>f.filmId),badParse=ids[13],badContent=ids[27];
const itemFor=id=>id===badParse?{filmId:id,failure:{kind:'parse_error'}}:id===badContent?{filmId:id,fingerprint:w.fingerprint,prediction:{...w.prediction,predictedRating:99}}:{filmId:id,fingerprint:w.fingerprint,prediction:w.prediction};
const seen={created:0,validation_failure:0},bodies=[];
for(let i=0;i<ids.length;i+=10){
 const items=ids.slice(i,i+10).map(itemFor);assert.ok(items.length<=10);bodies.push(items);
 let r=await w.api('batch/submit',{runId,epoch,items});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));
 if(i===30){ // the answer is lost: the same body again returns the committed films as replayed and writes nothing new
  const again=await w.api('batch/submit',{runId,epoch,items});assert.equal(again.status,200);assert.ok(again.data.results.every(x=>x.replayed===true),'replay by the same body');
 }
 for(const x of r.data.results)seen[x.status]=(seen[x.status]||0)+1;
 epoch=r.data.epoch||epoch;
}
assert.equal(seen.created,98);assert.equal(seen.validation_failure,2,'two failed films did not stop the run');
assert.equal(bodies.length,10,'ten groups for 100 films');
const refused=await w.api('complete',{runId});assert.equal(refused.status,409,'a reasonless complete is refused while ready films remain beyond the 100-film manifest');
const done=await w.api('complete',{runId,reason:'time_budget'});assert.equal(done.status,200,JSON.stringify(done.data).slice(0,200));
console.log('scheduled-task-prompt-v2 ok');
