// AIR-570 / ADR 0186. The Diary-and-Ratings phase and the removal-reconciliation phase ports over the ratings pipeline, OFFLINE against a fake pipeline. The two-phase split of one pipeline run, the
// slot key that makes the pipeline write no Event of its own, the epoch guard on every write, an unfinished run of an earlier slot, blocked / rate-limited / lease outcomes by class. No network, no D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ratingsSlotPhase} from '../src/letterboxd-sync-ratings.js';

const T=s=>Date.parse(s);
function pipeline(initial=null){
 const state={run:initial,starts:[],steps:[],envs:[]};
 const api={
  async readRun(env){state.envs.push(env);return state.run?structuredClone(state.run):null;},
  async start(env,args,now){state.envs.push(env);state.starts.push(args);if(state.busy)return {created:false,reason:'busy'};if(state.storage)return {created:false,reason:'storage_unsupported'};if(state.isolated)return {created:false,reason:'isolated'};state.run={runId:'run'+state.starts.length,state:'running',phase:'diary',slotKey:args.slotKey||null,checkpoint:{diaryPagesRead:0,removalChecked:0}};return {created:true,runId:state.run.runId};},
  async step(env,{runId},{now,clock}){state.envs.push(env);state.steps.push({runId,now,clock:typeof clock});const r=state.run;if(state.reply)return state.reply;
   if(r.phase==='diary'){r.phase='removal';r.checkpoint.diaryPagesRead=2;return {nextAction:'continue'};}
   r.state='finished';r.checkpoint.removalChecked=3;return {nextAction:'stop',state:'finished'};}
 };
 return {state,api};
}
const ctx=(env={},over={})=>({env,slotKey:'2026-11-21T1030',runId:'lb',epoch:4,now:()=>T('2026-11-21T10:40:00Z'),...over});
const guard=e=>['INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, 1 WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok',[e]];
const ports=p=>({diary:ratingsSlotPhase({ratings:p.api,fenceGuard:guard,phase:'diary'}),removal:ratingsSlotPhase({ratings:p.api,fenceGuard:guard,phase:'removal'})});

