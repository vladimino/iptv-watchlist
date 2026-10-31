// The prediction recovery panel on /admin/limbo. The view: Russian copy for every code of the assessment vocabulary, fail
// closed on any undeclared code or on an answer that claims an action or a writer, escaping, codes and the pin only inside
// the closed technical details, Madrid times. The page: the panel opens only from a film item of the prediction or
// fingerprint subsystem, toggles with aria-expanded, reads through the client with the held pin, and after a change says
// so and shows the fresh state. The bundle has no write method and no action control.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {bundleAdmin} from '../src/admin/bundle.js';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as R from '../src/domain/prediction-recovery.js';
import * as V from '../src/admin/prediction-recovery-view.js';

const build = fs.readFileSync('build.mjs', 'utf8');
const bundleLine = build.split('\n').find(line => line.includes("assets['/admin-limbo.js']"));
assert.ok(bundleLine.indexOf('src/admin/limbo-client.js') < bundleLine.indexOf('src/admin/prediction-recovery-view.js') && bundleLine.indexOf('src/admin/prediction-recovery-view.js') < bundleLine.indexOf('public/admin-limbo.js'), 'the view is bundled after the client and before the page');
const viewSource = fs.readFileSync('src/admin/prediction-recovery-view.js', 'utf8');
assert.doesNotMatch(viewSource, /\bfetch\(|adminCall|data-limbo-action|<form|method=/, 'the view reads nothing and offers no action');

// 1. Copy for every code the assessment can return.
for (const code of R.PREDICTION_RECOVERY_STATUSES) assert.ok(V.RECOVERY_STATUS_COPY[code], 'status ' + code);
for (const code of R.PREDICTION_RECOVERY_CAUSES) {
  const copy = V.RECOVERY_CAUSE_COPY[code];
  assert.ok(copy && copy.title && copy.what && (copy.why || code === 'repeated_failures'), 'cause ' + code);
}
for (const reason of ['caller_contract', 'system_failure', 'failure_unclassified']) assert.ok(V.RECOVERY_REPEATED_WHY[reason], 'repeated ' + reason);
for (const code of R.PREDICTION_RECOVERY_ACTION_REASONS) assert.ok(V.RECOVERY_ACTION_REASON_COPY[code], 'reason ' + code);
for (const code of R.PREDICTION_RECOVERY_PREREQUISITES) assert.ok(V.RECOVERY_PREREQUISITE_COPY[code], 'prerequisite ' + code);
for (const code of R.PREDICTION_RECOVERY_EVIDENCE) assert.ok(V.RECOVERY_EVIDENCE_COPY[code], 'evidence ' + code);
assert.ok(V.recoveryExplainable({assessment: R.assessPredictionRecovery(null)}), 'a malformed input still has an explanation: unknown');
assert.deepEqual(Object.keys(V.RECOVERY_CAUSE_COPY).sort(), [...R.PREDICTION_RECOVERY_CAUSES].sort(), 'no copy for a cause that does not exist');

const NOW = Date.parse('2026-10-31T09:00:00.000Z'), H = 3600000;
const iso = ms => new Date(NOW + ms).toISOString();
const diagnostic = (over = {}) => ({
  atomic: false, filmId: 'f1', lane: 'hot', eligibleNow: true, cause: 'ready', snapshot: {consistent: true, partial: false, reasons: []},
  fingerprint: {presence: 'recorded', current: true, usable: true, reason: 'current', migration: 'none'},
  prediction: {presence: 'recorded', current: false, stale: true, profileMatch: false, cause: 'profile_changed', reason: 'profile_changed', requiredWork: 'prediction_only'},
  index: 'agreed', retry: {classification: 'not_recorded', scope: null, attempts: null, failedAt: null, retryAt: null, lastRunId: null, validation: null}, ...over,
});
const assess = (over = {}) => R.assessPredictionRecovery({filmId: 'f1', now: NOW, snapshotReasons: [], sources: {film: 'recorded', queue: 'recorded', profile: 'recorded'}, catalogMember: true, queueActivityAt: iso(-H), nominalNextRunAt: iso(20 * 60000), runner: {lease: 'not_recorded', run: 'not_recorded'}, ...over, diagnostic: diagnostic(over.diagnostic)});
const answer = (assessment, over = {}) => ({pin: 'R1.' + '0'.repeat(32), evaluatedAt: iso(0), atomic: false, assessment, snapshot: {consistent: true, reasons: [], queue: {status: 'recorded', refreshedAt: iso(-H), programmeRunId: 'run-31', lastActivityAt: iso(-H)}, profile: {status: 'recorded', version: 4}}, sources: ['enrichment/prediction-queue.json'], ...over});
const outside = html => html.replace(/<details class="recovery-tech">[\s\S]*?<\/details>/g, '');
const RAW = new RegExp('\\b(?:' + [...R.PREDICTION_RECOVERY_CAUSES, ...R.PREDICTION_RECOVERY_ACTION_REASONS, ...R.PREDICTION_RECOVERY_NEXT.filter(code => code !== 'none'), 'enrichment/', 'R1\\.'].join('|') + ')\\b');

// 2. Every reachable verdict renders without raw codes outside the details, with the headline, next step and no button.
const cases = [
  assess(),
  assess({queueActivityAt: iso(-25 * H)}),
  assess({diagnostic: {lane: 'cold', eligibleNow: false, cause: 'waiting_behind_hot'}}),
  assess({diagnostic: {eligibleNow: false, cause: 'retry_backoff', retry: {classification: 'validation_error', scope: 'item', attempts: 2, failedAt: iso(-2 * H), retryAt: iso(3 * H), lastRunId: 'run-0', validation: {stage: 'prediction_schema', reportedBy: 'worker', issues: [{path: 'mainRisk', code: 'required'}]}}}}),
  assess({diagnostic: {retry: {classification: 'parse_error', scope: 'item', attempts: 6, failedAt: iso(-7 * H), retryAt: iso(-H), lastRunId: 'run-0', validation: null}}}),
  assess({runner: {lease: 'recorded', leaseRunId: 'run-9', leaseExpiresAt: NOW + 600000, run: 'recorded', runId: 'run-9', selectedIds: ['f1'], resultIds: []}}),
  assess({diagnostic: {lane: 'none', eligibleNow: false, cause: 'not_in_queue'}}),
  assess({diagnostic: {lane: 'none', eligibleNow: false, cause: 'not_in_queue', prediction: {presence: 'recorded', current: true, profileMatch: true, cause: 'current', reason: 'current', requiredWork: null}}}),
  assess({catalogMember: false, diagnostic: {lane: 'none', eligibleNow: false, cause: 'not_in_queue', prediction: {presence: 'not_recorded', current: false, profileMatch: null, cause: 'not_recorded'}}}),
  assess({sources: {film: 'recorded', queue: 'recorded', profile: 'not_recorded'}}),
  assess({snapshotReasons: ['queue_programme_differs']}),
  assess({sources: {film: 'recorded', queue: 'not_recorded', profile: 'recorded'}, diagnostic: {lane: 'unknown', eligibleNow: null, cause: 'unknown'}}),
  assess({runner: {lease: 'unavailable', run: 'unavailable'}, queueActivityAt: null}),
];
for (const assessment of cases) {
  const html = V.recoveryPanelHtml(answer(assessment));
  assert.ok(V.recoveryExplainable(answer(assessment)), assessment.cause);
  assert.match(html, new RegExp(V.RECOVERY_STATUS_COPY[assessment.status]));
  assert.ok(html.includes(V.RECOVERY_CAUSE_COPY[assessment.cause].title.replace(/«|»/g, '')) || html.includes(V.RECOVERY_CAUSE_COPY[assessment.cause].title), assessment.cause);
  assert.match(html, /<h4>Что будет дальше<\/h4>/);
  assert.match(html, /<h4>Почему здесь нет кнопки «повторить»<\/h4>/);
  assert.match(html, /<details class="recovery-tech"><summary>Технические подробности<\/summary>/, 'details are closed by default');
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(outside(html), RAW, assessment.cause + ' raw code outside the details: ' + (outside(html).match(RAW) || [])[0]);
  assert.match(html, /data-limbo-recovery-recheck>Проверить заново</);
  assert.doesNotMatch(html, /Повторить<|Поставить в очередь|data-limbo-action|<form/, 'no action control');
  assert.equal((html.match(/<button/g) || []).length, 1, 'the only control is the recheck');
}
// Repeated failures: the visible remedy follows the failure kind; infrastructure failures never blame the model output.
const repeatedOf = kind => assess({diagnostic: {retry: {classification: kind, scope: 'item', attempts: 5, failedAt: iso(-7 * H), retryAt: iso(-H), lastRunId: 'run-0', validation: null}}});
for (const [kind, label] of [['storage_error', 'ошибка хранилища'], ['quota', 'исчерпана квота модели'], ['time_budget', 'не хватило времени запуска'], ['model_unavailable', 'модель недоступна']]) {
  const html = V.recoveryPanelHtml(answer(repeatedOf(kind)));
  assert.match(html, /Сбой на стороне инфраструктуры/, kind);
  assert.doesNotMatch(outside(html), /Исправлять нужно то, что модель возвращает|исправить ответ модели/, kind + ' does not blame the model output');
  assert.match(html, new RegExp('последняя ошибка: ' + label), kind);
  assert.doesNotMatch(outside(html), RAW, kind);
}
for (const kind of ['validation_error', 'parse_error']) assert.match(V.recoveryPanelHtml(answer(repeatedOf(kind))), /Сбой в ответе модели: тот же запрос даст ту же ошибку/, kind);
for (const kind of ['model_error', 'not_recorded']) {
  const html = V.recoveryPanelHtml(answer(repeatedOf(kind)));
  assert.match(html, /Вид сбоя не распознан/, kind);
  assert.doesNotMatch(html, /Сбой в ответе модели|Сбой на стороне инфраструктуры/, kind);
}
assert.match(V.recoveryPanelHtml(answer({...repeatedOf('quota'), targetedAction: {available: false, capability: null, reason: 'not_needed'}})), /Невозможно достоверно объяснить/, 'a repeated failure without a failure reason is not explained');
// A malformed lease is an unknown run state, never "no run".
const unknownLease = V.recoveryPanelHtml(answer(assess({runner: {lease: 'recorded', leaseRunId: 'run-9', leaseExpiresAt: null, run: 'recorded', runId: 'run-9', selectedIds: ['f1'], resultIds: []}})));
assert.match(unknownLease, /<dt>запуск<\/dt><dd>состояние запуска неизвестно<\/dd>/);
assert.doesNotMatch(unknownLease, /сейчас запуска нет/);
assert.match(unknownLease, /Не удалось прочитать: состояние текущего запуска\./);
assert.match(V.recoveryPanelHtml(answer(cases[0])), /<dt>запуск<\/dt><dd>сейчас запуска нет<\/dd>/, 'no lease object is a real fact');

// Madrid times, with the zone named.
const backoffHtml = V.recoveryPanelHtml(answer(cases[3]));
assert.match(backoffHtml, /не раньше 31\.10\.2026, 13:00 Madrid/, 'retry time in Madrid (UTC+1)');
assert.match(V.recoveryPanelHtml(answer(cases[0])), /около 31\.10\.2026, 10:20 Madrid; это оценка, а не обещание/);
assert.equal(V.recoveryDate('2026-07-01T10:00:00.000Z'), '01.07.2026, 12:00 Madrid', 'summer time is UTC+2');
assert.equal(V.recoveryDate('not a date'), null);
assert.match(V.recoveryPanelHtml(answer(cases[5])), /фильм взят в работу/);
assert.match(V.recoveryPanelHtml(answer(cases[0])), /<dt>нужная работа<\/dt><dd>только прогноз; отпечаток переиспользуется<\/dd>/);
assert.match(V.recoveryPanelHtml(answer(cases[7])), /<dt>нужная работа<\/dt><dd>нет<\/dd>/, 'a current prediction needs nothing');
assert.match(V.recoveryPanelHtml(answer(cases[8])), /<dt>нужная работа<\/dt><dd>не определена<\/dd>/, 'no prediction and no recorded plan is not "nothing"');
assert.match(V.recoveryPanelHtml(answer(cases[8])), /<li>фильм в опубликованной программе или в каталоге/);
assert.match(V.recoveryPanelHtml(answer(cases[12])), /Не удалось прочитать: состояние текущего запуска, последний запуск, время последней проверки очереди\./);
assert.match(V.recoveryPanelHtml(answer(cases[0]), {changed: true}), /role="status">Состояние изменилось с прошлой проверки/);

// 3. Fail closed: an undeclared code anywhere, or a claimed action or writer, is never explained.
const base = cases[0];
for (const broken of [
  {...base, status: 'retry_now'}, {...base, cause: 'film_rescued'}, {...base, targetedAction: {...base.targetedAction, reason: 'because'}},
  {...base, nextExpected: {kind: 'requeue', at: null}}, {...base, targetedAction: {available: true, capability: 'prediction.requeue', reason: 'ordinary_schedule'}},
  {...base, writer: {exists: true, decision: 'go'}}, {...base, missingPrerequisites: ['lease']}, {...base, evidence: {completeness: 'partial', missing: ['r2']}},
  {...base, missingPrerequisites: null}, null,
]) {
  const html = V.recoveryPanelHtml(broken === null ? null : answer(broken));
  assert.match(html, /Невозможно достоверно объяснить состояние прогноза\. Ничего не выполнялось/);
  assert.doesNotMatch(html, /<h4>/, 'no partial explanation');
}
assert.equal(V.recoveryExplainable(undefined), false);
// Escaping: hostile ids and sources render as text inside the details.
const hostile = V.recoveryPanelHtml(answer({...base, filmId: '<img src=x onerror=alert(1)>'}, {sources: ['"><script>alert(1)</script>']}));
assert.doesNotMatch(hostile, /<img|<script/);
assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/);
// Errors: known copy, an HTTP code without raw text, a recheck.
assert.match(V.recoveryErrorHtml('storage_unavailable'), /Хранилище не ответило\. Ничего не выполнялось\./);
assert.match(V.recoveryErrorHtml('http_500'), /ошибкой 500/);
assert.match(V.recoveryErrorHtml('<b>x</b>'), /Разбор не получен\./);
assert.doesNotMatch(V.recoveryErrorHtml('<b>x</b>'), /<b>/);

