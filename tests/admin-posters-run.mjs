// The pure run logic of /admin/posters: preview, a confirmation bound to one exact scope for a short time and one run, the
// fresh check before the first call, and the bounded sequence of calls with every stop rule. The route is a stand-in here;
// tests/admin-posters-page.mjs runs the same logic against the real route.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  POSTER_BATCH_MAX, POSTER_CALLS_MAX, POSTER_NO_PROGRESS_MAX, POSTER_CONFIRM_TTL_MS, POSTER_CALL_CHOICES, POSTER_OUTCOME_COPY, POSTER_STOP_COPY, POSTER_PREVIEW_COPY, POSTER_REFUSAL_COPY, POSTER_TERMINAL,
  posterCoverage, posterPreview, posterConfirm, posterBeginRun, runPosterSweep, posterReceiptSummary, posterOutcomeText, posterStopText,
  posterHistoryRead, posterHistoryObserve, posterHistoryRecord, posterResumeCursor,
} from '../src/admin/posters-run.js';

const NOW = Date.parse('2026-10-31T09:00:00.000Z');
const G1 = 'gen-1', G2 = 'gen-2';
const item = (id, tmdbId = id.replace(/\D/g, '') || '1') => ({id, tmdbId, title: 'Фильм ' + id, original: null, year: 2001});
const read = (fields = {}) => ({
  schemaVersion: 1, observedAt: new Date(NOW).toISOString(), programmeRunId: G1, catalogRecords: 40, withPoster: 30, missingPoster: 10, verifiedMissing: 8, unverifiedMissing: 2,
  queue: {cursor: null, limit: 10, items: Array.from({length: 8}, (_, index) => item('f' + index, String(index + 1))), remainingAfterCursor: 8, total: 8},
  unverified: {count: 2, sample: []}, health: {issue: {severity: 'info', reason: 'posters_missing'}, posterBacklogCount: 20}, ...fields,
});

assert.equal(POSTER_BATCH_MAX, 10); assert.equal(POSTER_CALLS_MAX, 30); assert.equal(POSTER_NO_PROGRESS_MAX, 5); assert.equal(POSTER_CONFIRM_TTL_MS, 600000);
assert.equal(Math.max(...POSTER_CALL_CHOICES), POSTER_CALLS_MAX);

// Every outcome literal the route can return has a sentence, and the terminal set matches the route's.
const route = fs.readFileSync('src/discovery.js', 'utf8');
const section = route.slice(route.indexOf('const CATALOG_POSTER_LIMIT'), route.indexOf('async function catalogPosterHydration'));
const hydration = route.slice(route.indexOf('async function catalogPosterHydration'), route.indexOf('finally{await releaseDiscoveryLease(env,lease);}', route.indexOf('async function catalogPosterHydration')));
const literals = new Set([...hydration.matchAll(/outcome:'([a-z_]+)'/g)].map(match => match[1]).filter(code => code !== 'pending'));
for (const code of ['generation_changed', 'lease_lost', 'catalog_changed', 'not_written']) literals.add(code);
for (const match of section.matchAll(/status\[[a-z.]+\]='([a-z_]+)'/g)) if (!['written', 'present', 'changed'].includes(match[1])) literals.add(match[1]);
for (const code of literals) assert.ok(Object.hasOwn(POSTER_OUTCOME_COPY, code), 'no sentence for outcome ' + code);
const terminal = route.match(/CATALOG_POSTER_TERMINAL=new Set\(\[([^\]]+)\]\)/)[1].split(',').map(text => text.trim().slice(1, -1));
assert.deepEqual([...POSTER_TERMINAL].sort(), terminal.sort());
for (const [code, copy] of Object.entries(POSTER_OUTCOME_COPY)) assert.equal(copy.terminal, terminal.includes(code), code);
assert.match(posterOutcomeText('made_up'), /Неизвестный результат/, 'an unknown code is never explained by guesswork');
assert.equal(posterStopText('made_up'), POSTER_STOP_COPY.unknown_result.text);

