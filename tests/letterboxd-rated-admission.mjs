// Pure rated-archive classification (AIR-340). Synthetic rows only. No storage and no network.
import assert from 'node:assert/strict';
import {TMDB_STATES, admissionFilm, classifyArchive, pageTmdbObservation, tmdbCheckState, classifyRow, movieDetailAgrees, planIdentityRetry, planRegistration, resumePending, retryFingerprint, splitPending, validatedRetryExpected} from '../src/domain/letterboxd-rated-admission.js';
import {transportStop} from '../src/letterboxd-identity.js';

const rated = (code, extra = {}) => ({code, name: extra.name || 'Invented', year: extra.year ?? 2001, inRatings: true, rating: extra.rating ?? 4, ...extra});
const accepted = (code, tmdb = '900001') => ({code, status: 'accepted', method: 'lid_exact', reason: null, tmdbId: tmdb});

assert.equal(classifyRow({code: 'Ww1', inRatings: false}, null).disposition, 'excluded');
assert.equal(classifyRow({code: 'Ww1', inWatched: true, inRatings: false}, {status: 'unmatched'}).reason, 'no_rating');
assert.equal(classifyRow(rated('bad code'), {status: 'unmatched'}).disposition, 'needs_review');
assert.deepEqual(classifyRow(rated('Zz9'), {status: 'unmatched', reason: 'no_stored_title'}), {code: 'Zz9', disposition: 'pending', reason: 'no_stored_title', tmdb: null, historicalTmdb: null, rating: 4, name: 'Invented', year: 2001});
assert.equal(classifyRow(rated('Aa1'), accepted('Aa1', '55')).disposition, 'matched');
assert.equal(classifyRow(rated('Aa1'), accepted('Aa1', '55')).tmdb, '55');
assert.equal(classifyRow(rated('Rm1'), {status: 'ambiguous', reason: 'multiple_targets'}).disposition, 'needs_review');
assert.equal(classifyRow(rated('Ty1'), {status: 'candidate', method: 'title_year', reason: 'identity_unverified'}).reason, 'identity_unverified');
assert.equal(classifyRow(rated('Tv1'), {status: 'accepted', tmdbScheme: 'tmdb_tv', tmdbId: '8'}).reason, 'tmdb_tv');
assert.equal(classifyRow(rated('Old1'), accepted('Old1', '2'), {tmdb: '1'}).reason, 'historical_alias_conflict');
assert.equal(classifyRow(rated('Old1'), accepted('Old1', '2'), {tmdb: '2'}).disposition, 'matched', 'the same historical movie id does not become a conflict');

const archive = classifyArchive({
  films: [rated('Zz9'), rated('Zz9'), rated('Aa1'), rated('Rm1'), {code: 'Ww1', name: 'Seen', year: 1990, inWatched: true}],
  matches: [accepted('Aa1', '55'), {code: 'Rm1', status: 'ambiguous', reason: 'multiple_targets'}, {code: 'Ww1', status: 'unmatched'}],
  historical: {counts: {candidates: 561, ambiguous: 1, unmatched: 1478, total: 2040}, aliases: {Aa1: {tmdb: '9'}}},
});
assert.equal(archive.pending.length, 1);
assert.equal(archive.pending[0].code, 'Zz9');
assert.equal(archive.tally.replay, 1);
assert.equal(archive.tally.excluded, 1);
assert.equal(archive.review.find(row => row.code === 'Aa1').reason, 'historical_alias_conflict');
assert.deepEqual(archive.historicalCountsIgnored, {candidates: 561, ambiguous: 1, unmatched: 1478, total: 2040});
assert.notEqual(archive.pending.length + archive.review.length, 2040);

