// AIR-637 / ADR 0215 (Accepted), card EC: the identity evidence writer control and the domain-path insert helper (migration 0042, a file only).
// DORMANT by control: since card E2c (AIR-619) the Worker bundle carries this module, but only `src/discovery-owner-evidence.js` (the Discovery owner write) calls `domainEvidenceStatements`
// and `src/discovery-authority.js` calls `readWriter`; `changeWriter` is reachable from no Worker module. A writer with no control row is `off`, so until the owner-approved activation
// operation (`changeWriter`, outside the Worker) flips it nothing is written. Card E2a wires the Discovery decision writer the same way.
// Nothing here READS the ledger to decide anything (ADR 0213 decision 8).
//
// What it provides:
// - `readWriter`: the control row of a writer (absent or a schema without the control tables = `off`, generation 0).
// - `planDomainEvidence`: the normalized row and key of a live domain-path row of a Discovery writer (an observation as a candidate for a TMDB movie or TV id). The key is
//   the one of ADR 0213 decision 4, unchanged; `source_order` (owner rows) is part of the semantic identity but not of the key.
// - `domainEvidenceStatements`: the two statements a domain batch appends (ADR 0215 decision 1): an insert that writes only while the writer is `pending` or `on`
//   (`ON CONFLICT (evidence_key) DO NOTHING`), and an assertion that passes for `off`/absent, a new row and a valid duplicate, and fails (rolling the domain batch back) for a
//   missing row or a row under the same key with another semantic identity. On a schema without the control tables it returns ONE guard statement instead (see below).
// - `changeWriter`: the activation/break operator (ADR 0215 decision 4): `activate` (`off -> pending`), `drain_complete` (`pending -> on`, with drain evidence and the
//   coverage start), `deactivate` (`pending|on -> off`) and `break` (`pending|on -> off` with the deployment that broke the interval). Each is ONE statement: the change row,
//   whose trigger applies the transition to the control row (history and control are inseparable), compare-and-swap on `generation` (the triggers of migration 0042 enforce
//   it). Each is an owner-approved production operation when run for real.
import {database,failed,many,one} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';
import {evidenceKeyOf,normalizeEvidence,KNOWN_ALIAS_SCOPES} from './identity-evidence.js';

export const WRITER_SCHEMA=42;
export const WRITERS=Object.freeze(['discovery_decision','discovery_owner','claim_alias_bridge','tmdb_retirement_decision','tmdb_retirement_application']);
export const WRITER_STATES=Object.freeze(['off','pending','on']);
export const CHANGE_KINDS=Object.freeze(['activate','drain_complete','deactivate','break']);
// The domain-path writers of this record: the Discovery decision and owner writers. The claim bridge is canonical-path (E2b) and the retirement writers are parked (E2d).
export const DOMAIN_WRITERS=Object.freeze({
 discovery_decision:Object.freeze({route:'discovery_scan',methods:Object.freeze(['tmdb_detail_check','known_alias']),owner:false}),
 discovery_owner:Object.freeze({route:'owner_action',methods:Object.freeze(['owner_statement']),owner:true}),
});

const REASON=/^[^\x00-\x1f\x7f]{1,500}$/u;
const VERSION=/^[\x21-\x7e]{1,100}$/;
const LINK=/^[\x21-\x7e]{1,500}$/;
const REQUEST=/^[\x21-\x7e]{1,200}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const TABLES="SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('identity_evidence_writer','identity_evidence_writer_change')) AS tables,(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='film_identity_evidence') AS ledger,(SELECT version FROM schema_contract WHERE id=1) AS version";
const invalid=reason=>{const error=failed('identity_evidence_writer_invalid');error.reason=reason;return error;};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const clockOf=now=>typeof now==='function'?now:()=>now||new Date().toISOString();
const instant=(value,reason)=>{
 if(typeof value!=='string'||!ISO.test(value)||!Number.isFinite(Date.parse(value)))throw invalid(reason);
 return new Date(Date.parse(value)).toISOString();
};
const writerName=writer=>{if(!WRITERS.includes(writer))throw invalid('writer');return writer;};

