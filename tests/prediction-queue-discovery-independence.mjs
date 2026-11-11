// AIR-431. The Prediction queue advances on its own state while Discovery keeps writing. Production: every next/submit/complete rebuilt the queue from
// the whole catalog, each rebuild was a fenced read against the Discovery generation, and a Discovery chunk landing between its statements failed it
// (`discovery_fence`), so a run stalled in 503 waits until its lease expired. Here the Worker runs in a vm on an in-memory R2 and a real Discovery
// authority on a local sqlite D1 stand-in, and every catalog query moves the Discovery generation (a chunk landing on each statement).
// Local stand-ins only; nothing here calls Cloudflare, TMDB or production.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {d1Standin} from './d1-standin.mjs';
import {migrated,sql} from './discovery-paged-write.mjs';

const records=new Map(),etags=new Map();let revision=0;const reads=new Map();
const env={BUCKET:{async get(key){reads.set(key,(reads.get(key)||0)+1);return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)}},list:async()=>({objects:[],truncated:false})}};
const logs=[];const capture={log:()=>{},info:()=>{},error:(...a)=>logs.push(a.join(' ')),warn:(...a)=>logs.push(a.join(' '))};
const file=migrated();
sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
// The storm: while on, every query against the admission table moves the generation, as a Discovery chunk committing between two statements does.
const stats={storm:false,fullReads:0,idReads:0,queries:0};
const db=d1Standin(file,{onQuery:text=>{
 stats.queries++;
 if(/FROM discovery_admission WHERE state='current' ORDER BY film_id/.test(text))stats.fullReads++;
 else if(/FROM discovery_admission WHERE state='current' AND film_id IN/.test(text))stats.idReads++;
 if(stats.storm&&/FROM discovery_admission/.test(text))sql(file,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');
}});
env.DB=db;
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:capture,DiscoveryAuthority:Authority,encodeURIComponent,decodeURIComponent});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const f of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(f,'utf8').replace('export default','globalThis.worker='),ctx);
async function api(path,body){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);return {status:r.status,data:await r.json()}}
const lines=()=>logs.filter(l=>l.includes('prediction_boundary_failed')).map(l=>JSON.parse(l));
const resetLease=()=>{const lease=records.get('enrichment/runner-lease.json');if(lease)lease.expiresAt=0;const writer=records.get('enrichment/writer-lease.json');if(writer)writer.expiresAt=0;};

