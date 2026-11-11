// AIR-374 P5 (ADR 0099, ADR 0110; owner decision 2 of 11 Nov 2026, https://trello.com/c/ha7ais3w): the bounded, idempotent loader of the three D1 classes that
// the projector does not write and that are EMPTY while the marker is `prepared`: film_rated_admission (expected 708), film_retention (401) and
// tmdb_retirement_decision (4), 1,113 rows. The fenced writers (admitRatedFilm, retainFilm, recordRetirementDecision) need the marker `open`
// (assertWritable) and so cannot be used; this tool is their `prepared` counterpart, separately verified, and it is NOT a second canonical writer: it never writes
// a Film, a Person, an identity row or the marker, only these three tables, and only against a verified baseline.
// OFFLINE and INACTIVE: not bundled (build.mjs lists no such file), no `src/` or Worker import, no route, cron or job, no side effect at import. It has NO write
// path to any database or bucket. The only network it can reach is the read-only R2 client it is given (head/get of three allowlisted keys). It emits the exact
// SQL the human-facing operator session would run through the connector (as `sql` of scripts/film-person-connector-run.mjs does) and reads what the operator saved.
// A live run is a separate owner GO (owner decision 2): nothing here is proof that it ran.
// - `buildLoadPlan` is pure and DRY: sources and a read-only state in, a plan out (counts, digests, rows, bounded batches). Nothing is written, ever.
// - `emitLoadSql` refuses unless called with apply===true AND the pinned plan digest of a plan it can recompute; only then does it render SQL (it never executes it).
// - Every inserted row carries the fence inside its own statement (the guard column `request_id` becomes NULL, a NOT NULL violation, when the guard is false, so the
//   whole batch rolls back): marker `prepared`/`open` at the planned generation, baseline `verified` at the planned reference, the projector lease of the run (and the
//   projector window when one is pinned) still live by the database clock, the class count inside its bounds, and the identity the row stands on (trusted movie id,
//   or the Letterboxd id, held by exactly that Film, not a redirect). The assertion writes nothing: no table outside the three is ever written (not even a fence table).
// - A re-run is a no-op: a row that already exists with the same content is skipped by the statement itself, the plan is rebuilt from the current state so a loaded row
//   is never planned again, and request ids are content-derived and stable (a different existing row, or a row the plan does not know, refuses the plan).
// - Receipts and readback are counts and digests only (no id, title, name or payload); the plan itself holds rows and is PRIVATE.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ACCEPTED_DISCREPANCIES} from '../src/film-person-cutover-accepted.js';
import {watchlistAdmissionsFromIndex} from '../src/enrichment-projection.js';
import {RATED_RECEIPT_KEY,verifiedAdmission} from '../src/film-admission.js';
import {RETIREMENTS_KEY,normalizeDecision,prepareRetirementImport} from '../src/tmdb-retirement-decisions.js';
import {isAllowed,limitedClient} from './film-person-capture.mjs';
import {sqliteDriver} from './film-person-connector-run.mjs';
import {renderSql} from './d1-backfill.mjs';
import {createReadOnlyClient,readCredentials} from './r2-snapshot-export.mjs';
import {assertReadOnly} from './schema-preflight.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const LOADER_VERSION=1;
export const CLASSES=Object.freeze(['ratedAdmission','retention','retirement']);
export const TABLES=Object.freeze({ratedAdmission:'film_rated_admission',retention:'film_retention',retirement:'tmdb_retirement_decision'});
// The pinned expectations are the accepted 11 Nov 2026 measurement (ACCEPTED_DISCREPANCIES.caps), not a number typed again.
export const EXPECTED=Object.freeze(Object.fromEntries(CLASSES.map(name=>[name,ACCEPTED_DISCREPANCIES.caps[name]])));
// Bounds. A batch is one atomic D1 batch with one statement per row, never more than the fenced writers' own cap (MUTATION_STATEMENT_CAP, 60). A run (one plan,
// one pinned digest) carries at most RUN_BATCHES batches; what does not fit is reported as `deferred` and goes into a later run built from the then-current state.
export const BATCH_ROWS=40;
export const BATCH_STATEMENT_CAP=60;
export const RUN_BATCHES=40;
export const RUN_STATEMENTS=1200;
export const SOURCE_KEYS=Object.freeze({verifiedFilms:RATED_RECEIPT_KEY,viewIndex:'enrichment/view-index.json',retirements:RETIREMENTS_KEY});
export const SOURCE_FILES=Object.freeze({verifiedFilms:'verified-films.json',viewIndex:'view-index.json',retirements:'tmdb-retirements.json'});
export const MAX_SOURCE_BYTES=64*1024*1024;
const HEX64=/^[0-9a-f]{64}$/;
const LEASE_ID=/^[A-Za-z0-9:._-]{8,80}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sorted=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(sorted):Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])]))):value;
const stable=value=>JSON.stringify(sorted(value===undefined?null:value));
const sha=text=>createHash('sha256').update(text).digest('hex');
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export class LoaderError extends Error{constructor(reason,detail){super(reason+(detail?': '+detail:''));this.name='LoaderError';this.reason=reason;}}
const stop=(reason,detail)=>new LoaderError(reason,detail);