const stored = {candidates: {Zz9: {code: 'Zz9', state: 'verified', observedAt: '2026-10-01T00:00:00.000Z'}, Keep: {code: 'Keep', state: 'pending', reason: 'unmatched', rating: 4, observedAt: '2026-10-01T00:00:00.000Z'}, Newr: {code: 'Newr', state: 'pending', reason: 'unmatched', rating: 3, observedAt: '2026-11-01T00:00:00.000Z'}}};
const plan = planRegistration(stored, [
  {code: 'Zz9', disposition: 'pending', reason: 'unmatched', rating: 4},
  {code: 'Keep', disposition: 'pending', reason: 'unmatched', rating: 4},
  {code: 'Newr', disposition: 'pending', reason: 'unmatched', rating: 5},
  {code: 'Pend', disposition: 'pending', reason: 'unmatched', rating: 4},
], '2026-10-20T00:00:00.000Z');
assert.deepEqual(plan.keep.sort(), ['Keep', 'Zz9']);
assert.deepEqual(plan.skippedNewer, ['Newr']);
assert.deepEqual(plan.add.map(row => row.code), ['Pend']);
assert.equal(splitPending(archive.pending, 3)[0].chunk, 3);

const stopped = resumePending({cursor: null, stopped: {reason: 'forbidden', code: 'Zz9'}}, {Zz9: {state: 'pending', code: 'Zz9'}, Aa1: {state: 'needs_review', code: 'Aa1'}});
assert.equal(stopped.next, null);
assert.equal(resumePending({cursor: 'Zz9', stopped: null}, {Zz9: {state: 'verified', code: 'Zz9', enrichment: 'done'}, Aa1: {state: 'pending', code: 'Aa1'}}).next, 'Aa1', 'a later chunk before the cursor stays eligible');
assert.equal(resumePending({cursor: 'Zz9', stopped: null}, {Zz9: {state: 'pending', code: 'Zz9'}, Aa1: {state: 'admitting', code: 'Aa1'}}).next, 'Aa1', 'an admitting fence resumes before a new fetch');
assert.equal(resumePending({cursor: 'Zz9', stopped: null}, {Zz9: {state: 'verified', code: 'Zz9', enrichment: 'pending'}}).phase, 'enrich');

assert.equal(movieDetailAgrees({id: 900001, media_type: 'movie', title: 'Invented Alpha', release_date: '2001-06-01'}, '900001', 'Invented Alpha', 2001).ok, true);
assert.equal(movieDetailAgrees({id: 900001, media_type: 'movie', title: 'Invented Alpha', release_date: '2002-01-01'}, '900001', 'Invented Alpha', 2001).ok, true);
assert.equal(movieDetailAgrees({id: 900001, media_type: 'tv', title: 'Invented Alpha', release_date: '2001-01-01'}, '900001', 'Invented Alpha', 2001).reason, 'tmdb_tv');
assert.equal(movieDetailAgrees({id: 8, media_type: 'movie', title: 'Invented Alpha', release_date: '2001-01-01'}, '900001', 'Invented Alpha', 2001).reason, 'detail_id_mismatch');
assert.equal(movieDetailAgrees({id: 900001, media_type: 'movie', title: 'Other', release_date: '2001-01-01'}, '900001', 'Invented Alpha', 2001).reason, 'detail_title_mismatch');
assert.equal(movieDetailAgrees({id: 900001, media_type: 'movie', title: 'Invented Alpha', release_date: '1990-01-01'}, '900001', 'Invented Alpha', 2001).reason, 'detail_year_mismatch');

const film = admissionFilm({tmdb: '900001', sourceCode: 'Zz9', archiveSha256: 'ab'.repeat(32), title: 'Invented Alpha', year: 2001});
assert.equal(film.filmId, 'tmdb_900001');
assert.equal(Object.prototype.hasOwnProperty.call(film, 'watchlist'), false);
assert.equal(admissionFilm({tmdb: 'tv', sourceCode: 'Zz9', archiveSha256: 'ab'.repeat(32)}), null);

const headers = map => ({get: key => map[String(key).toLowerCase()] ?? null});
assert.equal(transportStop(403, headers({}), ''), 'forbidden');
assert.equal(transportStop(429, headers({}), ''), 'rate_limited');
assert.equal(transportStop(200, headers({}), '<title>Just a moment...'), 'challenge');
assert.equal(transportStop(200, headers({}), '<html>film</html>'), null);

