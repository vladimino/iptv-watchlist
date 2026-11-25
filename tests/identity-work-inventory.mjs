// AIR-527 (ADR 0170): the pure identity work inventory. The negative scenarios of the ADR: a trusted Film only by a D1 admission that
// matches archive AND short code with a typed movie id, same-code and remake rows are separate, hints only between rows of one response,
// verified-without-admission is not resolved, deterministic filters and cursors, and no cross-lane sort.
import assert from 'node:assert/strict';
import * as W from '../src/domain/identity-work-inventory.js';

const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64), NOW = Date.parse('2026-11-18T12:00:00.000Z'), DAY = 86400000;
const q = query => W.identityWorkQuery(new URLSearchParams(query));
const iso = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();
const item = (code, state, extra = {}) => ({code, state, reason: null, name: 'Film ' + code, year: 2001, rating: 4, chunk: 0, observedAt: iso(10), registeredAt: iso(9), ...extra});
const doc = (sha, candidates, stopped = null) => ({schemaVersion: 1, archiveSha256: sha, candidates: Object.fromEntries(candidates.map(entry => [entry.code, entry])), checkpoint: {cursor: null, stopped}});
const admission = (sha, code, extra = {}) => ({film_id: 'tmdb_' + (extra.tmdb ?? '603'), tmdb: '603', source_code: code, archive_sha256: sha, ...extra});
const rowsOf = (d, sha, admissions, retryable = reason => reason === 'tmdb_fetch_failed') => W.candidateRows(d, sha, {nowMs: NOW, admissions, isRetryable: retryable});

// ---- query ----
assert.deepEqual(['unknown_type', 'unknown_disposition', 'unknown_include', 'invalid_archive', 'invalid_query', 'invalid_limit', 'invalid_limit', 'invalid_limit'], [q('type=tv'), q('disposition=done'), q('include=all'), q('archive=' + 'A'.repeat(64)), q('q='), q('limit=0'), q('limit=26'), q('limit=1.5')].map(result => result.error));
{
  const ok = q('');
  assert.equal(ok.limit, 25); assert.equal(ok.includeResolved, false); assert.equal(ok.type, null);
  assert.equal(q('include=resolved').includeResolved, true);
  assert.equal(q('disposition=resolved').includeResolved, true, 'asking for resolved rows shows them');
  assert.equal(q('q=Matrix').key, q('q=matrix&limit=5').key, 'case and limit are not part of the filter key');
  assert.notEqual(q('q=Matrix').key, q('q=Other').key);
  assert.notEqual(q('').key, q('include=resolved').key);
  assert.equal(q('q=MaTrIx').q, 'matrix');
  assert.equal(W.laneEnabled(q('type=film'), 'film'), true); assert.equal(W.laneEnabled(q('type=film'), 'epg_observation'), false);
}

// ---- proof: archive AND code AND typed movie id ----
{
  assert.deepEqual(W.admissionProof([admission(SHA_A, 'Aa1')], SHA_A, 'Aa1'), {filmId: 'tmdb_603', proof: 'film_rated_admission', tmdb: '603'});
  assert.equal(W.admissionProof([admission(SHA_B, 'Aa1')], SHA_A, 'Aa1'), null, 'the same short code from another archive never confirms');
  assert.equal(W.admissionProof([admission(SHA_A, 'Zz9')], SHA_A, 'Aa1'), null, 'another code of the same archive never confirms');
  assert.equal(W.admissionProof([admission(SHA_A, 'Aa1', {tmdb: 'tv:12'})], SHA_A, 'Aa1'), null, 'a tmdb_tv style id is not a movie identity');
  assert.equal(W.admissionProof([{...admission(SHA_A, 'Aa1'), tmdb: '0603'}], SHA_A, 'Aa1'), null);
  assert.equal(W.admissionProof(null, SHA_A, 'Aa1'), null);
}

