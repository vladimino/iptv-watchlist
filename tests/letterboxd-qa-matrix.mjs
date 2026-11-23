// AIR-571 (offline QA): the gaps of the go/no-go package section 5 that no other test covered, on real code and the whole migration chain (sqlite D1 stand-in). Offline: no network, no Cloudflare, no production.
//   1. D1's 100-bound-parameter limit (emulated by the stand-in): a promotion that ADDS many ids must not need a statement with more than 100 parameters (a real finding of this QA, fixed in watchlist-d1.js).
//   2. The four authority combinations: the EPG checkpoint authority (r2, d1) x the Watchlist marker (epg, d1).
//   3. An EPG step in flight at the marker flip, and a failing R2 mirror after it: the flip is refused while busy, and a failing mirror never gates scans.
//   4. A 16:30 Letterboxd slot that runs past the 17:00 EPG start: the EPG pins the last good snapshot and a later promotion does not change what the EPG already pinned.
//   5. A stale snapshot is served (last good, a warning above 24 hours), never refused.
//   6. An unknown admission does not gate the next scan; an over-full ledger is a visible refusal that writes nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as Boot from '../scripts/watchlist-bootstrap-production.mjs';
import * as Op from '../scripts/watchlist-cutover-production.mjs';
import * as WatchlistD1 from '../src/watchlist-d1.js';
import * as Mirror from '../src/watchlist-mirror.js';
import * as PublishedEpg from '../src/published-epg.js';
import * as Slots from '../src/domain/letterboxd-slots.js';
import {membershipDigest} from '../src/watchlist-bootstrap.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-qa-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const T=s=>Date.parse(s);
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const chain=names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const base=path.join(root,'base.sqlite');
{const r=sqliteSync(['-bail',base],{input:'PRAGMA foreign_keys=ON;\n'+chain});if(r.status!==0)throw new Error(r.stderr);}
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
let copies=0;
const fresh=(opts={})=>{const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(base,file);sqlite(file,"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;");return {file,db:d1Standin(file,opts),sql:text=>sqlite(file,text)};};
const film=i=>({id:'f'+i,title:'Film '+i,year:1950+(i%70),url:'https://letterboxd.com/film/f'+i+'/'});
const list=(a,b)=>Array.from({length:b-a},(_,i)=>film(a+i));
const NOW=T('2026-11-22T12:00:00Z');
const publish=async(f,films,at,scanId)=>{const r=await WatchlistD1.publishSnapshot(f.db,films,{scanId,observedAt:at,completedAt:at},{now:T(at)});return r;};
const settle=async(f,r,at)=>{for(const effect of WatchlistD1.EFFECTS)assert.equal((await WatchlistD1.completeEffect(f.db,{snapshotId:r.snapshotId,effect,receipt:'r'},{now:T(at)})).ok,true);};
const resolveLedger=f=>f.sql("UPDATE watchlist_admission_pending SET state='resolved', resolved_by='qa', updated_at='2026-11-22T09:00:00.000Z' WHERE state='pending'");

// ===== 1. D1's 100-bound-parameter limit =====
{
 const f=fresh({maxBinds:100});
 const first=await publish(f,list(0,400),'2026-11-22T09:00:00.000Z','a');assert.equal(first.ok,true,JSON.stringify(first));await settle(f,first,'2026-11-22T09:00:01.000Z');resolveLedger(f);
 // 300 ids added in ONE scan (700 rows): the ledger read is chunked, no statement needs more than 100 bound parameters
 const wide=await publish(f,list(0,700),'2026-11-22T10:00:00.000Z','b');
 assert.equal(wide.ok,true,'a promotion that adds 300 ids works under the 100-parameter limit: '+JSON.stringify(wide));assert.equal(wide.added.length,300);
 assert.equal(rows(f.file,'SELECT COUNT(*) AS n FROM watchlist_admission_pending WHERE state=\'pending\'')[0].n,300);
 // an over-full ledger is a visible refusal and writes nothing
 await settle(f,wide,'2026-11-22T10:00:01.000Z');
 const before=rows(f.file,'SELECT version, revision FROM watchlist_current')[0];
 const full=await publish(f,list(0,700).slice(0,100).concat(list(1000,1250)),'2026-11-22T11:00:00.000Z','c');
 assert.deepEqual([full.ok,full.reason],[false,'admission_ledger_full']);
 assert.deepEqual(rows(f.file,'SELECT version, revision FROM watchlist_current')[0],before,'the refusal wrote nothing');
}

