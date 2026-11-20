// AIR-497 / ADR 0141: dormant canonical_producer_chain store, GATE, launch/claim/handoff/takeover, RETRY_GATE, marker dormancy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as Fence from '../src/canonical-producer-fence.js';
import * as Chain from '../src/canonical-producer-chain.js';
import {reconcileProducerChain,acquireSealedSnapshot,runProducerWorkflow} from '../src/canonical-producer-workflow.js';
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
assert.equal(Number(one(template,'SELECT version FROM schema_contract WHERE id=1')),29,'the whole chain: 0023, 0024 (dormant prediction recovery intent), 0025 (retention scan watermark), 0026 (EPG run certificate), 0027 (identity revoke intent kind) then 0028 (dormant Filter presets authority) then 0029 (dormant Started marks authority)');
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
 const dormant=await reconcileProducerChain({...envOf(database('prepared')),PRODUCER_WORKFLOW:{create:async({id})=>{created.push(id);}}},{now:Date.parse(AT)});
 assert.equal(dormant.reason,'marker_unreadable');
 assert.equal(created.length,0);
 const noBind=await reconcileProducerChain(envOf(database()),{now:Date.parse(AT)});
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
 const inf=Fence.successorDecision({spentCalls:0,spentStatements:0,estimateCalls:9000,estimateStatements:9000});
 assert.equal(inf.reason,'producer_budget_infeasible');
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
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('33333333-3333-3333-3333-333333333333'):fn()});
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
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('66666666-6666-6666-6666-666666666666'):fn()});
 assert.equal(result.state,'complete');
 assert.equal(result.pass.state,'already_complete');
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
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('77777777-7777-7777-7777-777777777777'):fn()});
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
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('88888888-8888-8888-8888-888888888888'):fn()});
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
  "INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('epg:stuck','film_facts','epg','film','film:tmdb:stuck','"+'b'.repeat(64)+"',0,2,'pending',1,'2020-01-01T00:00:00.000Z','"+AT+"','"+AT+"')");
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('99999999-9999-9999-9999-999999999999'):fn()});
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
 const first=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'):fn()});
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
 const first=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('cccccccc-cccc-cccc-cccc-cccccccccccc'):fn()});
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
 const tomorrow='2026-11-17T12:00:00.000Z';
 sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_1\",\"title\":\"A\"}]}');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_1'),('run-p','programme',0,'tmdb_1');"+
  "INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('epg:future','film_facts','epg','film','film:tmdb:stuck','"+'c'.repeat(64)+"',0,2,'pending',1,'"+tomorrow+"','"+AT+"','"+AT+"')");
 const env=envOf(file);
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 const result=await runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve('dddddddd-dddd-dddd-dddd-dddddddddddd'):fn()});
 assert.equal(result.state,'stopped');
 assert.equal(result.code,'receipt_state_conflict','a future-due epg receipt still blocks current');
}
