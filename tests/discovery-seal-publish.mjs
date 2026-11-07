// ADR 0092: the staged publication in the Worker. The ledger is read from the immutable generation document by byte
// offset, sealed in bounded steps that survive cancellation, and the catalog is brought up to date by its difference.
// Local sqlite stand-ins and an in-memory bucket with range reads; nothing here calls Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as Authority from '../src/discovery-authority.js';
import {loadWorker} from '../scripts/discovery-ledger-offline.mjs';
import {d1Standin} from './d1-standin.mjs';

const context=loadWorker();
context.DiscoveryAuthority=Authority;
const call=code=>vm.runInContext(code,context);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-publish-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal'];
let n=0;
const sql=(file,text)=>{const r=spawnSync('sqlite3',['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const migrate=()=>{const file=path.join(root,'p-'+(n++)+'.sqlite');const r=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'),encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");return file;};
const count=(file,where)=>Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_observation WHERE '+where)[0].n);

// An in-memory bucket with what the seal needs of R2: put (string or stream), get with a byte range and a chunked body, head, delete.
function bucket(chunk=7){
 const objects=new Map();let revision=0;
 const read=async value=>{if(typeof value==='string')return Buffer.from(value,'utf8');if(value&&typeof value.getReader==='function'){const reader=value.getReader(),parts=[];for(;;){const step=await reader.read();if(step.done)break;parts.push(Buffer.from(step.value));}return Buffer.concat(parts);}return Buffer.from(value);};
 return {
  objects,
  async put(key,value){const bytes=await read(value);objects.set(key,{bytes,etag:'e'+(++revision)});return {etag:objects.get(key).etag};},
  async head(key){const o=objects.get(key);return o?{etag:o.etag,size:o.bytes.length}:null;},
  async delete(key){objects.delete(key);},
  async get(key,options={}){
   const o=objects.get(key);if(!o)return null;
   const offset=options.range?.offset??0,bytes=o.bytes.subarray(offset);
   return {etag:o.etag,text:async()=>bytes.toString('utf8'),json:async()=>JSON.parse(bytes.toString('utf8')),body:new ReadableStream({start(controller){for(let at=0;at<bytes.length;at+=chunk)controller.enqueue(new Uint8Array(bytes.subarray(at,at+chunk)));controller.close();}})};
  },
 };
}
const item=(key,title)=>({key,title,normalizedTitle:title.toLowerCase(),year:2001,durations:[100],shows:[{channelId:'c',channel:'Канал',start:1793000000000,end:1793000100000},{channelId:'d',channel:'D',start:1793000200000,end:1793000300000}],seenInLatestSnapshot:true,lastAiring:1793000000000});
const TITLES=['Брат','Сталкер','Солярис','Зеркало','Кин-дза-дза','Ирония судьбы','Кавычки "цитата"','Скобка {блок}','Descripción — ñ','日本語のタイトル'];
const keys=(a,b)=>Array.from({length:b-a},(_,i)=>'k'+String(a+i).padStart(5,'0'));
const NEW=keys(20,270).map((key,i)=>item(key,TITLES[i%TITLES.length]+' '+i));

// Builds the immutable generation document exactly as the commit does, with the Worker's own framing.
async function stageDocument(bkt,items,runId){
 const framing=call('discoveryDocumentFraming')({programmeRunId:runId},{ledgerMode:'bounded'});
 const encoder=new TextEncoder(),encoded=items.map(i=>encoder.encode(JSON.stringify(i)));
 const length=call('discoveryDocumentLength')(framing,encoded.reduce((a,b)=>a+b.byteLength,0),encoded.length);
 const stream=call('discoveryDocumentStream')(framing,(async function*(){for(const bytes of encoded)yield bytes;})());
 const key='epg/generations/'+runId+'/discovery-latest.json';
 await bkt.put(key,stream);
 const head=await bkt.head(key);
 assert.equal(head.size,length,'the document has the length the commit computes');
 return {key,etag:head.etag,prefixBytes:framing.prefix.byteLength,itemTotal:items.length};
}
async function committedOld(file){
 const env={DB:d1Standin(file),BUCKET:bucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:'run-old',handoff:true,lease:taken.lease,items:(async function*(){for(const k of keys(0,120))yield item(k,'Старый '+k);})()});
 await Authority.releaseLease(env,taken.lease);
}
const stepEnv=(file,bkt,hooks={})=>({DB:d1Standin(file,hooks),BUCKET:bkt,discoveryLease:null});
async function takeLease(env,file){sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');const lease=await call('acquireDiscoveryLease')(env);assert.ok(lease,'a lease');return lease;}

// 1. The ledger is sealed over several steps, with cancellations, from byte offsets in a document with multibyte text.
{
 const file=migrate();await committedOld(file);
 const bkt=bucket(7);
 const job=await stageDocument(bkt,NEW,'run-new');
 const run={runId:'run-new',stage:'seal',seal:{jobId:'job-1',phase:'ledger',sourceKey:job.key,etag:job.etag,itemTotal:job.itemTotal,prefixBytes:job.prefixBytes}};
 let steps=0,killed=0,done=false,lastCursor=-1;
 while(!done&&steps<60){
  steps++;
  // Every third step is cancelled in the middle of a batch.
  let seen=0;const dying=steps%3===0;
  const env=stepEnv(file,bkt,dying?{onBatch(){seen++;if(seen===3){killed++;throw new Error('cancelled');}}}:{});
  const lease=await takeLease(env,file);
  try{
   // A step with its time already spent does one flush of at least SEAL_FLUSH_ITEMS and stops.
   const result=await call('sealLedgerStep')(env,run,lease,Date.now()-1);
   done=result.done;
  }catch(error){assert.ok(/cancelled/.test(String(error.message))||error.cause,String(error.message));}
  const state=await Authority.sealState(env);
  if(process.env.DEBUG_SEAL)console.log(steps,state.phase,state.cursorItems,state.itemTotal,dying?'dying':'');
  assert.ok(state.cursorItems>=lastCursor,'the cursor never goes back');lastCursor=state.cursorItems;
  // The rows and the cursor agree after every step, killed or not.
  if(state.phase==='items')assert.equal(count(file,"source_key='active' AND residence='active' AND programme_run_id='run-new'"),state.cursorItems);
 }
 assert.ok(done,'the ledger seals within '+steps+' steps');
 assert.ok(killed>0,'cancellations happened');
 assert.ok(steps>=5,'bounded steps: '+steps);
 assert.equal(sql(file,'SELECT state FROM discovery_transfer')[0].state,'committed');
 assert.equal(count(file,"source_key='active' AND residence='active' AND programme_run_id='run-new'"),NEW.length);
 // Every item arrived whole, in order, multibyte text intact.
 const stored=sql(file,"SELECT observation_key, title FROM discovery_observation WHERE source_key='active' AND residence='active' ORDER BY observation_key");
 assert.deepEqual(stored.map(r=>[r.observation_key,r.title]),NEW.map(i=>[i.key,i.title]));
 assert.equal(count(file,"residence='archive'"),20,'the 20 previous observations that did not come back are archived');
 assert.equal(Number(sql(file,"SELECT COUNT(*) AS n FROM discovery_observation_show WHERE source_key='active'")[0].n),2*NEW.length);
}

// 2. A document that changed under the job is refused, not read.
{
 const file=migrate();await committedOld(file);
 const bkt=bucket();
 const job=await stageDocument(bkt,NEW,'run-new');
 const run={runId:'run-new',stage:'seal',seal:{jobId:'job-1',phase:'ledger',sourceKey:job.key,etag:'not-the-etag',itemTotal:job.itemTotal,prefixBytes:job.prefixBytes}};
 const env=stepEnv(file,bkt);const lease=await takeLease(env,file);
 await assert.rejects(()=>call('sealLedgerStep')(env,run,lease,Date.now()+60000),/changed during the seal/);
 assert.equal(count(file,"source_key='active' AND residence='active' AND programme_run_id='run-new'"),0);
}

// 3. The catalog is brought up to date by its difference, in bounded steps; films that left are superseded.
{
 const file=migrate();await committedOld(file);
 const bkt=bucket();
 const film=(id,title)=>({id:'tmdb_'+id,tmdbId:String(id),canonicalIdentity:'tmdb:'+id,title});
 const seed=stepEnv(file,bkt);const l0=await takeLease(seed,file);
 const before={};for(let id=1;id<=60;id++)before['tmdb_'+id]=film(id,'Было '+id);
 await Authority.upsertAdmissions(seed,before,{lease:l0});await Authority.releaseLease(seed,l0);
 // The new catalog: films 1..60 retitled (all differ), 61..80 added, none removed except 1..5.
 const next={};for(let id=6;id<=80;id++)next['tmdb_'+id]=film(id,'Стало '+id);
 await bkt.put('epg/seal/run-new/payload.json',JSON.stringify({runId:'run-new',catalog:next,expectedProgrammeRunId:null}));
 const run={runId:'run-new',stage:'seal',seal:{jobId:'job-1',phase:'catalog'}};
 let rounds=0,result;
 do{
  const env=stepEnv(file,bkt);const lease=await takeLease(env,file);
  result=await call('sealCatalogStep')(env,run,lease,Date.now()-1);rounds++;
 }while(!result.done&&rounds<30);
 if(process.env.DEBUG_SEAL)console.log(JSON.stringify(result),rounds,JSON.stringify(sql(file,"SELECT state, COUNT(*) n FROM discovery_admission GROUP BY state")));
 assert.ok(result.done);
 assert.ok(rounds>=3,'bounded steps: '+rounds);
 // The merge keeps films the catalog already knew, so 1..5 stay as they were and 6..80 are the new ones.
 const rows=sql(file,"SELECT film_id, state, payload_json FROM discovery_admission ORDER BY film_id");
 assert.equal(rows.filter(r=>r.state==='current').length,80);
 for(const r of rows){const id=Number(r.film_id.slice(5));assert.equal(JSON.parse(r.payload_json).title,(id<=5?'Было ':'Стало ')+id);}
 // Nothing left to do on a repeat.
 const env=stepEnv(file,bkt);const lease=await takeLease(env,file);
 const again=await call('sealCatalogStep')(env,run,lease,Date.now()+60000);
 if(process.env.DEBUG_SEAL){const probe=stepEnv(file,bkt);const pay=JSON.parse(await (await bkt.get('epg/seal/run-new/payload.json')).text());const nx=call('mergeCatalogIdentity')(pay.catalog,await call('loadJSON')(probe,'epg/discovered-films.json'),'run-new');const cur=await call('loadJSON')(probe,'epg/discovered-films.json');for(const id of Object.keys(nx))if(JSON.stringify(nx[id])!==JSON.stringify(cur[id]))console.log('DIFF',id,JSON.stringify(nx[id]),JSON.stringify(cur[id]));}
 assert.equal(again.written,0);assert.ok(again.done);
 // A film that does leave is superseded, not deleted.
 const gone=stepEnv(file,bkt);const lg=await takeLease(gone,file);
 await Authority.supersedeAdmissions(gone,['tmdb_1','tmdb_2'],{lease:lg});
 assert.deepEqual(sql(file,"SELECT film_id FROM discovery_admission WHERE state='superseded' ORDER BY film_id").map(r=>r.film_id),['tmdb_1','tmdb_2']);
}

// 4. The whole staged publication: the commit stages and returns at once, and bounded steps seal, update the catalog and
// publish, in that order. The published pointer moves only after the ledger is committed and the catalog is up to date.
for(const mode of ['document','emit']){
 const file=migrate();await committedOld(file);
 const bkt=bucket(11);
 const events=[];
 context.PublishedEpg={
  async readAuthority(){return {cutover:'open',mode:'d1'};},
  async currentGeneration(){return {programmeRunId:'run-old',phase:'published',fence:'g1'};},
  async publishGeneration(env,input){events.push(['publish',sql(file,'SELECT state FROM discovery_transfer')[0].state,sql(file,"SELECT phase FROM discovery_seal")[0].phase]);return {ok:true,programmeRunId:input.programmeRunId};},
  async writeMirrors(){return true;},
 };
 context.ratingsGate=async()=>({active:true,migration:'complete'});
 context.flushRemovalHandover=async()=>false;
 context.persistWatchlist=async()=>{events.push(['persist',run.stage]);};
 context.persistScan=async()=>{};
 context.persistEvents=async()=>{};
 context.refreshPredictionQueue=async()=>{events.push(['refresh',run.stage]);if(mode==='emit')throw new Error('queue refresh failed with a long secret message '+'x'.repeat(300));};
 context.queueCommittedDiscovery=async()=>{events.push(['queue']);};
 context.copyEpgGeneration=async()=>{events.push(['copy']);};
 context.planDiscoveryLedger=async()=>{
  const encoder=new TextEncoder();
  if(mode==='document')return {items:NEW,ledger:{ledgerMode:'bounded'},holder:null};
  const encoded=NEW.map(i=>encoder.encode(JSON.stringify(i)));
  return {emit:()=>(async function*(){for(const bytes of encoded)yield bytes;})(),itemBytes:encoded.reduce((a,b)=>a+b.byteLength,0),itemCount:encoded.length,ledger:{ledgerMode:'bounded'},holder:{discovery:[]}};
 };
 const run={runId:'run-new',stage:'epg',startedAt:'2026-11-05T10:00:00.000Z',watchlist:[],events:[{type:'watchlist'}]};
 const holder={discovery:[]};
 const catalog={};for(let id=1;id<=45;id++)catalog['tmdb_'+id]={id:'tmdb_'+id,tmdbId:String(id),canonicalIdentity:'tmdb:'+id,title:'Фильм '+id};
 const staged=await context.stageSealedGeneration({DB:d1Standin(file),BUCKET:bkt,discoveryLease:null},run,{holder,meta:{programmeRunId:'run-new'},pending:{'programme.json':{runId:'run-new',updatedAt:'2026-11-05T10:00:00.000Z'},'discovered-films.json':catalog},nextWatchlist:{updatedAt:'x',films:[]},uncertain:[],publication:{programmeRunId:'run-old',phase:'published',fence:'g1'}});
 assert.equal(staged.stage,'seal');assert.equal(staged.discovery.nextAction,'continue');assert.equal(staged.discovery.reason,'ledger_seal');
 assert.equal(run.stage,'seal');assert.equal(run.seal.phase,'ledger');assert.equal(run.seal.itemTotal,NEW.length);
 // The commit wrote nothing to the D1 ledger: the previous ledger is as it was, the transfer is not loading.
 assert.equal(sql(file,'SELECT state FROM discovery_transfer')[0].state,'committed');
 assert.equal(count(file,"residence='active' AND programme_run_id='run-old'"),120);
 assert.equal(events.length,0,'nothing is published by the commit');
 assert.ok(await bkt.head('epg/seal/run-new/payload.json'));
 // Bounded steps, the same step handler a client calls, until the run is complete.
 // The first call goes through the step handler a client reaches (`epg_sync_step`), with the run read from storage.
 {
  const env={DB:d1Standin(file),BUCKET:bkt,discoveryLease:null};
  sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
  const response=await context.syncStep(env,'/api/sync/epg',{runId:'run-new'},{});
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.stage,'seal');assert.equal(body.discovery.nextAction,'continue');
  Object.assign(run,JSON.parse(await (await bkt.get('sync.json')).text()));
  const mismatch=await context.syncStep(env,'/api/sync/epg',{runId:'other-run'},{});
  assert.equal(mismatch.status,409);
 }
 let steps=0,result;const phases=[];
 do{
  steps++;phases.push(run.seal?.phase);
  const env={DB:d1Standin(file),BUCKET:bkt,discoveryLease:null};
  sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
  result=await context.sealStep(env,run);
  if(result.stage!=='complete'){assert.equal(result.discovery.nextAction,'continue');assert.equal(result.stage,'seal');}
 }while(result.stage!=='complete'&&steps<40);
 assert.equal(result.stage,'complete');
 assert.ok(steps>=3&&steps<40,'steps: '+steps);
 // AIR-353: the publication is three separate steps after the catalog, each answering `continue` until the last.
 assert.deepEqual(phases.slice(-3),['publish','finalize','queue'],'phases: '+phases.join(','));
 assert.equal(phases.filter(phase=>phase==='publish').length,1);
 const order=events.map(e=>e[0]);
 assert.ok(order.indexOf('publish')<order.indexOf('queue')&&order.indexOf('queue')<order.indexOf('persist')&&order.indexOf('persist')<order.indexOf('refresh'),'event order: '+order.join(','));
 assert.equal(events.find(e=>e[0]==='persist')[1],'seal','the commit tail persists while the run is still sealing');
 assert.equal(events.find(e=>e[0]==='refresh')[1],'seal','the queue refresh runs before the run is complete');
 if(mode==='emit'){assert.ok(run.enrichmentQueueError&&run.enrichmentQueueError.length<=160,'a failed refresh is recorded, bounded, and does not hold the run');}
 assert.equal(result.ratingsPipeline,'separate');
 const published=events.filter(e=>e[0]==='publish');
 assert.equal(published.length,1);
 assert.equal(published[0][1],'committed','the pointer moves after the ledger transfer is committed');
 assert.equal(published[0][2],'done');
 assert.ok(events.findIndex(e=>e[0]==='publish')<events.findIndex(e=>e[0]==='queue'));
 assert.equal(run.stage,'complete');assert.equal(run.seal,undefined);
 assert.equal(count(file,"source_key='active' AND residence='active' AND programme_run_id='run-new'"),NEW.length);
 assert.equal(Object.keys((await Authority.routeRead({DB:d1Standin(file),BUCKET:bkt,discoveryLease:null},'epg/discovered-films.json')).value).length,45);
 assert.equal(await bkt.head('epg/seal/run-new/payload.json'),null,'the staging payload is removed');
}

// AIR-353: each publication step after the pointer is idempotent and a failing step leaves the phase where it was, so
// the next call repeats it. The blocked ratings pipeline is carried to the final answer.
{
 const bkt=bucket(11);
 const report={runId:'run-x',updatedAt:'2026-11-06T10:00:00.000Z',watchlistCount:0,films:[],stats:{a:1}};
 await bkt.put('epg/seal/run-x/payload.json',JSON.stringify({report,watchlist:{films:[]},uncertain:[],fence:'g'}));
 const env={BUCKET:bkt};
 const calls=[];let failPersist=true;
 context.ratingsGate=async()=>({active:false,migration:'none'});
 context.persistWatchlist=async()=>{calls.push('persist');if(failPersist){failPersist=false;throw new Error('persist failed');}};
 context.persistScan=async()=>{};
 context.persistEvents=async()=>{};
 context.refreshPredictionQueue=async()=>{calls.push('refresh');};
 const run={runId:'run-x',stage:'seal',seal:{jobId:'j',phase:'finalize'},events:[],watchlist:[{id:1}],pending:{}};
 await assert.rejects(()=>context.sealFinalizeStep(env,run),/persist failed/);
 assert.equal(run.seal.phase,'finalize','a failing step leaves its phase');
 const second=await context.sealFinalizeStep(env,run);
 assert.equal(second.stage,'seal');assert.equal(run.seal.phase,'queue');assert.equal(run.ratingsPipeline,'blocked');assert.equal(run.ratingsMigration,'none');
 assert.deepEqual(calls,['persist','persist']);
 const done=await context.sealQueueStep(env,run);
 assert.equal(done.stage,'complete');assert.equal(done.ratingsPipeline,'blocked');assert.equal(done.ratingsMigration,'none');
 assert.equal(run.seal,undefined);assert.equal(run.watchlist,undefined);assert.equal(run.stage,'complete');
 assert.equal(await bkt.head('epg/seal/run-x/payload.json'),null);
 // A repeated queue step after a lost answer still completes the run and leaves nothing behind.
 const again={runId:'run-x',stage:'seal',seal:{jobId:'j',phase:'queue'},ratingsPipeline:'separate'};
 await bkt.put('epg/seal/run-x/payload.json',JSON.stringify({report,watchlist:{films:[]},uncertain:[],fence:'g'}));
 const repeated=await context.sealQueueStep(env,again);
 assert.equal(repeated.stage,'complete');assert.equal(repeated.ratingsPipeline,'separate');assert.equal(repeated.ratingsMigration,undefined);
}

// AIR-353: the `publish` step is four units around one atomic pointer. A cancellation before the pointer changes nothing; a
// cancellation after it leaves the generation published exactly once and the repeat finishes the rest without a second
// pointer; a deadline between units stops the step with a checkpoint and the next calls resume where it stopped.
{
 const bkt=bucket(11);
 const report={runId:'run-p',updatedAt:'2026-11-06T10:00:00.000Z',films:[],watchlistCount:0,stats:{}};
 const payload=JSON.stringify({report,watchlist:{films:[]},uncertain:[],fence:'f0',expectedProgrammeRunId:'run-old'});
 await bkt.put('epg/seal/run-p/payload.json',payload);
 let ev=[],published=false,failPointer=0,failIntent=0,otherFence=false;
 context.PublishedEpg={
  async currentGeneration(){return published?{programmeRunId:'run-p',phase:'published',fence:'f1'}:{programmeRunId:'run-old',phase:'published',fence:otherFence?'f9':'f0'};},
  async publishGeneration(){if(failPointer-->0)throw new Error('cancelled before the pointer');published=true;ev.push('pointer');return {ok:true};},
  async writeMirrors(){ev.push('mirrors');return true;},
 };
 context.copyEpgGeneration=async()=>{ev.push('copy');};
 context.queueCommittedDiscovery=async()=>{if(failIntent-->0)throw new Error('cancelled after the pointer');ev.push('intent');};
 const env={BUCKET:bkt};
 const fresh=()=>({runId:'run-p',stage:'seal',seal:{jobId:'j',phase:'publish'},watchlist:[]});
 const count=name=>ev.filter(item=>item===name).length;
 // Another generation published since the staging: the fence refuses, nothing moves.
 otherFence=true;let run=fresh();
 await assert.rejects(()=>context.sealPublishStep(env,run,null),/generation changed/);
 assert.equal(published,false);assert.equal(ev.length,0);otherFence=false;
 // Cancelled before the pointer: the previous generation is untouched and the repeat publishes once.
 failPointer=1;run=fresh();
 await assert.rejects(()=>context.sealPublishStep(env,run,null),/before the pointer/);
 assert.equal(published,false);assert.equal(ev.length,0);assert.equal(run.seal.phase,'publish');
 const done=await context.sealPublishStep(env,run,null);
 assert.equal(run.seal.phase,'finalize');assert.equal(done.stage,'seal');assert.equal(run.seal.units,undefined);
 assert.deepEqual(ev,['pointer','mirrors','copy','intent']);
 // Cancelled after the pointer, before the discovery intent: the repeat does not publish again and queues the intent once.
 ev=[];published=false;failIntent=1;run=fresh();
 await assert.rejects(()=>context.sealPublishStep(env,run,null),/after the pointer/);
 assert.equal(count('pointer'),1);assert.equal(count('intent'),0);assert.equal(run.seal.phase,'publish');
 await context.sealPublishStep(env,run,null);
 assert.equal(count('pointer'),1,'the pointer moved exactly once');assert.equal(count('intent'),1);assert.equal(run.seal.phase,'finalize');
 // A deadline that has passed stops the step after the pointer and after each unit, with a checkpoint.
 ev=[];published=false;run=fresh();let calls=0;const stored=[];
 do{calls++;const out=await context.sealPublishStep(env,run,null,0);stored.push(JSON.stringify(out.seal));}while(run.seal.phase==='publish'&&calls<8);
 assert.equal(calls,4,'pointer, mirrors, copy, then the intent: '+stored.join(' '));
 assert.deepEqual(ev,['pointer','mirrors','copy','intent']);assert.equal(run.seal.phase,'finalize');
 assert.ok(JSON.parse(await (await bkt.get('sync.json')).text()).seal.phase==='finalize','the checkpoint is saved');
}

// AIR-353 review: a failed mirror write or copy is never recorded as done. It is retried, bounded, then reported as
// degraded; a deadline stops every phase between units, and the saved checkpoint survives a lost answer and a restart.
{
 const same=(actual,expected)=>assert.equal(JSON.stringify(actual),JSON.stringify(expected));
 const bkt=bucket(11);
 const report={runId:'run-q',updatedAt:'2026-11-06T10:00:00.000Z',films:[],watchlistCount:0,stats:{}};
 const writePayload=()=>bkt.put('epg/seal/run-q/payload.json',JSON.stringify({report,watchlist:{films:[{id:'w1'}]},uncertain:[],fence:'f0',expectedProgrammeRunId:'run-old'}));
 await writePayload();
 let ev=[],published=false,mirrorsOk=0,copyFails=0,slowMs=0;
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 context.PublishedEpg={
  async currentGeneration(){return published?{programmeRunId:'run-q',phase:'published',fence:'f1'}:{programmeRunId:'run-old',phase:'published',fence:'f0'};},
  async publishGeneration(){if(slowMs)await sleep(slowMs);published=true;ev.push('pointer');return {ok:true};},
  async writeMirrors(){ev.push('mirrors');return mirrorsOk-->0?true:false;},
 };
 context.copyEpgGeneration=async()=>{ev.push('copy');if(copyFails-->0)throw new Error('copy failed');};
 context.queueCommittedDiscovery=async()=>{ev.push('intent');};
 const env={BUCKET:bkt};
 const fresh=()=>({runId:'run-q',stage:'seal',seal:{jobId:'j',phase:'publish'},watchlist:[]});
 const count=name=>ev.filter(item=>item===name).length;
 const readRun=async()=>JSON.parse(await (await bkt.get('sync.json')).text());
 // A mirror write that fails twice is retried on the next calls and is not marked done; the third try succeeds.
 mirrorsOk=0;let run=fresh();let calls=0;const mirrorState=[];
 // Fails on the first two tries, succeeds on the third.
 let tries=0;context.PublishedEpg.writeMirrors=async()=>{ev.push('mirrors');return ++tries>=3;};
 let answer=await context.sealPublishStep(env,run,null);
 assert.equal(run.seal.phase,'publish');assert.equal(answer.seal.retry,'mirrors');assert.equal(answer.seal.attempts,1);assert.equal(run.seal.units.mirrors,undefined,'a failed unit is not recorded as done');
 answer=await context.sealPublishStep(env,run,null);
 assert.equal(answer.seal.retry,'mirrors');assert.equal(answer.seal.attempts,2);assert.equal(run.seal.phase,'publish');
 answer=await context.sealPublishStep(env,run,null);
 assert.equal(run.seal.phase,'finalize');assert.equal(count('pointer'),1,'the pointer moved once through the retries');assert.equal(count('mirrors'),3);assert.equal(run.sealDegraded,undefined);
 // Mirrors that never succeed: three tries, then recorded as gave_up and degraded, with the watchlist fallback written.
 ev=[];published=false;tries=-100;run=fresh();
 for(let i=0;i<3;i++)answer=await context.sealPublishStep(env,run,null);
 assert.equal(run.seal.phase,'finalize');same(run.sealDegraded,['mirrors']);assert.equal(answer.seal.degraded[0],'mirrors');
 assert.equal(count('mirrors'),3);assert.equal(count('pointer'),1);assert.equal(count('intent'),1);
 assert.ok(await bkt.head('watchlist.json'),'the watchlist fallback is written when the mirrors failed');
 // A copy that fails is retried the same way and reported as degraded after three tries.
 ev=[];published=false;copyFails=100;tries=100;run=fresh();
 for(let i=0;i<3;i++)answer=await context.sealPublishStep(env,run,null);
 assert.equal(run.seal.phase,'finalize');same(run.sealDegraded,['copy']);assert.equal(count('copy'),3);assert.equal(count('pointer'),1);
 copyFails=0;
 // The degraded names reach the final answer.
 context.ratingsGate=async()=>({active:true,migration:'complete'});context.flushRemovalHandover=async()=>false;
 context.persistWatchlist=async()=>{};context.persistScan=async()=>{};context.persistEvents=async()=>{};context.refreshPredictionQueue=async()=>{};
 await context.sealFinalizeStep(env,run);await writePayload();
 const finished=await context.sealQueueStep(env,run);
 assert.equal(finished.stage,'complete');same(finished.degraded,['copy']);
 // A slow pointer passes the deadline: the first unit still ran, nothing else started, and the checkpoint is durable.
 ev=[];published=false;tries=100;slowMs=40;run=fresh();await writePayload();
 const slow=await context.sealPublishStep(env,run,null,Date.now()+10);
 assert.deepEqual(ev,['pointer'],'no unit starts after the deadline');assert.equal(run.seal.phase,'publish');same(slow.seal.units,['pointer']);
 // The answer is lost; the process restarts and reads the run back from storage: the saved units hold.
 const restarted=await readRun();
 assert.equal(restarted.seal.units.pointer,'ok');
 slowMs=0;
 await context.sealPublishStep(env,restarted,null);
 assert.equal(restarted.seal.phase,'finalize');assert.equal(count('pointer'),1,'the repeat after the lost answer does not publish again');assert.equal(count('intent'),1);
 // The deadline bounds the finalize and queue phases between their units as well.
 ev=[];const evs=[];
 context.ratingsGate=async()=>{evs.push('handover');return {active:true,migration:'complete'};};
 context.persistWatchlist=async()=>{evs.push('watchlist');};context.persistScan=async()=>{evs.push('scan');};context.persistEvents=async()=>{evs.push('events');};
 const fin=fresh();fin.seal.phase='finalize';await writePayload();
 let finCalls=0;do{finCalls++;await context.sealFinalizeStep(env,fin,0);}while(fin.seal.phase==='finalize'&&finCalls<8);
 assert.equal(finCalls,4,'one unit per call once the deadline has passed');assert.deepEqual(evs,['handover','watchlist','scan','events']);assert.equal(fin.seal.phase,'queue');
 // A failing unit keeps the units that finished: the next call resumes after them.
 evs.length=0;let failScan=true;context.persistScan=async()=>{evs.push('scan');if(failScan){failScan=false;throw new Error('scan failed');}};
 const resume=fresh();resume.seal.phase='finalize';
 await assert.rejects(()=>context.sealFinalizeStep(env,resume),/scan failed/);
 assert.equal(resume.seal.phase,'finalize');
 await context.sealFinalizeStep(env,resume);
 assert.equal(resume.seal.phase,'queue');same(evs,['handover','watchlist','scan','scan','events']);
}
console.log('discovery seal publish ok');
