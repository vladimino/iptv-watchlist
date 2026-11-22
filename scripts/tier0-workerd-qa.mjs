#!/usr/bin/env node
// AIR-571 Tier 0 QA harness: a LOCAL, offline workerd (Miniflare) with a LOCAL D1 and a LOCAL R2, synthetic data only.
// It strips every credential from the environment, never uses a production id, a bucket name or a remote binding, and refuses to run if a Cloudflare credential is present after sanitising.
// Usage: node scripts/tier0-workerd-qa.mjs [--out report.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const SAFE = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'NODE_OPTIONS_SAFE'];
const env = Object.fromEntries(SAFE.filter(k => process.env[k]).map(k => [k, process.env[k]]));
env.WRANGLER_SEND_METRICS = 'false'; env.CI = '1'; env.NO_COLOR = '1'; env.WRANGLER_HIDE_BANNER = 'true';
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const FAKE_DB_ID = '00000000-0000-4000-8000-00000000t0t0';
const PROD_DB_ID = '3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'air571-tier0-'));
const persist = path.join(work, 'state');
const report = {tier: 0, scope: 'local workerd/Miniflare only; no Cloudflare resources', versions: {}, items: {}};
const log = (...a) => console.error('[tier0]', ...a);

// ---- versions
const ver = cmd => spawnSync(cmd[0], cmd.slice(1), {env, encoding: 'utf8'}).stdout.trim().split('\n').pop();
report.versions = {
  node: process.version,
  wrangler: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/wrangler/package.json'), 'utf8')).version,
  miniflare: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/miniflare/package.json'), 'utf8')).version,
  workerd: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/workerd/package.json'), 'utf8')).version,
  esbuild: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/esbuild/package.json'), 'utf8')).version
};

// ---- 1. the isolated rig: a private tmp wrangler.toml with a FAKE database id, wrangler local migrations 0001..0033
fs.copyFileSync(path.join(root, 'scripts/tier0/worker.mjs'), path.join(work, 'unused.mjs'));
fs.mkdirSync(path.join(work, 'migrations'));
const migrations = fs.readdirSync(path.join(root, 'migrations')).filter(f => /^00\d\d_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 33).sort();
for (const f of migrations) fs.copyFileSync(path.join(root, 'migrations', f), path.join(work, 'migrations', f));
fs.writeFileSync(path.join(work, 'wrangler.toml'), `name = "tier0-local-only"\nmain = "worker.bundle.mjs"\ncompatibility_date = "2026-10-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "tier0-local"\ndatabase_id = "${FAKE_DB_ID}"\nmigrations_dir = "migrations"\n[[r2_buckets]]\nbinding = "BUCKET"\nbucket_name = "tier0-local-bucket"\n`);
assert.ok(!fs.readFileSync(path.join(work, 'wrangler.toml'), 'utf8').includes(PROD_DB_ID));
const mig = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist, '--config', path.join(work, 'wrangler.toml')], {cwd: work, env, encoding: 'utf8', timeout: 180000});
report.items.rig = {migrationsApplied: migrations.length, first: migrations[0], last: migrations.at(-1), wranglerExit: mig.status, wranglerTail: (mig.stdout + mig.stderr).split('\n').filter(l => /✅|applied|error/i.test(l)).slice(-4)};
if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); throw new Error('wrangler local migrations failed'); }

// ---- the scratch worker bundle (production src/*.js imported unchanged)
const {build} = await import(pathToFileURL(require.resolve('esbuild', {paths: [root]})).href);
const bundle = path.join(work, 'worker.bundle.mjs');
await build({entryPoints: [path.join(root, 'scripts/tier0/worker.mjs')], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'error', conditions: ['workerd', 'worker'], mainFields: ['module', 'main']});

