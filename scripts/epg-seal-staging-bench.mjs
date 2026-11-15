// AIR-485: offline comparison of EPG seal staging layouts for the steps that read the staged publication after the ledger seal
// (`seal_catalog`, `seal_publish`, `seal_finalize`, `seal_queue`). Nothing here calls Cloudflare, TMDB, R2 or production, and it uses
// no private data: every body is synthetic, sized like the natural runs of 13-14 Nov 2026 (see the AIR-460 evidence).
//
//   npm ci && node scripts/epg-seal-staging-bench.mjs [--films 9226] [--airing 0.3] [--catalog-bytes 12700000]
//        [--programme-bytes 2242013] [--watchlist-bytes 1477694] [--repeat 2] [--out file.json]
//
// Layouts (the step code of A0 is the Worker's own; the others are prototypes built from the Worker's own primitives):
//   A0  main: one `epg/seal/<runId>/payload.json` {report, catalog, watchlist, uncertain, fence, expectedProgrammeRunId}.
//   A1  the same object; `seal_catalog` reads the D1 catalog once instead of twice (no format change). Its other steps are A0's.
//   B   four-object R2 split: report.json, catalog.json, watchlist.json and rest.json (uncertain, fence, expected), which stands in
//       for the manifest (a real one adds the part keys and etags, a few hundred bytes); every step reads only its parts.
//   C   D1-aware: no staged catalog. The staged input is the scan's confirmed availability ({confirmedTmdbId, shows} pairs, the exact
//       input of `replaceCatalogAvailability`), and `seal_catalog` rebuilds the catalog from the live D1 rows with the Worker's own
//       `replaceCatalogAvailability` + `mergeCatalogIdentity`. payload.json keeps report, watchlist, uncertain, fence, expected.
//   C+  C, with the D1 publication rows staged and validated in `published_epg_stage` before the seal, so the pointer unit is the
//       single commit batch (the prototype commit reuses `published_epg_stage`; no new table).
//
// Metrics per (layout, step), each in a fresh child process over a fresh copy of the prepared state:
//   minHeapMB  the smallest --max-old-space-size (MB) at which the step completes, by binary search. It bounds the step's live V8
//              heap including synchronous peaks (a whole-text JSON.parse) that sampling cannot see. It includes the harness and the
//              Worker bundle (`baselineHeapMB`); compare layouts with each other, not with the workerd 128 MiB isolate limit.
//   r2/d1      calls and bytes the step reads and writes (counted in a separate uncapped run).
// Node V8 heap is not the workerd isolate accounting (which also counts ArrayBuffers and native buffers). The ranking is the result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as Authority from '../src/discovery-authority.js';
import {loadWorker} from './discovery-ledger-offline.mjs';
import {scoped} from './bundle-scope.mjs';
import {d1Standin} from '../tests/d1-standin.mjs';
import {sqliteSync} from '../tests/sqlite-session.mjs';

const SELF=fileURLToPath(import.meta.url);
const args=process.argv.slice(2),value=(name,fallback)=>{const i=args.indexOf(name);return i>=0?args[i+1]:fallback;};
const MB=bytes=>Math.round(bytes/1048576*10)/10;
const LAYOUTS=['A0','A1','B','C','C+'];
const STEPS=['catalog','publish','finalize','queue'];
const RUN='run-new',OLD='run-old';

