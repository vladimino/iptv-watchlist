// AIR-571 (M1) / ADR 0186 decisions 1a and 8.6. The independent reconcile of the root `watchlist.json` mirror of the Watchlist authority, called by the Letterboxd `ensure` on every tick. It is DELIVERY, never state:
// one target (the current pointer, collapsed from any backlog of slots), a bounded retry with backoff recorded in `watchlist_current`, a proof before every acknowledgement, and no effect on a scan, the causal
// effects, the Events, Discovery or the EPG. Dependencies are injected (the module holds no storage of its own): `WatchlistD1` (readAuthority, readCurrent, recordMirror, mirrorToken) and `PublishedEpg`
// (putStandaloneWatchlistRoot). Nothing here runs unless the Letterboxd mode is `cloudflare` (the caller passes its epoch).
export const MIRROR_SOURCE = 'watchlist_authority';
// The backoff after the Nth consecutive failed attempt (capped): a bounded retry, never a tight loop.
export const MIRROR_BACKOFF_MS = [60000, 300000, 900000, 3600000];
export const MIRROR_STALE_MS = 2 * 3600000;
export const MIRROR_STALE_ATTEMPTS = 3;
export const backoffMs = attempts => MIRROR_BACKOFF_MS[Math.min(Math.max(attempts, 1), MIRROR_BACKOFF_MS.length) - 1];

// The standalone document of the current snapshot: membership and order, labelled with the snapshot it mirrors. Ids are the Letterboxd ids; nothing of a programme is in it.
export function mirrorDocument(snapshot) {
  return {
    updatedAt: snapshot.lastSuccessAt,
    films: snapshot.films.map(film => ({id: film.lid, title: film.title, year: film.year, url: film.url})),
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
    lastSuccessAt: snapshot.lastSuccessAt,
    source: MIRROR_SOURCE
  };
}

// The visible health of the mirror, independent of every other signal. `stale` = see below.
export function mirrorState(pointer, now = Date.now()) {
  if (!pointer || !pointer.snapshotId || !pointer.lastSuccessAt) return {state: 'none', stale: false};
  const target = String(pointer.snapshotId) + '|' + String(pointer.lastSuccessAt);
  const owed = pointer.mirrorDeliveredSnapshotId !== target;
  const age = now - Date.parse(pointer.lastSuccessAt);
  // Stale = a target is owed for longer than MIRROR_STALE_MS (from its own success time) OR delivery has failed MIRROR_STALE_ATTEMPTS times in a row: an outage shows before the next slot's age would.
  const stale = owed && ((Number.isFinite(age) && age > MIRROR_STALE_MS) || (pointer.mirrorAttempts ?? 0) >= MIRROR_STALE_ATTEMPTS);
  return {state: owed ? (stale ? 'stale' : 'owed') : 'delivered', stale, attempts: pointer.mirrorAttempts ?? 0, nextRetryAt: pointer.mirrorNextRetryAt ?? null, target, delivered: pointer.mirrorDeliveredSnapshotId ?? null};
}

// One reconcile pass. -> {outcome: 'not_owner'|'unreadable'|'delivered'|'backoff'|'written'|'failed'|'blocked'|'uncertain', ...}. Never throws.
export async function reconcileMirror(env, {epoch, now = Date.now(), deps}) {
  const {WatchlistD1, PublishedEpg} = deps || {};
  if (!WatchlistD1 || !PublishedEpg || !Number.isInteger(epoch)) return {outcome: 'not_owner', reason: 'dependencies'};
  try {
    const authority = await WatchlistD1.readAuthority(env);
    if (authority?.state !== 'd1' || authority.writes !== 'open' || !Number.isInteger(authority.generation)) return {outcome: 'not_owner', reason: 'authority'};
    const read = await WatchlistD1.readCurrent(env, {now, generation: authority.generation});
    if (!read.ok) return {outcome: 'unreadable', reason: read.reason};
    const snapshot = read.snapshot;
    const pointer = snapshot.current;
    const state = mirrorState(pointer, now);
    if (state.state === 'delivered') return {outcome: 'delivered', nothingOwed: true};
    if (pointer.mirrorNextRetryAt && Date.parse(pointer.mirrorNextRetryAt) > now) return {outcome: 'backoff', nextRetryAt: pointer.mirrorNextRetryAt, attempts: pointer.mirrorAttempts};
    const written = await PublishedEpg.putStandaloneWatchlistRoot(env, mirrorDocument(snapshot), {generation: authority.generation, epoch, target: {snapshotId: snapshot.snapshotId, lastSuccessAt: snapshot.lastSuccessAt}});
    if (written.blocked) return {outcome: 'blocked'};
    // The target moved while this pass ran (a newer scan promoted, or only its freshness moved): nothing was written and nothing is recorded; the next tick owes the new target.
    if (written.reason === 'target_moved') return {outcome: 'moved'};
    const target = {snapshotId: snapshot.snapshotId, lastSuccessAt: snapshot.lastSuccessAt, generation: authority.generation, now};
    if (written.proven === true) {
      // Acknowledged only if the pinned target, the generation and the epoch still hold in the batch itself.
      const ack = await WatchlistD1.recordMirror(env, {...target, outcome: 'delivered', guards: [[epochGuardSql, [epoch]]]});
      if (ack.ok && ack.applied !== null) return {outcome: written.wrote ? 'written' : 'delivered', etag: written.etag ?? null, acknowledged: ack.applied === true};
      if (ack.ok) return {outcome: 'uncertain', reason: 'ack_result_unreadable'};
      return {outcome: 'uncertain', reason: 'ack_' + ack.reason};
    }
    const attempts = pointer.mirrorAttempts ?? 0;
    const failed = await WatchlistD1.recordMirror(env, {...target, outcome: 'failed', attempts, nextRetryAt: new Date(now + backoffMs(attempts + 1)).toISOString(), guards: [[epochGuardSql, [epoch]]]});
    // `recorded` is true only for an attempt that was newly recorded: an already delivered target (a late failure) or a lost compare-and-swap is not.
    return {outcome: 'failed', reason: written.reason, recorded: failed.ok === true && failed.applied === true};
  } catch { return {outcome: 'unreadable', reason: 'exception'}; }
}
// The Letterboxd mode epoch guard as a batch statement (an upsert of the fence row of the Letterboxd control plane would be the wrong table here: the Watchlist batch fences with its own table). This asserts the
// mode row in the Watchlist batch through a CHECK-bearing upsert of `watchlist_cas`.
const epochGuardSql = "INSERT INTO watchlist_cas (id, ok) SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM letterboxd_sync_mode WHERE id = 1 AND mode = 'cloudflare' AND epoch = ?) THEN 1 ELSE 0 END WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok";
