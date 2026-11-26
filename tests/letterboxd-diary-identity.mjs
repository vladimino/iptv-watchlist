// AIR-489 / ADR 0166 (option A): the bounded same-run Film bridge of a rated-only Diary id. Synthetic pages, a stub D1 canonical writer and an in-memory
// ratings store; nothing here calls Letterboxd, TMDB or a production store. Fixtures mirror `vMEO` (3.5) and `Aj8u` (4.0) as ids only: their movie is NOT assumed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import {installRawViewProjection} from './letterboxd-view-double.mjs';

const records = new Map(), etags = new Map(); let rev = 0; const fail = {view: 0, identity: null};
const bucket = {
  async get(key) {return records.has(key) ? {etag: etags.get(key), json: async () => structuredClone(records.get(key))} : null;},
  async put(key, value, options = {}) {
    if (fail.view && key === 'enrichment/view-index.json') {fail.view--; throw new Error('projection unavailable');}
    if (fail.identity !== null && key === 'letterboxd/facts/scans/diary-identity.json') {if (fail.identity <= 0) throw new Error('pending write lost'); fail.identity--;}
    const c = options.onlyIf;
    if (c?.etagDoesNotMatch === '*' && records.has(key) || c?.etagMatches && c.etagMatches !== etags.get(key)) return null;
    records.set(key, JSON.parse(value)); etags.set(key, String(++rev)); return {etag: etags.get(key)};
  },
  async list() {return {objects: [], truncated: false};},
};
const net = {calls: [], handler: async () => {throw new Error('unexpected request');}};
const headersOf = map => ({get: key => map[String(key).toLowerCase()] ?? null});
const http = (status, body, headers = {}) => ({status, ok: status < 300, headers: headersOf(headers), async text() {return body;}});
const canonical = {gate: {mode: 'd1', state: 'open', generation: 2}, bridge: {}, applied: [], failWith: null, result: null, bridgeThrows: null};
const applied = {state: 'complete', applied: 1, failed: 0, unknown: 0, preflightFailed: 0, deferred: 0, refused: 0, units: [{kind: 'film_admission', state: 'applied'}]};
const ctx = vm.createContext({Response, Headers, URL, Date, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, AbortSignal, crypto: webcrypto, console: {...console, log: () => {}},
  fetch: async (url, init) => {net.calls.push(String(url)); return net.handler(String(url), init);}});
ctx.CanonicalCatalogReader = {
  catalogReaderGate: async () => canonical.gate,
  catalogFilmIdentityBridge: async (env, lid) => {if (canonical.bridgeThrows) throw Object.assign(new Error(canonical.bridgeThrows), {code: canonical.bridgeThrows}); return canonical.bridge[lid] || {state: 'absent'};},
  catalogTitlesFromD1: async () => ({}),
};
ctx.CanonicalRatedAdmission = {
  applyRatedAdmissionRetention: async (env, input) => {if (canonical.failWith) throw Object.assign(new Error(canonical.failWith), {code: canonical.failWith}); canonical.applied.push(input); return canonical.result || applied;},
  assertRatedAdmissionAccepted: out => out,
};
const run = file => vm.runInContext(fs.readFileSync(file, 'utf8').replace(/^export default/m, 'globalThis.x='), ctx);
run('src/domain/tmdb-tv-identity.js'); run('src/sources.js');
vm.runInContext(scoped('src/upstream-cooldown.js', 'UpstreamCooldown'), ctx); // AIR-604: in scope before any call, as in the bundle
vm.runInContext(scoped('src/letterboxd-match.js', 'LetterboxdMatch') + '\n' + scopedReplacing('src/letterboxd-identity.js', 'LetterboxdIdentity', 'const normTitle=LetterboxdMatch.normTitle;\n') + '\n' + scoped('src/domain/letterboxd-rated-admission.js', 'LetterboxdRatedAdmission'), ctx);
for (const file of ['src/letterboxd-facts.js', 'src/letterboxd-rated-candidates.js', process.env.DIARY_IDENTITY_SRC || 'src/letterboxd-diary-identity.js']) run(file);
installRawViewProjection(ctx); // AIR-558
const Facts = vm.runInContext('LetterboxdFacts', ctx), Identity = vm.runInContext('LetterboxdDiaryIdentity', ctx);
const env = {BUCKET: bucket, TMDB_API_READ_ACCESS_TOKEN: 'fixture-token'};

const filmPage = ({lid, slug, title, year, tmdbIds = ['900001'], type = 'movie', shortlink = true, canonicalSlug = slug}) => {
  const ld = JSON.stringify({name: title, releasedEvent: [{'@type': 'PublicationEvent', startDate: String(year)}]});
  return '<html><head><link rel="canonical" href="https://letterboxd.com/film/' + canonicalSlug + '/">' + (shortlink ? '<link rel="shortlink" href="https://boxd.it/' + lid + '">' : '')
    + '<meta property="og:title" content="' + title + ' (' + year + ')"><script type="application/ld+json">' + ld + '</script></head><body class="film" data-tmdb-type="' + type + '" '
    + tmdbIds.map(id => 'data-tmdb-id="' + id + '"').join(' ') + '></body></html>';
};
const detail = (tmdb, title, year) => JSON.stringify({id: Number(tmdb), title, original_title: title, release_date: year + '-05-01'});
// site: lid -> {slug, page html, status}; tmdb: id -> http response
const site = new Map(), tmdbDocs = new Map(), slow = {on: null, left: 120000};
net.handler = async url => {
  const boxd = /^https:\/\/boxd\.it\/([A-Za-z0-9]+)$/.exec(url);
  if (boxd) {if (slow.on === 'redirect') slow.left = 10000; const item = site.get(boxd[1]); if (!item) return http(404, ''); if (item.status) return http(item.status, '', item.headers || {}); return http(301, '', {location: 'https://letterboxd.com/film/' + item.landing + '/'});}
  const film = /^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/$/.exec(url);
  if (film) {const item = [...site.values()].find(entry => entry.landing === film[1]); return item ? http(200, item.html) : http(404, '');}
  const tm = /api\.themoviedb\.org\/3\/movie\/(\d+)/.exec(url);
  if (tm) {if (slow.on === 'detail') slow.left = 14000; const doc = tmdbDocs.get(tm[1]); return doc ? (typeof doc === 'function' ? doc() : http(200, doc)) : http(404, '');}
  throw new Error('unexpected ' + url);
};
const reset = () => {fail.identity = null; records.clear(); etags.clear(); site.clear(); tmdbDocs.clear(); net.calls.length = 0; canonical.bridge = {}; canonical.applied.length = 0; canonical.failWith = null; canonical.result = null; canonical.bridgeThrows = null; slow.on = null; canonical.gate = {mode: 'd1', state: 'open', generation: 2};};
const seed = async (lid, rating, date = '2026-11-15') => Facts.applyDiaryEvidence(env, [{lid, watchedDate: date, rating, ratingState: 'rated', sourceRef: 'diary:viewing:1'}]);
const add = (lid, slug, tmdb, title, year, extra = {}) => {site.set(lid, {landing: slug, html: filmPage({lid, slug, title, year, tmdbIds: [tmdb], ...extra})}); tmdbDocs.set(tmdb, detail(tmdb, title, year));};
const NOW = Date.parse('2026-11-17T16:01:00.000Z');
const AFTER_RESERVATION = NOW + 6 * 60000; // a step that was cut off leaves its check reservation, which expires after five minutes
const opts = (extra = {}) => ({clock: () => NOW, remaining: () => 120000, fetchImpl: ctx.fetch, ...extra});
const items = (...lids) => lids.map(([lid, slug]) => ({lid, slug}));
const recordOf = lid => records.get('letterboxd/facts/films/lb-' + lid + '.json');
const pending = () => records.get(Facts.DIARY_IDENTITY_KEY)?.films || {};
const putDoc = films => {records.set(Facts.DIARY_IDENTITY_KEY, {schemaVersion: 1, films}); etags.set(Facts.DIARY_IDENTITY_KEY, String(++rev));};

// 1. verified: facts kept, Film admitted through the existing writer, movie id linked, label returned, receipt marked, idempotent.
reset(); await seed('vMEO', 3.5); add('vMEO', 'fixture-alpha-2023', '900001', 'Fixture Alpha', 2023);
let out = await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts());
assert.equal(out.counts.verified, 1);
assert.deepEqual({...out.labels.get('vMEO')}, {title: 'Fixture Alpha', year: 2023, tmdb: '900001'});
assert.equal(recordOf('vMEO').links.tmdb, '900001'); assert.equal(recordOf('vMEO').rating.value, 3.5); assert.equal(recordOf('vMEO').watched.value, true);
assert.equal(recordOf('vMEO').ratingHistory[0].kind, 'first_observed');
const view = records.get('enrichment/view-index.json'); assert.equal(view.vMEO.watched, true); assert.equal(view.tmdb_900001.watched, true); assert.equal(view.tmdb_900001.actualRating, 3.5);
assert.equal(canonical.applied.length, 1); assert.equal(canonical.applied[0].admissions[0].receiptKey, 'tmdb_900001');
const receipt = records.get('letterboxd/admissions/verified-films.json').films.tmdb_900001;
assert.equal(receipt.sourceCode, 'vMEO'); assert.equal(receipt.identity, 'diary_page'); assert.match(receipt.archiveSha256, /^[0-9a-f]{64}$/);
assert.deepEqual(Object.keys(pending()), []);
const before = net.calls.length; out = await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts());
assert.equal(net.calls.length, before, 'a bridged id is not requested again'); assert.equal(out.counts.considered, 0); assert.equal(canonical.applied.length, 1);

// 2. 403 is a pending with a retry time, not a refusal; no request inside the backoff; a later run retries; the rating is untouched.
reset(); await seed('Aj8u', 4); site.set('Aj8u', {status: 403});
out = await Identity.resolve(env, items(['Aj8u', 'fixture-beta-2024']), opts());
assert.equal(out.counts.pending, 1); assert.equal(pending().Aj8u.reason, 'forbidden'); assert.equal(pending().Aj8u.attempts, 0, 'AIR-599: a 403 consumes no attempt'); assert.equal(pending().Aj8u.streak, 1); assert.equal(pending().Aj8u.class, 'transport');
assert.ok(Date.parse(pending().Aj8u.nextAttemptAt) > NOW); assert.equal(recordOf('Aj8u').rating.value, 4); assert.equal(recordOf('Aj8u').links.tmdb, null);
let calls = net.calls.length; out = await Identity.resolve(env, items(['Aj8u', 'fixture-beta-2024']), opts({clock: () => NOW + 60000}));
assert.equal(net.calls.length, calls); assert.equal(out.counts.deferred, 1);
add('Aj8u', 'fixture-beta-2024', '900002', 'Fixture Beta', 2024);
out = await Identity.resolve(env, items(['Aj8u', 'fixture-beta-2024']), opts({clock: () => NOW + 3 * 3600000}));
assert.equal(out.counts.verified, 1); assert.equal(recordOf('Aj8u').links.tmdb, '900002'); assert.deepEqual(Object.keys(pending()), []);

