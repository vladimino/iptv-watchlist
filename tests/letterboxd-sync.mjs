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
function fresh({schema=true}={}){
 const file=path.join(root,'t'+(dbCount++)+'.db');
 const run=sql=>{const r=sqliteSync(['-bail',file],{input:sql});if(r.status!==0)throw new Error(r.stderr);};
 run("CREATE TABLE schema_contract(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, note TEXT); INSERT INTO schema_contract VALUES(1,31,'t');");
 if(schema)run(fs.readFileSync('migrations/0032_letterboxd_sync_control.sql','utf8'));
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
const GOOD={handover:async()=>({ratingsClosed:true,ratingsDrained:true,legacyFenced:true,watchlistRepository:true,ratingsPhase:true})};
async function activate(e,ports=GOOD,now=T('2026-11-21T09:39:00Z')){
 assert.equal((await Sync.switchMode(e,{action:'close_admission',target:'cloudflare'},ports,now)).closed,true);
 const done=await Sync.switchMode(e,{action:'complete'},ports,now);assert.equal(done.completed,true,JSON.stringify(done));return done;
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
 const refused=await Sync.switchMode(e,{action:'close_admission',target:'cloudflare'},{},T('2026-11-21T00:00:00Z'));assert.equal(refused.closed,true);
 const blocked=await Sync.switchMode(e,{action:'complete'},{},T('2026-11-21T00:00:00Z'));
 assert.equal(blocked.refused,'handover_not_proven');assert.deepEqual(blocked.missing.sort(),['legacyFenced','ratingsClosed','ratingsDrained','ratingsPhase','watchlistRepository']);
 assert.equal((await Sync.writerFence(e)).fenced,true,'switching fences the legacy ratings entry');
 const partial=await Sync.switchMode(e,{action:'complete'},{handover:async()=>({ratingsClosed:true,ratingsDrained:true,legacyFenced:false,watchlistRepository:true,ratingsPhase:true})});
 assert.deepEqual(partial.missing,['legacyFenced'],'an external-mode-only Ratings is not a sufficient fence');
 assert.equal((await Sync.switchMode(e,{action:'complete'},{handover:async()=>{throw new Error('x');}})).refused,'handover_not_proven');
 const done=await Sync.switchMode(e,{action:'complete'},GOOD);assert.equal(done.completed,true);assert.equal(done.epoch,1);
 assert.equal((await Sync.writerFence(e)).reason,'letterboxd_sync_active');
 assert.equal((await Sync.switchMode(e,{action:'close_admission',target:'cloudflare'})).refused,'already_in_mode');
 // Rollback: close to external; the epoch moves so a stale instance is refused.
 assert.equal((await Sync.switchMode(e,{action:'close_admission',target:'external'})).epoch,2);
 assert.equal((await Sync.switchMode(e,{action:'complete'})).completed,true,'closing to external needs no handover');
 assert.equal((await Sync.writerFence(e)).fenced,false);
 assert.equal(Sync.validate({action:'close_admission'}),'Missing target');assert.equal(Sync.validate({action:'x'}),'Unknown action');assert.equal(Sync.validate({action:'complete',extra:1}),'Unknown field');
 assert.equal((await Sync.handle(e,{action:'complete'})).body.refused,'not_switching');
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
 await Sync.switchMode(e,{action:'close_admission',target:'external'});
 const stale=await Sync.run(e,{slotKey:st.slot,series:0,epoch:1},step(),{now:()=>T('2026-11-21T09:41:00Z'),ports:{ratings:okPort('finished'),watchlist:okPort('committed')}});
 assert.equal(stale.stopped,true);assert.equal(stale.reason,'switch_in_progress');assert.equal(b.map.size,0);assert.equal((await Sync.readSlot(e,st.slot)).status,'claimed');
 assert.equal((await Sync.switchMode(e,{action:'complete'})).drain,'instance_live','the drain is verified, not assumed');
 wf.instances.get('lbsync_20261121_1030_0').status='terminated';
 assert.equal((await Sync.switchMode(e,{action:'complete'})).completed,true);
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
 assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/LETTERBOXD|30 \* \* \* \*/,'no binding or cron in this change');
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
 const f=fresh(),wf=workflow(),e={DB:f.db,BUCKET:bucket(),LETTERBOXD_WORKFLOW:wf,RATINGS_WORKFLOW:{create:async()=>{throw new Error('must not create');}}};
 // Inert: with no Letterboxd mode row the legacy gate is exactly today's.
 assert.equal((await RatingsOrchestration.externalGate(e,'start')).reason,null);
 assert.equal((await RatingsOrchestration.externalGate(e,'step')).reason,null);
 // Taking over: the switch is open, so both legacy entries are refused.
 await LetterboxdSync.switchMode(e,{action:'close_admission',target:'cloudflare'},{},T('2026-11-21T09:39:00Z'));
 assert.equal((await RatingsOrchestration.externalGate(e,'start')).reason,'external_writer_fenced');
 assert.equal((await RatingsOrchestration.externalGate(e,'step')).reason,'external_writer_fenced');
 assert.equal((await RatingsOrchestration.externalGate(e,'status')).reason,null,'reads stay open');
 await LetterboxdSync.switchMode(e,{action:'complete'},{handover:async()=>({ratingsClosed:true,ratingsDrained:true,legacyFenced:true,watchlistRepository:true,ratingsPhase:true})});
 assert.equal((await RatingsOrchestration.externalGate(e,'step')).reason,'external_writer_fenced');
 // The 17:00 ratings due creates nothing while the Letterboxd mode is cloudflare, even if the ratings mode document says cloudflare (never two Diary writers).
 ctx.__ratingsCloudflare=true;
 const mode=await RatingsOrchestration.ensure(e,{now:T('2026-11-21T16:05:00Z')});assert.equal(mode.reason,'letterboxd_sync_active');assert.equal(mode.started,false);
 const stale=await RatingsOrchestration.admit(e,{runKey:'2026-11-21',series:0,epoch:1,id:'x'});assert.equal(stale.reason,'external_writer_fenced','a stale ratings instance is refused');
 ctx.__ratingsCloudflare=false;
 // Rollback: back to external re-opens exactly the legacy writer.
 await LetterboxdSync.switchMode(e,{action:'close_admission',target:'external'});
 await LetterboxdSync.switchMode(e,{action:'complete'});
 assert.equal((await RatingsOrchestration.externalGate(e,'start')).reason,null,'rollback restores the single legacy writer');
}
console.log('letterboxd-sync ok');
