// Live telemetry of batch runner v2 runs (ADR 0162; D1 prediction authority, as production runs it): idle, running, completed and blocked states; fresh added,
// failed, heartbeat and queue counters while a run is live; no start, resume or progress Event (a v2 run has one terminal Event, ADR 0146); a silent overlapping
// trigger; and a final Event whose coverage shares the footer's canonical semantics. Local stand-ins only.
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
const w=await flowWorld({films:4});const records=w.records,ctx=w.ctx,env=w.env;
env.BUCKET.list=async({prefix='',limit=1000}={})=>({objects:[...records.keys()].filter(key=>key.startsWith(prefix)).sort().slice(0,limit).map(key=>({key})),truncated:false});
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};}
const events=()=>[...records].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v),status=async()=>(await api('status',undefined,'GET')).data;
const setRun=(id,edit)=>{const doc=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+id+"'")[0].d);edit(doc);sql(w.file,"UPDATE prediction_run SET document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE run_id='"+id+"'");};
const COVERAGE=['confirmedFilmsTotal','currentPredictionsTotal','windowFilmsTotal','windowCurrentPredictions','cacheOffWindowTotal','pendingOffWindowTotal'];
const start=body=>api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...body}).then(r=>r.data);
const item=id=>({filmId:id,fingerprint:w.fingerprint,prediction:w.prediction});

assert.equal((await status()).state,'idle');
assert.equal((await api('queue/reconcile',{})).status,200);
let run=await start({manifestSize:3});assert.equal(run.status,'running');assert.equal(events().length,0,'a batch v2 start writes no start Event');
let live=await status();assert.equal(live.state,'running');assert.equal(live.runId,run.runId);assert.equal(live.added,0);assert.equal(live.failed,0);assert.equal(live.hotRemaining,4);
assert.equal((await start()).status,'already_running');assert.equal(events().length,0,'an overlapping trigger is silent');
const ids=run.films.map(f=>f.filmId);
setRun(run.runId,doc=>{doc.lastHeartbeatAt='2000-01-01T00:00:00Z';});
await api('batch/submit',{runId:run.runId,epoch:run.lease.epoch,items:[item(ids[0])]});live=await status();assert.equal(live.added,1);assert.equal(live.hotRemaining,3);assert(live.lastHeartbeatAt>'2000-01-01T00:00:00Z');assert.equal(events().length,0);
await api('batch/submit',{runId:run.runId,epoch:run.lease.epoch,items:[{filmId:ids[1],failure:{kind:'parse_error',reason:'json_unparseable'}}]});live=await status();assert.equal(live.failed,1);assert.equal(live.added,1);assert.equal(live.state,'running');assert.equal(events().length,0);
setRun(run.runId,doc=>{doc.lastHeartbeatAt='2000-01-01T00:00:00Z';doc.lastProgressAt='2000-01-01T00:00:00Z';});
await api('heartbeat',{runId:run.runId});assert((await status()).lastHeartbeatAt>'2000-01-01T00:00:00Z');assert.equal(events().length,0,'a heartbeat writes no progress Event for a v2 run');
await api('batch/submit',{runId:run.runId,epoch:run.lease.epoch,items:[item(ids[2])]});assert.equal((await status()).added,2);assert.equal(events().length,0,'individual submits do not create Events');
await api('complete',{runId:run.runId,reason:'manifest_spent'});assert.equal((await status()).state,'completed');
let final=events().at(-1);assert.equal(events().length,1,'one terminal Event');assert.deepEqual(final.delta,{added:2,updated:0,failed:1,predictionGain:2});
// The last eligible film: a second run settles it and completes with eligible_queue_empty (the failed film waits for its retry) and its Event shares the footer's coverage.
run=await start();assert.equal(run.films.length,1);assert.ok(!ids.slice(0,3).includes(run.films[0].filmId),'the deferred and the saved films are not delivered again');
await api('batch/submit',{runId:run.runId,epoch:run.lease.epoch,items:[item(run.films[0].filmId)]});await api('complete',{runId:run.runId});
assert.equal((await status()).state,'completed');final=events().at(-1);assert.equal(events().length,2);assert.equal(final.stopReason,'eligible_queue_empty','the failed film waits for its retry');assert.deepEqual(final.delta,{added:1,updated:0,failed:0,predictionGain:1});
assert.equal(final.snapshot.coverage.currentPredictionsTotal,3);assert.equal(final.snapshot.coverage.confirmedFilmsTotal,4);
const footer=(await api('footer/status',undefined,'GET')).data.coverage;for(const key of COVERAGE)assert.equal(final.snapshot.coverage[key],footer[key],'the final Event and the footer share canonical coverage semantics: '+key);
assert(!/hash|token|prompt|Bearer|stack/i.test(JSON.stringify(events())),'no secret, hash or prompt in an Event (a v2 terminal Event names its lastHeartbeatAt, ADR 0146)');
await api('complete',{runId:run.runId});assert.equal(events().length,2,'a repeated complete writes no second Event');
// New work plus early quota: the start answers blocked quota.
{const f={id:'tmdb_5',title:'tmdb_5',original:'tmdb_5',year:2020,tmdbId:'5',canonicalIdentity:'tmdb:5',genres:[],actors:[],directors:[],shows:[{start:Date.now()}]};
 sql(w.file,"INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES ('tmdb_5','5','movie','tmdb:5','tmdb_5','p1',1,'current','"+JSON.stringify(f).replace(/'/g,"''")+"')");}
assert.equal((await api('queue/reconcile',{})).status,200);
{const blocked=await start({capacity:{remainingPercent:0}});assert.equal(blocked.status,'blocked');assert.equal(blocked.reason,'quota');}
// A v2 idle outcome takes no lease and creates no run: the live state still names the last real run, and no Event is written.
assert.equal((await status()).state,'completed');assert.equal(events().length,2);
console.log('Live telemetry (batch v2): no start/resume/progress Events, silent concurrent trigger/heartbeat, fresh added/failed/heartbeat/queue counters, one terminal Event sharing footer coverage idle/running/completed states and a blocked quota start passed');