// ---------- the sources: three allowlisted R2 objects, read-only ----------
// client: createReadOnlyClient(...) or a double with head/get only. limitedClient refuses a key outside the capture's ONE allowlist before a request is built, and
// the three keys here are checked against it again. HEAD, GET If-Match, HEAD, as the capture reads a key: an ETag that moved is a refusal, never a retry.
const readBytes=async body=>Buffer.from(await new Response(body).arrayBuffer());
export async function readSourcesFromClient(client,{maxBytes=MAX_SOURCE_BYTES}={}){
 const limited=limitedClient(client,()=>null);
 const out={};
 for(const [id,key] of Object.entries(SOURCE_KEYS)){
  if(!isAllowed(key,null))throw stop('key_not_allowlisted',id);
  let first,response,bytes,second;
  try{first=await limited.head(key);}catch{throw stop('source_unreadable',id);}
  if(!first)throw stop('source_missing',id);
  if(!(first.size<=maxBytes))throw stop('source_too_large',id);
  try{
   response=await limited.get(key,{ifMatch:first.etag});
   if(!response||response.etag!==first.etag||response.size!==first.size)throw stop('source_changed',id);
   bytes=await readBytes(response.body);
   second=await limited.head(key,{ifMatch:first.etag});
  }catch(error){throw error instanceof LoaderError?error:stop(error?.kind==='source_changed'?'source_changed':'source_unreadable',id);}
  if(bytes.length!==first.size)throw stop('source_size_mismatch',id);
  if(!second||second.etag!==first.etag||second.size!==first.size)throw stop('source_changed',id);
  out[id]={key,bytes,sha256:sha(bytes),size:bytes.length,etag:first.etag};
 }
 return out;
}
// The operator-copy path: three files the operator saved (for example from the capture's private bodies), named SOURCE_FILES.
export function readSourcesFromDirectory(dir){
 const out={};
 for(const [id,name] of Object.entries(SOURCE_FILES)){
  let bytes;
  try{bytes=fs.readFileSync(path.join(dir,name));}catch{throw stop('source_missing',id);}
  out[id]={key:SOURCE_KEYS[id],bytes,sha256:sha(bytes),size:bytes.length,etag:null};
 }
 return out;
}
function parseSources(sources){
 const reasons=[],parsed={};
 for(const id of Object.keys(SOURCE_KEYS)){
  const item=sources?.[id];
  if(!item||!Buffer.isBuffer(item.bytes)&&typeof item.bytes!=='string'){reasons.push('source_missing:'+id);continue;}
  const bytes=Buffer.isBuffer(item.bytes)?item.bytes:Buffer.from(item.bytes);
  const digest=sha(bytes);
  if(item.sha256!==undefined&&item.sha256!==digest){reasons.push('source_digest_mismatch:'+id);continue;}
  try{parsed[id]={value:JSON.parse(bytes.toString('utf8')),sha256:digest,size:bytes.length};}catch{reasons.push('source_malformed:'+id);}
 }
 if(parsed.verifiedFilms&&!(record(parsed.verifiedFilms.value)&&parsed.verifiedFilms.value.schemaVersion===1&&record(parsed.verifiedFilms.value.films)))reasons.push('source_malformed:verifiedFilms');
 if(parsed.viewIndex&&!record(parsed.viewIndex.value))reasons.push('source_malformed:viewIndex');
 return {reasons,parsed};
}

