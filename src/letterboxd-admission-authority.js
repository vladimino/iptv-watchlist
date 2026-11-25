// AIR-602 (card A1) / ADR 0207 decision 1 (Accepted). The Letterboxd admission authority marker `letterboxd_admission_authority` (migration 0044, schema 44): who coordinates the admission of a
// verified Letterboxd Film. DORMANT until an owner-approved activation (cards M1 and A2): the migration is a file, the marker is inserted as `r2`, and at `r2` (and while the migration is absent)
// every writer behaves exactly as before this card.
//
// Three modes: `r2` (the legacy R2 coordination step, byte-identical to the delivered code), `closed` (every admission writer refuses BEFORE its first effect; reads are unchanged) and `d1` (the
// new path, terminal). The chain is `r2 -> closed -> d1` and `closed -> r2`, enforced by the triggers of migration 0044, not by this module.
//
// Safety invariants (ADR 0207 decision 1, adopted from ADR 0196):
// - LEGACY ROUTING NEEDS POSITIVE PROOF. A writer may take the legacy path only when (a) a FRESH read proves the marker migration is not installed (schema version below 44 AND the table absent), or
//   (b) the installed marker row proves `r2`. An unavailable D1, a partial schema, a missing row at or above the migration's version or an invalid mode is `letterboxd_admission_unavailable`:
//   it never defaults to `r2`. (A request without ANY D1 binding is not a database at all, so it has no marker to read and is the legacy `not_installed` state, as the other markers of this
//   Worker treat it: production always has the binding, and a binding that fails to answer is `unavailable`.)
// - GUARD AT THE WRITE. `guardLegacyWrite` reads the marker FRESH (never from a request scope), so a request that read `r2` or "migration absent" at its start still refuses at its own write. It is the
//   last awaited step before an R2 PUT or delete of letterboxd/admissions/verified-films.json.
// - FENCE ON THE BATCH. `legacyBatchCondition` / `d1BatchCondition` are the assertions a fenced D1 batch carries so a legacy admission cannot land under `closed` or `d1`, and a new-path admission cannot land
//   under anything but `d1` at the generation it read. For a request that read "migration absent" the condition is a commit-time check that the table is STILL absent: a batch prepared before the
//   migration was applied cannot commit after it (the statement never names the missing table, which would fail at prepare time).
import {database,failed,one} from './film-person-authority.js';

export const ADMISSION_AUTHORITY_SCHEMA=44;
export const ADMISSION_MODES=Object.freeze(['r2','closed','d1']);
const TABLE='letterboxd_admission_authority';

const unavailable=(cause,reason)=>{const error=failed('letterboxd_admission_unavailable',cause);if(reason)error.reason=reason;return error;};
const closedError=mode=>{const error=failed('letterboxd_admission_closed');error.mode=mode;return error;};

// A FRESH read. -> {mode, proof, generation, installed, version}
//   proof 'not_installed' (no binding, or schema below 44 and no table): legacy.     proof 'explicit_r2' (the row says r2): legacy.
//   proof 'closed' | 'd1': the row says so.
// Anything that is not one of these four answers throws `letterboxd_admission_unavailable`.
export async function readAdmissionAuthority(env){
 const db=database(env);
 if(!db)return {mode:'r2',proof:'not_installed',generation:0,installed:false,version:null};
 let head;
 try{
  head=await one(db,"SELECT (SELECT version FROM schema_contract WHERE id=1) AS version,(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?) AS installed",[TABLE]);
 }catch(error){throw unavailable(error,'read_failed');}
 const version=head?.version==null?null:Number(head.version),installed=Number(head?.installed)===1;
 if(!installed){
  // The only legitimate absence is a schema BELOW the migration. At 44 or later a missing table is a damaged schema; an unreadable version is no proof of anything.
  if(Number.isFinite(version)&&version<ADMISSION_AUTHORITY_SCHEMA)return {mode:'r2',proof:'not_installed',generation:0,installed:false,version};
  throw unavailable(new Error('letterboxd_admission_authority_missing_at_schema_'+version),'table_missing');
 }
 let row;
 try{row=await one(db,'SELECT mode,generation FROM '+TABLE+' WHERE id=1');}catch(error){throw unavailable(error,'read_failed');}
 if(!row||!ADMISSION_MODES.includes(row.mode)||!Number.isSafeInteger(Number(row.generation))||Number(row.generation)<0)throw unavailable(new Error('letterboxd_admission_authority_row_invalid'),row?'invalid_row':'row_missing');
 // The table exists but the version is below the migration's, or unreadable: the file was applied outside the chain. That is not a state this code can vouch for.
 if(!Number.isFinite(version)||version<ADMISSION_AUTHORITY_SCHEMA)throw unavailable(new Error('letterboxd_admission_authority_version_'+version),'version_mismatch');
 return {mode:row.mode,proof:row.mode==='r2'?'explicit_r2':row.mode,generation:Number(row.generation),installed:true,version};
}

