// AIR-609 (UC2): the narrow production operator of the upstream cooldown mode (scripts/upstream-cooldown-mode-production.mjs) and the offline evidence aggregator
// (scripts/upstream-cooldown-evidence-report.mjs). Offline only: a sqlite D1 stand-in over the real migration chain, no production database, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {migrated, sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {D1Error} from '../scripts/d1-backfill.mjs';
import * as Op from '../scripts/upstream-cooldown-mode-production.mjs';
import * as Report from '../scripts/upstream-cooldown-evidence-report.mjs';
import {createCoordinator} from '../src/upstream-cooldown.js';

const NOW = Date.parse('2026-11-28T12:00:00.000Z');
const SHA = Op.operatorSha256();
const open = (upTo = 47) => {const file = migrated(upTo); return {file, db: d1Standin(file)};};
const stop = async (promise, reason) => {try {await promise;} catch (error) {assert.equal(error.reason, reason, String(error.reason)); return error;} assert.fail('expected ' + reason);};
const states = [];
const ctx = () => ({track: state => states.push(state)});
const mode = file => sql(file, 'SELECT mode, revision, updated_at FROM upstream_coordination')[0] ?? null;
const set = (env, to, expectRevision, extra = {}) => Op.execute('set', {binding: env.db, now: NOW, ctx: ctx(), params: {mode: to, expectRevision, operatorSha256: SHA, ...extra}});

// ===== 1. arguments =====
{
  const A = (...a) => ['node', 'x', ...a];
  const ok = ['--set', '--target', 'iptv', '--confirm', 'set', '--mode', 'observe', '--expect-revision', '0', '--operator-sha256', SHA];
  assert.deepEqual(Op.parseArgs(A()).report, {configured: false, writes: false, writeState: 'none'});
  assert.throws(() => Op.parseArgs(A('--set')), e => e.reason === 'target_required');
  assert.throws(() => Op.parseArgs(A('--set', '--target', 'other', '--confirm', 'set')), e => e.reason === 'target_invalid');
  assert.throws(() => Op.parseArgs(A(...ok.filter(a => a !== '--confirm' && a !== 'set'))), e => e.reason === 'confirm');
  assert.throws(() => Op.parseArgs(A(...ok.map(a => a === 'observe' ? 'enforce' : a))), e => e.reason === 'mode_unsupported', 'enforce is not reachable');
  assert.throws(() => Op.parseArgs(A(...ok.map(a => a === 'observe' ? 'bogus' : a))), e => e.reason === 'usage');
  assert.throws(() => Op.parseArgs(A(...ok.map(a => a === '0' ? '-1' : a))), e => e.reason === 'usage');
  assert.throws(() => Op.parseArgs(A(...ok.map(a => a === SHA ? 'abc' : a))), e => e.reason === 'usage');
  assert.throws(() => Op.parseArgs(A('--apply', '--target', 'iptv')), e => e.reason === 'usage', 'no other command exists');
  assert.throws(() => Op.parseArgs(A('--status', '--set', ...ok.slice(1))), e => e.reason === 'usage');
  assert.throws(() => Op.parseArgs(A('--status', '--target', 'iptv', '--mode', 'observe')), e => e.reason === 'usage', 'status takes only the target');
  assert.deepEqual(Op.parseArgs(A(...ok)), {command: 'set', params: {mode: 'observe', expectRevision: 0, operatorSha256: SHA}});
  const r = spawnSync(process.execPath, ['scripts/upstream-cooldown-mode-production.mjs'], {encoding: 'utf8'});
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {configured: false, writes: false, writeState: 'none'});
}

// ===== 2. status is read-only and decides each transition =====
{
  const env = open();
  const writes = [];
  const spy = {prepare: s => env.db.prepare(s), batch: async b => {writes.push(b); return env.db.batch(b);}};
  const status = await Op.execute('status', {binding: spy, now: NOW});
  assert.equal(status.writes, false); assert.equal(status.writeState, 'none'); assert.equal(writes.length, 0);
  assert.equal(status.operatorSha256, SHA); assert.equal(status.mode, 'off'); assert.equal(status.modeRow, null); assert.equal(status.expectRevision, 0);
  assert.deepEqual(status.decisions, {observe: 'apply', off: 'already_set'});
  assert.equal(status.schemaVersion >= 47, true); assert.deepEqual(status.cooldowns, []);
  assert.equal(JSON.stringify(status).includes('api.themoviedb'), false, 'no endpoint or payload in the output');
}

