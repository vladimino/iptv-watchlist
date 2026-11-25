// AIR-660 / ADR 0218 (Accepted), stage 1. The PURE half of the offline Film dimension parity reader: it derives the facts of ADR 0218
// decision 2 from their domain authorities (already read by src/film-dimension-parity.js) and classifies every stored film_dimension row as
// agree, stale_copy, control or unknown_legacy under the per-column matrix of decision 1. No I/O, no clock, no write.
//
// Rules that keep a classification honest:
// - A stored copy status is never compared as truth. A copy row is `stale_copy` whatever its status says; the difference with the derived fact
//   is reported as `diverges` for information only (decision 7, stage 1).
// - Anything that may be the only durable record of a decision (owner/reviewed rows, the ADR 0214 metadata lock, identity titleSource, a
//   localization projection whose source row is gone) is `control`, and every value no current writer produces (an unknown authority, an unknown
//   localization status, a reviewed fingerprint/prediction row, a titleSource outside identity, an unreadable identity provenance) is
//   `unknown_legacy`. Both are retained by every later stage; only `stale_copy` can ever be a retirement candidate, and stage 6 narrows it further.
// - A missing dimension row is never a negative, and a missing metadata provenance is never an explicit null: without film_metadata_field
//   (ADR 0214 PV1, not live) no metadata field is ever `absent`.
import {isOwnerProjection,resolveLocalization} from '../localization-sources.js';

export const PARITY_CLASSES=Object.freeze(['agree','stale_copy','control','unknown_legacy']);
export const PARITY_DIMENSIONS=Object.freeze(['identity','metadata','localization','fingerprint','prediction']);
// ADR 0214's six core fields, in its order.
export const CORE_FIELDS=Object.freeze(['year','runtime','synopsis','poster','url','genres']);
// The schemes an ADR 0216 section reads; an unsettled claim on another scheme (for example a slug) does not fail identity.
export const SECTION_SCHEMES=Object.freeze(['tmdb','letterboxd']);
const LOCALIZATION_AUTHORITIES=new Set(['owner','dictionary']);
const LOCALIZATION_STATUSES=new Set(['reviewed','provisional']);

const own=claim=>Number(claim?.trusted)===1&&Number(claim?.conflicting)===0;
const parseJson=text=>{if(text==null)return {ok:true,value:null};if(typeof text==='object')return {ok:true,value:text};try{return {ok:true,value:JSON.parse(text)};}catch{return {ok:false,value:null};}};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const filled=value=>value!=null&&value!=='';
const sameText=(a,b)=>(a??null)===(b??null);

// A tmdb movie id is retired when it has a `retire` decision that no `restore` supersedes (ADR 0216 decision 3: settled history, removed from
// every alias set before conflict evaluation).
export function retiredMovieIds(decisions){
 const superseded=new Set((decisions||[]).filter(item=>item.kind==='restore'&&item.supersedes_seq!=null).map(item=>Number(item.supersedes_seq)));
 return new Set((decisions||[]).filter(item=>item.kind==='retire'&&!superseded.has(Number(item.seq))).map(item=>String(item.movie_id)));
}