// ---------- the state: SELECTs only, through any read-only binding (the sqlite stand-in, the operator copy, a recording of the connector) ----------
export const STATE_STATEMENTS=Object.freeze({
 schema:'SELECT version FROM schema_contract WHERE id = 1',
 marker:'SELECT mode, cutover, generation FROM film_person_authority WHERE id = 1',
 baseline:'SELECT state, reference FROM film_person_baseline WHERE id = 1',
 identity:"SELECT film_id, scheme, value, trusted, conflicting FROM film_external_id WHERE scheme IN ('tmdb', 'letterboxd') ORDER BY film_id, scheme, value",
 redirects:'SELECT from_id FROM film_redirect ORDER BY from_id',
 ratedAdmission:'SELECT film_id, tmdb, source_code, archive_sha256, title, year, receipt_key, receipt_film_key, verified_at, request_id FROM film_rated_admission ORDER BY film_id',
 retention:'SELECT film_id, basis, watchlist, evidence_json, request_id, observed_at FROM film_retention ORDER BY film_id',
 retirement:'SELECT request_id, film_id, kind, lid, movie_id, tv_id, evidence_json, confirmation_json, origin, input_sha256, supersedes_seq, payload_json FROM tmdb_retirement_decision ORDER BY seq',
});
for(const sql of Object.values(STATE_STATEMENTS))assertReadOnly(sql);
const noTable=error=>/no such (table|column)/i.test(String(error?.message||error));
export async function readLoadState(db){
 const rows={};
 for(const [id,sql] of Object.entries(STATE_STATEMENTS)){
  try{rows[id]=(await db.prepare(sql).all()).results;}
  catch(error){throw stop(noTable(error)?'state_tables_missing':'state_unreadable',id);}
  if(!Array.isArray(rows[id]))throw stop('state_malformed',id);
 }
 return rows;
}
// A read-only binding over the operator copy (a local sqlite file): one SELECT per statement, nothing else is accepted.
export function copyReadBinding(file){
 const driver=sqliteDriver(file);
 return {prepare(sql){
  const text=assertReadOnly(sql);
  return {all:async()=>({results:driver.query(text)})};
 }};
}

// ---------- the rows ----------
const canon={
 ratedAdmission:row=>({film_id:row.film_id,tmdb:row.tmdb,source_code:row.source_code,archive_sha256:row.archive_sha256,title:row.title??null,year:row.year??null,receipt_key:row.receipt_key,receipt_film_key:row.receipt_film_key,verified_at:row.verified_at,request_id:row.request_id}),
 retention:row=>({film_id:row.film_id,basis:row.basis,watchlist:Number(row.watchlist),evidence_json:stable(JSON.parse(row.evidence_json)),request_id:row.request_id,observed_at:row.observed_at}),
 retirement:row=>({request_id:row.request_id,film_id:row.film_id,kind:row.kind,lid:row.lid,movie_id:row.movie_id,tv_id:row.tv_id,evidence_json:stable(JSON.parse(row.evidence_json)),confirmation_json:stable(JSON.parse(row.confirmation_json)),origin:row.origin,input_sha256:row.input_sha256??null,supersedes_seq:row.supersedes_seq??null,payload_json:row.payload_json}),
};
const keyOf={ratedAdmission:row=>row.film_id,retention:row=>row.film_id,retirement:row=>row.request_id};
const digestOf=(name,rows)=>sha(stable([...rows].sort((a,b)=>keyOf[name](a)<keyOf[name](b)?-1:1)));

