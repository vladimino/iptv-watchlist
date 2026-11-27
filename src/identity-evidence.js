// AIR-601 / ADR 0213 (Accepted), card E1 of the ADR 0207 delivery graph: the Film identity evidence ledger, initial slice (migrations/0041_film_identity_evidence.sql).
// DORMANT: nothing in the Worker imports this module, it is not bundled, and no route, Workflow, cron or producer calls it. Card A1 wires the admission routes to it at
// ADR 0207 mode `d1`; until then the table stays empty. Nothing here READS the ledger to decide anything (ADR 0213 decision 8): ADR 0184 keeps the Ratings marks,
// ADR 0170 its exact archive join, and the catalog and Discovery their own reads.
//
// What it provides:
// - `normalizeEvidence` and `evidenceKeyOf`: the pure model of ADR 0213 decisions 1-4 (typed subject, relation and object; route and method; three polarities;
//   `same_work` stored in canonical order; the evidence key over the normalized proposition, polarity, route, method, source root (or, only when the root is unknown on a
//   reconstructed row, the source record), source scope, scoped row and superseded row). They admit reconstructed rows too, so the key is defined once for the live
//   writers and the later reconstruction (cards E3a and E3b), which this card does not build.
// - `planIdentityEvidence` + `evidenceInsertStatement`: the writer helper for a live row of the initial slice, appended by a caller INSIDE its own fenced batch, so the
//   evidence and its canonical effect commit together or not at all (ADR 0213 decision 4). The insert is a no-op on an existing key.
// - `recordIdentityEvidence`: the receipted `identity_evidence` operation for a genuine check without a canonical effect (keep-first no-op admission, a second archive).
//   It runs under the Film/Person fence (marker generation and the Film's revision), its target is the existing Film, its request id derives from the evidence key and the
//   Film, and it is a no-op (no receipt, no batch) on an existing key.
// - `identityEvidenceOperation`: the operation spec a reconciler registers (readback, replay, revalidate), atomic mode only.
//
// The initial slice (ADR 0213 decision 7) is the ONLY shape a live writer here accepts: `same_work` between a Letterboxd entity (lid or short code) and a TMDB movie,
// either `restricts` by `title_year_search` from `letterboxd_export_import` (the inferred import), or `asserts` by `page_check` from `ratings_diary`, `watchlist_admission`
// or `letterboxd_rated_archive`. Every row is Film-bound. Unbound observations, the Discovery, claim, owner and retirement writers, scoped refutations and supersessions
// are later cards (EP, E2a-d) and are refused here with `identity_evidence_out_of_slice`; the schema already admits them.
//
// No verification, no evidence: a live row needs the source root the check produced and the time it was performed. A caller that did not perform its method has
// neither and must not call this module (a retry answering `present` from the admission row writes nothing).
import {assertWritable,database,failed,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';
import {RETRY_POLICY,defineOperation,digestOf,receiptedWrite,requestIdOf} from './canonical-receipts.js';

export const IDENTITY_EVIDENCE_SCHEMA=41;
export const IDENTITY_EVIDENCE_TABLE='film_identity_evidence';
export const IDENTITY_EVIDENCE_OPERATION='identity_evidence';
export const IDENTITY_EVIDENCE_ORIGIN='identity_evidence';
// A row recorded by another request while this receipt's own batch never landed (atomic mode): the receipt is abandoned with this class, never applied.
export const EVIDENCE_PRESENT='identity_evidence_present';
// A replan that no longer gives this receipt's key, Film or digest: the typed terminal abandon of ADR 0123 decision 5 (the same class as the producer adapters' SOURCE_CHANGED;
// not imported, so this module stays outside the producer layers).
export const SOURCE_CHANGED='producer_source_changed';

export const SOURCE_ENTITY_KINDS=Object.freeze(['letterboxd_lid','letterboxd_short_code','tmdb_movie','tmdb_tv']);
export const SUBJECT_KINDS=Object.freeze([...SOURCE_ENTITY_KINDS,'discovery_observation','film']);
export const RELATIONS=Object.freeze(['same_work','film_has_id','candidate_for','exists']);
export const POLARITIES=Object.freeze(['asserts','restricts','refutes']);
export const ROUTES=Object.freeze(['epg_programme','discovery_scan','letterboxd_export_import','letterboxd_rated_archive','ratings_diary','watchlist_admission','ratings_alias_bridge','owner_action','unknown']);
export const METHODS=Object.freeze(['title_only','title_year','title_year_search','tmdb_detail_check','page_check','alias_bridge','owner_statement','known_alias']);
export const ORIGINS=Object.freeze(['live','reconstruction']);
// The routes of the page check in the initial slice (ADR 0213 decision 7): one method, three routes.
export const PAGE_CHECK_ROUTES=Object.freeze(['ratings_diary','watchlist_admission','letterboxd_rated_archive']);

const LETTERBOXD=new Set(['letterboxd_lid','letterboxd_short_code']);
const TMDB_KINDS=new Set(['tmdb_movie','tmdb_tv']);
const VALUE={
 letterboxd_lid:/^[A-Za-z0-9_-]{1,80}$/,
 letterboxd_short_code:/^[A-Za-z0-9_-]{1,40}$/,
 tmdb_movie:/^[1-9]\d{0,11}$/,
 tmdb_tv:/^[1-9]\d{0,11}$/,
 film:/^film:[\x21-\x7e]{1,295}$/,
 // A Discovery observation key is `normalizedTitle|year`: any title script, no control character, at most 300 characters (the SQL bound counts characters).
 discovery_observation:/^[^\x00-\x1f\x7f]{1,300}$/u,
};
const HEX64=/^[0-9a-f]{64}$/;
// A source root, reference or scope, a reconstruction run or source record: printable ASCII, at most 300 characters (the SQL CHECK bound), never empty.
const TOKEN=/^[\x21-\x7e]{1,300}$/;
const RUN=/^[\x21-\x7e]{1,200}$/;
const REQUEST=/^[\x21-\x7e]{1,200}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const invalid=reason=>{const error=failed('identity_evidence_invalid');error.reason=reason;return error;};
const clockOf=now=>typeof now==='function'?now:()=>now||new Date().toISOString();
function instant(value,reason){
 if(typeof value!=='string'||!ISO.test(value))throw invalid(reason);
 const ms=Date.parse(value);
 if(!Number.isFinite(ms))throw invalid(reason);
 return new Date(ms).toISOString();
}
function optional(value,pattern,reason){
 if(value===undefined||value===null)return null;
 if(typeof value!=='string'||!pattern.test(value))throw invalid(reason);
 return value;
}
function entity(value,reason){
 if(!plain(value)||!SUBJECT_KINDS.includes(value.kind))throw invalid(reason);
 const text=typeof value.value==='number'&&Number.isInteger(value.value)?String(value.value):value.value;
 if(typeof text!=='string'||!VALUE[value.kind].test(text))throw invalid(reason);
 if(value.kind==='discovery_observation'&&/^(film|person):/.test(text))throw invalid(reason);
 return {kind:value.kind,value:text};
}
const sortKey=item=>item.kind+':'+item.value;

// Pure. One evidence row in its normalized form, or `identity_evidence_invalid` (with a `reason`) for anything outside the model of ADR 0213 decisions 1-6. The rules are
// the same as the migration's CHECKs and shape trigger, so a row that passes here is one the table accepts (the database checks them again).
// input: {subject:{kind,value}, relation, object?:{kind,value}|null, polarity, route, method, sourceRoot?, sourceRef?, sourceScope?, scopeEvidenceKey?, supersedesKey?,
//         observedAt?, origin?:'live'|'reconstruction', reconstructionRun?, reconstructedFrom?}
export function normalizeEvidence(input){
 if(!plain(input))throw invalid('not_an_object');
 const relation=input.relation;
 if(!RELATIONS.includes(relation))throw invalid('relation');
 let subject=entity(input.subject,'subject');
 let object=input.object===undefined||input.object===null?null:entity(input.object,'object');
 if((relation==='exists')!==(object===null))throw invalid('object');
 if(object&&!SOURCE_ENTITY_KINDS.includes(object.kind))throw invalid('object');
 if(relation==='same_work'){
  if(!SOURCE_ENTITY_KINDS.includes(subject.kind))throw invalid('subject');
  // ADR 0213 decision 4: the symmetric relation is stored in canonical `kind:value` order, so A-B and B-A are one proposition and one key.
  if(sortKey(subject)===sortKey(object))throw invalid('same_work_self');
  if(sortKey(subject)>sortKey(object))[subject,object]=[object,subject];
 }
 if((relation==='film_has_id')!==(subject.kind==='film'))throw invalid('subject');
 if(relation==='candidate_for'&&(subject.kind!=='discovery_observation'||!TMDB_KINDS.has(object.kind)))throw invalid('candidate_for');
 const polarity=input.polarity,route=input.route,method=input.method;
 if(!POLARITIES.includes(polarity))throw invalid('polarity');
 if(!ROUTES.includes(route))throw invalid('route');
 if(!METHODS.includes(method))throw invalid('method');
 if(method==='title_year_search'&&polarity!=='restricts')throw invalid('title_year_search_is_never_proof');
 if(polarity==='refutes'&&method!=='owner_statement'&&method!=='page_check')throw invalid('refutes_method');
 const origin=input.origin===undefined?'live':input.origin;
 if(!ORIGINS.includes(origin))throw invalid('origin');
 // The Discovery root is the observation key (`normalizedTitle|year`, ADR 0215 decision 5): any title script and spaces, like the subject itself. Every other root stays a token.
 const sourceRoot=optional(input.sourceRoot,route==='discovery_scan'?VALUE.discovery_observation:TOKEN,'source_root');
 const sourceRef=optional(input.sourceRef,TOKEN,'source_ref');
 const sourceScope=optional(input.sourceScope,TOKEN,'source_scope');
 const scopeEvidenceKey=optional(input.scopeEvidenceKey,HEX64,'scope_evidence_key');
 const supersedesKey=optional(input.supersedesKey,HEX64,'supersedes_key');
 if(scopeEvidenceKey!==null&&polarity!=='refutes')throw invalid('scope_evidence_key');
 const observedAt=input.observedAt===undefined||input.observedAt===null?null:instant(input.observedAt,'observed_at');
 const reconstructionRun=optional(input.reconstructionRun,RUN,'reconstruction_run');
 const reconstructedFrom=optional(input.reconstructedFrom,TOKEN,'reconstructed_from');
 // ADR 0215 decision 6: the causal position of an owner row in its own source. Not part of the key; only an owner row carries one.
 const sourceOrder=input.sourceOrder===undefined||input.sourceOrder===null?null:input.sourceOrder;
 if(sourceOrder!==null&&(!Number.isSafeInteger(sourceOrder)||sourceOrder<1||route!=='owner_action'))throw invalid('source_order');
 if(origin==='live'){
  if(reconstructionRun!==null||reconstructedFrom!==null)throw invalid('live_reconstruction_fields');
  // No verification, no evidence (ADR 0213 decision 4): a live row comes only from a step that performed its method, so it carries the root that check produced and
  // the time it ran. Unknowns are allowed only on a reconstructed row.
  if(route==='unknown')throw invalid('unknown_route_is_reconstruction_only');
  if(sourceRoot===null)throw invalid('unchecked_no_source_root');
  if(observedAt===null)throw invalid('unchecked_no_observed_at');
 }else if(reconstructionRun===null||reconstructedFrom===null)throw invalid('reconstruction_provenance');
 return Object.freeze({subjectKind:subject.kind,subjectValue:subject.value,relation,objectKind:object?object.kind:null,objectValue:object?object.value:null,
  polarity,route,method,sourceRoot,sourceRef,sourceScope,scopeEvidenceKey,supersedesKey,observedAt,origin,reconstructionRun,reconstructedFrom,sourceOrder});
}

// Pure (async only for SHA-256). The evidence key of a normalized row (ADR 0213 decisions 4-6): sha256 over the canonical JSON of the normalized proposition, polarity,
// route, method, source root, source scope, scoped row and superseded row. When the root is unknown (a reconstructed row only), the exact source record takes its place:
// two records with unknown roots stay two rows and a repeated import of one record is one key; the reconstruction run is never part of it. `source_ref`, the observation
// time and the bound Film are not part of it: the same route checking the same root is the same row.
export async function evidenceKeyOf(row){
 const r=normalizeEvidence(denormalize(row));
 return digestOf({v:1,subject:[r.subjectKind,r.subjectValue],relation:r.relation,object:r.objectKind===null?null:[r.objectKind,r.objectValue],polarity:r.polarity,route:r.route,method:r.method,
  root:r.sourceRoot,reconstructedFrom:r.sourceRoot===null?r.reconstructedFrom:null,scope:r.sourceScope,scopeEvidenceKey:r.scopeEvidenceKey,supersedesKey:r.supersedesKey});
}
// Accepts a normalized row or a raw input, so the key is always computed over the normalized form.
function denormalize(row){
 if(!plain(row)||row.subjectKind===undefined)return row;
 return {subject:{kind:row.subjectKind,value:row.subjectValue},relation:row.relation,object:row.objectKind===null?null:{kind:row.objectKind,value:row.objectValue},polarity:row.polarity,route:row.route,method:row.method,
  sourceRoot:row.sourceRoot,sourceRef:row.sourceRef,sourceScope:row.sourceScope,scopeEvidenceKey:row.scopeEvidenceKey,supersedesKey:row.supersedesKey,observedAt:row.observedAt,origin:row.origin,
  reconstructionRun:row.reconstructionRun,reconstructedFrom:row.reconstructedFrom,sourceOrder:row.sourceOrder};
}

// Pure. The strength a reader derives from a row (ADR 0213 decision 3, amended by ADR 0215 Q1-a): the ledger stores none. `known_alias` is ranked by method AND
// `source_scope` together: `known_epg_alias` alongside `title_only`, `known_alias_year_runtime` alongside `title_year`, and a missing or unknown scope never defaults to a
// stronger tier (it ranks with `title_only`). `title_year_search` is never proof. Neither title method nor `known_alias` is proof; only `proof` rows are.
export const KNOWN_ALIAS_SCOPES=Object.freeze(['known_epg_alias','known_alias_year_runtime']);
export function evidenceStrength(row){
 if(!plain(row)||!METHODS.includes(row.method))throw invalid('method');
 const scope=row.sourceScope===undefined?null:row.sourceScope;
 switch(row.method){
  case 'owner_statement':return {tier:'owner',rank:4,proof:true};
  case 'page_check':case 'tmdb_detail_check':case 'alias_bridge':return {tier:'verified',rank:3,proof:true};
  case 'title_year':return {tier:'title_year',rank:2,proof:false};
  case 'known_alias':return scope==='known_alias_year_runtime'?{tier:'title_year',rank:2,proof:false}:{tier:'title_only',rank:1,proof:false};
  case 'title_only':return {tier:'title_only',rank:1,proof:false};
  default:return {tier:'never_proof',rank:0,proof:false};
 }
}

// Pure. Whether a normalized row is one of the initial slice's live shapes (ADR 0213 decision 7).
export function initialSliceShape(row){
 // AIR-675 / ADR 0217 decision 7: the ONE Film-bound `film_has_id` live shape this helper accepts, written by the attach batch (the migration triggers already admit it): `asserts`, `film_has_id(film, tmdb_movie)`,
 // route `owner_action`, method `page_check`, rooted in the attach root, no scope and no supersession. Anything else of this relation (another object kind, polarity, route or method) stays out of the slice.
 if(row&&row.origin==='live'&&row.relation==='film_has_id')return row.subjectKind==='film'&&row.objectKind==='tmdb_movie'&&row.polarity==='asserts'&&row.route==='owner_action'&&row.method==='page_check'
  &&row.scopeEvidenceKey===null&&row.supersedesKey===null&&row.sourceScope===null&&row.sourceOrder===null&&typeof row.sourceRoot==='string'&&HEX64.test(row.sourceRoot);
 if(!row||row.origin!=='live'||row.relation!=='same_work'||row.scopeEvidenceKey!==null||row.supersedesKey!==null)return false;
 // Canonical order puts the Letterboxd entity first (`letterboxd_*` sorts before `tmdb_movie`).
 if(!LETTERBOXD.has(row.subjectKind)||row.objectKind!=='tmdb_movie')return false;
 if(row.polarity==='restricts')return row.route==='letterboxd_export_import'&&row.method==='title_year_search';
 // ADR 0213 decisions 2 and 4 (scenarios 6 and 8): an archive check is per archive, so the rated-archive route names its archive in `source_scope`; without it two archives
 // checking the same root would collapse into one key. The general model keeps the scope optional for other routes and for reconstruction.
 if(row.polarity==='asserts')return row.method==='page_check'&&PAGE_CHECK_ROUTES.includes(row.route)&&(row.route!=='letterboxd_rated_archive'||row.sourceScope!==null);
 return false;
}

// The live writers' plan: the normalized row of the initial slice and its key. Anything else is refused before any statement.
export async function planIdentityEvidence(input){
 const row=normalizeEvidence(input);
 if(!initialSliceShape(row))throw failed('identity_evidence_out_of_slice');
 return Object.freeze({row,evidenceKey:await evidenceKeyOf(row)});
}

const INSERT='INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,scope_evidence_key,supersedes_key,observed_at,origin,reconstruction_run,reconstructed_from,request_id,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(evidence_key) DO NOTHING';
// The one statement a caller appends to ITS OWN fenced batch (before its revision bump) so the evidence commits with its canonical effect or not at all. A replay of the
// same key inserts nothing. `filmId` is the batch's receipted target (the admitted or existing Film), `requestId` the batch's receipt request id, `at` the batch clock.
export function evidenceInsertStatement(plan,{filmId,requestId,at}={}){
 if(!plan||!plain(plan.row)||!HEX64.test(plan.evidenceKey||'')||!initialSliceShape(plan.row))throw failed('identity_evidence_out_of_slice');
 const r=plan.row;
 if(typeof requestId!=='string'||!REQUEST.test(requestId))throw invalid('request_id');
 // A `film_has_id` row names the Film it is about: it must be the very Film this batch writes (the survivor, not a spelling taken blindly).
 if(r.relation==='film_has_id'&&r.subjectValue!==fenced.filmId(filmId))throw failed('identity_evidence_out_of_slice');
 return [INSERT,[plan.evidenceKey,fenced.filmId(filmId),r.subjectKind,r.subjectValue,r.relation,r.objectKind,r.objectValue,r.polarity,r.route,r.method,r.sourceRoot,r.sourceRef,r.sourceScope,
  r.scopeEvidenceKey,r.supersedesKey,r.observedAt,r.origin,r.reconstructionRun,r.reconstructedFrom,requestId,instant(at,'at')]];
}

// `absent` (schema below 41 and no table: the legitimate pre-migration state), `ready`, or `film_person_unavailable` thrown for anything else (an unreadable database,
// a version at or above 41 without the table): the writer fails closed and never treats a damaged schema as "no ledger".
export async function identityEvidenceStatus(env){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 let row;
 try{row=await one(db,"SELECT (SELECT version FROM schema_contract WHERE id=1) AS version,(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='film_identity_evidence') AS present");}
 catch(error){throw failed('film_person_unavailable',error);}
 const version=Number(row?.version),present=Number(row?.present)===1;
 if(present&&version>=IDENTITY_EVIDENCE_SCHEMA)return 'ready';
 if(!present&&Number.isFinite(version)&&version<IDENTITY_EVIDENCE_SCHEMA)return 'absent';
 throw failed('film_person_unavailable',new Error('film_identity_evidence_inconsistent_at_schema_'+row?.version));
}

export async function readEvidence(env,evidenceKey){
 if(!HEX64.test(evidenceKey||''))throw invalid('evidence_key');
 return one(database(env),'SELECT seq,evidence_key,film_id,request_id FROM film_identity_evidence WHERE evidence_key=?',[evidenceKey]);
}

// The request id of the evidence-only operation: derived from the evidence key and the bound Film only (no clock, no source reference), so the same check of the same
// root always names the same receipt, and a lost response is answered by reading it (ADR 0207 decision 3). The Film is in it so a key whose earlier attempt targeted a
// Film that was merged away since gets its own receipt on the survivor instead of a receipt conflict.
export async function identityEvidenceRequestId({evidenceKey,filmId}={}){
 if(!HEX64.test(evidenceKey||''))throw invalid('evidence_key');
 return requestIdOf({origin:IDENTITY_EVIDENCE_ORIGIN,operation:IDENTITY_EVIDENCE_OPERATION,source:{evidenceKey,filmId:fenced.filmId(filmId)}});
}
// The receipt's planned-content digest: the key and the Film. The observation time and the source reference stay out, as a clock stays out of every request identity.
export async function identityEvidenceDigest({evidenceKey,filmId}={}){
 if(!HEX64.test(evidenceKey||''))throw invalid('evidence_key');
 return digestOf({operation:IDENTITY_EVIDENCE_OPERATION,evidenceKey,filmId:fenced.filmId(filmId)});
}

const revisionOf=async(db,id)=>Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?",[id]))?.revision??0);
const TRIGGER=/film_identity_evidence_[a-z_]+/;

// The fenced batch of the evidence-only operation: the marker generation (and a bound producer fence), the Film's revision, the Film present and not redirected, the
// evidence insert (a no-op on an existing key), the revision bump and, with a `receiptMark`, the receipt's atomic tail.
async function writeEvidence(env,{plan,filmId,expectedRevision,requestId,at,receiptMark}){
 const id=fenced.filmId(filmId),expected=fenced.revisionOf(expectedRevision);
 const tail=fenced.receiptTail(receiptMark,{kind:'film',id});
 const insert=evidenceInsertStatement(plan,{filmId:id,requestId,at});
 const gate=fenced.bindProducerFence(env,assertWritable(await readAuthority(env)));
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 statements.push(insert);
 // The Film's revision is not a key-wide guard: another request (another Film's evidence-only call, or an admission batch) can record the same key between this
 // operation's absence read and its batch, and the insert above is then a silent no-op. The batch therefore asserts that the row with the key is ITS OWN before the
 // revision bump and the receipt tail, so a receipt is applied only by the batch that wrote its evidence.
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film_identity_evidence WHERE evidence_key=? AND request_id=?)'),[plan.evidenceKey,requestId]]);
 statements.push([fenced.BUMP,['film',id,instant(at,'at')]]);
 try{await fenced.commit(env,gate,statements,entities,tail);}
 catch(error){
  const named=TRIGGER.exec(String(error?.cause?.message||''));
  if(error?.code==='film_person_unavailable'&&named)throw failed(named[0],error);
  // A refused assertion (ownership, revision or precondition) with the key now recorded by another request is the lost race: typed, permanent, never applied.
  if(['film_person_precondition','film_person_revision_conflict'].includes(error?.code)){
   let row=null;
   try{row=await readEvidence(env,plan.evidenceKey);}catch{/* the original error stands */}
   if(row&&row.request_id!==requestId)throw failed(EVIDENCE_PRESENT,error);
  }
  throw error;
 }
 return {id,revision:expected+1};
}