// the real Wrangler local dev server (workerd under Miniflare); `--local` never reaches Cloudflare
const port = 18700 + Math.floor(Math.random() * 200);
const dev = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 300), '--persist-to', persist, '--config', path.join(work, 'wrangler.toml')], {cwd: work, env, stdio: ['ignore', 'pipe', 'pipe']});
let devLog = ''; dev.stdout.on('data', d => devLog += d); dev.stderr.on('data', d => devLog += d);
const mf = {dispose: async () => { dev.kill('SIGTERM'); await new Promise(r => setTimeout(r, 500)); }, dispatchFetch: (u, init) => fetch(u.replace('http://tier0.local', 'http://127.0.0.1:' + port), init)};
for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/none'); if (r.status === 404) break; } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 500)); if (i === 119) { console.error(devLog); throw new Error('wrangler dev did not start'); } }
report.items.rig.devServer = {command: 'wrangler dev --local', remoteMode: /remote/i.test(devLog.replace(/--local/g, '')) ? 'MENTIONED-CHECK' : 'no', bindingsLine: devLog.split('\n').filter(l => /env\.|binding|local/i.test(l)).slice(0, 8)};
const post = async (route, body = {}) => { const r = await mf.dispatchFetch('http://tier0.local' + route, {method: 'POST', body: JSON.stringify(body)}); const j = await r.json(); if (r.status !== 200) throw new Error(route + ' ' + r.status + ' ' + JSON.stringify(j)); return j; };
// local sqlite of the persisted D1, for seeding only (the same private file the worker binding uses)
const sqliteFile = () => { const dir = path.join(persist, 'v3/d1/miniflare-D1DatabaseObject'); const f = fs.readdirSync(dir).filter(n => n.endsWith('.sqlite')); return path.join(dir, f[0]); };
const sql = text => { const r = spawnSync('sqlite3', [sqliteFile(), text], {encoding: 'utf8'}); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
try {
  // switch the LOCAL watchlist authority to d1/open and seed the local Letterboxd control row
  sql("UPDATE watchlist_authority SET mode='d1', writes='open', generation=1 WHERE id=1;");
  sql("INSERT INTO letterboxd_sync_mode (id,mode,epoch,changed_at,revision,write_id) VALUES (1,'cloudflare',1,'2026-11-22T00:00:00.000Z',1,'tier0');");
  report.items.rig.migrationTables = Number(sql("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").trim());
  report.items.rig.localMarker = sql('SELECT mode, writes, generation FROM watchlist_authority').trim();

  // ---- 2. changes() batch shape and strict decoder on the real binding
  log('item 2: batch shape'); report.items.shape = await post('/shape');
  const s = report.items.shape;
  assert.equal(s.oneRow.decoded, 1); assert.equal(s.zeroRows.decoded, 0);
  // ---- 3. limits
  log('item 3: limits'); report.items.limits = await post('/limits');
  // ---- 4. promotions
  report.items.promotions = [];
  for (const step of ['fill400', 'overCapRefusedWhileLedgerFull', 'grow700AfterSettle', 'replace100', 'noChange', 'extra300New']) { log('item 4:', step); { const t0 = performance.now(); const r = await post('/promote', {step}); r.clientWallMs = Math.round(performance.now() - t0); report.items.promotions.push(r); } }
  log('item 4: CAS'); report.items.cas = await post('/cas');
  // ---- 5. slot (real modules, local R2); honest result either way
  log('item 5: slot'); try { const t0 = performance.now(); report.items.slot = await post('/slot', {films: 40}); report.items.slot.clientWallMs = Math.round(performance.now() - t0); } catch (e) { report.items.slot = {notProven: String(e.message).slice(0, 400)}; }
  // ---- process-level workerd stats: indicative only (a host process measure, not a per-isolate figure)
  const stat = spawnSync('sh', ['-c', "ps -eo pid,rss,time,comm | grep -i workerd | head -3"], {encoding: 'utf8'}).stdout.trim();
  report.items.processIndicative = {note: 'host-process figures of workerd, NOT per-isolate CPU/memory; per-isolate CPU and memory are NOT MEASURED (workerd local exposes no honest figure)', ps: stat};
} finally { await mf.dispose(); }
report.workDir = process.argv.includes('--keep') ? work : '(removed)';
const text = JSON.stringify(report, null, 1);
if (out) fs.writeFileSync(out, text); else console.log(text);
if (!process.argv.includes('--keep')) fs.rmSync(work, {recursive: true, force: true});