// ---------- the plan (pure, dry) ----------
// input: {sources, state, at, leaseId, windowOwner?, expected?, limits?}
//   sources: {verifiedFilms,viewIndex,retirements} each {bytes,sha256?}   state: the result of readLoadState
//   at: the pinned UTC instant stamped into updated_at / recorded_at / observed_at (ms precision, Z)   leaseId: the projector lease the operator holds for the run
// Result: {ok:false,reasons} or {ok:true,plan}. `plan.digest` names the whole run: sources, marker generation, baseline reference, the state it was planned from,
// every row and every statement. Whatever moves changes it, and `emitLoadSql` accepts only the digest that was pinned.
export function buildLoadPlan({sources,state,at,leaseId,windowOwner=null,expected=EXPECTED,limits={}}={}){
 const reasons=[];
 const bounds={batchRows:limits.batchRows??BATCH_ROWS,runBatches:limits.runBatches??RUN_BATCHES,runStatements:limits.runStatements??RUN_STATEMENTS};
 if(!(Number.isInteger(bounds.batchRows)&&bounds.batchRows>=1&&bounds.batchRows<=BATCH_STATEMENT_CAP&&Number.isInteger(bounds.runBatches)&&bounds.runBatches>=1&&bounds.runBatches<=RUN_BATCHES&&Number.isInteger(bounds.runStatements)&&bounds.runStatements>=1&&bounds.runStatements<=RUN_STATEMENTS))return {ok:false,reasons:['limits_invalid']};
 if(typeof at!=='string'||!ISO.test(at)||new Date(at).toISOString()!==at)reasons.push('at_invalid');
 if(typeof leaseId!=='string'||!LEASE_ID.test(leaseId))reasons.push('lease_id_invalid');
 if(windowOwner!==null&&(typeof windowOwner!=='string'||!LEASE_ID.test(windowOwner)))reasons.push('window_owner_invalid');
 if(!record(expected)||!CLASSES.every(name=>Number.isInteger(expected[name])&&expected[name]>=0))reasons.push('expected_invalid');
 if(reasons.length)return {ok:false,reasons};
 // the gate: only a `prepared` marker over a verified baseline lets this tool plan anything
 const marker=state?.marker?.[0],baseline=state?.baseline?.[0];
 const version=Number(state?.schema?.[0]?.version);
 if(!(version>=16))reasons.push('schema_below_16');
 if(!marker)reasons.push('marker_unreadable');
 else{
  if(marker.mode!=='prepared'||marker.cutover!=='open')reasons.push('marker_not_prepared:'+marker.mode+'/'+marker.cutover);
  if(!Number.isInteger(Number(marker.generation))||Number(marker.generation)<0)reasons.push('generation_invalid');
 }
 if(!baseline||baseline.state!=='verified'||typeof baseline.reference!=='string'||!baseline.reference)reasons.push('baseline_not_verified');
 const parsed=parseSources(sources);
 reasons.push(...parsed.reasons);
 if(reasons.length)return {ok:false,reasons};
 const {parsed:src}=parsed;
 const generation=Number(marker.generation),reference=baseline.reference;

 // identity maps from the D1 copy: the typed movie id and the Letterboxd id, and the films that are redirect sources
 const tmdbClaims=new Map(),lidFilms=new Map(),redirects=new Set(state.redirects.map(row=>row.from_id));
 for(const row of state.identity){
  if(row.scheme==='tmdb'){const list=tmdbClaims.get(String(row.value))||[];list.push(row);tmdbClaims.set(String(row.value),list);}
  else if(row.scheme==='letterboxd'){const set=lidFilms.get(String(row.value))||new Set();set.add(row.film_id);lidFilms.set(String(row.value),set);}
 }
 const counts={},rows={},skipped={ratedAdmission:{unverified:0,noFilm:0,identityHeld:0,redirected:0},retention:{noFilm:0,redirected:0},retirement:{}};

 // rated admission: strict per-entry verification (the fenced writer's own rule); the Film must already exist and own the movie id, trusted, unclaimed by any other row
 const receiptsSha16=src.verifiedFilms.sha256.slice(0,16);
 const admissions=[],seenFilm=new Set(),seenCode=new Set();
 for(const [key,item] of Object.entries(src.verifiedFilms.value.films).sort(([a],[b])=>a<b?-1:1)){
  const checked=verifiedAdmission(key,item);
  if(!checked.ok){skipped.ratedAdmission.unverified++;continue;}
  const admission=checked.admission,claims=tmdbClaims.get(admission.tmdb)||[];
  const owner=claims.find(row=>row.trusted===1&&row.conflicting===0)?.film_id??null;
  if(!owner){skipped.ratedAdmission.noFilm++;continue;}
  if(claims.some(row=>!(row.trusted===1&&row.conflicting===0&&row.film_id===owner))){skipped.ratedAdmission.identityHeld++;continue;}
  if(redirects.has(owner)){skipped.ratedAdmission.redirected++;continue;}
  if(seenFilm.has(owner))reasons.push('duplicate_film:ratedAdmission');
  if(seenCode.has(admission.sourceCode))reasons.push('duplicate_source_code');
  seenFilm.add(owner);seenCode.add(admission.sourceCode);
  admissions.push({film_id:owner,tmdb:admission.tmdb,source_code:admission.sourceCode,archive_sha256:admission.archiveSha256,title:admission.title,year:admission.year,receipt_key:RATED_RECEIPT_KEY,receipt_film_key:admission.receiptFilmKey,verified_at:admission.verifiedAt,request_id:'p5-load:'+receiptsSha16+':'+admission.receiptFilmKey});
 }
 rows.ratedAdmission=admissions;

 // retention: the watchlist fact of the view index, per Letterboxd id, on the one Film that carries that id
 const viewSha16=src.viewIndex.sha256.slice(0,16);
 const lists=watchlistAdmissionsFromIndex(src.viewIndex.value),retained=[],seenRetained=new Set();
 for(const lid of Object.keys(lists).sort()){
  const films=lidFilms.get(lid);
  if(!films||films.size===0){skipped.retention.noFilm++;continue;}
  if(films.size>1){reasons.push('retention_ambiguous');continue;}
  const filmId=[...films][0];
  if(redirects.has(filmId)){skipped.retention.redirected++;continue;}
  if(seenRetained.has(filmId))reasons.push('duplicate_film:retention');
  seenRetained.add(filmId);
  retained.push({film_id:filmId,lid,basis:'watchlist_fact',watchlist:lists[lid]?1:0,evidence_json:stable({source:'p5_prepared_load',viewIndexSha256:src.viewIndex.sha256}),request_id:'p5-load:'+viewSha16+':'+filmId,observed_at:at});
 }
 rows.retention=retained;

 // retirement: the existing prepare-only validation of the whole object (one invalid entry invalidates all), then the fenced writer's own normalization of each decision
 const prepared=prepareRetirementImport(src.retirements.value,{sha256:src.retirements.sha256});
 if(!prepared.ok)reasons.push('retirements_invalid:'+prepared.reasons.length);
 const retirements=[];
 for(const decision of prepared.decisions){
  let normalized;
  try{normalized=normalizeDecision(decision);}catch(error){reasons.push('retirements_invalid:'+(error?.reason||'normalize'));continue;}
  retirements.push({request_id:normalized.requestId,film_id:normalized.filmId,kind:normalized.kind,lid:normalized.lid,movie_id:normalized.movieId,tv_id:normalized.tvId,evidence_json:stable(normalized.evidence),confirmation_json:stable(normalized.confirmation),origin:normalized.origin,input_sha256:normalized.inputSha256,supersedes_seq:normalized.supersedesSeq,payload_json:normalized.payload});
 }
 rows.retirement=retirements;
 if(reasons.length)return {ok:false,reasons:[...new Set(reasons)]};

 // against the stored rows: identical = already loaded; different = refuse; stored but not planned = unknown rows, refuse. Nothing is ever updated or deleted.
 const toLoad={},already={},initial={};
 for(const name of CLASSES){
  const stored=new Map(state[name].map(row=>[keyOf[name](canon[name](row)),canon[name](row)]));
  initial[name]=stored.size;
  const planned=new Map(rows[name].map(row=>[keyOf[name](row),row]));
  toLoad[name]=[];already[name]=0;
  for(const [key,row] of planned){
   const have=stored.get(key);
   if(!have)toLoad[name].push(row);
   else if(stable(canonical(name,row))===stable(have))already[name]++;
   else reasons.push('mismatch:'+name);
  }
  if([...stored.keys()].some(key=>!planned.has(key)))reasons.push('unknown_rows:'+name);
  counts[name]={expected:expected[name],planned:planned.size,already:already[name],toLoad:toLoad[name].length,stored:initial[name]};
  if(planned.size!==expected[name])reasons.push('count_mismatch:'+name+':'+planned.size);
 }
 if(reasons.length)return {ok:false,reasons:[...new Set(reasons)],counts};

 // the bounded batches: admission, then retention, then retirement, each in key order, at most `batchRows` rows (= statements) per batch, `runBatches` and `runStatements` per run
 const context={generation,reference,leaseId,windowOwner,at};
 const batches=[];let statements=0,deferred=0;
 for(const name of CLASSES){
  const total=counts[name].planned;
  for(let from=0;from<toLoad[name].length;from+=bounds.batchRows){
   const slice=toLoad[name].slice(from,from+bounds.batchRows);
   if(batches.length>=bounds.runBatches||statements+slice.length>bounds.runStatements){deferred+=slice.length;continue;}
   batches.push({class:name,table:TABLES[name],rows:slice.length,statements:slice.map(row=>insertStatement(name,row,{...context,initial:initial[name],total}))});
   statements+=slice.length;
  }
 }
 const core={version:LOADER_VERSION,gate:{mode:'prepared',cutover:'open',generation,baselineReference:reference},leaseId,windowOwner,at,
  sources:Object.fromEntries(Object.entries(src).map(([id,item])=>[id,{key:SOURCE_KEYS[id],sha256:item.sha256,size:item.size}])),
  classes:Object.fromEntries(CLASSES.map(name=>[name,{...counts[name],digest:digestOf(name,rows[name].map(row=>canonical(name,row))),toLoadDigest:digestOf(name,toLoad[name].map(row=>canonical(name,row))),skipped:skipped[name]}])),
  bounds,batches:batches.map(batch=>({class:batch.class,rows:batch.rows,digest:sha(stable(batch.statements))})),deferred};
 const digest=sha(stable(core));
 return {ok:true,plan:{...core,digest,complete:deferred===0,noop:batches.length===0&&deferred===0,
  expectedRows:Object.fromEntries(CLASSES.map(name=>[name,rows[name].map(row=>canonical(name,row))])),batchStatements:batches}};
}
function canonical(name,row){
 if(name==='ratedAdmission')return canon.ratedAdmission(row);
 if(name==='retention')return canon.retention(row);
 return canon.retirement(row);
}
// The public, document-safe summary: counts, digests and bounds only.
export function summarize(plan){
 return {version:plan.version,digest:plan.digest,gate:plan.gate,at:plan.at,complete:plan.complete,noop:plan.noop,sources:plan.sources,
  classes:Object.fromEntries(CLASSES.map(name=>{const {expected,planned,already,toLoad,stored,digest,toLoadDigest,skipped}=plan.classes[name];return [name,{expected,planned,already,toLoad,stored,digest,toLoadDigest,skipped}];})),
  batches:plan.batches.length,statements:plan.batches.reduce((sum,batch)=>sum+batch.rows,0),deferred:plan.deferred,bounds:plan.bounds};
}

