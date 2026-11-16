// AIR-508: the batch v2 terminal Event carries a compact named-film snapshot of this run
// (titles, ratings, source kinds, per-film failures). Offline sqlite D1 / in-memory R2.
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const batch=(w,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...body});
const assessment=()=>({assessmentVersion:1,ratingBasis:'Premise, execution and payoff of this film.',probability4PlusBasis:'Fit is moderate given mixed payoff.',
 tasteSignals:[],risks:[],uncertainties:[],research:{status:'not_attempted'},
 sources:[{kind:'model_knowledge',ref:'model_knowledge',usedFor:'taste match'}],conflicts:[],model:{status:'unavailable'}});
const webAssessment=()=>({assessmentVersion:1,ratingBasis:'Premise, execution and payoff of this film.',probability4PlusBasis:'Fit is moderate given mixed payoff.',
 tasteSignals:[],risks:[],uncertainties:[],research:{status:'attempted_found'},
 sources:[{kind:'metadata',ref:'metadata:synopsis',usedFor:'premise'},{kind:'web_research',ref:'https://example.com/review',usedFor:'reception',access:'full_text'}],
 conflicts:[{topic:'Ending',positions:[{source:1,author:'Jane Reviewer',stance:'earned'},{source:1,author:'Other Voice',stance:'weak'}],handling:'kept_unresolved'}],
 model:{status:'unavailable'}});

{
 const w=await flowWorld({films:8});
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const start=await batch(w,{manifestSize:5});assert.equal(start.status,200);
 const items=start.data.films.map(f=>({filmId:f.filmId,fingerprint:w.fingerprint,prediction:w.prediction,assessment:assessment()}));
 const sub=await w.api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items});
 assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,300));
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200);assert.equal(done.data.presentation,'batch_v2_terminal');
 const details=done.data.details;assert.ok(details);assert.equal(details.processed,5);assert.equal(details.success.length,5);assert.equal(details.failure.length,0);
 for(const row of details.success){
  assert.equal(row.status,'created');assert.equal(row.rating,3.5);assert.equal(row.year,2020);
  assert.ok(row.title);assert.match(row.filmId,/^tmdb_/);assert.deepEqual(row.source,{kinds:['model_knowledge']});
  assert.equal(row.source.kinds.includes('web_research'),false);
 }
 const packed=JSON.stringify(done.data);
 assert.doesNotMatch(packed,/https:\/\/example|ratingBasis|SYNTHETIC|predictionSha256|assessmentSha256/);
 const event=[...w.records.values()].find(v=>v?.id==='enrichment-'+start.data.runId);
 assert.deepEqual(event.details.success.map(r=>r.filmId),details.success.map(r=>r.filmId));
}

{
 const w=await flowWorld({films:6});
 sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.synopsis','A crew plans a robbery and a detective closes in.','$.genres',json('[\"Crime\"]'),'$.runtime',120,'$.directors',json('[\"A Director\"]'))");
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const start=await batch(w,{manifestSize:3});
 const ok=start.data.films.slice(0,1).map(f=>({filmId:f.filmId,fingerprint:w.fingerprint,prediction:w.prediction,assessment:webAssessment()}));
 const bad=start.data.films.slice(1).map(f=>({filmId:f.filmId,failure:{kind:'parse_error',reason:'json_unparseable'}}));
 const sub=await w.api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[...ok,...bad]});
 assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,400));
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200);assert.equal(done.data.status,'complete');assert.equal(done.data.title,'Пакет прогнозов обработан с ошибками');
 const details=done.data.details;assert.equal(details.processed,3);assert.equal(details.success.length,1);assert.equal(details.failure.length,2);
 assert.equal(details.success[0].rating,3.5);
 assert.deepEqual(details.success[0].source.kinds,['metadata','web_research']);
 assert.deepEqual(details.success[0].source.accesses,['full_text']);
 assert.deepEqual(details.success[0].source.authors,['Jane Reviewer','Other Voice']);
 assert.doesNotMatch(JSON.stringify(details),/https:\/\/example.com\/review|A crew plans|Premise, execution/);
 assert.equal(details.failure[0].kind,'parse_error');assert.equal(details.failure[0].claimed,'json_unparseable');
 assert.equal(details.failure[0].attempts,1);assert.equal(details.failure[0].exhausted,undefined);
}

