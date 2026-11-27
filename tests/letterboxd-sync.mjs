// AIR-570 / ADR 0186. The dormant Letterboxd Sync control plane, OFFLINE on the sqlite D1 stand-in: the four Madrid slots and DST, the owner's mode switch and its
// handover refusal, `ensure` (inert, duplicate ticks, missed slots), a whole instance through the phase ports, the slot-owned Event outbox (exactly two Events per slot),
// failure isolation between Diary and Watchlist, the epoch fence, stale instances and the read model. No network, no Cloudflare, nothing applied to production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as Slots from '../src/domain/letterboxd-slots.js';
import * as Sync from '../src/letterboxd-sync.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lbsync-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const at=ms=>new Date(ms).toISOString(),T=s=>Date.parse(s);
let dbCount=0;
// AIR-571 D2: the reverse close needs drain mode first. `sw` is switchMode, plus an automatic `drain` before a reverse close_admission (re-pinned to the row after the drain); `rawSwitch` is the plain command.
const rawSwitch=Sync.switchMode;
async function sw(e,body,ports,now){
 if(body.action==='close_admission'&&body.target==='external'&&!body.noDrain){
  const mode=await Sync.readMode(e);
  if(mode.mode==='cloudflare'&&mode.drain!=='scan_stopped'){
   const drained=await rawSwitch(e,{action:'drain'},{},now);
   if(!drained.draining)return {action:'close_admission',refused:'test_drain_failed',drained};
   if(body.expectRevision!==undefined)body={...body,expectRevision:(await Sync.readMode(e)).revision};
  }
 }
 const {noDrain,...rest}=body;
 return rawSwitch(e,rest,ports,now);
}
function fresh({schema=true,watchlist=true}={}){
 const file=path.join(root,'t'+(dbCount++)+'.db');
 const run=sql=>{const r=sqliteSync(['-bail',file],{input:sql});if(r.status!==0)throw new Error(r.stderr);};
 run("CREATE TABLE schema_contract(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, note TEXT); INSERT INTO schema_contract VALUES(1,32,'t');");
 if(schema)run(fs.readFileSync('migrations/0033_letterboxd_sync_control.sql','utf8'));
 // the Watchlist authority marker of schema 31 (columns the legacy gate reads); inert epg/open as in production
 if(watchlist)run("CREATE TABLE watchlist_authority (id INTEGER PRIMARY KEY, mode TEXT NOT NULL, writes TEXT NOT NULL, generation INTEGER NOT NULL); INSERT INTO watchlist_authority VALUES (1,'epg','open',0);");
 return {file,db:d1Standin(file),run};
}
function bucket(){
 const map=new Map();let fail=false;
 return {map,setFail(v){fail=v;},async put(key,body,opts){if(fail)throw new Error('r2 down');if(opts?.onlyIf?.etagDoesNotMatch==='*'&&map.has(key))return null;map.set(key,body);return {etag:'e'};}};
}
function workflow(){
 const instances=new Map();
 return {instances,created:[],async create({id,params}){if(instances.has(id)){const e=new Error('already exists');throw e;}instances.set(id,{status:'running',params});this.created.push(id);},async get(id){if(!instances.has(id)){throw new Error('not found');}return {status:async()=>({status:instances.get(id).status})};}};
}
const step=()=>({async do(name,fn){return fn();},async sleepUntil(){}});
const okPort=(outcome,extra={})=>({run:async()=>({done:true,outcome,...extra})});
const env=({db,bucket:b=bucket(),wf=workflow()})=>({DB:db,BUCKET:b,LETTERBOXD_WORKFLOW:wf});
// The ports of a proven handover: the proof, a guard that pins its facts at the commit (a passing one here), and drained causal effects.
const PASS=['INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, 1 WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok',[]];
const GOOD={handover:async()=>({ratingsClosed:true,ratingsDrained:true,legacyFenced:true,watchlistRepository:true,ratingsPhase:true}),handoverGuards:async()=>[['INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, 1 WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok',[]]],effects:async()=>({drained:true,pending:0,guard:PASS})};
async function activate(e,ports=GOOD,now=T('2026-11-21T09:39:00Z')){
 assert.equal((await sw(e,{action:'close_admission',target:'cloudflare'},ports,now)).closed,true);
 const done=await sw(e,{action:'complete'},ports,now);assert.equal(done.completed,true,JSON.stringify(done));return done;
}

// 1. Pure slots: four per day, DST, keys, ids, window.
{
 for(const day of ['2026-03-28','2026-03-29','2026-03-30','2026-10-24','2026-10-25','2026-10-26','2026-07-01']){
  const slots=Slots.slotsOfDay(day);assert.equal(slots.length,4);assert.equal(new Set(slots.map(s=>s.key)).size,4);
  for(let i=1;i<4;i++){assert.ok(slots[i].dueAt>slots[i-1].dueAt);}
  const hours=slots.map(s=>(s.dueAt-slots[0].dueAt)/3600000);assert.deepEqual(hours,[0,6,12,18]);
 }
 assert.equal(at(Slots.slotsOfDay('2026-03-29')[0].dueAt),'2026-03-29T02:30:00.000Z');
 assert.equal(at(Slots.slotsOfDay('2026-10-25')[0].dueAt),'2026-10-25T03:30:00.000Z');
 // DST spacing: 22:30 of the day before to 04:30 of the change day is 5 h (forward) or 7 h (back); none of the four is in the gap or fold.
 assert.equal((Slots.slotsOfDay('2026-03-29')[0].dueAt-Slots.slotsOfDay('2026-03-28')[3].dueAt)/3600000,5);
 assert.equal((Slots.slotsOfDay('2026-10-25')[0].dueAt-Slots.slotsOfDay('2026-10-24')[3].dueAt)/3600000,7);
 assert.equal(Slots.latestDueSlot(T('2026-11-21T09:29:59Z')).key,'2026-11-21T0430');
 assert.equal(Slots.latestDueSlot(T('2026-11-21T09:30:00Z')).key,'2026-11-21T1030');
 assert.equal(Slots.latestDueSlot(T('2026-11-21T02:00:00Z')).key,'2026-11-20T2230','before 04:30 the latest slot is last night');
 assert.equal(Slots.latestDueSlot(T('2026-11-21T09:30:00Z')).windowEndsAt,T('2026-11-21T15:30:00Z'));
 assert.equal(Slots.nextSlot('2026-11-21T2230').key,'2026-11-22T0430');
 assert.equal(Slots.previousSlot('2026-11-21T0430').key,'2026-11-20T2230');
 assert.equal(Slots.slotInstanceId('2026-11-21T1630',1),'lbsync_20261121_1630_1');
 assert.equal(Slots.slotEventKey('2026-11-21T1630','watchlist'),'lbsync-20261121T1630-watchlist');
 assert.throws(()=>Slots.slotEventKey('2026-11-21T1630','epg'));
 assert.throws(()=>Slots.slotKey('2026-11-21',9));
 // Every minute of a leap-DST day maps to exactly one latest slot and the windows tile without gap.
 let previous=null;for(let ms=T('2026-03-28T00:00:00Z');ms<T('2026-03-31T00:00:00Z');ms+=15*60000){const s=Slots.latestDueSlot(ms);assert.ok(s.dueAt<=ms&&ms<s.windowEndsAt);if(previous&&previous.key!==s.key)assert.equal(previous.windowEndsAt,s.dueAt);previous=s;}
 assert.doesNotMatch(fs.readFileSync('src/domain/letterboxd-slots.js','utf8'),/\b(fetch|BUCKET|Date\.now|new Date\(\)|Math\.random|crypto)\b/);
}

// 2. Inert default: schema absent, mode absent, mode external. ensure creates nothing and never throws.
{
 const bare=fresh({schema:false}),wf=workflow(),e=env({db:bare.db,wf});
 assert.equal((await Sync.readMode(e)).mode,'external');
 assert.deepEqual({...await Sync.ensure(e,{now:T('2026-11-21T10:40:00Z')})}.reason,'external');
 assert.equal(wf.created.length,0);
 assert.equal((await Sync.readModel(e,{now:T('2026-11-21T10:40:00Z')})).health,'external');
 const migrated=fresh(),e2=env({db:migrated.db,wf});
 assert.equal((await Sync.ensure(e2,{now:T('2026-11-21T10:40:00Z')})).reason,'external');
 assert.equal(wf.created.length,0);assert.equal(migrated.db.sql('SELECT COUNT(*) AS n FROM letterboxd_sync_mode')[0].n,0,'migration inserts no row');
 assert.equal((await Sync.writerFence(e2)).fenced,false);assert.equal((await Sync.writerFence(e)).fenced,false,'an absent schema is not a fence');
}

// 3. Mode switch: refused without a proven handover (O5, T30), allowed with it; fences the legacy writer; epoch bump; rollback.
{
 const {db}=fresh(),e=env({db});
 const refused=await sw(e,{action:'close_admission',target:'cloudflare'},{},T('2026-11-21T00:00:00Z'));assert.equal(refused.closed,true,JSON.stringify(refused));
 const blocked=await sw(e,{action:'complete'},{},T('2026-11-21T00:00:00Z'));
 assert.equal(blocked.refused,'handover_not_proven');assert.deepEqual(blocked.missing.sort(),['legacyFenced','ratingsClosed','ratingsDrained','ratingsPhase','watchlistRepository']);
 assert.equal((await Sync.writerFence(e)).fenced,true,'switching fences the legacy ratings entry');
 const partial=await sw(e,{action:'complete'},{handover:async()=>({ratingsClosed:true,ratingsDrained:true,legacyFenced:false,watchlistRepository:true,ratingsPhase:true})});
 assert.deepEqual(partial.missing,['legacyFenced'],'an external-mode-only Ratings is not a sufficient fence');
 assert.equal((await sw(e,{action:'complete'},{handover:async()=>{throw new Error('x');}})).refused,'handover_not_proven');
 const done=await sw(e,{action:'complete'},GOOD);assert.equal(done.completed,true);assert.equal(done.epoch,1);
 assert.equal((await Sync.writerFence(e)).reason,'letterboxd_sync_active');
 assert.equal((await sw(e,{action:'close_admission',target:'cloudflare'})).refused,'already_in_mode');
 // Rollback: close to external; the epoch moves so a stale instance is refused.
 assert.equal((await sw(e,{action:'close_admission',target:'external'},GOOD)).epoch,2);
 assert.equal((await sw(e,{action:'complete'},GOOD)).completed,true,'closing to external needs no handover');
 assert.equal((await Sync.writerFence(e)).fenced,false);
 assert.equal(Sync.validate({action:'close_admission'}),'Missing target');assert.equal(Sync.validate({action:'x'}),'Unknown action');assert.equal(Sync.validate({action:'complete',extra:1}),'Unknown field');
 assert.deepEqual((await Sync.handle(e,{action:'complete'})).body,{error:'Missing confirm'},'the owner route needs the confirmation and the pins');
 assert.equal((await Sync.handle(e,{action:'complete',confirm:'complete',expectEpoch:2,expectRevision:0})).body.refused,'pin_mismatch');
}

