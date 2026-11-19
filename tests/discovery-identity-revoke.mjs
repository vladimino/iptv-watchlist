// AIR-132 / ADR 0178: revoke one saved owner correction. Local sqlite stand-ins only: no Cloudflare, no TMDB, no production D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import * as Identity from '../src/domain/discovery-identity-review.js';
import {observationDecisionView} from '../src/domain/discovery-observation-index.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-identity-revoke-'));
process.on('exit', () => { try { fs.rmSync(root, {recursive: true, force: true}); } catch {} });
const files = fs.readdirSync('migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
const file = path.join(root, 'revoke.sqlite');
const built = sqliteSync(['-bail', file], {input: 'PRAGMA foreign_keys=ON;\n' + files.map(name => fs.readFileSync('migrations/' + name, 'utf8')).join('\n'), encoding: 'utf8', maxBuffer: 1 << 26});
if (built.status !== 0) throw new Error(built.stderr);
const db = d1Standin(file);
db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
const env = {DB: db, BUCKET: new MemoryBucket(), discoveryLease: null};
const count = sql => Number(Object.values(db.sql(sql)[0] || {n: 0})[0] || 0);
const RUN = 'run-b';
const hash = value => Authority.decisionHash(value);
const read = async key => (await Authority.routeRead(env, 'epg/discovery-resolution.json')).value[key];

let lease = (await Authority.acquireLease(env, {programmeRunId: null, role: 'epg'})).lease;
assert.ok(lease);
env.discoveryLease = lease;
const item = key => ({key, title: 'T ' + key, normalizedTitle: 't ' + key, year: 1999, durations: [100], shows: [{channelId: 'news', channel: 'News', start: 5, end: 9}], seenInLatestSnapshot: true, lastAiring: 5});
await Authority.replaceLedger(env, {programmeRunId: RUN, items: [item('obs-1'), item('obs-2'), item('obs-3'), item('obs-other')]});
const base = key => ({status: 'needs_verification', attempts: 1, evidenceKey: Authority.evidenceKey(item(key)), terminalReason: 'awaiting_confirmation', retryAt: null, scoring: {status: 'accepted', acceptedTmdbId: '41'}});
await Authority.routeWrite(env, 'epg/discovery-resolution.json', {'obs-1': base('obs-1'), 'obs-2': base('obs-2'), 'obs-3': base('obs-3'), 'obs-other': {...base('obs-other'), status: 'verified', tmdbId: '7', filmId: 'tmdb_7', identitySource: 'tmdb_detail'}});
const otherBefore = JSON.stringify(db.sql("SELECT * FROM discovery_decision WHERE observation_key='obs-other'"));
db.sql("UPDATE published_epg_authority SET programme_run_id='run-b' WHERE id=1");
const renewed = await Authority.renewLease(env, lease, {programmeRunId: RUN});
assert.ok(renewed.lease || renewed.renewed || renewed, 'the lease moves to the run');
if (renewed.lease) { lease = renewed.lease; env.discoveryLease = lease; }

let sequence = 0;
const idem = () => 'req-' + String(++sequence).padStart(14, '0');
// One owner action through the real writer, exactly as the route performs it.
async function act(key, kind, command, build, expectedHash, extra = {}) {
  const requestId = extra.requestId || idem();
  const saved = await Authority.putIntent(env, {idempotencyKey: requestId, kind, observationKey: key, command, expectedHash, expiresAt: Date.now() + 600000, issued: {capability: 'x'}});
  assert.equal(saved.saved, true);
  const previous = await read(key);
  const next = build(previous, requestId);
  const result = await Authority.ownerDecision(env, {idempotencyKey: requestId, key, expectedHash, next, lease, writer: extra.writer || 'discovery_identity_correct', receipt: {state: 'applied', effect: command.effect}});
  return {requestId, result, next};
}
async function doAssign(key, id, extra) {
  const previous = await read(key);
  return act(key, 'identity_assign', {effect: 'assign', tmdbId: id, basis: 'owner says so', ...(extra?.command || {})}, (p, requestId) => Identity.appliedIdentityDecision(p, {effect: 'assign', tmdbId: id, basis: 'owner says so'}, {at: '2026-11-19T10:00:00.000Z', requestId, programmeRunId: RUN}), await hash(previous), extra);
}
async function doReject(key, id, extra) {
  const previous = await read(key);
  return act(key, 'identity_reject', {effect: 'reject', tmdbId: id, basis: 'owner says so'}, (p, requestId) => Identity.appliedIdentityDecision(p, {effect: 'reject', tmdbId: id, basis: 'owner says so'}, {at: '2026-11-19T10:00:00.000Z', requestId, programmeRunId: RUN}), await hash(previous), extra);
}
async function evidenceOf(key, requestId) {
  const evidence = await Authority.readIdentityActionEvidence(env, requestId, key);
  const provenance = evidence.intent && !evidence.wrongObservation ? Identity.revokeProvenance({intent: evidence.intent, history: evidence.history, current: evidence.current}) : {ok: false, reason: evidence.wrongObservation ? 'wrong_observation' : 'intent_missing'};
  return {evidence, provenance};
}
async function doRevoke(key, originalId, extra = {}) {
  const {evidence, provenance} = await evidenceOf(key, originalId);
  assert.equal(provenance.ok, true, 'provenance ' + provenance.reason);
  const command = Identity.revokeCommand(provenance, {basis: 'wrong film'});
  assert.equal(command.ok, true);
  const stored = {effect: 'revoke', revokes: command.revokes, basis: command.basis};
  const requestId = extra.requestId || idem();
  const saved = await Authority.putIntent(env, {idempotencyKey: requestId, kind: 'identity_revoke', observationKey: key, command: stored, expectedHash: evidence.decisionHash, expiresAt: Date.now() + 600000, issued: {capability: 'discovery_identity_revoke'}});
  assert.equal(saved.saved, true);
  const next = Identity.appliedRevokeDecision(evidence.current, stored, {at: '2026-11-19T11:00:00.000Z', requestId, identityBasis: 'b'.repeat(64)});
  const result = await Authority.ownerDecision(env, {idempotencyKey: requestId, key, expectedHash: extra.expectedHash || evidence.decisionHash, next: extra.next || next, lease: extra.lease === undefined ? lease : extra.lease, writer: 'discovery_identity_revoke', receipt: {state: 'applied', capability: 'discovery_identity_revoke', effect: 'revoke'}});
  return {requestId, result, next, evidence};
}

// --- assign -> revoke -----------------------------------------------------------------------------------------------
db.sql("INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('run-b','tmdb_41','c',1,2,'C',NULL,'discovery','obs-1'),('run-b','tmdb_7','d',1,2,'D',NULL,'discovery','obs-other')");
const a1 = await doAssign('obs-1', '41');
assert.equal(a1.result.outcome, 'written');
assert.equal((await read('obs-1')).ownerIdentity.requestId, a1.requestId, 'the marker names the real request');
const historyBefore = db.sql("SELECT * FROM discovery_decision_history WHERE observation_key='obs-1' ORDER BY revision");
const intentBefore = JSON.stringify(db.sql(`SELECT * FROM discovery_intent WHERE idempotency_key='${a1.requestId}'`));
const writesBefore = JSON.stringify([db.sql('SELECT * FROM discovery_decision ORDER BY observation_key'), db.sql('SELECT * FROM discovery_decision_history ORDER BY observation_key, revision'), db.sql('SELECT * FROM discovery_intent ORDER BY idempotency_key')]);
const preview = await evidenceOf('obs-1', a1.requestId);
assert.equal(preview.provenance.ok, true);
assert.equal(preview.provenance.original.effect, 'assign');
assert.equal(JSON.stringify([db.sql('SELECT * FROM discovery_decision ORDER BY observation_key'), db.sql('SELECT * FROM discovery_decision_history ORDER BY observation_key, revision'), db.sql('SELECT * FROM discovery_intent ORDER BY idempotency_key')]), writesBefore, 'reading the evidence writes nothing');
assert.equal((await Authority.readIdentityActionEvidence(env, a1.requestId, 'obs-2')).wrongObservation, true, 'another observation is refused');
assert.equal((await Authority.readIdentityActionEvidence(env, 'req-missing-0000001', 'obs-1')).intent, null);

const r1 = await doRevoke('obs-1', a1.requestId);
assert.equal(r1.result.outcome, 'written');
const after = await read('obs-1');
assert.equal(after.status, 'needs_verification');
assert.equal(after.tmdbId, null);
assert.equal(after.ownerIdentity, undefined, 'the owner marker is gone');
assert.equal(after.revokedOwnerAssign.tmdbId, '41');
assert.equal(after.revokedOwnerAssign.requestId, a1.requestId);
assert.equal(after.revokedOwnerAssign.revokedBy, r1.requestId);
assert.equal(count("SELECT COUNT(*) AS n FROM published_epg_show WHERE match_reason='obs-1'"), 0, 'the assigned shows of this observation are gone');
assert.equal(count("SELECT COUNT(*) AS n FROM published_epg_show WHERE match_reason='obs-other'"), 1, 'another observation keeps its shows');
assert.equal(JSON.stringify(db.sql("SELECT * FROM discovery_decision WHERE observation_key='obs-other'")), otherBefore, 'an unrelated decision is untouched');
const historyAfter = db.sql("SELECT * FROM discovery_decision_history WHERE observation_key='obs-1' ORDER BY revision");
assert.equal(historyAfter.length, historyBefore.length + 1, 'one history row is appended');
assert.deepEqual(historyAfter.slice(0, historyBefore.length).map(row => row.revision), historyBefore.map(row => row.revision));
assert.equal(historyAfter.at(-1).writer, 'discovery_identity_revoke');
assert.equal(JSON.stringify(db.sql(`SELECT * FROM discovery_intent WHERE idempotency_key='${a1.requestId}'`)).includes('"state":"receipt"'), true, 'the original intent keeps its receipt');
assert.equal(count("SELECT COUNT(*) AS n FROM discovery_intent WHERE kind='identity_revoke' AND state='receipt'"), 1);
assert.equal(count('SELECT COUNT(*) AS n FROM film'), 0, 'no film is created or removed');

// A replay returns the receipt and writes nothing.
const replay = await Authority.ownerDecision(env, {idempotencyKey: r1.requestId, key: 'obs-1', expectedHash: 'stale', next: r1.next, lease, writer: 'discovery_identity_revoke'});
assert.equal(replay.outcome, 'replay');
assert.equal(db.sql("SELECT * FROM discovery_decision_history WHERE observation_key='obs-1'").length, historyAfter.length);
// A second revoke of the same original: the fence is already recorded, and the old action is no longer effective.
const again = await evidenceOf('obs-1', a1.requestId);
assert.equal(again.provenance.ok, false);
assert.match(again.provenance.reason, /old_action_not_effective/);
// The fence outlives the resolver's carry of the marker.
assert.equal(Identity.appliedIdentityDecision(after, {effect: 'reject', tmdbId: '99', basis: 'b'}, {at: 'x', requestId: 'r', programmeRunId: RUN}).revokedOwnerAssign.tmdbId, '41');
// Only an owner assign of the same id removes the fence.
assert.equal(Identity.appliedIdentityDecision(after, {effect: 'assign', tmdbId: '41', basis: 'again'}, {at: 'x', requestId: 'r2', programmeRunId: RUN}).revokedOwnerAssign, undefined);
assert.equal(Identity.appliedIdentityDecision(after, {effect: 'assign', tmdbId: '42', basis: 'other'}, {at: 'x', requestId: 'r3', programmeRunId: RUN}).revokedOwnerAssign.tmdbId, '41');

// --- reject -> revoke: only the rejection this action introduced ------------------------------------------------------
{
  const all = (await Authority.routeRead(env, 'epg/discovery-resolution.json')).value;
  await Authority.routeWrite(env, 'epg/discovery-resolution.json', {...all, 'obs-2': {...all['obs-2'], rejectedTmdbIds: ['99']}});
}
const j1 = await doReject('obs-2', '41');
assert.equal(j1.result.outcome, 'written');
const jr = await doRevoke('obs-2', j1.requestId);
assert.equal(jr.result.outcome, 'written');
const rejectedAfter = await read('obs-2');
assert.deepEqual(rejectedAfter.rejectedTmdbIds, ['99'], 'an independent exclusion stays');
assert.equal(rejectedAfter.revokedOwnerAssign, undefined, 'revoking a reject writes no negative fence');
assert.equal(rejectedAfter.ownerIdentity, undefined);

// A reject of an id that was already excluded before the action is ambiguous: refused, nothing written.
{
  const seeded = {...base('obs-3'), rejectedTmdbIds: ['41']};
  const all = (await Authority.routeRead(env, 'epg/discovery-resolution.json')).value;
  await Authority.routeWrite(env, 'epg/discovery-resolution.json', {...all, 'obs-3': seeded});
}
const k1 = await doReject('obs-3', '41');
assert.equal(k1.result.outcome, 'written');
const ambiguous = await evidenceOf('obs-3', k1.requestId);
assert.equal(ambiguous.provenance.ok, false);
assert.equal(ambiguous.provenance.reason, 'provenance_ambiguous');

// --- pure refusals ----------------------------------------------------------------------------------------------------
const intent = {idempotencyKey: 'req-x', kind: 'identity_assign', state: 'receipt', receipt: {}, observationKey: 'o', command: {effect: 'assign', tmdbId: '5'}, before: {status: 'needs_verification'}};
const owner = {effect: 'assign', tmdbId: '5', requestId: 'req-x'};
const assigned = {status: 'verified', tmdbId: '5', filmId: 'tmdb_5', identitySource: 'owner', ownerIdentity: owner};
const rows = [{revision: 1, writer: 'discovery_identity_correct', payload: assigned}];
assert.equal(Identity.revokeProvenance({intent, history: rows, current: assigned}).ok, true);
assert.equal(Identity.revokeProvenance({intent: null, history: rows, current: assigned}).reason, 'intent_missing');
assert.equal(Identity.revokeProvenance({intent: {...intent, state: 'approved'}, history: rows, current: assigned}).reason, 'intent_not_applied');
assert.equal(Identity.revokeProvenance({intent: {...intent, kind: 'reconsider'}, history: rows, current: assigned}).reason, 'not_identity_action');
assert.equal(Identity.revokeProvenance({intent, history: [], current: assigned}).reason, 'provenance_unproven', 'no introducing revision: fail closed');
assert.equal(Identity.revokeProvenance({intent: {...intent, before: null}, history: rows, current: assigned}).reason, 'provenance_unproven');
assert.equal(Identity.revokeProvenance({intent, history: [{...rows[0], writer: 'resolver_chunk'}], current: assigned}).reason, 'provenance_unproven', 'only the identity writer introduces');
assert.equal(Identity.revokeProvenance({intent, history: rows, current: {...assigned, ownerIdentity: {...owner, requestId: 'req-other'}}}).reason, 'old_action_not_effective', 'another owner action replaced it');
assert.equal(Identity.revokeProvenance({intent, history: rows, current: {...assigned, tmdbId: '6', filmId: 'tmdb_6'}}).reason, 'old_action_not_effective', 'a newer independent decision');
assert.equal(Identity.revokeProvenance({intent, history: [...rows, {revision: 2, writer: 'resolver_chunk', payload: {status: 'needs_verification'}}], current: assigned}).reason, 'old_action_not_effective', 'a later revision that dropped the marker');
assert.equal(Identity.revokeProvenance({intent, history: [...rows, {revision: 2, writer: 'resolver_chunk', payload: {...assigned, evidenceKey: 'other airing'}}], current: assigned}).ok, true, 'a carried marker with a drifted scheduling fingerprint is still effective');
assert.equal(Identity.revokeCommand({ok: true, original: {requestId: 'req-x', effect: 'assign', tmdbId: '5'}}, {}).reason, 'basis_required');
assert.equal(Identity.revokeWriteMatches({effect: 'revoke', revokes: {requestId: 'r', effect: 'assign', tmdbId: '5'}}, {status: 'needs_verification', tmdbId: null, revokedOwnerAssign: {tmdbId: '5', requestId: 'r'}}), true);
assert.equal(Identity.revokeWriteMatches({effect: 'revoke', revokes: {requestId: 'r', effect: 'assign', tmdbId: '5'}}, {status: 'verified', tmdbId: '5', ownerIdentity: owner}), false);
assert.equal(Identity.revokeWriteMatches({effect: 'assign', tmdbId: '5'}, {}), false);
// identityBasis: identity inputs only, never an airing, a duration or a score.
const rec = {normalizedTitle: 'a b', year: 1999, confirmedTmdbId: '5', shows: [1], durations: [90]};
assert.equal(Identity.identityBasisText(rec), Identity.identityBasisText({...rec, shows: [2, 3], durations: [100], decision: {scoring: {}}}));
assert.notEqual(Identity.identityBasisText(rec), Identity.identityBasisText({...rec, year: 2000}));
assert.equal(Identity.parseRevokeVersion(Identity.revokeVersion('a'.repeat(64), '5')).tmdbId, '5');
assert.equal(Identity.parseIdentityVersion(Identity.revokeVersion('a'.repeat(64), '5')), null, 'a revoke version is not an assign or reject version');

// --- writer guards ----------------------------------------------------------------------------------------------------
const w1 = await doAssign('obs-3', '55');
assert.equal(w1.result.outcome, 'written');
const staleHash = 'f'.repeat(64);
assert.equal((await doRevoke('obs-3', w1.requestId, {expectedHash: staleHash})).result.outcome, 'conflict', 'a stale decision hash refuses');
const wrongNext = await doRevoke('obs-3', w1.requestId, {next: {...(await read('obs-3'))}});
assert.equal(wrongNext.result.outcome, 'conflict', 'a revoke whose next decision keeps the marker is refused by the typed branch');
env.discoveryLease = null;
assert.equal((await doRevoke('obs-3', w1.requestId, {lease: null})).result.outcome, 'lease', 'no lease, no write');
env.discoveryLease = lease;
assert.equal((await read('obs-3')).ownerIdentity.requestId, w1.requestId, 'nothing changed after the refusals');
// A revoke intent whose command is not a revoke is refused.
await Authority.putIntent(env, {idempotencyKey: 'req-bad-command-001', kind: 'identity_revoke', observationKey: 'obs-3', command: {effect: 'assign', tmdbId: '55'}, expectedHash: await hash(await read('obs-3')), expiresAt: Date.now() + 600000});
assert.equal((await Authority.ownerDecision(env, {idempotencyKey: 'req-bad-command-001', key: 'obs-3', expectedHash: await hash(await read('obs-3')), next: {status: 'verified', tmdbId: '55'}, lease})).outcome, 'conflict');
// An unknown outcome is never retried blindly.
db.sql("UPDATE discovery_intent SET state='running' WHERE idempotency_key='req-bad-command-001'");
assert.equal((await Authority.ownerDecision(env, {idempotencyKey: 'req-bad-command-001', key: 'obs-3', expectedHash: staleHash, next: {}, lease})).outcome, 'unknown');

// --- supersede is enforced, not descriptive ---------------------------------------------------------------------------
const currentHash = await hash(await read('obs-3'));
const sup = {effect: 'assign', tmdbId: '56', basis: 'better id'};
const okSupersede = await act('obs-3', 'identity_assign', {...sup, supersedes: {requestId: w1.requestId, decisionHash: currentHash}}, p => Identity.appliedIdentityDecision(p, sup, {at: 'x', requestId: 'r', programmeRunId: RUN}), currentHash);
assert.equal(okSupersede.result.outcome, 'written', 'a supersede bound to the original and the exact hash is written');
const staleSupersede = await act('obs-1', 'identity_assign', {effect: 'assign', tmdbId: '57', basis: 'b', supersedes: {requestId: w1.requestId, decisionHash: await hash(await read('obs-1'))}}, p => Identity.appliedIdentityDecision(p, {effect: 'assign', tmdbId: '57', basis: 'b'}, {at: 'x', requestId: 'r', programmeRunId: RUN}), await hash(await read('obs-1')));
assert.equal(staleSupersede.result.outcome, 'conflict', 'a supersede of an action on another observation is refused');
const hashLie = await act('obs-1', 'identity_assign', {effect: 'assign', tmdbId: '58', basis: 'b', supersedes: {requestId: a1.requestId, decisionHash: staleHash}}, p => Identity.appliedIdentityDecision(p, {effect: 'assign', tmdbId: '58', basis: 'b'}, {at: 'x', requestId: 'r', programmeRunId: RUN}), await hash(await read('obs-1')));
assert.equal(hashLie.result.outcome, 'conflict', 'a supersede that names another hash than the one it writes over is refused');
assert.equal((await read('obs-1')).tmdbId, null, 'nothing was written by the refused supersedes');
// The old action is no longer effective after the supersede.
assert.equal((await evidenceOf('obs-3', w1.requestId)).provenance.reason, 'old_action_not_effective');

// --- the resolver consumer: the fence is carried and blocks exactly the revoked id -------------------------------------
{
  const source = fs.readFileSync('src/discovery.js', 'utf8');
  const grab = name => { const match = new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n').exec(source); assert.ok(match, name + ' is in the resolver'); return match[0]; };
  const {ownerMarkerCarry, ownerRejected} = new Function(grab('ownerMarkerCarry') + grab('ownerRejected') + 'return {ownerMarkerCarry, ownerRejected};')();
  const fenced = {status: 'needs_verification', revokedOwnerAssign: {tmdbId: '41', requestId: 'r', revokedBy: 'v', at: 'x'}};
  assert.equal(ownerRejected(fenced, '41'), true, 'the revoked id is not re-confirmed');
  assert.equal(ownerRejected(fenced, 41), true);
  assert.equal(ownerRejected(fenced, '42'), false, 'another id is evaluated as usual');
  assert.equal(ownerRejected({status: 'needs_verification'}, '41'), false);
  assert.deepEqual(ownerMarkerCarry(fenced).revokedOwnerAssign, fenced.revokedOwnerAssign, 'the next resolver decision keeps the fence');
  assert.equal(ownerMarkerCarry({status: 'verified'}).revokedOwnerAssign, undefined);
  // A new airing, a rescore or a drifted evidence key changes nothing: the fence is not tied to a scheduling fingerprint.
  assert.equal(ownerRejected({...fenced, evidenceKey: 'another airing', scoring: {acceptedTmdbId: '41'}}, '41'), true);
}
// The owner view shows the fence only when there is one, so ordinary index records do not grow.
assert.equal('revokedOwnerAssign' in observationDecisionView({status: 'needs_verification'}), false);
assert.deepEqual(observationDecisionView({status: 'needs_verification', revokedOwnerAssign: {tmdbId: '41', requestId: 'r', revokedBy: 'v', at: 'x', extra: 'dropped'}}).revokedOwnerAssign, {tmdbId: '41', requestId: 'r', revokedBy: 'v', at: 'x'});
console.log('discovery-identity-revoke ok');