// ADR 0216 decision 3 for a canonical `film:` request (the only kind the parity reader asks). `absent` comes only from step 0 (no film row and
// no redirect); a merged film id is `redirected`, never `retired`; `unverified` and `retired` describe external requests and are never produced
// here. input: {requested, filmExists, redirect:{state,survivor,chain}, survivorExists, claims (survivor rows), competing (rows of other
// Films claiming one of the survivor's values), retired (Set of movie ids), available}.
export function identityVerdict(input){
 if(input?.available===false)return {verdict:'unavailable',reason:input.reason||'film_person_unavailable',survivor:null,aliases:emptyAliases()};
 const redirect=input.redirect||{state:'direct',survivor:input.requested,chain:[]};
 if(redirect.state==='cycle'||redirect.state==='too_deep')return {verdict:'cycle',reason:redirect.state,survivor:null,chain:redirect.chain||[],aliases:emptyAliases()};
 if(redirect.state==='direct'&&!input.filmExists)return {verdict:'absent',reason:'no_film_row',survivor:null,aliases:emptyAliases()};
 // A redirect whose survivor row is missing is a broken read-set, not an absence (ADR 0216 decision 3, step 0 only proves absence): unavailable.
 if(!input.survivorExists)return {verdict:'unavailable',reason:'survivor_missing',survivor:null,chain:redirect.chain||[],aliases:emptyAliases()};
 const retired=input.retired||new Set();
 const claims=(input.claims||[]).filter(claim=>!(claim.scheme==='tmdb'&&retired.has(String(claim.value))));
 const unsettled=claims.filter(claim=>SECTION_SCHEMES.includes(claim.scheme)&&!own(claim));
 const trusted=claims.filter(own);
 const values=new Set(trusted.filter(claim=>SECTION_SCHEMES.includes(claim.scheme)).map(claim=>claim.scheme+'\u0000'+String(claim.value)));
 const survivor=redirect.survivor||input.requested;
 const competing=(input.competing||[]).filter(row=>row.film_id!==survivor&&values.has(row.scheme+'\u0000'+String(row.value)));
 // The fatal identity fence: a conflict authorizes no alias and no section (ADR 0218 decision 2, ADR 0216 decisions 5/6b).
 const failedBase={survivor,chain:redirect.chain||[],aliases:emptyAliases()};
 if(unsettled.length)return {...failedBase,verdict:'conflict',reason:'unsettled_claim'};
 if(competing.length)return {...failedBase,verdict:'conflict',reason:'competing_claim'};
 return {survivor,chain:redirect.chain||[],aliases:aliasesOf(trusted),verdict:redirect.state==='redirected'?'redirected':'found',reason:null};
}
// Only these verdicts pass the fence; every other verdict yields no section.
export function identityPassed(identity){return identity?.verdict==='found'||identity?.verdict==='redirected';
}
function emptyAliases(){return {tmdb:[],lids:[],tmdbTv:[],storageIds:[],stable:false};}
// Authorized aliases (ADR 0216 decision 6b): the survivor's trusted, non-conflicting, non-retired claims. Prediction storage ids are tmdb_<n>
// and each lid, as the prediction domain keys them. A stable alias (ADR 0218 C1) is a verified lid or a trusted tmdb movie claim.
function aliasesOf(trusted){
 const pick=scheme=>[...new Set(trusted.filter(claim=>claim.scheme===scheme).map(claim=>String(claim.value)))].sort();
 const tmdb=pick('tmdb'),lids=pick('letterboxd'),tmdbTv=pick('tmdb_tv');
 return {tmdb,lids,tmdbTv,storageIds:[...tmdb.map(value=>'tmdb_'+value),...lids],stable:tmdb.length>0||lids.length>0};
}

// ADR 0218 decision 4 "usable values", reused by decision 2: a value is usable when well-typed and not a default.
export function usableField(field,row){
 if(field==='genres'){
  const parsed=parseJson(row?.genres_json);
  if(!parsed.ok)return {usable:false,reason:'malformed'};
  const list=parsed.value;
  if(list==null)return {usable:false,reason:'null'};
  if(!Array.isArray(list))return {usable:false,reason:'wrong_type'};
  if(!list.length)return {usable:false,reason:'empty'};
  return list.every(item=>typeof item==='string'&&item.trim())?{usable:true}:{usable:false,reason:'wrong_type'};
 }
 const value=row?.[field];
 if(value==null)return {usable:false,reason:'null'};
 if(field==='year'||field==='runtime')return Number.isInteger(value)&&value>0?{usable:true}:{usable:false,reason:typeof value==='number'?'not_positive':'wrong_type'};
 if(typeof value!=='string')return {usable:false,reason:'wrong_type'};
 return value.trim()?{usable:true}:{usable:false,reason:'empty'};
}

// Decision 2, metadata: value presence and provenance confidence are separate, and both are separate from decision 4 usability. A stored
// non-null value is `present` whatever its type or provenance, with `usable` and a diagnostic beside it (malformed, wrong_type, empty,
// not_positive). A null is `unknown`; it is `absent` only under an explicit-null provenance record (ADR 0214 film_metadata_field, not live).
// Confidence is `unattributed`: no provenance record is validated here, so none is trusted to raise it. Freshness is `unknown`.
const storedValue=(field,row)=>field==='genres'?row?.genres_json:row?.[field];
export function metadataFacts(row,{provenance=null}={}){
 const fields={};
 for(const field of CORE_FIELDS){
  if(!row){fields[field]={status:'unknown',reason:'no_metadata_row',usable:false,confidence:null};continue;}
  const value=storedValue(field,row),usable=usableField(field,row);
  if(value!=null)fields[field]={status:'present',usable:usable.usable,...(usable.usable?{}:{diagnostic:usable.reason}),confidence:'unattributed'};
  else if(provenance?.[field]?.explicitNull===true)fields[field]={status:'absent',reason:'explicit_null',usable:false,confidence:null};
  else fields[field]={status:'unknown',reason:'null_unproved',usable:false,confidence:null};
 }
 return {fields,freshness:'unknown',present:CORE_FIELDS.filter(field=>fields[field].status==='present'),usable:CORE_FIELDS.filter(field=>fields[field].usable)};
}

