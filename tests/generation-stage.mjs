import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createEpgRepository} from '../src/epg-repository.js';
import {DEFAULT_CHUNK_BYTES,DEFAULT_CHUNK_STATEMENTS,MAX_ROW_STATEMENT_BYTES,STAGE_CLAIM_TTL_MS,STAGE_TABLES,StageStop,chunkStatements,claimStage,commitStage,discardStage,failStage,openStage,planGeneration,publishStaged,readStage,renderedBytes,stageChunk,validateStage} from '../src/generation-stage.js';
import {D1Error} from '../scripts/d1-backfill.mjs';
import {expectedStatements,measureGenerationUnit,syntheticGeneration} from '../scripts/d1-generation-size.mjs';
import {openSqlite} from '../scripts/offline-import.mjs';

// ADR-0021 implemented: a generation staged in bounded chunks and published by one commit writes exactly the final rows the
// legacy publishGeneration writes, at 1.25x the production order of magnitude, and every interruption, refusal or mismatch
// leaves the final tables as the previous commit left them.
const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
const schema=fs.readFileSync('migrations/0001_schema_v1.sql','utf8')+'\n'+fs.readFileSync('migrations/0002_generation_stage.sql','utf8');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-generation-stage-'));
const FINAL=['programme_generation','published_generation','film_generation','film_show','film_epg_last_airing','candidate','candidate_generation','candidate_show'];
const PRODUCTION={films:2300,candidates:22199},SCALED={films:2300,candidates:27749};
const sqlite=(file,input,{json=false}={})=>spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input,encoding:'utf8',maxBuffer:1<<30});
const ok=(file,input)=>{const result=sqlite(file,input);assert.equal(result.status,0,result.stderr);};
const rows=(file,sql)=>{const result=sqlite(file,sql,{json:true});assert.equal(result.status,0,result.stderr);return result.stdout.trim()?JSON.parse(result.stdout):[];};
const one=(file,sql)=>rows(file,sql)[0];
const dump=file=>Object.fromEntries(FINAL.map(table=>[table,rows(file,'SELECT * FROM '+table+';').map(row=>JSON.stringify(row)).sort()]));
const filmIds=count=>Array.from({length:count},(_,index)=>'film:'+('f'+index+'-'.repeat(24)).slice(0,24));
function database(name,{films=100,staged=true}={}){
 const file=path.join(root,name+'.sqlite');
 ok(file,staged?schema:fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
 const ids=filmIds(films);
 for(let index=0;index<ids.length;index+=500)ok(file,'INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES '+ids.slice(index,index+500).map(id=>"('"+id+"',1,NULL,'Film','2026-10-26T00:00:00.000Z')").join(',')+';');
 return file;
}
// The dry-run SQLite adapter with injected faults. A write request is buffered by the caller and sent as one sqlite3 batch;
// 'lost' drops it unsent with an uncertain-write error, 'after500' executes it and then reports an uncertain write,
// 'failLast' appends a failing last statement. Every write request is counted, so a retry would be visible. hooks[index] runs
// before write request index is sent, so another execution can act in between two requests of this one.
function adapter(file,faults={},hooks={}){
 const base=openSqlite(file),log={writes:0,attempts:[]};
 let buffer=null;
 return {log,
  run(sql,params=[]){if(buffer){buffer.push([sql,params]);return Promise.resolve();}return base.run(sql,params);},
  get:(sql,params)=>base.get(sql,params),
  all:(sql,params)=>base.all(sql,params),
  async transaction(fn){
   if(buffer)return fn();
   buffer=[];
   let statements;
   try{await fn();statements=buffer;}finally{buffer=null;}
   const index=log.writes++,fault=faults[index]||(typeof faults.match==='function'?faults.match(statements,index):null);
   if(hooks[index])await hooks[index]();
   log.attempts.push({index,first:statements[0]?.[0].slice(0,40),fault:fault||null});
   if(fault==='lost')throw new D1Error('write_uncertain','injected lost response');
   await base.transaction(async()=>{for(const [sql,params] of statements)await base.run(sql,params);if(fault==='failLast')await base.run('INSERT INTO stage_missing_table VALUES (1)');});
   if(fault==='after500')throw new D1Error('write_uncertain','injected HTTP 500 after commit',{status:500});
  },
 };
}
// Each context is a later execution: its clock starts a day after the previous one, past any earlier claim's expiry, so a rerun
// after an interruption takes the abandoned claim over. at() pins a time, to run two executions while a claim is live.
const DAY=24*60*60*1000;let executions=0;
const at=offset=>()=>new Date(Date.UTC(2026,9,26,2)+offset).toISOString();
const context=(owner='owner-a',baseline='baseline-a',{execution=executions++,nonce='nonce-'+execution,fence=1,now=at(DAY*execution)}={})=>({owner,baseline,sha256,nonce,fence,now});
const withPrior=generation=>({...generation,candidates:generation.candidates.map((candidate,index)=>index<5?{...candidate,evidenceKey:candidate.evidenceKey+'|changed'}:candidate)});
const seedAttempts=file=>ok(file,"UPDATE candidate SET attempts=3,last_attempt_at='2026-10-26T01:30:00.000Z',retry_at='2026-10-27T00:00:00.000Z',terminal_reason='repeated_uncertain_match' WHERE observation_key IN (SELECT observation_key FROM candidate ORDER BY observation_key LIMIT 10);");
const stopReason=async promise=>{try{await promise;return null;}catch(error){return error instanceof StageStop?error.reason:'error:'+error.message;}};

try{
 // The legacy unit size stays measurable and its count formula holds; the migration adds staging tables and nothing else.
 for(const shape of [{films:3,showsPerFilm:2,candidates:7,showsPerCandidate:3},{films:0,showsPerFilm:1,candidates:5,showsPerCandidate:0},{films:4,showsPerFilm:0,candidates:0,showsPerCandidate:1}])assert.equal((await measureGenerationUnit(shape)).statements,expectedStatements(shape),JSON.stringify(shape));
 assert.deepEqual([...fs.readFileSync('migrations/0002_generation_stage.sql','utf8').matchAll(/CREATE TABLE ([a-z_]+)/g)].map(match=>match[1]),STAGE_TABLES);
 assert.doesNotMatch(fs.readFileSync('migrations/0002_generation_stage.sql','utf8'),/DROP|ALTER|CREATE VIEW|DELETE/);
 assert.equal(one(database('version'),'SELECT version FROM schema_contract;').version,2);
 for(const file of ['src/worker.js','build.mjs','wrangler.jsonc'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/generation-stage|0002_generation_stage/,file);

 // 1. At 1.25x production cardinality: the plan stays within the proven request size, the staged path writes exactly what the
 // legacy path writes, and the commit is twelve statements of a few KB.
 const prior=syntheticGeneration({...PRODUCTION,showsPerFilm:2,showsPerCandidate:2,runId:'run-1'});
 const scaled=withPrior(syntheticGeneration({...SCALED,showsPerFilm:2,showsPerCandidate:2,runId:'run-2',previousRunId:'run-1'}));
 const plan=planGeneration(scaled,{sha256});
 assert.equal(plan.rows.length,SCALED.films*3+SCALED.candidates*3);
 assert.ok(plan.chunks.every(chunk=>chunk.statements.length+3<=DEFAULT_CHUNK_STATEMENTS&&chunk.bytes+4096<=DEFAULT_CHUNK_BYTES));
 for(const chunk of plan.chunks){const statements=chunkStatements(plan,chunk,context());assert.ok(statements.length<=DEFAULT_CHUNK_STATEMENTS);assert.ok(statements.reduce((sum,item)=>sum+renderedBytes(item.sql,item.params),0)<=DEFAULT_CHUNK_BYTES);}
 assert.deepEqual(planGeneration(scaled,{sha256}).chunks.map(chunk=>chunk.sha256),plan.chunks.map(chunk=>chunk.sha256),'the plan is deterministic');
 const legacy=database('legacy',{films:SCALED.films,staged:false}),staged=database('staged',{films:SCALED.films});
 await createEpgRepository(openSqlite(legacy)).publishGeneration(prior);
 const stagedPrior=[];
 await publishStaged(adapter(staged),prior,{...context(),report:stagedPrior});
 assert.deepEqual(dump(staged),dump(legacy),'a first generation staged from an empty target equals the legacy write');
 for(const file of [legacy,staged])seedAttempts(file);
 const beforeScaled=dump(staged);
 await createEpgRepository(openSqlite(legacy)).publishGeneration(scaled);
 // Interrupt mid-way with a lost response: nothing reaches a final table, the stage keeps loading, the write is not retried.
 const middle=Math.floor(plan.chunks.length/2);
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
 assert.equal(resumed[0].chunks.sent,plan.chunks.length-middle);
 assert.deepEqual(dump(staged),dump(legacy),'staged import equals publishGeneration row for row at 1.25x');
 assert.equal(resumed[0].commit.statements,12);
 assert.ok(resumed[0].commit.bytes<6000);
 assert.equal(resumed[0].readback.rows,plan.rows.length);
 console.log('1.25x staged generation (local SQLite):',JSON.stringify({rows:resumed[0].rows,chunks:plan.chunks.length,bytes:resumed[0].bytes,largestChunkBytes:resumed[0].largestChunkBytes,largestRowBytes:resumed[0].largestRowBytes,requests:resumed[0].requests,durations:resumed[0].durations,commit:resumed[0].commit}));
 // A repeated run is a replay; a repeated commit request aborts and changes nothing.
 const replay=[];
 assert.equal((await publishStaged(adapter(staged),scaled,{...context(),report:replay})).replay,true);
 assert.equal(replay[0].outcome,'replay');
 await assert.rejects(commitStage(openSqlite(staged),plan,context()));
 assert.deepEqual(dump(staged),dump(legacy));

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

 // Small generations for the fault matrix: 60 candidates, 2 shows each, 12 films; 25 statements per chunk.
 const small=withPrior(syntheticGeneration({films:12,candidates:60,showsPerFilm:2,showsPerCandidate:2,runId:'run-2',previousRunId:'run-1'}));
 const smallPrior=syntheticGeneration({films:12,candidates:50,showsPerFilm:1,showsPerCandidate:1,runId:'run-1'});
 const limits={maxStatements:25,maxBytes:DEFAULT_CHUNK_BYTES};
 const smallPlan=planGeneration(small,{sha256,...limits});
 const reference=database('reference',{staged:false});
 await createEpgRepository(openSqlite(reference)).publishGeneration(smallPrior);seedAttempts(reference);
 await createEpgRepository(openSqlite(reference)).publishGeneration(small);
 const expected=dump(reference);
 const fresh=async name=>{const file=database(name);await createEpgRepository(openSqlite(file)).publishGeneration(smallPrior);seedAttempts(file);return file;};
 assert.ok(smallPlan.chunks.length>=8);

 // 3. Interruption at every chunk, by a lost response before it lands and by a 500 after it landed; each resumes to the same rows.
 for(const fault of ['lost','after500'])for(let chunk=0;chunk<smallPlan.chunks.length;chunk++){
  const file=await fresh('every-'+fault+'-'+chunk),before=dump(file);
  const first=adapter(file,{[1+chunk]:fault});
  assert.equal(await stopReason(publishStaged(first,small,{...context(),limits})),'error:injected '+(fault==='lost'?'lost response':'HTTP 500 after commit'));
  assert.deepEqual(dump(file),before,'no final row before the commit');
  const report=[];
  await publishStaged(adapter(file),small,{...context(),limits,report});
  assert.equal(report[0].chunks.alreadyReceived,fault==='lost'?chunk:chunk+1);
  assert.deepEqual(dump(file),expected,fault+' at chunk '+chunk);
 }

 // 4. A failing last statement aborts its chunk whole: no staged row of that chunk, no receipt; the next run completes.
 {
  const file=await fresh('fail-last'),before=dump(file);
  const failing=adapter(file,{3:'failLast'});
  assert.match(await stopReason(publishStaged(failing,small,{...context(),limits})),/^error:.*stage_missing_table/);
  assert.equal(one(file,"SELECT COUNT(*) AS n FROM generation_stage_chunk WHERE chunk_index=2;").n,0);
  assert.equal(one(file,'SELECT (SELECT COUNT(*) FROM stage_film_generation WHERE chunk_index=2)+(SELECT COUNT(*) FROM stage_film_show WHERE chunk_index=2)+(SELECT COUNT(*) FROM stage_candidate WHERE chunk_index=2)+(SELECT COUNT(*) FROM stage_candidate_show WHERE chunk_index=2) AS n;').n,0);
  assert.deepEqual(dump(file),before);
  await publishStaged(adapter(file),small,{...context(),limits});
  assert.deepEqual(dump(file),expected);
 }

 // 5. Commit then 500: the commit landed, the run stops without a retry, and the next run sees a replay.
 {
  const file=await fresh('commit-500');
  const commitIndex=1+smallPlan.chunks.length+1;
  const first=adapter(file,{[commitIndex]:'after500'});
  assert.equal(await stopReason(publishStaged(first,small,{...context(),limits})),'error:injected HTTP 500 after commit');
  assert.equal(first.log.writes,commitIndex+1,'nothing was sent after the uncertain commit');
  assert.deepEqual(dump(file),expected);
  const report=[];
  assert.equal((await publishStaged(adapter(file),small,{...context(),limits,report})).replay,true);
  // A lost commit request did not land: the stage stays validated and the next run commits it.
  const lostFile=await fresh('commit-lost'),beforeLost=dump(lostFile);
  assert.equal(await stopReason(publishStaged(adapter(lostFile,{[commitIndex]:'lost'}),small,{...context(),limits})),'error:injected lost response');
  assert.deepEqual(dump(lostFile),beforeLost);
  assert.equal(one(lostFile,"SELECT state FROM generation_stage WHERE programme_run_id='run-2';").state,'validated');
  await publishStaged(adapter(lostFile),small,{...context(),limits});
  assert.deepEqual(dump(lostFile),expected);
 }

 // 6. A stale pointer refuses the commit with nothing written; double publish and late chunks are refused too.
 {
  const file=await fresh('stale');
  const commitIndex=1+smallPlan.chunks.length+1;
  assert.equal(await stopReason(publishStaged(adapter(file,{[commitIndex]:'lost'}),small,{...context(),limits})),'error:injected lost response');
  await createEpgRepository(openSqlite(file)).publishGeneration(syntheticGeneration({films:1,candidates:1,runId:'run-x',previousRunId:'run-1'}));
  const before=dump(file);
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context(),limits})),'pointer_moved');
  assert.deepEqual(dump(file),before);
  assert.equal(one(file,"SELECT state,failure_reason FROM generation_stage WHERE programme_run_id='run-2';").failure_reason,'pointer_moved','a stage that can never commit is failed for cleanup');
  const committed=await fresh('double');
  await publishStaged(adapter(committed),small,{...context(),limits});
  await assert.rejects(stageChunk(openSqlite(committed),smallPlan,smallPlan.chunks[0],context()),'a chunk after the commit is refused');
  await assert.rejects(commitStage(openSqlite(committed),smallPlan,context()),'a second commit is refused');
  assert.deepEqual(dump(committed),expected);
 }

 // 7. Ownership and lineage: another baseline or another owner cannot continue a stage; a changed plan is refused.
 {
  const file=await fresh('lineage'),before=dump(file);
  assert.equal(await stopReason(publishStaged(adapter(file,{5:'lost'}),small,{...context(),limits})),'error:injected lost response');
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context('owner-a','baseline-b'),limits})),'stage_baseline_changed');
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context('owner-b','baseline-a'),limits})),'stage_owned_elsewhere');
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context(),limits:{maxStatements:30,maxBytes:DEFAULT_CHUNK_BYTES}})),'stage_plan_changed');
  const changed={...small,candidates:small.candidates.slice(0,-1)};
  assert.equal(await stopReason(publishStaged(adapter(file),changed,{...context(),limits})),'stage_plan_changed');
  assert.deepEqual(dump(file),before);
  // Receipts: a checksum that differs from the plan, or a gap in the prefix, stops the run.
  ok(file,"UPDATE generation_stage_chunk SET content_sha256='tampered' WHERE programme_run_id='run-2' AND chunk_index=1;");
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context(),limits})),'chunk_conflict');
  ok(file,"UPDATE generation_stage_chunk SET content_sha256='"+smallPlan.chunks[1].sha256+"' WHERE programme_run_id='run-2' AND chunk_index=1;");
  ok(file,"DELETE FROM generation_stage_chunk WHERE programme_run_id='run-2' AND chunk_index=1;");
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context(),limits})),'chunk_receipts_out_of_order');
  assert.deepEqual(dump(file),before);
 }

 // 8. Staged rows that differ from the plan never reach the final tables: a mutated row fails the read-back, an extra or a
 // missing row fails the count validation; either way the stage is failed and the run stops.
 const loadedThenStop=async name=>{const file=await fresh(name);assert.equal(await stopReason(publishStaged(adapter(file,{[1+smallPlan.chunks.length]:'lost'}),small,{...context(),limits})),'error:injected lost response');return file;};
 for(const [name,mutation,reason] of [
  ['mutated',"UPDATE stage_candidate SET title='Tampered' WHERE observation_key=(SELECT MIN(observation_key) FROM stage_candidate);",'stage_parity_mismatch'],
  ['extra',"INSERT INTO stage_candidate_show SELECT programme_run_id,observation_key,channel_id,channel,start_ms+1,end_ms,epg_title,chunk_index FROM stage_candidate_show LIMIT 1;",'stage_validation_failed'],
  ['missing',"DELETE FROM stage_candidate_show WHERE rowid=(SELECT MIN(rowid) FROM stage_candidate_show);",'stage_validation_failed'],
 ]){
  const file=await loadedThenStop(name),before=dump(file);
  ok(file,mutation);
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context(),limits})),reason,name);
  assert.equal(one(file,"SELECT state FROM generation_stage WHERE programme_run_id='run-2';").state,'failed');
  assert.deepEqual(dump(file),before,name+' never reached a final table');
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context(),limits})),'stage_failed');
 }
 {
  // A mutation after validation is caught by the read-back too.
  const file=await fresh('validated-mutation');
  assert.equal(await stopReason(publishStaged(adapter(file,{[1+smallPlan.chunks.length+1]:'lost'}),small,{...context(),limits})),'error:injected lost response');
  ok(file,"UPDATE stage_film_show SET epg_title='Tampered' WHERE rowid=(SELECT MIN(rowid) FROM stage_film_show);");
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context(),limits})),'stage_parity_mismatch');
 }

 // 9. An oversized row is refused before any write, as is a repeated key.
 {
  const file=await fresh('oversized'),before=dump(file);
  const huge={...small,candidates:[{...small.candidates[0],description:'x'.repeat(MAX_ROW_STATEMENT_BYTES)},...small.candidates.slice(1)]};
  const quiet=adapter(file);
  assert.equal(await stopReason(publishStaged(quiet,huge,{...context(),limits})),'stage_row_too_large');
  assert.equal(quiet.log.writes,0);
  assert.equal(await readStage(openSqlite(file),'run-2'),null);
  const repeated={...small,films:[small.films[0],small.films[0],...small.films.slice(1)]};
  assert.equal(await stopReason(publishStaged(quiet,repeated,{...context(),limits})),'error:Generation rows repeat a key');
  assert.equal(quiet.log.writes,0);
  assert.deepEqual(dump(file),before);
 }

 // 10. Bounded staging-only cleanup: refused for a live stage, a failed stage is removed in batches and frees its run id, a
 // superseded stage keeps its stage row as the record of its commit; final tables never change.
 {
  const file=await loadedThenStop('cleanup'),before=dump(file);
  assert.equal(await stopReason(discardStage(openSqlite(file),'run-2',{limit:10})),'stage_not_discardable');
  // A stage left by another baseline is abandoned and discarded only on request; abandon never touches a committed stage.
  const left=await loadedThenStop('abandon'),leftBefore=dump(left);
  const abandoned=await discardStage(openSqlite(left),'run-2',{limit:10,abandon:true});
  assert.equal(abandoned.state,'failed');
  assert.equal(await readStage(openSqlite(left),'run-2'),null);
  assert.deepEqual(dump(left),leftBefore);
  const done=await fresh('abandon-published');
  await publishStaged(adapter(done),small,{...context(),limits});
  assert.equal(await stopReason(discardStage(openSqlite(done),'run-2',{limit:10,abandon:true})),'stage_not_discardable');
  ok(file,"UPDATE stage_candidate SET title='Tampered' WHERE observation_key=(SELECT MIN(observation_key) FROM stage_candidate);");
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context(),limits})),'stage_parity_mismatch');
  const cleaned=await discardStage(openSqlite(file),'run-2',{limit:10});
  assert.ok(cleaned.batches>3,'cleanup ran in bounded batches');
  assert.equal(await readStage(openSqlite(file),'run-2'),null);
  for(const table of STAGE_TABLES)assert.equal(one(file,'SELECT COUNT(*) AS n FROM '+table+';').n,0,table);
  assert.deepEqual(dump(file),before);
  await publishStaged(adapter(file),small,{...context('owner-c','baseline-c'),limits});
  assert.deepEqual(dump(file),expected,'the freed run id is staged again from another baseline');
  const third=syntheticGeneration({films:12,candidates:40,showsPerFilm:1,showsPerCandidate:1,runId:'run-3',previousRunId:'run-2'});
  await publishStaged(adapter(file),third,{...context('owner-c','baseline-c'),limits});
  assert.equal(one(file,"SELECT state FROM generation_stage WHERE programme_run_id='run-2';").state,'superseded');
  const afterThird=dump(file);
  const superseded=await discardStage(openSqlite(file),'run-2',{limit:10});
  assert.equal(superseded.stageRowKept,true);
  assert.equal(one(file,"SELECT state FROM generation_stage WHERE programme_run_id='run-2';").state,'superseded');
  assert.equal(one(file,"SELECT COUNT(*) AS n FROM stage_candidate WHERE programme_run_id='run-2';").n,0);
  assert.equal(one(file,"SELECT COUNT(*) AS n FROM stage_candidate WHERE programme_run_id='run-3';").n,40);
  assert.deepEqual(dump(file),afterThird);
 }

 // 11. Two runs of different generations against the same pointer: the first commit wins, the second is refused unwritten.
 {
  const file=await fresh('race');
  const rival=syntheticGeneration({films:12,candidates:30,showsPerFilm:1,showsPerCandidate:1,runId:'run-r',previousRunId:'run-1'});
  const commitIndex=1+smallPlan.chunks.length+1;
  assert.equal(await stopReason(publishStaged(adapter(file,{[commitIndex]:'lost'}),small,{...context(),limits})),'error:injected lost response');
  await publishStaged(adapter(file),rival,{...context('owner-r','baseline-r'),limits});
  const before=dump(file);
  assert.equal(await stopReason(publishStaged(adapter(file),small,{...context(),limits})),'pointer_moved');
  assert.deepEqual(dump(file),before);
  assert.equal(one(file,'SELECT programme_run_id FROM published_generation;').programme_run_id,'run-r');
 }

 // 12. Repository statements guard themselves too: a chunk for a stage that does not exist, or before opening, aborts whole.
 {
  const file=database('guards');
  const guards=planGeneration(syntheticGeneration({films:2,candidates:3,runId:'run-g'}),{sha256});
  const own=context();
  await assert.rejects(stageChunk(openSqlite(file),guards,guards.chunks[0],own));
  await openStage(openSqlite(file),guards,own);
  await assert.rejects(stageChunk(openSqlite(file),guards,guards.chunks[0],{...own,owner:'owner-z'}));
  await assert.rejects(stageChunk(openSqlite(file),guards,guards.chunks[0],{...own,nonce:'nonce-other'}),'another nonce cannot write');
  await assert.rejects(stageChunk(openSqlite(file),guards,guards.chunks[0],{...own,fence:2}),'another claim generation cannot write');
  await assert.rejects(commitStage(openSqlite(file),guards,own),'an unvalidated stage cannot commit');
  await stageChunk(openSqlite(file),guards,guards.chunks[0],own);
  await validateStage(openSqlite(file),guards,own);
  assert.equal(one(file,"SELECT state FROM generation_stage WHERE programme_run_id='run-g';").state,'validated');
 }

 // 13. One claimant at a time. Two executions of the same baseline share the owner token, so the claim (nonce and claim
 // generation) is what makes one of them the only writer; a claim is taken over only after it expired, and a replaced claimant
 // is refused at its next write. Uncertain writes stay read-back based: nothing is retried.
 {
  const n=smallPlan.chunks.length,TTL=STAGE_CLAIM_TTL_MS,stageOf=file=>one(file,"SELECT state,claim_nonce,claim_generation FROM generation_stage WHERE programme_run_id='run-2';");
  const staged=file=>one(file,"SELECT (SELECT COUNT(*) FROM generation_stage_chunk)+0 AS receipts,(SELECT COUNT(*) FROM stage_film_generation)+(SELECT COUNT(*) FROM stage_film_show)+(SELECT COUNT(*) FROM stage_candidate)+(SELECT COUNT(*) FROM stage_candidate_show) AS rows;");
  const execution=(file,ctx,faults={},hooks={})=>{const db=adapter(file,faults,hooks),report=[];return {db,report,ctx,run:()=>publishStaged(db,small,{...ctx,limits,report})};};
  // a) While A holds a live claim, B of the same baseline is refused after one claim request that changes nothing.
  {
   const file=await fresh('claim-live'),T=DAY*executions;
   let b=null;
   const a=execution(file,context(undefined,undefined,{now:at(T)}),{},{3:async()=>{b=execution(file,context(undefined,undefined,{now:at(T+60000)}));b.reason=await stopReason(b.run());}});
   await a.run();
   assert.equal(b.reason,'stage_claimed_elsewhere');
   assert.equal(b.db.log.writes,1,'the refused claim is the only request B sent');
   assert.deepEqual(dump(file),expected);
   assert.deepEqual(staged(file),{receipts:n,rows:smallPlan.rows.length});
   assert.equal(stageOf(file).claim_generation,1);
  }
  // b) A stops sending mid-load; once its claim expired B takes it over, resumes after A's receipts and commits. A is then
  // refused at its very next chunk and sends nothing more. A foreign baseline stays NO-GO without a write meanwhile.
  {
   const file=await fresh('claim-takeover'),T=DAY*executions;
   let b=null,foreign=null;
   const a=execution(file,context(undefined,undefined,{now:at(T)}),{},{4:async()=>{
    const other=adapter(file);foreign=await stopReason(publishStaged(other,small,{...context('owner-a','baseline-b',{now:at(T)}),limits}));assert.equal(other.log.writes,0);
    b=execution(file,context(undefined,undefined,{now:at(T+TTL+1000)}));await b.run();}});
   assert.equal(await stopReason(a.run()),'stage_claim_lost');
   assert.equal(foreign,'stage_baseline_changed');
   assert.equal(b.report[0].outcome,'committed');
   assert.deepEqual(b.report[0].claim,{generation:2,takenOver:true,previous:{generation:1,expiresAt:new Date(Date.parse(at(T)())+TTL).toISOString()}});
   assert.equal(b.report[0].chunks.alreadyReceived,3,'B resumes after the chunks A sent');
   assert.equal(a.db.log.writes,5,'A sent the refused chunk and nothing after it');
   assert.deepEqual(staged(file),{receipts:n,rows:smallPlan.rows.length},'no chunk landed twice');
   assert.deepEqual(dump(file),expected);
  }
  // c) A is validated and about to commit when B takes over and loses its own commit response. A's commit is refused, and A can
  // no longer chunk, validate, commit or fail the stage; B's claim is live, so A cannot take it back either. C commits later.
  {
   const file=await fresh('claim-commit'),before=dump(file),T=DAY*executions;
   const actx=context(undefined,undefined,{now:at(T)});
   let b=null;
   const a=execution(file,actx,{},{[n+2]:async()=>{b=execution(file,context(undefined,undefined,{now:at(T+TTL+1000)}),{1:'lost'});b.reason=await stopReason(b.run());}});
   assert.equal(await stopReason(a.run()),'stage_claim_lost');
   assert.equal(b.reason,'error:injected lost response');
   assert.deepEqual(dump(file),before,'the stale claimant committed nothing');
   const stale={...actx,fence:1,now:at(T+TTL+2000)};
   for(const write of [()=>stageChunk(openSqlite(file),smallPlan,smallPlan.chunks[0],stale),()=>validateStage(openSqlite(file),smallPlan,stale),()=>commitStage(openSqlite(file),smallPlan,stale)])await assert.rejects(write());
   await failStage(openSqlite(file),'run-2',{...stale,reason:'stale'});
   await claimStage(openSqlite(file),smallPlan,stale);
   assert.deepEqual(stageOf(file),{state:'validated',claim_nonce:b.ctx.nonce,claim_generation:2});
   assert.deepEqual(dump(file),before);
   const c=execution(file,context());await c.run();
   assert.equal(c.report[0].claim.generation,3);
   assert.deepEqual(dump(file),expected);
  }
  // d) A validation request from a replaced claimant is refused as a lost claim, not booked as a count mismatch.
  {
   const file=await fresh('claim-validate'),T=DAY*executions;
   let b=null;
   const a=execution(file,context(undefined,undefined,{now:at(T)}),{},{[n+1]:async()=>{b=execution(file,context(undefined,undefined,{now:at(T+TTL+1000)}),{1:'lost'});b.reason=await stopReason(b.run());}});
   assert.equal(await stopReason(a.run()),'stage_claim_lost');
   assert.equal(b.reason,'error:injected lost response');
   assert.equal(stageOf(file).state,'loading');
   const c=execution(file,context());await c.run();
   assert.deepEqual(dump(file),expected);
  }
  // e) An uncertain claim request is not retried: if it landed, the claim belongs to the stopped execution until it expires.
  {
   const file=await fresh('claim-uncertain'),T=DAY*executions;
   assert.equal(await stopReason(execution(file,context(undefined,undefined,{now:at(T)}),{2:'lost'}).run()),'error:injected lost response');
   const b=execution(file,context(undefined,undefined,{now:at(T+TTL+1000)}),{0:'after500'});
   assert.equal(await stopReason(b.run()),'error:injected HTTP 500 after commit');
   assert.equal(b.db.log.writes,1);
   assert.equal(stageOf(file).claim_nonce,b.ctx.nonce);
   assert.equal(await stopReason(execution(file,context(undefined,undefined,{now:at(T+TTL+2000)})).run()),'stage_claimed_elsewhere');
   const d=execution(file,context(undefined,undefined,{now:at(T+2*TTL+2000)}));await d.run();
   assert.equal(d.report[0].claim.generation,3);
   assert.deepEqual(dump(file),expected);
  }
  // f) Two executions open the same stage at once: the second insert is refused by the primary key and B owns the stage.
  {
   const file=await fresh('claim-open'),T=DAY*executions;
   let b=null;
   const a=execution(file,context(undefined,undefined,{now:at(T)}),{},{0:async()=>{b=execution(file,context(undefined,undefined,{now:at(T)}),{3:'lost'});b.reason=await stopReason(b.run());}});
   assert.equal(await stopReason(a.run()),'stage_claimed_elsewhere');
   assert.equal(b.reason,'error:injected lost response');
   assert.deepEqual(stageOf(file),{state:'loading',claim_nonce:b.ctx.nonce,claim_generation:1});
  }
  // The claim TTL is bounded.
  for(const claimTtlMs of [1000,2*DAY])assert.match(await stopReason(publishStaged(adapter(database('ttl-'+claimTtlMs)),small,{...context(),limits,claimTtlMs})),/Stage claim TTL out of bounds/);
 }
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('Generation stage: 1.25x published and withheld equality with publishGeneration, bounded deterministic chunks, interruption at every chunk (lost and 500), failing last statement, commit-then-500 and lost commit, stale pointer, double publish, baseline/owner/plan fences, receipt conflicts and gaps, mutated/extra/missing staged rows, oversized and repeated rows, bounded cleanup, concurrent commits and exclusive fenced stage claims passed');
