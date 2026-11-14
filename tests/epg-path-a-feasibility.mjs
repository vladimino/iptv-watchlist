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
const report=measured.report;
assert.equal(report.departures,40);
assert.equal(report.returns,10);
assert.equal(report.scanItems,report.expectedItems);
assert.equal(report.ledgerItemsAfter,report.expectedItems);
assert.equal(report.upsertedKeys,40);
assert.equal(report.archiveItemsAfter,340);
assert.ok(report.memoryMiB.peak.heapUsed>0);

assert.throws(()=>run(['measure','--dir','relative/dir']));
console.log('epg-path-a-feasibility ok');