// 3. no proof, no Film: every disagreement stays pending with its reason and admits nothing.
const refusals = [
  ['slug_mismatch', (lid) => add(lid, 'other-slug', '900010', 'Fixture Gamma', 2020), 'fixture-gamma-2020'],
  ['slug_missing', (lid) => add(lid, 'fixture-gamma-2020', '900010', 'Fixture Gamma', 2020), null],
  ['tmdb_multiple', (lid) => add(lid, 'fixture-gamma-2020', '900010', 'Fixture Gamma', 2020, {tmdbIds: ['900010', '900011']}), 'fixture-gamma-2020'],
  ['tmdb_not_movie', (lid) => add(lid, 'fixture-gamma-2020', '900010', 'Fixture Gamma', 2020, {type: 'tv'}), 'fixture-gamma-2020'],
  ['shortlink_mismatch', (lid) => {add(lid, 'fixture-gamma-2020', '900010', 'Fixture Gamma', 2020); site.get(lid).html = site.get(lid).html.replace('boxd.it/' + lid, 'boxd.it/zzzz');}, 'fixture-gamma-2020'],
  ['canonical_mismatch', (lid) => add(lid, 'fixture-gamma-2020', '900010', 'Fixture Gamma', 2020, {canonicalSlug: 'elsewhere'}), 'fixture-gamma-2020'],
  ['tmdb_missing', (lid) => {add(lid, 'fixture-gamma-2020', '900010', 'Fixture Gamma', 2020); site.get(lid).html = site.get(lid).html.replace(/data-tmdb-id="\d+"/, '');}, 'fixture-gamma-2020'],
  ['detail_title_mismatch', (lid) => {add(lid, 'fixture-gamma-2020', '900010', 'Fixture Gamma', 2020); tmdbDocs.set('900010', detail('900010', 'A Different Film', 2020));}, 'fixture-gamma-2020'],
  ['detail_year_mismatch', (lid) => {add(lid, 'fixture-gamma-2020', '900010', 'Fixture Gamma', 2020); tmdbDocs.set('900010', detail('900010', 'Fixture Gamma', 1999));}, 'fixture-gamma-2020'],
  ['tmdb_fetch_failed', (lid) => {add(lid, 'fixture-gamma-2020', '900010', 'Fixture Gamma', 2020); tmdbDocs.delete('900010');}, 'fixture-gamma-2020'],
  ['rate_limited', (lid) => site.set(lid, {status: 429}), 'fixture-gamma-2020'],
  ['challenge', (lid) => site.set(lid, {status: 403, headers: {'cf-mitigated': 'challenge'}}), 'fixture-gamma-2020'],
];
for (const [reason, arrange, slug] of refusals) {
  reset(); await seed('Gam1', 2.5); arrange('Gam1');
  out = await Identity.resolve(env, items(['Gam1', slug]), opts());
  const expected = reason === 'tmdb_fetch_failed' ? 'not_found' : reason; // AIR-599: a TMDB 404 is `not_found` (gone)
  assert.equal(pending().Gam1?.reason, expected, reason); if (reason === 'slug_missing') assert.equal(net.calls.length, 0, 'no request without the same-row slug'); assert.equal(canonical.applied.length, 0, reason + ' admits nothing');
  assert.equal(recordOf('Gam1').links.tmdb, null, reason); assert.equal(recordOf('Gam1').rating.value, 2.5, reason);
  assert.equal(records.has('letterboxd/admissions/verified-films.json'), false, reason + ' writes no receipt');
}

// 4. an existing trusted D1 bridge is consumed, not re-proved: no request, no receipt, no admission.
reset(); await seed('Brg1', 3); canonical.bridge.Brg1 = {state: 'ok', filmId: 'film:tmdb:900020', tmdb: '900020', lid: 'Brg1'};
out = await Identity.resolve(env, items(['Brg1', 'fixture-brg-2019']), opts());
assert.equal(out.counts.bridged, 1); assert.equal(net.calls.length, 0); assert.equal(canonical.applied.length, 0); assert.equal(recordOf('Brg1').links.tmdb, '900020');
// a conflicting or retired bridge is a visible pending and is never overridden by the source.
for (const state of ['conflict', 'retired']) {reset(); await seed('Brg2', 3); canonical.bridge.Brg2 = {state}; out = await Identity.resolve(env, items(['Brg2', 'x']), opts()); assert.equal(pending().Brg2.reason, 'bridge_' + state); assert.equal(net.calls.length, 0);}

// 5. two ids, one movie: the second link is an alias_conflict, never a merge; both records keep their facts.
reset(); await seed('Two1', 3); await seed('Two2', 4); add('Two1', 'fixture-two-2022', '900030', 'Fixture Two', 2022); site.set('Two2', {landing: 'fixture-two-dup-2022', html: filmPage({lid: 'Two2', slug: 'fixture-two-dup-2022', title: 'Fixture Two', year: 2022, tmdbIds: ['900030']})});
await Identity.resolve(env, items(['Two1', 'fixture-two-2022']), opts()); out = await Identity.resolve(env, items(['Two2', 'fixture-two-dup-2022']), opts());
assert.equal(recordOf('Two1').links.tmdb, '900030'); assert.equal(recordOf('Two2').links.tmdb, null); assert.equal(pending().Two2.reason, 'admission_conflict', 'a second code for an admitted movie is refused at the receipt'); assert.equal(recordOf('Two2').rating.value, 4);
// a movie id already linked to another record (an owner mark): the Film is verified and admitted, the facts are never merged.
reset(); await seed('Lnk1', 3); await Facts.linkTmdbOnly(env, '900031'); add('Lnk1', 'fixture-lnk-2022', '900031', 'Fixture Lnk', 2022);
await Identity.resolve(env, items(['Lnk1', 'fixture-lnk-2022']), opts()); assert.equal(pending().Lnk1.reason, 'link_conflict'); assert.equal(recordOf('Lnk1').links.tmdb, null); assert.equal(recordOf('Lnk1').rating.value, 3);

// 6. the receipt is kept when an entry already holds the movie, a code bound to another movie is a conflict.
reset(); await seed('Rc01', 3); records.set('letterboxd/admissions/verified-films.json', {schemaVersion: 1, films: {tmdb_900040: {tmdb: '900040', sourceCode: 'Rc01', archiveSha256: 'a'.repeat(64), title: 'Elsewhere', year: 2000, verifiedAt: '2026-11-01T00:00:00.000Z'}}});
add('Rc01', 'fixture-rc-2021', '900041', 'Fixture Rc', 2021); out = await Identity.resolve(env, items(['Rc01', 'fixture-rc-2021']), opts());
assert.equal(pending().Rc01.reason, 'admission_conflict'); assert.equal(canonical.applied.length, 0);

// 7. the canonical writer's refusal or a held authority is a pending, never an exception into the run.
reset(); await seed('Hld1', 3); add('Hld1', 'fixture-hld-2018', '900050', 'Fixture Hld', 2018); canonical.failWith = 'film_person_held';
out = await Identity.resolve(env, items(['Hld1', 'fixture-hld-2018']), opts()); assert.equal(out.counts.pending, 1); assert.equal(recordOf('Hld1').links.tmdb, null);
reset(); await seed('Nop1', 3); canonical.gate = {mode: 'existing', state: 'prepared', generation: 2}; out = await Identity.resolve(env, items(['Nop1', 'x']), opts());
assert.equal(net.calls.length, 0); assert.equal(out.counts.deferred, 1); assert.equal(pending().Nop1.reason, 'deferred', 'a not-open authority defers, it does not drop');

// 8. budget: a short lease defers, a transport stop ends the step's requests, the step cap is three.
reset(); for (const lid of ['Bud1', 'Bud2', 'Bud3', 'Bud4', 'Bud5']) {await seed(lid, 3); site.set(lid, {status: 404});}
out = await Identity.resolve(env, items(...['Bud1', 'Bud2', 'Bud3', 'Bud4', 'Bud5'].map(lid => [lid, 'x'])), opts({remaining: () => 1000}));
assert.equal(net.calls.length, 0); assert.equal(out.counts.deferred, 5); assert.equal(Object.keys(pending()).length, 5, 'deferred ids are kept, not dropped');
out = await Identity.resolve(env, items(...['Bud1', 'Bud2', 'Bud3', 'Bud4', 'Bud5'].map(lid => [lid, 'x'])), opts());
assert.equal(out.counts.deferred, 2); assert.equal(net.calls.filter(url => url.startsWith('https://boxd.it/')).length, 3);
reset(); for (const lid of ['Stp1', 'Stp2']) {await seed(lid, 3); site.set(lid, {status: 429});}
out = await Identity.resolve(env, items(['Stp1', 'x'], ['Stp2', 'x']), opts()); assert.equal(net.calls.length, 1, 'a 429 stops further requests in the step'); assert.equal(out.counts.deferred, 1);
// bounded recovery: attempts stop at MAX_ATTEMPTS.
reset(); await seed('Cap1', 3); site.set('Cap1', {status: 404}); let at = NOW;
for (let i = 0; i < Identity.MAX_ATTEMPTS + 3; i++) {await Identity.resolve(env, items(['Cap1', 'x']), opts({clock: () => at})); at += 3 * 24 * 3600000;}
assert.equal(pending().Cap1.attempts, Identity.MAX_ATTEMPTS); assert.equal(net.calls.length, Identity.MAX_ATTEMPTS);
// an id with no fact record is not bridged (nothing to attach to).
reset(); out = await Identity.resolve(env, items(['Nof1', 'x']), opts()); assert.equal(out.counts.skipped, 1); assert.equal(net.calls.length, 0);


// 10. review of PR #720, P1: the writer answering `skipped` (routing moved after the gate) or any answer without an applied unit is NOT an admission.
for (const [name, result] of [['skipped', {state: 'skipped', reason: 'film_person_route_not_open', receipt: false}], ['no unit', {state: 'complete', applied: 0, failed: 0, unknown: 0, preflightFailed: 0, deferred: 0, refused: 0, units: []}], ['failed count', {...applied, failed: 1}], ['refused', {...applied, refused: 1}], ['incomplete', {...applied, state: 'incomplete'}], ['unknown unit state', {...applied, units: [{kind: 'film_admission', state: 'unknown'}]}], ['retention unit only', {...applied, units: [{kind: 'film_retention', state: 'applied'}]}], ['null', null]]) {
  reset(); await seed('Skp1', 3); add('Skp1', 'fixture-skp-2017', '900060', 'Fixture Skp', 2017); canonical.result = result === null ? {state: undefined} : result;
  out = await Identity.resolve(env, items(['Skp1', 'fixture-skp-2017']), opts());
  assert.equal(recordOf('Skp1').links.tmdb, null, name + ': no alias without a confirmed admission'); assert.equal(out.labels.size, 0, name); assert.ok(pending().Skp1, name);
  assert.equal(records.get('enrichment/view-index.json')?.tmdb_900060, undefined, name + ': no TMDB projection');
}
reset(); await seed('Skp2', 3); add('Skp2', 'fixture-skp-2016', '900061', 'Fixture Skp2', 2016); canonical.result = {state: 'skipped', reason: 'film_person_route_not_open'};
await Identity.resolve(env, items(['Skp2', 'fixture-skp-2016']), opts()); assert.equal(pending().Skp2.reason, 'admission_skipped');
for (const state of ['applied', 'already', 'noop']) {reset(); await seed('Okk1', 3); add('Okk1', 'fixture-okk-2015', '900062', 'Fixture Okk', 2015); canonical.result = {...applied, units: [{kind: 'film_admission', state}]}; out = await Identity.resolve(env, items(['Okk1', 'fixture-okk-2015']), opts()); assert.equal(out.counts.verified, 1, state);}

// 11. review of PR #720, P1: an id that left Diary page 1 is still retried (the same-row slug is kept); an id deferred by the step cap is kept and served later.
reset(); await seed('Aj8u', 4); site.set('Aj8u', {status: 403});
await Identity.resolve(env, items(['Aj8u', 'fixture-beta-2024']), opts());
assert.equal(pending().Aj8u.slug, 'fixture-beta-2024'); add('Aj8u', 'fixture-beta-2024', '900002', 'Fixture Beta', 2024);
calls = net.calls.length; out = await Identity.resolve(env, [], opts({clock: () => NOW + 60000})); assert.equal(net.calls.length, calls, 'not due yet: no request'); assert.equal(out.counts.verified, 0);
out = await Identity.resolve(env, items(['Other', 'o']), opts({clock: () => NOW + 3 * 3600000}));
assert.equal(out.counts.verified, 1, 'the entry that left page 1 is retried by a later ordinary step'); assert.equal(recordOf('Aj8u').links.tmdb, '900002'); assert.equal(pending().Aj8u, undefined);
reset(); const five = ['Dfr1', 'Dfr2', 'Dfr3', 'Dfr4', 'Dfr5'];
for (const lid of five) {await seed(lid, 3); add(lid, 'fixture-' + lid.toLowerCase(), String(900100 + Number(lid.slice(3))), 'Fixture ' + lid, 2010);}
out = await Identity.resolve(env, items(...five.map(lid => [lid, 'fixture-' + lid.toLowerCase()])), opts());
assert.equal(out.counts.verified, 3); assert.equal(out.counts.deferred, 2); assert.deepEqual(Object.keys(pending()).sort(), ['Dfr4', 'Dfr5']); assert.equal(pending().Dfr4.reason, 'deferred'); assert.equal(pending().Dfr4.attempts, 0);
out = await Identity.resolve(env, [], opts({clock: () => NOW + 1000}));
assert.equal(out.counts.verified, 2, 'the deferred fourth and fifth are processed without being on the page again'); assert.deepEqual(pending(), {}); for (const lid of five) assert.ok(recordOf(lid).links.tmdb, lid);

