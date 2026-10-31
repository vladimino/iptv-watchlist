// Feasibility probe of the archive preview route in the real Workers runtime (workerd under `wrangler dev --local`). Every
// object and archive is synthetic and sized like production; nothing here touches a remote account. Two steps:
//   node scripts/letterboxd-archive-probe.mjs seed --config <wrangler.json> --persist <dir>
//   node scripts/letterboxd-archive-probe.mjs run --url http://127.0.0.1:<port> [--pid <workerd pid>] [--inspector <ws url>]
//   node scripts/letterboxd-archive-probe.mjs bound [--caps 32,40,48]
// `seed` writes the synthetic R2 objects into the local persistence directory through wrangler's platform proxy; `run`
// posts each archive the way the page does and prints, per case, the status and wall time; with --pid the workerd
// process's CPU time; with --inspector (workerd's own inspector, ws://127.0.0.1:<port>/core:user:<worker>) the isolate's
// heap after a forced GC before the request, its peak while the request runs (sampled) and after a GC once it is done.
// Process RSS is not the isolate: V8 keeps freed pages and the local R2 simulator lives in the same process. Output is
// JSON with counts only.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {zipArchive, exportFiles} from '../tests/fixtures/letterboxd-archive.mjs';

const args = process.argv.slice(2), mode = args[0];
const option = name => {const at = args.indexOf('--' + name); return at > 0 ? args[at + 1] : null;};
const RUN = '11111111-1111-4111-8111-111111111111';
const NOW = Date.now(), DAY = 86400000;
const code = n => 'p' + n.toString(36);
const filler = (n, size) => ('Synopsis ' + n + ' ').repeat(Math.ceil(size / 12)).slice(0, size);

function storedFilm(n, size) {
  return {id: code(n), tmdbId: 100000 + n, title: 'Probe Film ' + n, original: 'Probe Film ' + n, titleRu: 'Пробный фильм ' + n, titleStatus: 'verified', year: 1950 + (n % 70), genres: ['Драма'], synopsis: filler(n, size), directors: [{name: 'Director ' + n}], actors: [{name: 'Actor ' + n}, {name: 'Actress ' + n}], shows: []};
}

// Production sizes from the evidence: programme about 2.2 MB, metadata.json about 1.2 MB, links.json about 25 KB with
// about 420 imported films, a films-list summary of the whole account and a watchlist summary.
// Production sizes from the evidence: programme about 2.2 MB, metadata.json about 1.2 MB, links.json about 25 KB with
// about 420 imported films, a films-list summary of the whole account and a watchlist summary.
function syntheticObjects() {
  const programmeFilms = Array.from({length: 1500}, (_, n) => storedFilm(n, 1300));
  const metadata = Object.fromEntries(Array.from({length: 1500}, (_, n) => [code(n + 1500), storedFilm(n + 1500, 650)]));
  const ratings = {ratings: Object.fromEntries(Array.from({length: 2400}, (_, n) => [code(n), ((n % 10) + 1) / 2]))};
  const objects = new Map(), links = {};
  const observed = new Date(NOW - 200 * DAY).toISOString();
  for (let n = 0; n < 420; n++) {
    const key = 'tmdb-' + (100000 + n);
    links['letterboxd:' + code(n)] = key; links['tmdb:' + (100000 + n)] = key;
    objects.set('letterboxd/facts/films/' + key + '.json', {schemaVersion: 1, factKey: key, links: {letterboxd: code(n), tmdb: String(100000 + n)}, redirectTo: null, migrating: null,
      watched: {value: true, effectiveOn: null, observedAt: observed, source: 'letterboxd_export', sourceRef: 'f'.repeat(64), observationId: 'a'.repeat(64)},
      rating: {value: ((n % 10) + 1) / 2, effectiveOn: null, observedAt: observed, source: 'letterboxd_export', sourceRef: 'f'.repeat(64), observationId: 'b'.repeat(64)}});
  }
  objects.set('epg/published-generation.json', {phase: 'published', programmeRunId: RUN, publishedAt: new Date(NOW - DAY).toISOString()});
  objects.set('epg/generations/' + RUN + '/programme.json', {runId: RUN, updatedAt: new Date(NOW - DAY).toISOString(), films: programmeFilms, people: {directors: [], actors: []}, stats: {}});
  objects.set('titles.json', {}); objects.set('people.json', {});
  objects.set('metadata.json', metadata);
  objects.set('enrichment/ratings/published.json', {projected: true, generationId: 'probe'});
  objects.set('enrichment/ratings/generations/probe.json', ratings);
  objects.set('letterboxd/facts/links.json', links);
  objects.set('letterboxd/facts/scans/films-list.json', {observedAt: new Date(NOW - 100 * DAY).toISOString(), scanId: 'probe', films: Object.fromEntries(Array.from({length: 2400}, (_, n) => [code(n), ((n % 10) + 1) / 2]))});
  objects.set('letterboxd/facts/scans/watchlist.json', {observedAt: new Date(NOW - 100 * DAY).toISOString(), scanId: 'probe', films: Array.from({length: 400}, (_, n) => code(n + 3000))});
  return objects;
}

