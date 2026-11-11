// AIR-374 P2c: the durable canonical write receipt (migrations/0019_canonical_write_receipt.sql, src/canonical-receipts.js), dormant. sqlite3-CLI D1 stand-in only: no Worker, R2, D1 or
// Cloudflare access. Covered: the migration on top of the full chain (and its refusal on a partial one), the marker triggers (a receipt is writable only at d1/open; the table stays empty at r2,
// prepared and held), the state machine in SQL, the record-pending-commit-mark protocol over the existing fenced writers, retry bound and backoff, an unknown outcome settled by readback both
// ways, a stale generation, `unreceipted` detection, no payload in the table, the statement budget and the dormant wiring. CANON_RECEIPTS_SOURCE / CANON_RECEIPTS_MIGRATION point the file at a
// mutant (tests/canonical-receipts-mutation.mjs); CANON_RECEIPTS_ONLY=3,4 runs only those numbered sections.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {mutateFilm,mutatePerson,fenced} from '../src/canonical-mutations.js';
import {failed} from '../src/film-person-authority.js';

const M=await import(process.env.CANON_RECEIPTS_SOURCE?pathToFileURL(path.resolve(process.env.CANON_RECEIPTS_SOURCE)).href:'../src/canonical-receipts.js');
const {receiptedWrite,reconcilePlan,reconcileReceipts,unreceiptedChanges,readUnreceipted,readReceipt,listReceipts,digestOf,canonicalJson,requestIdOf,backoffMs,classify,errorClassOf,defineOperation,operationRegistry,
 appliedStatements,receiptsAvailable,assertReceiptsAvailable,normalizeRequest,RETRY_POLICY,OPERATION_KINDS,RECEIPT_STATES}=M;

