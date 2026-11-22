// AIR-571 (M1): the independent reconcile of the root watchlist.json mirror of the Watchlist authority (src/watchlist-mirror.js, PublishedEpg.putStandaloneWatchlistRoot, WatchlistD1.recordMirror), OFFLINE against the
// real Watchlist repository on the sqlite D1 stand-in with the whole migration chain, and an in-memory R2 store with strong content etags. No network, no Cloudflare, nothing applied to production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as Mirror from '../src/watchlist-mirror.js';
import * as PublishedEpg from '../src/published-epg.js';
import * as WatchlistD1 from '../src/watchlist-d1.js';
import * as Sync from '../src/letterboxd-sync.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-wlmirror-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const T=s=>Date.parse(s);
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const base=path.join(root,'base.sqlite');
{const r=sqliteSync(['-bail',base],{input:'PRAGMA foreign_keys=ON;\n'+chain});if(r.status!==0)throw new Error(r.stderr);}
const md5=text=>createHash('md5').update(text).digest('hex');
// An R2 stand-in with content etags, conditional puts and hooks to model lost replies and racing writers.
function store(initial={}){
 const objects=new Map(Object.entries(initial).map(([key,text])=>[key,{text,etag:md5(text)}]));
 const s={objects,puts:0,onGet:null,failPut:null,lostReply:false,dropPut:false,getFails:0,
  async get(key){if(s.getFails>0){s.getFails--;throw new Error('r2 down');}if(s.onGet)await s.onGet(key);const o=objects.get(key);return o?{etag:o.etag,text:async()=>o.text}:null;},
  async put(key,text,options={}){
   if(s.failPut)throw s.failPut;
   const o=objects.get(key);
   if(options.onlyIf?.etagMatches&&o?.etag!==options.onlyIf.etagMatches)return null;
   if(options.onlyIf?.etagDoesNotMatch==='*'&&o)return null;
   if(s.dropPut)return {etag:'phantom'};
   objects.set(key,{text,etag:md5(text)});s.puts++;
   if(s.lostReply)throw new Error('reply lost after commit');
   return {etag:md5(text)};
  }};
 return s;
}
let copies=0;
function open({marker='d1',writes='open',mode='cloudflare',epoch=1,onBatch=null}={}){
 const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(base,file);
 const sql=text=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
 sql("UPDATE watchlist_authority SET mode='"+marker+"',writes='"+writes+"',generation=1 WHERE id=1;");
 if(mode&&mode!=='switching')sql("INSERT INTO letterboxd_sync_mode (id,mode,epoch,changed_at,revision,write_id) VALUES (1,'"+mode+"',"+epoch+",'2026-11-21T00:00:00.000Z',1,'w');");
 return {file,sql,db:d1Standin(file,onBatch?{onBatch}:{})};
}
const films=(...ids)=>ids.map(i=>({id:'f'+i,title:'F'+i,year:2000+i,url:'https://letterboxd.com/film/f'+i+'/'}));
let scans=0;
async function scan(f,list,observedAt){
 const result=await WatchlistD1.publishSnapshot(f.db,list,{scanId:'s'+(scans++),observedAt,completedAt:observedAt},{now:T(observedAt)});
 assert.equal(result.ok,true,JSON.stringify(result));
 if(result.outcome==='committed')for(const effect of WatchlistD1.EFFECTS)assert.equal((await WatchlistD1.completeEffect(f.db,{snapshotId:result.snapshotId,effect,receipt:'r'},{now:T(observedAt)})).ok,true);
 return result;
}
const deps={WatchlistD1,PublishedEpg};
const reconcile=(f,bucket,now,epoch=1)=>Mirror.reconcileMirror({DB:f.db,BUCKET:bucket},{epoch,now:T(now),deps});
const rootDoc=bucket=>{const o=bucket.objects.get('watchlist.json');return o?JSON.parse(o.text):null;};
const pointer=f=>f.db.sql('SELECT version, snapshot_id, last_success_at, mirror_delivered_snapshot_id, mirror_attempts, mirror_next_retry_at, revision FROM watchlist_current')[0];