async function seed() {
  const config = option('config'), persist = option('persist');
  if (!config || !persist) throw new Error('seed needs --config and --persist');
  const wrangler = option('wrangler') || path.resolve('/tmp/wrk/node_modules/wrangler/wrangler-dist/cli.js');
  const {getPlatformProxy} = await import(pathToFileURL(wrangler).href);
  const proxy = await getPlatformProxy({configPath: config, persist: {path: persist}, remoteBindings: false, envFiles: []});
  const bucket = proxy.env.BUCKET, objects = syntheticObjects(), sizes = {};
  for (const [key, value] of objects) await bucket.put(key, JSON.stringify(value));
  for (const key of ['epg/generations/' + RUN + '/programme.json', 'metadata.json', 'enrichment/ratings/generations/probe.json', 'letterboxd/facts/links.json', 'letterboxd/facts/scans/films-list.json']) sizes[key] = (await bucket.head(key)).size;
  await proxy.dispose();
  console.log(JSON.stringify({seeded: true, objects: objects.size, sizes}, null, 1));
}

// An upper bound independent of sampling: the same route in Node over the same objects, in a child whose V8 old space is
// capped. The smallest cap at which every case still answers bounds what the route needs on top of the modules.
async function bound() {
  const caps = (option('caps') || '32,40,48,56,64,80').split(',').map(Number);
  const rows = [];
  for (const cap of caps) {
    const child = spawnSync(process.execPath, ['--max-old-space-size=' + cap, '--max-semi-space-size=1', fileURLToPath(import.meta.url), 'bound-child'], {encoding: 'utf8'});
    rows.push({oldSpaceCapMiB: cap, ok: child.status === 0, result: child.status === 0 ? JSON.parse(child.stdout) : (child.stderr.match(/heap out of memory|Reached heap limit/) ? 'out_of_memory' : 'failed')});
  }
  console.log(JSON.stringify({runtime: 'node ' + process.version + ' vm, capped old space', rows}, null, 1));
}
async function boundChild() {
  const {loadArchiveWorker} = await import('../tests/fixtures/letterboxd-archive-worker.mjs');
  const objects = new Map([...syntheticObjects()].map(([key, value]) => [key, JSON.stringify(value)]));
  const bucket = {async get(key) {const text = objects.get(key); return text === undefined ? null : {etag: 'e', json: async () => JSON.parse(text), text: async () => text};}};
  const {worker} = loadArchiveWorker({now: NOW, console: {}, fetch: async () => {throw new Error('no fetch');}});
  const name = 'letterboxd-probe-' + new Date(NOW - 3 * DAY).toISOString().slice(0, 16).replace(/[T:]/g, '-') + '-utc.zip';
  const out = {};
  for (const [label, bytes] of cases()) {
    const form = new FormData();
    form.append('archive', new File([bytes], name));
    const encoded = new Request('http://encode/', {method: 'POST', body: form}), body = new Uint8Array(await encoded.arrayBuffer());
    const response = await worker.fetch(new Request('https://probe.test/api/admin/letterboxd-archive/preview', {method: 'POST', headers: {Origin: 'https://probe.test', 'Content-Type': encoded.headers.get('content-type'), 'Content-Length': String(body.length)}, body}), {BUCKET: bucket}, {});
    out[label] = response.status;
  }
  console.log(JSON.stringify(out));
}

