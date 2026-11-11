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
 ['a write is made without the marker gate','js',"const gate=assertWritable(await readAuthority(env));\n let row=","const gate=await readAuthority(env);\n let row=",'4'],
 ['a write is made without the receipt table','js',"await assertReceiptsAvailable(env);\n const gate=assertWritable(","void 0;\n const gate=assertWritable(",'4'],
 ['the receipt batch carries no fence head','js',"const all=[...fenced.head(gate,[]),...statements];","const all=[...statements];",'7'],
 ['a different request under one id is a replay','js',"if(!sameRequest(row,request))throw failed('receipt_conflict');","",'4'],
 ['content is ignored in the identity of a request','js',"row.target.id===request.target.id&&row.contentDigest===request.digest","row.target.id===request.target.id",'4'],
 ['an applied receipt runs again','js',"if(row.state==='applied')return {ran:false,state:'applied',already:true,receipt:row};","",'4'],
 ['an abandoned receipt runs again','js',"if(row.state==='abandoned')return {ran:false,state:'abandoned',receipt:row};","",'6'],
 ['an attempt in flight or backing off runs again','js',"if(timeOf(now)<timeOf(row.nextAttemptAt))return {ran:false,state:row.state,reason:row.state==='pending'?'in_flight':'backoff',nextAttemptAt:row.nextAttemptAt,receipt:row};","",'6,7'],
 ['a retry is made without a readback','js',"if(observed&&observed.digest===row.contentDigest){\n   await transition(env,gate,row,{kind:'applied'","if(false){\n   await transition(env,gate,row,{kind:'applied'",'7'],
 ['any readback counts as applied','js',"if(observed&&observed.digest===row.contentDigest){\n   await transition(env,gate,row,{kind:'applied'","if(observed){\n   await transition(env,gate,row,{kind:'applied'",'7'],
 ['the retry bound is ignored','js',"const exhausted=row.attempts>=policy.maxAttempts?'attempts_exhausted'","const exhausted=false?'attempts_exhausted'",'6'],
 ['the age bound is ignored','js',":timeOf(now)-timeOf(row.createdAt)>policy.abandonAfterMs?'expired':null;",":null;",'6'],
 ['the backoff never grows','js',"return policy.backoffMs[Math.min(attempts-1,policy.backoffMs.length-1)];","return policy.backoffMs[0];",'6'],
 ['a permanent refusal is retried','js',"outcome:PERMANENT.has(errorClass)?'abandoned':RETRYABLE.has(errorClass)?'failed':'unknown'","outcome:RETRYABLE.has(errorClass)?'failed':'unknown'",'6'],
 ['an unknown outcome is read as a definite failure','js',"outcome:PERMANENT.has(errorClass)?'abandoned':RETRYABLE.has(errorClass)?'failed':'unknown'","outcome:PERMANENT.has(errorClass)?'abandoned':'failed'",'6'],
 ['an error message is stored as the class','js',"return IDENT.test(code)?code:'unclassified';","return IDENT.test(code)?code:String(error?.message||'unclassified');",'7,11'],
 ['a failed attempt is not marked','js',"   if(outcome==='abandoned')await transition(env,gate,current,{kind:'abandoned',errorClass},now);\n   else await transition(env,gate,current,{kind:'failed',state:outcome,errorClass,nextAttemptAt:plus(now,backoffMs(attempt,policy))},now);","   void now;",'6,7'],
 ['a successful attempt is not marked applied','js',"  await transition(env,gate,{...row,state:'pending',attempts:attempt},{kind:'applied',revision},clock());\n ","  void revision;\n ",'4'],
 ['a retry keeps the old marker generation','js',"[change.plannedRevision,gate.generation,change.nextAttemptAt,now,...where]","[change.plannedRevision,row.markerGeneration,change.nextAttemptAt,now,...where]",'7'],
 ['the in-batch applied statement has no assertion','js',"  [CHANGED,[]],\n ];","  void CHANGED,\n ];",'5'],
 ['the stable request id carries its source text','js',"return origin+':'+operation+':'+(await digestOf(source));","return origin+':'+operation+':'+String(source);",'4'],
 ['a request digest is not validated','js',"||!DIGEST.test(request.digest||'')","",'4'],
 // the reconcile plan and the pass
 ['the plan acts while the marker is not open','js',"if(marker?.state!=='open'){plan.waiting.push({requestId:receipt.requestId,reason:'marker_not_open'","if(false){plan.waiting.push({requestId:receipt.requestId,reason:'marker_not_open'",'8'],
 ['the plan acts before a receipt is due','js',"if(at<timeOf(receipt.nextAttemptAt)){plan.waiting.push","if(false){plan.waiting.push",'8'],
 ['the plan acts without a readback','js',"if(seen===undefined){plan.actions.push({requestId:receipt.requestId,action:'readback'});continue;}","",'8'],
 ['the plan never recognises a landed write','js',"if(seen&&seen.digest===receipt.contentDigest){","if(false){",'8'],
 ['the plan recognises any content as landed','js',"if(seen&&seen.digest===receipt.contentDigest){","if(seen){",'8'],
 ['the plan never abandons an exhausted receipt','js',"if(receipt.attempts>=policy.maxAttempts){plan.actions.push","if(false){plan.actions.push",'8'],
 ['the plan never abandons an expired receipt','js',"if(at-timeOf(receipt.createdAt)>policy.abandonAfterMs){plan.actions.push","if(false){plan.actions.push",'8'],
 ['the plan hides an abandoned receipt','js',"plan.attention.push({requestId:receipt.requestId,reason:receipt.errorClass||'abandoned'});continue;","continue;",'8'],
 ['the plan never asks for a re-plan','js',"replan:receipt.markerGeneration!==marker.generation","replan:false",'8'],
 ['the pass acts while the marker is not open','js',"if(gate.state!=='open'){result.waiting=","if(false){result.waiting=",'7'],
 ['the pass reads receipts that are not due','js',"await listReceipts(env,{dueBefore:at,limit})","await listReceipts(env,{limit})",'10'],
 ['the receipt read is not capped','js',"const cap=Math.min(Math.max(Number(limit)||1,1),RECONCILE_LIMIT_MAX);","const cap=Number(limit)||1;",'10'],
 ['an unregistered operation is guessed','js',"if(!operation){missing.add(row.requestId);result.waiting.push({requestId:row.requestId,reason:'operation_unregistered'});continue;}","",'10'],
 // unreceipted
 ['every change counts as receipted','js',"if(applied.has(key+'|'+Number(change.revision)))covered++;","if(true)covered++;",'9'],
 ['a non-terminal receipt is not called out','js',"reason:open.has(key)?'receipt_not_applied':'no_receipt'","reason:'no_receipt'",'9'],
 ['the database read ignores the revision of the receipt','js',"AND w.state='applied' AND w.applied_revision=r.revision)","AND w.state='applied')",'9'],
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canonical-receipts-mutants-'));
for(const [name,file,from] of MUTANTS)assert.equal(sources[file].split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+(file==='js'?JS:SQL));
const absolute=text=>text.replace(/from '\.\/([^']+)'/g,(_,name)=>"from '"+pathToFileURL(path.resolve('src',name)).href+"'");
const run=env=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/canonical-receipts.mjs'],{env:{...process.env,...env},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|near ".*": syntax error/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
});
try{
 const queue=MUTANTS.map(([name,file,from,to,sections],index)=>{
  const mutant=path.join(dir,'mutant'+index+(file==='js'?'.mjs':'.sql'));
  fs.writeFileSync(mutant,file==='js'?absolute(sources.js.replace(from,()=>to)):sources.sql.replace(from,()=>to));
  return {name,env:{[file==='js'?'CANON_RECEIPTS_SOURCE':'CANON_RECEIPTS_MIGRATION']:mutant,CANON_RECEIPTS_ONLY:sections}};
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();if(await run(item.env)===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-receipts-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
