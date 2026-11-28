// AIR-648 / ADR 0218 stage 5: the D1 reader of the PREDICTION-DOMAIN evidence that predictionReady needs for P3 (fingerprint absent), P5 (incompatible) and P6 (ready).
// DORMANT like the aggregate: scoped into the Worker bundle, called by nothing (no route, no consumer) until the owner-approved activation. It reads D1 only (two SELECTs,
// no write, no R2, no network) and adds no algorithm: the compatibility verdict is the prediction domain's own, supplied by the caller as `reader.verdictOf`.
//
// Shape (ADR 0218 decision 4, src/film-readiness.js checkPredictionEvidence):
//   begin   - reserves TWO statements of the request budget before the sections read (so no section can consume them), then CAPTURES once (statement A): the prediction marker,
//             the active profile, the fingerprint and pointer rows of the authorized storage ids and the Film's genres, plus the registry token. The observation (`evidence`) is built from A.
//   finish  - after EVERY section read and its own after-read, CAPTURES again (statement B, the final consistency fence). The expected `context` is built from B alone.
// The two captures are independent reads. The observation is certified only when it coheres with the context and with the aggregate body actually judged (identity, prediction and
// coverage tokens, the active profile, the registry, the fingerprint read-set); a profile, registry, fingerprint or pointer that moved between A and B, a stale profile or fingerprint
// behind an unchanged pointer, a held or unreadable marker, or a failed read leaves P3/P5/P6 `unknown`. The prediction facts and their provable verdicts come from
// predictionFacts (src/domain/film-dimension-parity.js); nothing here infers a negative from the aggregate, from a verdict alone or from a missing row.
// What is fenced (A against B, and A and B against the aggregate body judged): the active profile (version, hash, the marker's profile generation AND a digest of the lineage the verdict
// reads), the registry token, and the read-set token over EVERY other verdict input (the examined ids, each fingerprint row with its features digest, each pointer row, the Film's genres);
// the prediction authority generation, and the pointers themselves, bound to the aggregate's own predictions token (generation and the digest of its `current` list, which covers every
// pointer field it reads). The read set is the resolver's own capped authorized set (aliases(): at most AUTHORIZED_ALIASES_PER_SCHEME per scheme); an alias overflow is never certified.
// Held semantics: the aggregate's predictions section reads only mode and generation of the prediction marker (a held marker does not make it unavailable); this reader additionally requires
// writes `open` (the served-state rule of the parity reader), so a held marker makes the fingerprint `unavailable` and predictionReady P1 `unknown` (ADR 0218 P1: marker held).
// Cost: exactly PREDICTION_EVIDENCE_STATEMENTS of the shared request budget (no new cap); the derivation itself adds none.
import {sha256Hex} from './sha256-sync.js';
import {database} from './film-person-authority.js';
import {countedDatabase,fenceOf,row,digestOf,aliases,pointerRow} from './film-aggregate.js';
import {predictionEvidence} from './film-readiness.js';
import {predictionFacts} from './domain/film-dimension-parity.js';

export const PREDICTION_EVIDENCE_STATEMENTS=2;
// One statement, one snapshot. Every table is read by its primary key or the partial unique index of the active profile (prediction_profile_active); the id lists are bound
// as JSON so the statement shape never changes with the number of aliases, and each list is capped at its own length + 1 (a primary key cannot return more rows than ids).
export const PREDICTION_EVIDENCE_SQL=
 "SELECT (SELECT json_object('mode',mode,'writes',writes,'generation',generation,'profileGeneration',profile_generation) FROM prediction_domain_authority WHERE id=1) AS marker,"
 +"(SELECT json_object('version',version,'profileHash',profile_hash,'lineage',json(CASE WHEN json_valid(lineage_json) THEN lineage_json END),'lineageValid',CASE WHEN lineage_json IS NULL OR json_valid(lineage_json) THEN 1 ELSE 0 END) FROM prediction_profile WHERE active=1) AS profile,"
 +"(SELECT json_group_array(json_array(film_id,fingerprint_hash,schema_version,prompt_version,invalidated_at,content_sha256,json(CASE WHEN json_valid(features_json) THEN features_json END))) FROM (SELECT film_id,fingerprint_hash,schema_version,prompt_version,invalidated_at,content_sha256,features_json FROM prediction_fingerprint WHERE film_id IN (SELECT value FROM json_each(?)) ORDER BY film_id LIMIT ?)) AS fingerprints,"
 +"(SELECT json_group_array(json_array(film_id,predicted_rating,content_sha256,updated_at,r2_key,taste_profile_version,fingerprint_hash,display_json,taste_profile_hash,fingerprint_schema_version,prediction_prompt_version)) FROM (SELECT film_id,predicted_rating,content_sha256,updated_at,r2_key,taste_profile_version,fingerprint_hash,display_json,taste_profile_hash,fingerprint_schema_version,prediction_prompt_version FROM prediction_pointer WHERE film_id IN (SELECT value FROM json_each(?)) ORDER BY film_id LIMIT ?)) AS pointers,"
 +'(SELECT genres_json FROM film_metadata WHERE film_id=?) AS genres';

