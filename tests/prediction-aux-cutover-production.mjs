// The owner-only cutover operator of the Predictions auxiliary state (scripts/prediction-aux-cutover-production.mjs): status, apply 0034, close, import, verify, flip, reopen.
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
import {buildPlan,planReport,planSql,planVerifySql,auxExportFamily,importGuardStatement} from '../scripts/prediction-aux-d1-import.mjs';
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
const plan=await buildPlan(objects);assert.deepEqual(plan.blockers,[]);
const report=await planReport(plan);
const verifyText=planVerifySql(plan);

// A scratch production stand-in at schema 33: the aux tables do not exist yet, the prediction domain is d1.
function scratch(){
 const file=migrated(33);
 sql(file,"UPDATE prediction_domain_authority SET mode='d1' WHERE id=1");
 return {file,db:d1Standin(file)};
}
const sqlFor=generation=>planSql(plan,generation);
const importGuard=generation=>importGuardStatement(generation)+';\n';
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
// The verification the operator DERIVES from a converted tree (the only verification it will run): its pin is the owner's confirmation of what `status` printed.
const pinOf=conv=>sha256(conv.verifyText);
const flipParams=(conv,release,extra={})=>({generation:1,captureBefore:conv,verifySha256:pinOf(conv),release,source:SOURCE,...extra});

