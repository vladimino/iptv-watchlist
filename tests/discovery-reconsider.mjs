// The guarded owner action `discovery_reconsider@1` over the real Worker routes and an R2 stand-in with etags and
// conditional writes. GET reads the observation from the generation's index and nothing else, writes nothing and calls
// no one; the confirmation binds one exact observation in one exact state; the execution lifts only that observation's
// terminal fence under the resolver lease, an etag compare-and-swap and the decision's digest, stores the intent and the
// receipt, and never claims an outcome it cannot read back. The next ordinary resolver chunk then looks the title up once.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto, createHash} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import * as DI from '../src/domain/discovery-observation-index.js';

const adapter = fs.readFileSync('src/admin/discovery-recovery.js', 'utf8');
assert.doesNotMatch(adapter, /\bfetch\(|themoviedb|tmdbRequest|resolveDiscovery|advanceDiscovery|queueDiscovery|waitUntil|\.list\(|\.delete\(|DiscoveryContinuation|saveJSON/, 'the adapter calls no one, starts nothing, lists and deletes nothing');
assert.match(adapter, /const \{bucket,versions\}=drReadOnly\(env\.BUCKET\);\n let observed;\n try\{observed=await drObserve/, 'the GET route reads through the get/head-only bucket');
const worker = fs.readFileSync('src/worker.js', 'utf8');
assert.match(worker, /if\(url\.pathname==='\/api\/admin\/discovery-recovery'\)return await adminDiscoveryRecoveryRoute\(request,env,url\);/);
assert.match(worker, /if\(url\.pathname\.startsWith\('\/api\/admin\/discovery-recovery\/'\)\)return await adminDiscoveryReconsiderRoute\(request,env,url\);/);

const sha = text => createHash('sha256').update(text).digest('hex');
const memory = new MemoryBucket();
const log = {puts: [], gets: [], heads: [], lists: 0, deletes: 0};
const hooks = {beforePut: null, putError: null, afterGet: null};
const bucket = {
  async get(key) {log.gets.push(key); const object = await memory.get(key); return hooks.afterGet ? hooks.afterGet(key, object) : object;},
  async head(key) {log.heads.push(key); return memory.head(key);},
  async put(key, body, options = {}) {
    if (hooks.beforePut) await hooks.beforePut(key, body, options);
    if (hooks.putError && hooks.putError(key, body)) throw new Error('r2 put failed');
    const saved = await memory.put(key, body, options);
    if (saved) log.puts.push(key);
    return saved;
  },
  async delete() {log.deletes++; throw new Error('nothing here deletes');},
  async list() {log.lists++; throw new Error('nothing here lists');},
};
let clock = Date.parse('2026-10-31T12:00:00.000Z'), tmdbCalls = 0;
const FrozenDate = class extends Date {constructor(...args) {super(...(args.length ? args : [clock]));} static now() {return clock;}};
const context = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date: FrozenDate, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, atob, btoa, crypto: webcrypto, console: {log() {}, error() {}, warn() {}}, setTimeout, structuredClone, encodeURIComponent, decodeURIComponent,
  ASSETS: {}, INITIAL_PERSONAL_RATINGS: {}, FILM_TITLE_DICTIONARY: [], PERSON_NAME_DICTIONARY: [],
  fetch: async url => {tmdbCalls++; return new Response(JSON.stringify(String(url).includes('/search/') ? {total_pages: 1, results: []} : {}));}});
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

const ORIGIN = 'https://iptv.example', RUN = '11111111-1111-4111-8111-111111111111', RUN2 = '22222222-2222-4222-8222-222222222222';
const H = 3600000, D = 86400000;
const MAP = 'epg/discovery-resolution.json', STATUS = 'epg/discovery-status.json', CONT = 'epg/resolver-continuation.json', LEASE = 'epg/resolver-lease.json', POINTER = 'epg/published-generation.json';
const LEDGER = run => 'epg/generations/' + run + '/discovery-latest.json';
const TARGET = 'тихий берег|2001', OTHER = 'громкий берег|2002', AMBIG = 'двойник|2003', BACKOFF = 'терпеливый|2004';
const iso = ms => new Date(clock + ms).toISOString();
const show = (start, channelId = 'c1') => ({channelId, channel: 'Первый', start, end: start + 2 * H});
const candidate = (key, extra = {}) => ({key, title: key.split('|')[0][0].toUpperCase() + key.split('|')[0].slice(1), normalizedTitle: key.split('|')[0], year: Number(key.split('|')[1]), duration: 95, durations: [95], shows: [show(clock + 3 * H)], seenInLatestSnapshot: true, lastSeenAt: clock - H, lastAiring: clock + 3 * H, firstAiring: clock + 3 * H, airings: 1, ...extra});
const evidenceOf = item => vm.runInContext('candidateEvidence(__c)', Object.assign(context, {__c: item}));
const json = async key => {const object = await memory.get(key); return object ? JSON.parse(await object.text()) : null;};
const put = (key, value) => memory.put(key, JSON.stringify(value));
const etag = async key => (await memory.head(key))?.etag ?? null;

function decisionsFor(items) {
  const [target, other, ambig, backoff] = items;
  return {
    [TARGET]: {status: 'no_confident_match', attempts: 5, evidenceKey: evidenceOf(target), lastAttemptAt: iso(-3 * D), checkedAt: iso(-3 * D), retryAt: null, terminalReason: 'repeated_uncertain_match'},
    [OTHER]: {status: 'no_confident_match', attempts: 5, evidenceKey: evidenceOf(other), lastAttemptAt: iso(-2 * D), checkedAt: iso(-2 * D), retryAt: null, terminalReason: 'repeated_uncertain_match'},
    [AMBIG]: {status: 'ambiguous', attempts: 5, evidenceKey: evidenceOf(ambig), lastAttemptAt: iso(-D), checkedAt: iso(-D), retryAt: null, terminalReason: 'repeated_uncertain_match'},
    [BACKOFF]: {status: 'no_confident_match', attempts: 2, evidenceKey: evidenceOf(backoff), lastAttemptAt: iso(-H), checkedAt: iso(-H), retryAt: iso(D), terminalReason: null},
    'известный|1999': {status: 'verified', tmdbId: '77'},
  };
}
// The published generation, its ledger, the decision map, a quiet series, and the index the real writer derives from them.
async function seed({lease = null, status = {stage: 'complete', at: iso(-H), programmeRunId: RUN}} = {}) {
  memory.objects.clear();
  hooks.beforePut = hooks.putError = hooks.afterGet = null;
  const items = [candidate(TARGET), candidate(OTHER), candidate(AMBIG), candidate(BACKOFF), candidate('известный|1999')];
  await put(POINTER, {phase: 'published', programmeRunId: RUN, publishedAt: iso(-5 * H)});
  await put(LEDGER(RUN), {programmeRunId: RUN, items});
  await put(MAP, decisionsFor(items));
  await put(CONT, {stage: 'paused', reason: null, remainingChunks: 6, programmeRunId: RUN, at: iso(-H)});
  await put(STATUS, status);
  if (lease) await put(LEASE, lease);
  context.__source = {programmeRunId: RUN, items};
  context.__decisions = decisionsFor(items);
  const written = await vm.runInContext('saveObservationIndex(env,__source,__decisions,async()=>true,{kind:"resolver_chunk",hopId:"hop-seed"})', context);
  assert.equal(written.written, true, 'the seed index is written by the real writer');
  log.puts = []; log.gets = []; log.heads = []; tmdbCalls = 0;
}
const snapshot = async () => {const out = {}; for (const [key, value] of memory.objects) out[key] = value.text; return out;};
const changedKeys = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key]).sort();