// Decision 2 and ADR 0216 decisions 5/6b, fingerprint and prediction. `available` is false when the prediction marker is not d1/open (held or
// still r2): then nothing is proved. With incomplete candidate coverage the result is never absent or none.
export function predictionFacts({available=true,reason=null,storageIds=[],fingerprints=[],pointers=[],coverage={status:'incomplete',reason:'ratings_evidence_not_read'}}={}){
 if(!available)return {fingerprint:{status:'unavailable',reason:reason||'prediction_unavailable'},prediction:{status:'unavailable',reason:reason||'prediction_unavailable'},compatibility:'unknown',coverage};
 if(!storageIds.length)return {fingerprint:{status:'unknown',reason:'no_authorized_alias'},prediction:{status:'unknown',reason:'no_authorized_alias'},compatibility:'unknown',coverage};
 const allowed=new Set(storageIds);
 const prints=fingerprints.filter(row=>allowed.has(row.film_id)),points=pointers.filter(row=>allowed.has(row.film_id));
 const complete=coverage?.status==='complete';
 const fingerprint=prints.length?{status:'present',storageIds:prints.map(row=>row.film_id).sort()}:complete?{status:'absent',reason:'fingerprint_absent'}:{status:'partial',reason:coverage?.reason||'coverage_incomplete'};
 let prediction;
 const bodies=new Set(points.map(row=>(row.r2_key||'')+'\u0000'+(row.content_sha256||'')));
 if(bodies.size>1)prediction={status:'conflict',reason:'storage_ids_disagree',storageIds:points.map(row=>row.film_id).sort()};
 else if(points.length)prediction={status:complete?'present':'partial',storageIds:points.map(row=>row.film_id).sort(),...(complete?{}:{reason:coverage?.reason||'coverage_incomplete'})};
 else prediction=complete?{status:'absent',reason:'prediction_absent'}:{status:'partial',reason:coverage?.reason||'coverage_incomplete'};
 // Compatibility: only the verdicts provable without the ADR-0035 registry. A pointer bound to another fingerprint hash, or an invalidated
 // fingerprint, is incompatible; anything else stays unknown (the profile rule and the transition registry are the prediction domain's).
 let compatibility='unknown',compatibilityReason='registry_not_read';
 const byId=new Map(prints.map(row=>[row.film_id,row]));
 for(const row of points){
  const print=byId.get(row.film_id);
  if(print&&filled(print.invalidated_at)){compatibility='incompatible';compatibilityReason='fingerprint_invalidated';break;}
  if(print&&filled(row.fingerprint_hash)&&row.fingerprint_hash!==print.fingerprint_hash){compatibility='incompatible';compatibilityReason='fingerprint_hash_mismatch';break;}
 }
 return {fingerprint,prediction,compatibility,compatibilityReason,coverage};
}

// Decision 3: the effective localization the existing resolver gives over the authorities (owner_review_entry, the applied reviewed row, the
// source rows), plus the stored provisional row as the legacy candidate of its own source exactly as loadLocalizationInputs feeds it at runtime.
// ownerValues: the distinct verified owner values of the Film and its redirect ancestors; more than one is an owner conflict.
export function localizationFacts({row=null,sources=[],ownerValues=[],ownerAvailable=true}={}){
 if(!ownerAvailable)return {status:'unavailable',reason:'owner_review_unavailable',resolved:null};
 const distinct=[...new Set(ownerValues.map(item=>item.value))];
 if(distinct.length>1)return {status:'conflict',reason:'owner_conflict',resolved:null};
 const input={owner:null,reviewed:null,automatic:sources.map(item=>({source:item.source,value:item.value,sourceVersion:item.source_version??null,provenance:parseJson(item.provenance_json).value,observedAt:item.observed_at??null}))};
 if(distinct.length)input.owner={value:distinct[0],at:null};
 const sole=!!row&&row.status==='provisional'&&!filled(row.authority)&&filled(row.value)&&filled(row.source)&&!sources.some(item=>item.source===row.source);
 // ADR 0218 D1 (AIR-662): a marked owner projection is a projection of the owner_review_entry decision read above, never an independent owner input: with the evidence read
 // (ownerAvailable) its removal or change leaves the row stale. An unmarked legacy owner/reviewed row keeps its control.
 if(isOwnerProjection(row)){/* not an input */}
 else if(row?.status==='reviewed'&&filled(row.value)){
  if(row.authority==='owner'&&!input.owner)input.owner={value:row.value,at:row.updated_at??null};
  else if(row.authority!=='owner')input.reviewed={value:row.value,source:row.source||'dictionary',at:row.updated_at??null};
 }else if(sole)input.automatic.push({source:row.source,value:row.value,sourceVersion:row.source_version??null,provenance:parseJson(row.provenance_json).value,observedAt:row.updated_at??null});
 const resolved=resolveLocalization(input);
 return {status:resolved.tier==='none'?'unknown':'present',resolved:{value:resolved.value,tier:resolved.tier,source:resolved.source},soleRecord:sole};
}

