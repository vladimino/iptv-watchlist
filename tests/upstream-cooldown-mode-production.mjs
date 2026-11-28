// AIR-609 (UC2): the narrow production operator of the upstream cooldown mode (scripts/upstream-cooldown-mode-production.mjs) and the offline evidence aggregator
// (scripts/upstream-cooldown-evidence-report.mjs). Offline only: a sqlite D1 stand-in over the real migration chain, no production database, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  // a cooldown row that changes during the window is caught by the readback digest
  const dirty = open();
  const writing = {prepare: s => dirty.db.prepare(s), batch: async b => {const r = await dirty.db.batch(b); sql(dirty.file, `INSERT INTO upstream_cooldown (scope, until_at, reason, retry_after_s, set_by, updated_at) VALUES ('tmdb', ${NOW + 1000}, 'rate_limited', NULL, 'x', ${NOW})`); return r;}};
  const bad = await stop(Op.execute('set', {binding: writing, now: NOW, ctx: ctx(), params: {mode: 'observe', expectRevision: 0, operatorSha256: SHA}}), 'write_uncertain');
  assert.equal(bad.details.problems.includes('cooldown_rows_changed'), true);
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
  assert.equal(report.rows.find(r => r.caller === 'discovery' && r.decision === 'would_skip').runs, 6);
  const written = report.rows.find(r => r.decision === 'written');
  assert.deepEqual([written.caller, written.scope, written.lower, written.upper, written.cooldownSecondsLogged], ['letterboxd_scan', 'letterboxd', 1, 1, {rate_limited: 60}]);
  assert.deepEqual(report.flags, ['malformed_lines']);
  assert.equal(Report.markdown(report).includes('| tmdb | discovery | would_skip |'), true);
}

// ===== 9. aggregator arithmetic, flags and the CLI =====
{
  const line = (decision, count, extra = {}) => JSON.stringify({event: 'upstream_cooldown', decision, caller: 'c', scope: 'tmdb', count, ...extra});
  // two runs: one stopped at 1 (1 decision), one logged 1,2,4 (4..7 decisions)
  const report = Report.aggregate([line('would_skip', 1), line('would_skip', 1), line('would_skip', 2), line('would_skip', 4)]);
  const row = report.rows[0];
  assert.deepEqual([row.runs, row.lower, row.upper, row.lines], [2, 5, 8, 4]);
  assert.deepEqual(report.flags, []);
  assert.deepEqual(Report.aggregate([line('skipped', 1)]).flags, ['actual_skips'], 'an actual skip in observe is a defect');
  assert.deepEqual(Report.aggregate([line('write_failed', 1)]).flags, ['write_failed']);
  assert.deepEqual(Report.aggregate([line('would_skip', 2)]).flags, ['inconsistent_export'], 'a run that logged 2 without 1 is an incomplete export');
  assert.deepEqual(Report.aggregate([line('would_skip', 3)]).flags, ['inconsistent_export']);
  assert.deepEqual(Report.aggregate([]).flags, []);
  assert.throws(() => Report.parseArgs(['node', 'x', '--bogus']));
  const run = spawnSync(process.execPath, ['scripts/upstream-cooldown-evidence-report.mjs', '--format', 'json'], {input: line('would_skip', 1) + '\n', encoding: 'utf8'});
  assert.equal(run.status, 0); assert.equal(JSON.parse(run.stdout).totals.would_skip.lower, 1);
}
console.log('upstream-cooldown-mode-production: ok');
