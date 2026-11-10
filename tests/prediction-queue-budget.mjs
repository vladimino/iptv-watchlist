// AIR-417. The prediction queue document is stored plain while it fits PREDICTION_QUEUE_CHARS and in the `dict1` encoding when it does not.
// Real D1 stand-in (SQLite), real fenced batches. Synthetic film ids only; the shapes are those of buildPredictionQueue.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {activatePredictionDomain,importPredictionDomain,openQueue,routeRead,writeQueue,PREDICTION_QUEUE_CHARS,PREDICTION_STATEMENT_BYTES} from '../src/prediction-d1.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prediction-queue-budget-'));
let databases=0;
const migrated=()=>{
 const db=d1Standin(path.join(root,'queue-'+(databases++)+'.sqlite'));
 for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority'])db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return db;
};
const KEY='enrichment/prediction-queue.json';
const stored=db=>db.sql('SELECT chunk_text FROM prediction_queue ORDER BY seq').map(row=>row.chunk_text).join('');
const chunks=db=>db.sql('SELECT COUNT(*) AS n FROM prediction_queue')[0].n;
const generation=db=>db.sql('SELECT generation, queue_generation AS q FROM prediction_domain_authority')[0];

// The real document shape: a work class and a priority value per outstanding film; `retries`, `lastBatch` and the summary blocks ride along.
function queueOf({hot,cold,offset=0,programmeRunId='run-old',numeric=false,retries=0}){
 const id=n=>numeric?String(5000000+n*3):'tmdb_'+(1000000+n*7);
 const priority={},work={},hotPending=[],coldPending=[],watch=[];
 let n=offset;
 for(let k=0;k<hot;k++,n++){
  const x=id(n);hotPending.push(x);
  const slot=k%37;
  priority[x]={hot:true,availableNow:slot%5===0,availableToday:slot%3===0,availableUntil:new Date(Date.UTC(2026,10,12,18,0)+slot*1800000).toISOString(),rank:slot%5===0?0:1,expiresInMs:123456789+slot*1800000};
  work[x]={class:'missing',requiredWork:k%4?'fingerprint_and_prediction':'prediction_only',migration:null,reason:null};
 }
 for(let k=0;k<cold;k++,n++){
  const x=id(n);coldPending.push(x);if(k%9===0)watch.push(x);
  priority[x]={hot:false,availableNow:false,availableToday:false,availableUntil:null,rank:2,expiresInMs:null};
  if(k%9===0)work[x]={class:'missing',requiredWork:'prediction_only',migration:null,reason:null};
 }
 const retry={};
 for(let k=0;k<retries;k++)retry[id(offset+k)]={kind:'parse_error',scope:'film',retryable:true,failedAt:'2026-11-09T10:00:00.000Z',retryAt:1789000000000,attempts:1+k%3,lastRunId:'run-x'};
 return {schemaVersion:3,hotCount:hot,coldCount:cold,coldWithoutPrediction:cold-watch.length,profileVersion:2,programmeRunId,refreshedAt:'2026-11-08T18:17:13.096Z',trigger:'programme_updated',
  pending:[...hotPending,...watch],hotPending,coldPending,priorityCount:hot,coldRemaining:cold,urgentCount:Math.floor(hot/5),priority,retries:retry,
  lastBatch:{runId:'run-a',stage:'complete',hotProcessed:47},lastCheckAt:'2026-11-06T10:32:23.286Z',metrics:{hotAddedTotal:4140,hotProcessedTotal:1173},
  compatibility:{mode:'selective',films:hot+cold,missing:hot+cold,reasons:{exact:1207}},fingerprintCompatibility:{mode:'selective',classes:{missing:hot+cold},reasons:{exact:1}},work,discovery:{ready:true,minimum:100}};
}
const start=async(initial)=>{
 const db=migrated(),bucket=new MemoryBucket();
 await importPredictionDomain(db,bucket,{queue:initial});
 await activatePredictionDomain(db,{generation:0,queueGeneration:0,profileGeneration:0});
 return {db,bucket,env:{DB:db,BUCKET:bucket}};
};
const read=async env=>(await routeRead(env,KEY)).value;
const unwrap=text=>JSON.parse(text.replace(/^dict1:/,''));
const same=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));

// 1. The 8 Nov generation (3109 outstanding) fits plain: the stored text is byte-identical to the plain document, so an older Worker reads it.
const old=queueOf({hot:2642,cold:467});
const oldText=JSON.stringify(old);
console.log('old generation plain chars',oldText.length,'of',PREDICTION_QUEUE_CHARS);
assert.ok(oldText.length<=PREDICTION_QUEUE_CHARS);
{
 const {db,env,bucket}=await start(old);
 assert.equal(stored(db),oldText);
 same(await read(env),old);
 assert.equal(JSON.parse(bucket.objects.get(KEY)?.text||'null')?.programmeRunId??'run-old','run-old');
}

