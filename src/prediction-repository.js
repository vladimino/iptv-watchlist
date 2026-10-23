// AIR-72. Local D1 repository for fingerprints, taste profiles, predictions, and ratings.
// The Worker does not import this file. The caller supplies the database and the already produced records.
// Fingerprint, profile, and current-prediction bodies stay in R2. This module stores their pointers.
// It does not generate a fingerprint or a prediction, and it does not change Film identity.

const FINGERPRINT_SCHEMA_VERSION=1;
const PREDICTION_PROMPT_VERSION=1;

export function createPredictionRepository(db){
 return {
  saveProfile:input=>saveProfile(db,input),
  saveFingerprint:input=>saveFingerprint(db,input),
  savePrediction:input=>savePrediction(db,input),
  saveActualRating:input=>saveActualRating(db,input),
  readFilm:id=>readFilm(db,id),
 };
}

async function saveProfile(db,input){
 const row=profileInput(input);
 const existing=await db.get('SELECT version,profile_hash,created_at,r2_key,content_sha256 FROM profile_version WHERE version=?',[row.version]);
 if(existing&&sameProfile(existing,row))return profileView(existing);
 if(existing)throw new Error('Profile version conflicts');
 await db.transaction(async()=>{await db.run('INSERT INTO profile_version (version,profile_hash,created_at,r2_key,content_sha256) VALUES (?,?,?,?,?)',[row.version,row.profileHash,row.createdAt,row.r2Key,row.contentSha256]);});
 return profileView(row);
}

async function saveFingerprint(db,input){
 const row=fingerprintInput(input);
 const existing=await db.get('SELECT film_id,schema_version,fingerprint_hash,generated_at,invalidated_at,r2_key,content_sha256 FROM fingerprint_payload WHERE film_id=?',[row.filmId]);
 if(existing&&sameFingerprint(existing,row))return fingerprintView(existing);
 await db.transaction(async()=>{await db.run('INSERT INTO fingerprint_payload (film_id,schema_version,fingerprint_hash,generated_at,invalidated_at,r2_key,content_sha256) VALUES (?,?,?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET schema_version=excluded.schema_version,fingerprint_hash=excluded.fingerprint_hash,generated_at=excluded.generated_at,invalidated_at=excluded.invalidated_at,r2_key=excluded.r2_key,content_sha256=excluded.content_sha256',[row.filmId,row.schemaVersion,row.fingerprintHash,row.generatedAt,row.invalidatedAt,row.r2Key,row.contentSha256]);});
 return fingerprintView(await db.get('SELECT film_id,schema_version,fingerprint_hash,generated_at,invalidated_at,r2_key,content_sha256 FROM fingerprint_payload WHERE film_id=?',[row.filmId]));
}

async function savePrediction(db,input){
 const row=predictionInput(input);
 const current=await db.get('SELECT film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at FROM prediction_current WHERE film_id=?',[row.filmId]);
 if(current&&samePrediction(current,row))return readFilm(db,row.filmId);
 await db.transaction(async()=>{
  if(current)await db.run('INSERT INTO prediction_history (film_id,replaced_at,predicted_rating,taste_profile_version,fingerprint_hash,payload_json,r2_key,content_sha256,source) VALUES (?,?,?,?,?,?,?,?,?)',[current.film_id,row.updatedAt,current.predicted_rating,current.taste_profile_version,current.fingerprint_hash,JSON.stringify(formerPrediction(current)),required(current.r2_key,'stored prediction r2Key'),required(current.content_sha256,'stored prediction contentSha256'),'replaced']);
  await db.run('INSERT INTO prediction_current (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET taste_profile_version=excluded.taste_profile_version,taste_profile_hash=excluded.taste_profile_hash,fingerprint_hash=excluded.fingerprint_hash,fingerprint_schema_version=excluded.fingerprint_schema_version,prediction_prompt_version=excluded.prediction_prompt_version,predicted_rating=excluded.predicted_rating,r2_key=excluded.r2_key,content_sha256=excluded.content_sha256,updated_at=excluded.updated_at',[row.filmId,row.tasteProfileVersion,row.tasteProfileHash,row.fingerprintHash,row.fingerprintSchemaVersion,row.predictionPromptVersion,row.predictedRating,row.r2Key,row.contentSha256,row.updatedAt]);
 });
 return readFilm(db,row.filmId);
}

