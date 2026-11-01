// Owner correction of one discovery observation: assign one canonical movie id, or reject one id already on that
// decision. The pure rules, the guarded routes, and the next resolver chunk's respect for the marker.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto, createHash} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import * as Identity from '../src/domain/discovery-identity-review.js';
import * as DI from '../src/domain/discovery-observation-index.js';
import {OBS_IDENTITY_REASON_COPY, obsIdentityBlocked, obsIdentityPreviewText} from '../src/admin/discovery-recovery-view.js';

const source = fs.readFileSync('src/domain/discovery-identity-review.js', 'utf8');
assert.doesNotMatch(source, /\bfetch\b|BUCKET|Date\.now|new Date\(/, 'the identity module is pure');
for (const reason of Identity.DISCOVERY_IDENTITY_REASONS) assert.equal(typeof OBS_IDENTITY_REASON_COPY[reason], 'string', reason);
assert.deepEqual(Identity.identityFromTitle(), {ok: false, reason: 'title_only', tmdbId: null});
assert.equal(Identity.identityMovieId('11'), '11');
assert.equal(Identity.identityMovieId('0'), null);
assert.equal(Identity.identityMovieId('tmdb_tv:11'), null);
assert.equal(Identity.identityStoreAuthority({phase: 'published', programmeRunId: 'run-1'}).authority, 'r2');
assert.equal(Identity.identityStoreAuthority({phase: 'published', programmeRunId: 'run-1', identityAuthority: 'd1'}).reason, 'unknown_authority');
assert.equal(Identity.identityStoreAuthority({phase: 'building', programmeRunId: 'run-1'}).reason, 'unknown_authority');
assert.equal(Identity.parseIdentityVersion('a'.repeat(64) + ':assign:11').effect, 'assign');
assert.equal(Identity.parseIdentityVersion('a'.repeat(64) + ':reject:11').tmdbId, '11');
assert.equal(Identity.parseIdentityVersion('short:assign:11'), null);

const offerInput = (extra = {}) => ({
  record: {key: 'тихий|2001', decisionHash: 'a'.repeat(64), year: 2001, confirmedTmdbId: null, decision: {status: 'needs_verification', tmdbId: null, scoring: {status: 'accepted', reason: 'unique', acceptedTmdbId: '11', scorerVersion: '1'}, rejectedTmdbIds: [], ownerIdentity: null}},
  index: {state: 'fresh', complete: true},
  generation: {phase: 'published', programmeRunId: 'run-1'},
  series: {state: 'continuing', at: null},
  ...extra,
});
let offer = Identity.identityOffer(offerInput());
assert.equal(offer.available, true);
assert.deepEqual(offer.trusted, []);
assert.deepEqual(offer.hypothesis, {tmdbId: '11', source: 'scoring', trusted: false});
assert.deepEqual(offer.rejectable, ['11']);
assert.equal(Identity.identityOffer(offerInput({index: {state: 'fresh', complete: false}})).reason, 'index_incomplete');
assert.equal(Identity.identityOffer(offerInput({index: {state: 'stale', complete: true}})).reason, 'index_not_current');
assert.equal(Identity.identityOffer(offerInput({generation: {phase: 'published', programmeRunId: 'run-1', programmeAuthority: 'd1'}})).reason, 'unknown_authority');
assert.equal(Identity.identityOffer(offerInput({series: {state: 'live_writer'}})).reason, 'writer_active');
assert.equal(Identity.identityOffer(offerInput({record: {...offerInput().record, decision: {status: 'ambiguous', scoring: null, rejectedTmdbIds: []}}})).reason, 'identity_ambiguous');

const film = {id: 'tmdb_11', tmdbId: '11', canonicalIdentity: 'tmdb:11', year: 2001, title: 'Тихий'};
const record = offerInput().record;
assert.equal(Identity.identityCommand(record, {effect: 'assign', tmdbId: '11', basis: 'это тот'}, film).ok, true);
assert.equal(Identity.identityCommand(record, {effect: 'assign', tmdbId: '11', basis: 'это тот'}, {...film, year: 1990}).reason, 'year_conflict');
assert.equal(Identity.identityCommand(record, {effect: 'assign', tmdbId: '11', basis: 'это тот'}, {...film, canonicalIdentity: 'tmdb_tv:11'}).reason, 'tmdb_tv');
assert.equal(Identity.identityCommand(record, {effect: 'assign', tmdbId: '11', basis: 'это тот'}, {...film, conflictingTmdbIds: ['11', '12']}).reason, 'conflicting_identity');
assert.equal(Identity.identityCommand(record, {effect: 'assign', tmdbId: '11', basis: 'это тот'}, null).reason, 'film_absent');
assert.equal(Identity.identityCommand(record, {effect: 'assign', tmdbId: '11', basis: 'это тот'}, undefined).reason, 'catalogue_unread');
assert.equal(Identity.identityCommand({...record, year: null}, {effect: 'assign', tmdbId: '11', basis: 'это тот'}, film).reason, 'year_unknown');
assert.equal(Identity.identityCommand({...record, year: null, confirmedTmdbId: '11'}, {effect: 'assign', tmdbId: '11', basis: 'это тот'}, {...film, year: null}).ok, true);
assert.equal(Identity.identityCommand(record, {effect: 'assign', tmdbId: '11', basis: '   '}, film).reason, 'basis_required');
assert.equal(Identity.identityCommand(record, {effect: 'reject', tmdbId: '11', basis: 'не тот'}, null).ok, true);
assert.equal(Identity.identityCommand(record, {effect: 'reject', tmdbId: '99', basis: 'не тот'}, null).reason, 'not_on_decision');
const ambiguous = {...record, confirmedTmdbId: '11', decision: {status: 'ambiguous', scoring: {acceptedTmdbId: '22'}}};
assert.equal(Identity.identityCommand(ambiguous, {effect: 'assign', tmdbId: '22', basis: 'это тот'}, {...film, tmdbId: '22', canonicalIdentity: 'tmdb:22', id: 'tmdb_22'}).reason, 'ambiguous_needs_stronger');
assert.equal(Identity.identityCommand(ambiguous, {effect: 'assign', tmdbId: '11', basis: 'это тот'}, film).ok, true);
const previous = {status: 'needs_verification', attempts: 2, evidenceKey: 'ev', scoring: {acceptedTmdbId: '11'}, terminalReason: 'awaiting_confirmation'};
const assigned = Identity.appliedIdentityDecision(previous, {effect: 'assign', tmdbId: '11', basis: 'это тот'}, {at: '2026-11-01T12:00:00.000Z', requestId: 'req-1', programmeRunId: 'run-1'});
assert.equal(assigned.status, 'verified');
assert.equal(assigned.identitySource, 'owner');
assert.equal(assigned.terminalReason, null);
assert.equal(assigned.evidenceKey, 'ev');
assert.equal(assigned.filmId, 'tmdb_11');
const rejected = Identity.appliedIdentityDecision(previous, {effect: 'reject', tmdbId: '11', basis: 'не тот'}, {at: '2026-11-01T12:00:00.000Z', requestId: 'req-1', programmeRunId: 'run-1'});
assert.equal(rejected.status, 'needs_verification');
assert.deepEqual(rejected.rejectedTmdbIds, ['11']);
assert.equal(rejected.evidenceKey, 'ev');
assert.equal(Identity.identityCommand({...record, decision: rejected}, {effect: 'reject', tmdbId: '11', basis: 'не тот'}, null).reason, 'already_current');
const shown = {identity: offer, observation: {title: 'Тихий', key: 'тихий|2001'}, index: {programmeRunId: 'run-1'}};
assert.equal(obsIdentityPreviewText(shown, {identityEffect: 'reject', identityTarget: '11'}), 'Сейчас: гипотеза 11 → Станет: id 11 заблокирован только у наблюдения «Тихий».');
assert.equal(obsIdentityPreviewText(shown, {identityEffect: 'assign', identityTarget: ''}), '');
assert.match(obsIdentityBlocked(shown, {identityEffect: 'reject', identityTarget: '99', identityBasis: 'не тот'}), /уже стоит на этом решении/);

const sha = text => createHash('sha256').update(text).digest('hex');
const memory = new MemoryBucket();
const log = {puts: [], gets: []};
const hooks = {beforePut: null, afterGet: null, putError: null};
const bucket = {
  async get(key) {log.gets.push(key); const object = await memory.get(key); return hooks.afterGet ? hooks.afterGet(key, object) : object;},
  async head(key) {return memory.head(key);},
  async put(key, body, options = {}) {
    if (hooks.beforePut) await hooks.beforePut(key, body, options);
    if (hooks.putError && hooks.putError(key)) throw new Error('r2 put failed');
    const saved = await memory.put(key, body, options);
    if (saved) log.puts.push(key);
    return saved;
  },
  async delete() {throw new Error('nothing here deletes');},
  async list() {throw new Error('nothing here lists');},
};
let clock = Date.parse('2026-11-01T12:00:00.000Z'), tmdbCalls = 0;
const FrozenDate = class extends Date {constructor(...args) {super(...(args.length ? args : [clock]));} static now() {return clock;}};
const context = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date: FrozenDate, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, console: {log() {}, error() {}, warn() {}}, setTimeout, structuredClone, encodeURIComponent, decodeURIComponent,
  fetch: async url => {tmdbCalls++; return new Response(JSON.stringify(String(url).includes('/search/') ? {total_pages: 1, results: []} : {id: 11, title: 'Тихий', original_title: 'Quiet', release_date: '2001-01-01', runtime: 95}));}});
