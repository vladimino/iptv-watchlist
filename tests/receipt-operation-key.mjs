// AIR-600 R1 (ADR 0207 decision 3, 0207-U1 = K2): the receipt operation key. migrations/0039_receipt_operation_key.sql, the keyed reservation of src/canonical-receipts.js and the protocol of
// src/receipt-operation-key.js, dormant. sqlite3-CLI D1 stand-in only: no Worker, R2, D1 or Cloudflare access, no production record. Covered:
//   1. the migration: refusal of anything but a complete previous version (and of a second apply), legacy rows kept with a NULL key, the key CHECK, the partial unique index (one unresolved
//      attempt per origin and key; terminal states free it; NULL keys never collide), the immutable key, and the statement-by-statement apply D1's REST batch uses;
//   2. absent or partial schema: legacy receipts unchanged, every keyed call refused before any write, validation before any read;
//   3. reservation under a key, the deterministic request id, and a settled replay that writes nothing;
//   4. concurrent attempts: a live attempt is never stolen (wait), two digests at one history (one wins, the loser replans), the same content at one history, a stale fingerprint refused;
//   5. a lost response (and a lost response followed by a merge redirect) settled from the applied receipt, never written twice;
//   6. expiry: a pending attempt inside its window waits, past it is abandoned (`superseded_by_retry`) before the next reservation, and its original tail can then never land; failed and unknown too;
//   7. a terminal outcome finalized atomically against the observed fingerprint: the loser of the source-changed race writes nothing and replans; a refusal for another reason is reported as such;
//   8. applied receipts are never trusted without the caller's current-state check;
//   9. bounds: history cap, bounded replans, an abandon that loses its race re-reads;
//  10. legacy callers at schema 39 and origin scoping; 11. dormant wiring.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {mutateFilm,fenced} from '../src/canonical-mutations.js';
import {readAuthority} from '../src/film-person-authority.js';
import {receiptedWrite,readReceipt,listAttention,reconcileReceipts,defineOperation,operationRegistry,operationKeyStatus,operationHistoryCondition,normalizeOperationKey,digestOf,requestIdOf} from '../src/canonical-receipts.js';
import * as K from '../src/receipt-operation-key.js';
import {migrationStatements} from '../scripts/published-epg-production.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-operation-key-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const exec=(file,text)=>{const result=sqlite(file,text);if(result.status!==0)throw new Error(result.stderr);return result;};
const rows=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const value=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const code=expected=>error=>{assert.equal(error.code,expected);return true;};

// The migration is found by name, so a renumbering at merge changes nothing here: its chain is every file below it.
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const MIGRATION=files.find(name=>name.endsWith('_receipt_operation_key.sql'));
assert.ok(MIGRATION,'the operation key migration exists');
const N=Number(MIGRATION.slice(0,4));
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const chainBelow=upTo=>files.filter(name=>Number(name.slice(0,4))<upTo);
const version=file=>Number(value(file,'SELECT version FROM schema_contract WHERE id=1'));
const before=path.join(root,'before.sqlite');exec(before,chainBelow(N).map(read).join('\n'));
const older=path.join(root,'older.sqlite');exec(older,chainBelow(N-1).map(read).join('\n'));
const template=path.join(root,'template.sqlite');fs.copyFileSync(before,template);exec(template,read(MIGRATION));
let n=0;
const copy=source=>{const file=path.join(root,'k-'+(n++)+'.sqlite');fs.copyFileSync(source,file);return file;};
// Film/Person at d1/open (generation 2) with the receipt activation baseline of an empty canonical_revision, as production has it.
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const T0=Date.parse('2026-11-24T10:00:00.000Z');
const iso=ms=>new Date(T0+ms).toISOString();
const clockAt=ms=>()=>iso(ms);
const T=iso(0);
function open(source=template){
 const file=copy(source);
 exec(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+
  "INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+T+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','"+T+"');"+
  "CREATE TABLE test_outcome (item TEXT PRIMARY KEY, outcome TEXT NOT NULL) STRICT;");
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const DIGEST='a'.repeat(64);
// A receipt row written in SQL, as an earlier attempt left it. `key` undefined writes the pre-39 column list.
const receiptSql=({id,key,origin='o_test',target='film:tmdb:1',at=T})=>"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at"+(key===undefined?'':',operation_key')+") VALUES ('"+id+"','film_mutation','"+origin+"','film','"+target+"','"+DIGEST+"',0,2,'pending',1,'"+at+"','"+at+"','"+at+"'"+(key===undefined?'':','+(key===null?'NULL':"'"+key+"'"))+")";
const ORIGIN='o_test',KEY='admission:lid:2bg8';
const MOVIE_A='film:tmdb:1',MOVIE_B='film:tmdb:2',MOVIE_C='film:tmdb:3';
const revisionOf=(file,id)=>Number(value(file,"SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+id+"'),0)")||0);
const titleOf=(file,id)=>value(file,"SELECT original_title FROM film WHERE id='"+id+"'");
const keyed=(file,key=KEY,origin=ORIGIN)=>rows(file,"SELECT request_id,state,attempts,error_class,operation_key FROM canonical_write_receipt WHERE origin='"+origin+"' AND operation_key='"+key+"' ORDER BY created_at,request_id");
const receiptCount=file=>Number(value(file,'SELECT COUNT(*) FROM canonical_write_receipt'));
// The writer of these scenarios: one fenced canonical mutation of the intended Film carrying the receipt tail (atomic mode), the effect the key protects.
const writer=(env,movie,title)=>async ctx=>{
 await mutateFilm(env,{id:movie,expectedRevision:ctx.currentRevision,at:T,film:{contractVersion:1,originalTitle:title},receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:T,target:{kind:'film',id:movie}}});
 return {revision:ctx.currentRevision+1};
};
const reserving=(env,file,movie,title=movie)=>async()=>({kind:'reserve',request:{operation:'film_mutation',target:{kind:'film',id:movie},expectedRevision:revisionOf(file,movie),digest:await digestOf({movie,title}),source:{movie,title}},write:{run:writer(env,movie,title),readback:async()=>null,atomic:true}});
// The caller's current-state check: an applied attempt is `settled` for this work only when it admitted the movie this work intends AND that Film is still there (under its id or the one it was merged into).
const intends=(file,movie)=>async(receipt,{currentTarget})=>receipt.target.id===movie&&titleOf(file,currentTarget.id)!=null?'settled':'historical';
// A terminal outcome that reserves nothing, in its own fenced batch with the history guard (the stand-in of a writer's pending-state record).
const finalizing=(env,item,outcome,extra=[])=>async guard=>{
 const gate=await readAuthority(env);const db=env.DB;
 const statements=[...fenced.head(gate,[]),[fenced.assertSql(guard.sql),guard.params],...extra,['INSERT INTO test_outcome (item,outcome) VALUES (?,?)',[item,outcome]]];
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));return {written:true};}
 catch(error){if(/CHECK constraint failed/i.test(String(error?.message)))return {refused:true};throw error;}
};
// A binding whose batches can be intercepted: `before` runs ahead of the real batch (and may throw instead), `after` runs once it committed (and may throw: a lost response).
function intercept(env,{before,after}={}){
 const real=env.DB;
 return {DB:{calls:real.calls,prepare:(...args)=>real.prepare(...args),batch:async list=>{if(before)await before(list);const out=await real.batch(list);if(after)await after(list);return out;}},real};
}
const appliedIn=list=>list.some(item=>/SET state='applied'/.test(item.text));