// 1. Preview.
let preview = posterPreview(read(), {limit: 10, calls: 3, now: NOW});
assert.equal(preview.status, 'eligible');
assert.deepEqual([preview.limit, preview.calls, preview.maxRecords, preview.planned, preview.remaining, preview.items.length, preview.cursor], [10, 3, 30, 8, 8, 8, null]);
assert.ok(preview.scopeKey);
assert.deepEqual([posterPreview(read(), {limit: 25, calls: 31, now: NOW}).limit, posterPreview(read(), {limit: 25, calls: 31, now: NOW}).calls], [10, 1], 'out-of-range choices fall back to the bounded defaults');
assert.equal(posterPreview(read(), {limit: 3, calls: 1, now: NOW}).items.length, 3);
assert.equal(posterPreview(read({missingPoster: 0, verifiedMissing: 0, unverifiedMissing: 0}), {limit: 10, calls: 1, now: NOW}).status, 'nothing');
assert.equal(posterPreview(read({missingPoster: 4, verifiedMissing: 0, unverifiedMissing: 4, queue: {cursor: null, limit: 10, items: [], remainingAfterCursor: 0, total: 0}}), {limit: 10, calls: 1, now: NOW}).status, 'unverified_only');
assert.equal(posterPreview(read({queue: {cursor: 'f9', limit: 10, items: [], remainingAfterCursor: 0, total: 8}}), {limit: 10, calls: 1, now: NOW}).status, 'end_of_queue');
const gated = posterPreview(read(), {limit: 10, calls: 1, retryAt: NOW + 60000, now: NOW});
assert.deepEqual([gated.status, gated.scopeKey, gated.retryAt], ['rate_limited', null, new Date(NOW + 60000).toISOString()]);
assert.equal(posterPreview(read(), {limit: 10, calls: 1, retryAt: NOW - 1, now: NOW}).status, 'eligible', 'a passed retryAt no longer gates');
for (const broken of [null, {}, read({missingPoster: -1}), read({queue: null}), read({verifiedMissing: '8'})]) assert.equal(posterPreview(broken, {limit: 10, calls: 1, now: NOW}).status, 'unknown');
assert.equal(posterPreview(read({queue: {cursor: null, limit: 10, items: [{id: 'x', tmdbId: 'abc'}, item('f1', '2')], remainingAfterCursor: 2, total: 2}}), {limit: 10, calls: 1, now: NOW}).items.length, 1, 'an item without a numeric TMDB id is never in scope');
for (const status of ['eligible', 'nothing', 'unverified_only', 'end_of_queue', 'rate_limited', 'unknown']) assert.ok(POSTER_PREVIEW_COPY[status], status);
assert.equal(posterCoverage(read({health: {issue: {severity: 'warning', reason: 'posters_missing'}, posterBacklogCount: 20}})).backlog, true);

// 2. Confirmation: exact scope, accepted, eligible only.
assert.deepEqual(posterConfirm(preview, {accepted: false, now: NOW}), {ok: false, reason: 'not_accepted'});
assert.deepEqual(posterConfirm(gated, {accepted: true, now: NOW}), {ok: false, reason: 'not_eligible'});
assert.deepEqual(posterConfirm({...preview, coverage: {...preview.coverage, programmeRunId: null}}, {accepted: true, now: NOW}), {ok: false, reason: 'not_eligible'}, 'no confirmation without a generation to fence on');
let confirmed = posterConfirm(preview, {accepted: true, now: NOW});
assert.equal(confirmed.ok, true);
assert.deepEqual([confirmed.confirmation.programmeRunId, confirmed.confirmation.limit, confirmed.confirmation.calls, confirmed.confirmation.cursor, confirmed.confirmation.expiresAt, confirmed.confirmation.consumedAt], [G1, 10, 3, null, new Date(NOW + POSTER_CONFIRM_TTL_MS).toISOString(), null]);
for (const reason of ['not_accepted', 'not_eligible', 'confirmation_expired', 'confirmation_used', 'stale_generation', 'scope_changed', 'read_failed']) assert.ok(POSTER_REFUSAL_COPY[reason], reason);

