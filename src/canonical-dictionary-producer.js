// AIR-374 P3a, DICTIONARY-STORE semantics of the EPG producer (ADR 0127; owner decisions E2, E4, E5 and E6 of 12 Nov 2026; title order and `titleSource` of ADR 0117 and ADR 0120). DORMANT: nothing in the Worker imports this
// module, it is not bundled (build.mjs is unchanged), `epgSync` does not call it and no route, job or cron does. The projector stays the only canonical writer while the marker is `legacy`, `r2` or `prepared`: `applyDictionaryUnits`
// and `reconcileDictionary` read the marker ONCE through the adapter's route gate and, unless it is `open`, return `skipped` before any other statement. `held` and an unreadable marker throw.
// ONE source of truth for ownership: the curated title/alias dictionary (`data/film-titles.json`, reviewed entries) feeds the canonical Film ONLY through the existing fenced writer `writeFilmFacts`, reached through the receipt
// adapter (`applyFilmFacts`: no-op pre-plan before any receipt, ONE atomic fenced batch with the applied receipt). This module has no SQL, no second write path and no competing writer; it decides WHAT to hand the writer and NAMES
// every outcome. Precedence is the writer's own: the title order owner > dictionary > tmdb > letterboxd > watchlist > epg > discovery (original_title only) with `titleSource` in the identity provenance, and the localization tiers
// owner > reviewed dictionary > automatic. An owner-owned value is never overwritten.
//   - `dictionarySnapshot`   async. The version (a caller label) and a content DIGEST of the whole curated snapshot. The pair is the source EVENT of every request id, so a replay is bound to the dictionary version it was planned from.
//                            CONTRACT: every genuine dictionary change OR REVERT must carry a FRESH, UNIQUE `version` (a revision token the future caller mints; never a reused label). The same version with the same content is the same event
//                            and the same request id by design, so an A -> B -> A edit under a REUSED label cannot restore A: the third pass meets A's applied receipt and is NOT written. It is a NAMED outcome, never a silent success:
//                            counted `already` and listed as the kept conflict `snapshot_already_applied` (field `snapshot`). Distinct request ids for A -> B -> A need three distinct versions (A v1, B v2, A v3).
//   - `planDictionaryUnits`  async, PURE. One unit per dictionary entry that names a canonical Film (`filmId`), sorted by Film id; duplicates and malformed entries are refused.
//   - `buildDictionaryInput` PURE over the stored rows of ONE Film. Decides `proceed` (with the writer input), `absent`, `redirected`, `identity_mismatch` or `kept`, and lists the named conflicts.
//   - `applyDictionaryUnits` bounded, resumable by cursor, at most `limit` units per call (hard ceiling, provisional: E6 measured Film-facts volume only; combined-producer ceiling remains unknown). A refusal of one unit never blocks the others; held and unreadable stop the pass.
//   - `dictionaryReplan` / `reconcileDictionary`  E2: the adapter's bounded inline reconcile for the origin `dictionary` ONLY. A receipt is re-planned only for the snapshot that wrote it. No cron, no tick, no global pass.
// What a unit is: the facts of one Film that the dictionary owns: `original_title` (the entry's `original`, source `dictionary`, with `titleSource`), the effective Russian localization (reviewed, source `dictionary`) and the TMDB
// identity (`canonical_identity` is filled only when empty and the id is a trusted external id of that Film). Membership, metadata and sync clocks are never part of a dictionary unit. Aliases are part of the snapshot digest (they
// are dictionary content) but this producer does not write them: the canonical `film_alias` table exists, but no unit of this layer carries aliases (ADR 0127).
// Named conflicts (`kind` kept: nothing written for the field; `replaced`: written over a different lower-ranked value): owner_kept, reviewed_kept, unranked_kept, no_identity_row, needs_trusted_tmdb_id,
// identity_mismatch (kept), snapshot_already_applied (kept: this exact snapshot, version and digest, was applied before and the Film no longer holds it) and replaced_lower, replaced_reviewed, replaced_automatic (replaced). Stored: operation kind, origin, target, digests, revisions, state; no title, payload or personal data.
import {failed} from './film-person-authority.js';
import {applyFilmFacts,digestOf,filmFactsOperation,producerRequestId,producerRouteOpen,readFilmSnapshot,reconcileOwnOrigin,FILM_FACTS_OPERATION} from './canonical-producer-adapters.js';