// ---- 1. The migration --------------------------------------------------------------------------------------------------
{
 assert.equal(version(before),N-1);assert.equal(version(template),N);
 const columns=rows(template,"SELECT name FROM pragma_table_info('canonical_write_receipt')").map(row=>row.name);
 assert.ok(columns.includes('operation_key'),'the column exists');
 assert.equal(value(template,"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='canonical_write_receipt_operation_unresolved' AND sql LIKE '%UNIQUE%' AND sql LIKE '%WHERE%'"),1,'the unresolved index is unique and partial');
 assert.equal(value(template,"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='canonical_write_receipt_operation_history' AND sql LIKE '%WHERE%'"),1,'the history index is partial');
 assert.equal(value(template,"SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='canonical_write_receipt_operation_key_immutable'"),1);
 // anything but a complete previous version is refused before a table changes
 const old=copy(older);
 assert.notEqual(sqlite(old,read(MIGRATION)).status,0,'a version below '+(N-1)+' is refused');
 assert.equal(version(old),N-2);
 assert.ok(!rows(old,"SELECT name FROM pragma_table_info('canonical_write_receipt')").some(row=>row.name==='operation_key'),'and the column was not added');
 const twice=copy(template);
 assert.notEqual(sqlite(twice,read(MIGRATION)).status,0,'a second apply is refused');assert.equal(version(twice),N);
 // every table present but another version (a contract already past it) is refused too: the version is part of the precondition
 const ahead=copy(before);exec(ahead,'UPDATE schema_contract SET version='+N+' WHERE id=1');
 assert.notEqual(sqlite(ahead,read(MIGRATION)).status,0,'a version other than '+(N-1)+' is refused');
 assert.ok(!rows(ahead,"SELECT name FROM pragma_table_info('canonical_write_receipt')").some(row=>row.name==='operation_key'));
 // legacy receipts written before the apply keep every value and get a NULL key
 // (explicit columns: the test harness keeps one sqlite3 connection per file, and `SELECT *` on it does not see a column another connection added)
 const legacy=open(before);
 exec(legacy,receiptSql({id:'legacy-1'}));
 const COLS='request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,applied_revision,marker_generation,state,attempts,next_attempt_at,error_class,created_at,updated_at,settled_at';
 const prior=rows(legacy,'SELECT '+COLS+' FROM canonical_write_receipt')[0];
 exec(legacy,read(MIGRATION));
 const after=rows(legacy,'SELECT '+COLS+',operation_key FROM canonical_write_receipt')[0];
 assert.equal(after.operation_key,null);delete after.operation_key;assert.deepEqual(after,prior,'an existing receipt is untouched');
 // the key is an identifier: a lowercase namespace, a colon, the request id alphabet, 3 to 200
 const file=open();
 const bad=['Admission:lid:1','admission:','ad','admission:a b',"admission:lid:'x'",'adm-ission:x','admission:lid:é',':x','admission:'+'x'.repeat(200)];
 bad.forEach((key,i)=>assert.match(sqlite(file,receiptSql({id:'bad-'+i,key:key.replace(/'/g,"''")})).stderr,/CHECK constraint failed/,'refused key '+JSON.stringify(key)));
 for(const key of ['admission:lid:2bg8','admission:short_code:abc','evidence:3f2a/b=c+d@e.f','retention:film:tmdb:1'])exec(file,receiptSql({id:'ok-'+key.replace(/[^a-z0-9]/g,''),key})+";UPDATE canonical_write_receipt SET state='abandoned',error_class='superseded_by_retry',next_attempt_at=NULL,settled_at='"+T+"' WHERE operation_key='"+key+"'");
 // one unresolved attempt per (origin, key): pending, failed and unknown all hold it; applied and abandoned free it; another origin and NULL keys never collide
 const idx=open();
 exec(idx,receiptSql({id:'u-1',key:KEY}));
 assert.match(sqlite(idx,receiptSql({id:'u-2',key:KEY})).stderr,/UNIQUE constraint failed: canonical_write_receipt\.origin, canonical_write_receipt\.operation_key/);
 exec(idx,receiptSql({id:'u-3',key:KEY,origin:'o_other'}));
 exec(idx,receiptSql({id:'u-4',key:null})+';'+receiptSql({id:'u-5',key:null})+';'+receiptSql({id:'u-6'}));
 // (failed never moves to unknown directly: the 0019 state machine goes through a new attempt)
 for(const [state,extra] of [['failed',",error_class='film_person_fence'"],['unknown',",error_class='unclassified'"]]){
  if(state==='unknown')exec(idx,"UPDATE canonical_write_receipt SET state='pending',attempts=2,error_class=NULL WHERE request_id='u-1'");
  exec(idx,"UPDATE canonical_write_receipt SET state='"+state+"'"+extra+" WHERE request_id='u-1'");
  assert.match(sqlite(idx,receiptSql({id:'u-2',key:KEY})).stderr,/UNIQUE constraint failed/,state+' still holds the key');
 }
 exec(idx,"UPDATE canonical_write_receipt SET state='abandoned',error_class='superseded_by_retry',next_attempt_at=NULL,settled_at='"+T+"' WHERE request_id='u-1'");
 exec(idx,receiptSql({id:'u-2',key:KEY}));
 // the key never changes, not even from NULL
 assert.match(sqlite(idx,"UPDATE canonical_write_receipt SET operation_key='admission:lid:other' WHERE request_id='u-2'").stderr,/canonical_receipt_immutable/);
 assert.match(sqlite(idx,"UPDATE canonical_write_receipt SET operation_key='admission:lid:late' WHERE request_id='u-4'").stderr,/canonical_receipt_immutable/);
 assert.match(sqlite(idx,"UPDATE canonical_write_receipt SET operation_key=NULL WHERE request_id='u-2'").stderr,/canonical_receipt_immutable/);
 // the triggers of 0019 still hold for a keyed row: no delete, terminal states stay terminal
 assert.match(sqlite(idx,"DELETE FROM canonical_write_receipt WHERE request_id='u-1'").stderr,/canonical_receipt_delete/);
 assert.match(sqlite(idx,"UPDATE canonical_write_receipt SET state='pending',attempts=attempts+1,next_attempt_at='"+T+"',settled_at=NULL,error_class=NULL WHERE request_id='u-1'").stderr,/canonical_receipt_transition/);
 // the production apply path sends one statement per entry (D1's REST batch): the split gives the same schema
 const statements=migrationStatements(read(MIGRATION));
 assert.equal(statements.length,7,'refusal guard, column, two indexes, two triggers, version');
 const split=copy(before);
 for(const statement of statements)exec(split,statement+';');
 assert.equal(version(split),N);
 const shape=f=>rows(f,"SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'canonical_write_receipt%' OR name='schema_contract_no_downgrade' ORDER BY type,name");
 assert.deepEqual(shape(split),shape(template));
 // the version never goes down
 assert.match(sqlite(copy(template),'UPDATE schema_contract SET version='+(N-1)+' WHERE id=1').stderr,/schema_contract_downgrade/);
}

// ---- 2. Absent or partial schema: legacy unchanged, keyed refused before any write, validation before any read ---------------
{
 const file38=open(before),file39=open(),partial=open();
 exec(partial,'DROP TRIGGER canonical_write_receipt_operation_key_immutable');
 const env38=envOf(file38),env39=envOf(file39),envPartial=envOf(partial);
 assert.equal(await operationKeyStatus(env38),'absent');
 assert.equal(await operationKeyStatus(env39),'ready');
 assert.equal(await operationKeyStatus(envPartial),'invalid','a partial apply is neither absent nor ready');
 await assert.rejects(()=>operationKeyStatus({DB:{prepare(){throw new Error('D1 down');}}}),code('film_person_unavailable'));
 // a legacy (unkeyed) receipted write is the same at schema 38 and 39, and leaves the key NULL
 for(const [file,env] of [[file38,env38],[file39,env39]]){
  const requestId=await requestIdOf({origin:ORIGIN,operation:'film_mutation',source:'legacy-event'});
  const done=await receiptedWrite(env,{requestId,operation:'film_mutation',origin:ORIGIN,target:{kind:'film',id:MOVIE_A},expectedRevision:0,digest:DIGEST,now:clockAt(0)},{run:writer(env,MOVIE_A,'Legacy'),readback:async()=>null,atomic:true});
  assert.equal(done.state,'applied');assert.equal(revisionOf(file,MOVIE_A),1);
  const again=await receiptedWrite(env,{requestId,operation:'film_mutation',origin:ORIGIN,target:{kind:'film',id:MOVIE_A},expectedRevision:0,digest:DIGEST,now:clockAt(1000)},{run:writer(env,MOVIE_A,'Legacy'),readback:async()=>null,atomic:true});
  assert.equal(again.already,true,'a legacy replay is the same answer as before');
  if(file===file39)assert.equal(value(file,"SELECT operation_key IS NULL FROM canonical_write_receipt WHERE request_id='"+requestId+"'"),1);
 }
 // every keyed call refuses at schema 38 and at a partial schema, before any write
 const keyedInput={requestId:'o_test:film_mutation:k',operation:'film_mutation',origin:ORIGIN,target:{kind:'film',id:MOVIE_B},expectedRevision:0,digest:DIGEST,operationKey:KEY,history:{count:0,applied:0},now:clockAt(0)};
 for(const [file,env,expected] of [[file38,env38,'receipt_operation_key_missing'],[partial,envPartial,'receipt_operation_key_invalid']]){
  const count=receiptCount(file);
  let ran=false;
  await assert.rejects(()=>receiptedWrite(env,keyedInput,{run:async()=>{ran=true;},readback:async()=>null,atomic:true}),code(expected));
  await assert.rejects(()=>K.readOperationHistory(env,{origin:ORIGIN,operationKey:KEY}),code(expected));
  await assert.rejects(()=>K.reconcileOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)}),code(expected));
  await assert.rejects(()=>K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{decide:async()=>{ran=true;}}),code(expected));
  assert.equal(ran,false,'no writer and no decision ran');assert.equal(receiptCount(file),count,'nothing was written');
 }
 // malformed keys, fingerprints and origins are refused before the database is touched
 const untouched={DB:{prepare(){throw new Error('touched');},batch(){throw new Error('touched');}}};
 for(const operationKey of ['Bad:key','admission','','admission: x'])await assert.rejects(()=>receiptedWrite(untouched,{...keyedInput,operationKey},{run:async()=>{},atomic:true}),code('film_person_invalid'));
 for(const history of [undefined,null,{count:-1,applied:0},{count:1,applied:2},{count:1.5,applied:0},{count:'1',applied:0}])await assert.rejects(()=>receiptedWrite(untouched,{...keyedInput,history},{run:async()=>{},atomic:true}),code('film_person_invalid'));
 await assert.rejects(()=>receiptedWrite(untouched,{...keyedInput,operationKey:undefined},{run:async()=>{},atomic:true}),code('film_person_invalid'),'a history without a key is refused');
 await assert.rejects(()=>K.reconcileOperationKey(untouched,{origin:'Bad',operationKey:KEY,now:clockAt(0)}),code('film_person_invalid'));
 await assert.rejects(()=>K.runOperationKey(untouched,{origin:ORIGIN,operationKey:'nope',now:clockAt(0)},{decide:async()=>({kind:'none'})}),code('film_person_invalid'));
 await assert.rejects(()=>K.keyedRequestIdOf({origin:ORIGIN,operation:'film_mutation',operationKey:KEY,ordinal:-1,source:'x'}),code('film_person_invalid'));
 assert.throws(()=>operationHistoryCondition({origin:ORIGIN,operationKey:KEY,fingerprint:{count:0}}),code('film_person_invalid'));
 assert.equal(normalizeOperationKey('admission:lid:2bg8'),'admission:lid:2bg8');
}

// ---- 3. Reservation under a key, the deterministic request id, a settled replay that writes nothing --------------------------
{
 const file=open(),env=envOf(file);
 const empty=await K.readOperationHistory(env,{origin:ORIGIN,operationKey:KEY});
 assert.deepEqual(empty.fingerprint,{count:0,applied:0});assert.deepEqual(empty.receipts,[]);
 const decided=[];
 const out=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{validate:intends(file,MOVIE_A),decide:async ctx=>{decided.push(ctx);return reserving(env,file,MOVIE_A,'Movie A')();}});
 assert.equal(out.status,'reserved');assert.equal(out.outcome.state,'applied');assert.equal(out.replans,0);
 assert.deepEqual(decided.map(ctx=>[ctx.ordinal,ctx.fingerprint]),[[0,{count:0,applied:0}]]);
 const expected=await K.keyedRequestIdOf({origin:ORIGIN,operation:'film_mutation',operationKey:KEY,ordinal:0,source:{movie:MOVIE_A,title:'Movie A'}});
 assert.equal(out.requestId,expected,'the request id is the key, the ordinal and the source identity');
 assert.equal(out.requestId,await K.keyedRequestIdOf({origin:ORIGIN,operation:'film_mutation',operationKey:KEY,ordinal:0,source:{title:'Movie A',movie:MOVIE_A}}),'deterministic (canonical JSON)');
 assert.notEqual(out.requestId,await K.keyedRequestIdOf({origin:ORIGIN,operation:'film_mutation',operationKey:KEY,ordinal:1,source:{movie:MOVIE_A,title:'Movie A'}}),'another ordinal is another request');
 assert.ok(!out.requestId.includes('2bg8')&&!out.requestId.includes('Movie'),'no key or source text in the id');
 assert.deepEqual(keyed(file).map(row=>[row.request_id,row.state,row.operation_key]),[[expected,'applied',KEY]]);
 const history=await K.readOperationHistory(env,{origin:ORIGIN,operationKey:KEY});
 assert.deepEqual(history.fingerprint,{count:1,applied:1});assert.equal(history.receipts[0].operationKey,KEY);
 assert.equal(revisionOf(file,MOVIE_A),1);assert.equal(titleOf(file,MOVIE_A),'Movie A');
 // the same item again: the applied attempt is validated against current state and reported; nothing is reserved or written
 let asked=false;
 const replay=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(60000)},{validate:intends(file,MOVIE_A),decide:async()=>{asked=true;return {kind:'none'};}});
 assert.equal(replay.status,'settled');assert.equal(replay.receipt.requestId,expected);assert.deepEqual(replay.currentTarget,{kind:'film',id:MOVIE_A,redirected:false});
 assert.equal(asked,false);assert.equal(revisionOf(file,MOVIE_A),1);assert.equal(keyed(file).length,1);
 // a `none` decision writes nothing
 const none=await K.runOperationKey(env,{origin:ORIGIN,operationKey:'admission:lid:other',now:clockAt(0)},{decide:async()=>({kind:'none',result:'not_now'})});
 assert.deepEqual([none.status,none.result],['none','not_now']);assert.equal(keyed(file,'admission:lid:other').length,0);
 await assert.rejects(()=>K.runOperationKey(env,{origin:ORIGIN,operationKey:'admission:lid:other',now:clockAt(0)},{decide:async()=>({kind:'unknown'})}),code('film_person_invalid'));
 await assert.rejects(()=>K.runOperationKey(env,{origin:ORIGIN,operationKey:'admission:lid:other',now:clockAt(0)},{}),code('film_person_invalid'));
}

