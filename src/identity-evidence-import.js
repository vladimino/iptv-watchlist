// AIR-639 / ADR 0215 (Accepted), card ER: the manifest-bound reconstruction import path of the identity evidence ledger (migration 0044, a file only).
// DORMANT: nothing in the Worker imports this module, it is not bundled, and no route, Workflow, cron or producer calls it. The families (cards E3a-E3c) bring their own source
// extraction and run these operators only after an owner-approved dry run and an import GO that names the manifest digest. Nothing here READS the ledger to decide anything.
//
// What it provides (ADR 0215 decision 7, one import path for every family):
// - `planManifest`: the dry run. PURE, writes nothing. From the source records a family extracted at its extraction time and the rows each maps to, it freezes the exact cohort,
//   keys every row, reports duplicates (the first source record in manifest order owns a key) and conflicts (inputs that disagree on the semantic identity, `source_order`
//   included, are left out), excludes R2 objects whose residual window the owner did not accept, cuts ordered chunks of at most 50 source records and 200 rows, and prints the
//   manifest's SHA-256. The owner's import GO names that digest.
// - `loadManifest`: stages the manifest into the immutable staging tables of the run (idempotent: a lost response is answered by resending, a chunk is atomic), reads it back and
//   recomputes the digest. `sealRun`: the atomic seal, then a second readback. Any difference abandons (stops) the run. `loadAndSealManifest` runs both.
// - `importRun`: claims the lease, and per chunk runs ONE D1 batch that asserts the run, the live lease of this attempt, the next chunk number, and every staged source record's
//   guard fields (a changed or deleted listed record fails the chunk as `source_moved`), inserts FROM THE STAGING ROWS (never from caller values) with
//   `ON CONFLICT (evidence_key) DO NOTHING`, asserts that every staged key now has the staged semantic identity (a different one is a collision), and appends the create-only
//   receipt whose four counts (inserted, already_imported, live_covered, reconstructed_equivalent) are computed in the batch and must add up to the staged keys. A lost response
//   is settled by the receipt; a resumed attempt takes a new lease and a chunk sent under a stale lease fails the receipt's fence. R2 sources are re-read by ETag before their chunk.
//   The import never moves a Film revision, never writes a canonical receipt and refuses while a writer the run names is `pending` (the database enforces it).
// - `readImportRun`, `readImportReport`: read-only status, receipts and the reconstructed-equivalent pairs of a run.
import {database,failed,many,one} from './film-person-authority.js';
import {evidenceKeyOf,normalizeEvidence} from './identity-evidence.js';

export const IMPORT_SCHEMA=44;
export const FAMILIES=Object.freeze(['a','b','c']);
export const MAX_SOURCES_PER_CHUNK=50;
export const MAX_ROWS_PER_CHUNK=200;
export const OUTCOMES=Object.freeze(['inserted','already_imported','live_covered','reconstructed_equivalent']);
export const MANIFEST_VERSION=1;
// The frozen R2 objects that may be imported at all (ADR 0215 decision 7, step 6). Anything else is excluded and reported.
export const R2_ELIGIBLE=Object.freeze(['verified_films_after_a2','admin_action_applied']);
// The writers a run may name; the database refuses a start while one of them is `pending`.
export const IMPORT_WRITERS=Object.freeze(['discovery_decision','discovery_owner','claim_alias_bridge','tmdb_retirement_decision','tmdb_retirement_application']);
// The closed allowlist of D1 source tables a guard may assert, with their key columns and the columns whose fields may be compared. A family card widens it in code review; the
// manifest never names SQL. A JSON field is addressed `column#$.path` and is allowed only on a `_json` column.
export const GUARD_TABLES=Object.freeze({
 discovery_decision_history:Object.freeze({key:['observation_key','revision'],columns:['observation_key','revision','generation','written_at','writer','payload_json']}),
 discovery_decision:Object.freeze({key:['observation_key'],columns:['observation_key','programme_run_id','generation','status','attempts','evidence_key','terminal_reason','retry_at','tmdb_id','media_kind','film_id','decision_hash','payload_json']}),
 discovery_intent:Object.freeze({key:['idempotency_key'],columns:['idempotency_key','kind','state','observation_key','before_json','receipt_json','issued_json','command_json','expected_hash','expires_at','generation']}),
 film_external_id:Object.freeze({key:['film_id','scheme','value'],columns:['film_id','scheme','value','trusted','conflicting','provenance_json']}),
 tmdb_retirement_decision:Object.freeze({key:['seq'],columns:['seq','request_id','film_id','kind','lid','movie_id','tv_id','evidence_json','confirmation_json','origin','input_sha256','supersedes_seq','payload_json','recorded_at']}),
});

const HEX64=/^[0-9a-f]{64}$/;
const RUN=/^[\x21-\x7e]{1,150}$/;
const OWNER=/^[\x21-\x7e]{1,200}$/;
const TOKEN=/^[\x21-\x7e]{1,300}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const JSON_PATH=/^\$(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){1,6}$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const invalid=reason=>{const error=failed('identity_evidence_import_invalid');error.reason=reason;return error;};
const clockOf=now=>typeof now==='function'?now:()=>now||new Date().toISOString();
function instant(value,reason){
 if(typeof value!=='string'||!ISO.test(value)||!Number.isFinite(Date.parse(value)))throw invalid(reason);
 return new Date(Date.parse(value)).toISOString();
}
// Canonical JSON (object keys sorted, undefined dropped) and its SHA-256: the manifest's own digest form. A local copy, not an import of the receipt layer, so this dormant path stays
// outside the canonical receipt importers (the manifest digest is an import-path contract of its own and never a receipt digest).
function canonicalJson(value){
 if(value===undefined)return 'null';
 if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 return '{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';
}
const digestOf=value=>sha256(canonicalJson(value));
const sha256=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');

// ---- the import's own assertion (the chunk batch rolls back whole when a condition proves false) ----
export const assertSql=condition=>'INSERT INTO identity_evidence_import_cas (id,ok) VALUES (1,(SELECT CASE WHEN EXISTS (SELECT 1 FROM identity_evidence_import_cas WHERE id=1) AND ('+condition+') THEN 1 ELSE 0 END)) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';

