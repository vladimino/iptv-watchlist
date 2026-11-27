// AIR-349: the pure monitor policy. Health of each stream from observed facts (DST, delayed trigger, backoff versus stalled, resource
// limits, empty versus stale queue, mode switch, quarantine), and the alert planner (confirmation, cooldown, escalation, recovery,
// bounded sends, duplicates). No I/O, an injected clock. AIR-592 (ADR 0206): four states, `critical` instead of `needs_owner`, one 6 h reminder,
// and the legacy `needs_owner` entries and outbox messages written before the change.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as P from '../src/domain/monitor-policy.js';
import * as Old from './fixtures/monitor-policy-pre-air-592.js'; // the policy before ADR 0206, verbatim, for the rollback replay
import {dailyDue} from '../src/domain/orchestration-policy.js';

assert.doesNotMatch(fs.readFileSync('src/domain/monitor-policy.js','utf8'),/\b(fetch|BUCKET|import |require|Date\.now|new Date\(\)|Math\.random|crypto)\b/,'the policy has no I/O, clock or randomness');
const H=3600000,MIN=60000,at=ms=>new Date(ms).toISOString(),T=s=>Date.parse(s);
const helpers={dailyDue};
const epg=(facts,now)=>P.evaluateEpg(facts,now,helpers);
const keys=result=>result.issues.map(item=>item.key);

// 1. EPG across the Madrid DST changes: the due time follows 17:00 local, judged by the stored publication.
{
 // Fall back: before 25 Oct 2026 (CEST) 17:00 is 15:00Z, after it (CET) 16:00Z.
 assert.equal(epg({authority:'d1',publishedAt:at(T('2026-10-23T15:20:00Z'))},T('2026-10-24T17:30:00Z')).state,'delayed','2.5 h past 15:00Z with no new publication: delayed, no alert');
 assert.equal(epg({authority:'d1',publishedAt:at(T('2026-10-25T15:20:00Z'))},T('2026-10-26T17:30:00Z')).state,'waiting','1.5 h past 16:00Z');
 assert.equal(epg({authority:'d1',publishedAt:at(T('2026-10-26T16:10:00Z'))},T('2026-10-26T17:30:00Z')).state,'healthy','published after the due time');
 // Spring forward: 29 Mar 2026, 17:00 is 16:00Z before and 15:00Z after.
 assert.equal(epg({authority:'d1',publishedAt:at(T('2026-03-28T16:05:00Z'))},T('2026-03-29T15:30:00Z')).state,'waiting');
 assert.equal(epg({authority:'d1',publishedAt:at(T('2026-03-29T15:05:00Z'))},T('2026-03-29T17:30:00Z')).state,'healthy');
 // Before today's due time the previous day's publication still counts, and a very late one escalates.
 assert.equal(epg({authority:'d1',publishedAt:at(T('2026-11-05T16:10:00Z'))},T('2026-11-06T09:00:00Z')).state,'healthy');
 const stale=epg({authority:'d1',publishedAt:at(T('2026-11-04T16:10:00Z'))},T('2026-11-06T22:30:00Z'));
 assert.equal(stale.state,'degraded');assert.deepEqual(keys(stale),['epg_stale']);
 // A delayed Worker trigger inside the grace window is not an incident; the same facts past the grace are.
 assert.equal(epg({authority:'d1',publishedAt:at(T('2026-11-05T16:10:00Z'))},T('2026-11-06T17:10:00Z')).state,'waiting');
 assert.equal(epg({authority:'d1',publishedAt:at(T('2026-11-05T16:10:00Z'))},T('2026-11-06T19:30:00Z')).state,'delayed');
 assert.equal(epg({authority:'d1',publishedAt:at(T('2026-11-05T16:10:00Z'))},T('2026-11-06T21:10:00Z')).state,'degraded');
 // A failed run names itself; an unreadable or held authority is a critical degraded issue.
 assert.deepEqual(keys(epg({authority:'d1',publishedAt:at(T('2026-11-04T16:10:00Z')),runError:true},T('2026-11-06T22:30:00Z'))),['epg_failed']);
 const held=epg({authority:'held',publishedAt:at(T('2026-11-06T16:10:00Z'))},T('2026-11-06T17:30:00Z'));
 assert.equal(held.state,'degraded');assert.deepEqual(keys(held),['epg_authority']);assert.equal(held.issues[0].critical,true);
 assert.equal(stale.issues[0].critical,undefined,'an ordinary degraded issue is not critical');
 assert.equal(epg({error:true},T('2026-11-06T17:30:00Z')).state,'degraded','an unreadable source is itself reported');
 assert.deepEqual(keys(epg({error:true},T('2026-11-06T17:30:00Z'))),['epg_unreadable']);
 assert.ok(keys(epg({authority:'d1',publishedAt:at(T('2026-11-06T16:10:00Z')),resourceLimit:true},T('2026-11-06T17:30:00Z'))).includes('epg_resource_limit'),'1102/unknown limit text is surfaced');
}

