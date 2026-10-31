import assert from 'node:assert/strict';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,diaryPages,diaryPage,diaryRow,migrated,QUEUE,CURSOR,HISTORY,RUN,SEPARATE,H,MIN,eventKeyOf,film,plain,g} from './ratings-harness.mjs';

// ADR 0060 decisions 4, 5, 7 and 8: the ratings run record, its lease and checkpoints, the start and step answers,
// stale runs, isolation, the scheduled gap, and a status that only reads.
const T0=Date.parse('2026-10-31T08:00:00.000Z');
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);
function setup({pages=12,extra={}}={}){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 const env=baseEnv(bucket,{...SEPARATE,...extra});
 if(pages)diaryPages(net,{pages});
 return {clock,net,bucket,ctx,env,R:g(ctx,'LetterboxdRatings')};
}
const at=ms=>new Date(ms).toISOString();
async function drain(R,env,runId,limit=20){const replies=[];for(let i=0;i<limit;i++){const reply=plain(await R.step(env,{runId}));replies.push(reply);if(reply.nextAction!=='continue')break;}return replies;}

// 1. Inline (the default) and an unmigrated separate switch: start and step write nothing; the status reads.
{
 const {bucket,env,R,net}=setup();
 const inline={...env,RATINGS_PIPELINE:undefined};
 eq(await R.start(inline,{trigger:'manual'}),{runId:null,created:false,nextAction:'stop',reason:'disabled'});
 assert.equal((await R.step(inline,{runId:'x'})).reason,'disabled');
 const pending=plain(await R.start(env,{trigger:'manual'}));
 assert.equal(pending.reason,'not_migrated');assert.equal(pending.migration,'none');
 assert.equal((await R.step(env,{runId:'x'})).reason,'not_migrated');
 const status=plain(await R.status(env));
 assert.equal(status.pipeline,'separate_pending_migration');assert.equal(status.switch,'separate');assert.equal(status.sideEffects,'none');
 assert.equal(plain(await R.status(inline)).pipeline,'inline');
 assert.equal(bucket.writes().length,0,'nothing written');assert.equal(net.fetches.length,0,'nothing requested');
}

// 2. A full run: three Diary pages per step, nine per run, a checkpoint after each page, then the removal phase.
// The next run goes on from the cursor: page 1 overlaps, the backfill resumes one page before where it stopped.
{
 const {bucket,env,R,net}=setup();
 migrated(bucket);
 const started=plain(await R.start(env,{trigger:'manual'}));
 assert.equal(started.reason,'started');assert.equal(started.nextAction,'continue');assert.equal(started.created,true);
 const replies=await drain(R,env,started.runId);
 eq(replies.map(reply=>[reply.nextAction,reply.reason,reply.step?.diaryPages??null]),[['continue','more_work',3],['continue','more_work',3],['continue','more_work',3],['stop','finished',0]]);
 eq(net.diaryFetches().map(url=>Number(url.match(/page\/(\d+)/)?.[1]||1)),[1,2,3,4,5,6,7,8,9]);
 const run=bucket.value(RUN);
 assert.equal(run.state,'finished');assert.equal(run.phase,'done');assert.equal(run.checkpoint.diaryPagesRead,9);assert.equal(run.checkpoint.diaryNextPage,10);
 assert.equal(run.lease.step,null,'the lease is released');
 assert.equal(run.recent[0].runId,started.runId);
 assert.equal(Object.keys(bucket.value(HISTORY).entries).length,450);
 const cursor=bucket.value(CURSOR);
 assert.equal(cursor.schemaVersion,2);assert.equal(cursor.writer.runId,started.runId);assert.equal(cursor.resumePage,10);
 assert.ok([...bucket.records.keys()].some(key=>key.startsWith('letterboxd/facts/')),'the rating facts of the pages read are written');
 assert.equal(net.watchlistFetches().length,0,'the ratings run never reads the watchlist');
 assert.ok(!bucket.log.some(item=>item.key==='watchlist.json'||item.key==='sync.json'||item.key==='programme.json'),'nor the sync or EPG objects');
 // Run 2: page 1 is known, the backfill resumes at page 9 (overlap) and reaches the end.
 net.fetches.length=0;
 const second=plain(await R.start(env,{trigger:'manual'}));
 const more=await drain(R,env,second.runId);
 eq(net.diaryFetches().map(url=>Number(url.match(/page\/(\d+)/)?.[1]||1)),[1,9,10,11,12]);
 assert.equal(more.at(-1).reason,'finished');
 eq(bucket.value(CURSOR).coverage.reachedEnd,true);assert.equal(bucket.value(CURSOR).resumePage,null);
 assert.equal(bucket.value(RUN).diary.outcome,'complete');
 assert.equal(bucket.value(RUN).recent.length,2);
}

