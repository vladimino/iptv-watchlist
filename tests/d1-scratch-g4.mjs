import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {RUN_IDS,SCRATCH_DATABASE_NAME,plan,readScratchTarget,requestKind,runG4} from '../scripts/d1-scratch-g4.mjs';

// AIR-174 harness against a fake D1 HTTP API backed by SQLite: identity and approval fences, schema provisioning that never
// touches foreign objects, the whole G4 scenario at the small scale, private reports without values, and approved cleanup.
const ACCOUNT='0123456789abcdef0123456789abcdef',TOKEN='scratch-token',SCRATCH='11111111-2222-3333-4444-555555555555',OTHER='99999999-2222-3333-4444-555555555555',PROD='aaaaaaaa-2222-3333-4444-555555555555';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-g4-'));
const sqlite=(file,input,{json=false}={})=>spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input,encoding:'utf8',maxBuffer:1<<30});
const count=(file,sql)=>JSON.parse(sqlite(file,sql+';',{json:true}).stdout||'[{"n":0}]')[0].n;
function fakeD1(databases){
 const calls=[],hooks=[];
 const server=http.createServer((request,response)=>{
  const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',async()=>{
   const match=new URL(request.url,'http://127.0.0.1').pathname.match(/^\/client\/v4\/accounts\/([0-9a-f]{32})\/d1\/database\/([0-9a-f-]{36})(\/query)?$/);
   const send=(status,body)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(body));};
   if(request.headers.authorization!=='Bearer '+TOKEN)return send(403,{success:false,errors:[{message:'Authentication error'}]});
   if(!match||match[1]!==ACCOUNT||!databases[match[2]])return send(404,{success:false,errors:[{message:'Database not found'}]});
   const database=databases[match[2]];
   if(request.method==='GET'&&!match[3])return send(200,{success:true,result:{uuid:match[2],name:database.name}});
   const sql=JSON.parse(Buffer.concat(chunks).toString('utf8')).sql,write=!/^\s*(SELECT|PRAGMA)\b/i.test(sql);
   calls.push({database:match[2],sql,write});
   for(const hook of hooks){const status=await hook({sql,write});if(typeof status==='number')return send(status,{success:false,errors:[{message:'Injected'}]});}
   const result=sqlite(database.file,'PRAGMA foreign_keys=ON;\n'+(write?'BEGIN;\n'+sql+'\nCOMMIT;\n':sql+'\n'),{json:true});
   if(result.status!==0)return send(400,{success:false,errors:[{message:(result.stderr||'SQL error').trim().slice(0,300)}],result:[]});
   const text=result.stdout.trim(),rows=text?JSON.parse(text.replace(/\]\s*\[/g,',')):[];
   send(200,{success:true,result:[{results:rows,success:true,meta:{duration:0.25}}]});
  });
 });
 return {calls,hooks,async start(){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port+'/client/v4';},async stop(){await new Promise(resolve=>server.close(resolve));}};
}
const file=name=>{const target=path.join(root,name+'.sqlite');assert.equal(sqlite(target,'SELECT 1;').status,0);return target;};
const out=name=>path.join(root,'out-'+name);
const read=(name,which='report.json')=>fs.readFileSync(path.join(out(name),which),'utf8');

