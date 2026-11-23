// AIR-527 (ADR 0170 section 5): the derived archive registry. Pure rules (caps, ordering, enumeration, estimates) and the hook in the
// existing candidate writers: the first import into an empty registry, a lost or refused registry update that never fails the primary write,
// an older summary that never replaces a newer one, and no registry write when the candidate document did not change.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as R from '../src/domain/letterboxd-import-registry.js';
import {loadArchiveWorker} from './fixtures/letterboxd-archive-worker.mjs';

const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64), SHA_C = 'c'.repeat(64);
const NOW = '2026-11-18T10:00:00.000Z', LATER = '2026-11-18T11:00:00.000Z';
const doc = states => ({schemaVersion: 1, archiveSha256: SHA_A, generatedAt: '2026-11-01T00:00:00.000Z', candidates: Object.fromEntries(states.map((state, i) => ['c' + i, {code: 'c' + i, state, registeredAt: '2026-11-0' + (i + 1) + 'T00:00:00.000Z'}])), checkpoint: {cursor: null, stopped: null}});

// ---- pure ----
assert.equal(R.REGISTRY_KEY, 'letterboxd/imports/registry.json');
assert.equal(R.archiveOfCandidateKey('letterboxd/imports/' + SHA_A + '/rated-candidates.json'), SHA_A);
assert.equal(R.archiveOfCandidateKey('letterboxd/imports/' + SHA_A + '/chunks/0.receipt.json'), null);
assert.equal(R.archiveOfCandidateKey('letterboxd/admissions/verified-films.json'), null);
{
  const summary = R.summarizeDocument({...doc(['pending', 'verified', 'verified', 'needs_review', 'removed', 'bogus']), revision: 3}, {etag: 'e1', now: NOW});
  assert.equal(summary.revision, 3); assert.equal(R.summarizeDocument(doc(['pending']), {etag: 'e', now: NOW}).revision, null);
  assert.deepEqual(summary.counts, {pending: 1, admitting: 0, needs_review: 1, verified: 2, removed: 1});
  assert.equal(summary.documentEtag, 'e1');
  assert.equal(summary.registeredAt, '2026-11-01T00:00:00.000Z');
  assert.equal(R.summarizeDocument({}, {etag: null, now: NOW}).documentEtag, null);
  const first = R.applyArchive(null, SHA_A, summary, NOW);
  assert.equal(first.changed, true);
  assert.deepEqual(Object.keys(first.registry.archives), [SHA_A]);
  assert.equal(first.registry.archives[SHA_A].registeredAt, '2026-11-01T00:00:00.000Z');
  // registeredAt of an archive is kept from the first registration
  const again = R.applyArchive(first.registry, SHA_A, {...summary, revision: 4, registeredAt: '2027-01-01T00:00:00.000Z', summarizedAt: LATER}, LATER);
  assert.equal(again.registry.archives[SHA_A].registeredAt, '2026-11-01T00:00:00.000Z');
  assert.equal(again.registry.archives[SHA_A].revision, 4);
  // ordered by the document's mutation revision, not by a clock: an older or equal revision never replaces a row, even with a later summarizedAt
  for (const revision of [3, 4, null]) assert.deepEqual(R.applyArchive(again.registry, SHA_A, {...summary, revision, summarizedAt: '2030-01-01T00:00:00.000Z'}, LATER), {changed: false, refused: 'older_summary'});
  assert.equal(R.applyArchive(again.registry, SHA_A, {...summary, revision: 5, summarizedAt: NOW}, LATER).changed, true, 'a newer revision wins whatever its clock says');
  assert.deepEqual(R.applyArchive(null, 'nope', summary, NOW), {changed: false, refused: 'invalid_archive'});
  assert.deepEqual(R.applyArchive({schemaVersion: 9, archives: {}}, SHA_A, summary, NOW), {changed: false, refused: 'registry_invalid'});
}
// caps: archives and bytes
{
  const archives = {};
  for (let i = 0; i < R.REGISTRY_MAX_ARCHIVES; i++) archives[i.toString(16).padStart(64, '0')] = {registeredAt: NOW, generatedAt: null, counts: {pending: 0, admitting: 0, needs_review: 0, verified: 0, removed: 0}, documentEtag: 'e', summarizedAt: NOW};
  const full = {schemaVersion: 1, updatedAt: NOW, archives};
  const summary = R.summarizeDocument(doc(['pending']), {etag: 'e', now: NOW});
  assert.deepEqual(R.applyArchive(full, SHA_A, summary, NOW), {changed: false, refused: 'registry_full'});
  assert.equal(R.applyArchive(full, Object.keys(archives)[3], {...summary, revision: 1, summarizedAt: LATER}, LATER).changed, true, 'an archive already in the registry still updates at the cap');
  const wide = {...summary, documentEtag: 'x'.repeat(R.REGISTRY_MAX_BYTES)};
  assert.deepEqual(R.applyArchive(null, SHA_A, wide, NOW), {changed: false, refused: 'registry_too_large'});
}
// order, enumeration, estimate
{
  const row = (registeredAt, pending = 0) => ({registeredAt, generatedAt: null, counts: {pending, admitting: 0, needs_review: 0, verified: 0, removed: 0}, documentEtag: 'e', summarizedAt: registeredAt});
  const registry = {schemaVersion: 1, updatedAt: NOW, archives: {[SHA_C]: row('2026-11-01T00:00:00.000Z', 3), [SHA_A]: row('2026-11-03T00:00:00.000Z', 1), [SHA_B]: row('2026-11-01T00:00:00.000Z', 2)}};
  assert.deepEqual(R.orderedArchives(registry).map(item => item.sha), [SHA_B, SHA_C, SHA_A], 'registeredAt, then sha');
  assert.deepEqual(R.enumerate(registry, {prefixes: [SHA_A, SHA_B, SHA_C], truncated: false}), {state: 'complete', reason: null, registered: 3, listed: 3, unindexed: 0, unindexedArchives: [], registryOrphans: 0, orphanArchives: []});
  const extra = 'd'.repeat(64);
  const unindexed = R.enumerate(registry, {prefixes: [SHA_A, SHA_B, SHA_C, extra], truncated: false});
  assert.equal(unindexed.state, 'partial'); assert.equal(unindexed.reason, 'unindexed_archives'); assert.deepEqual(unindexed.unindexedArchives, [extra]);
  const orphan = R.enumerate(registry, {prefixes: [SHA_A, SHA_B], truncated: false});
  assert.equal(orphan.reason, 'registry_orphans'); assert.deepEqual(orphan.orphanArchives, [SHA_C]);
  const truncated = R.enumerate(registry, {prefixes: [SHA_A], truncated: true});
  assert.equal(truncated.reason, 'listing_truncated'); assert.equal(truncated.registryOrphans, null, 'orphans cannot be judged on a truncated listing');
  assert.equal(R.enumerate(registry, null).state, 'unknown');
  assert.equal(R.enumerate(null, {prefixes: [], truncated: false}).state, 'complete', 'no archives and no registry is a complete, empty enumeration of prefixes (not "no work")');
  const estimate = R.estimateCounts(registry);
  assert.equal(estimate.basis, 'registry_estimate'); assert.equal(estimate.byStatus.pending, 6); assert.equal(estimate.summarizedAt, '2026-11-03T00:00:00.000Z');
  // a malformed row is dropped by the parser
  const parsed = R.parseRegistry({schemaVersion: 1, updatedAt: NOW, archives: {[SHA_A]: {counts: {pending: -4, verified: 2.5}}, 'not-a-sha': {counts: {}}, [SHA_B]: 'x'}});
  assert.deepEqual(Object.keys(parsed.archives), [SHA_A]); assert.equal(parsed.archives[SHA_A].counts.pending, 0);
}

