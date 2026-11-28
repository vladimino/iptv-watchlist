// AIR-665 / ADR 0218 (Accepted) decision 4, delivery graph stage 5: derived Film readiness over the FilmAggregateV1 body (ADR 0216, AIR-647).
// DORMANT and PURE: no D1 statement, no R2, no network, no write, no import of the Worker. It takes the aggregate body that AIR-647 already produces and
// answers displayReady / catalogReady / predictionReady. Scoped into the Worker bundle with the rest of the aggregate (AIR-648, scopedFilmAggregate()) but unrouted: no consumer is switched.
// Every predicate returns exactly one {value, rule, reason}: value is true, false, 'unknown' or 'not_applicable'; the rules are evaluated in order and the
// FIRST match wins, so the cases are exhaustive and mutually exclusive. `false` is stated only when the authoritative section proves the negative.
// Readiness is never an eligibility or existence gate (ADR 0218, ADR 0154); freshness and provenance are reported beside it and never required by it.

export const READINESS_CONTRACT='film-readiness/v1';
export const CORE_FIELDS=['year','runtime','synopsis','poster','url','genres'];

const positiveInteger=v=>Number.isInteger(v)&&v>0;
const nonBlank=v=>typeof v==='string'&&v.trim().length>0;
const USABLE={
 year:positiveInteger,
 runtime:positiveInteger,
 synopsis:nonBlank,
 poster:nonBlank,
 url:nonBlank,
 genres:v=>Array.isArray(v)&&v.length>0&&v.every(nonBlank),
};
export const usableTitle=nonBlank;
export const usableCoreField=(name,value)=>Object.hasOwn(USABLE,name)&&USABLE[name](value);

const out=(value,rule,reason=null)=>({value,rule,reason});
const sectionOk=s=>s!=null&&typeof s==='object'&&s.status!=='unavailable';
// A field is `present` with a usable value; any other status or an unusable value is unknown, never proved absent. Only an explicit `absent` (explicit-null
// provenance, ADR 0214) is a proof.
const fieldUsable=(field,name)=>field?.status==='present'&&usableCoreField(name,field.value);

// Identity gate G1-G3. Returns null to continue, else the result every predicate shares.
function gate(identity){
 const verdict=identity?.verdict;
 if(verdict==='unavailable')return out('unknown','G1','identity_unavailable');
 if(['absent','retired','conflict','unverified','cycle'].includes(verdict))return out('not_applicable','G2',verdict);
 if(verdict==='found'||verdict==='redirected')return null;
 // `invalid` or a missing identity: the typed id was not resolved to a verdict of ADR 0216.
 return out('unknown','G1','identity_not_resolved');
}

export function displayReady(body){
 const g=gate(body?.identity);
 if(g)return g;
 const display=body.display;
 const f=display?.fields||{};
 if(sectionOk(display)){
  if(f.title?.status==='present'&&usableTitle(f.title.value))return out(true,'D1');
  if(f.originalTitle?.status==='present'&&usableTitle(f.originalTitle.value))return out(true,'D1');
 }
 if(!sectionOk(display))return out('unknown','D2','display_unavailable');
 if(f.title?.status==='absent'&&f.originalTitle?.status==='absent')return out(false,'D3','no_title');
 return out('unknown','D4','title_unknown');
}

// A stable alias: a verified Letterboxd lid or a trusted, non-conflicting TMDB movie claim of the survivor. A `tmdb_tv` claim is never one.
const stableClaim=c=>(c?.scheme==='letterboxd'||c?.scheme==='tmdb')&&c.trusted===true&&!c.conflicting&&!c.retired&&!c.competing;

export function catalogReady(body){
 const g=gate(body?.identity);
 if(g)return g;
 if(!(body.identity.claims||[]).some(stableClaim))return out(false,'C1','no_stable_alias');
 const display=body.display;
 if(sectionOk(display)&&CORE_FIELDS.some(n=>fieldUsable(display.fields?.[n],n)))return out(true,'C2');
 if(!sectionOk(display))return out('unknown','C3','display_unavailable');
 if(CORE_FIELDS.every(n=>display.fields?.[n]?.status==='absent'))return out(false,'C4','no_core_metadata');
 return out('unknown','C5','metadata_unknown');
}

