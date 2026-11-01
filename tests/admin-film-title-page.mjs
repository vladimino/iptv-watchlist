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
let formAfterRefresh = null;
const context = vm.createContext({
  document, URL, URLSearchParams, Promise, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Error, RegExp, Math,
  crypto: {randomUUID: () => 'req-fixed'},
  setTimeout, clearTimeout,
  adminSaveFilmTitle: async (id, body) => {
    saved.push({id, body});
    if (typeof context.editOnSave === 'function') context.editOnSave();
    return context.nextResponse;
  },
});
vm.runInContext(page, context);
context.onAdminRefresh = () => {
  refreshes++;
  if (formAfterRefresh) formAfterRefresh();
  else buildForm();
  context.adminBindTitleReview(detail);
  return Promise.resolve(refreshView);
};

function refreshWithoutChoice() {
  formAfterRefresh = () => {
    const built = buildForm();
    built.form.dataset.version = 'title-review:1:moved';
    built.form.children = built.form.children.filter(child => child !== built.radio);
  };
}

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
  context.editOnSave = null;
  formAfterRefresh = null;
  refreshWithoutChoice();
  context.nextResponse = {ok: false, status: 503, error: 'readback_failed', body: {error: 'storage_unavailable', reason: 'readback_failed'}};
  refreshView = {mode: 'ready', entity: {preferred: 'Словарный фильм'}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название', basis: 'карточка'});
  const form = detail.querySelector('[data-title-review]');
  const result = form.querySelector('[data-title-result]');
  assert.equal(refreshes, 1);
  assert.equal(form.dataset.version, 'title-review:1:moved');
  assert.equal(form.querySelector('input[name="title-review-choice"]'), null);
  assert.equal(result.textContent.includes('не изменено'), false, result.textContent);
  assert.match(result.textContent, /Неизвестно, записалось ли название/);
  assert.equal(form.dataset.requestId, 'req-fixed');
  assert.equal(form.querySelector('[data-title-manual]').value, 'Хозяйское название');
  assert.equal(form.querySelector('[name="basis"]').value, 'карточка');
  assert.equal(form.querySelector('[data-title-accept]').checked, false);
  const accept = form.querySelector('[data-title-accept]');
  accept.checked = true;
  for (const fn of form.listeners.get('input')) fn({target: accept});
  for (const fn of form.listeners.get('change')) fn({target: accept});
  assert.equal(form.dataset.requestId, 'req-fixed', 'the confirmation checkbox does not discard the frozen command');
  assert.equal(form.querySelector('[data-title-save]').disabled, false);
  context.nextResponse = {ok: true, status: 200, error: null, body: {ok: true, changed: false, idempotent: true}};
  const replay = {preventDefault() {}, defaultPrevented: false};
  for (const fn of form.listeners.get('submit')) fn(replay);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1].body, saved[0].body);
  assert.equal(saved[0].body.expectedVersion, 'title-review:1:abc');
  assert.equal(saved[0].body.filmId, 'film:d5');
  assert.notEqual(form.dataset.version, saved[1].body.expectedVersion);
  formAfterRefresh = null;
}

{
  saved = []; refreshes = 0;
  context.editOnSave = null;
  formAfterRefresh = null;
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
  assert.equal(context.adminTitleFrozen('d5', 'req-fixed'), null);
  assert.equal(refreshes, 1);
}

{
  saved = []; refreshes = 0;
  context.editOnSave = null;
  refreshWithoutChoice();
  context.nextResponse = {ok: false, status: 503, error: 'readback_failed', body: {error: 'storage_unavailable', reason: 'readback_failed'}};
  refreshView = {mode: 'ready', entity: {preferred: 'Словарный фильм'}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название', basis: 'карточка'});
  const form = detail.querySelector('[data-title-review]');
  const manual = form.querySelector('[data-title-manual]');
  manual.value = 'Другое название';
  for (const fn of form.listeners.get('input')) fn({target: manual});
  assert.equal(form.dataset.requestId, undefined);
  assert.equal(context.adminTitleFrozen('d5', 'req-fixed'), null);
  form.querySelector('[data-title-accept]').checked = true;
  form.querySelector('[data-title-save]').disabled = false;
  context.nextResponse = {ok: true, status: 200, error: null, body: {ok: true, changed: true}};
  const replay = {preventDefault() {}, defaultPrevented: false};
  for (const fn of form.listeners.get('submit')) fn(replay);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved[1].body.value, 'Другое название');
  assert.equal(saved[1].body.expectedVersion, 'title-review:1:moved');
  assert.notDeepEqual(saved[1].body, saved[0].body);
  formAfterRefresh = null;
}

