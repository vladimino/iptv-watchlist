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
import crypto from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {mutateFilm,mutatePerson,fenced} from '../src/canonical-mutations.js';
import {failed} from '../src/film-person-authority.js';

const M=await import(process.env.CANON_RECEIPTS_SOURCE?pathToFileURL(path.resolve(process.env.CANON_RECEIPTS_SOURCE)).href:'../src/canonical-receipts.js');
const {receiptedWrite:rawWrite,reconcilePlan,reconcileReceipts,unreceiptedChanges,readUnreceipted,readReceipt,listReceipts,digestOf,canonicalJson,requestIdOf,backoffMs,classify,errorClassOf,defineOperation:rawDefine,operationRegistry:rawRegistry,
 appliedStatements,receiptsAvailable,assertReceiptsAvailable,normalizeRequest,RETRY_POLICY,OPERATION_KINDS,RECEIPT_STATES,recordBaseline,judgeReadback,receiptsStatus,BASELINE_CAP,verifyBaseline,listAttention,exceptionOf,APPROVED_EXCEPTIONS,validEvidence}=M;
// Atomic mode is REQUIRED by the module (owner decision, PR #530 comment 6802553275). Only the test seam below can approve the named legacy exception, so the separate-mark scenarios of sections 4 to 14 run through it;
// production code has no approved exception (APPROVED_EXCEPTIONS is empty) and sections 13 and 16 use the raw functions.
const EXCEPTION={id:'test-legacy-separate-mark',review:'test fixture',proof:'test fixture',ownerAcceptance:'test fixture'};
const APPROVED=[EXCEPTION.id];
const receiptedWrite=(env,input,hooks)=>rawWrite(env,input,hooks&&hooks.atomic===true?hooks:{exception:EXCEPTION,approvedExceptions:APPROVED,...hooks});
const defineOperation=spec=>rawDefine(spec.atomic===true?spec:{exception:EXCEPTION,...spec},{approved:APPROVED});
const operationRegistry=specs=>rawRegistry(specs,{approved:APPROVED});