const expectOf = item => ({state: item.state, reason: item.reason || null, fingerprint: retryFingerprint(item), observedAt: item.observedAt || null, registeredAt: item.registeredAt || null});
const retryRows = {
  '103U': {code: '103U', state: 'needs_review', reason: 'shortlink_missing', observedAt: '2026-10-20T00:00:00.000Z', registeredAt: '2026-10-20T00:00:01.000Z'},
  '10TQ': {code: '10TQ', state: 'needs_review', reason: 'shortlink_missing', observedAt: '2026-10-20T00:00:00.000Z', registeredAt: '2026-10-20T00:00:01.000Z'},
  Stay: {code: 'Stay', state: 'pending', reason: 'no_stored_title', observedAt: '2026-10-20T00:00:00.000Z', registeredAt: '2026-10-20T00:00:01.000Z'},
  Done: {code: 'Done', state: 'verified', reason: null, observedAt: '2026-10-20T00:00:00.000Z', registeredAt: '2026-10-20T00:00:01.000Z'},
};
const retryPlan = planIdentityRetry({candidates: retryRows}, {codes: ['103U', '10TQ', 'Stay', 'Done'], expected: {
  '103U': expectOf(retryRows['103U']),
  '10TQ': expectOf(retryRows['10TQ']),
  Stay: expectOf(retryRows.Stay),
  Done: expectOf(retryRows.Done),
}});
assert.deepEqual(retryPlan.requeue, ['103U', '10TQ']);
assert.equal(retryPlan.outcomes.find(entry => entry.id === 'Stay').outcome, 'skipped_changed');
assert.equal(retryPlan.outcomes.find(entry => entry.id === 'Done').outcome, 'skipped_changed');
assert.equal(planIdentityRetry({candidates: {}}, {codes: []}).ok, false);
assert.equal(planIdentityRetry({candidates: retryRows}, {codes: ['103U']}).ok, false, 'an empty expected map is not a match');
const stamped = retryRows['103U'];
assert.equal(retryFingerprint(stamped), 'needs_review|shortlink_missing|2026-10-20T00:00:00.000Z|2026-10-20T00:00:01.000Z');
assert.equal(planIdentityRetry({candidates: {'103U': {...stamped, observedAt: '2026-11-01T00:00:00.000Z'}}}, {codes: ['103U'], expected: {'103U': expectOf(stamped)}}).outcomes[0].outcome, 'skipped_changed');
assert.equal(planIdentityRetry({candidates: {'103U': {...stamped, registeredAt: '2026-11-01T00:00:00.000Z'}}}, {codes: ['103U'], expected: {'103U': expectOf(stamped)}}).outcomes[0].outcome, 'skipped_changed');
assert.equal(planIdentityRetry({candidates: {'103U': {code: '103U', state: 'pending', retryOf: 'shortlink_missing', observedAt: stamped.observedAt, registeredAt: stamped.registeredAt}}}, {codes: ['103U'], expected: {'103U': expectOf(stamped)}}).outcomes[0].outcome, 'already_applied');
assert.equal(planIdentityRetry({candidates: {'103U': {code: '103U', state: 'pending', retryOf: 'shortlink_missing', observedAt: '2026-11-01T00:00:00.000Z', registeredAt: stamped.registeredAt}}}, {codes: ['103U'], expected: {'103U': expectOf(stamped)}}).outcomes[0].outcome, 'skipped_changed');
assert.equal(validatedRetryExpected({candidates: retryRows}, ['103U'], {}).ok, false);

