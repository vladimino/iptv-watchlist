// The pure preview module (src/domain/letterboxd-archive-preview.js): the facts it proposes are the baseline import's plan,
// the export time follows the importer's rules, and the answer is bounded and says what it does not know.
import fs from 'node:fs';
import vm from 'node:vm';
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
assert.equal(bare.freshness.needsFreshArchive, true);
assert.equal(bare.freshness.verdict, 'needs_fresh');
assert.deepEqual(bare.freshness.reasons, ['archive_stale', 'ratings_unconfirmed']);
assert.equal(bare.freshness.ratingsNewerInR2, undefined);
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
  assert.equal(answer.freshness.needsFreshArchive, true);
  assert.equal(answer.freshness.verdict, 'needs_fresh');
  assert.deepEqual(answer.freshness.reasons, ['ratings_newer_in_r2']);
  assert.equal(answer.details.adds.total, 30);
  assert.equal(answer.details.adds.rows.length, PREVIEW_LIMITS.detailRows);
  assert.equal(answer.details.heldNewer.total, 1);
  assert.equal(answer.status, 'complete');
  assert.equal(answer.matching.status, 'complete', 'a missing scan summary is evidence, not a failure');
}

const DAY = 86400000;
const recentArchive = {...archive, generatedAt: '2026-10-30T00:00:00.000Z'};
const oneFilm = [{code: 'c0', name: 'N', year: 2000, inWatched: true, inRatings: true, inWatchlist: false, rating: 4}];
const present = {watched: {present: true, records: 1, valid: 1, invalid: {}, duplicates: 0, conflicts: 0, missingYear: 0}};
function oneComparison(overrides = {}) {
  return {
    sources: {programme: {evidence: 'observed'}, metadata: {evidence: 'observed'}, ratingsGeneration: {evidence: 'observed'}, links: {evidence: 'observed'}, filmsListSummary: {evidence: 'observed'}, watchlistSummary: {evidence: 'observed'}, ...overrides.sources},
    omitted: {}, consistency: overrides.consistency || {status: 'stable', changed: []}, receipt: {status: 'absent', committedAt: null}, indexSummary: {}, hypothesis: {verdict: 'supported'},
    matches: [{code: 'c0', status: 'accepted', method: 'lid_exact', reason: null, candidates: []}],
    items: [{code: 'c0', lid: 'c0', tmdb: null, facts: {watched: true, rating: 4}, effectiveOn: {}, state: overrides.state || 'compared', reason: overrides.reason || null, outcomes: overrides.outcomes || [{fact: 'watched', outcome: 'unchanged', tie: false, current: null}, {fact: 'rating', outcome: overrides.rating || 'unchanged', tie: false, current: null}]}],
    recordReads: {limit: 300, needed: 1, done: overrides.done ?? 1},
  };
}
function freshnessOf(comparison, generatedAt = recentArchive.generatedAt) {
  return buildPreview({archive: {...recentArchive, generatedAt}, parsed: {...parsed, films: oneFilm, files: {watched: present.watched, ratings: present.watched, watchlist: present.watched, diary: present.watched}, invalidRows: []}, comparison, now: NOW, archiveStaleMs: 60 * DAY}).freshness;
}
for (const [label, comparison] of [
  ['unverified record', oneComparison({state: 'unverified', reason: 'record_read_limit', outcomes: [{fact: 'rating', outcome: 'unverified', tie: false, current: null}]})],
  ['ratings generation unavailable', oneComparison({sources: {ratingsGeneration: {evidence: 'unavailable'}}})],
  ['programme unavailable', oneComparison({sources: {programme: {evidence: 'unavailable'}}})],
  ['metadata unavailable', oneComparison({sources: {metadata: {evidence: 'unavailable'}}})],
  ['scan summary unavailable', oneComparison({sources: {filmsListSummary: {evidence: 'unavailable'}}})],
  ['drift', oneComparison({consistency: {status: 'drift', changed: ['letterboxd/facts/links.json']}})],
]) {
  const freshness = freshnessOf(comparison);
  assert.equal(freshness.needsFreshArchive, false, label);
  assert.equal(freshness.verdict, 'inconclusive', label);
  assert.deepEqual(freshness.reasons, ['ratings_unconfirmed'], label);
}
{
  const provenGap = freshnessOf(oneComparison({state: 'unverified', reason: 'record_unavailable', rating: 'older', outcomes: [{fact: 'rating', outcome: 'older', tie: false, current: {value: 5, observedAt: '2026-10-29T00:00:00.000Z', source: 'letterboxd_films_list'}}]}));
  assert.equal(provenGap.needsFreshArchive, true);
  assert.equal(provenGap.verdict, 'needs_fresh');
  assert.deepEqual(provenGap.reasons, ['ratings_newer_in_r2', 'ratings_unconfirmed']);
}
{
  const provedDespiteGap = freshnessOf(oneComparison({sources: {metadata: {evidence: 'unavailable'}}, outcomes: [{fact: 'rating', outcome: 'older', tie: false, current: {value: 5, observedAt: '2026-10-29T00:00:00.000Z', source: 'letterboxd_films_list'}}]}));
  assert.equal(provedDespiteGap.needsFreshArchive, true);
  assert.equal(provedDespiteGap.verdict, 'needs_fresh');
  assert.deepEqual(provedDespiteGap.reasons, ['ratings_newer_in_r2', 'ratings_unconfirmed']);
}
{
  const absent = freshnessOf(oneComparison({sources: {ratingsGeneration: {evidence: 'object_missing'}}}));
  assert.equal(absent.needsFreshArchive, false);
  assert.equal(absent.verdict, 'verified');
  assert.deepEqual(absent.reasons, []);
}
function freshnessWithFiles(files, generatedAt = recentArchive.generatedAt) {
  return buildPreview({archive: {...recentArchive, generatedAt}, parsed: {...parsed, films: oneFilm, files, invalidRows: []}, comparison: oneComparison(), now: NOW, archiveStaleMs: 60 * DAY}).freshness;
}
{
  const noRatingsFile = freshnessWithFiles({watched: present.watched, ratings: {present: false}, watchlist: present.watched, diary: present.watched});
  assert.equal(noRatingsFile.needsFreshArchive, false);
  assert.equal(noRatingsFile.verdict, 'inconclusive');
  assert.deepEqual(noRatingsFile.reasons, ['ratings_unconfirmed']);
}
{
  const staleNoRatings = freshnessWithFiles({watched: present.watched, ratings: {present: false}, watchlist: present.watched, diary: present.watched}, '2026-07-01T00:00:00.000Z');
  assert.equal(staleNoRatings.needsFreshArchive, true);
  assert.equal(staleNoRatings.verdict, 'needs_fresh');
  assert.deepEqual(staleNoRatings.reasons, ['archive_stale', 'ratings_unconfirmed']);
}
{
  const diaryOnly = freshnessWithFiles({watched: present.watched, ratings: present.watched, watchlist: present.watched, diary: {present: false}});
  assert.equal(diaryOnly.verdict, 'verified');
  assert.deepEqual(diaryOnly.reasons, []);
}
{
  const unread = buildPreview({archive: recentArchive, parsed, comparison: null, now: NOW, archiveStaleMs: 60 * DAY});
  assert.equal(unread.freshness.needsFreshArchive, false);
  assert.equal(unread.freshness.verdict, 'inconclusive');
  assert.deepEqual(unread.freshness.reasons, ['ratings_unconfirmed']);
}

