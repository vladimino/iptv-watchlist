// AIR-571 / ADR 0186 decision 8, holdpoints (d): the Watchlist marker transitions of the owner operator (scripts/watchlist-cutover-production.mjs). Pure: no I/O and no clock.
// Each transition is ONE guarded batch: [the guard upsert of the fence row, the marker UPDATE compare-and-swapped on (mode, writes, generation), the fence check]. A false guard trips
// CHECK (ok = 1) in watchlist_cas and aborts the whole batch. Nothing here writes the pointer, a snapshot, a member, a journal row, the EPG, R2 or any other domain.
//
//   hold           epg/open  G -> epg/held G+1   the import is current; no EPG step; checkpoint settled; Letterboxd mode closed (external or absent)
//   release-abort  epg/held  G -> epg/open G     back out before the switch: nothing else changed
//   activate       epg/held  G -> d1/held  G+1   the same proofs as `hold`, re-asserted in the switching batch
//   release        d1/held   G -> d1/open  G     the snapshot is servable and unchanged since the pins
//   hold-rollback  d1/open   G -> d1/held  G+1   first step of the data rollback: Letterboxd mode closed, no EPG step, snapshot intact
//   revert-authority     d1/held G -> epg/held G+1  AFTER the rollback export: the published generation's watchlist part equals the snapshot in membership and order. The operator also proves (outside, from R2)
//                        that the root watchlist.json carries this generation's fence and the restored legacy document (`fence-root-rollback`). Both this transition and `activate` INVALIDATE the mirror delivery receipt
//                        (`mirror_delivered_snapshot_id`, attempts, retry time of watchlist_current): the token is history, not proof of the object, because the EPG can replace the root while the token stays.
//   release-rolled-back  epg/held G -> epg/open G   the EPG owns the Watchlist again; backing out of nothing else is checked (the EPG may have published its own list since)
// The rollback export itself writes the published generation through the EPG writer path (`PublishedEpg.saveWatchlist`, a staged commit compare-and-swapped on the EPG generation); it is not a marker transition.
import {livenessGuard} from './watchlist-bootstrap.js';

const GUARD=expression=>'INSERT INTO watchlist_cas (id, ok) SELECT 1, '+expression+' WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
const FENCE='UPDATE watchlist_cas SET ok=changes() WHERE id=1';

export const TRANSITIONS=Object.freeze({
 hold:{from:{mode:'epg',writes:'open'},to:{mode:'epg',writes:'held'},bump:true,needs:['snapshotImport','source','liveness','checkpoint','letterboxdClosed']},
 'release-abort':{from:{mode:'epg',writes:'held'},to:{mode:'epg',writes:'open'},bump:false,needs:[]},
 activate:{from:{mode:'epg',writes:'held'},to:{mode:'d1',writes:'held'},bump:true,invalidateMirror:true,needs:['snapshotImport','source','liveness','checkpoint','letterboxdClosed']},
 release:{from:{mode:'d1',writes:'held'},to:{mode:'d1',writes:'open'},bump:false,needs:['snapshotImport','checkpoint','letterboxdClosed']},
 'hold-rollback':{from:{mode:'d1',writes:'open'},to:{mode:'d1',writes:'held'},bump:true,needs:['snapshotCurrent','liveness','letterboxdClosed']},
 'revert-authority':{from:{mode:'d1',writes:'held'},to:{mode:'epg',writes:'held'},bump:true,invalidateMirror:true,needs:['snapshotCurrent','exportParity','liveness','letterboxdClosed']},
 'release-rolled-back':{from:{mode:'epg',writes:'held'},to:{mode:'epg',writes:'open'},bump:false,needs:['letterboxdClosed']},
});