// 1. Pure: the document, the token, the health and the backoff.
{
 const doc=Mirror.mirrorDocument({lastSuccessAt:'2026-11-21T10:00:00.000Z',snapshotId:'snap-1',version:3,films:[{lid:'a',title:'A',year:2001,url:'u'}]});
 assert.deepEqual(doc,{updatedAt:'2026-11-21T10:00:00.000Z',films:[{id:'a',title:'A',year:2001,url:'u'}],snapshotId:'snap-1',snapshotVersion:3,lastSuccessAt:'2026-11-21T10:00:00.000Z',source:'watchlist_authority'});
 assert.equal(WatchlistD1.mirrorToken('s','t'),'s|t');
 assert.deepEqual([1,2,3,4,9].map(Mirror.backoffMs),[60000,300000,900000,3600000,3600000]);
 const owed={snapshotId:'s',lastSuccessAt:'2026-11-21T10:00:00.000Z',mirrorDeliveredSnapshotId:null,mirrorAttempts:2,mirrorNextRetryAt:null};
 assert.equal(Mirror.mirrorState(owed,T('2026-11-21T11:00:00Z')).state,'owed');assert.equal(Mirror.mirrorState({...owed,mirrorAttempts:3},T('2026-11-21T10:05:00Z')).state,'stale','three failed attempts in a row');assert.equal(Mirror.mirrorState(owed,T('2026-11-21T12:30:00Z')).state,'stale');
 assert.equal(Mirror.mirrorState({...owed,mirrorDeliveredSnapshotId:'s|2026-11-21T10:00:00.000Z'},T('2026-11-22T10:00:00Z')).state,'delivered');
 // a root whose token differs only by freshness (a no_change scan) is owed again
 assert.equal(Mirror.mirrorState({...owed,mirrorDeliveredSnapshotId:'s|2026-11-21T04:00:00.000Z'},T('2026-11-21T10:30:00Z')).state,'owed');
}

// 2. Not the owner: an EPG-owned marker, a held marker or a closed Letterboxd mode write nothing.
{
 for(const [label,options] of [['epg marker',{marker:'epg'}],['held',{writes:'held'}],['switching mode',{mode:'switching'}],['no mode row',{mode:null}]]){
  const f=open(options);const b=store();
  if(options.mode==='switching')f.sql("DELETE FROM letterboxd_sync_mode;INSERT INTO letterboxd_sync_mode (id,mode,target,from_mode,epoch,changed_at,revision,write_id) VALUES (1,'switching','external','cloudflare',2,'2026-11-21T00:00:00.000Z',2,'w');");
  const r=await reconcile(f,b,'2026-11-21T10:00:00Z');
  assert.ok(['not_owner','unreadable','blocked'].includes(r.outcome),label+': '+JSON.stringify(r));assert.equal(b.puts,0,label+' wrote nothing');
 }
}

// 3. First delivery, then a no_change scan: freshness changes without a new snapshot id and is delivered; a delivered target is nothing owed.
{
 const f=open(),b=store();
 await scan(f,films(0,1,2),'2026-11-21T09:40:00.000Z');
 const first=await reconcile(f,b,'2026-11-21T09:41:00Z');assert.equal(first.outcome,'written',JSON.stringify(first));
 assert.deepEqual([rootDoc(b).source,rootDoc(b).snapshotVersion,rootDoc(b).films.map(x=>x.id)],['watchlist_authority',1,['f0','f1','f2']]);
 assert.equal(pointer(f).mirror_delivered_snapshot_id,pointer(f).snapshot_id+'|2026-11-21T09:40:00.000Z');assert.equal(pointer(f).mirror_attempts,0);
 const revision=pointer(f).revision;
 assert.equal((await reconcile(f,b,'2026-11-21T09:42:00Z')).outcome,'delivered');assert.equal(b.puts,1,'nothing owed, nothing written');
 const nochange=await scan(f,films(0,1,2),'2026-11-21T15:40:00.000Z');assert.equal(nochange.outcome,'no_change');
 const after=await reconcile(f,b,'2026-11-21T15:41:00Z');assert.equal(after.outcome,'written','a freshness-only change is owed');
 assert.equal(rootDoc(b).lastSuccessAt,'2026-11-21T15:40:00.000Z');assert.equal(rootDoc(b).snapshotId,pointer(f).snapshot_id,'same snapshot id, new freshness');
 assert.ok(pointer(f).revision>revision,'the scan moved the revision, the mirror bookkeeping never does');
 const beforeBookkeeping=pointer(f).revision;await reconcile(f,b,'2026-11-21T15:50:00Z');assert.equal(pointer(f).revision,beforeBookkeeping);
}

