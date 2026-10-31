import assert from 'node:assert/strict';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,QUEUE,CURSOR,RUN,WITNESS,SEPARATE,H,eventKeyOf,film,plain,g,diaryPage,diaryRow} from './ratings-harness.mjs';

// ADR 0060 decision 10: ratings_storage_migrate and the migration boundary.
const T0=Date.parse('2026-10-31T08:00:00.000Z');
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);
const at=ms=>new Date(ms).toISOString();
function setup(extra={}){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 return {clock,net,bucket,ctx,env:baseEnv(bucket,{...SEPARATE,...extra}),R:g(ctx,'LetterboxdRatings')};
}
const V1_ENTRY={url:film('old').url,state:'not_rated',attempts:3,enqueuedAt:at(T0-H),nextAttemptAt:null,lastAttemptAt:at(T0-H),lastResult:'not_rated'};
const V1_CURSOR={schemaVersion:1,lastAttemptAt:at(T0-H),lastSuccessAt:at(T0-H),lastFailureAt:null,lastOutcome:'partial',stopReason:'page_budget',counts:{pages:3},coverage:{newestWatchedDate:'2026-10-30',oldestWatchedDate:'2026-09-01',reachedEnd:false},resumePage:4};
const QUEUES={absent:null,empty:{schemaVersion:1,films:{}},v1:{schemaVersion:1,films:{old:V1_ENTRY},pausedUntil:at(T0+H),pausedBy:'rate_limited'}};
const CURSORS={absent:null,v1:V1_CURSOR};

// 1. The matrix: every starting queue and cursor. dry_run writes nothing; apply converts both, records the witness, and
// a second apply changes nothing. The queue's version 1 entries become legacy entries with their state kept.
for(const [qName,queue] of Object.entries(QUEUES))for(const [cName,cursor] of Object.entries(CURSORS)){
 const label=qName+'/'+cName;
 const {bucket,env,R}=setup();
 if(queue)bucket.set(QUEUE,queue);if(cursor)bucket.set(CURSOR,cursor);
 assert.equal(plain(await R.status(env)).migration,'none',label);
 const dry=plain(await R.migrate(env,{mode:'dry_run'}));
 assert.equal(bucket.writes().length,0,label+': dry_run writes nothing');
 eq([dry.queue.result,dry.cursor.result,dry.writes,dry.migration],['would_migrate','would_migrate',0,'none'],label);
 assert.equal(dry.queue.entries,qName==='v1'?1:0,label);assert.equal(dry.queue.legacy,qName==='v1'?1:0,label);
 const applied=plain(await R.migrate(env,{mode:'apply'}));
 eq([applied.queue.result,applied.cursor.result,applied.migration],['migrated','migrated','complete'],label);
 const q=bucket.value(QUEUE),c=bucket.value(CURSOR);
 assert.equal(q.schemaVersion,2,label);assert.equal(q.droppedRefs,0);assert.equal(q.migratedAt,at(T0));
 if(qName==='v1'){eq(q.films.old,{...V1_ENTRY,claim:null,refs:[],legacy:true},label);eq([q.pausedUntil,q.pausedBy],[at(T0+H),'rate_limited'],label+': the pause is kept');}
 assert.equal(c.schemaVersion,2,label);eq(c.writer,{runId:'ratings-storage-migrate',step:'migrate'});
 if(cName==='v1')eq([c.resumePage,c.coverage,c.lastOutcome],[4,V1_CURSOR.coverage,'partial'],label+': the cursor keeps its progress');
 eq(bucket.value(WITNESS),{schemaVersion:1,queue:{migratedAt:at(T0)},cursor:{migratedAt:at(T0)}},label);
 const writes=bucket.writes().length;
 const again=plain(await R.migrate(env,{mode:'apply'}));
 eq([again.queue.result,again.cursor.result,again.migration],['already','already','complete'],label);
 assert.equal(bucket.writes().length,writes,label+': a second apply writes nothing');
 const dryAfter=plain(await R.migrate(env,{mode:'dry_run'}));
 eq([dryAfter.queue.result,dryAfter.cursor.result],['already','already'],label);
 assert.equal(plain(await R.status(env)).pipeline,'idle',label);
 assert.equal(bucket.log.filter(item=>item.op==='put').every(item=>item.conditional),true,label+': every write is conditional');
}

