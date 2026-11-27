// AIR-497 / ADR 0141: dormant canonical_producer_chain store, GATE, launch/claim/handoff/takeover, RETRY_GATE, marker dormancy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as Fence from '../src/canonical-producer-fence.js';
import * as Chain from '../src/canonical-producer-chain.js';
import {reconcileProducerChain,acquireSealedSnapshot,runProducerWorkflow,PRODUCER_DELIVERY_HOLD,HELD_BY_DELIVERY} from '../src/canonical-producer-workflow.js';
import {producerRequestId} from '../src/canonical-producer-adapters.js';
import {runEpgProducerPass} from '../src/canonical-producer-driver.js';
import * as Store from '../src/canonical-producer-store.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-producer-chain-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const chainFiles=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'t.sqlite');
assert.equal(sqlite(template,chainFiles.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
assert.equal(Number(one(template,'SELECT version FROM schema_contract WHERE id=1')),49,'the whole chain: 0023, 0024 (dormant prediction recovery intent), 0025 (retention scan watermark), 0026 (EPG run certificate), 0027 (identity revoke intent kind) then 0028 (dormant Filter presets authority) then 0029 (dormant Started marks authority) then 0030 (dormant EPG checkpoint authority) then 0031 (dormant Watchlist authority) then 0032 (dormant EPG Channel authority), 0035 (dormant import receipts), 0036 (lookup indexes), 0037 (dormant Watchlist membership projection), 0038 (Producer outcome outbox, ADR 0208), 0039 (dormant receipt operation key, AIR-600), 0040 (retirement ledger movie_id index, AIR-667), 0041 (dormant identity evidence ledger, ADR 0213), 0042 (dormant identity evidence writer control, ADR 0215), 0043 (film_redirect target index, AIR-647)');
assert.equal(Number(one(template,'SELECT COUNT(*) FROM canonical_producer_chain')),0);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
let n=0;
function database(stage='open'){
 const file=path.join(root,'c-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 if(stage==='open')assert.equal(sqlite(file,"UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='run-p',generation=10 WHERE id=1").status,0);
 return file;
}
const envOf=file=>({DB:d1Standin(file)});
const AT='2026-11-16T10:00:00.000Z';
// The stuck receipt of the stop test must be a LIVE pending one: the driver abandons a receipt older than `RETRY_POLICY.abandonAfterMs` (7 days) by the REAL clock, so a receipt stamped with the fixed `AT`
// stopped being live at 2026-11-23T10:00Z (AT + 7 days) and the chain completed instead of stopping. It is stamped one hour before the run, so the test no longer depends on the date it runs on.
const STUCK=new Date(Date.now()-3600000).toISOString();
const P='run-p';

{
 const file=database('prepared');
 const before=one(file,'SELECT COUNT(*) FROM canonical_producer_chain');
 const env=envOf(file);
 await assert.rejects(()=>Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)}),error=>error.code==='film_person_unavailable');
 assert.equal(one(file,'SELECT COUNT(*) FROM canonical_producer_chain'),before);
}

{
 const file=database();
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 assert.equal(launched.state,'launched');
 assert.equal(launched.chain.owner_state,'pending');
 assert.equal(launched.epoch,1);
 const nonce='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 const claimed=await Chain.claimChain(env,{programmeRunId:P,epoch:1,instanceId:launched.instanceId,nonce,generation:10,revision:1,at:AT,nowMs:Date.parse(AT)});
 assert.equal(claimed.state,'owned');
 const fence={kind:'chain',programmeRunId:P,epoch:1,nonce,inputGeneration:10,revision:claimed.chain.revision};
 const {fenced}=await import('../src/canonical-mutations.js');
 const gate={generation:2,producerFence:fence};
 const db=env.DB;
 await db.batch([db.prepare(fenced.FENCE).bind(2),db.prepare(Fence.chainGateSql()).bind(...Fence.chainGateParams(fence))]);
 assert.equal(sqlite(file,"UPDATE published_epg_authority SET generation=11 WHERE id=1").status,0);
 let failed=false;
 try{
  await db.batch([db.prepare(fenced.FENCE).bind(2),db.prepare(Fence.chainGateSql()).bind(...Fence.chainGateParams(fence))]);
 }catch{failed=true;}
 assert.equal(failed,true,'a moved generation rolls GATE back');
 assert.equal(one(file,'SELECT owner_state FROM canonical_producer_chain'),'active');
 const stale={...fence,epoch:2};
 failed=false;
 try{await db.batch([db.prepare(fenced.FENCE).bind(2),db.prepare(Fence.chainGateSql()).bind(...Fence.chainGateParams(stale))]);}catch{failed=true;}
 assert.equal(failed,true,'a stale owner fails GATE');
}

{
 const file=database();
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const nonce='11111111-1111-1111-1111-111111111111';
 await Chain.claimChain(env,{programmeRunId:P,epoch:1,instanceId:launched.instanceId,nonce,generation:10,revision:1,at:AT,nowMs:Date.parse(AT)});
 const fence={kind:'chain',programmeRunId:P,epoch:1,nonce,inputGeneration:10,revision:2};
 const hand=await Chain.handoffChain(env,{fence,revision:2,at:AT,nowMs:Date.parse(AT)});
 assert.equal(hand.state,'handed_off');
 assert.equal(hand.epoch,2);
 assert.equal(hand.chain.owner_state,'pending');
}

