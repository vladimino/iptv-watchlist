// AIR-477 (ADR 0165, Accepted). The owner-confirmed, scoped prediction recovery intent: the D1 store of migration 0024 and the pure
// rules around it. An intent names ONE stored prediction version of ONE film (and, in mode fingerprint_and_prediction, ONE stored
// fingerprint version) that the freshness rule must not accept as current. Nothing else changes: the ordinary queue rebuild admits the
// film because the ordinary freshness rule now calls it outstanding; retry records, the hot/cold order, the runner lease and the
// validated batch v2 runner stay exactly as they are. The first new version the runner commits no longer matches the denied token, so
// the intent's effect ends by itself (satisfied) and can never re-score the film twice.
//
// Readers: `readOverlay` (the freshness rule, once per request) and `readFilmRows` (the owner preview) only SELECT. An absent table is
// "not installed": the overlay is empty and every write refuses `recovery_schema_not_ready`.
// Writers: `confirmCohort` and `cancelCohort`, one fenced D1 batch each, called only by the owner-only admin route after its own
// server-side preview. Each film's insert is conditional on the D1 pointer (and fingerprint) still holding the previewed tokens; the
// batch fence (`prediction_domain_cas.ok=changes()`) fails the whole batch when any of them moved.

export const RECOVERY_VERSION=1;
export const RECOVERY_MODES=['prediction_only','fingerprint_and_prediction'];
export const RECOVERY_LIMITS=Object.freeze({maxFilms:50,maxActive:300,defaultTtlHours:72,minTtlHours:1,maxTtlHours:168});
export const RECOVERY_OUTCOMES=['eligible','unchanged','blocked','conflict'];
export const RECOVERY_REASONS=[
 'eligible','not_current','prediction_absent','not_admitted','identity_absent','identity_retired','identity_conflict','identity_mismatch',
 'identity_unavailable','retry_exhausted','token_unbindable','pointer_mismatch','pointer_absent','active_intent','film_unreadable','profile_missing',
];
const FILM_ID=/^[A-Za-z0-9_-]{1,80}$/;
const IDEMPOTENCY_KEY=/^[A-Za-z0-9_-]{16,80}$/;
const COHORT_ID=/^pr_[0-9a-f]{24}$/;
const HEX64=/^[0-9a-f]{64}$/;
const TABLES=['prediction_recovery_revision','prediction_recovery_cohort','prediction_recovery_intent'];
const FENCE_SQL='UPDATE prediction_domain_cas SET ok=changes() WHERE id=1';
// The token of a stored prediction, in JS and in SQL over prediction_pointer.display_json (the stored body without its storage fields).
const PREDICTION_TOKEN_SQL="json_extract(display_json,'$.generatedAt')||'|'||json_extract(display_json,'$.fingerprintHash')||'|'||ifnull(json_extract(display_json,'$.tasteProfileHash'),'')";
const FINGERPRINT_TOKEN_SQL="fingerprint_hash||'|'||ifnull(generated_at,'')";
// The prediction domain is D1-authoritative. `writes` is deliberately not read: it is the r2-mode gate, and mode d1 normally carries
// `held` after the activation (ADR 0078; the AIR-478 preflight of 18 Nov 2026 read d1/held). Every D1 writer checks mode d1 and its CAS.
const OPEN_SQL="EXISTS (SELECT 1 FROM prediction_domain_authority WHERE id=1 AND mode='d1')";

export function failed(code,cause){const error=new Error(code);error.code=code;if(cause)error.cause=cause;return error;}
function database(env){return env&&typeof env.prepare==='function'?env:env?.DB??null;}
const missingTable=error=>/no such table/i.test(String(error?.message||error))||/no such table/i.test(String(error?.cause?.message||''));
async function many(db,sql,params=[]){return (await db.prepare(sql).bind(...params).all()).results||[];}
async function one(db,sql,params=[]){return (await db.prepare(sql).bind(...params).first())??null;}