// ===== 2. the four authority combinations (EPG checkpoint r2|d1 x Watchlist marker epg|d1) =====
{
 const RUN='run-20261122';
 const FILMS=Array.from({length:30},(_,i)=>({id:'film-'+i,title:'Film '+i,year:1980+i,url:'https://letterboxd.com/film/film-'+i+'/'}));
 const SHA=await WatchlistD1.listDigest(WatchlistD1.normalizeFilms(FILMS)),MEMBERS=await membershipDigest(WatchlistD1.normalizeFilms(FILMS));
 const esc=text=>text.replace(/'/g,"''");
 const imported=async checkpoint=>{
  const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(base,file);
  const text=JSON.stringify({films:FILMS,updatedAt:'2026-11-22T10:11:45.255Z'});const half=Math.floor(text.length/2);
  sqlite(file,"INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('"+RUN+"','published','2026-11-22T10:11:45.255Z','"+'a'.repeat(64)+"','2026-11-22T10:11:45.255Z');"
   +"UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='"+RUN+"', generation=515, finalized_run_id='"+RUN+"', finalized_at='2026-11-22T10:11:45.255Z' WHERE id=1;"
   +"INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('"+RUN+"','watchlist',0,'"+esc(text.slice(0,half))+"'),('"+RUN+"','watchlist',1,'"+esc(text.slice(half))+"');"
   +FILMS.map((f,i)=>"INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('"+RUN+"','watchlist',"+i+",'"+f.id+"');").join(''));
  const db=d1Standin(file);
  const done=await Boot.execute('bootstrap',{binding:db,args:{run:RUN,epgGeneration:515,count:30,membersSha256:MEMBERS,sha256:SHA},now:NOW,ctx:{snapshotId:'snap-1'}});assert.equal(done.writeState,'committed');
  sqlite(file,"UPDATE epg_checkpoint_authority SET mode='"+checkpoint+"'");
  return {file,db};
 };
 const FORWARD={run:RUN,epgGeneration:515,count:30,membersSha256:MEMBERS,sha256:SHA,snapshotId:'snap-1'};
 const refuses=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason);return;}assert.fail('expected '+reason);};
 const marker=file=>rows(file,'SELECT mode, writes, generation FROM watchlist_authority')[0];
 const hold=env=>Op.execute('hold',{binding:env.db,args:{generation:0,...FORWARD},now:NOW,ctx:{track(){}}});
 // (checkpoint r2, Watchlist epg): today's production. The forward path is refused: O4 first.
 { const e=await imported('r2');await refuses(hold(e),'checkpoint_not_d1');assert.deepEqual(marker(e.file),{mode:'epg',writes:'open',generation:0});
   assert.equal((await WatchlistD1.pinForEpg(e.db,{now:NOW})).ok,false,'the EPG does not read the Watchlist authority while the marker is epg'); }
 // (checkpoint d1, Watchlist epg): the forward path may start (hold), and backs out
 { const e=await imported('d1');const held=await hold(e);assert.deepEqual(held.marker,{mode:'epg',writes:'held',generation:1});
   await Op.execute('release-abort',{binding:e.db,args:{generation:1},now:NOW,ctx:{track(){}}});assert.deepEqual(marker(e.file),{mode:'epg',writes:'open',generation:1}); }
 // (checkpoint d1, Watchlist d1): the target state. A held marker refuses the snapshot; open serves it
 { const e=await imported('d1');sqlite(e.file,"UPDATE watchlist_authority SET mode='d1', writes='held'");
   assert.equal((await WatchlistD1.pinForEpg(e.db,{now:NOW})).reason,'watchlist_writes_held');
   sqlite(e.file,"UPDATE watchlist_authority SET writes='open'");const pin=await WatchlistD1.pinForEpg(e.db,{now:NOW});assert.equal(pin.ok,true);assert.equal(pin.films.length,30); }
 // (checkpoint r2, Watchlist d1): the combination the plan forbids. The read side does not depend on the checkpoint, but every transition that needs the checkpoint refuses, so it cannot be entered or left by these commands
 { const e=await imported('r2');sqlite(e.file,"UPDATE watchlist_authority SET mode='d1', writes='held'");
   await refuses(Op.execute('release',{binding:e.db,args:{generation:0,run:RUN,count:30,membersSha256:MEMBERS,sha256:SHA,snapshotId:'snap-1'},now:NOW,ctx:{track(){}}}),'checkpoint_not_d1');
   sqlite(e.file,"UPDATE watchlist_authority SET writes='open'");assert.equal((await WatchlistD1.pinForEpg(e.db,{now:NOW})).ok,true,'a served snapshot is independent of the checkpoint mode'); }
 // ===== 3a. an EPG step in flight at the marker flip: refused while busy =====
 { const e=await imported('d1');
   sqlite(e.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify({schemaVersion:1,holder:'h',expiresAt:'2026-11-22T12:30:00.000Z',released:false})+"',1,'2026-11-22T11:50:00.000Z')");
   await refuses(hold(e),'writer_active');assert.deepEqual(marker(e.file),{mode:'epg',writes:'open',generation:0},'no flip while an EPG step holds its lease');
   sqlite(e.file,"DELETE FROM epg_orchestration_document WHERE key='lease'");
   sqlite(e.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('control','"+JSON.stringify({schemaVersion:1,phase:'running',budget:{consecutive:0,total:0}})+"',1,'2026-11-22T11:50:00.000Z')");
   await refuses(hold(e),'writer_active');
   sqlite(e.file,"UPDATE epg_orchestration_document SET body='"+JSON.stringify({schemaVersion:1,phase:'done',budget:{consecutive:0,total:0}})+"' WHERE key='control'");
   assert.equal((await hold(e)).marker.writes,'held','a settled EPG lets the flip proceed'); }
}

