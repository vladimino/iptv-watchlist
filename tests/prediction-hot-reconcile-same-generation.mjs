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
 const r=await realStart();assert.ok(r.status===200||r.status===409,'the racing start is allowed to be refused once');
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

// 4. Clock-only transitions on an UNCHANGED generation and signature: a fixed assigned show enters the hot window (start - 24 h) and later leaves it (start + 72 h). The queue is
// re-evaluated at a natural start once its stored boundary has passed, at most every 15 minutes, never before the boundary, and never per submit or complete.
{
 const HOUR=3600000,realNow=Date.now;let clock=realNow();const T0=clock;Date.now=()=>clock;
 try{
  const c=await flowWorld({films:3});
  c.ctx.PublishedEpg={
   currentGeneration:async()=>({authority:'d1',programmeRunId:'p1',phase:'published',fence:'d1:1:p1',generation:1}),
   readDocumentAt:async(env,run,kind)=>c.records.get(kind==='watchlist'?'watchlist.json':'programme.json')??null,
   assignedShowsSignature:async()=>'w0',
  };
  // tmdb 1: first airing at T0+25h (cold now, hot from T0+1h, cold again after T0+97h). tmdb 2: airing at T0-71h (hot now, cold after T0+1h). tmdb 3: aired ten days ago (always cold).
  const shows=(id,start)=>({tmdbId:id,shows:[{channelId:'c',channel:'C',start,end:start+7200000,basis:'discovery'}]});
  c.records.set('programme.json',{runId:'p1',films:[],catalogFilms:[shows('1',T0+25*HOUR),shows('2',T0-71*HOUR),shows('3',T0-240*HOUR)]});
  const read=async()=>(await PredictionD1.openQueue(c.env)).queue;
  const cbody={scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100}};
  const release=()=>sql(c.file,"UPDATE prediction_lease SET expires_at=1, document_json=json_set(document_json,'$.expiresAt',1)");
  const start=async()=>{release();const r=await c.api('batch/start',cbody);if(r.data?.runId&&r.data.status==='running')await c.api('complete',{runId:r.data.runId,reason:'manifest_spent'});return r;};
  const cdry=()=>c.api('batch/start',{...cbody,dryRun:true});
  assert.equal((await c.api('queue/reconcile',{})).status,200);
  let q=await read();assert.deepEqual([...q.hotPending].sort(),['tmdb_2'],'at T0 only the film airing at T0-71h is hot');
  assert.equal(q.priorityNextChangeAt,new Date(T0+HOUR).toISOString(),'the next boundary is T0+1h');
  const built0=q.refreshedAt;
  // Before the boundary: nothing is due.
  clock=T0+30*60000;assert.equal((await cdry()).data.priorityCause,undefined,'before the boundary');
  // After the boundary, cold to hot and hot to cold on the SAME generation and signature.
  assert.equal((await cdry()).data.hotBasis,undefined,'a current basis adds nothing to the dry-run answer');
  clock=T0+2*HOUR;{const d=(await cdry()).data;assert.equal(d.priorityCause,'window_transition','boundary passed');assert.deepEqual(d.hotBasis,{status:'degraded',cause:'window_transition',hotRemaining:1,programmeRunId:'p1',showsSignature:'w0',nextChangeAt:new Date(T0+HOUR).toISOString()});}assert.equal((await read()).refreshedAt,built0,'a dry run writes nothing');
  assert.equal((await start()).status,200);q=await read();
  assert.deepEqual([...q.hotPending].sort(),['tmdb_1'],'cold to hot: tmdb_1 entered the window; hot to cold: tmdb_2 left it');
  assert.ok(q.coldPending.includes('tmdb_2')&&q.coldPending.includes('tmdb_3'));assert.equal(q.programmeRunId,'p1');assert.equal(q.priorityNextChangeAt,new Date(T0+97*HOUR).toISOString());
  const built1=q.refreshedAt;
  // No loop: the next start does not rebuild, and neither does one right after another boundary inside the 15-minute minimum.
  clock+=60000;assert.equal((await start()).status,200);assert.equal((await read()).refreshedAt,built1,'no rebuild without a passed boundary');
  // The film leaves the window at T0+97h: cold again, re-evaluated at the next start after the interval.
  clock=T0+98*HOUR;assert.equal((await cdry()).data.priorityCause,'window_transition');
  assert.equal((await start()).status,200);q=await read();assert.equal(q.hotPending.length,0,'hot to cold after the show expired past 72 h');assert.equal(q.priorityNextChangeAt,null);
  const built2=q.refreshedAt;clock+=5*60000;assert.equal((await cdry()).data.priorityCause,undefined);assert.equal((await read()).refreshedAt,built2);
 }finally{Date.now=realNow;}
}
console.log('3,200-film same-generation reconcile ok; signature reads',reads);
console.log('prediction hot reconcile same generation ok');