// 2. The 9 Nov generation (8704 films, 3255 current, 5449 outstanding, a larger index than before) exceeds the cap as plain text.
//    Old -> new generation through the real conditional write: stored encoded, within the cap, read back identical, mirrored plain.
const next=queueOf({hot:4400,cold:1049,offset:90,programmeRunId:'run-new',retries:300});
const nextText=JSON.stringify(next);
assert.ok(nextText.length>PREDICTION_QUEUE_CHARS,'the new generation must exceed the plain cap, otherwise this test proves nothing');
{
 const {db,env,bucket}=await start(old);
 const head=await openQueue(env);
 assert.equal(head.queue.programmeRunId,'run-old');
 const t0=performance.now();
 const written=await writeQueue(env,head,next);
 const ms=performance.now()-t0;
 assert.equal(written.etag,'d1');
 const text=stored(db);
 console.log('new generation plain',nextText.length,'encoded',text.length,'chunks',chunks(db),'write ms',ms.toFixed(0),'ratio',(text.length/nextText.length).toFixed(2));
 assert.ok(text.length<=PREDICTION_QUEUE_CHARS);
 assert.ok(text.startsWith('dict1:'),'the encoded text is not valid JSON, so a build without this support cannot parse it');
 assert.throws(()=>JSON.parse(text));
 assert.match(text,/"\$queueEncoding":"dict1"/);
 assert.ok(chunks(db)>=Math.ceil(text.length/40000));
 for(const row of db.sql('SELECT chunk_text FROM prediction_queue'))assert.ok(new TextEncoder().encode(row.chunk_text).length+160<=PREDICTION_STATEMENT_BYTES);
 same(await read(env),next);                      // parity with the plain representation
 same((await openQueue(env)).queue,next);          // the writers' own read path sees the plain shape
 assert.deepEqual(generation(db),{generation:1,q:1});
 assert.equal(bucket.objects.get(KEY).text,nextText); // the R2 mirror is the plain document, unchanged format
 // Queue semantics survive: hot/cold lists, priority, work, retries and the pending order.
 const back=await read(env);
 assert.equal(back.pending.length,next.pending.length);
 assert.deepEqual(back.hotPending,next.hotPending);
 assert.deepEqual(Object.keys(back.priority),Object.keys(next.priority));
 assert.deepEqual(back.retries,next.retries);
 // A later rebuild back under the cap goes back to plain text.
 await writeQueue(env,await openQueue(env),old);
 assert.equal(stored(db),oldText);
 same(await read(env),old);
}

// 3. Integer-like film ids (object key order is numeric for them) and a document that has no encodable field still round-trip.
{
 const {db,env}=await start(old);
 const numeric=queueOf({hot:4600,cold:900,numeric:true,programmeRunId:'run-num'});
 assert.ok(JSON.stringify(numeric).length>PREDICTION_QUEUE_CHARS);
 await writeQueue(env,await openQueue(env),numeric);
 assert.match(stored(db),/dict1/);
 same(await read(env),numeric);
 // `pending` is not a list of strings here: that field stays as it is while the others are encoded, and the document still round-trips.
 const odd={...queueOf({hot:4600,cold:900,programmeRunId:'run-odd'}),pending:[1,2]};
 assert.ok(JSON.stringify(odd).length>PREDICTION_QUEUE_CHARS);
 await writeQueue(env,await openQueue(env),odd);
 const text=stored(db);
 assert.match(text,/dict1/);
 assert.deepEqual(unwrap(text).pending,[1,2]);
 assert.ok(!unwrap(text).$queueEncoded.includes('pending'));
 same(await read(env),odd);
}

// 4. A document that exceeds the cap even encoded is refused and changes nothing: the previous queue and generation stay, and the guard is named.
{
 const {db,env}=await start(old);
 const huge=queueOf({hot:30000,cold:6000,programmeRunId:'run-huge'});
 const before=generation(db);
 const logged=[];const warn=console.warn;console.warn=line=>logged.push(String(line));
 try{
  await assert.rejects(writeQueue(env,await openQueue(env),huge),error=>error.code==='prediction_domain_budget'&&error.guard==='queue_chars');
 }finally{console.warn=warn;}
 assert.ok(logged.some(line=>line==='{"event":"prediction_domain_budget","guard":"queue_chars"}'),'one structured line names the guard');
 assert.ok(!logged.some(line=>/tmdb_/.test(line)),'the log line carries no film id');
 assert.equal(stored(db),oldText);
 assert.deepEqual(generation(db),before);
 same(await read(env),old);
}