// 3. Page boundaries: a step whose lease runs short stops before the next request (`step_budget`) and the next step
// reads that page; a step that never starts a page reads nothing twice.
{
 const {bucket,env,R,net,clock}=setup();
 migrated(bucket);
 const {runId}=plain(await R.start(env,{trigger:'manual'}));
 let pagesSeen=0;
 const step=plain(await R.step(env,{runId},{now:clock.now,clock:()=>clock.now+(net.diaryFetches().length>pagesSeen?R.LEASE_MS-R.LEASE_MARGIN_MS+1:0)}));
 assert.equal(step.step.diaryPages,1);assert.equal(step.nextAction,'continue');
 assert.equal(bucket.value(RUN).checkpoint.diaryNextPage,2);
 assert.equal(bucket.value(CURSOR).stopReason,'step_budget');
 pagesSeen=Infinity;
 await R.step(env,{runId});
 eq(net.diaryFetches().map(url=>Number(url.match(/page\/(\d+)/)?.[1]||1)),[1,2,3,4]);
}

// 4. Diary failures end the Diary phase and the run is an error; the removal phase still runs. 403 is blocked, 429 rate
// limited, anything else failed; a partial run (the run budget) is not an error.
for(const [status,outcome,code,state] of [[403,'blocked','ratings_blocked','degraded'],[429,'rate_limited','ratings_rate_limit','degraded'],[500,'failed','ratings_failed','failed']]){
 const {bucket,env,R,net}=setup({pages:3});
 migrated(bucket);
 net.diary.set(2,status);
 const {runId}=plain(await R.start(env,{trigger:'manual'}));
 const replies=await drain(R,env,runId);
 assert.equal(replies.at(-1).reason,'error',outcome);
 const run=bucket.value(RUN);
 assert.equal(run.diary.outcome,outcome);assert.equal(run.cause,outcome);assert.equal(run.diary.pagesRead,1);
 assert.equal(bucket.value(CURSOR).resumePage,2,'the failed page is where the next run resumes');
 eq(R.health(run,T0),{lastSuccessAt:null,lastFailureAt:run.finishedAt,state,code});
}
{
 const {bucket,env,R}=setup({pages:12});
 migrated(bucket);
 const {runId}=plain(await R.start(env,{trigger:'manual'}));
 await drain(R,env,runId);
 assert.equal(bucket.value(RUN).diary.outcome,'partial');assert.equal(bucket.value(RUN).state,'finished');
 assert.equal(R.health(bucket.value(RUN),T0).code,'ok');
}

