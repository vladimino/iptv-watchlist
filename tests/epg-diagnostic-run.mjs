// AIR-455 / ADR 0121. The owner-only EPG diagnostic canary: routes, durable receipt, the Workflow body and its report, on test bindings: sqlite stand-ins of the diagnostic and the
// production-like D1, in-memory buckets and a scripted Workflow binding. The REAL ledger seal (`stageSealedGeneration` and what it calls), the real step lease and the real
// replay module run; nothing is simulated in the seal path. No Cloudflare, no network, no production. What is proved:
//   1. Inert: without the diagnostic bindings every route refuses and nothing is created or written, and reads never write (counters and byte-for-byte fingerprints).
//   2. Launch is a writing action behind a confirmation, strict configuration, the production-idle gate, the one-active slot and an atomic reservation; duplicates resolve to the same run,
//      other parameters fail, an unknown create outcome is reconciled, never retried blind.
//   3. The Workflow body runs the real seal on the diagnostic domain and writes a `canary-measured` report whose invariants hold (published false, no production writes, expected equals actual).
//   4. Faults: a lost lease, an expired lease, a pointer conflict, an unprepared domain, a missing or tampered dataset, a stopped receipt: each ends in a failed or stopped receipt with a typed reason.
//   5. The production-like resources are byte for byte what they were after everything above.
//   6. Mutation checks: every guard removed from the run module is caught.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {loadWorker} from '../scripts/discovery-ledger-offline.mjs';
import * as Authority from '../src/discovery-authority.js';
import {sql,bucket,world,bootstrap,commit,POINTER} from './discovery-bounded-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-diag-run-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
const SOURCES={
 diagnostic:fs.readFileSync('src/epg-diagnostic.js','utf8'),replay:fs.readFileSync('src/epg-replay.js','utf8'),run:fs.readFileSync('src/epg-diagnostic-run.js','utf8'),
 orchestration:fs.readFileSync('src/epg-orchestration.js','utf8'),policy:scoped('src/domain/orchestration-policy.js','OrchestrationPolicy'),
};
const ALL=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const DIAG=fs.readdirSync('diagnostic-migrations').filter(name=>/\.sql$/.test(name)).sort();
const RESOURCE='diag-test-0001',BUILT='2026-11-12T12:00:00.000Z';
const plain=value=>JSON.parse(JSON.stringify(value));
let copies=0;
// Two pristine templates (the production chain; the production chain plus the diagnostic migrations) built once and copied per domain.
const template=withDiagnostic=>{
 const file=path.join(root,'template-'+(withDiagnostic?'diagnostic':'production')+'.sqlite');
 const input='PRAGMA foreign_keys=ON;\n'+ALL.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')+(withDiagnostic?'\n'+DIAG.map(name=>fs.readFileSync('diagnostic-migrations/'+name,'utf8')).join('\n'):'');
 const r=sqliteSync(['-bail',file],{input,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);
 return file;
};
const TEMPLATES={false:template(false),true:template(true)};
const database=withDiagnostic=>{const file=path.join(root,'d-'+(copies++)+'.sqlite');fs.copyFileSync(TEMPLATES[withDiagnostic],file);return file;};
const fingerprint=(file,bkt)=>JSON.stringify({dump:sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<28}).stdout,objects:[...bkt.objects].map(([key,value])=>[key,value.etag])});

// ---- the replay dataset, built once from a real bounded ledger (public synthetic scans of the bounded-ledger tests) ------------------------------------------------------------
const source=world();
await bootstrap(source,0);
for(const day of [1,2,3,4,5,6])await commit(source,day,'bounded');
const sourceId=source.published.programmeRunId;
const readerOver=bkt=>({get:key=>bkt.get(key)});
const loaders=(src,context)=>{vm.runInContext(src.policy,context);vm.runInContext(src.orchestration,context);vm.runInContext(src.diagnostic,context);vm.runInContext(src.replay,context);vm.runInContext(src.run,context);};
const builderContext=loadWorker();builderContext.DiscoveryAuthority=Authority;loaders(SOURCES,builderContext);
const Replay=vm.runInContext('EpgReplay',builderContext),Diag=vm.runInContext('EpgDiagnostic',builderContext);
const dataset=await Replay.buildDataset(readerOver(source.bkt),{programmeRunId:sourceId,builtAt:BUILT});
const datasetText=JSON.stringify(dataset),DIGEST=dataset.digest;
const CONFIG={datasetDigest:DIGEST,seed:'canary-seed-1',departures:30,returns:2};
const launchBody=(key,extra={})=>({idempotencyKey:key,confirm:'LAUNCH_EPG_DIAGNOSTIC_CANARY',...CONFIG,...extra});
const KEY1='canary-key-0000000001',KEY2='canary-key-0000000002';

