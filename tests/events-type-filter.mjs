// AIR-381: the events screen keeps the programme's two-column frame, filters the already loaded events by type in the browser, keeps the choice in
// the URL and does not touch the fetch, the cursor or the compact feed of the programme and film pages.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');

// 1. Markup: one frame for every route, the film and events columns live in the workspace, the feed starts in the sidebar.
{
  const workspace = html.slice(html.indexOf('<div class="workspace">'), html.indexOf('<footer class="status-footer"'));
  const order = ['<aside class="filters" id="filters"', '<section class="results"', '<section id="film-screen"', '<section id="events-screen"'];
  const at = order.map(marker => workspace.indexOf(marker));
  assert.ok(at.every(position => position >= 0), 'sidebar, results, film and events columns are all inside the workspace');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in that order');
  const aside = workspace.slice(at[0], at[1]);
  assert.ok(aside.includes('class="activity"'), 'the compact feed starts in the sidebar');
  assert.ok(!workspace.slice(at[3]).includes('class="activity"'), 'the events column starts empty: the feed is moved in, never duplicated');
  assert.equal((html.match(/id="activity-list"/g) || []).length, 1, 'one feed list in the document');
  const panel = html.match(/<section class="events-types" id="events-types" hidden[\s\S]*?<\/section>/)[0];
  assert.ok(aside.includes('id="events-types"'), 'the type panel is part of the sidebar');
  assert.match(panel, /<h2 id="events-types-title">Тип событий<\/h2>/);
  assert.match(panel, /role="group" aria-label="Тип событий"/, 'a button group');
  const buttons = [...panel.matchAll(/<button type="button" data-event-type="([a-z_]+)" aria-pressed="(true|false)">([^<]+)<\/button>/g)].map(match => match.slice(1, 4));
  assert.deepEqual(buttons, [
    ['all', 'true', 'Все события'], ['watchlist', 'false', 'Watchlist и просмотр'], ['epg', 'false', 'Программа'], ['discovery', 'false', 'Находки'],
    ['ratings', 'false', 'Оценки'], ['enrichment', 'false', 'Прогнозы'], ['taste_profile', 'false', 'Модель вкуса'],
  ], 'seven buttons, «Все события» pressed by default');
}