// 4. T24: an outage across several healthy slots: every scan commits, the backlog is ONE target (the latest), the retry backs off, `mirror_stale` is visible, and delivery resumes with ONE write.
{
 const f=open(),b=store();
 await scan(f,films(0,1,2),'2026-11-21T09:40:00.000Z');assert.equal((await reconcile(f,b,'2026-11-21T09:41:00Z')).outcome,'written');
 b.failPut=new Error('r2 outage');const puts=b.puts;
 await scan(f,films(0,1,3),'2026-11-21T15:40:00.000Z');
 const r1=await reconcile(f,b,'2026-11-21T15:41:00Z');assert.deepEqual([r1.outcome,r1.recorded],['failed',true]);
 assert.deepEqual([pointer(f).mirror_attempts,pointer(f).mirror_next_retry_at],[1,'2026-11-21T15:42:00.000Z']);
 assert.equal((await reconcile(f,b,'2026-11-21T15:41:30Z')).outcome,'backoff','no tight loop');assert.equal(pointer(f).mirror_attempts,1,'a backoff attempt records nothing');
 await scan(f,films(0,2,3),'2026-11-21T21:40:00.000Z');await scan(f,films(1,2,3),'2026-11-22T03:40:00.000Z');
 const r2=await reconcile(f,b,'2026-11-22T03:41:00Z');assert.equal(r2.outcome,'failed');assert.equal(pointer(f).mirror_attempts,2);
 assert.equal((await Sync.readModel({DB:f.db},{now:T('2026-11-22T03:41:30Z')})).mirror.stale,false,'two failures on a fresh target: owed, not yet stale');
 const r3=await reconcile(f,b,'2026-11-22T03:50:00Z');assert.equal(r3.outcome,'failed');assert.equal(pointer(f).mirror_attempts,3);
 // the model shows the signal; the scans are not gated by it
 const model=await Sync.readModel({DB:f.db},{now:T('2026-11-22T03:51:00Z')});assert.equal(model.mirror.stale,true);assert.equal(model.mirror.warning,'mirror_stale');
 b.failPut=null;
 const recovered=await reconcile(f,b,'2026-11-22T06:00:00Z');assert.equal(recovered.outcome,'written');
 assert.equal(b.puts,puts+1,'one write for the whole backlog: only the latest snapshot was owed');
 assert.deepEqual(rootDoc(b).films.map(x=>x.id),['f1','f2','f3']);assert.equal(rootDoc(b).snapshotVersion,pointer(f).version);
 assert.deepEqual([pointer(f).mirror_attempts,pointer(f).mirror_next_retry_at],[0,null]);
 assert.equal((await Sync.readModel({DB:f.db},{now:T('2026-11-22T06:01:00Z')})).mirror.state,'delivered');
}

// 5. Unknown writes: the answer of a put is never the proof.
{
 // a lost reply after the object was stored: the readback proves it, delivery is acknowledged
 let f=open(),b=store();await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');b.lostReply=true;
 const proven=await reconcile(f,b,'2026-11-21T09:41:00Z');assert.equal(proven.outcome,'delivered','proved by the readback, not by the lost reply');assert.equal(pointer(f).mirror_attempts,0);assert.ok(pointer(f).mirror_delivered_snapshot_id);
 // a reply that says "stored" while nothing was: no proof, a failed attempt, never an acknowledgement
 f=open();b=store();await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');b.dropPut=true;
 const phantom=await reconcile(f,b,'2026-11-21T09:41:00Z');assert.equal(phantom.outcome,'failed');assert.equal(pointer(f).mirror_delivered_snapshot_id,null);assert.equal(pointer(f).mirror_attempts,1);
 // an unreadable readback after a put that landed: unproven too (the next tick compares and acknowledges without a write)
 f=open();b=store();await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');
 let gets=0;const realGet=b.get.bind(b);b.get=async key=>{gets++;if(gets===2)throw new Error('r2 down');return realGet(key);};
 const unknown=await reconcile(f,b,'2026-11-21T09:41:00Z');assert.equal(unknown.outcome,'failed');assert.equal(pointer(f).mirror_delivered_snapshot_id,null);
 b.get=realGet;const later=await reconcile(f,b,'2026-11-21T09:43:00Z');assert.equal(later.outcome,'delivered');assert.equal(b.puts,1,'the landed object is recognized semantically: no second write');
}

