// AIR-604 (UC1): the shared upstream cooldown core: migration 0045, the policy and the coordinator. Offline: scratch sqlite (D1 stand-in), injected fetch, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated, sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as U from '../src/upstream-cooldown.js';
import {isChallenge as identityChallenge} from '../src/letterboxd-identity.js';

const readText = path => fs.readFileSync(path, 'utf8');
const H = init => new Headers(init);
const NOW = Date.parse('2026-11-25T12:00:00Z');
const world = (mode, upTo = Infinity) => {
  const file = migrated(upTo);
  if (mode) sql(file, `INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, '${mode}', 1, ${NOW})`);
  return {file, env: {DB: d1Standin(file)}};
};
const cooldowns = file => sql(file, 'SELECT scope, until_at, reason, retry_after_s, set_by FROM upstream_cooldown ORDER BY scope');

// ---- 1. policy ----------------------------------------------------------------------------------------------------------------------------------
assert.equal(U.scopeOfUrl('https://api.themoviedb.org/3/movie/1'), 'tmdb');
assert.equal(U.scopeOfUrl('https://letterboxd.com/film/x/'), 'letterboxd');
assert.equal(U.scopeOfUrl('https://boxd.it/abc'), 'letterboxd');
assert.equal(U.scopeOfUrl('https://query.wikidata.org/sparql?q=1'), 'wikidata');
assert.equal(U.scopeOfUrl('https://example.com/'), null, 'EPG, Telegram, webhooks and Access certs are out of scope');
assert.equal(U.scopeOfUrl('http://api.themoviedb.org/3/'), null);
assert.equal(U.scopeOfUrl('not a url'), null);

assert.deepEqual(U.classifySignal({status: 429, headers: H()}, NOW), {reason: 'rate_limited', seconds: 300, retryAfter: null});
assert.deepEqual(U.classifySignal({status: 429, headers: H({'retry-after': '120'})}, NOW), {reason: 'rate_limited', seconds: 120, retryAfter: 120});
assert.equal(U.classifySignal({status: 429, headers: H({'retry-after': '1'})}, NOW).seconds, 30, 'clamped up to 30 s');
assert.equal(U.classifySignal({status: 429, headers: H({'retry-after': '999999'})}, NOW).seconds, 3600, 'clamped down to 3600 s');
const date = new Date(NOW + 600_000).toUTCString();
assert.equal(U.classifySignal({status: 429, headers: H({'retry-after': date})}, NOW).seconds, 600, 'an HTTP date');
assert.equal(U.classifySignal({status: 429, headers: H({'retry-after': 'soon'})}, NOW).seconds, 300, 'garbage is absent');
assert.deepEqual(U.classifySignal({status: 403, headers: H()}, NOW), {reason: 'forbidden', seconds: 900, retryAfter: null});
assert.equal(U.classifySignal({status: 200, headers: H({'cf-mitigated': 'challenge'})}, NOW).reason, 'challenge');
assert.equal(U.classifySignal({status: 503, headers: H(), html: '<title>Just a moment...</title> cf-chl'}, NOW).reason, 'challenge');
assert.equal(U.classifySignal({status: 403, headers: H({'cf-mitigated': 'challenge'})}, NOW).seconds, 900);
for (const status of [200, 204, 301, 404, 410, 500, 502, 503, 504]) assert.equal(U.classifySignal({status, headers: H()}, NOW), null, `${status} sets no cooldown`);

// the copied challenge test agrees with the Letterboxd identity one on every shape
for (const status of [200, 403, 404, 429, 500, 503]) for (const headers of [H(), H({'cf-mitigated': 'challenge'}), H({'cf-mitigated': 'other'})]) for (const html of ['', '<title>Just a moment...</title>', 'cf-chl-opt', 'captcha', '/cdn-cgi/challenge-platform/h/b', '<html>ok</html>'])
  assert.equal(U.isChallenge(status, headers, html), identityChallenge(status, headers, html), `${status} ${html}`);

