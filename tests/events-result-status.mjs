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
  [{type: 'enrichment', stage: 'partial', reason: 'api_error', queueSchemaVersion: 5}, null, 'legacy v5 is not guessed'],
  [{type: 'enrichment'}, null, 'bare legacy enrichment'],
  // Discovery
  [{type: 'discovery', kind: 'hour', status: 'idle', checked: 0, added: 0}, 'success', 'nothing new is not a warning'],
  [{type: 'discovery', kind: 'hour', status: 'empty', checked: 3, added: 1}, 'success', 'hour report'],
  [{type: 'discovery', kind: 'hour', status: 'running', checked: 3, added: 1}, null, 'still running: no outcome yet'],
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
  [{type: 'discovery', status: 'stopped'}, null, 'legacy stopped is not guessed'],
  [{type: 'discovery', kind: 'empty'}, null, 'legacy empty queue'],
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
  // Catalog posters (not the same thing as the `outcome` of another event type)
  [{type: 'catalog_posters', outcome: 'completed', noPoster: 5}, 'success', 'completed; noPoster is not a warning'],
  [{type: 'catalog_posters', outcome: 'deferred'}, 'warning', 'deferred'],
  [{type: 'catalog_posters', final: false}, 'warning', 'deferred by final=false'],
  [{type: 'catalog_posters', outcome: 'failed'}, 'error', 'failed'],
  [{type: 'catalog_posters'}, null, 'no outcome'],
  [{type: 'enrichment', presentation: 'batch_v2_terminal', stage: 'complete', outcome: 'failed'}, 'success', 'outcome of another type is ignored'],
  // Neutral and unknown
  [{type: 'epg', films: 1}, 'success', 'epg published'],
  [{type: 'watchlist'}, null, 'watchlist neutral'], [{type: 'started'}, null, 'started neutral'], [{type: 'unstarted'}, null, 'unstarted neutral'],
  [{type: 'taste_profile'}, null, 'taste profile neutral'], [{type: 'future_type', state: 'error'}, null, 'unknown type'], [{}, null, 'empty'], [null, null, 'null'],
];
for (const [event, expected, name] of table) assert.equal(status(event), expected, name);

// The title text never decides: same fields, any wording.
assert.equal(status({type: 'discovery', kind: 'hour', status: 'idle', checked: 1, added: 0, title: 'Ошибка прервано'}), 'success');

// Filters: both axes combine; «Пропущенные» stays a type, `warning` a result.
const events = [
  {type: 'enrichment', presentation: 'batch_v2_skipped'}, terminal({stage: 'complete', delta: {failed: 0}}), terminal({stage: 'partial', stopReason: 'api_error'}),
  {type: 'discovery', kind: 'report_failed'}, {type: 'watchlist'}, {type: 'epg'},
];
const count = (type, result) => events.filter(event => run(`eventMatchesFilters(${JSON.stringify(event)},'${type}','${result}')`)).length;
assert.equal(count('all', 'all'), 6);
assert.equal(count('all', 'warning'), 2);
assert.equal(count('skipped', 'warning'), 1);
assert.equal(count('skipped', 'success'), 0, 'zero results for a combination');
assert.equal(count('enrichment', 'error'), 1);
assert.equal(count('enrichment', 'all'), 3);
assert.equal(count('all', 'success'), 2);
assert.equal(count('watchlist', 'all'), 1);
assert.equal(count('watchlist', 'success'), 0, 'a neutral event matches only «Все»');
assert.equal(run("eventMatchesResult({type:'epg'},'nonsense')"), true, 'an unknown result id never hides events');

// The automatic search counts matches of BOTH axes: ten skipped events (warning) are not ten «error» matches of the prediction type.
run("loadedEvents.clear();eventResultFilterId='error'");
for (let i = 0; i < 10; i++) run(`loadedEvents.set('s${i}',{id:'s${i}',type:'enrichment',presentation:'batch_v2_skipped'})`);
assert.equal(run("eventMatchCount('enrichment')"), 0, 'ten events of the type with the wrong result are no matches');
assert.equal(run("eventMatchCount('skipped','warning')"), 10);
run("loadedEvents.set('t1',{id:'t1',type:'enrichment',presentation:'batch_v2_terminal',stage:'partial',stopReason:'api_error'})");
assert.equal(run("eventMatchCount('enrichment')"), 1);
assert.equal(run("eventMatchCount('all','all')"), 11, 'both axes «all» count everything and need no scan');
run("eventResultFilterId='all';loadedEvents.clear()");

// URL: the two parameters are independent and every other parameter stays byte for byte.
assert.equal(run("eventResultFrom('?result=warning&type=skipped')"), 'warning');
assert.equal(run("eventTypeFrom('?result=warning&type=skipped')"), 'skipped');
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
  assert.equal(run("eventStatusBadgeHTML({type:'watchlist'})"), '', 'no result, no badge');
  assert.match(run("eventHTML({id:'e1',at:'2026-11-20T10:00:00Z',type:'epg',films:1,archive:1,future:1,broadcasts:1})"), /<time[^>]*>[^<]*<\/time><span class="event-status event-status-success">/);
  assert.doesNotMatch(run("eventHTML({id:'e2',at:'2026-11-20T10:00:00Z',type:'watchlist',total:0,added:[],removed:[]})"), /event-status/);
}
console.log('events-result-status: ok');