{
 const file=database();
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const expired=new Date(Date.parse(AT)-10*60000).toISOString();
 assert.equal(sqlite(file,"UPDATE canonical_producer_chain SET lease_expires_at='"+expired+"',revision=revision+1,updated_at='"+AT+"' WHERE programme_run_id='"+P+"'").status,0);
 const chain=await Chain.readChain(env,P);
 const take=await Chain.takeoverChain(env,{chain,generation:10,at:AT,nowMs:Date.parse(AT)});
 assert.equal(take.state,'pending');
 assert.equal(take.epoch,2);
}

{
 const file=database();
 const env=envOf(file);
 const retry=Fence.fenceStatements({kind:'retry',programmeRunId:P,inputGeneration:10});
 const db=env.DB;
 await db.batch([db.prepare(retry[0][0]).bind(...retry[0][1])]);
 await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 let refused=false;
 try{await db.batch([db.prepare(retry[0][0]).bind(...retry[0][1])]);}catch{refused=true;}
 assert.equal(refused,true,'RETRY_GATE refuses while the chain is pending');
}

{
 const created=[];
 const dormant=await reconcileProducerChain({...envOf(database('prepared')),PRODUCER_WORKFLOW:{create:async({id})=>{created.push(id);}}},{now:Date.parse(AT),hold:false});
 assert.equal(dormant.reason,'marker_unreadable');
 assert.equal(created.length,0);
 const noBind=await reconcileProducerChain(envOf(database()),{now:Date.parse(AT),hold:false});
 assert.equal(noBind.reason,'workflow_unavailable');
}

{
 const file=database();
 const sha='a'.repeat(64);
 sqlite(file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:tmdb:3',1,'Gone','"+AT+"');INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:3','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\",\"directors\":[{\"id\":\"director/1\",\"name\":\"One\"}]},{\"id\":\"tmdb_2\",\"title\":\"On air\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\",\"directors\":[{\"id\":\"director/1\",\"name\":\"One\"}]}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1'),('run-p','programme',1,'tmdb_2')");
 const snap=await acquireSealedSnapshot(envOf(file),P);
 assert.equal(snap.ok,true);
 assert.equal(snap.generation,10);
 assert.deepEqual(snap.films.map(item=>item.id),['film:tmdb:1']);
 assert.equal(snap.films[0].facts.watchlist,true);
 assert.deepEqual(snap.departed,['film:tmdb:3'],'a Film dropped from both current documents is released; a TV-only Film is not');
 assert.ok(!snap.departed.includes('film:tmdb:2'));
 assert.equal(snap.personRows[0].id,'person:director/1');
 assert.equal(snap.credits[0].filmId,'film:tmdb:1');
 assert.equal(Fence.snapshotLabel(P,10),'run-p:10');
 const moved=await acquireSealedSnapshot(envOf(file),'other-run');
 assert.equal(moved.ok,false);
}

{
 const d=Fence.successorDecision({spentCalls:100,spentStatements:100,estimateCalls:40,estimateStatements:200});
 assert.equal(d.continue,true);
 const h=Fence.successorDecision({spentCalls:9000,spentStatements:9000,estimateCalls:2000,estimateStatements:2000});
 assert.equal(h.continue,false);
 // AIR-572 (production 24 Nov 2026): a large measured invocation hands over; infeasibility is the FLOOR plus the end reserve against the headroom (ADR 0141 D5), never a measured invocation.
 assert.deepEqual(Fence.successorDecision({spentCalls:37000,spentStatements:37000,estimateCalls:37000,estimateStatements:37000}),{continue:false,reason:'handoff'});
 assert.equal(Fence.successorDecision({spentCalls:0,spentStatements:0,estimateCalls:9000,estimateStatements:9000}).reason,'handoff');
 assert.equal(Fence.successorDecision({limitCalls:500}).reason,'producer_budget_infeasible','floor 200 + reserve 80 do not fit half of 500');
 // A-priori operation ceilings: a unit by kind and credits (two applies plus the slice commit), the end reserve kept on every admission, unknown operations never admitted.
 const C=Fence.CHAIN_COST;
 assert.equal(Fence.operationCost('unit',{kind:'person_mutation'}),2*C.unit.person_mutation+C.flush);
 assert.equal(Fence.operationCost('unit',{kind:'film_credits',credits:50}),2*(C.unit.film_credits+50*C.unit.perCredit)+C.flush);
 assert.equal(Fence.operationCost('unit',{kind:'unknown_kind'}),2*C.unit.other+C.flush);
 assert.equal(Fence.operationCost('unit',{kind:'film_facts',refusal:true}),C.unit.refusal+C.flush);
 assert.equal(Fence.operationCost('teleport'),Infinity);
 const cap=Fence.CHAIN_HEADROOM*Fence.CHAIN_SUBREQUEST_LIMIT;
 assert.equal(Fence.admitOperation({spentCalls:cap-C.end-500,spentStatements:0,cost:500}),true,'exactly at the headroom with the end reserve');
 assert.equal(Fence.admitOperation({spentCalls:cap-C.end-499,spentStatements:0,cost:500}),false);
 assert.equal(Fence.admitOperation({spentCalls:0,spentStatements:cap-C.end-499,cost:500}),false,'statements are bounded too');
 assert.equal(Fence.admitOperation({spentCalls:0,spentStatements:0,cost:Infinity}),false);
 assert.equal(Fence.admitOperation({spentCalls:NaN,spentStatements:0,cost:1}),false);
}

assert.equal(Fence.recoveryClassOf('producer_cas_lost'),'transient');
assert.equal(Fence.recoveryClassOf('receipt_state_conflict'),'receipt');
assert.equal(Fence.recoveryClassOf('producer_store_missing'),'terminal');
assert.equal(Fence.generationOrder('run-p:10','run-p:11'),-1);