// ---------- the statements ----------
// The fence, as one boolean SQL expression and its parameters. It is part of EVERY row statement, so a batch that crosses a marker move, a generation bump, a changed
// baseline, a lost lease or a lost window writes nothing. The lease and window are judged by the database clock, in the formats the projector stores them.
export function guardSql({generation,reference,leaseId,windowOwner,table,initial,total}){
 const parts=[
  ["(SELECT COUNT(*) FROM film_person_authority a, film_person_baseline b WHERE a.id=1 AND a.mode='prepared' AND a.cutover='open' AND a.generation=? AND b.id=1 AND b.state='verified' AND b.reference=?)=1",[generation,reference]],
  ["(SELECT COUNT(*) FROM projection_run WHERE projection='enrichment' AND lease_id=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))=1",[leaseId]],
 ];
 if(windowOwner!==null)parts.push(["(SELECT COUNT(*) FROM projector_window WHERE id=1 AND state='held' AND owner=? AND expires_at>CAST(strftime('%s','now') AS INTEGER)*1000)=1",[windowOwner]]);
 parts.push(['(SELECT COUNT(*) FROM '+table+') BETWEEN ? AND ?',[initial,total-1]]);
 return {sql:parts.map(part=>part[0]).join(' AND '),params:parts.flatMap(part=>part[1])};
}
const SAME_FILM="NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)";
export function insertStatement(name,row,context){
 const table=TABLES[name],guard=guardSql({...context,table,initial:context.initial,total:context.total});
 if(name==='ratedAdmission'){
  const identity="EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0) AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND value=?)=1 AND "+SAME_FILM;
  return {sql:'INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) SELECT ?,?,?,?,?,?,?,?,?,CASE WHEN ('+guard.sql+') AND ('+identity+') THEN ? END,? WHERE NOT EXISTS (SELECT 1 FROM film_rated_admission WHERE film_id=? AND tmdb=? AND source_code=? AND archive_sha256=? AND title IS ? AND year IS ? AND receipt_key=? AND receipt_film_key=? AND verified_at=? AND request_id=?)',
   params:[row.film_id,row.tmdb,row.source_code,row.archive_sha256,row.title,row.year,row.receipt_key,row.receipt_film_key,row.verified_at,...guard.params,row.film_id,row.tmdb,row.tmdb,row.film_id,row.request_id,context.at,row.film_id,row.tmdb,row.source_code,row.archive_sha256,row.title,row.year,row.receipt_key,row.receipt_film_key,row.verified_at,row.request_id]};
 }
 if(name==='retention'){
  const identity="EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='letterboxd' AND value=?) AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd' AND value=?)=1 AND "+SAME_FILM;
  return {sql:"INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) SELECT ?,'watchlist_fact',?,?,CASE WHEN ("+guard.sql+') AND ('+identity+') THEN ? END,?,? WHERE NOT EXISTS (SELECT 1 FROM film_retention WHERE film_id=? AND basis=\'watchlist_fact\' AND watchlist=? AND evidence_json=? AND request_id=? AND observed_at=?)',
   params:[row.film_id,row.watchlist,row.evidence_json,...guard.params,row.film_id,row.lid,row.lid,row.film_id,row.request_id,row.observed_at,context.at,row.film_id,row.watchlist,row.evidence_json,row.request_id,row.observed_at]};
 }
 return {sql:'INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq,payload_json,recorded_at) SELECT CASE WHEN ('+guard.sql+') THEN ? END,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision WHERE request_id=? AND payload_json=?)',
  params:[...guard.params,row.request_id,row.film_id,row.kind,row.lid,row.movie_id,row.tv_id,row.evidence_json,row.confirmation_json,row.origin,row.input_sha256,row.supersedes_seq,row.payload_json,context.at,row.request_id,row.payload_json]};
}