// 2. Discovery: a backlog follows its own backoff; the commit without a finished discovery is a state, not an alarm.
// AIR-598: owed work and every time the rule uses come from the shared classification (src/discovery.js `discoveryQueueState`): `allowedAt` (the effective gate),
// `checkpointAt` and `lastChunkAt` of the published generation only. The raw continuation and `lastChunkFinishedAt` are never read for timing.
{
 const now=T('2026-11-06T18:00:00Z');
 const q=(extra={})=>({state:'backlog',reason:'chunk_budget',owed:true,eligible:true,remainingChunks:10,allowedAt:null,checkpointAt:at(now-30*MIN),lastChunkAt:at(now-20*MIN),...extra});
 const base={executor:'external',health:'settled',publishedRunId:'r1',readout:null};
 const rec=extra=>({stage:'paused',reason:'chunk_budget',remainingChunks:10,at:at(now-30*MIN),programmeRunId:'r1',...extra});
 const ev=(queue,extra={},previous=null)=>P.evaluateDiscovery({...base,continuation:rec(),queue,...extra},now,previous);
 assert.equal(ev(q({allowedAt:at(now+40*MIN),eligible:false})).state,'waiting','the next allowed progress is in the future: waiting by design');
 assert.equal(ev(q({allowedAt:at(now-20*MIN)})).state,'waiting','just past the allowed time');
 assert.equal(ev(q({allowedAt:at(now-2*H),checkpointAt:at(now-2*H),lastChunkAt:at(now-2*H)})).state,'delayed');
 const stalled=ev(q({allowedAt:at(now-4*H),checkpointAt:at(now-5*H),lastChunkAt:at(now-5*H)}));
 assert.equal(stalled.state,'degraded');assert.deepEqual(keys(stalled),['discovery_stalled']);
 // The EPG just committed and discovery has not started: a fresh backlog with a due time of now is healthy.
 assert.equal(ev(q({reason:'pending',allowedAt:null,checkpointAt:at(now-5*MIN),lastChunkAt:null})).state,'healthy');
 // Retry backoff in the future is waiting even with an old last chunk.
 assert.equal(ev(q({reason:'backoff',eligible:false,allowedAt:at(now+30*MIN),checkpointAt:at(now-8*H),lastChunkAt:at(now-8*H)})).state,'waiting');
 // A known budget the Workflow renews at once is allowed from its checkpoint, whatever future gate it still carries (the classifier's `allowedAt`): no waiting
 // hides a stall of renewed work.
 assert.equal(ev(q({allowedAt:at(now-5*H),checkpointAt:at(now-5*H),lastChunkAt:at(now-5*H)}),{continuation:rec({nextCatchUpAt:at(now+40*MIN)})}).state,'degraded','a future leftover gate does not wait a renewed backlog');
 // A foreign record's times are not this generation's: the raw continuation and lastChunkFinishedAt are ignored.
 assert.equal(ev(q({allowedAt:at(now-4*H),checkpointAt:at(now-5*H),lastChunkAt:at(now-5*H)}),{lastChunkFinishedAt:at(now-MIN),continuation:rec({at:at(now-MIN)})}).state,'degraded','a recent batch of another generation does not hide the stall');
 // Owner conditions and the Workflow instance.
 const quarantined=ev(q({allowedAt:at(now+10*MIN),eligible:false}),{executor:'workflow',readout:{stalled:false,quarantined:true}});
 assert.equal(quarantined.state,'degraded');assert.deepEqual(keys(quarantined),['discovery_quarantined']);assert.equal(quarantined.issues[0].critical,true);
 const wfStalled=ev(q({allowedAt:at(now-20*MIN)}),{executor:'workflow',readout:{stalled:true,quarantined:false}});
 assert.equal(wfStalled.state,'degraded');assert.ok(keys(wfStalled).includes('discovery_executor_stalled'));
 // An unconfirmed state has no trustworthy record time: it runs on its own clock from the first tick that observed it (`unknownSince`), whatever the records say.
 const unknown=reason=>({state:'unknown',reason,owed:null,eligible:null,remainingChunks:null,allowedAt:null,checkpointAt:null,lastChunkAt:null});
 const first=ev(unknown('generation_mismatch'),{publishedRunId:'r2',continuation:rec({at:at(now-5*H),nextCatchUpAt:at(now-4*H)})});
 assert.equal(first.state,'waiting','a fresh handoff waits, and a foreign gate is not an overdue gate');assert.deepEqual(keys(first),[]);assert.equal(first.facts.unknownSince,at(now));
 const mismatch=ev(unknown('generation_mismatch'),{publishedRunId:'r2',continuation:rec({at:at(now-5*H),nextCatchUpAt:at(now-4*H)})},{unknownSince:at(now-3*H)});
 assert.ok(keys(mismatch).includes('discovery_unconfirmed'),'a continuation of another generation unconfirmed for 3 hours');assert.ok(keys(mismatch).includes('discovery_generation_mismatch'));
 assert.ok(!keys(mismatch).includes('discovery_stalled'));assert.equal(mismatch.facts.unknownSince,at(now-3*H),'the clock is kept, not restarted');
 for(const reason of ['no_continuation','no_status','partial_counts','drain_unconfirmed','admission_unreadable','records_unreadable']){
  const fresh=ev(unknown(reason),{continuation:null});
  assert.equal(fresh.state,'delayed',reason+': missing proof is never healthy');assert.deepEqual(keys(fresh),[],reason);
  assert.deepEqual(keys(ev(unknown(reason),{continuation:null},{unknownSince:at(now-3*H)})),['discovery_unconfirmed'],reason+': bounded by its own clock');
 }
 assert.equal(ev(q()).facts.unknownSince,null,'a known state resets the clock');
 // The drained series of 23 Nov is proven empty: healthy, no stall from the old gate.
 const drained=rec({remainingChunks:0,at:at(now-21*H),nextCatchUpAt:at(now-20*H),hopId:'hop-27'});
 const empty=ev({state:'empty',reason:'drained',owed:false,eligible:false,proof:'drained',lastChunkAt:at(now-21*H)},{continuation:drained});
 assert.equal(empty.state,'healthy');assert.deepEqual(keys(empty),[]);assert.equal(empty.facts.queueState,'empty');assert.equal(empty.facts.backlog,false);
 const paused=ev({state:'paused',reason:'epg_priority',owed:true,eligible:false,checkpointAt:at(now-6*H),lastChunkAt:at(now-6*H)});
 assert.equal(paused.state,'waiting');assert.deepEqual(keys(paused),[]);
 const unclassified=ev(undefined,{continuation:rec({at:at(now-5*H),nextCatchUpAt:at(now-4*H)})},{unknownSince:at(now-4*H)});
 assert.deepEqual(keys(unclassified),['discovery_unconfirmed'],'facts without the shared classification are never a backlog');
 // An open incident is never recovered by an unreadable or unconfirmed tick: it is held under its own key with its last measured metrics; a change of
 // diagnosis keeps the open key; only a valid disposition recovers it, and says which.
 const open={key:'discovery_stalled',firstSeenAt:at(now-4*H),metrics:{stalledMs:4*H,allowedAt:at(now-8*H),lastChunkAt:at(now-8*H),queueState:'backlog',queueReason:'chunk_budget'},metricsAt:at(now-H)};
 const heldMissing=ev(unknown('no_continuation'),{continuation:null},{open});
 assert.deepEqual(keys(heldMissing),['discovery_stalled']);assert.equal(heldMissing.state,'degraded');assert.equal(heldMissing.issues[0].metrics.held,'queue_unconfirmed');
 assert.equal(heldMissing.issues[0].metrics.stalledMs,4*H,'the last measured stall is kept');assert.equal(heldMissing.issues[0].metricsAt,at(now-H),'under its own time');assert.equal(heldMissing.facts.recovery,null);
 const heldUnreadable=P.evaluateDiscovery({error:true},now,{open});
 assert.deepEqual(keys(heldUnreadable).sort(),['discovery_stalled','discovery_unreadable']);assert.equal(heldUnreadable.issues.find(item=>item.key==='discovery_stalled').metrics.held,'records_unreadable');
 const transition=ev(unknown('generation_mismatch'),{publishedRunId:'r2'},{open,unknownSince:at(now-3*H)});
 assert.deepEqual(keys(transition).filter(key=>key!=='discovery_generation_mismatch'),['discovery_stalled'],'the open key stays');assert.equal(transition.issues[0].metrics.transition,'discovery_unconfirmed');
 for(const [label,queue,reason] of [['proven empty',{state:'empty',reason:'drained',owed:false,eligible:false},'queue_empty'],['EPG pause',{state:'paused',reason:'epg_priority',owed:true,eligible:false},'epg_priority'],['progress within the rule',q({lastChunkAt:at(now-10*MIN),checkpointAt:at(now-10*MIN)}),'within_policy']]){
  const recovered=ev(queue,{},{open});
  assert.deepEqual(keys(recovered),[],label);assert.equal(recovered.facts.recovery,reason,label);assert.equal(P.discoveryRecovery(recovered.facts).reason,reason,label);
 }
 // AIR-687: an open incident with an owed queue is judged by the last chunk that really moved the queue, not by a fresh saved checkpoint. A zero-work loop (a recorded error or a counted fence collision retry,
 // with fresh checkpoint and chunk times and a future gate) neither refreshes the clock nor recovers the incident. Starting to track is a detection baseline, never recovery evidence: an open incident recovers only on
 // useful work newer than its baseline. A legitimate deferred wait (cooldown, budget backoff) with a future gate is not a loop and opens no new stall. A legacy record without the fields keeps the old clocks (above).
 {
  const zeroWork={checkpointAt:at(now-MIN),lastChunkAt:at(now-MIN),allowedAt:at(now+30*MIN),usefulProgressAt:at(now-5*H),usefulProgressSince:at(now-6*H)};
  for(const [label,queue] of [['saved error checkpoints',{...q(zeroWork),state:'failed',reason:'discovery_fence'}],['saved collision backoff checkpoints',q({...zeroWork,reason:'backoff',fenceCollisions:3})],['collisions, no useful work since tracking began',q({...zeroWork,reason:'backoff',fenceCollisions:2,usefulProgressAt:null,usefulProgressSince:at(now-5*H)})]]){
   const held=ev(queue,{},{open});
   assert.deepEqual(keys(held),['discovery_stalled'],label+': the incident stays open');assert.equal(held.state,'degraded',label);assert.equal(held.facts.recovery,null,label);
   assert.deepEqual(keys(ev(queue)),['discovery_stalled'],label+': and is raised without an earlier incident');
  }
  // A legitimate deferred wait (no collision count): the future gate keeps it `waiting`, no fresh stall; an open incident is held, not recovered, without useful work newer than its baseline.
  const legit=q({...zeroWork,reason:'backoff',usefulProgressAt:null,usefulProgressSince:at(now-5*H)});
  const legitFresh=ev(legit);
  assert.deepEqual([legitFresh.state,keys(legitFresh)],['waiting',[]],'a cooldown with a future gate opens no stall');
  const legitHeld=ev(legit,{},{open});
  assert.deepEqual(keys(legitHeld),['discovery_stalled']);assert.equal(legitHeld.issues[0].metrics.held,'progress_unconfirmed');assert.equal(legitHeld.facts.recovery,null);
  // Rollout: an old three-hour incident, then the first new-version chunk saves a zero-work checkpoint and starts tracking now. That is not recovery; the productive chunk after it is.
  const first=q({checkpointAt:at(now-MIN),lastChunkAt:at(now-MIN),allowedAt:null,usefulProgressAt:null,usefulProgressSince:at(now-10*MIN),reason:'backoff',fenceCollisions:1});
  const justStarted=ev(first,{},{open});
  assert.deepEqual(keys(justStarted),['discovery_stalled'],'starting to track does not close the incident');assert.equal(justStarted.facts.recovery,null);assert.equal(justStarted.issues[0].metrics.held,'progress_unconfirmed');
  const productive=ev(q({...first,usefulProgressAt:at(now-MIN)}),{},{open});
  assert.deepEqual(keys(productive),[]);assert.equal(productive.facts.recovery,'within_policy');
  // The baseline is the last stalled observation's progress time when the incident recorded one: older useful work does not recover it.
  const measured={...open,metrics:{...open.metrics,lastProgressAt:at(now-2*H)}};
  assert.deepEqual(keys(ev(q({...first,usefulProgressAt:at(now-3*H),usefulProgressSince:at(now-6*H)}),{},{open:measured})),['discovery_stalled'],'useful work older than the baseline');
  assert.equal(ev(q({...first,usefulProgressAt:at(now-H),usefulProgressSince:at(now-6*H)}),{},{open:measured}).facts.recovery,'within_policy');
  // A stalled observation records the progress time it judged, for the next tick's baseline.
  assert.equal(ev(queueStalledTracked()).issues[0].metrics.lastProgressAt,at(now-5*H));
  // A quiet state is unaffected: the proven empty queue and the EPG pause still recover regardless of the useful-work clock.
  assert.equal(ev({state:'empty',reason:'drained',owed:false,eligible:false,usefulProgressSince:at(now-9*H)},{},{open}).facts.recovery,'queue_empty');
  assert.equal(ev({state:'paused',reason:'epg_priority',owed:true,eligible:false,usefulProgressSince:at(now-9*H)},{},{open}).facts.recovery,'epg_priority');
  function queueStalledTracked(){return {...q({...zeroWork}),state:'failed',reason:'discovery_fence'};}
 }
 // Re-review: owed work without any usable time of this generation is unconfirmed, never healthy and never a recovery `within_policy`.
 const untimed=q({allowedAt:null,checkpointAt:null,lastChunkAt:null});
 const untimedFresh=ev(untimed);
 assert.deepEqual([untimedFresh.state,untimedFresh.issues.length,untimedFresh.issues[0]?.key],['delayed',0,undefined]);assert.equal(untimedFresh.facts.unknownSince,at(now));
 const untimedHeld=ev(untimed,{},{open});
 assert.deepEqual(keys(untimedHeld),['discovery_stalled']);assert.equal(untimedHeld.issues[0].metrics.held,'queue_unconfirmed');assert.equal(untimedHeld.facts.recovery,null);
 assert.deepEqual(keys(ev(untimed,{},{unknownSince:at(now-3*H)})),['discovery_unconfirmed'],'bounded by its own clock');
 const unreadLease=ev({state:'unknown',reason:'lease_unread',owed:true,eligible:null,checkpointAt:at(now-10*MIN),lastChunkAt:at(now-10*MIN)},{},{open});
 assert.deepEqual(keys(unreadLease),['discovery_stalled'],'an unread lease is no progress: the incident is held');assert.equal(unreadLease.facts.recovery,null);
 assert.deepEqual(P.discoveryRecovery({recovery:'queue_empty',queueReason:'drained'}),{reason:'queue_empty',message:'Recovered: the Discovery queue is proven empty (drained); this is not new progress'});
 assert.ok(keys(ev(q(),{continuation:null,resourceLimit:true})).includes('discovery_resource_limit'));
 assert.deepEqual(keys(P.evaluateDiscovery({error:true},now)),['discovery_unreadable']);
}