const only=process.env.CANON_RECEIPTS_ONLY?new Set(process.env.CANON_RECEIPTS_ONLY.split(',')):null;
const on=number=>!only||only.has(String(number));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-receipts-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>name.replace(/\.sql$/,''));
const MIGRATION=process.env.CANON_RECEIPTS_MIGRATION||'migrations/0019_canonical_write_receipt.sql';
const sql=name=>name==='0019_canonical_write_receipt'?fs.readFileSync(MIGRATION,'utf8'):fs.readFileSync('migrations/'+name+'.sql','utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const template=path.join(root,'template.sqlite');
assert.equal(sqlite(template,chain.map(sql).join('\n')).status,0);
// A database one migration short (schema 18), for the schema-missing refusal.
const template18=path.join(root,'template18.sqlite');
assert.equal(sqlite(template18,chain.filter(name=>name!=='0019_canonical_write_receipt').map(sql).join('\n')).status,0);
let n=0;
function database(stage='open',source=template){
 const file=path.join(root,'rc-'+(n++)+'.sqlite');
 fs.copyFileSync(source,file);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const T0=Date.parse('2026-11-11T10:00:00.000Z');
const iso=ms=>new Date(T0+ms).toISOString();
const clockAt=ms=>()=>iso(ms);
const T=iso(0);
const FILM='film:tmdb:1',PERSON='person:director/1';
const SECRET_TITLE='Zzyzx Secret Title',SECRET_NAME='Qwerty Private Name';
const receiptRows=file=>rows(file,'SELECT * FROM canonical_write_receipt ORDER BY request_id');
const count=file=>Number(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'));
const revision=(file,id)=>Number(one(file,"SELECT revision FROM canonical_revision WHERE id='"+id+"'")??0);
const filmRow=(file,id=FILM)=>rows(file,"SELECT original_title,contract_version FROM film WHERE id='"+id+"'")[0]||null;

// The test operation: one Film written by the real fenced mutateFilm; the planned digest and the readback digest go through the same digestOf over the same canonical form.
const filmContent=(title,contractVersion=1)=>({originalTitle:title,contractVersion});
const plannedDigest=title=>digestOf(filmContent(title));
const readbackFilm=async(env,target)=>{
 const row=await env.DB.prepare('SELECT original_title,contract_version FROM film WHERE id=?').bind(target.id).first();
 const rev=await env.DB.prepare('SELECT revision FROM canonical_revision WHERE kind=? AND id=?').bind(target.kind,target.id).first();
 return row?{digest:await digestOf(filmContent(row.original_title,row.contract_version)),revision:Number(rev?.revision??0)}:null;
};
const writeFilm=(env,title,expectedRevision=0,id=FILM)=>mutateFilm(env,{id,expectedRevision,at:T,film:{contractVersion:1,originalTitle:title}});
async function request(source,title=SECRET_TITLE,over={}){
 return {requestId:await requestIdOf({origin:'epg',operation:'film_mutation',source}),operation:'film_mutation',origin:'epg',target:{kind:'film',id:FILM},expectedRevision:0,digest:await plannedDigest(title),...over};
}
const hooksFor=(env,title=SECRET_TITLE,calls={run:0,readback:0})=>({
 run:async()=>{calls.run++;return writeFilm(env,title);},
 readback:async(...args)=>{calls.readback++;return readbackFilm(env,args[1]);},
});
const FILM_OPERATION=env=>defineOperation({operation:'film_mutation',readback:(e,target)=>readbackFilm(env,target),replay:(e,receipt,ctx)=>mutateFilm(env,{id:receipt.target.id,expectedRevision:ctx.currentRevision,at:T,film:{contractVersion:1,originalTitle:SECRET_TITLE}})});
const rawInsert=(over={})=>{
 const r={id:'r-raw',op:'film_mutation',origin:'epg',kind:'film',target:FILM,digest:'a'.repeat(64),planned:0,gen:2,state:'pending',attempts:1,next:iso(120000),...over};
 const q=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
 return `INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES (${q(r.id)},${q(r.op)},${q(r.origin)},${q(r.kind)},${q(r.target)},${q(r.digest)},${r.planned},${r.gen},${q(r.state)},${r.attempts},${q(r.next)},'${T}','${T}')`;
};
const message=result=>String(result.stderr||'');

// 1. The migration: on top of the full chain; empty; version 19; refuses a partial chain; the version never goes down.
if(on(1)){
 assert.equal(chain[chain.length-1],'0019_canonical_write_receipt','0019 is the last file of the chain');
 const file=database('r2');
 assert.equal(Number(one(file,'SELECT version FROM schema_contract WHERE id=1')),19);
 assert.equal(count(file),0,'the table starts empty');
 for(const name of ['canonical_write_receipt'])assert.equal(Number(one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='"+name+"'")),1);
 // Applying 0019 to a database that is not a complete version 18 changes nothing.
 const partial=path.join(root,'partial.sqlite');
 assert.equal(sqlite(partial,chain.filter(name=>Number(name.slice(0,4))<=17).map(sql).join('\n')).status,0);
 const refused=sqlite(partial,sql('0019_canonical_write_receipt'));
 assert.notEqual(refused.status,0,'0019 refuses a version 17');
 assert.equal(Number(one(partial,"SELECT COUNT(*) FROM sqlite_master WHERE name='canonical_write_receipt'")),0);
 assert.equal(Number(one(partial,'SELECT version FROM schema_contract WHERE id=1')),17);
 // A version-18 stamp without a prerequisite table is refused too.
 const missing=path.join(root,'missing.sqlite');
 fs.copyFileSync(template18,missing);
 assert.equal(sqlite(missing,'DROP TABLE projector_window').status,0);
 assert.notEqual(sqlite(missing,sql('0019_canonical_write_receipt')).status,0,'0019 refuses a version 18 missing a table');
 assert.equal(Number(one(missing,"SELECT COUNT(*) FROM sqlite_master WHERE name='canonical_write_receipt'")),0);
 // A database with every table of a version 18 but a version stamp of 17 is refused by the version guard alone.
 const stamped=path.join(root,'stamped.sqlite');
 fs.copyFileSync(template18,stamped);
 assert.equal(sqlite(stamped,'DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=17 WHERE id=1').status,0);
 assert.notEqual(sqlite(stamped,sql('0019_canonical_write_receipt')).status,0,'0019 refuses a version 17 stamp');
 assert.equal(Number(one(stamped,"SELECT COUNT(*) FROM sqlite_master WHERE name='canonical_write_receipt'")),0);
 // Applying it twice is refused (no silent re-run), and the version cannot go down.
 assert.notEqual(sqlite(file,sql('0019_canonical_write_receipt')).status,0);
 assert.match(message(sqlite(file,'UPDATE schema_contract SET version=18 WHERE id=1')),/schema_contract_downgrade/);
 // The migration adds no row anywhere else and no marker move: the marker is exactly what the chain left.
 assert.deepEqual(rows(file,'SELECT mode,cutover,generation FROM film_person_authority'),[{mode:'r2',cutover:'open',generation:0}]);
 assert.ok(fs.readFileSync('migrations/README.md','utf8').includes('0019_canonical_write_receipt.sql'),'migrations/README.md lists 0019');
}

// 2. The marker triggers: a receipt is writable only at d1/open; reads always; stale generation, shape and no-delete.
if(on(2)){
 for(const stage of ['r2','prepared','held']){
  const file=database(stage);
  const result=sqlite(file,rawInsert({gen:stage==='r2'?0:stage==='prepared'?1:3}));
  assert.notEqual(result.status,0,stage+': an insert is refused');
  assert.match(message(result),/canonical_receipt_not_open/,stage);
  assert.equal(count(file),0,stage+': the table stays empty');
  assert.equal(Number(one(file,'SELECT COUNT(*) FROM canonical_write_receipt WHERE 1=0')),0,stage+': reads work');
 }
 const file=database('open');
 assert.equal(sqlite(file,rawInsert()).status,0,'open: an insert is accepted');
 // held: the row stays readable and every update is refused.
 assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 assert.equal(count(file),1,'held: reads allowed');
 assert.match(message(sqlite(file,"UPDATE canonical_write_receipt SET state='applied',applied_revision=1,next_attempt_at=NULL,settled_at='"+T+"',updated_at='"+T+"' WHERE request_id='r-raw'")),/canonical_receipt_not_open/);
 assert.equal(one(file,"SELECT state FROM canonical_write_receipt WHERE request_id='r-raw'"),'pending');
 assert.match(message(sqlite(file,rawInsert({id:'r-held',gen:3}))),/canonical_receipt_not_open/);
 assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1").status,0);
 // Insert shape and generation.
 const open=database('open');
 assert.match(message(sqlite(open,rawInsert({gen:1}))),/canonical_receipt_stale_generation/,'an insert under an older generation');
 assert.match(message(sqlite(open,rawInsert({gen:9}))),/canonical_receipt_stale_generation/,'an insert under a future generation');
 assert.match(message(sqlite(open,rawInsert({state:'applied'}))),/canonical_receipt_insert|CHECK constraint failed/,'a new receipt is pending');
 assert.match(message(sqlite(open,rawInsert({attempts:2}))),/canonical_receipt_insert/,'a new receipt is attempt 1');
 assert.equal(sqlite(open,rawInsert()).status,0);
 assert.match(message(sqlite(open,'DELETE FROM canonical_write_receipt')),/canonical_receipt_delete/,'rows are never deleted');
 // No payload can be stored: identifiers and digests only.
 const shapes=[
  ['a request id with a space',rawInsert({id:'has space'})],['an operation with a capital',rawInsert({id:'r2',op:'FilmMutation'})],['a target with no id',rawInsert({id:'r3',target:'film:'})],
  ['a person id on a film',rawInsert({id:'r4',target:'person:x'})],['a short digest',rawInsert({id:'r5',digest:'abc'})],['an upper-case digest',rawInsert({id:'r6',digest:'A'.repeat(64)})],
  ['an unknown kind',rawInsert({id:'r7',kind:'title'})],['a bad state',rawInsert({id:'r8',state:'done'})],
 ];
 for(const [name,statement] of shapes)assert.notEqual(sqlite(open,statement).status,0,name+' is refused');
 assert.match(message(sqlite(open,"UPDATE canonical_write_receipt SET state='failed',error_class='network timed out',next_attempt_at='"+iso(1)+"' WHERE request_id='r-raw'")),/CHECK constraint failed/,'an error message is not an error class');
}

// 3. The state machine in SQL: legal moves, terminal states, immutable identity, attempt counter, generation.
if(on(3)){
 const file=database('open');
 const upd=(set,id='r-raw')=>sqlite(file,'UPDATE canonical_write_receipt SET '+set+" WHERE request_id='"+id+"'");
 const fresh=id=>assert.equal(sqlite(file,rawInsert({id})).status,0);
 const fail=(id,cls='film_person_fence')=>assert.equal(upd("state='failed',error_class='"+cls+"',next_attempt_at='"+iso(60000)+"',updated_at='"+iso(1)+"'",id).status,0);
 // pending -> applied needs a revision and no error class
 fresh('a1');
 assert.notEqual(upd("state='applied',next_attempt_at=NULL,settled_at='"+iso(1)+"'",'a1').status,0,'applied needs an applied revision');
 assert.equal(upd("state='applied',applied_revision=1,next_attempt_at=NULL,settled_at='"+iso(1)+"',updated_at='"+iso(1)+"'",'a1').status,0);
 // applied and abandoned are terminal
 assert.match(message(upd("state='pending',attempts=2",'a1')),/canonical_receipt_transition/);
 assert.match(message(upd("updated_at='"+iso(2)+"'",'a1')),/canonical_receipt_transition/);
 fresh('a2');
 assert.equal(upd("state='abandoned',error_class='expired',next_attempt_at=NULL,settled_at='"+iso(1)+"',updated_at='"+iso(1)+"'",'a2').status,0);
 assert.match(message(upd("state='failed',error_class='x',next_attempt_at='"+iso(9)+"'",'a2')),/canonical_receipt_transition/);
 // failed -> unknown is not a move; failed -> pending needs attempts+1 and the live generation
 fresh('a3');fail('a3');
 assert.match(message(upd("state='unknown',error_class='x',next_attempt_at='"+iso(9)+"'",'a3')),/canonical_receipt_transition/);
 assert.match(message(upd("state='pending',next_attempt_at='"+iso(9)+"'",'a3')),/canonical_receipt_attempts/,'a new attempt moves the counter by one');
 assert.match(message(upd("state='pending',attempts=3,next_attempt_at='"+iso(9)+"'",'a3')),/canonical_receipt_attempts/,'not by two');
 assert.match(message(upd("state='pending',attempts=2,marker_generation=1,next_attempt_at='"+iso(9)+"'",'a3')),/canonical_receipt_stale_generation/,'a new attempt carries the live generation');
 assert.equal(upd("state='pending',attempts=2,next_attempt_at='"+iso(9)+"',updated_at='"+iso(2)+"'",'a3').status,0);
 // the counter does not move without a new attempt
 assert.match(message(upd("state='failed',attempts=3,error_class='film_person_fence',next_attempt_at='"+iso(9)+"'",'a3')),/canonical_receipt_attempts/);
 // the planned generation of a settled move is not rewritten
 assert.match(message(upd("state='unknown',marker_generation=7,error_class='x',next_attempt_at='"+iso(9)+"'",'a3')),/canonical_receipt_stale_generation/);
 // unknown -> failed, applied, abandoned and pending are the moves; failed needs an error class
 fresh('a4');
 assert.equal(upd("state='unknown',error_class='unclassified',next_attempt_at='"+iso(9)+"',updated_at='"+iso(1)+"'",'a4').status,0);
 assert.notEqual(upd("state='failed',error_class=NULL,next_attempt_at='"+iso(9)+"'",'a4').status,0,'a failed receipt names its class');
 assert.equal(upd("state='failed',error_class='film_person_fence',next_attempt_at='"+iso(9)+"',updated_at='"+iso(2)+"'",'a4').status,0);
 // an in-flight pending receipt can be marked applied only with its due time cleared
 fresh('a5');
 assert.notEqual(upd("state='applied',applied_revision=1,settled_at='"+iso(1)+"'",'a5').status,0,'applied clears the due time');
 // the consistency CHECKs: applied is settled, and only an applied receipt carries an applied revision
 fresh('a7');
 assert.notEqual(upd("state='applied',applied_revision=1,next_attempt_at=NULL",'a7').status,0,'applied is settled');
 assert.notEqual(upd("applied_revision=1,attempts=attempts+1",'a7').status,0,'a pending receipt has no applied revision');
 assert.notEqual(upd("state='abandoned',error_class='expired',next_attempt_at=NULL",'a7').status,0,'abandoned is settled');
 // identity is immutable
 fresh('a6');
 for(const [name,set] of [['request id',"request_id='zz'"],['operation',"operation='film_merge'"],['origin',"origin='other'"],['target kind',"target_kind='person',target_id='person:x'"],['target id',"target_id='film:other'"],['digest',"content_digest='"+'b'.repeat(64)+"'"],['created_at',"created_at='"+iso(5)+"'"]]){
  assert.match(message(upd('attempts=attempts+1,'+set,'a6')),/canonical_receipt_immutable|CHECK constraint failed/,name+' is immutable');
 }
 // an in-flight attempt may be re-leased only as a new attempt; a plain touch is refused
 assert.match(message(upd("state='pending',next_attempt_at='"+iso(7)+"'",'a6')),/canonical_receipt_attempts/);
}

// 4. The protocol over the real fenced writer: pending first, commit, applied; idempotent; refusal before open.
if(on(4)){
 const file=database('open');
 const env=envOf(file);
 const calls={run:0,readback:0};
 const input=await request('event-1');
 assert.deepEqual(RECEIPT_STATES,['pending','applied','failed','unknown','abandoned']);
 const first=await receiptedWrite(env,{...input,now:clockAt(0)},hooksFor(env,SECRET_TITLE,calls));
 assert.equal(first.state,'applied');assert.equal(first.ran,true);
 assert.equal(calls.run,1);
 assert.equal(filmRow(file).original_title,SECRET_TITLE);
 assert.equal(revision(file,FILM),1);
 const row=await readReceipt(env,input.requestId);
 assert.equal(row.state,'applied');assert.equal(row.attempts,1);assert.equal(row.appliedRevision,1);assert.equal(row.markerGeneration,2);
 assert.equal(row.contentDigest,input.digest);assert.equal(row.nextAttemptAt,null);assert.equal(row.errorClass,null);assert.ok(row.settledAt);
 // the same request id again: no second run, no second revision, still one row.
 const again=await receiptedWrite(env,{...input,now:clockAt(1000)},hooksFor(env,SECRET_TITLE,calls));
 assert.equal(again.ran,false);assert.equal(again.already,true);assert.equal(calls.run,1);assert.equal(revision(file,FILM),1);assert.equal(count(file),1);
 // the same id with another content, operation or target is a conflict, not a replay.
 for(const [name,over] of [['content',{digest:await plannedDigest('Other')}],['target',{target:{kind:'film',id:'film:tmdb:2'}}],['origin',{origin:'discovery'}],['operation',{operation:'film_merge'}]]){
  await assert.rejects(()=>receiptedWrite(env,{...input,...over,now:clockAt(2000)},hooksFor(env)),code('receipt_conflict'),'a different '+name+' under the same id');
 }
 assert.equal(calls.run,1);
 // the request id is stable, source text-free, and validated.
 assert.equal(await requestIdOf({origin:'epg',operation:'film_mutation',source:'event-1'}),input.requestId);
 assert.ok(!input.requestId.includes('event-1'));
 await assert.rejects(()=>requestIdOf({origin:'epg',operation:'nope',source:'x'}),code('film_person_invalid'));
 await assert.rejects(()=>receiptedWrite(env,{...input,requestId:'has space'},hooksFor(env)),code('film_person_invalid'));
 await assert.rejects(()=>receiptedWrite(env,{...input,digest:'xyz'},hooksFor(env)),code('film_person_invalid'));
 await assert.rejects(()=>receiptedWrite(env,{...input,target:{kind:'film',id:PERSON}},hooksFor(env)),code('film_person_invalid'));
 // A person target goes through the same protocol.
 const personEnv=envOf(database('open'));
 const personInput=await request('event-p',SECRET_NAME,{operation:'person_mutation',target:{kind:'person',id:PERSON}});
 const done=await receiptedWrite(personEnv,{...personInput,now:clockAt(0)},{run:()=>mutatePerson(personEnv,{id:PERSON,expectedRevision:0,at:T,person:{roleId:'director/1',contractVersion:1}}),readback:async()=>null});
 assert.equal(done.state,'applied');
 // Before open nothing is written: r2, prepared, held, and a database one schema short.
 for(const [stage,expected] of [['r2','film_person_not_open'],['prepared','film_person_not_open'],['held','film_person_held']]){
  const f=database(stage),e=envOf(f);
  const c={run:0,readback:0};
  await assert.rejects(()=>receiptedWrite(e,{...input,now:clockAt(0)},hooksFor(e,SECRET_TITLE,c)),code(expected),stage);
  assert.equal(c.run,0,stage+': the writer never ran');assert.equal(count(f),0,stage+': no receipt');assert.equal(filmRow(f),null,stage+': no Film');
 }
 const old=database('open',template18),oldEnv=envOf(old);
 assert.equal(await receiptsAvailable(oldEnv),false);
 await assert.rejects(()=>assertReceiptsAvailable(oldEnv),code('receipt_schema_missing'));
 const c18={run:0,readback:0};
 await assert.rejects(()=>receiptedWrite(oldEnv,{...input,now:clockAt(0)},hooksFor(oldEnv,SECRET_TITLE,c18)),code('receipt_schema_missing'));
 assert.equal(c18.run,0,'without the receipt table a canonical write is refused, not made unreceipted');assert.equal(filmRow(old),null);
 assert.equal(await receiptsAvailable(env),true);
}

// 5. The in-batch applied statements: `applied` is atomic with the content; a failed content batch rolls the receipt move back too.
if(on(5)){
 const file=database('open');
 const env=envOf(file);
 const input=await request('event-atomic');
 const entities=expected=>[{kind:'film',id:FILM,expected}];
 const batches=[];
 const watched=envOf(file,{onBatch:async list=>{batches.push(list.length);}});
 const atomicRun=expected=>async({gate,appliedStatements:applied})=>{
  const statements=fenced.head(gate,entities(expected));
  statements.push(['INSERT INTO film (id,contract_version,original_title,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET original_title=excluded.original_title,updated_at=excluded.updated_at',[FILM,1,SECRET_TITLE,T]]);
  statements.push([fenced.BUMP,['film',FILM,T]]);
  statements.push(...applied());
  await fenced.commit(watched,gate,statements,entities(expected));
  return {revision:expected+1};
 };
 const result=await receiptedWrite(watched,{...input,now:clockAt(0)},{run:atomicRun(0),readback:readbackFilm});
 assert.equal(result.state,'applied');
 assert.equal(batches.length,2,'one batch for the pending record and ONE for content and applied together: no separate mark batch');
 const row=await readReceipt(env,input.requestId);
 assert.equal(row.state,'applied');assert.equal(row.appliedRevision,1);
 // a wrong expected revision: the whole content batch (including the applied statement) rolls back, the receipt is failed, the Film is unchanged.
 const f2=database('open'),e2=envOf(f2);
 sqlite(f2,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('"+FILM+"',1,'Before','"+T+"');INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','"+FILM+"',1,'"+T+"')");
 const in2=await request('event-atomic-2');
 await assert.rejects(()=>receiptedWrite(e2,{...in2,now:clockAt(0)},{run:async ctx=>{const entities2=[{kind:'film',id:FILM,expected:0}];const st=fenced.head(ctx.gate,entities2);st.push(['UPDATE film SET original_title=? WHERE id=?',['Changed',FILM]]);st.push(...ctx.appliedStatements());await fenced.commit(e2,ctx.gate,st,entities2);},readback:readbackFilm}),code('film_person_revision_conflict'));
 assert.equal(filmRow(f2).original_title,'Before');
 const failedRow=await readReceipt(e2,in2.requestId);
 assert.equal(failedRow.state,'failed');assert.equal(failedRow.errorClass,'film_person_revision_conflict');
 // appliedStatements is the registration shape: an UPDATE guarded to the pending attempt, then the changes() assertion; a receipt that is not this attempt's fails the batch.
 const stmts=appliedStatements({requestId:'x',attempt:1,target:{kind:'film',id:FILM},now:T});
 assert.equal(stmts.length,2);assert.match(stmts[0][0],/WHERE request_id=\? AND state=\? AND attempts=\?/);
 const f3=database('open'),e3=envOf(f3);
 assert.equal(sqlite(f3,rawInsert({id:'x'})).status,0);
 await assert.rejects(()=>e3.DB.batch([...fenced.head({generation:2},[]),...appliedStatements({requestId:'x',attempt:2,target:{kind:'film',id:FILM},now:T})].map(([s,p])=>e3.DB.prepare(s).bind(...p))),/CHECK constraint failed/,'the wrong attempt is not marked applied');
 assert.equal(one(f3,"SELECT state FROM canonical_write_receipt WHERE request_id='x'"),'pending');
}

// 6. Retry, backoff and the bound; definite failures; permanent refusals; expiry.
if(on(6)){
 assert.deepEqual([1,2,3,4,5,9].map(attempts=>backoffMs(attempts)),[60000,300000,1800000,7200000,7200000,7200000],'a stored schedule, the last step repeats');
 assert.throws(()=>backoffMs(0),code('film_person_invalid'));
 assert.equal(RETRY_POLICY.maxAttempts,5);assert.ok(Object.isFrozen(RETRY_POLICY));
 assert.deepEqual(classify(failed('film_person_revision_conflict')),{errorClass:'film_person_revision_conflict',outcome:'failed'});
 assert.deepEqual(classify(failed('film_person_fence')),{errorClass:'film_person_fence',outcome:'failed'});
 assert.deepEqual(classify(failed('film_person_invalid')),{errorClass:'film_person_invalid',outcome:'abandoned'});
 assert.deepEqual(classify(failed('identity_collision')),{errorClass:'identity_collision',outcome:'abandoned'});
 assert.deepEqual(classify(failed('film_person_unavailable')),{errorClass:'film_person_unavailable',outcome:'unknown'});
 assert.deepEqual(classify(new Error('connect ETIMEDOUT 10.0.0.1')),{errorClass:'unclassified',outcome:'unknown'},'a message is never stored');
 assert.equal(errorClassOf({code:'Has Capital'}),'unclassified');
 const file=database('open');
 const env=envOf(file);
 const input=await request('event-retry');
 const calls={run:0,readback:0};
 const conflict=async()=>{calls.run++;throw failed('film_person_revision_conflict');};
 const hooks={run:conflict,readback:async()=>{calls.readback++;return null;}};
 // attempt 1 fails definitively: failed, due after the first backoff.
 await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks),code('film_person_revision_conflict'));
 let row=await readReceipt(env,input.requestId);
 assert.equal(row.state,'failed');assert.equal(row.attempts,1);assert.equal(row.errorClass,'film_person_revision_conflict');assert.equal(row.nextAttemptAt,iso(60000));
 // not due: no run, no readback.
 const early=await receiptedWrite(env,{...input,now:clockAt(59999)},hooks);
 assert.equal(early.ran,false);assert.equal(early.reason,'backoff');assert.equal(calls.run,1);assert.equal(calls.readback,0);
 // each due attempt reads back first, then retries, with the next backoff.
 const due=[60000,60000+300000,60000+300000+1800000,60000+300000+1800000+7200000];
 for(let i=0;i<4;i++){
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(due[i])},hooks),code('film_person_revision_conflict'));
  row=await readReceipt(env,input.requestId);
  assert.equal(row.attempts,i+2);assert.equal(row.state,'failed');
  assert.equal(row.nextAttemptAt,iso(due[i]+backoffMs(i+2)),'backoff after attempt '+(i+2));
 }
 assert.equal(calls.run,5,'five attempts');assert.equal(calls.readback,4);
 // the bound: the sixth is not run; the receipt is abandoned and reported.
 const last=await receiptedWrite(env,{...input,now:clockAt(due[3]+backoffMs(5))},hooks);
 assert.equal(last.ran,false);assert.equal(last.state,'abandoned');assert.equal(last.reason,'attempts_exhausted');
 assert.equal(calls.run,5,'no sixth run');
 row=await readReceipt(env,input.requestId);
 assert.equal(row.state,'abandoned');assert.equal(row.errorClass,'attempts_exhausted');assert.ok(row.settledAt);
 assert.equal((await receiptedWrite(env,{...input,now:clockAt(1e9)},hooks)).state,'abandoned','an abandoned receipt is never run again');
 assert.equal(calls.run,5);
 // a permanent refusal is abandoned at once.
 const permanent=await request('event-permanent');
 await assert.rejects(()=>receiptedWrite(env,{...permanent,now:clockAt(0)},{run:async()=>{throw failed('film_person_invalid');},readback:async()=>null}),code('film_person_invalid'));
 assert.equal((await readReceipt(env,permanent.requestId)).state,'abandoned');
 // too old: abandoned by age even with attempts left.
 const aged=await request('event-aged');
 await assert.rejects(()=>receiptedWrite(env,{...aged,now:clockAt(0)},{run:conflict,readback:async()=>null}),code('film_person_revision_conflict'));
 const result=await receiptedWrite(env,{...aged,now:clockAt(RETRY_POLICY.abandonAfterMs+1)},{run:conflict,readback:async()=>null});
 assert.equal(result.reason,'expired');assert.equal((await readReceipt(env,aged.requestId)).errorClass,'expired');
 // a custom, tighter policy bounds the same way.
 const tight=await request('event-tight');
 const policy={...RETRY_POLICY,maxAttempts:2};
 await assert.rejects(()=>receiptedWrite(env,{...tight,policy,now:clockAt(0)},{run:conflict,readback:async()=>null}));
 await assert.rejects(()=>receiptedWrite(env,{...tight,policy,now:clockAt(60000)},{run:conflict,readback:async()=>null}));
 assert.equal((await receiptedWrite(env,{...tight,policy,now:clockAt(60000+300000)},{run:conflict,readback:async()=>null})).reason,'attempts_exhausted');
 // an existing receipt due for settling needs a readback: the protocol refuses to retry blind.
 const blind=await request('event-blind');
 await assert.rejects(()=>receiptedWrite(env,{...blind,now:clockAt(0)},{run:conflict}));
 await assert.rejects(()=>receiptedWrite(env,{...blind,now:clockAt(60000)},{run:conflict}),code('receipt_readback_required'));
}

// 7. Unknown outcomes settled by READBACK, both ways, and a crash between the commit and the mark.
if(on(7)){
 // applied-then-lost: the commit landed, the answer was lost. The receipt is unknown; readback finds the content, marks applied, and the writer does NOT run again.
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-applied-lost');
  const calls={run:0,readback:0};
  const lost={run:async()=>{calls.run++;await writeFilm(env,SECRET_TITLE);throw new Error('network reset');},readback:async(...a)=>{calls.readback++;return readbackFilm(env,a[1]);}};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},lost),/network reset/);
  let row=await readReceipt(env,input.requestId);
  assert.equal(row.state,'unknown');assert.equal(row.errorClass,'unclassified');assert.equal(row.nextAttemptAt,iso(60000));
  assert.equal(revision(file,FILM),1,'the content did land');
  const early=await receiptedWrite(env,{...input,now:clockAt(1000)},lost);
  assert.equal(early.reason,'backoff');assert.equal(calls.readback,0);
  const settled=await receiptedWrite(env,{...input,now:clockAt(60000)},lost);
  assert.equal(settled.state,'applied');assert.equal(settled.settled,'readback');assert.equal(settled.ran,false);
  assert.equal(calls.run,1,'no second write');assert.equal(revision(file,FILM),1,'no second revision');
  row=await readReceipt(env,input.requestId);
  assert.equal(row.state,'applied');assert.equal(row.appliedRevision,1);assert.equal(row.errorClass,null);assert.equal(row.attempts,1);
 }
 // lost-before-send: the request never reached the database. Readback finds nothing, the SAME request id is replayed, and the second attempt applies.
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-lost-before');
  const calls={run:0,readback:0};
  const hooks={run:async()=>{calls.run++;if(calls.run===1)throw new Error('fetch failed');return writeFilm(env,SECRET_TITLE);},readback:async(...a)=>{calls.readback++;return readbackFilm(env,a[1]);}};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks),/fetch failed/);
  assert.equal((await readReceipt(env,input.requestId)).state,'unknown');assert.equal(filmRow(file),null,'nothing landed');
  const retried=await receiptedWrite(env,{...input,now:clockAt(60000)},hooks);
  assert.equal(retried.state,'applied');assert.equal(retried.ran,true);assert.equal(retried.attempt,2);
  assert.equal(calls.readback,1,'readback ran before the retry');assert.equal(calls.run,2);
  const row=await readReceipt(env,input.requestId);
  assert.equal(row.state,'applied');assert.equal(row.attempts,2);assert.equal(row.requestId,input.requestId,'the same request id');assert.equal(row.appliedRevision,1);
  assert.equal(revision(file,FILM),1);
 }
 // a readback of DIFFERENT content (another writer's value) is not "applied": the receipt retries instead of claiming it.
 {
  const file=database('open'),env=envOf(file);
  await writeFilm(env,'Somebody else');
  const input=await request('event-other-content',SECRET_TITLE,{expectedRevision:1});
  const hooks={run:async()=>{throw new Error('timeout');},readback:async(...a)=>readbackFilm(env,a[1])};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks));
  const result=await receiptedWrite(env,{...input,now:clockAt(60000)},{run:async()=>writeFilm(env,SECRET_TITLE,1),readback:hooks.readback});
  assert.equal(result.state,'applied');assert.equal(result.attempt,2);assert.equal(filmRow(file).original_title,SECRET_TITLE);
 }
 // crash between the commit and the mark: the receipt stays pending, the writer's result is returned, and after its window readback marks it applied.
 {
  const file=database('open');
  const env=envOf(file,{onBatch:async list=>{if(list.some(item=>/SET state='applied'/.test(item.text)))throw new Error('D1 unavailable');}});
  const plain=envOf(file);
  const input=await request('event-mark-lost');
  const calls={run:0,readback:0};
  const hooks={run:async()=>{calls.run++;return writeFilm(plain,SECRET_TITLE);},readback:async(...a)=>{calls.readback++;return readbackFilm(plain,a[1]);}};
  const first=await receiptedWrite(env,{...input,now:clockAt(0)},hooks);
  assert.equal(first.ran,true);assert.equal(first.state,'pending');assert.equal(first.markFailed,true);
  let row=await readReceipt(plain,input.requestId);
  assert.equal(row.state,'pending');assert.equal(row.nextAttemptAt,iso(RETRY_POLICY.attemptWindowMs));
  const inflight=await receiptedWrite(plain,{...input,now:clockAt(1000)},hooks);
  assert.equal(inflight.reason,'in_flight');assert.equal(calls.run,1,'an in-flight attempt is not run again');
  const settled=await receiptedWrite(plain,{...input,now:clockAt(RETRY_POLICY.attemptWindowMs)},hooks);
  assert.equal(settled.settled,'readback');assert.equal(calls.run,1);assert.equal(revision(file,FILM),1);
  assert.equal((await readReceipt(plain,input.requestId)).state,'applied');
 }
 // the marker moved between the read and the receipt insert: the stale generation fails and nothing is recorded or written.
 {
  const file=database('open');
  const env=envOf(file,{onBatch:async()=>{if(!env.moved){env.moved=true;assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1").status,0);}}});
  const input=await request('event-stale');
  const calls={run:0,readback:0};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooksFor(env,SECRET_TITLE,calls)),code('film_person_fence'));
  assert.equal(calls.run,0);assert.equal(count(file),0);assert.equal(filmRow(file),null);
  // the same request after the move records under the new generation.
  const ok=await receiptedWrite(env,{...input,now:clockAt(1)},hooksFor(env,SECRET_TITLE,calls));
  assert.equal(ok.state,'applied');assert.equal((await readReceipt(env,input.requestId)).markerGeneration,4);
 }
 // a retry after the marker moved carries the live generation (held, then open again: generation 4).
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-regeneration');
  let first=true;
  const hooks={run:async()=>{if(first){first=false;throw new Error('timeout');}return writeFilm(env,SECRET_TITLE);},readback:async(...a)=>readbackFilm(env,a[1])};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks),/timeout/);
  assert.equal((await readReceipt(env,input.requestId)).markerGeneration,2);
  assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1").status,0);
  const result=await receiptedWrite(env,{...input,now:clockAt(60000)},hooks);
  assert.equal(result.state,'applied');
  const row=await readReceipt(env,input.requestId);
  assert.equal(row.markerGeneration,4);assert.equal(row.attempts,2);
 }
 // a held marker after the commit: the receipt stays pending (a held database accepts no receipt write) and is settled once reopened.
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-held-after');
  const hooks={run:async()=>{await writeFilm(env,SECRET_TITLE);assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);return {revision:1};},readback:async(...a)=>readbackFilm(env,a[1])};
  const first=await receiptedWrite(env,{...input,now:clockAt(0)},hooks);
  assert.equal(first.state,'pending');assert.equal(first.markFailed,true);
  assert.equal((await readReceipt(env,input.requestId)).state,'pending','held: the receipt is frozen, never guessed');
  let reads=0;
  const counting=defineOperation({operation:'film_mutation',readback:async(...a)=>{reads++;return readbackFilm(env,a[1]);},replay:async()=>{throw new Error('must not replay');}});
  const held=await reconcileReceipts(env,{operations:operationRegistry([counting]),now:clockAt(RETRY_POLICY.attemptWindowMs)});
  assert.equal(reads,0,'a held marker reads no target');
  assert.equal(held.marker,'held');assert.deepEqual(held.waiting.map(item=>item.reason),['marker_not_open']);assert.equal(held.applied.length,0);
  assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1").status,0);
  const open=await reconcileReceipts(env,{operations:operationRegistry([FILM_OPERATION(env)]),now:clockAt(RETRY_POLICY.attemptWindowMs)});
  assert.deepEqual(open.applied,[input.requestId]);
 }
}

