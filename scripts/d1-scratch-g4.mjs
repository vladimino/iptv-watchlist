// AIR-174. G4 harness: the staged generation import (ADR-0021) against the isolated scratch D1 database, with synthetic data
// only. It never reads R2, never touches the database iptv, and refuses any target whose live uuid and name are not the
// configured scratch database. Every command that writes is separately approved by the owner and needs its own flag:
// --apply-schema and --run need --approved-scratch-writes, --cleanup needs --approved-cleanup. --plan sends nothing and reads
// no credential; --preflight only reads. Reports go to an absolute directory outside the repository and hold no credential.
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEpgRepository,pagedAll,replayGeneration} from '../src/epg-repository.js';
import {DEFAULT_CHUNK_BYTES,PUBLISH_BUDGET_MS,StageStop,commitStage,discardStage,failStage,planGeneration,publishStaged,readStage} from '../src/generation-stage.js';
import {D1Error,DEFAULT_MAX_BATCH_BYTES,DEFAULT_MAX_BATCH_STATEMENTS,TARGET_DATABASE_NAME,createD1Adapter,endpointFor,stageOwner} from './d1-backfill.mjs';
import {syntheticGeneration} from './d1-generation-size.mjs';
import {ExportError} from './migration-export.mjs';
import {openSqlite} from './offline-import.mjs';

export const SCRATCH_DATABASE_NAME='iptv-atomicity-scratch';
export const RUN_IDS=Object.freeze({prior:'g4-prior',scaled:'g4-scaled',rival:'g4-rival'});
export const FINAL_TABLES=['programme_generation','published_generation','film_generation','film_show','film_epg_last_airing','candidate','candidate_generation','candidate_show'];
export const MIGRATIONS=['migrations/0001_schema_v1.sql','migrations/0002_generation_stage.sql'];
// The claim TTL is the minimum the stage accepts, so the planned takeovers wait about a minute each.
export const CLAIM_TTL_MS=60000;
// full: the ADR-0021 GO/NO-GO size (prior at today's 22,199 candidates, then 1.25x). small: the same scenario for tests.
export const SCALES=Object.freeze({
 full:{prior:{films:2300,candidates:22199},scaled:{films:2300,candidates:27749},rival:{films:4,candidates:40},showsPerFilm:2,showsPerCandidate:2,limits:{}},
 small:{prior:{films:12,candidates:50},scaled:{films:12,candidates:60},rival:{films:2,candidates:5},showsPerFilm:2,showsPerCandidate:2,limits:{maxStatements:25,maxBytes:DEFAULT_CHUNK_BYTES}},
});
const REPO_ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
const sleepFor=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

// The scratch target from the local environment only. The production database name and id are refused outright.
export function readScratchTarget(env=process.env){
 const accountId=String(env.D1_BACKFILL_ACCOUNT_ID||'').trim(),apiToken=String(env.D1_BACKFILL_API_TOKEN||'').trim();
 const databaseId=String(env.D1_BACKFILL_SCRATCH_DATABASE_ID||'').trim(),databaseName=String(env.D1_G4_SCRATCH_DATABASE_NAME||SCRATCH_DATABASE_NAME).trim();
 if(!/^[0-9a-f]{32}$/.test(accountId))throw new ExportError('configuration','D1_BACKFILL_ACCOUNT_ID must be the 32-character account id');
 if(!apiToken)throw new ExportError('configuration','D1_BACKFILL_API_TOKEN is required in the environment');
 if(!/^[0-9a-f-]{36}$/.test(databaseId))throw new ExportError('configuration','D1_BACKFILL_SCRATCH_DATABASE_ID must be the scratch database uuid');
 if(databaseName===TARGET_DATABASE_NAME||!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(databaseName))throw new ExportError('configuration','The scratch database name is not a scratch database name');
 if(String(env.D1_BACKFILL_DATABASE_ID||'').trim()===databaseId)throw new ExportError('configuration','The scratch database must not be the target database');
 return {accountId,apiToken,databaseId,databaseName,endpoint:endpointFor(env.D1_BACKFILL_ENDPOINT),maxBatchStatements:DEFAULT_MAX_BATCH_STATEMENTS,maxBatchBytes:DEFAULT_MAX_BATCH_BYTES};
}