// 3. Ratings: the read model's health, the mode switch, repeated resource limits. 403 and 429 surface as the model's cooldown or failure.
{
 const now=T('2026-11-06T18:00:00Z');
 const model=extra=>({mode:'cloudflare',health:'healthy',failure:null,...extra});
 for(const [health,state] of [['idle','healthy'],['healthy','healthy'],['waiting','waiting'],['cooldown','waiting'],['stalled','degraded'],['quarantined','degraded'],['failed_permanent','degraded'],['unknown','degraded']])assert.equal(P.evaluateRatings(model({health}),now).state,state,health);
 assert.deepEqual(keys(P.evaluateRatings(model({health:'stalled'}),now)),['ratings_stalled']);
 assert.deepEqual(keys(P.evaluateRatings(model({health:'quarantined',quarantine:{reason:'budget_exhausted'}}),now)),['ratings_quarantined']);
 for(const health of ['quarantined','failed_permanent'])assert.equal(P.evaluateRatings(model({health}),now).issues[0].critical,true,health+' is critical');
 assert.equal(P.evaluateRatings(model({health:'stalled'}),now).issues[0].critical,undefined,'a stalled Ratings day is ordinary');
 // 429/403: a cooldown with a transient failure is waiting by design, not an alert.
 const cooling=P.evaluateRatings(model({health:'cooldown',failure:{class:'transient',code:'upstream_blocked',consecutive:1}}),now);
 assert.equal(cooling.state,'waiting');assert.deepEqual(keys(cooling),[]);
 assert.ok(keys(P.evaluateRatings(model({health:'cooldown',failure:{class:'transient',code:'worker_1102',consecutive:3}}),now)).includes('ratings_resource_limit'));
 // A mode switch: fine while fresh, an issue when it stays open; the external mode is judged like the cloudflare one.
 assert.equal(P.evaluateRatings(model({mode:'switching',updatedAt:at(now-20*MIN)}),now).state,'waiting');
 const stuck=P.evaluateRatings(model({mode:'switching',updatedAt:at(now-3*H)}),now);
 assert.equal(stuck.state,'degraded');assert.ok(keys(stuck).includes('ratings_switch_open'));
 assert.equal(P.evaluateRatings(model({mode:'external',health:'stalled'}),now).state,'degraded');
 assert.deepEqual(keys(P.evaluateRatings({error:true},now)),['ratings_unreadable']);
}