// 12. review of PR #720, P2: one shared budget. A slow redirect leaves no time for the page or TMDB; a slow detail leaves no time for the writes. Nothing is written in either case.
reset(); await seed('Slw1', 3); add('Slw1', 'fixture-slw-2014', '900070', 'Fixture Slw', 2014); slow.on = 'redirect'; slow.left = 120000;
out = await Identity.resolve(env, items(['Slw1', 'fixture-slw-2014']), opts({remaining: () => slow.left}));
assert.equal(pending().Slw1.reason, 'timeout'); assert.equal(canonical.applied.length, 0); assert.equal(net.calls.length, 1, 'the page and TMDB are not requested past the budget');
reset(); await seed('Slw2', 3); add('Slw2', 'fixture-slw-2013', '900071', 'Fixture Slw2', 2013); slow.on = 'detail'; slow.left = 120000;
out = await Identity.resolve(env, items(['Slw2', 'fixture-slw-2013']), opts({remaining: () => slow.left}));
assert.equal(pending().Slw2.reason, 'deferred', 'AIR-599: no write reserve is not-now (no attempt)'); assert.equal(pending().Slw2.attempts, 0); assert.equal(canonical.applied.length, 0); assert.equal(recordOf('Slw2').links.tmdb, null); assert.equal(records.has('letterboxd/admissions/verified-films.json'), false, 'no receipt without the write reserve');
reset(); await seed('Slw3', 3); add('Slw3', 'fixture-slw-2012', '900072', 'Fixture Slw3', 2012);
out = await Identity.resolve(env, items(['Slw3', 'fixture-slw-2012']), opts({remaining: () => Identity.STEP_BUDGET_MS - 1})); assert.equal(net.calls.length, 0); assert.equal(pending().Slw3.reason, 'deferred');

// 13. review of PR #720 (second), P1: a temporary Film authority interruption (gate not open, bridge read held/unavailable/moved) keeps the id as a bounded `deferred`
// pending (same-row slug, attempts unchanged, no outbound check), and a LATER step with an empty or different page and an open gate processes it.
const interruptions = [['gate held', () => {canonical.gate = {mode: 'existing', state: 'held', generation: 2};}], ['gate not open', () => {canonical.gate = {mode: 'existing', state: 'prepared', generation: 2};}],
  ['gate unreadable', () => {canonical.gate = null;}], ...['film_person_held', 'film_person_unavailable', 'film_person_generation_moved', 'canonical_read_unavailable', 'canonical_read_not_authoritative'].map(code => ['bridge ' + code, () => {canonical.bridgeThrows = code;}])];
for (const [name, interrupt] of interruptions) {
  reset(); await seed('Tmp1', 3); add('Tmp1', 'fixture-tmp-2011', '900080', 'Fixture Tmp', 2011); interrupt();
  out = await Identity.resolve(env, items(['Tmp1', 'fixture-tmp-2011']), opts());
  assert.equal(net.calls.length, 0, name + ': no outbound check while the authority is unavailable'); assert.equal(canonical.applied.length, 0, name);
  assert.deepEqual({...pending().Tmp1}, {reason: 'deferred', class: 'not_now', slug: 'fixture-tmp-2011', attempts: 0, streak: 0, queuedAt: new Date(NOW).toISOString(), lastAttemptAt: null, nextAttemptAt: new Date(NOW).toISOString()}, name);
  // a second interrupted step keeps the entry as it is (no attempt consumed)
  await Identity.resolve(env, [], opts({clock: () => NOW + 1000})); assert.equal(pending().Tmp1.attempts, 0, name); assert.equal(net.calls.length, 0, name);
  canonical.gate = {mode: 'd1', state: 'open', generation: 2}; canonical.bridgeThrows = null;
  out = await Identity.resolve(env, items(['Other9', 'other-9']), opts({clock: () => NOW + 2000}));
  assert.equal(out.counts.verified, 1, name + ': the id is processed although it is no longer on the page'); assert.equal(recordOf('Tmp1').links.tmdb, '900080', name); assert.equal(pending().Tmp1, undefined, name);
}
// a conflict or retired bridge still fails closed and backs off (not a deferral).
reset(); await seed('Tmp2', 3); canonical.bridge.Tmp2 = {state: 'conflict'}; await Identity.resolve(env, items(['Tmp2', 'x']), opts());
assert.equal(pending().Tmp2.reason, 'bridge_conflict'); assert.equal(pending().Tmp2.attempts, 1); assert.ok(Date.parse(pending().Tmp2.nextAttemptAt) > NOW);
// a throw while linking a consumed bridge keeps the id as a deferral too (nothing is linked, nothing is dropped).
reset(); await seed('Tmp3', 3); canonical.bridge.Tmp3 = {state: 'ok', filmId: 'film:tmdb:x', tmdb: 'not-a-number', lid: 'Tmp3'};
out = await Identity.resolve(env, items(['Tmp3', 'fixture-tmp3-2010']), opts()); assert.equal(pending().Tmp3.reason, 'deferred'); assert.equal(recordOf('Tmp3').links.tmdb, null);

// 14. review of PR #720 (third), P1: an existing pending entry without a slug is upgraded when a later same-row Diary item supplies one, before the backoff and the authority
// deferral, keeping attempts and backoff; the entry is then retried off-page once due and the gate is open.
for (const variant of ['backoff', 'held gate']) {
  reset(); await seed('Slg1', 3); add('Slg1', 'fixture-slg-2009', '900090', 'Fixture Slg', 2009);
  await Identity.resolve(env, items(['Slg1', null]), opts()); const first = {...pending().Slg1};
  assert.deepEqual([first.reason, first.slug, first.attempts], ['slug_missing', null, 1], variant); assert.equal(net.calls.length, 0);
  if (variant === 'held gate') canonical.gate = {mode: 'existing', state: 'held', generation: 2};
  await Identity.resolve(env, items(['Slg1', 'fixture-slg-2009']), opts({clock: () => NOW + 60000}));
  const upgraded = pending().Slg1; assert.equal(upgraded.slug, 'fixture-slg-2009', variant + ': the new same-row slug is saved'); assert.equal(upgraded.attempts, 1, variant + ': no attempt consumed'); assert.equal(upgraded.nextAttemptAt, first.nextAttemptAt, variant + ': backoff unchanged'); assert.equal(upgraded.reason, 'slug_missing', variant);
  assert.equal(net.calls.length, 0, variant + ': no outbound check in the backoff or while the authority is held');
  canonical.gate = {mode: 'd1', state: 'open', generation: 2};
  out = await Identity.resolve(env, items(['Other8', 'other-8']), opts({clock: () => NOW + 13 * 3600000}));
  assert.equal(out.counts.verified, 1, variant + ': off-page retry once due'); assert.equal(recordOf('Slg1').links.tmdb, '900090', variant); assert.equal(pending().Slg1, undefined, variant);
}

// AIR-599: the same upgrade when the entry is already DUE but the authority is held (the step defers it): the new slug is saved, nothing is charged.
reset(); await seed('Slg2', 3); await Identity.resolve(env, items(['Slg2', null]), opts()); canonical.gate = {mode: 'existing', state: 'held', generation: 2};
await Identity.resolve(env, items(['Slg2', 'fixture-slg2-2009']), opts({clock: () => NOW + 13 * 3600000}));
assert.deepEqual([pending().Slg2.slug, pending().Slg2.attempts], ['fixture-slg2-2009', 1], 'a due entry deferred by a held authority keeps the newly seen slug'); canonical.gate = {mode: 'd1', state: 'open', generation: 2};

// 15. review of PR #720 (fourth), P1: a bridge that failed after the alias and the record link were committed (the projection threw once) leaves a pending entry on an already-linked id.
// A later ordinary step on a DIFFERENT page repairs the projection (no request, no second admission, no new fact) and clears the entry only then.
reset(); fail.view = 0; await seed('Prj1', 3.5); add('Prj1', 'fixture-prj-2008', '900110', 'Fixture Prj', 2008); fail.view = 1;
out = await Identity.resolve(env, items(['Prj1', 'fixture-prj-2008']), opts());
assert.equal(pending().Prj1.reason, 'link_failed'); assert.equal(recordOf('Prj1').links.tmdb, '900110', 'the alias and the record link are committed'); assert.equal(canonical.applied.length, 1);
assert.equal(records.get('enrichment/view-index.json').tmdb_900110, undefined, 'the projection did not happen');
const factsBefore = JSON.stringify(recordOf('Prj1')), receiptBefore = JSON.stringify(records.get('letterboxd/admissions/verified-films.json')), prjCalls = net.calls.filter(url => url.includes('Prj1') || url.includes('fixture-prj')).length;
out = await Identity.resolve(env, items(['Other7', 'other-7']), opts({clock: () => NOW + 1000}));
assert.equal(out.counts.repaired, 1); assert.equal(pending().Prj1, undefined, 'cleared only after the repair');
assert.equal(records.get('enrichment/view-index.json').tmdb_900110.watched, true); assert.equal(records.get('enrichment/view-index.json').tmdb_900110.actualRating, 3.5);
assert.equal(net.calls.filter(url => url.includes('Prj1') || url.includes('fixture-prj')).length, prjCalls, 'no outbound request for the repair'); assert.equal(canonical.applied.length, 1, 'no second admission');
assert.equal(JSON.stringify(recordOf('Prj1')), factsBefore, 'no new fact'); assert.equal(JSON.stringify(records.get('letterboxd/admissions/verified-films.json')), receiptBefore, 'no second receipt');
// a repair that fails again keeps the entry (nothing is cleared on a failed reproject).
reset(); fail.view = 0; await seed('Prj2', 3); add('Prj2', 'fixture-prj2-2007', '900111', 'Fixture Prj2', 2007); fail.view = 2;
await Identity.resolve(env, items(['Prj2', 'fixture-prj2-2007']), opts()); out = await Identity.resolve(env, [], opts({clock: () => NOW + 1000}));
assert.equal(out.counts.repaired, 0); assert.equal(pending().Prj2.reason, 'link_failed', 'the entry survives a failed repair'); fail.view = 0;
out = await Identity.resolve(env, [], opts({clock: () => NOW + 2000})); assert.equal(out.counts.repaired, 1); assert.equal(pending().Prj2, undefined);

// 16. review of PR #720 (fourth), P2: a due on-page entry with earlier attempts that is deferred behind the step cap keeps its attempts and backoff state.
reset(); fail.view = 0; for (const lid of ['Frs1', 'Frs2', 'Frs3', 'Old1']) await seed(lid, 3);
for (const [i, lid] of ['Frs1', 'Frs2', 'Frs3'].entries()) add(lid, 'fixture-frs' + (i + 1) + '-2006', String(900120 + i), 'Fixture ' + lid, 2006);
const oldEntry = {reason: 'forbidden', slug: 'old-one', attempts: 5, lastAttemptAt: '2026-11-17T10:00:00.000Z', nextAttemptAt: '2026-11-17T12:00:00.000Z'};
await bucket.put(Facts.DIARY_IDENTITY_KEY, JSON.stringify({schemaVersion: 1, films: {Old1: oldEntry}}));
site.set('Old1', {status: 429});
out = await Identity.resolve(env, items(['Frs1', 'fixture-frs1-2006'], ['Frs2', 'fixture-frs2-2006'], ['Frs3', 'fixture-frs3-2006'], ['Old1', 'old-one']), opts());
// AIR-599: one stable queue order. The older retained id (queued at its last attempt, 10:00) runs before the new page ids; its 429 stops the step's requests,
// consumes no attempt and keeps its place; the page ids are deferred (no attempt) behind it.
assert.equal(out.counts.checked, 1); assert.equal(out.counts.verified, 0); assert.equal(out.counts.deferred, 3);
assert.deepEqual([pending().Old1.reason, pending().Old1.attempts, pending().Old1.streak, pending().Old1.queuedAt], ['rate_limited', 5, 1, oldEntry.lastAttemptAt], 'a transport stop keeps the attempts and the place');
for (const lid of ['Frs1', 'Frs2', 'Frs3']) assert.deepEqual([pending()[lid].reason, pending()[lid].attempts], ['deferred', 0], lid);