// ---- candidate rows and the disposition table ----
{
  const d = doc(SHA_A, [item('Aa1', 'verified'), item('Bb2', 'verified'), item('Cc3', 'pending'), item('Dd4', 'admitting'), item('Ee5', 'needs_review', {reason: 'tmdb_fetch_failed'}), item('Ff6', 'needs_review', {reason: 'same_title_year'}), item('Gg7', 'removed', {removedAt: iso(1)})]);
  const rows = rowsOf(d, SHA_A, [admission(SHA_A, 'Aa1')]);
  const by = Object.fromEntries(rows.map(row => [row.shortCode, row]));
  assert.deepEqual(rows.map(row => row.shortCode), ['Aa1', 'Bb2', 'Cc3', 'Dd4', 'Ee5', 'Ff6', 'Gg7'], 'short code order');
  assert.equal(by.Aa1.key, 'lbc:' + SHA_A + ':Aa1');
  assert.deepEqual([by.Aa1.disposition, by.Aa1.film?.filmId, by.Aa1.film?.proof], ['resolved', 'tmdb_603', 'film_rated_admission']);
  assert.deepEqual([by.Bb2.disposition, by.Bb2.reason, by.Bb2.film], ['needs_owner_review', 'admission_unconfirmed', null], 'verified without a matching D1 row is not resolved');
  assert.deepEqual([by.Cc3.disposition, by.Dd4.disposition], ['waiting', 'waiting']);
  assert.deepEqual([by.Ee5.disposition, by.Ee5.status, by.Ee5.reason], ['retryable', 'needs_review', 'tmdb_fetch_failed']);
  assert.deepEqual([by.Ff6.disposition, by.Ff6.reason], ['needs_owner_review', 'same_title_year'], 'the remake reason stays the candidate\'s own and links nothing');
  assert.equal(by.Ff6.film, null);
  assert.equal(by.Gg7.disposition, 'resolved');
  assert.equal(by.Gg7.film, null, 'a removed row has no confirmed Film');
  assert.equal(by.Aa1.ageMs, 10 * DAY);
  assert.deepEqual(by.Aa1.provenance, [{source: 'letterboxd_archive', ref: SHA_A}, {source: 'archive_chunk', ref: '0'}]);
  // D1 unreadable: nothing is confirmed, nothing is called unconfirmed either
  const unread = Object.fromEntries(rowsOf(d, SHA_A, null).map(row => [row.shortCode, row]));
  assert.deepEqual([unread.Aa1.disposition, unread.Aa1.reason, unread.Aa1.film], ['waiting', 'admission_unreadable', null]);
  // a stopped checkpoint blocks unfinished work only
  const stopped = Object.fromEntries(rowsOf(doc(SHA_A, [item('Cc3', 'pending'), item('Ee5', 'needs_review', {reason: 'x'})], {code: 'tmdb_unavailable'}), SHA_A, []).map(row => [row.shortCode, row]));
  assert.deepEqual([stopped.Cc3.disposition, stopped.Cc3.reason, stopped.Ee5.disposition], ['blocked', 'tmdb_unavailable', 'needs_owner_review']);
  // default list excludes resolved; include shows them; a disposition filter is exact
  const keys = query => W.filterRows(rows, q(query)).map(row => row.shortCode);
  assert.deepEqual(keys(''), ['Bb2', 'Cc3', 'Dd4', 'Ee5', 'Ff6']);
  assert.deepEqual(keys('include=resolved'), ['Aa1', 'Bb2', 'Cc3', 'Dd4', 'Ee5', 'Ff6', 'Gg7']);
  assert.deepEqual(keys('disposition=retryable'), ['Ee5']);
  assert.deepEqual(keys('disposition=resolved'), ['Aa1', 'Gg7']);
  assert.deepEqual(keys('q=ee5'), ['Ee5']);
  assert.deepEqual(keys('q=film%20cc3'), ['Cc3']);
}

