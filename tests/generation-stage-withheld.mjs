import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createEpgRepository} from '../src/epg-repository.js';
import {DEFAULT_CHUNK_BYTES,DEFAULT_CHUNK_STATEMENTS,MAX_ROW_STATEMENT_BYTES,STAGE_CLAIM_TTL_MS,STAGE_TABLES,StageStop,chunkStatements,claimStage,commitStage,discardStage,failStage,openStage,planGeneration,publishStaged,readStage,renderedBytes,stageChunk,validateStage} from '../src/generation-stage.js';
import {D1Error} from '../scripts/d1-backfill.mjs';
import {expectedStatements,measureGenerationUnit,syntheticGeneration} from '../scripts/d1-generation-size.mjs';
import {DAY,FINAL,PRODUCTION,SCALED,adapter,at,cleanup,context,database,dump,filmIds,ok,one,openSqlite,root,rows,schema,seedAttempts,sha256,sqlite,stopReason,withPrior} from './generation-stage-lib.mjs';

// AIR-418: part two of three (see tests/generation-stage-lib.mjs): the withheld generation at 1.25x over the same prior as the published part.
try{
 const prior=syntheticGeneration({...PRODUCTION,showsPerFilm:2,showsPerCandidate:2,runId:'run-1'});
 // 2. Withheld at 1.25x over the same prior: equal to the legacy withheld write; the pointer does not move.
 {
  const withheld={...syntheticGeneration({...SCALED,showsPerFilm:2,showsPerCandidate:2,runId:'run-w'}),phase:'withheld'};delete withheld.expectedProgrammeRunId;
  const legacyW=database('legacy-w',{films:SCALED.films,staged:false}),stagedW=database('staged-w',{films:SCALED.films});
  await createEpgRepository(openSqlite(legacyW)).publishGeneration(prior);
  await createEpgRepository(openSqlite(stagedW)).publishGeneration(prior);
  for(const file of [legacyW,stagedW])seedAttempts(file);
  await createEpgRepository(openSqlite(legacyW)).publishGeneration(withheld);
  const entry=[];
  await publishStaged(adapter(stagedW),withheld,{...context(),report:entry});
  assert.equal(entry[0].commit.statements,8);
  assert.deepEqual(dump(stagedW),dump(legacyW),'withheld staged import equals publishGeneration row for row at 1.25x');
  assert.equal(one(stagedW,'SELECT programme_run_id FROM published_generation;').programme_run_id,'run-1');
 }
}finally{cleanup();}
console.log('Generation stage (withheld): 1.25x withheld equality with publishGeneration and an unmoved pointer passed');
