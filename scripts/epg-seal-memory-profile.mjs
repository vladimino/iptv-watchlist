// AIR-460: offline memory profile of the staged EPG publication tail (`seal_ledger` and `seal_publish`) at the volumes of the
// natural run of 13 Nov 2026, against the D1-authoritative `bounded` flow (the sqlite D1 stand-in with the real migrations).
// Nothing here calls Cloudflare, TMDB, R2 or production, and it uses no private data: every body is synthetic.
//
//   node --expose-gc scripts/epg-seal-memory-profile.mjs --scenario ledger|publish|both [--gc none|step|batch]
//        [--items 36999] [--item-bytes 1238] [--catalog-bytes 12700000] [--programme-bytes 2242013] [--watchlist-bytes 1477694]
//        [--out file.jsonl]
//
// Run it under a V8 heap cap to rank scenarios, e.g. `node --expose-gc --max-old-space-size=64 ...`. Node RSS and heap are NOT the
// workerd 128 MiB isolate limit (which counts V8 heap, ArrayBuffers and the Worker's native buffers together); the numbers give the
// shape of the allocations and what each step retains, not the production peak. `live` = heapUsed + external - bytes held by the
// in-memory bucket, which stands in for R2 and is outside the isolate in production.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import v8 from 'node:v8';
import * as Authority from '../src/discovery-authority.js';
import {loadWorker} from './discovery-ledger-offline.mjs';
import {scoped} from './bundle-scope.mjs';
import {d1Standin} from '../tests/d1-standin.mjs';
import {sqliteSync} from '../tests/sqlite-session.mjs';

const args=process.argv.slice(2),value=(name,fallback)=>{const i=args.indexOf(name);return i>=0?args[i+1]:fallback;};
const SCENARIO=value('--scenario','both'),GC=value('--gc','none');
const ITEMS=Number(value('--items','36999')),ITEM_BYTES=Number(value('--item-bytes','1238'));
const CATALOG_BYTES=Number(value('--catalog-bytes','12700000')),PROGRAMME_BYTES=Number(value('--programme-bytes','2242013')),WATCHLIST_BYTES=Number(value('--watchlist-bytes','1477694'));
const OUT=value('--out','');
const MB=bytes=>Math.round(bytes/1048576*10)/10;
if(GC!=='none'&&!global.gc){console.error('--gc needs node --expose-gc');process.exit(2);}

const context=loadWorker();
context.DiscoveryAuthority=Authority;
vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),context);
const call=code=>vm.runInContext(code,context);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-profile-'));
const migrations=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();

let heldBytes=()=>0;
const phases=new Map();let current='setup';
function sample(label){
 if(GC==='batch'&&global.gc)global.gc();
 const m=process.memoryUsage();
 const live=Math.max(0,m.heapUsed+m.external-heldBytes());
 const entry=phases.get(current)||{phase:current,samples:0,peakHeapMB:0,peakExternalMB:0,peakLiveMB:0,peakRssMB:0};
 entry.samples++;entry.peakHeapMB=Math.max(entry.peakHeapMB,MB(m.heapUsed));entry.peakExternalMB=Math.max(entry.peakExternalMB,MB(m.external));
 entry.peakLiveMB=Math.max(entry.peakLiveMB,MB(live));entry.peakRssMB=Math.max(entry.peakRssMB,MB(m.rss));
 phases.set(current,entry);
 if(OUT)fs.appendFileSync(OUT,JSON.stringify({phase:current,label,heapMB:MB(m.heapUsed),externalMB:MB(m.external),liveMB:MB(live),rssMB:MB(m.rss)})+'\n');
}
function mark(name){
 if(GC==='step'||GC==='batch')global.gc();
 current=name;sample('enter');
}

function bucket(chunk=64*1024){
 const objects=new Map();let revision=0;
 const read=async v=>{if(typeof v==='string')return Buffer.from(v,'utf8');if(v&&typeof v.getReader==='function'){const reader=v.getReader(),parts=[];for(;;){const step=await reader.read();if(step.done)break;parts.push(Buffer.from(step.value));}return Buffer.concat(parts);}return Buffer.from(v);};
 heldBytes=()=>{let n=0;for(const o of objects.values())n+=o.bytes.length;return n;};
 return {
  objects,
  async put(key,v){const bytes=await read(v);objects.set(key,{bytes,etag:'e'+(++revision)});sample('put');return {etag:objects.get(key).etag};},
  async head(key){const o=objects.get(key);return o?{etag:o.etag,size:o.bytes.length}:null;},
  async delete(key){objects.delete(key);},
  async get(key,options={}){
   const o=objects.get(key);if(!o)return null;
   const offset=options.range?.offset??0,bytes=o.bytes.subarray(offset);
   // `text()` decodes the whole object into one string; `body` is pulled chunk by chunk, as R2's is.
   return {etag:o.etag,size:bytes.length,text:async()=>bytes.toString('utf8'),json:async()=>JSON.parse(bytes.toString('utf8')),
    body:new ReadableStream({pull(controller){if(!this.at)this.at=0;if(this.at>=bytes.length){controller.close();return;}controller.enqueue(new Uint8Array(bytes.subarray(this.at,this.at+chunk)));this.at+=chunk;}})};
  },
 };
}