// AIR-599: a due entry deferred behind a transport stop of an older one keeps its attempts, reason and queue position.
reset(); for (const lid of ['Qa01', 'Qb01']) await seed(lid, 3); site.set('Qa01', {status: 429}); site.set('Qb01', {status: 404});
putDoc({Qa01: {reason: 'not_found', slug: 'qa', attempts: 2, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-11T00:00:00.000Z'},
  Qb01: {reason: 'not_found', slug: 'qb', attempts: 3, streak: 0, queuedAt: '2026-11-02T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-11T00:00:00.000Z'}});
out = await Identity.resolve(env, [], opts());
assert.deepEqual([pending().Qa01.reason, pending().Qa01.attempts, pending().Qb01.reason, pending().Qb01.attempts, pending().Qb01.queuedAt], ['rate_limited', 2, 'not_found', 3, '2026-11-02T00:00:00.000Z'], 'the older id runs first; the deferred one is unchanged');
assert.equal(net.calls.filter(url => url.includes('Qb01')).length, 0);

// 17. review of PR #720 (fifth), P1: a durable link intent precedes every non-atomic effect, so a lost final pending write after a partial commit is still repaired off-page.
const prjView = tmdb => records.get('enrichment/view-index.json')?.['tmdb_' + tmdb];
// (a) alias + record committed, projection throws, and the final pending write is lost: the intent survives; a later step on another page repairs the projection.
reset(); fail.view = 0; fail.identity = null; await seed('Crs1', 4); add('Crs1', 'fixture-crs-2005', '900130', 'Fixture Crs', 2005); fail.view = 1; fail.identity = 2;
out = await Identity.resolve(env, items(['Crs1', 'fixture-crs-2005']), opts()); fail.identity = null;
assert.equal(out.counts.persistFailed, 1); assert.equal(pending().Crs1.reason, 'linking', 'the intent written before the effects survives the lost final write'); assert.equal(pending().Crs1.tmdb, '900130');
assert.equal(recordOf('Crs1').links.tmdb, '900130'); assert.equal(prjView('900130'), undefined); assert.equal(canonical.applied.length, 1);
let crsCalls = net.calls.length;
out = await Identity.resolve(env, items(['Other6', 'other-6']), opts({clock: () => AFTER_RESERVATION}));
assert.equal(out.counts.repaired, 1); assert.equal(prjView('900130').watched, true); assert.equal(prjView('900130').actualRating, 4); assert.equal(pending().Crs1, undefined);
assert.equal(net.calls.filter(url => url.includes('Crs1') || url.includes('fixture-crs')).length, 0 + net.calls.slice(0, crsCalls).filter(url => url.includes('Crs1') || url.includes('fixture-crs')).length, 'no source request for the repair'); assert.equal(canonical.applied.length, 1, 'no second admission');
// (b) a link_failed at attempts = 6 (the source cap) is still repaired off-page, without a source request or a new admission.
reset(); fail.view = 0; fail.identity = null; await seed('Cap6', 3); add('Cap6', 'fixture-cap6-2004', '900131', 'Fixture Cap6', 2004);
await bucket.put(Facts.DIARY_IDENTITY_KEY, JSON.stringify({schemaVersion: 1, films: {Cap6: {reason: 'forbidden', slug: 'fixture-cap6-2004', attempts: 5, lastAttemptAt: '2026-11-17T10:00:00.000Z', nextAttemptAt: '2026-11-17T12:00:00.000Z'}}}));
fail.view = 1; await Identity.resolve(env, items(['Cap6', 'fixture-cap6-2004']), opts());
assert.deepEqual([pending().Cap6.reason, pending().Cap6.attempts], ['link_failed', 5], 'AIR-599: a verified page whose link failed consumes no attempt');
{const doc = records.get(Facts.DIARY_IDENTITY_KEY); doc.films.Cap6.attempts = Identity.MAX_ATTEMPTS; records.set(Facts.DIARY_IDENTITY_KEY, doc);} crsCalls = net.calls.length; // the repair is served at the cap too
out = await Identity.resolve(env, items(['Other5', 'other-5']), opts({clock: () => NOW + 1000}));
assert.equal(out.counts.repaired, 1, 'the cap on source attempts does not stop a repair'); assert.equal(prjView('900131').watched, true); assert.equal(pending().Cap6, undefined);
assert.equal(net.calls.slice(crsCalls).filter(url => url.includes('Cap6') || url.includes('fixture-cap6')).length, 0); assert.equal(canonical.applied.length, 1);
// (c) the intent cannot be written: fail closed, no receipt, no admission, no alias.
reset(); fail.view = 0; fail.identity = 0; await seed('Fcl1', 3); add('Fcl1', 'fixture-fcl-2003', '900132', 'Fixture Fcl', 2003);
out = await Identity.resolve(env, items(['Fcl1', 'fixture-fcl-2003']), opts()); fail.identity = null;
assert.equal(out.counts.persistFailed, 1); assert.equal(canonical.applied.length, 0); assert.equal(records.has('letterboxd/admissions/verified-films.json'), false); assert.equal(recordOf('Fcl1').links.tmdb, null);
// (d) a kill after the intent and before the alias (admission refused, final write lost): the intent is served later off-page and the source check completes it.
reset(); fail.view = 0; fail.identity = 2; await seed('Kil1', 3); add('Kil1', 'fixture-kil-2002', '900133', 'Fixture Kil', 2002); canonical.failWith = 'canonical_write_unknown';
await Identity.resolve(env, items(['Kil1', 'fixture-kil-2002']), opts()); fail.identity = null; canonical.failWith = null;
assert.equal(pending().Kil1.reason, 'linking'); assert.equal(recordOf('Kil1').links.tmdb, null);
out = await Identity.resolve(env, items(['Other4', 'other-4']), opts({clock: () => AFTER_RESERVATION}));
assert.equal(out.counts.verified, 1); assert.equal(recordOf('Kil1').links.tmdb, '900133'); assert.equal(prjView('900133').watched, true); assert.equal(pending().Kil1, undefined);
// an intent whose alias never commits stops being served as a repair once the source cap is reached.
reset(); fail.identity = null; await seed('Itr1', 3); await bucket.put(Facts.DIARY_IDENTITY_KEY, JSON.stringify({schemaVersion: 1, films: {Itr1: {reason: 'linking', slug: 'fixture-itr-2001', tmdb: '900134', attempts: 6, lastAttemptAt: '2026-11-17T10:00:00.000Z', nextAttemptAt: '2026-11-17T10:00:00.000Z'}}}));
out = await Identity.resolve(env, items(['Other3', 'other-3']), opts()); assert.equal(pending().Itr1.reason, 'link_interrupted'); assert.equal(net.calls.filter(url => url.includes('Itr1')).length, 0);

// 9. the pending retry spacing is monotone and bounded; transport backs off less than a review.
assert.ok(Identity.delayMs('forbidden', 1) < Identity.delayMs('slug_mismatch', 1)); assert.ok(Identity.delayMs('forbidden', 9) <= 48 * 3600000);
// 18. ADR 0184 wiring: the canonical Letterboxd claim is requested AFTER the facts, the link and the pending document are durable, only for a proven Ratings link, never throws into the run, never delays the rating,
// and a claim that is not proved keeps a bounded local `claim_pending` state served by later ordinary steps (also off Diary page 1). The claim module is gated off in production; here a recording stub stands in for it.
const claimCalls = []; const claimStub = {LETTERBOXD_CLAIM_ACTIVATED: true, mode: 'complete', ensureLetterboxdClaims: async (envArg, {pairs}) => {
  claimCalls.push({pairs: JSON.parse(JSON.stringify(pairs)), linked: JSON.parse(JSON.stringify(pairs.map(pair => recordOf(pair.lid)?.links?.tmdb ?? null))), pendingKeys: Object.keys(pending())});
  if (claimStub.mode === 'throw') throw Object.assign(new Error('boom'), {code: 'film_person_unavailable'});
  if (claimStub.mode === 'inactive') return {state: 'inactive', results: [], unattempted: []};
  const state = claimStub.mode === 'incomplete' ? 'refused' : 'written';
  return {state: claimStub.mode === 'incomplete' ? 'incomplete' : 'complete', results: pairs.map(pair => ({lid: pair.lid, state})), unattempted: []};
}};
ctx.CanonicalLetterboxdClaim = claimStub;
reset(); claimCalls.length = 0; claimStub.mode = 'complete'; await seed('vMEO', 3.5); add('vMEO', 'fixture-alpha-2023', '900001', 'Fixture Alpha', 2023);
out = await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts());
assert.equal(out.counts.verified, 1); assert.equal(out.counts.claim, 'complete');
assert.equal(claimCalls.length, 1);
// AIR-618 (ADR 0215 choice 0215-8b = C): a pair THIS step verified by a page check is handed over WITH that check's digest (the admission receipt's own digest of the same page), as the causal root of the bridge evidence row.
const handedRoot = claimCalls[0].pairs[0].root; assert.match(handedRoot, /^[0-9a-f]{64}$/);
assert.deepEqual(claimCalls[0].pairs, [{lid: 'vMEO', tmdb: '900001', root: handedRoot}]);
assert.equal(handedRoot, records.get('letterboxd/admissions/verified-films.json').films.tmdb_900001.archiveSha256, 'the root is the digest of the very check that produced the link, never a guess');
assert.deepEqual(claimCalls[0].linked, ['900001'], 'the Ratings link is durable before the claim is requested'); assert.deepEqual(claimCalls[0].pendingKeys, ['vMEO'], 'the verified pair is handed off: its durable claim_pending entry exists BEFORE the claim is requested (AIR-559, review of #966)');
assert.deepEqual(Object.keys(pending()), [], 'a proved claim leaves no pending state');
// AIR-559: the next ordinary run does NOT re-offer an already-linked id without its own pending claim: the link index alone does not say how the pair was made (an inferred
// title/year import may have left it unmarked), so only a pair this step verified, bridged or repaired, and still unproved, is served again (as `claim_pending`).
out = await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts());
assert.equal(claimCalls.length, 1, 'a proved, already-linked id is not offered again');
// an id the link index ties to a movie that this step never verified (for example an inferred import's pair) is never offered, on page or off
reset(); claimCalls.length = 0; await seed('Inf1', 4);
{const key = await Facts.linkFilm(env, {letterboxd: 'Inf1', tmdb: '900050'}); await Facts.recordObservations(env, key, {letterboxd: 'Inf1', tmdb: '900050'}, []);}
assert.equal(recordOf('Inf1').links.tmdb, '900050', 'the pair is linked in the index and on the record');
const requestsBefore = net.calls.length;
out = await Identity.resolve(env, items(['Inf1', 'fixture-inf-2010']), opts());
assert.equal(claimCalls.length, 0, 'an index-only link is never offered by the Diary step');
assert.equal(net.calls.length, requestsBefore, 'and an already-linked id needs no source request');
// a pending claim whose movie no longer matches the current link is not served
await bucket.put(Facts.DIARY_IDENTITY_KEY, JSON.stringify({schemaVersion: 1, films: {Inf1: {reason: 'claim_pending', slug: null, tmdb: '900051', attempts: 1, lastAttemptAt: new Date(NOW).toISOString(), nextAttemptAt: new Date(NOW).toISOString()}}}), {});
out = await Identity.resolve(env, items(['Inf1', 'fixture-inf-2010']), opts({clock: () => NOW + 3600000}));
assert.equal(claimCalls.length, 0, 'a pending claim for another movie than the current link is not offered');
// an existing trusted bridge is offered too
reset(); claimCalls.length = 0; await seed('Brg1', 3); canonical.bridge.Brg1 = {state: 'ok', filmId: 'film:tmdb:900020', tmdb: '900020', lid: 'Brg1'};
out = await Identity.resolve(env, items(['Brg1', 'fixture-brg-2019']), opts()); assert.equal(out.counts.bridged, 1); assert.deepEqual(claimCalls.map(call => call.pairs), [[{lid: 'Brg1', tmdb: '900020'}]]);
// a repaired link_failed bridge is offered (AIR-618: rootless; no page was checked by this step, so nothing is handed over)
reset(); claimCalls.length = 0; await seed('Itr9', 3); await bucket.put(Facts.DIARY_IDENTITY_KEY, JSON.stringify({schemaVersion: 1, films: {Itr9: {reason: 'link_failed', slug: 'fixture-itr-2009', tmdb: '900030', attempts: 1, lastAttemptAt: new Date(NOW - 7200000).toISOString(), nextAttemptAt: new Date(NOW - 3600000).toISOString()}}}), {});
out = await Identity.resolve(env, items(['Itr9', 'fixture-itr-2009']), opts()); assert.equal(out.counts.repaired, 1); assert.deepEqual(claimCalls.map(call => call.pairs), [[{lid: 'Itr9', tmdb: '900030'}]]);
// no proven link, no claim request: a 403 pending never reaches the claim step
reset(); claimCalls.length = 0; await seed('Aj8u', 4); site.set('Aj8u', {status: 403}); out = await Identity.resolve(env, items(['Aj8u', 'fixture-beta-2024']), opts());
assert.equal(out.counts.pending, 1); assert.equal(claimCalls.length, 0); assert.equal(out.counts.claim, undefined);
// a claim step that throws or ends incomplete never fails the run, the label or the rating, and keeps a bounded pending state
for (const mode of ['throw', 'incomplete']) {
  reset(); claimCalls.length = 0; claimStub.mode = mode; await seed('vMEO', 3.5); add('vMEO', 'fixture-alpha-2023', '900001', 'Fixture Alpha', 2023);
  out = await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts());
  assert.equal(out.counts.verified, 1, mode); assert.deepEqual({...out.labels.get('vMEO')}, {title: 'Fixture Alpha', year: 2023, tmdb: '900001'}); assert.equal(recordOf('vMEO').rating.value, 3.5);
  assert.equal(out.counts.claim, 'incomplete', mode);
  assert.equal(pending().vMEO.reason, 'claim_pending', mode); assert.equal(pending().vMEO.tmdb, '900001'); assert.ok(Date.parse(pending().vMEO.nextAttemptAt) >= NOW);
}
// durable retry: an id that is OFF Diary page 1 is offered again by a later ordinary step once its backoff has elapsed, and a proved claim clears the state
reset(); claimCalls.length = 0; claimStub.mode = 'incomplete'; await seed('vMEO', 3.5); add('vMEO', 'fixture-alpha-2023', '900001', 'Fixture Alpha', 2023);
await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts());
const first = pending().vMEO; assert.equal(first.reason, 'claim_pending'); assert.equal(first.attempts, 1);
claimCalls.length = 0; await Identity.resolve(env, items(), opts({clock: () => NOW + 60000})); assert.equal(claimCalls.length, 0, 'inside the backoff nothing is requested');
claimStub.mode = 'incomplete'; await Identity.resolve(env, items(), opts({clock: () => NOW + 13 * 3600000}));
assert.equal(claimCalls.length, 1, 'off-page: served by the later ordinary step'); assert.deepEqual(claimCalls[0].pairs, [{lid: 'vMEO', tmdb: '900001'}]); assert.equal(pending().vMEO.attempts, 2, 'a tried and unproved id counts an attempt');
claimStub.mode = 'complete'; await Identity.resolve(env, items(), opts({clock: () => NOW + 60 * 3600000}));
assert.equal(claimCalls.length, 2); assert.deepEqual(Object.keys(pending()), [], 'a proved claim clears the pending state');
// AIR-599 (review of PR #1009): an owner dismiss that lands while the claim request is in flight is not overwritten by the claim step's own write.
reset(); claimCalls.length = 0; claimStub.mode = 'incomplete'; await seed('vMEO', 3.5); add('vMEO', 'fixture-alpha-2023', '900001', 'Fixture Alpha', 2023);
await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts());
{const original = claimStub.ensureLetterboxdClaims; claimStub.ensureLetterboxdClaims = async (envArg, input) => {const {version} = await Facts.readDiaryIdentityVersioned(env); await Facts.ownerAction(env, {action: 'dismiss', lids: ['vMEO'], expectedVersion: version, by: 'o', why: 'w', at: 'a'}); return original(envArg, input);};
 await Identity.resolve(env, items(), opts({clock: () => NOW + 13 * 3600000})); claimStub.ensureLetterboxdClaims = original;}
