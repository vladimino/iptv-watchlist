// The generation-scoped observation index. The pure module: canonical digests, placement, records reproduced exactly or
// omitted, the item cap and its priority, manifest and shard validation (missing, malformed, other generation, torn) and
// freshness by source etags. The writer in src/discovery.js: only current, unscreened, undecided-or-unresolved candidates
// with a decision; the published generation only; digests of the full decision; unchanged shards not rewritten; a shard
// written without its manifest repaired; every write behind the fence; a lost lease rethrown, any other failure swallowed;
// and a full resolver chunk leaving a current index behind. Nothing lists the bucket.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto, createHash} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import * as DI from '../src/domain/discovery-observation-index.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const moduleSource = fs.readFileSync('src/domain/discovery-observation-index.js', 'utf8');
assert.doesNotMatch(moduleSource, /\bfetch\b|BUCKET|cloudflare:|node:|\bimport\b|\brequire\(|Date\.now|new Date\(|Math\.random|crypto/, 'the index module is pure');
const build = fs.readFileSync('build.mjs', 'utf8');
assert.ok(build.indexOf("scoped('src/domain/discovery-observation-index.js','DiscoveryIndex')") > 0 && build.indexOf("scoped('src/domain/discovery-observation-index.js','DiscoveryIndex')") < build.indexOf("fs.readFileSync('src/discovery.js','utf8')"), 'the index module is bundled, scoped, before the writer');

// 1. Canonical JSON and placement.
assert.equal(DI.canonicalJson({b: 1, a: [{d: 2, c: null}]}), '{"a":[{"c":null,"d":2}],"b":1}');
assert.equal(DI.canonicalJson({a: 1, b: 2}), DI.canonicalJson({b: 2, a: 1}));
for (const key of ['a', 'title|2020', 'очень длинное название|1999']) {
  const shard = DI.observationShard(key);
  assert.ok(Number.isInteger(shard) && shard >= 0 && shard < DI.OBSERVATION_INDEX_SHARDS);
  assert.equal(DI.observationShard(key), shard, 'placement is deterministic');
}
assert.equal(DI.observationIndexShardKey('run-1', 3), 'epg/generations/run-1/discovery-observations/shard-03.json');
assert.equal(DI.observationIndexManifestKey('run-1'), 'epg/generations/run-1/discovery-observations/manifest.json');
assert.equal(DI.observationKeyValid(''), false);
assert.equal(DI.observationKeyValid('a'.repeat(201)), false);
assert.equal(DI.observationKeyValid('bad\nkey'), false);
assert.equal(DI.observationKeyValid('ok|2020'), true);

// 2. Records: exact or omitted, never trimmed.
const show = (start, channelId = 'c1') => ({channelId, channel: 'Канал', start, end: start + 7200000});
const decision = (extra = {}) => ({status: 'no_confident_match', evidenceKey: 'ev-1', attempts: 2, lastAttemptAt: '2026-10-30T10:00:00.000Z', checkedAt: '2026-10-30T10:00:00.000Z', retryAt: '2026-10-31T10:00:00.000Z', ...extra});
const candidate = (key, extra = {}) => ({key, title: key.split('|')[0], normalizedTitle: key.split('|')[0].toLowerCase(), year: 2020, durations: [100], shows: [show(2000, 'b'), show(1000, 'a')], seenInLatestSnapshot: true, lastSeenAt: 3000, lastAiring: 2000, ...extra});
let shaped = DI.observationIndexRecord(candidate('Фильм|2020'), decision(), 'run-1');
assert.deepEqual(shaped.record.shows.map(item => item.start), [1000, 2000], 'shows sorted');
assert.equal(shaped.record.programmeRunId, 'run-1');
assert.deepEqual(Object.keys(shaped.record.decision).sort(), ['attempts', 'checkedAt', 'evidenceKey', 'identitySource', 'lastAttemptAt', 'ownerIdentity', 'reconsidered', 'rejectedTmdbIds', 'retryAt', 'scoring', 'status', 'terminalReason', 'tmdbId']);
assert.deepEqual(DI.observationIndexRecord(candidate('x|1', {shows: Array.from({length: 97}, (_, index) => show(index))}), decision(), 'run-1'), {omit: 'oversized'});
assert.deepEqual(DI.observationIndexRecord(candidate('x|1', {shows: [{channelId: 'a'}]}), decision(), 'run-1'), {omit: 'malformed'});
assert.deepEqual(DI.observationIndexRecord(candidate('x|1'), {attempts: 1}, 'run-1'), {omit: 'malformed'});
assert.deepEqual(DI.observationIndexRecord({key: ''}, decision(), 'run-1'), {omit: 'malformed'});
const marker = DI.observationDecisionView(decision({reconsidered: {at: '2026-10-30T11:00:00.000Z', idempotencyKey: 'k'.repeat(20), previousTerminalReason: 'repeated_uncertain_match', extra: 'dropped'}})).reconsidered;
assert.deepEqual(marker, {at: '2026-10-30T11:00:00.000Z', idempotencyKey: 'k'.repeat(20), previousTerminalReason: 'repeated_uncertain_match'});

// 3. The cap: terminal records first, then ambiguous, then the rest; the coverage names what was cut.
const many = [];
for (let index = 0; index < DI.OBSERVATION_INDEX_MAX_ITEMS + 40; index++) many.push({candidate: candidate('n' + String(index).padStart(5, '0') + '|2020'), decision: decision()});
many.push({candidate: candidate('zz-terminal|2020'), decision: decision({attempts: 5, terminalReason: 'repeated_uncertain_match', retryAt: null})});
many.push({candidate: candidate('zz-ambiguous|2020'), decision: decision({status: 'ambiguous'})});
many.push({candidate: candidate('zz-oversized|2020', {shows: Array.from({length: 97}, (_, index) => show(index))}), decision: decision()});
let built = DI.buildObservationIndex({programmeRunId: 'run-1', entries: many});
const kept = built.shards.flat();
assert.equal(kept.length, DI.OBSERVATION_INDEX_MAX_ITEMS);
assert.deepEqual(built.coverage, {scope: 'current_unresolved_with_decision', eligible: many.length, indexed: DI.OBSERVATION_INDEX_MAX_ITEMS, omitted: {cap: 42, oversized: 1, malformed: 0}, complete: false, maxItems: DI.OBSERVATION_INDEX_MAX_ITEMS});
assert.ok(kept.some(record => record.key === 'zz-terminal|2020') && kept.some(record => record.key === 'zz-ambiguous|2020'), 'the cap keeps terminal and ambiguous records');
for (const [index, shard] of built.shards.entries()) assert.ok(shard.every(record => DI.observationShard(record.key) === index));
assert.deepEqual(DI.buildObservationIndex({programmeRunId: '', entries: []}), {error: 'invalid_generation'});
built = DI.buildObservationIndex({programmeRunId: 'run-1', entries: [{candidate: candidate('a|1'), decision: decision()}, {candidate: candidate('a|1'), decision: decision()}]});
assert.equal(built.coverage.omitted.malformed, 1, 'a duplicate key is not indexed twice');

// 4. Manifest and shard validation.
const one = DI.buildObservationIndex({programmeRunId: 'run-1', entries: [{candidate: candidate('a|1'), decision: decision()}, {candidate: candidate('b|2'), decision: decision({status: 'ambiguous'})}]});
const shardDocs = one.shards.map((items, index) => {
  const withHash = items.map(record => ({...record, decisionHash: sha(DI.canonicalJson({record: record.key}))}));
  return DI.observationShardDocument('run-1', index, withHash, sha(DI.canonicalJson(withHash)));
});
const manifest = DI.observationIndexManifest({programmeRunId: 'run-1', writtenAt: '2026-10-30T12:00:00.000Z', writer: {kind: 'resolver_chunk', hopId: 'h'}, sources: {resolutionEtag: 'r1', ledgerEtag: 'l1'}, shards: shardDocs.map(doc => ({items: doc.items.length, revision: doc.revision})), coverage: one.coverage, counts: {awaitingFirstLookup: 0}});
assert.equal(DI.readObservationIndexManifest(null, 'run-1').state, 'missing');
assert.equal(DI.readObservationIndexManifest(manifest, 'run-1').state, 'readable');
assert.equal(DI.readObservationIndexManifest(manifest, 'run-2').state, 'other_generation');
for (const broken of [{...manifest, kind: 'x'}, {...manifest, schemaVersion: 2}, {...manifest, writer: {kind: 'someone'}}, {...manifest, sources: {resolutionEtag: 'r1'}}, {...manifest, shards: manifest.shards.slice(1)}, {...manifest, coverage: {...manifest.coverage, indexed: 3}}, {...manifest, writtenAt: 'never'}, {...manifest, shards: manifest.shards.map((entry, index) => index ? entry : {...entry, revision: 'short'})}]) {
  assert.equal(DI.readObservationIndexManifest(broken, 'run-1').state, 'malformed');
}
const shardOfA = DI.observationShard('a|1');
assert.deepEqual(DI.readObservationIndexShard(shardDocs[shardOfA], manifest, shardOfA).items.map(record => record.key), shardOfA === DI.observationShard('b|2') ? ['a|1', 'b|2'] : ['a|1']);
assert.equal(DI.readObservationIndexShard(null, manifest, shardOfA).state, 'torn', 'a missing shard that should hold records is torn');
const empty = manifest.shards.findIndex(entry => entry.items === 0);
assert.deepEqual(DI.readObservationIndexShard(null, manifest, empty), {ok: true, items: []});
assert.equal(DI.readObservationIndexShard({...shardDocs[shardOfA], revision: sha('other')}, manifest, shardOfA).state, 'torn');
assert.equal(DI.readObservationIndexShard({...shardDocs[shardOfA], items: shardDocs[shardOfA].items.map(record => ({...record, decisionHash: 'nope'}))}, manifest, shardOfA).state, 'malformed');
assert.equal(DI.readObservationIndexShard({...shardDocs[shardOfA], programmeRunId: 'run-2'}, manifest, shardOfA).state, 'malformed');
const misplaced = (shardOfA + 1) % 16;
assert.equal(DI.readObservationIndexShard({...shardDocs[shardOfA], shard: DI.observationShardName(misplaced)}, {...manifest, shards: manifest.shards.map((entry, index) => index === misplaced ? manifest.shards[shardOfA] : entry)}, misplaced).state, 'malformed', 'a record in the wrong shard');
assert.deepEqual(DI.observationIndexFreshness(manifest, {programmeRunId: 'run-1', resolutionEtag: 'r1', ledgerEtag: 'l1'}), {state: 'fresh', reasons: []});
assert.deepEqual(DI.observationIndexFreshness(manifest, {programmeRunId: 'run-1', resolutionEtag: 'r2', ledgerEtag: null}), {state: 'stale', reasons: ['resolution_changed', 'ledger_unread']});
assert.deepEqual(DI.observationIndexFreshness(manifest, {programmeRunId: 'run-2', resolutionEtag: 'r1', ledgerEtag: 'l2'}), {state: 'stale', reasons: ['generation_changed', 'ledger_changed']});

// 5. The writer, over the real discovery module.
const bucket = new MemoryBucket();
const log = {puts: [], heads: 0, lists: 0};
const store = {
  async get(key) {return bucket.get(key);},
  async head(key) {log.heads++; if (store.failHead) throw new Error('head failed'); return bucket.head(key);},
  async put(key, body, options) {log.puts.push(key); return bucket.put(key, body, options);},
  async delete(key) {return bucket.delete(key);},
  async list() {log.lists++; throw new Error('the index writer never lists');},
  failHead: false,
};
let tmdbCalls = 0;
const context = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, console: {log() {}, error() {}, warn() {}}, setTimeout, structuredClone,
  fetch: async url => {tmdbCalls++; return new Response(JSON.stringify(String(url).includes('/search/') ? {total_pages: 1, results: []} : {}));}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js', 'utf8'), context);
vm.runInContext(scoped('src/domain/discovery-observation-index.js', 'DiscoveryIndex'), context);
for (const file of ['src/domain/scored-resolution.js', 'src/domain/resolution-acceptance.js', 'src/sources.js', 'src/discovery.js', 'src/domain/profile-impact.js', 'src/domain/prediction-compatibility.js', 'src/domain/fingerprint-compatibility.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/worker.js']) vm.runInContext(fs.readFileSync(file, 'utf8').replace('export default', 'globalThis.worker='), context);
const env = {BUCKET: store, TMDB_API_READ_ACCESS_TOKEN: 'test', TMDB_REQUEST_INTERVAL_MS: 0};
context.env = env;
const RUN = 'run-1';
const now = Date.now(), H = 3600000, D = 86400000;
const put = (key, value) => bucket.put(key, JSON.stringify(value));
const ledgerKey = 'epg/generations/' + RUN + '/discovery-latest.json';
const live = (key, extra = {}) => candidate(key, {shows: [show(now + H)], lastAiring: now + H, lastSeenAt: now, ...extra});
const items = [
  live('Терминальный|2001'),
  live('Новый|2002'),
  live('Найден|2003'),
  live('Старый|2004', {shows: [show(now - 10 * D)], lastAiring: now - 10 * D, seenInLatestSnapshot: false}),
  live('TV series Example|2005', {title: 'TV series Example'}),
  live('Двойной|2006'),
];
const decisions = {
  'Терминальный|2001': decision({attempts: 5, terminalReason: 'repeated_uncertain_match', retryAt: null}),
  'Найден|2003': {status: 'verified', tmdbId: 7},
  'Старый|2004': decision(),
  'TV series Example|2005': decision(),
  'Двойной|2006': decision({status: 'ambiguous', retryAt: null}),
};
function seedWriter() {
  bucket.objects.clear();
  put('epg/published-generation.json', {phase: 'published', programmeRunId: RUN});
  put(ledgerKey, {programmeRunId: RUN, items});
  put('epg/discovery-resolution.json', decisions);
  log.puts = []; log.heads = 0;
}
const source = {programmeRunId: RUN, items};
const fence = async () => true;
context.args = {source, decisions, fence};
const save = (writer = {kind: 'resolver_chunk', hopId: 'hop-1'}) => {context.writer = writer; return vm.runInContext('saveObservationIndex(env,args.source,args.decisions,args.fence,writer)', context);};
const manifestKey = DI.observationIndexManifestKey(RUN);
const readManifest = async () => JSON.parse(await (await bucket.get(manifestKey)).text());

seedWriter();
let outcome = await save();
assert.deepEqual({...outcome}, {written: true, reason: null});
let stored = await readManifest();
assert.equal(DI.readObservationIndexManifest(stored, RUN).state, 'readable');
assert.equal(stored.writer.kind, 'resolver_chunk');
assert.equal(stored.writer.hopId, 'hop-1');
assert.equal(stored.coverage.indexed, 2);
assert.equal(stored.coverage.eligible, 2);
assert.equal(stored.counts.awaitingFirstLookup, 1, 'a current observation without a decision is counted, not indexed');
assert.equal(stored.sources.resolutionEtag, (await bucket.head('epg/discovery-resolution.json')).etag);
assert.equal(stored.sources.ledgerEtag, (await bucket.head(ledgerKey)).etag);
assert.equal(log.puts.at(-1), manifestKey, 'the manifest is written last');
const indexed = [];
for (let index = 0; index < 16; index++) {
  const object = await bucket.get(DI.observationIndexShardKey(RUN, index));
  assert.ok(object, 'every shard exists after the first write');
  const read = DI.readObservationIndexShard(await object.json(), stored, index);
  assert.ok(read.ok);
  assert.equal(object.customMetadata.revision, stored.shards[index].revision, 'the shard carries its revision');
  indexed.push(...read.items);
}
assert.deepEqual(indexed.map(record => record.key).sort(), ['Двойной|2006', 'Терминальный|2001']);
for (const record of indexed) assert.equal(record.decisionHash, sha(DI.canonicalJson(decisions[record.key])), 'the digest covers the full decision');
assert.equal(log.lists, 0);

// The same content again: only the manifest is written.
log.puts = [];
await save();
assert.deepEqual(log.puts, [manifestKey]);

// One decision changes: its shard and the manifest.
const terminalShard = DI.observationShard('Терминальный|2001');
context.args.decisions = {...decisions, 'Терминальный|2001': {...decisions['Терминальный|2001'], checkedAt: '2026-10-30T11:00:00.000Z'}};
log.puts = [];
await save();
assert.deepEqual(log.puts, [DI.observationIndexShardKey(RUN, terminalShard), manifestKey]);
context.args.decisions = decisions;

// A shard written without its manifest (a writer stopped between the two) is torn for readers and repaired by the next write.
await bucket.put(DI.observationIndexShardKey(RUN, terminalShard), JSON.stringify(DI.observationShardDocument(RUN, terminalShard, [], sha('x'))), {customMetadata: {revision: sha('x')}});
stored = await readManifest();
assert.equal(DI.readObservationIndexShard(await (await bucket.get(DI.observationIndexShardKey(RUN, terminalShard))).json(), stored, terminalShard).state, 'torn');
log.puts = [];
await save();
assert.ok(log.puts.includes(DI.observationIndexShardKey(RUN, terminalShard)), 'the stored revision, not the manifest, decides what is rewritten');
stored = await readManifest();
assert.ok(DI.readObservationIndexShard(await (await bucket.get(DI.observationIndexShardKey(RUN, terminalShard))).json(), stored, terminalShard).ok);

// Only the published generation; another or none writes nothing.
put('epg/published-generation.json', {phase: 'published', programmeRunId: 'run-2'});
log.puts = [];
assert.deepEqual({...await save()}, {written: false, reason: 'generation_not_published'});
await bucket.delete('epg/published-generation.json');
assert.deepEqual({...await save()}, {written: false, reason: 'generation_not_published'});
assert.deepEqual(log.puts, []);
put('epg/published-generation.json', {phase: 'published', programmeRunId: RUN});

// Every write is behind the fence; a lost lease is rethrown and leaves the manifest as it was.
const before = await bucket.get(manifestKey).then(object => object.etag);
context.args.decisions = {...decisions, 'Двойной|2006': {...decisions['Двойной|2006'], checkedAt: '2026-10-30T11:30:00.000Z'}};
context.args.fence = async () => {throw vm.runInContext('leaseLostError()', context);};
await assert.rejects(save(), error => error.name === 'LeaseLostError');
assert.equal((await bucket.get(manifestKey)).etag, before);
// Any other failure is swallowed: the chunk keeps its progress and the old manifest reads as stale.
context.args.fence = fence;
store.failHead = true;
assert.deepEqual({...await save()}, {written: false, reason: 'error'});
store.failHead = false;
context.args.decisions = decisions;

// 6. A full resolver chunk publishes a current index of its generation, and the final status precedes it.
seedWriter();
put('programme.json', {runId: RUN, films: []});
const report = {runId: RUN, updatedAt: new Date(now).toISOString(), films: []};
context.report = report;
put(ledgerKey, {programmeRunId: RUN, items: [live('Неведомый|1999')]});
put('epg/discovery-resolution.json', {});
log.puts = [];
await vm.runInContext('resolveDiscoveryBatch(env,report,1)', context);
assert.ok(tmdbCalls > 0, 'the chunk looked the title up');
const chunkDecision = JSON.parse(await (await bucket.get('epg/discovery-resolution.json')).text())['Неведомый|1999'];
assert.equal(chunkDecision.status, 'no_confident_match');
assert.ok(log.puts.indexOf('epg/discovery-status.json') < log.puts.indexOf(manifestKey), 'the index follows the status');
stored = await readManifest();
assert.equal(DI.observationIndexFreshness(stored, {programmeRunId: RUN, resolutionEtag: (await bucket.head('epg/discovery-resolution.json')).etag, ledgerEtag: (await bucket.head(ledgerKey)).etag}).state, 'fresh');
assert.equal(stored.coverage.indexed, 1);
const chunkShard = DI.observationShard('Неведомый|1999');
const chunkRecord = DI.readObservationIndexShard(await (await bucket.get(DI.observationIndexShardKey(RUN, chunkShard))).json(), stored, chunkShard).items[0];
assert.equal(chunkRecord.decisionHash, sha(DI.canonicalJson(chunkDecision)));
assert.equal(log.lists, 0);
assert.match(fs.readFileSync('src/discovery.js', 'utf8'), /await saveScorePreview\(env,source,preview,fence\);await saveObservationIndex\(env,source,persistedDecisions,fence,\{kind:'resolver_chunk',hopId\}\);return summary;/);

console.log('Discovery observation index: pure shape, cap and priority, validation, freshness, fenced writer, unchanged shards kept, torn repaired, published generation only, chunk integration passed');
