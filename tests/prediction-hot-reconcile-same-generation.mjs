// AIR-529. New Discovery show assignments inside the SAME published EPG generation must reach the Prediction hot/cold queue before the next batch selects.
// Part 1: the real `PublishedEpg.assignedShowsSignature` on a migrated sqlite D1 stand-in. Part 2: the batch preflight/start on the flow world with a D1 pin stub:
// a queue ranked on an old signature of the unchanged `programmeRunId` is rebuilt by the NEXT natural batch start (cold films that now air become hot, no new generation),
// an unchanged signature rebuilds nothing, and an unreadable signature never forces a rebuild. Local stand-ins only; nothing here calls Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import * as PublishedEpg from '../src/published-epg.js';
import * as PredictionD1 from '../src/prediction-d1.js';
import {flowWorld,sql,migrated} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';

// 1. The signature: exact content, not an aggregate.
{
 const made=migrated();const file=made.file||made;
 const db=d1Standin(file);
 const ins=(run,film,start,basis,channel='c')=>sql(file,"INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('"+run+"','"+film+"','"+channel+"',"+start+",NULL,'C',NULL,'"+basis+"','k')");
 const sig=run=>PublishedEpg.assignedShowsSignature({DB:db},run);
 const empty=await sig('r1');assert.match(empty,/^0:[0-9a-f]{24}$/,'no assigned row');assert.equal(await sig(null),null);
 ins('r1','f1',1,'epg');assert.equal(await sig('r1'),empty,'sealed rows are not assignments');
 // The reviewer's case: the only assigned slot is reassigned from one film to another. The freed rowid is reused and the old aggregates were equal.
 ins('r1','tmdb_123456',1000,'discovery');const a=await sig('r1');assert.match(a,/^1:/);
 sql(file,"DELETE FROM published_epg_show WHERE programme_run_id='r1' AND basis='discovery'");ins('r1','tmdb_223456',1000,'discovery');
 assert.equal(sql(file,"SELECT rowid AS r FROM published_epg_show WHERE film_id='tmdb_223456'")[0].r,sql(file,"SELECT rowid AS r FROM published_epg_show WHERE film_id='f1'")[0].r+1,'the stand-in reuses the rowid sequence as SQLite does');
 const reassigned=await sig('r1');assert.notEqual(reassigned,a,'a reassignment of the only slot to another film moves the signature');
 // Same film, other channel; same film and channel, other start.
 sql(file,"UPDATE published_epg_show SET channel_id='d' WHERE film_id='tmdb_223456'");const channel=await sig('r1');assert.notEqual(channel,reassigned);
 sql(file,"UPDATE published_epg_show SET start_ms=1001 WHERE film_id='tmdb_223456'");assert.notEqual(await sig('r1'),channel);
 ins('r2','f9',3,'discovery');assert.equal(await sig('r1'),await sig('r1'),'stable');
 // Scale: 3,600 assigned shows of one generation, one read of the run's rows each, and the cost recorded.
 for(let at=0;at<3600;at+=100){sql(file,"INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES "+Array.from({length:100},(_,i)=>"('big','tmdb_"+(at+i)+"','c',"+(at+i)+",NULL,'C',NULL,'discovery','k')").join(','));}
 let queries=0;const counted=d1Standin(file,{onQuery:()=>{queries++;}});
 const t0=performance.now();const big=await PublishedEpg.assignedShowsSignature({DB:counted},'big');const ms=performance.now()-t0;
 assert.match(big,/^3600:/);assert.equal(queries,1,'one statement per signature read');
 const t1=performance.now();for(let i=0;i<5;i++)await PublishedEpg.assignedShowsSignature({DB:counted},'big');
 console.log('signature of 3,600 assigned shows:',ms.toFixed(1),'ms (first),',((performance.now()-t1)/5).toFixed(1),'ms (mean of 5 repeats), 1 statement, rows read',3600);
 sql(file,"DELETE FROM published_epg_show WHERE programme_run_id='big' AND film_id='tmdb_7'");sql(file,"INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('big','tmdb_9999','c',7,NULL,'C',NULL,'discovery','k')");
 assert.notEqual(await PublishedEpg.assignedShowsSignature({DB:counted},'big'),big,'one swapped film among 3,600 moves it');
}