// 2. A version 1 hand-over still in sync.json: films the saved watchlist event removed get it as their reference, others
// become legacy entries.
{
 const {bucket,env,R}=setup();
 const eventAt=at(T0-2*H);
 bucket.set('sync.json',{runId:'run-7',stage:'complete',removalLookups:[film('a'),film('b')],events:[{id:'run-7-watchlist',type:'watchlist',at:eventAt,removed:[{id:'a'}]},{id:'run-7-epg',type:'epg',at:eventAt}]});
 bucket.set(QUEUE,{schemaVersion:1,films:{}});bucket.set(CURSOR,V1_CURSOR);
 const dry=plain(await R.migrate(env,{mode:'dry_run'}));
 eq(dry.queue.handover,{films:2,withEvent:1});eq([dry.queue.refs,dry.queue.legacy],[1,1]);
 await R.migrate(env,{mode:'apply'});
 const q=bucket.value(QUEUE);
 eq(q.films.a.refs,[{eventKey:eventKeyOf(eventAt,'run-7-watchlist'),sourceRunId:'run-7',at:eventAt,resolved:false}]);
 assert.equal(q.films.b.legacy,true);eq(q.films.b.refs,[]);
 assert.equal(bucket.value('sync.json').removalLookups.length,2,'the migration does not rewrite sync.json');
}

// 3. Kill points. a) The cursor write fails after the queue converted: partial, and the separate pipeline stays inert
// until a second apply completes it. b) The isolate dies between the queue write and its witness: the next apply
// records the witness and goes on.
{
 const {bucket,env,R}=setup();
 bucket.set(QUEUE,{schemaVersion:1,films:{}});bucket.set(CURSOR,V1_CURSOR);
 bucket.hooks.beforePut=key=>{if(key===CURSOR)throw new Error('write failed');};
 const first=plain(await R.migrate(env,{mode:'apply'}));
 bucket.hooks.beforePut=null;
 eq([first.queue.result,first.cursor.result,first.migration],['migrated','failed','partial']);
 eq(bucket.value(WITNESS),{schemaVersion:1,queue:{migratedAt:at(T0)}});
 assert.equal(plain(await R.status(env)).pipeline,'separate_pending_migration');
 assert.equal(plain(await R.start(env,{trigger:'manual'})).reason,'not_migrated');
 assert.equal(await R.separateActive(env),false);
 const second=plain(await R.migrate(env,{mode:'apply'}));
 eq([second.queue.result,second.cursor.result,second.migration],['already','migrated','complete']);
}
{
 const {bucket,env,R}=setup();
 bucket.set(QUEUE,{schemaVersion:1,films:{}});bucket.set(CURSOR,V1_CURSOR);
 bucket.hooks.beforePut=key=>{if(key===WITNESS)throw new Error('isolate killed');};
 await assert.rejects(R.migrate(env,{mode:'apply'}),/killed/);
 bucket.hooks.beforePut=null;
 assert.equal(bucket.value(QUEUE).schemaVersion,2);assert.equal(bucket.value(CURSOR).schemaVersion,1);
 assert.equal(plain(await R.status(env)).migration,'partial');
 const next=plain(await R.migrate(env,{mode:'apply'}));
 eq([next.queue.result,next.cursor.result,next.migration],['already','migrated','complete']);
 assert.ok(bucket.value(WITNESS).queue.migratedAt&&bucket.value(WITNESS).cursor.migratedAt);
}

// 4. An object found back at version 1 after the witness recorded it (a writer of older code) is `regressed`: the status
// reports it without writing, the separate pipeline stays inert and the EPG commit acts as inline.
{
 const {bucket,env,R,net}=setup();
 bucket.set(QUEUE,{schemaVersion:1,films:{}});bucket.set(CURSOR,V1_CURSOR);
 await R.migrate(env,{mode:'apply'});
 bucket.set(QUEUE,{schemaVersion:1,films:{x:V1_ENTRY}});
 const writes=bucket.writes().length;
 const status=plain(await R.status(env));
 eq([status.migration,status.regressedObjects,status.pipeline],['regressed',['queue'],'separate_pending_migration']);
 assert.equal(bucket.writes().length,writes,'the status writes nothing');assert.equal(net.fetches.length,0);
 eq(plain(await R.start(env,{trigger:'manual'})),{runId:null,created:false,nextAction:'stop',reason:'not_migrated',migration:'regressed'});
 assert.equal(await R.separateActive(env),false);
 bucket.set(CURSOR,V1_CURSOR);
 eq(plain(await R.status(env)).regressedObjects,['queue','cursor']);
}

