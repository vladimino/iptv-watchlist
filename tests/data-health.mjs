import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DATA_HEALTH_ACTIONS, DATA_HEALTH_ACTION_CODES, DATA_HEALTH_ANOMALIES, DATA_HEALTH_CATEGORIES, DATA_HEALTH_COVERAGE, DATA_HEALTH_ELIGIBILITY_REASONS,
  DATA_HEALTH_EVIDENCE, DATA_HEALTH_FILM_FIELDS, DATA_HEALTH_FRESHNESS, DATA_HEALTH_PROGRESS, DATA_HEALTH_REASONS, DATA_HEALTH_SEVERITIES, DATA_HEALTH_SUBJECT_KINDS,
  DATA_HEALTH_SUBSYSTEMS, DATA_HEALTH_SUBSYSTEM_STATUSES, DATA_HEALTH_THRESHOLDS, DATA_HEALTH_UNOBSERVED_REASONS, compareHealthIssues, diffHealthIssues,
  evaluateDataHealth, healthIssueId, progressOf,
} from '../src/domain/data-health.js';

// Pure and offline: no storage, network or clock of its own, and not part of the Worker bundle or the public pages.
const source = fs.readFileSync('src/domain/data-health.js', 'utf8');
assert.doesNotMatch(source, /\bfetch\b|BUCKET|cloudflare:|node:|\bimport\b|\brequire\(|Date\.now|new Date\(\)|Math\.random|R2|D1/);
assert.equal(fs.readFileSync('build.mjs', 'utf8').includes('data-health'), false);
assert.equal(fs.readFileSync('public/app.js', 'utf8').includes('data-health'), false);
assert.equal(fs.readFileSync('src/admin/client.js', 'utf8').includes('data-health'), false);
assert.equal(fs.readFileSync('src/admin/read.js', 'utf8').includes('data-health'), false);
assert.equal(fs.readFileSync('public/admin.js', 'utf8').includes('data-health'), false);

const NOW = '2026-10-30T12:00:00.000Z';
const H = 3600000, D = 86400000;
const at = ms => new Date(Date.parse(NOW) + ms).toISOString();
const plain = value => JSON.parse(JSON.stringify(value));
const deepFreeze = value => {if (value && typeof value === 'object') {Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item);} return value;};
const published = {programmeRunId: 'gen-2', phase: 'published', publishedAt: at(-5 * H), observedAt: NOW};
const film = (id, fields) => ({id, programmeRunId: 'gen-2', observedAt: NOW, identity: {status: 'resolved'}, metadata: {status: 'fresh'}, localization: {status: 'reviewed'}, localizationConflicts: [], externalIds: [{scheme: 'tmdb', value: '1', trusted: true, conflicting: false}], fingerprint: {status: 'current'}, prediction: {status: 'current'}, poster: 'https://image.example/poster.jpg', ...fields});
const queue = fields => ({observedAt: NOW, programmeRunId: 'gen-2', hotPending: [], coldPending: [], retries: {}, lastCheckAt: at(-H), lastBatch: {finishedAt: at(-H), stage: 'noop', reason: null}, ...fields});
const complete = fields => ({now: NOW, published, coverage: {films: 'complete', observations: 'complete'}, films: [], observations: [], predictionQueue: queue(), discovery: {stage: 'complete', reason: null, at: at(-2 * H), programmeRunId: 'gen-2', observedAt: NOW}, posters: {observedAt: NOW, programmeRunId: 'gen-2', missingPoster: 0, verifiedMissing: 0, unverifiedMissing: 0}, letterboxd: {observedAt: NOW, baseline: {confirmedAt: at(-10 * D), sha256: 'a'.repeat(64)}}, ...fields});
const evaluate = (snapshot, options) => evaluateDataHealth(deepFreeze(structuredClone(snapshot)), options);
const only = (result, subsystem) => result.issues.filter(item => item.subsystem === subsystem);
const one = (result, id) => {const found = result.issues.filter(item => item.id === id); assert.equal(found.length, 1, id); return found[0];};

// Closed vocabularies: every issue field value belongs to its list.
function checkIssue(item, result) {
  assert.equal(item.schemaVersion, 1);
  assert.equal(item.id, healthIssueId(item.subsystem, item.category, item.subject));
  assert(DATA_HEALTH_SUBSYSTEMS.includes(item.subsystem), item.subsystem);
  assert(DATA_HEALTH_SUBJECT_KINDS.includes(item.subject.kind), item.subject.kind);
  assert.equal(typeof item.subject.id, 'string');
  assert(DATA_HEALTH_CATEGORIES.includes(item.category), item.category);
  assert(DATA_HEALTH_SEVERITIES.includes(item.severity), item.severity);
  assert(DATA_HEALTH_REASONS.includes(item.reason), item.reason);
  assert(DATA_HEALTH_EVIDENCE.includes(item.evidence.completeness), item.id);
  assert.equal(typeof item.evidence.source, 'string');
  for (const anomaly of item.evidence.anomalies) assert(DATA_HEALTH_ANOMALIES.includes(anomaly), anomaly);
  assert(DATA_HEALTH_FRESHNESS.includes(item.freshness.status), item.id);
  assert(DATA_HEALTH_PROGRESS.includes(item.progress.status), item.id);
  assert(DATA_HEALTH_ACTIONS.includes(item.action.suggested), item.id);
  assert(DATA_HEALTH_ACTION_CODES.includes(item.action.code), item.action.code);
  assert([true, false, null].includes(item.action.eligible), item.id);
  assert(DATA_HEALTH_ELIGIBILITY_REASONS.includes(item.action.reason), item.action.reason);
  assert(Number.isInteger(item.affected.count) && item.affected.count >= 0, item.id);
  assert(item.affected.sample.length <= result.thresholds.sampleSize, item.id);
  for (const key of ['observedAt', 'lastProgressAt']) assert(item[key] === null || !Number.isNaN(Date.parse(item[key])), key);
  if (item.threshold) {assert(Object.hasOwn(DATA_HEALTH_THRESHOLDS, item.threshold.code), item.threshold.code); assert.equal(item.threshold.unit, 'ms');}
  assert.equal(typeof item.provenance.source, 'string');
  assert.equal(typeof item.provenance.rule, 'string');
  if (item.action.eligible === true) assert.equal(item.action.reason, 'eligible');
  if (item.action.eligible === true) assert.equal(item.evidence.completeness, 'complete', item.id + ': eligible only on complete evidence');
  if (item.evidence.completeness === 'missing') assert.equal(item.action.eligible, null, 'missing evidence never makes an action eligible');
}
function checkResult(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.now, NOW);
  const ids = result.issues.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual(ids, [...result.issues].sort(compareHealthIssues).map(item => item.id), 'issues are sorted');
  for (const item of result.issues) checkIssue(item, result);
  const totals = {critical: 0, warning: 0, info: 0};
  for (const item of result.issues) totals[item.severity]++;
  assert.deepEqual(result.counts.bySeverity, totals);
  assert.equal(Object.values(result.counts.byCategory).reduce((sum, value) => sum + value, 0), result.issues.length);
  for (const [name, entry] of Object.entries(result.subsystems)) {
    assert.equal(entry.issues, only(result, name).length, name);
    assert(DATA_HEALTH_SUBSYSTEM_STATUSES.includes(entry.status), entry.status);
    if (entry.evidence !== 'observed') assert.equal(entry.status, 'unknown', name + ' without evidence is unknown');
    else if (entry.issues) assert.equal(entry.status, 'attention', name);
    else assert(['clear', 'clear_in_scope'].includes(entry.status), name);
  }
  for (const [list, value] of Object.entries(result.scope.coverage)) assert(DATA_HEALTH_COVERAGE.includes(value), list);
  assert.deepEqual(result.scope.subjects.films, [...result.scope.subjects.films].sort((a, b) => a.localeCompare(b, 'en')));
  assert.equal(Object.hasOwn(result, 'score'), false, 'no aggregate score');
  return result;
}