async function saveActualRating(db,input){
 const row=ratingInput(input);
 const existing=await db.get('SELECT film_id,rating,source,recorded_at FROM actual_rating WHERE film_id=?',[row.filmId]);
 if(existing&&existing.rating===row.rating&&existing.source===row.source&&existing.recorded_at===row.recordedAt)return ratingView(existing);
 await db.transaction(async()=>{await db.run('INSERT INTO actual_rating (film_id,rating,source,recorded_at) VALUES (?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET rating=excluded.rating,source=excluded.source,recorded_at=excluded.recorded_at',[row.filmId,row.rating,row.source,row.recordedAt]);});
 return ratingView(row);
}

async function readFilm(db,filmId){
 const id=requiredFilm(filmId);
 const [fingerprint,prediction,history,rating,profile]=await Promise.all([
  db.get('SELECT film_id,schema_version,fingerprint_hash,generated_at,invalidated_at,r2_key,content_sha256 FROM fingerprint_payload WHERE film_id=?',[id]),
  db.get('SELECT film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at FROM prediction_current WHERE film_id=?',[id]),
  db.all('SELECT film_id,replaced_at,predicted_rating,taste_profile_version,fingerprint_hash,payload_json,r2_key,content_sha256,source FROM prediction_history WHERE film_id=? ORDER BY replaced_at',[id]),
  db.get('SELECT film_id,rating,source,recorded_at FROM actual_rating WHERE film_id=?',[id]),
  db.get('SELECT version,profile_hash,created_at,r2_key,content_sha256 FROM profile_version ORDER BY version DESC LIMIT 1'),
 ]);
 const fingerprintRecord=fingerprint?fingerprintView(fingerprint):null;
 const predictionRecord=prediction?predictionView(prediction):null;
 const aligned=predictionCurrent(predictionRecord,profile?profileView(profile):null,fingerprintRecord);
 return {filmId:id,fingerprint:fingerprintRecord,profile:profile?profileView(profile):null,prediction:predictionRecord?{...predictionRecord,stale:aligned===false}:null,history:history.map(historyView),actualRating:rating?ratingView(rating):null,view:viewProjection(fingerprintRecord,predictionRecord,rating,aligned),queue:queueProjection(id,fingerprintRecord,aligned)};
}

function viewProjection(fingerprint,prediction,rating,aligned){
 return {fingerprintHash:fingerprint?.fingerprintHash??null,predictedRating:prediction?.predictedRating??null,stale:prediction?aligned===false:null,actualRating:rating?rating.rating:null,predictionR2Key:prediction?.r2Key??null,fingerprintR2Key:fingerprint?.r2Key??null};
}
function queueProjection(filmId,fingerprint,aligned){
 if(aligned)return null;
 return {filmId,requiredWork:fingerprintCurrent(fingerprint)?'prediction_only':'fingerprint_and_prediction'};
}
function fingerprintCurrent(fingerprint){return !!fingerprint&&fingerprint.schemaVersion===FINGERPRINT_SCHEMA_VERSION&&!fingerprint.invalidatedAt;}
function predictionCurrent(prediction,profile,fingerprint){return !!prediction&&!!profile&&fingerprintCurrent(fingerprint)&&prediction.tasteProfileVersion===profile.version&&prediction.tasteProfileHash===profile.profileHash&&prediction.fingerprintHash===fingerprint.fingerprintHash&&prediction.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&prediction.predictionPromptVersion===PREDICTION_PROMPT_VERSION;}