// ---------- emit: the SQL the operator runs; it is rendered, never executed ----------
// Refuses unless apply===true AND planDigest is the digest of THIS plan (recomputed from its content, so an edited plan file does not pass). Returns one artefact per batch.
export function emitLoadSql({plan,apply,planDigest}={}){
 if(apply!==true)throw stop('apply_required');
 if(typeof planDigest!=='string'||!HEX64.test(planDigest))throw stop('plan_digest_required');
 if(!plan||typeof plan!=='object'||!Array.isArray(plan.batchStatements))throw stop('plan_invalid');
 const {digest,complete,noop,expectedRows,batchStatements,...core}=plan;
 if(sha(stable(core))!==digest)throw stop('plan_tampered');
 if(planDigest!==digest)throw stop('plan_digest_mismatch');
 if(core.batches.length!==batchStatements.length)throw stop('plan_tampered');
 let total=0;
 const artefacts=batchStatements.map((batch,index)=>{
  if(!CLASSES.includes(batch.class)||batch.table!==TABLES[batch.class]||batch.statements.length!==batch.rows||batch.rows<1||batch.rows>BATCH_STATEMENT_CAP)throw stop('plan_tampered');
  if(sha(stable(batch.statements))!==core.batches[index].digest||core.batches[index].class!==batch.class)throw stop('plan_tampered');
  for(const item of batch.statements){
   if(!new RegExp('^INSERT INTO '+batch.table+' ').test(item.sql))throw stop('statement_outside_scope');
   if(!item.sql.includes('CASE WHEN ('))throw stop('statement_unguarded');
  }
  total+=batch.rows;
  const rendered=batch.statements.map(item=>renderSql(item.sql,item.params)+';');
  const body={artefact:'prepared_load_batch',index,class:batch.class,table:batch.table,rows:batch.rows,statements:batch.statements,sql:rendered.join('\n'),expectResults:batch.statements.length,planDigest:digest,gate:core.gate,
   readBack:[STATE_STATEMENTS.marker,STATE_STATEMENTS.baseline,'SELECT COUNT(*) AS n FROM '+batch.table]};
  return {...body,digest:sha(stable(body))};
 });
 if(total>RUN_STATEMENTS||artefacts.length>RUN_BATCHES)throw stop('run_cap_exceeded');
 return {planDigest:digest,batches:artefacts,note:'emitted, not executed: the live run is a separate owner GO (owner decision 2, AIR-374)'};
}