// 6. A stale owner: the marker moves between the guard and the put, the root changes under a racing writer, and the acknowledgement lands only while everything it pinned still holds.
{
 // the marker is held after the first guard read: the second guard (after the etag read) blocks the put
 let f=open(),b=store({'watchlist.json':JSON.stringify({updatedAt:'x',films:[]})});await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');
 b.onGet=async()=>{f.sql("UPDATE watchlist_authority SET writes='held'");};
 const blocked=await reconcile(f,b,'2026-11-21T09:41:00Z');assert.equal(blocked.outcome,'blocked');assert.equal(b.puts,0);
 // the root moved after the etag read: the conditional put is refused and the semantic readback does not match
 f=open();b=store({'watchlist.json':JSON.stringify({updatedAt:'x',films:[]})});await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');
 const putReal=b.put.bind(b);b.put=async(...args)=>{b.objects.set('watchlist.json',{text:JSON.stringify({updatedAt:'y',films:[{id:'zz'}]}),etag:md5('other')});return putReal(...args);};
 const raced=await reconcile(f,b,'2026-11-21T09:41:00Z');assert.equal(raced.outcome,'failed');assert.equal(pointer(f).mirror_delivered_snapshot_id,null);
 // the acknowledgement is refused when the pointer moved after the root was stored: the pinned target is stale, nothing is recorded
 f=open();b=store();await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');
 const realPut=b.put.bind(b);b.put=async(...args)=>{const out=await realPut(...args);await scan(f,films(0,1,2),'2026-11-21T10:00:00.000Z');return out;};
 const moved=await reconcile(f,b,'2026-11-21T09:41:00Z');assert.equal(moved.outcome,'uncertain');assert.equal(pointer(f).mirror_delivered_snapshot_id,null,'the stale target is not acknowledged');
 b.put=realPut;assert.equal((await reconcile(f,b,'2026-11-21T10:01:00Z')).outcome,'written','the next tick delivers the new target');assert.equal(rootDoc(b).snapshotVersion,2);
 // the Letterboxd epoch moved (a close) between the root write and the acknowledgement
 f=open();b=store();await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');
 const put2=b.put.bind(b);b.put=async(...args)=>{const out=await put2(...args);f.sql("UPDATE letterboxd_sync_mode SET epoch=2,revision=2");return out;};
 assert.equal((await reconcile(f,b,'2026-11-21T09:41:00Z')).outcome,'uncertain');assert.equal(pointer(f).mirror_delivered_snapshot_id,null);
}

// 7. Competing reconcile and the representation fence: two writers produce an equal list, never an equal representation (no ABA), and the bookkeeping is idempotent.
{
 const f=open(),b=store();await scan(f,films(0,1,2),'2026-11-21T09:40:00.000Z');
 const results=await Promise.all([reconcile(f,b,'2026-11-21T09:41:00Z'),reconcile(f,b,'2026-11-21T09:41:00Z')]);
 assert.ok(results.every(r=>['written','delivered'].includes(r.outcome)),JSON.stringify(results));
 assert.equal(pointer(f).mirror_attempts,0);assert.ok(pointer(f).mirror_delivered_snapshot_id);assert.equal(rootDoc(b).snapshotVersion,1);
 const doc=Mirror.mirrorDocument({lastSuccessAt:'t',snapshotId:'s',version:1,films:[]});
 const one=PublishedEpg.serializeRoot(doc),two=PublishedEpg.serializeRoot(doc);
 assert.equal(PublishedEpg.rootSemantic(one),PublishedEpg.rootSemantic(two));assert.notEqual(md5(one),md5(two),'a fresh token on every write: an etag is never reused');
}

