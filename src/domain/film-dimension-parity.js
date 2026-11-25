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
import {resolveLocalization} from '../localization-sources.js';

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
 if(!input.survivorExists)return {verdict:'absent',reason:'no_survivor_row',survivor:null,chain:redirect.chain||[],aliases:emptyAliases()};
 const retired=input.retired||new Set();
 const claims=(input.claims||[]).filter(claim=>!(claim.scheme==='tmdb'&&retired.has(String(claim.value))));
 const unsettled=claims.filter(claim=>SECTION_SCHEMES.includes(claim.scheme)&&!own(claim));
 const trusted=claims.filter(own);
 const values=new Set(trusted.filter(claim=>SECTION_SCHEMES.includes(claim.scheme)).map(claim=>claim.scheme+'\u0000'+String(claim.value)));
 const survivor=redirect.survivor||input.requested;
 const competing=(input.competing||[]).filter(row=>row.film_id!==survivor&&values.has(row.scheme+'\u0000'+String(row.value)));
 const aliases=aliasesOf(trusted);
 const base={survivor,chain:redirect.chain||[],aliases};
 if(unsettled.length)return {...base,verdict:'conflict',reason:'unsettled_claim'};
 if(competing.length)return {...base,verdict:'conflict',reason:'competing_claim'};
 return {...base,verdict:redirect.state==='redirected'?'redirected':'found',reason:null};
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

// Decision 2, metadata: value presence and provenance confidence are separate. Without per-field provenance (film_metadata_field is not live)
// a usable value is `present` with confidence `unattributed`, and everything else is `unknown`: an explicit null cannot be proven. Freshness is
// `unknown` (no window is set by ADR 0218; ADR 0214 PVT owns it).
export function metadataFacts(row,{provenance=null}={}){
 const fields={};
 for(const field of CORE_FIELDS){
  if(!row){fields[field]={status:'unknown',reason:'no_metadata_row',confidence:null};continue;}
  const usable=usableField(field,row);
  const record=provenance?.[field]||null;
  if(usable.usable)fields[field]={status:'present',confidence:record?.confidence||'unattributed'};
  else if(record&&record.explicitNull===true&&usable.reason==='null')fields[field]={status:'absent',reason:'explicit_null',confidence:record.confidence||null};
  else fields[field]={status:'unknown',reason:usable.reason,confidence:null};
 }
 return {fields,freshness:'unknown',present:CORE_FIELDS.filter(field=>fields[field].status==='present')};
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
 const sole=!!row&&row.status==='provisional'&&filled(row.value)&&filled(row.source)&&!sources.some(item=>item.source===row.source);
 if(row?.status==='reviewed'&&filled(row.value)){
  if(row.authority==='owner'&&!input.owner)input.owner={value:row.value,at:row.updated_at??null};
  else if(row.authority!=='owner')input.reviewed={value:row.value,source:row.source||'dictionary',at:row.updated_at??null};
 }else if(sole)input.automatic.push({source:row.source,value:row.value,sourceVersion:row.source_version??null,provenance:parseJson(row.provenance_json).value,observedAt:row.updated_at??null});
 const resolved=resolveLocalization(input);
 return {status:resolved.tier==='none'?'unknown':'present',resolved:{value:resolved.value,tier:resolved.tier,source:resolved.source},soleRecord:sole};
}