// 8. The pure reconcile plan.
if(on(8)){
 const base={operation:'film_mutation',origin:'epg',target:{kind:'film',id:FILM},contentDigest:'a'.repeat(64),plannedRevision:0,appliedRevision:null,markerGeneration:2,attempts:1,errorClass:null,createdAt:iso(0),updatedAt:iso(0),settledAt:null};
 const rc=(requestId,over)=>({...base,requestId,state:'pending',nextAttemptAt:iso(1000),...over});
 const marker={state:'open',generation:2};
 const plan=(receipts,observed={},now=iso(5000),m=marker)=>reconcilePlan({receipts,observed,marker:m,now});
 // not due waits (in flight / backoff); terminal states are not planned; abandoned is attention
 let p=plan([rc('p1',{nextAttemptAt:iso(9000)}),rc('f1',{state:'failed',nextAttemptAt:iso(9000)}),rc('ap',{state:'applied',nextAttemptAt:null,appliedRevision:1}),rc('ab',{state:'abandoned',nextAttemptAt:null,errorClass:'attempts_exhausted'})]);
 assert.deepEqual(p.actions,[]);assert.deepEqual(p.waiting.map(item=>[item.requestId,item.reason]),[['f1','backoff'],['p1','in_flight']]);assert.deepEqual(p.attention,[{requestId:'ab',reason:'attempts_exhausted'}]);
 assert.equal(p.counts.applied,1);assert.equal(p.counts.abandoned,1);
 // exactly at the due time is due
 assert.deepEqual(plan([rc('d1',{nextAttemptAt:iso(5000)})]).actions.map(item=>item.action),['readback']);
 assert.deepEqual(plan([rc('d1',{nextAttemptAt:iso(5001)})]).actions,[]);
 // marker not open: nothing is planned
 for(const state of ['prepared','held','r2'])assert.deepEqual(plan([rc('m1')],{},iso(5000),{state,generation:2}).waiting.map(item=>item.reason),['marker_not_open']);
 // a due receipt is read back first; equal digest -> mark_applied (with the observed revision); different or absent -> replay; null (target empty) -> replay
 assert.deepEqual(plan([rc('u1',{state:'unknown'})]).actions,[{requestId:'u1',action:'readback'}]);
 assert.deepEqual(plan([rc('u1',{state:'unknown'})],{u1:{digest:'a'.repeat(64),revision:4}}).actions,[{requestId:'u1',action:'mark_applied',revision:4}]);
 assert.deepEqual(plan([rc('u1',{state:'unknown'})],{u1:{digest:'b'.repeat(64),revision:4}}).actions,[{requestId:'u1',action:'replay',attempt:2,replan:false}]);
 assert.deepEqual(plan([rc('u1',{state:'failed'})],{u1:null}).actions,[{requestId:'u1',action:'replay',attempt:2,replan:false}]);
 assert.equal(plan([rc('u1',{state:'pending'})],{u1:{digest:'a'.repeat(64),revision:2}}).actions[0].action,'mark_applied','an in-flight attempt past its window is settled like an unknown one');
 // a moved generation asks for a re-plan
 assert.equal(plan([rc('g1',{markerGeneration:1})],{g1:null}).actions[0].replan,true);
 // the bound: attempts exhausted and age
 assert.deepEqual(plan([rc('x1',{attempts:5})],{x1:null}).actions,[{requestId:'x1',action:'abandon',reason:'attempts_exhausted'}]);
 assert.deepEqual(plan([rc('x2',{attempts:4})],{x2:null}).actions[0].action,'replay');
 assert.deepEqual(reconcilePlan({receipts:[rc('x3')],observed:{x3:null},marker,now:iso(RETRY_POLICY.abandonAfterMs+1)}).actions,[{requestId:'x3',action:'abandon',reason:'expired'}]);
 // even an exhausted receipt whose target already holds the content is applied, not abandoned
 assert.equal(plan([rc('x4',{attempts:5})],{x4:{digest:'a'.repeat(64),revision:1}}).actions[0].action,'mark_applied');
 // deterministic order by due time then id; pure (no input mutated)
 const input=[rc('b',{nextAttemptAt:iso(2000)}),rc('a',{nextAttemptAt:iso(2000)}),rc('c',{nextAttemptAt:iso(1000)})];
 const copy=JSON.stringify(input);
 assert.deepEqual(plan(input).actions.map(item=>item.requestId),['c','a','b']);assert.equal(JSON.stringify(input),copy);
 assert.throws(()=>plan([rc('t',{nextAttemptAt:'garbage'})]),code('film_person_invalid'));
 // normalizeRequest accepts the registered kinds only
 for(const kind of OPERATION_KINDS)assert.equal(normalizeRequest({requestId:'r1',operation:kind,origin:'epg',target:{kind:'film',id:FILM},expectedRevision:0,digest:'a'.repeat(64)}).operation,kind);
}