assert.match(fs.readFileSync('wrangler.jsonc','utf8'),/"binding": "PRODUCER_WORKFLOW"/);
assert.match(fs.readFileSync('src/epg-orchestration.js','utf8'),/reconcileProducerChain/);
assert.doesNotMatch(fs.readFileSync('src/canonical-producer-workflow.js','utf8').replace(/export async function retryEpgProducerResultsFenced[\s\S]*$/,''),/retryEpgProducerResults\(/,'the chain never calls the unit retry pass');
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/crons.*producer/i);
assert.match(fs.readFileSync('build.mjs','utf8'),/export class ProducerWorkflow/);
assert.equal(Fence.CHAIN_LEASE_MS,5*60000);

{
 const file=database();
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const nonce='22222222-2222-2222-2222-222222222222';
 const claimed=await Chain.claimChain(env,{programmeRunId:P,epoch:1,instanceId:launched.instanceId,nonce,generation:10,revision:1,at:AT,nowMs:Date.parse(AT)});
 const fence={kind:'chain',programmeRunId:P,epoch:1,nonce,inputGeneration:10,revision:claimed.chain.revision};
 env.producerFence=fence;
 const hex='a'.repeat(64);
 const opened=await Store.openEpgRun(env,{runKey:'epg:run-p:10',sourceGeneration:'run-p:10',fingerprint:hex,units:[{kind:'film_facts',id:'film:tmdb:1'}],at:AT});
 assert.equal(opened.state,'created');
 const before=fence.revision;
 env.DB.batch=async()=>{throw new Error('forced rollback');};
 let failed=false;
 try{await Store.commitStrike(env,{run:opened.run,next:{strike_kind:'film_facts',strike_id:'film:tmdb:1',strike_digest:hex,strike_class:'transient',strike_count:1},at:AT});}catch{failed=true;}
 assert.equal(failed,true);
 assert.equal(fence.revision,before,'a rejected batch does not advance the local chain revision');
}

{
 const file=database();
 const sha='b'.repeat(64);
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1')");
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('33333333-3333-3333-3333-333333333333'):fn()},{hold:false});
 assert.equal(result.state,'complete');
 assert.equal(one(file,'SELECT owner_state FROM canonical_producer_chain'),'complete');
 const run=rows(file,"SELECT run_key,source_generation,pass_state FROM canonical_producer_run WHERE origin='epg'")[0];
 assert.equal(run.run_key,'epg:run-p:10');
 assert.equal(run.source_generation,'run-p:10');
 assert.equal(run.pass_state,'passed');
 assert.match(fs.readFileSync('src/canonical-producer-workflow.js','utf8'),/runId:snap\.label/);
}

{
 const file=database();
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const nonce='44444444-4444-4444-4444-444444444444';
 await Chain.claimChain(env,{programmeRunId:P,epoch:1,instanceId:launched.instanceId,nonce,generation:10,revision:1,at:AT,nowMs:Date.parse(AT)});
 env.producerFence={kind:'chain',programmeRunId:P,epoch:1,nonce,inputGeneration:10,revision:2};
 const pass=await runEpgProducerPass(env,{
  runId:'run-p:10',sourceGeneration:'run-p:10',at:AT,films:[],sliceSize:50,maxSlicesPerRun:20,sliceDeadlineMs:270000,
  prerequisites:async()=>({}),generationOrder:Fence.generationOrder,
  inputProvenance:{complete:true,committed:true,sealed:true,publishedGeneration:'run-p:10'},
  beforePassComplete:async()=>({stop:true,code:'receipt_state_conflict'}),
 });
 assert.equal(pass.state,'stopped');
 assert.equal(pass.code,'receipt_state_conflict');
 assert.equal(one(file,"SELECT pass_state FROM canonical_producer_run WHERE origin='epg'"),'stopped');
 assert.equal(one(file,'SELECT owner_state FROM canonical_producer_chain'),'active','unresolved receipts do not claim passed or complete');
}

{
 const file=database();
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const nonce='55555555-5555-5555-5555-555555555555';
 await Chain.claimChain(env,{programmeRunId:P,epoch:1,instanceId:launched.instanceId,nonce,generation:10,revision:1,at:AT,nowMs:Date.parse(AT)});
 env.producerFence={kind:'chain',programmeRunId:P,epoch:1,nonce,inputGeneration:10,revision:2};
 const pass=await runEpgProducerPass(env,{
  runId:'run-p:10',sourceGeneration:'run-p:10',at:AT,films:[],sliceSize:50,maxSlicesPerRun:20,sliceDeadlineMs:270000,
  prerequisites:async()=>({}),generationOrder:Fence.generationOrder,
  inputProvenance:{complete:true,committed:true,sealed:true,publishedGeneration:'run-p:10'},
  beforePassComplete:async()=>{assert.equal(sqlite(file,"UPDATE published_epg_authority SET generation=11 WHERE id=1").status,0);},
 });
 assert.equal(pass.state,'stopped');
 assert.notEqual(one(file,"SELECT pass_state FROM canonical_producer_run WHERE origin='epg'"),'passed');
 assert.equal(one(file,'SELECT owner_state FROM canonical_producer_chain'),'active');
}