// 2. CSS: the grid is never replaced, so the sidebar keeps its width and position on every route.
{
  assert.match(css, /\.workspace\{display:grid;grid-template-columns:322px minmax\(0,1fr\);gap:36px\}/);
  assert.doesNotMatch(css, /html\.events-screen \.workspace/, 'the events screen does not rebuild the workspace');
  assert.doesNotMatch(css, /html\.film-screen \.workspace/, 'neither does the film page');
  assert.doesNotMatch(css, /html\.events-screen \.filters\{[^}]*(width:auto|padding:0|border:0)/, 'the sidebar keeps its width, padding and rule on the events screen');
  assert.match(css, /html\.events-screen \.results,html\.events-screen \.filter-toggle,html\.events-screen \.filters>:not\(\.events-types\)\{display:none!important\}/, 'on the events screen the sidebar shows only the type panel');
  assert.match(css, /html\.film-screen \.results\{display:none!important\}|html\.film-screen \.search-panel,html\.film-screen \.results\{display:none!important\}/, 'on the film page only the programme column is replaced');
  assert.match(css, /\.events-type-options button\[aria-pressed=true\]\{/, 'the pressed type is visibly active');
  assert.match(css, /\.events-main\[hidden\]\{display:none\}/);
  assert.match(css, /@media\(max-width:760px\)\{[^@]*\.events-type-options\{flex-direction:row;flex-wrap:wrap\}/, 'narrow screens: the types wrap above the feed');
}

// 3. The pure mapping.
const stubWindow = {location: {href: 'https://iptv.example/'}};
const pure = vm.createContext({URL, URLSearchParams, Set, Map, Date, Intl, document: {querySelector: () => null, querySelectorAll: () => []}, window: stubWindow});
vm.runInContext(fs.readFileSync('public/return-home.js', 'utf8') + '\n' + app.replace(/init\(\);\s*$/, ''), pure);
const pureRun = code => vm.runInContext(code, pure);
{
  const mapping = {
    all: ['watchlist', 'started', 'unstarted', 'epg', 'discovery', 'ratings', 'enrichment', 'taste_profile', 'diary_viewing', 'some_future_type', undefined, ''],
    watchlist: ['watchlist', 'started', 'unstarted'], epg: ['epg'], discovery: ['discovery'], ratings: ['ratings'], enrichment: ['enrichment'], taste_profile: ['taste_profile'],
  };
  const everything = mapping.all;
  for (const [id, expected] of Object.entries(mapping)) {
    const matched = everything.filter(type => pureRun(`eventMatchesType({type:${JSON.stringify(type)}},${JSON.stringify(id)})`));
    assert.deepEqual(matched, expected, id);
  }
  assert.equal(pureRun("eventMatchesType({type:'epg'},'nonsense')"), true, 'an unknown filter id never hides events');
  assert.equal(pureRun("eventMatchesType(null,'epg')"), false);
  assert.equal(pureRun("eventMatchesType({type:'taste_profile'},'enrichment')"), false, 'the taste profile is not a prediction run');
  // The query parameter: valid, default, invalid, duplicated.
  for (const [search, expected] of [['', 'all'], ['?type=all', 'all'], ['?type=ratings', 'ratings'], ['?return=%2F%3Fq%3D1&type=taste_profile', 'taste_profile'], ['?type=bogus', 'all'], ['?type=', 'all'], ['?type=RATINGS', 'all'], ['?type=bogus&type=epg', 'epg'], ['?type=watchlist&type=epg', 'watchlist']]) {
    assert.equal(pureRun(`eventTypeFrom(${JSON.stringify(search)})`), expected, search);
  }
  assert.equal(pureRun("withEventType('/events','all')"), '/events');
  assert.equal(pureRun("withEventType('/events','ratings')"), '/events?type=ratings');
  assert.equal(pureRun("withEventType('/events','bogus')"), '/events');
  assert.equal(pureRun("ReturnHome.withReturn(withEventType('/events','ratings'),'/?q=%D0%B6&genre=a&genre=b#f')"), '/events?type=ratings&return=' + encodeURIComponent('/?q=%D0%B6&genre=a&genre=b#f'), 'the type and the return target live side by side');
}

// 4. Behaviour over the real app.js with a recording DOM: one feed node, one request at a time, guarded automatic pagination.
const nodes = new Map();
function node(selector, extra = {}) {
  const item = {selector, innerHTML: '', textContent: '', hidden: false, disabled: false, dataset: {}, parentNode: null, attrs: new Map(), children: [],
    classList: {toggle() {}, add() {}, remove() {}, contains() {return false;}},
    setAttribute(name, value) {item.attrs.set(name, String(value));}, getAttribute(name) {return item.attrs.get(name) ?? null;}, removeAttribute(name) {item.attrs.delete(name);},
    focus() {}, addEventListener() {}, appendChild(child) {if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(other => other !== child); child.parentNode = item; item.children.push(child); return child;}, ...extra};
  nodes.set(selector, item);
  return item;
}
const filters = node('#filters'), eventsMain = node('#events-screen', {hidden: true}), activity = node('.activity'), list = node('#activity-list'), status = node('#activity-status');
const more = node('#activity-more', {hidden: true, textContent: 'Более давние события'}), typePanel = node('#events-types', {hidden: true}), expand = node('#activity-expand'), returnLink = node('#return-home', {hidden: true});
filters.appendChild(activity);
const typeButtons = ['all', 'watchlist', 'epg', 'discovery', 'ratings', 'enrichment', 'taste_profile'].map(id => node('[data-event-type=' + id + ']', {dataset: {eventType: id}}));
const classes = new Set();
const document = {
  hidden: false, addEventListener() {}, removeEventListener() {},
  documentElement: {classList: {toggle(name, on) {on ? classes.add(name) : classes.delete(name);}}},
  querySelector: selector => nodes.get(selector) || null,
  querySelectorAll: selector => selector === '#events-types [data-event-type]' ? typeButtons : [],
};
const stack = [{href: 'https://iptv.example/?q=x', state: null}];
let index = 0;
const win = {
  scrollY: 0, scrollTo() {}, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({matches: false}),
  location: {href: stack[0].href},
  history: {
    get state() {return stack[index].state;},
    pushState(state, _t, url) {stack.splice(index + 1); stack.push({href: new URL(url, win.location.href).href, state}); index++; win.location.href = stack[index].href;},
    replaceState(state, _t, url) {stack[index] = {href: new URL(url, win.location.href).href, state}; win.location.href = stack[index].href;},
    back() {index--; win.location.href = stack[index].href; run('onHistoryNavigation()');},
    forward() {index++; win.location.href = stack[index].href; run('onHistoryNavigation()');},
  },
};
// The archive: a chain of pages, newest first, linked by cursors. A page is served when its gate (if any) is released; a request is aborted through its signal.
let archive = {}, requests = [], inFlight = 0, maxInFlight = 0, failures = new Set(), gates = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const context = vm.createContext({Date, Intl, URL, URLSearchParams, Set, Map, JSON, console, document, window: win, setTimeout, AbortController,
  sessionStorage: {getItem: () => null, setItem() {}}, localStorage: {getItem: () => null, setItem() {}},
  fetch: (url, options = {}) => new Promise((resolve, reject) => {
    const cursor = new URL(String(url), 'https://iptv.example').searchParams.get('cursor') || 'first';
    const entry = {url: String(url), method: options.method || 'GET', cursor, aborted: false};
    requests.push(entry);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    let finished = false;
    const done = () => {if (!finished) {finished = true; inFlight--;}};
    if (options.signal) options.signal.addEventListener('abort', () => {entry.aborted = true; done(); reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));});
    entry.held = gates.has(cursor);
    Promise.resolve(gates.get(cursor)).then(() => {
      entry.held = false;
      if (entry.aborted) return;
      done();
      if (failures.has(cursor)) return resolve({ok: false, status: 500, json: async () => ({})});
      resolve({ok: true, json: async () => archive[cursor]});
    });
  })});
