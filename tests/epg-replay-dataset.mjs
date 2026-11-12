// AIR-454 / ADR 0121. Immutable, digest-verified replay datasets for the EPG diagnostic canary. Offline only: an in-memory bucket and the real bounded planner on a sqlite D1 stand-in,
// synthetic public fixtures; no Cloudflare, no provider fetch, no production. What is proved:
//   1. The builder reads through a read-only reader and writes nothing (the bucket's writes do not change); the dataset is canonical, sorted, digest-verified and states its fidelity as reduced.
//   2. Two runs on one dataset and seed give the identical plan (departures, segments, digests); another seed gives another plan; the plan is bound to the dataset digest.
//   3. Parity with the real planner: the replay scan, committed through the real `stageSealedGeneration`, archives exactly the planned departures into exactly the planned segments, and returned keys re-enter.
//   4. Invalid or mismatched generation, a missing or tampered segment, a tampered dataset, an incomplete baseline, an oversize dataset and an excessive N are refused, with no side effect.
//   5. Mutation checks: every guard removed from the module is caught.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {context,call,sql,runId,POINTER,world,bootstrap,commit,r2Union,assertParity,scan,keyOf} from './discovery-bounded-lib.mjs';

const source=fs.readFileSync('src/epg-replay.js','utf8');
const load=text=>new Function('crypto',text+'\nreturn EpgReplay;')(globalThis.crypto);
const Replay=load(source);
const segmentOf=call('ledgerArchiveSegment'),candidateKey=call('discoveryCandidateKey');
const plain=value=>JSON.parse(JSON.stringify(value));
const BUILT='2026-11-12T12:00:00.000Z';
const codeOf=async run=>{try{await run();return null;}catch(error){return error.reason||error.code||String(error.message);}};

// A reader over a bucket, optionally with overrides and removed keys; it exposes `get` only (the builder never needs more).
const readerOver=(bucket,{override={},missing=[]}={})=>({async get(key){if(missing.includes(key))return null;if(key in override)return {text:async()=>override[key]};return bucket.get(key);}});

// ---- the real world: a bounded ledger with an archive, built by the Worker's own planner from the public synthetic scans of the bounded-ledger tests ----
const state=world();
await bootstrap(state,0);
for(const day of [1,2,3,4,5,6])await commit(state,day,'bounded');
assertParity(state,'before the replay');
const id=state.published.programmeRunId;
const before={puts:state.bkt.puts.length,keys:[...state.bkt.objects.keys()].sort().join('|')};

// 1. The builder is read-only and the dataset is verified and honest about its fidelity.
const dataset=await Replay.buildDataset(readerOver(state.bkt),{programmeRunId:id,builtAt:BUILT});
assert.equal(state.bkt.puts.length,before.puts,'building wrote nothing');assert.equal([...state.bkt.objects.keys()].sort().join('|'),before.keys);
assert.equal(dataset.kind,'epg-replay-dataset');assert.equal(dataset.schemaVersion,1);assert.equal(dataset.source.programmeRunId,id);
assert.equal(dataset.fidelity.level,'reduced');assert.ok(dataset.fidelity.reasons.includes('scan_is_canonical_ledger_not_raw_feed'),'the merged-result limit is stated: '+dataset.fidelity.reasons);
assert.ok(dataset.counts.items>0&&dataset.counts.archivedItems>0&&dataset.counts.segments>0,JSON.stringify(dataset.counts));
assert.deepEqual(dataset.baseline.items.map(item=>item.key),dataset.baseline.items.map(item=>item.key).sort(),'items sorted by key');
assert.match(dataset.digest,/^[0-9a-f]{64}$/);
assert.deepEqual(await Replay.verifyDataset(dataset,{expectedProgrammeRunId:id,expectedDigest:dataset.digest}),{ok:true,problems:[]});
// The stored segment digests are the Worker's: a dataset built from the real archive verifies against `textSha256`.
const again=await Replay.buildDataset(readerOver(state.bkt),{programmeRunId:id,builtAt:BUILT});
assert.equal(again.digest,dataset.digest,'the same stored state and time give the same dataset digest');
assert.equal(await Replay.digestOf(plain(dataset)),dataset.digest,'a round trip through JSON keeps the digest');
const reader=readerOver(state.bkt);assert.deepEqual(Object.keys(reader),['get'],'the reader is read-only');