assert.equal(pending().vMEO.reason, 'owner_dismissed', 'the claim step wrote nothing over the owner decision'); claimStub.mode = 'complete';
// the same backoff and attempt bound hold for an id that is still ON Diary page 1 (an ordinary run never retries early or past the bound)
reset(); claimCalls.length = 0; claimStub.mode = 'incomplete'; await seed('vMEO', 3.5); add('vMEO', 'fixture-alpha-2023', '900001', 'Fixture Alpha', 2023);
await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts()); assert.equal(claimCalls.length, 1); assert.equal(pending().vMEO.attempts, 1);
claimCalls.length = 0; await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts({clock: () => NOW + 60000}));
assert.equal(claimCalls.length, 0, 'on page, inside the backoff: no early retry'); assert.equal(pending().vMEO.attempts, 1);
await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts({clock: () => NOW + 13 * 3600000}));
assert.equal(claimCalls.length, 1, 'on page, once due: retried'); assert.equal(pending().vMEO.attempts, 2);
await bucket.put(Facts.DIARY_IDENTITY_KEY, JSON.stringify({schemaVersion: 1, films: {vMEO: {reason: 'claim_pending', slug: null, tmdb: '900001', attempts: 6, lastAttemptAt: new Date(NOW).toISOString(), nextAttemptAt: new Date(NOW).toISOString()}}}), {});
claimCalls.length = 0; await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts({clock: () => NOW + 100 * 3600000}));
assert.equal(claimCalls.length, 0, 'on page, at the attempt bound: never retried again'); assert.equal(pending().vMEO.attempts, 6);
// bounded: after MAX_ATTEMPTS the entry stays visible and is no longer served
await bucket.put(Facts.DIARY_IDENTITY_KEY, JSON.stringify({schemaVersion: 1, films: {vMEO: {reason: 'claim_pending', slug: null, tmdb: '900001', attempts: 6, lastAttemptAt: new Date(NOW).toISOString(), nextAttemptAt: new Date(NOW).toISOString()}}}), {});
claimCalls.length = 0; await Identity.resolve(env, items(), opts({clock: () => NOW + 100 * 3600000})); assert.equal(claimCalls.length, 0); assert.equal(pending().vMEO.attempts, 6);
// a withdrawn Ratings link ends the claim state (nothing to claim)
await bucket.put(Facts.DIARY_IDENTITY_KEY, JSON.stringify({schemaVersion: 1, films: {Gone1: {reason: 'claim_pending', slug: null, tmdb: '900077', attempts: 1, lastAttemptAt: new Date(NOW).toISOString(), nextAttemptAt: new Date(NOW).toISOString()}}}), {});
await Identity.resolve(env, items(), opts({clock: () => NOW + 3600000})); assert.equal(pending().Gone1, undefined);
// INACTIVE: nothing is stored (no production document changes while the gate is off)
reset(); claimCalls.length = 0; claimStub.mode = 'inactive'; claimStub.LETTERBOXD_CLAIM_ACTIVATED = false; await seed('vMEO', 3.5); add('vMEO', 'fixture-alpha-2023', '900001', 'Fixture Alpha', 2023);
out = await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts()); assert.equal(out.counts.verified, 1); assert.deepEqual(Object.keys(pending()), []); assert.equal(out.counts.claim, undefined);
claimStub.LETTERBOXD_CLAIM_ACTIVATED = true;
// a short lease skips the claim step (the rating and the Event never wait for it) and keeps the id due; an absent claim module is a no-op
reset(); claimCalls.length = 0; claimStub.mode = 'complete'; await seed('Brg1', 3); canonical.bridge.Brg1 = {state: 'ok', filmId: 'film:tmdb:900020', tmdb: '900020', lid: 'Brg1'};
out = await Identity.resolve(env, items(['Brg1', 'fixture-brg-2019']), opts({remaining: () => 1000})); assert.equal(claimCalls.length, 0); assert.equal(pending().Brg1.reason, 'claim_pending'); assert.equal(pending().Brg1.attempts, 0);
delete ctx.CanonicalLetterboxdClaim; reset(); await seed('Brg1', 3); canonical.bridge.Brg1 = {state: 'ok', filmId: 'film:tmdb:900020', tmdb: '900020', lid: 'Brg1'};
out = await Identity.resolve(env, items(['Brg1', 'fixture-brg-2019']), opts()); assert.equal(out.counts.bridged, 1); assert.equal(out.counts.claim, undefined); assert.deepEqual(Object.keys(pending()), []);