// 4. Prediction queue (AIR-556): the verdict arrives in `facts.stall` from the one shared assessment (enrichment.js). Empty and deferred work never alert,
// eligible work with no confirmed progress degrades, unknown evidence is delayed (never healthy), and the alert needs one snapshot.
{
 const now=T('2026-11-06T18:00:00Z');
 const q=extra=>({present:true,pendingCount:5,eligibleNow:5,lastProgressAt:at(now-30*MIN),stall:{state:'ok',idleMs:30*MIN},...extra});
 const stalled=idleMs=>({stall:{state:'no_progress',reason:'no_productive_batch',idleMs,sinceKnown:true},lastProgressAt:at(now-idleMs)});
 assert.equal(P.evaluatePredictions(q({pendingCount:0,eligibleNow:0,stall:{state:'idle',idleMs:null},lastProgressAt:at(now-30*H)}),null,now).state,'healthy','an empty queue is healthy however old the last batch is');
 assert.equal(P.evaluatePredictions(q(),null,now).state,'healthy');
 assert.equal(P.evaluatePredictions(q({stall:{state:'running',idleMs:null}}),null,now).state,'healthy','a live run is not an incident');
 const stale=P.evaluatePredictions(q(stalled(70*MIN)),null,now);
 assert.equal(stale.state,'degraded');assert.deepEqual(keys(stale),['predictions_no_progress']);
 assert.doesNotMatch(stale.issues[0].message,/api_error|auth|missed|expired/i,'no claim about why Tasks did not run');
 assert.equal(P.evaluatePredictions(q({pendingCount:9,...stalled(5*H)}),{pendingCount:5},now).state,'degraded','growth changes nothing: one issue, one key');
 assert.deepEqual(keys(P.evaluatePredictions(q({pendingCount:9,...stalled(5*H)}),{pendingCount:5},now)),['predictions_no_progress']);
 assert.equal(P.evaluatePredictions(q({eligibleNow:0,stall:{state:'waiting',idleMs:null},nextRetryAt:at(now+H)}),null,now).state,'waiting','work deferred by its own retry time waits by design');
 assert.equal(P.evaluatePredictions(q({lastProgressAt:null,stall:{state:'unknown',reason:'no_progress_evidence',idleMs:null}}),null,now).state,'delayed','unknown progress time is never healthy and never an alert by itself');
 assert.deepEqual(keys(P.evaluatePredictions(q({lastProgressAt:null,stall:{state:'unknown',reason:'no_progress_evidence',idleMs:null}}),null,now)),[]);
 const unsplit=P.evaluatePredictions(q({eligibleNow:null,stall:{state:'unknown',reason:'queue_unreadable',idleMs:null}}),null,now);
 assert.equal(unsplit.state,'delayed','pending work that cannot be split into eligible and deferred is visible, never healthy');assert.deepEqual(keys(unsplit),[],'and raises no false alert');
 assert.equal(P.evaluatePredictions(q({pendingCount:2,eligibleNow:0,stall:{state:'idle',idleMs:null}}),null,now).state,'healthy','only retry-exhausted work is not a stall');
 assert.equal(P.evaluatePredictions({present:false},null,now).state,'waiting');
 assert.deepEqual(keys(P.evaluatePredictions({error:true},null,now)),['predictions_unreadable']);
 // One snapshot confirms the prediction verdict; every other degraded issue still needs two.
 const issue=P.evaluatePredictions(q(stalled(70*MIN)),null,now).issues;
 assert.equal(P.planAlerts(issue,{issues:{}},now).sends.length,1,'confirmed by one snapshot');
 assert.equal(P.planAlerts([{key:'epg_stale',severity:'degraded',stream:'epg',message:'x'}],{issues:{}},now).sends.length,0,'other degraded issues keep two snapshots');
}