// ---- 2. migration 0045 --------------------------------------------------------------------------------------------------------------------------
{
  const file = migrated(44);
  assert.equal(sql(file, 'SELECT version FROM schema_contract WHERE id=1')[0].version, 44);
  const w = world(null);
  assert.equal(sql(w.file, 'SELECT version FROM schema_contract WHERE id=1')[0].version, 46);
  assert.equal(sql(w.file, 'SELECT COUNT(*) n FROM upstream_cooldown')[0].n, 0, 'created empty');
  assert.equal(sql(w.file, 'SELECT COUNT(*) n FROM upstream_coordination')[0].n, 0, 'no mode row: off by absence');
  // a second apply and a wrong predecessor are refused before any object is created
  const again = sqliteSync(['-bail', w.file], {input: readText('migrations/0045_upstream_cooldown.sql'), encoding: 'utf8'});
  assert.notEqual(again.status, 0, 'a second apply is refused');
  const old = migrated(43);
  const refused = sqliteSync(['-bail', old], {input: readText('migrations/0045_upstream_cooldown.sql'), encoding: 'utf8'});
  assert.notEqual(refused.status, 0, 'version 43 is refused');
  assert.equal(sql(old, "SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('upstream_cooldown','upstream_coordination')")[0].n, 0, 'nothing created on refusal');
  // shape: closed scope, reason and mode sets, a singleton mode row
  const bad = text => sqliteSync(['-bail', w.file], {input: text, encoding: 'utf8'}).status !== 0;
  assert.ok(bad(`INSERT INTO upstream_cooldown VALUES ('epg', 1, 'rate_limited', NULL, 'x', 1)`), 'unknown scope');
  assert.ok(bad(`INSERT INTO upstream_cooldown VALUES ('tmdb', 1, 'boom', NULL, 'x', 1)`), 'unknown reason');
  assert.ok(bad(`INSERT INTO upstream_coordination VALUES (1, 'always', 1, 1)`), 'unknown mode');
  assert.ok(bad(`INSERT INTO upstream_coordination VALUES (2, 'off', 1, 1)`), 'not a singleton');
}

// ---- 3. mode and read are fail-safe -------------------------------------------------------------------------------------------------------------
assert.equal(await U.readMode({}), 'off', 'no binding');
assert.equal(await U.readMode(world(null).env), 'off', 'absent row');
assert.equal(await U.readMode(world('observe').env), 'observe');
assert.equal(await U.readMode(world('enforce').env), 'enforce');
{
  const old = migrated(44); // absent tables
  const env = {DB: d1Standin(old)};
  assert.equal(await U.readMode(env), 'off', 'absent table is off');
  assert.equal(await U.readCooldown(env, 'tmdb', NOW), null, 'absent table: no cooldown');
  assert.equal(await U.writeCooldown(env, 'tmdb', {reason: 'rate_limited', seconds: 300, retryAfter: null}, 't', NOW), false, 'a failed write is swallowed');
  const c = U.createCoordinator(env, {caller: 't', now: () => NOW});
  assert.deepEqual(await c.peek('tmdb'), {mode: 'off', skip: false, until: null, reason: null});
  let calls = 0;
  const res = await c.fetch(async () => {calls++; return new Response('ok', {status: 200});}, 'https://api.themoviedb.org/3/x', {});
  assert.equal(res.status, 200); assert.equal(calls, 1, 'behaves as today');
  const broken = {DB: {prepare() {throw new Error('D1 down');}}};
  assert.equal(await U.readMode(broken), 'off', 'an unreadable mode is off');
}

// ---- 4. off: reads and writes nothing about cooldowns ---------------------------------------------------------------------------------------------
{
  const w = world('off');
  const queries = [];
  const env = {DB: d1Standin(w.file, {onQuery: q => queries.push(q)})};
  const c = U.createCoordinator(env, {caller: 'discovery', now: () => NOW});
  const res = await c.fetch(async () => new Response('x', {status: 429}), 'https://api.themoviedb.org/3/x', {});
  assert.equal(res.status, 429);
  assert.deepEqual(cooldowns(w.file), [], 'off writes no cooldown');
  assert.ok(queries.every(q => !/upstream_cooldown/.test(q)), 'off does not even read the cooldown table');
}

