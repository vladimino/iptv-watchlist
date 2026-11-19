// AIR-539 / ADR 0175 (Accepted): the EPG run completion certificate. The EPG-priority pause lifts only when the published run is certified complete.
// Local sqlite stand-ins for D1 (each batch one transaction), a memory bucket for R2. Nothing here calls Cloudflare, TMDB or production, and migration
// 0026 is applied only to throwaway files. Covered: the migration file; an ABSENT column (today's behaviour, byte for byte); the pointer move that
// resets the certificate for a different run and keeps it for the same one; the pointer batch that no longer clears the pause; the certify batch and its
// in-batch step-lease fence (lease lost, released, expired, taken over between the preflight and the batch, mode revision moved, wrong run, wrong day,
// no lease at all); idempotent replay and consecutive days; an unreadable column; the certify-only repair `certifyComplete` (control already `doneAt`, yesterday's run,
// pointer advanced, live lease, no Workflow, no control or sync write); `scanOutcome`; and the busy telemetry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as Authority from '../src/discovery-authority.js';
import * as PublishedEpg from '../src/published-epg.js';
import {discoveryAdmission} from '../src/domain/epg-priority-pause.js';
import {madridInstant} from '../src/domain/orchestration-policy.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-run-certificate-'));
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
let databases=0;
let beforeBatch=null,failColumnProbe=false,failCertRead=false;
const options={
 onBatch:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}},
 onQuery:async text=>{if(failColumnProbe&&/col:finalized_run_id/.test(text))throw new Error('D1_ERROR: inventory unavailable');if(failCertRead&&/name='published_epg_authority' AND sql LIKE/.test(text))throw new Error('D1_ERROR: certificate read unavailable');},
};
const migrated=(upTo=26)=>{
 const file=path.join(root,'c-'+(databases++)+'.sqlite');
 const sql='PRAGMA foreign_keys=ON;\n'+files.filter(name=>Number(name.slice(0,4))<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
 const result=sqliteSync(['-bail',file],{input:sql,encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return {file,db:d1Standin(file,options)};
};
const first=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const row=db=>({...db.sql('SELECT state, owed_day_key AS owed, override_day_key AS override FROM discovery_epg_priority WHERE id=1')[0]});
const cert=db=>({...db.sql('SELECT programme_run_id AS run, madrid_run_key AS day, finalized_run_id AS finalized, finalized_at AS at FROM published_epg_authority WHERE id=1')[0]});
const envFor=(db,extra={})=>({DB:db,BUCKET:new MemoryBucket(),discoveryLease:null,...extra});

const realNow=Date.now;
let clock=realNow();
Date.now=()=>clock;
const D1='2026-11-12',D2='2026-11-13',D3='2026-11-14';
const at=(day,h,m=0)=>{clock=madridInstant(day,h,m);return clock;};
const iso=ms=>new Date(ms).toISOString();
const MARGIN=5000;
const setPointer=(db,run,dayKey,pin=run)=>{
 db.sql("UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='"+run+"', madrid_run_key='"+dayKey+"' WHERE id=1");
 db.sql("UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id='"+pin+"', published_programme_run_id='"+pin+"' WHERE id=1");
};
const armed=(upTo=26)=>{const made=migrated(upTo);setPointer(made.db,'run-1',D1);return made;};
const take=(env,context={})=>Authority.acquireLease(env,{programmeRunId:'run-2',...context});
const release=db=>db.sql('UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1');
const programme=run=>({runId:run,updatedAt:'2026-11-13T15:30:00.000Z',watchlistCount:0,films:[]});
const publish=(db,run,key,expected)=>PublishedEpg.publishGeneration({DB:db,BUCKET:new MemoryBucket()},{programmeRunId:run,phase:'published',expectedProgrammeRunId:expected,madridRunKey:key,programme:programme(run),watchlist:{updatedAt:programme(run).updatedAt,films:[]}},{now:0});
// The orchestration documents: a `cloudflare` mode at revision 3 and the step lease the certify batch fences on.
const setMode=db=>db.sql("INSERT OR REPLACE INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{\"schemaVersion\":1,\"mode\":\"cloudflare\",\"epoch\":1}',3,'x')");
const setLease=(db,{holder='h1',modeRevision=3,expiresAt=iso(clock+60000),released=false}={})=>db.sql("INSERT OR REPLACE INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify({schemaVersion:1,holder,kind:'executor',modeRevision,acquiredAt:iso(clock),expiresAt,released})+"',1,'x')");
const step=(extra={})=>({epgFence:{revision:3},step:{holder:'h1',modeRevision:3},leaseBound:iso(clock+MARGIN),now:clock,...extra});
const certify=(db,run,day,extra={})=>PublishedEpg.certifyRun({DB:db},{programmeRunId:run,madridRunKey:day,...step(extra)});
const plain=value=>JSON.parse(JSON.stringify(value));
const refused=(promise,code)=>assert.rejects(promise,error=>error.code===code||new RegExp(code).test(String(error.message)),code);

// 0. The migration file: follows a complete version 25, refuses anything else, adds two NULL columns and sets version 26 (never down).
{
 const old=migrated(24);
 const result=sqliteSync(['-bail',old.file],{input:fs.readFileSync('migrations/0026_epg_run_certificate.sql','utf8'),encoding:'utf8'});
 assert.notEqual(result.status,0,'0026 is refused on a version 24 database');
 assert.equal(Number(first(old.db,'SELECT version FROM schema_contract WHERE id=1')),24,'a refused file changed nothing');
 const {db}=armed();
 assert.equal(Number(first(db,'SELECT version FROM schema_contract WHERE id=1')),26);
 assert.deepEqual({...db.sql('SELECT finalized_run_id AS a, finalized_at AS b FROM published_epg_authority WHERE id=1')[0]},{a:null,b:null},'both columns are NULL after the apply');
 assert.throws(()=>db.sql('UPDATE schema_contract SET version=25 WHERE id=1'),/downgrade/,'the version never goes down');
 assert.match(fs.readFileSync('migrations/README.md','utf8'),/0026_epg_run_certificate\.sql/);
 const runbook=fs.readFileSync('docs/runbooks/epg-run-certificate-0026-apply.md','utf8');
 assert.match(runbook,/Counterexample that must stop the apply/,'the runbook preflight names the pointer-moved, no-lease, stage=seal counterexample');
 assert.match(runbook,/A missing step lease proves nothing/);
 assert.match(runbook,/positively verified terminal or absent/,'the Workflow check is positive: unknown or unreadable status is a stop');
 assert.match(runbook,/is a \*\*stop\*\*, never evidence that no Workflow is alive/);
}

// 1. The column ABSENT (schema 25): today's behaviour, byte for byte. The pointer batch clears the pause, nothing is certified, and a certify writes nothing.
{
 const {db}=armed(25);
 const env=envFor(db);
 const gate=await Authority.readAuthority(env);
 assert.equal(gate.priorityTable,true);
 assert.equal(gate.certColumn,false,'a verified absence');
 at(D2,16,56);
 assert.equal((await take(env,{programmeRunId:'run-1'})).busy.kind,'epg_priority');
 assert.deepEqual(row(db),{state:'paused',owed:D2,override:null});
 db.sql("UPDATE discovery_authority SET programme_run_id='run-2', published_programme_run_id='run-2' WHERE id=1");
 await publish(db,'run-2',D2,'run-1');
 assert.deepEqual(row(db),{state:'clear',owed:null,override:null},'column absent: the pointer batch clears the pause as before ADR 0175');
 at(D2,17,5);
 assert.ok((await take(env)).lease,'column absent: the new id is admitted at the pointer');
 assert.deepEqual(await PublishedEpg.readCertificate({DB:db}),{column:'absent'});
 assert.deepEqual(await certify(db,'run-2',D2),{certified:false,column:'absent'},'a verified-absent column certifies nothing and writes nothing');
}

// 2. The column PRESENT: the pointer batch no longer clears the pause. The new run is `awaiting_complete` until the certify batch.
const pointerPublished=async()=>{
 const made=armed();
 const env=envFor(made.db);
 at(D2,16,56);
 assert.equal((await take(env,{programmeRunId:'run-1'})).busy.kind,'epg_priority');
 made.db.sql("UPDATE discovery_authority SET programme_run_id='run-2', published_programme_run_id='run-2' WHERE id=1");
 await publish(made.db,'run-2',D2,'run-1');
 return {...made,env};
};
{
 const {db,env}=await pointerPublished();
 assert.equal((await Authority.readAuthority(env)).certColumn,true);
 assert.deepEqual(cert(db),{run:'run-2',day:D2,finalized:null,at:null});
 assert.deepEqual(row(db),{state:'paused',owed:D2,override:null},'the pointer batch left the pause closed');
 at(D2,17,5);
 const waiting=await take(env);
 assert.equal(waiting.lease,null);
 assert.equal(waiting.busy.kind,'epg_priority');
 assert.equal(waiting.busy.detail,'awaiting_complete','the pointer names the owed run but it is not certified: the pause says why');
 assert.equal(waiting.busy.owedDayKey,D2);
 // The pure contract agrees, and an absent `certRequired` is today's answer.
 const facts={tablePresent:true,action:'acquire',role:null,nowMs:clock,row:{state:'paused',owedDayKey:D2,overrideDayKey:null},publishedDayKey:D2,publishedProgrammeRunId:'run-2',handoffProgrammeRunId:'run-2',requestedProgrammeRunId:'run-2'};
 assert.equal(discoveryAdmission({...facts,certRequired:true,finalizedRunId:null}).detail,'awaiting_complete');
 assert.equal(discoveryAdmission({...facts,certRequired:true,finalizedRunId:'run-2'}).admit,true);
 assert.equal(discoveryAdmission({...facts,certRequired:true,finalizedRunId:'run-1'}).admit,false,'a certificate of another run proves nothing');
 assert.equal(discoveryAdmission({...facts}).admit,true,'no certRequired: the pointer and the pin are the proof');
 // A pointer replay does not clear it either (the replay branch clears only without the column).
 await publish(db,'run-2',D2,'run-1');
 assert.deepEqual(row(db),{state:'paused',owed:D2,override:null});
 // The EPG role is exempt throughout.
 db.sql('UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1');
 const epg=await Authority.acquireLease(envFor(db),{programmeRunId:null,role:'epg'});
 assert.ok(epg.lease,'the EPG seal step takes the lease while Discovery is refused');
 release(db);
}

// 3. The certify batch: lease fence in the batch, CAS, atomic pause clear, readback.
{
 const {db,env}=await pointerPublished();
 at(D2,17,10);
 setMode(db);
 // no fence or no step: refused, no fence-less fallback, nothing written.
 await refused(PublishedEpg.certifyRun({DB:db},{programmeRunId:'run-2',madridRunKey:D2}),'published_epg_certify_unfenced');
 await refused(PublishedEpg.certifyRun({DB:db},{programmeRunId:'run-2',madridRunKey:D2,epgFence:{revision:3},leaseBound:iso(clock+MARGIN)}),'published_epg_certify_unfenced');
 await refused(PublishedEpg.certifyRun({DB:db},{programmeRunId:'run-2',madridRunKey:D2,step:{holder:'h1',modeRevision:3},leaseBound:iso(clock+MARGIN)}),'published_epg_certify_unfenced');
 assert.equal(cert(db).finalized,null);
 // no lease document at all
 await refused(certify(db,'run-2',D2),'published_epg_fence');
 assert.equal(cert(db).finalized,null,'no lease: nothing written');
 // another holder, released, expired, within the margin, mode revision of the lease moved, fence revision moved
 for(const [name,lease,extra] of [
  ['another holder',{holder:'other'},{}],
  ['released',{released:true},{}],
  ['expired',{expiresAt:iso(clock-1000)},{}],
  ['inside the boundary margin',{expiresAt:iso(clock+MARGIN-1)},{}],
  ['lease under another mode revision',{modeRevision:2},{}],
  ['mode revision moved under the fence',{},{epgFence:{revision:2}}],
 ]){
  setLease(db,lease);
  await refused(certify(db,'run-2',D2,extra),'published_epg_fence');
  assert.deepEqual(cert(db),{run:'run-2',day:D2,finalized:null,at:null},name+': nothing written');
  assert.deepEqual(row(db),{state:'paused',owed:D2,override:null},name+': the pause is untouched');
 }
 // ownership changes between the preflight and the batch: the in-batch fence refuses it (a preceding read could not).
 setLease(db);
 beforeBatch=()=>setLease(db,{holder:'taker'});
 await refused(certify(db,'run-2',D2),'published_epg_fence');
 assert.equal(cert(db).finalized,null,'ownership lost between preflight and certify: nothing written');
 // the wrong run and the wrong day do not match the compare-and-set
 setLease(db);
 await refused(certify(db,'run-9',D2),'published_epg_fence');
 await refused(certify(db,'run-2',D1),'published_epg_fence');
 assert.equal(cert(db).finalized,null);
 // success: the proof and the clear are one batch
 const out=await certify(db,'run-2',D2);
 assert.equal(out.certified,true);
 assert.deepEqual(cert(db),{run:'run-2',day:D2,finalized:'run-2',at:iso(clock)});
 assert.deepEqual(row(db),{state:'clear',owed:null,override:null},'the same batch cleared the pause');
 at(D2,17,11);
 assert.ok((await take(env)).lease,'the new generation is admitted only after the certificate');
 release(db);
 // replay: idempotent, the first time stays
 clock+=60000;setLease(db,{expiresAt:iso(clock+60000)});
 const again=await certify(db,'run-2',D2,{now:clock,leaseBound:iso(clock+MARGIN)});
 assert.equal(again.certified,true);
 assert.equal(cert(db).at,iso(madridInstant(D2,17,10)),'a replay keeps the first certificate time');
 // an unknown result is read back, not assumed: the readback names the stored run
 assert.equal((await PublishedEpg.readCertificate({DB:db})).finalizedRunId,'run-2');
}

// 4. Consecutive days and the reset: A complete, B published, B complete. The pointer move resets the certificate for a different run only.
{
 const {db,env}=await pointerPublished();
 at(D2,17,10);setMode(db);setLease(db);
 await certify(db,'run-2',D2);
 assert.equal(cert(db).finalized,'run-2');
 // next day: run-3 published (pin on run-3 first, as the Discovery sealArchive does)
 at(D3,16,56);
 await take(env,{programmeRunId:'run-2'});
 assert.deepEqual(row(db),{state:'paused',owed:D3,override:null});
 db.sql("UPDATE discovery_authority SET programme_run_id='run-3', published_programme_run_id='run-3' WHERE id=1");
 await publish(db,'run-3',D3,'run-2');
 assert.deepEqual(cert(db),{run:'run-3',day:D3,finalized:null,at:null},'a different run: the pointer UPDATE reset the certificate atomically');
 assert.deepEqual(row(db),{state:'paused',owed:D3,override:null});
 at(D3,17,5);
 assert.equal((await take(env,{programmeRunId:'run-3'})).busy.detail,'awaiting_complete');
 // the old run cannot certify over the new pointer
 setLease(db,{expiresAt:iso(clock+60000)});
 await refused(certify(db,'run-2',D2,{now:clock,leaseBound:iso(clock+MARGIN)}),'published_epg_fence');
 // B certifies; a same-run replay of the pointer keeps the certificate
 const out=await certify(db,'run-3',D3,{now:clock,leaseBound:iso(clock+MARGIN)});
 assert.equal(out.certified,true);
 await publish(db,'run-3',D3,'run-2');
 assert.equal(cert(db).finalized,'run-3','a same-run pointer replay does not reset the certificate');
 assert.deepEqual(row(db),{state:'clear',owed:null,override:null});
 assert.ok((await take(env,{programmeRunId:'run-3'})).lease);
 release(db);
}

// 5. Cross-day: an adopted yesterday seal is stamped with its frozen day. Its certificate does not clear today's pause.
{
 const {db,env}=armed();
 setPointer(db,'run-1',D1);
 const made={db,env:envFor(db)};
 at(D2,17,0);
 await take(made.env,{programmeRunId:'run-1'});
 assert.deepEqual(row(db),{state:'paused',owed:D2,override:null});
 db.sql("UPDATE discovery_authority SET programme_run_id='run-2', published_programme_run_id='run-2' WHERE id=1");
 await publish(db,'run-2',D1,'run-1');
 setMode(db);setLease(db);
 const out=await certify(db,'run-2',D1);
 assert.equal(out.certified,true);
 assert.deepEqual(row(db),{state:'paused',owed:D2,override:null},'yesterday\'s certificate does not clear today\'s pause');
 assert.equal((await take(made.env,{programmeRunId:'run-2'})).busy.kind,'epg_priority');
}

// 6. The column is detected in the same inventory query as the other gate tables (no extra D1 call). If that inventory cannot be read, the whole gate read fails
// as the existing `discovery_unavailable`: nothing is admitted for any role, which is today's failure class for an unreadable D1.
{
 const {db}=armed();
 failColumnProbe=true;
 at(D2,10,0);
 await assert.rejects(Authority.readAuthority(envFor(db)),/discovery_unavailable/);
 await assert.rejects(take(envFor(db),{programmeRunId:'run-1'}),/discovery_unavailable/,'an unreadable inventory admits nothing');
 failColumnProbe=false;
 assert.equal((await Authority.readAuthority(envFor(db))).certColumn,true,'one inventory query reports the column');
 assert.equal((await Authority.readAuthority(envFor(armed(25).db))).certColumn,false);
}

// 7. The certify-only repair `certifyComplete` of the hourly `ensure`. It bypasses no Workflow gate: it is not on that path at all.
const orchestration=fs.readFileSync('src/epg-orchestration.js','utf8');
function load({db,sync}){
 const state={sync,calls:[]};
 const context=vm.createContext({console,Date,Math,JSON,Promise,Intl,URL,crypto:webcrypto});
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy'),context);
 context.loadJSON=async(env,key)=>key==='sync.json'&&state.sync?JSON.parse(JSON.stringify(state.sync)):null;
 context.saveJSON=async()=>{state.calls.push('saveJSON');};
 context.postSync=async(...args)=>{state.calls.push('postSync');return {status:200,json:async()=>({})};};
 context.PublishedEpg={...PublishedEpg,repairMirrors:async()=>({mirrored:true,aligned:true,wrote:false})};
 vm.runInContext(orchestration,context);
 const creates=[];
 const env={DB:db,EPG_WORKFLOW:{async create(args){creates.push(args);},async get(){throw new Error('not found');}}};
 return {state,env,creates,epg:vm.runInContext('EpgOrchestration',context)};
}
const completeRun=(run,day,extra={})=>({runId:run,stage:'complete',runKey:day,startedAt:iso(madridInstant(day,16,56)),completedAt:iso(madridInstant(day,17,20)),updatedAt:iso(madridInstant(day,17,20)),...extra});
const controlDone=(db,day)=>db.sql("INSERT OR REPLACE INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('control','"+JSON.stringify({schemaVersion:1,runKey:day,series:0,instanceId:'i',phase:'done',doneAt:iso(clock),publishedRunId:'run-2',budget:{consecutive:0,total:0}})+"',7,'x')");
const docs=db=>JSON.stringify(db.sql("SELECT key, body, revision FROM epg_orchestration_document WHERE key IN ('mode','control') ORDER BY key"));
{
 // Same day: sync.json complete, control already `doneAt`, no seal handoff, the certificate missing.
 const {db}=await pointerPublished();
 at(D2,18,1);setMode(db);controlDone(db,D2);
 const {state,env,creates,epg}=load({db,sync:completeRun('run-2',D2)});
 const control=docs(db);
 const out=await epg.certifyComplete(env,{now:clock});
 assert.equal(out.ran,true);assert.equal(out.certified,true);assert.equal(out.reason,'certified');
 assert.equal(cert(db).finalized,'run-2');
 assert.deepEqual(row(db),{state:'clear',owed:null,override:null});
 assert.equal(docs(db),control,'the control document (doneAt, publishedRunId) and the mode document are byte for byte as they were');
 assert.deepEqual(plain(state.calls),[],'no sync.json write, no sync start, no seal step');
 assert.deepEqual(plain(creates),[],'no Workflow instance is created');
 assert.equal(first(db,"SELECT COUNT(*) FROM epg_orchestration_document WHERE key='lease' AND json_extract(body,'$.released')=1"),1,'the step lease is released');
 // certified already: nothing to do, no lease taken
 assert.deepEqual(plain(await epg.certifyComplete(env,{now:clock})),{ran:false,reason:'certified'});
}
{
 // Yesterday's complete run after Madrid midnight: the pointer still names it. Repaired with no `day_rolled` gate.
 const {db}=armed();
 setPointer(db,'run-2',D2);
 db.sql("INSERT OR REPLACE INTO discovery_epg_priority (id,state,owed_day_key,override_day_key) VALUES (1,'paused','"+D2+"',NULL)");
 at(D3,3,0);setMode(db);controlDone(db,D2);
 const {env,epg,creates,state}=load({db,sync:completeRun('run-2',D2)});
 const out=await epg.certifyComplete(env,{now:clock});
 assert.equal(out.certified,true,'a previous-day run is certified under its frozen day');
 assert.equal(cert(db).finalized,'run-2');
 assert.deepEqual(plain(creates),[]);assert.deepEqual(plain(state.calls),[]);
}
{
 // Stale or contradicting evidence does nothing: the pointer advanced, another run in sync.json, another day, a missing receipt, an unproven pointer.
 const {db}=await pointerPublished();
 at(D2,18,1);setMode(db);
 for(const [name,sync] of [
  ['sync.json names another run',completeRun('run-1',D1)],
  ['sync.json is not complete',{...completeRun('run-2',D2),stage:'seal'}],
  ['frozen day contradicts the pointer day',completeRun('run-2',D1,{runKey:D1})],
  ['no receipt',completeRun('run-2',D2,{completedAt:null,updatedAt:null})],
  ['no sync.json',null],
 ]){
  const {env,epg}=load({db,sync});
  const out=await epg.certifyComplete(env,{now:clock});
  assert.equal(out.ran,false,name+': does nothing');
  assert.equal(cert(db).finalized,null,name+': no certificate');
 }
 db.sql("UPDATE published_epg_authority SET programme_run_id='run-9' WHERE id=1");
 const {env,epg}=load({db,sync:completeRun('run-2',D2)});
 assert.equal((await epg.certifyComplete(env,{now:clock})).ran,false,'the pointer advanced: nothing is certified and nothing is re-run');
 db.sql("UPDATE published_epg_authority SET programme_run_id='run-2' WHERE id=1");
 // A live step lease (a Workflow step) is waited for, never raced.
 setLease(db,{holder:'workflow',expiresAt:iso(clock+120000)});
 const busy=load({db,sync:completeRun('run-2',D2)});
 const waited=await busy.epg.certifyComplete(busy.env,{now:clock});
 assert.equal(waited.ran,false);assert.equal(waited.reason,'step_lease_held');
 assert.equal(cert(db).finalized,null);
 // mode external: not this unit's business
 db.sql("UPDATE epg_orchestration_document SET body='{\"schemaVersion\":1,\"mode\":\"external\",\"epoch\":1}' WHERE key='mode'");
 setLease(db,{expiresAt:iso(clock-1),released:true});
 const external=load({db,sync:completeRun('run-2',D2)});
 assert.equal((await external.epg.certifyComplete(external.env,{now:clock})).ran,false);
}
{
 // The lease is lost between the cheap check and the batch: the in-batch fence refuses, the unit reports it and retries on the next tick.
 const {db}=await pointerPublished();
 at(D2,18,1);setMode(db);
 const {env,epg}=load({db,sync:completeRun('run-2',D2)});
 beforeBatch=()=>db.sql("UPDATE epg_orchestration_document SET body=json_set(body,'$.holder','taker') WHERE key='lease'");
 const out=await epg.certifyComplete(env,{now:clock});
 assert.equal(out.ran,true);assert.equal(out.certified,false);assert.equal(out.reason,'published_epg_fence');
 assert.equal(cert(db).finalized,null,'lost lease: nothing written, still owed');
 db.sql("DELETE FROM epg_orchestration_document WHERE key='lease'");
 const retry=await epg.certifyComplete(env,{now:clock});
 assert.equal(retry.certified,true,'the next tick certifies');
 // ensure reports a repair that happened or could not, and stays unchanged for an idle tick
 const idle=await epg.ensure(env,{now:clock});
 assert.equal('certificate' in idle,false,'an idle tick keeps the ensure result unchanged');
}
{
 // The column absent: the repair does nothing.
 const {db}=armed(25);
 setPointer(db,'run-2',D2);
 at(D2,18,1);
 db.sql("INSERT OR REPLACE INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{\"schemaVersion\":1,\"mode\":\"cloudflare\",\"epoch\":1}',3,'x')");
 const {env,epg}=load({db,sync:completeRun('run-2',D2)});
 assert.deepEqual(plain(await epg.certifyComplete(env,{now:clock})),{ran:false,reason:'column_absent'});
}

{
 // Persistent certificate debt stays visible in the hourly `ensure` result, with the age from the durable completion receipt; an idle tick stays quiet.
 const {db}=await pointerPublished();
 at(D2,18,1);setMode(db);controlDone(db,D2);
 const {env,epg}=load({db,sync:completeRun('run-2',D2)});
 const receipt=madridInstant(D2,17,20);
 // repeated D1 outage after sync.json is complete: unreadable evidence, reported each tick, no throw, no failure budget touched
 failCertRead=true;
 for(let tick=0;tick<2;tick++){
  const out=plain(await epg.ensure(env,{now:clock}));
  assert.equal(out.certificate.unreadable,true,'an unreadable certificate is reported, not discarded');
  assert.equal(out.certificate.reason,'d1_unavailable');
  assert.equal(out.certificate.ran,false);
  clock+=60*60000;
 }
 failCertRead=false;
 at(D2,18,1);
 // a certify batch that fails (the lease is taken over before it): a proven debt with its age, the closed code, no payload
 beforeBatch=()=>db.sql("UPDATE epg_orchestration_document SET body=json_set(body,'$.holder','taker') WHERE key='lease'");
 const failed=plain(await epg.ensure(env,{now:clock}));
 assert.equal(failed.certificate.owed,true);
 assert.equal(failed.certificate.ageMs,clock-receipt,'the age is counted from the durable completion receipt');
 assert.equal(failed.certificate.certified,false);
 assert.equal(failed.certificate.reason,'published_epg_fence');
 assert.deepEqual(Object.keys(failed.certificate).sort(),['ageMs','certified','owed','ran','reason']);
 assert.equal(cert(db).finalized,null);
 // a live step lease also carries the debt and its age
 setLease(db,{holder:'workflow',expiresAt:iso(clock+120000)});
 const waiting=plain(await epg.certifyComplete(env,{now:clock}));
 assert.equal(waiting.reason,'step_lease_held');assert.equal(waiting.owed,true);assert.equal(waiting.ageMs,clock-receipt);
 db.sql("DELETE FROM epg_orchestration_document WHERE key='lease'");
 // certified: the debt is gone and the idle tick is quiet again
 assert.equal(plain(await epg.ensure(env,{now:clock})).certificate.certified,true);
 assert.equal('certificate' in plain(await epg.ensure(env,{now:clock})),false,'nothing owed: the idle tick keeps the result unchanged');
}

{
 // A malformed mode document is unreadable evidence, reported and never written on. A verified unconfigured mode and the external mode stay quiet.
 const {db}=await pointerPublished();
 at(D2,18,1);
 db.sql("INSERT OR REPLACE INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{\"schemaVersion\":1,\"mode\":\"bogus\",\"epoch\":1}',3,'x')");
 const {env,epg}=load({db,sync:completeRun('run-2',D2)});
 const malformed=plain(await epg.certifyComplete(env,{now:clock}));
 assert.deepEqual(malformed,{ran:false,unreadable:true,reason:'mode_unreadable'});
 assert.equal(plain(await epg.ensure(env,{now:clock})).certificate.reason,'mode_unreadable','the hourly result keeps the warning');
 assert.equal(cert(db).finalized,null,'no certificate write on malformed evidence');
 assert.equal(first(db,"SELECT COUNT(*) FROM epg_orchestration_document WHERE key='lease'"),0,'no step lease is taken');
 db.sql("DELETE FROM epg_orchestration_document WHERE key='mode'");
 assert.deepEqual(plain(await epg.certifyComplete(env,{now:clock})),{ran:false,reason:'not_owed'},'a verified unconfigured mode stays quiet');
 db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{\"schemaVersion\":1,\"mode\":\"external\",\"epoch\":1}',4,'x')");
 assert.deepEqual(plain(await epg.certifyComplete(env,{now:clock})),{ran:false,reason:'not_owed'},'the external mode stays quiet');
}

// 8. Structure: the Worker certifies after the durable complete save and before the event flushes; the repair is not on the Workflow gates; a
// certify failure never stops the flushes; scanOutcome and the busy telemetry exist; the pointer batch clears the pause only without the column.
{
 const worker=fs.readFileSync('src/worker.js','utf8');
 const queue=worker.slice(worker.indexOf('async function sealQueueStep'),worker.indexOf('// ADR 0074, ADR 0161'));
 const save=queue.indexOf("await saveJSON(env,'sync.json',run);\n // ADR 0175");
 assert.ok(save>0,'the complete save comes first');
 assert.ok(queue.indexOf('certifyCompletedRun(env,run)')>save,'certify follows the durable complete save');
 assert.ok(queue.indexOf('certifyCompletedRun(env,run)')<queue.indexOf('flushEpgEvent(env,run)'),'certify precedes the event flushes');
 const certifier=worker.slice(worker.indexOf('async function certifyCompletedRun'),worker.indexOf('async function sealQueueStep'));
 assert.match(certifier,/catch\(error\)\{[\s\S]*return 'owed'/,'a certify failure is caught: the flushes still run');
 assert.match(certifier,/env\.epgStep/,'no lease, no certificate');
 for(const outcome of ['applied','facts_only','skipped_incomplete_watchlist','skipped_no_observation'])assert.match(worker,new RegExp("scanOutcome="+"[^;]*'"+outcome+"'|run\\.scanOutcome='"+outcome+"'"),'scanOutcome '+outcome);
 for(const field of ['holderKind','holdExpiry','scheduledWaitMs','sealPhase'])assert.match(worker,new RegExp(field+'[:,]'),'busy telemetry '+field);
 const orch=fs.readFileSync('src/epg-orchestration.js','utf8');
 const certifyBody=orch.slice(orch.indexOf('async function certifyComplete'),orch.indexOf('// ---- the cron `ensure`'));
 assert.doesNotMatch(certifyBody,/ensureWorkflow|\bact\(|drive\(|createSuccessor|EPG_WORKFLOW|casDoc\(env,'control'|saveJSON|postSync/,'the repair never schedules, drives, writes control or sync');
 const published=fs.readFileSync('src/published-epg.js','utf8');
 assert.match(published,/paused&&!cert\?\[\[PAUSE_CLEAR_SQL/,'the pointer batch clears the pause only without the column');
 assert.match(published,/json_extract\(body,'\$\.holder'\)=\?/,'the lease holder is checked inside the certify batch');
 assert.doesNotMatch(published.slice(published.indexOf('export async function certifyRun'),published.indexOf('export async function publishGeneration')),/epgFenceStatements\(null\)|fence==null\?\[\]/,'no fence-less fallback');
}

Date.now=realNow;
console.log('epg run certificate ok');
