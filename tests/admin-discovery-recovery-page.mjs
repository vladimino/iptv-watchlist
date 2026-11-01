// The observation panel on /admin/limbo. The view: Russian copy for every verdict, gate reason, refusal and receipt state,
// fail closed on an undeclared code, escaping, identifiers only inside the closed technical details, the action controls
// only for an eligible preview. The page over the Worker bundle: an observation item opens its panel; the checkbox names
// the exact observation and only enables «Подтвердить»; the server-issued confirmation, then one execution, then a fresh
// read beside the receipt; cancel and refusals keep the owner in control; focus follows the step.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {bundleAdmin} from '../src/admin/bundle.js';
import {scoped} from '../scripts/bundle-scope.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import * as V from '../src/admin/discovery-recovery-view.js';
import {ADMIN_ACTION_REFUSALS} from '../src/domain/admin-actions.js';
import {DISCOVERY_RECOVERY_VERDICTS} from '../src/domain/discovery-recovery.js';

const build = fs.readFileSync('build.mjs', 'utf8');
const bundleLine = build.split('\n').find(line => line.includes("assets['/admin-limbo.js']"));
assert.ok(bundleLine.indexOf('src/admin/limbo-client.js') < bundleLine.indexOf('src/admin/discovery-recovery-view.js') && bundleLine.indexOf('src/admin/discovery-recovery-view.js') < bundleLine.indexOf('public/admin-limbo.js'), 'the view is bundled after the client and before the page');
const viewSource = fs.readFileSync('src/admin/discovery-recovery-view.js', 'utf8');
assert.doesNotMatch(viewSource, /\bfetch\(|adminCall|<form|method=|localStorage|Authorization/, 'the view reads nothing and sends nothing');

// 1. The view's vocabularies are closed and complete.
assert.deepEqual(Object.keys(V.OBS_VERDICT_COPY).sort(), [...DISCOVERY_RECOVERY_VERDICTS].sort());
for (const refusal of [...ADMIN_ACTION_REFUSALS, 'lease_unknown', 'storage_unavailable', 'network']) assert.ok(V.OBS_REFUSAL_COPY[refusal], refusal);
const okAnswer = {
  pin: 'D1.' + 'a'.repeat(32), evaluatedAt: '2026-10-31T12:00:00.000Z', target: {key: 'тихий|2001'}, indexed: true,
  index: {state: 'fresh', reasons: [], programmeRunId: 'run-1', writtenAt: '2026-10-31T11:00:00.000Z', writer: 'resolver_chunk'},
  observation: {key: 'тихий|2001', title: 'Тихий', normalizedTitle: 'тихий', year: 2001, durations: [95], shows: [{channelId: 'c1', channel: 'Первый', start: Date.parse('2026-10-31T15:00:00.000Z')}], decision: {status: 'no_confident_match', attempts: 5, terminalReason: 'repeated_uncertain_match', retryAt: null, lastAttemptAt: '2026-10-28T12:00:00.000Z', evidenceKey: 'ev'}, decisionHash: 'f'.repeat(64)},
  assessment: {verdict: 'no_more_evidence', reason: 'repeated_uncertain_match', observation: {activity: 'current', evidence: 'same'}, series: {state: 'continuing', reason: null, at: null}, retry: {helps: 'unlikely'}, next: {actor: 'new_epg_evidence', at: null}, review: {suggested: true}, execute: {available: true, capability: 'discovery_reconsider', version: 1, reason: 'eligible', effect: {when: 'next_ordinary_chunk', at: null}}, evidence: {completeness: 'complete', missing: [], anomalies: []}},
  action: {status: 'eligible', reason: null, scopeFingerprint: '0a0b0c0d', confirmTtlMs: 600000},
  sources: ['epg/published-generation.json'],
};
assert.equal(V.obsRecoveryExplainable(okAnswer), true);
for (const broken of [{verdict: 'brand_new'}, {execute: {...okAnswer.assessment.execute, reason: 'brand_new'}}, {next: {actor: 'someone'}}, {series: {state: 'dancing'}}, {reason: 'new_terminal'}, {execute: {...okAnswer.assessment.execute, effect: {when: 'later'}}}]) {
  const answer = {...okAnswer, assessment: {...okAnswer.assessment, ...broken}};
  assert.equal(V.obsRecoveryExplainable(answer), false, JSON.stringify(broken));
  const html = V.obsRecoveryPanelHtml(answer, {slot: 'o1'});
  assert.match(html, /Невозможно достоверно объяснить состояние наблюдения/);
  assert.doesNotMatch(html, /data-obs-recovery-accept|data-obs-recovery-confirm/, 'no action on an unexplained answer');
}
const visible = html => html.replace(/<details class="recovery-tech">[\s\S]*?<\/details>/g, '');
let html = V.obsRecoveryPanelHtml(okAnswer, {slot: 'o1'});
assert.match(html, /Автоматические попытки исчерпаны на тех же данных/);
assert.match(html, /пять попыток подряд без уверенного совпадения/);
assert.match(html, /Запросов к TMDB: 0\. Запусков резолвера: 0\./);
assert.match(html, /ровно одна дополнительная обычная попытка/);
assert.match(html, /<input type="checkbox" id="obs-accept-o1" data-obs-recovery-accept> <label for="obs-accept-o1">Я хочу снять терминальную отметку только с наблюдения «Тихий» \(2001\)/);
assert.match(html, /data-obs-recovery-confirm disabled/);
assert.match(html, /<details class="recovery-tech"><summary>Технические подробности<\/summary>/);
assert.doesNotMatch(visible(html), /D1\.|f{64}|тихий\|2001|discovery_reconsider|0a0b0c0d/, 'identifiers only in the technical details');
assert.match(V.obsRecoveryPanelHtml(okAnswer, {slot: 'o1', accepted: true}), /data-obs-recovery-confirm>Подтвердить/);
html = V.obsRecoveryPanelHtml(okAnswer, {slot: 'o1', confirmation: {idempotencyKey: 'k'.repeat(20), expiresAt: '2026-10-31T12:10:00.000Z'}});
assert.match(html, /Подтверждение выдано, действует до 31\.10\.2026, 13:10 Madrid/);
assert.match(html, /data-obs-recovery-execute>Повторно направить на проверку/);
assert.match(html, /data-obs-recovery-cancel>Отменить/);
assert.doesNotMatch(visible(html), /k{20}/);
html = V.obsRecoveryPanelHtml({...okAnswer, assessment: {...okAnswer.assessment, execute: {...okAnswer.assessment.execute, available: false, reason: 'writer_active', effect: {when: 'none', at: null}}}, action: {status: 'ineligible'}}, {slot: 'o1'});
assert.match(html, /Недоступно — резолвер сейчас пишет: вмешиваться нельзя\./);
assert.doesNotMatch(html, /data-obs-recovery-accept/);
html = V.obsRecoveryPanelHtml({...okAnswer, observation: {...okAnswer.observation, title: '<img src=x onerror=alert(1)>'}}, {slot: 'o1'});
assert.doesNotMatch(html, /<img/);
assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
for (const [state, text] of [['succeeded', /терминальная отметка снята/], ['unknown', /Исход неизвестен/], ['aborted', /Прервано/], ['failed', /карта решений изменилась/]]) {
  assert.match(V.obsRecoveryPanelHtml(okAnswer, {slot: 'o1', receipt: {state, outcomes: []}}), text, state);
}
assert.match(V.obsRecoveryPanelHtml(okAnswer, {slot: 'o1', receipt: {state: 'refused', refusal: 'stale_pin', outcomes: []}}), /Отказ\. Данные изменились после просмотра/);
assert.match(V.obsRecoveryPanelHtml(okAnswer, {slot: 'o1', receipt: {state: 'mystery'}}), /Квитанция не распознана/);
assert.match(V.obsRecoveryPanelHtml(okAnswer, {slot: 'o1', receipt: {state: 'succeeded', outcomes: []}, durable: false}), /Квитанция не сохранилась/);
for (const state of ['missing', 'stale', 'other_generation', 'malformed', 'torn', 'unavailable']) {
  const text = V.obsRecoveryPanelHtml({...okAnswer, indexed: false, observation: null, assessment: null, index: {state}}, {slot: 'o1'});
  assert.match(text, /Индекса? наблюдений|Нет опубликованного поколения/, state);
  assert.doesNotMatch(text, /data-obs-recovery-accept/);
}
assert.match(V.obsRecoveryPanelHtml({...okAnswer, index: {...okAnswer.index, state: 'stale'}}, {slot: 'o1'}), /Индекс наблюдений устарел/);
assert.match(V.obsRecoveryErrorHtml('http_500'), /ошибкой 500/);
assert.doesNotMatch(V.obsRecoveryErrorHtml('<b>x</b>'), /<b>/);

// 2. The page over the Worker bundle and an R2 stand-in.
const page = fs.readFileSync('public/admin-limbo.js', 'utf8');
const bundle = bundleAdmin([fs.readFileSync('src/admin/client.js', 'utf8'), fs.readFileSync('src/admin/limbo-client.js', 'utf8'), fs.readFileSync('src/admin/prediction-recovery-view.js', 'utf8'), viewSource, page]);
assert.doesNotMatch(page, /\bfetch\(/, 'the page reaches the API only through the client');
const css = fs.readFileSync('public/admin.css', 'utf8');
assert.match(css, /\.obs-accept\{display:flex/);
assert.match(css, /@media\(max-width:800px\)\{[^}]*\}?[^@]*\.recovery-controls \.admin-more\{display:block;width:100%/, 'full-width controls on a phone');
assert.match(css, /\.obs-identity-option,\.obs-identity-accept\{[^}]*min-height:44px/);
assert.match(css, /\.obs-identity input\[type="text"\],\.obs-identity button,\.obs-identity \.admin-more\{min-height:44px\}/);
assert.match(css, /\.obs-identity-receipt:focus\{outline:2px solid #9bc48a/);

const memory = new MemoryBucket();
let clock = Date.parse('2026-10-31T12:00:00.000Z'), tmdbCalls = 0;
const FrozenDate = class extends Date {constructor(...args) {super(...(args.length ? args : [clock]));} static now() {return clock;}};
const workerContext = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date: FrozenDate, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, atob, btoa, crypto: webcrypto, console: {log() {}}, setTimeout, structuredClone, encodeURIComponent, decodeURIComponent,
  ASSETS: {}, INITIAL_PERSONAL_RATINGS: {}, FILM_TITLE_DICTIONARY: [], PERSON_NAME_DICTIONARY: [],
  fetch: async () => {tmdbCalls++; throw new Error('no outbound request');}});
vm.runInContext(scoped('src/domain/discovery-observation-index.js', 'DiscoveryIndex'), workerContext);
for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/sources.js', 'src/discovery.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), workerContext);
vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), workerContext);
vm.runInContext(scoped('src/domain/limbo-inventory.js', 'LimboInventory'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/owner-reviews.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/limbo.js', 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/admin-actions.js', 'AdminActions'), workerContext);
vm.runInContext(scoped('src/domain/discovery-identity-review.js', 'DiscoveryIdentity'), workerContext);
vm.runInContext(scoped('src/domain/discovery-recovery.js', 'DiscoveryRecovery'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/discovery-recovery.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/worker.js', 'utf8').replace('export default', 'globalThis.worker='), workerContext);
const env = {BUCKET: memory};
workerContext.env = env;
const RUN = '11111111-1111-4111-8111-111111111111', H = 3600000, D = 86400000;
const TARGET = 'тихий берег|2001', OTHER = 'громкий берег|2002', AMBIG = 'двойник|2003';
const iso = ms => new Date(clock + ms).toISOString();
const put = (key, value) => memory.put(key, JSON.stringify(value));
const candidate = (key, title) => ({key, title, normalizedTitle: key.split('|')[0], year: Number(key.split('|')[1]), durations: [95], shows: [{channelId: 'c1', channel: 'Первый', start: clock + 3 * H, end: clock + 5 * H}], seenInLatestSnapshot: true, lastSeenAt: clock - H, lastAiring: clock + 3 * H});
async function seed() {
  memory.objects.clear();
  const items = [candidate(TARGET, 'Тихий берег'), candidate(OTHER, 'Громкий берег'), candidate(AMBIG, 'Двойник')];
  workerContext.__items = items;
  const evidence = item => vm.runInContext('candidateEvidence(__c)', Object.assign(workerContext, {__c: item}));
  const decisions = {
    [TARGET]: {status: 'no_confident_match', attempts: 5, evidenceKey: evidence(items[0]), lastAttemptAt: iso(-3 * D), checkedAt: iso(-3 * D), retryAt: null, terminalReason: 'repeated_uncertain_match'},
    [OTHER]: {status: 'no_confident_match', attempts: 5, evidenceKey: evidence(items[1]), lastAttemptAt: iso(-2 * D), checkedAt: iso(-2 * D), retryAt: null, terminalReason: 'repeated_uncertain_match'},
    [AMBIG]: {status: 'ambiguous', attempts: 2, evidenceKey: evidence(items[2]), lastAttemptAt: iso(-H), checkedAt: iso(-H), retryAt: iso(D), terminalReason: null},
  };
  await put('epg/published-generation.json', {phase: 'published', programmeRunId: RUN, publishedAt: iso(-5 * H)});
  await put('epg/generations/' + RUN + '/programme.json', {runId: RUN, updatedAt: iso(-5 * H), films: [], people: {directors: [], actors: []}, stats: {}});
  await put('titles.json', {}); await put('people.json', {});
  await put('epg/generations/' + RUN + '/discovery-latest.json', {programmeRunId: RUN, items});
  await put('epg/discovery-resolution.json', decisions);
  await put('epg/resolver-continuation.json', {stage: 'paused', reason: null, remainingChunks: 6, programmeRunId: RUN, at: iso(-H)});
  await put('epg/discovery-status.json', {stage: 'complete', programmeRunId: RUN});
  workerContext.__source = {programmeRunId: RUN, items};
  workerContext.__decisions = decisions;
  await vm.runInContext('ADMIN_SNAPSHOT_CACHE=null;ADMIN_LIMBO_CACHE=null;saveObservationIndex(env,__source,__decisions,async()=>true,{kind:"resolver_chunk"})', workerContext);
}
await seed();
let requests = [];
const fakeFetch = async (input, init = {}) => {
  const url = new URL(String(input), 'https://iptv.example');
  requests.push({method: init.method || 'GET', path: url.pathname + url.search, headers: init.headers || {}, credentials: init.credentials, body: init.body});
  // The edge adds the Access assertion and the browser the Origin; the page never sets either.
  const headers = {...(init.headers || {}), 'Cf-Access-Jwt-Assertion': 'edge.jwt.value', ...(init.method === 'POST' ? {Origin: 'https://iptv.example'} : {})};
  return workerContext.worker.fetch(new Request('https://iptv.example' + url.pathname + url.search, {method: init.method || 'GET', headers, body: init.body}), env, {waitUntil() {throw new Error('background work');}});
};

// DOM stand-in: fixed page nodes; button and panel nodes present while the results hold them; panel children by selector.
const attrs = new Map();
const document = {body: {}, activeElement: null};
function element(selector, parent = null) {
  const children = new Map();
  const node = {
    selector, parent, hidden: false, innerHTML: '', textContent: '', value: '', disabled: false, checked: false,
    setAttribute(name, value) {attrs.set(selector + ':' + name, value);},
    getAttribute(name) {return attrs.get(selector + ':' + name) ?? null;},
    removeAttribute(name) {attrs.delete(selector + ':' + name);},
    focus() {document.activeElement = this;}, insertAdjacentHTML(position, markup) {this.innerHTML += markup;}, remove() {}, addEventListener() {},
    closest(match) {return match === '[data-obs-recovery-slot]' ? parent : null;},
    querySelector(child) {
      const present = child.split(',').map(part => part.trim()).find(part => {
        const attr = /^\[([a-z-]+)(?:="([^"]+)")?\]$/.exec(part), cls = /^\.([a-z-]+)$/.exec(part);
        return attr ? new RegExp(attr[2] ? `${attr[1]}="${attr[2]}"` : `${attr[1]}(?=[\\s>])`).test(this.innerHTML) : cls ? new RegExp(`class="[^"]*\\b${cls[1]}\\b`).test(this.innerHTML) : false;
      });
      if (!present) return null;
      if (!children.has(present)) children.set(present, element(selector + ' ' + present, this));
      const found = children.get(present);
      if (present === '[data-obs-recovery-confirm]' && found.renderedFrom !== this.innerHTML) {
        found.renderedFrom = this.innerHTML;
        found.disabled = /data-obs-recovery-confirm[^>]*disabled/.test(this.innerHTML);
      }
      return found;
    },
  };
  return node;
}
const nodes = new Map(['#limbo-snapshot-text', '#limbo-causes', '#limbo-subsystems', '#limbo-form', '#limbo-kind', '#limbo-age', '#limbo-reset', '#limbo-loading', '#limbo-stale', '#limbo-refresh', '#limbo-error', '#limbo-empty', '#limbo-results', '#limbo-total', '#limbo-context-body'].map(selector => [selector, element(selector)]));
const dynamic = new Map();
const results = nodes.get('#limbo-results');
document.querySelector = selector => {
  if (nodes.has(selector)) return nodes.get(selector);
  const match = /^\[(data-(?:obs|limbo)-recovery(?:-slot)?)="([^"]+)"\]$/.exec(selector);
  if (!match || !results.innerHTML.includes(`${match[1]}="${match[2]}"`)) return null;
  if (!dynamic.has(selector)) {const node = element(selector); node.setAttribute(match[1], match[2]); dynamic.set(selector, node);}
  return dynamic.get(selector);
};
const window = {addEventListener() {}, location: {href: 'https://iptv.example/admin/limbo?kind=observation'}, history: {pushState(s, t, url) {window.location.href = new URL(url, window.location.href).href;}, replaceState(s, t, url) {window.location.href = new URL(url, window.location.href).href;}, back() {}}};
const ctx = vm.createContext({URL, URLSearchParams, document, window, history: window.history, fetch: fakeFetch, crypto: webcrypto, Array, Object, String, Number, Boolean, Math, JSON, Map, Set, Error, Promise, Date: FrozenDate, Intl, RegExp, Uint8Array, setTimeout, clearTimeout, AbortController, console});
vm.runInContext(bundle, ctx);
const run = code => vm.runInContext(code, ctx);
const settle = async () => {for (let index = 0; index < 4; index++) {await run('limboLive.pending'); await new Promise(resolve => setTimeout(resolve, 0));}};
const click = (panel, selector) => run('onLimboResult')({preventDefault() {}, target: {closest: match => match === selector ? {} : match === '[data-obs-recovery-slot]' ? panel : null}});
const openButton = slot => document.querySelector(`[data-obs-recovery="${slot}"]`);

await settle();
const items = [...results.innerHTML.matchAll(/<article class="admin-hit limbo-item" data-limbo-item="([^"]+)">([\s\S]*?)<\/article>/g)].map(([, id, inner]) => ({id, inner, slot: /data-obs-recovery="(o\d+)"/.exec(inner)?.[1] || null}));
assert.equal(items.length, 3, results.innerHTML.slice(0, 300));
assert.ok(items.every(item => item.slot), 'every observation item can be explained');
const slotOf = title => items.find(item => item.inner.includes(`<span class="admin-hit-title">${title}</span>`)).slot;
const target = slotOf('Тихий берег');
assert.match(results.innerHTML, new RegExp(`data-obs-recovery="${target}" aria-expanded="false" aria-controls="obs-recovery-${target}">Разобрать наблюдение</button>`));
assert.match(results.innerHTML, new RegExp(`<section class="limbo-recovery" id="obs-recovery-${target}" data-obs-recovery-slot="${target}" aria-label="Разбор наблюдения" hidden>`));
const cardFace = html => html.replace(/<details class="limbo-tech">[\s\S]*?<\/details>/g, '');
const face = cardFace(results.innerHTML).replace(/data-limbo-item="[^"]*"/g, '');
assert.match(face, /Автоматическое исправление недоступно\. Кнопка ниже только объясняет, почему/);
assert.match(face, /Разбор ниже скажет, можно ли вернуть наблюдение в обычную очередь/);
assert.match(face, /class="limbo-actions"/);
assert.doesNotMatch(face, /\|2001|observation:|недопустимо|не применимо|Identity Review|admin-status-plain|неизвестно/);
assert.match(results.innerHTML, /<details class="limbo-tech">[\s\S]*тихий берег\|2001/);
assert.match(nodes.get('#limbo-context-body').innerHTML, /Наблюдения: частичное покрытие — в индексе 3 нерешённых наблюдений с решением резолвера/);

// Open: one GET for this key; the panel explains it and offers the checkbox; «Подтвердить» is disabled.
const panel = document.querySelector(`[data-obs-recovery-slot="${target}"]`);
requests = [];
await run('onLimboResult')({preventDefault() {}, target: {closest: match => match === '[data-obs-recovery]' ? openButton(target) : null}});
await settle();
assert.deepEqual(requests.map(item => item.method + ' ' + item.path), ['GET /api/admin/discovery-recovery?key=' + encodeURIComponent(TARGET).replace(/%20/g, '+')]);
assert.equal(panel.hidden, false);
assert.equal(openButton(target).getAttribute('aria-expanded'), 'true');
assert.equal(openButton(target).textContent, 'Скрыть разбор');
assert.match(panel.innerHTML, /Автоматические попытки исчерпаны/);
assert.match(panel.innerHTML, /только с наблюдения «Тихий берег» \(2001\)/);
assert.equal(panel.querySelector('[data-obs-recovery-confirm]').disabled, true);
// The checkbox enables the button without redrawing the panel (focus stays on it); confirming is one POST.
const before = panel.innerHTML;
run('onLimboResultChange')({target: {closest: match => match === '[data-obs-recovery-accept]' ? {checked: true, closest: () => panel} : null}});
assert.equal(panel.innerHTML, before, 'not redrawn');
assert.equal(panel.querySelector('[data-obs-recovery-confirm]').disabled, false);
requests = [];
await click(panel, '[data-obs-recovery-confirm]');
await settle();
assert.equal(requests.length, 1);
const sent = requests[0];
assert.equal(sent.method, 'POST');
assert.equal(sent.path, '/api/admin/discovery-recovery/confirm');
assert.equal(sent.credentials, 'same-origin');
assert.deepEqual(JSON.parse(JSON.stringify(sent.headers)), {Accept: 'application/json', 'Content-Type': 'application/json', 'X-IPTV-Admin-Action': 'discovery_reconsider'}, 'no token from the page; Access is the credential');
const confirmBody = JSON.parse(sent.body);
assert.equal(confirmBody.key, TARGET);
assert.equal(confirmBody.accepted, true);
assert.match(confirmBody.idempotencyKey, /^[0-9a-f]{36}$/);
assert.match(panel.innerHTML, /Подтверждение выдано, действует до 31\.10\.2026, 13:10 Madrid/);
assert.equal(document.activeElement, panel.querySelector('[data-obs-recovery-execute]'), 'focus moves to the execution button');
assert.equal(JSON.parse(await (await memory.get('epg/discovery-resolution.json')).text())[TARGET].terminalReason, 'repeated_uncertain_match', 'confirming changes nothing');
// Execute: one POST, then a fresh read; the receipt and the new state side by side; focus on the receipt.
requests = [];
await click(panel, '[data-obs-recovery-execute]');
await settle();
assert.deepEqual(requests.map(item => item.method + ' ' + item.path.split('?')[0]), ['POST /api/admin/discovery-recovery/reconsider', 'GET /api/admin/discovery-recovery', 'GET /api/admin/discovery-recovery']);
assert.match(requests[1].path, /pin=D1\./, 'the re-read carries the held pin; its 409 says the state changed');
assert.doesNotMatch(requests[2].path, /pin=/, 'then one fresh read without the pin');
assert.match(panel.innerHTML, /Записано: терминальная отметка снята, наблюдение вернулось в обычную очередь/);
assert.match(panel.innerHTML, /Состояние изменилось с прошлой проверки/);
assert.match(panel.innerHTML, /Наблюдение в обычной очереди/);
assert.match(panel.innerHTML, /повторно направлено<\/dt><dd>31\.10\.2026, 13:00 Madrid владельцем/);
assert.equal(document.activeElement, panel.querySelector('.obs-receipt'), 'focus moves to the receipt');
assert.match(panel.innerHTML, new RegExp(`<dt>idempotencyKey|<dt>receipt<\\/dt><dd>succeeded`), 'the receipt is in the technical details');
assert.doesNotMatch(panel.innerHTML.replace(/<details class="recovery-tech">[\s\S]*?<\/details>/g, ''), /D1\.[0-9a-f]{32}|[0-9a-f]{64}/, 'no pin or digest outside the details');
assert.equal(JSON.parse(await (await memory.get('epg/discovery-resolution.json')).text())[TARGET].terminalReason, null);
assert.equal(JSON.parse(await (await memory.get('epg/discovery-resolution.json')).text())[OTHER].terminalReason, 'repeated_uncertain_match');
// A recheck starts over: the receipt is gone, the gate now says there is nothing to lift.
await click(panel, '[data-obs-recovery-recheck]');
await settle();
assert.doesNotMatch(panel.innerHTML, /obs-receipt/);
assert.match(panel.innerHTML, /Недоступно — наблюдение и так в обычной очереди: запись ничего не изменит\./);

// Cancel: back to the checkbox, nothing executed.
const other = slotOf('Громкий берег');
const otherPanel = document.querySelector(`[data-obs-recovery-slot="${other}"]`);
await run('onLimboResult')({preventDefault() {}, target: {closest: match => match === '[data-obs-recovery]' ? openButton(other) : null}});
await settle();
run('onLimboResultChange')({target: {closest: match => match === '[data-obs-recovery-accept]' ? {checked: true, closest: () => otherPanel} : null}});
await click(otherPanel, '[data-obs-recovery-confirm]');
await settle();
assert.match(otherPanel.innerHTML, /data-obs-recovery-execute/);
requests = [];
await click(otherPanel, '[data-obs-recovery-cancel]');
assert.deepEqual(requests, [], 'cancel sends nothing');
assert.match(otherPanel.innerHTML, /data-obs-recovery-accept/);
assert.doesNotMatch(otherPanel.innerHTML, /data-obs-recovery-execute/);
assert.equal(document.activeElement, otherPanel.querySelector('[data-obs-recovery-accept]'));
// A busy resolver at execution: the refusal is shown and the confirmation kept for a later try.
run('onLimboResultChange')({target: {closest: match => match === '[data-obs-recovery-accept]' ? {checked: true, closest: () => otherPanel} : null}});
await click(otherPanel, '[data-obs-recovery-confirm]');
await settle();
await put('epg/resolver-lease.json', {id: 'chunk-hop', expiresAt: clock + 60000});
await click(otherPanel, '[data-obs-recovery-execute]');
await settle();
assert.match(otherPanel.innerHTML, /Резолвер сейчас занят\. Ничего не записано/);
assert.match(otherPanel.innerHTML, /Недоступно — резолвер сейчас пишет/);
assert.match(otherPanel.innerHTML, /Подтверждение сохранено до 31\.10\.2026, 13:10 Madrid/);
assert.doesNotMatch(otherPanel.innerHTML, /data-obs-recovery-execute/, 'no execution while the lease is live');
assert.equal(JSON.parse(await (await memory.get('epg/discovery-resolution.json')).text())[OTHER].terminalReason, 'repeated_uncertain_match');
// The resolver frees the lease; a recheck brings the held confirmation back, and it executes.
await put('epg/resolver-lease.json', {id: 'chunk-hop', expiresAt: 0});
await click(otherPanel, '[data-obs-recovery-recheck]');
await settle();
assert.doesNotMatch(otherPanel.innerHTML, /Резолвер сейчас занят/);
assert.match(otherPanel.innerHTML, /data-obs-recovery-execute/, 'the confirmation stays usable');
await click(otherPanel, '[data-obs-recovery-execute]');
await settle();
assert.match(otherPanel.innerHTML, /Записано: терминальная отметка снята/);
assert.equal(JSON.parse(await (await memory.get('epg/discovery-resolution.json')).text())[OTHER].terminalReason, null);
// Past its expiry a held confirmation is dropped on a recheck.
await click(panel, '[data-obs-recovery-recheck]');
await settle();
run(`obsRecovery.get(${JSON.stringify(target)}).confirmation = {idempotencyKey: 'x'.repeat(36), expiresAt: '2026-10-31T11:59:00.000Z'}`);
await click(panel, '[data-obs-recovery-recheck]');
await settle();
assert.equal(run(`obsRecovery.get(${JSON.stringify(target)}).confirmation`), null);

// An ineligible observation: the reason, no checkbox.
const ambig = slotOf('Двойник');
const ambigPanel = document.querySelector(`[data-obs-recovery-slot="${ambig}"]`);
await run('onLimboResult')({preventDefault() {}, target: {closest: match => match === '[data-obs-recovery]' ? openButton(ambig) : null}});
await settle();
assert.match(ambigPanel.innerHTML, /Идентичность неоднозначна/);
assert.match(ambigPanel.innerHTML, /выбрать по одному названию нельзя/);
assert.doesNotMatch(ambigPanel.innerHTML, /Автоматическое исправление этой проблемы пока недоступно/);
assert.match(ambigPanel.innerHTML, /Недоступно — идентичность неоднозначна: нужен разбор идентичности, а не повтор\./);
assert.doesNotMatch(panel.innerHTML, /Автоматическое исправление этой проблемы пока недоступно/);
assert.doesNotMatch(ambigPanel.innerHTML, /data-obs-recovery-accept/);
// Close: no request.
requests = [];
await run('onLimboResult')({preventDefault() {}, target: {closest: match => match === '[data-obs-recovery]' ? openButton(ambig) : null}});
assert.equal(ambigPanel.hidden, true);
assert.equal(openButton(ambig).getAttribute('aria-expanded'), 'false');
assert.equal(openButton(ambig).textContent, 'Разобрать наблюдение');
assert.deepEqual(requests, []);
assert.equal(tmdbCalls, 0, 'nothing on the page reached TMDB');

// Without an index the context says observations are unavailable, and why.
await seed();
await memory.delete('epg/generations/' + RUN + '/discovery-observations/manifest.json');
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null;ADMIN_LIMBO_CACHE=null', workerContext);
await run('onLimboRefresh()');
await settle();
assert.match(nodes.get('#limbo-context-body').innerHTML, /Нерешённые наблюдения EPG недоступны: индекса наблюдений для опубликованного поколения ещё нет/);
assert.doesNotMatch(results.innerHTML, /data-obs-recovery=/);

// Identity correction is a second action on the same panel: exact posts, a refused repeat that stays on the form, then an assign.
async function seedIdentity() {
  await seed();
  const items = [{...candidate(TARGET, 'Тихий берег'), confirmedTmdbId: '11'}, candidate(OTHER, 'Громкий берег'), candidate(AMBIG, 'Двойник')];
  const evidence = item => vm.runInContext('candidateEvidence(__c)', Object.assign(workerContext, {__c: item}));
  const decisions = {
    [TARGET]: {status: 'needs_verification', attempts: 2, evidenceKey: evidence(items[0]), lastAttemptAt: iso(-H), checkedAt: iso(-H), retryAt: null, terminalReason: null, scoring: {scorerVersion: '1', status: 'accepted', reason: 'unique', acceptedTmdbId: '11'}},
    [OTHER]: {status: 'no_confident_match', attempts: 1, evidenceKey: evidence(items[1]), retryAt: null, terminalReason: null},
    [AMBIG]: {status: 'ambiguous', attempts: 2, evidenceKey: evidence(items[2]), lastAttemptAt: iso(-H), checkedAt: iso(-H), retryAt: iso(D), terminalReason: null},
  };
  await put('epg/generations/' + RUN + '/discovery-latest.json', {programmeRunId: RUN, items});
  await put('epg/discovery-resolution.json', decisions);
  await put('epg/discovered-films.json', {tmdb_11: {id: 'tmdb_11', tmdbId: '11', canonicalIdentity: 'tmdb:11', title: 'Тихий берег', year: 2001}});
  workerContext.__source = {programmeRunId: RUN, items};
  workerContext.__decisions = decisions;
  await vm.runInContext('ADMIN_SNAPSHOT_CACHE=null;ADMIN_LIMBO_CACHE=null;saveObservationIndex(env,__source,__decisions,async()=>true,{kind:"resolver_chunk"})', workerContext);
}
function identityEdit(panel, attributes, extra = {}) {
  const target = {
    value: extra.value ?? '',
    checked: extra.checked === true,
    getAttribute(name) {return Object.hasOwn(attributes, name) ? attributes[name] : null;},
    closest(match) {
      if (String(match).includes('data-obs-identity')) return target;
      if (match === '[data-obs-recovery-slot]') return panel;
      return null;
    },
  };
  run('onLimboResultChange')({target});
}
await seedIdentity();
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null;ADMIN_LIMBO_CACHE=null', workerContext);
await run('onLimboRefresh()');
await settle();
const identityItems = [...results.innerHTML.matchAll(/<article class="admin-hit limbo-item" data-limbo-item="([^"]+)">([\s\S]*?)<\/article>/g)].map(([, id, inner]) => ({id, inner, slot: /data-obs-recovery="(o\d+)"/.exec(inner)?.[1] || null}));
const identitySlot = identityItems.find(item => item.inner.includes('<span class="admin-hit-title">Тихий берег</span>')).slot;
const identityPanel = document.querySelector(`[data-obs-recovery-slot="${identitySlot}"]`);
requests = [];
await run('onLimboResult')({preventDefault() {}, target: {closest: match => match === '[data-obs-recovery]' ? openButton(identitySlot) : null}});
await settle();
assert.match(identityPanel.innerHTML, /Идентичность этого наблюдения/);
assert.match(identityPanel.innerHTML, /Индекс покрывает только текущие нерешённые наблюдения с решением/);
assert.match(identityPanel.innerHTML, /Ключ доказательства:/);
assert.match(identityPanel.innerHTML, /Гипотеза автоматики \(не выбор\): 11/);
assert.match(identityPanel.innerHTML, /value="11"[^>]*data-obs-identity-choice/);
assert.match(identityPanel.innerHTML, /Я меняю идентичность только наблюдения «Тихий берег», ключ тихий берег\|2001, поколение 11111111-1111-4111-8111-111111111111/);
assert.match(identityPanel.innerHTML, /data-obs-identity-confirm disabled/);
assert.doesNotMatch(identityPanel.innerHTML, /<form/);
await click(identityPanel, '[data-obs-identity-confirm]');
await settle();
assert.deepEqual(requests.filter(item => item.method === 'POST'), [], 'an unchecked identity form sends nothing');
identityEdit(identityPanel, {'data-obs-identity-effect': ''}, {value: 'reject', checked: true});
identityEdit(identityPanel, {'data-obs-identity-id': ''}, {value: '11'});
identityEdit(identityPanel, {'data-obs-identity-basis': ''}, {value: 'не тот фильм'});
await click(identityPanel, '[data-obs-identity-confirm]');
await settle();
assert.deepEqual(requests.filter(item => item.method === 'POST'), [], 'without the checkbox nothing is posted');
identityEdit(identityPanel, {'data-obs-identity-accept': ''}, {checked: true});
requests = [];
await click(identityPanel, '[data-obs-identity-confirm]');
await settle();
assert.equal(requests.length, 1);
const identityConfirm = requests[0];
assert.equal(identityConfirm.method, 'POST');
assert.equal(identityConfirm.path, '/api/admin/discovery-recovery/identity-confirm');
assert.equal(identityConfirm.credentials, 'same-origin');
assert.equal(identityConfirm.headers['X-IPTV-Admin-Action'], 'discovery_identity_correct');
const identityBody = JSON.parse(identityConfirm.body);
assert.equal(identityBody.key, TARGET);
assert.equal(identityBody.effect, 'reject');
assert.equal(identityBody.tmdbId, '11');
assert.equal(identityBody.basis, 'не тот фильм');
assert.equal(identityBody.accepted, true);
assert.match(identityBody.idempotencyKey, /^[0-9a-f]{36}$/);
assert.equal(document.activeElement, identityPanel.querySelector('[data-obs-identity-execute]'));
requests = [];
await click(identityPanel, '[data-obs-identity-execute]');
await settle();
assert.equal(requests.filter(item => item.method === 'POST').length, 1);
assert.equal(requests.find(item => item.method === 'POST').path, '/api/admin/discovery-recovery/identity-correct');
assert.equal(JSON.parse(requests.find(item => item.method === 'POST').body).confirmation.capability, 'discovery_identity_correct');
const rejectedDecision = JSON.parse(await (await memory.get('epg/discovery-resolution.json')).text())[TARGET];
assert.deepEqual(rejectedDecision.rejectedTmdbIds, ['11']);
assert.equal(rejectedDecision.ownerIdentity.effect, 'reject');
assert.notEqual(rejectedDecision.status, 'verified');
assert.match(identityPanel.innerHTML, /Отказ записан только для этого наблюдения и этого id/);
assert.equal(document.activeElement, identityPanel.querySelector('.obs-identity-receipt'));
assert.equal(tmdbCalls, 0);
identityEdit(identityPanel, {'data-obs-identity-effect': ''}, {value: 'reject', checked: true});
identityEdit(identityPanel, {'data-obs-identity-id': ''}, {value: '11'});
identityEdit(identityPanel, {'data-obs-identity-basis': ''}, {value: 'ещё раз'});
identityEdit(identityPanel, {'data-obs-identity-accept': ''}, {checked: true});
requests = [];
await click(identityPanel, '[data-obs-identity-confirm]');
await settle();
assert.deepEqual(requests.filter(item => item.method === 'POST'), [], 'a repeat rejection is refused before a request');
assert.match(identityPanel.innerHTML, /Уже так\. Новой записи нет\./);
assert.match(identityPanel.innerHTML, /data-obs-identity-confirm/);
identityEdit(identityPanel, {'data-obs-identity-effect': ''}, {value: 'assign', checked: true});
identityEdit(identityPanel, {'data-obs-identity-choice': ''}, {value: '11', checked: true});
identityEdit(identityPanel, {'data-obs-identity-basis': ''}, {value: 'это тот фильм'});
identityEdit(identityPanel, {'data-obs-identity-accept': ''}, {checked: true});
requests = [];
await click(identityPanel, '[data-obs-identity-confirm]');
await settle();
assert.equal(requests.length, 1);
assert.equal(JSON.parse(requests[0].body).effect, 'assign');
assert.equal(JSON.parse(requests[0].body).tmdbId, '11');
await click(identityPanel, '[data-obs-identity-execute]');
await settle();
const assignedDecision = JSON.parse(await (await memory.get('epg/discovery-resolution.json')).text())[TARGET];
assert.equal(assignedDecision.identitySource, 'owner');
assert.equal(assignedDecision.tmdbId, '11');
assert.equal(assignedDecision.status, 'verified');
assert.match(identityPanel.innerHTML, /Решение по этому наблюдению записано/);
assert.match(identityPanel.innerHTML, /Показы каталога обновятся следующим обычным чанком/);
assert.equal(JSON.parse(await (await memory.get('epg/discovery-resolution.json')).text())[OTHER].status, 'no_confident_match');
assert.equal(tmdbCalls, 0, 'the page correction calls no one');

console.log('Admin discovery recovery page: copy for every code, fail closed, escaping, technical details, open, accept, confirm, execute, receipt, recheck, cancel, busy resolver, ineligible, close, focus, identity assign and reject passed');