// ---- two archives with one short code, remakes and hints ----
{
  const rowsA = rowsOf(doc(SHA_A, [item('Aa1', 'pending', {name: 'The Thing', year: 1982}), item('Rm1', 'needs_review', {reason: 'same_title_year', name: 'The Thing', year: 1982})]), SHA_A, []);
  const rowsB = rowsOf(doc(SHA_B, [item('Aa1', 'pending', {name: 'The Thing', year: 1982})]), SHA_B, []);
  const epg = W.observationRows([{kind: 'observation', subjectId: 'the thing|1982', cause: 'pending', reason: 'awaiting', observation: {title: 'The Thing', year: 1982}, age: {ms: 3 * DAY}, evidence: {}}]);
  const alone = W.attachHints(rowsA);
  assert.deepEqual(alone.map(row => row.observedHints), [[], []], 'one archive alone: no hint means "not observed"');
  const both = W.attachHints([...rowsA, ...rowsB, ...epg]);
  const byKey = Object.fromEntries(both.map(row => [row.key, row]));
  assert.equal(byKey['lbc:' + SHA_A + ':Aa1'].key === byKey['lbc:' + SHA_B + ':Aa1'].key, false, 'two archives, two rows');
  assert.deepEqual(byKey['lbc:' + SHA_A + ':Aa1'].observedHints.filter(hint => hint.kind === 'same_short_code'), [{kind: 'same_short_code', trusted: false, ref: 'lbc:' + SHA_B + ':Aa1'}]);
  assert.deepEqual(byKey['lbc:' + SHA_A + ':Rm1'].observedHints.filter(hint => hint.kind === 'same_short_code'), [], 'same title and year inside one archive is no short-code hint');
  const eh = byKey['epg:the thing|1982'].observedHints;
  assert.deepEqual(eh.map(hint => hint.kind), ['title_year_match', 'title_year_match', 'title_year_match']);
  assert.ok(eh.every(hint => hint.trusted === false));
  assert.ok(both.every(row => row.film === null), 'a hint never sets a Film link and merges nothing');
  assert.equal(byKey['lbc:' + SHA_A + ':Aa1'].observedHints.some(hint => hint.ref === 'lbc:' + SHA_A + ':Rm1'), false, 'candidates are not cross-hinted by title');
}

// ---- Film and observation lanes from the Limbo items, unchanged ----
{
  const issue = (id, cause, subsystem, ageMs) => ({kind: 'film', subjectId: id, subsystem, cause, reason: 'r_' + subsystem, film: {id, title: 'T ' + id, year: 2000}, age: {ms: ageMs, lastProgressAt: iso(2)}, evidence: {observedAt: iso(0)}});
  const films = W.filmRows([issue('tmdb_1', 'stalled', 'metadata', 5 * DAY), issue('tmdb_1', 'pending', 'prediction', 9 * DAY), issue('tmdb_2', 'retry_eligible', 'prediction', null), {kind: 'observation', subjectId: 'x'}]);
  assert.deepEqual(films.map(row => row.key), ['film:tmdb_1', 'film:tmdb_2'], 'several issues of one Film are one row');
  assert.equal(films[0].ageMs, 9 * DAY); assert.equal(films[0].source.issues.length, 2); assert.equal(films[0].film.proof, 'canonical_film');
  assert.deepEqual(films.map(row => row.disposition), ['blocked', 'retryable']);
  assert.deepEqual(W.sortLaneRows([films[1], films[0]]).map(row => row.key), ['film:tmdb_1', 'film:tmdb_2'], 'age descending, unknown last');
  const obs = W.observationRows([{kind: 'observation', subjectId: 'k', cause: 'manual_review', reason: 'z', observation: {title: 'A', year: null}, age: {ms: null}, evidence: {}}]);
  assert.deepEqual([obs[0].key, obs[0].disposition, obs[0].film], ['epg:k', 'needs_owner_review', null]);
  assert.equal(W.causeDisposition('nonsense'), 'waiting');
}

