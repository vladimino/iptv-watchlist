// AIR-457 retirement guard (replaces the AIR-456 H1 "binding names a real database" guard). The Worker `iptv` carries NO diagnostic binding, var, Workflow or route:
// the diagnostic D1 / EU R2 / Workflow can be deprovisioned without an orphan reference. The inert modules, ADR 0121/0124 and the dated evidence stay.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const raw=fs.readFileSync('wrangler.jsonc','utf8');
const config=JSON.parse(raw.replace(/^\s*\/\/.*$/gm,''));
assert.doesNotMatch(raw,/EPG_DIAGNOSTIC|EpgDiagnosticWorkflow|iptv-epg-diagnostic|38033d5e-9460-4d24-95d1-ff4a0af56b20/,'wrangler.jsonc names no diagnostic resource');
assert.deepEqual(config.d1_databases.map(item=>item.binding),['DB'],'only the production D1 binding');
assert.deepEqual(config.r2_buckets.map(item=>item.binding),['BUCKET'],'only the production R2 binding');
assert.deepEqual(config.workflows.map(item=>item.binding),['DISCOVERY_WORKFLOW','RATINGS_WORKFLOW','EPG_WORKFLOW','PRODUCER_WORKFLOW'],'production Workflows unchanged');
assert.equal(config.d1_databases[0].database_id,'3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb','production D1 id unchanged');
assert.deepEqual(config.triggers.crons,['0 * * * *'],'single hourly cron unchanged');
assert.equal(config.keep_vars,true,'keep_vars unchanged');
const worker=fs.readFileSync('src/worker.js','utf8'),build=fs.readFileSync('build.mjs','utf8');
assert.doesNotMatch(worker,/api\/epg\/diagnostic|EpgDiagnosticRun\.route/,'the Worker does not route the diagnostic API');
assert.doesNotMatch(build,/export class EpgDiagnosticWorkflow/,'the bundle entry does not export the diagnostic Workflow class');
console.log('EPG diagnostic retirement: no diagnostic binding, var, Workflow class or route remains; production bindings unchanged passed');