// The deterministic synthetic generations. The 1.25x generation changes five evidence keys of the prior one, as the tests do.
export function generations(scale='full'){
 const size=SCALES[scale];if(!size)throw new ExportError('configuration','Unknown scale '+scale);
 const shape={showsPerFilm:size.showsPerFilm,showsPerCandidate:size.showsPerCandidate};
 const prior=syntheticGeneration({...size.prior,...shape,runId:RUN_IDS.prior,previousRunId:null});
 const raw=syntheticGeneration({...size.scaled,...shape,runId:RUN_IDS.scaled,previousRunId:RUN_IDS.prior});
 const scaled={...raw,candidates:raw.candidates.map((candidate,index)=>index<5?{...candidate,evidenceKey:candidate.evidenceKey+'|changed'}:candidate)};
 const rival=syntheticGeneration({...size.rival,...shape,runId:RUN_IDS.rival,previousRunId:RUN_IDS.prior});
 return {prior,scaled,rival,films:Math.max(size.prior.films,size.scaled.films,size.rival.films),limits:size.limits,baseline:sha256('air-174-g4-synthetic-v1:'+scale)};
}

// Every statement of a migration file, comments removed; the files contain no ';' other than statement terminators.
export function migrationStatements(file){
 const text=fs.readFileSync(path.join(REPO_ROOT,file),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n');
 return text.split(/;\s*$/m).map(statement=>statement.trim()).filter(Boolean);
}
export function migrationObjects(file){return [...fs.readFileSync(path.join(REPO_ROOT,file),'utf8').matchAll(/CREATE (TABLE|INDEX) ([a-z_]+)/g)].map(match=>({type:match[1].toLowerCase(),name:match[2]}));}

// Which kind of stage request a statement list is; only statement shapes are logged, never values.
export function requestKind(statements){
 const first=statements[0]?.[0]||'',last=statements.at(-1)?.[0]||'';
 if(/^\s*INSERT INTO programme_generation/.test(first))return 'commit';
 if(/^\s*INSERT INTO generation_stage \(programme_run_id,baseline_sha256,phase,published_at/.test(first))return 'open';
 if(/^\s*UPDATE generation_stage SET claim_nonce/.test(first))return 'claim';
 if(/^\s*INSERT INTO generation_stage_chunk/.test(last))return 'chunk';
 if(statements.length===2&&/state='validated'/.test(statements[1][0]))return 'validate';
 if(/^\s*UPDATE generation_stage SET state='failed'/.test(first))return 'fail';
 if(/^\s*INSERT INTO film /.test(first))return 'seed_films';
 if(/^\s*(CREATE|UPDATE schema_contract|INSERT INTO schema_contract)/.test(first))return 'schema';
 if(/^\s*DELETE /.test(first))return 'discard';
 return 'other';
}

// Request log: client wall time per HTTP request and the D1 server time it reports (meta.duration summed over statements).
function instrument(fetchImpl,log,clock,current){
 return async(url,init={})=>{
  // A request outside a tagged stage write is a describe, a read, or a write the harness sends itself (a fence probe).
  const sql=init.body?JSON.parse(init.body).sql:null,started=clock();
  const entry={method:init.method||'GET',kind:current.kind||(sql==null?'describe':/^\s*(SELECT|PRAGMA)\b/i.test(sql)?'read':'direct_write'),statements:current.statements??(sql==null?0:1),bytes:sql==null?0:Buffer.byteLength(sql,'utf8'),fault:current.fault||null,status:null,clientMs:null,serverMs:null};
  try{
   const response=await fetchImpl(url,init);entry.status=response.status;
   try{const payload=await response.clone().json();const durations=(Array.isArray(payload?.result)?payload.result:[]).map(item=>Number(item?.meta?.duration)).filter(Number.isFinite);entry.serverMs=durations.length?Math.round(durations.reduce((sum,value)=>sum+value,0)*1000)/1000:null;}catch{}
   return response;
  }catch(error){entry.error=error?.name||'error';throw error;}
  finally{entry.clientMs=clock()-started;log.push(entry);}
 };
}

// One execution's adapter over the D1 adapter: it buffers a write request as the stage code builds it, tags it for the log,
// and can inject the scenario's faults: 'crash' stops before the request is sent (an uncertain write, as a lost connection),
// 'failLast' appends a failing statement so the whole request must roll back. hooks run before a request is sent.
function scenarioAdapter(base,current,{fault=()=>null,hooks=[]}={}){
 let buffer=null;const state={writes:0,kinds:[]};
 const send=async statements=>{
  if(!statements.length)return;
  const index=state.writes++,kind=requestKind(statements);state.kinds.push(kind);
  for(const hook of hooks)await hook({index,kind,statements});
  const injected=fault({index,kind,statements});
  if(injected==='crash')throw new D1Error('write_uncertain','G4 harness: simulated crash before the request was sent',{simulated:true});
  Object.assign(current,{kind,statements:statements.length+(injected==='failLast'?1:0),fault:injected||null});
  try{await base.transaction(async()=>{for(const [sql,params] of statements)await base.run(sql,params);if(injected==='failLast')await base.run('INSERT INTO g4_missing_table (id) VALUES (1)');});}
  finally{Object.assign(current,{kind:null,statements:null,fault:null});}
 };
 return {state,
  run(sql,params=[]){if(buffer){buffer.push([sql,params]);return Promise.resolve();}return send([[sql,params]]);},
  get:(sql,params)=>base.get(sql,params),
  all:(sql,params)=>base.all(sql,params),
  async transaction(fn){if(buffer)return fn();buffer=[];let statements;try{await fn();statements=buffer;}finally{buffer=null;}return send(statements);},
 };
}

// Read-only: the database must be the configured scratch database; reports its objects, schema version and harness stages.
export async function preflight(db,target){
 const described=await db.describe();
 if(described.uuid!==target.databaseId||described.name!==target.databaseName)throw new StageStop('scratch_identity_mismatch',{expected:{uuid:target.databaseId,name:target.databaseName},actual:described});
 const objects=await db.all("SELECT type,name FROM sqlite_master WHERE type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name");
 const names=new Map(objects.map(row=>[row.name,row.type]));
 let foreignKeys=null;try{foreignKeys=(await db.get('PRAGMA foreign_keys'))?.foreign_keys??null;}catch{foreignKeys='unavailable';}
 const migrations=MIGRATIONS.map(file=>{const wanted=migrationObjects(file);return {file,objects:wanted.length,present:wanted.filter(item=>names.get(item.name)===item.type).length,typeConflicts:wanted.filter(item=>names.has(item.name)&&names.get(item.name)!==item.type).map(item=>item.name)};});
 const known=new Set(MIGRATIONS.flatMap(file=>migrationObjects(file).map(item=>item.name)));
 const result={database:described,objects:objects.length,foreignObjects:objects.filter(row=>!known.has(row.name)).map(row=>row.type+':'+row.name),foreignKeys,migrations,schemaVersion:null,claimColumns:null,stages:{},finalRows:null};
 if(names.get('schema_contract')==='table')result.schemaVersion=(await db.get('SELECT version FROM schema_contract WHERE id=1'))?.version??null;
 if(names.get('generation_stage')==='table'){
  result.claimColumns=/claim_nonce/.test((await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='generation_stage'"))?.sql||'');
  for(const run of Object.values(RUN_IDS)){const stage=await db.get('SELECT state,claim_generation,failure_reason FROM generation_stage WHERE programme_run_id=?',[run]);result.stages[run]=stage?{state:stage.state,claimGeneration:stage.claim_generation,failureReason:stage.failure_reason}:null;}
 }
 if(FINAL_TABLES.every(table=>names.get(table)==='table')){result.finalRows={};for(const table of FINAL_TABLES)result.finalRows[table]=(await db.get('SELECT COUNT(*) AS n FROM '+table)).n;}
 return result;
}

// Creates only what is missing: a migration whose objects all exist is skipped, a migration none of whose objects exist is
// applied as one request, anything in between (or a name used by another object type) stops without a write.
export async function applySchema(db,target,current){
 const before=await preflight(db,target),applied=[];
 for(const [index,migration] of before.migrations.entries()){
  if(migration.typeConflicts.length||(migration.present&&migration.present!==migration.objects))throw new StageStop('schema_partial',{file:migration.file,present:migration.present,objects:migration.objects,typeConflicts:migration.typeConflicts});
  if(migration.present===migration.objects)continue;
  if(index===1){const version=(await db.get('SELECT version FROM schema_contract WHERE id=1'))?.version??null;if(version!==1)throw new StageStop('schema_version_unexpected',{file:migration.file,version});}
  const statements=migrationStatements(migration.file);
  Object.assign(current,{kind:'schema',statements:statements.length});
  try{await db.transaction(async()=>{for(const statement of statements)await db.run(statement);});}finally{Object.assign(current,{kind:null,statements:null});}
  applied.push(migration.file);
 }
 const after=await preflight(db,target);
 if(after.schemaVersion!==2||after.claimColumns!==true||after.migrations.some(item=>item.present!==item.objects))throw new StageStop('schema_not_ready',{after});
 return {applied,before,after};
}

// The synthetic films the generations reference (film foreign keys), inserted idempotently in requests of 500 rows.
async function seedFilms(db,count,current){
 const ids=Array.from({length:count},(_,index)=>'film:'+('f'+index+'-'.repeat(24)).slice(0,24));
 for(let start=0;start<ids.length;start+=500){
  const slice=ids.slice(start,start+500);
  Object.assign(current,{kind:'seed_films',statements:1});
  try{await db.run('INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES '+slice.map(()=>'(?,1,NULL,?,?)').join(',')+' ON CONFLICT(id) DO NOTHING',slice.flatMap(id=>[id,'G4 synthetic film','2026-10-26T00:00:00.000Z']));}
  finally{Object.assign(current,{kind:null,statements:null});}
 }
 return ids.length;
}

// Final tables as sorted row digests; the same function reads D1 and the local reference.
async function digestTables(db,tables=FINAL_TABLES){
 const out={};
 for(const table of tables){const rows=(await pagedAll(db,'SELECT * FROM '+table+' ORDER BY rowid',[],5000)).map(row=>JSON.stringify(Object.keys(row).sort().map(key=>[key,row[key]]))).sort();out[table]={rows:rows.length,sha256:sha256(rows.join('\n'))};}
 return out;
}
// The independent reference: the legacy publishGeneration writes the same two generations into a local SQLite database.
async function referenceDigest(input){
 const directory=await mkdtemp(path.join(os.tmpdir(),'iptv-g4-reference-')),file=path.join(directory,'reference.sqlite');
 try{
  const local=openSqlite(file);
  for(const statement of migrationStatements(MIGRATIONS[0]))await local.run(statement);
  for(let start=0;start<input.films;start+=500){const count=Math.min(500,input.films-start);await local.run('INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES '+Array.from({length:count},(_,offset)=>"('"+('film:'+('f'+(start+offset)+'-'.repeat(24)).slice(0,24))+"',1,NULL,'G4 synthetic film','2026-10-26T00:00:00.000Z')").join(','));}
  const repository=createEpgRepository(local);
  await repository.publishGeneration(input.prior);await repository.publishGeneration(input.scaled);
  return await digestTables(local);
 }finally{await rm(directory,{recursive:true,force:true});}
}

// The G4 scenario on the scratch database. Each step records what it expected and what happened; nothing is retried.
export async function runScenario(db,target,current,{scale='full',sha256:hash=sha256,now=()=>new Date().toISOString(),clock=()=>Date.now(),sleep=sleepFor,referenceDigestFn=referenceDigest}={}){
 const input=generations(scale),owner=stageOwner(target.databaseId,input.baseline),steps=[],check=(name,ok,details={})=>{steps.push({step:name,ok,...details});return ok;};
 const execute=async(generation,{fault,hooks,nonce=randomUUID()}={})=>{
  const adapter=scenarioAdapter(db,current,{fault,hooks}),entries=[];
  try{const result=await publishStaged(adapter,generation,{owner,baseline:input.baseline,sha256:hash,nonce,claimTtlMs:CLAIM_TTL_MS,now,clock,limits:input.limits,report:entries});return {outcome:result.replay?'replay':'committed',entry:entries[0],nonce,kinds:adapter.state.kinds};}
  catch(error){
   // A real uncertain write or a D1 failure is not part of the scenario: it stops the run, unretried, for the owner to read.
   if(error instanceof D1Error&&error.fatal&&!error.details?.simulated)throw error;
   return {outcome:error instanceof StageStop?'stop':error instanceof D1Error?error.kind:'error',reason:error.reason??null,message:String(error?.message||'').slice(0,200),entry:entries[0],nonce,kinds:adapter.state.kinds};}
 };
 const waitForExpiry=async()=>{const stage=await readStage(db,RUN_IDS.scaled);const until=Date.parse(stage?.claim_expires_at||'')-Date.parse(now());if(until>0){await sleep(Math.min(until+1500,CLAIM_TTL_MS+5000));}return Math.max(0,until);};
 const scaledPlan=planGeneration(input.scaled,{sha256:hash,...input.limits}),middle=Math.floor(scaledPlan.chunks.length/2);
 const receipts=async()=>(await db.get('SELECT COUNT(*) AS n FROM generation_stage_chunk WHERE programme_run_id=?',[RUN_IDS.scaled])).n;
 const chunkRows=async chunk=>(await db.get('SELECT '+['stage_film_generation','stage_film_show','stage_candidate','stage_candidate_show'].map(table=>'(SELECT COUNT(*) FROM '+table+' WHERE programme_run_id=? AND chunk_index=?)').join('+')+' AS n',Array(4).fill([RUN_IDS.scaled,chunk]).flat())).n;
 const result={scale,plan:{priorChunks:planGeneration(input.prior,{sha256:hash,...input.limits}).chunks.length,scaledChunks:scaledPlan.chunks.length,scaledRows:scaledPlan.rows.length,interruptAtChunk:middle},steps,executions:{},commit:null,parity:null,verdict:null};

 check('seed_films',true,{films:await seedFilms(db,input.films,current)});
 const prior=await execute(input.prior);result.executions.prior=prior.entry;
 check('prior_generation',['committed','replay'].includes(prior.outcome),{outcome:prior.outcome,reason:prior.reason});
 if(!['committed','replay'].includes(prior.outcome))return finishScenario(result,'NO-GO');
 const alreadyCommitted=await replayGeneration(db,input.scaled);
 if(alreadyCommitted){check('scaled_already_committed',false,{note:'The 1.25x generation was committed by an earlier run; its faults cannot be exercised again on this database.'});return finishScenario(result,'INCOMPLETE');}

 // 1. A chunk request whose last statement fails leaves no staged row and no receipt of that chunk.
 const firstChunk=await receipts();
 const failing=await execute(input.scaled,{fault:({kind})=>kind==='chunk'?'failLast':null});
 check('fail_last_statement_rolls_back',failing.outcome==='statement'&&await receipts()===firstChunk&&await chunkRows(firstChunk)===0,{outcome:failing.outcome,chunk:firstChunk});
 // 2. While that execution's claim is live, another execution of the same baseline is refused after one claim request.
 const rivalExecution=await execute(input.scaled);
 check('second_executor_refused',rivalExecution.outcome==='stop'&&rivalExecution.reason==='stage_claimed_elsewhere'&&rivalExecution.kinds.length===1,{reason:rivalExecution.reason,requests:rivalExecution.kinds});
 // 3. After the claim expired an execution takes over and is interrupted before the middle chunk (an uncertain write).
 result.waitedMs=[await waitForExpiry()];
 const interrupted=await execute(input.scaled,{fault:({kind,statements})=>kind==='chunk'&&statements.at(-1)[1][1]===middle?'crash':null});
 result.executions.interrupted=interrupted.entry;
 check('interrupted_before_middle_chunk',interrupted.outcome==='write_uncertain'&&await receipts()===middle,{outcome:interrupted.outcome,receipts:await receipts(),claim:interrupted.entry?.claim??null});
 // 4. The next execution takes the expired claim over and resumes after the receipts. Just before its commit request the
 // interrupted execution's fence is tried: its fail must change nothing and its commit must be refused.
 result.waitedMs.push(await waitForExpiry());
 const staleContext={owner,baseline:input.baseline,nonce:interrupted.nonce,fence:interrupted.entry?.claim?.generation??null,now,claimTtlMs:CLAIM_TTL_MS};
 const fence={};
 const resumed=await execute(input.scaled,{hooks:[async({kind})=>{
  if(kind!=='commit'||fence.tried)return;fence.tried=true;
  await failStage(db,RUN_IDS.scaled,{...staleContext,reason:'g4_stale_fail'});
  fence.failIgnored=(await readStage(db,RUN_IDS.scaled))?.state==='validated';
  try{await commitStage(db,scaledPlan,staleContext);fence.commitRefused=false;}catch(error){fence.commitRefused=error?.kind==='statement';}
  fence.pointerUnchanged=(await db.get('SELECT programme_run_id FROM published_generation WHERE id=1'))?.programme_run_id===RUN_IDS.prior;
 }]});
 result.executions.resumed=resumed.entry;
 check('takeover_resumes_after_receipts',resumed.outcome==='committed'&&resumed.entry?.claim?.takenOver===true&&resumed.entry?.chunks?.alreadyReceived===middle,{outcome:resumed.outcome,reason:resumed.reason,claim:resumed.entry?.claim??null,chunks:resumed.entry?.chunks??null});
 check('stale_claimant_fenced',fence.tried===true&&fence.failIgnored===true&&fence.commitRefused===true&&fence.pointerUnchanged===true,fence);
 const commit=resumed.entry?.commit||null;
 result.commit=commit&&{statements:commit.statements,bytes:commit.bytes,clientMs:commit.ms,budgetMs:PUBLISH_BUDGET_MS,withinBudget:commit.withinBudget};
 check('commit_within_budget',commit?.withinBudget===true,{clientMs:commit?.ms??null});
 check('staged_readback_equal',resumed.entry?.readback?.ok===true,{rows:resumed.entry?.readback?.rows??null});
 // 5. A repeated commit request of the committed stage is refused and changes nothing.
 const beforeRepeat=await digestTables(db);
 let repeatRefused=false;try{await commitStage(db,scaledPlan,{owner,baseline:input.baseline,nonce:resumed.nonce,fence:resumed.entry?.claim?.generation,now,claimTtlMs:CLAIM_TTL_MS});}catch(error){repeatRefused=error?.kind==='statement';}
 check('repeated_commit_refused',repeatRefused&&JSON.stringify(await digestTables(db))===JSON.stringify(beforeRepeat));
 // 6. A stage planned against the previous pointer is refused at its commit with nothing written, and failed.
 const stale=await execute(input.rival);
 check('stale_pointer_refused',stale.outcome==='stop'&&stale.reason==='pointer_moved'&&(await readStage(db,RUN_IDS.rival))?.state==='failed'&&JSON.stringify(await digestTables(db))===JSON.stringify(beforeRepeat),{outcome:stale.outcome,reason:stale.reason});
 // 7. The same 1.25x generation again is a replay.
 const replay=await execute(input.scaled);
 check('rerun_is_replay',replay.outcome==='replay',{outcome:replay.outcome});
 // 8. Independent parity: every final table equals the legacy writer's result for the same two generations, row for row.
 const [remote,reference]=[await digestTables(db),await referenceDigestFn(input)];
 const differing=FINAL_TABLES.filter(table=>remote[table].sha256!==reference[table].sha256||remote[table].rows!==reference[table].rows);
 result.parity={tables:Object.fromEntries(FINAL_TABLES.map(table=>[table,{rows:remote[table].rows,referenceRows:reference[table].rows,equal:!differing.includes(table)}])),differing};
 check('final_tables_equal_reference',!differing.length,{differing});
 return finishScenario(result,steps.every(step=>step.ok)?'GO':'NO-GO');
}
function finishScenario(result,verdict){result.verdict=verdict;return result;}

// Approved cleanup: bounded discard of the harness's failed or superseded stages; staging rows only, never a final table.
export async function cleanupStages(db){
 const results={};
 for(const run of Object.values(RUN_IDS)){
  const stage=await readStage(db,run);
  if(!stage||!['failed','superseded'].includes(stage.state)){results[run]={skipped:stage?.state??'absent'};continue;}
  results[run]=await discardStage(db,run,{limit:500});
 }
 return results;
}

export function plan(scale='full'){
 const input=generations(scale),chunks=generation=>planGeneration(generation,{sha256,...input.limits});
 const prior=chunks(input.prior),scaled=chunks(input.scaled),rival=chunks(input.rival);
 const migrations=MIGRATIONS.map(file=>({file,statements:migrationStatements(file).length,objects:migrationObjects(file).length}));
 return {scale,database:SCRATCH_DATABASE_NAME,refuses:['any database whose live uuid or name differs from the configured scratch database','the database name iptv and the D1_BACKFILL_DATABASE_ID uuid','any R2 access (none is implemented)'],
  environment:['D1_BACKFILL_ACCOUNT_ID','D1_BACKFILL_API_TOKEN (scoped to the scratch database)','D1_BACKFILL_SCRATCH_DATABASE_ID','D1_G4_SCRATCH_DATABASE_NAME (default '+SCRATCH_DATABASE_NAME+')'],
  generations:{prior:{runId:RUN_IDS.prior,films:input.prior.films.length,candidates:input.prior.candidates.length,rows:prior.rows.length,chunks:prior.chunks.length,largestChunkBytes:Math.max(...prior.chunks.map(chunk=>chunk.bytes))},scaled:{runId:RUN_IDS.scaled,films:input.scaled.films.length,candidates:input.scaled.candidates.length,rows:scaled.rows.length,chunks:scaled.chunks.length,largestChunkBytes:Math.max(...scaled.chunks.map(chunk=>chunk.bytes))},rival:{runId:RUN_IDS.rival,candidates:input.rival.candidates.length,chunks:rival.chunks.length}},
  commands:[
   {command:'--preflight',approval:'scratch access (read-only)',writes:'none',reads:'database uuid and name, sqlite_master, schema_contract, harness stage rows, final table counts'},
   {command:'--apply-schema --approved-scratch-writes',approval:'apply 0001 and 0002 to the scratch database',writes:migrations.map(item=>item.file+': one request of '+item.statements+' statements, only if none of its '+item.objects+' objects exists; any partial schema stops'),reads:'preflight before and after'},
   {command:'--run --approved-scratch-writes',approval:'synthetic writes to the scratch database',writes:['seed '+input.films+' synthetic films (ON CONFLICT DO NOTHING)','stage and commit '+RUN_IDS.prior+' ('+prior.chunks.length+' chunks)','1.25x '+RUN_IDS.scaled+' ('+scaled.chunks.length+' chunks): failing last statement, refused second executor, interruption before chunk '+Math.floor(scaled.chunks.length/2)+', takeover after claim expiry (two waits of about '+CLAIM_TTL_MS/1000+' s), stale-claimant fail and commit, timed commit, repeated commit','stale-pointer stage '+RUN_IDS.rival+' (failed at commit)','replay of '+RUN_IDS.scaled],reads:'stage read-back, receipts, final tables digested for parity with a local legacy reference'},
   {command:'--cleanup --approved-cleanup',approval:'deleting staging rows (separate)',writes:'discard of failed or superseded harness stages in batches of 500 rows; final tables, the published stage and objects outside the harness are never touched',reads:'stage rows'},
  ],
  go:['commit of the 1.25x stage within '+PUBLISH_BUDGET_MS+' ms client time (D1 server time recorded)','every final table equal to the legacy reference','failing last statement rolled back whole','second executor refused; stale claimant cannot fail or commit','interrupted run resumed after its receipts by a takeover','repeated and stale-pointer commits refused with nothing written','rerun is a replay'],
  noGo:'any failed step, a timeout or an uncertain write stops the scenario; the report records it and the owner decides; nothing is retried'};
}

function outsideRepository(directory){
 if(!directory||!path.isAbsolute(directory))throw new ExportError('configuration','--output must be an absolute path outside the Git repository');
 const absolute=path.resolve(directory);
 if(absolute===REPO_ROOT||absolute.startsWith(REPO_ROOT+path.sep))throw new ExportError('configuration','--output must be an absolute path outside the Git repository');
 return absolute;
}

// One command. Returns the report it wrote.
export async function runG4({command,output,scale='full',approvedWrites=false,approvedCleanup=false,env=process.env,fetchImpl=fetch,clock=()=>Date.now(),now=()=>new Date().toISOString(),sleep=sleepFor,referenceDigestFn}){
 if(command==='plan')return plan(scale);
 const directory=outsideRepository(output);
 if(['apply-schema','run'].includes(command)&&!approvedWrites)throw new ExportError('configuration','--'+command+' writes to the scratch database and needs --approved-scratch-writes');
 if(command==='cleanup'&&!approvedCleanup)throw new ExportError('configuration','--cleanup deletes staging rows and needs --approved-cleanup');
 if(!['preflight','apply-schema','run','cleanup'].includes(command))throw new ExportError('configuration','Unknown command');
 const target=readScratchTarget(env),log=[],current={};
 const db=createD1Adapter({target,databaseId:target.databaseId,fetchImpl:instrument(fetchImpl,log,clock,current),sleep});
 const report={command,scale,startedAt:now(),database:{name:target.databaseName},status:null,result:null,stop:null,requests:null};
 try{
  if(command==='preflight')report.result=await preflight(db,target);
  else{
   const checked=await preflight(db,target);
   if(command==='apply-schema')report.result=await applySchema(db,target,current);
   else if(checked.schemaVersion!==2||checked.claimColumns!==true)throw new StageStop('schema_not_ready',{schemaVersion:checked.schemaVersion,claimColumns:checked.claimColumns});
   else if(command==='run')report.result=await runScenario(db,target,current,{scale,now,clock,sleep,...(referenceDigestFn?{referenceDigestFn}:{})});
   else report.result={preflight:checked,discarded:await cleanupStages(db)};
  }
  report.status=command==='run'?report.result.verdict:'completed';
 }catch(error){
  if(error instanceof StageStop){report.status='no_go';report.stop={reason:error.reason,details:error.details};}
  else if(error instanceof D1Error){report.status='stopped';report.stop={reason:error.kind,message:error.message,status:error.details?.status??null};}
  else throw error;
 }
 const writes=log.filter(entry=>entry.kind!=='read'&&entry.kind!=='describe');
 report.requests={total:log.length,writes:writes.length,reads:log.length-writes.length,byKind:Object.fromEntries([...new Set(log.map(entry=>entry.kind))].sort().map(kind=>{const items=log.filter(entry=>entry.kind===kind);return [kind,{count:items.length,clientMs:items.reduce((sum,item)=>sum+item.clientMs,0),serverMs:items.some(item=>item.serverMs!=null)?Math.round(items.reduce((sum,item)=>sum+(item.serverMs||0),0)*1000)/1000:null,maxBytes:Math.max(0,...items.map(item=>item.bytes))}];}))};
 const commits=log.filter(entry=>entry.kind==='commit'&&entry.status===200);
 if(command==='run'&&report.result?.commit)report.result.commit.serverMs=commits.at(-1)?.serverMs??null;
 report.finishedAt=now();
 await mkdir(directory,{recursive:true,mode:0o700});
 await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 await writeFile(path.join(directory,'requests.jsonl'),log.map(entry=>JSON.stringify(entry)).join('\n')+(log.length?'\n':''),{mode:0o600});
 return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=flag=>{const index=args.indexOf(flag);return index<0?null:args[index+1];};
 const commands=['plan','preflight','apply-schema','run','cleanup'].filter(name=>args.includes('--'+name));
 const scale=value('--scale')||'full';
 if(commands.length!==1||!SCALES[scale]){console.error('Usage: node scripts/d1-scratch-g4.mjs --plan | --preflight | --apply-schema --approved-scratch-writes | --run --approved-scratch-writes | --cleanup --approved-cleanup  --output /absolute/private/dir [--scale full|small]');process.exit(2);}
 try{
  const report=await runG4({command:commands[0],output:value('--output'),scale,approvedWrites:args.includes('--approved-scratch-writes'),approvedCleanup:args.includes('--approved-cleanup')});
  console.log(JSON.stringify(commands[0]==='plan'?report:{status:report.status,stop:report.stop,verdict:report.result?.verdict??null,commit:report.result?.commit??null,requests:report.requests},null,commands[0]==='plan'?1:0));
  process.exitCode=commands[0]==='plan'||['completed','GO'].includes(report.status)?0:3;
 }catch(error){
  if(error instanceof ExportError){console.error(error.kind+': '+error.message);process.exitCode=error.kind==='configuration'?2:1;}
  else{console.error('G4 harness failed: '+String(error?.message||error).slice(0,200));process.exitCode=1;}
 }
}