// ===== 3. off -> observe -> off -> observe, each exactly one statement, revision +1 =====
{
  const env = open();
  const batches = [];
  const spy = {prepare: s => env.db.prepare(s), batch: async b => {batches.push(b.map(x => x.text)); return env.db.batch(b);}};
  const run = (to, rev, extra = {}) => Op.execute('set', {binding: spy, now: NOW, ctx: ctx(), params: {mode: to, expectRevision: rev, operatorSha256: SHA, ...extra}});
  await stop(run('observe', 0, {operatorSha256: '0'.repeat(64)}), 'operator_digest_mismatch');
  await stop(run('observe', 3), 'revision_moved');
  await stop(run('off', 0), 'already_set');
  await stop(run('enforce', 0), 'mode_unsupported');
  assert.equal(batches.length, 0, 'every refusal happens before a write'); assert.equal(mode(env.file), null);
  states.length = 0;
  const first = await run('observe', 0);
  assert.equal(first.writeState, 'committed'); assert.equal(first.statements, 1); assert.equal(states.at(-1), 'committed');
  assert.equal(batches.length, 1); assert.equal(batches[0].length, 1);
  assert.match(batches[0][0], /^INSERT INTO upstream_coordination \(id, mode, revision, updated_at\) VALUES \(1, 'observe', 1, \d+\)$/);
  assert.deepEqual(mode(env.file), {mode: 'observe', revision: 1, updated_at: NOW});
  assert.equal(first.before.mode, 'off'); assert.equal(first.after.mode, 'observe'); assert.equal(first.after.modeRow.revision, 1);
  await stop(run('observe', 1), 'already_set');
  await stop(run('off', 0), 'revision_moved');
  const back = await run('off', 1);
  assert.match(batches[1][0], /^UPDATE upstream_coordination SET mode = 'off', revision = revision \+ 1, updated_at = \d+ WHERE id = 1 AND mode = 'observe' AND revision = 1$/);
  assert.deepEqual(mode(env.file), {mode: 'off', revision: 2, updated_at: NOW}); assert.equal(back.after.mode, 'off');
  await run('observe', 2);
  assert.deepEqual(mode(env.file), {mode: 'observe', revision: 3, updated_at: NOW});
  const again = await Op.execute('status', {binding: spy, now: NOW});
  assert.deepEqual(again.decisions, {observe: 'already_set', off: 'apply'}); assert.equal(again.expectRevision, 3);
  assert.equal(sql(env.file, 'SELECT COUNT(*) AS n FROM upstream_cooldown')[0].n, 0, 'no cooldown row is ever written by the operator');
}

// ===== 4. predecessor states that refuse =====
{
  await stop(Op.execute('set', {binding: open(44).db, now: NOW, params: {mode: 'observe', expectRevision: 0, operatorSha256: SHA}}), 'tables_missing');
  await stop(Op.execute('set', {binding: open(46).db, now: NOW, params: {mode: 'observe', expectRevision: 0, operatorSha256: SHA}}), 'schema_unexpected');
  const enforced = open();
  sql(enforced.file, `INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, 'enforce', 5, ${NOW})`);
  const refused = await stop(set(enforced, 'off', 5), 'enforce_active');
  assert.equal(refused.details.state.mode, 'enforce'); assert.deepEqual(mode(enforced.file), {mode: 'enforce', revision: 5, updated_at: NOW}, 'enforce is never rolled back from here');
  // a moved revision between status and set
  const moved = open();
  sql(moved.file, `INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, 'off', 4, ${NOW})`);
  await stop(set(moved, 'observe', 3), 'revision_moved');
  await set(moved, 'observe', 4);
  assert.equal(mode(moved.file).revision, 5);
  // an unreadable schema_contract is unknown_state, never a guess
  const broken = open();
  sql(broken.file, 'DELETE FROM schema_contract WHERE 1=1');
  await stop(Op.execute('set', {binding: broken.db, now: NOW, params: {mode: 'observe', expectRevision: 0, operatorSha256: SHA}}), 'unknown_state');
}

