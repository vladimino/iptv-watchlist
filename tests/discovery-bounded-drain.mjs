// AIR-429: the departure budget of a bounded ledger. A `frozen` ledger piles up observations that left the scan on earlier days (the
// backlog). The first bounded commit used to archive all of them in one request. Now a bounded commit archives the observations that left
// the scan since the previous generation at once (the daily flow) and at most `ledgerDrainCap()` of the backlog, in key order; the rest stay
// active, marked `drain` in the generation document, until a later commit archives them. The real planner and the real ledger seal run on a
// D1 stand-in and an in-memory bucket, against an independent model of what the active ledger must be after every generation. After
// each one, the active ledger plus its archive holds exactly what one ever-growing ledger holds (R2 and D1), nothing is deleted, and the
// backlog falls by the cap whatever the flow. Local stand-ins only: no Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import {context,call,sql,DAY,BASE,titles,runId,keyOf,POINTER,world,envOf,bootstrap,commit,r2Union,assertParity,d1Counts} from './discovery-bounded-lib.mjs';

const UNIVERSE=500,WINDOW=30,SHIFT=11,CAP=40;
// Candidate i is in the scan of day d when its slot is inside a window that moves by SHIFT slots a day: about a third of one day's scan
// is new on the next, so the daily flow (55 or so) is larger than the cap (40) and the drain still has to make progress.
const present=(i,d)=>((i*37+d*SHIFT)%100)<WINDOW;
function scanOf(day){
 const out=[];
 for(let i=0;i<UNIVERSE;i++){
  if(!present(i,day))continue;
  const start=BASE+day*DAY+(i%12)*3600000,title=titles(i)+' ('+(1960+i%40)+')';
  out.push({key:null,confirmedTmdbId:null,title,rawTitles:[title],normalizedTitle:null,year:1960+i%40,duration:90+(i%5)*5,description:'Описание '+i,firstAiring:start,lastAiring:start,airings:1,shows:[{channelId:'ch'+(i%7),channel:'Канал '+(i%7),start,end:start+5400000,epgTitle:title}]});
 }
 return out;
}
const keysOf=list=>new Set(list.map(raw=>keyOf(raw)));
const setEquals=(a,b)=>a.size===b.size&&[...a].every(key=>b.has(key));

// The model: the active ledger as {key: seen}, and what each commit must archive.
function expected(model,scanKeys,mode,cap){
 if(mode!=='bounded'){
  const next=new Map(model);
  for(const key of next.keys())next.set(key,false);
  for(const key of scanKeys)next.set(key,true);
  return {next,archived:new Set(),backlog:0,fresh:0,drained:0,absentBacklog:0};
 }
 const fresh=[],backlog=[];
 for(const [key,seen] of model){if(scanKeys.has(key))continue;if(seen)fresh.push(key);else backlog.push(key);}
 backlog.sort();
 const drained=backlog.slice(0,cap),held=backlog.slice(cap);
 const next=new Map();
 for(const key of scanKeys)next.set(key,true);
 for(const key of held)next.set(key,false);
 return {next,archived:new Set([...fresh,...drained]),backlog:held.length,fresh:fresh.length,drained:drained.length,absentBacklog:backlog.length};
}
const d1Active=file=>sql(file,"SELECT observation_key AS k, seen_in_latest AS s FROM discovery_observation WHERE source_key='active' AND residence='active'");