// 3. The fresh check before the first call.
let begin = posterBeginRun(confirmed.confirmation, read(), {now: NOW + 1000});
assert.equal(begin.ok, true);
assert.ok(begin.confirmation.consumedAt);
assert.equal(posterBeginRun(begin.confirmation, read(), {now: NOW + 2000}).reason, 'confirmation_used', 'one confirmation, one run');
assert.equal(posterBeginRun(confirmed.confirmation, read(), {now: NOW + POSTER_CONFIRM_TTL_MS}).reason, 'confirmation_expired');
assert.equal(posterBeginRun(confirmed.confirmation, read({programmeRunId: G2}), {now: NOW + 1000}).reason, 'stale_generation');
const shifted = read(); shifted.queue.items = shifted.queue.items.slice(1);
assert.equal(posterBeginRun(confirmed.confirmation, shifted, {now: NOW + 1000}).reason, 'scope_changed', 'another first batch than the one confirmed');
const retargeted = read(); retargeted.queue.items[0] = {...retargeted.queue.items[0], tmdbId: '999'};
assert.equal(posterBeginRun(confirmed.confirmation, retargeted, {now: NOW + 1000}).reason, 'scope_changed', 'the same record with another TMDB id');
assert.equal(posterBeginRun(confirmed.confirmation, read({missingPoster: 0, verifiedMissing: 0, unverifiedMissing: 0}), {now: NOW + 1000}).reason, 'not_eligible');
assert.equal(posterBeginRun(confirmed.confirmation, null, {now: NOW + 1000}).reason, 'read_failed');
assert.equal(posterBeginRun(confirmed.confirmation, read(), {now: NOW + 1000, retryAt: NOW + 60000}).reason, 'not_eligible', 'a rate-limit gate set meanwhile refuses');
assert.equal(posterBeginRun(null, read(), {now: NOW}).reason, 'not_eligible');

// 4. The sweep. A stand-in route answers from a script of answers; every body it receives is recorded.
const ok = (fields = {}) => ({ok: true, status: 200, error: null, body: {dryRun: false, enabled: true, programmeRunId: G1, requested: 10, processed: 1, hydrated: 1, outcomes: [{id: 'f0', tmdbId: '1', outcome: 'hydrated', writtenTo: ['a', 'b']}], writes: [{key: 'a', written: true, reason: null, records: 1}, {key: 'b', written: true, reason: null, records: 1}], retryable: [], generationChanged: false, leaseLost: false, retryAt: null, done: false, nextCursor: 'f0', remainingAfterCursor: 7, ...fields}});
async function sweep(answers, options = {}) {
  const bodies = [];
  const confirmation = {...begin.confirmation, calls: options.calls ?? 30, limit: options.limit ?? 10, cursor: options.cursor ?? null};
  let index = 0, stops = 0;
  const receipt = await runPosterSweep({
    confirmation, now: () => NOW,
    call: async body => {bodies.push(body); const answer = typeof answers === 'function' ? answers(index, body) : answers[Math.min(index, answers.length - 1)]; index++; if (answer instanceof Error) throw answer; return answer;},
    stopRequested: () => options.stopAfter !== undefined && ++stops > options.stopAfter,
    onProgress: options.onProgress,
  });
  return {receipt, bodies};
}