vm.runInContext(scoped('src/domain/discovery-observation-index.js', 'DiscoveryIndex'), context);
for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/domain/profile-impact.js', 'src/domain/prediction-compatibility.js', 'src/domain/fingerprint-compatibility.js', 'src/domain/scored-resolution.js', 'src/domain/resolution-acceptance.js', 'src/sources.js', 'src/ratings-seed.js', 'src/discovery.js', 'src/letterboxd-facts.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), context);
vm.runInContext(fs.readFileSync('src/admin/owner-reviews.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), context);
vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), context);
vm.runInContext(scoped('src/domain/limbo-inventory.js', 'LimboInventory'), context);
vm.runInContext(fs.readFileSync('src/admin/limbo.js', 'utf8'), context);
vm.runInContext(scoped('src/domain/admin-actions.js', 'AdminActions'), context);
vm.runInContext(scoped('src/domain/discovery-identity-review.js', 'DiscoveryIdentity'), context);
vm.runInContext(scoped('src/domain/discovery-recovery.js', 'DiscoveryRecovery'), context);
vm.runInContext(fs.readFileSync('src/admin/discovery-recovery.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('src/worker.js', 'utf8').replace('export default', 'globalThis.worker='), context);
const env = {BUCKET: bucket, TMDB_API_READ_ACCESS_TOKEN: 'test', TMDB_REQUEST_INTERVAL_MS: 0};
context.env = env;
const ORIGIN = 'https://iptv.example', RUN = '11111111-1111-4111-8111-111111111111';
const H = 3600000;
const MAP = 'epg/discovery-resolution.json', CATALOG = 'epg/discovered-films.json';
const KEY = 'тихий берег|2001', OTHER = 'громкий берег|2002';
const iso = ms => new Date(clock + ms).toISOString();
const show = start => ({channelId: 'c1', channel: 'Первый', start, end: start + 2 * H});
const candidate = (key, extra = {}) => ({key, title: 'Тихий берег', normalizedTitle: key.split('|')[0], year: Number(key.split('|')[1]) || null, duration: 95, durations: [95], shows: [show(clock + 3 * H)], seenInLatestSnapshot: true, lastSeenAt: clock - H, lastAiring: clock + 3 * H, ...extra});
const evidenceOf = item => vm.runInContext('candidateEvidence(__c)', Object.assign(context, {__c: item}));
const json = async key => {const object = await memory.get(key); return object ? JSON.parse(await object.text()) : null;};
const put = (key, value) => memory.put(key, JSON.stringify(value));
const canonical = extra => ({id: 'tmdb_11', tmdbId: '11', canonicalIdentity: 'tmdb:11', title: 'Тихий берег', year: 2001, ...extra});
async function seed(decisionExtra = {}, options = {}) {
  memory.objects.clear();
  hooks.beforePut = hooks.afterGet = hooks.putError = null;
  const items = [candidate(KEY), candidate(OTHER, {title: 'Громкий берег'})];
  const decisions = {
    [KEY]: {status: 'needs_verification', attempts: 2, evidenceKey: evidenceOf(items[0]), lastAttemptAt: iso(-H), checkedAt: iso(-H), retryAt: null, terminalReason: null, scoring: {scorerVersion: '1', status: 'accepted', reason: 'unique', acceptedTmdbId: '11'}, ...decisionExtra},
    [OTHER]: {status: 'no_confident_match', attempts: 1, evidenceKey: evidenceOf(items[1]), retryAt: null, terminalReason: null},
  };
  await put('epg/published-generation.json', {phase: 'published', programmeRunId: RUN, ...(options.authority ? {identityAuthority: options.authority} : {})});
  await put('epg/generations/' + RUN + '/discovery-latest.json', {programmeRunId: RUN, items});
  await put(MAP, decisions);
  await put(CATALOG, {tmdb_11: canonical(options.film || {})});
  await put('epg/resolver-continuation.json', {stage: 'paused', reason: null, remainingChunks: 6, programmeRunId: RUN, at: iso(-H)});
  await put('epg/discovery-status.json', {stage: 'complete', at: iso(-H), programmeRunId: RUN});
  context.__source = {programmeRunId: RUN, items};
  context.__decisions = decisions;
  if (options.skipIndex) return;
  const written = await vm.runInContext('saveObservationIndex(env,__source,__decisions,async()=>true,{kind:"resolver_chunk",hopId:"hop-seed"})', context);
  assert.equal(written.written, true);
  if (options.partial) {
    const manifest = await json(DI.observationIndexManifestKey(RUN));
    manifest.coverage.complete = false;
    manifest.coverage.eligible = manifest.coverage.indexed + 5;
    await put(DI.observationIndexManifestKey(RUN), manifest);
  }
  log.puts = []; log.gets = []; tmdbCalls = 0;
}
const request = (path, init) => context.worker.fetch(new Request(ORIGIN + path, init), env, {waitUntil() {throw new Error('no background work');}});
const get = async path => {const response = await request(path); return {status: response.status, body: await response.json()};};
const headers = (action = 'discovery_identity_correct') => ({'Cf-Access-Jwt-Assertion': 'header.payload.signature', Origin: ORIGIN, 'X-IPTV-Admin-Action': action, 'Content-Type': 'application/json'});
const post = async (action, body, extra) => {const response = await request('/api/admin/discovery-recovery/' + action, {method: 'POST', headers: headers(extra), body: JSON.stringify(body)}); return {status: response.status, body: await response.json()};};
let n = 0;
const idem = () => 'idem-identity-' + String(++n).padStart(8, '0');
const view = () => get('/api/admin/discovery-recovery?key=' + encodeURIComponent(KEY));
async function confirm(effect, tmdbId = '11', basis = 'это тот фильм', extra = {}) {
  const answer = await view();
  return {answer, issued: await post('identity-confirm', {key: KEY, pin: answer.body.pin, idempotencyKey: extra.idempotencyKey || idem(), accepted: true, effect, tmdbId, basis, ...extra.body})};
}

await seed();
let seen = await view();
assert.equal(seen.status, 200);
assert.equal(seen.body.identity.available, true);
assert.deepEqual(seen.body.identity.trusted, []);
assert.equal(seen.body.identity.hypothesis.tmdbId, '11');
assert.equal(seen.body.identity.hypothesis.trusted, false);
assert.equal(tmdbCalls, 0);
assert.equal(log.gets.includes(CATALOG), false, 'GET does not read the catalogue');
assert.equal(log.gets.includes(MAP), false, 'GET does not read the resolution map');
assert.deepEqual(log.puts, []);

const assign = await confirm('assign');
assert.equal(assign.issued.status, 200, JSON.stringify(assign.issued.body));
assert.equal(assign.issued.body.confirmation.capability, 'discovery_identity_correct');
assert.equal(assign.issued.body.command.effect, 'assign');
assert.equal(assign.issued.body.plan.after.status, 'verified');
assert.equal(assign.issued.body.plan.after.tmdbId, '11');
assert.equal((await json(MAP))[KEY].status, 'needs_verification', 'confirm writes no decision');
const reused = await post('identity-confirm', {key: KEY, pin: assign.answer.body.pin, idempotencyKey: assign.issued.body.confirmation.idempotencyKey, accepted: true, effect: 'reject', tmdbId: '11', basis: 'не тот'});
assert.equal(reused.body.refusal, 'idempotency_conflict');
const beforeMap = JSON.stringify(await json(MAP));
const executed = await post('identity-correct', {confirmation: assign.issued.body.confirmation});
assert.equal(executed.body.state, 'succeeded', JSON.stringify(executed.body));
assert.equal(executed.body.replayed, false);
assert.equal(executed.body.application.shows, 'next_ordinary_chunk');
assert.equal(executed.body.application.catalog, true);
assert.deepEqual(executed.body.application.consumers, ['resolution_decision']);
const written = (await json(MAP))[KEY];
assert.equal(written.status, 'verified');
assert.equal(written.identitySource, 'owner');
assert.equal(written.tmdbId, '11');
assert.equal(written.ownerIdentity.basis, 'это тот фильм');
assert.equal(written.ownerIdentity.requestId, assign.issued.body.confirmation.idempotencyKey);
assert.equal((await json(MAP))[OTHER].status, 'no_confident_match');
assert.notEqual(JSON.stringify(await json(MAP)), beforeMap);
assert.equal(tmdbCalls, 0, 'the correction calls no one');
const again = await view();
assert.equal(again.body.indexed, false, 'a verified observation leaves the unresolved index');
assert.equal(again.body.identity.reason, 'target_absent');
const replay = await post('identity-correct', {confirmation: assign.issued.body.confirmation});
assert.equal(replay.body.replayed, true);
assert.equal(replay.body.receipt.state, 'succeeded');

await seed();
const rejectedIssue = await confirm('reject', '11', 'не тот фильм');
assert.equal(rejectedIssue.issued.status, 200, JSON.stringify(rejectedIssue.issued.body));
const rejectedRun = await post('identity-correct', {confirmation: rejectedIssue.issued.body.confirmation});
assert.equal(rejectedRun.body.state, 'succeeded', JSON.stringify(rejectedRun.body));
assert.equal(rejectedRun.body.application.shows, 'not_this_action');
const blocked = (await json(MAP))[KEY];
assert.deepEqual(blocked.rejectedTmdbIds, ['11']);
assert.notEqual(blocked.status, 'verified');
assert.equal(blocked.evidenceKey, (await json(MAP))[KEY].evidenceKey);
const second = await confirm('reject', '11', 'ещё раз');
assert.equal(second.issued.body.reason, 'already_current');
assert.equal(second.issued.status, 409);
assert.equal(JSON.stringify((await json(MAP))[KEY].rejectedTmdbIds), JSON.stringify(['11']));

await seed();
assert.equal((await confirm('assign', '11', 'это тот', {body: {tmdbId: '99'}})).issued.body.reason, 'film_absent');
assert.equal((await confirm('reject', '99', 'не тот')).issued.body.reason, 'not_on_decision');
assert.equal((await confirm('assign', '11', '   ')).issued.body.reason, 'basis_required');
await put(CATALOG, {tmdb_11: canonical({year: 1980})});
assert.equal((await confirm('assign')).issued.body.reason, 'year_conflict');
await put(CATALOG, {tmdb_11: canonical({canonicalIdentity: 'tmdb_tv:11'})});
assert.equal((await confirm('assign')).issued.body.reason, 'tmdb_tv');
await put(CATALOG, {tmdb_11: canonical({conflictingTmdbIds: ['11', '12']})});
assert.equal((await confirm('assign')).issued.body.reason, 'conflicting_identity');
assert.equal((await json(MAP))[KEY].status, 'needs_verification');
assert.equal((await post('identity-confirm', {key: KEY, pin: (await view()).body.pin, idempotencyKey: idem(), accepted: true, effect: 'assign', tmdbId: '11', basis: 'это тот'}, 'discovery_reconsider')).status, 403);

await seed({}, {partial: true});
assert.equal((await view()).body.identity.reason, 'index_incomplete');
assert.equal((await confirm('assign')).issued.body.reason, 'index_incomplete');
await seed({}, {authority: 'd1'});
assert.equal((await view()).body.identity.reason, 'unknown_authority');
await seed();
const issued = await confirm('assign');
await put(MAP, {...await json(MAP), [KEY]: {...(await json(MAP))[KEY], attempts: 9}});
const stale = await post('identity-correct', {confirmation: issued.issued.body.confirmation});
assert.ok(['stale_pin', 'record_changed', 'eligibility_changed'].includes(stale.body.receipt?.refusal || stale.body.refusal), JSON.stringify(stale.body));
assert.equal((await json(MAP))[KEY].attempts, 9);
assert.notEqual((await json(MAP))[KEY].identitySource, 'owner');

await seed();
const leased = await confirm('assign');
await put('epg/resolver-lease.json', {id: 'chunk-hop', expiresAt: clock + 60000});
const held = await post('identity-correct', {confirmation: leased.issued.body.confirmation});
assert.equal(held.body.refusal, 'lease_held');
assert.equal((await json(MAP))[KEY].status, 'needs_verification');

await seed();
const racing = await confirm('assign');
hooks.beforePut = async (key, value, options) => {
  if (key === MAP && options.onlyIf?.etagMatches) {hooks.beforePut = null; await memory.put(MAP, JSON.stringify({...(await json(MAP)), extra: {status: 'verified', tmdbId: '8'}}));}
};
const lost = await post('identity-correct', {confirmation: racing.issued.body.confirmation});
assert.equal(lost.body.state, 'failed');
assert.equal((await json(MAP)).extra.tmdbId, '8');
assert.notEqual((await json(MAP))[KEY].identitySource, 'owner');

await seed();
const unknown = await confirm('assign');
hooks.afterGet = (key, object) => key === MAP && log.puts.includes(MAP) ? null : object;
const unclear = await post('identity-correct', {confirmation: unknown.issued.body.confirmation});
assert.equal(unclear.body.state, 'unknown');
hooks.afterGet = null;
const landed = (await json(MAP))[KEY];
assert.equal(landed.identitySource, 'owner', 'the put landed; the receipt does not claim failure');
const blind = await post('identity-correct', {confirmation: unknown.issued.body.confirmation});
assert.equal(blind.body.replayed, true);
assert.equal(blind.body.receipt.state, 'unknown');
assert.equal((await json(MAP))[KEY].identitySource, 'owner');

// The next ordinary chunk keeps an owner rejection and does not call TMDB for that id, and keeps an owner assignment.
await seed();
const marked = await confirm('reject', '11', 'не тот фильм');
assert.equal((await post('identity-correct', {confirmation: marked.issued.body.confirmation})).body.state, 'succeeded');
context.report = {runId: RUN, films: []};
await put('programme.json', context.report);
await put('epg/published-generation.json', {phase: 'published', programmeRunId: RUN});
const waiting = await json(MAP);
waiting[OTHER] = {...waiting[OTHER], retryAt: iso(48 * H), evidenceKey: evidenceOf(candidate(OTHER, {title: 'Громкий берег'}))};
await put(MAP, waiting);
tmdbCalls = 0;
await vm.runInContext('resolveDiscoveryBatch(env,report,4)', context);
const afterChunk = (await json(MAP))[KEY];
assert.equal(tmdbCalls, 0, 'a rejected accepted id is not looked up');
assert.deepEqual(afterChunk.rejectedTmdbIds, ['11']);
assert.equal(afterChunk.ownerIdentity.effect, 'reject');
assert.notEqual(afterChunk.status, 'verified');
assert.notEqual(afterChunk.identitySource, 'known_epg_alias');

await seed({status: 'verified', tmdbId: '11', filmId: 'tmdb_11', identitySource: 'owner', canonicalIdentity: 'tmdb:11', ownerIdentity: {effect: 'assign', tmdbId: '11', basis: 'это тот', at: iso(-H), requestId: 'req-owner', programmeRunId: RUN}, scoring: {acceptedTmdbId: '11'}});
await put(CATALOG, {tmdb_11: canonical({shows: []})});
const parked = await json(MAP);
parked[OTHER] = {...parked[OTHER], retryAt: iso(48 * H), evidenceKey: evidenceOf(candidate(OTHER, {title: 'Громкий берег'}))};
await put(MAP, parked);
context.__decisions = await json(MAP);
await vm.runInContext('saveObservationIndex(env,__source,__decisions,async()=>true,{kind:"resolver_chunk"})', context);
context.report = {runId: RUN, films: []};
await put('programme.json', context.report);
tmdbCalls = 0;
await vm.runInContext('resolveDiscoveryBatch(env,report,4)', context);
const kept = (await json(MAP))[KEY];
assert.equal(kept.identitySource, 'owner');
assert.equal(kept.tmdbId, '11');
assert.ok(((await json(CATALOG)).tmdb_11.shows || []).length > 0, 'the cheap pass updates shows of the owner-verified film');
assert.equal(tmdbCalls, 0);

console.log('Discovery identity review: trusted id, explicit reject, title-only, year and television conflicts, stale and partial index, lease, CAS, unknown read-back, chunk stickiness passed');