function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
}
export async function digestOf(value){
 const bytes=new TextEncoder().encode(JSON.stringify(canonical(value)));
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

// Pure. The identity of one stored prediction version: its generation time, the fingerprint it was scored on (a content hash that
// includes the film id) and the profile hash. Null when the version cannot be named exactly, which makes the film unbindable.
export function predictionToken(prediction){
 if(!prediction||typeof prediction!=='object')return null;
 const {generatedAt,fingerprintHash,tasteProfileHash}=prediction;
 if(typeof generatedAt!=='string'||!generatedAt||typeof fingerprintHash!=='string'||!fingerprintHash)return null;
 if(tasteProfileHash!=null&&typeof tasteProfileHash!=='string')return null;
 return generatedAt+'|'+fingerprintHash+'|'+(tasteProfileHash??'');
}
export function fingerprintToken(fingerprint){
 if(!fingerprint||typeof fingerprint!=='object')return null;
 const {fingerprintHash,generatedAt}=fingerprint;
 if(typeof fingerprintHash!=='string'||!fingerprintHash)return null;
 if(generatedAt!=null&&typeof generatedAt!=='string')return null;
 return fingerprintHash+'|'+(generatedAt??'');
}

// Pure. The owner's request: a frozen, bounded, duplicate-free allowlist of stored film ids, one mode and a TTL in whole hours.
export function parseRecoveryRequest(input){
 const raw=input?.films;
 const list=Array.isArray(raw)?raw:typeof raw==='string'&&raw.trim()?raw.split(','):null;
 if(!list||!list.length)return {error:'films_required'};
 if(list.length>RECOVERY_LIMITS.maxFilms)return {error:'too_many_films',limit:RECOVERY_LIMITS.maxFilms};
 const films=list.map(value=>typeof value==='string'?value.trim():value);
 if(films.some(id=>typeof id!=='string'||!FILM_ID.test(id)))return {error:'invalid_film'};
 if(new Set(films).size!==films.length)return {error:'duplicate_film'};
 const mode=input?.mode??'prediction_only';
 if(!RECOVERY_MODES.includes(mode))return {error:'invalid_mode'};
 const ttlRaw=input?.ttlHours??RECOVERY_LIMITS.defaultTtlHours,ttlHours=typeof ttlRaw==='string'&&/^\d{1,3}$/.test(ttlRaw)?Number(ttlRaw):ttlRaw;
 if(!Number.isInteger(ttlHours)||ttlHours<RECOVERY_LIMITS.minTtlHours||ttlHours>RECOVERY_LIMITS.maxTtlHours)return {error:'invalid_ttl'};
 return {films:[...films].sort((a,b)=>a.localeCompare(b,'en')),mode,ttlHours};
}
export const validIdempotencyKey=key=>typeof key==='string'&&IDEMPOTENCY_KEY.test(key);
export const validCohortId=id=>typeof id==='string'&&COHORT_ID.test(id);
export const validScopeHash=hash=>typeof hash==='string'&&HEX64.test(hash);

// Pure. One film's preview outcome from what the route read. `film` = {filmId, admitted, identity:{state, filmId, tmdb, lid}|{error},
// state:{status, prediction, fingerprint}, current (the ordinary rule's verdict, without any intent), d1:{prediction, fingerprint}
// (the tokens D1 holds, or null), retryExhausted, activeIntent:{predictionToken, expiresAt}|null}. The order of the checks is the
// order of the reasons: what cannot be read, then what is not this capability's to change, then what conflicts, then eligibility.
export function classifyRecoveryFilm(film,mode,nowMs){
 const out=(outcome,reason,extra={})=>({filmId:film.filmId,outcome,reason,plan:null,...extra});
 if(film.profile===false)return out('blocked','profile_missing');
 if(film.state?.status!=='recorded')return out('blocked','film_unreadable');
 if(!film.admitted)return out('blocked','not_admitted');
 const identity=film.identity||{};
 if(identity.error)return out('blocked','identity_unavailable');
 if(identity.state==='absent')return out('blocked','identity_absent');
 if(identity.state==='retired')return out('blocked','identity_retired');
 if(identity.state==='conflict')return out('conflict','identity_conflict');
 if(identity.state!=='ok'||typeof identity.filmId!=='string'||!identity.filmId)return out('blocked','identity_unavailable');
 const facts={canonicalFilmId:identity.filmId,tmdb:identity.tmdb??null,lid:identity.lid??null};
 // A typed TMDB id spelled in the stored id must be the Film's one trusted TMDB claim; a Letterboxd id must be its trusted lid.
 const typed=/^tmdb_(\d+)$/.exec(film.filmId);
 if(typed?typed[1]!==facts.tmdb:facts.lid!==film.filmId)return out('conflict','identity_mismatch',facts);
 if(film.retryExhausted)return out('blocked','retry_exhausted',facts);
 const prediction=film.state.prediction;
 if(!prediction)return out('unchanged','prediction_absent',facts);
 if(film.current!==true)return out('unchanged','not_current',facts);
 const pToken=predictionToken(prediction),fToken=mode==='fingerprint_and_prediction'?fingerprintToken(film.state.fingerprint):null;
 if(!pToken||(mode==='fingerprint_and_prediction'&&film.state.fingerprint&&!fToken))return out('blocked','token_unbindable',facts);
 if(!film.d1||film.d1.prediction==null)return out('conflict','pointer_absent',facts);
 if(film.d1.prediction!==pToken||(fToken&&film.d1.fingerprint!==fToken))return out('conflict','pointer_mismatch',facts);
 const active=film.activeIntent;
 if(active&&Date.parse(active.expiresAt)>nowMs&&active.predictionToken===pToken)return out('conflict','active_intent',facts);
 return {filmId:film.filmId,outcome:'eligible',reason:'eligible',plan:mode==='fingerprint_and_prediction'?'fingerprint_and_prediction':'prediction_only',...facts,predictionToken:pToken,fingerprintToken:fToken};
}

// Pure. The scope the owner confirms: every requested film with its outcome, the tokens an eligible film will deny, its queue lane and
// retry record (attempts, retryAt, exhausted), the mode, the TTL, the recovery revision, the prediction authority mode and the
// Film/Person state/generation the preview read. Any change to one of them is another scope (`stale_scope`). Deliberately NOT in it:
// the queue generation, the prediction authority generation and the runner lease/run/epoch. Those move on every runner step and
// heartbeat, confirming during a live v2 run is intended, and the intent changes none of them (ADR 0165).
export async function recoveryScopeHash({mode,ttlHours,revision,authority,filmPerson=null,films}){
 return digestOf({version:RECOVERY_VERSION,mode,ttlHours,revision,authority:{mode:authority?.mode??null},filmPerson:{state:filmPerson?.state??null,generation:filmPerson?.generation??null},
  films:films.map(f=>({filmId:f.filmId,outcome:f.outcome,reason:f.reason,lane:f.lane??null,retry:f.retry?{attempts:f.retry.attempts??null,retryAt:f.retry.retryAt??null,exhausted:!!f.retry.exhausted}:null,canonicalFilmId:f.canonicalFilmId??null,tmdb:f.tmdb??null,lid:f.lid??null,predictionToken:f.predictionToken??null,fingerprintToken:f.fingerprintToken??null}))});
}
// The owner's normalized request (a parsed recovery request: sorted films, mode, TTL). A replay of an idempotency key must repeat it
// exactly, not only the old scope hash (review of PR #734).
export async function recoveryRequestDigest({films,mode,ttlHours}){return digestOf({version:RECOVERY_VERSION,films:[...films].sort((a,b)=>a.localeCompare(b,'en')),mode,ttlHours});}
export async function cohortIdFor(idempotencyKey){return 'pr_'+(await digestOf({cohort:idempotencyKey})).slice(0,24);}

// The tables are installed when all three exist; none of them is "not installed"; some of them fail closed.
async function readInstalled(db){
 const names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+")")).map(row=>row.name);
 if(!names.length)return false;
 if(names.length!==TABLES.length)throw failed('recovery_schema_partial');
 return true;
}