const request = (path, init) => context.worker.fetch(new Request(ORIGIN + path, init), env, {waitUntil() {throw new Error('no background work');}});
const get = async path => {const response = await request(path); return {status: response.status, body: await response.json()};};
const ownerHeaders = (extra = {}) => ({'Cf-Access-Jwt-Assertion': 'header.payload.signature', Origin: ORIGIN, 'X-IPTV-Admin-Action': 'discovery_reconsider', 'Content-Type': 'application/json', ...extra});
const post = async (action, body, headers = ownerHeaders()) => {const response = await request('/api/admin/discovery-recovery/' + action, {method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body)}); return {status: response.status, body: await response.json()};};
const view = key => get('/api/admin/discovery-recovery?key=' + encodeURIComponent(key));
let keyCounter = 0;
const idem = () => 'idem-' + String(++keyCounter).padStart(16, '0');
const confirm = async (key, extra = {}) => {const answer = await view(key); return post('confirm', {key, pin: answer.body.pin, idempotencyKey: idem(), accepted: true, ...extra});};
const actionKey = key => 'admin/actions/discovery_reconsider/v1/' + key + '.json';

// 1. GET: the eligible terminal observation, explained from the index alone; no write, no call, no list, no map or ledger body.
await seed();
let before = await snapshot();
let r = await view(TARGET);
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.indexed, true);
assert.equal(r.body.observation.title, 'Тихий берег');
assert.equal(r.body.assessment.verdict, 'no_more_evidence');
assert.equal(r.body.assessment.reason, 'repeated_uncertain_match');
assert.deepEqual(r.body.assessment.execute, {available: true, capability: 'discovery_reconsider', version: 1, reason: 'eligible', effect: {when: 'next_ordinary_chunk', at: null}}, 'a paused series with chunks left takes it with its next step');
assert.equal(r.body.action.status, 'eligible');
assert.deepEqual(r.body.action.cost, {tmdbCalls: 0, chunksStarted: 0, writes: {resolutionMap: 1, actionRecord: 3, observationIndex: 2}});
assert.equal(r.body.action.confirmTtlMs, 600000);
assert.equal(r.body.action.compensation.kind, 'manual');
assert.equal(r.body.index.state, 'fresh');
assert.match(r.body.pin, /^D1\.[0-9a-f]{32}$/);
assert.deepEqual(changedKeys(before, await snapshot()), [], 'GET writes nothing');
assert.deepEqual(log.puts, []);
assert.equal(tmdbCalls, 0);
assert.equal(log.lists + log.deletes, 0);
assert.ok(!log.gets.includes(MAP) && !log.gets.includes(LEDGER(RUN)), 'neither the map nor the ledger body is read');
assert.deepEqual([...new Set(log.gets)].sort(), [CONT, STATUS, LEASE, POINTER, DI.observationIndexManifestKey(RUN), DI.observationIndexShardKey(RUN, DI.observationShard(TARGET))].sort(), 'one shard: the one that can hold the key');
assert.deepEqual(log.heads.sort(), [LEDGER(RUN), MAP].sort());
assert.deepEqual(r.body.sources, [...new Set([...log.gets, ...log.heads])].filter(key => key !== LEASE).sort((a, b) => a.localeCompare(b, 'en')), 'the pin covers every read but the lease');
// Exact key: a neighbour's state is never reported for the target, and an unknown key is not invented.
const otherView = await view(OTHER);
assert.equal(otherView.body.target.key, OTHER);
assert.notEqual(otherView.body.observation.decisionHash, r.body.observation.decisionHash);
r = await view('нет такого|1900');
assert.equal(r.status, 200);
assert.equal(r.body.indexed, false);
assert.equal(r.body.assessment, null);
assert.notEqual(r.body.action.status, 'eligible');
for (const bad of ['', 'a'.repeat(201), 'bad\u0001key']) assert.equal((await get('/api/admin/discovery-recovery?key=' + encodeURIComponent(bad))).body.error, 'invalid_key');
assert.equal((await get('/api/admin/discovery-recovery')).status, 400);
assert.equal((await get('/api/admin/discovery-recovery?key=a&pin=nope')).body.error, 'invalid_pin');
const pin = (await view(TARGET)).body.pin;
assert.equal((await view(TARGET)).body.pin, pin, 'the same state gives the same pin');
r = await get('/api/admin/discovery-recovery?key=' + encodeURIComponent(TARGET) + '&pin=D1.' + '0'.repeat(32));
assert.equal(r.status, 409);
assert.deepEqual(r.body, {error: 'stale_pin', pin});
assert.equal((await request('/api/admin/discovery-recovery?key=a', {method: 'POST'})).status, 405);