// 2. The batch start, on 3,200 catalog films under one fixed generation `p1`.
const now=Date.now(),TOTAL=3200;
const w=await flowWorld({films:TOTAL,extra:()=>({shows:[{start:now-10*86400000}]})});
const {file,records,ctx}=w;const api=async(...args)=>{const r=await w.api(...args);await reload();return r;};
let signature='s0',mode='ok',reads=0;
ctx.PublishedEpg={
 currentGeneration:async()=>({authority:'d1',programmeRunId:'p1',phase:'published',fence:'d1:1:p1',generation:1}),
 readDocumentAt:async(env,run,kind)=>records.get(kind==='watchlist'?'watchlist.json':'programme.json')??null,
 assignedShowsSignature:async()=>{reads++;if(mode==='down')throw new Error('d1 down');return signature;},
};
// The completed programme: `catalogFilms` with the assigned shows of the first `n` films at this instant (what the completed read returns after Discovery inserted the rows).
const assign=(n,sig)=>{records.set('programme.json',{runId:'p1',films:[],catalogFilms:Array.from({length:n},(_,i)=>({tmdbId:String(i+1),shows:[{channelId:'c',channel:'C',start:now-600000,end:now+7200000,basis:'discovery'}]}))});signature=sig;};
records.set('sync.json',{runId:'p1',stage:'complete'});assign(0,'s0');
let stored=null;const reload=async()=>{stored=(await PredictionD1.openQueue(w.env)).queue;};const queue=()=>stored;
const release=()=>sql(file,"UPDATE prediction_lease SET expires_at=1, document_json=json_set(document_json,'$.expiresAt',1)");
const body={scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100}};
const realStart=async()=>{release();const r=await api('batch/start',body);if(r.data?.runId&&r.data.status==='running')await api('complete',{runId:r.data.runId,reason:'manifest_spent'});return r;};
const dry=()=>api('batch/start',{...body,dryRun:true});
const hot=()=>queue().hotPending.length;
const built=await api('queue/reconcile',{});assert.equal(built.status,200,JSON.stringify(built.data).slice(0,300));
assert.equal(queue().showsSignature,'s0','the queue stores the signature it was ranked on');assert.equal(hot(),0,'all 3,200 films are cold');assert.equal(queue().coldPending.length,TOTAL);

// Unchanged signature: a start rebuilds nothing.
{const before=queue().refreshedAt,r=await realStart();assert.equal(r.status,200);assert.equal(queue().refreshedAt,before,'unchanged signature: no rebuild');}

// Unreadable signature while 3,100 films just got showings: never a silent cold pick. The dry run says why, the real start does not deliver a cold manifest.
assign(3100,'s1');mode='down';
{const d=await dry();assert.equal(d.status,200);assert.equal(d.data.priorityDue,true);assert.equal(d.data.priorityCause,'shows_signature_unreadable','degraded, not a false 0');assert.equal(queue().showsSignature,'s0','a dry run never rebuilds');
 release();const r=await api('batch/start',body);
 assert.notEqual(r.data.status,'running','the start does not run a manifest while hot outstanding cannot be verified: '+JSON.stringify(r.data).slice(0,200));
 assert.equal(queue().showsSignature,null,'the rebuild stored no signature it could not read');}
mode='ok';

// The read is back: the NEXT natural start rebuilds (the stored signature is null) and delivers hot first, on the same generation.
{const r=await realStart();assert.equal(r.status,200);assert.equal(queue().showsSignature,'s1');assert.equal(queue().programmeRunId,'p1');
 assert.ok(hot()+queue().hotPredicted>=3100-100,'3,100 cold films promoted to hot: '+hot());}

