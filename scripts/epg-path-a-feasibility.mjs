// AIR-470 / ADR 0139, Path A feasibility gate. OFFLINE ONLY: no Cloudflare, no production, no network.
//
// Question: with the real production seal and planner UNCHANGED (`stageSealedGeneration` -> `planDiscoveryLedger`, `src/worker.js` is only loaded, never edited) and only the
// active scan materialized as the array they expect, does a full-scale replay fit with a usable margin in the 128 MB Worker budget?
//
//   node scripts/epg-path-a-feasibility.mjs build   --dir /abs/tmp/dir [--active 42156] [--archived 40213] [--item-bytes 1200]
//   node scripts/epg-path-a-feasibility.mjs measure --dir /abs/tmp/dir [--departures 2000] [--returns 200] [--heap-mb 128]
//
// `build` runs unconstrained: it creates the sanitized synthetic baseline with the real planner and real ledger writers (a published active ledger in a D1 stand-in plus the real
// archive segments, manifest and pointer in a file-backed bucket). `measure` copies that baseline, then runs ONE real `stageSealedGeneration` in a fresh Node process whose old
// space is capped at --heap-mb, while sampling heap, external memory and RSS. Everything measured here is Node and a sqlite stand-in, never a Cloudflare isolate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import v8 from 'node:v8';
import * as Authority from '../src/discovery-authority.js';
import {loadWorker} from './discovery-ledger-offline.mjs';
import {d1Standin} from '../tests/d1-standin.mjs';
import {sqliteSync} from '../tests/sqlite-session.mjs';

