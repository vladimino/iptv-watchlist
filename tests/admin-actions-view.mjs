// The guarded action panel and its demonstration page on a DOM stand-in. Every one of the five demonstration
// situations must read as a problem, an action, a risk, an outcome and a next step in plain Russian; the primary view
// shows fictional titles and never raw ids, versions, codes or fingerprints, which stay in the closed technical
// disclosure; the simulate button stays off until an eligible, fully explained preview is acknowledged; and the page
// makes no request and writes nothing outside its in-tab store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {bundleAdmin} from '../src/admin/bundle.js';

const html = fs.readFileSync('public/admin-actions.html', 'utf8');
const page = fs.readFileSync('public/admin-actions.js', 'utf8');
const sources = ['src/domain/admin-actions.js', 'src/admin/actions-fixture.js', 'src/admin/actions-presentation.js', 'src/admin/actions-view.js'].map(file => fs.readFileSync(file, 'utf8'));
const bundle = bundleAdmin([...sources, page]);
assert.match(html, /Тренажёр на вымышленных данных\. Реальные фильмы не меняются\./, 'a permanent simulation banner');
assert.match(html, /<h2 id="action-harness-title">Демонстрационные ситуации<\/h2>/, 'the scenario selector is labelled as a demonstration harness');
assert.match(html, /<script src="\/admin-actions\.js"><\/script>/);
assert.doesNotMatch(bundle, /\bfetch\(|\/api\/|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|Authorization|Bearer|anthropic|openai/i, 'the demonstration makes no request, stores nothing and calls no model');
const build = fs.readFileSync('build.mjs', 'utf8');
assert.match(build, /assets\['\/admin\/actions'\]/);
assert.match(build, /actions-presentation\.js[\s\S]*actions-view\.js/, 'the page bundle includes the presentation layer before the panel');
assert.doesNotMatch(fs.readFileSync('public/admin.js', 'utf8'), /admin-actions|mountActionPanel/, 'the /admin shell is not changed');

const listeners = [];
let focused = null;
function element(name) {
  return {name, innerHTML: '', textContent: '', value: '', disabled: false, checked: false, options: [],
    addEventListener(type, fn) {listeners.push({name, type, fn});},
    focus() {focused = name;},
    querySelector(selector) {return nodes[selector] || null;}};
}
const nodes = {};
for (const name of ['#action-scenario', '#action-scenario-note', '#action-root', '[data-action-preview]', '[data-action-accept]', '[data-action-accept-text]', '[data-action-confirm]', '[data-action-repreview]', '[data-action-receipt]', '[data-action-result-title]']) nodes[name] = element(name);
const document = {querySelector: selector => nodes[selector] || null};
const fire = (name, type) => Promise.all(listeners.filter(item => item.name === name && item.type === type).map(item => item.fn()));
const ctx = vm.createContext({document, crypto: webcrypto, structuredClone, Date, JSON, Map, Set, Promise, Error, Object, Array, String, Number, Math, Uint8Array, Intl, console, setTimeout});
vm.runInContext(bundle, ctx);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const preview = nodes['[data-action-preview]'], accept = nodes['[data-action-accept]'], acceptText = nodes['[data-action-accept-text]'];
const confirm = nodes['[data-action-confirm]'], receipt = nodes['[data-action-receipt]'], note = nodes['#action-scenario-note'];
const writes = () => JSON.parse(vm.runInContext('JSON.stringify(actionDemo.store.writes)', ctx));
const technical = text => (text.match(/<details class="action-tech">[\s\S]*?<\/details>/g) || []).join('');
const primary = () => [preview.innerHTML, receipt.innerHTML].map(text => text.replace(/<details class="action-tech">[\s\S]*?<\/details>/g, '')).join('\n') + '\n' + acceptText.textContent + '\n' + confirm.textContent + '\n' + note.textContent;
const visible = () => primary().replace(/<[^>]+>/g, ' ');
// Nothing internal in the primary view: ids, versions, raw enums and codes, fingerprints, keys, jargon.
const FORBIDDEN = [/film:/, /\bv1\b/, /\bineligible\b/, /generation_changed/, /\beligible\b/, /\batomic/i, /\b[0-9a-f]{8}\b/, /demo-pin/, /demo-[0-9a-f]{6}/, /metadata_/, /provider_error|timeout\b|fence_lost|internal_error/, /stale_pin|record_changed|confirmation_/, /\bCAS\b|lease|idempot|fingerprint|отпечат|хэш|hash/i, /restore_before_image|fixture_metadata_refresh/, /issue|scope|pin\b/i];
function assertReadable(where) {
  const text = visible();
  for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, where + ': primary view shows ' + pattern);
}
const scenario = async code => {nodes['#action-scenario'].value = code; await fire('#action-scenario', 'change'); await settle();};
const simulate = async () => {accept.checked = true; await fire('[data-action-accept]', 'change'); return vm.runInContext('actionDemo.panel.confirm()', ctx);};
const SECTIONS = ['Что не так', 'Что мы собираемся изменить', 'Кого это затронет (и почему)', 'Кого пропустим (и почему)', 'Что может пойти не так / как поступить'];
function assertOrder(text) {
  let at = -1;
  for (const heading of SECTIONS) {
    const index = text.indexOf('<h3>' + heading + '</h3>');
    assert.ok(index > at, 'section in order: ' + heading);
    at = index;
  }
}

