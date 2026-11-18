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
console.log('3,200-film same-generation reconcile ok; signature reads',reads);
console.log('prediction hot reconcile same generation ok');
