// AIR-442. The queue mutation of a step starts from the head `currentPredictionQueue` read (QUEUE_HEADS). With the prediction queue D1-authoritative the head is the D1 queue
// generation: a writer that commits between that read and the conditional write makes the write refuse (CAS), the retry reads the queue afresh from D1, applies the settlement to what
// the other writer left, and both survive; an unconflicted step reads the queue from D1 once, not twice. Real PredictionD1 adapter on a local sqlite D1 stand-in; no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
import * as PredictionD1 from '../src/prediction-d1.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-queue-head-'));
const state={queueReads:0,queueWrites:0};
const db=d1Standin(path.join(root,'queue.sqlite'),{onQuery:text=>{if(/FROM\s+prediction_queue\b/i.test(text))state.queueReads++;if(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+prediction_queue\b/i.test(text))state.queueWrites++;}});
for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority'])db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
const bucket=new MemoryBucket(),env={DB:db,BUCKET:bucket};

const capture={log:()=>{},info:()=>{},error:()=>{},warn:()=>{}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:capture,setTimeout,PredictionD1});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const f of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(f,'utf8').replace('export default','globalThis.worker='),ctx);
ctx.env=env;
const call=expression=>vm.runInContext(expression,ctx);
const versions=call('({s:FINGERPRINT_SCHEMA_VERSION,p:FINGERPRINT_PROMPT_VERSION,q:PREDICTION_PROMPT_VERSION})'),registry=(await call('fingerprintRegistryDigests()')).registry;

const report={runId:'p1'},profile={profileHash:'h',version:1};
const queueDocument=(extra={})=>({schemaVersion:3,pending:['tmdb_1','tmdb_2','tmdb_3'],hotPending:['tmdb_1','tmdb_2','tmdb_3'],coldPending:[],priority:{tmdb_1:{hot:true,rank:1},tmdb_2:{hot:true,rank:1},tmdb_3:{hot:true,rank:1}},work:{},retries:{},priorityCount:3,coldRemaining:0,urgentCount:0,coldWithoutPrediction:0,hotPredicted:0,programmeRunId:'p1',profileHash:'h',profileVersion:1,fingerprintSchemaVersion:versions.s,fingerprintPromptVersion:versions.p,predictionPromptVersion:versions.q,fingerprintCompatibility:{registryDigest:registry},metrics:{hotProcessedTotal:0},trigger:'seed',...extra});
// Import and activate once; every scenario below writes through the adapter, as the Worker does.
await PredictionD1.importPredictionDomain(db,bucket,{queue:queueDocument()});
await PredictionD1.activatePredictionDomain(db,{generation:0,queueGeneration:0,profileGeneration:0});
assert.equal((await PredictionD1.openQueue(env)).mode,'d1','the queue is D1-authoritative');

const settle=ids=>call('(async()=>{const context=await advanceContext(env,'+JSON.stringify(report)+','+JSON.stringify(profile)+');return guardedSettle(context,'+JSON.stringify(ids)+",'batch_progress');})()");
const readSeeded=async()=>{const stored=await call('currentPredictionQueue(env,'+JSON.stringify(report)+','+JSON.stringify(profile)+",'batch_progress')");ctx.stored=stored;return stored;};

// 1. No conflict: the step reads the queue from D1 once (currentPredictionQueue) and its seeded mutation reads nothing more.
{
 state.queueReads=0;
 const stored=await readSeeded();assert.ok(call('QUEUE_HEADS.has(stored)'),'the head of the queue just read is registered for the mutation');
 const afterRead=state.queueReads;assert.ok(afterRead>=1);
 ctx.apply=await settle(['tmdb_1']);
 const next=await call("mutatePredictionQueue(env,apply,'batch_progress',stored)");
 assert.equal(state.queueReads,afterRead,'the seeded mutation did not read the queue again');
 assert.ok(!next.pending.includes('tmdb_1')&&next.priorityCount===2,'the film is settled');
 const stored2=(await PredictionD1.openQueue(env)).queue;assert.ok(!stored2.pending.includes('tmdb_1'),'and the settlement is what D1 holds');
}

// 2. A writer commits between the step's read and its conditional write: the write is refused on the D1 queue generation, the retry reads D1 afresh, applies the settlement to
//    what the other writer left, and both survive. The head the step started from is not used a second time.
{
 const stored=await readSeeded();const readsBefore=state.queueReads;
 const other=await PredictionD1.openQueue(env);
 const written=await PredictionD1.writeQueue(env,other,{...other.queue,retries:{...other.queue.retries,tmdb_9:{kind:'parse_error',retryable:true,attempts:1,retryAt:Date.now()+3600000,failedAt:new Date().toISOString(),lastRunId:'another-run'}},trigger:'resolver_checkpoint'});
 assert.notEqual(written,null,'the other writer committed');
 const generationAfterOther=(await PredictionD1.openQueue(env)).queueGeneration;
 ctx.stored=stored;ctx.apply=await settle(['tmdb_2']);
 const next=await call("mutatePredictionQueue(env,apply,'batch_progress',stored)");
 assert.ok(!next.pending.includes('tmdb_2'),'the settlement was applied');
 assert.ok(next.retries.tmdb_9,'the other writer\'s record survived');
 const final=(await PredictionD1.openQueue(env));
 assert.ok(final.queue.retries.tmdb_9&&!final.queue.pending.includes('tmdb_2'),'D1 holds both');
 assert.ok(final.queueGeneration>generationAfterOther,'one more commit, on top of the other writer\'s');
 assert.ok(state.queueReads>readsBefore,'the retry read the queue afresh from D1');
}

// 3. A queue rebuilt for another programme between the read and the write: the gate inside the write refuses the settlement and the new generation is left as it is.
{
 const stored=await readSeeded();
 const other=await PredictionD1.openQueue(env);
 await PredictionD1.writeQueue(env,other,queueDocument({programmeRunId:'p2',pending:['tmdb_1','tmdb_2','tmdb_3'],hotPending:['tmdb_1','tmdb_2','tmdb_3'],trigger:'programme_updated',advancedAt:undefined}));
 ctx.stored=stored;ctx.apply=await settle(['tmdb_3']);
 const next=await call("mutatePredictionQueue(env,apply,'batch_progress',stored)");
 assert.equal(next.programmeRunId,'p2','the newer generation is what came back');
 assert.ok(next.pending.includes('tmdb_3'),'the old settlement did not touch it');
 const final=(await PredictionD1.openQueue(env)).queue;assert.equal(final.programmeRunId,'p2');assert.ok(final.pending.includes('tmdb_3'));assert.equal(final.trigger,'programme_updated');
}

// 4. The same mutation without a seed reads the queue itself (no seed, no registered head): the seed only saves the read, never changes the result.
{
 await PredictionD1.writeQueue(env,await PredictionD1.openQueue(env),queueDocument());
 const readsBefore=state.queueReads;
 ctx.apply=await settle(['tmdb_1']);
 const next=await call("mutatePredictionQueue(env,apply,'batch_progress')");
 assert.ok(state.queueReads>readsBefore,'an unseeded mutation reads the queue');assert.ok(!next.pending.includes('tmdb_1'));
}

console.log('prediction queue head seed on the D1 adapter tests passed');