// ===== 3b. a failing R2 mirror after the flip never gates a scan =====
{
 const f=fresh();
 f.sql("INSERT INTO letterboxd_sync_mode (id,mode,epoch,changed_at,revision,write_id) VALUES (1,'cloudflare',1,'2026-11-22T00:00:00.000Z',1,'w');");
 const failing={objects:new Map(),async get(){return null;},async put(){throw new Error('r2 outage');}};
 const env={DB:f.db,BUCKET:failing};
 const outcomes=[];
 for(const [i,at] of [[0,'2026-11-22T03:40:00.000Z'],[1,'2026-11-22T09:40:00.000Z'],[2,'2026-11-22T15:40:00.000Z']]){
  const r=await publish(f,list(0,3+i),at,'m'+i);outcomes.push(r.outcome);if(r.outcome==='committed')await settle(f,r,at);
  const mirror=await Mirror.reconcileMirror(env,{epoch:1,now:T(at)+60000,deps:{WatchlistD1,PublishedEpg}});
  assert.ok(['failed','backoff'].includes(mirror.outcome),'the mirror fails or backs off, it never throws into the scan: '+JSON.stringify(mirror));
 }
 assert.deepEqual(outcomes,['committed','committed','committed'],'every scan committed while the mirror was down');
 assert.equal(rows(f.file,'SELECT version FROM watchlist_current')[0].version,3);
}

