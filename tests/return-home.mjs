// AIR-380: one «На главную» link and one validated return contract for the film screen, the events screen and the admin pages.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const helperSource = fs.readFileSync('public/return-home.js', 'utf8');
const helperContext = vm.createContext({URL, URLSearchParams});
vm.runInContext(helperSource, helperContext);
const R = vm.runInContext('ReturnHome', helperContext);

// 1. The target: only the canonical internal home is accepted.
{
  const valid = ['/', '/?q=1', '/?q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD&sort=relevance#films', '/#top', '/?a=&b=&a=2'];
  for (const value of valid) assert.equal(R.parseTarget(value), value, value);
  const invalid = ['', null, undefined, 42, {}, '//evil.example/', '//evil.example/?x=/', '/\\evil.example', '\\\\evil.example', 'https://evil.example/', 'http://x/', 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', '/admin', '/admin?x=1', '/film/heat', '/events', '/index.html', 'film/heat', '?q=1', '/?a=b\nc', '/?a\u0000', '/\t/', '/' + 'a'.repeat(2100)];
  for (const value of invalid) assert.equal(R.parseTarget(value), null, JSON.stringify(value));
  assert.equal(R.parseTarget('/%2e%2e/'), '/', 'a dot segment that resolves to the home is the home');
}

// 2. Roundtrip: Cyrillic, duplicated keys, empty values, nested encoding, plus signs and a hash survive one trip through a URL.
{
  const targets = [
    '/?q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD',
    '/?genre=%D0%94%D1%80%D0%B0%D0%BC%D0%B0&genre=%D0%9A%D0%BE%D0%BC%D0%B5%D0%B4%D0%B8%D1%8F&genre=%D0%94%D1%80%D0%B0%D0%BC%D0%B0',
    '/?q=&sort=&from=1900',
    '/?q=a%26b%3Dc%2Fd%3F%23e&x=%2525',
    '/?q=a+b&r=1%2B1',
    '/?q=1#section-2',
    '/',
  ];
  for (const target of targets) {
    for (const base of ['/film/heat-1995', '/events', '/admin', '/admin?q=x&kind=film&id=film%3Aa', '/admin/limb?subsystem=metadata#h']) {
      const href = R.withReturn(base, target);
      const search = href.includes('?') ? href.slice(href.indexOf('?'), href.includes('#') && href.indexOf('#') > href.indexOf('?') ? href.indexOf('#') : undefined) : '';
      assert.equal(R.fromSearch(search), target, base + ' carries ' + target);
      if (target === '/') assert.equal(href, base, 'the canonical home needs no parameter');
    }
  }
  assert.equal(R.withReturn('/film/x', '/?q=1'), '/film/x?return=%2F%3Fq%3D1');
  assert.equal(R.withReturn('/admin?q=1#h', '/?q=1'), '/admin?q=1&return=%2F%3Fq%3D1#h', 'the other parameters and the hash are kept');
  assert.equal(R.withReturn('/admin?return=%2F%3Fold%3D1&q=1', '/?new=1'), '/admin?q=1&return=%2F%3Fnew%3D1', 'an old target is replaced, never stacked');
  assert.equal(R.withReturn('/admin?return=%2F%3Fold%3D1', '/'), '/admin', 'back to the canonical home removes the parameter');
  assert.equal(R.withReturn('/film/x', '//evil.example/'), '/film/x', 'an invalid target is never written into a URL');
  assert.equal(R.stripReturn('/a?return=1&b=2&return=3&c'), '/a?b=2&c');
}

// 3. A missing, malformed, external or duplicated parameter.
{
  assert.equal(R.fromSearch(''), '/');
  assert.equal(R.fromSearch('?q=1'), '/', 'no context: the canonical home');
  assert.equal(R.fromSearch('?return='), '/');
  assert.equal(R.fromSearch('?return=%2F%2Fevil.example%2F'), '/', 'scheme-relative');
  assert.equal(R.fromSearch('?return=https%3A%2F%2Fevil.example%2F'), '/', 'external');
  assert.equal(R.fromSearch('?return=javascript%3Aalert(1)'), '/', 'javascript:');
  assert.equal(R.fromSearch('?return=%2Fadmin%3Fa%3D1'), '/', 'not the home');
  assert.equal(R.fromSearch('?return=%E0%A4%A'), '/', 'a broken percent sequence');
  assert.equal(R.fromSearch('?return=%2F%2Fevil.example%2F&return=%2F%3Fq%3D1'), '/?q=1', 'the first valid target wins');
  assert.equal(R.fromSearch(undefined), '/');
}

// 4. The one link: the same markup everywhere, escaped.
{
  assert.equal(R.linkHtml('/?q=1'), '<a class="return-home" data-return-home href="/?q=1">На главную</a>');
  assert.equal(R.linkHtml('//evil.example/'), '<a class="return-home" data-return-home href="/">На главную</a>');
  const hostile = R.linkHtml('/?a="><script>x</script>');
  assert.doesNotMatch(hostile, /<script/, 'no markup can be injected through the target');
  assert.equal((hostile.match(/<a /g) || []).length, 1);
  assert.doesNotMatch(hostile.match(/href="([^"]*)"/)[1], /[<>"']/, 'the attribute value carries no raw delimiter');
  assert.equal(R.LABEL, 'На главную');
}

// 5. decorate: idempotent, remembers each carrying link's own base.
{
  const makeLink = (href, extra = {}) => {const link = {attrs: {href}, dataset: {}, ...extra}; link.getAttribute = name => link.attrs[name] ?? null; link.setAttribute = (name, value) => {link.attrs[name] = value;}; return link;};
  const home = makeLink('/', {kind: 'home'}), events = makeLink('/events'), admin = makeLink('/admin?q=x'), other = makeLink('/somewhere');
  const root = {querySelectorAll: selector => selector === '[data-return-home]' ? [home] : selector === '[data-return-carry]' ? [events, admin] : []};
  R.decorate(root, '/?q=1');
  assert.equal(home.attrs.href, '/?q=1');
  assert.equal(events.attrs.href, '/events?return=%2F%3Fq%3D1');
  assert.equal(admin.attrs.href, '/admin?q=x&return=%2F%3Fq%3D1');
  R.decorate(root, '/?q=1');
  assert.equal(events.attrs.href, '/events?return=%2F%3Fq%3D1', 'a second call does not stack parameters');
  R.decorate(root, '/?q=2&q=3');
  assert.equal(events.attrs.href, '/events?return=%2F%3Fq%3D2%26q%3D3', 'a new target replaces the old one');
  R.decorate(root, '//evil.example/');
  assert.equal(home.attrs.href, '/', 'an invalid target is the canonical home');
  assert.equal(events.attrs.href, '/events');
  assert.equal(other.attrs.href, '/somewhere', 'a link that does not opt in is not touched');
  const init = R.init({querySelectorAll: root.querySelectorAll}, {search: '?return=%2F%3Fz%3D1'});
  assert.equal(init, '/?z=1');
  assert.equal(admin.attrs.href, '/admin?q=x&return=%2F%3Fz%3D1');
}

// 6. Markup: the same link in the same place on every page, no competing old buttons, nav and footer links carry the target.
{
  const pages = {'public/admin.html': 'admin', 'public/admin-letterboxd.html': 'letterboxd', 'public/admin-limbo.html': 'limbo', 'public/admin-posters.html': 'posters', 'public/admin-actions.html': 'actions'};
  const index = fs.readFileSync('public/index.html', 'utf8');
  const linkMarkup = '<a class="return-home" data-return-home href="/">На главную</a>';
  for (const [file, name] of Object.entries(pages)) {
    const html = fs.readFileSync(file, 'utf8');
    assert.equal((html.match(/data-return-home/g) || []).length, 1, name + ': exactly one return link');
    assert.ok(html.includes(linkMarkup), name + ': the shared markup');
    const main = html.slice(html.indexOf('<main class="admin-shell"'));
    assert.match(main, /^<main class="admin-shell"[^>]*>\s*<a class="return-home" data-return-home href="\/">На главную<\/a>/, name + ': the first thing in the standard content container, under the header');
    assert.ok(html.indexOf('</header>') < html.indexOf('data-return-home'), name + ': below the shared header');
    assert.doesNotMatch(html, /К программе|К списку|К фильмам/, name + ': no competing old button');
    assert.ok(html.indexOf('src="/return-home.js"') > 0 && html.indexOf('src="/return-home.js"') < html.search(/src="\/admin[^"]*\.js"/), name + ': the helper loads before the page script');
  }
  for (const file of ['public/admin.html', 'public/admin-letterboxd.html', 'public/admin-limbo.html', 'public/admin-posters.html']) {
    const nav = fs.readFileSync(file, 'utf8').match(/<nav class="admin-views"[\s\S]*?<\/nav>/)[0];
    const anchors = nav.match(/<a [^>]*>/g);
    assert.equal(anchors.length, 5, file);
    for (const anchor of anchors) assert.match(anchor, /data-return-carry/, file + ': ' + anchor + ' keeps the target through the sections');
  }
  assert.match(fs.readFileSync('public/admin-actions.html', 'utf8'), /<a class="admin-home" href="\/admin" data-return-carry>К данным<\/a>/);
  assert.equal((index.match(/data-return-home/g) || []).length, 1);
  assert.match(index, /<main>\s*<a class="return-home" id="return-home" data-return-home href="\/" hidden>На главную<\/a>/, 'the programme page: first in main, hidden until a film or events screen is shown');
  assert.doesNotMatch(index, /id="film-back"|id="activity-back"|К списку|К фильмам|К программе/);
  assert.ok(index.indexOf('src="/return-home.js"') < index.indexOf('src="/app.js"'));
  const footerJs = fs.readFileSync('public/status-footer.js', 'utf8');
  for (const source of [index, footerJs]) {
    for (const id of ['status-events-link', 'status-integrations-events']) assert.match(source, new RegExp('id="' + id + '" href="/events" data-return-carry'), id);
    assert.match(source, /class="footer-admin-link" href="\/admin" data-return-carry/);
  }
  assert.match(footerJs, /ReturnHome\.init\(\)/, 'the admin footer is decorated once it is mounted');
  const css = fs.readFileSync('public/styles.css', 'utf8');
  assert.match(css, /\.return-home\{[^}]*display:inline-flex[^}]*\}/);
  assert.match(css, /\.return-home\[hidden\]\{display:none\}/);
  assert.doesNotMatch(css, /#film-back/);
  assert.match(fs.readFileSync('build.mjs', 'utf8'), /assets\['\/return-home\.js'\]=\{body:fs\.readFileSync\('public\/return-home\.js'/, 'the Worker serves the helper');
}

// 7. The admin pages keep the target in their own URL writes.
{
  const pull = (file, name) => {
    const source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name);
    let depth = 0, end = start;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) {end = i + 1; break;}
    }
    return source.slice(start, end);
  };
  const target = '/?q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD&genre=a&genre=b';
  const context = vm.createContext({URL, URLSearchParams, window: {location: {search: '?q=zzz&return=' + encodeURIComponent(target)}}});
  vm.runInContext(helperSource + '\n' + pull('public/admin.js', 'adminUrl') + '\n' + pull('public/admin-limbo.js', 'limboUrl'), context);
  const catalogue = vm.runInContext("adminUrl({view:'catalog',q:'жара',kind:'film',id:'film:a'})", context);
  assert.equal(catalogue.split('?')[0], '/admin');
  assert.equal(R.fromSearch(catalogue.slice(catalogue.indexOf('?'))), target, 'the catalogue URL keeps the target');
  assert.match(catalogue, /kind=film&id=film%3Aa/, 'its own state is intact');
  const health = vm.runInContext("adminUrl({view:'health'})", context);
  assert.equal(health.split('?')[0], '/admin/health');
  assert.equal(R.fromSearch(health.slice(health.indexOf('?'))), target);
  const limbo = vm.runInContext("limboUrl({kind:'',subsystem:'metadata',age:'',attention:'now',causes:null})", context);
  assert.equal(limbo.split('?')[0], '/admin/limb');
  assert.equal(R.fromSearch(limbo.slice(limbo.indexOf('?'))), target, 'the limbo URL keeps the target');
  assert.match(limbo, /subsystem=metadata/);
  // Without a target nothing is added; a hostile one is dropped.
  context.window.location.search = '?q=1';
  assert.equal(vm.runInContext("adminUrl({view:'catalog'})", context), '/admin');
  context.window.location.search = '?return=' + encodeURIComponent('//evil.example/');
  assert.equal(vm.runInContext("adminUrl({view:'catalog'})", context), '/admin', 'an external target is never carried');
}