function exportFilms(count, {offset = 0} = {}) {
  return Array.from({length: count}, (_, i) => {
    const n = offset + i;
    return {code: code(n), name: 'Probe Film ' + n, year: 1950 + (n % 70), watched: true, watchedDate: '2025-0' + (1 + (n % 9)) + '-1' + (n % 9), rating: n % 4 ? ((n % 10) + 1) / 2 : undefined, watchlist: n % 9 === 0, diary: n % 3 === 0 ? [{date: '2025-0' + (1 + (n % 9)) + '-0' + (1 + (n % 9)), rating: '3'}] : []};
  });
}
function archive(films, extra = []) {
  return zipArchive([{name: 'profile.csv', data: 'Date Joined,Username\n2015-01-01,probe\n'}, ...Object.entries(exportFiles(films)).map(([name, data]) => ({name, data})), ...extra]);
}
// The cases: a realistic account export, the largest export inside the limits, and refusals that must stay cheap.
function cases() {
  const realistic = archive(exportFilms(2400));
  // Just under the row limit in every imported file, with a long random title past the first 3000 films so nothing
  // compresses well, and a diary entry on every other film.
  const big = Array.from({length: 9990}, (_, n) => ({code: code(n), name: n < 3000 ? 'Probe Film ' + n : 'Probe Film ' + n + ' ' + randomBytes(30).toString('hex'), year: 1950 + (n % 70), watched: true, watchedDate: '2025-01-01', rating: ((n % 10) + 1) / 2, watchlist: n % 2 === 0, diary: n % 2 ? [] : [{date: '2025-01-01', rating: '3'}]}));
  const worst = archive(big, [{name: 'reviews.csv', data: randomBytes(900 * 1024), method: 0}]);
  const bomb = zipArchive([{name: 'watched.csv', data: Buffer.alloc(4 * 1024 * 1024 - 1)}]);
  const padded = zipArchive([...Object.entries(exportFiles(exportFilms(50))).map(([name, data]) => ({name, data})), {name: 'padding.bin', data: randomBytes(10 * 1024 * 1024 - 64 * 1024), method: 0}]);
  const many = zipArchive([...Object.entries(exportFiles(exportFilms(50))).map(([name, data]) => ({name, data})), ...Array.from({length: 1990}, (_, i) => ({name: 'deleted/d' + i + '.csv', data: 'x', method: 0}))]);
  return [['realistic', realistic], ['worst_case', worst], ['bomb_refused', bomb], ['padded_10mib', padded], ['entries_2000', many]];
}

