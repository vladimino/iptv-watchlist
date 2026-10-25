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
console.log('Timeless documentation advisory fixtures passed.');