vm.runInContext(fs.readFileSync('public/return-home.js', 'utf8') + '\n' + app.replace(/init\(\);\s*$/, ''), context);
const run = code => vm.runInContext(code, context);
// The rendering of single events is tested elsewhere; here every event is one marked line.
run("eventHTML=(event)=>'<li data-event-id=\"'+event.id+'\" data-type=\"'+event.type+'\">'+event.type+'</li>'");
const shownIds = () => [...list.innerHTML.matchAll(/data-event-id="([^"]*)"/g)].map(match => match[1]);
const shownTypes = () => [...list.innerHTML.matchAll(/data-type="([^"]*)"/g)].map(match => match[1]);
const at = minutes => new Date(Date.UTC(2026, 10, 8, 12, 0) - minutes * 60000).toISOString();
let tick = 0;
const ev = (id, type) => ({id, type, at: at(++tick)});
const pressed = () => typeButtons.map(button => button.getAttribute('aria-pressed'));
// AIR-374: a request held by a gate can never finish by itself, so waiting for the search to end only burned the whole 2.4 s bound (four times); the wait now also ends once the request in flight is the one a gate holds, which is the state those cases go on to assert.
const heldByGate = () => requests.some(request => request.held && !request.aborted);
const settle = async () => {await sleep(0); for (let i = 0; i < 600 && (run('eventSearch.state') === 'searching' || run('eventLoading')) && !heldByGate(); i++) await sleep(4);};
const reset = async (pages, first = 'first') => {
  run('cancelEventSearch()');
  archive = pages; requests = []; inFlight = 0; maxInFlight = 0; failures = new Set(); gates = new Map(); tick = 0;
  run("loadedEvents.clear();eventCursor=null;eventsReady=false;eventTypeFilterId='all';activityNote='Загружаем события…'");
  win.history.replaceState(null, '', 'https://iptv.example/?q=x');
  run('eventsScreen=false;applyEventsScreen(false)');
  void first;
};
const onEvents = async type => {
  win.history.replaceState(null, '', 'https://iptv.example/');
  run("openEventsScreen(document.querySelector('#activity-expand'))");
  if (type) run(`selectEventType(${JSON.stringify(type)})`);
  await settle();
};
// Archive helper: page n holds `ratings[n]` ratings and the rest epg events; cursors c1, c2, ...
const chain = (ratingsPerPage, size = 6) => {
  const pages = {};
  ratingsPerPage.forEach((count, n) => {
    const events = [];
    for (let k = 0; k < size; k++) events.push(ev(`p${n}-${k}`, k < count ? 'ratings' : 'epg'));
    pages[n === 0 ? 'first' : 'c' + n] = {events, cursor: n < ratingsPerPage.length - 1 ? 'c' + (n + 1) : null};
  });
  return pages;
};

