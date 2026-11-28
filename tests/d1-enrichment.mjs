// AIR-537 slice 3 (ADR 0155, ADR 0162): src/d1-enrichment.js now holds only the read-only status of the retired enrichment projector
// for /api/d1/status. The projector's runner, R2 reads, checkpoint diff and `legacy`/`r2`/`prepared` D1 write arms are gone (their
// scenarios, previously in this file, are removed with them). A D1 stand-in runs the real migrations in the sqlite3 CLI. Covered: no
// runner or write arm remains in the module or is reachable from the Worker, the cron and the Worker bundle; the status is retired
// (mode and windowMode null whatever the retired selectors say), schema detection for v3/partial v4/v4, the checkpoint counts and last
// run it reports from the rows, and the owner-review, metadata-cache and prediction-domain fields of later schemas.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {d1Standin} from './d1-standin.mjs';

const source=fs.readFileSync('src/d1-enrichment.js','utf8');
const code=source.split('\n').filter(line=>!line.startsWith('//')).join('\n');
const worker=fs.readFileSync('src/worker.js','utf8').split('\n').filter(line=>!/^\s*\/\//.test(line)).join('\n');
// The module is read-only: no runner, no write, no R2, no lease, no window, no retired selector read.
for(const pattern of [/runD1EnrichmentProjection/,/\bBUCKET\b/,/\b(INSERT|UPDATE|DELETE)\s/,/projection_fence\s*\(/,/D1_ENRICHMENT_(WRITE|WINDOW|BULK|TEST_HARNESS)/,/\bd1Enrichment(Mode|Adapter|Plan|Store|Diff|Write|Lease|Release|Guard)\b/])assert.doesNotMatch(code,pattern,String(pattern));
assert.deepEqual([...code.matchAll(/^(?:async )?function (\w+)/gm)].map(match=>match[1]),['d1EnrichmentStatus'],'the status is the only function left');
assert.doesNotMatch(worker,/runD1EnrichmentProjection|D1_ENRICHMENT_(WRITE|WINDOW|BULK|TEST_HARNESS)/,'the Worker never starts the projector or reads the retired selectors');
assert.doesNotMatch(fs.readFileSync('src/catalog-d1.js','utf8'),/runD1EnrichmentProjection/);
assert.match(fs.readFileSync('wrangler.jsonc','utf8'),/"crons": \["0 \* \* \* \*", "1-59\/2 \* \* \* \*", "24 3 \* \* \*", "30 \* \* \* \*"\]/);
assert.doesNotMatch(fs.readFileSync('src/catalog-d1.js','utf8'),/d1EnrichmentStatus\(/,'AIR-690: /api/d1/status no longer reports the retired projector; the function stays only as a historical diagnostic with its own tests');
// CI shards do not build first: like the other bundle tests, build the Worker bundle here (atomic write).
assert.equal(spawnSync(process.execPath,['build.mjs'],{stdio:'ignore'}).status,0);
const bundle=fs.readFileSync('dist/server/index.js','utf8').split('\n').filter(line=>!/^\s*\/\//.test(line)).join('\n');
assert.ok(bundle.includes('async function d1EnrichmentStatus('),'the bundle carries the status');
assert.doesNotMatch(bundle,/runD1EnrichmentProjection|d1EnrichmentPlan|d1EnrichmentDiff|LifecycleReader/,'the bundle carries no projector runner');

const context=vm.createContext({Date,Map,Set,JSON,Object,Number,Promise,console});
vm.runInContext(source+'\nglobalThis.status=d1EnrichmentStatus;',context);
const status=(binding,env={})=>context.status(binding,env);
const plain=value=>JSON.parse(JSON.stringify(value));

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-enrichment-status-'));
let databases=0;
const migrated=(names)=>{
 const db=d1Standin(path.join(root,'status-'+(databases++)+'.sqlite'));
 for(const name of names)db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return db;
};
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const V3=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity'];

// 1. Retired, whatever the selectors say: mode and windowMode are null even when the retired variables are set.
{
 const tableNames=['projection_state','projection_run','projection_fence','film_sync_state','metadata_cache','metadata_cache_authority','metadata_cache_cas'];
 const binding={prepare(sql){return {bind(){return this;},async all(){return {results:/owner_review_/.test(sql)?[]:tableNames.map(name=>({name}))};},async first(){if(/schema_contract/.test(sql))return {version:7};if(/COUNT\(/.test(sql))return {total:0,absent:0,lastWriteAt:null};return null;}};}};
 for(const env of [{},{D1_ENRICHMENT_WRITE:'on',D1_ENRICHMENT_WINDOW:'on',D1_ENRICHMENT_BULK:'on'},{D1_ENRICHMENT_WRITE:'dry'}]){
  const reported=await status(binding,env);
  assert.deepEqual([reported.mode,reported.windowMode,reported.retired,reported.schema],[null,null,true,true],JSON.stringify(env));
 }
}

// 2. A database without schema v4 has no projector tables; a partial 0004 is not schema v4.
{
 const v3=migrated(V3);
 assert.deepEqual(plain(await status(v3)),{mode:null,retired:true,schema:false,schemaVersion:3,projectionTables:[]});
 v3.sql(fs.readFileSync('migrations/0004_projection_state.sql','utf8').replace(/UPDATE schema_contract[^;]*;/,''));
 assert.deepEqual(plain(await status(v3)),{mode:null,retired:true,schema:false,schemaVersion:3,projectionTables:['projection_fence','projection_run','projection_state']});
 v3.sql('UPDATE schema_contract SET version=4 WHERE id=1;DROP TABLE projection_fence');
 assert.deepEqual(plain(await status(v3)),{mode:null,retired:true,schema:false,schemaVersion:4,projectionTables:['projection_run','projection_state']});
}

// 3. Schema v4: the checkpoint counts and the last run come from the rows; the v4 shape has no sync, cache or prediction fields.
{
 const db=migrated([...V3,'0004_projection_state']);
 const T='2026-11-10T10:00:00.000Z';
 db.sql(`INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('enrichment','film','film:heat','k1','${T}'),('enrichment','film','film:gone','absent','${T}'),('enrichment','person','actor/a','k2','${T}'),('other','film','film:x','k3','${T}')`);
 db.sql(`INSERT INTO projection_run (projection,lease_id,lease_until,started_at,finished_at,outcome,summary_json) VALUES ('enrichment',NULL,NULL,'${T}','${T}','complete','{"changed":3}')`);
 const reported=await status(db);
 assert.deepEqual([reported.mode,reported.schema,reported.checkpoints,reported.absent,reported.lastWriteAt,reported.windowMode],[null,true,3,1,T,null]);
 assert.deepEqual(plain(reported.lastRun),{startedAt:T,finishedAt:T,outcome:'complete',leaseHeld:false,summary:{changed:3}});
 assert.equal(one(db,'SELECT COUNT(*) FROM projection_state'),4,'the status only reads');
 assert.equal(reported.schemaVersion,undefined);assert.equal(reported.syncCheckpoints,undefined);assert.equal(reported.cacheMode,undefined);assert.equal(reported.predictionMode,undefined);
 assert.deepEqual(Object.keys(reported).sort(),['absent','checkpoints','lastRun','lastWriteAgeSec','lastWriteAt','mode','retired','schema','windowMode']);
}

// 4. Schema v5 adds the sync checkpoints; a run row with a lease reports leaseHeld; an unreadable summary stays null.
{
 const db=migrated([...V3,'0004_projection_state','0005_film_sync_state']);
 const T='2026-11-10T10:00:00.000Z';
 db.sql(`INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('metadata_sync','film','film:heat','s1','${T}'),('metadata_sync','film','film:gone','absent','${T}')`);
 db.sql(`INSERT INTO projection_run (projection,lease_id,lease_until,started_at,finished_at,outcome,summary_json) VALUES ('enrichment','lease','2999-01-01T00:00:00.000Z','${T}',NULL,NULL,'not json')`);
 const reported=await status(db);
 assert.deepEqual([reported.schemaVersion,reported.syncCheckpoints,reported.syncAbsent,reported.checkpoints],[5,2,1,0]);
 assert.equal(reported.lastRun.leaseHeld,true);assert.equal(reported.lastRun.summary,null);
}

fs.rmSync(root,{recursive:true,force:true});
console.log('D1 enrichment status (AIR-537 slice 3): the projector runner, R2 reads and write arms are gone from the module, the Worker and the bundle; the status is retired (mode and windowMode null whatever the retired selectors say), detects schema v3, partial and v4, reports checkpoints, the last run and the sync clocks from rows without writing');
