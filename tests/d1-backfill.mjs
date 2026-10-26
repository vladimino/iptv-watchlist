import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {manifestFor} from '../scripts/migration-export.mjs';
import {loadDomainRules} from '../scripts/offline-import.mjs';
import {BackfillStop,D1Error,createD1Adapter,probeAtomicity,readTarget,renderSql,runBackfill,runStageCleanup,schemaTables,stageOwner,verifyTargetIdentity} from '../scripts/d1-backfill.mjs';

// The executor never touches R2, a Worker binding or the deploy configuration, and the Worker bundle does not include it.
const source=fs.readFileSync('scripts/d1-backfill.mjs','utf8');
assert.doesNotMatch(source,/\bBUCKET\b|wrangler|d1_databases|env\.DB\b|BEGIN|COMMIT/);
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/d1-backfill/);
assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/d1_databases/);

const rules=loadDomainRules();
const sha256=value=>createHash('sha256').update(value).digest('hex');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-backfill-'));
const migration=fs.readFileSync('migrations/0001_schema_v1.sql','utf8');
const ACCOUNT='0123456789abcdef0123456789abcdef',TOKEN='test-d1-token';
const TARGET='11111111-1111-4111-8111-111111111111',SCRATCH='22222222-2222-4222-8222-222222222222';
const at='2026-10-26T01:00:00.000Z',later='2026-10-26T05:00:00.000Z';

function sqlite(file,input,{json=false}={}){return spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input,encoding:'utf8'});}
function freshDatabase(name,{schema=true}={}){const file=path.join(root,name+'.sqlite');fs.rmSync(file,{force:true});if(schema){const result=sqlite(file,'PRAGMA foreign_keys=ON;\n'+migration);assert.equal(result.status,0,result.stderr);}else{const result=sqlite(file,'SELECT 1;');assert.equal(result.status,0,result.stderr);}return file;}
function count(file,sql){const result=sqlite(file,sql,{json:true});assert.equal(result.status,0,result.stderr);const rows=result.stdout.trim()?JSON.parse(result.stdout):[];return rows[0]?.n??0;}

// A fake Cloudflare D1 HTTP API over local SQLite files. atomic:true executes a multi-statement request inside one transaction
// (what the real service must be proven to do); atomic:false executes statement by statement and keeps earlier writes on failure.
function fakeD1(databases){
 const calls=[],hooks=[];
 const server=http.createServer((request,response)=>{
  const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',async()=>{
   const url=new URL(request.url,'http://127.0.0.1');
   const match=url.pathname.match(/^\/client\/v4\/accounts\/([0-9a-f]{32})\/d1\/database\/([0-9a-f-]{36})(\/query)?$/);
   const send=(status,body)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(body));};
   if(request.headers.authorization!=='Bearer '+TOKEN)return send(403,{success:false,errors:[{code:10000,message:'Authentication error'}]});
   if(!match||match[1]!==ACCOUNT||!databases[match[2]])return send(404,{success:false,errors:[{code:7404,message:'Database not found'}]});
   const database=databases[match[2]];
   if(request.method==='GET'&&!match[3])return send(200,{success:true,errors:[],messages:[],result:{uuid:database.uuid??match[2],name:database.name,version:'production'}});
   if(request.method!=='POST'||!match[3])return send(405,{success:false,errors:[{message:'Method not allowed'}]});
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const call={database:match[2],sql:body.sql,write:!/^\s*SELECT\b/i.test(body.sql)};calls.push(call);
   for(const hook of hooks){const result=await hook({...call,phase:'before'});if(typeof result==='number')return send(result,{success:false,errors:[{message:'Injected'}]});}
   const input='PRAGMA foreign_keys=ON;\n'+(database.atomic!==false&&call.write?'BEGIN;\n'+body.sql+'\nCOMMIT;\n':body.sql+'\n');
   const result=sqlite(database.file,input,{json:true});
   for(const hook of hooks){const after=await hook({...call,phase:'after',ok:result.status===0});if(after==='drop'){request.socket.destroy();return;}if(typeof after==='number')return send(after,{success:false,errors:[{message:'Injected after commit'}]});}
   if(result.status!==0)return send(400,{success:false,errors:[{code:7500,message:(result.stderr||'SQL error').trim().slice(0,300)}],result:[]});
   const text=result.stdout.trim();
   const rows=text?JSON.parse(text.split('\n').filter(Boolean).length&&text.startsWith('[')?text.replace(/\]\s*\[/g,','):'[]'):[];
   send(200,{success:true,errors:[],messages:[],result:[{results:rows,success:true,meta:{changes:0}}]});
  });
 });
 return {calls,hooks,server,async start(){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port+'/client/v4';},async stop(){await new Promise(resolve=>server.close(resolve));}};
}
const envFor=(endpoint,extra={})=>({D1_BACKFILL_ACCOUNT_ID:ACCOUNT,D1_BACKFILL_API_TOKEN:TOKEN,D1_BACKFILL_DATABASE_ID:TARGET,D1_BACKFILL_SCRATCH_DATABASE_ID:SCRATCH,D1_BACKFILL_ENDPOINT:endpoint,...extra});

