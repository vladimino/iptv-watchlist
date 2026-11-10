// AIR-420: the ledger seal pays for D1 round trips, not for SQL. This file measures the round trips of a seal of production size on
// the sqlite stand-in and checks that packing the batch changed none of the guarantees of ADR 0092: the cursor and the rows agree
// after a crash, an unknown outcome, a stale carried fence, a foreign lease holder and a replay; nothing is lost and nothing is
// written twice. Local sqlite stand-ins only; no Cloudflare, TMDB or production D1.
//
//   SEAL_PERF_TOTAL=40000   observations of the new ledger (default 40000)
//   SEAL_PERF_MODULE=path   another build of src/discovery-authority.js (the baseline measurement of the dated evidence)
//   SEAL_PERF_ONLY=1        only the volume measurement
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const Authority=await import(process.env.SEAL_PERF_MODULE?pathToFileURL(path.resolve(process.env.SEAL_PERF_MODULE)).href:'../src/discovery-authority.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-throughput-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal'];
let n=0;
const sql=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const migrate=()=>{const file=path.join(root,'q-'+(n++)+'.sqlite');const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'),encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");return file;};
const one=(file,text)=>sql(file,text)[0];
const count=(file,where)=>Number(one(file,'SELECT COUNT(*) AS n FROM discovery_observation WHERE '+where).n);
const shows=(file,where)=>Number(one(file,'SELECT COUNT(*) AS n FROM discovery_observation_show WHERE '+where).n);
const seal=file=>one(file,'SELECT * FROM discovery_seal');
const keyOf=i=>'k'+String(i).padStart(6,'0');
// An observation of about the production size (about 1.2 kB of JSON, two shows).
const PAD='x'.repeat(900);
const item=(i,title='new')=>({key:keyOf(i),title:title+' '+i,normalizedTitle:title+' '+i,year:1990+i%30,durations:[100],shows:[{channelId:'c'+i%40,channel:'C',start:1793000000000+i,end:1793000100000+i},{channelId:'d',channel:'D',start:1793000200000+i,end:1793000300000+i}],seenInLatestSnapshot:true,lastAiring:1793000000000+i,note:PAD});
const entry=(i,title)=>{const value=item(i,title);return {item:value,bytes:JSON.stringify(value).length+1};};
const entries=(from,to,title)=>Array.from({length:to-from},(_,k)=>entry(from+k,title));
// The previous committed ledger, written by SQL (it is the fixture, not the code under test): `total` active observations with two shows each.
function previous(file,total){
 sql(file,`WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM s WHERE i<${total-1}) INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, payload_json) SELECT 'active', 'k'||printf('%06d',i), 'active', 'run-old', 'old '||i, 'old '||i, 2000, '{"key":"k'||printf('%06d',i)||'"}' FROM s`);
 sql(file,`WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM s WHERE i<${total-1}) INSERT INTO discovery_observation_show (source_key, observation_key, ordinal, channel_id, channel, start_ms, end_ms) SELECT 'active', 'k'||printf('%06d',i), o.n, 'c', 'C', 1, 2 FROM s, (SELECT 0 AS n UNION ALL SELECT 1) o`);
 sql(file,"UPDATE discovery_authority SET programme_run_id='run-old', published_programme_run_id='run-old' WHERE id=1");
 sql(file,"UPDATE discovery_transfer SET state='committed', programme_run_id='run-old' WHERE id=1");
}
// Every stand-in here refuses a statement with more than 100 bound parameters, as D1 does.
const worker=(file,hooks={})=>({DB:d1Standin(file,{maxBinds:100,...hooks}),BUCKET:new MemoryBucket(),discoveryLease:null});
async function lease(env,file){
 sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 assert.ok(taken.lease,'a lease must be taken');
 env.discoveryLease=taken.lease;
 return taken.lease;
}
const begin=(env,l,total,jobId='job-1')=>Authority.sealBegin(env,{programmeRunId:'run-new',jobId,sourceKey:'epg/generations/run-new/discovery-latest.json',sourceEtag:'etag-1',itemTotal:total,startBytes:100,lease:l});
const trips=env=>env.DB.calls.queries+env.DB.calls.batches;
// What a step of the Worker does: hand sealWrite a full flush and carry the fence values from one batch to the next.
async function writeAll(env,l,from,to,{flush=400,stopAfter=Infinity,carry=true}={}){
 let cursor=from,carried=null,batches=0;
 while(cursor<to&&batches<stopAfter){
  const result=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:cursor,items:entries(cursor,Math.min(to,cursor+flush)),lease:l,...(carry?{carried}:{})});
  cursor=result.cursorItems;carried=result.carried||null;batches++;
 }
 return {cursor,batches,carried};
}
const invariant=file=>{
 const s=seal(file),cursor=Number(s.cursor_items);
 assert.equal(count(file,"source_key='active' AND residence='active' AND programme_run_id='run-new'"),cursor,'rows equal cursor');
 assert.equal(shows(file,"source_key='active' AND observation_key IN (SELECT observation_key FROM discovery_observation WHERE source_key='active' AND residence='active' AND programme_run_id='run-new')"),2*cursor,'two shows per written observation');
 return cursor;
};

