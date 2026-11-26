// AIR-570 / ADR 0186 decisions 1, 4 and 5. The Watchlist PHASE of a Letterboxd Sync slot: a complete paginated scan with the repeat-first-page
// integrity rule, then one call into the Watchlist repository of AIR-569. The repository is a PORT: this file never touches a Watchlist table, so
// there is no second schema and no second writer. Without a ready repository the phase fails closed (`disabled`, nothing fetched, nothing committed).
//
// Repository contract (AIR-569 implements it; tests use a mock):
//   ready(ctx)                          -> {ready: boolean}
//   drainEffects(ctx, {now})            -> {drained: boolean, code?}   causal effects of promoted snapshots, oldest version first (decision 1)
//   commitScan(ctx, {members, scan})    -> {outcome: 'committed'|'no_change', version, lastSuccessAt, total, baseline, added[], removed[]}   films are {id, title, year, url}
//   recordAttempt(ctx, {outcome, at, slotKey, code})  -> void          `last_attempt_*` only; never lowers last_success_at
//   admitNew(ctx, {limit, now})         -> {resolved, pending}         the bounded admission ledger step (decision 5), optional
//   reconcileMembership(ctx, {now})     -> {processed, settled, ...}   ADR 0203: the bounded membership handoff reconcile against the CURRENT snapshot, optional, never changes the slot outcome
// `ctx` is the phase context ({env, slotKey, runId, epoch, now, deadline}); the repository adapter reads the Workflow epoch from it.
// `fetchPage(url)` returns the page HTML or throws an error with `status` (403, 429, 5xx) for the Letterboxd HTTP outcome; `parse(html)` returns
// {films:[{id,...}], total, next}. Neither is created here: the cutover injects the real ones, tests inject fixtures.
export const MAX_PAGES = 100;
const err = (code, extra = {}) => Object.assign(new Error(code), {code, ...extra});

// A scan is complete only when every page was read, the stated total equals the number of distinct ids, no page is empty with a positive total,
// the pagination URL matches the account path, and a repeat read of page 1 agrees (the rules of `beginSync` today, moved into the phase).
export async function scanWatchlist({fetchPage, parse, firstUrl, username, maxPages = MAX_PAGES}) {
  const members = new Map();
  let url = firstUrl, pages = 0, total = null, firstPage = null;
  const pathPattern = new RegExp('^/' + String(username).replace(/[^a-zA-Z0-9_-]/g, '') + '/watchlist/page/\\d+/$');
  while (url) {
    const page = parse(await fetchPage(url));
    pages++;
    if (pages === 1) firstPage = page.films.map(film => film.id);
    if (pages > maxPages) throw err('incomplete', {reason: 'page_limit'});
    if (!Number.isInteger(page.total)) throw err('incomplete', {reason: 'total_missing'});
    if (total === null) total = page.total;
    if (total !== page.total) throw err('incomplete', {reason: 'total_changed'});
    if (page.films.length === 0 && total > 0) throw err('incomplete', {reason: 'empty_page'});
    for (const film of page.films) {
      if (members.has(film.id)) throw err('incomplete', {reason: 'duplicate'});
      members.set(film.id, film);
    }
    if (page.next && !pathPattern.test(page.next)) throw err('incomplete', {reason: 'pagination_url'});
    url = page.next ? 'https://letterboxd.com' + page.next : null;
  }
  if (members.size !== total) throw err('incomplete', {reason: 'count_mismatch'});
  const list = [...members.values()];
  const repeat = parse(await fetchPage(firstUrl));
  // The repeated first page must equal the original one exactly: the same count and the same ids in the same order (a shortened or empty repeat is a change).
  if (repeat.total !== total || repeat.films.length !== firstPage.length || repeat.films.some((film, index) => film.id !== firstPage[index])) throw err('incomplete', {reason: 'page1_changed'});
  return {members: list, total, pages};
}

// The Letterboxd HTTP outcome of a failed fetch, by class only (no message is stored).
export function classifyScanFailure(error) {
  if (error?.code === 'incomplete') return {outcome: 'incomplete', reason: error.reason || 'incomplete'};
  // AIR-604 (ADR 0211 decision 5): an enforced shared Letterboxd cooldown sent no request. The existing non-charging `rate_limited` outcome, reason `upstream_cooldown`.
  if (error?.code === 'upstream_cooldown') return {outcome: 'rate_limited', reason: 'upstream_cooldown'};
  // `getHTML` reports the HTTP status in its message ("Source HTTP 429: /path"); a typed `status` wins when present. Only the number is read, the message is never stored.
  const typed = Number.isInteger(error?.status) ? error.status : null;
  const parsed = /^Source HTTP (\d{3}):/.exec(String(error?.message || ''));
  const status = typed ?? (parsed ? Number(parsed[1]) : null);
  if (status === 429) return {outcome: 'rate_limited', reason: 'http_429'};
  if (status === 403) return {outcome: 'unavailable', reason: 'http_403'};
  if (Number.isInteger(status) && status >= 500) return {outcome: 'unavailable', reason: 'http_5xx'};
  return {outcome: 'unavailable', reason: 'network_error'};
}

