// AIR-637 / ADR 0215 (Accepted), card EC: migration 0042 (a file only), the writer control and its operator, the ledger's source_order and known_alias, the domain-path
// trigger relaxation and the conditional-insert + assertion helper, on the sqlite3-CLI D1 stand-in. No Worker, R2, network or production access.
// Covered: the migration's refusal and replay; the control tables (absent = off, compare-and-swap, valid transitions, append-only change log, drain evidence, recorded
// breaks); `source_order` and `known_alias`; the domain path (unbound candidate rows only, fenced by the writer's batch, not by the Film/Person marker); the key and strength
// helpers; absent/off/pending/on, a valid duplicate, a mismatching row and a different causal position (all rolling the domain batch back), statement counts, and the
// the dormant wiring (only the E2c owner writer imports the control; no Worker module can change it).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {evidenceKeyOf,evidenceStrength,METHODS,normalizeEvidence} from '../src/identity-evidence.js';
import {ABSENT,CHANGE_KINDS,WRITERS,changeWriter,domainEvidenceStatements,identityEvidenceControlStatus,planDomainEvidence,readWriter,readWriterChanges} from '../src/identity-evidence-writer.js';

const NEW='0042_identity_evidence_writer_control.sql',PREVIOUS='0041_film_identity_evidence.sql';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.ok(files.includes(NEW),'0042 exists');
assert.equal(files[files.indexOf(NEW)-1],PREVIOUS,'0042 follows 0041');
const chain=files.slice(0,files.indexOf(NEW));
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-identity-writer-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const ok=(file,text)=>{const r=sqlite(file,text);assert.equal(r.status,0,r.stderr+' <- '+text);};
const refused=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'expected a refusal: '+text);if(pattern)assert.match(r.stderr,pattern,text);};
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};

const template40=path.join(root,'t41.sqlite'),template=path.join(root,'t42.sqlite');
ok(template40,chain.map(read).join('\n'));
fs.copyFileSync(template40,template);
ok(template,read(NEW));
let n=0;
const copy=source=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(source,file);return file;};
const envOf=file=>({DB:d1Standin(file)});
const hex=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const T0=Date.parse('2026-11-25T10:00:00.000Z');
const iso=ms=>new Date(T0+ms).toISOString();
const AT=iso(0);
const key=i=>i.toString(16).padStart(64,'0');
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY=crypto.createHash('sha256').update('[]').digest('hex');
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
// The Film/Person marker at d1/open, as the canonical path needs it.
const OPEN=VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE;
const lit=value=>value===null||value===undefined?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";

// ===== 1. the migration: it follows a complete 41, creates nothing otherwise, and leaves 0041 and the ledger untouched =====
{
 const objects=file=>one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','trigger','index')");
 const t40=path.join(root,'t40.sqlite');
 ok(t40,chain.slice(0,-1).map(read).join('\n'));
 const before=objects(t40);
 refused(t40,read(NEW));
 assert.equal(objects(t40),before,'a refused file creates nothing (schema 40)');
 assert.equal(one(t40,'SELECT version FROM schema_contract WHERE id=1'),40);
 // A version 41 whose ledger lost an E1 trigger is not a complete 41.
 const damaged=copy(template40);
 ok(damaged,'DROP TRIGGER film_identity_evidence_no_delete');
 const beforeDamaged=objects(damaged);
 refused(damaged,read(NEW));
 assert.equal(objects(damaged),beforeDamaged,'a refused file creates nothing (41 without an E1 trigger)');
 refused(template,read(NEW),/UNIQUE|PRIMARY/);
 assert.equal(one(template,'SELECT version FROM schema_contract WHERE id=1'),42);
 assert.equal(one(template,'SELECT COUNT(*) FROM schema_contract'),1);
 assert.equal(one(template,'SELECT COUNT(*) FROM film_identity_evidence'),0,'the ledger is still empty');
 assert.equal(one(template,'SELECT COUNT(*) FROM identity_evidence_writer'),0,'no control row: every writer is off');
 assert.equal(one(template,'SELECT COUNT(*) FROM identity_evidence_writer_change'),0);
 assert.deepEqual(rows(template,'SELECT mode,cutover,generation FROM film_person_authority'),[{mode:'r2',cutover:'open',generation:0}],'the marker is not moved');
 // A ledger that already holds E1 rows takes the migration (the column is nullable): the rows keep their data and get a NULL source_order.
 const populated=copy(template40);
 ok(populated,OPEN+"INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,origin,request_id,recorded_at) VALUES ('"+key(1)+"','film:tmdb:603','letterboxd_lid','lid603','same_work','tmdb_movie','603','asserts','ratings_diary','page_check','"+hex('page')+"','"+AT+"','live','req','"+AT+"')");
 ok(populated,read(NEW));
 assert.deepEqual(rows(populated,'SELECT evidence_key,source_order FROM film_identity_evidence'),[{evidence_key:key(1),source_order:null}]);
 // No other table is touched: the schema difference between 41 and 42 is exactly the new objects and the replaced triggers.
 const names=file=>rows(file,"SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").map(row=>row.type+':'+row.name).sort();
 const added=names(template).filter(name=>!names(template40).includes(name));
 assert.deepEqual(added,['index:film_identity_evidence_scope_ref','index:identity_evidence_writer_change_writer','table:identity_evidence_writer','table:identity_evidence_writer_change','trigger:film_identity_evidence_scope_arrival',
  'trigger:film_identity_evidence_source_order','trigger:identity_evidence_writer_change_apply','trigger:identity_evidence_writer_change_conflict','trigger:identity_evidence_writer_change_current',
  'trigger:identity_evidence_writer_change_no_delete','trigger:identity_evidence_writer_change_no_update','trigger:identity_evidence_writer_insert','trigger:identity_evidence_writer_no_delete',
  'trigger:identity_evidence_writer_update'].sort());
 assert.deepEqual(names(template40).filter(name=>!names(template).includes(name)),[],'0042 removes no object (the four replaced triggers keep their names)');
 const downgrade=copy(template);
 refused(downgrade,'UPDATE schema_contract SET version=41 WHERE id=1',/schema_contract_downgrade/);
}

// ===== 2. the ledger SQL: source_order, known_alias, the domain path =====
const COLUMNS=['evidence_key','film_id','subject_kind','subject_value','relation','object_kind','object_value','polarity','route','method','source_root','source_ref','source_scope','scope_evidence_key','supersedes_key','observed_at','origin','reconstruction_run','reconstructed_from','request_id','recorded_at','source_order'];
const DOMAIN={evidence_key:key(10),film_id:null,subject_kind:'discovery_observation',subject_value:'the matrix|1999',relation:'candidate_for',object_kind:'tmdb_movie',object_value:'603',polarity:'asserts',route:'discovery_scan',
 method:'tmdb_detail_check',source_root:'the matrix|1999',source_ref:null,source_scope:null,scope_evidence_key:null,supersedes_key:null,observed_at:AT,origin:'live',reconstruction_run:null,reconstructed_from:null,request_id:'req',recorded_at:AT,source_order:null};