// 8. The programme page: home → film / events → nested screens → home.
const classes = new Set();
const nodes = new Map();
const focused = [];
function element(selector) {
  if (!nodes.has(selector)) {
    const node = {selector, innerHTML: '', textContent: '', hidden: false, value: '', checked: false, disabled: false, dataset: {}, style: {}, attrs: new Map(),
      classList: {toggle() {}, add() {}, remove() {}, contains() {return false;}},
      setAttribute(name, value) {node.attrs.set(name, String(value));}, getAttribute(name) {return node.attrs.get(name) ?? null;}, removeAttribute(name) {node.attrs.delete(name);},
      focus() {focused.push(selector);}, addEventListener() {}, querySelector() {return null;}, querySelectorAll() {return [];}};
    nodes.set(selector, node);
  }
  return nodes.get(selector);
}
const carrying = [
  {id: 'events', href: '/events', dataset: {}}, {id: 'integrations', href: '/events', dataset: {}}, {id: 'admin', href: '/admin', dataset: {}},
].map(entry => {const link = {...entry, attrs: {href: entry.href}}; link.getAttribute = name => link.attrs[name] ?? null; link.setAttribute = (name, value) => {link.attrs[name] = value;}; return link;});
const homeLink = {attrs: {href: '/'}, dataset: {}, getAttribute(name) {return this.attrs[name] ?? null;}, setAttribute(name, value) {this.attrs[name] = value;}};
const document = {
  hidden: false, addEventListener() {}, removeEventListener() {},
  documentElement: {classList: {toggle(name, on) {on ? classes.add(name) : classes.delete(name);}}},
  querySelector: element,
  querySelectorAll: selector => selector === '[data-return-home]' ? [homeLink] : selector === '[data-return-carry]' ? carrying : [],
};
const stack = [{href: 'https://iptv.example/?q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD&genre=a&genre=b&empty=&nested=x%2526y#films', state: null}];
let index = 0;
const window = {
  scrollY: 0, scrollTo(_x, y) {window.scrollY = y;}, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({matches: false}), innerWidth: 1280, innerHeight: 800,
  location: {href: stack[0].href},
  history: {
    get state() {return stack[index].state;},
    pushState(state, _t, url) {stack.splice(index + 1); stack.push({href: new URL(url, window.location.href).href, state}); index++; window.location.href = stack[index].href;},
    replaceState(state, _t, url) {stack[index] = {href: new URL(url, window.location.href).href, state}; window.location.href = stack[index].href;},
    back() {if (index === 0) return; index--; window.location.href = stack[index].href; run('onHistoryNavigation()');},
    forward() {if (index >= stack.length - 1) return; index++; window.location.href = stack[index].href; run('onHistoryNavigation()');},
  },
};
const context = vm.createContext({Date, Intl, URL, URLSearchParams, Set, Map, JSON, document, window, console,
  sessionStorage: {getItem: () => null, setItem() {}}, localStorage: {getItem: () => null, setItem() {}}});