// Invalid input: an error result, never a partial evaluation.
assert.deepEqual(evaluateDataHealth(null), {error: 'invalid_snapshot'});
assert.deepEqual(evaluateDataHealth([]), {error: 'invalid_snapshot'});
assert.deepEqual(evaluateDataHealth({}), {error: 'invalid_clock'});
assert.deepEqual(evaluateDataHealth({now: 'yesterday'}), {error: 'invalid_clock'});
assert.deepEqual(evaluateDataHealth({now: NOW}, {thresholds: {stalledMs: 0}}), {error: 'invalid_thresholds'});
assert.deepEqual(evaluateDataHealth({now: NOW}, {thresholds: {unknownMs: 5}}), {error: 'invalid_thresholds'});
assert.deepEqual(evaluateDataHealth({now: NOW}, {thresholds: {stalledMs: 1.5}}), {error: 'invalid_thresholds'});
assert.deepEqual(evaluateDataHealth({now: NOW, films: {}}), {error: 'invalid_films'});
assert.deepEqual(evaluateDataHealth({now: NOW, observations: 'x'}), {error: 'invalid_observations'});
assert.deepEqual(evaluateDataHealth({now: NOW, coverage: 'complete'}), {error: 'invalid_coverage'});
assert.deepEqual(evaluateDataHealth({now: NOW, coverage: {films: 'all'}}), {error: 'invalid_coverage'});
assert.deepEqual(evaluateDataHealth({now: NOW, coverage: {posters: 'complete'}}), {error: 'invalid_coverage'});
assert.equal(evaluateDataHealth({now: Date.parse(NOW), films: []}).now, NOW, 'milliseconds are an accepted clock');

// Empty, two senses. Nothing supplied: every subsystem is unknown, reported, and nothing is clear.
const nothing = checkResult(evaluate({now: NOW}));
assert.equal(nothing.issues.length, DATA_HEALTH_SUBSYSTEMS.length);
assert(nothing.issues.every(item => item.reason === 'evidence_not_supplied' && item.severity === 'info' && item.category === 'incomplete' && item.evidence.completeness === 'missing' && item.action.eligible === null));
assert(Object.values(nothing.subsystems).every(entry => entry.status === 'unknown' && entry.evidence === 'not_supplied'));
assert.deepEqual(nothing.published, {programmeRunId: null, phase: null, publishedAt: null});
// Everything supplied and empty: clear everywhere, zero issues, and the thresholds in force are reported.
const clear = checkResult(evaluate(complete()));
assert.deepEqual(clear.issues, []);
assert(Object.values(clear.subsystems).every(entry => entry.status === 'clear' && entry.evidence === 'observed'));
assert.deepEqual(clear.counts.bySeverity, {critical: 0, warning: 0, info: 0});
assert.deepEqual(clear.thresholds, DATA_HEALTH_THRESHOLDS);
assert.deepEqual(clear.published, {programmeRunId: 'gen-2', phase: 'published', publishedAt: at(-5 * H)});
assert.deepEqual(clear.clock, {skewToleranceMs: 5 * 60000, anomalies: []});
assert.deepEqual(clear.scope, {programmeRunId: 'gen-2', coverage: {films: 'complete', observations: 'complete'}, sources: {published: 'observed', films: 'observed', observations: 'observed', predictionQueue: 'observed', discovery: 'observed', posters: 'observed', letterboxd: 'observed'}, subjects: {films: [], observations: []}, fields: {films: {}}});
// A bounded page is clear only in its own scope: undeclared coverage is partial, and `clear` needs every list the
// subsystem reads to be complete.
const page = checkResult(evaluate(complete({coverage: undefined, films: [film('film:ok')]})));
assert.deepEqual(page.scope.coverage, {films: 'partial', observations: 'partial'});
assert.deepEqual(page.scope.subjects.films, ['film:ok']);
assert.deepEqual(page.scope.fields.films, {'film:ok': ['externalIds', 'fingerprint', 'identity', 'localizationConflicts', 'metadata', 'poster', 'prediction']});
assert.deepEqual(evaluate(complete({films: [{id: 'film:thin', observedAt: NOW, poster: undefined, identity: null, externalIds: 'x'}]})).scope.fields.films, {'film:thin': []}, 'undefined, null and malformed fields are not observed');
assert.deepEqual(evaluate(complete({films: [{id: 'film:split', metadata: {status: 'fresh'}}, {id: 'film:split', poster: null}]})).scope.fields.films, {'film:split': ['metadata', 'poster']}, 'a repeated record adds its fields');
for (const name of ['identity', 'metadata', 'localization', 'fingerprint', 'prediction', 'poster']) assert.equal(page.subsystems[name].status, 'clear_in_scope', name);
for (const name of ['programme', 'prediction_queue', 'discovery', 'letterboxd_archive']) assert.equal(page.subsystems[name].status, 'clear', name);
const filmsOnly = evaluate(complete({coverage: {films: 'complete'}, observations: undefined, posters: undefined}));
assert.deepEqual([filmsOnly.subsystems.metadata.status, filmsOnly.subsystems.identity.status, filmsOnly.subsystems.poster.status, filmsOnly.scope.coverage.observations], ['clear', 'clear_in_scope', 'clear_in_scope', 'partial'], 'identity needs the observations and poster needs the summary to claim clear');
assert.equal(evaluate(complete({coverage: {films: 'complete', observations: 'partial'}})).subsystems.identity.status, 'clear_in_scope');
// An object the caller read and found absent is missing evidence, more severe than one the caller did not supply.
const absent = checkResult(evaluate(complete({published: null, predictionQueue: null, letterboxd: undefined})));
assert.equal(one(absent, 'programme/incomplete/subsystem:programme').severity, 'critical');
assert.equal(one(absent, 'programme/incomplete/subsystem:programme').reason, 'evidence_object_missing');
assert.equal(one(absent, 'prediction_queue/incomplete/subsystem:prediction_queue').severity, 'warning');
assert.equal(one(absent, 'letterboxd_archive/incomplete/subsystem:letterboxd_archive').severity, 'info');
assert.equal(absent.subsystems.programme.evidence, 'object_missing');
assert.equal(absent.subsystems.letterboxd_archive.evidence, 'not_supplied');
assert.equal(absent.published.programmeRunId, null);