// The phase port for `LetterboxdSync.run`. One call is one whole bounded action: the scan is at most 100 page fetches and a single repository call.
// It never reads Discovery, EPG or resolver state (decision 2). The slot's attempt is made once per run; the next slot is the retry.
export function watchlistPhase({repository, fetchPage, parse, firstUrl, username, describe = null, scanOpen = null}) {
  return {
    // Called by the Workflow once the phase outcome and its time are recorded on the slot: applies the causal effects of the snapshot just promoted (and any older pending one), oldest first, so a removal reaches the
    // Ratings queue in the same run. No Letterboxd request, no scan. -> {drained, code?}
    async afterRecorded(ctx) {
      if (!repository || typeof repository.drainEffects !== 'function') return {drained: false, code: 'repository_absent'};
      return repository.drainEffects(ctx, {now: ctx.now()});
    },
    async run(ctx) {
      const at = () => new Date(ctx.now()).toISOString();
      const ready = repository && typeof repository.ready === 'function' ? await repository.ready(ctx).catch(() => ({ready: false})) : {ready: false};
      if (!ready.ready) return {done: true, outcome: 'disabled', at: at(), reason: 'watchlist_repository_absent'};
      const attempt = async (outcome, code) => { try { await repository.recordAttempt(ctx, {outcome, at: at(), slotKey: ctx.slotKey, code: code ?? null}); } catch { /* the slot Event still reports the outcome */ } };
      // Pending causal effects of earlier versions first, oldest first. A persistent failure is a visible outcome, not a silent skip.
      const drain = await repository.drainEffects(ctx, {now: ctx.now()}).catch(() => ({drained: false, code: 'effects_failed'}));
      if (!drain.drained) { await attempt('error', drain.code || 'effects_pending'); return {done: true, outcome: 'error', at: at(), reason: drain.code || 'effects_pending'}; }
      // AIR-571 D2: in drain mode the effects above are applied but no new scan starts (nothing is fetched, nothing is recorded as an attempt).
      if (typeof scanOpen === 'function') {
        const open = await scanOpen(ctx.env).catch(() => ({open: false}));
        if (open?.open !== true) return {done: true, outcome: 'disabled', at: at(), reason: 'draining'};
      }
      let scanned;
      try { scanned = await scanWatchlist({fetchPage, parse, firstUrl, username}); }
      catch (error) { const failure = classifyScanFailure(error); await attempt(failure.outcome, failure.reason); return {done: true, outcome: failure.outcome, at: at(), reason: failure.reason}; }
      let committed;
      try { committed = await repository.commitScan(ctx, {members: scanned.members, scan: {scanId: ctx.runId + ':watchlist', slotKey: ctx.slotKey, runId: ctx.runId, observedAt: at()}}); }
      catch (error) { await attempt('error', String(error?.code || 'commit_failed').slice(0, 60)); return {done: true, outcome: 'error', at: at(), reason: String(error?.code || 'commit_failed').slice(0, 60)}; }
      // Admission of new ids is a separate, bounded, deduplicated step: its failure never undoes the committed snapshot (decision 5).
      let admission = null;
      if (typeof repository.admitNew === 'function') admission = await repository.admitNew(ctx, {limit: 3, now: ctx.now()}).catch(() => ({resolved: 0, pending: null, error: true}));
      // ADR 0203: the bounded reconcile of the canonical membership handoff ledger against the CURRENT snapshot. After the admission step, optional, and its failure or absence never changes the slot outcome.
      if (typeof repository.reconcileMembership === 'function') await repository.reconcileMembership(ctx, {now: ctx.now()}).catch(() => null);
      // The Event's films: identity (id, title, year, trusted tmdb) and, for a removed film, the confirmed rating the fact store already holds. Stored facts only; a failure leaves the plain films.
      let added = committed.added || [], removed = committed.removed || [];
      if (typeof describe === 'function' && (added.length || removed.length)) {
        try { const described = await describe(ctx.env, {added, removed}); if (Array.isArray(described?.added)) added = described.added; if (Array.isArray(described?.removed)) removed = described.removed; } catch { /* keep the plain films */ }
      }
      const outcome = committed.outcome === 'committed' ? 'committed' : 'no_change';
      return {done: true, outcome, at: at(), snapshotVersion: committed.version ?? null, lastSuccessAt: committed.lastSuccessAt ?? at(), total: committed.total ?? scanned.total, baseline: committed.baseline === true,
        added, removed, addedCount: (committed.added || []).length, removedCount: (committed.removed || []).length, admission};
    }
  };
}