// Every refusal the gate can give, read-only.
for (const [key, reason] of [[AMBIG, 'identity_ambiguous'], [BACKOFF, 'backoff_is_policy']]) {
  r = await view(key);
  assert.equal(r.body.assessment.execute.reason, reason, key);
  assert.notEqual(r.body.action.status, 'eligible');
  assert.equal((await post('confirm', {key, pin: r.body.pin, idempotencyKey: idem(), accepted: true})).body.refusal, 'not_eligible');
}
await seed({lease: {id: 'other-hop', expiresAt: clock + 60000}});
assert.equal((await view(TARGET)).body.assessment.execute.reason, 'writer_active', 'a live lease');
await seed({lease: {id: 'other-hop'}});
assert.equal((await view(TARGET)).body.assessment.execute.reason, 'series_unknown', 'a broken lease');
await seed({status: {stage: 'partial', error: 'TMDB HTTP 429', retryAt: iso(20 * 60000), programmeRunId: RUN}});
assert.equal((await view(TARGET)).body.assessment.execute.reason, 'tmdb_throttled');
// The index is not current: the map moved since it was written.
await seed();
await put(MAP, {...await json(MAP), 'посторонний|1990': {status: 'verified', tmdbId: '5'}});
r = await view(TARGET);
assert.equal(r.body.index.state, 'stale');
assert.deepEqual(r.body.index.reasons, ['resolution_changed']);
assert.equal(r.body.assessment.execute.reason, 'index_not_current');
assert.equal(r.body.action.status === 'eligible', false);
// No index for the published generation: unavailable, never "nothing wrong".
await seed();
await put(POINTER, {phase: 'published', programmeRunId: RUN2});
r = await view(TARGET);
assert.equal(r.body.indexed, false);
assert.equal(r.body.index.state, 'missing');
assert.equal(r.body.assessment, null);

