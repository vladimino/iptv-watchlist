// AIR-571 holdpoint (d): the Watchlist marker transitions of the owner operator (src/watchlist-cutover.js, scripts/watchlist-cutover-production.mjs).
// Offline only: the sqlite D1 stand-in over the whole migration chain, with the bootstrap import done by the bootstrap operator. No production database is opened.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import {D1Error} from '../scripts/d1-backfill.mjs';
import * as Boot from '../scripts/watchlist-bootstrap-production.mjs';
import * as Op from '../scripts/watchlist-cutover-production.mjs';
import * as PublishedEpg from '../src/published-epg.js';
import {createHash} from 'node:crypto';
import {listDigest,normalizeFilms,readCurrent,pinForEpg,readAuthority,publishSnapshot,completeEffect,EFFECTS} from '../src/watchlist-d1.js';
import {membershipDigest} from '../src/watchlist-bootstrap.js';
import {transitionStatements,exportGuards,TRANSITIONS} from '../src/watchlist-cutover.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-wl-cut-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const NOW=Date.parse('2026-11-21T18:00:00.000Z');
const RUN='run-20261121';
const FILMS=Array.from({length:30},(_,i)=>({id:'film-'+i,title:'Film '+i,year:1980+i,url:'https://letterboxd.com/film/film-'+i+'/',...(i===0?{tmdbId:'123',directors:[{id:'d1',name:'Director'}]}:{})}));
const esc=text=>text.replace(/'/g,"''");
const SHA=await listDigest(normalizeFilms(FILMS));
const MEMBERS=await membershipDigest(normalizeFilms(FILMS));
const md5=text=>createHash('md5').update(text).digest('hex');
// An in-memory R2 object store with strong content etags and conditional puts, usable both as the operator's store (get, head, put) and as the Worker's bucket binding.
function memStore(initial={}){
 const objects=new Map(Object.entries(initial).map(([key,text])=>[key,{text,etag:md5(text)}]));
 const log=[];
 const store={objects,log,beforePut:null,failPut:null,
  etag:key=>objects.get(key)?.etag??null,
  async get(key){const o=objects.get(key);return o?{etag:o.etag,size:Buffer.byteLength(o.text),text:async()=>o.text}:null;},
  async head(key){const o=objects.get(key);return o?{etag:o.etag,size:Buffer.byteLength(o.text)}:null;},
  async put(key,text,options={}){
   if(store.beforePut)await store.beforePut(key);
   if(store.failPut)throw store.failPut;
   const o=objects.get(key);
   if(options.onlyIf?.etagMatches&&o?.etag!==options.onlyIf.etagMatches)return null;
   if(options.onlyIf?.etagDoesNotMatch==='*'&&o)return null;
   objects.set(key,{text,etag:md5(text)});log.push('put '+key);return {etag:md5(text)};
  }};
 return store;
}
let copies=0;
// A database with the published generation and the bootstrap import done (marker epg/open g0, pointer v1).
async function imported(){
 const file=path.join(root,'db-'+(copies++)+'.sqlite');
 sqlite(file,names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 const text=JSON.stringify({films:FILMS,updatedAt:'2026-11-21T16:11:45.255Z'});const half=Math.floor(text.length/2);
 sqlite(file,"INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('"+RUN+"','published','2026-11-21T16:11:45.255Z','"+'a'.repeat(64)+"','2026-11-21T16:00:00.000Z');"
  +"UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='"+RUN+"', generation=515, finalized_run_id='"+RUN+"', finalized_at='2026-11-21T16:11:45.255Z' WHERE id=1;"
  +"INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('"+RUN+"','watchlist',0,'"+esc(text.slice(0,half))+"'),('"+RUN+"','watchlist',1,'"+esc(text.slice(half))+"'),('"+RUN+"','programme',0,'"+esc(JSON.stringify({updatedAt:'2026-11-21T16:11:45.255Z',films:[],watchlistCount:30}))+"');"
  +FILMS.map((f,i)=>"INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('"+RUN+"','watchlist',"+i+",'"+f.id+"');").join(''));
 const db=d1Standin(file);
 const done=await Boot.execute('bootstrap',{binding:db,args:{run:RUN,epgGeneration:515,count:30,membersSha256:MEMBERS,sha256:SHA},now:NOW,ctx:{snapshotId:'snap-1'}});
 assert.equal(done.writeState,'committed');
 // O4: the forward path needs the EPG checkpoint authority cut over to d1 and open first.
 sqlite(file,"UPDATE epg_checkpoint_authority SET mode='d1'");
 // the root watchlist mirror in R2 (the list the EPG published) and a write-store factory that allows only that key
 const store=memStore({'watchlist.json':JSON.stringify({films:FILMS.map(f=>({id:f.id,title:f.title,year:f.year,url:f.url})),updatedAt:'2026-11-21T16:11:45.255Z'})});
 return {file,db,store,writeFactory:allowed=>{assert.deepEqual([...allowed],['watchlist.json'],'the fence may write only the root key');return store;}};
}
const snapshotId='snap-1';
const FORWARD={run:RUN,epgGeneration:515,count:30,membersSha256:MEMBERS,sha256:SHA,snapshotId};
const CURRENT={count:30,sha256:SHA,snapshotId};
const RELEASE={run:RUN,count:30,membersSha256:MEMBERS,sha256:SHA,snapshotId};
const stop=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason,String(error.reason));return error;}assert.fail('expected '+reason);};
const asStatement=async run=>{try{return await run();}catch(error){throw new D1Error('statement',String(error?.message||error));}};
const states=[];const trackedCtx=()=>({track:state=>states.push(state)});
const marker=file=>rows(file,'SELECT mode, writes, generation FROM watchlist_authority')[0];
const pointer=file=>rows(file,'SELECT version, snapshot_id, list_sha256, film_count, effects_drained_version, revision FROM watchlist_current')[0];
const counts=file=>rows(file,"SELECT (SELECT COUNT(*) FROM watchlist_staging) AS staging,(SELECT COUNT(*) FROM watchlist_snapshot) AS snapshot,(SELECT COUNT(*) FROM watchlist_member) AS member,(SELECT COUNT(*) FROM watchlist_change) AS change,(SELECT COUNT(*) FROM watchlist_effect) AS effect,(SELECT COUNT(*) FROM watchlist_admission_pending) AS pending")[0];
// `activate` needs the root mirror fenced first (the runbook order): the helper fences with the etag it reads, then activates with the etag the fence produced.
const run=async(env,command,args,extra={})=>{
 if(command==='activate'&&args.rootEtag===undefined){
  const fenced=await Op.execute('fence-root',{binding:env.db,args:{generation:args.generation,rootEtag:env.store.etag('watchlist.json')},now:NOW,readStore:env.store,writeStoreFactory:env.writeFactory});
  args={...args,rootEtag:fenced.root.etag};
 }
 return Op.execute(command,{binding:env.db,args,now:NOW,ctx:trackedCtx(),readStore:env.store,writeStoreFactory:env.writeFactory,...extra});
};
// A guard tripped in the batch reaches the operator as a statement error of the D1 API; the stand-in throws a plain error.
const asStmt=env=>({prepare:sql=>env.db.prepare(sql),batch:statements=>asStatement(()=>env.db.batch(statements))});
const wrap=(env,mutate)=>({prepare:sql=>env.db.prepare(sql),batch:async statements=>{sqlite(env.file,mutate);return asStatement(()=>env.db.batch(statements));}});