const migrate=()=>{
 const file=path.join(root,'profile.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+migrations.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr);
 return file;
};
const sql=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const LATENCY=Number(value('--d1-latency-ms','0'));
const hooksFor=()=>({latencyMs:LATENCY,onQuery:async()=>{sample('d1')}});
const stepEnv=(file,bkt)=>({DB:d1Standin(file,hooksFor()),BUCKET:bkt,discoveryLease:null});
const keyOf=i=>'k'+String(i).padStart(6,'0');
const pad=n=>'О'.repeat(Math.max(0,n));
function ledgerItem(i,padChars){
 const start=1_793_000_000_000+(i%5)*3_600_000;
 return {key:keyOf(i),title:'Кандидат '+i,normalizedTitle:'кандидат '+i,year:1990+i%30,duration:100,description:pad(padChars),firstAiring:start,lastAiring:start+120000,airings:3,
  shows:[0,1,2].map(j=>({channelId:'ch'+((i+j)%150),channel:'Канал '+((i+j)%150),start:start+j*60000,end:start+j*60000+6000000,epgTitle:'Кандидат '+i})),rawTitles:['Кандидат '+i]};
}
const baseBytes=Buffer.byteLength(JSON.stringify(ledgerItem(0,0)))+1;
const PAD_CHARS=Math.max(0,Math.floor((ITEM_BYTES-baseBytes)/2));
const film=(i,padChars)=>({id:'tmdb_'+i,tmdbId:String(i),canonicalIdentity:'tmdb:'+i,title:'Фильм '+i,original:'Film '+i,year:1990+i%30,synopsis:pad(padChars)});
function sizedFilms(target,make,count){const probe=Buffer.byteLength(JSON.stringify(make(0,0)));return Array.from({length:count},(_,i)=>make(i,Math.max(0,Math.floor((target/count-probe)/2))));}

const result={node:process.version,oldSpaceMB:MB(v8.getHeapStatistics().heap_size_limit),gc:GC,scenario:SCENARIO,volumes:{items:ITEMS,itemBytes:ITEM_BYTES,catalogBytes:CATALOG_BYTES,programmeBytes:PROGRAMME_BYTES,watchlistBytes:WATCHLIST_BYTES}};
let failure=null;
try{
 const file=migrate();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 sql(file,"UPDATE published_epg_authority SET mode='d1', cutover='open' WHERE id=1");
 const bkt=bucket();
 const takeLease=async env=>{sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');const lease=await call('acquireDiscoveryLease')(env);env.discoveryLease=lease;return lease;};

 {
  const env=stepEnv(file,bkt);
  const taken=await Authority.acquireLease(env,{programmeRunId:null});env.discoveryLease=taken.lease;
  await Authority.ingestLedger(env,{programmeRunId:'run-old',handoff:true,lease:taken.lease,items:(async function*(){for(let i=0;i<120;i++)yield ledgerItem(1_000_000+i,0);})()});
  await Authority.releaseLease(env,taken.lease);
 }

 if(SCENARIO==='ledger'||SCENARIO==='both'){
  const framing=call('discoveryDocumentFraming')({programmeRunId:'run-new'},{ledgerMode:'bounded'});
  const encoder=new TextEncoder();
  const encoded=[];let bytes=0;for(let i=0;i<ITEMS;i++){const b=encoder.encode(JSON.stringify(ledgerItem(i,PAD_CHARS)));encoded.push(b);bytes+=b.byteLength;}
  const length=call('discoveryDocumentLength')(framing,bytes,ITEMS);
  const key='epg/generations/run-new/discovery-latest.json';
  await bkt.put(key,call('discoveryDocumentStream')(framing,(async function*(){for(const b of encoded)yield b;})()));
  encoded.length=0;
  const head=await bkt.head(key);
  if(head.size!==length)throw new Error('document length mismatch');
  result.ledgerDocumentBytes=head.size;
  if(global.gc)global.gc();
  result.baselineBeforeLedger={heapMB:MB(process.memoryUsage().heapUsed),externalMB:MB(process.memoryUsage().external),liveMB:MB(Math.max(0,process.memoryUsage().heapUsed+process.memoryUsage().external-heldBytes()))};
  const run={runId:'run-new',stage:'seal',seal:{jobId:'job-1',phase:'ledger',sourceKey:key,etag:head.etag,itemTotal:ITEMS,prefixBytes:framing.prefix.byteLength}};
  let steps=0,done=false;const started=Date.now();
  while(!done&&steps<400){
   steps++;mark('seal_ledger');
   const env=stepEnv(file,bkt);const lease=await takeLease(env);
   const out=await call('sealLedgerStep')(env,run,lease,Date.now()+Number(value('--step-ms','8000')));
   done=out.done;
   sample('step_end');
  }
  const rows=Number(sql(file,"SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key='active' AND residence='active' AND programme_run_id='run-new'")[0].n);
  const transfer=sql(file,'SELECT state FROM discovery_transfer')[0]?.state;
  result.ledger={steps,done,elapsedMs:Date.now()-started,rows,transfer};
  if(!done||rows!==ITEMS||transfer!=='committed')throw new Error('replay_incomplete: ledger done='+done+' rows='+rows+'/'+ITEMS+' transfer='+transfer);
 }

 if(SCENARIO==='publish'||SCENARIO==='both'){
  const PublishedEpg=call('PublishedEpg');
  await (async()=>{
    const watchFilms=sizedFilms(WATCHLIST_BYTES,(i,padChars)=>({id:'w'+i,title:'Список '+i,original:'Watch '+i,year:2000,synopsis:pad(padChars)}),396);
    const programmeFilms=sizedFilms(PROGRAMME_BYTES,(i,padChars)=>({id:'w'+i,title:'Список '+i,year:2000,synopsis:pad(padChars),shows:[{channelId:'ch1',channel:'Канал',startMs:1_793_000_000_000+i*1000,endMs:1_793_000_600_000+i*1000,epgTitle:'x'}]}),396);
    const mk=(runId,stamp)=>({report:{runId,updatedAt:stamp,watchlistCount:396,films:programmeFilms,people:{directors:[],actors:[]},stats:{}},watchlist:{updatedAt:stamp,films:watchFilms}});
    const seed=mk('run-old','2026-11-12T16:00:00.000Z');
    const seedEnv={DB:d1Standin(file),BUCKET:bkt};
    await PublishedEpg.publishGeneration(seedEnv,{programmeRunId:'run-old',phase:'published',publishedAt:seed.report.updatedAt,expectedProgrammeRunId:null,programme:seed.report,watchlist:seed.watchlist});
    const live=await PublishedEpg.currentGeneration(seedEnv);
    const next=mk('run-new','2026-11-13T16:00:00.000Z');
    const catalog=Object.fromEntries(sizedFilms(CATALOG_BYTES,film,2631).map(f=>[f.id,f]));
    await bkt.put('epg/seal/run-new/payload.json',JSON.stringify({runId:'run-new',report:next.report,catalog,watchlist:next.watchlist,uncertain:[],fence:live.fence,expectedProgrammeRunId:'run-old'}));
    result.payloadBytes=(await bkt.head('epg/seal/run-new/payload.json')).size;

  })();
  const run={runId:'run-new',stage:'seal',seal:{jobId:'job-1',phase:'publish'},watchlist:[]};
  const env=stepEnv(file,bkt);env.epgFence=undefined;
  const lease=await takeLease(env);
  if(global.gc)global.gc();
  result.baselineBeforePublish={heapMB:MB(process.memoryUsage().heapUsed),externalMB:MB(process.memoryUsage().external),liveMB:MB(Math.max(0,process.memoryUsage().heapUsed+process.memoryUsage().external-heldBytes()))};
  mark('seal_publish');
  const started=Date.now();
  try{
   const out=await call('sealPublishStep')(env,run,lease,Infinity);
   result.publish={elapsedMs:Date.now()-started,phase:run.seal.phase,units:run.seal.units||null,answer:out&&out.seal||null};
  }catch(error){result.publish={error:String(error&&error.message||error),elapsedMs:Date.now()-started,units:run.seal.units||null};}
  sample('step_end');
  const after=await PublishedEpg.currentGeneration(env);
  result.publish.pointer=after?.programmeRunId||null;
  if(result.publish.error||run.seal.phase!=='finalize'||after?.programmeRunId!=='run-new')throw new Error('replay_incomplete: publish error='+result.publish.error+' phase='+run.seal.phase+' pointer='+result.publish.pointer);
 }
}catch(error){failure=String(error&&error.stack||error).split('\n').slice(0,6).join(' | ');}
result.error=failure;
result.phases=[...phases.values()];
console.log(JSON.stringify(result));
if(failure)process.exitCode=1;