// 2. Confirmation: Access, same origin, the action header and JSON, or nothing happens.
await seed();
before = await snapshot();
const answer = await view(TARGET);
const body = {key: TARGET, pin: answer.body.pin, idempotencyKey: idem(), accepted: true};
for (const headers of [ownerHeaders({'Cf-Access-Jwt-Assertion': ''}), ownerHeaders({Origin: 'https://evil.example'}), ownerHeaders({'X-IPTV-Admin-Action': 'other'}), ownerHeaders({'Content-Type': 'text/plain'}), {Origin: ORIGIN, 'Content-Type': 'application/json'}]) {
  r = await post('confirm', body, headers);
  assert.equal(r.status, 403, JSON.stringify(headers));
  assert.ok(r.body.refusal === 'access_denied' || r.body.error === 'Origin not allowed', JSON.stringify(r.body));
}
assert.equal((await request('/api/admin/discovery-recovery/confirm')).status, 405);
assert.equal((await request('/api/admin/discovery-recovery/anything', {method: 'POST', headers: ownerHeaders(), body: '{}'})).status, 404);
assert.equal((await post('confirm', 'not json')).body.refusal, 'invalid_request');
assert.equal((await post('confirm', JSON.stringify({...body, padding: 'x'.repeat(17000)}))).body.refusal, 'invalid_request');
assert.equal((await post('confirm', {...body, idempotencyKey: 'short'})).body.refusal, 'invalid_request');
assert.equal((await post('confirm', {...body, accepted: false})).body.refusal, 'confirmation_missing');
assert.equal((await post('confirm', {...body, pin: 'D1.' + '0'.repeat(32)})).body.refusal, 'stale_pin');
assert.deepEqual(changedKeys(before, await snapshot()), [], 'a refused confirmation writes nothing');
r = await post('confirm', body);
assert.equal(r.status, 200, JSON.stringify(r.body));
const confirmation = r.body.confirmation;
assert.deepEqual(confirmation.ids, [TARGET]);
assert.equal(confirmation.capability, 'discovery_reconsider');
assert.equal(Date.parse(confirmation.expiresAt) - Date.parse(confirmation.confirmedAt), 600000);
assert.deepEqual(changedKeys(before, await snapshot()), [actionKey(body.idempotencyKey)], 'confirming stores the issued confirmation and nothing else');
let record = await json(actionKey(body.idempotencyKey));
assert.equal(record.state, 'approved');
assert.deepEqual(record.provenance, {actor: 'owner', authority: 'cloudflare_access', programmeRunId: RUN, manifestEtag: await etag(DI.observationIndexManifestKey(RUN)), observationKey: TARGET});
assert.ok(!JSON.stringify(record).includes('header.payload.signature'), 'the Access assertion is never stored');
assert.equal((await post('confirm', body)).body.refusal, 'idempotency_conflict', 'a key is issued once');
assert.equal(tmdbCalls, 0);

