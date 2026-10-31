import assert from 'node:assert/strict';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,CURSOR,plain,seeded,g} from './ratings-harness.mjs';

// ADR 0060 decision 6: the Diary cursor's merge form. The progress part is a join, the diagnostic part one record chosen
// last-writer-wins by (lastAttemptAt, writer.runId, writer.step, content); serialization is canonical.
const T0=Date.parse('2026-10-31T08:00:00.000Z');
const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
const ctx=loadContext({net,clock,FakeDate,crypto});
const D=g(ctx,'LetterboxdDiary'),env=baseEnv(bucket);
const bytes=value=>JSON.stringify(value);
const random=seeded(294);
const pick=list=>list[Math.floor(random()*list.length)];
const DATES=[null,'2019-01-01','2021-06-15','2024-02-29','2026-10-30'];
const TIMES=[null,'2026-10-31T07:00:00.000Z','2026-10-31T08:00:00.000Z','2026-10-31T09:00:00.000Z'];
function state(){
 const newest=pick(DATES),oldest=pick(DATES);
 return {schemaVersion:2,coverage:{newestWatchedDate:newest,oldestWatchedDate:oldest,reachedEnd:random()<.3},resumePage:pick([null,2,3,4,7,12]),
  lastAttemptAt:pick(TIMES),lastSuccessAt:pick(TIMES),lastFailureAt:pick(TIMES),lastOutcome:pick(['partial','complete','failed','blocked',null]),stopReason:pick([null,'page_budget','overlap','step_budget']),
  counts:random()<.2?null:{pages:Math.floor(random()*4),rows:Math.floor(random()*120)},writer:{runId:pick(['run-a','run-b','ratings-storage-migrate']),step:pick(['s1','s2','inline'])}};
}
const merge=(a,b)=>D.mergeCursor(a,b);

// 1. Commutative, associative, idempotent, byte for byte, over 3000 random triples.
for(let i=0;i<3000;i++){
 const a=state(),b=state(),c=state();
 assert.equal(bytes(merge(a,b)),bytes(merge(b,a)),'commutative');
 assert.equal(bytes(merge(merge(a,b),c)),bytes(merge(a,merge(b,c))),'associative');
 const ab=merge(a,b);
 assert.equal(bytes(merge(ab,ab)),bytes(ab),'idempotent');
 assert.equal(bytes(merge(ab,b)),bytes(ab),'absorbs a merged writer');
 // The join never moves progress back.
 const later=(x,y)=>x==null?y:y==null?x:x>y?x:y,earlier=(x,y)=>x==null?y:y==null?x:x<y?x:y;
 assert.equal(ab.coverage.newestWatchedDate,later(a.coverage.newestWatchedDate,b.coverage.newestWatchedDate));
 assert.equal(ab.coverage.oldestWatchedDate,earlier(a.coverage.oldestWatchedDate,b.coverage.oldestWatchedDate));
 assert.equal(ab.coverage.reachedEnd,a.coverage.reachedEnd||b.coverage.reachedEnd);
 if(ab.coverage.reachedEnd)assert.equal(ab.resumePage,null,'no resume point once the end is reached');
 else if(a.resumePage!=null||b.resumePage!=null)assert.equal(ab.resumePage,Math.max(a.resumePage??2,b.resumePage??2));
 assert.equal(ab.lastAttemptAt,later(a.lastAttemptAt,b.lastAttemptAt));
 assert.equal(ab.schemaVersion,2);
}

// 2. Last writer wins deterministically: any order of the same writers yields the same bytes and the winner's record.
for(let i=0;i<500;i++){
 const writers=Array.from({length:5},state),order=[...writers].sort(()=>random()-.5);
 const forward=writers.reduce(merge),shuffled=order.reduce(merge);
 assert.equal(bytes(forward),bytes(shuffled),'order does not matter');
 const key=s=>[String(s.lastAttemptAt||''),s.writer.runId,s.writer.step,JSON.stringify(Object.fromEntries(Object.entries({counts:s.counts,lastOutcome:s.lastOutcome,stopReason:s.stopReason}).sort()))];
 const winner=[...writers].sort((x,y)=>{const a=key(x),b=key(y);for(let n=0;n<a.length;n++){if(a[n]<b[n])return -1;if(a[n]>b[n])return 1;}return 0;}).at(-1);
 assert.deepEqual(plain({o:forward.lastOutcome,s:forward.stopReason,c:forward.counts,w:forward.writer}),plain({o:winner.lastOutcome,s:winner.stopReason,c:winner.counts,w:winner.writer}));
}