// ---------------------------------------------------------------------------------------------------------------------------------
// A file-backed bucket: bodies stay on disk (R2 is outside the isolate), so the heap holds only what a step decodes.
function fileBucket(dir,counts=null){
 const etagsFile=path.join(dir,'etags.json');
 const etags=fs.existsSync(etagsFile)?JSON.parse(fs.readFileSync(etagsFile,'utf8')):{};
 let revision=Object.keys(etags).length;
 const file=key=>path.join(dir,'r2',encodeURIComponent(key));
 fs.mkdirSync(path.join(dir,'r2'),{recursive:true});
 const note=(kind,bytes)=>{if(!counts)return;counts[kind]=(counts[kind]||0)+1;counts[kind+'Bytes']=(counts[kind+'Bytes']||0)+bytes;};
 const save=()=>fs.writeFileSync(etagsFile,JSON.stringify(etags));
 return {
  save,
  async put(key,v){
   const target=file(key);
   if(typeof v==='string'){fs.writeFileSync(target,v,'utf8');}
   else if(v&&typeof v.getReader==='function'){const fd=fs.openSync(target,'w');const reader=v.getReader();try{for(;;){const step=await reader.read();if(step.done)break;fs.writeSync(fd,step.value);}}finally{fs.closeSync(fd);}}
   else fs.writeFileSync(target,Buffer.from(v));
   etags[key]='e'+(++revision);
   note('put',fs.statSync(target).size);
   return {etag:etags[key]};
  },
  async head(key){const target=file(key);if(!fs.existsSync(target))return null;return {etag:etags[key],size:fs.statSync(target).size};},
  async delete(key){const target=file(key);if(fs.existsSync(target))fs.unlinkSync(target);delete etags[key];},
  async get(key,options={}){
   const target=file(key);if(!fs.existsSync(target))return null;
   const size=fs.statSync(target).size,offset=options.range?.offset??0;
   let read=false;const charge=()=>{if(!read){read=true;note('get',size-offset);}};
   return {etag:etags[key],size:size-offset,
    text:async()=>{charge();const fd=fs.openSync(target,'r');try{const buffer=Buffer.allocUnsafe(size-offset);fs.readSync(fd,buffer,0,buffer.length,offset);return buffer.toString('utf8');}finally{fs.closeSync(fd);}},
    json:async()=>{charge();return JSON.parse(fs.readFileSync(target,'utf8').slice(offset));},
    get body(){charge();const fd=fs.openSync(target,'r');let at=offset;return new ReadableStream({pull(controller){const buffer=Buffer.allocUnsafe(65536);const n=fs.readSync(fd,buffer,0,buffer.length,at);if(!n){fs.closeSync(fd);controller.close();return;}at+=n;controller.enqueue(new Uint8Array(buffer.subarray(0,n)));},cancel(){try{fs.closeSync(fd);}catch{}}});}};
  },
 };
}
// D1 read volume: the rows a statement returns, as the JSON text the sqlite CLI hands back (only in the uncapped counting run).
function countedD1(db,counts){
 const wrap=statement=>({...statement,
  async first(){const row=await statement.first();counts.d1Reads=(counts.d1Reads||0)+1;counts.d1ReadBytes=(counts.d1ReadBytes||0)+(row?JSON.stringify(row).length:0);return row;},
  async all(){const out=await statement.all();counts.d1Reads=(counts.d1Reads||0)+1;counts.d1ReadBytes=(counts.d1ReadBytes||0)+JSON.stringify(out.results||[]).length;return out;},
  async run(){counts.d1Writes=(counts.d1Writes||0)+1;return statement.run();}});
 return {...db,
  prepare(sql){const p=db.prepare(sql);return {bind:(...params)=>wrap(p.bind(...params)),first:()=>wrap(p.bind()).first(),all:()=>wrap(p.bind()).all(),run:()=>wrap(p.bind()).run()};},
  async batch(statements){counts.d1Batches=(counts.d1Batches||0)+1;counts.d1Statements=(counts.d1Statements||0)+statements.length;counts.d1WriteBytes=(counts.d1WriteBytes||0)+statements.reduce((n,s)=>n+(s.text?.length||0),0);return db.batch(statements);},
 };
}
const sql=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};