// 3. Execution: access first, then the stored confirmation; a forged or unknown one does nothing.
assert.equal((await post('reconsider', {confirmation}, ownerHeaders({Origin: 'https://evil.example'}))).status, 403, 'the Worker refuses a cross-origin POST before routing');
assert.equal((await post('reconsider', {confirmation}, ownerHeaders({'Cf-Access-Jwt-Assertion': ''}))).body.refusal, 'access_denied');
assert.equal((await post('reconsider', {confirmation: {...confirmation, extra: 1}})).body.refusal, 'invalid_request');
assert.equal((await post('reconsider', {confirmation: {...confirmation, scopeFingerprint: '00000000'}})).body.refusal, 'invalid_request', 'a scope that does not match its fingerprint');
assert.equal((await post('reconsider', {confirmation: {...confirmation, idempotencyKey: 'never-issued-0000001'}})).body.refusal, 'confirmation_missing', 'a key that was never issued');
assert.equal((await post('reconsider', {confirmation: {...confirmation, expiresAt: iso(D)}})).body.refusal, 'confirmation_mismatch', 'the issued expiry is the one enforced');
assert.deepEqual(changedKeys(before, await snapshot()), [actionKey(body.idempotencyKey)].concat([LEASE]).sort(), 'the mismatch was refused under the lease, which is released');
record = await json(actionKey(body.idempotencyKey));
assert.equal(record.state, 'refused', 'a refused submission under the lease consumes the key with its receipt');
assert.equal(record.receipt.refusal, 'confirmation_mismatch');
assert.equal((await post('reconsider', {confirmation})).body.replayed, true, 'and the key is not reusable');

