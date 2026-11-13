// AIR-462: the correlation of an executor action and the bounded `epg_memory_boundary` markers of the staged publication. Markers carry only
// a closed set of names and non-negative integer counters, the correlation is bound per run for the step only, a logging failure changes
// nothing, and a step killed inside a boundary leaves its enter line without an exit. No network, no R2, no D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {loadWorker} from '../scripts/discovery-ledger-offline.mjs';

const context=loadWorker();
const call=code=>vm.runInContext(code,context);
const lines=[];
context.console.log=line=>lines.push(String(line));
const events=kind=>lines.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(e=>e?.event===kind);
const boundaries=()=>events('epg_memory_boundary');

// 1. Closed names and fields: an unknown boundary, a free-text or negative or fractional counter and an unknown field are dropped.
{
 lines.length=0;
 call('epgBoundary')('run-a','seal_payload_parse','enter',{bytes:1234,title:'Secret Film',items:-1,cursor:1.5,elapsedMs:7,sql:'SELECT 1'});
 call('epgBoundary')('run-a','not_a_boundary','enter',{bytes:1});
 call('epgBoundary')('run-a','seal_payload_parse','sideways',{bytes:1});
 const [event,...rest]=boundaries();
 assert.equal(rest.length,0);
 assert.deepEqual(Object.keys(event).sort(),['at','boundary','bytes','edge','elapsedMs','event','runId']);
 assert.equal(event.bytes,1234);assert.equal(event.elapsedMs,7);
 assert.doesNotMatch(JSON.stringify(event),/Secret|SELECT/);
}

// 2. The correlation is bound to the run while its step runs and is gone afterwards; two runs never see each other's trace.
{
 lines.length=0;
 const traceA={instanceId:'epg_a',actStep:'act-3',attemptTraceId:'t-a'},traceB={instanceId:'epg_b',actStep:'act-9',attemptTraceId:'t-b'};
 const withTrace=call('withEpgTrace');
 await Promise.all([
  withTrace({epgTrace:traceA},{runId:'run-a'},async()=>{await Promise.resolve();call('epgPhase')('run-a','seal_ledger','enter');call('epgBoundary')('run-a','seal_ledger_begin','exit',{cursor:3});}),
  withTrace({epgTrace:traceB},{runId:'run-b'},async()=>{call('epgPhase')('run-b','seal_publish','enter');await Promise.resolve();call('epgBoundary')('run-b','seal_payload_get','enter');}),
 ]);
 call('epgPhase')('run-a','seal_ledger','exit');
 const all=lines.map(l=>JSON.parse(l));
 const pick=(runId,name)=>all.find(e=>e.runId===runId&&(e.phase===name||e.boundary===name));
 assert.equal(pick('run-a','seal_ledger').attemptTraceId,'t-a');assert.equal(pick('run-a','seal_ledger_begin').actStep,'act-3');
 assert.equal(pick('run-b','seal_publish').attemptTraceId,'t-b');assert.equal(pick('run-b','seal_payload_get').instanceId,'epg_b');
 const after=all.filter(e=>e.phase==='seal_ledger'&&e.edge==='exit')[0];
 assert.equal(after.attemptTraceId,undefined,'no trace is left on the run once the step ended');
 // A step without a trace (an external caller, or the start request) logs the markers as before.
 lines.length=0;await withTrace({}, {runId:'run-c'},async()=>call('epgPhase')('run-c','epg_input_scan','enter'));
 assert.equal(JSON.parse(lines[0]).attemptTraceId,undefined);
 // The trace is released when the step throws.
 await assert.rejects(()=>withTrace({epgTrace:traceA},{runId:'run-d'},async()=>{throw new Error('step failed');}));
 lines.length=0;call('epgPhase')('run-d','seal_stage','enter');assert.equal(JSON.parse(lines[0]).attemptTraceId,undefined);
}

// 3. A logging failure changes nothing: the work, its result and its error are the same with a console that throws.
{
 const real=context.console.log;
 context.console.log=()=>{throw new Error('console is down');};
 try{
  assert.equal(await call('tracedPhase')('run-e','seal_publish',async()=>'published'),'published');
  await assert.rejects(()=>call('tracedPhase')('run-e','seal_publish',async()=>{throw new Error('real failure');}),/real failure/);
  call('epgBoundary')('run-e','seal_payload_get','enter',{bytes:1});
 }finally{context.console.log=real;}
}

