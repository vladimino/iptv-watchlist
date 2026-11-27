// AIR-675 / ADR 0217 (Accepted) decision 7, the helper changes of the attach card, on the real migrations (a sqlite D1 stand-in): (1) the writer control allowlist admits `lid_tmdb_attach` only from schema 50, with the
// same compare-and-swap, drain evidence and append-only history as the other writers; (2) the live shape of the evidence helper accepts the ONE Film-bound `film_has_id(film, tmdb_movie)` page-check row of the attach
// (owner_action, rooted in the attach root) and nothing wider, and refuses a row whose subject is not the batch's Film; (3) the keyed receipt reservation accepts the intent compare-and-swap in exactly one shape.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {ATTACH_WRITER,ATTACH_WRITER_SCHEMA,WRITERS,attachWriterSchemaReady,changeWriter,readWriter,readWriterChanges} from '../src/identity-evidence-writer.js';
import {evidenceInsertStatement,evidenceKeyOf,initialSliceShape,normalizeEvidence,planIdentityEvidence} from '../src/identity-evidence.js';
import {receiptedWrite} from '../src/canonical-receipts.js';

const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-attach-helpers-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const build=upTo=>{const file=path.join(root,'t'+upTo+'.sqlite');sqlite(file,files.filter(name=>Number(name.slice(0,4))<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));return file;};
const t49=build(49),t50=build(50);
let n=0;
const copy=source=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(source,file);return file;};
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const OPERATION={reason:'AIR-675 test',deployedVersion:'v1',evidenceLink:'https://trello.com/c/8k4DjDpv'};
const T0=Date.parse('2026-11-27T10:00:00.000Z'),iso=ms=>new Date(T0+ms).toISOString();

// ===== 1. the writer control =====
assert.equal(ATTACH_WRITER,'lid_tmdb_attach');assert.equal(ATTACH_WRITER_SCHEMA,50);
assert.ok(WRITERS.includes('lid_tmdb_attach')&&WRITERS.length===6,'the allowlist is the five delivered writers and the attach');
{
 // schema 49: the sixth writer is not ready, reads `off`, and cannot be changed (its CHECK does not exist yet): nothing is written
 const file=copy(t49),env={DB:d1Standin(file)};
 assert.equal(await attachWriterSchemaReady(env),false);
 assert.deepEqual(await readWriter(env,ATTACH_WRITER),{writer:ATTACH_WRITER,state:'off',generation:0,coverageFrom:null,updatedAt:null,present:false});
 await assert.rejects(()=>changeWriter(env,{writer:ATTACH_WRITER,kind:'activate',expectedGeneration:0,...OPERATION,now:iso(0)}),code('identity_evidence_writer_unavailable'));
 assert.deepEqual(await readWriterChanges(env,ATTACH_WRITER),[]);
 // the delivered writers still work at 49
 assert.equal((await changeWriter(env,{writer:'discovery_decision',kind:'activate',expectedGeneration:0,...OPERATION,now:iso(0)})).state,'pending');
}
{
 // an unreadable or damaged schema is never ready
 const file=copy(t50);sqlite(file,'DROP TRIGGER identity_evidence_writer_no_delete;DROP TABLE identity_evidence_writer_change');
 assert.equal(await attachWriterSchemaReady({DB:d1Standin(file)}),false);
 assert.equal(await attachWriterSchemaReady({}),false);
}
{
 // schema 50: the full life of the writer through the operator (compare-and-swap, drain evidence, coverage start, deactivation, break), atomic history
 const file=copy(t50),env={DB:d1Standin(file)};
 assert.equal(await attachWriterSchemaReady(env),true);
 assert.equal((await readWriter(env,ATTACH_WRITER)).state,'off');
 const step=(over={})=>changeWriter(env,{writer:ATTACH_WRITER,...OPERATION,now:iso(0),...over});
 const a=await step({kind:'activate',expectedGeneration:0});
 assert.deepEqual([a.noop,a.state,a.generation],[false,'pending',1]);
 assert.deepEqual(await step({kind:'activate',expectedGeneration:1}),{noop:true,writer:ATTACH_WRITER,state:'pending',generation:1},'an interrupted activation re-runs safely');
 await assert.rejects(()=>step({kind:'drain_complete',expectedGeneration:0,drainEvidence:'x'}),code('identity_evidence_writer_stale'));
 await assert.rejects(()=>step({kind:'drain_complete',expectedGeneration:1}),code('identity_evidence_writer_invalid'),'a drain without evidence is refused before a statement');
 await assert.rejects(()=>step({kind:'activate',expectedGeneration:1,writer:'lid_only_attach'}),code('identity_evidence_writer_invalid'));
 const on=await step({kind:'drain_complete',expectedGeneration:1,drainEvidence:'no Worker without the attach serves traffic',now:iso(60000)});
 assert.deepEqual([on.state,on.generation,on.coverageFrom],['on',2,iso(60000)]);
 assert.equal((await readWriter(env,ATTACH_WRITER)).state,'on');
 await assert.rejects(()=>step({kind:'activate',expectedGeneration:2}),code('identity_evidence_writer_transition'));
 const brk=await step({kind:'break',expectedGeneration:2,breakFrom:iso(90000),now:iso(120000)});
 assert.deepEqual([brk.state,brk.generation,brk.coverageFrom],['off',3,null]);
 assert.deepEqual((await readWriterChanges(env,ATTACH_WRITER)).map(r=>[r.kind,r.from_state,r.to_state,r.generation]),[['activate','off','pending',1],['drain_complete','pending','on',2],['break','on','off',3]]);
 // the other writers' control rows are independent
 assert.equal((await readWriter(env,'discovery_decision')).state,'off');
}