vm.runInContext(helperSource + '\n' + fs.readFileSync('public/app.js', 'utf8').replace(/init\(\);\s*$/, ''), context);
const run = code => vm.runInContext(code, context);
const where = () => {const url = new URL(window.location.href); return url.pathname + url.search + url.hash;};
const homeHref = stack[0].href;
const homeTargetValue = '/?q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD&genre=a&genre=b&empty=&nested=x%2526y#films';
run("films=[{id:'f1',title:'Один',original:'One',year:2000,runtime:100,genres:['Драма'],shows:[]},{id:'f2',title:'Два',original:'Two',year:2001,runtime:100,genres:['Драма'],shows:[]}];report={people:{directors:[],actors:[]},updatedAt:'2026-10-24T12:00:00Z',window:{from:0,to:1}};enrichment={films:{}};urlReady=true");

assert.equal(run('homeTarget()'), homeTargetValue, 'on the programme the target is the page itself, with its query and hash');
run('refreshReturnLinks()');
assert.equal(carrying[0].attrs.href, '/events?return=' + encodeURIComponent(homeTargetValue), 'the footer events link carries the current programme state');
assert.equal(carrying[2].attrs.href, '/admin?return=' + encodeURIComponent(homeTargetValue), 'so does the admin link');

// home → film: the target is in the film's URL and in its history entry; the link is shown and points home.
run("openFilm('f1')");
assert.equal(new URL(window.location.href).pathname, '/film/f1');
assert.equal(run('ReturnHome.fromSearch(new URL(window.location.href).search)'), homeTargetValue);
assert.equal(run('window.history.state.iptvHome'), homeTargetValue);
assert.equal(element('#return-home').hidden, false, 'the shared link is shown on the film screen');
assert.equal(homeLink.attrs.href, homeTargetValue, 'and points at the exact programme state');
assert.equal(carrying[0].attrs.href, '/events?return=' + encodeURIComponent(homeTargetValue), 'the footer links keep carrying it on the film screen');

