// AIR-470 / ADR 0139 Path A. The feasibility tool itself, at a tiny scale: it builds a sanitized baseline with the real planner, replays it once through the real, unchanged
// `stageSealedGeneration` in a heap-capped process, and the replay is semantically exact (counts, departures archived, returns re-entered). The full-scale numbers are evidence, not a test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-path-a-test-'));
process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
const tool=['scripts/epg-path-a-feasibility.mjs'];
const run=args=>{const r=spawnSync(process.execPath,[...tool,...args],{encoding:'utf8',maxBuffer:1<<26});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim().split('\n').pop());};

const built=run(['build','--dir',dir,'--active','300','--archived','300','--item-bytes','200']);
assert.equal(built.universe,600);
assert.equal(built.archive.items,300);
assert.equal(built.archive.segments,64);

const measured=run(['measure','--dir',dir,'--departures','40','--returns','10','--heap-mb','512']);
assert.equal(measured.exit,0);
assert.ok(measured.report);
const verified=measured.verified;
assert.equal(verified.exact,true);
assert.equal(measured.report.departures,40);
assert.equal(measured.report.returns,10);
assert.equal(verified.scanItems,verified.expectedItems);
assert.equal(verified.ledgerItemsAfter,verified.expectedItems);
assert.equal(verified.upsertedKeys,40);
assert.equal(verified.archiveItemsAfter,340);
assert.ok(measured.report.memoryMiB.sealPeak.heapUsed>0);
assert.ok(measured.phases.some(entry=>entry.phase==='after_gc_retained_scan'),'the retained-scan baseline is recorded after a gc');
assert.equal(measured.failedAfterPhase,null);

// build never clears anything: a non-empty directory is refused and left as it was; the checkout and paths outside the temp directory are refused.
const occupied=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-path-a-occupied-'));
fs.writeFileSync(path.join(occupied,'keep.txt'),'precious');
const refused=spawnSync(process.execPath,[...tool,'build','--dir',occupied,'--active','10','--archived','10'],{encoding:'utf8'});
assert.notEqual(refused.status,0);
assert.equal(fs.readFileSync(path.join(occupied,'keep.txt'),'utf8'),'precious');
assert.deepEqual(fs.readdirSync(occupied),['keep.txt']);
fs.rmSync(occupied,{recursive:true,force:true});
for(const bad of [path.resolve('.'),path.resolve('scripts'),os.homedir(),'/']){
 const r=spawnSync(process.execPath,[...tool,'build','--dir',bad],{encoding:'utf8'});
 assert.notEqual(r.status,0,bad);
}
assert.ok(fs.existsSync('scripts/epg-path-a-feasibility.mjs'));

assert.throws(()=>run(['measure','--dir','relative/dir']));
console.log('epg-path-a-feasibility ok');