// ---- cursor and paging ----
{
  const query = q('limit=2'), base = {key: query.key, limit: 2, pin: 'I1|a|b', nowMs: NOW};
  const encoded = W.encodeCursor({...base, lane: 'film', index: 1, total: 5, id: 'film:x'});
  assert.deepEqual(W.decodeCursor(encoded, {key: query.key, limit: 2}), {pin: 'I1|a|b', nowMs: NOW, cursor: {lane: 'film', index: 1, total: 5, id: 'film:x'}});
  assert.equal(W.decodeCursor(encoded, {key: query.key, limit: 3}).error, 'stale_cursor', 'another limit');
  assert.equal(W.decodeCursor(encoded, {key: q('type=film').key, limit: 2}).error, 'stale_cursor', 'another filter');
  assert.equal(W.decodeCursor(W.encodeCursor({...base, nowMs: undefined, lane: 'film', index: 0, total: 1, id: 'x'}), {key: query.key, limit: 2}).error, 'stale_cursor', 'a cursor without the evaluation clock is refused');
  assert.equal(W.decodeCursor('garbage', {key: query.key, limit: 2}).error, 'stale_cursor');
  assert.equal(W.decodeCursor(W.encodeCursor({...base, lane: 'nope', index: 0, total: 1, id: 'x'}), {key: query.key, limit: 2}).error, 'stale_cursor');
  const cand = W.encodeCursor({...base, lane: 'letterboxd_rated_candidate', sha: SHA_A, after: 'Bb2', etag: 'e1'});
  assert.deepEqual(W.decodeCursor(cand, {key: query.key, limit: 2}).cursor, {lane: 'letterboxd_rated_candidate', sha: SHA_A, after: 'Bb2', etag: 'e1'});
  const start = W.encodeCursor({...base, lane: 'letterboxd_rated_candidate', sha: null, after: '', etag: null});
  assert.equal(W.decodeCursor(start, {key: query.key, limit: 2}).cursor.sha, null);
  assert.equal(W.decodeCursor(W.encodeCursor({...base, lane: 'letterboxd_rated_candidate', sha: 'zz', after: '', etag: null}), {key: query.key, limit: 2}).error, 'stale_cursor');
  const lane = ['a', 'b', 'c', 'd', 'e'].map(key => ({key}));
  const one = W.pageMemoryLane(lane, W.START, 2);
  assert.deepEqual([one.rows.map(row => row.key), one.exhausted, one.last], [['a', 'b'], false, {index: 1, id: 'b', total: 5}]);
  const two = W.pageMemoryLane(lane, {index: 1, total: 5, id: 'b'}, 2);
  assert.deepEqual(two.rows.map(row => row.key), ['c', 'd']);
  const three = W.pageMemoryLane(lane, {index: 3, total: 5, id: 'd'}, 2);
  assert.deepEqual([three.rows.map(row => row.key), three.exhausted], [['e'], true]);
  assert.equal(W.pageMemoryLane(lane, {index: 1, total: 4, id: 'b'}, 2).error, 'stale_cursor', 'the lane moved in length');
  assert.equal(W.pageMemoryLane(lane, {index: 1, total: 5, id: 'zzz'}, 2).error, 'stale_cursor', 'the lane moved in content');
  assert.deepEqual(W.pageMemoryLane([], W.START, 3), {rows: [], exhausted: true, last: null});
  const codes = ['Aa1', 'Bb2', 'Cc3'].map(shortCode => ({shortCode}));
  assert.deepEqual([W.pageCandidateRows(codes, '', 2).rows.map(row => row.shortCode), W.pageCandidateRows(codes, '', 2).exhausted, W.pageCandidateRows(codes, '', 2).last], [['Aa1', 'Bb2'], false, 'Bb2']);
  assert.deepEqual([W.pageCandidateRows(codes, 'Bb2', 2).rows.map(row => row.shortCode), W.pageCandidateRows(codes, 'Bb2', 2).exhausted], [['Cc3'], true]);
  assert.deepEqual(W.pageCandidateRows(codes, 'Cc3', 2), {rows: [], exhausted: true, last: 'Cc3'});
  const served = [...W.pageCandidateRows(codes, '', 2).rows, ...W.pageCandidateRows(codes, 'Bb2', 2).rows].map(row => row.shortCode);
  assert.deepEqual(served, ['Aa1', 'Bb2', 'Cc3'], 'no row is served twice or skipped across a cursor');
}
// ---- the Watchlist admission lane (ADR 0186 decision 5) ----
{
  assert.deepEqual(W.IDENTITY_LANES, ['film', 'epg_observation', 'watchlist_admission', 'diary_identity', 'letterboxd_rated_candidate'], 'the ledger and Diary lanes sit before the archive lane');
  // AIR-599 / ADR 0207 decision 4b: the Diary check entries and the backlog, in queue order, with class, streak and next retry; at the cap the owner decides; a dismissed entry is resolved.
  const NOWD = Date.parse('2026-11-25T12:00:00.000Z');
  const diary = {films: {
    capA: {reason: 'not_found', class: 'gone', attempts: 6, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-20T00:00:00.000Z', nextAttemptAt: '2026-11-22T00:00:00.000Z', slug: 'a'},
    trnB: {reason: 'forbidden', class: 'transport', attempts: 1, streak: 4, queuedAt: '2026-11-02T00:00:00.000Z', lastAttemptAt: '2026-11-25T11:00:00.000Z', nextAttemptAt: '2026-11-25T13:00:00.000Z', slug: 'b'},
    dueC: {reason: 'deferred', class: 'not_now', attempts: 0, streak: 0, queuedAt: '2026-11-03T00:00:00.000Z', lastAttemptAt: null, nextAttemptAt: '2026-11-25T11:00:00.000Z', slug: 'c'},
    disD: {reason: 'owner_dismissed', class: 'settled', attempts: 6, queuedAt: '2026-10-01T00:00:00.000Z', lastAttemptAt: '2026-11-24T00:00:00.000Z', nextAttemptAt: null, slug: 'd'},
  }};
  const backlog = {ids: {bklE: {slug: 'e', queuedAt: '2026-11-04T00:00:00.000Z'}, dueC: {slug: 'c', queuedAt: '2026-11-03T00:00:00.000Z'}}};
  const dRows = W.diaryRows(diary, backlog, {nowMs: NOWD, maxAttempts: 6});
  assert.deepEqual(dRows.map(row => [row.key, row.disposition, row.source.class, row.source.streak]), [
    ['did:disD', 'resolved', 'settled', 0], ['did:capA', 'needs_owner_review', 'needs_owner_review', 0], ['did:trnB', 'waiting', 'transport', 4], ['did:dueC', 'retryable', 'not_now', 0], ['dbl:bklE', 'waiting', 'not_now', 0]],
  'queue order; a backlog id that already has an entry is shown once');
  assert.equal(dRows.at(-1).reason, 'diary_cap');
  const lRows = W.admissionRows([{lid: 'trnB', state: 'pending', attempts: 1, lastReason: 'forbidden', nextRetryAt: '2026-11-25T13:00:00.000Z', updatedAt: 'u', firstSeenVersion: 3}, {lid: 'capA', state: 'terminal', attempts: 6, lastReason: 'not_found'}], {nowMs: NOWD, classify: reason => reason === 'forbidden' ? 'transport' : 'gone', diary});
  assert.deepEqual(lRows.map(row => [row.source.class, row.source.streak, row.source.nextRetryAt]), [['transport', 4, '2026-11-25T13:00:00.000Z'], ['needs_owner_review', 0, null]]);
  assert.deepEqual(lRows[0].source.revision, {state: 'pending', attempts: 1, updatedAt: 'u'}, 'the compare-and-swap token of a ledger row');
  assert.equal(W.laneEnabled(q('type=watchlist_admission'), 'watchlist_admission'), true); assert.equal(W.laneEnabled(q('type=watchlist_admission'), 'film'), false);
  const base = {lid: 'f1', attempts: 2, nextRetryAt: null, lastReason: null, resolvedBy: null, firstSeenSnapshotId: 'snap1', firstSeenVersion: 3, firstSeenAt: iso(2), updatedAt: iso(1), title: 'Heat', year: 1995};
  const d = row => W.admissionDisposition(row, NOW);
  assert.deepEqual(d({...base, state: 'terminal', lastReason: 'age_exceeded'}), {disposition: 'needs_owner_review', reason: 'age_exceeded'});
  assert.deepEqual(d({...base, state: 'terminal'}), {disposition: 'needs_owner_review', reason: 'terminal'});
  assert.equal(d({...base, state: 'pending', nextRetryAt: iso(-1)}).disposition, 'waiting', 'a retry time in the future is waiting');
  assert.equal(d({...base, state: 'pending', nextRetryAt: iso(1)}).disposition, 'retryable');
  assert.equal(d({...base, state: 'pending'}).disposition, 'retryable');
  assert.equal(d({...base, state: 'resolved'}).disposition, 'resolved'); assert.equal(d({...base, state: 'superseded'}).disposition, 'resolved');
  const rows = W.admissionRows([{...base, state: 'terminal', lastReason: 'age_exceeded'}, {lid: '', state: 'pending'}, null], {nowMs: NOW});
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual([row.key, row.type, row.status, row.disposition, row.title, row.year, row.shortCode, row.film], ['wla:f1', 'watchlist_admission', 'terminal', 'needs_owner_review', 'Heat', 1995, 'f1', null], 'no Film link is ever claimed');
  assert.deepEqual(row.provenance, [{source: 'watchlist_snapshot', ref: 'snap1'}]);
  assert.equal(row.ageMs, 2 * DAY);
  // resolved rows are history: hidden unless asked for; the filter and the sort are the shared ones
  const resolved = W.admissionRows([{...base, state: 'resolved'}, {...base, lid: 'f2', state: 'terminal'}], {nowMs: NOW});
  assert.deepEqual(W.filterRows(resolved, q('')).map(r => r.key), ['wla:f2']);
  assert.deepEqual(W.filterRows(resolved, q('include=resolved')).map(r => r.key).sort(), ['wla:f1', 'wla:f2']);
  assert.deepEqual(W.filterRows(resolved, q('disposition=needs_owner_review')).map(r => r.key), ['wla:f2']);
  assert.deepEqual(W.filterRows(resolved, q('q=heat&include=resolved')).length, 2, 'the title is searchable');
  // a cursor of this lane is a memory-lane cursor
  // the ledger lane is a KEYSET lane over a mutable D1 source: (first-seen version, lid) of the last row read plus the authority generation
  const cur = W.encodeCursor({lane: 'watchlist_admission', version: 4, lid: 'f1', gen: 2, key: q('').key, limit: 25, pin: 'I1|x|y', nowMs: NOW});
  assert.deepEqual(W.decodeCursor(cur, {key: q('').key, limit: 25}).cursor, {lane: 'watchlist_admission', version: 4, lid: 'f1', gen: 2});
  const start = W.encodeCursor({lane: 'watchlist_admission', version: -1, lid: '', gen: null, key: q('').key, limit: 25, pin: 'I1|x|y', nowMs: NOW});
  assert.deepEqual(W.decodeCursor(start, {key: q('').key, limit: 25}).cursor, {lane: 'watchlist_admission', version: -1, lid: '', gen: null});
  for (const bad of [{version: 'x', lid: 'a', gen: 1}, {version: 1, lid: 5, gen: 1}, {version: 1, lid: 'a', gen: 'g'}, {version: -2, lid: 'a', gen: 1}]) {
    assert.equal(W.decodeCursor(W.encodeCursor({lane: 'watchlist_admission', ...bad, key: q('').key, limit: 25, pin: 'I1|x|y', nowMs: NOW}), {key: q('').key, limit: 25}).error, 'stale_cursor');
  }
  // the SQL filter a query implies is decided BEFORE any page limit
  assert.deepEqual(['', 'include=resolved', 'disposition=needs_owner_review', 'disposition=waiting', 'disposition=retryable', 'disposition=resolved', 'disposition=blocked'].map(x => W.admissionFilter(q(x))), ['open', 'all', 'owner_review', 'waiting', 'retryable', 'history', 'none']);
  assert.deepEqual(W.admissionRows(null, {nowMs: NOW}), []);
}
console.log('identity-work-inventory: ok');