const SELF=fileURLToPath(import.meta.url),REPO=path.resolve(path.dirname(SELF),'..');
const MIB=1024*1024;
const CHAIN=fs.readdirSync(path.join(REPO,'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const RUN=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const POINTER='epg/discovery-archive/v1/current.json',GENERATION_POINTER='epg/published-generation.json';

// ---- a deterministic, sanitized synthetic record in the shape of a Discovery candidate (no production payload, no real title) -------------------------------------------------
const WORDS=['alpha','bravo','carbon','delta','ember','fjord','garnet','harbor','iris','juniper','kelvin','lumen','meadow','nectar','opal','prism'];
function description(i,bytes){
 const parts=[];let state=createHash('sha256').update('desc|'+i).digest(),size=0;
 while(size<bytes){state=createHash('sha256').update(state).digest();const word=WORDS[state[0]%16]+state[1].toString(16);parts.push(word);size+=word.length+1;}
 return parts.join(' ').slice(0,bytes);
}
export function syntheticScan(from,to,{day=0,itemBytes=1200}={}){
 const base=Date.UTC(2026,9,20,12)+day*86400000,out=[];
 for(let i=from;i<to;i++){
  const title='Synthetic film '+i,year=1950+i%70,start=base+(i%12)*3600000;
  out.push({key:null,confirmedTmdbId:null,title,rawTitles:[title],normalizedTitle:null,year,duration:90+i%5*5,description:description(i,itemBytes),firstAiring:start,lastAiring:start,airings:1,
   shows:[{channelId:'ch'+i%7,channel:'Channel '+i%7,start,end:start+5400000,epgTitle:title}]});
 }
 return out;
}

// ---- a file-backed R2 stand-in: objects live on disk, so what is measured is the heap of the code under test, not of the fixture -----------------------------------------------
export function fileBucket(dir,{chunk=65536}={}){
 fs.mkdirSync(dir,{recursive:true});
 const name=key=>path.join(dir,encodeURIComponent(key));
 const etags=new Map();let revision=0;
 const readBody=async value=>{
  if(typeof value==='string')return Buffer.from(value,'utf8');
  if(value&&typeof value.getReader==='function'){const reader=value.getReader(),parts=[];for(;;){const step=await reader.read();if(step.done)break;parts.push(Buffer.from(step.value));}return Buffer.concat(parts);}
  if(value instanceof Uint8Array)return Buffer.from(value);
  return Buffer.from(String(value));
 };
 const currentEtag=key=>etags.get(key)||'f'+fs.statSync(name(key)).size;
 const store={puts:[],gets:[],bytesWritten:0,bytesRead:0,
  async put(key,value,options={}){
   const exists=fs.existsSync(name(key)),c=options.onlyIf;
   if(c?.etagDoesNotMatch==='*'&&exists)return null;
   if(c?.etagMatches&&(!exists||c.etagMatches!==currentEtag(key)))return null;
   // A stream is written to disk chunk by chunk (as R2 receives a known-length body), never concatenated; it becomes visible only when complete.
   const temp=name(key)+'.part';let written=0;
   if(value&&typeof value.getReader==='function'){
    const handle=fs.openSync(temp,'w');
    try{const reader=value.getReader();for(;;){const step=await reader.read();if(step.done)break;fs.writeSync(handle,step.value);written+=step.value.length;}}
    finally{fs.closeSync(handle);}
    fs.renameSync(temp,name(key));
   }else{const bytes=await readBody(value);fs.writeFileSync(temp,bytes);fs.renameSync(temp,name(key));written=bytes.length;}
   etags.set(key,'e'+(++revision));store.puts.push(key);store.bytesWritten+=written;
   return {etag:etags.get(key)};
  },
  async head(key){return fs.existsSync(name(key))?{etag:currentEtag(key),size:fs.statSync(name(key)).size}:null;},
  async delete(key){fs.rmSync(name(key),{force:true});etags.delete(key);},
  async list({prefix='',limit=1000}={}){return {objects:fs.readdirSync(dir).filter(file=>!file.endsWith('.part')).map(decodeURIComponent).filter(key=>key.startsWith(prefix)).sort().slice(0,limit).map(key=>({key})),truncated:false};},
  async get(key,options={}){
   if(!fs.existsSync(name(key)))return null;
   store.gets.push(key);
   const file=name(key),size=fs.statSync(file).size,offset=options.range?.offset??0,etag=currentEtag(key);
   const read=()=>{const bytes=fs.readFileSync(file).subarray(offset);store.bytesRead+=bytes.length;return bytes;};
   // The body is demand-driven: one bounded chunk is read from disk per pull, so a consumer that stops pulling holds one chunk, never the object.
   let position=offset,handle=null;
   const body=new ReadableStream({
    pull(controller){
     handle??=fs.openSync(file,'r');
     const buffer=Buffer.allocUnsafe(Math.min(chunk,Math.max(1,size-position)));
     const n=position>=size?0:fs.readSync(handle,buffer,0,buffer.length,position);
     if(n===0){fs.closeSync(handle);handle=null;controller.close();return;}
     position+=n;store.bytesRead+=n;
     controller.enqueue(new Uint8Array(buffer.buffer,buffer.byteOffset,n));
    },
    cancel(){if(handle!==null){fs.closeSync(handle);handle=null;}},
   },{highWaterMark:1});
   return {etag,size,text:async()=>read().toString('utf8'),json:async()=>JSON.parse(read().toString('utf8')),body};
  },
 };
 return store;
}

function database(file){
 const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+CHAIN.map(x=>fs.readFileSync(path.join(REPO,'migrations',x),'utf8')).join('\n'),encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 sqliteSync(['-bail',file],{input:"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1;",encoding:'utf8'});
}
// The Worker with the modules the seal needs; published-generation authority is a plain stand-in as in the bounded-ledger tests.
function worker(state){
 const context=loadWorker();context.DiscoveryAuthority=Authority;
 context.PublishedEpg={
  async readAuthority(){return {cutover:'open',mode:'d1'};},
  async currentGeneration(){return state.published?{programmeRunId:state.published.programmeRunId,phase:'published',fence:state.published.fence}:null;},
 };
 return context;
}
const envOf=(state)=>({DB:d1Standin(state.file,{maxBinds:100}),BUCKET:state.bucket,discoveryLease:null,DISCOVERY_LEDGER_MODE:'bounded'});

// ---- build -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function build({dir,active,archived,itemBytes}){
 fs.mkdirSync(dir,{recursive:true});
 const state={file:path.join(dir,'d1.sqlite'),bucket:fileBucket(path.join(dir,'r2')),published:null};
 database(state.file);
 const context=worker(state),call=code=>context.eval?context.eval(code):null;
 void call;
 const vm=await import('node:vm'),run=code=>vm.runInContext(code,context);
 const merge=run('mergeDiscoveryCandidates');
 // Generation 1: the ledger of day 0 holds ACTIVE + ARCHIVED observations (the universe), installed the way a cutover installs a ledger.
 const universe=active+archived,id0=RUN(1),at0=new Date(Date.UTC(2026,9,20,12)).toISOString();
 const first=merge([],syntheticScan(0,universe,{day:0,itemBytes}),{replaceShows:true,programmeRunId:id0});
 const framing=run('discoveryDocumentFraming')({programmeRunId:id0},{}),encoder=new TextEncoder();
 const encoded=first.map(item=>encoder.encode(JSON.stringify(item)));
 await state.bucket.put('epg/generations/'+id0+'/discovery-latest.json',run('discoveryDocumentStream')(framing,(async function*(){for(const bytes of encoded)yield bytes;})()));
 const env=envOf(state);
 const taken=await Authority.acquireLease(env,{programmeRunId:null,role:'epg'});env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:id0,handoff:true,lease:taken.lease,items:(async function*(){for(const item of first)yield item;})()});
 await Authority.releaseLease(env,taken.lease);
 state.published={programmeRunId:id0,fence:'g1'};
 return {state,context,run,universe};
}

