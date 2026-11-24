// AIR-588 (A1): request-scoped reuse of the schema-shape probes, and the read-only check of a young claim and of a young persist gate in a Task's synchronous start.
// Offline: the real `src/prediction-d1.js` request scope over a sqlite D1 stand-in, and the real Worker over the flow world. No Cloudflare, model or production call.
import assert from 'node:assert/strict';
import * as PredictionD1 from '../src/prediction-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {flowWorld,sql,migrated} from './prediction-d1-flow-lib.mjs';

// 1. The probe cache of one request scope.
{
 const made=migrated();const file=made.file||made;
 const seen=[];const base=d1Standin(file,{onQuery:text=>{seen.push(text);}});
 const count=re=>seen.filter(text=>re.test(text)).length;
 const env=PredictionD1.scopeRequest({DB:base});
 const db=env.DB;
 const version='SELECT version FROM schema_contract WHERE id=1';
 const tables="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('prediction_run','prediction_lease')";
 // the same probe twice: one round trip, equal answers, and a caller that mutates its answer does not change the next one
 const a=await db.prepare(version).bind().first();const b=await db.prepare(version).bind().first();
 assert.deepEqual(a,b);assert.equal(count(/FROM schema_contract/),1,'the contract probe is read once inside the scope');
 a.version=-1;assert.notEqual((await db.prepare(version).bind().first()).version,-1,'an answer is a copy');
 const t1=await db.prepare(tables).bind().all(),t2=await db.prepare(tables).all();
 assert.deepEqual(t1.results,t2.results);assert.equal(count(/FROM sqlite_master/),1,'bound and unbound forms of the same probe share one read');
 // other bind arguments, or another method, are another probe
 const named="SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?";
 await db.prepare(named).bind('prediction_run').first();await db.prepare(named).bind('prediction_lease').first();await db.prepare(named).bind('prediction_run').first();
 assert.equal(seen.filter(text=>/name='prediction_run'/.test(text)&&/SELECT 1 AS present/.test(text)).length,1);assert.equal(seen.filter(text=>/name='prediction_lease'/.test(text)&&/SELECT 1 AS present/.test(text)).length,1);
 // a domain marker is never a probe: every read reaches the database
 const marker='SELECT mode, generation FROM discovery_authority WHERE id=1';
 await db.prepare(marker).bind().first();await db.prepare(marker).bind().first();
 assert.equal(count(/FROM discovery_authority/),2,'a domain marker row is read every time');
 // not probes: another table in the statement, a comma-joined FROM list, a comment, a subquery on another table
 for(const text of [
  "SELECT m.name FROM sqlite_master m JOIN prediction_run r ON r.run_id=m.name",
  "SELECT name FROM sqlite_master, prediction_run",
  "SELECT version FROM schema_contract WHERE id=1 -- c",
  "SELECT (SELECT COUNT(*) FROM prediction_run) AS n, (SELECT version FROM schema_contract WHERE id=1) AS v",
 ]){
  const before=seen.length;await db.prepare(text).bind().all().catch(()=>null);await db.prepare(text).bind().all().catch(()=>null);
  assert.equal(seen.length-before,2,'not a probe, read twice: '+text);
 }
 // Review P2: a marker read that hides behind a quoted, qualified or table-valued source is never a probe, and a marker change is visible between two such reads in one scope
 {
  const mixed='SELECT (SELECT generation FROM "discovery_authority" WHERE id=1) AS generation, (SELECT version FROM schema_contract WHERE id=1) AS version';
  const g1=(await db.prepare(mixed).bind().first()).generation;
  sql(file,'UPDATE discovery_authority SET generation=generation+7 WHERE id=1');
  const g2=(await db.prepare(mixed).bind().first()).generation;
  assert.equal(g2,g1+7,'the marker change is visible: the mixed statement was read twice, not reused');
  for(const text of [
   'SELECT name FROM "sqlite_master"',
   "SELECT name FROM main.sqlite_master WHERE type='table'",
   'SELECT name FROM `sqlite_master`',
   'SELECT name FROM [sqlite_master]',
   "SELECT name FROM pragma_table_list WHERE name='prediction_run'",
   'SELECT (SELECT mode FROM discovery_authority WHERE id=1) AS mode,(SELECT version FROM schema_contract WHERE id=1) AS version',
   "SELECT version FROM schema_contract WHERE id=1 AND (SELECT COUNT(*) FROM \"prediction_run\")>=0",
  ]){
   const before=seen.length;await db.prepare(text).bind().all().catch(()=>null);await db.prepare(text).bind().all().catch(()=>null);
   assert.equal(seen.length-before,2,'not a probe, read twice: '+text);
  }
  // a literal that merely contains a quote or a table name does not hide a source: still recognized
  const literal="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a\"b','discovery_authority')";
  {const before=seen.length;await db.prepare(literal).bind().all();await db.prepare(literal).bind().all();assert.equal(seen.length-before,1,'string literals are values, not sources');}
 }
 // a probe made only of the two schema tables (subqueries included) is one
 const pair="SELECT (SELECT version FROM schema_contract WHERE id=1) AS version,(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='prediction_run') AS present";
 {const before=seen.length;await db.prepare(pair).bind().first();await db.prepare(pair).bind().first();assert.equal(seen.length-before,1,'a pure schema statement is one probe');}
 // an authority boundary drops the reuse: the next probe reads again
 PredictionD1.forgetRequestAuthority(env);
 await db.prepare(version).bind().first();assert.equal(count(/FROM schema_contract WHERE id=1$/),2,'forgetRequestAuthority makes the next probe a fresh read');
 // ordinary writes keep it (they cannot change the schema); a DDL statement and a batch the scope cannot classify drop it
 await db.prepare("UPDATE prediction_lease SET expires_at=expires_at WHERE name='nobody'").bind().run();
 await db.prepare(version).bind().first();assert.equal(count(/FROM schema_contract WHERE id=1$/),2,'a plain write keeps the probe');
 await db.prepare('CREATE TABLE IF NOT EXISTS air588_scratch (x INTEGER)').bind().run();
 await db.prepare(version).bind().first();assert.equal(count(/FROM schema_contract WHERE id=1$/),3,'a DDL statement drops the probe');
 await db.batch([base.prepare("UPDATE prediction_lease SET expires_at=expires_at WHERE name='nobody'").bind()]);
 await db.prepare(version).bind().first();assert.equal(count(/FROM schema_contract WHERE id=1$/),4,'a batch of statements the scope did not prepare drops the probe');
 await db.batch([db.prepare("UPDATE prediction_lease SET expires_at=expires_at WHERE name='nobody'").bind()]);
 await db.prepare(version).bind().first();assert.equal(count(/FROM schema_contract WHERE id=1$/),4,'a batch of known plain writes keeps it');
 // a failed probe is not kept
 {
  let fail=true;const flaky=d1Standin(file,{onQuery:text=>{if(fail&&/FROM schema_contract/.test(text)){fail=false;throw new Error('d1 unavailable');}}});
  const scoped=PredictionD1.scopeRequest({DB:flaky}).DB;
  await assert.rejects(()=>scoped.prepare(version).bind().first());
  assert.ok((await scoped.prepare(version).bind().first()).version>0,'the next call reads again after a failure');
 }
 // another request (another scope) never sees this one's answers, and an unscoped database is unchanged
 {const other=PredictionD1.scopeRequest({DB:base}).DB;const before=count(/FROM schema_contract/);await other.prepare(version).bind().first();assert.equal(count(/FROM schema_contract/),before+1,'a new scope reads afresh');}
 {const before=count(/FROM schema_contract/);await base.prepare(version).bind().first();await base.prepare(version).bind().first();assert.equal(count(/FROM schema_contract/),before+2,'no reuse without a scope');}
}