// Resolved: a healthy film yields nothing; the diff between two evaluations names what went away by stable id.
const healthy = checkResult(evaluate(complete({films: [film('film:ok')]})));
assert.deepEqual(healthy.issues, []);
const earlier = evaluate(complete({films: [film('film:ok', {metadata: {status: 'missing'}}), film('film:other', {localizationConflicts: [{value: 'x'}]})]}));
const later = evaluate(complete({films: [film('film:ok'), film('film:other', {localizationConflicts: [{value: 'x'}]}), film('film:new', {metadata: {status: 'partial', updatedAt: at(-D)}})]}));
const diff = diffHealthIssues(earlier, later);
assert.deepEqual(diff.resolved.map(item => item.id), ['metadata/incomplete/film:film:ok']);
assert.deepEqual(diff.persisting.map(item => item.id), ['localization/conflict/film:film:other']);
assert.deepEqual(diff.appeared.map(item => item.id), ['metadata/incomplete/film:film:new']);
assert.deepEqual(diff.unobserved, []);
assert.deepEqual(diffHealthIssues(null, null), {appeared: [], persisting: [], resolved: [], unobserved: []});
// A subject that left the snapshot is not resolved: another page, a missing projection or a changed generation
// are `unobserved` with their reason; a subject observed again in a bounded page is resolved.
const firstPage = evaluate(complete({coverage: undefined, films: [film('film:p1', {poster: null}), film('film:both', {metadata: {status: 'missing'}})], predictionQueue: queue({hotPending: ['film:x'], lastCheckAt: at(-30 * H), lastBatch: {finishedAt: at(-30 * H), stage: 'complete', reason: null}})}));
const secondPage = evaluate(complete({coverage: undefined, films: [film('film:p2'), film('film:both')]}));
const paged = diffHealthIssues(firstPage, secondPage);
assert.deepEqual(paged.resolved.map(item => item.id), ['prediction_queue/stuck/queue:prediction', 'metadata/incomplete/film:film:both'], 'a film seen again on the next page, and a whole object re-read under the same generation, are resolved');
assert.deepEqual(paged.unobserved.map(entry => [entry.reason, entry.issue.id]), [['subject_not_observed', 'poster/missing_asset/film:film:p1']]);
assert.deepEqual(paged.appeared, []);
const withoutFilms = diffHealthIssues(firstPage, evaluate(complete({films: undefined})));
assert.deepEqual(withoutFilms.resolved.map(item => item.id), ['prediction_queue/stuck/queue:prediction']);
assert.deepEqual(withoutFilms.unobserved.map(entry => [entry.reason, entry.issue.id]), [['source_not_observed', 'metadata/incomplete/film:film:both'], ['source_not_observed', 'poster/missing_asset/film:film:p1']]);
assert.deepEqual(withoutFilms.appeared.map(item => item.id), ['identity/incomplete/subsystem:identity', 'metadata/incomplete/subsystem:metadata', 'localization/incomplete/subsystem:localization', 'fingerprint/incomplete/subsystem:fingerprint', 'prediction/incomplete/subsystem:prediction', 'poster/incomplete/subsystem:poster']);
const regained = diffHealthIssues(evaluate(complete({films: undefined})), evaluate(complete({films: []})));
assert.equal(regained.resolved.length, 6, 'a coverage issue is resolved once its source is observed');
assert.deepEqual(regained.unobserved, []);
const nextGeneration = diffHealthIssues(firstPage, evaluate(complete({published: {...published, programmeRunId: 'gen-3'}, films: [film('film:p1', {programmeRunId: 'gen-3'}), film('film:both', {programmeRunId: 'gen-3'})]})));
assert.deepEqual(nextGeneration.resolved.map(item => item.id), ['metadata/incomplete/film:film:both', 'poster/missing_asset/film:film:p1'], 'films observed again are comparable across generations');
assert.deepEqual(nextGeneration.unobserved.map(entry => [entry.reason, entry.issue.id]), [['generation_changed', 'prediction_queue/stuck/queue:prediction']]);
const queueGone = diffHealthIssues(firstPage, evaluate(complete({films: [film('film:p1', {poster: null}), film('film:both', {metadata: {status: 'missing'}})], predictionQueue: null})));
assert.deepEqual(queueGone.unobserved.map(entry => [entry.reason, entry.issue.id]), [['source_not_observed', 'prediction_queue/stuck/queue:prediction']]);
assert.deepEqual(diffHealthIssues(firstPage, {issues: []}).unobserved.length, 3, 'a result without a scope observes nothing');
// The same Film seen again is not enough: the field the issue is about must be on the record. A known healthy
// value resolves the issue; an omitted field leaves it unobserved.
const dimensionsBefore = evaluate(complete({films: [
  film('film:dim', {poster: null, metadata: {status: 'missing'}, prediction: {status: 'stale', updatedAt: at(-3 * H)}, localizationConflicts: [{value: 'x'}], externalIds: [{scheme: 'tmdb', value: '1', conflicting: true}, {scheme: 'tmdb', value: '2', conflicting: true}]}),
]}));
assert.deepEqual(dimensionsBefore.issues.map(item => item.id).sort(), ['identity/conflict/film:film:dim', 'localization/conflict/film:film:dim', 'metadata/incomplete/film:film:dim', 'poster/missing_asset/film:film:dim', 'prediction/conflict/film:film:dim']);
const thinRecord = diffHealthIssues(dimensionsBefore, evaluate(complete({films: [{id: 'film:dim', programmeRunId: 'gen-2', observedAt: NOW, identity: {status: 'resolved'}, fingerprint: {status: 'current'}}]})));
assert.deepEqual(thinRecord.resolved, [], 'an incomplete projection of the same Film resolves nothing');
assert.deepEqual(thinRecord.unobserved.map(entry => [entry.reason, entry.issue.subsystem]).sort(), [['dimension_not_observed', 'identity'], ['dimension_not_observed', 'localization'], ['dimension_not_observed', 'metadata'], ['dimension_not_observed', 'poster'], ['dimension_not_observed', 'prediction']], 'identity needs externalIds as well');
const healthyRecord = diffHealthIssues(dimensionsBefore, evaluate(complete({films: [film('film:dim')]})));
assert.deepEqual(healthyRecord.resolved.map(item => item.subsystem).sort(), ['identity', 'localization', 'metadata', 'poster', 'prediction'], 'known healthy values resolve every issue');
assert.deepEqual(healthyRecord.unobserved, []);
const posterOnly = diffHealthIssues(dimensionsBefore, evaluate(complete({films: [{id: 'film:dim', programmeRunId: 'gen-2', observedAt: NOW, poster: 'https://image.example/p.jpg', metadata: {status: 'fresh'}}]})));
assert.deepEqual(posterOnly.resolved.map(item => item.subsystem).sort(), ['metadata', 'poster']);
assert.deepEqual(posterOnly.unobserved.map(entry => entry.issue.subsystem).sort(), ['identity', 'localization', 'prediction']);
assert.deepEqual(diffHealthIssues(dimensionsBefore, evaluate(complete({films: [{id: 'film:dim', observedAt: NOW, poster: null, metadata: {status: 'partial', updatedAt: at(-D)}}]}))).persisting.map(item => item.id).sort(), ['metadata/incomplete/film:film:dim', 'poster/missing_asset/film:film:dim']);
for (const [subsystem, fields] of Object.entries(DATA_HEALTH_FILM_FIELDS)) for (const field of fields) assert(['identity', 'externalIds', 'metadata', 'localizationConflicts', 'fingerprint', 'prediction', 'poster'].includes(field), subsystem);
for (const entry of [...paged.unobserved, ...withoutFilms.unobserved, ...nextGeneration.unobserved, ...thinRecord.unobserved]) assert(DATA_HEALTH_UNOBSERVED_REASONS.includes(entry.reason), entry.reason);

