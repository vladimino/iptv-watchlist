// The narrow 0033 production operator (scripts/letterboxd-sync-control-production.mjs): status, the one atomic schema-only apply and its readback.
// Offline only: a sqlite D1 stand-in over the real migration chain. No production database is opened.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import * as Op from '../scripts/letterboxd-sync-control-production.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-lb-ctl-op-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const chain=upTo=>names.filter(name=>name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const NOW=Date.parse('2026-11-21T16:00:00.000Z');
let copies=0;
function open(upTo='0032_epg_channel_authority.sql'){
 const file=path.join(root,'db-'+(copies++)+'.sqlite');
 sqlite(file,chain(upTo));
 return {file,db:d1Standin(file)};
}
const stop=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason,String(error.reason));return error;}assert.fail('expected '+reason);};
const states=[];const trackedCtx=()=>({track:state=>states.push(state)});
const v=file=>rows(file,'SELECT version FROM schema_contract')[0].version;

// ===== 1. arguments =====
{
 const A=(...a)=>['node','x',...a];
 assert.deepEqual(Op.parseArgs(A()).report,{configured:false,writes:false,writeState:'none'});
 assert.throws(()=>Op.parseArgs(A('--apply')),e=>e.reason==='target_required');
 assert.throws(()=>Op.parseArgs(A('--apply','--target','other','--confirm','apply')),e=>e.reason==='target_invalid');
 assert.throws(()=>Op.parseArgs(A('--apply','--target','iptv')),e=>e.reason==='confirm');
 assert.throws(()=>Op.parseArgs(A('--apply','--target','iptv','--confirm','status')),e=>e.reason==='confirm');
 assert.throws(()=>Op.parseArgs(A('--import','--target','iptv','--confirm','import')),e=>e.reason==='usage','no other command exists');
 assert.throws(()=>Op.parseArgs(A('--status','--apply','--target','iptv','--confirm','apply')),e=>e.reason==='usage');
 assert.equal(Op.parseArgs(A('--apply','--target','iptv','--confirm','apply')).command,'apply');
 const r=spawnSync(process.execPath,['scripts/letterboxd-sync-control-production.mjs'],{encoding:'utf8'});assert.equal(r.status,0);
 assert.deepEqual(JSON.parse(r.stdout),{configured:false,writes:false,writeState:'none'});
}

// ===== 2. the file the operator applies =====
{
 const wanted=Op.expectedObjects();
 assert.deepEqual([...wanted.tables].sort(),['letterboxd_slot','letterboxd_slot_event','letterboxd_sync_fence','letterboxd_sync_mode']);
 assert.deepEqual([...wanted.indexes].sort(),['letterboxd_slot_due','letterboxd_slot_event_pending']);
 assert.deepEqual([...wanted.triggers].sort(),['letterboxd_slot_closed_immutable','letterboxd_slot_event_frozen'],'the existing schema_contract_no_downgrade trigger is not counted');
 assert.equal(Op.migrationSql().length>8,true);
 assert.match(Op.migrationSha256(),/^[0-9a-f]{64}$/);
 assert.match(Op.MIGRATION_PATH,/0033_letterboxd_sync_control\.sql$/);
}

// ===== 3. status is read-only; apply installs everything atomically and the readback holds =====
{
 const env=open();
 const calls=[];const spy={prepare:sql=>env.db.prepare(sql),batch:async s=>{calls.push(s.length);return env.db.batch(s);}};
 const before=rows(env.file,'SELECT * FROM schema_contract');
 const status=await Op.execute('status',{binding:spy,now:NOW});
 assert.equal(status.writes,false);assert.equal(status.decision,'apply');assert.equal(status.schemaVersion,32);assert.equal(calls.length,0,'status never batches');
 assert.deepEqual(rows(env.file,'SELECT * FROM schema_contract'),before);
 states.length=0;
 const result=await Op.execute('apply',{binding:spy,now:NOW,ctx:trackedCtx()});
 assert.equal(calls.length,1,'exactly ONE batch');assert.equal(calls[0],Op.migrationSql().length,'the whole file, nothing piecemeal');
 assert.equal(result.writeState,'committed');assert.deepEqual(states,['unknown','committed']);
 assert.equal(v(env.file),33);
 for(const table of ['letterboxd_sync_mode','letterboxd_sync_fence','letterboxd_slot','letterboxd_slot_event'])assert.equal(rows(env.file,'SELECT COUNT(*) AS n FROM '+table)[0].n,0,table+' stays empty');
 assert.deepEqual(rows(env.file,'SELECT mode, writes, generation FROM watchlist_authority'),[{mode:'epg',writes:'open',generation:0}],'the Watchlist marker is untouched');
 assert.deepEqual(rows(env.file,'SELECT mode, writes, generation FROM epg_checkpoint_authority'),[{mode:'r2',writes:'open',generation:0}]);
 assert.equal(rows(env.file,'SELECT revision FROM epg_channel_revision')[0].revision,0,'the Channel revision row is untouched');
 const again=await Op.execute('status',{binding:env.db,now:NOW});assert.equal(again.decision,'already_applied');
 await stop(Op.execute('apply',{binding:env.db,now:NOW}),'already_applied');
}

