// AIR-457 / AIR-521 retirement guard (ADR 0160). The Worker `iptv` carries NO diagnostic binding, var, Workflow or route (AIR-457), and since AIR-521 the retired canary
// modules, provisioning script and diagnostic migrations are gone from the tree and from the BUILT bundle. ADR 0121/0124/0139 and the dated evidence stay as history.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const raw=fs.readFileSync('wrangler.jsonc','utf8');
const config=JSON.parse(raw.replace(/^\s*\/\/.*$/gm,''));
assert.doesNotMatch(raw,/EPG_DIAGNOSTIC|EpgDiagnosticWorkflow|iptv-epg-diagnostic|38033d5e-9460-4d24-95d1-ff4a0af56b20/,'wrangler.jsonc names no diagnostic resource');
assert.deepEqual(config.d1_databases.map(item=>item.binding),['DB'],'only the production D1 binding');
assert.deepEqual(config.r2_buckets.map(item=>item.binding),['BUCKET'],'only the production R2 binding');
assert.deepEqual(config.workflows.map(item=>item.binding),['DISCOVERY_WORKFLOW','EPG_WORKFLOW','PRODUCER_WORKFLOW','LETTERBOXD_WORKFLOW','PREDICTION_START_WORKFLOW','CATALOG_ENRICHMENT_WORKFLOW'],'production Workflows are the known set (ADR 0193 adds PREDICTION_START_WORKFLOW, ADR 0186 adds LETTERBOXD_WORKFLOW, ADR 0219 adds the dormant CATALOG_ENRICHMENT_WORKFLOW)');
assert.equal(config.d1_databases[0].database_id,'3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb','production D1 id unchanged');
assert.deepEqual(config.triggers.crons,['0 * * * *','1-59/2 * * * *','24 3 * * *','30 * * * *','11-59/15 * * * *'],'hourly cron unchanged, plus the AIR-534 Discovery-only fast cron (ADR 0174), the AIR-543 daily poster cron (ADR 0179), the AIR-571 Letterboxd Sync cron (ADR 0186) and the AIR-607 Catalog Enrichment reconcile cron (ADR 0219)');
assert.equal(config.keep_vars,true,'keep_vars unchanged');
const worker=fs.readFileSync('src/worker.js','utf8'),build=fs.readFileSync('build.mjs','utf8');
assert.doesNotMatch(worker,/api\/epg\/diagnostic|EpgDiagnosticRun\.route/,'the Worker does not route the diagnostic API');
assert.doesNotMatch(build,/export class EpgDiagnosticWorkflow/,'the bundle entry does not export the diagnostic Workflow class');
// AIR-521: the canary code is not merely unrouted, it does not exist.
for(const gone of ['src/epg-diagnostic.js','src/epg-diagnostic-run.js','src/epg-replay.js','scripts/epg-diagnostic-provision.mjs','diagnostic-migrations'])assert.equal(fs.existsSync(gone),false,gone+' is retired and must not return');
assert.doesNotMatch(build,/epg-diagnostic|epg-replay|runEpgDiagnosticWorkflow/,'build.mjs concatenates and exports no canary module');
const entry=build.slice(build.indexOf("writeAtomic('dist/server/workflow-entry.js'"));
assert.deepEqual([...entry.matchAll(/export class (\w+)/g)].map(match=>match[1]),['DiscoveryWorkflow','EpgWorkflow','ProducerWorkflow','LetterboxdWorkflow','PredictionStartWorkflow','CatalogEnrichmentWorkflow'],'only the production Workflow classes are exported (ADR 0193 adds PredictionStartWorkflow, ADR 0219 adds the dormant CatalogEnrichmentWorkflow)');
// (scripts/test-classification.mjs legitimately names this guard file, so it is the one exclusion.) The marker the canary used to share is now an offline-fixture-only name; no source may mention the canary identifiers again.
const CANARY=/EpgDiagnostic|EpgReplay|epgDiagnostic|epg-diagnostic|EPG_DIAGNOSTIC|iptv-epg-diagnostic|epg_diagnostic/;
for(const dir of ['src','scripts','public'])for(const file of fs.readdirSync(dir,{recursive:true,withFileTypes:true}))if(file.isFile()&&/\.(m?js|json|sql)$/.test(file.name)&&file.name!=='test-classification.mjs'){
 const path=(file.parentPath||file.path)+'/'+file.name;assert.doesNotMatch(fs.readFileSync(path,'utf8'),CANARY,path+' references the retired EPG diagnostic canary');
}
// The deployed artifact, not only the sources: `npm run build` must have produced a bundle without the canary.
// The bundle is built here when no earlier file of the shard produced it: CI builds after the tests, and which shard file builds first depends on how the files are dealt, so this guard must not rest on that order.
// `build.mjs` replaces its outputs atomically, so a concurrent build never exposes a missing bundle (50cecee).
if(!['dist/server/index.js','dist/server/workflow-entry.js'].every(file=>fs.existsSync(file)))execFileSync(process.execPath,['build.mjs'],{stdio:'inherit'});
for(const artifact of ['dist/server/index.js','dist/server/workflow-entry.js']){
 assert.equal(fs.existsSync(artifact),true,artifact+' is built before the tests');
 assert.doesNotMatch(fs.readFileSync(artifact,'utf8'),CANARY,artifact+' carries no retired canary code');
}
console.log('EPG diagnostic retirement: no diagnostic binding, var, Workflow class, route, module or bundle code remains; production bindings unchanged passed');