try{
 // The plan reads no credential and sends nothing; the full scale is the ADR-0021 GO/NO-GO size.
 const full=plan('full');
 assert.deepEqual([full.generations.prior.candidates,full.generations.scaled.candidates,full.generations.scaled.films],[22199,27749,2300]);
 assert.ok(full.generations.scaled.largestChunkBytes<=1000000);
 assert.ok(full.commands.find(item=>item.command.startsWith('--cleanup')).approval.includes('separate'));
 assert.deepEqual(await runG4({command:'plan',scale:'small',env:{}}),plan('small'));

 // Configuration fences: never the production name or uuid, never without approval, never an output inside the repository.
 const env=endpoint=>({D1_BACKFILL_ACCOUNT_ID:ACCOUNT,D1_BACKFILL_API_TOKEN:TOKEN,D1_BACKFILL_SCRATCH_DATABASE_ID:SCRATCH,D1_BACKFILL_DATABASE_ID:PROD,D1_BACKFILL_ENDPOINT:endpoint});
 assert.throws(()=>readScratchTarget({...env('http://127.0.0.1:1/client/v4'),D1_G4_SCRATCH_DATABASE_NAME:'iptv'}),/not a scratch database name/);
 assert.throws(()=>readScratchTarget({...env('http://127.0.0.1:1/client/v4'),D1_BACKFILL_DATABASE_ID:SCRATCH}),/must not be the target database/);
 assert.equal(readScratchTarget(env('http://127.0.0.1:1/client/v4')).databaseName,SCRATCH_DATABASE_NAME);
 await assert.rejects(runG4({command:'run',scale:'small',output:out('x'),env:env('http://127.0.0.1:1/client/v4')}),/needs --approved-scratch-writes/);
 await assert.rejects(runG4({command:'apply-schema',scale:'small',output:out('x'),env:env('http://127.0.0.1:1/client/v4')}),/needs --approved-scratch-writes/);
 await assert.rejects(runG4({command:'cleanup',scale:'small',output:out('x'),env:env('http://127.0.0.1:1/client/v4')}),/needs --approved-cleanup/);
 await assert.rejects(runG4({command:'preflight',scale:'small',output:path.join(process.cwd(),'out'),env:env('http://127.0.0.1:1/client/v4')}),/outside the Git repository/);
 assert.equal(requestKind([['UPDATE generation_stage SET claim_nonce=?',[]]]),'claim');

 const scratch=file('scratch'),wrongName=file('wrong'),partial=file('partial'),flaky=file('flaky');
 // The scratch database already holds the owner's earlier probe table; nothing may touch it.
 assert.equal(sqlite(scratch,'CREATE TABLE atomicity_probe (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO atomicity_probe VALUES (1,\'kept\');').status,0);
 assert.equal(sqlite(partial,'CREATE TABLE film (id TEXT PRIMARY KEY);').status,0);
 const fake=fakeD1({[SCRATCH]:{file:scratch,name:SCRATCH_DATABASE_NAME},[OTHER]:{file:wrongName,name:'iptv'}});
 const endpoint=await fake.start();
 let offset=0;const now=()=>new Date(Date.UTC(2026,9,26,20)+offset).toISOString(),sleep=async ms=>{offset+=ms;};
 const g4=(command,name,extra={})=>runG4({command,scale:'small',output:out(name),env:env(endpoint),now,sleep,...extra});

 // A database whose live name is not the scratch name is refused before anything else.
 const wrong=await runG4({command:'preflight',scale:'small',output:out('wrong'),env:{...env(endpoint),D1_BACKFILL_SCRATCH_DATABASE_ID:OTHER},now});
 assert.equal(wrong.status,'no_go');assert.equal(wrong.stop.reason,'scratch_identity_mismatch');assert.equal(wrong.requests.total,1);

 const first=await g4('preflight','preflight');
 assert.equal(first.status,'completed');
 assert.equal(first.result.schemaVersion,null);
 assert.deepEqual(first.result.foreignObjects,['table:atomicity_probe']);
 assert.equal(first.requests.writes,0,'preflight only reads');
 assert.ok(fake.calls.every(call=>!call.write||/^\s*PRAGMA/i.test(call.sql)),'nothing was written so far');
 const early=await g4('run','early',{approvedWrites:true});
 assert.equal(early.status,'no_go');assert.equal(early.stop.reason,'schema_not_ready');

 const schema=await g4('apply-schema','schema',{approvedWrites:true});
 assert.equal(schema.status,'completed');
 assert.deepEqual(schema.result.applied,['migrations/0001_schema_v1.sql','migrations/0002_generation_stage.sql']);
 assert.equal(schema.requests.byKind.schema.count,2,'each migration is one request');
 assert.equal((await g4('apply-schema','schema-again',{approvedWrites:true})).result.applied.length,0,'an applied schema is left alone');

 // A partial schema stops without a write.
 const partialFake=fakeD1({[SCRATCH]:{file:partial,name:SCRATCH_DATABASE_NAME}}),partialEndpoint=await partialFake.start();
 const partialReport=await runG4({command:'apply-schema',scale:'small',output:out('partial'),env:env(partialEndpoint),now,approvedWrites:true});
 assert.equal(partialReport.status,'no_go');assert.equal(partialReport.stop.reason,'schema_partial');
 assert.equal(partialFake.calls.filter(call=>call.write&&!/^\s*PRAGMA/i.test(call.sql)).length,0);
 await partialFake.stop();

 // The whole scenario at the small scale: every step passes and the verdict is GO.
 const run=await g4('run','run',{approvedWrites:true});
 assert.equal(run.status,'GO',JSON.stringify(run.result?.steps?.filter(step=>!step.ok)));
 assert.deepEqual(run.result.steps.map(step=>step.step),['seed_films','prior_generation','fail_last_statement_rolls_back','second_executor_refused','interrupted_before_middle_chunk','takeover_resumes_after_receipts','stale_claimant_fenced','commit_within_budget','staged_readback_equal','repeated_commit_refused','stale_pointer_refused','rerun_is_replay','final_tables_equal_reference']);
 assert.ok(run.result.steps.every(step=>step.ok));
 assert.equal(run.result.waitedMs.length,2,'two takeovers waited for the claim to expire');
 assert.equal(run.result.commit.statements,12);
 assert.equal(run.requests.byKind.direct_write.count,3,'the stale fail, the stale commit and the repeated commit are logged as harness writes');
 assert.equal(run.result.commit.serverMs,0.25,'D1 server time of the commit request is recorded');
 assert.ok(Object.values(run.result.parity.tables).every(table=>table.equal&&table.rows===table.referenceRows));
 assert.equal(run.result.parity.tables.candidate.rows,60);
 for(const name of ['run'])for(const which of ['report.json','requests.jsonl']){const text=read(name,which);assert.doesNotMatch(text,/scratch-token|Title |G4 synthetic|Channel /,which+' holds no credential and no row value');}
 assert.equal(count(scratch,'SELECT COUNT(*) AS n FROM atomicity_probe'),1,'the foreign probe table is untouched');
 assert.equal(count(scratch,"SELECT COUNT(*) AS n FROM generation_stage WHERE programme_run_id LIKE 'guard:%'"),0);
 const finalBefore=sqlite(scratch,'SELECT COUNT(*) FROM candidate; SELECT programme_run_id FROM published_generation;').stdout;
 assert.match(finalBefore,new RegExp(RUN_IDS.scaled));

 // Rerunning cannot exercise the faults again and says so.
 const rerun=await g4('run','rerun',{approvedWrites:true});
 assert.equal(rerun.status,'INCOMPLETE');

 // Approved cleanup discards the failed and superseded harness stages only; final tables and the probe table stay.
 const cleanup=await g4('cleanup','cleanup',{approvedCleanup:true});
 assert.equal(cleanup.status,'completed');
 assert.equal(cleanup.result.discarded[RUN_IDS.scaled].skipped,'published');
 assert.equal(cleanup.result.discarded[RUN_IDS.prior].stageRowKept,true);
 assert.equal(count(scratch,`SELECT COUNT(*) AS n FROM generation_stage WHERE programme_run_id='${RUN_IDS.rival}'`),0);
 assert.equal(count(scratch,`SELECT COUNT(*) AS n FROM stage_candidate WHERE programme_run_id IN ('${RUN_IDS.prior}','${RUN_IDS.rival}')`),0);
 assert.equal(sqlite(scratch,'SELECT COUNT(*) FROM candidate; SELECT programme_run_id FROM published_generation;').stdout,finalBefore);
 assert.equal(count(scratch,'SELECT COUNT(*) AS n FROM atomicity_probe'),1);
 await fake.stop();

 // A real uncertain write (HTTP 500 to a chunk) stops the scenario without a retry; the report says so.
 const flakyFake=fakeD1({[SCRATCH]:{file:flaky,name:SCRATCH_DATABASE_NAME}}),flakyEndpoint=await flakyFake.start();
 await runG4({command:'apply-schema',scale:'small',output:out('flaky-schema'),env:env(flakyEndpoint),now,approvedWrites:true});
 let chunks=0;flakyFake.hooks.push(({sql})=>/INSERT INTO generation_stage_chunk/.test(sql)&&++chunks===3?500:null);
 const flakyRun=await runG4({command:'run',scale:'small',output:out('flaky'),env:env(flakyEndpoint),now,sleep,approvedWrites:true});
 assert.equal(flakyRun.status,'stopped');assert.equal(flakyRun.stop.reason,'write_uncertain');
 assert.equal(flakyFake.calls.filter(call=>/INSERT INTO generation_stage_chunk/.test(call.sql)).length,3,'the uncertain chunk was sent once');
 await flakyFake.stop();

 // CLI: the plan needs no environment; a write command without approval exits 2.
 const cliPlan=spawnSync(process.execPath,['scripts/d1-scratch-g4.mjs','--plan','--scale','small'],{encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(cliPlan.status,0,cliPlan.stderr);assert.equal(JSON.parse(cliPlan.stdout).generations.scaled.candidates,60);
 const cliRun=spawnSync(process.execPath,['scripts/d1-scratch-g4.mjs','--run','--output',out('cli')],{encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(cliRun.status,2);assert.match(cliRun.stderr,/approved-scratch-writes/);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('D1 scratch G4 harness: plan without credentials, identity/approval/output fences, schema provisioning that keeps foreign objects and refuses a partial schema, full G4 scenario (failing last statement, refused second executor, interruption and takeover, stale claimant fence, timed commit, repeated and stale-pointer commits, replay, legacy parity) at small scale, private value-free reports, an uncertain write sent once and approved cleanup passed');