// The intent read joins its cohort, so the one read batch touches all three 0024 tables: a missing table of any of them fails the
// statement and is then classified by readInstalled (none: dormant; some: recovery_schema_partial). An intent counts only while its
// cohort is active too.
const OVERLAY_SQL="SELECT i.film_id AS filmId, i.mode AS mode, i.prediction_token AS predictionToken, i.fingerprint_token AS fingerprintToken, c.created_at AS confirmedAt FROM prediction_recovery_intent i JOIN prediction_recovery_cohort c ON c.cohort_id=i.cohort_id AND c.state='active' WHERE i.state='active' AND i.expires_at>? AND EXISTS (SELECT 1 FROM prediction_domain_authority WHERE id=1 AND mode='d1') LIMIT ?";
const validOverlayRow=row=>typeof row?.filmId==='string'&&FILM_ID.test(row.filmId)&&RECOVERY_MODES.includes(row.mode)&&typeof row.predictionToken==='string'&&row.predictionToken.length>=3&&(row.fingerprintToken==null||typeof row.fingerprintToken==='string'&&row.fingerprintToken.length>=2)&&(row.confirmedAt==null||typeof row.confirmedAt==='string');
const EMPTY_OVERLAY=Object.freeze({ready:false,revision:null,size:0,deniesPrediction:()=>false,deniesFingerprint:()=>false,modeOf:()=>null,activeIds:()=>[],confirmedAtOf:()=>null});
export const emptyOverlay=()=>EMPTY_OVERLAY;
// The active, unexpired intents and the revision, in one read. Only while the prediction domain marker is d1: the tokens name D1 pointers.
// `deniesPrediction(filmId, prediction)` is true only for that film's exact denied version; an id-less call never matches.
// Only migration 0024 NOT installed (none of its tables) is the empty overlay. A partial table set, an unreadable store or a malformed
// answer throws `recovery_schema_partial` / `recovery_unavailable`: an installed store must never read as "no intents", because a
// rebuild on that answer would treat a recovery film as current and drop its retry record (ADR 0165, review of PR #734).
export async function readOverlay(env,nowMs=Date.now()){
 const db=database(env);
 if(!db||typeof db.prepare!=='function')return EMPTY_OVERLAY;
 const now=new Date(nowMs).toISOString();
 let revision,rows;
 try{
  const read=[db.prepare('SELECT revision FROM prediction_recovery_revision WHERE id=1').bind(),db.prepare(OVERLAY_SQL).bind(now,RECOVERY_LIMITS.maxActive+1)];
  if(typeof db.batch==='function'){const results=await db.batch(read);revision=results[0]?.results?.[0]?.revision;rows=results[1]?.results||[];}
  else{revision=(await read[0].first())?.revision;rows=(await read[1].all()).results||[];}
 }catch(error){
  if(missingTable(error)){
   let installed;
   try{installed=await readInstalled(db);}catch(inner){if(inner?.code)throw inner;throw failed('recovery_unavailable',inner);}
   if(!installed)return EMPTY_OVERLAY;
  }
  throw failed('recovery_unavailable',error);
 }
 if(revision==null||!Number.isInteger(Number(revision)))throw failed('recovery_unavailable');
 if(rows.length>RECOVERY_LIMITS.maxActive||!rows.every(validOverlayRow))throw failed('recovery_unavailable');
 const predictions=new Map(),fingerprints=new Map(),modes=new Map(),confirmed=new Map();
 for(const row of rows){predictions.set(row.filmId,row.predictionToken);modes.set(row.filmId,row.mode);confirmed.set(row.filmId,row.confirmedAt??null);if(row.fingerprintToken)fingerprints.set(row.filmId,row.fingerprintToken);}
 return Object.freeze({ready:true,revision:Number(revision),size:rows.length,
  deniesPrediction:(filmId,prediction)=>typeof filmId==='string'&&predictions.has(filmId)&&predictions.get(filmId)===predictionToken(prediction),
  deniesFingerprint:(filmId,fingerprint)=>typeof filmId==='string'&&fingerprints.has(filmId)&&fingerprints.get(filmId)===fingerprintToken(fingerprint),
  modeOf:filmId=>modes.get(filmId)??null,
  // The film ids with an active, unexpired intent, and the time the owner confirmed the cohort of each (the recovery slots of a batch order by it).
  activeIds:()=>[...modes.keys()],confirmedAtOf:filmId=>confirmed.get(filmId)??null});
}