// ===== 5. existing cooldown rows are reported with their expiry and never changed =====
{
  const env = open();
  sql(env.file, `INSERT INTO upstream_cooldown (scope, until_at, reason, retry_after_s, set_by, updated_at) VALUES ('tmdb', ${NOW + 90_000}, 'rate_limited', 90, 'discovery', ${NOW - 1000}), ('wikidata', ${NOW - 5000}, 'forbidden', NULL, 'metadata', ${NOW - 9000})`);
  const status = await Op.execute('status', {binding: env.db, now: NOW});
  assert.deepEqual(status.cooldowns.map(r => [r.scope, r.active, r.remainingS, r.setBy]), [['tmdb', true, 90, 'discovery'], ['wikidata', false, 0, 'metadata']]);
  const before = sql(env.file, 'SELECT * FROM upstream_cooldown ORDER BY scope');
  await set(env, 'observe', 0);
  assert.deepEqual(sql(env.file, 'SELECT * FROM upstream_cooldown ORDER BY scope'), before);
  // the schema CHECK already refuses a foreign scope; the decision still does not trust it (defence in depth)
  const synthetic = {...(await Op.readState(env.db, {now: NOW}))};
  synthetic.cooldowns = [...synthetic.cooldowns, {scope: 'other', untilAt: 1, reason: 'forbidden', retryAfterS: null, setBy: 'x', updatedAt: 1, active: false}];
  assert.equal(Op.decide(synthetic, 'off'), 'scope_unexpected');
}

// ===== 6. outcomes of a failing batch =====
{
  // a proven statement rejection that changed nothing is the only "not applied"
  const rej = open();
  states.length = 0;
  await stop(Op.execute('set', {binding: {prepare: s => rej.db.prepare(s), batch: async () => {throw new D1Error('statement', 'rejected');}}, now: NOW, ctx: ctx(), params: {mode: 'observe', expectRevision: 0, operatorSha256: SHA}}), 'statement_failed');
  assert.equal(states.at(-1), 'none');
  // a lost response with an apparently untouched readback stays uncertain, never retried
  const lostEnv = open();
  let tries = 0;
  const timing = {prepare: s => lostEnv.db.prepare(s), batch: async () => {tries++; throw new D1Error('write_uncertain', 'response lost');}};
  states.length = 0;
  await stop(Op.execute('set', {binding: timing, now: NOW, ctx: ctx(), params: {mode: 'observe', expectRevision: 0, operatorSha256: SHA}}), 'write_uncertain');
  assert.equal(states.at(-1), 'unknown'); assert.equal(tries, 1);
  const cli = await Op.runUpstreamCooldownModeProduction({argv: ['node', 'x', '--set', '--target', 'iptv', '--confirm', 'set', '--mode', 'observe', '--expect-revision', '0', '--operator-sha256', SHA], deps: {binding: timing}, now: () => NOW});
  assert.equal(cli.exit, 3); assert.equal(cli.result.reason, 'write_uncertain'); assert.equal(cli.result.writeState, 'unknown'); assert.equal(cli.result.writes, null); assert.equal(cli.result.retry, false);
  // a lost reply after a real commit
  const committed = open();
  const losing = {prepare: s => committed.db.prepare(s), batch: async b => {await committed.db.batch(b); throw new Error('lost reply');}};
  const err = await stop(Op.execute('set', {binding: losing, now: NOW, ctx: ctx(), params: {mode: 'observe', expectRevision: 0, operatorSha256: SHA}}), 'write_uncertain');
  assert.equal(err.details.mode, 'observe'); assert.equal(err.details.revision, 1);
  // a concurrent writer that moves the row inside the window: the guarded UPDATE matches nothing and the readback says so
  const racy = open();
  sql(racy.file, `INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, 'off', 1, ${NOW})`);
  const racing = {prepare: s => racy.db.prepare(s), batch: async b => {sql(racy.file, `UPDATE upstream_coordination SET revision = 2 WHERE id = 1`); return racy.db.batch(b);}};
  const race = await stop(Op.execute('set', {binding: racing, now: NOW, ctx: ctx(), params: {mode: 'observe', expectRevision: 1, operatorSha256: SHA}}), 'write_uncertain');
  assert.equal(race.details.problems.includes('mode'), true); assert.deepEqual(mode(racy.file), {mode: 'off', revision: 2, updated_at: NOW}, 'the guarded UPDATE changed nothing');
  // the control row disagrees after a successful batch (another writer moved the mode or the written time): write_uncertain, judged from the control row alone
  for (const [label, tamper] of [['updated_at', `UPDATE upstream_coordination SET updated_at = ${NOW + 1} WHERE id = 1`], ['revision', 'UPDATE upstream_coordination SET revision = revision + 1 WHERE id = 1']]) {
    const tampered = open();
    const writing = {prepare: s => tampered.db.prepare(s), batch: async b => {const r = await tampered.db.batch(b); sql(tampered.file, tamper); return r;}};
    const bad = await stop(Op.execute('set', {binding: writing, now: NOW, ctx: ctx(), params: {mode: 'observe', expectRevision: 0, operatorSha256: SHA}}), 'write_uncertain');
    assert.equal(bad.details.problems.includes(label), true, label);
  }
}

