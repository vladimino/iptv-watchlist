// AIR-450: isolation of the batch runner v2 dry run. Every dry-run RPC (start with and without pin, submit with every kind of item, mismatches and repeated trials) runs on the real Worker code
// while EVERY write is a fault: an R2 put or delete throws, and so does any D1 INSERT, UPDATE, DELETE, REPLACE, CREATE, DROP or ALTER, in a statement or in a batch. The test counts the attempts (none are allowed:
// the dry path must not even try to write), compares the whole D1 dump and every R2 object before and after, and does this beside a live run that holds the lease. Local stand-ins only; no model, no production.
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {flowWorld} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as PredictionD1 from '../src/prediction-d1.js';

const dump=f=>{const r=sqliteSync([f,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const snapshot=w=>JSON.stringify([[...w.records.entries()],dump(w.file)]);
const WRITE=/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

async function world(films){
 const w=await flowWorld({films});assert.equal((await w.api('queue/reconcile',{})).status,200);
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.call=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;const r=await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx);const res=r.result;return {isError:!!res.isError,data:res.isError?res.content[0].text:JSON.parse(res.content[0].text)};};
 return w;
}
// From here on any attempt to write is counted and fails.
function armWriteFaults(w){
 const faults={attempts:[]},env=w.env,fail=what=>{faults.attempts.push(what);throw new Error('WRITE_FAULT '+what);};
 env.BUCKET.put=async key=>fail('r2.put '+key);env.BUCKET.delete=async key=>fail('r2.delete '+key);
 const prepare=env.DB.prepare.bind(env.DB),batch=env.DB.batch.bind(env.DB);
 env.DB.prepare=sql=>{if(WRITE.test(sql))fail('d1 '+sql.slice(0,60));return prepare(sql);};
 env.DB.batch=async statements=>{for(const s of statements)if(WRITE.test(s.text||''))fail('d1 batch '+String(s.text).slice(0,60));return batch(statements);};
 return faults;
}
const MODEL_METADATA_KEYS=new Set(['id','letterboxdUri','tmdbUri','title','original','year','genres','synopsis','directors','actors','runtime']);

// Phase 1, with writes allowed: real state a dry run must not disturb. Three films get real current predictions, then a live run takes the lease and keeps it.
const w=await world(40);
const first=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.equal(first.status,200);
const predicted=first.data.films.slice(0,3).map(f=>f.filmId);
const sub=await w.api('batch/submit',{runId:first.data.runId,epoch:first.data.lease.epoch,items:predicted.map(id=>({filmId:id,fingerprint:w.fingerprint,prediction:w.prediction}))});assert.equal(sub.status,200);
assert.equal((await w.call('prediction_complete',{runId:first.data.runId,reason:'time_budget'})).isError,false);
const live=await w.call('prediction_batch_start',{trigger:'scheduled'});assert.equal(live.isError,false);assert.equal(live.data.status,'running','a live run holds the lease during every dry run below');
const liveFilms=live.data.films.map(f=>f.filmId);
for(const route of ['next','submit']){const r=await w.api(route,{runId:live.data.runId,items:[],batchSize:1});assert.equal(r.status,409);assert.equal(r.data.code,'wrong_protocol','the v5 '+route+' refuses a v2 run');}
assert.equal((await w.call('prediction_batch_start',{trigger:'scheduled'})).data.status,'already_running');
// the one frozen manifest, taken by a dry-run start (still allowed to run before the faults, it writes nothing anyway)
const freeze=await w.call('prediction_batch_start',{trigger:'manual',dryRun:true});assert.equal(freeze.isError,false,JSON.stringify(freeze.data).slice(0,200));
const frozen=freeze.data,frozenFilms=frozen.films.map(f=>f.filmId);

// The generator never sees an existing prediction or a rating: the manifest holds neither, and a film that already has a current prediction is not in it.
for(const id of predicted)assert.ok(!frozenFilms.includes(id),'a film with a current prediction is not part of the manifest');
const filmsText=JSON.stringify(frozen.films);assert.ok(!/predictedRating|probability4Plus|mainRisk|matchSignals|personalRating|userRating/.test(filmsText),'no prediction or rating field in any film of the manifest (the schema document describes the fields, the films hold none)');
for(const f of frozen.films)for(const k of Object.keys(f.modelMetadata))assert.ok(MODEL_METADATA_KEYS.has(k),'modelMetadata key '+k+' is on the allowlist (no rating, no prediction)');

// Phase 2: every write is now a fault.
const before=snapshot(w),faults=armWriteFaults(w);
const items=ids=>ids.map(id=>({filmId:id,fingerprint:w.fingerprint,prediction:w.prediction,inputHash:frozen.films.find(f=>f.filmId===id)?.inputHash}));
const dry=(args,extra={})=>w.call('prediction_batch_submit',{runId:'dry-run',epoch:1,dryRun:true,manifestHash:frozen.manifestHash,...extra,...args});
const pick=frozenFilms.slice(0,4);

// start: default, pinned (including a film that is current, an unknown id and the largest pin), repeated
const s1=await w.call('prediction_batch_start',{trigger:'manual',dryRun:true});assert.equal(s1.isError,false);assert.equal(s1.data.manifestHash,frozen.manifestHash,'a repeated dry start gives the same manifest');
const s2=await w.call('prediction_batch_start',{trigger:'manual',dryRun:true,pin:{filmIds:[pick[1],predicted[0],'tmdb_9999',pick[0]]}});assert.equal(s2.isError,false);
assert.deepEqual(s2.data.films.map(f=>f.filmId),[pick[1],pick[0]],'pinned order, only the eligible films');assert.deepEqual(s2.data.notEligible.map(x=>x.filmId).sort(),['tmdb_9999',predicted[0]].sort());assert.ok(s2.data.notEligible.every(x=>x.reason==='not_queued'));
const s3=await w.call('prediction_batch_start',{trigger:'manual',dryRun:true,pin:{filmIds:Array.from({length:100},(_,i)=>'tmdb_'+(i+1))}});assert.equal(s3.isError,false);
assert.equal((await w.call('prediction_batch_start',{trigger:'manual',dryRun:true,pin:{filmIds:[]}})).isError,true,'a bad pin is a refusal');

// submit: every kind of item, in one group and one by one, twice (a repeated trial answers the same and writes nothing)
const mixed=[...items(pick.slice(0,2)),{filmId:pick[2],fingerprint:w.fingerprint,prediction:{...w.prediction,predictedRating:99}},{filmId:pick[3],failure:{kind:'parse_error'}},{filmId:'tmdb_9999',fingerprint:w.fingerprint,prediction:w.prediction}];
const m1=await dry({items:mixed}),m2=await dry({items:mixed});
assert.equal(m1.isError,false,JSON.stringify(m1.data).slice(0,300));assert.deepEqual(m2.data,m1.data,'a repeated trial answers the same');
const by=Object.fromEntries(m1.data.results.map(x=>[x.filmId,x]));
assert.equal(by[pick[0]].status,'would_write');assert.equal(by[pick[2]].status,'validation_failure');assert.equal(by[pick[3]].status,'validation_failure');assert.equal(by.tmdb_9999.status,'not_eligible');
for(const id of pick.slice(0,2))assert.equal((await dry({items:items([id])})).data.results[0].status,'would_write');
{const r=(await dry({items:items([predicted[0]])})).data.results[0];assert.equal(r.status,'already_current');assert.equal(r.liveInput,'not_eligible','a film that already has a current prediction is reported as current and never regenerated');}
// ADR 0132: a dry run with an assessment validates it and reports what a real submit would do, while every write stays a fault (the same isolation as above).
{
 const a={assessmentVersion:1,ratingBasis:'basis',probability4PlusBasis:'basis',tasteSignals:[],risks:[],uncertainties:[],research:{status:'not_attempted'},sources:[],conflicts:[],model:{status:'unavailable'}};
 const withA=(ids,x=a)=>items(ids).map(i=>({...i,assessment:x}));
 const r=await dry({items:[...withA([pick[0]]),...withA([predicted[0]]),...withA([pick[1]],{...a,extra:1})]});assert.equal(r.isError,false,JSON.stringify(r.data).slice(0,300));
 const got=r.data.results.map(x=>[x.status,x.assessment]);
 assert.equal(JSON.stringify(got),JSON.stringify([['would_write','would_write'],['already_current','not_applicable'],['validation_failure','not_applicable']]));
 assert.equal(r.data.results[2].validation.stage,'assessment_schema');assert.equal(JSON.stringify(r.data.results[2].validation.issues),JSON.stringify([{path:'assessment.extra',code:'unknown_field'}]));
 assert.equal(JSON.stringify((await dry({items:withA([pick[0]])})).data),JSON.stringify((await dry({items:withA([pick[0]])})).data),'a repeated trial answers the same');
}
// mismatches: another manifest hash, a changed contract, a malformed hash, no runId, epoch 0
const other=await dry({items:items([pick[0]]),manifestHash:'f'.repeat(64)});assert.equal(other.isError,false);
assert.equal((await dry({items:items([pick[0]]),manifestHash:'xyz'})).isError,true);
const stale=await dry({items:items([pick[0]]),contract:{fingerprintSchemaVersion:frozen.contract.fingerprintSchemaVersion+1,fingerprintPromptVersion:frozen.contract.fingerprintPromptVersion,predictionPromptVersion:frozen.contract.predictionPromptVersion,registryDigest:frozen.contract.registryDigest}});assert.equal(stale.isError,true);assert.match(JSON.stringify(stale.data),/contract_changed/,'a changed contract is refused (409) and writes nothing');
assert.equal((await w.call('prediction_batch_submit',{dryRun:true,manifestHash:frozen.manifestHash,items:items([pick[0]])})).isError,true);
assert.equal((await dry({epoch:0,items:items([pick[0]])})).isError,true);
assert.equal((await dry({items:Array.from({length:11},(_,i)=>({filmId:'f'+i,prediction:w.prediction}))})).isError,true);
// the live run is untouched and still owns the lease
// the live run is untouched and still owns the lease (checked in phase 1: a real start records its own attempt, which is a write)

assert.deepEqual(faults.attempts,[],'the dry run never even tried to write');
assert.equal(snapshot(w),before,'every D1 table and every R2 object is byte for byte unchanged');
assert.ok(liveFilms.length>0);

// Phase 3: a profile mismatch. The profile moves after the freeze; the dry run reports it safely and still writes nothing.
{
 const v=await world(20);
 const fz=(await v.call('prediction_batch_start',{trigger:'manual',dryRun:true})).data,ids=fz.films.map(f=>f.filmId).slice(0,3);
 const next={version:2,profileHash:'p2',profile:{ratingScale:'Half stars',changed:true}};
 v.records.set('enrichment/profile/versions/2.json',next);await PredictionD1.saveMutable(v.env,'enrichment/profile/current.json',next);
 const baseline=snapshot(v),f=armWriteFaults(v);
 const sub=await v.call('prediction_batch_submit',{runId:'dry-run',epoch:1,dryRun:true,manifestHash:fz.manifestHash,items:ids.map(id=>({filmId:id,fingerprint:v.fingerprint,prediction:v.prediction,inputHash:fz.films.find(x=>x.filmId===id).inputHash}))});
 assert.equal(sub.isError,false,JSON.stringify(sub.data).slice(0,300));assert.equal(sub.data.dryRun,true);assert.notEqual(sub.data.profile.hash,fz.profile.hash,'the answer names the moved profile');
 assert.ok(sub.data.results.every(r=>r.status==='would_write'&&r.liveInput==='same'),'liveInput compares the film inputs; the moved profile is visible in the answer profile, which a pass compares with the manifest profile (runbook)');
 const again=await v.call('prediction_batch_start',{trigger:'manual',dryRun:true});assert.ok(again.isError||again.data.dryRun===true);
 assert.deepEqual(f.attempts,[]);assert.equal(snapshot(v),baseline,'a profile mismatch writes nothing either');
}

// Phase 4: the production surface is unchanged. The v5 tools never accept a dry-run argument, the runner contract still says pipeline 5 without model batching, and the dry run needs the batch tools.
{
 const tools=vm.runInContext('MCP_TOOLS',w.ctx),named=n=>tools.find(t=>t.name===n);
 for(const n of ['prediction_start','prediction_next','prediction_submit','prediction_heartbeat','prediction_complete','prediction_validate']){const p=named(n).inputSchema.properties||{};assert.ok(!('dryRun' in p)&&!('pin' in p)&&!('manifestHash' in p),n+' has no dry-run argument');}
 assert.deepEqual(Object.keys(named('prediction_batch_start').inputSchema.properties).sort(),['capacity','dryRun','pin','trigger']);
 const contract=vm.runInContext('predictionRunnerContract()',w.ctx);assert.equal(contract.pipelineVersion,5);assert.equal(contract.modelBatching.enabled,false);assert.equal(contract.modelBatching.readyFingerprintsPerCall,1);
}
console.log('prediction-dry-run-isolation ok');