// 8. Writer separation: the EPG-side root writer refuses the d1 marker; the standalone writer refuses everything else.
{
 const f=open(),b=store();
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:f.db,BUCKET:b},{updatedAt:'x',films:[]})).blocked,true,'d1/open: the root belongs to the Watchlist');
 const e=open({marker:'epg'});const eb=store();
 assert.equal((await PublishedEpg.putStandaloneWatchlistRoot({DB:e.db,BUCKET:eb},{updatedAt:'x',films:[]},{generation:1,epoch:1,target:{snapshotId:'s',lastSuccessAt:'t'}})).blocked,true);assert.equal(eb.puts,0);
 assert.equal((await PublishedEpg.putStandaloneWatchlistRoot({DB:f.db,BUCKET:b},{updatedAt:'x',films:[]},{generation:2,epoch:1,target:{snapshotId:'s',lastSuccessAt:'t'}})).blocked,true,'another generation');
}

// 8b. Review (PR #883): the guard after the etag read pins the exact current TARGET, not only ownership. Pass A captured V1 and stalls before its root read; V2 is promoted, written AND acknowledged by pass B; A then
// resumes and reads B's NEW etag. A must write nothing: V2 stays stored, D1 still says V2 is delivered, and the next reconcile owes nothing wrong. Repeated for a freshness-only (no_change) change.
{
 for(const [label,next,expectedVersion] of [['a new snapshot',films(0,1,3),2],['a no_change freshness',films(0,1,2),1]]){
  const f=open(),b=store();
  await scan(f,films(0,1,2),'2026-11-21T09:40:00.000Z');
  // A: the pass starts with target V1, then stalls inside its first root read
  let inner=null;
  b.onGet=async()=>{b.onGet=null;
   await scan(f,next,'2026-11-21T15:40:00.000Z');
   inner=await reconcile(f,b,'2026-11-21T15:41:00Z');   // B: promotes, writes and ACKNOWLEDGES the newer target
  };
  const a=await reconcile(f,b,'2026-11-21T09:41:00Z');
  assert.equal(inner.outcome,'written',label+': B delivered the newer target');
  assert.equal(a.outcome,'moved',label+': A found the target moved: '+JSON.stringify(a));
  assert.equal(rootDoc(b).lastSuccessAt,'2026-11-21T15:40:00.000Z',label+': the newer root is still stored');assert.equal(rootDoc(b).snapshotVersion,expectedVersion);
  assert.equal(pointer(f).mirror_delivered_snapshot_id,pointer(f).snapshot_id+'|2026-11-21T15:40:00.000Z',label+': D1 says the newer target is delivered, and it IS stored');
  assert.equal((await reconcile(f,b,'2026-11-21T15:50:00Z')).outcome,'delivered');assert.equal(b.puts,1,label+': only B wrote; A wrote nothing');
 }
}

// 8c. Review (PR #883): bookkeeping applies only while the target is still owed. A late failure after a successful acknowledgement of the same target records nothing, and a duplicate success is an idempotent no-op.
{
 const f=open();await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');
 const p0=pointer(f);const target={snapshotId:p0.snapshot_id,lastSuccessAt:p0.last_success_at,generation:1,now:T('2026-11-21T09:41:00Z')};
 // two passes read attempts = 0; B proves delivery first
 assert.equal((await WatchlistD1.recordMirror(f.db,{...target,outcome:'delivered'})).ok,true);
 const delivered=pointer(f);assert.equal(delivered.mirror_attempts,0);
 // A's earlier failure arrives late: nothing is recorded (no debt, no backoff on a delivered target, no revision move)
 const late=await WatchlistD1.recordMirror(f.db,{...target,outcome:'failed',attempts:0,nextRetryAt:'2026-11-21T09:50:00.000Z'});
 assert.deepEqual([late.ok,late.applied,late.reason],[true,false,'already_delivered'],'a late failure on a delivered target is reported as a no-op, never as a recorded attempt');
 assert.deepEqual(pointer(f),delivered,'a late failure after a successful acknowledgement changes nothing');
 // a second successful acknowledgement of the same token leaves the revision unchanged
 const dup=await WatchlistD1.recordMirror(f.db,{...target,outcome:'delivered'});assert.deepEqual([dup.ok,dup.applied],[true,false]);
 assert.equal(pointer(f).revision,delivered.revision,'duplicate success: no revision bump, no contention with a scan');
 // a stale target is refused outright (the pointer moved)
 await scan(f,films(0,1,2),'2026-11-21T10:00:00.000Z');
 assert.equal((await WatchlistD1.recordMirror(f.db,{...target,outcome:'delivered'})).ok,false);
}