{
 const file=database();
 const sha='c'.repeat(64);
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1')");
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const snap=await acquireSealedSnapshot(env,P);
 const prior=await runEpgProducerPass(env,{
  runId:snap.label,sourceGeneration:snap.label,at:AT,films:snap.films,departed:snap.departed,persons:snap.persons,credits:snap.credits,personRows:snap.personRows,
  sliceSize:50,maxSlicesPerRun:20,sliceDeadlineMs:270000,prerequisites:async()=>({}),generationOrder:Fence.generationOrder,
  inputProvenance:{complete:true,committed:true,sealed:true,publishedGeneration:snap.label},
 });
 assert.equal(prior.state,'complete');
 assert.equal(one(file,"SELECT pass_state FROM canonical_producer_run WHERE origin='epg'"),'passed');
 assert.equal(one(file,'SELECT owner_state FROM canonical_producer_chain'),'pending','a pass without the chain GATE does not complete the owner');
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('66666666-6666-6666-6666-666666666666'):fn()},{hold:false});
 assert.equal(result.state,'complete');
 assert.equal(result.pass.state,'already_complete');
 assert.equal(one(file,'SELECT owner_state FROM canonical_producer_chain'),'complete');
}

// AIR-572 budget scenarios on the real Workflow path: tests/canonical-producer-budget.mjs and tests/canonical-producer-budget-boundaries.mjs (shared fixture: canonical-producer-budget-lib.mjs).

// AIR-572 delivery hold: when on, both Producer entrypoints do zero I/O and affect nothing else. The shipped default is now lifted
// (owner-approved, after the Watchlist membership switch to the Letterboxd Sync); the guard itself stays and is exercised explicitly.
{
 assert.equal(PRODUCER_DELIVERY_HOLD,false,'the hold is lifted in code (AIR-572, after the ADR 0203 switch)');
 const touched=[];
 const trap=new Proxy({},{get:(_t,prop)=>{touched.push(String(prop));throw new Error('held entrypoint touched env.'+String(prop));}});
 const cron=await reconcileProducerChain(trap,{now:Date.parse(AT),hold:true});
 assert.deepEqual(cron,{ran:false,reason:HELD_BY_DELIVERY});
 const instance=await runProducerWorkflow(trap,{programmeRunId:P,epoch:1},{do:()=>{touched.push('step');throw new Error('step used');}},{hold:true});
 assert.deepEqual(instance,{state:HELD_BY_DELIVERY});
 assert.deepEqual(touched,[],'no env property, D1 statement, Workflow create or step is reached while held');
 // Only an explicit hold:false lifts it; truthy or unknown values keep it closed.
 for(const value of [true,1,'false',null]){
  const out=await reconcileProducerChain(trap,{now:Date.parse(AT),hold:value});
  assert.equal(out.reason,HELD_BY_DELIVERY);
 }
 // A held cron tick on a real open database changes no row and creates no instance.
 const file=database();
 const created=[];
 const before=one(file,'SELECT COUNT(*) FROM canonical_producer_chain')+':'+one(file,'SELECT COUNT(*) FROM canonical_producer_run');
 const held=await reconcileProducerChain({...envOf(file),PRODUCER_WORKFLOW:{create:async({id})=>{created.push(id);}}},{now:Date.parse(AT),hold:true});
 assert.equal(held.reason,HELD_BY_DELIVERY);
 assert.equal(created.length,0);
 assert.equal(one(file,'SELECT COUNT(*) FROM canonical_producer_chain')+':'+one(file,'SELECT COUNT(*) FROM canonical_producer_run'),before);
 // The hourly EPG caller passes no `hold`, so the shipped default (lifted) applies; the cron path cannot override it either way.
 assert.doesNotMatch(fs.readFileSync('src/epg-orchestration.js','utf8'),/hold\s*:/,'the cron path passes no hold');
 // With the default, the cron tick on an open database is no longer held: it proceeds into the real reconcile.
 const live=await reconcileProducerChain({...envOf(database()),PRODUCER_WORKFLOW:{create:async()=>{}}},{now:Date.parse(AT)});
 assert.notEqual(live.reason,HELD_BY_DELIVERY,'the shipped default does not hold');
}

// AIR-572: a Cloudflare Workflow `step` is an RPC stub whose methods have no `.bind`. The stub below is function-shaped but refuses
// bind/call/apply, so the former `step.do.bind(step)` fails here exactly as it did in production (113/113 instances `errored`, step_count 0).
function rpcStep(){
 const seen=[];
 const method=(name,impl)=>new Proxy(function(){},{apply:(_t,_this,args)=>impl(...args),get:(target,prop)=>prop==='bind'||prop==='call'||prop==='apply'?undefined:Reflect.get(target,prop)});
 const stub=new Proxy({},{get:(_t,prop)=>prop==='do'?method('do',(name,fn)=>{seen.push(name);return name==='nonce'?Promise.resolve('12121212-1212-1212-1212-121212121212'):fn();}):undefined});
 return {stub,seen};
}
{
 const {stub}=rpcStep();
 assert.equal(typeof stub.do,'function');
 assert.throws(()=>stub.do.bind(stub),TypeError,'the stub must not expose bind, so the old code path is reproduced');
 // The legacy expression of the Workflow, run against the same stub, fails with the production TypeError (no step ran).
 const legacyDoStep=step=>typeof step?.do==='function'?step.do.bind(step):(name,fn)=>fn();
 assert.throws(()=>legacyDoStep(stub),TypeError);
}
{
 const file=database();
 const sha='e'.repeat(64);
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1')");
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const {stub,seen}=rpcStep();
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},stub,{hold:false});
 assert.equal(result.state,'complete','the Workflow runs through an RPC-shaped step');
 assert.deepEqual(seen.slice(0,2),['nonce','claim'],'the first steps are the nonce and the claim, in order');
 assert.equal(seen.at(-1),'work');
 assert.equal(one(file,'SELECT owner_state FROM canonical_producer_chain'),'complete');
}