// ---- 5. enforce: write on a signal, skip the scope, never another scope ---------------------------------------------------------------------------
{
  const w = world('enforce');
  const c = () => U.createCoordinator(w.env, {caller: 'diary', now: () => NOW});
  const send = status => async () => new Response(status === 200 ? 'ok' : '', {status, headers: status === 429 ? {'retry-after': '60'} : {}});
  for (const status of [404, 500, 503, 200]) {
    await c().fetch(send(status), 'https://letterboxd.com/film/a/', {});
    assert.deepEqual(cooldowns(w.file), [], `${status} writes nothing`);
  }
  await assert.rejects(async () => { const x = c(); await x.fetch(send(429), 'https://letterboxd.com/film/a/', {}); await x.fetch(send(200), 'https://boxd.it/abc', {}); },
    e => e instanceof U.UpstreamCooldownSkip && e.scope === 'letterboxd' && e.until === NOW + 60_000 && e.code === 'upstream_cooldown');
  const rows = cooldowns(w.file);
  assert.equal(rows.length, 1); assert.equal(rows[0].scope, 'letterboxd'); assert.equal(rows[0].until_at, NOW + 60_000); assert.equal(rows[0].retry_after_s, 60); assert.equal(rows[0].set_by, 'diary');
  // no false cross-source blocking
  let sent = 0;
  const other = async () => {sent++; return new Response('{}', {status: 200});};
  await c().fetch(other, 'https://api.themoviedb.org/3/movie/1', {});
  await c().fetch(other, 'https://query.wikidata.org/sparql', {});
  assert.equal(sent, 2, 'a Letterboxd cooldown never blocks TMDB or Wikidata');
  // the skip sent no request
  let letterboxdSent = 0;
  await assert.rejects(c().fetch(async () => {letterboxdSent++; return new Response('', {status: 200});}, 'https://letterboxd.com/film/b/', {}), U.UpstreamCooldownSkip);
  assert.equal(letterboxdSent, 0, 'an active cooldown sends no request');
  // expiry: a passed until_at is inert, and the row is overwritten, never deleted
  const later = U.createCoordinator(w.env, {caller: 'diary', now: () => NOW + 61_000});
  assert.equal((await later.peek('letterboxd')).skip, false, 'expired is inert');
  assert.equal(cooldowns(w.file).length, 1, 'the row stays');
}

// ---- 6. monotonic, commutative extension ---------------------------------------------------------------------------------------------------------
{
  const w = world('enforce');
  const long = {reason: 'challenge', seconds: 900, retryAfter: null}, short = {reason: 'rate_limited', seconds: 60, retryAfter: 60};
  await Promise.all([U.writeCooldown(w.env, 'tmdb', short, 'a', NOW), U.writeCooldown(w.env, 'tmdb', long, 'b', NOW)]);
  let row = cooldowns(w.file)[0];
  assert.equal(row.until_at, NOW + 900_000, 'the longer cooldown wins');
  assert.equal(row.reason, 'challenge'); assert.equal(row.set_by, 'b');
  await U.writeCooldown(w.env, 'tmdb', short, 'c', NOW + 1000);
  row = cooldowns(w.file)[0];
  assert.equal(row.until_at, NOW + 900_000, 'a later, shorter write never shortens');
  assert.equal(row.reason, 'challenge', 'the reason follows the latest until_at only'); assert.equal(row.set_by, 'b');
  const reversed = world('enforce');
  await U.writeCooldown(reversed.env, 'tmdb', long, 'b', NOW); await U.writeCooldown(reversed.env, 'tmdb', short, 'a', NOW);
  assert.deepEqual(cooldowns(reversed.file)[0].until_at, row.until_at, 'commutative');
  assert.ok(sqliteSync(['-bail', w.file], {input: "UPDATE upstream_cooldown SET until_at = 1 WHERE scope = 'tmdb'", encoding: 'utf8'}).status !== 0, 'a direct shortening is refused');
  assert.ok(sqliteSync(['-bail', w.file], {input: "DELETE FROM upstream_cooldown", encoding: 'utf8'}).status !== 0, 'a delete is refused');
}

// ---- 7. observe: writes, counts the would-skip, skips nothing -------------------------------------------------------------------------------------
{
  const w = world('observe');
  const c = U.createCoordinator(w.env, {caller: 'wikidata-sync', now: () => NOW});
  let sent = 0;
  const f = async () => {sent++; return new Response('', {status: 429});};
  await c.fetch(f, 'https://query.wikidata.org/sparql', {});
  await c.fetch(f, 'https://query.wikidata.org/sparql', {});
  assert.equal(sent, 2, 'observe skips nothing');
  assert.equal(c.stats.wouldSkip, 1); assert.equal(c.stats.skipped, 0); assert.ok(c.stats.written >= 1);
  assert.equal(cooldowns(w.file)[0].scope, 'wikidata');
}

// ---- 8. read-only paths: peek never writes -------------------------------------------------------------------------------------------------------
{
  const w = world('enforce');
  await U.writeCooldown(w.env, 'tmdb', {reason: 'rate_limited', seconds: 300, retryAfter: null}, 'seed', NOW);
  const before = JSON.stringify(cooldowns(w.file));
  const writes = [];
  const env = {DB: d1Standin(w.file, {onQuery: q => {if (/^\s*(INSERT|UPDATE|DELETE)/i.test(q)) writes.push(q);}})};
  const probe = U.createCoordinator(env, {caller: 'tmdb-status-probe', now: () => NOW});
  const gate = await probe.peek('tmdb');
  assert.equal(gate.skip, true); assert.equal(gate.until, NOW + 300_000);
  assert.deepEqual(writes, [], 'peek issues no write');
  assert.equal(JSON.stringify(cooldowns(w.file)), before);
}

console.log('upstream-cooldown: ok');
