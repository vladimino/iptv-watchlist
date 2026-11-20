// Read-only parity of the actual hot outstanding work against the persisted hot queue: `predictionHotParity` and the `prediction_hot_parity` MCP tool.
// One fixed published generation `p1` on a migrated sqlite D1 stand-in with 3,200 Discovery-admitted films, the real Worker code in a vm, a local R2. The expected side is the queue
// builder itself, so each scenario changes the world or the stored queue and asserts the verdict. Nothing here calls Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as PredictionD1 from '../src/prediction-d1.js';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const TOTAL=3200,HOUR=3600000,MIN=60000;
const T0=Date.now();
const lowerEdge=T0+24*HOUR+5*MIN,upperEdge=T0-72*HOUR+5*MIN,farPast=T0-10*86400000;
const w=await flowWorld({films:TOTAL,extra:()=>({shows:[{start:farPast}]})});
const {records,env,ctx,hooks,stats,file}=w;
vm.runInContext(fs.readFileSync('src/prediction-diagnostics.js','utf8'),ctx);

let generation={authority:'d1',programmeRunId:'p1',phase:'published',fence:'d1:1:p1',generation:1},signature='s0',signatureMode='ok',signatureReads=0;
ctx.PublishedEpg={
 currentGeneration:async()=>generation,
 readDocumentAt:async(e,run,kind)=>records.get(kind==='watchlist'?'watchlist.json':'programme.json')??null,
 assignedShowsSignature:async()=>{signatureReads++;if(signatureMode==='down')throw new Error('d1 down');return signature;},
};
const show=start=>({channelId:'c',channel:'C',start,end:start+7200000,basis:'discovery'});
// The completed programme: film n gets one assigned show starting at `at(n)` (null: no show).
const assign=(at,sig)=>{records.set('programme.json',{runId:'p1',films:[],catalogFilms:Array.from({length:TOTAL},(_,i)=>at(i+1)==null?null:({tmdbId:String(i+1),shows:[show(at(i+1))]})).filter(Boolean)});signature=sig;};
// The answer crosses the vm realm: a JSON copy is what the MCP layer returns and keeps deepEqual away from foreign prototypes.
const parity=async(now=Date.now())=>JSON.parse(JSON.stringify(await ctx.predictionHotParity(env,now)));
const head=async()=>PredictionD1.openQueue(env);
const queue=async()=>(await head()).queue;
const writeQueue=async next=>{const h=await head();assert.notEqual(await PredictionD1.writeQueue(env,h,next),null,'the test writer wins its own compare-and-set');};
const reconcile=async()=>{const r=await w.api('queue/reconcile',{});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));return queue();};
const clone=value=>structuredClone(value);

// Only SELECTs are allowed while a parity read runs, and the stored queue document is byte-identical afterwards.
let writes=[];hooks.query=text=>{if(!/^\s*(SELECT|WITH|PRAGMA)/i.test(text))writes.push(text.slice(0,80));};
const readOnly=async(fn)=>{writes=[];const before=JSON.stringify(await queue()),batchesBefore=stats.writeBatches;const out=await fn();assert.deepEqual(writes,[],'a parity read issues no write statement');assert.equal(stats.writeBatches,batchesBefore,'no write batch');assert.equal(JSON.stringify(await queue()),before,'the stored queue is untouched');return out;};

// 1. Matching parity: every film cold, an identical queue.
assign(()=>farPast+1,'s0');
let built=await reconcile();
assert.equal(built.hotPending.length,0);assert.equal(built.coldPending.length,TOTAL);
{const r=await readOnly(()=>parity());
 assert.equal(r.verdict,'match',JSON.stringify(r).slice(0,400));assert.deepEqual(r.reasons,[]);
 assert.equal(r.generation.programmeRunId,'p1');assert.equal(r.generation.authority,'d1');assert.ok(r.cutoff);assert.equal(r.atomic,false);
 assert.equal(r.expected.hotOutstanding,0);assert.equal(r.queueCounts.hotOutstanding,0);assert.equal(r.evaluated.films,TOTAL);
 assert.equal(r.showsSignature.matches,true);assert.equal(r.diff.missingFromQueueHot,0);assert.equal(r.diff.extraInQueueHot,0);}