// ---- 4. Concurrent attempts ----------------------------------------------------------------------------------------------
{
 // (a) a live attempt is never stolen: B runs while A's writer is in flight and waits; A then lands
 const file=open(),env=envOf(file);
 let seenByB=null;
 const slowA=async ctx=>{
  seenByB=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(30000)},{validate:intends(file,MOVIE_B),decide:async()=>{throw new Error('B must not decide while A is in flight');}});
  return writer(env,MOVIE_A,'Movie A')(ctx);
 };
 const a=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{decide:async()=>({...(await reserving(env,file,MOVIE_A,'Movie A')()),write:{run:slowA,readback:async()=>null,atomic:true}})});
 assert.equal(seenByB.status,'wait');assert.equal(seenByB.reason,'in_flight');assert.equal(seenByB.requestId,a.requestId);assert.equal(seenByB.dueAt,iso(120000));
 assert.equal(a.outcome.state,'applied');assert.deepEqual(keyed(file).map(row=>row.state),['applied'],'B abandoned nothing');
}
{
 // (b) two digests at one history: both read {0,0}; A reserves and lands first; B's reservation fails its assertion, B replans, finds A's applied attempt (another movie: historical) and reserves at ordinal 1
 const file=open(),env=envOf(file);
 const ordinals=[];
 const b=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{validate:intends(file,MOVIE_B),decide:async ctx=>{
  ordinals.push(ctx.ordinal);
  if(ordinals.length===1){
   const a=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{decide:reserving(env,file,MOVIE_A,'Movie A')});
   assert.equal(a.outcome.state,'applied');
  }else assert.deepEqual(ctx.historical.map(item=>item.receipt.target.id),[MOVIE_A]);
  return reserving(env,file,MOVIE_B,'Movie B')();
 }});
 assert.deepEqual(ordinals,[0,1]);assert.equal(b.status,'reserved');assert.equal(b.replans,1);assert.equal(b.outcome.state,'applied');
 assert.deepEqual(keyed(file).map(row=>row.state),['applied','applied']);
 assert.deepEqual((await K.readOperationHistory(env,{origin:ORIGIN,operationKey:KEY})).fingerprint,{count:2,applied:2});
 // a reservation against a stale fingerprint is refused in its own batch: no row, no write
 const count=receiptCount(file),rev=revisionOf(file,MOVIE_C);let ran=false;
 await assert.rejects(()=>K.reserveOperationKey(env,{requestId:'o_test:film_mutation:stale',operation:'film_mutation',origin:ORIGIN,target:{kind:'film',id:MOVIE_C},expectedRevision:0,digest:DIGEST,operationKey:KEY,fingerprint:{count:1,applied:1},now:clockAt(0)},{run:async()=>{ran=true;},readback:async()=>null,atomic:true}),code('operation_key_moved'));
 assert.equal(ran,false);assert.equal(receiptCount(file),count);assert.equal(revisionOf(file,MOVIE_C),rev);
 // the assertion also holds while an unresolved attempt exists at the observed count (an abandon or retry moves neither number)
 exec(file,receiptSql({id:'live',key:'admission:lid:live',at:iso(0)}));
 await assert.rejects(()=>K.reserveOperationKey(env,{requestId:'o_test:film_mutation:second',operation:'film_mutation',origin:ORIGIN,target:{kind:'film',id:MOVIE_C},expectedRevision:0,digest:DIGEST,operationKey:'admission:lid:live',fingerprint:{count:1,applied:0},now:clockAt(0)},{run:async()=>{ran=true;},readback:async()=>null,atomic:true}),code('operation_key_moved'));
 assert.equal(ran,false);
}
{
 // (c) the same content at one history computes the same request id: the second caller finds the id taken and replans, then waits on (or settles from) the first
 const file=open(),env=envOf(file);
 let inner=null,turns=0;
 const out=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{validate:intends(file,MOVIE_A),decide:async()=>{
  turns++;
  if(turns===1)inner=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{decide:reserving(env,file,MOVIE_A,'Movie A')});
  return reserving(env,file,MOVIE_A,'Movie A')();
 }});
 assert.equal(inner.status,'reserved');
 assert.equal(out.status,'settled','the loser replans and finds the winner applied for the same movie');assert.equal(out.replans,1);assert.equal(out.receipt.requestId,inner.requestId);
 assert.equal(keyed(file).length,1);assert.equal(revisionOf(file,MOVIE_A),1);
}