// facts: what the operator read and verified, re-asserted inside the batch.
//   snapshot:   {snapshotId, sha256, count, revision, version, runId}  the pointer and its snapshot (the forward path pins the bootstrap import: version 1, drained effects)
//   source:     {programmeRunId, epgGeneration}  the published generation the import was taken from, still certified and current
//   liveness:   {controlRevision, leaseRevision, liveAfterIso}
//   checkpoint: {mode}  the independent EPG checkpoint authority is writes `open` in the mode read (never in the middle of its own cutover)
//   letterboxd: {revision}  the mode document row revision, or -1 when absent; the mode must be `external` (no new writer) or the row absent
function buildParts(needs,from,generation,facts){
 const parts=[["(SELECT COUNT(*) FROM watchlist_authority WHERE id=1 AND mode=? AND writes=? AND generation=?)=1",[from.mode,from.writes,generation]]];
 const need=key=>needs.includes(key);
 const snap=facts.snapshot;
 if(need('snapshotImport')||need('snapshotCurrent')){
  if(!snap||!snap.snapshotId||!/^[0-9a-f]{64}$/.test(snap.sha256||'')||!Number.isInteger(snap.count)||!Number.isInteger(snap.revision)||!Number.isInteger(snap.version))throw new Error('cutover_snapshot');
  // The pointer is the pinned one (same revision: nothing moved it) and its snapshot still has every member. The forward path pins the bootstrap import: version 1 with its effects drained.
  // The rollback path pins the current snapshot AND requires its durable causal effects to be done (below): once the writer is closed and the authority is `epg`, nothing could drain them.
  parts.push(["(SELECT COUNT(*) FROM watchlist_current WHERE id=1 AND version=? AND snapshot_id=? AND list_sha256=? AND film_count=? AND revision=?"+(need('snapshotImport')||need('snapshotCurrent')?' AND effects_drained_version=version':'')+")=1 AND (SELECT COUNT(*) FROM watchlist_member WHERE snapshot_id=?)=? AND (SELECT COUNT(*) FROM watchlist_snapshot WHERE snapshot_id=? AND version=? AND list_sha256=? AND film_count=?)=1",[snap.version,snap.snapshotId,snap.sha256,snap.count,snap.revision,snap.snapshotId,snap.count,snap.snapshotId,snap.version,snap.sha256,snap.count]]);
  if(need('snapshotCurrent'))parts.push(["(SELECT COUNT(*) FROM watchlist_effect WHERE status<>'done')=0",[]]);
  if(need('snapshotImport')){
   if(snap.version!==1)throw new Error('cutover_snapshot');
   // The import-only row invariants, at commit time: one staging receipt of the import, one snapshot, exactly the pinned members, and NO change, effect or pending-admission row. A scan journal
   // that appeared (or a missing receipt) means this is not the bootstrap import any more.
   parts.push(["(SELECT COUNT(*) FROM watchlist_staging)=1 AND (SELECT COUNT(*) FROM watchlist_staging WHERE snapshot_id=? AND expected_sha256=? AND expected_count=?)=1 AND (SELECT COUNT(*) FROM watchlist_snapshot)=1 AND (SELECT COUNT(*) FROM watchlist_member)=? AND (SELECT COUNT(*) FROM watchlist_change)=0 AND (SELECT COUNT(*) FROM watchlist_effect)=0 AND (SELECT COUNT(*) FROM watchlist_admission_pending)=0",[snap.snapshotId,snap.sha256,snap.count,snap.count]]);
  }
 }
 if(need('source')){
  const source=facts.source;
  if(!source||!source.programmeRunId||!Number.isInteger(source.epgGeneration)||!snap?.runId||snap.runId!==source.programmeRunId)throw new Error('cutover_source');
  // The published generation is the one the import came from: same run and EPG generation, certified complete, and its stored member rows still count the list.
  parts.push(["(SELECT COUNT(*) FROM published_epg_authority WHERE id=1 AND mode='d1' AND cutover='open' AND programme_run_id=? AND generation=? AND finalized_run_id=programme_run_id)=1 AND (SELECT COUNT(*) FROM published_epg_member WHERE programme_run_id=? AND kind='watchlist')=? AND (SELECT run_id FROM watchlist_snapshot WHERE snapshot_id=?)=?",[source.programmeRunId,source.epgGeneration,source.programmeRunId,snap.count,snap.snapshotId,source.programmeRunId]]);
 }
 if(need('publishedCertified')){
  const published=facts.published;
  if(!published||!published.programmeRunId||!Number.isInteger(published.epgGeneration))throw new Error('cutover_published');
  // The export commits over a certified, current publication: the pinned run at the pinned EPG generation (the writer's own compare-and-swap repeats the generation).
  parts.push(["(SELECT COUNT(*) FROM published_epg_authority WHERE id=1 AND mode='d1' AND cutover='open' AND programme_run_id=? AND generation=? AND finalized_run_id=programme_run_id)=1",[published.programmeRunId,published.epgGeneration]]);
 }
 if(need('exportParity')){
  const parity=facts.parity;
  if(!parity||!parity.programmeRunId||!Number.isInteger(parity.epgGeneration)||!/^[0-9a-f]{64}$/.test(parity.payloadSha256||'')||!snap)throw new Error('cutover_parity');
  // The published generation's watchlist part equals the pinned snapshot at the exact generation the export produced. The operator compared the normalized document digest (title, year, url included)
  // and the member order outside; the batch binds that proof: the run is certified, the generation and the stored payload digest of the generation are the ones read, and the member rows
  // still join the snapshot on ordinal and id. A replacement after the read changes the generation and the payload digest and aborts the batch.
  parts.push(["(SELECT COUNT(*) FROM published_epg_authority WHERE id=1 AND mode='d1' AND cutover='open' AND programme_run_id=? AND generation=? AND finalized_run_id=programme_run_id)=1 AND (SELECT payload_sha256 FROM published_epg_generation WHERE programme_run_id=?)=? AND (SELECT COUNT(*) FROM published_epg_member WHERE programme_run_id=? AND kind='watchlist')=? AND (SELECT COUNT(*) FROM published_epg_member m JOIN watchlist_member w ON w.snapshot_id=? AND w.ordinal=m.ordinal AND w.lid=m.film_id WHERE m.programme_run_id=? AND m.kind='watchlist')=?",[parity.programmeRunId,parity.epgGeneration,parity.programmeRunId,parity.payloadSha256,parity.programmeRunId,snap.count,snap.snapshotId,parity.programmeRunId,snap.count]]);
 }
 if(need('checkpoint')){
  // ADR 0186 decision 8.3 / O4: the EPG checkpoint cutover is completed first. The forward path switches only with the checkpoint authority `d1` and `open`, and re-asserts it here;
  // `r2`, a held marker and a mode that changed after the read all abort the batch.
  if(!facts.checkpoint||facts.checkpoint.mode!=='d1')throw new Error('cutover_checkpoint');
  parts.push(["(SELECT COUNT(*) FROM epg_checkpoint_authority WHERE id=1 AND mode='d1' AND writes='open')=1",[]]);
 }
 if(need('letterboxdClosed')){
  if(!facts.letterboxd||!Number.isInteger(facts.letterboxd.revision))throw new Error('cutover_letterboxd');
  // No new writer: the Letterboxd mode row is absent or `external`, and it is the row that was read (revision pinned, absence included).
  parts.push(["NOT EXISTS (SELECT 1 FROM letterboxd_sync_mode WHERE mode<>'external') AND COALESCE((SELECT revision FROM letterboxd_sync_mode WHERE id=1),-1)=?",[facts.letterboxd.revision]]);
 }
 return parts;
}
const guardStatement=parts=>[GUARD(parts.map(([sql])=>'('+sql+')').join(' AND ')),parts.flatMap(([,params])=>params)];