// ADR 0201. The stored ids of every film an owner cohort ever named (active, settled or cancelled): such a film keeps its stored key in the queue
// after the intent ends, so a satisfied or expired intent never turns it back into a second `tmdb_<n>` film. Bounded and explicit: over the cap, or a
// store that cannot be read, throws; an absent migration (the dormant store) is none.
export const RECOVERED_IDS_LIMIT=1000;
export async function readRecoveredIds(env){
 const db=database(env);
 if(!db||typeof db.prepare!=='function')return [];
 let rows;
 try{rows=(await db.prepare('SELECT DISTINCT film_id AS filmId FROM prediction_recovery_intent ORDER BY film_id LIMIT ?').bind(RECOVERED_IDS_LIMIT+1).all()).results||[];}
 catch(error){
  let installed;
  try{installed=await readInstalled(db);}catch(inner){throw inner?.code?inner:failed('recovery_unavailable',inner);}
  if(!installed)return [];
  throw failed('recovery_unavailable',error);
 }
 if(rows.length>RECOVERED_IDS_LIMIT||!rows.every(row=>typeof row?.filmId==='string'&&FILM_ID.test(row.filmId)))throw failed('recovery_unavailable');
 return rows.map(row=>row.filmId);
}

// Read only. For the requested ids: the D1 pointer and fingerprint tokens, each film's active intent and the recovery revision.
// `installed:false` when migration 0024 is not applied.
export async function readFilmRows(env,filmIds){
 const db=database(env);
 if(!db)throw failed('recovery_unavailable');
 let installed;
 try{installed=await readInstalled(db);}catch(error){if(error?.code)throw error;throw failed('recovery_unavailable',error);}
 const ids=JSON.stringify(filmIds);
 try{
  const [pointers,fingerprints]=await Promise.all([
   many(db,`SELECT film_id AS filmId, ${PREDICTION_TOKEN_SQL} AS token FROM prediction_pointer WHERE film_id IN (SELECT value FROM json_each(?))`,[ids]),
   many(db,`SELECT film_id AS filmId, ${FINGERPRINT_TOKEN_SQL} AS token FROM prediction_fingerprint WHERE film_id IN (SELECT value FROM json_each(?))`,[ids]),
  ]);
  const out={installed,revision:null,films:new Map(filmIds.map(id=>[id,{prediction:null,fingerprint:null,activeIntent:null}]))};
  for(const row of pointers)out.films.get(row.filmId).prediction=row.token??null;
  for(const row of fingerprints)out.films.get(row.filmId).fingerprint=row.token??null;
  if(!installed)return out;
  const [revision,active]=await Promise.all([
   one(db,'SELECT revision FROM prediction_recovery_revision WHERE id=1'),
   many(db,"SELECT cohort_id AS cohortId, film_id AS filmId, prediction_token AS predictionToken, expires_at AS expiresAt FROM prediction_recovery_intent WHERE state='active' AND film_id IN (SELECT value FROM json_each(?))",[ids]),
  ]);
  out.revision=Number(revision?.revision);
  if(!Number.isInteger(out.revision))throw failed('recovery_unavailable');
  for(const row of active)out.films.get(row.filmId).activeIntent={cohortId:row.cohortId,predictionToken:row.predictionToken,expiresAt:row.expiresAt};
  return out;
 }catch(error){if(error?.code)throw error;throw failed('recovery_unavailable',error);}
}