// 4. Success: only the target decision changes, its fence is lifted and nothing else; the intent, the receipt, the before
// and after images are durable; the index is refreshed; the lease is released; nobody was called.
await seed();
before = await snapshot();
const mapBefore = await json(MAP);
let issued = await confirm(TARGET);
assert.equal(issued.status, 200);
const actionPuts = [];
hooks.beforePut = async (key, value) => {if (key.startsWith('admin/actions/')) actionPuts.push(JSON.parse(value).state);};
r = await post('reconsider', {confirmation: issued.body.confirmation});
hooks.beforePut = null;
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.state, 'succeeded');
assert.equal(r.body.durable, true);
assert.equal(r.body.replayed, false);
assert.deepEqual(r.body.receipt.outcomes, [{id: TARGET, outcome: 'written'}]);
assert.deepEqual(r.body.index, {refreshed: true, reason: null});
assert.deepEqual(actionPuts, ['running', 'succeeded'], 'the intent is stored before the write, the receipt after');
const mapAfter = await json(MAP);
for (const key of Object.keys(mapBefore)) if (key !== TARGET) assert.deepEqual(mapAfter[key], mapBefore[key], key + ' is untouched');
assert.deepEqual(Object.keys(mapAfter).sort(), Object.keys(mapBefore).sort());
const lifted = mapAfter[TARGET];
assert.deepEqual({...lifted, reconsidered: undefined}, {...mapBefore[TARGET], terminalReason: null, retryAt: null, reconsidered: undefined});
assert.equal(lifted.attempts, 5, 'attempt history is kept');
assert.deepEqual(lifted.reconsidered, {at: lifted.reconsidered.at, idempotencyKey: issued.body.confirmation.idempotencyKey, capability: 'discovery_reconsider@1', previousTerminalReason: 'repeated_uncertain_match', previousRetryAt: null, attemptsAtReconsider: 5});
record = await json(actionKey(issued.body.confirmation.idempotencyKey));
assert.equal(record.state, 'succeeded');
assert.deepEqual(record.beforeImage.decision, mapBefore[TARGET]);
assert.equal(record.beforeImage.decisionHash, sha(DI.canonicalJson(mapBefore[TARGET])));
assert.deepEqual(record.afterImage.decision, lifted);
assert.equal(record.afterImage.resolutionEtag, await etag(MAP));
assert.equal(record.receipt.state, 'succeeded');
assert.deepEqual(changedKeys(before, await snapshot()), [actionKey(issued.body.confirmation.idempotencyKey), MAP, DI.observationIndexManifestKey(RUN), DI.observationIndexShardKey(RUN, DI.observationShard(TARGET)), LEASE].sort(), 'the map, the action record, the index and the lease; the ledger, status, continuation and every other object untouched');
assert.equal((await json(LEASE)).expiresAt, 0, 'the lease is released');
assert.equal(tmdbCalls, 0, 'the action calls no one');
// The refreshed index is current and says the observation is back in the ordinary queue.
r = await view(TARGET);
assert.equal(r.body.index.state, 'fresh');
assert.equal(r.body.index.writer, 'discovery_reconsider');
assert.equal(r.body.assessment.verdict, 'queued');
assert.equal(r.body.assessment.execute.reason, 'already_eligible');
assert.equal(r.body.observation.decision.reconsidered.previousTerminalReason, 'repeated_uncertain_match');
assert.equal((await view(OTHER)).body.assessment.execute.available, true, 'the neighbour is still terminal and still eligible');
// Replay: the same confirmation returns the stored receipt and writes nothing.
const afterSuccess = await snapshot();
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.body.replayed, true);
assert.equal(r.body.receipt.state, 'succeeded');
assert.deepEqual(changedKeys(afterSuccess, await snapshot()), []);
r = await get('/api/admin/discovery-recovery/receipt?idempotencyKey=' + issued.body.confirmation.idempotencyKey);
assert.equal(r.body.state, 'succeeded');
assert.deepEqual(changedKeys(afterSuccess, await snapshot()), [], 'reading a receipt writes nothing');
assert.equal((await get('/api/admin/discovery-recovery/receipt?idempotencyKey=bad')).status, 400);
assert.equal((await get('/api/admin/discovery-recovery/receipt?idempotencyKey=missing-0000000000001')).status, 404);
// The next ordinary chunk looks the title up once; the same uncertain answer makes it terminal again at once.
context.report = {runId: RUN, updatedAt: iso(-5 * H), films: []};
await put('programme.json', context.report);
await vm.runInContext('resolveDiscoveryBatch(env,report,1)', context);
const next = (await json(MAP))[TARGET];
assert.ok(tmdbCalls > 0, 'the ordinary chunk, not the action, called TMDB');
assert.equal(next.attempts, 6);
assert.equal(next.terminalReason, 'repeated_uncertain_match');
assert.equal((await json(MAP))[OTHER].terminalReason, 'repeated_uncertain_match', 'the neighbour was not looked up');

// 5. Two submissions of one confirmation at once: one write.
await seed();
issued = await confirm(TARGET);
const mapWrites = () => log.puts.filter(key => key === MAP).length;
log.puts = [];
const both = await Promise.all([post('reconsider', {confirmation: issued.body.confirmation}), post('reconsider', {confirmation: issued.body.confirmation})]);
assert.equal(mapWrites(), 1, 'exactly one map write');
assert.ok(both.some(item => item.body.state === 'succeeded'));
assert.ok(both.every(item => item.body.state === 'succeeded' || ['lease_held', 'in_progress'].includes(item.body.refusal) || item.body.replayed === true), JSON.stringify(both.map(item => item.body)));

