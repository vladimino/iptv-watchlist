// AIR-604 (UC1 acceptance): the callers of the shared upstream cooldown, through the real Worker sources loaded as the bundle loads them (one vm scope). Offline: a sqlite D1
// stand-in, a scripted fetch, no network, no production. Per caller: a signal writes the scope's cooldown; an enforced cooldown sends NO request and maps to the caller's own
// non-charging not-now path; `off`, an absent schema and a missing module change nothing; a cooldown of one scope never blocks another; GET reads write nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {migrated, sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {scoped, scopedReplacing} from '../scripts/bundle-scope.mjs';

const NOW = Date.now();
const dbWith = (mode, upTo = Infinity) => {
  const file = migrated(upTo);
  if (mode) sql(file, `INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, '${mode}', 1, ${NOW})`);
  return file;
};
const seed = (file, scope, secondsFromNow, reason = 'rate_limited') =>
  sql(file, `INSERT INTO upstream_cooldown (scope, until_at, reason, retry_after_s, set_by, updated_at) VALUES ('${scope}', ${NOW + secondsFromNow * 1000}, '${reason}', NULL, 'seed', ${NOW})`);
const plain = value => JSON.parse(JSON.stringify(value));
const rows = file => sql(file, 'SELECT scope, until_at, reason, set_by FROM upstream_cooldown ORDER BY scope');

// the Worker sources in one scope, as build.mjs concatenates them (the cooldown module first, scoped)
let sent = [], answer = () => new Response('{}', {status: 200});
const context = vm.createContext({Response, Request, URL, URLSearchParams, Date, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, AbortSignal, crypto: webcrypto, console, setTimeout: fn => (fn(), 0), clearTimeout() {},
  fetch: async (url, init) => {sent.push(String(url)); return answer(String(url), init);}});
const load = (text, name) => vm.runInContext(text, context, {filename: name});
function bootstrap({withModule = true} = {}) {
  load(fs.readFileSync('src/domain/film-person.js', 'utf8'), 'film-person');
  if (withModule) load(scoped('src/upstream-cooldown.js', 'UpstreamCooldown'), 'upstream-cooldown');
  for (const file of ['src/domain/scored-resolution.js', 'src/domain/resolution-acceptance.js', 'src/sources.js', 'src/discovery.js']) load(fs.readFileSync(file, 'utf8'), file);
  load(scoped('src/letterboxd-match.js', 'LetterboxdMatch'), 'letterboxd-match');
  load(scopedReplacing('src/letterboxd-identity.js', 'LetterboxdIdentity', 'const normTitle=LetterboxdMatch.normTitle;\n'), 'letterboxd-identity');
  load(fs.readFileSync('src/letterboxd-rated-candidates.js', 'utf8'), 'rated-candidates');
}
bootstrap();
const run = code => vm.runInContext(code, context);
const reset = () => {sent = []; answer = () => new Response('{}', {status: 200});};
const headers429 = seconds => ({status: 429, headers: {'Retry-After': String(seconds)}});