// A production baseline snapshot in the exporter's manifest shape, with its consistency proof.
const heat={id:'heat-1995',title:'Heat',original:'Heat',tmdbId:7,year:1995};
const version=(()=>{const record={filmId:'heat-1995',tasteProfileVersion:1,tasteProfileHash:'profile-a',fingerprintHash:'print-heat',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4,generatedAt:at};const text=rules.predictionVersionText(record),sha=sha256(Buffer.from(text,'utf8'));return {record,text,pointer:{r2Key:rules.predictionVersionKey('heat-1995',sha),contentSha256:sha}};})();
const baseBodies=()=>({
 'watchlist.json':{films:[heat]},
 'programme.json':{runId:'run-1',films:[{...heat,shows:[{channelId:'c1',channel:'C1',start:1000,end:2000,title:'Heat'}]}]},
 'enrichment/profile/current.json':{version:1,profileHash:'profile-a',updatedAt:at},
 'enrichment/profile/versions/1.json':{version:1,profileHash:'profile-a',createdAt:at},
 'enrichment/films/heat-1995/fingerprint.json':{fingerprintSchemaVersion:1,fingerprintHash:'print-heat',generatedAt:at,invalidatedAt:null},
 'enrichment/films/heat-1995/actual.json':{rating:4,source:'letterboxd',updatedAt:at},
 'enrichment/films/heat-1995/predictions.json':{current:{...version.record,...version.pointer},history:[]},
 [version.pointer.r2Key]:Buffer.from(version.text,'utf8'),
});
function writeSnapshot(name,bodies,{production=true,status='consistent_fenced',finishedAt='2026-10-26T01:00:00.000Z'}={}){
 const directory=path.join(root,name);fs.rmSync(directory,{recursive:true,force:true});fs.mkdirSync(path.join(directory,'objects'),{recursive:true});
 const entries=Object.entries(bodies).map(([key,value])=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value),'utf8');const file=sha256(Buffer.from(key,'utf8'))+'.bin';fs.writeFileSync(path.join(directory,'objects',file),bytes);return {key,file:'objects/'+file,size:bytes.length,sha256:sha256(bytes),metadata:{key,size:bytes.length,etag:'etag-'+sha256(bytes).slice(0,8)}};});
 const manifest=manifestFor(entries,1,'2026-10-26T00:00:00.000Z',finishedAt,[]);
 if(production)Object.assign(manifest,{sourceSiteId:null,sourceOrigin:null,status,noGoReasons:status==='consistent_fenced'?[]:['fence_changed'],source:{kind:'cloudflare-r2-s3',bucket:'iptv',accountId:ACCOUNT,endpoint:'example.r2',endpointOverride:true,exporter:'scripts/r2-snapshot-export.mjs',readOnly:true},fence:{ok:status==='consistent_fenced',keys:[]},baselineIdentity:{publishedProgrammeRunId:'run-1',syncUpdatedAt:null,continuationAt:null,continuationHopId:null,latestEnrichmentRunId:null}});
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
 return {directory,aggregateSha256:manifest.totals.aggregateSha256};
}
const output=name=>{const directory=path.join(root,'out-'+name);fs.rmSync(directory,{recursive:true,force:true});return directory;};
const noSleep=async()=>{};