// 5. Overall state: the worst stream; delayed and waiting never produce an alertable issue.
{
 const now=T('2026-11-06T18:00:00Z');
 const facts={epg:{authority:'d1',publishedAt:at(T('2026-11-06T16:10:00Z'))},discovery:{executor:'external',continuation:null,queue:{state:'empty',reason:'complete',owed:false,eligible:false}},ratings:{mode:'cloudflare',health:'waiting'},predictions:{present:true,pendingCount:0}};
 const all=P.evaluateAll(facts,null,now,helpers);
 assert.equal(all.overall,'waiting');assert.equal(all.streams.length,4);assert.deepEqual(all.issues,[]);
 const bad=P.evaluateAll({...facts,ratings:{mode:'cloudflare',health:'quarantined'}},null,now,helpers);
 assert.equal(bad.overall,'degraded');assert.deepEqual(keys(bad),['ratings_quarantined']);
 assert.deepEqual([...P.STATES],['healthy','waiting','delayed','degraded'],'four states; needs_owner is retired');
}

// 6. Alert planning: confirmation, cooldown, escalation, bounded sends per day, recovery once, no duplicates on repeat.
{
 const degraded=[{key:'epg_stale',severity:'degraded',stream:'epg',message:'stale'}];
 const owner=[{key:'ratings_quarantined',severity:'degraded',critical:true,stream:'ratings',message:'quarantined'}];
 const t0=T('2026-11-06T20:00:00Z');
 let plan=P.planAlerts(degraded,{issues:{}},t0);
 assert.deepEqual(plan.sends,[],'a degraded issue is confirmed by a second snapshot');assert.equal(plan.state.issues.epg_stale.seen,1);
 plan=P.planAlerts(degraded,plan.state,t0+H);
 assert.deepEqual(plan.sends.map(item=>[item.kind,item.key]),[['alert','epg_stale']],'one alert on the second snapshot');
 const sentAt=plan.state.issues.epg_stale.lastSentAt;
 plan=P.planAlerts(degraded,plan.state,t0+2*H);assert.deepEqual(plan.sends,[],'the same snapshot repeated inside the cooldown sends nothing');
 plan=P.planAlerts(degraded,plan.state,t0+H+7*H);assert.deepEqual(plan.sends.map(item=>item.kind),['reminder'],'a reminder after the 6 h cooldown');assert.notEqual(plan.state.issues.epg_stale.lastSentAt,sentAt);
 // A critical issue alerts at the first sight, and an ordinary issue that turns critical escalates inside the reminder interval.
 assert.deepEqual(P.planAlerts(owner,{issues:{}},t0).sends.map(item=>[item.kind,item.severity,item.critical]),[['alert','degraded',true]]);
 let upgrade=P.planAlerts(degraded,{issues:{}},t0);upgrade=P.planAlerts(degraded,upgrade.state,t0+H);
 const escalated=P.planAlerts([{...degraded[0],critical:true}],upgrade.state,t0+H+10*MIN);
 assert.deepEqual(escalated.sends.map(item=>item.kind),['escalation']);
 // Critical back to ordinary sends nothing; the issue stays open on the same reminder interval.
 const downgraded=P.planAlerts(degraded,escalated.state,t0+H+20*MIN);
 assert.deepEqual(downgraded.sends,[]);assert.equal(downgraded.state.issues.epg_stale.critical,false);
 // Recovery: once, only for an issue that was sent; one that never alerted disappears silently.
 const recovered=P.planAlerts([],plan.state,t0+20*H);assert.deepEqual(recovered.sends.map(item=>[item.kind,item.key]),[['recovery','epg_stale']]);assert.deepEqual(recovered.state.issues,{});
 const quiet=P.planAlerts([],P.planAlerts(degraded,{issues:{}},t0).state,t0+H);assert.deepEqual(quiet.sends,[],'an unconfirmed issue that clears sends no recovery');
 // Bounded per day.
 let bounded={issues:{k:{severity:'degraded',critical:true,firstSeenAt:at(t0),seen:50,lastSentAt:at(t0-7*H),sendCount:8,sendDay:'2026-11-06',sendsToday:8}}};
 assert.deepEqual(P.planAlerts([{key:'k',severity:'degraded',critical:true,stream:'x',message:'m'}],bounded,t0).sends,[],'at most eight messages per issue per day');
 assert.equal(P.planAlerts([{key:'k',severity:'degraded',critical:true,stream:'x',message:'m'}],bounded,T('2026-11-07T08:00:00Z')).sends.length,1,'the count resets on the next day');
 // Delayed and waiting issues never alert.
 assert.deepEqual(P.planAlerts([{key:'epg_delayed',severity:'delayed',stream:'epg',message:'d'}],{issues:{}},t0).sends,[]);
 // No payload carries a title or a rating: only the fixed fields.
 const sent=P.planAlerts(owner,{issues:{}},t0).sends[0];
 assert.deepEqual(Object.keys(sent).sort(),['critical','firstSeenAt','key','kind','message','severity','stream']);
}

