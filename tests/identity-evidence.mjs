// AIR-601 / ADR 0213 (Accepted), card E1 of the ADR 0207 delivery graph: the Film identity evidence ledger, initial slice. Migration 0041 (a file only), the pure model
// and key, the writer helper inside a fenced canonical batch, and the receipted `identity_evidence` operation, on the sqlite3-CLI D1 stand-in. No Worker, R2, network or
// production access. Covered: the migration's refusal and its constraints and triggers (append-only, marker, shape, Film-bound, scope, supersession, reconstruction
// provenance), normalized keys, the initial-slice guard, ADR 0213 scenarios 1-8 and 11 at this layer (the admission routes that call the helper are card A1), receipt
// reconciliation (replay, a row present by another request, a moved source) and the dormant wiring (no reader, no Worker import).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {fenced,mutateFilm,mergeFilms} from '../src/canonical-mutations.js';
import {assertWritable,readAuthority} from '../src/film-person-authority.js';
import {OPERATION_KINDS,operationRegistry,readReceipt,reconcileReceipts} from '../src/canonical-receipts.js';
import {SOURCE_CHANGED as ADAPTER_SOURCE_CHANGED} from '../src/canonical-producer-adapters.js';
import {EVIDENCE_PRESENT,SOURCE_CHANGED,IDENTITY_EVIDENCE_OPERATION,IDENTITY_EVIDENCE_ORIGIN,METHODS,POLARITIES,RELATIONS,ROUTES,SUBJECT_KINDS,evidenceInsertStatement,evidenceKeyOf,identityEvidenceDigest,
 identityEvidenceOperation,identityEvidenceRequestId,identityEvidenceStatus,initialSliceShape,normalizeEvidence,planIdentityEvidence,readEvidence,recordIdentityEvidence} from '../src/identity-evidence.js';

const NEW='0041_film_identity_evidence.sql';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.ok(files.includes(NEW),'0041 exists');
const chain=files.slice(0,files.indexOf(NEW));
assert.equal(chain[chain.length-1],'0040_tmdb_retirement_decision_movie_index.sql','0041 follows 0040');
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-identity-evidence-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const ok=(file,text)=>{const r=sqlite(file,text);assert.equal(r.status,0,r.stderr+' <- '+text);};
const refused=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'expected a refusal: '+text);if(pattern)assert.match(r.stderr,pattern,text);};
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};

