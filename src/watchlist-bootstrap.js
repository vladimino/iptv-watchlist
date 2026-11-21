// AIR-571 / ADR 0186 decision 8.2(c). The bootstrap import of the current published watchlist into snapshot version 1 while the marker is still `epg`.
// It is an import, not a scan: it writes the staging row, the ordered member rows, the snapshot row and the pointer, and NOTHING else (no change, effect or
// pending-admission row, no fact, no retention row, no marker move). Pure: no I/O and no clock; the owner operator (scripts/watchlist-bootstrap-production.mjs)
// reads the source, pins it and runs the statements in ONE atomic batch. Every guard is an upsert of the fence row (`INSERT ... ON CONFLICT DO UPDATE`), so
// a false guard trips CHECK (ok = 1) and aborts the whole batch.
import {LIMITS,listDigest,normalizeFilms} from './watchlist-d1.js';

export const BOOTSTRAP_MEMBERS_PER_STATEMENT=16; // 6 bound values each: 96 of the 100 a D1 statement allows
export const BOOTSTRAP_OUTCOME='bootstrap';
const GUARD=expression=>'INSERT INTO watchlist_cas (id, ok) SELECT 1, '+expression+' WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
const FENCE='UPDATE watchlist_cas SET ok=changes() WHERE id=1';

// Membership and order only: SHA-256 of the lines `ordinal<TAB>id<NEWLINE>`. It is what the owner can reproduce from the authoritative `GET /api/watchlist` response, because the
// route localizes titles at read time (presentLocalized) while ids and order stay those of the published generation. The raw payload digest (`listDigest`, titles included) is a
// separate pin bound to the exact generation, never compared with the presented titles.
export async function membershipDigest(films){
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(films.map((film,index)=>(film.ordinal??index)+'\t'+(film.lid??film.id)+'\n').join('')));
 return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

// The source document of a published generation -> {ok:true,films,digest} | {ok:false,reason}
export async function sourceList(document){
 if(!document||!Array.isArray(document.films))return {ok:false,reason:'source_shape'};
 const films=normalizeFilms(document.films);
 if(!films||!films.length)return {ok:false,reason:'source_shape'};
 return {ok:true,films,digest:await listDigest(films)};
}