// ===== 1. arguments =====
{
 const A=(...a)=>['node','x',...a];
 const pins=['--expect-run',RUN,'--expect-epg-generation','515','--expect-count','30','--expect-members-sha256',MEMBERS,'--expect-sha256',SHA,'--expect-snapshot-id',snapshotId];
 const activatePins=[...pins,'--expect-root-etag','abc123'];
 assert.deepEqual(Op.parseArgs(A()).report,{configured:false,writes:false,writeState:'none'});
 for(const command of Op.COMMANDS.filter(c=>c!=='status'))assert.throws(()=>Op.parseArgs(A('--'+command)),e=>e.reason==='target_required',command);
 assert.throws(()=>Op.parseArgs(A('--hold','--target','other','--confirm','hold')),e=>e.reason==='target_invalid');
 assert.throws(()=>Op.parseArgs(A('--hold','--target','iptv','--expect-generation','0',...pins)),e=>e.reason==='confirm');
 assert.throws(()=>Op.parseArgs(A('--hold','--target','iptv','--confirm','activate','--expect-generation','0',...pins)),e=>e.reason==='confirm','the token is the command name');
 assert.throws(()=>Op.parseArgs(A('--hold','--target','iptv','--confirm','hold',...pins)),e=>e.reason==='usage','the expected generation is required');
 assert.throws(()=>Op.parseArgs(A('--hold','--activate','--target','iptv','--confirm','hold','--expect-generation','0',...pins)),e=>e.reason==='usage','one command only');
 assert.throws(()=>Op.parseArgs(A('--release-abort','--target','iptv','--confirm','release-abort','--expect-generation','1','--expect-count','30')),e=>e.reason==='usage','a command takes only its own pins');
 assert.throws(()=>Op.parseArgs(A('--status','--target','iptv','--confirm','status')),e=>e.reason==='usage');
 for(const drop of ['--expect-run','--expect-epg-generation','--expect-count','--expect-members-sha256','--expect-sha256','--expect-snapshot-id','--expect-generation','--expect-root-etag']){
  const full=['--activate','--target','iptv','--confirm','activate','--expect-generation','1',...activatePins];const at=full.indexOf(drop);full.splice(at,2);
  assert.throws(()=>Op.parseArgs(A(...full)),e=>e.reason==='usage','every pin of activate is required: '+drop);
 }
 assert.equal(Op.parseArgs(A('--hold','--target','iptv','--confirm','hold','--expect-generation','0',...pins)).command,'hold');
 assert.equal(Op.parseArgs(A('--release','--target','iptv','--confirm','release','--expect-generation','2','--expect-run',RUN,'--expect-count','30','--expect-members-sha256',MEMBERS,'--expect-sha256',SHA,'--expect-snapshot-id',snapshotId)).command,'release');
 assert.throws(()=>Op.parseArgs(A('--release','--target','iptv','--confirm','release','--expect-generation','2','--expect-count','30','--expect-sha256',SHA,'--expect-snapshot-id',snapshotId)),e=>e.reason==='usage','release needs the full import pins');
 assert.equal(Op.parseArgs(A('--hold-rollback','--target','iptv','--confirm','hold-rollback','--expect-generation','2','--expect-count','30','--expect-sha256',SHA,'--expect-snapshot-id',snapshotId,'--expect-version','1','--expect-revision','2')).command,'hold-rollback');
 const rb=['--target','iptv','--expect-generation','3','--expect-count','30','--expect-sha256',SHA,'--expect-snapshot-id',snapshotId,'--expect-version','2','--expect-revision','5','--expect-run',RUN,'--expect-epg-generation','515'];
 for(const command of ['export-rollback','revert-authority'])assert.equal(Op.parseArgs(A('--'+command,'--target','iptv','--confirm',command,...rb.slice(2))).command,command,command);
 assert.throws(()=>Op.parseArgs(A('--export-rollback','--target','iptv','--confirm','export-rollback','--expect-generation','3')),e=>e.reason==='usage','the export needs every pin');
 assert.throws(()=>Op.parseArgs(A('--revert-authority','--target','iptv','--confirm','revert-authority',...rb.slice(2).filter(x=>x!=='515'&&x!=='--expect-epg-generation'))),e=>e.reason==='usage','the revert needs the EPG generation the export produced');
 assert.equal(Op.parseArgs(A('--release-rolled-back','--target','iptv','--confirm','release-rolled-back','--expect-generation','4')).command,'release-rolled-back');
 assert.throws(()=>Op.parseArgs(A('--release-rolled-back','--target','iptv','--confirm','release-rolled-back','--expect-generation','4','--expect-count','30')),e=>e.reason==='usage');
 const r=spawnSync(process.execPath,['scripts/watchlist-cutover-production.mjs'],{encoding:'utf8'});assert.equal(r.status,0);
 assert.deepEqual(JSON.parse(r.stdout),{configured:false,writes:false,writeState:'none'});
}

// ===== 2. the plan: what each transition may write =====
{
 const facts={snapshot:{snapshotId,sha256:SHA,count:30,revision:2,version:1,runId:RUN},source:{programmeRunId:RUN,epgGeneration:515},liveness:{controlRevision:-1,leaseRevision:-1,liveAfterIso:'2026-11-21T17:59:45.000Z'},checkpoint:{mode:'d1'},letterboxd:{revision:-1},parity:{programmeRunId:RUN,epgGeneration:516,payloadSha256:'f'.repeat(64)},published:{programmeRunId:RUN,epgGeneration:515}};
 for(const name of Object.keys(TRANSITIONS)){
  const plan=transitionStatements(name,{generation:0,facts});
  const sql=plan.statements.map(([text])=>text).join('\n');
  const tables=[...new Set([...sql.matchAll(/(?:INSERT INTO|(?<!DO )UPDATE|DELETE FROM)\s+([a-z_]+)/gi)].map(match=>match[1]))].sort();
  assert.deepEqual(tables,['watchlist_authority','watchlist_cas'],name+' writes the marker and the fence only');
  assert.equal(plan.statements.every(([,params])=>params.length<=100),true);
  assert.equal(plan.statements.at(-1)[0],'UPDATE watchlist_cas SET ok=changes() WHERE id=1');
 }
 assert.deepEqual(transitionStatements('hold',{generation:4,facts}).target,{mode:'epg',writes:'held',generation:5});
 assert.deepEqual(transitionStatements('release-abort',{generation:5}).target,{mode:'epg',writes:'open',generation:5});
 assert.deepEqual(transitionStatements('activate',{generation:5,facts}).target,{mode:'d1',writes:'held',generation:6});
 assert.deepEqual(transitionStatements('release',{generation:6,facts}).target,{mode:'d1',writes:'open',generation:6});
 assert.deepEqual(transitionStatements('hold-rollback',{generation:6,facts}).target,{mode:'d1',writes:'held',generation:7});
 assert.throws(()=>transitionStatements('hold',{generation:0,facts:{...facts,liveness:undefined}}),/bootstrap_liveness/,'the liveness proof is required');
 assert.throws(()=>transitionStatements('hold',{generation:0,facts:{...facts,checkpoint:undefined}}),/cutover_checkpoint/);
 assert.throws(()=>transitionStatements('activate',{generation:0,facts:{...facts,checkpoint:{mode:'r2'}}}),/cutover_checkpoint/,'the plan never accepts an r2 checkpoint on the forward path');
 assert.throws(()=>transitionStatements('hold',{generation:0,facts:{...facts,source:{programmeRunId:'other',epgGeneration:515}}}),/cutover_source/);
 assert.throws(()=>transitionStatements('nope',{generation:0}),/cutover_usage/);
 assert.throws(()=>transitionStatements('revert-authority',{generation:0,facts:{...facts,parity:{...facts.parity,payloadSha256:undefined}}}),/cutover_parity/,'the parity proof binds the stored payload digest');
 // the export commit guard: the marker, the pointer with its effects done, the publication, the Letterboxd mode and the liveness proof
 const guards=exportGuards({generation:3,facts});
 assert.equal(guards.length,2);assert.equal(guards.every(([sql,params])=>/^INSERT INTO watchlist_cas/.test(sql)&&params.length<=100),true);
 assert.match(guards[0][0],/effects_drained_version=version/);assert.match(guards[0][0],/watchlist_effect WHERE status<>'done'/);assert.match(guards[0][0],/finalized_run_id=programme_run_id/);
 assert.throws(()=>exportGuards({generation:3,facts:{...facts,liveness:undefined}}),/bootstrap_liveness/);
}