// ---------- readback and receipt: counts and digests only ----------
// state: readLoadState after the run. The ledger holds: the marker and baseline as pinned, and per class the rows planned against the rows stored, exactly.
export function readbackLedger({plan,state,expectGeneration=plan.gate.generation,expectReference=plan.gate.baselineReference}){
 const reasons=[];
 if(expectGeneration!==plan.gate.generation||expectReference!==plan.gate.baselineReference)reasons.push('gate_not_the_pinned_one');
 const marker=state?.marker?.[0],baseline=state?.baseline?.[0];
 if(!marker||marker.mode!=='prepared'||marker.cutover!=='open')reasons.push('marker_moved');
 else if(Number(marker.generation)!==plan.gate.generation)reasons.push('generation_moved');
 if(!baseline||baseline.state!=='verified'||baseline.reference!==plan.gate.baselineReference)reasons.push('baseline_changed');
 const classes={};
 for(const name of CLASSES){
  const stored=new Map(state[name].map(row=>[keyOf[name](canon[name](row)),canon[name](row)]));
  const planned=new Map(plan.expectedRows[name].map(row=>[keyOf[name](row),row]));
  let missing=0,different=0,unexpected=0;
  for(const [key,row] of planned){const have=stored.get(key);if(!have)missing++;else if(stable(have)!==stable(row))different++;}
  for(const key of stored.keys())if(!planned.has(key))unexpected++;
  const ok=missing===0&&different===0&&unexpected===0&&stored.size===plan.classes[name].expected;
  if(!ok)reasons.push('readback:'+name);
  classes[name]={expected:plan.classes[name].expected,stored:stored.size,missing,different,unexpected,digest:digestOf(name,[...stored.values()]),plannedDigest:plan.classes[name].digest,ok};
 }
 const core={version:LOADER_VERSION,kind:'film-person-prepared-load-readback',planDigest:plan.digest,gate:plan.gate,marker:marker?{mode:marker.mode,cutover:marker.cutover,generation:Number(marker.generation)}:null,classes,ok:reasons.length===0,reasons};
 return {...core,digest:sha(stable(core))};
}
export function buildReceipt({plan,ledger,at}){
 const core={version:LOADER_VERSION,kind:'film-person-prepared-load-receipt',planDigest:plan.digest,at,sources:plan.sources,gate:plan.gate,
  counts:Object.fromEntries(CLASSES.map(name=>[name,{expected:plan.classes[name].expected,stored:ledger.classes[name].stored,digest:ledger.classes[name].digest}])),readbackDigest:ledger.digest,ok:ledger.ok===true};
 return {...core,digest:sha(stable(core))};
}