function cohortView(row,intents,nowMs,tokens){
 return {
  cohortId:row.cohort_id,idempotencyKey:row.idempotency_key,scopeHash:row.scope_hash,requestDigest:row.request_digest,mode:row.mode,filmCount:row.film_count,state:row.state,
  createdAt:row.created_at,expiresAt:row.expires_at,cancelledAt:row.cancelled_at??null,
  films:intents.map(intent=>{
   const now=tokens?.get(intent.film_id)??null;
   const status=intent.state!=='active'?intent.state:Date.parse(intent.expires_at)<=nowMs?'expired':now&&now!==intent.prediction_token?'satisfied':'pending';
   return {filmId:intent.film_id,canonicalFilmId:intent.canonical_film_id,tmdb:intent.tmdb,lid:intent.lid,status,closedAt:intent.closed_at??null};
  }),
 };
}
// Read only. One cohort (by id or by idempotency key) with each film's derived status: pending (the denied version is still the
// pointer), satisfied (a new version replaced it), expired, settled (superseded by a later intent) or cancelled.
export async function readCohort(env,{cohortId=null,idempotencyKey=null},nowMs=Date.now()){
 const db=database(env);
 if(!db)throw failed('recovery_unavailable');
 try{
  if(!await readInstalled(db))return {installed:false,cohort:null};
  const row=cohortId?await one(db,'SELECT * FROM prediction_recovery_cohort WHERE cohort_id=?',[cohortId]):await one(db,'SELECT * FROM prediction_recovery_cohort WHERE idempotency_key=?',[idempotencyKey]);
  if(!row)return {installed:true,cohort:null};
  const intents=await many(db,'SELECT * FROM prediction_recovery_intent WHERE cohort_id=? ORDER BY film_id',[row.cohort_id]);
  const pointers=await many(db,`SELECT film_id AS filmId, ${PREDICTION_TOKEN_SQL} AS token FROM prediction_pointer WHERE film_id IN (SELECT value FROM json_each(?))`,[JSON.stringify(intents.map(i=>i.film_id))]);
  return {installed:true,cohort:cohortView(row,intents,nowMs,new Map(pointers.map(p=>[p.filmId,p.token])))};
 }catch(error){if(error?.code)throw error;throw failed('recovery_unavailable',error);}
}