{
  saved = []; refreshes = 0;
  formAfterRefresh = null;
  context.nextResponse = {ok: false, status: 503, error: 'readback_failed', body: {error: 'storage_unavailable', reason: 'readback_failed'}};
  context.editOnSave = () => {
    const form = detail.querySelector('[data-title-review]');
    const manual = form.querySelector('[data-title-manual]');
    manual.value = 'Уже другое';
    for (const fn of form.listeners.get('input')) fn({target: manual});
  };
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название'});
  context.editOnSave = null;
  const form = detail.querySelector('[data-title-review]');
  assert.equal(refreshes, 0);
  assert.match(form.querySelector('[data-title-result]').textContent, /Поле изменено/);
  assert.equal(form.dataset.requestId, undefined);
  assert.equal(context.adminTitleFrozen('d5', 'req-fixed'), null);
  assert.equal(form.querySelector('[data-title-manual]').value, 'Уже другое');
}

{
  saved = []; refreshes = 0;
  formAfterRefresh = null;
  context.editOnSave = null;
  context.nextResponse = {ok: false, status: 0, error: 'network', body: null};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название', basis: 'карточка'});
  assert.equal(refreshes, 0);
  assert.equal(parts.form.dataset.requestId, 'req-fixed');
  parts.form.dataset.version = 'title-review:1:moved';
  context.nextResponse = {ok: true, status: 200, error: null, body: {ok: true, changed: false, idempotent: true}};
  const replay = {preventDefault() {}, defaultPrevented: false};
  for (const fn of parts.form.listeners.get('submit')) fn(replay);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(saved[1].body, saved[0].body);
  assert.equal(saved[1].body.expectedVersion, 'title-review:1:abc');
}