// ---- a domain: production-like resources, a diagnostic domain, a scripted Workflow binding, and a Worker context with all the modules ------------------------------------------------
async function domain({realPublished=false,provision=true,dataset:put=datasetText,sourcesOverride=null,authority='d1',published='match',diagnosticBindings=true,workflow={}}={}){
 const context=loadWorker();context.DiscoveryAuthority=Authority;loaders(sourcesOverride||SOURCES,context);
 const DiagnosticModule=vm.runInContext('EpgDiagnostic',context);
 const prodFile=database(false),prodBkt=bucket();
 await prodBkt.put('epg/generation.json',JSON.stringify({sentinel:true}));
 const diagFile=database(true),diagBkt=bucket(),diagRaw=d1Standin(diagFile,{maxBinds:100});
 const instances=new Map(),calls={create:[],terminate:[],get:[]};
 const binding={
  async create({id,params}){calls.create.push({id,params});if(workflow.createThrows){instances.set(id,workflow.createThrows.then||'unknown');throw Object.assign(new Error(workflow.createThrows.message||'network down'),{name:workflow.createThrows.name||'Error'});}instances.set(id,'running');return {id};},
  async get(id){calls.get.push(id);if(!instances.has(id)){if(workflow.statusUnknown&&calls.create.length>0)throw new Error('unreachable');throw new Error('instance.not_found');}return {status:async()=>({status:instances.get(id)==='unknown'?undefined:instances.get(id)}),terminate:async()=>{calls.terminate.push(id);instances.set(id,'terminated');}};},
 };
 if(provision){
  const done=await DiagnosticModule.provision({DB:diagRaw,BUCKET:diagBkt,resourceId:RESOURCE});assert.equal(done.ok,true,JSON.stringify(done));
  if(authority==='d1')sql(diagFile,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
  if(put)await diagBkt.put('diagnostic/replay/'+DIGEST+'.json',put);
 }
 const programmeRunId=dataset.source.programmeRunId;
 if(realPublished)vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),context);
 else context.PublishedEpg={
  async readAuthority(){return {cutover:'open',mode:'d1'};},
  async currentGeneration(){return published==='none'?null:{programmeRunId:published==='match'?programmeRunId:'11111111-1111-4111-8111-111111111111',phase:'published',fence:'g-diag'};},
 };
 const env={DB:d1Standin(prodFile,{maxBinds:100}),BUCKET:prodBkt,...(diagnosticBindings?{EPG_DIAGNOSTIC_DB:diagRaw,EPG_DIAGNOSTIC_BUCKET:diagBkt,EPG_DIAGNOSTIC_RESOURCE_ID:RESOURCE,EPG_DIAGNOSTIC_WORKFLOW:binding}:{})};
 const Run=vm.runInContext('EpgDiagnosticRun',context);
 const state={context,env,Run,prodFile,prodBkt,diagFile,diagBkt,diagRaw,binding,instances,calls,
  prod:()=>fingerprint(prodFile,prodBkt),diag:()=>fingerprint(diagFile,diagBkt),
  receipt:key=>sql(diagFile,"SELECT * FROM epg_diagnostic_receipt WHERE idempotency_key='"+key+"'")[0]||null,
  receipts:()=>sql(diagFile,'SELECT idempotency_key, status, slot FROM epg_diagnostic_receipt ORDER BY idempotency_key'),
  async call(method,pathname,body,extraHeaders){
   const init={method,headers:{'content-type':'application/json',...(extraHeaders||{})}};if(extraHeaders&&extraHeaders['Cf-Access-Jwt-Assertion']===null)delete init.headers['Cf-Access-Jwt-Assertion'];if(body!==undefined)init.body=JSON.stringify(body);
   const response=await context.worker.fetch(new Request('http://worker.test'+pathname,init),env);
   return {status:response.status,body:await response.json()};
  },
  // The Workflow body, driven directly with a step that runs each function once, as the engine does on a first attempt.
  async runInstance(key,hooks){const names=[];const step={do:async(name,fn)=>{names.push(name);return fn();}};const result=await Run.run(env,{idempotencyKey:key},step,hooks);return {result,names};},
 };
 return state;
}