function rethrow(error){
 if(error?.code)throw error;
 const message=String(error?.message||error)+' '+String(error?.cause?.message||'');
 if(/prediction_recovery_not_open/.test(message))throw failed('recovery_not_open',error);
 if(missingTable(error))throw failed('recovery_schema_not_ready',error);
 if(/CHECK constraint failed|UNIQUE constraint failed|prediction_recovery_/i.test(message))throw failed('recovery_cas',error);
 throw failed('recovery_unavailable',error);
}
async function runBatch(db,statements){
 if(typeof db?.batch!=='function')throw failed('recovery_unavailable');
 let prepared;
 try{prepared=statements.map(([sql,params])=>db.prepare(sql).bind(...params));}catch(error){rethrow(error);}
 try{await db.batch(prepared);}catch(error){rethrow(error);}
}

// The identity decision of the preview, asserted again inside the confirmation batch (review of PR #734): the Film/Person marker is still
// d1/open at the previewed generation, and the canonical Film still holds exactly the frozen trusted claim the bridge resolved: the stored
// id's claim is the Film's own trusted, non-conflicting claim, no other row claims the frozen TMDB id or Letterboxd id, the Film has no
// untrusted, conflicting or second claim of either scheme, it is not redirected (retired), and its TMDB / Letterboxd values are the frozen
// ones. Any change between the server's last preview and the batch sets `prediction_domain_cas.ok` to 0 and fails the whole batch.
const IDENTITY_GUARD_SQL="UPDATE prediction_domain_cas SET ok=CASE WHEN "+[
 "EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)",
 "EXISTS (SELECT 1 FROM film_external_id WHERE scheme=? AND value=? AND film_id=? AND trusted=1 AND conflicting=0)",
 "NOT EXISTS (SELECT 1 FROM film_external_id WHERE ((scheme='tmdb' AND value=?) OR (scheme='letterboxd' AND value=?)) AND NOT (film_id=? AND trusted=1 AND conflicting=0))",
 "NOT EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme IN ('tmdb','letterboxd') AND NOT (trusted=1 AND conflicting=0))",
 "(SELECT COUNT(*) FROM film_external_id WHERE film_id=? AND scheme='tmdb')<=1",
 "(SELECT COUNT(*) FROM film_external_id WHERE film_id=? AND scheme='letterboxd')<=1",
 "(SELECT value FROM film_external_id WHERE film_id=? AND scheme='tmdb') IS ?",
 "(? IS NULL OR (SELECT value FROM film_external_id WHERE film_id=? AND scheme='letterboxd') = ?)",
 "NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)",
].join(' AND ')+" THEN 1 ELSE 0 END WHERE id=1";
function identityGuard(film,generation){
 const typed=/^tmdb_(\d+)$/.exec(film.filmId),scheme=typed?'tmdb':'letterboxd',value=typed?typed[1]:film.filmId,owner=film.canonicalFilmId;
 return [IDENTITY_GUARD_SQL,[generation,scheme,value,owner,film.tmdb??'',film.lid??'',owner,owner,owner,owner,owner,film.tmdb,film.lid,owner,film.lid,owner]];
}