// ---- the hook in the candidate writers ----
const records = new Map();
let version = 0, failRegistryPut = false, registryPuts = 0, registryGets = 0;
const bucket = {
  async get(key) {
    if (key === R.REGISTRY_KEY) registryGets++;
    const entry = records.get(key);
    return entry ? {etag: entry.etag, body: null, json: async () => JSON.parse(entry.text), text: async () => entry.text} : null;
  },
  async put(key, value, options = {}) {
    if (key === R.REGISTRY_KEY) {registryPuts++; if (failRegistryPut) throw new Error('registry storage down');}
    const current = records.get(key);
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && current) return null;
    const etag = 'e' + (++version);
    records.set(key, {text: value, etag});
    return {etag};
  },
  async head(key) {return records.has(key) ? {etag: records.get(key).etag} : null;},
};
const env = {BUCKET: bucket};
const {context} = loadArchiveWorker({now: Date.parse(NOW), console: {log() {}, warn() {}, error() {}}, fetch: async () => {throw new Error('no outbound request');}});
const Candidates = vm.runInContext('LetterboxdRatedCandidates', context);
const registry = () => records.has(R.REGISTRY_KEY) ? JSON.parse(records.get(R.REGISTRY_KEY).text) : null;
const rows = (...codes) => codes.map(code => ({code, disposition: 'pending', reason: null, rating: 4, name: 'Film ' + code, year: 2001}));
const docKey = sha => 'letterboxd/imports/' + sha + '/rated-candidates.json';

