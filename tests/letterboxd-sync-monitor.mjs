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
{const r=Policy.evaluateLetterboxd(model({health:'quarantined',quarantine:{reason:'epoch'}}),NOW);assert.equal(r.state,'degraded');assert.equal(r.issues[0].critical,true);assert.match(r.issues[0].message,/epoch/);}
// 2. Source staleness: 24 h since the last Watchlist success, and a Watchlist that never succeeded, are actionable on their own; a healthy slot does not hide them.
{
 let r=Policy.evaluateLetterboxd(model({sources:{watchlist:{stale:true,warning:'watchlist_stale'}}}),NOW);assert.deepEqual([r.state,keys(r)],['degraded',['letterboxd_watchlist_stale']]);assert.match(r.issues[0].message,/24 hours/);
 r=Policy.evaluateLetterboxd(model({sources:{watchlist:{stale:true,warning:'watchlist_never_succeeded'}}}),NOW);assert.match(r.issues[0].message,/since the executor started/);
 // Each source signals on its own (review): a failing Diary alerts while the Watchlist succeeded, and the reverse; neither rewrites the other's success.
 const src=(ratings,watchlist)=>model({sources:{ratings:{lastSuccessAt:'2026-11-21T09:00:00.000Z',lastOutcome:ratings},watchlist:{lastSuccessAt:'2026-11-21T09:00:00.000Z',lastOutcome:watchlist,stale:false,warning:null}}});
 r=Policy.evaluateLetterboxd(src('error','committed'),NOW);assert.deepEqual([r.state,keys(r)],['degraded',['letterboxd_ratings_failed']]);assert.match(r.issues[0].message,/Ratings \(error\)/);
 r=Policy.evaluateLetterboxd(src('finished','incomplete'),NOW);assert.deepEqual([r.state,keys(r)],['degraded',['letterboxd_watchlist_failed']]);assert.match(r.issues[0].message,/Watchlist \(incomplete\)/);
 r=Policy.evaluateLetterboxd(src('finished','unavailable'),NOW);assert.deepEqual(keys(r),['letterboxd_watchlist_failed']);
 r=Policy.evaluateLetterboxd(src('blocked','no_change'),NOW);assert.deepEqual(keys(r),['letterboxd_ratings_failed']);
 r=Policy.evaluateLetterboxd(src('finished','interrupted'),NOW);assert.deepEqual(keys(r),['letterboxd_watchlist_failed']);
 r=Policy.evaluateLetterboxd(src('error','error'),NOW);assert.deepEqual(keys(r),['letterboxd_ratings_failed','letterboxd_watchlist_failed'],'both sources failing are two signals');
 // success, no-op and a rate limit: no actionable signal; a rate limit is recorded as delayed and never alerts
 for(const [a,b] of [['finished','committed'],['noop','no_change'],['finished','no_change']]){r=Policy.evaluateLetterboxd(src(a,b),NOW);assert.deepEqual([r.state,keys(r)],['healthy',[]],a+'/'+b);}
 r=Policy.evaluateLetterboxd(src('rate_limited','committed'),NOW);assert.deepEqual([r.state,keys(r),r.issues[0].severity],['delayed',['letterboxd_ratings_rate_limited'],'delayed']);
 assert.equal(Policy.planAlerts(r.issues,null,NOW+1).sends.length,0,'a rate limit is never sent');
 // The partial failure is confirmed over snapshots and then sent through the shared planner; the successful source stays untouched.
 const bad=Policy.evaluateLetterboxd(src('error','committed'),NOW);
 let plan=Policy.planAlerts(bad.issues,null,NOW);plan=Policy.planAlerts(bad.issues,plan.state,NOW+60000);assert.equal(plan.sends[0].key,'letterboxd_ratings_failed');
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
 assert.match(text,/model\.mode==='external'\?null:\{\.\.\.model,identityCheck:await identityCheckFacts\(env,now\)\}/);
 assert.match(text,/!env\?\.DB\)return null/);
}
// 8. AIR-599 / ADR 0207 decision 4b (and review of PR #1009): one fact reader of the shared Letterboxd check, three conditions.
{
 const H=3600000,at=hours=>new Date(NOW-hours*H).toISOString();
 const check=extra=>model({identityCheck:{lastCheckAt:at(2),work:0,oldestWorkAt:null,atCap:0,backlog:0,backlogFull:false,ledgerUnreadable:false,overdue:0,overdueUnknown:0,...extra}});
 assert.deepEqual(keys(Policy.evaluateLetterboxd(check(),NOW)),[],'a recent check and nothing waiting is healthy');
 assert.deepEqual(keys(Policy.evaluateLetterboxd(check({lastCheckAt:at(25)}),NOW)),[],'an old check with nothing waiting is not stale');
 assert.deepEqual(keys(Policy.evaluateLetterboxd(check({lastCheckAt:at(25),work:2,oldestWorkAt:at(30)}),NOW)),['letterboxd_identity_check_stale']);
 // work that arrived after the last answer: the clock starts at its queue time, so fresh work does not alarm, and work that has NEVER been answered does after 24 h
 assert.deepEqual(keys(Policy.evaluateLetterboxd(check({lastCheckAt:at(100),work:1,oldestWorkAt:at(1)}),NOW)),[],'work queued an hour ago is not stale');
 assert.deepEqual(keys(Policy.evaluateLetterboxd(check({lastCheckAt:null,work:3,oldestWorkAt:at(26)}),NOW)),['letterboxd_identity_check_stale'],'a queue that only ever hit transport failures alerts after 24 h');
 assert.deepEqual(keys(Policy.evaluateLetterboxd(check({lastCheckAt:null,work:3,oldestWorkAt:at(20)}),NOW)),[]);
 assert.deepEqual(keys(Policy.evaluateLetterboxd(check({lastCheckAt:at(1),work:3,oldestWorkAt:at(90)}),NOW)),[],'progress was made an hour ago');
 assert.deepEqual(keys(Policy.evaluateLetterboxd(check({overdue:3}),NOW)),['letterboxd_admission_overdue']);
 const unknown=Policy.evaluateLetterboxd(check({overdueUnknown:2}),NOW);assert.deepEqual(keys(unknown),['letterboxd_admission_overdue']);assert.match(unknown.issues[0].message,/unknown age/);
 assert.deepEqual(keys(Policy.evaluateLetterboxd(check({backlog:4}),NOW)),['letterboxd_identity_cap_refused']);
 assert.deepEqual(keys(Policy.evaluateLetterboxd(check({backlog:2000,backlogFull:true}),NOW)),['letterboxd_identity_backlog_full']);
 assert.deepEqual(keys(Policy.evaluateLetterboxd(model({identityCheck:{error:'unreadable'}}),NOW)),['letterboxd_identity_check_unreadable']);
 const ledger=Policy.evaluateLetterboxd(check({ledgerUnreadable:true,overdue:null,overdueUnknown:null}),NOW);assert.deepEqual(keys(ledger),['letterboxd_identity_check_unreadable'],'an unreadable ledger is reported, never read as nothing waiting');assert.match(ledger.issues[0].message,/ledger/);
 assert.equal(Policy.evaluateLetterboxd(check({overdue:1}),NOW).state,'degraded');
}
console.log('letterboxd-sync-monitor ok');