// 2. Determinism of the plan.
const N=30;
const planA=await Replay.planMutation(dataset,{seed:'canary-1',departures:N,returns:2},{segmentOf});
const planB=await Replay.planMutation(plain(dataset),{seed:'canary-1',departures:N,returns:2},{segmentOf});
assert.equal(JSON.stringify(planA),JSON.stringify(planB),'two runs, one plan, digest included');
const planC=await Replay.planMutation(dataset,{seed:'canary-2',departures:N,returns:2},{segmentOf});
assert.notEqual(planC.digest,planA.digest);assert.notDeepEqual(planC.departures,planA.departures,'another seed, another plan');
assert.equal(planA.departureCount,N);assert.equal(planA.returnCount,2);assert.equal(planA.datasetDigest,dataset.digest);
assert.deepEqual(planA.departures,[...planA.departures].sort());assert.equal(new Set(planA.departures).size,N);
assert.equal(planA.activeAfter,dataset.counts.items-N+2);
assert.equal(Object.values(planA.archive.departuresBySegment).reduce((a,b)=>a+b,0),N,'every departure lands in one segment');
for(const [segment,count] of Object.entries(planA.archive.departuresBySegment))assert.equal(planA.departures.filter(key=>segmentOf(key,planA.archive.segmentCount)===Number(segment)).length,count);
assert.equal(planA.returns.every(key=>!dataset.baseline.items.some(item=>item.key===key)),true,'a return is a key that only the archive holds');
const zero=await Replay.planMutation(dataset,{seed:'x',departures:0},{segmentOf});assert.equal(zero.departureCount,0);assert.deepEqual(zero.archive.segmentsRewritten,[]);
// The scan: the baseline without the departures plus the returns; its keys are the Worker's own candidate keys.
const scanA=await Replay.replayScan(dataset,planA,{candidateKey});
assert.equal(scanA.length,planA.activeAfter);assert.equal(JSON.stringify(await Replay.replayScan(dataset,planA)),JSON.stringify(scanA),'the scan is deterministic');
await assert.rejects(Replay.replayScan(dataset,{...planA,departures:planA.departures.slice(1)}),error=>error.reason==='plan_digest_mismatch','a plan edited after the fact');
await assert.rejects(Replay.replayScan({...dataset,digest:'0'.repeat(64)},planA),error=>error.reason==='dataset_invalid');
await assert.rejects(Replay.replayScan(dataset,{...planA,datasetDigest:'0'.repeat(64)}),error=>error.reason==='plan_mismatch','a plan of another dataset');

// 3. Parity with the real planner: the replay scan, committed by the Worker's own seal path, archives exactly the planned departures into exactly the planned segments.
{
 const pointerBefore=state.bkt.json(POINTER).manifestId,manifestBefore=state.bkt.json('epg/discovery-archive/v1/manifests/'+pointerBefore+'.json');
 const activeBefore=r2Union(state).doc.items.map(item=>item.key);assert.equal(activeBefore.length,dataset.counts.items);
 await commit(state,7,'bounded',{latest:scanA});
 const pointerAfter=state.bkt.json(POINTER).manifestId;assert.notEqual(pointerAfter,pointerBefore,'the archive moved');
 const manifest=state.bkt.json('epg/discovery-archive/v1/manifests/'+pointerAfter+'.json');
 assert.deepEqual(manifest.upsertedKeys,planA.departures,'the real planner archived exactly the planned departures');
 const rewritten=manifest.segments.map((entry,index)=>entry.object!==(manifestBefore.segments[index]?.object||null)?index:-1).filter(index=>index>=0);
 assert.deepEqual(rewritten,planA.archive.segmentsRewritten,'into exactly the planned segments');
 const union=r2Union(state);
 assert.equal(union.doc.items.length,planA.activeAfter,'the active ledger is the scan');
 for(const key of planA.returns)assert.ok(union.doc.items.some(item=>item.key===key),'a returned key is active again');
 for(const key of planA.departures)assert.ok(!union.doc.items.some(item=>item.key===key),'a departed key left the active ledger');
 assertParity(state,'after the replay');
}

