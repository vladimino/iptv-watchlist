// AIR-572 support (not a test): a production-shaped Producer fixture over the sqlite D1 stand-in, membership marker sync/1, and a driver that runs one chain instance by instance
// on the REAL runProducerWorkflow, checking every instance against the metered headroom and every admitted operation against its a-priori ceiling.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as Fence from '../src/canonical-producer-fence.js';
import * as Chain from '../src/canonical-producer-chain.js';
import {runProducerWorkflow} from '../src/canonical-producer-workflow.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-producer-budget-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
export const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
export const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
export const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
export const AT='2026-11-16T10:00:00.000Z';
export const P='run-p';
const template=path.join(root,'t.sqlite');
assert.equal(sqlite(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
let n=0;
function database(){
 const file=path.join(root,'b-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 assert.equal(sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='run-p',generation=10 WHERE id=1").status,0);
 return file;
}
const envOf=file=>({DB:d1Standin(file)});
// AIR-572 RCA (production 24 Nov 2026, P518, 4,042 units): (a) the stop/hand-off lost its revision CAS because the fence was COPIED after the release pin while the slice commits renewed the
// lease through the original object (`producer_cas_lost`), and (b) the instance stopped `producer_budget_infeasible` after its first full invocation (about 37 statements per unit). Since the
// fix every Producer operation is admitted at an a-priori ceiling with the end reserve kept, on ONE instance meter (claim and end path included).
// Fixture on the REAL Workflow path, membership marker `sync`/1 as deployed: heterogeneous units (0 to 12 actors, 1 to 3 directors, one Film over the credit cap = a planner refusal),
// then a second generation in which only the LAST films change (cheap no-ops first, expensive credit changes later). Asserted per instance: total metered spend inside the headroom,
// each admitted operation's real cost under its ceiling, the end path under the reserve; and the chain completes with every unit durable, no shadow Film, membership untouched.
export const producerFixture=(file,generation,{changed=0,run='run-p'}={})=>{
 const films=[];
 for(let i=1;i<=40;i++){
  const swap=generation>10&&i>40-changed;
  const n=i%5===0?51:i%13;
  films.push({id:'tmdb_'+i,title:'Film '+i,directors:Array.from({length:1+(i%3)},(_,d)=>({id:'director/d'+i+'_'+d,name:'Director'})),actors:Array.from({length:n},(_,c)=>({id:'actor/a'+(i*100+c+(swap?50:0)),name:'Actor'}))});
 }
 const doc=JSON.stringify({films}).replace(/'/g,"''");
 return "DELETE FROM published_epg_member;DELETE FROM published_epg_document;"+
  (run==='run-p'?'':"INSERT OR IGNORE INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('"+run+"','published','"+AT+"','"+'8'.repeat(64)+"','"+AT+"');")+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('"+run+"','programme',0,'{\"films\":[]}'),('"+run+"','watchlist',0,'"+doc+"');"+
  "INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES "+films.map((f,i)=>"('"+run+"','watchlist',"+i+",'"+f.id+"')").join(',')+";"+
  "UPDATE published_epg_authority SET programme_run_id='"+run+"',generation="+generation+" WHERE id=1;";
};
export function producerWorld({loseReceiptResponses=0}={}){
 const file=database();
 const empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 assert.equal(sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');"+
  "UPDATE watchlist_membership_authority SET mode='sync',generation=1 WHERE id=1;"+
  "INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:tmdb:999',1,'Kept by the Sync','"+AT+"');INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:999','"+AT+"');"+
  "INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+'7'.repeat(64)+"','"+AT+"');"+
  producerFixture(file,10)).status,0);
 const meter={calls:0,statements:0};
 const base=envOf(file);
 // `loseReceiptResponses`: the first N batches that write a receipt COMMIT and then lose their response (a D1 transport failure after the commit), which leaves real open receipts
 // for the reconcile of ADR 0141 T-10 to settle.
 const lost={left:loseReceiptResponses,count:0};
 const counted=new Proxy(base.DB,{get(db,prop){if(prop==='prepare')return sql=>{meter.calls++;meter.statements++;return db.prepare(sql);};
  if(prop==='batch')return async list=>{meter.calls++;const out=await db.batch(list);if(lost.left>0&&list.some(item=>/INSERT INTO canonical_write_receipt/.test(item?.text||''))){lost.left--;lost.count++;throw new Error('Network connection lost.');}return out;};
  const v=Reflect.get(db,prop,db);return typeof v==='function'?v.bind(db):v;}});
 const created=[];
 return {file,meter,created,lost,env:{DB:counted,PRODUCER_WORKFLOW:{create:async({id,params})=>{created.push({id,params});}}}};
}
// Runs one chain to its end; checks every instance against the headroom of `limitCalls` and every admitted operation against its ceiling.
export async function driveChain(world,{generation,limitCalls,maxInstances=400,programmeRunId=P,recover=false}={}){
 const {env,meter,created}=world;
 const cap=Fence.CHAIN_HEADROOM*(limitCalls??Fence.CHAIN_SUBREQUEST_LIMIT);
 const existing=await Chain.readChain(env,programmeRunId);
 const launched=existing?{epoch:existing.owner_epoch}:await Chain.launchChain(env,{programmeRunId,generation,at:AT,nowMs:Date.parse(AT)});
 let epoch=launched.epoch||1,last,instances=0,recovered=0;
 const reasons=new Set(),ops=new Map(),trace=[];
 for(;instances<maxInstances;){
  const start=meter.calls,startSt=meter.statements;
  let prev=null;const seq=[];
  const observe=(op,detail,spent)=>{
   if(prev&&prev.op!=='end'){
    const real=spent.calls-prev.spent.calls,ceiling=prev.op==='end'?0:prev.cost;
    assert.ok(real<=ceiling,'operation '+prev.op+' '+JSON.stringify(prev.detail)+' cost '+real+' > ceiling '+ceiling);
    ops.set(prev.op,Math.max(ops.get(prev.op)||0,real));
   }
   if(op==='end'){assert.ok(spent.calls<=cap&&spent.statements<=cap,'instance spend '+spent.calls+'/'+spent.statements+' within '+cap);trace.push(seq.join('>'));return;}
   if(seq.at(-1)!==op)seq.push(op);
   const cost=op==='receipt'?Fence.operationCost('receipt')*Math.max(1,detail?.count||1):Fence.operationCost(op,detail);
   prev={op,detail,cost,spent};
  };
  last=await runProducerWorkflow(env,{programmeRunId,epoch},{do:(name,fn)=>name==='nonce'?Promise.resolve(crypto.randomUUID()):fn()},{hold:false,limitCalls,observe});
  instances++;
  assert.ok(meter.calls-start<=cap&&meter.statements-startSt<=cap,'instance '+instances+' metered '+(meter.calls-start)+' calls / '+(meter.statements-startSt)+' statements within '+cap);
  if(last.reason)reasons.add(last.reason);
  // `recover`: a transient stop is relaunched as the hourly reconcile does after its backoff (recoverChain), and the chain continues.
  if(recover&&last.state==='stopped'){
   const stopped=await Chain.readChain(env,programmeRunId);
   if(stopped.recovery_class==='transient'||stopped.recovery_class==='receipt'){
    // The receipts' own backoff runs on the real clock: elapse it, as the next hourly tick would find it.
    {const u=sqlite(world.file,"UPDATE canonical_write_receipt SET next_attempt_at='2020-01-01T00:00:00.000Z',attempts=attempts+(state='pending') WHERE state IN ('pending','failed','unknown') AND next_attempt_at IS NOT NULL");assert.equal(u.status,0,u.stderr);}
    const t=Date.parse(stopped.next_attempt_at)+1000;
    const again=await Chain.recoverChain(env,{chain:stopped,generation,at:new Date(t).toISOString(),nowMs:t});
    assert.equal(again.state,'pending',JSON.stringify(again));
    epoch=(await Chain.readChain(env,programmeRunId)).owner_epoch;recovered++;
    continue;
   }
  }
  if(last.state!=='handoff')break;
  assert.equal(last.epoch,epoch+1);epoch=last.epoch;
  assert.equal(created.at(-1).params.epoch,epoch,'the successor is created for the new epoch');
 }
 if(process.env.TRACE_PRODUCER)console.log(JSON.stringify({limitCalls,instances,trace,ops:[...ops]}));
 return {last,instances,reasons,ops,trace,recovered};
}
export const runRow=(file,run='run-p')=>rows(file,"SELECT pass_state,unit_count,n_applied+n_noop+n_kept+n_failed AS done,n_applied,n_noop,n_failed FROM canonical_producer_run WHERE run_key LIKE 'epg:"+run+":%' ORDER BY created_at DESC LIMIT 1")[0];
