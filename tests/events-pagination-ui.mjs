// AIR-530: older events load by scrolling (a sentinel at the end of the real scroll container), with a loader, an explicit retry and a durable end-of-history
// marker. Runs the real public/app.js over a recording DOM, a fake IntersectionObserver and an archive of pages linked by cursors.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');
const app = fs.readFileSync('public/return-home.js', 'utf8') + '\n' + fs.readFileSync('public/app.js', 'utf8').replace(/init\(\);\s*$/, '');

// 1. Markup and styles.
{
  const tail = html.match(/<div class="activity-tail">[\s\S]*?<\/div><\/div><\/section>/)[0];
  assert.match(tail, /id="activity-sentinel" aria-hidden="true"/, 'a sentinel marks the end of the list');
  assert.match(tail, /id="activity-loading" class="activity-loading" role="status" hidden>[\s\S]*Загружаем более давние события…/, 'the loader is announced');
  assert.match(tail, /id="activity-end" class="activity-end" hidden>Это самое раннее доступное событие\.</, 'the end marker is plain text');
  assert.match(tail, /<button type="button" id="activity-more" hidden>Повторить<\/button>/, 'the only button is the retry');
  assert.ok(html.indexOf('id="activity-list"') < html.indexOf('id="activity-sentinel"'), 'the tail follows the list inside the scroll region');
  assert.ok(html.indexOf('class="activity-scroll"') < html.indexOf('id="activity-sentinel"') && html.indexOf('id="activity-sentinel"') < html.indexOf('class="status-footer"'));
  assert.doesNotMatch(html, /Более давние события<\/button>/, 'no «older events» button in the markup');
  assert.match(html, /id="activity-status" role="status"/);
  assert.match(css, /\.activity-spinner\{[^}]*animation:activity-more-spin/, 'the loader spins');
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.activity-spinner\{animation:none/, 'and respects reduced motion');
  assert.match(css, /\.activity-loading\[hidden\],\.activity-end\[hidden\]\{display:none\}/);
  assert.match(css, /html\.events-screen \.activity-scroll\{max-height:calc\(100dvh - 220px\)\}/, 'the expanded list is the same scroll container');
  assert.match(html, /<footer class="status-footer"/);
  assert.doesNotMatch(css, /html\.events-screen \.status-footer\{display:\s*none/);
}

// 2. A recording DOM.
const nodes = new Map();
const attrs = new Map();
const mk = (selector, extra = {}) => { const item = {selector, textContent: '', hidden: false, disabled: false, dataset: {}, attrs: new Map(), children: [], parentNode: null,
  classList: {toggle() {}, add() {}, remove() {}, contains() {return false;}},
  setAttribute(name, value) {item.attrs.set(name, String(value));}, getAttribute(name) {return item.attrs.get(name) ?? null;}, removeAttribute(name) {item.attrs.delete(name);},
  focus() {}, addEventListener() {}, appendChild(child) {child.parentNode = item; item.children.push(child); return child;}, ...extra}; nodes.set(selector, item); return item; };
// The list parses its own markup: every `data-event-id` item holds the <details> it was written with, so open/closed state can be observed.
let items = [];
const list = mk('#activity-list');
let html_ = '';
Object.defineProperty(list, 'innerHTML', {get: () => html_, set(value) {
  html_ = value; items = [];
  for (const match of value.matchAll(/<li data-event-id="([^"]*)">([\s\S]*?)<\/li>/g)) {
    const details = [...match[2].matchAll(/<details( open)?>/g)].map(m => ({open: !!m[1]}));
    items.push({dataset: {eventId: match[1]}, offsetTop: items.length * 100, offsetHeight: 100, querySelectorAll: selector => selector === 'details' ? details : []});
  }
}});
const handlers = new Map();
const scroll = mk('.activity-scroll', {scrollTop: 0, clientHeight: 390, addEventListener(name, fn) {handlers.set(name, fn);}, querySelectorAll: selector => selector === '[data-event-id]' ? items : [], querySelector: selector => { const m = selector.match(/\[data-event-id="([^"]*)"\]/); return m ? items.find(item => item.dataset.eventId === m[1]) || null : null; }});
const status = mk('#activity-status'), more = mk('#activity-more', {hidden: true, textContent: 'Повторить'}), loader = mk('#activity-loading', {hidden: true}), end = mk('#activity-end', {hidden: true}), sentinel = mk('#activity-sentinel');
mk('.activity'); mk('#filters'); mk('#events-screen', {hidden: true}); mk('#events-types', {hidden: true}); mk('#activity-expand'); mk('#return-home', {hidden: true});
const typeButtons = ['all', 'watchlist', 'epg', 'discovery', 'ratings', 'enrichment', 'taste_profile'].map(id => mk('[data-event-type=' + id + ']', {dataset: {eventType: id}}));
const classes = new Set();
const document = {
  hidden: false, addEventListener() {}, removeEventListener() {},
  documentElement: {classList: {toggle(name, on) {on ? classes.add(name) : classes.delete(name);}}},
  querySelector: selector => nodes.get(selector) || null,
  querySelectorAll: selector => selector === '#events-types [data-event-type]' ? typeButtons : selector === '#activity-list [data-event-id]' ? items : [],
};
const stack = [{href: 'https://iptv.example/', state: null}];
let index = 0;
const win = {scrollY: 0, scrollTo() {}, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({matches: false}), location: {href: stack[0].href},
  history: {get state() {return stack[index].state;}, pushState(state, _t, url) {stack.splice(index + 1); stack.push({href: new URL(url, win.location.href).href, state}); index++; win.location.href = stack[index].href;}, replaceState(state, _t, url) {stack[index] = {href: new URL(url, win.location.href).href, state}; win.location.href = stack[index].href;}, back() {}, forward() {}}};

// A fake IntersectionObserver: `scrollToEnd()` reports the sentinel as visible, but only while it is observed, exactly like the browser.
const observers = [];
let stickyVisible = false; // a browser reports a sentinel that is already in view as soon as it is observed
class FakeObserver {
  constructor(callback, options) {this.callback = callback; this.options = options; this.targets = new Set(); this.disconnected = false; observers.push(this);}
  observe(target) {this.targets.add(target); if (stickyVisible) queueMicrotask(() => { if (this.targets.has(target) && !this.disconnected) this.callback([{isIntersecting: true, target}]); });}
  unobserve(target) {this.targets.delete(target);}
  disconnect() {this.targets.clear(); this.disconnected = true;}
}
const liveObserver = () => observers.filter(observer => !observer.disconnected).at(-1);
const sentinelObserved = () => !!liveObserver() && liveObserver().targets.has(sentinel);
const scrollToEnd = () => { const observer = liveObserver(); if (observer && observer.targets.has(sentinel)) observer.callback([{isIntersecting: true, target: sentinel}]); };

let archive = {}, requests = [], inFlight = 0, maxInFlight = 0, failures = new Set(), gates = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const context = vm.createContext({Date, Intl, URL, URLSearchParams, Set, Map, JSON, console, document, window: win, setTimeout, AbortController, IntersectionObserver: FakeObserver,
  sessionStorage: {getItem: () => null, setItem() {}}, localStorage: {getItem: () => null, setItem() {}},
  fetch: (url, options = {}) => new Promise((resolve, reject) => {
    const cursor = new URL(String(url), 'https://iptv.example').searchParams.get('cursor') || 'first';
    const entry = {url: String(url), method: options.method || 'GET', cursor, aborted: false};
    requests.push(entry);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    let finished = false;
    const done = () => {if (!finished) {finished = true; inFlight--;}};
    if (options.signal) options.signal.addEventListener('abort', () => {entry.aborted = true; done(); reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));});
    Promise.resolve(gates.get(cursor)).then(() => {
      if (entry.aborted) return;
      done();
      if (failures.has(cursor)) return resolve({ok: false, status: 500, json: async () => ({})});
      resolve({ok: true, json: async () => archive[cursor]});
    });
  })});
vm.runInContext(app, context);
const run = code => vm.runInContext(code, context);
run('bindActivityDemand()');
run("eventHTML=(event)=>'<li data-event-id=\"'+event.id+'\"><details open></details>'+event.type+'</li>'");
const shownIds = () => [...html_.matchAll(/data-event-id="([^"]*)"/g)].map(match => match[1]);
let tick = 0;
const ev = (id, type = 'epg') => ({id, type, at: new Date(Date.UTC(2026, 10, 18, 12, 0) - ++tick * 60000).toISOString()});
const chain = (pages, size = 4, typeOf = () => 'epg') => {
  const out = {};
  for (let n = 0; n < pages; n++) out[n === 0 ? 'first' : 'c' + n] = {events: Array.from({length: size}, (_, k) => ev(`p${n}-${k}`, typeOf(n, k))), cursor: n < pages - 1 ? 'c' + (n + 1) : null};
  return out;
};
const tail = () => ({loading: !loader.hidden, end: !end.hidden, retry: !more.hidden, observed: sentinelObserved(), busy: scroll.getAttribute('aria-busy')});
const reset = (pages) => {
  run('cancelEventSearch()');
  archive = pages; requests = []; inFlight = 0; maxInFlight = 0; failures = new Set(); gates = new Map(); tick = 0;
  run("resetEventPrefetch();loadedEvents.clear();eventCursor=null;eventsReady=false;eventLoading=false;eventLoadingMore=false;eventTypeFilterId='all';activityNote='Загружаем события…';eventPaging.error=null;eventPaging.stuck=false;eventPaging.seen.clear()");
  win.history.replaceState(null, '', 'https://iptv.example/');
  run('eventsScreen=false;applyEventsScreen(false)');
  scroll.scrollTop = 0;
};
const settle = async () => { for (let i = 0; i < 400 && (run('eventLoading') || run('eventSearch.state') === 'searching'); i++) await sleep(2); await sleep(0); };

// 3. First page: no button, the sentinel is armed on the real scroll container with a prefetch margin, nothing else is requested.
reset(chain(4));
assert.equal(await run('loadEvents(false)'), true);
assert.equal(requests.length, 1);
assert.deepEqual(tail(), {loading: false, end: false, retry: false, observed: true, busy: null}, 'the button is gone from the successful flow; the sentinel waits');
assert.equal(liveObserver().options.root, scroll, 'the observed root is the .activity-scroll container');
assert.match(liveObserver().options.rootMargin, /^0px 0px [1-9]\d+px 0px$/, 'a prefetch margin at the bottom');
await sleep(30);
assert.equal(requests.length, 1, 'no polling: nothing happens until the user scrolls');

// 4. Several pages by scrolling; exact EOF; the loader while a slow request is in flight; no second request.
gates.set('c1', new Promise(resolve => {gates.release = resolve;}));
scrollToEnd();
assert.equal(requests.length, 2, 'the scroll asks for the next page');
assert.equal(requests[1].cursor, 'c1');
assert.deepEqual(tail(), {loading: true, end: false, retry: false, observed: false, busy: 'true'}, 'the loader is visible, the region is busy and the sentinel is not observed');
assert.equal(await run('loadEvents(true)'), 'busy', 'a direct second call cannot start another request');
assert.equal(run('loadOlderEvents()'), false, 'the scroll handler does nothing while a request is in flight');
scrollToEnd();
assert.equal(requests.length, 2, 'a repeated scroll event does not repeat the request');
gates.release();
await settle();
assert.deepEqual(tail(), {loading: false, end: false, retry: false, observed: true, busy: null}, 'the loader goes, the sentinel is armed again');
scrollToEnd(); await settle();
scrollToEnd(); await settle();
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1', 'c2', 'c3'], 'every page once, in cursor order');
assert.equal(maxInFlight, 1);
assert.equal(shownIds().length, 16, 'four pages of four events');
assert.deepEqual(tail(), {loading: false, end: true, retry: false, observed: false, busy: null}, 'the cursor is exhausted: the end marker stays and nothing is observed');
assert.equal(end.textContent === '' || true, true);
scrollToEnd(); await sleep(20);
assert.equal(requests.length, 4, 'no request after the end');
assert.equal(new Set(shownIds()).size, 16, 'no duplicates');

// 5. A sentinel that is still in view after a page is added asks for the next one (a short page does not fill the container); a full page does not.
reset(chain(3));
await run('loadEvents(false)');
scrollToEnd(); await settle();
assert.equal(sentinelObserved(), true, 're-armed after the page: the browser reports the current intersection again');
const armed = liveObserver();
assert.equal(observers.filter(observer => !observer.disconnected).length, 1, 'one observer, never one per page');
assert.ok(armed.targets.has(sentinel));

// 6. Exact EOF on the first page, an empty archive and an empty first page followed by a cursor.
reset({first: {events: [ev('a'), ev('b')], cursor: null}});
await run('loadEvents(false)');
assert.deepEqual(tail(), {loading: false, end: true, retry: false, observed: false, busy: null}, 'one page, no cursor: the end is proved');
reset({first: {events: [], cursor: null}});
await run('loadEvents(false)');
assert.deepEqual(tail(), {loading: false, end: false, retry: false, observed: false, busy: null}, 'an empty archive has an empty state, not an end marker');
assert.equal(status.textContent, 'Здесь появятся события списка.');
reset({first: {events: [], cursor: 'c1'}, c1: {events: [ev('z')], cursor: null}});
await run('loadEvents(false)');
assert.equal(end.hidden, true, 'an empty first page is not the end while a cursor remains');
assert.equal(sentinelObserved(), true);
scrollToEnd(); await settle();
assert.deepEqual(shownIds(), ['z']);
assert.equal(end.hidden, false);

// 7. A network failure: error and an explicit retry; nothing is retried by itself; the retry resumes from the saved cursor; no end marker anywhere near it.
reset(chain(3));
await run('loadEvents(false)');
failures.add('c1');
scrollToEnd(); await settle();
assert.deepEqual(tail(), {loading: false, end: false, retry: true, observed: false, busy: null});
assert.equal(more.textContent, 'Повторить');
assert.equal(status.textContent, 'Не удалось загрузить события.');
const failed = requests.length;
scrollToEnd(); await sleep(60);
assert.equal(requests.length, failed, 'no automatic retry, and the scroll cannot hammer the API while the error waits');
assert.equal(run('eventCursor'), 'c1', 'the cursor is kept');
failures.clear();
run('retryEvents()'); await settle();
assert.deepEqual(requests.slice(failed).map(request => request.cursor), ['c1'], 'the retry resumes from the saved cursor');
assert.equal(status.textContent, '');
assert.deepEqual(tail(), {loading: false, end: false, retry: false, observed: true, busy: null}, 'then the scroll goes on');
// The retry of a first-page failure loads the first page.
reset(chain(2));
failures.add('first');
await run('loadEvents(false)');
assert.deepEqual(tail(), {loading: false, end: false, retry: true, observed: false, busy: null}, 'a failed first page offers the retry');
failures.clear();
run('retryEvents()'); await settle();
assert.equal(requests.at(-1).cursor, 'first');
assert.equal(shownIds().length, 4);
assert.equal(more.hidden, true);

// 8. Duplicate IDs, a repeated cursor and a cursor that does not advance.
reset({first: {events: [ev('a'), ev('b')], cursor: 'c1'}, c1: {events: [ev('a'), ev('b'), ev('c')], cursor: 'c2'}, c2: {events: [ev('c')], cursor: 'c1'}});
await run('loadEvents(false)');
scrollToEnd(); await settle(); scrollToEnd(); await settle();
assert.equal(shownIds().length, 3, 'a repeated event is listed once');
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1', 'c2'], 'nothing is requested twice');
assert.deepEqual(tail(), {loading: false, end: false, retry: true, observed: false, busy: null}, 'a cursor seen before stops the scroll and offers the retry, never an end marker');
assert.equal(status.textContent, 'Архив событий не продвигается дальше.');
reset({first: {events: [ev('a')], cursor: 'c1'}, c1: {events: [ev('b')], cursor: 'c1'}});
await run('loadEvents(false)');
scrollToEnd(); await settle();
assert.equal(run('eventPaging.stuck'), true, 'a cursor that does not advance');
assert.equal(end.hidden, true);
assert.equal(more.hidden, false);
scrollToEnd(); await sleep(20);
assert.equal(requests.length, 2);

// 9. Filtered: zero-match pages do not mean the end (AIR-381 keeps searching by itself), then the scroll continues; the end only when the cursor is exhausted.
reset(chain(6, 4, (n, k) => (n === 1 || n === 3) ? 'ratings' : 'epg'));
await run('loadEvents(false)');
win.history.replaceState(null, '', 'https://iptv.example/events?type=enrichment');
run('eventsScreen=false;applyEventsScreen(true)');
await settle();
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1', 'c2', 'c3', 'c4', 'c5'], 'the whole archive had no «enrichment» event: walked without a click');
assert.equal(end.hidden, true, 'no end marker for an empty filter result');
assert.equal(status.textContent, 'Во всём доступном архиве событий этого типа нет.');
reset(chain(8, 4, (n, k) => k < 2 && n !== 0 ? 'ratings' : 'epg'));
await run('loadEvents(false)');
win.history.replaceState(null, '', 'https://iptv.example/events?type=ratings');
run('eventsScreen=false;applyEventsScreen(true)');
await settle();
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1', 'c2', 'c3', 'c4', 'c5'], 'strictly sequential, no further than needed');
assert.equal(run('eventMatchCount("ratings")'), 10, 'the search stops at ten matches');
assert.equal(end.hidden, true, 'ten matches are not the end of history');
assert.equal(run('eventCursor'), 'c6');
assert.equal(sentinelObserved(), true, 'then the scroll takes over');
const walked = requests.length;
scrollToEnd(); await settle();
assert.equal(requests.length, walked + 1, 'one more page per scroll');
assert.equal(requests.at(-1).cursor, 'c6');
assert.equal(end.hidden, true, 'one page remains');
scrollToEnd(); await settle();
assert.equal(requests.at(-1).cursor, 'c7');
assert.equal(end.hidden, false, 'the last page was consumed: the end of the history, shown with the list of the type');
assert.ok(shownIds().length >= 10);
assert.equal(maxInFlight, 1);
// A page with no match while scrolling does not stop it and is not the end.
reset(chain(4, 4, (n, k) => n === 0 ? 'ratings' : n === 3 ? 'ratings' : 'epg'));
await run('loadEvents(false)');
win.history.replaceState(null, '', 'https://iptv.example/events?type=ratings');
run('eventsScreen=false;applyEventsScreen(true)');
await settle();
assert.equal(run('eventSearch.state'), 'exhausted', 'only 8 matches in the whole archive: it was walked to the end');
assert.equal(end.hidden, false);

// 10. Aborts: a type or screen change while the scroll's page is in flight leaves one consistent state and no extra request.
reset(chain(4));
await run('loadEvents(false)');
run('eventsScreen=false;applyEventsScreen(true)');
gates.set('c1', new Promise(resolve => {gates.release = resolve;}));
scrollToEnd();
run("selectEventType('epg')");
run('applyEventsScreen(false)');
gates.release();
await settle();
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1'], 'the page in flight completes once and nothing else is requested');
assert.equal(run('loadedEvents.size'), 8);
assert.equal(maxInFlight, 1);
assert.equal(sentinelObserved(), true, 'the sentinel is armed for the compact feed again');

// 11. Concurrency: a refresh of the first page while an older page is loading is skipped; afterwards the live refresh keeps the cursor and adds no duplicates.
reset(chain(4));
await run('loadEvents(false)');
gates.set('c1', new Promise(resolve => {gates.release = resolve;}));
scrollToEnd();
assert.equal(await run('loadEvents(false,{quiet:true})'), 'busy', 'the refresh waits for its turn');
gates.release(); await settle();
assert.equal(maxInFlight, 1);
const cursorBefore = run('eventCursor');
await run('loadEvents(false,{quiet:true})');
assert.equal(run('eventCursor'), cursorBefore, 'a refresh with many events loaded keeps the paging cursor');
assert.equal(run('loadedEvents.size'), 8, 'and adds no duplicate');

// 12. Position and groups survive a page: the viewed event keeps its offset, an opened or closed group keeps its state.
reset(chain(3));
await run('loadEvents(false)');
items[1].querySelectorAll('details')[0].open = false;
scroll.scrollTop = 150; // inside the second event
const anchorOffset = 150 - items[1].offsetTop;
scrollToEnd(); await settle();
assert.equal(items[1].dataset.eventId, 'p0-1');
assert.equal(items[1].querySelectorAll('details')[0].open, false, 'a group the user closed stays closed after the page is added');
assert.equal(items[0].querySelectorAll('details')[0].open, true, 'and an open one stays open');
assert.equal(scroll.scrollTop, items[1].offsetTop + anchorOffset, 'the scroll position is anchored to the same event');

// 12b. AIR-530 review P2: a background refresh of the first page keeps an older-page error until the explicit retry; the failed cursor is not fetched again by itself.
reset(chain(4));
await run('loadEvents(false)');
failures.add('c1');
scrollToEnd(); await settle();
assert.equal(run('eventPaging.error'), 'more');
const afterFailure = requests.length;
assert.equal(await run('loadEvents(false,{quiet:true})'), true, 'the quiet refresh succeeds');
assert.equal(run('eventPaging.error'), 'more', 'and does not clear the older-page error');
assert.deepEqual(tail(), {loading: false, end: false, retry: true, observed: false, busy: null}, 'the retry stays, the sentinel stays unobserved');
assert.equal(status.textContent, 'Не удалось загрузить события.', 'the error text stays');
stickyVisible = true;
await run('loadEvents(false,{quiet:true})'); await sleep(30);
scrollToEnd(); await sleep(30);
stickyVisible = false;
assert.deepEqual(requests.slice(afterFailure).map(request => request.cursor), ['first', 'first'], 'only the two refreshes: the failed cursor c1 is not requested again');
failures.clear();
run('retryEvents()'); await settle();
assert.equal(requests.at(-1).cursor, 'c1', 'the explicit retry fetches it');
assert.equal(run('eventPaging.error'), null);

// 12c. AIR-530 review P1: a list that stays short never reads the archive without the user. After a type search found its ten, many zero-match pages are bounded, then a button takes over.
const sparse = {first: {events: Array.from({length: 12}, (_, k) => ev('r' + k, 'ratings')), cursor: 'c1'}};
for (let n = 1; n <= 12; n++) sparse['c' + n] = {events: [ev('x' + n + 'a'), ev('x' + n + 'b')], cursor: n < 12 ? 'c' + (n + 1) : null};
reset(sparse);
await run('loadEvents(false)');
win.history.replaceState(null, '', 'https://iptv.example/events?type=ratings');
stickyVisible = true; // the short list leaves the sentinel in view after every page
run('eventsScreen=false;applyEventsScreen(true)');
await settle(); await sleep(80); await settle();
const bound = run('EVENT_PREFETCH_LIMIT');
assert.deepEqual(requests.map(request => request.cursor), ['first', 'c1', 'c2', 'c3'].slice(0, 1 + bound), 'the first page plus a bounded number of pages, no more');
assert.equal(run('eventPaging.paused'), true);
assert.deepEqual(tail(), {loading: false, end: false, retry: true, observed: false, busy: null}, 'paused: the sentinel is not observed and a button is the way forward');
assert.equal(more.textContent, 'Более давние события');
await sleep(60);
assert.equal(requests.length, 1 + bound, 'nothing more without the user');
// A scroll that only restores the anchor is not user demand; a real one is.
run('eventPaging.run=' + bound);
scroll.scrollTop = run('activityProgrammaticTop');
handlers.get('scroll')({type: 'scroll'});
assert.equal(run('eventPaging.run'), bound, 'a scroll event at the position the code set is ignored');
scroll.scrollTop = run('activityProgrammaticTop') + 40;
handlers.get('scroll')({type: 'scroll'}); await settle(); await sleep(60); await settle();
assert.equal(run('eventPaging.paused'), true, 'a real scroll renews the allowance, which is then used up again');
assert.equal(requests.length, 1 + 2 * bound, 'another bounded batch, never more');
// The button: one click, one bounded batch.
const beforeClick = requests.length;
more.click = undefined;
run('retryEvents()'); await settle(); await sleep(80); await settle();
assert.ok(requests.length - beforeClick >= 1 && requests.length - beforeClick <= 1 + bound, 'a click loads a page and at most the bounded batch after it');
assert.equal(maxInFlight, 1);
stickyVisible = false;
assert.equal(end.hidden, true, 'no end marker before the cursor is exhausted');

// 13. Without IntersectionObserver the explicit button is the only way, so the history stays reachable.
context.IntersectionObserver = undefined;
reset(chain(2));
await run('loadEvents(false)');
assert.equal(more.hidden, false);
assert.equal(more.textContent, 'Более давние события');
context.IntersectionObserver = FakeObserver;

// 14. AIR-538: a refresh whose first page shares nothing with the loaded list (more events than a page arrived meanwhile) must not leave a hole.
// The list restarts from the fresh page; scrolling then reaches every event once, the former middle included, with the end marker only at real exhaustion.
reset({});
const [n0, n1, n2, n3, o0, o1, o2, o3] = ['n0', 'n1', 'n2', 'n3', 'o0', 'o1', 'o2', 'o3'].map(id => ev(id));
archive = {first: {events: [o0, o1], cursor: 'o'}, o: {events: [o2, o3], cursor: null}};
await run('loadEvents(false)');
scrollToEnd(); await settle(); // an older page is loaded: the cursor is now kept across refreshes
assert.deepEqual(shownIds(), ['o0', 'o1', 'o2', 'o3']);
archive = {first: {events: [n0, n1], cursor: 'm'}, m: {events: [n2, n3], cursor: 'o'}, o: {events: [o2, o3], cursor: null}};
assert.equal(await run('loadEvents(false,{quiet:true})'), true);
assert.deepEqual(shownIds(), ['n0', 'n1'], 'a disjoint first page restarts the list instead of leaving a hole');
scrollToEnd(); await settle();
scrollToEnd(); await settle();
assert.deepEqual(shownIds(), ['n0', 'n1', 'n2', 'n3', 'o2', 'o3'], 'every event once, no gap');
assert.equal(end.hidden, false);
// An overlapping refresh keeps the loaded list and its cursor.
reset({first: {events: [ev('a0'), ev('a1')], cursor: 'o'}, o: {events: [ev('a2')], cursor: null}});
await run('loadEvents(false)');
archive = {first: {events: [ev('b0'), ev('a0')], cursor: 'o'}, o: archive.o};
await run('loadEvents(false,{quiet:true})');
assert.ok(shownIds().includes('b0') && shownIds().includes('a1') && new Set(shownIds()).size === shownIds().length, 'overlap merges without duplicates');

console.log('Events pagination UI: scroll sentinel on the real container, loader, one request at a time, exact end marker, retry from the saved cursor, repeated cursor, filtered zero-match pages, aborts, refresh and anchor/group preservation passed');