// 4. The page over the Worker bundle.
const page = fs.readFileSync('public/admin-limbo.js', 'utf8');
const bundle = bundleAdmin([fs.readFileSync('src/admin/client.js', 'utf8'), fs.readFileSync('src/admin/limbo-client.js', 'utf8'), viewSource, page]);
assert.doesNotMatch(bundle, /method:\s*['"](?:POST|PUT|PATCH|DELETE)|\/api\/enrichment|\/mcp|Authorization|Bearer|localStorage/);
assert.doesNotMatch(page, /\bfetch\(/);
const css = fs.readFileSync('public/admin.css', 'utf8');
assert.match(css, /\.limbo-recovery\{/);
assert.match(css, /\.recovery-tech/);

const records = new Map(), etags = new Map();
let requests = [], version = 0;
const set = (key, value) => {records.set(key, value); etags.set(key, 'e' + (++version));};
const bucket = {
  async get(key) {
    if (!records.has(key)) return null;
    const text = JSON.stringify(records.get(key));
    return {etag: etags.get(key), uploaded: new Date('2026-10-31T07:00:00.000Z'), json: async () => JSON.parse(text), text: async () => text};
  },
  async put() {throw new Error('the recovery panel never writes');},
  async list() {throw new Error('the recovery panel never lists');},
};
const D = 86400000;
const FrozenDate = class extends Date {constructor(...args) {super(...(args.length ? args : [NOW]));} static now() {return NOW;}};
const workerContext = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date: FrozenDate, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, atob, btoa, crypto: webcrypto, console, setTimeout, structuredClone, encodeURIComponent, decodeURIComponent,
  ASSETS: {}, INITIAL_PERSONAL_RATINGS: {}, FILM_TITLE_DICTIONARY: [], PERSON_NAME_DICTIONARY: [],
  fetch: async () => {throw new Error('no outbound request');}});
for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/domain/profile-impact.js', 'src/domain/prediction-compatibility.js', 'src/domain/fingerprint-compatibility.js', 'src/domain/scored-resolution.js', 'src/domain/resolution-acceptance.js', 'src/sources.js', 'src/ratings-seed.js', 'src/discovery.js', 'src/letterboxd-facts.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), workerContext);
vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), workerContext);
vm.runInContext(scoped('src/domain/limbo-inventory.js', 'LimboInventory'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/limbo.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/prediction-diagnostics.js', 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/prediction-recovery.js', 'PredictionRecovery'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/prediction-recovery.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/worker.js', 'utf8').replace('export default', 'globalThis.worker='), workerContext);
const G1 = '11111111-1111-4111-8111-111111111111';
const QUEUE = 'enrichment/prediction-queue.json';
function seed() {
  records.clear(); etags.clear(); requests = [];
  vm.runInContext('ADMIN_SNAPSHOT_CACHE=null;ADMIN_LIMBO_CACHE=null', workerContext);
  const films = [
    {id: 'stuck', tmdbId: '1', title: 'Застрявший', original: 'Stuck', titleRu: 'Застрявший', titleStatus: 'verified', year: 2020, metadataAt: iso(-D), synopsis: 's', peopleVersion: 1, directors: [], actors: [], shows: []},
    {id: 'later', tmdbId: '2', title: 'Позже', original: 'Later', titleRu: 'Позже', titleStatus: 'verified', year: 2021, metadataAt: iso(-D), synopsis: 's', peopleVersion: 1, directors: [], actors: [], shows: []},
    {id: 'bare', tmdbId: '3', title: 'Без метаданных', original: 'Bare', titleRu: 'Без метаданных', titleStatus: 'verified', directors: [], actors: [], shows: []},
  ];
  set('epg/published-generation.json', {phase: 'published', programmeRunId: G1, publishedAt: iso(-5 * H)});
  set('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: iso(-5 * H), films, people: {directors: [], actors: []}, stats: {}});
  set('epg/generations/' + G1 + '/discovered-films.json', {});
  set('titles.json', {});
  set('people.json', {});
  set('enrichment/profile/current.json', {version: 4, profileHash: 'hash-31', updatedAt: iso(-2 * H), profile: 'CANARY-PROFILE-TEXT'});
  set(QUEUE, {programmeRunId: G1, profileVersion: 4, profileHash: 'hash-31', refreshedAt: iso(-H), lastCheckAt: iso(-H), hotPending: ['stuck', 'later'], coldPending: [], pending: ['stuck', 'later'], priorityCount: 2, retries: {later: {attempts: 1, retryAt: NOW + 2 * H, kind: 'parse_error', scope: 'item', failedAt: iso(-H), lastRunId: 'run-1'}}, work: {stuck: {requiredWork: 'prediction_only'}}});
  set('enrichment/view-index.json', {stuck: {fingerprintHash: 'f', prediction: {generatedAt: iso(-20 * D)}}, later: {fingerprintHash: 'g', prediction: {generatedAt: iso(-D)}}});
}
seed();
const fakeFetch = async (input, init = {}) => {
  const url = new URL(String(input), 'http://127.0.0.1');
  requests.push({method: init.method || 'GET', path: url.pathname + url.search});
  return workerContext.worker.fetch(new Request('http://127.0.0.1' + url.pathname + url.search, {method: init.method || 'GET', headers: init.headers}), {BUCKET: bucket}, {waitUntil() {throw new Error('background work');}});
};

// DOM stand-in: fixed page nodes plus nodes for the recovery button and panel, present while the results contain them.
const attrs = new Map();
function element(selector) {
  return {
    selector, hidden: false, innerHTML: '', textContent: '', value: '', disabled: false,
    setAttribute(name, value) {attrs.set(selector + ':' + name, value);},
    getAttribute(name) {return attrs.get(selector + ':' + name) ?? null;},
    focus() {}, insertAdjacentHTML(position, markup) {this.innerHTML += markup;}, remove() {}, addEventListener() {},
  };
}
const nodes = new Map(['#limbo-snapshot-text', '#limbo-causes', '#limbo-subsystems', '#limbo-form', '#limbo-kind', '#limbo-age', '#limbo-reset', '#limbo-loading', '#limbo-stale', '#limbo-refresh', '#limbo-error', '#limbo-empty', '#limbo-results', '#limbo-total', '#limbo-context-body'].map(selector => [selector, element(selector)]));
const dynamic = new Map();
const results = nodes.get('#limbo-results');
const document = {
  body: {}, activeElement: null,
  querySelector(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const match = /^\[(data-limbo-recovery(?:-slot)?)="(\d+)"\]$/.exec(selector);
    if (!match || !results.innerHTML.includes(`${match[1]}="${match[2]}"`)) return null;
    if (!dynamic.has(selector)) {const node = element(selector); node.setAttribute(match[1], match[2]); dynamic.set(selector, node);}
    return dynamic.get(selector);
  },
};
const window = {addEventListener() {}, location: {href: 'http://127.0.0.1/admin/limbo'}, history: {pushState(s, t, url) {window.location.href = new URL(url, window.location.href).href;}, replaceState(s, t, url) {window.location.href = new URL(url, window.location.href).href;}, back() {}}};
const ctx = vm.createContext({URL, URLSearchParams, document, window, history: window.history, fetch: fakeFetch, Array, Object, String, Number, Boolean, Math, JSON, Map, Set, Error, Promise, Date: FrozenDate, Intl, RegExp, setTimeout, clearTimeout, AbortController, console});
vm.runInContext(bundle, ctx);
const run = code => vm.runInContext(code, ctx);
const settle = async () => {await run('limboLive.pending'); await new Promise(resolve => setTimeout(resolve, 0));};
const click = target => run('onLimboResult')({preventDefault() {}, target: {closest: selector => target(selector)}});

await settle();
const buttons = [...results.innerHTML.matchAll(/<article class="admin-hit limbo-item" data-limbo-item="([^"]+)">[\s\S]*?<\/article>/g)].map(([html, id]) => ({id, button: /data-limbo-recovery="(\d+)"/.exec(html)?.[1] || null}));
assert.ok(buttons.length >= 2, results.innerHTML.slice(0, 400));
for (const {id, button} of buttons) {
  const film = /film:(stuck|later)$/.test(id);
  assert.equal(button !== null, film, id + (film ? ' explains its prediction' : ' has no recovery button'));
}
assert.doesNotMatch(results.innerHTML, /Повторить<|data-limbo-action/);
const slot = buttons.find(item => /film:stuck$/.test(item.id)).button;
assert.match(results.innerHTML, new RegExp(`data-limbo-recovery="${slot}" aria-expanded="false" aria-controls="limbo-recovery-${slot}">Разобрать прогноз</button>`));
assert.match(results.innerHTML, new RegExp(`<section class="limbo-recovery" id="limbo-recovery-${slot}" data-limbo-recovery-slot="${slot}" aria-label="Разбор прогноза" hidden>`));

// Open: one GET for this film, the panel explains it; the canary profile text never reaches the page.
const panel = document.querySelector(`[data-limbo-recovery-slot="${slot}"]`), button = document.querySelector(`[data-limbo-recovery="${slot}"]`);
requests = [];
await click(selector => selector === '[data-limbo-recovery]' ? button : null);
await settle();
assert.deepEqual(requests.map(request => request.method + ' ' + request.path), ['GET /api/admin/prediction-recovery?film=stuck']);
assert.equal(panel.hidden, false);
assert.equal(button.getAttribute('aria-expanded'), 'true');
assert.equal(button.textContent, 'Скрыть разбор');
assert.match(panel.innerHTML, /Фильм в очереди и готов к обработке/);
assert.match(panel.innerHTML, /<h4>Почему здесь нет кнопки «повторить»<\/h4>/);
assert.doesNotMatch(panel.innerHTML, /CANARY/);

// Recheck after the queue changed: the held pin is stale, the panel says the state changed and shows the fresh verdict.
set(QUEUE, {...records.get(QUEUE), retries: {...records.get(QUEUE).retries, stuck: {attempts: 2, retryAt: NOW + 3 * H, kind: 'validation_error', scope: 'item', failedAt: iso(-H), lastRunId: 'run-2'}}});
requests = [];
await click(selector => selector === '[data-limbo-recovery-recheck]' ? {} : selector === '[data-limbo-recovery-slot]' ? panel : null);
await settle();
assert.equal(requests.length, 2, 'the pinned read, then a fresh one');
assert.match(requests[0].path, /film=stuck&pin=R1\./);
assert.doesNotMatch(requests[1].path, /pin=/);
assert.match(panel.innerHTML, /Состояние изменилось с прошлой проверки/);
assert.equal(panel.hidden, false, 'a recheck keeps the panel open');
assert.equal(button.getAttribute('aria-expanded'), 'true');
assert.match(panel.innerHTML, /Прошлая попытка не удалась, следующая уже назначена/);
assert.match(panel.innerHTML, /не раньше 31\.10\.2026, 13:00 Madrid/);
// An unchanged recheck keeps the pin and says nothing changed.
requests = [];
await click(selector => selector === '[data-limbo-recovery-recheck]' ? {} : selector === '[data-limbo-recovery-slot]' ? panel : null);
await settle();
assert.equal(requests.length, 1);
assert.doesNotMatch(panel.innerHTML, /Состояние изменилось/);

// A lease without an expiry: the panel says the run state is unknown, never that there is no run.
set('enrichment/runner-lease.json', {runId: 'run-3', heartbeatAt: iso(-60000)});
await click(selector => selector === '[data-limbo-recovery-recheck]' ? {} : selector === '[data-limbo-recovery-slot]' ? panel : null);
await settle();
assert.match(panel.innerHTML, /<dt>запуск<\/dt><dd>состояние запуска неизвестно<\/dd>/);
assert.doesNotMatch(panel.innerHTML, /сейчас запуска нет/);
assert.match(panel.innerHTML, /Не удалось прочитать: состояние текущего запуска/);

// Close: no request, the panel hides.
requests = [];
await click(selector => selector === '[data-limbo-recovery]' ? button : null);
assert.equal(panel.hidden, true);
assert.equal(button.getAttribute('aria-expanded'), 'false');
assert.equal(button.textContent, 'Разобрать прогноз');
assert.deepEqual(requests, []);

assert.ok(requests.every(request => request.method === 'GET'));
console.log('Admin prediction recovery page: copy for every code, fail closed, escaping, Madrid times, toggle, recheck after a change, no action passed');
