// Copy of the mutable discovery objects that --load leaves behind, and the two
// marker commands that follow it. Archive segments stay out: ADR 0085 imports
// one only after the marker is already authoritative, and this operator does
// not expose that command. The ledger seal stays the runtime handoff.
import {createHash} from 'node:crypto';
import {decisionHash} from '../src/discovery-authority.js';
import {renderSql} from './d1-backfill.mjs';

export const IMPORT_READ_CAP=20000;
export const SCORE_CAP=64;
export const SMALL_MAX_BYTES=200000;
export const IMPORT_BATCH_STATEMENTS=100;
export const IMPORT_BATCH_BYTES=1024*1024;
const STATEMENT_BYTES=100*1024;

export function mediaKind(film){
 const id=film?.id==null?'':String(film.id);
 const canon=typeof film?.canonicalIdentity==='string'?film.canonicalIdentity:'';
 if(id.startsWith('tmdb_tv')||canon.startsWith('tmdb_tv:')||film?.mediaType==='tv'||film?.kind==='tv')return 'tv';
 return 'movie';
}

function stop(reason, exitCode=3){
 const error=new Error(reason);
 error.reason=reason;
 error.exitCode=exitCode;
 throw error;
}

export function isCutoverStop(error){
 return error&&typeof error.reason==='string'&&Number.isInteger(error.exitCode);
}

function textOf(value){
 const text=JSON.stringify(value);
 if(Buffer.byteLength(text,'utf8')>STATEMENT_BYTES)stop('batch_too_large');
 return text;
}

export function catalogEntries(films){
 if(!films||typeof films!=='object'||Array.isArray(films))stop('import_refused');
 const seen=new Set();
 const entries=Object.entries(films).map(([filmId,film])=>{
  if(typeof filmId!=='string'||!filmId||filmId.length>200||/[\u0000-\u001f]/.test(filmId))stop('import_refused');
  if(!film||typeof film!=='object'||Array.isArray(film)||film.tmdbId==null)stop('import_refused');
  const kind=mediaKind(film);
  const id=String(film.tmdbId);
  const expected=(kind==='tv'?'tmdb_tv:':'tmdb:')+id;
  if(film.canonicalIdentity!==expected)stop('import_refused');
  const token=kind+':'+id;
  if(seen.has(token))stop('import_refused');
  seen.add(token);
  return {filmId,film,kind,tmdbId:id};
 });
 if(entries.length>IMPORT_READ_CAP)stop('import_refused');
 entries.sort((left,right)=>left.filmId<right.filmId?-1:left.filmId>right.filmId?1:0);
 return entries;
}

export function decisionEntries(map){
 if(!map||typeof map!=='object'||Array.isArray(map))stop('import_refused');
 const entries=Object.entries(map).filter(([key])=>key!=='__canonicalizedAt').map(([key,decision])=>{
  if(typeof key!=='string'||!key||key.length>200||/[\u0000-\u001f]/.test(key))stop('import_refused');
  if(!decision||typeof decision!=='object'||Array.isArray(decision))stop('import_refused');
  return {key,decision};
 });
 if(entries.length>IMPORT_READ_CAP)stop('import_refused');
 entries.sort((left,right)=>left.key<right.key?-1:left.key>right.key?1:0);
 return entries;
}

export function assertDecisionEvidence(entries, evidenceByKey){
 for(const row of entries){
  if(row.decision.evidenceKey==null)continue;
  if(!evidenceByKey.has(row.key))continue;
  if(evidenceByKey.get(row.key)!==row.decision.evidenceKey)stop('import_refused');
 }
}

export function scoreEntries(preview, programmeRunId){
 if(preview==null)return [];
 if(!preview||typeof preview!=='object'||Array.isArray(preview)||preview.programmeRunId!==programmeRunId)stop('import_refused');
 const items=preview.items&&typeof preview.items==='object'&&!Array.isArray(preview.items)?Object.values(preview.items):null;
 if(!items)stop('import_refused');
 if(items.length>SCORE_CAP)stop('import_refused');
 const entries=[];
 const seen=new Set();
 for(const item of items){
  if(!item||typeof item!=='object'||typeof item.observationKey!=='string'||!item.observationKey||seen.has(item.observationKey))stop('import_refused');
  seen.add(item.observationKey);
  entries.push(item);
 }
 entries.sort((left,right)=>left.observationKey<right.observationKey?-1:left.observationKey>right.observationKey?1:0);
 return entries;
}