// ---- 5. Lost response, and a lost response followed by a merge redirect ------------------------------------------------------
{
 const file=open();
 let lose=true;
 const wrapped=intercept(envOf(file),{after:async list=>{if(lose&&appliedIn(list)){lose=false;throw new Error('Network connection lost');}}});
 await assert.rejects(()=>K.runOperationKey(wrapped,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{decide:reserving(wrapped,file,MOVIE_A,'Movie A')}),code('film_person_unavailable'));
 assert.deepEqual(keyed(file).map(row=>row.state),['applied'],'the batch landed with its receipt: atomic');assert.equal(revisionOf(file,MOVIE_A),1);
 const env=envOf(file);
 let asked=false;
 const retry=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(5000)},{validate:intends(file,MOVIE_A),decide:async()=>{asked=true;return reserving(env,file,MOVIE_A,'Movie A')();}});
 assert.equal(retry.status,'settled');assert.equal(asked,false,'the retry finds the applied attempt by key and writes nothing');
 assert.equal(revisionOf(file,MOVIE_A),1);assert.equal(keyed(file).length,1);
 // the Film is then merged into another one: the applied attempt is still found by key, and its target is followed through the redirect
 await mutateFilm(env,{id:MOVIE_C,expectedRevision:0,at:T,film:{contractVersion:1,originalTitle:'Movie C'}});
 exec(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+MOVIE_A+"','"+MOVIE_C+"','"+T+"')");
 let seen=null;
 const redirected=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(10000)},{validate:async(receipt,ctx)=>{seen=ctx.currentTarget;return intends(file,MOVIE_A)(receipt,ctx);},decide:async()=>{throw new Error('no decision');}});
 assert.deepEqual(seen,{kind:'film',id:MOVIE_C,redirected:true});
 assert.equal(redirected.status,'settled');assert.deepEqual(redirected.currentTarget,{kind:'film',id:MOVIE_C,redirected:true});
 // a redirect that does not resolve (a cycle) refuses
 exec(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+MOVIE_C+"','"+MOVIE_A+"','"+T+"')");
 await assert.rejects(()=>K.currentTargetOf(env,{kind:'film',id:MOVIE_A}),code('film_person_redirect'));
 assert.deepEqual(await K.currentTargetOf(env,{kind:'person',id:'person:director/1'}),{kind:'person',id:'person:director/1'});
}