// ===== 3. status is read-only; the forward path hold, activate, release and the serving of the snapshot =====
{
 const env=await imported();
 const calls=[];const spy={prepare:sql=>env.db.prepare(sql),batch:async s=>{calls.push(s.length);return env.db.batch(s);}};
 const status=await Op.execute('status',{binding:spy,now:NOW});
 assert.equal(status.writes,false);assert.equal(status.marker.mode,'epg');assert.equal(status.snapshot.ok,true);assert.equal(status.snapshot.membersSha256,MEMBERS);assert.equal(status.letterboxd.closed,true);assert.equal(calls.length,0,'status never batches');
 const base={pointer:pointer(env.file),counts:counts(env.file)};
 // hold
 states.length=0;
 const held=await Op.execute('hold',{binding:spy,args:{generation:0,...FORWARD},now:NOW,ctx:trackedCtx()});
 assert.equal(calls.length,1,'exactly ONE batch');assert.deepEqual(states,['unknown','committed']);assert.deepEqual(held.marker,{mode:'epg',writes:'held',generation:1});
 assert.deepEqual(marker(env.file),{mode:'epg',writes:'held',generation:1});
 // back out
 await run(env,'release-abort',{generation:1});assert.deepEqual(marker(env.file),{mode:'epg',writes:'open',generation:1},'release-abort keeps the generation');
 // an old generation is refused
 await stop(run(env,'hold',{generation:0,...FORWARD}),'state_mismatch');
 await run(env,'hold',{generation:1,...FORWARD});assert.deepEqual(marker(env.file),{mode:'epg',writes:'held',generation:2});
 // switch: no marker can serve before the release: the snapshot is refused while held, never read as the EPG generation
 await run(env,'activate',{generation:2,...FORWARD});assert.deepEqual(marker(env.file),{mode:'d1',writes:'held',generation:3});
 assert.deepEqual(await readAuthority(env.db),{state:'d1',writes:'held',generation:3});
 assert.equal((await readCurrent(env.db,{now:NOW})).reason,'held','a held d1 marker refuses the snapshot');
 assert.equal((await pinForEpg(env.db,{now:NOW})).ok,false,'the EPG start has no list while held (it fails closed)');
 // release
 const released=await run(env,'release',{generation:3,...RELEASE});assert.deepEqual(released.marker,{mode:'d1',writes:'open',generation:3});
 const current=await readCurrent(env.db,{now:NOW});
 assert.equal(current.ok,true);assert.equal(current.snapshot.listSha256,SHA);assert.deepEqual(current.snapshot.films.map(f=>f.lid),FILMS.map(f=>f.id),'order parity');
 const pin=await pinForEpg(env.db,{now:NOW});assert.equal(pin.ok,true);assert.equal(pin.films.length,30);
 // only the marker moved
 assert.deepEqual(pointer(env.file),base.pointer);assert.deepEqual(counts(env.file),base.counts);
 assert.deepEqual(rows(env.file,'SELECT mode, cutover, programme_run_id, generation FROM published_epg_authority'),[{mode:'d1',cutover:'open',programme_run_id:RUN,generation:515}],'the published EPG generation is untouched');
 // the first step of the data rollback
 const version=Number(pointer(env.file).version),revision=Number(pointer(env.file).revision);
 const rolled=await run(env,'hold-rollback',{generation:3,...CURRENT,version,revision});assert.deepEqual(rolled.marker,{mode:'d1',writes:'held',generation:4});
 assert.equal((await readCurrent(env.db,{now:NOW})).reason,'held');
 // a transition that does not belong to the state is refused
 await stop(run(env,'hold',{generation:4,...FORWARD}),'state_mismatch');
 await stop(run(env,'activate',{generation:4,...FORWARD}),'state_mismatch');
}