async function generation(state,model,day,mode,cap){
 context.ledgerDrainCap=()=>cap;
 const latest=scanOf(day),scanKeys=keysOf(latest),plan=expected(model.active,scanKeys,mode,cap);
 const archiveBefore=d1Counts(state.file).archive||0,pointerBefore=state.bkt.json(POINTER)?.manifestId||null;
 await commit(state,day,mode,{latest});
 const label='day '+day+' ('+(mode||'unset')+')';
 const check=assertParity(state,label);
 const doc=check.doc,docKeys=new Set(doc.items.map(item=>item.key));
 // The active ledger is exactly what the model says, with the model's seen flags.
 assert.ok(setEquals(docKeys,new Set(plan.next.keys())),label+': the active ledger is the scan plus the backlog that was not archived');
 for(const item of doc.items)assert.equal(item.seenInLatestSnapshot,plan.next.get(item.key),label+': seen flag of '+item.key);
 if(mode==='bounded'){
  assert.equal(doc.drain?.backlog,plan.backlog>0?plan.backlog:undefined,label+': the document names the backlog it still holds');
  if(plan.backlog>0)assert.equal(doc.drain.cap,cap);else assert.ok(!('drain' in doc),label+': no drain field once the backlog is gone');
  assert.equal(doc.ledgerMode,'bounded');
  // The bytes the planner wrote are what the status reader parses: the header sits right after the last item, `drain` before `archive`.
  {
   const text=state.bkt.objects.get('epg/generations/'+runId(day)+'/discovery-latest.json').bytes.toString('utf8');
   const at=text.lastIndexOf('],"ledgerMode"'),header=call('LEDGER_HEADER_PATTERN').exec(text.slice(at,at+512));
   assert.ok(header,label+': the document header is readable by the status');
   if(plan.backlog>0)assert.deepEqual([header[2],header[3]],[String(plan.backlog),String(cap)],label+': the header carries the drain');
   else assert.equal(header[2],undefined,label+': no drain in the header');
  }
  // The commit archived the flow at once and at most `cap` of the backlog: never more.
  assert.equal(plan.drained,Math.min(cap,plan.absentBacklog),label+': a commit archives at most the cap of the backlog');
  const archiveRows=(d1Counts(state.file).archive||0)-archiveBefore;
  assert.equal(archiveRows,plan.archived.size,label+': one D1 archive row per archived observation: '+plan.fresh+' fresh and '+plan.drained+' of the backlog');
  assert.equal(state.bkt.json(POINTER)?.manifestId!==pointerBefore,plan.archived.size>0,label+': the archive pointer moves exactly when something is archived');
  // The rows D1 holds for the held backlog are active and not seen; nothing is retiring.
  const rows=d1Active(state.file),notSeen=rows.filter(row=>Number(row.s)===0).length;
  assert.equal(notSeen,plan.backlog,label+': D1 holds exactly the held backlog as active, not-seen rows');
  assert.equal(d1Counts(state.file).retiring||0,0);
 }else{
  assert.ok(!('drain' in doc),label+': a '+(mode||'unset')+' ledger has no drain field');
 }
 assert.ok(setEquals(new Set(d1Active(state.file).map(row=>row.k)),docKeys),label+': D1 active rows are the active ledger');
 model.active=plan.next;
 return {plan,doc};
}