// 8d. Review (PR #883, carried into M2): the replay pin is ONE read of the pointer and the authority, and its guard asserts the original generation too.
{
 const f=open();await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');
 const pin=await WatchlistD1.pointerPin(f.db);
 assert.deepEqual([pin.version,pin.generation,typeof pin.snapshotId,typeof pin.lastSuccessAt,Number.isInteger(pin.revision)],[1,1,'string','string',true]);
 const run=async()=>{try{await f.db.batch([f.db.prepare(WatchlistD1.pointerGuard(pin)[0]).bind(...WatchlistD1.pointerGuard(pin)[1])]);return true;}catch{return false;}};
 assert.equal(await run(),true);
 f.sql("UPDATE watchlist_authority SET generation=2");assert.equal(await run(),false,'a marker transition after the pin refuses the replay even when the pointer did not move');
 f.sql("UPDATE watchlist_authority SET generation=1,writes='held'");assert.equal(await WatchlistD1.pointerPin(f.db),null,'a held marker has no pin');
}

// 8e. Review (PR #884): `applied` is derived from the ACTUAL result of the conditional UPDATE (a trailing `SELECT changes()` in the same batch), never from the early read. A competing successful acknowledgement
// or a competing failed-attempt compare-and-swap landing between the pre-read and the batch makes the UPDATE match no row: a proven no-op (`applied:false`, `not_owed`), reported by the reconcile as not recorded.
{
 const state={armed:null};
 const f=open({onBatch:async statements=>{if(statements.every(item=>/^\s*SELECT/i.test(item.text)))return;const hook=state.armed;state.armed=null;if(hook)hook(f);}});
 await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');
 const p0=pointer(f);const target={snapshotId:p0.snapshot_id,lastSuccessAt:p0.last_success_at,generation:1,now:T('2026-11-21T09:41:00Z')};
 const token=p0.snapshot_id+'|'+p0.last_success_at;
 // a normal failure records and says so
 const normal=await WatchlistD1.recordMirror(f.db,{...target,outcome:'failed',attempts:0,nextRetryAt:'2026-11-21T09:45:00.000Z'});
 assert.deepEqual([normal.ok,normal.applied],[true,true]);assert.equal(pointer(f).mirror_attempts,1);
 // competing failed pass: another failure wins the attempts CAS after our pre-read
 state.armed=g=>g.sql("UPDATE watchlist_current SET mirror_attempts=mirror_attempts+1, mirror_next_retry_at='2026-11-21T09:50:00.000Z', revision=revision+1");
 const lost=await WatchlistD1.recordMirror(f.db,{...target,outcome:'failed',attempts:1,nextRetryAt:'2026-11-21T09:46:00.000Z'});
 assert.deepEqual([lost.ok,lost.applied,lost.reason],[true,false,'not_owed'],'the attempts compare-and-swap was lost: not recorded');assert.equal(pointer(f).mirror_attempts,2,'only the winner recorded');
 // a competing SUCCESSFUL acknowledgement lands between the pre-read and the failed batch: the failure records nothing
 state.armed=g=>g.sql("UPDATE watchlist_current SET mirror_delivered_snapshot_id='"+token+"', mirror_attempts=0, mirror_next_retry_at=NULL, revision=revision+1");
 const late=await WatchlistD1.recordMirror(f.db,{...target,outcome:'failed',attempts:2,nextRetryAt:'2026-11-21T09:47:00.000Z'});
 assert.deepEqual([late.ok,late.applied,late.reason],[true,false,'not_owed']);assert.deepEqual([pointer(f).mirror_attempts,pointer(f).mirror_next_retry_at],[0,null],'no debt on a delivered target');
 // and a duplicate success that races the same way is a no-op too
 const revisionNow=pointer(f).revision;
 const dup=await WatchlistD1.recordMirror(f.db,{...target,outcome:'delivered'});assert.deepEqual([dup.ok,dup.applied],[true,false]);assert.equal(pointer(f).revision,revisionNow);
 // the reconcile reports a failed pass as `recorded` only when the attempt was newly recorded
 f.sql("UPDATE watchlist_current SET mirror_delivered_snapshot_id=NULL, revision=revision+1");
 const bucket=store();bucket.failPut=new Error('r2 outage');
 state.armed=g=>g.sql("UPDATE watchlist_current SET mirror_delivered_snapshot_id='"+token+"', mirror_attempts=0, mirror_next_retry_at=NULL, revision=revision+1");
 const raced=await reconcile(f,bucket,'2026-11-21T09:48:00Z');
 assert.equal(raced.outcome,'failed');assert.equal(raced.recorded,false,'a competing acknowledgement won: the failure was not recorded');
}