// 9. Unreceipted detection: an observed canonical change without an applied receipt for its revision is reported, never treated as safe.
if(on(9)){
 const applied=(id,rev,kind='film')=>({target:{kind,id},state:'applied',appliedRevision:rev});
 let r=unreceiptedChanges({changes:[{kind:'film',id:'film:a',revision:1},{kind:'film',id:'film:b',revision:2},{kind:'person',id:'person:c',revision:1}],receipts:[applied('film:a',1),applied('film:b',1),{target:{kind:'person',id:'person:c'},state:'pending',appliedRevision:null}]});
 assert.deepEqual(r.unreceipted,[{kind:'film',id:'film:b',revision:2,reason:'no_receipt'},{kind:'person',id:'person:c',revision:1,reason:'receipt_not_applied'}]);
 assert.equal(r.covered,1);assert.equal(r.safe,false);
 assert.equal(unreceiptedChanges({changes:[{kind:'film',id:'film:a',revision:1}],receipts:[applied('film:a',1)]}).safe,true);
 assert.equal(unreceiptedChanges({changes:[],receipts:[]}).safe,true,'no change, nothing unreceipted');
 assert.equal(unreceiptedChanges({changes:[{kind:'film',id:'film:a',revision:1}],receipts:[]}).safe,false,'no receipt is never safe');
 assert.equal(unreceiptedChanges({changes:[{kind:'film',id:'film:a',revision:1}],receipts:[{target:{kind:'film',id:'film:a'},state:'abandoned',appliedRevision:null}]}).unreceipted[0].reason,'no_receipt','an abandoned receipt covers nothing');
 // against the database: a write outside the protocol is unreceipted; a receipted one is covered; a later unreceipted bump is reported again.
 const file=database('open'),env=envOf(file);
 await writeFilm(env,'Plain write');
 let found=await readUnreceipted(env);
 assert.deepEqual(found.unreceipted,[{kind:'film',id:FILM,revision:1,reason:'no_receipt'}]);assert.equal(found.safe,false);
 const file2=database('open'),env2=envOf(file2);
 const input=await request('event-covered');
 await receiptedWrite(env2,{...input,now:clockAt(0)},hooksFor(env2));
 found=await readUnreceipted(env2);
 assert.deepEqual(found.unreceipted,[]);assert.equal(found.safe,true);
 await writeFilm(env2,'Second plain write',1);
 found=await readUnreceipted(env2);
 assert.deepEqual(found.unreceipted,[{kind:'film',id:FILM,revision:2,reason:'no_receipt'}],'only the revision with no receipt');
 // a pending receipt for the target is called out, and still unreceipted.
 const file3=database('open'),env3=envOf(file3);
 const crashed=await request('event-crashed');
 await assert.rejects(()=>receiptedWrite(env3,{...crashed,now:clockAt(0)},{run:async()=>{await writeFilm(env3,SECRET_TITLE);throw new Error('lost');},readback:readbackFilm}));
 found=await readUnreceipted(env3);
 assert.deepEqual(found.unreceipted,[{kind:'film',id:FILM,revision:1,reason:'receipt_not_applied'}]);
 // bounded and refused without the table
 assert.ok((await readUnreceipted(env,{limit:1})).unreceipted.length<=1);
 await assert.rejects(()=>readUnreceipted(envOf(database('open',template18))),code('receipt_schema_missing'));
}