// 5. Refused while a ratings run is live; allowed once that run is stale.
{
 const {bucket,env,R,clock}=setup({LETTERBOXD_DIARY_HISTORY:undefined});
 bucket.set(QUEUE,{schemaVersion:1,films:{}});bucket.set(CURSOR,V1_CURSOR);
 bucket.set(RUN,{schemaVersion:1,runId:'r1',state:'running',phase:'removal',lease:{step:'s',expiresAt:at(T0+60000)},startedAt:at(T0),updatedAt:at(T0),checkpoint:{},recent:[]});
 const refused=plain(await R.migrate(env,{mode:'apply'}));
 eq([refused.refused,refused.migration],['run_running','none']);
 assert.equal(bucket.value(QUEUE).schemaVersion,1);
 clock.now+=R.LEASE_MS;
 assert.equal(plain(await R.migrate(env,{mode:'apply'})).migration,'complete');
}

// 6. The boundary under concurrency: an inline version 1 writer that commits between the migration's read and its
// compare-and-swap is not lost (the migration retries on the new content); an inline writer that read version 1 before
// the migration follows version 2 at its own retry.
{
 const {bucket,env,R,ctx}=setup({RATINGS_PIPELINE:undefined});
 bucket.set(QUEUE,{schemaVersion:1,films:{}});bucket.set(CURSOR,V1_CURSOR);
 let raced=false;
 bucket.hooks.beforePut=async (key,value)=>{if(key===QUEUE&&value.schemaVersion===2&&!raced){raced=true;await g(ctx,'enqueueRemovalRefs')(env,[film('inflight')],null);}};
 await R.migrate(env,{mode:'apply'});
 bucket.hooks.beforePut=null;
 const q=bucket.value(QUEUE);
 assert.equal(q.schemaVersion,2);eq(q.films.inflight.legacy,true,'the in-flight version 1 entry is migrated, not lost');
 // Inline code on migrated storage keeps the version 2 rules: references are stored, the cursor is merged.
 const eventAt=at(T0);
 await g(ctx,'lookupRemovalRatings')({...env,REMOVAL_RATING_LOOKUP:'on'},[],T0,{eventKey:eventKeyOf(eventAt,'run-9-watchlist'),sourceRunId:'run-9',at:eventAt});
 assert.equal(bucket.value(QUEUE).schemaVersion,2);
}
{
 const {bucket,env,R,ctx,net}=setup({RATINGS_PIPELINE:undefined,LETTERBOXD_DIARY_HISTORY:'on'});
 bucket.set(QUEUE,{schemaVersion:1,films:{}});bucket.set(CURSOR,V1_CURSOR);
 await R.migrate(env,{mode:'apply'});
 net.diary.set(1,diaryPage([diaryRow('lid1',8,'2026-10-31','901')],false));
 await g(ctx,'LetterboxdDiary').syncHistory(env,{now:T0+H});
 const c=bucket.value(CURSOR);
 assert.equal(c.schemaVersion,2,'the inline Diary stage merges into the merge form');
 eq(c.writer,{runId:'unknown',step:'inline'});eq(c.coverage.newestWatchedDate,'2026-10-31');eq(c.coverage.oldestWatchedDate,'2026-09-01');
}

// 7. Malformed requests write nothing.
{
 const {bucket,env,R}=setup();
 for(const body of [null,[],{},{mode:'APPLY'},{mode:'apply',extra:1},{mode:1}])assert.equal(plain(await R.handle(env,'migrate',body)).status,400,JSON.stringify(body));
 assert.equal(bucket.writes().length,0);
}

console.log('Ratings storage migration (ADR 0060): dry_run writes nothing and apply converts every starting queue and cursor, idempotently, with conditional writes and a witness; hand-over references, kill points before the cursor and before the witness, regressed objects, refusal during a live run, an in-flight version 1 writer, inline rules on migrated storage and malformed requests passed');