// 2. A false queue snapshot: 3,100 films got completed shows inside the same generation and the queue was not rebuilt. The stored hot lane is empty; the actual hot outstanding is 3,100.
assign(i=>i<=3100?T0-600000:farPast+1,'s1');
{const r=await readOnly(()=>parity());
 assert.equal(r.verdict,'mismatch');assert.equal(r.expected.hotOutstanding,3100,'actual hot outstanding');assert.equal(r.queueCounts.hotOutstanding,0,'queue hot lane');
 assert.equal(r.diff.missingFromQueueHot,3100);assert.equal(r.diff.extraInQueueHot,0);assert.deepEqual(r.reasons,['shows_signature_changed']);
 assert.equal(r.showsSignature.matches,false);
 assert.equal(r.examples.missingFromQueueHot.ids.length,10,'bounded examples');assert.equal(r.examples.missingFromQueueHot.total,3100);assert.equal(r.examples.missingFromQueueHot.truncated,true);
 assert.ok(r.examples.missingFromQueueHot.ids.every(id=>/^tmdb_\d+$/.test(id)));
 assert.equal(r.queueCounts.actionableNow,TOTAL,'the queue would select cold work');assert.equal(r.expected.actionableNow,3100);}

// 3. The natural rebuild closes the gap: match with 3,100 hot on both sides.
built=await reconcile();
{const r=await readOnly(()=>parity());assert.equal(r.verdict,'match',JSON.stringify(r).slice(0,300));assert.equal(r.expected.hotOutstanding,3100);assert.equal(r.queueCounts.hotOutstanding,3100);assert.equal(r.showsSignature.stored,'s1');}

// 4. Stale, missing and extra Film IDs in the stored hot lane.
{const base=await queue(),tampered=clone(base),dropped=base.hotPending[0],kept=base.hotPending.slice(1);
 tampered.hotPending=[...kept,'tmdb_999999'];tampered.pending=[...kept,'tmdb_999999'];tampered.priorityCount=tampered.hotPending.length;
 await writeQueue(tampered);
 const r=await readOnly(()=>parity());
 assert.equal(r.verdict,'mismatch');assert.equal(r.diff.missingFromQueueHot,1);assert.equal(r.diff.extraInQueueHot,1);
 assert.equal(r.diff.causes.absent_from_queue,1,'a hot film the queue does not hold at all');assert.equal(r.diff.causes.no_longer_outstanding,1,'an id the catalog does not make outstanding');
 assert.deepEqual(r.examples.missingFromQueueHot.ids,[dropped]);assert.deepEqual(r.examples.extraInQueueHot.ids,['tmdb_999999']);
 // A film the queue lists cold while it is hot is a reclassification, not an absence.
 const cold=clone(base);cold.hotPending=base.hotPending.slice(1);cold.coldPending=[base.hotPending[0],...base.coldPending];cold.priorityCount=cold.hotPending.length;cold.pending=cold.hotPending;
 await writeQueue(cold);
 const c=await readOnly(()=>parity());assert.equal(c.verdict,'mismatch');assert.equal(c.diff.causes.reclassified_hot,1,JSON.stringify(c.diff));
 await writeQueue(base);assert.equal((await readOnly(()=>parity())).verdict,'match');

 // Malformed lanes are never deduplicated into a match: a duplicate id in one lane, or an id in both lanes, makes the queue itself unreadable as a lane set.
 const malformed={
  duplicateHot:q=>{q.hotPending=[q.hotPending[0],...q.hotPending];q.priorityCount=q.hotPending.length;},
  duplicateCold:q=>{q.coldPending=[q.coldPending[0],...q.coldPending];q.coldRemaining=q.coldPending.length;},
  hotAndCold:q=>{q.coldPending=[q.hotPending[0],...q.coldPending];q.coldRemaining=q.coldPending.length;},
 };
 for(const [name,mutate] of Object.entries(malformed)){
  const bad=clone(base);mutate(bad);await writeQueue(bad);
  const r=await readOnly(()=>parity());
  assert.equal(r.verdict,'unknown',name+': '+JSON.stringify(r).slice(0,200));assert.deepEqual(r.reasons,['queue_shape_invalid'],name);assert.equal(r.expected,undefined,name+': no count is claimed');assert.equal(r.diff,undefined,name);
  await writeQueue(base);
 }
 assert.equal((await readOnly(()=>parity())).verdict,'match','the legitimate queue is still a match after the malformed ones');}

