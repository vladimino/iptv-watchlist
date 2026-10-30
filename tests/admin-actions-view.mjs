// The guarded action panel and its demonstration page on a DOM stand-in: rendering a preview writes nothing, the confirm
// button stays disabled until the owner ticks the scope checkbox on an eligible preview, the receipt shows succeeded,
// partial, unknown and refused results, and the page bundle makes no request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {bundleAdmin} from '../src/admin/bundle.js';

const html = fs.readFileSync('public/admin-actions.html', 'utf8');
const page = fs.readFileSync('public/admin-actions.js', 'utf8');
const view = fs.readFileSync('src/admin/actions-view.js', 'utf8');
const bundle = bundleAdmin([fs.readFileSync('src/domain/admin-actions.js', 'utf8'), fs.readFileSync('src/admin/actions-fixture.js', 'utf8'), view, page]);
assert.match(html, /ДЕМОНСТРАЦИЯ · СИНТЕТИЧЕСКИЕ ДАННЫЕ/);
assert.match(html, /<script src="\/admin-actions\.js"><\/script>/);
assert.doesNotMatch(bundle, /\bfetch\(|\/api\/|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|Authorization|Bearer/, 'the demonstration makes no request and stores nothing');
assert.match(fs.readFileSync('build.mjs', 'utf8'), /assets\['\/admin\/actions'\]/);
assert.doesNotMatch(fs.readFileSync('public/admin.js', 'utf8'), /admin-actions|mountActionPanel/, 'the /admin shell is not changed');

const listeners = [];
function element(name) {
  return {name, innerHTML: '', textContent: '', value: '', disabled: false, checked: false, options: [],
    addEventListener(type, fn) {listeners.push({name, type, fn});},
    querySelector(selector) {return nodes[selector] || null;}};
}
const nodes = {};
for (const name of ['#action-scenario', '#action-root', '#action-receipt-reset', '[data-action-preview]', '[data-action-accept]', '[data-action-confirm]', '[data-action-repreview]', '[data-action-receipt]']) nodes[name] = element(name);
const root = nodes['#action-root'];
const document = {querySelector: selector => nodes[selector] || null};
const fire = (name, type) => Promise.all(listeners.filter(item => item.name === name && item.type === type).map(item => item.fn()));
const ctx = vm.createContext({document, crypto: webcrypto, structuredClone, Date, JSON, Map, Set, Promise, Error, Object, Array, String, Number, Math, Uint8Array, console, setTimeout});
vm.runInContext(bundle, ctx);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const preview = nodes['[data-action-preview]'], accept = nodes['[data-action-accept]'], confirm = nodes['[data-action-confirm]'], receipt = nodes['[data-action-receipt]'];
const writes = () => JSON.parse(vm.runInContext('JSON.stringify(actionDemo.store.writes)', ctx));

// 1. Page load: an eligible preview, nothing written, confirm disabled until the scope is accepted.
await settle();
assert.match(nodes['#action-scenario'].innerHTML, /Два фильма готовы/);
assert.match(preview.innerHTML, /Можно подтвердить/);
assert.match(preview.innerHTML, /film:north/);assert.match(preview.innerHTML, /film:quiet/);
assert.match(preview.innerHTML, /Исключены[\s\S]*film:blank/);
assert.match(preview.innerHTML, /нет: при сбое возможен частичный результат/);
assert.deepEqual(writes(), [], 'opening the page writes nothing');
assert.equal(accept.disabled, false);assert.equal(accept.checked, false);
assert.equal(confirm.disabled, true, 'no confirmation without the explicit checkbox');
assert.equal(await vm.runInContext('actionDemo.panel.confirm()', ctx), null, 'a disabled confirm executes nothing');
assert.deepEqual(writes(), []);
await fire('[data-action-repreview]', 'click');await settle();
assert.deepEqual(writes(), [], 'rebuilding the preview writes nothing');

// 2. Accept, confirm: the receipt shows the written records; the checkbox resets.
accept.checked = true;await fire('[data-action-accept]', 'change');
assert.equal(confirm.disabled, false);
await vm.runInContext('actionDemo.panel.confirm()', ctx);
assert.deepEqual(writes(), ['film:north', 'film:quiet']);
assert.match(receipt.innerHTML, /Квитанция: выполнено/);
assert.match(receipt.innerHTML, /film:north<\/span> <small>записано/);
assert.equal(accept.checked, false);
assert.doesNotMatch(receipt.innerHTML, /owner@|token|secret/i);

// 3. Scenarios: partial, unknown, stale pin, nothing eligible.
const scenario = async code => {nodes['#action-scenario'].value = code;await fire('#action-scenario', 'change');await settle();};
await scenario('partial');
accept.checked = true;await fire('[data-action-accept]', 'change');await vm.runInContext('actionDemo.panel.confirm()', ctx);
assert.match(receipt.innerHTML, /выполнено частично/);assert.match(receipt.innerHTML, /provider_error/);assert.match(receipt.innerHTML, /Можно повторить: film:quiet/);
await scenario('unknown');
accept.checked = true;await fire('[data-action-accept]', 'change');await vm.runInContext('actionDemo.panel.confirm()', ctx);
assert.match(receipt.innerHTML, /исход неизвестен/);assert.match(receipt.innerHTML, /сначала перечитайте записи/);assert.doesNotMatch(receipt.innerHTML, /read the records/);
await scenario('stale');
accept.checked = true;await fire('[data-action-accept]', 'change');await vm.runInContext('actionDemo.panel.confirm()', ctx);
assert.match(receipt.innerHTML, /отказано/);assert.match(receipt.innerHTML, /снимок изменился после превью/);assert.match(receipt.innerHTML, /Ничего не выполнялось/);
assert.deepEqual(writes(), [], 'a refused submission writes nothing');
await scenario('ineligible');
assert.match(preview.innerHTML, /Недостаточно данных|Нельзя выполнить/);
assert.equal(accept.disabled, true);assert.equal(confirm.disabled, true);
console.log('Admin actions view: page load, preview without writes, explicit confirmation, receipts and refusals passed');
