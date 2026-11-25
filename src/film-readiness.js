// AIR-665 / ADR 0218 (Accepted) decision 4, delivery graph stage 5: derived Film readiness over the FilmAggregateV1 body (ADR 0216, AIR-647).
// DORMANT and PURE: no D1 statement, no R2, no network, no write, no import of the Worker. It takes the aggregate body that AIR-647 already produces and
// answers displayReady / catalogReady / predictionReady. Not in the Worker bundle (build.mjs does not name it); no consumer is switched.
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

// `prediction` carries the prediction-domain verdicts the aggregate does not read (no fingerprint section in ADR 0216): fingerprint
// 'present'|'absent'|'unavailable'|'unknown', compatibility 'compatible'|'incompatible'|'unknown'. Not supplied means unknown: a negative is never inferred.
export function predictionReady(body,prediction={}){
 const g=gate(body?.identity);
 if(g)return g;
 const p=body.predictions;
 const fingerprint=prediction.fingerprint??'unknown';
 const compatibility=prediction.compatibility??'unknown';
 if(!sectionOk(p)||fingerprint==='unavailable')return out('unknown','P1','prediction_unavailable');
 if(p.status==='conflict')return out('unknown','P2','conflict');
 const complete=p.coverage?.status==='complete';
 if(fingerprint==='absent'&&complete)return out(false,'P3','fingerprint_absent');
 if(p.status==='absent'&&p.reason==='none'&&complete)return out(false,'P4','prediction_absent');
 if(compatibility==='incompatible'&&(fingerprint==='present'||p.status==='present'))return out(false,'P5','incompatible');
 if(fingerprint==='present'&&p.status==='present'&&compatibility==='compatible'&&complete)return out(true,'P6');
 const reason=fingerprint!=='present'?'fingerprint_unknown':!complete?'coverage_incomplete':p.status!=='present'?'section_'+p.status:'compatibility_unknown';
 return out('unknown','P7',reason);
}

// Provenance confidence and freshness, reported beside readiness. This ADR sets no freshness window: freshness is `unknown` (ADR 0214 PVT owns the policy).
export function readinessContext(body){
 const f=body?.display?.fields||{};
 const provenance={};
 for(const n of CORE_FIELDS)provenance[n]=f[n]?.provenance??'unknown';
 return {provenance,freshness:'unknown'};
}

export function deriveReadiness(body,{prediction}={}){
 return {
  contract:READINESS_CONTRACT,
  displayReady:displayReady(body),
  catalogReady:catalogReady(body),
  predictionReady:predictionReady(body,prediction),
  ...readinessContext(body),
 };
}
