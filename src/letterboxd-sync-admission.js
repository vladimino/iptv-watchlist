// AIR-570 / ADR 0186 decision 5. The bounded admission step for the Letterboxd ids a promoted snapshot added: each due row of the durable ledger (`watchlist_admission_pending`) is resolved with the
// existing same-run identity check (ADR 0166 generalized to Watchlist ids: the Letterboxd film page and the TMDB movie must agree, only a unanimous result admits a Film, a title or year alone never does),
// at most three per step. The ledger, not a version diff or a run document, says what is due. Outcomes are exactly: resolved (a verified TMDB identity, or another writer admitted the Film first, so
// there is no second write), still pending with a backoff, or terminal after a bounded number of attempts (it then waits for an owner decision; nothing is guessed). A transport stop (rate limit, forbidden, challenge)
// does not count as an attempt. The membership is never rolled back by an admission failure. Collaborators are injected: the ledger repository and the identity bridge.
export const STEP_LIMIT = 3;
const SLUG = /^https:\/\/letterboxd\.com\/film\/([a-z0-9-]{1,200})\/$/;
// Reasons that mean "not now", not "the source said no": a transport stop, or the bridge deferring the id (budget, the canonical reader not open, facts not durable). None uses up an attempt.
const NOT_NOW = new Set(['forbidden', 'rate_limited', 'challenge', 'timeout', 'fetch_failed', 'oversized', 'tmdb_unavailable', 'deferred', 'unavailable']);
const HOUR = 3600000;

export function admissionStep({repository, identity, epochGuard}) {
  return async (ctx, {limit = STEP_LIMIT, now = ctx.now()} = {}) => {
    const guards = typeof epochGuard === 'function' && Number.isInteger(ctx?.epoch) ? [epochGuard(ctx.epoch)] : null;
    if (!guards) return {resolved: 0, pending: null, terminal: 0, error: 'epoch_guard_absent'};
    const due = await repository.dueAdmissions(ctx.env, {now, limit: Math.min(limit, STEP_LIMIT)});
    if (!due.ok) return {resolved: 0, pending: null, terminal: 0, error: 'ledger_unreadable'};
    if (!due.rows.length) return {resolved: 0, pending: due.pending, terminal: 0};
    // The film slug of each id comes from the snapshot that first listed it (its member URL), never from a title.
    const items = [], slugless = [];
    const cache = new Map();
    for (const row of due.rows) {
      let snapshot = cache.get(row.firstSeenSnapshotId);
      if (snapshot === undefined) { const read = await repository.readSnapshot(ctx.env, row.firstSeenSnapshotId); snapshot = read.ok ? read.snapshot : null; cache.set(row.firstSeenSnapshotId, snapshot); }
      const member = snapshot?.films.find(film => film.lid === row.lid);
      const slug = member ? SLUG.exec(member.url)?.[1] ?? null : null;
      (slug ? items : slugless).push(slug ? {lid: row.lid, slug} : row);
    }
    const settle = (row, fields) => repository.settleAdmission(ctx.env, {lid: row.lid, now, ...fields}, {guards});
    let resolved = 0, terminal = 0, pending = 0;
    for (const row of slugless) {
      const attempts = row.attempts + 1;
      const result = await settle(row, attempts >= identity.MAX_ATTEMPTS ? {state: 'terminal', attempts, reason: 'slug_missing'} : {state: 'pending', attempts, reason: 'slug_missing', nextRetryAt: new Date(now + 12 * HOUR).toISOString()});
      if (result.ok && attempts >= identity.MAX_ATTEMPTS) terminal++; else pending++;
    }
    if (items.length) {
      let out;
      try { out = await identity.resolve(ctx.env, items, {clock: ctx.now, remaining: () => Math.max(0, ctx.deadline - ctx.now())}); }
      catch { return {resolved, pending: due.pending, terminal, error: 'identity_check_failed'}; }
      const stored = await identity.readIdentity(ctx.env).catch(() => ({films: {}}));
      const links = await identity.diaryLinks(ctx.env, items.map(item => item.lid)).catch(() => new Map());
      for (const item of items) {
        const row = due.rows.find(candidate => candidate.lid === item.lid);
        const tmdb = links.get(item.lid)?.tmdb;
        if (out.labels?.has(item.lid) || tmdb) {
          // Verified now, or already linked by another writer's receipt: resolved without a second write.
          const by = ('identity:' + (tmdb || 'verified')).slice(0, 200);
          if ((await settle(row, {state: 'resolved', attempts: row.attempts, resolvedBy: by})).ok) resolved++;
          continue;
        }
        const entry = stored.films?.[item.lid];
        if (!entry) { pending++; continue; } // not reached this step (budget, facts not durable yet): still due, unchanged
        // A "not now" reason does not use up an attempt.
        const attempts = NOT_NOW.has(entry.reason) ? row.attempts : Math.max(row.attempts + 1, Number(entry.attempts) || 0);
        const exhausted = attempts >= identity.MAX_ATTEMPTS;
        const result = await settle(row, exhausted ? {state: 'terminal', attempts, reason: String(entry.reason || 'unresolved')} : {state: 'pending', attempts, reason: String(entry.reason || 'unresolved'), nextRetryAt: entry.nextAttemptAt});
        if (result.ok && exhausted) terminal++; else pending++;
      }
    }
    return {resolved, pending: Math.max(0, (due.pending ?? 0) - resolved - terminal), terminal};
  };
}