// 1. Volume. A previous ledger of comparable size (most keys seen again, some retiring for good), a new ledger of production size.
{
 const total=Number(process.env.SEAL_PERF_TOTAL)>0?Number(process.env.SEAL_PERF_TOTAL):40000;
 const overlap=Math.round(total*0.9),gone=Math.round(total*0.05);
 const file=migrate();
 previous(file,overlap+gone);
 // New keys: [gone, gone+total). The first `gone` old keys are not seen again and are archived.
 const env=worker(file);const l=await lease(env,file);
 await begin(env,l,total);
 assert.equal(count(file,"residence='retiring'"),overlap+gone);
 const before={trips:trips(env),statements:env.DB.calls.statements,batches:env.DB.calls.batches};
 const started=Date.now();
 let cursor=0,carried=null,batches=0;
 while(cursor<total){
  const from=gone+cursor;
  const result=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:cursor,items:entries(from,Math.min(gone+total,from+400)),lease:l,carried});
  cursor=result.cursorItems;carried=result.carried||null;batches++;
 }
 const wallMs=Date.now()-started;
 const used={trips:trips(env)-before.trips,statements:env.DB.calls.statements-before.statements,batches};
 const measured={total,retiring:overlap+gone,batches,itemsPerBatch:Math.round(total/batches),roundTrips:used.trips,roundTripsPer1000:Math.round(used.trips/total*10000)/10,statements:used.statements,standinWallMs:wallMs,standinRowsPerSec:Math.round(total/(wallMs/1000)),
  // The production model: what the same round trips cost at the two latencies measured in production (about 11 ms on 9 November, about 200 ms on 10 November).
  modelSecondsAt11ms:Math.round(used.trips*11/100)/10,modelSecondsAt200ms:Math.round(used.trips*200/100)/10};
 console.log(JSON.stringify({seal_throughput:measured}));
 assert.equal(invariant(file),total);
 assert.equal(count(file,"residence='retiring'"),gone,'what was not seen again is still retiring');
 // Archive in 500-row batches, as the step does, then the commit.
 let rounds=0,result;do{result=await Authority.sealArchive(env,{jobId:'job-1',lease:l,limit:500});rounds++;}while(!result.committed);
 assert.equal(rounds,Math.ceil(gone/500)+1,'bounded archive rounds');
 assert.equal(count(file,"source_key='active' AND residence='active' AND programme_run_id='run-new'"),total);
 assert.equal(count(file,"residence='retiring'"),0);
 assert.equal(count(file,"residence='archive'"),gone,'every retiring observation is archived, none lost');
 assert.equal(shows(file,"source_key='active'"),2*total);
 assert.equal(one(file,'SELECT state FROM discovery_transfer').state,'committed');
 // A sample of the stored payloads is the source, byte for byte.
 for(const i of [gone,gone+1,gone+Math.floor(total/2),gone+total-1]){
  const row=one(file,"SELECT payload_json, title FROM discovery_observation WHERE source_key='active' AND observation_key='"+keyOf(i)+"'");
  const expected={...item(i)};delete expected.shows;
  assert.equal(row.payload_json,JSON.stringify(expected));assert.equal(row.title,'new '+i);
 }
 if(!process.env.SEAL_PERF_MODULE){
  // The regression guard: before AIR-420 a batch carried about 30 observations and cost about 7 round trips (about 230 a thousand).
  assert.ok(measured.itemsPerBatch>=100,'a batch carries at least 100 observations: '+measured.itemsPerBatch);
  assert.ok(measured.roundTripsPer1000<=12,'at most 12 D1 round trips a thousand observations: '+measured.roundTripsPer1000);
 }
}
if(process.env.SEAL_PERF_ONLY||process.env.SEAL_PERF_MODULE){console.log('discovery seal throughput ok (volume only)');process.exit(0);}