// `absent` (no control tables, the legitimate state before migration 0042: every writer reads as `off`), `ready`, or `film_person_unavailable` for anything else (an
// unreadable database, version 42 or later with a table missing, or control tables without the ledger): fail closed, never read a damaged schema as "no control".
export async function identityEvidenceControlStatus(env){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 let row;
 try{row=await one(db,TABLES);}catch(error){throw failed('film_person_unavailable',error);}
 const tables=Number(row?.tables),version=Number(row?.version),ledger=Number(row?.ledger)===1;
 if(tables===2&&ledger&&version>=WRITER_SCHEMA)return 'ready';
 if(tables===0&&Number.isFinite(version)&&version<WRITER_SCHEMA)return 'absent';
 throw failed('film_person_unavailable',new Error('identity_evidence_control_inconsistent_at_schema_'+row?.version));
}

// The control row of a writer. An absent row, and a schema without the control tables, is `off` at generation 0 (ADR 0215 decision 4).
export async function readWriter(env,writer){
 writerName(writer);
 const OFF={writer,state:'off',generation:0,coverageFrom:null,updatedAt:null,present:false};
 if(await identityEvidenceControlStatus(env)==='absent')return OFF;
 const row=await one(database(env),'SELECT writer,state,generation,coverage_from,updated_at FROM identity_evidence_writer WHERE writer=?',[writer]);
 if(!row)return OFF;
 return {writer:row.writer,state:row.state,generation:Number(row.generation),coverageFrom:row.coverage_from??null,updatedAt:row.updated_at,present:true};
}

export async function readWriterChanges(env,writer){
 writerName(writer);
 if(await identityEvidenceControlStatus(env)==='absent')return [];
 return many(database(env),'SELECT seq,writer,kind,from_state,to_state,generation,reason,deployed_version,evidence_link,drain_evidence,break_from,recorded_at FROM identity_evidence_writer_change WHERE writer=? ORDER BY seq',[writer]);
}

// Pure (async only for SHA-256). The live domain-path row of a Discovery writer and its key, accepted ONLY in the shapes of ADR 0215 Table 3 (decision 5); the pure model of
// `normalizeEvidence` keeps the wider vocabulary for future and reconstructed data. input as `normalizeEvidence`, plus `sourceOrder` (an owner row of `discovery_owner`: the
// observation's history revision of the batch that wrote the action, decision 6).
// - `discovery_decision`: `candidate_for(observation, tmdb_movie|tmdb_tv)`, `asserts`, route `discovery_scan`, method `tmdb_detail_check` or `known_alias` (with its variant in
//   `source_scope`), the **source root equal to the observation key** (so a re-check of one observation is one root, never independent corroboration), no `source_order`.
//   A title method, `title_year_search` or a `restricts` row is not written by this writer.
// - `discovery_owner`: `candidate_for(observation, tmdb_movie)` only (never TV), route `owner_action`, method `owner_statement`, `asserts` (an assign) or `refutes` (a reject, or a
//   scoped revoke naming its target's key, which may not exist yet), the root the intent's key, and a `source_order`. No `restricts`.
// Anything else is `identity_evidence_out_of_slice`; a live row without root or time is refused by the model first. A domain-path row names no Film.
export async function planDomainEvidence(writer,input){
 writerName(writer);
 const spec=DOMAIN_WRITERS[writer];
 if(!spec)throw failed('identity_evidence_out_of_slice');
 const row=normalizeEvidence(input);
 const refuse=()=>{throw failed('identity_evidence_out_of_slice');};
 if(row.origin!=='live'||row.relation!=='candidate_for'||row.subjectKind!=='discovery_observation')refuse();
 if(row.route!==spec.route||!spec.methods.includes(row.method)||row.supersedesKey!==null)refuse();
 if(spec.owner){
  if(row.objectKind!=='tmdb_movie'||!['asserts','refutes'].includes(row.polarity))refuse();
  // Owner rows are ordered by their source, never by `seq`: no order, no row. Only a refutation is scoped.
  if(row.sourceOrder===null)refuse();
  if(row.scopeEvidenceKey!==null&&row.polarity!=='refutes')refuse();
  if(row.sourceScope!==null)refuse();
 }else{
  if(!['tmdb_movie','tmdb_tv'].includes(row.objectKind)||row.polarity!=='asserts')refuse();
  if(row.sourceRoot!==row.subjectValue)refuse();
  if(row.sourceOrder!==null||row.scopeEvidenceKey!==null)refuse();
  if(row.method==='known_alias'?!KNOWN_ALIAS_SCOPES.includes(row.sourceScope):row.sourceScope!==null)refuse();
 }
 return Object.freeze({writer,row,evidenceKey:await evidenceKeyOf(row)});
}