const only=process.env.CANON_RECEIPTS_ONLY?new Set(process.env.CANON_RECEIPTS_ONLY.split(',')):null;
const on=(number,sub)=>!only||only.has(String(number))||(sub!==undefined&&only.has(number+'.'+sub));
const onAny=number=>!only||[...only].some(item=>item===String(number)||item.startsWith(number+'.'));
// Shared prebuilt templates (the mutation runner builds them once): CANON_RECEIPTS_TEMPLATES is a directory holding template.sqlite (schema 19) and template18.sqlite.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-receipts-'));
// The scenario databases are removed when the process ends (the mutation check starts it dozens of times: nothing may pile up in the temporary directory).
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
// This file tests the schema-19 receipt table: the chain stops at 0019 (migration 0020 follows it and has its own tests, tests/canonical-producer-schema.mjs).
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=19).sort().map(name=>name.replace(/\.sql$/,''));
const MIGRATION=process.env.CANON_RECEIPTS_MIGRATION||'migrations/0019_canonical_write_receipt.sql';
const sql=name=>name==='0019_canonical_write_receipt'?fs.readFileSync(MIGRATION,'utf8'):fs.readFileSync('migrations/'+name+'.sql','utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const template=path.join(root,'template.sqlite');
// A database one migration short (schema 18), for the schema-missing refusal.
const template18=path.join(root,'template18.sqlite');
const shared=process.env.CANON_RECEIPTS_TEMPLATES;
if(shared){
 fs.copyFileSync(path.join(shared,'template18.sqlite'),template18);
 if(process.env.CANON_RECEIPTS_MIGRATION){fs.copyFileSync(template18,template);assert.equal(sqlite(template,sql('0019_canonical_write_receipt')).status,0);}
 else fs.copyFileSync(path.join(shared,'template.sqlite'),template);
}else{
 assert.equal(sqlite(template,chain.map(sql).join('\n')).status,0);
 assert.equal(sqlite(template18,chain.filter(name=>name!=='0019_canonical_write_receipt').map(sql).join('\n')).status,0);
}
let n=0;
const EMPTY=crypto.createHash('sha256').update('[]').digest('hex');
// A watermark and a seal for an EMPTY canonical_revision (every scenario database starts empty), with the digest of the empty set.
const WM=generation=>"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,"+generation+",0,0,0,0,0,'2026-11-11T09:00:00.000Z')";
const SEAL="INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z')";
const BASELINE=WM(2)+";"+SEAL+";";
// A database at `open` carries the activation baseline unless `baseline` is false (the baseline tests take it themselves).
function database(stage='open',source=template,baseline=true){
 const file=path.join(root,'rc-'+(n++)+'.sqlite');
 fs.copyFileSync(source,file);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='held'&&baseline&&source===template)assert.equal(sqlite(file,BASELINE).status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 if(stage==='open'&&baseline&&source===template)assert.equal(sqlite(file,BASELINE).status,0);
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
// The operation-specific evidence: a writer that wants a lost mark settled by readback writes STRUCTURED evidence {requestId, target, appliedRevision, contentDigest} as an alias row inside its OWN batch; the readback
// returns it and the MODULE validates it against the receipt (validEvidence). A write without it (another actor's) proves nothing.
const filmContent=(title,contractVersion=1)=>({originalTitle:title,contractVersion});
const plannedDigest=title=>digestOf(filmContent(title));
const evidenceOf=async(requestId,id,appliedRevision,title)=>({requestId,target:{kind:'film',id},appliedRevision,contentDigest:await plannedDigest(title)});
const readbackFilm=async(env,target,receipt)=>{
 const row=await env.DB.prepare('SELECT original_title,contract_version FROM film WHERE id=?').bind(target.id).first();
 if(!row)return null;
 const rev=await env.DB.prepare('SELECT revision FROM canonical_revision WHERE kind=? AND id=?').bind(target.kind,target.id).first();
 const out={digest:await digestOf(filmContent(row.original_title,row.contract_version)),revision:Number(rev?.revision??0)};
 if(receipt){
  const alias=await env.DB.prepare("SELECT value FROM film_alias WHERE film_id=? AND kind='request' AND value LIKE ?").bind(target.id,'%"requestId":"'+receipt.requestId+'"%').first();
  if(alias)out.evidence=JSON.parse(alias.value);
 }
 return out;
};
const writeFilm=async(env,title,expectedRevision=0,id=FILM,requestId=null)=>mutateFilm(env,{id,expectedRevision,at:T,film:{contractVersion:1,originalTitle:title,...(requestId?{aliases:[{kind:'request',value:JSON.stringify(await evidenceOf(requestId,id,expectedRevision+1,title))}]}:{})}});
async function request(source,title=SECRET_TITLE,over={}){
 return {requestId:await requestIdOf({origin:'epg',operation:'film_mutation',source}),operation:'film_mutation',origin:'epg',target:{kind:'film',id:FILM},expectedRevision:0,digest:await plannedDigest(title),...over};
}
const hooksFor=(env,title=SECRET_TITLE,calls={run:0,readback:0})=>({
 run:async()=>{calls.run++;return writeFilm(env,title);},
 readback:async(...args)=>{calls.readback++;return readbackFilm(env,args[1],args[2]);},
});
const FILM_OPERATION=env=>defineOperation({operation:'film_mutation',readback:(e,target,receipt)=>readbackFilm(env,target,receipt),replay:(e,receipt,ctx)=>mutateFilm(env,{id:receipt.target.id,expectedRevision:ctx.currentRevision,at:T,film:{contractVersion:1,originalTitle:SECRET_TITLE}})});
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
 for(const table of ['canonical_receipt_watermark','canonical_receipt_baseline','canonical_receipt_baseline_seal'])assert.equal(Number(one(file,'SELECT COUNT(*) FROM '+table)),0,table+' starts empty');
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
  assert.equal(sqlite(file,'DROP TRIGGER canonical_write_receipt_insert_baseline').status,0,'the baseline trigger is dropped so that the marker trigger is the only one that can refuse');
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
if(onAny(4)){
 const file=database('open');
 const env=envOf(file);
 const calls={run:0,readback:0};
 const input=await request('event-1');
 if(on(4,1)){
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
 }
 if(on(4,2)){
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
if(onAny(6)){
 if(on(6,1)){
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
 }
 const file=database('open');
 const env=envOf(file);
 const input=await request('event-retry');
 const calls={run:0,readback:0};
 const conflict=async()=>{calls.run++;throw failed('film_person_revision_conflict');};
 const hooks={run:conflict,readback:async()=>{calls.readback++;return null;}};
 if(on(6,2)){
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
 }
 if(on(6,3)){
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
}

// 7. Unknown outcomes settled by READBACK, both ways, and a crash between the commit and the mark.
if(onAny(7)){
 // applied-then-lost: the commit landed, the answer was lost. The receipt is unknown; readback finds the content, marks applied, and the writer does NOT run again.
 if(on(7,1)){
  const file=database('open'),env=envOf(file);
  const input=await request('event-applied-lost');
  const calls={run:0,readback:0};
  const lost={run:async()=>{calls.run++;await writeFilm(env,SECRET_TITLE,0,FILM,input.requestId);throw new Error('network reset');},readback:async(...a)=>{calls.readback++;return readbackFilm(env,a[1],a[2]);}};
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
 if(on(7,2)){
  const file=database('open'),env=envOf(file);
  const input=await request('event-lost-before');
  const calls={run:0,readback:0};
  const hooks={run:async()=>{calls.run++;if(calls.run===1)throw new Error('fetch failed');return writeFilm(env,SECRET_TITLE);},readback:async(...a)=>{calls.readback++;return readbackFilm(env,a[1],a[2]);}};
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
 if(on(7,3)){
  const file=database('open'),env=envOf(file);
  await writeFilm(env,'Somebody else');
  const input=await request('event-other-content',SECRET_TITLE,{expectedRevision:1});
  const hooks={run:async()=>{throw new Error('timeout');},readback:async(...a)=>readbackFilm(env,a[1],a[2])};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks));
  const result=await receiptedWrite(env,{...input,now:clockAt(60000)},{run:async()=>writeFilm(env,SECRET_TITLE,1),readback:hooks.readback});
  assert.equal(result.state,'applied');assert.equal(result.attempt,2);assert.equal(filmRow(file).original_title,SECRET_TITLE);
 }
 // crash between the commit and the mark: the receipt stays pending, the writer's result is returned, and after its window readback marks it applied.
 if(on(7,4)){
  const file=database('open');
  const env=envOf(file,{onBatch:async list=>{if(list.some(item=>/SET state='applied'/.test(item.text)))throw new Error('D1 unavailable');}});
  const plain=envOf(file);
  const input=await request('event-mark-lost');
  const calls={run:0,readback:0};
  const hooks={run:async()=>{calls.run++;return writeFilm(plain,SECRET_TITLE,0,FILM,input.requestId);},readback:async(...a)=>{calls.readback++;return readbackFilm(plain,a[1],a[2]);}};
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
 if(on(7,5)){
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
 if(on(7,6)){
  const file=database('open'),env=envOf(file);
  const input=await request('event-regeneration');
  let first=true;
  const hooks={run:async()=>{if(first){first=false;throw new Error('timeout');}return writeFilm(env,SECRET_TITLE);},readback:async(...a)=>readbackFilm(env,a[1],a[2])};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks),/timeout/);
  assert.equal((await readReceipt(env,input.requestId)).markerGeneration,2);
  assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1").status,0);
  const result=await receiptedWrite(env,{...input,now:clockAt(60000)},hooks);
  assert.equal(result.state,'applied');
  const row=await readReceipt(env,input.requestId);
  assert.equal(row.markerGeneration,4);assert.equal(row.attempts,2);
 }
 // a held marker after the commit: the receipt stays pending (a held database accepts no receipt write) and is settled once reopened.
 if(on(7,7)){
  const file=database('open'),env=envOf(file);
  const input=await request('event-held-after');
  const hooks={run:async()=>{await writeFilm(env,SECRET_TITLE,0,FILM,input.requestId);assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);return {revision:1};},readback:async(...a)=>readbackFilm(env,a[1],a[2])};
  const first=await receiptedWrite(env,{...input,now:clockAt(0)},hooks);
  assert.equal(first.state,'pending');assert.equal(first.markFailed,true);
  assert.equal((await readReceipt(env,input.requestId)).state,'pending','held: the receipt is frozen, never guessed');
  let reads=0;
  const counting=defineOperation({operation:'film_mutation',readback:async(...a)=>{reads++;return readbackFilm(env,a[1],a[2]);},replay:async()=>{throw new Error('must not replay');}});
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
 const ev=(requestId,over={})=>({requestId,target:{kind:'film',id:FILM},appliedRevision:1,contentDigest:'a'.repeat(64),...over});
 assert.deepEqual(plan([rc('u1',{state:'unknown'})],{u1:{digest:'a'.repeat(64),revision:4,evidence:ev('u1')}}).actions,[{requestId:'u1',action:'mark_applied',revision:1}],'the revision is the one the evidence says');
 // the planned content WITHOUT proof of this request is never applied: it is for review
 assert.deepEqual(plan([rc('u1',{state:'unknown'})],{u1:{digest:'a'.repeat(64),revision:4}}).actions,[{requestId:'u1',action:'needs_review',reason:'content_match_unproven'}]);
 // proof of the request wins even when the content was overwritten since
 assert.deepEqual(plan([rc('u1',{state:'unknown'})],{u1:{digest:'c'.repeat(64),revision:3,evidence:ev('u1')}}).actions,[{requestId:'u1',action:'mark_applied',revision:1}]);
 // evidence that does not validate against THIS receipt is for review, never applied, whatever the content is
 for(const [name,evidence] of [['another request',ev('other')],['another target',ev('u1',{target:{kind:'film',id:'film:other'}})],['another target kind',ev('u1',{target:{kind:'person',id:FILM}})],['another revision',ev('u1',{appliedRevision:2})],['a string revision',ev('u1',{appliedRevision:'1'})],['another digest',ev('u1',{contentDigest:'b'.repeat(64)})],['an extra field',ev('u1',{extra:1})],['a missing field',{requestId:'u1',target:{kind:'film',id:FILM},appliedRevision:1}],['an extra target field',ev('u1',{target:{kind:'film',id:FILM,x:1}})],['an array',[]],['a string','proof'],['null',null],['a flag',true]])for(const digest of ['a'.repeat(64),'c'.repeat(64)])assert.deepEqual(plan([rc('u1',{state:'unknown'})],{u1:{digest,revision:1,evidence}}).actions,[{requestId:'u1',action:'needs_review',reason:'evidence_invalid'}],name+' ('+digest[0]+')');
 assert.equal(validEvidence(ev('u1'),{requestId:'u1',target:{kind:'film',id:FILM},contentDigest:'a'.repeat(64),plannedRevision:0}),true);
 assert.equal(validEvidence(ev('u1'),{requestId:'u1',target:{kind:'film',id:FILM},contentDigest:'a'.repeat(64),plannedRevision:1}),false,'evidence of another planned revision');
 assert.equal(judgeReadback({digest:'z',evidence:ev('u1')},{requestId:'u1',target:{kind:'film',id:FILM},contentDigest:'a'.repeat(64),plannedRevision:0}),'applied');assert.equal(judgeReadback({digest:'a'.repeat(64),evidence:{proof:'request'}},{requestId:'u1',target:{kind:'film',id:FILM},contentDigest:'a'.repeat(64),plannedRevision:0}),'evidence_invalid','a bare flag is not evidence');assert.equal(judgeReadback({digest:'a'.repeat(64)},{contentDigest:'a'.repeat(64)}),'content_unproven');assert.equal(judgeReadback(null,{contentDigest:'a'}),'absent');
 assert.deepEqual(plan([rc('u1',{state:'unknown'})],{u1:{digest:'b'.repeat(64),revision:4}}).actions,[{requestId:'u1',action:'replay',attempt:2,replan:false}]);
 assert.deepEqual(plan([rc('u1',{state:'failed'})],{u1:null}).actions,[{requestId:'u1',action:'replay',attempt:2,replan:false}]);
 assert.equal(plan([rc('u1',{state:'pending'})],{u1:{digest:'a'.repeat(64),revision:2,evidence:ev('u1')}}).actions[0].action,'mark_applied','an in-flight attempt past its window is settled like an unknown one');
 // a moved generation asks for a re-plan
 assert.equal(plan([rc('g1',{markerGeneration:1})],{g1:null}).actions[0].replan,true);
 // the bound: attempts exhausted and age
 assert.deepEqual(plan([rc('x1',{attempts:5})],{x1:null}).actions,[{requestId:'x1',action:'abandon',reason:'attempts_exhausted'}]);
 assert.deepEqual(plan([rc('x2',{attempts:4})],{x2:null}).actions[0].action,'replay');
 assert.deepEqual(reconcilePlan({receipts:[rc('x3')],observed:{x3:null},marker,now:iso(RETRY_POLICY.abandonAfterMs+1)}).actions,[{requestId:'x3',action:'abandon',reason:'expired'}]);
 // even an exhausted receipt is settled by proof (applied) or sent to review (content alone), not abandoned as absent
 assert.equal(plan([rc('x4',{attempts:5})],{x4:{digest:'a'.repeat(64),revision:1,evidence:ev('x4')}}).actions[0].action,'mark_applied');
 assert.equal(plan([rc('x4',{attempts:5})],{x4:{digest:'a'.repeat(64),revision:1}}).actions[0].action,'needs_review');
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
 // the baseline: a revision at or below its baseline entry predates receipts and is not unreceipted; above it, it is
 r=unreceiptedChanges({changes:[{kind:'film',id:'film:a',revision:2},{kind:'film',id:'film:b',revision:3},{kind:'film',id:'film:c',revision:1}],receipts:[],baseline:{'film|film:a':2,'film|film:b':2}});
 assert.deepEqual(r.preReceiptBaseline,[{kind:'film',id:'film:a',revision:2}]);assert.deepEqual(r.unreceipted.map(item=>item.id),['film:b','film:c']);assert.equal(r.safe,false);
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
if(onAny(10)){
 const file=database('open'),env=envOf(file);
 const registry=operationRegistry([FILM_OPERATION(env)]);
 assert.throws(()=>operationRegistry([FILM_OPERATION(env),FILM_OPERATION(env)]),code('film_person_invalid'));
 assert.throws(()=>defineOperation({operation:'nope',readback(){},replay(){}}),code('film_person_invalid'));
 assert.throws(()=>defineOperation({operation:'film_mutation',readback(){}}),code('film_person_invalid'));
 if(on(10,1)){
 // three receipts: applied-then-lost (unknown), lost-before-send (unknown), and an unregistered operation.
 const landed=await request('event-1',SECRET_TITLE,{target:{kind:'film',id:'film:tmdb:10'}});
 await assert.rejects(()=>receiptedWrite(env,{...landed,now:clockAt(0)},{run:async()=>{await writeFilm(env,SECRET_TITLE,0,'film:tmdb:10',landed.requestId);throw new Error('lost answer');},readback:readbackFilm}));
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
 }
 if(on(10,2)){
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
}

// 11. No payload and no personal data are stored; the statement budget of the protocol.
if(onAny(11)){
 if(on(11,1)){
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
 }
 if(on(11,2)){
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
}

// 12. Dormant: no source file imports the module, it is not bundled, it has no R2 or network reference, and the fenced mutation module is untouched by it.
if(on(12)){
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&full!=='src/canonical-receipts.js'&&fs.readFileSync(full,'utf8').includes('canonical-receipts'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers.sort(),['src/canonical-person-adapters.js','src/canonical-person-mutation-producer.js','src/canonical-producer-adapters.js','src/canonical-producer-run.js','src/canonical-producers.js'],'only the dormant producers module (readiness, read-only), the dormant receipt adapters and the dormant pure producer-run module (ADR 0128, S4-1: pure helpers only) import canonical-receipts');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-receipts'),file+' does not bundle it');
 const source=fs.readFileSync('src/canonical-receipts.js','utf8');
 assert.ok(!/\bfetch\(|BUCKET|R2|setTimeout|setInterval|cron|scheduled/i.test(source.replace(/\/\/.*$/gm,'')),'no network, R2, timer or schedule');
 assert.ok(!fs.readFileSync('src/canonical-mutations.js','utf8').includes('canonical-receipts'),'canonical-mutations.js does not import the receipt module (it owns the applied tail SQL, AIR-374 P3-0a)');
 assert.deepEqual(Object.keys(await import('../src/film-person-authority.js')).includes('receiptedWrite'),false);
 assert.ok(OPERATION_KINDS.includes('film_mutation')&&OPERATION_KINDS.includes('person_state')&&OPERATION_KINDS.includes('localization_conflict'));
 assert.equal(canonicalJson({b:1,a:[{d:undefined,c:2}]}),'{"a":[{"c":2}],"b":1}');
}

// 13. What `applied` means: the atomic path, and the weaker separate-mark path that can never claim more than it can prove.
if(on(13)){
 // two actors reach identical content: the lost mark is NOT settled as applied by the content alone, it goes to review, and the writer does not run again.
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-twin');
  const calls={run:0,readback:0};
  const hooks={run:async()=>{calls.run++;await writeFilm(env,SECRET_TITLE);throw new Error('answer lost');},readback:async(...a)=>{calls.readback++;return readbackFilm(env,a[1],a[2]);}};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks),/answer lost/);
  const settled=await receiptedWrite(env,{...input,now:clockAt(60000)},hooks);
  assert.equal(settled.state,'abandoned');assert.equal(settled.needsReview,true);assert.equal(settled.reason,'content_match_unproven');assert.equal(settled.ran,false);
  assert.equal(calls.run,1,'no second write');
  const row=await readReceipt(env,input.requestId);
  assert.equal(row.state,'abandoned');assert.equal(row.errorClass,'content_match_unproven');assert.equal(row.appliedRevision,null,'never reported applied');
  // the reconciler reports it the same way
  const file2=database('open'),env2=envOf(file2);
  const in2=await request('event-twin-2');
  await assert.rejects(()=>receiptedWrite(env2,{...in2,now:clockAt(0)},{run:async()=>{await writeFilm(env2,SECRET_TITLE);throw new Error('x');},readback:readbackFilm}));
  const pass=await reconcileReceipts(env2,{operations:operationRegistry([FILM_OPERATION(env2)]),now:clockAt(60000)});
  assert.deepEqual(pass.needsReview,[in2.requestId]);assert.deepEqual(pass.applied,[]);assert.equal(pass.attention===undefined,false);
 }
 // the same content written by the request WITH evidence in its own batch is applied; and when it was overwritten later by a newer revision it is STILL applied (the effect happened), without a second write.
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-overwritten');
  const calls={run:0};
  const hooks={run:async()=>{calls.run++;await writeFilm(env,SECRET_TITLE,0,FILM,input.requestId);throw new Error('answer lost');},readback:readbackFilm};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks));
  await writeFilm(env,'A newer title by another writer',1);
  assert.equal(revision(file,FILM),2);
  const pass=await reconcileReceipts(env,{operations:operationRegistry([FILM_OPERATION(env)]),now:clockAt(60000)});
  assert.deepEqual(pass.applied,[input.requestId]);assert.equal(calls.run,1);
  assert.equal(filmRow(file).original_title,'A newer title by another writer','the newer content is untouched');
  assert.equal((await readReceipt(env,input.requestId)).appliedRevision,1,'the revision this request landed at, not the current one');
 }
 // the mark is lost, then reconcile: settled by the request's own evidence (covered in section 7 for a held marker and a crashed mark).
 // ATOMIC mode: the writer's own batch applies the receipt; this module never marks it by a second batch.
 {
  const file=database('open');
  const batches=[];
  const env=envOf(file,{onBatch:async list=>{batches.push(list.map(item=>item.text).join(' '));}});
  const input=await request('event-atomic-mode');
  const entities=[{kind:'film',id:FILM,expected:0}];
  const writer=skip=>async ctx=>{
   const statements=fenced.head(ctx.gate,entities);
   statements.push(['INSERT INTO film (id,contract_version,original_title,updated_at) VALUES (?,?,?,?)',[FILM,1,SECRET_TITLE,T]]);
   statements.push([fenced.BUMP,['film',FILM,T]]);
   if(!skip)statements.push(...ctx.appliedStatements());
   await fenced.commit(env,ctx.gate,statements,entities);
   return {revision:1};
  };
  const done=await receiptedWrite(env,{...input,now:clockAt(0)},{run:writer(false),readback:readbackFilm,atomic:true});
  assert.equal(done.state,'applied');
  assert.equal(batches.filter(text=>text.includes("SET state='applied'")).length,1,'exactly one batch carries the applied mark: the writer\'s own');
  assert.ok(batches.find(text=>text.includes("SET state='applied'")).includes('INSERT INTO film '),'and it is the one that carries the content');
  // an atomic writer that forgets appliedStatements is NOT marked applied by this module: unknown, for review
  const file2=database('open'),env2=envOf(file2);
  const in2=await request('event-atomic-forgot');
  const forgetful=async ctx=>{const st=fenced.head(ctx.gate,entities);st.push(['INSERT INTO film (id,contract_version,original_title,updated_at) VALUES (?,?,?,?)',[FILM,1,SECRET_TITLE,T]]);st.push([fenced.BUMP,['film',FILM,T]]);await fenced.commit(env2,ctx.gate,st,entities);return {revision:1};};
  const result=await receiptedWrite(env2,{...in2,now:clockAt(0)},{run:forgetful,readback:readbackFilm,atomic:true});
  assert.equal(result.state,'unknown');assert.equal(result.needsReview,true);assert.equal(result.errorClass,'atomic_mark_missing');
  const row=await readReceipt(env2,in2.requestId);
  assert.equal(row.state,'unknown');assert.equal(row.errorClass,'atomic_mark_missing');assert.equal(row.appliedRevision,null);
  assert.equal(defineOperation({operation:'film_mutation',readback(){},replay(){},atomic:true}).atomic,true);
  assert.equal(defineOperation({operation:'film_mutation',readback(){},replay(){}}).atomic,false);
 }
}

// 14. A retry never blindly overwrites: an unrelated writer advanced the entity revision between attempts (direct retry and the reconcile pass).
if(on(14)){
 const other='Another writer title';
 // direct retry, no revalidate: abandoned for repair, the newer content stays
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-stale-direct');
  const calls={run:0};
  const hooks={run:async()=>{calls.run++;throw new Error('timeout');},readback:readbackFilm};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks));
  await writeFilm(env,other);
  const result=await receiptedWrite(env,{...input,now:clockAt(60000)},hooks);
  assert.equal(result.state,'abandoned');assert.equal(result.reason,'stale_revision_needs_repair');assert.equal(calls.run,1,'no retry was run');
  assert.equal(filmRow(file).original_title,other);assert.equal(revision(file,FILM),1);
  assert.equal((await readReceipt(env,input.requestId)).errorClass,'stale_revision_needs_repair');
 }
 // direct retry, revalidate says superseded: abandoned, newer content stays
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-stale-superseded');
  const hooks={run:async()=>{throw new Error('timeout');},readback:readbackFilm,revalidate:async()=>'superseded'};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks));
  await writeFilm(env,other);
  const result=await receiptedWrite(env,{...input,now:clockAt(60000)},hooks);
  assert.equal(result.reason,'superseded_by_newer_revision');assert.equal(filmRow(file).original_title,other);
 }
 // direct retry, revalidate says proceed: the writer is given the CURRENT revision (not the original expectation) and its CAS passes; planned_revision follows
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-stale-proceed');
  let seen=null;
  const hooks={run:async ctx=>{if(ctx.attempt===1)throw new Error('timeout');seen=ctx.currentRevision;return writeFilm(env,SECRET_TITLE,ctx.currentRevision);},readback:readbackFilm,revalidate:async(e,receipt,ctx)=>{assert.equal(ctx.currentRevision,1);return 'proceed';}};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks));
  await writeFilm(env,other);
  const result=await receiptedWrite(env,{...input,now:clockAt(60000)},hooks);
  assert.equal(result.state,'applied');assert.equal(seen,1);assert.equal(revision(file,FILM),2);
  const row=await readReceipt(env,input.requestId);
  assert.equal(row.plannedRevision,1);assert.equal(row.appliedRevision,2);
 }
 // a retry whose revision did NOT move needs no revalidation (the writer's own CAS still holds)
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-stale-none');
  let first=true,asked=0;
  const hooks={run:async()=>{if(first){first=false;throw new Error('timeout');}return writeFilm(env,SECRET_TITLE);},readback:readbackFilm,revalidate:async()=>{asked++;return 'proceed';}};
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooks));
  assert.equal((await receiptedWrite(env,{...input,now:clockAt(60000)},hooks)).state,'applied');assert.equal(asked,0);
 }
 // the reconcile pass: no revalidate on the operation -> abandoned for repair, newer content untouched; a revalidating operation proceeds against the current revision
 {
  const file=database('open'),env=envOf(file);
  const input=await request('event-stale-pass');
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},{run:async()=>{throw new Error('timeout');},readback:readbackFilm}));
  await writeFilm(env,other);
  const replay=async()=>{throw new Error('must not replay a stale revision blindly');};
  const bare=defineOperation({operation:'film_mutation',readback:(e,t,r)=>readbackFilm(env,t,r),replay});
  const pass=await reconcileReceipts(env,{operations:operationRegistry([bare]),now:clockAt(60000)});
  assert.deepEqual(pass.abandoned,[{requestId:input.requestId,reason:'stale_revision_needs_repair'}]);
  assert.equal(filmRow(file).original_title,other);assert.equal(revision(file,FILM),1);
  const file2=database('open'),env2=envOf(file2);
  const in2=await request('event-stale-pass-2');
  await assert.rejects(()=>receiptedWrite(env2,{...in2,now:clockAt(0)},{run:async()=>{throw new Error('timeout');},readback:readbackFilm}));
  await writeFilm(env2,other);
  let asked=null;
  const checking=defineOperation({operation:'film_mutation',readback:(e,t,r)=>readbackFilm(env2,t,r),revalidate:async(e,receipt,ctx)=>{asked=ctx.currentRevision;return 'proceed';},replay:(e,receipt,ctx)=>writeFilm(env2,SECRET_TITLE,ctx.currentRevision)});
  const pass2=await reconcileReceipts(env2,{operations:operationRegistry([checking]),now:clockAt(60000)});
  assert.deepEqual(pass2.replayed,[in2.requestId]);assert.equal(asked,1);assert.equal(revision(file2,FILM),2);
  const file3=database('open'),env3=envOf(file3);
  const in3=await request('event-stale-pass-3');
  await assert.rejects(()=>receiptedWrite(env3,{...in3,now:clockAt(0)},{run:async()=>{throw new Error('timeout');},readback:readbackFilm}));
  await writeFilm(env3,other);
  const superseding=defineOperation({operation:'film_mutation',readback:(e,t,r)=>readbackFilm(env3,t,r),revalidate:async()=>'superseded',replay});
  const pass3=await reconcileReceipts(env3,{operations:operationRegistry([superseding]),now:clockAt(60000)});
  assert.deepEqual(pass3.abandoned,[{requestId:in3.requestId,reason:'superseded_by_newer_revision'}]);assert.equal(filmRow(file3).original_title,other);
 }
}