// ---- 1. Discovery (TMDB): a 429 writes, a skip is the existing not-now `retryAt`, and nothing else blocks it ------------------------------------------------------
{
  const file = dbWith('enforce');
  const env = {DB: d1Standin(file), TMDB_API_READ_ACCESS_TOKEN: 't', TMDB_REQUEST_INTERVAL_MS: 0};
  context.env = env;
  reset();
  answer = () => new Response('{}', headers429(120));
  const first = await run("tmdbRequest(env,'movie/1').then(()=>null,e=>({message:e.message,retryAt:e.retryAt,cool:e.upstreamCooldown===true}))");
  assert.equal(first.message, 'TMDB HTTP 429'); assert.ok(first.retryAt, 'the existing 429 path still reports retryAt');
  const written = rows(file);
  assert.equal(written.length, 1); assert.equal(written[0].scope, 'tmdb'); assert.equal(written[0].set_by, 'discovery');
  assert.ok(written[0].until_at >= NOW + 119_000 && written[0].until_at <= Date.now() + 121_000, 'Retry-After 120 s');
  sent = [];
  const second = await run("tmdbRequest(env,'movie/2').then(()=>null,e=>({message:e.message,retryAt:e.retryAt,cool:e.upstreamCooldown===true}))");
  assert.deepEqual(sent, [], 'an enforced cooldown sends no request');
  assert.equal(second.cool, true); assert.equal(Date.parse(second.retryAt), written[0].until_at, 'retryAt is the cooldown end: the existing not-now path, no attempt charged');
  // a 404 and a 5xx never set a cooldown
  for (const status of [404, 500, 502]) {
    const f = dbWith('enforce'); context.env = {...env, DB: d1Standin(f)}; reset(); answer = () => new Response('{}', {status});
    await run("tmdbRequest(env,'movie/3').catch(()=>null)");
    assert.deepEqual(rows(f), [], `${status} writes no cooldown`);
  }
  // observe: writes, skips nothing
  const o = dbWith('observe'); context.env = {...env, DB: d1Standin(o)}; reset(); answer = () => new Response('{}', headers429(60));
  await run("tmdbRequest(env,'movie/4').catch(()=>null)"); await run("tmdbRequest(env,'movie/5').catch(()=>null)");
  assert.equal(sent.length, 2, 'observe skips nothing'); assert.equal(rows(o)[0].scope, 'tmdb');
  // off and an absent schema: today's behaviour, nothing written, nothing read but the mode
  for (const [label, f] of [['off', dbWith('off')], ['absent row', dbWith(null)], ['absent schema', migrated(44)]]) {
    context.env = {...env, DB: d1Standin(f)}; reset(); answer = () => new Response('{}', headers429(60));
    const res = await run("tmdbRequest(env,'movie/6').then(()=>null,e=>e.message)");
    assert.equal(res, 'TMDB HTTP 429', label); assert.equal(sent.length, 1, label);
    if (label !== 'absent schema') assert.deepEqual(rows(f), [], `${label} writes nothing`);
  }
  // a Letterboxd cooldown never blocks TMDB
  const l = dbWith('enforce'); seed(l, 'letterboxd', 600); context.env = {...env, DB: d1Standin(l)}; reset();
  assert.ok(await run("tmdbRequest(env,'movie/7').then(()=>true,()=>false)"), 'no false cross-source blocking');
}

// ---- 2. the TMDB status probe: a read-only caller ------------------------------------------------------------------------------------------------------------------
{
  const file = dbWith('enforce'); seed(file, 'tmdb', 300);
  const writes = [];
  const env = {DB: d1Standin(file, {onQuery: q => {if (/^\s*(INSERT|UPDATE|DELETE)/i.test(q)) writes.push(q);}}), BUCKET: {get: async () => null}, TMDB_API_READ_ACCESS_TOKEN: 't'};
  for (const file2 of ['src/domain/prediction-confidence.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/worker.js']) load(fs.readFileSync(file2, 'utf8').replace('export default', 'globalThis.worker='), file2);
  reset();
  const probe = () => run('worker').fetch(new Request('https://site.example/api/integrations/tmdb/status'), env);
  let res = await probe();
  assert.equal(res.status, 503); const body = await res.json();
  assert.equal(body.stage, 'upstream_cooldown'); assert.equal(body.connected, false);
  assert.deepEqual(sent, [], 'an active cooldown answers without a request');
  assert.deepEqual(writes, [], 'the GET probe writes nothing');
  // no cooldown: it requests as today, and a 429 is reported without writing the cooldown
  const clean = dbWith('enforce'); const w2 = [];
  const env2 = {...env, DB: d1Standin(clean, {onQuery: q => {if (/^\s*(INSERT|UPDATE|DELETE)/i.test(q)) w2.push(q);}})};
  reset(); answer = () => new Response('{}', headers429(60));
  res = await run('worker').fetch(new Request('https://site.example/api/integrations/tmdb/status'), env2);
  assert.equal(res.status, 502); assert.deepEqual(await res.json(), {connected: false, stage: 'tmdb_http', status: 429});
  assert.equal(sent.length, 1); assert.deepEqual(w2, [], 'a 429 seen by the probe writes no cooldown'); assert.deepEqual(rows(clean), []);
}

