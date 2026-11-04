#!/usr/bin/env node
// AIR-342: memory profile of one discovery resolver chunk at production scale, offline. It builds a synthetic published
// generation (by default 37,000 observations with EPG descriptions, about 46 MB of ledger JSON like production on
// 4 November 2026; 3,300 catalog Films; 4,400 decisions), runs `resolveDiscoveryBatch` of the built Worker bundle
// (`npm run build` first) against an in-memory bucket and a TMDB stub, and prints the V8 heap at each stage: the peak
// since the previous stage and what is retained after a forced collection. Stored objects are kept as Buffers, off the
// V8 heap, so the numbers are the chunk's own. Node's heap is not the Workers isolate limit; compare runs with each
// other (for example before and after a change), not with 128 MB.
// Usage: node --expose-gc scripts/discovery-chunk-profile.mjs [--items 37000] [--films 3300] [--decisions 4400] [--limit 24]
// The live set is best compared as the smallest old space a run completes in, for example:
//   for m in 48 64 80 96 112 128 160 192; do node --expose-gc --max-old-space-size=$m scripts/discovery-chunk-profile.mjs >/dev/null 2>&1 && echo $m && break; done
// Without a heap limit Node collects lazily, so the printed peaks include garbage; the retained figures do not.
// Nothing here reads or writes R2, D1, TMDB or any network.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), option = (name, fallback) => {const index = args.indexOf('--' + name); return index < 0 ? fallback : Number(args[index + 1]);};
const ITEMS = option('items', 37000), FILMS = option('films', 3300), DECISIONS = option('decisions', 4400), LIMIT = option('limit', 24);
if (typeof global.gc !== 'function') {console.error('Run with node --expose-gc'); process.exit(2);}
const bundle = path.join(ROOT, 'dist/server/index.js');
if (!fs.existsSync(bundle)) {console.error('Run npm run build first'); process.exit(2);}

const RUN = 'profile-run', NOW = Date.parse('2026-11-04T18:00:00.000Z'), H = 3600000;
const words = ['агент', 'семья', 'город', 'тайна', 'дорога', 'ночь', 'война', 'любовь', 'побег', 'память', 'море', 'поезд'];
const text = (seed, length) => {let out = ''; for (let index = 0; out.length < length; index++) out += words[(seed * 7 + index * 3) % words.length] + ' '; return out.trim();};
const show = (seed, start) => ({channelId: 'ch' + (seed % 400), channel: 'Канал ' + (seed % 400), start, end: start + 2 * H, epgTitle: 'х/ф ' + text(seed, 20)});
// The ledger is built item by item into Buffers, so building it does not hold the whole document on the heap.
const decisions = {}, films = {}, keys = [], parts = [], observation = index => {
  const title = text(index, 18) + ' ' + index, year = 1950 + index % 75, start = NOW - (index % 96) * H;
  const shows = Array.from({length: 1 + index % 3}, (_, offset) => show(index + offset, start + offset * 24 * H));
  return {key: title + '|' + year, title, normalizedTitle: title, year, duration: 90 + index % 60, description: text(index, 300), firstAiring: start, lastAiring: start, airings: shows.length, rawTitles: [title, 'х/ф ' + title, title + ' (' + year + ')'], durations: [90 + index % 60], shows, seenInLatestSnapshot: true, lastSeenAt: start, lastSeenProgrammeRunId: RUN, ...(index < FILMS ? {confirmedTmdbId: String(500000 + index)} : {})};
};
parts.push(Buffer.from(JSON.stringify({programmeRunId: RUN, updatedAt: new Date(NOW).toISOString()}).slice(0, -1) + ',"items":['));
for (let index = 0; index < ITEMS; index++) {
  const item = observation(index);
  if (index < FILMS + DECISIONS) keys.push(item);
  parts.push(Buffer.from((index ? ',' : '') + JSON.stringify(item)));
}
parts.push(Buffer.from(']}'));
const ledgerBuffer = Buffer.concat(parts);
parts.length = 0;
for (let index = 0; index < FILMS; index++) films['tmdb_' + (500000 + index)] = {id: 'tmdb_' + (500000 + index), tmdbId: String(500000 + index), title: keys[index].title, original: keys[index].title, year: keys[index].year, runtime: 100, synopsis: text(index, 400), genres: ['Драма'], aliases: [keys[index].title], canonicalIdentity: 'tmdb:' + (500000 + index), shows: keys[index].shows, showsProgrammeRunId: RUN, directors: [{id: 'tmdb_director/' + index, name: 'Режиссёр ' + index}], actors: Array.from({length: 6}, (_, actor) => ({id: 'tmdb_actor/' + (index * 10 + actor), name: 'Актёр ' + actor}))};
for (let index = 0; index < Math.min(DECISIONS, ITEMS); index++) decisions[keys[index].key] = index < FILMS ? {status: 'verified', tmdbId: String(500000 + index), filmId: 'tmdb_' + (500000 + index), identitySource: 'tmdb_detail', checkedAt: new Date(NOW - 24 * H).toISOString()} : {status: 'no_confident_match', attempts: 1, checkedAt: new Date(NOW - 24 * H).toISOString(), retryAt: new Date(NOW - H).toISOString()};
keys.length = 0;