// ===== 4. refusals change nothing =====
{
 const refuse=async(env,command,args,reason,label)=>{const before=marker(env.file);states.length=0;const e=await stop(run(env,command,args),reason);assert.deepEqual(marker(env.file),before,label+' left the marker');assert.equal(states.length,0,label+' refused before any write');return e;};
 const g0={generation:0,...FORWARD};
 await refuse(await imported(),'hold',{...g0,sha256:'c'.repeat(64)},'pin_mismatch','digest pin');
 await refuse(await imported(),'hold',{...g0,snapshotId:'other'},'pin_mismatch','snapshot id pin');
 await refuse(await imported(),'hold',{...g0,count:29},'pin_mismatch','count pin');
 assert.deepEqual((await refuse(await imported(),'hold',{...g0,membersSha256:'e'.repeat(64)},'already_bootstrapped','members pin')).details.problems,['pins_differ']);
 await refuse(await imported(),'hold',{...g0,generation:5},'state_mismatch','generation');
 await refuse(await imported(),'activate',g0,'state_mismatch','activate needs epg/held');
 await refuse(await imported(),'release',{generation:0,...RELEASE},'state_mismatch','release needs d1/held');
 await refuse(await imported(),'hold-rollback',{generation:0,...CURRENT,version:1,revision:2},'state_mismatch','rollback needs d1/open');
 // the imported snapshot must be whole
 const tampered=await imported();sqlite(tampered.file,"DROP TRIGGER watchlist_member_immutable;DELETE FROM watchlist_member WHERE snapshot_id='snap-1' AND ordinal=4");
 await refuse(tampered,'hold',g0,'snapshot_inconsistent','missing member');
 // the source moved after the import
 const moved=await imported();sqlite(moved.file,"INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('run-next','published','2026-11-22T16:11:45.255Z','"+'b'.repeat(64)+"','2026-11-22T16:00:00.000Z');UPDATE published_epg_authority SET programme_run_id='run-next', generation=516, finalized_run_id='run-next'");
 assert.equal((await refuse(moved,'hold',g0,'source_moved','newer publication')).details.published.programmeRunId,'run-next');
 await refuse(await imported(),'hold',{...g0,epgGeneration:514},'source_moved','generation pin');
 // an independent authority in the middle of its own cutover
 const checkpointHeld=await imported();sqlite(checkpointHeld.file,"UPDATE epg_checkpoint_authority SET writes='held'");
 await refuse(checkpointHeld,'hold',g0,'checkpoint_not_settled','checkpoint held');
 // the Letterboxd mode is not closed
 const lb=await imported();sqlite(lb.file,"INSERT INTO letterboxd_sync_mode (id, mode, epoch, changed_at, revision, write_id) VALUES (1,'cloudflare',1,'2026-11-21T10:00:00.000Z',1,'w')");
 await refuse(lb,'hold',g0,'letterboxd_not_closed','Letterboxd cloudflare');
 // a closed (external) mode row is fine and pinned
 const external=await imported();sqlite(external.file,"INSERT INTO letterboxd_sync_mode (id, mode, epoch, changed_at, revision, write_id) VALUES (1,'external',0,'2026-11-21T10:00:00.000Z',1,'w')");
 assert.equal((await run(external,'hold',g0)).writeState,'committed');
 // the EPG is executing, or its liveness records are unreadable
 const lease=await imported();sqlite(lease.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify({schemaVersion:1,holder:'h',expiresAt:'2026-11-21T19:00:00.000Z',released:false})+"',1,'2026-11-21T17:50:00.000Z')");
 assert.equal((await refuse(lease,'hold',g0,'writer_active','live lease')).details.busy,'step_lease_live');
 const unknown=await imported();sqlite(unknown.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('control','{}',1,'2026-11-21T17:50:00.000Z')");
 await refuse(unknown,'hold',g0,'liveness_unknown','invalid control record');
 // O4: the forward path never switches with the EPG checkpoint still on R2
 const r2=await imported();sqlite(r2.file,"UPDATE epg_checkpoint_authority SET mode='r2'");
 await refuse(r2,'hold',g0,'checkpoint_not_d1','checkpoint r2/open');
 // the import must be whole before the release: a scan journal row or a missing staging receipt appeared after the activation
 {
  const dirty=await imported();await run(dirty,'hold',g0);await run(dirty,'activate',{generation:1,...FORWARD});
  sqlite(dirty.file,"INSERT INTO watchlist_change (snapshot_id, kind, lid, ordinal, prev_ordinal) VALUES ('snap-1','added','film-1',1,NULL)");
  assert.equal((await refuse(dirty,'release',{generation:2,...RELEASE},'snapshot_inconsistent','dirty journal')).details.problems.includes('rows'),true);
  const effect=await imported();await run(effect,'hold',g0);await run(effect,'activate',{generation:1,...FORWARD});
  sqlite(effect.file,"INSERT INTO watchlist_effect (snapshot_id, effect, status, receipt, attempts, done_at) VALUES ('snap-1','scan_facts','pending',NULL,0,NULL)");
  await refuse(effect,'release',{generation:2,...RELEASE},'snapshot_inconsistent','an effect row');
  const pendingRow=await imported();await run(pendingRow,'hold',g0);await run(pendingRow,'activate',{generation:1,...FORWARD});
  sqlite(pendingRow.file,"INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) VALUES ('film-1','snap-1',1,'pending',0,NULL,NULL,NULL,'2026-11-21T17:59:00.000Z')");
  await refuse(pendingRow,'release',{generation:2,...RELEASE},'snapshot_inconsistent','an admission row');
  const receipt=await imported();await run(receipt,'hold',g0);await run(receipt,'activate',{generation:1,...FORWARD});
  sqlite(receipt.file,"PRAGMA foreign_keys=OFF;DELETE FROM watchlist_staging WHERE snapshot_id='snap-1'");
  await refuse(receipt,'release',{generation:2,...RELEASE},'snapshot_inconsistent','a missing staging receipt');
  const wrongRun=await imported();await run(wrongRun,'hold',g0);await run(wrongRun,'activate',{generation:1,...FORWARD});
  await refuse(wrongRun,'release',{generation:2,...RELEASE,run:'run-other'},'already_bootstrapped','pins of another import');
  // the old EPG source may have moved on: the release only needs the import itself
  const moved=await imported();await run(moved,'hold',g0);await run(moved,'activate',{generation:1,...FORWARD});
  sqlite(moved.file,"INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('run-next','published','2026-11-22T16:11:45.255Z','"+'b'.repeat(64)+"','2026-11-22T16:00:00.000Z');UPDATE published_epg_authority SET programme_run_id='run-next', generation=516, finalized_run_id='run-next'");
  assert.equal((await run(moved,'release',{generation:2,...RELEASE})).writeState,'committed','a moved old source does not block the release of an intact import');
 }
 // release-abort needs no pin and no liveness: only the marker
 const abortable=await imported();await run(abortable,'hold',g0);sqlite(abortable.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('control','{}',1,'2026-11-21T17:50:00.000Z')");
 assert.equal((await run(abortable,'release-abort',{generation:1})).writeState,'committed','backing out is never blocked by an unreadable EPG record');
 // the import must be the import: a pointer that moved on is not the forward path
 const advanced=await imported();await run(advanced,'hold',g0);await run(advanced,'activate',{generation:1,...FORWARD});
 sqlite(advanced.file,"UPDATE watchlist_authority SET writes='open'");
 await refuse(advanced,'hold-rollback',{generation:2,...CURRENT,version:1,revision:99},'pin_mismatch','pointer revision pin');
}

// ===== 5. races inside the batch: the facts verified before are re-asserted at commit time =====
{
 const g0={generation:0,...FORWARD};
 const race=async(label,mutate,command='hold',args=g0,prepare=null,reason='predicate_refused')=>{
  const env=await imported();if(prepare)prepare(env);
  const before=marker(env.file);states.length=0;
  await stop(Op.execute(command,{binding:wrap(env,mutate),args,now:NOW,ctx:trackedCtx()}),reason);
  if(reason==='predicate_refused'){assert.deepEqual(marker(env.file),before,label+': the marker did not move');assert.equal(states.at(-1),'none',label);}
  else{assert.equal(states.at(-1),'unknown',label+': the marker was moved by another writer, so the outcome is not proven as not applied');assert.equal(rows(env.file,'SELECT COUNT(*) AS n FROM watchlist_member')[0].n,30,label+': nothing else was written');}
 };
 await race('a lease appears',"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify({schemaVersion:1,holder:'h',expiresAt:'2026-11-21T19:00:00.000Z',released:false})+"',1,'2026-11-21T17:59:00.000Z')");
 await race('a running control record',"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('control','"+JSON.stringify({schemaVersion:1,phase:'running',budget:{consecutive:0,total:0}})+"',1,'2026-11-21T17:59:00.000Z')");
 await race('the pointer revision moves',"UPDATE watchlist_current SET revision=revision+1");
 await race('the published generation moves',"UPDATE published_epg_authority SET generation=516");
 await race('the checkpoint authority moves back to r2',"UPDATE epg_checkpoint_authority SET mode='r2'");
 await race('a scan journal row appears',"INSERT INTO watchlist_change (snapshot_id, kind, lid, ordinal, prev_ordinal) VALUES ('snap-1','added','film-1',1,NULL)");
 await race('the staging receipt changes',"PRAGMA foreign_keys=OFF;UPDATE watchlist_staging SET expected_count=29");
 await race('the checkpoint is held',"UPDATE epg_checkpoint_authority SET writes='held'");
 await race('the Letterboxd mode appears',"INSERT INTO letterboxd_sync_mode (id, mode, epoch, changed_at, revision, write_id) VALUES (1,'cloudflare',1,'2026-11-21T17:59:00.000Z',1,'w')");
 await race('the marker generation moves',"UPDATE watchlist_authority SET generation=generation+1",'hold',g0,null,'write_uncertain');
 await race('the marker writes move',"UPDATE watchlist_authority SET writes='held'",'hold',g0,null,'write_uncertain');
 await race('a member goes missing',"DROP TRIGGER watchlist_member_immutable;DELETE FROM watchlist_member WHERE snapshot_id='snap-1' AND ordinal=0");
 // the same for the later steps
 const step=async env=>{await run(env,'hold',g0);await run(env,'activate',{generation:1,...FORWARD});};
 {
  const releaseRace=async(label,mutate)=>{
   const env=await imported();await step(env);
   await stop(Op.execute('release',{binding:wrap(env,mutate),args:{generation:2,...RELEASE},now:NOW}),'predicate_refused');
   assert.deepEqual(marker(env.file),{mode:'d1',writes:'held',generation:2},label+': the release did not happen');
  };
  await releaseRace('the checkpoint is held',"UPDATE epg_checkpoint_authority SET writes='held'");
  await releaseRace('a row appears inside the release window',"INSERT INTO watchlist_change (snapshot_id, kind, lid, ordinal, prev_ordinal) VALUES ('snap-1','added','film-1',1,NULL)");
  await releaseRace('the checkpoint authority moves back to r2',"UPDATE epg_checkpoint_authority SET mode='r2'");
 }
 {
  const env=await imported();await step(env);await run(env,'release',{generation:2,...RELEASE});
  const args={generation:2,...CURRENT,version:1,revision:Number(pointer(env.file).revision)};
  await stop(Op.execute('hold-rollback',{binding:wrap(env,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify({schemaVersion:1,holder:'h',expiresAt:'2026-11-21T19:00:00.000Z',released:false})+"',1,'2026-11-21T17:59:00.000Z')"),args,now:NOW}),'predicate_refused');
  assert.deepEqual(marker(env.file),{mode:'d1',writes:'open',generation:2},'the rollback hold does not start under a live EPG step');
  await stop(Op.execute('hold-rollback',{binding:wrap(env,"INSERT INTO letterboxd_sync_mode (id, mode, epoch, changed_at, revision, write_id) VALUES (1,'cloudflare',1,'2026-11-21T17:59:00.000Z',1,'w')"),args:{...args},now:NOW}),'writer_active');
 }
}

// ===== 6. failures: unproven transport, lost reply, readback drift, live counters =====
{
 const g0={generation:0,...FORWARD};
 // an unproven transport outcome stays write_uncertain even if the readback looks untouched; the CLI says retry:false
 const unproven=await imported();let attempts=0;
 const timing={prepare:sql=>unproven.db.prepare(sql),batch:async()=>{attempts++;throw new D1Error('write_uncertain','response lost');}};
 states.length=0;
 await stop(Op.execute('hold',{binding:timing,args:g0,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(states.at(-1),'unknown');assert.equal(attempts,1,'no retry');assert.deepEqual(marker(unproven.file),{mode:'epg',writes:'open',generation:0});
 const cli=await Op.runWatchlistCutoverProduction({argv:['node','x','--hold','--target','iptv','--confirm','hold','--expect-generation','0','--expect-run',RUN,'--expect-epg-generation','515','--expect-count','30','--expect-members-sha256',MEMBERS,'--expect-sha256',SHA,'--expect-snapshot-id',snapshotId],deps:{binding:timing},now:()=>NOW});
 assert.equal(cli.exit,3);assert.equal(cli.result.reason,'write_uncertain');assert.equal(cli.result.writeState,'unknown');assert.equal(cli.result.writes,null);assert.equal(cli.result.retry,false);
 // a lost reply after a visible commit
 const lost=await imported();
 const error=await stop(Op.execute('hold',{binding:{prepare:sql=>lost.db.prepare(sql),batch:async s=>{await lost.db.batch(s);throw new Error('lost reply');}},args:g0,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(error.details.reachedByUnknownOutcome,true);assert.equal(states.at(-1),'unknown');
 // a readback that disagrees: the pointer moves, a journal row appears, a stable field of another domain changes, the checkpoint or the Letterboxd mode changes
 const drift=async(label,mutate,problem)=>{
  const env=await imported();
  const e=await stop(Op.execute('hold',{binding:{prepare:sql=>env.db.prepare(sql),batch:async s=>{const r=await env.db.batch(s);sqlite(env.file,mutate);return r;}},args:g0,now:NOW,ctx:trackedCtx()}),'write_uncertain');
  assert.equal(e.details.problems.some(p=>p.startsWith(problem)),true,label+': '+JSON.stringify(e.details.problems));
 };
 await drift('pointer',"UPDATE watchlist_current SET revision=revision+1",'pointer_moved');
 await drift('journal',"INSERT INTO watchlist_change (snapshot_id, kind, lid, ordinal, prev_ordinal) VALUES ('snap-1','added','film-1',1,NULL)",'rows_moved');
 await drift('ratings marker',"UPDATE ratings_domain_authority SET cutover='held'",'marker_changed:ratings_domain_authority');
 await drift('checkpoint',"UPDATE epg_checkpoint_authority SET writes='held'",'checkpoint_changed');
 await drift('letterboxd',"INSERT INTO letterboxd_sync_mode (id, mode, epoch, changed_at, revision, write_id) VALUES (1,'cloudflare',1,'2026-11-21T17:59:00.000Z',1,'w')",'letterboxd_changed');
 // a proven rejection that left the marker alone is the only "not applied"
 const rejected=await imported();
 await stop(Op.execute('hold',{binding:{prepare:sql=>rejected.db.prepare(sql),batch:async()=>{throw new D1Error('statement','rejected');}},args:g0,now:NOW,ctx:trackedCtx()}),'predicate_refused');assert.equal(states.at(-1),'none');
 // live counters of fast-moving domains inside the window are NOT drift
 const live=await imported();
 const counter=await Op.execute('hold',{binding:{prepare:sql=>live.db.prepare(sql),batch:async s=>{const r=await live.db.batch(s);sqlite(live.file,"UPDATE discovery_authority SET generation=generation+500; UPDATE ratings_domain_authority SET generation=generation+30; UPDATE published_epg_authority SET watchlist_generation=watchlist_generation+1");return r;}},args:g0,now:NOW,ctx:trackedCtx()});
 assert.equal(counter.writeState,'committed','natural counters of other domains do not read as drift');
}

// ===== 7. the data rollback: hold, export through the EPG writer path, revert, release =====
{
 // A Letterboxd scan promoted a newer snapshot (version 2) after the release: one film replaced, one reordered. The export must carry it into the published generation.
 const forward=async({keepPending=false}={})=>{
  const env=await imported();
  await run(env,'hold',{generation:0,...FORWARD});await run(env,'activate',{generation:1,...FORWARD});await run(env,'release',{generation:2,...RELEASE});
  const next=FILMS.map(f=>({id:f.id,title:f.title,year:f.year,url:f.url}));next[3]={id:'film-new',title:'A New Film',year:2024,url:'https://letterboxd.com/film/film-new/'};[next[7],next[8]]=[next[8],next[7]];
  const published=await publishSnapshot(env.db,next,{scanId:'scan-2',observedAt:'2026-11-21T20:00:00.000Z',completedAt:'2026-11-21T20:00:30.000Z',runId:'lb-run-2'},{snapshotId:'snap-2',now:NOW});
  assert.equal(published.ok,true,JSON.stringify(published));
  // the causal effects of the new snapshot are completed in order (the writer would do this before it is closed)
  if(!keepPending)for(const effect of EFFECTS)assert.equal((await completeEffect(env.db,{snapshotId:'snap-2',effect,receipt:'done'},{now:NOW})).ok,true,effect);
  const ptr=pointer(env.file);
  const snap2={count:30,sha256:ptr.list_sha256,snapshotId:'snap-2',version:Number(ptr.version),revision:Number(ptr.revision)};
  return {env,next,snap2};
 };
 const {env,next,snap2}=await forward();
 assert.equal(snap2.version,2);
 const publishedAuth=()=>rows(env.file,'SELECT generation, programme_run_id FROM published_epg_authority')[0];
 const storedFilms=()=>JSON.parse(rows(env.file,"SELECT payload_json FROM published_epg_document WHERE programme_run_id='"+RUN+"' AND kind='watchlist' ORDER BY ordinal").map(r=>r.payload_json).join('')).films;
 // before the hold the export is refused: the marker is d1/open
 const exportArgs={generation:3,...snap2,run:RUN,epgGeneration:515};
 await stop(run(env,'export-rollback',{...exportArgs,generation:2}),'state_mismatch');
 await run(env,'hold-rollback',{generation:2,...snap2});assert.deepEqual(marker(env.file),{mode:'d1',writes:'held',generation:3});
 // refusals change nothing
 const before=JSON.stringify(storedFilms());
 await stop(run(env,'export-rollback',{...exportArgs,epgGeneration:514}),'published_moved');
 await stop(run(env,'export-rollback',{...exportArgs,revision:snap2.revision+1}),'pin_mismatch');
 await stop(run(env,'export-rollback',{...exportArgs,sha256:'d'.repeat(64)}),'pin_mismatch');
 await stop(run(env,'export-rollback',{...exportArgs,run:'run-other'}),'published_moved');
 assert.equal(JSON.stringify(storedFilms()),before,'refusals wrote nothing');
 // the export writes through the EPG writer path: one generation bump, the new list, other film fields kept
 states.length=0;
 const exported=await run(env,'export-rollback',exportArgs);
 assert.equal(exported.writeState,'committed');assert.deepEqual(states,['unknown','committed']);assert.equal(exported.published.generation,516);
 assert.deepEqual(publishedAuth(),{generation:516,programme_run_id:RUN});
 assert.deepEqual(storedFilms().map(f=>f.id),next.map(f=>f.id),'order and membership of the snapshot');
 assert.equal(storedFilms().find(f=>f.id==='film-0').tmdbId,'123','a field of an existing stored film is kept');
 assert.equal(await listDigest(normalizeFilms(storedFilms())),snap2.sha256,'digest parity');
 assert.deepEqual(rows(env.file,"SELECT film_id FROM published_epg_member WHERE programme_run_id='"+RUN+"' AND kind='watchlist' ORDER BY ordinal").map(r=>r.film_id),next.map(f=>f.id),'member rows');
 assert.equal(rows(env.file,"SELECT payload_json FROM published_epg_document WHERE programme_run_id='"+RUN+"' AND kind='programme'")[0].payload_json.includes('watchlistCount'),true,'the programme document is untouched');
 assert.deepEqual(marker(env.file),{mode:'d1',writes:'held',generation:3},'the export moves no marker');
 // idempotent: an equal list at the produced generation is a receipt, nothing written
 const again=await run(env,'export-rollback',{...exportArgs,epgGeneration:516});assert.equal(again.outcome,'already_exported');assert.equal(again.writes,false);assert.equal(publishedAuth().generation,516);
 // the revert needs the parity at the exact generation the export produced
 const revertArgs={generation:3,...snap2,run:RUN,epgGeneration:516};
 await stop(Op.execute('revert-authority',{binding:asStmt(env),args:{...revertArgs,epgGeneration:515},now:NOW,ctx:trackedCtx()}),'published_moved');
 sqlite(env.file,"UPDATE published_epg_member SET film_id='film-zzz' WHERE programme_run_id='"+RUN+"' AND kind='watchlist' AND ordinal=0");
 await stop(Op.execute('revert-authority',{binding:asStmt(env),args:revertArgs,now:NOW,ctx:trackedCtx()}),'parity_mismatch');assert.deepEqual(marker(env.file),{mode:'d1',writes:'held',generation:3},'a broken parity blocks the revert');
 sqlite(env.file,"UPDATE published_epg_member SET film_id='film-0' WHERE programme_run_id='"+RUN+"' AND kind='watchlist' AND ordinal=0");
 // a live EPG step blocks the revert
 sqlite(env.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify({schemaVersion:1,holder:'h',expiresAt:'2026-11-21T19:00:00.000Z',released:false})+"',1,'2026-11-21T17:50:00.000Z')");
 await stop(run(env,'revert-authority',revertArgs),'writer_active');
 sqlite(env.file,"DELETE FROM epg_orchestration_document WHERE key='lease'");
 const reverted=await run(env,'revert-authority',revertArgs);assert.deepEqual(reverted.marker,{mode:'epg',writes:'held',generation:4});
 assert.deepEqual(await readAuthority(env.db),{state:'epg',writes:'held',generation:4});
 const opened=await run(env,'release-rolled-back',{generation:4});assert.deepEqual(opened.marker,{mode:'epg',writes:'open',generation:4});
 assert.deepEqual(await readAuthority(env.db),{state:'epg',writes:'open',generation:4},'the EPG owns the Watchlist again');
 // the snapshots stay as inert history
 assert.equal(rows(env.file,'SELECT COUNT(*) AS n FROM watchlist_snapshot')[0].n,2);
 // a Letterboxd mode that is not closed blocks every rollback step
 const open2=await forward();
 sqlite(open2.env.file,"INSERT INTO letterboxd_sync_mode (id, mode, epoch, changed_at, revision, write_id) VALUES (1,'cloudflare',1,'2026-11-21T10:00:00.000Z',1,'w')");
 await stop(run(open2.env,'hold-rollback',{generation:2,...open2.snap2}),'letterboxd_not_closed');
}
// export: failures
{
 const {env,snap2}=await (async()=>{
  const e=await imported();await run(e,'hold',{generation:0,...FORWARD});await run(e,'activate',{generation:1,...FORWARD});await run(e,'release',{generation:2,...RELEASE});
  const ptr=pointer(e.file);return {env:e,snap2:{count:30,sha256:ptr.list_sha256,snapshotId:'snap-1',version:Number(ptr.version),revision:Number(ptr.revision)}};
 })();
 await run(env,'hold-rollback',{generation:2,...snap2});
 // the published list already equals the snapshot (nothing advanced): a receipt, no write
 const args={generation:3,...snap2,run:RUN,epgGeneration:515};
 assert.equal((await run(env,'export-rollback',args)).outcome,'already_exported');
 // make the snapshot differ so a write is needed
 sqlite(env.file,"UPDATE published_epg_document SET payload_json=replace(payload_json,'Film 11','Film Eleven') WHERE kind='watchlist'");
 // an unproven transport outcome is write_uncertain and never retried
 let attempts=0;
 const timing={prepare:sql=>env.db.prepare(sql),batch:async()=>{attempts++;throw new D1Error('write_uncertain','response lost');}};
 states.length=0;
 await stop(Op.execute('export-rollback',{binding:timing,args,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(states.at(-1),'unknown');assert.equal(attempts,1,'no retry');
 const cli=await Op.runWatchlistCutoverProduction({argv:['node','x','--export-rollback','--target','iptv','--confirm','export-rollback','--expect-generation','3','--expect-run',RUN,'--expect-epg-generation','515','--expect-count','30','--expect-sha256',snap2.sha256,'--expect-snapshot-id','snap-1','--expect-version',String(snap2.version),'--expect-revision',String(snap2.revision)],deps:{binding:timing},now:()=>NOW});
 assert.equal(cli.exit,3);assert.equal(cli.result.reason,'write_uncertain');assert.equal(cli.result.retry,false);assert.equal(cli.result.writes,null);
 // the EPG generation moves under the export: nothing is committed over the other writer
 const racing={prepare:sql=>env.db.prepare(sql),batch:async s=>{sqlite(env.file,"UPDATE published_epg_authority SET generation=generation+1");return asStatement(()=>env.db.batch(s));}};
 const lostCas=await stop(Op.execute('export-rollback',{binding:racing,args,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(rows(env.file,"SELECT payload_json FROM published_epg_document WHERE kind='watchlist' ORDER BY ordinal").map(r=>r.payload_json).join('').includes('Film Eleven'),true,'the document was not replaced over the other writer');
 void lostCas;
}

// ===== 8. review: the export is fenced at its own commit; no rollback over undrained effects; the revert proves the document, not only the ids =====
{
 const setup=async opts=>{
  const e=await imported();
  await run(e,'hold',{generation:0,...FORWARD});await run(e,'activate',{generation:1,...FORWARD});await run(e,'release',{generation:2,...RELEASE});
  const next=FILMS.map(f=>({id:f.id,title:f.title,year:f.year,url:f.url}));next[3]={id:'film-new',title:'A New Film',year:2024,url:'https://letterboxd.com/film/film-new/'};
  assert.equal((await publishSnapshot(e.db,next,{scanId:'scan-2',observedAt:'2026-11-21T20:00:00.000Z',completedAt:'2026-11-21T20:00:30.000Z',runId:'lb-run-2'},{snapshotId:'snap-2',now:NOW})).ok,true);
  if(!opts?.keepPending)for(const effect of EFFECTS)assert.equal((await completeEffect(e.db,{snapshotId:'snap-2',effect,receipt:'done'},{now:NOW})).ok,true);
  const ptr=pointer(e.file);
  return {e,next,snap2:{count:30,sha256:ptr.list_sha256,snapshotId:'snap-2',version:Number(ptr.version),revision:Number(ptr.revision)}};
 };
 const storedFilms=file=>JSON.parse(rows(file,"SELECT payload_json FROM published_epg_document WHERE programme_run_id='"+RUN+"' AND kind='watchlist' ORDER BY ordinal").map(r=>r.payload_json).join('')).films;
 const authority=file=>rows(file,'SELECT generation, finalized_run_id FROM published_epg_authority')[0];
 const members=file=>rows(file,"SELECT film_id FROM published_epg_member WHERE programme_run_id='"+RUN+"' AND kind='watchlist' ORDER BY ordinal").map(r=>r.film_id).join(',');
 // ---- P1: undrained causal effects stop the rollback at every step
 {
  const {e,snap2}=await setup({keepPending:true});
  assert.equal(Number(pointer(e.file).effects_drained_version),1,'the new snapshot has pending effects');
  const undrained=await stop(run(e,'hold-rollback',{generation:2,...snap2}),'effects_pending');
  assert.deepEqual([undrained.details.version,undrained.details.drainedVersion],[2,1]);assert.deepEqual(marker(e.file),{mode:'d1',writes:'open',generation:2},'nothing moved');
  // drained, then a new pending effect row appears: the export and the revert refuse as well
  for(const effect of EFFECTS)await completeEffect(e.db,{snapshotId:'snap-2',effect,receipt:'done'},{now:NOW});
  const ptr=pointer(e.file);const pins={count:30,sha256:ptr.list_sha256,snapshotId:'snap-2',version:Number(ptr.version),revision:Number(ptr.revision)};
  await run(e,'hold-rollback',{generation:2,...pins});
  sqlite(e.file,"DROP TRIGGER IF EXISTS watchlist_effect_monotonic;UPDATE watchlist_effect SET status='pending', receipt=NULL, done_at=NULL WHERE snapshot_id='snap-2' AND effect='retention'");
  await stop(run(e,'export-rollback',{generation:3,...pins,run:RUN,epgGeneration:515}),'effects_pending');
 }
 const injected=async(label,mutate,{pre=null}={})=>{
  const {e,snap2}=await setup();await run(e,'hold-rollback',{generation:2,...snap2});
  if(pre)sqlite(e.file,pre);
  const args={generation:3,...snap2,run:RUN,epgGeneration:515};
  // count the batches of a normal export on a twin, then inject right before the LAST one (the final replacement)
  const twin=await setup();await run(twin.e,'hold-rollback',{generation:2,...twin.snap2});
  let total=0;
  await Op.execute('export-rollback',{binding:{prepare:sql=>twin.e.db.prepare(sql),batch:async b=>{total++;return twin.e.db.batch(b);}},args:{generation:3,...twin.snap2,run:RUN,epgGeneration:515},now:NOW});
  assert.equal(total>=4,true,'the staged writer sends several batches: '+total);
  let index=0;
  const before={films:JSON.stringify(storedFilms(e.file)),members:members(e.file),authority:authority(e.file),marker:marker(e.file)};
  const binding={prepare:sql=>e.db.prepare(sql),batch:async b=>{index++;if(index===total)sqlite(e.file,mutate);return asStatement(()=>e.db.batch(b));}};
  states.length=0;
  const error=await stop(Op.execute('export-rollback',{binding,args,now:NOW,ctx:trackedCtx()}),'export_refused');
  assert.equal(error.details.authoritative,'unchanged',label);
  assert.equal(JSON.stringify(storedFilms(e.file)),before.films,label+': the stored document did not change');
  assert.equal(members(e.file),before.members,label+': the member rows did not change');
  assert.equal(authority(e.file).generation,before.authority.generation,label+': the EPG generation did not move');
  assert.equal(rows(e.file,"SELECT COUNT(*) AS n FROM published_epg_stage WHERE programme_run_id LIKE '%#watchlist#%'")[0].n,0,label+': the staging rows were cleaned');
  // the staging batches DID write: the operator reports unknown, never none, and no retry
  assert.equal(states.at(-1),'unknown',label+': staged writes are not "no writes"');assert.equal(error.details.batches.completed>=1,true,label);
 };
 await injected('a lease appears',"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify({schemaVersion:1,holder:'h',expiresAt:'2026-11-21T19:00:00.000Z',released:false})+"',1,'2026-11-21T17:59:00.000Z')");
 await injected('a running control record',"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('control','"+JSON.stringify({schemaVersion:1,phase:'running',budget:{consecutive:0,total:0}})+"',1,'2026-11-21T17:59:00.000Z')");
 await injected('the Letterboxd mode appears',"INSERT INTO letterboxd_sync_mode (id, mode, epoch, changed_at, revision, write_id) VALUES (1,'cloudflare',1,'2026-11-21T17:59:00.000Z',1,'w')");
 await injected('the pointer moves',"UPDATE watchlist_current SET revision=revision+1");
 await injected('the marker is released',"UPDATE watchlist_authority SET writes='open'");
 await injected('the marker is reverted',"UPDATE watchlist_authority SET mode='epg'");
 await injected('the publication is uncertified',"UPDATE published_epg_authority SET finalized_run_id=NULL");
 await injected('a causal effect reopens',"DROP TRIGGER watchlist_effect_monotonic;UPDATE watchlist_effect SET status='pending', receipt=NULL, done_at=NULL WHERE snapshot_id='snap-2' AND effect='scan_facts'");
 // ---- P2: a failure after successful staging is not "no writes"; a failure of the first batch is
 {
  const {e,snap2}=await setup();await run(e,'hold-rollback',{generation:2,...snap2});
  const args={generation:3,...snap2,run:RUN,epgGeneration:515};
  // the very first batch is a proven rejection: nothing was written, writeState none
  states.length=0;
  const first=await stop(Op.execute('export-rollback',{binding:{prepare:sql=>e.db.prepare(sql),batch:async()=>{throw new D1Error('statement','rejected');}},args,now:NOW,ctx:trackedCtx()}),'export_refused');
  assert.equal(first.details.batches.completed,0);assert.equal(states.at(-1),'none','a rejected first batch wrote nothing');
  // a rejection AFTER the staging batches committed: the generation is unchanged but the staging rows may exist
  let call=0;
  const later={prepare:sql=>e.db.prepare(sql),batch:async b=>{call++;if(call===3)throw new D1Error('statement','rejected later');return e.db.batch(b);}};
  states.length=0;
  const after=await stop(Op.execute('export-rollback',{binding:later,args,now:NOW,ctx:trackedCtx()}),'export_refused');
  assert.equal(states.at(-1),'unknown','earlier batches committed: not proven writeState none');assert.equal(after.details.batches.completed,2);
  assert.equal(after.details.authoritative,'unchanged');assert.equal(Array.isArray(after.details.stage)&&after.details.stage.length>=1,true,'the surviving staging evidence is reported');
  const cli=await Op.runWatchlistCutoverProduction({argv:['node','x','--export-rollback','--target','iptv','--confirm','export-rollback','--expect-generation','3','--expect-run',RUN,'--expect-epg-generation','515','--expect-count','30','--expect-sha256',snap2.sha256,'--expect-snapshot-id','snap-2','--expect-version',String(snap2.version),'--expect-revision',String(snap2.revision)],deps:{binding:{prepare:sql=>e.db.prepare(sql),batch:async()=>{throw new D1Error('write_uncertain','lost');}}},now:()=>NOW});
  assert.equal(cli.result.retry,false);
 }
 // ---- P2: the revert proves the stored document (title, year, url), the certificate and the exact generation
 {
  // same ids and order, different payload: revert without export is refused
  const {e,snap2}=await setup();await run(e,'hold-rollback',{generation:2,...snap2});
  // the published list carries the snapshot's ids and order but another title
  const exported=await run(e,'export-rollback',{generation:3,...snap2,run:RUN,epgGeneration:515});
  const gen=exported.published.generation;
  sqlite(e.file,"UPDATE published_epg_document SET payload_json=replace(payload_json,'A New Film','A Different Title') WHERE kind='watchlist'");
  const revert={generation:3,...snap2,run:RUN,epgGeneration:gen};
  const e1=await stop(run(e,'revert-authority',revert),'parity_mismatch');assert.deepEqual(e1.details.problems,['document_digest']);
  assert.deepEqual(marker(e.file),{mode:'d1',writes:'held',generation:3});
  // restore the document: the revert succeeds without a new export (the already-equal path)
  sqlite(e.file,"UPDATE published_epg_document SET payload_json=replace(payload_json,'A Different Title','A New Film') WHERE kind='watchlist'");
  // an uncertified publication is refused
  sqlite(e.file,"UPDATE published_epg_authority SET finalized_run_id=NULL");
  await stop(run(e,'revert-authority',revert),'published_not_certified');
  sqlite(e.file,"UPDATE published_epg_authority SET finalized_run_id='"+RUN+"'");
  // a replacement between the read and the commit: the stored payload digest and the generation are pinned in the batch
  const racing={prepare:sql=>e.db.prepare(sql),batch:async b=>{sqlite(e.file,"UPDATE published_epg_generation SET payload_sha256='"+'9'.repeat(64)+"' WHERE programme_run_id='"+RUN+"'");return asStatement(()=>e.db.batch(b));}};
  await stop(Op.execute('revert-authority',{binding:racing,args:revert,now:NOW,ctx:trackedCtx()}),'predicate_refused');assert.deepEqual(marker(e.file),{mode:'d1',writes:'held',generation:3});
 }
}

// ===== 9. C3: the root watchlist mirror fence before the switch =====
{
 const held=async()=>{const e=await imported();await run(e,'hold',{generation:0,...FORWARD});return e;};
 const text=env=>env.store.objects.get('watchlist.json').text;
 // the fence: the same list, a new etag, written by a conditional put on the etag read
 {
  const e=await held();const before=e.store.etag('watchlist.json');const original=JSON.parse(text(e));
  states.length=0;
  const fenced=await Op.execute('fence-root',{binding:e.db,args:{generation:1,rootEtag:before},now:NOW,ctx:trackedCtx(),readStore:e.store,writeStoreFactory:e.writeFactory});
  assert.equal(fenced.writeState,'committed');assert.deepEqual(states,['unknown','committed']);
  assert.notEqual(fenced.root.etag,before,'the etag changed');assert.equal(fenced.root.previousEtag,before);assert.match(fenced.next,/--expect-root-etag/);
  assert.deepEqual(JSON.parse(text(e)),original,'the parsed list is the same');assert.equal(text(e).endsWith('\n'),true);
  assert.equal(e.store.log.filter(l=>l==='put watchlist.json').length,1);
  // a repeat with the etag read before is a lost compare-and-swap: root_moved, nothing written
  states.length=0;
  await stop(Op.execute('fence-root',{binding:e.db,args:{generation:1,rootEtag:before},now:NOW,ctx:trackedCtx(),readStore:e.store,writeStoreFactory:e.writeFactory}),'root_moved');
  assert.equal(e.store.log.filter(l=>l==='put watchlist.json').length,1);
  // activate needs the etag the fence produced
  await stop(Op.execute('activate',{binding:e.db,args:{generation:1,...FORWARD,rootEtag:before},now:NOW,readStore:e.store}),'root_fence_mismatch');
  await stop(Op.execute('activate',{binding:e.db,args:{generation:1,...FORWARD,rootEtag:fenced.root.etag},now:NOW}),'root_store_required');
  assert.deepEqual(marker(e.file),{mode:'epg',writes:'held',generation:1},'a refused activate moved nothing');
  const done=await Op.execute('activate',{binding:e.db,args:{generation:1,...FORWARD,rootEtag:fenced.root.etag},now:NOW,readStore:e.store});
  assert.deepEqual(done.marker,{mode:'d1',writes:'held',generation:2});
  // a writer that got through after the fence changes the root again: the fence is repeated, never assumed
  const e2=await held();
  const f2=await Op.execute('fence-root',{binding:e2.db,args:{generation:1,rootEtag:e2.store.etag('watchlist.json')},now:NOW,readStore:e2.store,writeStoreFactory:e2.writeFactory});
  e2.store.objects.set('watchlist.json',{text:'{"films":[],"updatedAt":"x"}',etag:md5('{"films":[],"updatedAt":"x"}')});
  await stop(Op.execute('activate',{binding:e2.db,args:{generation:1,...FORWARD,rootEtag:f2.root.etag},now:NOW,readStore:e2.store}),'root_fence_mismatch');
 }
 // refusals
 {
  const open=await imported();
  await stop(Op.execute('fence-root',{binding:open.db,args:{generation:0,rootEtag:open.store.etag('watchlist.json')},now:NOW,readStore:open.store,writeStoreFactory:open.writeFactory}),'state_mismatch');
  const e=await held();const etag=e.store.etag('watchlist.json');
  await stop(Op.execute('fence-root',{binding:e.db,args:{generation:1,rootEtag:etag},now:NOW,readStore:e.store}),'root_store_required');
  e.store.objects.set('watchlist.json',{text:'not json',etag:md5('not json')});
  await stop(Op.execute('fence-root',{binding:e.db,args:{generation:1,rootEtag:md5('not json')},now:NOW,readStore:e.store,writeStoreFactory:e.writeFactory}),'root_unreadable');
  e.store.objects.delete('watchlist.json');
  await stop(Op.execute('fence-root',{binding:e.db,args:{generation:1,rootEtag:etag},now:NOW,readStore:e.store,writeStoreFactory:e.writeFactory}),'root_absent');
 }
 // failures: a root changed by another writer between the read and the put loses the compare-and-swap (nothing written); an unproven put is write_uncertain, never retried
 {
  const e=await held();const etag=e.store.etag('watchlist.json');
  e.store.beforePut=async()=>{e.store.objects.set('watchlist.json',{text:'{"films":[],"updatedAt":"y"}',etag:md5('{"films":[],"updatedAt":"y"}')});e.store.beforePut=null;};
  states.length=0;
  await stop(Op.execute('fence-root',{binding:e.db,args:{generation:1,rootEtag:etag},now:NOW,ctx:trackedCtx(),readStore:e.store,writeStoreFactory:e.writeFactory}),'root_moved');
  assert.equal(states.at(-1),'none','a lost compare-and-swap wrote nothing');
  const f=await held();let puts=0;
  const timed={...f.store,get:f.store.get,head:f.store.head,put:async()=>{puts++;throw new Error('connection reset');}};
  states.length=0;
  const unproven=await stop(Op.execute('fence-root',{binding:f.db,args:{generation:1,rootEtag:f.store.etag('watchlist.json')},now:NOW,ctx:trackedCtx(),readStore:f.store,writeStoreFactory:()=>timed}),'write_uncertain');
  assert.equal(states.at(-1),'unknown');assert.equal(puts,1,'no retry');assert.equal(unproven.details.root.fenced,false);
  // a lost reply after the object changed: write_uncertain, with the fenced root reported
  const g=await held();
  const lost={...g.store,put:async(key,t,o)=>{await g.store.put(key,t,o);throw new Error('reply lost');}};
  const reached=await stop(Op.execute('fence-root',{binding:g.db,args:{generation:1,rootEtag:g.store.etag('watchlist.json')},now:NOW,ctx:trackedCtx(),readStore:g.store,writeStoreFactory:()=>lost}),'write_uncertain');
  assert.equal(reached.details.root.fenced,true);
  const cli=await Op.runWatchlistCutoverProduction({argv:['node','x','--fence-root','--target','iptv','--confirm','fence-root','--expect-generation','1','--expect-root-etag',md5('z')],deps:{binding:f.db,readStore:f.store,writeStoreFactory:()=>timed},now:()=>NOW});
  assert.equal(cli.result.reason,'root_moved');
 }
 // the drain, end to end with the EPG-side writer of the Worker: an in-flight writer that read the root before the fence loses its put; a new one is blocked by the held marker; after the flip nothing writes
 {
  const e=await imported();
  const newer={updatedAt:'2026-11-21T17:00:00.000Z',films:[{id:'film-9',title:'Late',year:2001,url:'https://letterboxd.com/film/film-9/'}]};
  // the writer read the object and passed the marker check (epg/open) when the cutover starts
  const bucket={get:e.store.get,head:e.store.head,put:async(key,t,o)=>{
   if(!bucket.started){bucket.started=true;await run(e,'hold',{generation:0,...FORWARD});await Op.execute('fence-root',{binding:e.db,args:{generation:1,rootEtag:e.store.etag('watchlist.json')},now:NOW,readStore:e.store,writeStoreFactory:e.writeFactory});}
   return e.store.put(key,t,o);}};
  const out=await PublishedEpg.putWatchlistRoot({DB:e.db,BUCKET:bucket},newer);
  assert.equal(out.etag,null,'the in-flight writer lost its compare-and-swap');
  assert.equal(JSON.parse(text(e)).films.length,30,'the root keeps the published list');
  // a writer that starts now finds the marker held; after the switch and the release it finds d1
  assert.equal((await PublishedEpg.putWatchlistRoot({DB:e.db,BUCKET:e.store},newer)).blocked,true);
  await run(e,'activate',{generation:1,...FORWARD,rootEtag:e.store.etag('watchlist.json')});
  assert.equal((await PublishedEpg.putWatchlistRoot({DB:e.db,BUCKET:e.store},newer)).blocked,true);
  await run(e,'release',{generation:2,...RELEASE});
  assert.equal((await PublishedEpg.putWatchlistRoot({DB:e.db,BUCKET:e.store},newer)).blocked,true,'d1/open: the root belongs to the Watchlist');
 }
}
console.log('watchlist cutover: ok');