// 5. The removal phase: settle first, then at most five lookups with claim tokens; a rating reaches every unresolved
// removal event. A 403 pauses the queue and ends the lookups; the next run requests nothing while it is paused.
{
 const {bucket,env,R,net,ctx}=setup({pages:0,extra:{LETTERBOXD_DIARY_HISTORY:undefined}});
 const films={};
 const ids=['a','b','c','d','e','f','g'];
 const eventAt=at(T0-2*H);
 await ctx.writeEvent(env,{id:'run-1-watchlist',type:'watchlist',at:eventAt,total:0,baseline:false,added:[],removed:ids.map(id=>({id,title:id,year:2000}))});
 for(const [n,id] of ids.entries())films[id]={url:film(id).url,state:'pending',attempts:0,enqueuedAt:at(T0-H+n),nextAttemptAt:at(T0-H),lastAttemptAt:null,lastResult:null,claim:null,refs:[{eventKey:eventKeyOf(eventAt,'run-1-watchlist'),sourceRunId:'run-1',at:eventAt,resolved:false}]};
 migrated(bucket,{films});
 net.members.set('a',4);net.members.set('b','none');net.members.set('c',404);net.members.set('d',3.5);net.members.set('e',403);
 const {runId}=plain(await R.start(env,{trigger:'manual'}));
 assert.equal(bucket.value(RUN).phase,'removal','with the Diary off the run starts at the removal phase');
 const reply=plain(await R.step(env,{runId}));
 assert.equal(reply.reason,'finished');assert.equal(reply.step.lookups,5);
 eq(net.memberFetches().map(url=>url.split('/').at(-2)),['a','b','c','d','e']);
 const queue=bucket.value(QUEUE);
 eq(['a','b','c','d','e'].map(id=>[queue.films[id].state,queue.films[id].lastResult]),[['rated','saved'],['pending','not_rated'],['not_found','not_found'],['rated','saved'],['pending','blocked']]);
 assert.ok(Date.parse(queue.pausedUntil)>T0);assert.equal(queue.pausedBy,'blocked');
 eq(['a','d'].map(id=>queue.films[id].refs[0].resolved),[true,true]);
 const event=bucket.value(eventKeyOf(eventAt,'run-1-watchlist'));
 eq(event.removed.filter(item=>item.rating!=null).map(item=>[item.id,item.rating]),[['a',4],['d',3.5]]);
 assert.equal(bucket.value(RUN).removal.lookup.stoppedBy,'blocked');
 net.fetches.length=0;
 const again=plain(await R.start(env,{trigger:'manual'}));
 await drain(R,env,again.runId);
 assert.equal(net.memberFetches().length,0,'a paused queue is not requested');
 assert.equal(bucket.value(RUN).removal.lookup.stoppedBy,'blocked');
 // With REMOVAL_RATING_LOOKUP off the run only settles: no request at all.
 const off={...env,REMOVAL_RATING_LOOKUP:undefined};
 const third=plain(await R.start(off,{trigger:'manual'}));
 await drain(R,off,third.runId);
 assert.equal(bucket.value(RUN).removal.lookup.stoppedBy,'lookup_off');
 assert.equal(net.memberFetches().length,0);
}

// 5b. Settlements are bounded per step: 150 unresolved references take two steps, the lookups come after them.
{
 const {bucket,env,R,net,ctx}=setup({pages:0,extra:{LETTERBOXD_DIARY_HISTORY:undefined}});
 const films={};
 for(let r=0;r<15;r++){const eventAt=at(T0-(r+1)*H);await ctx.writeEvent(env,{id:'run-'+r+'-watchlist',type:'watchlist',at:eventAt,total:0,baseline:false,added:[],removed:Array.from({length:10},(_,n)=>({id:'s'+n,title:'S'+n,year:2000}))});}
 for(let n=0;n<10;n++)films['s'+n]={url:film('s'+n).url,state:'rated',rating:4,attempts:1,enqueuedAt:at(T0-H),nextAttemptAt:null,lastAttemptAt:null,lastResult:'saved',claim:null,refs:Array.from({length:15},(_,r)=>({eventKey:eventKeyOf(at(T0-(r+1)*H),'run-'+r+'-watchlist'),sourceRunId:'run-'+r,at:at(T0-(r+1)*H),resolved:false}))};
 films.todo={url:film('todo').url,state:'pending',attempts:0,enqueuedAt:at(T0-H),nextAttemptAt:at(T0-H),lastAttemptAt:null,lastResult:null,claim:null,refs:[]};
 migrated(bucket,{films});net.members.set('todo',2.5);
 const {runId}=plain(await R.start(env,{trigger:'manual'}));
 const first=plain(await R.step(env,{runId}));
 eq([first.nextAction,first.summary.removal.settled.resolved,first.summary.removal.lookup.stoppedBy,net.memberFetches().length],['continue',100,'settling',0]);
 const second=plain(await R.step(env,{runId}));
 eq([second.reason,second.summary.removal.settled.resolved,net.memberFetches().length],['finished',150,1]);
 assert.ok(Object.values(bucket.value(QUEUE).films).every(entry=>entry.refs.every(ref=>ref.resolved)));
}

