// AIR-557: one classifier derives `presentationStatus` (success | warning | interrupted | error | none) from the structured fields of a stored event,
// a «Результат» filter combines with the type filter, and the choice lives in the URL. Pure functions only: the fetch and the stored events are untouched.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const ctx = vm.createContext({URL, URLSearchParams, Set, Map, Date, Intl, document: {querySelector: () => null, querySelectorAll: () => []}, window: {location: {href: 'https://iptv.example/'}}});
vm.runInContext(fs.readFileSync('public/return-home.js', 'utf8') + '\n' + app.replace(/init\(\);\s*$/, ''), ctx);
const run = code => vm.runInContext(code, ctx);
const status = event => run(`eventPresentationStatus(${JSON.stringify(event)})`);

// Contract table: structured fields only. Titles and translations never matter.
const terminal = extra => ({type: 'enrichment', presentation: 'batch_v2_terminal', queueSchemaVersion: 6, ...extra});
const table = [
  // Predictions
  [terminal({stage: 'complete', delta: {failed: 0}}), 'success', 'complete, no failures'],
  [terminal({stage: 'complete', stopReason: 'manifest_spent'}), 'success', 'complete, manifest spent'],
  [terminal({stage: 'complete', delta: {failed: 2}}), 'warning', 'complete with per-film failures'],
  [terminal({stage: 'complete', failed: 1}), 'warning', 'failures on the event itself'],
  [{type: 'enrichment', presentation: 'batch_v2_skipped', stage: 'skipped', reason: 'already_running'}, 'warning', 'skipped start (AIR-548)'],
  [{type: 'enrichment', presentation: 'batch_v2_skipped', stage: 'skipped', reason: 'catalog_held', cause: 'discovery_incomplete'}, 'warning', 'start refused for a held catalog (AIR-575): a warning, not an error or an interruption'],
  [terminal({stage: 'partial', stopReason: 'quota'}), 'warning', 'quota'],
  [terminal({stage: 'partial', stopReason: 'time_budget'}), 'warning', 'time budget'],
  [terminal({stage: 'partial', reason: 'api_error'}), 'error', 'api_error via reason'],
  [terminal({stage: 'partial', stopReason: 'storage_error'}), 'error', 'storage_error'],
  [terminal({stage: 'partial', stopReason: 'model_error'}), 'error', 'model_error'],
  [terminal({stage: 'partial', stopReason: 'model_unavailable'}), 'error', 'model_unavailable'],
  [terminal({stage: 'partial', stopReason: 'format_error_storm'}), 'error', 'format_error_storm'],
  [terminal({stage: 'partial', stopReason: 'priority_changed'}), 'interrupted', 'priority_changed'],
  [terminal({stage: 'partial', stopReason: 'profile_changed'}), 'interrupted', 'profile_changed'],
  [terminal({stage: 'partial', stopReason: 'runner_aborted'}), 'interrupted', 'runner_aborted'],
  [terminal({stage: 'partial', stopReason: 'external_termination'}), 'interrupted', 'external_termination'],
  [terminal({stage: 'partial', stopReason: 'something_new'}), 'warning', 'unknown stop code: attention, not a proven failure'],
  [terminal({stage: 'partial', stopReason: 'api_error', reason: 'priority_changed'}), 'error', 'collision: stopReason wins over reason, error over interruption'],
  [{type: 'enrichment', stage: 'started', queueSchemaVersion: 6}, null, 'start has no result'],
  [{type: 'enrichment', stage: 'resumed', queueSchemaVersion: 6}, null, 'resume has no result'],
  [{type: 'enrichment', stage: 'running', queueSchemaVersion: 6}, null, 'running progress is intermediate'],
  [{type: 'enrichment', stage: 'running', queueSchemaVersion: 4, reason: 'api_error'}, null, 'a progress record never gets a result, whatever its reason'],
  [{type: 'enrichment'}, null, 'bare legacy enrichment: no stage, no result'],
  [{type: 'enrichment', stage: 'mystery', queueSchemaVersion: 5}, null, 'unknown stage'],
  [{type: 'enrichment', presentation: 'batch_v2_terminal', stage: 'running'}, null, 'terminal packet in a running stage is inconsistent'],
  [{type: 'enrichment', presentation: 'batch_v2_terminal', stage: 'running', stopReason: 'api_error'}, null, 'a running stage with an error-looking reason is not an error'],
  [{type: 'enrichment', presentation: 'batch_v2_terminal', stopReason: 'api_error'}, null, 'terminal packet with no stage'],
  [{type: 'enrichment', presentation: 'batch_v2_terminal', stage: 'mystery', stopReason: 'priority_changed'}, null, 'terminal packet with an unknown stage'],
  [{type: 'enrichment', presentation: 'batch_v2_terminal', stage: 'started'}, null, 'terminal packet claiming a start'],
  [{type: 'enrichment', presentation: 'batch_v2_skipped', stage: 'running'}, 'warning', 'the skipped exception keeps its result'],
  [{type: 'enrichment', presentation: 'something_new', stage: 'complete'}, null, 'unknown presentation'],
  // Historical enrichment runs (v3-v6, no `presentation`): classified only by the stored end stage.
  [{type: 'enrichment', stage: 'completed', queueSchemaVersion: 6, delta: {failed: 0}}, 'success', 'legacy v6 completed'],
  [{type: 'enrichment', stage: 'complete', queueSchemaVersion: 5, failed: 0}, 'success', 'legacy v5 complete'],
  [{type: 'enrichment', stage: 'complete', queueSchemaVersion: 3, failed: 3}, 'warning', 'legacy v3 complete with failures'],
  [{type: 'enrichment', stage: 'partial', reason: 'api_error', queueSchemaVersion: 5}, 'error', 'legacy v5 partial, api_error'],
  [{type: 'enrichment', stage: 'partial', reason: 'priority_changed', queueSchemaVersion: 5}, 'interrupted', 'legacy v5 partial, priority_changed'],
  [{type: 'enrichment', stage: 'partial', reason: 'quota', queueSchemaVersion: 4}, 'warning', 'legacy partial, quota'],
  [{type: 'enrichment', stage: 'partial', queueSchemaVersion: 4}, 'warning', 'legacy partial, no reason: attention, not a proven failure'],
  [{type: 'enrichment', stage: 'partial', reason: 'queue_empty', queueSchemaVersion: 6}, 'success', 'legacy partial with a normal reason'],
  [{type: 'enrichment', stage: 'blocked', reason: 'retry_backoff', queueSchemaVersion: 5}, 'warning', 'legacy blocked waits for the next run'],
  [{type: 'enrichment', stage: 'blocked', reason: 'model_unavailable', queueSchemaVersion: 6}, 'error', 'legacy blocked by a systemic error'],
  [{type: 'enrichment', stage: 'interrupted', stopReason: 'lease_expired', queueSchemaVersion: 6}, 'interrupted', 'legacy interrupted run'],
  // Discovery
  [{type: 'discovery', kind: 'hour', status: 'idle', checked: 0, added: 0}, 'success', 'nothing new is not a warning'],
  [{type: 'discovery', kind: 'hour', status: 'empty', checked: 3, added: 1}, 'success', 'hour report'],
  [{type: 'discovery', kind: 'hour', status: 'running', checked: 3, added: 1}, 'success', 'running, clean report with results: the report is published'],
  [{type: 'discovery', kind: 'hour', status: 'running', checked: 588, added: 39, remaining: 6155}, 'success', 'running, the production shape of 20 Nov 18:00 Madrid (39 found, 6155 left)'],
  [{type: 'discovery', kind: 'hour', status: 'running', checked: 0, added: 0}, 'warning', 'AIR-695: running, zero counters = «полезного прогресса за час нет», a warning'],
  [{type: 'discovery', kind: 'hour', status: 'running', checked: 0, added: 0, remaining: null}, 'warning', 'AIR-695: running, zero counters, unknown remainder'],
  [{type: 'discovery', kind: 'hour', status: 'running', checked: 0, added: 0, queueEmpty: true}, 'success', 'AIR-695: running with an empty queue is the empty-queue title, a success'],
  [{type: 'discovery', kind: 'hour', status: 'running', checked: 5, added: 0}, 'success', 'AIR-695: observations processed, no new films: still a success'],
  [{type: 'discovery', kind: 'hour', status: 'idle', checked: 0, added: 0}, 'success', 'AIR-695: idle with zero counters keeps its semantics'],
  [{type: 'discovery', kind: 'hour', status: 'empty', checked: 0, added: 0}, 'success', 'AIR-695: empty with zero counters keeps its semantics'],
  [{type: 'discovery', kind: 'hour', status: 'running', checked: 3, added: 1, incomplete: true}, 'warning', 'running + incomplete'],
  [{type: 'discovery', kind: 'hour', status: 'running', checked: 3, added: 1, queueUnreadable: true}, 'warning', 'running + queueUnreadable'],
  [{type: 'discovery', kind: 'hour', status: 'running', checked: null, added: null}, 'warning', 'running, counters unreadable'],
  [{type: 'discovery', kind: 'hour', status: 'running', incomplete: true, queueUnreadable: true}, 'warning', 'running, several warning fields'],
  [{type: 'discovery', kind: 'hour', status: 'idle', checked: 4, added: 2}, 'success', 'normal idle'],
  [{type: 'discovery', kind: 'hour', status: 'empty', checked: 4, added: 2, queueEmpty: true}, 'success', 'normal empty'],
  [{type: 'discovery', kind: 'hour', status: 'unknown', checked: 0, added: 0}, null, 'unrecognised status is not a success'],
  [{type: 'discovery', kind: 'hour', checked: 2, added: 1}, null, 'missing status is not a success'],
  [{type: 'discovery', kind: 'hour', status: 'unknown', checked: 1, added: 0, incomplete: true}, 'warning', 'an unrecognised status with an incomplete report still warns'],
  [{type: 'discovery', kind: 'hour', status: 'failed', checked: 0, added: 0}, 'error', 'hour failed'],
  [{type: 'discovery', kind: 'hour', status: 'stalled'}, 'error', 'hour stalled'],
  [{type: 'discovery', kind: 'hour', status: 'waiting', checked: 1, added: 0}, 'warning', 'waiting'],
  [{type: 'discovery', kind: 'hour', status: 'blocked'}, 'warning', 'blocked'],
  [{type: 'discovery', kind: 'hour', status: 'idle', incomplete: true}, 'warning', 'incomplete report'],
  [{type: 'discovery', kind: 'hour', status: 'idle', checked: 1, added: 0, queueUnreadable: true}, 'warning', 'queueUnreadable'],
  [{type: 'discovery', kind: 'hour', status: 'failed', incomplete: true}, 'error', 'collision: confirmed failure beats incomplete'],
  [{type: 'discovery', kind: 'report_failed'}, 'warning', 'report_failed, unknown state'],
  [{type: 'discovery', kind: 'report_failed', status: 'idle'}, 'warning', 'report_failed, non-alarming state'],
  [{type: 'discovery', kind: 'report_failed', status: 'waiting'}, 'warning', 'report_failed + waiting'],
  [{type: 'discovery', kind: 'report_failed', status: 'failed'}, 'error', 'report_failed + confirmed failed'],
  [{type: 'discovery', kind: 'report_failed', status: 'stalled'}, 'error', 'report_failed + confirmed stalled'],
  [{type: 'discovery', status: 'superseded'}, 'interrupted', 'legacy superseded'],
  [{type: 'discovery', status: 'failed'}, 'error', 'legacy failed'],
  [{type: 'discovery', kind: 'run', status: 'finished', reason: 'complete'}, 'success', 'legacy run finished'],
  [{type: 'discovery', kind: 'run', status: 'finished', reason: 'backlog_empty'}, 'success', 'legacy run, backlog empty'],
  [{type: 'discovery', kind: 'run', status: 'superseded'}, 'interrupted', 'legacy run superseded'],
  [{type: 'discovery', kind: 'run', status: 'failed', reason: 'recovery_exhausted'}, 'error', 'legacy run failed'],
  [{type: 'discovery', kind: 'run', status: 'stopped', reason: 'executor_not_workflow'}, null, 'legacy stopped is a refusal, not an outcome'],
  [{type: 'discovery', kind: 'empty'}, null, 'legacy empty record has no stored result'],
  [{type: 'discovery'}, null, 'bare discovery record'],
  // Ratings
  [{type: 'ratings', state: 'finished'}, 'success', 'finished'],
  [{type: 'ratings', state: 'finished', cause: 'blocked'}, 'success', 'finished wins over a stray cause'],
  [{type: 'ratings', state: 'error', cause: 'rate_limited'}, 'warning', 'rate_limited is temporary'],
  [{type: 'ratings', state: 'error', cause: 'blocked'}, 'warning', 'blocked is temporary'],
  [{type: 'ratings', state: 'error', cause: 'failed'}, 'error', 'confirmed error'],
  [{type: 'ratings', state: 'error'}, 'error', 'state=error'],
  [{type: 'ratings', state: 'unknown'}, 'interrupted', 'unknown'],
  [{type: 'ratings', state: 'interrupted', cause: 'abandoned'}, 'interrupted', 'abandoned'],
  [{type: 'ratings', state: 'something'}, null, 'unknown state'],
  // AIR-694: the stored shape without state/cause (slot outcome + reason only) is classified from those structured fields.
  [{type: 'ratings', status: 'error', outcome: 'error', reason: 'lease_lost'}, 'interrupted', 'legacy lease_lost'],
  [{type: 'ratings', outcome: 'interrupted', reason: 'lease_lost'}, 'interrupted', 'legacy interrupted'],
  [{type: 'ratings', outcome: 'error', reason: 'network_error'}, 'error', 'legacy confirmed error'],
  [{type: 'ratings', outcome: 'blocked'}, 'warning', 'legacy blocked'],
  [{type: 'ratings', outcome: 'rate_limited'}, 'warning', 'legacy rate_limited'],
  [{type: 'ratings', outcome: 'finished'}, 'success', 'legacy finished'],
  [{type: 'ratings', state: 'unknown', cause: 'interrupted', diary: null, removal: null, interruptedPhase: 'diary'}, 'interrupted', 'AIR-694 honest unknown contract'],
  // Catalog posters (not the same thing as the `outcome` of another event type)
  [{type: 'catalog_posters', outcome: 'completed', noPoster: 5}, 'success', 'completed; noPoster is not a warning'],
  [{type: 'catalog_posters', outcome: 'deferred'}, 'warning', 'deferred'],
  [{type: 'catalog_posters', final: false}, 'warning', 'deferred by final=false'],
  [{type: 'catalog_posters', outcome: 'failed'}, 'error', 'failed'],
  [{type: 'catalog_posters'}, null, 'no outcome'],
  // AIR-594: Canonical Producer («Обогащение каталога»)
  [{type: 'canonical_producer', outcome: 'passed', failed: 0, openResults: 0}, 'success', 'producer pass, nothing failed or open'],
  [{type: 'canonical_producer', outcome: 'passed', failed: 1, openResults: 0}, 'warning', 'producer pass with a failed unit'],
  [{type: 'canonical_producer', outcome: 'passed', failed: 0, openResults: 2}, 'warning', 'producer pass with unclosed results: all visited is not current'],
  [{type: 'canonical_producer', outcome: 'passed'}, 'warning', 'producer pass with unknown counts is not a success'],
  [{type: 'canonical_producer', outcome: 'stopped', recovery: 'eligible'}, 'interrupted', 'producer stop eligible for the automatic retry (eligibility, not a promise)'],
  [{type: 'canonical_producer', outcome: 'stopped', recovery: 'automatic'}, 'warning', 'an unknown recovery value is not read as eligible'],
  [{type: 'canonical_producer', outcome: 'held', recovery: 'owner'}, 'error', 'producer automatic recovery held: needs the owner'],
  [{type: 'canonical_producer', outcome: 'stopped', recovery: 'owner'}, 'error', 'producer stop that needs the owner'],
  [{type: 'canonical_producer', outcome: 'stopped'}, 'warning', 'producer stop with unknown recovery'],
  [{type: 'canonical_producer', outcome: 'superseded'}, 'interrupted', 'producer pass cut by a newer publication'],
  [{type: 'canonical_producer'}, null, 'producer record without an outcome'],
  [{type: 'enrichment', presentation: 'batch_v2_terminal', stage: 'complete', outcome: 'failed'}, 'success', 'outcome of another type is ignored'],
  // Neutral and unknown
  [{type: 'epg', films: 1}, 'success', 'epg published'],
  // ADR 0191: the two structured Channel policy warnings; everything else about an EPG event stays a successful publication.
  [{type: 'epg', films: 1, warning: {code: 'channel_policy_degraded', reason: 'empty'}}, 'warning', 'degraded: the blacklist was not applied'],
  [{type: 'epg', films: 1, warning: {code: 'channel_registration_failed', reason: 'conflict'}}, 'warning', 'registration failed'],
  [{type: 'epg', films: 1, channels: {total: 5, unclassified: 2, new: 1}, policy: {mode: 'filtered', revision: 7}}, 'success', 'filtered with unclassified and new channels is not a warning'],
  [{type: 'epg', films: 1, channels: {total: 5, knownOnly: 5}, policy: {mode: 'degraded'}}, 'success', 'the mode alone is not the warning: only the structured code is'],
  [{type: 'epg', films: 1, warning: {code: 'something_else'}}, 'success', 'an unknown warning code stays a success'],
  [{type: 'epg', films: 1, warning: 'channel_policy_degraded'}, 'success', 'a non-object warning is ignored'],
  // Recorded actions are successes even with nothing changed (owner return of AIR-557).
  [{type: 'watchlist', total: 3, baseline: false, added: [], removed: []}, 'success', 'watchlist commit with no diff'],
  [{type: 'watchlist', total: 3, baseline: true, added: [], removed: []}, 'success', 'watchlist baseline'],
  [{type: 'watchlist', total: 4, added: [{id: 'x'}], removed: []}, 'success', 'watchlist with additions'],
  [{type: 'watchlist'}, 'success', 'watchlist, bare'],
  [{type: 'started', film: {id: 'a'}}, 'success', 'started'], [{type: 'unstarted', film: {id: 'a'}}, 'success', 'unstarted'],
  [{type: 'taste_profile', scope: 'identity', changedFields: []}, 'success', 'taste profile, identity scope'],
  [{type: 'taste_profile', scope: 'global', toVersion: 4}, 'success', 'taste profile, global'],
  [{type: 'taste_profile', scope: 'selective', toVersion: 5}, 'success', 'taste profile, selective'],
  [{type: 'future_type', state: 'error'}, null, 'unknown type'], [{type: 'diary_viewing', state: 'finished'}, null, 'unknown type with a known-looking state'], [{}, null, 'empty'], [null, null, 'null'],
];
for (const [event, expected, name] of table) assert.equal(status(event), expected, name);