// ---- Prediction-domain evidence (checked handoff) ----
// The aggregate has no fingerprint section and no compatibility verdict (ADR 0216), so P3, P5 and P6 need prediction-domain facts. Two independent objects:
//  - `evidence`: the OBSERVATION, built by the reading side from `predictionFacts` (AIR-660) with the context it captured while reading: the Film, the
//    identity token, the aggregate prediction and coverage tokens, the active taste profile (version and hash), the compatibility registry snapshot token,
//    and the fingerprint read-set (authorized storage ids examined) with its token;
//  - `context`: the EXPECTED coherent context, supplied independently by the trusted, already-fenced composition that owns those inputs (AIR-648 acquires and
//    fences it from the existing domain authority; this module reads nothing): identity token, active profile, registry token, fingerprint read-set and token.
// `checkPredictionEvidence` compares what the observation captured with that context and with the body being judged: nothing is copied from the evidence to
// validate itself, every proof must be present (a missing or null token never equals another missing token), and any difference (moved identity, moved active
// profile or registry, changed fingerprint, omitted or unreadable fingerprint read) makes the evidence uncertifying: P3/P5/P6 are not reached, the result is
// `unknown`. P4 never depends on it. No storage read, no compatibility algorithm and no adapter lives here, and no new eligibility or limit is imposed.
export const PREDICTION_EVIDENCE_CONTRACT='film-prediction-evidence/v1';
const FINGERPRINT_STATES=['present','absent','partial','unavailable','unknown'];
const COMPATIBILITY=['compatible','incompatible','unknown'];
const canonical=v=>JSON.stringify(v,(k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(key=>[key,x[key]])):x);
const defined=v=>v!==undefined&&v!==null&&(typeof v!=='object'||Object.values(v).every(defined));
// A proof is a value that states something: not undefined, null, blank or empty, with no undefined or null member (an empty list inside a token is a statement).
const proven=v=>defined(v)&&(typeof v==='string'?v.trim().length>0:typeof v==='object'?Array.isArray(v)?v.length>0:Object.keys(v).length>0:true);
const same=(a,b)=>proven(a)&&proven(b)&&canonical(a)===canonical(b);
const sameSet=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&same([...a].sort(),[...b].sort());

// The storage ids the aggregate authorizes: each verified lid and `tmdb_<n>` of a trusted, non-conflicting, non-retired, uncontested movie claim.
export function authorizedStorageIds(identity){
 const ids=[];
 for(const c of identity?.claims||[]){
  if(!stableClaim(c))continue;
  ids.push(c.scheme==='tmdb'?'tmdb_'+c.value:String(c.value));
 }
 return ids.sort();
}

// Build the observation from `predictionFacts` output and the context captured with it. A plain object: the reading side owns the facts, this fixes the shape.
export function predictionEvidence(facts,captured={}){
 const {filmId,identityToken,predictionToken,coverageToken,profile,registryToken,fingerprintToken,examinedStorageIds}=captured;
 return {
  contract:PREDICTION_EVIDENCE_CONTRACT,filmId,identityToken,predictionToken,coverageToken,profile,registryToken,fingerprintToken,
  examinedStorageIds:[...(examinedStorageIds||[])],fingerprint:facts?.fingerprint?.status??'unknown',fingerprintStorageIds:[...(facts?.fingerprint?.storageIds||[])],
  compatibility:facts?.compatibility??'unknown',
 };
}

