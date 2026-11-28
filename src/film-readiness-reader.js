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
// Cost: exactly PREDICTION_EVIDENCE_STATEMENTS of the shared request budget (no new cap); the derivation itself adds none.
import {sha256Hex} from './sha256-sync.js';
import {database} from './film-person-authority.js';
import {countedDatabase,fenceOf,row,digestOf} from './film-aggregate.js';
import {authorizedStorageIds,predictionEvidence} from './film-readiness.js';
import {predictionFacts} from './domain/film-dimension-parity.js';

export const PREDICTION_EVIDENCE_STATEMENTS=2;
// One statement, one snapshot. Every table is read by its primary key or the partial unique index of the active profile (prediction_profile_active); the id lists are bound
// as JSON so the statement shape never changes with the number of aliases, and each list is capped at its own length + 1 (a primary key cannot return more rows than ids).
export const PREDICTION_EVIDENCE_SQL=
 "SELECT (SELECT json_object('mode',mode,'writes',writes,'generation',generation,'profileGeneration',profile_generation) FROM prediction_domain_authority WHERE id=1) AS marker,"
 +"(SELECT json_object('version',version,'profileHash',profile_hash,'lineage',json(CASE WHEN json_valid(lineage_json) THEN lineage_json END),'lineageValid',CASE WHEN lineage_json IS NULL OR json_valid(lineage_json) THEN 1 ELSE 0 END) FROM prediction_profile WHERE active=1) AS profile,"
 +"(SELECT json_group_array(json_array(film_id,fingerprint_hash,schema_version,prompt_version,invalidated_at,content_sha256,json(CASE WHEN json_valid(features_json) THEN features_json END))) FROM (SELECT film_id,fingerprint_hash,schema_version,prompt_version,invalidated_at,content_sha256,features_json FROM prediction_fingerprint WHERE film_id IN (SELECT value FROM json_each(?)) ORDER BY film_id LIMIT ?)) AS fingerprints,"
 +"(SELECT json_group_array(json_array(film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,r2_key,content_sha256)) FROM (SELECT film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,r2_key,content_sha256 FROM prediction_pointer WHERE film_id IN (SELECT value FROM json_each(?)) ORDER BY film_id LIMIT ?)) AS pointers,"
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
 const pointers=list(x.pointers).map(r=>({film_id:String(r[0]),taste_profile_version:r[1],taste_profile_hash:r[2],fingerprint_hash:r[3],fingerprint_schema_version:r[4],prediction_prompt_version:r[5],r2_key:r[6],content_sha256:r[7]}));
 if(marker===undefined||profile===undefined||genres===undefined)throw new Error('malformed');
 return {marker,profile,fingerprints,pointers,genres:Array.isArray(genres)?genres:null,registryToken};
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
// The active profile as the observation and the context state it: version, hash and the marker's profile generation. No active profile, or a profile whose lineage
// cannot be read, is no proof (null: the evidence is then not certifying, so P3/P5/P6 stay unknown).
function profileOf(c){
 const p=c.profile;
 if(p==null||typeof p!=='object'||!integer(p.version)||typeof p.profileHash!=='string'||!p.profileHash||p.lineageValid!==1||!integer(c.marker?.profileGeneration))return null;
 return {version:p.version,hash:p.profileHash,generation:c.marker.profileGeneration};
}
// The fingerprint read-set token: the examined ids, every fingerprint row (including its content digest) and every pointer row. An empty set is a statement too (the absence
// token), so a fingerprint or pointer that appears or disappears between the two captures moves it.
const readSetToken=(c,ids)=>digestOf({ids,fingerprints:c.fingerprints.map(f=>[f.film_id,f.fingerprint_hash,f.schema_version,f.prompt_version,f.invalidated_at,f.content_sha256,sha256Hex(JSON.stringify(f.features??null))]),pointers:c.pointers.map(p=>[p.film_id,p.taste_profile_version,p.taste_profile_hash,p.fingerprint_hash,p.fingerprint_schema_version,p.prediction_prompt_version,p.r2_key,p.content_sha256])});

// Starts the evidence: reserves its statements, then captures the observation. `null` when it cannot (no authorized alias, no budget, a failed or malformed read): the
// caller then derives readiness without evidence, which never proves a prediction fact.
export async function beginPredictionEvidence(env,resolution,budget,reader){
 try{
  const ids=authorizedStorageIds(resolution);
  if(!ids.length||typeof reader?.registryToken!=='function')return null;
  const fence=fenceOf(budget,PREDICTION_EVIDENCE_STATEMENTS);
  if(!fence)return null;
  try{return {fence,ids,first:await capture(env,resolution,ids,budget,fence,reader)};}
  catch{fence.release();return null;}
 }catch{return null;}
}

// The pointers the capture read must be the pointers of the aggregate body judged (same storage ids, same content digests): a pointer that moved between the aggregate's own
// read and this capture is not evidence about that body.
function pointersAgree(pointers,body){
 const current=body?.predictions?.current;
 if(!Array.isArray(current))return false;
 const key=(id,sha)=>String(id)+'\u0000'+String(sha);
 const a=pointers.map(p=>key(p.film_id,p.content_sha256)).sort(),b=current.map(c=>key(c.storageId,c.contentSha256)).sort();
 return a.length===b.length&&a.every((value,index)=>value===b[index]);
}
// The prediction domain's verdict per pointer, through the caller's `verdictOf` ({pointer, fingerprint, genres, profile} -> {outcome: current|compatible|stale}); anything else, a missing
// fingerprint row or a throw is `unknown`. One incompatible pointer is incompatible; compatible needs every pointer judged compatible.
async function domainCompatibility(c,reader){
 if(typeof reader.verdictOf!=='function'||!c.pointers.length)return 'unknown';
 const profile={version:c.profile.version,profileHash:c.profile.profileHash,lineage:c.profile.lineage??[]};
 let all=true;
 for(const pointer of c.pointers){
  const fingerprint=c.fingerprints.find(f=>f.film_id===pointer.film_id);
  if(!fingerprint){all=false;continue;}
  let outcome;
  try{outcome=(await reader.verdictOf({pointer,fingerprint,genres:c.genres,profile}))?.outcome;}catch{outcome=undefined;}
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
  // The facts of the observation: from A only. An unreadable or unproved profile, a marker that is not d1/open, or pointers that are not the body's own are never certified.
  if(!profileA||!profileB||!pointersAgree(first.pointers,body))return null;
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