const presentation = vm.createContext({});
vm.runInContext(fs.readFileSync('src/admin/letterboxd-archive-view.js', 'utf8'), presentation);
const banner = freshness => presentation.archiveFreshnessHtml({freshness});
const shown = {
  inconclusive: banner({needsFreshArchive: false, verdict: 'inconclusive', reasons: ['ratings_unconfirmed'], archiveStaleMs: 60 * DAY, ageMs: DAY, ratingsNewerInR2: 0}),
  verified: banner({needsFreshArchive: false, verdict: 'verified', reasons: [], archiveStaleMs: 60 * DAY, ageMs: DAY, ratingsNewerInR2: 0}),
  fresh: banner({needsFreshArchive: true, verdict: 'needs_fresh', reasons: ['ratings_newer_in_r2', 'ratings_unconfirmed'], archiveStaleMs: 60 * DAY, ageMs: DAY, ratingsNewerInR2: 1}),
};
assert.match(shown.inconclusive, /Сравнение неполное, свежесть оценок не подтверждена/);
assert.doesNotMatch(shown.inconclusive, /Нужен свежий архив|Архив достаточно свежий|archive-callout-ok/);
assert.match(shown.inconclusive, /archive-callout-warn/);
assert.match(shown.verified, /Архив достаточно свежий/);
assert.match(shown.verified, /Среди проверенных фильмов ни одна оценка не новее этого архива/);
assert.doesNotMatch(shown.verified, /ни одна оценка в R2 не новее/);
assert.match(shown.fresh, /Нужен свежий архив/);
assert.match(shown.fresh, /оценка в R2 новее этого архива/);
assert.match(shown.fresh, /Остальные оценки не подтверждены/);
assert.doesNotMatch(shown.fresh, /Архив достаточно свежий/);
for (const label of ['programme unavailable', 'metadata unavailable']) {
  const html = banner(freshnessOf(oneComparison({sources: label.startsWith('programme') ? {programme: {evidence: 'unavailable'}} : {metadata: {evidence: 'unavailable'}}})));
  assert.match(html, /Сравнение неполное, свежесть оценок не подтверждена/, label);
  assert.doesNotMatch(html, /Архив достаточно свежий|Нужен свежий архив/, label);
}
{
  const html = banner(freshnessWithFiles({watched: present.watched, ratings: {present: false}, watchlist: present.watched, diary: present.watched}));
  assert.match(html, /Сравнение неполное, свежесть оценок не подтверждена/);
  assert.doesNotMatch(html, /Архив достаточно свежий/);
}
console.log('letterboxd-archive-preview: ok');
