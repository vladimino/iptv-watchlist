// The pure preview module (src/domain/letterboxd-archive-preview.js): the facts it proposes are the baseline import's plan,
// the export time follows the importer's rules, and the answer is bounded and says what it does not know.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {planItem} from '../scripts/letterboxd-baseline-import.mjs';
import {parseExport} from '../src/letterboxd-export.js';
import {PREVIEW_LIMITS, PREVIEW_OUTCOMES, resolveGeneratedAt, proposedFacts, buildPreview, factValueKind, summarizeFactValues} from '../src/domain/letterboxd-archive-preview.js';
import {splitBatches} from '../src/domain/letterboxd-archive-apply.js';

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
assert.match(shown.inconclusive, /Сравнение с R2 частичное/);
assert.match(shown.inconclusive, /скачивать новый ZIP не нужно/);
assert.doesNotMatch(shown.inconclusive, /Нужен свежий архив|Архив достаточно свежий|Архив успешно прочитан|archive-callout-ok/);
assert.match(shown.inconclusive, /archive-callout-warn/);
assert.match(shown.verified, /Среди проверенных фильмов архив не устарел/);
assert.match(shown.verified, /Ни одна проверенная оценка не новее этого архива/);
assert.doesNotMatch(shown.verified, /ни одна оценка в R2 не новее|Нужен свежий архив/);
assert.match(shown.fresh, /Нужен свежий архив/);
assert.match(shown.fresh, /оценка в R2 новее этого архива/);
assert.match(shown.fresh, /Сравнение с R2 частичное/);
assert.match(shown.fresh, /только ради этого сообщения скачивать новый ZIP не нужно/);
assert.doesNotMatch(shown.fresh, /Архив достаточно свежий|Среди проверенных фильмов архив не устарел/);
for (const label of ['programme unavailable', 'metadata unavailable']) {
  const html = banner(freshnessOf(oneComparison({sources: label.startsWith('programme') ? {programme: {evidence: 'unavailable'}} : {metadata: {evidence: 'unavailable'}}})));
  assert.match(html, /Сравнение с R2 частичное/, label);
  assert.doesNotMatch(html, /Архив достаточно свежий|Нужен свежий архив|Архив успешно прочитан/, label);
}
{
  const html = banner(freshnessWithFiles({watched: present.watched, ratings: {present: false}, watchlist: present.watched, diary: present.watched}));
  assert.match(html, /Сравнение с R2 частичное/);
  assert.doesNotMatch(html, /Архив достаточно свежий|Нужен свежий архив/);
}

// A replace keeps the commit outcome. The value kind is a projection: equal values, including null, are the same
// observation update; a different value, or a replace with nothing stored, is a changed value.
{
  const current = value => ({value, observedAt: '2026-01-01T00:00:00.000Z', source: 'letterboxd_films_list'});
  assert.equal(factValueKind({outcome: 'replaces', current: current(4)}, 4), 'same');
  assert.equal(factValueKind({outcome: 'replaces', current: current(null)}, null), 'same');
  assert.equal(factValueKind({outcome: 'replaces', current: current(true)}, true), 'same');
  assert.equal(factValueKind({outcome: 'replaces', current: current(3)}, 4), 'changed');
  assert.equal(factValueKind({outcome: 'replaces', current: null}, 4), 'changed');
  assert.equal(factValueKind({outcome: 'replaces'}, null), 'changed');
  assert.equal(factValueKind({outcome: 'new', current: null}, true), 'new');
  assert.equal(factValueKind({outcome: 'unchanged', current: current(true)}, true), 'unchanged');
  assert.equal(factValueKind({outcome: 'older', current: current(5)}, 4), 'older');
  assert.equal(factValueKind({outcome: 'unverified', current: null}, 1), 'unverified');
}

