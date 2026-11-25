import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createEpgRepository} from '../src/epg-repository.js';
import {DEFAULT_CHUNK_BYTES,DEFAULT_CHUNK_STATEMENTS,MAX_ROW_STATEMENT_BYTES,STAGE_CLAIM_TTL_MS,STAGE_TABLES,StageStop,chunkStatements,claimStage,commitStage,discardStage,failStage,openStage,planGeneration,publishStaged,readStage,renderedBytes,stageChunk,validateStage} from '../src/generation-stage.js';
import {D1Error} from '../scripts/d1-backfill.mjs';
import {expectedStatements,measureGenerationUnit,syntheticGeneration} from '../scripts/d1-generation-size.mjs';
import {DAY,FINAL,PRODUCTION,SCALED,adapter,at,cleanup,context,database,dump,filmIds,ok,one,openSqlite,openSqliteStreaming,root,rows,schema,seedAttempts,sha256,sqlite,stopReason,withPrior} from './generation-stage-lib.mjs';

// AIR-418: part one of three (see tests/generation-stage-lib.mjs): the published generation at 1.25x. The withheld generation is generation-stage-withheld.mjs,
// the fault matrix generation-stage-faults.mjs.
// ADR-0021 implemented: a generation staged in bounded chunks and published by one commit writes exactly the final rows the
// legacy publishGeneration writes, at 1.25x the production order of magnitude, and every interruption, refusal or mismatch
// leaves the final tables as the previous commit left them.
try{
 // The legacy unit size stays measurable and its count formula holds; the migration adds staging tables and nothing else.
 for(const shape of [{films:3,showsPerFilm:2,candidates:7,showsPerCandidate:3},{films:0,showsPerFilm:1,candidates:5,showsPerCandidate:0},{films:4,showsPerFilm:0,candidates:0,showsPerCandidate:1}])assert.equal((await measureGenerationUnit(shape)).statements,expectedStatements(shape),JSON.stringify(shape));
 assert.deepEqual([...fs.readFileSync('migrations/0002_generation_stage.sql','utf8').matchAll(/CREATE TABLE ([a-z_]+)/g)].map(match=>match[1]),STAGE_TABLES);
 assert.doesNotMatch(fs.readFileSync('migrations/0002_generation_stage.sql','utf8'),/DROP|ALTER|CREATE VIEW|DELETE/);
 assert.equal(one(database('version'),'SELECT version FROM schema_contract;').version,2);
 for(const file of ['src/worker.js','build.mjs','wrangler.jsonc'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/generation-stage|0002_generation_stage/,file);

 // 1. At 1.25x production cardinality: the plan stays within the proven request size, the staged path writes exactly what the
 // legacy path writes, and the commit is twelve statements of a few KB.
 // Memory (CI incident 2026-11-25): the plan, its per-chunk statements and both generations are each hundreds of MB at this cardinality, so the file never holds
 // them together: the plan checks keep only the numbers and chunk digests they need, and the plan is dropped before the databases are loaded and rebuilt
 // (deterministically, as asserted) where a later assertion needs it. Every assertion below is the one the file always had.
 const scaled=withPrior(syntheticGeneration({...SCALED,showsPerFilm:2,showsPerCandidate:2,runId:'run-2',previousRunId:'run-1'}));
 let planRows,chunkDigests;
 {
  const plan=planGeneration(scaled,{sha256});
  assert.equal(plan.rows.length,SCALED.films*3+SCALED.candidates*3);
  assert.ok(plan.chunks.every(chunk=>chunk.statements.length+3<=DEFAULT_CHUNK_STATEMENTS&&chunk.bytes+4096<=DEFAULT_CHUNK_BYTES));
  for(const chunk of plan.chunks){const statements=chunkStatements(plan,chunk,context());assert.ok(statements.length<=DEFAULT_CHUNK_STATEMENTS);assert.ok(statements.reduce((sum,item)=>sum+renderedBytes(item.sql,item.params),0)<=DEFAULT_CHUNK_BYTES);}
  planRows=plan.rows.length;chunkDigests=plan.chunks.map(chunk=>chunk.sha256);
 }
 {
  const again=planGeneration(scaled,{sha256});
  assert.deepEqual(again.chunks.map(chunk=>chunk.sha256),chunkDigests,'the plan is deterministic');
 }
 const chunkCount=chunkDigests.length;
 const legacy=database('legacy',{films:SCALED.films,staged:false}),staged=database('staged',{films:SCALED.films});
 {
  const prior=syntheticGeneration({...PRODUCTION,showsPerFilm:2,showsPerCandidate:2,runId:'run-1'});
  await createEpgRepository(openSqliteStreaming(legacy)).publishGeneration(prior);
  const stagedPrior=[];
  await publishStaged(adapter(staged),prior,{...context(),report:stagedPrior});
 }
 assert.deepEqual(dump(staged),dump(legacy),'a first generation staged from an empty target equals the legacy write');
 for(const file of [legacy,staged])seedAttempts(file);
 const beforeScaled=dump(staged);
 await createEpgRepository(openSqliteStreaming(legacy)).publishGeneration(scaled);
 // Interrupt mid-way with a lost response: nothing reaches a final table, the stage keeps loading, the write is not retried.
 const middle=Math.floor(chunkCount/2);
 const interrupted=adapter(staged,{[1+middle]:'lost'});
 const report=[];
 assert.equal(await stopReason(publishStaged(interrupted,scaled,{...context(),report})),'error:injected lost response');
 assert.equal(interrupted.log.attempts.filter(item=>item.fault==='lost').length,1,'the uncertain write was sent once');
 assert.deepEqual(dump(staged),beforeScaled,'0 writes to final tables before the commit');
 assert.equal(one(staged,"SELECT state FROM generation_stage WHERE programme_run_id='run-2';").state,'loading');
 const resumed=[];
 await publishStaged(adapter(staged),scaled,{...context(),report:resumed});
 assert.equal(resumed[0].outcome,'committed');
 assert.equal(resumed[0].chunks.alreadyReceived,middle,'resume starts at the first chunk without a receipt');
 assert.equal(resumed[0].chunks.sent,chunkCount-middle);
 assert.deepEqual(dump(staged),dump(legacy),'staged import equals publishGeneration row for row at 1.25x');
 assert.equal(resumed[0].commit.statements,12);
 assert.ok(resumed[0].commit.bytes<6000);
 assert.equal(resumed[0].readback.rows,planRows);
 console.log('1.25x staged generation (local SQLite):',JSON.stringify({rows:resumed[0].rows,chunks:chunkCount,bytes:resumed[0].bytes,largestChunkBytes:resumed[0].largestChunkBytes,largestRowBytes:resumed[0].largestRowBytes,requests:resumed[0].requests,durations:resumed[0].durations,commit:resumed[0].commit}));
 // A repeated run is a replay; a repeated commit request aborts and changes nothing.
 const replay=[];
 assert.equal((await publishStaged(adapter(staged),scaled,{...context(),report:replay})).replay,true);
 assert.equal(replay[0].outcome,'replay');
 {
  const plan=planGeneration(scaled,{sha256});
  await assert.rejects(commitStage(openSqlite(staged),plan,context()));
 }
 assert.deepEqual(dump(staged),dump(legacy));
}finally{cleanup();}
console.log('Generation stage (published): 1.25x published equality with publishGeneration, bounded deterministic chunks, a lost response mid-way, resume from the first chunk without a receipt, replay and a refused repeated commit passed');