// 1. Load: the "eligible" situation explains everything, names fictional films, writes nothing, and keeps confirm off.
await settle();
assert.match(nodes['#action-scenario'].innerHTML, /Два фильма можно обновить/);
assert.match(note.textContent, /^Имитируем: .+ Увидим: .+/);
assert.match(preview.innerHTML, /<h2 class="action-title">Проверка перед обновлением метаданных<\/h2>/);
assert.match(preview.innerHTML, /Можно смоделировать изменение/);
assertOrder(preview.innerHTML);
assert.match(preview.innerHTML, /Тестовый фильм «Север»<\/b><span>Причина: метаданные давно не обновлялись\. Сведения собраны полностью\./);
assert.match(preview.innerHTML, /Тестовый фильм «Тихая гавань»<\/b><span>Причина: метаданные заполнены не полностью\./);
assert.match(preview.innerHTML, /Не будем изменять тестовый фильм «Пустой лист»: сведения относятся к предыдущему обновлению, поэтому сейчас нельзя безопасно продолжать\.<\/span><span class="action-next">Что делать: Сначала обновите сведения и повторите проверку\./);
assert.match(preview.innerHTML, /Изменения выполняются по одному фильму\. Если что-то пойдёт не так, часть фильмов может обновиться, остальные нет\. Мы покажем результат каждого\. Автоматический откат не обещаем\./);
assert.match(preview.innerHTML, /Внешние сервисы это действие не вызывает\./);
assert.match(preview.innerHTML, /В тренажёре изменение только моделируется/);
assertReadable('eligible preview');
// The technical disclosure keeps the stable ids, versions and codes, escaped, for support.
const tech = technical(preview.innerHTML);
assert.match(tech, /<summary>Технические подробности<\/summary>/);
for (const fragment of ['film:north', 'film:blank', 'v1', 'generation_changed', 'ineligible', 'atomic', 'demo-pin-1', 'fixture_metadata_refresh v1']) assert.ok(tech.includes(fragment), 'technical details keep ' + fragment);
assert.match(tech, /[0-9a-f]{8}/, 'technical details keep the scope fingerprint');
assert.doesNotMatch(preview.innerHTML, /<details[^>]* open/, 'the disclosure starts closed');
assert.deepEqual(writes(), [], 'opening the page writes nothing');
assert.equal(accept.disabled, false); assert.equal(accept.checked, false);
assert.equal(confirm.disabled, true, 'nothing runs without the explicit acknowledgement');
assert.equal(confirm.textContent, 'Смоделировать изменение (2 тестовых фильма)');
assert.equal(acceptText.textContent, 'Подтверждаю: смоделировать обновление метаданных для 2 тестовых фильма — тестовый фильм «Север», тестовый фильм «Тихая гавань». Понимаю, что часть фильмов может не обновиться; результат будет показан по каждому.');
assert.equal(await vm.runInContext('actionDemo.panel.confirm()', ctx), null, 'a disabled button executes nothing');
await fire('[data-action-repreview]', 'click'); await settle();
assert.deepEqual(writes(), [], 'a fresh check writes nothing');

// 2. Simulate: the result says N of M, names each film, and the stable ids stay in the scope that ran.
await simulate();
assert.deepEqual(writes(), ['film:north', 'film:quiet'], 'the stable ids are what the in-tab store wrote');
assert.match(receipt.innerHTML, /<h3 class="action-result-title" tabindex="-1" data-action-result-title>Что получилось<\/h3>/);
assert.equal(focused, '[data-action-result-title]', 'focus moves to the result');
assert.match(receipt.innerHTML, /Всё получилось/);
assert.match(receipt.innerHTML, /Удалось для 2 из 2 тестовых фильмов\. Это моделирование: реальные фильмы не менялись\./);
assert.match(receipt.innerHTML, /Тестовый фильм «Север»<\/b><span>Изменено\./);
assert.match(receipt.innerHTML, /Больше ничего делать не нужно\./);
assert.ok(technical(receipt.innerHTML).includes('film:north · written'), 'the receipt disclosure keeps per-record codes');
assert.equal(accept.checked, false);
assertReadable('succeeded receipt');

// 3. Partial: one film failed, the result says what to do with it.
await scenario('partial');
assert.equal(receipt.innerHTML, '', 'a new situation starts without an old result');
await simulate();
assert.match(receipt.innerHTML, /Получилось частично/);
assert.match(receipt.innerHTML, /Удалось для 1 из 2 тестовых фильмов/);
assert.match(receipt.innerHTML, /Тестовый фильм «Тихая гавань»<\/b><span>Не удалось — источник данных вернул ошибку\.<\/span><span class="action-next">Что делать: Можно повторить: запустите проверку заново и подтвердите новый список\./);
assert.match(receipt.innerHTML, /Посмотрите следующий шаг у каждого фильма, который не изменился\./);
assert.ok(technical(receipt.innerHTML).includes('provider_error'));
assertReadable('partial receipt');

