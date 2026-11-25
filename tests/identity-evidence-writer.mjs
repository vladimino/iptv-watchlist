// AIR-637 / ADR 0215 (Accepted), card EC: migration 0042 (a file only), the writer control and its operator, the ledger's source_order and known_alias, the domain-path
// trigger relaxation and the conditional-insert + assertion helper, on the sqlite3-CLI D1 stand-in. No Worker, R2, network or production access.
// Covered: the migration's refusal and replay; the control tables (absent = off, compare-and-swap, valid transitions, append-only change log, drain evidence, recorded
// breaks); `source_order` and `known_alias`; the domain path (unbound candidate rows only, fenced by the writer's batch, not by the Film/Person marker); the key and strength
// helpers; absent/off/pending/on, a valid duplicate, a mismatching row and a different causal position (all rolling the domain batch back), statement counts, and the
// dormant wiring (no Worker import).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {evidenceKeyOf,evidenceStrength,METHODS,normalizeEvidence} from '../src/identity-evidence.js';
import {CHANGE_KINDS,WRITERS,changeWriter,domainEvidenceStatements,identityEvidenceControlStatus,planDomainEvidence,readWriter,readWriterChanges} from '../src/identity-evidence-writer.js';

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
 assert.deepEqual(added,['index:identity_evidence_writer_change_writer','table:identity_evidence_writer','table:identity_evidence_writer_change','trigger:film_identity_evidence_source_order',
  'trigger:identity_evidence_writer_change_current','trigger:identity_evidence_writer_change_no_delete','trigger:identity_evidence_writer_change_no_update','trigger:identity_evidence_writer_insert',
  'trigger:identity_evidence_writer_no_delete','trigger:identity_evidence_writer_update'].sort());
 assert.deepEqual(names(template40).filter(name=>!names(template).includes(name)),[],'0042 removes no object (the three replaced triggers keep their names)');
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