export const DICTIONARY_ORIGIN='dictionary';
// The title source this module writes, and the constant source version of its localization row: a dictionary VERSION bump must not rewrite an unchanged row (the version lives in the request event, not in the row).
export const DICTIONARY_SOURCE='dictionary';
export const DICTIONARY_SOURCE_VERSION='verified';
// Provisional ceiling of units per call (the same reasoning as ADR 0125, kept provisional): the first E6 production measurement (12 Nov 2026, docs/evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md) measured Film-facts units only: about 38 D1 round trips for a changed `applyFilmFacts` unit and 14 for an unchanged one (offline stand-in), before loop/step overhead, Person/credits work and retries; changedShare, Person/credits volume, the EPG-step budgets and the combined-producer per-run ceiling are still unmeasured and no ceiling is chosen.
export const DICTIONARY_UNIT_HARD_CAP=50;
export const DICTIONARY_UNIT_LIMIT_DEFAULT=25;
const HELD=new Set(['film_person_held','film_person_unavailable']);
const VERSION=/^[A-Za-z0-9._:-]{1,80}$/;
const TMDB=/^[1-9]\d{0,11}$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim()?value.trim():null;
const strings=(value,max)=>{
 if(value===undefined||value===null)return [];
 if(!Array.isArray(value)||value.length>max||value.some(item=>typeof item!=='string'||!item.trim()))throw failed('film_person_invalid');
 return value.map(item=>item.trim());
};
const titleSourceOf=row=>{try{const value=JSON.parse(row?.provenance_json||'null')?.titleSource;return plain(value)&&typeof value.source==='string'?value.source:null;}catch{return null;}};

// A reviewed entry of the curated dictionary that names the canonical Film it describes. Only `verified` entries are reviewed; the rest is refused, never silently skipped.
function normaliseEntry(raw){
 if(!plain(raw)||typeof raw.id!=='string'||!raw.id.trim()||raw.id.length>64||typeof raw.filmId!=='string'||!raw.filmId.startsWith('film:')||raw.status!=='verified')throw failed('film_person_invalid');
 const tmdb=raw.tmdbId===undefined||raw.tmdbId===null?null:String(raw.tmdbId);
 if(tmdb!==null&&!TMDB.test(tmdb))throw failed('film_person_invalid');
 const original=text(raw.original),title=text(raw.title);
 if(!original&&!title)throw failed('film_person_invalid');
 return {id:raw.id.trim(),filmId:raw.filmId,tmdbId:tmdb,original,title,aliases:strings(raw.aliases,50),sources:strings(raw.sources,10),status:'verified'};
}
const byFilm=(a,b)=>a.filmId<b.filmId?-1:a.filmId>b.filmId?1:0;

// The identity of the curated snapshot a plan was made from: the caller's version label and a digest of EVERY entry (aliases and sources included), in a fixed order. Any edit of the dictionary is another snapshot, but only a UNIQUE
// version makes it another REQUEST when an earlier content returns: the label is mandatory-unique per genuine change or revert (module header; the plan does not and cannot detect reuse, it never sees the receipts).
export async function dictionarySnapshot({version,entries}={}){
 if(typeof version!=='string'||!VERSION.test(version)||!Array.isArray(entries))throw failed('film_person_invalid');
 const list=entries.map(normaliseEntry).sort(byFilm);
 if(new Set(list.map(entry=>entry.filmId)).size!==list.length||new Set(list.map(entry=>entry.id)).size!==list.length)throw failed('film_person_invalid');
 const digest=await digestOf({operation:'dictionary_snapshot',version,entries:list});
 return {version,digest,count:list.length,entries:list};
}

// version: the label of the curated snapshot. entries: [{id, filmId, tmdbId?, original?, title?, aliases?, sources?, status:'verified'}]; `filmId` is the canonical Film the entry describes (the caller resolves it).
// at: the write clock. Returns {event, snapshot:{version,digest,count}, at, units:[{id, entry}]}; the event is `dictionary:<version>:<digest>`, so request ids are bound to the snapshot used.
export async function planDictionaryUnits({version,entries=[],at}={}){
 if(typeof at!=='string'||!at)throw failed('film_person_invalid');
 const snapshot=await dictionarySnapshot({version,entries});
 return {
  event:'dictionary:'+snapshot.version+':'+snapshot.digest,
  snapshot:{version:snapshot.version,digest:snapshot.digest,count:snapshot.count},
  at,
  units:snapshot.entries.map(entry=>({id:entry.filmId,entry})),
 };
}