// film → events keeps the same target (it is the film's, not the film's own URL).
run("openEventsScreen(document.querySelector('#status-events-link'))");
assert.equal(new URL(window.location.href).pathname, '/events');
assert.equal(run('ReturnHome.fromSearch(new URL(window.location.href).search)'), homeTargetValue, 'film → events: the original programme state, not the film page');
assert.equal(run('window.history.state.iptvHome'), null, 'an entry opened from another screen does not claim to follow the programme directly');
assert.equal(homeLink.attrs.href, homeTargetValue);

// events → film keeps it too.
run("openFilm('f2')");
assert.equal(new URL(window.location.href).pathname, '/film/f2');
assert.equal(run('ReturnHome.fromSearch(new URL(window.location.href).search)'), homeTargetValue, 'events → film: still the original programme state');
assert.equal(run('window.history.state.iptvHome'), null);

// nested navigation then «На главная»: a plain navigation to the exact programme state (Back would only go one screen back).
const depth = stack.length;
run('returnHome()');
assert.equal(stack.length, depth + 1, 'from a nested screen the way home is a new entry, not a single Back');
assert.equal(where(), homeTargetValue, 'the exact pathname, query (Cyrillic, duplicated keys, empty value, nested encoding) and hash');
assert.equal(classes.has('film-screen') || classes.has('events-screen'), false);
assert.equal(element('#return-home').hidden, true, 'the link is hidden on the programme itself');