const TOTAL=1000;
async function fresh(){const file=migrate();previous(file,600);const env=worker(file);const l=await lease(env,file);await begin(env,l,TOTAL);return {file,env,l};}

// 2. A crash at any batch (the batch never reaches D1) leaves rows and cursor agreeing; the next step resumes from the durable cursor.
{
 const {file}=await fresh();
 let at=0;
 for(const kill of [1,3,2]){
  let seen=0;
  const dying=worker(file,{onBatch(){seen++;if(seen===kill+1)throw new Error('cancelled');}});
  const l=await lease(dying,file);
  await assert.rejects(()=>writeAll(dying,l,at,TOTAL));
  const cursor=invariant(file);
  assert.ok(cursor>=at,'the cursor never goes back');
  assert.equal(cursor>at,kill>1,'the batches before the crash are durable');
  at=cursor;
 }
 const env=worker(file);const l=await lease(env,file);
 const done=await writeAll(env,l,at,TOTAL);
 assert.equal(done.cursor,TOTAL);assert.equal(invariant(file),TOTAL);
}

// 3. Unknown outcome: the batch commits and the answer is lost. Nothing is repeated blindly: the same batch again is refused by the
//    cursor, with the carried values and from fresh reads, and the resumed step continues after it.
{
 const {file,env,l}=await fresh();
 const first=await writeAll(env,l,0,TOTAL,{stopAfter:1});
 const real=d1Standin(file);
 let lost=false;
 const flaky={...real,prepare:real.prepare.bind(real),async batch(statements){const out=await real.batch(statements);if(!lost&&statements.some(s=>/UPDATE discovery_seal SET cursor_items/.test(s.text))){lost=true;throw new Error('D1_ERROR: network connection lost');}return out;}};
 const unsure={DB:flaky,BUCKET:new MemoryBucket(),discoveryLease:l};
 await assert.rejects(()=>Authority.sealWrite(unsure,{jobId:'job-1',expectedCursor:first.cursor,items:entries(first.cursor,first.cursor+400),lease:l,carried:first.carried}),error=>error.code==='discovery_unavailable');
 const after=invariant(file);
 assert.ok(after>first.cursor,'the batch did commit');
 const rowsBefore=one(file,"SELECT COUNT(*) AS n, SUM(LENGTH(payload_json)) AS bytes FROM discovery_observation");
 await assert.rejects(()=>Authority.sealWrite(env,{jobId:'job-1',expectedCursor:first.cursor,items:entries(first.cursor,first.cursor+400),lease:l,carried:first.carried}),error=>error.code==='discovery_fence');
 await assert.rejects(()=>Authority.sealWrite(env,{jobId:'job-1',expectedCursor:first.cursor,items:entries(first.cursor,first.cursor+400),lease:l}),error=>error.code==='discovery_fence');
 assert.deepEqual(one(file,"SELECT COUNT(*) AS n, SUM(LENGTH(payload_json)) AS bytes FROM discovery_observation"),rowsBefore,'a refused replay writes nothing');
 assert.equal(invariant(file),after);
 const resumed=await writeAll(env,l,after,TOTAL);
 assert.equal(resumed.cursor,TOTAL);assert.equal(invariant(file),TOTAL);
}

// 4. A stale carried generation (something else moved the fence) writes nothing by itself and the batch is then sent once from fresh reads.
{
 const {file,env,l}=await fresh();
 const first=await writeAll(env,l,0,TOTAL,{stopAfter:1});
 sql(file,'UPDATE discovery_authority SET generation=generation+5 WHERE id=1');
 const before=trips(env);
 const next=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:first.cursor,items:entries(first.cursor,first.cursor+400),lease:l,carried:first.carried});
 assert.ok(next.written>0);
 assert.ok(trips(env)-before>2,'the refused carried batch was followed by fresh reads and one more batch');
 assert.equal(invariant(file),next.cursorItems);
 // And the values it returns are good again.
 const again=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:next.cursorItems,items:entries(next.cursorItems,next.cursorItems+400),lease:l,carried:next.carried});
 assert.equal(invariant(file),again.cursorItems);
 // Carried values that are not values are ignored, never trusted.
 for(const bad of [{},{generation:'7',programmeRunId:'run-new',cursorBytes:1},{generation:7,programmeRunId:'',cursorBytes:1},{generation:7,programmeRunId:'run-new',cursorBytes:NaN}]){
  const state=seal(file);
  const r=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:Number(state.cursor_items),items:entries(Number(state.cursor_items),Number(state.cursor_items)+10),lease:l,carried:bad});
  assert.equal(r.written,10);assert.equal(invariant(file),r.cursorItems);
 }
}

