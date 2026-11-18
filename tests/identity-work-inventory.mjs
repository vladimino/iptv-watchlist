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
  const query = q('limit=2'), base = {key: query.key, limit: 2, pin: 'I1|a|b'};
  const encoded = W.encodeCursor({...base, lane: 'film', index: 1, total: 5, id: 'film:x'});
  assert.deepEqual(W.decodeCursor(encoded, {key: query.key, limit: 2}), {pin: 'I1|a|b', cursor: {lane: 'film', index: 1, total: 5, id: 'film:x'}});
  assert.equal(W.decodeCursor(encoded, {key: query.key, limit: 3}).error, 'stale_cursor', 'another limit');
  assert.equal(W.decodeCursor(encoded, {key: q('type=film').key, limit: 2}).error, 'stale_cursor', 'another filter');
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
console.log('identity-work-inventory: ok');
