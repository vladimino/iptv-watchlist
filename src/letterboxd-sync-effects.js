// AIR-570 / ADR 0186 decision 1. The three CAUSAL effect writers of a promoted Watchlist snapshot: `scan_facts`, `retention` and `removal_enqueue`. Each is applied by the Letterboxd Sync
// (never by the EPG), idempotent through its own key, and returns a receipt string; `null` means "not applied", which holds the drain (the effect stays pending and is counted).
// All collaborators are injected: the Watchlist repository (`readSnapshot`, `snapshotIdOfVersion`, `readChanges`), the facts module, the rated-admission retention surface, the removal-queue
// enqueue, the metadata-cache TMDB lookup and the check that the slot's `watchlist` Event object exists. The Worker supplies the real ones (src/worker.js `letterboxdPorts`).
// Membership removal is MEMBERSHIP ONLY (owner decision O3): none of these writers deletes a Film, a show or a rating, and none infers a watched state or a reason.
export const RETENTION_SLICES_PER_CALL = 24;

export function effectWriters(deps) {
  const {repository, facts, retention, removal, tmdbOf, removalRef, epochGuard, fenceEnv = env => env} = deps;
  // Every authoritative write below goes through the Letterboxd epoch-fenced env (see `fencedEnv`); reads keep the plain env.
  const writeEnv = ctx => fenceEnv(ctx.env, ctx.epoch);
  // The TMDB ids only enrich: a cache outage must not hold the facts (identity stays a Film fact, the facts module links by Letterboxd id), but it does hold retention, which needs them.
  const tmdbForFacts = (env, lids) => tmdbOf(env, lids).catch(() => new Map());
  const snapshotOf = async (ctx, effect) => {
    const read = await repository.readSnapshot(ctx.env, effect.snapshotId);
    return read.ok ? read.snapshot : null;
  };
  return {
    // The facts of the scan: one observation of every listed film (ADR 0024), keyed by the scan id of the snapshot so a replay is the same scan.
    async scan_facts(ctx, effect) {
      const snapshot = await snapshotOf(ctx, effect);
      if (!snapshot) return null;
      const tmdb = await tmdbForFacts(ctx.env, snapshot.films.map(film => film.lid));
      await facts.applyWatchlistScan(writeEnv(ctx), {scanId: snapshot.scanId, observedAt: snapshot.observedAt, films: snapshot.films.map(film => ({id: film.lid, tmdbId: tmdb.get(film.lid) ?? null}))});
      return 'facts:' + snapshot.scanId;
    },
    // Retention transitions (ADR 0173): the listed films are `watchlist: true`, the departed ones `watchlist: false`, from the durable change rows, never from a membership diff.
    // With the canonical rated-admission writer closed the transition is skipped, exactly as the EPG scan did (`facts_only`); the receipt says so.
    async retention(ctx, effect) {
      const snapshot = await snapshotOf(ctx, effect);
      if (!snapshot) return null;
      if (!(await retention.writerOpen(writeEnv(ctx)))) return 'retention:writer_closed:' + snapshot.scanId;
      const changes = await repository.readChanges(ctx.env, effect.snapshotId);
      if (!changes.ok) return null;
      let tmdb;
      try { tmdb = await tmdbOf(ctx.env, snapshot.films.map(film => film.lid)); } catch { return null; }
      const listed = snapshot.films.map(film => ({lid: film.lid, tmdbId: tmdb.get(film.lid) ?? undefined}));
      const queue = retention.work({listed, departed: changes.removed.map(item => item.lid), observedAt: snapshot.observedAt, scanId: snapshot.scanId});
      // The queue (the listed films, then the departed ones) is deterministic for a snapshot, so a resume point is an index into it; it is kept on the pending effect between calls (`effect.progress`), because a list larger
      // than one call (24 slices of UNIT_CAP films) would otherwise restart from 0 every time and never finish. An unreadable or out-of-range point starts over (the units are idempotent), it never skips ahead.
      const resumed = /^retention-cursor:(\d{1,6})$/.exec(String(effect.progress ?? ''));
      const start = resumed && Number(resumed[1]) <= queue.length ? Number(resumed[1]) : 0;
      let cursor = start, intent = [];
      const slicesPerCall = deps.slicesPerCall ?? RETENTION_SLICES_PER_CALL;
      for (let pass = 0; pass < slicesPerCall && cursor < queue.length; pass++) {
        const room = Math.max(0, retention.UNIT_CAP - intent.length);
        const slice = queue.slice(cursor, cursor + room);
        const out = await retention.apply(writeEnv(ctx), {event: 'watchlist:' + snapshot.scanId + ':' + cursor, retentions: slice, intent, limit: retention.UNIT_CAP});
        intent = retention.carry(out);
        if (!retention.settled(out)) return cursor > start ? {progress: 'retention-cursor:' + cursor, more: false} : null;
        cursor += slice.length;
      }
      if (cursor >= queue.length && intent.length === 0) return 'retention:' + snapshot.scanId + ':' + queue.length;
      return cursor > start ? {progress: 'retention-cursor:' + cursor, more: true} : null;
    },
    // The hand-over of the removed films to the Ratings lookup queue, referencing the slot's own `watchlist` Event. It only schedules the rating lookup (O3). It is not applied
    // before that Event object exists, because the queue patches a late rating onto the Event by its key; an absent Event holds the effect until delivery.
    async removal_enqueue(ctx, effect) {
      const snapshot = await snapshotOf(ctx, effect);
      if (!snapshot) return null;
      const changes = await repository.readChanges(ctx.env, effect.snapshotId);
      if (!changes.ok) return null;
      if (!changes.removed.length) return 'removal:none:' + snapshot.scanId;
      const previousId = await repository.snapshotIdOfVersion(ctx.env, snapshot.prevVersion);
      if (!previousId.ok) return null;
      const previous = await repository.readSnapshot(ctx.env, previousId.snapshotId);
      if (!previous.ok) return null;
      const byLid = new Map(previous.snapshot.films.map(film => [film.lid, film]));
      const films = changes.removed.map(item => byLid.get(item.lid)).filter(Boolean).map(film => ({id: film.lid, url: film.url}));
      if (films.length !== changes.removed.length) return null;
      const ref = await removalRef(ctx.env, snapshot);
      if (!ref) return null;
      await removal.enqueue(writeEnv(ctx), films, ref);
      // An id removed before its Film was resolved is not retried any more (`superseded`); a returning id reopens through a later promotion. Part of this effect, so a failure holds it.
      if (typeof repository.supersedeAdmissions === 'function' && typeof epochGuard === 'function') {
        const superseded = await repository.supersedeAdmissions(ctx.env, {lids: changes.removed.map(item => item.lid), now: ctx.now()}, {guards: [epochGuard(ctx.epoch)]});
        if (!superseded.ok) return null;
      }
      return 'removal:' + snapshot.scanId + ':' + films.length;
    }
  };
}
