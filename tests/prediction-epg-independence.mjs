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
 const origin=new Date(Date.now()-30*3600000).toISOString();
 await w.ctx.mutatePredictionQueue(w.env,q=>{q.refreshedAt=origin;q.priorityAsOf=origin;q.priorityBasis='completed';for(const id of Object.keys(q.priority))q.priority[id]={...q.priority[id],hot:true,basis:'completed'};return q;},'test_age');
 assert.equal(queueDoc(w).priorityAsOf,origin,'mutate stored the origin');
 w.records.set('sync.json',{runId:'seal-run',stage:'finalize'});
 w.records.set('programme.json',{runId:'seal-run',films:[{id:'tmdb_1',title:'Hot',shows:[{start:Date.now()}]}]});
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const carried=queueDoc(w);
 assert.equal(carried.priorityBasis,'carried');
 assert.equal(carried.priorityAsOf,origin,'the first carry keeps the completed snapshot time');
 assert.equal(Object.values(carried.priority).some(p=>p.hot===true),true);
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const again=queueDoc(w);
 assert.equal(again.priorityAsOf,origin,'a second rebuild does not move the carry origin');
 assert.equal(again.priorityBasis,'carried');
 await w.ctx.mutatePredictionQueue(w.env,q=>{q.priorityAsOf=new Date(Date.now()-37*3600000).toISOString();return q;},'test_expire');
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const expired=queueDoc(w);
 assert.equal(expired.priorityBasis,'neutral');
 assert.equal(Object.values(expired.priority).every(p=>p.hot===false),true,'a fresh refreshedAt does not extend a carry past 36 hours');
 assert.equal(expired.programmeRunId!=='seal-run',true);
}
{
 const w=await ready(2);
 sql(w.file,'DELETE FROM discovery_admission');
 const only={id:'wl_only',title:'Only Watchlist',year:1999,genres:[]};
 w.records.set('watchlist.json',{films:[only]});
 w.records.set('sync.json',{runId:'seal-watch',stage:'finalize'});
 w.records.set('programme.json',{runId:'seal-watch',films:[{id:'tmdb_9',title:'Partial',shows:[{start:Date.now()}]}]});
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 assert.ok(queueDoc(w).pending.includes('wl_only'),'a watchlist film absent from Discovery is queued');
 const started=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:5});
 assert.equal(started.status,200,JSON.stringify(started.data).slice(0,300));
 assert.ok(started.data.films.some(f=>f.filmId==='wl_only'),'it reaches the manifest');
 assert.equal(started.data.skipped.missingAdmission,0);
 const submitted=await w.api('batch/submit',{runId:started.data.runId,epoch:started.data.lease.epoch,items:[item(w,'wl_only')]});
 assert.equal(submitted.status,200,JSON.stringify(submitted.data).slice(0,240));
 assert.equal(submitted.data.results[0].status,'created');
 assert.equal(w.records.get('sync.json').stage,'finalize');
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
