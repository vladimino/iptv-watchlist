// AIR-505: ten saved per-film retryable failures exhaust automatic selection. Offline Worker on sqlite D1
// and in-memory R2. No model, TMDB, production write or Scheduled Task.
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const ready=async n=>{const w=await flowWorld({films:n});assert.equal((await w.api('queue/reconcile',{})).status,200);return w;};
const start=async w=>{const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,240));return r.data;};
const submit=(w,m,items)=>w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items});
const stop=(w,m)=>w.api('complete',{runId:m.runId,reason:'external_termination'});
const queue=w=>JSON.parse(sql(w.file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
const ids=m=>m.films.map(f=>f.filmId);
const storedRun=(w,m)=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+m.runId+"'")[0].d);
const claim={kind:'parse_error',reason:'insufficient_evidence'};

async function failFilm(w,filmId){
 await w.ctx.mutatePredictionQueue(w.env,current=>{
  const record=current.retries?.[filmId];
  if(record)record.retryAt=0;
  return current;
 },'due_retry');
 const m=await start(w);
 assert.ok(ids(m).includes(filmId),'the film is still selected');
 const r=await submit(w,m,[{filmId,failure:claim}]);
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,240));
 assert.equal(r.data.results[0].status,'validation_failure');
 const done=await stop(w,m);assert.equal(done.status,200,JSON.stringify(done.data).slice(0,200));
 return queue(w).retries[filmId];
}

{
 const w=await ready(6);const target='tmdb_1';
 let record=null;
 for(let n=1;n<=9;n++){
  record=await failFilm(w,target);
  assert.equal(record.attempts,n,'attempt '+n+' is stored once');
  assert.ok(queue(w).hotPending.includes(target),'attempt '+n+' still leaves the film in the hot lane');
 }
 record=await failFilm(w,target);
 assert.equal(record.attempts,10);
 const held=queue(w);
 assert.ok(!held.hotPending.includes(target),'the tenth attempt leaves the hot lane');
 assert.ok(!held.coldPending.includes(target));
 assert.ok(!held.pending.includes(target));
 assert.equal(held.retries[target].attempts,10);
 const next=await start(w);
 assert.ok(!ids(next).includes(target),'v2 start does not select an exhausted film');
 assert.ok(ids(next).length>0,'neighbours remain eligible');
 await stop(w,next);
 const rebuilt=await w.api('queue/reconcile',{});
 assert.equal(rebuilt.status,200);
 const after=queue(w);
 assert.equal(after.retries[target].attempts,10,'rebuild keeps the exhausted retry record');
 assert.ok(!after.hotPending.includes(target)&&!after.coldPending.includes(target));
 const again=await start(w);
 assert.ok(!ids(again).includes(target));
 await stop(w,again);
}

{
 const w=await ready(4);const m=await start(w),pick=ids(m)[0];
 const first=await submit(w,m,[{filmId:pick,failure:claim}]);
 assert.equal(first.data.results[0].status,'validation_failure');
 const replay=await submit(w,m,[{filmId:pick,failure:claim}]);
 assert.equal(replay.data.results[0].replayed,true);
 assert.equal(queue(w).retries[pick].attempts,1,'identical replay does not raise attempts');
 await stop(w,m);
}

{
 const w=await ready(8);const m=await start(w),pick=ids(m).slice(0,5);
 const r=await submit(w,m,pick.map(filmId=>({filmId,failure:claim})));
 assert.equal(r.status,200);
 const stored=storedRun(w,m);
 assert.equal(stored.formatFailureStreak||0,0,'insufficient_evidence does not count toward format_error_storm');
 assert.notEqual(stored.systemicStopReason,'format_error_storm');
 await stop(w,m);
}

{
 const w=await ready(8);const m=await start(w),pick=ids(m).slice(0,5);
 const r=await submit(w,m,pick.map(filmId=>({filmId,failure:{kind:'parse_error',reason:'json_unparseable'}})));
 assert.equal(r.status,200);
 const stored=storedRun(w,m);
 assert.equal(stored.formatFailureStreak||0,0,'caller json_unparseable does not trip format_error_storm');
 assert.notEqual(stored.systemicStopReason,'format_error_storm');
 await stop(w,m);
}

{
 const w=await ready(8);const m=await start(w),pick=ids(m).slice(0,5);
 const mixed=pick.map((filmId,i)=>i<4?{filmId,failure:{kind:'parse_error',reason:'preflight_validation_failed'}}:{filmId,fingerprint:w.fingerprint,prediction:{...w.prediction,predictedRating:99}});
 const r=await submit(w,m,mixed);
 assert.equal(r.status,200);
 const stored=storedRun(w,m);
 assert.notEqual(stored.systemicStopReason,'format_error_storm','four caller claims plus one worker failure is not a storm');
 assert.equal(stored.formatFailureStreak,1);
 await stop(w,m);
}