// One EPG commit and its ledger seal by the Worker's own functions (the pattern of tests/discovery-bounded-lib.mjs `commit`), over the file-backed bucket.
async function commit(state,context,run,day,latest){
 const id=RUN(day+1),at=new Date(Date.UTC(2026,9,20,12)+day*86400000).toISOString();
 await state.bucket.put('sync.json',JSON.stringify({runId:id,stage:'epg',startedAt:at,updatedAt:at}));
 const runDoc={runId:id,stage:'epg',startedAt:at,watchlist:[],events:[]};
 sqliteSync(['-bail',state.file],{input:'UPDATE discovery_lease SET expires_at=1 WHERE id=1;',encoding:'utf8'});
 const env=envOf(state);
 await run('stageSealedGeneration')(env,runDoc,{holder:{discovery:latest},meta:{programmeRunId:id,updatedAt:at},pending:{'programme.json':{runId:id,updatedAt:at},'discovered-films.json':{}},nextWatchlist:{updatedAt:at,films:[]},uncertain:[],publication:{programmeRunId:state.published.programmeRunId,phase:'published',fence:state.published.fence}});
 let done=false,steps=0;
 while(!done){
  steps++;assert.ok(steps<200,'the seal must finish');
  sqliteSync(['-bail',state.file],{input:'UPDATE discovery_lease SET expires_at=1 WHERE id=1;',encoding:'utf8'});
  const stepEnv=envOf(state),lease=await run('acquireDiscoveryLease')(stepEnv,'epg');
  done=(await run('sealLedgerStep')(stepEnv,runDoc,lease,Date.now()+60000)).done;
 }
 state.published={programmeRunId:id,fence:'g'+(day+1)};
 void context;
 return {steps,runId:id};
}
function archiveSummary(state){
 const pointer=state.bucket.puts.includes(POINTER)?JSON.parse(fs.readFileSync(path.join(state.dir,'r2',encodeURIComponent(POINTER)),'utf8')):null;
 if(!pointer)return null;
 const manifest=JSON.parse(fs.readFileSync(path.join(state.dir,'r2',encodeURIComponent('epg/discovery-archive/v1/manifests/'+pointer.manifestId+'.json')),'utf8'));
 return {manifestId:pointer.manifestId,segments:manifest.segmentCount,items:manifest.totals.items,bytes:manifest.totals.bytes};
}

