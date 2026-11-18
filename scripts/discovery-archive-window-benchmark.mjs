// AIR-533: offline before/after benchmark of the `seal_stage` archive loop of a bounded commit (the Worker's own `planDiscoveryLedger`, loaded unchanged except for the
// `ARCHIVE_SEGMENT_CONCURRENCY` constant). Synthetic objects only: no network, no R2, no D1, no production data.
//
// What it measures, per concurrency (1 = the sequential path before AIR-533, 3 = the shipped window):
//   wallMs      wall time of the whole bounded commit with a SIMULATED R2 latency on the segment objects: a put costs putBaseMs + MB * putMsPerMb, a read readBaseMs + MB * readMsPerMb,
//               both multiplied by --latency-scale (default 0.02, so a run takes seconds, not minutes). The model constants come from the natural run of 18 November 2026
//               (AIR-420 evidence: 64 puts 86.3 s for 81.6 MB, 64 reads 18.9 s). The CPU of the commit is real and NOT scaled, so a wall time is not a production time:
//               only the DIFFERENCE between two concurrencies is meaningful, and `modelledSavingMs` (= that difference / latencyScale, relative to the first level) is the
//               production-scale saving of the overlapped I/O under the model.
//   peakHeapMB  the highest `process.memoryUsage().heapUsed` sampled every 2 ms during the commit, minus the heap before it (the Worker code's own working set, relative figure:
//               Node's heap is not the Workers isolate limit).
//   segments, archiveMB  how many segments the commit rewrote and how much it wrote.
// The latency is a model, not a measurement of R2; a natural production run stays the acceptance gate.
//
// Usage: node scripts/discovery-archive-window-benchmark.mjs --output /absolute/dir/outside/repo [--total 21000] [--archived 26000] [--seen 20500] [--churn 3500] [--latency-scale 0.02] [--concurrency 1,3]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {REPO,directoryBase,overlayStore} from './discovery-ledger-offline.mjs';
import {withLedgerMode} from '../tests/ledger-mode-fixture.mjs';

const BASE=Date.UTC(2026,10,1,12),DAY=86400000;
const run=day=>'00000000-0000-4000-8000-'+String(day).padStart(12,'0');
const RU=['Брат','Сибирский цирюльник','Москва слезам не верит','Ирония судьбы','Кин-дза-дза','Сталкер','Зеркало','Солярис'];
const raw=(i,day)=>{const start=BASE+day*DAY+(i%20)*3600000,title=RU[i%8]+' к'+i.toString(36)+' ('+(1960+i%60)+')';return {key:null,confirmedTmdbId:null,title,rawTitles:[title],normalizedTitle:null,year:1960+i%60,duration:95,description:'Описание фильма '.repeat(40).slice(0,560),firstAiring:start,lastAiring:start,airings:1,shows:[{channelId:'ch'+(i%300),channel:'Канал '+(i%300),start,end:start+5400000,epgTitle:title},{channelId:'d'+(i%40),channel:'Д',start:start+7200000,end:start+9000000,epgTitle:title}]};};
const scan=(count,day,from=0)=>Array.from({length:count},(_,i)=>raw(from+i,day));
const SOURCES=['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/continuation.js','src/worker.js'];
const SEGMENTS='epg/discovery-archive/v1/segments/';
// Measured on 18 November 2026 (AIR-420): 64 puts = 86.3 s for 81.6 MB, 64 reads = 18.9 s; about 1.27 MB a segment.
const MODEL={putBaseMs:100,putMsPerMb:(86300/64-100)/1.275,readBaseMs:50,readMsPerMb:(18900/64-50)/1.275};