// ---- AIR-599 / ADR 0207 decision 4b: one retry contract for both callers ----
const backlogOf = () => records.get(Facts.DIARY_IDENTITY_KEY)?.backlog || {};
// (a) transport (403, challenge, 429, timeout, 5xx, network) consumes no attempt, keeps the place and backs off 15 min · 2^(streak − 1); a 404 consumes one; six 404s are terminal and visible.
for (const [name, arrange, reason] of [['403', lid => site.set(lid, {status: 403}), 'forbidden'], ['challenge', lid => site.set(lid, {status: 403, headers: {'cf-mitigated': 'challenge'}}), 'challenge'], ['429', lid => site.set(lid, {status: 429}), 'rate_limited'],
  ['5xx', lid => site.set(lid, {status: 503}), 'upstream_5xx'], ['tmdb 5xx', lid => {add(lid, 'fixture-t5-2001', '900201', 'Fixture T5', 2001); tmdbDocs.set('900201', () => http(502, ''));}, 'upstream_5xx'],
  ['network', lid => {site.set(lid, {landing: 'fixture-net'}); const handler = net.handler; net.handler = async (url, init) => {if (url.includes('boxd.it/' + lid)) {net.handler = handler; throw new TypeError('network down');} return handler(url, init);};}, 'network_error']]) {
  reset(); await seed('Trn1', 3); arrange('Trn1');
  out = await Identity.resolve(env, items(['Trn1', 'fixture-t5-2001']), opts({route: 'watchlist_admission'}));
  const entry = pending().Trn1;
  assert.deepEqual([entry.reason, entry.class, entry.attempts, entry.streak, entry.queuedAt], [reason, 'transport', 0, 1, new Date(NOW).toISOString()], name);
  assert.equal(entry.nextAttemptAt, new Date(NOW + 15 * 60000).toISOString(), name + ': first transport backoff is 15 min');
  const outcome = out.outcomes.get('Trn1'); assert.deepEqual([outcome.checked, outcome.class, outcome.attempts, outcome.terminal], [true, 'transport', 0, false], name);
  assert.equal(entry.route, 'watchlist_admission', name);
}
assert.equal(Identity.transportDelayMs(6), 8 * 3600000, 'the transport backoff is capped at 8 h'); assert.equal(Identity.transportDelayMs(9), 8 * 3600000);
reset(); await seed('Gon1', 3); site.set('Gon1', {status: 404}); let when = NOW;
for (let i = 0; i < 8; i++) {out = await Identity.resolve(env, items(['Gon1', 'x']), opts({clock: () => when})); when += 3 * 24 * 3600000;}
assert.deepEqual([pending().Gon1.reason, pending().Gon1.class, pending().Gon1.attempts], ['not_found', 'gone', 6], 'six 404s, then no more checks');
assert.equal(net.calls.filter(url => url.includes('Gon1')).length, 6); assert.equal(out.outcomes.get('Gon1').terminal, true, 'terminal and visible, never dropped');
assert.equal(Identity.visibleClass(pending().Gon1), 'needs_owner_review');
// a real check after a transport streak resets the streak
reset(); await seed('Rst1', 3); putDoc({Rst1: {reason: 'rate_limited', class: 'transport', slug: 'x', attempts: 2, streak: 4, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-17T10:00:00.000Z', nextAttemptAt: '2026-11-17T12:00:00.000Z'}}); site.set('Rst1', {status: 404});
await Identity.resolve(env, [], opts()); assert.deepEqual([pending().Rst1.attempts, pending().Rst1.streak, pending().Rst1.queuedAt], [3, 0, '2026-11-01T00:00:00.000Z']); assert.match(pending().Rst1.checkId, /.+/);
// (b) one check budget for both callers: a real check charged once whichever caller runs it; the other caller inside the backoff makes no request and gets the same count.
reset(); await seed('Shr1', 3); site.set('Shr1', {status: 404});
out = await Identity.resolve(env, items(['Shr1', 'x']), opts({route: 'watchlist_admission'})); assert.equal(pending().Shr1.attempts, 1);
const callsShr = net.calls.length;
out = await Identity.resolve(env, items(['Shr1', 'x']), opts({clock: () => NOW + 60000, route: 'ratings_diary'}));
assert.equal(net.calls.length, callsShr, 'not due for the other caller either'); assert.equal(pending().Shr1.attempts, 1, 'charged once');
assert.deepEqual([out.outcomes.get('Shr1').checked, out.outcomes.get('Shr1').attempts], [false, 1]);
// an intent written by one caller is resumed by the other
reset(); fail.identity = 2; await seed('Res1', 3); add('Res1', 'fixture-res-2000', '900202', 'Fixture Res', 2000); canonical.failWith = 'canonical_write_unknown';
await Identity.resolve(env, items(['Res1', 'fixture-res-2000']), opts({route: 'watchlist_admission'})); fail.identity = null; canonical.failWith = null;
assert.deepEqual([pending().Res1.reason, pending().Res1.route], ['linking', 'watchlist_admission']);
out = await Identity.resolve(env, items(['Oth9', 'oth-9']), opts({clock: () => AFTER_RESERVATION, route: 'ratings_diary'})); assert.equal(out.counts.verified, 1); assert.equal(recordOf('Res1').links.tmdb, '900202');
// a stale Sync epoch at the admission batch (the writer's `letterboxd_epoch_fence`) is not now: no attempt
reset(); await seed('Epo1', 3); add('Epo1', 'fixture-epo-2000', '900203', 'Fixture Epo', 2000); canonical.failWith = 'letterboxd_epoch_fence';
await Identity.resolve(env, items(['Epo1', 'fixture-epo-2000']), opts()); canonical.failWith = null;
assert.deepEqual([pending().Epo1.reason, pending().Epo1.class, pending().Epo1.attempts], ['epoch_fenced', 'not_now', 0]);
// (c) the cap: 200 entries the step may not evict (link intents, pending claims, transport-retained, below-cap, at-cap) refuse a NEW id: no check, backlog, `cap_refused`.
reset(); await seed('New1', 3); add('New1', 'fixture-new-2000', '900204', 'Fixture New', 2000);
{const films = {}; const kinds = ['linking', 'link_failed', 'claim_pending', 'forbidden', 'not_found'];
  for (let i = 0; i < 200; i++) {const reason = kinds[i % 5]; films['K' + String(i).padStart(3, '0')] = {reason, slug: 'k-' + i, tmdb: reason === 'not_found' || reason === 'forbidden' ? undefined : '9' + String(i).padStart(5, '0'), attempts: i % 10 === 4 ? 6 : 1, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-17T00:00:00.000Z', nextAttemptAt: '2026-11-30T00:00:00.000Z'};}
  putDoc(films);}
const callsCap = net.calls.length;
out = await Identity.resolve(env, items(['New1', 'fixture-new-2000']), opts());
assert.equal(net.calls.length, callsCap, 'no check for an id without a place'); assert.equal(out.counts.capRefused, 1); assert.deepEqual({...out.outcomes.get('New1')}, {checked: false, class: 'not_now', reason: 'diary_cap', retryAt: null, attempts: 0, streak: 0, terminal: false});
assert.equal(Object.keys(pending()).length, 200, 'nothing evicted'); assert.deepEqual(Object.keys(backlogOf()), ['New1']); assert.equal(backlogOf().New1.slug, 'fixture-new-2000');
// the write path refuses too: an added id above the cap is returned in `refused`, no existing entry is dropped
const refusedWrite = await Facts.updateDiaryIdentity(env, {set: {Zzz1: {reason: 'deferred', slug: 'z', attempts: 0, lastAttemptAt: null, nextAttemptAt: new Date(NOW).toISOString()}}});
assert.deepEqual([...refusedWrite.refused], ['Zzz1']); assert.equal(Object.keys(pending()).length, 200);
// new page ids do not overtake: when a place returns (the owner dismisses one entry), the backlog id enters first, before a newer page id
const {version: v1} = await Facts.readDiaryIdentityVersioned(env);
const dismissed = await Facts.ownerAction(env, {action: 'dismiss', lids: ['K004'], expectedVersion: v1, by: 'owner@example.test', why: 'test', at: new Date(NOW).toISOString()});
assert.equal(dismissed.state, 'applied'); assert.equal(dismissed.entries.K004.reason, 'owner_dismissed');
await seed('Pg01', 3); add('Pg01', 'fixture-pg01-2000', '900205', 'Fixture Pg01', 2000);
out = await Identity.resolve(env, items(['Pg01', 'fixture-pg01-2000']), opts({clock: () => NOW + 1000}));
assert.equal(out.counts.verified, 1, 'the backlog id is checked first'); assert.equal(recordOf('New1').links.tmdb, '900204'); assert.deepEqual(Object.keys(backlogOf()), ['Pg01'], 'the newer page id waits in the backlog');
assert.equal(pending().K004, undefined, 'the dismissed (settled) entry was the one evicted');
// (d) owner requeue / dismiss: compare-and-swap on the stored version, readback; a stale version is refused and writes nothing.
reset(); putDoc({Leg1: {reason: 'forbidden', slug: 'l', attempts: 6, lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-11T00:00:00.000Z'}});
const {version: v2} = await Facts.readDiaryIdentityVersioned(env);
out = await Identity.resolve(env, [], opts()); assert.equal(pending().Leg1.attempts, 6, 'a legacy entry exhausted by old transport charges keeps its count until the owner requeues it');
const stale = await Facts.ownerAction(env, {action: 'requeue', lids: ['Leg1'], expectedVersion: 'not-the-version', by: 'o', why: 'w', at: 'a'});
assert.equal(stale.state, 'stale_revision'); assert.equal(pending().Leg1.attempts, 6);
const req = await Facts.ownerAction(env, {action: 'requeue', lids: ['Leg1', 'Abs1'], expectedVersion: v2, by: 'owner@example.test', why: 'transport exhausted', at: '2026-11-17T16:00:00.000Z'});
assert.deepEqual({...req.results}, {Leg1: 'requeued', Abs1: 'absent'});
assert.deepEqual([req.entries.Leg1.attempts, req.entries.Leg1.streak, req.entries.Leg1.queuedAt, req.entries.Leg1.reason, req.entries.Leg1.requeued.why], [0, 0, '2026-11-10T00:00:00.000Z', 'owner_requeued', 'transport exhausted']);
assert.notEqual(req.version, v2);
// a requeue of a reported id without an entry creates its backlog record; a dismiss of a backlog id removes it
const {version: b0} = await Facts.readDiaryBacklog(env);
const created = await Facts.ownerAction(env, {action: 'requeue', createMissing: true, lids: ['Rep1'], slugs: {Rep1: 'rep-1'}, expectedVersion: b0, by: 'o', why: 'report', at: '2026-11-17T16:00:00.000Z'});
assert.deepEqual([created.state, created.results.Rep1, created.backlog.Rep1.slug], ['applied', 'created', 'rep-1']);
assert.equal((await Facts.ownerAction(env, {action: 'dismiss', createMissing: false, lids: ['Rep1'], expectedVersion: b0, by: 'o', why: 'x', at: 'a'})).state, 'stale_revision');
assert.equal((await Facts.ownerAction(env, {action: 'dismiss', createMissing: false, lids: ['Rep1'], expectedVersion: created.version, by: 'o', why: 'x', at: 'a'})).results.Rep1, 'dismissed');
// a dismissed entry is never checked again
reset(); await seed('Dis1', 3); site.set('Dis1', {status: 404}); putDoc({Dis1: {reason: 'owner_dismissed', class: 'settled', slug: 'd', attempts: 2, lastAttemptAt: 'x', nextAttemptAt: null}});
out = await Identity.resolve(env, items(['Dis1', 'd']), opts()); assert.equal(net.calls.length, 0); assert.deepEqual([out.outcomes.get('Dis1').class, out.outcomes.get('Dis1').reason], ['settled', 'owner_dismissed']);
// (e) under a not-open authority (the A1 `closed` analogue): no attempt and no termination
reset(); await seed('Cls1', 3); canonical.gate = {mode: 'existing', state: 'held', generation: 2};
for (let i = 0; i < 10; i++) await Identity.resolve(env, items(['Cls1', 'c']), opts({clock: () => NOW + i * 86400000}));
assert.deepEqual([pending().Cls1.attempts, pending().Cls1.reason], [0, 'deferred']);

// ---- AIR-599 review of PR #1009 ----
// P3: a resolve that read an entry before slow source I/O never overwrites what an owner action (or another caller's check) wrote meanwhile.
{
 const slowTo = async (lid, work) => {const handler = net.handler; net.handler = async (url, init) => {if (url.includes('boxd.it/' + lid)) {net.handler = handler; await work(); return http(404, '');} return handler(url, init);};};
 const entryOf = (attempts, extra = {}) => ({reason: 'not_found', class: 'gone', slug: 'rac', attempts, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-11T00:00:00.000Z', ...extra});
 const ownerAct = async (action, lid) => {const {version} = await Facts.readDiaryIdentityVersioned(env); return Facts.ownerAction(env, {action, lids: [lid], expectedVersion: version, by: 'o', why: 'w', at: new Date(NOW + 30000).toISOString()});};
 // (a) an owner `requeue` during an in-flight check is REFUSED whole (the id has a live reservation: an effect can still land), nothing is written; the holder charges its check once; the owner acts after it.
 reset(); await seed('Rac1', 3); putDoc({Rac1: entryOf(5)}); let refusedA = null;
 await slowTo('Rac1', async () => {refusedA = await ownerAct('requeue', 'Rac1');});
 out = await Identity.resolve(env, [], opts());
 assert.deepEqual([refusedA.state, [...refusedA.ids]], ['check_in_flight', ['Rac1']], 'refused while the check is in flight'); assert.deepEqual([pending().Rac1.attempts, out.outcomes.get('Rac1').terminal], [6, true], 'the holder charged its one check');
 assert.equal((await ownerAct('requeue', 'Rac1')).state, 'applied'); assert.equal(pending().Rac1.attempts, 0, 'after the check the owner requeue applies');
 // (a2) a writer that does not honour reservations (a foreign write that lands mid-flight): the holder's write is bound to the entry it reserved, so it is not installed (entry_changed) and the foreign value stands.
 reset(); await seed('Rac6', 3); putDoc({Rac6: entryOf(5)});
 await slowTo('Rac6', async () => {putDoc({Rac6: entryOf(0, {reason: 'owner_requeued', class: 'not_now'})});});
 out = await Identity.resolve(env, [], opts());
 assert.deepEqual([pending().Rac6.reason, pending().Rac6.attempts], ['owner_requeued', 0], 'the foreign value stands'); assert.deepEqual([out.outcomes.get('Rac6').reason, out.outcomes.get('Rac6').attempts], ['entry_changed', null]); assert.equal(out.counts.entryChanged, 1);
 // (b) an owner `dismiss` during the check is refused whole too; afterwards it applies.
 reset(); await seed('Rac2', 3); putDoc({Rac2: entryOf(1, {reason: 'forbidden', class: 'transport', streak: 2})}); let refusedB = null;
 await slowTo('Rac2', async () => {refusedB = await ownerAct('dismiss', 'Rac2');});
 await Identity.resolve(env, [], opts()); assert.equal(refusedB.state, 'check_in_flight'); assert.equal(pending().Rac2.reason, 'not_found'); assert.equal((await ownerAct('dismiss', 'Rac2')).state, 'applied'); assert.equal(pending().Rac2.reason, 'owner_dismissed');
 // (c) two overlapping resolves of the same id: the first RESERVES the check before it reaches the source; the second sees the reservation and performs NO check at all (`in_flight`), so two callers never make two real checks.
 reset(); await seed('Rac3', 3); site.set('Rac3', {status: 404});
 const inner = []; await slowTo('Rac3', async () => {inner.push(await Identity.resolve(env, items(['Rac3', 'rac']), opts({route: 'watchlist_admission'})));});
 const outer = await Identity.resolve(env, items(['Rac3', 'rac']), opts());
 assert.equal(net.calls.filter(url => url.includes('Rac3')).length, 1, 'one reservation, at most one real check');
 assert.deepEqual([inner[0].outcomes.get('Rac3').reason, inner[0].outcomes.get('Rac3').checked, inner[0].outcomes.get('Rac3').class], ['in_flight', false, 'not_now']);
 assert.deepEqual([pending().Rac3.attempts, pending().Rac3.reservation, outer.outcomes.get('Rac3').checked], [1, undefined, true], 'the holder charged once and released the reservation');
 // a reservation left by a step that was cut off expires: a later step takes the check over (bounded crash recovery)
 reset(); await seed('Rac5', 3); site.set('Rac5', {status: 404}); putDoc({Rac5: {reason: 'checking', class: 'not_now', slug: 'rac', attempts: 0, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: null, nextAttemptAt: '2026-11-01T00:00:00.000Z', reservation: {checkId: 'dead', until: new Date(NOW + 60000).toISOString(), route: 'ratings_diary'}}});
 out = await Identity.resolve(env, items(['Rac5', 'rac']), opts()); assert.equal(out.outcomes.get('Rac5').reason, 'in_flight'); assert.equal(net.calls.length, 0);
 out = await Identity.resolve(env, [], opts({clock: () => NOW + 120000})); assert.deepEqual([pending().Rac5.reason, pending().Rac5.attempts, pending().Rac5.reservation], ['not_found', 1, undefined]);
 // (d) effects: after the reservation and the intent, an owner action is refused until the admission and link are done; a foreign write that changes the entry before the intent fails the intent closed (no admission).
 reset(); await seed('Rac4', 3); add('Rac4', 'fixture-rac4-2000', '900301', 'Fixture Rac4', 2000); putDoc({Rac4: entryOf(0, {reason: 'forbidden', class: 'transport', slug: 'fixture-rac4-2000', streak: 1, nextAttemptAt: '2026-11-10T00:00:00.000Z'})});
 {let refused = null; const applyOriginal = ctx.CanonicalRatedAdmission.applyRatedAdmissionRetention;
  ctx.CanonicalRatedAdmission.applyRatedAdmissionRetention = async (envArg, input) => {refused = await ownerAct('dismiss', 'Rac4'); return applyOriginal(envArg, input);};
  await Identity.resolve(env, [], opts()); ctx.CanonicalRatedAdmission.applyRatedAdmissionRetention = applyOriginal;
  assert.equal(refused.state, 'check_in_flight', 'refused after the intent and before the canonical batch'); assert.equal(pending().Rac4, undefined); assert.equal(recordOf('Rac4').links.tmdb, '900301', 'the in-flight admission and link completed under their reservation');}
 reset(); await seed('Rac7', 3); add('Rac7', 'fixture-rac7-2000', '900303', 'Fixture Rac7', 2000); putDoc({Rac7: entryOf(0, {reason: 'forbidden', class: 'transport', slug: 'fixture-rac7-2000', streak: 1, nextAttemptAt: '2026-11-10T00:00:00.000Z'})});
 {const handler7 = net.handler; net.handler = async (url, init) => {const result = await handler7(url, init); if (url.includes('api.themoviedb.org')) putDoc({Rac7: entryOf(0, {reason: 'owner_dismissed', class: 'settled', nextAttemptAt: null})}); return result;};
  const appliedBefore = canonical.applied.length; await Identity.resolve(env, [], opts());
  net.handler = handler7; assert.equal(canonical.applied.length, appliedBefore, 'no admission over an entry a foreign writer changed during the check'); assert.equal(pending().Rac7.reason, 'owner_dismissed');}
 // a trusted-bridge repair is reserved too: an owner action during its local link is refused
 reset(); await seed('Rac8', 3); canonical.bridge.Rac8 = {state: 'ok', filmId: 'film:tmdb:900304', tmdb: '900304', lid: 'Rac8'}; putDoc({Rac8: entryOf(0, {reason: 'forbidden', class: 'transport', slug: 'rac8', streak: 1, nextAttemptAt: '2026-11-10T00:00:00.000Z'})});
 {let refused = null; const original = Facts.bridgeDiaryFilm; Facts.bridgeDiaryFilm = async (...args) => {Facts.bridgeDiaryFilm = original; refused = await ownerAct('requeue', 'Rac8'); return original(...args);};
  await Identity.resolve(env, [], opts()); assert.equal(refused.state, 'check_in_flight'); assert.equal(recordOf('Rac8').links.tmdb, '900304');}
 // a confirmed-admission link repair (`link_failed`) is reserved as well: an owner action during its local link is refused
 reset(); await seed('Rac9', 3); putDoc({Rac9: entryOf(0, {reason: 'link_failed', class: 'intent', tmdb: '900305', slug: 'rac9', nextAttemptAt: '2026-11-10T00:00:00.000Z'})});
 {let refused = null; const original = Facts.bridgeDiaryFilm; Facts.bridgeDiaryFilm = async (...args) => {Facts.bridgeDiaryFilm = original; refused = await ownerAct('dismiss', 'Rac9'); return original(...args);};
  await Identity.resolve(env, [], opts()); assert.equal(refused.state, 'check_in_flight'); assert.equal(recordOf('Rac9').links.tmdb, '900305');}
}
// P4: an id refused at the cap keeps the attempts of its Watchlist row; the other caller materializes the entry with them, not with 0.
{
 reset(); await seed('Bud9', 3); site.set('Bud9', {status: 404});
 {const films = {}; for (let i = 0; i < 200; i++) films['F' + String(i).padStart(3, '0')] = {reason: 'forbidden', class: 'transport', slug: 'f', attempts: 1, streak: 1, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-17T00:00:00.000Z', nextAttemptAt: '2026-11-30T00:00:00.000Z'}; putDoc(films);}
 out = await Identity.resolve(env, [{lid: 'Bud9', slug: 'bud9', attempts: 5}], opts({route: 'watchlist_admission'}));
 assert.equal(out.outcomes.get('Bud9').reason, 'diary_cap'); assert.equal(backlogOf().Bud9.attempts, 5, 'the backlog keeps the row budget');
 const {version} = await Facts.readDiaryIdentityVersioned(env); await Facts.ownerAction(env, {action: 'dismiss', lids: ['F000'], expectedVersion: version, by: 'o', why: 'w', at: 'a'});
 out = await Identity.resolve(env, items(['Other1', 'other-1']), opts({clock: () => NOW + 1000, route: 'ratings_diary'}));
 assert.equal(pending().Bud9.attempts, 6, 'the Diary caller materializes the entry with the row budget: one 404 reaches the cap, not 1'); assert.equal(out.outcomes.get('Bud9').terminal, true);
 // an owner reset is intentional: requeue of the backlog id sets the budget to 0
 reset(); putDoc({}); const created = await Facts.ownerAction(env, {action: 'requeue', createMissing: true, lids: ['Bud8'], slugs: {}, expectedVersion: (await Facts.readDiaryIdentityVersioned(env)).version, by: 'o', why: 'w', at: 'a'}); assert.equal(backlogOf().Bud8.attempts, 0);
}
// P4b: an entry the other caller already materialized with fewer attempts than the Watchlist row holds is raised to the row's budget by the next real check.
{
 reset(); await seed('Bud7', 3); site.set('Bud7', {status: 404});
 putDoc({Bud7: {reason: 'not_found', class: 'gone', slug: 'b7', attempts: 1, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-11T00:00:00.000Z'}});
 out = await Identity.resolve(env, [{lid: 'Bud7', slug: 'b7', attempts: 5}], opts({route: 'watchlist_admission'}));
 assert.deepEqual([pending().Bud7.attempts, out.outcomes.get('Bud7').terminal], [6, true], 'the row budget (5) and the new 404 make 6');
}
// P4c: a non-source outcome (a missing slug) also starts from the row budget, not from the smaller entry count.
{
 reset(); await seed('Bud6', 3);
 putDoc({Bud6: {reason: 'not_found', class: 'gone', slug: null, attempts: 1, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-11T00:00:00.000Z'}});
 out = await Identity.resolve(env, [{lid: 'Bud6', slug: null, attempts: 5}], opts({route: 'watchlist_admission'}));
 assert.deepEqual([pending().Bud6.reason, pending().Bud6.attempts, out.outcomes.get('Bud6').terminal], ['slug_missing', 6, true]);
}
// P1: a caller without a slug (the first-seen snapshot is gone) is served by the slug the shared entry already holds, never `slug_missing`.
{
 reset(); await seed('Slp1', 3); add('Slp1', 'fixture-slp1-2000', '900302', 'Fixture Slp1', 2000);
 putDoc({Slp1: {reason: 'forbidden', class: 'transport', slug: 'fixture-slp1-2000', attempts: 2, streak: 1, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-10T00:00:00.000Z'}});
 out = await Identity.resolve(env, [{lid: 'Slp1', slug: null, attempts: 2}], opts({route: 'watchlist_admission'}));
 assert.equal(out.counts.verified, 1, 'the stored slug carried the check'); assert.equal(pending().Slp1, undefined);
}

// ---- AIR-599 second review of PR #1009 ----
// The cap applies to the EFFECTIVE count before any check: a row budget at the cap with no entry, and an entry below a legacy row/backlog budget at the cap, never reach the source and never write attempts above the cap.
{
 reset(); await seed('Cap7', 3); site.set('Cap7', {status: 404});
 out = await Identity.resolve(env, [{lid: 'Cap7', slug: 'cap7', attempts: 6, reason: 'not_found'}], opts({route: 'watchlist_admission'}));
 assert.equal(net.calls.length, 0, 'no source check for an id whose row budget is at the cap'); assert.deepEqual([pending().Cap7.attempts, pending().Cap7.reason, out.outcomes.get('Cap7').terminal, out.outcomes.get('Cap7').checked], [6, 'not_found', true, false], 'the count is held on the entry');
 reset(); await seed('Cap8', 3); site.set('Cap8', {status: 404});
 putDoc({Cap8: {reason: 'not_found', class: 'gone', slug: 'cap8', attempts: 3, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-11T00:00:00.000Z'}});
 out = await Identity.resolve(env, [{lid: 'Cap8', slug: 'cap8', attempts: 6, reason: 'not_found'}], opts({route: 'watchlist_admission'}));
 assert.equal(net.calls.length, 0, 'an entry below a legacy row budget at the cap is not checked'); assert.deepEqual([pending().Cap8.attempts, out.outcomes.get('Cap8').terminal], [6, true], 'the entry is raised to the row budget, never to 7');
 // a backlog record at the cap (the budget travelled with it) is not checked either
 reset(); await seed('Cap9', 3); site.set('Cap9', {status: 404}); putDoc({}); await Facts.updateDiaryIdentity(env, {backlogAdd: {Cap9: {slug: 'cap9', queuedAt: '2026-11-01T00:00:00.000Z', attempts: 6}}});
 out = await Identity.resolve(env, [], opts({route: 'ratings_diary'})); assert.equal(net.calls.length, 0); assert.ok(pending().Cap9.attempts <= 6, 'never above the cap: ' + JSON.stringify(pending().Cap9));
}
// The reservation enforces the cap authoritatively: a document that fills between the step's read and its reservation refuses the id (no check; the id waits in the backlog with its budget).
{
 const films = {}; for (let i = 0; i < 199; i++) films['G' + String(i).padStart(3, '0')] = {reason: 'forbidden', class: 'transport', slug: 'g', attempts: 1, streak: 1, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-17T00:00:00.000Z', nextAttemptAt: '2026-11-30T00:00:00.000Z'};
 reset(); await seed('Rf01', 3); site.set('Rf01', {status: 404}); putDoc(films);
 {const original = Facts.diaryLinks; Facts.diaryLinks = async (...args) => {Facts.diaryLinks = original; await Facts.updateDiaryIdentity(env, {set: {Fill1: {reason: 'forbidden', class: 'transport', slug: 'f', attempts: 1, streak: 1, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-17T00:00:00.000Z', nextAttemptAt: '2026-11-30T00:00:00.000Z'}}}); return original(...args);};}
 out = await Identity.resolve(env, [{lid: 'Rf01', slug: 'rf01', attempts: 3}], opts({route: 'watchlist_admission'}));
 assert.equal(net.calls.length, 0, 'no check for an id the full document refused'); assert.equal(out.outcomes.get('Rf01').reason, 'diary_cap'); assert.equal(pending().Rf01, undefined);
 assert.deepEqual([backlogOf().Rf01?.attempts, backlogOf().Rf01?.slug], [3, 'rf01'], 'the id and its budget wait in the backlog');
}
// An owner action that lands while a step has read the backlog but not yet reserved the id: the step reserves nothing, checks nothing and writes no stale seed.
{
 const intakeHook = async (work) => {const original = Facts.diaryLinks; Facts.diaryLinks = async (...args) => {Facts.diaryLinks = original; await work(); return original(...args);};};
 const fullDoc = () => {const films = {}; for (let i = 0; i < 199; i++) films['F' + String(i).padStart(3, '0')] = {reason: 'forbidden', class: 'transport', slug: 'f', attempts: 1, streak: 1, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-17T00:00:00.000Z', nextAttemptAt: '2026-11-30T00:00:00.000Z'}; return films;};
 // (a) the owner REQUEUES the backlog record (budget 5 -> 0) after the step read it: the stale seed 5 is not written, no check runs.
 reset(); await seed('Ik01', 3); site.set('Ik01', {status: 404}); putDoc(fullDoc()); await Facts.updateDiaryIdentity(env, {backlogAdd: {Ik01: {slug: 'ik01', queuedAt: '2026-11-01T00:00:00.000Z', attempts: 5}}});
 await intakeHook(async () => {const {version} = await Facts.readDiaryIdentityVersioned(env); const r = await Facts.ownerAction(env, {action: 'requeue', lids: ['Ik01'], expectedVersion: version, by: 'o', why: 'w', at: 'a'}); assert.equal(r.state, 'applied');});
 out = await Identity.resolve(env, [], opts());
 assert.equal(net.calls.length, 0, 'no check over an owner reset'); assert.equal(pending().Ik01, undefined, 'no entry with the stale seed'); assert.equal(backlogOf().Ik01.attempts, 0, 'the owner reset stands'); assert.equal(out.counts.entryChanged, 1);
 // (b) the owner DISMISSES the backlog record after the step read it: it is not resurrected as an entry.
 reset(); await seed('Ik02', 3); site.set('Ik02', {status: 404}); putDoc(fullDoc()); await Facts.updateDiaryIdentity(env, {backlogAdd: {Ik02: {slug: 'ik02', queuedAt: '2026-11-01T00:00:00.000Z', attempts: 2}}});
 await intakeHook(async () => {const {version} = await Facts.readDiaryIdentityVersioned(env); await Facts.ownerAction(env, {action: 'dismiss', lids: ['Ik02'], expectedVersion: version, by: 'o', why: 'w', at: 'a'});});
 await Identity.resolve(env, [], opts()); assert.equal(net.calls.length, 0); assert.equal(pending().Ik02, undefined); assert.equal(backlogOf().Ik02, undefined, 'a dismissed backlog id stays dismissed');
 // (c) the owner action is also honoured when an entry AND a backlog record both exist (the three-place state): one requeue resets both.
 reset(); putDoc({Both9: {reason: 'not_found', class: 'gone', slug: 'b9', attempts: 6, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-11T00:00:00.000Z'}}); await Facts.updateDiaryIdentity(env, {backlogAdd: {Both9: {slug: 'b9', queuedAt: '2026-11-01T00:00:00.000Z', attempts: 5}}});
 {const doc = records.get(Facts.DIARY_IDENTITY_KEY); doc.backlog = {Both9: {slug: 'b9', queuedAt: '2026-11-01T00:00:00.000Z', attempts: 5}}; records.set(Facts.DIARY_IDENTITY_KEY, doc); etags.set(Facts.DIARY_IDENTITY_KEY, String(++rev));}
 const {version: bv} = await Facts.readDiaryIdentityVersioned(env); const both = await Facts.ownerAction(env, {action: 'requeue', lids: ['Both9'], expectedVersion: bv, by: 'o', why: 'w', at: 'a'});
 assert.deepEqual([both.entries.Both9.attempts, both.backlog.Both9.attempts], [0, 0], 'a requeue resets every place that holds the id');
}

// AIR-599 (fourth review of PR #1009): no effect starts so late that the reservation could expire under it. With no caller deadline (Infinity) a step whose clock has run to the end of the reservation (less the margin)
// makes no source request: the id is deferred, nothing is charged.
{
  reset(); await seed('Late1', 3); add('Late1', 'fixture-late-2001', '900777', 'Fixture Late', 2001);
  let ticks = 0;
  const out = await Identity.resolve(env, items(['Late1', 'fixture-late-2001']), {clock: () => (ticks++ === 0 ? NOW : NOW + 4.9 * 60000), remaining: () => Infinity, fetchImpl: ctx.fetch});
  assert.equal(net.calls.length, 0, 'no request after the reservation window is spent');
  assert.equal(out.counts.checked, 0);
}

// AIR-599 (fifth review of PR #1009): the LOCAL effects (a trusted-bridge link, a `link_failed` completion) never start once the reservation window is spent, whatever lease the caller has.
{
  reset(); await seed('LateB', 3); canonical.bridge.LateB = {state: 'ok', filmId: 'film:tmdb:900801', tmdb: '900801', lid: 'LateB'};
  let ticks = 0;
  const out = await Identity.resolve(env, items(['LateB', 'fixture-lateb-2002']), {clock: () => (ticks++ === 0 ? NOW : NOW + 4.9 * 60000), remaining: () => Infinity, fetchImpl: ctx.fetch});
  assert.equal(out.counts.bridged, 0, 'no trusted-bridge link after the window');
  assert.equal((await Facts.diaryLinks(env, ['LateB'])).get('LateB')?.tmdb ?? null, null, 'no TMDB link was written');
  assert.equal(pending().LateB?.reservation, undefined, 'no reservation is left behind');
}

// the window can also run out BETWEEN the reservation, the intent and the link: the local effect re-checks right before it commits
{
  reset(); await seed('LateC', 3); canonical.bridge.LateC = {state: 'ok', filmId: 'film:tmdb:900802', tmdb: '900802', lid: 'LateC'};
  let jumped = false, writes = 0; const original = Facts.updateDiaryIdentity;
  Facts.updateDiaryIdentity = async (...args) => {const out = await original(...args); if (++writes === 2) jumped = true; return out;};
  let out;
  try {out = await Identity.resolve(env, items(['LateC', 'fixture-latec-2003']), {clock: () => (jumped ? NOW + 4.9 * 60000 : NOW), remaining: () => Infinity, fetchImpl: ctx.fetch});}
  finally {Facts.updateDiaryIdentity = original;}
  assert.equal(out.counts.bridged, 0, 'no trusted-bridge link after the window ran out between the intent and the link');
  assert.equal((await Facts.diaryLinks(env, ['LateC'])).get('LateC')?.tmdb ?? null, null);
}

// AIR-604 (ADR 0211 decision 5): a shared-cooldown skip is a transport stop that costs no attempt and whose retry time is the LATER of the local transport backoff and the shared cooldown end.
{
 const skipWith = until => async () => {throw Object.assign(new Error('upstream_cooldown'), {code: 'upstream_cooldown', until});};
 reset(); await seed('Ck01', 3); site.set('Ck01', {status: 404});
 const farUntil = NOW + 4 * 3600000;
 out = await Identity.resolve(env, items(['Ck01', 'x']), opts({fetchImpl: skipWith(farUntil)}));
 assert.deepEqual(net.calls, [], 'no request was sent');
 assert.deepEqual([pending().Ck01.reason, pending().Ck01.attempts, pending().Ck01.streak, pending().Ck01.nextAttemptAt], ['upstream_cooldown', 0, 1, new Date(farUntil).toISOString()], 'no attempt charged; due at the cooldown end, later than the 15 min backoff');
 assert.equal(out.outcomes.get('Ck01').retryAt, new Date(farUntil).toISOString());
 reset(); await seed('Ck02', 3);
 out = await Identity.resolve(env, items(['Ck02', 'x']), opts({fetchImpl: skipWith(NOW + 60000)}));
 assert.equal(pending().Ck02.nextAttemptAt, new Date(NOW + 15 * 60000).toISOString(), 'a short cooldown never shortens the local backoff');
 assert.equal(pending().Ck02.attempts, 0);
}

// AIR-604 (review of PR #1021, second round): a recognized blocking response stays a TRANSPORT stop whatever happened to its body. With coordination active, an oversized or unreadable HTTP 403 or 429
// and a header challenge never charge the Diary/Watchlist identity attempt (they would otherwise be a definite `oversized`/`fetch_failed` answer and push an item to the six-attempt cap);
// `off` (no coordinator on the fetch) keeps today's classification exactly.
{
 const U = await import('../src/upstream-cooldown.js');
 const coordinated = base => {const f = async (url, init) => base(url, init); f.coordinator = {after: async (scope, response) => U.classifySignal(response)}; return f;};
 const big = 'x'.repeat(3000001);
 const unreadable = status => ({status, ok: false, headers: headersOf({}), async text() {throw new Error('read failed');}});
 const cases = [
  ['oversized 403', () => http(403, big), 'forbidden'],
  ['oversized 429', () => http(429, big), 'rate_limited'],
  ['unreadable 403', () => unreadable(403), 'forbidden'],
  ['unreadable 429', () => unreadable(429), 'rate_limited'],
  ['oversized header challenge on a 200', () => http(200, big, {'cf-mitigated': 'challenge'}), 'challenge'],
  ['unreadable header challenge on a 200', () => ({status: 200, ok: true, headers: headersOf({'cf-mitigated': 'challenge'}), async text() {throw new Error('read failed');}}), 'challenge'],
  ['body-only challenge on a 200', () => http(200, '<html><head><title>Just a moment...</title></head>cf-chl-opt</html>'), 'challenge'],
 ];
 for (const [label, reply, reason] of cases) {
  reset(); await seed('Sg01', 3);
  out = await Identity.resolve(env, items(['Sg01', 'x']), opts({fetchImpl: coordinated(async () => reply())}));
  assert.deepEqual([pending().Sg01?.reason, pending().Sg01?.attempts, pending().Sg01?.streak], [reason, 0, 1], label + ': a transport stop, no attempt charged');
  assert.equal(out.outcomes.get('Sg01').class, 'transport', label);
  assert.equal(out.outcomes.get('Sg01').terminal, false, label);
 }
 // repeated blocks never reach the review cap: six oversized 403s still cost no attempt
 reset(); await seed('Sg02', 3); let clock = NOW;
 for (let i = 0; i < 7; i++) {out = await Identity.resolve(env, items(['Sg02', 'x']), {...opts({fetchImpl: coordinated(async () => http(403, big))}), clock: () => clock}); clock += 9 * 3600000;}
 assert.equal(pending().Sg02.attempts, 0, 'seven blocked answers charged nothing'); assert.equal(pending().Sg02.reason, 'forbidden');
 // off (no coordinator): today's classification, an oversized 403 is a definite answer
 reset(); await seed('Sg03', 3);
 out = await Identity.resolve(env, items(['Sg03', 'x']), opts({fetchImpl: async () => http(403, big)}));
 assert.equal(pending().Sg03.reason, 'oversized', 'without coordination the oversized body is classified as today'); assert.equal(pending().Sg03.attempts, 1);
}

console.log('letterboxd-diary-identity: ok');