// ===== 6b. concurrent NATURAL cooldown writes are legal and are not evidence about the mode write (review P1-C) =====
{
  const natural = (file, scope, untilMs, by = 'natural') => sql(file, `INSERT INTO upstream_cooldown (scope, until_at, reason, retry_after_s, set_by, updated_at) VALUES ('${scope}', ${untilMs}, 'rate_limited', NULL, '${by}', ${NOW}) ON CONFLICT(scope) DO UPDATE SET until_at = MAX(until_at, excluded.until_at), updated_at = excluded.updated_at`);
  // activation: the instant the mode becomes observe a caller of the next run writes a cooldown. The single guarded statement still committed and the control row reads back exactly.
  const env = open();
  natural(env.file, 'wikidata', NOW + 30_000, 'seed');
  const racing = {prepare: s => env.db.prepare(s), batch: async b => {const r = await env.db.batch(b); natural(env.file, 'tmdb', NOW + 90_000); natural(env.file, 'wikidata', NOW + 120_000); return r;}};
  states.length = 0;
  const activated = await Op.execute('set', {binding: racing, now: NOW, ctx: ctx(), params: {mode: 'observe', expectRevision: 0, operatorSha256: SHA}});
  assert.equal(activated.writeState, 'committed'); assert.equal(states.at(-1), 'committed');
  assert.deepEqual(mode(env.file), {mode: 'observe', revision: 1, updated_at: NOW});
  assert.deepEqual(activated.cooldownObservations, {changed: true, added: ['tmdb'], extended: ['wikidata']}, 'reported on their own, as observations');
  assert.equal(activated.after.cooldowns.length, 2);
  // rollback: a run that cached `observe` may still write after the mode is off
  const rolling = {prepare: s => env.db.prepare(s), batch: async b => {const r = await env.db.batch(b); natural(env.file, 'letterboxd', NOW + 60_000, 'in-flight run'); return r;}};
  const rolledBack = await Op.execute('set', {binding: rolling, now: NOW, ctx: ctx(), params: {mode: 'off', expectRevision: 1, operatorSha256: SHA}});
  assert.equal(rolledBack.writeState, 'committed'); assert.deepEqual(mode(env.file), {mode: 'off', revision: 2, updated_at: NOW});
  assert.deepEqual(rolledBack.cooldownObservations, {changed: true, added: ['letterboxd'], extended: []});
  // no concurrent write: nothing is reported
  const quiet = open();
  assert.deepEqual((await set(quiet, 'observe', 0)).cooldownObservations, {changed: false, added: [], extended: []});
  // a real CAS mismatch with a concurrent cooldown write is still write_uncertain: the control row decides, the cooldown never excuses it
  const racy = open();
  sql(racy.file, `INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, 'off', 1, ${NOW})`);
  const mismatch = {prepare: s => racy.db.prepare(s), batch: async b => {sql(racy.file, 'UPDATE upstream_coordination SET revision = 2 WHERE id = 1'); natural(racy.file, 'tmdb', NOW + 1000); return racy.db.batch(b);}};
  const err = await stop(Op.execute('set', {binding: mismatch, now: NOW, ctx: ctx(), params: {mode: 'observe', expectRevision: 1, operatorSha256: SHA}}), 'write_uncertain');
  assert.equal(err.details.problems.includes('mode'), true); assert.equal(err.details.cooldownObservations.added[0], 'tmdb');
  // the observation helper itself: a shortened or missing row is an anomaly (the triggers make it impossible), listed and never a verdict
  const row = (scope, untilAt) => ({scope, untilAt});
  assert.deepEqual(Op.cooldownObservations({cooldowns: [row('tmdb', 5), row('wikidata', 5)], digest: 'a'}, {cooldowns: [row('tmdb', 4)], digest: 'b'}), {changed: true, added: [], extended: [], anomalies: ['shortened:tmdb', 'missing:wikidata']});
}

