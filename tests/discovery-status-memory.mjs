// AIR-344: the discovery pipeline status and the footer status read the ledger once, streamed and counted item by item
// without keeping its items, and never hold the ledger, the decisions and the catalog at the same time. Their answers
// equal the counts of the whole parsed ledger, on a streamed and on a parsed ledger alike, with and without an
// interrupted continuation; neither writes.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const LEDGER = 'epg/discovery-latest.json', LARGE = new Set([LEDGER, 'epg/discovery-resolution.json', 'epg/discovered-films.json']);
function harness(records, {stream}) {
  let reading = 0, maxReading = 0, ledgerReads = 0, puts = 0, wholeLedgerParses = 0;
  const etags = new Map();
  const env = {TMDB_API_READ_ACCESS_TOKEN: 'test', BUCKET: {
    async get(key) {
      if (!records.has(key)) return null;
      const large = LARGE.has(key);
      if (key === LEDGER) ledgerReads++;
      if (large) {reading++; maxReading = Math.max(maxReading, reading);}
      const done = () => {if (large) reading--;};
      if (stream && key === LEDGER) {
        const bytes = new TextEncoder().encode(JSON.stringify(records.get(key)));
        let offset = 0;
        return {etag: etags.get(key) || '1', body: new ReadableStream({pull(controller) {if (offset >= bytes.length) {done(); controller.close(); return;} controller.enqueue(bytes.slice(offset, offset + 8192)); offset += 8192;}}), json: async () => {wholeLedgerParses++; done(); return structuredClone(records.get(key));}};
      }
      return {etag: etags.get(key) || '1', json: async () => {await new Promise(resolve => setTimeout(resolve, 1)); if (key === LEDGER) wholeLedgerParses++; done(); return structuredClone(records.get(key));}};
    },
    async head(key) {return records.has(key) ? {etag: '1'} : null;},
    async put() {puts++; return {etag: '2'};},
    async delete() {puts++;},
    async list() {throw new Error('status never lists');},
  }};
  const live = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date, Intl, Map, Set, JSON, TextEncoder, TextDecoder, ReadableStream, Uint8Array, crypto: webcrypto, console: {log() {}, error() {}, warn() {}}, setTimeout, structuredClone, fetch: async () => {throw new Error('status makes no request');}});
  for (const file of ['src/domain/scored-resolution.js', 'src/domain/resolution-acceptance.js', 'src/sources.js', 'src/discovery.js', 'src/domain/profile-impact.js', 'src/domain/prediction-compatibility.js', 'src/domain/fingerprint-compatibility.js', 'src/domain/prediction-confidence.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/worker.js']) vm.runInContext(fs.readFileSync(file, 'utf8').replace('export default', 'globalThis.worker='), live);
  live.env = env;
  return {live, maxReading: () => maxReading, ledgerReads: () => ledgerReads, puts: () => puts, wholeLedgerParses: () => wholeLedgerParses};
}