// 1. A frozen backlog drains in a bounded number of commits whatever the flow, and the active ledger then is exactly the scan.
{
 const state=world(),model={active:new Map()};
 await bootstrap(state,0,scanOf(0));
 for(const key of keysOf(scanOf(0)))model.active.set(key,true);
 assertParity(state,'day 0');
 let day=1;
 for(;day<=6;day++)await generation(state,model,day,undefined,CAP);
 const backlogAtStart=[...model.active.values()].filter(seen=>!seen).length,activeAtStart=model.active.size;
 assert.ok(backlogAtStart>200,'a frozen period piled up a backlog: '+backlogAtStart);
 // The flag is set. Day 7 is the first bounded commit.
 const first=await generation(state,model,day++,'bounded',CAP);
 const firstScan=keysOf(scanOf(7)),absentAtFirst=first.plan.absentBacklog;
 assert.ok(absentAtFirst>CAP,'the first bounded commit has more backlog than the cap: '+absentAtFirst);
 assert.equal(first.plan.drained,CAP,'it archives the cap, not the whole backlog');
 assert.ok(first.plan.backlog>0&&first.doc.items.length>firstScan.size,'its active ledger is more than the scan, and says so');
 assert.ok(first.plan.archived.size<=CAP+first.plan.fresh,'what it archives is the cap plus the flow');
 let previousBacklog=first.plan.backlog,commits=1,drainedAt=null;
 const flows=[first.plan.fresh];
 while(day<=7+14){
  const step=await generation(state,model,day,'bounded',CAP);
  commits++;flows.push(step.plan.fresh);
  // Progress: the backlog that is still absent shrinks by the cap in every commit, whatever new observations left the scan, and never grows.
  assert.ok(step.plan.backlog<=previousBacklog,'day '+day+': the backlog never grows');
  assert.ok(step.plan.backlog<=Math.max(0,previousBacklog-Math.min(CAP,step.plan.absentBacklog)),'day '+day+': the backlog falls by the cap');
  previousBacklog=step.plan.backlog;
  if(step.plan.backlog===0&&drainedAt===null)drainedAt=commits;
  day++;
 }
 assert.ok(Math.max(...flows)>CAP,'the daily flow went above the cap, so progress did not depend on it: '+flows.join(','));
 assert.ok(drainedAt!==null,'the backlog drained');
 assert.ok(drainedAt<=Math.ceil(absentAtFirst/CAP),'it drained within ceil(backlog/cap) commits: '+drainedAt+' of at most '+Math.ceil(absentAtFirst/CAP));
 // Fully drained: the active ledger is exactly the latest scan, every row seen, no drain field, and it stays so.
 const last=r2Union(state).doc,lastScan=keysOf(scanOf(day-1));
 assert.ok(setEquals(new Set(last.items.map(item=>item.key)),lastScan),'after the drain the active ledger equals the latest scan');
 assert.ok(last.items.every(item=>item.seenInLatestSnapshot===true));
 assert.ok(!('drain' in last));
 console.log(JSON.stringify({bounded_drain:{universe:UNIVERSE,cap:CAP,activeAtFirstBounded:activeAtStart,backlogAtFirstBounded:absentAtFirst,commitsToDrain:drainedAt,bound:Math.ceil(absentAtFirst/CAP),dailyFlow:flows.slice(0,6),finalActive:last.items.length}}));
}

// 2. A cap larger than the backlog is the plain bounded mode of ADR 0034: everything that left the scan is archived at once.
{
 const state=world(),model={active:new Map()};
 await bootstrap(state,0,scanOf(0));
 for(const key of keysOf(scanOf(0)))model.active.set(key,true);
 for(let day=1;day<=4;day++)await generation(state,model,day,undefined,CAP);
 const step=await generation(state,model,5,'bounded',100000);
 assert.equal(step.plan.backlog,0);assert.ok(!('drain' in step.doc));
 assert.ok(setEquals(new Set(step.doc.items.map(item=>item.key)),keysOf(scanOf(5))),'with a large cap the active ledger is the scan at once');
}

// 3. A commit that stops after the archive pointer moved and before the generation document is stored, in the middle of a drain, is retried
//    by the next attempt to the same result as an uninterrupted twin: the selection is a function of the published ledger and the scan.
{
 const history=async()=>{
  const state=world(),model={active:new Map()};
  await bootstrap(state,0,scanOf(0));
  for(const key of keysOf(scanOf(0)))model.active.set(key,true);
  for(let day=1;day<=5;day++)await generation(state,model,day,undefined,CAP);
  await generation(state,model,6,'bounded',CAP);
  return {state,model};
 };
 const a=await history(),b=await history();
 assert.ok(r2Union(a.state).doc.drain?.backlog>CAP,'the history ends in the middle of a drain');
 await generation(a.state,a.model,7,'bounded',CAP);
 // The twin B: the day-7 commit dies when the generation document is stored, after the archive pointer has moved.
 context.ledgerDrainCap=()=>CAP;
 const pointerBefore=b.state.bkt.json(POINTER).manifestId,publishedBefore=b.state.published.programmeRunId;
 let failed=false;
 b.state.bkt.onPut=async key=>{if(!failed&&/^epg\/generations\/.*\/discovery-latest\.json$/.test(key)){failed=true;throw new Error('R2 unavailable');}};
 const stopped=await commit(b.state,7,'bounded',{latest:scanOf(7),expectThrow:true});
 b.state.bkt.onPut=null;
 assert.match(String(stopped.error.message),/R2 unavailable/);
 assert.notEqual(b.state.bkt.json(POINTER).manifestId,pointerBefore,'the archive pointer had moved');
 assert.equal(b.state.published.programmeRunId,publishedBefore,'the previous generation is still the published one');
 r2Union(b.state);
 await generation(b.state,b.model,7,'bounded',CAP);
 const snapshot=state=>{
  const union=r2Union(state);
  return JSON.stringify({items:union.doc.items,drain:union.doc.drain??null,archivedKeys:[...union.map.keys()].sort(),alsoArchived:[...union.doc.archive.alsoArchived].sort(),unique:union.doc.archive.uniqueArchivedItems,
   d1:sql(state.file,"SELECT residence AS r, observation_key AS k, payload_json AS p FROM discovery_observation WHERE source_key='active' OR residence='archive' ORDER BY residence, observation_key, payload_json").map(row=>[row.r,row.k,row.p])});
 };
 assert.equal(snapshot(b.state),snapshot(a.state),'a drain commit retried after a stop behind the pointer equals the uninterrupted one');
}

