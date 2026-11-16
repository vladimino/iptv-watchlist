// ADR 0154 / AIR-511. Scoring does not wait for an EPG seal. Offline sqlite and in-memory R2 only.
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const queueDoc=w=>JSON.parse(sql(w.file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
const ready=async n=>{const w=await flowWorld({films:n});assert.equal((await w.api('queue/reconcile',{})).status,200);return w;};
const item=(w,id)=>({filmId:id,fingerprint:w.fingerprint,prediction:w.prediction});

{
 const w=await ready(8);
 const before=queueDoc(w);
 assert.equal(before.programmeRunId,'p1');
 const retryId=before.pending[before.pending.length-1];
 await w.ctx.mutatePredictionQueue(w.env,q=>{q.retries={...q.retries,[retryId]:{attempts:3,retryAt:Date.now()+3600000,kind:'parse_error'}};return q;},'test_retry');
 const sync={runId:'47663279-3e6b-423d-b696-b22edfcead91',stage:'seal'};
 const partial={runId:sync.runId,films:[{id:'tmdb_1',title:'Partial',shows:[{start:Date.now()+1000}]}]};
 w.records.set('sync.json',sync);
 w.records.set('programme.json',partial);
 w.records.set('watchlist.json',{films:[{id:'tmdb_1'},{id:'tmdb_2'}]});
 const keys=JSON.stringify([...w.records.keys()].sort());
 const started=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:5});
 assert.equal(started.status,200,JSON.stringify(started.data).slice(0,300));
 assert.equal(started.data.status,'running');
 assert.equal(started.data.films.length,5);
 assert.equal(started.data.films.every(f=>f.modelMetadata&&f.modelMetadata.title),true);
 assert.equal(JSON.stringify(w.records.get('sync.json')),JSON.stringify(sync),'the start wrote no EPG sync');
 assert.equal(JSON.stringify(w.records.get('programme.json')),JSON.stringify(partial));
 assert.equal(queueDoc(w).programmeRunId,'p1','an unsealed generation does not restamp the queue');
 assert.equal(queueDoc(w).retries[retryId].attempts,3);
 const picked=started.data.films.map(f=>f.filmId);
 const submitted=await w.api('batch/submit',{runId:started.data.runId,epoch:started.data.lease.epoch,items:picked.map(id=>item(w,id))});
 assert.equal(submitted.status,200,JSON.stringify(submitted.data).slice(0,240));
 assert.equal(submitted.data.results.every(row=>row.status==='created'),true);
 const done=await w.api('complete',{runId:started.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200,JSON.stringify(done.data).slice(0,240));
 assert.equal(done.data.stopReason,'manifest_spent');
 assert.equal(queueDoc(w).retries[retryId].attempts,3,'complete keeps a retry the manifest did not spend');
 assert.equal(JSON.stringify([...w.records.keys()].sort())===keys||w.records.get('sync.json').stage==='seal',true);
}

{
 const w=await ready(4);
 await w.ctx.mutatePredictionQueue(w.env,q=>{q.refreshedAt='1990-01-01T00:00:00.000Z';return q;},'test_age');
 w.records.set('sync.json',{runId:'seal-run',stage:'finalize'});
 w.records.set('programme.json',{runId:'seal-run',films:[{id:'tmdb_1',title:'Hot',shows:[{start:Date.now()}]}]});
 const rebuilt=await w.api('queue/reconcile',{});
 assert.equal(rebuilt.status,200,JSON.stringify(rebuilt.data).slice(0,200));
 const next=queueDoc(w);
 assert.equal(next.priorityBasis,'neutral');
 assert.equal(Object.values(next.priority).every(p=>p.hot===false),true,'shows older than the carry window are not current');
 assert.equal(next.programmeRunId!=='seal-run',true);
}

{
 const w=await ready(3);
 const first=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',manifestSize:1});
 assert.equal(first.status,200,JSON.stringify(first.data).slice(0,200));
 const id=first.data.films[0].filmId;
 const submitted=await w.api('batch/submit',{runId:first.data.runId,epoch:first.data.lease.epoch,items:[item(w,id)]});
 assert.equal(submitted.status,200);
 await w.api('complete',{runId:first.data.runId,reason:'manifest_spent'});
 const programme=w.records.get('programme.json');
 w.records.set('programme.json',{...programme,films:[...(programme.films||[]),{id,shows:[{start:Date.now()+5000}]}]});
 w.records.set('sync.json',{runId:programme.runId,stage:'complete'});
 const again=await w.api('queue/reconcile',{});
 assert.equal(again.status,200);
 const follow=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',manifestSize:5});
 assert.equal(follow.status,200,JSON.stringify(follow.data).slice(0,240));
 assert.equal(follow.data.films.some(f=>f.filmId===id),false,'a new airtime does not make a current prediction stale');
}