// A screen opened straight from the programme returns by Back: same entry count, exact URL.
window.history.replaceState(null, '', homeHref);
run("openFilm('f1')");
const direct = stack.length;
run('returnHome()');
assert.equal(index, direct - 2, 'opened from the programme: Back is the way home');
assert.equal(window.location.href, homeHref);
assert.equal(stack.length, direct, 'no extra entry');

// Reload on a screen with a target keeps it; a bookmark without one, and hostile ones, go to the canonical home.
window.history.replaceState(null, '', 'https://iptv.example/film/f1?return=' + encodeURIComponent(homeTargetValue));
run("filmScreen='f1'");
run('returnHome()');
assert.equal(where(), homeTargetValue, 'a reload keeps the target because it is in the URL');
for (const hostile of ['', '?return=%2F%2Fevil.example%2F', '?return=https%3A%2F%2Fevil.example%2F', '?return=javascript%3Aalert(1)', '?return=%2Fadmin', '?return=%2F%3Fq%3D1%00']) {
  window.history.replaceState(null, '', 'https://iptv.example/film/f1' + hostile);
  run("filmScreen='f1'");
  run('returnHome()');
  assert.equal(new URL(window.location.href).origin, 'https://iptv.example', hostile + ': never leaves the site');
  assert.equal(where(), '/', hostile + ': the canonical home with no stale state');
}
// A film card is a real link: before a new-tab open or a copy it takes the programme's current state as its target.
assert.equal(run("ReturnHome.withReturn(filmHref('f1'), '"+homeTargetValue+"')"), '/film/f1?return=' + encodeURIComponent(homeTargetValue));
assert.match(fs.readFileSync('public/app.js', 'utf8'), /for\(const type of \['pointerdown','focusin','contextmenu'\]\)\$\('#movies'\)\.addEventListener\(type,refreshFilmLink\)/, 'the card refreshes its href before a new-tab open or a copy');

console.log('Return home: validated internal target only, exact roundtrip of encoded and duplicated query values, one link on film, events and every admin page, target kept through nested screens, reload, the admin URL writes and the footer links, canonical home without a target');
