// AIR-426: an offline rehearsal of `frozen` to `bounded` with the Discovery authority in D1. The real planner
// (`planDiscoveryLedger` through `stageSealedGeneration`) and the real ledger seal run against a sqlite stand-in and an in-memory
// bucket, generation after generation, in the order production would see: a full ledger, a first archive, a frozen period that
// accumulates absent rows, then bounded again. After every generation the active ledger plus the archive it names must hold
// exactly what one ever-growing ledger would hold (payload parity), in R2 and in D1. Local stand-ins only: no Cloudflare, TMDB
// or production. The catalog and publication steps after the ledger are the same in every mode and are not run here.
//
//   BOUNDED_PERF=47059:20568   also run the bounded commits that drain a frozen ledger of that size and scan size, and report each (not in the default run);
//   BOUNDED_CAP=4000           the departure budget for that run (default: the code's)
import assert from 'node:assert/strict';
import * as Authority from '../src/discovery-authority.js';
import {context,call,sql,DAY,BASE,scan,runId,merge,keyOf,POINTER,world,envOf,takeLease,bootstrap,commit,r2Union,assertParity,d1Counts} from './discovery-bounded-lib.mjs';


if(!process.env.BOUNDED_PERF){
 // 1. The production order: full, a first archive, a frozen period, bounded again, a frozen rollback, bounded again.
 const state=world();
 await bootstrap(state,0);
 assertParity(state,'day 0 (installed)');
 const plan=[[1,undefined,'full'],[2,'bounded','bounded'],[3,undefined,'frozen'],[4,undefined,'frozen'],[5,'bounded','bounded'],[6,'bounded','bounded'],[7,undefined,'frozen'],[8,'frozen','frozen'],[9,'bounded','bounded'],[10,'bounded','bounded']];
 const history=[];let archiveRowsBefore=0;
 for(const [day,mode,effective] of plan){
  const previous=r2Union(state),previousKeys=new Set(previous.doc.items.map(item=>item.key));
  const latest=scan(day),latestKeys=new Set(latest.map(item=>keyOf(item)));
  const pointerBefore=state.bkt.json(POINTER)?.manifestId||null;
  const done=await commit(state,day,mode);
  const check=assertParity(state,'day '+day+' ('+effective+')');
  assert.equal(check.doc.ledgerMode??'full',effective,'day '+day+': the generation records the mode the planner used');
  const activeKeys=new Set(check.doc.items.map(item=>item.key));
  const departed=[...previousKeys].filter(key=>!activeKeys.has(key)),reentered=[...latestKeys].filter(key=>!previousKeys.has(key)&&previous.map.has(key));
  const counts=d1Counts(state.file),pointerAfter=state.bkt.json(POINTER)?.manifestId||null;
  if(effective==='bounded'){
   assert.deepEqual([...activeKeys].sort(),[...latestKeys].sort(),'day '+day+': a bounded active ledger is exactly the latest scan');
   assert.ok(check.doc.items.every(item=>item.seenInLatestSnapshot===true),'day '+day+': every bounded row was seen');
   assert.equal(pointerAfter!==pointerBefore,departed.length>0,'day '+day+': the archive pointer moves exactly when something departs');
  }else{
   assert.equal(departed.length,0,'day '+day+': nothing leaves a '+effective+' ledger');
   assert.equal(pointerAfter,pointerBefore,'day '+day+': a '+effective+' commit writes no archive');
  }
  // D1 archives exactly the departures (a row per departure, never deleted) and keeps nothing retiring.
  assert.equal((counts.archive||0)-archiveRowsBefore,departed.length,'day '+day+': one D1 archive row per departure');
  assert.equal(counts.retiring||0,0);
  archiveRowsBefore=counts.archive||0;
  // A key that returns takes its history from the archive: its record equals the ever-growing ledger's (checked by parity), and it
  // is listed as also archived, because its archive copy stays.
  for(const key of reentered)assert.ok(check.doc.archive.alsoArchived.includes(key),'day '+day+': a re-entered key is listed as also archived: '+key);
  history.push({day,effective,active:check.active,total:check.total,departed:departed.length,reentered:reentered.length,d1:counts,staging:done.staging});
 }
 assert.ok(history.some(row=>row.effective==='bounded'&&row.departed>0&&row.reentered>0),'the plan exercises a bounded commit with departures and re-entries');
 assert.ok(history.find(row=>row.day===5).departed>history.find(row=>row.day===6).departed,'the first bounded commit after a frozen period archives the accumulated absent rows');
 console.log(JSON.stringify({bounded_d1_rehearsal:history.map(({day,effective,active,total,departed,reentered,d1})=>({day,effective,active,total,departed,reentered,d1Archive:d1.archive||0}))}));

 // 2. What the D1 reader says against what R2 holds (AIR-427). D1 stores neither the mode of a generation nor the R2 archive: the reader
 //    answers `unknown` for the mode and names its archive figures as D1 rows. D1 counts a row per departure, so a key that departed
 //    twice has two rows; the R2 archive keeps one record per key.
 {
  const union=r2Union(state),env=envOf(state);
  const ledger=await call('loadJSON')(env,'epg/discovery-latest.json');
  const r2Unique=union.doc.archive.uniqueArchivedItems;
  const d1Rows=Number(sql(state.file,"SELECT COUNT(*) AS n FROM discovery_observation WHERE residence='archive'")[0].n);
  const d1DistinctKeysNotActive=Number(sql(state.file,"SELECT COUNT(DISTINCT observation_key) AS n FROM discovery_observation WHERE residence='archive' AND observation_key NOT IN (SELECT observation_key FROM discovery_observation WHERE residence='active')")[0].n);
  assert.equal(ledger.ledgerMode,'unknown','the D1 reader does not claim a mode it cannot prove');
  assert.equal(ledger.archive.source,'d1');
  assert.equal(ledger.archive.d1.archiveOnlyRows,d1Rows-Number(sql(state.file,"SELECT COUNT(*) AS n FROM discovery_observation WHERE residence='archive' AND observation_key IN (SELECT observation_key FROM discovery_observation WHERE residence='active')")[0].n));
  assert.equal(d1DistinctKeysNotActive,r2Unique,'in this world every departure went through D1, so the keys archived only in R2 each have a D1 row');
  assert.ok(d1Rows>d1DistinctKeysNotActive,'keys that departed more than once have more than one D1 archive row');
  console.log(JSON.stringify({status_counters:{r2UniqueArchived:r2Unique,d1ArchiveOnlyRows:ledger.archive.d1.archiveOnlyRows,d1ArchiveRows:d1Rows,d1DistinctArchivedNotActive:d1DistinctKeysNotActive}}));
 }

 // 3. AIR-426 finding A, and its fix. With READ_CAP rows (20,000) or fewer the D1 ledger is read whole. The chunk used to take the
 //    whole-ledger path for that, which saves the whole decision map; a whole-map save fails closed once a decided key has departed
 //    from the active ledger (and above READ_CAP decisions). A frozen ledger never gets there (it is far above READ_CAP and nothing
 //    departs); a bounded ledger has the size of one scan (20,568 on 10 November, 19,821 and 20,506 earlier) and 4,995 of the 32,530
 //    stored decisions already have no active observation. The D1 chunk is now the paged one whatever the size.
 {
  const env=envOf(state,'bounded');
  const ledger=await call('loadJSON')(env,'epg/discovery-latest.json');
  assert.ok(Array.isArray(ledger.items)&&!ledger.paged,'a small active ledger is read whole, not paged');
  const lease=await takeLease(env,state.file);env.discoveryLease=lease;
  const activeKey=ledger.items[0].key;
  const evidence=sql(state.file,"SELECT evidence_key AS e FROM discovery_observation WHERE source_key='active' AND observation_key='"+activeKey.replace(/'/g,"''")+"'")[0].e;
  await call('saveJSON')(env,'epg/discovery-resolution.json',{[activeKey]:{status:'no_confident_match',checkedAt:'2026-11-10T00:00:00.000Z',evidenceKey:evidence,attempts:1}});
  // The key departs: a scan without it.
  const day=11,without=scan(day).filter(item=>keyOf(item)!==activeKey);
  assert.ok(scan(day).some(item=>keyOf(item)===activeKey),'the key is in the next scan unless removed');
  await commit(state,day,'bounded',{latest:without});
  assertParity(state,'day 11 (bounded, one decided key departs)');
  const after=envOf(state,'bounded'),lease2=await takeLease(after,state.file);after.discoveryLease=lease2;
  const decisions=await call('loadJSON')(after,'epg/discovery-resolution.json');
  assert.ok(decisions[activeKey],'the decision of a departed key is kept');
  await assert.rejects(()=>call('saveJSON')(after,'epg/discovery-resolution.json',decisions),error=>error?.code==='discovery_fence'||/discovery_fence/.test(String(error?.message)),'saving the whole decision map fails closed once a decided key has departed');
  // The chunk of that small ledger goes to the paged path, with the descriptor the reader gives above READ_CAP, and never to the
  // whole-ledger path.
  const real=context.resolvePagedDiscoveryChunk,seen=[];
  context.resolvePagedDiscoveryChunk=async(env_,report,limit,lease_,checkpoint,source)=>{seen.push(source);return {stage:'complete',checked:0,remaining:0};};
  try{
   const result=await call('resolveDiscoveryChunk')(after,{films:[]},1,lease2);
   assert.equal(result.stage,'complete');
  }finally{context.resolvePagedDiscoveryChunk=real;}
  assert.equal(seen.length,1,'the small D1 ledger is resolved by the paged chunk');
  assert.equal(seen[0].paged,true);assert.equal(seen[0].items,null);
  assert.equal(seen[0].itemCount,Number(sql(state.file,"SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key='active' AND residence='active'")[0].n));
  assert.equal(seen[0].programmeRunId,state.published.programmeRunId);
  // The key returns: the decision is still there and is joined again.
  await commit(state,12,'bounded',{latest:[...scan(12).filter(item=>keyOf(item)!==activeKey),scan(day).find(item=>keyOf(item)===activeKey)]});
  assertParity(state,'day 12 (bounded, the decided key returns)');
  const again=envOf(state,'bounded');
  assert.ok((await call('loadJSON')(again,'epg/discovery-resolution.json'))[activeKey],'the decision survives departure and re-entry');
 }

 // 4. Fail closed, and a stop after the archive pointer moved.
 {
  const state2=world();
  await bootstrap(state2,0);
  await commit(state2,1,undefined);await commit(state2,2,'bounded');await commit(state2,3,undefined);
  const snapshot=()=>JSON.stringify({pointer:state2.bkt.json(POINTER),d1:d1Counts(state2.file),transfer:sql(state2.file,'SELECT state, programme_run_id FROM discovery_transfer')[0],authority:sql(state2.file,'SELECT programme_run_id, published_programme_run_id FROM discovery_authority')[0]});
  const stable=snapshot();
  // (a) The manifest the pointer names is missing: the commit stops before any write.
  const realPointer=state2.bkt.objects.get(POINTER);
  await state2.bkt.put(POINTER,JSON.stringify({manifestId:'missing-manifest'}));
  let stopped=await commit(state2,4,'bounded',{expectThrow:true});
  assert.match(String(stopped.error.message),/manifest missing/);
  state2.bkt.objects.set(POINTER,realPointer);
  assert.equal(snapshot(),stable,'a missing manifest changes nothing');
  // (b) The published generation moved under the commit: the archive fence stops it and the pointer is not swapped.
  const fenceBefore=state2.published.fence;
  context.PublishedEpg.currentGeneration=async()=>({programmeRunId:state2.published.programmeRunId,phase:'published',fence:'someone-else'});
  stopped=await commit(state2,4,'bounded',{expectThrow:true});
  assert.match(String(stopped.error.message),/fence lost/);
  context.PublishedEpg.currentGeneration=async()=>({programmeRunId:state2.published.programmeRunId,phase:'published',fence:state2.published.fence});
  assert.equal(state2.published.fence,fenceBefore);
  assert.equal(snapshot(),stable,'a lost fence changes nothing');
  // (c) A named segment version is missing: a re-entry cannot be read, so the commit stops rather than lose history.
  // (covered by the manifest and fence stops above for the pointer; the segment read is fenced by the same manifest.)
  // (d) The commit dies after the archive pointer moved and before the generation document is stored (ADR 0034, crash window 3).
  //     The previous generation stays published with a newer archive; a retry of the same day starts from that archive and the
  //     result is the same as an uninterrupted commit.
  let failed=false;
  state2.bkt.onPut=async key=>{if(!failed&&/^epg\/generations\/.*\/discovery-latest\.json$/.test(key)){failed=true;throw new Error('R2 unavailable');}};
  stopped=await commit(state2,4,'bounded',{expectThrow:true});
  state2.bkt.onPut=null;
  assert.match(String(stopped.error.message),/R2 unavailable/);
  assert.notEqual(state2.bkt.json(POINTER).manifestId,JSON.parse(stable).pointer.manifestId,'the archive pointer had already moved');
  assert.equal(JSON.stringify(d1Counts(state2.file)),JSON.stringify(JSON.parse(stable).d1),'D1 was not touched by the stopped commit');
  assert.equal(sql(state2.file,'SELECT state FROM discovery_transfer')[0].state,'committed');
  // A reader of the still-published generation sees its own manifest: nothing it needs was overwritten.
  r2Union(state2);
  await commit(state2,4,'bounded');
  assertParity(state2,'day 4 (bounded, retried after a stop behind the pointer)');
  // (e) The seal is interrupted between steps (a dead step leaves the job in `items` or `archive`): the same run resumes and the
  //     result is the same. A killed batch inside a step is covered by tests/discovery-seal-resume.mjs and -throughput.mjs.
  const partial=await commit(state2,5,'bounded',{sealSteps:0});
  assert.equal(partial.done,false);
  assert.equal(sql(state2.file,'SELECT state FROM discovery_transfer')[0].state,'committed','staging alone does not open the D1 transfer');
  let done=false,steps=0;
  while(!done&&steps<20){steps++;const stepEnv=envOf(state2,'bounded'),lease=await takeLease(stepEnv,state2.file);done=(await call('sealLedgerStep')(stepEnv,partial.run,lease,Date.now()-1)).done;}
  assert.ok(done&&steps>1,'the seal finishes over several spent steps: '+steps);
  state2.published={programmeRunId:runId(5),fence:'g'+(++state2.generation)};
  state2.full=merge(state2.full,scan(5),{replaceShows:true,programmeRunId:runId(5)});
  assertParity(state2,'day 5 (bounded, seal resumed)');
  // (f) Rollback R1: the flag goes back to unset. Nothing is rebuilt or deleted, departures stop, re-entry still reads the archive.
  const pointer=state2.bkt.json(POINTER).manifestId,archiveRows=d1Counts(state2.file).archive||0;
  await commit(state2,6,undefined);
  const rolled=assertParity(state2,'day 6 (rollback to frozen)');
  assert.equal(rolled.doc.ledgerMode,'frozen');
  assert.equal(state2.bkt.json(POINTER).manifestId,pointer,'a frozen commit writes no archive');
  assert.equal(d1Counts(state2.file).archive||0,archiveRows,'and archives no D1 row');
 }
 console.log('discovery bounded D1 rehearsal ok');
}else{
 // Performance of a first bounded commit at production size. Synthetic rows of about the production size; the stand-in has no
 // network, so the figures are R2 objects and bytes, D1 round trips and rows, and local wall time.
 const [total,seen]=process.env.BOUNDED_PERF.split(':').map(Number);
 const state=world();
 const pad='я'.repeat(330);
 const row=(i,day)=>{const start=BASE+day*DAY+(i%24)*3600000,title='Картина к'+i.toString(36)+' ('+(1950+i%70)+')';return {key:null,confirmedTmdbId:null,title,rawTitles:[title],normalizedTitle:null,year:1950+i%70,duration:90,description:pad+i,firstAiring:start,lastAiring:start,airings:1,shows:[{channelId:'ch'+(i%40),channel:'Канал',start,end:start+5400000,epgTitle:title},{channelId:'d'+(i%9),channel:'Д',start:start+7200000,end:start+9000000,epgTitle:title}]};};
 const id0=runId(0);
 // Day 0: `total` rows, of which only the first `seen` are seen (a frozen ledger); installed directly.
 const first=merge([],Array.from({length:total},(_,i)=>row(i,0)),{replaceShows:true,programmeRunId:id0});
 state.full=merge(first,Array.from({length:seen},(_,i)=>row(i,1)),{replaceShows:true,programmeRunId:id0});
 const framing=call('discoveryDocumentFraming')({programmeRunId:id0},{ledgerMode:'frozen'}),encoder=new TextEncoder();
 await state.bkt.put('epg/generations/'+id0+'/discovery-latest.json',call('discoveryDocumentStream')(framing,(async function*(){for(const item of state.full)yield encoder.encode(JSON.stringify(item));})()));
 const env=envOf(state);const taken=await Authority.acquireLease(env,{programmeRunId:null});env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:id0,handoff:true,lease:taken.lease,items:(async function*(){for(const item of state.full)yield item;})()});
 await Authority.releaseLease(env,taken.lease);
 state.published={programmeRunId:id0,fence:'g1'};
 const latest=Array.from({length:seen},(_,i)=>row(i,2));
 if(process.env.BOUNDED_CAP)context.ledgerDrainCap=()=>Number(process.env.BOUNDED_CAP);
 const cap=call('ledgerDrainCap')();
 const frozen=await commit(state,2,undefined,{latest});
 const frozenDoc=state.bkt.objects.get('epg/generations/'+runId(2)+'/discovery-latest.json').bytes.length;
 const round=value=>Math.round(value*10)/10;
 const commits=[];
 // Bounded commits on an unchanged scan (no daily flow) until the backlog is gone: `ceil(backlog / cap)` of them.
 for(let day=3;day<3+Math.ceil((total-seen)/cap)+2;day++){
  const archiveBefore=d1Counts(state.file).archive||0;
  const step=await commit(state,day,'bounded',{latest:Array.from({length:seen},(_,i)=>row(i,day))});
  const doc=state.bkt.objects.get('epg/generations/'+runId(day)+'/discovery-latest.json').bytes;
  const backlog=r2Union(state).doc.drain?.backlog||0;
  commits.push({day,stagingMs:step.staging.ms,r2Puts:step.staging.r2Puts,r2Mb:round(step.staging.r2Bytes/1e6),documentMb:round(doc.length/1e6),archivedRows:(d1Counts(state.file).archive||0)-archiveBefore,backlogLeft:backlog,sealRoundTrips:step.staging.sealTrips,sealBatches:step.staging.sealBatches});
  if(backlog===0)break;
 }
 const drained=commits[commits.length-1];
 console.log(JSON.stringify({bounded_perf:{total,seen,cap,
  frozenCommit:{stagingMs:frozen.staging.ms,r2Puts:frozen.staging.r2Puts,r2Mb:round(frozen.staging.r2Bytes/1e6),documentMb:round(frozenDoc/1e6),sealRoundTrips:frozen.staging.sealTrips,sealBatches:frozen.staging.sealBatches},
  boundedCommits:commits,d1:d1Counts(state.file)}}));
 assert.equal(drained.backlogLeft,0,'the backlog drained');
 assert.equal(commits.length,Math.ceil((total-seen)/cap),'in ceil(backlog / cap) commits');
 assert.equal(d1Counts(state.file).active,seen);assert.equal(d1Counts(state.file).archive,total-seen);
 console.log('discovery bounded D1 perf ok');
}