// What the operation re-plans from: the caller's `replan(receipt)` answers {evidence, filmId} (the receipt stores no payload). `ok` is true only when that input gives
// the receipt's own key, Film and digest.
async function planned(replan,receipt){
 let input=null;
 try{input=await replan(receipt);}catch(error){if(['film_person_unavailable','film_person_held','film_person_not_open'].includes(error?.code))throw error;input=null;}
 if(!input)return null;
 try{
  const plan=await planIdentityEvidence(input.evidence);
  const ok=input.filmId===receipt.target.id&&(await identityEvidenceDigest({evidenceKey:plan.evidenceKey,filmId:input.filmId}))===receipt.contentDigest;
  return {input,plan,ok};
 }catch{return {input,plan:null,ok:false};}
}

// The receipt operation of `identity_evidence` (atomic mode only): what a reconciler registers. `replan(receipt)` -> {evidence, filmId} | null.
// - readback: the source moved (another key, Film or digest) is a typed terminal abandon; a row with the key recorded by ANOTHER request (this receipt's batch never landed,
//   or it would be applied) abandons it as `identity_evidence_present`; otherwise nothing landed and the receipt may be replayed.
// - replay: the same fenced batch against the current revision.
// - revalidate: an unrelated write moved the Film's revision; the evidence-only batch has no precondition on the Film's content, so it proceeds while the Film exists,
//   is not redirected and the key is still absent.
export function identityEvidenceOperation({replan=async()=>null,now}={}){
 if(typeof replan!=='function')throw failed('film_person_invalid');
 const clock=clockOf(now);
 return defineOperation({
  operation:IDENTITY_EVIDENCE_OPERATION,atomic:true,
  readback:async(env,target,receipt)=>{
   const db=database(env);
   const found=await planned(replan,receipt);
   if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};
   if(found&&await readEvidence(env,found.plan.evidenceKey))return {disposition:'abandon',errorClass:EVIDENCE_PRESENT};
   return {digest:null,revision:await revisionOf(db,target.id)};
  },
  replay:async(env,receipt,ctx)=>{
   const found=await planned(replan,receipt);
   if(!found)throw failed('producer_replan_unavailable');
   if(!found.ok)throw failed('film_person_invalid');
   return writeEvidence(env,{plan:found.plan,filmId:receipt.target.id,expectedRevision:ctx.currentRevision,requestId:receipt.requestId,at:clock(),
    receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target}});
  },
  revalidate:async(env,receipt)=>{
   const found=await planned(replan,receipt);
   if(!found||!found.ok)return 'stale';
   const db=database(env);
   const read=await one(db,'SELECT (SELECT id FROM film WHERE id=?) AS film,(SELECT 1 FROM film_redirect WHERE from_id=?) AS redirected',[receipt.target.id,receipt.target.id]);
   if(!read?.film||read?.redirected)return 'stale';
   return await readEvidence(env,found.plan.evidenceKey)?'superseded':'proceed';
  },
 });
}