{
 const w=await ready(8);const m=await start(w),pick=ids(m).slice(0,5);
 const bad={...w.prediction,predictedRating:99};
 const r=await submit(w,m,pick.map(filmId=>({filmId,fingerprint:w.fingerprint,prediction:bad})));
 assert.equal(r.status,200);
 const stored=storedRun(w,m);
 assert.equal(stored.systemicStopReason,'format_error_storm','five worker schema failures still stop the run');
 await w.api('complete',{runId:m.runId,reason:'format_error_storm'});
}

{
 const w=await ready(2);
 const rec=(n)=>({kind:'parse_error',scope:'item',retryable:true,attempts:10,failedAt:new Date(Date.parse('2026-11-16T00:00:00.000Z')+n*1000).toISOString(),retryAt:0,lastRunId:'prior'});
 const seeded=await w.ctx.mutatePredictionQueue(w.env,current=>{
  current.retries||={};
  current.retries.tmdb_1=rec(0);
  for(let i=0;i<501;i++)current.retries['hist_'+i]=rec(i+1);
  return current;
 },'seed_history_cap');
 assert.ok(seeded);
 const rebuilt=await w.api('queue/reconcile',{});
 assert.equal(rebuilt.status,200);
 const held=queue(w);
 assert.equal(held.retries.tmdb_1.attempts,10,'rebuild does not drop an exhausted catalog identity under the history cap');
 assert.ok(!held.hotPending.includes('tmdb_1'));
 assert.equal(held.retries.hist_0,undefined);
 const m=await start(w);
 assert.ok(!ids(m).includes('tmdb_1'),'the held identity is not selected for an 11th attempt');
 await stop(w,m);
}

{
 const w=await ready(3);
 const seeded=await w.ctx.mutatePredictionQueue(w.env,current=>{
  current.retries||={};
  current.retries.tmdb_1={kind:'parse_error',scope:'item',retryable:true,attempts:10,failedAt:'2026-11-16T08:00:00.000Z',retryAt:0,lastRunId:'prior',validation:{stage:'caller_reported',reportedBy:'caller',issues:[],claimed:{reason:'insufficient_evidence'}}};
  return current;
 },'seed_exhausted');
 assert.ok(seeded);
 const rebuilt=await w.api('queue/reconcile',{});
 assert.equal(rebuilt.status,200);
 const held=queue(w);
 assert.equal(held.retries.tmdb_1.attempts,10);
 assert.ok(!held.hotPending.includes('tmdb_1'));
 const m=await start(w);
 assert.ok(!ids(m).includes('tmdb_1'),'a pre-existing attempts>=10 record is held without an eleventh model call');
 await stop(w,m);
}

{
 const w=await ready(2);
 const same=w.ctx.mergeRetryRecord({kind:'parse_error',scope:'item',attempts:4,retryAt:1,lastRunId:'run-1'},{kind:'parse_error',scope:'item',attempts:5,retryAt:9},'run-1');
 assert.equal(same.attempts,4,'the same runId does not raise attempts');
 const grown=w.ctx.mergeRetryRecord(same,{kind:'parse_error',scope:'item',failedAt:'2026-11-16T09:00:00.000Z'},'run-2');
 assert.equal(grown.attempts,5);
 const systemic=w.ctx.mergeRetryRecord(grown,{kind:'storage_error',scope:'run',failedAt:'2026-11-16T09:01:00.000Z'},'run-3');
 assert.equal(systemic,grown,'a systemic run failure does not consume the per-film budget');
 const readyIds=w.ctx.queueReadyIds({hotPending:['a','b'],coldPending:['c'],priorityCount:2,retries:{a:{attempts:10,retryAt:0},b:{attempts:2,retryAt:Date.now()+3600000}}});
 assert.deepEqual(readyIds,[],'exhausted hot films do not occupy the hot lane once every remaining hot film is held');
 const cold=w.ctx.queueReadyIds({hotPending:['a'],coldPending:['c'],priorityCount:1,retries:{a:{attempts:10,retryAt:0}}});
 assert.deepEqual(cold,['c'],'cold proceeds when every hot film is retry-exhausted');
 const rec=(n,id)=>({kind:'parse_error',scope:'item',retryable:true,attempts:10,failedAt:new Date(Date.parse('2026-11-16T00:00:00.000Z')+n*1000).toISOString(),retryAt:0,lastRunId:'prior'});
 const retries={};
 for(let i=0;i<501;i++)retries['hist_'+i]=rec(i);
 retries.important=rec(0);
 const keepActive=w.ctx.boundRetryRecords(retries,new Set(['important']));
 assert.equal(keepActive.important.attempts,10,'an exhausted catalog identity survives >500 newer historical records');
 assert.equal(Object.keys(keepActive).filter(id=>id.startsWith('hist_')).length,500);
 assert.equal(keepActive.hist_0,undefined,'the oldest historical exhausted record is the one dropped');
 const keepBoth=w.ctx.boundRetryRecords(retries,new Set(['important','hist_0']));
 assert.ok(keepBoth.hist_0&&keepBoth.important,'catalog exhausted holds are never trimmed for history');
}

console.log('prediction retry exhausted: 9 stays deferred, 10 holds, rebuild and replay keep the budget, insufficient_evidence does not false-storm');