// 6. A film the Diary proves resolves its queue entry without a lookup, and its removal events get the rating.
{
 const {bucket,env,R,net,ctx}=setup({pages:0});
 const eventAt=at(T0-H);
 await ctx.writeEvent(env,{id:'run-2-watchlist',type:'watchlist',at:eventAt,total:0,baseline:false,added:[],removed:[{id:'gone',title:'Gone',year:2001}]});
 migrated(bucket,{films:{gone:{url:film('gone').url,state:'pending',attempts:0,enqueuedAt:eventAt,nextAttemptAt:eventAt,lastAttemptAt:null,lastResult:null,claim:null,refs:[{eventKey:eventKeyOf(eventAt,'run-2-watchlist'),sourceRunId:'run-2',at:eventAt,resolved:false}]}}});
 net.diary.set(1,diaryPage([diaryRow('gone',9,'2026-10-29','5001'),diaryRow('other',6,'2026-10-28','5002')],false));
 net.members.set('gone',2);
 const {runId}=plain(await R.start(env,{trigger:'manual'}));
 await drain(R,env,runId);
 const entry=bucket.value(QUEUE).films.gone;
 assert.equal(entry.state,'rated');assert.equal(entry.lastResult,'diary');assert.equal(entry.rating,4.5);assert.equal(entry.refs[0].resolved,true);
 assert.equal(net.memberFetches().length,0,'no lookup for a film the Diary rated');
 assert.equal(bucket.value(eventKeyOf(eventAt,'run-2-watchlist')).removed[0].rating,4.5);
 assert.equal(bucket.value(RUN).diary.removalResolved,1);
}