function loadWorker(concurrency){
 const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,ReadableStream,crypto:webcrypto,setTimeout,ASSETS:{},console:{...console,log:()=>{}},fetch:async()=>new Response('unavailable',{status:599})});
 vm.runInContext(fs.readFileSync(path.join(REPO,'src/domain/film-person.js'),'utf8'),context);
 for(const file of SOURCES){
  let source=fs.readFileSync(path.join(REPO,file),'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation');
  if(file==='src/worker.js'){
   if(!/ARCHIVE_SEGMENT_CONCURRENCY=3\b/.test(source))throw new Error('ARCHIVE_SEGMENT_CONCURRENCY=3 not found in src/worker.js: the benchmark needs the AIR-533 loop');
   source=source.replace(/ARCHIVE_SEGMENT_CONCURRENCY=3\b/,'ARCHIVE_SEGMENT_CONCURRENCY='+concurrency);
  }
  vm.runInContext(source,context);
 }
 return context;
}
async function commit(store,day,mode,latest,concurrency=3){
 const context=loadWorker(concurrency),id=run(day);
 await store.put('sync.json',JSON.stringify({runId:id,stage:'epg'}));
 await vm.runInContext('publishGenerationWithLedger',context)(withLedgerMode({BUCKET:store},mode||'full'),id,latest,{programmeRunId:id},{'programme.json':{runId:id,films:[]},'discovered-films.json':{}});
}
async function build(dir,{total,archived,seen}){
 // Day 0 full ledger of total + archived; day 1 bounded keeps `total` (the archive appears); day 2 frozen keeps `seen`; day 3 bounded: the bounded steady state.
 const base=path.join(dir,'bounded'),store=overlayStore(null,base);
 await commit(store,0,undefined,scan(total+archived,0));
 await commit(store,1,'bounded',scan(total,1));
 await commit(store,2,undefined,scan(seen,2));
 await commit(store,3,'bounded',scan(seen,3));
 const archive=JSON.parse(fs.readFileSync(path.join(base,encodeURIComponent('epg/discovery-archive/v1/current.json')),'utf8'));
 const manifest=JSON.parse(fs.readFileSync(path.join(base,encodeURIComponent('epg/discovery-archive/v1/manifests/'+archive.manifestId+'.json')),'utf8'));
 const shape={archiveSegments:manifest.segments.filter(entry=>entry.object).length,archiveMB:Math.round(manifest.totals.bytes/1e5)/10,archiveItems:manifest.totals.items};
 fs.writeFileSync(path.join(dir,'shape.json'),JSON.stringify(shape));
 return shape;
}
async function child(concurrency,dir,scale){
 const {seen,churn}=JSON.parse(fs.readFileSync(path.join(dir,'params.json'),'utf8'));
 const overlay=fs.mkdtempSync(path.join(dir,'run-'));
 const store=overlayStore(directoryBase(path.join(dir,'bounded')),overlay);
 const realGet=store.get.bind(store),realPut=store.put.bind(store),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 let written=0,segments=0;
 store.get=async(key,...rest)=>{
  const object=await realGet(key,...rest);
  if(object&&key.startsWith(SEGMENTS))await sleep((MODEL.readBaseMs+MODEL.readMsPerMb*(object.size||0)/1e6)*scale);
  return object;
 };
 store.put=async(key,value,...rest)=>{
  if(key.startsWith(SEGMENTS)){const bytes=Buffer.byteLength(value);written+=bytes;segments++;await sleep((MODEL.putBaseMs+MODEL.putMsPerMb*bytes/1e6)*scale);}
  return realPut(key,value,...rest);
 };
 const before=process.memoryUsage().heapUsed;let peak=before;
 const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().heapUsed);},2);
 const started=Date.now();
 try{await commit(store,4,'bounded',scan(seen,4,churn),concurrency);}finally{clearInterval(timer);fs.rmSync(overlay,{recursive:true,force:true});}
 const wallMs=Date.now()-started;peak=Math.max(peak,process.memoryUsage().heapUsed);
 process.stdout.write(JSON.stringify({concurrency,wallMs,peakHeapMB:Math.round((peak-before)/1e5)/10,segments,archiveMB:Math.round(written/1e5)/10}));
}

const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
if(args[0]==='--child'){await child(Number(args[1]),args[2],Number(args[3]));process.exit(0);}
const output=value('--output');
if(!output||!path.isAbsolute(output)||path.resolve(output).startsWith(REPO+path.sep)){console.error('Usage: node scripts/discovery-archive-window-benchmark.mjs --output /absolute/dir/outside/repo [--total 21000] [--archived 26000] [--seen 20500] [--churn 3500] [--latency-scale 0.02] [--concurrency 1,3]');process.exit(2);}
const sizes={total:Number(value('--total')||21000),archived:Number(value('--archived')||26000),seen:Number(value('--seen')||20500),churn:Number(value('--churn')||3500)};
const scale=Number(value('--latency-scale')||0.02),levels=(value('--concurrency')||'1,3').split(',').map(Number);
fs.mkdirSync(output,{recursive:true});
const dir=fs.mkdtempSync(path.join(output,'archive-window-'));
try{
 const shape=await build(dir,sizes);
 fs.writeFileSync(path.join(dir,'params.json'),JSON.stringify(sizes));
 const results=[];
 for(const level of levels){
  const out=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--child',String(level),dir,String(scale)],{encoding:'utf8',maxBuffer:1<<26});
  if(out.status!==0)throw new Error('child failed: '+out.stderr.slice(0,400));
  results.push(JSON.parse(out.stdout));
 }
 for(const result of results)result.modelledSavingMs=Math.round((results[0].wallMs-result.wallMs)/scale);
 console.log(JSON.stringify({sizes,latencyScale:scale,model:MODEL,shape,results},null,1));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
