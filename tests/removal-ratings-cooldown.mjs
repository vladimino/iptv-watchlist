// AIR-604 (ADR 0211 decision 5): the removal-phase rating refresh and the shared Letterboxd cooldown, through the real ratings pipeline (the harness of ratings-run.mjs).
// The cooldown is read BEFORE each claim, so a skip never charges an attempt; it extends the queue pause to max(pausedUntil, until) and stops the phase cleanly. The run outcome
// comes from the Diary part, so a skip is neither a failure nor a quarantine charge. A 403, 429 or challenge of a sent lookup writes the cooldown. `off` is today's behaviour.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {makeBucket, makeClock, makeNetwork, loadContext, baseEnv, diaryPages, diaryPage, diaryRow, migrated as seedBucket, QUEUE, RUN, SEPARATE, H, eventKeyOf, film, plain, g} from './ratings-harness.mjs';
import {migrated as chain, sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {scoped} from '../scripts/bundle-scope.mjs';
import {aggregate} from '../scripts/upstream-cooldown-evidence-report.mjs';

const T0 = Date.parse('2026-10-31T08:00:00.000Z');
const at = ms => new Date(ms).toISOString();
const drain = async (R, env, runId, limit = 20) => {const replies = []; for (let i = 0; i < limit; i++) {const r = plain(await R.step(env, {runId})); replies.push(r); if (r.nextAction !== 'continue') break;} return replies;};

async function world({mode, cooldownSeconds = null, members = {}, appearsAtRecheck = false, logs = null}) {
  const {clock, FakeDate, crypto} = makeClock(T0), net = makeNetwork(), bucket = makeBucket();
  const ctx = loadContext({net, clock, FakeDate, crypto, extra: logs ? {console: {log: line => logs.push(String(line)), warn() {}, error() {}}} : {}});
  vm.runInContext(scoped('src/upstream-cooldown.js', 'UpstreamCooldown'), ctx); // before any call: a lookup of a missing global can stay cached
  const file = chain();
  if (mode) sql(file, `INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, '${mode}', 1, ${T0})`);
  // `appearsAtRecheck`: the cooldown is written by ANOTHER writer between the pre-claim read and the real request (the plan and the claim are awaited): the 2nd read of the cooldown row is
  // the real request's own re-check, and the row appears just before it.
  let armed = false, reads = 0;
  const onQuery = text => {if (armed && appearsAtRecheck && /FROM upstream_cooldown/.test(text) && ++reads === 2) sql(file, `INSERT INTO upstream_cooldown (scope, until_at, reason, retry_after_s, set_by, updated_at) VALUES ('letterboxd', ${T0 + 900_000}, 'rate_limited', NULL, 'other-writer', ${T0})`);};
  const env = {...baseEnv(bucket, {...SEPARATE, LETTERBOXD_DIARY_HISTORY: undefined}), DB: d1Standin(file, {onQuery})};
  const R = g(ctx, 'LetterboxdRatings');
  const ids = ['a', 'b', 'c'], films = {}, eventAt = at(T0 - 2 * H);
  await ctx.writeEvent(env, {id: 'run-1-watchlist', type: 'watchlist', at: eventAt, total: 0, baseline: false, added: [], removed: ids.map(id => ({id, title: id, year: 2000}))});
  for (const [n, id] of ids.entries()) films[id] = {url: film(id).url, state: 'pending', attempts: 0, enqueuedAt: at(T0 - H + n), nextAttemptAt: at(T0 - H), lastAttemptAt: null, lastResult: null, claim: null, refs: [{eventKey: eventKeyOf(eventAt, 'run-1-watchlist'), sourceRunId: 'run-1', at: eventAt}]};
  seedBucket(bucket, {films});
  net.diary.set(1, diaryPage([diaryRow('diary-only', 8, '2026-10-29', '99001')], false));
  for (const [id, value] of Object.entries(members)) net.members.set(id, value);
  const {runId} = plain(await R.start(env, {trigger: 'manual'}));
  await R.step(env, {runId}); // Diary page 1 (the Diary page consults the same cooldown, so it is seeded after this step: the removal phase is what is under test here)
  if (cooldownSeconds) sql(file, `INSERT INTO upstream_cooldown (scope, until_at, reason, retry_after_s, set_by, updated_at) VALUES ('letterboxd', ${T0 + cooldownSeconds * 1000}, 'rate_limited', NULL, 'seed', ${T0})`);
  armed = true;
  const replies = await drain(R, env, runId);
  return {bucket, net, file, replies, queue: bucket.value(QUEUE), run: bucket.value(RUN)};
}
const rows = file => sql(file, 'SELECT scope, until_at, reason, set_by FROM upstream_cooldown ORDER BY scope');

// 1. enforce + an active cooldown: no member page is requested, no attempt is charged, the pause is the cooldown end, the run is not an error
{
  const w = await world({mode: 'enforce', cooldownSeconds: 900, members: {a: 4, b: 4, c: 4}});
  assert.deepEqual(w.net.memberFetches(), [], 'no lookup request while the cooldown is active');
  for (const id of ['a', 'b', 'c']) {const e = w.queue.films[id]; assert.equal(e.attempts, 0, id + ': no attempt charged'); assert.equal(e.state, 'pending'); assert.equal(e.lastResult, null, id + ': never claimed'); assert.equal(e.claim, null);}
  assert.equal(Date.parse(w.queue.pausedUntil), T0 + 900_000, 'pausedUntil = max(pausedUntil, until_at)'); assert.equal(w.queue.pausedBy, 'upstream_cooldown');
  assert.equal(w.run.removal.lookup.stoppedBy, 'upstream_cooldown'); assert.equal(w.run.removal.lookup.checked, 0);
  assert.equal(w.run.state, 'finished'); assert.equal(w.run.cause, null, 'neither a failure nor a quarantine charge');
}

// 2. a longer existing pause is never shortened by a shorter cooldown (monotonic)
{
  const w = await world({mode: 'enforce', cooldownSeconds: 60, members: {a: 4}});
  assert.equal(Date.parse(w.queue.pausedUntil), T0 + 60_000); assert.equal(w.queue.pausedBy, 'upstream_cooldown');
}

// 3. a 403 of a sent lookup writes the cooldown (enforce and observe); a rated film and a 404 write nothing
for (const mode of ['enforce', 'observe']) {
  const w = await world({mode, members: {a: 4, b: 403, c: 4}});
  const written = rows(w.file);
  assert.equal(written.length, 1, mode); assert.equal(written[0].scope, 'letterboxd'); assert.ok(['forbidden', 'challenge'].includes(written[0].reason), 'a 403 (the harness body is a challenge page): ' + written[0].reason); assert.equal(written[0].set_by, 'removal-rating-request', 'the write belongs to the request site');
}
{
  const w = await world({mode: 'enforce', members: {a: 4, b: 404, c: 'none'}});
  assert.deepEqual(rows(w.file), [], 'a rating, a 404 and a not-rated page set no cooldown');
}

// 4. observe skips nothing; off is today's behaviour, even with a seeded cooldown row
for (const [label, mode] of [['observe', 'observe'], ['off', 'off'], ['absent row', null]]) {
  const w = await world({mode, cooldownSeconds: 900, members: {a: 4, b: 4, c: 4}});
  assert.equal(w.net.memberFetches().length, 3, label + ': the lookups run as today');
  assert.equal(w.run.removal.lookup.stoppedBy, null, label);
}

// 5. a cooldown that appears AFTER the pre-claim read, during the awaited plan and claim: the real request re-checks, sends nothing, RELEASES the claim, and consumes no attempt
{
  const w = await world({mode: 'enforce', members: {a: 4, b: 4, c: 4}, appearsAtRecheck: true});
  assert.deepEqual(w.net.memberFetches(), [], 'the real request re-checked the cooldown and sent nothing');
  const e = w.queue.films.a;
  assert.equal(e.attempts, 0, 'the claimed attempt is given back'); assert.equal(e.state, 'pending'); assert.equal(e.lastResult, null); assert.equal(e.claim, null, 'the claim is released');
  assert.equal(e.nextAttemptAt, at(T0 - H), 'the film is due again exactly as before the claim');
  for (const id of ['b', 'c']) assert.equal(w.queue.films[id].attempts, 0, id + ' was never touched');
  assert.equal(Date.parse(w.queue.pausedUntil), T0 + 900_000); assert.equal(w.queue.pausedBy, 'upstream_cooldown');
  assert.equal(w.run.removal.lookup.stoppedBy, 'upstream_cooldown'); assert.equal(w.run.state, 'finished'); assert.equal(w.run.cause, null);
}

// 6. AIR-609 (independent review P1-A): a decision count is NOT a prevented request. The removal path checks the same scope at TWO sites for one lookup: the queue's pre-claim peek (caller
// `removal-rating`, one coordinator per phase) and the real request's guard (caller `removal-rating-request`, one coordinator per request). With an active cooldown:
//  - observe sends EVERY lookup (the cooldown skips nothing) and counts would_skip at both sites, so the decision total is larger than the number of lookups it stands for;
//  - enforce would have stopped the whole phase at the FIRST pre-claim check: no lookup sent, one skipped decision, so the counterfactual request count is not the would_skip total either.
// The two guards stay (a cooldown can appear between them, case 5); the evidence keeps the sites apart by caller.
{
  const logs = [];
  const w = await world({mode: 'observe', cooldownSeconds: 900, members: {a: 4, b: 4, c: 4}, logs});
  const sent = w.net.memberFetches().length;
  assert.equal(sent, 3, 'observe sends every lookup while the cooldown is active');
  const report = aggregate(logs);
  const site = caller => report.rows.find(r => r.caller === caller && r.scope === 'letterboxd' && r.decision === 'would_skip');
  const pre = site('removal-rating'), request = site('removal-rating-request');
  assert.deepEqual([pre.streams, pre.lower, pre.upper], [1, 2, 3], 'one pre-claim coordinator counted the three entries; it logs at counts 1 and 2, so the range 2-3 holds the true 3');
  assert.deepEqual([request.streams, request.lower, request.upper], [3, 3, 3], 'one coordinator per sent request, one decision each');
  const decisions = report.totals.would_skip;
  assert.deepEqual([decisions.lower, decisions.upper], [5, 6], 'the true total is 6: three pre-claim plus three request-site decisions');
  assert.equal(decisions.lower > sent, true, 'more would_skip decisions than lookups sent: a decision count is not a request count');
  assert.equal(report.totals.skipped.lines, 0, 'observe never skips');

  const enforced = [];
  const e = await world({mode: 'enforce', cooldownSeconds: 900, members: {a: 4, b: 4, c: 4}, logs: enforced});
  const counterfactual = aggregate(enforced);
  assert.equal(e.net.memberFetches().length, 0, 'enforce would have sent none of the three');
  assert.deepEqual([counterfactual.totals.skipped.lower, counterfactual.totals.skipped.upper], [1, 1], 'a single skipped decision stopped the phase');
  assert.equal(counterfactual.totals.would_skip.lines, 0);
}

console.log('removal-ratings-cooldown: ok');
