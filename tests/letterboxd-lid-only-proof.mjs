// AIR-672 / ADR 0217 (Accepted) decisions 2, 3 and 7, tests 1 and 3: the PURE, DORMANT H1 page proof and its recomputable digest. Synthetic pages only, parsed by the REAL page parser (pageEvidence).
// Synthetic markup proves the code, never the upstream: the real absence marker and the eligible page types are fixed at ADR 0217 delivery step 8, so the shipped rules are EMPTY and fail closed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped, scopedReplacing} from '../scripts/bundle-scope.mjs';
import {H1_RULES, LID_ONLY_PROOF_VERSION, lidOnlyPageProof, lidOnlyProofDigest, normalizeFilmUrl} from '../src/domain/letterboxd-lid-only-proof.js';

const ctx = vm.createContext({Response, Headers, URL, Date, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, console});
const run = file => vm.runInContext(fs.readFileSync(file, 'utf8').replace(/^export default/m, 'globalThis.x='), ctx);
run('src/domain/tmdb-tv-identity.js'); run('src/sources.js');
vm.runInContext(scoped('src/letterboxd-match.js', 'LetterboxdMatch') + '\n' + scopedReplacing('src/letterboxd-identity.js', 'LetterboxdIdentity', 'const normTitle=LetterboxdMatch.normTitle;\n'), ctx);
const LI = vm.runInContext('LetterboxdIdentity', ctx), tools = vm.runInContext('letterboxdPageTools()', ctx);

const RULES = {eligibleTypes: ['video.movie'], idBlockMarker: '<section class="film-ids">'};
const LID = 'Ab12', SLUG = 'some-short-1999';
const page = ({lid = LID, slug = SLUG, title = 'Some Short', year = 1999, ids = '', type = 'video.movie', block = true, canonicalSlug = slug, shortlink = true, extra = '', close = true} = {}) =>
  '<html><head><link rel="canonical" href="https://letterboxd.com/film/' + canonicalSlug + '/">' + (shortlink ? '<link rel="shortlink" href="https://boxd.it/' + lid + '">' : '')
  + (type ? '<meta property="og:type" content="' + type + '">' : '') + (year ? '<meta property="og:title" content="' + title + ' (' + year + ')"><script type="application/ld+json">' + JSON.stringify({name: title, releasedEvent: [{startDate: String(year)}]}) + '</script>' : '<meta property="og:title" content="' + title + '"><script type="application/ld+json">' + JSON.stringify({name: title}) + '</script>')
  + '</head><body class="film" ' + ids + '>' + (block ? '<section class="film-ids"></section>' : '') + extra + '</body>' + (close ? '</html>' : '');
const check = async ({html = page(), landing = 'https://letterboxd.com/film/' + SLUG + '/', redirect = {status: 301}, fetched = null, rules = RULES, lid = LID} = {}) => {
  const f = fetched || {html, landing: new URL(landing)};
  const evidence = f.html ? LI.pageEvidence(f.html, f.landing, tools) : null;
  return lidOnlyPageProof({lid, redirect, fetched: f, evidence, rules, checkedAt: '2026-11-27T10:00:00.000Z'});
};
const nothing = async (label, input, state) => { const out = await check(input); assert.equal(out.admits, false, label + ': never admits'); assert.equal(out.proof, undefined, label + ': no proof'); if (state) assert.equal(out.state, state, label); return out; };

// the shipped rules are empty and fail closed: not even a perfect page passes before step 8
assert.deepEqual([H1_RULES.eligibleTypes.length, H1_RULES.idBlockMarker], [0, null]);
assert.ok(Object.isFrozen(H1_RULES) && Object.isFrozen(H1_RULES.eligibleTypes));
assert.equal((await lidOnlyPageProof({lid: LID, redirect: {status: 301}, fetched: {html: page(), landing: new URL('https://letterboxd.com/film/' + SLUG + '/')}, evidence: LI.pageEvidence(page(), new URL('https://letterboxd.com/film/' + SLUG + '/'), tools)})).admits, false, 'default rules admit nothing');

// 1. the valid page: tmdb_none with every proof column, and the digest recomputes from them
const ok = await check();
assert.deepEqual([ok.state, ok.admits, ok.outcome, ok.retryClass], ['tmdb_none', true, 'admitted_lid_only', null]);
const p = ok.proof;
assert.deepEqual([p.proofVersion, p.lid, p.finalUrl, p.slug, p.canonicalPath, p.shortlink, p.typeMarker, p.idBlockOutcome, p.completenessOutcome, p.title, p.year, p.redirectStatus, p.pageStatus],
  [LID_ONLY_PROOF_VERSION, LID, 'https://letterboxd.com/film/' + SLUG + '/', SLUG, '/film/' + SLUG + '/', LID, 'video.movie', 'absent', 'complete', 'Some Short', 1999, 301, 200]);
