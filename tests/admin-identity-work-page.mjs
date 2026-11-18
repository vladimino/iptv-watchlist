// The unified identity queue on /admin/limb (read-only): static boundary, the pure view (escaping, wording, no Film link without proof,
// coverage labelled as an estimate) and the controller over a DOM stand-in (first page, show more under the pin, stale keeps rows,
// error, reset). Real browser checks at 1280 and 390 px are a written report in the PR, not a test.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {bundleAdmin} from '../src/admin/bundle.js';

const html = fs.readFileSync('public/admin-limbo.html', 'utf8');
const css = fs.readFileSync('public/admin.css', 'utf8');
const build = fs.readFileSync('build.mjs', 'utf8');
const files = {client: 'src/admin/client.js', iwClient: 'src/admin/identity-work-client.js', view: 'src/admin/identity-work-view.js', controller: 'public/admin-identity-work.js'};
const text = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')]));

// ---- static boundary ----
for (const id of ['iw-section', 'iw-form', 'iw-type', 'iw-disposition', 'iw-q', 'iw-include', 'iw-reset', 'iw-refresh', 'iw-loading', 'iw-error', 'iw-error-text', 'iw-retry', 'iw-stale', 'iw-reload', 'iw-verdict', 'iw-coverage', 'iw-coverage-body', 'iw-empty', 'iw-empty-text', 'iw-results', 'iw-more']) assert.match(html, new RegExp(`id="${id}"`), id);
assert.ok(html.indexOf('id="limbo-results"') < html.indexOf('id="iw-section"') && html.indexOf('id="iw-section"') < html.indexOf('id="limbo-causes"'), 'the identity queue sits after the existing queue and before its filters');
assert.doesNotMatch(html.slice(html.indexOf('id="iw-section"'), html.indexOf('id="limbo-filters-panel"')), /<details[^>]*\bopen\b/, 'panels stay closed');
assert.match(html, /<label class="limbo-field iw-q-field" for="iw-q">/);
assert.match(html.slice(html.indexOf('id="iw-section"')), /Только чтение: ничего не запускается и не меняется/);
for (const [name, source] of Object.entries(text).filter(([name]) => name !== 'client')) {
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|\bfetch\(/i, name + ' only reads through adminCall and stores nothing');
}
assert.deepEqual([...text.iwClient.matchAll(/adminCall\('([^']+)'/g)].map(match => match[1]), ['/identity-work'], 'the only route is identity-work');
assert.match(build, /identity-work-client\.js[^]*identity-work-view\.js[^]*public\/admin-limbo\.js[^]*public\/admin-identity-work\.js/, 'the bundle order: client, view, existing page script, controller');
assert.match(css, /\.iw-more\[hidden\]/, 'the show-more button honours hidden despite display:block of .admin-more');

// ---- bundle in one scope, as the page runs it ----
const bundle = bundleAdmin([text.client, text.iwClient, text.view]);
function loadView() {
  const context = vm.createContext({URLSearchParams, Intl, Date, encodeURIComponent, String, Number, Array, Object, JSON, Math, Promise});
  vm.runInContext(bundle + '\nthis.api={iwRowHtml,iwRowsHtml,iwCoverageHtml,iwVerdict,iwEmptyText,iwErrorText,iwEscape,loadIdentityWork,identityWorkParams};', context);
  return context.api;
}
const api = loadView();
const SHA = 'a'.repeat(64);
const row = extra => ({key: 'lbc:' + SHA + ':Aa1', type: 'letterboxd_rated_candidate', status: 'pending', reason: null, disposition: 'waiting', title: 'The Matrix', year: 1999, shortCode: 'Aa1', archiveSha256: SHA, provenance: [{source: 'letterboxd_archive', ref: SHA}, {source: 'archive_chunk', ref: '0'}], lastProgressAt: '2026-11-10T10:00:00.000Z', ageMs: 9 * 86400000, film: null, observedHints: [], ...extra});

// escaping and the Film rule
{
  const evil = api.iwRowHtml(row({title: '<img src=x onerror=alert(1)>', reason: '"><b>x</b>', key: 'k"><x'}));
  assert.doesNotMatch(evil, /<img|<b>x|"><x/, 'every answer value is escaped');
  assert.doesNotMatch(api.iwRowHtml(row()), /href="\/admin\?kind=film/, 'no Film link without proof');
  assert.match(api.iwRowHtml(row()), /Фильм не подтверждён/);
  const proven = api.iwRowHtml(row({status: 'verified', disposition: 'resolved', film: {filmId: 'tmdb_603', proof: 'film_rated_admission'}}));
  assert.match(proven, /href="\/admin\?kind=film&amp;id=tmdb_603"/); assert.match(proven, /подтверждено admission в D1 по архиву и коду/);
  assert.match(api.iwRowHtml(row({status: 'verified', reason: 'admission_unconfirmed', disposition: 'needs_owner_review'})), /в D1 нет admission, совпадающего и по архиву, и по короткому коду/);
  const hinted = api.iwRowHtml(row({observedHints: [{kind: 'title_year_match', trusted: false, ref: 'epg:x'}]}));
  assert.match(hinted, /Не доказано, фильм не назначен/); assert.match(hinted, /epg:x/);
  assert.match(api.iwRowHtml(row({title: null, year: null})), /<h4 class="iw-title">Aa1/, 'a row without a title is headed by its short code');
  const lanes = api.iwRowsHtml([row({type: 'film', key: 'film:1'}), row({type: 'film', key: 'film:2'}), row()]);
  assert.equal((lanes.match(/class="iw-lane"/g) || []).length, 3 - 1, 'consecutive rows of one lane share one heading');
}
// coverage and verdict wording
{
  const coverage = {film: {state: 'partial', observed: 2}, epg_observation: {state: 'unavailable', reason: 'index_unavailable'}, letterboxd_rated_candidate: {enumeration: {state: 'partial', reason: 'unindexed_archives', registered: 1, listed: 2, unindexed: 1}, counts: {basis: 'registry_estimate', summarizedAt: '2026-11-18T10:00:00.000Z', state: 'estimate', byStatus: {pending: 3, admitting: 0, needs_review: 1, verified: 0, removed: 0}}, page: {archiveSha256: SHA, state: 'registry_stale', indexed: true}, selected: null}};
  const out = api.iwCoverageHtml(coverage);
  assert.match(out, /оценка по реестру/); assert.match(out, /не проверены/); assert.match(out, /ожидают 3/);
  assert.match(out, /частичное: есть архивы, которых нет в реестре/); assert.match(out, /не в реестре 1/);
  assert.match(out, /документ изменился после записи реестра/); assert.match(out, /по каждому архиву отдельно/);
  assert.match(out, /не прочитаны \(index_unavailable\)\. Это не значит, что их нет/);
  assert.doesNotMatch(out, /полное покрытие|нет работы|всё в порядке/i);
  const complete = api.iwCoverageHtml({letterboxd_rated_candidate: {enumeration: {state: 'complete', registered: 2, listed: 2, unindexed: 0}, counts: {state: 'estimate', summarizedAt: null, byStatus: {pending: 0, admitting: 0, needs_review: 0, verified: 0, removed: 0}}, page: {state: 'read_whole'}}});
  assert.match(complete, /полное \(проверено только наличие префиксов\)/); assert.doesNotMatch(complete, /нет работы|полное покрытие/);
  assert.match(api.iwCoverageHtml({letterboxd_rated_candidate: {enumeration: {state: 'partial', reason: 'registry_invalid'}, counts: {state: 'invalid', byStatus: null}, page: {state: 'not_read'}}}), /реестр недоступен \(invalid\), оценки нет/);
  // an absent registry is no estimate: no zeros, whatever the listing holds
  const absent = api.iwCoverageHtml({letterboxd_rated_candidate: {enumeration: {state: 'partial', reason: 'unindexed_archives', registered: 0, listed: 3, unindexed: 3}, counts: {basis: 'registry_estimate', summarizedAt: null, state: 'absent', byStatus: {pending: 0, admitting: 0, needs_review: 0, verified: 0, removed: 0}}, page: {archiveSha256: SHA, state: 'read_whole', indexed: false}}});
  assert.match(absent, /реестр архивов ещё не создан, оценки нет/); assert.match(absent, /не вошедших в реестр: 3/);
  assert.doesNotMatch(absent, /ожидают 0|оценка по реестру/, 'zero counts of an absent registry are never shown as an estimate');
  // a partially indexed registry: the estimate is scoped to the registered archives and says the others are unknown
  const partial = api.iwCoverageHtml({letterboxd_rated_candidate: {enumeration: {state: 'partial', reason: 'unindexed_archives', registered: 1, listed: 3, unindexed: 2}, counts: {basis: 'registry_estimate', summarizedAt: '2026-11-18T10:00:00.000Z', state: 'estimate', byStatus: {pending: 0, admitting: 0, needs_review: 0, verified: 0, removed: 0}}, page: {state: 'read_whole'}}});
  assert.match(partial, /только по архивам, которые есть в реестре \(1\)/); assert.match(partial, /Архивы вне реестра \(2\) в эти счётчики не входят, их содержимое неизвестно/);
  assert.match(api.iwCoverageHtml({letterboxd_rated_candidate: {enumeration: {state: 'partial', reason: 'listing_truncated', registered: 1, listed: 1000}, counts: {state: 'estimate', byStatus: {pending: 1, admitting: 0, needs_review: 0, verified: 0, removed: 0}}, page: {state: 'not_read'}}}), /могут быть архивы, о которых счётчики ничего не говорят/);
  assert.doesNotMatch(complete, /вне реестра|могут быть архивы/, 'a complete enumeration adds no scope warning');
  assert.match(complete, /только по архивам, которые есть в реестре/, 'the estimate is always scoped to the registered archives');
  assert.match(api.iwCoverageHtml({}), /Покрытие не прочитано/);
  assert.match(api.iwCoverageHtml({letterboxd_rated_candidate: {enumeration: {state: 'complete'}, counts: {state: 'absent', byStatus: {pending: 0, admitting: 0, needs_review: 0, verified: 0, removed: 0}}, page: {state: 'read_whole'}, selected: SHA}}), /Это не покрытие всех архивов/);
  assert.match(api.iwVerdict({mode: 'ready', rows: [1, 2], nextCursor: 'c', coverage}), /Показано записей: 2\. Есть следующая страница\. Покрытие частичное/);
  assert.doesNotMatch(api.iwVerdict({mode: 'ready', rows: [], nextCursor: null, coverage: {letterboxd_rated_candidate: {enumeration: {state: 'complete'}, page: {state: 'read_whole'}}}}), /нет работы/);
  assert.match(api.iwEmptyText({rows: [], nextCursor: 'c', coverage}), /нажмите «Показать ещё»/);
  assert.match(api.iwEmptyText({rows: [], nextCursor: null, coverage}), /Перечисление архивов частичное, поэтому это не означает, что работы нет/);
  assert.match(api.iwEmptyText({rows: [], nextCursor: null, coverage}), /пустота не доказана/);
  assert.match(api.iwErrorText('storage_unavailable'), /Хранилище сейчас недоступно/); assert.match(api.iwErrorText('weird<'), /weird&lt;/);
}
// client: params, pin only with a cursor, stale and error mapping, no write
{
  assert.deepEqual({...api.identityWorkParams({type: 'film', disposition: '', include: true, q: ' '.trim()}, null)}, {type: 'film', disposition: null, include: 'resolved', q: null, limit: 25, cursor: null});
  assert.equal(api.identityWorkParams({type: '', disposition: 'blocked', include: true, q: ''}, 'c').include, null, 'a disposition filter already decides about resolved rows');
  const seen = [];
  const reply = (status, body) => async url => {seen.push(String(url)); return {ok: status < 400, status, json: async () => body};};
  const body = {pin: 'P1', snapshot: {}, rows: [{key: 'a'}], nextCursor: 'n1', coverage: {film: {state: 'partial'}}};
  const first = await api.loadIdentityWork({type: '', disposition: '', include: false, q: ''}, null, {fetch: reply(200, body), pin: 'ignored'});
  assert.deepEqual([first.mode, first.pin, first.rows.length, first.nextCursor], ['ready', 'P1', 1, 'n1']);
  assert.doesNotMatch(seen[0], /pin=/, 'the first page carries no pin');
  const more = await api.loadIdentityWork({type: '', disposition: '', include: false, q: ''}, 'n1', {fetch: reply(200, body), pin: 'P1'});
  assert.match(seen[1], /cursor=n1/); assert.match(seen[1], /pin=P1/); assert.equal(more.mode, 'ready');
  assert.equal((await api.loadIdentityWork({}, 'n1', {fetch: reply(200, {...body, pin: 'P2'}), pin: 'P1'})).mode, 'stale', 'a different pin is a stale read');
  assert.deepEqual({...(await api.loadIdentityWork({}, 'n1', {fetch: reply(409, {error: 'stale_pin'}), pin: 'P1'}))}, {mode: 'stale', error: 'stale_pin'});
  assert.equal((await api.loadIdentityWork({}, 'n1', {fetch: reply(400, {error: 'stale_cursor'}), pin: 'P1'})).error, 'stale_cursor');
  assert.deepEqual({...(await api.loadIdentityWork({}, null, {fetch: reply(503, {error: 'storage_unavailable'})}))}, {mode: 'error', error: 'storage_unavailable'});
  assert.equal((await api.loadIdentityWork({}, null, {fetch: async () => {throw new TypeError('x');}})).error, 'network');
}

// ---- controller over a DOM stand-in ----
function node(id) {
  const listeners = {};
  return {id, value: '', checked: false, hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {}, attrs: {}, listeners,
    addEventListener(type, fn) {listeners[type] = fn;}, setAttribute(name, value) {this.attrs[name] = value;}};
}
async function runController(responses) {
  const ids = ['iw-section', 'iw-form', 'iw-type', 'iw-disposition', 'iw-q', 'iw-include', 'iw-reset', 'iw-refresh', 'iw-reload', 'iw-retry', 'iw-more', 'iw-loading', 'iw-error', 'iw-error-text', 'iw-stale', 'iw-verdict', 'iw-results', 'iw-empty', 'iw-empty-text', 'iw-coverage-body'];
  const nodes = Object.fromEntries(ids.map(id => [id, node(id)]));
  const calls = [];
  const context = vm.createContext({URLSearchParams, Intl, Date, encodeURIComponent, String, Number, Array, Object, JSON, Math, Promise, AbortController, setTimeout,
    document: {querySelector: selector => nodes[selector.slice(1)] || null},
    fetch: async url => {calls.push(String(url)); const next = responses.shift(); return {ok: next.status < 400, status: next.status, json: async () => next.body};}});
  vm.runInContext(bundleAdmin([text.client, text.iwClient, text.view, text.controller]) + '\nthis.iwLive=iwLive;', context);
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  await settle();
  return {nodes, calls, live: context.iwLive, settle};
}
const ok = (rows, next, pin = 'P1') => ({status: 200, body: {pin, snapshot: {}, rows, nextCursor: next, coverage: {film: {state: 'partial'}, letterboxd_rated_candidate: {enumeration: {state: 'complete'}, counts: {state: 'estimate', summarizedAt: null, byStatus: {pending: 0, admitting: 0, needs_review: 0, verified: 0, removed: 0}}, page: {state: 'read_whole'}}}}});
{
  const view = await runController([ok([row()], 'n1'), ok([row({key: 'lbc:' + SHA + ':Bb2', shortCode: 'Bb2'})], null)]);
  assert.equal(view.calls.length, 1); assert.match(view.calls[0], /^\/api\/admin\/identity-work\?limit=25$/);
  assert.equal(view.nodes['iw-more'].hidden, false); assert.match(view.nodes['iw-results'].innerHTML, /data-iw-key="lbc:/);
  assert.match(view.nodes['iw-verdict'].textContent, /Показано записей: 1\. Есть следующая страница/);
  view.nodes['iw-more'].listeners.click(); await view.settle();
  assert.match(view.calls[1], /cursor=n1/); assert.match(view.calls[1], /pin=P1/);
  assert.equal((view.nodes['iw-results'].innerHTML.match(/data-iw-key=/g) || []).length, 2); assert.equal(view.nodes['iw-more'].hidden, true);
}
{
  const view = await runController([ok([row()], 'n1'), {status: 409, body: {error: 'stale_pin'}}, ok([row()], null, 'P2')]);
  view.nodes['iw-more'].listeners.click(); await view.settle();
  assert.equal(view.live.mode, 'stale'); assert.equal(view.nodes['iw-stale'].hidden, false);
  assert.match(view.nodes['iw-results'].innerHTML, /data-iw-key=/, 'rows stay, flagged by the banner');
  view.nodes['iw-reload'].listeners.click(); await view.settle();
  assert.equal(view.live.mode, 'ready'); assert.equal(view.nodes['iw-stale'].hidden, true); assert.doesNotMatch(view.calls[2], /cursor=/, 'reload starts from the first page'); assert.doesNotMatch(view.calls[2], /pin=/);
}
{
  // a failed first page of a NEW query shows nothing of the previous query and pages with no old cursor
  const view = await runController([ok([row()], 'n1'), {status: 503, body: {error: 'storage_unavailable'}}, ok([], null, 'P2')]);
  assert.match(view.nodes['iw-results'].innerHTML, /data-iw-key=/); assert.equal(view.nodes['iw-more'].hidden, false);
  view.nodes['iw-type'].value = 'film'; view.nodes['iw-q'].value = 'other';
  view.nodes['iw-form'].listeners.submit({preventDefault() {}}); await view.settle();
  assert.equal(view.live.mode, 'error'); assert.equal(view.nodes['iw-error'].hidden, false);
  assert.doesNotMatch(view.nodes['iw-results'].innerHTML, /data-iw-key=/, 'no row of the previous query stays as current');
  assert.match(view.nodes['iw-coverage-body'].innerHTML, /Покрытие не прочитано/, 'nor its coverage');
  assert.equal(view.nodes['iw-more'].hidden, true, 'no paging after a failed first page');
  assert.equal(view.nodes['iw-empty'].hidden, true, 'a failed read is not an empty list');
  assert.match(view.nodes['iw-verdict'].textContent, /Очередь не прочитана/);
  assert.equal(view.live.next, null); assert.equal(view.live.pin, null);
  view.nodes['iw-retry'].listeners.click(); await view.settle();
  assert.doesNotMatch(view.calls[2], /cursor=|pin=/, 'the retry starts from the first page');
  assert.match(view.calls[2], /type=film/); assert.equal(view.live.mode, 'ready');
}
{
  // a failed or stale "show more" hides paging; reload starts over
  const view = await runController([ok([row()], 'n1'), {status: 503, body: {error: 'network'}}]);
  view.nodes['iw-more'].listeners.click(); await view.settle();
  assert.equal(view.live.mode, 'error'); assert.equal(view.nodes['iw-more'].hidden, true);
  const stale = await runController([ok([row()], 'n1'), {status: 409, body: {error: 'stale_pin'}}]);
  stale.nodes['iw-more'].listeners.click(); await stale.settle();
  assert.equal(stale.live.mode, 'stale'); assert.equal(stale.nodes['iw-more'].hidden, true);
}
{
  const view = await runController([{status: 503, body: {error: 'storage_unavailable'}}, ok([], null)]);
  assert.equal(view.nodes['iw-error'].hidden, false); assert.match(view.nodes['iw-error-text'].textContent, /Хранилище сейчас недоступно/);
  view.nodes['iw-retry'].listeners.click(); await view.settle();
  assert.equal(view.nodes['iw-error'].hidden, true); assert.equal(view.nodes['iw-empty'].hidden, false); assert.doesNotMatch(view.nodes['iw-empty-text'].textContent, /нет работы/);
}
{
  const view = await runController([ok([row()], null), ok([], null)]);
  view.nodes['iw-type'].value = 'film'; view.nodes['iw-q'].value = '  matrix '; view.nodes['iw-disposition'].value = 'blocked';
  view.nodes['iw-form'].listeners.submit({preventDefault() {}}); await view.settle();
  assert.match(view.calls[1], /type=film/); assert.match(view.calls[1], /disposition=blocked/); assert.match(view.calls[1], /q=matrix/); assert.doesNotMatch(view.calls[1], /include=/);
  view.nodes['iw-reset'].listeners.click(); await view.settle();
  assert.equal(view.nodes['iw-type'].value, ''); assert.equal(view.nodes['iw-q'].value, '');
  assert.ok(view.calls.every(call => call.startsWith('/api/admin/identity-work')), 'no other request');
}
console.log('admin-identity-work-page: ok');