{
 const file=database();
 const sha='d'.repeat(64);
 sqlite(file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:tmdb:3',1,'Gone','"+AT+"');INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:3','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1')");
 const db=d1Standin(file,{onQuery:async text=>{if(/FROM watchlist_film/i.test(text))throw new Error('D1_ERROR: boom');}});
 const snap=await acquireSealedSnapshot({DB:db},P);
 assert.equal(snap.ok,false);
 assert.equal(snap.code,'producer_membership_unreadable');
}

{
 const file=database();
 const sha='e'.repeat(64);
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:tmdb:3',1,'Gone','"+AT+"');INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:3','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1')");
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('77777777-7777-7777-7777-777777777777'):fn()},{hold:false});
 assert.equal(result.state,'complete');
 assert.equal(one(file,'SELECT release_pin FROM canonical_producer_chain'),'film:tmdb:3');
 sqlite(file,"DELETE FROM watchlist_film");
 const pinned=await acquireSealedSnapshot(env,P,{previousIds:Chain.parseReleasePin(one(file,'SELECT release_pin FROM canonical_producer_chain'))});
 assert.deepEqual(pinned.departed,['film:tmdb:3'],'a later membership apply does not change the pinned release set');
 const live=await acquireSealedSnapshot(env,P);
 assert.deepEqual(live.departed,[],'live watchlist_film after a release would otherwise empty the set');
}

{
 const file=database();
 const sha='f'.repeat(64);
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 const due='2020-01-01T00:00:00.000Z';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1')");
 const inserts=[];
 for(let i=0;i<21;i++){
  const digest=i.toString(16).padStart(64,'0');
  const requestId=await producerRequestId({origin:'epg',event:'epg:run-p:10',target:{kind:'film',id:'film:tmdb:1'},digest});
  inserts.push("INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('"+requestId+"','film_facts','epg','film','film:tmdb:1','"+digest+"',0,2,'pending',1,'"+due+"','"+AT+"','"+AT+"')");
 }
 assert.equal(sqlite(file,inserts.join(';')).status,0);
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('88888888-8888-8888-8888-888888888888'):fn()},{hold:false});
 assert.equal(result.state,'complete','a backlog larger than one inline page is drained before claim');
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE state='abandoned'")),21);
}

{
 const file=database();
 const sha='1'.repeat(64);
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1');"+
  "INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('epg:stuck','film_facts','epg','film','film:tmdb:stuck','"+'b'.repeat(64)+"',0,2,'pending',1,'2020-01-01T00:00:00.000Z','"+STUCK+"','"+STUCK+"')");
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('99999999-9999-9999-9999-999999999999'):fn()},{hold:false});
 assert.equal(result.state,'stopped');
 assert.equal(result.code,'receipt_state_conflict');
 assert.equal(one(file,'SELECT owner_state FROM canonical_producer_chain'),'stopped');
 assert.match(fs.readFileSync('src/canonical-producer-workflow.js','utf8'),/RECEIPT_PAGES/);
}

{
 const file=database();
 const sha='2'.repeat(64);
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:tmdb:3',1,'Gone','"+AT+"');INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:3','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1')");
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const first=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'):fn()},{hold:false});
 assert.equal(first.state,'complete');
 assert.equal(one(file,'SELECT release_pin FROM canonical_producer_chain'),'film:tmdb:3');
 assert.equal(sqlite(file,"UPDATE published_epg_authority SET generation=11 WHERE id=1").status,0);
 const chain=await Chain.readChain(env,P);
 const reopened=await Chain.reopenChain(env,{chain,generation:11,at:AT,nowMs:Date.parse(AT)});
 assert.equal(reopened.state,'pending');
 assert.equal(reopened.chain.release_pin,null,'a new generation drops the old pin');
 sqlite(file,"DELETE FROM watchlist_film;INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:1','"+AT+"')");
 sqlite(file,"DELETE FROM published_epg_document;INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[]}'),('run-p','watchlist',0,'{\"films\":[]}');DELETE FROM published_epg_member");
 const claimed=await Chain.claimChain(env,{programmeRunId:P,epoch:reopened.epoch,instanceId:reopened.instanceId,nonce:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',generation:11,revision:reopened.chain.revision,at:AT,nowMs:Date.parse(AT)});
 assert.equal(claimed.state,'owned');
 const snap=await acquireSealedSnapshot(env,P);
 assert.deepEqual(snap.departed,['film:tmdb:1'],'after the pin is cleared the new generation releases A');
}

{
 const file=database();
 const sha='3'.repeat(64);
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1')");
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const first=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('cccccccc-cccc-cccc-cccc-cccccccccccc'):fn()},{hold:false});
 assert.equal(first.state,'complete');
 assert.equal(one(file,'SELECT release_pin FROM canonical_producer_chain'),'empty');
 sqlite(file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:tmdb:9',1,'Later','"+AT+"');INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:9','"+AT+"')");
 const live=await acquireSealedSnapshot(env,P);
 assert.deepEqual(live.departed,['film:tmdb:9']);
 const pinned=await acquireSealedSnapshot(env,P,{previousIds:Chain.parseReleasePin(one(file,'SELECT release_pin FROM canonical_producer_chain'))});
 assert.deepEqual(pinned.departed,[],'an empty pin is a frozen empty set, not a missing pin');
}