const template38=path.join(root,'t40.sqlite'),template=path.join(root,'t41.sqlite');
ok(template38,chain.map(read).join('\n'));
fs.copyFileSync(template38,template);
ok(template,read(NEW));
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY=crypto.createHash('sha256').update('[]').digest('hex');
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
let n=0;
// stage: r2 (as migrated), prepared, open (with the receipt baseline unless baseline:false) or held.
function database(stage='open',{source=template,baseline=true}={}){
 const file=path.join(root,'ie-'+(n++)+'.sqlite');
 fs.copyFileSync(source,file);
 if(stage!=='r2')ok(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1");
 if(stage==='open'||stage==='held')ok(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1"+(baseline?';'+BASELINE:''));
 if(stage==='held')ok(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const T0=Date.parse('2026-11-24T10:00:00.000Z');
const iso=ms=>new Date(T0+ms).toISOString();
const AT=iso(0);
const hex=(value)=>crypto.createHash('sha256').update(String(value)).digest('hex');
const FILM='film:tmdb:603',OTHER='film:tmdb:604';
const PAGE=hex('page-603'),ARCHIVE1=hex('archive-1'),ARCHIVE2=hex('archive-2'),EXPORT=hex('export-1');
const seedFilm=(env,id=FILM)=>mutateFilm(env,{id,expectedRevision:0,at:AT,film:{contractVersion:1}});
const revision=(file,id=FILM)=>Number(one(file,"SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+id+"'),0)"));
const ledger=file=>rows(file,'SELECT seq,evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,origin,request_id FROM film_identity_evidence ORDER BY seq');
const receipts=file=>rows(file,"SELECT request_id,operation,origin,target_id,state,error_class FROM canonical_write_receipt ORDER BY created_at,request_id");

// The initial-slice inputs: a Diary or Watchlist page check (lid), a rated-archive page check (short code, scoped to the archive) and the inferred import (restricts).
const diary=(over={})=>({subject:{kind:'letterboxd_lid',value:'lid603'},relation:'same_work',object:{kind:'tmdb_movie',value:'603'},polarity:'asserts',route:'ratings_diary',method:'page_check',sourceRoot:PAGE,sourceRef:'diary:entry-1',observedAt:AT,...over});
const watchlist=(over={})=>diary({route:'watchlist_admission',sourceRef:'snapshot:9',...over});
const archive=(sha,over={})=>diary({subject:{kind:'letterboxd_short_code',value:'sc603'},route:'letterboxd_rated_archive',sourceRoot:sha,sourceScope:sha,sourceRef:'archive-step:'+sha.slice(0,8),...over});
const inferred=(over={})=>({subject:{kind:'letterboxd_short_code',value:'sc603'},relation:'same_work',object:{kind:'tmdb_movie',value:'603'},polarity:'restricts',route:'letterboxd_export_import',method:'title_year_search',sourceRoot:EXPORT,sourceRef:'chunk:3',observedAt:AT,...over});

// What card A1 does: the evidence statement appended INSIDE the admission's own fenced batch, before its revision bump.
async function admissionBatch(env,{filmId=FILM,expected,plans,requestId='admission:req-1',at=AT,extra=[]}){
 const gate=assertWritable(await readAuthority(env));
 const entities=[{kind:'film',id:filmId,expected}];
 const statements=fenced.head(gate,entities);
 statements.push(["INSERT INTO film (id,contract_version,canonical_identity,updated_at) VALUES (?,1,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at",[filmId,'tmdb:'+filmId.split(':').pop(),at]]);
 for(const plan of plans)statements.push(evidenceInsertStatement(plan,{filmId,requestId,at}));
 statements.push(...extra);
 statements.push([fenced.BUMP,['film',filmId,at]]);
 await fenced.commit(env,gate,statements,entities);
}

// ===== 1. the migration: it follows a complete 40, creates nothing otherwise, and adds one empty table =====
{
 const t37=path.join(root,'t39.sqlite');
 ok(t37,chain.slice(0,-1).map(read).join('\n'));
 const tables=file=>one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','trigger','index')");
 const before=tables(t37);
 refused(t37,read(NEW));
 assert.equal(tables(t37),before,'a refused file creates nothing (schema 39)');
 assert.equal(one(t37,'SELECT version FROM schema_contract WHERE id=1'),39);
 // A version 40 without the 0040 index is not a complete 40: refused, nothing created.
 const noIndex=path.join(root,'t40-no-index.sqlite');
 fs.copyFileSync(template38,noIndex);
 ok(noIndex,'DROP INDEX tmdb_retirement_decision_movie');
 const beforeNoIndex=tables(noIndex);
 refused(noIndex,read(NEW));
 assert.equal(tables(noIndex),beforeNoIndex,'a refused file creates nothing (40 without its index)');
 assert.equal(one(noIndex,'SELECT version FROM schema_contract WHERE id=1'),40);
 refused(template,read(NEW),/UNIQUE|PRIMARY/);
 assert.equal(one(template,'SELECT version FROM schema_contract WHERE id=1'),41);
 assert.equal(one(template,'SELECT COUNT(*) FROM schema_contract'),1,'one schema_contract row');
 assert.equal(one(template,'SELECT COUNT(*) FROM film_identity_evidence'),0,'the table starts empty');
 assert.deepEqual(rows(template,'SELECT mode,cutover,generation FROM film_person_authority'),[{mode:'r2',cutover:'open',generation:0}],'the marker is not moved');
 const objects=rows(template,"SELECT type,name FROM sqlite_master WHERE tbl_name='film_identity_evidence' ORDER BY type,name").map(row=>row.type+':'+row.name);
 assert.deepEqual(objects,['index:film_identity_evidence_object','index:film_identity_evidence_scope','index:film_identity_evidence_subject','index:film_identity_evidence_superseded_once','index:sqlite_autoindex_film_identity_evidence_1',
  'table:film_identity_evidence','trigger:film_identity_evidence_film_bound','trigger:film_identity_evidence_insert_conflict','trigger:film_identity_evidence_insert_open','trigger:film_identity_evidence_insert_shape','trigger:film_identity_evidence_no_delete',
  'trigger:film_identity_evidence_no_update','trigger:film_identity_evidence_scope_target','trigger:film_identity_evidence_supersedes_target']);
 const downgrade=database('r2');
 refused(downgrade,'UPDATE schema_contract SET version=40 WHERE id=1',/schema_contract_downgrade/);
}

// ===== 2. the SQL contract: append-only, the marker, the model's shape, Film-bound rows, explicit unknowns only on reconstruction, scope and supersession =====
const COLUMNS=['evidence_key','film_id','subject_kind','subject_value','relation','object_kind','object_value','polarity','route','method','source_root','source_ref','source_scope','scope_evidence_key','supersedes_key','observed_at','origin','reconstruction_run','reconstructed_from','request_id','recorded_at'];
const lit=value=>value===null||value===undefined?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const key=i=>i.toString(16).padStart(64,'0');
const BASE={evidence_key:key(1),film_id:FILM,subject_kind:'letterboxd_lid',subject_value:'lid603',relation:'same_work',object_kind:'tmdb_movie',object_value:'603',polarity:'asserts',route:'ratings_diary',method:'page_check',
 source_root:PAGE,source_ref:null,source_scope:null,scope_evidence_key:null,supersedes_key:null,observed_at:AT,origin:'live',reconstruction_run:null,reconstructed_from:null,request_id:'req',recorded_at:AT};
const insert=(over={})=>{const row={...BASE,...over};return 'INSERT INTO film_identity_evidence ('+COLUMNS.join(',')+') VALUES ('+COLUMNS.map(column=>lit(row[column])).join(',')+')';};
{
 for(const stage of ['r2','prepared','held'])refused(database(stage),insert(),/film_identity_evidence_not_open/);
 const file=database('open');
 ok(file,insert());
 const original=JSON.stringify(rows(file,'SELECT * FROM film_identity_evidence'));
 ok(file,insert({source_ref:'another ref'}));
 ok(file,insert({source_ref:'another ref'})+' ON CONFLICT(evidence_key) DO NOTHING');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),1,'an existing key is a no-op for the writer');
 // Append-only against a conflict policy, with recursive triggers OFF (the SQLite default): REPLACE never deletes the existing row (its seq and payload stay).
 for(const verb of ['INSERT OR REPLACE','REPLACE']){
  ok(file,'PRAGMA recursive_triggers=OFF;'+insert({source_ref:'replaced',request_id:'evil'}).replace(/^INSERT/,verb));
  ok(file,'PRAGMA recursive_triggers=OFF;'+insert({source_ref:'replaced',request_id:'evil'})+' ON CONFLICT(evidence_key) DO UPDATE SET source_ref=excluded.source_ref');
 }
 assert.equal(JSON.stringify(rows(file,'SELECT * FROM film_identity_evidence')),original,'REPLACE and an upsert by key leave the row, its seq and payload unchanged');
 refused(file,'PRAGMA recursive_triggers=OFF;'+insert({evidence_key:key(90),source_root:hex('page-r')}).replace('INSERT INTO film_identity_evidence (','INSERT OR REPLACE INTO film_identity_evidence (seq,').replace("VALUES ('","VALUES ("+one(file,'SELECT seq FROM film_identity_evidence')+",'"),/film_identity_evidence_seq_taken/);
 assert.equal(JSON.stringify(rows(file,'SELECT * FROM film_identity_evidence')),original,'an explicit seq never replaces a row');
 refused(file,"UPDATE film_identity_evidence SET source_ref='x'",/film_identity_evidence_append_only/);
 refused(file,'DELETE FROM film_identity_evidence',/film_identity_evidence_append_only/);
 // seq is monotonic and orders rows causally.
 ok(file,insert({evidence_key:key(2),route:'watchlist_admission'}));
 ok(file,insert({evidence_key:key(3),subject_kind:'letterboxd_short_code',subject_value:'sc603',route:'letterboxd_rated_archive',source_scope:ARCHIVE1,source_root:ARCHIVE1}));
 const seqs=rows(file,'SELECT seq FROM film_identity_evidence ORDER BY evidence_key').map(row=>Number(row.seq));
 assert.ok(seqs.length===3&&seqs[0]<seqs[1]&&seqs[1]<seqs[2],'seq follows the insert order: '+seqs);
 // The model (shape trigger and CHECKs).
 const shape=[
  {subject_kind:'imdb'},{object_kind:'film'},{relation:'is_same'},{route:'tmdb_search'},{method:'guess'},
  {subject_kind:'tmdb_movie',subject_value:'603',object_kind:'letterboxd_lid',object_value:'lid603'},
  {object_kind:'letterboxd_lid',object_value:'lid603'},
  {subject_kind:'film',subject_value:FILM},
  {relation:'film_has_id',subject_kind:'letterboxd_lid'},
  {relation:'candidate_for',subject_kind:'letterboxd_lid'},
  {relation:'candidate_for',subject_kind:'discovery_observation',subject_value:'obs-1',object_kind:'letterboxd_short_code',object_value:'zz'},
  {relation:'exists',subject_kind:'film',subject_value:FILM,object_kind:null,object_value:null},
  {relation:'film_has_id',subject_kind:'film',subject_value:'movie-603'},
  {object_value:'0603'},{object_value:'60a'},{subject_kind:'letterboxd_short_code',subject_value:'sc',object_kind:'tmdb_tv',object_value:'x1'},
 ];
 for(const [i,over] of shape.entries())refused(file,insert({evidence_key:key(100+i),...over}),/film_identity_evidence_shape/);
 const checks=[
  {relation:'exists'},{object_kind:null,object_value:null},{object_value:null},
  {method:'title_year_search'},{polarity:'refutes',method:'title_year'},{polarity:'polite'},
  {route:'unknown'},{source_root:null},{observed_at:null},{observed_at:'2026-11-24T11:00:00+01:00'},
  {reconstruction_run:'run-1'},{origin:'reconstruction'},{origin:'reconstruction',reconstruction_run:'run-1'},{origin:'imported'},
  {evidence_key:'A'.repeat(64)},{evidence_key:'abc'},{film_id:'tmdb:603'},{scope_evidence_key:key(1)},
 ];
 for(const [i,over] of checks.entries())refused(file,insert({evidence_key:key(150+i),...over}),/CHECK constraint failed/);
 // Film-bound: the initial slice refuses an unbound row with its own trigger (card EP may drop it with a forward migration).
 refused(file,insert({evidence_key:key(190),film_id:null}),/film_identity_evidence_unbound/);
 // Valid shapes of the full model that later cards write: the schema already admits them.
 ok(file,insert({evidence_key:key(10),relation:'film_has_id',subject_kind:'film',subject_value:FILM,object_kind:'tmdb_movie',object_value:'603',route:'owner_action',method:'owner_statement'}));
 ok(file,insert({evidence_key:key(11),relation:'candidate_for',subject_kind:'discovery_observation',subject_value:'obs|title|2001',object_kind:'tmdb_movie',object_value:'603',route:'discovery_scan',method:'tmdb_detail_check'}));
 ok(file,insert({evidence_key:key(12),relation:'exists',subject_kind:'letterboxd_lid',object_kind:null,object_value:null,route:'watchlist_admission',method:'title_only'}));
 // Reconstruction: unknowns stay explicit (route `unknown`, NULL root, NULL time), never without the source record.
 ok(file,insert({evidence_key:key(20),origin:'reconstruction',reconstruction_run:'e3a-dry',reconstructed_from:'r2:letterboxd/admissions/verified-films.json@etag-1#tmdb_603',route:'unknown',source_root:null,observed_at:null}));
 ok(file,insert({evidence_key:key(21),origin:'reconstruction',reconstruction_run:'e3a-dry',reconstructed_from:'ratings:inferredPairs#sc603',subject_kind:'letterboxd_short_code',subject_value:'sc603',polarity:'restricts',route:'letterboxd_export_import',method:'title_year_search',source_root:null,observed_at:null}));
 refused(file,insert({evidence_key:key(22),origin:'reconstruction',reconstruction_run:'e3a-dry',route:'unknown',source_root:null}),/CHECK constraint failed/);
 // A scoped refutation names an existing row of the same proposition; only a refutation is scoped.
 refused(file,insert({evidence_key:key(30),polarity:'refutes',route:'owner_action',method:'owner_statement',scope_evidence_key:key(999)}),/film_identity_evidence_scope/);
 refused(file,insert({evidence_key:key(31),polarity:'refutes',route:'owner_action',method:'owner_statement',scope_evidence_key:key(3)}),/film_identity_evidence_scope/);
 ok(file,insert({evidence_key:key(32),polarity:'refutes',route:'owner_action',method:'owner_statement',scope_evidence_key:key(1)}));
 ok(file,insert({evidence_key:key(33),polarity:'refutes',route:'ratings_diary',method:'page_check',source_root:hex('page-names-604')}));
 // Supersession: an existing row of the same proposition, route and scope; each row at most once (scenario 12 at the schema level).
 refused(file,insert({evidence_key:key(40),source_root:hex('page-v2'),supersedes_key:key(999)}),/film_identity_evidence_supersedes/);
 refused(file,insert({evidence_key:key(41),route:'watchlist_admission',source_root:hex('page-v2'),supersedes_key:key(1)}),/film_identity_evidence_supersedes/);
 refused(file,insert({evidence_key:key(42),source_root:hex('page-v2'),source_scope:ARCHIVE1,supersedes_key:key(1)}),/film_identity_evidence_supersedes/);
 ok(file,insert({evidence_key:key(43),source_root:hex('page-v2'),supersedes_key:key(1)}));
 refused(file,insert({evidence_key:key(44),source_root:hex('page-v3'),supersedes_key:key(1)}),/film_identity_evidence_superseded_once/);
 const superseding=JSON.stringify(rows(file,'SELECT * FROM film_identity_evidence WHERE evidence_key=\''+key(43)+'\''));
 refused(file,'PRAGMA recursive_triggers=OFF;'+insert({evidence_key:key(46),source_root:hex('page-v4'),supersedes_key:key(1)}).replace(/^INSERT/,'INSERT OR REPLACE'),/film_identity_evidence_superseded_once/);
 assert.equal(JSON.stringify(rows(file,'SELECT * FROM film_identity_evidence WHERE evidence_key=\''+key(43)+'\'')),superseding,'a second supersession by REPLACE never erases the first');
 ok(file,insert({evidence_key:key(45),source_root:hex('page-v3'),supersedes_key:key(43)}));
 // No foreign key on the Film: a row survives the Film it names (a merge keeps the id it was written for).
 assert.equal(one(file,"SELECT COUNT(*) FROM pragma_foreign_key_list('film_identity_evidence')"),0);
}

// ===== 3. the pure model and the key =====
{
 assert.deepEqual([...SUBJECT_KINDS],['letterboxd_lid','letterboxd_short_code','tmdb_movie','tmdb_tv','discovery_observation','film']);
 assert.deepEqual([...RELATIONS],['same_work','film_has_id','candidate_for','exists']);
 assert.deepEqual([...POLARITIES],['asserts','restricts','refutes']);
 assert.equal(ROUTES.length,9);assert.equal(METHODS.length,8,'E1 had seven methods; known_alias is added by card EC (migration 0042)');
 // The SQL trigger lists the same sets as the module.
 const trigger=read(NEW);
 for(const value of [...SUBJECT_KINDS,...RELATIONS,...ROUTES,...METHODS.filter(method=>method!=='known_alias')])assert.ok(trigger.includes("'"+value+"'"),value+' is in the migration');
 assert.ok(!trigger.includes("'known_alias'"),'0041 is not changed: known_alias is 0042');
 assert.ok(read('0042_identity_evidence_writer_control.sql').includes("'known_alias'"),'known_alias is added by 0042');
 // The key formula is pinned: the canonical JSON of the normalized proposition, polarity, route, method, root (or the source record), scope, scoped and superseded row.
 const pinned='{"method":"page_check","object":["tmdb_movie","603"],"polarity":"asserts","reconstructedFrom":null,"relation":"same_work","root":"'+PAGE+'","route":"ratings_diary","scope":null,"scopeEvidenceKey":null,"subject":["letterboxd_lid","lid603"],"supersedesKey":null,"v":1}';
 assert.equal(await evidenceKeyOf(diary()),crypto.createHash('sha256').update(pinned).digest('hex'),'the key formula');
 // Normalized: the symmetric relation in canonical order, so A-B and B-A are one proposition and one key.
 const reversed=diary({subject:{kind:'tmdb_movie',value:603},object:{kind:'letterboxd_lid',value:'lid603'}});
 assert.equal(normalizeEvidence(reversed).subjectKind,'letterboxd_lid');
 assert.equal(normalizeEvidence(reversed).objectValue,'603');
 assert.equal(await evidenceKeyOf(reversed),await evidenceKeyOf(diary()),'A-B and B-A are one key');
 assert.equal(await evidenceKeyOf(normalizeEvidence(diary())),await evidenceKeyOf(diary()),'a normalized row gives the same key');
 // Same route and root: the same row, whatever the reference, the observation time or the Film.
 assert.equal(await evidenceKeyOf(diary({sourceRef:'diary:entry-2',observedAt:iso(5000)})),await evidenceKeyOf(diary()));
 // Another route, the same root: another row (scenario 4). Polarity, method, root and scope are each part of the key.
 const keys=await Promise.all([diary(),watchlist(),diary({sourceRoot:hex('page-603-v2')}),archive(ARCHIVE1),archive(ARCHIVE2),archive(ARCHIVE1,{sourceRoot:ARCHIVE2}),inferred(),inferred({polarity:'restricts',sourceRoot:PAGE})].map(evidenceKeyOf));
 assert.equal(new Set(keys).size,keys.length,'route, root, scope, polarity and method separate keys');
 // Reconstruction: the source record takes the place of an unknown root; the run is never part of the key; a known root is compared as a root.
 const rec=(over={})=>diary({origin:'reconstruction',reconstructionRun:'run-1',reconstructedFrom:'d1:film_rated_admission#film:tmdb:603',route:'unknown',sourceRoot:null,observedAt:null,...over});
 assert.equal(await evidenceKeyOf(rec()),await evidenceKeyOf(rec({reconstructionRun:'run-2'})),'a repeated import of one record is one key');
 assert.notEqual(await evidenceKeyOf(rec()),await evidenceKeyOf(rec({reconstructedFrom:'d1:film_rated_admission#film:tmdb:604'})),'two records with unknown roots stay two rows');
 assert.equal(await evidenceKeyOf(rec({sourceRoot:PAGE,route:'ratings_diary'})),await evidenceKeyOf(rec({sourceRoot:PAGE,route:'ratings_diary',reconstructedFrom:'other-record'})),'a known root keys the row, not the record');
 assert.notEqual(await evidenceKeyOf(rec({route:'ratings_diary',reconstructedFrom:PAGE})),await evidenceKeyOf(diary()),'a source record never collides with a root of the same text');
 // Invalid inputs, each with its reason.
 const reason=input=>{try{normalizeEvidence(input);return 'accepted';}catch(error){assert.equal(error.code,'identity_evidence_invalid');return error.reason;}};
 assert.equal(reason(diary({sourceRoot:undefined})),'unchecked_no_source_root','no check, no row');
 assert.equal(reason(diary({observedAt:null})),'unchecked_no_observed_at');
 assert.equal(reason(diary({route:'unknown'})),'unknown_route_is_reconstruction_only');
 assert.equal(reason(diary({method:'title_year_search'})),'title_year_search_is_never_proof');
 assert.equal(reason(diary({polarity:'refutes',method:'title_year'})),'refutes_method');
 assert.equal(reason(diary({object:{kind:'letterboxd_lid',value:'lid603'}})),'same_work_self');
 assert.equal(reason(diary({object:{kind:'tmdb_movie',value:'0603'}})),'object');
 assert.equal(reason(diary({subject:{kind:'letterboxd_lid',value:'bad lid'}})),'subject');
 assert.equal(reason(diary({scopeEvidenceKey:'a'.repeat(64)})),'scope_evidence_key');
 assert.equal(reason(diary({reconstructedFrom:'x'})),'live_reconstruction_fields');
 assert.equal(reason(rec({reconstructedFrom:null})),'reconstruction_provenance');
 assert.equal(reason(diary({observedAt:'yesterday'})),'observed_at');
 assert.equal(reason({...diary(),relation:'exists'}),'object');
 assert.equal(reason(diary({relation:'film_has_id'})),'subject');
 assert.equal(reason(rec()),'accepted','the model accepts an explicit unknown reconstruction without proof');
 assert.equal(reason({subject:{kind:'discovery_observation',value:'солярис|1972'},relation:'candidate_for',object:{kind:'tmdb_movie',value:'593'},polarity:'asserts',route:'discovery_scan',method:'tmdb_detail_check',sourceRoot:'obs-root',observedAt:AT}),'accepted','an observation key in any script');
 assert.equal(reason({subject:{kind:'discovery_observation',value:'film:tmdb:603'},relation:'exists',polarity:'asserts',route:'discovery_scan',method:'title_only',sourceRoot:'r',observedAt:AT}),'subject','an observation key is never a Film id');
 assert.equal(normalizeEvidence(diary({observedAt:'2026-11-24T11:00:00+01:00'})).observedAt,AT,'times are normalized UTC');
 // The initial slice (ADR 0213 decision 7) is the only live shape a writer here accepts.
 for(const input of [diary(),watchlist(),archive(ARCHIVE1),inferred(),diary({subject:{kind:'letterboxd_short_code',value:'sc603'}})])assert.ok(initialSliceShape(normalizeEvidence(input)),input.route);
 const outside=[
  diary({polarity:'refutes'}),diary({route:'owner_action',method:'owner_statement'}),diary({method:'tmdb_detail_check'}),diary({object:{kind:'tmdb_tv',value:'603'}}),
  inferred({polarity:'restricts',method:'title_year_search',route:'ratings_diary'}),inferred({polarity:'restricts',method:'page_check'}),diary({route:'letterboxd_export_import'}),
  {subject:{kind:'film',value:FILM},relation:'film_has_id',object:{kind:'tmdb_movie',value:'603'},polarity:'asserts',route:'owner_action',method:'owner_statement',sourceRoot:'intent-1',observedAt:AT},
  {subject:{kind:'letterboxd_lid',value:'lid603'},relation:'exists',polarity:'asserts',route:'watchlist_admission',method:'title_only',sourceRoot:'snap',observedAt:AT},
  {subject:{kind:'discovery_observation',value:'obs-1'},relation:'candidate_for',object:{kind:'tmdb_movie',value:'603'},polarity:'asserts',route:'discovery_scan',method:'tmdb_detail_check',sourceRoot:'obs-1',observedAt:AT},
  diary({supersedesKey:'b'.repeat(64)}),rec({route:'ratings_diary',sourceRoot:PAGE}),
 ];
 outside.push(archive(ARCHIVE1,{sourceScope:null}),archive(ARCHIVE1,{sourceScope:undefined}));
 for(const input of outside)await assert.rejects(()=>planIdentityEvidence(input),code('identity_evidence_out_of_slice'));
 // A rated-archive check names its archive: the same source root checked by two archives is two keys (scenarios 6 and 8).
 assert.notEqual(await evidenceKeyOf(archive(PAGE,{sourceScope:ARCHIVE1})),await evidenceKeyOf(archive(PAGE,{sourceScope:ARCHIVE2})),'same root, different archive scope: two keys');
 assert.equal(reason(archive(PAGE,{sourceScope:null})),'accepted','the general model keeps the scope optional');
 assert.throws(()=>evidenceInsertStatement({row:normalizeEvidence(rec()),evidenceKey:'a'.repeat(64)},{filmId:FILM,requestId:'r',at:AT}),code('identity_evidence_out_of_slice'),'the helper never writes a reconstructed row');
 const plan=await planIdentityEvidence(diary());
 assert.throws(()=>evidenceInsertStatement(plan,{filmId:'tmdb:603',requestId:'r',at:AT}),code('film_person_invalid'));
 assert.throws(()=>evidenceInsertStatement(plan,{filmId:FILM,requestId:'',at:AT}),code('identity_evidence_invalid'));
 const [sql,params]=evidenceInsertStatement(plan,{filmId:FILM,requestId:'r',at:'2026-11-24T11:00:00+01:00'});
 assert.match(sql,/ON CONFLICT\(evidence_key\) DO NOTHING$/);
 assert.equal(params.length,21);assert.equal(params[0],plan.evidenceKey);assert.equal(params[20],AT);
}

// ===== 4. atomic with the canonical effect: the evidence statement inside the admission's own fenced batch (scenarios 2, 3 and 11 at this layer) =====
{
 const file=database('open');
 const env=envOf(file);
 const restrict=await planIdentityEvidence(inferred());
 const page=await planIdentityEvidence(diary());
 // Scenario 2: the inferred import's admission batch carries its `restricts` row.
 await admissionBatch(env,{expected:0,plans:[restrict]});
 assert.equal(revision(file),1);
 assert.deepEqual(ledger(file).map(row=>[row.film_id,row.polarity,row.method,row.route,row.request_id]),[[FILM,'restricts','title_year_search','letterboxd_export_import','admission:req-1']]);
 // A batch that does not hold (a stale revision) writes neither the canonical effect nor the evidence.
 await assert.rejects(()=>admissionBatch(env,{expected:0,plans:[page],requestId:'admission:req-2'}),code('film_person_revision_conflict'));
 assert.equal(ledger(file).length,1,'no evidence without its effect');
 assert.equal(revision(file),1);
 // Evidence that the table refuses rolls the canonical effect back with it.
 const [sql,params]=evidenceInsertStatement(page,{filmId:FILM,requestId:'admission:req-3',at:AT});
 const broken=[...params];broken[2]='tmdb_movie';broken[3]='603';broken[5]='letterboxd_lid';broken[6]='lid603';broken[0]=hex('broken');
 await assert.rejects(()=>admissionBatch(env,{filmId:OTHER,expected:0,plans:[],extra:[[sql,broken]],requestId:'admission:req-3'}),code('film_person_unavailable'));
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='"+OTHER+"'"),0,'no effect without its evidence');
 assert.equal(revision(file,OTHER),0);
 // Scenario 3: a Diary page check that admits writes `asserts same_work` (ratings_diary, page_check) in the admission batch.
 await admissionBatch(env,{filmId:OTHER,expected:0,plans:[await planIdentityEvidence(diary({object:{kind:'tmdb_movie',value:'604'},sourceRoot:hex('page-604')}))],requestId:'admission:req-4'});
 assert.deepEqual(ledger(file).filter(row=>row.film_id===OTHER).map(row=>[row.polarity,row.route,row.method,row.object_value]),[['asserts','ratings_diary','page_check','604']]);
 // Scenario 11: a replay of the same admission batch inserts no second row.
 await admissionBatch(env,{expected:1,plans:[restrict],requestId:'admission:req-1'});
 assert.equal(ledger(file).length,2,'a replayed key writes nothing');
 assert.equal(receipts(file).length,0,'the helper creates no receipt: the admission batch carries its own');
}

// ===== 5. the receipted `identity_evidence` operation (scenarios 4, 5, 6, 7, 8 and 11) =====
{
 assert.ok(OPERATION_KINDS.includes(IDENTITY_EVIDENCE_OPERATION),'the operation kind is registered');
 assert.equal(SOURCE_CHANGED,ADAPTER_SOURCE_CHANGED,'the moved-source class is the producer adapters\' one (ADR 0123 decision 5)');
 const file=database('open');
 const env=envOf(file);
 await seedFilm(env);
 // Scenario 5: the pair was admitted by the inferred import (restricts in that batch); a later page check verifies it. The admission is a keep-first no-op, so the proof
 // is recorded by the evidence-only operation; the `restricts` row stays.
 await admissionBatch(env,{expected:1,plans:[await planIdentityEvidence(inferred())]});
 const r2=revision(file);
 const verified=await recordIdentityEvidence(env,{evidence:archive(ARCHIVE1),filmId:FILM,now:iso(1000)});
 assert.equal(verified.state,'applied');assert.equal(verified.written,true);assert.equal(verified.receipt,true);
 assert.equal(verified.requestId,await identityEvidenceRequestId({evidenceKey:verified.evidenceKey,filmId:FILM}));
 assert.match(verified.requestId,/^identity_evidence:identity_evidence:[0-9a-f]{64}$/);
 assert.equal(revision(file),r2+1,'the operation is a fenced canonical write of the Film');
 const stored=await readReceipt(env,verified.requestId);
 assert.deepEqual([stored.state,stored.operation,stored.origin,stored.target.id,stored.appliedRevision,stored.contentDigest],['applied','identity_evidence','identity_evidence',FILM,r2+1,await identityEvidenceDigest({evidenceKey:verified.evidenceKey,filmId:FILM})]);
 assert.deepEqual(ledger(file).map(row=>[row.polarity,row.route,row.source_scope]),[['restricts','letterboxd_export_import',null],['asserts','letterboxd_rated_archive',ARCHIVE1]],'the restricts row stays, the proof now exists');
 // Scenario 6: a second archive verifying the admitted pair: one new row with that archive's scope.
 const second=await recordIdentityEvidence(env,{evidence:archive(ARCHIVE2),filmId:FILM,now:iso(2000)});
 assert.equal(second.state,'applied');
 assert.deepEqual(rows(file,"SELECT source_scope FROM film_identity_evidence WHERE route='letterboxd_rated_archive' ORDER BY seq").map(row=>row.source_scope),[ARCHIVE1,ARCHIVE2]);
 // Scenario 4: the Diary check, then the Watchlist caller checking the same page (same digest): a new row with the same root, never independent; the same caller
 // again (a later snapshot, a later time): no row, no receipt, no batch.
 await recordIdentityEvidence(env,{evidence:diary(),filmId:FILM,now:iso(3000)});
 const fromWatchlist=await recordIdentityEvidence(env,{evidence:watchlist(),filmId:FILM,now:iso(4000)});
 assert.equal(fromWatchlist.state,'applied');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_identity_evidence WHERE route IN ('ratings_diary','watchlist_admission')"),2);
 assert.equal(one(file,"SELECT COUNT(DISTINCT source_root) FROM film_identity_evidence WHERE route IN ('ratings_diary','watchlist_admission')"),1,'one source: the rows share a root and are not independent');
 const countBefore=[ledger(file).length,receipts(file).length,revision(file)];
 const again=await recordIdentityEvidence(env,{evidence:watchlist({sourceRef:'snapshot:10',observedAt:iso(9000)}),filmId:FILM,now:iso(9000)});
 assert.deepEqual([again.state,again.receipt,again.written],['present',false,false]);
 assert.deepEqual([ledger(file).length,receipts(file).length,revision(file)],countBefore,'an existing key is a no-op: no row, no receipt, no revision');
 // Scenario 8: the symmetric order of the same proposition is the same key.
 const symmetric=await recordIdentityEvidence(env,{evidence:diary({subject:{kind:'tmdb_movie',value:'603'},object:{kind:'letterboxd_lid',value:'lid603'}}),filmId:FILM,now:iso(9500)});
 assert.equal(symmetric.state,'present');
 // Scenario 7: a step that did not perform its method has no root: nothing is written.
 await assert.rejects(()=>recordIdentityEvidence(env,{evidence:diary({sourceRoot:null,sourceRef:'answered-present-from-admission'}),filmId:FILM,now:iso(9600)}),code('identity_evidence_invalid'));
 assert.deepEqual([ledger(file).length,receipts(file).length,revision(file)],countBefore,'no verification, no evidence');
 // Refusals before any write.
 await assert.rejects(()=>recordIdentityEvidence(env,{evidence:diary({polarity:'refutes'}),filmId:FILM}),code('identity_evidence_out_of_slice'));
 await assert.rejects(()=>recordIdentityEvidence(env,{evidence:diary({sourceRoot:hex('x')}),filmId:'film:tmdb:999'}),code('identity_evidence_unknown_film'));
 await assert.rejects(()=>recordIdentityEvidence(env,{evidence:diary({sourceRoot:hex('x')}),filmId:'tmdb:999'}),code('film_person_invalid'));
 assert.deepEqual([ledger(file).length,receipts(file).length],countBefore.slice(0,2));
}

// ===== 6. concurrency, lost responses and reconciliation =====
{
 // Scenario 8: two concurrent verifications from the same route and root: one row and one receipt.
 const file=database('open');
 const env=envOf(file);
 await seedFilm(env);
 const outcomes=await Promise.allSettled([recordIdentityEvidence(env,{evidence:diary(),filmId:FILM,now:iso(0)}),recordIdentityEvidence(env,{evidence:diary({sourceRef:'diary:entry-2'}),filmId:FILM,now:iso(0)})]);
 assert.ok(outcomes.every(item=>item.status==='fulfilled'),JSON.stringify(outcomes.map(item=>item.reason?.code)));
 assert.equal(ledger(file).length,1,'one row');
 assert.equal(receipts(file).length,1,'one receipt: the request id derives from the key and the Film');
 assert.ok(outcomes.some(item=>item.value.state==='applied'));
 assert.ok(outcomes.every(item=>['applied','present','pending'].includes(item.value.state)));
 // From different archives: two rows with different scopes. A concurrent loser of the Film's revision fails transiently and lands on its retry.
 const both=await Promise.allSettled([recordIdentityEvidence(env,{evidence:archive(ARCHIVE1),filmId:FILM,now:iso(1000)}),recordIdentityEvidence(env,{evidence:archive(ARCHIVE2),filmId:FILM,now:iso(1000)})]);
 for(const item of both)if(item.status==='rejected')assert.equal(item.reason.code,'film_person_revision_conflict');
 for(const [i,item] of both.entries())if(item.status==='rejected'){
  const retried=await recordIdentityEvidence(env,{evidence:archive(i===0?ARCHIVE1:ARCHIVE2),filmId:FILM,now:iso(1000+61000)});
  assert.equal(retried.state,'applied','the due retry replays the same request against the current revision');
 }
 assert.deepEqual(rows(file,"SELECT source_scope FROM film_identity_evidence WHERE source_scope IS NOT NULL ORDER BY source_scope").map(row=>row.source_scope),[ARCHIVE1,ARCHIVE2].sort());
}
{
 // Scenario 11: the evidence-only batch commits and its response is lost. The receipt is `applied` (it moved in the same batch), the row exists, and the replay writes nothing.
 const file=database('open');
 const base=d1Standin(file);
 let armed=true;
 const env={DB:{...base,async batch(statements){const result=await base.batch(statements);if(armed&&statements.some(item=>/INSERT INTO film_identity_evidence/.test(item.text))){armed=false;throw new Error('network: response lost');}return result;}}};
 await seedFilm(env);
 await assert.rejects(()=>recordIdentityEvidence(env,{evidence:diary(),filmId:FILM,now:iso(0)}),code('film_person_unavailable'));
 const evidenceKey=await evidenceKeyOf(diary());
 const requestId=await identityEvidenceRequestId({evidenceKey,filmId:FILM});
 assert.equal((await readReceipt(env,requestId)).state,'applied','a lost response is answered by reading the key: applied means the row exists');
 assert.equal((await readEvidence(env,evidenceKey)).request_id,requestId);
 const replay=await recordIdentityEvidence(env,{evidence:diary(),filmId:FILM,now:iso(5000)});
 assert.deepEqual([replay.state,replay.receipt],['present',false]);
 assert.equal(ledger(file).length,1);assert.equal(receipts(file).length,1);
}
{
 // Reconciliation: a receipt whose batch lost the Film's revision is `failed`; the reconciler replays it (revalidated: no precondition on the Film's content).
 const file=database('open');
 let bump=false;
 const env=envOf(file,{onBatch:async statements=>{if(bump&&statements.some(item=>/INSERT INTO film_identity_evidence/.test(item.text))){bump=false;ok(file,"UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id='"+FILM+"'");}}});
 await seedFilm(env);
 bump=true;
 await assert.rejects(()=>recordIdentityEvidence(env,{evidence:diary(),filmId:FILM,now:iso(0)}),code('film_person_revision_conflict'));
 const evidenceKey=await evidenceKeyOf(diary());
 const requestId=await identityEvidenceRequestId({evidenceKey,filmId:FILM});
 assert.equal((await readReceipt(env,requestId)).state,'failed');
 assert.equal(ledger(file).length,0);
 const operations=operationRegistry([identityEvidenceOperation({replan:async receipt=>receipt.requestId===requestId?{evidence:diary(),filmId:FILM}:null,now:()=>iso(70000)})]);
 const early=await reconcileReceipts(env,{operations,now:iso(30000),origin:IDENTITY_EVIDENCE_ORIGIN});
 assert.equal(early.considered,0,'not due inside its backoff');
 const pass=await reconcileReceipts(env,{operations,now:iso(70000),origin:IDENTITY_EVIDENCE_ORIGIN});
 assert.deepEqual(pass.replayed,[requestId]);
 assert.equal((await readReceipt(env,requestId)).state,'applied');
 assert.equal(ledger(file).length,1);
}
{
 // Reconciliation: while the receipt was failed, an admission batch recorded the same key under its own request. The receipt never landed, so it is abandoned as
 // `identity_evidence_present`, never applied; a moved source (the replan gives another key) is a typed terminal abandon.
 const file=database('open');
 let bump=0;
 const env=envOf(file,{onBatch:async statements=>{if(bump>0&&statements.some(item=>/INSERT INTO film_identity_evidence/.test(item.text))){bump--;ok(file,"UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id='"+FILM+"'");}}});
 await seedFilm(env);
 bump=2;
 await assert.rejects(()=>recordIdentityEvidence(env,{evidence:diary(),filmId:FILM,now:iso(0)}),code('film_person_revision_conflict'));
 await assert.rejects(()=>recordIdentityEvidence(env,{evidence:watchlist(),filmId:FILM,now:iso(0)}),code('film_person_revision_conflict'));
 const diaryRequest=await identityEvidenceRequestId({evidenceKey:await evidenceKeyOf(diary()),filmId:FILM});
 const watchRequest=await identityEvidenceRequestId({evidenceKey:await evidenceKeyOf(watchlist()),filmId:FILM});
 await admissionBatch(env,{expected:revision(file),plans:[await planIdentityEvidence(diary())],requestId:'admission:diary-1'});
 const replan=async receipt=>receipt.requestId===diaryRequest?{evidence:diary(),filmId:FILM}:receipt.requestId===watchRequest?{evidence:watchlist({sourceRoot:hex('another page')}),filmId:FILM}:null;
 const pass=await reconcileReceipts(env,{operations:operationRegistry([identityEvidenceOperation({replan,now:()=>iso(70000)})]),now:iso(70000),origin:IDENTITY_EVIDENCE_ORIGIN});
 assert.deepEqual(pass.abandoned.map(item=>item.reason).sort(),[EVIDENCE_PRESENT,'producer_source_changed'].sort());
 assert.equal((await readReceipt(env,diaryRequest)).errorClass,EVIDENCE_PRESENT);
 assert.equal((await readReceipt(env,watchRequest)).errorClass,'producer_source_changed');
 assert.deepEqual(ledger(file).map(row=>row.request_id),['admission:diary-1'],'one row, written by the admission batch; no receipt claims it');
}

{
 // The global evidence-key race. The Film revision is not a key-wide guard, so each interleaving below lets the key land between the operation's absence read and its
 // batch. The losing batch must not bump the Film or apply its receipt: it rolls back, the receipt is abandoned as `identity_evidence_present`, one row stays.
 const evidenceKey=await evidenceKeyOf(diary());
 // (a) the same key for two DIFFERENT existing Films: the other Film's call completes inside this one's window.
 {
  const file=database('open');
  let interleave=null;
  const env=envOf(file,{onBatch:async statements=>{if(interleave&&statements.some(item=>/INSERT INTO film_identity_evidence/.test(item.text))){const run=interleave;interleave=null;await run();}}});
  await seedFilm(env);await seedFilm(env,OTHER);
  const plain=envOf(file);
  let winner=null;
  interleave=async()=>{winner=await recordIdentityEvidence(plain,{evidence:diary(),filmId:OTHER,now:iso(0)});};
  const before=revision(file);
  const loser=await recordIdentityEvidence(env,{evidence:diary(),filmId:FILM,now:iso(0)});
  assert.equal(winner.state,'applied','the other Film recorded the key');
  assert.deepEqual([loser.state,loser.receipt,loser.receiptState,loser.errorClass,loser.written],['present',true,'abandoned',EVIDENCE_PRESENT,false]);
  assert.equal(revision(file),before,'the losing batch did not bump its Film');
  const lost=await readReceipt(env,await identityEvidenceRequestId({evidenceKey,filmId:FILM}));
  assert.deepEqual([lost.state,lost.errorClass],['abandoned',EVIDENCE_PRESENT],'the losing receipt is settled non-applied with a typed class');
  assert.deepEqual(ledger(file).map(row=>[row.film_id,row.request_id]),[[OTHER,await identityEvidenceRequestId({evidenceKey,filmId:OTHER})]],'one row, owned by the winner');
  assert.equal(receipts(file).filter(row=>row.state==='applied').length,1,'only the winner applied');
 }
 // (b) the same Film: an admission batch records the key (with and without moving the Film's revision) between the absence read and the batch.
 for(const moves of [false,true]){
  const file=database('open');
  let interleave=false;
  const env=envOf(file,{onBatch:async statements=>{
   if(!interleave||!statements.some(item=>/INSERT INTO film_identity_evidence/.test(item.text)))return;
   interleave=false;
   const plain=envOf(file);
   if(moves)await admissionBatch(plain,{expected:revision(file),plans:[await planIdentityEvidence(diary())],requestId:'admission:race-1'});
   else ok(file,insert({evidence_key:evidenceKey,request_id:'admission:race-1',source_ref:'diary:entry-1'}));
  }});
  await seedFilm(env);
  interleave=true;
  const before=revision(file);
  const loser=await recordIdentityEvidence(env,{evidence:diary(),filmId:FILM,now:iso(0)});
  assert.deepEqual([loser.state,loser.receiptState,loser.errorClass],['present','abandoned',EVIDENCE_PRESENT],moves?'revision moved':'revision unmoved');
  assert.equal(revision(file),before+(moves?1:0),'only the admission bumped the Film');
  assert.deepEqual(ledger(file).map(row=>row.request_id),['admission:race-1']);
  assert.equal(receipts(file).filter(row=>row.state==='applied').length,0,'no evidence receipt is applied');
 }
 // (c) the replay race: the reconciler's readback finds the key absent, then another request records it before the replay batch; the replay abandons, never applies.
 {
  const file=database('open');
  let bump=false,interleave=false;
  const env=envOf(file,{onBatch:async statements=>{
   if(!statements.some(item=>/INSERT INTO film_identity_evidence/.test(item.text)))return;
   if(bump){bump=false;ok(file,"UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id='"+FILM+"'");return;}
   if(interleave){interleave=false;await recordIdentityEvidence(envOf(file),{evidence:diary(),filmId:OTHER,now:iso(70000)});}
  }});
  await seedFilm(env);await seedFilm(env,OTHER);
  bump=true;
  await assert.rejects(()=>recordIdentityEvidence(env,{evidence:diary(),filmId:FILM,now:iso(0)}),code('film_person_revision_conflict'));
  const requestId=await identityEvidenceRequestId({evidenceKey,filmId:FILM});
  interleave=true;
  const pass=await reconcileReceipts(env,{operations:operationRegistry([identityEvidenceOperation({replan:async receipt=>receipt.requestId===requestId?{evidence:diary(),filmId:FILM}:null,now:()=>iso(70000)})]),now:iso(70000),origin:IDENTITY_EVIDENCE_ORIGIN});
  assert.ok(!pass.applied.some(item=>(item.requestId??item)===requestId),'the replay is never reported applied');
  const settled=await readReceipt(env,requestId);
  assert.deepEqual([settled.state,settled.errorClass],['abandoned',EVIDENCE_PRESENT],'the replay lost the race and is abandoned, not applied');
  assert.deepEqual(ledger(file).map(row=>row.film_id),[OTHER]);
 }
 // The rated-archive writer refuses an archive check without its archive scope, before any receipt or row.
 {
  const file=database('open');
  const env=envOf(file);
  await seedFilm(env);
  await assert.rejects(()=>recordIdentityEvidence(env,{evidence:archive(ARCHIVE1,{sourceScope:null}),filmId:FILM,now:iso(0)}),code('identity_evidence_out_of_slice'));
  assert.deepEqual([ledger(file).length,receipts(file).length],[0,0]);
  // Two archives over the SAME source root: two rows, one per archive scope.
  for(const scope of [ARCHIVE1,ARCHIVE2])assert.equal((await recordIdentityEvidence(env,{evidence:archive(PAGE,{sourceScope:scope}),filmId:FILM,now:iso(scope===ARCHIVE1?0:120000)})).state,'applied');
  assert.deepEqual(ledger(file).map(row=>[row.source_root,row.source_scope]),[[PAGE,ARCHIVE1],[PAGE,ARCHIVE2]]);
 }
}

// ===== 7. fail closed: schema, marker, receipts, redirect and merge =====
{
 const absent=database('open',{source:template38});
 assert.equal(await identityEvidenceStatus(envOf(absent)),'absent');
 await seedFilm(envOf(absent));
 await assert.rejects(()=>recordIdentityEvidence(envOf(absent),{evidence:diary(),filmId:FILM}),code('identity_evidence_unavailable'));
 const damaged=database('open');
 ok(damaged,'DROP TABLE film_identity_evidence');
 await assert.rejects(()=>identityEvidenceStatus(envOf(damaged)),code('film_person_unavailable'),'schema 41 without the table is never "no ledger"');
 assert.equal(await identityEvidenceStatus(envOf(database('open'))),'ready');
 // A `prepared` (or `r2`) marker is not served (ADR 0162): refused as unavailable, never written.
 await assert.rejects(()=>recordIdentityEvidence(envOf(database('prepared')),{evidence:diary(),filmId:FILM}),code('film_person_unavailable'));
 await assert.rejects(()=>recordIdentityEvidence(envOf(database('held')),{evidence:diary(),filmId:FILM}),code('film_person_held'));
 const unsealed=database('open',{baseline:false});
 await seedFilm(envOf(unsealed));
 await assert.rejects(()=>recordIdentityEvidence(envOf(unsealed),{evidence:diary(),filmId:FILM}),code('receipt_baseline_missing'));
 assert.equal(one(unsealed,'SELECT COUNT(*) FROM film_identity_evidence'),0);
 // A merge writes no evidence and touches none: the retired Film's row keeps its id (readers resolve it through film_redirect, card EP). A redirected Film is refused.
 const file=database('open');
 const env=envOf(file);
 await seedFilm(env);await seedFilm(env,OTHER);
 await recordIdentityEvidence(env,{evidence:diary(),filmId:FILM,now:iso(0)});
 const rowsBefore=ledger(file).length;
 await mergeFilms(env,{from:FILM,to:OTHER,expected:{from:revision(file,FILM),to:revision(file,OTHER)},at:iso(1000),evidence:{verified:true}});
 assert.equal(ledger(file).length,rowsBefore,'a merge writes no evidence');
 assert.equal(ledger(file)[0].film_id,FILM,'the row keeps the id it was written for');
 await assert.rejects(()=>recordIdentityEvidence(env,{evidence:watchlist(),filmId:FILM,now:iso(2000)}),code('film_person_redirect'));
 assert.equal((await recordIdentityEvidence(env,{evidence:diary(),filmId:OTHER,now:iso(3000)})).state,'present','the key exists whatever Film it is bound to');
}

// ===== 8. dormant: nothing reads the ledger, nothing in the Worker imports the writer =====
{
 const sources=fs.readdirSync('src',{recursive:true}).filter(name=>String(name).endsWith('.js')).map(name=>path.join('src',String(name)));
 const mentions=sources.filter(name=>fs.readFileSync(name,'utf8').includes('film_identity_evidence'));
 assert.deepEqual(mentions,['src/identity-evidence-import.js','src/identity-evidence-writer.js','src/identity-evidence.js'],'no other module reads or writes the table (ADR 0213 decision 8: no reader); the dormant import path of card ER (AIR-639) is the third');
 const importers=sources.filter(name=>/from\s+['"]\.{1,2}\/(?:[\w-]+\/)*identity-evidence\.js['"]/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(importers,['src/discovery-owner-evidence.js','src/film-admission.js','src/identity-evidence-family-b.js','src/identity-evidence-import.js','src/identity-evidence-writer.js','src/letterboxd-admission-d1.js','src/letterboxd-lid-attach.js'],'only the writer-control (card EC), the import (card ER), the Discovery owner writer (card E2c, dormant by its control row) and the d1 admission path of card A1 (AIR-602: the admission writer appends the row to its own batch, the coordinator records the evidence-only row) import the model: no route, Workflow, cron or other producer calls it; the family (b) extraction of card E3b (AIR-622) imports only the row model to validate what it maps: it reads no ledger, writes nothing and no Worker module imports it');
 // AIR-618 (card E2b): the claim unit's bridge row rides in the claim's own batch, so the two ledger modules are scoped into the Worker bundle (dormant: no control row means no row); the import path is not.
 const build=fs.readFileSync('build.mjs','utf8');
 const scopes=fs.readFileSync('scripts/bundle-scope.mjs','utf8');
 assert.ok(build.includes('scopedIdentityEvidence()')&&scopes.includes("'src/identity-evidence.js','IdentityEvidence'")&&scopes.includes("'src/identity-evidence-writer.js','IdentityEvidenceWriter'"),'the Worker bundle scopes the ledger helper and the writer control (E2a Discovery write, E2b claim unit, A1 d1 admission path)');
 assert.ok(!build.includes('identity-evidence-import'),'the Worker bundle does not include the import path');
 // AIR-602: card A1 uses the helper for the d1 admission path. It stays dormant: that path runs only at the marker mode `d1` (a separate owner activation), and the Worker itself never names it.
 assert.ok(!/IdentityEvidence/.test(fs.readFileSync('src/worker.js','utf8')),'no Worker route, cron or Workflow names it');
}
console.log('identity evidence ledger: ok');
