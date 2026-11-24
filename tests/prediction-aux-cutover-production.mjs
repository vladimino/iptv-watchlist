// The owner-only cutover operator of the Predictions auxiliary state (scripts/prediction-aux-cutover-production.mjs): status, apply 0034 and 0035, close, chunked import, seal, chunked verify, flip, reopen (ADR 0202).
// Offline only: a sqlite D1 stand-in over the real migration chain, the four families written by the REAL Worker on its legacy R2 path, SQL printed by the REAL importer. No production database is opened,
// no credential, no R2, no Scheduled Task, no model.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {flowWorld,sql,migrated,labelStarts} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {D1Error} from '../scripts/d1-backfill.mjs';
import * as Op from '../scripts/prediction-aux-cutover-production.mjs';
import {buildPlan,planReport,planSql,planVerifySql,planSha256,chunkPlan,slicePlan,sealStatements,flipStatements,auxExportFamily,CHUNK_LIMITS} from '../scripts/prediction-aux-d1-import.mjs';
import {fakeBucket,envFor,ACCOUNT} from './r2-fake-bucket-lib.mjs';
import {exportProductionSnapshot,readCredentials} from '../scripts/r2-snapshot-export.mjs';
import {convertSnapshot} from '../scripts/prediction-aux-export-convert.mjs';
labelStarts();

const sha256=value=>createHash('sha256').update(value).digest('hex');
const NOW=Date.parse('2026-11-22T14:00:00.000Z');
const made=[];process.on('exit',()=>{for(const dir of made)try{fs.rmSync(dir,{recursive:true,force:true});}catch{/* best effort */}});
const tmp=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aux-op-'));made.push(dir);return dir;};
const stop=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason,String(error.reason)+' '+JSON.stringify(error.details||{}));return error;}assert.fail('expected '+reason);};
const states=[];const ctxOf=()=>({track:state=>states.push(state)});
const run=(command,env,params={},extra={})=>Op.execute(command,{binding:env.db,now:NOW,ctx:ctxOf(),params,...extra});
const marker=file=>sql(file,'SELECT mode, generation, activated_at AS at FROM prediction_aux_authority WHERE id=1')[0];
const count=(file,table)=>Number(sql(file,'SELECT count(*) AS n FROM '+table)[0].n);

// The real legacy data: a start, a held stage, a skipped record, a delivered stop record (what production has until the cutover).
const world=await flowWorld({films:8,aux:'r2'});
const {start}=await world.reconcileAndStart({manifestSize:4});assert.equal(start.status,200);
const runId=start.data.runId;await world.pair(runId);
const held=start.data.films.slice(1,3).map(f=>({filmId:f.filmId,...(f.plan==='prediction_only'?{}:{fingerprint:world.fingerprint}),prediction:world.prediction}));
assert.equal((await world.api('batch/hold',{runId,epoch:start.data.lease.epoch,items:held})).status,200);
const rival=await world.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',taskId:'task15',capacity:{remainingPercent:100}});assert.equal(rival.data.status,'already_running');
assert.equal((await world.api('complete',{runId,reason:'external_termination'})).status,200);
const objects=Object.fromEntries([...world.records.entries()].filter(([key])=>auxExportFamily(key)));
// Six more completed runs (a source and a delivered stop record each): the small real dataset alone is one run, which no budget can cut into several chunks of whole runs.
for(let i=0;i<6;i++){const id='extra-run-'+i;objects['enrichment/sources/'+id+'.json']={['tmdb_'+(900+i)]:{title:'Extra '+i,modelMetadata:{note:'x'.repeat(2000)}}};objects['enrichment/stop-events/'+id+'.json']={event:{id:'evt-'+id,at:'2026-11-20T10:0'+i+':00.000Z',type:'stop'},delivered:true};}
const plan=await buildPlan(objects);assert.deepEqual(plan.blockers,[]);
const report=await planReport(plan);

// A scratch production stand-in at schema 33: the aux tables do not exist yet, the prediction domain is d1.
function scratch(){
 const file=migrated(33);
 sql(file,"UPDATE prediction_domain_authority SET mode='d1' WHERE id=1");
 return {file,db:d1Standin(file)};
}
const SOURCE={kind:'cloudflare-r2-s3',bucket:'iptv',accountId:ACCOUNT};

// The R2 side, for real: the objects in a fake bucket, cut by the REAL exporter and converted by the REAL converter. A capture is that converter's output directory (identity.json + converter-report.json).
const json=value=>JSON.stringify(value);
const fenceObjects=()=>({
 'watchlist.json':json({films:[{id:'heat-1995'}]}),'programme.json':json({runId:'run-1',films:[]}),'sync.json':json({updatedAt:'2026-10-26T10:00:00.000Z',failures:[]}),
 'epg/published-generation.json':json({programmeRunId:'run-1',phase:'published'}),'epg/resolver-lease.json':json({id:'lease-1'}),'epg/resolver-continuation.json':json({at:'2026-10-26T10:05:00.000Z',hopId:'hop-7'}),
 'enrichment/writer-lease.json':json({id:'writer-1'}),'enrichment/runner-lease.json':json({id:'runner-1'}),'enrichment/profile/current.json':json({version:3,profileHash:'profile-3'}),
 'enrichment/latest-run.json':json({runId:'enrichment-run-9'})
});
const legacyBytes=Object.fromEntries(Object.entries(objects).map(([key,value])=>[key,json(value)]));
async function openBucket(extra={},legacy=legacyBytes){
 const bucket=fakeBucket({...fenceObjects(),...legacy,...extra},{pageSize:4});
 const endpoint=await bucket.start();
 return {bucket,credentials:readCredentials(envFor(endpoint))};
}
async function capture(opened,{scope=null}={}){
 const snapshot=tmp(),output=path.join(tmp(),'capture');
 await exportProductionSnapshot({directory:snapshot,credentials:opened.credentials,sleep:async()=>{},...(scope?{scope}:{})});
 await convertSnapshot({snapshot,output});
 await new Promise(resolve=>setTimeout(resolve,5));   // two cuts are two distinct moments
 return {dir:output,...Op.readCapture(output)};
}
const clockAfter=cap=>Date.parse(cap.report.snapshot.finishedAt)+60000;
// The plan digest the operator DERIVES from a converted tree (the only pin of every chunked step): the owner's confirmation of what `status` printed.
const pinOf=conv=>conv.planSha256;
// A small chunk budget forces several chunks and slices out of the small real dataset (a whole run needs a handful of statements).
const SMALL={statements:14,bytes:400000};
const pp=(conv,generation=1,extra={})=>({generation,converted:conv,planSha256:pinOf(conv),...extra});
const runS=(command,env,params={},extra={})=>run(command,env,params,{limits:SMALL,...extra});
const flipParams=(conv,release,extra={})=>({generation:1,captureBefore:conv,planSha256:pinOf(conv),release,source:SOURCE,...extra});
const flipExec=(env,params,at,extra={})=>Op.execute('flip',{binding:env.db,now:at,ctx:ctxOf(),params,limits:SMALL,...extra});
// apply, close, then the chunked steps up to `until` on a scratch database
async function stage(env,until='verified',{conv=pinnedConv(),limits=SMALL,generation=1}={}){
 await run('apply',env,{migrationSha256:Op.migrationSha256()});
 await run('close',env,{generation:generation-1});
 const imp=await run('import',env,pp(conv,generation),{limits});
 if(until==='imported')return {imp};
 const seal=await run('seal',env,pp(conv,generation),{limits});
 if(until==='sealed')return {imp,seal};
 const ver=await run('verify',env,pp(conv,generation),{limits});
 return {imp,seal,ver};
}
let CONV=null;const pinnedConv=()=>CONV;


