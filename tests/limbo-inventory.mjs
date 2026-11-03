import assert from 'node:assert/strict';
import fs from 'node:fs';
import {evaluateDataHealth} from '../src/domain/data-health.js';
import {
  LIMBO_CAUSES, LIMBO_KINDS, LIMBO_SUBSYSTEMS, filterLimboItems, limboCause, limboContext, limboCounts, limboFilmDelta, limboFilmStates, limboFilter, limboItems, pageLimboItems,
} from '../src/domain/limbo-inventory.js';

// Pure and offline: no storage, network or clock of its own.
const source = fs.readFileSync('src/domain/limbo-inventory.js', 'utf8');
assert.doesNotMatch(source, /\bfetch\b|BUCKET|cloudflare:|node:|\bimport\b|\brequire\(|Date\.now|new Date\(|Math\.random/);
assert.match(fs.readFileSync('build.mjs', 'utf8'), /scoped\('src\/domain\/limbo-inventory\.js','LimboInventory'\)/);

const NOW = '2026-10-30T12:00:00.000Z', H = 3600000, D = 86400000;
const at = ms => new Date(Date.parse(NOW) + ms).toISOString();
const film = (id, fields) => ({id, programmeRunId: 'g1', observedAt: NOW, storedId: id.slice(5), preferred: 'Title ' + id, year: 2020, identity: {status: 'resolved'}, metadata: {status: 'fresh'}, localizationConflicts: [], externalIds: [{scheme: 'tmdb', value: '1', trusted: true}], ...fields});
const health = films => evaluateDataHealth({now: NOW, published: {programmeRunId: 'g1', phase: 'published', publishedAt: at(-H), observedAt: NOW}, coverage: {films: 'partial'}, films, predictionQueue: {observedAt: NOW, programmeRunId: 'g1', hotPending: ['film:queued'], coldPending: [], retries: {'film:queued': {attempts: 1, retryAt: Date.parse(NOW) + 2 * H}}, lastCheckAt: at(-H)}});

// 1. Causes, one per issue, from the health model's facts.
const films = [
  film('film:ok'),
  film('film:stalled', {identity: {status: 'unresolved', updatedAt: at(-20 * D), nextAction: 'wait_new_evidence'}}),
  film('film:due', {identity: {status: 'unresolved', retryAt: at(-H), updatedAt: at(-D)}}),
  film('film:wait', {identity: {status: 'unresolved', retryAt: at(D), updatedAt: at(-D)}}),
  film('film:recent', {identity: {status: 'unresolved', updatedAt: at(-H), nextAction: 'wait_new_evidence'}}),
  film('film:conflict', {identity: {status: 'ambiguous'}, externalIds: [{scheme: 'tmdb', value: '1', conflicting: true}, {scheme: 'tmdb', value: '2', conflicting: true}]}),
  film('film:old', {programmeRunId: 'g0', metadata: {status: 'missing'}}),
  film('film:nodate', {identity: {status: 'unresolved', nextAction: 'wait_new_evidence'}}),
  film('film:rejected', {identity: {status: 'rejected', updatedAt: at(-D)}}),
  film('film:queued', {prediction: {status: 'failed', updatedAt: at(-H)}}),
  film('film:poster', {poster: null}),
];
const evaluation = health(films);
const items = limboItems(evaluation, {films});
const cause = id => items.find(item => item.id === id)?.cause;
assert.equal(cause('identity/stuck/film:film:stalled'), 'stalled');
assert.equal(cause('identity/incomplete/film:film:due'), 'retry_eligible');
assert.equal(cause('identity/incomplete/film:film:wait'), 'backoff');
assert.equal(cause('identity/incomplete/film:film:recent'), 'pending');
assert.equal(cause('identity/conflict/film:film:conflict'), 'manual_review');
assert.equal(cause('metadata/incomplete/film:film:old'), 'stale_projection');
assert.equal(cause('identity/incomplete/film:film:nodate'), 'unknown');
assert.equal(cause('identity/incomplete/film:film:rejected'), 'manual_review', 'a terminal decision needs a person');
assert.equal(cause('prediction/incomplete/film:film:queued'), 'backoff');
assert.equal(items.some(item => item.subjectId === 'film:ok'), false, 'a healthy film is not in limbo');
assert.equal(items.some(item => item.subsystem === 'poster'), false, 'a missing poster is an asset, not limbo');
assert.equal(limboCause({category: 'external_refresh', action: {}, progress: {}, evidence: {}}), 'external_archive');
assert.equal(limboCause({category: 'incomplete', action: {eligible: null}, progress: {status: 'progressing'}, evidence: {completeness: 'partial'}}), 'unknown', 'eligibility the evidence cannot decide is unknown');
assert.equal(limboCause({}), 'unknown');
for (const item of items) {
  assert(LIMBO_CAUSES.includes(item.cause), item.cause);
  assert(LIMBO_KINDS.includes(item.kind), item.kind);
  assert(LIMBO_SUBSYSTEMS.includes(item.subsystem), item.subsystem);
}
// The order is the health model's order; items are complete copies of what an owner needs to see.
assert.deepEqual(items.map(item => item.id), evaluation.issues.filter(issue => issue.subject.kind === 'film' && LIMBO_SUBSYSTEMS.includes(issue.subsystem)).map(issue => issue.id));
const stalled = items.find(item => item.id === 'identity/stuck/film:film:stalled');
assert.deepEqual(stalled.age, {ms: 20 * D, days: 20, lastProgressAt: at(-20 * D), basis: 'progress'});
assert.deepEqual(stalled.film, {id: 'film:stalled', storedId: 'stalled', title: 'Title film:stalled', year: 2020, inProgramme: true, identity: {status: 'unresolved', canonicalIdentity: null, trustedExternalIds: ['tmdb:1'], conflicting: false}});
assert.equal(stalled.links.film, '/admin?kind=film&id=film%3Astalled');
assert.equal(stalled.diagnostics.nextAction, 'wait_new_evidence');
assert.equal(stalled.evidence.observedAt, NOW);
assert.equal(items.find(item => item.id === 'identity/incomplete/film:film:nodate').age.ms, null);
// A film issue without a record still yields an item, with no title claimed.
const bare = limboItems(evaluation, {films: []}).find(item => item.id === 'identity/stuck/film:film:stalled');
assert.deepEqual([bare.film.title, bare.film.storedId, bare.film.inProgramme, bare.film.identity, bare.links.film, bare.links.filmUnavailable], [null, null, false, null, null, 'record_not_observed']);
const outside = limboItems(evaluation, {films: films.map(record => record.id === 'film:stalled' ? {...record, inProgramme: false} : record)}).find(item => item.id === 'identity/stuck/film:film:stalled');
assert.deepEqual([outside.links.film, outside.links.filmUnavailable], [null, 'not_in_programme'], 'a record outside the programme gets no catalogue link');
// Observations are items of their own kind, never Films.
const observed = evaluateDataHealth({now: NOW, observations: [{key: 'title|2001', status: 'needs_verification', attempts: 2, retryAt: at(D), lastAttemptAt: at(-D)}]});
const observation = limboItems(observed, {}).find(item => item.kind === 'observation');
assert.deepEqual([observation.subjectId, observation.cause, observation.film, observation.links.film, observation.links.filmUnavailable], ['title|2001', 'backoff', null, null, 'observation']);

// 2. Context: whole-object issues and unread subsystems, never film items.
const context = limboContext(evaluation);
assert.ok(context.issues.every(issue => ['generation', 'queue', 'continuation', 'catalog', 'archive'].includes(issue.subject.kind)));
assert.deepEqual(context.unread.map(entry => entry.subsystem), ['discovery', 'letterboxd_archive']);
assert.deepEqual(limboContext(null), {issues: [], unread: []});

// 3. Counts over the whole inventory.
const counts = limboCounts(items);
assert.equal(counts.total, items.length);
assert.equal(Object.values(counts.byCause).reduce((sum, value) => sum + value, 0), items.length);
assert.equal(counts.byKind.film, items.length);

// 4. Filters are validated; an age filter keeps unknown ages; nothing unknown is "everything".
assert.deepEqual(limboFilter({cause: 'nope'}), {error: 'unknown_cause'});
assert.deepEqual(limboFilter({subsystem: 'poster'}), {error: 'unknown_subsystem'});
assert.deepEqual(limboFilter({kind: 'person'}), {error: 'unknown_kind'});
for (const value of [-1, 366, 1.5, '3']) assert.deepEqual(limboFilter({minAgeDays: value}), {error: 'invalid_age'}, String(value));
assert.equal(limboFilter({}).key, '|||');
assert.notEqual(limboFilter({cause: 'stalled'}).key, limboFilter({subsystem: 'identity'}).key);
const old = filterLimboItems(items, {minAgeDays: 14});
assert.ok(old.items.some(item => item.id === 'identity/stuck/film:film:stalled'));
assert.ok(old.items.some(item => item.id === 'identity/incomplete/film:film:nodate'), 'a missing clock never proves youth');
assert.equal(old.items.some(item => item.id === 'identity/incomplete/film:film:recent'), false);
assert.deepEqual(filterLimboItems(items, {cause: 'backoff', subsystem: 'identity'}).items.map(item => item.subjectId), ['film:wait']);
assert.deepEqual(filterLimboItems(items, {kind: 'observation'}).items, []);
assert.deepEqual(filterLimboItems(items, {cause: 'nope'}), {error: 'unknown_cause'});
assert.deepEqual(limboFilter({cause: 'stalled', causes: ['backoff']}), {error: 'conflicting_cause'});
assert.deepEqual(limboFilter({causes: ['nope']}), {error: 'unknown_cause'});
assert.deepEqual(limboFilter({attention: 'later'}), {error: 'unknown_attention'});
assert.equal(limboFilter({attention: 'all'}).key, '|||');
assert.equal(limboFilter({attention: 'now'}).key, '|||@now');
assert.equal(limboFilter({causes: []}).key, '|||~');
assert.equal(limboFilter({causes: ['manual_review', 'stalled']}).key, '|||~manual_review,stalled');
assert.deepEqual(filterLimboItems(items, {causes: []}).items, []);
const orItems = filterLimboItems(items, {causes: ['backoff', 'stalled']}).items;
assert.ok(orItems.every(item => item.cause === 'backoff' || item.cause === 'stalled'));
assert.deepEqual([...new Set(orItems.map(item => item.cause))].sort(), ['backoff', 'stalled'].filter(cause => items.some(item => item.cause === cause)).sort());
const marked = items.map(item => ({...item, ownerAction: {now: item.cause === 'stalled', checked: true, capability: item.cause === 'stalled' ? 'discovery_reconsider' : null, reason: item.cause === 'stalled' ? 'eligible' : 'not_this_page'}}));
assert.ok(filterLimboItems(marked, {attention: 'now'}).items.every(item => item.ownerAction.now === true));
assert.equal(filterLimboItems(marked, {attention: 'now'}).items.some(item => item.cause !== 'stalled'), false);
assert.equal(filterLimboItems(items, {attention: 'now'}).items.length, 0, 'an item without a confirmed action is not in the attention queue');
assert.equal(filterLimboItems(marked, {}).items.length, marked.length);

// 5. Pages: bounded, deterministic, cursor bound to filter key, limit and list.
assert.deepEqual(pageLimboItems(null, {limit: 5}), {error: 'invalid_items'});
for (const limit of [undefined, 0, 26, 1.5]) assert.deepEqual(pageLimboItems(items, {limit}), {error: 'invalid_limit'}, String(limit));
const walked = [];
let cursor = null, pages = 0;
do {
  const page = pageLimboItems(items, {limit: 2, key: 'k', cursor});
  assert.equal(page.total, items.length);
  walked.push(...page.items.map(item => item.id));
  cursor = page.nextCursor;
  pages++;
} while (cursor);
assert.deepEqual(walked, items.map(item => item.id));
assert.equal(pages, Math.ceil(items.length / 2));
const first = pageLimboItems(items, {limit: 2, key: 'k'});
assert.deepEqual(pageLimboItems(items, {limit: 3, key: 'k', cursor: first.nextCursor}), {error: 'stale_cursor'}, 'another limit');
assert.deepEqual(pageLimboItems(items, {limit: 2, key: 'other', cursor: first.nextCursor}), {error: 'stale_cursor'}, 'another filter');
assert.deepEqual(pageLimboItems(items.slice(1), {limit: 2, key: 'k', cursor: first.nextCursor}), {error: 'stale_cursor'}, 'another list');
assert.deepEqual(pageLimboItems(items, {limit: 2, key: 'k', cursor: 'garbage'}), {error: 'stale_cursor'});
assert.deepEqual(pageLimboItems([], {limit: 25}), {items: [], total: 0, nextCursor: null});

// 6. Determinism: the same evaluation gives the same items; the input is not modified.
const copy = structuredClone(films);
assert.deepEqual(limboItems(health(films), {films}), items);
assert.deepEqual(films, copy);

// 7. Film signatures: one canonical film, not one issue row, and not an observation. Age and a retry clock are not a change.
const filmRow = (id, extra = {}) => ({kind: 'film', subjectId: id, film: {id}, subsystem: 'prediction', cause: 'stalled', category: 'stuck', reason: 'no_progress', progress: {status: 'stalled', retryAt: '2026-11-01T00:00:00.000Z'}, age: {ms: 1, days: 0}, evidence: {observedAt: NOW}, ...extra});
const aged = filmRow('film:a');
const clocked = filmRow('film:a', {age: {ms: 9, days: 9}, progress: {status: 'stalled', retryAt: '2026-12-01T00:00:00.000Z'}, evidence: {observedAt: '2027-01-01T00:00:00.000Z'}});
assert.equal(limboFilmStates([aged]).films[0].signature, limboFilmStates([clocked]).films[0].signature);
const moved = filmRow('film:a', {cause: 'backoff', progress: {status: 'waiting'}});
assert.notEqual(limboFilmStates([aged]).films[0].signature, limboFilmStates([moved]).films[0].signature);
const rows = Array.from({length: 50}, (_, index) => filmRow('film:a', {reason: 'r' + index, subsystem: index % 2 ? 'metadata' : 'prediction'}));
assert.equal(limboFilmStates(rows).count, 1, 'fifty issue rows of one film are one film');
const fifty = Array.from({length: 50}, (_, index) => filmRow('film:' + index));
const fortyNine = fifty.slice(0, 49);
assert.equal(limboFilmStates(fifty).count, 50);
assert.equal(limboFilmStates([]).comparable, true);
assert.equal(limboFilmStates([{kind: 'observation', subjectId: 't|2014', cause: 'manual_review', subsystem: 'identity', progress: {status: 'terminal'}, reason: 'identity_ambiguous'}]).count, 0);
assert.equal(limboFilmStates([{kind: 'film', subjectId: '', film: {id: ''}, subsystem: 'prediction', cause: 'stalled', progress: {status: 'stalled'}, reason: 'x'}]).comparable, false);
const withRun = states => ({...states, programmeRunId: 'g1'});
assert.equal(limboFilmDelta(withRun(limboFilmStates(fortyNine)), withRun(limboFilmStates(fortyNine))).changed, 0);
assert.equal(limboFilmDelta(withRun(limboFilmStates(fortyNine)), withRun(limboFilmStates(fifty))).changed, 1);
assert.equal(limboFilmDelta(withRun(limboFilmStates([])), withRun(limboFilmStates(fifty))).changed, 50);
assert.equal(limboFilmDelta(withRun(limboFilmStates(fifty)), withRun(limboFilmStates([]))).changed, 50);
assert.equal(limboFilmDelta(withRun(limboFilmStates([aged])), withRun(limboFilmStates(rows))).changed, 1);
assert.equal(limboFilmDelta(withRun(limboFilmStates([aged])), {...withRun(limboFilmStates([aged])), programmeRunId: 'g2'}).comparable, false);
assert.equal(limboFilmDelta(withRun(limboFilmStates([aged])), {comparable: false, programmeRunId: 'g1', films: []}).comparable, false);

console.log('Limbo inventory: causes, items, context, counts, filters, pages and determinism passed');