// Pure. Which path a writer takes for this authority: 'legacy' (the R2 coordination step), 'closed' (refuse before the first effect) or 'd1' (the new path).
export function admissionRoute(authority){
 if(!authority)throw unavailable(new Error('no_authority'),'no_authority');
 if(authority.mode==='r2'&&(authority.proof==='not_installed'||authority.proof==='explicit_r2'))return 'legacy';
 if(authority.mode==='closed'&&authority.proof==='closed')return 'closed';
 if(authority.mode==='d1'&&authority.proof==='d1')return 'd1';
 throw unavailable(new Error('authority_inconsistent'),'inconsistent');
}

// The gate immediately before an R2 PUT or delete of the admissions object (and before any other legacy effect). Reads FRESH and refuses unless the marker proves `r2` or proves the migration absent.
// closed and d1 both refuse (after d1 the Worker never writes the object again); an unavailable marker refuses too. -> the authority read.
export async function guardLegacyWrite(env){
 const authority=await readAdmissionAuthority(env);
 if(admissionRoute(authority)!=='legacy')throw closedError(authority.mode);
 return authority;
}

// The route of one request at its start, without refusing: 'legacy' | 'closed' | 'd1'. Throws `letterboxd_admission_unavailable`.
export async function admissionRouteNow(env){
 const authority=await readAdmissionAuthority(env);
 return {route:admissionRoute(authority),authority};
}

const ABSENT="NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='"+TABLE+"')";
const R2_ROW='EXISTS (SELECT 1 FROM '+TABLE+" WHERE id=1 AND mode='r2' AND generation=?)";
const D1_ROW='EXISTS (SELECT 1 FROM '+TABLE+" WHERE id=1 AND mode='d1' AND generation=?)";

// The condition a LEGACY fenced batch asserts (ADR 0207 decision 1, "Fence on the legacy D1 batch"): {sql, params}, ONE boolean expression for the caller's own assertion statement.
// The authority is the one the caller read at the start of its request. Read as "migration absent": the table must STILL be absent at commit. Read as `r2`: the row must still say `r2` at the same
// generation (a close and reopen in between moves the generation, so a batch planned before it is refused and replans). Any other authority has no legacy batch.
export function legacyBatchCondition(authority){
 if(admissionRoute(authority)!=='legacy')throw closedError(authority.mode);
 if(authority.proof==='not_installed')return {sql:ABSENT,params:[]};
 return {sql:R2_ROW,params:[authority.generation]};
}

// The condition a NEW-PATH fenced batch asserts: mode `d1` at the generation the caller read. Only a `d1` authority has one.
export function d1BatchCondition(authority){
 if(admissionRoute(authority)!=='d1')throw closedError(authority.mode);
 return {sql:D1_ROW,params:[authority.generation]};
}

// The assertion statement of a condition for a fenced canonical batch (`film_person_cas`): a false condition fails the CHECK and rolls the whole batch back.
export function authorityAssertion(assertSql,condition){return [assertSql(condition.sql),condition.params];}

export const admissionClosedError=closedError;