// The title text never decides: same fields, any wording.
assert.equal(status({type: 'discovery', kind: 'hour', status: 'idle', checked: 1, added: 0, title: 'Ошибка прервано'}), 'success');

// Filters: both axes combine. A skipped start is an `enrichment` Event with the `warning` result; it has no type of its own (AIR-584).
const events = [
  {type: 'enrichment', presentation: 'batch_v2_skipped'}, terminal({stage: 'complete', delta: {failed: 0}}), terminal({stage: 'partial', stopReason: 'api_error'}),
  {type: 'discovery', kind: 'report_failed'}, {type: 'watchlist'}, {type: 'epg'},
  {type: 'epg', warning: {code: 'channel_policy_degraded', reason: 'empty'}}, {type: 'epg', warning: {code: 'channel_registration_failed'}},
];
const count = (type, result) => events.filter(event => run(`eventMatchesFilters(${JSON.stringify(event)},'${type}','${result}')`)).length;
assert.equal(count('all', 'all'), 8);
assert.equal(count('all', 'warning'), 4, 'both EPG warnings are in «Предупреждение»');
assert.equal(count('all', 'success'), 3, 'a successful watchlist commit is in «Успех»');
assert.equal(count('enrichment', 'warning'), 1, 'the skipped start is the warning of «Прогнозы»');
assert.equal(count('watchlist', 'warning'), 0, 'zero results for a combination');
assert.equal(count('enrichment', 'error'), 1);
assert.equal(count('enrichment', 'all'), 3);
assert.equal(count('watchlist', 'all'), 1);
assert.equal(count('watchlist', 'success'), 1, 'watchlist + success combine');
assert.equal(count('watchlist', 'error'), 0);
assert.equal(count('epg', 'success'), 1, 'only the ordinary publication is a success');
assert.equal(count('epg', 'warning'), 2);
assert.equal(count('epg', 'all'), 3);
const degradedBadge = run("eventStatusBadgeHTML({type:'epg',warning:{code:'channel_policy_degraded'}})");
assert.match(degradedBadge, /event-status-warning/, 'the degraded EPG event has the warning badge');
assert.doesNotMatch(degradedBadge, /event-status-success/);
assert.match(run("eventStatusBadgeHTML({type:'epg',warning:{code:'channel_registration_failed'}})"), /event-status-warning/);
assert.match(run("eventStatusBadgeHTML({type:'epg',films:1})"), /event-status-success/, 'an ordinary EPG event keeps the success badge');
const runningHour = JSON.stringify({type: 'discovery', kind: 'hour', status: 'running', checked: 588, added: 39});
assert.equal(run(`eventMatchesFilters(${runningHour},'discovery','success')`), true, 'result=success + «Находки» shows the running hour report');
assert.equal(run(`eventMatchesFilters(${runningHour},'all','warning')`), false);
assert.match(run(`eventStatusBadgeHTML(${runningHour})`), /event-status-success/);
assert.equal(run("eventMatchesResult({type:'epg'},'nonsense')"), true, 'an unknown result id never hides events');