const insert=(over={})=>{const row={...DOMAIN,...over};return 'INSERT INTO film_identity_evidence ('+COLUMNS.join(',')+') VALUES ('+COLUMNS.map(column=>lit(row[column])).join(',')+')';};
const FILM_BOUND={film_id:'film:tmdb:603',subject_kind:'letterboxd_lid',subject_value:'lid603',relation:'same_work',route:'ratings_diary',method:'page_check',source_root:hex('page'),subject_value_:null};
delete FILM_BOUND.subject_value_;
{
 // The domain path: an unbound Discovery candidate row inserts while the Film/Person marker is NOT open (it is `r2` here), and a Film-bound row still needs the marker.
 const file=copy(template);
 ok(file,insert());
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence WHERE film_id IS NULL'),1,'a domain row names no Film and needs no marker');
 refused(file,insert({...FILM_BOUND,evidence_key:key(11)}),/film_identity_evidence_not_open/);
 ok(file,OPEN);
 ok(file,insert({...FILM_BOUND,evidence_key:key(11)}));
 // Only the Discovery candidate shape is admitted unbound.
 for(const [name,over] of [
  ['a Letterboxd lid',{subject_kind:'letterboxd_lid',subject_value:'lid1',relation:'same_work',route:'ratings_diary',method:'page_check'}],
  ['an exists sighting',{relation:'exists',object_kind:null,object_value:null}],
  ['a retirement route',{route:'letterboxd_rated_archive'}],
  ['the epg route',{route:'epg_programme'}],
 ])refused(file,insert({...over,evidence_key:key(20)}),/film_identity_evidence_(unbound|shape)/,name);
 refused(file,insert({evidence_key:key(21),subject_kind:'tmdb_movie',subject_value:'603',relation:'film_has_id',object_kind:'tmdb_movie',object_value:'1',route:'owner_action',method:'owner_statement',source_order:1}),/film_identity_evidence_(unbound|shape)/);
 // E1's other triggers still apply to a domain row: append-only, the shape of ADR 0213, no proof by a title search, only owner/page refutations.
 refused(file,"UPDATE film_identity_evidence SET source_ref='x' WHERE evidence_key='"+key(10)+"'",/film_identity_evidence_append_only/);
 refused(file,"DELETE FROM film_identity_evidence",/film_identity_evidence_append_only/);
 refused(file,insert({evidence_key:key(22),method:'title_year_search'}),/CHECK constraint failed/);
 refused(file,insert({evidence_key:key(23),object_kind:'letterboxd_lid'}),/film_identity_evidence_shape/);
 refused(file,insert({evidence_key:key(24),polarity:'refutes',method:'known_alias'}),/CHECK constraint failed/);
 // known_alias is a method value now, with E1's rules around it.
 ok(file,insert({evidence_key:key(25),method:'known_alias',source_scope:'known_epg_alias'}));
 ok(file,insert({evidence_key:key(26),method:'known_alias',source_scope:'known_alias_year_runtime'}));
 refused(file,insert({evidence_key:key(27),method:'not_a_method'}),/film_identity_evidence_shape/);
 // source_order: a positive integer on an owner row only; `seq` still orders insertion.
 ok(file,insert({evidence_key:key(30),route:'owner_action',method:'owner_statement',source_order:7}));
 ok(file,insert({evidence_key:key(31),route:'owner_action',method:'owner_statement'}));
 refused(file,insert({evidence_key:key(32),route:'owner_action',method:'owner_statement',source_order:0}),/CHECK constraint failed/);
 refused(file,insert({evidence_key:key(33),route:'owner_action',method:'owner_statement',source_order:-3}),/CHECK constraint failed/);
 refused(file,insert({evidence_key:key(34),source_order:5}),/film_identity_evidence_source_order/);
 refused(file,insert({...FILM_BOUND,evidence_key:key(35),source_order:5}),/film_identity_evidence_source_order/);
 assert.equal(one(file,'SELECT source_order FROM film_identity_evidence WHERE evidence_key=\''+key(30)+'\''),7);
 // A replay of an existing key is still an exact no-op (the conflict trigger of 0041 is unchanged), and the seq of the original row stays.
 const seq=one(file,"SELECT seq FROM film_identity_evidence WHERE evidence_key='"+key(10)+"'");
 ok(file,insert({request_id:'again'})+' ON CONFLICT(evidence_key) DO NOTHING');
 ok(file,'PRAGMA recursive_triggers=OFF;'+insert({request_id:'evil'}).replace(/^INSERT/,'INSERT OR REPLACE'));
 assert.equal(one(file,"SELECT seq FROM film_identity_evidence WHERE evidence_key='"+key(10)+"'"),seq);
 assert.equal(one(file,"SELECT request_id FROM film_identity_evidence WHERE evidence_key='"+key(10)+"'"),'req');
}

// ----- 2b. forward withdrawals (ADR 0215 decision 6): a scoped refutation of the domain path may name a target that does not exist yet -----
{
 const file=copy(template);
 const OWNER={route:'owner_action',method:'owner_statement',source_root:'intent-1'};
 const revoke=(n,target,over={})=>insert({evidence_key:key(n),...OWNER,polarity:'refutes',scope_evidence_key:key(target),source_order:2,source_root:'intent-revoke-'+n,...over});
 const assign=(n,over={})=>insert({evidence_key:key(n),...OWNER,source_order:1,source_root:'intent-assign-'+n,...over});
 // revoke before target: accepted, the target is not there yet.
 ok(file,revoke(50,51));
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),1);
 // the target arrives later with the SAME proposition: accepted, the withdrawal and the target are both stored.
 ok(file,assign(51));
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),2);
 // a target arriving with ANOTHER proposition than a withdrawal already naming it is refused whole (nothing lands).
 ok(file,revoke(52,53));
 refused(file,assign(53,{object_value:'604'}),/film_identity_evidence_scope/);
 refused(file,assign(53,{subject_value:'another film|2000'}),/film_identity_evidence_scope/);
 assert.equal(one(file,"SELECT COUNT(*) FROM film_identity_evidence WHERE evidence_key='"+key(53)+"'"),0,'a mismatching arrival rolled back');
 ok(file,assign(53));
 // target before revoke: the unchanged 0041 rule for an existing target, same proposition accepted, another refused.
 ok(file,revoke(54,51));
 refused(file,revoke(55,51,{object_value:'604'}),/film_identity_evidence_scope/);
 refused(file,revoke(56,51,{subject_value:'another film|2000'}),/film_identity_evidence_scope/);
 // the replay of a stored forward withdrawal is still an exact no-op (the conflict trigger of 0041).
 ok(file,revoke(50,51)+' ON CONFLICT(evidence_key) DO NOTHING');
 ok(file,'PRAGMA recursive_triggers=OFF;'+revoke(50,51).replace(/^INSERT/,'INSERT OR REPLACE'));
 assert.equal(one(file,"SELECT COUNT(*) FROM film_identity_evidence WHERE evidence_key='"+key(50)+"'"),1);
 // the forward reference is NARROW: only an unbound owner row. A Film-bound refutation, or another route, still needs an existing target (0041 behaviour).
 refused(file,revoke(57,58,{film_id:'film:tmdb:603'}),/film_identity_evidence_(scope|not_open)/);
 const open=copy(template);ok(open,OPEN);
 refused(open,revoke(57,58,{film_id:'film:tmdb:603',subject_kind:'letterboxd_lid',subject_value:'lid603',relation:'same_work',object_kind:'tmdb_movie',object_value:'603',route:'ratings_diary',method:'page_check',source_root:hex('p'),source_order:null}),/film_identity_evidence_scope/);
 refused(file,revoke(59,60,{route:'discovery_scan',source_order:null}),/film_identity_evidence_scope/);
 // a withdrawal never targets itself, and every other E1 rule still applies to a forward withdrawal (shape, CHECKs, append-only).
 refused(file,revoke(61,61),/CHECK constraint failed/);
 refused(file,revoke(62,63,{method:'known_alias'}),/CHECK constraint failed/);
 refused(file,revoke(64,65,{subject_kind:'letterboxd_lid',subject_value:'lid1'}),/film_identity_evidence_(shape|unbound)/);
 refused(file,"UPDATE film_identity_evidence SET scope_evidence_key='"+key(99)+"' WHERE evidence_key='"+key(50)+"'",/film_identity_evidence_append_only/);
}