// 2. A Task's synchronous start: the young claim and the young persist gate are checked by reads. Fewer lease writes than one per check, and a claim or gate lost between
// two checks is still detected at the next one (start_claim_lost, nothing committed).
const batch=(w,taskId,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:5,taskId,...body});
const leaseDoc=w=>{const row=sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0];return row?JSON.parse(row.d):{};};
const setLease=(w,doc)=>sql(w.file,"UPDATE prediction_lease SET expires_at="+Number(doc.expiresAt)+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");
const timing=w=>w.logs.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(l=>l?.event==='prediction_step_timing'&&l.step==='batch_start').at(-1);
const world=async()=>{const w=await flowWorld({films:20});const r=await w.api('queue/reconcile',{});assert.equal(r.status,200);return w;};
{
 const w=await world();let leaseWrites=0,mirrorPuts=0;
 w.hooks.write=statements=>{if(statements.some(item=>/UPDATE prediction_lease|INSERT INTO prediction_lease/i.test(item.text)&&/runner/.test(item.text)))leaseWrites++;};
 const put=w.env.BUCKET.put.bind(w.env.BUCKET);w.env.BUCKET.put=async(key,...rest)=>{if(key==='enrichment/runner-lease.json')mirrorPuts++;return put(key,...rest);};
 w.logs.length=0;
 const r=await batch(w,'task00');w.hooks.write=null;
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'running');
 const line=timing(w);
 assert.ok((line.notes.claimChecks||0)>=1,'a young claim is checked by a read: '+JSON.stringify(line.notes));
 assert.equal(line.notes.claimRenewals||0,0,'no claim renewal in a start shorter than the read window');
 // acquire, convert, gate set and gate clear remain writes; the gate checks between them do not write
 assert.ok(leaseWrites<=5,'runner lease writes of one start: '+leaseWrites);
 assert.equal(mirrorPuts,leaseWrites,'one non-authoritative R2 mirror PUT of the runner lease per runner lease write');
 const doc=leaseDoc(w);assert.equal(doc.runId,r.data.runId);assert.equal(doc.phase,'run');assert.ok(!doc.submitGate,'the persist gate was cleared');assert.equal(doc.taskId,'task00');
}
// a claim taken over between two read checks: the next check sees it and the start ends with nothing committed
{
 const w=await world();let fired=false;
 const foreign={owner:'foreign',runId:'foreign',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+15*60000,epoch:9,phase:'run',taskId:'task15'};
 w.hooks.query=text=>{if(!fired&&/FROM prediction_queue/i.test(text)&&leaseDoc(w).phase==='claim'){fired=true;setLease(w,foreign);}};
 const r=await batch(w,'task00');w.hooks.query=null;
 assert.ok(fired,'the takeover was injected during the preflight');
 assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.code,'start_claim_lost');
 assert.deepEqual(leaseDoc(w),foreign,'the new holder is untouched');assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_run')[0].n,0,'no run');
}
// a persist gate taken over between two read checks: superseded, no manifest
{
 const w=await world();let fired=false;
 w.hooks.query=text=>{if(fired||!/FROM prediction_lease/i.test(text))return;const d=leaseDoc(w);if(d.phase==='run'&&d.submitGate){fired=true;setLease(w,{...d,submitGate:{...d.submitGate,token:'someone-else'}});}};
 const r=await batch(w,'task00');w.hooks.query=null;
 assert.ok(fired,'the gate takeover was injected during the persist');
 assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.code,'start_claim_lost');
 assert.ok(![...w.records.keys()].some(k=>k.startsWith('enrichment/batch-manifest/')),'no manifest');
}
console.log('AIR-588 A1: schema probes reused inside one request scope until a boundary, DDL or unknown batch; domain markers always read; young claim and gate checked by reads; takeovers still caught');