// Stale: the programme generation, the metadata and the Letterboxd baseline age against their own thresholds.
const stale = checkResult(evaluate(complete({
  published: {...published, publishedAt: at(-37 * H)},
  films: [film('film:meta', {metadata: {status: 'stale', updatedAt: at(-40 * D), nextAction: 'refresh_metadata'}})],
  letterboxd: {observedAt: NOW, baseline: {confirmedAt: at(-61 * D), sha256: 'b'.repeat(64)}},
})));
const generation = one(stale, 'programme/stale/generation:gen-2');
assert.deepEqual([generation.severity, generation.reason, generation.freshness, generation.threshold], ['warning', 'generation_stale', {status: 'stale', ageMs: 37 * H, thresholdMs: 36 * H}, {code: 'programmeStaleMs', value: 36 * H, unit: 'ms'}]);
assert.deepEqual([generation.action.suggested, generation.action.code, generation.action.eligible], ['investigate', 'check_scheduled_tasks', false]);
const meta = one(stale, 'metadata/stale/film:film:meta');
assert.deepEqual([meta.severity, meta.freshness.status, meta.freshness.ageMs, meta.progress.status, meta.action], ['info', 'stale', 40 * D, 'not_applicable', {suggested: 'bounded_action', code: 'metadata_refresh', eligible: true, reason: 'eligible'}]);
const archive = one(stale, 'letterboxd_archive/external_refresh/archive:letterboxd');
assert.deepEqual([archive.severity, archive.reason, archive.freshness.status, archive.action], ['warning', 'baseline_stale', 'stale', {suggested: 'bounded_action', code: 'archive_import', eligible: false, reason: 'owner_input_required'}]);
assert.equal(archive.provenance.sha256, 'b'.repeat(64));
// Fresh at the threshold is still fresh; the owner can change a threshold without changing the rule.
assert.deepEqual(evaluate(complete({published: {...published, publishedAt: at(-36 * H)}})).issues, []);
assert.equal(evaluate(complete({published: {...published, publishedAt: at(-37 * H)}}), {thresholds: {programmeStaleMs: 48 * H}}).issues.length, 0);
assert.equal(evaluate(complete({published: {...published, publishedAt: at(-37 * H)}}), {thresholds: {programmeStaleMs: 48 * H}}).thresholds.programmeStaleMs, 48 * H);
// A baseline without a date, or no baseline at all, is not fresh.
const undated = one(checkResult(evaluate(complete({letterboxd: {observedAt: NOW, baseline: {sha256: 'c'.repeat(64)}}}))), 'letterboxd_archive/external_refresh/archive:letterboxd');
assert.deepEqual([undated.reason, undated.freshness.status, undated.evidence.completeness, undated.evidence.missing], ['baseline_age_unknown', 'unknown', 'partial', ['baseline.confirmedAt']]);
const noBaseline = one(checkResult(evaluate(complete({letterboxd: {observedAt: NOW, baseline: null}}))), 'letterboxd_archive/external_refresh/archive:letterboxd');
assert.deepEqual([noBaseline.severity, noBaseline.reason, noBaseline.evidence.completeness], ['warning', 'baseline_missing', 'complete']);
// A pointer that is not published is critical, and a missing publication time is incomplete rather than stale.
const withheld = one(checkResult(evaluate(complete({published: {...published, phase: 'withheld'}}))), 'programme/incomplete/generation:gen-2');
assert.deepEqual([withheld.severity, withheld.reason], ['critical', 'generation_not_published']);
const undatedGeneration = one(checkResult(evaluate(complete({published: {...published, publishedAt: undefined}}))), 'programme/incomplete/generation:gen-2');
assert.deepEqual([undatedGeneration.severity, undatedGeneration.reason, undatedGeneration.freshness.status, undatedGeneration.evidence.missing], ['info', 'progress_unknown', 'unknown', ['publishedAt']]);

// Stalled: no retry and no recorded progress for longer than the threshold; recent progress is pending, not stuck.
const stalled = checkResult(evaluate(complete({
  films: [
    film('film:stalled', {identity: {status: 'unresolved', updatedAt: at(-15 * D), attempts: 0, nextAction: 'wait_new_evidence'}}),
    film('film:recent', {identity: {status: 'unresolved', updatedAt: at(-2 * D), attempts: 0, nextAction: 'wait_new_evidence'}}),
    film('film:pending', {prediction: {status: 'stale', updatedAt: at(-15 * D)}}),
  ],
  predictionQueue: queue({coldPending: ['film:pending']}),
})));
const stuckFilm = one(stalled, 'identity/stuck/film:film:stalled');
assert.deepEqual([stuckFilm.severity, stuckFilm.reason, stuckFilm.progress.status, stuckFilm.progress.sinceProgressMs, stuckFilm.threshold.code, stuckFilm.lastProgressAt], ['warning', 'no_progress', 'stalled', 15 * D, 'stalledMs', at(-15 * D)]);
assert.deepEqual(stuckFilm.action, {suggested: 'investigate', code: 'discovery_retry', eligible: true, reason: 'eligible'});
const recent = one(stalled, 'identity/incomplete/film:film:recent');
assert.deepEqual([recent.severity, recent.reason, recent.progress.status, recent.action], ['info', 'work_pending', 'progressing', {suggested: 'wait', code: 'discovery_retry', eligible: false, reason: 'awaiting_progress'}]);
const queuedStalled = one(stalled, 'prediction/stuck/film:film:pending');
assert.deepEqual([queuedStalled.severity, queuedStalled.reason, queuedStalled.provenance.queued], ['warning', 'no_progress', true]);
assert.equal(evaluate(complete({films: [film('film:edge', {identity: {status: 'unresolved', updatedAt: at(-14 * D), nextAction: 'wait_new_evidence'}})]})).issues[0].progress.status, 'progressing', 'exactly the threshold is not stalled');
assert.equal(evaluate(complete({films: [film('film:edge', {identity: {status: 'unresolved', updatedAt: at(-14 * D), nextAction: 'wait_new_evidence'}})]}), {thresholds: {stalledMs: 13 * D}}).issues[0].progress.status, 'stalled');

