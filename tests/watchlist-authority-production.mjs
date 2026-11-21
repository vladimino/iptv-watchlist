// The narrow 0031 production operator (scripts/watchlist-authority-production.mjs): status, the one atomic schema-only apply and its readback.
// Offline only: a sqlite D1 stand-in over the real migration chain. No production database is opened.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import * as Op from '../scripts/watchlist-authority-production.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-wl-auth-op-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const chain=upTo=>names.filter(name=>name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const NOW=Date.parse('2026-11-21T16:00:00.000Z');
let copies=0;
function open(upTo='0030_epg_checkpoint_authority.sql'){
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
 const r=spawnSync(process.execPath,['scripts/watchlist-authority-production.mjs'],{encoding:'utf8'});assert.equal(r.status,0);
 assert.deepEqual(JSON.parse(r.stdout),{configured:false,writes:false,writeState:'none'});
}

// ===== 2. the file the operator applies =====
{
 const wanted=Op.expectedObjects();
 assert.deepEqual(wanted.tables.sort(),['watchlist_admission_pending','watchlist_authority','watchlist_cas','watchlist_change','watchlist_current','watchlist_effect','watchlist_member','watchlist_snapshot','watchlist_staging']);
 assert.equal(wanted.indexes.length>=1,true);assert.equal(wanted.triggers.includes('schema_contract_no_downgrade'),false);
 assert.equal(Op.migrationSql().length>20,true);
 assert.match(Op.migrationSha256(),/^[0-9a-f]{64}$/);
}

// ===== 3. status is read-only; apply installs everything atomically and the readback holds =====
{
 const env=open();
 const calls=[];const spy={prepare:sql=>env.db.prepare(sql),batch:async s=>{calls.push(s.length);return env.db.batch(s);}};
 const before=rows(env.file,'SELECT * FROM schema_contract');
 const status=await Op.execute('status',{binding:spy,now:NOW});
 assert.equal(status.writes,false);assert.equal(status.decision,'apply');assert.equal(status.schemaVersion,30);assert.equal(calls.length,0,'status never batches');
 assert.deepEqual(rows(env.file,'SELECT * FROM schema_contract'),before);
 states.length=0;
 const result=await Op.execute('apply',{binding:spy,now:NOW,ctx:trackedCtx()});
 assert.equal(calls.length,1,'exactly ONE batch');assert.equal(calls[0],Op.migrationSql().length,'the whole file, nothing piecemeal');
 assert.equal(result.writeState,'committed');assert.deepEqual(states,['unknown','committed']);
 assert.equal(v(env.file),31);
 assert.deepEqual(rows(env.file,'SELECT mode, generation, writes FROM watchlist_authority'),[{mode:'epg',generation:0,writes:'open'}]);
 assert.deepEqual(rows(env.file,'SELECT ok FROM watchlist_cas'),[{ok:1}]);
 assert.deepEqual(rows(env.file,'SELECT version, snapshot_id, revision FROM watchlist_current'),[{version:0,snapshot_id:null,revision:1}]);
 assert.deepEqual(rows(env.file,"SELECT mode, writes, generation FROM epg_checkpoint_authority"),[{mode:'r2',writes:'open',generation:0}],'the checkpoint marker is untouched');
 for(const table of ['watchlist_staging','watchlist_snapshot','watchlist_member','watchlist_change','watchlist_effect','watchlist_admission_pending'])assert.equal(rows(env.file,'SELECT COUNT(*) AS n FROM '+table)[0].n,0,table);
 const again=await Op.execute('status',{binding:env.db,now:NOW});assert.equal(again.decision,'already_applied');
 await stop(Op.execute('apply',{binding:env.db,now:NOW}),'already_applied');
}