// 6. A writer outside the lease changes the map between the read and the write: the compare-and-swap refuses, nothing of
// the other writer is lost, and the receipt says the record was not written.
await seed();
issued = await confirm(TARGET);
hooks.beforePut = async (key, value, options) => {
  if (key === MAP && options.onlyIf?.etagMatches) {
    hooks.beforePut = null;
    await memory.put(MAP, JSON.stringify({...await json(MAP), 'чужой|1980': {status: 'verified', tmdbId: '9'}}));
  }
};
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.body.state, 'failed');
assert.deepEqual(r.body.receipt.outcomes, [{id: TARGET, outcome: 'skipped_changed', error: 'conflict'}]);
assert.equal((await json(MAP))['чужой|1980'].tmdbId, '9', 'the other writer is kept');
assert.equal((await json(MAP))[TARGET].terminalReason, 'repeated_uncertain_match');
assert.equal((await json(actionKey(issued.body.confirmation.idempotencyKey))).state, 'failed');
// The map moved after the confirmation and before the execution: the index is no longer current, so nothing is written.
await seed();
issued = await confirm(TARGET);
await put(MAP, {...await json(MAP), 'чужой|1980': {status: 'verified', tmdbId: '9'}});
before = await snapshot();
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.status, 409);
assert.equal(r.body.state, 'refused');
assert.ok(['stale_pin', 'eligibility_changed', 'record_changed'].includes(r.body.receipt.refusal), r.body.receipt.refusal);
assert.deepEqual(changedKeys(before, await snapshot()), [actionKey(issued.body.confirmation.idempotencyKey), LEASE].sort());
// The decision itself changed but the index still names the old etag (a stale index): its digest refuses.
await seed();
issued = await confirm(TARGET);
const stale = await json(MAP);
stale[TARGET] = {...stale[TARGET], checkedAt: iso(-H)};
const etagBefore = await etag(MAP);
hooks.afterGet = (key, object) => key === MAP && object ? {...object, etag: etagBefore, json: async () => stale, text: async () => JSON.stringify(stale)} : object;
r = await post('reconsider', {confirmation: issued.body.confirmation});
hooks.afterGet = null;
assert.equal(r.body.receipt.refusal, 'record_changed');
assert.equal((await json(MAP))[TARGET].terminalReason, 'repeated_uncertain_match');

// 7. An interrupted write: the put fails in flight. The outcome is unknown, said so, and never retried.
await seed();
issued = await confirm(TARGET);
hooks.putError = key => key === MAP;
r = await post('reconsider', {confirmation: issued.body.confirmation});
hooks.putError = null;
assert.equal(r.body.state, 'unknown');
assert.deepEqual(r.body.receipt.retry.retryable, []);
assert.equal((await json(actionKey(issued.body.confirmation.idempotencyKey))).state, 'unknown');
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.body.replayed, true);
assert.equal(r.body.receipt.state, 'unknown');
// A write that lands but cannot be read back as written: unknown, not success.
await seed();
issued = await confirm(TARGET);
let afterWrite = false;
hooks.beforePut = async key => {if (key === MAP) afterWrite = true;};
hooks.afterGet = (key, object) => key === MAP && afterWrite && object ? {...object, json: async () => ({}), text: async () => '{}'} : object;
r = await post('reconsider', {confirmation: issued.body.confirmation});
hooks.beforePut = hooks.afterGet = null;
assert.equal(r.body.state, 'unknown');
// An intent stored without a receipt (the Worker stopped after it): unknown, refused, nothing redone.
await seed();
issued = await confirm(TARGET);
const stuckKey = actionKey(issued.body.confirmation.idempotencyKey);
await put(stuckKey, {...await json(stuckKey), state: 'running', startedAt: iso(-60000)});
before = await snapshot();
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.status, 409);
assert.equal(r.body.refusal, 'in_progress');
assert.equal(r.body.state, 'unknown');
assert.deepEqual(changedKeys(before, await snapshot()), [], 'not even the lease is taken');
assert.equal((await get('/api/admin/discovery-recovery/receipt?idempotencyKey=' + issued.body.confirmation.idempotencyKey)).body.state, 'unknown');
// The receipt itself cannot be stored: the answer says so.
await seed();
issued = await confirm(TARGET);
hooks.putError = (key, value) => key.startsWith('admin/actions/') && JSON.parse(value).receipt;
r = await post('reconsider', {confirmation: issued.body.confirmation});
hooks.putError = null;
assert.equal(r.body.state, 'succeeded');
assert.equal(r.body.durable, false);

