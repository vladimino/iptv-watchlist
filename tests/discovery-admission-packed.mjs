// AIR-422. The catalog seal writes admissions in packed batches: multi-row upserts under the bind, statement and byte caps, one D1 round
// trip per batch, the generation carried from one batch to the next. Local sqlite stand-ins only; nothing here calls Cloudflare or production.
import assert from 'node:assert/strict';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {migrated,sql} from './discovery-paged-write.mjs';

const RUN='run-catalog';
const film=(tmdb,extra={})=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:'Фильм '+tmdb,year:1990+tmdb%35,genres:['Drama','Crime'],synopsis:'с'.repeat(380),poster:'/p/'+tmdb+'.jpg',...extra});
const generation=file=>Number(sql(file,'SELECT generation FROM discovery_authority')[0].generation);
const stored=file=>Object.fromEntries(sql(file,"SELECT film_id, payload_json FROM discovery_admission WHERE state='current'").map(row=>[row.film_id,row.payload_json]));
const bytes=text=>new TextEncoder().encode(text).byteLength;

// The stand-in with every statement recorded: its SQL, its bind count and the bytes of its bound values; `fail` can break a batch.
async function setup({fail=null}={}){
 const file=migrated();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const real=d1Standin(file),seen={batches:[],queries:0};
 const DB={
  prepare(text){const prepared=real.prepare(text);return {bind(...params){const bound=prepared.bind(...params);bound.sqlText=text;bound.binds=params.length;bound.valueBytes=params.reduce((sum,value)=>sum+(typeof value==='string'?bytes(value):8),0);const first=bound.first.bind(bound),all=bound.all.bind(bound);bound.first=async()=>{seen.queries++;return first();};bound.all=async()=>{seen.queries++;return all();};return bound;},first:()=>{seen.queries++;return prepared.first();},all:()=>{seen.queries++;return prepared.all();},run:()=>prepared.run()};},
  async batch(statements){
   const record=statements.map(item=>({sql:item.sqlText,binds:item.binds,valueBytes:item.valueBytes}));
   seen.batches.push(record);
   // `fail` sees the ordinal of the admission batch (setup's own batches are not counted).
   const admission=record.some(item=>/INSERT INTO discovery_admission/.test(item.sql));if(admission)seen.admissions=(seen.admissions||0)+1;
   if(fail&&admission){const verdict=await fail(seen.admissions,record);if(verdict==='before')throw new Error('D1_ERROR: network connection lost');if(verdict==='after'){await real.batch(statements);throw new Error('D1_ERROR: network connection lost');}}
   return real.batch(statements);
  },
 };
 const env={DB,BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){yield {key:'obs-a',title:'A',normalizedTitle:'a',year:2001,durations:[100],shows:[],seenInLatestSnapshot:true,lastAiring:Date.now()};})()});
 seen.batches.length=0;seen.queries=0;
 return {file,env,lease:taken.lease,seen};
}
const admissionBatches=seen=>seen.batches.filter(batch=>batch.some(item=>/INSERT INTO discovery_admission/.test(item.sql)));
function assertCaps(seen,{single=0}={}){
 for(const batch of admissionBatches(seen)){
  assert.ok(batch.length<=Authority.STATEMENT_CAP,'statements '+batch.length);
  let total=0;
  for(const item of batch){
   assert.ok(item.binds<=Authority.BIND_CAP,'binds '+item.binds);
   if(!/INSERT INTO discovery_admission/.test(item.sql))continue;
   const rows=item.binds/8;
   assert.ok(Number.isInteger(rows)&&rows>=1&&rows<=Authority.ADMISSION_ROWS_PER_UPSERT);
   // More than one row never exceeds the upsert bytes; a single film may be larger than the cap, and then it is alone.
   if(rows>1)assert.ok(item.valueBytes<=Authority.ADMISSION_UPSERT_BYTES+rows*200,'upsert bytes '+item.valueBytes);
   else if(item.valueBytes>Authority.ADMISSION_UPSERT_BYTES)assert.ok(single>0,'an oversized film needs to be expected');
   total+=item.valueBytes;
  }
  if(batch.filter(item=>/INSERT INTO discovery_admission/.test(item.sql)).reduce((n,item)=>n+item.binds/8,0)>1)assert.ok(total<=Authority.ADMISSION_BATCH_BYTES+40000,'batch bytes '+total);
  // Every upsert is followed by the fence that requires all of its rows.
  batch.forEach((item,at)=>{if(/INSERT INTO discovery_admission/.test(item.sql))assert.match(batch[at+1].sql,/changes\(\)=\?/);});
 }
}