// The automatic search counts matches of BOTH axes: ten skipped events (warning) are not ten «error» matches of the prediction type.
run("loadedEvents.clear();eventResultFilterId='error'");
for (let i = 0; i < 10; i++) run(`loadedEvents.set('s${i}',{id:'s${i}',type:'enrichment',presentation:'batch_v2_skipped'})`);
assert.equal(run("eventMatchCount('enrichment')"), 0, 'ten events of the type with the wrong result are no matches');
assert.equal(run("eventMatchCount('enrichment','warning')"), 10);
run("loadedEvents.set('t1',{id:'t1',type:'enrichment',presentation:'batch_v2_terminal',stage:'partial',stopReason:'api_error'})");
assert.equal(run("eventMatchCount('enrichment')"), 1);
assert.equal(run("eventMatchCount('all','all')"), 11, 'both axes «all» count everything and need no scan');
run("eventResultFilterId='all';loadedEvents.clear()");

// URL: the two parameters are independent and every other parameter stays byte for byte.
assert.equal(run("eventResultFrom('?result=warning&type=skipped')"), 'warning');
assert.equal(run("eventTypeFrom('?result=warning&type=skipped')"), 'all', 'AIR-584: the removed type falls back to «Все события», the result stays');
assert.equal(run("eventResultFrom('?result=nonsense')"), 'all');
assert.equal(run("eventResultFrom('')"), 'all');
assert.equal(run("withEventResult('/events?type=skipped&return=%2F%3Fq%3Da','warning')"), '/events?type=skipped&return=%2F%3Fq%3Da&result=warning');
assert.equal(run("withEventType('/events?result=error&return=%2F','epg')"), '/events?result=error&return=%2F&type=epg');
assert.equal(run("withEventResult('/events?result=error&type=epg#x','all')"), '/events?type=epg#x');
assert.equal(run("withEventResult('/events?result=error&result=warning','success')"), '/events?result=success');