export function statusText(status, programmeRunId){
 if(!status||typeof status!=='object'||Array.isArray(status))stop('import_refused');
 if(status.programmeRunId!=null&&status.programmeRunId!==programmeRunId)stop('import_refused');
 const text=JSON.stringify(status);
 if(text.length>SMALL_MAX_BYTES)stop('import_refused');
 return {text,retryAt:typeof status.retryAt==='string'?status.retryAt:null};
}

export function recordText(record, programmeRunId){
 if(record==null)return {text:null,programmeRunId:null,instanceId:null,series:null,revision:0};
 if(!record||typeof record!=='object'||Array.isArray(record))stop('import_refused');
 if(record.programmeRunId!=null&&record.programmeRunId!==programmeRunId)stop('import_refused');
 const text=JSON.stringify(record);
 if(text.length>SMALL_MAX_BYTES)stop('import_refused');
 return {
  text,
  programmeRunId:record.programmeRunId??null,
  instanceId:typeof record.instanceId==='string'?record.instanceId:null,
  series:Number.isInteger(record.series)?record.series:null,
  revision:1,
 };
}

function loaded(snapshot){
 const marker=snapshot?.marker;
 const transfer=snapshot?.transfer;
 return !!marker&&marker.mode==='r2'&&marker.cutover==='open'&&marker.generation>=1&&typeof marker.programmeRunId==='string'&&marker.programmeRunId===marker.publishedProgrammeRunId&&transfer?.state==='committed'&&transfer.programmeRunId===marker.programmeRunId;
}

export function importDecision(snapshot){
 const marker=snapshot?.marker;
 if(marker?.mode==='d1'&&marker.cutover==='held')return 'already_held';
 if(marker?.mode==='d1'&&marker.cutover==='open')return 'already_active';
 if(!loaded(snapshot))return 'ledger_required';
 const hop=snapshot.checkpoint?.hopId??null;
 if(hop==='import')return 'partial_import';
 if(hop!=null)return 'partial_mismatch';
 return 'import';
}

export function holdDecision(snapshot){
 const marker=snapshot?.marker;
 if(marker?.mode==='d1'&&marker.cutover==='held')return 'already_held';
 if(marker?.mode==='d1'&&marker.cutover==='open')return 'already_active';
 if(!loaded(snapshot))return 'ledger_required';
 if((snapshot.checkpoint?.hopId??null)!==null)return 'partial_import';
 return 'hold';
}

export function activateDecision(snapshot){
 const marker=snapshot?.marker;
 if(marker?.mode==='d1'&&marker.cutover==='open'&&marker.generation>=1&&marker.programmeRunId&&marker.programmeRunId===marker.publishedProgrammeRunId)return 'already_active';
 if(marker?.mode==='d1'&&marker.cutover==='held'&&marker.generation>=1&&marker.programmeRunId&&marker.programmeRunId===marker.publishedProgrammeRunId&&snapshot.transfer?.state==='committed'&&snapshot.transfer.programmeRunId===marker.programmeRunId)return 'activate';
 return 'marker_refused';
}

export function importIdentity(spec){
 const body={
  programmeRunId:spec.programmeRunId,
  generation:spec.generation,
  batches:spec.batches,
  catalog:spec.catalog,
  decisions:spec.decisions,
  status:spec.status,
  scores:spec.scores,
  continuation:spec.continuation,
  workflow:spec.workflow,
 };
 const payload=JSON.stringify(body);
 if(payload.length>8000)stop('import_refused');
 return payload;
}

export function parseImportIdentity(payload){
 if(typeof payload!=='string'||payload.length>8000)return null;
 let value;
 try{value=JSON.parse(payload);}catch{return null;}
 if(!value||typeof value.programmeRunId!=='string'||!Number.isInteger(value.generation)||!Number.isInteger(value.batches))return null;
 for(const name of ['catalog','decisions','status','scores','continuation','workflow']){
  const part=value[name];
  if(!part||typeof part.present!=='boolean')return null;
  if(part.present&&(typeof part.etag!=='string'||typeof part.sha256!=='string'||!Number.isInteger(part.bytes)))return null;
 }
 return value;
}

function partMatches(stored, next){
 if(!stored||!next||stored.present!==next.present)return false;
 if(!stored.present)return true;
 return stored.etag===next.etag&&stored.sha256===next.sha256&&stored.bytes===next.bytes;
}