// ---------------------------------------------------------------------------------------------------------------------------------
function workerContext(){
 const context=loadWorker();
 context.DiscoveryAuthority=Authority;
 vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),context);
 return {context,call:code=>vm.runInContext(code,context)};
}
async function takeLease(env,file,call){sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');const lease=await call('acquireDiscoveryLease')(env,'epg');if(!lease)throw new Error('no lease');env.discoveryLease=lease;return lease;}
const pad=n=>'О'.repeat(Math.max(0,n));
function sized(target,count,make){const probe=Buffer.byteLength(JSON.stringify(make(0,0)));const chars=Math.max(0,Math.floor((target/count-probe)/2));return Array.from({length:count},(_,i)=>make(i,chars));}
const START=1_793_000_000_000;
const showsOf=i=>[0,1,2].map(j=>({channelId:'ch'+((i+j)%150),channel:'Канал '+((i+j)%150),start:START+i*1000+j*3_600_000,end:START+i*1000+j*3_600_000+6_000_000}));

// The staged run: a D1 catalog of `films` admissions (the generation before), a published previous generation, and the staged objects
// of every layout for the new run. Every layout stages the same logical content.
async function prepare(dir,opts){
 fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'d1.sqlite');
 const migrations=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+migrations.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(r.status!==0)throw new Error(r.stderr);
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 sql(file,"UPDATE published_epg_authority SET mode='d1', cutover='open' WHERE id=1");
 const {context,call}=workerContext();
 const bkt=fileBucket(dir);
 const env=()=>({DB:d1Standin(file),BUCKET:bkt,discoveryLease:null});
 {const e=env();const lease=await takeLease(e,file,call);
  await Authority.ingestLedger(e,{programmeRunId:OLD,handoff:true,lease,items:(async function*(){for(let i=0;i<120;i++)yield {key:'k'+i,title:'Старый '+i,normalizedTitle:'старый '+i,year:2001,durations:[100],shows:[],seenInLatestSnapshot:true,lastAiring:START};})()});
  await Authority.releaseLease(e,lease);}
 // The catalog the D1 rows hold before the run (shows of the previous programme), sized to catalogBytes over `films` films.
 const filmCount=opts.films,airing=Math.round(filmCount*opts.airing);
 const before=Object.fromEntries(sized(opts.catalogBytes,filmCount,(i,chars)=>({id:'tmdb_'+i,tmdbId:String(i),canonicalIdentity:'tmdb:'+i,title:'Фильм '+i,original:'Film '+i,year:1990+i%30,synopsis:pad(chars),aliases:[],shows:i%3===0?showsOf(i+7):[],epgLastAiring:i%3===0?START:0,showsProgrammeRunId:OLD})).map(f=>[f.id,f]));
 {const e=env();const lease=await takeLease(e,file,call);const ids=Object.keys(before);
  for(let at=0;at<ids.length;at+=2000)await Authority.upsertAdmissions(e,Object.fromEntries(ids.slice(at,at+2000).map(id=>[id,before[id]])),{lease});
  await Authority.releaseLease(e,lease);}
 // The scan's confirmed availability: one confirmed observation for each airing film, three shows each.
 const availability=Array.from({length:airing},(_,i)=>({confirmedTmdbId:String(i*Math.floor(filmCount/airing)),shows:showsOf(i)}));
 const scanCatalog=call('loadJSON')(env(),'epg/discovered-films.json');
 const catalog=call('replaceCatalogAvailability')(await scanCatalog,availability,RUN).catalog;
 // The previous published generation, then the new run's programme and watchlist.
 const watchFilms=sized(opts.watchlistBytes,396,(i,chars)=>({id:'w'+i,title:'Список '+i,original:'Watch '+i,year:2000,synopsis:pad(chars)}));
 const programmeFilms=sized(opts.programmeBytes,396,(i,chars)=>({id:'w'+i,title:'Список '+i,year:2000,synopsis:pad(chars),shows:showsOf(i).map(s=>({...s,epgTitle:'x'}))}));
 const mk=(runId,stamp)=>({report:{runId,updatedAt:stamp,watchlistCount:396,films:programmeFilms,people:{directors:[],actors:[]},stats:{}},watchlist:{updatedAt:stamp,films:watchFilms}});
 const seed=mk(OLD,'2026-11-12T16:00:00.000Z');
 await call('PublishedEpg').publishGeneration(env(),{programmeRunId:OLD,phase:'published',publishedAt:seed.report.updatedAt,expectedProgrammeRunId:null,programme:seed.report,watchlist:seed.watchlist});
 const live=await call('PublishedEpg').currentGeneration(env());
 const next=mk(RUN,'2026-11-13T16:00:00.000Z');
 const rest={runId:RUN,uncertain:[],fence:live.fence,expectedProgrammeRunId:OLD};
 const staged={};
 const put=async(key,text)=>{await bkt.put(key,text);staged[key]=Buffer.byteLength(text);};
 // A0/A1: today's object, field order as in stageSealedGeneration.
 await put('epg/seal/'+RUN+'/payload.json',JSON.stringify({runId:RUN,report:next.report,catalog,watchlist:next.watchlist,uncertain:rest.uncertain,fence:rest.fence,expectedProgrammeRunId:rest.expectedProgrammeRunId}));
 // B: the split objects.
 await put('bench/B/report.json',JSON.stringify(next.report));
 await put('bench/B/catalog.json',JSON.stringify(catalog));
 await put('bench/B/watchlist.json',JSON.stringify(next.watchlist));
 await put('bench/B/rest.json',JSON.stringify(rest));
 // C: payload without the catalog, and the confirmed availability as its own immutable input.
 await put('bench/C/payload.json',JSON.stringify({runId:RUN,report:next.report,watchlist:next.watchlist,uncertain:rest.uncertain,fence:rest.fence,expectedProgrammeRunId:rest.expectedProgrammeRunId}));
 await put('bench/C/availability.json',JSON.stringify(availability));
 bkt.save();
 // Equivalence: with the D1 rows unchanged since the scan, C rebuilds exactly the catalog that A0 merges.
 const liveCatalog=await call('loadJSON')(env(),'epg/discovered-films.json');
 const viaA=call('mergeCatalogIdentity')(catalog,liveCatalog,RUN);
 const viaC=call('mergeCatalogIdentity')(call('replaceCatalogAvailability')(liveCatalog,availability,RUN).catalog,liveCatalog,RUN);
 const equivalent=JSON.stringify(viaA)===JSON.stringify(viaC);
 if(!equivalent)throw new Error('C catalog is not equivalent to A0');
 const changed=Object.keys(viaA).filter(id=>JSON.stringify(viaA[id])!==JSON.stringify(liveCatalog[id])).length;
 return {staged,films:filmCount,airing,changedFilms:changed,catalogEquivalent:equivalent};
}
// C+ runs on its own copy of the state: the publication rows are staged and validated in published_epg_stage (the commit is stopped right
// after `validate`), which is the work C+ moves out of the pointer unit. Its D1 volume is reported as the cost moved to staging time.
async function stagePlus(dir){
 const {call}=workerContext();
 const file=path.join(dir,'d1.sqlite'),bkt=fileBucket(dir),counts={};
 const read=async key=>JSON.parse(await (await bkt.get(key)).text());
 const report=await read('bench/B/report.json'),watchlist=await read('bench/B/watchlist.json');
 const env={DB:countedD1(d1Standin(file),counts),BUCKET:bkt};
 const started=Date.now();
 try{await call('PublishedEpg').publishGeneration(env,{programmeRunId:RUN,phase:'published',publishedAt:report.updatedAt,expectedProgrammeRunId:OLD,programme:report,watchlist},{owner:'bench-stage',claimTtlMs:60*60*1000,afterValidate:()=>{throw Object.assign(new Error('bench_stop'),{code:'bench_stop'});}});}
 catch(error){if(error.code!=='bench_stop')throw error;}
 const elapsedMs=Date.now()-started;
 const stage=sql(file,"SELECT state, chunk_count AS chunks, member_count AS members, show_count AS shows, document_count AS documents FROM published_epg_stage WHERE programme_run_id='"+RUN+"'")[0];
 if(stage?.state!=='validated')throw new Error('C+ stage not validated: '+JSON.stringify(stage));
 return {stage,elapsedMs,d1:{reads:counts.d1Reads||0,batches:counts.d1Batches||0,statements:counts.d1Statements||0,writeMB:MB(counts.d1WriteBytes||0)}};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Step prototypes for the layouts other than A0. They mirror the Worker's step bodies line for line and differ only in what they read.
async function catalogStep(call,env,run,lease,deadline,layout){
 let next;
 const live=await call('loadJSON')(env,'epg/discovered-films.json')||{};
 if(layout==='A1'){const payload=JSON.parse(await (await env.BUCKET.get('epg/seal/'+run.runId+'/payload.json')).text());next=call('mergeCatalogIdentity')(payload.catalog||{},live,run.runId);}
 else if(layout==='B'){const catalog=JSON.parse(await (await env.BUCKET.get('bench/B/catalog.json')).text());next=call('mergeCatalogIdentity')(catalog,live,run.runId);}
 else{const availability=JSON.parse(await (await env.BUCKET.get('bench/C/availability.json')).text());next=call('mergeCatalogIdentity')(call('replaceCatalogAvailability')(live,availability,run.runId).catalog,live,run.runId);}
 const changed=Object.keys(next).filter(id=>JSON.stringify(next[id])!==JSON.stringify(live[id])).sort();
 let written=0,carried=null;
 for(let at=0;at<changed.length;){
  const slice=changed.slice(at,at+2000);
  const result=await Authority.upsertAdmissions(env,Object.fromEntries(slice.map(id=>[id,next[id]])),{lease,carried,deadline});
  written+=result.written.length;carried=result.carried||null;
  if(result.refused.length)throw new Error('admission_identity_conflict');
  at+=slice.length-(result.remaining||0);
  if(Date.now()>=deadline)break;
 }
 return {done:!changed.length,remaining:changed.length-written,written};
}
function stagedPayload(layout,step){
 return async(env,run)=>{
  const read=async key=>JSON.parse(await (await env.BUCKET.get(key)).text());
  if(layout==='B'){
   const report=await read('bench/B/report.json');
   if(step!=='publish')return {report};
   return {report,watchlist:await read('bench/B/watchlist.json'),...await read('bench/B/rest.json')};
  }
  return read('bench/C/payload.json');
 };
}
// C+: the pointer unit commits the stage that was validated before the seal. Same statements as PublishedEpg's commitPublish, without
// packing a single row: the claim is re-taken by owner and nonce, the pointer moves under the generation fence, and the rows are copied in SQL.
async function commitStaged(call,env,run,payload){
 const db=env.DB,PublishedEpg=call('PublishedEpg');
 const authority=await PublishedEpg.readAuthority(env);
 const stage=await db.prepare("SELECT owner_token AS owner, claim_nonce AS nonce, claim_generation AS generation, payload_sha256 AS sha FROM published_epg_stage WHERE programme_run_id=? AND state='validated'").bind(run.runId).first();
 if(!stage)throw new Error('stage_missing');
 const now=Date.now(),stamp=new Date(now).toISOString(),FENCE='UPDATE published_epg_cas SET ok=changes() WHERE id=1';
 const statements=[
  ["UPDATE published_epg_stage SET claim_expires_at=?, updated_at=? WHERE programme_run_id=? AND owner_token=? AND claim_nonce=? AND claim_generation=? AND state='validated' AND claim_expires_at>?",[now+900000,stamp,run.runId,stage.owner,stage.nonce,stage.generation,now]],[FENCE,[]],
  ["UPDATE published_epg_authority SET programme_run_id=?, generation=generation+1, watchlist_generation=watchlist_generation+1 WHERE id=1 AND mode='d1' AND cutover='open' AND generation=? AND programme_run_id IS ?",[run.runId,authority.generation,payload.expectedProgrammeRunId]],[FENCE,[]],
  ['INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES (?,?,?,?,?)',[run.runId,'published',payload.publishedAt??null,stage.sha,stamp]],
  ["INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) SELECT ?,doc_kind,item_ordinal,payload_json FROM published_epg_stage_row WHERE programme_run_id=? AND kind='document'",[run.runId,run.runId]],
  ["INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) SELECT ?,doc_kind,item_ordinal,film_id FROM published_epg_stage_row WHERE programme_run_id=? AND kind='member'",[run.runId,run.runId]],
  ["INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason) SELECT ?,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason FROM published_epg_stage_row WHERE programme_run_id=? AND kind='show'",[run.runId,run.runId]],
  ["UPDATE published_epg_stage SET state='published', updated_at=? WHERE programme_run_id=? AND owner_token=? AND claim_nonce=? AND state='validated'",[stamp,run.runId,stage.owner,stage.nonce]],[FENCE,[]],
 ];
 await db.batch(statements.map(([text,params])=>db.prepare(text).bind(...params)));
 const after=await PublishedEpg.currentGeneration(env);
 if(after?.programmeRunId!==run.runId)throw new Error('pointer_not_moved');
}

async function child(dir,layout,step,counting){
 const {context,call}=workerContext();
 const counts={};
 const file=path.join(dir,'d1.sqlite');
 const bkt=fileBucket(dir,counting?counts:null);
 const db=counting?countedD1(d1Standin(file),counts):d1Standin(file);
 const env={DB:db,BUCKET:bkt,discoveryLease:null};
 // The consumers that are the same in every layout and not part of the staging are stubbed identically: they hold the report the step read.
 const held=[];
 context.queueCommittedDiscovery=async()=>{};
 context.ratingsGate=async()=>({active:false,migration:'none'});
 context.persistWatchlist=async(e,r,report)=>{held.push(report.films.length);};
 context.persistScan=async(e,r,report)=>{held.push(report.films.length);};
 context.persistEvents=async(e,r,report)=>{held.push(report.films.length);};
 context.refreshPredictionQueue=async(e,report)=>{held.push(report.films.length);};
 context.prepareEpgCompletion=async()=>{};context.flushEpgEvent=async()=>{};
 if(layout!=='A0'&&step!=='catalog')context.sealPayload=stagedPayload(layout==='C+'?'C':layout,step);
 if(layout==='C+'&&step==='publish')call('PublishedEpg').publishGeneration=async(e,input)=>{await commitStaged(call,e,{runId:input.programmeRunId},{expectedProgrammeRunId:input.expectedProgrammeRunId,publishedAt:input.publishedAt});return {replay:false};};
 const lease=await takeLease(env,file,call);
 for(const key of Object.keys(counts))delete counts[key];
 if(global.gc)global.gc();
 const baselineHeapMB=MB(process.memoryUsage().heapUsed);
 const run={runId:RUN,stage:'seal',seal:{jobId:'job-1',phase:step},watchlist:[],events:[]};
 const started=Date.now();
 let out;
 if(step==='catalog')out=layout==='A0'?await call('sealCatalogStep')(env,run,lease,Date.now()-1):await catalogStep(call,env,run,lease,Date.now()-1,layout);
 else if(step==='publish'){out=await call('sealPublishStep')(env,run,lease,Infinity);if(run.seal.phase!=='finalize')throw new Error('publish incomplete '+JSON.stringify(run.seal));const g=await call('PublishedEpg').currentGeneration(env);if(g?.programmeRunId!==RUN)throw new Error('pointer not moved');}
 else if(step==='finalize'){out=await call('sealFinalizeStep')(env,run,Infinity);if(run.seal.phase!=='queue')throw new Error('finalize incomplete');}
 else{out=await call('sealQueueStep')(env,run,Infinity);if(run.stage!=='complete')throw new Error('queue incomplete');}
 const elapsedMs=Date.now()-started;
 if(step==='catalog'&&!(out.written>0))throw new Error('catalog wrote nothing');
 return {layout,step,baselineHeapMB,elapsedMs,counts,written:out?.written};
}

// ---------------------------------------------------------------------------------------------------------------------------------
function copyState(from){const to=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-staging-run-'));fs.cpSync(from,to,{recursive:true});return to;}
function runChild(state,layout,step,{heapMB=null,counting=false}={}){
 const dir=copyState(state);
 const flags=['--expose-gc','--max-semi-space-size=2',...(heapMB?['--max-old-space-size='+heapMB]:[])];
 const r=spawnSync(process.execPath,[...flags,SELF,'--child',dir,layout,step,counting?'count':'heap'],{encoding:'utf8',maxBuffer:1<<26});
 fs.rmSync(dir,{recursive:true,force:true});
 const line=(r.stdout||'').trim().split('\n').filter(Boolean).pop();
 let parsed=null;try{parsed=line?JSON.parse(line):null;}catch{}
 return {ok:r.status===0&&parsed&&!parsed.error,result:parsed,stderr:(r.stderr||'').slice(-400)};
}
function minHeap(state,layout,step){
 let lo=8,hi=512;
 if(!runChild(state,layout,step,{heapMB:hi}).ok)return null;
 while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(runChild(state,layout,step,{heapMB:mid}).ok)hi=mid;else lo=mid;}
 return hi;
}

if(args[0]==='--child'){
 const [,dir,layout,step,mode]=args;
 try{console.log(JSON.stringify(await child(dir,layout,step,mode==='count')));}
 catch(error){console.log(JSON.stringify({error:String(error&&error.stack||error).split('\n').slice(0,4).join(' | ')}));process.exitCode=1;}
}else{
 const opts={films:Number(value('--films','9226')),airing:Number(value('--airing','0.3')),catalogBytes:Number(value('--catalog-bytes','12700000')),programmeBytes:Number(value('--programme-bytes','2242013')),watchlistBytes:Number(value('--watchlist-bytes','1477694'))};
 const repeat=Number(value('--repeat','2'));
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-staging-state-'));
 const started=Date.now();
 const prepared=await prepare(state,opts);
 const statePlus=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-staging-plus-'));
 fs.cpSync(state,statePlus,{recursive:true});
 prepared.plus=await stagePlus(statePlus);
 const only=value('--only','');
 const rows=[];let failed=false;
 for(const step of STEPS)for(const layout of LAYOUTS){
  if(layout==='C+'&&step!=='publish')continue;
  // A1 changes `seal_catalog` only; its other steps are A0's.
  if(layout==='A1'&&step!=='catalog')continue;
  if(only&&only!==layout+':'+step)continue;
  const source=layout==='C+'?statePlus:state;
  const counted=runChild(source,layout,step,{counting:true});
  if(!counted.ok){failed=true;rows.push({layout,step,error:counted.result?.error||counted.stderr});console.error(JSON.stringify(rows.at(-1)));continue;}
  const heaps=[];for(let i=0;i<repeat;i++)heaps.push(minHeap(source,layout,step));
  const c=counted.result.counts;
  rows.push({layout,step,minHeapMB:heaps,baselineHeapMB:counted.result.baselineHeapMB,elapsedMs:counted.result.elapsedMs,written:counted.result.written,
   r2:{gets:c.get||0,getMB:MB(c.getBytes||0),puts:c.put||0,putMB:MB(c.putBytes||0)},
   d1:{reads:c.d1Reads||0,readMB:MB(c.d1ReadBytes||0),batches:c.d1Batches||0,statements:c.d1Statements||0,writeMB:MB(c.d1WriteBytes||0)}});
  console.error(JSON.stringify(rows.at(-1)));
 }
 const result={node:process.version,volumes:opts,prepared:{...prepared,staged:Object.fromEntries(Object.entries(prepared.staged).map(([k,v])=>[k,MB(v)]))},rows,elapsedSec:Math.round((Date.now()-started)/1000)};
 fs.rmSync(state,{recursive:true,force:true});fs.rmSync(statePlus,{recursive:true,force:true});
 const out=value('--out','');
 if(out)fs.writeFileSync(out,JSON.stringify(result,null,1)+'\n');
 console.log(JSON.stringify(result));
 if(failed)process.exitCode=1;
}