// 1. A whole run in two phases: phase 1 starts the run WITH the slot key and stops when the Diary part is done; phase 3 finishes the run. The Watchlist scan sits between them.
{
 const p=pipeline(),{diary,removal}=ports(p);
 let out=await diary.run(ctx());assert.equal(out.done,false,'started');assert.deepEqual(p.state.starts,[{trigger:'scheduled',slotKey:'2026-11-21T1030'}]);
 out=await diary.run(ctx());assert.equal(out.done,false,'the Diary step');assert.equal(p.state.run.phase,'removal');
 out=await diary.run(ctx());assert.deepEqual([out.done,out.outcome,out.counts],[true,'finished',{diaryPages:2,removalChecked:0}],'phase 1 ends when the run reaches removal');
 assert.equal(p.state.run.state,'running','phase 1 left the run for phase 3');
 out=await removal.run(ctx());assert.equal(out.done,false);assert.equal(p.state.run.state,'finished');
 out=await removal.run(ctx());assert.deepEqual([out.done,out.outcome],[true,'done']);
 // every pipeline call carried the Letterboxd epoch guard, hard, in the env
 assert.ok(p.state.envs.every(env=>env.ratingsFence?.hard===true&&env.ratingsFence.guard[1][0]===4),'every pipeline write rides the mode-epoch guard');
 assert.ok(p.state.envs.every(env=>env.producerFence?.kind==='letterboxd'&&env.producerFence.epoch===4),'canonical writes the pipeline makes carry the producer fence too');
}
// 2. Phase 3 does nothing without this slot's run, and never starts one.
{
 const p=pipeline(),{removal}=ports(p);
 const out=await removal.run(ctx());assert.deepEqual([out.done,out.outcome,out.reason],[true,'skipped','no_slot_run']);assert.equal(p.state.starts.length,0);
 const other=pipeline({runId:'o',state:'finished',slotKey:'2026-11-21T0430',phase:'removal',checkpoint:{}});
 assert.equal((await ports(other).removal.run(ctx())).reason,'no_slot_run');
}
// 3. An unfinished run of an EARLIER slot (its reconciliation was deferred) is stepped to its end first, before a new run starts.
{
 const p=pipeline({runId:'old',state:'running',phase:'removal',slotKey:'2026-11-21T0430',checkpoint:{diaryPagesRead:1,removalChecked:0}}),{diary}=ports(p);
 let out=await diary.run(ctx());assert.equal(out.done,false);assert.equal(p.state.steps[0].runId,'old');assert.equal(p.state.starts.length,0,'no new run while an earlier slot run is unfinished');
 assert.equal(p.state.run.state,'finished');
 out=await diary.run(ctx());assert.equal(out.done,false);assert.equal(p.state.starts.length,1,'the next call starts this slot\'s run');
}
// 4. Outcomes by class: busy waits, blocked / rate limited / error runs, lease and storage replies. A deferred reconciliation is not a failure of Ratings.
{
 let p=pipeline();p.state.busy=true;let out=await ports(p).diary.run(ctx());assert.equal(out.done,false);assert.ok(out.wakeAt>T('2026-11-21T10:40:00Z'));
 p=pipeline();p.state.storage=true;out=await ports(p).diary.run(ctx());assert.deepEqual([out.outcome,out.reason],['error','config_invalid']);
 p=pipeline();p.state.isolated=true;out=await ports(p).diary.run(ctx());assert.deepEqual([out.outcome,out.reason],['error','evidence_contradictory']);
 const errored=cause=>pipeline({runId:'e',state:'error',phase:'diary',cause,slotKey:'2026-11-21T1030',checkpoint:{},removal:{pausedUntil:'2026-11-21T16:30:00.000Z'}});
 p=errored('blocked');out=await ports(p).diary.run(ctx());assert.deepEqual([out.outcome,out.reason],['blocked','upstream_blocked']);
 out=await ports(p).removal.run(ctx());assert.equal(out.outcome,'deferred','a blocked run defers the reconciliation, it does not fail it');
 p=errored('rate_limited');out=await ports(p).diary.run(ctx());assert.deepEqual([out.outcome,out.reason],['rate_limited','http_429']);assert.equal(out.pausedUntil,T('2026-11-21T16:30:00Z'));
 out=await ports(p).removal.run(ctx());assert.equal(out.outcome,'deferred');
 p=errored('failed');out=await ports(p).diary.run(ctx());assert.equal(out.outcome,'error');out=await ports(p).removal.run(ctx());assert.equal(out.outcome,'error');
 for(const reason of ['lease_lost','unknown','run_mismatch','not_running','storage_unsupported']){
  p=pipeline({runId:'r',state:'running',phase:'diary',slotKey:'2026-11-21T1030',checkpoint:{}});p.state.reply={reason};
  out=await ports(p).diary.run(ctx());
  // AIR-694: a lost lease or an unrecognised run is an interruption; a misconfigured storage stays an error.
  assert.deepEqual([out.done,out.outcome,out.reason],[true,reason==='storage_unsupported'?'error':'interrupted',reason]);
  if(reason==='lease_lost')assert.equal(out.phase,'diary');
 }
 p=pipeline({runId:'r',state:'running',phase:'diary',slotKey:'2026-11-21T1030',checkpoint:{}});p.state.reply={reason:'busy',nextCatchUpAt:'2026-11-21T10:55:00.000Z'};
 out=await ports(p).diary.run(ctx());assert.equal(out.wakeAt,T('2026-11-21T10:55:00Z'));
}
// 5. Misconfiguration: no pipeline, no guard or a wrong phase is no port at all (the phase then fails closed in the Workflow).
{
 assert.equal(ratingsSlotPhase({ratings:null,fenceGuard:guard,phase:'diary'}),null);
 assert.equal(ratingsSlotPhase({ratings:pipeline().api,phase:'diary'}),null);
 assert.equal(ratingsSlotPhase({ratings:pipeline().api,fenceGuard:guard,phase:'x'}),null);
}
// 6. The module names no EPG, Discovery or storage of its own.
{
 const text=fs.readFileSync('src/letterboxd-sync-ratings.js','utf8');
 assert.doesNotMatch(text,/published_epg|PublishedEpg|discovery_|epg_checkpoint|env\.DB|BUCKET|prepare\(/i);
}
console.log('letterboxd-sync-ratings ok');