// 7. ADR 0206: one reminder interval for every issue, critical or not, and the legacy `needs_owner` state written before the change.
{
 const t0=T('2026-11-24T10:00:00Z');
 assert.equal(P.ALERT_POLICY.reminderMs,6*H);assert.equal(P.ALERT_POLICY.cooldownMs,undefined,'no per-severity cooldown');
 // A critical issue reminds after 6 h, not after 2 h.
 const hard=[{key:'ratings_quarantined',severity:'degraded',critical:true,stream:'ratings',message:'q'}];
 let plan=P.planAlerts(hard,{issues:{}},t0);assert.deepEqual(plan.sends.map(item=>item.kind),['alert']);
 for(const hours of [1,2,3,5])assert.deepEqual(P.planAlerts(hard,plan.state,t0+hours*H).sends,[],'no reminder after '+hours+' h');
 assert.deepEqual(P.planAlerts(hard,plan.state,t0+6*H).sends.map(item=>item.kind),['reminder'],'the reminder at 6 h');
 // The per-key one-snapshot confirmation of the ordinary issues is unchanged, and they share the same interval.
 const stall=[{key:'predictions_no_progress',severity:'degraded',stream:'predictions',message:'p'}];
 const first=P.planAlerts(stall,{issues:{}},t0);assert.deepEqual(first.sends.map(item=>[item.kind,item.critical]),[['alert',false]]);
 assert.deepEqual(P.planAlerts(stall,first.state,t0+5*H).sends,[]);assert.deepEqual(P.planAlerts(stall,first.state,t0+6*H).sends.map(item=>item.kind),['reminder']);
 // Legacy entries: an open needs_owner issue sent 3 h ago keeps its history, is critical, neither escalates nor recovers, and reminds at lastSentAt + 6 h.
 const legacy={issues:{ratings_quarantined:{severity:'needs_owner',firstSeenAt:at(t0-30*H),seen:30,lastSentAt:at(t0-3*H),sendCount:5,sendDay:'2026-11-24',sendsToday:2}}};
 const kept=P.planAlerts(hard,legacy,t0);
 assert.deepEqual(kept.sends,[],'no new alert, reminder or escalation only because the enum changed');
 assert.deepEqual(kept.state.issues.ratings_quarantined,{severity:'degraded',critical:true,firstSeenAt:at(t0-30*H),seen:31,lastSentAt:at(t0-3*H),sendCount:5,sendDay:'2026-11-24',sendsToday:2,stream:'ratings'});
 assert.deepEqual(P.planAlerts(hard,legacy,t0+3*H).sends.map(item=>[item.kind,item.severity,item.critical]),[['reminder','degraded',true]]);
 // A legacy needs_owner issue that is now reported as a fresh critical issue under the same key is the same issue; one that cleared recovers once.
 assert.deepEqual(P.planAlerts([],legacy,t0).sends.map(item=>[item.kind,item.key,item.severity]),[['recovery','ratings_quarantined','healthy']]);
 // A legacy needs_owner issue that is now ordinary (a recoverable stop) is not an escalation and sends nothing inside the interval.
 const legacyStop={issues:{canonical_producer_failed:{severity:'needs_owner',firstSeenAt:at(t0-2*H),seen:2,lastSentAt:at(t0-2*H),sendCount:1,sendDay:'2026-11-24',sendsToday:1}}};
 assert.deepEqual(P.planAlerts([{key:'canonical_producer_failed',severity:'degraded',stream:'canonical_producer',message:'s'}],legacyStop,t0).sends,[]);
 // A legacy ordinary degraded entry that becomes critical escalates, as before.
 const legacyOrdinary={issues:{canonical_producer_failed:{severity:'degraded',firstSeenAt:at(t0-2*H),seen:2,lastSentAt:at(t0-H),sendCount:1,sendDay:'2026-11-24',sendsToday:1}}};
 assert.deepEqual(P.planAlerts([{key:'canonical_producer_failed',severity:'degraded',critical:true,stream:'canonical_producer',message:'s'}],legacyOrdinary,t0).sends.map(item=>item.kind),['escalation']);
 // A legacy needs_owner issue in the input (an old projection) is read as critical degraded.
 assert.deepEqual(P.planAlerts([{key:'x',severity:'needs_owner',stream:'x',message:'m'}],{issues:{}},t0).sends.map(item=>[item.kind,item.severity,item.critical]),[['alert','degraded',true]]);
 // The read-side helpers.
 assert.equal(P.normalizeSeverity('needs_owner'),'degraded');assert.equal(P.normalizeSeverity('delayed'),'delayed');
 assert.deepEqual(P.normalizeMessage({id:'k|alert|t',kind:'alert',severity:'needs_owner',key:'k'}),{id:'k|alert|t',kind:'alert',severity:'degraded',critical:true,key:'k'},'the id is kept so the receiver can still drop a repeat');
 const recovery={id:'k|recovery|t',kind:'recovery',severity:'healthy',key:'k'};assert.equal(P.normalizeMessage(recovery),recovery);
 assert.equal(P.isCritical({severity:'degraded'}),false);assert.equal(P.isCritical({severity:'needs_owner'}),true);assert.equal(P.isCritical({severity:'degraded',critical:true}),true);
 // A legacy poster projection that still says needs_owner is read as a critical degraded issue.
 const posters=P.evaluateCatalogPosters({state:'failed',monitor:'needs_owner',detail:'run_failed'});
 assert.deepEqual([posters.state,posters.issues[0].severity,posters.issues[0].critical],['degraded','degraded',true]);
 const current=P.evaluateCatalogPosters({state:'failed',monitor:'degraded',critical:true,detail:'run_failed'});
 assert.deepEqual([current.state,current.issues[0].critical],['degraded',true]);
 assert.equal(P.evaluateCatalogPosters({state:'stalled',monitor:'degraded',detail:'run_stuck'}).issues[0].critical,undefined,'a stalled poster week is ordinary');
}