// 3. A tie on lastAttemptAt is broken by the writer, then by the content, never by arrival order.
const tie={...state(),lastAttemptAt:TIMES[2],writer:{runId:'run-a',step:'s1'},lastOutcome:'partial'};
const other={...tie,writer:{runId:'run-b',step:'s1'},lastOutcome:'failed'};
assert.equal(merge(tie,other).lastOutcome,'failed');assert.equal(merge(other,tie).lastOutcome,'failed');
const sameWriter={...tie,lastOutcome:'complete'};
assert.equal(bytes(merge(tie,sameWriter)),bytes(merge(sameWriter,tie)));

// 4. Migration keeps progress and diagnostics and adds the writer; canonical key order.
const v1={schemaVersion:1,lastAttemptAt:TIMES[1],lastSuccessAt:TIMES[1],lastFailureAt:null,lastOutcome:'partial',stopReason:'page_budget',counts:{pages:3},coverage:{newestWatchedDate:'2026-10-30',oldestWatchedDate:'2026-01-01',reachedEnd:false},resumePage:4};
const migrated=D.migrateCursor(v1,{runId:'ratings-storage-migrate',step:'migrate'});
assert.equal(D.cursorMigrated(migrated),true);assert.equal(D.cursorMigrated(v1),false);
assert.deepEqual(plain({...migrated,schemaVersion:1,writer:undefined}),plain(v1));
assert.deepEqual(Object.keys(migrated),[...Object.keys(migrated)].sort());

// 5. Concurrent writers on the stored cursor: every write is a compare-and-swap that follows the version it finds.
// a) A version 1 cursor read before a migration: the stale write loses, re-reads the merge form and merges into it.
bucket.set(CURSOR,v1);
let interleaved=false;
bucket.hooks.beforePut=key=>{if(key===CURSOR&&!interleaved){interleaved=true;bucket.set(CURSOR,D.migrateCursor(bucket.value(CURSOR),{runId:'ratings-storage-migrate',step:'migrate'}));}};
await D.syncHistory({...env,LETTERBOXD_DIARY_HISTORY:'on'},{now:T0,maxPages:0});
bucket.hooks.beforePut=null;
assert.equal(bucket.value(CURSOR).schemaVersion,2,'a version 1 writer never turns the merge form back');
assert.equal(bucket.value(CURSOR).resumePage,4,'progress survives');
// b) Random interleavings of merge writers converge to the fold of their states.
for(let round=0;round<50;round++){
 const start=state(),writers=Array.from({length:4},state);
 bucket.set(CURSOR,start);
 let pending=[...writers].sort(()=>random()-.5);
 // Each writer reads, then a random other writer may commit in between, then the writer commits.
 const reads=new Map();
 for(const w of pending)reads.set(w,await D.readCursor(env));
 for(const w of pending)await (async()=>{let read=reads.get(w);for(let attempt=0;attempt<10;attempt++){const next=D.mergeCursor(read.state,w);if(await D.putCursor(env,read.object,next)!==null)return;read=await D.readCursor(env);}throw new Error('no progress');})();
 assert.equal(bytes(bucket.value(CURSOR)),bytes([start,...writers].reduce(merge)),'converges to the join');
}
// c) A per-page checkpoint writes nothing on a version 1 cursor (inline keeps one final write).
bucket.set(CURSOR,v1);const before=bucket.writes().length;
net.diary.set(1,'<table><tr class="diary-entry-row"><td><a href="/demo-user/diary/films/for/2026/10/30/">30</a></td><td><div data-postered-identifier="{&quot;lid&quot;:&quot;aa&quot;}"></div></td><td></td></tr></table>');
await D.syncHistory({...env,LETTERBOXD_DIARY_HISTORY:'on'},{now:T0,maxPages:1,progressWrites:true});
assert.equal(bucket.writes().slice(before).filter(item=>item.key===CURSOR).length,1,'one final write on version 1');
assert.equal(bucket.value(CURSOR).schemaVersion,1);

console.log('Ratings cursor merge (ADR 0060): join and last-writer-wins are commutative, associative and idempotent over 3000 random triples, order-free over 500 shuffles, ties broken by writer and content, migration keeps progress, a version 1 writer loses to the migration, random interleavings converge, and a version 1 cursor keeps one final write passed');