// ===== 3. the control tables: absent = off, transitions, compare-and-swap, append-only =====
const change=(over={})=>{
 const row={writer:'discovery_decision',kind:'activate',from_state:'off',to_state:'pending',generation:1,reason:'activation',deployed_version:'abc123',evidence_link:'https://trello.com/c/x',drain_evidence:null,break_from:null,recorded_at:AT,...over};
 const columns=['writer','kind','from_state','to_state','generation','reason','deployed_version','evidence_link','drain_evidence','break_from','recorded_at'];
 return 'INSERT INTO identity_evidence_writer_change ('+columns.join(',')+') VALUES ('+columns.map(column=>lit(row[column])).join(',')+')';
};
const control=(over={})=>{const row={writer:'discovery_decision',state:'pending',generation:1,coverage_from:null,updated_at:AT,...over};
 return 'INSERT INTO identity_evidence_writer (writer,state,generation,coverage_from,updated_at) VALUES ('+['writer','state','generation','coverage_from','updated_at'].map(column=>lit(row[column])).join(',')+')';};
{
 const file=copy(template);
 // The control row never appears without its change row, and the change row never claims a state the writer is not in.
 refused(file,control(),/identity_evidence_writer_transition/);
 refused(file,change({from_state:'pending'}),/identity_evidence_writer_change_stale|CHECK constraint failed/);
 refused(file,change({generation:2}),/identity_evidence_writer_change_stale/);
 refused(file,change({kind:'drain_complete',from_state:'pending',to_state:'on',drain_evidence:'proof'}),/identity_evidence_writer_change_stale/);
 ok(file,change()+';'+control());
 assert.deepEqual(rows(file,'SELECT writer,state,generation,coverage_from FROM identity_evidence_writer'),[{writer:'discovery_decision',state:'pending',generation:1,coverage_from:null}]);
 // A change row alone moves nothing in the control row but a control row alone is refused: it needs the change row of this exact generation and time.
 refused(file,"UPDATE identity_evidence_writer SET state='on',generation=2,coverage_from='"+iso(1000)+"',updated_at='"+iso(1000)+"' WHERE writer='discovery_decision'",/identity_evidence_writer_transition/);
 refused(file,change({kind:'drain_complete',from_state:'pending',to_state:'on',generation:2,recorded_at:iso(1000)})+";UPDATE identity_evidence_writer SET state='on',generation=2,coverage_from=NULL,updated_at='"+iso(1000)+"' WHERE writer='discovery_decision'",/CHECK constraint failed/);
 refused(file,change({kind:'drain_complete',from_state:'pending',to_state:'on',generation:2,recorded_at:iso(1000)}),/CHECK constraint failed/);
 ok(file,change({kind:'drain_complete',from_state:'pending',to_state:'on',generation:2,drain_evidence:'one deployment at 100%',recorded_at:iso(1000)})
  +";UPDATE identity_evidence_writer SET state='on',generation=2,coverage_from='"+iso(1000)+"',updated_at='"+iso(1000)+"' WHERE writer='discovery_decision'");
 assert.equal(one(file,"SELECT coverage_from FROM identity_evidence_writer WHERE writer='discovery_decision'"),iso(1000),'coverage starts at the pending -> on flip, not at activation');
 // Illegal transitions and shapes.
 refused(file,change({kind:'activate',from_state:'on',to_state:'pending',generation:3}),/CHECK constraint failed|identity_evidence_writer_change_stale/);
 refused(file,change({kind:'deactivate',from_state:'on',to_state:'off',generation:3,break_from:iso(10)}),/CHECK constraint failed|identity_evidence_writer_change_stale/);
 refused(file,change({kind:'break',from_state:'on',to_state:'off',generation:3}),/CHECK constraint failed|identity_evidence_writer_change_stale/);
 refused(file,change({kind:'deactivate',from_state:'off',to_state:'on',generation:3}),/CHECK constraint failed|identity_evidence_writer_change_stale/);
 refused(file,change({kind:'deactivate',from_state:'on',to_state:'off',generation:3,reason:''}),/CHECK constraint failed|identity_evidence_writer_change_stale/);
 refused(file,change({kind:'deactivate',from_state:'on',to_state:'off',generation:3,evidence_link:''}),/CHECK constraint failed|identity_evidence_writer_change_stale/);
 refused(file,"UPDATE identity_evidence_writer SET coverage_from='"+iso(5)+"' WHERE writer='discovery_decision'",/identity_evidence_writer_transition/);
 refused(file,"UPDATE identity_evidence_writer SET writer='discovery_owner' WHERE writer='discovery_decision'",/identity_evidence_writer_transition/);
 refused(file,"DELETE FROM identity_evidence_writer",/identity_evidence_writer_no_delete/);
 refused(file,"UPDATE identity_evidence_writer_change SET reason='edited'",/identity_evidence_writer_change_append_only/);
 refused(file,"DELETE FROM identity_evidence_writer_change",/identity_evidence_writer_change_append_only/);
 refused(file,change({writer:'unknown_writer'}),/CHECK constraint failed|identity_evidence_writer_change_stale/);
 // `deactivate` then a later activation starts again at the first step, with history kept.
 ok(file,change({kind:'break',from_state:'on',to_state:'off',generation:3,reason:'rollback',break_from:iso(2000),recorded_at:iso(3000)})
  +";UPDATE identity_evidence_writer SET state='off',generation=3,coverage_from=NULL,updated_at='"+iso(3000)+"' WHERE writer='discovery_decision'");
 ok(file,change({generation:4,recorded_at:iso(4000)})+";UPDATE identity_evidence_writer SET state='pending',generation=4,coverage_from=NULL,updated_at='"+iso(4000)+"' WHERE writer='discovery_decision'");
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_writer_change'),4,'every transition is kept');
 // Writers are independent: one writer's row says nothing about another's.
 ok(file,change({writer:'discovery_owner'})+';'+control({writer:'discovery_owner'}));
 assert.deepEqual(rows(file,'SELECT writer,state FROM identity_evidence_writer ORDER BY writer'),[{writer:'discovery_decision',state:'pending'},{writer:'discovery_owner',state:'pending'}]);
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
 assert.equal((await planDomainEvidence('discovery_decision',decision({polarity:'restricts',method:'title_year_search'}))).row.polarity,'restricts');
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
 // A schema without the control tables: the writer reads as off and appends nothing; the domain batch is unchanged.
 {
  const file=withProbe(copy(template40));const env=envOf(file);
  const statements=await domainEvidenceStatements(env,plan,{requestId:'req-1',at:AT});
  assert.deepEqual(statements,[]);
  await domainBatch(env,file,plan);
  assert.deepEqual(probe(file),['m']);
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

// ===== 7. dormant: nothing in the Worker imports the writer control, nothing reads the ledger or the control =====
{
 const sources=fs.readdirSync('src',{recursive:true}).filter(name=>String(name).endsWith('.js')).map(name=>path.join('src',String(name)));
 const mentions=sources.filter(name=>/identity_evidence_writer/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(mentions,['src/identity-evidence-writer.js'],'no other module reads or writes the control tables');
 const importers=sources.filter(name=>/from\s+['"]\.{1,2}\/(?:[\w-]+\/)*identity-evidence-writer\.js['"]/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(importers,[],'nothing imports the writer control: no route, Workflow, cron or producer calls it');
 assert.ok(!fs.readFileSync('build.mjs','utf8').includes('identity-evidence'),'the Worker bundle does not include it');
 // The migration is a file only: no code applies it, and the deploy workflow never applies a migration.
 for(const workflow of fs.readdirSync('.github/workflows')){
  assert.ok(!/migrations\s+apply|d1\s+execute|0042_identity/.test(fs.readFileSync('.github/workflows/'+workflow,'utf8')),workflow+' does not apply 0042');
 }
}
console.log('identity evidence writer control: ok');