// PURE. snapshot: readFilmSnapshot's result for the unit's Film. Returns {outcome, input?, conflicts}:
//   absent             no stored `film` row: a dictionary entry never creates a Film;
//   redirected         the Film was merged into another: refused here, never written;
//   identity_mismatch  the stored Film is another TMDB film than the entry (a trusted external id or the stored identity differs): nothing of the entry applies;
//   kept               every field of the entry is kept or already stored as it is: nothing to hand the writer;
//   proceed            `input` is the writer input of `writeFilmFacts` (without requestId, expectedRevision and receiptMark); the writer decides again, under its own fence.
// `conflicts`: [{field, reason, kind, from?}], see the header. The contract version and `updated_at` of the stored Film are carried so the Film row changes only where the dictionary changes it.
export function buildDictionaryInput(snapshot,unit,{at}={}){
 const entry=unit?.entry;
 if(!plain(snapshot)||!plain(entry)||typeof at!=='string'||!at)throw failed('film_person_invalid');
 const conflicts=[];
 if(snapshot.redirect)return {outcome:'redirected',conflicts};
 const stored=snapshot.film;
 if(!stored||!Number.isInteger(stored.contract_version))return {outcome:'absent',conflicts};
 const trusted=snapshot.trustedTmdb||[];
 const wantedIdentity=entry.tmdbId===null?null:'tmdb:'+entry.tmdbId;
 if(wantedIdentity!==null&&((trusted.length>0&&!trusted.includes(entry.tmdbId))||(stored.canonical_identity&&stored.canonical_identity!==wantedIdentity))){
  return {outcome:'identity_mismatch',conflicts:[{field:'identity',reason:'identity_mismatch',kind:'kept'}]};
 }
 const film={contractVersion:stored.contract_version};
 let filmChanges=false;
 // (1) identity: filled only when empty and provable. A stored identity that equals the entry is nothing to write.
 if(wantedIdentity!==null&&!stored.canonical_identity){
  if(!trusted.includes(entry.tmdbId))conflicts.push({field:'canonicalIdentity',reason:'needs_trusted_tmdb_id',kind:'kept'});
  else{film.canonicalIdentity=wantedIdentity;filmChanges=true;}
 }
 // (2) original_title, ranked by the title order (the dictionary ranks below the owner only, so an owner source is the one higher-precedence case and is named below; the writer applies the whole order again under its fence); the provenance (`titleSource`) lives in the identity row, so a title is written only where that row exists.
 const identity=snapshot.dimensions?.identity||null;
 const storedTitle=text(stored.original_title);
 if(entry.original){
  const storedSource=titleSourceOf(identity);
  const strong=!!identity&&(identity.status==='reviewed'||identity.authority==='owner');
  const send=()=>{film.originalTitle=entry.original;film.source=DICTIONARY_SOURCE;};
  // An EQUAL title is adopted only where its stored source is explicitly lower-ranked (provenance upgrade). An owner, reviewed, unranked (no titleSource) or already-dictionary row is left alone: equality is no proof of who owns the value.
  if(storedTitle===entry.original){if(identity&&!strong&&storedSource!==null&&storedSource!=='owner'&&storedSource!==DICTIONARY_SOURCE)send();}
  else if(!identity)conflicts.push({field:'originalTitle',reason:'no_identity_row',kind:'kept'});
  else if(storedTitle===null){send();filmChanges=true;}
  else if(strong||storedSource==='owner')conflicts.push({field:'originalTitle',reason:identity.authority==='owner'||storedSource==='owner'?'owner_kept':'reviewed_kept',kind:'kept'});
  else if(storedSource===null)conflicts.push({field:'originalTitle',reason:'unranked_kept',kind:'kept'});
  else{send();filmChanges=true;conflicts.push({field:'originalTitle',reason:'replaced_lower',kind:'replaced',from:storedSource});}
 }
 // (3) the reviewed Russian localization. An owner row is kept; a reviewed or automatic row with another value is replaced and named.
 // `requireExisting`: the writer asserts the Film inside its fenced batch, so a Film deleted after this read is never recreated (ADR 0127).
 const input={id:unit.id,at,updatedAt:filmChanges?at:(stored.updated_at||at),film,requireExisting:true};
 const localization=snapshot.dimensions?.localization||null;
 if(entry.title){
  if(localization&&localization.authority==='owner')conflicts.push({field:'localization',reason:'owner_kept',kind:'kept'});
  else{
   const other=!!localization&&text(localization.value)!==null&&localization.value!==entry.title;
   if(other&&localization.status==='reviewed')conflicts.push({field:'localization',reason:'replaced_reviewed',kind:'replaced'});
   else if(other)conflicts.push({field:'localization',reason:'replaced_automatic',kind:'replaced'});
   input.localization={state:{dimension:'localization',status:'reviewed',source:DICTIONARY_SOURCE,sourceVersion:DICTIONARY_SOURCE_VERSION,provenance:{authority:'dictionary',sources:entry.sources},value:entry.title,updatedAt:at,attempts:0,nextAction:'keep_reviewed'}};
  }
 }
 if(film.originalTitle===undefined&&film.canonicalIdentity===undefined&&input.localization===undefined)return {outcome:'kept',conflicts};
 return {outcome:'proceed',input,conflicts};
}