// 281 compared films, 487 same-value replaces (watched 103, rating 103 including null, watchlist 281), plus one
// unread film and one unmatched identity. Counts are facts. Batch sums equal the compared-film totals.
{
  const files = {watched: present.watched, ratings: present.watched, watchlist: present.watched, diary: present.watched};
  const films = [], items = [], matches = [];
  const current = value => ({value, observedAt: '2026-01-01T00:00:00.000Z', source: 'letterboxd_films_list'});
  for (let i = 0; i < 281; i++) {
    const code = 's' + i;
    const rated = i < 103;
    const rating = i < 5 ? null : 4;
    films.push({code, name: 'Same ' + i, year: 2000, inWatched: rated, inRatings: rated, inWatchlist: true, ...(rated ? {rating} : {})});
    const facts = {watchlist: true};
    const outcomes = [{fact: 'watchlist', outcome: 'replaces', tie: false, current: current(true)}];
    if (rated) {
      facts.watched = true;
      facts.rating = rating;
      outcomes.unshift({fact: 'rating', outcome: 'replaces', tie: false, current: current(rating)}, {fact: 'watched', outcome: 'replaces', tie: false, current: current(true)});
    }
    items.push({code, lid: code, tmdb: null, facts, effectiveOn: {}, state: 'compared', outcomes});
    matches.push({code, status: 'accepted', method: 'lid_exact', reason: null, candidates: []});
  }
  films.push({code: 'unread', name: 'Unread', year: 2001, inWatched: true, inRatings: true, inWatchlist: false, rating: 2});
  items.push({code: 'unread', lid: 'unread', tmdb: null, facts: {watched: true, rating: 2}, effectiveOn: {}, state: 'unverified', reason: 'record_read_limit', outcomes: [{fact: 'watched', outcome: 'unverified', tie: false, current: null}, {fact: 'rating', outcome: 'unverified', tie: false, current: null}]});
  matches.push({code: 'unread', status: 'accepted', method: 'lid_exact', reason: null, candidates: []});
  films.push({code: 'lost', name: 'Lost', year: 1999, inWatched: true});
  matches.push({code: 'lost', status: 'unmatched', method: null, reason: 'no_stored_title', candidates: []});
  const comparison = {
    sources: {programme: {evidence: 'observed'}, metadata: {evidence: 'observed'}, ratingsGeneration: {evidence: 'observed'}, links: {evidence: 'observed'}, filmsListSummary: {evidence: 'observed'}, watchlistSummary: {evidence: 'observed'}},
    omitted: {}, consistency: {status: 'stable', changed: []}, receipt: {status: 'absent', committedAt: null}, indexSummary: {}, hypothesis: {verdict: 'supported'},
    matches, items, recordReads: {limit: 300, needed: 282, done: 300},
  };
  const answer = buildPreview({archive: recentArchive, parsed: {...parsed, films, files, invalidRows: [], crossFileMismatches: 0}, comparison, now: NOW, archiveStaleMs: 60 * DAY});
  assert.equal(answer.freshness.verdict, 'inconclusive');
  assert.equal(answer.freshness.needsFreshArchive, false);
  assert.deepEqual(answer.freshness.reasons, ['ratings_unconfirmed']);
  assert.equal(answer.proposal.films.compared, 281);
  assert.equal(answer.proposal.films.unverified, 1);
  assert.equal(answer.proposal.films.heldForIdentity, 1);
  assert.equal(answer.proposal.facts.replaces, 487);
  assert.equal(answer.proposal.values.newValues, 0);
  assert.equal(answer.proposal.values.changedValues, 0);
  assert.equal(answer.proposal.values.sameValueUpdates, 487);
  assert.equal(answer.proposal.values.unchanged, 0);
  assert.equal(answer.proposal.values.byFact.watched.sameValueUpdates, 103);
  assert.equal(answer.proposal.values.byFact.rating.sameValueUpdates, 103);
  assert.equal(answer.proposal.values.byFact.watchlist.sameValueUpdates, 281);
  assert.equal(answer.details.sameValue.total, 281);
  assert.equal(answer.details.updates.total, 0);
  assert.equal(answer.details.adds.total, 0);
  assert.equal(answer.details.sameValue.rows[0].valueKind.rating, 'same');
  assert.equal(answer.details.sameValue.rows[0].facts.rating, null);
  assert.equal(answer.details.unverified.total, 1);
  assert.equal(answer.details.identity.total, 1);
  const chunks = splitBatches(items.filter(item => item.state === 'compared')).map(batch => ({chunk: batch.chunk, films: batch.films.length, planHash: 'ab'.repeat(32), changes: {}, values: summarizeFactValues(batch.films), confirmable: false, reason: null}));
  assert.equal(chunks.length, 6);
  const summed = chunks.reduce((sum, chunk) => sum + chunk.values.sameValueUpdates, 0);
  assert.equal(summed, answer.proposal.values.sameValueUpdates);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.values.newValues + chunk.values.changedValues, 0), 0);
  const html = presentation.archivePreviewHtml({...answer, batches: {size: 50, confirmable: false, reason: null, chunks}});
  assert.match(html, /Архив успешно прочитан: 4\/4 CSV, ошибок нет, создан 1 дн\. назад/);
  assert.match(html, /Сравнение с R2 частичное: проверен 281 из 282 сопоставленных фильма, ещё 1 не проверен из-за лимита чтения/);
  assert.match(html, /только ради этого сообщения скачивать новый ZIP не нужно/);
  assert.match(html, /Ещё 1 фильм архива не сопоставлен и в это сравнение не входит/);
  assert.doesNotMatch(html, /Нужен свежий архив/);
  assert.match(html, /Изменений значений: 0\. Новых значений: 0\. При записи этого архива обновятся 487 наблюдений без изменения оценок, просмотренного и watchlist \(103\/103\/281\)/);
  assert.match(html, /Эти числа — факты среди проверенных фильмов, не весь архив/);
  assert.match(html, /не проверено \(фильмов\)/);
  assert.doesNotMatch(html, /Числа — только проверенные фильмы/);
  assert.match(html, /Пока ничего не записано/);
  assert.doesNotMatch(html, /без изменений: 0|без изменений<\/span>/);
  assert.match(html, /то же значение 487, другое значение 0/);
  const batchSame = [...html.matchAll(/Обновлений наблюдений без смены значения: (\d+)/g)].map(match => Number(match[1]));
  const batchFresh = [...html.matchAll(/Новых или изменённых значений: (\d+)/g)].map(match => Number(match[1]));
  assert.equal(batchSame.length, 6);
  assert.equal(batchSame.reduce((sum, n) => sum + n, 0), 487);
  assert.deepEqual(batchFresh, [0, 0, 0, 0, 0, 0]);
  assert.match(html, /То же значение <small>показано 25 из 281<\/small>/);
  assert.match(html, /значение то же/);
}