{
  saved = []; refreshes = 0;
  context.nextResponse = {ok: false, status: 400, error: 'invalid_title', body: {error: 'invalid_title', reason: 'invalid_title'}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название'});
  assert.equal(refreshes, 0);
  assert.equal(parts.form.dataset.requestId, undefined);
  assert.equal(context.adminTitleFrozen('d5', 'req-fixed'), null);
  assert.match(parts.result.textContent, /Название не изменено/);
}

{
  const programme = Array.from({length: 40}, (_, index) => ({value: `Tytul ${index} 영화`, origin: 'alias', provenance: {source: 'programme'}}));
  const record = {
    storedId: 'd5',
    preferred: 'Аферистка',
    originalTitle: 'I Care a Lot',
    aliases: [
      ...programme.map(option => ({kind: 'title', value: option.value, provenance: option.provenance})),
      {kind: 'title', value: 'Мошенница', provenance: {source: 'dictionary'}},
    ],
    titleReview: {
      version: 'title-review:1:abc',
      filmId: 'film:d5',
      preferred: {value: 'Аферистка', status: 'reviewed', source: 'dictionary'},
      options: [
        {value: 'Аферистка', origin: 'preferred', provenance: {source: 'dictionary'}},
        {value: 'Кино', origin: 'alias', provenance: {source: 'programme'}},
        ...programme,
        {value: 'Мошенница', origin: 'alias', provenance: {source: 'dictionary'}},
        {value: 'Своё старое', origin: 'alias', provenance: {source: 'letterboxd', authority: 'owner'}},
        {value: 'Без источника', origin: 'alias', provenance: {authority: 'dictionary'}},
        {value: 'Чужой источник', origin: 'alias', provenance: {source: 'programme', authority: 'dictionary'}},
      ],
      reviews: [{to: {value: 'Аферистка'}, at: '2026-01-01T00:00:00.000Z', basis: 'прокат'}],
    },
  };
  const html = context.adminTitleForm(record);
  const radios = html.match(/type="radio"/g) || [];
  assert.equal(radios.length, 4, 'dictionary or owner on source or authority; programme text stays out');
  assert.equal(html.includes('Tytul'), false);
  assert.equal(html.includes('Кино'), false, 'Cyrillic programme text is not a Russian choice');
  assert.match(html, /Мошенница/);
  assert.match(html, /Своё старое/);
  assert.match(html, /Без источника/);
  assert.match(html, /Чужой источник/);
  const capped = context.adminTitleForm({...record, titleReview: {...record.titleReview, options: Array.from({length: 6}, (_, index) => ({value: `Словарь ${index}`, origin: 'alias', provenance: {source: 'dictionary'}}))}});
  assert.equal((capped.match(/type="radio"/g) || []).length, 5);
  assert.equal(capped.includes('Словарь 5'), false);
  assert.match(html, /data-title-manual/);
  assert.match(html, /Записать название/);
  assert.match(html, /прокат/);
  assert.doesNotMatch(html, /Выбрать из известных/);
  const aliases = context.adminAliases(record);
  assert.match(aliases, /<summary>Другие названия \(41\)<\/summary>/);
  assert.match(aliases, /Tytul 0/);
  assert.match(aliases, /Мошенница/);
  assert.equal(aliases.includes('type="radio"'), false);
  assert.equal(aliases.includes('<details'), true);
  assert.equal(aliases.includes(' open'), false);
  const person = context.adminAliases({aliases: [{value: 'Л. Норд', provenance: {source: 'dictionary'}}]}, 'person');
  assert.match(person, /<summary>Другие имена \(1\)<\/summary>/);
  assert.equal(person.includes('Другие названия'), false);
  assert.match(context.adminAliases({aliases: []}, 'person'), /Других имён нет/);
  assert.match(context.adminAliases({aliases: []}, 'film'), /Других названий нет/);
  assert.match(context.adminAliases({aliases: []}), /Других названий нет/);
  context.adminDetail({mode: 'ready', kind: 'film', id: 'd5', entity: record});
  const filmCard = detail.innerHTML;
  assert.match(filmCard, /data-title-review/);
  assert.match(filmCard, /Записать название/);
  assert.match(filmCard, /<summary>Другие названия \(41\)<\/summary>/);
  assert.doesNotMatch(filmCard, /id="admin-name-form"/);
  assert.ok(filmCard.indexOf('Оригинал:') < filmCard.indexOf('data-title-review') && filmCard.indexOf('data-title-review') < filmCard.indexOf('<h3>Сводка</h3>'));
  context.adminDetail({
    mode: 'ready', kind: 'person', id: 'person:actor/lot',
    entity: {
      id: 'person:actor/lot', preferred: 'Актриса', original: 'Actor',
      aliases: [{value: 'A. Lot', provenance: {source: 'letterboxd'}}],
      nameReview: {
        version: 'name-review:1:lot', original: 'Actor',
        preferred: {value: 'Актриса', status: 'provisional', source: 'wikidata'},
        options: [{value: 'Актриса', origin: 'preferred', provenance: {source: 'wikidata'}, preferred: true}],
        collisions: [{id: 'person:director/lot', original: 'Actor', reason: 'same_original', version: 'name-review:1:role', linked: false}],
        reviews: [], roleLinks: [],
      },
    },
  });
  const personCard = detail.innerHTML;
  assert.match(personCard, /id="admin-name-form"/);
  assert.match(personCard, /Сохранить имя/);
  assert.match(personCard, /name="person-name-role"/);
  assert.match(personCard, /admin-folded/);
  assert.match(personCard, /<summary>Другие имена \(1\)<\/summary>/);
  assert.doesNotMatch(personCard, /data-title-review/);
  assert.doesNotMatch(personCard, /Записать название/);
}

console.log('admin film title page: unknown readback keeps the request, a matching reread says stored');
