// AIR-431 / AIR-493. The Prediction queue advances on its own state while Discovery keeps writing. A runner step does
// not rebuild from the whole catalog. A full rebuild reads the catalog as one admission snapshot (ADR 0147): a Discovery
// chunk that only bumps `discovery_authority.generation` does not fence it. The runner is batch runner v2 (the only one since
// ADR 0162), with the prediction domain and the Discovery authority in D1 mode on a local sqlite D1 stand-in, and every catalog
// query moves the Discovery generation (a continuation write on each statement). Local stand-ins only; nothing here calls
// Cloudflare, TMDB or production.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import * as Authority from '../src/discovery-authority.js';
import * as PredictionD1 from '../src/prediction-d1.js';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const now=Date.now(),HOT=60,COLD=140,TOTAL=HOT+COLD;
// Films 1..HOT air now; the rest aired ten days ago (cold).
const w=await flowWorld({films:TOTAL,extra:n=>n<=HOT?{}:{shows:[{start:now-10*86400000}]}});
const {file,env,api,logs,fingerprint,prediction}=w;
// The storm: while on, every query against the admission table moves the generation, as a Discovery chunk committing between two statements does.
const stats={storm:false,fullReads:0,idReads:0,queries:0};
w.hooks.query=text=>{
 stats.queries++;
 if(/FROM discovery_admission WHERE state='current' ORDER BY film_id/.test(text))stats.fullReads++;
 else if(/FROM discovery_admission WHERE state='current' AND film_id IN/.test(text))stats.idReads++;
 if(stats.storm&&/FROM discovery_admission/.test(text))sql(file,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');
};
const film=(n,start)=>({id:'tmdb_'+n,title:'tmdb_'+n,original:'tmdb_'+n,year:2020,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,genres:[],actors:[],directors:[],shows:[{start}]});
const insertAdmissions=films=>{for(let at=0;at<films.length;at+=50)sql(file,"INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES "+films.slice(at,at+50).map(f=>"('"+f.id+"','"+f.tmdbId+"','movie','"+f.canonicalIdentity+"','"+f.id+"','p1',1,'current','"+JSON.stringify(f).replace(/'/g,"''")+"')").join(','));};
const publish=runId=>{w.records.set('programme.json',{runId,films:[]});w.records.set('sync.json',{runId,stage:'complete'});};
const queue=()=>JSON.parse(sql(file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
const runOf=runId=>JSON.parse(sql(file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+runId+"'")[0].d);
const leaseOf=()=>JSON.parse(sql(file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0]?.d||'null');
const resetLease=()=>{for(const name of ['runner','writer'])sql(file,"UPDATE prediction_lease SET expires_at=1, document_json=json_set(document_json,'$.expiresAt',1) WHERE name='"+name+"'");};
const lines=()=>logs.filter(l=>l.includes('prediction_boundary_failed')).map(l=>JSON.parse(l));
const measured=async(work)=>{const q0=stats.queries,full0=stats.fullReads,id0=stats.idReads,t0=performance.now();const value=await work();return {value,queries:stats.queries-q0,fullReads:stats.fullReads-full0,idReads:stats.idReads-id0,ms:performance.now()-t0};};
const start=(body={})=>api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100},...body});
const submit=(m,items)=>api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items});
const item=id=>({filmId:id,fingerprint,prediction});

// 1. The queue exists (a quiet Discovery built it: the EPG tail / resolver checkpoint refresh). Then Discovery storms and batch runs drain it end to end.
const built=await measured(()=>api('queue/reconcile',{}));
assert.equal(built.value.status,200);assert.equal(queue().pending.length+queue().coldPending.length>0,true);
assert.equal(queue().hotPending.length,HOT,'hot films in the queue');assert.equal(queue().programmeRunId,'p1');
console.log('full rebuild (reconcile): queries',built.queries,'whole-catalog reads',built.fullReads,'ms',built.ms.toFixed(0));
stats.storm=true;
// AIR-493: a generation-only storm is not a torn catalog. The rebuild is one SELECT; retries of `discovery_fence` are unused.
const control=await measured(()=>api('queue/reconcile',{}));
assert.equal(control.value.status,200,'a catalog snapshot rebuild survives a generation-only storm: '+JSON.stringify(control.value.data).slice(0,200));
assert.equal(control.fullReads,1,'no generation-fence retries of the catalog SELECT');

logs.length=0;
let progressReads=0,runs=0;const predicted=new Set(),steps={start:[],submit:[],complete:[]};
for(let guard=0;guard<10;guard++){
 const started=await measured(()=>start());steps.start.push(started);
 assert.equal(started.value.status,200,JSON.stringify(started.value.data).slice(0,300));
 if(started.value.data.status==='noop')break;
 assert.equal(started.value.data.status,'running');assert.equal(started.value.data.queueStale,undefined,'a start under a generation storm reads a readable catalog, not a stale fallback');
 const m=started.value.data,ids=m.films.map(f=>f.filmId);runs++;
 for(let at=0;at<ids.length;at+=10){
  const sub=await measured(()=>submit(m,ids.slice(at,at+10).map(item)));steps.submit.push(sub);
  assert.equal(sub.value.status,200,'submit '+JSON.stringify(sub.value.data).slice(0,300));assert.equal(sub.idReads,0,'submit reads no catalog film at all');
  // The only whole-catalog read a submit may make is the periodic progress Event (every 50 results), which is best effort and never fails the step.
  if(sub.fullReads)progressReads++;assert.ok(sub.fullReads<=1,'submit whole-catalog reads '+sub.fullReads);
  for(const r of sub.value.data.results){assert.equal(r.status,'created');assert.ok(!predicted.has(r.filmId),'no film is predicted twice');predicted.add(r.filmId);}
  const q=queue();assert.ok(!sub.value.data.results.some(r=>q.pending.includes(r.filmId)||q.hotPending.includes(r.filmId)||q.coldPending.includes(r.filmId)||q.priority[r.filmId]||q.work?.[r.filmId]),'settled films left the queue');
  assert.equal(q.priorityCount,q.hotPending.length);assert.equal(q.coldRemaining,q.coldPending.length);assert.equal(sub.value.data.remaining,q.pending.length);
 }
 const remaining=queue().pending.length+queue().coldPending.length;
 const done=await measured(()=>api('complete',{runId:m.runId,...(remaining?{reason:'manifest_spent'}:{})}));steps.complete.push(done);
 assert.equal(done.value.status,200,JSON.stringify(done.value.data).slice(0,300));assert.equal(done.value.data.status,'complete');assert.ok(done.fullReads<=1,'complete reads the catalog at most once, for its Event coverage (best effort): '+done.fullReads);
 assert.equal(runOf(m.runId).status,'complete');assert.equal(queue().lastBatch.runId,m.runId);
 if(!remaining)assert.equal(done.value.data.snapshot.coverage?.confirmedFilmsTotal,TOTAL,'coverage is computed from the readable catalog snapshot under a generation storm');
}
assert.ok(progressReads<=Math.ceil(TOTAL/50)+runs,'progress Event reads '+progressReads);
assert.equal(predicted.size,TOTAL,'every film of the catalog was predicted across '+runs+' runs while Discovery kept writing');
assert.ok(runs>=2,'at least two sequential batch runs (the manifest holds at most 100 films)');
assert.equal(queue().hotPredicted,HOT,'hot counter follows the settled films');assert.equal(queue().priorityCount,0);assert.equal(queue().coldRemaining,0);assert.equal(queue().pending.length,0);
assert.equal(queue().metrics.hotProcessedTotal,HOT);
assert.equal(lines().length,0,'no failed prediction boundary during the whole drain: '+JSON.stringify(lines()).slice(0,300));
assert.ok(!logs.some(l=>l.includes('discovery_fence')),'no discovery_fence reached the runner');
assert.ok(leaseOf().expiresAt<=Date.now(),'the lease was released, not left to expire');
const mean=list=>list.length?list.reduce((a,b)=>a+b,0)/list.length:0;
console.log('drain under storm:',runs,'runs,',steps.submit.length,'submits; mean D1 queries per start',mean(steps.start.map(s=>s.queries)).toFixed(2),'per submit',mean(steps.submit.map(s=>s.queries)).toFixed(2),'per complete',mean(steps.complete.map(s=>s.queries)).toFixed(2),'; mean ms per submit',mean(steps.submit.map(s=>s.ms)).toFixed(0),'; rebuild was',built.queries,'queries');

// 2. Idempotent replay: the same submit again is a replay and settles nothing twice. A film whose admission disappears before a start is settled out of the
//    queue by that start and never delivered.
{
 stats.storm=false;resetLease();
 insertAdmissions([film(TOTAL+1,now)]);
 assert.equal((await api('queue/reconcile',{})).status,200);
 stats.storm=true;resetLease();
 const second=(await start()).data;assert.equal(second.status,'running');assert.deepEqual(second.films.map(f=>f.filmId),['tmdb_'+(TOTAL+1)]);
 const one=(await submit(second,[item('tmdb_'+(TOTAL+1))])).data;assert.equal(one.results[0].status,'created');
 const predictedWas=queue().hotPredicted;
 const replay=(await submit(second,[item('tmdb_'+(TOTAL+1))])).data;assert.equal(replay.results[0].replayed,true);
 assert.equal(queue().hotPredicted,predictedWas,'a replayed submit settles nothing twice');
 assert.equal((await api('complete',{runId:second.runId})).status,200);
 stats.storm=false;resetLease();
 insertAdmissions([film(TOTAL+2,now),film(TOTAL+4,now)]);assert.equal((await api('queue/reconcile',{})).status,200);
 sql(file,"UPDATE discovery_admission SET state='superseded' WHERE film_id='tmdb_"+(TOTAL+4)+"'");
 stats.storm=true;
 const third=(await start()).data;assert.equal(third.status,'running',JSON.stringify(third).slice(0,300));
 assert.ok(!third.films.some(f=>f.filmId==='tmdb_'+(TOTAL+4)),'a superseded film is never offered');
 assert.ok(!queue().pending.includes('tmdb_'+(TOTAL+4)),'and it is out of the queue');
 assert.equal((await submit(third,third.films.map(f=>item(f.filmId)))).status,200);assert.equal((await api('complete',{runId:third.runId})).status,200);
}

// 3. A published programme transition does not stop the run and does not rebuild inside a submit (ADR 0154).
//    Priority moves on the named refresh, not on this step. A generation-only storm does not hold the step.
{
 stats.storm=false;resetLease();publish('p3');insertAdmissions([film(TOTAL+5,now),film(TOTAL+6,now)]);assert.equal((await api('queue/reconcile',{})).status,200);resetLease();
 const run3=(await start()).data;assert.equal(run3.status,'running',JSON.stringify(run3).slice(0,300));
 publish('p4');stats.storm=true;logs.length=0;
 const step=await submit(run3,[item(run3.films[0].filmId)]);
 assert.equal(step.status,200,JSON.stringify(step.data).slice(0,300));
 assert.equal(runOf(run3.runId).status,'running','the run keeps its lease and is not stopped');
 assert.equal(queue().programmeRunId,'p3','a submit does not rebuild the queue just because the published programme changed');
 assert.equal((await api('complete',{runId:run3.runId,reason:'external_termination'})).status,200);
}
// 4. Reads stay independent of the storm: enrichment status reads no catalog and still reports the queue; the queue
//    overview stays eligible/ready. The catalog snapshot is readable under a generation-only storm (ADR 0147).
{
 stats.storm=false;resetLease();publish('p5');assert.equal((await api('queue/reconcile',{})).status,200);
 stats.storm=true;
 const statusRead=await measured(async()=>{const r=await w.ctx.worker.fetch(new Request('https://site.example/api/enrichment/status'),env);return {status:r.status,data:await r.json()};});
 assert.equal(statusRead.value.status,200);assert.equal(statusRead.fullReads,0,'status reads no whole catalog');assert.equal(statusRead.idReads,0);
 assert.ok(statusRead.value.data.queue.pendingCount>0);
 w.ctx.env=env;if(typeof w.ctx.predictionQueueOverview!=='function')vm.runInContext(fs.readFileSync('src/prediction-diagnostics.js','utf8'),w.ctx);
 const view=await vm.runInContext('(async()=>predictionQueueOverview(await loadPredictionDiagnosticSnapshot(env),Date.now()))()',w.ctx);
 assert.equal(view.state,'eligible');assert.equal(view.cause,'ready');
 assert.ok(!view.snapshot.reasons.includes('catalog_unavailable'),JSON.stringify(view.snapshot.reasons));
 assert.ok(['object'].includes(typeof statusRead.value.data.discovery)||statusRead.value.data.discovery===null);
}
// 6. AIR-431 review: a start whose stored queue lists films with no admission any more settles them out and takes replacements; it never repeats a
//    manifest of missing films. First N missing, then every film missing (eventual progress, then an honest noop).
{
 stats.storm=false;resetLease();publish('p9');
 insertAdmissions(Array.from({length:40},(_,k)=>film(5001+k,now)));assert.equal((await api('queue/reconcile',{})).status,200);
 const gone=queue().hotPending.slice(0,25);assert.equal(gone.length,25,'more than one group of missing films');
 sql(file,"UPDATE discovery_admission SET state='superseded' WHERE film_id IN ("+gone.map(id=>"'"+id+"'").join(',')+")");
 stats.storm=true;resetLease();
 const partial=await start();
 assert.equal(partial.status,200,JSON.stringify(partial.data).slice(0,300));assert.equal(partial.data.status,'running');
 assert.ok(partial.data.films.length>0&&partial.data.films.every(f=>!gone.includes(f.filmId)),'replacements were delivered, none of the missing films');
 assert.ok(gone.every(id=>!queue().pending.includes(id)&&!queue().hotPending.includes(id)&&!queue().coldPending.includes(id)&&!queue().priority[id]),'the missing films left the queue');
 assert.equal(queue().priorityCount,queue().hotPending.length);
 assert.equal((await api('complete',{runId:partial.data.runId,reason:'external_termination'})).status,200);
 // Every remaining film missing: a batch start delivers nothing and takes no lease (its idle outcome comes before any settlement, unlike the retired
 // v5 start, which settled them and answered noop); the named queue refresh drops the missing films, and the next start has nothing to repeat.
 sql(file,"UPDATE discovery_admission SET state='superseded' WHERE state='current'");
 resetLease();
 const emptied=await start();
 assert.equal(emptied.status,200,JSON.stringify(emptied.data).slice(0,300));assert.ok(['noop','blocked'].includes(emptied.data.status),JSON.stringify(emptied.data).slice(0,400));assert.equal(emptied.data.runId,null,'no run is created');
 assert.equal((await api('queue/reconcile',{})).status,200);
 assert.equal(queue().pending.length+queue().coldPending.length,0,'the queue holds none of the missing films');
 resetLease();assert.equal((await start()).data.status,'noop');
 sql(file,"UPDATE discovery_admission SET state='current' WHERE CAST(tmdb_id AS INTEGER)<="+(TOTAL+2));
 sql(file,"UPDATE discovery_admission SET state='superseded' WHERE CAST(tmdb_id AS INTEGER)>"+(TOTAL+2));
}

// 7. AIR-431 review: the gate holds inside the conditional write. A reconcile that rebuilds the queue for a newer programme between the step's gate
//    and its write (a forced D1 queue-generation conflict) makes the retried mutation see the new generation, and the old settlement does not touch it.
{
 stats.storm=false;resetLease();publish('p10');
 insertAdmissions(Array.from({length:30},(_,k)=>film(6001+k,now)));assert.equal((await api('queue/reconcile',{})).status,200);resetLease();
 const run7=(await start({manifestSize:1})).data;assert.equal(run7.status,'running',JSON.stringify(run7).slice(0,300));
 const filmId=run7.films[0].filmId;
 // The concurrent writer runs once, just before the submit's first queue write reaches D1. In the newer generation the submitted film is pending again
 // (as if its prediction had not counted there): the old settlement must not remove it.
 const original=env.DB.batch.bind(env.DB);let forced=0;
 const interfere=work=>{env.DB.batch=async statements=>{if(!forced&&statements.some(s=>/prediction_queue/i.test(s.text)&&!/^\s*SELECT/i.test(s.text))){forced++;env.DB.batch=original;await work();}return original(statements);};};
 interfere(async()=>{publish('p11');const r=await api('queue/reconcile',{});assert.equal(r.status,200);const head=await PredictionD1.openQueue(env),q=head.queue;if(!q.hotPending.includes(filmId)){q.hotPending.push(filmId);q.pending.push(filmId);q.priorityCount=q.hotPending.length;q.priority[filmId]={hot:true,rank:1};assert.ok(await PredictionD1.writeQueue(env,head,q));}});
 const sub=await submit(run7,[item(filmId)]);env.DB.batch=original;
 assert.equal(forced,1,'the conflict was forced');assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,300));assert.equal(sub.data.results[0].status,'created');
 assert.equal(queue().programmeRunId,'p11','the newer generation is what is stored');assert.equal(queue().trigger,'manual_reconcile','the old settlement did not write over it');assert.equal(queue().advancedAt,undefined);assert.ok(queue().hotPending.includes(filmId),'the newer generation still lists the film: the old settlement was refused by the gate inside the write');
 // Complete: the completion's own queue write meets the same conflict. The new generation keeps its lastBatch and counters; the run is still completed.
 const metricsBefore=JSON.stringify(queue().metrics?.hotProcessedTotal);
 forced=0;interfere(async()=>{publish('p12');const r=await api('queue/reconcile',{});assert.equal(r.status,200);});
 const fin=await api('complete',{runId:run7.runId,reason:'manifest_spent'});env.DB.batch=original;
 assert.equal(forced,1,'the conflict was forced for the completion');assert.equal(fin.status,200,JSON.stringify(fin.data).slice(0,300));assert.ok(['complete','partial'].includes(fin.data.status));
 assert.equal(queue().programmeRunId,'p12');assert.notEqual(queue().lastBatch?.runId,run7.runId,'the new generation keeps its own lastBatch');
 assert.equal(JSON.stringify(queue().metrics?.hotProcessedTotal),metricsBefore,'its counters were not moved by the old completion');
 assert.equal(runOf(run7.runId).status,fin.data.status);
}

