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
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'aux-op-'));
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
async function openBucket(extra={}){
 const bucket=fakeBucket({...fenceObjects(),...legacyBytes,...extra},{pageSize:4});
 const endpoint=await bucket.start();
 return {bucket,credentials:readCredentials(envFor(endpoint))};
}
async function capture(opened){
 const snapshot=tmp(),output=path.join(tmp(),'capture');
 await exportProductionSnapshot({directory:snapshot,credentials:opened.credentials,sleep:async()=>{}});
 await convertSnapshot({snapshot,output});
 await new Promise(resolve=>setTimeout(resolve,5));   // two cuts are two distinct moments
 return {dir:output,...Op.readCapture(output)};
}
const clockAfter=cap=>Date.parse(cap.report.snapshot.finishedAt)+60000;
const flipParams=(release,extra={})=>({generation:1,report,verifyText,verifySha256:sha256(verifyText),release,source:SOURCE,...extra});

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
 assert.throws(()=>Op.parseArgs(A('--import','--target','iptv','--confirm','import','--generation','1','--sql-file','x')),e=>e.reason==='usage','the SQL pin is required');
 assert.throws(()=>Op.parseArgs(A('--status','--apply','--target','iptv','--confirm','apply')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--close','--target','iptv','--confirm','close','--generation','0','--release','x')),e=>e.reason==='usage','an option the command does not take');
 assert.throws(()=>Op.parseArgs(A('--flip','--target','iptv','--confirm','flip','--generation','1','--report','r','--capture-before','a','--capture-now','b')),e=>e.reason==='usage','the verification SQL and its pin are required by the flip');
 assert.throws(()=>Op.parseArgs(A('--flip','--target','iptv','--confirm','flip','--generation','1','--report','r','--listing-before','a','--listing-now','b','--verify-sql-file','v','--verify-sql-sha256','0'.repeat(64))),e=>e.reason==='usage','loose listing files are not an input any more');
 const flipArgs=A('--flip','--target','iptv','--confirm','flip','--generation','1','--report','r','--capture-before','a','--capture-now','b','--verify-sql-file','v','--verify-sql-sha256','0'.repeat(64));
 assert.equal(Op.parseArgs(flipArgs).command,'flip');assert.equal(Op.parseArgs([...flipArgs,'--release','abc']).params.release,'abc');
 assert.throws(()=>Op.parseArgs(A('--target','iptv','--confirm','status')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--wipe','--target','iptv')),e=>e.reason==='usage','no other command exists');
 const ok=Op.parseArgs(A('--close','--target','iptv','--confirm','close','--generation','0'));assert.equal(ok.command,'close');assert.equal(ok.params.generation,0);
 assert.equal(Op.parseArgs(A('--target','iptv')).command,'status');
 const cli=spawnSync(process.execPath,['scripts/prediction-aux-cutover-production.mjs'],{encoding:'utf8'});assert.equal(cli.status,0);
 assert.deepEqual(JSON.parse(cli.stdout),{configured:false,writes:false,writeState:'none'});
 const refused=await Op.runPredictionAuxCutoverProduction({argv:A('--close','--target','iptv','--confirm','close','--generation','0'),env:{}});
 assert.ok([2,3].includes(refused.exit),'without the production target in the environment nothing is attempted');assert.equal(refused.result.writeState,'none');
}

// ===== 2. status is read-only and says what each step would do =====
{
 const env=scratch();const before=fs.readFileSync(env.file);
 const status=await run('status',env);
 assert.equal(status.writes,false);assert.equal(status.writeState,'none');assert.equal(status.schemaVersion,33);assert.equal(status.tables,'0/13');
 assert.equal(status.decisions.apply,'apply');assert.equal(status.decisions.close,undefined,'nothing to close before 0034');
 assert.match(status.migrationSha256,/^[0-9a-f]{64}$/);assert.equal(status.migrationSha256,Op.migrationSha256());
 assert.ok(fs.readFileSync(env.file).equals(before),'status changed no byte of the database');
 assert.equal(states.length,0,'no write was tracked');
 // the sizing of an import file is reported without sending anything
 const sized=await run('status',env,{sqlText:sqlFor(1),generation:1});
 assert.equal(sized.importFile.fits,true);assert.ok(sized.importFile.statements>=10);assert.equal(sized.importFile.sha256,sha256(sqlFor(1)));
 const tooBig=await Op.execute('status',{binding:env.db,now:NOW,ctx:ctxOf(),params:{sqlText:sqlFor(1),generation:1},limits:{statements:5}});
 assert.equal(tooBig.importFile.fits,false,'the measured batch limits are reported');assert.equal(tooBig.importFile.maxStatements,5);
 assert.equal((await run('status',env,{sqlText:'DROP TABLE film;',generation:1})).importFile.refused,'sql_refused');
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
const opened=await openBucket();
const capBefore=await capture(opened);          // the cut taken at the close
let release;
{
 // close: pinned to the generation the marker holds
 await stop(run('close',env,{generation:3}),'generation_mismatch');
 await stop(run('import',env,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))}),'marker_is_r2');
 await stop(run('flip',env,{...flipParams(),generation:0,captureBefore:capBefore,captureNow:capBefore}),'marker_is_r2');
 await stop(run('verify',env,{generation:0,sqlText:verifyText,sqlSha256:sha256(verifyText)}),'marker_is_r2');
 const closed=await run('close',env,{generation:0});
 assert.equal(closed.after.marker.mode,'closed');assert.equal(closed.importGeneration,1);assert.deepEqual(marker(env.file),{mode:'closed',generation:1,at:null});
 await stop(run('close',env,{generation:0}),'marker_is_closed');
 await stop(run('close',env,{generation:1}),'marker_is_closed');
 // the closed marker reaches the Worker's own readers as `closed` (the gate of ADR 0196)
 const Aux=await import('../src/prediction-aux-d1.js');
 assert.equal((await Aux.readAuxAuthority(env.db,{PREDICTION_DB_REQUIRED:'on'})).mode,'closed');
 // import: the SQL pin, the generation pin, only the importer's exact shapes, the measured batch limits
 await stop(run('import',env,{generation:1,sqlText:sqlFor(1),sqlSha256:'0'.repeat(64)}),'sql_sha256_mismatch');
 await stop(run('import',env,{generation:2,sqlText:sqlFor(2),sqlSha256:sha256(sqlFor(2))}),'generation_mismatch');
 await stop(run('import',env,{generation:1,sqlText:sqlFor(7),sqlSha256:sha256(sqlFor(7))}),'sql_generation_mismatch');
 const big=await stop(run('import',env,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))},{limits:{statements:5}}),'import_too_large');
 assert.equal(big.details.maxStatements,5);assert.ok(big.details.statements>5);assert.match(big.details.note,/no chunking/);
 assert.equal(count(env.file,'prediction_batch_stage'),0,'nothing was sent after a refusal');
 const imported=await run('import',env,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))});
 assert.equal(imported.writeState,'committed');assert.equal(imported.after.counts.stage,report.stage.items);assert.equal(imported.after.counts.sources,report.sources.runs);assert.equal(imported.after.counts.manifests,report.manifests.count);assert.equal(imported.after.counts.outbox,report.outbox.total);
 await stop(run('import',env,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))}),'tables_not_empty');
 await stop(run('reopen',env,{generation:1}),'tables_not_empty');
 await stop(run('close',env,{generation:1}),'marker_is_closed');
 const verified=await run('verify',env,{generation:1,sqlText:verifyText,sqlSha256:sha256(verifyText)});assert.equal(verified.writeState,'committed');
 await stop(run('verify',env,{generation:1,sqlText:verifyText,sqlSha256:'0'.repeat(64)}),'sql_sha256_mismatch');

 // ---- flip ----
 const capNow=await capture(opened);              // a fresh cut just before the flip: nothing changed in the bucket
 const base={...flipParams(undefined),captureBefore:capBefore,captureNow:capNow};
 const at=clockAfter(capNow);
 const flipRun=(params,extra={})=>Op.execute('flip',{binding:env.db,now:at,ctx:ctxOf(),params:params,...extra});
 await stop(flipRun({...base,generation:2}),'generation_mismatch');
 await stop(flipRun({...base,report:{...report,manifests:{...report.manifests,count:report.manifests.count+1}}}),'counts_differ');
 await stop(flipRun({...base,report:{...report,outbox:{...report.outbox,byState:{...report.outbox.byState,pending:(report.outbox.byState.pending||0)+1}}}}),'outbox_states_differ');
 await stop(flipRun({...base,report:{stage:{}}}),'report_invalid');
 // the verification travels inside the flip: it cannot be skipped, it must be the verification of THIS report, and its hash is a checksum only
 await stop(flipRun({...base,verifyText:undefined,verifySha256:undefined}),'verify_required');
 const other=await buildPlan(Object.fromEntries(Object.entries(objects).filter(([key])=>!key.includes('batch-stage'))));
 const otherVerify=planVerifySql(other);
 await stop(flipRun({...base,verifyText:otherVerify,verifySha256:sha256(otherVerify)}),'verify_not_for_report');
 await stop(flipRun({...base,verifySha256:'0'.repeat(64)}),'sql_sha256_mismatch');
 // the evidence is two real, distinct, fresh, consistent cuts of the expected source
 await stop(flipRun({...base,captureNow:capBefore}),'captures_not_distinct');
 await stop(Op.execute('flip',{binding:env.db,now:at+3600000,ctx:ctxOf(),params:base}),'capture_not_fresh');
 await stop(flipRun({...base,source:{...SOURCE,bucket:'other'}}),'capture_source_mismatch');
 const inconsistent=structuredClone(capNow);inconsistent.report.snapshot.status='no_go';
 await stop(flipRun({...base,captureNow:inconsistent}),'capture_not_consistent');
 const tampered={...capNow,identityText:capNow.identityText.replace('"size":','"size":1'),identitySha256:sha256(capNow.identityText.replace('"size":','"size":1'))};
 await stop(flipRun({...base,captureNow:tampered}),'capture_identity_mismatch');
 await stop(flipRun({...base,captureNow:{identity:'x'}}),'capture_invalid');
 // a report that is not the report of the export the captures describe (counts equal to D1, different export): refused
 const foreign=await openBucket({'enrichment/sources/another-run.json':json({tmdb_1:{modelMetadata:{}}})});
 const capForeign=await capture(foreign);
 const foreignNow=await capture(foreign);
 await stop(flipRun({...base,captureBefore:capForeign,captureNow:foreignNow}),'report_not_from_export');
 await foreign.bucket.stop();
 // a fabricated zero-count report: the verification of the real dataset is not the verification of it
 const zero={...report,stage:{...report.stage,items:0},sources:{...report.sources,runs:0,revisions:0},manifests:{count:0,pieces:0,digest:report.manifests.digest},outbox:{...report.outbox,total:0,byState:{}}};
 await stop(flipRun({...base,report:zero}),'counts_differ');
 // a late write for real: a legacy PUT lands in the bucket after the close (the same key, other bytes, same length); the next fresh cut sees another ETag and the flip is refused
 const key=Object.keys(legacyBytes).find(k=>k.startsWith('enrichment/stop-events/')),text=legacyBytes[key];
 const flippedText=text.replace(/"at":"(\d{4})/,(m,y)=>'"at":"'+(Number(y)===2026?'2025':'2026'));assert.equal(flippedText.length,text.length);assert.notEqual(flippedText,text);
 await opened.bucket.put(key,flippedText);
 const capLate=await capture(opened);
 const late=await stop(Op.execute('flip',{binding:env.db,now:clockAfter(capLate),ctx:ctxOf(),params:{...base,captureNow:capLate}}),'listing_changed');
 assert.deepEqual(late.details.changed,[key],'the landing is seen by ETag even though the key set and the size are unchanged');
 await opened.bucket.put(key,text);                // the object is back to what was exported (a new ETag): the cut taken at the close is now stale
 const capBack=await capture(opened);
 await stop(Op.execute('flip',{binding:env.db,now:clockAfter(capBack),ctx:ctxOf(),params:{...base,captureNow:capBack}}),'listing_changed');
 // the owner re-takes the cut at the close and the final one: two clean captures
 const capClose=await capture(opened),capFinal=await capture(opened);
 const clean={...base,captureBefore:capClose,captureNow:capFinal};
 const atFinal=clockAfter(capFinal);
 // without the release the flip prints the exact release and writes nothing; a wrong release is refused
 const needed=await stop(Op.execute('flip',{binding:env.db,now:atFinal,ctx:ctxOf(),params:clean}),'release_required');
 release=needed.details.release;assert.match(release,/^[0-9a-f]{16}$/);assert.equal(release,Op.flipRelease({generation:1,capture:capFinal,report,verifySha256:sha256(verifyText)}));
 await stop(Op.execute('flip',{binding:env.db,now:atFinal,ctx:ctxOf(),params:{...clean,release:'0'.repeat(16)}}),'release_mismatch');
 assert.notEqual(Op.flipRelease({generation:1,capture:capLate,report,verifySha256:sha256(verifyText)}),release,'the release binds the final capture');
 assert.notEqual(Op.flipRelease({generation:2,capture:capFinal,report,verifySha256:sha256(verifyText)}),release,'and the generation');
 assert.notEqual(Op.flipRelease({generation:1,capture:capFinal,report,verifySha256:sha256(otherVerify)}),release,'and the verification SQL');
 assert.deepEqual(marker(env.file),{mode:'closed',generation:1,at:null},'every refusal left the marker closed');
 // the flip itself: the verification and the marker update in ONE guarded batch, irreversible
 const flipped=await Op.execute('flip',{binding:env.db,now:atFinal,ctx:ctxOf(),params:{...clean,release}});
 assert.equal(flipped.writeState,'committed');assert.equal(flipped.irreversible,true);assert.equal(flipped.after.marker.mode,'d1');assert.equal(flipped.after.marker.generation,2);assert.equal(flipped.after.marker.activatedAt,new Date(atFinal).toISOString());
 assert.equal(flipped.verifiedInBatch.sha256,sha256(verifyText));assert.ok(flipped.verifiedInBatch.statements>10);
 assert.equal(marker(env.file).mode,'d1');
 assert.equal((await Aux.readAuxAuthority(env.db,{PREDICTION_DB_REQUIRED:'on'})).mode,'d1');
 // after d1 nothing moves back: every command is refused, and the schema itself refuses the marker
 for(const [command,params] of [['close',{generation:2}],['import',{generation:2,sqlText:sqlFor(2),sqlSha256:sha256(sqlFor(2))}],['reopen',{generation:2}]])await stop(run(command,env,params),'marker_is_d1');
 await stop(Op.execute('flip',{binding:env.db,now:atFinal,ctx:ctxOf(),params:{...clean,generation:2,release}}),'marker_is_d1');
 assert.throws(()=>sql(env.file,"UPDATE prediction_aux_authority SET mode='r2', generation=9, activated_at=NULL"),/prediction_aux_authority/);
 assert.equal(otherModes(),modesBefore,'no other domain changed its mode or cutover');
 assert.equal(sql(env.file,'SELECT version FROM schema_contract')[0].version,34);
 await opened.bucket.stop();
}