// 8. The lease: another writer holds it (nothing stored, the confirmation stays usable), its state is unreadable (not
// taken over), or it is lost between the intent and the write (aborted, nothing written).
await seed();
issued = await confirm(TARGET);
await put(LEASE, {id: 'chunk-hop', expiresAt: clock + 60000});
before = await snapshot();
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.body.refusal, 'lease_held');
assert.deepEqual(changedKeys(before, await snapshot()), []);
await put(LEASE, {id: 'chunk-hop'});
before = await snapshot();
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.body.refusal, 'lease_unknown');
assert.deepEqual(changedKeys(before, await snapshot()), [], 'an unreadable lease is not taken over');
await put(LEASE, {id: 'chunk-hop', expiresAt: clock - 1000});
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.body.state, 'succeeded', 'after the writer is gone the same confirmation works');
await seed();
issued = await confirm(TARGET);
hooks.beforePut = async (key, value) => {if (key.startsWith('admin/actions/') && JSON.parse(value).state === 'running') {hooks.beforePut = null; await memory.put(LEASE, JSON.stringify({id: 'thief', expiresAt: clock + 90000}));}};
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.body.state, 'aborted');
assert.deepEqual(r.body.receipt.outcomes, [{id: TARGET, outcome: 'not_attempted', error: 'fence_lost'}]);
assert.equal((await json(MAP))[TARGET].terminalReason, 'repeated_uncertain_match');
assert.equal((await json(LEASE)).id, 'thief', 'another holder\'s lease is never released');

// 9. Expiry and generation change between confirmation and execution.
await seed();
issued = await confirm(TARGET);
clock += 11 * 60000;
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.body.receipt.refusal, 'confirmation_expired');
clock -= 11 * 60000;
await seed();
issued = await confirm(TARGET);
await put(POINTER, {phase: 'published', programmeRunId: RUN2});
r = await post('reconsider', {confirmation: issued.body.confirmation});
assert.equal(r.body.state, 'refused');
assert.equal((await json(MAP))[TARGET].terminalReason, 'repeated_uncertain_match');

// 10. A storage failure on the routes is a 503, never a success.
await seed();
const broken = {...bucket, async get() {throw new Error('r2 down');}};
let response = await context.worker.fetch(new Request(ORIGIN + '/api/admin/discovery-recovery?key=' + encodeURIComponent(TARGET)), {BUCKET: broken}, {});
assert.equal(response.status, 503);
response = await context.worker.fetch(new Request(ORIGIN + '/api/admin/discovery-recovery/confirm', {method: 'POST', headers: ownerHeaders(), body: JSON.stringify({key: TARGET, pin: 'D1.' + '0'.repeat(32), idempotencyKey: idem(), accepted: true})}), {BUCKET: broken}, {});
assert.equal(response.status, 503);
assert.equal((await response.json()).refusal, 'storage_unavailable');
assert.equal(log.lists + log.deletes, 0, 'nothing listed or deleted anywhere');

console.log('Discovery reconsider: read-only GET, exact key, gate refusals, Access and confirmation, success with images and receipt, replay, concurrency, CAS race, interrupted and unknown outcomes, lease held, unreadable and lost, expiry, generation change passed');