// 4.1 «Все события»: the first page, no scan, the feed moves to the main column, the sidebar shows the types.
await reset({first: {events: [ev('e1', 'epg'), ev('d1', 'discovery'), ev('r1', 'ratings'), ev('s1', 'started'), ev('t1', 'taste_profile'), ev('p1', 'enrichment'), ev('w1', 'watchlist'), ev('u1', 'unstarted'), ev('x1', 'some_future_type')], cursor: 'c1'}, c1: {events: [ev('e0', 'epg')], cursor: null}});
assert.equal(await run('loadEvents(false)'), true);
assert.equal(requests.length, 1, 'one request loads the feed');
assert.deepEqual(shownTypes(), ['epg', 'discovery', 'ratings', 'started', 'taste_profile', 'enrichment', 'watchlist', 'unstarted', 'some_future_type'], 'the compact feed shows every event, unknown types included');
assert.equal(more.hidden, false, 'the older-events button offers the next page');
await onEvents();
assert.equal(new URL(win.location.href).pathname, '/events');
assert.equal(new URL(win.location.href).searchParams.has('type'), false, 'the default choice needs no parameter');
assert.equal(activity.parentNode, eventsMain, 'the one feed node is now in the main column');
assert.equal(filters.children.includes(activity), false, 'and no longer in the sidebar: it is never rendered twice');
assert.equal(typePanel.hidden, false);
assert.equal(eventsMain.hidden, false);
assert.deepEqual(pressed(), ['true', 'false', 'false', 'false', 'false', 'false', 'false']);
assert.equal(shownIds().length, 9);
assert.equal(requests.length, 1, '«Все события» does not scan the archive');
await sleep(30);
assert.equal(requests.length, 1, 'and nothing happens by itself later');

// 4.2 Each type is a single selection; the choice is in the URL of the same history entry next to the return target.
const entries = stack.length;
const expectations = {watchlist: ['s1', 'w1', 'u1'], epg: ['e1', 'e0'], discovery: ['d1'], ratings: ['r1'], enrichment: ['p1'], taste_profile: ['t1']};
for (const [id, expected] of Object.entries(expectations)) {
  run(`selectEventType(${JSON.stringify(id)})`);
  await settle();
  assert.deepEqual(shownIds().sort(), [...expected].sort(), id);
  assert.deepEqual(pressed(), ['all', 'watchlist', 'epg', 'discovery', 'ratings', 'enrichment', 'taste_profile'].map(name => String(name === id)), id + ': exactly one button is active');
  const url = new URL(win.location.href);
  assert.equal(url.pathname, '/events');
  assert.equal(url.searchParams.get('type'), id);
  assert.equal(run('ReturnHome.fromSearch(new URL(window.location.href).search)'), '/', id + ': the return target is kept');
  assert.equal(stack.length, entries, 'a filter change adds no history entry');
}
assert.equal(maxInFlight, 1, 'never two requests at once');
run("selectEventType('all')");
await settle();
assert.equal(new URL(win.location.href).searchParams.has('type'), false, 'back to the default removes the parameter');
assert.equal(shownIds().length, 10, 'every loaded event, nothing duplicated');
run("selectEventType('nonsense')");
assert.equal(run('eventTypeFilterId'), 'all', 'an unknown button value changes nothing');