const now=Date.now(),HOT=60,COLD=140,TOTAL=HOT+COLD;
const film=(n,start)=>({id:'tmdb_'+n,title:'tmdb_'+n,original:'tmdb_'+n,year:2020,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,genres:[],actors:[],directors:[],shows:[{start}]});
const catalogFilms=[];for(let n=1;n<=TOTAL;n++)catalogFilms.push(film(n,n<=HOT?now:now-10*86400000));
const insertAdmissions=films=>{for(let at=0;at<films.length;at+=50)sql(file,"INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES "+films.slice(at,at+50).map(f=>"('"+f.id+"','"+f.tmdbId+"','movie','"+f.canonicalIdentity+"',NULL,NULL,1,'current','"+JSON.stringify(f).replace(/'/g,"''")+"')").join(','));};
insertAdmissions(catalogFilms);
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});
const publish=runId=>{records.set('programme.json',{runId,films:[]});records.set('sync.json',{runId,stage:'complete'});};
publish('p1');

const EXECUTION=JSON.parse(JSON.stringify(vm.runInContext('EXECUTION',ctx)));
const execution=Object.fromEntries(Object.entries(EXECUTION).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['heist','investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
const queue=()=>records.get('enrichment/prediction-queue.json');
const measured=async(work)=>{const q0=stats.queries,full0=stats.fullReads,id0=stats.idReads,t0=performance.now();const value=await work();return {value,queries:stats.queries-q0,fullReads:stats.fullReads-full0,idReads:stats.idReads-id0,ms:performance.now()-t0};};

// 1. The queue exists (a quiet Discovery built it: the EPG tail / resolver checkpoint refresh). Then Discovery storms and a run drains it end to end.
const built=await measured(()=>api('queue/reconcile',{}));
assert.equal(built.value.status,200);assert.equal(queue().pending.length+queue().coldPending.length>0,true);
assert.equal(queue().hotPending.length,HOT,'hot films in the queue');assert.equal(queue().programmeRunId,'p1');
console.log('full rebuild (reconcile): queries',built.queries,'whole-catalog reads',built.fullReads,'ms',built.ms.toFixed(0));
stats.storm=true;
// The control: with the storm on a whole-catalog read is the failure of production, the bounded retry does not hide a storm that never stops.
const control=await measured(()=>api('queue/reconcile',{}));
assert.ok(control.value.status>=500||control.value.data?.error,'a rebuild under a continuous storm fails: '+JSON.stringify(control.value.data).slice(0,200));
assert.ok(control.fullReads>=3,'bounded retries of the fenced catalog read: '+control.fullReads);

resetLease();logs.length=0;
const started=await measured(()=>api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}}));
assert.equal(started.value.status,200,JSON.stringify(started.value.data));assert.equal(started.value.data.status,'running');
assert.equal(started.value.data.queueStale?.reason,'discovery_fence','start under a storm runs on the persisted queue and says so');
const run=started.value.data;
console.log('start under storm: queries',started.queries,'whole-catalog reads (bounded retries)',started.fullReads,'by-id reads',started.idReads,'ms',started.ms.toFixed(0));
let progressReads=0,predicted=new Set(),batches=0,steps={next:[],submit:[],complete:null};
for(let guard=0;guard<200;guard++){
 const step=await measured(()=>api('next',{runId:run.runId,batchSize:20}));steps.next.push(step);
 assert.equal(step.value.status,200,'next '+guard+' '+JSON.stringify(step.value.data).slice(0,300));
 assert.equal(step.fullReads,0,'next reads no whole catalog');
 const items=step.value.data.items;
 if(step.value.data.mustComplete){assert.equal(step.value.data.stopReason,'queue_empty');break;}
 if(!items.length)continue;
 batches++;
 for(let at=0;at<items.length;at+=10){
  const payload={runId:run.runId,items:items.slice(at,at+10).map(item=>({filmId:item.filmId,fingerprint,prediction}))};
  const sub=await measured(()=>api('submit',payload));steps.submit.push(sub);
  assert.equal(sub.value.status,200,'submit '+JSON.stringify(sub.value.data).slice(0,300));assert.equal(sub.idReads,0,'submit reads no catalog film at all');
  // The only whole-catalog read a submit may make is the periodic progress Event (every 50 results), which is best effort and never fails the step.
  if(sub.fullReads)progressReads++;assert.ok(sub.fullReads<=1,'submit whole-catalog reads '+sub.fullReads);
  for(const r of sub.value.data.results){assert.equal(r.status,'created');assert.ok(!predicted.has(r.filmId),'no film is predicted twice');predicted.add(r.filmId);}
  const q=queue();assert.ok(!sub.value.data.results.some(r=>q.pending.includes(r.filmId)||q.hotPending.includes(r.filmId)||q.coldPending.includes(r.filmId)||q.priority[r.filmId]||q.work?.[r.filmId]),'settled films left the queue');
  assert.equal(q.priorityCount,q.hotPending.length);assert.equal(q.coldRemaining,q.coldPending.length);assert.equal(sub.value.data.remaining,q.pending.length);
 }
}
assert.ok(progressReads<=Math.ceil(TOTAL/50),'progress Event reads '+progressReads);
assert.equal(predicted.size,TOTAL,'every film of the catalog was predicted across '+batches+' batches while Discovery kept writing');
assert.ok(batches>=2,'at least two full sequential runner batches');
assert.equal(queue().hotPredicted,HOT,'hot counter follows the settled films');assert.equal(queue().priorityCount,0);assert.equal(queue().coldRemaining,0);assert.equal(queue().pending.length,0);
const done=await measured(()=>api('complete',{runId:run.runId}));steps.complete=done;
assert.equal(done.value.status,200,JSON.stringify(done.value.data).slice(0,300));assert.equal(done.value.data.status,'complete');assert.ok(done.fullReads<=1,'complete reads the catalog at most once, for its Event coverage (best effort): '+done.fullReads);
assert.equal(done.value.data.snapshot.coverage,null,'coverage is unknown under the storm, never computed from a missing catalog');
assert.equal(records.get('enrichment/runs/'+run.runId+'.json').status,'complete');
assert.equal(queue().lastBatch.runId,run.runId);assert.equal(queue().metrics.hotProcessedTotal,HOT);
assert.equal(lines().length,0,'no failed prediction boundary during the whole run: '+JSON.stringify(lines()).slice(0,300));
assert.ok(!logs.some(l=>l.includes('discovery_fence')),'no discovery_fence reached the runner');
assert.equal(records.get('enrichment/runner-lease.json').expiresAt,0,'the lease was released, not left to expire');
const mean=list=>list.length?list.reduce((a,b)=>a+b,0)/list.length:0;
console.log('run under storm:',batches,'batches,',steps.next.length,'next,',steps.submit.length,'submit; mean D1 queries per next',mean(steps.next.map(s=>s.queries)).toFixed(2),'per submit',mean(steps.submit.map(s=>s.queries)).toFixed(2),'complete',done.queries,'; mean ms per next',mean(steps.next.map(s=>s.ms)).toFixed(0),'submit',mean(steps.submit.map(s=>s.ms)).toFixed(0),'; rebuild was',built.queries,'queries /',built.ms.toFixed(0),'ms');