// 10. The reconciler pass over registered operations: settles by readback, replays with the same id, abandons, and is bounded.
if(on(10)){
 const file=database('open'),env=envOf(file);
 const registry=operationRegistry([FILM_OPERATION(env)]);
 assert.throws(()=>operationRegistry([FILM_OPERATION(env),FILM_OPERATION(env)]),code('film_person_invalid'));
 assert.throws(()=>defineOperation({operation:'nope',readback(){},replay(){}}),code('film_person_invalid'));
 assert.throws(()=>defineOperation({operation:'film_mutation',readback(){}}),code('film_person_invalid'));
 // three receipts: applied-then-lost (unknown), lost-before-send (unknown), and an unregistered operation.
 const landed=await request('event-1',SECRET_TITLE,{target:{kind:'film',id:'film:tmdb:10'}});
 await assert.rejects(()=>receiptedWrite(env,{...landed,now:clockAt(0)},{run:async()=>{await writeFilm(env,SECRET_TITLE,0,'film:tmdb:10');throw new Error('lost answer');},readback:readbackFilm}));
 const never=await request('event-2',SECRET_TITLE,{target:{kind:'film',id:'film:tmdb:11'}});
 await assert.rejects(()=>receiptedWrite(env,{...never,now:clockAt(0)},{run:async()=>{throw new Error('connect failed');},readback:readbackFilm}));
 const other=await request('event-3',SECRET_TITLE,{operation:'film_merge',target:{kind:'film',id:'film:tmdb:12'}});
 await assert.rejects(()=>receiptedWrite(env,{...other,now:clockAt(0)},{run:async()=>{throw new Error('x');},readback:readbackFilm}));
 // before they are due nothing happens
 const early=await reconcileReceipts(env,{operations:registry,now:clockAt(1000)});
 assert.equal(early.considered,0);assert.deepEqual(early.applied,[]);
 const pass=await reconcileReceipts(env,{operations:registry,now:clockAt(60000)});
 assert.equal(pass.marker,'open');assert.equal(pass.considered,3);
 assert.deepEqual(pass.applied,[landed.requestId],'the landed write is marked applied by readback, not re-run');
 assert.equal(revision(file,'film:tmdb:10'),1);
 // the lost-before-send one is replayed with the same request id against the current revision
 assert.equal(pass.replayed.length+pass.failed.length,1);
 assert.ok(pass.waiting.some(item=>item.requestId===other.requestId&&item.reason==='operation_unregistered'),'an unregistered operation is never guessed');
 const replayedRow=await readReceipt(env,never.requestId);
 assert.equal(replayedRow.requestId,never.requestId);
 // the replay writes the planned content for the target it names; the readback uses the shared digest.
 assert.equal(replayedRow.attempts,2);
 // a second pass has nothing due that it can settle again: idempotent.
 const second=await reconcileReceipts(env,{operations:registry,now:clockAt(60000)});
 assert.deepEqual(second.applied,[]);
 // bounded: limit caps the receipts read
 const many=database('open'),menv=envOf(many);
 for(let i=0;i<7;i++){const input=await request('bulk-'+i,SECRET_TITLE,{target:{kind:'film',id:'film:tmdb:'+(100+i)}});await assert.rejects(()=>receiptedWrite(menv,{...input,now:clockAt(0)},{run:async()=>{throw new Error('x');},readback:readbackFilm}));}
 const bounded=await reconcileReceipts(menv,{operations:operationRegistry([FILM_OPERATION(menv)]),now:clockAt(60000),limit:3});
 assert.equal(bounded.considered,3);
 assert.equal((await listReceipts(menv,{limit:1000})).length,4,'three of the seven were settled by the bounded pass');assert.equal((await listReceipts(menv,{states:['applied'],limit:1000})).length,3);
 assert.equal((await listReceipts(menv,{limit:1000,dueBefore:iso(0)})).length,0);
 // the read is capped whatever limit is asked for
 const wide=database('open');
 assert.equal(sqlite(wide,Array.from({length:55},(_,i)=>rawInsert({id:'w'+i,target:'film:w'+i})).join(';\n')).status,0);
 assert.equal((await listReceipts(envOf(wide),{limit:1000})).length,50,'the cap');
 assert.equal((await listReceipts(envOf(wide),{limit:0})).length,1,'at least one');
 // before open the reconciler writes nothing
 const r2=database('prepared');
 const idle=await reconcileReceipts(envOf(r2),{operations:registry,now:clockAt(99999999)});
 assert.equal(idle.considered,0);assert.equal(count(r2),0);
}

