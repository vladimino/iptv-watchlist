// The film-title form on /admin. A 503 readback_failed can follow a put that already landed, so the
// page must not say the title is unchanged and must keep the requestId for a replay. A reread that
// already shows the submitted title says it is stored.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const page = fs.readFileSync('public/admin.js', 'utf8').replace(/\nstartAdmin\(\);\s*$/, '\n');
assert.match(page, /readback_failed/);
assert.match(page, /adminFinishUnknownTitle/);

function element(name) {
  const node = {
    name,
    children: [],
    attrs: {},
    dataset: {},
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    type: '',
    parent: null,
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key] ?? null; },
    append(child) { child.parent = this; this.children.push(child); },
    focus() { document.activeElement = this; },
    addEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    },
    listeners: new Map(),
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const matches = this.matches(selector) ? [this] : [];
      for (const child of this.children) matches.push(...child.querySelectorAll(selector));
      return matches;
    },
    matches(selector) {
      const checked = selector.match(/^input\[name="([^"]+)"\]:checked$/);
      if (checked) return this.name === 'input' && this.attrs.name === checked[1] && this.checked;
      const named = selector.match(/^(?:input)?\[name="([^"]+)"\]$/);
      if (named) return this.attrs.name === named[1] && (selector.startsWith('input') ? this.name === 'input' : true);
      const data = selector.match(/^\[data-([a-z-]+)\]$/);
      if (data) return Object.prototype.hasOwnProperty.call(this.attrs, 'data-' + data[1]);
      if (selector.startsWith('#')) return this.attrs.id === selector.slice(1);
      return false;
    },
  };
  return node;
}

function field(name, attrs) {
  const node = element(name);
  Object.assign(node.attrs, attrs);
  return node;
}

const detail = element('section');
detail.attrs.id = 'admin-detail';
function buildForm() {
  const form = field('form', {'data-title-review': ''});
  form.dataset.filmId = 'film:d5';
  form.dataset.storedId = 'd5';
  form.dataset.version = 'title-review:1:abc';
  const radio = field('input', {name: 'title-review-choice', type: 'radio'});
  radio.value = 'Из словаря';
  radio.checked = true;
  const manual = field('input', {'data-title-manual': '', name: 'manual'});
  const basis = field('textarea', {name: 'basis'});
  const accept = field('input', {'data-title-accept': '', type: 'checkbox'});
  const save = field('button', {'data-title-save': ''});
  save.disabled = true;
  const result = field('p', {'data-title-result': ''});
  for (const child of [radio, manual, basis, accept, save, result]) form.append(child);
  detail.children = [form];
  return {form, manual, basis, accept, save, result, radio};
}

const document = {
  activeElement: null,
  querySelector(selector) {
    if (selector === '#admin-detail') return detail;
    return detail.querySelector(selector);
  },
};
let saved = [];
let refreshView = {mode: 'ready', entity: {preferred: 'Словарный фильм'}};
let refreshes = 0;
const context = vm.createContext({
  document, URL, URLSearchParams, Promise, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Error, RegExp, Math,
  crypto: {randomUUID: () => 'req-fixed'},
  setTimeout, clearTimeout,
  adminSaveFilmTitle: async (id, body) => { saved.push({id, body}); return context.nextResponse; },
});
vm.runInContext(page, context);
context.onAdminRefresh = () => {
  refreshes++;
  buildForm();
  context.adminBindTitleReview(detail);
  return Promise.resolve(refreshView);
};

async function submit(parts, {manual = '', basis = '', accept = true} = {}) {
  parts.manual.value = manual;
  parts.basis.value = basis;
  parts.accept.checked = accept;
  parts.save.disabled = !accept;
  const event = {preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false};
  for (const fn of parts.form.listeners.get('submit')) fn(event);
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

{
  saved = []; refreshes = 0;
  context.nextResponse = {ok: false, status: 503, error: 'readback_failed', body: {error: 'storage_unavailable', reason: 'readback_failed'}};
  refreshView = {mode: 'ready', entity: {preferred: 'Словарный фильм'}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название', basis: 'карточка'});
  const form = detail.querySelector('[data-title-review]');
  const result = form.querySelector('[data-title-result]');
  assert.equal(refreshes, 1);
  assert.equal(result.textContent.includes('не изменено'), false, result.textContent);
  assert.match(result.textContent, /Неизвестно, записалось ли название/);
  assert.equal(form.dataset.requestId, 'req-fixed');
  assert.equal(form.querySelector('[data-title-manual]').value, 'Хозяйское название');
  assert.equal(form.querySelector('[name="basis"]').value, 'карточка');
  assert.equal(form.querySelector('[data-title-accept]').checked, false);
  form.querySelector('[data-title-accept]').checked = true;
  form.querySelector('[data-title-save]').disabled = false;
  context.nextResponse = {ok: true, status: 200, error: null, body: {ok: true, changed: false, idempotent: true}};
  const replay = {preventDefault() {}, defaultPrevented: false};
  for (const fn of form.listeners.get('submit')) fn(replay);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved.length, 2);
  assert.equal(saved[1].body.requestId, saved[0].body.requestId);
  assert.equal(saved[1].body.value, 'Хозяйское название');
  assert.equal(saved[1].body.mode, 'manual');
  assert.equal(saved[1].body.basis, 'карточка');
}

{
  saved = []; refreshes = 0;
  context.nextResponse = {ok: false, status: 503, error: 'readback_failed', body: {error: 'storage_unavailable', reason: 'readback_failed'}};
  refreshView = {mode: 'ready', entity: {preferred: 'Хозяйское название'}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название'});
  const form = detail.querySelector('[data-title-review]');
  const result = form.querySelector('[data-title-result]');
  assert.equal(result.textContent, 'Название записано. Карточка сверена.');
  assert.equal(result.textContent.includes('не изменено'), false);
  assert.equal(form.dataset.requestId, undefined);
  assert.equal(refreshes, 1);
}

{
  saved = []; refreshes = 0;
  context.nextResponse = {ok: false, status: 400, error: 'invalid_title', body: {error: 'invalid_title', reason: 'invalid_title'}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название'});
  assert.equal(refreshes, 0);
  assert.equal(parts.form.dataset.requestId, undefined);
  assert.match(parts.result.textContent, /Название не изменено/);
}

console.log('admin film title page: unknown readback keeps the request, a matching reread says stored');