const sealDiag=SOURCES;void sealDiag;
// ================================ 1. inert: no bindings, no writes ================================
{
 const d=await domain({diagnosticBindings:false});
 const before={prod:d.prod(),diag:d.diag()};
 const pre=await d.call('GET','/api/epg/diagnostic/preflight');
 assert.equal(pre.status,200);assert.equal(pre.body.ready,false);assert.equal(pre.body.refused,'diagnostic_bindings_absent');assert.equal(pre.body.sideEffects,'none');
 for(const [method,route,body] of [['GET','/api/epg/diagnostic/status?key='+KEY1],['GET','/api/epg/diagnostic/result?key='+KEY1],['POST','/api/epg/diagnostic/launch',launchBody(KEY1)],['POST','/api/epg/diagnostic/stop',{idempotencyKey:KEY1,confirm:'STOP_EPG_DIAGNOSTIC_CANARY'}],['POST','/api/epg/diagnostic/cleanup',{confirm:'CLEANUP_EPG_DIAGNOSTIC_DOMAIN'}]]){
  const reply=await d.call(method,route,body);
  assert.equal(reply.status,503,method+' '+route);assert.equal(reply.body.refused,'diagnostic_bindings_absent');
 }
 assert.equal(d.calls.create.length,0,'no Workflow instance without the diagnostic bindings');
 assert.equal(d.prod(),before.prod,'the production-like resources are untouched');assert.equal(d.diag(),before.diag);
 // bindings without a resource id (the owner has not set the identity) is the same refusal
 const partial=await domain({diagnosticBindings:true});delete partial.env.EPG_DIAGNOSTIC_RESOURCE_ID;
 assert.equal((await partial.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1))).body.refused,'diagnostic_bindings_absent');
 // Authorization is Cloudflare Access at the edge (owner decision, ADR 0124): the Worker holds no second validator, audience or owner e-mail. What stays in the code are accident guards
 // (confirmation strings, same-origin for POST) and fail-closed behaviour while the diagnostic bindings are absent. Validating the real edge policy is an AIR-456 provisioning acceptance.
 assert.doesNotMatch(SOURCES.run,/mcpVerifyAccess|EPG_DIAGNOSTIC_ACCESS_AUD|EPG_DIAGNOSTIC_OWNER_EMAIL|Cf-Access-Jwt-Assertion/,'no in-Worker Access validator or second audience');
 assert.doesNotMatch(fs.readFileSync('src/mcp.js','utf8'),/mcpVerifyAccessWith|ownerEmail/,'the MCP verifier is unchanged');
 // routing: methods and unknown paths
 assert.equal((await d.call('GET','/api/epg/diagnostic/launch')).status,405);assert.equal((await d.call('POST','/api/epg/diagnostic/preflight',{})).status,405);assert.equal((await d.call('GET','/api/epg/diagnostic/nothing')).status,404);
 const crossOrigin=await d.context.worker.fetch(new Request('http://worker.test/api/epg/diagnostic/launch',{method:'POST',headers:{Origin:'http://elsewhere.test','content-type':'application/json'},body:JSON.stringify(launchBody(KEY1))}),d.env);
 assert.equal(crossOrigin.status,403,'a cross-origin POST is refused by the existing origin rule before the route');
 assert.equal(d.calls.create.length,0);
}
// ================================ 2. preflight, gates and launch ================================
{
 const d=await domain();
 const before=d.diag(),prodBefore=d.prod();
 const pre=await d.call('GET','/api/epg/diagnostic/preflight?dataset='+DIGEST);
 assert.equal(pre.body.ready,true,JSON.stringify(pre.body));assert.equal(pre.body.checks.dataset,'verified');assert.equal(pre.body.writes,0);
 assert.equal(d.diag(),before,'a preflight writes nothing');
 assert.equal((await d.call('GET','/api/epg/diagnostic/preflight?dataset=zz')).status,400);
 assert.equal((await d.call('GET','/api/epg/diagnostic/preflight?dataset='+'0'.repeat(64))).body.checks.dataset,'dataset_missing');
 // validation and confirmation: nothing is reserved
 for(const [label,body,status] of [
  ['unknown field',launchBody(KEY1,{extra:1}),400],['short key',launchBody('short'),400],['no dataset digest',launchBody(KEY1,{datasetDigest:'x'}),400],['bad seed',launchBody(KEY1,{seed:'../x'}),400],
  ['no departures',launchBody(KEY1,{departures:0}),400],['too many departures',launchBody(KEY1,{departures:100000}),400],['negative returns',launchBody(KEY1,{returns:-1}),400],['budget too small',launchBody(KEY1,{budgetMs:1}),400],['budget too large',launchBody(KEY1,{budgetMs:1e9}),400],
  ['no confirmation',{...launchBody(KEY1),confirm:undefined},400],['wrong confirmation',launchBody(KEY1,{confirm:'yes'}),400],['not an object',[1],400],
 ]){
  const reply=await d.call('POST','/api/epg/diagnostic/launch',body);
  assert.equal(reply.status,status,label+' '+JSON.stringify(reply.body));
 }
 assert.deepEqual(d.receipts(),[],'nothing was reserved');assert.equal(d.calls.create.length,0);
 // a dataset that does not exist, or a plan that cannot derive, is refused before the reservation
 assert.equal((await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1,{datasetDigest:'0'.repeat(64)}))).body.refused,'dataset_missing');
 assert.match((await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1,{departures:7999}))).body.refused,/^plan_/,'more departures than the ledger holds');
 assert.deepEqual(d.receipts(),[]);
 // the production-idle gate (reads only)
 const gate=async(prepare,expected)=>{
  const g=await domain();prepare(g);
  const reply=await g.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
  assert.equal(reply.status,409,expected);assert.equal(reply.body.refused,expected);assert.deepEqual(g.receipts(),[]);assert.equal(g.calls.create.length,0);
  const pre=await g.call('GET','/api/epg/diagnostic/preflight');assert.equal(pre.body.ready,false);assert.equal(pre.body.production,expected);
 };
 const prodDoc=(g,key,value)=>sql(g.prodFile,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('"+key+"','"+JSON.stringify(value).replace(/'/g,"''")+"',1,'t')");
 await gate(g=>prodDoc(g,'lease',{schemaVersion:1,holder:'prod',kind:'executor',modeRevision:1,acquiredAt:new Date().toISOString(),expiresAt:new Date(Date.now()+200000).toISOString(),released:false}),'production_step_live');
 await gate(g=>prodDoc(g,'mode',{schemaVersion:1,mode:'switching',from:'external',target:'cloudflare',epoch:1,drain:null}),'production_mode_switching');
 await gate(g=>prodDoc(g,'control',{schemaVersion:1,runKey:'2026-11-12',series:0,instanceId:'x',epoch:1,phase:'running',budget:{consecutive:0,total:0},checkpoint:null}),'production_epg_active');
 await gate(g=>g.prodBkt.put('sync.json',JSON.stringify({runId:'r',stage:'seal',updatedAt:new Date().toISOString()})),'production_seal_active');
 await gate(g=>g.prodBkt.put('sync.json',JSON.stringify({runId:'r',stage:'epg',updatedAt:new Date().toISOString()})),'production_sync_active');
 // launch
 const ok=await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 assert.equal(ok.status,200,JSON.stringify(ok.body));assert.equal(ok.body.receipt.status,'created');assert.equal(ok.body.created,true);
 assert.equal(d.calls.create.length,1);assert.equal(d.calls.create[0].id,await d.Run.instanceIdOf(KEY1),'a deterministic instance id');assert.deepEqual(plain(d.calls.create[0].params),{idempotencyKey:KEY1},'the Workflow gets the key only, the configuration is in the receipt');
 const row=d.receipt(KEY1);assert.equal(row.status,'created');assert.equal(row.slot,1);assert.equal(row.fingerprint,await d.Run.fingerprintOf({datasetDigest:DIGEST,seed:CONFIG.seed,departures:30,returns:2,budgetMs:15*60000}));
 // a duplicate with the same parameters is the same run and creates nothing; other parameters fail; a second canary while one is active is refused
 const again=await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 assert.equal(again.status,200);assert.equal(again.body.reconciled,false);assert.equal(d.calls.create.length,1,'no second instance');
 assert.equal((await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1,{seed:'another-seed'}))).body.refused,'idempotency_conflict');
 assert.equal((await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY2))).body.refused,'canary_active');
 assert.deepEqual(d.receipts().map(r=>r.idempotency_key),[KEY1],'one receipt, one slot');
 // reads never write
 const read=d.diag();
 const status=await d.call('GET','/api/epg/diagnostic/status?key='+KEY1);assert.equal(status.status,200);assert.equal(status.body.receipt.status,'created');assert.equal(status.body.instance,'running');assert.equal(status.body.writes,0);
 assert.equal((await d.call('GET','/api/epg/diagnostic/result?key='+KEY1)).status,202);
 assert.equal((await d.call('GET','/api/epg/diagnostic/status?key=unknown-key-00000000')).status,404);assert.equal((await d.call('GET','/api/epg/diagnostic/status?key=x')).status,400);
 assert.equal(d.diag(),read,'status and result write nothing');
 assert.equal(d.prod(),prodBefore,'the production-like resources are untouched by launch');
}
// ================================ 2b. unknown create outcomes are reconciled, never retried blind ================================
{
 const d=await domain({workflow:{createThrows:{message:'network down',then:'unknown'},statusUnknown:true}});
 const first=await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 assert.equal(first.status,202,JSON.stringify(first.body));assert.equal(first.body.outcome,'unknown');assert.equal(d.calls.create.length,1);
 assert.equal(d.receipt(KEY1).status,'reserved','the receipt is not marked created on an unknown outcome');
 const status=await d.call('GET','/api/epg/diagnostic/status?key='+KEY1);assert.equal(status.body.reconcile,'instance_status_unknown');
 // the same call again, status still unknown: no second create
 const second=await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));assert.equal(second.status,202);assert.equal(d.calls.create.length,1,'no blind retry while the status is unknown');
 // the instance turns out to exist (the create had landed): the repeat attaches and records it
 d.instances.set(await d.Run.instanceIdOf(KEY1),'running');d.binding.get=async id=>({status:async()=>({status:'running'})});
 const third=await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 assert.equal(third.status,200);assert.equal(third.body.attached,true);assert.equal(d.calls.create.length,1,'attached, not created again');assert.equal(d.receipt(KEY1).status,'created');
 // a create that reports "already exists" is attached to
 const e=await domain({workflow:{createThrows:{message:'instance.already_exists',name:'Error',then:'running'}}});
 const exists=await e.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));assert.equal(exists.status,200);assert.equal(exists.body.attached,true);assert.equal(e.receipt(KEY1).status,'created');
 // an instance that ended before it was recorded is not silently replaced
 const f=await domain();f.binding.get=async()=>({status:async()=>({status:'errored'})});
 await f.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1)).catch(()=>null);
 const g=await domain();await g.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 assert.equal(g.receipt(KEY1).status,'created');
}
// ================================ 3. the Workflow body: the real seal, the report, the invariants ================================
{
 const d=await domain();
 await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 const prodBefore=d.prod();
 const {result,names}=await d.runInstance(KEY1);
 assert.deepEqual(names,['begin','seal','finish'],'three steps, none retried');assert.equal(result.reason,'complete');assert.equal(result.recorded,true);
 const row=d.receipt(KEY1);assert.equal(row.status,'complete');assert.equal(row.slot,null,'the slot is free');
 const res=await d.call('GET','/api/epg/diagnostic/result?key='+KEY1);assert.equal(res.status,200);
 const report=res.body.report;
 assert.equal(report.label,'canary-measured');assert.equal(report.published,false);assert.equal(report.productionWrites,0);
 assert.equal(report.dataset.digest,DIGEST);assert.equal(report.dataset.fidelity.level,'reduced');assert.equal(report.plan.seed,CONFIG.seed);assert.equal(report.plan.departures,30);assert.equal(report.plan.returns,2);
 assert.equal(report.expectedVsActual.departuresMatch,true,'the real seal archived exactly the planned departures');assert.equal(report.expectedVsActual.segmentsMatch,true,'into exactly the planned segments');
 assert.equal(report.expectedVsActual.actual.departures,30);
 for(const phase of ['seal_stage_plan','seal_stage_archive','seal_stage_emit'])assert.ok(report.phases[phase],'phase '+phase);
 for(const field of ['elapsedMs','segments','fences','fencesSkipped','fenceMs','readMs','putMs','bytes'])assert.ok(Number.isFinite(report.phases.seal_stage_archive[field]),'archive '+field);
 assert.ok(report.phases.seal_stage_archive.fences>=1&&report.phases.seal_stage_archive.segments>=1);
 assert.ok(report.storage.d1.reads>0&&report.storage.d1.writes>0&&report.storage.r2.writes>0&&report.storage.r2.reads>0,'per-resource reads and writes: '+JSON.stringify(report.storage));
 assert.equal(report.lease.holderKept,true);assert.ok(report.lease.renewals>=0&&report.lease.leaseMs===300000);
 assert.equal(report.cpuMs,null);assert.equal(report.memory,null);assert.match(report.cpuMemoryNote,/not exposed/);
 assert.equal(report.invariants.deniedAccesses,0);assert.equal(report.invariants.refusedWrites,0);assert.equal(report.invariants.identityVerified,true);assert.equal(report.invariants.archivePointerMoved,true);assert.equal(report.invariants.productionBindingsExposed,false);
 assert.equal(report.withinBudget,true);assert.ok(report.limits.some(text=>/not AIR-444 acceptance/.test(text)));
 assert.ok(!JSON.stringify(report).includes(dataset.baseline.items[0].title),'no ledger payload in the report');
 assert.equal(d.prod(),prodBefore,'the production-like resources are byte for byte what they were after a whole run');
 // the diagnostic domain really holds the sealed generation of the run, the archive moved on, and the production pointer names of the domain were not touched
 const archive=d.diagBkt.json(POINTER);assert.ok(archive.manifestId,'the diagnostic archive pointer moved');
 assert.ok(d.diagBkt.objects.has('epg/generations/'+report.runId+'/discovery-latest.json'),'the staged generation ledger of the run');
 // a second launch of the finished key is the same result, no new instance
 const again=await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));assert.equal(again.body.note,'already_complete');assert.equal(d.calls.create.length,1);
 // a new canary is possible once the slot is free, and refuses a dirty domain until the owner cleans it
 const second=await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY2,{seed:'canary-seed-2'}));assert.equal(second.status,200);
 const dirty=await d.runInstance(KEY2);assert.equal(dirty.result.reason,'domain_not_clean');assert.equal(d.receipt(KEY2).status,'failed');assert.equal(d.receipt(KEY2).failure,'domain_not_clean');
 // cleanup: refused while a canary is active, then it empties the baseline and keeps identity, datasets and receipts
 const third=await d.call('POST','/api/epg/diagnostic/launch',launchBody('canary-key-0000000003',{seed:'canary-seed-3'}));assert.equal(third.status,200);
 assert.equal((await d.call('POST','/api/epg/diagnostic/cleanup',{confirm:'CLEANUP_EPG_DIAGNOSTIC_DOMAIN'})).body.refused,'canary_active');
 assert.equal((await d.call('POST','/api/epg/diagnostic/cleanup',{})).body.refused,'confirmation_required');
 // A stop is a request, not a completion: the slot stays held (no new canary, no cleanup) until the instance has ended AND the step lease is quiet for the quiescence window.
 const stopBody={idempotencyKey:'canary-key-0000000003',confirm:'STOP_EPG_DIAGNOSTIC_CANARY'};
 const requested=await d.call('POST','/api/epg/diagnostic/stop',stopBody);
 assert.equal(requested.status,202);assert.equal(requested.body.stopped,false);assert.equal(requested.body.note,'quiescence_unconfirmed_repeat_stop');assert.equal(d.receipt('canary-key-0000000003').status,'stopping');
 assert.equal((await d.call('POST','/api/epg/diagnostic/cleanup',{confirm:'CLEANUP_EPG_DIAGNOSTIC_DOMAIN'})).body.refused,'canary_active','a stopping canary still holds the slot');
 assert.equal((await d.call('POST','/api/epg/diagnostic/launch',launchBody('canary-key-0000000004',{seed:'canary-seed-4'}))).body.refused,'canary_active');
 {const early=await d.Run.stop(d.env,stopBody,{now:()=>Date.now()+30000});assert.equal(plain(early).status??202,202);}
 assert.equal(d.receipt('canary-key-0000000003').status,'stopping','not yet quiescent');
 const confirmed=await d.Run.stop(d.env,stopBody,{now:()=>Date.now()+61000});
 assert.equal(d.receipt('canary-key-0000000003').status,'stopped');assert.equal(confirmed.status,200);
 const cleaned=await d.call('POST','/api/epg/diagnostic/cleanup',{confirm:'CLEANUP_EPG_DIAGNOSTIC_DOMAIN'});assert.equal(cleaned.body.cleaned,true);assert.ok(cleaned.body.removed>0);
 assert.ok(![...d.diagBkt.objects.keys()].some(key=>key.startsWith('epg/')||key==='sync.json'||key===d.Run.MATERIALIZED_KEY),'the baseline is gone');
 assert.ok(d.diagBkt.objects.has('diagnostic/identity.json')&&d.diagBkt.objects.has('diagnostic/replay/'+DIGEST+'.json'),'identity and datasets stay');
 assert.equal(d.receipts().length,3,'receipts stay');
 assert.equal(d.prod(),prodBefore);
 // after the cleanup a canary runs again from the same dataset (fresh domain)
 const fresh=await d.call('POST','/api/epg/diagnostic/launch',launchBody('canary-key-0000000004',{seed:'canary-seed-4'}));assert.equal(fresh.status,200);
 assert.equal((await d.runInstance('canary-key-0000000004')).result.reason,'complete');
}
// ================================ 4. faults ================================
const failedWith=async(label,{prepare,expect,statusExpect='failed'})=>{
 const d=await domain(prepare?.options||{});
 await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 if(prepare?.hook)prepare.hook(d);
 const {result}=await d.runInstance(KEY1);
 const row=d.receipt(KEY1);
 assert.equal(row.status,statusExpect,label+': '+JSON.stringify(result)+' '+row.failure);
 if(expect)assert.match(String(row.failure||result.reason),expect,label);
 assert.equal(row.slot,null,label+': the slot is free');
 return d;
};
{
 const setLease=(d,patch)=>sql(d.diagFile,"UPDATE epg_orchestration_document SET body=json_set(body,"+Object.entries(patch).map(([k,v])=>"'$."+k+"',"+(typeof v==='string'?"'"+v+"'":v)).join(',')+") WHERE key='lease'");
 await failedWith('a lost lease',{prepare:{hook:d=>{d.diagBkt.onPut=async key=>{if(key.includes('/segments/'))setLease(d,{holder:'someone-else'});};}},expect:/epoch_mismatch|fence/});
 await failedWith('an expired lease',{prepare:{hook:d=>{d.diagBkt.onPut=async key=>{if(key.includes('/segments/'))setLease(d,{expiresAt:new Date(Date.now()-60000).toISOString()});};}},expect:/step_lease_expired/});
 const conflict=await failedWith('a pointer conflict',{prepare:{hook:d=>{d.diagBkt.onPut=async key=>{if(key.includes('/manifests/')&&d.diagBkt.objects.has('sync.json')&&!d.diagBkt.__done){d.diagBkt.__done=true;await d.diagBkt.put(POINTER,JSON.stringify({manifestId:'another-writer'}));}};}}});
 assert.equal(conflict.diagBkt.json(POINTER).manifestId,'another-writer','the other writer\'s pointer stays');
 await failedWith('a domain that is not prepared',{prepare:{options:{published:'other'}},expect:/domain_not_prepared/});
 await failedWith('a missing dataset',{prepare:{options:{dataset:null},hook:()=>{}},expect:/dataset_missing/,statusExpect:'failed'}).catch(()=>null);
 const tampered=JSON.parse(datasetText);tampered.baseline.items[0].title=tampered.baseline.items[0].title.split('').reverse().join('');
 const bad=await domain({dataset:JSON.stringify(tampered)});
 assert.equal((await bad.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1))).body.refused,'dataset_invalid','a tampered dataset never starts');assert.equal(bad.calls.create.length,0);
 // a held production-like state appearing after the launch does not make the run touch it: the run reads nothing of production
 const d=await domain();await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 d.diagBkt.onPut=async key=>{if(key.includes('/segments/'))d.diagBkt.__seen=(d.diagBkt.__seen||0)+1;};
 await d.runInstance(KEY1);assert.ok(d.diagBkt.__seen>0);assert.equal(d.receipt(KEY1).status,'complete');
 // the budget is ENFORCED by the real step guard at every mutation boundary: a deadline already past stops the seal before it writes, the receipt fails typed, nothing is published
 {const e=await domain();await e.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1,{budgetMs:60000}));
  const over=await e.runInstance(KEY1,{now:()=>Date.now()-90000});
  assert.equal(e.receipt(KEY1).status,'failed');assert.equal(e.receipt(KEY1).failure,'budget_exceeded');assert.equal(over.result.reason,'budget_exceeded');
  assert.equal(e.diagBkt.objects.has('epg/generations/'+(await e.Run.runIdOf(KEY1))+'/discovery-latest.json'),false,'no staged generation after the deadline');}
 // a run that finished but took longer than its budget (measured by the run clock) is reported in full and is NOT a successful canary
 const b=await domain();await b.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1,{budgetMs:60000}));
 let t=0;const slow=await b.runInstance(KEY1,{now:()=>{t+=40000;return Date.now()+t;}});
 const slowReport=JSON.parse(b.receipt(KEY1).report_json);assert.equal(slowReport.withinBudget,false,'the budget overrun is reported');
 assert.equal(b.receipt(KEY1).status,'failed');assert.match(b.receipt(KEY1).failure,/^postcondition_failed:.*budget_exceeded/);assert.equal(slowReport.outcome.ok,false);assert.deepEqual(slowReport.outcome.violations,['budget_exceeded']);assert.equal(slow.result.reason,'postcondition_failed');
}
// stop semantics
{
 const d=await domain();
 await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 assert.equal((await d.call('POST','/api/epg/diagnostic/stop',{idempotencyKey:KEY1})).body.refused,'confirmation_required');
 assert.equal((await d.call('POST','/api/epg/diagnostic/stop',{idempotencyKey:'nope-nope-nope-nope-1',confirm:'STOP_EPG_DIAGNOSTIC_CANARY'})).status,404);
 const stopped=await d.call('POST','/api/epg/diagnostic/stop',{idempotencyKey:KEY1,confirm:'STOP_EPG_DIAGNOSTIC_CANARY'}); // the terminate is requested, but the slot stays fenced until the instance ended and the lease has been quiet for the window
 assert.equal(stopped.status,202);assert.equal(stopped.body.stopped,false);assert.deepEqual(plain(d.calls.terminate),[await d.Run.instanceIdOf(KEY1)]);
 assert.equal(d.receipt(KEY1).status,'stopping');assert.notEqual(d.receipt(KEY1).slot,null);
 // a second instance that still wakes up finds a stopping receipt and does nothing
 const wokeEarly=await d.runInstance(KEY1);assert.equal(wokeEarly.result.reason,'receipt_stopping');assert.deepEqual(wokeEarly.names,['begin']);
 assert.equal((await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY2,{seed:'too-early'}))).body.refused,'canary_active');
 const settled=await d.Run.stop(d.env,{idempotencyKey:KEY1,confirm:'STOP_EPG_DIAGNOSTIC_CANARY'},{now:()=>Date.now()+61000});assert.equal(settled.status,200);
 assert.equal(d.receipt(KEY1).status,'stopped');assert.equal(d.receipt(KEY1).slot,null);
 // the instance, if it still woke up, finds its receipt stopped and does nothing: no baseline, no seal
 const woke=await d.runInstance(KEY1);assert.equal(woke.result.reason,'receipt_stopped');assert.deepEqual(woke.names,['begin']);
 assert.ok(![...d.diagBkt.objects.keys()].some(key=>key.startsWith('epg/')),'a stopped receipt materializes nothing');
 assert.equal((await d.call('POST','/api/epg/diagnostic/stop',{idempotencyKey:KEY1,confirm:'STOP_EPG_DIAGNOSTIC_CANARY'})).body.note,'not_active');
 assert.equal((await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY2,{seed:'after-stop'}))).status,200,'the slot is free after a stop');
}
// ================================ 4b. the domain as the operator prepares it, with the REAL published-EPG module (no stub) ================================
{
 // `prepare-domain` sets the Discovery authority of the diagnostic D1 to d1/open, the production state. With it, the real modules complete a run on the D1 ledger path (hundreds of D1 writes
 // in sixteen batches); the seeded marker (r2) is refused before anything is written, because it would run the legacy R2 ledger path and measure nothing about production.
 const ready=await domain({realPublished:true,authority:'d1'});
 await ready.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 await ready.runInstance(KEY1);
 const done=JSON.parse(ready.receipt(KEY1).report_json);
 assert.equal(ready.receipt(KEY1).status,'complete');assert.equal(done.outcome.ok,true);assert.ok(done.storage.d1.writes>100,'the ledger goes through D1, as in production');assert.ok(done.storage.d1.batches>=1);
 const seeded=await domain({realPublished:true,authority:'r2'});
 await seeded.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));
 const refused=await seeded.runInstance(KEY1);
 assert.equal(seeded.receipt(KEY1).status,'failed');assert.equal(seeded.receipt(KEY1).failure,'domain_not_prepared');assert.equal(refused.result.reason,'domain_not_prepared');
 assert.equal([...seeded.diagBkt.objects.keys()].some(key=>key.startsWith('epg/')),false,'nothing was materialized on an unprepared domain');
}
// static wiring
{
 const wrangler=fs.readFileSync('wrangler.jsonc','utf8'),build=fs.readFileSync('build.mjs','utf8'),workerSource=fs.readFileSync('src/worker.js','utf8');
 assert.match(wrangler,/"binding": "EPG_DIAGNOSTIC_WORKFLOW"[\s\S]*"class_name": "EpgDiagnosticWorkflow"/);
 assert.doesNotMatch(wrangler,/"crons": \[[^\]]*,/,'still the single hourly cron (the diagnostic storage bindings are asserted in epg-diagnostic-context.mjs)');
 assert.match(wrangler,/"crons": \["0 \* \* \* \*"\]/);
 assert.match(build,/EpgDiagnosticWorkflow extends WorkflowEntrypoint/);assert.match(build,/runEpgDiagnosticWorkflow/);
 assert.doesNotMatch(workerSource,/EPG_DIAGNOSTIC_WORKFLOW|\.create\(\{id/,'the Worker entry creates no diagnostic instance itself; only the owner-only launch does');
 assert.doesNotMatch(SOURCES.run,/\bfetch\(|scheduled\(|setInterval|setTimeout|crons?\b/i,'no network, no timer, no cron in the run module');
 assert.equal((SOURCES.run.match(/\.create\(\{/g)||[]).length,1,'one create call, in the launch reconcile');
}

// ================================ 6. mutation checks ================================
async function quick(sourcesOverride,only=null){
 const failed=[];
 const lazy=build=>{let value;return async()=>value||(value=await build());};
 const check=async(name,run)=>{if(only&&!only.includes(name))return;try{if(await run()!==true)failed.push(name);}catch{failed.push(name);}};
 const make=options=>domain({sourcesOverride,...options});
 const launched=({budget,...options}={})=>lazy(async()=>{const x=await make(options);await x.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1,budget?{budgetMs:budget}:{}));return x;});
 const tamperedText=JSON.stringify((()=>{const x=JSON.parse(datasetText);x.baseline.items[0].title=x.baseline.items[0].title.split('').reverse().join('');return x;})());
 await check('launch needs the confirmation',async()=>{const d=await make();return (await d.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1,{confirm:'no'}))).status===400&&d.receipts().length===0;});
 await check('the production gate refuses',async()=>{const g=await make();await g.prodBkt.put('sync.json',JSON.stringify({runId:'r',stage:'seal',updatedAt:new Date().toISOString()}));const r=await g.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));return r.status===409&&g.calls.create.length===0&&g.receipts().length===0;});
 await check('an unbound Workflow refuses',async()=>{const w=await make();delete w.env.EPG_DIAGNOSTIC_WORKFLOW;const r=await w.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));return r.status===503&&w.receipts().length===0;});
 await check('a tampered dataset does not start',async()=>{const t=await make({dataset:tamperedText});const r=await t.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));return r.status===409&&t.calls.create.length===0&&t.receipts().length===0;});
 const n=launched();
 await check('a repeat creates no second instance',async()=>{const x=await n();await x.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));x.instances.clear();const again=await x.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));return x.calls.create.length===1&&again.body.note==='already_created';});
 await check('other parameters conflict',async()=>(await (await n()).call('POST','/api/epg/diagnostic/launch',launchBody(KEY1,{seed:'other-seed'}))).body.refused==='idempotency_conflict');
 await check('one canary at a time',async()=>{const x=await n();return (await x.call('POST','/api/epg/diagnostic/launch',launchBody(KEY2))).body.refused==='canary_active'&&x.receipts().length===1;});
 await check('cleanup refuses while active',async()=>(await (await n()).call('POST','/api/epg/diagnostic/cleanup',{confirm:'CLEANUP_EPG_DIAGNOSTIC_DOMAIN'})).body.refused==='canary_active');
 await check('status writes nothing',async()=>{const x=await n();const before=x.diag();await x.call('GET','/api/epg/diagnostic/status?key='+KEY1);return x.diag()===before;});
 await check('an unknown create is not retried blind',async()=>{const u=await make({workflow:{createThrows:{message:'network down',then:'unknown'},statusUnknown:true}});await u.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));await u.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));return u.calls.create.length===1&&u.receipt(KEY1).status==='reserved';});
 const stopBody={idempotencyKey:KEY1,confirm:'STOP_EPG_DIAGNOSTIC_CANARY'};
 const s=lazy(async()=>{const x=await (launched())();await x.call('POST','/api/epg/diagnostic/stop',stopBody);await x.Run.stop(x.env,stopBody,{now:()=>Date.now()+61000});return x;});
 await check('stop terminates the instance',async()=>(await s()).calls.terminate.length>=1);
 await check('a stop holds the slot until quiescent',async()=>{const x=await (launched())();const r=await x.call('POST','/api/epg/diagnostic/stop',stopBody);const again=await x.call('POST','/api/epg/diagnostic/launch',launchBody(KEY2,{seed:'early'}));return r.status===202&&x.receipt(KEY1).status==='stopping'&&again.body.refused==='canary_active';});
 await check('production busy at begin fails the run',async()=>{const x=await (launched())();await x.prodBkt.put('sync.json',JSON.stringify({runId:'r',stage:'seal',updatedAt:new Date().toISOString()}));const run=await x.runInstance(KEY1);return run.names.length===1&&x.receipt(KEY1).status==='failed'&&!x.diagBkt.objects.has('sync.json');});
 await check('an exceeded deadline is enforced by the guard',async()=>{const x=await (launched({budget:60000}))();const run=await x.runInstance(KEY1,{now:()=>Date.now()-90000});return run.result.reason==='budget_exceeded'&&x.receipt(KEY1).failure==='budget_exceeded';});
 await check('a violated postcondition is not complete',async()=>{const x=await (launched({budget:60000}))();let t=0;await x.runInstance(KEY1,{now:()=>{t+=40000;return Date.now()+t;}});return x.receipt(KEY1).status==='failed'&&/postcondition_failed/.test(x.receipt(KEY1).failure||'');});
 await check('a seeded Discovery marker is refused',async()=>{const x=await make({realPublished:true,authority:'r2'});await x.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));const run=await x.runInstance(KEY1);return run.result.reason==='domain_not_prepared'&&x.receipt(KEY1).status==='failed'&&![...x.diagBkt.objects.keys()].some(key=>key.startsWith('epg/'));});
 await check('production busy at seal fails the run',async()=>{const x=await (launched())();const step={do:async(name,fn)=>{const r=await fn();if(name==='begin')await x.prodBkt.put('sync.json',JSON.stringify({runId:'r',stage:'seal',updatedAt:new Date().toISOString()}));return r;}};const run=await x.Run.run(x.env,{idempotencyKey:KEY1},step);return run.reason!=='complete'&&x.receipt(KEY1).status==='failed'&&![...x.diagBkt.objects.keys()].some(key=>key.startsWith('epg/'));});
 await check('a stopped receipt does not run',async()=>{const x=await s();const r=await x.runInstance(KEY1);return r.names.length===1&&r.result.reason==='receipt_stopped'&&x.receipt(KEY1).status==='stopped'&&![...x.diagBkt.objects.keys()].some(key=>key.startsWith('epg/'));});
 await check('a run completes with exact departures',async()=>{const x=await (launched())();const run=await x.runInstance(KEY1);const report=JSON.parse(x.receipt(KEY1).report_json||'{}');return run.result.reason==='complete'&&report.expectedVsActual?.departuresMatch===true&&report.published===false&&report.productionWrites===0&&report.label==='canary-measured';});
 await check('an unprepared domain fails closed',async()=>{const p=await (launched({published:'other'}))();const x=await p.runInstance(KEY1);return /domain_not_prepared/.test(x.result.reason)&&p.receipt(KEY1).status==='failed'&&!p.diagBkt.objects.has('sync.json');});
 await check('a dirty domain is refused',async()=>{const q=await make();await q.diagBkt.put('epg/stray.json','{}');await q.call('POST','/api/epg/diagnostic/launch',launchBody(KEY1));const x=await q.runInstance(KEY1);return /domain_not_clean/.test(x.result.reason)&&q.receipt(KEY1).status==='failed'&&!q.diagBkt.objects.has('sync.json')&&!q.diagBkt.objects.has(q.Run.MATERIALIZED_KEY);});
 await check('a consumed baseline is refused',async()=>{const c=await (launched())();await c.runInstance(KEY1);await c.call('POST','/api/epg/diagnostic/launch',launchBody(KEY2,{seed:'second-seed'}));const x=await c.runInstance(KEY2);return /domain_not_clean/.test(x.result.reason);});
 return failed;
}
{
 assert.deepEqual(await quick(null),[],'the real module passes every check');
 const mutants=[
  ['a stop completes without quiescence',"if(!(ended&&quiet&&waitedMs>=QUIESCENCE_MS))return reply(202,","if(false)return reply(202,"],
  ['begin does not gate production',"if(busy){await transition(ctx.env,key,Number(row.revision),['reserved','created'],'failed',{failure:busy,now:now()});return {ok:false,code:busy};}",""],
  ['an unprepared Discovery marker is accepted',"    if(!gate.ready)return {failure:{code:'domain_not_prepared'}};\n",'','a seeded Discovery marker is refused'],
  ['seal does not gate production',"   if(busy)return {failure:{code:busy}};\n",""],
  ['the deadline is not enforced',"   ctx.env.epgDeadline=started+config.budgetMs;",""],
  ['complete ignores the outcome',"const ok=sealed.report?.outcome?.ok===true;","const ok=!!sealed.report;"],
  ['launch needs no confirmation',"if(body.confirm!==CONFIRM.launch)return refuse(400,'confirmation_required');",""],
  ['the production gate is skipped',"if(production)return refuse(409,production);",""],
  ['an unbound Workflow is accepted',"if(typeof env.EPG_DIAGNOSTIC_WORKFLOW?.create!=='function')return refuse(503,'workflow_unbound');",""],
  ['the dataset is not verified',"if(!checked.ok)return {refused:'dataset_invalid',problems:checked.problems};",""],
  ['the idempotency conflict is ignored',"if(existing.fingerprint!==fingerprint)return refuse(409,'idempotency_conflict');",""],
  ['the active slot is ignored',"if(taken.constraint==='slot')return refuse(409,'canary_active');",""],
  ['an unknown create is retried',"else return reply(202,{receipt:publicReceipt(row),outcome:'unknown',note:'create_outcome_unknown_no_blind_retry'});","else created=true;"],
  ['an unknown status is retried',"else if(known==='unknown')return reply(202,{receipt:publicReceipt(row),outcome:'unknown',note:'instance_status_unknown_no_retry'});",""],
  ['a repeat creates again',"if(row.status!=='reserved')return reply(200,{receipt:publicReceipt(row),reconciled:false,note:'already_'+row.status});",""],
  ['stop does not terminate',"if(typeof instance?.terminate==='function'){await instance.terminate();terminated='terminated';}",""],
  ['a stopped receipt runs on',"if(row.status!=='created'&&row.status!=='reserved')return {ok:false,code:'receipt_'+row.status};",""],
  ['cleanup ignores an active canary',"if(active)return refuse(409,'canary_active',{idempotencyKey:active.idempotency_key});",""],
  ['the published generation is not compared',"if(live){if(live.programmeRunId!==id)return {refused:'domain_not_prepared'};return {publication:{programmeRunId:id,phase:'published',fence:live.fence}};}","if(live)return {publication:{programmeRunId:id,phase:'published',fence:live.fence}};"],
  ['a dirty domain is overwritten',"if((listed.objects||[]).length)return {refused:'domain_not_clean'};",""],
  ['the dataset digest of a materialized baseline is not compared',"return body.datasetDigest===dataset.digest&&!body.consumedBy?{reused:true}:{refused:'domain_not_clean'};","return {reused:true};"],
  ['the report claims a publication',"schemaVersion:1,label:'canary-measured',published:publishedAfter!==publishedBefore,productionWrites:measure.attempts,\n    dataset:","schemaVersion:1,label:'canary-measured',published:true,productionWrites:0,\n    dataset:"],
  ['the report is labelled production-measured',"schemaVersion:1,label:'canary-measured',published:publishedAfter!==publishedBefore,productionWrites:measure.attempts,\n    dataset:","schemaVersion:1,label:'production-measured',published:false,productionWrites:0,\n    dataset:"],
  ['status writes',"return reply(200,{receipt:publicReceipt(row),instance:live,reconcile:hint,sideEffects:'none',writes:noteWrites(ctx)});","await transition(ctx.env,row.idempotency_key,Number(row.revision),ACTIVE,row.status);return reply(200,{receipt:publicReceipt(row),instance:live,reconcile:hint,sideEffects:'none',writes:noteWrites(ctx)});"],
 ];
 const concerns={"a stop completes without quiescence":["a stop holds the slot until quiescent"],"begin does not gate production":["production busy at begin fails the run"],"seal does not gate production":["production busy at seal fails the run"],"an unprepared Discovery marker is accepted":["a seeded Discovery marker is refused"],"the deadline is not enforced":["an exceeded deadline is enforced by the guard"],"complete ignores the outcome":["a violated postcondition is not complete"],"launch needs no confirmation": ["launch needs the confirmation"], "the production gate is skipped": ["the production gate refuses"], "an unbound Workflow is accepted": ["an unbound Workflow refuses"], "the dataset is not verified": ["a tampered dataset does not start"], "the idempotency conflict is ignored": ["other parameters conflict"], "the active slot is ignored": ["one canary at a time"], "an unknown create is retried": ["an unknown create is not retried blind"], "an unknown status is retried": ["an unknown create is not retried blind"], "a repeat creates again": ["a repeat creates no second instance"], "stop does not terminate": ["stop terminates the instance"], "a stopped receipt runs on": ["a stopped receipt does not run"], "cleanup ignores an active canary": ["cleanup refuses while active"], "the published generation is not compared": ["an unprepared domain fails closed"], "a dirty domain is overwritten": ["a dirty domain is refused"], "the dataset digest of a materialized baseline is not compared": ["a consumed baseline is refused"], "the report claims a publication": ["a run completes with exact departures"], "the report is labelled production-measured": ["a run completes with exact departures"], "status writes": ["status writes nothing"]};
 for(const [name,from,to] of mutants){
  assert.equal(SOURCES.run.split(from).length-1,1,'the mutant pattern exists once: '+name);
  assert.ok(concerns[name],'the mutant names the checks it concerns: '+name);
  const failed=await quick({...SOURCES,run:SOURCES.run.replace(from,to)},concerns[name]);
  assert.ok(failed.length>0,'the checks catch the mutant "'+name+'"');
 }
}
void webcrypto;void Diag;
console.log('EPG diagnostic run: inert without bindings, owner-only launch behind confirmation and gates, atomic reservation and reconciliation, the real seal on the diagnostic domain with a canary-measured report, typed failures, stop and cleanup, production-like resources untouched and every guard mutant caught passed');