const predicted=new Set();
// 5. Mismatched freshness: a film is settled by a real submit, then an OLDER snapshot of the queue (which still lists it outstanding) is put back. The queue lies; the facts do not.
{const started=await w.reconcileAndStart();assert.equal(started.start.status,200,JSON.stringify(started.start.data).slice(0,300));
 const before=clone(await queue()),paired=await w.pair(started.start.data.runId);predicted.add(paired.filmId);assert.equal(paired.submit.status,200,JSON.stringify(paired.submit.data).slice(0,300));
 await w.api('complete',{runId:started.start.data.runId,reason:'manifest_spent'});
 const settled=await queue();assert.ok(!settled.hotPending.includes(paired.filmId),'the real submit settled the film');
 await readOnly(async()=>assert.equal((await parity()).verdict,'match','the settled queue agrees'));
 await writeQueue(before);
 const r=await readOnly(()=>parity());assert.equal(r.verdict,'mismatch');assert.equal(r.diff.causes.no_longer_outstanding,1,JSON.stringify(r.diff));assert.deepEqual(r.examples.extraInQueueHot.ids,[paired.filmId]);
 await writeQueue(settled);assert.equal((await readOnly(()=>parity())).verdict,'match');}

// 6. Retry exhausted and backoff: both sides read the stored retry records, so the exhausted film leaves both hot lanes and a backed-off one is counted, not a difference.
{const base=await queue(),[a,b]=base.hotPending,next=clone(base);
 next.retries={...(base.retries||{}),[a]:{attempts:10,kind:'validation_error',scope:'item'},[b]:{attempts:2,kind:'validation_error',scope:'item',retryAt:Date.now()+HOUR}};
 await writeQueue(next);
 const r=await readOnly(()=>parity());assert.equal(r.verdict,'match',JSON.stringify(r).slice(0,300));
 assert.equal(r.queueCounts.retryExhausted,1);assert.equal(r.queueCounts.hotDeferredByRetry,1);assert.equal(r.expected.hotDeferredByRetry,1);
 assert.equal(r.queueCounts.hotOutstanding,base.hotPending.length-1,'the exhausted film is not outstanding automatic work');
 await writeQueue(base);}

// 7. A new Discovery admission with its same-run show assignment: absent from the queue, and the signature moved.
{sql(file,"INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES ('tmdb_900001','900001','movie','tmdb:900001','tmdb_900001','p1',1,'current','"+JSON.stringify({id:'tmdb_900001',title:'tmdb_900001',original:'tmdb_900001',year:2020,tmdbId:'900001',canonicalIdentity:'tmdb:900001',genres:[],actors:[],directors:[],shows:[]})+"')");
 const programme=records.get('programme.json');records.set('programme.json',{...programme,catalogFilms:[...programme.catalogFilms,{tmdbId:'900001',shows:[show(T0-600000)]}]});signature='s2';
 const r=await readOnly(()=>parity());assert.equal(r.verdict,'mismatch');assert.deepEqual(r.examples.missingFromQueueHot.ids,['tmdb_900001']);assert.equal(r.diff.causes.absent_from_queue,1);
 await reconcile();assert.equal((await readOnly(()=>parity())).verdict,'match');}