// Markup, badge and CSS: one renderer, text + icon, no colour-only meaning.
{
  const panel = html.match(/<section class="events-types events-results" id="events-results" hidden[\s\S]*?<\/section>/)[0];
  const buttons = [...panel.matchAll(/data-event-result="([a-z]+)" aria-pressed="(true|false)">([^<]+)</g)].map(m => m.slice(1, 4));
  assert.deepEqual(buttons, [['all', 'true', 'Все'], ['success', 'false', 'Успех'], ['warning', 'false', 'Предупреждение'], ['interrupted', 'false', 'Прервано'], ['error', 'false', 'Ошибка']]);
  assert.match(panel, /<h2 id="events-results-title">Результат<\/h2>/);
  assert.match(panel, /role="group" aria-label="Результат"/);
  for (const name of ['success', 'warning', 'interrupted', 'error']) {
    const badge = run(`eventStatusBadgeHTML(${JSON.stringify(name === 'success' ? {type: 'epg'} : name === 'warning' ? {type: 'discovery', kind: 'report_failed'} : name === 'interrupted' ? {type: 'discovery', status: 'superseded'} : {type: 'catalog_posters', outcome: 'failed'})})`);
    assert.match(badge, new RegExp(`event-status-${name}`));
    assert.match(badge, /<span class="event-status-icon" aria-hidden="true">.<\/span>(Успех|Предупреждение|Прервано|Ошибка)<\/span>$/);
    assert.match(css, new RegExp(`\\.event-status-${name}\\{--st:#`));
  }
  assert.equal(run("eventStatusBadgeHTML({type:'future_type'})"), '', 'no result, no badge');
  // One header holds the date and the marker, then the title follows on its own line (owner return of AIR-557).
  const head = run("eventHTML({id:'e1',at:'2026-11-20T10:00:00Z',type:'epg',films:1,archive:1,future:1,broadcasts:1})");
  assert.match(head, /<li class="activity-event" data-event-id="e1"><div class="event-head"><time datetime="2026-11-20T10:00:00Z">[^<]*<\/time><span class="event-status event-status-success"><span class="event-status-icon" aria-hidden="true">.<\/span>Успех<\/span><\/div><p>Обновлён EPG<\/p>/);
  const quiet = run("eventHTML({id:'e3',at:'2026-11-20T10:00:00Z',type:'future_type'})");
  assert.match(quiet, /<div class="event-head"><time[^>]*>[^<]*<\/time><\/div>/);
  assert.doesNotMatch(quiet, /event-status/);
  // Watchlist with no change shows the success marker on both layouts (one renderer).
  const wl = run("eventHTML({id:'e2',at:'2026-11-20T10:00:00Z',type:'watchlist',total:3,baseline:false,added:[],removed:[]})");
  assert.match(wl, /event-status-success/);
  assert.match(wl, /Состав без изменений/);
  // Layout CSS: stacked in the compact feed (the approved layout), one row with the marker flush right on /events, wrapping on a narrow screen.
  assert.match(css, /\.event-head\{display:block\}/);
  assert.match(css, /html\.events-screen \.event-head\{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;/);
  assert.match(css, /html\.events-screen \.event-head \.event-status\{margin:0 0 0 auto\}/, 'flush right, also when it wraps');
  assert.match(css, /html\.events-screen \.event-head time\{margin:0;min-width:0\}/);
}
// AIR-694: the card of a Ratings event interrupted by a lost lease — new honest shape and the already stored fallback shape — has the interrupted badge, the «Прервано» filter and no fictitious zero counters.
{
 const card=event=>{ctx.ev=event;return run('eventHTML(ev)');};
 for(const event of [{id:'a',type:'ratings',at:'2026-11-27T21:34:54Z',outcome:'error',reason:'lease_lost'},{id:'b',type:'ratings',at:'2026-11-27T21:34:54Z',outcome:'interrupted',reason:'lease_lost',state:'unknown',cause:'interrupted',interruptedPhase:'diary',diary:null,removal:null}]){
  const html=card(event);
  assert.match(html,/Проверка рейтингов прервана/);assert.match(html,/event-status-interrupted/);assert.match(html,/Прервано/);assert.doesNotMatch(html,/<dl>|Удалений обработано|проверено/);
  assert.equal(run(`eventMatchesFilters(${JSON.stringify(event)},'ratings','interrupted')`),true);
  assert.equal(run(`eventMatchesFilters(${JSON.stringify(event)},'ratings','error')`),false);
 }
 const err=card({id:'c',type:'ratings',at:'2026-11-27T21:34:54Z',outcome:'error',reason:'network_error'});
 assert.match(err,/event-status-error/);assert.doesNotMatch(err,/Проверка рейтингов прервана/);
 const ok=card({id:'d',type:'ratings',at:'2026-11-27T21:34:54Z',state:'finished',diary:{pages:1,rows:3,added:0,updated:0,written:1,unchanged:2,skipped:0,conflicts:0},removal:{pending:0,checked:0,rated:0,resolved:0}});
 assert.match(ok,/Рейтинги обновлены/);assert.match(ok,/Удалений обработано/);
}
console.log('events-result-status: ok');