// 4.3 Several consecutive pages without a match are searched without a click; the search stops at 10 matches; older pages stay a manual choice.
await reset(chain([1, 0, 0, 4, 0, 6, 3, 3]));
await run('loadEvents(false)');
gates.set('c1', new Promise(resolve => {gates.release = resolve;}));
await onEvents();
run("selectEventType('ratings')");
await sleep(20);
assert.equal(run('eventSearch.state'), 'searching');
assert.equal(status.textContent, 'Ищем более давние события… Найдено среди загруженных: 1.', 'the search is announced and the matches found so far are counted');
assert.deepEqual(shownIds(), ['p0-0'], 'what was found is shown while it searches');
assert.equal(more.hidden, true, 'no manual button while it searches by itself');
gates.release();
await settle();
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1', 'c2', 'c3', 'c4', 'c5'], 'strictly sequential, in cursor order, through the pages with no match, and no further than needed');
assert.equal(maxInFlight, 1);
assert.equal(shownIds().length, 11, '1 + 0 + 0 + 4 + 0 + 6 matches');
assert.equal(run('eventMatchCount("ratings")'), 11);
assert.equal(run('eventSearch.state'), 'idle');
assert.equal(status.textContent, '', 'nothing but the list once the first screen is full');
assert.equal(more.hidden, false, 'older events stay available by hand');
assert.equal(more.textContent, 'Более давние события');
assert.equal(shownTypes().every(type => type === 'ratings'), true);
// What is loaded is reused: the same type again does not search, a type with fewer than 10 loaded continues from the same cursor.
const loadedRequests = requests.length;
run("selectEventType('all')");
run("selectEventType('ratings')");
await settle();
assert.equal(requests.length, loadedRequests, 'ten matches are already loaded: no request');
run("selectEventType('epg')");
await settle();
assert.equal(requests.length, loadedRequests, 'epg events are plentiful in what is loaded: no request');

// 4.4 One match and zero matches until the cursor is exhausted.
await reset(chain([0, 0, 1, 0]));
await run('loadEvents(false)');
await onEvents('ratings');
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1', 'c2', 'c3'], 'the whole archive was walked');
assert.deepEqual(shownIds(), ['p2-0']);
assert.equal(run('eventSearch.state'), 'exhausted');
assert.equal(status.textContent, '', 'one match is shown as it is');
assert.equal(more.hidden, true, 'the cursor is exhausted');
await reset(chain([0, 0, 0]));
await run('loadEvents(false)');
await onEvents('ratings');
assert.deepEqual(shownIds(), []);
assert.equal(run('eventSearch.state'), 'exhausted');
assert.equal(status.textContent, 'Во всём доступном архиве событий этого типа нет.', 'the empty state only once the archive is exhausted');
assert.equal(more.hidden, true);

// 4.5 Cancellation: another type, «Все события» or leaving the screen aborts the request and starts nothing more.
for (const stop of ["selectEventType('all')", "selectEventType('epg')", "applyEventsScreen(false)"]) {
  await reset(chain([0, 0, 0, 0, 0, 0]));
  await run('loadEvents(false)');
  gates.set('c2', new Promise(resolve => {gates.release = resolve;}));
  await onEvents('ratings');
  await sleep(20);
  assert.equal(run('eventSearch.state'), 'searching');
  assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1', 'c2'], 'waiting on c2');
  run(stop);
  await sleep(20);
  assert.equal(requests.at(-1).aborted, true, stop + ': the request in flight is aborted');
  gates.release();
  await sleep(60);
  assert.equal(requests.length, 3, stop + ': nothing more is requested after the change');
  assert.equal(inFlight, 0);
  if (stop.includes('epg')) {
    assert.equal(run('eventTypeFilterId'), 'epg');
    assert.ok(shownIds().length > 0, 'the new type searches from what is loaded');
  }
  assert.equal(maxInFlight, 1, stop + ': a new search never overlaps the old request');
}

// 4.6 Duplicates, a repeated cursor and a cursor that does not advance.
await reset({first: {events: [ev('a', 'epg'), ev('b', 'epg')], cursor: 'c1'}, c1: {events: [ev('a', 'epg'), ev('b', 'epg')], cursor: 'c2'}, c2: {events: [ev('a', 'epg')], cursor: 'c1'}});
await run('loadEvents(false)');
await onEvents('ratings');
assert.equal(run('eventSearch.state'), 'stuck', 'a cursor seen before ends the search');
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1', 'c2'], 'and nothing is requested twice');
assert.equal(run('loadedEvents.size'), 2, 'the repeated events are one');
assert.match(status.textContent, /Архив событий не продвигается дальше\./);
assert.equal(more.hidden, false);
assert.equal(more.textContent, 'Повторить', 'an explicit retry, no automatic one');
await reset({first: {events: [ev('a', 'epg')], cursor: 'c1'}, c1: {events: [ev('a', 'epg')], cursor: 'c1'}});
await run('loadEvents(false)');
await onEvents('ratings');
assert.equal(run('eventSearch.state'), 'stuck', 'a cursor that does not advance');
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1']);

