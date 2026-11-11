// AIR-371 / ADR 0099 (Accepted), decomposition C4. Producer adapters and the single-writer routing for canonical Film/Person. INACTIVE:
// nothing in the Worker imports this module (it is not bundled; no route, job or cron calls it), no schema is applied and no marker moves.
// While the marker is legacy, r2 or prepared the enrichment projector is the ONLY canonical writer and every adapter here is dormant
// (dispatch returns without a database statement). From open the adapters are the only writers and the projector is compare-only/off;
// held and every unreadable marker fail closed and never fall back to R2 (AIR-374 owns the real handoff and each production step).
// - writerRoute: the one routing decision. Exactly one of the projector and the canonical adapters may write in any state.
// - projectorFence: the SQL assertion a FUTURE projector batch carries so an in-flight projector batch loses once the marker moves
//   (a generation mismatch or mode d1 fails its CHECK and rolls the batch back whole). It is the proof of "no overlap"; the real projector
//   carries the same condition from src/film-person-authority.js (AIR-374 P1, ADR 0117), so this module stays dormant and unimported.
// - plan* functions are pure: they turn the existing producers' data into fenced AIR-367..370 calls, or say why not.
// - dispatch executes a plan only when the route is canonical; an unknown batch outcome is reported, never blindly retried, and is settled
//   by readback (the entity revision) and a replay with the same request id.
// - shadowCompare / handoffReadiness are read-only and bounded. AIR-374 P6 (ADR 0117): handoffReadiness is COMPUTED. A former GAP counts as cleared only when its
//   fenced writer is registered in CALLS and RECONCILE here and the differential registry (src/canonical-differential-registry.js, verified against the harness
//   run by tests/canonical-differential.mjs) marks it covered; every other condition of a `prepared` to `open` handoff is a named blocker. It is information for the
//   owner's decision, never a permission, and nothing in the Worker calls it.
import {PROJECTOR_MARKER_CONDITION,assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced,mutateFilm,mutatePerson} from './canonical-mutations.js';
import {compareLocalization,recordLocalizationSources} from './localization-sources.js';
import {admitRatedFilm,retainFilm,verifiedAdmission} from './film-admission.js';
import {recordRetirementDecision} from './tmdb-retirement-decisions.js';
import {filmFactsPresent,writeFilmFacts} from './canonical-film-writers.js';
import {PERSON_STATE_CALLS,PERSON_STATE_RECONCILE} from './canonical-person-state.js';
import {P6_DIFFERENTIAL_EXCEPTIONS} from './canonical-film-writers.js';
import {DIFFERENTIAL_COVERAGE,EXTRA_EXCEPTIONS} from './canonical-differential-registry.js';
import {OPERATION_KINDS,RECEIPT_MIN_VERSION,listAttention,operationRegistry,readUnreceipted,receiptsStatus,verifyBaseline} from './canonical-receipts.js';

