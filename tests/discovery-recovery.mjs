import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  DISCOVERY_NEXT_ACTORS, DISCOVERY_RECOVERY_EXECUTE_REASON, DISCOVERY_RECOVERY_VERDICTS, DISCOVERY_RETRY_HELPS, DISCOVERY_SERIES_STATES,
  assessObservationRecovery, discoverySeriesState, observationActionable, observationActivity, observationEvidenceKey,
} from '../src/domain/discovery-recovery.js';

// Pure and offline, and not part of the Worker: no route consumes it and no capability is registered for it.
const source = fs.readFileSync('src/domain/discovery-recovery.js', 'utf8');
assert.doesNotMatch(source, /\bfetch\b|BUCKET|cloudflare:|node:|\bimport\b|\brequire\(|Date\.now|new Date\(\)|Math\.random|crypto/);
for (const file of ['build.mjs', 'src/worker.js', 'src/admin/limbo.js', 'src/admin/health.js', 'src/admin/actions-fixture.js', 'public/admin-actions.js']) {
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /discovery-recovery|assessObservationRecovery/, file + ' must not wire the assessment');
}

// The resolver itself, loaded the way the Worker bundle concatenates it.
const ctx = vm.createContext({Date, Map, Set, JSON, console, nextCatchUpAt: () => null, hourlyTaskRunAt: () => null});
vm.runInContext(fs.readFileSync('src/sources.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('src/discovery.js', 'utf8'), ctx);
const call = (name, ...args) => {
  ctx.__args = structuredClone(args);
  return vm.runInContext(`${name}(...__args)`, ctx);
};

const NOW = '2026-10-31T12:00:00.000Z', NOW_MS = Date.parse(NOW), H = 3600000, D = 86400000;
const iso = ms => new Date(NOW_MS + ms).toISOString();
const show = (offset, channelId = 'c1') => ({channelId, start: NOW_MS + offset, end: NOW_MS + offset + 2 * H});
const RUN = 'run-published', HOP = '11111111-1111-4111-8111-111111111111', OTHER_HOP = '22222222-2222-4222-8222-222222222222';
const candidate = fields => ({key: 'sever|2020', programmeRunId: RUN, title: 'Север', normalizedTitle: 'север', year: 2020, durations: [95], shows: [show(2 * H)], seenInLatestSnapshot: true, lastSeenAt: NOW_MS - H, lastAiring: NOW_MS + 2 * H, nonfilmReason: null, ...fields});
const evidence = c => call('candidateEvidence', c);
const quietSeries = {record: {stage: 'paused', reason: null, remainingChunks: 6, programmeRunId: RUN, at: iso(-H)}, health: {status: 'settled'}, lease: {id: OTHER_HOP, expiresAt: 0}};
const assess = fields => assessObservationRecovery({now: NOW, target: {key: 'sever|2020'}, published: {programmeRunId: RUN}, observation: candidate(), decision: null, series: quietSeries, ...fields});

// 1. Parity with the resolver: activity, evidence key and actionability over a generated matrix.
const showSets = [[], [show(-80 * H)], [show(-72 * H)], [show(-72 * H - 1)], [show(-71.5 * H)], [show(24 * H - 1)], [show(24 * H)], [show(2 * H), show(-5 * D, 'c2')]];
const seenFlags = [true, false, null, undefined];
const lastTimes = [undefined, NOW_MS - 4 * D, NOW_MS - 72 * H, NOW_MS - 72 * H - 1, NOW_MS - H];
const candidates = [];
for (const shows of showSets) for (const seenInLatestSnapshot of seenFlags) for (const lastSeenAt of lastTimes) {
  candidates.push(candidate({shows, seenInLatestSnapshot, lastSeenAt, lastAiring: lastSeenAt}));
}
candidates.push(candidate({title: 'Новости', normalizedTitle: 'новости', key: 'sever|2020'}));
candidates.push(candidate({shows: undefined, seenInLatestSnapshot: undefined, lastAiring: NOW_MS + H}));
candidates.push(candidate({confirmedTmdbId: '77', title: 'Новости'}));
const decisionsFor = c => {
  const same = evidence(c);
  return [
    null,
    {status: 'verified', tmdbId: '1', filmId: 'tmdb_1'},
    {status: 'excluded_nonfilm', reason: 'news'},
    {status: 'no_confident_match', attempts: 1, evidenceKey: same, retryAt: iso(D)},
    {status: 'no_confident_match', attempts: 2, evidenceKey: same, retryAt: iso(-H)},
    {status: 'no_confident_match', attempts: 2, evidenceKey: 'other', retryAt: iso(D)},
    {status: 'no_confident_match', attempts: 5, evidenceKey: same, retryAt: null, terminalReason: 'repeated_uncertain_match'},
    {status: 'no_confident_match', attempts: 5, evidenceKey: 'other', retryAt: null, terminalReason: 'repeated_uncertain_match'},
    {status: 'ambiguous', attempts: 1, evidenceKey: same, retryAt: iso(D)},
    {status: 'ambiguous', attempts: 3, evidenceKey: same, retryAt: iso(-H)},
    {status: 'ambiguous', attempts: 5, evidenceKey: same, retryAt: null, terminalReason: 'repeated_uncertain_match'},
    {status: 'needs_verification', attempts: 2, evidenceKey: same, retryAt: iso(2 * D)},
    {status: 'needs_verification', attempts: 5, evidenceKey: same, retryAt: null, terminalReason: 'awaiting_confirmation'},
    {status: 'duration_mismatch', attempts: 1, retryAt: iso(D)},
    {status: 'no_confident_match', attempts: 1, evidenceKey: same, retryAt: 'not a time'},
    {status: 'no_confident_match', attempts: 1},
  ];
};
let compared = 0;
for (const c of candidates) {
  const screened = {...c, nonfilmReason: call('nonFilmEPGReason', c.title)};
  assert.equal(observationActivity(screened, NOW_MS), call('candidateActivity', c, NOW_MS));
  assert.equal(observationEvidenceKey(screened), evidence(c));
  for (const decision of decisionsFor(c)) {
    const actionable = observationActionable(screened, decision, NOW_MS);
    assert.equal(actionable, call('resolutionActionability', c, decision, NOW_MS), JSON.stringify({c, decision}));
    const result = assess({observation: screened, decision});
    assert.equal(result.observation.actionable, actionable);
    // The assessment calls an observation queued (or a due conflict) exactly when the next chunk may look it up;
    // a known alias is verified by the chunk's cheap pass without a lookup.
    const willLookUp = result.verdict === 'queued' && result.reason !== 'known_alias' || result.verdict === 'identity_conflict' && result.next.at === null;
    if (result.reason !== 'known_alias') assert.equal(willLookUp, actionable, JSON.stringify({verdict: result.verdict, reason: result.reason, decision}));
    // Vocabulary is closed and execution is never offered.
    assert.ok(DISCOVERY_RECOVERY_VERDICTS.includes(result.verdict));
    assert.ok(DISCOVERY_SERIES_STATES.includes(result.series.state));
    assert.ok(DISCOVERY_RETRY_HELPS.includes(result.retry.helps));
    assert.ok(DISCOVERY_NEXT_ACTORS.includes(result.next.actor));
    assert.deepEqual(result.execute, {available: false, capability: null, reason: DISCOVERY_RECOVERY_EXECUTE_REASON});
    assert.equal(result.review.available, false);
    // A retry is never claimed to be the fix.
    assert.notEqual(result.retry.helps, 'yes');
    compared++;
  }
}
assert.ok(compared > 1000, 'the matrix covers the decision space');

// 2. Parity of the series decision with continuationDecision and continuationHealth.
const records = [
  null,
  {stage: 'paused', reason: 'epg_committed', remainingChunks: 12, programmeRunId: RUN},
  {stage: 'paused', reason: null, remainingChunks: 0, programmeRunId: RUN},
  {stage: 'paused', reason: 'chunk_budget', remainingChunks: 0, nextCatchUpAt: iso(H), programmeRunId: RUN},
  {stage: 'paused', reason: 'chunk_budget', remainingChunks: 0, nextCatchUpAt: iso(-H), programmeRunId: RUN},
  {stage: 'paused', reason: 'backoff', remainingChunks: 4, retryAt: iso(30 * 60000), nextCatchUpAt: iso(30 * 60000), programmeRunId: RUN},
  {stage: 'error', reason: 'discovery_failed', remainingChunks: 3, nextCatchUpAt: iso(H), programmeRunId: RUN},
  {stage: 'error', reason: 'discovery_failed', remainingChunks: 3, programmeRunId: RUN},
  {stage: 'complete', reason: null, remainingChunks: 5, programmeRunId: RUN},
  {stage: 'paused', reason: 'interrupted', remainingChunks: 5, interruptions: 2, programmeRunId: RUN},
  {stage: 'paused', reason: 'programme_changed', remainingChunks: 5, programmeRunId: RUN},
  {stage: 'error', reason: 'missing_secret', remainingChunks: 0, programmeRunId: RUN},
  {stage: 'scheduled', remainingChunks: 11, programmeRunId: RUN},
];
for (const record of records) {
  const state = discoverySeriesState({record, health: {status: record ? 'settled' : 'idle'}, lease: null}, RUN, NOW_MS);
  assert.equal(state.state === 'continuing', call('continuationDecision', record, NOW_MS).run, JSON.stringify({record, state}));
}
const running = {stage: 'running', reason: null, at: iso(-10 * 60000), hopId: HOP, remainingChunks: 7, programmeRunId: RUN};
const healthOf = (record, lease, last) => call('continuationHealth', record, lease, last, NOW_MS, RUN);
const finished = {startedAt: iso(-9 * 60000), finishedAt: iso(-8 * 60000), hopId: HOP, programmeRunId: RUN};
const runningCases = [
  {record: running, lease: {id: HOP, expiresAt: NOW_MS + 60000}, last: null, expect: 'live_writer'},
  {record: running, lease: {id: OTHER_HOP, expiresAt: NOW_MS + 60000}, last: null, expect: 'live_writer'},
  {record: running, lease: {id: HOP, expiresAt: NOW_MS - 60000}, last: null, expect: 'recovering'},
  {record: running, lease: null, last: finished, expect: 'recovering'},
  {record: {...running, interruptions: 1}, lease: {id: OTHER_HOP, expiresAt: NOW_MS - 60000}, last: null, expect: 'interrupted'},
  {record: {...running, interruptions: 1}, lease: {id: HOP, expiresAt: NOW_MS - 60000}, last: finished, expect: 'recovering'},
];
for (const item of runningCases) {
  const health = healthOf(item.record, item.lease, item.last);
  const state = discoverySeriesState({record: item.record, health, lease: item.lease}, RUN, NOW_MS);
  assert.equal(state.state, item.expect, JSON.stringify({item, health, state}));
  if (health.status === 'orphaned') assert.equal(state.state === 'interrupted', health.failClosed === true, 'fail-closed agrees with the resolver');
}

// 3. The card's situations, one by one.
// Known target, nothing decided yet, series moving: already queued; a targeted retry would only take it sooner.
let result = assess({});
assert.equal(result.verdict, 'queued');
assert.equal(result.reason, 'no_decision');
assert.deepEqual(result.retry, {helps: 'only_sooner', reason: 'already_queued'});
assert.deepEqual(result.next, {actor: 'scheduled_step', at: null});
assert.equal(result.evidence.completeness, 'complete');

// Absent target: the ledger has no such key. Nothing is invented and nothing is offered.
result = assess({observation: null});
assert.equal(result.verdict, 'not_found');
assert.equal(result.retry.helps, 'unknown');
assert.equal(result.observation, null);

// The exact target only: a candidate of another key is never judged in its place.
result = assess({observation: candidate({key: 'sever|2021'})});
assert.equal(result.verdict, 'unknown');
assert.equal(result.reason, 'observation_key_differs');

// Live lease (a chunk or the poster maintenance route holds the resolver): wait for its expiry.
result = assess({series: {...quietSeries, lease: {id: OTHER_HOP, expiresAt: NOW_MS + 45000}}});
assert.equal(result.series.state, 'live_writer');
assert.deepEqual(result.next, {actor: 'scheduled_step', at: iso(45000)});
assert.equal(result.retry.helps, 'only_sooner');

// Orphaned running record: the next ordinary step settles or resumes it.
const orphanLease = {id: HOP, expiresAt: NOW_MS - 30000};
result = assess({series: {record: running, health: healthOf(running, orphanLease, null), lease: orphanLease}});
assert.equal(result.series.state, 'recovering');
assert.equal(result.series.reason, 'orphan_resume');
assert.equal(result.retry.helps, 'only_sooner');

// Expired lease of another hop over a record that was already interrupted once: ownership is ambiguous, the series
// fails closed, and only a whole-series action could help.
const twice = {...running, interruptions: 1};
const strayLease = {id: OTHER_HOP, expiresAt: NOW_MS - 30000};
result = assess({series: {record: twice, health: healthOf(twice, strayLease, null), lease: strayLease}});
assert.equal(result.series.state, 'interrupted');
assert.deepEqual(result.retry, {helps: 'series_level', reason: 'series_stopped'});
assert.deepEqual(result.next, {actor: 'epg_commit', at: null});

// A running record without a matching health report is not guessed at.
result = assess({series: {record: running, health: {status: 'settled'}, lease: null}});
assert.equal(result.series.state, 'unknown');
assert.equal(result.evidence.completeness, 'partial');
assert.deepEqual(result.evidence.missing, ['series']);

// Generation change: the projection is of an older generation; a checkpoint of an older generation is handed off.
result = assess({observation: candidate({programmeRunId: 'run-older'})});
assert.equal(result.verdict, 'stale_generation');
assert.equal(result.next.actor, 'reread');
result = assess({series: {...quietSeries, record: {...quietSeries.record, programmeRunId: 'run-older'}}});
assert.equal(result.series.state, 'recovering');
assert.equal(result.series.reason, 'generation_handoff');

// Throttling: a TMDB 429 left the series in backoff; the queued observation waits with it.
result = assess({series: {...quietSeries, record: {stage: 'paused', reason: 'backoff', remainingChunks: 4, retryAt: iso(20 * 60000), nextCatchUpAt: iso(20 * 60000), programmeRunId: RUN}}});
assert.equal(result.series.state, 'waiting');
assert.equal(result.series.reason, 'backoff');
assert.deepEqual(result.next, {actor: 'scheduled_step', at: iso(20 * 60000)});

// Per-observation backoff is policy: never bypassed, and the time is named.
const same = evidence(candidate());
result = assess({decision: {status: 'no_confident_match', attempts: 2, evidenceKey: same, retryAt: iso(2 * D)}});
assert.equal(result.verdict, 'backoff');
assert.deepEqual(result.retry, {helps: 'no', reason: 'backoff_is_policy'});
assert.deepEqual(result.next, {actor: 'scheduled_step', at: iso(2 * D)});
assert.equal(result.review.suggested, false);

// Identity conflict: review, not retry, whether or not its automatic re-check is due.
for (const retryAt of [iso(D), iso(-H)]) {
  result = assess({decision: {status: 'ambiguous', attempts: 2, evidenceKey: same, retryAt}});
  assert.equal(result.verdict, 'identity_conflict');
  assert.deepEqual(result.retry, {helps: 'unlikely', reason: 'ambiguity_needs_review'});
  assert.deepEqual(result.review, {suggested: true, reason: 'identity_ambiguous', target: 'identity_review', available: false, unavailableReason: 'identity_review_not_built'});
}

// No more evidence: automatic attempts are finished on unchanged evidence; new airing evidence reopens it on its own.
for (const terminalReason of ['repeated_uncertain_match', 'awaiting_confirmation']) {
  result = assess({decision: {status: terminalReason === 'awaiting_confirmation' ? 'needs_verification' : 'no_confident_match', attempts: 5, evidenceKey: same, retryAt: null, terminalReason}});
  assert.equal(result.verdict, 'no_more_evidence');
  assert.equal(result.reason, terminalReason);
  assert.equal(result.retry.helps, 'unlikely');
  assert.deepEqual(result.next, {actor: 'new_epg_evidence', at: null});
  assert.equal(result.review.suggested, true);
}
result = assess({observation: candidate({shows: [show(3 * H, 'c9')]}), decision: {status: 'no_confident_match', attempts: 5, evidenceKey: same, terminalReason: 'repeated_uncertain_match'}});
assert.equal(result.verdict, 'queued');
assert.equal(result.reason, 'evidence_changed');

// Not in the current EPG window: the resolver does not look at it, so no retry can.
result = assess({observation: candidate({seenInLatestSnapshot: false, shows: [], lastSeenAt: NOW_MS - 10 * D, lastAiring: NOW_MS - 10 * D})});
assert.equal(result.verdict, 'not_current');
assert.equal(result.reason, 'expired');
assert.deepEqual(result.retry, {helps: 'no', reason: 'not_in_current_epg'});

// Resolved and screened-out observations need nothing.
assert.equal(assess({decision: {status: 'verified', tmdbId: '1'}}).verdict, 'resolved');
assert.equal(assess({observation: candidate({nonfilmReason: 'news'})}).verdict, 'excluded_nonfilm');

// The series stopped (complete, or budget spent): a queued observation waits for the next EPG commit.
result = assess({series: {...quietSeries, record: {stage: 'complete', remainingChunks: 3, programmeRunId: RUN}}});
assert.deepEqual(result.retry, {helps: 'series_level', reason: 'series_stopped'});
assert.deepEqual(result.next, {actor: 'epg_commit', at: null});

// No identity trust escalation: an accepted score awaiting confirmation is not resolved, a known alias is only queued
// for the resolver's own cheap pass, and only a verified decision is `resolved`.
result = assess({decision: {status: 'needs_verification', attempts: 1, evidenceKey: same, retryAt: iso(-H), scoring: {status: 'accepted', acceptedTmdbId: '42'}}});
assert.equal(result.verdict, 'queued');
assert.equal(result.decision.status, 'needs_verification');
result = assess({observation: candidate({confirmedTmdbId: '42'})});
assert.equal(result.verdict, 'queued');
assert.equal(result.reason, 'known_alias');
assert.ok(!JSON.stringify(result).includes('"42"'), 'the assessment never carries an identity it did not verify');

// Unknown evidence fails closed: nothing supplied is never "nothing wrong".
for (const [fields, reason] of [
  [{published: undefined}, 'published_not_supplied'],
  [{observation: undefined}, 'observation_not_supplied'],
  [{observation: 'sever|2020'}, 'observation_malformed'],
  [{decision: undefined}, 'decision_not_supplied'],
  [{decision: ['verified']}, 'decision_malformed'],
  [{observation: candidate({programmeRunId: null})}, 'observation_generation_missing'],
]) {
  result = assess(fields);
  assert.equal(result.verdict, 'unknown', reason);
  assert.equal(result.reason, reason);
  assert.equal(result.evidence.completeness, 'missing');
  assert.equal(result.retry.helps, 'unknown');
}
for (const series of [undefined, {record: quietSeries.record, health: null}, {record: undefined, health: null, lease: null}, {record: 'x', health: null, lease: null}, {record: null, health: null, lease: 7}]) {
  result = assess({series});
  assert.equal(result.series.state, 'unknown');
  assert.equal(result.retry.helps, 'unknown');
  assert.equal(result.evidence.completeness, 'partial');
}
assert.equal(assess({decision: {status: 'no_confident_match', attempts: 1, evidenceKey: same, retryAt: 'not a time'}}).evidence.anomalies[0], 'retry_at_unparseable');
assert.deepEqual(assessObservationRecovery(null), {error: 'invalid_input'});
assert.deepEqual(assessObservationRecovery({now: 'yesterday', target: {key: 'k'}}), {error: 'invalid_clock'});
assert.deepEqual(assessObservationRecovery({now: NOW, target: {key: ''}}), {error: 'invalid_target'});

// Repeat assessment: the same inputs give the same answer, and the inputs are never changed (deep-frozen here).
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const input = freeze({now: NOW, target: {key: 'sever|2020'}, published: {programmeRunId: RUN}, observation: candidate(), decision: {status: 'ambiguous', attempts: 2, evidenceKey: same, retryAt: iso(-H)}, series: structuredClone(quietSeries)});
assert.deepEqual(assessObservationRecovery(input), assessObservationRecovery(input));

console.log('discovery recovery assessment: ok');