const store = new Map();
const put = (key, value) => store.set(key, {buf: Buffer.from(JSON.stringify(value)), meta: {}});
put('epg/published-generation.json', {phase: 'published', programmeRunId: RUN});
for (const key of ['epg/discovery-latest.json', 'epg/generations/' + RUN + '/discovery-latest.json']) store.set(key, {buf: ledgerBuffer, meta: {}});
for (const key of ['epg/discovered-films.json', 'epg/generations/' + RUN + '/discovered-films.json']) put(key, films);
put('epg/discovery-resolution.json', decisions);
const programme = {runId: RUN, updatedAt: new Date(NOW).toISOString(), films: []};
for (const key of ['programme.json', 'epg/generations/' + RUN + '/programme.json']) put(key, programme);
const sizes = {ledgerBytes: store.get('epg/discovery-latest.json').buf.length, catalogBytes: store.get('epg/discovered-films.json').buf.length, decisionsBytes: store.get('epg/discovery-resolution.json').buf.length};

let since = 0, peak = 0;
const sample = () => {const heap = process.memoryUsage().heapUsed; if (heap > since) since = heap; if (heap > peak) peak = heap; return heap;};
const etag = buf => {let hash = 2166136261; for (let index = 0; index < buf.length; index += 7) hash = Math.imul(hash ^ buf[index], 16777619); return (hash >>> 0).toString(16) + '-' + buf.length;};
const bucket = {
  // As an R2 object: a byte stream in 64 KiB chunks beside json() and text().
  async get(key) {
    sample(); const object = store.get(key); if (!object) return null;
    let offset = 0;
    const body = new ReadableStream({pull(controller) {if (offset >= object.buf.length) {controller.close(); return;} controller.enqueue(new Uint8Array(object.buf.subarray(offset, offset + 65536))); offset += 65536; sample();}});
    return {etag: etag(object.buf), customMetadata: {...object.meta}, body, json: async () => {const value = JSON.parse(object.buf.toString('utf8')); sample(); return value;}, text: async () => object.buf.toString('utf8')};
  },
  async head(key) {sample(); const object = store.get(key); return object ? {etag: etag(object.buf), customMetadata: {...object.meta}, size: object.buf.length} : null;},
  async put(key, body, options = {}) {
    sample();
    const buf = Buffer.from(typeof body === 'string' ? body : new Uint8Array(body)), current = store.get(key), only = options.onlyIf;
    if (only?.etagMatches !== undefined && (!current || etag(current.buf) !== only.etagMatches)) return null;
    if (only?.etagDoesNotMatch !== undefined && current && (only.etagDoesNotMatch === '*' || etag(current.buf) === only.etagDoesNotMatch)) return null;
    store.set(key, {buf, meta: {...(options.customMetadata || {})}}); sample(); return {key, etag: etag(buf)};
  },
  async delete(key) {store.delete(key);},
  async list() {throw new Error('the profile never lists');},
};
const clock = Date.now();
class ProfileDate extends Date {constructor(...values) {if (values.length) super(...values); else super(NOW + Date.now() - clock);} static now() {return NOW + Date.now() - clock;}}
const tmdb = async url => new Response(JSON.stringify(String(url).includes('/search/') ? {page: 1, results: [], total_pages: 1} : {}), {status: String(url).includes('/search/') ? 200 : 404});
const context = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, AbortController, Date: ProfileDate, Intl, Map, Set, WeakMap, JSON, Math, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Blob, FormData, ReadableStream, crypto: webcrypto, console: {log() {}, error() {}, warn() {}, info() {}}, setTimeout, clearTimeout, structuredClone, fetch: tmdb, atob, btoa, queueMicrotask, Promise});
vm.runInContext(fs.readFileSync(bundle, 'utf8').replace(/^export const /gm, 'const ').replace(/^export \{[^}]*\};?$/gm, '').replace('export default', 'globalThis.worker='), context, {filename: 'bundle.js'});
context.env = {BUCKET: bucket, TMDB_API_READ_ACCESS_TOKEN: 'profile', TMDB_REQUEST_INTERVAL_MS: 0, PUBLISHED_EPG_DB_OPTIONAL: 'standin'};
context.report = programme;
const MB = bytes => Math.round(bytes / 1048576);
const stages = [];
const mark = name => {const before = since; global.gc(); const heap = sample(); stages.push({stage: name, peakSinceMB: MB(before), retainedMB: MB(heap)}); since = heap;};
for (const name of ['saveDiscoveredFilms', 'releaseLedgerDetail', 'refreshPredictionQueue', 'saveScorePreview', 'saveObservationIndex']) {
  const original = context[name];
  if (typeof original !== 'function') continue;
  context[name] = async function (...values) {mark('enter ' + name); const result = await original.apply(this, values); mark('leave ' + name); return result;};
}
global.gc();
const start = sample(); since = start; peak = start;
const started = Date.now();
const summary = await vm.runInContext(`resolveDiscoveryBatch(env,report,${LIMIT})`, context);
mark('end');
console.log(JSON.stringify({items: ITEMS, films: FILMS, decisions: DECISIONS, ...Object.fromEntries(Object.entries(sizes).map(([key, value]) => [key.replace('Bytes', 'MB'), MB(value)])), startMB: MB(start), peakMB: MB(peak), peakAboveStartMB: MB(peak - start), ms: Date.now() - started, summary: {stage: summary.stage, checkpoint: summary.checkpoint ?? null, checked: summary.checked, touched: summary.touched, remaining: summary.remaining, tmdbCalls: summary.tmdbCalls, error: summary.error ?? null}, stages}, null, 1));