// The statuses current and historical writers produce: the AIR-42 lifecycle enums (src/domain/film-person.js) plus the `reviewed` control
// status; identity also carries the ADR 0216 verdict words a W1/C1 write may store. Anything else is unknown legacy.
export const KNOWN_STATUSES=Object.freeze({
 identity:Object.freeze(['unresolved','resolving','resolved','ambiguous','rejected','reviewed','found','redirected','absent','conflict','unverified','cycle']),
 metadata:Object.freeze(['missing','fetching','partial','fresh','stale','failed','reviewed']),
 localization:Object.freeze(['missing','provisional','reviewed']),
 fingerprint:Object.freeze(['missing','generating','current','stale','failed']),
 prediction:Object.freeze(['missing','generating','current','stale','failed']),
});

// Decision 1, per row. facts: the derived facts of this row's Film ({identity, metadata, localization, prediction}). Every row carries `proof`:
// `complete` only when the derived fact of its dimension is fully proved, `incomplete` when it was read but not proved (coverage incomplete,
// a partial or unknown state, a missing metadata row), `unavailable` when it could not be read (a held or non-authoritative marker, or an
// identity verdict that did not pass the fence). Control and unknown_legacy classifications never depend on proof; stale_copy never means
// "safe to retire" by itself: a later stage also requires proof `complete`.
export function classifyRow(row,facts={}){
 const reasons=[],notes=[];
 const provenance=parseJson(row.provenance_json);
 const titleSource=provenance.ok&&plain(provenance.value)&&provenance.value.titleSource!==undefined;
 const processing=['last_error','failure_reason','retry_at','next_action'].some(name=>filled(row[name])&&!(name==='next_action'&&row[name]==='none'))||Number(row.attempts)>0;
 if(processing)notes.push('processing_fields');
 if(facts.identity?.verdict==='redirected')notes.push('film_redirected');
 const proof=proofOf(row.dimension,facts);
 const done=(klass,extra={})=>({film_id:row.film_id,dimension:row.dimension,class:klass,reasons,notes,proof,...extra});
 const known=KNOWN_STATUSES[row.dimension];
 if(!known){reasons.push('unknown_dimension');return done('unknown_legacy');}
 // Ambiguous content first: an unreadable provenance could hide a titleSource or an owner decision; an unknown status has no writer.
 if(!provenance.ok||(provenance.value!=null&&!plain(provenance.value)))reasons.push('malformed_provenance');
 if(!known.includes(row.status))reasons.push('unknown_status');
 switch(row.dimension){
  case 'identity':{
   if(filled(row.authority)&&row.authority!=='owner')reasons.push('unknown_authority');
   if(reasons.length)return done('unknown_legacy');
   if(row.authority==='owner')reasons.push('owner_authority');
   if(row.status==='reviewed')reasons.push('reviewed');
   if(titleSource)reasons.push('title_source');
   if(reasons.length)return done('control');
   return done('stale_copy',{diverges:proof==='unavailable'?null:row.status!==facts.identity.verdict});
  }
  case 'metadata':{
   if(filled(row.authority)&&row.authority!=='owner')reasons.push('unknown_authority');
   if(titleSource)reasons.push('title_source_outside_identity');
   // The ADR 0214 decision 5 lock predicate, unchanged, wins over every other reason: a locked row is control even when it is odd.
   if(row.status==='reviewed'||row.authority==='owner'){reasons.push('metadata_lock');return done('control');}
   if(reasons.length)return done('unknown_legacy');
   return done('stale_copy',{diverges:null});
  }
  case 'localization':{
   if(filled(row.authority)&&!LOCALIZATION_AUTHORITIES.has(row.authority))reasons.push('unknown_authority');
   if(titleSource)reasons.push('title_source_outside_identity');
   // strong() protects every owner-authority row; an owner or dictionary authority on a non-reviewed row has no writer and is never an automatic candidate.
   if(row.status!=='reviewed'&&filled(row.authority)&&LOCALIZATION_AUTHORITIES.has(row.authority))reasons.push(row.authority==='owner'?'owner_authority_not_reviewed':'dictionary_authority_not_reviewed');
   // A marked owner projection (the row the projection-aware writer materialized from an owner decision) is a copy of owner_review_entry, never an independent owner authority:
   // `agree` while the current decision still resolves to its value; otherwise `control` (kept, NEVER a stale_copy, so never retirement-eligible) as a stale or unproved
   // projection, the handoff to the separate reconciler (AIR-663). Missing or unavailable owner evidence is never read as a proved revocation.
   if(isOwnerProjection(row)&&!reasons.length){
    const loc=facts.localization;
    if(proof==='unavailable'||!loc||loc.status==='unavailable'||loc.status==='conflict'){reasons.push('owner_projection_unproved');return done('control');}
    if(loc.resolved?.tier==='owner'&&loc.resolved.value===(row.value??'').trim()){reasons.push('owner_projection');return done('agree');}
    reasons.push('owner_projection_stale');
    notes.push('expected_'+(loc.resolved?.tier??'none'));
    return done('control',{expected:{tier:loc.resolved?.tier??'none',source:loc.resolved?.source??null}});
   }
   if(row.status==='reviewed'&&!reasons.length){
    reasons.push(row.authority==='owner'?'owner_applied':'reviewed_applied');
    const loc=facts.localization;
    if(loc?.status==='present'&&loc.resolved.tier==='owner'&&loc.resolved.value!==(row.value??'').trim())notes.push('owner_entry_differs');
    return done('control');
   }
   if(reasons.length)return done('unknown_legacy');
   const loc=facts.localization;
   if(proof==='unavailable'){reasons.push('projection_unproved');return done('control');}
   if(loc.status==='conflict'){reasons.push('owner_conflict');return done('unknown_legacy');}
   const expected=loc.resolved;
   const same=expected&&sameText(expected.value,(row.value??'').trim()||null)&&sameText(expected.tier==='automatic'?expected.source:null,row.source??null);
   if(same&&loc.soleRecord){reasons.push('projection_sole_record');return done('control');}
   if(same)return done('agree');
   reasons.push('projection_stale');
   return done('stale_copy',{expected:{tier:expected?.tier??'none',source:expected?.source??null}});
  }
  default:{
   if(filled(row.authority))reasons.push('unknown_authority');
   if(row.status==='reviewed')reasons.push('reviewed_status');
   if(titleSource)reasons.push('title_source_outside_identity');
   if(reasons.length)return done('unknown_legacy');
   return done('stale_copy',{diverges:null,derived:facts.prediction?.[row.dimension]?.status??null});
  }
 }
}
function proofOf(dimension,facts){
 const identity=facts.identity;
 if(!identity||identity.verdict==='unavailable')return 'unavailable';
 if(dimension==='identity')return 'complete';
 if(!identityPassed(identity))return 'unavailable';
 if(dimension==='metadata')return facts.metadata?.fields&&Object.values(facts.metadata.fields).every(field=>field.status!=='unknown')?'complete':'incomplete';
 if(dimension==='localization'){const status=facts.localization?.status;return !status||status==='unavailable'?'unavailable':'complete';}
 const status=facts.prediction?.[dimension]?.status;
 if(!status||status==='unavailable')return 'unavailable';
 const complete=facts.prediction?.coverage?.status==='complete';
 return complete&&(status==='present'||status==='absent')?'complete':'incomplete';
}

// A deterministic summary: counts per dimension and class, per reason and per proof; no ids, values or payloads.
export function summarize(classified){
 const byDimension={},reasons={},proof={},notes={};
 for(const dimension of PARITY_DIMENSIONS)byDimension[dimension]=Object.fromEntries(PARITY_CLASSES.map(name=>[name,0]));
 for(const item of classified){
  (byDimension[item.dimension]||(byDimension[item.dimension]=Object.fromEntries(PARITY_CLASSES.map(name=>[name,0]))))[item.class]++;
  for(const reason of item.reasons){const key=item.dimension+':'+reason;reasons[key]=(reasons[key]||0)+1;}
  for(const note of item.notes){const key=item.dimension+':'+note;notes[key]=(notes[key]||0)+1;}
  const key=item.dimension+':'+item.proof;proof[key]=(proof[key]||0)+1;
 }
 const sort=object=>Object.fromEntries(Object.entries(object).sort(([a],[b])=>a<b?-1:a>b?1:0));
 return {rows:classified.length,byDimension,reasons:sort(reasons),notes:sort(notes),proof:sort(proof)};
}