// ===== 6c. the production reads are strict (review P1-C): a malformed answer stops the status and the set BEFORE any write =====
{
  const {PRODUCTION_ACCOUNT_ID, PRODUCTION_DATABASE_ID} = await import('../scripts/published-epg-production.mjs');
  const {createD1Adapter} = await import('../scripts/d1-backfill.mjs');
  const {sqliteSync} = await import('./sqlite-session.mjs');
  const adapterTarget = {accountId: 'a'.repeat(32), apiToken: 't', endpoint: 'https://example.test/client/v4', maxBatchStatements: 2000, maxBatchBytes: 8388608};
  const answer = body => async () => ({ok: true, status: 200, json: async () => body});
  const strict = body => createD1Adapter({target: adapterTarget, databaseId: 'd', fetchImpl: answer(body), retries: 0}).allStrict('SELECT 1 AS n');
  assert.deepEqual(await strict({success: true, result: [{success: true, results: [{n: 1}]}]}), [{n: 1}]);
  assert.deepEqual(await strict({success: true, result: [{success: true, results: []}]}), [], 'a real empty answer is an answer');
  for (const bad of [{success: true, result: []}, {success: true, result: [{success: true}]}, {success: true}]) await assert.rejects(() => strict(bad), e => e.kind === 'statement', JSON.stringify(bad));

  const env = open();
  const calls = [];
  const lite = (input, json) => sqliteSync([...(json ? ['-json'] : []), '-bail', env.file], {input: 'PRAGMA foreign_keys=ON;\n' + input, encoding: 'utf8', maxBuffer: 1 << 26});
  const makeFetch = (malformed = () => false) => async (url, init) => {
    calls.push({url: String(url), method: init.method, body: init.body});
    const reply = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body});
    if (String(url).endsWith('/time_travel/bookmark')) return reply({success: true, result: {bookmark: 'bookmark-' + calls.length}});
    if (init.method === 'GET') return reply({success: true, result: {uuid: PRODUCTION_DATABASE_ID, name: 'iptv'}});
    const body = JSON.parse(init.body);
    if (body.batch) {
      const result = lite('BEGIN;\n' + body.batch.map(item => item.sql).join('\n') + '\nCOMMIT;');
      if (result.status !== 0) return reply({success: false, errors: [{message: String(result.stderr).trim()}]}, 400);
      return reply({success: true, result: body.batch.map(() => ({success: true, results: [], meta: {rows_written: 1}}))});
    }
    const text = String(body.sql);
    if (malformed(text)) return reply({success: true, result: [{success: true}]});
    const result = lite(text, true);
    if (result.status !== 0) return reply({success: false, errors: [{message: String(result.stderr).trim()}]}, 400);
    const out = String(result.stdout).trim();
    return reply({success: true, result: [{success: true, results: out ? JSON.parse(out) : [], meta: {rows_written: 0}}]});
  };
  const procEnv = {D1_BACKFILL_ACCOUNT_ID: PRODUCTION_ACCOUNT_ID, D1_BACKFILL_API_TOKEN: 'SECRET-TOKEN-VALUE', NODE_USE_ENV_PROXY: ''};
  const run = (args, fetchImpl) => Op.runUpstreamCooldownModeProduction({argv: ['node', 'x', ...args], env: procEnv, fetchImpl, now: () => NOW});
  const setArgs = ['--set', '--target', 'iptv', '--confirm', 'set', '--mode', 'observe', '--expect-revision', '0', '--operator-sha256', SHA];
  // the real composition works end to end: describe, strict reads, bookmark, one batch, readback
  const ok = await run(['--status', '--target', 'iptv'], makeFetch());
  assert.equal(ok.exit, 0, JSON.stringify(ok.result).slice(0, 300)); assert.equal(ok.result.mode, 'off');
  for (const pattern of [/FROM upstream_coordination/, /FROM upstream_cooldown/, /schema_contract/, /sqlite_master/]) {
    calls.length = 0;
    const bad = await run(['--status', '--target', 'iptv'], makeFetch(text => pattern.test(text)));
    assert.equal(bad.exit, 3, String(pattern)); assert.equal(bad.result.reason, 'unknown_state', String(pattern));
    assert.equal(JSON.stringify(bad).includes('SECRET-TOKEN-VALUE'), false);
    calls.length = 0;
    const refused = await run(setArgs, makeFetch(text => pattern.test(text)));
    assert.equal(refused.exit, 3, String(pattern)); assert.equal(refused.result.reason, 'unknown_state'); assert.equal(refused.result.writeState, 'none');
    assert.equal(calls.some(call => call.method === 'POST' && String(call.body).includes('"batch"')), false, 'nothing was written after a malformed read: ' + pattern);
    assert.equal(mode(env.file), null, 'the mode row is untouched');
  }
  calls.length = 0;
  const applied = await run(setArgs, makeFetch());
  assert.equal(applied.exit, 0, JSON.stringify(applied.result).slice(0, 400)); assert.equal(applied.result.writeState, 'committed');
  assert.equal(calls.filter(call => call.method === 'POST' && String(call.body).includes('"batch"')).length, 1, 'one batch');
  assert.ok(applied.result.bookmarkBefore && applied.result.bookmarkAfter);
  assert.equal(mode(env.file).mode, 'observe');
}

