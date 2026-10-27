import assert from 'node:assert/strict';
import { inspectAddedLines } from '../scripts/check-timeless-documentation.mjs';

const file = 'docs/reference/api/mcp.md';
const patch = '@@ -8,0 +9,3 @@\n+The contract was introduced in AIR-152.\n+The API returns validation issues.\n+Unchanged in this PR.';
const hits = inspectAddedLines(patch, file);
assert.equal(hits.length, 2);
assert.deepEqual(hits.map(h => h.line), [9, 11]);
assert.equal(inspectAddedLines(patch, 'docs/evidence/prediction/air-152.md').length, 0);
assert.equal(inspectAddedLines(patch, 'docs/process/documentation-governance.md').length, 0);
assert.equal(inspectAddedLines('@@ -1 +1 @@\n-[AIR-22] old\n+See the current validation contract.', file).length, 0);
assert.equal(inspectAddedLines('@@ -2,0 +3 @@\n+See [the rationale](../adr/0015-decision.md).', file).length, 0);
assert.equal(inspectAddedLines('@@ -2,0 +3 @@\n+Historical retry records without a summary return null.', file).length, 0);

const nav = 'docs/architecture/README.md';
const patchFor = text => '@@ -1,0 +2 @@\n+' + text;
assert.equal(inspectAddedLines(patchFor('merged (AIR-141)'), nav)[0]?.severity, 'error');
assert.equal(inspectAddedLines(patchFor('The diagrams were delivered across AIR-140–143.'), nav)[0]?.severity, 'error');
assert.equal(inspectAddedLines(patchFor('Implemented in AIR-152'), 'docs/reference/README.md')[0]?.severity, 'error');
assert.equal(inspectAddedLines(patchFor('See AIR-141 source evidence'), nav)[0]?.severity, 'warning');
assert.equal(inspectAddedLines(patchFor('See [ADR-0005](../adr/0005.md)'), nav).length, 0);
assert.equal(inspectAddedLines(patchFor('merged (AIR-141)'), 'docs/evidence/README.md').length, 0);
assert.equal(inspectAddedLines(patchFor('merged (AIR-141)'), 'docs/process/README.md').length, 0);
assert.equal(inspectAddedLines(patchFor('merged (AIR-141)'), 'docs/reference/api/mcp.md')[0]?.severity, 'warning');
assert.equal(inspectAddedLines('@@ -1 +1 @@\n-merged (AIR-141)\n+Architecture and current boundaries', nav).length, 0);
assert.equal(inspectAddedLines(patchFor('A working overview.'), nav).length, 0);

console.log('Timeless documentation strict and advisory fixtures passed.');