// Backoff: a retry in the future inside the policy cap is waiting, never stuck; past the grace it is overdue;
// beyond the cap it is an anomaly; many attempts escalate the severity but not the category.
const backoff = checkResult(evaluate(complete({
  films: [
    film('film:waiting', {identity: {status: 'unresolved', retryAt: at(6 * D), attempts: 4, updatedAt: at(-D), nextAction: 'wait_retry'}, metadata: {status: 'failed', retryAt: at(2 * H), attempts: 1, updatedAt: at(-H), failureReason: 'tmdb_failed'}}),
    film('film:due', {identity: {status: 'unresolved', retryAt: at(-H), attempts: 2, updatedAt: at(-2 * D)}}),
    film('film:overdue', {identity: {status: 'unresolved', retryAt: at(-3 * H), attempts: 2, updatedAt: at(-2 * D)}}),
    film('film:beyond', {identity: {status: 'unresolved', retryAt: at(8 * D), attempts: 2, updatedAt: at(-D)}}),
    film('film:many', {identity: {status: 'unresolved', retryAt: at(6 * D), attempts: 5, updatedAt: at(-D)}}),
    film('film:prediction', {prediction: {status: 'failed', updatedAt: at(-2 * H), failureReason: 'parse_error'}}),
  ],
  predictionQueue: queue({hotPending: ['film:prediction'], retries: {'film:prediction': {attempts: 2, retryAt: Date.parse(NOW) + 2 * H, kind: 'parse_error', scope: 'item', failedAt: at(-2 * H), lastRunId: 'run-9'}}}),
})));
assert.equal(backoff.counts.byCategory.stuck, 2, 'only the overdue retry and the backoff beyond policy are stuck');
const waiting = one(backoff, 'identity/incomplete/film:film:waiting');
assert.deepEqual([waiting.severity, waiting.reason, waiting.progress.status, waiting.progress.retryAt, waiting.progress.attempts, waiting.threshold], ['info', 'retry_waiting', 'waiting', at(6 * D), 4, {code: 'discoveryMaxBackoffMs', value: 7 * D, unit: 'ms'}]);
assert.deepEqual(waiting.action, {suggested: 'wait', code: 'discovery_retry', eligible: false, reason: 'in_backoff'});
const waitingMetadata = one(backoff, 'metadata/incomplete/film:film:waiting');
assert.deepEqual([waitingMetadata.progress.status, waitingMetadata.action.reason, waitingMetadata.provenance.failureReason], ['waiting', 'in_backoff', 'tmdb_failed']);
const due = one(backoff, 'identity/incomplete/film:film:due');
assert.deepEqual([due.severity, due.reason, due.progress.status, due.progress.overdueMs, due.action], ['info', 'retry_due', 'due', H, {suggested: 'bounded_action', code: 'discovery_retry', eligible: true, reason: 'eligible'}]);
const overdue = one(backoff, 'identity/stuck/film:film:overdue');
assert.deepEqual([overdue.severity, overdue.reason, overdue.progress.status, overdue.progress.overdueMs, overdue.threshold.code, overdue.action.eligible], ['warning', 'retry_overdue', 'overdue', 3 * H, 'retryGraceMs', true]);
const beyond = one(backoff, 'identity/stuck/film:film:beyond');
assert.deepEqual([beyond.severity, beyond.reason, beyond.progress.status, beyond.threshold.code], ['warning', 'backoff_beyond_policy', 'overdue', 'discoveryMaxBackoffMs']);
const many = one(backoff, 'identity/incomplete/film:film:many');
assert.deepEqual([many.severity, many.reason, many.progress.status, many.category, many.action.reason], ['warning', 'repeated_failures', 'waiting', 'incomplete', 'in_backoff']);
const predictionRetry = one(backoff, 'prediction/incomplete/film:film:prediction');
assert.deepEqual([predictionRetry.progress.status, predictionRetry.progress.retryAt, predictionRetry.progress.attempts, predictionRetry.threshold.code, predictionRetry.provenance.retryScope, predictionRetry.provenance.lastRunId, predictionRetry.action.code], ['waiting', at(2 * H), 2, 'predictionMaxBackoffMs', 'item', 'run-9', 'prediction_retry']);
assert.deepEqual(backoff.clock.anomalies, [], 'a retry time in the future is not clock skew');
// The direct progress rule, at its edges.
const clockFor = {nowMs: Date.parse(NOW), future: value => ({ms: value ? Date.parse(value) : null, skew: false}), at: value => ({ms: value ? Date.parse(value) : null, ageMs: value ? Date.parse(NOW) - Date.parse(value) : null, skew: false}), latest(...values) {const known = values.filter(Boolean).map(value => Date.parse(value)); return known.length ? {ms: Math.max(...known), ageMs: Date.parse(NOW) - Math.max(...known), skew: false} : {ms: null, ageMs: null, skew: false};}};
assert.equal(progressOf({retryAt: at(-2 * H)}, clockFor, DATA_HEALTH_THRESHOLDS, 7 * D).status, 'due', 'exactly the grace is still due');
assert.equal(progressOf({retryAt: at(-2 * H - 1)}, clockFor, DATA_HEALTH_THRESHOLDS, 7 * D).status, 'overdue');
assert.equal(progressOf({retryAt: at(7 * D + 5 * 60000)}, clockFor, DATA_HEALTH_THRESHOLDS, 7 * D).status, 'waiting', 'the cap plus the tolerance is still waiting');
assert.equal(progressOf({retryAt: at(7 * D + 5 * 60000 + 1)}, clockFor, DATA_HEALTH_THRESHOLDS, 7 * D).reason, 'backoff_beyond_policy');
assert.equal(progressOf({terminal: true, retryAt: at(-5 * D)}, clockFor, DATA_HEALTH_THRESHOLDS, 7 * D).status, 'terminal');
assert.equal(progressOf({}, clockFor, DATA_HEALTH_THRESHOLDS, 7 * D).status, 'unknown');
assert.equal(progressOf({attempts: -1, updatedAt: at(-D)}, clockFor, DATA_HEALTH_THRESHOLDS, 7 * D).attempts, null);

// No evidence: a missing observation time is partial evidence, a future timestamp is clock skew and proves nothing,
// a film without the queue projection cannot say whether its work is queued.
const unobserved = checkResult(evaluate(complete({
  films: [
    film('film:unobserved', {observedAt: undefined, metadata: {status: 'partial', updatedAt: at(-D)}}),
    film('film:future', {identity: {status: 'unresolved', updatedAt: at(10 * 60000), nextAction: 'wait_new_evidence'}}),
    film('film:soon', {identity: {status: 'unresolved', updatedAt: at(4 * 60000), nextAction: 'wait_new_evidence'}}),
    film('film:nodate', {identity: {status: 'unresolved', nextAction: 'wait_new_evidence'}}),
  ],
})));
const partial = one(unobserved, 'metadata/incomplete/film:film:unobserved');
assert.deepEqual([partial.evidence.completeness, partial.evidence.missing, partial.observedAt, partial.reason], ['partial', ['observedAt'], null, 'metadata_partial']);
assert.deepEqual(partial.action, {suggested: 'investigate', code: 'metadata_refresh', eligible: null, reason: 'evidence_incomplete'}, 'no observation time: the refresh is named but not eligible');
// Eligibility needs complete evidence on every path that can claim it: metadata, a film poster, the poster summary
// and a due retry.
const skewedEvidence = checkResult(evaluate(complete({
  films: [
    film('film:poster-skew', {poster: null, observedAt: at(10 * 60000)}),
    film('film:poster-unobserved', {poster: null, observedAt: undefined}),
    film('film:meta-skew', {metadata: {status: 'missing'}, observedAt: at(10 * 60000)}),
    film('film:retry-unobserved', {observedAt: undefined, identity: {status: 'unresolved', retryAt: at(-H), attempts: 1, updatedAt: at(-D)}}),
    film('film:retry-complete', {identity: {status: 'unresolved', retryAt: at(-H), attempts: 1, updatedAt: at(-D)}}),
  ],
  posters: {observedAt: at(10 * 60000), programmeRunId: 'gen-2', missingPoster: 3, verifiedMissing: 3, unverifiedMissing: 0},
})));
assert.deepEqual(one(skewedEvidence, 'poster/missing_asset/film:film:poster-skew').action, {suggested: 'investigate', code: 'poster_hydration', eligible: null, reason: 'evidence_incomplete'});
assert.deepEqual(one(skewedEvidence, 'poster/missing_asset/film:film:poster-skew').evidence.anomalies, ['clock_skew']);
assert.deepEqual(one(skewedEvidence, 'poster/missing_asset/film:film:poster-unobserved').action, {suggested: 'investigate', code: 'poster_hydration', eligible: null, reason: 'evidence_incomplete'});
assert.deepEqual(one(skewedEvidence, 'metadata/incomplete/film:film:meta-skew').action, {suggested: 'investigate', code: 'metadata_refresh', eligible: null, reason: 'evidence_incomplete'});
assert.deepEqual(one(skewedEvidence, 'identity/incomplete/film:film:retry-unobserved').action, {suggested: 'investigate', code: 'discovery_retry', eligible: null, reason: 'evidence_incomplete'});
assert.deepEqual(one(skewedEvidence, 'identity/incomplete/film:film:retry-complete').action, {suggested: 'bounded_action', code: 'discovery_retry', eligible: true, reason: 'eligible'});
assert.deepEqual(one(skewedEvidence, 'poster/missing_asset/catalog:published').action, {suggested: 'investigate', code: 'poster_hydration', eligible: null, reason: 'evidence_incomplete'});
assert.deepEqual(one(checkResult(evaluate(complete({posters: {observedAt: undefined, programmeRunId: 'gen-2', missingPoster: 3, verifiedMissing: 3, unverifiedMissing: 0}}))), 'poster/missing_asset/catalog:published').action.eligible, null);
assert.equal(skewedEvidence.issues.filter(item => item.action.eligible === true).length, 1);
const future = one(unobserved, 'identity/incomplete/film:film:future');
assert.deepEqual([future.progress.status, future.progress.sinceProgressMs, future.evidence.anomalies, future.action], ['unknown', null, ['clock_skew'], {suggested: 'investigate', code: 'supply_evidence', eligible: null, reason: 'evidence_incomplete'}]);
assert.deepEqual(unobserved.clock.anomalies, ['clock_skew']);
assert.equal(one(unobserved, 'identity/incomplete/film:film:soon').progress.sinceProgressMs, 0, 'inside the tolerance a future time is now');
const nodate = one(unobserved, 'identity/incomplete/film:film:nodate');
assert.deepEqual([nodate.severity, nodate.reason, nodate.progress.status, nodate.evidence.missing, nodate.action.eligible], ['warning', 'progress_unknown', 'unknown', ['identity.updatedAt'], null]);
const noQueue = checkResult(evaluate(complete({predictionQueue: undefined, films: [film('film:work', {fingerprint: {status: 'missing'}, prediction: {status: 'missing'}})]})));
const unknownQueue = one(noQueue, 'prediction/incomplete/film:film:work');
assert.deepEqual([unknownQueue.evidence.completeness, unknownQueue.evidence.missing, unknownQueue.provenance.queued, unknownQueue.action], ['partial', ['predictionQueue'], null, {suggested: 'investigate', code: 'supply_evidence', eligible: null, reason: 'evidence_incomplete'}]);
assert.equal(noQueue.subsystems.prediction_queue.status, 'unknown');
assert.equal(noQueue.subsystems.prediction.status, 'attention');