// The evidence-only operation (ADR 0213 decision 4; ADR 0207 decision 3): records ONE live evidence row of the initial slice for an EXISTING Film when the check that
// produced it has no canonical effect. input: {evidence, filmId, now?, policy?, replan?}.
// - An existing key is a no-op: no receipt, no batch ({state:'present', receipt:false}).
// - Otherwise one receipt (`identity_evidence`, origin `identity_evidence`, target the Film) and ONE fenced batch that inserts the row, bumps the Film's revision and
//   applies the receipt atomically. A lost response is settled by the receipt: `applied` means the row exists.
// Refused before any write: a shape outside the initial slice, an unchecked row (no root or time), a missing or redirected Film, the schema absent, the marker not `open`
// or the receipt table not ready.
export async function recordIdentityEvidence(env,input={}){
 const plan=await planIdentityEvidence(input.evidence);
 const filmId=fenced.filmId(input.filmId);
 const status=await identityEvidenceStatus(env);
 if(status!=='ready')throw failed('identity_evidence_unavailable');
 assertWritable(await readAuthority(env));
 const db=database(env);
 const existing=await readEvidence(env,plan.evidenceKey);
 if(existing)return {state:'present',receipt:false,written:false,evidenceKey:plan.evidenceKey,seq:Number(existing.seq),filmId:existing.film_id};
 const film=await one(db,"SELECT (SELECT id FROM film WHERE id=?) AS film,(SELECT 1 FROM film_redirect WHERE from_id=?) AS redirected,(SELECT revision FROM canonical_revision WHERE kind='film' AND id=?) AS revision",[filmId,filmId,filmId]);
 if(film?.redirected)throw failed('film_person_redirect');
 if(!film?.film)throw failed('identity_evidence_unknown_film');
 const requestId=await identityEvidenceRequestId({evidenceKey:plan.evidenceKey,filmId});
 const digest=await identityEvidenceDigest({evidenceKey:plan.evidenceKey,filmId});
 const clock=clockOf(input.now);
 const spec=identityEvidenceOperation({replan:input.replan||(async()=>({evidence:input.evidence,filmId})),now:clock});
 let outcome;
 try{outcome=await receiptedWrite(env,{requestId,operation:IDENTITY_EVIDENCE_OPERATION,origin:IDENTITY_EVIDENCE_ORIGIN,target:{kind:'film',id:filmId},expectedRevision:Number(film.revision??0),digest,now:clock,policy:input.policy||RETRY_POLICY},{
  atomic:true,readback:spec.readback,revalidate:spec.revalidate,
  run:ctx=>writeEvidence(env,{plan,filmId,expectedRevision:ctx.currentRevision,requestId,at:clock(),receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target}}),
 });}
 catch(error){
  // The lost race: another request recorded the key first. This receipt was settled `abandoned` with that class by its own attempt; nothing of it landed.
  if(error?.code!==EVIDENCE_PRESENT)throw error;
  const row=await readEvidence(env,plan.evidenceKey);
  return {ran:true,state:'present',receipt:true,receiptState:'abandoned',errorClass:EVIDENCE_PRESENT,requestId,evidenceKey:plan.evidenceKey,written:false,seq:row?Number(row.seq):null,filmId:row?.film_id??null};
 }
 const row=await readEvidence(env,plan.evidenceKey);
 return {...outcome,receipt:true,requestId,evidenceKey:plan.evidenceKey,written:row?.request_id===requestId,seq:row?Number(row.seq):null};
}