// 4.7 An API error stops the search, says why, offers a retry and never retries by itself; the retry continues from the same cursor.
await reset(chain([0, 0, 0, 4, 7]));
await run('loadEvents(false)');
failures.add('c2');
await onEvents('ratings');
assert.equal(run('eventSearch.state'), 'error');
assert.match(status.textContent, /^Не удалось загрузить события\. Найдено среди загруженных: 0\.$/);
assert.equal(more.hidden, false);
assert.equal(more.textContent, 'Повторить');
const failedRequests = requests.length;
await sleep(80);
assert.equal(requests.length, failedRequests, 'no automatic retry');
failures.clear();
run('startEventSearch()');
await settle();
assert.deepEqual(requests.slice(failedRequests).map(request => request.cursor), ['c2', 'c3', 'c4'].slice(0, requests.length - failedRequests), 'the retry resumes from the cursor that failed');
assert.equal(run('eventMatchCount("ratings")'), 10, '4 + 6 (a page holds six events): the target of ten is reached');
assert.equal(status.textContent, '');

// 4.8 A deep link or a reload with a type: it waits for the first page, then searches by itself.
await reset(chain([0, 0, 4, 8]));
win.history.replaceState(null, '', 'https://iptv.example/events?return=' + encodeURIComponent('/?q=x') + '&type=ratings');
run('eventsScreen=false;applyEventsScreen(true)');
assert.equal(run('eventTypeFilterId'), 'ratings', 'the type comes from the URL');
assert.equal(pressed()[4], 'true');
assert.equal(requests.length, 0, 'nothing is requested before the feed has loaded');
await run('loadEvents(false)');
await settle();
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1', 'c2', 'c3'], 'the first page, then the search with no click');
assert.equal(run('eventMatchCount("ratings")'), 10);
// Back and Forward between two events entries restore the choice and its search.
win.history.pushState({iptvEvents: true}, '', 'https://iptv.example/events?type=epg');
run('onHistoryNavigation()');
await settle();
assert.equal(run('eventTypeFilterId'), 'epg');
win.history.back();
assert.equal(run('eventTypeFilterId'), 'ratings', 'Back restores the previous choice and its button');
assert.equal(pressed()[4], 'true');
win.history.forward();
assert.equal(run('eventTypeFilterId'), 'epg', 'Forward restores the next one');
await settle();

// 4.9 A refresh keeps the filter and does not duplicate; leaving the screen shows the whole compact feed again.
const beforeRefresh = run('loadedEvents.size');
await run('loadEvents(false,{quiet:true})');
assert.equal(run('loadedEvents.size'), beforeRefresh, 'a refresh of the first page adds no duplicates');
assert.equal(run('eventTypeFilterId'), 'epg', 'and keeps the active filter');
win.history.replaceState(null, '', 'https://iptv.example/?q=x');
run('applyEventsScreen(false)');
assert.equal(activity.parentNode, filters, 'the feed is back in the sidebar');
assert.equal(eventsMain.hidden, true);
assert.equal(typePanel.hidden, true);
assert.equal(shownIds().length, run('loadedEvents.size'), 'the compact feed is not filtered');
assert.ok(requests.every(request => request.method === 'GET' && request.url.startsWith('/api/events')), 'no request but reads of the events feed');