// 4. The payload read logs its boundaries in order with the sizes the code already knows, and a kill inside the decode leaves the enter alone.
{
 const text=JSON.stringify({runId:'run-p',report:{films:[]},watchlist:{films:[]},uncertain:[],fence:'f'});
 const bucket=(failText=false)=>({async get(){return {size:Buffer.byteLength(text),async text(){if(failText)throw new Error('killed');return text;}};}});
 lines.length=0;
 const payload=await call('sealPayload')({BUCKET:bucket()},{runId:'run-p'});
 assert.equal(payload.fence,'f');
 assert.deepEqual(boundaries().map(e=>e.boundary+':'+e.edge),['seal_payload_get:enter','seal_payload_get:exit','seal_payload_text:enter','seal_payload_text:exit','seal_payload_parse:enter','seal_payload_parse:exit']);
 assert.equal(boundaries()[1].bytes,Buffer.byteLength(text));assert.equal(boundaries()[3].bytes,text.length);
 lines.length=0;
 await assert.rejects(()=>call('sealPayload')({BUCKET:bucket(true)},{runId:'run-p'}),/killed/);
 assert.deepEqual(boundaries().map(e=>e.boundary+':'+e.edge),['seal_payload_get:enter','seal_payload_get:exit','seal_payload_text:enter'],'the last line is the enter of the decode, with no false exit');
}