function profileInput(input){return {version:requiredNumber(input?.version,'profile version'),profileHash:required(input?.profileHash,'profileHash'),createdAt:required(input?.createdAt,'createdAt'),r2Key:required(input?.r2Key,'r2Key'),contentSha256:required(input?.contentSha256,'contentSha256')};}
function fingerprintInput(input){return {filmId:requiredFilm(input?.filmId),schemaVersion:requiredNumber(input?.schemaVersion,'schemaVersion'),fingerprintHash:required(input?.fingerprintHash,'fingerprintHash'),generatedAt:input?.generatedAt??null,invalidatedAt:input?.invalidatedAt??null,r2Key:required(input?.r2Key,'r2Key'),contentSha256:required(input?.contentSha256,'contentSha256')};}
function predictionInput(input){return {filmId:requiredFilm(input?.filmId),tasteProfileVersion:requiredNumber(input?.tasteProfileVersion,'tasteProfileVersion'),tasteProfileHash:required(input?.tasteProfileHash,'tasteProfileHash'),fingerprintHash:required(input?.fingerprintHash,'fingerprintHash'),fingerprintSchemaVersion:requiredNumber(input?.fingerprintSchemaVersion,'fingerprintSchemaVersion'),predictionPromptVersion:requiredNumber(input?.predictionPromptVersion,'predictionPromptVersion'),predictedRating:requiredNumber(input?.predictedRating,'predictedRating'),r2Key:required(input?.r2Key,'r2Key'),contentSha256:required(input?.contentSha256,'contentSha256'),updatedAt:required(input?.updatedAt,'updatedAt')};}
function ratingInput(input){return {filmId:requiredFilm(input?.filmId),rating:requiredNumber(input?.rating,'rating'),source:required(input?.source,'source'),recordedAt:required(input?.recordedAt,'recordedAt')};}
function sameProfile(row,input){return row.profile_hash===input.profileHash&&row.r2_key===input.r2Key&&row.content_sha256===input.contentSha256;}
function sameFingerprint(row,input){return row.schema_version===input.schemaVersion&&row.fingerprint_hash===input.fingerprintHash&&row.generated_at===input.generatedAt&&row.invalidated_at===input.invalidatedAt&&row.r2_key===input.r2Key&&row.content_sha256===input.contentSha256;}
function samePrediction(row,input){return row.taste_profile_version===input.tasteProfileVersion&&row.taste_profile_hash===input.tasteProfileHash&&row.fingerprint_hash===input.fingerprintHash&&row.fingerprint_schema_version===input.fingerprintSchemaVersion&&row.prediction_prompt_version===input.predictionPromptVersion&&row.predicted_rating===input.predictedRating&&row.r2_key===input.r2Key&&row.content_sha256===input.contentSha256;}
function formerPrediction(row){return {filmId:row.film_id,tasteProfileVersion:row.taste_profile_version,tasteProfileHash:row.taste_profile_hash,fingerprintHash:row.fingerprint_hash,fingerprintSchemaVersion:row.fingerprint_schema_version,predictionPromptVersion:row.prediction_prompt_version,predictedRating:row.predicted_rating,r2Key:row.r2_key,contentSha256:row.content_sha256,updatedAt:row.updated_at};}
function profileView(row){return {version:row.version,profileHash:row.profileHash??row.profile_hash,createdAt:row.createdAt??row.created_at,r2Key:row.r2Key??row.r2_key,contentSha256:row.contentSha256??row.content_sha256};}
function fingerprintView(row){return {filmId:row.film_id,schemaVersion:row.schema_version,fingerprintHash:row.fingerprint_hash,generatedAt:row.generated_at,invalidatedAt:row.invalidated_at,r2Key:row.r2_key,contentSha256:row.content_sha256};}
function predictionView(row){return {filmId:row.film_id,tasteProfileVersion:row.taste_profile_version,tasteProfileHash:row.taste_profile_hash,fingerprintHash:row.fingerprint_hash,fingerprintSchemaVersion:row.fingerprint_schema_version,predictionPromptVersion:row.prediction_prompt_version,predictedRating:row.predicted_rating,r2Key:row.r2_key,contentSha256:row.content_sha256,updatedAt:row.updated_at};}
function historyView(row){return {filmId:row.film_id,replacedAt:row.replaced_at,predictedRating:row.predicted_rating,tasteProfileVersion:row.taste_profile_version,fingerprintHash:row.fingerprint_hash,payload:JSON.parse(row.payload_json),r2Key:row.r2_key,contentSha256:row.content_sha256,source:row.source};}
function ratingView(row){return {filmId:row.filmId??row.film_id,rating:row.rating,source:row.source,recordedAt:row.recordedAt??row.recorded_at};}

function requiredFilm(value){const id=required(value,'film id');if(!id.startsWith('film:'))throw new Error('Film id must start with film:');return id;}
function required(value,name){if(value==null||value==='')throw new Error(name+' is required');return value;}
function requiredNumber(value,name){if(typeof value!=='number'||!Number.isFinite(value))throw new Error(name+' is required');return value;}