// ===== 4. refusals change nothing =====
{
 await stop(Op.execute('apply',{binding:open('0029_started_authority.sql').db,now:NOW}),'schema_unexpected');
 const partial=open();sqlite(partial.file,'CREATE TABLE watchlist_cas (id INTEGER PRIMARY KEY)');
 await stop(Op.execute('apply',{binding:partial.db,now:NOW}),'partial_schema');
 assert.equal(v(partial.file),30);
 const noCheckpoint=open();sqlite(noCheckpoint.file,"UPDATE epg_checkpoint_authority SET mode='r2'; DROP TABLE epg_checkpoint_run");
 await stop(Op.execute('apply',{binding:noCheckpoint.db,now:NOW}),'checkpoint_invalid');
 const wrongMarker=open();sqlite(wrongMarker.file,"UPDATE epg_checkpoint_authority SET generation=1");
 await stop(Op.execute('apply',{binding:wrongMarker.db,now:NOW}),'checkpoint_invalid');
 for(const [label,body] of [['live lease',{schemaVersion:1,holder:'h',expiresAt:'2026-11-21T17:00:00.000Z',released:false}]]){
  const busy=open();sqlite(busy.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify(body)+"',1,'2026-11-21T15:00:00.000Z')");
  states.length=0;
  const error=await stop(Op.execute('apply',{binding:busy.db,now:NOW,ctx:trackedCtx()}),'writer_active');
  assert.equal(error.details.busy,'step_lease_live',label);assert.equal(v(busy.file),30);assert.equal(states.length,0,'refused before any write');
 }
 const running=open();sqlite(running.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('control','{\"phase\":\"running\"}',1,'2026-11-21T15:00:00.000Z')");
 await stop(Op.execute('apply',{binding:running.db,now:NOW}),'writer_active');
}

// ===== 5. a failing batch rolls back and is read back; a lost reply is write_uncertain; a bad readback is write_uncertain =====
{
 // a race: the checkpoint run table disappears between the preflight and the batch; the file's own guard aborts the whole batch
 const raced=open();
 const racing={prepare:sql=>raced.db.prepare(sql),batch:async s=>{sqlite(raced.file,'DROP TABLE epg_checkpoint_run');return raced.db.batch(s);}};
 states.length=0;
 await stop(Op.execute('apply',{binding:racing,now:NOW,ctx:trackedCtx()}),'statement_failed');
 assert.equal(v(raced.file),30,'rolled back: schema 30');
 assert.equal(rows(raced.file,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('watchlist_authority','watchlist_cas','watchlist_current','watchlist_snapshot')")[0].n,0,'and no 0031 object');
 assert.equal(states.at(-1),'none');
 // a lost reply after a real commit: the state is read back and reported as write_uncertain, never retried
 const lost=open();let batches=0;
 const losing={prepare:sql=>lost.db.prepare(sql),batch:async s=>{batches++;await lost.db.batch(s);throw new Error('lost reply');}};
 states.length=0;
 const error=await stop(Op.execute('apply',{binding:losing,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(batches,1,'no retry');assert.equal(error.details.schemaVersion,31);assert.equal(states.at(-1),'unknown');
 // a readback that disagrees (a row written by someone else inside the window) is write_uncertain, not success
 const dirty=open();
 const writing={prepare:sql=>dirty.db.prepare(sql),batch:async s=>{const r=await dirty.db.batch(s);sqlite(dirty.file,"UPDATE watchlist_authority SET mode='d1'");return r;}};
 const bad=await stop(Op.execute('apply',{binding:writing,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(bad.details.problems.includes('authority_row'),true);
 // another domain marker changed during the window is caught too
 const moved=open();
 const marker={prepare:sql=>moved.db.prepare(sql),batch:async s=>{const r=await moved.db.batch(s);sqlite(moved.file,"UPDATE epg_checkpoint_authority SET generation=1");return r;}};
 const m=await stop(Op.execute('apply',{binding:marker,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(m.details.problems.some(p=>p.startsWith('marker_changed:')),true);
}
console.log('watchlist-authority-production: ok');
