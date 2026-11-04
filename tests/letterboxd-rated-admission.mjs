// Pure rated-archive classification (AIR-340). Synthetic rows only. No storage and no network.
import assert from 'node:assert/strict';
import {admissionFilm, classifyArchive, classifyRow, movieDetailAgrees, planIdentityRetry, planRegistration, resumePending, splitPending} from '../src/domain/letterboxd-rated-admission.js';
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

const retryPlan = planIdentityRetry({
  candidates: {
    '103U': {code: '103U', state: 'needs_review', reason: 'shortlink_missing'},
    '10TQ': {code: '10TQ', state: 'needs_review', reason: 'shortlink_missing'},
    Stay: {code: 'Stay', state: 'pending', reason: 'no_stored_title'},
    Done: {code: 'Done', state: 'verified', reason: null},
  },
}, {codes: ['103U', '10TQ', 'Stay', 'Done'], expected: {
  '103U': {state: 'needs_review', reason: 'shortlink_missing'},
  '10TQ': {state: 'needs_review', reason: 'shortlink_missing'},
  Stay: {state: 'pending', reason: 'no_stored_title'},
  Done: {state: 'verified', reason: null},
}});
assert.deepEqual(retryPlan.requeue, ['103U', '10TQ']);
assert.equal(retryPlan.outcomes.find(entry => entry.id === 'Stay').outcome, 'skipped_changed');
assert.equal(retryPlan.outcomes.find(entry => entry.id === 'Done').outcome, 'skipped_changed');
assert.equal(planIdentityRetry({candidates: {}}, {codes: []}).ok, false);

console.log('Rated archive admission: pending is this archive, a historical count is not the queue, conflicts stay unmerged, a Film id is the movie id');