// AIR-670 / ADR 0217 decision 3: the typed TMDB states and their outcomes, pure controls. The chain from real fetch answers and the real page parser to the existing retry class is in tests/letterboxd-diary-identity.mjs.
{
  const markup = (ids, types) => '<html><body ' + types.map(type => 'data-tmdb-type="' + type + '"').join(' ') + ' ' + ids.map(id => 'data-tmdb-id="' + id + '"').join(' ') + '></body></html>';
  const evidenceOf = (ids, types) => ({kind: 'page', tmdbIds: ids, tmdbTypes: types, title: 'Invented Alpha', years: [2001]});
  const movie = {id: 900001, media_type: 'movie', title: 'Invented Alpha', release_date: '2001-06-01'};
  const check = (ids, types, detail, extra = {}) => tmdbCheckState({fetched: {html: markup(ids, types)}, evidence: evidenceOf(ids, types), detail, ...extra});
  // only the composition of the page AND an agreeing TMDB document admits; the page alone is the non-admitting `page_movie`
  assert.deepEqual([pageTmdbObservation({html: markup(['900001'], ['movie'])}, evidenceOf(['900001'], ['movie'])).state, pageTmdbObservation({html: markup(['900001'], ['movie'])}, evidenceOf(['900001'], ['movie'])).admits], ['page_movie', false]);
  assert.deepEqual([check(['900001'], ['movie'], undefined).state, check(['900001'], ['movie'], undefined).admits], ['page_movie', false], 'no TMDB document yet: not admitting');
  assert.deepEqual([check(['900001'], ['movie'], {detail: movie}).state, check(['900001'], ['movie'], {detail: movie}).admits, check(['900001'], ['movie'], {detail: movie}).tmdbId], ['tmdb_movie', true, '900001']);
  for (const [label, detail, state, outcome] of [
    ['404', {review: 'tmdb_fetch_failed', status: 404, state: 'tmdb_missing'}, 'tmdb_missing', 'tmdb_contradiction'],
    ['non-transport non-200', {review: 'tmdb_fetch_failed', status: 400}, 'tmdb_failed', 'tmdb_fetch_failed'],
    ['unparseable document', {review: 'tmdb_fetch_failed'}, 'tmdb_failed', 'tmdb_fetch_failed'],
    ['oversized document', {stop: 'oversized'}, 'tmdb_failed', 'tmdb_fetch_failed'],
    ['tv document', {detail: {...movie, media_type: 'tv'}}, 'tmdb_tv', 'tmdb_not_movie'],
    ['title mismatch', {detail: {...movie, title: 'Other'}}, 'tmdb_disagrees', 'detail_title_mismatch'],
    ['id mismatch', {detail: {...movie, id: 8}}, 'tmdb_disagrees', 'detail_id_mismatch'],
    ['no document', null, 'tmdb_failed', 'tmdb_fetch_failed'],
  ]) {
    const out = check(['900001'], ['movie'], detail);
    assert.deepEqual([out.state, out.outcome, out.retryClass, out.admits], [state, outcome, 'definite', false], label);
  }
  // the transport answers of TMDB keep their established class and their cooldown information
  for (const [label, detail, outcome, extra] of [
    ['5xx', {review: 'tmdb_fetch_failed', status: 500, state: 'tmdb_unavailable'}, 'upstream_5xx', {}],
    ['503', {review: 'tmdb_fetch_failed', status: 503}, 'upstream_5xx', {}],
    ['429', {stop: 'rate_limited'}, 'rate_limited', {}],
    ['network', {stop: 'fetch_failed', network: true}, 'network_error', {network: true}],
    ['cooldown', {stop: 'upstream_cooldown', until: 99}, 'upstream_cooldown', {until: 99}],
    ['no token', {stop: 'tmdb_unavailable'}, 'tmdb_unavailable', {}],
  ]) {
    const out = check(['900001'], ['movie'], detail);
    assert.deepEqual([out.state, out.outcome, out.retryClass, out.admits], ['tmdb_unavailable', outcome, 'transport', false], label);
    for (const [key, value] of Object.entries(extra)) assert.equal(out[key], value, label + ' keeps ' + key);
  }
  // a TV marker needs no document; unreadable pages are never admitted and never `tmdb_none`
  assert.deepEqual([check(['900001'], ['tv'], undefined).state, check(['900001'], ['tv'], undefined).outcome], ['tmdb_tv', 'tmdb_not_movie']);
  for (const [label, fetched, evidence] of [
    ['truncated body', {html: markup(['900001'], ['movie']).replace('</html>', '')}, evidenceOf(['900001'], ['movie'])],
    ['empty body', {html: ''}, evidenceOf(['900001'], ['movie'])],
    ['oversized body', {stop: 'oversized'}, null],
    ['unparsable page', {html: markup(['900001'], ['movie'])}, {kind: 'unparsable_page'}],
    ['no evidence', {html: markup(['900001'], ['movie'])}, null],
    ['no id block', {html: markup([], [])}, evidenceOf([], [])],
    ['several ids', {html: markup(['900001', '900002'], ['movie'])}, evidenceOf(['900001', '900002'], ['movie'])],
    ['malformed id hidden by the parser', {html: markup(['900001', 'broken'], ['movie'])}, evidenceOf(['900001'], ['movie'])],
    ['malformed id only', {html: markup(['broken'], ['movie'])}, evidenceOf([], ['movie'])],
    ['id the parser did not see', {html: markup(['900001'], ['movie'])}, evidenceOf(['900002'], ['movie'])],
    ['malformed type hidden by the parser', {html: markup(['900001'], ['movie', '?'])}, evidenceOf(['900001'], ['movie'])],
    ['unreadable type only', {html: markup(['900001'], ['?'])}, evidenceOf(['900001'], [])],
    ['uppercase type', {html: markup(['900001'], ['Movie'])}, evidenceOf(['900001'], [])],
    ['no type marker', {html: markup(['900001'], [])}, evidenceOf(['900001'], [])],
    ['unknown type', {html: markup(['900001'], ['person'])}, evidenceOf(['900001'], ['person'])],
    ['two types', {html: markup(['900001'], ['movie', 'tv'])}, evidenceOf(['900001'], ['movie', 'tv'])],
  ]) {
    const out = tmdbCheckState({fetched, evidence, detail: {detail: movie}});
    assert.deepEqual([out.state, out.outcome, out.retryClass, out.admits], ['tmdb_unreadable', 'page_unreadable', 'definite', false], label);
  }
  // the follow answers that are not a read page keep the classification the live check gives them
  for (const [label, fetched, state, outcome, retryClass] of [
    ['page 503', {review: 'fetch_failed', status: 503}, 'tmdb_unavailable', 'upstream_5xx', 'transport'],
    ['page 404', {review: 'fetch_failed', status: 404}, 'page_not_read', 'not_found', 'gone'],
    ['page 410', {review: 'fetch_failed', status: 410}, 'page_not_read', 'not_found', 'gone'],
    ['page 418', {review: 'fetch_failed', status: 418}, 'page_not_read', 'fetch_failed', 'definite'],
    ['blocked redirect', {review: 'blocked_redirect'}, 'page_not_read', 'blocked_redirect', 'definite'],
    ['challenge', {stop: 'challenge'}, 'tmdb_unavailable', 'challenge', 'transport'],
    ['network', {stop: 'fetch_failed', network: true}, 'tmdb_unavailable', 'network_error', 'transport'],
    ['cooldown', {stop: 'upstream_cooldown', until: 7}, 'tmdb_unavailable', 'upstream_cooldown', 'transport'],
  ]) {
    const out = tmdbCheckState({fetched, evidence: null, detail: {detail: movie}});
    assert.deepEqual([out.state, out.outcome, out.retryClass, out.admits], [state, outcome, retryClass, false], label);
  }
  assert.deepEqual([tmdbCheckState({fetched: {stop: 'upstream_cooldown', until: 7}}).until, tmdbCheckState({fetched: {stop: 'fetch_failed', network: true}}).network], [7, true]);
  // only the composed `tmdb_movie` admits, and no state is ever tmdb_none (the lid-only admission is a later delivery step)
  assert.deepEqual(Object.entries(TMDB_STATES).filter(([, value]) => value.admits).map(([key]) => key), ['tmdb_movie']);
  assert.equal('tmdb_none' in TMDB_STATES, false);
}

console.log('Rated archive admission: pending is this archive, a historical count is not the queue, conflicts stay unmerged, a Film id is the movie id');
