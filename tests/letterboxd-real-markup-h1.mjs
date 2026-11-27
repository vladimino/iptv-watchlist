// AIR-678 / ADR 0217 delivery step 8: sanitized excerpts of REAL public Letterboxd film pages captured on 27 Nov 2026 (see docs/evidence/letterboxd/air-678-h1-real-markup-2026-11-27.md), parsed by the REAL page parser.
// They are TMDB-bearing CONTROLS. No real no-TMDB page was found, so this test pins what the parser and the dormant H1 proof do with real markup (the actual refusals) and proves no control is ever `tmdb_none`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped, scopedReplacing} from '../scripts/bundle-scope.mjs';
import {H1_RULES, lidOnlyPageProof} from '../src/domain/letterboxd-lid-only-proof.js';

const ctx = vm.createContext({Response, Headers, URL, Date, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, console});
const run = file => vm.runInContext(fs.readFileSync(file, 'utf8').replace(/^export default/m, 'globalThis.x='), ctx);
run('src/domain/tmdb-tv-identity.js'); run('src/sources.js');
vm.runInContext(scoped('src/letterboxd-match.js', 'LetterboxdMatch') + '\n' + scopedReplacing('src/letterboxd-identity.js', 'LetterboxdIdentity', 'const normTitle=LetterboxdMatch.normTitle;\n'), ctx);
const LI = vm.runInContext('LetterboxdIdentity', ctx), tools = vm.runInContext('letterboxdPageTools()', ctx);

const dir = 'tests/fixtures/air-678-letterboxd-real-markup/';
const cases = [
  // name, slug, lid, tmdb ids and types the parser reads, body tmdb id attribute, TMDB footer link
  ['movie-with-tmdb-id', 'toy-soldiers', '1Vuo', ['10750'], ['movie'], '10750', '/movie/10750/'],
  ['tv-zero-empty-body-id', 'twin-peaks-the-return', 'hN9O', [], ['movie'], '', '/tv/0/'],
  ['tv-empty-body-id', 'the-beatles-get-back', 'xo7A', [], ['movie'], '', '/tv/128876/']
];
// provisional rules a reviewer might propose from the og:type marker; even these must not admit a real TMDB-bearing page
const RULES = {eligibleTypes: ['video.movie'], idBlockMarker: '<p class="text-link text-footer">'};
for (const [name, slug, lid, ids, types, bodyId, link] of cases) {
  const html = fs.readFileSync(dir + name + '.html', 'utf8'), landing = new URL('https://letterboxd.com/film/' + slug + '/');
  // the real markup facts the ADR asked for
  assert.match(html, /<meta property="og:type" content="video\.movie">/, name + ': og:type is video.movie on every real capture');
  assert.ok(html.includes('<body class="film" data-type="film" data-tmdb-type="movie" data-tmdb-id="' + bodyId + '">'), name + ': body carries data-type="film"');
  assert.ok(html.includes('data-track-action="TMDB"') && html.includes('themoviedb.org' + link), name + ': the TMDB footer button holds ' + link);
  assert.ok(html.includes('<input id="url-field-film-0" type="text" value="https://boxd.it/' + lid + '"'), name + ': the shortlink lives in the url-field input');
  assert.ok(!/<link rel="(?:canonical|shortlink)"/.test(html), name + ': no link rel canonical/shortlink tag on a real page');
  // what the existing page parser reads from it today
  const evidence = LI.pageEvidence(html, landing, tools);
  assert.equal(JSON.stringify([evidence.tmdbIds, evidence.tmdbTypes]), JSON.stringify([ids, types]), name + ': ids and types');
  assert.deepEqual([evidence.shortCode, evidence.shortlinkPresent, evidence.canonicalPath], [null, false, null], name + ': the parser does not see the shortlink or canonical of a real page (finding)');
  // The dormant proof on the REAL parser output, with the shipped rules and with the provisional ones. The movie control is refused by the TMDB observation; the TV controls fail EARLIER, at check 4, because the
  // parser sees no shortlink on a real page. Neither outcome is a `tmdb_none`.
  const expected = name === 'movie-with-tmdb-id' ? ['page_movie', null] : ['page_refused', 'shortlink_missing'];
  const verdict = async (ev, rules) => lidOnlyPageProof({lid, redirect: {status: 302}, fetched: {html, landing}, evidence: ev, rules, checkedAt: '2026-11-27T10:00:00.000Z'});
  for (const rules of [H1_RULES, RULES]) {
    const out = await verdict(evidence, rules);
    assert.deepEqual([out.state, out.outcome ?? null, out.admits, out.proof], [...expected, false, undefined], name + ': real parser output');
  }
  // SYNTHETIC EVIDENCE ADAPTER over the same, unmodified real HTML. It is NOT a parser and NOT real evidence: it only fills what check 4 reads (the lid from the url-field input, the canonical path from og:url) so that
  // the proof reaches the TMDB relation guard. Both TV controls must still be refused there (`tmdb_unreadable`); the movie control is still `page_movie`.
  const fromUrlField = new RegExp('id="url-field-film-\\d+"[^>]*value="https://boxd\\.it/' + lid + '"').test(html), fromOgUrl = html.includes('property="og:url" content="https://letterboxd.com/film/' + slug + '/"');
  assert.ok(fromUrlField && fromOgUrl, name + ': the adapter inputs are present in the real HTML');
  const adapted = {...evidence, shortCode: lid, shortlinkPresent: true, canonicalPath: '/film/' + slug + '/'};
  for (const rules of [H1_RULES, RULES]) {
    const out = await verdict(adapted, rules);
    assert.deepEqual([out.state, out.admits, out.proof], [name === 'movie-with-tmdb-id' ? 'page_movie' : 'tmdb_unreadable', false, undefined], name + ': synthetic adapter, TMDB relation guard');
  }
}
// Not eligibility evidence: `data-type="film"` and `og:type=video.movie` are carried by BOTH TV controls, so neither marker separates a feature film from a TV entity. The raw relation guard of the proof also rejects any
// `data-tmdb-type` attribute, which every real page carries. None of this says what a no-TMDB page looks like; that representation is NOT inferred from these controls.
for (const name of ['tv-zero-empty-body-id', 'tv-empty-body-id']) { const html = fs.readFileSync(dir + name + '.html', 'utf8'); assert.ok(html.includes('data-type="film"') && html.includes('content="video.movie"') && html.includes('data-tmdb-type="movie"'), name); }
// an EMPTY body data-tmdb-id is NOT an absence marker: both empty-id controls name a TMDB TV entity in the footer
for (const name of ['tv-zero-empty-body-id', 'tv-empty-body-id']) assert.match(fs.readFileSync(dir + name + '.html', 'utf8'), /data-tmdb-id=""[\s\S]*themoviedb\.org\/tv\/\d+\//);
console.log('letterboxd real markup H1 controls: ok');