// -> null when the observation is coherent with `body` and the independently supplied `context`, else the reason it is not. Never throws.
export function checkPredictionEvidence(body,evidence,context){
 try{
  if(evidence==null||typeof evidence!=='object'||evidence.contract!==PREDICTION_EVIDENCE_CONTRACT)return 'evidence_shape';
  if(!FINGERPRINT_STATES.includes(evidence.fingerprint)||!COMPATIBILITY.includes(evidence.compatibility))return 'evidence_shape';
  if(context==null||typeof context!=='object')return 'context_missing';
  const identity=body?.identity,p=body?.predictions;
  if(!proven(evidence.filmId)||evidence.filmId!==identity?.filmId)return 'evidence_foreign_film';
  // Identity: the observation, the context and the body's own fenced identity token must be one and the same, and stated.
  if(!same(evidence.identityToken,identity?.token)||!same(context.identityToken,identity?.token))return 'evidence_identity_moved';
  // The aggregate's own prediction and coverage tokens, as the observation captured them.
  if(!p||!same(evidence.predictionToken,p.token)||!same(evidence.coverageToken,p.coverage?.token))return 'evidence_token_moved';
  // The active profile and the compatibility registry the verdict was computed against, versus the expected ones.
  if(!same(evidence.profile,context.profile)||!same(evidence.registryToken,context.registryToken))return 'evidence_profile_changed';
  // The fingerprint read-set: every authorized storage id examined, under the expected read-set and its token.
  const authorized=authorizedStorageIds(identity);
  if(!authorized.length||!sameSet(evidence.examinedStorageIds,authorized)||!sameSet(context.examinedStorageIds,authorized))return 'evidence_incomplete_fingerprint_coverage';
  if(!same(evidence.fingerprintToken,context.fingerprintToken))return 'evidence_fingerprint_changed';
  if(!evidence.fingerprintStorageIds.every(id=>authorized.includes(id)))return 'evidence_foreign_film';
  if(evidence.fingerprint==='absent'&&evidence.fingerprintStorageIds.length)return 'evidence_incoherent';
  if(evidence.fingerprint==='present'&&!evidence.fingerprintStorageIds.length)return 'evidence_incoherent';
  return null;
 }catch{return 'evidence_shape';}
}

// `evidence` and `context` are optional (above). Without both, or when they do not cohere, every prediction fact only the prediction domain can state is
// `unknown`: a negative or a positive is never inferred from the aggregate, from a bare verdict or from a freshly relabelled stale observation.
export function predictionReady(body,evidence,context){
 const g=gate(body?.identity);
 if(g)return g;
 const p=body.predictions;
 const supplied=evidence!=null;
 const unbound=supplied?checkPredictionEvidence(body,evidence,context):null;
 const ev=supplied&&!unbound?evidence:null;
 const fingerprint=ev?.fingerprint??'unknown';
 const compatibility=ev?.compatibility??'unknown';
 if(!sectionOk(p)||fingerprint==='unavailable')return out('unknown','P1','prediction_unavailable');
 if(p.status==='conflict')return out('unknown','P2','conflict');
 const complete=p.coverage?.status==='complete';
 if(fingerprint==='absent'&&complete)return out(false,'P3','fingerprint_absent');
 if(p.status==='absent'&&p.reason==='none'&&complete)return out(false,'P4','prediction_absent');
 if(compatibility==='incompatible')return out(false,'P5','incompatible');
 if(fingerprint==='present'&&p.status==='present'&&compatibility==='compatible'&&complete)return out(true,'P6');
 const reason=unbound?'prediction_'+unbound:fingerprint!=='present'?'fingerprint_unknown':!complete?'coverage_incomplete':p.status!=='present'?'section_'+p.status:'compatibility_unknown';
 return out('unknown','P7',reason);
}

// Provenance confidence and freshness, reported beside readiness. This ADR sets no freshness window: freshness is `unknown` (ADR 0214 PVT owns the policy).
export function readinessContext(body){
 const f=body?.display?.fields||{};
 const provenance={};
 for(const n of CORE_FIELDS)provenance[n]=f[n]?.provenance??'unknown';
 return {provenance,freshness:'unknown'};
}

export function deriveReadiness(body,{prediction}={}){ // `prediction`: {evidence, context}, see predictionReady
 return {
  contract:READINESS_CONTRACT,
  displayReady:displayReady(body),
  catalogReady:catalogReady(body),
  predictionReady:predictionReady(body,prediction?.evidence,prediction?.context),
  ...readinessContext(body),
 };
}
