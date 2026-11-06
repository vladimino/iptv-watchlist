// AIR-349: the pure monitor policy. Health of each stream from observed facts (DST, delayed trigger, backoff versus stalled, resource
// limits, empty versus stale queue, mode switch, quarantine), and the alert planner (confirmation, cooldown, escalation, recovery,
// bounded sends, duplicates). No I/O, an injected clock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as P from '../src/domain/monitor-policy.js';
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
 // A failed run names itself; an unreadable or held authority needs the owner.
 assert.deepEqual(keys(epg({authority:'d1',publishedAt:at(T('2026-11-04T16:10:00Z')),runError:true},T('2026-11-06T22:30:00Z'))),['epg_failed']);
 const held=epg({authority:'held',publishedAt:at(T('2026-11-06T16:10:00Z'))},T('2026-11-06T17:30:00Z'));
 assert.equal(held.state,'needs_owner');assert.deepEqual(keys(held),['epg_authority']);
 assert.equal(epg({error:true},T('2026-11-06T17:30:00Z')).state,'degraded','an unreadable source is itself reported');
 assert.deepEqual(keys(epg({error:true},T('2026-11-06T17:30:00Z'))),['epg_unreadable']);
 assert.ok(keys(epg({authority:'d1',publishedAt:at(T('2026-11-06T16:10:00Z')),resourceLimit:true},T('2026-11-06T17:30:00Z'))).includes('epg_resource_limit'),'1102/unknown limit text is surfaced');
}

// 2. Discovery: a backlog follows its own backoff; the commit without a finished discovery is a state, not an alarm.
{
 const now=T('2026-11-06T18:00:00Z');
 const base={executor:'external',health:'settled',publishedRunId:'r1',lastChunkFinishedAt:at(now-20*MIN),readout:null};
 const rec=extra=>({stage:'paused',reason:'chunk_budget',remainingChunks:10,at:at(now-30*MIN),programmeRunId:'r1',...extra});
 assert.equal(P.evaluateDiscovery({...base,continuation:null},now).state,'healthy','no backlog');
 assert.equal(P.evaluateDiscovery({...base,continuation:rec({nextCatchUpAt:at(now+40*MIN)})},now).state,'waiting','the next allowed progress is in the future: waiting by design');
 assert.equal(P.evaluateDiscovery({...base,continuation:rec({nextCatchUpAt:at(now-20*MIN)})},now).state,'waiting','just past the allowed time');
 assert.equal(P.evaluateDiscovery({...base,lastChunkFinishedAt:at(now-2*H),continuation:rec({at:at(now-2*H),nextCatchUpAt:at(now-2*H)})},now).state,'delayed');
 const stalled=P.evaluateDiscovery({...base,lastChunkFinishedAt:at(now-5*H),continuation:rec({at:at(now-5*H),nextCatchUpAt:at(now-4*H)})},now);
 assert.equal(stalled.state,'degraded');assert.deepEqual(keys(stalled),['discovery_stalled']);
 // The EPG just committed and discovery has not started: a fresh backlog with a due time of now is healthy.
 assert.equal(P.evaluateDiscovery({...base,lastChunkFinishedAt:null,continuation:rec({at:at(now-5*MIN),nextCatchUpAt:at(now-5*MIN)})},now).state,'waiting');
 // Retry backoff in the future (retryAt) is waiting even with an old last chunk.
 assert.equal(P.evaluateDiscovery({...base,lastChunkFinishedAt:at(now-8*H),continuation:rec({at:at(now-8*H),retryAt:at(now+30*MIN)})},now).state,'waiting');
 // Owner conditions and the Workflow instance.
 assert.equal(P.evaluateDiscovery({...base,executor:'invalid',continuation:null},now).state,'needs_owner');
 const quarantined=P.evaluateDiscovery({...base,executor:'workflow',readout:{stalled:false,quarantined:true},continuation:rec({nextCatchUpAt:at(now+10*MIN)})},now);
 assert.equal(quarantined.state,'needs_owner');assert.deepEqual(keys(quarantined),['discovery_quarantined']);
 const wfStalled=P.evaluateDiscovery({...base,executor:'workflow',readout:{stalled:true,quarantined:false},continuation:rec({nextCatchUpAt:at(now-20*MIN)})},now);
 assert.equal(wfStalled.state,'degraded');assert.ok(keys(wfStalled).includes('discovery_executor_stalled'));
 // A stale continuation of another generation is named when it is stalled.
 const mismatch=P.evaluateDiscovery({...base,publishedRunId:'r2',lastChunkFinishedAt:at(now-5*H),continuation:rec({at:at(now-5*H),nextCatchUpAt:at(now-4*H)})},now);
 assert.ok(keys(mismatch).includes('discovery_generation_mismatch'));
 assert.ok(keys(P.evaluateDiscovery({...base,continuation:null,resourceLimit:true},now)).includes('discovery_resource_limit'));
 assert.deepEqual(keys(P.evaluateDiscovery({error:true},now)),['discovery_unreadable']);
}