// 8f. The affected-row decoder accepts only an explicit numeric 0 or 1: null, a string or a missing result is unproven (never coerced to 0), and the reconcile reports an unreadable acknowledgement as `uncertain`.
{
 const f=open();await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');
 const p0=pointer(f);
 const lying=value=>({prepare:f.db.prepare.bind(f.db),batch:async statements=>{const out=await f.db.batch(statements);if(statements.some(item=>/SELECT changes\(\)/.test(item.text)))out[out.length-1]={success:true,results:value===undefined?[]:[{changed:value}]};return out;}});
 for(const value of [null,'1',2,-1,undefined]){
  f.sql("UPDATE watchlist_current SET mirror_delivered_snapshot_id=NULL, mirror_attempts=0, mirror_next_retry_at=NULL, revision=revision+1");
  const r=await WatchlistD1.recordMirror(lying(value),{snapshotId:p0.snapshot_id,lastSuccessAt:p0.last_success_at,generation:1,outcome:'delivered',now:T('2026-11-21T09:41:00Z')});
  assert.deepEqual([r.ok,r.applied,r.reason],[true,null,'result_unreadable'],'changed='+String(value)+' is unproven');
 }
 f.sql("UPDATE watchlist_current SET mirror_delivered_snapshot_id=NULL, mirror_attempts=0, mirror_next_retry_at=NULL, revision=revision+1");
 const b=store();const out=await Mirror.reconcileMirror({DB:lying(null),BUCKET:b},{epoch:1,now:T('2026-11-21T09:42:00Z'),deps});
 assert.deepEqual([out.outcome,out.reason],['uncertain','ack_result_unreadable']);
}

// 9. The Letterboxd ensure: the reconcile runs BEFORE any early return on a finished slot, its failure never blocks Events or a new slot, and an absent port changes nothing.
{
 const f=open(),b=store();await scan(f,films(0,1),'2026-11-21T09:40:00.000Z');
 const env={DB:f.db,BUCKET:b,LETTERBOXD_WORKFLOW:{async create(){},async get(){throw new Error('not found');}}};
 const calls=[];
 const ports={mirror:{reconcile:async(e,arg)=>{calls.push(arg.epoch);return Mirror.reconcileMirror(e,{...arg,deps});}}};
 const ensured=await Sync.ensure(env,{now:T('2026-11-21T09:35:00Z'),ports});
 assert.deepEqual(calls,[1]);assert.equal(ensured.delivery.mirror.outcome,'written');assert.equal(ensured.started,true,'a new slot starts');
 // a throwing mirror port is reported and never blocks the tick
 const bad=await Sync.ensure(env,{now:T('2026-11-21T09:36:00Z'),ports:{mirror:{reconcile:async()=>{throw new Error('boom');}}}});
 assert.equal(bad.delivery.mirror.outcome,'unreadable');
 // no port: today's result shape
 assert.equal('mirror' in (await Sync.ensure(env,{now:T('2026-11-21T09:37:00Z')})).delivery,false);
 // a dormant mode (no row) never reconciles
 const dormant=open({mode:null});const never=[];
 await Sync.ensure({DB:dormant.db,BUCKET:store(),LETTERBOXD_WORKFLOW:env.LETTERBOXD_WORKFLOW},{now:T('2026-11-21T09:35:00Z'),ports:{mirror:{reconcile:async()=>{never.push(1);return {};}}}});
 assert.deepEqual(never,[]);
}
console.log('watchlist-mirror ok');
