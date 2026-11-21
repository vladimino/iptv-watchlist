// AIR-570 / ADR 0186. The monitor stream for the Letterboxd Sync: pure policy, OFFLINE. A dormant executor adds nothing to the monitor; an active one maps its read-model health to the same issue levels
// as the other streams (late, stalled, missed, failed, quarantined, unreadable, 24 h Watchlist staleness, a bounded Event backlog), and recovery follows the shared alert planner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Policy from '../src/domain/monitor-policy.js';

const NOW=Date.parse('2026-11-21T12:00:00Z');
const model=(over={})=>({mode:'cloudflare',health:'healthy',slot:{key:'2026-11-21T1030'},eventsPending:0,sources:{ratings:{lastSuccessAt:'x'},watchlist:{lastSuccessAt:'y',stale:false,warning:null}},quarantine:null,...over});
const keys=r=>r.issues.map(i=>i.key);
const helpers={dailyDue:()=>({due:false,dueAt:NOW})};

// 1. Health to state and issues.
assert.deepEqual([Policy.evaluateLetterboxd(model(),NOW).state,keys(Policy.evaluateLetterboxd(model(),NOW))],['healthy',[]]);
for(const health of ['waiting','switching'])assert.equal(Policy.evaluateLetterboxd(model({health}),NOW).state,'waiting',health+' never alerts');
for(const [health,key] of [['late','letterboxd_slot_late'],['stalled','letterboxd_slot_stalled'],['missed','letterboxd_slot_missed'],['failed','letterboxd_slots_failed'],['unreadable','letterboxd_unreadable']]){
 const r=Policy.evaluateLetterboxd(model({health}),NOW);assert.equal(r.state,'degraded',health);assert.deepEqual(keys(r),[key]);assert.equal(r.stream,'letterboxd');
}
{const r=Policy.evaluateLetterboxd(model({health:'quarantined',quarantine:{reason:'epoch'}}),NOW);assert.equal(r.state,'needs_owner');assert.match(r.issues[0].message,/epoch/);}
// 2. Source staleness: 24 h since the last Watchlist success, and a Watchlist that never succeeded, are actionable on their own; a healthy slot does not hide them.
{
 let r=Policy.evaluateLetterboxd(model({sources:{watchlist:{stale:true,warning:'watchlist_stale'}}}),NOW);assert.deepEqual([r.state,keys(r)],['degraded',['letterboxd_watchlist_stale']]);assert.match(r.issues[0].message,/24 hours/);
 r=Policy.evaluateLetterboxd(model({sources:{watchlist:{stale:true,warning:'watchlist_never_succeeded'}}}),NOW);assert.match(r.issues[0].message,/since the executor started/);
 // A failing Diary does not alert by itself: only the Watchlist is a stale source (Ratings health is the slot health).
 r=Policy.evaluateLetterboxd(model({sources:{ratings:{lastSuccessAt:null},watchlist:{stale:false}}}),NOW);assert.equal(r.state,'healthy');
}
// 3. A pending Event backlog is actionable only past a day of slots.
assert.equal(Policy.evaluateLetterboxd(model({eventsPending:7}),NOW).state,'healthy');
assert.deepEqual(keys(Policy.evaluateLetterboxd(model({eventsPending:8}),NOW)),['letterboxd_events_backlog']);
// 4. No model or an error model is unreadable, never healthy.
for(const bad of [null,undefined,{error:true}]){const r=Policy.evaluateLetterboxd(bad,NOW);assert.equal(r.state,'degraded');assert.deepEqual(keys(r),['letterboxd_unreadable']);}
// 5. A dormant executor adds NO stream; an active one adds exactly one, and never changes the other streams.
{
 const base={epg:{error:true},discovery:{error:true},ratings:{error:true},predictions:{error:true}};
 const without=Policy.evaluateAll(base,null,NOW,helpers),withLb=Policy.evaluateAll({...base,letterboxd:model({health:'late'})},null,NOW,helpers);
 assert.ok(!without.streams.some(s=>s.stream==='letterboxd'));
 assert.equal(withLb.streams.length,without.streams.length+1);
 assert.deepEqual(withLb.streams.filter(s=>s.stream!=='letterboxd').map(s=>s.stream+':'+s.state),without.streams.map(s=>s.stream+':'+s.state));
 assert.ok(withLb.issues.some(i=>i.key==='letterboxd_slot_late'));
}
// 6. The shared alert planner: confirmation, then send, then one recovery; the stream prefix reaches the recovery message.
{
 const late=[{key:'letterboxd_slot_late',severity:'degraded',stream:'letterboxd',message:'x'}];
 let plan=Policy.planAlerts(late,null,NOW);assert.equal(plan.sends.length,0,'one snapshot is not confirmed');
 plan=Policy.planAlerts(late,plan.state,NOW+60000);assert.equal(plan.sends[0].kind,'alert');
 const recovered=Policy.planAlerts([],plan.state,NOW+120000);assert.equal(recovered.sends[0].kind,'recovery');assert.equal(recovered.sends[0].stream,'letterboxd');
}
// 7. The monitor wiring supplies the model only for an active executor and never without a database.
{
 const text=fs.readFileSync('src/monitor.js','utf8');
 assert.match(text,/letterboxdFacts=\(env,now\)=>guarded/);
 assert.match(text,/model\.mode==='external'\?null:model/);
 assert.match(text,/!env\?\.DB\)return null/);
}
console.log('letterboxd-sync-monitor ok');