// One call, the budget: no cursor on the first call, the limit as confirmed and never above ten.
let {receipt, bodies} = await sweep([ok()], {calls: 1});
assert.deepEqual(bodies, [{dryRun: false, limit: 10, expectedProgrammeRunId: G1}], 'the first call already carries the confirmed generation');
assert.deepEqual([receipt.stop, receipt.nextCursor, receipt.summary.hydrated, receipt.summary.calls], ['call_budget', 'f0', 1, 1]);
({bodies} = await sweep([ok()], {calls: 1, limit: 20}));
assert.deepEqual(bodies, [{dryRun: false, limit: 10, expectedProgrammeRunId: G1}], 'a tampered limit is capped at ten');
// The cursor is carried from answer to answer, and an empty restart cursor is never sent.
({receipt, bodies} = await sweep(index => ok({nextCursor: ['f1', 'f3', ''][index], outcomes: [{id: 'f' + index, tmdbId: '1', outcome: 'hydrated'}]}), {calls: 3, cursor: 'f0'}));
assert.deepEqual(bodies.map(body => body.cursor ?? null), ['f0', 'f1', 'f3']);
assert.deepEqual(bodies.map(body => body.expectedProgrammeRunId), [G1, G1, G1], 'every call carries the confirmed generation');
assert.equal(receipt.nextCursor, null);
// Done ends the run and clears the position.
({receipt, bodies} = await sweep([ok(), ok({done: true, nextCursor: null, remainingAfterCursor: 0})]));
assert.deepEqual([receipt.stop, receipt.done, receipt.nextCursor, bodies.length], ['done', true, null, 2]);
// Thirty calls at most, however many are left.
({receipt, bodies} = await sweep(index => ok({nextCursor: 'c' + String(index).padStart(3, '0')}), {calls: 30}));
assert.deepEqual([receipt.stop, bodies.length], ['call_budget', 30]);
// Five calls in a row without a new poster and without moving the cursor stop the run.
({receipt, bodies} = await sweep(() => ok({hydrated: 0, outcomes: [{id: 'f0', tmdbId: '1', outcome: 'tmdb_failed', error: 'TMDB HTTP 500'}], writes: [], nextCursor: ''})));
assert.deepEqual([receipt.stop, bodies.length, receipt.summary.retryable], ['no_progress', POSTER_NO_PROGRESS_MAX, 1]);
// Moving past terminal records is progress even with no new poster; four idle calls then progress reset the count.
({receipt, bodies} = await sweep(index => index % 5 === 4 ? ok({hydrated: 0, nextCursor: 'm' + index, outcomes: [{id: 'm' + index, tmdbId: '1', outcome: 'no_poster_on_tmdb'}]}) : ok({hydrated: 0, writes: [], outcomes: [], nextCursor: index < 4 ? '' : 'm' + (index - index % 5 - 1)}), {calls: 12}));
assert.deepEqual([receipt.stop, bodies.length], ['call_budget', 12]);
// TMDB rate limit: stop at once with the time.
({receipt, bodies} = await sweep([ok(), ok({hydrated: 0, retryAt: NOW + 120000, outcomes: [{id: 'f1', tmdbId: '2', outcome: 'rate_limited'}, {id: 'f2', tmdbId: '3', outcome: 'not_attempted'}], writes: [], nextCursor: 'f0'}), ok()]));
assert.deepEqual([receipt.stop, receipt.retryAt, bodies.length, receipt.summary.retryable], ['rate_limited', NOW + 120000, 2, 2]);
// A new generation, either reported by the route or seen in its answer, stops after that call.
({receipt, bodies} = await sweep([ok(), ok({generationChanged: true, hydrated: 0, outcomes: [{id: 'f1', tmdbId: '2', outcome: 'generation_changed'}], writes: [{key: 'a', written: false, reason: 'generation_changed', records: 0}]}), ok()]));
assert.deepEqual([receipt.stop, bodies.length], ['generation_changed', 2]);
({receipt, bodies} = await sweep([ok({programmeRunId: G2}), ok()]));
assert.deepEqual([receipt.stop, bodies.length], ['generation_changed', 1]);
// The route's expected-generation fence refuses the call before TMDB and any write: a 409 that is a generation change.
({receipt, bodies} = await sweep([ok(), {ok: false, status: 409, error: 'Programme generation changed', body: {dryRun: false, enabled: true, error: 'Programme generation changed', generationChanged: true, leaseLost: false, expectedProgrammeRunId: G1, programmeRunId: G2}}, ok()]));
assert.deepEqual([receipt.stop, bodies.length, receipt.summary.outcomes.length, receipt.nextCursor], ['generation_changed', 2, 1, 'f0']);
// Resolver busy: nothing written, no further call.
({receipt, bodies} = await sweep([{ok: false, status: 409, error: 'Resolver is writing the catalog', body: {dryRun: false, enabled: true, error: 'Resolver is writing the catalog', programmeRunId: G1}}, ok()]));
assert.deepEqual([receipt.stop, bodies.length, receipt.summary.outcomes.length], ['resolver_busy', 1, 0]);
// Lease lost between the two copies: the partial write is reported, the position is the route's.
const lost = ok({leaseLost: true, hydrated: 0, outcomes: [{id: 'f0', tmdbId: '1', outcome: 'lease_lost', writtenTo: ['a']}], writes: [{key: 'a', written: true, reason: null, records: 1}, {key: 'b', written: false, reason: 'lease_lost', records: 0}], nextCursor: ''});
({receipt, bodies} = await sweep([{...lost, ok: false, status: 409, error: 'Resolver lease lost; see writes for the copies already written'}, ok()]));
assert.deepEqual([receipt.stop, bodies.length, receipt.summary.partialWrites, receipt.nextCursor], ['lease_lost', 1, true, null]);
assert.deepEqual(receipt.calls[0].outcomes[0].writtenTo, ['a']);
// TMDB not configured, an invalid request, a network failure, a thrown call, an unexpected body, an unknown outcome code.
for (const [answer, stop] of [
  [{ok: false, status: 503, error: 'TMDB is not configured', body: {error: 'TMDB is not configured'}}, 'tmdb_unconfigured'],
  [{ok: false, status: 400, error: 'Invalid limit', body: {error: 'Invalid limit'}}, 'invalid_request'],
  [{ok: false, status: 0, error: 'network', body: null}, 'unknown_result'],
  [new Error('boom'), 'unknown_result'],
  [{ok: false, status: 502, error: 'http_502', body: null}, 'unknown_result'],
  [{ok: true, status: 200, error: null, body: {dryRun: true, ids: []}}, 'unknown_result'],
  [ok({nextCursor: undefined}), 'unknown_result'],
  [ok({outcomes: [{id: 'f0', tmdbId: '1', outcome: 'teleported'}]}), 'unknown_result'],
]) {
  ({receipt, bodies} = await sweep([answer, ok()]));
  assert.deepEqual([receipt.stop, bodies.length], [stop, 1], stop + ' after ' + JSON.stringify(answer?.body ?? String(answer)));
}
// The owner's stop is honoured between calls, never during one.
({receipt, bodies} = await sweep(index => ok({nextCursor: 'f' + index}), {stopAfter: 2}));
assert.deepEqual([receipt.stop, bodies.length], ['owner_stopped', 3]);
// The latest outcome of a record wins, and progress is reported after every call.
const progress = [];
({receipt} = await sweep([ok({hydrated: 0, outcomes: [{id: 'f0', tmdbId: '1', outcome: 'tmdb_failed', error: 'x'}], writes: [], nextCursor: ''}), ok()], {calls: 2, onProgress: summary => progress.push([summary.calls, summary.hydrated, summary.remaining])}));
assert.deepEqual(receipt.summary.outcomes.map(item => item.outcome), ['hydrated']);
assert.deepEqual([receipt.summary.retryable, receipt.summary.hydrated], [0, 1]);
assert.deepEqual(progress, [[1, 0, 7], [2, 1, 7]]);
assert.deepEqual(posterReceiptSummary({callsPlanned: 1, calls: []}).outcomes, []);