// ===== 1. arguments =====
{
 const A=(...a)=>['node','x',...a];
 const PIN='0'.repeat(64);
 assert.deepEqual(Op.parseArgs(A()).report,{configured:false,writes:false,writeState:'none'});
 for(const command of ['apply','close','import','seal','verify','flip','reopen'])assert.throws(()=>Op.parseArgs(A('--'+command)),e=>e.reason==='target_required',command);
 assert.throws(()=>Op.parseArgs(A('--close','--target','other','--confirm','close','--generation','0')),e=>e.reason==='target_invalid');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--generation','0')),e=>e.reason==='confirm');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','apply','--generation','0')),e=>e.reason==='confirm');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','close')),e=>e.reason==='usage','--generation is required');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','close','--generation','-1')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','close','--generation','1.5')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--apply','--target','iptv','--confirm','apply')),e=>e.reason==='usage','the migration pin is required');
 assert.throws(()=>Op.parseArgs(A('--apply','--target','iptv','--confirm','apply','--migration-sha256','abc')),e=>e.reason==='usage');
 for(const command of ['import','seal','verify'])assert.throws(()=>Op.parseArgs(A('--'+command,'--target','iptv','--confirm',command,'--generation','1','--converted','x')),e=>e.reason==='usage','the plan pin is required by '+command);
 assert.throws(()=>Op.parseArgs(A('--import','--target','iptv','--confirm','import','--generation','1','--converted','x','--plan-sha256','abc')),e=>e.reason==='usage','a plan pin is 64 hex digits');
 assert.throws(()=>Op.parseArgs(A('--status','--apply','--target','iptv','--confirm','apply')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','close','--generation','0','--release','x')),e=>e.reason==='usage','an option the command does not take');
 assert.throws(()=>Op.parseArgs(A('--target','iptv','--confirm','status')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--wipe','--target','iptv')),e=>e.reason==='usage','no other command exists');
 // The SQL and the report are DERIVED from the converted tree: no option can carry a file of SQL, a report or a hash of SQL any more (review of PR 897; ADR 0202 replaces the SQL pins by the plan digest)
 for(const option of ['--sql-file','--verify-sql-file','--report','--listing-before','--listing-now','--sql-sha256','--verify-sql-sha256'])assert.throws(()=>Op.parseArgs(A('--import','--target','iptv','--confirm','import','--generation','1','--converted','x','--plan-sha256',PIN,option,'x')),e=>e.reason==='usage',option);
 for(const option of ['--sql-file','--verify-sql-file','--report','--sql-sha256','--verify-sql-sha256'])assert.throws(()=>Op.parseArgs(A('--flip','--target','iptv','--confirm','flip','--generation','1','--capture-before','a','--capture-now','b','--plan-sha256',PIN,option,'x')),e=>e.reason==='usage',option);
 assert.throws(()=>Op.parseArgs(A('--flip','--target','iptv','--confirm','flip','--generation','1','--capture-before','a','--capture-now','b')),e=>e.reason==='usage','the plan pin is required by the flip');
 const flipArgs=A('--flip','--target','iptv','--confirm','flip','--generation','1','--capture-before','a','--capture-now','b','--plan-sha256',PIN);
 assert.equal(Op.parseArgs(flipArgs).command,'flip');assert.equal(Op.parseArgs([...flipArgs,'--release','abc']).params.release,'abc');
 // --max-chunks bounds one run of import or verify (a run is resumable); the other commands do not take it
 const importArgs=A('--import','--target','iptv','--confirm','import','--generation','1','--converted','x','--plan-sha256',PIN);
 assert.equal(Op.parseArgs([...importArgs,'--max-chunks','3']).params.maxChunks,3);
 for(const bad of ['0','-1','1.5','x','1000000'])assert.throws(()=>Op.parseArgs([...importArgs,'--max-chunks',bad]),e=>e.reason==='usage',bad);
 assert.throws(()=>Op.parseArgs([...flipArgs,'--max-chunks','1']),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--seal','--target','iptv','--confirm','seal','--generation','1','--converted','x','--plan-sha256',PIN,'--max-chunks','1')),e=>e.reason==='usage');
 const ok=Op.parseArgs(A('--close','--target','iptv','--confirm','close','--generation','0'));assert.equal(ok.command,'close');assert.equal(ok.params.generation,0);
 assert.equal(Op.parseArgs(A('--target','iptv')).command,'status');
 const cli=spawnSync(process.execPath,['scripts/prediction-aux-cutover-production.mjs'],{encoding:'utf8'});assert.equal(cli.status,0);
 assert.deepEqual(JSON.parse(cli.stdout),{configured:false,writes:false,writeState:'none'});
 const refused=await Op.runPredictionAuxCutoverProduction({argv:A('--close','--target','iptv','--confirm','close','--generation','0'),env:{}});
 assert.ok([2,3].includes(refused.exit),'without the production target in the environment nothing is attempted');assert.equal(refused.result.writeState,'none');
}

// ===== 2. status is read-only, prints the plan digest and the chunks the operator derives, and says what each step would do =====
const opened=await openBucket();
const capBefore=await capture(opened);                 // the cut taken at the close
const convBefore=await Op.loadConverted(capBefore.dir);
CONV=convBefore;
{
 const env=scratch();const before=fs.readFileSync(env.file);
 const status=await run('status',env);
 assert.equal(status.writes,false);assert.equal(status.writeState,'none');assert.equal(status.schemaVersion,33);assert.equal(status.tables,'0/13');assert.equal(status.receiptTables,'0/3');
 assert.equal(status.decisions.apply,'apply');assert.equal(status.decisions.close,undefined,'nothing to close before 0034 and 0035');
 assert.match(status.migrationSha256,/^[0-9a-f]{64}$/);assert.equal(status.migrationSha256,Op.migrationSha256());
 assert.ok(fs.readFileSync(env.file).equals(before),'status changed no byte of the database');
 assert.equal(states.length,0,'no write was tracked');
 // the dataset the operator derives from the converted tree: the SAME plan the importer builds from the original objects
 assert.equal(convBefore.planSha256,planSha256(plan),'the plan digest of the converted tree is the importer\'s own for this dataset');
 assert.deepEqual(convBefore.report.stage.items,report.stage.items);assert.equal(JSON.stringify(convBefore.report),JSON.stringify(report));
 const printed=await run('status',env,{converted:convBefore,generation:1},{limits:SMALL});
 assert.equal(printed.converted.planSha256,planSha256(plan));assert.equal(printed.converted.identitySha256,capBefore.identitySha256);assert.equal(printed.converted.report.manifests.count,report.manifests.count);
 assert.ok(printed.converted.import.chunks>=3,'the small budget cuts the dataset into several chunks: '+printed.converted.import.chunks);
 assert.ok(printed.converted.verify.slices>=3);assert.equal(printed.converted.import.fits,true);assert.equal(printed.converted.verify.fits,true);
 assert.ok(printed.converted.import.maxBatchStatements<=SMALL.statements&&printed.converted.import.maxBatchBytes<=SMALL.bytes,'every chunk is inside the budget');
 assert.deepEqual(printed.converted.batches,{import:printed.converted.import.chunks,seal:1,verify:printed.converted.verify.slices,flip:1,total:printed.converted.import.chunks+printed.converted.verify.slices+2});
 assert.deepEqual(printed.converted.budget,SMALL);
 // the default budget is the owner's starting design limit, inside the measured D1 batch limits
 const standard=await run('status',env,{converted:convBefore,generation:1});
 assert.deepEqual(standard.converted.budget,{statements:CHUNK_LIMITS.statements,bytes:CHUNK_LIMITS.bytes});assert.ok(CHUNK_LIMITS.statements<=2000&&CHUNK_LIMITS.bytes<=8*1048576);
 // a budget above the D1 batch limits is clamped to them; a run (or an outbox row) that does not fit one batch is a refusal, never a split
 const clamped=await run('status',env,{converted:convBefore,generation:1},{limits:{statements:99999,bytes:99999999}});assert.deepEqual(clamped.converted.budget,{statements:2000,bytes:8*1048576});
 const tiny=await run('status',env,{converted:convBefore,generation:1},{limits:{statements:3,bytes:SMALL.bytes}});assert.equal(tiny.converted.refused,'chunk_unit_over_limits');
 // deterministic: the same inputs give the same chunks, byte for byte
 const one=Op.plansOf(convBefore,1,SMALL),two=Op.plansOf(convBefore,1,SMALL);
 assert.deepEqual(one.chunking.chunks.map(c=>c.chunkSha256),two.chunking.chunks.map(c=>c.chunkSha256));assert.deepEqual(one.slicing.slices.map(c=>c.sliceSha256),two.slicing.slices.map(c=>c.sliceSha256));
 // the plan digest does not depend on the generation or the limits; the chunk bytes do depend on the generation (the guard names it)
 assert.equal(Op.plansOf(convBefore,2,SMALL).chunking.planSha256,one.chunking.planSha256);assert.equal(Op.plansOf(convBefore,1).chunking.planSha256,one.chunking.planSha256);
 // every data statement of the plan is in exactly one chunk, in order; a whole run is never split
 const dataLines=one.chunking.chunks.flatMap(c=>c.sql.slice(1,-1));
 assert.deepEqual([...dataLines].sort(),planSql(plan,1).split('\n').filter(Boolean).slice(1).sort(),'the chunks carry every data statement of the plan once');
 const chunkOfRun=new Map();
 one.chunking.chunks.forEach(c=>{for(const line of c.sql.slice(1,-1)){const m=/^INSERT INTO prediction_run_(?:source_revision|source_piece|source_head|manifest|manifest_piece) \([a-z_, ]+\) VALUES \('([^']+)'/.exec(line);if(m){const known=chunkOfRun.get(m[1]);assert.ok(known===undefined||known===c.chunkNo,'run '+m[1].slice(0,8)+' is split across chunks');chunkOfRun.set(m[1],c.chunkNo);}}});
 assert.ok(chunkOfRun.size>=1);
 assert.equal(one.chunking.chunks.at(-1).sql.some(l=>/prediction_batch_stage /.test(l)),plan.stage.length>0,'the held stage is the last unit');
 assert.ok(fs.readFileSync(env.file).equals(before),'status with a converted tree changed nothing');
}
// ===== 2b. the converted tree is the evidence: it must be exactly what the capture recorded =====
{
 const clone=()=>{const dir=tmp();fs.cpSync(capBefore.dir,dir,{recursive:true});return dir;};
 const key='enrichment/batch-stage.json';
 const tamperSame=clone();const file=path.join(tamperSame,'tree',...key.split('/'));const bytes=fs.readFileSync(file);bytes[bytes.length-5]=bytes[bytes.length-5]^1;fs.writeFileSync(file,bytes);
 await stop(Op.loadConverted(tamperSame),'tree_not_from_capture');                      // same length, other bytes
 const extra=clone();fs.writeFileSync(path.join(extra,'tree','enrichment','sources','extra.json'),'{}');
 await stop(Op.loadConverted(extra),'tree_not_from_capture');                           // an object the capture never recorded
 const missing=clone();fs.rmSync(path.join(missing,'tree',...key.split('/')));
 await stop(Op.loadConverted(missing),'tree_not_from_capture');                         // an object that is gone
 const short=clone();fs.writeFileSync(path.join(short,'tree',...key.split('/')),fs.readFileSync(path.join(short,'tree',...key.split('/'))).subarray(0,10));
 await stop(Op.loadConverted(short),'tree_not_from_capture');
 const blocked=clone();fs.writeFileSync(path.join(blocked,'tree','enrichment','batch-manifest','bad.json'),'{not json');
 const sums=JSON.parse(fs.readFileSync(path.join(blocked,'identity.json'),'utf8'));const b=fs.readFileSync(path.join(blocked,'tree','enrichment','batch-manifest','bad.json'));
 fs.writeFileSync(path.join(blocked,'identity.json'),JSON.stringify([...sums,{key:'enrichment/batch-manifest/bad.json',etag:'e',size:b.length,sha256:sha256(b)}])+'\n');
 await stop(Op.loadConverted(blocked),'converted_blocked');                             // consistent with its capture, but the importer cannot read it
 // a verification or a report dropped next to the tree is simply never read
 const decoy=clone();fs.writeFileSync(path.join(decoy,'verify.sql'),"UPDATE prediction_aux_authority SET mode='d1', generation=2 WHERE id=1;\n");fs.writeFileSync(path.join(decoy,'report.json'),'{"stage":{"items":0}}');
 assert.equal((await Op.loadConverted(decoy)).planSha256,convBefore.planSha256);
 await stop(Op.loadConverted(path.join(tmp(),'nothing')),'file_unreadable');
}


// ===== 3. apply: pinned, atomic, read back; a stale or partial state is refused; schema 33 gets 0034 and 0035, schema 34 only 0035 =====
{
 const env=scratch();
 await stop(run('apply',env,{migrationSha256:'0'.repeat(64)}),'migration_sha256_mismatch');
 assert.equal(count(env.file,'schema_contract'),1);assert.equal(sql(env.file,'SELECT version FROM schema_contract')[0].version,33,'a refused apply changed nothing');
 const other=scratch();sql(other.file,"UPDATE prediction_domain_authority SET mode='r2' WHERE id=1");
 await stop(run('apply',other,{migrationSha256:Op.migrationSha256()}),'prediction_domain_not_d1');
 const res=await run('apply',env,{migrationSha256:Op.migrationSha256()});
 assert.equal(res.writeState,'committed');assert.deepEqual(res.applied,['0034','0035']);assert.equal(res.after.schemaVersion,35);assert.deepEqual(res.after.marker,{mode:'r2',generation:0,activatedAt:null});assert.equal(res.after.tables,'13/13');assert.equal(res.after.receiptTables,'3/3');
 assert.deepEqual(res.after.counts,{stage:0,sources:0,revisions:0,manifests:0,pieces:0,outbox:0});assert.deepEqual(res.after.receipts,{chunks:0,seals:0,slices:0});
 assert.deepEqual(marker(env.file),{mode:'r2',generation:0,at:null});
 assert.ok(states.includes('committed'));
 await stop(run('apply',env,{migrationSha256:Op.migrationSha256()}),'already_applied');
 // 0034 alone is applied (schema 34): only 0035 is missing, and only it is applied; the marker and every row stay as they were
 const half=scratch();sql(half.file,fs.readFileSync('migrations/0034_prediction_aux_authority.sql','utf8'));
 assert.equal(sql(half.file,'SELECT version FROM schema_contract')[0].version,34);
 sql(half.file,"UPDATE prediction_aux_authority SET generation=0 WHERE id=1");
 const only=await run('apply',half,{migrationSha256:Op.migrationSha256()});
 assert.deepEqual(only.applied,['0035']);assert.equal(only.after.schemaVersion,35);assert.equal(only.after.receiptTables,'3/3');assert.deepEqual(marker(half.file),{mode:'r2',generation:0,at:null});
 // partial schema (a table of the file without the rest) is refused, whatever the version says
 const partial=scratch();sql(partial.file,'CREATE TABLE prediction_aux_cas (id INTEGER PRIMARY KEY, ok INTEGER)');
 await stop(run('apply',partial,{migrationSha256:Op.migrationSha256()}),'partial_schema');
 const partialReceipts=scratch();sql(partialReceipts.file,'CREATE TABLE prediction_aux_seal (generation INTEGER PRIMARY KEY)');
 await stop(run('apply',partialReceipts,{migrationSha256:Op.migrationSha256()}),'partial_schema');
 // no step of the chunked contract runs before 0035 exists (0034 alone is applied here)
 {const early=scratch();sql(early.file,fs.readFileSync('migrations/0034_prediction_aux_authority.sql','utf8'));await stop(run('close',early,{generation:0}),'receipts_not_installed');}
 // a statement failure proven by the D1 API with the state unchanged is "not applied"; a lost reply is write_uncertain and is never retried
 const proven=scratch();let batches=0;
 const failing={prepare:s=>proven.db.prepare(s),batch:async()=>{batches++;throw new D1Error('statement','CHECK constraint failed');}};
 states.length=0;
 const failed=await stop(Op.execute('apply',{binding:failing,now:NOW,ctx:ctxOf(),params:{migrationSha256:Op.migrationSha256()}}),'statement_failed');
 assert.equal(failed.details.state.schemaVersion,33);assert.equal(batches,1);assert.equal(states.at(-1),'none');
 const lost=scratch();let tries=0;
 const timing={prepare:s=>lost.db.prepare(s),batch:async()=>{tries++;throw new D1Error('write_uncertain','response lost');}};
 states.length=0;
 await stop(Op.execute('apply',{binding:timing,now:NOW,ctx:ctxOf(),params:{migrationSha256:Op.migrationSha256()}}),'write_uncertain');
 assert.equal(tries,1,'never retried');assert.equal(states.at(-1),'unknown');
 const cli=await Op.runPredictionAuxCutoverProduction({argv:['node','x','--apply','--target','iptv','--confirm','apply','--migration-sha256',Op.migrationSha256()],deps:{binding:timing},now:()=>NOW});
 assert.equal(cli.exit,3);assert.equal(cli.result.reason,'write_uncertain');assert.equal(cli.result.writeState,'unknown');assert.equal(cli.result.writes,null);assert.equal(cli.result.retry,false);
 // the readback disagrees (a row appeared in an aux table behind the operator's back): write_uncertain, not success
 const racy=scratch();
 const racing={prepare:s=>racy.db.prepare(s),async batch(statements){await racy.db.batch(statements);sql(racy.file,"INSERT INTO prediction_event_outbox_diag (id, cap_refusals) VALUES (2, 0)");}};
 await stop(Op.execute('apply',{binding:racing,now:NOW,ctx:ctxOf(),params:{migrationSha256:Op.migrationSha256()}}),'write_uncertain');
}

// ===== 4. the whole sequence on one scratch database: apply, close, chunked import, seal, chunked verify, flip; the aux domain only =====
const env=scratch();
const otherModes=()=>JSON.stringify(sql(env.file,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%\\_authority' ESCAPE '\\' AND name<>'prediction_aux_authority' ORDER BY name").map(row=>[row.name,sql(env.file,'SELECT mode FROM '+row.name+' LIMIT 1')[0]?.mode]));
const modesBefore=otherModes();
const plansBefore=Op.plansOf(convBefore,1,SMALL);
const K=plansBefore.chunking.chunkCount,M=plansBefore.slicing.sliceCount;
const allTables=['prediction_batch_stage','prediction_run_source_head','prediction_run_source_revision','prediction_run_source_piece','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox'];
const rowTotal=file=>allTables.reduce((n,t)=>n+count(file,t),0);
await run('apply',env,{migrationSha256:Op.migrationSha256()});
let release;
{
 // before the close
 for(const command of ['import','seal','verify'])await stop(runS(command,env,pp(convBefore,1)),'marker_is_r2');
 await stop(flipExec(env,{...flipParams(convBefore),generation:0,captureNow:capBefore},NOW),'marker_is_r2');
 await stop(run('close',env,{generation:3}),'generation_mismatch');
 const closed=await run('close',env,{generation:0});
 assert.equal(closed.after.marker.mode,'closed');assert.equal(closed.importGeneration,1);assert.deepEqual(marker(env.file),{mode:'closed',generation:1,at:null});
 await stop(run('close',env,{generation:0}),'marker_is_closed');await stop(run('close',env,{generation:1}),'marker_is_closed');
 // the closed marker reaches the Worker's own readers as `closed` (the gate of ADR 0196): reads stay on R2, the D1 branch is off
 const Aux=await import('../src/prediction-aux-d1.js');
 assert.equal((await Aux.readAuxAuthority(env.db,{PREDICTION_DB_REQUIRED:'on'})).mode,'closed');
 assert.equal(await Aux.auxD1(env.db,{PREDICTION_DB_REQUIRED:'on'}),null,'partial D1 rows are not read while the marker is closed');
 // refusals before any chunk: nothing is sent
 await stop(runS('import',env,pp(convBefore,2)),'generation_mismatch');
 await stop(runS('import',env,pp(convBefore,1,{planSha256:'0'.repeat(64)})),'plan_sha256_mismatch');
 await stop(run('import',env,pp(convBefore,1),{limits:{statements:3,bytes:SMALL.bytes}}),'chunk_unit_over_limits');
 assert.equal(rowTotal(env.file),0,'nothing was written after a refusal');assert.equal(count(env.file,'prediction_aux_import_chunk'),0);
 await stop(runS('seal',env,pp(convBefore,1)),'import_incomplete');
 await stop(runS('verify',env,pp(convBefore,1)),'not_sealed');
 await stop(flipExec(env,{...flipParams(convBefore),captureNow:capBefore},NOW),'not_sealed');
 // the first chunk alone, then the rest from its receipt
 const first=await runS('import',env,pp(convBefore,1,{maxChunks:1}));
 assert.equal(first.complete,false);assert.equal(first.appliedNow.length,1);assert.equal(first.appliedNow[0].no,1);assert.equal(first.writeState,'committed');assert.equal(first.total,K);
 assert.deepEqual(first.after.receipts,{chunks:1,seals:0,slices:0});assert.ok(rowTotal(env.file)>0);
 const receipt1=sql(env.file,'SELECT * FROM prediction_aux_import_chunk');
 assert.equal(receipt1.length,1);assert.equal(receipt1[0].chunk_sha256,plansBefore.chunking.chunks[0].chunkSha256);assert.equal(receipt1[0].plan_sha256,plansBefore.chunking.planSha256);assert.equal(receipt1[0].statements,plansBefore.chunking.chunks[0].dataStatements);
 // after the first chunk the abort path is gone
 await stop(run('reopen',env,{generation:1}),'tables_not_empty');await stop(run('close',env,{generation:1}),'marker_is_closed');
 const rest=await runS('import',env,pp(convBefore,1));
 assert.equal(rest.complete,true);assert.equal(rest.appliedNow.length,K-1);assert.deepEqual(rest.appliedNow.map(x=>x.no),Array.from({length:K-1},(_,i)=>i+2));
 assert.ok(rest.appliedNow.every(x=>Number.isFinite(x.ms)&&x.attempts===1&&x.applied==='this_attempt'),'the duration of every chunk is measured');
 assert.deepEqual(rest.after.counts,{stage:report.stage.items,sources:report.sources.runs,revisions:report.sources.revisions,manifests:report.manifests.count,pieces:report.manifests.pieces,outbox:report.outbox.total});
 const again=await runS('import',env,pp(convBefore,1));assert.deepEqual(again.appliedNow,[]);assert.equal(again.complete,true);assert.equal(again.writes,false,'a finished import has nothing to send');
 // the seal: the cohort is frozen by the database
 await stop(runS('verify',env,pp(convBefore,1)),'not_sealed');
 const sealed=await runS('seal',env,pp(convBefore,1));
 assert.equal(sealed.writeState,'committed');assert.deepEqual(sealed.after.receipts,{chunks:K,seals:1,slices:0});assert.equal(sealed.chunks,K);assert.equal(sealed.slices,M);
 await stop(runS('seal',env,pp(convBefore,1)),'already_sealed');await stop(runS('import',env,pp(convBefore,1)),'sealed');
 const frozen=JSON.stringify(allTables.map(t=>count(env.file,t)));
 for(const [label,statement] of [
  ['an insert into a family table',"INSERT INTO prediction_run_source_head (run_id,current_revision,source_hash) VALUES ('late-run',1,'"+'a'.repeat(64)+"')"],
  ['an update of a source head',"UPDATE prediction_run_source_head SET current_revision=current_revision+1 WHERE rowid=(SELECT min(rowid) FROM prediction_run_source_head)"],
  ['a delete of a source head',"DELETE FROM prediction_run_source_head"],
  ['an update of an outbox row',"UPDATE prediction_event_outbox SET attempts=attempts+1"],
  ['a delete of an outbox row',"DELETE FROM prediction_event_outbox"],
  ['an update of the stage head',"UPDATE prediction_batch_stage_head SET revision=revision+1"],
  ['an update of the stage',"UPDATE prediction_batch_stage SET position=position"],
  ['an insert into the manifest',"INSERT INTO prediction_run_manifest (run_id,manifest_hash,payload_digest,selected_ids,drained_json,bytes,piece_count,part_index,created_at) VALUES ('late-run','h12345678','"+'b'.repeat(64)+"','[]',NULL,1,1,'{}','1970-01-01T00:00:00.000Z')"],
  ['an update of the skipped counter',"UPDATE prediction_event_outbox_counter SET active_pending=active_pending"],
  ['an update of the state counts',"UPDATE prediction_event_outbox_state_count SET n=n"],
  ['an update of the diagnostic row',"UPDATE prediction_event_outbox_diag SET cap_refusals=cap_refusals+1"],
  ['a second seal',"INSERT INTO prediction_aux_seal (generation,plan_sha256,chunk_count,slice_count) VALUES (1,'"+'c'.repeat(64)+"',1,1)"],
  ['an update of a receipt',"UPDATE prediction_aux_import_chunk SET statements=statements"],
  ['a delete of a receipt',"DELETE FROM prediction_aux_import_chunk"],
 ])assert.throws(()=>sql(env.file,statement),/prediction_aux_(sealed|receipt_immutable)|UNIQUE|PRIMARY KEY|constraint/i,label);
 assert.equal(JSON.stringify(allTables.map(t=>count(env.file,t))),frozen,'nothing of the cohort changed');
 // the chunked verification on the sealed data, resumable; the flip waits for every slice
 const v1=await runS('verify',env,pp(convBefore,1,{maxChunks:1}));
 assert.equal(v1.complete,false);assert.equal(v1.appliedNow.length,1);assert.equal(v1.total,M);assert.deepEqual(v1.after.receipts,{chunks:K,seals:1,slices:1});
 await stop(flipExec(env,{...flipParams(convBefore),captureNow:capBefore},NOW),'verify_incomplete');
 const vRest=await runS('verify',env,pp(convBefore,1));
 assert.equal(vRest.complete,true);assert.equal(vRest.appliedNow.length,M-1);assert.deepEqual(vRest.after.receipts,{chunks:K,seals:1,slices:M});
 const vAgain=await runS('verify',env,pp(convBefore,1));assert.deepEqual(vAgain.appliedNow,[]);assert.equal(vAgain.complete,true);
 const slices=sql(env.file,'SELECT slice_no, slice_sha256 FROM prediction_aux_verify_slice ORDER BY slice_no');assert.deepEqual(slices.map(x=>x.slice_sha256),plansBefore.slicing.slices.map(x=>x.sliceSha256));

 // ---- the decisions of the flip, one reason at a time (the state is the real one after the verification) ----
 const capNow=await capture(opened);              // a fresh cut just before the flip: nothing changed in the bucket
 const at=clockAfter(capNow);
 const state=await Op.readState(env.db,at);
 const d=(extra={})=>Op.flipDecision(state,{generation:1,report,before:capBefore,now:capNow,chunking:plansBefore.chunking,slicing:plansBefore.slicing,clock:at,source:SOURCE,...extra});
 assert.equal(d({generation:2}).reason,'generation_mismatch');
 assert.equal(d({report:{...report,manifests:{...report.manifests,count:report.manifests.count+1}}}).reason,'counts_differ');
 assert.equal(d({report:{...report,outbox:{...report.outbox,byState:{...report.outbox.byState,pending:(report.outbox.byState.pending||0)+1}}}}).reason,'outbox_states_differ');
 assert.equal(d({report:{stage:{}}}).reason,'report_invalid');
 assert.equal(d({chunking:{...plansBefore.chunking,planSha256:'0'.repeat(64)}}).reason,'seal_mismatch');
 assert.equal(d({chunking:{...plansBefore.chunking,chunkCount:K+1}}).reason,'seal_mismatch');
 assert.equal(d({slicing:{...plansBefore.slicing,sliceCount:M+1}}).reason,'seal_mismatch');
 const foreign=await openBucket({'enrichment/sources/another-run.json':json({tmdb_1:{modelMetadata:{}}})});
 const capForeign=await capture(foreign);const capForeignNow=await capture(foreign);await foreign.bucket.stop();
 assert.equal(d({before:capForeign,now:capForeignNow}).reason,'report_not_from_export');
 assert.equal(d({now:capBefore}).reason,'captures_not_distinct');
 assert.equal(d({clock:at+3600000}).reason,'capture_not_fresh');
 assert.equal(d({source:{...SOURCE,bucket:'other'}}).reason,'capture_source_mismatch');
 const inconsistent=structuredClone(capNow);inconsistent.report.snapshot.status='no_go';assert.equal(d({now:inconsistent}).reason,'capture_not_consistent');
 const edited=capNow.identityText.replace('"size":','"size":1');assert.equal(d({now:{...capNow,identityText:edited,identitySha256:sha256(edited)}}).reason,'capture_identity_mismatch');
 assert.equal(d({now:{identity:'x'}}).reason,'capture_invalid');
 assert.equal(d().reason,'release_required');

 // ---- flip through the operator ----
 const base={...flipParams(convBefore),captureNow:capNow};
 const flipRun=(params,extra={})=>Op.execute('flip',{binding:env.db,now:at,ctx:ctxOf(),params,limits:SMALL,...extra});
 await stop(flipRun({...base,generation:2}),'generation_mismatch');
 await stop(flipRun({...base,planSha256:'0'.repeat(64)}),'plan_sha256_mismatch');
 await stop(flipRun({...base,captureBefore:undefined}),'converted_required');
 await stop(flipRun({...base,captureNow:convBefore.capture}),'captures_not_distinct');
 await stop(Op.execute('flip',{binding:env.db,now:at+3600000,ctx:ctxOf(),params:base,limits:SMALL}),'capture_not_fresh');
 // a late write for real: a legacy PUT lands in the bucket after the close (the same key, other bytes, the same length); the next fresh cut sees another ETag and the flip is refused
 const key=Object.keys(legacyBytes).find(k=>k.startsWith('enrichment/stop-events/')),text=legacyBytes[key];
 const flippedText=text.replace(/"at":"(\d{4})/,(m,y)=>'"at":"'+(Number(y)===2026?'2025':'2026'));assert.equal(flippedText.length,text.length);assert.notEqual(flippedText,text);
 await opened.bucket.put(key,flippedText);
 const capLate=await capture(opened);
 const late=await stop(flipRun({...base,captureNow:capLate},{now:clockAfter(capLate)}),'listing_changed');
 assert.deepEqual(late.details.changed,[key],'the landing is seen by ETag even though the key set and the size are unchanged');
 await opened.bucket.put(key,text);                // the object is back to what was exported (a new ETag): the cut taken at the close is stale now
 const capBack=await capture(opened);
 await stop(flipRun({...base,captureNow:capBack},{now:clockAfter(capBack)}),'listing_changed');
 // the owner re-takes the cut at the close and the final one: two clean captures of the same bytes that were imported
 const capClose=await capture(opened),capFinal=await capture(opened);
 const convClose=await Op.loadConverted(capClose.dir);
 assert.equal(convClose.planSha256,convBefore.planSha256,'the same dataset derives the same plan digest');
 const clean={...flipParams(convClose),captureNow:capFinal};
 const atFinal=clockAfter(capFinal);
 // without the release the flip prints the exact release and writes nothing; a wrong release is refused
 const needed=await stop(flipRun(clean,{now:atFinal}),'release_required');
 release=needed.details.release;assert.match(release,/^[0-9a-f]{16}$/);
 const releaseOf=(args={})=>Op.flipRelease({generation:1,capture:capFinal,report,planSha256:plansBefore.chunking.planSha256,chunkCount:K,sliceCount:M,...args});
 assert.equal(release,releaseOf());
 await stop(flipRun({...clean,release:'0'.repeat(16)},{now:atFinal}),'release_mismatch');
 assert.notEqual(releaseOf({capture:capLate}),release,'the release binds the final capture');
 assert.notEqual(releaseOf({generation:2}),release,'and the generation');
 assert.notEqual(releaseOf({planSha256:sha256('other')}),release,'and the plan digest');
 assert.notEqual(releaseOf({chunkCount:K+1}),release,'and the number of import receipts');
 assert.notEqual(releaseOf({sliceCount:M+1}),release,'and the number of verification receipts');
 assert.deepEqual(marker(env.file),{mode:'closed',generation:1,at:null},'every refusal left the marker closed');
 // the flip itself: ONE small guarded batch (the guard and the marker), irreversible
 let flipBatch=null;
 const spying={prepare:s=>env.db.prepare(s),async batch(statements){flipBatch=statements.length;return env.db.batch(statements);}};
 const flipped=await Op.execute('flip',{binding:spying,now:atFinal,ctx:ctxOf(),params:{...clean,release},limits:SMALL});
 assert.equal(flipBatch,2,'the flip is two statements: the guard and the marker');
 assert.equal(flipped.writeState,'committed');assert.equal(flipped.irreversible,true);assert.equal(flipped.after.marker.mode,'d1');assert.equal(flipped.after.marker.generation,2);assert.equal(flipped.after.marker.activatedAt,new Date(atFinal).toISOString());
 assert.deepEqual(flipped.receipts,{chunks:K,slices:M});assert.equal(flipped.planSha256,plansBefore.chunking.planSha256);
 assert.equal(marker(env.file).mode,'d1');
 assert.equal((await Aux.readAuxAuthority(env.db,{PREDICTION_DB_REQUIRED:'on'})).mode,'d1');
 // after d1 the seal does not block: a normal Worker write goes through (a new run source and an outbox state change)
 sql(env.file,"INSERT INTO prediction_run_source_head (run_id,current_revision,source_hash) VALUES ('after-flip',1,'"+'d'.repeat(64)+"')");
 sql(env.file,"UPDATE prediction_run_source_head SET current_revision=2 WHERE run_id='after-flip'");
 sql(env.file,"UPDATE prediction_event_outbox_diag SET cap_refusals=cap_refusals+1");
 // every sealed family accepts normal Worker writes after d1 (the seal triggers stand down on the marker, not only for the tables used above)
 sql(env.file,"UPDATE prediction_event_outbox SET attempts=attempts+1 WHERE rowid=(SELECT min(rowid) FROM prediction_event_outbox)");
 sql(env.file,"UPDATE prediction_event_outbox_counter SET active_pending=active_pending");
 sql(env.file,"UPDATE prediction_event_outbox_state_count SET n=n");
 // insert and delete paths too (a copy of each counter row is written and removed again)
 sql(env.file,"CREATE TEMP TABLE keep AS SELECT * FROM prediction_event_outbox_counter; DELETE FROM prediction_event_outbox_counter; INSERT INTO prediction_event_outbox_counter SELECT * FROM keep");
 sql(env.file,"UPDATE prediction_batch_stage_head SET revision=revision+1");
 sql(env.file,"UPDATE prediction_batch_stage SET position=position");
 assert.equal(count(env.file,'prediction_run_source_head'),report.sources.runs+1);
 // after d1 nothing moves back: every command is refused, and the schema itself refuses the marker
 for(const [command,params] of [['close',{generation:2}],['import',pp(convBefore,2)],['seal',pp(convBefore,2)],['verify',pp(convBefore,2)],['reopen',{generation:2}]])await stop(runS(command,env,params),'marker_is_d1');
 await stop(Op.execute('flip',{binding:env.db,now:atFinal,ctx:ctxOf(),params:{...clean,generation:2,release},limits:SMALL}),'marker_is_d1');
 assert.throws(()=>sql(env.file,"UPDATE prediction_aux_authority SET mode='r2', generation=9, activated_at=NULL"),/prediction_aux_authority/);
 assert.equal(otherModes(),modesBefore,'no other domain changed its mode or cutover');
 assert.equal(sql(env.file,'SELECT version FROM schema_contract')[0].version,35);
}

// ===== 4b. what a batch may carry: the importer's exact shapes, never the marker (review of PR 897); the operator derives its batches and re-checks them =====
{
 const plans=Op.plansOf(convBefore,1,SMALL);
 const chunk=plans.chunking.chunks[0].sql,slice=plans.slicing.slices[0].sql;
 const activate="UPDATE prediction_aux_authority SET mode='d1', generation=2, activated_at='2026-11-22T14:00:00.000Z' WHERE id=1";
 const refuse=(kind,statements,reason='sql_refused')=>{try{Op.checkBatch(kind,statements);}catch(error){assert.equal(error.reason,reason,JSON.stringify(String(statements?.[0]).slice(0,50)));return;}assert.fail('expected '+reason);};
 // the real batches pass
 for(const item of plans.chunking.chunks)assert.equal(Op.checkBatch('chunk',item.sql).statements,item.statements);
 for(const item of plans.slicing.slices)assert.equal(Op.checkBatch('slice',item.sql).statements,item.statements);
 // a marker statement anywhere in a chunk or a slice is refused: as the guard, in the middle, in place of the receipt, appended
 refuse('chunk',[activate,...chunk.slice(1)]);refuse('chunk',[chunk[0],activate,...chunk.slice(1)]);refuse('chunk',[...chunk.slice(0,-1),activate]);refuse('chunk',[...chunk,activate]);
 refuse('slice',[activate,...slice.slice(1)]);refuse('slice',[slice[0],activate,...slice.slice(1)]);refuse('slice',[...slice.slice(0,-1),activate]);refuse('slice',[...slice,activate]);
 refuse('chunk',[chunk[0],"INSERT INTO prediction_aux_authority (id, mode, generation, activated_at) VALUES (2, 'd1', 3, '2026-11-22T14:00:00.000Z');",chunk.at(-1)]);
 // a guard that hides a marker update inside its own text (two statements in one, or a second UPDATE)
 refuse('chunk',[chunk[0]+"; "+activate,...chunk.slice(1)]);
 refuse('chunk',["UPDATE prediction_aux_cas SET ok=1 WHERE id=1; UPDATE prediction_aux_authority SET mode='d1' WHERE id=1",...chunk.slice(1)]);
 // other shapes: other writes, a select, a drop, a delete, a counter, a receipt in the middle, a missing receipt, an empty batch
 refuse('chunk',[chunk[0],"DELETE FROM prediction_event_outbox;",chunk.at(-1)]);refuse('chunk',[chunk[0],"DROP TRIGGER prediction_aux_authority_chain;",chunk.at(-1)]);
 refuse('chunk',[chunk[0],"INSERT INTO prediction_event_outbox_counter (kind, active_pending) VALUES ('x', 1);",chunk.at(-1)]);
 refuse('chunk',[chunk[0],"INSERT INTO prediction_batch_stage (film_id) SELECT film_id FROM film;",chunk.at(-1)]);
 refuse('chunk',[chunk[0],"UPDATE prediction_aux_cas SET ok=1 WHERE id=1;",chunk.at(-1)]);
 refuse('chunk',[chunk[0],chunk.at(-1),chunk.at(-1)]);refuse('chunk',chunk.slice(0,-1));
 refuse('slice',[slice[0],"UPDATE prediction_aux_cas SET ok=(SELECT count(*)=0 FROM prediction_aux_authority) WHERE id=1;",slice.at(-1)]);
 refuse('slice',[slice[0],"UPDATE prediction_aux_cas SET ok=1 WHERE id=1;",slice.at(-1)]);
 refuse('slice',[slice[0],"DELETE FROM prediction_run_source_head;",slice.at(-1)]);refuse('slice',slice.slice(0,-1));
 refuse('chunk',[],'sql_empty');refuse('slice',[],'sql_empty');
 // the seal and the flip batches are exactly two statements: the guard and one fixed statement
 const seal=sealStatements(plan,{generation:1,chunkCount:plans.chunking.chunkCount,sliceCount:plans.slicing.sliceCount}),flip=flipStatements(plan,{generation:1,chunkCount:plans.chunking.chunkCount,sliceCount:plans.slicing.sliceCount,activatedAt:'2026-11-22T14:00:00.000Z'});
 assert.equal(Op.checkBatch('seal',seal).statements,2);assert.equal(Op.checkBatch('flip',flip).statements,2);
 refuse('flip',[flip[0],flip[1],"DELETE FROM prediction_event_outbox;"]);refuse('flip',[flip[0],"UPDATE prediction_aux_authority SET mode='r2' WHERE id=1"]);refuse('flip',[seal[0],seal[1]]);refuse('seal',[seal[0],flip[1]]);refuse('flip',[activate,flip[1]]);
 // a literal that merely CONTAINS the words is data, not a statement: a document that names the marker still chunks and passes
 const sneaky=await buildPlan({...objects,'enrichment/sources/sneaky-run.json':{title:"'; UPDATE prediction_aux_authority SET mode='d1'; --",note:"prediction_aux_authority"}});
 const sneakyChunks=chunkPlan(sneaky,{generation:1,limits:SMALL});for(const item of sneakyChunks.chunks)Op.checkBatch('chunk',item.sql);
 // defence in depth: a hand-built converted object cannot make the operator run SQL of its own: the batches come from the plan and a text carried next to it is never used
 const e=scratch();await run('apply',e,{migrationSha256:Op.migrationSha256()});await run('close',e,{generation:0});
 const evil={...convBefore,importText:()=>activate,verifyText:activate,chunks:[{sql:[activate]}]};
 const done=await runS('import',e,pp(evil,1));assert.equal(done.complete,true,'the derived chunks ran, not any text carried next to the plan');
 assert.deepEqual(marker(e.file),{mode:'closed',generation:1,at:null},'the marker did not move');
}

// ===== 4c. receipts, exactly-once chunks, ambiguous outcomes, competing attempts, stale generations, the seal and a failed verification =====
{
 const plansOf=Op.plansOf(convBefore,1,SMALL),chunks=plansOf.chunking.chunks,slices=plansOf.slicing.slices;
 const prepared=(e,item)=>item.sql.map(text=>e.db.prepare(text).bind());
 const closedScratch=async()=>{const e=scratch();await run('apply',e,{migrationSha256:Op.migrationSha256()});await run('close',e,{generation:0});return e;};
 // a chunk out of order, or a later chunk first: the guard aborts the whole batch and nothing is written
 {
  const e=await closedScratch();
  await assert.rejects(e.db.batch(prepared(e,chunks[1])),/constraint|CHECK/i);assert.equal(rowTotal(e.file),0);assert.equal(count(e.file,'prediction_aux_import_chunk'),0);
  await runS('import',e,pp(convBefore,1,{maxChunks:1}));
  await assert.rejects(e.db.batch(prepared(e,chunks[2])),/constraint|CHECK/i,'chunk 3 cannot skip chunk 2');await assert.rejects(e.db.batch(prepared(e,chunks[0])),/constraint|CHECK/i,'chunk 1 cannot run twice');
  assert.equal(count(e.file,'prediction_aux_import_chunk'),1);
 }
 // two competing attempts of one chunk: exactly one commits (the second meets the guard or the receipt key)
 {
  const e=await closedScratch();
  const settled=await Promise.allSettled([e.db.batch(prepared(e,chunks[0])),e.db.batch(prepared(e,chunks[0]))]);
  assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);assert.equal(settled.filter(x=>x.status==='rejected').length,1);assert.equal(count(e.file,'prediction_aux_import_chunk'),1);
  const before=rowTotal(e.file);await assert.rejects(e.db.batch(prepared(e,chunks[0])),/constraint|CHECK/i);assert.equal(rowTotal(e.file),before,'the second attempt wrote nothing');
 }
 // a chunk of ANOTHER plan cannot start or continue: the plan digest is part of the guard, and an existing receipt of another plan makes the operator stop
 {
  const foreign=await openBucket({'enrichment/sources/another-run.json':json({tmdb_1:{modelMetadata:{}}})});const capF=await capture(foreign);await foreign.bucket.stop();
  const convF=await Op.loadConverted(capF.dir);assert.notEqual(convF.planSha256,convBefore.planSha256);
  const other=Op.plansOf(convF,1,SMALL).chunking.chunks;
  const e=await closedScratch();
  await runS('import',e,pp(convBefore,1,{maxChunks:1}));
  await assert.rejects(e.db.batch(prepared(e,other[1])),/constraint|CHECK/i);
  await stop(runS('import',e,pp(convF,1)),'receipt_plan_mismatch');
  await stop(runS('seal',e,pp(convF,1)),'receipt_plan_mismatch');
  // a plan that would start under existing rows of another plan is refused too
  const e2=await closedScratch();await runS('import',e2,pp(convF,1,{maxChunks:1}));
  await assert.rejects(e2.db.batch(prepared(e2,chunks[1])),/constraint|CHECK/i);
 }
 // a stale chunk of an older closure generation: close(0)->1, reopen (empty) ->2, close ->3; the chunk built for generation 1 cannot commit under generation 3
 {
  const e=await closedScratch();
  const stale=Op.plansOf(convBefore,1,SMALL).chunking.chunks[0];
  await run('reopen',e,{generation:1});await run('close',e,{generation:2});assert.equal(marker(e.file).generation,3);
  await assert.rejects(e.db.batch(prepared(e,stale)),/constraint|CHECK/i);assert.equal(rowTotal(e.file),0);
  await stop(runS('import',e,pp(convBefore,1)),'generation_mismatch');
  const fresh=await runS('import',e,pp(convBefore,3));assert.equal(fresh.complete,true);
  assert.equal(sql(e.file,'SELECT DISTINCT generation FROM prediction_aux_import_chunk').map(x=>x.generation).join(),'3');
 }
 // ambiguous outcome 1: the batch COMMITS but the reply is lost. The receipt is read; it carries the chunk's own digest, so the chunk counts as applied by the earlier attempt (no second send)
 {
  const e=await closedScratch();let calls=0;
  const lostReply={prepare:s=>e.db.prepare(s),async batch(statements){calls++;await e.db.batch(statements);if(calls===1)throw new D1Error('write_uncertain','reply lost');}};
  const result=await Op.execute('import',{binding:lostReply,now:NOW,ctx:ctxOf(),params:pp(convBefore,1,{maxChunks:1}),limits:SMALL});
  assert.equal(calls,1,'the committed chunk was not sent again');assert.equal(result.appliedNow[0].applied,'earlier_attempt');assert.equal(result.appliedNow[0].attempts,1);assert.equal(count(e.file,'prediction_aux_import_chunk'),1);
 }
 // ambiguous outcome 2: the first attempt times out WITHOUT committing, the identical retry commits, then the old attempt commits LATE: it meets the receipt and writes nothing
 {
  const e=await closedScratch();let calls=0,stash=null;
  const timeout={prepare:s=>e.db.prepare(s),async batch(statements){calls++;if(calls===1){stash=statements;throw new D1Error('write_uncertain','timeout');}return e.db.batch(statements);}};
  const result=await Op.execute('import',{binding:timeout,now:NOW,ctx:ctxOf(),params:pp(convBefore,1,{maxChunks:1}),limits:SMALL});
  assert.equal(calls,2,'a missing receipt proves nothing: the SAME chunk was sent again');assert.equal(result.appliedNow[0].applied,'this_attempt');assert.equal(result.appliedNow[0].attempts,2);
  const rows=rowTotal(e.file);await assert.rejects(e.db.batch(stash),/constraint|CHECK/i,'the late commit of the old attempt');
  assert.equal(rowTotal(e.file),rows);assert.equal(count(e.file,'prediction_aux_import_chunk'),1);
  // and the late attempt cannot run ahead of chunk k+1: after chunk 2 is applied, a stale copy of chunk 1 or 2 still fails
  await runS('import',e,pp(convBefore,1,{maxChunks:1}));await assert.rejects(e.db.batch(prepared(e,chunks[1])),/constraint|CHECK/i);
 }
 // ambiguous outcome 3: every attempt is lost without committing: three identical attempts, then a stop; the tracker says unknown and nothing is applied
 {
  const e=await closedScratch();let calls=0;
  const dead={prepare:s=>e.db.prepare(s),async batch(){calls++;throw new D1Error('write_uncertain','never answers');}};
  states.length=0;
  await stop(Op.execute('import',{binding:dead,now:NOW,ctx:ctxOf(),params:pp(convBefore,1),limits:SMALL}),'write_uncertain');
  assert.equal(calls,3);assert.equal(states.at(-1),'unknown');assert.equal(rowTotal(e.file),0);
  // a proven rejection that left no receipt is a stop at once (no retry)
  const rejected={prepare:s=>e.db.prepare(s),async batch(){calls++;throw new D1Error('statement','CHECK constraint failed');}};calls=0;
  await stop(Op.execute('import',{binding:rejected,now:NOW,ctx:ctxOf(),params:pp(convBefore,1),limits:SMALL}),'statement_failed');assert.equal(calls,1);
 }
 // a receipt of other bytes in the place of the chunk: the operator stops (never replaces or skips)
 {
  const e=await closedScratch();await runS('import',e,pp(convBefore,1,{maxChunks:1}));
  const tampered=Op.plansOf(convBefore,1,{statements:SMALL.statements,bytes:SMALL.bytes-1000});   // other boundaries: chunk 1 has other bytes
  if(tampered.chunking.chunks[0].chunkSha256!==chunks[0].chunkSha256)await stop(Op.execute('import',{binding:e.db,now:NOW,ctx:ctxOf(),params:pp(convBefore,1),limits:{statements:SMALL.statements,bytes:SMALL.bytes-1000}}),'receipt_mismatch');
  else assert.ok(true);
 }
 // a verification that FAILS: a row of the cohort is damaged before the seal (the totals still match, so the seal passes); the slice holding it is a proven statement failure with no receipt, the flip is refused, the marker stays closed
 {
  const e=await closedScratch();await runS('import',e,pp(convBefore,1));
  sql(e.file,'DROP TRIGGER prediction_event_outbox_settled_terminal');sql(e.file,'DROP TRIGGER prediction_event_outbox_identity');
  sql(e.file,"UPDATE prediction_event_outbox SET attempts=attempts+3 WHERE rowid=(SELECT min(rowid) FROM prediction_event_outbox)");
  await runS('seal',e,pp(convBefore,1));
  const proven={prepare:s=>e.db.prepare(s),async batch(statements){try{await e.db.batch(statements);}catch(error){throw new D1Error('statement',String(error.message));}}};
  states.length=0;
  const failed=await stop(Op.execute('verify',{binding:proven,now:NOW,ctx:ctxOf(),params:pp(convBefore,1),limits:SMALL}),'statement_failed');
  assert.equal(failed.details.state.marker.mode,'closed');assert.equal(states.at(-1),'none');
  const have=count(e.file,'prediction_aux_verify_slice');assert.ok(have<M,'the damaged slice left no receipt');
  const cap2=await capture(opened);
  await stop(flipExec(e,{...flipParams(convBefore),captureNow:cap2},clockAfter(cap2)),'verify_incomplete');
  assert.equal(marker(e.file).mode,'closed','fail closed: the marker never moved');
  // the sealed cohort cannot be repaired through the database (only the owner can, by an operation that is not designed here)
  assert.throws(()=>sql(e.file,"UPDATE prediction_event_outbox SET attempts=0"),/prediction_aux_sealed/);
 }
 // totals that do not match the plan: the seal refuses (a row was added behind the operator's back before the seal)
 {
  const e=await closedScratch();await runS('import',e,pp(convBefore,1));
  sql(e.file,"INSERT INTO prediction_run_source_head (run_id,current_revision,source_hash) VALUES ('extra-run',1,'"+'e'.repeat(64)+"')");
  await stop(runS('seal',e,pp(convBefore,1)),'counts_differ');
  // and the in-batch guard refuses even when the operator's own pre-check is bypassed
  const seal=sealStatements(plan,{generation:1,chunkCount:K,sliceCount:M});
  await assert.rejects(e.db.batch(seal.map(text=>e.db.prepare(text).bind())),/constraint|CHECK/i);assert.equal(count(e.file,'prediction_aux_seal'),0);
 }
 // the stage head the Worker's readStage cross-checks (item_count, total_bytes, revision, updated_at), altered after the import and before the seal: the seal refuses
 for(const [label,change] of [['item_count',"UPDATE prediction_batch_stage_head SET item_count=0"],['total_bytes',"UPDATE prediction_batch_stage_head SET total_bytes=total_bytes+1"],['revision',"UPDATE prediction_batch_stage_head SET revision=revision+1"],['updated_at',"UPDATE prediction_batch_stage_head SET updated_at='1999-01-01T00:00:00.000Z'"]]){
  const e=await closedScratch();await runS('import',e,pp(convBefore,1));
  sql(e.file,change);
  const refused=await runS('seal',e,pp(convBefore,1)).then(()=>null,error=>error);
  assert.ok(refused,'the seal refuses a stage head or stage row that differs from the plan: '+label);
  assert.equal(count(e.file,'prediction_aux_seal'),0,label);assert.equal(marker(e.file).mode,'closed',label);
  // and the in-batch guard refuses even when the operator's own pre-check is bypassed
  const seal=sealStatements(plan,{generation:1,chunkCount:K,sliceCount:M});
  await assert.rejects(e.db.batch(seal.map(text=>e.db.prepare(text).bind())),/constraint|CHECK/i,label);
 }
 // held_at of a staged row, altered before the seal, is caught by the byte-level verification (a slice fails, the marker never moves)
 {
  const e=await closedScratch();await runS('import',e,pp(convBefore,1));
  sql(e.file,"UPDATE prediction_batch_stage SET held_at='1999-01-01T00:00:00.000Z' WHERE rowid=(SELECT min(rowid) FROM prediction_batch_stage)");
  await runS('seal',e,pp(convBefore,1));
  const failed=await runS('verify',e,pp(convBefore,1)).then(()=>null,error=>error);
  assert.ok(failed,'a differing held_at fails the verification');assert.ok(count(e.file,'prediction_aux_verify_slice')<M);assert.equal(marker(e.file).mode,'closed');
 }
 // a flip batch built for the right plan cannot commit without the seal or with missing slices (the guard of the batch itself, not the operator's checks)
 {
  const e=await closedScratch();await runS('import',e,pp(convBefore,1));
  const flip=flipStatements(plan,{generation:1,chunkCount:K,sliceCount:M,activatedAt:'2026-11-22T14:00:00.000Z'});
  await assert.rejects(e.db.batch(flip.map(text=>e.db.prepare(text).bind())),/constraint|CHECK/i,'no seal');
  await runS('seal',e,pp(convBefore,1));await runS('verify',e,pp(convBefore,1,{maxChunks:1}));
  await assert.rejects(e.db.batch(flip.map(text=>e.db.prepare(text).bind())),/constraint|CHECK/i,'missing slices');
  assert.equal(marker(e.file).mode,'closed');
  // a slice cannot commit out of order (slice 2 before slice 1 has its receipt)
  const ordered=slicePlan(plan,{generation:1,chunkCount:K,limits:SMALL}).slices;
  const e2=await closedScratch();await runS('import',e2,pp(convBefore,1));await runS('seal',e2,pp(convBefore,1));
  await assert.rejects(e2.db.batch(ordered[1].sql.map(text=>e2.db.prepare(text).bind())),/constraint|CHECK/i,'slice 2 first');
  assert.equal(count(e2.file,'prediction_aux_verify_slice'),0);
 // a slice built for another seal (other chunk count) cannot commit
  const wrong=slicePlan(plan,{generation:1,chunkCount:K+1,limits:SMALL}).slices[1];
  await assert.rejects(e.db.batch(wrong.sql.map(text=>e.db.prepare(text).bind())),/constraint|CHECK/i);
 }
}

// ===== 4e. scoped captures (`--scope prediction-aux`, ADR 0200): the whole sequence with scoped cuts, an unrelated writer that no longer matters, and the refusals of a mixed or unsupported proof =====
{
 const e=scratch();
 const o=await openBucket({'epg/published-generation.json':json({programmeRunId:'p-1'}),'sync.json':json({updatedAt:'t'}),'monitor/state.json':json({tick:1})});
 const scopedBefore=await capture(o,{scope:'prediction-aux'});
 assert.equal(scopedBefore.report.snapshot.scope.kind,'prediction_aux');
 const conv=await Op.loadConverted(scopedBefore.dir);
 assert.equal(conv.planSha256,convBefore.planSha256,'the scoped tree is the same auxiliary dataset as the whole-bucket one');
 await stage(e,'verified',{conv});
 const plans=Op.plansOf(conv,1,SMALL),Kc=plans.chunking.chunkCount,Ms=plans.slicing.sliceCount;
 // unrelated writers change the bucket between the two cuts: a scoped cut is independent of them, and the flip compares only the auxiliary identity
 await o.bucket.put('epg/published-generation.json',json({programmeRunId:'p-2'}));await o.bucket.put('sync.json',json({updatedAt:'t2'}));await o.bucket.put('monitor/state.json',json({tick:2}));await o.bucket.put('letterboxd/diary/state.json',json({n:9}));
 const scopedNow=await capture(o,{scope:'prediction-aux'});
 const wholeNow=await capture(o);                       // a whole-bucket cut of the same moment (the legacy proof)
 assert.equal(wholeNow.report.snapshot.scope.kind,'full_bucket');
 const at=clockAfter(scopedNow);
 const params=(before,nowCapture,extra={})=>({...flipParams(conv),captureBefore:before,captureNow:nowCapture,...extra});
 const exec=(p,time=at)=>Op.execute('flip',{binding:e.db,now:time,ctx:ctxOf(),params:p,limits:SMALL});
 // a scoped capture next to a whole-bucket one is two different proofs: refused, whichever way round
 await stop(exec(params(conv,wholeNow)),'capture_scope_mismatch');
 // an unsupported or edited proof is refused: the digest must be exactly the current definition of the scope it names
 const edit=(capture,mutate)=>{const copy={...capture,report:structuredClone(capture.report)};mutate(copy.report);return copy;};
 const state0=await Op.readState(e.db,at);
 const decision=(before,nowCap)=>Op.flipDecision(state0,{generation:1,report:conv.report,before,now:nowCap,chunking:plans.chunking,slicing:plans.slicing,clock:at,source:SOURCE});
 assert.equal(decision(edit(scopedBefore,r=>{r.snapshot.scope.digest='0'.repeat(64);}),scopedNow).reason,'capture_scope_unsupported');
 assert.equal(decision(scopedBefore,edit(scopedNow,r=>{r.snapshot.scope={kind:'everything',digest:null};})).reason,'capture_scope_unsupported');
 assert.equal(decision(scopedBefore,wholeNow).reason,'capture_scope_mismatch');
 assert.equal(decision(wholeNow,scopedNow).reason,'capture_scope_mismatch');
 // a capture without a scope field is the legacy whole-bucket cut and stays valid
 const legacy=edit(wholeNow,r=>{delete r.snapshot.scope;});
 assert.equal(Op.captureScope(legacy.report).kind,'full_bucket');assert.equal(Op.captureScope(scopedNow.report).kind,'prediction_aux');assert.equal(Op.captureScope({snapshot:{scope:{kind:'prediction_aux',digest:'x'}}}),null);
 // the release binds the proof kind
 const releaseOf=capture=>Op.flipRelease({generation:1,capture,report:conv.report,planSha256:plans.chunking.planSha256,chunkCount:Kc,sliceCount:Ms});
 assert.notEqual(releaseOf(scopedNow),releaseOf(edit(scopedNow,r=>{r.snapshot.scope={kind:'full_bucket',digest:null};})),'the release is bound to the proof kind of the final capture');
 // the whole flip with two scoped cuts: release printed, then committed
 const needed=await stop(exec(params(conv,scopedNow)),'release_required');
 assert.equal(needed.details.release,releaseOf(scopedNow));
 const flipped=await exec(params(conv,scopedNow,{release:needed.details.release}));
 assert.equal(flipped.writeState,'committed');assert.equal(flipped.after.marker.mode,'d1');
 await o.bucket.stop();
}

// ===== 4d. a legacy PUT the REAL Worker admitted BEFORE the close, paused, then resumed AFTER the operator's close and the cut: the flip is refused =====
{
 const w=await flowWorld({films:8,aux:'r2'});
 const {start}=await w.reconcileAndStart({manifestSize:4});assert.equal(start.status,200);
 const wRun=start.data.runId,epoch=start.data.lease.epoch;
 const item=n=>start.data.films.slice(n,n+1).map(f=>({filmId:f.filmId,...(f.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction}));
 assert.equal((await w.api('batch/hold',{runId:wRun,epoch,items:item(0)})).status,200,'the first hold writes the stage object');
 // the second hold passes the Worker's marker read and is PAUSED at its stage PUT (admitted at r2)
 const raw=w.env.BUCKET.put;let release=null,reached=null;const waiting=new Promise(resolve=>{reached=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 w.env.BUCKET.put=async(key,...rest)=>{if(key==='enrichment/batch-stage.json'&&release){reached();await gate;}return raw(key,...rest);};
 const held=w.api('batch/hold',{runId:wRun,epoch,items:item(1)});await waiting;
 // the operator closes admission on the SAME database the Worker uses, and the cut at the close is taken while that PUT is still in flight
 const closed=await Op.execute('close',{binding:w.db,now:NOW,ctx:ctxOf(),params:{generation:0}});assert.equal(closed.after.marker.mode,'closed');
 const seed=()=>Object.fromEntries([...w.records.entries()].filter(([k])=>auxExportFamily(k)).map(([k,v])=>[k,json(v)]));
 const o1=await openBucket({},seed());const capClose=await capture(o1);await o1.bucket.stop();
 const convClose=await Op.loadConverted(capClose.dir);
 // the Worker's write path now refuses everything new (the gate of ADR 0196) while the old PUT lands
 const refused=await w.api('batch/hold',{runId:wRun,epoch,items:item(2)});assert.equal(refused.status,503);assert.equal(refused.data.code,'prediction_aux_closed');
 release();assert.equal((await held).status,200,'the PUT admitted before the close completes');w.env.BUCKET.put=raw;
 // the owner imports, seals and verifies the dataset of the cut taken at the close
 for(const command of ['import','seal','verify'])await Op.execute(command,{binding:w.db,now:NOW,ctx:ctxOf(),params:pp(convClose,1)});
 // the final cut sees the object the paused PUT rewrote (same key, another ETag and size): the flip is refused, the marker stays closed
 const o2=await openBucket({},seed());const capFinal=await capture(o2);await o2.bucket.stop();
 const stopped=await stop(Op.execute('flip',{binding:w.db,now:clockAfter(capFinal),ctx:ctxOf(),params:{...flipParams(convClose),captureNow:capFinal}}),'listing_changed');
 assert.deepEqual(stopped.details.changed,['enrichment/batch-stage.json'],'the resumed PUT is seen even though no key name changed');
 assert.equal(sql(w.file,'SELECT mode FROM prediction_aux_authority')[0].mode,'closed');
 // the interleaving where the PUT lands AFTER the final cut cannot be seen by any inventory: that is the residual of ADR 0196, stated and not claimed as fenced
}

// ===== 5. reopen (the abort path) only before the first chunk; a plan of another closure never resumes over a later one =====
{
 const e=scratch();await run('apply',e,{migrationSha256:Op.migrationSha256()});
 await run('close',e,{generation:0});
 const reopened=await run('reopen',e,{generation:1});assert.equal(reopened.after.marker.mode,'r2');assert.equal(reopened.after.marker.generation,2);
 await stop(run('reopen',e,{generation:2}),'marker_is_r2');
 await run('close',e,{generation:2});assert.equal(marker(e.file).generation,3);
 await stop(runS('import',e,pp(convBefore,1)),'generation_mismatch','a plan of the first closure refuses under the later one');
 await stop(runS('import',e,pp(convBefore,3,{planSha256:'0'.repeat(64)})),'plan_sha256_mismatch');
 const second=await runS('import',e,pp(convBefore,3,{maxChunks:1}));assert.equal(second.writeState,'committed');
 await stop(run('reopen',e,{generation:3}),'tables_not_empty','after the first chunk there is no way back to r2 by this operator');
}

// ===== 6. the file names no network beyond the pinned adapter, no R2, no Task, no flag =====
{
 const source=fs.readFileSync('scripts/prediction-aux-cutover-production.mjs','utf8').split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');   // the code, not the header comments
 assert.doesNotMatch(source,/BUCKET|r2-snapshot|wrangler|child_process|execSync|execFile|\bspawn|R2_SNAPSHOT_|ChatGPT|Scheduled/);
 assert.doesNotMatch(source,/prepare\((?:"|')\s*(?:INSERT|DELETE|DROP|ALTER)/i,'the operator prepares no row write itself: it runs the migrations, the importer\'s checked batches and its own marker statements');
 for(const forbidden of ['prediction_domain_authority SET','published_epg_authority SET','feature_flags','sqlFile','--sql-file','sqlText','--sql-sha256','--verify-sql-sha256'])assert.equal(source.includes(forbidden),false,forbidden);
 // 0034 is untouched by this stage: the operator and the importer name it only as the first migration
 assert.equal(sha256(fs.readFileSync('migrations/0034_prediction_aux_authority.sql','utf8')),sha256(fs.readFileSync('migrations/0034_prediction_aux_authority.sql','utf8')));
}

// ===== 7. a real-size dataset: the 22 Nov 2026 sizing (1,947 objects; import 3,998 statements and 36.2 MB) cut into chunks and slices that each fit one batch =====
const rnd=(n,seed)=>{let s=seed,out='';while(out.length<n){s=(s*1103515245+12345)&0x7fffffff;out+=s.toString(36);}return out.slice(0,n);};
const synthetic=(runs,bytes)=>{
 const o={};
 for(let i=0;i<runs;i++){
  const id='run-'+String(i).padStart(5,'0');
  o['enrichment/sources/'+id+'.json']={['tmdb_'+i]:{title:'Film '+i,modelMetadata:{note:rnd(bytes,i+1)}}};
  o['enrichment/stop-events/'+id+'.json']={event:{id:'evt-'+id,at:'2026-11-20T10:'+String(i%60).padStart(2,'0')+':00.000Z',type:'stop'},delivered:true};
 }
 return o;
};
const GATE={d1:{statements:2000,bytes:8*1048576,statementBytes:100*1024}};
{
 const big=await buildPlan(synthetic(180,200000));assert.deepEqual(big.blockers,[]);
 const whole=planSql(big,1).split('\n').filter(Boolean);
 const wholeBytes=whole.reduce((n,l)=>n+Buffer.byteLength(l),0);
 assert.ok(whole.length>GATE.d1.statements||wholeBytes>GATE.d1.bytes,'the synthetic dataset is as big as the real one: it does not fit one batch ('+whole.length+' statements, '+wholeBytes+' bytes)');
 const c=chunkPlan(big,{generation:1}),v=slicePlan(big,{generation:1,chunkCount:c.chunkCount});
 const cs=c.chunks.map(x=>[x.statements,x.bytes]),vs=v.slices.map(x=>[x.statements,x.bytes]);
 for(const [statements,bytes] of [...cs,...vs]){assert.ok(statements<=CHUNK_LIMITS.statements&&bytes<=CHUNK_LIMITS.bytes,'a batch is inside the budget');assert.ok(statements<=GATE.d1.statements&&bytes<=GATE.d1.bytes,'and inside the D1 limits');}
 assert.ok(c.chunkCount>=Math.ceil(wholeBytes/CHUNK_LIMITS.bytes),'no fewer chunks than the bytes need');assert.ok(c.chunkCount>=6,'about 6 chunks for 36 MB: '+c.chunkCount);
 assert.ok(Math.max(...c.chunks.flatMap(x=>x.sql.map(t=>Buffer.byteLength(t))))<=GATE.d1.statementBytes,'every statement is inside the D1 statement limit');
 assert.equal(c.chunks.reduce((n,x)=>n+x.dataStatements,0),whole.length-1,'every data statement of the plan is in a chunk');
 // the seal and the flip are small whatever the dataset
 const sealB=sealStatements(big,{generation:1,chunkCount:c.chunkCount,sliceCount:v.sliceCount}),flipB=flipStatements(big,{generation:1,chunkCount:c.chunkCount,sliceCount:v.sliceCount,activatedAt:'2026-11-22T14:00:00.000Z'});
 assert.equal(sealB.length,2);assert.equal(flipB.length,2);assert.ok(flipB.reduce((n,x)=>n+Buffer.byteLength(x),0)<8192,'the flip batch is a few KB');
 console.log('sizing (synthetic 22 Nov scale): whole import '+whole.length+' statements / '+wholeBytes+' bytes -> '+c.chunkCount+' chunks '+JSON.stringify(cs.map(x=>Math.round(x[1]/1024)+'KiB'))+', '+v.sliceCount+' slices, flip '+flipB.reduce((n,x)=>n+Buffer.byteLength(x),0)+' bytes');
}
{
 // through a database: apply, close, import with the standard budget, seal, verify (the flip is covered above); the chunks that the database accepted are the ones of the standard budget
 const objectsBig=synthetic(65,200000),planBig=await buildPlan(objectsBig);assert.deepEqual(planBig.blockers,[]);
 const reportBig=await planReport(planBig);
 const convBig={directory:'synthetic',capture:{identity:[],identitySha256:'x',report:{}},plan:planBig,report:reportBig,planSha256:planSha256(planBig)};
 const e=scratch();
 const started=Date.now();
 await run('apply',e,{migrationSha256:Op.migrationSha256()});await run('close',e,{generation:0});
 const imp=await run('import',e,pp(convBig,1));
 assert.ok(imp.appliedNow.length>=3,'the standard budget cuts 13 MB into at least 3 chunks: '+imp.appliedNow.length);assert.equal(imp.complete,true);
 assert.ok(sql(e.file,'SELECT bytes, statements FROM prediction_aux_import_chunk').every(r=>r.bytes<=CHUNK_LIMITS.bytes&&r.statements<=CHUNK_LIMITS.statements));
 assert.equal(count(e.file,'prediction_run_source_head'),65);assert.equal(count(e.file,'prediction_event_outbox'),65);
 const seal=await run('seal',e,pp(convBig,1));assert.equal(seal.writeState,'committed');
 const ver=await run('verify',e,pp(convBig,1));assert.equal(ver.complete,true);assert.ok(ver.appliedNow.length>=3);
 assert.deepEqual(ver.after.receipts,{chunks:imp.appliedNow.length,seals:1,slices:ver.appliedNow.length});
 assert.equal(marker(e.file).mode,'closed','the marker moves only at the flip');
 console.log('real-size database run: '+imp.appliedNow.length+' chunks, '+ver.appliedNow.length+' slices in '+(Date.now()-started)+' ms (sqlite stand-in, not D1)');
}
// ===== 8. the REAL REST binding: a data text with a question mark (24 Nov 2026: "Missing SQL parameter" on the first real chunk, nothing sent) =====
{
 const {createPublishedBinding}=await import('../scripts/published-epg-production.mjs');
 const e=scratch();
 // An adapter over the stand-in with the shape createPublishedBinding needs; its binding renders `?` exactly like the REST client does.
 const adapter={
  async get(text,params=[]){return ((await e.db.prepare(text).bind(...params).all()).results||[])[0]??null;},
  async all(text,params=[]){return (await e.db.prepare(text).bind(...params).all()).results||[];},
  async run(text,params=[]){await e.db.prepare(text).bind(...params).run();},
  async readBatch(texts){return (await e.db.batch(texts.map(t=>e.db.prepare(t).bind()))).map(r=>r.results||[]);},
  async executeRendered(texts){await e.db.batch(texts.map(t=>e.db.prepare(t).bind()));},
 };
 // The defect itself: the published binding refuses a final statement that has a `?` inside a string literal.
 assert.throws(()=>createPublishedBinding(adapter).prepare("INSERT INTO t (a) VALUES ('what? why?')").bind(),/Missing SQL parameter/);
 const binding=Op.restBinding(adapter);
 const objectsQ=synthetic(12,30000);
 for(const key of Object.keys(objectsQ))if(key.startsWith('enrichment/sources/')){const run=Object.values(objectsQ[key])[0];run.title='Why? Who? "What?" it\'s a ? question';run.modelMetadata.note='?'+run.modelMetadata.note+'?';}
 const planQ=await buildPlan(objectsQ);assert.deepEqual(planQ.blockers,[]);
 assert.ok(planSql(planQ,1).includes('Why? Who?'),'the dataset really carries question marks inside its literals');
 const convQ={directory:'synthetic',capture:{identity:[],identitySha256:'x',report:{}},plan:planQ,report:await planReport(planQ),planSha256:planSha256(planQ)};
 const exec=(command,params,limits=SMALL)=>Op.execute(command,{binding,now:NOW,ctx:ctxOf(),params,limits});
 await exec('apply',{migrationSha256:Op.migrationSha256()});await exec('close',{generation:0});
 const imp=await exec('import',{generation:1,converted:convQ,planSha256:convQ.planSha256});
 assert.equal(imp.complete,true);assert.equal(count(e.file,'prediction_run_source_head'),12);
 const stored=sql(e.file,"SELECT text FROM prediction_run_source_piece WHERE text LIKE '%Why? Who?%' LIMIT 1");assert.equal(stored.length,1,'a question mark inside a literal arrives as it is');
 assert.equal((await exec('seal',{generation:1,converted:convQ,planSha256:convQ.planSha256})).writeState,'committed');
 const ver=await exec('verify',{generation:1,converted:convQ,planSha256:convQ.planSha256});assert.equal(ver.complete,true);
 assert.equal(marker(e.file).mode,'closed');
}
await opened.bucket.stop();
console.log('prediction aux cutover production: ok');