const parse=text=>{if(text==null)return null;if(typeof text!=='string')return text;try{return JSON.parse(text);}catch{return undefined;}};
const list=text=>{const value=parse(text);if(value==null)return [];if(!Array.isArray(value))throw new Error('malformed');return value;};

// One capture: the statement and the registry token, parsed into the shapes predictionFacts reads. Throws on anything that is not exactly what the schema promises.
async function capture(env,resolution,ids,budget,fence,reader){
 if(!fence.redeem())throw new Error('budget_exceeded');
 const db=countedDatabase(database(env),budget);
 const x=await row(db,PREDICTION_EVIDENCE_SQL,[JSON.stringify(ids),ids.length+1,JSON.stringify(ids),ids.length+1,resolution.filmId]);
 const registryToken=await reader.registryToken();
 const marker=parse(x.marker),profile=parse(x.profile),genres=parse(x.genres);
 const fingerprints=list(x.fingerprints).map(r=>({film_id:String(r[0]),fingerprint_hash:r[1],schema_version:r[2],prompt_version:r[3],invalidated_at:r[4],content_sha256:r[5],features:r[6]}));
 // The first eight columns are the aggregate's own pointer read (PREDICTION_SQL order), so `current` rebuilds the aggregate's `current` list exactly; the rest feed the verdict.
 const pointers=list(x.pointers).map(r=>({film_id:String(r[0]),taste_profile_version:r[5],taste_profile_hash:r[8],fingerprint_hash:r[6],fingerprint_schema_version:r[9],prediction_prompt_version:r[10],r2_key:r[4],content_sha256:r[2],predicted_rating:r[1],updated_at:r[3],raw:r.slice(0,8)}));
 if(marker===undefined||profile===undefined||genres===undefined)throw new Error('malformed');
 return {marker,profile,fingerprints,pointers,genres,registryToken};
}
const integer=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
// The marker proves the prediction facts only at d1 with writes open (the same served-state rule as the aggregate's predictions section and the parity reader).
function markerState(marker){
 if(marker==null||typeof marker!=='object')return {available:false,reason:'prediction_marker_unavailable'};
 if(marker.mode!=='d1')return {available:false,reason:'prediction_not_authoritative'};
 if(marker.writes!=='open')return {available:false,reason:'prediction_held'};
 if(!integer(marker.generation)||!integer(marker.profileGeneration))return {available:false,reason:'prediction_marker_malformed'};
 return {available:true};
}
// The active profile as the observation and the context state it: version, hash, the marker's profile generation and a digest of the LINEAGE the verdict reads (a valid-JSON lineage that
// changes at an unchanged version, hash and generation moves it). A legacy profile has no lineage (NULL or JSON null); a lineage that is valid JSON but not an array of plain objects is
// malformed, and no active profile or an unreadable lineage is no proof (null: the evidence is then not certifying, so P3/P5/P6 stay unknown).
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function profileOf(c){
 const p=c.profile;
 if(p==null||typeof p!=='object'||!integer(p.version)||typeof p.profileHash!=='string'||!p.profileHash||p.lineageValid!==1||!integer(c.marker?.profileGeneration))return null;
 const lineage=p.lineage??null;
 if(lineage!==null&&!(Array.isArray(lineage)&&lineage.every(plain)))return null;
 return {version:p.version,hash:p.profileHash,generation:c.marker.profileGeneration,lineage:digestOf(lineage)};
}
// The fingerprint read-set token: the examined ids, the Film's genres, every fingerprint row (including its features digest) and every pointer row. An empty set is a statement too (the absence
// token), so a fingerprint or pointer that appears or disappears between the two captures moves it.
const readSetToken=(c,ids)=>digestOf({ids,genres:sha256Hex(JSON.stringify(c.genres??null)),fingerprints:c.fingerprints.map(f=>[f.film_id,f.fingerprint_hash,f.schema_version,f.prompt_version,f.invalidated_at,f.content_sha256,sha256Hex(JSON.stringify(f.features??null))]),pointers:c.pointers.map(p=>[p.film_id,p.taste_profile_version,p.taste_profile_hash,p.fingerprint_hash,p.fingerprint_schema_version,p.prediction_prompt_version,p.r2_key,p.content_sha256,p.predicted_rating,p.updated_at,sha256Hex(JSON.stringify(p.raw[7]??null))])});

