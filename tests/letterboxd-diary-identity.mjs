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
const reset = () => {records.clear(); etags.clear(); site.clear(); tmdbDocs.clear(); net.calls.length = 0; canonical.bridge = {}; canonical.applied.length = 0; canonical.failWith = null; canonical.result = null; canonical.bridgeThrows = null; slow.on = null; canonical.gate = {mode: 'd1', state: 'open', generation: 2};};
const seed = async (lid, rating, date = '2026-11-15') => Facts.applyDiaryEvidence(env, [{lid, watchedDate: date, rating, ratingState: 'rated', sourceRef: 'diary:viewing:1'}]);
const add = (lid, slug, tmdb, title, year, extra = {}) => {site.set(lid, {landing: slug, html: filmPage({lid, slug, title, year, tmdbIds: [tmdb], ...extra})}); tmdbDocs.set(tmdb, detail(tmdb, title, year));};
const NOW = Date.parse('2026-11-17T16:01:00.000Z');
const opts = (extra = {}) => ({clock: () => NOW, remaining: () => 120000, fetchImpl: ctx.fetch, ...extra});
const items = (...lids) => lids.map(([lid, slug]) => ({lid, slug}));
const recordOf = lid => records.get('letterboxd/facts/films/lb-' + lid + '.json');
const pending = () => records.get(Facts.DIARY_IDENTITY_KEY)?.films || {};

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
assert.equal(out.counts.pending, 1); assert.equal(pending().Aj8u.reason, 'forbidden'); assert.equal(pending().Aj8u.attempts, 1);
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
  const expected = reason === 'challenge' ? 'challenge' : reason;
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
assert.equal(pending().Slw2.reason, 'budget'); assert.equal(canonical.applied.length, 0); assert.equal(recordOf('Slw2').links.tmdb, null); assert.equal(records.has('letterboxd/admissions/verified-films.json'), false, 'no receipt without the write reserve');
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
  assert.deepEqual({...pending().Tmp1}, {reason: 'deferred', slug: 'fixture-tmp-2011', attempts: 0, lastAttemptAt: null, nextAttemptAt: new Date(NOW).toISOString()}, name);
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
out = await Identity.resolve(env, items(['Frs1', 'fixture-frs1-2006'], ['Frs2', 'fixture-frs2-2006'], ['Frs3', 'fixture-frs3-2006'], ['Old1', 'old-one']), opts());
assert.equal(out.counts.verified, 3); assert.equal(out.counts.deferred, 1); assert.deepEqual(pending().Old1, oldEntry, 'attempts, reason and backoff are not reset by a deferral');