// 7. Concurrency and lost responses.
{
 const {bucket,env,R,clock}=setup();
 migrated(bucket);
 // Two starts racing: one starts, the other answers busy and never sees the running id.
 let nested=null;
 bucket.hooks.beforePut=async key=>{if(key===RUN&&!nested){nested=R.start(env,{trigger:'manual'});await nested;}};
 const outer=plain(await R.start(env,{trigger:'manual'}));
 bucket.hooks.beforePut=null;
 const inner=plain(await nested);
 eq([inner.reason,outer.reason].sort(),['busy','started']);
 const runId=(inner.runId||outer.runId);
 assert.equal([inner.runId,outer.runId].filter(Boolean).length,1,'busy returns no runId');
 // A step while another step holds the lease waits until the lease expires.
 let waited=null;
 bucket.hooks.beforeGet=async key=>{if(key==='letterboxd/diary/history.json'&&!waited){waited=plain(await R.step(env,{runId}));}};
 const first=plain(await R.step(env,{runId}));
 bucket.hooks.beforeGet=null;
 assert.equal(waited.nextAction,'wait');assert.equal(waited.reason,'busy');assert.equal(waited.nextCatchUpAt,at(clock.now+R.LEASE_MS));
 assert.equal(first.nextAction,'continue');
 // A lost response: the caller repeats the step and the run goes on from its checkpoint, not from page 1.
 const repeat=plain(await R.step(env,{runId}));
 assert.equal(repeat.nextAction,'continue');assert.equal(bucket.value(RUN).checkpoint.diaryPagesRead,6);
 // Another runId is a mismatch and writes nothing.
 const writes=bucket.writes().length;
 eq(plain(await R.step(env,{runId:'00000000-0000-4000-8000-999999999999'})).reason,'run_mismatch');
 assert.equal(bucket.writes().length,writes);
 await drain(R,env,runId);
}
// An EPG enqueue racing a removal step's claim: both changes survive in the queue.
{
 const {bucket,env,R,net,ctx}=setup({pages:0,extra:{LETTERBOXD_DIARY_HISTORY:undefined}});
 const eventAt=at(T0-H),ref={eventKey:eventKeyOf(eventAt,'run-3-watchlist'),sourceRunId:'run-3',at:eventAt};
 migrated(bucket,{films:{a:{url:film('a').url,state:'pending',attempts:0,enqueuedAt:eventAt,nextAttemptAt:eventAt,lastAttemptAt:null,lastResult:null,claim:null,refs:[{...ref,resolved:false}]}}});
 net.members.set('a',4);
 let raced=false;
 bucket.hooks.beforePut=async key=>{if(key===QUEUE&&!raced){raced=true;await g(ctx,'enqueueRemovalRefs')(env,[film('fresh')],{eventKey:eventKeyOf(at(T0),'run-4-watchlist'),sourceRunId:'run-4',at:at(T0)});}};
 const {runId}=plain(await R.start(env,{trigger:'manual'}));
 await drain(R,env,runId);
 bucket.hooks.beforePut=null;
 const queue=bucket.value(QUEUE);
 assert.equal(queue.films.a.state,'rated');assert.equal(queue.films.a.claim,null);
 assert.equal(queue.films.fresh.refs[0].sourceRunId,'run-4','the EPG reference is not lost');
}

// 8. A killed step leaves its lease; once it expires the run is `interrupted`, closed as `unknown` by the next start or
// step, never resumed. Two identical interruptions isolate the pipeline; only a manual start with clearIsolation clears it.
{
 const {bucket,env,R,clock,net}=setup();
 migrated(bucket);
 const kill=()=>{let dead=false;bucket.hooks.beforePut=key=>{if(dead||key===HISTORY){dead=true;throw new Error('isolate killed');}};bucket.hooks.beforeGet=()=>{if(dead)throw new Error('isolate killed');};return ()=>{bucket.hooks.beforePut=null;bucket.hooks.beforeGet=null;};};
 const interrupted=async()=>{
  const {runId}=plain(await R.start(env,{trigger:'manual'}));
  const revive=kill();await assert.rejects(R.step(env,{runId}),/killed/);revive();
  assert.ok(bucket.value(RUN).lease.step,'the dead step still holds the lease');
  const writes=bucket.writes().length,fetches=net.fetches.length;
  clock.now+=R.LEASE_MS+1;
  const status=plain(await R.status(env));
  assert.equal(status.run.stale,'interrupted');assert.equal(status.run.state,'running');assert.equal(status.run.lease.live,false);
  assert.equal(bucket.writes().length,writes,'the status closes nothing');assert.equal(net.fetches.length,fetches);
  return runId;
 };
 const first=await interrupted();
 eq(plain(await R.step(env,{runId:first})),{runId:first,state:'unknown',phase:'diary',nextAction:'stop',reason:'unknown',nextCatchUpAt:null,step:null,summary:null,cause:'interrupted'});
 assert.equal(bucket.value(RUN).interruptedPhase,'diary');assert.equal(bucket.value(RUN).isolation,null);
 const second=await interrupted();
 const isolated=plain(await R.start(env,{trigger:'manual'}));
 assert.equal(isolated.reason,'isolated');assert.equal(isolated.runId,null);
 eq(isolated.isolation.runIds,[first,second]);assert.equal(isolated.isolation.phase,'diary');
 assert.equal(bucket.value(RUN).state,'unknown','the start closed the stale run');
 assert.equal(plain(await R.status(env)).pipeline,'isolated');
 assert.equal(R.health(bucket.value(RUN),clock.now).code,'ratings_pending');
 eq(plain(await R.handle(env,'start',{trigger:'scheduled',clearIsolation:true})),{status:400,body:{error:'clearIsolation requires trigger manual'}});
 assert.equal(plain(await R.start(env,{trigger:'scheduled'})).reason,'isolated');
 const cleared=plain(await R.start(env,{trigger:'manual',clearIsolation:true}));
 assert.equal(cleared.reason,'started');assert.equal(bucket.value(RUN).isolation,null);assert.ok(bucket.value(RUN).isolationClearedAt);
 // An abandoned run: no step for 30 minutes.
 clock.now+=R.ABANDONED_MS+1;
 assert.equal(plain(await R.status(env)).run.stale,'abandoned');
 const after=plain(await R.start(env,{trigger:'manual'}));
 assert.equal(after.reason,'started');assert.equal(bucket.value(RUN).recent[0].cause,'abandoned');assert.equal(bucket.value(RUN).recent[0].state,'unknown');
}