{
 const w=await flowWorld({films:4});assert.equal((await w.api('queue/reconcile',{})).status,200);
 const start=await batch(w,{manifestSize:2});
 const stop=await w.api('complete',{runId:start.data.runId,reason:'quota'});
 assert.equal(stop.status,200);assert.equal(stop.data.status,'partial');assert.equal(stop.data.title,'Пакет прогнозов прерван');
 const details=stop.data.details;assert.equal(details.processed,0);assert.deepEqual(details.success,[]);assert.deepEqual(details.failure,[]);
}

{
 const w=await flowWorld({films:4});assert.equal((await w.api('queue/reconcile',{})).status,200);
 const start=await batch(w,{manifestSize:1});
 await w.api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[{filmId:start.data.films[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});
 const stop=await w.api('complete',{runId:start.data.runId,reason:'quota'});
 assert.equal(stop.data.details.success.length,1);assert.equal(stop.data.details.failure.length,0);assert.equal(stop.data.details.processed,1);
 assert.equal(stop.data.stage,'partial');
}

{
 const w=await flowWorld({films:4});assert.equal((await w.api('queue/reconcile',{})).status,200);
 const start=await batch(w,{manifestSize:1});
 const pick=start.data.films[0].filmId;
 const snippet={assessmentVersion:1,ratingBasis:'Premise, execution and payoff of this film.',probability4PlusBasis:'Fit is moderate given mixed payoff.',
  tasteSignals:[],risks:[],uncertainties:[],research:{status:'attempted_found'},
  sources:[{kind:'web_research',ref:'https://example.com/snippet',usedFor:'reception',access:'search_snippet'}],
  conflicts:[{topic:'Ending',positions:[{source:0,author:'Snippet Voice',stance:'earned'},{source:0,author:'Other Snip',stance:'weak'}],handling:'kept_unresolved'}],
  model:{status:'unavailable'}};
 const sub=await w.api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[{filmId:pick,fingerprint:w.fingerprint,prediction:w.prediction,assessment:snippet}]});
 assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,300));
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.deepEqual(done.data.details.success[0].source.accesses,['search_snippet']);
 assert.equal(done.data.details.success[0].source.authors,undefined);
}

{
 const w=await flowWorld({films:4});
 sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.synopsis','A crew plans a robbery and a detective closes in.','$.genres',json('[\"Crime\"]'),'$.runtime',120,'$.directors',json('[\"A Director\"]'))");
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const start=await batch(w,{manifestSize:1});
 const pick=start.data.films[0].filmId;
 const sub=await w.api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[{filmId:pick,fingerprint:w.fingerprint,prediction:w.prediction,assessment:webAssessment()}]});
 assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,300));
 assert.equal(sub.data.results[0].status,'created');
 sql(w.file,"UPDATE prediction_run SET document_json=json_remove(document_json,'$.eventFilms') WHERE run_id='"+start.data.runId+"'");
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200);
 assert.equal(done.data.details.success[0].rating,3.5);
 assert.deepEqual(done.data.details.success[0].source.kinds,['metadata','web_research']);
 assert.deepEqual(done.data.details.success[0].source.authors,['Jane Reviewer','Other Voice']);
}

{
 const w=await flowWorld({films:4});assert.equal((await w.api('queue/reconcile',{})).status,200);
 const start=await batch(w,{manifestSize:1});
 const pick=start.data.films[0].filmId;
 const sub=await w.api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[{filmId:pick,failure:{kind:'parse_error',reason:'insufficient_evidence'}}]});
 assert.equal(sub.status,200);
 const stored=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+start.data.runId+"'")[0].d);
 assert.equal(stored.failures[pick].attempts,1,'reconciled attempts are checkpointed on the run after submit');
 await w.ctx.mutatePredictionQueue(w.env,current=>{
  if(current.retries?.[pick])current.retries[pick].attempts=10;
  return current;
 },'due_retry');
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200);
 assert.equal(done.data.details.failure[0].attempts,10);
 assert.equal(done.data.details.failure[0].exhausted,true);
}

console.log('prediction event details: named films, sources, failures and interruption snapshot passed');