// ===== 1. arguments =====
{
 const A=(...a)=>['node','x',...a];
 assert.deepEqual(Op.parseArgs(A()).report,{configured:false,writes:false,writeState:'none'});
 for(const command of ['apply','close','import','verify','flip','reopen'])assert.throws(()=>Op.parseArgs(A('--'+command)),e=>e.reason==='target_required',command);
 assert.throws(()=>Op.parseArgs(A('--close','--target','other','--confirm','close','--generation','0')),e=>e.reason==='target_invalid');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--generation','0')),e=>e.reason==='confirm');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','apply','--generation','0')),e=>e.reason==='confirm');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','close')),e=>e.reason==='usage','--generation is required');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','close','--generation','-1')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','close','--generation','1.5')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--apply','--target','iptv','--confirm','apply')),e=>e.reason==='usage','the migration pin is required');
 assert.throws(()=>Op.parseArgs(A('--apply','--target','iptv','--confirm','apply','--migration-sha256','abc')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--import','--target','iptv','--confirm','import','--generation','1','--converted','x')),e=>e.reason==='usage','the SQL pin is required');
 assert.throws(()=>Op.parseArgs(A('--status','--apply','--target','iptv','--confirm','apply')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','close','--generation','0','--release','x')),e=>e.reason==='usage','an option the command does not take');
 assert.throws(()=>Op.parseArgs(A('--target','iptv','--confirm','status')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--wipe','--target','iptv')),e=>e.reason==='usage','no other command exists');
 // The SQL and the report are DERIVED from the converted tree: no option can carry a file of SQL or a report any more (review of PR 897)
 for(const option of ['--sql-file','--verify-sql-file','--report','--listing-before','--listing-now'])assert.throws(()=>Op.parseArgs(A('--import','--target','iptv','--confirm','import','--generation','1','--converted','x','--sql-sha256','0'.repeat(64),option,'f')),e=>e.reason==='usage',option+' is not an input');
 for(const option of ['--sql-file','--verify-sql-file','--report'])assert.throws(()=>Op.parseArgs(A('--flip','--target','iptv','--confirm','flip','--generation','1','--capture-before','a','--capture-now','b','--verify-sql-sha256','0'.repeat(64),option,'f')),e=>e.reason==='usage',option+' is not an input of the flip');
 assert.throws(()=>Op.parseArgs(A('--flip','--target','iptv','--confirm','flip','--generation','1','--capture-before','a','--capture-now','b')),e=>e.reason==='usage','the verification pin is required by the flip');
 const flipArgs=A('--flip','--target','iptv','--confirm','flip','--generation','1','--capture-before','a','--capture-now','b','--verify-sql-sha256','0'.repeat(64));
 assert.equal(Op.parseArgs(flipArgs).command,'flip');assert.equal(Op.parseArgs([...flipArgs,'--release','abc']).params.release,'abc');
 const ok=Op.parseArgs(A('--close','--target','iptv','--confirm','close','--generation','0'));assert.equal(ok.command,'close');assert.equal(ok.params.generation,0);
 assert.equal(Op.parseArgs(A('--target','iptv')).command,'status');
 const cli=spawnSync(process.execPath,['scripts/prediction-aux-cutover-production.mjs'],{encoding:'utf8'});assert.equal(cli.status,0);
 assert.deepEqual(JSON.parse(cli.stdout),{configured:false,writes:false,writeState:'none'});
 const refused=await Op.runPredictionAuxCutoverProduction({argv:A('--close','--target','iptv','--confirm','close','--generation','0'),env:{}});
 assert.ok([2,3].includes(refused.exit),'without the production target in the environment nothing is attempted');assert.equal(refused.result.writeState,'none');
}

// ===== 2. status is read-only, prints the pins of what the operator will derive, and says what each step would do =====
const opened=await openBucket();
const capBefore=await capture(opened);                 // the cut taken at the close
const convBefore=await Op.loadConverted(capBefore.dir);
{
 const env=scratch();const before=fs.readFileSync(env.file);
 const status=await run('status',env);
 assert.equal(status.writes,false);assert.equal(status.writeState,'none');assert.equal(status.schemaVersion,33);assert.equal(status.tables,'0/13');
 assert.equal(status.decisions.apply,'apply');assert.equal(status.decisions.close,undefined,'nothing to close before 0034');
 assert.match(status.migrationSha256,/^[0-9a-f]{64}$/);assert.equal(status.migrationSha256,Op.migrationSha256());
 assert.ok(fs.readFileSync(env.file).equals(before),'status changed no byte of the database');
 assert.equal(states.length,0,'no write was tracked');
 // the dataset the operator derives from the converted tree: the SAME plan the importer builds from the original objects
 assert.equal(convBefore.verifyText,planVerifySql(plan),'the verification is the importer\'s canonical one for this dataset');
 assert.equal(sqlFor(1),planSql(plan,1));assert.deepEqual(convBefore.report.stage.items,report.stage.items);assert.equal(JSON.stringify(convBefore.report),JSON.stringify(report));
 assert.ok(convBefore.verifyText.split("\n").filter(Boolean).length>6,'row-level comparisons, not only totals');
 assert.match(convBefore.verifyText,/item_json=/);assert.match(convBefore.verifyText,/AND text=/);assert.match(convBefore.verifyText,/event_id=/);
 const printed=await run('status',env,{converted:convBefore,generation:1});
 assert.equal(printed.converted.verifySha256,sha256(planVerifySql(plan)));assert.equal(printed.converted.import.sha256,sha256(planSql(plan,1)));assert.equal(printed.converted.import.fits,true);assert.ok(printed.converted.import.statements>=10);
 assert.equal(printed.converted.identitySha256,capBefore.identitySha256);assert.equal(printed.converted.report.manifests.count,report.manifests.count);
 const tooBig=await Op.execute('status',{binding:env.db,now:NOW,ctx:ctxOf(),params:{converted:convBefore,generation:1},limits:{statements:5}});
 assert.equal(tooBig.converted.import.fits,false,'the measured batch limits are reported');assert.equal(tooBig.converted.import.maxStatements,5);
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
 assert.equal((await Op.loadConverted(decoy)).verifyText,convBefore.verifyText);
 await stop(Op.loadConverted(path.join(tmp(),'nothing')),'file_unreadable');
}

// ===== 3. apply: pinned, atomic, read back; a stale or partial state is refused =====
{
 const env=scratch();
 await stop(run('apply',env,{migrationSha256:'0'.repeat(64)}),'migration_sha256_mismatch');
 assert.equal(count(env.file,'schema_contract'),1);assert.equal(sql(env.file,'SELECT version FROM schema_contract')[0].version,33,'a refused apply changed nothing');
 const other=scratch();sql(other.file,"UPDATE prediction_domain_authority SET mode='r2' WHERE id=1");
 await stop(run('apply',other,{migrationSha256:Op.migrationSha256()}),'prediction_domain_not_d1');
 const res=await run('apply',env,{migrationSha256:Op.migrationSha256()});
 assert.equal(res.writeState,'committed');assert.equal(res.after.schemaVersion,34);assert.deepEqual(res.after.marker,{mode:'r2',generation:0,activatedAt:null});assert.equal(res.after.tables,'13/13');
 assert.deepEqual(res.after.counts,{stage:0,sources:0,revisions:0,manifests:0,pieces:0,outbox:0});
 assert.deepEqual(marker(env.file),{mode:'r2',generation:0,at:null});
 assert.ok(states.includes('committed'));
 await stop(run('apply',env,{migrationSha256:Op.migrationSha256()}),'already_applied');
 // partial schema (a table of the file without the rest) is refused, whatever the version says
 const partial=scratch();sql(partial.file,'CREATE TABLE prediction_aux_cas (id INTEGER PRIMARY KEY, ok INTEGER)');
 await stop(run('apply',partial,{migrationSha256:Op.migrationSha256()}),'partial_schema');
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

// ===== 4. the whole sequence on one scratch database: apply, close, import, verify, flip; the aux domain only =====
const env=scratch();
const otherModes=()=>JSON.stringify(sql(env.file,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%\\_authority' ESCAPE '\\' AND name<>'prediction_aux_authority' ORDER BY name").map(row=>[row.name,sql(env.file,'SELECT mode FROM '+row.name+' LIMIT 1')[0]?.mode]));
const modesBefore=otherModes();
await run('apply',env,{migrationSha256:Op.migrationSha256()});
const importParams=(generation=1,extra={})=>({generation,converted:convBefore,sqlSha256:sha256(planSql(plan,generation)),...extra});
const verifyParams=(generation=1,extra={})=>({generation,converted:convBefore,sqlSha256:pinOf(convBefore),...extra});
let release;
{
 // close: pinned to the generation the marker holds
 await stop(run('close',env,{generation:3}),'generation_mismatch');
 await stop(run('import',env,importParams()),'marker_is_r2');
 await stop(run('flip',env,{...flipParams(convBefore),generation:0,captureNow:capBefore}),'marker_is_r2');
 await stop(run('verify',env,verifyParams(0)),'marker_is_r2');
 const closed=await run('close',env,{generation:0});
 assert.equal(closed.after.marker.mode,'closed');assert.equal(closed.importGeneration,1);assert.deepEqual(marker(env.file),{mode:'closed',generation:1,at:null});
 await stop(run('close',env,{generation:0}),'marker_is_closed');
 await stop(run('close',env,{generation:1}),'marker_is_closed');
 // the closed marker reaches the Worker's own readers as `closed` (the gate of ADR 0196)
 const Aux=await import('../src/prediction-aux-d1.js');
 assert.equal((await Aux.readAuxAuthority(env.db,{PREDICTION_DB_REQUIRED:'on'})).mode,'closed');
 // import: the SQL is derived from the tree; the pin must be the hash of exactly that SQL for exactly that closure
 await stop(run('import',env,importParams(1,{sqlSha256:'0'.repeat(64)})),'sql_sha256_mismatch');
 await stop(run('import',env,importParams(2)),'generation_mismatch');
 await stop(run('import',env,importParams(1,{sqlSha256:sha256(planSql(plan,7))})),'sql_sha256_mismatch');   // another closure's SQL has another hash
 const big=await stop(run('import',env,importParams(),{limits:{statements:5}}),'import_too_large');
 assert.equal(big.details.maxStatements,5);assert.ok(big.details.statements>5);assert.match(big.details.note,/no chunking/);
 assert.equal(count(env.file,'prediction_batch_stage'),0,'nothing was sent after a refusal');
 const imported=await run('import',env,importParams());
 assert.equal(imported.writeState,'committed');assert.equal(imported.after.counts.stage,report.stage.items);assert.equal(imported.after.counts.sources,report.sources.runs);assert.equal(imported.after.counts.manifests,report.manifests.count);assert.equal(imported.after.counts.outbox,report.outbox.total);
 await stop(run('import',env,importParams()),'tables_not_empty');
 await stop(run('reopen',env,{generation:1}),'tables_not_empty');
 await stop(run('close',env,{generation:1}),'marker_is_closed');
 const verified=await run('verify',env,verifyParams());assert.equal(verified.writeState,'committed');
 await stop(run('verify',env,verifyParams(1,{sqlSha256:'0'.repeat(64)})),'sql_sha256_mismatch');

 // ---- the decisions, one reason at a time (the state is the real one after the import) ----
 const capNow=await capture(opened);              // a fresh cut just before the flip: nothing changed in the bucket
 const at=clockAfter(capNow);
 const state=await Op.readState(env.db,at);
 const checked=Op.checkedSql(convBefore.verifyText,{kind:'verify',pin:pinOf(convBefore)});
 const d=(extra={})=>Op.flipDecision(state,{generation:1,report,before:capBefore,now:capNow,verify:checked,clock:at,source:SOURCE,...extra});
 assert.equal(d({generation:2}).reason,'generation_mismatch');
 assert.equal(d({report:{...report,manifests:{...report.manifests,count:report.manifests.count+1}}}).reason,'counts_differ');
 assert.equal(d({report:{...report,outbox:{...report.outbox,byState:{...report.outbox.byState,pending:(report.outbox.byState.pending||0)+1}}}}).reason,'outbox_states_differ');
 assert.equal(d({report:{stage:{}}}).reason,'report_invalid');
 assert.equal(d({verify:null}).reason,'verify_required');
 const other=await buildPlan(Object.fromEntries(Object.entries(objects).filter(([key])=>!key.includes('batch-stage'))));
 assert.equal(d({verify:Op.checkedSql(planVerifySql(other),{kind:'verify',pin:sha256(planVerifySql(other))})}).reason,'verify_not_for_report');
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
 const flipRun=(params,extra={})=>Op.execute('flip',{binding:env.db,now:at,ctx:ctxOf(),params,...extra});
 await stop(flipRun({...base,generation:2}),'generation_mismatch');
 await stop(flipRun({...base,verifySha256:'0'.repeat(64)}),'sql_sha256_mismatch');
 await stop(flipRun({...base,captureBefore:undefined}),'converted_required');
 await stop(flipRun({...base,captureNow:convBefore.capture}),'captures_not_distinct');
 await stop(Op.execute('flip',{binding:env.db,now:at+3600000,ctx:ctxOf(),params:base}),'capture_not_fresh');
 // a late write for real: a legacy PUT lands in the bucket after the close (the same key, other bytes, the same length); the next fresh cut sees another ETag and the flip is refused
 const key=Object.keys(legacyBytes).find(k=>k.startsWith('enrichment/stop-events/')),text=legacyBytes[key];
 const flippedText=text.replace(/"at":"(\d{4})/,(m,y)=>'"at":"'+(Number(y)===2026?'2025':'2026'));assert.equal(flippedText.length,text.length);assert.notEqual(flippedText,text);
 await opened.bucket.put(key,flippedText);
 const capLate=await capture(opened);
 const late=await stop(Op.execute('flip',{binding:env.db,now:clockAfter(capLate),ctx:ctxOf(),params:{...base,captureNow:capLate}}),'listing_changed');
 assert.deepEqual(late.details.changed,[key],'the landing is seen by ETag even though the key set and the size are unchanged');
 await opened.bucket.put(key,text);                // the object is back to what was exported (a new ETag): the cut taken at the close is stale now
 const capBack=await capture(opened);
 await stop(Op.execute('flip',{binding:env.db,now:clockAfter(capBack),ctx:ctxOf(),params:{...base,captureNow:capBack}}),'listing_changed');
 // the owner re-takes the cut at the close and the final one: two clean captures of the same bytes that were imported
 const capClose=await capture(opened),capFinal=await capture(opened);
 const convClose=await Op.loadConverted(capClose.dir);
 assert.equal(convClose.verifyText,convBefore.verifyText,'the same dataset derives the same verification');
 const clean={...flipParams(convClose),captureNow:capFinal};
 const atFinal=clockAfter(capFinal);
 // without the release the flip prints the exact release and writes nothing; a wrong release is refused
 const needed=await stop(Op.execute('flip',{binding:env.db,now:atFinal,ctx:ctxOf(),params:clean}),'release_required');
 release=needed.details.release;assert.match(release,/^[0-9a-f]{16}$/);assert.equal(release,Op.flipRelease({generation:1,capture:capFinal,report,verifySha256:pinOf(convClose)}));
 await stop(Op.execute('flip',{binding:env.db,now:atFinal,ctx:ctxOf(),params:{...clean,release:'0'.repeat(16)}}),'release_mismatch');
 assert.notEqual(Op.flipRelease({generation:1,capture:capLate,report,verifySha256:pinOf(convClose)}),release,'the release binds the final capture');
 assert.notEqual(Op.flipRelease({generation:2,capture:capFinal,report,verifySha256:pinOf(convClose)}),release,'and the generation');
 assert.notEqual(Op.flipRelease({generation:1,capture:capFinal,report,verifySha256:sha256('other')}),release,'and the verification SQL');
 assert.deepEqual(marker(env.file),{mode:'closed',generation:1,at:null},'every refusal left the marker closed');
 // the flip itself: the verification and the marker update in ONE guarded batch, irreversible
 const flipped=await Op.execute('flip',{binding:env.db,now:atFinal,ctx:ctxOf(),params:{...clean,release}});
 assert.equal(flipped.writeState,'committed');assert.equal(flipped.irreversible,true);assert.equal(flipped.after.marker.mode,'d1');assert.equal(flipped.after.marker.generation,2);assert.equal(flipped.after.marker.activatedAt,new Date(atFinal).toISOString());
 assert.equal(flipped.verifiedInBatch.sha256,pinOf(convClose));assert.ok(flipped.verifiedInBatch.statements>10);
 assert.equal(marker(env.file).mode,'d1');
 assert.equal((await Aux.readAuxAuthority(env.db,{PREDICTION_DB_REQUIRED:'on'})).mode,'d1');
 // after d1 nothing moves back: every command is refused, and the schema itself refuses the marker
 for(const [command,params] of [['close',{generation:2}],['import',importParams(2)],['reopen',{generation:2}]])await stop(run(command,env,params),'marker_is_d1');
 await stop(Op.execute('flip',{binding:env.db,now:atFinal,ctx:ctxOf(),params:{...clean,generation:2,release}}),'marker_is_d1');
 assert.throws(()=>sql(env.file,"UPDATE prediction_aux_authority SET mode='r2', generation=9, activated_at=NULL"),/prediction_aux_authority/);
 assert.equal(otherModes(),modesBefore,'no other domain changed its mode or cutover');
 assert.equal(sql(env.file,'SELECT version FROM schema_contract')[0].version,34);
}

// ===== 4b. the SQL a file may carry: the importer's exact shapes, never the marker (review of PR 897, P1); and the operator derives its SQL, it never reads any =====
{
 const e=scratch();await run('apply',e,{migrationSha256:Op.migrationSha256()});await run('close',e,{generation:0});
 const bytes=()=>fs.readFileSync(e.file);const before=bytes();
 const importGuard=generation=>importGuardStatement(generation)+';\n';
 const activate="UPDATE prediction_aux_authority SET mode='d1', generation=2, activated_at='2026-11-22T14:00:00.000Z' WHERE id=1;\n";
 const refuse=(kind,text,reason='sql_refused')=>{try{Op.checkedSql(text,{kind,generation:1,pin:sha256(text)});}catch(error){assert.equal(error.reason,reason,JSON.stringify(text.slice(0,60)));return;}assert.fail('expected '+reason);};
 refuse('verify',activate);refuse('verify',convBefore.verifyText+activate);refuse('verify',activate+convBefore.verifyText);
 refuse('import',sqlFor(1)+activate);refuse('import',importGuard(1)+activate);
 refuse('import',importGuard(1)+"INSERT INTO prediction_aux_authority (id, mode, generation, activated_at) VALUES (2, 'd1', 3, '2026-11-22T14:00:00.000Z');\n");
 refuse('import',sqlFor(1)+"UPDATE prediction_aux_cas SET ok=1 WHERE id=1;\n");refuse('import',sqlFor(1)+"DELETE FROM prediction_event_outbox;\n");refuse('import',sqlFor(1)+"DROP TRIGGER prediction_aux_authority_chain;\n");
 refuse('import',sqlFor(1)+"INSERT INTO prediction_event_outbox_counter (kind, active_pending) VALUES ('x', 1);\n");refuse('import',sqlFor(1)+"INSERT INTO prediction_batch_stage (film_id) SELECT film_id FROM film;\n");
 refuse('verify',convBefore.verifyText+"UPDATE prediction_aux_cas SET ok=1 WHERE id=1;\n");refuse('verify',convBefore.verifyText+"UPDATE prediction_aux_cas SET ok=(SELECT count(*)=0 FROM prediction_aux_authority) WHERE id=1;\n");
 refuse('import','','sql_empty');refuse('verify','   \n','sql_empty');refuse('import','DROP TABLE film;','sql_refused');refuse('import',importGuard(2)+'','sql_generation_mismatch');
 // a literal that merely CONTAINS the words is data, not a statement
 const sneaky=await buildPlan({...objects,'enrichment/sources/sneaky-run.json':{title:"'; UPDATE prediction_aux_authority SET mode='d1'; --",note:"prediction_aux_authority"}});
 const checkedSneaky=Op.checkedSql(planSql(sneaky,1),{kind:'import',generation:1,pin:sha256(planSql(sneaky,1))});assert.ok(checkedSneaky.sizing.fits,'a document that names the marker is still data');
 // defence in depth: even a hand-built converted object cannot make the operator run SQL of its own. The operator re-derives the SQL from the plan and ignores any text carried next to it.
 const evil={...convBefore,importText:()=>activate,verifyText:activate};
 const imported=await run('import',e,importParams(1,{converted:evil}));assert.equal(imported.writeState,'committed','the derived SQL ran, not the text carried next to it');
 assert.deepEqual(marker(e.file),{mode:'closed',generation:1,at:null},'the marker did not move');
 assert.equal(imported.sqlSha256,sha256(planSql(plan,1)));
 void before;void bytes;
}

// ===== 4c. the flip needs the verification INSIDE its batch: same-count corruption, a forged totals-only text, an empty database and a fabricated report cannot flip =====
{
 const setup=async()=>{
  const e=scratch();await run('apply',e,{migrationSha256:Op.migrationSha256()});await run('close',e,{generation:0});
  const o=await openBucket();const before=await capture(o);const conv=await Op.loadConverted(before.dir);
  return {e,o,before,conv};
 };
 const proven=e=>({prepare:s=>e.db.prepare(s),async batch(statements){try{await e.db.batch(statements);}catch(error){throw new D1Error('statement',String(error.message));}}});
 const flipOf=async(s,{binding,before,params={}}={})=>{
  const now=await capture(s.o);const at=clockAfter(now);
  const base={...flipParams(before??s.conv),captureNow:now,...params};
  const needed=await stop(Op.execute('flip',{binding:s.e.db,now:at,ctx:ctxOf(),params:base}),'release_required');
  const full={...base,release:needed.details.release};
  return {at,full,run:()=>Op.execute('flip',{binding:binding??s.e.db,now:at,ctx:ctxOf(),params:full})};
 };
 // (1) a corrupted piece with every count and state unchanged: the verification aborts the batch, the marker stays closed
 {
  const s=await setup();const {e}=s;
  await run('import',e,{generation:1,converted:s.conv,sqlSha256:sha256(planSql(plan,1))});
  const totals=()=>JSON.stringify([count(e.file,'prediction_run_source_piece'),count(e.file,'prediction_run_manifest_piece'),count(e.file,'prediction_event_outbox')]);const t0=totals();
  sql(e.file,'DROP TRIGGER prediction_run_source_piece_no_update');
  sql(e.file,"UPDATE prediction_run_source_piece SET text=substr(text,1,5)||CASE substr(text,6,1) WHEN 'x' THEN 'y' ELSE 'x' END||substr(text,7) WHERE rowid=(SELECT min(rowid) FROM prediction_run_source_piece)");
  assert.equal(totals(),t0,'same counts, same states');
  const f=await flipOf(s,{binding:proven(e)});
  states.length=0;
  const failed=await stop(f.run(),'statement_failed');
  assert.equal(failed.details.state.marker.mode,'closed');assert.deepEqual(marker(e.file),{mode:'closed',generation:1,at:null},'a corrupted byte aborted the flip before the marker moved');assert.equal(states.at(-1),'none');
  // the review's forgery: a short totals-only "verification" carried next to the tree, with its own hash, is simply not what the operator runs
  const totalsOnly=Object.entries({prediction_batch_stage:report.stage.items,prediction_run_source_head:report.sources.runs,prediction_run_source_revision:report.sources.revisions,prediction_run_manifest:report.manifests.count,prediction_run_manifest_piece:report.manifests.pieces,prediction_event_outbox:report.outbox.total}).map(([table,n])=>'UPDATE prediction_aux_cas SET ok=(SELECT count(*)='+n+' FROM '+table+') WHERE id=1;').join('\n')+'\n';
  assert.ok(Op.checkedSql(totalsOnly,{kind:'verify',pin:sha256(totalsOnly)}),'such a file is well-formed (that is why it must never be accepted from a caller)');
  const forged={...s.conv,verifyText:totalsOnly};
  {const now=await capture(s.o);await stop(Op.execute('flip',{binding:e.db,now:clockAfter(now),ctx:ctxOf(),params:{...flipParams(forged),verifySha256:sha256(totalsOnly),captureNow:now}}),'sql_sha256_mismatch','the pin of the forged text is not the pin of the derived verification');}
  await s.o.bucket.stop();
 }
 // (2) a corrupted outbox event with the same counts and states
 {
  const s=await setup();const {e}=s;
  await run('import',e,{generation:1,converted:s.conv,sqlSha256:sha256(planSql(plan,1))});
  sql(e.file,'DROP TRIGGER prediction_event_outbox_settled_terminal');sql(e.file,'DROP TRIGGER prediction_event_outbox_identity');
  sql(e.file,"UPDATE prediction_event_outbox SET event_json=replace(event_json,'\"id\":\"','\"id\":\"z') WHERE rowid=(SELECT min(rowid) FROM prediction_event_outbox)");
  const f=await flipOf(s,{binding:proven(e)});
  await stop(f.run(),'statement_failed');assert.equal(marker(e.file).mode,'closed');
  await s.o.bucket.stop();
 }
 // (3) no import at all, and a fabricated empty report: neither flips
 {
  const s=await setup();const {e}=s;
  const early=await capture(s.o);
  await stop(Op.execute('flip',{binding:e.db,now:clockAfter(early),ctx:ctxOf(),params:{...flipParams(s.conv),captureNow:early}}),'counts_differ');   // an empty database does not match the dataset's report
  const emptyPlan=await buildPlan({});
  const fabricated={...s.conv,plan:emptyPlan,verifyText:planVerifySql(emptyPlan),report:await planReport(emptyPlan)};          // an honest empty plan (zero counts, its own empty verification) presented with the captures of a non-empty export
  await stop(Op.execute('flip',{binding:e.db,now:clockAfter(early),ctx:ctxOf(),params:{...flipParams(fabricated),captureNow:early}}),'report_not_from_export');
  assert.equal(marker(e.file).mode,'closed');
  await s.o.bucket.stop();
 }
}

// ===== 4e. scoped captures (`--scope prediction-aux`, review of PR 912): the whole sequence with scoped cuts, an unrelated writer that no longer matters, and the refusals of a mixed or unsupported proof =====
{
 const e=scratch();await run('apply',e,{migrationSha256:Op.migrationSha256()});await run('close',e,{generation:0});
 const o=await openBucket({'epg/published-generation.json':json({programmeRunId:'p-1'}),'sync.json':json({updatedAt:'t'}),'monitor/state.json':json({tick:1})});
 const scopedBefore=await capture(o,{scope:'prediction-aux'});
 assert.equal(scopedBefore.report.snapshot.scope.kind,'prediction_aux');
 const conv=await Op.loadConverted(scopedBefore.dir);
 assert.equal(conv.verifyText,convBefore.verifyText,'the scoped tree is the same auxiliary dataset as the whole-bucket one');
 await run('import',e,{generation:1,converted:conv,sqlSha256:sha256(planSql(conv.plan,1))});await run('verify',e,{generation:1,converted:conv,sqlSha256:pinOf(conv)});
 // unrelated writers change the bucket between the two cuts: a scoped cut is independent of them, and the flip compares only the auxiliary identity
 await o.bucket.put('epg/published-generation.json',json({programmeRunId:'p-2'}));await o.bucket.put('sync.json',json({updatedAt:'t2'}));await o.bucket.put('monitor/state.json',json({tick:2}));await o.bucket.put('letterboxd/diary/state.json',json({n:9}));
 const scopedNow=await capture(o,{scope:'prediction-aux'});
 const wholeNow=await capture(o);                       // a whole-bucket cut of the same moment (the legacy proof)
 assert.equal(wholeNow.report.snapshot.scope.kind,'full_bucket');
 const at=clockAfter(scopedNow);
 const params=(before,nowCapture,extra={})=>({...flipParams(conv),captureBefore:before,captureNow:nowCapture,...extra});
 const exec=(p,time=at)=>Op.execute('flip',{binding:e.db,now:time,ctx:ctxOf(),params:p});
 // a scoped capture next to a whole-bucket one is two different proofs: refused, whichever way round
 await stop(exec(params(conv,wholeNow)),'capture_scope_mismatch');
 // an unsupported or edited proof is refused: the digest must be exactly the current definition of the scope it names
 const edit=(capture,mutate)=>{const copy={...capture,report:structuredClone(capture.report)};mutate(copy.report);return copy;};
 const decision=(before,nowCap)=>Op.flipDecision(state0,{generation:1,report:conv.report,before,now:nowCap,verify:checkedVerify,clock:at,source:SOURCE});
 const state0=await Op.readState(e.db,at);
 const checkedVerify=Op.checkedSql(conv.verifyText,{kind:'verify',pin:pinOf(conv)});
 assert.equal(decision(edit(scopedBefore,r=>{r.snapshot.scope.digest='0'.repeat(64);}),scopedNow).reason,'capture_scope_unsupported');
 assert.equal(decision(scopedBefore,edit(scopedNow,r=>{r.snapshot.scope={kind:'everything',digest:null};})).reason,'capture_scope_unsupported');
 assert.equal(decision(scopedBefore,wholeNow).reason,'capture_scope_mismatch');
 assert.equal(decision(wholeNow,scopedNow).reason,'capture_scope_mismatch');
 // a capture without a scope field is the legacy whole-bucket cut and stays valid
 const legacy=edit(wholeNow,r=>{delete r.snapshot.scope;});
 assert.equal(Op.captureScope(legacy.report).kind,'full_bucket');assert.equal(Op.captureScope(scopedNow.report).kind,'prediction_aux');assert.equal(Op.captureScope({snapshot:{scope:{kind:'prediction_aux',digest:'x'}}}),null);
 // the release binds the proof kind
 const releaseScoped=Op.flipRelease({generation:1,capture:scopedNow,report:conv.report,verifySha256:pinOf(conv)});
 const releaseWhole=Op.flipRelease({generation:1,capture:edit(scopedNow,r=>{r.snapshot.scope={kind:'full_bucket',digest:null};}),report:conv.report,verifySha256:pinOf(conv)});
 assert.notEqual(releaseScoped,releaseWhole,'the release is bound to the proof kind of the final capture');
 // the whole flip with two scoped cuts: release printed, then committed
 const needed=await stop(exec(params(conv,scopedNow)),'release_required');
 assert.equal(needed.details.release,releaseScoped);
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
 // the owner imports and verifies the dataset of the cut taken at the close
 await Op.execute('import',{binding:w.db,now:NOW,ctx:ctxOf(),params:{generation:1,converted:convClose,sqlSha256:sha256(planSql(convClose.plan,1))}});
 await Op.execute('verify',{binding:w.db,now:NOW,ctx:ctxOf(),params:{generation:1,converted:convClose,sqlSha256:pinOf(convClose)}});
 // the final cut sees the object the paused PUT rewrote (same key, another ETag and size): the flip is refused, the marker stays closed
 const o2=await openBucket({},seed());const capFinal=await capture(o2);await o2.bucket.stop();
 const stopped=await stop(Op.execute('flip',{binding:w.db,now:clockAfter(capFinal),ctx:ctxOf(),params:{...flipParams(convClose),captureNow:capFinal}}),'listing_changed');
 assert.deepEqual(stopped.details.changed,['enrichment/batch-stage.json'],'the resumed PUT is seen even though no key name changed');
 assert.equal(sql(w.file,'SELECT mode FROM prediction_aux_authority')[0].mode,'closed');
 // the interleaving where the PUT lands AFTER the final cut cannot be seen by any inventory: that is the residual of ADR 0196, stated and not claimed as fenced
}

// ===== 5. reopen (the abort path) only before an import; a changed row fails verify =====
{
 const e=scratch();await run('apply',e,{migrationSha256:Op.migrationSha256()});
 await run('close',e,{generation:0});
 const reopened=await run('reopen',e,{generation:1});assert.equal(reopened.after.marker.mode,'r2');assert.equal(reopened.after.marker.generation,2);
 await stop(run('reopen',e,{generation:2}),'marker_is_r2');
 await run('close',e,{generation:2});assert.equal(marker(e.file).generation,3);
 await stop(run('import',e,{generation:1,converted:convBefore,sqlSha256:sha256(planSql(plan,1))}),'generation_mismatch','a plan of the first closure refuses under the later one');
 await stop(run('import',e,{generation:3,converted:convBefore,sqlSha256:sha256(planSql(plan,1))}),'sql_sha256_mismatch');
 const second=await run('import',e,{generation:3,converted:convBefore,sqlSha256:sha256(planSql(plan,3))});assert.equal(second.writeState,'committed');
 // a changed imported row: verify fails as a proven statement error (statement_failed) and nothing is retried
 sql(e.file,'DROP TRIGGER prediction_event_outbox_settled_terminal');sql(e.file,'DROP TRIGGER prediction_event_outbox_identity');
 sql(e.file,"UPDATE prediction_event_outbox SET attempts=attempts+3 WHERE rowid=(SELECT min(rowid) FROM prediction_event_outbox)");
 const proven={prepare:s=>e.db.prepare(s),async batch(statements){try{await e.db.batch(statements);}catch(error){throw new D1Error('statement',String(error.message));}}};
 states.length=0;
 const failed=await stop(Op.execute('verify',{binding:proven,now:NOW,ctx:ctxOf(),params:{generation:3,converted:convBefore,sqlSha256:pinOf(convBefore)}}),'statement_failed');
 assert.equal(failed.details.state.marker.mode,'closed');assert.equal(states.at(-1),'none');
}

// ===== 6. the file names no network beyond the pinned adapter, no R2, no Task, no flag =====
{
 const source=fs.readFileSync('scripts/prediction-aux-cutover-production.mjs','utf8').split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');   // the code, not the header comments
 assert.doesNotMatch(source,/BUCKET|r2-snapshot|wrangler|child_process|execSync|execFile|\bspawn|R2_SNAPSHOT_|ChatGPT|Scheduled/);
 assert.doesNotMatch(source,/prepare\((?:"|')\s*(?:INSERT|DELETE|DROP|ALTER)/i,'the operator prepares no row write itself: it runs the migration, the importer\'s checked SQL and its own marker statements');
 for(const forbidden of ['prediction_domain_authority SET','published_epg_authority SET','feature_flags','sqlFile','--sql-file','sqlText'])assert.equal(source.includes(forbidden),false,forbidden);
}
await opened.bucket.stop();
console.log('prediction aux cutover production: ok');