export function sameImportIdentity(stored, next){
 if(!stored||!next)return false;
 if(stored.programmeRunId!==next.programmeRunId||stored.generation!==next.generation||stored.batches!==next.batches)return false;
 return ['catalog','decisions','status','scores','continuation','workflow'].every(name=>partMatches(stored[name],next[name]));
}

export function valuePrefix(stored, expected, same){
 if(stored.length>expected.length)return {cursor:0,mismatch:true};
 for(let index=0;index<stored.length;index++){
  if(!same(stored[index],expected[index]))return {cursor:index,mismatch:true};
 }
 return {cursor:stored.length,mismatch:false};
}

export function admissionSql(row, programmeRunId, generation){
 return renderSql(
  "INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES (?,?,?,?,?,?,?,'current',?)",
  [row.filmId,row.tmdbId,row.kind,row.film.canonicalIdentity,typeof row.film.observationKey==='string'?row.film.observationKey:null,programmeRunId,generation,textOf(row.film)],
 );
}

export async function decisionGroup(row, programmeRunId, generation, writtenAt){
 const hash=await decisionHash(row.decision);
 const payload=textOf(row.decision);
 const kind=row.decision.tmdbId==null?null:mediaKind(row.decision);
 return [
  renderSql(
   "INSERT INTO discovery_decision_history (observation_key, revision, generation, written_at, writer, payload_json) VALUES (?,?,?,?,?,?)",
   [row.key,1,generation,writtenAt,'import',payload],
  ),
  renderSql(
   "INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, evidence_key, terminal_reason, retry_at, tmdb_id, media_kind, film_id, decision_hash, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
   [row.key,programmeRunId,generation,row.decision.status??null,Number.isInteger(row.decision.attempts)?row.decision.attempts:null,row.decision.evidenceKey??null,row.decision.terminalReason??null,row.decision.retryAt??null,row.decision.tmdbId==null?null:String(row.decision.tmdbId),kind,row.decision.filmId??null,hash,payload],
  ),
 ];
}

export function packImportBatches(groups){
 const batches=[];
 let current=[];
 let bytes=0;
 const flush=()=>{if(current.length){batches.push(current);current=[];bytes=0;}};
 for(const group of groups){
  const groupBytes=group.reduce((sum,sql)=>sum+Buffer.byteLength(sql,'utf8')+1,0);
  if(group.length>IMPORT_BATCH_STATEMENTS||groupBytes>IMPORT_BATCH_BYTES)stop('batch_too_large');
  if(current.length&&(current.length+group.length>IMPORT_BATCH_STATEMENTS||bytes+groupBytes>IMPORT_BATCH_BYTES))flush();
  current.push(...group);
  bytes+=groupBytes;
 }
 flush();
 return batches;
}

export function openingImportSql(spec){
 return [
  renderSql("INSERT INTO discovery_cas (id, ok) SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM discovery_authority a, discovery_transfer t, discovery_checkpoint c, discovery_lease l WHERE a.id=1 AND t.id=1 AND c.id=1 AND l.id=1 AND a.mode='r2' AND a.cutover='open' AND a.generation=? AND a.programme_run_id=? AND a.published_programme_run_id=? AND t.state='committed' AND t.programme_run_id=? AND t.batches=? AND c.hop_id IS NULL AND c.payload_json IS NULL AND l.lease_id IS NULL AND l.expires_at=0)",[spec.generation,spec.programmeRunId,spec.programmeRunId,spec.programmeRunId,spec.batches]),
  renderSql("UPDATE discovery_checkpoint SET programme_run_id=?, generation=?, hop_id='import', payload_json=? WHERE id=1 AND hop_id IS NULL AND payload_json IS NULL",[spec.programmeRunId,spec.generation,spec.payload]),
  renderSql("INSERT INTO discovery_cas (id, ok) SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM discovery_checkpoint WHERE id=1 AND hop_id='import' AND programme_run_id=? AND payload_json=?)",[spec.programmeRunId,spec.payload]),
 ];
}

