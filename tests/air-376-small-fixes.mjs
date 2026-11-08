// AIR-376 Small Fixes Batch: search note removed, wider desktop sidebar, compact scenarios, footer links that really open /events.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');

// 1. Search: no explanatory paragraph, scopes and their labels unchanged.
assert.doesNotMatch(html, /search-scope-note|По умолчанию ищутся только названия/, 'the search hint paragraph is gone');
assert.doesNotMatch(css, /search-scope-note/, 'no unused CSS remains');
assert.match(html, /<div class="search-scopes" role="group" aria-label="Область поиска">/);
for (const scope of ['titles', 'people', 'plot']) assert.match(html, new RegExp('data-search-scope="' + scope + '"'));
assert.match(html, /data-search-scope="titles" aria-pressed="true" aria-disabled="true"/, 'titles stays the default scope');

// 2. Desktop sidebar: 215px -> 322px (+50%), a middle band keeps one card column, narrow layouts unchanged.
assert.match(css, /\.workspace\{display:grid;grid-template-columns:322px minmax\(0,1fr\);gap:36px\}/);
assert.doesNotMatch(css, /grid-template-columns:215px/);
assert.match(css, /@media\(min-width:1131px\) and \(max-width:1279px\)\{\.workspace\{grid-template-columns:260px minmax\(0,1fr\)[^}]*\}[^@]*\.movie-grid\{grid-template-columns:1fr\}/, 'between 1131 and 1279 px the sidebar is 260px and cards take one column');
assert.match(css, /@media\(min-width:1280px\) and \(max-width:1359px\)\{\.movie-grid\{grid-template-columns:1fr\}/, 'from 1280 to 1359 px the 322px sidebar keeps cards in one column so they are not squeezed');
assert.match(css, /@media\(max-width:1130px\)\{\.workspace\{grid-template-columns:180px minmax\(0,1fr\)/, 'the narrow breakpoint keeps its own width');
assert.match(css, /@media\(max-width:760px\)\{[^@]*\.workspace\{display:flex;flex-direction:column/, 'mobile layout is untouched');
assert.match(css, /\.movie-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/, 'two card columns stay on wide desktop');

// 3. Scenarios: compact markup.
const presets = html.match(/<section class="presets"[\s\S]*?<\/section>/)?.[0] || '';
assert.match(presets, /<h2 id="presets-title">Сценарии<\/h2><button type="button" id="preset-save" class="preset-add" aria-label="[^"]+">\+ Сохранить<\/button>/, 'one short visible action next to the title');
assert.match(presets, /<p id="presets-empty" class="presets-empty">Нет сценариев<\/p>/, 'a one-line empty state');
assert.doesNotMatch(presets, /Пока нет сохранённых|Сохранить текущий/, 'no long empty text and no heavy "save current" block');
assert.match(presets, /<form id="preset-editor" hidden>/, 'the editor is closed by default');
assert.match(css, /#preset-editor\[hidden\]\{display:none\}/);
assert.match(css, /\.preset-apply\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap/, 'a long name cannot break the layout');
assert.match(css, /\.preset-row\.is-current \.preset-apply/, 'the matching scenario is visibly marked');
// Review fix: the feedback line must stay visible on mobile. The ≤760px rule hides every `.filters .hint`, so the status must not be a hint.
assert.match(presets, /<p id="preset-status" class="preset-status" role="status"><\/p>/, 'the status line has its own class');
assert.doesNotMatch(presets, /id="preset-status"[^>]*class="[^"]*\bhint\b/, 'the status line is not a .hint');
assert.match(css, /\.preset-status\{[^}]*color:#ffb6a3[^}]*\}\.preset-status:empty\{display:none\}/, 'visible with text, hidden only when empty');
{
  const open = css.indexOf('@media(max-width:760px){.masthead') + '@media(max-width:760px){'.length;
  let depth = 1, end = open;
  while (depth > 0 && end < css.length) {const ch = css[end++]; if (ch === '{') depth++; else if (ch === '}') depth--;}
  const narrow = css.slice(open, end - 1);
  const hiders = [...narrow.matchAll(/([^{}]+)\{[^{}]*display:none[^{}]*\}/g)].map(match => match[1]);
  for (const selector of hiders) assert.doesNotMatch(selector, /preset-status|#preset-status|\.presets(?![-\w])(?! \.hint)/, 'no ≤760px rule hides the scenario feedback: ' + selector);
  assert.ok(hiders.some(selector => /\.filters \.hint/.test(selector)), 'the rule that hid the old status is still there for real hints, which is why the status left that class');
}

// Behaviour over the real app.js with a recording DOM.
const nodes = new Map(), focused = [];
function el(selector) {
  if (!nodes.has(selector)) {
    const node = {selector, innerHTML: '', textContent: '', hidden: false, value: '', checked: false, disabled: false, dataset: {}, style: {}, classes: new Set(), attrs: new Map(),
      classList: {toggle(name, on) {on ? node.classes.add(name) : node.classes.delete(name);}, add(name) {node.classes.add(name);}, remove(name) {node.classes.delete(name);}, contains(name) {return node.classes.has(name);}},
      setAttribute(name, value) {node.attrs.set(name, String(value));}, removeAttribute(name) {node.attrs.delete(name);}, getAttribute(name) {return node.attrs.get(name) ?? null;},
      focus() {focused.push(selector);}, addEventListener() {}, querySelector() {return null;}, querySelectorAll() {return [];}};
    nodes.set(selector, node);
  }
  return nodes.get(selector);
}
const classes = new Set();
const document = {hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: el, querySelectorAll: () => [],
  documentElement: {classList: {toggle(name, on) {on ? classes.add(name) : classes.delete(name);}, contains: name => classes.has(name)}}};
const stack = [{href: 'https://iptv.example/film/abc', state: null}];
let index = 0;
const window = {scrollY: 0, scrollTo(_x, y) {window.scrollY = y;}, addEventListener() {}, removeEventListener() {},
  location: {href: stack[0].href}, matchMedia: () => ({matches: false}), innerWidth: 1300, innerHeight: 800,
  history: {
    get state() {return stack[index].state;},
    pushState(state, _t, url) {stack.splice(index + 1); stack.push({href: new URL(url, window.location.href).href, state}); index++; window.location.href = stack[index].href;},
    replaceState(state, _t, url) {stack[index] = {href: new URL(url, window.location.href).href, state}; window.location.href = stack[index].href;},
    back() {index--; window.location.href = stack[index].href; run('onHistoryNavigation()');},
  }};
const store = new Map();
let presetData = [];
const context = vm.createContext({Date, Intl, URL, URLSearchParams, Set, Map, JSON, document, window, console,
  sessionStorage: {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value)},
  localStorage: {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value)},
  fetch: async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') return new Response(JSON.stringify({schemaVersion: 1, presets: presetData}), {status: 200, headers: {ETag: '"1"'}});
    const body = options.body ? JSON.parse(options.body) : {};
    presetData = [...presetData, {id: '33333333-3333-4333-8333-333333333333', name: body.name, query: body.query}];
    return new Response(JSON.stringify({schemaVersion: 1, presets: presetData}), {status: 201, headers: {ETag: '"2"'}});
  }});
vm.runInContext(fs.readFileSync('public/return-home.js', 'utf8') + '\n' + app.replace(/init\(\);\s*$/, ''), context);
const run = code => vm.runInContext(code, context);

// Empty list: one line, no form, one "save" action.
run('presets=[];presetEditor=null;presetStatus="";renderPresets()');
assert.equal(el('#presets-empty').hidden, false, 'the empty line is shown with no scenarios');
assert.equal(el('#preset-editor').hidden, true, 'the editor is not open by default');
assert.equal(el('#preset-save').hidden, false, 'the one action is visible');

// Opening the editor hides the head action: never two competing "save" buttons.
run('presetEditor={mode:"create"};renderPresets()');
assert.equal(el('#preset-editor').hidden, false);
assert.equal(el('#preset-save').hidden, true, 'the editor owns the only save button while it is open');

// Validation: an empty name sends nothing and says why; focus stays in the field.
let requests = 0;
const realFetch = context.fetch;
context.fetch = async (...args) => {requests++; return realFetch(...args);};
el('#preset-name').value = '   ';
focused.length = 0;
await run('(async()=>{const form=document.querySelector("#preset-editor");return 1;})()');
// Drive the same code the submit listener runs, through bindEvents' listener captured on the editor.
const listeners = {};
el('#preset-editor').addEventListener = (type, fn) => {listeners[type] = fn;};
el('#preset-cancel').addEventListener = (type, fn) => {listeners['cancel-' + type] = fn;};
el('#preset-save').addEventListener = (type, fn) => {listeners['save-' + type] = fn;};
const bind = app.match(/const presetSave=\$\('#preset-save'\);[\s\S]*?\n const presetList=/)?.[0];
assert.ok(bind, 'the preset wiring block is found');
run('(function(){' + bind.replace(/\n const presetList=$/, '') + '})()');
await listeners.submit({preventDefault() {}});
assert.equal(requests, 0, 'an empty name is not sent');
assert.equal(run('presetStatus'), 'Введи название сценария.');
assert.equal(focused.at(-1), '#preset-name', 'focus returns to the name field');

// Escape closes the editor, clears the message and returns focus to the single save action.
focused.length = 0;
let prevented = false;
listeners.keydown({key: 'Escape', preventDefault() {prevented = true;}});
assert.equal(prevented, true);
assert.equal(run('presetEditor'), null);
assert.equal(run('presetStatus'), '');
assert.equal(el('#preset-save').hidden, false);
assert.equal(focused.at(-1), '#preset-save', 'focus returns to the opener');

// Create: trimmed name, closes the editor, focus back on the opener.
run('presetEditor={mode:"create"};renderPresets()');
el('#preset-name').value = '  Вечер пятницы  ';
focused.length = 0;
await listeners.submit({preventDefault() {}});
assert.equal(requests >= 1, true);
assert.equal(run('presets.at(-1).name'), 'Вечер пятницы');
assert.equal(run('presetEditor'), null);
assert.equal(focused.at(-1), '#preset-save');

// Current marker: only when the canonical filters equal the saved ones; a manual change drops it.
run('urlReady=true;state.viewing="rewatch";presets=[{id:"a1",name:"Пересмотр",query:presetQuery()},{id:"b2",name:"Другой",query:"started=1"}];renderPresets()');
const markup = el('#preset-list').innerHTML;
assert.match(markup, /<li class="preset-row is-current"><button type="button" class="preset-apply" data-preset-apply="a1" title="Пересмотр" aria-current="true">/);
assert.doesNotMatch(markup, /data-preset-apply="b2"[^>]*aria-current/);
assert.equal(run('presetIsCurrent(presets[0],currentPresetKey())'), true);
run('state.viewing="new"');
assert.equal(run('presetIsCurrent(presets[0],currentPresetKey())'), false, 'a manual change does not leave the saved scenario looking current');
assert.equal(run('presetKey("viewing=rewatch&token=secret&started=1")'), run('presetKey("started=1&viewing=rewatch")'), 'order and foreign parameters do not matter');

// A long name is kept whole in the title and escaped.
run('presets=[{id:"c3",name:"Очень длинное название сценария <i>x</i> "+"я".repeat(70),query:""}];renderPresets()');
assert.match(el('#preset-list').innerHTML, /title="Очень длинное название сценария &lt;i&gt;x&lt;\/i&gt; я{70}"/);

// Existing contracts stay: explicit update/delete confirmations and the replace-state apply path.
run('presets=[{id:"d4",name:"X",query:"started=1"}];presetPrompt={id:"d4",action:"delete"};renderPresets()');
assert.match(el('#preset-list').innerHTML, /Удалить этот сценарий\?/);
run('presetPrompt={id:"d4",action:"update"};renderPresets()');
assert.match(el('#preset-list').innerHTML, /Заменить сохранённые условия текущими\?/);

// 4. Footer links: real /events hrefs; opening events from a film screen leaves the film screen.
assert.equal((html.match(/class="status-events-link"[^>]*href="\/events"/g) || []).length, 1, 'AIR-389: the footer has one events link (the second footer link goes to Admin Health)');
assert.doesNotMatch(html, /href="#activity-title"/);
assert.equal(run('plainFilmActivation({button:0})'), true, 'a plain click is handled in the page');
for (const event of [{button: 0, ctrlKey: true}, {button: 0, metaKey: true}, {button: 0, shiftKey: true}, {button: 1}, {button: 0, defaultPrevented: true}]) assert.equal(run('plainFilmActivation(' + JSON.stringify(event) + ')'), false, JSON.stringify(event) + ' keeps native navigation (new tab, copy link)');

run('filmScreen="abc"');
classes.add('film-screen');
store.set('iptv-film-list-query', '?q=x');
run('openEventsScreen(document.querySelector("#status-integrations-events"))');
assert.equal(new URL(window.location.href).pathname, '/events');
assert.equal(classes.has('film-screen'), false, 'the film screen no longer hides the events');
assert.equal(classes.has('events-screen'), true);
assert.equal(run('filmScreen'), null);
assert.equal(focused.at(-1), '#activity-title');
// Back returns to the film and does not leave the events class behind.
window.history.back();
assert.equal(new URL(window.location.href).pathname, '/film/abc');
assert.equal(classes.has('events-screen'), false, 'back to a film clears the events screen');
// Already on /events: the link keeps it there and does not push a second entry.
run('openEventsScreen(document.querySelector("#status-integrations-events"))');
const depth = stack.length;
run('openEventsScreen(document.querySelector("#status-integrations-events"))');
assert.equal(stack.length, depth, 'a second click on /events adds no history entry');
assert.equal(new URL(window.location.href).pathname, '/events');

console.log('AIR-376: no search hint, wider sidebar with a one-column middle band, compact scenarios (single save action, validation, Escape and focus, current marker, long names) and footer links that open /events, also from a film screen, passed');