// ---- 3. the Letterboxd page reader (Watchlist scan, metadata film pages) ------------------------------------------------------------------------------------------------
{
  const file = dbWith('enforce');
  const env = {DB: d1Standin(file)};
  context.env = env; reset();
  const coordination = () => run("upstreamCoordinator(env,'letterboxd-watchlist-scan')");
  context.coordination = coordination();
  answer = () => new Response('', headers429(90));
  const first = await run("getHTML('https://letterboxd.com/demo/watchlist/',coordination).then(()=>null,e=>e.message)");
  assert.match(first, /^Source HTTP 429/); assert.equal(rows(file)[0].scope, 'letterboxd');
  context.coordination = coordination(); sent = [];
  const skipped = await run("getHTML('https://letterboxd.com/demo/watchlist/',coordination).then(()=>null,e=>({code:e.code,until:e.until}))");
  assert.equal(skipped.code, 'upstream_cooldown'); assert.deepEqual(sent, [], 'no request while the cooldown is active');
  // the Sync phase maps it to its existing non-charging outcome
  const watchlist = await import('../src/letterboxd-sync-watchlist.js');
  assert.deepEqual(watchlist.classifyScanFailure(Object.assign(new Error('x'), {code: 'upstream_cooldown'})), {outcome: 'rate_limited', reason: 'upstream_cooldown'});
  assert.deepEqual(watchlist.classifyScanFailure(new Error('Source HTTP 429: /x')), {outcome: 'rate_limited', reason: 'http_429'}, 'today\'s 429 is unchanged');
  // without a coordinator (null) the request is today's
  sent = []; answer = () => new Response('<html></html>', {status: 200});
  assert.equal(await run("getHTML('https://letterboxd.com/demo/watchlist/')"), '<html></html>'); assert.equal(sent.length, 1);
  // a Letterboxd cooldown does not block TMDB or Wikidata page readers
  const other = await run("wikidataRequest(upstreamCoordinator(env,'x'),'https://query.wikidata.org/sparql',{})");
  assert.ok(other, 'Wikidata is another scope');
}

// ---- 4. Wikidata callers (metadata sync, EPG localization, archive enrich): a skip stops the step's requests, is no error, and records the skip ---------------------------
{
  const file = dbWith('enforce'); seed(file, 'wikidata', 600);
  context.env = {DB: d1Standin(file)}; reset();
  context.coordination = run("upstreamCoordinator(env,'metadata-sync')");
  context.films = [{id: 'a', tmdbId: '603', title: 'The Matrix', original: 'The Matrix', directors: [], actors: []}];
  context.cache = {};
  const out = await run("localizeFilmTitles(films,cache,'on',coordination).then(r=>({ok:true}),e=>({ok:false,message:e.message}))");
  assert.equal(out.ok, true, 'a skip is not an error'); assert.deepEqual(sent, [], 'no Wikidata request'); assert.equal(context.coordination.stats.skipped, 1);
  context.coordination = run("upstreamCoordinator(env,'epg-localization')");
  context.people = {};
  context.films = [{id: 'a', directors: [{id: 'p/jane-doe', name: 'Jane Doe', original: 'Jane Doe'}], actors: []}];
  await run("localizeByLetterboxd(films,people,coordination)"); assert.deepEqual(sent, []); assert.equal(context.coordination.stats.skipped, 1);
  // no cooldown: Wikidata is asked as today; a Letterboxd cooldown does not block it
  const f2 = dbWith('enforce'); seed(f2, 'letterboxd', 600); context.env = {DB: d1Standin(f2)}; reset();
  context.coordination = run("upstreamCoordinator(env,'metadata-sync')");
  await run("localizeByLetterboxd(films,people,coordination)").catch(() => null);
  assert.equal(sent.length, 1, 'a Letterboxd cooldown never blocks Wikidata');
}

