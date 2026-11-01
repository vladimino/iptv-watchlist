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
  const prefer = field('input', {'data-title-prefer': '', type: 'checkbox'});
  const save = field('button', {'data-title-save': ''});
  const result = field('p', {'data-title-result': ''});
  const preview = field('p', {'data-title-preview': ''});
  for (const child of [radio, manual, basis, prefer, preview, save, result]) form.append(child);
  detail.children = [form];
  return {form, manual, basis, prefer, save, result, radio};
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

async function submit(parts, {manual = '', basis = '', prefer = false} = {}) {
  parts.manual.value = manual;
  parts.basis.value = basis;
  parts.prefer.checked = prefer;
  parts.save.disabled = false;
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
  assert.equal(form.querySelector('[data-title-prefer]').checked, false, 'an add_alias retry stays unchecked');
  assert.equal(form.dataset.requestId, 'req-fixed');
  assert.equal(saved[0].body.effect, 'add_alias');
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
  refreshView = {mode: 'ready', entity: {preferred: 'Хозяйское название', titleReview: {reviews: [{requestId: 'req-fixed', effect: 'preferred_changed', to: {value: 'Хозяйское название'}, version: {after: 'title-review:1:landed'}}]}}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название', prefer: true});
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
  assert.equal(radios.length, 5, 'current preferred plus dictionary or owner; programme text stays out');
  assert.match(html, /Аферистка<\/span> <small class="muted">текущее предпочтительное<\/small>/);
  assert.equal(html.includes('Tytul'), false);
  assert.equal(html.includes('Кино'), false, 'Cyrillic programme text is not a Russian choice');
  assert.match(html, /Мошенница/);
  assert.match(html, /Своё старое/);
  assert.match(html, /Без источника/);
  assert.match(html, /Чужой источник/);
  const capped = context.adminTitleForm({...record, titleReview: {...record.titleReview, options: Array.from({length: 6}, (_, index) => ({value: `Словарь ${index}`, origin: 'alias', provenance: {source: 'dictionary'}}))}});
  assert.equal((capped.match(/type="radio"/g) || []).length, 6, 'the current preferred stays outside the five ordinary choices');
  assert.equal(capped.includes('Словарь 5'), false);
  assert.match(html, /data-title-manual/);
  assert.match(html, /Сохранить вариант/);
  assert.match(html, /Использовать как предпочтительное/);
  assert.doesNotMatch(html, /data-title-prefer[^>]*checked/);
  assert.match(html, /Добавится альтернативное название/);
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
  assert.match(person, /source: dictionary/, 'a person alias still shows its provenance');
  assert.equal(person.includes('Другие названия'), false);
  const titled = context.adminAliases({aliases: [{value: 'Аферистка', kind: 'title', provenance: {source: 'owner', authority: 'owner', requestId: 'req-secret', added: 'alias'}}]}, 'film');
  assert.match(titled, /Аферистка/);
  assert.doesNotMatch(titled, /req-secret/, 'a film alias request id stays out of the title list');
  assert.doesNotMatch(titled, /admin-provenance/);
  const trusted = context.adminFilmTechnical({
    id: 'film:care', storedId: 'care', canonicalIdentity: 'tmdb:601666',
    externalIds: [{scheme: 'tmdb', value: '601666', trusted: true, conflicting: false}],
    aliases: [{value: 'Аферистка', kind: 'title', provenance: {source: 'owner', authority: 'owner', requestId: 'req-secret', added: 'alias'}}],
  });
  assert.match(trusted, /tmdb:601666/);
  assert.match(trusted, /tmdb 601666 · доверенный/);
  assert.match(trusted, /req-secret/);
  assert.doesNotMatch(trusted, /Внешних id нет/);
  const conflicting = context.adminFilmTechnical({
    id: 'film:care', storedId: 'care', canonicalIdentity: 'tmdb:601666',
    externalIds: [{scheme: 'tmdb', value: '601666', trusted: false, conflicting: true}, {scheme: 'tmdb', value: '601666', trusted: false, conflicting: true}],
  });
  assert.match(conflicting, /tmdb:601666/);
  assert.equal((conflicting.match(/tmdb 601666/g) || []).length, 1, 'an exact duplicate external row is one row');
  assert.match(conflicting, /не доверенный/);
  assert.match(conflicting, /конфликт/);
  assert.doesNotMatch(conflicting, /Внешних id нет/);
  assert.match(context.adminAliases({aliases: []}, 'person'), /Других имён нет/);
  assert.match(context.adminAliases({aliases: []}, 'film'), /Других названий нет/);
  assert.match(context.adminAliases({aliases: []}), /Других названий нет/);
  context.adminDetail({mode: 'ready', kind: 'film', id: 'd5', entity: record});
  const filmCard = detail.innerHTML;
  assert.match(filmCard, /data-title-review/);
  assert.match(filmCard, /Сохранить вариант/);
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
  assert.match(personCard, /Сохранить вариант/);
  assert.match(personCard, /name="person-name-role"/);
  assert.match(personCard, /admin-folded/);
  assert.match(personCard, /<summary>Другие имена \(1\)<\/summary>/);
  assert.doesNotMatch(personCard, /data-title-review/);
  assert.doesNotMatch(personCard, /Сохранить вариант названия|Записать название/);
  assert.match(personCard, /Сохранить вариант/);
}

{
  saved = []; refreshes = 0;
  formAfterRefresh = null;
  context.nextResponse = {ok: false, status: 503, error: 'readback_failed', body: {reason: 'readback_failed'}};
  refreshView = {mode: 'ready', entity: {preferred: 'Хозяйское название'}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название', prefer: true});
  const form = detail.querySelector('[data-title-review]');
  assert.match(form.querySelector('[data-title-result]').textContent, /Неизвестно, записалось ли название/);
  assert.doesNotMatch(form.querySelector('[data-title-result]').textContent, /Карточка сверена/);
  assert.equal(form.dataset.requestId, 'req-fixed', 'a matching preferred title without the audit is not success');
  const box = form.querySelector('[data-title-prefer]');
  assert.equal(box.checked, true, 'a promote retry shows the same effect');
  box.checked = false;
  for (const fn of form.listeners.get('change')) fn({target: box});
  assert.equal(form.dataset.requestId, undefined, 'changing the effect drops the frozen command');
  assert.equal(context.adminTitleFrozen('d5', 'req-fixed'), null);
}

{
  saved = []; refreshes = 0;
  formAfterRefresh = null;
  context.nextResponse = {ok: false, status: 503, error: 'readback_failed', body: {reason: 'readback_failed'}};
  refreshView = {mode: 'ready', entity: {preferred: 'Словарный фильм', aliases: [{value: 'Хозяйское название', provenance: {source: 'owner', authority: 'owner', added: 'alias'}}], titleReview: {reviews: [{requestId: 'req-fixed', effect: 'alias_added', to: {value: 'Хозяйское название'}, version: {after: 'title-review:1:alias'}}]}}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название'});
  const form = detail.querySelector('[data-title-review]');
  assert.equal(form.querySelector('[data-title-result]').textContent, 'Вариант записан. Предпочтительное название не изменилось.');
  assert.equal(form.dataset.requestId, undefined);
}

{
  saved = []; refreshes = 0;
  formAfterRefresh = null;
  context.nextResponse = {ok: false, status: 503, error: 'readback_failed', body: {reason: 'readback_failed'}};
  refreshView = {mode: 'ready', entity: {preferred: 'Словарный фильм', aliases: [], titleReview: {options: [{value: 'Хозяйское название', origin: 'epg'}], reviews: [{requestId: 'req-fixed', effect: 'alias_added', to: {value: 'Хозяйское название'}, version: {after: 'title-review:1:alias'}}]}}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название', basis: 'карточка'});
  const form = detail.querySelector('[data-title-review]');
  assert.match(form.querySelector('[data-title-result]').textContent, /Неизвестно, записалось ли название/);
  assert.doesNotMatch(form.querySelector('[data-title-result]').textContent, /Вариант записан/);
  assert.equal(form.dataset.requestId, 'req-fixed', 'an EPG option is not a stored alias');
  context.nextResponse = {ok: true, status: 200, error: null, body: {ok: true, changed: false, idempotent: true}};
  const replay = {preventDefault() {}, defaultPrevented: false};
  for (const fn of form.listeners.get('submit')) fn(replay);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1].body, saved[0].body);
  assert.equal(saved[1].body.effect, 'add_alias');
  assert.equal(saved[1].body.expectedVersion, 'title-review:1:abc');
  assert.equal(saved[1].body.requestId, 'req-fixed');
}

{
  saved = []; refreshes = 0;
  formAfterRefresh = null;
  context.nextResponse = {ok: false, status: 503, error: 'readback_failed', body: {reason: 'readback_failed'}};
  refreshView = {mode: 'ready', entity: {preferred: 'Словарный фильм', aliases: [{value: 'Хозяйское название', provenance: {source: 'epg'}}], titleReview: {reviews: [{requestId: 'req-fixed', effect: 'alias_added', to: {value: 'Хозяйское название'}, version: {after: 'title-review:1:alias'}}]}}};
  const parts = buildForm();
  context.adminBindTitleReview(detail);
  await submit(parts, {manual: 'Хозяйское название'});
  const form = detail.querySelector('[data-title-review]');
  assert.match(form.querySelector('[data-title-result]').textContent, /Неизвестно, записалось ли название/);
  assert.equal(form.dataset.requestId, 'req-fixed', 'a programme alias of the same text is not the owner alias');
  assert.equal(context.adminTitleFrozen('d5', 'req-fixed').effect, 'add_alias');
  assert.equal(context.adminTitleFrozen('d5', 'req-fixed').expectedVersion, 'title-review:1:abc');
}

{
  const heterogeneous = Array.from({length: 37}, (_, index) => ({value: `Alias ${index}`, origin: 'alias', provenance: {source: index % 2 ? 'programme' : 'wikidata'}}));
  const before = {
    storedId: 'care', preferred: 'Аферистка', originalTitle: 'I Care a Lot',
    aliases: heterogeneous.map(option => ({kind: 'title', value: option.value, provenance: option.provenance})),
    titleReview: {
      version: 'title-review:1:care', filmId: 'film:care',
      preferred: {value: 'Аферистка', status: 'provisional', source: 'wikidata'},
      options: [{value: 'Аферистка', origin: 'preferred', provenance: {source: 'wikidata'}}, ...heterogeneous, {value: 'I Care a Lot', origin: 'original', provenance: {source: 'letterboxd'}}],
      reviews: [],
    },
  };
  const initial = context.adminTitleForm(before);
  const initialRadios = [...initial.matchAll(/name="title-review-choice" value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(initialRadios, ['Аферистка']);
  assert.doesNotMatch(initial, /Мошенница/);
  assert.doesNotMatch(initial, /name="title-review-choice" value="I Care a Lot"/);
  assert.doesNotMatch(initial, /name="title-review-choice" value="Alias 0"/);
  const added = context.adminTitleForm({
    ...before,
    aliases: [...before.aliases, {kind: 'title', value: 'Мошенница', provenance: {source: 'owner', authority: 'owner', added: 'alias'}}],
    titleReview: {
      ...before.titleReview,
      options: [...before.titleReview.options, {value: 'Мошенница', origin: 'alias', provenance: {source: 'owner', authority: 'owner', added: 'alias'}}],
      reviews: [{effect: 'alias_added', at: '2026-11-01T11:00:00.000Z', to: {value: 'Мошенница'}, from: {value: 'Аферистка'}}],
    },
  });
  const addedRadios = [...added.matchAll(/name="title-review-choice" value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(addedRadios, ['Аферистка', 'Мошенница']);
  assert.match(added, /добавлен вариант «Мошенница»/);
  assert.doesNotMatch(added, /Аферистка → Мошенница/);
  const legacy = context.adminTitleForm({
    storedId: 'care', preferred: 'Мошенница', originalTitle: 'I Care a Lot',
    aliases: [{value: 'Аферистка', provenance: {source: 'programme'}}, {value: 'Кино', provenance: {source: 'programme'}}],
    titleReview: {
      version: 'title-review:1:legacy', filmId: 'film:care',
      preferred: {value: 'Мошенница', status: 'reviewed', source: 'owner', authority: 'owner'},
      options: [
        {value: 'Мошенница', origin: 'preferred', provenance: {source: 'owner', authority: 'owner'}},
        {value: 'Аферистка', origin: 'alias', provenance: {source: 'programme'}},
        {value: 'Кино', origin: 'alias', provenance: {source: 'programme'}},
        {value: 'I Care a Lot', origin: 'original', provenance: {source: 'letterboxd'}},
      ],
      reviews: [{from: {value: 'Аферистка', status: 'provisional'}, to: {value: 'Мошенница', status: 'reviewed'}}],
    },
  });
  const legacyRadios = [...legacy.matchAll(/name="title-review-choice" value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(legacyRadios, ['Мошенница', 'Аферистка']);
  assert.match(legacy, /Аферистка<\/span> <small class="muted">было предпочтительным<\/small>/);
  assert.doesNotMatch(legacy, /name="title-review-choice" value="Кино"/);
  assert.doesNotMatch(legacy, /name="title-review-choice" value="I Care a Lot"/);
  const latin = context.adminTitleForm({
    storedId: 'care', originalTitle: 'I Care a Lot',
    titleReview: {version: 'title-review:1:latin', filmId: 'film:care', preferred: {value: 'I Care a Lot', status: 'missing'}, options: [{value: 'I Care a Lot', origin: 'original', provenance: {source: 'letterboxd'}}], reviews: []},
  });
  assert.doesNotMatch(latin, /type="radio"/);
  assert.match(latin, /Сейчас: <b>нет<\/b>/);
  const pinned = context.adminTitleForm({
    storedId: 'care',
    titleReview: {
      version: 'title-review:1:pin', filmId: 'film:care',
      preferred: {value: 'Аферистка', status: 'provisional', source: 'wikidata'},
      options: [
        {value: 'Аферистка', origin: 'preferred', provenance: {source: 'wikidata'}},
        {value: 'Старое', origin: 'alias', provenance: {source: 'programme', previousPreferred: true, historicalSource: 'programme'}},
        ...Array.from({length: 6}, (_, index) => ({value: `Словарь ${index}`, origin: 'alias', provenance: {source: 'dictionary'}})),
      ],
      reviews: [],
    },
  });
  const pinnedRadios = [...pinned.matchAll(/name="title-review-choice" value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(pinnedRadios, ['Аферистка', 'Старое', 'Словарь 0', 'Словарь 1', 'Словарь 2', 'Словарь 3', 'Словарь 4']);
  assert.match(pinned, /текущее предпочтительное/);
  assert.match(pinned, /было предпочтительным/);
}

console.log('admin film title page: unknown readback keeps the request, a matching reread says stored');