// ---- guard fields and the source token ----
function scalar(value,reason){
 if(value===null||typeof value==='string'||(typeof value==='number'&&Number.isFinite(value)))return value;
 throw invalid(reason);
}
function guardField(table,name){
 const spec=GUARD_TABLES[table];
 const [column,path]=String(name).split('#');
 if(!spec.columns.includes(column))throw invalid('guard_column');
 if(path!==undefined&&(!column.endsWith('_json')||!JSON_PATH.test(path)))throw invalid('guard_path');
 return {column,path:path===undefined?null:path};
}
// The canonical form of a D1 source: its key columns (all of them) and its guard fields (at least one).
function d1Source(input){
 if(!plain(input)||typeof input.table!=='string'||!GUARD_TABLES[input.table])throw invalid('source_table');
 const spec=GUARD_TABLES[input.table];
 if(!plain(input.key)||Object.keys(input.key).sort().join()!==[...spec.key].sort().join())throw invalid('source_key');
 const key={};
 for(const column of spec.key){const value=scalar(input.key[column],'source_key');if(value===null)throw invalid('source_key');key[column]=value;}
 if(!plain(input.guard)||!Object.keys(input.guard).length||Object.keys(input.guard).length>40)throw invalid('guard');
 const guard={};
 for(const name of Object.keys(input.guard).sort()){guardField(input.table,name);guard[name]=scalar(input.guard[name],'guard_value');}
 return {kind:'d1_row',table:input.table,key,guard};
}
// An R2 source is a LOGICAL record inside a PHYSICAL object: `key` and `etag` name the frozen object (the guard, re-read before every submission of a chunk that uses it) and
// `record` the durable record inside it (for example one legacy admission), so one object yields many distinct source records that stage across bounded chunks.
function r2Source(input){
 if(!plain(input)||typeof input.key!=='string'||!/^[\x21-\x7e]{1,500}$/.test(input.key)||typeof input.etag!=='string'||!/^[\x21-\x7e]{1,200}$/.test(input.etag)
  ||typeof input.record!=='string'||!/^[\x21-\x7e]{1,300}$/.test(input.record))throw invalid('r2_source');
 return {kind:'r2_object',key:input.key,record:input.record,etag:input.etag};
}
// The canonical descriptor of a source: two inputs of one source token must agree on it exactly (guard fields and pinned ETag included).
const describe=source=>canonicalJson(source);
// The `reconstructed_from` of every row a source record yields: stable across runs and cohorts, so a replay of one record is one key and one token. The token carries the logical
// record, never the ETag (a replay after the object was rewritten identically is still the same record).
export async function sourceToken(source){
 if(source?.kind==='r2_object')return 'r2:'+await sha256(canonicalJson([source.key,source.record]));
 if(source?.kind==='d1_row'&&GUARD_TABLES[source.table])return 'd1:'+source.table+':'+await sha256(canonicalJson(source.key));
 throw invalid('source');
}

// The assertion a chunk makes for one staged D1 source record: it exists with exactly its staged key and guard fields (field equality; `IS` so NULL equals NULL).
export function guardCondition(source){
 const spec=GUARD_TABLES[source?.table];
 if(source?.kind!=='d1_row'||!spec)throw invalid('source');
 const clauses=[],params=[];
 for(const column of spec.key){clauses.push(column+'=?');params.push(source.key[column]);}
 for(const name of Object.keys(source.guard).sort()){
  const {column,path}=guardField(source.table,name);
  clauses.push((path===null?column:'json_extract('+column+',?)')+' IS ?');
  if(path!==null)params.push(path);
  params.push(source.guard[name]);
 }
 return {sql:'EXISTS (SELECT 1 FROM '+source.table+' WHERE '+clauses.join(' AND ')+')',params};
}

// ---- the manifest ----
const ROW_FIELDS=['filmId','subjectKind','subjectValue','relation','objectKind','objectValue','polarity','route','method','sourceRoot','sourceRef','sourceScope','scopeEvidenceKey','supersedesKey','observedAt','reconstructedFrom','sourceOrder'];
const FILM_ID=/^film:[\x21-\x7e]{1,295}$/;
function normalizedInput(row){
 return {subject:{kind:row.subjectKind,value:row.subjectValue},relation:row.relation,object:row.objectKind===null?null:{kind:row.objectKind,value:row.objectValue},polarity:row.polarity,route:row.route,method:row.method,
  sourceRoot:row.sourceRoot,sourceRef:row.sourceRef,sourceScope:row.sourceScope,scopeEvidenceKey:row.scopeEvidenceKey,supersedesKey:row.supersedesKey,observedAt:row.observedAt,origin:'reconstruction',
  reconstructionRun:row.reconstructionRun,reconstructedFrom:row.reconstructedFrom,sourceOrder:row.sourceOrder};
}
// The semantic identity of ADR 0215 decision 1 (proposition, polarity, route, method, root or its substitute, scope, scoped and superseded rows, `source_order`): what two inputs of
// one key must agree on, and what an existing ledger row must have for the key to count as the same.
const identityOf=row=>canonicalJson([row.subjectKind,row.subjectValue,row.relation,row.objectKind,row.objectValue,row.polarity,row.route,row.method,row.sourceRoot===null?['from',row.reconstructedFrom]:['root',row.sourceRoot],
 row.sourceScope,row.scopeEvidenceKey,row.supersedesKey,row.sourceOrder]);

// The manifest row of one input row of a source record.
async function manifestRow(runId,token,input){
 if(!plain(input)||!plain(input.evidence))throw invalid('row');
 const {reconstructedFrom,origin,reconstructionRun,...rest}=input.evidence;
 if(origin!==undefined&&origin!=='reconstruction')throw invalid('row_origin');
 if(reconstructionRun!==undefined&&reconstructionRun!==null&&reconstructionRun!==runId)throw invalid('row_run');
 if(reconstructedFrom!==undefined&&reconstructedFrom!==null&&reconstructedFrom!==token)throw invalid('row_source');
 const row=normalizeEvidence({...rest,origin:'reconstruction',reconstructionRun:runId,reconstructedFrom:token});
 const filmId=input.filmId===undefined||input.filmId===null?null:input.filmId;
 if(filmId!==null&&(typeof filmId!=='string'||!FILM_ID.test(filmId)))throw invalid('film_id');
 return {key:await evidenceKeyOf(row),filmId,subjectKind:row.subjectKind,subjectValue:row.subjectValue,relation:row.relation,objectKind:row.objectKind,objectValue:row.objectValue,polarity:row.polarity,route:row.route,
  method:row.method,sourceRoot:row.sourceRoot,sourceRef:row.sourceRef,sourceScope:row.sourceScope,scopeEvidenceKey:row.scopeEvidenceKey,supersedesKey:row.supersedesKey,observedAt:row.observedAt,
  reconstructedFrom:token,sourceOrder:row.sourceOrder};
}

// The writers whose live coverage a family's import depends on (ADR 0215 decision 7: family (b) imports after E2a and E2c are `on`). Derived from the family, never from the
// extractor: a manifest that omits them is invalid, and the database refuses a family `b` run unless both are `on`. Family (a) and (c) need no live writer.
export const REQUIRED_WRITERS=Object.freeze({a:Object.freeze([]),b:Object.freeze(['discovery_decision','discovery_owner']),c:Object.freeze([])});
function checkWriters(writers,family){
 if(!Array.isArray(writers)||writers.length>5||new Set(writers).size!==writers.length||writers.some(writer=>!IMPORT_WRITERS.includes(writer)))throw invalid('writers');
 if(!REQUIRED_WRITERS[family].every(writer=>writers.includes(writer)))throw invalid('writers_required');
 return [...writers].sort();
}
function checkRun(runId,family){
 if(typeof runId!=='string'||!RUN.test(runId))throw invalid('run_id');
 if(!FAMILIES.includes(family))throw invalid('family');
}

