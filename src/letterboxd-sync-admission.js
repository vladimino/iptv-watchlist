// AIR-570 / ADR 0186 decision 5, AIR-599 / ADR 0207 decision 4b. The bounded admission step for the Letterboxd ids a promoted snapshot added: each due row of the durable ledger
// (`watchlist_admission_pending`) is resolved with the existing same-run identity check (ADR 0166 generalized to Watchlist ids: the Letterboxd film page and the TMDB movie must agree, only a
// unanimous result admits a Film, a title or year alone never does), at most three per step, oldest first-seen version first (the queue position, never changed by a retry).
// AIR-599: ONE retry policy for both callers of the check. The check returns an explicit outcome for every id; this step charges nothing itself. The attempt count lives only in the shared Diary
// entry: the ledger COPIES the entry's `attempts` and next retry time from the outcome (idempotent, so a restart between the check and the settle charges nothing twice). A row ends only when it is
// resolved, superseded (the id left the Watchlist) or at the attempt cap (`terminal`, visible, it waits for the owner). Age no longer ends a row: a row pending longer than AGE_REPORT_MS is REPORTED
// (`overdue`), not terminated. The membership is never rolled back by an admission failure. Collaborators are injected: the ledger repository and the identity bridge.
// AIR-673 / ADR 0217 decision 9: the typed `resolvedBy` of a Watchlist id admitted as a lid-only Film.
export const LID_ONLY_RESOLVED_BY = 'identity:lid_only';
export const STEP_LIMIT = 3;
// AIR-599: the age at which a pending row is reported (run record, Monitor). It is not a terminal rule any more.
export const AGE_REPORT_MS = 14 * 24 * 3600000;
const SLUG = /^https:\/\/letterboxd\.com\/film\/([a-z0-9-]{1,200})\/$/;
const emptyCounts = () => ({checked: 0, transport: 0, notNow: 0, gone: 0, definite: 0, atCap: 0, capRefused: 0, backlogFull: 0, resolved: 0, overdue: 0, overdueUnknown: 0, rowChanged: 0});