try{
 // Configuration comes from the environment only and refuses ambiguous targets.
 assert.throws(()=>readTarget({}),/D1_BACKFILL_ACCOUNT_ID/);
 assert.throws(()=>readTarget(envFor('https://api.example',{D1_BACKFILL_SCRATCH_DATABASE_ID:TARGET})),/scratch database must differ/);
 assert.throws(()=>readTarget(envFor('http://d1.example.net')),/loopback/);
 assert.throws(()=>readTarget(envFor('https://api.example',{D1_BACKFILL_MAX_BATCH_STATEMENTS:'0'})),/positive integers/);
 assert.equal(readTarget({...envFor(''),D1_BACKFILL_ENDPOINT:''}).endpoint,'https://api.cloudflare.com/client/v4');
 assert.equal(readTarget(envFor('https://api.example')).databaseName,'iptv');
 assert.equal(renderSql('INSERT INTO t VALUES (?,?,?,?)',["it's",3,null,true]),"INSERT INTO t VALUES ('it''s',3,NULL,1)");
 assert.deepEqual(schemaTables().includes('import_receipt'),true);

 const snapshot=writeSnapshot('baseline',baseBodies());
 const targetFile=freshDatabase('target'),scratchFile=freshDatabase('scratch',{schema:false});
 const fake=fakeD1({[TARGET]:{file:targetFile,name:'iptv'},[SCRATCH]:{file:scratchFile,name:'iptv-scratch'}});
 const endpoint=await fake.start();
 const target=readTarget(envFor(endpoint,{D1_BACKFILL_MAX_BATCH_STATEMENTS:'200',D1_BACKFILL_MAX_BATCH_BYTES:'65536'}));

 // Atomicity is proven at the configured size on the scratch database, never assumed, and never touches the target.
 {
  const probe=await probeAtomicity(createD1Adapter({target,databaseId:SCRATCH,sleep:noSleep}),{statements:200,bytes:65536});
  assert.equal(probe.atomic,true,JSON.stringify(probe));
  assert.equal(probe.statements,200);
  assert.equal(probe.rowsAfterFailure,0);
  assert.equal(fake.calls.some(call=>call.database===TARGET),false);
 }
 // A service that keeps earlier statements when the last one fails is a NO-GO before any target write.
 {
  const loose=freshDatabase('loose',{schema:false}),looseTarget=freshDatabase('loose-target');
  const looseFake=fakeD1({[TARGET]:{file:looseTarget,name:'iptv'},[SCRATCH]:{file:loose,name:'iptv-scratch',atomic:false}});
  const looseEndpoint=await looseFake.start();
  const report=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:readTarget(envFor(looseEndpoint)),output:output('loose'),sleep:noSleep});
  assert.equal(report.status,'no_go');
  assert.deepEqual(report.stopReasons,['batch_not_atomic']);
  assert.equal(report.probe.rowsAfterFailure>0,true);
  assert.equal(looseFake.calls.some(call=>call.database===TARGET),false,'the target is not even read');
  assert.equal(count(looseTarget,'SELECT COUNT(*) AS n FROM import_receipt'),0);
  await looseFake.stop();
 }
 // Wrong database identity: the target uuid or name differs from the configuration.
 {
  const wrongFake=fakeD1({[TARGET]:{file:freshDatabase('wrong-target'),name:'iptv-staging'},[SCRATCH]:{file:freshDatabase('wrong-scratch',{schema:false}),name:'iptv-scratch'}});
  const wrongEndpoint=await wrongFake.start();
  const report=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:readTarget(envFor(wrongEndpoint)),output:output('wrong'),sleep:noSleep});
  assert.deepEqual(report.stopReasons,['target_identity_mismatch']);
  assert.equal(wrongFake.calls.filter(call=>call.database===TARGET&&call.write).length,0);
  await wrongFake.stop();
  const sameName=fakeD1({[TARGET]:{file:freshDatabase('same-target'),name:'iptv'},[SCRATCH]:{file:freshDatabase('same-scratch',{schema:false}),name:'iptv'}});
  const sameEndpoint=await sameName.start();
  assert.deepEqual((await runBackfill({snapshot:snapshot.directory,mode:'d1',target:readTarget(envFor(sameEndpoint)),output:output('same'),sleep:noSleep})).stopReasons,['scratch_identity_mismatch']);
  await sameName.stop();
  const empty=fakeD1({[TARGET]:{file:freshDatabase('empty-target',{schema:false}),name:'iptv'},[SCRATCH]:{file:freshDatabase('empty-scratch',{schema:false}),name:'iptv-scratch'}});
  const emptyEndpoint=await empty.start();
  const missing=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:readTarget(envFor(emptyEndpoint)),output:output('empty'),sleep:noSleep});
  assert.deepEqual(missing.stopReasons,['schema_missing']);
  assert.equal(missing.noGo.details.missing.includes('import_receipt'),true);
  await empty.stop();
 }

 // First run, interrupted by --limit, then resumed; the same baseline twice more applies nothing.
 const bounded=await runBackfill({snapshot:snapshot.directory,mode:'d1',target,limit:2,output:output('bounded'),sleep:noSleep});
 assert.equal(bounded.status,'partial',JSON.stringify(bounded.stopReasons));
 assert.equal(bounded.probe.atomic,true);
 assert.equal(bounded.identity.baseline,'first_run');
 assert.equal(bounded.result.applied,2);
 assert.equal(bounded.result.pending>0,true);
 const resumed=await runBackfill({snapshot:snapshot.directory,mode:'d1',target,output:output('resumed'),sleep:noSleep});
 assert.equal(resumed.status,'completed',JSON.stringify(resumed.noGo||resumed.result?.ledger));
 assert.equal(resumed.identity.baseline,'same_baseline');
 assert.equal(resumed.result.resumed,2);
 assert.equal(resumed.result.applied>0,true);
 assert.equal(resumed.result.parity.ok,true,JSON.stringify(resumed.result.parity));
 assert.equal(resumed.result.receipts.stale.length+resumed.result.receipts.foreign.length,0);
 assert.equal(resumed.result.classes.A.mandatory.prediction.portable,true);
 assert.equal(resumed.result.adapter.batches>0,true);
 assert.equal(resumed.result.adapter.largestBatchStatements<=200,true);
 assert.equal(count(targetFile,"SELECT COUNT(*) AS n FROM prediction_current WHERE film_id='film:heat-1995'"),1);
 assert.equal(count(targetFile,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_table='database' AND target_id='"+TARGET+"' AND source_sha256='"+snapshot.aggregateSha256+"'"),1);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'out-resumed','report.json'),'utf8')).status,'completed');
 assert.equal(fs.existsSync(path.join(root,'out-resumed','ledger.json')),true);
 assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'out-resumed','report.json'),'utf8'))).includes(TOKEN),false,'the token never reaches a report');
 const totalApplied=bounded.result.applied+resumed.result.applied;
 for(const name of ['rerun-1','rerun-2']){
  const rerun=await runBackfill({snapshot:snapshot.directory,mode:'d1',target,output:output(name),sleep:noSleep});
  assert.equal(rerun.status,'completed');
  assert.equal(rerun.result.applied,0,name+' applied rows');
  assert.equal(rerun.result.resumed,totalApplied);
  assert.equal(fake.calls.filter(call=>call.database===TARGET&&call.write&&/INSERT INTO film\b|INSERT INTO prediction_current/.test(call.sql)).length>0,true);
 }
 const writesBefore=fake.calls.filter(call=>call.database===TARGET&&call.write&&!/import_receipt/.test(call.sql)).length;
 await runBackfill({snapshot:snapshot.directory,mode:'d1',target,output:output('rerun-3'),sleep:noSleep});
 assert.equal(fake.calls.filter(call=>call.database===TARGET&&call.write&&!/import_receipt/.test(call.sql)).length,writesBefore,'a same-baseline rerun sends no data write');

 // Changed manifest: refused without --delta; with --delta the changed object is re-imported and its old receipt is superseded.
 const revised=writeSnapshot('revised',{...baseBodies(),'enrichment/films/heat-1995/actual.json':{rating:4.5,source:'letterboxd',updatedAt:later}},{finishedAt:'2026-10-26T06:00:00.000Z'});
 const refusedDelta=await runBackfill({snapshot:revised.directory,mode:'d1',target,output:output('changed'),sleep:noSleep});
 assert.deepEqual(refusedDelta.stopReasons,['baseline_changed']);
 assert.equal(refusedDelta.noGo.details.previous.includes(snapshot.aggregateSha256),true);
 const delta=await runBackfill({snapshot:revised.directory,mode:'d1',target,delta:true,output:output('delta'),sleep:noSleep});
 assert.equal(delta.status,'completed',JSON.stringify(delta.noGo||delta.result?.ledger));
 assert.equal(delta.identity.baseline,'changed_baseline');
 assert.equal(delta.result.applied,1);
 assert.equal(delta.result.receipts.superseded.some(item=>item.sourceKey==='enrichment/films/heat-1995/actual.json'),true);
 assert.equal(delta.result.receipts.superseded.some(item=>item.sourceKey==='manifest.json'),true);
 assert.equal(delta.result.receipts.stale.length,0);
 assert.equal(count(targetFile,"SELECT rating*10 AS n FROM actual_rating WHERE film_id='film:heat-1995'"),45);
 // The lineage only moves forward: after A then B, running A again is a rollback, with or without --delta; so is a never-seen
 // baseline older than the high-water mark. Re-running B (the mark) is allowed.
 for(const delta of [false,true]){
  const back=await runBackfill({snapshot:snapshot.directory,mode:'d1',target,delta,output:output('rollback-'+delta),sleep:noSleep});
  assert.deepEqual(back.stopReasons,['baseline_rollback'],'A after B with delta='+delta);
  assert.equal(back.noGo.details.highWater.sourceSha256,revised.aggregateSha256);
 }
 const older=writeSnapshot('older',{...baseBodies(),'enrichment/films/heat-1995/actual.json':{rating:3,source:'letterboxd',updatedAt:at}},{finishedAt:'2026-10-26T03:00:00.000Z'});
 assert.deepEqual((await runBackfill({snapshot:older.directory,mode:'d1',target,delta:true,output:output('older'),sleep:noSleep})).stopReasons,['baseline_rollback']);
 assert.equal(count(targetFile,"SELECT rating*10 AS n FROM actual_rating WHERE film_id='film:heat-1995'"),45,'no rollback write landed');
 assert.equal((await runBackfill({snapshot:revised.directory,mode:'d1',target,output:output('mark-again'),sleep:noSleep})).identity.baseline,'same_baseline');
 // Two different baselines recorded at the same instant are ambiguous, never resolved by guessing.
 sqlite(targetFile,"INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES ('manifest.json','twin-sha','database','"+TARGET+"','2026-10-26T06:00:00.000Z');");
 assert.deepEqual((await runBackfill({snapshot:revised.directory,mode:'d1',target,output:output('twin'),sleep:noSleep})).stopReasons,['baseline_ambiguous']);
 sqlite(targetFile,"DELETE FROM import_receipt WHERE source_sha256='twin-sha';");

 // Duplicate receipts are a no-op; a stale receipt (old checksum, nothing superseding it) and a foreign receipt block class A.
 {
  const duplicate=sqlite(targetFile,"PRAGMA foreign_keys=ON;\nINSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) SELECT source_key,source_sha256,target_table,target_id,imported_at FROM import_receipt LIMIT 1 ON CONFLICT DO NOTHING;");
  assert.equal(duplicate.status,0,duplicate.stderr);
  sqlite(targetFile,"INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES ('enrichment/films/heat-1995/fingerprint.json','old-print-sha','fingerprint_payload','film:other','"+at+"'), ('enrichment/films/ghost/actual.json','ghost-sha','actual_rating','film:ghost','"+at+"');");
  const audited=await runBackfill({snapshot:revised.directory,mode:'d1',target,delta:true,output:output('audit'),sleep:noSleep});
  assert.equal(audited.status,'completed');
  assert.equal(audited.result.receipts.stale.some(item=>item.sourceSha256==='old-print-sha'),true);
  assert.equal(audited.result.receipts.foreign.some(item=>item.sourceKey==='enrichment/films/ghost/actual.json'),true);
  assert.equal(audited.result.classes.A.blockers.includes('receipts_stale'),true);
  assert.equal(audited.result.classes.A.blockers.includes('receipts_foreign'),true);
  assert.equal(audited.result.claimsFullParity,false);
  sqlite(targetFile,"DELETE FROM import_receipt WHERE source_sha256 IN ('old-print-sha','ghost-sha');");
 }
 // A database identity receipt naming another database is a conflict, even with the right uuid and name configured.
 {
  sqlite(targetFile,"INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES ('manifest.json','"+revised.aggregateSha256+"','database','33333333-3333-4333-8333-333333333333','"+at+"');");
  const conflicted=await runBackfill({snapshot:revised.directory,mode:'d1',target,delta:true,output:output('conflict-db'),sleep:noSleep});
  assert.deepEqual(conflicted.stopReasons,['database_identity_conflict']);
  sqlite(targetFile,"DELETE FROM import_receipt WHERE target_id='33333333-3333-4333-8333-333333333333';");
 }

 // A write whose response is lost is not retried: the run stops, and the next run reconciles through the read-back.
 {
  const lostFile=freshDatabase('lost'),lostFake=fakeD1({[TARGET]:{file:lostFile,name:'iptv'},[SCRATCH]:{file:freshDatabase('lost-scratch',{schema:false}),name:'iptv-scratch'}});
  const lostEndpoint=await lostFake.start(),lostTarget=readTarget(envFor(lostEndpoint));
  let armed=true;
  lostFake.hooks.push(({database,write,sql,phase})=>{if(armed&&phase==='after'&&database===TARGET&&write&&/INSERT INTO fingerprint_payload/.test(sql)){armed=false;return 'drop';}});
  const lost=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:lostTarget,output:output('lost'),sleep:noSleep});
  assert.equal(lost.status,'no_go');
  assert.deepEqual(lost.stopReasons,['write_uncertain']);
  assert.equal(count(lostFile,'SELECT COUNT(*) AS n FROM fingerprint_payload'),1,'the lost-response write did land');
  assert.equal(count(lostFile,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_table='fingerprint_payload'"),0,'and it was not receipted');
  const after=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:lostTarget,output:output('lost-after'),sleep:noSleep});
  assert.equal(after.status,'completed',JSON.stringify(after.noGo||after.result?.ledger));
  assert.equal(after.result.reconciled>=1,true,'the landed write is read back and receipted, not written again');
  assert.equal(after.result.parity.ok,true);
  // A batch that commits and then answers HTTP 500 is sent exactly once: the run stops, and the next run reconciles by read-back.
  const fiveFile=freshDatabase('five'),fiveFake=fakeD1({[TARGET]:{file:fiveFile,name:'iptv'},[SCRATCH]:{file:freshDatabase('five-scratch',{schema:false}),name:'iptv-scratch'}});
  const fiveEndpoint=await fiveFake.start(),fiveTarget=readTarget(envFor(fiveEndpoint));
  let fiveArmed=true;
  fiveFake.hooks.push(({database,write,sql,phase,ok})=>{if(fiveArmed&&phase==='after'&&ok&&database===TARGET&&write&&/INSERT INTO actual_rating/.test(sql)){fiveArmed=false;return 500;}});
  const five=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:fiveTarget,output:output('five'),sleep:noSleep});
  assert.equal(five.status,'no_go');
  assert.deepEqual(five.stopReasons,['write_uncertain']);
  assert.equal(five.noGo.details.status,500);
  assert.equal(fiveFake.calls.filter(call=>call.database===TARGET&&/INSERT INTO actual_rating/.test(call.sql)).length,1,'the uncertain batch was sent exactly once');
  assert.equal(count(fiveFile,'SELECT COUNT(*) AS n FROM actual_rating'),1,'it did commit');
  assert.equal(count(fiveFile,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_table='actual_rating'"),0);
  const fiveAfter=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:fiveTarget,output:output('five-after'),sleep:noSleep});
  assert.equal(fiveAfter.status,'completed',JSON.stringify(fiveAfter.noGo||fiveAfter.result?.ledger));
  assert.equal(fiveAfter.result.reconciled>=1,true);
  assert.equal(fiveFake.calls.filter(call=>call.database===TARGET&&/INSERT INTO actual_rating/.test(call.sql)).length,1,'the reconciling run did not resend it');
  assert.equal(fiveAfter.result.parity.ok,true);
  // A 503 on a write is just as uncertain and is not retried either.
  let writeBusy=true;
  fiveFake.hooks.push(({database,write,phase})=>{if(writeBusy&&phase==='before'&&database===TARGET&&write){writeBusy=false;return 503;}});
  sqlite(fiveFile,'DELETE FROM import_receipt;');
  const busy=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:fiveTarget,output:output('five-busy'),sleep:noSleep});
  assert.deepEqual(busy.stopReasons,['write_uncertain']);
  await fiveFake.stop();
  // Transient read failures are retried within a bound; a refused credential is not retried.
  let flaky=2;
  lostFake.hooks.push(({database,write,phase})=>{if(flaky>0&&phase==='before'&&database===TARGET&&!write){flaky--;return 503;}});
  const flakyRun=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:lostTarget,output:output('flaky'),sleep:noSleep});
  assert.equal(flakyRun.status,'completed');
  assert.equal(flakyRun.result.adapter.retries>=2,true);
  await assert.rejects(runBackfill({snapshot:snapshot.directory,mode:'d1',target:{...lostTarget,apiToken:'wrong'},output:output('denied'),sleep:noSleep}),error=>error instanceof D1Error&&error.kind==='authorization');
  await lostFake.stop();
 }

 // A unit larger than the configured batch is not split across requests: the run stops.
 {
  const smallFile=freshDatabase('small'),smallFake=fakeD1({[TARGET]:{file:smallFile,name:'iptv'},[SCRATCH]:{file:freshDatabase('small-scratch',{schema:false}),name:'iptv-scratch'}});
  const smallEndpoint=await smallFake.start();
  const small=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:readTarget(envFor(smallEndpoint,{D1_BACKFILL_MAX_BATCH_STATEMENTS:'3'})),output:output('small'),sleep:noSleep});
  assert.equal(small.status,'no_go');
  assert.deepEqual(small.stopReasons,['batch_too_large']);
  await smallFake.stop();
 }

 // Fail-closed import: an unexpected conflict, a prediction version gap and an unacknowledged class C record each stop the run;
 // only an acknowledged class C record lets it continue. Class A is never acknowledgeable.
 {
  const gapBodies={...baseBodies(),'enrichment/films/heat-1995/predictions.json':{current:{...version.record},history:[]}};
  delete gapBodies[version.pointer.r2Key];
  const gap=writeSnapshot('gap',gapBodies);
  const gapFile=freshDatabase('gap-db');
  const gapReport=await runBackfill({snapshot:gap.directory,mode:'sqlite',sqliteFile:gapFile,output:output('gap'),sleep:noSleep});
  assert.equal(gapReport.status,'stopped');
  assert.deepEqual(gapReport.stopReasons,['class_a_blocker']);
  assert.equal(gapReport.result.blockers[0].reason,'prediction_version_object_missing');
  assert.equal(gapReport.result.pending>0,true);
  assert.equal(gapReport.result.claimsFullParity,false);
  const notAcknowledgeable=await runBackfill({snapshot:gap.directory,mode:'sqlite',sqliteFile:freshDatabase('gap-db-2'),acknowledged:[{sourceKey:'enrichment/films/heat-1995/predictions.json',targetTable:'prediction_current',targetId:'film:heat-1995',reason:'prediction_version_object_missing'}],output:output('gap-ack'),sleep:noSleep});
  assert.deepEqual(notAcknowledgeable.stopReasons,['class_a_blocker']);

  const ghost=writeSnapshot('ghost',{...baseBodies(),'enrichment/films/tmdb_404/fingerprint.json':{fingerprintSchemaVersion:1,fingerprintHash:'print-ghost',generatedAt:at,invalidatedAt:null}});
  const ghostReport=await runBackfill({snapshot:ghost.directory,mode:'sqlite',sqliteFile:freshDatabase('ghost-db'),output:output('ghost'),sleep:noSleep});
  assert.deepEqual(ghostReport.stopReasons,['unacknowledged_record']);
  assert.equal(ghostReport.result.blockers[0].class,'C');
  const ackFile=path.join(root,'class-c.json');
  fs.writeFileSync(ackFile,JSON.stringify([{sourceKey:'enrichment/films/tmdb_404/fingerprint.json',targetTable:'fingerprint_payload',targetId:'film:tmdb:404',reason:'film_unresolved'}]));
  const acknowledged=JSON.parse(fs.readFileSync(ackFile,'utf8'));
  const ghostAcknowledged=await runBackfill({snapshot:ghost.directory,mode:'sqlite',sqliteFile:freshDatabase('ghost-db-2'),acknowledged,output:output('ghost-ack'),sleep:noSleep});
  assert.equal(ghostAcknowledged.status,'completed',JSON.stringify(ghostAcknowledged.stopReasons));
  assert.equal(ghostAcknowledged.result.classes.C.count,1);
  assert.equal(ghostAcknowledged.result.claimsFullParity,false,'an acknowledged class C record is a known gap, never lossless parity');
  const ledger=JSON.parse(fs.readFileSync(path.join(root,'out-ghost-ack','ledger.json'),'utf8'));
  assert.equal(ledger.classC[0].sourceKey,'enrichment/films/tmdb_404/fingerprint.json');
  assert.equal(typeof ledger.classC[0].sourceSha256,'string');

  const collisionBodies={...baseBodies(),'watchlist.json':{films:[heat,{id:'heat-copy',title:'Heat copy',original:'Heat copy',tmdbId:7,year:1995}]},'programme.json':{runId:'run-1',films:[{...heat,shows:[]},{id:'heat-copy',title:'Heat copy',original:'Heat copy',tmdbId:7,year:1995,shows:[]}]}};
  const collision=writeSnapshot('collision',collisionBodies);
  const collisionReport=await runBackfill({snapshot:collision.directory,mode:'sqlite',sqliteFile:freshDatabase('collision-db'),output:output('collision'),sleep:noSleep});
  assert.equal(collisionReport.status,'stopped');
  assert.deepEqual(collisionReport.stopReasons,['unexpected_conflict']);
  assert.equal(collisionReport.result.pending>0,true,'units after the conflict were not written');
 }

 // Snapshot gates: a NO-GO manifest and a historical archive are refused before any target is touched.
 {
  const noGo=writeSnapshot('nogo',baseBodies(),{status:'no_go'});
  const noGoReport=await runBackfill({snapshot:noGo.directory,mode:'sqlite',sqliteFile:freshDatabase('nogo-db'),output:output('nogo'),sleep:noSleep});
  assert.deepEqual(noGoReport.stopReasons,['snapshot_not_consistent']);
  const historical=writeSnapshot('historical',baseBodies(),{production:false});
  await assert.rejects(runBackfill({snapshot:historical.directory,mode:'sqlite',sqliteFile:freshDatabase('historical-db'),output:output('historical'),sleep:noSleep}),/not a production R2 snapshot/);
  await assert.rejects(runBackfill({snapshot:snapshot.directory,mode:'sqlite',sqliteFile:path.resolve('tests','inside.sqlite'),output:output('inside'),sleep:noSleep}),/outside the Git repository/);
 }

 // Dry-run parity with the D1 path, and a local rollback rehearsal: backup, run, restore, identity fence, re-import.
 {
  const dryFile=freshDatabase('dry');
  const backup=path.join(root,'dry-backup.sqlite');fs.copyFileSync(dryFile,backup);
  const dry=await runBackfill({snapshot:snapshot.directory,mode:'sqlite',sqliteFile:dryFile,output:output('dry'),sleep:noSleep});
  assert.equal(dry.status,'completed');
  assert.equal(dry.result.applied,totalApplied,'the dry-run applies what the D1 run applied');
  assert.equal(dry.result.parity.ok,true);
  fs.copyFileSync(backup,dryFile);
  assert.equal(count(dryFile,'SELECT COUNT(*) AS n FROM film'),0);
  assert.equal(count(dryFile,'SELECT COUNT(*) AS n FROM import_receipt'),0);
  const again=await runBackfill({snapshot:snapshot.directory,mode:'sqlite',sqliteFile:dryFile,output:output('dry-again'),sleep:noSleep});
  assert.equal(again.identity.baseline,'first_run');
  assert.equal(again.result.applied,totalApplied);
  const fence=await verifyTargetIdentity((await import('../scripts/offline-import.mjs')).openSqlite(dryFile),{databaseId:'sqlite:dry.sqlite',databaseName:'dry-run',aggregateSha256:revised.aggregateSha256,baselineAt:'2026-10-26T06:00:00.000Z',describe:false}).catch(error=>error);
  assert.equal(fence instanceof BackfillStop&&fence.reason==='baseline_changed',true,'restoring a backup and pointing a different baseline at it is fenced');
 }

 // Staged generation (ADR-0021, schema v2): opt-in, fenced on schema version, reported with perf counters and the commit gate,
 // and its cleanup needs an explicit approval and touches staging rows only.
 {
  const stagedSchema=migration+'\n'+fs.readFileSync('migrations/0002_generation_stage.sql','utf8');
  const stagedDatabase=name=>{const file=path.join(root,name+'.sqlite');fs.rmSync(file,{force:true});const result=sqlite(file,'PRAGMA foreign_keys=ON;\n'+stagedSchema);assert.equal(result.status,0,result.stderr);return file;};
  const STAGED_TARGET='33333333-3333-4333-8333-333333333333',STAGED_SCRATCH='44444444-4444-4444-8444-444444444444';
  const stagedFile=stagedDatabase('staged-target');
  const stagedFake=fakeD1({[STAGED_TARGET]:{file:stagedFile,name:'iptv'},[STAGED_SCRATCH]:{file:freshDatabase('staged-scratch',{schema:false}),name:'iptv-scratch'}});
  const stagedEndpoint=await stagedFake.start();
  const stagedTarget=readTarget(envFor(stagedEndpoint,{D1_BACKFILL_DATABASE_ID:STAGED_TARGET,D1_BACKFILL_SCRATCH_DATABASE_ID:STAGED_SCRATCH,D1_BACKFILL_MAX_BATCH_STATEMENTS:'200',D1_BACKFILL_MAX_BATCH_BYTES:'65536'}));
  const first=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:stagedTarget,output:output('staged-d1'),sleep:noSleep,stagedGeneration:true});
  assert.equal(first.status,'completed',JSON.stringify(first.noGo||first.stopReasons));
  assert.deepEqual(first.staged.limits,{maxStatements:200,maxBytes:65536});
  assert.equal(first.staged.generations.length,1);
  assert.equal(first.staged.generations[0].outcome,'committed');
  assert.equal(first.staged.generations[0].commit.statements,12);
  assert.equal(first.staged.gate.go,true);
  assert.equal(first.result.parity.ok,true);
  assert.equal(count(stagedFile,"SELECT COUNT(*) AS n FROM generation_stage WHERE state='published'"),1);
  assert.equal(count(stagedFile,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_table='programme_generation'"),1);
  assert.equal(stagedFake.calls.some(call=>/\bBEGIN\b|\bCOMMIT\b/.test(call.sql)),false,'no transaction keywords are sent');
  const rerun=await runBackfill({snapshot:snapshot.directory,mode:'d1',target:stagedTarget,output:output('staged-d1-rerun'),sleep:noSleep,stagedGeneration:true});
  assert.equal(rerun.status,'completed');
  assert.equal(rerun.result.applied,0);
  assert.equal(rerun.staged.generations.length,0,'a receipted generation is not staged again');
  await stagedFake.stop();

  // Schema fence: the staged path needs migration 0002 and schema version 2.
  const v1Only=await runBackfill({snapshot:snapshot.directory,mode:'sqlite',sqliteFile:freshDatabase('staged-v1'),output:output('staged-v1'),sleep:noSleep,stagedGeneration:true});
  assert.deepEqual(v1Only.stopReasons,['schema_missing']);
  assert.ok(v1Only.noGo.details.missing.includes('generation_stage'));
  const wrongVersion=stagedDatabase('staged-version');
  assert.equal(sqlite(wrongVersion,'UPDATE schema_contract SET version=1;').status,0);
  const versionReport=await runBackfill({snapshot:snapshot.directory,mode:'sqlite',sqliteFile:wrongVersion,output:output('staged-version'),sleep:noSleep,stagedGeneration:true});
  assert.deepEqual(versionReport.stopReasons,['schema_version_mismatch']);
  assert.equal(count(wrongVersion,'SELECT COUNT(*) AS n FROM import_receipt'),0,'nothing is written before the fence passes');

  // A stage this baseline does not own stops the run as a NO-GO with its reason, and its cleanup is approval-gated.
  const owned=stagedDatabase('staged-owned');
  assert.equal(sqlite(owned,"PRAGMA foreign_keys=ON;\nINSERT INTO generation_stage (programme_run_id,baseline_sha256,phase,published_at,expected_programme_run_id,state,owner_token,chunk_count,film_count,film_show_count,candidate_count,candidate_show_count,created_at,updated_at) VALUES ('run-1','"+snapshot.aggregateSha256+"','published',NULL,NULL,'loading','someone-else',1,1,1,0,0,'"+at+"','"+at+"');").status,0);
  const ownedReport=await runBackfill({snapshot:snapshot.directory,mode:'sqlite',sqliteFile:owned,output:output('staged-owned'),sleep:noSleep,stagedGeneration:true});
  assert.equal(ownedReport.status,'no_go');
  assert.deepEqual(ownedReport.stopReasons,['stage_owned_elsewhere']);
  assert.equal(count(owned,'SELECT COUNT(*) AS n FROM programme_generation'),0);
  assert.notEqual(stageOwner('sqlite:staged-owned.sqlite',snapshot.aggregateSha256),'someone-else');
  await assert.rejects(runStageCleanup({mode:'sqlite',sqliteFile:owned,programmeRunId:'run-1',output:output('cleanup-unapproved')}),/cleanup-approved/);
  const live=await runStageCleanup({mode:'sqlite',sqliteFile:owned,programmeRunId:'run-1',approved:true,output:output('cleanup-live')});
  assert.deepEqual(live.noGo.reason,'stage_not_discardable');
  assert.equal(sqlite(owned,"UPDATE generation_stage SET state='failed';").status,0);
  const cleaned=await runStageCleanup({mode:'sqlite',sqliteFile:owned,programmeRunId:'run-1',approved:true,output:output('cleanup-failed')});
  assert.equal(cleaned.status,'completed');
  assert.equal(count(owned,'SELECT COUNT(*) AS n FROM generation_stage'),0);
  const afterCleanup=await runBackfill({snapshot:snapshot.directory,mode:'sqlite',sqliteFile:owned,output:output('staged-after-cleanup'),sleep:noSleep,stagedGeneration:true});
  assert.equal(afterCleanup.status,'completed',JSON.stringify(afterCleanup.noGo||afterCleanup.stopReasons));
  assert.equal(afterCleanup.staged.generations[0].outcome,'committed');

  // CLI opt-in and the approval flag.
  const cliStaged=spawnSync(process.execPath,['scripts/d1-backfill.mjs','--snapshot',snapshot.directory,'--output',output('cli-staged'),'--target','sqlite','--database',stagedDatabase('cli-staged'),'--staged-generation'],{encoding:'utf8'});
  assert.equal(cliStaged.status,0,cliStaged.stderr);
  assert.equal(JSON.parse(cliStaged.stdout).staged.generations[0].outcome,'committed');
  const cliCleanup=spawnSync(process.execPath,['scripts/d1-backfill.mjs','--discard-stage','run-1','--target','sqlite','--database',owned,'--output',output('cli-cleanup')],{encoding:'utf8'});
  assert.equal(cliCleanup.status,2);
  assert.match(cliCleanup.stderr,/cleanup-approved/);
 }

 // The CLI: usage, configuration and exit codes, with the secret only in the environment.
 {
  assert.equal(spawnSync(process.execPath,['scripts/d1-backfill.mjs','--snapshot','relative'],{encoding:'utf8'}).status,2);
  const missingEnv=spawnSync(process.execPath,['scripts/d1-backfill.mjs','--snapshot',snapshot.directory,'--output',output('cli-env'),'--target','d1'],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(missingEnv.status,2);
  assert.match(missingEnv.stderr,/configuration/);
  const cliDb=freshDatabase('cli');
  const cli=spawnSync(process.execPath,['scripts/d1-backfill.mjs','--snapshot',snapshot.directory,'--output',output('cli'),'--target','sqlite','--database',cliDb],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status,'completed');
  // The target's high-water mark is the revised baseline now, so the CLI re-runs that one. The fake D1 server lives in this process, so the CLI runs asynchronously; a synchronous spawn would block the server it calls.
  const cliD1=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/d1-backfill.mjs','--snapshot',revised.directory,'--output',output('cli-d1'),'--target','d1'],{env:{PATH:process.env.PATH,...envFor(endpoint)}});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));});
  assert.equal(cliD1.status,0,cliD1.stderr);
  assert.equal(JSON.parse(cliD1.stdout).result.applied,0);
  assert.equal(cliD1.stdout.includes(TOKEN),false);
 }
 await fake.stop();
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('D1 backfill: environment-only target, scratch atomicity proof at size, non-atomic service NO-GO, identity and schema fence, bounded resume, empty reruns, changed baseline and delta, duplicate/stale/foreign receipts, lost-response writes, bounded retries, oversized units, fail-closed classes A and C, snapshot gates, dry-run and rollback rehearsal, staged generation with schema v2 fence, stage ownership NO-GO and approval-gated cleanup passed');