// The dry run (ADR 0215 decision 7, step 1). PURE: it writes nothing and reads nothing. `records` is the family's extraction at its extraction time, in manifest order:
// [{source:{kind:'d1_row',table,key,guard}|{kind:'r2_object',key,record,etag,r2,residualAccepted}, rows:[{evidence, filmId?}]}]. Returns {manifest, digest, report}.
// - Repeated inputs of ONE source (same token) are compared first: identical descriptors (guard fields, ETag) merge their rows into one record; contradictory descriptors make the
//   source a reported `source_conflict` and ALL its rows are left out. Never first-wins on contradictory data.
// - The first record in manifest order owns an `evidence_key`; a later record mapping to the same key with the same identity is a reported duplicate. Inputs of one key that
//   disagree on the semantic identity (`source_order` included) make the key a reported conflict, and it is left out of the manifest altogether.
// - An R2 record is eligible only from an object frozen by contract (`verified_films_after_a2`, `admin_action_applied`) and only when the owner accepts the residual window.
// - A record that yields no row or has more rows than a chunk holds is excluded and reported.
// - With nothing eligible (no records, all excluded, all conflicting) the result is a well-defined REPORT-ONLY dry run: `manifest` and `digest` are null, `report.disposition` is
//   `no_import`, and there is nothing to stage or approve. A dry run is not an import.
export async function planManifest({runId,family,cohortAt,writers,records}={}){
 checkRun(runId,family);
 const cohort=instant(cohortAt,'cohort_at');
 const writerList=checkWriters(writers===undefined?[...REQUIRED_WRITERS[family]]:writers,family);
 if(!Array.isArray(records))throw invalid('records');
 const report={duplicates:[],conflicts:[],excluded:[],r2Residual:[]};
 // Group the eligible inputs by source token, in manifest order, comparing every repeated descriptor with the first.
 const groups=new Map();
 for(const [index,record] of records.entries()){
  if(!plain(record)||!plain(record.source)||!Array.isArray(record.rows))throw invalid('record');
  let source;
  if(record.source.kind==='r2_object'){
   if(!R2_ELIGIBLE.includes(record.source.r2)){report.excluded.push({index,reason:'r2_not_frozen'});continue;}
   if(record.source.residualAccepted!==true){report.excluded.push({index,reason:'r2_residual_not_accepted'});continue;}
   source=r2Source(record.source);
  }else source=d1Source(record.source);
  const token=await sourceToken(source);
  const group=groups.get(token);
  if(!group)groups.set(token,{index,source,token,descriptor:describe(source),inputs:[...record.rows],indexes:[index],conflict:false});
  else{
   group.indexes.push(index);
   if(describe(source)!==group.descriptor)group.conflict=true;
   else group.inputs.push(...record.rows);
  }
 }
 const staged=[];
 for(const group of groups.values()){
  if(group.conflict){report.excluded.push({index:group.index,token:group.token,reason:'source_conflict'});report.conflicts.push({source:group.token,indexes:group.indexes,reason:'source_descriptor'});continue;}
  if(!group.inputs.length){report.excluded.push({index:group.index,token:group.token,reason:'no_rows'});continue;}
  if(group.inputs.length>MAX_ROWS_PER_CHUNK){report.excluded.push({index:group.index,token:group.token,reason:'record_too_large'});continue;}
  const rows=[];
  for(const input of group.inputs)rows.push(await manifestRow(runId,group.token,input));
  staged.push({index:group.index,source:group.source,token:group.token,rows});
 }
 // Keys: first in manifest order owns it; disagreement on the identity is a conflict and the key is dropped (inside ONE source too).
 const byKey=new Map();
 for(const record of staged)for(const row of record.rows){
  const entry=byKey.get(row.key);
  if(!entry)byKey.set(row.key,{first:{token:record.token,row},later:[]});
  else entry.later.push({token:record.token,row});
 }
 const dropped=new Set();
 for(const [key,entry] of byKey){
  const identity=identityOf(entry.first.row);
  const disagree=entry.later.filter(item=>identityOf(item.row)!==identity);
  if(disagree.length){dropped.add(key);report.conflicts.push({evidenceKey:key,sources:[entry.first.token,...entry.later.map(item=>item.token)]});continue;}
  for(const item of entry.later)report.duplicates.push({evidenceKey:key,owner:entry.first.token,duplicate:item.token});
 }
 const owned=new Set();
 const kept=[];
 for(const record of staged){
  const rows=[];
  record.rows.forEach((row,position)=>{
   if(dropped.has(row.key))return;
   const entry=byKey.get(row.key);
   if(owned.has(row.key))return;
   // The owner is the first occurrence in manifest order, which may be a row of this very record.
   if(entry.first.token!==record.token||entry.first.row!==row)return;
   owned.add(row.key);rows.push(row);
  });
  if(rows.length)kept.push({...record,rows});
  else report.excluded.push({index:record.index,token:record.token,reason:'no_rows_after_keys'});
 }
 const chunks=[];
 let current=null;
 for(const record of kept){
  if(!current||current.sources.length>=MAX_SOURCES_PER_CHUNK||current.rows.length+record.rows.length>MAX_ROWS_PER_CHUNK){current={chunkNo:chunks.length+1,sources:[],rows:[]};chunks.push(current);}
  const ordinal=current.sources.length+1;
  const entry=record.source.kind==='r2_object'?{ordinal,kind:'r2_object',key:record.source.key,record:record.source.record,etag:record.source.etag,token:record.token}
   :{ordinal,kind:'d1_row',table:record.source.table,key:record.source.key,guard:record.source.guard,token:record.token};
  current.sources.push(entry);
  for(const row of record.rows)current.rows.push({ordinal:current.rows.length+1,sourceOrdinal:ordinal,...row});
 }
 report.counts={chunks:chunks.length,sources:kept.length,rows:chunks.reduce((sum,chunk)=>sum+chunk.rows.length,0)};
 // The residual window of each frozen object, per chunk that re-reads it (ADR 0215 decision 7, step 6): the owner's GO accepts it by naming the digest.
 const byObject=new Map();
 chunks.forEach(chunk=>chunk.sources.forEach(source=>{if(source.kind!=='r2_object')return;const entry=byObject.get(source.key)||{key:source.key,etag:source.etag,chunks:new Set()};entry.chunks.add(chunk.chunkNo);byObject.set(source.key,entry);}));
 for(const entry of byObject.values())report.r2Residual.push({key:entry.key,etag:entry.etag,chunks:[...entry.chunks],window:'between the ETag re-read before each submission of these chunks and the D1 commit of each',accepted:true});
 if(!chunks.length){report.digest=null;report.disposition='no_import';return {manifest:null,digest:null,report};}
 const manifest={version:MANIFEST_VERSION,runId,family,cohortAt:cohort,writers:writerList,chunks};
 const digest=await manifestDigest(manifest);
 report.digest=digest;report.disposition='import_candidate';
 return {manifest,digest,report};
}

// The digest an import GO names: SHA-256 of the canonical JSON of the whole manifest.
export async function manifestDigest(manifest){return digestOf(validateManifest(manifest));}