const now = Date.now(), H = 3600000, D = 86400000, RUN = 'run-1';
const show = start => ({channelId: 'c', channel: 'C', start, end: start + 2 * H});
const items = [], decisions = {}, catalog = {};
for (let index = 0; index < 6000; index++) {
  const offset = [0, -48 * H, -10 * D, -100 * D][index % 4];
  const title = (index % 97 === 0 ? 'т/с Сериал ' : 'Фильм ') + index;
  const item = {key: title.toLowerCase() + '|' + (1950 + index % 70), title, normalizedTitle: title.toLowerCase(), year: 1950 + index % 70, durations: [100], description: 'Описание ' + index, rawTitles: [title], shows: [show(now + offset)], lastAiring: now + offset, lastSeenAt: now + offset, seenInLatestSnapshot: index % 4 !== 3 ? true : false, ...(index % 50 === 0 ? {confirmedTmdbId: String(900000 + index)} : {})};
  items.push(item);
  const kind = index % 7;
  if (kind === 0) {decisions[item.key] = {status: 'verified', tmdbId: String(100000 + index)}; catalog['tmdb_' + (100000 + index)] = {id: 'tmdb_' + (100000 + index), tmdbId: String(100000 + index), title, shows: [show(now)]};}
  else if (kind === 1) decisions[item.key] = {status: 'verified', tmdbId: null};
  else if (kind === 2) decisions[item.key] = {status: 'ambiguous'};
  else if (kind === 3) decisions[item.key] = {status: 'no_confident_match', retryAt: new Date(now + D).toISOString()};
  else if (kind === 4) decisions[item.key] = {status: 'no_confident_match', terminalReason: 'repeated_uncertain_match', attempts: 5};
}
const ledger = {programmeRunId: RUN, updatedAt: new Date(now).toISOString(), rawCandidates: 7000, filteredNonMovies: 12, ledgerMode: 'frozen', archive: {uniqueArchivedItems: 321, manifestId: 'm-1', segments: 4, items: 400, bytes: 12345}, items};
const queue = {schemaVersion: 2, programmeRunId: RUN, pending: ['tmdb_100000', 'tmdb_100007', 'tmdb_missing'], priorityCount: 3, hotCount: 3, coldCount: 0, pendingCount: 3};
const records = () => new Map([
  ['epg/published-generation.json', {phase: 'published', programmeRunId: RUN}],
  ['programme.json', {runId: RUN, films: []}],
  [LEDGER, ledger],
  ['epg/discovery-resolution.json', decisions],
  ['epg/discovered-films.json', catalog],
  ['epg/discovery-status.json', {schemaVersion: 2, stage: 'partial', programmeRunId: RUN, hopId: 'hop-1', checkpoint: 'cheap_pass', touched: 10, checked: 0, tmdbCalls: 0}],
  ['enrichment/prediction-queue.json', queue],
  ['sync.json', {stage: 'complete', runId: RUN}],
]);
const interrupted = {stage: 'paused', reason: 'interrupted', at: new Date(now - H).toISOString(), hopId: 'hop-1', remainingChunks: 12, programmeRunId: RUN, nextCatchUpAt: null, retryAt: null};

// The counts the old status computed from the whole parsed ledger.
const reference = harness(records(), {stream: false});
reference.live.args = {ledger, decisions};
const expected = vm.runInContext('({counts:ledgerCounts(args.ledger,args.decisions,Date.now())})', reference.live);
const statuses = {}, confirmed = new Set(), recognized = new Set();
for (const item of items) {const decision = decisions[item.key]; if (decision) {statuses[decision.status] = (statuses[decision.status] || 0) + 1; if (decision.status === 'verified') {confirmed.add(String(decision.tmdbId)); if (decision.tmdbId) recognized.add(String(decision.tmdbId));}}}

for (const continuation of [null, interrupted]) {
  const answers = [];
  for (const stream of [false, true]) {
    const stored = records();
    if (continuation) stored.set('epg/resolver-continuation.json', continuation);
    const run = harness(stored, {stream});
    const status = JSON.parse(JSON.stringify(await vm.runInContext('discoveryPipelineStatus(env)', run.live)));
    const label = `${continuation ? 'interrupted' : 'idle'} ${stream ? 'streamed' : 'parsed'}`;
    assert.equal(run.puts(), 0, label + ': the status writes nothing');
    assert.equal(run.ledgerReads(), continuation ? 2 : 1, label + ': the ledger is counted once, and read once more, independently, for the recovery verdict');
    assert.equal(run.maxReading(), 1, label + ': no two large documents are read at once');
    if (stream) assert.equal(run.wholeLedgerParses(), 0, label + ': a streamed ledger is never parsed whole');
    for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(expected.counts)))) assert.deepEqual(status[key], value, label + ': ' + key);
    assert.equal(status.candidates, expected.counts.ledgerTotal);
    assert.equal(status.archive.uniqueArchivedItems, 321);
    assert.deepEqual(status.statuses, statuses, label + ': statuses');
    assert.equal(status.confirmedFilms, confirmed.size, label + ': confirmed');
    assert.equal(status.checked, Object.values(statuses).reduce((a, b) => a + b, 0));
    assert.equal(status.verifiedFilms, Object.keys(catalog).length);
    assert.deepEqual(status.nextHotPredictions.map(row => [row.filmId, row.tmdbId, row.title]), [['tmdb_100000', '100000', 'т/с Сериал 0'], ['tmdb_100007', '100007', 'Фильм 7'], ['tmdb_missing', null, null]]);
    assert.equal(status.programmeRunId, RUN);
    assert.equal(status.latestRawCandidates, 7000);
    if (continuation) assert.deepEqual(status.interruptedRecovery, {permit: 'eligible', reason: 'eligible', cause: null, budget: 12, proof: 'cheap_pass'}, label + ': the recovery verdict');
    else assert.equal(status.interruptedRecovery, undefined);
    answers.push(status);
  }
  assert.deepEqual(answers[1], answers[0], 'the streamed and the parsed status are equal');
}