// 4. ensure: claims the latest due slot once; duplicate tick, same slot replay, next slot after a failed prior.
{
 const {db}=fresh(),wf=workflow(),e=env({db,wf});await activate(e);
 const tick=T('2026-11-21T09:40:00Z');
 const a=await Sync.ensure(e,{now:tick});assert.equal(a.started,true);assert.equal(a.slot,'2026-11-21T1030');assert.equal(a.instanceId,'lbsync_20261121_1030_0');
 const b=await Sync.ensure(e,{now:tick+60000});assert.equal(b.started,false);assert.equal(b.reason,'in_progress');
 assert.equal(wf.created.length,1,'duplicate cron: one instance');
 const slot=await Sync.readSlot(e,'2026-11-21T1030');assert.equal(slot.status,'claimed');assert.equal(slot.epoch,1);
 // The instance ends unfinished inside the window: a counted failure and a successor series (never past the window).
 wf.instances.get('lbsync_20261121_1030_0').status='errored';
 const c=await Sync.ensure(e,{now:tick+3600000});assert.equal(c.started,true);assert.equal(c.series,1);assert.equal(c.instanceId,'lbsync_20261121_1030_1');
 // Past the window end the slot closes as interrupted and both Events are owed; no late retry crosses the next slot.
 wf.instances.get('lbsync_20261121_1030_1').status='errored';
 const late=T('2026-11-21T15:28:00Z');
 const d=await Sync.ensure(e,{now:late});assert.equal(d.started,false);assert.equal(d.reason,'closed_interrupted');
 const closed=await Sync.readSlot(e,'2026-11-21T1030');assert.equal(closed.status,'interrupted');
 assert.equal(db.sql("SELECT COUNT(*) AS n FROM letterboxd_slot_event WHERE slot_key='2026-11-21T1030'")[0].n,2);
 // The next slot is claimed independently after the failed prior.
 const next=await Sync.ensure(e,{now:T('2026-11-21T15:40:00Z')});assert.equal(next.started,true);assert.equal(next.slot,'2026-11-21T1630');
}

