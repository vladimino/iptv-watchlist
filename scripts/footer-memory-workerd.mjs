// AIR-519. The footer's heap in workerd itself: the fixtures of scripts/footer-memory-profile.mjs are loaded into a local D1 and R2 (wrangler --local,
// nothing remote), the checkout's deployed bundle runs under `wrangler dev`, and the isolate's heap is read through the inspector
// (Runtime.getHeapUsage) while C footer requests run at once. Synthetic data only; no production binding, credential or route is used.
//   node scripts/footer-memory-workerd.mjs [--checkout DIR] [--fixtures DIR] [--concurrent 1,2,4] [--rounds 3] [--port 8799] [--inspector 9239]
// The checkout must be built (`npm run build`). Prints the heap of the fresh isolate (the module alone), then per concurrency the highest used and
// committed heap the inspector saw while the requests ran, and their statuses. Run one concurrency per invocation for a fresh isolate each time.
// Local workerd enforces no memory limit and the inspector cannot force a GC there, so these are the version-to-version figures in workerd itself;
// the hard cap is measured by footer-memory-profile.mjs under --max-old-space-size with the same bundle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';

const arg = (name, fallback) => {const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback;};
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const checkout = path.resolve(arg('checkout', repo)), FIX = arg('fixtures', path.join(os.tmpdir(), 'air519-fixtures'));
const levels = String(arg('concurrent', '1,2,4')).split(',').map(Number), rounds = Number(arg('rounds', 3));
const port = Number(arg('port', 8799)), inspector = Number(arg('inspector', 9239));
const wrangler = path.join(repo, 'node_modules/.bin/wrangler');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'air519-workerd-')), persist = path.join(state, 'persist'), config = path.join(state, 'wrangler.json');
const env = {...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: ''};
fs.writeFileSync(config, JSON.stringify({name: 'iptv-footer-memory', main: path.join(checkout, 'dist/server/index.js'), compatibility_date: '2026-10-18', vars: {PREDICTION_DB_REQUIRED: 'on', RATINGS_DB_REQUIRED: 'on'}, d1_databases: [{binding: 'DB', database_name: 'iptv', database_id: '00000000-0000-4000-8000-000000000519'}], r2_buckets: [{binding: 'BUCKET', bucket_name: 'iptv'}]}));
const run = (args, label) => {const r = spawnSync(wrangler, args, {cwd: state, env, encoding: 'utf8', maxBuffer: 1 << 26}); if (r.status !== 0) throw new Error(label + ': ' + (r.stderr || r.stdout).slice(-800)); return r.stdout;};

// D1: the fixture database as SQL (wrangler d1 execute --local runs it in its own transaction).
const dump = spawnSync('sqlite3', [path.join(FIX, 'd1.sqlite'), '.dump'], {encoding: 'utf8', maxBuffer: 1 << 28}).stdout
  .split('\n').filter(line => !/^(BEGIN TRANSACTION|COMMIT|PRAGMA)/.test(line) && !/^INSERT INTO sqlite_sequence/.test(line) && !/^DELETE FROM sqlite_sequence/.test(line)).join('\n');
fs.writeFileSync(path.join(state, 'd1.sql'), 'PRAGMA defer_foreign_keys=on;\n' + dump);
run(['d1', 'execute', 'iptv', '--local', '--persist-to', persist, '--config', config, '--file', path.join(state, 'd1.sql'), '--yes'], 'd1 load');
// R2: every fixture object.
for (const key of JSON.parse(fs.readFileSync(path.join(FIX, 'r2.json'), 'utf8'))) run(['r2', 'object', 'put', 'iptv/' + key, '--file', path.join(FIX, encodeURIComponent(key)), '--local', '--persist-to', persist, '--config', config], 'r2 put ' + key);

const dev = spawn(wrangler, ['dev', '--config', config, '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', persist, '--show-interactive-dev-session', 'false'], {cwd: state, env, stdio: ['ignore', 'pipe', 'pipe']});
let log = ''; dev.stdout.on('data', d => {log += d;}); dev.stderr.on('data', d => {log += d;});
const stop = () => {try {dev.kill('SIGINT');} catch {} };
process.on('exit', () => {stop(); fs.rmSync(state, {recursive: true, force: true});});
for (let i = 0; i < 600 && !/Ready on/.test(log); i++) await new Promise(r => setTimeout(r, 200));
if (!/Ready on/.test(log)) {console.error(log.slice(-2000)); process.exit(1);}
const url = `http://127.0.0.1:${port}/api/enrichment/footer/status`;
const targets = await (await fetch(`http://127.0.0.1:${inspector}/json`)).json();
// The wrangler inspector proxy accepts DevTools origins only.
const socket = new WebSocket(targets[0].webSocketDebuggerUrl, {headers: {Origin: 'https://devtools.devprod.cloudflare.dev'}});
await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = event => reject(new Error('inspector: ' + (event?.message || 'connection failed')));});
let id = 0; const waiting = new Map();
socket.onmessage = event => {const message = JSON.parse(event.data); if (message.id && waiting.has(message.id)) {waiting.get(message.id)(message.result || message.error); waiting.delete(message.id);}};
// Local workerd answers HeapProfiler.collectGarbage with nothing, so no forced GC is used: the figures include garbage V8 has not collected yet,
// and V8 without a heap limit collects lazily. They compare two versions on the same isolate; the hard cap is measured in footer-memory-profile.mjs.
const call = (method, params = {}) => new Promise(resolve => {const n = ++id; const timer = setTimeout(() => {waiting.delete(n); resolve(null);}, 5000); waiting.set(n, value => {clearTimeout(timer); resolve(value);}); socket.send(JSON.stringify({id: n, method, params}));});
const heap = async () => {const r = await call('Runtime.getHeapUsage'); return r ? {used: r.usedSize, total: r.totalSize} : null;};
const mb = bytes => +(bytes / 1048576).toFixed(1);
// The isolate exists before the first request; its heap then is the module (bundle, dictionaries, assets) alone.
const fresh = await heap();
console.log(JSON.stringify({checkout: path.basename(checkout), freshIsolateUsedMiB: fresh && mb(fresh.used), freshIsolateCommittedMiB: fresh && mb(fresh.total)}));
for (const concurrent of levels) {
  let peakUsed = 0, peakTotal = 0; const statuses = [], walls = [];
  for (let round = 0; round < rounds; round++) {
    let running = true;
    const sampler = (async () => {while (running) {const h = await heap(); if (h) {peakUsed = Math.max(peakUsed, h.used); peakTotal = Math.max(peakTotal, h.total);} await new Promise(r => setTimeout(r, 10));}})();
    const t0 = Date.now();
    const answers = await Promise.all(Array.from({length: concurrent}, () => fetch(url).then(async r => {await r.text(); return r.status;}).catch(() => 'error')));
    walls.push(Date.now() - t0);
    running = false; await sampler;
    statuses.push(...answers);
  }
  console.log(JSON.stringify({checkout: path.basename(checkout), concurrent, rounds, statuses, wallMs: walls, peakUsedMiB: mb(peakUsed), peakCommittedMiB: mb(peakTotal)}));
}
socket.close(); stop();
setTimeout(() => process.exit(0), 500);
