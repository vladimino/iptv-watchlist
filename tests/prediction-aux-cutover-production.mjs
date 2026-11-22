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
import {buildPlan,planReport,planSql,planVerifySql,auxExportFamily} from '../scripts/prediction-aux-d1-import.mjs';
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
// listing identities the cutover compares (what the converter writes as identity.json)
const identity=Object.keys(objects).sort().map((key,index)=>({key,etag:'etag-'+index,size:JSON.stringify(objects[key]).length}));
const sqlFor=generation=>planSql(plan,generation);

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
{
 // close: pinned to the generation the marker holds
 await stop(run('close',env,{generation:3}),'generation_mismatch');
 await stop(run('import',env,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))}),'marker_is_r2');
 await stop(run('flip',env,{generation:0,report,listingBefore:identity,listingNow:identity}),'marker_is_r2');
 await stop(run('verify',env,{generation:0,sqlText:verifyText,sqlSha256:sha256(verifyText)}),'marker_is_r2');
 const closed=await run('close',env,{generation:0});
 assert.equal(closed.after.marker.mode,'closed');assert.equal(closed.importGeneration,1);assert.deepEqual(marker(env.file),{mode:'closed',generation:1,at:null});
 await stop(run('close',env,{generation:0}),'marker_is_closed');
 await stop(run('close',env,{generation:1}),'marker_is_closed');
 // the closed marker reaches the Worker's own readers as `closed` (the gate of ADR 0196)
 const Aux=await import('../src/prediction-aux-d1.js');
 assert.equal((await Aux.readAuxAuthority(env.db,{PREDICTION_DB_REQUIRED:'on'})).mode,'closed');
 // import: the SQL pin, the generation pin, only the aux tables, the measured batch limits
 await stop(run('import',env,{generation:1,sqlText:sqlFor(1),sqlSha256:'0'.repeat(64)}),'sql_sha256_mismatch');
 await stop(run('import',env,{generation:2,sqlText:sqlFor(2),sqlSha256:sha256(sqlFor(2))}),'generation_mismatch');
 await stop(run('import',env,{generation:1,sqlText:sqlFor(7),sqlSha256:sha256(sqlFor(7))}),'sql_generation_mismatch');
 const alien=sqlFor(1)+"DELETE FROM film;\n";
 await stop(run('import',env,{generation:1,sqlText:alien,sqlSha256:sha256(alien)}),'sql_refused');
 const big=await stop(run('import',env,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))},{limits:{statements:5}}),'import_too_large');
 assert.equal(big.details.maxStatements,5);assert.ok(big.details.statements>5);assert.match(big.details.note,/no chunking/);
 assert.equal(count(env.file,'prediction_batch_stage'),0,'nothing was sent after a refusal');
 const imported=await run('import',env,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))});
 assert.equal(imported.writeState,'committed');assert.equal(imported.after.counts.stage,report.stage.items);assert.equal(imported.after.counts.sources,report.sources.runs);assert.equal(imported.after.counts.manifests,report.manifests.count);assert.equal(imported.after.counts.outbox,report.outbox.total);
 await stop(run('import',env,{generation:1,sqlText:sqlFor(1),sqlSha256:sha256(sqlFor(1))}),'tables_not_empty');
 await stop(run('reopen',env,{generation:1}),'tables_not_empty');
 await stop(run('close',env,{generation:1}),'marker_is_closed');
 // verify: exact rows; passes on the clean import, fails (statement) on a changed row, never retried
 const verified=await run('verify',env,{generation:1,sqlText:verifyText,sqlSha256:sha256(verifyText)});assert.equal(verified.writeState,'committed');
 await stop(run('verify',env,{generation:1,sqlText:verifyText,sqlSha256:'0'.repeat(64)}),'sql_sha256_mismatch');
 // flip: counts, listing identity, release
 const listing={generation:1,report,listingBefore:identity,listingNow:identity};
 await stop(run('flip',env,{...listing,generation:2}),'generation_mismatch');
 await stop(run('flip',env,{...listing,report:{...report,manifests:{...report.manifests,count:report.manifests.count+1}}}),'counts_differ');
 await stop(run('flip',env,{...listing,report:{...report,outbox:{...report.outbox,byState:{...report.outbox.byState,pending:(report.outbox.byState.pending||0)+1}}}}),'outbox_states_differ');
 await stop(run('flip',env,{...listing,report:{stage:{}}}),'report_invalid');
 // a late write: the same keys, an object rewritten (ETag changed, size the same) -> the flip is refused
 const rewritten=identity.map((item,index)=>index===0?{...item,etag:'etag-late'}:item);
 const changed=await stop(run('flip',env,{...listing,listingNow:rewritten}),'listing_changed');assert.deepEqual(changed.details.changed,[identity[0].key]);
 await stop(run('flip',env,{...listing,listingNow:identity.slice(1)}),'listing_changed');
 await stop(run('flip',env,{...listing,listingNow:[...identity,{key:'enrichment/sources/new.json',etag:'e',size:1}]}),'listing_changed');
 await stop(run('flip',env,{...listing,listingNow:[{key:'k'}]}),'listing_invalid');
 // without the release the flip prints the exact release and writes nothing; a wrong release is refused
 const needed=await stop(run('flip',env,listing),'release_required');
 const release=needed.details.release;assert.match(release,/^[0-9a-f]{16}$/);assert.equal(release,Op.flipRelease({generation:1,listingNow:identity,report}));
 await stop(run('flip',env,{...listing,release:'0'.repeat(16)}),'release_mismatch');
 assert.notEqual(Op.flipRelease({generation:1,listingNow:rewritten,report}),release,'the release binds the listing identity');
 assert.notEqual(Op.flipRelease({generation:2,listingNow:identity,report}),release,'and the generation');
 assert.deepEqual(marker(env.file),{mode:'closed',generation:1,at:null},'every refusal left the marker closed');
 // the flip itself: one guarded batch, irreversible
 const flipped=await run('flip',env,{...listing,release});
 assert.equal(flipped.writeState,'committed');assert.equal(flipped.irreversible,true);assert.equal(flipped.after.marker.mode,'d1');assert.equal(flipped.after.marker.generation,2);assert.equal(flipped.after.marker.activatedAt,'2026-11-22T14:00:00.000Z');
 assert.equal(marker(env.file).mode,'d1');
 assert.equal((await Aux.readAuxAuthority(env.db,{PREDICTION_DB_REQUIRED:'on'})).mode,'d1');
 // after d1 nothing moves back: every command is refused, and the schema itself refuses the marker
 for(const [command,params] of [['close',{generation:2}],['import',{generation:2,sqlText:sqlFor(2),sqlSha256:sha256(sqlFor(2))}],['reopen',{generation:2}],['flip',{...listing,generation:2,release}]])await stop(run(command,env,params),'marker_is_d1');
 assert.throws(()=>sql(env.file,"UPDATE prediction_aux_authority SET mode='r2', generation=9, activated_at=NULL"),/prediction_aux_authority/);
 assert.equal(otherModes(),modesBefore,'no other domain changed its mode or cutover');
 assert.equal(sql(env.file,'SELECT version FROM schema_contract')[0].version,34);
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
 assert.doesNotMatch(source,/BUCKET|r2-snapshot|wrangler|child_process|\bexec\(|execSync|spawn|R2_SNAPSHOT_|ChatGPT|Scheduled/);
 assert.doesNotMatch(source,/INSERT INTO|DELETE FROM|DROP /,'the operator writes no row itself: it runs the migration, the importer\'s SQL and its own marker statements');
 for(const forbidden of ['prediction_domain_authority SET','published_epg_authority SET','feature_flags'])assert.equal(source.includes(forbidden),false,forbidden);
}
console.log('prediction aux cutover production: ok');