// Identity conflict: conflicting external ids, an ambiguous identity, an ambiguous observation and a localization
// conflict are conflicts for manual review; a Letterboxd film kept without TMDB is not a defect.
const conflicts = checkResult(evaluate(complete({
  films: [
    film('film:twins', {identity: {status: 'ambiguous', updatedAt: at(-D), provenance: {conflictingTmdbIds: ['1', '2']}}, externalIds: [{scheme: 'tmdb', value: '1', trusted: false, conflicting: true}, {scheme: 'tmdb', value: '2', trusted: false, conflicting: true}], poster: null}),
    film('film:ambiguous', {identity: {status: 'ambiguous', retryAt: at(D), attempts: 1, updatedAt: at(-D)}}),
    film('film:letterboxd', {identity: {status: 'unresolved', nextAction: 'keep_letterboxd_id'}, externalIds: [{scheme: 'letterboxd', value: 'abc', trusted: true}]}),
    film('film:rejected', {identity: {status: 'rejected', updatedAt: at(-D)}}),
    film('film:titles', {localizationConflicts: [{reason: 'overwrite', value: 'A'}, {reason: 'overwrite', value: 'B'}]}),
  ],
  observations: [
    {key: 'twin|1999', status: 'ambiguous', attempts: 3, lastAttemptAt: at(-D), programmeRunId: 'gen-2', observedAt: NOW},
    {key: 'done|2000', status: 'verified', programmeRunId: 'gen-2', observedAt: NOW},
    {key: 'show|2001', status: 'excluded_nonfilm', programmeRunId: 'gen-2', observedAt: NOW},
    {key: 'wait|2002', status: 'needs_verification', attempts: 2, retryAt: at(D), lastAttemptAt: at(-D), programmeRunId: 'gen-2', observedAt: NOW},
    {key: 'final|2003', status: 'no_confident_match', attempts: 4, retryAt: null, lastAttemptAt: at(-3 * D), terminalReason: 'repeated_uncertain_match', programmeRunId: 'gen-2', observedAt: NOW},
    {status: 'needs_verification'},
  ],
})));
const twins = one(conflicts, 'identity/conflict/film:film:twins');
assert.deepEqual([twins.severity, twins.reason, twins.progress.status, twins.action], ['warning', 'identity_conflict', 'not_applicable', {suggested: 'investigate', code: 'manual_review', eligible: false, reason: 'manual_review_required'}]);
assert.deepEqual(one(conflicts, 'poster/missing_asset/film:film:twins').action, {suggested: 'investigate', code: 'manual_review', eligible: false, reason: 'identity_unverified'}, 'no hydration for a conflicting identity');
assert.equal(one(conflicts, 'identity/conflict/film:film:ambiguous').reason, 'identity_ambiguous');
assert.equal(only(conflicts, 'identity').some(item => item.subject.id === 'film:letterboxd'), false);
const rejected = one(conflicts, 'identity/incomplete/film:film:rejected');
assert.deepEqual([rejected.progress.status, rejected.reason, rejected.action.reason], ['terminal', 'terminal_without_resolution', 'terminal']);
const titles = one(conflicts, 'localization/conflict/film:film:titles');
assert.deepEqual([titles.severity, titles.affected, titles.action.code], ['info', {count: 2, sample: ['film:titles']}, 'manual_review']);
const twinObservation = one(conflicts, 'identity/conflict/observation:twin|1999');
assert.deepEqual([twinObservation.severity, twinObservation.reason, twinObservation.lastProgressAt, twinObservation.evidence.source], ['warning', 'identity_ambiguous', at(-D), 'observations']);
assert.equal(only(conflicts, 'identity').filter(item => item.subject.kind === 'observation').length, 3, 'verified, excluded and keyless entries yield nothing');
assert.deepEqual(one(conflicts, 'identity/incomplete/observation:wait|2002').action, {suggested: 'wait', code: 'discovery_retry', eligible: false, reason: 'in_backoff'});
const terminalObservation = one(conflicts, 'identity/incomplete/observation:final|2003');
assert.deepEqual([terminalObservation.severity, terminalObservation.progress.status, terminalObservation.provenance.terminalReason, terminalObservation.action.reason], ['warning', 'terminal', 'repeated_uncertain_match', 'terminal']);

// Stale pin: the caller's generation differs from the published one; records of the old generation keep their
// evidence partial and their actions wait for a re-read; projections of another generation are stale.
const pinned = checkResult(evaluate(complete({
  pin: {programmeRunId: 'gen-1'},
  films: [
    film('film:old', {programmeRunId: 'gen-1', metadata: {status: 'missing'}, identity: {status: 'unresolved', retryAt: at(-5 * H), updatedAt: at(-D)}, poster: null}),
    film('film:current', {metadata: {status: 'missing'}}),
  ],
  predictionQueue: queue({programmeRunId: 'gen-1', hotPending: ['film:a', 'film:b']}),
  discovery: {stage: 'paused', reason: 'chunk_budget', at: at(-H), nextCatchUpAt: at(H), remainingChunks: 2, programmeRunId: 'gen-1', observedAt: NOW},
  posters: {observedAt: NOW, programmeRunId: 'gen-1', missingPoster: 3, verifiedMissing: 2, unverifiedMissing: 1, sample: ['film:z', 'film:y']},
})));
const pin = one(pinned, 'programme/stale/generation:gen-1');
assert.deepEqual([pin.severity, pin.reason, pin.provenance.pinnedProgrammeRunId, pin.provenance.programmeRunId, pin.action], ['warning', 'pin_generation_changed', 'gen-1', 'gen-2', {suggested: 'wait', code: 'reread_snapshot', eligible: false, reason: 'generation_changed'}]);
const oldFilm = one(pinned, 'metadata/incomplete/film:film:old');
assert.deepEqual([oldFilm.evidence.completeness, oldFilm.evidence.anomalies, oldFilm.action], ['partial', ['projection_generation_differs'], {suggested: 'wait', code: 'reread_snapshot', eligible: false, reason: 'generation_changed'}]);
assert.deepEqual(one(pinned, 'identity/stuck/film:film:old').action, {suggested: 'wait', code: 'reread_snapshot', eligible: false, reason: 'generation_changed'}, 'an overdue retry of another generation is not eligible');
assert.deepEqual(one(pinned, 'poster/missing_asset/film:film:old').action.reason, 'generation_changed');
assert.deepEqual(one(pinned, 'metadata/incomplete/film:film:current').action, {suggested: 'bounded_action', code: 'metadata_refresh', eligible: true, reason: 'eligible'});
const staleQueue = one(pinned, 'prediction_queue/stale/queue:prediction');
assert.deepEqual([staleQueue.severity, staleQueue.reason, staleQueue.affected, staleQueue.provenance.publishedProgrammeRunId], ['warning', 'projection_generation_differs', {count: 2, sample: ['film:a', 'film:b']}, 'gen-2']);
assert.deepEqual(one(pinned, 'prediction_queue/incomplete/queue:prediction').action.reason, 'generation_changed');
assert.deepEqual([one(pinned, 'discovery/stale/continuation:discovery').severity, one(pinned, 'discovery/stale/continuation:discovery').action.code], ['info', 'reread_snapshot']);
assert.deepEqual(one(pinned, 'poster/missing_asset/catalog:published').action.reason, 'generation_changed');
assert.equal(evaluate(complete({pin: {programmeRunId: 'gen-2'}})).issues.length, 0, 'a matching pin is silent');
assert.equal(evaluate(complete({pin: 'gen-1'})).issues.length, 0, 'a malformed pin is ignored');
assert.equal(evaluate({now: NOW, pin: {programmeRunId: 'gen-1'}, films: [film('film:old', {programmeRunId: 'gen-1', metadata: {status: 'missing'}})]}).issues.find(item => item.id === 'metadata/incomplete/film:film:old').evidence.anomalies.length, 0, 'without a published pointer no generation comparison is made');