// 5. The code adds a bounded number of lines per action and no network, R2 or D1 call of its own.
{
 const worker=fs.readFileSync('src/worker.js','utf8');
 const sites=[...worker.matchAll(/epgBoundary\(([^,]+),'([a-z_]+)'/g)].filter(m=>m[1]!=='runId'||true).map(m=>m[2]);
 const names=call('[...EPG_BOUNDARIES]');
 for(const name of new Set(sites))assert.ok(names.includes(name),name+' is in the whitelist');
 for(const name of names)assert.ok(sites.includes(name),name+' is used');
 const helpers=worker.slice(worker.indexOf('const EPG_TRACE=new Map()'),worker.indexOf('async function tracedPhase('));
 assert.doesNotMatch(helpers,/BUCKET|\.put\(|fetch\(|DB\b|memoryUsage|\bgc\(|performance\.memory/);
 // Batch milestones are every 25th batch and archive milestones every 16th segment: a few dozen lines a run, none per observation or film.
 assert.match(worker,/stats\.batches%25===0/);assert.match(worker,/tally\.segments%16===0/);
}

const trail=()=>lines.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(e=>e&&(e.event==='epg_memory_boundary'||e.event==='epg_phase')).map(e=>(e.boundary||e.phase)+':'+e.edge);

// 6. A payload that does not parse: the decode finished, the parse entered and never exited, and the underlying error is the one thrown.
{
 const bucket={async get(){return {size:4,async text(){return '{bad';}};}};
 lines.length=0;
 await assert.rejects(()=>call('sealPayload')({BUCKET:bucket},{runId:'run-p'}),SyntaxError);
 assert.deepEqual(trail().slice(-2),['seal_payload_text:exit','seal_payload_parse:enter']);
 assert.ok(!trail().includes('seal_payload_parse:exit'));
}

// 7. The ledger step: a completed read is a matching pair, the milestones are bounded, and a failure in the stream or in a D1 write leaves the read's enter alone.
{
 const real={readSealedItems:context.readSealedItems,DiscoveryAuthority:context.DiscoveryAuthority};
 const run={runId:'run-l',seal:{jobId:'j',sourceKey:'k',etag:'e',itemTotal:24000,prefixBytes:1}};
 const state=(cursorItems=0)=>({phase:'items',cursorItems,cursorBytes:0,itemTotal:24000});
 let writes=0,failWrite=false,failStream=false,total=24000;
 context.DiscoveryAuthority={
  async sealBegin(){},async sealState(){return state(writes>=1&&!failWrite&&!failStream?total:0);},
  async sealWrite(env,{items,expectedCursor}){if(failWrite)throw new Error('d1 write failed');writes++;return {written:items.length,cursorItems:expectedCursor+items.length,carried:null};},
  async sealArchive(){return {committed:true};},
 };
 context.readSealedItems=async(env,job,offset,visit)=>{if(failStream)throw new Error('stream failed');for(let i=0;i<total;i++)if(await visit({key:'k'+i},10)===false)return;};
 try{
  lines.length=0;
  const out=await call('sealLedgerStep')({},run,{},Date.now()+1e9);
  assert.equal(out.done,true);
  const t=trail();
  assert.deepEqual(t.filter(x=>x.startsWith('seal_ledger_read')),['seal_ledger_read:enter','seal_ledger_read:exit'],'a completed read is a pair');
  assert.deepEqual(t.filter(x=>x.startsWith('seal_ledger_archive')),['seal_ledger_archive:enter','seal_ledger_archive:exit']);
  const milestones=boundaries().filter(e=>e.boundary==='seal_ledger_batches');
  assert.equal(milestones.length,Math.floor(writes/25),'one milestone line per 25 batches ('+writes+' batches)');
  assert.ok(writes>=50&&lines.length<20,'sixty batches log '+lines.length+' lines');
  // The stream fails: the read was entered and never exited, the error is the stream's.
  failStream=true;writes=0;lines.length=0;
  await assert.rejects(()=>call('sealLedgerStep')({},run,{},Date.now()+1e9),/stream failed/);
  assert.deepEqual(trail().filter(x=>x.startsWith('seal_ledger')),['seal_ledger_begin:exit','seal_ledger_read:enter']);
  // A D1 write fails inside the read: the same last confirmed point, the write error is preserved, no archive was entered.
  failStream=false;failWrite=true;writes=0;lines.length=0;
  await assert.rejects(()=>call('sealLedgerStep')({},run,{},Date.now()+1e9),/d1 write failed/);
  assert.deepEqual(trail().filter(x=>x.startsWith('seal_ledger')),['seal_ledger_begin:exit','seal_ledger_read:enter']);
 }finally{Object.assign(context,real);}
}

// 8. The catalog step: the merge is a pair and the payload exit carries no count (nothing is enumerated for the log).
{
 const real={pinEpg:context.pinEpg,loadJSON:context.loadJSON,DiscoveryAuthority:context.DiscoveryAuthority};
 context.pinEpg=async env=>env;context.loadJSON=async()=>({});
 context.DiscoveryAuthority={ownsKey(){return false;},async upsertAdmissions(env,films){return {written:Object.keys(films),refused:[],batches:1,reads:0,remaining:0};}};
 const catalog={tmdb_1:{id:'tmdb_1',tmdbId:'1',canonicalIdentity:'tmdb:1'},tmdb_2:{id:'tmdb_2',tmdbId:'2',canonicalIdentity:'tmdb:2'}};
 const bucket={async get(key){return {async text(){return JSON.stringify({runId:'run-c',catalog});},async json(){return {};}};}};
 try{
  lines.length=0;
  await call('sealCatalogStep')({BUCKET:bucket},{runId:'run-c'},{},Date.now()+1e9);
  assert.deepEqual(trail(),['seal_catalog_payload:enter','seal_catalog_payload:exit','seal_catalog_merge:enter','seal_catalog_merge:exit']);
  assert.equal(boundaries().find(e=>e.boundary==='seal_catalog_payload'&&e.edge==='exit').count,undefined);
  assert.equal(boundaries().find(e=>e.boundary==='seal_catalog_merge'&&e.edge==='exit').count,2);
  assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/epgBoundary\([^\n]*Object\.(keys|values|entries)\(/,'no marker enumerates an object for its count');
 }finally{Object.assign(context,real);}
}

// 9. The publish pointer: a failing commit leaves the unit's enter without an exit, the error is preserved and nothing after the pointer ran.
{
 const real={PublishedEpg:context.PublishedEpg};
 const events=[];
 context.PublishedEpg={
  async currentGeneration(){return {programmeRunId:'run-old',phase:'published',fence:'f0'};},
  async publishGeneration(){throw new Error('pointer commit failed');},
  async writeMirrors(){events.push('mirrors');return true;},
 };
 const text=JSON.stringify({report:{films:[]},watchlist:{films:[]},uncertain:[],fence:'f0',expectedProgrammeRunId:'run-old'});
 const bucket={async get(){return {size:text.length,async text(){return text;}};},async put(){events.push('put');return {etag:'e'};}};
 try{
  lines.length=0;
  const run={runId:'run-pp',seal:{jobId:'j',phase:'publish'}};
  await assert.rejects(()=>call('sealPublishStep')({BUCKET:bucket},run,{},Infinity),/pointer commit failed/);
  const t=trail();
  assert.equal(t[t.length-1],'seal_publish_pointer:error','the failed unit logs an error edge');
  assert.ok(!t.includes('seal_publish_pointer:exit')&&!t.includes('seal_publish_mirrors:enter'));
  assert.ok(!events.includes('mirrors'),'no later unit ran');
  assert.equal(run.seal.phase,'publish');
 }finally{Object.assign(context,real);}
}
console.log('epg trace boundaries ok');