// ---- 5. a missing cooldown module is today's behaviour --------------------------------------------------------------------------------------------------------------
{
  const bare = vm.createContext({Response, URL, URLSearchParams, Date, Map, Set, JSON, TextEncoder, TextDecoder, AbortSignal, crypto: webcrypto, console, fetch: async () => new Response('<html>ok</html>', {status: 200})});
  vm.runInContext(fs.readFileSync('src/domain/film-person.js', 'utf8'), bare);
  vm.runInContext(fs.readFileSync('src/sources.js', 'utf8'), bare);
  assert.equal(vm.runInContext("upstreamCoordinator({}, 'x')", bare), null);
  assert.equal(await vm.runInContext("getHTML('https://letterboxd.com/x/')", bare), '<html>ok</html>');
}

// ---- 6. the identity checks (Diary, Watchlist admission, archive step): the shared fetches --------------------------------------------------------------------------------------
{
  const filmPage = '<html><head><link rel="canonical" href="https://letterboxd.com/film/x/"></head></html>';
  const world = (mode, cooling = []) => {const f = dbWith(mode); for (const [scope, seconds] of cooling) seed(f, scope, seconds); return f;};
  const guarded = (file, caller = 'letterboxd-identity:ratings_diary') => {context.env = {DB: d1Standin(file)}; return run(`upstreamCoordinator(env,'${caller}').guard(fetch)`);};
  // an enforced Letterboxd cooldown: a transport stop that costs no attempt, and no request
  let f = world('enforce', [['letterboxd', 600]]); reset();
  context.net = guarded(f);
  assert.deepEqual(plain(await run("LetterboxdRatedCandidates.follow(net,'abc')")), {stop: 'upstream_cooldown'}); assert.deepEqual(sent, []);
  // TMDB is another scope: the same Letterboxd cooldown does not stop movieDetail
  context.env = {DB: d1Standin(f), TMDB_API_READ_ACCESS_TOKEN: 't'}; reset(); answer = () => new Response('{"id":603}', {status: 200});
  context.net = guarded(f);
  context.env = {DB: d1Standin(f), TMDB_API_READ_ACCESS_TOKEN: 't'};
  assert.ok((await run("LetterboxdRatedCandidates.movieDetail(env,'603',net)")).detail, 'no false cross-source blocking'); assert.equal(sent.length, 1);
  // and a TMDB cooldown stops movieDetail only
  f = world('enforce', [['tmdb', 600]]); reset(); context.net = guarded(f); context.env = {DB: d1Standin(f), TMDB_API_READ_ACCESS_TOKEN: 't'};
  assert.deepEqual(plain(await run("LetterboxdRatedCandidates.movieDetail(env,'603',net)")), {stop: 'upstream_cooldown'}); assert.deepEqual(sent, []);
  // signals: a 429, a 403 and a challenge write the Letterboxd cooldown; a 404 and a 5xx do not
  for (const [label, res, expectCooldown] of [
    ['429', () => new Response('', headers429(60)), true],
    ['403', () => new Response('', {status: 403}), true],
    ['challenge page', () => new Response('<title>Just a moment...</title> cf-chl', {status: 503}), true],
    ['404', () => new Response('', {status: 404}), false],
    ['500', () => new Response('', {status: 500}), false],
    ['200 page', () => new Response(filmPage, {status: 200}), false]
  ]) {
    const file = world('enforce'); reset(); answer = res; context.net = guarded(file);
    await run("LetterboxdRatedCandidates.follow(net,'abc')");
    assert.equal(rows(file).length, expectCooldown ? 1 : 0, label);
    if (expectCooldown) assert.equal(rows(file)[0].scope, 'letterboxd', label);
  }
  // off, an absent schema and no guard: today's request
  for (const [label, file] of [['off', world('off')], ['absent schema', migrated(44)]]) {
    reset(); answer = () => new Response('', headers429(60)); context.net = guarded(file);
    assert.deepEqual(plain(await run("LetterboxdRatedCandidates.follow(net,'abc')")), {stop: 'rate_limited'}, label); assert.equal(sent.length, 1, label);
  }
}

console.log('upstream-cooldown-callers: ok');