// 3. Ratings: the read model's health, the mode switch, repeated resource limits. 403 and 429 surface as the model's cooldown or failure.
{
 const now=T('2026-11-06T18:00:00Z');
 const model=extra=>({mode:'cloudflare',health:'healthy',failure:null,...extra});
 for(const [health,state] of [['idle','healthy'],['healthy','healthy'],['waiting','waiting'],['cooldown','waiting'],['stalled','degraded'],['quarantined','needs_owner'],['failed_permanent','needs_owner'],['unknown','degraded']])assert.equal(P.evaluateRatings(model({health}),now).state,state,health);
 assert.deepEqual(keys(P.evaluateRatings(model({health:'stalled'}),now)),['ratings_stalled']);
 assert.deepEqual(keys(P.evaluateRatings(model({health:'quarantined',quarantine:{reason:'budget_exhausted'}}),now)),['ratings_quarantined']);
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

// 4. Prediction queue: empty is healthy, stale pending work is not, growth while idle is named, a missing queue waits.
{
 const now=T('2026-11-06T18:00:00Z');
 const q=extra=>({present:true,pendingCount:5,lastBatchAt:at(now-30*MIN),...extra});
 assert.equal(P.evaluatePredictions(q({pendingCount:0,lastBatchAt:at(now-30*H)}),null,now).state,'healthy','an empty queue is healthy however old the last batch is');
 assert.equal(P.evaluatePredictions(q(),null,now).state,'healthy');
 assert.equal(P.evaluatePredictions(q({lastBatchAt:at(now-4*H)}),null,now).state,'delayed');
 assert.equal(P.evaluatePredictions(q({lastBatchAt:at(now-4*H),pendingCount:9}),{pendingCount:5},now).state,'degraded','growing while idle');
 assert.ok(keys(P.evaluatePredictions(q({lastBatchAt:at(now-4*H),pendingCount:9}),{pendingCount:5},now)).includes('predictions_backlog_growing'));
 const stale=P.evaluatePredictions(q({lastBatchAt:at(now-8*H)}),null,now);
 assert.equal(stale.state,'degraded');assert.deepEqual(keys(stale),['predictions_stale']);
 assert.equal(P.evaluatePredictions(q({lastBatchAt:null}),null,now).state,'degraded','pending work and no model batch ever recorded');
 assert.equal(P.evaluatePredictions({present:false},null,now).state,'waiting');
 assert.deepEqual(keys(P.evaluatePredictions({error:true},null,now)),['predictions_unreadable']);
}

// 5. Overall state: the worst stream; delayed and waiting never produce an alertable issue.
{
 const now=T('2026-11-06T18:00:00Z');
 const facts={epg:{authority:'d1',publishedAt:at(T('2026-11-06T16:10:00Z'))},discovery:{executor:'external',continuation:null},ratings:{mode:'cloudflare',health:'waiting'},predictions:{present:true,pendingCount:0}};
 const all=P.evaluateAll(facts,null,now,helpers);
 assert.equal(all.overall,'waiting');assert.equal(all.streams.length,4);assert.deepEqual(all.issues,[]);
 const bad=P.evaluateAll({...facts,ratings:{mode:'cloudflare',health:'quarantined'}},null,now,helpers);
 assert.equal(bad.overall,'needs_owner');assert.deepEqual(keys(bad),['ratings_quarantined']);
}

// 6. Alert planning: confirmation, cooldown, escalation, bounded sends per day, recovery once, no duplicates on repeat.
{
 const degraded=[{key:'epg_stale',severity:'degraded',stream:'epg',message:'stale'}];
 const owner=[{key:'ratings_quarantined',severity:'needs_owner',stream:'ratings',message:'quarantined'}];
 const t0=T('2026-11-06T20:00:00Z');
 let plan=P.planAlerts(degraded,{issues:{}},t0);
 assert.deepEqual(plan.sends,[],'a degraded issue is confirmed by a second snapshot');assert.equal(plan.state.issues.epg_stale.seen,1);
 plan=P.planAlerts(degraded,plan.state,t0+H);
 assert.deepEqual(plan.sends.map(item=>[item.kind,item.key]),[['alert','epg_stale']],'one alert on the second snapshot');
 const sentAt=plan.state.issues.epg_stale.lastSentAt;
 plan=P.planAlerts(degraded,plan.state,t0+2*H);assert.deepEqual(plan.sends,[],'the same snapshot repeated inside the cooldown sends nothing');
 plan=P.planAlerts(degraded,plan.state,t0+H+7*H);assert.deepEqual(plan.sends.map(item=>item.kind),['reminder'],'a reminder after the 6 h cooldown');assert.notEqual(plan.state.issues.epg_stale.lastSentAt,sentAt);
 // needs_owner alerts at the first sight, and an upgrade escalates inside the cooldown.
 assert.deepEqual(P.planAlerts(owner,{issues:{}},t0).sends.map(item=>item.kind),['alert']);
 let upgrade=P.planAlerts(degraded,{issues:{}},t0);upgrade=P.planAlerts(degraded,upgrade.state,t0+H);
 const escalated=P.planAlerts([{...degraded[0],severity:'needs_owner'}],upgrade.state,t0+H+10*MIN);
 assert.deepEqual(escalated.sends.map(item=>item.kind),['escalation']);
 // Recovery: once, only for an issue that was sent; one that never alerted disappears silently.
 const recovered=P.planAlerts([],plan.state,t0+20*H);assert.deepEqual(recovered.sends.map(item=>[item.kind,item.key]),[['recovery','epg_stale']]);assert.deepEqual(recovered.state.issues,{});
 const quiet=P.planAlerts([],P.planAlerts(degraded,{issues:{}},t0).state,t0+H);assert.deepEqual(quiet.sends,[],'an unconfirmed issue that clears sends no recovery');
 // Bounded per day.
 let bounded={issues:{k:{severity:'needs_owner',firstSeenAt:at(t0),seen:50,lastSentAt:at(t0-5*H),sendCount:8,sendDay:'2026-11-06',sendsToday:8}}};
 assert.deepEqual(P.planAlerts([{key:'k',severity:'needs_owner',stream:'x',message:'m'}],bounded,t0).sends,[],'at most eight messages per issue per day');
 assert.equal(P.planAlerts([{key:'k',severity:'needs_owner',stream:'x',message:'m'}],bounded,T('2026-11-07T08:00:00Z')).sends.length,1,'the count resets on the next day');
 // Delayed and waiting issues never alert.
 assert.deepEqual(P.planAlerts([{key:'epg_delayed',severity:'delayed',stream:'epg',message:'d'}],{issues:{}},t0).sends,[]);
 // No payload carries a title or a rating: only the fixed fields.
 const sent=P.planAlerts(owner,{issues:{}},t0).sends[0];
 assert.deepEqual(Object.keys(sent).sort(),['firstSeenAt','key','kind','message','severity','stream']);
}
console.log('Monitor policy: EPG across DST and delayed triggers, Discovery backoff versus stalled, Ratings health and switch, empty versus stale prediction queue, overall state and alert planning passed');