// 4. Unknown: no retry without checking.
await scenario('unknown');
await simulate();
assert.match(receipt.innerHTML, /Результат части изменений неизвестен/);
assert.match(receipt.innerHTML, /Тестовый фильм «Север»<\/b><span>Не знаем, применилось ли изменение — источник не ответил вовремя\.<\/span><span class="action-next">Что делать: НЕ повторяйте, пока не проверите карточку этого фильма\./);
assert.match(receipt.innerHTML, /НЕ повторяйте действие, пока не проверите их карточки/);
assertReadable('unknown receipt');

// 5. Stale: refused, nothing changed, with the fix; a fresh check recovers.
await scenario('stale');
await simulate();
assert.match(receipt.innerHTML, /Отказано: ничего не выполнялось/);
assert.match(receipt.innerHTML, /Причина: после проверки на сайте опубликовались новые данные\./);
assert.match(receipt.innerHTML, /Как исправить: Повторите проверку: новые данные могли изменить список\./);
assert.deepEqual(writes(), [], 'a refused submission writes nothing');
assertReadable('refused receipt');
await fire('[data-action-repreview]', 'click'); await settle();
assert.match(preview.innerHTML, /Можно смоделировать изменение/, 'a fresh check reads the new data');
await simulate();
assert.match(receipt.innerHTML, /Всё получилось/);

// 6. Nothing eligible: every film has a reason and a next step, and nothing can be confirmed.
await scenario('ineligible');
assert.match(preview.innerHTML, /Недостаточно сведений, чтобы решить/);
assert.match(preview.innerHTML, /Дождитесь полной проверки данных и повторите\./);
assert.match(preview.innerHTML, /Никого: изменять сейчас нечего\./);
assert.match(preview.innerHTML, /Не будем изменять тестовый фильм «Двойник»: сведений недостаточно, чтобы понять, нужно ли и безопасно ли обновление\./);
assert.match(preview.innerHTML, /Не будем изменять тестовый фильм «Пустой лист»: сведения относятся к предыдущему обновлению/);
assert.equal(accept.disabled, true); assert.equal(confirm.disabled, true, 'incomplete evidence never enables confirmation');
assert.match(acceptText.textContent, /Подтверждать нечего: выполнение недоступно/);
assertReadable('blocked preview');
assert.deepEqual(writes(), []);

// 7. Every situation has a purpose and an expected result, and none of them wrote anything outside the in-tab store.
const scenarios = JSON.parse(vm.runInContext('JSON.stringify(Object.entries(ACTION_SCENARIOS).map(([code, item]) => [code, item.title, item.note]))', ctx));
assert.deepEqual(scenarios.map(([code]) => code), ['eligible', 'partial', 'unknown', 'stale', 'ineligible']);
for (const [, title, text] of scenarios) {assert.ok(title.length > 3); assert.match(text, /^Имитируем: .+ Увидим: .+/);}

// 8. An eligible situation with one unnamed skipped film cannot be acknowledged or executed.
vm.runInContext(`delete ACTION_DEMO_TITLES['film:blank'];`, ctx);
await scenario('eligible');
assert.match(preview.innerHTML, /Невозможно достоверно объяснить действие; выполнение недоступно/);
assert.equal(accept.disabled, true); assert.equal(confirm.disabled, true, 'an unnamed skipped film blocks the acknowledgement and the button');
accept.checked = true; await fire('[data-action-accept]', 'change');
assert.equal(accept.checked, false); assert.equal(confirm.disabled, true);
assert.equal(await vm.runInContext('actionDemo.panel.confirm()', ctx), null, 'execution is impossible');
assert.deepEqual(writes(), []);
vm.runInContext(`ACTION_DEMO_TITLES['film:blank'] = 'Пустой лист';`, ctx);

// 9. A hostile fictional title is escaped everywhere; an unknown action code never enables the simulate button.
vm.runInContext(`ACTION_DEMO_TITLES['film:north'] = '<img src=x onerror=alert(1)>';`, ctx);
await scenario('eligible');
assert.doesNotMatch(preview.innerHTML + receipt.innerHTML, /<img/);
assert.match(preview.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
vm.runInContext(`actionDemo.store.issues.forEach(issue => {issue.reason = 'future_reason_code';});`, ctx);
await fire('[data-action-repreview]', 'click'); await settle();
assert.match(preview.innerHTML, /Невозможно достоверно объяснить действие; выполнение недоступно/);
assert.doesNotMatch(preview.innerHTML.replace(/<details class="action-tech">[\s\S]*?<\/details>/g, ''), /future_reason_code/);
assert.equal(accept.disabled, true); assert.equal(confirm.disabled, true, 'an unexplained preview is never confirmable');
assert.equal(await vm.runInContext('actionDemo.panel.confirm()', ctx), null);
console.log('Admin actions view: five situations explained in plain language, fictional titles, technical details disclosed only, no writes or requests, fail-closed confirmation passed');