assert.match(p.proofDigest, /^[0-9a-f]{64}$/);
assert.equal(await lidOnlyProofDigest(p), p.proofDigest, 'recomputes from the columns');
for (const [key, value] of Object.entries({lid: 'Zz9', finalUrl: 'https://letterboxd.com/film/x/', slug: 'x', canonicalPath: '/film/x/', typeMarker: 'other', title: 'Other', year: 2000, proofVersion: 2, idBlockOutcome: 'present', completenessOutcome: 'truncated'})) {
  assert.notEqual(await lidOnlyProofDigest({...p, [key]: value}), p.proofDigest, key + ' is bound by the digest');
}
assert.equal(await lidOnlyProofDigest({...p, year: null}) === await lidOnlyProofDigest({...p, year: undefined}), true, 'unknown year is null');
// route observation metadata is NOT in the root: another route and time give the same digest
assert.equal((await check({redirect: {status: 302}})).proof.proofDigest, p.proofDigest);
assert.equal(p.checkedAt, '2026-11-27T10:00:00.000Z');
// a page without a year is admitted with year unknown (lid-only only)
const noYear = await check({html: page({year: null})});
assert.deepEqual([noYear.state, noYear.proof.year], ['tmdb_none', null]);
assert.notEqual(noYear.proof.proofDigest, p.proofDigest);

// 2./3. an unproved input is never proof
await nothing('invalid lid', {lid: 'a b'}, 'lid_unverified');
await nothing('no redirect', {redirect: {status: 200}}, 'page_not_read');
await nothing('no redirect object', {redirect: null}, 'page_not_read');
await nothing('shortlink of another lid', {html: page({lid: 'Zz9'})}, 'page_refused');
await nothing('shortlink missing', {html: page({shortlink: false})}, 'page_refused');
await nothing('canonical differs', {html: page({canonicalSlug: 'another-1999'})}, 'page_refused');
await nothing('landing is not the page path', {landing: 'https://letterboxd.com/film/another-1999/'}, 'page_refused');
await nothing('landing off site', {landing: 'https://example.com/film/' + SLUG + '/'}, 'page_not_read');
await nothing('title empty', {html: page({title: ' '})});
// 3. TMDB states: only tmdb_none admits
await nothing('page names a movie id', {html: page({ids: 'data-tmdb-type="movie" data-tmdb-id="900001"'})}, 'page_movie');
await nothing('page names a tv id', {html: page({ids: 'data-tmdb-type="tv" data-tmdb-id="900001"'})}, 'tmdb_tv');
await nothing('stray TMDB id without a type is not "no TMDB"', {html: page({ids: 'data-tmdb-id="900001"'})}, 'tmdb_unreadable');
await nothing('a TMDB link in the markup', {html: page({extra: '<a href="https://www.themoviedb.org/movie/1/">x</a>'})}, 'tmdb_unreadable');
await nothing('truncated page', {html: page({close: false})}, 'tmdb_unreadable');
await nothing('id block missing', {html: page({block: false})}, 'tmdb_unreadable');
await nothing('id block twice', {html: page({extra: '<section class="film-ids"></section>'})}, 'tmdb_unreadable');
await nothing('type marker missing', {html: page({type: null})}, 'tmdb_unreadable');
await nothing('unconfigured id block marker', {rules: {eligibleTypes: ['video.movie'], idBlockMarker: null}}, 'tmdb_unreadable');
await nothing('malformed marker rule', {rules: {eligibleTypes: ['video.movie'], idBlockMarker: '('}}, 'tmdb_unreadable');
const other = await nothing('readable but other page type', {html: page({type: 'video.episode'})}, 'page_type_ineligible');
assert.deepEqual([other.outcome, other.retryClass, other.typeMarker], ['page_type_ineligible', 'definite', 'video.episode']);
await nothing('a type outside the list, empty list', {rules: {eligibleTypes: [], idBlockMarker: RULES.idBlockMarker}}, 'page_type_ineligible');
await nothing('two disagreeing years', {html: page({year: 1999}).replace('"startDate":"1999"', '"startDate":"2001"')});
// the page's own transport answers keep the existing states and never become "no TMDB"
await nothing('challenge', {fetched: {stop: 'challenge'}}, 'tmdb_unavailable');
await nothing('rate limited', {fetched: {stop: 'rate_limited'}}, 'tmdb_unavailable');
await nothing('oversized', {fetched: {stop: 'oversized'}}, 'tmdb_unreadable');
await nothing('page 404', {fetched: {review: 'fetch_failed', status: 404}}, 'page_not_read');
await nothing('page 503', {fetched: {review: 'fetch_failed', status: 503}}, 'tmdb_unavailable');
await nothing('no fetch result', {fetched: {}}, 'tmdb_unreadable');

// the normalized final URL (decision 8b): https, lowercase host, no query or fragment, one trailing slash; nothing else
assert.equal(normalizeFilmUrl('https://Letterboxd.com/film/x//?a=1#b'), 'https://letterboxd.com/film/x/');
assert.equal(normalizeFilmUrl('http://letterboxd.com/film/x/'), null);
assert.equal(normalizeFilmUrl('https://letterboxd.com:8443/film/x/'), null);
assert.equal(normalizeFilmUrl('https://u@letterboxd.com/film/x/'), null);
assert.equal(normalizeFilmUrl('nope'), null);
console.log('Letterboxd lid-only page proof (AIR-672) passed.');