// ===== 7. the source of the operator writes nothing else =====
{
  const text = fs.readFileSync('scripts/upstream-cooldown-mode-production.mjs', 'utf8');
  const statements = [...text.matchAll(/`((?:INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)[^`]*)`/g)].map(m => m[1]);
  assert.equal(statements.length, 2);
  assert.equal(statements.every(s => /upstream_coordination/.test(s)), true, 'only the mode table is written');
  assert.equal(/upstream_cooldown\s*\(|INSERT INTO upstream_cooldown|DELETE FROM|enforce'\s*[,}]/.test(statements.join('\n')), false);
  assert.equal(/fetch\(|api\.themoviedb|letterboxd\.com|query\.wikidata/.test(text.replace(/\/\/.*$/gm, '')), false, 'no upstream request');
}

// ===== 8. evidence aggregation: the bounds hold against the REAL coordinator =====
{
  const env = open();
  sql(env.file, `INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, 'observe', 1, ${NOW})`);
  sql(env.file, `INSERT INTO upstream_cooldown (scope, until_at, reason, retry_after_s, set_by, updated_at) VALUES ('tmdb', ${NOW + 600_000}, 'rate_limited', NULL, 'seed', ${NOW})`);
  const logs = [];
  const original = console.log;
  console.log = (...a) => {logs.push(a.join(' '));};
  const truth = new Map();
  try {
    for (const [caller, runs] of [['discovery', [1, 2, 3, 7, 8, 100]], ['poster_weekly', [5, 5]]]) {
      for (const n of runs) {
        const c = createCoordinator({DB: env.db}, {caller, now: () => NOW});
        for (let i = 0; i < n; i++) {const gate = await c.peek('tmdb'); assert.equal(gate.skip, false, 'observe never skips'); assert.equal(gate.wouldSkip, true);}
        assert.equal(c.snapshot().skipped, 0);
        truth.set(caller, (truth.get(caller) || 0) + n);
      }
    }
    const c = createCoordinator({DB: env.db}, {caller: 'letterboxd_scan', now: () => NOW});
    await c.after('letterboxd', {status: 429, headers: new Headers({'retry-after': '60'})});
  } finally {console.log = original;}
  const report = Report.aggregate(['noise line', ...logs, '{"event":"upstream_cooldown","decision":"bogus"}']);
  assert.equal(report.malformedLines, 1); assert.equal(report.ignoredLines, 1);
  for (const [caller, n] of truth) {
    const row = report.rows.find(r => r.caller === caller && r.scope === 'tmdb' && r.decision === 'would_skip');
    assert.equal(row.lower <= n && n <= row.upper, true, `${caller}: ${row.lower} <= ${n} <= ${row.upper}`);
    assert.equal(row.inconsistent, undefined);
  }
  assert.equal(report.rows.find(r => r.caller === 'discovery' && r.decision === 'would_skip').streams, 6);
  const written = report.rows.find(r => r.decision === 'written');
  assert.deepEqual([written.caller, written.scope, written.lower, written.upper, written.cooldownSecondsLogged], ['letterboxd_scan', 'letterboxd', 1, 1, {rate_limited: 60}]);
  assert.deepEqual(report.flags, ['malformed_lines']); assert.equal(report.evidence.status, 'insufficient');
  assert.equal(Report.markdown(report).includes('| tmdb | discovery | would_skip |'), true);
}

// ===== 9. aggregator arithmetic, flags and the CLI =====
{
  const line = (decision, count, extra = {}) => JSON.stringify({event: 'upstream_cooldown', decision, caller: 'c', scope: 'tmdb', count, ...extra});
  // two runs: one stopped at 1 (1 decision), one logged 1,2,4 (4..7 decisions)
  const report = Report.aggregate([line('would_skip', 1), line('would_skip', 1), line('would_skip', 2), line('would_skip', 4)]);
  const row = report.rows[0];
  assert.deepEqual([row.streams, row.lower, row.upper, row.lines], [2, 5, 8, 4]);
  assert.deepEqual(report.flags, []);
  assert.deepEqual([report.evidence.status, report.evidence.completenessProven, report.evidence.uc3Eligible, report.limits], ['conditional', false, false, ['completeness_unproven', 'identity_unverified']], 'plain lines: conditional, never complete, never a UC3 GO');
  assert.deepEqual(Report.aggregate([line('skipped', 1)]).flags, ['actual_skips'], 'an actual skip in observe is a defect');
  assert.deepEqual(Report.aggregate([line('write_failed', 1)]).flags, ['write_failed']);
  assert.deepEqual(Report.aggregate([line('would_skip', 2)]).flags, ['inconsistent_export'], 'a run that logged 2 without 1 is an incomplete export');
  assert.deepEqual(Report.aggregate([line('would_skip', 3)]).flags, ['inconsistent_export']);
  assert.deepEqual(Report.aggregate([]).flags, ['no_events']);
  assert.throws(() => Report.parseArgs(['node', 'x', '--bogus']));
  const run = spawnSync(process.execPath, ['scripts/upstream-cooldown-evidence-report.mjs', '--format', 'json'], {input: line('would_skip', 1) + '\n', encoding: 'utf8'});
  assert.equal(run.status, 0); assert.equal(JSON.parse(run.stdout).totals.would_skip.lower, 1);
}

// ===== 10. evidence completeness: what the arithmetic cannot establish (review P1-B) =====
{
  const event = (decision, count, extra = {}) => ({event: 'upstream_cooldown', decision, caller: 'c', scope: 'tmdb', count, ...extra});
  const wrap = (body, id, at) => JSON.stringify({source: body, timestamp: at, $metadata: {id}});
  // empty input is NO evidence, not a zero
  const none = Report.aggregate([]);
  assert.deepEqual([none.evidence.status, none.flags, none.totals.would_skip.upper], ['none', ['no_events'], 0]);
  assert.equal(Report.aggregate(['unrelated line', '']).evidence.status, 'none');
  assert.match(Report.markdown(none), /NO EVIDENCE: no upstream_cooldown event was found\. This is not a zero count/);
  // a truncated query: the number of events reached the query limit
  const many = Array.from({length: 5}, (_, i) => wrap(event('would_skip', 1), 'id-' + i, 1000 + i));
  assert.deepEqual(Report.aggregate(many, {queryLimit: 5}).flags, ['possibly_truncated']);
  assert.deepEqual(Report.aggregate(many, {queryLimit: 6}).flags, []);
  assert.equal(Report.aggregate(many, {queryLimit: 5}).evidence.status, 'insufficient');
  // structured events are de-duplicated by id: an overlapping export never counts a decision twice
  const dup = Report.aggregate([wrap(event('would_skip', 1), 'x', 1), wrap(event('would_skip', 1), 'x', 1), wrap(event('would_skip', 1), 'y', 2)]);
  assert.deepEqual([dup.events, dup.duplicateEvents, dup.rows[0].streams, dup.flags, dup.limits], [2, 1, 2, ['duplicate_events'], ['completeness_unproven']]);
  assert.equal(dup.evidence.status, 'insufficient');
  // plain lines carry no identity: a repeated line is legitimate (two streams) and cannot be told from an overlap
  const plain = JSON.stringify(event('would_skip', 1));
  assert.deepEqual([Report.aggregate([plain, plain]).rows[0].streams, Report.aggregate([plain, plain]).limits.includes('identity_unverified')], [2, true]);
  // the same file twice, and two files whose event ids or time windows overlap
  const a = [wrap(event('would_skip', 1), 'a1', Date.parse('2026-11-29T10:00:00Z')), wrap(event('would_skip', 2), 'a2', Date.parse('2026-11-29T10:30:00Z'))].join('\n');
  const b = [wrap(event('would_skip', 1), 'b1', Date.parse('2026-11-29T10:20:00Z'))].join('\n');
  const c = [wrap(event('would_skip', 1), 'c1', Date.parse('2026-11-29T11:00:00Z'))].join('\n');
  assert.equal(Report.aggregateFiles([{name: 'a', text: a}, {name: 'a2', text: a}]).flags.includes('duplicate_files'), true);
  const overlapping = Report.aggregateFiles([{name: 'a', text: a}, {name: 'b', text: b}]);
  assert.equal(overlapping.flags.includes('overlapping_exports'), true, 'b starts inside a\'s window'); assert.equal(overlapping.evidence.status, 'insufficient');
  const disjoint = Report.aggregateFiles([{name: 'a', text: a}, {name: 'c', text: c}]);
  assert.deepEqual([disjoint.flags, disjoint.evidence.status, disjoint.files.length], [[], 'conditional', 2]);
  assert.match(Report.markdown(disjoint), /Exports: a 2 records, 2 events, 2026-11-29T10:00:00\.000Z \.\. 2026-11-29T10:30:00\.000Z; c 1 records, 1 events/);
  // what NO check can see: an entire missing stream or a missing tail pass every test and stay CONDITIONAL, never complete (documented limit of the arithmetic)
  const truth = [event('would_skip', 1), event('would_skip', 2), event('would_skip', 4), event('would_skip', 1)];
  const lost = Report.aggregate(truth.slice(0, 3).map(JSON.stringify)); // the second stream and the tail of nothing are missing
  assert.deepEqual([lost.flags, lost.evidence.status, lost.evidence.completenessProven, lost.evidence.uc3Eligible], [[], 'conditional', false, false]);
  assert.equal(lost.rows[0].streams < Report.aggregate(truth.map(JSON.stringify)).rows[0].streams, true, 'the loss is real and invisible to the flags');
  assert.match(Report.markdown(lost), /CONDITIONAL: .* This report is not a UC3 GO\./);
  // the truncation limit belongs to ONE query (review round 2): each file is checked on its own, the decision accounting stays global
  const batch = (prefix, n, base) => Array.from({length: n}, (_, i) => wrap(event('would_skip', 1), prefix + i, base + i * 60_000)).join('\n');
  const first = {name: 'first', text: batch('p', 3, Date.parse('2026-11-29T08:00:00Z'))};
  const second = {name: 'second', text: batch('q', 3, Date.parse('2026-11-29T09:00:00Z'))};
  const belowLimit = Report.aggregateFiles([first, second], {queryLimit: 5});
  assert.deepEqual([belowLimit.events, belowLimit.flags, belowLimit.evidence.status], [6, [], 'conditional'], 'two disjoint below-limit files whose sum exceeds the limit are NOT truncated');
  assert.equal(belowLimit.rows[0].streams, 6, 'the combined accounting stays global');
  const atLimit = Report.aggregateFiles([first, {name: 'full', text: batch('r', 5, Date.parse('2026-11-29T10:00:00Z'))}], {queryLimit: 5});
  assert.deepEqual([atLimit.flags, atLimit.evidence.status], [['possibly_truncated'], 'insufficient'], 'one file that reaches its own limit is');
  // returned records count before de-duplication and include non-matching records; blank lines do not count
  const noisy = {name: 'noisy', text: [batch('s', 3, Date.parse('2026-11-29T11:00:00Z')), 'a returned record that is not an event', '', '   '].join('\n')};
  assert.equal(Report.aggregateFiles([noisy], {queryLimit: 5}).files[0].records, 4, 'three events and one other record; the two blank lines do not count');
  assert.deepEqual([Report.aggregateFiles([noisy], {queryLimit: 5}).flags, Report.aggregateFiles([noisy], {queryLimit: 4}).flags], [[], ['possibly_truncated']], 'four returned records reach a limit of 4, not of 5');
  // separate EMPTY exports hash alike but are not duplicate evidence: the honest status stays "no evidence"
  const empties = Report.aggregateFiles([{name: 'e1', text: ''}, {name: 'e2', text: ''}, {name: 'e3', text: '\n'}]);
  assert.deepEqual([empties.flags, empties.evidence.status], [['no_events'], 'none']);
  // a non-empty duplicate still is one
  assert.equal(Report.aggregateFiles([first, {name: 'again', text: first.text}]).flags.includes('duplicate_files'), true);
  // the CLI: several files, a per-file limit, JSON, in a portable temp directory
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooldown-report-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.ndjson'), a); fs.writeFileSync(path.join(dir, 'b.ndjson'), b);
    const cli = spawnSync(process.execPath, ['scripts/upstream-cooldown-evidence-report.mjs', '--format', 'json', '--query-limit', '2', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson')], {encoding: 'utf8'});
    assert.equal(cli.status, 0); const parsedCli = JSON.parse(cli.stdout);
    assert.equal(parsedCli.flags.includes('overlapping_exports'), true); assert.equal(parsedCli.flags.includes('possibly_truncated'), true, 'a.ndjson holds 2 records and reaches the limit of 2');
    const roomy = spawnSync(process.execPath, ['scripts/upstream-cooldown-evidence-report.mjs', '--format', 'json', '--query-limit', '3', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson')], {encoding: 'utf8'});
    assert.equal(JSON.parse(roomy.stdout).flags.includes('possibly_truncated'), false, 'a (2) and b (1) are each below 3 although together they are 3');
    assert.throws(() => Report.parseArgs(['node', 'x', '--query-limit', '0']));
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
}
console.log('upstream-cooldown-mode-production: ok');