// 1. 8,312 films (the catalog of 10 November 2026): every film stored as sent, one authority read, one round trip per batch.
{
 const {file,env,seen}=await setup();
 const films={};for(let n=1;n<=8312;n++)films['tmdb_'+n]=film(n);
 const g=generation(file),t0=performance.now();
 const result=await Authority.upsertAdmissions(env,films);
 const ms=performance.now()-t0;
 assert.equal(result.written.length,8312);assert.deepEqual(result.refused,[]);assert.equal(result.remaining,0);
 const rows=stored(file);
 assert.equal(Object.keys(rows).length,8312);
 for(const [id,value] of Object.entries(films))assert.equal(rows[id],JSON.stringify(value),id);
 const batches=admissionBatches(seen).length;
 assert.equal(result.batches,batches);assert.equal(result.reads,1,'the authority is read once for the whole write');
 assert.equal(generation(file),g+batches,'each batch moves the generation by exactly one');
 assert.deepEqual(result.carried,{generation:g+batches,programmeRunId:RUN});
 assertCaps(seen);
 const perFilm=bytes(JSON.stringify(films.tmdb_1)),oldBatches=Math.ceil(8312/19),oldTrips=oldBatches*5,newTrips=batches+4;
 // The whole run: about 8 min of staging and 3 min of publication tail measured on 10 November, plus this phase.
 const estimate=latency=>({before:+(oldTrips*latency/60000).toFixed(1),after:+(newTrips*latency/60000).toFixed(2)});
 console.log(JSON.stringify({films:8312,bytesPerFilm:perFilm,batches,filmsPerBatch:Math.round(8312/batches),roundTrips:{before:oldTrips,after:newTrips},catalogWriteMinutes:{fast17ms:estimate(17),slow350ms:estimate(350)},wholeRunMinutesSlow:{before:+(8+3+oldTrips*350/60000).toFixed(1),after:+(8+3+newTrips*350/60000).toFixed(1)},localMs:Math.round(ms)}));
 assert.ok(batches<=60,'batches '+batches);
 assert.ok(newTrips*350<60000,'the write is under a minute at 350 ms a round trip');
 // A second write of the same films changes nothing in what is stored (idempotent replay of a whole step).
 const again=await Authority.upsertAdmissions(env,films,{carried:result.carried});
 assert.equal(again.written.length,8312);assert.equal(again.reads,0,'a carried generation needs no authority read');
 assert.deepEqual(stored(file),rows);
}

// 2. Long-tail films: a few large payloads among small ones, one above the upsert bytes and one above the batch bytes.
{
 const {file,env,seen}=await setup();
 const films={};
 for(let n=1;n<=400;n++)films['tmdb_'+n]=film(n);
 films.tmdb_50=film(50,{synopsis:'я'.repeat(60000)});            // 120 KB of Cyrillic
 films.tmdb_51=film(51,{synopsis:'я'.repeat(60000)});
 films.tmdb_200=film(200,{synopsis:'x'.repeat(260000)});         // above ADMISSION_UPSERT_BYTES: alone in its upsert
 films.tmdb_300=film(300,{synopsis:'x'.repeat(450000)});         // above ADMISSION_BATCH_BYTES: alone in its batch
 const result=await Authority.upsertAdmissions(env,films);
 assert.equal(result.written.length,400);assert.deepEqual(result.refused,[]);
 const rows=stored(file);for(const [id,value] of Object.entries(films))assert.equal(rows[id],JSON.stringify(value),id);
 assertCaps(seen,{single:2});
 const alone=admissionBatches(seen).filter(batch=>batch.some(item=>item.valueBytes>Authority.ADMISSION_BATCH_BYTES));
 assert.equal(alone.length,1);assert.equal(alone[0].filter(item=>/INSERT INTO discovery_admission/.test(item.sql)).length,1);
}