// 5. readAdmissionsById: indexed lookups in chunks, current rows only, one authority check, closed like routeRead.
{
 stats.storm=false;
 const ids=Array.from({length:250},(_,k)=>'tmdb_'+(k+1)).concat(['tmdb_missing']);
 const before=stats.idReads,q0=stats.queries;
 const found=await Authority.readAdmissionsById(env,ids);
 assert.equal(found.handled,true);assert.equal(stats.idReads-before,Math.ceil(ids.length/Authority.ADMISSION_IDS_PER_QUERY),'one statement per chunk of '+Authority.ADMISSION_IDS_PER_QUERY+' ids');
 assert.ok(stats.queries-q0<=stats.idReads-before+8,'a constant number of authority reads beside the chunks');
 assert.equal(found.films.size,TOTAL+2,'the admitted films among the ids (the catalog plus the two admitted in scenario 2; the later ones are superseded and the missing id is absent)');assert.equal(found.films.get('tmdb_7').tmdbId,'7');
 sql(file,"UPDATE discovery_admission SET state='superseded' WHERE film_id='tmdb_7'");
 assert.ok(!(await Authority.readAdmissionsById(env,['tmdb_7','tmdb_8'])).films.has('tmdb_7'),'a superseded admission is not current');
 assert.equal((await Authority.readAdmissionsById(env,[])).films.size,0,'no ids, no statement');
 sql(file,"UPDATE discovery_authority SET cutover='held' WHERE id=1");
 await assert.rejects(Authority.readAdmissionsById(env,['tmdb_8']),error=>error.code==='discovery_fence','a held cutover is a fence, never "absent"');
 sql(file,"UPDATE discovery_authority SET cutover='open' WHERE id=1");
 sql(file,"UPDATE discovery_transfer SET state='loading', programme_run_id='x' WHERE id=1");
 sql(file,"UPDATE discovery_admission SET state='pending' WHERE film_id='tmdb_9'");
 await assert.rejects(Authority.readAdmissionsById(env,['tmdb_8']),error=>error.code==='discovery_incomplete','a catalog load in progress is incomplete');
 sql(file,"UPDATE discovery_transfer SET state='idle', programme_run_id=NULL WHERE id=1");
 sql(file,"UPDATE discovery_admission SET state='current' WHERE film_id='tmdb_9'");
 sql(file,"UPDATE discovery_authority SET mode='r2' WHERE id=1");
 assert.deepEqual(await Authority.readAdmissionsById(env,['tmdb_8']),{handled:false},'outside D1 authority the R2 catalog serves');
}
console.log('prediction queue / discovery independence tests passed');