// Mixed outcomes on one answer: a same-value replace, a changed value, a replace with no stored value, a true
// unchanged observation, an older fact and a new fact. The machine outcome stays replaces.
{
  const current = value => ({value, observedAt: '2026-01-01T00:00:00.000Z', source: 'letterboxd_films_list'});
  const film = (code, extra) => ({code, name: code, year: 2000, inWatched: true, inRatings: false, inWatchlist: false, ...extra});
  const films = [
    film('mix', {inRatings: true, rating: 4, inWatchlist: true}),
    film('gap'),
    film('keep'),
    film('old', {inWatched: false, inWatchlist: true}),
    film('brand'),
  ];
  const items = [
    {code: 'mix', lid: 'mix', tmdb: null, facts: {watched: true, rating: 4, watchlist: true}, effectiveOn: {}, state: 'compared', outcomes: [
      {fact: 'watched', outcome: 'replaces', tie: false, current: current(true)},
      {fact: 'rating', outcome: 'replaces', tie: false, current: current(3)},
      {fact: 'watchlist', outcome: 'unchanged', tie: false, current: current(true)},
    ]},
    {code: 'gap', lid: 'gap', tmdb: null, facts: {watched: true, rating: null}, effectiveOn: {}, state: 'compared', outcomes: [{fact: 'watched', outcome: 'replaces', tie: false, current: null}, {fact: 'rating', outcome: 'replaces', tie: false, current: current(null)}]},
    {code: 'keep', lid: 'keep', tmdb: null, facts: {watched: true, rating: null}, effectiveOn: {}, state: 'compared', outcomes: [{fact: 'watched', outcome: 'unchanged', tie: false, current: current(true)}]},
    {code: 'old', lid: 'old', tmdb: null, facts: {watchlist: true}, effectiveOn: {}, state: 'compared', outcomes: [{fact: 'watchlist', outcome: 'older', tie: false, current: current(true)}]},
    {code: 'brand', lid: 'brand', tmdb: null, facts: {watched: true, rating: null}, effectiveOn: {}, state: 'compared', outcomes: [{fact: 'watched', outcome: 'new', tie: false, current: null}]},
  ];
  const comparison = {
    sources: {programme: {evidence: 'observed'}, metadata: {evidence: 'observed'}, ratingsGeneration: {evidence: 'observed'}, links: {evidence: 'observed'}, filmsListSummary: {evidence: 'observed'}, watchlistSummary: {evidence: 'observed'}},
    omitted: {}, consistency: {status: 'stable', changed: []}, receipt: {status: 'absent', committedAt: null}, indexSummary: {}, hypothesis: {verdict: 'supported'},
    matches: films.map(entry => ({code: entry.code, status: 'accepted', method: 'lid_exact', reason: null, candidates: []})),
    items, recordReads: {limit: 300, needed: 5, done: 5},
  };
  const files = {watched: present.watched, ratings: present.watched, watchlist: present.watched, diary: present.watched};
  const answer = buildPreview({archive: {...recentArchive, generatedAt: new Date(NOW - 30 * 60 * 1000).toISOString()}, parsed: {...parsed, films, files, invalidRows: [], crossFileMismatches: 0}, comparison, now: NOW, archiveStaleMs: 60 * DAY});
  assert.equal(answer.freshness.verdict, 'verified');
  assert.equal(answer.proposal.values.newValues, 1);
  assert.equal(answer.proposal.values.changedValues, 2);
  assert.equal(answer.proposal.values.sameValueUpdates, 2);
  assert.equal(answer.proposal.values.unchanged, 2);
  assert.equal(answer.proposal.values.older, 1);
  assert.equal(answer.details.updates.total, 2);
  assert.equal(answer.details.sameValue.total, 2);
  assert.equal(answer.details.adds.rows.find(row => row.code === 'brand').valueKind.watched, 'new');
  const mix = answer.details.updates.rows.find(row => row.code === 'mix');
  assert.equal(mix.outcomes.rating, 'replaces');
  assert.equal(mix.valueKind.rating, 'changed');
  assert.equal(mix.valueKind.watched, 'same');
  assert.equal(answer.details.sameValue.rows.find(row => row.code === 'gap').valueKind.rating, 'same');
  assert.equal(answer.details.updates.rows.find(row => row.code === 'gap').valueKind.watched, 'changed');
  const html = presentation.archivePreviewHtml(answer);
  assert.match(html, /Архив успешно прочитан: 4\/4 CSV, ошибок нет, создан менее часа назад/);
  assert.match(html, /Среди проверенных фильмов архив не устарел/);
  assert.doesNotMatch(html, /Нужен свежий архив|Сравнение с R2 частичное/);
  assert.match(html, /Изменений значений: 2\. Новых значений: 1\. При записи этого архива обновятся 2 наблюдения/);
  assert.match(html, /заменит наблюдение, значение другое/);
  assert.match(html, /обновит наблюдение, значение то же/);
  assert.match(html, /Другое значение <small>2<\/small>/);
  assert.match(html, /То же значение <small>2<\/small>/);
}