// 15. The activation baseline: what `unreceipted` covers, and that a fresh schema 19 does not pretend history has receipts.
if(on(15)){
 const file=database('open',template,false),env=envOf(file);
 // pre-existing revisions (written before any receipt exists), no baseline yet: receipts are refused, nothing reads as safe
 await writeFilm(env,'Old film one');await writeFilm(env,'Old film two',0,'film:tmdb:2');
 assert.equal(await receiptsStatus(env),'no_baseline');
 const input=await request('event-baseline');
 const calls={run:0,readback:0};
 await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},hooksFor(env,SECRET_TITLE,calls)),code('receipt_baseline_missing'));
 assert.equal(calls.run,0,'no write without the baseline');assert.equal(count(file),0);
 await assert.rejects(()=>readUnreceipted(env),code('receipt_baseline_missing'));
 assert.match(message(sqlite(file,rawInsert())),/canonical_receipt_baseline_missing/,'and the table refuses a receipt before the baseline');
 // recording the baseline: one fenced batch, every entity, no receipt
 const taken=await recordBaseline(env,{now:clockAt(5)});
 assert.equal(taken.entries,2);assert.equal(await receiptsStatus(env),'ready');
 assert.deepEqual(rows(file,'SELECT kind,id,revision FROM canonical_receipt_baseline ORDER BY id').map(row=>row.revision),[1,1]);
 assert.equal(Number(one(file,'SELECT entries FROM canonical_receipt_watermark')),2);assert.equal(count(file),0,'no receipt was invented for the history');
 // the history is pre_receipt_baseline, not unreceipted, and not safe-by-receipt either: it is counted apart
 let found=await readUnreceipted(env);
 assert.deepEqual(found.unreceipted,[]);assert.equal(found.preReceiptBaselineCount,2);assert.equal(found.safe,true);
 // a change above the baseline without a receipt IS unreceipted; a receipted one is not
 await writeFilm(env,'After activation',1);
 found=await readUnreceipted(env);
 assert.deepEqual(found.unreceipted,[{kind:'film',id:FILM,revision:2,reason:'no_receipt'}]);assert.equal(found.safe,false);assert.equal(found.preReceiptBaselineCount,1);
 const covered=await request('event-after',SECRET_TITLE,{target:{kind:'film',id:'film:tmdb:3'}});
 await receiptedWrite(env,{...covered,now:clockAt(0)},{run:()=>writeFilm(env,SECRET_TITLE,0,'film:tmdb:3'),readback:readbackFilm});
 found=await readUnreceipted(env);
 assert.deepEqual(found.unreceipted.map(item=>item.id),[FILM],'only the unreceipted change');
 // the baseline is taken once, insert-only, and never after a receipt
 await assert.rejects(()=>recordBaseline(env,{now:clockAt(6)}),code('receipt_baseline_exists'),'a second baseline, receipts or not');
 const once=database('open',template,false),onceEnv=envOf(once);
 await recordBaseline(onceEnv,{now:clockAt(1)});
 await assert.rejects(()=>recordBaseline(onceEnv,{now:clockAt(2)}),code('receipt_baseline_exists'),'once');
 for(const statement of ["UPDATE canonical_receipt_baseline SET revision=revision+1","DELETE FROM canonical_receipt_baseline","UPDATE canonical_receipt_watermark SET entries=0","DELETE FROM canonical_receipt_watermark","UPDATE canonical_receipt_baseline_seal SET sealed_at=sealed_at","DELETE FROM canonical_receipt_baseline_seal"])assert.match(message(sqlite(file,statement)),/canonical_receipt_baseline_immutable/,statement);
 assert.match(message(sqlite(file,"INSERT INTO canonical_receipt_baseline (kind,id,revision) VALUES ('film','film:late',1)")),/canonical_receipt_baseline_refused/,'a baseline row after a receipt exists');
 // refused unless the marker is open, and bounded
 for(const stage of ['prepared','held']){
  const f=database(stage,template,false);
  await assert.rejects(()=>recordBaseline(envOf(f)),code(stage==='held'?'film_person_held':'film_person_not_open'));
  assert.equal(Number(one(f,'SELECT COUNT(*) FROM canonical_receipt_watermark')),0);
 }
 const f2=database('open',template,false);
 await writeFilm(envOf(f2),'x');await writeFilm(envOf(f2),'y',0,'film:tmdb:9');
 await assert.rejects(()=>recordBaseline(envOf(f2),{cap:1}),code('baseline_over_capacity'));
 for(const table of ['canonical_receipt_baseline','canonical_receipt_watermark','canonical_receipt_baseline_seal'])assert.equal(Number(one(f2,'SELECT COUNT(*) FROM '+table)),0,'over capacity records nothing in '+table);
 assert.equal(await receiptsStatus(envOf(f2)),'no_baseline','a refused baseline leaves nothing behind');
 assert.equal(BASELINE_CAP,5000);
 // a baseline under a stale generation is refused in SQL
 const f3=database('open',template,false);
 assert.match(message(sqlite(f3,WM(1))),/canonical_receipt_baseline_refused/);
 // raw inserts: baseline rows only before the watermark (by the copying batch); the watermark only equal to the rows it describes; the seal only after the watermark; a held marker accepts none of them
 const f4=database('open',template,false);
 assert.match(message(sqlite(f4,SEAL)),/canonical_receipt_baseline_refused/,'a seal without the watermark');
 assert.equal(sqlite(f4,"INSERT INTO canonical_receipt_baseline (kind,id,revision) VALUES ('film','film:x',1)").status,0,'a baseline row before the watermark (the copying batch writes them first)');
 // the watermark must equal what the copied rows say, field by field (per kind: count and highest revision)
 assert.equal(sqlite(f4,"INSERT INTO canonical_receipt_baseline (kind,id,revision) VALUES ('person','person:p',3)").status,0);
 const WMX=(entries,fc,fmax,pc,pmax)=>"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,"+entries+","+fc+","+fmax+","+pc+","+pmax+",'2026-11-11T09:00:00.000Z')";
 for(const [name,statement] of [['the film count',WMX(2,0,1,2,3)],['the film highest revision',WMX(2,1,9,1,3)],['the person count',WMX(2,2,1,0,3)],['the person highest revision',WMX(2,1,1,1,9)],['everything zero',WM(2)]])assert.match(message(sqlite(f4,statement)),/canonical_receipt_baseline_refused/,'a watermark with the wrong '+name);
 // held marker, watermark present, no seal yet: the seal is refused
 const f9=database('open',template,false);
 assert.equal(sqlite(f9,WM(2)).status,0);
 assert.equal(sqlite(f9,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 assert.match(message(sqlite(f9,SEAL)),/canonical_receipt_baseline_refused/,'a seal while held');
 assert.equal(sqlite(f4,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);

 assert.match(message(sqlite(f4,"INSERT INTO canonical_receipt_baseline (kind,id,revision) VALUES ('film','film:y',1)")),/canonical_receipt_baseline_refused/,'a baseline row while held');
 assert.match(message(sqlite(f4,WM(3))),/canonical_receipt_baseline_refused/,'a watermark while held');
 const held=database('held');
 assert.match(message(sqlite(held,"INSERT INTO canonical_receipt_baseline (kind,id,revision) VALUES ('film','film:x',1)")),/canonical_receipt_baseline_refused/,'a baseline row after the watermark');
 // schema 18: no status
 assert.equal(await receiptsStatus(envOf(database('open',template18))),'no_schema');
 await assert.rejects(()=>recordBaseline(envOf(database('open',template18))),code('receipt_schema_missing'));
}

// 16. ATOMIC MODE IS REQUIRED: nothing registers or writes without it unless it carries an approved named exception (none exists); mutation and receipt are all-or-nothing; two actors with identical content.
if(on(16)){
 // registration and the write itself refuse non-atomic adapters, before anything is read or written
 assert.equal(APPROVED_EXCEPTIONS.length,0,'no operation has an approved exception today');assert.ok(Object.isFrozen(APPROVED_EXCEPTIONS));
 const base={operation:'film_mutation',readback(){},replay(){}};
 assert.throws(()=>rawDefine(base),code('receipt_atomic_required'));
 assert.throws(()=>rawDefine({...base,atomic:false}),code('receipt_atomic_required'));
 assert.throws(()=>rawDefine({...base,exception:EXCEPTION}),code('receipt_atomic_required'),'a named exception that is not approved');
 assert.throws(()=>rawDefine({...base,exception:{id:'x'}},{approved:['x']}),code('receipt_atomic_required'),'an incomplete exception record');
 assert.throws(()=>rawDefine({...base,exception:{...EXCEPTION,proof:''}},{approved:APPROVED}),code('receipt_atomic_required'),'an exception with no safety proof');
 assert.throws(()=>rawRegistry([{operation:'film_mutation',readback(){},replay(){}}]),code('receipt_atomic_required'),'the registry refuses a spec that did not come through defineOperation');
 assert.equal(rawDefine({...base,atomic:true}).exception,null);
 assert.equal(rawDefine({...base,exception:EXCEPTION},{approved:APPROVED}).exception.id,EXCEPTION.id,'only an approved, complete exception registers');
 assert.equal(exceptionOf({atomic:true}),null);
 assert.equal(rawRegistry([rawDefine({...base,atomic:true})]).size,1);
 const file=database('open'),env=envOf(file);
 const input=await request('event-atomic-required');
 const before={...env.DB.calls};
 await assert.rejects(()=>rawWrite(env,input,{run:async()=>({revision:1}),readback:readbackFilm}),code('receipt_atomic_required'));
 await assert.rejects(()=>rawWrite(env,input,{run:async()=>({revision:1}),readback:readbackFilm,exception:EXCEPTION}),code('receipt_atomic_required'),'an exception the module does not approve');
 assert.deepEqual({...env.DB.calls},before,'refused before any read or write');assert.equal(count(file),0);assert.equal(filmRow(file),null);
 // ONE batch carries the mutation and the applied transition (after the revision bump)
 const batches=[];
 const watched=envOf(file,{onBatch:async list=>{batches.push(list.map(item=>item.text));}});
 const entities=expected=>[{kind:'film',id:FILM,expected}];
 const atomicWriter=(target,{extra=[],skip=false}={})=>async ctx=>{
  const st=fenced.head(ctx.gate,entities(0));
  st.push(['INSERT INTO film (id,contract_version,original_title,updated_at) VALUES (?,?,?,?)',[FILM,1,SECRET_TITLE,T]]);
  st.push(['INSERT INTO film_alias (film_id,kind,value) VALUES (?,?,?)',[FILM,'request',JSON.stringify(await evidenceOf(ctx.requestId,FILM,1,SECRET_TITLE))]]);
  st.push([fenced.BUMP,['film',FILM,T]]);
  st.push(...extra);
  if(!skip)st.push(...ctx.appliedStatements());
  await fenced.commit(target,ctx.gate,st,entities(0));
  return {revision:1};
 };
 const done=await rawWrite(watched,input,{run:atomicWriter(watched),readback:readbackFilm,atomic:true});
 assert.equal(done.state,'applied');
 const content=batches.filter(list=>list.some(text=>text.includes('INSERT INTO film ')));
 assert.equal(content.length,1);
 const order=content[0].map(text=>text.includes('INSERT INTO film (')?'content':text.includes('INSERT INTO canonical_revision')?'bump':text.includes("SET state='applied'")?'applied':'other');
 assert.ok(order.indexOf('content')<order.indexOf('bump')&&order.indexOf('bump')<order.indexOf('applied'),'content, then the revision bump, then the applied transition: '+order);
 assert.equal(batches.filter(list=>list.some(text=>text.includes("SET state='applied'"))).length,1,'no second marking batch');
 // all-or-nothing 1: the response is LOST after the batch committed: mutation and applied receipt both exist
 const f2=database('open'),inner=envOf(f2);
 const lossy={DB:{calls:inner.DB.calls,prepare:(...a)=>inner.DB.prepare(...a),batch:async list=>{const r=await inner.DB.batch(list);if(list.some(item=>item.text.includes('INSERT INTO film (')))throw new Error('response lost');return r;}}};
 const in2=await request('event-lost-response');
 await assert.rejects(()=>rawWrite(lossy,in2,{run:atomicWriter(lossy),readback:readbackFilm,atomic:true}));
 assert.equal(filmRow(f2).original_title,SECRET_TITLE);
 assert.equal((await readReceipt(inner,in2.requestId)).state,'applied','the receipt applied with the mutation');
 // all-or-nothing 2: the request never reached the database: neither the mutation nor an applied receipt
 const f3=database('open'),e3=envOf(f3,{onBatch:async list=>{if(list.some(item=>item.text.includes('INSERT INTO film (')))throw new Error('connection reset');}});
 const in3=await request('event-lost-before');
 await assert.rejects(()=>rawWrite(e3,in3,{run:atomicWriter(e3),readback:readbackFilm,atomic:true}));
 assert.equal(filmRow(f3),null);assert.notEqual((await readReceipt(e3,in3.requestId)).state,'applied');assert.equal(Number(one(f3,"SELECT COUNT(*) FROM canonical_write_receipt WHERE state='applied'")),0);
 // all-or-nothing 3: a crash BETWEEN the statements (one after the bump fails): everything rolls back, the receipt is never applied
 const f4=database('open'),e4=envOf(f4);
 const in4=await request('event-crash-between');
 await assert.rejects(()=>rawWrite(e4,in4,{run:atomicWriter(e4,{extra:[['INSERT INTO no_such_table VALUES (1)',[]]]}),readback:readbackFilm,atomic:true}));
 assert.equal(filmRow(f4),null,'no mutation');assert.equal(revision(f4,FILM),0,'no revision');assert.notEqual((await readReceipt(e4,in4.requestId)).state,'applied');
 // every canonical change above the baseline has an applied receipt, and every applied receipt has its change (the invariant, on all four databases)
 for(const [f,e] of [[file,env],[f2,inner],[f3,e3],[f4,e4]]){
  assert.equal(Number(one(f,"SELECT COUNT(*) FROM canonical_write_receipt w WHERE w.state='applied' AND NOT EXISTS (SELECT 1 FROM canonical_revision r WHERE r.kind=w.target_kind AND r.id=w.target_id AND r.revision>=w.applied_revision)")),0,'applied without the mutation');
  assert.deepEqual((await readUnreceipted(e)).unreceipted,[],'a mutation without an applied receipt');
 }
 // two actors reach identical content: each request's own receipt settles from its OWN proof, never from content
 const fa=database('open'),ea=envOf(fa);
 const A=await request('event-actor-a'),B=await request('event-actor-b');
 const writerFor=requestId=>async ctx=>{
  const st=fenced.head(ctx.gate,[{kind:'film',id:FILM,expected:ctx.currentRevision}]);
  st.push(['INSERT INTO film (id,contract_version,original_title,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET original_title=excluded.original_title',[FILM,1,SECRET_TITLE,T]]);
  st.push(['INSERT INTO film_alias (film_id,kind,value) VALUES (?,?,?)',[FILM,'request',JSON.stringify(await evidenceOf(requestId,FILM,ctx.currentRevision+1,SECRET_TITLE))]]);
  st.push([fenced.BUMP,['film',FILM,T]]);st.push(...ctx.appliedStatements());
  await fenced.commit(ea,ctx.gate,st,[{kind:'film',id:FILM,expected:ctx.currentRevision}]);
  return {revision:ctx.currentRevision+1};
 };
 assert.equal((await rawWrite(ea,{...A,now:clockAt(0)},{run:writerFor(A.requestId),readback:readbackFilm,atomic:true})).state,'applied');
 // B planned against revision 0 and carries the SAME content: its batch loses the revision CAS, so it is failed, not applied
 await assert.rejects(()=>rawWrite(ea,{...B,now:clockAt(0)},{run:async ctx=>writerFor(B.requestId)({...ctx,currentRevision:0}),readback:readbackFilm,atomic:true}),code('film_person_revision_conflict'));
 assert.equal((await readReceipt(ea,B.requestId)).state,'failed');
 const registry=rawRegistry([rawDefine({operation:'film_mutation',atomic:true,readback:(e,t,r)=>readbackFilm(ea,t,r),replay:async()=>{throw new Error('must not replay: the content is already there');}})]);
 const pass=await reconcileReceipts(ea,{operations:registry,now:clockAt(60000)});
 assert.deepEqual(pass.needsReview,[B.requestId],'B: the same content without B\'s own proof is for review, not applied');
 assert.equal((await readReceipt(ea,A.requestId)).state,'applied');assert.equal((await readReceipt(ea,A.requestId)).appliedRevision,1);
 const rowB=await readReceipt(ea,B.requestId);
 assert.equal(rowB.state,'abandoned');assert.equal(rowB.errorClass,'content_match_unproven');assert.equal(rowB.appliedRevision,null);
}

// 17. The baseline is PROVEN when recorded and VERIFIED later; a tampered one is detected; post-boundary mutations without a receipt are flagged; history is counted apart; no receipt is fabricated.
if(on(17)){
 const file=database('open',template,false),env=envOf(file);
 await writeFilm(env,'Old film one');await writeFilm(env,'Old film two',0,'film:tmdb:2');
 await mutatePerson(env,{id:PERSON,expectedRevision:0,at:T,person:{roleId:'director/1',contractVersion:1}});
 await writeFilm(env,'Old film one again',1);
 const taken=await recordBaseline(env,{now:clockAt(7)});
 assert.equal(taken.entries,3);assert.equal(taken.film.count,2);assert.equal(taken.film.max,2);assert.equal(taken.person.count,1);assert.equal(taken.person.max,1);
 // the proof stored is the count, highest revision and digest per kind, recomputable from the rows
 const rev=rows(file,'SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id');
 const digestFor=async kind=>digestOf(rev.filter(r=>r.kind===kind).map(r=>[r.id,r.revision]));
 const mark=rows(file,'SELECT * FROM canonical_receipt_watermark')[0],seal=rows(file,'SELECT * FROM canonical_receipt_baseline_seal')[0];
 assert.equal(seal.film_digest,await digestFor('film'));assert.equal(seal.person_digest,await digestFor('person'));
 assert.equal(taken.film.digest,seal.film_digest);assert.equal(mark.marker_generation,2);assert.equal(mark.film_count,2);assert.equal(mark.person_max_revision,1);assert.equal(mark.entries,3);
 assert.deepEqual(await verifyBaseline(env),{ok:true,reasons:[]});
 assert.equal(count(file),0,'no receipt was fabricated for history');
 let found=await readUnreceipted(env);
 assert.equal(found.safe,true);assert.equal(found.baseline.ok,true);assert.equal(found.preReceiptBaselineCount,3,'history is counted apart');assert.deepEqual(found.unreceipted,[]);
 // a post-boundary mutation without a genuine receipt makes the answer non-clean; with a receipt it is covered; history stays apart
 await writeFilm(env,'After the boundary',2);
 found=await readUnreceipted(env);
 assert.equal(found.safe,false);assert.deepEqual(found.unreceipted,[{kind:'film',id:FILM,revision:3,reason:'no_receipt'}]);assert.equal(found.baseline.ok,true);
 const f2=database('open',template,false),e2=envOf(f2);
 await writeFilm(e2,'Old');await recordBaseline(e2,{now:clockAt(1)});
 const input=await request('event-post-boundary');
 await rawWrite(e2,{...input,expectedRevision:1,now:clockAt(0)},{run:async ctx=>{const st=fenced.head(ctx.gate,[{kind:'film',id:FILM,expected:1}]);st.push(['UPDATE film SET original_title=? WHERE id=?',['New',FILM]]);st.push([fenced.BUMP,['film',FILM,T]]);st.push(...ctx.appliedStatements());await fenced.commit(e2,ctx.gate,st,[{kind:'film',id:FILM,expected:1}]);return {revision:2};},readback:readbackFilm,atomic:true});
 found=await readUnreceipted(e2);
 assert.equal(found.safe,true);assert.deepEqual(found.unreceipted,[]);assert.equal(found.preReceiptBaselineCount,0,'the entity moved above its baseline and is covered by its receipt');
 // tampered baselines are detected (the insert-only triggers are dropped to simulate an edit that bypasses them)
 const tamper=async(statements,reason)=>{
  const f=database('open',template,false),e=envOf(f);
  await writeFilm(e,'A');await writeFilm(e,'B',0,'film:tmdb:2');await recordBaseline(e,{now:clockAt(1)});
  assert.deepEqual((await verifyBaseline(e)).ok,true);
  assert.equal(sqlite(f,'DROP TRIGGER canonical_receipt_baseline_no_update;DROP TRIGGER canonical_receipt_baseline_no_delete;DROP TRIGGER canonical_receipt_watermark_no_update;DROP TRIGGER canonical_receipt_baseline_seal_no_update;DROP TRIGGER canonical_receipt_baseline_seal_no_delete;'+statements).status,0);
  const verified=await verifyBaseline(e);
  assert.equal(verified.ok,false);assert.ok(verified.reasons.some(item=>item.startsWith(reason)),reason+' in '+verified.reasons);
  if(reason==='seal_missing'){await assert.rejects(()=>readUnreceipted(e),code('receipt_baseline_missing'));return;}
  const read=await readUnreceipted(e);
  assert.equal(read.safe,false);assert.equal(read.baseline.ok,false,'a tampered baseline is never clean');
 };
 await tamper("UPDATE canonical_receipt_baseline SET revision=revision+1 WHERE id='film:tmdb:1'",'digest_mismatch:film');
 await tamper("DELETE FROM canonical_receipt_baseline WHERE id='film:tmdb:2'",'count_mismatch:film');
 await tamper("DELETE FROM canonical_receipt_baseline WHERE id='film:tmdb:2'",'entries_mismatch');
 await tamper("UPDATE canonical_receipt_watermark SET film_max_revision=9",'max_mismatch:film');
 await tamper("UPDATE canonical_receipt_baseline_seal SET film_digest='"+'f'.repeat(64)+"'",'digest_mismatch:film');
 await tamper("DELETE FROM canonical_receipt_baseline_seal",'seal_missing');
 await tamper("UPDATE canonical_receipt_watermark SET marker_generation=99",'generation_ahead');
 await tamper("DELETE FROM canonical_revision WHERE id='film:tmdb:2'",'revision_regressed');
 // the boundary generation: a marker that moved between reading and recording fails the whole batch, nothing is recorded; so does a revision written in between
 const f3=database('open',template,false);
 await writeFilm(envOf(f3),'x');
 const moving=envOf(f3,{onBatch:async()=>{if(!moving.moved){moving.moved=true;assert.equal(sqlite(f3,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1").status,0);}}});
 await assert.rejects(()=>recordBaseline(moving,{now:clockAt(1)}),code('film_person_fence'));
 assert.equal(Number(one(f3,'SELECT COUNT(*) FROM canonical_receipt_watermark')),0);assert.equal(Number(one(f3,'SELECT COUNT(*) FROM canonical_receipt_baseline')),0);
 // ... and the retry records the NEW boundary generation
 assert.equal((await recordBaseline(envOf(f3),{now:clockAt(2)})).generation,4);assert.equal(Number(one(f3,'SELECT marker_generation FROM canonical_receipt_watermark')),4);

 // BLOCKER 1: an entity set with the SAME count, highest revision and revision sum but other ids, replaced between the read and the batch, is recorded coherently from the batch's own snapshot: the baseline
 // describes exactly the rows that were copied, it verifies, and nothing unrepairable is left.
 const f6=database('open',template,false),e6=envOf(f6);
 await writeFilm(e6,'a',0,'film:tmdb:1');await writeFilm(e6,'b',0,'film:tmdb:2');await writeFilm(e6,'b2',1,'film:tmdb:2');
 assert.equal(sqlite(f6,"SELECT 1").status,0);
 const swapping=envOf(f6,{onBatch:async()=>{if(!swapping.moved){swapping.moved=true;assert.equal(sqlite(f6,"DELETE FROM canonical_revision;INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:tmdb:7',1,'"+T+"'),('film','film:tmdb:8',2,'"+T+"')").status,0);}}});
 const swapped=await recordBaseline(swapping,{now:clockAt(1)});
 assert.equal(swapped.entries,2);
 assert.deepEqual(rows(f6,'SELECT id,revision FROM canonical_receipt_baseline ORDER BY id'),[{id:'film:tmdb:7',revision:1},{id:'film:tmdb:8',revision:2}],'the NEW set, from the same snapshot as the watermark');
 assert.deepEqual(await verifyBaseline(e6),{ok:true,reasons:[]});
 assert.equal(rows(f6,'SELECT film_count,film_max_revision FROM canonical_receipt_baseline_seal, canonical_receipt_watermark')[0].film_count,2);
 assert.equal((await readUnreceipted(e6)).safe,true);
 // the same race against a write that changes the COUNT beyond the cap leaves NOTHING recorded and is retryable
 const f7=database('open',template,false),e7=envOf(f7);
 await writeFilm(e7,'a',0,'film:tmdb:1');
 const growing=envOf(f7,{onBatch:async()=>{if(!growing.moved){growing.moved=true;await writeFilm(envOf(f7),'b',0,'film:tmdb:2');}}});
 await assert.rejects(()=>recordBaseline(growing,{cap:1,now:clockAt(1)}),code('receipt_state_conflict'));
 for(const table of ['canonical_receipt_baseline','canonical_receipt_watermark','canonical_receipt_baseline_seal'])assert.equal(Number(one(f7,'SELECT COUNT(*) FROM '+table)),0,'nothing left in '+table);
 assert.equal(count(f7),0);
 await assert.rejects(()=>recordBaseline(envOf(f7),{cap:1}),code('baseline_over_capacity'),'now over capacity at the read');
 assert.equal((await recordBaseline(envOf(f7),{now:clockAt(2)})).entries,2,'retried with the real cap');
 assert.deepEqual(await verifyBaseline(envOf(f7)),{ok:true,reasons:[]});
 // a failure between the copy batch and the seal is repaired by calling it again, from the same immutable rows
 const f8=database('open',template,false),e8=envOf(f8);
 await writeFilm(e8,'a',0,'film:tmdb:1');
 const failing=envOf(f8,{onBatch:async list=>{if(!failing.failed&&list.some(item=>item.text.includes('canonical_receipt_baseline_seal'))){failing.failed=true;throw new Error('connection reset');}}});
 await assert.rejects(()=>recordBaseline(failing,{now:clockAt(1)}),code('film_person_unavailable'));
 assert.equal(Number(one(f8,'SELECT COUNT(*) FROM canonical_receipt_watermark')),1);assert.equal(Number(one(f8,'SELECT COUNT(*) FROM canonical_receipt_baseline_seal')),0);
 assert.equal(await receiptsStatus(e8),'no_baseline','unsealed: no receipt can be written');
 assert.ok((await verifyBaseline(e8)).reasons.includes('seal_missing'));
 // the canonical set moves on between the failure and the retry: the seal still comes from the immutable copied rows
 await writeFilm(e8,'c',0,'film:tmdb:5');
 await assert.rejects(()=>readUnreceipted(e8),code('receipt_baseline_missing'));
 const input8=await request('event-unsealed');
 await assert.rejects(()=>receiptedWrite(e8,{...input8,now:clockAt(0)},hooksFor(e8)),code('receipt_baseline_missing'));
 const resumed=await recordBaseline(e8,{now:clockAt(2)});
 assert.equal(resumed.resumed,true);assert.equal(resumed.entries,1,'the copied rows, not the current set');assert.deepEqual(await verifyBaseline(e8),{ok:true,reasons:[]});assert.equal(await receiptsStatus(e8),'ready');
 assert.deepEqual((await readUnreceipted(e8)).unreceipted.map(item=>item.id),['film:tmdb:5'],'the later change is above the baseline');
 await assert.rejects(()=>recordBaseline(e8),code('receipt_baseline_exists'),'once sealed it is final');
 // the sealed baseline carries exactly the rows that were copied
 assert.equal(count(f8),0);
 // the shape of the seal: both digests are hex
 const f5=database('open',template,false);
 assert.equal(sqlite(f5,WM(2)).status,0);
 assert.notEqual(sqlite(f5,SEAL.replace(EMPTY,'zz'.repeat(32))).status,0,'a film seal digest that is not hex');
 assert.notEqual(sqlite(f5,SEAL.replace("'"+EMPTY+"','"+EMPTY+"'","'"+EMPTY+"','"+'zz'.repeat(32)+"'")).status,0,'a person seal digest that is not hex');
 assert.equal(sqlite(f5,SEAL).status,0);
 // no code path fabricates receipts: the baseline functions never write the receipt table
 assert.equal(count(file),0);assert.equal(count(f2),1,'only the genuine receipt');
}

// 18. Append-only: nothing deletes or prunes, terminal rows survive, and abandoned/unknown/needs-review receipts stay visible.
if(on(18)){
 const code_=fs.readFileSync('src/canonical-receipts.js','utf8').split('\n').filter(line=>!/^\s*\/\//.test(line)).join('\n');
 assert.ok(!/DELETE\s+FROM|\bprun|\bTTL\b|\barchiv|\bpurge|\bvacuum|\bretention\b/i.test(code_),'no deletion, pruning, TTL, archival or purge code');
 const file=database('open'),env=envOf(file);
 const registry=operationRegistry([FILM_OPERATION(env)]);
 // an applied one, an unknown one (lost, nothing landed), a needs-review one (identical content, no proof)
 const applied=await request('event-keep-applied');
 await receiptedWrite(env,{...applied,now:clockAt(0)},hooksFor(env));
 const unknown=await request('event-keep-unknown',SECRET_TITLE,{target:{kind:'film',id:'film:tmdb:20'}});
 await assert.rejects(()=>receiptedWrite(env,{...unknown,now:clockAt(0)},{run:async()=>{throw new Error('timeout');},readback:readbackFilm}));
 const twin=await request('event-keep-twin',SECRET_TITLE,{target:{kind:'film',id:'film:tmdb:21'}});
 await assert.rejects(()=>receiptedWrite(env,{...twin,now:clockAt(0)},{run:async()=>{await writeFilm(env,SECRET_TITLE,0,'film:tmdb:21');throw new Error('lost');},readback:readbackFilm}));
 await receiptedWrite(env,{...twin,now:clockAt(60000)},{run:async()=>{throw new Error('must not run');},readback:readbackFilm});
 const list=await listAttention(env);
 assert.deepEqual(list.map(item=>[item.requestId===unknown.requestId?'unknown':item.requestId===twin.requestId?'twin':'other',item.state,item.needsReview]).sort(),[['twin','abandoned',true],['unknown','unknown',false]].sort());
 assert.ok(!list.some(item=>item.requestId===applied.requestId),'an applied receipt needs no attention');
 assert.equal((await listAttention(env,{limit:1})).length,1);
 await assert.rejects(()=>listAttention(envOf(database('open',template18))),code('receipt_schema_missing'));
 // the 7-day rule is about operation state: the row stays, abandoned and visible
 const aged=await request('event-keep-aged',SECRET_TITLE,{target:{kind:'film',id:'film:tmdb:22'}});
 await assert.rejects(()=>receiptedWrite(env,{...aged,now:clockAt(0)},{run:async()=>{throw new Error('timeout');},readback:readbackFilm}));
 const total=count(file);
 const result=await receiptedWrite(env,{...aged,now:clockAt(RETRY_POLICY.abandonAfterMs+1)},{run:async()=>{throw new Error('timeout');},readback:readbackFilm});
 assert.equal(result.state,'abandoned');assert.equal(count(file),total,'abandonment keeps the row');
 assert.ok((await listAttention(env)).some(item=>item.requestId===aged.requestId&&item.state==='abandoned'));
 // the database refuses to delete or rewrite terminal rows
 const before=JSON.stringify(receiptRows(file));
 assert.match(message(sqlite(file,'DELETE FROM canonical_write_receipt')),/canonical_receipt_delete/);
 assert.match(message(sqlite(file,"UPDATE canonical_write_receipt SET state='pending',attempts=attempts+1 WHERE state IN ('applied','abandoned')")),/canonical_receipt_transition/);
 assert.match(message(sqlite(file,"UPDATE canonical_write_receipt SET updated_at='"+iso(9)+"' WHERE state='applied'")),/canonical_receipt_transition/);
 assert.equal(JSON.stringify(receiptRows(file)),before,'every terminal row is untouched');
}

// 19. Adversarial evidence: a proof for another request, target, revision or digest, or a forged shape, never settles a receipt as applied; matching content never does either.
if(on(19)){
 const forge=async over=>{
  const file=database('open'),env=envOf(file);
  const input=await request('event-forged');
  // the request's writer really landed the planned content (so the digest matches), but the evidence row says something else
  const base=await evidenceOf(input.requestId,FILM,1,SECRET_TITLE);
  const evidence=typeof over==='function'?over(base):over;
  await assert.rejects(()=>receiptedWrite(env,{...input,now:clockAt(0)},{run:async()=>{await mutateFilm(env,{id:FILM,expectedRevision:0,at:T,film:{contractVersion:1,originalTitle:SECRET_TITLE,aliases:[{kind:'request',value:JSON.stringify({...evidence,requestId:evidence.requestId??'x'})}]}});throw new Error('lost');},readback:async(e,t,r)=>{const out=await readbackFilm(env,t,r);if(out&&evidence!==undefined&&!out.evidence){out.evidence=evidence;}return out;}}));
  const registry=operationRegistry([FILM_OPERATION(env)]);
  const op=defineOperation({operation:'film_mutation',readback:async(e,t,r)=>{const out=await readbackFilm(env,t,r);out.evidence=evidence;return out;},replay:async()=>{throw new Error('must not replay');}});
  const pass=await reconcileReceipts(env,{operations:operationRegistry([op]),now:clockAt(60000)});
  void registry;
  const row=await readReceipt(env,input.requestId);
  assert.deepEqual(pass.applied,[],'never applied');assert.notEqual(row.state,'applied');assert.equal(row.appliedRevision,null);
  assert.deepEqual(pass.needsReview,[input.requestId]);assert.equal(row.errorClass,'evidence_invalid');
 };
 await forge(base=>({...base,requestId:'epg:film_mutation:'+'0'.repeat(64)}));
 await forge(base=>({...base,target:{kind:'film',id:'film:tmdb:999'}}));
 await forge(base=>({...base,target:{kind:'person',id:FILM}}));
 await forge(base=>({...base,appliedRevision:2}));
 await forge(base=>({...base,appliedRevision:'1'}));
 await forge(base=>({...base,contentDigest:'b'.repeat(64)}));
 await forge(base=>({...base,extra:true}));
 await forge(base=>({requestId:base.requestId,target:base.target,appliedRevision:base.appliedRevision}));
 await forge(()=>({proof:'request',requestId:'x'}));
 // the genuine evidence applies; another actor's identical content with a DIFFERENT request's evidence does not
 const file=database('open'),env=envOf(file);
 const A=await request('event-real-a'),B=await request('event-real-b');
 await assert.rejects(()=>receiptedWrite(env,{...A,now:clockAt(0)},{run:async()=>{await writeFilm(env,SECRET_TITLE,0,FILM,A.requestId);throw new Error('lost');},readback:readbackFilm}));
 await assert.rejects(()=>receiptedWrite(env,{...B,now:clockAt(0)},{run:async()=>{throw new Error('timeout');},readback:readbackFilm}));
 const pass=await reconcileReceipts(env,{operations:operationRegistry([FILM_OPERATION(env)]),now:clockAt(60000)});
 assert.deepEqual(pass.applied,[A.requestId],'A: its own evidence');
 assert.deepEqual(pass.needsReview,[B.requestId],'B: the same final content carries A\'s evidence, not B\'s');
 assert.equal((await readReceipt(env,B.requestId)).state,'abandoned');
}

console.log('canonical-receipts: the durable canonical write receipt (schema 19) is writable only at open, records pending before the commit, settles unknown outcomes by readback both ways, bounds its retries, reports unreceipted changes, stores no payload, and stays dormant');