{
 const file=database();
 const sha='4'.repeat(64);
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 const tomorrow=new Date(Date.now()+24*60*60*1000).toISOString(); // a TRUE future due time by the real clock the driver uses (a fixed date went into the past and stopped covering the future-due branch)
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1');"+
  "INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('epg:future','film_facts','epg','film','film:tmdb:stuck','"+'c'.repeat(64)+"',0,2,'pending',1,'"+tomorrow+"','"+STUCK+"','"+STUCK+"')");
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('dddddddd-dddd-dddd-dddd-dddddddddddd'):fn()},{hold:false});
 assert.equal(result.state,'stopped');
 assert.equal(result.code,'receipt_state_conflict','a future-due epg receipt still blocks current');
}

// ---- AIR-572 identity: a bare Letterboxd lid is resolved through trusted claims, never turned into a Film by spelling.
import {resolveIdentity,resolveSourceIdentities,IDENTITY_LOOKUP_CAP} from '../src/canonical-producer-workflow.js';
function publish(file,rawIds,{films}={}){
 const sha='f'.repeat(64);
 const docFilms=(films||rawIds.map(id=>({id,title:'T '+id}))).map(film=>JSON.stringify(film).replace(/'/g,"''"));
 const members=rawIds.map((id,ordinal)=>"('run-p','watchlist',"+ordinal+",'"+id+"')").join(',');
 sqlite(file,"INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[]}'),('run-p','watchlist',0,'{\"films\":["+docFilms.join(',')+"]}');"+
  (members?"INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES "+members+";":''));
}
const addFilm=(file,id)=>sqlite(file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('"+id+"',1,'"+id+"','"+AT+"')");
const addClaim=(file,filmId,lid,trusted=1,conflicting=0)=>sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+filmId+"','letterboxd','"+lid+"',"+trusted+","+conflicting+")");

// Pure decisions.
assert.equal(resolveIdentity('tmdb_5').target,'film:tmdb:5');
assert.equal(resolveIdentity('film:x').target,'film:x');
assert.equal(resolveIdentity('lid1',{claims:[{film_id:'film:tmdb:7',trusted:1,conflicting:0}]}).target,'film:tmdb:7');
assert.equal(resolveIdentity('lid1',{films:new Set(['film:lid1'])}).target,'film:lid1');
assert.deepEqual(resolveIdentity('lid1',{}),{refused:'producer_identity_unresolved'},'no claim and no existing Film: never created from a spelling');
assert.deepEqual(resolveIdentity('lid1',{claims:[{film_id:'film:tmdb:7',trusted:0,conflicting:0}]}),{refused:'producer_identity_ambiguous'});
assert.deepEqual(resolveIdentity('lid1',{claims:[{film_id:'film:tmdb:7',trusted:1,conflicting:0},{film_id:'film:tmdb:8',trusted:0,conflicting:1}]}),{refused:'producer_identity_ambiguous'});
assert.equal(resolveIdentity('lid1',{claims:[{film_id:'film:tmdb:7',trusted:1,conflicting:0}],redirects:new Map([['film:tmdb:7','film:tmdb:9']])}).target,'film:tmdb:9');
assert.deepEqual(resolveIdentity('lid1',{claims:[{film_id:'film:tmdb:7',trusted:1,conflicting:0}],redirects:new Map([['film:tmdb:7','film:tmdb:9'],['film:tmdb:9','film:tmdb:10']])}),{refused:'producer_identity_redirect_chain'});
assert.deepEqual(resolveIdentity('tmdb_5',{redirects:new Map([['film:tmdb:5','film:tmdb:6']])}),{refused:'producer_identity_ambiguous'},'AIR-671: the minting spelling of an unclaimed movie id is not followed through a redirect');
assert.equal(resolveIdentity('film:tmdb:5',{redirects:new Map([['film:tmdb:5','film:tmdb:6']])}).target,'film:tmdb:6','an explicit Film id still follows its redirect');

// Historical mixed fixture (21.11): 386 canonical film:<lid> + 9 existing film:tmdb:<n> with trusted Letterboxd claims -> 395 unique existing owners, 0 shadow Films.
{
 const file=database();
 const own=Array.from({length:386},(_v,i)=>'own'+String(i).padStart(3,'0'));
 const claimed=Array.from({length:9},(_v,i)=>'clm'+i);
 own.forEach(lid=>addFilm(file,'film:'+lid));
 claimed.forEach((lid,i)=>{addFilm(file,'film:tmdb:'+(100+i));addClaim(file,'film:tmdb:'+(100+i),lid);});
 const sources=[...own,...claimed];
 publish(file,sources);
 const filmsBefore=Number(one(file,'SELECT COUNT(*) FROM film'));
 const env=envOf(file);
 const snap=await acquireSealedSnapshot(env,P,{previousIds:[]});
 assert.equal(snap.ok,true);
 assert.equal(snap.films.length,395);
 assert.equal(new Set(snap.films.map(film=>film.id)).size,395,'395 source lids -> 395 unique targets');
 const ids=new Set(snap.films.map(film=>film.id));
 claimed.forEach((lid,i)=>{assert.ok(ids.has('film:tmdb:'+(100+i)));assert.ok(!ids.has('film:'+lid),'no shadow target film:'+lid);});
 own.forEach(lid=>assert.ok(ids.has('film:'+lid)));
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM film')),filmsBefore,'resolving writes nothing');
 // Released Films: a previously listed owner that is still listed through its claim is NOT departed.
 const again=await acquireSealedSnapshot(env,P,{previousIds:['film:tmdb:100','film:gone']});
 assert.deepEqual(again.departed,['film:gone']);
 // Duplicate same-owner: a lid and its owner's own tmdb id both listed -> one unit.
 const file2=database();
 addFilm(file2,'film:tmdb:5');addClaim(file2,'film:tmdb:5','dup1');
 publish(file2,['dup1','tmdb_5']);
 const dup=await acquireSealedSnapshot(envOf(file2),P,{previousIds:[]});
 assert.deepEqual(dup.films.map(film=>film.id),['film:tmdb:5']);
}

// Refusals fail the snapshot closed by name; nothing is written and nothing is dropped as departed.
for(const [label,setup,expected] of [
 ['unresolved',file=>{},'producer_identity_unresolved'],
 ['untrusted claim',file=>{addFilm(file,'film:tmdb:5');addClaim(file,'film:tmdb:5','lidx',0,0);},'producer_identity_ambiguous'],
 ['conflicting claim',file=>{addFilm(file,'film:tmdb:5');addFilm(file,'film:tmdb:6');addClaim(file,'film:tmdb:5','lidx');addClaim(file,'film:tmdb:6','lidx',0,1);},'producer_identity_ambiguous'],
]){
 const file=database();
 setup(file);
 publish(file,['tmdb_9','lidx']);
 const filmsBefore=Number(one(file,'SELECT COUNT(*) FROM film'));
 const snap=await acquireSealedSnapshot(envOf(file),P,{previousIds:['film:tmdb:1']});
 assert.equal(snap.ok,false,label);
 assert.equal(snap.code,expected,label);
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM film')),filmsBefore,label+': no Film created');
}
{
 // Redirect and bounds.
 const file=database();
 addFilm(file,'film:tmdb:5');addFilm(file,'film:tmdb:6');addClaim(file,'film:tmdb:5','lidr');
 sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:5','film:tmdb:6','"+AT+"')");
 const out=await resolveSourceIdentities(envOf(file),['lidr','tmdb_6']);
 assert.equal(out.ok,true);
 assert.equal(out.resolved.get('lidr'),'film:tmdb:6','a claim owner that was merged resolves to the survivor');
 const many=await resolveSourceIdentities(envOf(file),Array.from({length:IDENTITY_LOOKUP_CAP+1},(_v,i)=>'l'+i));
 assert.deepEqual([many.ok,many.code],[false,'producer_identity_bounded']);
 const empty=await resolveSourceIdentities(envOf(file),[]);
 assert.equal(empty.ok,true);
 assert.equal(empty.resolved.size,0);
 const broken=await resolveSourceIdentities({DB:{prepare(){throw new Error('x');}}},['lid']);
 assert.deepEqual([broken.ok,broken.code],[false,'producer_identity_unreadable']);
}
// Whole Workflow on a collision: facts and membership land on the existing owner, no shadow Film is created, the chain completes.
{
 const file=database();
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"')");
 addFilm(file,'film:tmdb:55');addClaim(file,'film:tmdb:55','collide1');
 publish(file,['collide1'],{films:[{id:'collide1',title:'Collide'}]});
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('13131313-1313-1313-1313-131313131313'):fn()},{hold:false});
 assert.equal(result.state,'complete');
 assert.equal(one(file,'SELECT COUNT(*) FROM film'),1,'no shadow Film');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:collide1'"),0);
 assert.equal(one(file,'SELECT film_id FROM watchlist_film'),'film:tmdb:55','membership is the existing owner');
}
// Whole Workflow on a refusal: the chain is stopped by name on the record and no Film or membership row is written.
{
 const file=database();
 publish(file,['nobody']);
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('14141414-1414-1414-1414-141414141414'):fn()},{hold:false});
 assert.equal(result.state,'stopped');
 assert.equal(result.code,'producer_identity_unresolved');
 assert.equal(one(file,'SELECT owner_state FROM canonical_producer_chain'),'stopped');
 assert.equal(one(file,'SELECT stopped_by FROM canonical_producer_chain'),'producer_identity_unresolved');
 assert.equal(one(file,'SELECT COUNT(*) FROM film'),0);
 assert.equal(one(file,'SELECT COUNT(*) FROM watchlist_film'),0);
}