// 8. The clock-only window edge. 3,000 films start 24 h 5 min after the build instant (cold at the build, hot 5 min later); 200 films started 72 h minus 5 min before it (hot at the build, cold 5 min later).
assign(i=>i<=3000?lowerEdge:i<=3200?upperEdge:null,'s3');
built=await reconcile();
// The film settled by the real submit above has a current prediction: it is outstanding in neither lane.
const lower=Array.from({length:3000},(_,i)=>'tmdb_'+(i+1)).filter(id=>!predicted.has(id)).length,upper=Array.from({length:200},(_,i)=>'tmdb_'+(3001+i)).filter(id=>!predicted.has(id)).length;
assert.equal(built.hotPending.length,upper,'the films that are inside the window at the build are hot');
{const builtAt=Date.parse(built.refreshedAt);
 // The queue was ranked before the edge; the signature is unchanged. Inside the 15-minute rate cap this is the accepted deferral: degraded, with the cause named, never a PASS.
 const inside=await readOnly(()=>parity(builtAt+10*MIN));
 assert.equal(inside.verdict,'degraded',JSON.stringify(inside).slice(0,400));assert.deepEqual(inside.reasons,['window_transition_deferred']);assert.equal(inside.rateCap.withinCap,true);
 assert.equal(inside.diff.missingFromQueueHot,lower);assert.equal(inside.diff.extraInQueueHot,upper);assert.equal(inside.diff.causes.window_transition,lower+upper);
 // After the cap the next natural start would rebuild: until then it is a plain mismatch, still caused by the clock alone.
 const after=await readOnly(()=>parity(builtAt+20*MIN));assert.equal(after.verdict,'mismatch');assert.deepEqual(after.reasons,['window_transition']);assert.equal(after.rateCap.withinCap,false);
 // At the build instant there is nothing to defer.
 assert.equal((await readOnly(()=>parity(builtAt))).verdict,'match');}

// 9. EPG rollover: the published generation moved to p2 and the queue still ranks p1. It waits for its own natural refresh; its hot lane is not compared with p2.
{const previous=generation,programme=records.get('programme.json');
 generation={...generation,programmeRunId:'p2',fence:'d1:2:p2',generation:2};records.set('programme.json',{...programme,runId:'p2'});
 const r=await readOnly(()=>parity());assert.equal(r.verdict,'degraded');assert.deepEqual(r.reasons,['generation_rollover_pending']);assert.equal(r.queue.programmeRunId,'p1');assert.equal(r.generation.programmeRunId,'p2');
 // The rollover answer is fenced like any other: the published generation or the queue revision moving during the call is `unknown`, not the stated deferral. `n` is the number of generation reads of a stable call; the fence is the last.
 {const live=ctx.PublishedEpg.currentGeneration;let n=0;ctx.PublishedEpg.currentGeneration=async(...args)=>{n++;return live(...args);};
  assert.equal((await readOnly(()=>parity())).verdict,'degraded','the stable rollover stays degraded');const last=n;
  let calls=0;ctx.PublishedEpg.currentGeneration=async()=>{calls++;return calls===last?{...generation,programmeRunId:'p3',fence:'d1:3:p3',generation:3}:generation;};
  const moved=await readOnly(()=>parity());assert.equal(moved.verdict,'unknown',JSON.stringify(moved).slice(0,200));assert.deepEqual(moved.reasons,['generation_changed_during_read']);
  const before=clone(await queue());calls=0;
  // The concurrent writer commits before the fence starts reading (the generation read before it).
  ctx.PublishedEpg.currentGeneration=async()=>{if(++calls===last-1){const h=await head();await PredictionD1.writeQueue(env,h,{...clone(h.queue),trigger:'batch_complete'});}return generation;};
  const raced=await parity();assert.equal(raced.verdict,'unknown',JSON.stringify(raced).slice(0,200));assert.deepEqual(raced.reasons,['queue_changed_during_read']);
  ctx.PublishedEpg.currentGeneration=live;await writeQueue(before);}
 generation=previous;records.set('programme.json',programme);assert.equal((await readOnly(()=>parity(Date.parse(built.refreshedAt)))).verdict,'match');}