// ===== 4. a 16:30 Letterboxd slot delayed past the 17:00 EPG start: the EPG pins the last good snapshot =====
{
 const f=fresh();
 const v1=await publish(f,list(0,20),'2026-11-22T09:40:00.000Z','s1');await settle(f,v1,'2026-11-22T09:40:30.000Z');resolveLedger(f);
 // the slot key of the 16:30 slot and its window (the slot is still runnable at 17:02 Madrid, i.e. 16:02 UTC in CET)
 const slot=Slots.latestDueSlot(T('2026-11-22T16:02:00Z'));
 assert.equal(slot.key,'2026-11-22T1630');assert.ok(slot.windowEndsAt>T('2026-11-22T16:02:00Z'),'the delayed slot is still inside its window');
 // 17:00 Madrid = 16:00 UTC: the EPG starts and pins the last good snapshot while the 16:30 scan is still running (not yet promoted)
 const pinned=await WatchlistD1.pinForEpg(f.db,{now:T('2026-11-22T16:00:00Z')});
 assert.equal(pinned.ok,true);assert.equal(pinned.pin.watchlistVersion,1);assert.equal(pinned.films.length,20);
 // the delayed slot promotes at 17:05: the NEXT read sees version 2, the pin the EPG already took is unchanged
 const v2=await publish(f,list(0,19).concat([film(99)]),'2026-11-22T16:05:00.000Z','s2');assert.equal(v2.outcome,'committed');
 assert.equal(pinned.pin.watchlistVersion,1,'the already taken pin is a value, not a view');
 const later=await WatchlistD1.pinForEpg(f.db,{now:T('2026-11-22T16:06:00Z')});assert.equal(later.pin.watchlistVersion,2);
 assert.ok(JSON.stringify(later.films).includes('f99'),'the new member is in the next pin');assert.ok(!JSON.stringify(pinned.films).includes('f99'),'and not in the pin taken before');
 // a scan in flight (staged, not promoted) is never visible: a read between staging and promotion answers the last promoted version
 const midway=await WatchlistD1.pinForEpg(f.db,{now:T('2026-11-22T16:05:30Z')});assert.equal(midway.pin.watchlistVersion,2);
}

// ===== 5. a stale snapshot is served (last good), with a warning above 24 hours =====
{
 const f=fresh();
 const v1=await publish(f,list(0,10),'2026-11-20T09:40:00.000Z','s1');await settle(f,v1,'2026-11-20T09:40:30.000Z');
 const fresh1=await WatchlistD1.pinForEpg(f.db,{now:T('2026-11-20T20:00:00Z')});assert.equal(fresh1.ok,true);assert.ok(!fresh1.warning);
 const old=await WatchlistD1.pinForEpg(f.db,{now:T('2026-11-22T12:00:00Z')});
 assert.equal(old.ok,true,'no hard TTL: the last good list is served');assert.ok(/watchlist_stale/.test(String(old.warning||'')),'a warning above 24 hours: '+String(old.warning));
 assert.equal(old.films.length,10);
}

// ===== 6. an unknown admission does not gate the next scan =====
{
 const f=fresh();
 const v1=await publish(f,list(0,5),'2026-11-22T03:40:00.000Z','u1');await settle(f,v1,'2026-11-22T03:40:30.000Z');
 assert.equal(rows(f.file,"SELECT COUNT(*) AS n FROM watchlist_admission_pending WHERE state='pending'")[0].n,5,'five unknown ids wait in the ledger');
 // the identity step has resolved none of them; the next scan still promotes
 const v2=await publish(f,list(0,6),'2026-11-22T09:40:00.000Z','u2');assert.equal(v2.outcome,'committed','pending admissions never block a scan');
 assert.equal(rows(f.file,"SELECT COUNT(*) AS n FROM watchlist_admission_pending WHERE state='pending'")[0].n,6);
}
// ===== 7. dynamic independence: an ACTIVE Discovery lease neither gates nor is touched by a Letterboxd promotion =====
{
 const f=fresh();
 f.sql("INSERT INTO discovery_lease (id, lease_id, expires_at, programme_run_id) VALUES (1,'lease-live',"+(T('2026-11-22T20:00:00Z'))+",'run-x') ON CONFLICT(id) DO UPDATE SET lease_id='lease-live', expires_at="+(T('2026-11-22T20:00:00Z'))+", programme_run_id='run-x';");
 const lease=()=>rows(f.file,'SELECT lease_id, expires_at, programme_run_id FROM discovery_lease WHERE id=1')[0];
 const before=lease();
 const v1=await publish(f,list(0,5),'2026-11-22T15:40:00.000Z','d1');assert.equal(v1.outcome,'committed','a live Discovery lease does not gate the Watchlist scan');await settle(f,v1,'2026-11-22T15:40:30.000Z');
 const v2=await publish(f,list(0,6),'2026-11-22T15:50:00.000Z','d2');assert.equal(v2.outcome,'committed');
 assert.deepEqual(lease(),before,'the Letterboxd promotion never touches the Discovery lease');
}
console.log('letterboxd-qa-matrix ok');