// ---- 6. Expiry: wait inside the window, abandon past it, and the original tail never lands ------------------------------------
{
 const file=open();
 let cut=false,recorded=null;
 const dying=intercept(envOf(file),{before:async list=>{
  if(cut)throw new Error('invocation gone');
  if(appliedIn(list)){recorded=list;cut=true;throw new Error('invocation cut');}
 }});
 await assert.rejects(()=>K.runOperationKey(dying,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{decide:reserving(dying,file,MOVIE_A,'Movie A')}));
 const original=keyed(file);
 assert.deepEqual(original.map(row=>[row.state,row.attempts]),[['pending',1]],'the cut attempt stays pending: its outcome is not known');
 assert.ok(recorded,'its writer batch (mutation and receipt tail) was built and never ran');assert.equal(revisionOf(file,MOVIE_A),0);
 const env=envOf(file);
 // inside the window it is a live attempt
 const early=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(60000)},{decide:async()=>{throw new Error('no decision while in flight');}});
 assert.deepEqual([early.status,early.reason,early.requestId],['wait','in_flight',original[0].request_id]);
 assert.deepEqual(keyed(file).map(row=>row.state),['pending']);
 // past it, it is abandoned first, then the item is reserved anew at the next ordinal
 const decided=[];
 const late=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(180000)},{decide:async ctx=>{decided.push(ctx);return reserving(env,file,MOVIE_B,'Movie B')();}});
 assert.equal(late.status,'reserved');assert.equal(late.outcome.state,'applied');
 assert.deepEqual(decided.map(ctx=>[ctx.ordinal,ctx.fingerprint,ctx.abandoned]),[[1,{count:1,applied:0},[original[0].request_id]]]);
 assert.deepEqual(keyed(file).map(row=>[row.request_id===original[0].request_id,row.state,row.error_class]),[[true,'abandoned','superseded_by_retry'],[false,'applied',null]]);
 // the original in-flight batch arrives now: its tail matches no pending attempt, so the WHOLE batch rolls back
 const movieB=revisionOf(file,MOVIE_B);
 await assert.rejects(()=>dying.real.batch(recorded),/CHECK constraint failed/);
 assert.equal(revisionOf(file,MOVIE_A),0,'movie A never lands');assert.equal(titleOf(file,MOVIE_A),undefined);assert.equal(revisionOf(file,MOVIE_B),movieB);
 assert.equal(keyed(file)[0].state,'abandoned','abandoned is terminal');
 const attention=(await listAttention(env)).find(row=>row.requestId===original[0].request_id);
 assert.deepEqual([attention.errorClass,attention.needsReview],['superseded_by_retry',false],'a supersession stays visible and is not a repair');
}
{
 // `failed` and `unknown` attempts are abandoned whatever their backoff: only a live `pending` attempt waits
 const file=open(),env=envOf(file);
 exec(file,receiptSql({id:'f-1',key:'admission:lid:f'})+";UPDATE canonical_write_receipt SET state='failed',error_class='film_person_fence',next_attempt_at='"+iso(3600000)+"' WHERE request_id='f-1';"+
  receiptSql({id:'u-1',key:'admission:lid:u'})+";UPDATE canonical_write_receipt SET state='unknown',error_class='unclassified',next_attempt_at='"+iso(3600000)+"' WHERE request_id='u-1'");
 for(const key of ['admission:lid:f','admission:lid:u']){
  const state=await K.reconcileOperationKey(env,{origin:ORIGIN,operationKey:key,now:clockAt(1000)});
  assert.equal(state.status,'clear');assert.deepEqual(state.fingerprint,{count:1,applied:0});assert.equal(state.abandoned.length,1);
  assert.deepEqual(keyed(file,key).map(row=>[row.state,row.error_class]),[['abandoned','superseded_by_retry']]);
 }
 // the abandon is fenced by the marker: at another generation it refuses and changes nothing
 exec(file,receiptSql({id:'g-1',key:'admission:lid:g'})+";UPDATE canonical_write_receipt SET state='failed',error_class='film_person_fence' WHERE request_id='g-1'");
 exec(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 await assert.rejects(()=>K.reconcileOperationKey(env,{origin:ORIGIN,operationKey:'admission:lid:g',now:clockAt(1000)}));
 assert.equal(keyed(file,'admission:lid:g')[0].state,'failed');
}

// ---- 7. Finalize: the terminal outcome asserts the observed history in its own batch ------------------------------------------
{
 // the source-changed race of ADR 0207: A reads an empty history and decides `source_changed`; meanwhile B reserves and admits movie A. A's write fails its assertion, writes nothing, replans and
 // then reports the settled admission instead of the outcome computed from the old history.
 const file=open(),env=envOf(file);
 const turns=[];
 const a=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{validate:intends(file,MOVIE_A),decide:async ctx=>{
  turns.push(ctx.fingerprint);
  const b=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{decide:reserving(env,file,MOVIE_A,'Movie A')});
  assert.equal(b.outcome.state,'applied');
  return {kind:'finalize',write:finalizing(env,KEY,'source_changed')};
 }});
 assert.deepEqual(turns,[{count:0,applied:0}]);
 assert.equal(a.status,'settled');assert.equal(a.replans,1);
 assert.equal(rows(file,'SELECT * FROM test_outcome').length,0,'the stale terminal outcome was never written');
 // with the history unchanged it is written, once, in the same batch as its assertion
 const ok=await K.runOperationKey(env,{origin:ORIGIN,operationKey:'admission:lid:fresh',now:clockAt(0)},{decide:async()=>({kind:'finalize',write:finalizing(env,'admission:lid:fresh','source_unavailable')})});
 assert.deepEqual([ok.status,ok.result],['finalized',{written:true}]);
 assert.deepEqual(rows(file,'SELECT * FROM test_outcome'),[{item:'admission:lid:fresh',outcome:'source_unavailable'}]);
 // refused by ANOTHER guard of the caller's batch (an epoch, say) with the history unchanged: reported as refused, no replan
 const refused=await K.runOperationKey(env,{origin:ORIGIN,operationKey:'admission:lid:epoch',now:clockAt(0)},{decide:async()=>({kind:'finalize',write:finalizing(env,'admission:lid:epoch','other_code',[[fenced.assertSql('0'),[]]])})});
 assert.deepEqual([refused.status,refused.replans],['refused',0]);
 assert.equal(rows(file,"SELECT * FROM test_outcome WHERE item='admission:lid:epoch'").length,0);
 // the guard on its own: a canonical batch carrying `historyAssertion` of a moved history rolls back whole
 const stale=K.historyAssertion({origin:ORIGIN,operationKey:KEY,fingerprint:{count:0,applied:0}});
 const gate=await readAuthority(env);
 await assert.rejects(()=>env.DB.batch([...fenced.head(gate,[]),stale,['INSERT INTO test_outcome (item,outcome) VALUES (?,?)',['direct','x']]].map(([sql,params])=>env.DB.prepare(sql).bind(...params))),/CHECK constraint failed/);
 assert.equal(rows(file,"SELECT * FROM test_outcome WHERE item='direct'").length,0);
 const current=K.historyAssertion({origin:ORIGIN,operationKey:KEY,fingerprint:(await K.readOperationHistory(env,{origin:ORIGIN,operationKey:KEY})).fingerprint});
 await env.DB.batch([...fenced.head(gate,[]),current,['INSERT INTO test_outcome (item,outcome) VALUES (?,?)',['direct','x']]].map(([sql,params])=>env.DB.prepare(sql).bind(...params)));
 assert.equal(rows(file,"SELECT * FROM test_outcome WHERE item='direct'").length,1);
 // the guard is ONE boolean expression another domain can wrap in its own assertion (the Watchlist ledger, the Ratings fence); it holds for exactly the observed numbers
 const holds=(key,fingerprint)=>{const guard=K.historyGuard({origin:ORIGIN,operationKey:key,fingerprint});return Number(value(file,'SELECT ('+guard.sql.replace(/\?/g,()=>{const v=guard.params.shift();return typeof v==='number'?String(v):"'"+v+"'";})+')'));};
 assert.equal(holds(KEY,{count:1,applied:1}),1);
 for(const fingerprint of [{count:1,applied:0},{count:0,applied:0},{count:2,applied:1},{count:2,applied:2}])assert.equal(holds(KEY,fingerprint),0,'a moved history: '+JSON.stringify(fingerprint));
 exec(file,receiptSql({id:'gone',key:'admission:lid:gone'})+";UPDATE canonical_write_receipt SET state='abandoned',error_class='superseded_by_retry',next_attempt_at=NULL,settled_at='"+T+"' WHERE request_id='gone'");
 assert.equal(holds('admission:lid:gone',{count:1,applied:0}),1);assert.equal(holds('admission:lid:gone',{count:1,applied:1}),0);
 exec(file,receiptSql({id:'open',key:'admission:lid:open'}));
 assert.equal(holds('admission:lid:open',{count:1,applied:0}),0,'an unresolved attempt fails the guard whatever the numbers');
}