// Incremental Discovery chunks: each moves the signature, each next start rebuilds once and none is lost.
{let sig=1;const before=hot();
 for(const n of [3150,3200]){assign(n,'s'+(++sig+1));const r=await realStart();assert.equal(r.status,200);assert.equal(queue().showsSignature,signature,'rebuilt on the chunk '+n);assert.equal(queue().programmeRunId,'p1');}
 assert.ok(hot()+queue().hotPredicted>=before,'no hot work was lost across chunks');}

// A concurrent writer: an assignment lands between the signature the rebuild read and its write. The queue is ranked on the older signature, so the next start rebuilds again.
{assign(3200,'racing-old');let first=true;
 const original=ctx.PublishedEpg.assignedShowsSignature;
 ctx.PublishedEpg.assignedShowsSignature=async(...args)=>{const value=await original(...args);if(first){first=false;signature='racing-new';}return value;};
 const r=await realStart();assert.equal(r.status,200,'AIR-542: a priority-only race never refuses the start: '+JSON.stringify(r.data).slice(0,200));
 ctx.PublishedEpg.assignedShowsSignature=original;
 const again=await realStart();assert.equal(again.status,200);assert.equal(queue().showsSignature,'racing-new','the next natural start ranks on the signature that landed during the rebuild');}

// Another run id is the existing rollover path (`priorityRefreshDue`): the same-generation check stays silent about it.
{records.set('programme.json',{runId:'p2',films:[],catalogFilms:[]});const d=await dry();assert.ok(!String(d.data.priorityCause||'').startsWith('shows_signature'),'rollover is not a shows-signature cause');}

// 3. An EMPTY queue (nothing pending, hot or cold) on the fixed generation, then a new eligible Discovery admission and its same-generation assigned show. The preflight is priority-due; the start must
// reconcile BEFORE it can answer `noop`, and select the new film as hot. The 3,200-film fixture above starts with candidates and cannot reach this branch.
{
 const e=await flowWorld({films:1,extra:()=>({shows:[{start:now-10*86400000}]})});
 let sig='e0';e.ctx.PublishedEpg={
  currentGeneration:async()=>({authority:'d1',programmeRunId:'p1',phase:'published',fence:'d1:1:p1',generation:1}),
  readDocumentAt:async(env,run,kind)=>e.records.get(kind==='watchlist'?'watchlist.json':'programme.json')??null,
  assignedShowsSignature:async()=>sig,
 };
 e.records.set('programme.json',{runId:'p1',films:[],catalogFilms:[]});e.records.set('sync.json',{runId:'p1',stage:'complete'});
 const eapi=async(...a)=>e.api(...a),read=async()=>(await PredictionD1.openQueue(e.env)).queue;
 const ebody={scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100}};
 assert.equal((await eapi('queue/reconcile',{})).status,200);
 // Drain the only film through a normal run: the queue ends empty.
 {const m=(await eapi('batch/start',ebody)).data;assert.equal(m.status,'running');
  const sub=await eapi('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items:m.films.map(f=>({filmId:f.filmId,fingerprint:e.fingerprint,prediction:e.prediction}))});assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,200));
  assert.equal((await eapi('complete',{runId:m.runId})).status,200);}
 let q=await read();assert.equal(q.pending.length+q.hotPending.length+q.coldPending.length,0,'the queue is empty');
 assert.equal((await eapi('batch/start',ebody)).data.status,'noop','nothing to do while nothing changed');
 // Discovery admits a new Film and assigns its show inside the same generation.
 const f={id:'tmdb_900001',title:'tmdb_900001',original:'tmdb_900001',year:2020,tmdbId:'900001',canonicalIdentity:'tmdb:900001',genres:[],actors:[],directors:[],shows:[]};
 sql(e.file,"INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES ('"+f.id+"','"+f.tmdbId+"','movie','"+f.canonicalIdentity+"','"+f.id+"','p1',1,'current','"+JSON.stringify(f).replace(/'/g,"''")+"')");
 e.records.set('programme.json',{runId:'p1',films:[],catalogFilms:[{tmdbId:'900001',shows:[{channelId:'c',channel:'C',start:now-600000,end:now+7200000,basis:'discovery'}]}]});sig='e1';
 const d=await eapi('batch/start',{...ebody,dryRun:true});assert.equal(d.data.priorityCause,'shows_signature_changed','a dry run reports the pending reconcile and writes nothing');assert.equal((await read()).showsSignature,'e0');
 // Zero quota stays the quota outcome and writes nothing.
 const quota=await eapi('batch/start',{...ebody,capacity:{remainingPercent:0}});assert.notEqual(quota.data.status,'running');assert.equal((await read()).showsSignature,'e0','a quota start does not write the queue');
 const r=await eapi('batch/start',ebody);
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'running','the start reconciled instead of answering noop');
 assert.deepEqual(r.data.films.map(x=>x.filmId),['tmdb_900001'],'the new film is delivered');assert.equal((await read()).showsSignature,'e1');
}