// 8. Rollback replay of the planner: the previous policy over alert state written by the new one. Keys and history are kept; an ordinary entry
// behaves as before (no message inside its 6 h interval, a reminder after it); a cleared issue recovers once; the only difference is one escalation
// per issue that is open and critical at the rollback, because the old evaluation calls it needs_owner against a stored degraded entry.
{
 const t0=T('2026-11-24T10:00:00Z');
 const written={issues:{
  epg_stale:{severity:'degraded',critical:false,firstSeenAt:at(t0-5*H),seen:5,lastSentAt:at(t0-3*H),sendCount:1,sendDay:'2026-11-24',sendsToday:1},
  ratings_quarantined:{severity:'degraded',critical:true,firstSeenAt:at(t0-4*H),seen:4,lastSentAt:at(t0-H),sendCount:1,sendDay:'2026-11-24',sendsToday:1},
  discovery_quarantined:{severity:'degraded',critical:true,firstSeenAt:at(t0-4*H),seen:4,lastSentAt:at(t0-H),sendCount:1,sendDay:'2026-11-24',sendsToday:1}}};
 const oldIssues=[{key:'epg_stale',severity:'degraded',stream:'epg',message:'s'},{key:'ratings_quarantined',severity:'needs_owner',stream:'ratings',message:'q'}];
 const replay=Old.planAlerts(oldIssues,written,t0);
 assert.deepEqual(replay.sends.map(item=>[item.kind,item.key,item.severity]),[['escalation','ratings_quarantined','needs_owner'],['recovery','discovery_quarantined','healthy']],'one bounded escalation, one recovery of the issue that cleared, nothing for the ordinary one');
 assert.deepEqual([replay.state.issues.epg_stale.firstSeenAt,replay.state.issues.epg_stale.sendCount,replay.state.issues.ratings_quarantined.firstSeenAt],[at(t0-5*H),1,at(t0-4*H)],'history kept');
 assert.deepEqual(Old.planAlerts(oldIssues.slice(0,1),{issues:{epg_stale:written.issues.epg_stale}},t0+3*H).sends.map(item=>item.kind),['reminder'],'the ordinary issue reminds 6 h after its last send, as before');
}
console.log('Monitor policy: EPG across DST and delayed triggers, Discovery backoff versus stalled, Ratings health and switch, empty versus stale prediction queue, overall state, alert planning, one reminder interval and the legacy needs_owner state passed');