async function inspector(url) {
  if (!url) return null;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {ws.onopen = resolve; ws.onerror = reject;});
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
    if (message.id && pending.has(message.id)) {pending.get(message.id)(message.result || message.error); pending.delete(message.id);}
  };
  const call = (method, params = {}) => new Promise(resolve => {const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({id: n, method, params}));});
  await call('Runtime.enable'); await call('HeapProfiler.enable');
  const MiB = n => Math.round(n / 1048576 * 10) / 10;
  const usage = async () => {const u = await call('Runtime.getHeapUsage'); return {used: u.usedSize, total: u.totalSize, buffers: u.backingStorageSize ?? 0};};
  return {
    // workerd runs an inspector GC only under the isolate lock, so a GET the route refuses (405, no read) carries it.
    async settled(base) {const gc = call('HeapProfiler.collectGarbage'); await fetch(base + '/api/admin/letterboxd-archive/preview').then(r => r.arrayBuffer()); await gc; const u = await usage(); return {usedMiB: MiB(u.used), buffersMiB: MiB(u.buffers)};},
    // Samples the heap until `promise` settles; returns the peaks.
    async during(promise) {
      let done = false, peak = {used: 0, total: 0, buffers: 0, sum: 0}, samples = 0;
      promise.finally(() => {done = true;});
      while (!done) {
        const u = await usage(); samples++;
        peak = {used: Math.max(peak.used, u.used), total: Math.max(peak.total, u.total), buffers: Math.max(peak.buffers, u.buffers), sum: Math.max(peak.sum, u.used + u.buffers)};
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return {samples, peakUsedMiB: MiB(peak.used), peakHeapTotalMiB: MiB(peak.total), peakBuffersMiB: MiB(peak.buffers), peakUsedPlusBuffersMiB: MiB(peak.sum)};
    },
    close() {ws.close();},
  };
}

function processStats(pid) {
  if (!pid) return null;
  const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
  const field = name => Number((status.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm')) || [])[1]) / 1024;
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ');
  const ticks = Number(stat[11]) + Number(stat[12]);
  return {rssMiB: Math.round(field('VmRSS')), hwmMiB: Math.round(field('VmHWM')), cpuMs: ticks * 10};
}

async function run() {
  const base = option('url') || 'http://127.0.0.1:8799', pid = option('pid') ? Number(option('pid')) : null;
  const heap = await inspector(option('inspector'));
  const name = 'letterboxd-probe-' + new Date(NOW - 3 * DAY).toISOString().slice(0, 16).replace(/[T:]/g, '-') + '-utc.zip';
  const results = [];
  for (const [label, bytes] of cases()) {
    for (let round = 0; round < (label === 'worst_case' || label === 'realistic' ? 3 : 1); round++) {
      const before = processStats(pid), form = new FormData();
      form.append('archive', new File([bytes], name, {type: 'application/zip'}));
      const encoded = new Request('http://encode/', {method: 'POST', body: form}), body = new Uint8Array(await encoded.arrayBuffer());
      const settledBefore = heap ? await heap.settled(base) : null;
      const started = performance.now();
      const request = fetch(base + '/api/admin/letterboxd-archive/preview', {method: 'POST', headers: {Origin: base, 'Content-Type': encoded.headers.get('content-type'), 'Content-Length': String(body.length)}, body});
      const sampled = heap ? heap.during(request) : null;
      const response = await request;
      const answer = await response.json();
      const wallMs = Math.round(performance.now() - started), after = processStats(pid);
      const isolate = heap ? {before: settledBefore, ...(await sampled), after: await heap.settled(base)} : null;
      results.push({case: label, round, archiveBytes: bytes.length, status: response.status, error: answer.error ?? null, code: answer.code ?? null, wallMs,
        films: answer.export?.films ?? null, accepted: answer.proposal?.films?.accepted ?? null, recordReads: answer.proposal?.recordReads ?? null, responseBytes: JSON.stringify(answer).length,
        isolate, workerd: before && after ? {cpuMs: after.cpuMs - before.cpuMs, rssBeforeMiB: before.rssMiB, rssAfterMiB: after.rssMiB, hwmMiB: after.hwmMiB} : null});
    }
  }
  if (heap) heap.close();
  console.log(JSON.stringify({runtime: 'workerd (wrangler dev --local)', results}, null, 1));
}

if (mode === 'seed') await seed();
else if (mode === 'run') await run();
else if (mode === 'bound') await bound();
else if (mode === 'bound-child') await boundChild();
else {console.error('usage: seed --config <file> --persist <dir> | run --url <url> [--pid <workerd pid>] [--inspector <ws url>] | bound [--caps 32,48,64]'); process.exit(2);}