// ---- 8. An applied attempt is never trusted without the caller's current-state check -------------------------------------------
{
 const file=open(),env=envOf(file);
 await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{decide:reserving(env,file,MOVIE_A,'Movie A')});
 await assert.rejects(()=>K.reconcileOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(1000)}),code('operation_key_validation_required'));
 await assert.rejects(()=>K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(1000)},{decide:async()=>({kind:'none'})}),code('operation_key_validation_required'));
 await assert.rejects(()=>K.reconcileOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(1000)},{validate:async()=>'yes'}),code('operation_key_validation_required'));
 // an identity correction: the code now belongs to movie B; the applied attempt for A is history, and the caller decides on current state
 const out=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(1000)},{validate:intends(file,MOVIE_B),decide:async ctx=>{
  assert.deepEqual(ctx.historical.map(item=>[item.receipt.target.id,item.currentTarget.id]),[[MOVIE_A,MOVIE_A]]);
  return {kind:'none',result:'needs_review'};
 }});
 assert.equal(out.status,'none');assert.equal(revisionOf(file,MOVIE_B),0,'nothing was linked on the strength of the applied receipt');
 // a settled verdict needs the effect to be there now: a Film that is gone makes the applied attempt history
 const pure=K.planHistory({receipts:[{state:'applied',settledAt:iso(1),requestId:'x'},{state:'abandoned'},{state:'pending',nextAttemptAt:iso(10)},{state:'pending',nextAttemptAt:iso(-1)},{state:'failed'},{state:'unknown'}],now:iso(0)});
 assert.deepEqual([pure.applied.length,pure.abandoned,pure.live.length,pure.stale.length,pure.fingerprint],[1,1,1,3,{count:6,applied:1}]);
 assert.equal(K.sameFingerprint({count:1,applied:0},{count:1,applied:0}),true);assert.equal(K.sameFingerprint({count:1,applied:0},{count:1,applied:1}),false);
}