// 11. No payload and no personal data are stored; the statement budget of the protocol.
if(on(11)){
 const file=database('open');
 const watched=envOf(file);
 const input=await request('event-private',SECRET_TITLE);
 await receiptedWrite(watched,{...input,now:clockAt(0)},hooksFor(watched,SECRET_TITLE));
 const failing=await request('event-private-2',SECRET_NAME,{target:{kind:'film',id:'film:tmdb:2'}});
 await assert.rejects(()=>receiptedWrite(watched,{...failing,now:clockAt(0)},{run:async()=>{throw Object.assign(new Error('boom '+SECRET_NAME+' '+SECRET_TITLE),{code:'film_person_revision_conflict'});},readback:readbackFilm}));
 const dumped=JSON.stringify(receiptRows(file));
 for(const secret of [SECRET_TITLE,SECRET_NAME,'boom'])assert.ok(!dumped.includes(secret),'the receipt table holds no '+secret);
 const allowed={request_id:/^[A-Za-z0-9:._/=+@-]+$/,operation:/^[a-z_]+$/,origin:/^[a-z_]+$/,target_kind:/^(film|person)$/,target_id:/^(film|person):/,content_digest:/^[0-9a-f]{64}$/,error_class:/^[a-z_]+$/};
 for(const row of receiptRows(file))for(const [column,pattern] of Object.entries(allowed))if(row[column]!=null)assert.match(String(row[column]),pattern,column);
 assert.deepEqual(Object.keys(receiptRows(file)[0]).sort(),['applied_revision','attempts','content_digest','created_at','error_class','marker_generation','next_attempt_at','operation','origin','planned_revision','request_id','settled_at','state','target_id','target_kind','updated_at'],'the whole column set');
 // the budget: a new request is ONE read of the table availability, the five marker reads, ONE receipt read, ONE insert batch, the writer, ONE re-read of the receipt and ONE mark batch (in-batch applied adopters skip the mark batch).
 const file2=database('open');
 const env2=envOf(file2);
 const input2=await request('event-budget');
 const before={...env2.DB.calls};
 const writerCalls={batches:0,queries:0};
 await receiptedWrite(env2,{...input2,now:clockAt(0)},{run:async()=>{const b={...env2.DB.calls};const r=await writeFilm(env2,SECRET_TITLE);writerCalls.batches=env2.DB.calls.batches-b.batches;writerCalls.queries=env2.DB.calls.queries-b.queries;return r;},readback:readbackFilm});
 const used={batches:env2.DB.calls.batches-before.batches-writerCalls.batches,queries:env2.DB.calls.queries-before.queries-writerCalls.queries};
 assert.deepEqual(used,{batches:2,queries:8},'the receipt protocol adds exactly 2 batches and 8 reads to a new write: '+JSON.stringify(used));
 // each receipt batch stays inside its cap: fence + one write + one assertion.
 const sizes=[];
 const env3=envOf(database('open'),{onBatch:async list=>{sizes.push(list.length);}});
 await receiptedWrite(env3,{...await request('event-size'),now:clockAt(0)},hooksFor(env3));
 assert.ok(sizes.filter(size=>size<=3).length>=2,'receipt batches are at most 3 statements: '+sizes);
 // an already-applied replay costs no batch at all.
 const b0=env2.DB.calls.batches;
 await receiptedWrite(env2,{...input2,now:clockAt(5)},hooksFor(env2));
 assert.equal(env2.DB.calls.batches,b0,'an applied receipt replay writes nothing');
}