// A bounded line reader: one line in flight, nothing else retained.
async function* lines(file){
 const reader=readline.createInterface({input:fs.createReadStream(file,{encoding:'utf8',highWaterMark:64*1024}),crlfDelay:Infinity});
 for await(const line of reader)if(line)yield line;
}
// ---- measure: copy the baseline, run the real seal stage once in a heap-capped fresh process ------------------------------------------------------------------------------------
function measure({dir,departures,returns,heapMb,keep}){
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-path-a-'));
 fs.cpSync(dir,work,{recursive:true});
 const started=Date.now();
 const result=spawnSync(process.execPath,['--expose-gc',`--max-old-space-size=${heapMb}`,SELF,'child','--dir',work,'--departures',String(departures),'--returns',String(returns)],{encoding:'utf8',maxBuffer:1<<26});
 const out=(result.stdout||'').trim().split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
 const report=out.find(entry=>entry.sealed)||null,phases=out.filter(entry=>entry.phase);
 const lastPhase=phases.length?phases[phases.length-1].phase:null;
 const oom=/heap out of memory|JavaScript heap|Allocation failed/i.test(result.stderr||'');
 // The semantic check runs in this unconstrained parent, after the capped process has ended, so verification cannot add to the measured heap.
 const verified=report?verifySeal(work,report):null;
 console.log(JSON.stringify({command:'measure',verified,heapMb,departures,returns,exit:result.status,signal:result.signal,oom,failedAfterPhase:report?null:lastPhase,phases,wallMs:Date.now()-started,report,stderrTail:oom?(result.stderr||'').split('\n').slice(0,3).join(' | ').slice(0,300):(result.stderr||'').slice(-300)}));
 if(!keep&&path.basename(work).startsWith('iptv-path-a-')&&path.dirname(work)===os.tmpdir())fs.rmSync(work,{recursive:true,force:true});
}
function verifySeal(work,report){
 const r2=path.join(work,'r2'),read=key=>JSON.parse(fs.readFileSync(path.join(r2,encodeURIComponent(key)),'utf8'));
 const doc=read('epg/generations/'+RUN(3)+'/discovery-latest.json'),manifest=read('epg/discovery-archive/v1/manifests/'+read(POINTER).manifestId+'.json');
 const expected=report.activeBefore-report.departures+report.returns;
 return {expectedItems:expected,scanItems:report.scanItems,ledgerItemsAfter:doc.items.length,upsertedKeys:(manifest.upsertedKeys||[]).length,departures:report.departures,archiveItemsAfter:manifest.totals.items,
  exact:report.scanItems===expected&&doc.items.length===expected&&(manifest.upsertedKeys||[]).length===report.departures};
}
async function child({dir,departures,returns}){
 const vm=await import('node:vm');
 const base=JSON.parse(fs.readFileSync(path.join(dir,'baseline.json'),'utf8'));
 const state={file:path.join(dir,'d1.sqlite'),dir,bucket:fileBucket(path.join(dir,'r2')),published:{programmeRunId:base.programmeRunId,fence:base.fence}};
 const context=worker(state),run=code=>vm.runInContext(code,context);
 const stage=run('stageSealedGeneration'),keyOf=run('discoveryCandidateKey');
 global.gc?.();
 const idle=process.memoryUsage();
 const mibOf=m=>({heapUsed:Math.round(m.heapUsed/MIB*10)/10,external:Math.round(m.external/MIB*10)/10,arrayBuffers:Math.round(m.arrayBuffers/MIB*10)/10,rss:Math.round(m.rss/MIB*10)/10});
 const phase=(name,extra={})=>{console.log(JSON.stringify({phase:name,memoryMiB:mibOf(process.memoryUsage()),...extra}));};
 phase('before_read');
 const peak={heapUsed:0,external:0,arrayBuffers:0,rss:0};
 const sample=()=>{const m=process.memoryUsage();for(const name of Object.keys(peak))peak[name]=Math.max(peak[name],m[name]);};
 const timer=setInterval(sample,10);
 // The scan, materialized as the plain array the planner expects: the active ledger without the departures, plus the returned payloads.
 const everyN=Math.max(1,Math.floor(base.activeItems/Math.max(1,departures)));
 let scan=[];let departed=0,index=0;
 for await(const line of lines(path.join(dir,'scan.ndjson'))){
  const item=JSON.parse(line);
  if(departed<departures&&index%everyN===0){departed++;index++;continue;}
  index++;scan.push(item);
 }
 let returned=0;
 for await(const line of lines(path.join(dir,'returns.ndjson'))){if(returned>=returns)break;scan.push(JSON.parse(line));returned++;}
 sample();phase('after_load',{scanItems:scan.length});
 global.gc?.();const scanLoaded=process.memoryUsage();phase('after_gc_retained_scan',{scanItems:scan.length});
 const id=RUN(3),at=new Date(Date.UTC(2026,9,21,12)).toISOString();
 await state.bucket.put('sync.json',JSON.stringify({runId:id,stage:'epg',startedAt:at,updatedAt:at}));
 const runDoc={runId:id,stage:'epg',startedAt:at,watchlist:[],events:[]};
 sqliteSync(['-bail',state.file],{input:'UPDATE discovery_lease SET expires_at=1 WHERE id=1;',encoding:'utf8'});
 const env=envOf(state),scanSize=scan.length,started=Date.now();phase('seal_start');const loadPeak={...peak};for(const name of Object.keys(peak))peak[name]=0;
 await stage(env,runDoc,{holder:{discovery:scan},meta:{programmeRunId:id,updatedAt:at},pending:{'programme.json':{runId:id,updatedAt:at},'discovered-films.json':{}},nextWatchlist:{updatedAt:at,films:[]},uncertain:[],publication:{programmeRunId:base.programmeRunId,phase:'published',fence:base.fence}});
 const stageMs=Date.now()-started;phase('seal_done');
 clearInterval(timer);sample();
 scan=null;
 const mib=n=>Math.round(n/MIB*10)/10;
 console.log(JSON.stringify({sealed:true,scanItems:scanSize,departures:departed,returns:returned,activeBefore:base.activeItems,stageMs,r2:{puts:state.bucket.puts.length,gets:state.bucket.gets.length,bytesWritten:state.bucket.bytesWritten,bytesRead:state.bucket.bytesRead},
  memoryMiB:{idle:{heapUsed:mib(idle.heapUsed),rss:mib(idle.rss)},retainedScan:{heapUsed:mib(scanLoaded.heapUsed),external:mib(scanLoaded.external),rss:mib(scanLoaded.rss)},
   loadPeak:{heapUsed:mib(loadPeak.heapUsed),rss:mib(loadPeak.rss)},sealPeak:{heapUsed:mib(peak.heapUsed),external:mib(peak.external),arrayBuffers:mib(peak.arrayBuffers),rss:mib(peak.rss)},heapSizeLimit:mib(v8.getHeapStatistics().heap_size_limit)},keyOf:typeof keyOf}));
}
const active0=(rest,flag)=>Number(flag('--active',42156));
// The published active ledger (the scan a dataset would hold) as NDJSON, and a pool of archive-only payloads for returns, written by the unconstrained builder so the measured process
// reads them line by line, the way a part reader would. No archive record is kept in memory by the measured process other than the returns it asks for.
function writeReplayInputs(dir,state,pool){
 const r2=path.join(dir,'r2'),read=key=>JSON.parse(fs.readFileSync(path.join(r2,encodeURIComponent(key)),'utf8'));
 const doc=read('epg/generations/'+state.published.programmeRunId+'/discovery-latest.json');
 fs.writeFileSync(path.join(dir,'scan.ndjson'),doc.items.map(item=>JSON.stringify(item)).join('\n')+'\n');
 const manifest=read('epg/discovery-archive/v1/manifests/'+read(POINTER).manifestId+'.json'),active=new Set(doc.items.map(item=>item.key)),returns=[];
 for(const entry of manifest.segments){
  if(!entry.object||returns.length>=pool)continue;
  for(const [key,record] of Object.entries(read(entry.object).items)){if(!active.has(key)&&returns.length<pool)returns.push(record.payload);}
 }
 fs.writeFileSync(path.join(dir,'returns.ndjson'),returns.map(item=>JSON.stringify(item)).join('\n')+'\n');
 fs.writeFileSync(path.join(dir,'baseline.json'),JSON.stringify({programmeRunId:state.published.programmeRunId,fence:state.published.fence,activeItems:doc.items.length,returnsPool:returns.length}));
}
// `build` writes only into a scratch directory this tool may own: inside the OS temp directory, never inside or above the checkout, no symlink on the way, and either absent or
// EMPTY. It never removes anything; a non-empty directory is refused and left as it is.
export function scratchDirectory(dir){
 assert.ok(typeof dir==='string'&&path.isAbsolute(dir),'--dir must be an absolute scratch directory');
 const resolved=path.resolve(dir),tmp=fs.realpathSync(os.tmpdir()),repo=fs.realpathSync(REPO);
 let probe=resolved;const missing=[];
 while(!fs.existsSync(probe)){missing.push(path.basename(probe));const parent=path.dirname(probe);assert.ok(parent!==probe,'--dir has no existing ancestor');probe=parent;}
 const real=fs.realpathSync(probe),expected=path.resolve(probe);
 assert.equal(real,expected,'--dir must not pass through a symlink');
 const target=path.join(real,...missing.reverse());
 assert.ok(target.startsWith(tmp+path.sep),'--dir must be inside the OS temp directory');
 assert.ok(!(target===repo||target.startsWith(repo+path.sep)||repo.startsWith(target+path.sep)),'--dir must not be inside or above the repository');
 if(fs.existsSync(target)){
  assert.ok(fs.statSync(target).isDirectory(),'--dir must be a directory');
  assert.equal(fs.readdirSync(target).length,0,'--dir must be empty: it is never cleared');
 }
 return target;
}
export async function main(argv){
 const [command,...rest]=argv,flag=(name,fallback)=>{const i=rest.indexOf(name);return i<0?fallback:rest[i+1];};
 const dir=flag('--dir');
 assert.ok(dir&&path.isAbsolute(dir),'--dir must be an absolute scratch directory');
 if(command==='build'){
  scratchDirectory(dir);
  const started=Date.now(),result=await build({dir,active:Number(flag('--active',42156)),archived:Number(flag('--archived',40213)),itemBytes:Number(flag('--item-bytes',1200))});
  result.state.dir=dir;
  const activeScan=syntheticScan(0,active0(rest,flag),{day:1,itemBytes:Number(flag('--item-bytes',1200))});
  const sealed=await commit(result.state,result.context,result.run,1,activeScan);
  writeReplayInputs(dir,result.state,Number(flag('--returns-pool',2000)));
  console.log(JSON.stringify({command,universe:result.universe,activeScan:activeScan.length,seal:sealed,archive:archiveSummary(result.state),ms:Date.now()-started,r2Objects:fs.readdirSync(path.join(dir,'r2')).length}));
  return;
 }
 if(command==='measure')return measure({dir,departures:Number(flag('--departures',2000)),returns:Number(flag('--returns',200)),heapMb:Number(flag('--heap-mb',128)),keep:rest.includes('--keep')});
 if(command==='child')return child({dir,departures:Number(flag('--departures',2000)),returns:Number(flag('--returns',200))});
 throw new Error('unknown command');
}
if(process.argv[1]&&path.resolve(process.argv[1])===SELF)main(process.argv.slice(2)).catch(error=>{console.error(error);process.exit(1);});
void GENERATION_POINTER;