// 3. A stale lease, a foreign lease and a held or loading authority write nothing.
{
 const {file,env,lease}=await setup();
 const films={};for(let n=1;n<=300;n++)films['tmdb_'+n]=film(n);
 const g=generation(file);
 await assert.rejects(()=>Authority.upsertAdmissions(env,films,{lease:{...lease,id:'someone-else'}}),error=>error.code==='discovery_fence');
 sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
 await assert.rejects(()=>Authority.upsertAdmissions(env,films,{lease}),error=>error.code==='discovery_fence');
 await assert.rejects(()=>Authority.upsertAdmissions(env,films,{lease,carried:{generation:g,programmeRunId:RUN}}),error=>error.code==='discovery_fence');
 assert.equal(Object.keys(stored(file)).length,0);assert.equal(generation(file),g);
 sql(file,'UPDATE discovery_lease SET expires_at='+(Date.now()+90000)+' WHERE id=1');
 // A carried generation does not get past a transfer that is loading or a cutover that is held: the fence checks both.
 sql(file,"UPDATE discovery_transfer SET state='loading' WHERE id=1");
 await assert.rejects(()=>Authority.upsertAdmissions(env,films,{lease,carried:{generation:g,programmeRunId:RUN}}),error=>error.code==='discovery_incomplete');
 sql(file,"UPDATE discovery_transfer SET state='idle' WHERE id=1");
 sql(file,"UPDATE discovery_authority SET cutover='held' WHERE id=1");
 await assert.rejects(()=>Authority.upsertAdmissions(env,films,{lease,carried:{generation:g,programmeRunId:RUN}}),error=>error.code==='discovery_fence');
 assert.equal(Object.keys(stored(file)).length,0);assert.equal(generation(file),g);
}