// 12. Dormant: no source file imports the module, it is not bundled, it has no R2 or network reference, and the fenced mutation module is untouched by it.
if(on(12)){
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&full!=='src/canonical-receipts.js'&&fs.readFileSync(full,'utf8').includes('canonical-receipts'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers,[],'no source file imports canonical-receipts');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-receipts'),file+' does not bundle it');
 const source=fs.readFileSync('src/canonical-receipts.js','utf8');
 assert.ok(!/\bfetch\(|BUCKET|R2|setTimeout|setInterval|cron|scheduled/i.test(source.replace(/\/\/.*$/gm,'')),'no network, R2, timer or schedule');
 assert.ok(!fs.readFileSync('src/canonical-mutations.js','utf8').includes('canonical-receipts'),'canonical-mutations.js is wrapped, not edited');
 assert.deepEqual(Object.keys(await import('../src/film-person-authority.js')).includes('receiptedWrite'),false);
 assert.ok(OPERATION_KINDS.includes('film_mutation')&&OPERATION_KINDS.includes('person_state')&&OPERATION_KINDS.includes('localization_conflict'));
 assert.equal(canonicalJson({b:1,a:[{d:undefined,c:2}]}),'{"a":[{"c":2}],"b":1}');
}

console.log('canonical-receipts: the durable canonical write receipt (schema 19) is writable only at open, records pending before the commit, settles unknown outcomes by readback both ways, bounds its retries, reports unreceipted changes, stores no payload, and stays dormant');
