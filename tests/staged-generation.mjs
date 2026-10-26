import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createEpgRepository} from '../src/epg-repository.js';
import {renderSql} from '../scripts/d1-backfill.mjs';
import {expectedStatements,measureGenerationUnit,syntheticGeneration} from '../scripts/d1-generation-size.mjs';

// The design prototype of the staged generation import (docs/reference/data/staged-generation.sql) is executable:
// staging a generation in chunks and committing it writes exactly what publishGeneration writes, the commit is a fixed
// handful of statements whatever the generation size, and every guard aborts its batch with nothing written.
const migration=fs.readFileSync('migrations/0001_schema_v1.sql','utf8');
const prototype=fs.readFileSync('docs/reference/data/staged-generation.sql','utf8');
assert.match(prototype,/^-- DESIGN PROTOTYPE\. NOT A MIGRATION\./);
assert.deepEqual(fs.readdirSync('migrations'),['0001_schema_v1.sql'],'the prototype is not a migration');
const sections=Object.fromEntries(prototype.split(/^-- name: /m).slice(1).map(block=>{const [name,...rest]=block.split('\n');return [name.trim(),rest.join('\n').split('\n').filter(line=>!line.startsWith('--')).join('\n').split(/;\s*\n/).map(text=>text.trim()).filter(Boolean)];}));
for(const name of ['ddl','open_stage','chunk_guard','chunk_state','chunk_receipt','validate','commit_published','commit_withheld','fail_stage','discard_stage'])assert.ok(sections[name]?.length,name);
const literal=value=>renderSql('?',[value]);
const bind=(statements,params)=>statements.map(sql=>sql.replace(/:([a-z_]+)/g,(match,name)=>{if(!(name in params))throw new Error('Unbound '+name);return literal(params[name]);})+';');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-staged-generation-'));
const sqlite=(file,input,{json=false}={})=>spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input,encoding:'utf8',maxBuffer:1<<30});
const ok=(file,input)=>{const result=sqlite(file,input);assert.equal(result.status,0,result.stderr);};
const batch=(file,statements)=>sqlite(file,'BEGIN;\n'+statements.join('\n')+'\nCOMMIT;\n');
const rows=(file,sql)=>{const result=sqlite(file,sql,{json:true});assert.equal(result.status,0,result.stderr);return result.stdout.trim()?JSON.parse(result.stdout):[];};
const FINAL=['programme_generation','published_generation','film_generation','film_show','film_epg_last_airing','candidate','candidate_generation','candidate_show'];
const dump=file=>Object.fromEntries(FINAL.map(table=>[table,rows(file,'SELECT * FROM '+table+';').map(row=>JSON.stringify(row)).sort()]));
function sqliteAdapter(file){const state={buffer:null};return {run(sql,params=[]){const statement=renderSql(sql,params)+';';if(state.buffer)state.buffer.push(statement);else ok(file,statement);return Promise.resolve();},get(sql,params=[]){return Promise.resolve(rows(file,renderSql(sql,params)+';')[0]??null);},all(sql,params=[]){return Promise.resolve(rows(file,renderSql(sql,params)+';'));},async transaction(fn){if(state.buffer)return fn();state.buffer=[];try{const result=await fn();const run=batch(file,state.buffer);if(run.status!==0)throw new Error(run.stderr);return result;}finally{state.buffer=null;}}};}
function database(name,{staging=true}={}){
 const file=path.join(root,name+'.sqlite');
 ok(file,migration);
 if(staging)ok(file,sections.ddl.join(';\n')+';');
 const films=[];for(let index=0;index<12;index++)films.push("('film:"+('f'+index+'-'.repeat(24)).slice(0,24)+"',1,NULL,'Film "+index+"','2026-10-26T00:00:00.000Z')");
 ok(file,'INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES '+films.join(',')+';');
 return file;
}
// Stage one generation in chunks: each chunk batch is guard, state, rows, receipt, executed as one transaction.
function stageRows(generation,chunk){
 const run=generation.programmeRunId,statements=[];
 for(const film of generation.films){
  statements.push({rows:1,sql:renderSql('INSERT INTO stage_film_generation (programme_run_id,film_id,chunk_index) VALUES (?,?,?);',[run,film.filmId,chunk(statements.length)])});
  for(const show of film.shows)statements.push({rows:1,sql:renderSql('INSERT INTO stage_film_show (programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason,chunk_index) VALUES (?,?,?,?,?,?,?,?,?,?);',[run,film.filmId,show.channelId,show.channel??null,show.startMs,show.endMs??null,show.epgTitle??null,show.basis??null,show.matchReason??null,chunk(statements.length)])});
 }
 for(const candidate of generation.candidates){
  const observation=JSON.stringify({schemaVersion:1,title:candidate.title,normalizedTitle:candidate.normalizedTitle,year:candidate.year??null,rawTitles:candidate.rawTitles||[],durations:candidate.durations||[],description:candidate.description??null,firstAiring:candidate.firstAiringMs??null,lastAiring:candidate.lastAiringMs??null,airings:candidate.airings??null,confirmedTmdbId:candidate.confirmedTmdbId??null});
  statements.push({rows:1,sql:renderSql('INSERT INTO stage_candidate (programme_run_id,observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,evidence_key,chunk_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);',[run,candidate.observationKey,candidate.title,candidate.normalizedTitle,candidate.year??null,JSON.stringify(candidate.rawTitles||[]),JSON.stringify(candidate.durations||[]),candidate.description??null,candidate.firstAiringMs??null,candidate.lastAiringMs??null,candidate.airings??null,candidate.confirmedTmdbId??null,observation,candidate.activity??null,candidate.lastSeenAt??null,candidate.lastSeenProgrammeRunId??null,candidate.seenInLatest?1:0,candidate.evidenceKey,chunk(statements.length)])});
  for(const show of candidate.shows)statements.push({rows:1,sql:renderSql('INSERT INTO stage_candidate_show (programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title,chunk_index) VALUES (?,?,?,?,?,?,?,?);',[run,candidate.observationKey,show.channelId,show.channel??null,show.startMs,show.endMs??null,show.epgTitle??null,chunk(statements.length)])});
 }
 return statements;
}
function stageGeneration(file,generation,{chunkSize=7,owner='owner-a',baseline='sha-a',now='2026-10-26T02:00:00.000Z',through=Infinity}={}){
 const run=generation.programmeRunId;
 const all=stageRows(generation,index=>Math.floor(index/chunkSize));
 const chunks=[];for(let index=0;index<all.length;index+=chunkSize)chunks.push(all.slice(index,index+chunkSize));
 const counts={film_count:generation.films.length,film_show_count:generation.films.reduce((sum,film)=>sum+film.shows.length,0),candidate_count:generation.candidates.length,candidate_show_count:generation.candidates.reduce((sum,candidate)=>sum+candidate.shows.length,0)};
 const params={run,baseline,phase:generation.phase,published_at:generation.publishedAt??null,expected:generation.expectedProgrammeRunId??null,owner,now,chunk_count:chunks.length,...counts};
 const opened=batch(file,bind(sections.open_stage,params));assert.equal(opened.status,0,opened.stderr);
 const chunkBatch=(index,extra={})=>[...bind(sections.chunk_guard,{...params,...extra}),...bind(sections.chunk_state,{...params,...extra}),...chunks[index].map(item=>item.sql),...bind(sections.chunk_receipt,{...params,...extra,chunk:index,row_count:chunks[index].length,sha:'sha-chunk-'+index})];
 for(let index=0;index<Math.min(through,chunks.length);index++){const result=batch(file,chunkBatch(index));assert.equal(result.status,0,result.stderr);}
 return {params,chunks,chunkBatch};
}
const g1=syntheticGeneration({films:5,candidates:30,showsPerFilm:2,showsPerCandidate:2,runId:'run-1'});
const g2Base=syntheticGeneration({films:6,candidates:40,showsPerFilm:2,showsPerCandidate:3,runId:'run-2',previousRunId:'run-1'});
// Overlap with run-1: c0..c24 stay (c0..c4 with new evidence), c25..c29 disappear, c30..c39 are new.
const g2={...g2Base,candidates:g2Base.candidates.filter((_,index)=>index<25||index>=30).map((candidate,index)=>index<5?{...candidate,evidenceKey:candidate.evidenceKey+'|changed'}:candidate)};
const seedAttempts=file=>ok(file,"UPDATE candidate SET attempts=3,last_attempt_at='2026-10-26T01:30:00.000Z',retry_at='2026-10-27T00:00:00.000Z',terminal_reason='repeated_uncertain_match' WHERE observation_key IN (SELECT observation_key FROM candidate ORDER BY observation_key LIMIT 10);");