const COLUMNS='evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,scope_evidence_key,supersedes_key,observed_at,origin,reconstruction_run,reconstructed_from,request_id,recorded_at,source_order';
// Unbound (film_id NULL: a domain row names no Film). The row is written only while its writer is `pending` or `on`; an existing key is a no-op.
const INSERT='INSERT INTO film_identity_evidence ('+COLUMNS+') SELECT ?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM identity_evidence_writer WHERE writer=? AND state IN (\'pending\',\'on\')) ON CONFLICT(evidence_key) DO NOTHING';
// Semantic identity (ADR 0215 decision 1): proposition, polarity, route, method, root (or its substitute), `source_scope`, `scope_evidence_key`, supersession and `source_order`.
// `IS` so a NULL equals a NULL. The substitute of an unknown root is `reconstructed_from`; a live row has a root.
const SAME='SELECT 1 FROM film_identity_evidence WHERE evidence_key=? AND subject_kind=? AND subject_value=? AND relation=? AND object_kind IS ? AND object_value IS ? AND polarity=? AND route=? AND method=? AND source_root IS ? AND reconstructed_from IS ? AND source_scope IS ? AND scope_evidence_key IS ? AND supersedes_key IS ? AND source_order IS ?';
// Commit-time schema guard of a batch prepared without the control tables.
export const ABSENT="NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('identity_evidence_writer','identity_evidence_writer_change'))";
const ACTIVE="EXISTS (SELECT 1 FROM identity_evidence_writer WHERE writer=? AND state IN ('pending','on'))";

// The statements of one evidence row, for the caller to append INSIDE its own domain batch (ADR 0215 decision 1). On a schema WITHOUT the control tables they are ONE guard
// statement, never nothing: it asserts at COMMIT time that the tables are still absent, so a batch prepared before migration 0042 was applied cannot commit after the
// migration and an activation without its evidence row (that would be a silent gap inside a claimed coverage interval); it fails the domain batch instead, and the caller
// replans, which reads the schema again and now gets the insert and the assertion. Otherwise: the conditional insert and the assertion. The helper never returns an
// empty list, so an integration cannot omit the guard by treating no evidence as nothing to append. `assertSql` builds the caller's own assertion statement from a condition (each domain has its own CAS
// table; the default is the Film/Person one, for a canonical-path caller and for tests). Pass `params` of the condition in the order the statement takes them.
// It does not test `changes() = 1`: a valid duplicate changes nothing. The assertion passes when the writer is `off` or absent, or the row with the key has the planned
// semantic identity, so it passes for a new row and a valid duplicate and fails for a missing row (the writer flipped to `on`... or the insert was skipped) and for a
// mismatching row, including a matching owner row with another causal position.
export async function domainEvidenceStatements(env,plan,{requestId,at,assertSql=fenced.assertSql}={}){
 if(!plan||!plain(plan.row)||!/^[0-9a-f]{64}$/.test(plan.evidenceKey||'')||!DOMAIN_WRITERS[plan.writer])throw failed('identity_evidence_out_of_slice');
 if(typeof requestId!=='string'||!REQUEST.test(requestId))throw invalid('request_id');
 const recorded=instant(at,'at');
 if(await identityEvidenceControlStatus(env)==='absent')return [[assertSql(ABSENT),[]]];
 const r=plan.row;
 const insert=[INSERT,[plan.evidenceKey,r.subjectKind,r.subjectValue,r.relation,r.objectKind,r.objectValue,r.polarity,r.route,r.method,r.sourceRoot,r.sourceRef,r.sourceScope,
  r.scopeEvidenceKey,r.supersedesKey,r.observedAt,r.origin,r.reconstructionRun,r.reconstructedFrom,requestId,recorded,r.sourceOrder,plan.writer]];
 const assertion=[assertSql('NOT '+ACTIVE+' OR EXISTS ('+SAME+')'),[plan.writer,plan.evidenceKey,r.subjectKind,r.subjectValue,r.relation,r.objectKind,r.objectValue,r.polarity,r.route,r.method,
  r.sourceRoot,r.sourceRoot===null?r.reconstructedFrom:null,r.sourceScope,r.scopeEvidenceKey,r.supersedesKey,r.sourceOrder]];
 return [insert,assertion];
}

// The transitions of ADR 0215 decision 4, by kind.
const TRANSITIONS=Object.freeze({
 activate:{from:['off'],to:'pending'},
 drain_complete:{from:['pending'],to:'on'},
 deactivate:{from:['pending','on'],to:'off'},
 break:{from:['pending','on'],to:'off'},
});

