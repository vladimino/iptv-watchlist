// AIR-378: the bounded parallel test runner never loses a file, names every failure, bounds concurrency, runs serial-only files alone and
// leaves no orphan children. It is exercised against small synthetic test directories, never against the real suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

const runner = path.resolve('scripts/run-tests.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'air378-runner-'));
let counter = 0;

function suite(files) {
  const directory = path.join(root, 'suite-' + (++counter));
  fs.mkdirSync(directory);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), body);
  return directory;
}
function run(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [runner, ...args], {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...env}});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => {stdout += chunk;});
    child.stderr.on('data', chunk => {stderr += chunk;});
    child.on('close', (code, signal) => resolve({code, signal, stdout, stderr}));
  });
}
// A killed process whose parent never reaps it (PID 1 in a container) stays as a zombie: it is dead, not running.
const alive = pid => {
  try {process.kill(pid, 0);} catch {return false;}
  try {return fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[0] !== 'Z';} catch {return true;}
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  // 1. Everything passes: every file runs once, its own output is kept, the summary counts files, exit 0.
  {
    const dir = suite({
      'a.mjs': "console.log('alpha passed');",
      'b.mjs': "console.log('beta passed');",
      'c.txt': 'not a test',
      'names.mjs': "throw new Error('fixture-dependent files are excluded by name')",
    });
    const result = await run(['--dir', dir, '--jobs', '2']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ok   a\.mjs/);
    assert.match(result.stdout, /alpha passed/);
    assert.match(result.stdout, /beta passed/);
    assert.match(result.stdout, /Passed 2 self-contained test files\./);
    assert.match(result.stdout, /Slowest files:/);
    assert.doesNotMatch(result.stdout + result.stderr, /names\.mjs/, 'the fixture-dependent exclusion list is kept');
  }

  // 2. A failing file is named with its exit code and its full stdout and stderr; the run exits non-zero; the other running files finish.
  {
    const dir = suite({
      'a-ok.mjs': "await new Promise(r => setTimeout(r, 300)); console.log('slow sibling finished');",
      'b-fail.mjs': "console.log('before the failure'); console.error('the assertion that failed'); process.exit(3);",
    });
    const result = await run(['--dir', dir, '--jobs', '2']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAIL b-fail\.mjs \([\d.]+s\): exit code 3/);
    assert.match(result.stderr, /before the failure/);
    assert.match(result.stderr, /the assertion that failed/);
    assert.match(result.stderr, /FAILED 1 of 2 files: b-fail\.mjs/);
    assert.match(result.stdout, /slow sibling finished/, 'a file that was already running is allowed to finish and is reported');
    assert.doesNotMatch(result.stdout, /Passed \d+ self-contained/, 'no false green');
  }

  // 3. After the first failure no new file is started and the skipped ones are counted.
  {
    const dir = suite({
      'a-fail.mjs': 'process.exit(1);',
      'b.mjs': "console.log('must not run');",
      'c.mjs': "console.log('must not run');",
    });
    const result = await run(['--dir', dir, '--serial']);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /must not run/);
    assert.match(result.stderr, /2 not started after the first failure/);
  }

  // 4. A file killed by a signal is a failure that names the signal.
  {
    const dir = suite({'a-signal.mjs': "process.kill(process.pid, 'SIGKILL'); await new Promise(r => setTimeout(r, 5000));"});
    const result = await run(['--dir', dir, '--jobs', '2']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAIL a-signal\.mjs \([\d.]+s\): killed by signal SIGKILL/);
  }

  // 5. A hung file times out, is reported, and nothing it spawned is left running.
  {
    const pidFile = path.join(root, 'orphan.pid');
    const dir = suite({
      'a-hang.mjs': `import {spawn} from 'node:child_process'; import fs from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);`,
    });
    const result = await run(['--dir', dir, '--jobs', '2', '--timeout-ms', '800']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAIL a-hang\.mjs \([\d.]+s\): timed out after 800ms/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await sleep(300);
    assert.equal(alive(pid), false, 'the grandchild of a timed-out file is not left running');
  }

  // 6. Concurrency is bounded by --jobs and really used.
  {
    const log = path.join(root, 'concurrency');
    fs.mkdirSync(log);
    const body = `import fs from 'node:fs'; import path from 'node:path';
const dir = ${JSON.stringify(log)}, me = path.join(dir, String(process.pid));
fs.writeFileSync(me, '');
const now = fs.readdirSync(dir).length;
fs.appendFileSync(path.join(dir, 'max.log'), now + '\\n');
await new Promise(r => setTimeout(r, 400));
fs.unlinkSync(me);`;
    const files = Object.fromEntries(Array.from({length: 8}, (_, i) => [`f${i}.mjs`, body]));
    for (const jobs of [1, 3]) {
      fs.rmSync(path.join(log, 'max.log'), {force: true});
      const result = await run(['--dir', suite(files), '--jobs', String(jobs)]);
      assert.equal(result.code, 0, result.stderr);
      const seen = fs.readFileSync(path.join(log, 'max.log'), 'utf8').trim().split('\n').map(Number);
      // max.log itself is a directory entry, so the count includes it after the first write.
      const concurrent = Math.max(...seen.map(count => count - 1));
      assert.ok(concurrent <= jobs, `jobs ${jobs}: at most ${jobs} at once, saw ${concurrent}`);
      if (jobs > 1) assert.ok(concurrent >= 2, `jobs ${jobs}: files really run in parallel, saw ${concurrent}`);
      assert.match(result.stdout, /Passed 8 self-contained test files\./);
    }
  }

  // 7. Serial-only files run alone, after the parallel phase.
  {
    const log = path.join(root, 'serial.log');
    const stamp = tag => `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, '${tag} start ' + Date.now() + '\\n'); await new Promise(r => setTimeout(r, 300)); fs.appendFileSync(${JSON.stringify(log)}, '${tag} end ' + Date.now() + '\\n');`;
    const dir = suite({'a-par.mjs': stamp('par1'), 'b-par.mjs': stamp('par2'), 'c-serial.mjs': stamp('serial'), 'd-par.mjs': stamp('par3')});
    const result = await run(['--dir', dir, '--jobs', '4', '--serial-only', 'c-serial.mjs']);
    assert.equal(result.code, 0, result.stderr);
    const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => {const [tag, kind, at] = line.split(' '); return {tag, kind, at: Number(at)};});
    const serial = {start: events.find(e => e.tag === 'serial' && e.kind === 'start').at, end: events.find(e => e.tag === 'serial' && e.kind === 'end').at};
    for (const e of events.filter(e => e.tag !== 'serial' && e.kind === 'end')) assert.ok(e.at <= serial.start, 'the serial-only file starts after every parallel file has finished');
    assert.match(result.stdout, /1 serial-only/);
  }

  // 8. --serial runs in plain name order, one at a time.
  {
    const log = path.join(root, 'order.log');
    const note = tag => `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, '${tag}\\n');`;
    const dir = suite({'c.mjs': note('c'), 'a.mjs': note('a'), 'b.mjs': note('b')});
    const result = await run(['--dir', dir, '--serial']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(log, 'utf8'), 'a\nb\nc\n');
    assert.match(result.stdout, /serial/);
  }

  // 9. Bad options are refused before anything runs.
  {
    const dir = suite({'a.mjs': "console.log('x');"});
    for (const args of [['--jobs', '0'], ['--jobs', 'two'], ['--timeout-ms', '-5']]) {
      const result = await run(['--dir', dir, ...args]);
      assert.equal(result.code, 2, args.join(' '));
      assert.doesNotMatch(result.stdout, /ok   a\.mjs/);
    }
  }

  // 10. The default concurrency is bounded and at least one.
  {
    const dir = suite({'a.mjs': "console.log('x');"});
    const result = await run(['--dir', dir]);
    assert.match(result.stdout, /up to [1-4] at a time|serial/);
  }

  // 11. A GitHub step summary is written when the variable is set.
  {
    const summary = path.join(root, 'summary.md');
    const dir = suite({'a.mjs': "console.log('x');"});
    const result = await run(['--dir', dir, '--jobs', '2'], {GITHUB_STEP_SUMMARY: summary});
    assert.equal(result.code, 0, result.stderr);
    assert.match(fs.readFileSync(summary, 'utf8'), /### Test runner[\s\S]*1 of 1 files run, jobs 2[\s\S]*\| a\.mjs \|/);
  }
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}

console.log('Test runner: output kept per file, exit code, signal and timeout named, no new file after a failure, no orphan, bounded concurrency, serial-only files alone, name order with --serial and bad options refused passed');