export function commitImportSql(spec){
 const statements=[
  renderSql("INSERT INTO discovery_cas (id, ok) SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM discovery_authority a, discovery_transfer t, discovery_checkpoint c, discovery_lease l WHERE a.id=1 AND t.id=1 AND c.id=1 AND l.id=1 AND a.mode='r2' AND a.cutover='open' AND a.generation=? AND a.programme_run_id=? AND a.published_programme_run_id=? AND t.state='committed' AND t.programme_run_id=? AND t.batches=? AND c.hop_id='import' AND c.programme_run_id=? AND c.payload_json=? AND l.lease_id IS NULL AND l.expires_at=0)",[spec.generation,spec.programmeRunId,spec.programmeRunId,spec.programmeRunId,spec.batches,spec.programmeRunId,spec.payload]),
  renderSql("UPDATE discovery_status SET programme_run_id=?, generation=?, retry_at=?, payload_json=? WHERE id=1",[spec.programmeRunId,spec.generation,spec.retryAt,spec.statusText]),
  renderSql("DELETE FROM discovery_score WHERE programme_run_id IS ?",[spec.programmeRunId]),
 ];
 for(const item of spec.scores){
  statements.push(renderSql(
   "INSERT INTO discovery_score (observation_key, programme_run_id, generation, outcome, reason, payload_json) VALUES (?,?,?,?,?,?)",
   [item.observationKey,spec.programmeRunId,spec.generation,item.outcome??null,item.reason??null,textOf(item)],
  ));
 }
 statements.push(renderSql("UPDATE discovery_continuation SET programme_run_id=?, payload_json=?, revision=? WHERE id=1",[spec.continuation.programmeRunId,spec.continuation.text,spec.continuation.revision]));
 statements.push(renderSql("UPDATE discovery_workflow SET instance_id=?, programme_run_id=?, series=?, payload_json=?, revision=? WHERE id=1",[spec.workflow.instanceId,spec.workflow.programmeRunId,spec.workflow.series,spec.workflow.text,spec.workflow.revision]));
 statements.push(renderSql("UPDATE discovery_checkpoint SET programme_run_id=NULL, generation=0, hop_id=NULL, payload_json=NULL WHERE id=1 AND hop_id='import' AND programme_run_id=? AND payload_json=?",[spec.programmeRunId,spec.payload]));
 statements.push("INSERT INTO discovery_cas (id, ok) SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM discovery_checkpoint WHERE id=1 AND hop_id IS NULL AND payload_json IS NULL AND programme_run_id IS NULL AND generation=0)");
 statements.push(renderSql("INSERT INTO discovery_cas (id, ok) SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM discovery_authority WHERE id=1 AND mode='r2' AND cutover='open' AND generation=? AND programme_run_id=? AND published_programme_run_id=?)",[spec.generation,spec.programmeRunId,spec.programmeRunId]));
 statements.push(renderSql("INSERT INTO discovery_cas (id, ok) SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM discovery_transfer WHERE id=1 AND state='committed' AND programme_run_id=? AND batches=?)",[spec.programmeRunId,spec.batches]));
 if(statements.length>IMPORT_BATCH_STATEMENTS||statements.reduce((sum,sql)=>sum+Buffer.byteLength(sql,'utf8')+1,0)>IMPORT_BATCH_BYTES)stop('batch_too_large');
 return statements;
}

function markerFence(mode, cutover, spec){
 return renderSql("INSERT INTO discovery_cas (id, ok) SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM discovery_authority a, discovery_transfer t, discovery_checkpoint c, discovery_lease l WHERE a.id=1 AND t.id=1 AND c.id=1 AND l.id=1 AND a.mode=? AND a.cutover=? AND a.generation=? AND a.programme_run_id=? AND a.published_programme_run_id=? AND t.state='committed' AND t.programme_run_id=? AND t.batches=? AND c.hop_id IS NULL AND c.payload_json IS NULL AND l.lease_id IS NULL AND l.expires_at=0)",[mode,cutover,spec.generation,spec.programmeRunId,spec.programmeRunId,spec.programmeRunId,spec.batches]);
}

export function holdSql(spec){
 return [
  markerFence('r2','open',spec),
  renderSql("UPDATE discovery_authority SET mode='d1', cutover='held' WHERE id=1 AND mode='r2' AND cutover='open' AND generation=? AND programme_run_id=? AND published_programme_run_id=?",[spec.generation,spec.programmeRunId,spec.programmeRunId]),
  markerFence('d1','held',spec),
 ];
}

export function activateSql(spec){
 return [
  markerFence('d1','held',spec),
  renderSql("UPDATE discovery_authority SET cutover='open' WHERE id=1 AND mode='d1' AND cutover='held' AND generation=? AND programme_run_id=? AND published_programme_run_id=?",[spec.generation,spec.programmeRunId,spec.programmeRunId]),
  markerFence('d1','open',spec),
 ];
}

export function bodySha(text){
 return createHash('sha256').update(text).digest('hex');
}