// 4. Clock-only transitions on an UNCHANGED generation and signature. The predicate is `start >= now-72h && start < now+24h`: a show is still cold AT start-24h and hot from +1 ms; still hot AT start+72h and cold from +1 ms.
// Owner decision of 18 November 2026: the clock-only re-evaluation is a RATE CAP of 15 minutes between rebuilds, not a freshness guarantee. A rebuild exactly at an edge must keep the edge scheduled; an edge reached inside the cap
// is deferred (and reported by the dry run, never a verified count) and is reflected by the first start after the cap. A changed or unreadable signature is never capped (covered above).
{
 // The clock is controlled for `Date.now()` AND `new Date()` (the queue stamps `refreshedAt` with the latter), and it is installed BEFORE the world is built, which captures `Date` into its context.
 const HOUR=3600000,CAP=15*60000,RealDate=Date;let clock=RealDate.now();const T0=clock;
 globalThis.Date=class extends RealDate{constructor(...args){if(args.length)super(...args);else super(clock);}static now(){return clock;}};
 try{
  const c=await flowWorld({films:4});
  c.ctx.PublishedEpg={
   currentGeneration:async()=>({authority:'d1',programmeRunId:'p1',phase:'published',fence:'d1:1:p1',generation:1}),
   readDocumentAt:async(env,run,kind)=>c.records.get(kind==='watchlist'?'watchlist.json':'programme.json')??null,
   assignedShowsSignature:async()=>'w0',
  };
  // R is the instant of the second rebuild (T0+1h, exactly at the first edge, by a reconcile). tmdb 1: first airing T0+25h (cold; hot from T0+1h+1ms). tmdb 2: airing T0-71h (hot; cold from T0+1h+1ms).
  // tmdb 3: airing R+24h+60001ms (hot from R+60002ms, one minute after the rebuild at R+CAP-ish). tmdb 4: aired ten days ago (always cold).
  const R=T0+HOUR;
  const shows=(id,start)=>({tmdbId:id,shows:[{channelId:'c',channel:'C',start,end:start+7200000,basis:'discovery'}]});
  const S1=T0+25*HOUR,S2=T0-71*HOUR,S3=R+CAP+24*HOUR+60001;
  c.records.set('programme.json',{runId:'p1',films:[],catalogFilms:[shows('1',S1),shows('2',S2),shows('3',S3),shows('4',T0-240*HOUR)]});
  const read=async()=>(await PredictionD1.openQueue(c.env)).queue;
  const cbody={scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100}};
  const release=()=>sql(c.file,"UPDATE prediction_lease SET expires_at=1, document_json=json_set(document_json,'$.expiresAt',1)");
  const start=async()=>{release();const r=await c.api('batch/start',cbody);if(r.data?.runId&&r.data.status==='running')await c.api('complete',{runId:r.data.runId,reason:'manifest_spent'});return r;};
  const cdry=async()=>(await c.api('batch/start',{...cbody,dryRun:true})).data;
  const hotOf=q=>[...q.hotPending].sort();
  const iso=ms=>new Date(ms).toISOString();
  assert.equal((await c.api('queue/reconcile',{})).status,200);
  let q=await read();assert.deepEqual(hotOf(q),['tmdb_2'],'at T0 only the film airing at T0-71h is hot');
  assert.equal(q.priorityNextChangeAt,iso(T0+HOUR+1),'the first instant the predicate changes is T0+1h+1ms, not T0+1h');
  // Before the edge, and exactly AT the old edge (the predicate has not changed yet): nothing is due, nothing is deferred.
  clock=T0+30*60000;{const d=await cdry();assert.equal(d.priorityCause,undefined,'before the edge');assert.equal(d.hotBasis,undefined);}
  clock=R;{const d=await cdry();assert.equal(d.priorityCause,undefined,'at start-24h the show is still cold and at start+72h still hot: not due');assert.equal(d.hotBasis,undefined);}
  // A rebuild EXACTLY at the edge keeps the old classification and must keep the next edge scheduled (it was dropped when the edge was recorded as `edge > now`).
  assert.equal((await c.api('queue/reconcile',{})).status,200);q=await read();
  assert.deepEqual(hotOf(q),['tmdb_2'],'exactly at the edge the classification is still the old one');assert.equal(q.priorityNextChangeAt,iso(R+1),'the edge one millisecond later stays scheduled');
  // Rate cap: 1 ms past the edge but 1 ms after the rebuild. Deferred, reported, and the start does not rebuild (the accepted lag).
  clock=R+1;{const d=await cdry();assert.equal(d.priorityCause,undefined,'inside the cap: not due');assert.deepEqual(d.hotBasis,{status:'degraded',cause:'window_transition_deferred',hotRemaining:1,programmeRunId:'p1',showsSignature:'w0',nextChangeAt:iso(R+1)},'deferred is reported, not a verified count');}
  const builtR=q.refreshedAt;assert.equal((await start()).status,200);assert.equal((await read()).refreshedAt,builtR,'the cap holds the rebuild back');
  // At the end of the cap: due; the start reconciles both directions before it selects.
  clock=R+CAP-1;assert.equal((await cdry()).priorityCause,undefined,'one millisecond before the cap ends');
  clock=R+CAP;{const d=await cdry();assert.equal(d.priorityCause,'window_transition');assert.equal(d.hotBasis.status,'degraded');}
  assert.equal((await start()).status,200);q=await read();
  assert.deepEqual(hotOf(q),['tmdb_1'],'cold to hot and hot to cold, once the cap ended');assert.ok(q.coldPending.includes('tmdb_2'));assert.equal(q.programmeRunId,'p1');
  assert.equal(q.priorityNextChangeAt,iso(S3-24*HOUR+1),'the next edge is the third film');
  // The third film becomes hot one millisecond past its edge: deferred while inside the cap of the rebuild at R+CAP, reflected after it.
  const builtCap=q.refreshedAt;
  clock=S3-24*HOUR;assert.equal((await cdry()).hotBasis,undefined,'at the edge itself: nothing');
  clock=S3-24*HOUR+1;{const d=await cdry();assert.equal(d.priorityCause,undefined);assert.equal(d.hotBasis.cause,'window_transition_deferred');}
  assert.equal((await start()).status,200);assert.equal((await read()).refreshedAt,builtCap,'inside the cap');
  clock=R+2*CAP;assert.equal((await cdry()).priorityCause,'window_transition');assert.equal((await start()).status,200);q=await read();
  assert.deepEqual(hotOf(q),['tmdb_1','tmdb_3'],'the film that became hot is reflected by the first start after the cap');
  // No loop: with no edge reached since the rebuild, the next start rebuilds nothing.
  const again=q.refreshedAt;clock+=60000;assert.equal((await start()).status,200);assert.equal((await read()).refreshedAt,again,'no rebuild without a reached edge');
  // Hot to cold when the shows pass 72 h: exactly at start+72h still hot, 1 ms later cold (the cap has long passed).
  clock=S1+72*HOUR;assert.equal((await cdry()).priorityCause,undefined,'exactly at start+72h the film is still hot');
  clock=S1+72*HOUR+1;assert.equal((await cdry()).priorityCause,'window_transition');
  assert.equal((await start()).status,200);q=await read();assert.ok(!q.hotPending.includes('tmdb_1'),'hot to cold 1 ms past start+72h');
  clock=S3+72*HOUR+1;assert.equal((await start()).status,200);q=await read();assert.equal(q.hotPending.length,0);assert.equal(q.priorityNextChangeAt,null);
 }finally{globalThis.Date=RealDate;}
}