// ---------- CLI ----------
const USAGE=`Usage: node scripts/film-person-prepared-loader.mjs <command> [options]
  plan    --copy FILE (--source-dir DIR | --r2) --at ISO --lease-id ID [--window-owner ID] [--out DIR]
          DRY RUN (the default and only mode of this command): counts, digests and bounds on stdout; --out saves the private plan file. Writes nothing to any database.
  sql     the same inputs plus --apply --plan-digest HEX --out DIR
          rebuilds the plan from the current inputs and emits the SQL of each batch ONLY when its digest equals the pinned one; without --apply it refuses.
  verify  the same inputs plus --expect-generation N --expect-reference REF [--out DIR]
          readback of a copy taken after the run: the ledger and the receipt (counts and digests only).
--copy is the operator copy of production D1 (local sqlite). --source-dir holds ${Object.values(SOURCE_FILES).join(', ')}; --r2 reads the three allowlisted keys through the
read-only client (R2_SNAPSHOT_* in the environment). Every --out and every private file must be OUTSIDE the repository. Nothing here calls the connector or writes to production.`;
const privatePath=file=>{const full=path.resolve(file);if(!path.relative(ROOT,full).startsWith('..'))throw stop('private_path_inside_repository');return full;};
const writePrivate=(file,value)=>{const full=privatePath(file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,JSON.stringify(value),{mode:0o600});return full;};
export async function main(argv,{client=null}={}){
 const [command,...rest]=argv;
 const option=name=>{const index=rest.indexOf('--'+name);return index>=0?rest[index+1]:undefined;};
 const need=name=>{const value=option(name);if(!value)throw stop('usage','--'+name);return value;};
 const print=value=>console.log(JSON.stringify(value,null,1));
 if(!['plan','sql','verify'].includes(command))throw stop('usage');
 const sources=option('source-dir')?readSourcesFromDirectory(privatePath(option('source-dir'))):rest.includes('--r2')?await readSourcesFromClient(client||createReadOnlyClient({credentials:readCredentials(process.env),retries:2})):(()=>{throw stop('usage','--source-dir or --r2');})();
 const state=await readLoadState(copyReadBinding(privatePath(need('copy'))));
 const built=buildLoadPlan({sources,state,at:need('at'),leaseId:need('lease-id'),windowOwner:option('window-owner')??null});
 if(command==='verify'){
  // after the run the plan has nothing left to load; its expected rows are the readback's reference
  if(!built.ok)return print({ok:false,reasons:built.reasons});
  const ledger=readbackLedger({plan:built.plan,state,expectGeneration:Number(need('expect-generation')),expectReference:need('expect-reference')});
  const receipt=buildReceipt({plan:built.plan,ledger,at:need('at')});
  if(option('out')){const out=privatePath(option('out'));writePrivate(path.join(out,'readback.json'),ledger);writePrivate(path.join(out,'receipt.json'),receipt);}
  process.exitCode=ledger.ok?0:2;
  return print({ledger:{ok:ledger.ok,reasons:ledger.reasons,digest:ledger.digest,classes:ledger.classes},receipt:{digest:receipt.digest,ok:receipt.ok}});
 }
 if(!built.ok){process.exitCode=2;return print({ok:false,reasons:built.reasons,counts:built.counts??null});}
 if(command==='plan'){
  if(option('out'))writePrivate(path.join(privatePath(option('out')),'plan.private.json'),built.plan);
  return print({ok:true,mode:'dry-run',...summarize(built.plan)});
 }
 const emitted=emitLoadSql({plan:built.plan,apply:rest.includes('--apply'),planDigest:option('plan-digest')});
 const out=privatePath(need('out'));
 emitted.batches.forEach(batch=>writePrivate(path.join(out,'sql-batch-'+String(batch.index).padStart(3,'0')+'.json'),batch));
 return print({ok:true,planDigest:emitted.planDigest,batches:emitted.batches.map(batch=>({index:batch.index,class:batch.class,rows:batch.rows,digest:batch.digest})),note:emitted.note});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).catch(error=>{console.error(error instanceof LoaderError?'STOP '+error.message:'STOP '+String(error?.code||error?.message||error));if(error instanceof LoaderError&&error.reason==='usage')console.error(USAGE);process.exitCode=1;});
}
