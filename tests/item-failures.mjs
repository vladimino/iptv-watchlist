// Item failures on batch runner v2 (the only runner since ADR 0167), on the real Worker code with the prediction domain in D1 mode over a sqlite D1 stand-in and an
// in-memory R2. One bad film never ends the run: a Worker validation failure and a caller-reported failure each become a retry record with the existing backoff,
// their replay is idempotent, the healthy films are written, the run completes normally, and after the backoff the next run offers the failed films again,
// reusing a stored valid fingerprint (prediction_only). Local stand-ins only; nothing calls a model, TMDB or production.
import assert from 'node:assert/strict';
import * as PredictionD1 from '../src/prediction-d1.js';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const queueOf=w=>JSON.parse(sql(w.file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
const pointers=w=>sql(w.file,'SELECT film_id FROM prediction_pointer ORDER BY film_id').map(r=>r.film_id);
const runOf=(w,runId)=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+runId+"'")[0].d);
const start=async w=>{const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100}});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));return r.data;};
const submit=(w,m,items)=>w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items});

const w=await flowWorld({films:6});
assert.equal((await w.api('queue/reconcile',{})).status,200);
const m=await start(w),ids=m.films.map(f=>f.filmId);assert.equal(ids.length,6);
const good=id=>({filmId:id,fingerprint:w.fingerprint,prediction:w.prediction});
const invalid={filmId:ids[1],fingerprint:w.fingerprint,prediction:{...w.prediction,predictedRating:4.2}};
const reported={filmId:ids[3],failure:{kind:'parse_error',reason:'json_unparseable'}};

// A success, a Worker validation failure, a success and a caller-reported failure in one group: each film has its own result, the run stays running.
const mixed=await submit(w,m,[good(ids[0]),invalid,good(ids[2]),reported]);
assert.equal(mixed.status,200,JSON.stringify(mixed.data).slice(0,300));
const by=Object.fromEntries(mixed.data.results.map(r=>[r.filmId,r]));
assert.equal(by[ids[0]].status,'created');assert.equal(by[ids[2]].status,'created');
assert.equal(by[ids[1]].status,'validation_failure');assert.equal(by[ids[1]].retryable,true);assert.equal(by[ids[1]].validation.stage,'prediction_schema');assert.equal(by[ids[1]].validation.reportedBy,'worker');
assert.ok(by[ids[1]].validation.issues.some(issue=>issue.path==='prediction.predictedRating'),'the issue names the field');
assert.equal(by[ids[3]].status,'validation_failure');assert.equal(by[ids[3]].validation.stage,'caller_reported');
assert.equal(mixed.data.status,'running');assert.equal(mixed.data.mustComplete??false,false);
assert.deepEqual(pointers(w),[ids[0],ids[2]].sort(),'only the healthy films are written');
let queue=queueOf(w);
for(const id of [ids[1],ids[3]]){const retry=queue.retries[id];assert.ok(retry,id+' has a retry record');assert.equal(retry.attempts,1);assert.equal(retry.retryable,true);assert.equal(retry.scope,'item');assert.ok(retry.retryAt>Date.now(),'with the existing backoff');}

// The identical payload is a replay: no second attempt, no second retry record.
const replay=await submit(w,m,[invalid,reported]);
assert.ok(replay.data.results.every(r=>r.status==='validation_failure'&&r.replayed===true),JSON.stringify(replay.data.results));
queue=queueOf(w);assert.equal(queue.retries[ids[1]].attempts,1);assert.equal(queue.retries[ids[3]].attempts,1);

// A second runner is turned away while the run holds the lease; a heartbeat renews it.
assert.equal((await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual'})).data.status,'already_running');
assert.equal((await w.api('heartbeat',{runId:m.runId})).status,200);

// Completing for an isolated item failure while manifest films are unsettled is refused; the rest is written and the run completes normally.
assert.equal((await w.api('complete',{runId:m.runId,reason:'manifest_spent'})).status,409);
const rest=await submit(w,m,[good(ids[4]),good(ids[5])]);assert.deepEqual(rest.data.results.map(r=>r.status),['created','created']);
const done=await w.api('complete',{runId:m.runId,reason:'manifest_spent'});
assert.equal(done.status,200,JSON.stringify(done.data).slice(0,300));assert.equal(done.data.status,'complete');assert.equal(done.data.added,4);assert.equal(done.data.failed,2);
const stored=runOf(w,m.runId);assert.equal(stored.status,'complete');assert.deepEqual(Object.keys(stored.failures).sort(),[ids[1],ids[3]].sort());
assert.ok(!JSON.stringify(sql(w.file,'SELECT * FROM prediction_run')).includes('json_unparseable model'),'no model output is stored');

// After the backoff the next run offers the two failed films again; the film whose fingerprint was valid and stored needs only a prediction.
const head=await PredictionD1.openQueue(w.env);for(const id of [ids[1],ids[3]])head.queue.retries[id].retryAt=0;assert.ok(await PredictionD1.writeQueue(w.env,head,head.queue));
const again=await start(w);
assert.deepEqual(again.films.map(f=>f.filmId).sort(),[ids[1],ids[3]].sort(),'only the retried films are delivered');
const plans=Object.fromEntries(again.films.map(f=>[f.filmId,f.plan]));
assert.equal(plans[ids[1]],'prediction_only','the stored valid fingerprint is reused');assert.equal(plans[ids[3]],'fingerprint_and_prediction');
const retried=await submit(w,again,[{filmId:ids[1],prediction:w.prediction},good(ids[3])]);
assert.deepEqual(retried.data.results.map(r=>r.status),['created','created']);
const final=await w.api('complete',{runId:again.runId});assert.equal(final.status,200,JSON.stringify(final.data).slice(0,300));assert.equal(final.data.status,'complete');
assert.deepEqual(pointers(w),[...ids].sort(),'every film is predicted once');
queue=queueOf(w);assert.equal((queue.hotPending||[]).length+(queue.coldPending||[]).length,0,'the queue is empty');
console.log('Item failures (batch v2, D1): mixed group, Worker and caller-reported failures as retry records with backoff, idempotent replay, overlapping start turned away, refused early completion, normal completion, retry after backoff with fingerprint reuse passed');