// 5. Conditional writes: a stale head never lands, whether the queue is plain or encoded, and the winner's encoded queue is intact.
{
 const {db,env}=await start(old);
 const first=await openQueue(env),second=await openQueue(env);
 assert.equal((await writeQueue(env,first,next)).etag,'d1');
 const lost=await writeQueue(env,second,queueOf({hot:4400,cold:1049,programmeRunId:'run-loser'}));
 assert.equal(lost,null);
 same(await read(env),next);
 assert.deepEqual(generation(db),{generation:1,q:1});
 // five rebuilds that conflict in turn never write over the winner
 const stale=await openQueue(env);
 assert.equal((await writeQueue(env,await openQueue(env),{...next,trigger:'second'})).etag,'d1');
 assert.equal(await writeQueue(env,stale,{...next,trigger:'third'}),null);
 assert.equal((await read(env)).trigger,'second');
}

// 6. An unknown D1 failure inside the batch is not a budget error and leaves the previous queue as it was.
{
 const {db,env}=await start(old);
 const failing={...env,DB:new Proxy(db,{get:(target,prop)=>prop==='batch'?async()=>{throw new Error('D1_ERROR: simulated outage');}:target[prop]})};
 await assert.rejects(writeQueue(failing,await openQueue(env),next),error=>error.code==='prediction_domain_unavailable'&&!error.guard);
 same(await read(env),old);
 assert.equal(stored(db),oldText);
}

// 7. A stored encoding that is damaged or unknown fails closed instead of returning a wrong queue.
{
 const {db,env}=await start(old);
 await writeQueue(env,await openQueue(env),next);
 const good=stored(db);
 const store=text=>{db.sql('DELETE FROM prediction_queue');db.sql("INSERT INTO prediction_queue (seq, chunk_text, generation) VALUES (0,'"+text.replace(/'/g,"''")+"',9)");};
 const cases={
  badIndex:doc=>{doc.hotPending[0]=doc.$queueIds.length+5;},
  badTable:doc=>{doc.priority.v[0]=doc.$queueTable.length;},
  lengthMismatch:doc=>{doc.work.v.pop();},
  unknownEncoding:doc=>{doc.$queueEncoding='dict9';},
  duplicateIds:doc=>{doc.$queueIds[1]=doc.$queueIds[0];},
  unknownField:doc=>{doc.$queueEncoded.push('retries');},
 };
 // The prefix and the marker go together.
 store(good.slice('dict1:'.length));
 same(await read(env),next); // an encoded queue written without the prefix by the first build that had dict1 is still read
 store('dict1:'+JSON.stringify(old));
 await assert.rejects(read(env),error=>error.code==='prediction_domain_unavailable','prefix without marker');
 for(const [name,mutate] of Object.entries(cases)){
  const doc=unwrap(good);mutate(doc);store('dict1:'+JSON.stringify(doc));
  await assert.rejects(read(env),error=>error.code==='prediction_domain_unavailable',name);
 }
}

// 8. Recovery after a failed EPG queue tail: the refresh that threw wrote nothing; the next rebuild of the same generation lands and the
//    start path reads a consistent queue with the new programme generation.
{
 const {db,env}=await start(old);
 const huge=queueOf({hot:30000,cold:6000,programmeRunId:'run-new'});
 await assert.rejects(writeQueue(env,await openQueue(env),huge),error=>error.code==='prediction_domain_budget');
 same(await read(env),old);
 await writeQueue(env,await openQueue(env),next);
 const landed=await read(env);
 assert.equal(landed.programmeRunId,'run-new');
 assert.equal(landed.priorityCount,4400);
 assert.equal(landed.pending[0],next.pending[0]);
 assert.equal(db.sql('SELECT queue_generation AS q FROM prediction_domain_authority')[0].q,1);
}

// 9. Concurrent writers (EPG tail, Discovery checkpoint, projector refresh) racing on the encoded queue: exactly one wins each round.
{
 const {db,env}=await start(old);
 for(let round=0;round<3;round++){
  const heads=await Promise.all([openQueue(env),openQueue(env),openQueue(env)]);
  const results=await Promise.all(heads.map((head,i)=>writeQueue(env,head,{...next,trigger:'round'+round+'-'+i}).catch(error=>({error:error.code}))));
  assert.equal(results.filter(r=>r?.etag==='d1').length,1,JSON.stringify(results));
  assert.equal(results.filter(r=>r===null).length,2);
  assert.match((await read(env)).trigger,new RegExp('^round'+round));
 }
 assert.equal(generation(db).q,3);
}

console.log('prediction queue budget tests passed');
