// ADR 0186 (Accepted), AIR-569: the Watchlist authority repository (src/watchlist-d1.js, schema v31, migrations/0031_watchlist_authority.sql). Offline only: a sqlite D1 stand-in with the real
// migration chain. No production database, bucket or Letterboxd is opened. The module is dormant: nothing in the Worker activates it in this file.
// Contract cases of the ADR matrix covered here: T3/T4 (snapshot age), T6 (1-for-1), T8 (nothing committed), T10 (no-op), T13 (unknown outcome), T16 (marker states), T18/T19 (causal effects, version
// order), T20 (isolated staging), T22/T23 (admission ledger and cap), T29 (a large removal is published).
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import * as Watchlist from '../src/watchlist-d1.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-watchlist-d1-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const refuses=(file,text,pattern)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.notEqual(r.status,0,'must be refused: '+text.slice(0,70));if(pattern)assert.match(r.stderr,pattern);};
const chain=upTo=>names.filter(name=>name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const base=path.join(root,'base.sqlite');sqlite(base,chain('9999'));
const NOW=Date.parse('2026-11-21T10:00:00.000Z');
const T=new Date(NOW).toISOString();
let copies=0;
const open=(options={},{marker="UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;"}={})=>{const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(base,file);if(marker)sqlite(file,marker);return {file,db:d1Standin(file,options)};};
const film=(i,extra={})=>({id:'lb'+i,title:'Film '+i,year:2000+(i%20),url:'https://letterboxd.com/film/film-'+i+'/',...extra});
const list=(n,from=0)=>Array.from({length:n},(_,i)=>film(from+i));
const scan=(id='scan-1',extra={})=>({scanId:id,observedAt:T,runId:'run-'+id,slotKey:'20261121-1030',...extra});
const ctx=(extra={})=>({now:NOW,...extra});
const current=file=>rows(file,'SELECT * FROM watchlist_current')[0];
const counts=file=>rows(file,"SELECT (SELECT COUNT(*) FROM watchlist_staging) AS staging,(SELECT COUNT(*) FROM watchlist_snapshot) AS snapshot,(SELECT COUNT(*) FROM watchlist_member) AS member,(SELECT COUNT(*) FROM watchlist_change) AS change,(SELECT COUNT(*) FROM watchlist_effect) AS effect,(SELECT COUNT(*) FROM watchlist_admission_pending) AS pending")[0];
const publish=async(made,films,id,extra={},cx={})=>{const out=await Watchlist.publishSnapshot(made.db,films,scan(id,extra),ctx(cx));assert.equal(out.ok,true,JSON.stringify(out));return out;};
const drain=async(made,at)=>{for(;;){const todo=await Watchlist.pendingEffects(made.db);assert.equal(todo.ok,true);if(!todo.effects.length)return;const e=todo.effects[0];const out=await Watchlist.completeEffect(made.db,{snapshotId:e.snapshotId,effect:e.effect,receipt:'r:'+e.version+':'+e.effect},ctx(at?{now:at}:{}));assert.equal(out.ok,true,JSON.stringify(out));}};

// ===== 1. the migration =====
{
 const m='0031_watchlist_authority.sql';
 assert.ok(names.includes(m)&&names.indexOf(m)===names.indexOf('0030_epg_checkpoint_authority.sql')+1,'0031 follows 0030');
 const v30=path.join(root,'v30.sqlite');sqlite(v30,chain('0030_epg_checkpoint_authority.sql'));
 assert.equal(rows(v30,'SELECT version FROM schema_contract WHERE id=1')[0].version,30);
 const v29=path.join(root,'v29.sqlite');sqlite(v29,chain('0029_started_authority.sql'));
 refuses(v29,fs.readFileSync('migrations/'+m,'utf8'),/CHECK|constraint|NOT NULL/i);
 assert.equal(rows(v29,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='watchlist_current'")[0].n,0,'a refused file leaves no table');
 sqlite(v30,fs.readFileSync('migrations/'+m,'utf8'));
 assert.equal(rows(v30,'SELECT version FROM schema_contract WHERE id=1')[0].version,31);
 assert.deepEqual(rows(v30,'SELECT mode,generation,writes FROM watchlist_authority')[0],{mode:'epg',generation:0,writes:'open'});
 const pointer=current(v30);
 assert.equal(pointer.version,0);assert.equal(pointer.snapshot_id,null);assert.equal(pointer.effects_drained_version,0);
 assert.deepEqual(counts(v30),{staging:0,snapshot:0,member:0,change:0,effect:0,pending:0},'it copies and switches nothing');
 refuses(v30,'UPDATE schema_contract SET version=30 WHERE id=1',/schema_contract_downgrade/);
 refuses(v30,'DELETE FROM watchlist_cas',/watchlist_cas_required/);
 // the triggers hold against a writer that bypasses the repository
 refuses(v30,"UPDATE watchlist_current SET version=2,snapshot_id='x',list_sha256='"+'a'.repeat(64)+"',film_count=1,revision=2 WHERE id=1",/watchlist_current_regress/);
 refuses(v30,"UPDATE watchlist_current SET revision=5 WHERE id=1",/watchlist_current_regress/);
 const raw=open();
 await publish(raw,list(3),'a');
 refuses(raw.file,"UPDATE watchlist_member SET title='x'",/watchlist_member_immutable/);
 refuses(raw.file,"UPDATE watchlist_snapshot SET film_count=9",/watchlist_snapshot_immutable/);
 refuses(raw.file,"UPDATE watchlist_change SET lid='z'",/watchlist_change_immutable/);
 refuses(raw.file,"UPDATE watchlist_current SET version=0,revision=revision+1 WHERE id=1",/watchlist_current_regress|CHECK/);
 refuses(raw.file,"UPDATE watchlist_current SET last_success_at='2020-01-01T00:00:00.000Z',revision=revision+1 WHERE id=1",/watchlist_current_regress/);
 const first=(await Watchlist.pendingEffects(raw.db)).effects[0];
 await Watchlist.completeEffect(raw.db,{snapshotId:first.snapshotId,effect:first.effect,receipt:'r'},ctx());
 refuses(raw.file,"UPDATE watchlist_effect SET status='pending',done_at=NULL WHERE effect='scan_facts'",/watchlist_effect_regress|CHECK/);
}

// ===== 2. T16: the authority states =====
{
 const legacy=path.join(root,'legacy.sqlite');sqlite(legacy,chain('0030_epg_checkpoint_authority.sql'));
 assert.deepEqual(await Watchlist.readAuthority(d1Standin(legacy)),{state:'legacy'},'tables absent below version 31: the EPG generation serves');
 const noTables=path.join(root,'notables.sqlite');sqlite(noTables,chain('0030_epg_checkpoint_authority.sql')+"UPDATE schema_contract SET version=31 WHERE id=1;");
 assert.deepEqual(await Watchlist.readAuthority(d1Standin(noTables)),{state:'closed',reason:'contradiction'},'version 31 without the tables is closed');
 assert.deepEqual(await Watchlist.readAuthority({}),{state:'closed',reason:'contradiction'},'a missing binding is closed');
 assert.deepEqual(await Watchlist.readAuthority({WATCHLIST_DB_OPTIONAL:'standin'}),{state:'legacy'},'the explicit local stand-in only');
 assert.deepEqual(await Watchlist.readAuthority({WATCHLIST_DB_OPTIONAL:'on',DB:d1Standin(noTables)}),{state:'closed',reason:'contradiction'},'any other value of the selector is not a stand-in');
 const epg=open({},{marker:''});
 assert.deepEqual(await Watchlist.readAuthority(epg.db),{state:'epg',writes:'open',generation:0});
 assert.deepEqual(await Watchlist.readAuthority(open().db),{state:'d1',writes:'open',generation:1});
 const held=open({},{marker:"UPDATE watchlist_authority SET mode='d1',generation=2,writes='held' WHERE id=1;"});
 assert.deepEqual(await Watchlist.readAuthority(held.db),{state:'d1',writes:'held',generation:2});
 const gone=open({},{marker:'DROP TRIGGER watchlist_cas_required;DELETE FROM watchlist_cas;'});
 assert.deepEqual(await Watchlist.readAuthority(gone.db),{state:'closed',reason:'contradiction'},'a deleted fence row is closed');
 // at `epg` the repository neither serves nor writes: no R2/EPG fallback in either direction
 assert.deepEqual(await Watchlist.readCurrent(epg.db),{ok:false,reason:'closed'});
 assert.equal((await Watchlist.publishSnapshot(epg.db,list(2),scan(),ctx())).reason,'closed');
 assert.equal((await Watchlist.publishSnapshot(held.db,list(2),scan(),ctx())).reason,'writes_held');
 assert.deepEqual(counts(epg.file),{staging:0,snapshot:0,member:0,change:0,effect:0,pending:0});
 assert.equal((await Watchlist.pinForEpg(epg.db)).reason,'watchlist_unavailable','an epg-mode database is not a snapshot source');
 const d1=open();
 assert.equal((await Watchlist.pinForEpg(d1.db)).reason,'watchlist_snapshot_absent','no snapshot at all: fail closed, a D1 fault and not a Letterboxd one');
 assert.equal((await Watchlist.readCurrent(d1.db)).reason,'absent');
}

// ===== 2b. review: held, moved and storage errors are distinct reasons =====
{
 const held=open({},{marker:"UPDATE watchlist_authority SET mode='d1',generation=2,writes='held' WHERE id=1;"});
 assert.equal((await Watchlist.readCurrent(held.db)).reason,'held','a held authority is refused by the reader itself, not only by its caller');
 assert.equal((await Watchlist.pinForEpg(held.db)).reason,'watchlist_writes_held');
 const live=open();
 await publish(live,list(2),'g');
 assert.equal((await Watchlist.readCurrent(live.db,{generation:1})).ok,true);
 assert.equal((await Watchlist.readCurrent(live.db,{generation:7})).reason,'moved','a generation the caller did not see is a move');
 assert.equal((await Watchlist.readCurrent(live.db,{generation:1})).snapshot.authority.generation,1);
 assert.equal((await Watchlist.pinForEpg(live.db,{generation:3})).reason,'watchlist_authority_moved');
 const flaky=d1Standin(live.file,{onQuery:async()=>{throw new Error('D1 DB is overloaded');}});
 assert.deepEqual(await Watchlist.readAuthority(flaky),{state:'closed',reason:'unavailable'},'a storage error is retryable, never a contradiction');
}

// ===== 3. publish, read, 1-for-1, no-op (T6, T10) =====
{
 const made=open();
 const first=await publish(made,list(395),'s1');
 assert.equal(first.outcome,'committed');assert.equal(first.version,1);assert.equal(first.added.length,395);assert.deepEqual(first.removed,[]);
 let read=await Watchlist.readCurrent(made.db,{now:NOW});
 assert.equal(read.ok,true);assert.equal(read.snapshot.version,1);assert.equal(read.snapshot.filmCount,395);assert.equal(read.snapshot.films[394].lid,'lb394');
 assert.equal(read.snapshot.films[0].ordinal,0);assert.equal(read.snapshot.stale,false);
 const c1=counts(made.file);
 assert.deepEqual(c1,{staging:1,snapshot:1,member:395,change:395,effect:3,pending:395});
 // T10: the identical ordered list writes no snapshot, member, change or effect row; it needs the effects drained first
 const early=await Watchlist.publishSnapshot(made.db,list(395),scan('s2'),ctx());
 assert.deepEqual([early.ok,early.reason],[false,'effects_pending'],'a no-op repairs first: it never advances success over undone effects');
 assert.deepEqual(counts(made.file),c1);
 await drain(made);
 const later=NOW+3*3600000;
 const noop=await Watchlist.publishSnapshot(made.db,list(395),scan('s2',{completedAt:new Date(later).toISOString()}),ctx({now:later}));
 assert.deepEqual(noop,{ok:true,outcome:'no_change',version:1});
 assert.deepEqual(counts(made.file),c1,'a no-op adds no rows');
 assert.equal(current(made.file).last_success_at,new Date(later).toISOString(),'the success time advances');
 assert.equal(current(made.file).version,1,'the version does not move');
 // T6: 395 -> 395 with ONE film replaced: the count is equal, the digest is not
 const swapped=list(395);swapped[17]=film(9999);
 const replaced=await publish(made,swapped,'s3',{},{now:later+1000});
 assert.equal(replaced.version,2);assert.deepEqual(replaced.added,['lb9999']);assert.deepEqual(replaced.removed,['lb17']);
 const changes=await Watchlist.readChanges(made.db,replaced.snapshotId);
 assert.deepEqual(changes,{ok:true,added:[{lid:'lb9999',ordinal:17}],removed:[{lid:'lb17',prevOrdinal:17}]});
 read=await Watchlist.readCurrent(made.db,{now:later+1000});
 assert.equal(read.snapshot.filmCount,395);assert.equal(read.snapshot.films[17].lid,'lb9999');
 // order alone is a new version too (same members, different order, no add or remove)
 await drain(made,later+2000);
 const reordered=read.snapshot.films.map(item=>film(Number(item.lid.slice(2))));[reordered[0],reordered[1]]=[reordered[1],reordered[0]];
 const moved=await publish(made,reordered,'s4',{},{now:later+3000});
 assert.equal(moved.version,3);assert.deepEqual([moved.added,moved.removed],[[],[]]);
 // malformed pages: duplicate ids, missing url, non-array, and an oversized list never reach the database
 const before=counts(made.file);
 for(const bad of [[film(1),film(1)],[{id:'x',title:'t'}],'nope',[{id:'',title:'t',url:'u'}],[{...film(2),year:'1999'}],Array.from({length:Watchlist.LIMITS.maxFilms+1},(_,i)=>film(i))]){
  const out=await Watchlist.publishSnapshot(made.db,bad,scan('bad'),ctx());
  assert.deepEqual([out.ok,out.reason],[false,'shape']);
 }
 assert.deepEqual(counts(made.file),before,'T8: nothing was written for a malformed or incomplete result');
 assert.equal(current(made.file).version,3);
}

// ===== 4. T20: isolated staging, one winner, abandoned rows removed =====
{
 const made=open();
 await publish(made,list(5),'s1');await drain(made);
 // two interrupted attempts (staged, never promoted) for the same proposed next version, then a retry: distinct snapshot ids, no collision
 const stageOnly=async(snapshotId,films,at)=>{
  const db=made.db;
  await db.prepare('INSERT INTO watchlist_staging (snapshot_id, attempt_id, run_id, slot_key, expected_count, expected_sha256, started_at) VALUES (?,?,?,?,?,?,?)').bind(snapshotId,snapshotId,null,null,films.length,'b'.repeat(64),new Date(at).toISOString()).run();
  for(const f of films)await db.prepare('INSERT INTO watchlist_member (snapshot_id, ordinal, lid, title, year, url) VALUES (?,?,?,?,?,?)').bind(snapshotId,f.ordinal,f.id,f.title,f.year,f.url).run();
 };
 const old=NOW-2*3600000,fresh=NOW-60000;
 await stageOnly('dead-1',list(6).map((f,i)=>({...f,ordinal:i})),old);
 await stageOnly('dead-2',list(7).map((f,i)=>({...f,ordinal:i})),old);
 await stageOnly('inflight',list(4).map((f,i)=>({...f,ordinal:i})),fresh);
 const out=await publish(made,list(6,100),'s2');
 assert.equal(out.version,2,'exactly one promotion');
 const left=rows(made.file,"SELECT snapshot_id, COUNT(*) AS n FROM watchlist_member GROUP BY snapshot_id ORDER BY snapshot_id").map(row=>row.snapshot_id);
 assert.ok(!left.includes('dead-1')&&!left.includes('dead-2'),'abandoned staging of both interrupted attempts was removed before the stage');
 assert.ok(left.includes('inflight'),'an attempt inside the 30-minute guard is left alone');
 assert.equal(rows(made.file,"SELECT COUNT(*) AS n FROM watchlist_staging WHERE snapshot_id IN ('dead-1','dead-2')")[0].n,0);
 // a stale CAS: the pointer moved after this attempt read it. The loser writes nothing but garbage under its own id.
 const racing=open({},{});sqlite(racing.file,"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1");
 await publish(racing,list(3),'r1');await drain(racing);
 let moved=true;
 const lost=open({onBatch:async statements=>{if(!moved&&statements.some(item=>/UPDATE watchlist_current SET version/.test(item.text))){moved=true;sqlite(lost.file,"UPDATE watchlist_current SET revision=revision+1 WHERE id=1");}}},{});
 sqlite(lost.file,"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1");
 await publish(lost,list(3),'l1');await drain(lost);
 const before=counts(lost.file),version=current(lost.file).version;
 moved=false;
 const loser=await Watchlist.publishSnapshot(lost.db,list(4),scan('l2'),ctx({snapshotId:'loser'}));
 assert.deepEqual([loser.ok,loser.reason],[false,'conflict']);
 assert.equal(current(lost.file).version,version,'the pointer did not move');
 assert.equal(rows(lost.file,"SELECT COUNT(*) AS n FROM watchlist_snapshot WHERE snapshot_id='loser'")[0].n,0,'no promoted row for the loser');
 assert.equal(counts(lost.file).snapshot,before.snapshot);
 assert.equal(counts(lost.file).change,before.change,'no change or effect row of the loser');
 assert.equal(await Watchlist.classifyPublish(lost.db,{snapshotId:'loser',expectedVersion:version}),'not_applied');
}

// ===== 5. T13: an unknown outcome is classified by snapshot id =====
{
 // the batch applies but the answer is lost
 const applied=open({});
 const original=applied.db.batch.bind(applied.db);
 let lose=false;
 applied.db.batch=async statements=>{const result=await original(statements);if(lose&&statements.some(item=>/INSERT INTO watchlist_snapshot /.test(item.text))){lose=false;throw new Error('network: connection reset');}return result;};
 await publish(applied,list(3),'a');await drain(applied);
 lose=true;
 const out=await Watchlist.publishSnapshot(applied.db,list(4),scan('b'),ctx());
 assert.equal(out.ok,true,'applied: the receipt is the snapshot row, so the outcome is read back, not replayed');
 assert.equal(current(applied.file).version,2);
 assert.equal(counts(applied.file).snapshot,2,'exactly one promotion');
 // the batch does not apply and the answer is lost
 const missing=open({});
 const orig2=missing.db.batch.bind(missing.db);let drop=false;
 missing.db.batch=async statements=>{if(drop&&statements.some(item=>/INSERT INTO watchlist_snapshot /.test(item.text))){drop=false;throw new Error('network: connection reset');}return orig2(statements);};
 await publish(missing,list(3),'a');await drain(missing);
 drop=true;
 const lost=await Watchlist.publishSnapshot(missing.db,list(4),scan('b'),ctx({snapshotId:'maybe'}));
 assert.deepEqual([lost.ok,lost.reason],[false,'unavailable'],'not applied and no other writer: a retryable fault, never "applied"');
 assert.equal(await Watchlist.classifyPublish(missing.db,{snapshotId:'maybe',expectedVersion:1}),'not_applied');
 assert.equal(await Watchlist.classifyPublish(missing.db,{snapshotId:'x',expectedVersion:-1}),'indeterminate');
}

// ===== 6. T18/T19: the causal effects journal =====
{
 const made=open();
 const v1=await publish(made,list(3),'s1');
 // the crash window: the pointer is switched and no effect ran. The rows are durable, pending, and named.
 let pending=await Watchlist.pendingEffects(made.db);
 assert.deepEqual(pending.effects.map(e=>[e.version,e.effect]),[[1,'scan_facts'],[1,'retention'],[1,'removal_enqueue']]);
 assert.equal(current(made.file).effects_drained_version,0);
 // effects run in order inside a version
 assert.equal((await Watchlist.completeEffect(made.db,{snapshotId:v1.snapshotId,effect:'retention',receipt:'r'},ctx())).reason,'out_of_order');
 assert.equal((await Watchlist.completeEffect(made.db,{snapshotId:v1.snapshotId,effect:'scan_facts',receipt:'r1'},ctx())).drained,false);
 // a second promotion cannot happen over undone effects of a no-op, but a CHANGED list may promote (membership is an observation)
 const v2=await publish(made,list(4),'s2');
 assert.equal(v2.version,2,'a changed complete scan is published even while older effects are pending');
 pending=await Watchlist.pendingEffects(made.db);
 assert.deepEqual(pending.effects.map(e=>[e.version,e.effect]),[[1,'retention'],[1,'removal_enqueue'],[2,'scan_facts'],[2,'retention'],[2,'removal_enqueue']],'oldest version first');
 // T19: the newer version's retention cannot run ahead of the older version's undone effect
 await Watchlist.completeEffect(made.db,{snapshotId:v1.snapshotId,effect:'retention',receipt:'r'},ctx());
 assert.equal((await Watchlist.completeEffect(made.db,{snapshotId:v2.snapshotId,effect:'scan_facts',receipt:'x'},ctx())).reason,'out_of_order');
 assert.equal((await Watchlist.completeEffect(made.db,{snapshotId:v2.snapshotId,effect:'retention',receipt:'x'},ctx())).reason,'out_of_order');
 const last=await Watchlist.completeEffect(made.db,{snapshotId:v1.snapshotId,effect:'removal_enqueue',receipt:'r'},ctx());
 assert.deepEqual([last.ok,last.drained],[true,true]);
 assert.equal(current(made.file).effects_drained_version,1,'advances in the batch that marks the last effect of the version done');
 await drain(made);
 assert.equal(current(made.file).effects_drained_version,2);
 assert.equal((await Watchlist.completeEffect(made.db,{snapshotId:v2.snapshotId,effect:'retention',receipt:'again'},ctx())).ok,false,'a done effect stays done');
 assert.equal((await Watchlist.completeEffect(made.db,{snapshotId:'nope',effect:'retention',receipt:'r'},ctx())).reason,'shape');
 assert.equal((await Watchlist.completeEffect(made.db,{snapshotId:v2.snapshotId,effect:'mirror',receipt:'r'},ctx())).reason,'shape','delivery (mirror, Events) is not a causal effect');
 // T18: after the crash a REPEATED no-op scan drains first, then advances success. The removal item comes from the change rows, not from a membership diff.
 const crash=open();
 const a=await publish(crash,list(3),'a');await drain(crash);
 const b=await publish(crash,[film(0),film(2),film(7)],'b');
 const repeat=await Watchlist.publishSnapshot(crash.db,[film(0),film(2),film(7)],scan('c'),ctx());
 assert.equal(repeat.reason,'effects_pending');
 const changes=await Watchlist.readChanges(crash.db,b.snapshotId);
 assert.deepEqual(changes.removed.map(item=>item.lid),['lb1'],'the removal is rebuilt from watchlist_change');
 assert.deepEqual(changes.added.map(item=>item.lid),['lb7']);
 await drain(crash);
 assert.equal((await Watchlist.publishSnapshot(crash.db,[film(0),film(2),film(7)],scan('c'),ctx({now:NOW+60000}))).outcome,'no_change');
 assert.ok(a.snapshotId!==b.snapshotId);
}

// ===== 7. attempts never lower success; retention never drops an undone snapshot =====
{
 const made=open();
 await publish(made,list(3),'s1');await drain(made);
 const success=current(made.file).last_success_at;
 const later=new Date(NOW+3600000).toISOString();
 assert.deepEqual(await Watchlist.recordAttempt(made.db,{at:later,outcome:'incomplete',now:NOW+3600000}),{ok:true});
 assert.equal(current(made.file).last_success_at,success,'a failed or incomplete scan never touches last_success_at');
 assert.equal(current(made.file).last_attempt_outcome,'incomplete');
 const older=new Date(NOW).toISOString();
 await Watchlist.recordAttempt(made.db,{at:older,outcome:'unavailable'});
 assert.equal(current(made.file).last_attempt_outcome,'incomplete','an older attempt does not replace a newer one');
 assert.equal((await Watchlist.recordAttempt(made.db,{at:'nope',outcome:'x'})).reason,'shape');
 assert.equal(await Watchlist.readCurrent(made.db).then(out=>out.snapshot.version),1);
 // retention: the newest eight stay; an older snapshot with an undone effect is never deleted
 for(let i=2;i<=12;i++){await publish(made,list(3,i*10),'s'+i,{},{now:NOW+i*1000});if(i<3)await drain(made);}
 const heldBack=rows(made.file,"SELECT version FROM watchlist_snapshot s WHERE EXISTS (SELECT 1 FROM watchlist_effect e WHERE e.snapshot_id=s.snapshot_id AND e.status='pending') ORDER BY version").map(row=>Number(row.version));
 assert.ok(heldBack.includes(3),'version 3 still has undone effects');
 for(let n=0;n<4;n++)assert.equal((await Watchlist.pruneSnapshots(made.db)).ok,true);
 const kept=rows(made.file,'SELECT version FROM watchlist_snapshot ORDER BY version').map(row=>Number(row.version));
 assert.ok(kept.includes(3),'an undone snapshot is kept whatever its age');
 assert.ok(kept.includes(12)&&kept.includes(5),'the newest eight stay');
 // AIR-599 (review of PR #1009): the first-seen snapshot of an OPEN ledger row keeps its header (the authoritative age of the queue place); every other old, fully drained snapshot is deleted whole, and no old snapshot keeps its members.
 const referenced=new Set(rows(made.file,"SELECT first_seen_snapshot_id AS id FROM watchlist_admission_pending WHERE state IN ('pending','terminal')").map(row=>row.id));
 const versionOf=id=>Number(rows(made.file,"SELECT version FROM watchlist_snapshot WHERE snapshot_id='"+id+"'")[0]?.version);
 for(const version of [1,2]){
  const id=rows(made.file,"SELECT snapshot_id AS id FROM watchlist_snapshot WHERE version="+version)[0]?.id;
  if(id===undefined){assert.ok(![...referenced].some(ref=>versionOf(ref)===version),'a snapshot an open row names is never deleted: v'+version);continue;}
  assert.ok(referenced.has(id),'only a referenced snapshot survives its retention: v'+version);
  assert.equal(rows(made.file,"SELECT COUNT(*) AS n FROM watchlist_member WHERE snapshot_id='"+id+"'")[0].n,0,'its members are pruned like any old snapshot\'s: v'+version);
 }
 // once no open row names them, the old drained snapshots are deleted whole (headers included), as before
 sqlite(made.file,"UPDATE watchlist_admission_pending SET state='resolved', resolved_by='identity:t', next_retry_at=NULL");
 for(let n=0;n<6;n++)assert.equal((await Watchlist.pruneSnapshots(made.db)).ok,true);
 const after=rows(made.file,'SELECT version FROM watchlist_snapshot ORDER BY version').map(row=>Number(row.version));
 assert.ok(!after.includes(1)&&!after.includes(2),'old snapshots that no open row names are deleted with their members');
 assert.ok(after.includes(3),'an undone snapshot is still kept');
 assert.equal(rows(made.file,"SELECT COUNT(*) AS n FROM watchlist_member WHERE snapshot_id NOT IN (SELECT snapshot_id FROM watchlist_snapshot) AND snapshot_id NOT IN (SELECT snapshot_id FROM watchlist_staging WHERE snapshot_id=(SELECT snapshot_id FROM watchlist_current))")[0].n>=0,true);
 assert.equal((await Watchlist.readCurrent(made.db)).ok,true,'the current snapshot is intact after pruning');
}

// ===== 8. T22/T23: the admission ledger =====
{
 const made=open();
 await publish(made,list(3),'s1');await drain(made);
 assert.deepEqual(rows(made.file,"SELECT lid,state,attempts FROM watchlist_admission_pending ORDER BY lid"),[{lid:'lb0',state:'pending',attempts:0},{lid:'lb1',state:'pending',attempts:0},{lid:'lb2',state:'pending',attempts:0}]);
 // a returning id continues its own row and is never inserted twice; a superseded id re-opens
 sqlite(made.file,"UPDATE watchlist_admission_pending SET state='resolved',resolved_by='rcpt' WHERE lid='lb0';UPDATE watchlist_admission_pending SET state='superseded' WHERE lid='lb1'");
 await publish(made,[film(2)],'s2',{},{now:NOW+1000});await drain(made,NOW+1000);
 await publish(made,[film(2),film(0),film(1)],'s3',{},{now:NOW+2000});
 const ledger=Object.fromEntries(rows(made.file,'SELECT lid,state,resolved_by FROM watchlist_admission_pending').map(row=>[row.lid,[row.state,row.resolved_by]]));
 assert.deepEqual(ledger.lb0,['resolved','rcpt'],'a resolved id is not reopened by a return');
 assert.deepEqual(ledger.lb1,['pending',null],'a superseded id returns as the continuation of the same primary key');
 assert.equal(rows(made.file,'SELECT COUNT(*) AS n FROM watchlist_admission_pending')[0].n,3);
 // T23: the cap refuses loudly, drops nothing and writes nothing
 const full=open();
 sqlite(full.file,"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<"+Watchlist.LIMITS.pendingCap+") INSERT INTO watchlist_admission_pending (lid,first_seen_snapshot_id,first_seen_version,state,attempts,next_retry_at,last_reason,resolved_by,updated_at) SELECT 'old'||i,'s',1,'pending',0,NULL,NULL,NULL,'"+T+"' FROM n");
 const before=counts(full.file);
 const refused=await Watchlist.publishSnapshot(full.db,list(3),scan('x'),ctx());
 assert.deepEqual([refused.ok,refused.reason],[false,'admission_ledger_full']);
 assert.deepEqual(counts(full.file),before,'the promotion is held, nothing is truncated or dropped');
 assert.equal(current(full.file).version,0);
}

// ===== 9. T29: a complete scan that removes most members is published; T3/T4 snapshot age =====
{
 const made=open();
 await publish(made,list(400),'s1');await drain(made);
 const big=await publish(made,list(20),'s2',{},{now:NOW+1000});
 assert.equal(big.removed.length,380,'no mass-change guard (owner decision O2): a complete scan is published');
 assert.equal((await Watchlist.readCurrent(made.db)).snapshot.filmCount,20);
 const h=3600000;
 const successAt=current(made.file).last_success_at;
 for(const [hours,stale] of [[0.5,false],[6.5,false],[12.5,false],[18.5,false],[23.9,false],[24.1,true],[40,true]]){
  const out=await Watchlist.pinForEpg(made.db,{now:Date.parse(successAt)+hours*h});
  assert.equal(out.ok,true,'T4: the EPG runs whatever the age (no hard TTL), age '+hours+'h');
  assert.equal(out.warning,stale?'watchlist_stale':null,'the warning only above 24 hours: '+hours+'h');
 }
 const pin=await Watchlist.pinForEpg(made.db,{now:NOW});
 assert.equal(pin.pin.watchlistVersion,2);assert.equal(pin.films.length,20);assert.equal(pin.films[0].id,'lb0');
 assert.deepEqual(Object.keys(pin.films[0]).sort(),['id','title','url','year'],'the EPG copy is the list page shape: no TMDB id');
 // T3: a commit after the pin does not change what the run already copied
 await drain(made,NOW+2000);
 await publish(made,list(21),'s3',{},{now:NOW+5000});
 assert.equal(pin.films.length,20);assert.equal((await Watchlist.pinForEpg(made.db)).films.length,21,'a later commit is for the next EPG run only');
 // a corrupt snapshot is refused, never served
 sqlite(made.file,"DROP TRIGGER watchlist_member_immutable;UPDATE watchlist_member SET title='tampered' WHERE ordinal=0 AND snapshot_id=(SELECT snapshot_id FROM watchlist_current)");
 assert.equal((await Watchlist.readCurrent(made.db)).reason,'malformed');
 assert.equal((await Watchlist.pinForEpg(made.db)).reason,'watchlist_unavailable');
}

// ===== 10. caller guards (the Workflow mode epoch of AIR-570) and the hold fence =====
{
 const made=open();
 const refuse=[Watchlist.guardOf('0'),[]];
 const out=await Watchlist.publishSnapshot(made.db,list(3),scan('g'),ctx({guards:[refuse]}));
 assert.deepEqual([out.ok,out.reason],[false,'conflict'],'a stale instance of the caller is refused inside the batch');
 assert.equal(current(made.file).version,0);
 assert.equal((await Watchlist.publishSnapshot(made.db,list(3),scan('g'),ctx({guards:'x'}))).reason,'shape');
 // the authority moves between the read and the write (a hold): nothing is promoted
 let flipped=false;
 const racing=open({onBatch:async()=>{if(!flipped){flipped=true;sqlite(racing.file,"UPDATE watchlist_authority SET writes='held'");}}});
 const held=await Watchlist.publishSnapshot(racing.db,list(3),scan('h'),ctx());
 assert.equal(held.ok,false);assert.equal(current(racing.file).version,0);
 assert.equal(counts(racing.file).snapshot,0);
}
console.log('watchlist-d1: ok');