// 5. Browser history: bounded, normalized, one generation per resume position, unknown results never advance it.
let history = posterHistoryRead('{broken');
assert.deepEqual(history, {version: 1, receipts: [], observations: [], lastSuccess: null, resume: null, retryAt: null, terminal: {}});
assert.deepEqual(posterHistoryRead(JSON.stringify({version: 2, receipts: [{finishedAt: 'x'}]})).receipts, []);
history = posterHistoryObserve(history, posterCoverage(read()));
history = posterHistoryObserve(history, {...posterCoverage(read()), observedAt: new Date(NOW + 1000).toISOString()});
assert.equal(history.observations.length, 1, 'an unchanged reading updates the last observation');
history = posterHistoryObserve(history, {...posterCoverage(read({missingPoster: 9, verifiedMissing: 7})), observedAt: new Date(NOW + 2000).toISOString()});
assert.equal(history.observations.length, 2);
for (let index = 0; index < 30; index++) history = posterHistoryObserve(history, {...posterCoverage(read({verifiedMissing: index})), observedAt: new Date(NOW + index * 1000).toISOString()});
assert.equal(history.observations.length, 20);
({receipt} = await sweep([ok({outcomes: [{id: 'f0', tmdbId: '1', outcome: 'hydrated'}, {id: 'f1', tmdbId: '2', outcome: 'no_poster_on_tmdb'}], hydrated: 1, nextCursor: 'f1'})], {calls: 1}));
history = posterHistoryRecord(history, receipt);
assert.deepEqual([history.receipts.length, history.lastSuccess.hydrated, history.resume, history.terminal], [1, 1, {programmeRunId: G1, cursor: 'f1'}, {f1: 'no_poster_on_tmdb'}]);
assert.equal(posterResumeCursor(history, G1), 'f1');
assert.equal(posterResumeCursor(history, G2), null, 'a position belongs to its generation');
({receipt} = await sweep([{ok: false, status: 0, error: 'network', body: null}], {calls: 1, cursor: 'f1'}));
history = posterHistoryRecord(history, receipt);
assert.deepEqual([history.resume.cursor, history.lastSuccess.hydrated, history.receipts.length], ['f1', 1, 2], 'an unknown result keeps the earlier position and success');
({receipt} = await sweep([ok({hydrated: 0, retryAt: NOW + 60000, outcomes: [{id: 'f2', tmdbId: '3', outcome: 'rate_limited'}], writes: [], nextCursor: 'f1'})], {calls: 1, cursor: 'f1'}));
history = posterHistoryRecord(history, receipt);
assert.equal(history.retryAt, NOW + 60000);
assert.equal(posterPreview(read(), {limit: 10, calls: 1, retryAt: history.retryAt, now: NOW}).status, 'rate_limited');
({receipt} = await sweep([ok({done: true, nextCursor: null, outcomes: [{id: 'f1', tmdbId: '2', outcome: 'hydrated'}]})], {calls: 1, cursor: 'f1'}));
history = posterHistoryRecord(history, receipt);
assert.deepEqual([history.resume, history.retryAt, history.terminal], [null, null, {}], 'done clears the position; a later poster clears a remembered terminal outcome');
const reread = posterHistoryRead(JSON.stringify(history));
assert.deepEqual(reread, history, 'the stored history reads back unchanged');
assert.deepEqual(posterHistoryRead(JSON.stringify({...history, terminal: {x: 'hydrated', y: 'no_poster_on_tmdb'}, resume: {cursor: ''}})).terminal, {y: 'no_poster_on_tmdb'});
for (let index = 0; index < 15; index++) history = posterHistoryRecord(history, receipt);
assert.equal(history.receipts.length, 10);

console.log('Admin posters run: copy tables against the route, preview, exact-scope confirmation, fresh check, batch cap, call budget, no-progress stop, rate limit, generation change, resolver busy, lease loss with partial writes, unknown results, owner stop and bounded history passed');
