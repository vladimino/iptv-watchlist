// AIR-374 P2c: mutation check of the safety-critical rules of migrations/0019_canonical_write_receipt.sql and src/canonical-receipts.js, in the pattern of tests/canonical-person-state-mutation.mjs.
// Each mutant is a copy of ONE of the two files with ONE rule removed or inverted; tests/canonical-receipts.mjs, pointed at the mutant (CANON_RECEIPTS_SOURCE or CANON_RECEIPTS_MIGRATION), must FAIL on it.
// A surviving mutant is a rule no test depends on; a mutant that does not parse or load is BROKEN and fails this check. Mutants are written OUTSIDE the repository tree (a temporary directory, removed
// afterwards), their relative imports rewritten to the repository sources, so a copy can never be committed. Each mutant runs only the numbered sections that must kill it, at most four at a time.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sqliteSync} from './sqlite-session.mjs';

const JS='src/canonical-receipts.js',SQL='migrations/0019_canonical_write_receipt.sql';
const sources={js:fs.readFileSync(JS,'utf8'),sql:fs.readFileSync(SQL,'utf8')};
const TRIGGER_OPEN="WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')";
// [name, file, text, replacement, sections that must kill it]
const MUTANTS=[
 // the marker fence in SQL
 ['an insert is accepted at any marker','sql','BEFORE INSERT ON canonical_write_receipt\nFOR EACH ROW\n'+TRIGGER_OPEN,'BEFORE INSERT ON canonical_write_receipt\nFOR EACH ROW\nWHEN 0','2'],
 ['an insert is accepted while held','sql','BEFORE INSERT ON canonical_write_receipt\nFOR EACH ROW\nWHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = \'d1\' AND cutover = \'open\')',"BEFORE INSERT ON canonical_write_receipt\nFOR EACH ROW\nWHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1')",'2'],
 ['an insert is accepted at prepared','sql','BEFORE INSERT ON canonical_write_receipt\nFOR EACH ROW\nWHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = \'d1\' AND cutover = \'open\')',"BEFORE INSERT ON canonical_write_receipt\nFOR EACH ROW\nWHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode IN ('d1','prepared') AND cutover = 'open')",'2'],
 ['an update is accepted at any marker','sql','BEFORE UPDATE ON canonical_write_receipt\nFOR EACH ROW\n'+TRIGGER_OPEN,'BEFORE UPDATE ON canonical_write_receipt\nFOR EACH ROW\nWHEN 0','2'],
 ['an insert under a stale generation is accepted','sql',"WHEN NEW.marker_generation <> COALESCE((SELECT generation FROM film_person_authority WHERE id = 1), -1)\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_stale_generation');\nEND;\n\n-- What the receipt identifies","WHEN 0\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_stale_generation');\nEND;\n\n-- What the receipt identifies",'2'],
 ['a new receipt may start settled or at attempt 2','sql',"WHEN NEW.state <> 'pending' OR NEW.attempts <> 1 OR NEW.applied_revision IS NOT NULL OR NEW.settled_at IS NOT NULL","WHEN 0",'2'],
 ['a new receipt may start at attempt 2','sql',"WHEN NEW.state <> 'pending' OR NEW.attempts <> 1 OR","WHEN NEW.state <> 'pending' OR",'2'],
 ['a row can be deleted','sql',"CREATE TRIGGER canonical_write_receipt_no_delete\nBEFORE DELETE ON canonical_write_receipt\nFOR EACH ROW\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_delete');\nEND;\n",'','2'],
 // the shape: no payload
 ['a request id may hold free text','sql',"request_id NOT GLOB '*[^A-Za-z0-9:._/=+@-]*'","1",'2'],
 ['an error class may hold free text','sql',"AND error_class NOT GLOB '*[^a-z0-9_]*'","",'2'],
 ['a digest may be any hex-like text','sql',"AND content_digest NOT GLOB '*[^0-9a-f]*'","",'2'],
 ['a target may be any text','sql',"((target_kind = 'film' AND target_id GLOB 'film:?*') OR (target_kind = 'person' AND target_id GLOB 'person:?*'))","1",'2'],
 // the state machine
 ['failed may move to unknown','sql',"OR (OLD.state = 'failed' AND NEW.state IN ('pending', 'applied', 'abandoned'))","OR (OLD.state = 'failed' AND NEW.state IN ('pending', 'applied', 'abandoned', 'unknown'))",'3'],
 ['an applied receipt may move again','sql',"(OLD.state = 'pending' AND NEW.state IN ('pending', 'applied', 'failed', 'unknown', 'abandoned'))","(OLD.state IN ('pending','applied') AND NEW.state IN ('pending', 'applied', 'failed', 'unknown', 'abandoned'))",'3'],
 ['the attempt counter may move freely','sql',"WHEN NEW.attempts <> OLD.attempts + (NEW.state = 'pending')","WHEN NEW.attempts < OLD.attempts",'3'],
 ['a new attempt may carry an old generation','sql',"WHEN (NEW.state = 'pending' AND NEW.marker_generation <> COALESCE((SELECT generation FROM film_person_authority WHERE id = 1), -1))\n OR (NEW.state <> 'pending' AND NEW.marker_generation <> OLD.marker_generation)","WHEN (NEW.state <> 'pending' AND NEW.marker_generation <> OLD.marker_generation)",'3'],
 ['a settled move may rewrite the planned generation','sql',"\n OR (NEW.state <> 'pending' AND NEW.marker_generation <> OLD.marker_generation)\nBEGIN","\nBEGIN",'3'],
 ['the identity of a receipt can change (digest)','sql',"OR NEW.target_kind <> OLD.target_kind OR NEW.target_id <> OLD.target_id OR NEW.content_digest <> OLD.content_digest\n OR NEW.created_at <> OLD.created_at","OR NEW.target_kind <> OLD.target_kind OR NEW.target_id <> OLD.target_id\n OR NEW.created_at <> OLD.created_at",'3'],
 ['the identity of a receipt can change (operation)','sql',"WHEN NEW.request_id <> OLD.request_id OR NEW.operation <> OLD.operation OR NEW.origin <> OLD.origin","WHEN NEW.request_id <> OLD.request_id OR NEW.origin <> OLD.origin",'3'],
 ['applied needs no applied revision','sql',"CHECK (state <> 'applied' OR (applied_revision IS NOT NULL AND error_class IS NULL)),","",'3'],
 ['a pending receipt may carry an applied revision','sql',"CHECK (state = 'applied' OR applied_revision IS NULL),","",'3'],
 ['applied needs no settled time','sql',"CHECK ((state IN ('applied', 'abandoned')) = (settled_at IS NOT NULL)),","",'3'],
 ['failed needs no error class','sql',"CHECK (state NOT IN ('failed', 'unknown', 'abandoned') OR error_class IS NOT NULL)","CHECK (1)",'3'],
 ['applied keeps a due time','sql',"CHECK ((state IN ('pending', 'failed', 'unknown') AND next_attempt_at IS NOT NULL) OR (state IN ('applied', 'abandoned') AND next_attempt_at IS NULL)),","",'3'],
 // the migration guard
 ['the guard accepts version 17','sql',"WHERE id = 1 AND version = 18\n AND (","WHERE id = 1 AND version >= 17\n AND (",'1'],
 ['the guard does not check the tables','sql',") = 8\n);",") >= 0\n);",'1'],
 // the protocol
 ['a write is made without the marker gate','js',"const gate=assertWritable(await readAuthority(env));\n if(status==='no_baseline')","const gate=await readAuthority(env);\n if(status==='no_baseline')",'4.2'],
 ['a write is made without the receipt table','js',"if(status==='no_schema')throw failed('receipt_schema_missing');\n const gate","const gate",'4.2'],
 ['the receipt batch carries no fence head','js',"const all=[...fenced.head(gate,[]),...statements];","const all=[...statements];",'7.5'],
 ['a different request under one id is a replay','js',"if(!sameRequest(row,request))throw failed('receipt_conflict');","",'4.1'],
 ['content is ignored in the identity of a request','js',"row.target.id===request.target.id&&row.contentDigest===request.digest","row.target.id===request.target.id",'4.1'],
 ['an applied receipt runs again','js',"if(row.state==='applied')return {ran:false,state:'applied',already:true,receipt:row};","",'4.1'],
 ['an abandoned receipt runs again','js',"if(row.state==='abandoned')return {ran:false,state:'abandoned',receipt:row};","",'6.2'],
 ['an attempt in flight or backing off runs again','js',"if(due.waiting.length)return {ran:false,state:row.state,","if(false)return {ran:false,state:row.state,",'6.2'],
 ['a retry is made without a readback','js',"if(typeof hooks?.readback!=='function')throw failed('receipt_readback_required');","",'6.3'],
 ['any readback counts as applied','js',"if(observed&&observed.digest===receipt.contentDigest)return 'content_unproven';","if(observed&&observed.digest===receipt.contentDigest)return 'applied';",'13'],
 ['the backoff never grows','js',"return policy.backoffMs[Math.min(attempts-1,policy.backoffMs.length-1)];","return policy.backoffMs[0];",'6.1'],
 ['a permanent refusal is retried','js',"outcome:PERMANENT.has(errorClass)?'abandoned':RETRYABLE.has(errorClass)?'failed':'unknown'","outcome:RETRYABLE.has(errorClass)?'failed':'unknown'",'6.1'],
 ['an unknown outcome is read as a definite failure','js',"outcome:PERMANENT.has(errorClass)?'abandoned':RETRYABLE.has(errorClass)?'failed':'unknown'","outcome:PERMANENT.has(errorClass)?'abandoned':'failed'",'6.1'],
 ['an error message is stored as the class','js',"return IDENT.test(code)?code:'unclassified';","return IDENT.test(code)?code:String(error?.message||'unclassified');",'7.1'],
 ['a failed attempt is not marked','js',"   if(outcome==='abandoned')await transition(env,gate,current,{kind:'abandoned',errorClass},now);\n   else await transition(env,gate,current,{kind:'failed',state:outcome,errorClass,nextAttemptAt:plus(now,backoffMs(attempt,policy))},now);","   void now;",'7.1'],
 ['a successful attempt is not marked applied','js',"  await transition(env,gate,{...row,state:'pending',attempts:attempt},{kind:'applied',revision},clock());\n ","  void revision;\n ",'4.1'],
 ['a retry keeps the old marker generation','js',"[change.plannedRevision,gate.generation,change.nextAttemptAt,now,...where]","[change.plannedRevision,row.markerGeneration,change.nextAttemptAt,now,...where]",'7.6'],
 ['the stable request id carries its source text','js',"return origin+':'+operation+':'+(await digestOf(source));","return origin+':'+operation+':'+String(source);",'4.1'],
 ['a request digest is not validated','js',"||!DIGEST.test(request.digest||'')","",'4.1'],
 // the reconcile plan and the pass
 ['the plan acts while the marker is not open','js',"if(marker?.state!=='open'){plan.waiting.push({requestId:receipt.requestId,reason:'marker_not_open'","if(false){plan.waiting.push({requestId:receipt.requestId,reason:'marker_not_open'",'8'],
 ['the plan acts before a receipt is due','js',"if(at<timeOf(receipt.nextAttemptAt)){plan.waiting.push","if(false){plan.waiting.push",'8'],
 ['the plan acts without a readback','js',"if(seen===undefined){plan.actions.push({requestId:receipt.requestId,action:'readback'});continue;}","",'8'],
 ['the plan never recognises a landed write','js',"if(verdict==='applied'){plan.actions.push","if(false){plan.actions.push",'8'],
 ['the plan recognises any content as landed','js',"action:'needs_review',reason:'content_match_unproven'});continue;}","action:'mark_applied',revision:Number(seen.revision)||0});continue;}",'8'],
 ['the plan never abandons an exhausted receipt','js',"if(receipt.attempts>=policy.maxAttempts){plan.actions.push","if(false){plan.actions.push",'8'],
 ['the plan never abandons an expired receipt','js',"if(at-timeOf(receipt.createdAt)>policy.abandonAfterMs){plan.actions.push","if(false){plan.actions.push",'8'],
 ['the plan hides an abandoned receipt','js',"plan.attention.push({requestId:receipt.requestId,reason:receipt.errorClass||'abandoned'});continue;","continue;",'8'],
 ['the plan never asks for a re-plan','js',"replan:receipt.markerGeneration!==marker.generation","replan:false",'8'],
 ['the pass acts while the marker is not open','js',"if(gate.state!=='open'){result.waiting=","if(false){result.waiting=",'7.7'],
 ['the pass reads receipts that are not due','js',"await listReceipts(env,{dueBefore:at,limit,origin})","await listReceipts(env,{limit,origin})",'10.1'],
 ['the receipt read is not capped','js',"const cap=Math.min(Math.max(Number(limit)||1,1),RECONCILE_LIMIT_MAX);","const cap=Number(limit)||1;",'10.2'],
 ['an unregistered operation is guessed','js',"if(!operation){missing.add(row.requestId);result.waiting.push({requestId:row.requestId,reason:'operation_unregistered'});continue;}","",'10.1'],
 ["an unproven content match is marked applied",'js',"if(action.action==='needs_review'){await transition(env,gate,row,{kind:'abandoned',errorClass:action.reason},now);","if(action.action==='needs_review'){await transition(env,gate,row,{kind:'applied',revision:0},now);",'13'],
 ["an atomic writer is marked applied by a second batch",'js',"if(atomic){\n  try{","if(false){\n  try{",'13'],
 ["a stale revision is retried without revalidation",'js',"if(currentRevision!==row.plannedRevision){\n  const verdict","if(false){\n  const verdict",'14'],
 ["a revalidation answer other than proceed is ignored",'js',"if(verdict!=='proceed'){\n   const reason","if(false){\n   const reason",'14'],
 ["a superseded receipt is reported as needing repair",'js',"const reason=verdict==='superseded'?'superseded_by_newer_revision':'stale_revision_needs_repair';","const reason='stale_revision_needs_repair';",'14'],
 ["a retry keeps the original planned revision",'js',"{kind:'retry',plannedRevision:currentRevision,","{kind:'retry',plannedRevision:row.plannedRevision,",'14'],
 ["a direct retry runs against the original expectation",'js',"attempt=row.attempts+1;currentRevision=outcome.retry.currentRevision;","attempt=row.attempts+1;",'14'],
 ["the pass ignores the revalidation of its operation",'js',"revalidate:operation.revalidate,","revalidate:undefined,",'14'],
 ["unreceipted ignores the baseline (pure)",'js',"if(Number(change.revision)<=Number(baseline[key]||0)){","if(false){",'15,9'],
 ["unreceipted ignores the baseline (database)",'js',"WHERE r.revision>COALESCE(b.revision,0) AND NOT EXISTS","WHERE r.revision>0 AND NOT EXISTS",'15'],
 ["the baseline count counts every revision",'js',"WHERE r.revision<=b.revision'","WHERE 1'",'15'],
 ["a receipt is written without the baseline check",'js',"readAuthority(env));\n if(status==='no_baseline')throw failed('receipt_baseline_missing');","readAuthority(env));",'15'],
 ["a missing baseline reads as ready",'js',"return Number(row?.baseline)===1?'ready':'no_baseline';","return 'ready';",'15'],
 ["a baseline row is accepted while held",'sql',"BEFORE INSERT ON canonical_receipt_baseline\nFOR EACH ROW\nWHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')\n OR","BEFORE INSERT ON canonical_receipt_baseline\nFOR EACH ROW\nWHEN 0\n OR",'15'],
 ["the watermark can be updated",'sql',"CREATE TRIGGER canonical_receipt_watermark_no_update\nBEFORE UPDATE ON canonical_receipt_watermark\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_baseline_immutable');\nEND;\n","",'15'],
 ["the watermark can be deleted",'sql',"CREATE TRIGGER canonical_receipt_watermark_no_delete\nBEFORE DELETE ON canonical_receipt_watermark\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_baseline_immutable');\nEND;\n","",'15'],
 ["a baseline row can be updated",'sql',"CREATE TRIGGER canonical_receipt_baseline_no_update\nBEFORE UPDATE ON canonical_receipt_baseline\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_baseline_immutable');\nEND;\n","",'15'],
 ["a baseline row can be deleted",'sql',"CREATE TRIGGER canonical_receipt_baseline_no_delete\nBEFORE DELETE ON canonical_receipt_baseline\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_baseline_immutable');\nEND;\n","",'15'],
 ["an unapproved exception is accepted",'js',"||!approved.includes(exception.id)","",'16'],
 ["an incomplete exception is accepted",'js',".every(value=>typeof value==='string'&&value.length>=3)",".every(()=>true)",'16'],
 ["a non-atomic operation registers without an exception",'js',"if(!named||!approved.includes(exception.id))throw failed('receipt_atomic_required');","",'16'],
 ["a write is made without the atomic requirement",'js',"if(!atomic)exceptionOf({exception:hooks?.exception},hooks?.approvedExceptions||APPROVED_EXCEPTIONS);","",'16'],
 ["the registry accepts a spec that skipped defineOperation",'js',"if(spec.atomic!==true&&!spec.exception)throw failed('receipt_atomic_required');\n  if(spec.atomic!==true)exceptionOf(spec,approved);","",'16'],
 ["an exception is approved today",'js',"export const APPROVED_EXCEPTIONS=Object.freeze([]);","export const APPROVED_EXCEPTIONS=Object.freeze(['legacy']);",'16'],
 ["the baseline verifier ignores the count",'js',"if(Number(mark[kind+'_count'])!==proof[kind].count)reasons.push('count_mismatch:'+kind);","",'17'],
 ["the baseline verifier ignores the highest revision",'js',"if(Number(mark[kind+'_max_revision'])!==proof[kind].max)reasons.push('max_mismatch:'+kind);","",'17'],
 ["the baseline verifier ignores the entries total",'js',"if(Number(mark.entries)!==rows.length)reasons.push('entries_mismatch');","",'17'],
 ["the baseline verifier ignores the boundary generation",'js',"if(live&&Number(mark.marker_generation)>live.generation)reasons.push('generation_ahead');","",'17'],
 ["the baseline verifier ignores a regressed revision",'js',"if(Number(regressed?.n??0)>0)reasons.push('revision_regressed');","",'17'],
 ["a tampered baseline reads clean",'js',"safe:changes.safe&&baseline.ok}","safe:changes.safe}",'17'],
 ["abandoned receipts are not listed",'js',"WHERE state IN ('abandoned','unknown') ORDER BY updated_at","WHERE state IN ('unknown') ORDER BY updated_at",'18'],
 ["a content match without proof is not marked for review",'js',"const REVIEW_CLASSES=new Set(['content_match_unproven',","const REVIEW_CLASSES=new Set([",'18'],
 ["a readback with evidence is not judged",'js',"if(observed&&observed.evidence!==undefined)return validEvidence(observed.evidence,receipt)?'applied':'evidence_invalid';","if(false)return 'applied';",'8'],
 ["evidence of any shape is accepted",'js',"if(Object.keys(evidence).sort().join(',')!=='appliedRevision,contentDigest,requestId,target')return false;","",'8'],
 ["invalid evidence falls back to the content",'js',"if(verdict==='evidence_invalid'){plan.actions.push({requestId:receipt.requestId,action:'needs_review',reason:'evidence_invalid'});continue;}\n","",'8'],
 ["the applied revision is taken from the readback",'js',"revision:seen.evidence.appliedRevision});continue;}","revision:Number(seen.revision)||0});continue;}",'8'],
 ["the baseline is recorded without the receipt table",'js',"await assertReceiptsAvailable(env);\n const gate=assertWritable(await readAuthority(env));\n const db=database(env);\n const at=","const gate=assertWritable(await readAuthority(env));\n const db=database(env);\n const at=",'15'],
 ["the baseline is recorded without the marker gate",'js',"const gate=assertWritable(await readAuthority(env));\n const db=database(env);\n const at=","const gate=await readAuthority(env);\n const db=database(env);\n const at=",'15'],
 ["the baseline is not bounded at the read",'js',"if(count>cap)throw failed('baseline_over_capacity');","",'15'],
 ["the baseline copy has no capacity assertion",'js',"   [fenced.assertSql('(SELECT COUNT(*) FROM canonical_revision)<=?'),[cap]],\n","",'17'],
 ["the baseline verifier ignores the digest",'js',"if(seal&&seal[kind+'_digest']!==proof[kind].digest)reasons.push('digest_mismatch:'+kind);","",'17'],
 ["the baseline verifier ignores a missing seal",'js',"if(!seal)reasons.push('seal_missing');","",'17'],
 ["the baseline stores the wrong digest",'js',"[proof.film.digest,proof.person.digest,at]","[proof.person.digest,proof.film.digest,at]",'17'],
 ["the baseline is sealed from a stale read",'js',"const rows=await many(db,'SELECT kind,id,revision FROM canonical_receipt_baseline ORDER BY kind,id LIMIT ?',[cap+1]);\n const proof=await proofOf(rows);\n await writeBatch","const rows=await many(db,'SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id LIMIT ?',[cap+1]);\n const proof=await proofOf(rows);\n await writeBatch",'17'],
 ["an existing watermark is not resumed",'js',"if(Number(state?.mark)===0){","if(true){",'17'],
 ["a sealed baseline can be recorded again",'js',"if(Number(state?.seal)===1)throw failed('receipt_baseline_exists');","",'17'],
 ["an unsealed baseline reads as ready",'js',"return Number(row?.baseline)===1?'ready':'no_baseline';","return 'ready';",'15'],
 ["a receipt is accepted before the baseline is sealed",'sql',"CREATE TRIGGER canonical_write_receipt_insert_baseline\nBEFORE INSERT ON canonical_write_receipt\nFOR EACH ROW\nWHEN NOT EXISTS (SELECT 1 FROM canonical_receipt_baseline_seal WHERE id = 1)","CREATE TRIGGER canonical_write_receipt_insert_baseline\nBEFORE INSERT ON canonical_write_receipt\nFOR EACH ROW\nWHEN 0",'15'],
 ["a watermark is accepted under a stale generation",'sql',"AND generation = NEW.marker_generation)\n OR NEW.film_count",")\n OR NEW.film_count",'15'],
 ["a watermark may disagree with the film highest revision",'sql',"OR NEW.film_max_revision <> COALESCE((SELECT MAX(revision) FROM canonical_receipt_baseline WHERE kind = 'film'), 0)\n","",'15'],
 ["a watermark may disagree with the person highest revision",'sql',"OR NEW.person_max_revision <> COALESCE((SELECT MAX(revision) FROM canonical_receipt_baseline WHERE kind = 'person'), 0)\n","",'15'],
 ["a baseline row is accepted after the watermark",'sql',"BEFORE INSERT ON canonical_receipt_baseline\nFOR EACH ROW\nWHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')\n OR EXISTS (SELECT 1 FROM canonical_receipt_watermark WHERE id = 1)\nBEGIN","BEFORE INSERT ON canonical_receipt_baseline\nFOR EACH ROW\nWHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')\nBEGIN",'15'],
 ["a seal is accepted without the watermark",'sql',"OR NOT EXISTS (SELECT 1 FROM canonical_receipt_watermark WHERE id = 1)\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_baseline_refused');\nEND;\n\nCREATE TRIGGER canonical_receipt_watermark_no_update","\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_baseline_refused');\nEND;\n\nCREATE TRIGGER canonical_receipt_watermark_no_update",'15'],
 ["a seal is accepted while held",'sql',"BEFORE INSERT ON canonical_receipt_baseline_seal\nFOR EACH ROW\nWHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')\n OR","BEFORE INSERT ON canonical_receipt_baseline_seal\nFOR EACH ROW\nWHEN 0\n OR",'15'],
 ["a seal can be updated",'sql',"CREATE TRIGGER canonical_receipt_baseline_seal_no_update\nBEFORE UPDATE ON canonical_receipt_baseline_seal\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_baseline_immutable');\nEND;\n","",'15'],
 ["a seal can be deleted",'sql',"CREATE TRIGGER canonical_receipt_baseline_seal_no_delete\nBEFORE DELETE ON canonical_receipt_baseline_seal\nBEGIN\n SELECT RAISE(ABORT, 'canonical_receipt_baseline_immutable');\nEND;\n","",'15'],
 ["a seal digest may be any text",'sql',"person_digest TEXT NOT NULL CHECK (length(person_digest) = 64 AND person_digest NOT GLOB '*[^0-9a-f]*')","person_digest TEXT NOT NULL CHECK (length(person_digest) = 64)",'17'],
 ["a watermark may disagree with the per-kind counts",'sql',"OR NEW.film_count <> (SELECT COUNT(*) FROM canonical_receipt_baseline WHERE kind = 'film')\n OR NEW.person_count <> (SELECT COUNT(*) FROM canonical_receipt_baseline WHERE kind = 'person')\n","\n",'15'],
 ["evidence of another request is accepted",'js',"return evidence.requestId===receipt.requestId&&target.kind===receipt.target.kind&&target.id===receipt.target.id&&evidence.contentDigest===receipt.contentDigest\n  &&evidence.appliedRevision===receipt.plannedRevision+1;","return target.kind===receipt.target.kind&&target.id===receipt.target.id&&evidence.contentDigest===receipt.contentDigest\n  &&evidence.appliedRevision===receipt.plannedRevision+1;",'8'],
 ["evidence of another target kind is accepted",'js',"return evidence.requestId===receipt.requestId&&target.kind===receipt.target.kind&&target.id===receipt.target.id&&evidence.contentDigest===receipt.contentDigest\n  &&evidence.appliedRevision===receipt.plannedRevision+1;","return evidence.requestId===receipt.requestId&&target.id===receipt.target.id&&evidence.contentDigest===receipt.contentDigest\n  &&evidence.appliedRevision===receipt.plannedRevision+1;",'8'],
 ["evidence of another target is accepted",'js',"return evidence.requestId===receipt.requestId&&target.kind===receipt.target.kind&&target.id===receipt.target.id&&evidence.contentDigest===receipt.contentDigest\n  &&evidence.appliedRevision===receipt.plannedRevision+1;","return evidence.requestId===receipt.requestId&&target.kind===receipt.target.kind&&evidence.contentDigest===receipt.contentDigest\n  &&evidence.appliedRevision===receipt.plannedRevision+1;",'8'],
 ["evidence of another content digest is accepted",'js',"return evidence.requestId===receipt.requestId&&target.kind===receipt.target.kind&&target.id===receipt.target.id&&evidence.contentDigest===receipt.contentDigest\n  &&evidence.appliedRevision===receipt.plannedRevision+1;","return evidence.requestId===receipt.requestId&&target.kind===receipt.target.kind&&target.id===receipt.target.id&&\n  evidence.appliedRevision===receipt.plannedRevision+1;",'8'],
 ["evidence of another revision is accepted",'js',"return evidence.requestId===receipt.requestId&&target.kind===receipt.target.kind&&target.id===receipt.target.id&&evidence.contentDigest===receipt.contentDigest\n  &&evidence.appliedRevision===receipt.plannedRevision+1;","return evidence.requestId===receipt.requestId&&target.kind===receipt.target.kind&&target.id===receipt.target.id&&evidence.contentDigest===receipt.contentDigest;",'8'],
 ["evidence with another target shape is accepted",'js',"if(!target||typeof target!=='object'||Object.keys(target).sort().join(',')!=='id,kind')return false;","",'8'],
 // unreceipted
 ['every change counts as receipted','js',"if(applied.has(key+'|'+Number(change.revision))){covered++;continue;}","if(true){covered++;continue;}",'9'],
 ['a non-terminal receipt is not called out','js',"reason:open.has(key)?'receipt_not_applied':'no_receipt'","reason:'no_receipt'",'9'],
 ['the database read ignores the revision of the receipt','js',"AND w.applied_revision=r.revision)","AND w.applied_revision IS NOT NULL)",'9'],
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canonical-receipts-mutants-'));
// The migrated templates are built ONCE here and copied by every mutant run (a file copy, not a chain replay): the schema 19 one for mutants of the module, the schema 18 one for mutants of the migration (they apply the mutated 0019 to a copy of it).
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const build=(file,list)=>assert.equal(sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+list.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
const templates=path.join(dir,'templates');fs.mkdirSync(templates);
build(path.join(templates,'template.sqlite'),names);
build(path.join(templates,'template18.sqlite'),names.filter(name=>!name.startsWith('0019_')));
for(const [name,file,from] of MUTANTS)assert.equal(sources[file].split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+(file==='js'?JS:SQL));
const absolute=text=>text.replace(/from '\.\/([^']+)'/g,(_,name)=>"from '"+pathToFileURL(path.resolve('src',name)).href+"'");
const run=env=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/canonical-receipts.mjs'],{env:{...process.env,CANON_RECEIPTS_TEMPLATES:templates,...env},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|near ".*": syntax error/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
});
try{
 const queue=MUTANTS.map(([name,file,from,to,sections],index)=>{
  const mutant=path.join(dir,'mutant'+index+(file==='js'?'.mjs':'.sql'));
  fs.writeFileSync(mutant,file==='js'?absolute(sources.js.replace(from,()=>to)):sources.sql.replace(from,()=>to));
  return {name,env:{[file==='js'?'CANON_RECEIPTS_SOURCE':'CANON_RECEIPTS_MIGRATION']:mutant,CANON_RECEIPTS_ONLY:sections}};
 });
 // The control (the unmutated test, whole file) runs beside the mutants instead of before them: it is the longest single run, and a failing control is reported before any survivor.
 const control=run({});
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();if(await run(item.env)===0){
    // A hinted section that does not kill is retried against the whole file, so a stale hint can never hide a survivor.
    const {CANON_RECEIPTS_ONLY,...whole}=item.env;void CANON_RECEIPTS_ONLY;
    if(await run(whole)===0)survivors.push(item.name);
   }}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 assert.equal(await control,0,'the unmutated test passes');
 console.log('canonical-receipts-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