// ===== 4b. the SQL a file may carry: the importer's exact shapes, never the marker (review of PR 897, P1) =====
{
 const e=scratch();await run('apply',e,{migrationSha256:Op.migrationSha256()});await run('close',e,{generation:0});
 const untouched=()=>fs.readFileSync(e.file);const before=untouched();
 const refuse=async(command,text,reason='sql_refused')=>{
  const params={generation:1,sqlText:text,sqlSha256:sha256(text)};
  await stop(run(command,e,params),reason);
  assert.ok(untouched().equals(before),command+': no byte of the database changed');assert.deepEqual(marker(e.file),{mode:'closed',generation:1,at:null});
 };
 const activate="UPDATE prediction_aux_authority SET mode='d1', generation=2, activated_at='2026-11-22T14:00:00.000Z' WHERE id=1;\n";
 await refuse('verify',activate);                                              // the bypass of the review: a verify file that activates
 await refuse('verify',verifyText+activate);
 await refuse('verify',activate+verifyText);
 await refuse('import',sqlFor(1)+activate);                                    // an import file that appends the activation after its own guard
 await refuse('import',importGuard(1)+activate);
 await refuse('import',importGuard(1)+"INSERT INTO prediction_aux_authority (id, mode, generation, activated_at) VALUES (2, 'd1', 3, '2026-11-22T14:00:00.000Z');\n");
 await refuse('import',sqlFor(1)+"UPDATE prediction_aux_cas SET ok=1 WHERE id=1;\n");
 await refuse('import',sqlFor(1)+"DELETE FROM prediction_event_outbox;\n");
 await refuse('import',sqlFor(1)+"DROP TRIGGER prediction_aux_authority_chain;\n");
 await refuse('import',sqlFor(1)+"INSERT INTO prediction_event_outbox_counter (kind, active_pending) VALUES ('x', 1);\n");
 await refuse('import',sqlFor(1)+"INSERT INTO prediction_batch_stage (film_id) SELECT film_id FROM film;\n");
 await refuse('verify',verifyText+"UPDATE prediction_aux_cas SET ok=1 WHERE id=1;\n");
 await refuse('verify',verifyText+"UPDATE prediction_aux_cas SET ok=(SELECT count(*)=0 FROM prediction_aux_authority) WHERE id=1;\n");
 await refuse('import','','sql_empty');                                         // empty
 await refuse('verify','   \n','sql_empty');
 // a literal that merely CONTAINS the words is data, not a statement: the importer's own file with such a document still passes the shape check
 const sneaky=await buildPlan({...objects,'enrichment/sources/sneaky-run.json':{title:"'; UPDATE prediction_aux_authority SET mode='d1'; --",note:"prediction_aux_authority"}});
 const sneakySql=planSql(sneaky,1);
 const ok=await Op.execute('status',{binding:e.db,now:NOW,ctx:ctxOf(),params:{sqlText:sneakySql,generation:1}});assert.equal(ok.importFile.fits,true,'a document that names the marker is still data');
 const imported=await run('import',e,{generation:1,sqlText:sneakySql,sqlSha256:sha256(sneakySql)});assert.equal(imported.writeState,'committed');assert.deepEqual(marker(e.file),{mode:'closed',generation:1,at:null},'the quoted text moved nothing');
 // the sizing report of status refuses the same inputs
 const sized=await Op.execute('status',{binding:e.db,now:NOW,ctx:ctxOf(),params:{sqlText:sqlFor(1)+activate,generation:1}});assert.equal(sized.importFile.refused,'sql_refused');
}