// The one write of a confirmation. `plan` = {cohortId, idempotencyKey, scopeHash, mode, ttlHours, revision, films:[eligible outcomes]}.
// Atomic: the revision moves forward from the previewed value, the cohort row is born active, and each film's intent is inserted only
// while D1 still holds the previewed pointer (and fingerprint) token; a film's older active intent that is expired or already
// satisfied is settled in the same batch, and the frozen canonical identity and Film/Person marker are asserted again (IDENTITY_GUARD_SQL).
// Any moved token, a changed identity or marker, a concurrent confirmation, a closed marker or the global active cap fails
// the whole batch (`recovery_cas` / `recovery_not_open`); nothing is partially written.
export async function confirmCohort(env,plan,nowMs=Date.now()){
 const db=database(env);
 if(!db)throw failed('recovery_unavailable');
 if(!plan.films.length||plan.films.length>RECOVERY_LIMITS.maxFilms)throw failed('recovery_scope_empty');
 if(!Number.isInteger(plan.filmPersonGeneration)||!HEX64.test(plan.requestDigest||''))throw failed('recovery_scope_invalid');
 const now=new Date(nowMs).toISOString(),expires=new Date(nowMs+plan.ttlHours*3600000).toISOString();
 const statements=[
  ['UPDATE prediction_recovery_revision SET revision=revision+1 WHERE id=1 AND revision=? AND '+OPEN_SQL,[plan.revision]],
  [FENCE_SQL,[]],
  ['INSERT INTO prediction_recovery_cohort (cohort_id,idempotency_key,scope_hash,request_digest,mode,film_count,state,created_at,expires_at) VALUES (?,?,?,?,?,?,\'active\',?,?)',[plan.cohortId,plan.idempotencyKey,plan.scopeHash,plan.requestDigest,plan.mode,plan.films.length,now,expires]],
 ];
 for(const entry of plan.films){
  // Every bound value is a string or null: an absent field is never bound as undefined.
  const film={filmId:entry.filmId,canonicalFilmId:entry.canonicalFilmId,tmdb:entry.tmdb??null,lid:entry.lid??null,predictionToken:entry.predictionToken,fingerprintToken:entry.fingerprintToken??null};
  if(typeof film.filmId!=='string'||typeof film.canonicalFilmId!=='string'||typeof film.predictionToken!=='string')throw failed('recovery_scope_invalid');
  statements.push(
   ["UPDATE prediction_recovery_intent SET state='settled', closed_at=? WHERE film_id=? AND state='active' AND (expires_at<=? OR prediction_token<>?)",[now,film.filmId,now,film.predictionToken]],
   ['INSERT INTO prediction_recovery_intent (cohort_id,film_id,canonical_film_id,tmdb,lid,mode,prediction_token,fingerprint_token,state,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,\'active\',?,? WHERE EXISTS (SELECT 1 FROM prediction_pointer WHERE film_id=? AND '+PREDICTION_TOKEN_SQL+'=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM prediction_fingerprint WHERE film_id=? AND '+FINGERPRINT_TOKEN_SQL+'=?))',
    [plan.cohortId,film.filmId,film.canonicalFilmId,film.tmdb,film.lid,plan.mode,film.predictionToken,film.fingerprintToken,now,expires,film.filmId,film.predictionToken,film.fingerprintToken,film.filmId,film.fingerprintToken]],
   [FENCE_SQL,[]],
   identityGuard(film,plan.filmPersonGeneration),
  );
 }
 statements.push(["UPDATE prediction_domain_cas SET ok=CASE WHEN (SELECT COUNT(*) FROM prediction_recovery_intent WHERE state='active' AND expires_at>?)<=? THEN 1 ELSE 0 END WHERE id=1",[now,RECOVERY_LIMITS.maxActive]]);
 await runBatch(db,statements);
 return {cohortId:plan.cohortId,createdAt:now,expiresAt:expires,revision:plan.revision+1};
}

// Cancel what is still active in one cohort. A version the runner already committed stays: cancel only stops a pending intent.
// Atomic, fenced on the revision read just before; an already cancelled cohort is a replay and writes nothing.
export async function cancelCohort(env,cohortId,nowMs=Date.now()){
 const db=database(env);
 if(!db)throw failed('recovery_unavailable');
 let installed,row,revision;
 try{
  installed=await readInstalled(db);
  if(installed){row=await one(db,'SELECT cohort_id,state FROM prediction_recovery_cohort WHERE cohort_id=?',[cohortId]);revision=Number((await one(db,'SELECT revision FROM prediction_recovery_revision WHERE id=1'))?.revision);}
 }catch(error){rethrow(error);}
 if(!installed)throw failed('recovery_schema_not_ready');
 if(!row)throw failed('recovery_cohort_unknown');
 if(row.state==='cancelled')return {status:'already_cancelled',cohortId};
 const now=new Date(nowMs).toISOString();
 await runBatch(db,[
  ['UPDATE prediction_recovery_revision SET revision=revision+1 WHERE id=1 AND revision=? AND '+OPEN_SQL,[revision]],
  [FENCE_SQL,[]],
  ["UPDATE prediction_recovery_intent SET state='cancelled', closed_at=? WHERE cohort_id=? AND state='active'",[now,cohortId]],
  ["UPDATE prediction_recovery_cohort SET state='cancelled', cancelled_at=? WHERE cohort_id=? AND state='active'",[now,cohortId]],
  [FENCE_SQL,[]],
 ]);
 return {status:'cancelled',cohortId,cancelledAt:now,revision:revision+1};
}