// The re-plan the receipts module asks for: the unit of THIS snapshot for the receipt's Film against the CURRENT stored rows, and only when the receipt belongs to this snapshot (the request id is recomputed from the plan's event,
// the receipt's target and its content digest). null otherwise, and null when the Film no longer proceeds (absent, redirected, mismatched, kept): the receipts module then backs off or abandons by its own bounds.
export function dictionaryReplan(plan,env){
 const byId=new Map((plan?.units||[]).map(unit=>[unit.id,unit]));
 return async receipt=>{
  const unit=byId.get(receipt?.target?.id);
  if(!unit||typeof plan?.event!=='string'||typeof plan?.at!=='string'||!env)return null;
  let expected=null;
  try{expected=await producerRequestId({origin:DICTIONARY_ORIGIN,event:plan.event,target:receipt.target,digest:receipt.contentDigest});}catch{return null;}
  if(expected!==receipt.requestId)return null;
  const built=buildDictionaryInput(await readFilmSnapshot(env,unit.id),unit,{at:plan.at});
  return built.input??null;
 };
}

export const dictionaryUnitCap=limit=>Math.min(Math.max(Number(limit)||1,1),DICTIONARY_UNIT_HARD_CAP);
const emptyCounts=()=>({applied:0,noop:0,already:0,unknown:0,failed:0,pending:0,absent:0,redirected:0,identity_mismatch:0,kept:0});

// cursor: index of the next unit (resumable; the caller persists it). limit: units per call. Returns
//   {skipped:true, reason:'projector_is_writer', ...}                                  marker not open: one marker read, nothing else;
//   {skipped:false, cursor, done, counts, conflicts:[{id,field,reason,kind,from?}], failures:[{id,code}], stoppedBy}.
export async function applyDictionaryUnits(env,{plan,cursor=0,limit=DICTIONARY_UNIT_LIMIT_DEFAULT,now,policy}={}){
 if(!plan||!Array.isArray(plan.units)||typeof plan.event!=='string'||typeof plan.at!=='string'||!Number.isInteger(cursor)||cursor<0)throw failed('film_person_invalid');
 const cap=dictionaryUnitCap(limit);
 if(!(await producerRouteOpen(env)))return {skipped:true,reason:'projector_is_writer',cursor,done:false,counts:emptyCounts(),conflicts:[],failures:[]};
 const counts=emptyCounts(),conflicts=[],failures=[];
 let index=cursor,stoppedBy=null;
 for(;index<plan.units.length&&index-cursor<cap;index++){
  const unit=plan.units[index];
  try{
   const built=buildDictionaryInput(await readFilmSnapshot(env,unit.id),unit,{at:plan.at});
   for(const item of built.conflicts)conflicts.push({id:unit.id,...item});
   if(built.outcome!=='proceed'){counts[built.outcome]++;continue;}
   const outcome=await applyFilmFacts(env,{origin:DICTIONARY_ORIGIN,event:plan.event,input:built.input,...(now?{now}:{}),...(policy?{policy}:{})});
   if(outcome.state==='noop')counts.noop++;
   else if(outcome.already===true){
    // The adapter's pre-plan found the stored Film different from this unit, yet a receipt of the SAME request id is applied: this exact snapshot (version and digest) was applied before. Either another actor moved the Film since, or the caller REUSED a version label for a revert. Nothing is written; name it so it is never read as success. A revert needs a fresh version.
    counts.already++;conflicts.push({id:unit.id,field:'snapshot',reason:'snapshot_already_applied',kind:'kept'});
   }
   else if(outcome.state==='applied')counts.applied++;
   else if(outcome.state==='unknown')counts.unknown++;
   else if(outcome.state==='failed')counts.failed++;
   else counts.pending++;
  }catch(error){
   const code=typeof error?.code==='string'?error.code:'film_person_unavailable';
   if(HELD.has(code)){stoppedBy=code;break;}
   counts.failed++;failures.push({id:unit.id,code});
  }
 }
 return {skipped:false,cursor:index,done:index>=plan.units.length,counts,conflicts,failures,stoppedBy};
}

// E2: the producer's own receipts only, at most the adapter's inline bound per call. `plan` supplies the re-plan of THIS snapshot; a receipt of another snapshot is never replayed from it.
export async function reconcileDictionary(env,{plan,limit,now,policy}={}){
 const operations=new Map([[FILM_FACTS_OPERATION,filmFactsOperation({replan:dictionaryReplan(plan,env),...(now?{now}:{})})]]);
 return reconcileOwnOrigin(env,{origin:DICTIONARY_ORIGIN,operations,...(limit!==undefined?{limit}:{}),...(now?{now}:{}),...(policy?{policy}:{})});
}