// The prediction queue as a whole: eligible work nobody takes is stuck after a day; all-deferred work waits;
// a deferral beyond the policy cap is an anomaly; progress without a recorded check is unknown.
const queueStuck = one(checkResult(evaluate(complete({predictionQueue: queue({hotPending: ['film:h1', 'film:h2'], coldPending: ['film:c1'], lastCheckAt: at(-25 * H), lastBatch: {finishedAt: at(-26 * H), stage: 'complete', reason: 'time_budget'}})}))), 'prediction_queue/stuck/queue:prediction');
assert.deepEqual([queueStuck.severity, queueStuck.reason, queueStuck.progress.status, queueStuck.progress.sinceProgressMs, queueStuck.affected, queueStuck.provenance.eligible, queueStuck.provenance.lastReason, queueStuck.action], ['warning', 'eligible_work_without_runs', 'stalled', 25 * H, {count: 3, sample: ['film:c1', 'film:h1', 'film:h2']}, 3, 'time_budget', {suggested: 'investigate', code: 'check_scheduled_tasks', eligible: false, reason: 'no_action_defined'}]);
const queueBusy = one(checkResult(evaluate(complete({predictionQueue: queue({hotPending: ['film:h1'], lastCheckAt: at(-23 * H)})}))), 'prediction_queue/incomplete/queue:prediction');
assert.deepEqual([queueBusy.severity, queueBusy.reason, queueBusy.progress.status, queueBusy.action.reason], ['info', 'work_pending', 'progressing', 'already_queued']);
const queueDeferred = one(checkResult(evaluate(complete({predictionQueue: queue({coldPending: ['film:c1', 'film:c2'], retries: {'film:c1': {attempts: 1, retryAt: Date.parse(NOW) + 3 * H}, 'film:c2': {attempts: 2, retryAt: Date.parse(NOW) + H}}, lastCheckAt: at(-30 * H)})}))), 'prediction_queue/incomplete/queue:prediction');
assert.deepEqual([queueDeferred.severity, queueDeferred.reason, queueDeferred.progress.status, queueDeferred.progress.retryAt, queueDeferred.affected.count, queueDeferred.action], ['info', 'all_deferred_by_retry', 'waiting', at(H), 2, {suggested: 'wait', code: 'prediction_retry', eligible: false, reason: 'in_backoff'}]);
const queueBeyond = one(checkResult(evaluate(complete({predictionQueue: queue({coldPending: ['film:c1'], retries: {'film:c1': {attempts: 1, retryAt: Date.parse(NOW) + 7 * H}}})}))), 'prediction_queue/stuck/queue:prediction');
assert.deepEqual([queueBeyond.severity, queueBeyond.reason, queueBeyond.threshold.code], ['warning', 'backoff_beyond_policy', 'predictionMaxBackoffMs']);
const queueUnknown = one(checkResult(evaluate(complete({predictionQueue: {observedAt: NOW, programmeRunId: 'gen-2', hotPending: ['film:h1'], retries: {}}}))), 'prediction_queue/incomplete/queue:prediction');
assert.deepEqual([queueUnknown.severity, queueUnknown.reason, queueUnknown.evidence.completeness, queueUnknown.evidence.missing, queueUnknown.action.eligible], ['warning', 'progress_unknown', 'partial', ['lastCheckAt'], null]);
assert.equal(evaluate(complete({predictionQueue: queue({pending: []})})).issues.length, 0, 'a drained queue is clear');
// A stale prediction the refreshed queue does not list disagrees with the film; before the refresh it is only a note.
const disagreement = checkResult(evaluate(complete({
  films: [film('film:missing', {prediction: {status: 'stale', updatedAt: at(-3 * H)}}), film('film:fresh', {prediction: {status: 'stale', updatedAt: at(-10 * 60000)}})],
  predictionQueue: queue({coldPending: ['film:elsewhere']}),
})));
assert.deepEqual([one(disagreement, 'prediction/conflict/film:film:missing').severity, one(disagreement, 'prediction/conflict/film:film:missing').evidence.completeness], ['warning', 'complete']);
assert.deepEqual([one(disagreement, 'prediction/conflict/film:film:fresh').severity, one(disagreement, 'prediction/conflict/film:film:fresh').evidence.missing], ['info', ['predictionQueue.lastCheckAt']]);

// The discovery continuation: a valid gate waits, a passed gate is stuck, a running record older than its lease is
// stuck, a finished or idle record is clear.
const continuation = fields => complete({discovery: {stage: 'paused', reason: 'backoff', at: at(-H), retryAt: at(2 * H), nextCatchUpAt: at(2 * H), remainingChunks: 3, programmeRunId: 'gen-2', observedAt: NOW, ...fields}});
const gateWait = one(checkResult(evaluate(continuation())), 'discovery/incomplete/continuation:discovery');
assert.deepEqual([gateWait.severity, gateWait.reason, gateWait.progress.status, gateWait.affected.count, gateWait.action], ['info', 'retry_waiting', 'waiting', 3, {suggested: 'wait', code: 'discovery_retry', eligible: false, reason: 'in_backoff'}]);
const gateDue = one(checkResult(evaluate(continuation({retryAt: null, nextCatchUpAt: at(-H), reason: 'chunk_budget'}))), 'discovery/incomplete/continuation:discovery');
assert.deepEqual([gateDue.progress.status, gateDue.action.reason], ['due', 'already_queued']);
const gatePassed = one(checkResult(evaluate(continuation({retryAt: null, nextCatchUpAt: at(-3 * H), reason: 'chunk_budget', at: at(-4 * H)}))), 'discovery/stuck/continuation:discovery');
assert.deepEqual([gatePassed.severity, gatePassed.reason, gatePassed.progress.status, gatePassed.action], ['warning', 'continuation_not_advanced', 'overdue', {suggested: 'investigate', code: 'check_scheduled_tasks', eligible: false, reason: 'no_action_defined'}]);
const errorRecent = one(checkResult(evaluate(continuation({stage: 'error', reason: 'discovery_failed', retryAt: null, nextCatchUpAt: null, at: at(-10 * 60000)}))), 'discovery/incomplete/continuation:discovery');
assert.deepEqual([errorRecent.severity, errorRecent.progress.status, errorRecent.action.reason], ['info', 'progressing', 'awaiting_progress']);
const errorOld = one(checkResult(evaluate(continuation({stage: 'error', reason: 'discovery_failed', retryAt: null, nextCatchUpAt: null, at: at(-15 * D)}))), 'discovery/stuck/continuation:discovery');
assert.deepEqual([errorOld.progress.status, errorOld.reason], ['stalled', 'continuation_not_advanced']);
const errorUndated = one(checkResult(evaluate(continuation({stage: 'error', retryAt: null, nextCatchUpAt: null, at: null}))), 'discovery/incomplete/continuation:discovery');
assert.deepEqual([errorUndated.severity, errorUndated.reason, errorUndated.evidence.missing, errorUndated.action.eligible], ['warning', 'progress_unknown', ['at'], null]);
const runningFresh = evaluate(continuation({stage: 'running', reason: null, retryAt: null, at: at(-10 * 60000)}));
assert.equal(only(runningFresh, 'discovery').length, 0);
const runningStale = one(checkResult(evaluate(continuation({stage: 'running', reason: null, retryAt: null, at: at(-31 * 60000)}))), 'discovery/stuck/continuation:discovery');
assert.deepEqual([runningStale.severity, runningStale.reason, runningStale.freshness.status, runningStale.threshold.code, runningStale.action.code], ['warning', 'continuation_running_stale', 'stale', 'continuationRunningStaleMs', 'manual_review']);
for (const stage of ['complete', 'idle']) assert.equal(only(evaluate(continuation({stage, reason: null, retryAt: null, nextCatchUpAt: null, remainingChunks: 0})), 'discovery').length, 0, stage);
assert.equal(only(evaluate(continuation({reason: 'programme_changed', retryAt: null, nextCatchUpAt: null, remainingChunks: 0})), 'discovery').length, 0, 'a paused record with nothing left is clear');

