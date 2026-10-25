import assert from 'node:assert/strict';
import { checkDocumentation } from '../scripts/check-documentation-governance.mjs';

const base = 'Documentation impact: none - isolated internal refactoring only\nArchitecture impact: none - no responsibilities or contracts changed\nResearch evidence: no';
function verify(files, patches, body=base) { return checkDocumentation({files, patches, body}); }

assert.deepEqual(verify(['src/format.js'], {'src/format.js': '+const value = 4;'}), []);
assert.match(verify([], {}, '' ).join(' '), /Documentation impact/);
assert.match(verify([], {}, 'Documentation impact: none\nArchitecture impact: none\nResearch evidence: no').join(' '), /requires a concrete reason/);
assert.match(verify(['src/discovery.js'], {'src/discovery.js': '+const mode = env.SCORED_RESOLUTION;'}).join(' '), /feature-flags/);
assert.deepEqual(verify(['src/discovery.js','docs/reference/feature-flags.md'], {'src/discovery.js': '+const mode = env.SCORED_RESOLUTION;'}), []);
assert.deepEqual(verify(['tests/scorer.mjs'], {'tests/scorer.mjs': '+env.SCORED_RESOLUTION = "on";'}), []);
assert.deepEqual(verify(['src/discovery.js'], {'src/discovery.js': ' const mode = env.SCORED_RESOLUTION;'}), []);
assert.match(verify(['src/logic.js'], {}, base.replace('Research evidence: no','Research evidence: yes')).join(' '), /docs\/evidence/);
assert.deepEqual(verify(['docs/evidence/example.md'],{},base.replace('Research evidence: no','Research evidence: yes')),[]);
const arch = 'Documentation impact: docs/adr/0020.md and diagrams\nArchitecture impact: changed - modify source of truth\nResearch evidence: no';
assert.match(verify(['src/worker.js'], {}, arch).join(' '), /docs\/adr/);
assert.match(verify(['docs/adr/0020.md'], {}, arch).join(' '), /docs\/architecture/);
assert.match(verify(['docs/adr/0020.md','docs/architecture/runtime-topology.md'], {}, arch).join(' '), /docs\/reference/);
assert.deepEqual(verify(['docs/adr/0020.md','docs/architecture/runtime-topology.md','docs/reference/api/mcp.md'], {}, arch), []);
console.log('documentation governance: fixtures passed');