// 10. Unknown, never a PASS and never a proven zero.
{const known=await parity(Date.parse(built.refreshedAt));assert.equal(known.verdict,'match');
 const unknown=async(reason,fn,restore)=>{try{const r=await readOnly(()=>parity(Date.parse(built.refreshedAt)));assert.equal(r.verdict,'unknown',reason+': '+JSON.stringify(r).slice(0,300));assert.deepEqual(r.reasons,[reason]);assert.equal(r.expected,undefined,'no count is claimed when the sides were not compared');return r;}finally{restore();}};
 // Unreadable D1 (the catalog admissions).
 {hooks.query=text=>{if(/discovery_admission/i.test(text))throw new Error('d1 down');if(!/^\s*(SELECT|WITH|PRAGMA)/i.test(text))writes.push(text.slice(0,80));};
  const r=await unknown('source_unreadable',null,()=>{hooks.query=text=>{if(!/^\s*(SELECT|WITH|PRAGMA)/i.test(text))writes.push(text.slice(0,80));};});assert.ok(!/d1 down/.test(JSON.stringify(r)),'no raw error text leaves the Worker');}
 // Unreadable shows signature.
 signatureMode='down';await unknown('shows_signature_unreadable',null,()=>{signatureMode='ok';});
 // Lost authority: no live D1 generation.
 {const live=ctx.PublishedEpg.currentGeneration;ctx.PublishedEpg.currentGeneration=async()=>null;await unknown('epg_authority_not_d1',null,()=>{ctx.PublishedEpg.currentGeneration=live;});}
 // The generation moves while the expected side is evaluated.
 {const original=ctx.buildPredictionQueue;ctx.buildPredictionQueue=async(...args)=>{const out=await original(...args);generation={...generation,fence:'d1:9:p1',generation:9};return out;};
  await unknown('generation_changed_during_read',null,()=>{ctx.buildPredictionQueue=original;generation={authority:'d1',programmeRunId:'p1',phase:'published',fence:'d1:1:p1',generation:1};});}
 // A concurrent writer commits the queue (CAS) while the expected side is evaluated.
 {const original=ctx.buildPredictionQueue;ctx.buildPredictionQueue=async(...args)=>{const out=await original(...args);const h=await head();await PredictionD1.writeQueue(env,h,{...clone(h.queue),trigger:'batch_complete'});return out;};
  const r=await parity(Date.parse(built.refreshedAt));ctx.buildPredictionQueue=original;assert.equal(r.verdict,'unknown');assert.deepEqual(r.reasons,['queue_changed_during_read']);}
 // Discovery assigns shows while the expected side is evaluated: an unstable snapshot.
 {const original=ctx.buildPredictionQueue;ctx.buildPredictionQueue=async(...args)=>{const out=await original(...args);signature='racing';return out;};
  const r=await parity(Date.parse((await queue()).refreshedAt));ctx.buildPredictionQueue=original;signature='s3';assert.equal(r.verdict,'unknown');assert.deepEqual(r.reasons,['shows_changed_during_read']);}
 // A queue built under another profile is not comparable (the next natural start rebuilds it): the hot lane says nothing about the current profile.
 {const base=await queue();await writeQueue({...clone(base),profileHash:'another-profile'});
  const r=await parity(Date.now());await writeQueue(base);assert.equal(r.verdict,'unknown');assert.equal(r.reasons[0],'queue_not_comparable_profile_changed');}
 // A missing queue or profile is "not recorded", not an empty queue.
 {const live=records.get('programme.json');records.delete('programme.json');const r=await parity();records.set('programme.json',live);assert.equal(r.verdict,'unknown');assert.ok(['programme_not_recorded','source_unreadable','generation_unreadable','programme_generation_mismatch'].includes(r.reasons[0]),r.reasons[0]);}
}

// 11. Cost on 3,200 films: the statements and wall time of one full parity read. It is an occasional owner read, so it must be bounded and read-only, not free.
{let selects=0,queries=0;writes=[];hooks.query=text=>{queries++;if(/^\s*(SELECT|WITH)/i.test(text))selects++;else if(!/^\s*PRAGMA/i.test(text))writes.push(text.slice(0,80));};
 const trips0=stats.queries+stats.batches;signatureReads=0;
 const t0=performance.now();const r=await parity(Date.parse((await queue()).refreshedAt));const ms=performance.now()-t0;
 const trips=stats.queries+stats.batches-trips0;
 assert.equal(r.verdict,'match',JSON.stringify(r).slice(0,300));assert.deepEqual(writes,[]);assert.ok(r.elapsedMs>=0);
 assert.ok(signatureReads<=3,'the assigned-shows signature is read at most before, and once after, the evaluation: '+signatureReads);
 assert.ok(trips<=40,'D1 round trips of one parity read stay bounded on 3,200 films: '+trips);
 console.log('hot parity on '+TOTAL+' films: '+ms.toFixed(0)+' ms, '+queries+' statements ('+selects+' SELECT), '+trips+' D1 round trips, signature reads '+signatureReads+', elapsedMs reported '+r.elapsedMs);}
console.log('prediction hot parity: ok');