// Decision 1, per row. facts: the derived facts of this row's Film ({identity, metadata, localization, prediction}); proof is 'complete' when
// the facts of the row's dimension were readable and 'unavailable' otherwise, so a later stage never treats an unproved row as replaceable.
export function classifyRow(row,facts={}){
 const reasons=[],notes=[];
 const provenance=parseJson(row.provenance_json);
 const titleSource=provenance.ok&&plain(provenance.value)&&provenance.value.titleSource!==undefined;
 const processing=['last_error','failure_reason','retry_at','next_action'].some(name=>filled(row[name])&&!(name==='next_action'&&row[name]==='none'))||Number(row.attempts)>0;
 if(processing)notes.push('processing_fields');
 if(facts.identity?.verdict==='redirected')notes.push('film_redirected');
 const done=(klass,proof,extra={})=>({film_id:row.film_id,dimension:row.dimension,class:klass,reasons,notes,proof,...extra});
 const identityProof=facts.identity&&facts.identity.verdict!=='unavailable'?'complete':'unavailable';
 switch(row.dimension){
  case 'identity':{
   if(!provenance.ok){reasons.push('malformed_provenance');return done('unknown_legacy',identityProof);}
   if(filled(row.authority)&&row.authority!=='owner'){reasons.push('unknown_authority');return done('unknown_legacy',identityProof);}
   if(row.authority==='owner')reasons.push('owner_authority');
   if(row.status==='reviewed')reasons.push('reviewed');
   if(titleSource)reasons.push('title_source');
   if(reasons.length)return done('control',identityProof);
   return done('stale_copy',identityProof,{diverges:identityProof==='complete'?row.status!==facts.identity.verdict:null});
  }
  case 'metadata':{
   if(filled(row.authority)&&row.authority!=='owner'){reasons.push('unknown_authority');return done('unknown_legacy','complete');}
   if(titleSource){reasons.push('title_source_outside_identity');return done('unknown_legacy','complete');}
   // The ADR 0214 decision 5 lock predicate, unchanged.
   if(row.status==='reviewed'||row.authority==='owner'){reasons.push('metadata_lock');return done('control','complete');}
   const present=facts.metadata?.present?.length??0;
   return done('stale_copy','complete',{diverges:null,metadataPresent:present});
  }
  case 'localization':{
   if(filled(row.authority)&&!LOCALIZATION_AUTHORITIES.has(row.authority)){reasons.push('unknown_authority');return done('unknown_legacy','complete');}
   if(!LOCALIZATION_STATUSES.has(row.status)){reasons.push('unknown_status');return done('unknown_legacy','complete');}
   if(titleSource){reasons.push('title_source_outside_identity');return done('unknown_legacy','complete');}
   const loc=facts.localization;
   if(row.status==='reviewed'){
    reasons.push(row.authority==='owner'?'owner_applied':'reviewed_applied');
    if(loc?.status==='present'&&loc.resolved.tier==='owner'&&loc.resolved.value!==(row.value??'').trim())notes.push('owner_entry_differs');
    return done('control',loc&&loc.status!=='unavailable'?'complete':'unavailable');
   }
   if(!loc||loc.status==='unavailable'){reasons.push('projection_unproved');return done('control','unavailable');}
   if(loc.status==='conflict'){reasons.push('owner_conflict');return done('unknown_legacy','complete');}
   const expected=loc.resolved;
   const same=expected&&sameText(expected.value,(row.value??'').trim()||null)&&sameText(expected.tier==='automatic'?expected.source:null,row.source);
   if(same&&loc.soleRecord){reasons.push('projection_sole_record');return done('control','complete');}
   if(same)return done('agree','complete');
   reasons.push('projection_stale');
   return done('stale_copy','complete',{expected:{tier:expected?.tier??'none',source:expected?.source??null}});
  }
  case 'fingerprint':
  case 'prediction':{
   if(filled(row.authority)){reasons.push('unknown_authority');return done('unknown_legacy',predictionProof(facts,row.dimension));}
   if(row.status==='reviewed'){reasons.push('reviewed_status');return done('unknown_legacy',predictionProof(facts,row.dimension));}
   if(titleSource){reasons.push('title_source_outside_identity');return done('unknown_legacy',predictionProof(facts,row.dimension));}
   const proof=predictionProof(facts,row.dimension),derived=facts.prediction?.[row.dimension]?.status??null;
   return done('stale_copy',proof,{diverges:null,derived});
  }
  default:
   reasons.push('unknown_dimension');
   return done('unknown_legacy','unavailable');
 }
}
const predictionProof=(facts,dimension)=>{const status=facts.prediction?.[dimension]?.status;return status&&status!=='unavailable'?'complete':'unavailable';};

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