// Structural validation: returns the manifest itself when it is a well-formed, self-consistent manifest, or throws `identity_evidence_import_invalid`. It re-derives every key, every
// source token and every bound, so a hand-edited manifest cannot reach the staging tables with an inconsistent key or source.
export function validateManifest(manifest){
 if(!plain(manifest)||manifest.version!==MANIFEST_VERSION)throw invalid('manifest_version');
 checkRun(manifest.runId,manifest.family);
 instant(manifest.cohortAt,'cohort_at');
 if(canonicalJson(checkWriters(manifest.writers,manifest.family))!==canonicalJson(manifest.writers))throw invalid('writers');
 if(!Array.isArray(manifest.chunks)||!manifest.chunks.length||manifest.chunks.length>100000)throw invalid('chunks');
 const keys=new Set(),tokens=new Set();
 manifest.chunks.forEach((chunk,index)=>{
  if(!plain(chunk)||chunk.chunkNo!==index+1||!Array.isArray(chunk.sources)||!Array.isArray(chunk.rows))throw invalid('chunk');
  if(!chunk.sources.length||chunk.sources.length>MAX_SOURCES_PER_CHUNK||!chunk.rows.length||chunk.rows.length>MAX_ROWS_PER_CHUNK)throw invalid('chunk_bounds');
  chunk.sources.forEach((source,position)=>{
   if(!plain(source)||source.ordinal!==position+1||typeof source.token!=='string'||!TOKEN.test(source.token)||tokens.has(source.token))throw invalid('source');
   tokens.add(source.token);
   if(source.kind==='r2_object'){r2Source(source);}
   else if(source.kind==='d1_row')d1Source(source);
   else throw invalid('source_kind');
  });
  chunk.rows.forEach((row,position)=>{
   if(!plain(row)||row.ordinal!==position+1||!HEX64.test(row.key||'')||keys.has(row.key))throw invalid('row');
   keys.add(row.key);
   const source=chunk.sources[row.sourceOrdinal-1];
   if(!source||row.reconstructedFrom!==source.token)throw invalid('row_source');
   if(row.filmId!==null&&(typeof row.filmId!=='string'||!FILM_ID.test(row.filmId)))throw invalid('film_id');
   if(Object.keys(row).sort().join()!==['key','ordinal','sourceOrdinal',...ROW_FIELDS].sort().join())throw invalid('row_fields');
  });
 });
 return manifest;
}
// The async half of the validation: every key re-derived from the row's own fields, every token from its source. Run by the load before anything is staged.
async function verifyManifest(manifest){
 validateManifest(manifest);
 for(const chunk of manifest.chunks){
  for(const source of chunk.sources){
   const expected=await sourceToken(source.kind==='r2_object'?{kind:'r2_object',key:source.key,record:source.record}:{kind:'d1_row',table:source.table,key:source.key});
   if(expected!==source.token)throw invalid('source_token');
  }
  for(const row of chunk.rows){
   const normalized=normalizeEvidence(normalizedInput({...row,reconstructionRun:manifest.runId}));
   if(await evidenceKeyOf(normalized)!==row.key)throw invalid('row_key');
   if(normalized.subjectKind!==row.subjectKind||normalized.subjectValue!==row.subjectValue||normalized.objectKind!==row.objectKind||normalized.objectValue!==row.objectValue)throw invalid('row_normal_form');
  }
 }
 return manifest;
}

// ---- the schema ----
// `absent` (no import tables and a version below 44: the legitimate state before migration 0044), `ready`, or `identity_evidence_import_unavailable` for anything else.
const TABLES="SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'identity_evidence_import_%') AS tables,(SELECT version FROM schema_contract WHERE id=1) AS version";
export async function identityEvidenceImportStatus(env){
 const db=database(env);
 if(!db)throw failed('identity_evidence_import_unavailable');
 let row;
 try{row=await one(db,TABLES);}catch(error){throw failed('identity_evidence_import_unavailable',error);}
 const tables=Number(row?.tables),version=Number(row?.version);
 if(tables===7&&version>=IMPORT_SCHEMA)return 'ready';
 if(tables===0&&Number.isFinite(version)&&version<IMPORT_SCHEMA)return 'absent';
 throw failed('identity_evidence_import_unavailable',new Error('identity_evidence_import_inconsistent_at_schema_'+row?.version));
}
async function ready(env){
 if(await identityEvidenceImportStatus(env)!=='ready')throw failed('identity_evidence_import_unavailable');
 const db=database(env);
 if(typeof db.batch!=='function')throw failed('identity_evidence_import_unavailable');
 return db;
}

// ---- reading the staging back ----
const RUN_COLUMNS='run_id,family,manifest_sha256,cohort_at,chunk_count,source_count,row_count,writers_json,state,attempt,lease_owner,lease_expires_at,stop_reason,created_at,updated_at';
const runOf=row=>row&&{runId:row.run_id,family:row.family,manifestSha256:row.manifest_sha256,cohortAt:row.cohort_at,chunkCount:Number(row.chunk_count),sourceCount:Number(row.source_count),rowCount:Number(row.row_count),
 writers:JSON.parse(row.writers_json),state:row.state,attempt:Number(row.attempt),leaseOwner:row.lease_owner??null,leaseExpiresAt:row.lease_expires_at??null,stopReason:row.stop_reason??null,createdAt:row.created_at,updatedAt:row.updated_at};
export async function readImportRun(env,runId){
 if(typeof runId!=='string'||!RUN.test(runId))throw invalid('run_id');
 const db=await ready(env);
 return runOf(await one(db,'SELECT '+RUN_COLUMNS+' FROM identity_evidence_import_run WHERE run_id=?',[runId]));
}
const sourceOf=row=>row.kind==='r2_object'?{ordinal:Number(row.ordinal),kind:'r2_object',key:row.source_key,record:row.record_ref,etag:row.etag,token:row.source_token}
 :{ordinal:Number(row.ordinal),kind:'d1_row',table:row.source_table,key:JSON.parse(row.source_key),guard:JSON.parse(row.guard_json),token:row.source_token};
const rowOf=row=>({ordinal:Number(row.ordinal),sourceOrdinal:Number(row.source_ordinal),key:row.evidence_key,filmId:row.film_id??null,subjectKind:row.subject_kind,subjectValue:row.subject_value,relation:row.relation,
 objectKind:row.object_kind??null,objectValue:row.object_value??null,polarity:row.polarity,route:row.route,method:row.method,sourceRoot:row.source_root??null,sourceRef:row.source_ref??null,sourceScope:row.source_scope??null,
 scopeEvidenceKey:row.scope_evidence_key??null,supersedesKey:row.supersedes_key??null,observedAt:row.observed_at??null,reconstructedFrom:row.reconstructed_from,sourceOrder:row.source_order===null||row.source_order===undefined?null:Number(row.source_order)});
const ROW_SELECT='SELECT ordinal,source_ordinal,evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,scope_evidence_key,supersedes_key,observed_at,reconstructed_from,source_order FROM identity_evidence_import_row WHERE run_id=?';
const SOURCE_SELECT='SELECT ordinal,kind,source_table,source_key,record_ref,guard_json,etag,source_token FROM identity_evidence_import_source WHERE run_id=?';
// The staged chunk as the chunk batch uses it: sources and rows read back from the database.
async function readStagedChunk(db,runId,chunkNo){
 const sources=(await many(db,SOURCE_SELECT+' AND chunk_no=? ORDER BY ordinal',[runId,chunkNo])).map(sourceOf);
 const rows=(await many(db,ROW_SELECT+' AND chunk_no=? ORDER BY ordinal',[runId,chunkNo])).map(rowOf);
 return {chunkNo,sources,rows};
}
// The whole manifest rebuilt from the run row and the staging tables. Its digest must equal the run's and the owner's.
export async function readStagedManifest(env,runId){
 const db=await ready(env);
 const run=runOf(await one(db,'SELECT '+RUN_COLUMNS+' FROM identity_evidence_import_run WHERE run_id=?',[runId]));
 if(!run)return null;
 const chunkRows=await many(db,'SELECT chunk_no FROM identity_evidence_import_chunk WHERE run_id=? ORDER BY chunk_no',[runId]);
 const chunks=[];
 for(const {chunk_no} of chunkRows)chunks.push(await readStagedChunk(db,runId,Number(chunk_no)));
 return {version:MANIFEST_VERSION,runId:run.runId,family:run.family,cohortAt:run.cohortAt,writers:run.writers,chunks};
}
// Reads the staging back and compares its digest with the run's and with the approved one. A difference stops the run (`staging_mismatch`) and throws. `fence` ({attempt, owner})
// is the lease of the caller when the run is `running`: only that attempt may stop it. A caller without one can stop a run only while it is `staging` or `sealed`.
export async function verifyStaging(env,runId,{approvedDigest,now,fence}={}){
 const run=await readImportRun(env,runId);
 if(!run)throw failed('identity_evidence_import_unknown_run');
 let digest=null;
 try{digest=await manifestDigest(await readStagedManifest(env,runId));}catch{digest=null;}
 if(digest!==run.manifestSha256||(approvedDigest!==undefined&&digest!==approvedDigest)){
  await stopRun(env,run,'staging_mismatch',clockOf(now)(),fence);
  throw failed('identity_evidence_import_staging_mismatch');
 }
 return {run,digest};
}