// ===== 4c. the flip needs the verification INSIDE its batch: same-count corruption, a skipped verification and an empty database cannot flip =====
{
 const setup=async()=>{
  const e=scratch();await run('apply',e,{migrationSha256:Op.migrationSha256()});await run('close',e,{generation:0});
  const o=await openBucket();const before=await capture(o);
  return {e,o,before};
 };
 const proven=e=>({prepare:s=>e.db.prepare(s),async batch(statements){try{await e.db.batch(statements);}catch(error){throw new D1Error('statement',String(error.message));}}});
 const flipOf=async(e,o,before,{binding,params={}}={})=>{
  const now=await capture(o);const at=clockAfter(now);
  const base={...flipParams(undefined),captureBefore:before,captureNow:now,...params};
  const needed=await stop(Op.execute('flip',{binding:e.db,now:at,ctx:ctxOf(),params:base}),'release_required');
  const full={...base,release:needed.details.release};
  return {at,full,run:()=>Op.execute('flip',{binding:binding??e.db,now:at,ctx:ctxOf(),params:full})};
 };
 // (1) a corrupted piece with every count and state unchanged: the verification aborts the batch, the marker stays closed
 {
  const {e,o,before}=await setup();
  await run('import',e,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))});
  const totals=JSON.stringify([count(e.file,'prediction_run_source_piece'),count(e.file,'prediction_run_manifest_piece'),count(e.file,'prediction_event_outbox')]);
  sql(e.file,'DROP TRIGGER prediction_run_source_piece_no_update');
  sql(e.file,"UPDATE prediction_run_source_piece SET text=substr(text,1,5)||CASE substr(text,6,1) WHEN 'x' THEN 'y' ELSE 'x' END||substr(text,7) WHERE rowid=(SELECT min(rowid) FROM prediction_run_source_piece)");
  assert.equal(JSON.stringify([count(e.file,'prediction_run_source_piece'),count(e.file,'prediction_run_manifest_piece'),count(e.file,'prediction_event_outbox')]),totals,'same counts, same states');
  const f=await flipOf(e,o,before,{binding:proven(e)});
  states.length=0;
  const failed=await stop(f.run(),'statement_failed');
  assert.equal(failed.details.state.marker.mode,'closed');assert.deepEqual(marker(e.file),{mode:'closed',generation:1,at:null},'a corrupted byte aborted the flip before the marker moved');assert.equal(states.at(-1),'none');
  await o.bucket.stop();
 }
 // (2) a corrupted outbox event with the same counts and states
 {
  const {e,o,before}=await setup();
  await run('import',e,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))});
  sql(e.file,'DROP TRIGGER prediction_event_outbox_settled_terminal');sql(e.file,'DROP TRIGGER prediction_event_outbox_identity');
  sql(e.file,"UPDATE prediction_event_outbox SET event_json=replace(event_json,'\"id\":\"','\"id\":\"z') WHERE rowid=(SELECT min(rowid) FROM prediction_event_outbox)");
  const f=await flipOf(e,o,before,{binding:proven(e)});
  await stop(f.run(),'statement_failed');assert.equal(marker(e.file).mode,'closed');
  await o.bucket.stop();
 }
 // (3) no import at all (an empty database) with the real report, verification and captures: the verification fails inside the batch
 {
  const {e,o,before}=await setup();
  const early=await capture(o);
  await stop(Op.execute('flip',{binding:e.db,now:clockAfter(early),ctx:ctxOf(),params:{...flipParams(undefined),captureBefore:before,captureNow:early}}),'counts_differ');   // the counts of an empty database do not match the report
  // a zero-count fabricated report with the real verification and captures
  const zero={...report,stage:{...report.stage,items:0},sources:{...report.sources,runs:0,revisions:0},manifests:{count:0,pieces:0,digest:report.manifests.digest},outbox:{...report.outbox,total:0,byState:{}}};
  const now=await capture(o);
  await stop(Op.execute('flip',{binding:e.db,now:clockAfter(now),ctx:ctxOf(),params:{...flipParams(undefined),captureBefore:before,captureNow:now,report:zero}}),'verify_not_for_report');
  // even the empty plan's own (honest) verification does not pass with captures of a non-empty export: the report is not the export's
  const emptyPlan=await buildPlan({});const emptyReport=await planReport(emptyPlan),emptyVerify=planVerifySql(emptyPlan);
  await stop(Op.execute('flip',{binding:e.db,now:clockAfter(now),ctx:ctxOf(),params:{...flipParams(undefined),report:emptyReport,verifyText:emptyVerify,verifySha256:sha256(emptyVerify),captureBefore:before,captureNow:now}}),'report_not_from_export');
  assert.equal(marker(e.file).mode,'closed');
  await o.bucket.stop();
 }
 // (4) the verification is part of the batch even when the rest is perfect: with a flip whose verification is skipped, nothing flips
 {
  const {e,o,before}=await setup();
  await run('import',e,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))});
  const now=await capture(o);
  await stop(Op.execute('flip',{binding:e.db,now:clockAfter(now),ctx:ctxOf(),params:{...flipParams(undefined),captureBefore:before,captureNow:now,verifyText:undefined,verifySha256:undefined,release:'0'.repeat(16)}}),'verify_required');
  assert.equal(marker(e.file).mode,'closed');
  await o.bucket.stop();
 }
}