// 2. Idempotent replay: the same submit again is already_current and settles nothing twice.
{
 stats.storm=false;resetLease();
 insertAdmissions([film(TOTAL+1,now)]);
 assert.equal((await api('queue/reconcile',{})).status,200);
 stats.storm=true;resetLease();
 const second=(await api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}})).data;assert.equal(second.status,'running');
 const first=(await api('next',{runId:second.runId,batchSize:1})).data;assert.equal(first.items[0].filmId,'tmdb_'+(TOTAL+1));
 const payload={runId:second.runId,items:[{filmId:first.items[0].filmId,fingerprint,prediction}]};
 const one=(await api('submit',payload)).data;assert.equal(one.results[0].status,'created');
 const predictedWas=queue().hotPredicted;
 const replay=(await api('submit',payload)).data;assert.equal(replay.results[0].status,'already_current');
 assert.equal(queue().hotPredicted,predictedWas,'a replayed submit settles nothing twice');
 // A film whose admission disappears between the queue write and a step is dropped from the queue, not left to stall the run.
 stats.storm=false;resetLease();
 insertAdmissions([film(TOTAL+2,now),film(TOTAL+3,now)]);assert.equal((await api('queue/reconcile',{})).status,200);
 stats.storm=true;resetLease();
 const third=(await api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}})).data;assert.equal(third.status,'running');
 sql(file,"UPDATE discovery_admission SET state='superseded' WHERE film_id='tmdb_"+(TOTAL+3)+"'");
 // The start already selected both; a later batch picks metadata by id, so supersede a film the run has not selected yet.
 stats.storm=false;
 insertAdmissions([film(TOTAL+4,now)]);assert.equal((await api('queue/reconcile',{})).status,200);
 sql(file,"UPDATE discovery_admission SET state='superseded' WHERE film_id='tmdb_"+(TOTAL+4)+"'");
 stats.storm=true;
 const progressAnswer=await api('next',{runId:third.runId,batchSize:20}),progress=progressAnswer.data;assert.equal(progressAnswer.status,200,JSON.stringify(progress).slice(0,300));
 assert.ok(!progress.items.some(i=>i.filmId==='tmdb_'+(TOTAL+4)),'a superseded film is never offered');
 assert.ok(!queue().pending.includes('tmdb_'+(TOTAL+4)),'and it is out of the queue');
}

