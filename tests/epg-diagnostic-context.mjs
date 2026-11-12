// AIR-453 / ADR 0121. The isolated execution context of the EPG diagnostic canary. Offline only: sqlite stand-ins of D1 and in-memory buckets; no Cloudflare, no
// TMDB, no production. What is proved here:
//   1. The context is a strict allowlist, refuses a malformed or contradictory context and refuses every write until the identity of BOTH diagnostic resources has
//      been verified; a production-like database or bucket (no identity, not empty) is never provisioned and never verified.
//   2. The REAL seal path (`stageSealedGeneration` -> `planDiscoveryLedger`, `writeLedgerSegment`, manifest and pointer CAS, the Discovery fences, `EpgOrchestration.assertStep`)
//      runs unchanged on that context: its result equals the same commits on a plain environment, generation after generation.
//   3. Lease renewal, an expired lease, a lost lease, an archive pointer conflict and a stale published generation stop the diagnostic seal exactly as in production,
//      before the pointer moves; the production-like resources of the same process are never touched (byte for byte).
//   4. The module is inert: no binding, no route, no Workflow, no flag; without the diagnostic bindings the context is refused and nothing is written.
//   5. Mutation checks: the isolation checks fail on every one of a set of mutants of the module (each removes one guard).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {scoped} from '../scripts/bundle-scope.mjs';
import {context,call,sql,migrate,bucket,runId,POINTER,world,bootstrap,commit,r2Union,assertParity,d1Counts} from './discovery-bounded-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const source=fs.readFileSync('src/epg-diagnostic.js','utf8');
const loadModule=text=>new Function(text+'\nreturn EpgDiagnostic;')();
const Diag=loadModule(source);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-diagnostic-'));
const plain=value=>JSON.parse(JSON.stringify(value));
const IDENTITY=fs.readFileSync('diagnostic-migrations/0001_epg_diagnostic_identity.sql','utf8');
const LATER=fs.readdirSync('migrations').filter(name=>/^001[3-9]_/.test(name)).sort();
const RESOURCE='diag-test-0001';

// The real step lease and the real policy, loaded into the Worker's context like the Worker bundle does.
vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy'),context);
vm.runInContext(fs.readFileSync('src/epg-orchestration.js','utf8'),context);
const Epg=call('EpgOrchestration');

// ---- harness -----------------------------------------------------------------------------------------------------------------------------------------
// A database with the production chain (schema only) and the diagnostic identity table. `provisioned` writes the identity into the empty database and the empty bucket.
async function diagWorld({provisioned=true,resourceId=RESOURCE}={}){
 const state=world();
 for(const name of LATER)sql(state.file,fs.readFileSync('migrations/'+name,'utf8'));
 sql(state.file,IDENTITY);
 const raw=d1Standin(state.file,{maxBinds:100});
 const ctx=Diag.create({DB:raw,BUCKET:state.bkt,resourceId});
 assert.equal(ctx.ok,true,'the context is created');
 if(provisioned){
  const done=await Diag.provision({DB:raw,BUCKET:state.bkt,resourceId});assert.equal(done.ok,true,'provision: '+JSON.stringify(done));
  assert.equal((await ctx.verify()).ok,true,'verified');
 }
 // The harness hands the guarded environment to the Worker's functions, as the executor will.
 state.raw=raw;state.ctx=ctx;state.step=null;
 state.envFactory=(st,mode)=>{ctx.env.discoveryLease=null;ctx.env.DISCOVERY_LEDGER_MODE=mode??'bounded';ctx.env.DB.calls=raw.calls;if(state.step)ctx.env.epgStep=state.step;else delete ctx.env.epgStep;return ctx.env;};
 return state;
}
const fingerprint=(file,bkt)=>JSON.stringify({dump:sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<28}).stdout,objects:[...bkt.objects].map(([key,value])=>[key,value.etag])});