// ===== 4. refusals change nothing =====
{
 await stop(Op.execute('apply',{binding:open('0031_watchlist_authority.sql').db,now:NOW}),'schema_unexpected');
 const partial=open();sqlite(partial.file,'CREATE TABLE letterboxd_slot (id INTEGER PRIMARY KEY)');
 await stop(Op.execute('apply',{binding:partial.db,now:NOW}),'partial_schema');
 assert.equal(v(partial.file),32);
 const noCheckpoint=open();sqlite(noCheckpoint.file,'DROP TABLE epg_checkpoint_run');
 await stop(Op.execute('apply',{binding:noCheckpoint.db,now:NOW}),'checkpoint_invalid');
 const wrongMarker=open();sqlite(wrongMarker.file,"UPDATE epg_checkpoint_authority SET generation=1");
 await stop(Op.execute('apply',{binding:wrongMarker.db,now:NOW}),'checkpoint_invalid');
 const noWatchlist=open();sqlite(noWatchlist.file,'DROP TABLE watchlist_member');
 await stop(Op.execute('apply',{binding:noWatchlist.db,now:NOW}),'prerequisites_invalid');
 const noChannel=open();sqlite(noChannel.file,'DROP TABLE epg_channel');
 await stop(Op.execute('apply',{binding:noChannel.db,now:NOW}),'prerequisites_invalid');
 const noRevision=open();sqlite(noRevision.file,'DELETE FROM epg_channel_cas');
 await stop(Op.execute('apply',{binding:noRevision.db,now:NOW}),'prerequisites_invalid');
 const busy=open();sqlite(busy.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','{\"schemaVersion\":1,\"holder\":\"h\",\"expiresAt\":\"2026-11-21T17:00:00.000Z\",\"released\":false}',1,'2026-11-21T15:00:00.000Z')");
 states.length=0;
 const error=await stop(Op.execute('apply',{binding:busy.db,now:NOW,ctx:trackedCtx()}),'writer_active');
 assert.equal(error.details.busy,'step_lease_live');assert.equal(v(busy.file),32);assert.equal(states.length,0,'refused before any write');
 const running=open();sqlite(running.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('control','{\"phase\":\"running\"}',1,'2026-11-21T15:00:00.000Z')");
 await stop(Op.execute('apply',{binding:running.db,now:NOW}),'writer_active');
}

// ===== 5. a failing batch rolls back and is read back; a lost reply is write_uncertain; a bad readback is write_uncertain =====
{
 // a race that the file's own guard does not cover (a prerequisite table disappears between the preflight and the batch): the batch commits, the readback disagrees, the operator says write_uncertain
 const raced=open();
 const racing={prepare:sql=>raced.db.prepare(sql),batch:async s=>{sqlite(raced.file,'DROP TABLE epg_channel');return raced.db.batch(s);}};
 states.length=0;
 const race=await stop(Op.execute('apply',{binding:racing,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(race.details.problems.includes('prerequisites_changed'),true);assert.equal(states.at(-1),'unknown');
 // a guard abort: the version moved off 32 inside the window; the file inserts its refusal row and the whole batch rolls back
 const guarded=open();
 const guarding={prepare:sql=>guarded.db.prepare(sql),batch:async s=>{sqlite(guarded.file,"UPDATE schema_contract SET version=33 WHERE id=1");return guarded.db.batch(s);}};
 await stop(Op.execute('apply',{binding:guarding,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(rows(guarded.file,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('letterboxd_sync_mode','letterboxd_slot')")[0].n,0,'nothing was created');
 // a lost reply after a real commit: the state is read back and reported as write_uncertain, never retried
 const lost=open();let batches=0;
 const losing={prepare:sql=>lost.db.prepare(sql),batch:async s=>{batches++;await lost.db.batch(s);throw new Error('lost reply');}};
 states.length=0;
 const error=await stop(Op.execute('apply',{binding:losing,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(batches,1,'no retry');assert.equal(error.details.schemaVersion,33);assert.equal(states.at(-1),'unknown');
 // a readback that disagrees (a row written into the new mode table inside the window) is write_uncertain, not success
 const dirty=open();
 const writing={prepare:sql=>dirty.db.prepare(sql),batch:async s=>{const r=await dirty.db.batch(s);sqlite(dirty.file,"INSERT INTO letterboxd_sync_fence (id, ok) VALUES (1, 1)");return r;}};
 const bad=await stop(Op.execute('apply',{binding:writing,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(bad.details.problems.includes('rows_written'),true);
 // another domain marker changed during the window is caught too
 const moved=open();
 const marker={prepare:sql=>moved.db.prepare(sql),batch:async s=>{const r=await moved.db.batch(s);sqlite(moved.file,"UPDATE watchlist_authority SET generation=1");return r;}};
 const m=await stop(Op.execute('apply',{binding:marker,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(m.details.problems.some(p=>p.startsWith('marker_changed:')),true);
}
console.log('letterboxd-sync-control-production: ok');
