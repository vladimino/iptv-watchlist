// AIR-579: census of the whole-catalog reads of `discovery_admission` (the statement `... WHERE state='current' ORDER BY film_id`, `readCatalog`).
// The real Worker runs in a vm over a D1 stand-in at the real schema, and every statement is seen. The numbers are an INVENTORY, not a target: they say
// which entry points read the whole catalog and how often per call, so a change that adds or removes a read is a conscious one. Nothing here calls
// Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld} from './prediction-d1-flow-lib.mjs';

const world=await flowWorld({films:30});
vm.runInContext(fs.readFileSync('src/prediction-diagnostics.js','utf8').replace(/^export /gm,''),world.ctx);
const CATALOG=/FROM discovery_admission WHERE state='current' ORDER BY film_id/;
let reads=0;
world.hooks.query=text=>{if(CATALOG.test(text))reads++;};
const census=async fn=>{reads=0;await fn();return reads;};
const get=path=>world.ctx.worker.fetch(new Request('https://site.example'+path),world.env,{waitUntil(){}}).then(response=>response.text());
const snapshot=vm.runInContext('loadPredictionDiagnosticSnapshot',world.ctx);

const result={
 // The three read-only MCP diagnostics (prediction_queue_overview, prediction_pending, prediction_film_diagnostics) share this snapshot: one whole-catalog read each.
 diagnosticSnapshot:await census(()=>snapshot(world.env,null)),
 diagnosticSnapshotOneFilm:await census(()=>snapshot(world.env,'tmdb_1')),
 enrichmentView:await census(()=>get('/api/enrichment/view')),
 catalogAvailable:await census(()=>get('/api/catalog/available')),
 pipelineStatus:await census(()=>get('/api/enrichment/pipeline/status')),
 // These read the catalog by id or not at all.
 programme:await census(()=>get('/api/programme')),
 enrichmentStatus:await census(()=>get('/api/enrichment/status')),
 queueStatus:await census(()=>get('/api/enrichment/queue/status')),
 status:await census(()=>get('/api/status')),
 runner:await census(()=>get('/api/enrichment/runner')),
 queueReconcile:await census(()=>world.api('queue/reconcile',{})),
};
let started;
result.reconcileAndStart=await census(async()=>{started=await world.reconcileAndStart({});});
assert.equal(started.start.status,200);
const run=started.start.data.runId,epoch=started.start.data.lease.epoch;
result.heartbeat=await census(()=>world.api('heartbeat',{runId:run,epoch}));
result.manifestPart=await census(()=>world.api('batch/manifest',{runId:run,part:'envelope'}));
result.submitOneFilm=await census(()=>world.pair(run));
result.complete=await census(()=>world.api('complete',{runId:run,epoch,reason:'manifest_spent'}));
console.log(JSON.stringify(result));

assert.deepEqual(result,{
 diagnosticSnapshot:1,diagnosticSnapshotOneFilm:1,enrichmentView:1,catalogAvailable:1,pipelineStatus:1,
 programme:0,enrichmentStatus:0,queueStatus:0,status:0,runner:0,queueReconcile:1,reconcileAndStart:2,
 heartbeat:0,manifestPart:0,submitOneFilm:0,complete:0,
},'whole-catalog reads per entry point (a change must be deliberate and recorded in the AIR-579 evidence)');
console.log('discovery catalog read census ok');