// ---- AIR-572 review P1: the identity proof is asserted INSIDE the write batch (a second SELECT is not enough). The race is injected exactly between the plan
// and the first write batch by changing the claim / redirect through a wrapped D1 `batch`.
{
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 const seed=(file,sources,films)=>{
  sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"')");
  films(file);
  publish(file,sources,{films:sources.map(id=>({id,title:'T',directors:[{id:'p1',name:'Dir'}]}))});
 };
 async function race(label,{sources,films,change,trigger=/INSERT INTO (film \(|watchlist_film )/}){
  const file=database();
  seed(file,sources,films);
  let raced=false;
  const env={DB:d1Standin(file,{onBatch:async statements=>{
   if(!raced&&statements.some(item=>trigger.test(item.text))){raced=true;change(file);}
  }})};
  const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
  const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('15151515-1515-1515-1515-151515151515'):fn()},{hold:false});
  return {file,result,raced};
 }
 // 1. A competing (untrusted) claim for the lid appears after the plan: nothing is written to the owner.
 {
  const {file,result,raced}=await race('competing claim',{sources:['racel1'],
   films:f=>{addFilm(f,'film:tmdb:70');addClaim(f,'film:tmdb:70','racel1');},
   change:f=>{addFilm(f,'film:tmdb:71');addClaim(f,'film:tmdb:71','racel1',0,1);}});
  assert.equal(raced,true,'the race ran between the plan and the first write batch');
  assert.notEqual(result.state,'complete');
  assert.equal(one(file,'SELECT COUNT(*) FROM watchlist_film'),0,'no membership written under a changed claim');
 }
 // 2. The owner's claim is removed after the plan.
 {
  const {file,result,raced}=await race('claim removed',{sources:['racel2'],
   films:f=>{addFilm(f,'film:tmdb:72');addClaim(f,'film:tmdb:72','racel2');},
   change:f=>sqlite(f,"DELETE FROM film_external_id WHERE value='racel2'")});
  assert.equal(raced,true);assert.notEqual(result.state,'complete');
  assert.equal(one(file,'SELECT COUNT(*) FROM watchlist_film'),0);
 }
 // 3. A Film addressed by its own name (no claim): another Film claims the lid after the plan.
 {
  const {file,result,raced}=await race('own then claimed',{sources:['racel3'],
   films:f=>addFilm(f,'film:racel3'),
   change:f=>{addFilm(f,'film:tmdb:73');addClaim(f,'film:tmdb:73','racel3');}});
  assert.equal(raced,true);assert.notEqual(result.state,'complete');
  assert.equal(one(file,'SELECT COUNT(*) FROM watchlist_film'),0,'the lid-named Film is not written once another Film owns the lid');
 }
 // 4. A followed redirect disappears after the plan.
 {
  const {file,result,raced}=await race('redirect removed',{sources:['racel4'],
   films:f=>{addFilm(f,'film:tmdb:74');addFilm(f,'film:tmdb:75');addClaim(f,'film:tmdb:74','racel4');sqlite(f,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:74','film:tmdb:75','"+AT+"')");},
   change:f=>sqlite(f,"DELETE FROM film_redirect")});
  assert.equal(raced,true);assert.notEqual(result.state,'complete');
  assert.equal(one(file,'SELECT COUNT(*) FROM watchlist_film'),0);
 }
 // 4b. The credits write (a later unit; film_facts already applied) carries the same proof: a claim that changes right before the credit batch blocks it.
 {
  const {file,result,raced}=await race('claim changes before credits',{sources:['racel6'],
   films:f=>{addFilm(f,'film:tmdb:77');addClaim(f,'film:tmdb:77','racel6');},
   trigger:/INSERT INTO film_person_credit /,
   change:f=>{addFilm(f,'film:tmdb:78');addClaim(f,'film:tmdb:78','racel6',0,1);}});
  assert.equal(raced,true,'the credit batch was reached');
  assert.notEqual(result.state,'complete');
  assert.equal(one(file,'SELECT COUNT(*) FROM film_person_credit'),0,'no credit written under a changed claim');
 }
 // 5. Control: with no change the same pass completes and writes the owner (so the guards above are what blocked it).
 {
  const {file,result}=await race('control',{sources:['racel5'],
   films:f=>{addFilm(f,'film:tmdb:76');addClaim(f,'film:tmdb:76','racel5');},change:()=>{}});
  assert.equal(result.state,'complete');
  assert.equal(one(file,'SELECT film_id FROM watchlist_film'),'film:tmdb:76');
  assert.equal(one(file,'SELECT COUNT(*) FROM film'),1);
 }
}

// Receipt replay: the re-plan of a stored receipt returns the unit input WITH its proofs (so a replayed write asserts them again), and the proofs are not content (the digest is the same with or without them).
{
 const {planEpgUnits,epgReplan}=await import('../src/canonical-epg-producer.js');
 const {filmFactsDigest}=await import('../src/canonical-producer-adapters.js');
 const guard={sql:'EXISTS (SELECT 1 FROM film WHERE id=?)',params:['film:tmdb:1']};
 const plan=planEpgUnits({runId:'run-r',at:AT,films:[{id:'film:tmdb:1',facts:{film:{contractVersion:1},watchlist:true,guards:[guard]}}]});
 const input=plan.units[0].input;
 const digest=await filmFactsDigest(input);
 assert.equal(digest,await filmFactsDigest({...input,guards:undefined}),'guards are not content');
 const requestId=await producerRequestId({origin:'epg',event:plan.event,target:{kind:'film',id:'film:tmdb:1'},digest});
 const replanned=await epgReplan(plan)({target:{kind:'film',id:'film:tmdb:1'},contentDigest:digest,requestId});
 assert.deepEqual(replanned.guards,[guard]);
}

// Review P2: the Monitor's D1 read of the Producer is exactly three SQL statements, all reads, counted on the prepared SQL against the real schema (no table inventory, no schema read, no write).
{
 const {readProducerMonitorFacts}=await import('../src/canonical-producer-workflow.js');
 const file=database();
 const seen=[];
 const env={DB:d1Standin(file,{onQuery:async text=>{seen.push(text);}})};
 publish(file,[]);
 const idle=await readProducerMonitorFacts(env);
 assert.equal(idle.ready,true);
 assert.equal(seen.length,3,'authority row (with its generation), chain by primary key, run by index: three statements, got '+seen.length);
 assert.ok(seen.every(text=>/^\s*SELECT/i.test(text)),'every statement is a read');
 assert.ok(!seen.some(text=>/sqlite_master|schema_contract/i.test(text)),'no install inventory or schema read');
 seen.length=0;
 await Chain.launchChain(envOf(file),{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const withChain=await readProducerMonitorFacts(env);
 assert.equal(seen.length,3);
 assert.equal(withChain.chain.owner_state,'pending');
 assert.equal(withChain.label,'run-p:10');
 // A dormant marker names nothing and reads one statement only.
 const prepared=database('prepared');
 const none=[];
 const closed=await readProducerMonitorFacts({DB:d1Standin(prepared,{onQuery:async text=>{none.push(text);}})});
 assert.equal(closed.ready,false);
 assert.equal(none.length,1);
}