// 17. review of PR #720 (fifth), P1: a durable link intent precedes every non-atomic effect, so a lost final pending write after a partial commit is still repaired off-page.
const prjView = tmdb => records.get('enrichment/view-index.json')?.['tmdb_' + tmdb];
// (a) alias + record committed, projection throws, and the final pending write is lost: the intent survives; a later step on another page repairs the projection.
reset(); fail.view = 0; fail.identity = null; await seed('Crs1', 4); add('Crs1', 'fixture-crs-2005', '900130', 'Fixture Crs', 2005); fail.view = 1; fail.identity = 1;
out = await Identity.resolve(env, items(['Crs1', 'fixture-crs-2005']), opts()); fail.identity = null;
assert.equal(out.counts.persistFailed, 1); assert.equal(pending().Crs1.reason, 'linking', 'the intent written before the effects survives the lost final write'); assert.equal(pending().Crs1.tmdb, '900130');
assert.equal(recordOf('Crs1').links.tmdb, '900130'); assert.equal(prjView('900130'), undefined); assert.equal(canonical.applied.length, 1);
let crsCalls = net.calls.length;
out = await Identity.resolve(env, items(['Other6', 'other-6']), opts({clock: () => NOW + 1000}));
assert.equal(out.counts.repaired, 1); assert.equal(prjView('900130').watched, true); assert.equal(prjView('900130').actualRating, 4); assert.equal(pending().Crs1, undefined);
assert.equal(net.calls.filter(url => url.includes('Crs1') || url.includes('fixture-crs')).length, 0 + net.calls.slice(0, crsCalls).filter(url => url.includes('Crs1') || url.includes('fixture-crs')).length, 'no source request for the repair'); assert.equal(canonical.applied.length, 1, 'no second admission');
// (b) a link_failed at attempts = 6 (the source cap) is still repaired off-page, without a source request or a new admission.
reset(); fail.view = 0; fail.identity = null; await seed('Cap6', 3); add('Cap6', 'fixture-cap6-2004', '900131', 'Fixture Cap6', 2004);
await bucket.put(Facts.DIARY_IDENTITY_KEY, JSON.stringify({schemaVersion: 1, films: {Cap6: {reason: 'forbidden', slug: 'fixture-cap6-2004', attempts: 5, lastAttemptAt: '2026-11-17T10:00:00.000Z', nextAttemptAt: '2026-11-17T12:00:00.000Z'}}}));
fail.view = 1; await Identity.resolve(env, items(['Cap6', 'fixture-cap6-2004']), opts());
assert.deepEqual([pending().Cap6.reason, pending().Cap6.attempts], ['link_failed', 6]); crsCalls = net.calls.length;
out = await Identity.resolve(env, items(['Other5', 'other-5']), opts({clock: () => NOW + 1000}));
assert.equal(out.counts.repaired, 1, 'the cap on source attempts does not stop a repair'); assert.equal(prjView('900131').watched, true); assert.equal(pending().Cap6, undefined);
assert.equal(net.calls.slice(crsCalls).filter(url => url.includes('Cap6') || url.includes('fixture-cap6')).length, 0); assert.equal(canonical.applied.length, 1);
// (c) the intent cannot be written: fail closed, no receipt, no admission, no alias.
reset(); fail.view = 0; fail.identity = 0; await seed('Fcl1', 3); add('Fcl1', 'fixture-fcl-2003', '900132', 'Fixture Fcl', 2003);
out = await Identity.resolve(env, items(['Fcl1', 'fixture-fcl-2003']), opts()); fail.identity = null;
assert.equal(out.counts.persistFailed, 1); assert.equal(canonical.applied.length, 0); assert.equal(records.has('letterboxd/admissions/verified-films.json'), false); assert.equal(recordOf('Fcl1').links.tmdb, null);
// (d) a kill after the intent and before the alias (admission refused, final write lost): the intent is served later off-page and the source check completes it.
reset(); fail.view = 0; fail.identity = 1; await seed('Kil1', 3); add('Kil1', 'fixture-kil-2002', '900133', 'Fixture Kil', 2002); canonical.failWith = 'canonical_write_unknown';
await Identity.resolve(env, items(['Kil1', 'fixture-kil-2002']), opts()); fail.identity = null; canonical.failWith = null;
assert.equal(pending().Kil1.reason, 'linking'); assert.equal(recordOf('Kil1').links.tmdb, null);
out = await Identity.resolve(env, items(['Other4', 'other-4']), opts({clock: () => NOW + 1000}));
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
assert.equal(claimCalls.length, 1); assert.deepEqual(claimCalls[0].pairs, [{lid: 'vMEO', tmdb: '900001'}]);
assert.deepEqual(claimCalls[0].linked, ['900001'], 'the Ratings link is durable before the claim is requested'); assert.deepEqual(claimCalls[0].pendingKeys, [], 'the pending document is settled first');
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
// a repaired link_failed bridge is offered
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
reset(); claimCalls.length = 0; claimStub.mode = 'inactive'; await seed('vMEO', 3.5); add('vMEO', 'fixture-alpha-2023', '900001', 'Fixture Alpha', 2023);
out = await Identity.resolve(env, items(['vMEO', 'fixture-alpha-2023']), opts()); assert.equal(out.counts.verified, 1); assert.deepEqual(Object.keys(pending()), []); assert.equal(out.counts.claim, undefined);
// a short lease skips the claim step (the rating and the Event never wait for it) and keeps the id due; an absent claim module is a no-op
reset(); claimCalls.length = 0; claimStub.mode = 'complete'; await seed('Brg1', 3); canonical.bridge.Brg1 = {state: 'ok', filmId: 'film:tmdb:900020', tmdb: '900020', lid: 'Brg1'};
out = await Identity.resolve(env, items(['Brg1', 'fixture-brg-2019']), opts({remaining: () => 1000})); assert.equal(claimCalls.length, 0); assert.equal(pending().Brg1.reason, 'claim_pending'); assert.equal(pending().Brg1.attempts, 0);
delete ctx.CanonicalLetterboxdClaim; reset(); await seed('Brg1', 3); canonical.bridge.Brg1 = {state: 'ok', filmId: 'film:tmdb:900020', tmdb: '900020', lid: 'Brg1'};
out = await Identity.resolve(env, items(['Brg1', 'fixture-brg-2019']), opts()); assert.equal(out.counts.bridged, 1); assert.equal(out.counts.claim, undefined); assert.deepEqual(Object.keys(pending()), []);

console.log('letterboxd-diary-identity: ok');
