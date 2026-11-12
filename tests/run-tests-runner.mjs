// AIR-378: the bounded parallel test runner never loses a file, names every failure, bounds concurrency, runs serial-only files alone and
// leaves no orphan children. It is exercised against small synthetic test directories, never against the real suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DEFAULT_WEIGHT, WEIGHTS, capture, HEAD_LIMIT, TAIL_LIMIT, parseShard, planTests} from '../scripts/run-tests.mjs';

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

// 0. The bounded capture, directly, at its exact boundaries. Nothing is cut up to HEAD_LIMIT + TAIL_LIMIT characters; one more character
// (however the stream was chunked, and also when it ends right after the tail was trimmed) keeps the beginning and the end and says how much
// is missing.
{
  const notice = /\n\.\.\. \[(\d+) characters omitted\] \.\.\.\n/;
  const text = (chunks) => {const c = capture(); for (const chunk of chunks) c.push(chunk); return c;};
  const at = (n) => 'a'.repeat(n);
  // exactly full: no notice, nothing omitted
  let c = text([at(HEAD_LIMIT + TAIL_LIMIT)]);
  assert.equal(c.omitted(), 0);
  assert.equal(c.text().length, HEAD_LIMIT + TAIL_LIMIT);
  assert.doesNotMatch(c.text(), notice);
  // one character over: the notice appears with the right count
  c = text([at(HEAD_LIMIT + TAIL_LIMIT + 1)]);
  assert.equal(c.omitted(), 1);
  assert.equal(notice.exec(c.text())[1], '1');
  // the trim boundary: the tail reaches 2 * TAIL_LIMIT + 1, is cut to exactly TAIL_LIMIT, and the stream ends right there
  c = text([at(HEAD_LIMIT), at(2 * TAIL_LIMIT + 1)]);
  assert.equal(c.omitted(), TAIL_LIMIT + 1, 'the dropped characters are counted although the tail is exactly TAIL_LIMIT');
  assert.ok(notice.test(c.text()), 'the separator is present right after a trim, although the tail is exactly TAIL_LIMIT');
  assert.equal(notice.exec(c.text())[1], String(TAIL_LIMIT + 1));
  assert.equal(c.text().length, HEAD_LIMIT + TAIL_LIMIT + c.text().match(notice)[0].length);
  // exactly 2 * TAIL_LIMIT in the tail does not trim yet: omitted is TAIL_LIMIT and the notice says so
  c = text([at(HEAD_LIMIT), at(2 * TAIL_LIMIT)]);
  assert.equal(c.omitted(), TAIL_LIMIT);
  assert.equal(notice.exec(c.text())[1], String(TAIL_LIMIT));
  // property: for any chunking, head + notice + tail covers the stream, the head is its start and the tail is its end
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const total of [10, HEAD_LIMIT - 1, HEAD_LIMIT, HEAD_LIMIT + 1, HEAD_LIMIT + TAIL_LIMIT - 1, HEAD_LIMIT + TAIL_LIMIT, HEAD_LIMIT + TAIL_LIMIT + 1, HEAD_LIMIT + 2 * TAIL_LIMIT, HEAD_LIMIT + 2 * TAIL_LIMIT + 1, HEAD_LIMIT + 5 * TAIL_LIMIT + 7]) {
    const stream = Array.from({length: total}, (_, i) => String.fromCharCode(97 + (i * 7 + (i >> 11)) % 26)).join('');
    for (const sizes of [[total], [1 << 16], [4097], [1 + Math.floor(random() * 3000000)]]) {
      const parts = []; let offset = 0, k = 0;
      while (offset < total) {const size = Math.max(1, sizes[k++ % sizes.length]); parts.push(stream.slice(offset, offset + size)); offset += size;}
      const result = text(parts), out = result.text(), lost = result.omitted();
      const label = `total ${total}, chunks ${sizes[0]}`;
      assert.equal(lost, Math.max(0, total - HEAD_LIMIT - TAIL_LIMIT), label);
      if (lost === 0) {assert.equal(out, stream, label); continue;}
      const found = notice.exec(out);
      assert.ok(found, label + ': the cut is marked');
      assert.equal(Number(found[1]), lost, label);
      assert.equal(out.slice(0, HEAD_LIMIT), stream.slice(0, HEAD_LIMIT), label + ': the beginning is kept');
      assert.equal(out.slice(-TAIL_LIMIT), stream.slice(-TAIL_LIMIT), label + ': the end is kept');
      assert.equal(HEAD_LIMIT + lost + TAIL_LIMIT, total, label + ': kept plus omitted is the whole stream');
    }
  }
}

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

  // 2b. A noisy failing file keeps the beginning and the END of each stream (the assertion that matters is last) and says what was omitted.
  {
    const noisy = (stream, marker) => `{ const line = 'x'.repeat(99) + '\\n'; let out = '${marker}-first\\n';
for (let i = 0; i < 70000; i++) out += line; // about 7 MB, well over the capture limit
process.${stream}.write(out + '${marker}-LAST-LINE\\n'); }`;
    const dir = suite({'a-noisy.mjs': noisy('stdout', 'OUT') + '\n' + noisy('stderr', 'ERR') + '\nprocess.exitCode = 1; // not process.exit(): that would cut the output still in the pipe'});
    const result = await run(['--dir', dir, '--jobs', '2']);
    assert.equal(result.code, 1);
    for (const marker of ['OUT-first', 'OUT-LAST-LINE', 'ERR-first', 'ERR-LAST-LINE']) assert.ok(result.stderr.includes(marker), marker + ' is shown');
    assert.match(result.stderr, /characters omitted\] \.\.\./, 'the cut is marked inside the stream');
    assert.match(result.stderr, /characters from the middle of the output of a-noisy\.mjs were omitted; the beginning and the end are shown/);
    assert.ok(result.stderr.length < 9 * 1024 * 1024, 'the report itself stays bounded');
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
    assert.match(result.stdout, /up to [1-6] at a time|serial/);
  }

  // 11. A GitHub step summary is written when the variable is set.
  {
    const summary = path.join(root, 'summary.md');
    const dir = suite({'a.mjs': "console.log('x');"});
    const result = await run(['--dir', dir, '--jobs', '2'], {GITHUB_STEP_SUMMARY: summary});
    assert.equal(result.code, 0, result.stderr);
    assert.match(fs.readFileSync(summary, 'utf8'), /### Test runner[\s\S]*1 of 1 files run, jobs 2[\s\S]*\| a\.mjs \|/);
  }

  // 12. AIR-418 shards: every file is in exactly one shard, for any count; the shards of the real suite are disjoint, cover it and split the slow files; a
  // shard runs only its files, the serial-only ones included; a malformed shard is refused before anything runs.
  {
    const names = Array.from({length: 11}, (_, index) => 'f' + String(index).padStart(2, '0') + '.mjs');
    const dir = suite(Object.fromEntries(names.map(name => [name, "console.log('x');"])));
    for (const count of [1, 2, 3, 5, 11, 12]) {
      const seen = [];
      for (let index = 1; index <= count; index++) {
        const plan = planTests({directory: dir, serialOnly: new Set(['f03.mjs']), shard: {index, count}});
        assert.equal(plan.total, plan.parallel.length + plan.serial.length);
        assert.equal(plan.suite, names.length);
        seen.push(...plan.parallel, ...plan.serial);
      }
      assert.deepEqual(seen.sort(), names, `shards of ${count}: every file exactly once`);
    }
    const whole = planTests({directory: 'tests'});
    const halves = [1, 2].map(index => planTests({directory: 'tests', shard: {index, count: 2}}));
    assert.deepEqual([...halves[0].parallel, ...halves[0].serial, ...halves[1].parallel, ...halves[1].serial].sort(), [...whole.parallel, ...whole.serial].sort(), 'the two shards of the real suite are the whole suite, once');
    // AIR-374: the shards are balanced by WEIGHTS (greedy, heaviest first), not by file count: the weights of the two shards differ by less than the lightest listed file, and the two heaviest files are apart
    const weightOf = file => WEIGHTS[file] ?? DEFAULT_WEIGHT;
    const load = halves.map(half => [...half.parallel, ...half.serial].reduce((sum, file) => sum + weightOf(file), 0));
    assert.ok(Math.abs(load[0] - load[1]) <= Math.min(...Object.values(WEIGHTS)), `the shards carry the same weight: ${load.join(' vs ')}`);
    assert.ok(Math.abs(halves[0].total - halves[1].total) <= 30, 'neither shard is nearly empty');
    // The mutation files are CPU-bound and starve each other when they share a shard (the 12 Nov 2026 CI imbalance): they are dealt as a class of their own, so each shard carries about the same share of them, and the two heaviest are apart.
    const isMutation = file => /-mutation\.mjs$/.test(file);
    const mutationLoad = halves.map(half => [...half.parallel, ...half.serial].filter(isMutation).reduce((sum, file) => sum + weightOf(file), 0));
    assert.ok(Math.abs(mutationLoad[0] - mutationLoad[1]) <= Math.min(...Object.values(WEIGHTS)) * 2, `the mutation files are shared evenly: ${mutationLoad.join(' vs ')}`);
    const heaviestMutation = Object.entries(WEIGHTS).filter(entry => isMutation(entry[0])).sort((a, b) => b[1] - a[1]).slice(0, 2).map(entry => entry[0]);
    assert.notEqual(halves[0].parallel.includes(heaviestMutation[0]), halves[0].parallel.includes(heaviestMutation[1]), 'the two heaviest mutation files are in different shards');
    assert.deepEqual(whole.parallel.slice(0, 3), Object.entries(WEIGHTS).sort((a, b) => b[1] - a[1]).slice(0, 3).map(entry => entry[0]), 'the whole plan starts with the heaviest files');
    assert.deepEqual(planTests({directory: 'tests', shard: {index: 2, count: 2}}), halves[1], 'the split does not depend on who asks');
    assert.deepEqual(parseShard('2/3'), {index: 2, count: 3});
    assert.equal(parseShard(undefined), null);
    assert.equal(parseShard(''), null);
    for (const bad of ['0/2', '3/2', '1', '1/0', 'a/b', '1/2/3', '-1/2', '1.5/2']) assert.equal(parseShard(bad), undefined, bad);
    const first = await run(['--dir', dir, '--jobs', '2', '--shard', '1/2', '--serial-only', 'f03.mjs']);
    const second = await run(['--dir', dir, '--jobs', '2', '--serial-only', 'f03.mjs'], {TEST_SHARD: '2/2'});
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    const ran = out => [...out.matchAll(/^ok   (\S+)/gm)].map(match => match[1]);
    assert.deepEqual([...ran(first.stdout), ...ran(second.stdout)].sort(), names, 'the two runs together ran every file once');
    assert.match(first.stdout, /shard 1\/2 of 11 files/);
    assert.match(second.stdout, /Passed \d+ self-contained test files \(shard 2\/2 of 11 files\)/);
    for (const bad of ['3/2', 'x']) {
      const result = await run(['--dir', dir, '--shard', bad]);
      assert.equal(result.code, 2, bad);
      assert.doesNotMatch(result.stdout, /ok   f/);
    }
  }
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}

console.log('Test runner: output kept per file, exit code, signal and timeout named, no new file after a failure, no orphan, bounded concurrency, serial-only files alone, name order with --serial, shards that cover the suite once and bad options refused passed');