try{
 // 1. Equivalence with publishGeneration for a published generation over a prior one.
 const direct=database('direct',{staging:false}),staged=database('staged');
 for(const file of [direct,staged]){await createEpgRepository(sqliteAdapter(file)).publishGeneration(g1);seedAttempts(file);}
 const priorStaged=dump(staged);
 await createEpgRepository(sqliteAdapter(direct)).publishGeneration(g2);
 const {params,chunks,chunkBatch}=stageGeneration(staged,g2);
 assert.equal(chunks.length>5,true);
 assert.deepEqual(dump(staged),priorStaged,'staging leaves every final table unchanged');
 // A chunk sent twice, by an uncertain retry or a second executor, aborts as a whole: no duplicate rows, receipt unchanged.
 const duplicate=batch(staged,chunkBatch(2));
 assert.notEqual(duplicate.status,0);
 assert.equal(rows(staged,"SELECT COUNT(*) AS n FROM generation_stage_chunk WHERE programme_run_id='run-2';")[0].n,chunks.length);
 // Another owner, or another baseline, cannot write into this stage.
 assert.notEqual(batch(staged,chunkBatch(0,{owner:'owner-b'})).status,0);
 assert.notEqual(batch(staged,chunkBatch(0,{baseline:'sha-b'})).status,0);
 // A commit before validation aborts with nothing written.
 assert.notEqual(batch(staged,bind(sections.commit_published,params)).status,0);
 assert.deepEqual(dump(staged),priorStaged);
 assert.equal(batch(staged,bind(sections.validate,params)).status,0);
 assert.equal(rows(staged,"SELECT state FROM generation_stage WHERE programme_run_id='run-2';")[0].state,'validated');
 // The commit: one batch, a fixed handful of statements, a few KB.
 const commit=bind(sections.commit_published,params);
 assert.equal(commit.length<=14,true);
 assert.equal(Buffer.byteLength(commit.join('\n'))<12*1024,true);
 const committed=batch(staged,commit);
 assert.equal(committed.status,0,committed.stderr);
 assert.deepEqual(dump(staged),dump(direct),'staged commit writes exactly what publishGeneration writes');
 assert.equal(rows(staged,"SELECT state FROM generation_stage WHERE programme_run_id='run-2';")[0].state,'published');
 // Double publish and a late chunk both abort.
 assert.notEqual(batch(staged,commit).status,0);
 assert.notEqual(batch(staged,chunkBatch(0)).status,0);
 assert.deepEqual(dump(staged),dump(direct));
 // discard_stage refuses a published stage and only ever deletes staging rows.
 assert.equal(batch(staged,bind(sections.discard_stage,{...params,limit:50})).status,0);
 assert.equal(rows(staged,"SELECT COUNT(*) AS n FROM stage_candidate WHERE programme_run_id='run-2';")[0].n,g2.candidates.length);

 // 2. The commit is fenced on the published pointer: a generation published meanwhile aborts the batch.
 const fenced=database('fenced');
 await createEpgRepository(sqliteAdapter(fenced)).publishGeneration(g1);
 const late=stageGeneration(fenced,g2);
 assert.equal(batch(fenced,bind(sections.validate,late.params)).status,0);
 await createEpgRepository(sqliteAdapter(fenced)).publishGeneration(syntheticGeneration({films:1,candidates:1,runId:'run-x',previousRunId:'run-1'}));
 const beforeFence=dump(fenced);
 assert.notEqual(batch(fenced,bind(sections.commit_published,late.params)).status,0);
 assert.deepEqual(dump(fenced),beforeFence);
 assert.equal(batch(fenced,bind(sections.fail_stage,{...late.params,reason:'pointer_moved'})).status,0);
 // Bounded cleanup: each batch deletes at most :limit rows per table, children first; repeated until nothing is left.
 const staged2=()=>rows(fenced,"SELECT (SELECT COUNT(*) FROM stage_film_generation)+(SELECT COUNT(*) FROM stage_film_show)+(SELECT COUNT(*) FROM stage_candidate)+(SELECT COUNT(*) FROM stage_candidate_show)+(SELECT COUNT(*) FROM generation_stage_chunk)+(SELECT COUNT(*) FROM generation_stage) AS n;")[0].n;
 let rounds=0;for(let before=staged2();before>0;rounds++){assert.equal(batch(fenced,bind(sections.discard_stage,{...late.params,limit:20})).status,0);const after=staged2();assert.ok(after<before,'every cleanup batch makes progress');before=after;}
 assert.ok(rounds>2,'cleanup ran in several bounded batches');
 assert.deepEqual(dump(fenced),beforeFence,'discarding a failed stage never touches final tables');
 // A discarded failed stage frees its run id: the same run can be staged again, for example from a changed baseline.
 const restaged=stageGeneration(fenced,g2,{baseline:'sha-b',owner:'owner-b'});
 assert.equal(batch(fenced,bind(sections.validate,restaged.params)).status,0);
 assert.notEqual(batch(fenced,bind(sections.commit_published,restaged.params)).status,0,'still fenced on the pointer');

 // 3. Chunks load in order: a child row whose parent chunk is missing aborts its whole chunk (stage foreign keys).
 // An executor that stops at an uncertain chunk leaves the stage loading; it cannot validate or commit until resumed.
 const gap=database('gap');
 await createEpgRepository(sqliteAdapter(gap)).publishGeneration(g1);
 const gapped=stageGeneration(gap,g2,{through:3});
 const parentless=gapped.chunks.findIndex((chunk,index)=>index>3&&chunk[0].sql.startsWith('INSERT INTO stage_candidate_show'));
 assert.ok(parentless>3,"a chunk that starts with a child row exists");
 assert.notEqual(batch(gap,gapped.chunkBatch(parentless)).status,0);
 assert.equal(batch(gap,bind(sections.validate,gapped.params)).status,0);
 assert.equal(rows(gap,"SELECT state FROM generation_stage WHERE programme_run_id='run-2';")[0].state,'loading');
 assert.notEqual(batch(gap,bind(sections.commit_published,gapped.params)).status,0);
 // Resume from the first chunk without a receipt; validation and commit then match the direct publication.
 for(let index=3;index<gapped.chunks.length;index++)assert.equal(batch(gap,gapped.chunkBatch(index)).status,0);
 assert.equal(batch(gap,bind(sections.validate,gapped.params)).status,0);
 assert.equal(batch(gap,bind(sections.commit_published,gapped.params)).status,0);
 const directAgain=database('direct-again',{staging:false});
 for(const generation of [g1,g2])await createEpgRepository(sqliteAdapter(directAgain)).publishGeneration(generation);
 assert.deepEqual(dump(gap),dump(directAgain));

 // 4. A failing last statement inside a chunk batch leaves no staged row of that chunk.
 const failing=database('failing');
 await createEpgRepository(sqliteAdapter(failing)).publishGeneration(g1);
 const partial=stageGeneration(failing,g2,{through:1});
 const broken=[...partial.chunkBatch(1).slice(0,-1),"INSERT INTO stage_missing_table VALUES (1);"];
 assert.notEqual(batch(failing,broken).status,0);
 assert.equal(rows(failing,"SELECT COUNT(*) AS n FROM stage_candidate WHERE chunk_index=1;")[0].n+rows(failing,"SELECT COUNT(*) AS n FROM stage_film_generation WHERE chunk_index=1;")[0].n+rows(failing,"SELECT COUNT(*) AS n FROM stage_film_show WHERE chunk_index=1;")[0].n,0);

 // 5. Withheld generations commit to the same rows as publishGeneration with phase withheld.
 const withheld={...syntheticGeneration({films:3,candidates:12,runId:'run-w'}),phase:'withheld'};delete withheld.expectedProgrammeRunId;
 const directW=database('direct-w',{staging:false}),stagedW=database('staged-w');
 for(const file of [directW,stagedW]){await createEpgRepository(sqliteAdapter(file)).publishGeneration(g1);seedAttempts(file);}
 await createEpgRepository(sqliteAdapter(directW)).publishGeneration(withheld);
 const w=stageGeneration(stagedW,withheld);
 assert.equal(batch(stagedW,bind(sections.validate,w.params)).status,0);
 assert.notEqual(batch(stagedW,bind(sections.commit_published,w.params)).status,0,'a withheld stage cannot be published');
 assert.equal(batch(stagedW,bind(sections.commit_withheld,w.params)).status,0);
 assert.deepEqual(dump(stagedW),dump(directW));

 // 6. Sizes. Today's unit grows linearly; the staged commit does not.
 for(const shape of [{films:3,showsPerFilm:2,candidates:7,showsPerCandidate:3},{films:0,showsPerFilm:1,candidates:5,showsPerCandidate:0},{films:4,showsPerFilm:0,candidates:0,showsPerCandidate:1}]){
  const measured=await measureGenerationUnit(shape);
  assert.equal(measured.statements,expectedStatements(shape),JSON.stringify(shape));
 }
 const small=await measureGenerationUnit({films:10,candidates:100}),large=await measureGenerationUnit({films:10,candidates:1000});
 assert.equal(large.largestStatement.kind,'UPDATE candidate');
 assert.equal(large.largestStatement.bytes>8*small.largestStatement.bytes,true,'the absent-mark statement grows with the candidate count');
 const big=syntheticGeneration({films:12,candidates:2000,showsPerFilm:2,showsPerCandidate:2,runId:'run-big',previousRunId:null});
 const bigFile=database('big');
 const bigStage=stageGeneration(bigFile,big,{chunkSize:500});
 assert.equal(batch(bigFile,bind(sections.validate,bigStage.params)).status,0);
 const bigCommit=bind(sections.commit_published,bigStage.params);
 assert.equal(bigCommit.length,commit.length,'the commit statement count is independent of the generation size');
 assert.equal(batch(bigFile,bigCommit).status,0);
 assert.equal(rows(bigFile,"SELECT COUNT(*) AS n FROM candidate_show WHERE programme_run_id='run-big';")[0].n,4000);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('Staged generation prototype: chunked staging plus one set-based commit equals publishGeneration (published and withheld), staging leaves final tables untouched, owner/baseline/chunk/pointer/validation guards abort whole batches, failed last statement, resume after a missing chunk, double publish, staging-only discard, and size-independent commit passed');
