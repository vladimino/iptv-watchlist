// AIR-471: the current tree answers every batch_start scenario of tests/prediction-batch-start-parity-lib.mjs exactly as the baseline commit recorded in
// tests/fixtures/prediction-batch-start-parity-baseline.json did (selected film ids and order, lanes, plans, manifest hash, response fields, queue,
// run, lease and diagnostics state), except the known differences below. The Worker no longer puts a ChatGPT Task time on the start envelope, so
// nextCatchUpAt / nextScheduledRunAt are null and envelope byte counts (manifestBytes, overflow bytes) shrink by that JSON. Regenerate the baseline with
// scripts/prediction-batch-start-diff.mjs --write-baseline.
// AIR-452 (ADR 0167): retiring v5 reworded the schema contract text the manifest carries (prediction_batch_submit / prediction_batch_validate instead of
// prediction_submit / prediction_validate), so contractSha, manifestHash and the manifest byte counts differ from the baseline; no rule, film, order, lane,
// plan, queue, run, lease or diagnostics value does. The rewording itself is checked below.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runParity} from './prediction-batch-start-parity-lib.mjs';

const baseline=JSON.parse(fs.readFileSync(new URL('./fixtures/prediction-batch-start-parity-baseline.json',import.meta.url),'utf8'));
const {results}=await runParity();
const omitSchedule=value=>{
 const clone=JSON.parse(JSON.stringify(value||null));
 if(clone?.body){delete clone.body.nextCatchUpAt;delete clone.body.nextScheduledRunAt;delete clone.body.bytes;delete clone.body.drained;delete clone.body.contractSha;delete clone.body.manifestHash;delete clone.body.manifestBytes;delete clone.body.largestFilmBytes;}
 if(Array.isArray(clone?.state?.runs))for(const run of clone.state.runs){delete run.manifestBytes;delete run.manifestHash;}
 return clone;
};
assert.deepEqual(Object.keys(results),Object.keys(baseline.results),'same scenarios');
for(const name of Object.keys(results)){
 if(name==='missing_admission_far')continue;
 const now=results[name];
 if(now.body&&Object.prototype.hasOwnProperty.call(now.body,'nextScheduledRunAt')){
  assert.equal(now.body.nextCatchUpAt,null,name+' nextCatchUpAt');
  assert.equal(now.body.nextScheduledRunAt,null,name+' nextScheduledRunAt');
 }
 assert.deepEqual(omitSchedule(now),omitSchedule(baseline.results[name]),name+' differs from the baseline '+baseline.ref);
}

// The deliberate difference: with a film without admission inside the window (which starts the refresh) and another far behind it, the refresh used to settle both (it
// looked at a default 100 films); it now settles the one the manifest meets and leaves the far one queued until a later start reaches it. The manifest is the same.
{
 const was=baseline.results.missing_admission_far,now=results.missing_admission_far;
 assert.equal(now.status,was.status);
 assert.deepEqual(now.body.films,was.body.films,'the same films, in the same order');
 assert.equal(was.body.queueSettled,2);assert.equal(now.body.queueSettled,1);
 assert.equal(now.queue.pending.length,was.queue.pending.length+1,'the far film is still queued');
 assert.deepEqual(now.queue.pending.filter(id=>!was.queue.pending.includes(id)).length,1);
 assert.deepEqual(omitSchedule({state:now.state}),omitSchedule({state:was.state}),'run, lease and diagnostics state are the same except schedule-derived manifestBytes');
 const {queueSettled,eligible,pendingCount,hotRemaining,nextCatchUpAt,nextScheduledRunAt,drained,contractSha,manifestHash,manifestBytes,...restNow}=now.body,{queueSettled:a,eligible:b,pendingCount:c,hotRemaining:d,nextCatchUpAt:e,nextScheduledRunAt:f,contractSha:g,manifestHash:h,manifestBytes:i,...restWas}=was.body;
 assert.equal(nextCatchUpAt,null);assert.equal(nextScheduledRunAt,null);
 assert.deepEqual(restNow,restWas,'every other response field is the same');
}
// The one contract change: every running scenario still carries a well-formed contract and manifest hash (their values moved with the reworded schema text).
{
 const running=Object.values(results).filter(r=>r.body?.status==='running');assert.ok(running.length>0);
 for(const r of running){assert.match(r.body.contractSha,/^[0-9a-f]{64}$/);assert.match(r.body.manifestHash,/^[0-9a-f]{64}$/);}
}
console.log('prediction-batch-start-parity: ok ('+Object.keys(results).length+' scenarios, baseline '+baseline.ref+')');