// 5. Fencing: another job, a wrong cursor, an expired lease taken over by another holder, a transfer that is not loading. Each writes
//    nothing, with carried values exactly as without them.
{
 const {file,env,l}=await fresh();
 const first=await writeAll(env,l,0,TOTAL,{stopAfter:1});
 const snapshot=()=>JSON.stringify(sql(file,"SELECT (SELECT COUNT(*) FROM discovery_observation WHERE residence='active') AS active, (SELECT COUNT(*) FROM discovery_observation_show) AS shows, (SELECT cursor_items FROM discovery_seal) AS cursor, (SELECT cursor_bytes FROM discovery_seal) AS bytes"));
 const stored=snapshot();
 const attempt=(spec,who=env)=>Authority.sealWrite(who,{jobId:'job-1',expectedCursor:first.cursor,items:entries(first.cursor,first.cursor+400),lease:l,carried:first.carried,...spec});
 await assert.rejects(()=>attempt({jobId:'job-other'}),error=>error.code==='discovery_fence');
 await assert.rejects(()=>attempt({expectedCursor:first.cursor+1}),error=>error.code==='discovery_fence');
 await assert.rejects(()=>attempt({expectedCursor:0}),error=>error.code==='discovery_fence');
 assert.equal(snapshot(),stored);
 // The lease expires and another holder takes it: the first holder's carried batch is refused, and so is its fresh attempt.
 const other=worker(file);const l2=await lease(other,file);
 await assert.rejects(()=>attempt({}),error=>error.code==='discovery_fence');
 await assert.rejects(()=>attempt({carried:null}),error=>error.code==='discovery_fence');
 assert.equal(snapshot(),stored);
 // The new holder reads the durable cursor and continues; two writers never both advance it.
 const state=await Authority.sealState(other);
 assert.equal(state.cursorItems,first.cursor);
 const [a,b]=await Promise.allSettled([Authority.sealWrite(other,{jobId:'job-1',expectedCursor:first.cursor,items:entries(first.cursor,first.cursor+400),lease:l2}),Authority.sealWrite(other,{jobId:'job-1',expectedCursor:first.cursor,items:entries(first.cursor,first.cursor+400),lease:l2})]);
 assert.equal([a,b].filter(r=>r.status==='fulfilled').length,1,'exactly one of two concurrent writers advances the cursor');
 const cursor=invariant(file);
 // A transfer that is not loading refuses the carried batch too.
 sql(file,"UPDATE discovery_transfer SET state='committed' WHERE id=1");
 const good=[a,b].find(r=>r.status==='fulfilled').value;
 await assert.rejects(()=>Authority.sealWrite(other,{jobId:'job-1',expectedCursor:cursor,items:entries(cursor,cursor+50),lease:l2,carried:good.carried}),error=>error.code==='discovery_incomplete','the carried batch is refused by its fence and the fresh read names the reason');
 await assert.rejects(()=>Authority.sealWrite(other,{jobId:'job-1',expectedCursor:cursor,items:entries(cursor,cursor+50),lease:l2}),error=>error.code==='discovery_incomplete');
 assert.equal(invariant(file),cursor);
}