// One transition of one writer: the operator's compare-and-swap (ADR 0215 decision 4), run only under an owner-approved production operation.
// input: {writer, kind, expectedGeneration, reason, deployedVersion, evidenceLink, drainEvidence? (drain_complete), breakFrom? (break), now?}
// - `expectedGeneration` is the generation the operator read (0 for an absent row); a different live generation is `identity_evidence_writer_stale`, and writes nothing.
// - A repeated `activate` of a writer that is already `pending` is a no-op at the same generation ({noop:true}), so an interrupted activation can be re-run safely.
// - A transition the state does not allow (for example `pending -> on` from `off`) is `identity_evidence_writer_transition`; `drain_complete` without drain evidence and
//   `break` without the deployment time are refused before any statement.
// - One statement: the change row; its trigger is the compare-and-swap and applies the transition to the control row.
export async function changeWriter(env,input={}){
 if(!plain(input))throw invalid('input');
 const writer=writerName(input.writer);
 const kind=input.kind;
 if(!CHANGE_KINDS.includes(kind))throw invalid('kind');
 const rule=TRANSITIONS[kind];
 if(!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<0)throw invalid('expected_generation');
 if(typeof input.reason!=='string'||!REASON.test(input.reason))throw invalid('reason');
 if(typeof input.deployedVersion!=='string'||!VERSION.test(input.deployedVersion))throw invalid('deployed_version');
 if(typeof input.evidenceLink!=='string'||!LINK.test(input.evidenceLink))throw invalid('evidence_link');
 const now=instant(clockOf(input.now)(),'now');
 let drain=null,breakFrom=null;
 if(kind==='drain_complete'){
  if(typeof input.drainEvidence!=='string'||!input.drainEvidence.trim()||input.drainEvidence.length>1000||/[\x00-\x08\x0b-\x1f\x7f]/.test(input.drainEvidence))throw invalid('drain_evidence');
  drain=input.drainEvidence;
 }else if(input.drainEvidence!==undefined&&input.drainEvidence!==null)throw invalid('drain_evidence');
 if(kind==='break'){
  breakFrom=instant(input.breakFrom,'break_from');
  if(Date.parse(breakFrom)>Date.parse(now))throw invalid('break_from');
 }else if(input.breakFrom!==undefined&&input.breakFrom!==null)throw invalid('break_from');
 if(await identityEvidenceControlStatus(env)!=='ready')throw failed('identity_evidence_writer_unavailable');
 const db=database(env);
 if(typeof db.batch!=='function')throw failed('film_person_unavailable');
 const current=await readWriter(env,writer);
 if(kind==='activate'&&current.state==='pending'&&current.generation===input.expectedGeneration)return {noop:true,writer,state:'pending',generation:current.generation};
 if(current.generation!==input.expectedGeneration)throw failed('identity_evidence_writer_stale');
 if(!rule.from.includes(current.state))throw failed('identity_evidence_writer_transition');
 const generation=current.generation+1;
 // ONE statement: the change row. Its trigger applies the transition to the control row (first activation inserts it, any other updates it by generation), so history
 // and control are inseparable and the compare-and-swap is the trigger's, not this code's.
 const change=['INSERT INTO identity_evidence_writer_change (writer,kind,from_state,to_state,generation,reason,deployed_version,evidence_link,drain_evidence,break_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  [writer,kind,current.state,rule.to,generation,input.reason,input.deployedVersion,input.evidenceLink,drain,breakFrom,now]];
 try{await db.batch([db.prepare(change[0]).bind(...change[1])]);}
 catch(error){
  const message=String(error?.message||error);
  if(/identity_evidence_writer_change_stale|identity_evidence_writer_change_taken|UNIQUE constraint failed: identity_evidence_writer_change/i.test(message))throw failed('identity_evidence_writer_stale',error);
  if(/identity_evidence_writer_transition|CHECK constraint failed/i.test(message))throw failed('identity_evidence_writer_transition',error);
  throw failed('identity_evidence_writer_unavailable',error);
 }
 // The batch is atomic, so the control row is now this generation; the readback is the operator's evidence.
 const after=await readWriter(env,writer);
 if(after.generation!==generation||after.state!==rule.to)throw failed('identity_evidence_writer_unavailable',new Error('readback_mismatch'));
 return {noop:false,writer,kind,from:current.state,state:after.state,generation:after.generation,coverageFrom:after.coverageFrom,recordedAt:now};
}