// ===== 3. the control tables: absent = off, history and control inseparable, compare-and-swap, append-only, no REPLACE bypass =====
const change=(over={})=>{
 const row={writer:'discovery_decision',kind:'activate',from_state:'off',to_state:'pending',generation:1,reason:'activation',deployed_version:'abc123',evidence_link:'https://trello.com/c/x',drain_evidence:null,break_from:null,recorded_at:AT,...over};
 const columns=['writer','kind','from_state','to_state','generation','reason','deployed_version','evidence_link','drain_evidence','break_from','recorded_at'];
 return 'INSERT INTO identity_evidence_writer_change ('+columns.join(',')+') VALUES ('+columns.map(column=>lit(row[column])).join(',')+')';
};
const control=(over={})=>{const row={writer:'discovery_decision',state:'pending',generation:1,coverage_from:null,updated_at:AT,...over};
 return 'INSERT INTO identity_evidence_writer (writer,state,generation,coverage_from,updated_at) VALUES ('+['writer','state','generation','coverage_from','updated_at'].map(column=>lit(row[column])).join(',')+')';};
const writerRow=(file,writer='discovery_decision')=>rows(file,"SELECT writer,state,generation,coverage_from,updated_at FROM identity_evidence_writer WHERE writer='"+writer+"'")[0]||null;
const DRAIN={kind:'drain_complete',from_state:'pending',to_state:'on',generation:2,drain_evidence:'one deployment at 100%',recorded_at:iso(1000)};
const OFF3={kind:'break',from_state:'on',to_state:'off',generation:3,reason:'rollback',break_from:iso(2000),recorded_at:iso(3000)};
{
 const file=copy(template);
 // The control row can never be written on its own: not an insert, not an update.
 refused(file,control(),/identity_evidence_writer_transition/);
 refused(file,"INSERT OR REPLACE INTO identity_evidence_writer (writer,state,generation,coverage_from,updated_at) VALUES ('discovery_decision','on',2,'"+AT+"','"+AT+"')",/identity_evidence_writer_transition/);
 // A change row that does not start from the writer's current state, or skips a generation, is refused.
 refused(file,change({from_state:'pending'}),/identity_evidence_writer_change_stale|CHECK constraint failed/);
 refused(file,change({generation:2}),/identity_evidence_writer_change_stale/);
 refused(file,change({kind:'drain_complete',from_state:'pending',to_state:'on',drain_evidence:'proof'}),/identity_evidence_writer_change_stale/);
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_writer_change'),0,'a refused change leaves no orphan');
 // The change row ALONE does everything: it inserts the control row (history and control are inseparable).
 ok(file,change());
 assert.deepEqual(writerRow(file),{writer:'discovery_decision',state:'pending',generation:1,coverage_from:null,updated_at:AT});
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_writer_change'),1);
 // A control update on its own is refused, even to the next generation, even with a change row of ANOTHER generation or writer in history.
 refused(file,"UPDATE identity_evidence_writer SET state='on',generation=2,coverage_from='"+iso(1000)+"',updated_at='"+iso(1000)+"' WHERE writer='discovery_decision'",/identity_evidence_writer_transition/);
 // A second change row for the same writer and generation (a duplicate or an orphan waiting for its control update) cannot accumulate: the writer/generation is unique.
 refused(file,change({recorded_at:iso(5)}),/identity_evidence_writer_change_(taken|stale)|UNIQUE/);
 refused(file,change({kind:'deactivate',from_state:'pending',to_state:'off',generation:1,reason:'other'}),/identity_evidence_writer_change_(taken|stale)|UNIQUE|CHECK/);
 // Missing drain evidence and a malformed transition are refused.
 refused(file,change({...DRAIN,drain_evidence:null}),/CHECK constraint failed|identity_evidence_writer_change_stale/);
 ok(file,change(DRAIN));
 assert.deepEqual(writerRow(file),{writer:'discovery_decision',state:'on',generation:2,coverage_from:iso(1000),updated_at:iso(1000)},'coverage starts at the pending -> on flip, not at activation');
 // Illegal transitions and shapes.
 const illegal=/CHECK constraint failed|identity_evidence_writer_change_(stale|taken)|UNIQUE/;
 refused(file,change({kind:'activate',from_state:'on',to_state:'pending',generation:3}),illegal);
 refused(file,change({kind:'deactivate',from_state:'on',to_state:'off',generation:3,break_from:iso(10)}),illegal);
 refused(file,change({kind:'break',from_state:'on',to_state:'off',generation:3}),illegal);
 refused(file,change({kind:'deactivate',from_state:'off',to_state:'on',generation:3}),illegal);
 refused(file,change({kind:'deactivate',from_state:'on',to_state:'off',generation:3,reason:''}),illegal);
 refused(file,change({kind:'deactivate',from_state:'on',to_state:'off',generation:3,evidence_link:''}),illegal);
 refused(file,change({writer:'unknown_writer'}),illegal);
 // Direct writes of the control row stay refused after the history exists.
 refused(file,"UPDATE identity_evidence_writer SET coverage_from='"+iso(5)+"' WHERE writer='discovery_decision'",/identity_evidence_writer_transition/);
 refused(file,"UPDATE identity_evidence_writer SET writer='discovery_owner' WHERE writer='discovery_decision'",/identity_evidence_writer_transition/);
 refused(file,"UPDATE identity_evidence_writer SET state='pending',generation=1,coverage_from=NULL,updated_at='"+AT+"' WHERE writer='discovery_decision'",/identity_evidence_writer_transition/);
 refused(file,"DELETE FROM identity_evidence_writer",/identity_evidence_writer_no_delete/);
 // The REPLACE bypass of SQLite (a conflict policy deletes the old row without a DELETE trigger while recursive triggers are off) cannot reset the control row to its
 // original generation-1 values, nor erase or rewrite the history, with recursive_triggers OFF (the default) or ON.
 for(const recursive of ['OFF','ON']){
  const pragma='PRAGMA recursive_triggers='+recursive+';';
  const before=JSON.stringify([writerRow(file),rows(file,'SELECT * FROM identity_evidence_writer_change ORDER BY seq')]);
  for(const verb of ['INSERT OR REPLACE','REPLACE','INSERT OR IGNORE','INSERT OR ABORT']){
   const reset=control().replace(/^INSERT/,verb);
   refused(file,pragma+reset,/identity_evidence_writer_transition/);
  }
  refused(file,pragma+control()+" ON CONFLICT(writer) DO UPDATE SET state='pending',generation=1,coverage_from=NULL",/identity_evidence_writer_transition/);
  // REPLACE of an existing change seq, or of an existing writer/generation, with a transition that would otherwise be valid for ANOTHER writer.
  refused(file,pragma+change({writer:'discovery_owner'}).replace(/^INSERT INTO identity_evidence_writer_change \(/,'INSERT OR REPLACE INTO identity_evidence_writer_change (seq,').replace('VALUES (','VALUES (1,'),/identity_evidence_writer_change_(taken|stale)/);
  refused(file,pragma+change(OFF3).replace(/^INSERT/,'INSERT OR REPLACE').replace(/^INSERT OR REPLACE INTO identity_evidence_writer_change \(/,'INSERT OR REPLACE INTO identity_evidence_writer_change (seq,').replace('VALUES (','VALUES (2,'),/identity_evidence_writer_change_(taken|stale)/);
  refused(file,pragma+change(DRAIN).replace(/^INSERT/,'INSERT OR REPLACE'),/identity_evidence_writer_change_(taken|stale)/);
  refused(file,pragma+change(DRAIN)+" ON CONFLICT(writer,generation) DO UPDATE SET reason='rewritten'",/identity_evidence_writer_change_(taken|stale)/);
  refused(file,pragma+"UPDATE identity_evidence_writer_change SET reason='edited'",/identity_evidence_writer_change_append_only/);
  refused(file,pragma+"DELETE FROM identity_evidence_writer_change",/identity_evidence_writer_change_append_only/);
  assert.equal(JSON.stringify([writerRow(file),rows(file,'SELECT * FROM identity_evidence_writer_change ORDER BY seq')]),before,'recursive_triggers='+recursive+': control and history are untouched by every bypass attempt');
 }
 // A break from `on`, then a later activation starts again at the first step, with history kept and every generation exactly once.
 ok(file,change(OFF3));
 assert.deepEqual(writerRow(file),{writer:'discovery_decision',state:'off',generation:3,coverage_from:null,updated_at:iso(3000)});
 ok(file,change({generation:4,recorded_at:iso(4000)}));
 assert.deepEqual(writerRow(file),{writer:'discovery_decision',state:'pending',generation:4,coverage_from:null,updated_at:iso(4000)});
 assert.deepEqual(rows(file,'SELECT writer,generation FROM identity_evidence_writer_change ORDER BY seq'),[1,2,3,4].map(generation=>({writer:'discovery_decision',generation})),'one immutable transition per generation');
 // Writers are independent: one writer's row says nothing about another's.
 ok(file,change({writer:'discovery_owner'}));
 assert.deepEqual(rows(file,'SELECT writer,state FROM identity_evidence_writer ORDER BY writer'),[{writer:'discovery_decision',state:'pending'},{writer:'discovery_owner',state:'pending'}]);
 // The control row always equals the last recorded transition (the invariant the triggers keep).
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_writer AS w WHERE w.generation <> (SELECT MAX(generation) FROM identity_evidence_writer_change AS c WHERE c.writer = w.writer) OR w.state <> (SELECT to_state FROM identity_evidence_writer_change AS c WHERE c.writer = w.writer AND c.generation = w.generation)'),0);
}

// ===== 4. the operator (src/identity-evidence-writer.js changeWriter) =====
const OPERATION={reason:'owner-approved activation',deployedVersion:'7d8d4b3',evidenceLink:'https://trello.com/c/t35hqplw#activation'};
{
 // A schema without the control tables: every writer reads `off`, and the operator refuses (the migration is card ECM).
 const old=copy(template40);
 const oldEnv=envOf(old);
 assert.equal(await identityEvidenceControlStatus(oldEnv),'absent');
 assert.deepEqual(await readWriter(oldEnv,'discovery_decision'),{writer:'discovery_decision',state:'off',generation:0,coverageFrom:null,updatedAt:null,present:false});
 assert.deepEqual(await readWriterChanges(oldEnv,'discovery_decision'),[]);
 await assert.rejects(()=>changeWriter(oldEnv,{writer:'discovery_decision',kind:'activate',expectedGeneration:0,...OPERATION,now:AT}),code('identity_evidence_writer_unavailable'));
 // A damaged schema is not "no control": a control table without its sibling fails closed.
 const damaged=copy(template);
 ok(damaged,'DROP TABLE identity_evidence_writer_change');
 await assert.rejects(()=>identityEvidenceControlStatus(envOf(damaged)),code('film_person_unavailable'));

 const file=copy(template);
 const env=envOf(file);
 assert.equal(await identityEvidenceControlStatus(env),'ready');
 for(const writer of WRITERS)assert.equal((await readWriter(env,writer)).state,'off',writer+' has no row: off');
 await assert.rejects(()=>readWriter(env,'not_a_writer'),code('identity_evidence_writer_invalid'));
 const w='discovery_decision';
 const step=(over={})=>changeWriter(env,{writer:w,...OPERATION,now:iso(0),...over});
 // Refused before any statement.
 for(const [over,reason] of [[{kind:'bogus',expectedGeneration:0},'kind'],[{kind:'activate'},'expected_generation'],[{kind:'activate',expectedGeneration:-1},'expected_generation'],
  [{kind:'activate',expectedGeneration:0,reason:''},'reason'],[{kind:'activate',expectedGeneration:0,deployedVersion:''},'deployed_version'],[{kind:'activate',expectedGeneration:0,evidenceLink:''},'evidence_link'],
  [{kind:'drain_complete',expectedGeneration:1},'drain_evidence'],[{kind:'drain_complete',expectedGeneration:1,drainEvidence:'  '},'drain_evidence'],[{kind:'activate',expectedGeneration:0,drainEvidence:'x'},'drain_evidence'],
  [{kind:'break',expectedGeneration:1},'break_from'],[{kind:'break',expectedGeneration:1,breakFrom:iso(99999)},'break_from'],[{kind:'activate',expectedGeneration:0,breakFrom:iso(-1)},'break_from']]){
  await assert.rejects(()=>step(over),error=>error.code==='identity_evidence_writer_invalid'&&error.reason===reason,JSON.stringify(over));
 }
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_writer_change'),0,'nothing was written by a refused call');
 // A transition the state does not allow.
 await assert.rejects(()=>step({kind:'drain_complete',expectedGeneration:0,drainEvidence:'proof'}),code('identity_evidence_writer_transition'));
 await assert.rejects(()=>step({kind:'deactivate',expectedGeneration:0}),code('identity_evidence_writer_transition'));
 // off -> pending: the first activation; a repeat is a no-op at the same generation.
 const first=await step({kind:'activate',expectedGeneration:0});
 assert.deepEqual([first.noop,first.from,first.state,first.generation,first.coverageFrom],[false,'off','pending',1,null]);
 const repeat=await step({kind:'activate',expectedGeneration:1,now:iso(500)});
 assert.deepEqual([repeat.noop,repeat.state,repeat.generation],[true,'pending',1]);
 assert.equal((await readWriterChanges(env,w)).length,1,'a repeated off -> pending writes nothing');
 // A stale generation (a compare-and-swap race: the operator read generation 0 but the writer is at 1) writes nothing.
 await assert.rejects(()=>step({kind:'activate',expectedGeneration:0}),code('identity_evidence_writer_stale'));
 await assert.rejects(()=>step({kind:'deactivate',expectedGeneration:0}),code('identity_evidence_writer_stale'));
 // Two operators from the same generation: only one lands.
 const results=await Promise.allSettled([step({kind:'drain_complete',expectedGeneration:1,drainEvidence:'deployment 7d8d4b3 at 100%; no older Workflow instance running',now:iso(1000)}),
  step({kind:'deactivate',expectedGeneration:1,reason:'interrupted activation',now:iso(1000)})]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1,'exactly one of two racing transitions lands');
 const loser=results.find(result=>result.status==='rejected');
 assert.ok(['identity_evidence_writer_stale','identity_evidence_writer_unavailable','identity_evidence_writer_transition'].includes(loser.reason.code),String(loser.reason.stack));
 const state=await readWriter(env,w);
 assert.equal(state.generation,2);
 assert.equal((await readWriterChanges(env,w)).length,2);
 // Walk the whole life of one writer on a second writer, so the result does not depend on the race above.
 const o='discovery_owner';
 const own=(over={})=>changeWriter(env,{writer:o,...OPERATION,now:iso(0),...over});
 await own({kind:'activate',expectedGeneration:0,now:iso(0)});
 // Recovery of a pending left by an interrupted activation: pending -> off, with the reason kept; then activation starts again at step 1.
 const recovered=await own({kind:'deactivate',expectedGeneration:1,reason:'interrupted activation, no drain evidence',now:iso(100)});
 assert.deepEqual([recovered.from,recovered.state,recovered.generation,recovered.coverageFrom],['pending','off',2,null]);
 await own({kind:'activate',expectedGeneration:2,now:iso(200)});
 const on=await own({kind:'drain_complete',expectedGeneration:3,drainEvidence:'deployment 7d8d4b3 at 100%; no Discovery Workflow instance of an older version',now:iso(300)});
 assert.deepEqual([on.state,on.generation,on.coverageFrom],['on',4,iso(300)],'coverage starts at the flip');
 await assert.rejects(()=>own({kind:'activate',expectedGeneration:4}),code('identity_evidence_writer_transition'));
 // A rollback to a version without the writer: the operator records the break from the deployment history and the writer goes off; history stays.
 const broken=await own({kind:'break',expectedGeneration:4,reason:'rollback to a version without the writer',breakFrom:iso(250),now:iso(400)});
 assert.deepEqual([broken.from,broken.state,broken.generation,broken.coverageFrom],['on','off',5,null]);
 const log=await readWriterChanges(env,o);
 assert.deepEqual(log.map(entry=>[entry.kind,entry.from_state,entry.to_state,entry.generation]),[['activate','off','pending',1],['deactivate','pending','off',2],['activate','off','pending',3],['drain_complete','pending','on',4],['break','on','off',5]]);
 assert.equal(log[4].break_from,iso(250));
 assert.equal(log[3].drain_evidence.startsWith('deployment 7d8d4b3'),true);
 assert.ok(log.every(entry=>entry.deployed_version==='7d8d4b3'&&entry.evidence_link===OPERATION.evidenceLink),'every transition records the version and the evidence link');
 assert.equal((await readWriter(env,o)).state,'off');
 assert.deepEqual([...CHANGE_KINDS],['activate','drain_complete','deactivate','break']);
}

// ===== 5. the pure model: key, known_alias, strength, domain plans =====
const OBS='the matrix|1999';
const decision=(over={})=>({subject:{kind:'discovery_observation',value:OBS},relation:'candidate_for',object:{kind:'tmdb_movie',value:'603'},polarity:'asserts',route:'discovery_scan',method:'tmdb_detail_check',sourceRoot:OBS,sourceRef:'chunk:1',observedAt:AT,...over});
const known=(scope,over={})=>decision({method:'known_alias',sourceScope:scope,...over});
const owner=(over={})=>decision({route:'owner_action',method:'owner_statement',sourceRoot:'intent-1',sourceOrder:4,...over});
{
 assert.equal(METHODS.includes('known_alias'),true);
 // The key helper is unchanged: the pinned formula of E1, and `source_order` is not part of it.
 const row=normalizeEvidence(decision());
 const pinned='{"method":"tmdb_detail_check","object":["tmdb_movie","603"],"polarity":"asserts","reconstructedFrom":null,"relation":"candidate_for","root":"'+OBS+'","route":"discovery_scan","scope":null,"scopeEvidenceKey":null,"subject":["discovery_observation","'+OBS+'"],"supersedesKey":null,"v":1}';
 assert.equal(await evidenceKeyOf(row),crypto.createHash('sha256').update(pinned).digest('hex'),'the key formula is unchanged');
 assert.equal(await evidenceKeyOf(owner({sourceOrder:4})),await evidenceKeyOf(owner({sourceOrder:9})),'source_order is not part of the key');
 assert.equal(normalizeEvidence(owner()).sourceOrder,4);
 assert.equal(normalizeEvidence(decision()).sourceOrder,null);
 // The two known-alias variants are distinct rows (their scope is in the key) and neither collides with a detail check.
 const keys=new Set([await evidenceKeyOf(decision()),await evidenceKeyOf(known('known_epg_alias')),await evidenceKeyOf(known('known_alias_year_runtime'))]);
 assert.equal(keys.size,3);
 // source_order: a positive safe integer, owner rows only.
 for(const bad of [0,-1,1.5,'3',Number.MAX_SAFE_INTEGER+2])assert.throws(()=>normalizeEvidence(owner({sourceOrder:bad})),error=>error.reason==='source_order',String(bad));
 assert.throws(()=>normalizeEvidence(decision({sourceOrder:1})),error=>error.reason==='source_order');
 // Strength (ADR 0215 Q1-a): known_epg_alias with title_only, known_alias_year_runtime with title_year, an unknown scope never higher than title_only, never proof.
 const tier=(method,sourceScope=null)=>evidenceStrength({method,sourceScope});
 assert.deepEqual(tier('known_alias','known_epg_alias'),tier('title_only'));
 assert.deepEqual(tier('known_alias','known_alias_year_runtime'),tier('title_year'));
 for(const scope of [null,undefined,'','mystery','known_epg_alias '])assert.deepEqual(tier('known_alias',scope),tier('title_only'),'an unknown scope ranks with title_only: '+JSON.stringify(scope));
 assert.equal(evidenceStrength({method:'known_alias'}).rank,1);
 const ranks=['title_year_search','title_only','title_year','page_check','owner_statement'].map(method=>tier(method).rank);
 assert.deepEqual(ranks,[...ranks].sort((a,b)=>a-b),'the ranking is monotone: search < title_only < title_year < verified < owner');
 assert.deepEqual([tier('tmdb_detail_check').rank,tier('alias_bridge').rank,tier('page_check').rank],[3,3,3]);
 for(const method of ['known_alias','title_only','title_year','title_year_search'])assert.equal(tier(method,'known_alias_year_runtime').proof,false,method+' is never proof');
 for(const method of ['page_check','tmdb_detail_check','alias_bridge','owner_statement'])assert.equal(tier(method).proof,true);
 assert.throws(()=>evidenceStrength({method:'nope'}),error=>error.reason==='method');
 // Domain plans.
 const plan=await planDomainEvidence('discovery_decision',decision());
 assert.equal(plan.writer,'discovery_decision');
 assert.equal(plan.evidenceKey,await evidenceKeyOf(decision()));
 assert.equal((await planDomainEvidence('discovery_decision',known('known_epg_alias'))).row.method,'known_alias');
 assert.equal((await planDomainEvidence('discovery_decision',decision({object:{kind:'tmdb_tv',value:'1396'}}))).row.objectKind,'tmdb_tv','a decision may name a TV id');
 // ADR 0215 Table 3: nothing else is written by the live planner, however valid the pure model finds it.
 for(const [name,input] of [
  ['a root other than the observation key',decision({sourceRoot:'another root'})],
  ['an unrelated root token',decision({sourceRoot:'run-17'})],
  ['title_only as a standalone row',decision({method:'title_only'})],
  ['title_year as a standalone row',decision({method:'title_year'})],
  ['title_year_search restricts',decision({polarity:'restricts',method:'title_year_search'})],
  ['restricts by a detail check',decision({polarity:'restricts'})],
  ['a detail check with a scope',decision({sourceScope:'known_epg_alias'})],
  ['a known alias without a scope',known(null)],
  ['a refutation by a decision',decision({polarity:'refutes',method:'owner_statement'})],
 ])await assert.rejects(()=>planDomainEvidence('discovery_decision',input),code('identity_evidence_out_of_slice'),name);
 for(const [name,input] of [
  ['owner restricts',owner({polarity:'restricts'})],
  ['owner TV',owner({object:{kind:'tmdb_tv',value:'1396'}})],
  ['owner with a scope',owner({sourceScope:'known_epg_alias'})],
  ['owner by a detail check',owner({method:'tmdb_detail_check'})],
  ['owner with supersession',owner({supersedesKey:key(77)})],
 ])await assert.rejects(()=>planDomainEvidence('discovery_owner',input),code('identity_evidence_out_of_slice'),name);
 assert.equal((await planDomainEvidence('discovery_owner',owner())).row.sourceOrder,4);
 assert.equal((await planDomainEvidence('discovery_owner',owner({polarity:'refutes',scopeEvidenceKey:key(99)}))).row.scopeEvidenceKey,key(99));
 const out=async(writer,input)=>assert.rejects(()=>planDomainEvidence(writer,input),code('identity_evidence_out_of_slice'));
 await out('claim_alias_bridge',decision());
 await out('tmdb_retirement_decision',owner());
 await out('discovery_decision',owner());
 await out('discovery_owner',decision());
 await out('discovery_owner',owner({sourceOrder:undefined}));
 await assert.rejects(()=>planDomainEvidence('discovery_owner',owner({polarity:'restricts',scopeEvidenceKey:key(99)})),code('identity_evidence_invalid'));
 await out('discovery_decision',known('known_epg_alias',{polarity:'restricts'}));
 await out('discovery_decision',known(null));
 await out('discovery_decision',known('mystery'));
 await out('discovery_decision',decision({sourceOrder:2,route:'owner_action',sourceRoot:'intent-1'}));
 await out('discovery_decision',decision({method:'page_check'}));
 await assert.rejects(()=>planDomainEvidence('discovery_decision',decision({polarity:'restricts',method:'tmdb_detail_check',scopeEvidenceKey:key(98)})),code('identity_evidence_invalid'));
 await out('discovery_decision',decision({supersedesKey:key(97)}));
 await out('discovery_decision',decision({subject:{kind:'letterboxd_lid',value:'lid1'},relation:'same_work'}));
 await out('discovery_decision',decision({origin:'reconstruction',reconstructionRun:'run-1',reconstructedFrom:'rec-1'}));
 await assert.rejects(()=>planDomainEvidence('not_a_writer',decision()),code('identity_evidence_writer_invalid'));
 await assert.rejects(()=>planDomainEvidence('discovery_decision',decision({sourceRoot:undefined})),code('identity_evidence_invalid'));
}

// ===== 6. the conditional insert and its assertion inside a domain batch =====
// A domain batch of its own: a domain write (here a stand-in table row), the evidence statements, and the domain's own revision step. The assertion is the Film/Person
// one (`fenced.assertSql`, the default) because the stand-in schema has no Discovery CAS table; the statements are the same ones a Discovery batch appends.
const STATEMENT_CAP=40;
async function domainBatch(env,file,plan,{requestId='req-1',at=AT,mark='m'}={}){
 const statements=[['INSERT INTO schema_probe (note) VALUES (?)',[mark]]];
 const evidence=await domainEvidenceStatements(env,plan,{requestId,at});
 statements.push(...evidence);
 const db=env.DB;
 await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));
 return evidence;
}
const withProbe=file=>{ok(file,'CREATE TABLE IF NOT EXISTS schema_probe (id INTEGER PRIMARY KEY, note TEXT);');return file;};
const ledgerRows=file=>rows(file,'SELECT seq,evidence_key,film_id,route,method,source_scope,source_order,request_id FROM film_identity_evidence ORDER BY seq');
const probe=file=>rows(file,'SELECT note FROM schema_probe ORDER BY id').map(row=>row.note);
const setWriter=async(env,writer,target)=>{
 let generation=(await readWriter(env,writer)).generation;
 const path={off:[],pending:['activate'],on:['activate','drain_complete']}[target];
 for(const kind of path){
  await changeWriter(env,{writer,kind,expectedGeneration:generation,...OPERATION,drainEvidence:kind==='drain_complete'?'one deployment at 100%, no older instance running':undefined,now:iso(1000+generation)});
  generation+=1;
 }
};
{
 const plan=await planDomainEvidence('discovery_decision',decision());
 // A schema without the control tables: the writer reads as off and writes no row, but the helper still returns ONE commit-time guard (never an empty list), and the domain
 // write is otherwise unchanged.
 {
  const file=withProbe(copy(template40));const env=envOf(file);
  const statements=await domainEvidenceStatements(env,plan,{requestId:'req-1',at:AT});
  assert.equal(statements.length,1,'one guard statement, never nothing');
  assert.ok(statements[0][0].includes(ABSENT),'the guard asserts the control tables are still absent at commit');
  await domainBatch(env,file,plan);
  assert.deepEqual(probe(file),['m']);
  assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),0);
 }
 // The pre-ECM interleaving (ADR 0215 decision 4; the gap closed by the commit-time guard): a batch is PREPARED while the schema is absent, ECM then applies 0042 and the writer is
 // activated and drained to `on`, and only then does the delayed batch commit. Without the guard it would commit its domain step with no row inside a claimed coverage
 // interval. With it the batch fails whole (nothing of the domain step lands), and the replan, which reads the schema again, writes the row.
 {
  const file=withProbe(copy(template40));const env=envOf(file);
  const prepared=await domainEvidenceStatements(env,plan,{requestId:'late',at:AT});
  ok(file,read(NEW));
  await setWriter(env,'discovery_decision','on');
  const db=env.DB;
  await assert.rejects(()=>db.batch([['INSERT INTO schema_probe (note) VALUES (?)',['delayed']],...prepared].map(([sql,params])=>db.prepare(sql).bind(...params))),/CHECK constraint failed/);
  assert.deepEqual(probe(file),[],'the delayed pre-ECM batch committed nothing');
  assert.deepEqual(ledgerRows(file),[]);
  await domainBatch(env,file,plan,{requestId:'replanned',mark:'replanned'});
  assert.deepEqual(probe(file),['replanned']);
  assert.equal(ledgerRows(file).length,1,'the replan carries the insert and its row');
  assert.equal(ledgerRows(file)[0].request_id,'replanned');
 }
 // Absent and `off`: no row, the domain write is unchanged, the assertion passes.
 for(const state of ['absent','off']){
  const file=withProbe(copy(template));const env=envOf(file);
  if(state==='off'){await setWriter(env,'discovery_decision','pending');await changeWriter(env,{writer:'discovery_decision',kind:'deactivate',expectedGeneration:1,...OPERATION,now:iso(50)});}
  const evidence=await domainBatch(env,file,plan);
  assert.equal(evidence.length,2,'an insert and an assertion');
  assert.deepEqual(ledgerRows(file),[],state+': no row');
  assert.deepEqual(probe(file),['m'],state+': the domain write committed');
 }
 // `pending` and `on`: the row is written, unbound, with the batch's request id; a repeat (a valid duplicate) writes nothing and passes.
 for(const state of ['pending','on']){
  const file=withProbe(copy(template));const env=envOf(file);
  await setWriter(env,'discovery_decision',state);
  await domainBatch(env,file,plan,{requestId:'req-1'});
  const [row]=ledgerRows(file);
  assert.equal(ledgerRows(file).length,1);
  assert.deepEqual([row.evidence_key,row.film_id,row.route,row.method,row.request_id],[plan.evidenceKey,null,'discovery_scan','tmdb_detail_check','req-1'],state);
  await domainBatch(env,file,plan,{requestId:'req-2',mark:'again'});
  assert.equal(ledgerRows(file).length,1,state+': a valid duplicate writes nothing');
  assert.equal(ledgerRows(file)[0].seq,row.seq);
  assert.equal(ledgerRows(file)[0].request_id,'req-1','the first writer of the key keeps it');
  assert.deepEqual(probe(file),['m','again'],state+': the duplicate batch still commits its domain write');
 }
