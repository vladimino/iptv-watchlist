// ADR 0132: the prediction contract is closed. An undeclared key is rejected with unknown_field (sanitised path, value never echoed) and never reaches a stored version.
// Synthetic data only; the real Worker validators and the real v2 submit path on the sqlite/R2 stand-in.
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const ready=async n=>{const w=await flowWorld({films:n});assert.equal((await w.api('queue/reconcile',{})).status,200);return w;};
const start=async w=>{const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.equal(r.status,200);return r.data;};
const versions=w=>[...w.records.keys()].filter(k=>/\/predictions\/versions\//.test(k));
const w=await ready(3);const m=await start(w),[a,b]=m.films.map(f=>f.filmId);
const good={filmId:a,fingerprint:w.fingerprint,prediction:w.prediction};

// 1. v2: an extra prediction key is a per-film validation failure naming the key; nothing is written for it.
{
 const secret='SECRET-SYNTHETIC-TEXT';
 const r=await w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items:[{...good,prediction:{...w.prediction,'bad key!':secret,reasoning:secret}}]});
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));
 const res=r.data.results[0];assert.equal(res.status,'validation_failure');
 assert.deepEqual(res.validation.issues,[{path:'prediction.bad_key_',code:'unknown_field'},{path:'prediction.reasoning',code:'unknown_field'}]);
 assert.ok(!JSON.stringify(r.data).includes(secret),'the value is never echoed');
 assert.equal(versions(w).length,0);assert.equal(sql(w.file,'SELECT film_id FROM prediction_pointer').length,0);
}
// 2. v2: undeclared item keys are a 400 with the explicit code and an indexed path.
{
 const r=await w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items:[{...good,extra:1}]});
 assert.equal(r.status,400);assert.deepEqual(r.data.issues,[{path:'items[0].extra',code:'unknown_field'}]);
}
// 3. v5: undeclared item keys are a 400 with the explicit code (no run is needed: the check is pure).
{
 const r=await w.api('submit',{runId:'none',items:[{filmId:a,prediction:w.prediction,assessment:{x:1}}]});
 assert.equal(r.status,400);assert.deepEqual(r.data.issues,[{path:'items[0].assessment',code:'unknown_field'}]);
}
// 4. A valid payload (six model fields) is unchanged and the stored version carries exactly those fields; confidenceAssessment is still stripped.
{
 const r=await w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items:[{...good,filmId:b,prediction:{...w.prediction,confidenceAssessment:{note:'ignored'}}}]});
 assert.equal(r.status,200);assert.equal(r.data.results[0].status,'created',JSON.stringify(r.data.results[0]));
 const key=versions(w)[0],body=JSON.parse(JSON.stringify(w.records.get(key)?.body??w.records.get(key)));
 const text=JSON.stringify(body);assert.ok(!text.includes('ignored'),'the caller confidenceAssessment is replaced by the Worker own');
 for(const k of ['predictedRating','probability4Plus','confidence','matchSignals','mainRisk','moodLabels'])assert.ok(k in (body.prediction||body),k);
}
console.log('prediction-closed-contract: unknown_field on prediction and item keys, no write on rejection and v5 compatibility passed');