// 9. A step that outlives its lease: the progress it made stays (history and cursor joins), its run record write is
// refused and the answer is lease_lost.
{
 const {bucket,env,R,clock,net}=setup();
 migrated(bucket);
 const {runId}=plain(await R.start(env,{trigger:'manual'}));
 const reply=plain(await R.step(env,{runId},{now:clock.now,clock:()=>clock.now+(net.diaryFetches().length?R.LEASE_MS+1:0)}));
 assert.equal(reply.reason,'lease_lost');assert.equal(reply.nextAction,'stop');
 assert.equal(net.diaryFetches().length,1,'no request after the lease is lost');
 assert.equal(Object.keys(bucket.value(HISTORY).entries).length,50,'the page read is kept');
 assert.equal(bucket.value(CURSOR).coverage.newestWatchedDate,'2026-10-30');
 assert.equal(bucket.value(RUN).checkpoint.diaryPagesRead,0,'the run record is not written after the loss');
}

// 10. Scheduled starts keep six hours from the last start; a manual start is not gated.
{
 const {bucket,env,R,clock}=setup({pages:1});
 migrated(bucket);
 const first=plain(await R.start(env,{trigger:'scheduled'}));await drain(R,env,first.runId);
 clock.now+=2*H;
 const soon=plain(await R.start(env,{trigger:'scheduled'}));
 eq(soon,{runId:null,created:false,nextAction:'stop',reason:'too_soon',nextStartAt:at(T0+6*H)});
 const manual=plain(await R.start(env,{trigger:'manual'}));assert.equal(manual.reason,'started');await drain(R,env,manual.runId);
 clock.now=T0+8*H+1;
 assert.equal(plain(await R.start(env,{trigger:'scheduled'})).reason,'started');
}

// 11. The run does not need today's EPG: no published generation, no programme, the run still reads and finishes.
{
 const {bucket,env,R}=setup({pages:1});
 migrated(bucket);
 const {runId}=plain(await R.start(env,{trigger:'manual'}));
 assert.equal(bucket.value(RUN).pinned.programmeRunId,null);
 assert.equal((await drain(R,env,runId)).at(-1).reason,'finished');
}

console.log('Ratings run (ADR 0060): disabled and not_migrated write nothing, 3 pages per step and 9 per run with checkpoints and overlap resume, page boundaries, Diary blocked/rate-limited/failed/partial, five lookups with a 403 pause and lookup off, Diary-resolved queue entries, racing starts, a leased step, lost responses, run_mismatch, interrupted and abandoned runs closed as unknown, isolation and its manual clearing, lease_lost keeping progress, the scheduled gap and a run without EPG passed');
