// AIR-342: the resolver chunk's memory. A chunk reads its inputs one at a time, and once it has chosen the candidates it
// looks up, every other observation of its ledger copy drops the fields the rest of the chunk never reads. The chosen
// candidates keep them: a detail-verified Film still takes its synopsis from the EPG description when TMDB has none.
// The chunk's results (decisions, catalog, final status) are those of a chunk that kept everything.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const source = fs.readFileSync('src/discovery.js', 'utf8');
const chunk = source.slice(source.indexOf('async function resolveDiscoveryChunk('), source.indexOf('async function discoveryDigest('));
assert.doesNotMatch(chunk, /Promise\.all\(\[loadJSON\(pinned/, 'the chunk inputs are not read in parallel');
assert.ok(chunk.indexOf('films=null;aliasIndex.clear();knownTmdb.clear();') > 0 && chunk.indexOf('films=null;aliasIndex.clear();knownTmdb.clear();') < chunk.indexOf("await loadJSON(env,'programme.json')"), 'the catalog is released before the programme is read again');

const LEDGER = 'epg/discovery-latest.json', INPUTS = new Set([LEDGER, 'epg/discovery-resolution.json', 'epg/discovered-films.json', 'epg/discovery-status.json']);
function harness(respond, {stream = false} = {}) {
  const records = new Map(), etags = new Map();
  let revision = 0, calls = 0, reading = 0, maxReading = 0, ledgerCopy = null, ledgerReads = 0, wholeParses = 0;
  const env = {TMDB_API_READ_ACCESS_TOKEN: 'test', TMDB_REQUEST_INTERVAL_MS: 0, BUCKET: {
    async get(key) {
      if (!records.has(key)) return null;
      if (key === LEDGER) ledgerReads++;
      const input = INPUTS.has(key);
      if (input) {reading++; maxReading = Math.max(maxReading, reading);}
      if (stream && key === LEDGER) {
        reading--;
        const text = JSON.stringify(records.get(key)), bytes = new TextEncoder().encode(text);
        let offset = 0;
        return {etag: etags.get(key), body: new ReadableStream({pull(controller) {if (offset >= bytes.length) {controller.close(); return;} controller.enqueue(bytes.slice(offset, offset + 4096)); offset += 4096;}}), json: async () => {wholeParses++; return structuredClone(records.get(key));}};
      }
      return {etag: etags.get(key), json: async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        const value = structuredClone(records.get(key));
        if (input) reading--;
        if (key === LEDGER && !ledgerCopy) ledgerCopy = value;
        return value;
      }};
    },
    async put(key, value, options = {}) {
      const condition = options.onlyIf;
      if (condition?.etagDoesNotMatch === '*' && records.has(key) || condition?.etagMatches && condition.etagMatches !== etags.get(key)) return null;
      records.set(key, JSON.parse(value)); etags.set(key, String(++revision)); return {etag: etags.get(key)};
    },
  }};
  const live = vm.createContext({Response, Request, URL, URLSearchParams, AbortSignal, Date, Map, Set, JSON, TextEncoder, TextDecoder, ReadableStream, Uint8Array, crypto: webcrypto, console: {log() {}, error() {}, warn() {}}, setTimeout, structuredClone, fetch: async input => {calls++; return respond(String(input));}});
  for (const file of ['src/domain/scored-resolution.js', 'src/domain/resolution-acceptance.js', 'src/sources.js', 'src/discovery.js', 'src/domain/profile-impact.js', 'src/domain/prediction-compatibility.js', 'src/domain/fingerprint-compatibility.js', 'src/domain/prediction-confidence.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/worker.js']) vm.runInContext(fs.readFileSync(file, 'utf8').replace('export default', 'globalThis.worker='), live);
  live.env = env;
  return {live, records, wholeParses: () => wholeParses, ledgerReads: () => ledgerReads, calls: () => calls, maxReading: () => maxReading, ledger: () => ledgerCopy};
}

// releaseLedgerDetail on its own.
{
  const {live} = harness(() => new Response('{}'));
  const kept = {key: 'a|1', title: 'A', description: 'd', rawTitles: ['A'], firstAiring: 1, airings: 2, lastSeenProgrammeRunId: 'r', shows: [{start: 1}], lastAiring: 5};
  const other = {...structuredClone(kept), key: 'b|1'};
  live.items = [kept, other];
  live.keep = new Set([kept]);
  vm.runInContext('releaseLedgerDetail(items,keep)', live);
  assert.equal(kept.description, 'd', 'a chosen candidate keeps everything');
  assert.deepEqual(kept.rawTitles, ['A']);
  for (const field of ['description', 'rawTitles', 'firstAiring', 'airings', 'lastSeenProgrammeRunId']) assert.equal(other[field], undefined, field);
  assert.deepEqual([other.key, other.title, other.lastAiring, other.shows], ['b|1', 'A', 5, [{start: 1}]], 'what the counts, filters and index read stays');
}

// A chunk over a ledger of several thousand observations.
const now = Date.now(), H = 3600000, D = 86400000;
const show = start => ({channelId: 'n', channel: 'N', start, end: start + 2 * H, epgTitle: 'х/ф'});
const observation = (title, year, extra = {}) => ({key: title.toLowerCase() + '|' + (year ?? ''), title, normalizedTitle: title.toLowerCase(), year, duration: 137, durations: [137], description: 'Описание ' + title + ' '.repeat(40), rawTitles: [title, 'х/ф ' + title], firstAiring: now - D, airings: 1, lastSeenProgrammeRunId: 'run-1', seenInLatestSnapshot: true, shows: [show(now)], lastAiring: now, lastSeenAt: now, ...extra});
const dune = {...observation('Dune', 1984), description: 'Описание из EPG'};
const filler = [];
for (let index = 0; index < 4000; index++) filler.push(observation('Фильм ' + index, 1950 + index % 70, {shows: [show(now - 48 * H)], lastAiring: now - 48 * H}));
const decisions = {};
for (let index = 0; index < 3000; index++) decisions[filler[index].key] = {status: 'verified', tmdbId: String(100000 + index), filmId: 'tmdb_' + (100000 + index)};
const catalog = {tmdb_11: {id: 'tmdb_11', tmdbId: '11', title: 'Дюна', original: 'Dune', year: 1984, runtime: 137, canonicalIdentity: 'tmdb:11', aliases: [], shows: []}};
for (let index = 0; index < 3000; index++) catalog['tmdb_' + (100000 + index)] = {id: 'tmdb_' + (100000 + index), tmdbId: String(100000 + index), title: filler[index].title, original: filler[index].title, year: filler[index].year, canonicalIdentity: 'tmdb:' + (100000 + index), aliases: [], shows: []};
const detail = new Response(JSON.stringify({id: 11, title: 'Дюна', original_title: 'Dune', release_date: '1984-01-01', runtime: 137, overview: '', genres: [{name: 'Drama'}], poster_path: null, credits: {crew: [], cast: []}, translations: {translations: [{iso_639_1: 'ru', data: {title: 'Дюна'}}]}, alternative_titles: {titles: []}}));
const empty = () => new Response(JSON.stringify({total_pages: 1, results: []}));
const run = harness(url => url.includes('/movie/11') ? detail.clone() : empty());
run.records.set('programme.json', {runId: 'run-1', films: []});
run.records.set(LEDGER, {programmeRunId: 'run-1', items: [dune, ...filler]});
run.records.set('epg/discovered-films.json', catalog);
run.records.set('epg/discovery-resolution.json', decisions);
const summary = await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)', run.live);

assert.equal(run.maxReading(), 1, 'one input is read at a time');
assert.notEqual(summary.checkpoint, 'cheap_pass', 'the chunk reaches its final status');
assert.equal(run.records.get('epg/discovery-status.json').checkpoint, undefined, 'the stored status is the final one');
assert.equal(summary.stage, 'partial');
const stored = run.records.get('epg/discovery-resolution.json');
assert.equal(stored['dune|1984'].status, 'verified');
assert.equal(stored['dune|1984'].identitySource, 'tmdb_detail');
const film = run.records.get('epg/discovered-films.json').tmdb_11;
assert.equal(film.synopsis, 'Описание из EPG', 'a chosen candidate keeps its EPG description for the synopsis fallback');
assert.ok(film.aliases.includes('х/ф Dune'), 'and its raw titles for the aliases');
assert.equal(Object.keys(run.records.get('epg/discovered-films.json')).length, 3001, 'no Film admitted or lost');
assert.equal(summary.remaining, 1000 - 3, 'the other actionable observations still count as remaining');

// The chunk's own ledger copy: the chosen candidates are whole, every other observation is released.
const ledger = run.ledger();
const chosen = ledger.items.filter(item => item.description !== undefined);
assert.equal(chosen.length, 4, 'exactly the chosen candidates keep their detail');
assert.ok(chosen.some(item => item.key === 'dune|1984'));
for (const item of ledger.items) if (item.description === undefined) assert.deepEqual([item.rawTitles, item.firstAiring, item.airings, item.lastSeenProgrammeRunId], [undefined, undefined, undefined, undefined]);
assert.equal(run.records.get(LEDGER).items[1].description, filler[0].description, 'the stored ledger is untouched');

// The same chunk with the ledger streamed from R2: the description and the airing counters are never kept, the chosen
// candidate reads its description back for the synopsis, and every result equals the parsed chunk's.
const streamedRun = harness(url => url.includes('/movie/11') ? detail.clone() : empty(), {stream: true});
const kept = [];
const compactOriginal = streamedRun.live.compactLedgerItem;
streamedRun.live.compactLedgerItem = item => {const value = compactOriginal(item); kept.push(value); return value;};
streamedRun.records.set('programme.json', {runId: 'run-1', films: []});
streamedRun.records.set(LEDGER, {programmeRunId: 'run-1', items: [dune, ...filler]});
streamedRun.records.set('epg/discovered-films.json', catalog);
streamedRun.records.set('epg/discovery-resolution.json', decisions);
const streamedSummary = await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)', streamedRun.live);
assert.equal(kept.length, filler.length + 1, 'the chunk streamed its ledger once');
assert.equal(streamedRun.ledgerReads(), 2, 'and read it once more for the one missing description');
const own = kept;
assert.equal(own.find(item => item.key === 'dune|1984').description, 'Описание из EPG', 'read back for the chosen candidate');
assert.equal(own.filter(item => item.description !== undefined).length, 1, 'no other description is kept');
for (const item of own) assert.deepEqual([item.firstAiring, item.airings, item.lastSeenProgrammeRunId], [undefined, undefined, undefined]);
assert.deepEqual(own.find(item => item.key === 'dune|1984').rawTitles, ['Dune', 'х/ф Dune']);
assert.equal(own.filter(item => item.rawTitles !== undefined).length, 4, 'raw titles stay only on the chosen candidates');
const plainOf = (value, drop = /"(checkedAt|startedAt|finishedAt|at|hopId|discoveredAt|hotEnteredAt|lastAttemptAt|retryAt)":"[^"]*"/g) => JSON.stringify(value).replace(drop, '"$1":"T"');
for (const key of ['epg/discovery-resolution.json', 'epg/discovered-films.json', 'epg/discovery-status.json']) assert.equal(plainOf(streamedRun.records.get(key)), plainOf(run.records.get(key)), key);
assert.deepEqual({...streamedSummary, startedAt: 0, finishedAt: 0, at: 0, hopId: 0}, {...summary, startedAt: 0, finishedAt: 0, at: 0, hopId: 0});
// A film whose TMDB detail has an overview needs no second read.
const overview = harness(url => url.includes('/movie/11') ? new Response(JSON.stringify({id: 11, title: 'Дюна', original_title: 'Dune', release_date: '1984-01-01', runtime: 137, overview: 'TMDB', genres: [], credits: {crew: [], cast: []}, translations: {translations: []}, alternative_titles: {titles: []}})) : empty(), {stream: true});
overview.records.set('programme.json', {runId: 'run-1', films: []});
overview.records.set(LEDGER, {programmeRunId: 'run-1', items: [dune, ...filler]});
overview.records.set('epg/discovered-films.json', catalog);
overview.records.set('epg/discovery-resolution.json', decisions);
await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)', overview.live);
assert.equal(overview.records.get('epg/discovered-films.json').tmdb_11.synopsis, 'TMDB');
assert.equal(overview.ledgerReads(), 1, 'the ledger is streamed once');
assert.equal(streamedRun.wholeParses() + overview.wholeParses(), 0, 'a streamed ledger is never parsed whole');

// A stored ledger without an items array keeps its old outcome under the streamed reader.
const noItems = harness(empty, {stream: true});
noItems.records.set('programme.json', {runId: 'run-1', films: []});
noItems.records.set(LEDGER, {programmeRunId: 'run-1'});
noItems.records.set('epg/discovered-films.json', {});
noItems.records.set('epg/discovery-resolution.json', {});
assert.equal((await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)', noItems.live)).stage, 'awaiting_epg_discovery');
assert.equal(noItems.wholeParses(), 1, 'it falls back to the whole parse once');

console.log('Discovery chunk memory: sequential inputs, detail released after the selection, chosen candidates kept, unchanged results passed');