// AIR-602 / ADR 0207 decision 3 (review of PR #1018): the evidence-only operation under its OWN operation key `evidence:<evidence_key>` on the AIR-600 protocol, so a lost response, an
// expired or competing attempt and a Film merged away in between are all settled from durable state, never from timing. `run` is the protocol runner (`runOperationKey`, injected so this
// module keeps its imports). input: {evidence, filmId, now?, policy?}. -> {state:'present'|'written'|'wait'|'failed', written, evidenceKey, seq?, filmId?, errorClass?}.
// - settled: an applied attempt is validated against the LEDGER: the key exists, whatever Film it is bound to (a merge does not move a row), so a lost response after a redirect is `present`.
// - the write targets the Film that holds the id NOW (a redirect is followed, a few hops), and the receipt's own target is that Film.
// - `wait` (a live attempt) and `failed` are NOT success: the caller must not report the check as recorded.
export const evidenceOperationKey=evidenceKey=>'evidence:'+evidenceKey;
const REDIRECT_HOPS=8;
async function currentFilm(db,id){
 let at=id;
 for(let hop=0;hop<=REDIRECT_HOPS;hop++){
  const row=await one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[at]);
  if(!row)return at;
  at=row.to_film_id;
 }
 throw failed('film_person_redirect');
}
export async function recordIdentityEvidenceKeyed(env,input={},{run}={}){
 if(typeof run!=='function')throw failed('film_person_invalid');
 const plan=await planIdentityEvidence(input.evidence);
 const askedFilm=fenced.filmId(input.filmId);
 const status=await identityEvidenceStatus(env);
 if(status!=='ready')throw failed('identity_evidence_unavailable');
 assertWritable(await readAuthority(env));
 const db=database(env);
 const clock=clockOf(input.now);
 const policy=input.policy||RETRY_POLICY;
 const known=async()=>{const row=await readEvidence(env,plan.evidenceKey);return row?{state:'present',written:false,evidenceKey:plan.evidenceKey,seq:Number(row.seq),filmId:row.film_id}:null;};
 let ran;
 try{
  ran=await run(env,{origin:IDENTITY_EVIDENCE_ORIGIN,operationKey:evidenceOperationKey(plan.evidenceKey),now:clock,policy},{
   validate:async()=>(await readEvidence(env,plan.evidenceKey))?'settled':'historical',
   decide:async()=>{
    const existing=await known();
    if(existing)return {kind:'none',result:existing};
    const filmId=await currentFilm(db,askedFilm);
    const film=await one(db,"SELECT (SELECT id FROM film WHERE id=?) AS film,(SELECT revision FROM canonical_revision WHERE kind='film' AND id=?) AS revision",[filmId,filmId]);
    if(!film?.film)throw failed('identity_evidence_unknown_film');
    const digest=await identityEvidenceDigest({evidenceKey:plan.evidenceKey,filmId});
    return {kind:'reserve',request:{operation:IDENTITY_EVIDENCE_OPERATION,target:{kind:'film',id:filmId},expectedRevision:Number(film.revision??0),digest,source:{evidenceKey:plan.evidenceKey,filmId}},write:{
     atomic:true,
     run:ctx=>writeEvidence(env,{plan,filmId,expectedRevision:ctx.currentRevision,requestId:ctx.requestId,at:clock(),receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target}}),
     readback:async()=>({digest:(await readEvidence(env,plan.evidenceKey))?digest:null,revision:await revisionOf(db,filmId)}),
     revalidate:async()=>(await readEvidence(env,plan.evidenceKey))?'superseded':'proceed',
    }};
   },
  });
 }catch(error){
  // The lost race: another request recorded the key first. Nothing of this attempt landed.
  if(error?.code===EVIDENCE_PRESENT){const row=await known();if(row)return row;}
  throw error;
 }
 if(ran.status==='settled'||ran.status==='none'){const row=await known();return row||{state:'failed',written:false,evidenceKey:plan.evidenceKey,errorClass:'evidence_missing'};}
 if(ran.status==='reserved'){
  const o=ran.outcome||{};
  const row=await known();
  if((o.state==='applied'||o.state==='already')&&row)return {...row,state:o.already?'present':'written',written:o.already!==true&&row.seq!==undefined,requestId:ran.requestId};
  if(row)return row;
  return {state:'failed',written:false,evidenceKey:plan.evidenceKey,errorClass:o.errorClass||o.state||'unclassified'};
 }
 if(ran.status==='wait')return {state:'wait',written:false,evidenceKey:plan.evidenceKey,reason:ran.reason??'in_flight'};
 return {state:'failed',written:false,evidenceKey:plan.evidenceKey,errorClass:ran.status};
}