// 4.10 Choosing a type changes only the `type` parameter of the current events URL: every other parameter, the encoded non-ASCII return target and the fragment survive byte for byte.
await reset(chain([1]));
await run('loadEvents(false)');
const eventsBase = '/events?return=' + encodeURIComponent('/?q=жара&genre=Драма') + '&foo=bar+baz&empty=';
win.history.replaceState(null, '', 'https://iptv.example' + eventsBase + '&type=epg#section-2');
run('eventsScreen=false;applyEventsScreen(true)');
assert.equal(run('eventTypeFilterId'), 'epg');
const where = () => {const url = new URL(win.location.href); return url.pathname + url.search + url.hash;};
run("selectEventType('ratings')");
await settle();
assert.equal(where(), eventsBase + '&type=ratings#section-2', 'the old type is replaced, everything else is untouched, the hash too');
assert.equal(run('ReturnHome.fromSearch(new URL(window.location.href).search)'), '/?q=%D0%B6%D0%B0%D1%80%D0%B0&genre=%D0%94%D1%80%D0%B0%D0%BC%D0%B0', 'the non-ASCII return target still resolves');
run("selectEventType('all')");
await settle();
assert.equal(where(), eventsBase + '#section-2', 'back to the default removes only `type`');
run("selectEventType('enrichment')");
await settle();
assert.equal(where(), eventsBase + '&type=enrichment#section-2');
win.history.replaceState(null, '', 'https://iptv.example/events?type=taste_profile&x=1&return=' + encodeURIComponent('/?q=1') + '#h');
run("selectEventType('watchlist')");
await settle();
assert.equal(where(), '/events?x=1&return=' + encodeURIComponent('/?q=1') + '&type=watchlist#h', 'a type anywhere in the query is replaced and the rest keeps its order');
assert.equal(run("withEventType('/events?a=1#h','epg')"), '/events?a=1&type=epg#h');
assert.equal(run("withEventType('/events?type=epg&type=ratings&a=1','all')"), '/events?a=1', 'every old type goes');
assert.equal(run("withEventType('/events?%74ype=epg','all')"), '/events', 'an encoded key is recognised');

// 4.11 The state of the search is told even when nothing is loaded: an empty first page, an empty archive, a failure, a repeated cursor.
await reset({first: {events: [], cursor: null}});
await run('loadEvents(false)');
await onEvents('ratings');
assert.equal(run('eventSearch.state'), 'exhausted');
assert.equal(status.textContent, 'Во всём доступном архиве событий этого типа нет.', 'an archive that is empty to the end reports it accurately');
run("selectEventType('all')");
assert.equal(status.textContent, 'Здесь появятся события списка.', '«Все события» keeps its own text for an empty feed');
await reset({first: {events: [], cursor: null}});
win.history.replaceState(null, '', 'https://iptv.example/events?type=ratings');
run('eventsScreen=false;applyEventsScreen(true)');
await run('loadEvents(false)');
await settle();
assert.equal(status.textContent, 'Во всём доступном архиве событий этого типа нет.', 'a deep link into an empty archive reports its end too');
await reset({first: {events: [], cursor: 'c1'}, c1: {events: [ev('z', 'epg')], cursor: null}});
await run('loadEvents(false)');
gates.set('c1', new Promise(resolve => {gates.release = resolve;}));
await onEvents('ratings');
await sleep(20);
assert.equal(status.textContent, 'Ищем более давние события… Найдено среди загруженных: 0.', 'searching is shown although the first page was empty');
gates.release();
await settle();
assert.equal(status.textContent, 'Во всём доступном архиве событий этого типа нет.');
await reset({first: {events: [], cursor: 'c1'}, c1: {events: [ev('z', 'epg')], cursor: null}});
await run('loadEvents(false)');
failures.add('c1');
await onEvents('ratings');
assert.equal(run('eventSearch.state'), 'error');
assert.equal(status.textContent, 'Не удалось загрузить события. Найдено среди загруженных: 0.', 'a failure after an empty first page is visible');
assert.equal(more.textContent, 'Повторить');
assert.equal(more.hidden, false);
await reset({first: {events: [], cursor: 'c1'}, c1: {events: [], cursor: 'c1'}});
await run('loadEvents(false)');
await onEvents('ratings');
assert.equal(run('eventSearch.state'), 'stuck');
assert.equal(status.textContent, 'Архив событий не продвигается дальше. Найдено среди загруженных: 0.', 'a repeated cursor after an empty first page is visible');
assert.equal(more.textContent, 'Повторить');

// 5. The film page keeps its sidebar; the events frame is the same grid.
{
  assert.match(app, /function syncFilmReturn\(\)/, 'the film route keeps its return target in step with the sidebar filters');
  assert.match(app, /if\(filmIdFromLocation\(\)\)\{syncFilmReturn\(\);return;\}/);
}

console.log('Events type filter: shared frame, seven single-select types, URL parameter with deep link and Back/Forward, guarded sequential automatic pagination (zero-match pages, exhausted cursor, cancellation, error with retry, repeated cursor, reuse of loaded events) and one feed node passed');