// the first new import into an empty registry
assert.equal(registry(), null);
const first = await Candidates.registerCandidates(env, {sha: SHA_A, generatedAt: '2026-11-01T00:00:00.000Z', chunk: 0, rows: rows('Aa1', 'Bb2')});
assert.deepEqual([...first.added].sort(), ['Aa1', 'Bb2']);
{
  const stored = registry();
  assert.equal(stored.schemaVersion, 1);
  assert.deepEqual(Object.keys(stored.archives), [SHA_A]);
  assert.equal(stored.archives[SHA_A].counts.pending, 2);
  assert.equal(stored.archives[SHA_A].documentEtag, records.get(docKey(SHA_A)).etag, 'the row names the etag of the document the writer just saved');
  assert.equal(stored.archives[SHA_A].generatedAt, '2026-11-01T00:00:00.000Z');
}
// a second archive adds a row and keeps the first
await Candidates.registerCandidates(env, {sha: SHA_B, generatedAt: '2026-11-02T00:00:00.000Z', chunk: 0, rows: rows('Cc3')});
assert.deepEqual(Object.keys(registry().archives).sort(), [SHA_A, SHA_B]);
// an unchanged document writes nothing, registry included
{
  const before = registryPuts;
  const noop = await Candidates.registerCandidates(env, {sha: SHA_A, generatedAt: '2026-11-01T00:00:00.000Z', chunk: 0, rows: rows('Bb2')});
  assert.equal(noop.changed, false); assert.equal(registryPuts, before);
}
// a registry that cannot be written never fails or undoes the primary write; the row is stale until the next writer
failRegistryPut = true;
const lost = await Candidates.registerCandidates(env, {sha: SHA_B, generatedAt: '2026-11-02T00:00:00.000Z', chunk: 1, rows: rows('Dd4')});
assert.deepEqual([...lost.added], ['Dd4']);
assert.equal(JSON.parse(records.get(docKey(SHA_B)).text).candidates.Dd4.state, 'pending', 'the candidate is stored');
assert.equal(registry().archives[SHA_B].counts.pending, 1, 'the registry still holds the old estimate');
assert.notEqual(registry().archives[SHA_B].documentEtag, records.get(docKey(SHA_B)).etag, 'and it names an older etag, which a GET reports as registry_stale');
failRegistryPut = false;
await Candidates.registerCandidates(env, {sha: SHA_B, generatedAt: '2026-11-02T00:00:00.000Z', chunk: 1, rows: rows('Ee5')});
assert.equal(registry().archives[SHA_B].counts.pending, 3, 'the next writer of the archive repairs the row');
// every committed candidate write raises the document's revision by one, and the row carries it
{
  const stored = JSON.parse(records.get(docKey(SHA_A)).text);
  assert.ok(Number.isInteger(stored.revision) && stored.revision >= 1, 'register: revision ' + stored.revision);
  assert.equal(registry().archives[SHA_A].revision, stored.revision);
}
// a delayed response of an older write must not overwrite the newer write's row (equal-millisecond clocks included: the test clock is frozen)
{
  const SHA_D = 'd'.repeat(64);
  let gate = null, release = null, held = false;
  const slow = {...bucket, async put(key, value, options) {
    const saved = await bucket.put(key, value, options);
    if (key === docKey(SHA_D) && saved && !held) {held = true; gate = new Promise(resolve => {release = resolve;}); await gate;}
    return saved;
  }};
  const first = Candidates.registerCandidates({BUCKET: slow}, {sha: SHA_D, generatedAt: '2026-11-04T00:00:00.000Z', chunk: 0, rows: rows('Aa1')});
  while (!held) await new Promise(resolve => setTimeout(resolve, 1));
  // write B commits and syncs while A's response is still on its way
  await Candidates.registerCandidates(env, {sha: SHA_D, generatedAt: '2026-11-04T00:00:00.000Z', chunk: 1, rows: rows('Bb2')});
  const after = registry().archives[SHA_D];
  assert.equal(after.counts.pending, 2); assert.equal(after.documentEtag, records.get(docKey(SHA_D)).etag);
  release();
  const done = await first;
  assert.deepEqual([...done.added], ['Aa1'], 'the delayed write still succeeded');
  const row = registry().archives[SHA_D];
  assert.equal(row.counts.pending, 2, 'the delayed sync did not overwrite the newer counts');
  assert.equal(row.documentEtag, records.get(docKey(SHA_D)).etag, 'nor the newer etag');
  assert.equal(row.revision, JSON.parse(records.get(docKey(SHA_D)).text).revision);
}
// an unreadable registry is left alone (never overwritten with a guess), the primary write still succeeds
records.set(R.REGISTRY_KEY, {text: '{not json', etag: 'broken'});
const beforeBroken = registryPuts;
const survived = await Candidates.registerCandidates(env, {sha: SHA_C, generatedAt: '2026-11-03T00:00:00.000Z', chunk: 0, rows: rows('Ff6')});
assert.deepEqual([...survived.added], ['Ff6']); assert.equal(registryPuts, beforeBroken); assert.equal(records.get(R.REGISTRY_KEY).text, '{not json');
// a registry of another schema is never overwritten by a guess (it may belong to newer code): the writer leaves it, a GET reports it `invalid`
records.set(R.REGISTRY_KEY, {text: JSON.stringify({schemaVersion: 9}), etag: 'other'});
const beforeOther = registryPuts;
await Candidates.registerCandidates(env, {sha: SHA_C, generatedAt: '2026-11-03T00:00:00.000Z', chunk: 0, rows: rows('Gg7')});
assert.equal(registryPuts, beforeOther); assert.equal(JSON.parse(records.get(R.REGISTRY_KEY).text).schemaVersion, 9);
// dropping the registry is the recovery: the next writer starts it again from its own archive
records.delete(R.REGISTRY_KEY);
await Candidates.registerCandidates(env, {sha: SHA_C, generatedAt: '2026-11-03T00:00:00.000Z', chunk: 0, rows: rows('Hh8')});
assert.deepEqual(Object.keys(registry().archives), [SHA_C]); assert.equal(registry().archives[SHA_C].counts.pending, 3);
// the registry is written only by writers: a new Worker-side reader helper does not exist in the registry module
assert.equal(typeof R.applyArchive, 'function');
console.log('letterboxd-import-registry: ok');