// A reconstructed row with a KNOWN root is the same identity as a live check of that key: reconstruction provenance is not identity (ADR 0215 decisions 1 and 7), for both writers.
 for(const [writer,input,order] of [['discovery_decision',decision(),null],['discovery_owner',owner({sourceOrder:4}),4]]){
  const file=withProbe(copy(template));const env=envOf(file);
  await setWriter(env,writer,'on');
  const rooted=await planDomainEvidence(writer,input);
  const r=rooted.row;
  ok(file,"INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,scope_evidence_key,supersedes_key,observed_at,origin,reconstruction_run,reconstructed_from,request_id,recorded_at,source_order) VALUES ('"+rooted.evidenceKey+"',NULL,'"+r.subjectKind+"','"+r.subjectValue+"','"+r.relation+"','"+r.objectKind+"','"+r.objectValue+"','"+r.polarity+"','"+r.route+"','"+r.method+"','"+r.sourceRoot+"',NULL,"+(r.sourceScope?"'"+r.sourceScope+"'":'NULL')+",NULL,NULL,'"+AT+"','reconstruction','run-1','record-1','imp-1','"+AT+"',"+(order===null?'NULL':order)+")");
  await domainBatch(env,file,rooted,{requestId:'live-1',mark:'live'});
  assert.deepEqual(probe(file),['live'],writer+': the live batch commits beside a reconstructed row of the same rooted key');
  assert.equal(ledgerRows(file).length,1);
  assert.equal(one(file,'SELECT origin FROM film_identity_evidence'),'reconstruction','the existing row is not changed');
 }
 // A mismatching row under the same key rolls the whole batch back: another method, scope, source order or root.
 {
  const file=withProbe(copy(template));const env=envOf(file);
  await setWriter(env,'discovery_owner','on');
  const first=await planDomainEvidence('discovery_owner',owner({sourceOrder:4}));
  await domainBatch(env,file,first,{requestId:'o-1'});
  assert.equal(ledgerRows(file)[0].source_order,4);
  // The same key with the same source order: a valid duplicate.
  await domainBatch(env,file,await planDomainEvidence('discovery_owner',owner({sourceOrder:4})),{requestId:'o-2',mark:'dup'});
  // The same key with another causal position: a mismatch (the key does not include source_order).
  const moved=await planDomainEvidence('discovery_owner',owner({sourceOrder:5}));
  await assert.rejects(()=>domainBatch(env,file,moved,{requestId:'o-3',mark:'moved'}),/CHECK constraint failed/);
  assert.deepEqual(probe(file),['m','dup'],'the batch with the mismatching row wrote nothing of its own');
  assert.equal(ledgerRows(file).length,1);
  assert.equal(ledgerRows(file)[0].source_order,4,'the stored row is untouched');
  // A row planted under the key with another identity (as if a different writer had landed first): the assertion catches every identity column.
  for(const [column,value] of [['source_scope','known_epg_alias'],['method','tmdb_detail_check'],['polarity','restricts'],['source_root','other'],['object_value','604']]){
   const other=copy(template);const otherEnv=envOf(other);withProbe(other);
   await setWriter(otherEnv,'discovery_owner','on');
   // Build the stored row by hand, then plan the owner row whose key it carries.
   const real=await planDomainEvidence('discovery_owner',owner({sourceOrder:4}));
   const stored={evidence_key:real.evidenceKey,film_id:null,subject_kind:'discovery_observation',subject_value:OBS,relation:'candidate_for',object_kind:'tmdb_movie',object_value:'603',polarity:'asserts',route:'owner_action',method:'owner_statement',
    source_root:'intent-1',source_ref:null,source_scope:null,scope_evidence_key:null,supersedes_key:null,observed_at:AT,origin:'live',reconstruction_run:null,reconstructed_from:null,request_id:'x',recorded_at:AT,source_order:4,[column]:value};
   ok(other,'INSERT INTO film_identity_evidence ('+COLUMNS.join(',')+') VALUES ('+COLUMNS.map(name=>lit(stored[name])).join(',')+')');
   await assert.rejects(()=>domainBatch(otherEnv,other,real,{requestId:'o-9',mark:'z'}),/CHECK constraint failed/,column);
   assert.deepEqual(probe(other),[],column+': rolled back');
  }
 }
 // AIR-619 review: a stored row of the same key whose provenance is a RECONSTRUCTION (known root, non-null reconstructed_from) is semantically equivalent to a live plan with that
 // root, not a collision, when the causal position is equal; a different source_order still collides. The first row stays immutable (never promoted to live).
 {
  const file=withProbe(copy(template));const env=envOf(file);
  await setWriter(env,'discovery_owner','on');
  const real=await planDomainEvidence('discovery_owner',owner({sourceOrder:4}));
  const stored={evidence_key:real.evidenceKey,film_id:null,subject_kind:'discovery_observation',subject_value:OBS,relation:'candidate_for',object_kind:'tmdb_movie',object_value:'603',polarity:'asserts',route:'owner_action',method:'owner_statement',
   source_root:'intent-1',source_ref:null,source_scope:null,scope_evidence_key:null,supersedes_key:null,observed_at:AT,origin:'reconstruction',reconstruction_run:'run-1',reconstructed_from:'rec-1',request_id:'import',recorded_at:AT,source_order:4};
  ok(file,'INSERT INTO film_identity_evidence ('+COLUMNS.join(',')+') VALUES ('+COLUMNS.map(name=>lit(stored[name])).join(',')+')');
  await domainBatch(env,file,real,{requestId:'live-1',mark:'equal'});
  assert.deepEqual(probe(file),['equal'],'equal source order: a valid duplicate, the domain step commits');
  assert.equal(ledgerRows(file).length,1,'no second row');
  assert.equal(one(file,'SELECT origin FROM film_identity_evidence'),'reconstruction','the first matching row is never promoted to live');
  const unequal=await planDomainEvidence('discovery_owner',owner({sourceOrder:5}));
  await assert.rejects(()=>domainBatch(env,file,unequal,{requestId:'live-2',mark:'unequal'}),/CHECK constraint failed/);
  assert.deepEqual(probe(file),['equal'],'unequal source order: a collision, the batch rolled back');
  }
 // A key first inserted before an interval and committed again inside it gets no new row (coverage is per key, not per occurrence).
 {
  const file=withProbe(copy(template));const env=envOf(file);
  await setWriter(env,'discovery_decision','pending');
  await domainBatch(env,file,plan,{requestId:'before'});
  await changeWriter(env,{writer:'discovery_decision',kind:'drain_complete',expectedGeneration:1,...OPERATION,drainEvidence:'drained',now:iso(5000)});
  await domainBatch(env,file,plan,{requestId:'inside',mark:'again'});
  assert.equal(ledgerRows(file).length,1);
  assert.equal(ledgerRows(file)[0].request_id,'before');
 }
 // An off/on flip racing a domain batch: the insert and the assertion read the control row in one transaction, so the batch is either fully covered or fully silent.
 {
  const file=withProbe(copy(template));const env=envOf(file);
  const racing=await Promise.allSettled([domainBatch(env,file,plan,{requestId:'race'}),setWriter(env,'discovery_decision','pending')]);
  assert.equal(racing[0].status,'fulfilled',String(racing[0].reason?.stack));
  const rowsAfter=ledgerRows(file).length;
  assert.ok(rowsAfter===0||rowsAfter===1,'covered or silent, never torn: '+rowsAfter);
  assert.deepEqual(probe(file),['m']);
 }
 // A previous-version batch (no evidence statements) commits during `pending`: no row, and no coverage is claimed (coverage starts at the flip).
 {
  const file=withProbe(copy(template));const env=envOf(file);
  await setWriter(env,'discovery_decision','pending');
  await env.DB.batch([env.DB.prepare('INSERT INTO schema_probe (note) VALUES (?)').bind('old-version')]);
  assert.deepEqual(ledgerRows(file),[]);
  assert.equal((await readWriter(env,'discovery_decision')).coverageFrom,null);
 }
 // Each writer is gated by its own control row.
 {
  const file=withProbe(copy(template));const env=envOf(file);
  await setWriter(env,'discovery_owner','on');
  await domainBatch(env,file,plan,{requestId:'decision-while-owner-on'});
  assert.deepEqual(ledgerRows(file),[],'the decision writer is off although the owner writer is on');
  await domainBatch(env,file,await planDomainEvidence('discovery_owner',owner()),{requestId:'owner',mark:'owner'});
  assert.equal(ledgerRows(file).length,1);
 }
 // Budgets: two statements per row, inside the Discovery statement cap and D1's 100 binds per statement, on the covered and the new-row path.
 {
  const statements=await domainEvidenceStatements(envOf(copy(template)),plan,{requestId:'req-1',at:AT});
  assert.equal(statements.length,2);
  for(const [sql,params] of statements){
   assert.ok(params.length<100,'binds per statement: '+params.length);
   assert.equal((sql.match(/\?/g)||[]).length,params.length,'placeholders match binds');
  }
  assert.ok(6+2+2<=STATEMENT_CAP&&8+4<=STATEMENT_CAP,'the largest batches of ADR 0215 decision 1 fit the cap');
  const ownerStatements=await domainEvidenceStatements(envOf(copy(template)),await planDomainEvidence('discovery_owner',owner()),{requestId:'req-1',at:AT});
  for(const [sql,params] of ownerStatements)assert.equal((sql.match(/\?/g)||[]).length,params.length);
  await assert.rejects(()=>domainEvidenceStatements(envOf(copy(template)),plan,{requestId:'',at:AT}),code('identity_evidence_writer_invalid'));
  await assert.rejects(()=>domainEvidenceStatements(envOf(copy(template)),plan,{requestId:'r',at:'yesterday'}),code('identity_evidence_writer_invalid'));
  await assert.rejects(()=>domainEvidenceStatements(envOf(copy(template)),{writer:'discovery_decision',row:plan.row,evidenceKey:'x'},{requestId:'r',at:AT}),code('identity_evidence_out_of_slice'));
 }
}