// Starts the evidence: reserves its statements, then captures the observation. `null` when it cannot (no authorized alias, no budget, a failed or malformed read): the
// caller then derives readiness without evidence, which never proves a prediction fact.
export async function beginPredictionEvidence(env,resolution,budget,reader){
 try{
  // The resolver's own capped authorized set (aliases()), never every claim: an overflow of a scheme the prediction pointers use means the read-set is not the full set, so nothing is certified.
  const set=aliases(resolution),ids=set.storageIds;
  if(set.overflow||!ids.length||typeof reader?.registryToken!=='function')return null;
  const fence=fenceOf(budget,PREDICTION_EVIDENCE_STATEMENTS);
  if(!fence)return null;
  try{return {fence,ids,first:await capture(env,resolution,ids,budget,fence,reader)};}
  catch{fence.release();return null;}
 }catch{return null;}
}

// The capture must be about the body judged: the prediction authority generation of A, of B and of the aggregate's own token are one number, and the pointers of A and of B are exactly the
// pointers the aggregate read (the digest of the aggregate's `current` list is its own token and covers every field it reads: storage id, rating, content digest, update time, R2 key,
// profile version, fingerprint hash and display), and that list is the token's own. Any difference (a generation or a pointer that moved transiently during the aggregate read) is no evidence.
const currentOf=c=>c.pointers.map(p=>pointerRow(p.raw)).sort((a,b)=>a.storageId<b.storageId?-1:1);
function bindsBody(first,second,body){
 const token=body?.predictions?.token,current=body?.predictions?.current;
 if(token==null||typeof token!=='object'||!Array.isArray(current)||typeof token.pointers!=='string')return false;
 if(!integer(token.generation)||first.marker?.generation!==token.generation||second.marker?.generation!==token.generation)return false;
 return digestOf(current)===token.pointers&&digestOf(currentOf(first))===token.pointers&&digestOf(currentOf(second))===token.pointers;
}
// The prediction domain's verdict per pointer, through the caller's `verdictOf` ({pointer, fingerprint, genres, profile} -> {outcome: current|compatible|stale}); anything else, a missing
// fingerprint row or a throw is `unknown`. One incompatible pointer is incompatible; compatible needs every pointer judged compatible.
async function domainCompatibility(c,reader){
 if(typeof reader.verdictOf!=='function'||!c.pointers.length)return 'unknown';
 const profile={version:c.profile.version,profileHash:c.profile.profileHash,lineage:c.profile.lineage??[]},genres=Array.isArray(c.genres)?c.genres:null;
 let all=true;
 for(const pointer of c.pointers){
  const fingerprint=c.fingerprints.find(f=>f.film_id===pointer.film_id);
  if(!fingerprint){all=false;continue;}
  let outcome;
  try{outcome=(await reader.verdictOf({pointer,fingerprint,genres,profile}))?.outcome;}catch{outcome=undefined;}
  if(outcome==='stale')return 'incompatible';
  if(outcome!=='current'&&outcome!=='compatible')all=false;
 }
 return all?'compatible':'unknown';
}

// Finishes the evidence AFTER every section read: the final capture (statement B) is the expected context, the observation of statement A is judged against it by
// checkPredictionEvidence inside deriveReadiness. Returns {evidence, context} or null. Gives back whatever it reserved and did not spend.
export async function finishPredictionEvidence(env,resolution,body,budget,begun,reader){
 if(!begun)return null;
 try{
  if(body?.predictions==null||body.predictions.status==='unavailable')return null;
  const {fence,ids,first}=begun;
  const second=await capture(env,resolution,ids,budget,fence,reader);
  const profileA=profileOf(first),profileB=profileOf(second);
  const available=markerState(first.marker);
  const markerB=markerState(second.marker);
  // The facts of the observation: from A only. An unreadable or unproved profile, or an authority generation and pointers that are not the body's own, are never certified.
  if(!profileA||!profileB||!bindsBody(first,second,body))return null;
  const facts=predictionFacts({available:available.available&&markerB.available,reason:available.reason||markerB.reason,storageIds:ids,fingerprints:first.fingerprints,pointers:first.pointers,coverage:body.predictions.coverage});
  if(facts.compatibility!=='incompatible')facts.compatibility=facts.fingerprint.status==='present'?await domainCompatibility({...first,profile:{...first.profile}},reader):'unknown';
  const evidence=predictionEvidence(facts,{
   filmId:body.identity.filmId,identityToken:resolution.token,predictionToken:body.predictions.token,coverageToken:body.predictions.coverage?.token,
   profile:profileA,registryToken:first.registryToken,fingerprintToken:readSetToken(first,ids),examinedStorageIds:ids,
  });
  const context={identityToken:resolution.token,profile:profileB,registryToken:second.registryToken,fingerprintToken:readSetToken(second,ids),examinedStorageIds:ids};
  return {evidence,context};
 }catch{return null;}
 finally{begun.fence.release();}
}