// 1. Identity, provisioning and the guarded writes ------------------------------------------------------------------------------------------------------
{
 // A fresh database and bucket are provisioned; verify then passes and writes work and are counted.
 const state=await diagWorld();
 const stats=state.ctx.stats();
 assert.equal(state.ctx.verified(),true);
 assert.equal(stats.r2.writes,0,'verify and provision go through the unguarded handles and are not counted as diagnostic writes');
 await state.ctx.env.BUCKET.put('probe/a','{}');
 assert.equal(state.ctx.stats().r2.writes,stats.r2.writes+1,'a verified put is counted');
 await state.ctx.env.DB.prepare("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','{\"holder\":\"x\",\"expiresAt\":\"2099-01-01T00:00:00.000Z\"}',1,'now')").bind().run();
 assert.equal(state.ctx.stats().d1.writes>=1,true,'a verified D1 write is counted');
 // provision is once only and never into a used domain.
 assert.equal((await Diag.provision({DB:state.raw,BUCKET:state.bkt,resourceId:RESOURCE})).reason,'domain_not_empty','a second provision refuses: the bucket is no longer empty');

 // A database or bucket with no identity: every write is refused before it reaches storage, reads still work, verify says why.
 const bare=await diagWorld({provisioned:false});
 assert.equal((await bare.ctx.verify()).reason,'identity_missing');
 const before=fingerprint(bare.file,bare.bkt);
 await assert.rejects(bare.ctx.env.BUCKET.put('x','y'),error=>error.code==='diagnostic_unverified');
 await assert.rejects(bare.ctx.env.BUCKET.delete('x'),error=>error.code==='diagnostic_unverified');
 await assert.rejects(bare.ctx.env.DB.prepare("UPDATE discovery_lease SET expires_at=5 WHERE id=1").bind().run(),error=>error.code==='diagnostic_unverified');
 await assert.rejects(bare.ctx.env.DB.batch([bare.ctx.env.DB.prepare("DELETE FROM discovery_lease").bind()]),error=>error.code==='diagnostic_unverified');
 await bare.ctx.env.DB.prepare('SELECT 1 AS one').bind().first();await bare.ctx.env.BUCKET.get('nothing');
 assert.equal(fingerprint(bare.file,bare.bkt),before,'nothing changed');
 assert.equal(bare.ctx.stats().refusedWrites,4);
 // The seal path itself, run on the unverified context, stops at its first mutation and leaves the domain as it was.
 await bootstrapRaw(bare);
 const stopped=await commit(bare,1,'bounded',{expectThrow:true});
 assert.ok(['diagnostic_unverified','discovery_unavailable'].includes(stopped.error.code),'the real seal stops on the unverified context (its first write, the Discovery lease, is refused): '+stopped.error.code);
 assert.ok(bare.ctx.stats().refusedWrites>4,'it tried to write and was refused');
 assert.equal(fingerprint(bare.file,bare.bkt).includes('discovery-archive'),false,'nothing of the archive');
 const afterKeys=[...bare.bkt.objects.keys()].filter(key=>key.startsWith('epg/discovery-archive/'));
 assert.deepEqual(afterKeys,[],'no archive object');

 // The identity of the two resources must agree with each other and with the context.
 const split=await diagWorld({provisioned:false});
 split.raw.sql("INSERT INTO epg_diagnostic_identity (id,domain,resource_id,created_at) VALUES (1,'epg-diagnostic','another-resource-1','t')");
 await split.bkt.put(Diag.IDENTITY_OBJECT,JSON.stringify({domain:'epg-diagnostic',resourceId:RESOURCE}));
 assert.equal((await split.ctx.verify()).reason,'identity_mismatch','D1 and R2 name different resources');
 await assert.rejects(split.ctx.env.BUCKET.put('x','y'),error=>error.code==='diagnostic_unverified');
 const foreign=await diagWorld({provisioned:false});
 await foreign.bkt.put(Diag.IDENTITY_OBJECT,'not json');
 foreign.raw.sql("INSERT INTO epg_diagnostic_identity (id,domain,resource_id,created_at) VALUES (1,'epg-diagnostic','"+RESOURCE+"','t')");
 assert.equal((await foreign.ctx.verify()).reason,'identity_malformed');

 // A production-like database or bucket is not provisioned (it has data), and a provision never overwrites an identity.
 const prod=world();
 await bootstrap(prod,0);
 const prodRaw=d1Standin(prod.file,{maxBinds:100});
 assert.equal((await Diag.provision({DB:prodRaw,BUCKET:prod.bkt,resourceId:RESOURCE})).reason,'schema_missing','a database without the identity table is refused');
 sql(prod.file,IDENTITY);
 assert.equal((await Diag.provision({DB:prodRaw,BUCKET:prod.bkt,resourceId:RESOURCE})).reason,'domain_not_empty','and one with data in it, even with the table');
 assert.equal([...prod.bkt.objects.keys()].includes(Diag.IDENTITY_OBJECT),false,'no identity object was written');
}
async function bootstrapRaw(state){await bootstrap(state,0);}