export function admissionStep({repository, identity, epochGuard, fenceEnv = env => env}) {
  return async (ctx, {limit = STEP_LIMIT, now = ctx.now()} = {}) => {
    const guards = typeof epochGuard === 'function' && Number.isInteger(ctx?.epoch) ? [epochGuard(ctx.epoch)] : null;
    if (!guards) return {resolved: 0, pending: null, terminal: 0, error: 'epoch_guard_absent'};
    const due = await repository.dueAdmissions(ctx.env, {now, limit: Math.min(limit, STEP_LIMIT), overdueBefore: new Date(now - AGE_REPORT_MS).toISOString()});
    if (!due.ok) return {resolved: 0, pending: null, terminal: 0, error: 'ledger_unreadable'};
    const counts = emptyCounts();
    counts.overdue = Number(due.overdue) || 0;
    counts.overdueUnknown = Number(due.overdueUnknown) || 0;
    if (!due.rows.length) return {resolved: 0, pending: due.pending ?? 0, terminal: 0, counts};
    // The film slug of each id comes from the Watchlist itself, never from a title: the snapshot that first listed the id (its member URL), else the CURRENT snapshot's member of the same id (the first one may be pruned),
    // else the slug the shared entry already holds (resolve falls back to it). A read that FAILS is unavailable evidence, not absence: that row is left due and unchanged this step (no attempt); only an answered read that
    // has no slug anywhere lets the check record `slug_missing`.
    const items = [], unreadable = {}, needCurrent = [];
    const cache = new Map();
    for (const row of due.rows) {
      let snapshot = cache.get(row.firstSeenSnapshotId);
      if (snapshot === undefined) { const read = await repository.readSnapshot(ctx.env, row.firstSeenSnapshotId); snapshot = read.ok ? read.snapshot : read.reason === 'unavailable' ? 'unavailable' : null; cache.set(row.firstSeenSnapshotId, snapshot); }
      const member = snapshot && snapshot !== 'unavailable' ? snapshot.films.find(film => film.lid === row.lid) : null;
      const slug = member ? SLUG.exec(member.url)?.[1] ?? null : null;
      // The guard of the row's token (see `admissionRowGuard`): every write of the shared document that applies this row's budget carries it, so an owner action between this read and that write voids the stale seed.
      const guard = typeof repository.admissionRowGuard === 'function' ? repository.admissionRowGuard({lid: row.lid, attempts: row.attempts, updatedAt: row.updatedAt}) : null;
      const item = {lid: row.lid, slug, attempts: row.attempts, reason: row.lastReason ?? null, ...(guard ? {guard} : {}), ...(row.firstSeenAt ? {queuedAt: row.firstSeenAt} : {})};
      if (!slug) needCurrent.push(item);
      items.push(item);
      if (snapshot === 'unavailable' && !slug) unreadable[row.lid] = true;
    }
    if (needCurrent.length && typeof repository.currentMemberUrls === 'function') {
      const current = await repository.currentMemberUrls(ctx.env, needCurrent.map(item => item.lid));
      for (const item of needCurrent) {
        if (!current.ok) { unreadable[item.lid] = true; continue; }
        unreadable[item.lid] = false;
        const slug = current.urls.has(item.lid) ? SLUG.exec(current.urls.get(item.lid))?.[1] ?? null : null;
        if (slug) item.slug = slug;
      }
    }
    const offered = items.filter(item => unreadable[item.lid] !== true);
    counts.notNow += items.length - offered.length;
    if (!offered.length) return {resolved: 0, pending: due.pending ?? 0, terminal: 0, counts};
    let out;
    try { out = await identity.resolve(fenceEnv(ctx.env, ctx.epoch), offered, {clock: ctx.now, remaining: () => Math.max(0, ctx.deadline - ctx.now()), route: 'watchlist_admission'}); }
    catch { return {resolved: 0, pending: due.pending, terminal: 0, error: 'identity_check_failed', counts}; }
    for (const key of ['capRefused', 'backlogFull']) counts[key] += Number(out?.counts?.[key]) || 0;
    const links = await identity.diaryLinks(ctx.env, offered.map(item => item.lid)).catch(() => new Map());
    // Every settle carries the row's token as read with the due list (AIR-599, review of PR #1009): a row an owner requeued or dismissed since cannot be overwritten by the outcome of a check that started before.
    // AIR-602 (review of PR #1018): a terminal or charged outcome of the check was written against an operation history; its settlement here carries that history's guard IN the ledger batch, so an attempt that
    // reserved or applied under the key between the check's own write and this settlement refuses it (the row keeps its token and is read again).
    const settle = (row, fields, historyGuard = null) => repository.settleAdmission(ctx.env, {lid: row.lid, now, ...fields, expect: {attempts: row.attempts, updatedAt: row.updatedAt}}, {guards: historyGuard ? [...guards, historyGuard] : guards});
    let resolved = 0, terminal = 0;
    for (const row of due.rows) {
      if (unreadable[row.lid] === true) continue;
      const outcome = out?.outcomes instanceof Map ? out.outcomes.get(row.lid) : null;
      const tmdb = links.get(row.lid)?.tmdb;
      if (outcome?.checked) counts.checked++;
      if (out?.labels?.has(row.lid) || tmdb || (outcome?.class === 'settled' && outcome.reason !== 'owner_dismissed')) {
        // Verified now, or already linked by another writer's receipt: resolved without a second write.
        // AIR-673 / ADR 0217 decision 9: a lid-only Film (a label with `lidOnly` and no TMDB movie, no linked alias) is a typed success of its own. Settlement accepts it in addition to "label or TMDB link"; it
        // never invents a TMDB alias and never writes a receipt of its own (the coordinator's `present_lid_only` settles only).
        const label = out?.labels?.get?.(row.lid);
        const by = (label?.lidOnly === true && !tmdb ? LID_ONLY_RESOLVED_BY : 'identity:' + (tmdb || 'verified')).slice(0, 200);
        const done = await settle(row, {state: 'resolved', attempts: row.attempts, resolvedBy: by});
        if (done.ok) { resolved++; counts.resolved++; } else if (done.reason === 'conflict') counts.rowChanged++;
        continue;
      }
      if (outcome?.reason === 'owner_dismissed') {
        const done = await settle(row, {state: 'terminal', attempts: row.attempts, reason: 'owner_dismissed'});
        if (done.ok) terminal++; else if (done.reason === 'conflict') counts.rowChanged++;
        continue;
      }
      // No outcome, or one without a count (not reached, document unreadable): the row stays due and unchanged; no attempt.
      if (!outcome || !Number.isInteger(outcome.attempts)) { counts.notNow++; continue; }
      const cls = outcome.class === 'intent' ? 'not_now' : outcome.class;
      counts[cls === 'not_now' ? 'notNow' : cls] = (counts[cls === 'not_now' ? 'notNow' : cls] || 0) + 1;
      // The shared count, copied (never added to). At the cap the row is terminal and visible; it waits for the owner.
      // The shared count, but never below the row's own: a row that already holds attempts (a legacy row, or an id the other caller materialized without it) keeps them. An owner requeue resets the row AND the entry.
      const attempts = Math.max(outcome.attempts, row.attempts);
      const exhausted = attempts >= identity.MAX_ATTEMPTS;
      if (exhausted) counts.atCap++;
      const reason = String(outcome.reason || 'unresolved');
      const retryAt = typeof outcome.retryAt === 'string' && Number.isFinite(Date.parse(outcome.retryAt)) && Date.parse(outcome.retryAt) > now ? outcome.retryAt : null;
      const result = await settle(row, exhausted ? {state: 'terminal', attempts, reason} : {state: 'pending', attempts, reason, nextRetryAt: retryAt}, Array.isArray(outcome.historyGuard) ? outcome.historyGuard : null);
      if (result.ok && exhausted && !result.already) terminal++;
      else if (!result.ok && result.reason === 'conflict') counts.rowChanged++; // an owner action changed the row since the due list was read: the owner's decision stands
    }
    return {resolved, pending: Math.max(0, (due.pending ?? 0) - resolved - terminal), terminal, counts};
  };
}
