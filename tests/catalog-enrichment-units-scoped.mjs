// AIR-688: the whole receipted-unit suite (Person, credits, facts, replay, noop, settled, lost response, concurrent writers, a closed route) re-run with the drain's gate scope (`env.gateReuse`) on every env.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const r=spawnSync(process.execPath,['tests/catalog-enrichment-units.mjs'],{env:{...process.env,GATE_REUSE:'1'},encoding:'utf8',maxBuffer:1<<26});
assert.equal(r.status,0,'catalog-enrichment-units.mjs failed with the gate scope on:\n'+r.stdout+r.stderr);
console.log('catalog-enrichment units with gate reuse: OK');