// 2. The context shape ------------------------------------------------------------------------------------------------------------------------------------
{
 const state=await diagWorld();
 const env=state.ctx.env;
 assert.deepEqual(Object.keys(env).sort(),['BUCKET','DB','DISCOVERY_LEDGER_MODE','epgDiagnostic'],'only the allowlisted keys, built from scratch');
 assert.deepEqual(Object.keys({...env}).sort(),['BUCKET','DB','DISCOVERY_LEDGER_MODE','epgDiagnostic'],'a spread of it (as the executor does) carries the same and nothing else');
 for(const name of Diag.DENIED)assert.throws(()=>env[name],error=>error.code==='diagnostic_binding_denied'&&error.binding===name,'reading '+name+' is refused');
 assert.ok(state.ctx.stats().denied>=Diag.DENIED.length);
 assert.throws(()=>{env.EPG_WORKFLOW={};},error=>error.code==='diagnostic_binding_denied','a production binding cannot be attached');
 assert.throws(()=>{env.SOMETHING_ELSE=1;},error=>error.code==='diagnostic_binding_denied','nor any key outside the allowlist');
 env.epgStep={holder:'h'};assert.equal(env.epgStep.holder,'h','the step carrier is allowed');delete env.epgStep;
 assert.equal(Object.isFrozen(env.epgDiagnostic),true);assert.equal(env.epgDiagnostic.resourceId,RESOURCE);
 await assert.rejects(env.DB.exec('DROP TABLE x'),error=>error.code==='diagnostic_exec_refused');
 // A statement prepared on another database is refused as a whole, and nothing runs.
 const other=d1Standin(state.file,{maxBinds:100});
 await assert.rejects(env.DB.batch([env.DB.prepare('SELECT 1').bind(),other.prepare('SELECT 2').bind()]),error=>error.code==='diagnostic_foreign_statement');
 // Malformed and contradictory contexts are refused before anything exists.
 const raw=state.raw,bkt=state.bkt;
 for(const [args,field] of [[{DB:null,BUCKET:bkt,resourceId:RESOURCE},'DB'],[{DB:raw,BUCKET:{get(){}},resourceId:RESOURCE},'BUCKET'],[{DB:raw,BUCKET:bkt,resourceId:'short'},'resourceId'],[{DB:raw,BUCKET:bkt,resourceId:RESOURCE,ledgerMode:'wild'},'ledgerMode']]){
  const made=Diag.create(args);assert.equal(made.ok,false);assert.equal(made.reason,'context_malformed');assert.equal(made.field,field);
 }
 assert.equal(Diag.create({DB:raw,BUCKET:bkt,resourceId:RESOURCE,production:{DB:raw}}).reason,'context_contradictory','the diagnostic DB is the production DB');
 assert.equal(Diag.create({DB:raw,BUCKET:bkt,resourceId:RESOURCE,production:{BUCKET:bkt}}).reason,'context_contradictory','the diagnostic bucket is the production bucket');
 // The classification of statements is fail-closed.
 for(const [text,write] of [['SELECT 1',false],[' select a from b',false],['WITH a AS (SELECT 1) SELECT * FROM a',false],['/* x */ INSERT INTO t VALUES (1)',true],['WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a',true],['UPDATE t SET a=1',true],['DELETE FROM t',true],['REPLACE INTO t VALUES (1)',true],['PRAGMA x=1',true],['SELECT updated_at FROM t',false],['-- c\nSELECT 1',true]])assert.equal(Diag.isWrite(text),write,text);
}