// 4. Fail closed while draining: an archive manifest that is missing, or a published generation that moved, stops the commit before anything
//    is written, in drain as in plain bounded mode.
{
 const state=world(),model={active:new Map()};
 await bootstrap(state,0,scanOf(0));
 for(const key of keysOf(scanOf(0)))model.active.set(key,true);
 for(let day=1;day<=5;day++)await generation(state,model,day,undefined,CAP);
 await generation(state,model,6,'bounded',CAP);
 context.ledgerDrainCap=()=>CAP;
 const stable=()=>JSON.stringify({pointer:state.bkt.json(POINTER),d1:d1Counts(state.file),writes:state.bkt.puts.filter(key=>key!=='sync.json'&&key!==POINTER).length,published:state.published.programmeRunId});
 const before=stable(),real=state.bkt.objects.get(POINTER);
 await state.bkt.put(POINTER,JSON.stringify({manifestId:'missing-manifest'}));
 const writes=()=>state.bkt.puts.filter(key=>key!=='sync.json'&&key!==POINTER).length,writesBefore=writes();
 let stopped=await commit(state,7,'bounded',{latest:scanOf(7),expectThrow:true});
 assert.match(String(stopped.error.message),/manifest missing/);
 state.bkt.objects.set(POINTER,real);
 assert.equal(writes(),writesBefore,'a missing manifest stops before any archive write');
 const fence=state.published.fence;
 call('PublishedEpg');
 context.PublishedEpg.currentGeneration=async()=>({programmeRunId:state.published.programmeRunId,phase:'published',fence:'someone-else'});
 stopped=await commit(state,7,'bounded',{latest:scanOf(7),expectThrow:true});
 assert.match(String(stopped.error.message),/fence lost/);
 context.PublishedEpg.currentGeneration=async()=>({programmeRunId:state.published.programmeRunId,phase:'published',fence:state.published.fence});
 assert.equal(state.published.fence,fence);
 assert.equal(stable(),before,'nothing changed');
}

// 5. The memory bound is the point of the budget: a commit holds at most the flow plus the cap of departures, however large the backlog is.
{
 const seen=[];
 const state=world(),model={active:new Map()};
 await bootstrap(state,0,scanOf(0));
 for(const key of keysOf(scanOf(0)))model.active.set(key,true);
 for(let day=1;day<=6;day++)await generation(state,model,day,undefined,CAP);
 context.ledgerDrainCap=()=>CAP;
 const collect=context.collectLedgerDecisions;
 context.collectLedgerDecisions=async(...args)=>{const out=await collect(...args);seen.push(out.departures.length);return out;};
 try{await generation(state,model,7,'bounded',CAP);}finally{context.collectLedgerDecisions=collect;}
 assert.equal(seen.length,1);
 const flow=[...model.active.values()].filter(Boolean).length;
 assert.ok(seen[0]<=CAP+flow,'departures held in memory: '+seen[0]+' (cap '+CAP+', at most one day of flow more)');
}
console.log('discovery bounded drain ok');