// 3. A published programme transition: the persisted queue belongs to the old programme, so a rebuild is required; under a storm that is the old,
//    honest wait (503 catalog_held, lease kept), and once the storm ends the run continues on the new generation.
{
 stats.storm=false;resetLease();publish('p3');assert.equal((await api('queue/reconcile',{})).status,200);resetLease();
 const run3=(await api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}})).data;assert.equal(run3.status,'running',JSON.stringify(run3));
 publish('p4');stats.storm=true;logs.length=0;
 const waiting=await api('next',{runId:run3.runId,batchSize:20});
 assert.equal(waiting.status,503,JSON.stringify(waiting.data).slice(0,300));assert.equal(waiting.data.code,'prediction_catalog_held');assert.equal(waiting.data.cause,'discovery_fence');
 assert.equal(records.get('enrichment/runs/'+run3.runId+'.json').status,'running','the run keeps its lease and is not stopped');
 stats.storm=false;
 const resumed=await api('next',{runId:run3.runId,batchSize:20});assert.equal(resumed.status,200,JSON.stringify(resumed.data).slice(0,300));
 assert.equal(queue().programmeRunId,'p4','the queue was rebuilt on the published programme');
}
// 4. Reads stay independent of the storm: enrichment status reads no catalog and still reports the queue; the queue overview reports the working queue as
//    eligible (the unreadable catalog only makes the snapshot partial, it never turns a queue with ready work into "unavailable").
{
 stats.storm=false;resetLease();publish('p5');assert.equal((await api('queue/reconcile',{})).status,200);
 stats.storm=true;ctx.env=env;
 const statusRead=await measured(async()=>{const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/status'),env);return {status:r.status,data:await r.json()};});
 assert.equal(statusRead.value.status,200);assert.equal(statusRead.fullReads,0,'status reads no whole catalog');assert.equal(statusRead.idReads,0);
 assert.equal(statusRead.value.data.selectedCount,queue().hotCount+queue().coldCount);assert.ok(statusRead.value.data.queue.pendingCount>0);
 const view=await vm.runInContext('(async()=>predictionQueueOverview(await loadPredictionDiagnosticSnapshot(env),Date.now()))()',ctx);
 assert.equal(view.state,'eligible');assert.equal(view.cause,'ready');assert.equal(view.snapshot.partial,true,'the unreadable catalog is reported as partial');
 assert.ok(view.snapshot.reasons.includes('catalog_unavailable'),JSON.stringify(view.snapshot.reasons));
 // The enrichment status also survives an unreadable Discovery status record.
 assert.ok(['object'].includes(typeof statusRead.value.data.discovery)||statusRead.value.data.discovery===null);
}
// 5. readAdmissionsById: indexed lookups in chunks, current rows only, one authority check, closed like routeRead.
{
 stats.storm=false;
 const ids=Array.from({length:250},(_,k)=>'tmdb_'+(k+1)).concat(['tmdb_missing']);
 const before=stats.idReads,q0=stats.queries;
 const found=await Authority.readAdmissionsById(env,ids);
 assert.equal(found.handled,true);assert.equal(stats.idReads-before,Math.ceil(ids.length/Authority.ADMISSION_IDS_PER_QUERY),'one statement per chunk of '+Authority.ADMISSION_IDS_PER_QUERY+' ids');
 assert.ok(stats.queries-q0<=stats.idReads-before+8,'a constant number of authority reads beside the chunks');
 assert.equal(found.films.size,TOTAL+2,'the admitted films among the ids (the catalog plus the two admitted in scenario 2; the two superseded ones and the missing id are absent)');assert.equal(found.films.get('tmdb_7').tmdbId,'7');
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