// A ledger of another generation is still told apart by the recovery facts.
{
  const stored = records();
  stored.set('epg/resolver-continuation.json', interrupted);
  stored.set(LEDGER, {...ledger, programmeRunId: 'run-0'});
  const run = harness(stored, {stream: true});
  const status = await vm.runInContext('discoveryPipelineStatus(env)', run.live);
  assert.notEqual(status.interruptedRecovery.permit, 'eligible', 'a ledger of another run is not eligible');
}

// The pinned generation and the live one diverge: a generation is published after the status pinned run-1. The status counts
// the pinned ledger; the recovery verdict reads the live ledger itself (unpinned) and refuses. Only the ledger differs: the
// programme still names run-1, so a verdict that reused the pinned ledger read would say `eligible`.
for (const stream of [false, true]) {
  const stored = records();
  stored.set('epg/resolver-continuation.json', interrupted);
  stored.set('epg/generations/run-1/discovery-latest.json', ledger);
  stored.set('epg/generations/run-1/discovery-resolution.json', decisions);
  stored.set('epg/generations/run-1/discovered-films.json', catalog);
  stored.set('epg/generations/run-1/programme.json', {runId: 'run-1', films: []});
  stored.set('epg/generations/run-2/discovery-latest.json', {...ledger, programmeRunId: 'run-2', items: ledger.items.slice(0, 10)});
  const run = harness(stored, {stream});
  const bucket = run.live.env.BUCKET, original = bucket.get.bind(bucket);
  let flipped = false;
  bucket.get = async key => {
    const object = await original(key);
    if (key !== 'epg/published-generation.json' || !object || flipped) return object;
    const json = object.json;
    return {...object, json: async () => {const value = await json(); flipped = true; stored.set(key, {phase: 'published', programmeRunId: 'run-2'}); return value;}};
  };
  const status = JSON.parse(JSON.stringify(await vm.runInContext('discoveryPipelineStatus(env)', run.live)));
  assert.equal(flipped, true, 'the generation was published after the status pinned');
  assert.equal(status.programmeRunId, 'run-1', 'the counts are those of the pinned generation');
  assert.equal(status.candidates, ledger.items.length + 321, 'the pinned active ledger plus the shared archive');
  assert.deepEqual({permit: status.interruptedRecovery.permit, reason: status.interruptedRecovery.reason}, {permit: 'refused', reason: 'generation_mismatch'}, 'the live ledger differs from the pinned one: refused');
  assert.equal(run.puts(), 0);
}

// The recovery facts on their own (the confirm path) keep only the ledger's wrapper.
{
  const stored = records();
  const run = harness(stored, {stream: true});
  run.live.args = {current: interrupted};
  const verdict = await vm.runInContext('interruptedRecoveryFacts(env,{now:Date.now(),current:args.current,lease:null,published:"run-1",programmeRunId:"run-1"})', run.live);
  assert.equal(verdict.permit, 'eligible');
  assert.equal(run.ledgerReads(), 1);
  assert.equal(run.wholeLedgerParses(), 0);
}

// The footer status counts the same ledger the same way.
{
  const answers = [];
  for (const stream of [false, true]) {
    const run = harness(records(), {stream});
    const footer = JSON.parse(JSON.stringify(await vm.runInContext('footerStatus(env)', run.live)));
    assert.equal(run.ledgerReads(), 1);
    assert.equal(run.puts(), 0, 'the footer writes nothing');
    assert.equal(footer.epgTmdb.recognizedFilms, recognized.size);
    assert.equal(footer.epgTmdb.pendingRecognition, expected.counts.currentUnresolved);
    delete footer.generatedAt;
    answers.push(footer);
  }
  assert.deepEqual(answers[1], answers[0], 'the streamed and the parsed footer are equal');
}

// A stored ledger without an items array still answers, with zero counts, as before.
{
  const stored = records();
  stored.set(LEDGER, {programmeRunId: RUN});
  const run = harness(stored, {stream: true});
  const status = await vm.runInContext('discoveryPipelineStatus(env)', run.live);
  assert.equal(status.candidates, 0);
  assert.equal(status.programmeRunId, RUN);
}

console.log('Discovery status memory: one streamed ledger read, sequential large reads, counts equal to the whole ledger, recovery verdict kept, footer equal, no writes passed');