// 5. A whole run: both Events from the slot outbox, independent outcomes, no third Event, create-only keys.
async function wholeRun({ratings,watchlist,reconcile=okPort('done'),now=T('2026-11-21T09:40:00Z'),b=bucket()}){
 const f=fresh(),wf=workflow(),e=env({db:f.db,wf,bucket:b});await activate(e);
 const started=await Sync.ensure(e,{now});
 const result=await Sync.run(e,{slotKey:started.slot,series:0,epoch:1},step(),{now:()=>now+60000,ports:{ratings,watchlist,reconcile}});
 return {e,f,result,b,started};
}
{
 const {result,b,f}=await wholeRun({ratings:okPort('finished',{at:'2026-11-21T09:45:00.000Z',counts:{pages:1}}),watchlist:okPort('committed',{at:'2026-11-21T09:50:00.000Z',snapshotVersion:42,lastSuccessAt:'2026-11-21T09:50:00.000Z',total:395,added:[{lid:'a'}],removed:[],addedCount:1,removedCount:0})});
 assert.equal(result.reason,'complete');assert.equal(result.status,'finished');
 const keys=[...b.map.keys()];assert.equal(keys.length,2,'exactly two Events');
 const events=keys.map(k=>JSON.parse(b.map.get(k)));
 assert.deepEqual(events.map(x=>x.id).sort(),['lbsync-20261121T1030-ratings','lbsync-20261121T1030-watchlist']);
 const wl=events.find(x=>x.type==='watchlist'),rt=events.find(x=>x.type==='ratings');
 assert.equal(wl.status,'success');assert.equal(wl.snapshotVersion,42);assert.equal(wl.addedCount,1);assert.equal(wl.slot,'2026-11-21T1030');assert.equal(wl.at,'2026-11-21T09:50:00.000Z','frozen at = the real end of the phase');
 assert.equal(rt.status,'success');assert.equal(rt.at,'2026-11-21T09:45:00.000Z');
 assert.ok(keys.every(k=>/^events\/items\/\d{13}-lbsync-/.test(k)));
 assert.equal(f.db.sql("SELECT COUNT(*) AS n FROM letterboxd_slot_event WHERE status='delivered'")[0].n,2);
 // A replay of the same slot (or the same instance) writes no third Event and no duplicate: closed slot is final.
 const again=await Sync.run(env({db:f.db,bucket:b}),{slotKey:'2026-11-21T1030',series:0,epoch:1},step(),{now:()=>T('2026-11-21T10:00:00Z'),ports:{}});
 assert.equal(again.reason,'complete');assert.equal(b.map.size,2);
 assert.equal((await Sync.ensure(env({db:f.db,bucket:b}),{now:T('2026-11-21T10:10:00Z')})).reason,'complete');
}
// 5b. T7: Diary down, Watchlist up. T8: Watchlist incomplete, Ratings stands. Each source keeps its own outcome and Event.
{
 const a=await wholeRun({ratings:okPort('error',{reason:'network'}),watchlist:okPort('committed',{snapshotVersion:7,total:10})});
 const ev=[...a.b.map.values()].map(JSON.parse);
 assert.equal(ev.find(x=>x.type==='ratings').status,'error');assert.equal(ev.find(x=>x.type==='watchlist').status,'success');
 assert.equal((await Sync.readSlot(a.e,a.started.slot)).watchlist.outcome,'committed');
 const b=await wholeRun({ratings:okPort('finished'),watchlist:okPort('incomplete',{reason:'page_missing'})});
 const evb=[...b.b.map.values()].map(JSON.parse);
 assert.equal(evb.find(x=>x.type==='ratings').status,'success');assert.equal(evb.find(x=>x.type==='watchlist').outcome,'incomplete');assert.equal(evb.find(x=>x.type==='watchlist').addedCount,0);assert.equal(evb.find(x=>x.type==='watchlist').removedCount,0);
 // A port that throws is an error of its own source only.
 const c=await wholeRun({ratings:{run:async()=>{throw new Error('boom');}},watchlist:okPort('no_change')});
 const evc=[...c.b.map.values()].map(JSON.parse);assert.equal(evc.find(x=>x.type==='ratings').outcome,'error');assert.equal(evc.find(x=>x.type==='watchlist').status,'noop');
 // Both rate limited: both Events say so, one watchlist attempt (T9). No-op emits both Events (T10).
 let calls=0;const d=await wholeRun({ratings:okPort('rate_limited'),watchlist:{run:async()=>{calls++;return {done:true,outcome:'rate_limited'};}}});
 assert.equal(calls,1);assert.deepEqual([...d.b.map.values()].map(x=>JSON.parse(x).status),['warning','warning']);
 const n=await wholeRun({ratings:okPort('noop'),watchlist:okPort('no_change')});assert.equal(n.b.map.size,2);
 // A disabled/absent Watchlist port fails closed and still yields both Events honestly (not a success).
 const z=await wholeRun({ratings:okPort('finished'),watchlist:undefined});
 const evz=[...z.b.map.values()].map(JSON.parse);assert.equal(evz.find(x=>x.type==='watchlist').outcome,'disabled');assert.equal(evz.find(x=>x.type==='watchlist').status,'warning');
 // Reconciliation deferred/error never changes either Event and never makes a third one.
 const r=await wholeRun({ratings:okPort('finished'),watchlist:okPort('committed'),reconcile:okPort('deferred')});assert.equal(r.b.map.size,2);assert.equal((await Sync.readSlot(r.e,r.started.slot)).reconciliation,'deferred');
}
// 5c. Phases run in order and reconciliation follows the scan of the same run.
{
 const order=[];const mk=name=>({run:async()=>{order.push(name);return {done:true,outcome:name==='reconcile'?'done':name==='ratings'?'finished':'no_change'};}});
 await wholeRun({ratings:mk('ratings'),watchlist:mk('watchlist'),reconcile:mk('reconcile')});assert.deepEqual(order,['ratings','watchlist','reconcile']);
}
// 5c2. Review: the effects of the snapshot a run just promoted are applied BETWEEN the scan and the reconciliation, only after a commit, and a failing hook never fails the slot.
{
 const order=[];
 const mk=name=>({run:async()=>{order.push(name);return {done:true,outcome:name==='reconcile'?'done':name==='ratings'?'finished':'committed'};}});
 const watchlist={...mk('watchlist'),afterRecorded:async()=>{order.push('effects');return {drained:true};}};
 await wholeRun({ratings:mk('ratings'),watchlist,reconcile:mk('reconcile')});
 assert.deepEqual(order,['ratings','watchlist','effects','reconcile'],'effects run after the scan is recorded and before phase 3');
 const none=[];const noCommit={run:async()=>{none.push('w');return {done:true,outcome:'no_change'};},afterRecorded:async()=>{none.push('effects');}};
 await wholeRun({ratings:okPort('finished'),watchlist:noCommit});assert.deepEqual(none,['w'],'no commit, no effects step');
 const failing={...mk('watchlist'),afterRecorded:async()=>{throw new Error('boom');}};
 const r=await wholeRun({ratings:okPort('finished'),watchlist:failing,reconcile:okPort('done')});assert.equal(r.result.reason,'complete','a failing effects hook never fails the slot');
 assert.equal(r.b.map.size,2);
}
// 5d. Multi-action phase with a wake, and the deadline: no retry crosses the next slot's due instant.
{
 const f=fresh(),wf=workflow(),e=env({db:f.db,wf});await activate(e);
 const now=T('2026-11-21T15:20:00Z'),started=await Sync.ensure(e,{now});
 let clock=now+60000;
 const slow={run:async()=>{clock+=20*60000;return {done:false,wakeAt:clock};}};
 const result=await Sync.run(e,{slotKey:started.slot,series:0,epoch:1},{async do(n,fn){return fn();},async sleepUntil(){}},{now:()=>clock,ports:{ratings:slow,watchlist:okPort('committed'),reconcile:okPort('done')}});
 const slot=await Sync.readSlot(e,started.slot);assert.equal(slot.ratings.outcome,'interrupted');assert.equal(slot.status,'interrupted');
}
// 6. Outbox durability: a delivery outage leaves two pending rows; the next tick delivers; a found key is marked delivered; no scan is gated.
{
 const b=bucket();b.setFail(true);
 const {e,f,started}=await wholeRun({ratings:okPort('finished'),watchlist:okPort('no_change'),b});
 assert.equal(b.map.size,0);assert.deepEqual(f.db.sql("SELECT type,status,attempts FROM letterboxd_slot_event ORDER BY type").map(x=>x.status),['pending','pending']);
 assert.equal((await Sync.readSlot(e,started.slot)).status,'finished','a delivery outage never reopens or fails a slot');
 // The next slot is claimed and run while the previous Events are still pending.
 b.setFail(false);
 const later=await Sync.ensure(e,{now:T('2026-11-21T16:40:00Z')});
 assert.equal(later.started,true,'a pending Event never blocks the next slot');
 assert.equal(b.map.size,2,'the same tick delivered the backlog (the backoff had elapsed)');
 
 // Crash between the two puts: one key already exists; delivery marks it delivered with no second write.
 const b2=bucket(),g=fresh(),e2=env({db:g.db,bucket:b2});await activate(e2);
 const st=await Sync.ensure(e2,{now:T('2026-11-21T09:40:00Z')});
 b2.setFail(true);await Sync.run(e2,{slotKey:st.slot,series:0,epoch:1},step(),{now:()=>T('2026-11-21T09:41:00Z'),ports:{ratings:okPort('finished'),watchlist:okPort('no_change'),reconcile:okPort('done')}});
 b2.setFail(false);b2.map.set(Sync.eventObjectKey(g.db.sql("SELECT at FROM letterboxd_slot_event WHERE type='ratings'")[0].at,'lbsync-20261121T1030-ratings'),'{"pre":1}');
 const rec=await Sync.deliverEvents(e2,{now:T('2026-11-21T20:00:00Z')});assert.equal(rec.delivered,2);assert.equal(b2.map.size,2);
 assert.deepEqual(g.db.sql("SELECT status FROM letterboxd_slot_event").map(x=>x.status),['delivered','delivered']);
 assert.equal([...b2.map.values()].filter(v=>v==='{"pre":1}').length,1,'the existing object was kept, never rewritten');
}
// 7. Missed slots: recorded once with no Workflow instance and two Events; never run late; before activation nothing is recorded.
{
 const f=fresh(),wf=workflow(),b=bucket(),e=env({db:f.db,wf,bucket:b});await activate(e,GOOD,T('2026-11-21T00:00:00Z'));
 // No tick for 04:30 and 10:30; the first tick comes at 17:05, in the 16:30 window.
 const r=await Sync.ensure(e,{now:T('2026-11-21T16:05:00Z')});
 assert.equal(r.slot,'2026-11-21T1630');assert.equal(r.missed,2,'04:30 and 10:30 recorded as missed (22:30 of the day before predates activation)');
 for(const key of ['2026-11-21T0430','2026-11-21T1030']){const s=await Sync.readSlot(e,key);assert.equal(s.status,'skipped_missed');assert.equal(s.instanceId,Slots.slotInstanceId(key,0));assert.ok(!wf.instances.has(s.instanceId),'no instance for a missed slot');}
 assert.equal(f.db.sql("SELECT COUNT(*) AS n FROM letterboxd_slot_event WHERE slot_key IN ('2026-11-21T0430','2026-11-21T1030')")[0].n,4);
 await Sync.deliverEvents(e,{now:T('2026-11-21T16:06:00Z'),limit:10});assert.equal(b.map.size,4);
 assert.deepEqual([...b.map.values()].map(v=>JSON.parse(v).outcome),['skipped_missed','skipped_missed','skipped_missed','skipped_missed']);
 assert.equal((await Sync.ensure(e,{now:T('2026-11-21T16:20:00Z')})).missed,0,'recorded once');
}
// 8. Epoch fence and stale instances: a slot of another epoch, a closed mode and a quarantined domain are refused; nothing is written.
{
 const f=fresh(),wf=workflow(),b=bucket(),e=env({db:f.db,wf,bucket:b});await activate(e);
 const st=await Sync.ensure(e,{now:T('2026-11-21T09:40:00Z')});
 await sw(e,{action:'close_admission',target:'external'},typeof GOOD==='undefined'?{}:GOOD);
 const stale=await Sync.run(e,{slotKey:st.slot,series:0,epoch:1},step(),{now:()=>T('2026-11-21T09:41:00Z'),ports:{ratings:okPort('finished'),watchlist:okPort('committed')}});
 assert.equal(stale.stopped,true);assert.equal(stale.reason,'switch_in_progress');assert.equal(b.map.size,0);assert.equal((await Sync.readSlot(e,st.slot)).status,'claimed');
 assert.equal((await sw(e,{action:'complete'},GOOD)).drain,'instance_live','the drain is verified, not assumed');
 wf.instances.get('lbsync_20261121_1030_0').status='terminated';
 assert.equal((await sw(e,{action:'complete'},GOOD)).completed,true);
 const stale2=await Sync.run(e,{slotKey:st.slot,series:0,epoch:1},step(),{now:()=>T('2026-11-21T09:42:00Z'),ports:{}});assert.equal(stale2.reason,'not_cloudflare');
 // Re-activated at epoch 3: the old instance (epoch 1) is refused; a wrong series is refused; an invalid payload is refused.
 await activate(e,GOOD,T('2026-11-21T09:43:00Z'));
 assert.equal((await Sync.run(e,{slotKey:st.slot,series:0,epoch:1},step(),{now:()=>T('2026-11-21T09:44:00Z'),ports:{}})).reason,'epoch_mismatch');
 assert.equal((await Sync.run(e,{slotKey:st.slot,series:5,epoch:3},step(),{now:()=>T('2026-11-21T09:44:00Z'),ports:{}})).reason,'not_owner');
 assert.equal((await Sync.run(e,{slotKey:'nope'},step(),{})).reason,'invalid_payload');
 // The DB-level fence: a committing batch from a stale epoch aborts whole.
 await assert.rejects(()=>f.db.batch([f.db.prepare("INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM letterboxd_sync_mode WHERE id = 1 AND mode = 'cloudflare' AND epoch = ?) THEN 1 ELSE 0 END WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok").bind(1),f.db.prepare("UPDATE letterboxd_slot SET phase='ratings' WHERE slot_key=?").bind(st.slot)]));
 assert.equal(f.db.sql("SELECT phase FROM letterboxd_slot WHERE slot_key='2026-11-21T1030'")[0].phase,'starting','the aborted batch left the slot alone');
 // A closed slot is immutable at the database level.
 f.run("UPDATE letterboxd_slot SET status='error',phase='done',closed_at='x',write_id='w' WHERE slot_key='2026-11-21T1030'");
 assert.throws(()=>f.run("UPDATE letterboxd_slot SET phase='ratings' WHERE slot_key='2026-11-21T1030'"),/letterboxd_slot_closed/);
 // Quarantine blocks ensure; only the owner action clears it.
 f.run("UPDATE letterboxd_sync_mode SET quarantine_reason='x', quarantined_at='t'");
 assert.equal((await Sync.ensure(e,{now:T('2026-11-21T09:50:00Z')})).reason,'quarantined');
 assert.equal((await Sync.clearQuarantine(e)).cleared,true);
}
// 9. Two concurrent claims of one slot yield one claim and one create.
{
 const f=fresh(),wf=workflow(),e=env({db:f.db,wf});await activate(e);
 const results=await Promise.all([Sync.ensure(e,{now:T('2026-11-21T09:40:00Z')}),Sync.ensure(e,{now:T('2026-11-21T09:40:00Z')})]);
 assert.equal(wf.created.length,1);assert.equal(results.filter(r=>r.started&&!r.attached).length,1);
}
// 10. Read model: health, per-source lastSuccessAt, watchlist 24 h stale warning, no writes.
{
 const f=fresh(),wf=workflow(),b=bucket(),e=env({db:f.db,wf,bucket:b});await activate(e);
 let m=await Sync.readModel(e,{now:T('2026-11-21T09:45:00Z')});assert.equal(m.health,'waiting');assert.equal(m.sideEffects,'none');
 m=await Sync.readModel(e,{now:T('2026-11-21T10:00:00Z')});assert.equal(m.health,'late','due, never claimed, past the start grace');
 const st=await Sync.ensure(e,{now:T('2026-11-21T09:40:00Z')});
 await Sync.run(e,{slotKey:st.slot,series:0,epoch:1},step(),{now:()=>T('2026-11-21T09:41:00Z'),ports:{ratings:okPort('finished',{at:'2026-11-21T09:42:00.000Z'}),watchlist:okPort('committed',{at:'2026-11-21T09:43:00.000Z'}),reconcile:okPort('done')}});
 m=await Sync.readModel(e,{now:T('2026-11-21T09:50:00Z')});
 assert.equal(m.health,'healthy');assert.equal(m.sources.ratings.lastSuccessAt,'2026-11-21T09:42:00.000Z');assert.equal(m.sources.watchlist.lastSuccessAt,'2026-11-21T09:43:00.000Z');assert.equal(m.sources.watchlist.stale,false);assert.equal(m.eventsPending,0);
 m=await Sync.readModel(e,{now:T('2026-11-22T09:44:00Z')});assert.equal(m.sources.watchlist.stale,true);assert.equal(m.sources.watchlist.warning,'watchlist_stale');
 // Independent lastSuccessAt: a later failed Diary does not move the ratings success, a failed Watchlist does not move the watchlist one.
 const st2=await Sync.ensure(e,{now:T('2026-11-21T15:40:00Z')});
 await Sync.run(e,{slotKey:st2.slot,series:0,epoch:1},step(),{now:()=>T('2026-11-21T15:41:00Z'),ports:{ratings:okPort('error'),watchlist:okPort('unavailable'),reconcile:okPort('skipped')}});
 m=await Sync.readModel(e,{now:T('2026-11-21T15:50:00Z')});assert.equal(m.sources.ratings.lastSuccessAt,'2026-11-21T09:42:00.000Z');assert.equal(m.sources.watchlist.lastSuccessAt,'2026-11-21T09:43:00.000Z');assert.equal(m.health,'failed');
 const before=f.db.sql("SELECT (SELECT COUNT(*) FROM letterboxd_slot) a,(SELECT SUM(revision) FROM letterboxd_slot) r")[0];await Sync.readModel(e,{now:T('2026-11-21T15:51:00Z')});assert.deepEqual(f.db.sql("SELECT (SELECT COUNT(*) FROM letterboxd_slot) a,(SELECT SUM(revision) FROM letterboxd_slot) r")[0],before,'a read writes nothing');
}
// 10b. Review fixes: an earlier slot left unclosed after ITS window is `stalled` even though a newer slot is waiting; a source that never succeeded warns once the executor has been active 24 h.
{
 const f=fresh(),wf=workflow(),e=env({db:f.db,wf});await activate(e);
 const st=await Sync.ensure(e,{now:T('2026-11-21T09:40:00Z')});assert.equal(st.slot,'2026-11-21T1030');
 // The 10:30 slot stays claimed and unclosed. Later, 16:35 is inside the 16:30 slot's window and 10:30's window ended at 16:30.
 const later=T('2026-11-21T16:35:00Z');
 const m=await Sync.readModel(e,{now:later});
 assert.deepEqual(m.overdueSlots,['2026-11-21T1030']);assert.equal(m.health,'stalled','an overdue earlier slot is not hidden behind the newer one');
 assert.equal(m.slot.key,'2026-11-21T1630');
 // Never succeeded: active for over 24 h with no successful Watchlist run.
 const day2=await Sync.readModel(e,{now:T('2026-11-22T10:00:00Z')});
 assert.equal(day2.sources.watchlist.stale,true);assert.equal(day2.sources.watchlist.warning,'watchlist_never_succeeded');
 const fresh1=await Sync.readModel(e,{now:T('2026-11-21T12:00:00Z')});assert.equal(fresh1.sources.watchlist.warning,null,'not yet 24 h');
}
// 11. The module reads no EPG, Discovery or resolver state and names no cron.
{
 const text=fs.readFileSync('src/letterboxd-sync.js','utf8');
 assert.doesNotMatch(text,/discovery_lease|epg_checkpoint|epg_priority|resolver_lease|published_epg_|DiscoveryContinuation|EpgOrchestration/i);
 // AIR-571 E: the activation deployment registers the Workflow and the :30 cron (declared after the three existing triggers); they stay inert until the owner's `complete` sets the mode to cloudflare with the canary hold.
 const wranglerText=fs.readFileSync('wrangler.jsonc','utf8');
 assert.match(wranglerText,/"name": "iptv-letterboxd",\s*"binding": "LETTERBOXD_WORKFLOW",\s*"class_name": "LetterboxdWorkflow"/,'the Letterboxd Workflow is registered');
 assert.match(wranglerText,/"crons": \["0 \* \* \* \*", "1-59\/2 \* \* \* \*", "24 3 \* \* \*", "30 \* \* \* \*"\]/,'the :30 cron is the fourth trigger and the first three are unchanged');
}
// 12. T17 / T30: the legacy Ratings writer is FENCED (not merely `external`) while the Letterboxd Sync owns or takes over the Diary; both Workflows can never write.
// Loaded the way the Worker bundle loads them: one scope, the real ratings-orchestration source, the real Sync, a D1 stand-in.
{
 const {scoped,scopedImports}=await import('../scripts/bundle-scope.mjs');
 const vm=await import('node:vm');
 const stub="const LetterboxdRatings={readDocument:async(env,key)=>/executor/.test(key)&&globalThis.__ratingsCloudflare?{object:{etag:'m'},value:{schemaVersion:1,mode:'cloudflare',epoch:1,drain:null}}:{object:null,value:null},writeDocument:async()=>({etag:'x'}),KEYS:{run:'r'},readRun:async()=>null,start:async()=>({created:false}),step:async()=>({}),reconcileEvent:async()=>null};\n";
 const code=scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+stub+scopedImports('src/domain/letterboxd-slots.js','LetterboxdSlots','const {madridDayKey,madridInstant}=OrchestrationPolicy;')+'\n'+scopedImports('src/letterboxd-sync.js','LetterboxdSync','const {applyFailure,cooldownMs}=OrchestrationPolicy;\nconst {latestDueSlot,nextSlot,previousSlot,slotInstanceId,slotEventKey,parseSlotKey}=LetterboxdSlots;')+'\n'+fs.readFileSync('src/ratings-orchestration.js','utf8')+'\n;({RatingsOrchestration,LetterboxdSync})';
 const ctx={console,crypto,Date,Promise,Math,Object,Array,JSON,Number,String,Error,RegExp,Intl,Map,Set};
 const mods=vm.runInNewContext(code,ctx);
 const {RatingsOrchestration,LetterboxdSync}=mods;
 const f=fresh(),wf=workflow(),e={DB:f.db,BUCKET:bucket(),LETTERBOXD_WORKFLOW:wf};
 // Inert: with no Letterboxd mode row the legacy gate is exactly today's.
 assert.equal((await RatingsOrchestration.externalGate(e,'start')).reason,null);
 assert.equal((await RatingsOrchestration.externalGate(e,'step')).reason,null);
 // Taking over: the switch is open, so both legacy entries are refused.
 await sw(e,{action:'close_admission',target:'cloudflare'},{},T('2026-11-21T09:39:00Z'));
 assert.equal((await RatingsOrchestration.externalGate(e,'start')).reason,'external_writer_fenced');
 assert.equal((await RatingsOrchestration.externalGate(e,'step')).reason,'external_writer_fenced');
 assert.equal((await RatingsOrchestration.externalGate(e,'status')).reason,null,'reads stay open');
 await sw(e,{action:'complete'},typeof GOOD==='undefined'?{}:GOOD);
 assert.equal((await RatingsOrchestration.externalGate(e,'step')).reason,'external_writer_fenced');
 // The legacy gate stays fenced while the Letterboxd mode is cloudflare, even if the ratings mode document says cloudflare (never two Diary writers). The Ratings Workflow, its `admit` and the cron `ensure` are retired.
 ctx.__ratingsCloudflare=true;
 assert.equal((await RatingsOrchestration.externalGate(e,'start')).reason,'external_writer_fenced','fenced whatever the ratings mode document says');
 assert.equal(typeof RatingsOrchestration.admit,'undefined','the Workflow admission is gone');
 ctx.__ratingsCloudflare=false;
 // Rollback: back to external re-opens exactly the legacy writer.
 await sw(e,{action:'close_admission',target:'external'},typeof GOOD==='undefined'?{}:GOOD);
 await sw(e,{action:'complete'},GOOD);
 assert.equal((await RatingsOrchestration.externalGate(e,'start')).reason,null,'rollback restores the single legacy writer');
}
// 10. AIR-571 D: the owner's handover control: pins, a protected proof, drained effects before a running writer is closed, abort, one writer.
{
 const read=async e=>Sync.readMode(e);
 const NOW=T('2026-11-21T00:00:00Z');
 // pins: the command names the epoch and the revision of the row the owner read (revision 0 = no row yet)
 {
  const {db}=fresh(),e=env({db});
  const status0=await Sync.modeStatus(e,GOOD);assert.equal(status0.readable,true);assert.deepEqual([status0.mode.mode,status0.mode.epoch,status0.mode.revision],['external',0,0]);assert.equal(status0.sideEffects,'none');
  assert.equal(status0.letterboxdWriters,0);assert.equal(status0.legacyFenced,false);assert.equal(status0.effects.drained,true);
  assert.equal((await sw(e,{action:'close_admission',target:'cloudflare',expectEpoch:3,expectRevision:0},GOOD,NOW)).refused,'pin_mismatch','a stale epoch is refused');
  const stale=await sw(e,{action:'close_admission',target:'cloudflare',expectEpoch:0,expectRevision:7},GOOD,NOW);assert.deepEqual([stale.refused,stale.pin],['pin_mismatch','revision']);
  assert.equal((await read(e)).stored,false,'a refused command wrote nothing');
  const closed=await sw(e,{action:'close_admission',target:'cloudflare',expectEpoch:0,expectRevision:0},GOOD,NOW);assert.equal(closed.closed,true);
  // a competing owner: the second command holds the pins of the row the first one changed, and is refused, never retried blindly
  const second=await sw(e,{action:'close_admission',target:'cloudflare',expectEpoch:0,expectRevision:0},GOOD,NOW);assert.equal(second.refused,'pin_mismatch');
  assert.equal((await read(e)).epoch,1,'one switch, one epoch bump');
  const after=await read(e);
  // the protected proof: no guards port, an empty list, a throwing port and a tripped guard each leave the handover unfinished and the row untouched
  const proven=GOOD.handover;
  const pins={expectEpoch:after.epoch,expectRevision:after.revision};
  assert.equal((await sw(e,{action:'complete',...pins},{handover:proven},NOW)).refused,'handover_unprotected','a proof that cannot be pinned does not complete a handover');
  assert.equal((await sw(e,{action:'complete',...pins},{handover:proven,handoverGuards:async()=>[]},NOW)).refused,'handover_unprotected');
  assert.equal((await sw(e,{action:'complete',...pins},{handover:proven,handoverGuards:async()=>{throw new Error('x');}},NOW)).refused,'handover_unprotected');
  const tripped=await sw(e,{action:'complete',...pins},{handover:proven,handoverGuards:async()=>[['INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, 0 WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok',[]]]},NOW);
  assert.equal(tripped.refused,'handover_changed','a fact of the proof that changed at the commit aborts the completion');
  assert.equal((await read(e)).mode,'switching','nothing was written');
  // a stale pin on the completion
  assert.equal((await sw(e,{action:'complete',expectEpoch:0,expectRevision:after.revision},GOOD,NOW)).refused,'pin_mismatch');
  const done=await sw(e,{action:'complete',...pins},GOOD,NOW);assert.equal(done.completed,true);
  // exactly one writer: the Letterboxd side is admitted, the legacy entry is fenced
  const running=await Sync.modeStatus(e,GOOD);assert.equal(running.letterboxdWriters,1);assert.equal(running.legacyFenced,true);assert.equal(running.handover.ratingsClosed,true);
 }
 // reverse: no running writer is closed over undrained causal effects; unreadable and unproven effects refuse too
 {
  const {db}=fresh(),e=env({db});
  await sw(e,{action:'close_admission',target:'cloudflare'},GOOD,NOW);await sw(e,{action:'complete'},GOOD,NOW);
  assert.equal((await rawSwitch(e,{action:'drain'},{},NOW)).draining,true);
  const row=await read(e);const pins={expectEpoch:row.epoch,expectRevision:row.revision};
  const pending=await sw(e,{action:'close_admission',target:'external',...pins},{effects:async()=>({drained:false,pending:2,version:5,drainedVersion:4})},NOW);
  assert.deepEqual([pending.refused,pending.pending,pending.version,pending.drainedVersion],['effects_pending',2,5,4]);
  assert.equal((await sw(e,{action:'close_admission',target:'external',...pins},{effects:async()=>{throw new Error('d1');}},NOW)).refused,'effects_unreadable');
  assert.equal((await sw(e,{action:'close_admission',target:'external',...pins},{},NOW)).refused,'effects_unproven','without a port the effects are not provable');
  assert.equal((await Sync.modeStatus(e,{...GOOD,effects:async()=>({drained:false,pending:1,version:2,drainedVersion:1})})).effects.drained,false);
  assert.deepEqual([(await read(e)).mode,(await read(e)).epoch],['cloudflare',1],'a refused close changed nothing and the writer stays admitted');
  const closed=await sw(e,{action:'close_admission',target:'external',...pins},GOOD,NOW);assert.equal(closed.closed,true);assert.equal(closed.epoch,2);
  assert.equal((await Sync.writerFence(e)).fenced,true,'while switching neither writer is admitted');
 }
 // an unreadable drain of the executor's instances refuses the completion and is recorded, never assumed
 {
  const f=fresh(),wf=workflow(),e=env({db:f.db,wf});
  await sw(e,{action:'close_admission',target:'cloudflare'},GOOD,NOW);await sw(e,{action:'complete'},GOOD,NOW);
  const started=await Sync.ensure(e,{now:T('2026-11-21T09:40:00Z')});assert.ok(started.slot,'a slot instance exists');
  await sw(e,{action:'close_admission',target:'external'},GOOD,NOW);
  const switching=await read(e);
  wf.get=async()=>{throw new Error('boom');};
  const unreadable=await sw(e,{action:'complete',expectEpoch:switching.epoch,expectRevision:switching.revision},GOOD,NOW);
  assert.deepEqual([unreadable.refused,unreadable.drain],['drain_not_verified','unreadable']);assert.equal((await read(e)).mode,'switching');assert.equal((await read(e)).revision,switching.revision,'a drain refusal writes nothing');
 }
 // review fixes (PR #879): the effects proof is asserted AT the commit, outcomes are exact, the legacy entry reopens only after a safe Watchlist
 {
  const {db}=fresh(),e=env({db});
  await sw(e,{action:'close_admission',target:'cloudflare'},GOOD,NOW);await sw(e,{action:'complete'},GOOD,NOW);
  assert.equal((await rawSwitch(e,{action:'drain'},{},NOW)).draining,true);
  const running=await read(e);const pins={expectEpoch:running.epoch,expectRevision:running.revision};
  // a promotion that lands between the effects read and the commit trips the guard carried by the effects port: nothing is written and the answer is not a stale pin
  const trip=['INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, 0 WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok',[]];
  const raced=await sw(e,{action:'close_admission',target:'external',...pins},{...GOOD,effects:async()=>({drained:true,pending:0,guard:trip})},NOW);
  assert.equal(raced.refused,'effects_changed');assert.deepEqual([(await read(e)).mode,(await read(e)).revision],['cloudflare',running.revision],'a raced close wrote nothing');
  // a port that cannot pin its proof leaves the close refused
  assert.equal((await sw(e,{action:'close_admission',target:'external',...pins},{...GOOD,effects:async()=>({drained:true,pending:0})},NOW)).refused,'effects_unprotected');
  // a lost reply is never a stale pin and never retried: the outcome is unknown
  const lost={...e,DB:{prepare:db.prepare.bind(db),batch:async statements=>{await db.batch(statements);throw new Error('network lost after commit');}}};
  const uncertain=await sw(lost,{action:'close_admission',target:'external',...pins},GOOD,NOW);
  assert.deepEqual([uncertain.refused,uncertain.retry],['write_uncertain',false]);
  // the commit did land, so the same pins are now stale (the owner reads again before deciding)
  assert.equal((await sw(e,{action:'close_admission',target:'external',...pins},GOOD,NOW)).refused,'pin_mismatch');
  const switching=await read(e);const reverse={expectEpoch:switching.epoch,expectRevision:switching.revision};
  // the reverse completion needs no Watchlist state: the legacy entry is fenced by the Watchlist state itself (legacyAdmission), proven against the real rollback operator in watchlist-cutover.mjs
  const done=await sw(e,{action:'complete',...reverse},GOOD,NOW);assert.equal(done.completed,true);assert.equal((await Sync.writerFence(e)).fenced,false,'no Watchlist table here: the mode row alone decides');
  // an abort back to `cloudflare` re-admits the writer, so it needs the proof AND its pins at the commit (a partial Watchlist rollback in between refuses it); an abort toward `external` admits nothing
  await sw(e,{action:'close_admission',target:'cloudflare'},GOOD,NOW);await sw(e,{action:'complete'},GOOD,NOW);
  await sw(e,{action:'close_admission',target:'external'},GOOD,NOW);
  const open=await read(e);const abortPins={expectEpoch:open.epoch,expectRevision:open.revision};
  assert.equal((await sw(e,{action:'abort',...abortPins},{...GOOD,handover:async()=>({ratingsClosed:true,ratingsDrained:true,legacyFenced:true,watchlistRepository:false,ratingsPhase:true})},NOW)).refused,'handover_not_proven');
  assert.equal((await sw(e,{action:'abort',...abortPins},{handover:GOOD.handover,handoverGuards:async()=>[]},NOW)).refused,'handover_unprotected');
  const movedAbort=await sw(e,{action:'abort',...abortPins},{...GOOD,handoverGuards:async()=>[trip]},NOW);
  assert.equal(movedAbort.refused,'handover_changed');assert.equal((await read(e)).revision,open.revision,'nothing written');
  assert.equal((await sw(e,{action:'abort',...abortPins},GOOD,NOW)).aborted,true);
 }
 // abort: recovery from an open switch back to the mode it started from, in both directions, one writer at a time
 {
  const {db}=fresh(),e=env({db});
  await sw(e,{action:'close_admission',target:'cloudflare'},GOOD,NOW);
  const open=await read(e);
  assert.equal((await sw(e,{action:'abort',expectEpoch:open.epoch,expectRevision:open.revision+1},GOOD,NOW)).refused,'pin_mismatch');
  const aborted=await sw(e,{action:'abort',expectEpoch:open.epoch,expectRevision:open.revision},GOOD,NOW);
  assert.deepEqual([aborted.aborted,aborted.mode],[true,'external']);assert.equal((await Sync.writerFence(e)).fenced,false,'the legacy entry reopens: exactly one writer');
  assert.equal((await Sync.modeStatus(e,GOOD)).letterboxdWriters,0);
  assert.equal((await sw(e,{action:'abort'},GOOD,NOW)).refused,'not_switching');
  // cloudflare -> external -> abort: back to cloudflare, the epoch already moved so an old-epoch writer stays fenced
  await sw(e,{action:'close_admission',target:'cloudflare'},GOOD,NOW);await sw(e,{action:'complete'},GOOD,NOW);
  await sw(e,{action:'close_admission',target:'external'},GOOD,NOW);
  const switching=await read(e);const back=await sw(e,{action:'abort',expectEpoch:switching.epoch,expectRevision:switching.revision},GOOD,NOW);
  assert.deepEqual([back.aborted,back.mode,back.epoch],[true,'cloudflare',switching.epoch]);
  assert.equal((await Sync.modeStatus(e,GOOD)).letterboxdWriters,1);
  // the owner route needs the confirmation and the pins on every command
  assert.equal(Sync.validate({action:'abort'}),'Missing confirm');assert.equal(Sync.validate({action:'abort',confirm:'complete',expectEpoch:1,expectRevision:1}),'Invalid confirm');
  assert.equal(Sync.validate({action:'close_admission',target:'external',confirm:'close_admission',expectEpoch:1}),'Missing expectRevision');assert.equal(Sync.validate({action:'complete',confirm:'complete',expectEpoch:-1,expectRevision:0}),'Invalid expectEpoch');
  assert.equal(Sync.validate({action:'complete',confirm:'complete',expectEpoch:1,expectRevision:2}),null);assert.equal(Sync.validate({action:'clear_quarantine',confirm:'clear_quarantine'}),null);
 }
}
// 11. AIR-571 D2: drain mode. The writer keeps its epoch; new scans and promotions stop, effects and the Diary continue; the reverse close needs the marker.
{
 const NOW=T('2026-11-21T00:00:00Z');const read=async e=>Sync.readMode(e);
 const {db}=fresh(),e=env({db});
 const pins=async()=>{const m=await read(e);return {expectEpoch:m.epoch,expectRevision:m.revision};};
 assert.equal((await rawSwitch(e,{action:'drain',...await pins()},GOOD,NOW)).refused,'not_running','no writer, nothing to drain');
 await sw(e,{action:'close_admission',target:'cloudflare'},GOOD,NOW);
 assert.equal((await rawSwitch(e,{action:'drain'},GOOD,NOW)).refused,'not_running','a switching mode is not a running writer');
 await sw(e,{action:'complete'},GOOD,NOW);
 assert.equal((await Sync.modeStatus(e,GOOD)).scanning,'open');assert.equal((await Sync.scanOpen(e)).open,true);
 // both guards pass while scanning is open
 const trips=async sql=>{try{await db.batch([db.prepare(sql).bind(1)]);return false;}catch{return true;}};
 assert.equal(await trips(Sync.SCAN_GUARD_SQL),false);assert.equal(await trips(Sync.FENCE_GUARD_SQL),false);
 // the reverse close needs the marker; a stale pin and a competing owner are refused with nothing written
 const before=await pins();
 assert.equal((await rawSwitch(e,{action:'close_admission',target:'external',...before},GOOD,NOW)).refused,'drain_not_started');
 assert.equal((await rawSwitch(e,{action:'drain',expectEpoch:before.expectEpoch,expectRevision:before.expectRevision+3},GOOD,NOW)).refused,'pin_mismatch');
 const started=await rawSwitch(e,{action:'drain',...before},GOOD,NOW);assert.deepEqual([started.draining,started.epoch],[true,before.expectEpoch],'the epoch does not move: the running writer is not fenced');
 assert.equal((await rawSwitch(e,{action:'drain',...before},GOOD,NOW)).refused,'pin_mismatch','the second owner holds the old pins');
 assert.equal((await rawSwitch(e,{action:'drain',...await pins()},GOOD,NOW)).refused,'already_draining');
 assert.equal((await Sync.modeStatus(e,GOOD)).scanning,'stopped');assert.equal((await Sync.scanOpen(e)).open,false);
 // a promotion whose batch carries the scan guard (a stale worker that began before the marker) is refused; the effects guard still holds, so the causal effects drain
 assert.equal(await trips(Sync.SCAN_GUARD_SQL),true,'no promotion after the marker');assert.equal(await trips(Sync.FENCE_GUARD_SQL),false,'effects and the Diary continue under the same epoch');
 // recovery: resume reopens scanning; and a lost reply is unknown, never retried
 const marked=await pins();
 assert.equal((await rawSwitch(e,{action:'resume',...marked},GOOD,NOW)).resumed,true);assert.equal(await trips(Sync.SCAN_GUARD_SQL),false);
 assert.equal((await rawSwitch(e,{action:'resume',...await pins()},GOOD,NOW)).refused,'not_draining');
 const lost={...e,DB:{prepare:db.prepare.bind(db),batch:async statements=>{await db.batch(statements);throw new Error('network lost after commit');}}};
 const uncertain=await rawSwitch(lost,{action:'drain',...await pins()},GOOD,NOW);assert.deepEqual([uncertain.refused,uncertain.retry],['write_uncertain',false]);
 assert.equal((await Sync.scanOpen(e)).open,false,'the commit did land');
 // with the marker, the reverse close goes through (effects drained and pinned at the commit); the epoch moves and the writer is fenced
 const closed=await rawSwitch(e,{action:'close_admission',target:'external',...await pins()},GOOD,NOW);assert.equal(closed.closed,true);
 assert.equal(await trips(Sync.FENCE_GUARD_SQL),true,'the old epoch is fenced after the close');
 // the validated owner route
 assert.equal(Sync.validate({action:'drain',confirm:'drain',expectEpoch:1,expectRevision:2}),null);assert.equal(Sync.validate({action:'drain',confirm:'resume',expectEpoch:1,expectRevision:2}),'Invalid confirm');assert.equal(Sync.validate({action:'resume',confirm:'resume',expectEpoch:1}),'Missing expectRevision');
 // fail closed: a partial schema after a recorded epoch (no Watchlist table) is never the inert pre-switch state
 const partial=fresh({watchlist:false});const pe=env({db:partial.db});
 assert.equal((await Sync.writerFence(pe)).fenced,false,'epoch 0 and no Watchlist table: the dormant default');
 await rawSwitch(pe,{action:'close_admission',target:'cloudflare'},GOOD,NOW);await rawSwitch(pe,{action:'abort'},GOOD,NOW);
 const afterSwitch=await Sync.writerFence(pe);assert.deepEqual([afterSwitch.fenced,afterSwitch.reason],[true,'watchlist_schema_absent']);
}
// 12. AIR-571 E (review of PR #887): the CANARY HOLD. Only the named Madrid slot may be claimed until the owner's explicit `open_schedule`; the hold survives drain, resume and an abort; nothing is recorded for the held slots.
{
 const NOW=T('2026-11-22T00:00:00Z');
 const {db}=fresh(),wf=workflow(),b=bucket(),e=env({db,wf,bucket:b});
 const read=async()=>Sync.readMode(e);
 const pins=async()=>{const m=await read();return {expectEpoch:m.epoch,expectRevision:m.revision};};
 const slotRows=()=>db.sql('SELECT slot_key, status FROM letterboxd_slot ORDER BY slot_key');
 assert.equal((await rawSwitch(e,{action:'canary',slot:'2026-11-22T1630',...await pins()},GOOD,NOW)).refused,'not_running');
 await sw(e,{action:'close_admission',target:'cloudflare'},GOOD,NOW);await sw(e,{action:'complete'},GOOD,NOW);
 assert.equal((await rawSwitch(e,{action:'open_schedule',...await pins()},GOOD,NOW)).refused,'no_canary');
 assert.equal((await rawSwitch(e,{action:'canary',slot:'not-a-slot',...await pins()},GOOD,NOW)).refused,'invalid_slot');
 // a slot already past is refused (the first natural slot must still lie ahead)
 assert.equal((await rawSwitch(e,{action:'canary',slot:'2026-11-21T1030',...await pins()},GOOD,T('2026-11-22T09:35:00Z'))).refused,'slot_in_past');
 const set=await rawSwitch(e,{action:'canary',slot:'2026-11-22T1630',...await pins()},GOOD,NOW);assert.deepEqual([set.canary,set.epoch],['2026-11-22T1630',1]);
 assert.equal((await rawSwitch(e,{action:'canary',slot:'2026-11-22T2230',...await pins()},GOOD,NOW)).refused,'canary_active');
 assert.equal((await Sync.modeStatus(e,GOOD)).canary,'2026-11-22T1630');
 // before the canary slot: nothing is claimed, created or recorded (not even as missed)
 const before=await Sync.ensure(e,{now:T('2026-11-22T09:35:00Z')});
 assert.deepEqual([before.started,before.reason,before.canary],[false,'canary_hold','2026-11-22T1630']);assert.deepEqual(slotRows(),[]);assert.equal(wf.created.length,0);
 // the canary slot itself is claimed and created ONCE
 const canary=await Sync.ensure(e,{now:T('2026-11-22T15:35:00Z')});assert.equal(canary.started,true);assert.equal(canary.slot,'2026-11-22T1630');assert.equal(wf.created.length,1);
 // the hold persists after the canary: the next slot is NOT started and NOT recorded: the owner's gate is explicit
 const after=await Sync.ensure(e,{now:T('2026-11-22T21:35:00Z')});
 assert.deepEqual([after.started,after.reason],[false,'canary_hold']);assert.equal(wf.created.length,1);assert.deepEqual(slotRows().map(r=>r.slot_key),['2026-11-22T1630']);
 // drain and resume keep the hold; the scan guard still trips while draining under a canary
 const d=await rawSwitch(e,{action:'drain',...await pins()},GOOD,NOW);assert.equal(d.draining,true);assert.equal((await read()).drain,'scan_stopped+canary:2026-11-22T1630');
 assert.equal((await Sync.scanOpen(e)).open,false);
 const trips=async sql=>{try{await db.batch([db.prepare(sql).bind(1)]);return false;}catch{return true;}};
 assert.equal(await trips(Sync.SCAN_GUARD_SQL),true,'draining under a canary stops promotions');assert.equal(await trips(Sync.FENCE_GUARD_SQL),false);
 assert.equal((await rawSwitch(e,{action:'resume',...await pins()},GOOD,NOW)).resumed,true);assert.equal((await read()).drain,'canary:2026-11-22T1630','resume restores the canary hold, never the full schedule');
 assert.equal(await trips(Sync.SCAN_GUARD_SQL),false);
 // an abort back to cloudflare after a reverse close keeps the hold (the carried marker)
 await rawSwitch(e,{action:'drain',...await pins()},GOOD,NOW);
 assert.equal((await rawSwitch(e,{action:'close_admission',target:'external',...await pins()},GOOD,NOW)).closed,true);
 assert.equal((await read()).drain,'canary:2026-11-22T1630','the hold is carried through the switching episode');
 assert.equal((await rawSwitch(e,{action:'abort',...await pins()},GOOD,NOW)).aborted,true);assert.equal((await read()).drain,'canary:2026-11-22T1630','an abort never opens the full schedule');
 // the explicit gate: open_schedule removes the hold; the next slot is then claimed by the natural tick
 const opened=await rawSwitch(e,{action:'open_schedule',...await pins()},GOOD,NOW);assert.equal(opened.scheduleOpen,true);assert.equal((await read()).drain,null);
 const next=await Sync.ensure(e,{now:T('2026-11-22T21:36:00Z')});assert.equal(next.started,true);assert.equal(next.slot,'2026-11-22T2230');assert.equal(wf.created.length,2);
 // the owner route validates the commands
 assert.equal(Sync.validate({action:'canary',confirm:'canary',slot:'2026-11-23T0430',expectEpoch:1,expectRevision:2}),null);
 assert.equal(Sync.validate({action:'canary',confirm:'canary',expectEpoch:1,expectRevision:2}),'Missing slot');assert.equal(Sync.validate({action:'canary',confirm:'canary',slot:'tomorrow',expectEpoch:1,expectRevision:2}),'Invalid slot');
 assert.equal(Sync.validate({action:'open_schedule',confirm:'open_schedule',expectEpoch:1,expectRevision:2}),null);assert.equal(Sync.validate({action:'open_schedule',confirm:'canary',expectEpoch:1,expectRevision:2}),'Invalid confirm');
 assert.equal(Sync.validate({action:'open_schedule',confirm:'open_schedule',slot:'2026-11-23T0430',expectEpoch:1,expectRevision:2}),'Unknown field');
}
// 13. AIR-571 E (second review of PR #887): the canary hold is RECOVERABLE and every return to `cloudflare` through the owner route is FAIL-CLOSED. A retarget replaces a SETTLED hold in one pinned write (never opening the full schedule);
// an in-progress canary is preserved; and the completion chooses the canary slot BEFORE admission, so no tick can claim an unapproved slot between two owner commands (the cron may already be deployed).
{
 // The owner route (`handle`) reads the wall clock for the slot_in_past refusal; freeze it at the section's day so the fixed 2026-11-22 slots stay in the future on any real day (the section went red on 22 Nov 2026 after 10:30 UTC)
 const realNow=Date.now;Date.now=()=>T('2026-11-22T00:00:00Z');
 try{
 const {db}=fresh(),wf=workflow(),b=bucket(),e=env({db,wf,bucket:b});
 const read=async()=>Sync.readMode(e);
 const post=async(body,now)=>{const m=await read();const pinned={...body,confirm:body.confirm??body.action,expectEpoch:m.epoch,expectRevision:m.revision};const out=await Sync.handle(e,pinned,GOOD);return out.body;};
 const rowsOf=()=>db.sql('SELECT slot_key, status, closed_at FROM letterboxd_slot ORDER BY slot_key');
 const T0=T('2026-11-22T00:00:00Z');
 // the owner route refuses a completion toward cloudflare without a canary slot: nothing is written, the mode stays `switching`
 await rawSwitch(e,{action:'close_admission',target:'cloudflare'},GOOD,T0);
 const noSlot=await Sync.handle(e,{action:'complete',confirm:'complete',expectEpoch:(await read()).epoch,expectRevision:(await read()).revision},GOOD);
 assert.equal(noSlot.body.refused,'canary_required');assert.equal((await read()).mode,'switching');
 assert.equal((await post({action:'complete',slot:'bad'},T0)).error,'Invalid slot');
 const past=await Sync.handle(e,{action:'complete',confirm:'complete',slot:'2020-01-01T0430',expectEpoch:(await read()).epoch,expectRevision:(await read()).revision},GOOD);assert.equal(past.body.refused,'slot_in_past');
 // with the slot, the completion and the hold are ONE row write: a tick between two commands cannot exist
 const done=await Sync.handle(e,{action:'complete',confirm:'complete',slot:'2026-11-22T1030',expectEpoch:(await read()).epoch,expectRevision:(await read()).revision},GOOD);
 assert.deepEqual([done.body.completed,done.body.canary,(await read()).drain],[true,'2026-11-22T1030','canary:2026-11-22T1030']);
 const blocked=await Sync.ensure(e,{now:T('2026-11-22T03:35:00Z')});assert.deepEqual([blocked.started,blocked.reason],[false,'canary_hold']);
 // a canary that is pending or in progress is preserved: the retarget is refused with the reason, nothing is written
 const rev=(await read()).revision;
 let r=await post({action:'canary',slot:'2026-11-22T1630'},T0);assert.deepEqual([r.refused,r.why],['canary_active','canary_pending']);
 assert.equal((await post({action:'canary',slot:'2026-11-22T1030'},T0)).refused,'same_slot');
 const run1=await Sync.ensure(e,{now:T('2026-11-22T09:35:00Z')});assert.equal(run1.started,true);
 r=await Sync.handle(e,{action:'canary',confirm:'canary',slot:'2026-11-22T2230',expectEpoch:(await read()).epoch,expectRevision:(await read()).revision},GOOD,T('2026-11-22T10:00:00Z'));
 assert.equal(r.body.refused,'canary_active');assert.equal(r.body.why,'canary_in_progress','a running canary is preserved');assert.equal((await read()).drain,'canary:2026-11-22T1030');
 // inside the instance's window it stays; after the window with the instance still LIVE the retarget is refused too; once the instance ended it is a FAILED/EXPIRED canary and the retarget works
 const live=await rawSwitch(e,{action:'canary',slot:'2026-11-22T2230',...await (async()=>{const m=await read();return {expectEpoch:m.epoch,expectRevision:m.revision};})()},GOOD,T('2026-11-22T16:00:00Z'));
 assert.deepEqual([live.refused,live.why],['canary_active','canary_instance_live']);
 wf.instances.get('lbsync_20261122_1030_0').status='terminated';
 const retarget=await rawSwitch(e,{action:'canary',slot:'2026-11-22T2230',...await (async()=>{const m=await read();return {expectEpoch:m.epoch,expectRevision:m.revision};})()},GOOD,T('2026-11-22T16:00:00Z'));
 assert.deepEqual([retarget.canary,(await read()).drain],['2026-11-22T2230','canary:2026-11-22T2230'],'replaced in ONE write: the hold was never absent');
 // the non-target slot stays blocked after the retarget, the new canary starts, and nothing else does
 const between=await Sync.ensure(e,{now:T('2026-11-22T16:05:00Z')});assert.deepEqual([between.started,between.reason],[false,'canary_hold']);
 const second=await Sync.ensure(e,{now:T('2026-11-22T21:35:00Z')});assert.equal(second.started,true);assert.equal(second.slot,'2026-11-22T2230');
 // a slot that already has a row cannot be named again
 assert.equal((await rawSwitch(e,{action:'canary',slot:'2026-11-22T1030',...await (async()=>{const m=await read();return {expectEpoch:m.epoch,expectRevision:m.revision};})()},GOOD,T('2026-11-22T22:00:00Z'))).refused,'slot_in_past');
 // a MISSED canary (never claimed, window ended): the replacement works the same way
 {
  const f2=fresh(),wf2=workflow(),e2=env({db:f2.db,wf:wf2,bucket:bucket()});
  const m2=()=>Sync.readMode(e2);
  await rawSwitch(e2,{action:'close_admission',target:'cloudflare'},GOOD,T0);
  assert.equal((await Sync.handle(e2,{action:'complete',confirm:'complete',slot:'2026-11-22T1030',expectEpoch:(await m2()).epoch,expectRevision:(await m2()).revision},GOOD)).body.completed,true);
  const pend=await rawSwitch(e2,{action:'canary',slot:'2026-11-22T2230',expectEpoch:(await m2()).epoch,expectRevision:(await m2()).revision},GOOD,T('2026-11-22T12:00:00Z'));assert.deepEqual([pend.refused,pend.why],['canary_active','canary_pending']);
  const ok=await rawSwitch(e2,{action:'canary',slot:'2026-11-22T2230',expectEpoch:(await m2()).epoch,expectRevision:(await m2()).revision},GOOD,T('2026-11-22T16:00:00Z'));assert.equal(ok.canary,'2026-11-22T2230','the missed canary is replaced');
  assert.equal(f2.db.sql('SELECT COUNT(*) AS n FROM letterboxd_slot')[0].n,0,'nothing was claimed or recorded for the missed slot');
 }
 // a FAILED canary (closed with errors): the replacement works and the failed slot is not re-run
 {
  const f3=fresh(),wf3=workflow(),e3=env({db:f3.db,wf:wf3,bucket:bucket()});
  const m3=()=>Sync.readMode(e3);
  await rawSwitch(e3,{action:'close_admission',target:'cloudflare'},GOOD,T0);
  await Sync.handle(e3,{action:'complete',confirm:'complete',slot:'2026-11-22T1030',expectEpoch:(await m3()).epoch,expectRevision:(await m3()).revision},GOOD);
  const started=await Sync.ensure(e3,{now:T('2026-11-22T09:35:00Z')});assert.equal(started.started,true);
  const failed=await Sync.run(e3,{slotKey:started.slot,series:0,epoch:1},step(),{now:()=>T('2026-11-22T09:41:00Z'),ports:{ratings:okPort('error'),watchlist:okPort('unavailable')}});assert.equal(failed.status,'error');
  const ok=await rawSwitch(e3,{action:'canary',slot:'2026-11-22T1630',expectEpoch:(await m3()).epoch,expectRevision:(await m3()).revision},GOOD,T('2026-11-22T10:00:00Z'));assert.equal(ok.canary,'2026-11-22T1630','a closed (failed) canary is settled: the retarget is allowed');
  const held=await Sync.ensure(e3,{now:T('2026-11-22T10:05:00Z')});assert.deepEqual([held.started,held.reason],[false,'canary_hold']);
 }
 // RE-ENTRY with the cron already deployed: open the schedule, hand the writer back, then return to cloudflare. Every step of the way no slot is claimable without an owner-pinned canary.
 {
  const f4=fresh(),wf4=workflow(),e4=env({db:f4.db,wf:wf4,bucket:bucket()});
  const m4=()=>Sync.readMode(e4);
  const owner=async(body)=>{const m=await m4();return (await Sync.handle(e4,{...body,confirm:body.confirm??body.action,expectEpoch:m.epoch,expectRevision:m.revision},GOOD)).body;};
  await rawSwitch(e4,{action:'close_admission',target:'cloudflare'},GOOD,T0);
  assert.equal((await owner({action:'complete',slot:'2026-11-22T1030'})).completed,true);
  assert.equal((await owner({action:'open_schedule'})).scheduleOpen,true);
  assert.equal((await m4()).drain,null,'the schedule was opened by the owner');
  // the reverse handover (drain, close toward external, complete toward external), then the forward one again
  assert.equal((await owner({action:'drain'})).draining,true);
  assert.equal((await owner({action:'close_admission',target:'external'})).closed,true);
  assert.equal((await owner({action:'complete'})).completed,true);
  assert.equal((await owner({action:'close_admission',target:'cloudflare'})).closed,true);
  const attempt=await owner({action:'complete'});assert.equal(attempt.refused,'canary_required','the completion cannot reopen the schedule: it needs the canary slot');assert.equal((await m4()).mode,'switching');
  const failedBetween=await Sync.ensure(e4,{now:T('2026-11-23T03:35:00Z')});assert.equal(failedBetween.started,false,'a tick during the switch claims nothing');
  // an abort back to cloudflare after an interrupted reverse close ends in the CLOSED hold (no canary was set): nothing is claimable until the owner pins one
  assert.equal((await owner({action:'abort'})).aborted,true);
  assert.equal((await m4()).mode,'external');
 }
 {
  const f5=fresh(),wf5=workflow(),e5=env({db:f5.db,wf:wf5,bucket:bucket()});
  const m5=()=>Sync.readMode(e5);
  const owner=async(body)=>{const m=await m5();return (await Sync.handle(e5,{...body,confirm:body.confirm??body.action,expectEpoch:m.epoch,expectRevision:m.revision},GOOD)).body;};
  await rawSwitch(e5,{action:'close_admission',target:'cloudflare'},GOOD,T0);await rawSwitch(e5,{action:'complete'},GOOD,T0);   // a running writer WITHOUT any hold (state of an earlier plain completion)
  assert.equal((await m5()).drain,'verified');
  assert.equal((await owner({action:'drain'})).draining,true);
  assert.equal((await owner({action:'close_admission',target:'external'})).closed,true);
  assert.equal((await owner({action:'abort'})).aborted,true);
  assert.equal((await m5()).drain,'canary:none','an abort back to cloudflare through the owner route ends in the closed hold');
  const tick=await Sync.ensure(e5,{now:T('2026-11-22T09:35:00Z')});assert.deepEqual([tick.started,tick.reason,tick.canary],[false,'canary_hold','none']);assert.equal(f5.db.sql('SELECT COUNT(*) AS n FROM letterboxd_slot')[0].n,0);
  assert.equal((await owner({action:'open_schedule'})).refused,'canary_not_set','the closed hold cannot be opened: only `canary` leads to an admitted slot');
  const pinned=await owner({action:'canary',slot:'2026-11-22T1630'});assert.equal(pinned.canary,'2026-11-22T1630');
  const again=await Sync.ensure(e5,{now:T('2026-11-22T15:35:00Z')});assert.equal(again.started,true);assert.equal(again.slot,'2026-11-22T1630');
 }
 }finally{Date.now=realNow;}
}
// 14. AIR-571 (22 Nov 2026): an EARLIER retarget of a hold that cannot have been claimed yet. The owner chose the first evening slot after the hold had been set on the next morning's: while the held slot is still before its own
// due instant and has no slot row, the canary may move to a strictly earlier, valid, unused slot in ONE pinned write (epoch unchanged, revision +1, the full schedule never open). Everything else keeps the settled rule.
{
 const realNow=Date.now;Date.now=()=>T('2026-11-22T18:30:00Z');
 try{
  const NOW=T('2026-11-22T18:30:00Z');
  const mk=async slot=>{
   const f=fresh(),wf=workflow(),e=env({db:f.db,wf,bucket:bucket()});const read=()=>Sync.readMode(e);
   await rawSwitch(e,{action:'close_admission',target:'cloudflare'},GOOD,T('2026-11-22T18:00:00Z'));
   const done=await Sync.handle(e,{action:'complete',confirm:'complete',slot,expectEpoch:(await read()).epoch,expectRevision:(await read()).revision},GOOD);
   assert.equal(done.body.canary,slot);
   const pins=async()=>{const m=await read();return {expectEpoch:m.epoch,expectRevision:m.revision};};
   const slotRows=()=>f.db.sql('SELECT COUNT(*) AS n FROM letterboxd_slot')[0].n;
   const insertRow=(key,dueAt)=>f.db.sql("INSERT INTO letterboxd_slot (slot_key,due_at,series,instance_id,epoch,status,phase,budget_consecutive,budget_total,updated_at,revision,write_id) VALUES ('"+key+"','"+dueAt+"',0,'inst',1,'claimed','starting',0,0,'2026-11-22T18:00:00.000Z',1,'w')");
   return {f,wf,e,read,pins,slotRows,insertRow};
  };
  // A. the held 2026-11-23T1030 was never claimed and is before its due: the retarget to 2026-11-22T2230 works in ONE write
  {
   const A=await mk('2026-11-23T1030');const before=await A.read();assert.equal(A.slotRows(),0);
   const ok=await rawSwitch(A.e,{action:'canary',slot:'2026-11-22T2230',...await A.pins()},GOOD,NOW);
   assert.deepEqual([ok.canary,ok.epoch],['2026-11-22T2230',before.epoch]);
   const after=await A.read();assert.deepEqual([after.drain,after.epoch,after.revision,after.mode],['canary:2026-11-22T2230',before.epoch,before.revision+1,'cloudflare'],'one write: the hold was never absent, the epoch is unchanged');
   assert.equal(A.slotRows(),0,'nothing was claimed or recorded');
   // the full schedule is still closed: another slot is held back, the new canary is claimed once at its own tick, and the old held slot is not claimable
   const held=await Sync.ensure(A.e,{now:T('2026-11-22T18:35:00Z')});assert.deepEqual([held.started,held.reason],[false,'canary_hold']);
   const wrong=await Sync.ensure(A.e,{now:T('2026-11-22T21:00:00Z')});assert.deepEqual([wrong.started,wrong.reason],[false,'canary_hold'],'before its due instant nothing starts');
   const claimed=await Sync.ensure(A.e,{now:T('2026-11-22T21:35:00Z')});assert.deepEqual([claimed.started,claimed.slot],[true,'2026-11-22T2230']);
   assert.equal(A.slotRows(),1);
   const again=await Sync.ensure(A.e,{now:T('2026-11-22T21:50:00Z')});assert.notEqual(again.started,true,'the same slot is not started twice');assert.equal(A.slotRows(),1);
   // a later natural slot of the old hold is still refused while the new canary is pending/in progress
   const later=await rawSwitch(A.e,{action:'canary',slot:'2026-11-23T1030',...await A.pins()},GOOD,T('2026-11-22T21:40:00Z'));assert.equal(later.refused,'canary_active');
  }
  // B. a LATER target is still refused while the held slot is pending (the settled rule is unchanged)
  {
   const B=await mk('2026-11-22T2230');
   const r=await rawSwitch(B.e,{action:'canary',slot:'2026-11-23T1030',...await B.pins()},GOOD,NOW);assert.deepEqual([r.refused,r.why],['canary_active','canary_pending']);
   assert.equal((await B.read()).drain,'canary:2026-11-22T2230');
  }
  // C. the held slot already has a row (claimed): no earlier retarget; D. the target is in the past; E. the target already has a row; F. the same slot
  {
   const C=await mk('2026-11-23T1030');C.insertRow('2026-11-23T1030','2026-11-23T09:30:00.000Z');const rev=(await C.read()).revision;
   const r=await rawSwitch(C.e,{action:'canary',slot:'2026-11-22T2230',...await C.pins()},GOOD,NOW);assert.equal(r.refused,'canary_active','a claimed old hold blocks the earlier retarget');
   assert.equal((await C.read()).revision,rev,'nothing was written');
   const D=await mk('2026-11-23T1030');
   assert.equal((await rawSwitch(D.e,{action:'canary',slot:'2026-11-22T0430',...await D.pins()},GOOD,NOW)).refused,'slot_in_past');
   D.insertRow('2026-11-22T2230','2026-11-22T21:30:00.000Z');
   assert.equal((await rawSwitch(D.e,{action:'canary',slot:'2026-11-22T2230',...await D.pins()},GOOD,NOW)).refused,'slot_used');
   assert.equal((await rawSwitch(D.e,{action:'canary',slot:'2026-11-23T1030',...await D.pins()},GOOD,NOW)).refused,'same_slot');
   assert.equal((await D.read()).drain,'canary:2026-11-23T1030','every refusal left the hold as it was');
  }
  // G. the earlier retarget needs its pins like every owner command, and never works on the closed hold `none` or after the held slot is due
  {
   const G=await mk('2026-11-23T1030');
   const stale=await rawSwitch(G.e,{action:'canary',slot:'2026-11-22T2230',expectEpoch:1,expectRevision:999},GOOD,NOW);assert.equal(stale.refused,'pin_mismatch');
   const due=await rawSwitch(G.e,{action:'canary',slot:'2026-11-23T0430',...await G.pins()},GOOD,T('2026-11-23T09:35:00Z'));
   assert.equal(due.refused,'slot_in_past','a target earlier than the latest due slot is past: the held slot, once due, can no longer be retargeted earlier');
  }
 }finally{Date.now=realNow;}
}
// AIR-694: an interrupted Ratings phase without the pipeline contract freezes an honest «unknown» contract (no zero counters); a pipeline contract is never overwritten.
{
 const slot={key:'2026-11-27T2230',runId:'r1'},closedAt='2026-11-27T21:34:54.019Z',wl={outcome:'no_change',at:closedAt};
 const lost=Sync.slotEventPayloads(slot,{ratings:{outcome:'interrupted',reason:'lease_lost',phase:'diary',counts:{diaryPages:0,removalChecked:0}},watchlist:wl,closedAt}).ratings.payload;
 assert.deepEqual([lost.outcome,lost.reason,lost.state,lost.cause,lost.interruptedPhase,lost.diary,lost.removal],['interrupted','lease_lost','unknown','interrupted','diary',null,null]);
 const real={state:'error',cause:'failed',diary:{pages:1,rows:2,added:0,updated:0,written:0,unchanged:2,skipped:0,conflicts:0},removal:{pending:0,checked:0,rated:0,resolved:0}};
 const kept=Sync.slotEventPayloads(slot,{ratings:{outcome:'interrupted',event:real},watchlist:wl,closedAt}).ratings.payload;
 assert.deepEqual([kept.state,kept.cause,kept.diary.rows],['error','failed',2],'the pipeline contract wins');
 const fin=Sync.slotEventPayloads(slot,{ratings:{outcome:'finished',event:{state:'finished',cause:null}},watchlist:wl,closedAt}).ratings.payload;
 assert.equal(fin.state,'finished');
}
// AIR-694 (review): the REAL chain. A closed `unknown` run of the slot -> the pipeline's own ratingsEventOf -> the slot phase ports -> the slot outbox -> the stored Event -> the actual renderer and filter.
{
 const vm=(await import('node:vm')).default;
 const {makeBucket:mb,makeClock,makeNetwork,loadContext,g}=await import('./ratings-harness.mjs');
 const {clock,FakeDate,crypto}=makeClock(T('2026-11-27T21:00:00Z'));
 const R=g(loadContext({net:makeNetwork(),clock,FakeDate,crypto}),'LetterboxdRatings');
 const {ratingsSlotPhase}=await import('../src/letterboxd-sync-ratings.js');
 const guard=()=>['INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, 1 WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok',[1]];
 const closed=(over={})=>({runId:'4219ce2f',trigger:'scheduled',state:'unknown',cause:'interrupted',interruptedPhase:'diary',phase:'diary',slotKey:'2026-11-21T1030',closedAt:'2026-11-27T21:34:48.656Z',checkpoint:{diaryPagesRead:0,diaryNextPage:1,removalChecked:0},diary:null,removal:null,...over});
 const fakeApi=run=>({async readRun(){return structuredClone(run.current);},async start(){return {created:false,reason:'busy'};},async step(){return run.reply;},ratingsEventOf:(r,o)=>R.ratingsEventOf(JSON.parse(JSON.stringify(r)),o)});
 const portsOf=run=>({ratings:ratingsSlotPhase({ratings:fakeApi(run),fenceGuard:guard,phase:'diary'}),reconcile:ratingsSlotPhase({ratings:fakeApi(run),fenceGuard:guard,phase:'removal'})});
 const html=vm.createContext({URL,URLSearchParams,Set,Map,Date,Intl,document:{querySelector:()=>null,querySelectorAll:()=>[]},window:{location:{href:'https://iptv.example/'}}});
 vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+'\n'+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),html);
 const drawn=async(b)=>{const key=[...b.map.keys()].find(k=>k.includes('ratings'));const ev=JSON.parse(typeof b.map.get(key)==='string'?b.map.get(key):b.map.get(key).body??b.map.get(key));html.ev=ev;return {ev,card:vm.runInContext('eventHTML(ev)',html),interrupted:vm.runInContext("eventMatchesFilters(ev,'ratings','interrupted')",html),error:vm.runInContext("eventMatchesFilters(ev,'ratings','error')",html)};};
 // (a) The incident: the Diary port loses its lease, the run is then closed as unknown, the reconciliation port reads the closed run and hands back the REAL contract.
 {
  const run={current:{...closed(),state:'running',phase:'diary',lease:{step:'s',expiresAt:'2026-11-27T21:34:09.374Z'}},reply:{reason:'lease_lost'}};
  const p=portsOf(run);
  const ctx={env:{},slotKey:'2026-11-21T1030',epoch:1,now:()=>T('2026-11-21T09:40:00Z')};
  const r=await wholeRun({ratings:p.ratings,watchlist:okPort('no_change'),reconcile:{async run(c){run.current=closed();return p.reconcile.run(c);}}});
  assert.equal(r.result.reason,'complete');
  const slot=await Sync.readSlot(r.e,r.started.slot);assert.equal(slot.ratings.outcome,'interrupted');assert.equal(slot.status,'interrupted');
  assert.equal(r.f.db.sql("SELECT COUNT(*) AS n FROM letterboxd_slot_event")[0].n,2,'exactly two Events');
  const {ev,card,interrupted,error}=await drawn(r.b);
  assert.deepEqual([ev.state,ev.cause,ev.interruptedPhase,ev.diary,ev.removal,ev.reason,ev.outcome],['unknown','interrupted','diary',null,null,'lease_lost','interrupted'],'real contract: honest unknown, no fabricated zero');
  assert.match(card,/event-status-interrupted/);assert.match(card,/потеряна аренда шага/);assert.match(card,/этап: Diary/);assert.doesNotMatch(card,/<dl>|Удалений обработано/);
  assert.equal(interrupted,true);assert.equal(error,false);
 }
 // (b) An own run already persisted as unknown: the Diary phase reports an interruption (never network_error) and the reconciliation an operational error plus the interruption.
 {
  const run={current:closed({cause:'abandoned'}),reply:null},p=portsOf(run),c={env:{},slotKey:'2026-11-21T1030',epoch:1,now:()=>T('2026-11-21T09:40:00Z')};
  let out=await p.ratings.run(c);assert.deepEqual([out.outcome,out.reason,out.phase,out.counts],['interrupted','abandoned','diary',{diaryPages:0,removalChecked:0}]);assert.equal(out.event.state,'unknown');
  out=await p.reconcile.run(c);assert.deepEqual([out.outcome,out.interrupted],['error',{reason:'abandoned',phase:'diary'}]);
 }
 // (c) An interruption in removal after a successful Diary: the Diary outcome stays `finished`, the Event carries the confirmed Diary counts and an unknown removal; blocked and rate limited stay warnings.
 {
  const diary={counts:{pages:1,rows:50,added:1,updated:0},facts:{written:1,unchanged:49,skipped:0,conflicts:0},historicalCoverage:'incomplete'};
  const run={current:closed({phase:'removal',interruptedPhase:'removal',checkpoint:{diaryPagesRead:1,diaryNextPage:null,removalChecked:0},diary,removal:null}),reply:null},p=portsOf(run);
  const r=await wholeRun({ratings:okPort('finished',{at:'2026-11-21T09:45:00.000Z'}),watchlist:okPort('no_change'),reconcile:p.reconcile});
  const slot=await Sync.readSlot(r.e,r.started.slot);assert.equal(slot.ratings.outcome,'finished','a finished Diary outcome is not changed retroactively');
  assert.equal(r.f.db.sql("SELECT COUNT(*) AS n FROM letterboxd_slot_event")[0].n,2);
  const {ev,card,interrupted}=await drawn(r.b);
  assert.deepEqual([ev.state,ev.interruptedPhase,ev.diary.rows,ev.diary.written,ev.removal],['unknown','removal',50,1,null]);
  assert.match(card,/event-status-interrupted/);assert.match(card,/записей проверено/);assert.doesNotMatch(card,/Удалений обработано/);assert.equal(interrupted,true);
  for(const [cause,status] of [['blocked','warning'],['rate_limited','warning'],['failed','error']]){
   html.ev={type:'ratings',state:'error',cause};assert.equal(vm.runInContext('eventPresentationStatus(ev)',html),status);
  }
 }
 // (d) A lost lease in the removal phase: the reply carries the real phase of the run; no counters are guessed.
 {
  const run={current:{...closed({phase:'removal',interruptedPhase:null,state:'running',cause:null}),lease:{step:'s',expiresAt:'2026-11-27T21:34:09.374Z'}},reply:{reason:'lease_lost'}},p=portsOf(run);
  const out=await p.reconcile.run({env:{},slotKey:'2026-11-21T1030',epoch:1,now:()=>T('2026-11-21T09:40:00Z')});
  assert.deepEqual([out.outcome,out.interrupted],['error',{reason:'lease_lost',phase:'removal'}]);
  const f=Sync.slotEventPayloads({key:'2026-11-21T1030'},{ratings:{outcome:'finished',interruption:out.interrupted},watchlist:{outcome:'no_change'},closedAt:'2026-11-21T09:50:00.000Z'}).ratings.payload;
  assert.deepEqual([f.state,f.interruptedPhase,f.diary,f.reason,f.outcome],['unknown','removal',null,'lease_lost','finished']);
 }
}
console.log('letterboxd-sync ok');
