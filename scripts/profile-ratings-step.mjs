// Memory and CPU profile of the largest ratings steps (ADR 0060), offline, on synthetic data:
// a Diary step of three full pages over a large stored history, a removal step of 100 settlements and a removal step
// of five lookups over a queue at its retention limits. Run: node --expose-gc scripts/profile-ratings-step.mjs
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,diaryPages,migrated,eventKeyOf,film,SEPARATE,HISTORY,QUEUE,H,DAY,g} from '../tests/ratings-harness.mjs';

const HISTORY_ENTRIES=Number(process.env.HISTORY_ENTRIES||5000),PER_PAGE=50;
const gc=()=>{if(globalThis.gc){globalThis.gc();globalThis.gc();}};
const MB=bytes=>Math.round(bytes/1048576*10)/10;
async function measure(label,work,bucket){
 gc();const base=process.memoryUsage().heapUsed;let peak=base,largestRead=0,largestWrite=0,reads=0,writes=0;
 const sample=()=>{const used=process.memoryUsage().heapUsed;if(used>peak)peak=used;};
 bucket.hooks.beforeGet=key=>{sample();reads++;const value=bucket.records.get(key);if(value!==undefined)largestRead=Math.max(largestRead,JSON.stringify(value).length);};
 bucket.hooks.beforePut=(key,value)=>{sample();writes++;largestWrite=Math.max(largestWrite,JSON.stringify(value).length);};
 const cpu=process.cpuUsage(),started=performance.now();
 const result=await work();
 const elapsed=performance.now()-started,used=process.cpuUsage(cpu);sample();
 bucket.hooks.beforeGet=null;bucket.hooks.beforePut=null;
 return {label,result,elapsedMs:Math.round(elapsed),cpuMs:Math.round((used.user+used.system)/1000),heapBaseMB:MB(base),heapPeakAboveBaseMB:MB(peak-base),largestReadKB:Math.round(largestRead/1024),largestWriteKB:Math.round(largestWrite/1024),reads,writes};
}

const T0=Date.parse('2026-10-31T08:00:00.000Z');
const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
const ctx=loadContext({net,clock,FakeDate,crypto});
const env=baseEnv(bucket,SEPARATE),R=g(ctx,'LetterboxdRatings');

// A stored history of HISTORY_ENTRIES older viewings, three new full pages on top of it.
const entries={};
for(let n=0;n<HISTORY_ENTRIES;n++){const date=new Date(Date.parse('2026-01-01')-n*DAY/4).toISOString().slice(0,10);entries['viewing:'+(900000+n)]={key:'viewing:'+(900000+n),keyBasis:'viewing_id',identity:{type:'letterboxd_lid',value:'old'+n},watchedDate:date,ratingAtEntry:3.5,rewatch:'unknown',firstSeenAt:new Date(T0-30*DAY).toISOString(),lastSeenAt:new Date(T0-30*DAY).toISOString(),page:4};}
bucket.set(HISTORY,{schemaVersion:1,entries});
diaryPages(net,{pages:4,perPage:PER_PAGE});
// The queue at its limits: 100 finished entries, 20 pending entries with 20 unresolved references each, the events stored.
const films={};
for(let n=0;n<100;n++)films['done'+n]={url:film('done'+n).url,state:'rated',rating:3,attempts:1,enqueuedAt:new Date(T0-DAY).toISOString(),nextAttemptAt:null,lastAttemptAt:null,lastResult:'saved',claim:null,refs:[{eventKey:eventKeyOf(new Date(T0-DAY).toISOString(),'d'+n),sourceRunId:'d'+n,at:new Date(T0-DAY).toISOString(),resolved:true}]};
for(let n=0;n<20;n++){
 const refs=[];
 for(let r=0;r<20;r++){const at=new Date(T0-(r+1)*H).toISOString(),id='run-'+r+'-watchlist';refs.push({eventKey:eventKeyOf(at,id),sourceRunId:'run-'+r,at,resolved:false});}
 films['p'+n]={url:film('p'+n).url,state:n<5?'pending':'rated',rating:n<5?undefined:4,attempts:0,enqueuedAt:new Date(T0-H+n).toISOString(),nextAttemptAt:new Date(T0-H).toISOString(),lastAttemptAt:null,lastResult:null,claim:null,refs};
 net.members.set('p'+n,4);
}
for(let r=0;r<20;r++){const at=new Date(T0-(r+1)*H).toISOString();await ctx.writeEvent(env,{id:'run-'+r+'-watchlist',type:'watchlist',at,total:0,baseline:false,added:[],removed:Array.from({length:20},(_,n)=>({id:'p'+n,title:'Film '+n,year:2000}))});}
migrated(bucket,{films});
const queueBytes=JSON.stringify(bucket.value(QUEUE)).length,historyBytes=JSON.stringify(bucket.value(HISTORY)).length;

const {runId}=await R.start(env,{trigger:'manual'});
const diary=await measure('diary step: 3 pages x '+PER_PAGE+' rows over '+HISTORY_ENTRIES+' stored entries',async()=>{const reply=await R.step(env,{runId});return {nextAction:reply.nextAction,reason:reply.reason,pages:reply.step.diaryPages};},bucket);
// Straight to the removal phase of the same run.
bucket.set('letterboxd/ratings/run.json',{...bucket.value('letterboxd/ratings/run.json'),phase:'removal'});
const settle=await measure('removal step: 100 settlements (event write and reference resolution), queue at its limits',async()=>{const reply=await R.step(env,{runId});return {nextAction:reply.nextAction,reason:reply.reason,lookups:reply.step.lookups,settled:reply.summary.removal.settled};},bucket);
while((await g(ctx,'settleRemovalRefs')(env,{limit:100})).left>0);
const lookups=await measure('removal step: retention, then 5 lookups, each with its 20 event writes',async()=>{const reply=await R.step(env,{runId});return {nextAction:reply.nextAction,reason:reply.reason,lookups:reply.step.lookups,lookup:reply.summary.removal.lookup};},bucket);
console.log(JSON.stringify({node:process.version,gcExposed:!!globalThis.gc,storedBytes:{history:historyBytes,queue:queueBytes},steps:[diary,settle,lookups]},null,1));
