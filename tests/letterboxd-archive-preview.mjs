// The pure preview module (src/domain/letterboxd-archive-preview.js): the facts it proposes are the baseline import's plan,
// the export time follows the importer's rules, and the answer is bounded and says what it does not know.
import assert from 'node:assert/strict';
import {planItem} from '../scripts/letterboxd-baseline-import.mjs';
import {parseExport} from '../src/letterboxd-export.js';
import {PREVIEW_LIMITS, PREVIEW_OUTCOMES, resolveGeneratedAt, proposedFacts, buildPreview} from '../src/domain/letterboxd-archive-preview.js';

// Every combination of the three files, with and without a watched date and rating.
for (const inWatched of [false, true]) for (const inRatings of [false, true]) for (const inWatchlist of [false, true]) for (const watchedDate of [undefined, '2026-01-01']) {
  if (!inWatched && !inRatings && !inWatchlist) continue;
  const film = {code: 'a1', name: 'A', year: 2000, inWatched, inRatings, inWatchlist, ...(inRatings ? {rating: 3.5} : {}), ...(watchedDate && inWatched ? {watchedDate} : {})};
  const planned = planItem(film, {filmId: 'a1', tmdbId: null});
  assert.deepEqual(proposedFacts(film), {facts: planned.facts, effectiveOn: planned.effectiveOn}, JSON.stringify(film));
}

const NOW = Date.parse('2026-10-31T09:00:00.000Z');
assert.deepEqual(resolveGeneratedAt({named: '2026-10-20T08:15:00.000Z', declared: '', now: NOW}), {generatedAt: '2026-10-20T08:15:00.000Z', source: 'archive_name'});
assert.deepEqual(resolveGeneratedAt({named: null, declared: ' 2026-10-30T07:00:30Z ', now: NOW}), {generatedAt: '2026-10-30T07:00:30.000Z', source: 'owner_declared'});
assert.deepEqual(resolveGeneratedAt({named: '2026-10-20T08:15:00.000Z', declared: '2026-10-20T08:15Z', now: NOW}), {error: 'generated_at_conflict'});
assert.deepEqual(resolveGeneratedAt({named: null, declared: null, now: NOW}), {error: 'generated_at_required'});
for (const declared of ['2026-10-30', '2026-10-30T07:00', '2026-10-30T07:00+01:00', '2026-13-01T00:00Z', 'now']) assert.deepEqual(resolveGeneratedAt({named: null, declared, now: NOW}), {error: 'generated_at_invalid'}, declared);
assert.deepEqual(resolveGeneratedAt({named: null, declared: '2026-10-31T09:01Z', now: NOW}), {error: 'generated_at_future'});
assert.deepEqual(resolveGeneratedAt({named: '2010-12-31T23:59:00.000Z', declared: null, now: NOW}), {error: 'generated_at_too_old'});

// Without a comparison (R2 not read) the answer says so and proposes nothing.
const parsed = parseExport({watched: 'Date,Name,Year,Letterboxd URI\n2026-01-01,A,2000,https://boxd.it/a1\n2026-01-01,,2000,https://boxd.it/a2\n', ratings: null, watchlist: null, diary: null});
const archive = {sha256: 'f'.repeat(64), bytes: 100, entries: 1, ignoredEntries: 0, nameStandard: true, generatedAt: '2026-07-01T00:00:00.000Z', generatedAtSource: 'archive_name', files: {}};
const bare = buildPreview({archive, parsed, comparison: null, now: NOW, archiveStaleMs: 60 * 86400000});
assert.equal(bare.writes, false);
assert.equal(bare.status, 'partial');
assert.deepEqual(bare.completeness, {status: 'partial', missing: ['ratings.csv', 'watchlist.csv', 'diary.csv']});
assert.deepEqual(bare.freshness.reasons, ['archive_stale']);
assert.equal(bare.matching.status, 'unavailable');
assert.equal(bare.proposal.status, 'unavailable');
assert.equal(bare.baseline.status, 'unknown');
assert.deepEqual(bare.baseline.thisArchive, {status: 'not_read', committedAt: null});
assert.deepEqual(bare.details.invalidRows.rows, [{file: 'watched.csv', record: 3, reason: 'missing_name'}]);

// A tie is an overlay on its outcome, and every list is bounded by the detail limit.
{
  const films = Array.from({length: 30}, (_, i) => ({code: 'c' + i, name: 'N' + i, year: 2000, inWatched: true, inRatings: true, inWatchlist: false, rating: 4}));
  const comparison = {
    sources: {programme: {evidence: 'observed'}, metadata: {evidence: 'observed'}, ratingsGeneration: {evidence: 'observed'}, links: {evidence: 'observed'}, filmsListSummary: {evidence: 'observed'}, watchlistSummary: {evidence: 'object_missing'}},
    omitted: {}, consistency: {status: 'stable', changed: []}, receipt: {status: 'absent', committedAt: null}, indexSummary: {}, hypothesis: {verdict: 'supported'},
    matches: films.map(film => ({code: film.code, status: 'accepted', method: 'lid_exact', reason: null, candidates: []})),
    items: films.map((film, i) => ({code: film.code, lid: film.code, tmdb: null, facts: {watched: true, rating: 4}, effectiveOn: {}, state: 'compared', outcomes: [{fact: 'watched', outcome: 'new', tie: false, current: null}, {fact: 'rating', outcome: i === 0 ? 'older' : 'new', tie: i === 0, current: i === 0 ? {value: 3, observedAt: archive.generatedAt, source: 'letterboxd_films_list'} : null}]})),
    recordReads: {limit: 300, needed: 30, done: 30},
  };
  const full = {watched: {present: true, records: 30, valid: 30, invalid: {}, duplicates: 0, conflicts: 0, missingYear: 0}};
  const answer = buildPreview({archive: {...archive, generatedAt: '2026-10-30T00:00:00.000Z'}, parsed: {...parsed, films, files: {watched: full.watched, ratings: full.watched, watchlist: full.watched, diary: full.watched}, invalidRows: []}, comparison, now: NOW, archiveStaleMs: 60 * 86400000});
  assert.deepEqual(Object.keys(answer.proposal.facts), PREVIEW_OUTCOMES);
  assert.equal(answer.proposal.facts.new, 59);
  assert.equal(answer.proposal.facts.older, 1);
  assert.equal(answer.proposal.facts.tie, 1);
  assert.equal(answer.proposal.byFact.rating.tie, 1);
  assert.deepEqual(answer.freshness.reasons, ['ratings_newer_in_r2']);
  assert.equal(answer.details.adds.total, 30);
  assert.equal(answer.details.adds.rows.length, PREVIEW_LIMITS.detailRows);
  assert.equal(answer.details.heldNewer.total, 1);
  assert.equal(answer.status, 'complete');
  assert.equal(answer.matching.status, 'complete', 'a missing scan summary is evidence, not a failure');
}
console.log('letterboxd-archive-preview: ok');