// 4. Refusals, without side effects. A synthetic reader serves a copy of the stored state with one defect each.
{
 const stored=key=>state.bkt.json(key);
 const doc=state.bkt.json('epg/generations/'+id+'/discovery-latest.json');
 void stored;void doc;
}
const doc=JSON.parse(await (await readerOver(state.bkt).get('epg/generations/'+id+'/discovery-latest.json')).text());
// (the world moved to the replay's day; the day-6 generation is still stored under its own id)
const genKey='epg/generations/'+id+'/discovery-latest.json',manifestKey=Replay.MANIFEST_KEY(doc.archive.manifestId);
const manifest=JSON.parse(await (await state.bkt.get(manifestKey)).text());
const firstSegment=manifest.segments.find(entry=>entry.object);
const segmentText=await (await state.bkt.get(firstSegment.object)).text();
const putsNow=state.bkt.puts.length;
const build=(options={},build={})=>Replay.buildDataset(readerOver(state.bkt,options),{programmeRunId:id,builtAt:BUILT,...build});
assert.equal(await codeOf(()=>Replay.buildDataset(readerOver(state.bkt),{programmeRunId:'../x',builtAt:BUILT})),'invalid_generation');
assert.equal(await codeOf(()=>Replay.buildDataset(readerOver(state.bkt),{programmeRunId:id,builtAt:'yesterday'})),'invalid_built_at');
assert.equal(await codeOf(()=>Replay.buildDataset(readerOver(state.bkt),{programmeRunId:'00000000-0000-4000-8000-0000000000ff',builtAt:BUILT})),'generation_missing');
assert.equal(await codeOf(()=>build({override:{[genKey]:JSON.stringify({...doc,programmeRunId:'11111111-1111-4111-8111-111111111111'})}})),'generation_mismatch','a document of another generation');
assert.equal(await codeOf(()=>build({override:{[genKey]:'{not json'}})),'malformed');
assert.equal(await codeOf(()=>build({override:{[genKey]:JSON.stringify({programmeRunId:id})}})),'generation_incomplete');
assert.equal(await codeOf(()=>build({override:{[genKey]:JSON.stringify({...doc,items:[...doc.items,doc.items[0]]})}})),'duplicate_key');
assert.equal(await codeOf(()=>build({override:{[genKey]:JSON.stringify({...doc,items:[{title:'x'}]})}})),'item_malformed');
assert.equal(await codeOf(()=>build({missing:[firstSegment.object]})),'segment_missing','a segment the manifest names is gone');
assert.equal(await codeOf(()=>build({missing:[manifestKey]})),'manifest_missing');
assert.equal(await codeOf(()=>build({override:{[firstSegment.object]:segmentText.replace(/"title":"/,'"title":"X')}})),'segment_digest_mismatch','a tampered segment');
const tamperedManifest=(patch)=>JSON.stringify({...manifest,...patch});
assert.equal(await codeOf(()=>build({override:{[manifestKey]:tamperedManifest({totals:{...manifest.totals,items:manifest.totals.items+1}})}})),'manifest_totals_mismatch');
assert.equal(await codeOf(()=>build({override:{[manifestKey]:tamperedManifest({segments:manifest.segments.map(entry=>entry===firstSegment||entry.segment===firstSegment.segment?{...entry,items:entry.items+1}:entry)})}})),'segment_count_mismatch');
assert.equal(await codeOf(()=>build({override:{[manifestKey]:tamperedManifest({segments:manifest.segments.map(entry=>entry.object?{...entry,object:'other/place.json'}:entry)})}})),'segment_key_foreign','a segment outside the archive prefix');
assert.equal(await codeOf(()=>build({},{maxBytes:1000})),'size_budget_exceeded');assert.equal(await codeOf(()=>build({},{maxItems:3})),'size_budget_exceeded');
assert.equal(await codeOf(()=>Replay.buildDataset({get:async()=>{throw new Error('R2 unavailable');}},{programmeRunId:id,builtAt:BUILT})),'unreadable');
assert.equal(await codeOf(()=>Replay.buildDataset({get:async()=>({json:async()=>({})})},{programmeRunId:id,builtAt:BUILT})),'reader_unsupported');
assert.equal(state.bkt.puts.length,putsNow,'no refusal wrote anything');
// A fresh dataset of the (replayed) generation for the tamper checks on the dataset itself.
const fresh=await Replay.buildDataset(readerOver(state.bkt),{programmeRunId:state.published.programmeRunId,builtAt:BUILT});
const verify=async value=>(await Replay.verifyDataset(value)).problems;
{
 const t=plain(fresh);t.baseline.items[0].title='tampered';assert.ok((await verify(t)).includes('digest_mismatch'));
 const u=plain(fresh);u.baseline.items.reverse();assert.ok((await verify(u)).includes('items_unsorted'));
 const v=plain(fresh);v.counts.items++;assert.ok((await verify(v)).includes('item_count_mismatch'));
 const w=plain(fresh);const seg=w.baseline.archive.segments.find(entry=>entry.object);seg.text=seg.text.replace(/"title":"/,'"title":"X');assert.ok((await verify(w)).includes('segment_digest_mismatch'));
 const x=plain(fresh);x.baseline.generation.programmeRunId='11111111-1111-4111-8111-111111111111';assert.ok((await verify(x)).includes('generation_mismatch'));
 const y=plain(fresh);y.fidelity={level:'full',reasons:[]};assert.ok((await verify(y)).includes('fidelity_unstated'),'a dataset cannot claim full fidelity');
 const z=plain(fresh);delete z.baseline.archive.segments.find(entry=>entry.object).text;assert.ok((await verify(z)).includes('segment_digest_mismatch'));
 assert.deepEqual((await Replay.verifyDataset(fresh,{expectedDigest:'0'.repeat(64)})).problems,['digest_unexpected']);
 assert.ok((await Replay.verifyDataset(fresh,{expectedProgrammeRunId:id})).problems.includes('generation_mismatch'),'a dataset of another generation than expected');
 assert.deepEqual((await Replay.verifyDataset({kind:'other'})).problems,['dataset_unrecognized']);
 assert.deepEqual((await Replay.verifyDataset(null)).problems,['dataset_unrecognized']);
 // Plan refusals.
 const refuse=(options,helpers={segmentOf})=>codeOf(()=>Replay.planMutation(fresh,options,helpers));
 assert.equal(await refuse({seed:'',departures:1}),'invalid_seed');assert.equal(await refuse({seed:'s'.repeat(200),departures:1}),'invalid_seed');
 assert.equal(await refuse({seed:'s',departures:-1}),'invalid_departures');assert.equal(await refuse({seed:'s',departures:1.5}),'invalid_departures');
 assert.equal(await refuse({seed:'s',departures:Replay.LIMITS.maxDepartures+1}),'excessive_departures','above the cap');
 assert.equal(await refuse({seed:'s',departures:fresh.counts.items+1}),'excessive_departures','more than the ledger holds');
 assert.equal(await refuse({seed:'s',departures:1,returns:Replay.LIMITS.maxReentries+1}),'excessive_returns');
 assert.equal(await refuse({seed:'s',departures:1,returns:100000}),'excessive_returns');
 assert.equal(await refuse({seed:'s',departures:1},{}),'segment_function_missing','no reimplemented segment arithmetic');
 assert.equal(await codeOf(()=>Replay.planMutation(t,{seed:'s',departures:1},{segmentOf})),'dataset_invalid','a tampered dataset is never planned');
}

// 5. Mutation checks on a light synthetic fixture: each guard removed from the module is caught.
async function synthetic(Module){
 const SEG=4,runIdValue='00000000-0000-4000-8000-0000000000aa',archive='epg/discovery-archive/v1/';
 const item=index=>({key:'k'+String(index).padStart(3,'0'),title:'Title '+index,normalizedTitle:'title '+index,year:2000+index%20,seenInLatestSnapshot:true});
 const files=new Map();
 const segmentFile=(segment,keys)=>{const items=Object.fromEntries(keys.map(key=>[key,{payload:{...item(Number(key.slice(1))),lastSeenAt:1},envelope:{}}]));return JSON.stringify({schemaVersion:1,segment,writeId:'w'+segment,items});};
 const archived=[[0,['k100','k101']],[2,['k102']]];
 const entries=[];
 for(let segment=0;segment<SEG;segment++){
  const found=archived.find(entry=>entry[0]===segment);
  if(!found){entries.push({segment,object:null,sha256:null,items:0,bytes:0});continue;}
  const text=segmentFile(segment,found[1]),object=archive+'segments/00'+segment+'/w'+segment+'.json';
  files.set(object,text);entries.push({segment,object,sha256:await Module.sha256(text),items:found[1].length,bytes:text.length});
 }
 const manifest={schemaVersion:1,manifestId:'m1',segmentCount:SEG,segments:entries,totals:{items:3,bytes:0}};
 files.set(archive+'manifests/m1.json',JSON.stringify(manifest));
 files.set('epg/generations/'+runIdValue+'/discovery-latest.json',JSON.stringify({programmeRunId:runIdValue,ledgerMode:'bounded',archive:{manifestId:'m1'},items:Array.from({length:40},(_,index)=>item(index)).reverse()}));
 const reader={get:async key=>files.has(key)?{text:async()=>files.get(key)}:null};
 return {reader,files,runId:runIdValue,manifestKey:archive+'manifests/m1.json',segmentOf:(key,count)=>Number(key.slice(1))%count,entries};
}
async function checks(Module){
 const failed=[],check=async(name,run)=>{try{if(await run()!==true)failed.push(name);}catch{failed.push(name);}};
 const refused=async(promise,reason)=>{try{await promise;return false;}catch(error){return error.reason===reason;}};
 const fx=await synthetic(Module);
 const make=(reader=fx.reader,options={})=>Module.buildDataset(reader,{programmeRunId:fx.runId,builtAt:BUILT,...options});
 const set=(files,patch)=>({get:async key=>{if(key in patch)return {text:async()=>patch[key]};return files.has(key)?{text:async()=>files.get(key)}:null;}});
 const ds=await make();
 await check('a dataset verifies',async()=>(await Module.verifyDataset(ds)).ok);
 await check('digest is checked',async()=>{const t=JSON.parse(JSON.stringify(ds));t.baseline.items[0].title='x';return !(await Module.verifyDataset(t)).ok;});
 await check('segment digest is checked at build',async()=>{const obj=fx.entries.find(e=>e.object).object;return refused(make(set(fx.files,{[obj]:fx.files.get(obj).replace('Title','Titel')})),'segment_digest_mismatch');});
 await check('segment digest is checked in verify',async()=>{const t=JSON.parse(JSON.stringify(ds));const s=t.baseline.archive.segments.find(e=>e.object);s.text=s.text.replace('Title','Titel');return (await Module.verifyDataset(t)).problems.includes('segment_digest_mismatch');});
 await check('generation mismatch is refused',async()=>refused(make(set(fx.files,{['epg/generations/'+fx.runId+'/discovery-latest.json']:JSON.stringify({programmeRunId:'11111111-1111-4111-8111-111111111111',items:[]})})),'generation_mismatch'));
 await check('a missing segment is refused',async()=>{const obj=fx.entries.find(e=>e.object).object;const reader={get:async key=>key===obj?null:fx.reader.get(key)};return refused(make(reader),'segment_missing');});
 await check('duplicate keys are refused',async()=>{const doc=JSON.parse(fx.files.get('epg/generations/'+fx.runId+'/discovery-latest.json'));doc.items.push(doc.items[0]);return refused(make(set(fx.files,{['epg/generations/'+fx.runId+'/discovery-latest.json']:JSON.stringify(doc)})),'duplicate_key');});
 await check('the size budget is enforced on the generation',async()=>refused(make(fx.reader,{maxBytes:500}),'size_budget_exceeded'));
 await check('the size budget is enforced on the segments',async()=>{const gen=fx.files.get('epg/generations/'+fx.runId+'/discovery-latest.json').length,man=fx.files.get(fx.manifestKey).length;return refused(make(fx.reader,{maxBytes:gen+man+20}),'size_budget_exceeded');});
 await check('the item budget is enforced',async()=>refused(make(fx.reader,{maxItems:5}),'size_budget_exceeded'));
 await check('manifest totals are checked',async()=>{const m=JSON.parse(fx.files.get(fx.manifestKey));m.totals.items=99;return refused(make(set(fx.files,{[fx.manifestKey]:JSON.stringify(m)})),'manifest_totals_mismatch');});
 await check('fidelity cannot be claimed full',async()=>{const t=JSON.parse(JSON.stringify(ds));t.fidelity={level:'full',reasons:[]};return (await Module.verifyDataset(t)).problems.includes('fidelity_unstated');});
 const plan=(options,helpers={segmentOf:fx.segmentOf})=>Module.planMutation(ds,options,helpers);
 await check('the plan is deterministic',async()=>JSON.stringify(await plan({seed:'a',departures:7}))===JSON.stringify(await plan({seed:'a',departures:7})));
 await check('the seed changes the plan',async()=>JSON.stringify((await plan({seed:'a',departures:7})).departures)!==JSON.stringify((await plan({seed:'b',departures:7})).departures));
 await check('departures are bounded by the cap',async()=>await refused(plan({seed:'a',departures:20},{segmentOf:fx.segmentOf,maxDepartures:10}),'excessive_departures')&&await refused(plan({seed:'a',departures:Module.LIMITS.maxDepartures+1}),'excessive_departures'));
 await check('a caller cannot raise the cap',async()=>refused(plan({seed:'a',departures:Module.LIMITS.maxDepartures+1},{segmentOf:fx.segmentOf,maxDepartures:1e9}),'excessive_departures'));
 await check('departures are bounded by the ledger',async()=>refused(plan({seed:'a',departures:41}),'excessive_departures'));
 await check('returns are bounded by the archive',async()=>refused(plan({seed:'a',departures:1,returns:4}),'excessive_returns'));
 await check('returns are bounded by the cap',async()=>refused(plan({seed:'a',departures:1,returns:2},{segmentOf:fx.segmentOf,maxReturns:1}),'excessive_returns'));
 await check('a plan needs the real segment function',async()=>refused(plan({seed:'a',departures:1},{}),'segment_function_missing'));
 await check('a tampered dataset is not planned',async()=>{const t=JSON.parse(JSON.stringify(ds));t.baseline.items[1].title='x';return refused(Module.planMutation(t,{seed:'a',departures:1},{segmentOf:fx.segmentOf}),'dataset_invalid');});
 await check('a plan edit is detected',async()=>{const p=await plan({seed:'a',departures:7});return refused(Module.replayScan(ds,{...p,departures:p.departures.slice(1)}),'plan_digest_mismatch');});
 await check('a plan of another dataset is refused',async()=>{const p=await plan({seed:'a',departures:7});return refused(Module.replayScan(ds,{...p,datasetDigest:'0'.repeat(64)}),'plan_mismatch');});
 await check('departures and returns are disjoint from the scan',async()=>{const p=await plan({seed:'a',departures:7,returns:2});const scan=await Module.replayScan(ds,p);const keys=new Set(scan.map(i=>i.key));return p.departures.every(k=>!keys.has(k))&&p.returns.every(k=>keys.has(k))&&scan.length===35;});
 await check('the sorted items are canonical',async()=>{const keys=ds.baseline.items.map(i=>i.key);return keys.join()===[...keys].sort().join();});
 return failed;
}
{
 assert.deepEqual(await checks(Replay),[],'the real module passes every check');
 const mutants=[
  ['the dataset digest is not compared',"if(actual!==dataset.digest)bad('digest_mismatch');",""],
  ['the segment digest is not checked at build',"if(await segmentDigest(text)!==entry.sha256)throw fail('segment_digest_mismatch',{segment:entry.segment});",""],
  ['the segment digest is not checked in verify',"if(typeof segment.text!=='string'||await segmentDigest(segment.text)!==segment.sha256||segment.sha256!==entry.sha256){bad('segment_digest_mismatch');continue;}",""],
  ['the generation is not compared',"if(document.programmeRunId!==programmeRunId)throw fail('generation_mismatch',{expected:programmeRunId,found:document.programmeRunId??null});",""],
  ['a missing segment is accepted',"const text=await readText(reader,entry.object,'segment_missing');","let text='{}';try{text=await readText(reader,entry.object,'segment_missing');}catch{continue;}"],
  ['duplicate keys are accepted',"if(seen.has(item.key))throw fail('duplicate_key',{key:item.key});",""],
  ['the byte budget is not enforced anywhere',"if(bytes>maxBytes)throw fail('size_budget_exceeded',{bytes,maxBytes});","",true],
  ['the item budget is not enforced',"if(document.items.length>maxItems)throw fail('size_budget_exceeded',{items:document.items.length,maxItems});",""],
  ['manifest totals are not compared',"if(archivedItems!==manifest.totals?.items)throw fail('manifest_totals_mismatch',{expected:manifest.totals?.items??null,found:archivedItems});",""],
  ['fidelity can be claimed full',"dataset.fidelity.level!=='reduced'","false"],
  ['the departure cap is gone',"if(departures>departureCap)throw fail('excessive_departures',{departures,max:departureCap});",""],
  ['the return cap is gone',"if(returns>returnCap)throw fail('excessive_returns',{returns,max:returnCap});",""],
  ['a caller can raise the cap',"const departureCap=Math.min(LIMITS.maxDepartures,","const departureCap=Math.max(LIMITS.maxDepartures,"],
  ['departures may exceed the ledger',"if(departures>keys.length)throw fail('excessive_departures',{departures,active:keys.length});",""],
  ['returns may exceed the archive',"if(returns>onlyKeys.length)throw fail('excessive_returns',{returns,archived:onlyKeys.length});",""],
  ['the seed is ignored',"const random=rng(dataset.digest+'|'+seed);","const random=rng(dataset.digest+'|');"],
  ['the segment function is not required',"if(typeof helpers.segmentOf!=='function')throw fail('segment_function_missing');",""],
  ['a tampered dataset is planned',"if(!checked.ok)throw fail('dataset_invalid',{problems:checked.problems});\n  const keys=","\n  const keys="],
  ['a plan digest is not checked',"if(digest!==await sha256(canonical(rest)))throw fail('plan_digest_mismatch');",""],
  ['a plan of another dataset is accepted',"plan.datasetDigest!==dataset.digest","false"],
  ['items are not sorted',"const items=[...document.items].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);","const items=[...document.items];"],
 ];
 for(const [name,from,to,every] of mutants){
  const found=source.split(from).length-1;
  assert.ok(every?found>=1:found===1,'the mutant pattern exists'+(every?'':' once')+': '+name);
  const failed=await checks(load(every?source.split(from).join(to):source.replace(from,to)));
  assert.ok(failed.length>0,'the checks catch the mutant "'+name+'"');
 }
}
void sql;void runId;void keyOf;void scan;void context;
console.log('EPG replay datasets: read-only builder, digest-verified canonical dataset, deterministic seeded plans, parity with the real planner, tamper and incomplete-baseline refusals and every guard mutant caught passed');