// ---- 9. Bounds --------------------------------------------------------------------------------------------------------------
{
 // a key with more receipts than the cap is refused, never read in part
 const file=open(),env=envOf(file);
 const script=[];
 for(let i=0;i<=K.OPERATION_KEY_HISTORY_CAP;i++)script.push(receiptSql({id:'cap-'+String(i).padStart(3,'0'),key:'admission:lid:cap'})+";UPDATE canonical_write_receipt SET state='abandoned',error_class='superseded_by_retry',next_attempt_at=NULL,settled_at='"+T+"' WHERE request_id='cap-"+String(i).padStart(3,'0')+"'");
 exec(file,script.join(';\n'));
 await assert.rejects(()=>K.readOperationHistory(env,{origin:ORIGIN,operationKey:'admission:lid:cap'}),code('operation_key_history_oversized'));
 // a caller that keeps losing stops after its rounds, with nothing of its own written
 const busy=open(),busyEnv=envOf(busy);
 let other=0;
 const out=await K.runOperationKey(busyEnv,{origin:ORIGIN,operationKey:KEY,now:clockAt(0),rounds:2},{validate:async()=>'historical',decide:async()=>{
  const movie='film:tmdb:'+(100+other++);
  await K.runOperationKey(busyEnv,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{validate:async()=>'historical',decide:reserving(busyEnv,busy,movie)});
  return reserving(busyEnv,busy,MOVIE_A)();
 }});
 assert.deepEqual([out.status,out.reason,out.replans],['wait','contended',2]);
 assert.equal(revisionOf(busy,MOVIE_A),0);assert.equal(keyed(busy).length,2,'only the other callers reserved');
 // an abandon that loses its race re-reads and waits on the live attempt: the expired attempt 1 is retried by another caller (pending again, attempt 2, a new window) between the read and the
 // abandon, so the abandon matched on state AND attempt misses, and attempt 2 is never stolen
 const race=open();
 exec(race,receiptSql({id:'r-1',key:KEY,at:iso(-600000)}));
 let moved=false;
 const raceEnv=envOf(race,{onBatch:async list=>{if(!moved&&list.some(item=>/superseded_by_retry/.test(item.text))){moved=true;exec(race,"UPDATE canonical_write_receipt SET state='pending',attempts=2,next_attempt_at='"+iso(300000)+"' WHERE request_id='r-1'");}}});
 const raced=await K.reconcileOperationKey(raceEnv,{origin:ORIGIN,operationKey:KEY,now:clockAt(1000)});
 assert.ok(moved);assert.deepEqual([raced.status,raced.reason,raced.requestId,raced.abandoned],['wait','in_flight','r-1',[]]);
 assert.deepEqual(keyed(race).map(row=>[row.state,row.attempts]),[['pending',2]],'the other caller\'s attempt was not stolen');
}

// ---- 10. Legacy callers at schema 39 and origin scoping ---------------------------------------------------------------------
{
 const file=open(),env=envOf(file);
 // legacy unresolved receipts of one origin never collide with each other and never enter a key's history
 exec(file,receiptSql({id:'l-1'})+';'+receiptSql({id:'l-2'})+';'+receiptSql({id:'l-3',key:null}));
 assert.deepEqual((await K.readOperationHistory(env,{origin:ORIGIN,operationKey:KEY})).fingerprint,{count:0,applied:0});
 // the history of a key is per origin: another origin's unresolved attempt under the same key neither blocks nor counts
 exec(file,receiptSql({id:'x-1',key:KEY,origin:'o_other'}));
 const out=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{decide:reserving(env,file,MOVIE_A)});
 assert.equal(out.status,'reserved');assert.equal(keyed(file,KEY,'o_other').length,1);assert.equal(keyed(file).length,1);
 assert.equal((await readReceipt(env,out.requestId)).state,'applied','the legacy read path sees a keyed receipt as before');
}

// ---- 12. The legacy reconciler never owns a keyed attempt (PR #995 review) ---------------------------------------------------
{
 const file=open(),env=envOf(file);
 // a due keyed attempt (pending past its window) and a due legacy attempt of the same origin and operation; the keyed one sorts first, so with a window of one it would take the slot
 exec(file,receiptSql({id:'a-keyed-due',key:KEY,at:iso(-600000)})+';'+receiptSql({id:'b-legacy-due',at:iso(-600000)}));
 const keyedBefore=rows(file,"SELECT state,attempts,next_attempt_at,error_class FROM canonical_write_receipt WHERE request_id='a-keyed-due'")[0];
 const seen=[];
 const op=defineOperation({operation:'film_mutation',atomic:true,
  readback:async(e,target,receipt)=>{seen.push('readback:'+receipt.requestId);return null;},
  replay:async(e,receipt,ctx)=>{seen.push('replay:'+receipt.requestId);return writer(env,MOVIE_A,'Legacy replay')({...ctx,requestId:receipt.requestId});}});
 const out=await reconcileReceipts(env,{operations:operationRegistry([op]),origin:ORIGIN,now:clockAt(0),limit:1});
 assert.deepEqual(seen,['readback:b-legacy-due','replay:b-legacy-due'],'only the legacy row is read back and replayed');
 assert.equal(out.considered,1);assert.deepEqual(out.replayed,['b-legacy-due']);
 assert.deepEqual(rows(file,"SELECT state,attempts,next_attempt_at,error_class FROM canonical_write_receipt WHERE request_id='a-keyed-due'")[0],keyedBefore,'the keyed attempt is untouched: no state, attempt or due-time change');
 assert.equal(titleOf(file,MOVIE_A),'Legacy replay','the legacy writer effect is the legacy row\'s only');
 // the keyed protocol still owns it: it abandons it and reserves anew
 const keyedRun=await K.runOperationKey(env,{origin:ORIGIN,operationKey:KEY,now:clockAt(0)},{validate:async()=>'historical',decide:async()=>({kind:'none'})});
 assert.equal(keyedRun.status,'none');
 assert.deepEqual(rows(file,"SELECT state,error_class FROM canonical_write_receipt WHERE request_id='a-keyed-due'")[0],{state:'abandoned',error_class:'superseded_by_retry'});
 // an unkeyed direct call with the exact id of a keyed attempt is refused; the row does not move and the writer never runs
 exec(file,receiptSql({id:'c-keyed-direct',key:'admission:lid:direct',at:iso(-600000)}));
 const direct=rows(file,"SELECT state,attempts FROM canonical_write_receipt WHERE request_id='c-keyed-direct'")[0];
 let ran=false;
 await assert.rejects(()=>receiptedWrite(env,{requestId:'c-keyed-direct',operation:'film_mutation',origin:ORIGIN,target:{kind:'film',id:MOVIE_A},expectedRevision:0,digest:DIGEST,now:clockAt(0)},{run:async()=>{ran=true;},readback:async()=>null,atomic:true}),code('receipt_conflict'));
 assert.equal(ran,false);assert.deepEqual(rows(file,"SELECT state,attempts FROM canonical_write_receipt WHERE request_id='c-keyed-direct'")[0],direct);
 // below schema 39 the legacy reconciler lists exactly what it did before
 const old=open(before),oldEnv=envOf(old);
 exec(old,receiptSql({id:'old-due',at:iso(-600000)}));
 const oldSeen=[];
 const oldOp=defineOperation({operation:'film_mutation',atomic:true,readback:async(e,t2,receipt)=>{oldSeen.push(receipt.requestId);return null;},replay:async(e,receipt,ctx)=>writer(oldEnv,MOVIE_A,'Old')({...ctx,requestId:receipt.requestId})});
 const oldOut=await reconcileReceipts(oldEnv,{operations:operationRegistry([oldOp]),origin:ORIGIN,now:clockAt(0)});
 assert.deepEqual(oldSeen,['old-due']);assert.deepEqual(oldOut.replayed,['old-due']);
}

