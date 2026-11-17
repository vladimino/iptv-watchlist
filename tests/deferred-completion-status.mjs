// A run that ends with one hot film deferred by retry is a normal completion, but not a drained queue:
// the server stores `eligible_queue_empty` from the refreshed outstanding set, the Event snapshot and the
// footer status carry the read-only queue slices (outstanding, eligible now, deferred by retry, earliest
// retry time), and the UI never claims that the queue was processed completely.
// Since ADR 0162 the runs are batch runner v2 runs over D1 prediction authority, as production runs them (small catalog; the production-shaped coverage
// arithmetic is covered by the footer and Event tests).
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
const w=await flowWorld({films:3});const records=w.records,ctx=w.ctx,env=w.env;ctx.env=env;
let revision=0;{const bucket=env.BUCKET,put=bucket.put;bucket.put=async(key,value,options)=>{const saved=await put.call(bucket,key,value,options);if(saved)revision++;return saved;};}
const call=code=>vm.runInContext(code,ctx),plain=value=>JSON.parse(JSON.stringify(value));
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};}
const queueDoc=async()=>plain(await call('loadJSON(env,predictionQueueKey)'));
const setRetryAt=(id,at)=>call('mutatePredictionQueue(env,q=>{q.retries['+JSON.stringify(id)+'].retryAt='+at+';return q;},"test")');
const ui=vm.createContext({Date,Intl,URL,Set,Map});vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ui);
const render=(fn,value)=>{ui.value=value;return vm.runInContext(fn+'(value)',ui);};
const fingerprint=w.fingerprint,prediction=w.prediction;
const FORBIDDEN=/обработана полностью|очередь обработана|пакет завершён/i;
assert.equal((await api('queue/reconcile',{})).status,200);
const startRun=async()=>{const r=(await api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'})).data;assert.equal(r.status,'running',JSON.stringify(r).slice(0,200));return r;};
// Two films get a current prediction; the third is reported as a caller failure and is deferred by its retry.
let start=await startRun();const ids=start.films.map(f=>f.filmId);assert.equal(ids.length,3);const deferredId=ids[2];
const rejected=(await api('batch/submit',{runId:start.runId,epoch:start.lease.epoch,items:[{filmId:ids[0],fingerprint,prediction},{filmId:ids[1],fingerprint,prediction},{filmId:deferredId,failure:{kind:'parse_error',reason:'json_unparseable'}}]})).data;
assert.deepEqual(rejected.results.map(r=>r.status),['created','created','validation_failure']);
const retryAt=(await queueDoc()).retries[deferredId].retryAt;assert(retryAt>Date.now());
// The caller claims queue_empty; the server stores the reason the refreshed outstanding set supports.
const finished=(await api('complete',{runId:start.runId,reason:'queue_empty'})).data;
assert.equal(finished.status,'complete','a deferred run is a normal completion, not an error');assert.equal(finished.reason,null);assert.equal(finished.stopReason,'eligible_queue_empty','queue_empty is reserved for an empty outstanding set');
assert.equal(finished.hotRemaining,1);assert.equal(finished.coldRemaining,0);assert.equal(finished.counts.created,2);assert.equal(finished.counts.failed,1);
assert.deepEqual(plain(finished.snapshot.queue),{hotPending:1,coldPending:0,outstanding:1,eligibleNow:0,deferredByRetry:1,retryExhausted:0,nextRetryAt:new Date(retryAt).toISOString()});
assert.deepEqual([finished.snapshot.coverage.currentPredictionsTotal,finished.snapshot.coverage.confirmedFilmsTotal,finished.snapshot.coverage.windowCurrentPredictions,finished.snapshot.coverage.windowFilmsTotal],[2,3,2,3]);
assert.equal(finished.snapshot.coverage.localPercent,66.7);assert.equal(finished.snapshot.coverage.windowPercent,66.7);
const stored=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+start.runId+"'")[0].d);assert.equal(stored.stopReason,'eligible_queue_empty');assert.equal((await queueDoc()).lastBatch.stage,'complete');
// The Event renders from the stored snapshot: one film outstanding, deferred, with its retry time; no "processed completely".
const event=plain([...records].find(([key,value])=>key.startsWith('events/items/')&&value.id==='enrichment-'+start.runId)[1]);
assert.equal(event.stopReason,'eligible_queue_empty');assert.equal(event.stage,'complete');
const eventHTML=render('eventHTML',event);
// A v2 terminal Event renders its per-film groups (ADR 0146): the saved films and the failed one, never a claim that the queue was processed completely.
assert.match(eventHTML,/Осталось в очереди: hot 1 · cold 0\./);assert.match(eventHTML,/Успешно добавлены прогнозы · 2/);assert.match(eventHTML,/Не удалось получить прогноз · 1/);
assert.doesNotMatch(eventHTML,FORBIDDEN);assert.doesNotMatch(eventHTML,/приостановлен|прерван/);
// The footer reads the same slices from the stored queue, read-only, and keeps the schedule estimate apart from the film retry time.
const writesBefore=revision;
const footer=await (await ctx.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json();
assert.equal(revision,writesBefore,'footer status is read-only');
assert.equal(footer.lastRun.status,'completed');assert.equal(footer.lastRun.reason,'eligible_queue_empty');
assert.deepEqual({pendingHot:footer.predictions.pendingHot,pendingCold:footer.predictions.pendingCold,outstanding:footer.predictions.outstanding,eligibleNow:footer.predictions.eligibleNow,deferredByRetry:footer.predictions.deferredByRetry,retryExhausted:footer.predictions.retryExhausted,nextRetryAt:footer.predictions.nextRetryAt},{pendingHot:1,pendingCold:0,outstanding:1,eligibleNow:0,deferredByRetry:1,retryExhausted:0,nextRetryAt:new Date(retryAt).toISOString()});
assert.notEqual(footer.predictions.nextRetryAt,footer.predictions.nextScheduledRun);
const footerText=render('footerStatusText',footer);
assert.match(footerText.runLine,/^завершён · 1 фильм ожидает повторной попытки не раньше /);assert.match(footerText.runResult,/^завершён · 1 фильм ожидает повторной попытки/);assert.equal(footerText.nextBatch,'ждёт повторной попытки');assert.match(footerText.deferred,/^1 фильм · не раньше /);
assert.match(footerText.local,/^2\/3 с актуальным прогнозом · 66,7%$/);assert.match(footerText.windowCoverage,/^2\/3 с актуальным прогнозом · 66,7%$/);
for(const value of Object.values(footerText))if(typeof value==='string')assert.doesNotMatch(value,FORBIDDEN);
assert.doesNotMatch(JSON.stringify(footer),FORBIDDEN);assert.doesNotMatch(JSON.stringify(footer),/Bearer|token/);
// Once the retry matures and the film is predicted, the next run drains the queue and says so.
await setRetryAt(deferredId,0);
start=await startRun();assert.deepEqual(start.films.map(f=>f.filmId),[deferredId]);
await api('batch/submit',{runId:start.runId,epoch:start.lease.epoch,items:[{filmId:deferredId,fingerprint,prediction}]});
const drained=(await api('complete',{runId:start.runId})).data;
assert.equal(drained.stopReason,'queue_empty');assert.deepEqual(plain(drained.snapshot.queue),{hotPending:0,coldPending:0,outstanding:0,eligibleNow:0,deferredByRetry:0,retryExhausted:0,nextRetryAt:null});
assert.equal(drained.snapshot.coverage.currentPredictionsTotal,3);assert.equal(drained.snapshot.coverage.localPercent,100);
const drainedHTML=render('eventHTML',plain([...records].find(([key,value])=>key.startsWith('events/items/')&&value.id==='enrichment-'+start.runId)[1]));
assert.match(drainedHTML,/Пакет прогнозов обработан<\/p>/);assert.match(drainedHTML,/Осталось в очереди: hot 0 · cold 0\./);assert.doesNotMatch(drainedHTML,/без (актуального )?прогноза|повторной попытки/);
const drainedFooter=render('footerStatusText',await (await ctx.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json());
assert.equal(drainedFooter.runLine,'завершён · все фильмы с актуальными прогнозами');assert.equal(drainedFooter.deferred,'нет');assert.equal(drainedFooter.nextBatch,'очередь пуста');
console.log('Deferred completion status (batch v2): one hot film deferred by retry → eligible_queue_empty with 2/3, queue slices in the Event snapshot and footer, honest v2 Event and footer texts without "processed completely", read-only footer, and a drained queue after the retry passed');