{
  const stale = presentation.archiveFreshnessHtml({
    freshness: {needsFreshArchive: true, verdict: 'needs_fresh', reasons: ['archive_stale'], archiveStaleMs: 60 * DAY, ageMs: 61 * DAY},
    archive: {ageMs: 61 * DAY},
    export: {files: {watched: {present: true, conflicts: 0}, ratings: {present: true, conflicts: 0}, watchlist: {present: true, conflicts: 0}, diary: {present: true, conflicts: 0}}, invalidRows: 0},
  });
  assert.match(stale, /Архив успешно прочитан: 4\/4 CSV/);
  assert.match(stale, /Нужен свежий архив/);
  assert.match(stale, /больше порога/);
  assert.doesNotMatch(stale, /скачивать новый ZIP не нужно|Сравнение с R2 частичное/);
  assert.match(stale, /archive-callout-ok/);
}

// Count agreement for 1, 2, 5, 11, 21, 22 and 121. 121 follows 21, not 11.
{
  const forms = [
    [1, 'проверен 1 из 1 сопоставленного фильма', 'ещё 1 не проверен', 'обновится 1 наблюдение'],
    [2, 'проверены 2 из 2 сопоставленных фильма', 'ещё 2 не проверены', 'обновятся 2 наблюдения'],
    [5, 'проверено 5 из 5 сопоставленных фильмов', 'ещё 5 не проверено', 'обновятся 5 наблюдений'],
    [11, 'проверено 11 из 11 сопоставленных фильмов', 'ещё 11 не проверено', 'обновятся 11 наблюдений'],
    [21, 'проверен 21 из 21 сопоставленного фильма', 'ещё 21 не проверен', 'обновится 21 наблюдение'],
    [22, 'проверены 22 из 22 сопоставленных фильма', 'ещё 22 не проверены', 'обновятся 22 наблюдения'],
    [121, 'проверен 121 из 121 сопоставленного фильма', 'ещё 121 не проверен', 'обновится 121 наблюдение'],
  ];
  for (const [n, matched, unread, observations] of forms) {
    const coverage = presentation.archiveCoverageHtml({freshness: {verdict: 'inconclusive', reasons: ['ratings_unconfirmed']}, proposal: {films: {compared: n, accepted: n, unverified: n}, recordReads: {limit: 300, needed: n, done: n}}});
    assert.match(coverage, new RegExp(matched + '(?![а-яё])'), String(n));
    assert.match(coverage, new RegExp(unread + '(?![а-яё])'), String(n));
    const paragraph = presentation.archiveValueParagraph({proposal: {values: {changedValues: 0, newValues: 0, sameValueUpdates: n, byFact: {watched: {sameValueUpdates: 0}, rating: {sameValueUpdates: 0}, watchlist: {sameValueUpdates: n}}}, films: {compared: n, unverified: 0}}, export: {films: n}});
    assert.match(paragraph, new RegExp(observations + '(?![а-яё])'), String(n));
  }
}