// 4. A batch that landed and lost its response (crash after commit) is an unknown outcome: the call throws and repeats nothing. The replayed
//    step writes the difference to what D1 holds, as the seal step does, so the landed films are not written twice.
{
 let armed=true;
 const {file,env,seen}=await setup({fail:async number=>armed&&number===2?'after':null});
 const films={};for(let n=1;n<=900;n++)films['tmdb_'+n]=film(n);
 await assert.rejects(()=>Authority.upsertAdmissions(env,films),error=>error.code==='discovery_unavailable');
 assert.equal(admissionBatches(seen).length,2,'no retry inside the call');
 const landed=stored(file);
 assert.ok(Object.keys(landed).length>228&&Object.keys(landed).length<900,'two batches landed: '+Object.keys(landed).length);
 armed=false;seen.batches.length=0;
 const difference=Object.fromEntries(Object.entries(films).filter(([id,value])=>landed[id]!==JSON.stringify(value)));
 const replay=await Authority.upsertAdmissions(env,difference);
 assert.equal(replay.written.length,900-Object.keys(landed).length);
 const rows=stored(file);assert.equal(Object.keys(rows).length,900);
 for(const [id,value] of Object.entries(films))assert.equal(rows[id],JSON.stringify(value));
 assert.equal(Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_admission')[0].n),900,'no duplicate row');
}

// 5. An unknown outcome before the commit (the batch did not land) is not retried blindly inside the call: it throws, nothing of that
//    batch is stored, and the replayed step writes the rest.
{
 let armed=true;
 const {file,env}=await setup({fail:async number=>armed&&number===2?'before':null});
 const films={};for(let n=1;n<=700;n++)films['tmdb_'+n]=film(n);
 await assert.rejects(()=>Authority.upsertAdmissions(env,films),error=>error.code==='discovery_unavailable');
 const partial=Object.keys(stored(file)).length;
 assert.ok(partial>0&&partial<700,'the first batch stays, the failed one left nothing: '+partial);
 armed=false;
 const replay=await Authority.upsertAdmissions(env,films);
 assert.equal(replay.written.length,700);
 const rows=stored(file);assert.equal(Object.keys(rows).length,700);
 for(const [id,value] of Object.entries(films))assert.equal(rows[id],JSON.stringify(value));
}

// 6. A generation moved by another writer between batches: the carried value is refused by the fence, the authority is read again and
//    every film is still written once.
{
 let bumped=false,file0=null;
 const {file,env,seen}=await setup({fail:async number=>{if(number===2&&!bumped){bumped=true;sql(file0,'UPDATE discovery_authority SET generation=generation+5 WHERE id=1');}return null;}});
 file0=file;
 const films={};for(let n=1;n<=900;n++)films['tmdb_'+n]=film(n);
 const result=await Authority.upsertAdmissions(env,films);
 assert.equal(result.written.length,900);assert.equal(new Set(result.written).size,900);
 const rows=stored(file);assert.equal(Object.keys(rows).length,900);
 for(const [id,value] of Object.entries(films))assert.equal(rows[id],JSON.stringify(value));
 assert.ok(result.reads>=2&&result.reads<=6,'re-read after the refusal, not per film: '+result.reads);
 assert.ok(admissionBatches(seen).length<=12,'batches '+admissionBatches(seen).length);
}

// 7. One identity that belongs to another film id inside a full batch: that film is refused, every other film lands, in a logarithmic
//    number of attempts.
{
 const {file,env,seen}=await setup();
 await Authority.upsertAdmissions(env,{tmdb_77:film(77)});
 seen.batches.length=0;
 const films={};for(let n=100;n<328;n++)films['tmdb_'+n]=film(n);
 films.dup_of_77={...film(77),id:'dup_of_77'};
 const result=await Authority.upsertAdmissions(env,films);
 assert.deepEqual(result.refused,[{filmId:'dup_of_77',reason:'identity_conflict'}]);
 assert.equal(result.written.length,228);
 const rows=stored(file);assert.equal(Object.keys(rows).length,229);assert.ok(!Object.hasOwn(rows,'dup_of_77'));
 assert.ok(admissionBatches(seen).length<=24,'halving, not one write per film: '+admissionBatches(seen).length);
 // A film id that arrives with another identity is not written over: the upsert's own WHERE leaves the row, the count fence fails the
 // batch, and the call fails as the single-row fence did (it is not an identity owned by another film id).
 await assert.rejects(()=>Authority.upsertAdmissions(env,{tmdb_100:{...film(100),tmdbId:'999999',canonicalIdentity:'tmdb:999999'},tmdb_101:film(101,{title:'changed'})}),error=>error.code==='discovery_fence');
 assert.equal(JSON.parse(stored(file).tmdb_100).tmdbId,'100');
}

// 8. A deadline stops between batches after at least one, and reports what is left; the next call continues from the carried generation.
{
 const {file,env}=await setup();
 const films={};for(let n=1;n<=1000;n++)films['tmdb_'+n]=film(n);
 const first=await Authority.upsertAdmissions(env,films,{deadline:Date.now()-1});
 assert.equal(first.batches,1);assert.ok(first.written.length>0&&first.written.length<1000);assert.equal(first.remaining,1000-first.written.length);
 const rest=Object.fromEntries(Object.entries(films).filter(([id])=>!first.written.includes(id)));
 const second=await Authority.upsertAdmissions(env,rest,{carried:first.carried});
 assert.equal(second.reads,0);assert.equal(second.remaining,0);
 assert.equal(Object.keys(stored(file)).length,1000);
}

// 9. More than the read cap is refused before any write.
{
 const {file,env}=await setup();
 const films={};for(let n=1;n<=20001;n++)films['tmdb_'+n]={id:'tmdb_'+n,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,title:'f'};
 await assert.rejects(()=>Authority.upsertAdmissions(env,films),error=>error.code==='discovery_bounded');
 assert.equal(Object.keys(stored(file)).length,0);
}

console.log('discovery admission packed tests passed');