// ===== 5. reopen (the abort path) only before an import; a changed row fails verify =====
{
 const e=scratch();await run('apply',e,{migrationSha256:Op.migrationSha256()});
 await run('close',e,{generation:0});
 const reopened=await run('reopen',e,{generation:1});assert.equal(reopened.after.marker.mode,'r2');assert.equal(reopened.after.marker.generation,2);
 await stop(run('reopen',e,{generation:2}),'marker_is_r2');
 await run('close',e,{generation:2});assert.equal(marker(e.file).generation,3);
 await stop(run('import',e,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))}),'generation_mismatch','a plan of the first closure refuses under the later one');
 const second=await run('import',e,{generation:3,sqlText:sqlFor(3),sqlSha256:sha256(sqlFor(3))});assert.equal(second.writeState,'committed');
 // a changed imported row: verify fails as a proven statement error (statement_failed) and nothing is retried
 sql(e.file,'DROP TRIGGER prediction_event_outbox_settled_terminal');sql(e.file,'DROP TRIGGER prediction_event_outbox_identity');
 sql(e.file,"UPDATE prediction_event_outbox SET attempts=attempts+3 WHERE rowid=(SELECT min(rowid) FROM prediction_event_outbox)");
 const proven={prepare:s=>e.db.prepare(s),async batch(statements){try{await e.db.batch(statements);}catch(error){throw new D1Error('statement',String(error.message));}}};
 states.length=0;
 const failed=await stop(Op.execute('verify',{binding:proven,now:NOW,ctx:ctxOf(),params:{generation:3,sqlText:verifyText,sqlSha256:sha256(verifyText)}}),'statement_failed');
 assert.equal(failed.details.state.marker.mode,'closed');assert.equal(states.at(-1),'none');
}

// ===== 6. the file names no network beyond the pinned adapter, no R2, no Task, no flag =====
{
 const source=fs.readFileSync('scripts/prediction-aux-cutover-production.mjs','utf8').split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');   // the code, not the header comments
 assert.doesNotMatch(source,/BUCKET|r2-snapshot|wrangler|child_process|execSync|execFile|\bspawn|R2_SNAPSHOT_|ChatGPT|Scheduled/);
 assert.doesNotMatch(source,/prepare\((?:"|')\s*(?:INSERT|DELETE|DROP|ALTER)/i,'the operator prepares no row write itself: it runs the migration, the importer\'s checked SQL and its own marker statements');
 for(const forbidden of ['prediction_domain_authority SET','published_epg_authority SET','feature_flags'])assert.equal(source.includes(forbidden),false,forbidden);
}
console.log('prediction aux cutover production: ok');