// 4. AIR-542: races at the preflight-to-lease boundary on a small world (8 cold films, manifest of 3). The hook runs inside the BASELINE preflight's signature read, after its queue head was
// read and before the lease is taken, so the post-lease preflight reads the mutated queue: its revision differs from the baseline's.
{
 const nowMs=Date.now();
 const make=async()=>{
  const e=await flowWorld({films:8,extra:()=>({shows:[{start:nowMs-10*86400000}]})});
  const state={calls:0,sig:['s0','s0'],mutate:null,down:false};
  e.ctx.PublishedEpg={
   currentGeneration:async()=>({authority:'d1',programmeRunId:'p1',phase:'published',fence:'d1:1:p1',generation:1}),
   readDocumentAt:async(env,run,kind)=>e.records.get(kind==='watchlist'?'watchlist.json':'programme.json')??null,
   assignedShowsSignature:async()=>{const n=state.calls++;if(n===1&&state.down)throw new Error('d1 down');const value=state.signature??state.sig[Math.min(n,state.sig.length-1)];if(n===0&&state.mutate)await state.mutate();return value;},
  };
  e.records.set('programme.json',{runId:'p1',films:[],catalogFilms:[]});e.records.set('sync.json',{runId:'p1',stage:'complete'});
  assert.equal((await e.api('queue/reconcile',{})).status,200);
  const b={scope:'watchlist_all',mode:'queued',trigger:'manual',manifestSize:3,capacity:{remainingPercent:100}};
  const read=async()=>(await PredictionD1.openQueue(e.env));
  const edit=async fn=>{const head=await read();fn(head.queue);assert.ok(await PredictionD1.writeQueue(e.env,head,head.queue),'the concurrent writer committed');};
  const start=async()=>{state.calls=0;const r=await e.api('batch/start',b);if(r.data?.runId&&r.data.status==='running')await e.api('complete',{runId:r.data.runId,reason:'manifest_spent'});return r;};
  const rankHot=(q,id)=>{q.priority[id]={...(q.priority[id]||{}),hot:true,rank:1};q.coldPending=q.coldPending.filter(x=>x!==id);q.hotPending=[id,...q.hotPending.filter(x=>x!==id)];};
  return {e,state,read,edit,start,rankHot};
 };
 const ids=r=>r.data.films.map(f=>f.filmId+':'+f.lane);
 // (0) The baseline: three cold films, no race.
 {const w=await make();const r=await w.start();assert.equal(r.status,200);assert.deepEqual(ids(r),['tmdb_1:cold','tmdb_2:cold','tmdb_3:cold']);}
 // (a) A concurrent reconcile already ranked another film hot and moved the queue generation: priorityDue is false, the revision differs. The start keeps its slot on the re-ranked manifest,
 // and the next natural start sees the new order.
 {const w=await make();const before=(await w.read()).queueGeneration;
  w.state.mutate=()=>w.edit(q=>w.rankHot(q,'tmdb_8'));
  const r=await w.start();assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.status,'running','an owned run, not queue_changed');
  assert.notEqual((await w.read()).queueGeneration,before,'the race moved the queue generation');
  assert.deepEqual(ids(r),['tmdb_8:hot'],'hot first: the manifest is the re-ranked one validated under the lease');
  assert.ok(r.data.manifestHash,'the manifest carries its own identity');
  w.state.mutate=null;const next=await w.start();assert.equal(next.status,200);assert.equal((await w.read()).queue.priority.tmdb_8.hot,true,'the concurrent ranking is kept; the next natural start continues from it');}
 // (b) The same re-rank together with a genuine change: a displaced film (tmdb_3) just used its retry budget, and a selected film (tmdb_1) has a new retry record. Both are refused.
 {const w=await make();
  w.state.mutate=()=>w.edit(q=>{w.rankHot(q,'tmdb_8');q.retries={...(q.retries||{}),tmdb_1:{attempts:1}};});
  const r=await w.start();assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.reason,'queue_changed');
  assert.notEqual(r.data.status,'running');}
 {const w=await make();
  w.state.mutate=()=>w.edit(q=>{w.rankHot(q,'tmdb_8');q.retries={...(q.retries||{}),tmdb_3:{attempts:99}};});
  const r=await w.start();assert.equal(r.status,409,'a displaced film that left the retry budget is not a re-rank: '+JSON.stringify(r.data).slice(0,200));}
 // Second-round case 1: a rank-only revision that leaves the delivered manifest byte-identical (films outside the first three re-ranked). The slot is kept on the same manifest.
 {const w=await make();const before=(await w.read()).queueGeneration,dry=await w.e.api('batch/start',{...{scope:'watchlist_all',mode:'queued',trigger:'manual',manifestSize:3,capacity:{remainingPercent:100}},dryRun:true});
  w.state.calls=0;w.state.mutate=()=>w.edit(q=>{q.coldPending=[...q.coldPending.slice(0,3),...q.coldPending.slice(3).reverse()];});
  const r=await w.start();assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.status,'running');
  assert.notEqual((await w.read()).queueGeneration,before,'the revision moved');assert.deepEqual(ids(r),['tmdb_1:cold','tmdb_2:cold','tmdb_3:cold']);assert.equal(r.data.manifestHash,dry.data.manifestHash,'the manifest is byte-identical to the baseline');}
 // Second-round case 2: the migration share (`queue.work`) decides which films are selected. A concurrent change of it is not a re-rank, even with no priority, lane or retry change.
 {const w=await make();const runs=()=>sql(w.e.file,'SELECT count(*) AS n FROM prediction_run')[0].n,leaseBefore=JSON.stringify(sql(w.e.file,"SELECT token FROM prediction_lease WHERE name='runner'"));
  w.state.mutate=()=>w.edit(q=>{q.work={...(q.work||{}),tmdb_1:{migration:true},tmdb_2:{migration:true},tmdb_3:{migration:true}};});
  const r=await w.start();assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.reason,'queue_changed');assert.equal(runs(),0,'no run was persisted on the refusal');
  assert.notEqual(r.data.status,'running');void leaseBefore;}
 // Third-round cases: the REAL `queue/reconcile` (buildPredictionQueue) runs between the baseline and the post-lease preflights. A Discovery assignment promotes tmdb_8 from cold to hot on the same generation;
 // the real rebuild reorders and resizes `pending` (watchlist films tmdb_1..4) and rebuilds `work`. The start must keep its slot on the hot film, and the next natural start continues from that ranking.
 {const realRebuild=async(w,after=null)=>{
   const watch=[1,2,3,4].map(n=>({id:'tmdb_'+n,title:'tmdb_'+n,original:'tmdb_'+n,year:2020,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,genres:[],actors:[],directors:[],shows:[{start:nowMs-10*86400000}]}));
   w.e.records.set('programme.json',{runId:'p1',films:watch,catalogFilms:[]});
   assert.equal((await w.e.api('queue/reconcile',{})).status,200);
   w.state.mutate=async()=>{
    w.state.signature='s1';w.e.records.set('programme.json',{runId:'p1',films:watch,catalogFilms:[{tmdbId:'8',shows:[{channelId:'c',channel:'C',start:nowMs-600000,end:nowMs+7200000,basis:'discovery'}]}]});
    {const head=await PredictionD1.openQueue(w.e.env),report=w.e.records.get('programme.json'),rebuilt=await w.e.ctx.buildPredictionQueue(w.e.env,report,'manual_reconcile',head.queue);assert.ok(await PredictionD1.writeQueue(w.e.env,head,rebuilt),'the real rebuild committed');w.state.rebuilt=rebuilt;}
    if(after)await after();
   };
  };
  {const w=await make();w.state.signature='s0';await realRebuild(w);const before=(await w.read()).queue;assert.deepEqual(before.pending,['tmdb_1','tmdb_2','tmdb_3','tmdb_4'],'baseline pending: the watchlist films');
   const r=await w.start();assert.equal(r.status,200,JSON.stringify(r.data).slice(0,260));assert.equal(r.data.status,'running','a real priority-only rebuild keeps the slot');
   
   const rebuilt=w.state.rebuilt;assert.equal(JSON.stringify(rebuilt.hotPending),'["tmdb_8"]');assert.equal(JSON.stringify(rebuilt.pending),'["tmdb_8","tmdb_1","tmdb_2","tmdb_3","tmdb_4"]','the real rebuild reordered and resized pending, which a hand-edited queue never does');assert.notEqual(JSON.stringify(rebuilt.pending),JSON.stringify(before.pending));
   w.state.mutate=null;const next=await w.start();assert.equal(next.status,200);}
  // Negative, on the real rebuild: a film that left the queue, and a changed work/migration classification, are not a re-rank.
  {const w=await make();w.state.signature='s0';await realRebuild(w,()=>w.edit(q=>{q.coldPending=q.coldPending.filter(x=>x!=='tmdb_7');q.pending=q.pending.filter(x=>x!=='tmdb_7');}));
   const r=await w.start();assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.reason,'queue_changed');}
  {const w=await make();w.state.signature='s0';await realRebuild(w,()=>w.edit(q=>{q.work={...(q.work||{}),tmdb_5:{...(q.work?.tmdb_5||{}),migration:'fingerprint'}};}));
   const r=await w.start();assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.reason,'queue_changed');}
 }
 // The reviewer's second case: the signature is still due at the lease AND a selected film's retry record changed. priorityDue must not excuse the non-priority change.
 {const w=await make();w.state.sig=['s0','s1'];w.state.mutate=()=>w.edit(q=>{q.retries={...(q.retries||{}),tmdb_2:{attempts:1}};});
  const r=await w.start();assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.reason,'queue_changed');}
 // A displaced film that left the queue (admission removed or already current) is not a re-rank either.
 {const w=await make();
  w.state.mutate=()=>w.edit(q=>{w.rankHot(q,'tmdb_8');q.coldPending=q.coldPending.filter(x=>x!=='tmdb_3');q.pending=(q.pending||[]).filter(x=>x!=='tmdb_3');});
  const r=await w.start();assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));}
 // (c) Priority drift alone at the lease (the signature moved, nothing else): the run is owned. An unreadable signature at the lease refuses. A new programme run refuses.
 {const w=await make();w.state.sig=['s0','s1'];const r=await w.start();assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.status,'running');}
 {const w=await make();w.state.down=true;const r=await w.start();assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.reason,'queue_changed');}
 // A queue that fails the advance gate at the boundary (registry changed: stale) refuses, with a re-rank beside it.
 {const w=await make();w.state.mutate=()=>w.edit(q=>{w.rankHot(q,'tmdb_8');q.fingerprintCompatibility={...q.fingerprintCompatibility,registryDigest:'changed'};});
  const r=await w.start();assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.reason,'queue_changed');assert.notEqual(r.data.status,'running','a failed advance gate is never a priority-only drift');}
}
console.log('3,200-film same-generation reconcile ok; signature reads',reads);
console.log('prediction hot reconcile same generation ok');