// 5b. A carried `cursorBytes` that is a valid number but wrong cannot move the durable byte cursor: the database adds the bytes of the
//     batch to its own value, and the next step reads the cursor from D1. An out-of-band generation move at the same time is refused first.
{
 const {file,env,l}=await fresh();
 const first=await writeAll(env,l,0,TOTAL,{stopAfter:1});
 const before=seal(file);
 const batch=entries(first.cursor,first.cursor+50);
 const bytes=batch.reduce((n,e)=>n+e.bytes,0);
 const wrong={...first.carried,cursorBytes:first.carried.cursorBytes+123456};
 const result=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:first.cursor,items:batch,lease:l,carried:wrong});
 assert.equal(result.written,50);
 const after=seal(file);
 assert.equal(Number(after.cursor_bytes),Number(before.cursor_bytes)+bytes,'the durable byte cursor moved by the bytes of the batch only');
 assert.equal(Number(after.cursor_items),first.cursor+50);
 assert.equal((await Authority.sealState(env)).cursorBytes,Number(before.cursor_bytes)+bytes,'what the next step reads is the durable value');
 // The wrong value and a moved generation together: nothing is written by the carried batch, and the fresh path returns the true cursor.
 sql(file,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');
 const next=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:first.cursor+50,items:entries(first.cursor+50,first.cursor+60),lease:l,carried:{...result.carried,cursorBytes:1}});
 assert.equal(next.cursorBytes,Number(seal(file).cursor_bytes),'a refused carried batch falls back to the durable byte cursor');
 assert.equal(invariant(file),first.cursor+60);
}

// 6. Idempotency and packing bounds: the same observations written by a restarted job give the same rows; a very large payload gets
//    its own statement and its own batch instead of an oversized one; an observation with many shows still fits.
{
 const file=migrate();previous(file,50);
 const env=worker(file);const l=await lease(env,file);
 await begin(env,l,30);
 const big=i=>{const value=item(i);value.note='y'.repeat(150000);return {item:value,bytes:JSON.stringify(value).length+1};};
 const many=i=>{const value=item(i);value.shows=Array.from({length:300},(_,k)=>({channelId:'c'+k,channel:'C',start:1793000000000+k,end:1793000001000+k}));return {item:value,bytes:JSON.stringify(value).length+1};};
 // One observation larger than the whole batch byte cap still goes out, alone.
 const huge=i=>{const value=item(i);value.note='я'.repeat(300000);return {item:value,bytes:new TextEncoder().encode(JSON.stringify(value)).byteLength+1};};
 const list=[...Array.from({length:9},(_,i)=>big(i)),huge(9),...Array.from({length:5},(_,i)=>many(10+i)),...entries(15,30)];
 let cursor=0,carried=null,batches=0,statements=[];
 const counting=worker(file,{onBatch(batch){statements.push(batch.length);}});counting.discoveryLease=l;
 while(cursor<30){const r=await Authority.sealWrite(counting,{jobId:'job-1',expectedCursor:cursor,items:list.slice(cursor),lease:l,carried});cursor=r.cursorItems;carried=r.carried;batches++;}
 assert.ok(batches>=3,'large payloads and many shows split the batch: '+batches);
 assert.ok(Number(one(file,"SELECT LENGTH(payload_json) AS n FROM discovery_observation WHERE source_key='active' AND observation_key='"+keyOf(9)+"'").n)>300000,'the oversized observation is stored whole');
 assert.ok(statements.every(size=>size<=Authority.STATEMENT_CAP),'no batch exceeds the statement cap: '+statements.join(','));
 assert.equal(count(file,"source_key='active' AND residence='active' AND programme_run_id='run-new'"),30);
 assert.equal(shows(file,"source_key='active' AND observation_key='"+keyOf(12)+"'"),300);
 assert.equal(Number(one(file,"SELECT LENGTH(payload_json) AS n FROM discovery_observation WHERE source_key='active' AND observation_key='"+keyOf(3)+"'").n)>150000,true);
 const digest=()=>JSON.stringify(sql(file,"SELECT observation_key, residence, programme_run_id, LENGTH(payload_json) AS n, (SELECT COUNT(*) FROM discovery_observation_show s WHERE s.source_key='active' AND s.observation_key=o.observation_key) AS shows FROM discovery_observation o WHERE source_key='active' ORDER BY observation_key"));
 const firstPass=digest();
 // The job starts over (an interrupted handoff): the same source written again gives the same rows.
 sql(file,"UPDATE discovery_seal SET job_id=NULL, phase='idle', cursor_items=0 WHERE id=1");
 await begin(env,l,30,'job-2');
 cursor=0;carried=null;
 while(cursor<30){const r=await Authority.sealWrite(env,{jobId:'job-2',expectedCursor:cursor,items:list.slice(cursor),lease:l,carried});cursor=r.cursorItems;carried=r.carried;}
 assert.equal(digest(),firstPass,'a replayed seal is deterministic');
}
console.log('discovery seal throughput ok');