export function transitionStatements(name,{generation,facts={}}){
 const spec=TRANSITIONS[name];
 if(!spec)throw new Error('cutover_usage');
 if(!Number.isInteger(generation)||generation<0)throw new Error('cutover_generation');
 const statements=[guardStatement(buildParts(spec.needs,spec.from,generation,facts))];
 if(spec.needs.includes('liveness'))statements.push(livenessGuard(facts.liveness));
 statements.push(
  ...(spec.invalidateMirror?[['UPDATE watchlist_current SET mirror_delivered_snapshot_id=NULL, mirror_attempts=0, mirror_next_retry_at=NULL, revision=revision+1 WHERE id=1 AND (mirror_delivered_snapshot_id IS NOT NULL OR mirror_attempts<>0 OR mirror_next_retry_at IS NOT NULL)',[]]]:[]),
  ['UPDATE watchlist_authority SET mode=?, writes=?, generation=? WHERE id=1 AND mode=? AND writes=? AND generation=?',[spec.to.mode,spec.to.writes,spec.bump?generation+1:generation,spec.from.mode,spec.from.writes,generation]],
  [FENCE,[]],
 );
 if(statements.some(([,params])=>params.length>100))throw new Error('cutover_params');
 return {statements,target:{mode:spec.to.mode,writes:spec.to.writes,generation:spec.bump?generation+1:generation}};
}

// The commit guard of the rollback export, asserted INSIDE the staged writer's final replacement batch (PublishedEpg `guards` option), not before it: the marker is `d1`/`held` at the generation
// read, the pointer and snapshot are the pinned ones with their causal effects done, the Letterboxd mode is closed and pinned, no EPG step holds the liveness proof and the publication is the pinned
// certified run at the pinned generation. A change at any point of the multi-batch staging aborts the replacement and nothing authoritative is written.
export const EXPORT_GUARD_NEEDS=Object.freeze(['snapshotCurrent','publishedCertified','letterboxdClosed']);
export function exportGuards({generation,facts={}}){
 if(!Number.isInteger(generation)||generation<0)throw new Error('cutover_generation');
 const guards=[guardStatement(buildParts(EXPORT_GUARD_NEEDS,{mode:'d1',writes:'held'},generation,facts)),livenessGuard(facts.liveness)];
 if(guards.some(([,params])=>params.length>100))throw new Error('cutover_params');
 return guards;
}