// 3. Inert: no bindings, no route, no Workflow, no flag, no migration in the production chain ---------------------------------------------------------------
{
 const writes=[];const spy={prepare:()=>{writes.push('d1');throw new Error('no');},batch:()=>{writes.push('d1');}},spyBucket={get:()=>{writes.push('r2');},put:()=>{writes.push('r2');},head:()=>{},delete:()=>{writes.push('r2');}};
 assert.equal(Diag.fromWorkerEnv({DB:spy,BUCKET:spyBucket},{resourceId:RESOURCE}).reason,'diagnostic_bindings_absent','the Worker today');
 assert.equal(Diag.fromWorkerEnv({DB:spy,BUCKET:spyBucket,EPG_DIAGNOSTIC_DB:spy},{resourceId:RESOURCE}).reason,'diagnostic_bindings_incomplete');
 assert.equal(Diag.fromWorkerEnv({DB:spy,BUCKET:spyBucket,EPG_DIAGNOSTIC_DB:spy,EPG_DIAGNOSTIC_BUCKET:spyBucket},{resourceId:RESOURCE}).reason,'context_contradictory','diagnostic bindings that are the production objects');
 assert.deepEqual(writes,[],'no storage call at all');
 const wrangler=fs.readFileSync('wrangler.jsonc','utf8'),workerSource=fs.readFileSync('src/worker.js','utf8'),build=fs.readFileSync('build.mjs','utf8');
 assert.doesNotMatch(wrangler,/DIAGNOSTIC/i,'no diagnostic binding, resource, route or migration directory in wrangler.jsonc');
 assert.doesNotMatch(workerSource,/EpgDiagnostic/,'the Worker entry does not reference the module');
 assert.match(build,/src\/epg-diagnostic\.js/,'the module is in the bundle (inert)');
 assert.ok(!fs.readdirSync('migrations').some(name=>/diagnostic/i.test(name)),'the diagnostic migration is not in the production chain');
 assert.doesNotMatch(source,/\bfetch\(|\.create\(|EPG_WORKFLOW\s*[.?]|new Request|crypto\.randomUUID/,'no network, no Workflow creation');
 const bindingUses=[...source.matchAll(/\b(EPG_WORKFLOW|DISCOVERY_WORKFLOW|RATINGS_WORKFLOW)\b/g)].length;assert.equal(bindingUses,3,'the Workflow bindings appear only in the denied list');
}

// 4. Parity: the real seal path on the diagnostic context equals the same commits on a plain environment ------------------------------------------------------
{
 const plainWorld=world();await bootstrap(plainWorld,0);
 const diagnostic=await diagWorld();
 // `world()` installs the stub of the published generation on the shared context; the plain world needs its own while it runs.
 const stubOf=state=>({async readAuthority(){return {cutover:'open',mode:'d1'};},async currentGeneration(){return state.published?{programmeRunId:state.published.programmeRunId,phase:'published',fence:state.published.fence}:null;}});
 const use=state=>{context.PublishedEpg=stubOf(state);};
 use(diagnostic);await bootstrap(diagnostic,0);
 const results=[];
 for(const day of [1,2,3,4,5]){
  use(plainWorld);const a=await commit(plainWorld,day,'bounded');
  use(diagnostic);const b=await commit(diagnostic,day,'bounded');
  use(plainWorld);assertParity(plainWorld,'plain day '+day);const left=r2Union(plainWorld);
  use(diagnostic);assertParity(diagnostic,'diagnostic day '+day);const right=r2Union(diagnostic);
  assert.deepEqual([...left.map.keys()].sort(),[...right.map.keys()].sort(),'day '+day+': the same ledger and archive keys');
  for(const [key,item] of left.map)assert.equal(JSON.stringify(item),JSON.stringify(right.map.get(key)),'day '+day+': the same payload of '+key);
  assert.equal(left.doc.ledgerMode,right.doc.ledgerMode);assert.equal(left.doc.archive?.alsoArchived.length??0,right.doc.archive?.alsoArchived.length??0);
  assert.equal(b.staging.r2Puts,a.staging.r2Puts,'day '+day+': the same number of R2 puts');
  assert.deepEqual(plain(d1Counts(plainWorld.file)),plain(d1Counts(diagnostic.file)),'day '+day+': the same D1 rows');
  results.push({day,archived:right.archived,segments:right.segmentsRead});
 }
 assert.ok(results.some(row=>row.archived>0&&row.segments>0),'the plan archives departures: '+JSON.stringify(results));
 const stats=diagnostic.ctx.stats();
 assert.ok(stats.r2.writes>0&&stats.d1.writes>0&&stats.r2.reads>0&&stats.d1.reads>0,'reads and writes were counted per resource: '+JSON.stringify(stats));
 assert.equal(stats.denied,0,'no production binding was touched');assert.equal(stats.refusedWrites,0,'no write was refused');
}

// 5. The step lease on the diagnostic D1: renewal, expiry, loss; the archive CAS; a stale generation. The production-like resources never change. --------------
{
 // The production-like resources of the same process: their own database and bucket, never handed to the diagnostic path.
 const prod={file:migrate(),bkt:bucket()};
 sql(prod.file,"UPDATE discovery_lease SET lease_id='prod-sentinel' WHERE id=1");
 await prod.bkt.put('epg/generation.json',JSON.stringify({sentinel:true}));await prod.bkt.put('sync.json',JSON.stringify({sentinel:true}));
 const prodBefore=fingerprint(prod.file,prod.bkt);

 const setup=async()=>{
  const state=await diagWorld();
  context.PublishedEpg={async readAuthority(){return state.authority||{cutover:'open',mode:'d1'};},async currentGeneration(){return state.published?{programmeRunId:state.published.programmeRunId,phase:'published',fence:state.published.fence}:null;}};
  await bootstrap(state,0);
  const taken=await Epg.acquireStep(state.ctx.env,{kind:'executor',modeRevision:null});assert.ok(taken.step,'the step lease is taken on the diagnostic D1: '+JSON.stringify(taken));
  state.step=taken.step;
  return state;
 };
 const setLease=(state,patch)=>sql(state.file,"UPDATE epg_orchestration_document SET body=json_set(body,"+Object.entries(patch).map(([key,value])=>"'$."+key+"',"+(typeof value==='string'?"'"+value+"'":value)).join(',')+") WHERE key='lease'");
 const leaseRow=state=>JSON.parse(sql(state.file,"SELECT body FROM epg_orchestration_document WHERE key='lease'")[0].body);
 const archivePointer=state=>state.bkt.objects.get(POINTER)?.etag??null;

 // 5a. A lease with less than half of its time left is renewed by the fences of the real seal.
 {
  const state=await setup();
  setLease(state,{expiresAt:new Date(Date.now()+100000).toISOString()});
  const done=await commit(state,1,'bounded');assert.equal(done.done,true);
  const lease=leaseRow(state);
  assert.equal(lease.holder,state.step.holder,'the same holder');
  assert.ok(Date.parse(lease.expiresAt)>Date.now()+250000,'renewed to about a full lease: '+lease.expiresAt);
  assert.notEqual(archivePointer(state),null,'the archive pointer moved after every fence held');
 }
 // 5b. An expired lease stops the seal at the next full fence (the manifest's), before the pointer; the failure is named step_lease_expired.
 {
  const state=await setup();
  state.bkt.onPut=async key=>{if(key.includes('/segments/'))setLease(state,{expiresAt:new Date(Date.now()-60000).toISOString()});};
  const before=archivePointer(state);
  const stopped=await commit(state,1,'bounded',{expectThrow:true});
  assert.equal(stopped.error.code,'epg_step_fenced');assert.equal(stopped.error.detail,'lease_expired');
  assert.equal(Epg.classifyThrown(stopped.error),'step_lease_expired');
  assert.equal(archivePointer(state),before,'the pointer did not move');
  assert.ok(![...state.bkt.objects.keys()].some(key=>key.includes('/manifests/')),'no manifest');
 }
 // 5c. A lost lease (another holder) is a fence, not an expiry.
 {
  const state=await setup();
  state.bkt.onPut=async key=>{if(key.includes('/segments/'))setLease(state,{holder:'someone-else'});};
  const stopped=await commit(state,1,'bounded',{expectThrow:true});
  assert.equal(stopped.error.detail,'lease_lost');assert.equal(Epg.classifyThrown(stopped.error),'epoch_mismatch');
  assert.equal(archivePointer(state),null);
 }
 // 5d. Another writer moves the archive pointer between the manifest and the swap: the compare-and-swap refuses, the other writer's pointer stays.
 {
  const state=await setup();
  state.bkt.onPut=async key=>{if(key.includes('/manifests/'))await state.bkt.put(POINTER,JSON.stringify({manifestId:'another-writer'}));};
  const stopped=await commit(state,1,'bounded',{expectThrow:true});
  assert.match(String(stopped.error.message),/archive pointer changed/);
  assert.equal(state.bkt.json(POINTER).manifestId,'another-writer','the other writer\'s pointer stays');
 }
 // 5e. The published generation was held or replaced: the fence stops the archive before the pointer.
 {
  const state=await setup();
  state.bkt.onPut=async key=>{if(key.includes('/segments/'))state.authority={cutover:'held',mode:'d1'};};
  const before=archivePointer(state);
  const stopped=await commit(state,1,'bounded',{expectThrow:true});
  assert.match(String(stopped.error.message),/fence/,'a fence error: '+stopped.error.message);
  assert.equal(archivePointer(state),before);
 }
 assert.equal(fingerprint(prod.file,prod.bkt),prodBefore,'the production-like database and bucket are byte for byte what they were');
}

// 6. Mutation checks: the isolation checks fail on every mutant of the module ----------------------------------------------------------------------------------
async function isolationChecks(Module){
 const failed=[];
 const check=async(name,run)=>{try{if(await run()!==true)failed.push(name);}catch{failed.push(name);}};
 const tiny=()=>{const file=path.join(root,'m-'+Math.random().toString(36).slice(2)+'.sqlite');sql(file,IDENTITY);sql(file,'CREATE TABLE epg_orchestration_document (key TEXT PRIMARY KEY, body TEXT, revision INTEGER, updated_at TEXT)');return {file,raw:d1Standin(file),bkt:bucket()};};
 const refuses=async(promise,code)=>{try{await promise;return false;}catch(error){return error.code===code;}};
 await check('r2 put needs the identity',async()=>{const t=tiny(),c=Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});return await refuses(c.env.BUCKET.put('a','b'),'diagnostic_unverified')&&!t.bkt.objects.has('a');});
 await check('r2 delete needs the identity',async()=>{const t=tiny();await t.bkt.put('a','b');const c=Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});return await refuses(c.env.BUCKET.delete('a'),'diagnostic_unverified')&&t.bkt.objects.has('a');});
 await check('d1 run needs the identity',async()=>{const t=tiny(),c=Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});return await refuses(c.env.DB.prepare("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('a','{}',1,'t')").bind().run(),'diagnostic_unverified')&&t.raw.sql('SELECT COUNT(*) AS n FROM epg_orchestration_document')[0].n===0;});
 await check('d1 batch needs the identity',async()=>{const t=tiny(),c=Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});return await refuses(c.env.DB.batch([c.env.DB.prepare("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('a','{}',1,'t')").bind()]),'diagnostic_unverified')&&t.raw.sql('SELECT COUNT(*) AS n FROM epg_orchestration_document')[0].n===0;});
 await check('production bucket refused',async()=>{const t=tiny();return Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE,production:{BUCKET:t.bkt}}).reason==='context_contradictory';});
 await check('production database refused',async()=>{const t=tiny();return Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE,production:{DB:t.raw}}).reason==='context_contradictory';});
 await check('denied binding throws',async()=>{const t=tiny(),c=Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});try{c.env.EPG_WORKFLOW;return false;}catch(error){return error.code==='diagnostic_binding_denied';}});
 await check('unknown key refused',async()=>{const t=tiny(),c=Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});try{c.env.OTHER=1;return false;}catch(error){return error.code==='diagnostic_binding_denied';}});
 await check('bucket identity must match',async()=>{const t=tiny(),c=Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});t.raw.sql("INSERT INTO epg_diagnostic_identity (id,domain,resource_id,created_at) VALUES (1,'epg-diagnostic','"+RESOURCE+"','t')");await t.bkt.put(Module.IDENTITY_OBJECT,JSON.stringify({domain:'epg-diagnostic',resourceId:'another-resource-1'}));const v=await c.verify();return v.ok===false&&v.reason==='identity_mismatch';});
 await check('database identity must match',async()=>{const t=tiny(),c=Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});t.raw.sql("INSERT INTO epg_diagnostic_identity (id,domain,resource_id,created_at) VALUES (1,'epg-diagnostic','another-resource-1','t')");await t.bkt.put(Module.IDENTITY_OBJECT,JSON.stringify({domain:'epg-diagnostic',resourceId:RESOURCE}));const v=await c.verify();return v.ok===false&&v.reason==='identity_mismatch';});
 await check('a used bucket is not provisioned',async()=>{const t=tiny();await t.bkt.put('epg/generation.json','{}');const done=await Module.provision({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});return done.ok===false&&done.reason==='domain_not_empty'&&!t.bkt.objects.has(Module.IDENTITY_OBJECT);});
 await check('a used database is not provisioned',async()=>{const t=tiny();t.raw.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{}',1,'t')");const done=await Module.provision({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});return done.ok===false&&done.reason==='domain_not_empty'&&!t.bkt.objects.has(Module.IDENTITY_OBJECT);});
 await check('a comment cannot hide a write',async()=>{const t=tiny(),c=Module.create({DB:t.raw,BUCKET:t.bkt,resourceId:RESOURCE});return await refuses(c.env.DB.prepare("/* x */ INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('a','{}',1,'t')").bind().run(),'diagnostic_unverified');});
 return failed;
}
{
 assert.deepEqual(await isolationChecks(Diag),[],'the real module passes every isolation check');
 const mutants=[
  ['R2 put is not gated',"async put(...a){state.gate();","async put(...a){"],
  ['R2 delete is not gated',"async delete(...a){state.gate();","async delete(...a){"],
  ['D1 batch is not gated',"if(writes)state.gate();",""],
  ['D1 statements are all reads',"const write=isWrite(sql);","const write=false;"],
  ['a comment hides a write',"return !READ_START.test(text)||WRITE_WORD.test(text);","return /^\\s*(INSERT|UPDATE|DELETE)/i.test(text);"],
  ['production bucket allowed',"if(production.BUCKET&&(production.BUCKET===BUCKET))return refusal('context_contradictory',{field:'BUCKET'});",""],
  ['production database allowed',"if(production.DB&&(production.DB===DB))return refusal('context_contradictory',{field:'DB'});",""],
  ['denied bindings readable',"if(typeof name==='string'&&DENIED.includes(name)){state.stats.denied++;throw deniedError(name);}",""],
  ['unknown keys settable',"if(!ALLOWED.has(name)){state.stats.denied++;throw deniedError(String(name));}",""],
  ['bucket identity not compared',"if(record?.domain!==DOMAIN||record?.resourceId!==resourceId)return refusal('identity_mismatch',{resource:'r2'});",""],
  ['database identity not compared',"if(d1.domain!==DOMAIN||d1.resource_id!==resourceId)return refusal('identity_mismatch',{resource:'d1'});",""],
  ['a used bucket is provisioned',"if((listed?.objects||[]).length)return refusal('domain_not_empty',{resource:'r2'});",""],
  ['a used database is provisioned',"if(row)return refusal('domain_not_empty',{resource:'d1'});",""],
 ];
 for(const [name,from,to] of mutants){
  assert.ok(source.includes(from),'the mutant pattern exists: '+name);
  const failed=await isolationChecks(loadModule(source.replace(from,to)));
  assert.ok(failed.length>0,'the isolation checks catch the mutant "'+name+'"');
 }
}

console.log('EPG diagnostic context: allowlisted and verified before any write, the real seal path unchanged on it, leases and fences stop it as in production, the production-like resources untouched, inert, and every guard mutant caught passed');