// ---- 13. The history cap is enforced before a reservation, so no accepted attempt strands its own history (PR #995 review) -------
{
 const CAP=K.OPERATION_KEY_HISTORY_CAP,FULL='admission:lid:full';
 const file=open();
 const script=[];
 for(let i=0;i<CAP-1;i++){const id='full-'+String(i).padStart(3,'0');script.push(receiptSql({id,key:FULL})+";UPDATE canonical_write_receipt SET state='abandoned',error_class='superseded_by_retry',next_attempt_at=NULL,settled_at='"+T+"' WHERE request_id='"+id+"'");}
 exec(file,script.join(';\n'));
 // cap-1 -> cap, with the response lost: the attempt that fills the history stays readable and is recovered from it
 let lose=true;
 const lossy=intercept(envOf(file),{after:async list=>{if(lose&&appliedIn(list)){lose=false;throw new Error('Network connection lost');}}});
 await assert.rejects(()=>K.runOperationKey(lossy,{origin:ORIGIN,operationKey:FULL,now:clockAt(0)},{decide:reserving(lossy,file,MOVIE_A,'Movie A')}),code('film_person_unavailable'));
 const env=envOf(file);
 const atCap=await K.readOperationHistory(env,{origin:ORIGIN,operationKey:FULL});
 assert.deepEqual(atCap.fingerprint,{count:CAP,applied:1},'a history of exactly the cap is read whole');
 const recovered=await K.runOperationKey(env,{origin:ORIGIN,operationKey:FULL,now:clockAt(5000)},{validate:intends(file,MOVIE_A),decide:async()=>{throw new Error('no decision');}});
 assert.equal(recovered.status,'settled','the lost response at the cap is settled from its applied attempt');
 // cap -> a new reservation: a typed refusal, no receipt and no writer run; a terminal outcome is still possible
 const count=receiptCount(file),revB=revisionOf(file,MOVIE_B);let exhaustedSeen=null;
 const refusedRun=await K.runOperationKey(env,{origin:ORIGIN,operationKey:FULL,now:clockAt(6000)},{validate:async()=>'historical',decide:async ctx=>{exhaustedSeen=ctx.exhausted;return reserving(env,file,MOVIE_B,'Movie B')();}});
 assert.deepEqual([refusedRun.status,exhaustedSeen],['exhausted',true]);
 assert.equal(receiptCount(file),count);assert.equal(revisionOf(file,MOVIE_B),revB);
 const untouched={DB:{prepare(){throw new Error('touched');},batch(){throw new Error('touched');}}};
 await assert.rejects(()=>K.reserveOperationKey(untouched,{requestId:'o_test:film_mutation:over',operation:'film_mutation',origin:ORIGIN,target:{kind:'film',id:MOVIE_B},expectedRevision:0,digest:DIGEST,operationKey:FULL,fingerprint:{count:CAP,applied:1},now:clockAt(0)},{run:async()=>{throw new Error('ran');},readback:async()=>null,atomic:true}),code('operation_key_history_exhausted'),'refused before anything is read');
 const terminal=await K.runOperationKey(env,{origin:ORIGIN,operationKey:FULL,now:clockAt(7000)},{validate:async()=>'historical',decide:async()=>({kind:'finalize',write:finalizing(env,FULL,'needs_review')})});
 assert.equal(terminal.status,'finalized');
 // a history over the cap can only come from outside the protocol and is still refused whole (section 9); one below it reserves normally (section 3)
 assert.equal(receiptCount(file),count);
}

// ---- 11. Dormant: nothing calls the protocol, nothing bundles it, no network, timer or R2 -------------------------------------
{
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&full!=='src/receipt-operation-key.js'&&/(?:from|import\()\s*['"][^'"]*receipt-operation-key/.test(fs.readFileSync(full,'utf8')))importers.push(full);}};
 walk('src');walk('scripts');
 // AIR-605: the Catalog Enrichment units (dormant, not bundled) are the first consumer of the protocol; any other importer is still refused.
 assert.deepEqual(importers,['src/catalog-enrichment-units.js'],'only the dormant Catalog Enrichment units import the operation key protocol');
 // AIR-605: the protocol is bundled ONLY as the dependency of the dormant Catalog Enrichment drainer (one scope, ReceiptOperationKey); no other file names it.
 for(const file of ['package.json','wrangler.jsonc'])assert.ok(!fs.readFileSync(file,'utf8').includes('receipt-operation-key'),file+' does not bundle it');
 assert.equal((fs.readFileSync('build.mjs','utf8').match(/receipt-operation-key/g)||[]).length,1,'build.mjs scopes it exactly once, for the dormant Catalog Enrichment drainer');
 const source=fs.readFileSync('src/receipt-operation-key.js','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\bfetch\(|BUCKET|R2|setTimeout|setInterval|cron|scheduled|Date\.now/i.test(source),'no network, R2, timer, schedule or wall clock');
 assert.ok(!/operation_key/.test(fs.readFileSync('src/canonical-mutations.js','utf8')),'the fenced writers are unchanged');
}

console.log('receipt-operation-key: schema '+N+' adds the nullable receipt operation key with one unresolved attempt per key; keyed reservation and terminal outcomes assert the observed history; live attempts wait, expired ones are abandoned and their tails never land; lost responses settle from the applied attempt after a current-state check; absent schema and legacy callers unchanged');
