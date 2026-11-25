// AIR-599 / ADR 0207 decision 4b: the read-only legacy report (pure function and CLI over local fixture files). Offline; no store is read or written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {legacyReport} from '../src/domain/letterboxd-check-report.js';

const diary = {schemaVersion: 1, films: {
  a1: {reason: 'forbidden', attempts: 6}, a2: {reason: 'rate_limited', attempts: 6}, a3: {reason: 'tmdb_mismatch', attempts: 6}, a4: {reason: 'fetch_failed', attempts: 6},
  b1: {reason: 'forbidden', attempts: 2}, d1: {reason: 'owner_dismissed', attempts: 6},
}};
const ledger = [
  {lid: 'r1', state: 'terminal', attempts: 1, lastReason: 'age_exceeded', onWatchlist: true}, {lid: 'r2', state: 'terminal', attempts: 0, lastReason: 'age_exceeded', onWatchlist: false},
  {lid: 'r3', state: 'terminal', attempts: 6, lastReason: 'timeout'}, {lid: 'r4', state: 'terminal', attempts: 6, lastReason: 'fetch_failed'}, {lid: 'r5', state: 'terminal', attempts: 6, lastReason: 'tmdb_mismatch'},
  {lid: 'r6', state: 'pending', attempts: 2, lastReason: 'forbidden'},
];
const report = legacyReport({diary, ledger});
assert.deepEqual(report.diaryAtCap, {count: 4, byLastReason: {fetch_failed: 1, forbidden: 1, rate_limited: 1, tmdb_mismatch: 1}}, 'a dismissed and a below-cap entry are not listed');
assert.deepEqual(report.ledgerAgeExceeded, {count: 2, onWatchlist: 1, offWatchlist: 1, unknown: 0});
assert.deepEqual(report.ledgerExhaustedTransport, {count: 1, byLastReason: {timeout: 1}});
assert.deepEqual(report.ledgerExhaustedAmbiguous, {count: 1, byLastReason: {fetch_failed: 1}}, 'the old fetch_failed mixed a 404 and a 5xx: owner review, not recovery');
assert.deepEqual(report.recovery, {entries: 2, rows: 2, batches: 2, batchLimit: 50});
assert.equal(report.ids, undefined, 'no ids unless asked');
const withIds = legacyReport({diary, ledger, withIds: true});
assert.deepEqual(withIds.ids.recoverEntryBatches, [['a1', 'a2']]); assert.deepEqual(withIds.ids.recoverRowBatches, [['r1', 'r3']]);
assert.deepEqual(withIds.ids.ownerReview, ['a3', 'a4', 'r2', 'r4']);
const many = legacyReport({diary: {films: Object.fromEntries(Array.from({length: 120}, (_, i) => ['x' + String(i).padStart(3, '0'), {reason: 'forbidden', attempts: 6}]))}, withIds: true});
assert.deepEqual(many.ids.recoverEntryBatches.map(batch => batch.length), [50, 50, 20], 'recovery batches of at most 50');
// the CLI reads two local files and prints the aggregate report
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-legacy-'));
fs.writeFileSync(path.join(dir, 'diary.json'), JSON.stringify(diary));
fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(ledger.map(row => ({...row, onWatchlist: row.onWatchlist === true ? 1 : row.onWatchlist === false ? 0 : null}))));
const cli = spawnSync(process.execPath, ['scripts/letterboxd-check-legacy-report.mjs', '--diary', path.join(dir, 'diary.json'), '--ledger', path.join(dir, 'ledger.json')], {encoding: 'utf8'});
assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), report);
fs.rmSync(dir, {recursive: true, force: true});
console.log('letterboxd-check-legacy-report: ok');