// A stop is a compare-and-swap on the state it saw. An attempt-originated stop (a moved source, a collision, a moved R2 object, a tampered staging found under a lease) names its
// attempt and owner and applies only while that attempt still holds the run, so a delayed, stale attempt can never stop its successor. Without a fence only `staging` and `sealed`
// runs (which hold no lease) are stopped. A separately authorized, unconditional stop of a running run is `stopImportRun`.
async function stopRun(env,run,reason,at,fence){
 if(!run||!['staging','sealed','running'].includes(run.state))return;
 const db=database(env);
 const when=instant(at,'now');
 try{
  if(fence)await db.batch([db.prepare("UPDATE identity_evidence_import_run SET state='stopped',stop_reason=?,updated_at=? WHERE run_id=? AND state='running' AND attempt=? AND lease_owner=?").bind(reason,when,run.runId,fence.attempt,fence.owner)]);
  else await db.batch([db.prepare("UPDATE identity_evidence_import_run SET state='stopped',stop_reason=?,updated_at=? WHERE run_id=? AND state IN ('staging','sealed')").bind(reason,when,run.runId)]);
 }catch{/* the original failure stands */}
}
// The operator's own, unconditional stop (reason `owner`): an owner decision to end a run in any non-terminal state, whoever holds the lease. A lease holder then fails its next
// receipt fence. It is a production operation when run for real, under its own GO.
export async function stopImportRun(env,{runId,now}={}){
 const db=await ready(env);
 if(typeof runId!=='string'||!RUN.test(runId))throw invalid('run_id');
 await db.batch([db.prepare("UPDATE identity_evidence_import_run SET state='stopped',stop_reason='owner',updated_at=? WHERE run_id=? AND state IN ('staging','sealed','running')").bind(instant(clockOf(now)(),'now'),runId)]);
 return readImportRun(env,runId);
}