// ===== 2. the live shape of the attach evidence row =====
const ROOT='a'.repeat(64);
const attachRow=over=>({subject:{kind:'film',value:'film:lb:Ab1'},relation:'film_has_id',object:{kind:'tmdb_movie',value:'603'},polarity:'asserts',route:'owner_action',method:'page_check',sourceRoot:ROOT,observedAt:iso(0),...over});
{
 const plan=await planIdentityEvidence(attachRow());
 assert.deepEqual([plan.row.relation,plan.row.subjectKind,plan.row.objectKind,plan.row.route,plan.row.method,plan.row.sourceRoot],['film_has_id','film','tmdb_movie','owner_action','page_check',ROOT]);
 assert.match(plan.evidenceKey,/^[0-9a-f]{64}$/);
 assert.equal(plan.evidenceKey,await evidenceKeyOf(normalizeEvidence(attachRow({observedAt:iso(999)}))),'the key does not depend on the observation time');
 assert.notEqual(plan.evidenceKey,(await planIdentityEvidence(attachRow({sourceRoot:'b'.repeat(64)}))).evidenceKey,'another root is another row');
 // nothing wider is a live row of the slice
 for(const [name,over] of [['another object kind',{object:{kind:'tmdb_tv',value:'603'}}],['a letterboxd object (the bridge row is another writer)',{object:{kind:'letterboxd_lid',value:'Ab1'}}],['restricts',{polarity:'restricts'}],
  ['refutes by page check',{polarity:'refutes'}],['another route',{route:'ratings_diary'}],['another method',{method:'owner_statement'}],['alias_bridge',{method:'alias_bridge',route:'ratings_alias_bridge'}],['a source scope',{sourceScope:'archive-1'}],
  ['a scoped refutation key',{scopeEvidenceKey:'c'.repeat(64),polarity:'refutes',method:'owner_statement'}],['a non-hex root',{sourceRoot:'not-a-digest'}],['a source order',{sourceOrder:3}]])
  await assert.rejects(()=>planIdentityEvidence(attachRow(over)),error=>['identity_evidence_out_of_slice','identity_evidence_invalid'].includes(error.code),name);
 assert.equal(initialSliceShape(normalizeEvidence(attachRow())),true);
 assert.equal(initialSliceShape(normalizeEvidence({...attachRow(),origin:'reconstruction',reconstructionRun:'run-1',reconstructedFrom:'rec-1',sourceRoot:null,observedAt:null})),false,'a reconstructed row is never a live attach row');
 // the insert statement binds the row to the batch's own Film: a subject that is not the target Film is refused
 const [sql,params]=evidenceInsertStatement(plan,{filmId:'film:lb:Ab1',requestId:'req-1',at:iso(0)});
 assert.match(sql,/INSERT INTO film_identity_evidence/);assert.equal(params[1],'film:lb:Ab1');assert.equal(params[2],'film');assert.equal(params[3],'film:lb:Ab1');
 assert.throws(()=>evidenceInsertStatement(plan,{filmId:'film:tmdb:603',requestId:'req-1',at:iso(0)}),code('identity_evidence_out_of_slice'));
 // the existing same_work slice is unchanged
 const sameWork=await planIdentityEvidence({subject:{kind:'letterboxd_lid',value:'Ab1'},relation:'same_work',object:{kind:'tmdb_movie',value:'603'},polarity:'asserts',route:'ratings_diary',method:'page_check',sourceRoot:ROOT,observedAt:iso(0)});
 assert.equal(sameWork.row.relation,'same_work');
}

// ===== 3. the keyed receipt reservation: the intent compare-and-swap in exactly one shape, validated before anything is read =====
{
 const GOOD="UPDATE lid_recheck_intent SET attempt_request_id=?,revision=revision+1,updated_at=? WHERE request_id=? AND state='open' AND revision=?";
 const request={requestId:'r1',operation:'film_admission',origin:'rated_admission_retention',target:{kind:'film',id:'film:lb:Ab1'},expectedRevision:1,digest:'d'.repeat(64),operationKey:'admission:lid:Ab1',history:{count:1,applied:1}};
 const hooks={atomic:true,run:async()=>{throw new Error('must not run');},readback:async()=>null};
 const bad=[
  [[[GOOD.replace('revision=revision+1','revision=revision+2'),['a','b','c',1]]],'another statement'],
  [[[GOOD,['a','b','c']]],'too few params'],
  [[[GOOD,['a','b','c',1]],[GOOD,['a','b','c',1]]],'two statements'],
  [[["DELETE FROM lid_recheck_intent",['a','b','c',1]]],'a delete'],
  ['UPDATE lid_recheck_intent','not an array'],
  [[GOOD],'not a pair'],
  [[],'empty'],
 ];
 for(const [extra,name] of bad)await assert.rejects(()=>receiptedWrite({},{...request,reserveExtra:extra},hooks),code('film_person_invalid'),name);
 // an un-keyed write may not carry it
 const {operationKey,history,...unkeyed}=request;
 await assert.rejects(()=>receiptedWrite({},{...unkeyed,reserveExtra:[[GOOD,['a','b','c',1]]]},hooks),code('film_person_invalid'),'only a keyed reservation carries the intent');
}
console.log('Lid attach helpers (AIR-675: writer control, evidence shape, receipt reservation) passed.');
