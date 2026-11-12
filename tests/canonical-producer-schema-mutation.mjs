// AIR-374 S4-2: mutation check of migrations/0020_canonical_producer_run.sql. Each mutant removes or inverts ONE rule (a CHECK clause, a trigger, an index condition, a guard) in a copy of the migration; tests/canonical-producer-schema.mjs, pointed at the
// copy through CANON_PRODUCER_MIGRATION, must FAIL on it. A surviving mutant is a rule no test depends on. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards), so a mutant can never be committed. The schema 19 database is built
// ONCE here and shared (CANON_PRODUCER_TEMPLATE19). Each mutant names the sections of the test that should kill it (CANON_PRODUCER_ONLY); a mutant that the hinted sections do not kill is run against the whole test before it counts as a survivor.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE='migrations/0020_canonical_producer_run.sql';
const original=fs.readFileSync(SOURCE,'utf8');
const once=(from,to)=>text=>{assert.equal(text.split(from).length,2,'the mutation text must occur exactly once: '+from.slice(0,80));return text.replace(from,()=>to);};
// A trigger that never raises: its RAISE becomes a plain SELECT.
const neutral=name=>text=>{
 const start=text.indexOf('CREATE TRIGGER '+name+'\n');assert.ok(start>=0,'trigger '+name);
 const end=text.indexOf('END;',start);
 const block=text.slice(start,end);
 assert.ok(/SELECT RAISE\(ABORT, '[a-z_]+'\);/.test(block));
 return text.slice(0,start)+block.replace(/SELECT RAISE\(ABORT, '[a-z_]+'\);/,'SELECT 1;')+text.slice(end);
};
const TRIGGERS=[
 ['canonical_producer_run_insert_open','2'],['canonical_producer_run_update_open','2'],['canonical_producer_run_insert_shape','5'],['canonical_producer_run_insert_generation','5'],['canonical_producer_run_insert_dictionary_prev','8'],
 ['canonical_producer_run_immutable','6'],['canonical_producer_run_generation','6'],['canonical_producer_run_revision','6'],['canonical_producer_run_applied_once','6'],['canonical_producer_run_replay','6'],['canonical_producer_run_stop_strike','7'],['canonical_producer_run_strike_reset','7'],
 ['canonical_producer_run_strike_cursor','7'],['canonical_producer_run_strike_step','7'],['canonical_producer_run_no_delete','6'],['canonical_producer_unit_result_insert_open','2'],['canonical_producer_unit_result_update_open','2'],['canonical_producer_unit_result_insert_shape','4'],
 ['canonical_producer_unit_result_immutable','9'],['canonical_producer_unit_result_transition','4'],['canonical_producer_unit_result_attempts','9'],['canonical_producer_unit_result_no_delete','9'],
];
// [name, text -> mutated text, sections that should kill it]
const MUTANTS=[
 ...TRIGGERS.map(([name,sections])=>['trigger never raises: '+name,neutral(name),sections]),
 // the guard of the file
 ['the refuse-insert accepts version 18',once("WHERE id = 1 AND version = 19\n AND (","WHERE id = 1 AND version = 18\n AND ("),'1'],
 ['the refuse-insert does not need the baseline seal table',text=>once(") = 6\n);",") = 5\n);")(once("   'canonical_receipt_baseline_seal'\n","")(once("   'canonical_receipt_baseline',\n","   'canonical_receipt_baseline',\n")(text.replace("'canonical_receipt_watermark',\n","'canonical_receipt_watermark',\n")))),'1'],
 ['the refuse-insert does not need film_person_cas',text=>once(") = 6\n);",") = 5\n);")(once("   'film_person_cas',\n","")(text)),'1'],
 ['the version stays 19',once("SET version = 20,","SET version = 19,"),'1'],
 ['the note changes',once("Schema v20: durable canonical producer run and unit result tables (empty). Follows a complete version 19.'\nWHERE","Schema v20: other.'\nWHERE"),'1'],
 ['the result table is not STRICT',text=>{const i=text.lastIndexOf(') STRICT;');return text.slice(0,i)+');'+text.slice(i+') STRICT;'.length);},'1'],
 // the run row
 ['a strike count of 3 is stored',once("CHECK (strike_count BETWEEN 0 AND 2)","CHECK (strike_count BETWEEN 0 AND 3)"),'5'],
 ['a strike id without a count',once(" CHECK ((strike_count = 0) = (strike_id IS NULL)),\n",""),'5'],
 ['a strike without its digest and class',once(" AND strike_digest IS NOT NULL AND strike_class IS NOT NULL))"," ))"),'5'],
 ['a strike count of zero keeps a strike kind',once("(strike_count = 0 AND strike_kind IS NULL AND strike_digest IS NULL AND strike_class IS NULL)","(strike_count = 0 AND strike_digest IS NULL AND strike_class IS NULL)"),'5'],
 ['stopped_by outside a stop',once(" CHECK (stopped_by IS NULL OR pass_state = 'stopped'),\n",""),'5'],
 ['an applied generation of a run that has not passed',once("(pass_state = 'passed' AND source_generation IS NOT NULL AND applied_generation","(source_generation IS NOT NULL AND applied_generation"),'5'],
 ['an applied generation that differs from the source one',once(" AND applied_generation = source_generation AND open_at_completion IS NOT NULL)"," AND open_at_completion IS NOT NULL)"),'5'],
 ['an applied generation without open_at_completion',once(" AND applied_generation = source_generation AND open_at_completion IS NOT NULL)"," AND applied_generation = source_generation)"),'5'],
 ['the cursor may be half set',once(" CHECK ((cursor_kind IS NULL) = (cursor_id IS NULL)),\n",""),'5'],
 ['a dictionary run with a prev_seq that is not seq - 1',once(" AND prev_seq IS NOT NULL AND prev_seq = seq - 1 AND"," AND prev_seq IS NOT NULL AND"),'5'],
 ['a dictionary run with no prev_seq',once(" AND prev_seq IS NOT NULL AND prev_seq = seq - 1 AND"," AND prev_seq = seq - 1 AND"),'5'],
 ['a dictionary run_key that is not d<seq>',once(" AND run_key = 'd' || seq AND"," AND"),'5'],
 ['a dictionary run with no snapshot digest',once(" AND snapshot_digest IS NOT NULL AND source_generation IS NULL AND applied_generation IS NULL)"," AND source_generation IS NULL AND applied_generation IS NULL)"),'5'],
 ['a dictionary run with a source generation',once(" AND snapshot_digest IS NOT NULL AND source_generation IS NULL AND applied_generation IS NULL)"," AND snapshot_digest IS NOT NULL AND applied_generation IS NULL)"),'5'],
 ['an epg run with no source generation',once(" AND snapshot_digest IS NULL AND source_generation IS NOT NULL)"," AND snapshot_digest IS NULL)"),'5'],
 ['an epg run with a snapshot digest',once(" AND snapshot_digest IS NULL AND source_generation IS NOT NULL)"," AND source_generation IS NOT NULL)"),'5'],
 ['an epg run with a seq',once("(origin = 'epg' AND seq IS NULL AND prev_seq IS NULL","(origin = 'epg' AND prev_seq IS NULL"),'5'],
 ['pass_no beyond 10000',once(" pass_no INTEGER NOT NULL DEFAULT 1 CHECK (pass_no BETWEEN 1 AND 10000),"," pass_no INTEGER NOT NULL DEFAULT 1 CHECK (pass_no >= 1),"),'5'],
 ['the run fingerprint is any text',once("fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),\n unit_count","fingerprint TEXT NOT NULL,\n unit_count"),'5'],
 ['a strike digest that is not a digest',once("CHECK (strike_digest IS NULL OR (length(strike_digest) = 64 AND strike_digest NOT GLOB '*[^0-9a-f]*'))","CHECK (strike_digest IS NULL OR length(strike_digest) = 64)"),'5'],
 ['a strike class that is not a code',once(" AND strike_class GLOB '[a-z]*' AND strike_class NOT GLOB '*[^a-z_0-9]*'"," "),'5'],
 ['a run time with a bad character',once(" AND completed_at NOT GLOB '*[^0-9TZ:.-]*'"," "),'5'],
 ['a run time that is too long',once("completed_at IS NULL OR (length(completed_at) BETWEEN 20 AND 32 AND","completed_at IS NULL OR (length(completed_at) >= 20 AND"),'5'],
 ['a run time without the shape',once(" AND completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*Z'"," "),'5'],
 // the result row
 ['a unit-owned open row without a schedule',once(" CHECK (state <> 'open' OR retry_owner = 'receipt' OR next_attempt_at IS NOT NULL),\n",""),'3'],
 ['a receipt-owned row with a schedule',once(" CHECK (retry_owner = 'unit' OR next_attempt_at IS NULL),\n",""),'3'],
 ['a request id without a receipt owner',once(" CHECK ((retry_owner = 'receipt') = (request_id IS NOT NULL)),\n",""),'3'],
 ['a permanent refusal with a schedule or a stamp',once(" CHECK (state <> 'refused_permanent' OR (next_attempt_at IS NULL AND prereq_stamp IS NULL)),\n",""),'3'],
 ['a permanent refusal with a stamp allowed',once("(next_attempt_at IS NULL AND prereq_stamp IS NULL)),","(next_attempt_at IS NULL)),"),'3'],
 ['a recoverable refusal without a stamp',once(" AND next_attempt_at IS NOT NULL AND prereq_stamp IS NOT NULL)),"," AND next_attempt_at IS NOT NULL)),"),'3'],
 ['a recoverable refusal without a schedule',once("(retry_owner = 'unit' AND next_attempt_at IS NOT NULL AND prereq_stamp IS NOT NULL)),","(retry_owner = 'unit' AND prereq_stamp IS NOT NULL)),"),'3'],
 ['a terminal row with a schedule',once(" CHECK (state NOT IN ('settled', 'superseded', 'abandoned') OR next_attempt_at IS NULL),\n",""),'9'],
 ['a terminal row without settled_at',once(" CHECK ((state IN ('settled', 'superseded', 'abandoned')) = (settled_at IS NOT NULL)),\n",""),'9'],
 ['a terminal row without settled_by',once(" CHECK ((state IN ('settled', 'superseded', 'abandoned')) = (settled_by IS NOT NULL))\n",""),'9'],
 ['a state outside the six',once("CHECK (state IN ('open', 'refused_permanent', 'refused_recoverable', 'settled', 'superseded', 'abandoned'))","CHECK (state IN ('open', 'refused_permanent', 'refused_recoverable', 'settled', 'superseded', 'abandoned', 'other'))"),'3'],
 ['a third retry owner',once("CHECK (retry_owner IN ('unit', 'receipt'))","CHECK (retry_owner IN ('unit', 'receipt', 'other'))"),'3'],
 ['attempts beyond 16',once("CHECK (attempts BETWEEN 1 AND 16)","CHECK (attempts >= 1)"),'3'],
 ['attempts may be zero',once("CHECK (attempts BETWEEN 1 AND 16)","CHECK (attempts BETWEEN 0 AND 16)"),'3'],
 ['a code that starts with a digit',once("CHECK (length(code) BETWEEN 1 AND 80 AND code GLOB '[a-z]*' AND","CHECK (length(code) BETWEEN 1 AND 80 AND"),'3'],
 ['a code with any character',once(" AND code NOT GLOB '*[^a-z_0-9]*'),"," ),"),'3'],
 ['a code of any length',once("CHECK (length(code) BETWEEN 1 AND 80 AND","CHECK (length(code) >= 1 AND"),'3'],
 ['a request id with any character',once(" AND request_id NOT GLOB '*[^A-Za-z0-9:._/=+@-]*'"," "),'3'],
 ['a kind with a capital',once("CHECK (length(kind) BETWEEN 1 AND 40 AND kind NOT GLOB '*[^a-z_]*')","CHECK (length(kind) BETWEEN 1 AND 40)"),'3'],
 ['a unit id of any length',once("CHECK (length(unit_id) BETWEEN 1 AND 200)","CHECK (length(unit_id) >= 1)"),'3'],
 ['a result stamp of any text',once("CHECK (prereq_stamp IS NULL OR (length(prereq_stamp) = 64 AND prereq_stamp NOT GLOB '*[^0-9a-f]*'))","CHECK (prereq_stamp IS NULL OR length(prereq_stamp) = 64)"),'3'],
 ['a unit digest of any text',once("CHECK (length(unit_digest) = 64 AND unit_digest NOT GLOB '*[^0-9a-f]*')","CHECK (length(unit_digest) = 64)"),'3'],
 ['a settled_by that is not a code',once(" AND settled_by GLOB '[a-z]*' AND settled_by NOT GLOB '*[^a-z_0-9]*'"," "),'3'],
 ['a next_attempt_at with a bad character',once(" AND next_attempt_at NOT GLOB '*[^0-9TZ:.-]*'"," "),'3'],
 ['a settled_at with a bad character',once(" AND settled_at NOT GLOB '*[^0-9TZ:.-]*'"," "),'3'],
 ['a result time of any length',once("next_attempt_at IS NULL OR (length(next_attempt_at) BETWEEN 20 AND 32 AND","next_attempt_at IS NULL OR (length(next_attempt_at) >= 20 AND"),'3'],
 ['a result row without its run',once(" FOREIGN KEY (origin, run_key) REFERENCES canonical_producer_run (origin, run_key),\n",""),'4'],
 ['more than one live row per unit',once("CREATE UNIQUE INDEX canonical_producer_unit_result_live ON canonical_producer_unit_result (origin, run_key, kind, unit_id) WHERE state IN ('open', 'refused_permanent', 'refused_recoverable');","CREATE INDEX canonical_producer_unit_result_live ON canonical_producer_unit_result (origin, run_key, kind, unit_id) WHERE state IN ('open', 'refused_permanent', 'refused_recoverable');"),'4'],
 ['a permanent refusal is not live',once("(origin, run_key, kind, unit_id) WHERE state IN ('open', 'refused_permanent', 'refused_recoverable');","(origin, run_key, kind, unit_id) WHERE state IN ('open', 'refused_recoverable');"),'4'],
 // targeted trigger conditions
 ['a terminal row is not frozen once it is superseded',once("WHEN OLD.state IN ('settled', 'superseded', 'abandoned')\n","WHEN OLD.state IN ('settled', 'abandoned')\n"),'4'],
 ['a new result may be terminal',once("WHEN NEW.state NOT IN ('open', 'refused_permanent', 'refused_recoverable')\n","WHEN 0\n"),'4'],
 ['attempts may jump',once("NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1","NEW.attempts < OLD.attempts"),'9'],
 ['attempts may go down',once("NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1","NEW.attempts > OLD.attempts + 1"),'9'],
 ['the request id may change',once(" OR NEW.request_id IS NOT OLD.request_id"," "),'9'],
 ['the unit digest may change',once(" OR NEW.unit_digest <> OLD.unit_digest"," "),'9'],
 ['the result fingerprint may change',once("OR NEW.fingerprint <> OLD.fingerprint OR NEW.unit_digest","OR NEW.unit_digest"),'9'],
 ['the result created_at may change',once(" OR NEW.request_id IS NOT OLD.request_id OR NEW.created_at <> OLD.created_at"," OR NEW.request_id IS NOT OLD.request_id"),'9'],
 ['the result pass_no may change',once(" OR NEW.pass_no <> OLD.pass_no OR NEW.kind <> OLD.kind"," OR NEW.kind <> OLD.kind"),'9'],
 ['the revision may jump',once("WHEN NEW.revision <> OLD.revision + 1","WHEN NEW.revision < OLD.revision + 1"),'6'],
 ['the applied generation may be taken back',once("WHEN OLD.applied_generation IS NOT NULL AND NEW.applied_generation IS NOT OLD.applied_generation","WHEN OLD.applied_generation IS NOT NULL AND NEW.applied_generation IS NOT OLD.applied_generation AND NEW.applied_generation IS NOT NULL"),'6'],
 ['the run source generation may change',once(" OR NEW.source_generation IS NOT OLD.source_generation OR"," OR"),'6'],
 ['the run created_at may change',once("OR NEW.source_generation IS NOT OLD.source_generation OR NEW.created_at <> OLD.created_at\n","OR NEW.source_generation IS NOT OLD.source_generation\n"),'6'],
 ['the snapshot digest may change',once(" OR NEW.snapshot_digest IS NOT OLD.snapshot_digest OR"," OR"),'6'],
 ['a replay may keep the fingerprint',once("AND NEW.fingerprint <> OLD.fingerprint AND NEW.cursor_kind IS NULL","AND NEW.cursor_kind IS NULL"),'6'],
 ['a replay may keep the cursor',once("AND NEW.cursor_kind IS NULL AND NEW.cursor_id IS NULL AND NEW.strike_count = 0 AND NEW.pass_state = 'passing'","AND NEW.strike_count = 0 AND NEW.pass_state = 'passing'"),'6'],
 ['a replay may keep its strike',once(" AND NEW.strike_count = 0 AND NEW.pass_state = 'passing' AND NEW.stopped_by IS NULL))"," AND NEW.pass_state = 'passing' AND NEW.stopped_by IS NULL))"),'6'],
 ['a replay may stay stopped',once(" AND NEW.pass_state = 'passing' AND NEW.stopped_by IS NULL))"," ))"),'6'],
 ['a replay may skip a pass',once("NEW.pass_no = OLD.pass_no + 1 AND NEW.fingerprint","NEW.pass_no > OLD.pass_no AND NEW.fingerprint"),'6'],
 ['the plan may change without a replay',once(" OR (NEW.pass_no = OLD.pass_no AND (NEW.fingerprint <> OLD.fingerprint OR NEW.plan_version <> OLD.plan_version OR NEW.unit_count <> OLD.unit_count))",""),'6'],
 ['the plan version may change without a replay',once(" OR NEW.plan_version <> OLD.plan_version OR NEW.unit_count"," OR NEW.unit_count"),'6'],
 ['the generation may go down',once("WHEN NEW.marker_generation < OLD.marker_generation","WHEN NEW.marker_generation < OLD.marker_generation - 5"),'6'],
 ['a new run may start at pass 2',once("WHEN NEW.pass_no <> 1 OR NEW.pass_state","WHEN NEW.pass_state"),'5'],
 ['a new run may start with a strike',once(" OR NEW.strike_count <> 0 OR NEW.stopped_by IS NOT NULL OR NEW.applied_generation"," OR NEW.stopped_by IS NOT NULL OR NEW.applied_generation"),'5'],
 ['a new run may start passed',once("WHEN NEW.pass_no <> 1 OR NEW.pass_state <> 'passing' OR","WHEN NEW.pass_no <> 1 OR"),'5'],
 ['a new run may start with counts',once(" OR NEW.n_applied <> 0 OR NEW.n_noop <> 0 OR NEW.n_kept <> 0 OR NEW.n_failed <> 0"," "),'5'],
 ['a new run may start with a revision',once(" OR NEW.revision <> 1 OR NEW.n_applied"," OR NEW.n_applied"),'5'],
 ['a new run may start completed',once(" OR NEW.completed_at IS NOT NULL OR NEW.open_at_completion IS NOT NULL"," "),'5'],
 ['a future marker generation',once("WHEN NEW.marker_generation <> COALESCE(","WHEN NEW.marker_generation < COALESCE("),'5'],
 ['d2 and later need no previous guard',once("WHEN NEW.origin = 'dictionary' AND NEW.prev_seq > 0 AND NOT EXISTS","WHEN NEW.origin = 'dictionary' AND NEW.prev_seq > 1 AND NOT EXISTS"),'8'],
 ['d1 is guarded like the rest',once("WHEN NEW.origin = 'dictionary' AND NEW.prev_seq > 0 AND NOT EXISTS","WHEN NEW.origin = 'dictionary' AND NOT EXISTS"),'8'],
 ['a mint over an equal digest',once(" AND seq = NEW.prev_seq AND snapshot_digest <> NEW.snapshot_digest)"," AND seq = NEW.prev_seq)"),'8'],
 ['a stop that touches the strike',once("WHEN NEW.pass_state = 'stopped' AND NOT (NEW.strike_kind IS OLD.strike_kind","WHEN NEW.pass_state = 'stopped' AND OLD.pass_state <> 'stopped' AND NOT (NEW.strike_kind IS OLD.strike_kind"),'7'],
 ['a strike that resets with no cursor move',once("AND NEW.strike_count = 0 AND NOT ((NEW.cursor_kind IS NOT OLD.cursor_kind OR NEW.cursor_id IS NOT OLD.cursor_id) OR NEW.pass_no > OLD.pass_no)","AND NEW.strike_count = 0 AND NOT (NEW.pass_no > OLD.pass_no)"),'7'],
 ['a strike that resets on a pass_no increase only through the cursor',once("OR NEW.pass_no > OLD.pass_no)","OR 0)"),'7'],
 ['a strike write that moves the cursor',once("AND NEW.strike_count > 0 AND ((NEW.cursor_kind IS NOT OLD.cursor_kind OR NEW.cursor_id IS NOT OLD.cursor_id) OR NEW.pass_no <> OLD.pass_no)","AND NEW.strike_count > 0 AND (NEW.pass_no <> OLD.pass_no)"),'7'],
 ['a strike that decrements',once("AND NEW.strike_count <> OLD.strike_count + 1)","AND NEW.strike_count > OLD.strike_count + 1)"),'7'],
 ['a new identity that starts above 1',once(") AND NEW.strike_count <> 1))",") AND NEW.strike_count > 2))"),'7'],
 ['the strike class is not part of the identity',text=>{const from=" AND NEW.strike_class IS OLD.strike_class";return text.split(from).join(' ');},'7'],
 ['the strike digest is not part of the identity',text=>{const from=" AND NEW.strike_digest IS OLD.strike_digest";return text.split(from).join(' ');},'7'],
];
const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'producer-schema-mutants-'));
const template=path.join(dir,'t19.sqlite');
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=19).sort();
const built=spawnSync('sqlite3',[template],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26});
assert.equal(built.status,0,built.stderr);
const run=(file,sections)=>new Promise(resolve=>{
 const env={...process.env,CANON_PRODUCER_MIGRATION:file,CANON_PRODUCER_TEMPLATE19:template};
 if(sections)env.CANON_PRODUCER_ONLY=sections;else delete env.CANON_PRODUCER_ONLY;
 const child=spawn(process.execPath,['tests/canonical-producer-schema.mjs'],{env,stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 // a mutant that is not even valid SQL for the apply step is reported as BROKEN, never as killed
 child.on('close',code=>resolve({code,err}));
});
try{
 const control=path.join(dir,'control.sql');fs.writeFileSync(control,original);
 assert.equal((await run(control,null)).code,0,'the unmutated copy must pass the whole test');
 const invalid=[];
 const queue=MUTANTS.flatMap(([name,mutate,sections],index)=>{
  let mutated;
  try{mutated=mutate(original);assert.notEqual(mutated,original,'the mutant changes the file');}catch(error){invalid.push(name+': '+error.message.split('\n')[0].slice(0,120));return [];}
  const file=path.join(dir,'mutant'+index+'.sql');fs.writeFileSync(file,mutated);
  return [{name,file,sections}];
 });
 assert.deepEqual(invalid,[],'mutants whose mutation text is not in the file exactly once');
 const survivors=[],broken=[];
 const workers=Array.from({length:4},async()=>{while(queue.length){
  const item=queue.shift();
  let result=await run(item.file,item.sections);
  if(result.code===0)result=await run(item.file,null);
  if(result.code===0)survivors.push(item.name);
  else if(/near line|syntax error|incomplete input|no such (table|column)/.test(result.err)&&!/AssertionError/.test(result.err))broken.push(item.name+': '+result.err.slice(0,160));
 }});
 await Promise.all(workers);
 assert.deepEqual(broken,[],'broken mutants (invalid SQL, not a killed rule): '+broken.join('; '));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-producer-schema-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