// ---- load and seal ----
const BATCH_CAP=2000;
// Stages the manifest (ADR 0215 decision 7, step 2). Idempotent: a run that is already `staging` with the same digest takes the chunks it lacks, so a lost response is answered
// by sending again; each chunk is one atomic batch. The staging is read back and its digest recomputed (and compared with the approved one) before the function returns.
export async function loadManifest(env,{manifest,approvedDigest,now}={}){
 const db=await ready(env);
 await verifyManifest(manifest);
 const digest=await manifestDigest(manifest);
 if(!HEX64.test(approvedDigest||'')||approvedDigest!==digest)throw failed('identity_evidence_import_digest_mismatch');
 const at=instant(clockOf(now)(),'now');
 const rowCount=manifest.chunks.reduce((sum,chunk)=>sum+chunk.rows.length,0),sourceCount=manifest.chunks.reduce((sum,chunk)=>sum+chunk.sources.length,0);
 let run=await readImportRun(env,manifest.runId);
 if(!run){
  try{await db.batch([db.prepare('INSERT INTO identity_evidence_import_run (run_id,family,manifest_sha256,cohort_at,chunk_count,source_count,row_count,writers_json,state,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
   .bind(manifest.runId,manifest.family,digest,manifest.cohortAt,manifest.chunks.length,sourceCount,rowCount,canonicalJson(manifest.writers),'staging',0,at,at)]);}
  catch(error){
   // A concurrent loader created it: continue only if it is the same manifest.
   run=await readImportRun(env,manifest.runId);
   if(!run)throw failed('identity_evidence_import_unavailable',error);
  }
  run=await readImportRun(env,manifest.runId);
 }
 if(run.manifestSha256!==digest||run.family!==manifest.family)throw failed('identity_evidence_import_digest_mismatch');
 if(run.state!=='staging')throw failed('identity_evidence_import_sealed');
 const present=new Set((await many(db,'SELECT chunk_no FROM identity_evidence_import_chunk WHERE run_id=?',[manifest.runId])).map(row=>Number(row.chunk_no)));
 for(const chunk of manifest.chunks){
  if(present.has(chunk.chunkNo))continue;
  const statements=[db.prepare('INSERT INTO identity_evidence_import_chunk (run_id,chunk_no,source_count,row_count) VALUES (?,?,?,?)').bind(manifest.runId,chunk.chunkNo,chunk.sources.length,chunk.rows.length)];
  for(const source of chunk.sources){
   statements.push(db.prepare('INSERT INTO identity_evidence_import_source (run_id,chunk_no,ordinal,kind,source_table,source_key,record_ref,guard_json,etag,source_token) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(manifest.runId,chunk.chunkNo,source.ordinal,source.kind,source.kind==='d1_row'?source.table:null,source.kind==='d1_row'?canonicalJson(source.key):source.key,source.kind==='r2_object'?source.record:null,source.kind==='d1_row'?canonicalJson(source.guard):null,source.kind==='r2_object'?source.etag:null,source.token));
  }
  for(const row of chunk.rows){
   statements.push(db.prepare('INSERT INTO identity_evidence_import_row (run_id,chunk_no,ordinal,source_ordinal,evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,scope_evidence_key,supersedes_key,observed_at,reconstructed_from,source_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(manifest.runId,chunk.chunkNo,row.ordinal,row.sourceOrdinal,row.key,row.filmId,row.subjectKind,row.subjectValue,row.relation,row.objectKind,row.objectValue,row.polarity,row.route,row.method,row.sourceRoot,row.sourceRef,row.sourceScope,row.scopeEvidenceKey,row.supersedesKey,row.observedAt,row.reconstructedFrom,row.sourceOrder));
  }
  if(statements.length>BATCH_CAP)throw invalid('chunk_statements');
  await db.batch(statements);
 }
 await verifyStaging(env,manifest.runId,{approvedDigest,now});
 return {runId:manifest.runId,digest,state:'staging',chunks:manifest.chunks.length,sources:sourceCount,rows:rowCount};
}

// The atomic seal (ADR 0215 decision 7, step 2): ONE statement whose trigger asserts that no seal exists, that the staged counts equal the declared ones per chunk and in total
// and that the digest is the run's, then flips the run to `sealed`. The operator then reads the staging back once more; any difference abandons the run.
export async function sealRun(env,{runId,approvedDigest,now}={}){
 const db=await ready(env);
 if(typeof runId!=='string'||!RUN.test(runId)||!HEX64.test(approvedDigest||''))throw invalid('seal_input');
 const at=instant(clockOf(now)(),'now');
 const before=await verifyStaging(env,runId,{approvedDigest,now});
 const run=before.run;
 if(run.state==='sealed'||run.state==='running'||run.state==='complete')return {runId,digest:before.digest,state:run.state,sealed:false};
 if(run.state!=='staging')throw failed('identity_evidence_import_run_state');
 try{await db.batch([db.prepare('INSERT INTO identity_evidence_import_seal (run_id,manifest_sha256,chunk_count,source_count,row_count,sealed_at) VALUES (?,?,?,?,?,?)').bind(runId,before.digest,run.chunkCount,run.sourceCount,run.rowCount,at)]);}
 catch(error){
  const message=String(error?.message||error);
  if(/identity_evidence_import_seal_mismatch/.test(message)){await stopRun(env,run,'staging_mismatch',at);throw failed('identity_evidence_import_staging_mismatch',error);}
  throw failed('identity_evidence_import_unavailable',error);
 }
 const after=await verifyStaging(env,runId,{approvedDigest,now});
 const sealed=await readImportRun(env,runId);
 if(sealed.state!=='sealed')throw failed('identity_evidence_import_run_state');
 return {runId,digest:after.digest,state:'sealed',sealed:true};
}
export async function loadAndSealManifest(env,input={}){
 const loaded=await loadManifest(env,input);
 const sealed=await sealRun(env,{runId:loaded.runId,approvedDigest:input.approvedDigest,now:input.now});
 return {...loaded,state:sealed.state};
}

// ---- the import ----
// The database's OWN clock, in the ISO form of every stored time. Every lease decision uses it (in the triggers of migration 0044 and here), never a caller-supplied timestamp.
const DB_NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const leaseModifier=leaseMs=>'+'+(leaseMs/1000).toFixed(3)+' seconds';
async function dbNow(db){return String((await one(db,'SELECT '+DB_NOW+' AS now')).now);}

const LEDGER_INSERT='INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,scope_evidence_key,supersedes_key,observed_at,origin,reconstruction_run,reconstructed_from,request_id,recorded_at,source_order) '
 +"SELECT s.evidence_key,s.film_id,s.subject_kind,s.subject_value,s.relation,s.object_kind,s.object_value,s.polarity,s.route,s.method,s.source_root,s.source_ref,s.source_scope,s.scope_evidence_key,s.supersedes_key,s.observed_at,'reconstruction',s.run_id,s.reconstructed_from,?,?,s.source_order "
 +'FROM identity_evidence_import_row AS s WHERE s.run_id=? AND s.chunk_no=? ORDER BY s.ordinal ON CONFLICT(evidence_key) DO NOTHING';
// The semantic identity of ADR 0215 decision 7, step 3, between a staged row `s` and the ledger row `l` of its key: proposition, polarity, route, method, root (or, for a null root, the
// `reconstructed_from` substitute), `source_scope`, `scope_evidence_key`, supersession and `source_order`. ONE predicate, used by the chunk assertion, the diagnosis and the report.
const SAME_IDENTITY='l.subject_kind=s.subject_kind AND l.subject_value=s.subject_value AND l.relation=s.relation AND l.object_kind IS s.object_kind AND l.object_value IS s.object_value AND l.polarity=s.polarity AND l.route=s.route AND l.method=s.method '
 +'AND ((s.source_root IS NOT NULL AND l.source_root IS s.source_root) OR (s.source_root IS NULL AND l.source_root IS NULL AND l.reconstructed_from IS s.reconstructed_from)) '
 +'AND l.source_scope IS s.source_scope AND l.scope_evidence_key IS s.scope_evidence_key AND l.supersedes_key IS s.supersedes_key AND l.source_order IS s.source_order';
// For every staged row the ledger row with its key has the staged semantic identity. A missing row, a different identity or a different or unknown `source_order` is a collision.
const IDENTITY_ASSERT='NOT EXISTS (SELECT 1 FROM identity_evidence_import_row AS s WHERE s.run_id=? AND s.chunk_no=? AND NOT EXISTS (SELECT 1 FROM film_identity_evidence AS l WHERE l.evidence_key=s.evidence_key AND '+SAME_IDENTITY+'))';
// The receipt: the four counts are computed from what the ledger holds after the insert. A staged key with no ledger row counts nowhere, so the sum check refuses the receipt.
const RECEIPT_INSERT='INSERT INTO identity_evidence_import_receipt (run_id,chunk_no,attempt,staged_keys,inserted,already_imported,live_covered,reconstructed_equivalent,recorded_at) '
 +"SELECT s.run_id,s.chunk_no,?,COUNT(*),"
 +"COALESCE(SUM(CASE WHEN l.origin='reconstruction' AND l.reconstruction_run=s.run_id THEN 1 ELSE 0 END),0),"
 +"COALESCE(SUM(CASE WHEN l.origin='reconstruction' AND l.reconstruction_run<>s.run_id AND l.reconstructed_from IS s.reconstructed_from THEN 1 ELSE 0 END),0),"
 +"COALESCE(SUM(CASE WHEN l.origin='live' THEN 1 ELSE 0 END),0),"
 +"COALESCE(SUM(CASE WHEN l.origin='reconstruction' AND l.reconstruction_run<>s.run_id AND l.reconstructed_from IS NOT s.reconstructed_from THEN 1 ELSE 0 END),0),?"
 +' FROM identity_evidence_import_row AS s LEFT JOIN film_identity_evidence AS l ON l.evidence_key=s.evidence_key WHERE s.run_id=? AND s.chunk_no=? GROUP BY s.run_id,s.chunk_no';

// The statements of one chunk, built from the STAGED rows read back from the database. Exported so a test can check the budgets. The lease assertion is evaluated on the database's own
// clock at commit (`at` is only the time recorded on the rows), and the receipt trigger checks it again: a batch prepared before the lease expired cannot commit after it.
export function chunkStatements({run,chunk,attempt,at}){
 const requestId='reconstruction:'+run.runId+':'+chunk.chunkNo;
 const statements=[];
 const push=(sql,params)=>statements.push([sql,params]);
 push(assertSql("EXISTS (SELECT 1 FROM identity_evidence_import_run WHERE run_id=? AND state='running' AND attempt=? AND manifest_sha256=? AND lease_expires_at>"+DB_NOW+')'),[run.runId,attempt,run.manifestSha256]);
 push(assertSql('(SELECT COUNT(*) FROM identity_evidence_import_receipt WHERE run_id=?)=?'),[run.runId,chunk.chunkNo-1]);
 for(const source of chunk.sources){
  if(source.kind!=='d1_row')continue;
  const condition=guardCondition(source);
  push(assertSql(condition.sql),condition.params);
 }
 push(LEDGER_INSERT,[requestId,at,run.runId,chunk.chunkNo]);
 push(assertSql(IDENTITY_ASSERT),[run.runId,chunk.chunkNo]);
 push(RECEIPT_INSERT,[attempt,at,run.runId,chunk.chunkNo]);
 return statements;
}

const receiptOf=row=>row&&{runId:row.run_id,chunkNo:Number(row.chunk_no),attempt:Number(row.attempt),stagedKeys:Number(row.staged_keys),inserted:Number(row.inserted),alreadyImported:Number(row.already_imported),
 liveCovered:Number(row.live_covered),reconstructedEquivalent:Number(row.reconstructed_equivalent),recordedAt:row.recorded_at};
const RECEIPT_SELECT='SELECT run_id,chunk_no,attempt,staged_keys,inserted,already_imported,live_covered,reconstructed_equivalent,recorded_at FROM identity_evidence_import_receipt WHERE run_id=?';
async function readReceipt(db,runId,chunkNo){return receiptOf(await one(db,RECEIPT_SELECT+' AND chunk_no=?',[runId,chunkNo]));}
const totalsOf=receipts=>{
 const totals={stagedKeys:0,inserted:0,alreadyImported:0,liveCovered:0,reconstructedEquivalent:0};
 for(const receipt of receipts){totals.stagedKeys+=receipt.stagedKeys;totals.inserted+=receipt.inserted;totals.alreadyImported+=receipt.alreadyImported;totals.liveCovered+=receipt.liveCovered;totals.reconstructedEquivalent+=receipt.reconstructedEquivalent;}
 return totals;
};

const STOP_CODES=Object.freeze({source_moved:'identity_evidence_import_source_moved',collision:'identity_evidence_import_collision',r2_moved:'identity_evidence_import_r2_moved'});
// An attempt-originated stop: a compare-and-swap on the caller's own attempt and owner. If it did not apply because the run moved on (a successor took the lease, the owner stopped it),
// the caller is a stale attempt and gets `lease_lost`, and the successor is untouched.
async function stopWith(env,db,run,reason,at,fence){
 await stopRun(env,run,reason,at,fence);
 const after=runOf(await one(db,'SELECT '+RUN_COLUMNS+' FROM identity_evidence_import_run WHERE run_id=?',[run.runId]));
 if(after?.state==='stopped'&&after.stopReason===reason)throw failed(STOP_CODES[reason]);
 throw failed('identity_evidence_import_lease_lost');
}

// Why a chunk batch refused. The statements are rolled back whole, so nothing landed; this reads the cause to name it (a stale lease, a moved source record, a collision) and stops
// the run where the owner must decide. Anything it cannot name is rethrown as it was.
async function diagnose(env,db,run,chunk,fence,error){
 const current=runOf(await one(db,'SELECT '+RUN_COLUMNS+' FROM identity_evidence_import_run WHERE run_id=?',[run.runId]));
 const now=await dbNow(db);
 if(!current||current.state!=='running'||current.attempt!==fence.attempt||current.leaseOwner!==fence.owner||Date.parse(current.leaseExpiresAt)<=Date.parse(now))throw failed('identity_evidence_import_lease_lost',error);
 for(const source of chunk.sources){
  if(source.kind!=='d1_row')continue;
  const condition=guardCondition(source);
  if(!await one(db,'SELECT 1 AS ok WHERE '+condition.sql,condition.params))await stopWith(env,db,current,'source_moved',now,fence);
 }
 const clash=await one(db,'SELECT 1 AS clash FROM identity_evidence_import_row AS s WHERE s.run_id=? AND s.chunk_no=? AND NOT EXISTS (SELECT 1 FROM film_identity_evidence AS l WHERE l.evidence_key=s.evidence_key AND '+SAME_IDENTITY
  +') AND EXISTS (SELECT 1 FROM film_identity_evidence AS x WHERE x.evidence_key=s.evidence_key) LIMIT 1',[run.runId,chunk.chunkNo]);
 if(clash)await stopWith(env,db,current,'collision',now,fence);
 const message=String(error?.message||error);
 // The ledger's own trigger refused a staged row (a shape the ledger does not admit): permanent for this manifest, so it is not retried; the owner re-runs the dry run.
 if(/film_identity_evidence_[a-z_]+/.test(message))throw failed('identity_evidence_import_ledger_refused',error);
 // The receipt fence refused while this attempt's lease is live and the sources hold: a writer the run names went `pending` (or a family `b` writer is not `on`). The chunk rolled back
 // whole; the run stays `running`.
 if(/identity_evidence_import_receipt_fence/.test(message))throw failed('identity_evidence_import_blocked',error);
 // Anything else (a transient storage error): the run stays `running`, the chunk may be sent again.
 throw error;
}

const sameRun=(run,digest)=>run.manifestSha256===digest;
// The claim: every comparison is the database's (the UPDATE's own WHERE and the run triggers), the JS only decides which statement to try.
async function claim(db,run,{owner,leaseMs,at}){
 const now=await dbNow(db);
 const modifier=leaseModifier(leaseMs);
 const expiry="strftime('%Y-%m-%dT%H:%M:%fZ','now',?)";
 if(run.state==='sealed'){
  await db.batch([db.prepare("UPDATE identity_evidence_import_run SET state='running',attempt=1,lease_owner=?,lease_expires_at="+expiry+",updated_at=? WHERE run_id=? AND state='sealed'").bind(owner,modifier,at,run.runId)]);
 }else if(run.state==='running'){
  const expired=Date.parse(run.leaseExpiresAt)<=Date.parse(now);
  if(!expired&&run.leaseOwner!==owner)throw failed('identity_evidence_import_lease_held');
  if(expired)await db.batch([db.prepare("UPDATE identity_evidence_import_run SET attempt=attempt+1,lease_owner=?,lease_expires_at="+expiry+",updated_at=? WHERE run_id=? AND state='running' AND attempt=? AND lease_expires_at<="+DB_NOW).bind(owner,modifier,at,run.runId,run.attempt)]);
  else await db.batch([db.prepare("UPDATE identity_evidence_import_run SET lease_expires_at="+expiry+",updated_at=? WHERE run_id=? AND state='running' AND attempt=? AND lease_owner=? AND lease_expires_at>"+DB_NOW).bind(modifier,at,run.runId,run.attempt,owner)]);
 }else throw failed('identity_evidence_import_run_state');
}

// Runs the import of a sealed run (ADR 0215 decision 7, steps 3-7), chunk by chunk, until it is complete or `maxChunks` chunks were sent in this call.
// input: {runId, approvedDigest, owner, now?, leaseMs?, readEtag?, maxChunks?, retries?}
// - `approvedDigest` is the digest of the owner's GO; a different digest is `identity_evidence_import_digest_mismatch` and nothing is claimed.
// - The lease is the database's: the first claim is attempt 1; a live lease of another owner is `identity_evidence_import_lease_held`; an expired one is taken over by a NEW attempt
//   (resume). A chunk sent under a stale attempt, or delivered after the lease expired, fails the run assertion and the receipt's fence and writes nothing
//   (`identity_evidence_import_lease_lost`). `now` only stamps the recorded rows.
// - The claimed staging is read back once more under the lease (no chunk runs without the seal); a mismatch stops the run through this attempt's compare-and-swap only.
// - R2 sources: `readEtag(key)` is re-read before EVERY submission of a chunk that uses the object (the first send and each retry, after a possible receipt was settled); a difference
//   stops the run (`r2_moved`) and nothing is sent.
// - A lost response is settled by the chunk's receipt: present means done, absent means the same chunk is sent again (at most `retries` times, default 2).
// Returns {state, done, chunks:[receipt...], totals}.
export async function importRun(env,input={}){
 const db=await ready(env);
 const {runId,approvedDigest,owner}=input;
 if(typeof runId!=='string'||!RUN.test(runId)||!HEX64.test(approvedDigest||'')||typeof owner!=='string'||!OWNER.test(owner))throw invalid('import_input');
 const clock=clockOf(input.now);
 const leaseMs=input.leaseMs===undefined?60000:input.leaseMs;
 if(!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>3600000)throw invalid('lease_ms');
 const maxChunks=input.maxChunks===undefined?Infinity:input.maxChunks;
 if(maxChunks!==Infinity&&(!Number.isSafeInteger(maxChunks)||maxChunks<1))throw invalid('max_chunks');
 const retries=input.retries===undefined?2:input.retries;
 let run=await readImportRun(env,runId);
 if(!run)throw failed('identity_evidence_import_unknown_run');
 if(!sameRun(run,approvedDigest))throw failed('identity_evidence_import_digest_mismatch');
 const summary=async()=>{
  const receipts=(await many(db,RECEIPT_SELECT+' ORDER BY chunk_no',[runId])).map(receiptOf);
  const state=(await readImportRun(env,runId)).state;
  return {runId,state,done:state==='complete',chunks:receipts,totals:totalsOf(receipts)};
 };
 if(run.state==='complete')return summary();
 if(run.state==='stopped')throw failed('identity_evidence_import_stopped');
 if(run.state==='staging')throw failed('identity_evidence_import_not_sealed');
 try{await claim(db,run,{owner,leaseMs,at:instant(clock(),'now')});}
 catch(error){
  if(error?.code)throw error;
  throw failed('identity_evidence_import_blocked',error);
 }
 run=await readImportRun(env,runId);
 // Another claimer won the race and has already finished or stopped the run: report what is true, change nothing.
 if(run.state==='complete')return summary();
 if(run.state==='stopped')throw failed('identity_evidence_import_stopped');
 if(run.state!=='running'||run.leaseOwner!==owner){
  // The claim matched no row: another claimer won the race, or a writer the run depends on is not in the state it needs.
  throw failed(run.state==='running'?'identity_evidence_import_lease_held':'identity_evidence_import_blocked');
 }
 const attempt=run.attempt;
 const fence={attempt,owner};
 // No chunk runs without the seal: under the lease, the staging is read back and its digest recomputed once per claim.
 await verifyStaging(env,runId,{approvedDigest,now:clock,fence});
 let sent=0;
 for(;;){
  const received=Number((await one(db,'SELECT COUNT(*) AS n FROM identity_evidence_import_receipt WHERE run_id=?',[runId])).n);
  if(received>=run.chunkCount)break;
  if(sent>=maxChunks)return summary();
  const chunkNo=received+1;
  // Renew the lease while this attempt still holds it and less than half of it is left (the database's clock decides, and refuses a stale attempt).
  const live=await readImportRun(env,runId);
  if(live.state!=='running'||live.attempt!==attempt||live.leaseOwner!==owner)throw failed('identity_evidence_import_lease_lost');
  const now=await dbNow(db);
  if(Date.parse(live.leaseExpiresAt)-Date.parse(now)<leaseMs/2){
   try{await db.batch([db.prepare("UPDATE identity_evidence_import_run SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),updated_at=? WHERE run_id=? AND state='running' AND attempt=? AND lease_owner=? AND lease_expires_at>"+DB_NOW).bind(leaseModifier(leaseMs),instant(clock(),'now'),runId,attempt,owner)]);}
   catch(error){throw failed('identity_evidence_import_lease_lost',error);}
  }
  const chunk=await readStagedChunk(db,runId,chunkNo);
  const objects=[...new Map(chunk.sources.filter(source=>source.kind==='r2_object').map(source=>[source.key,source.etag])).entries()];
  for(let tries=0;;tries++){
   // R2 objects cannot be asserted inside D1: every pinned ETag is re-read before EVERY actual submission, so a retry never sends a chunk against an object that moved meanwhile. The
   // approved residual window is the read immediately before one commit attempt, not a chain of retries.
   for(const [key,pinned] of objects){
    if(typeof input.readEtag!=='function')throw failed('identity_evidence_import_r2_unavailable');
    let etag=null;
    try{etag=await input.readEtag(key);}catch(error){throw failed('identity_evidence_import_r2_unavailable',error);}
    if(etag!==pinned)await stopWith(env,db,run,'r2_moved',await dbNow(db),fence);
   }
   const at=instant(clock(),'now');
   const statements=chunkStatements({run,chunk,attempt,at});
   try{
    await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));
    if(!await readReceipt(db,runId,chunkNo))throw failed('identity_evidence_import_unavailable',new Error('receipt_not_found_after_commit'));
    break;
   }catch(error){
    // A lost response: the receipt decides. Present means the batch committed (and is never undone); absent means it did not, and the same chunk may be sent again (idempotent).
    const receipt=await readReceipt(db,runId,chunkNo).catch(()=>null);
    if(receipt&&receipt.attempt===attempt)break;
    if(receipt)throw failed('identity_evidence_import_lease_lost',error);
    if(/identity_evidence_import_receipt_fence|identity_evidence_import_run_transition|film_identity_evidence_[a-z_]+|CHECK constraint failed/.test(String(error?.message||'')))await diagnose(env,db,run,chunk,fence,error);
    if(tries>=retries||error?.code==='identity_evidence_import_unavailable')throw error;
    // A transient failure: read the cause once, then send the same chunk again (after the ETag re-read above).
    await diagnose(env,db,run,chunk,fence,error).catch(next=>{if(next!==error)throw next;});
   }
  }
  sent++;
 }
 await db.batch([db.prepare("UPDATE identity_evidence_import_run SET state='complete',updated_at=? WHERE run_id=? AND state='running' AND attempt=? AND lease_owner=? AND lease_expires_at>"+DB_NOW).bind(instant(clock(),'now'),runId,attempt,owner)]);
 return summary();
}

// Read-only status of a run: its row, receipts, totals, the `reconstructed_equivalent` pairs and the residual window of every R2 object.
// - The pairs (both source records, ADR 0215 decision 7, step 3: reported, never counted as corroboration, independence or coverage) are restricted to RECEIPTED chunks and to the exact
//   identity predicate of the chunk batch, so a chunk that never committed or collided is never reported; `equivalentsMatchReceipts` says their count equals the receipts' total.
// - `r2Objects` states, per frozen object, the pinned ETag, the chunks that re-read it and the residual window the owner's GO accepted (ADR 0215 decision 7, step 6).
export async function readImportReport(env,runId){
 const db=await ready(env);
 const run=await readImportRun(env,runId);
 if(!run)return null;
 const receipts=(await many(db,RECEIPT_SELECT+' ORDER BY chunk_no',[runId])).map(receiptOf);
 const totals=totalsOf(receipts);
 const equivalents=(await many(db,'SELECT s.evidence_key,s.reconstructed_from AS staged_from,l.reconstructed_from AS existing_from,l.reconstruction_run AS existing_run FROM identity_evidence_import_row AS s '
  +'JOIN identity_evidence_import_receipt AS r ON r.run_id=s.run_id AND r.chunk_no=s.chunk_no JOIN film_identity_evidence AS l ON l.evidence_key=s.evidence_key '
  +"WHERE s.run_id=? AND l.origin='reconstruction' AND l.reconstruction_run<>s.run_id AND l.reconstructed_from IS NOT s.reconstructed_from AND "+SAME_IDENTITY+' ORDER BY s.chunk_no,s.ordinal',[runId]))
  .map(row=>({evidenceKey:row.evidence_key,stagedFrom:row.staged_from,existingFrom:row.existing_from,existingRun:row.existing_run}));
 const objects=new Map();
 for(const row of await many(db,"SELECT source_key,etag,chunk_no FROM identity_evidence_import_source WHERE run_id=? AND kind='r2_object' ORDER BY chunk_no,ordinal",[runId])){
  const entry=objects.get(row.source_key)||{key:row.source_key,etag:row.etag,chunks:[],records:0};
  entry.records++;
  if(!entry.chunks.includes(Number(row.chunk_no)))entry.chunks.push(Number(row.chunk_no));
  objects.set(row.source_key,entry);
 }
 const r2Objects=[...objects.values()].map(entry=>({...entry,receiptedChunks:entry.chunks.filter(chunk=>receipts.some(receipt=>receipt.chunkNo===chunk)),
  window:'between the ETag re-read before each submission of chunks '+entry.chunks.join(',')+' and the D1 commit of each; accepted by the owner\'s GO naming the manifest digest'}));
 return {run,receipts,totals,equivalents,equivalentsMatchReceipts:equivalents.length===totals.reconstructedEquivalent,r2Objects};
}
