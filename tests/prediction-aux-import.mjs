// AIR-553 / ADR 0194 decision 10: the offline importer and dry run. The R2 objects come from the REAL Worker running its legacy R2 path (marker r2); the importer turns that export into rows and guarded
// SQL; the SQL is applied to the same sqlite database (an offline stand-in for the owner's AIR-554 step), the marker is flipped by the test, and the Worker then serves the same bytes from D1.
// A dry run writes nothing. No production call, no Scheduled Task, no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {flowWorld,sql,migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as Aux from '../src/prediction-aux-d1.js';
import {buildPlan,planReport,planSql,readExport} from '../scripts/prediction-aux-d1-import.mjs';

const applySql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\nBEGIN;\n'+text+'COMMIT;',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr.trim());};
const exportOf=w=>Object.fromEntries([...w.records.entries()].map(([key,value])=>[key,structuredClone(value)]));
const count=(file,table)=>Number(sql(file,'SELECT count(*) AS n FROM '+table)[0].n);
const tables=['prediction_batch_stage','prediction_run_source_head','prediction_run_source_revision','prediction_run_source_piece','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox'];

// ---- 1. End to end: real R2 objects -> plan -> SQL -> D1 rows -> the Worker serves the same bytes ----
{
 const w=await flowWorld({films:8,aux:'r2'});
 const {start}=await w.reconcileAndStart({manifestSize:4});assert.equal(start.status,200,JSON.stringify(start.data).slice(0,200));
 const runId=start.data.runId;
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 const tool=async(args)=>{w.ctx.__a={name:'prediction_batch_manifest',args};w.ctx.__env=w.env;const r=(await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;assert.equal(r.isError,undefined,JSON.stringify(r).slice(0,200));return JSON.parse(r.content[0].text);};
 const paired=await w.pair(runId);assert.equal(paired.submit.status,200);
 const left=start.data.films.slice(1,3).map(f=>({filmId:f.filmId,...(f.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction}));
 assert.equal((await w.api('batch/hold',{runId,epoch:start.data.lease.epoch,items:left})).status,200);
 const parts={envelope:await tool({runId,part:'envelope'}),profile:await tool({runId,part:'profile'}),contract:await tool({runId,part:'contract'}),film:await tool({runId,part:'film',filmId:start.data.films[0].filmId}),hold:await tool({runId,part:'hold'})};
 // a skipped request while the lease is held, then the completion
 const rival=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',capacity:{remainingPercent:100}});assert.equal(rival.data.status,'already_running');
 assert.equal((await w.api('complete',{runId,reason:'external_termination'})).status,200);
 const exported=exportOf(w);
 assert.ok(exported['enrichment/batch-stage.json']&&exported['enrichment/sources/'+runId+'.json']&&exported['enrichment/batch-manifest/'+runId+'.json'],'the legacy path wrote the three families');
 const plan=await buildPlan(exported);assert.deepEqual(plan.blockers,[]);
 const report=await planReport(plan);
 assert.equal(report.stage.items,2);assert.equal(report.sources.runs,1);assert.equal(report.manifests.count,1);assert.equal(report.outbox.byState.delivered,2,'the stop and the skipped record were delivered before the export');
 // a dry run changes nothing (the database is not even opened); the report is reproducible
 const before=tables.map(t=>count(w.file,t));assert.deepEqual(before,tables.map(()=>0));
 assert.deepEqual(await planReport(await buildPlan(exported)),report,'a repeated dry run gives the same counts and digests');
 // apply the guarded SQL while the marker is r2 and the tables are empty; a second apply aborts whole
 const text=planSql(plan);
 applySql(w.file,text);
 assert.throws(()=>applySql(w.file,text),/CHECK constraint failed: ok/,'an import never merges into existing history');
 assert.equal(count(w.file,'prediction_batch_stage'),2);assert.equal(count(w.file,'prediction_run_manifest'),1);assert.equal(count(w.file,'prediction_event_outbox'),2);
 // counts and digests of the rows equal the plan
 const stored=await Aux.readManifest(w.db,runId);assert.equal(JSON.stringify(stored),JSON.stringify(exported['enrichment/batch-manifest/'+runId+'.json']),'the manifest is the exact persisted response');
 assert.equal(JSON.stringify((await Aux.readSource(w.db,runId)).value),JSON.stringify(exported['enrichment/sources/'+runId+'.json']));
 const stage=await Aux.readStage(w.db);assert.deepEqual(stage.items.map(i=>i.filmId),exported['enrichment/batch-stage.json'].items.map(i=>i.filmId));assert.equal(stage.totalBytes,report.stage.totalBytes);
 // flip the marker (the owner's AIR-554 step, simulated) and read the same parts through the Worker: byte-equal to what the R2 path served
 sql(w.file,"UPDATE prediction_aux_authority SET mode='d1', generation=1, activated_at='2026-11-22T10:00:00.000Z' WHERE id=1");
 for(const [name,args] of [['envelope',{part:'envelope'}],['profile',{part:'profile'}],['contract',{part:'contract'}],['film',{part:'film',filmId:start.data.films[0].filmId}],['hold',{part:'hold'}]]){
  // a completed run answers `run_not_running` for a manifest part; the parity of the stored bytes is the readManifestPart/readManifest comparison above, and the hold part is a live stage read
  if(name==='hold')assert.deepEqual((await Aux.readStage(w.db)).items.map(i=>i.filmId).sort(),parts.hold.filmIds.sort(),'the hold read agrees');
  else{const got=await Aux.readManifestPart(w.db,runId,args.part,args.filmId);assert.ok(got,name);if(name==='film')assert.deepEqual(got.value,parts.film.film);if(name==='profile')assert.deepEqual(got.value,parts.profile.profile);if(name==='contract')assert.deepEqual(got.value,parts.contract.contract);if(name==='envelope')assert.deepEqual(got.filmIds,parts.envelope.parts.filter(p=>p.kind==='film').map(p=>p.filmId));}
 }
 // the imported records are not delivered again; the next start (marker d1) delivers nothing and drains the imported stage under its own lease
 const journalBefore=[...w.records.keys()].filter(k=>k.startsWith('events/items/')).length;
 const next=await w.reconcileAndStart({manifestSize:2});assert.equal(next.start.status,200,JSON.stringify(next.start.data).slice(0,300));
 assert.ok(next.start.data.drained,'the imported stage drains under its new run');assert.equal(count(w.file,'prediction_batch_stage'),0);
 assert.equal([...w.records.keys()].filter(k=>k.startsWith('events/items/')).length,journalBefore,'settled imported records are never re-delivered');
}

// ---- 2. Every outbox state, from the records and the pending index ----
{
 const at=n=>'2026-11-1'+n+'T10:00:00.000Z';
 const event=(id,n,extra={})=>({id,type:'enrichment',at:at(n),stage:'complete',...extra});
 const objects={
  'enrichment/stop-events/run-a.json':{event:event('enrichment-run-a',1),delivered:true},
  'enrichment/stop-events/run-b.json':{event:event('enrichment-run-b',2),delivered:true,superseded:true},
  'enrichment/stop-events/run-c.json':{event:event('enrichment-run-c',3)},
  'enrichment/stop-events/run-d.json':{event:event('enrichment-run-d',4)},
  'enrichment/stop-events/skipped-req-1.json':{event:event('enrichment-skipped-req-1',5,{stage:'skipped',presentation:'batch_v2_skipped'})},
  'enrichment/start-events/run-old.json':{event:event('enrichment-start-old',6,{stage:'start'}),delivered:true},
  'enrichment/event-outbox.json':{pending:{
   'enrichment/stop-events/run-c.json':{since:'2026-11-13T10:05:00.000Z',attempts:3,lastAttemptAt:'2026-11-13T11:00:00.000Z',quarantined:false},
   'enrichment/stop-events/run-d.json':{since:'2026-11-14T10:05:00.000Z',attempts:8,lastAttemptAt:'2026-11-14T11:00:00.000Z',quarantined:true},
   'enrichment/stop-events/gone.json':{since:'2026-11-01T00:00:00.000Z',attempts:1,quarantined:false},
   'something/else.json':{since:'x'}}},
 };
 const plan=await buildPlan(objects);assert.deepEqual(plan.blockers,[]);
 const by=Object.fromEntries(plan.outbox.map(r=>[r.eventKey,r]));
 assert.equal(by['stop:run-a'].state,'delivered');assert.equal(by['stop:run-a'].settledAt,at(1));
 assert.equal(by['stop:run-b'].state,'superseded');
 assert.deepEqual([by['stop:run-c'].state,by['stop:run-c'].attempts,by['stop:run-c'].since],['pending',3,'2026-11-13T10:05:00.000Z']);
 assert.deepEqual([by['stop:run-d'].state,by['stop:run-d'].attempts],['quarantined',8]);
 assert.equal(by['skipped:req-1'].kind,'skipped');assert.equal(by['skipped:req-1'].state,'pending');assert.equal(by['skipped:req-1'].since,at(5),'without an index entry, since is the event time');
 assert.equal(by['start:run-old'].kind,'start');
 assert.deepEqual(plan.orphanIndexEntries,['enrichment/stop-events/gone.json'],'an index entry without a record is reported, not imported');
 assert.equal(by['stop:run-a'].journalKey,'events/items/'+String(9999999999999-Date.parse(at(1))).padStart(13,'0')+'-enrichment-run-a.json','the journal key is derived exactly as the Worker derives it');
 const file=migrated();applySql(file,planSql(plan));
 const states=Object.fromEntries(sql(file,'SELECT event_key AS k, state FROM prediction_event_outbox').map(r=>[r.k,r.state]));
 assert.deepEqual(states,{'stop:run-a':'delivered','stop:run-b':'superseded','stop:run-c':'pending','stop:run-d':'quarantined','skipped:req-1':'pending','start:run-old':'delivered'});
 assert.equal(count(file,'prediction_event_outbox_counter')&&sql(file,'SELECT active_pending AS n FROM prediction_event_outbox_counter')[0].n,1,'the skipped counter follows the imported rows');
 // an imported settled record is compactable at once (its settlement time is its own time) and keeps its identity
 sql(file,"UPDATE prediction_aux_authority SET mode='d1', generation=1, activated_at='2026-11-22T10:00:00.000Z' WHERE id=1");
 const db=(await import('./d1-standin.mjs')).d1Standin(file);
 assert.equal(await Aux.compactSettled(db,{mode:'d1',generation:1},{now:()=>Date.parse('2026-12-30T00:00:00.000Z')}),3);
 assert.equal((await Aux.readOutboxRow(db,'stop:run-a')).event,null);assert.equal((await Aux.readOutboxRow(db,'stop:run-c')).event.id,'enrichment-run-c','pending payloads stay');
}

// ---- 3. Blockers: nothing is imported from a source the Worker could not read ----
{
 const huge=Array.from({length:10},(_,n)=>({filmId:'f'+n,itemDigest:'digest'+n+'xxxx',prediction:{note:'x'.repeat(7000)},origin:{runId:'r'}}));
 const cases={
  'stage over the aggregate cap':{'enrichment/batch-stage.json':{items:huge}},
  'stage over ten items':{'enrichment/batch-stage.json':{items:Array.from({length:11},(_,n)=>({filmId:'f'+n,itemDigest:'digest'+n+'xxxx'}))}},
  'stage unreadable':{'enrichment/batch-stage.json':{items:'no'}},
  'manifest not usable':{'enrichment/batch-manifest/r1.json':{runId:'other',films:[]}},
  'source not an object':{'enrichment/sources/r1.json':[1,2]},
  'event record without event':{'enrichment/stop-events/r1.json':{delivered:true}},
  'event with a bad time':{'enrichment/stop-events/r1.json':{event:{id:'e',at:'yesterday'}}},
  'skipped over the cap':Object.fromEntries(Array.from({length:257},(_,n)=>['enrichment/stop-events/skipped-s'+n+'.json',{event:{id:'enrichment-skipped-s'+n,at:'2026-11-10T10:00:00.000Z'}}])),
 };
 for(const [name,objects] of Object.entries(cases)){const plan=await buildPlan(objects);assert.ok(plan.blockers.length>=1,name+' is a blocker');}
 // the CLI: a blocker exits 2 and prints no SQL; a good export prints SQL; a dry run prints a report and no SQL
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aux-import-'));
 const bad=path.join(dir,'bad.json'),good=path.join(dir,'good.json');
 fs.writeFileSync(bad,JSON.stringify(cases['stage unreadable']));fs.writeFileSync(good,JSON.stringify({'enrichment/stop-events/run-a.json':{event:{id:'enrichment-run-a',at:'2026-11-10T10:00:00.000Z'},delivered:true}}));
 const run=(...args)=>spawnSync(process.execPath,['scripts/prediction-aux-d1-import.mjs',...args],{encoding:'utf8'});
 const blocked=run('sql',bad);assert.equal(blocked.status,2);assert.equal(blocked.stdout,'');assert.match(blocked.stderr,/BLOCKER/);
 const ok=run('sql',good);assert.equal(ok.status,0);assert.match(ok.stdout,/^UPDATE prediction_aux_cas SET ok=/);assert.ok(ok.stdout.split('\n').every(line=>line.length<110000),'every statement fits the D1 budget');
 const dry=run('report',good);assert.equal(dry.status,0);assert.equal(JSON.parse(dry.stdout).outbox.total,1);assert.doesNotMatch(dry.stdout,/INSERT INTO/);
 assert.equal(run('nope',good).status,1);
 // a directory export mirrors the keys
 const tree=path.join(dir,'tree');fs.mkdirSync(path.join(tree,'enrichment/stop-events'),{recursive:true});fs.writeFileSync(path.join(tree,'enrichment/stop-events/run-a.json'),JSON.stringify({event:{id:'enrichment-run-a',at:'2026-11-10T10:00:00.000Z'},delivered:true}));
 assert.deepEqual(Object.keys(readExport(tree)),['enrichment/stop-events/run-a.json']);
 void execFileSync;
}
console.log('prediction aux import: ok');