// Posters: a film without a poster is a missing asset, eligible for hydration only with a trusted TMDB identity;
// the catalog summary aggregates and counts without listing the bucket.
const posters = checkResult(evaluate(complete({
  films: [film('film:bare', {poster: null}), film('film:untrusted', {poster: null, externalIds: [{scheme: 'tmdb', value: '9', trusted: false}]}), film('film:unknown', {poster: undefined})],
  posters: {observedAt: NOW, programmeRunId: 'gen-2', catalogRecords: 40, missingPoster: 7, verifiedMissing: 5, unverifiedMissing: 2, sample: ['film:q', 'film:p', 'film:o', 'film:n', 'film:m', 'film:l']},
})));
assert.deepEqual(one(posters, 'poster/missing_asset/film:film:bare').action, {suggested: 'bounded_action', code: 'poster_hydration', eligible: true, reason: 'eligible'});
assert.deepEqual(one(posters, 'poster/missing_asset/film:film:untrusted').action.reason, 'identity_unverified');
assert.equal(only(posters, 'poster').some(item => item.subject.id === 'film:unknown'), false, 'an absent poster field is not a missing poster');
const summary = one(posters, 'poster/missing_asset/catalog:published');
assert.deepEqual([summary.affected, summary.provenance.verifiedMissing, summary.action.eligible], [{count: 7, sample: ['film:l', 'film:m', 'film:n', 'film:o', 'film:p']}, 5, true]);
assert.equal(only(evaluate(complete({posters: {observedAt: NOW, programmeRunId: 'gen-2', missingPoster: 0}})), 'poster').length, 0);
assert.deepEqual(one(checkResult(evaluate(complete({posters: {observedAt: NOW, programmeRunId: 'gen-2'}}))), 'poster/incomplete/catalog:published').action, {suggested: 'investigate', code: 'supply_evidence', eligible: null, reason: 'evidence_incomplete'});
assert.equal(one(checkResult(evaluate(complete({posters: {observedAt: NOW, programmeRunId: 'gen-2', missingPoster: 4, verifiedMissing: 0, unverifiedMissing: 4}}))), 'poster/missing_asset/catalog:published').action.reason, 'identity_unverified');

// Determinism, order and deduplication: input order never changes the output, a repeated subject is one issue,
// the more severe duplicate wins, and the caller's records are never modified.
const mixed = complete({
  pin: {programmeRunId: 'gen-1'},
  films: [
    film('film:b', {metadata: {status: 'missing'}}),
    film('film:a', {metadata: {status: 'missing'}}),
    film('film:c', {identity: {status: 'ambiguous'}}),
    film('film:a', {metadata: {status: 'stale', updatedAt: at(-50 * D)}}),
    film('film:b', {metadata: {status: 'missing'}, observedAt: undefined}),
    {id: 42}, null, 'film',
  ],
  observations: [{key: 'z|1', status: 'ambiguous', programmeRunId: 'gen-2', observedAt: NOW}, {key: 'a|1', status: 'ambiguous', programmeRunId: 'gen-2', observedAt: NOW}],
  predictionQueue: queue({hotPending: ['film:q'], lastCheckAt: at(-30 * H), lastBatch: {finishedAt: at(-30 * H), stage: 'complete', reason: null}}),
});
const ordered = checkResult(evaluate(mixed));
const shuffled = checkResult(evaluate({...mixed, films: [...mixed.films].reverse(), observations: [...mixed.observations].reverse()}));
assert.deepEqual(plain(shuffled), plain(ordered));
assert.deepEqual(ordered.issues.map(item => item.id), [
  'identity/conflict/film:film:c',
  'identity/conflict/observation:a|1',
  'identity/conflict/observation:z|1',
  'prediction_queue/stuck/queue:prediction',
  'programme/stale/generation:gen-1',
  'metadata/incomplete/film:film:a',
  'metadata/incomplete/film:film:b',
  'metadata/stale/film:film:a',
]);
const duplicate = one(ordered, 'metadata/incomplete/film:film:b');
assert.deepEqual([duplicate.evidence.completeness, duplicate.evidence.anomalies, duplicate.affected.count], ['partial', ['duplicate_subject'], 1], 'the weaker evidence wins on equal severity; the count is not doubled');
const escalated = evaluate(complete({films: [film('film:d', {identity: {status: 'unresolved', retryAt: at(D), updatedAt: at(-D)}}), film('film:d', {identity: {status: 'unresolved', retryAt: at(-5 * H), updatedAt: at(-D)}})]}));
assert.deepEqual(escalated.issues.map(item => [item.id, item.severity]), [['identity/stuck/film:film:d', 'warning'], ['identity/incomplete/film:film:d', 'info']], 'different categories of one subject are different issues');
const sameCategory = evaluate(complete({films: [film('film:e', {identity: {status: 'unresolved', retryAt: at(-5 * H), updatedAt: at(-D)}}), film('film:e', {identity: {status: 'unresolved', updatedAt: at(-20 * D)}})]}));
assert.deepEqual(sameCategory.issues.map(item => [item.id, item.reason, item.evidence.anomalies]), [['identity/stuck/film:film:e', 'retry_overdue', ['duplicate_subject']]], 'equal severity keeps the earlier record');
const original = complete({films: [film('film:f', {metadata: {status: 'missing'}})]});
const copy = structuredClone(original);
evaluateDataHealth(original);
assert.deepEqual(original, copy, 'the snapshot is not modified');
assert.deepEqual(plain(evaluateDataHealth(original)), plain(evaluateDataHealth(structuredClone(original))), 'the same snapshot gives the same result');
assert.equal(JSON.stringify(evaluateDataHealth(original)).includes('undefined'), false);

// Stable ids and the comparator.
assert.equal(healthIssueId('identity', 'stuck', {kind: 'film', id: 'film:x'}), 'identity/stuck/film:film:x');
assert.equal(compareHealthIssues({severity: 'warning', category: 'stuck', subsystem: 'identity', subject: {kind: 'film', id: 'a'}, id: '1'}, {severity: 'info', category: 'conflict', subsystem: 'programme', subject: {kind: 'generation', id: 'a'}, id: '0'}) < 0, true, 'severity first');
assert.equal(compareHealthIssues({severity: 'info', category: 'stuck', subsystem: 'prediction', subject: {kind: 'film', id: 'a'}, id: '1'}, {severity: 'info', category: 'conflict', subsystem: 'identity', subject: {kind: 'film', id: 'a'}, id: '0'}) > 0, true, 'then category');

console.log('Data health: schema, thresholds, coverage, empty, stale, stalled, backoff, no evidence, eligibility guard, conflicts, resolved and unobserved, stale pin, queue, discovery, posters and determinism passed');