// pin: {programmeRunId, epgGeneration, count, sha256, observedAt}; at: the commit instant (ISO); expected: the pointer row the batch starts from {revision}.
// -> {statements:[[sql,params]], snapshotId, version:1}
export function bootstrapStatements({films,pin,snapshotId,at,generation,revision,liveness}){
 if(!Array.isArray(films)||!films.length||films.length>LIMITS.maxFilms)throw new Error('bootstrap_films');
 if(!pin?.programmeRunId||!Number.isInteger(pin.epgGeneration)||pin.count!==films.length||!/^[0-9a-f]{64}$/.test(pin.sha256||''))throw new Error('bootstrap_pin');
 if(!snapshotId||snapshotId.length>100||!Number.isInteger(generation)||!Number.isInteger(revision))throw new Error('bootstrap_args');
 // The EPG liveness proof is part of the batch: the control and lease records are pinned by revision (absence included) and must not be live at commit time.
 if(!liveness||!Number.isInteger(liveness.controlRevision)||!Number.isInteger(liveness.leaseRevision)||typeof liveness.nowIso!=='string')throw new Error('bootstrap_liveness');
 const count=films.length;
 const statements=[
  // The marker is the inert `epg` at the expected generation with writes open, the pointer is the birth row and no snapshot or staging row exists.
  [GUARD("(SELECT COUNT(*) FROM watchlist_authority WHERE id=1 AND mode='epg' AND writes='open' AND generation=?)"),[generation]],
  [GUARD("(SELECT COUNT(*) FROM watchlist_current WHERE id=1 AND version=0 AND snapshot_id IS NULL AND revision=?)"),[revision]],
  [GUARD('(SELECT COUNT(*) FROM watchlist_staging)+(SELECT COUNT(*) FROM watchlist_snapshot)+(SELECT COUNT(*) FROM watchlist_member)+(SELECT COUNT(*) FROM watchlist_change)+(SELECT COUNT(*) FROM watchlist_effect)+(SELECT COUNT(*) FROM watchlist_admission_pending)=0'),[]],
  // The source is still the pinned published generation: same run, same EPG generation, and the stored member rows still count the pinned list.
  // No EPG writer holds a step at the commit. The table already refuses invalid JSON; a record that is valid JSON but not an object is unknown, not idle (fail closed), and a lease without an expiry counts as live.
  [GUARD("NOT EXISTS (SELECT 1 FROM epg_orchestration_document WHERE key IN ('control','lease') AND json_type(body)<>'object') AND COALESCE((SELECT revision FROM epg_orchestration_document WHERE key='control'),-1)=? AND COALESCE((SELECT revision FROM epg_orchestration_document WHERE key='lease'),-1)=? AND NOT EXISTS (SELECT 1 FROM epg_orchestration_document WHERE key='control' AND json_extract(body,'$.phase') IN ('starting','running','waiting')) AND NOT EXISTS (SELECT 1 FROM epg_orchestration_document WHERE key='lease' AND COALESCE(json_extract(body,'$.released'),0)=0 AND (json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?))"),[liveness.controlRevision,liveness.leaseRevision,liveness.nowIso]],
  [GUARD("(SELECT COUNT(*) FROM published_epg_authority WHERE id=1 AND mode='d1' AND cutover='open' AND programme_run_id=? AND generation=? AND finalized_run_id=programme_run_id)=1 AND (SELECT COUNT(*) FROM published_epg_member WHERE programme_run_id=? AND kind='watchlist')=?"),[pin.programmeRunId,pin.epgGeneration,pin.programmeRunId,count]],
  ['INSERT INTO watchlist_staging (snapshot_id, attempt_id, run_id, slot_key, expected_count, expected_sha256, started_at) VALUES (?,?,?,NULL,?,?,?)',[snapshotId,snapshotId,pin.programmeRunId,count,pin.sha256,at]],
 ];
 for(let from=0;from<count;from+=BOOTSTRAP_MEMBERS_PER_STATEMENT){
  const slice=films.slice(from,from+BOOTSTRAP_MEMBERS_PER_STATEMENT);
  statements.push(['INSERT INTO watchlist_member (snapshot_id, ordinal, lid, title, year, url) VALUES '+slice.map(()=>'(?,?,?,?,?,?)').join(', '),slice.flatMap(film=>[snapshotId,film.ordinal,film.lid,film.title,film.year,film.url])]);
 }
 statements.push(
  // The staged rows are the whole pinned list.
  [GUARD('CASE WHEN (SELECT COUNT(*) FROM watchlist_member WHERE snapshot_id=?)=? AND (SELECT COALESCE(MIN(ordinal),-1) FROM watchlist_member WHERE snapshot_id=?)=0 AND (SELECT COALESCE(MAX(ordinal),-1) FROM watchlist_member WHERE snapshot_id=?)=?-1 AND (SELECT COUNT(DISTINCT lid) FROM watchlist_member WHERE snapshot_id=?)=? THEN 1 ELSE 0 END'),[snapshotId,count,snapshotId,snapshotId,count,snapshotId,count]],
  ['INSERT INTO watchlist_snapshot (snapshot_id, version, scan_id, observed_at, committed_at, film_count, list_sha256, prev_version, slot_key, run_id) VALUES (?,1,?,?,?,?,?,0,NULL,?)',[snapshotId,'bootstrap:'+pin.programmeRunId,pin.observedAt,at,count,pin.sha256,pin.programmeRunId]],
  // The pointer moves 0 -> 1 by compare-and-swap. The import writes no effect, so the effects it would owe are drained at birth.
  ['UPDATE watchlist_current SET version=1, snapshot_id=?, list_sha256=?, film_count=?, last_success_at=?, last_success_run=?, last_success_slot=NULL, last_attempt_at=?, last_attempt_outcome=?, effects_drained_version=1, revision=revision+1, updated_at=? WHERE id=1 AND version=0 AND revision=?',[snapshotId,pin.sha256,count,pin.observedAt,pin.programmeRunId,at,BOOTSTRAP_OUTCOME,at,revision]],
  [FENCE,[]],
 );
 if(statements.some(([,params])=>params.length>100))throw new Error('bootstrap_params');
 return {statements,snapshotId,version:1};
}