export const SHADOW_ITEM_CAP=200;
export const SHADOW_LIST_CAP=200;
export const SHADOW_READ_CHUNK=80;
// Producer writes that today only the projector performs and that no fenced mutation covers (the AIR-371 audit): the handoff is not ready
// until each of these has a fenced writer, which needs its own decision and card.
export const GAPS=Object.freeze([
 'film_metadata rows (synopsis, poster, genres, runtime, payload, people version)',
 'film_dimension rows (identity, metadata lifecycle, effective localization)',
 'film_sync_state clocks',
 'watchlist_film membership (set and clear)',
 'person_dimension rows and Person localization state',
 'localization_conflict rows outside a merge',
 'canonical_identity and original_title overwrite (the fenced write only fills)',
 // AIR-374 P1 / ADR 0117 (owner decision 1): "projector revision bumps" is no longer a readiness blocker. The projector does not write the historic
 // canonical_revision in prepared (an entity's initial revision is 0); every projector batch instead asserts the marker and generation unconditionally.
]);
// AIR-374 P6: the registries handoffReadiness computes from. They are DATA (frozen objects), never read from comments or documentation, and every flip is a code change
// a reviewer sees: the PR that wires a producer, moves a reader or introduces the receipts protocol changes its own entry, and a test refuses an entry that the code
// contradicts (a producer marked wired while the Worker bundle does not carry this module).
// P3: the natural producer call sites. A producer counts as WIRED only when the receipts registry (PRODUCER_OPERATIONS, built by operationRegistry of src/canonical-receipts.js, which refuses
// anything that is not atomic) holds an atomic operation for EVERY operation kind the producer needs (`requires`). There is no flag to flip: the P3 PR that wires a producer registers its operations
// (a spec with readback, replay and atomic:true), and the Worker bundle must then carry this module (a test checks both). Today the registry is empty, so none is wired.
export const PRODUCER_WIRING=Object.freeze([
 Object.freeze({name:'epg_commit',site:'epgSync commit (worker.js)',requires:Object.freeze(['film_mutation','person_mutation','film_metadata','film_dimension','film_sync_state','film_membership','person_state'])}),
 Object.freeze({name:'metadata_sync',site:'metadataSync (worker.js)',requires:Object.freeze(['film_metadata','film_sync_state','localization_source','localization_conflict'])}),
 Object.freeze({name:'discovery_admission',site:'Discovery catalog admission (discovery-authority.js)',requires:Object.freeze(['film_mutation'])}),
 Object.freeze({name:'rated_admission_retention',site:'rated admission and watchlist retention (letterboxd-rated-candidates.js, enrichment.js)',requires:Object.freeze(['film_admission','film_retention'])}),
]);
export const PRODUCER_OPERATIONS=operationRegistry([]);
// P4: every consumer that must stop reading the frozen canonical R2 mirrors (titles.json, people.json, metadata.json) and answer from D1, fail closed. P4 slice 1 (the
// marker-gated /api/d1/* gate and the archive fallback) is moved; the PR of the next slice updates this list. Not derived from the readers' files.
export const READER_REGISTRY=Object.freeze([
 Object.freeze({name:'catalog_d1_gate',moved:true}),
 Object.freeze({name:'catalog_archive_fallback',moved:true}),
 Object.freeze({name:'worker_programme_read',moved:false}),
 Object.freeze({name:'worker_watchlist_read',moved:false}),
 Object.freeze({name:'worker_catalog_read',moved:false}),
 Object.freeze({name:'admin_read',moved:false}),
 Object.freeze({name:'admin_limbo',moved:false}),
 Object.freeze({name:'admin_health',moved:false}),
 Object.freeze({name:'owner_review_d1_gate',moved:false}),
]);
// ADR 0117 owner decision 5 / ADR 0119: durable cross-domain receipts inside the existing D1. The protocol is "registered" only when PRODUCER_OPERATIONS holds at least one atomic operation
// (derived, never a flag); the schema and the baseline are read from the database.
export const RECEIPTS_PROTOCOL=Object.freeze({table:'canonical_write_receipt',minSchema:RECEIPT_MIN_VERSION});
// ADR 0117 owner decision 2: the three classes loaded while `prepared` (counts accepted by the owner on 11 Nov 2026).
export const EMPTY_CLASSES=Object.freeze([
 Object.freeze({name:'ratedAdmission',table:'film_rated_admission',expected:708}),
 Object.freeze({name:'retention',table:'film_retention',expected:401}),
 Object.freeze({name:'retirement',table:'tmdb_retirement_decision',expected:4}),
]);
const ROLES=new Set(['director','actor']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const skipped=(producer,reason)=>({producer,calls:[],skipped:[{reason}]});

// One routing decision from the marker. legacy/r2/prepared: the projector writes, the adapters are dormant. open: the adapters write, the
// projector is compare-only. held and an unreadable marker throw (film_person_held / film_person_unavailable) and name no writer.
export async function writerRoute(env){
 const gate=await readAuthority(env);
 if(gate.r2Allowed===true)return {writer:'projector',projector:'writes',canonical:'dormant',state:gate.state,generation:gate.generation};
 if(gate.state==='open')return {writer:'canonical',projector:'compare_only',canonical:'writes',state:gate.state,generation:gate.generation};
 assertWritable(gate); // throws film_person_held / film_person_unavailable
 throw failed('film_person_unavailable');
}

// The statement a projector batch would add after its own fence. Null when there is no marker (legacy): nothing to prove. Otherwise it
// holds only while the marker is the r2 or prepared mode at cutover open and the generation the projector read, so a batch that started before a move to open
// (or any generation change) fails whole. The condition is the one the real projector carries (src/film-person-authority.js, ADR 0117).
export function projectorFence(gate){
 if(!gate||gate.state==='legacy')return null;
 if(gate.r2Allowed!==true)throw failed('film_person_not_projector');
 return [fenced.assertSql(PROJECTOR_MARKER_CONDITION),[gate.state,gate.generation]];
}

// EPG identity and the aliases, trusted ids and credits of the projector's Film entity. The credits are upserts only: no removal, no
// ordinal renumbering, so the D1-only TMDB credits survive. `revisions` maps an entity id to the revision the caller read (absent = 0; use
// readRevisions). A credit's Person must be created by this plan (`persons`) or already exist in D1 (`knownPersons`), otherwise the plan is
// refused (`credit_person_unresolved`): film_person_credit references person, so the calls run PERSONS FIRST, then the Film. The plan is NOT
// one atomic batch (`atomic:false`): each call is its own fenced batch, so a later failure leaves the earlier calls applied. Every call is
// idempotent in content (aliases and ids upsert, a credit that exists is kept), so after a partial outcome the caller re-reads the revisions
// (readRevisions), re-plans and dispatches again; the replay converges and never duplicates.
// input: {at, epgGeneration, revisions:{id:n}, knownPersons?:[id], film:{id, contractVersion?, canonicalIdentity?, originalTitle?, externalIds?, aliases?, localization?},
//   credits?:[{personId, role}], persons?:[{id, roleId, contractVersion?, externalIds?, aliases?, localization?}]}
export function planEpgIdentity(input){
 const film=input?.film;
 if(!plain(film)||typeof film.id!=='string'||!film.id.startsWith('film:')||typeof input.at!=='string')return skipped('epg_identity','invalid_input');
 const revisions=plain(input.revisions)?input.revisions:{};
 const rev=id=>Number.isInteger(revisions[id])&&revisions[id]>=0?revisions[id]:0;
 const persons=[];
 for(const person of input.persons||[]){
  if(!plain(person)||typeof person.id!=='string'||typeof person.roleId!=='string')return skipped('epg_identity','invalid_person');
  persons.push(person);
 }
 const resolvable=new Set([...persons.map(person=>person.id),...(Array.isArray(input.knownPersons)?input.knownPersons:[])]);
 const credits=[];
 for(const credit of input.credits||[]){
  if(!credit||!ROLES.has(credit.role)||typeof credit.personId!=='string')return skipped('epg_identity','invalid_credit');
  if(!resolvable.has(credit.personId))return skipped('epg_identity','credit_person_unresolved');
  credits.push({personId:credit.personId,role:credit.role});
 }
 const calls=persons.map(person=>({fn:'mutatePerson',input:{id:person.id,expectedRevision:rev(person.id),at:input.at,person:{roleId:person.roleId,contractVersion:Number.isInteger(person.contractVersion)?person.contractVersion:1,externalIds:person.externalIds||[],aliases:person.aliases||[]}}}));
 calls.push({fn:'mutateFilm',input:{id:film.id,expectedRevision:rev(film.id),at:input.at,film:{contractVersion:Number.isInteger(film.contractVersion)?film.contractVersion:1,canonicalIdentity:film.canonicalIdentity??undefined,originalTitle:film.originalTitle??undefined,externalIds:film.externalIds||[],aliases:film.aliases||[]},credits:credits.length?{upsert:credits}:undefined}});
 return {producer:'epg_identity',atomic:false,epgGeneration:input.epgGeneration??null,calls,skipped:[]};
}

// AIR-374 P2a / ADR 0120: the film-side facts the projector writes today (identity overwrite, metadata, sync clocks, membership, lifecycle rows, effective
// localization) as ONE fenced call per Film. Dormant like every other planner: dispatch runs it only when the route is canonical. `revisions` is the map of
// readRevisions; the call is idempotent by CONTENT under a stable requestId (no receipt table exists for it, see ADR 0120).
// input: {id, at, requestId, revisions?:{id:n}, updatedAt?, film:{contractVersion?, canonicalIdentity?, originalTitle?, source?, authority?}, evidence?, dimensions?,
//   localization?, metadata?, sync?, watchlist?, epgGeneration?}
export function planFilmWrite(input){
 if(!plain(input)||typeof input.id!=='string'||!input.id.startsWith('film:')||typeof input.at!=='string'||typeof input.requestId!=='string'||!input.requestId)return skipped('film_facts','invalid_input');
 const revisions=plain(input.revisions)?input.revisions:{};
 const {revisions:_revisions,epgGeneration,...rest}=input;
 return {producer:'film_facts',epgGeneration:epgGeneration??null,calls:[{fn:'writeFilmFacts',input:{...rest,expectedRevision:Number.isInteger(revisions[input.id])&&revisions[input.id]>=0?revisions[input.id]:0,film:{...(plain(input.film)?input.film:{}),contractVersion:Number.isInteger(input.film?.contractVersion)?input.film.contractVersion:1}}}],skipped:[]};
}

// Automatic localization candidates only: a reviewed or owner value, an empty one or an inconsistent one never becomes a source write.
// input: {kind, id, localization, resolved, revision, at, requestId}
export function planLocalization(input){
 if(!plain(input)||!['film','person'].includes(input.kind)||typeof input.id!=='string'||typeof input.requestId!=='string'||typeof input.at!=='string')return skipped('localization','invalid_input');
 const compared=compareLocalization(input.resolved||{tier:'none',value:null},input.localization);
 if(!compared.candidate)return skipped('localization',compared.outcome);
 return {producer:'localization',outcome:compared.outcome,calls:[{fn:'recordLocalizationSources',input:{kind:input.kind,id:input.id,expectedRevision:Number.isInteger(input.revision)?input.revision:0,at:input.at,requestId:input.requestId,sources:[{source:compared.candidate.source,value:compared.candidate.value,sourceVersion:compared.candidate.sourceVersion||'unknown',provenance:compared.candidate.provenance||{},observedAt:compared.candidate.observedAt}]}}],skipped:[]};
}

// A Discovery catalog admission: a verified movie id (scheme `tmdb`, from a `tmdb_<n>` key) becomes film:tmdb:<n> or lands on the Film that
// already holds it. `tmdb_tv_*` keys, an unverified entry and a held (untrusted or conflicting) typed claim are never admitted.
// input: {key, entry:{verified:true,...}, resolved:{id,revision,held,redirected}, at}
export function planDiscoveryAdmission(input){
 const match=/^tmdb_([1-9]\d{0,11})$/.exec(String(input?.key??''));
 if(!match)return skipped('discovery_admission',/^tmdb_tv_/.test(String(input?.key??''))?'tmdb_tv_is_not_a_film':'invalid_key');
 if(input.entry?.verified!==true)return skipped('discovery_admission','not_verified');
 const resolved=input.resolved;
 if(!plain(resolved)||typeof resolved.id!=='string'||typeof input.at!=='string')return skipped('discovery_admission','invalid_input');
 if(resolved.held)return skipped('discovery_admission','admission_identity_held');
 if(resolved.redirected)return skipped('discovery_admission','redirected');
 return {producer:'discovery_admission',calls:[{fn:'mutateFilm',input:{id:resolved.id,expectedRevision:Number.isInteger(resolved.revision)?resolved.revision:0,at:input.at,film:{contractVersion:1,originalTitle:typeof input.entry.title==='string'&&input.entry.title?input.entry.title:undefined,externalIds:[{scheme:'tmdb',value:match[1],trusted:true,provenance:{source:'discovery',verified:true}}]}}}],skipped:[]};
}

// A verified rated-only admission (the receipt stays the immutable evidence) and the watchlist retention fact.
export function planRatedAdmission(input){
 const checked=verifiedAdmission(input?.receiptKey,input?.receipt);
 if(!checked.ok)return skipped('rated_admission',checked.reason);
 if(typeof input.requestId!=='string'||typeof input.at!=='string')return skipped('rated_admission','invalid_input');
 return {producer:'rated_admission',calls:[{fn:'admitRatedFilm',input:{receiptKey:input.receiptKey,receipt:input.receipt,filmId:input.filmId,expectedRevision:Number.isInteger(input.expectedRevision)?input.expectedRevision:0,at:input.at,requestId:input.requestId}}],skipped:[]};
}
export function planRetention(input){
 if(!plain(input)||typeof input.id!=='string'||typeof input.watchlist!=='boolean'||typeof input.requestId!=='string'||typeof input.at!=='string'||typeof input.observedAt!=='string')return skipped('retention','invalid_input');
 return {producer:'retention',calls:[{fn:'retainFilm',input:{id:input.id,expectedRevision:Number.isInteger(input.expectedRevision)?input.expectedRevision:0,at:input.at,requestId:input.requestId,watchlist:input.watchlist,observedAt:input.observedAt,evidence:input.evidence}}],skipped:[]};
}
// An owner-only TMDB retirement decision (retire or an explicit restore). It is journalled, never applied to identity rows here.
export function planRetirement(input){
 if(!plain(input)||typeof input.requestId!=='string'||typeof input.at!=='string')return skipped('retirement','invalid_input');
 return {producer:'retirement',calls:[{fn:'recordRetirementDecision',input:{...input}}],skipped:[]};
}

// AIR-374 P2b: the Person's dimension state (identity, effective localization, the held-value alias and conflict) and the standalone localization conflicts of one
// Film or Person. Both are fenced writers of the person-state module and stay dormant before `open` (dispatch runs nothing). The Person row must exist (mutatePerson runs
// first); `revision` is the entity revision the caller read. requestId is the stable idempotency key; replay is recognised by content (no receipt table, no migration).
// input: {id, revision, at, requestId, person:{identity?, localization?, localizationConflicts?}}
export function planPersonState(input){
 if(!plain(input)||typeof input.id!=='string'||!input.id.startsWith('person:')||typeof input.requestId!=='string'||!input.requestId||typeof input.at!=='string'||!plain(input.person)||(!input.person.identity&&!input.person.localization))return skipped('person_state','invalid_input');
 return {producer:'person_state',calls:[{fn:'recordPersonState',input:{id:input.id,expectedRevision:Number.isInteger(input.revision)?input.revision:0,at:input.at,requestId:input.requestId,person:input.person}}],skipped:[]};
}
// input: {kind:'film'|'person', id, revision, at, requestId, conflicts:[{value,source,provenance,at,reason}]}
export function planLocalizationConflicts(input){
 if(!plain(input)||!['film','person'].includes(input.kind)||typeof input.id!=='string'||!input.id.startsWith(input.kind+':')||typeof input.requestId!=='string'||!input.requestId||typeof input.at!=='string'||!Array.isArray(input.conflicts)||!input.conflicts.length)return skipped('localization_conflict','invalid_input');
 return {producer:'localization_conflict',calls:[{fn:'recordLocalizationConflicts',input:{kind:input.kind,id:input.id,expectedRevision:Number.isInteger(input.revision)?input.revision:0,at:input.at,requestId:input.requestId,conflicts:input.conflicts}}],skipped:[]};
}

// One batch of plans must come from one EPG generation: a plan from another generation is never mixed in.
export function planBatch(plans){
 const generations=new Set(plans.filter(plan=>plan.epgGeneration!==undefined&&plan.epgGeneration!==null).map(plan=>plan.epgGeneration));
 if(generations.size>1)return {ok:false,reason:'mixed_generation',generations:[...generations]};
 return {ok:true,plans};
}

export const CALLS={writeFilmFacts,mutateFilm,mutatePerson,recordLocalizationSources,admitRatedFilm,retainFilm,recordRetirementDecision};
Object.assign(CALLS,PERSON_STATE_CALLS);

// Executes a plan only when the route is canonical. In legacy, r2 and prepared nothing runs and no statement reaches the database; held and
// unreadable markers throw. Each call is one fenced batch. A thrown unknown outcome (film_person_unavailable) is returned as `unknown` and is
// NOT retried: settle it with readback() and then replay with the same request id. A lost fence or revision is a `conflict` to read again.
export async function dispatch(env,plan){
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {executed:false,reason:'projector_is_writer',route,results:[]};
 const results=[];
 for(const call of plan.calls||[]){
  const run=CALLS[call.fn];
  if(!run)throw failed('canonical_producer_invalid');
  try{results.push({fn:call.fn,status:'applied',result:await run(env,call.input)});}
  catch(error){
   if(error?.code==='film_person_unavailable'){results.push({fn:call.fn,status:'unknown',code:error.code,input:call.input});break;}
   if(error?.code==='film_person_fence'||error?.code==='film_person_revision_conflict'){results.push({fn:call.fn,status:'conflict',code:error.code});break;}
   if(error?.code&&/held|identity|collision|conflict|redirect|invalid|not_open|admission|retirement/.test(error.code)){results.push({fn:call.fn,status:'refused',code:error.code});break;}
   throw error;
  }
 }
 const applied=results.filter(item=>item.status==='applied').length;
 return {executed:true,route,results,complete:applied===(plan.calls||[]).length,partial:applied>0&&applied<(plan.calls||[]).length};
}

// What each call kind can settle by itself. A request id makes a replay a no-op (the writer opens no batch for a request it already applied);
// mutateFilm, mutatePerson and writeFilmFacts carry NO per-request receipt: they are idempotent in content, not by request id (writeFilmFacts opens no batch when D1 already holds its rows).
export const RECONCILE={
 writeFilmFacts:{kind:()=>'film',id:input=>input.id,byRequestId:false,content:(db,input)=>filmFactsPresent(db,input)},
 mutateFilm:{kind:()=>'film',id:input=>input.id,byRequestId:false},
 mutatePerson:{kind:()=>'person',id:input=>input.id,byRequestId:false},
 recordLocalizationSources:{kind:input=>input.kind,id:input=>input.id,byRequestId:true},
 admitRatedFilm:{kind:()=>'film',id:input=>input.filmId||(/^tmdb_(\d+)$/.exec(String(input.receiptKey))?'film:tmdb:'+/^tmdb_(\d+)$/.exec(String(input.receiptKey))[1]:null),byRequestId:true},
 retainFilm:{kind:()=>'film',id:input=>input.id,byRequestId:true},
 recordRetirementDecision:{kind:()=>'film',id:input=>input.filmId,byRequestId:true},
};
Object.assign(RECONCILE,PERSON_STATE_RECONCILE);
export async function readRevisions(env,ids){
 const db=database(env);
 const list=[...new Set(ids)];
 const out={};
 for(let at=0;at<list.length;at+=SHADOW_READ_CHUNK){
  const chunk=list.slice(at,at+SHADOW_READ_CHUNK);
  for(const row of await many(db,`SELECT kind,id,revision FROM canonical_revision WHERE id IN (${chunk.map(()=>'?').join(',')})`,chunk))out[row.id]=Number(row.revision);
 }
 for(const id of list)if(!(id in out))out[id]=0;
 return out;
}

// Does D1 hold EXACTLY the state a mutateFilm/mutatePerson call would have left? Every write effect the call advertises is compared: the Film or
// Person row fields it sets (contract version, role id, and canonical identity / original title when given), each external id with its trust,
// conflict flag and provenance, each removal (the row must be absent), each alias and each upserted credit (present), each credit removal (absent).
// Anything that differs, or that cannot be proven equal, is "not present": a competing producer may have changed the entity, and a replay
// through the revision check is then the safe path. Read-only.
const jsonOf=value=>value===undefined||value===null?null:JSON.stringify(value);
async function contentPresent(db,fn,input){
 if(!plain(input))return false;
 const isFilm=fn==='mutateFilm';
 const table=isFilm?'film_external_id':'person_external_id',column=isFilm?'film_id':'person_id',aliasTable=isFilm?'film_alias':'person_alias';
 const body=isFilm?input.film:input.person;
 if(!plain(body))return false;
 if(isFilm){
  const row=await one(db,'SELECT contract_version,canonical_identity,original_title FROM film WHERE id=?',[input.id]);
  if(!row||row.contract_version!==body.contractVersion)return false;
  if(body.canonicalIdentity!==undefined&&body.canonicalIdentity!==null&&row.canonical_identity!==body.canonicalIdentity)return false;
  if(body.originalTitle!==undefined&&body.originalTitle!==null&&row.original_title!==body.originalTitle)return false;
 }else{
  const row=await one(db,'SELECT role_id,contract_version FROM person WHERE id=?',[input.id]);
  if(!row||row.role_id!==body.roleId||row.contract_version!==body.contractVersion)return false;
 }
 for(const item of body.removeExternalIds||[])if(await one(db,`SELECT 1 AS x FROM ${table} WHERE ${column}=? AND scheme=? AND value=?`,[input.id,item.scheme,String(item.value)]))return false;
 for(const item of body.externalIds||[]){
  const row=await one(db,`SELECT trusted,conflicting,provenance_json FROM ${table} WHERE ${column}=? AND scheme=? AND value=?`,[input.id,item.scheme,String(item.value)]);
  if(!row||row.trusted!==(item.trusted&&!item.conflicting?1:0)||row.conflicting!==(item.conflicting?1:0)||(row.provenance_json??null)!==jsonOf(item.provenance))return false;
 }
 for(const item of body.aliases||[])if(!(await one(db,`SELECT 1 AS x FROM ${aliasTable} WHERE ${column}=? AND kind=? AND value=?`,[input.id,item.kind||(isFilm?'title':'name'),item.value])))return false;
 if(isFilm){
  for(const item of input.credits?.remove||[])if(await one(db,'SELECT 1 AS x FROM film_person_credit WHERE film_id=? AND person_id=? AND role=?',[input.id,item.personId,item.role]))return false;
  for(const item of input.credits?.upsert||[])if(!(await one(db,'SELECT 1 AS x FROM film_person_credit WHERE film_id=? AND person_id=? AND role=?',[input.id,item.personId,item.role])))return false;
 }
 return true;
}

// Read-only. After an unknown outcome. A moved revision is NOT proof that THIS call applied (any competing producer moves it), so the verdict is
// never "applied" from the revision alone:
// - not_applied: the revision is still the expected one, the atomic batch left nothing; re-dispatch with the same revision.
// - settle_by_request_id: the writer dedupes by request id; replay the same call (a no-op if it applied; a `conflict` to re-read if it did not).
// - content_present: mutateFilm/mutatePerson only, the revision moved and D1 holds EXACTLY the state the call would have left (every value, trust, provenance, removal); otherwise reread_and_replan.
// - reread_and_replan: the revision moved and the content is missing; read the revisions again (readRevisions), re-plan and dispatch (idempotent in content).
// - unsupported: the call kind or its entity cannot be reconciled; block it, never guess.
export async function readback(env,call){
 const spec=RECONCILE[call?.fn];
 const input=call?.input;
 const kind=spec&&plain(input)?spec.kind(input):null,id=spec&&plain(input)?spec.id(input):null;
 if(!spec||typeof id!=='string'||!['film','person'].includes(kind))return {outcome:'unsupported',applied:null};
 const db=database(env);
 const row=await one(db,'SELECT revision FROM canonical_revision WHERE kind=? AND id=?',[kind,id]);
 const revision=Number(row?.revision??0),expected=Number(input.expectedRevision??0);
 const base={id,kind,revision,expected,moved:revision>expected};
 // AIR-374 P2b: the person-state writers are replay-safe by content (no receipt table): replaying the same call is a no-op when it had applied.
 if(spec.byReplay)return {...base,outcome:'settle_by_replay',applied:null,note:'replay the same call: when the rows already hold the wanted state it is a no-op without a batch'};
 if(spec.byRequestId)return {...base,outcome:'settle_by_request_id',applied:null,note:'replay the same call: an applied request id is a no-op'};
 if(revision<=expected)return {...base,outcome:'not_applied',applied:false};
 if(await (spec.content?spec.content(db,input):contentPresent(db,call.fn,input)))return {...base,outcome:'content_present',applied:null,note:'the wanted content exists; a competing writer may have written it'};
 return {...base,outcome:'reread_and_replan',applied:false};
}

const capped=list=>list.length>SHADOW_LIST_CAP?list.slice(0,SHADOW_LIST_CAP):list;
// Compare-only and bounded: what the projector's Film entities say (external ids, aliases, credits) against the D1 rows. Nothing is written.
// items: [{id, externalIds:[{scheme,value,trusted}], aliases:[{kind,value}], credits:[{personId,role}]}], at most SHADOW_ITEM_CAP per call.
export async function shadowCompare(env,items){
 if(!Array.isArray(items))throw failed('canonical_producer_invalid');
 const truncatedInput=items.length>SHADOW_ITEM_CAP;
 const list=items.slice(0,SHADOW_ITEM_CAP);
 const db=database(env);
 const report={compared:list.length,same:0,missing:[],differs:[],truncated:truncatedInput,agree:true};
 for(let at=0;at<list.length;at+=SHADOW_READ_CHUNK){
  const chunk=list.slice(at,at+SHADOW_READ_CHUNK),ids=chunk.map(item=>item.id),marks=ids.map(()=>'?').join(',');
  const [films,externals,aliases,credits]=await Promise.all([
   many(db,`SELECT id FROM film WHERE id IN (${marks})`,ids),
   many(db,`SELECT film_id,scheme,value,trusted FROM film_external_id WHERE film_id IN (${marks})`,ids),
   many(db,`SELECT film_id,kind,value FROM film_alias WHERE film_id IN (${marks})`,ids),
   many(db,`SELECT film_id,person_id,role FROM film_person_credit WHERE film_id IN (${marks})`,ids),
  ]);
  const have=new Set(films.map(row=>row.id));
  const by=(rows,key)=>{const out=new Map();for(const row of rows){if(!out.has(row.film_id))out.set(row.film_id,new Set());out.get(row.film_id).add(key(row));}return out;};
  const ext=by(externals,row=>row.scheme+':'+row.value+':'+(row.trusted===1?1:0)),ali=by(aliases,row=>row.kind+':'+row.value),cred=by(credits,row=>row.person_id+'/'+row.role);
  for(const item of chunk){
   if(!have.has(item.id)){report.missing.push(item.id);continue;}
   const fields=[];
   const absent=(planned,stored)=>planned.filter(key=>!(stored?.has(key)));
   if(absent((item.externalIds||[]).map(x=>x.scheme+':'+x.value+':'+(x.trusted?1:0)),ext.get(item.id)).length)fields.push('externalIds');
   if(absent((item.aliases||[]).map(x=>(x.kind||'title')+':'+x.value),ali.get(item.id)).length)fields.push('aliases');
   if(absent((item.credits||[]).map(x=>x.personId+'/'+x.role),cred.get(item.id)).length)fields.push('credits');
   // A D1-only credit (AIR-286) is not a difference: only planned values missing from D1 count.
   if(fields.length)report.differs.push({id:item.id,fields});else report.same++;
  }
 }
 report.missing=capped(report.missing);report.differs=capped(report.differs);
 report.agree=!report.missing.length&&!report.differs.length&&!truncatedInput;
 return report;
}

// Read-only readiness for the AIR-374 handoff, COMPUTED (P6, ADR 0117). It never writes and reads nothing but counts, the marker, the schema contract and the lease and
// window rows. `ready` is true only when no blocker remains; it is information for the owner's decision, never a permission. A blocker is:
// - marker_unreadable:<code>, marker_not_prepared:<state>, baseline_not_verified:<state>, schema_below_16:<n>, schema_unreadable, no_database;
// - projector_lease_live, projector_window_not_idle:<state> (an absent window table is no window);
// - gap:<former gap> unless every writer of it is registered in CALLS and RECONCILE AND the differential registry marks it covered;
// - exception_not_accepted:<id> for each named projector-vs-canonical difference the owner has not accepted;
// - receipts_schema_missing, receipts_baseline_missing (marker open or held, no sealed baseline), receipts_baseline_unverified, unreceipted_changes, receipts_attention_open, receipts_unreadable,
//   and receipts_protocol_unregistered (PRODUCER_OPERATIONS holds no atomic operation);
// - producer_not_wired:<name> (a producer needs an atomic registered operation for every kind it requires) and reader_not_moved:<name> from READER_REGISTRY;
// - empty_class_not_loaded:<name>:<found>/<expected> and empty_class_unreadable:<name>.
// `evidence` replaces a registry only in tests (a synthetic fully satisfied fixture); production callers pass none.
export async function handoffReadiness(env,{now=new Date().toISOString(),evidence={}}={}){
 const wiring=evidence.wiring||PRODUCER_WIRING,readers=evidence.readers||READER_REGISTRY,operations=evidence.operations||PRODUCER_OPERATIONS,classes=evidence.classes||EMPTY_CLASSES;
 const coverage=evidence.coverage||DIFFERENTIAL_COVERAGE,exceptions=evidence.exceptions||[...P6_DIFFERENTIAL_EXCEPTIONS,...EXTRA_EXCEPTIONS],calls=evidence.calls||{CALLS,RECONCILE};
 const blockers=[];
 let gate=null;
 try{gate=await readAuthority(env);}catch(error){blockers.push('marker_unreadable:'+(error?.code||'error'));}
 if(gate){
  if(gate.state!=='prepared')blockers.push('marker_not_prepared:'+gate.state);
  if(gate.baseline!=='verified')blockers.push('baseline_not_verified:'+String(gate.baseline));
 }
 const db=database(env);
 let version=0,tables=new Set();
 if(db){
  try{
   version=Number((await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??0);
   if(version<16)blockers.push('schema_below_16:'+version);
   tables=new Set((await many(db,"SELECT name FROM sqlite_master WHERE type='table'")).map(row=>row.name));
   const lease=await one(db,"SELECT lease_until FROM projection_run WHERE projection='enrichment' AND lease_id IS NOT NULL AND lease_until>?",[now]).catch(()=>null);
   if(lease)blockers.push('projector_lease_live');
   const nowMs=Date.parse(now);
   if(tables.has('projector_window')){
    const window=await one(db,'SELECT state,expires_at FROM projector_window WHERE id=1');
    if(window&&window.state!=='idle'&&Number(window.expires_at)>nowMs)blockers.push('projector_window_not_idle:'+window.state);
   }
  }catch{blockers.push('schema_unreadable');}
 }else blockers.push('no_database');
 // A former gap is cleared only by evidence the code can check: each of its writers is registered for dispatch and for readback, and the harness-verified registry marks it covered.
 const cleared=[],open=[];
 for(const gap of GAPS){
  const entry=coverage.find(item=>item.gap===gap);
  const registered=!!entry&&entry.covered===true&&Array.isArray(entry.writers)&&entry.writers.length>0&&entry.writers.every(name=>typeof calls.CALLS[name]==='function'&&!!calls.RECONCILE[name])&&entry.scenarios?.length>0&&entry.tables?.length>0;
  (registered?cleared:open).push(gap);
 }
 for(const gap of open)blockers.push('gap:'+gap);
 for(const item of exceptions)if(item.status!=='accepted')blockers.push('exception_not_accepted:'+item.id);
 // Receipts (ADR 0119), read-only. Schema below 19 or a missing receipt/baseline table: receipts_schema_missing. The activation baseline is recorded by the activation operation AFTER
 // `open` (recordBaseline refuses before), so it is required here only once the marker is open or held; at `prepared` it is expected to be absent and is not a blocker.
 const status=db?await receiptsStatus(env):'no_schema';
 if(status==='no_schema')blockers.push('receipts_schema_missing');
 else if(status==='no_baseline'){if(gate&&['open','held'].includes(gate.state))blockers.push('receipts_baseline_missing');}
 else{
  try{
   if(!(await verifyBaseline(env)).ok)blockers.push('receipts_baseline_unverified');
   if((await readUnreceipted(env)).unreceipted.length)blockers.push('unreceipted_changes');
   if((await listAttention(env)).length)blockers.push('receipts_attention_open');
  }catch{blockers.push('receipts_unreadable');}
 }
 const atomic=kind=>{for(const spec of operations.values())if(spec.operation===kind&&spec.atomic===true)return true;return false;};
 if(![...operations.values()].some(spec=>spec.atomic===true))blockers.push('receipts_protocol_unregistered');
 for(const item of wiring)if(!item.requires.every(kind=>OPERATION_KINDS.includes(kind)&&atomic(kind)))blockers.push('producer_not_wired:'+item.name);
 for(const item of readers)if(item.moved!==true)blockers.push('reader_not_moved:'+item.name);
 for(const item of classes){
  if(!db||!tables.has(item.table)){blockers.push('empty_class_unreadable:'+item.name);continue;}
  try{
   const found=Number((await one(db,'SELECT COUNT(*) AS n FROM '+item.table))?.n);
   if(found!==item.expected)blockers.push('empty_class_not_loaded:'+item.name+':'+found+'/'+item.expected);
  }catch{blockers.push('empty_class_unreadable:'+item.name);}
 }
 return {ready:blockers.length===0,blockers,gaps:open,clearedGaps:cleared,formerGaps:[...GAPS]};
}