// The production shape: 0 / 0 / 487 facts beside 121 unread films. The last tile stays a film count.
{
  const html = presentation.archiveSummaryHtml({
    status: 'partial', evaluatedAt: '2026-10-31T09:00:00.000Z', export: {films: 2461},
    proposal: {films: {accepted: 421, compared: 300, unverified: 121}, values: {newValues: 0, changedValues: 0, sameValueUpdates: 487, unchanged: 0, older: 0, unverified: 0, byFact: {watched: {sameValueUpdates: 103}, rating: {sameValueUpdates: 103}, watchlist: {sameValueUpdates: 281}}}},
    details: {unverified: {total: 121, rows: []}},
  });
  assert.match(html, /<b>0<\/b><span>новых значений<\/span>/);
  assert.match(html, /<b>0<\/b><span>изменённых значений<\/span>/);
  assert.match(html, /<b>487<\/b><span>то же значение, новое наблюдение<\/span>/);
  assert.match(html, /<b>121<\/b><span>не проверено \(фильмов\)<\/span>/);
  assert.match(html, /обновятся 487 наблюдений без изменения оценок, просмотренного и watchlist \(103\/103\/281\)/);
  assert.match(html, /Эти числа — факты среди проверенных фильмов, не весь архив/);
  assert.match(html, /«Не проверено \(фильмов\)» считает фильмы/);
  assert.doesNotMatch(html, /<b>0<\/b><span>не проверено/);
  assert.doesNotMatch(html, /Числа — только проверенные фильмы/);
}

{
  const dirty = presentation.archiveZipStatusHtml({
    archive: {ageMs: DAY},
    export: {files: {watched: {present: true, conflicts: 0}, ratings: {present: false}, watchlist: {present: true, conflicts: 1}, diary: {present: true, conflicts: 0}}, invalidRows: 2, crossFileMismatches: 3},
  });
  assert.match(dirty, /archive-callout-warn/);
  assert.doesNotMatch(dirty, /archive-callout-ok|ошибок нет|Архив успешно прочитан/);
  assert.match(dirty, /Архив прочитан: 3\/4 CSV, негодных строк 2, конфликтов CSV 1, расхождений между файлами 3/);
}
console.log('letterboxd-archive-preview: ok');