// ===== 7. dormant: only the Discovery writers (E2a decision, E2c owner) import the helper, nothing calls the operator, nothing reads the ledger or the control =====
// AIR-619 (E2c): `src/discovery-owner-evidence.js` builds the owner statements; `src/discovery-authority.js` reads the control row of `discovery_owner`.
{
 const sources=fs.readdirSync('src',{recursive:true}).filter(name=>String(name).endsWith('.js')).map(name=>path.join('src',String(name)));
 const mentions=sources.filter(name=>/identity_evidence_writer/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(mentions,['src/discovery-owner-evidence.js','src/identity-evidence-writer.js'],'no other module reads or writes the control tables');
 const importers=sources.filter(name=>/from\s+['"]\.{1,2}\/(?:[\w-]+\/)*identity-evidence-writer\.js['"]/.test(fs.readFileSync(name,'utf8')));
 // E2a/E2c (the Discovery writers) and E2b (the ADR 0184 claim unit, canonical-path bridge row) are the only importers; no route, Workflow, cron or other producer imports the writer control.
 assert.deepEqual(importers,['src/canonical-letterboxd-claim.js','src/discovery-authority.js','src/discovery-owner-evidence.js','src/letterboxd-lid-attach.js'],'only the Discovery writers (E2a decision, E2c owner) and the claim unit (E2b) import the writer helpers');
 assert.match(fs.readFileSync('src/canonical-letterboxd-claim.js','utf8'),/import \{claimBridgeEvidence\} from '\.\/identity-evidence-writer\.js';/,'the claim unit imports only the bridge row helper');
 const operator=sources.filter(name=>name!=='src/identity-evidence-writer.js'&&/\bchangeWriter\b/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(operator,[],'nothing in the Worker calls the activation/break operator: no row of any writer is ever flipped by code');
 assert.ok(!/changeWriter/.test(fs.readFileSync('build.mjs','utf8')+fs.readFileSync('scripts/bundle-scope.mjs','utf8').replace(/\/\/.*$/gm,'')),'the bundle hands the operator to nothing');
 assert.ok(!fs.readFileSync('build.mjs','utf8').includes('identity-evidence-import'),'the Worker bundle does not include the import path');
 // The migration is a file only: no code applies it, and the deploy workflow never applies a migration.
 for(const workflow of fs.readdirSync('.github/workflows')){
  assert.ok(!/migrations\s+apply|d1\s+execute|0042_identity/.test(fs.readFileSync('.github/workflows/'+workflow,'utf8')),workflow+' does not apply 0042');
 }
}
console.log('identity evidence writer control: ok');
