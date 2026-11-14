// AIR-471: the current tree answers every batch_start scenario of tests/prediction-batch-start-parity-lib.mjs exactly as the baseline commit recorded in
// tests/fixtures/prediction-batch-start-parity-baseline.json did (selected film ids and order, lanes, plans, manifest hash and bytes, response fields, queue,
// run, lease and diagnostics state), except the one deliberate difference below. Regenerate the baseline with scripts/prediction-batch-start-diff.mjs --write-baseline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runParity} from './prediction-batch-start-parity-lib.mjs';

const baseline=JSON.parse(fs.readFileSync(new URL('./fixtures/prediction-batch-start-parity-baseline.json',import.meta.url),'utf8'));
const {results}=await runParity();
assert.deepEqual(Object.keys(results),Object.keys(baseline.results),'same scenarios');
for(const name of Object.keys(results)){
 if(name==='missing_admission_far')continue;
 assert.deepEqual(results[name],baseline.results[name],name+' differs from the baseline '+baseline.ref);
}

// The deliberate difference: with a film without admission inside the window (which starts the refresh) and another far behind it, the refresh used to settle both (it
// looked at a default 100 films); it now settles the one the manifest meets and leaves the far one queued until a later start reaches it. The manifest is the same.
{
 const was=baseline.results.missing_admission_far,now=results.missing_admission_far;
 assert.equal(now.status,was.status);
 assert.deepEqual(now.body.films,was.body.films,'the same films, in the same order');
 assert.equal(now.body.manifestHash,was.body.manifestHash);
 assert.equal(was.body.queueSettled,2);assert.equal(now.body.queueSettled,1);
 assert.equal(now.queue.pending.length,was.queue.pending.length+1,'the far film is still queued');
 assert.deepEqual(now.queue.pending.filter(id=>!was.queue.pending.includes(id)).length,1);
 assert.deepEqual(now.state,was.state,'run, lease and diagnostics state are the same');
 const {queueSettled,eligible,pendingCount,hotRemaining,...restNow}=now.body,{queueSettled:a,eligible:b,pendingCount:c,hotRemaining:d,...restWas}=was.body;
 assert.deepEqual(restNow,restWas,'every other response field is the same');
}
console.log('prediction-batch-start-parity: ok ('+Object.keys(results).length+' scenarios, baseline '+baseline.ref+')');
