import vm from 'node:vm';
import assert from 'node:assert/strict';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,QUEUE,H,DAY,eventKeyOf,film,plain} from './ratings-harness.mjs';

// ADR 0060 decision 3: the version 2 removal queue. One lookup per film, one reference per removal event.
const T0=Date.parse('2026-10-31T08:00:00.000Z');
const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
const ctx=loadContext({net,clock,FakeDate,crypto});
const fn=name=>vm.runInContext(name,ctx);
const env=baseEnv(bucket);
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);
const at=ms=>new Date(ms).toISOString();
const ref=(n,ms=T0)=>({eventKey:eventKeyOf(at(ms),'run-'+n+'-watchlist'),sourceRunId:'run-'+n,at:at(ms)});
const v2=(films={})=>({schemaVersion:2,films,droppedRefs:0,migratedAt:at(T0)});
const enqueue=(queue,films,reference,ms=T0)=>fn('applyRemovalEnqueue')(queue,films,reference,at(ms));

// 1. Idempotent enqueue: the same event twice is one reference; a malformed reference is a legacy entry.
let q=v2();
assert.equal(enqueue(q,[film('a')],ref(1)),true);
assert.equal(enqueue(q,[film('a')],ref(1)),false,'a replay of the same event adds nothing');
eq(plain(q.films.a.refs),[{...ref(1),resolved:false}]);
assert.equal(q.films.a.claim,null);
assert.equal(enqueue(q,[film('b')],{eventKey:'sync.json'}),true);
assert.equal(q.films.b.legacy,true,'a reference that names no event key gives a legacy entry');
eq(plain(q.films.b.refs),[]);
assert.equal(enqueue(q,[film('b')],ref(2)),true);
assert.equal(q.films.b.legacy,undefined,'a real reference ends the legacy mark');

// 2. Remove, re-add, remove, from every entry state. A re-add touches nothing; the second removal adds its reference and
// reopens a finished entry (pending, no attempts, a fresh enqueuedAt, no claim); a pending entry keeps its attempts.
for(const state of ['pending','rated','not_rated','gave_up','expired','not_found','conflict']){
 q=v2();enqueue(q,[film('x')],ref(1));
 q.films.x={...q.films.x,state,attempts:2,lastResult:state==='rated'?'saved':state,rating:state==='rated'?4:undefined,claim:state==='pending'?{token:'t',at:at(T0)}:null,refs:[{...ref(1),resolved:state==='rated'}]};
 const before=plain(q);
 // A re-add is a watchlist addition: no removal event, no queue write.
 eq(plain(q),before,state+': re-add');
 assert.equal(enqueue(q,[film('x')],ref(3,T0+H),T0+H),true,state+': second removal');
 const entry=q.films.x;
 eq(entry.refs.map(item=>item.eventKey),[ref(1).eventKey,ref(3,T0+H).eventKey],state);
 if(state==='pending'){assert.equal(entry.attempts,2,'a pending entry keeps its attempts');assert.equal(entry.enqueuedAt,at(T0));}
 else eq([entry.state,entry.attempts,entry.enqueuedAt,entry.nextAttemptAt,entry.claim],['pending',0,at(T0+H),at(T0+H),null],state+': reopened');
 assert.equal(enqueue(q,[film('x')],ref(3,T0+H),T0+2*H),false,state+': replay of the second removal');
}

// 3. The 21st reference drops the oldest resolved one, or the oldest unresolved one when none is resolved.
q=v2();
for(let n=0;n<20;n++)enqueue(q,[film('y')],ref(n,T0+n*H));
q.films.y.refs[5].resolved=true;q.films.y.refs[9].resolved=true;
enqueue(q,[film('y')],ref(20,T0+20*H));
assert.equal(q.films.y.refs.length,20);
assert.equal(q.droppedRefs,1);
assert.ok(!q.films.y.refs.some(item=>item.eventKey===ref(5,T0+5*H).eventKey),'the oldest resolved reference is dropped');
assert.ok(q.films.y.refs.some(item=>item.eventKey===ref(9,T0+9*H).eventKey));
q=v2();for(let n=0;n<21;n++)enqueue(q,[film('z')],ref(n,T0+n*H));
assert.equal(q.films.z.refs.length,20);assert.equal(q.droppedRefs,1);
assert.equal(q.films.z.refs[0].eventKey,ref(1,T0+H).eventKey,'without a resolved one, the oldest unresolved reference is dropped');

// 4. Retention: an entry with an unresolved reference is never deleted, by age or by the cap; a pending one still expires.
const prune=fn('pruneRemovalQueue');
q=v2();
const old=T0-30*DAY;
q.films.pendingOld={url:film('p').url,state:'pending',attempts:1,enqueuedAt:at(old),nextAttemptAt:at(old),claim:null,refs:[{...ref(1,old),resolved:false}]};
q.films.ratedUnresolved={url:film('r').url,state:'rated',rating:4,attempts:1,enqueuedAt:at(old),claim:null,refs:[{...ref(2,old),resolved:false}]};
q.films.expiredUnresolved={url:film('e').url,state:'expired',attempts:1,enqueuedAt:at(T0-60*DAY),claim:null,refs:[{...ref(3,old),resolved:false}]};
q.films.ratedDone={url:film('d').url,state:'rated',rating:4,attempts:1,enqueuedAt:at(T0-15*DAY),claim:null,refs:[{...ref(4,old),resolved:true}]};
q.films.legacyOld={url:film('l').url,state:'not_rated',attempts:3,enqueuedAt:at(T0-15*DAY),claim:null,refs:[],legacy:true};
assert.equal(prune(q,T0),true);
assert.equal(q.films.pendingOld.state,'expired','a pending entry past 14 days expires');
assert.ok(q.films.pendingOld&&q.films.ratedUnresolved&&q.films.expiredUnresolved,'unresolved entries survive past 28 days');
assert.equal(q.films.ratedDone,undefined,'a resolved entry follows the 14-day retention');
assert.equal(q.films.legacyOld,undefined,'a legacy entry follows the version 1 rules');
q=v2();
for(let n=0;n<130;n++)q.films['f'+n]={url:film('f'+n).url,state:'rated',rating:3,attempts:1,enqueuedAt:at(T0-n*60000),claim:null,refs:[{...ref(n,T0),resolved:n>=10}]};
prune(q,T0);
assert.equal(Object.keys(q.films).length,110,'the cap of 100 applies to the resolved entries only');
for(let n=0;n<10;n++)assert.ok(q.films['f'+n],'unresolved f'+n+' is kept past the cap');

// 5. Version 1 is untouched: an absent id is queued with the version 1 shape, a present id is left alone.
const v1={schemaVersion:1,films:{}};
assert.equal(enqueue(v1,[film('a')],ref(1)),true);
eq(plain(v1.films.a),{url:film('a').url,state:'pending',attempts:0,enqueuedAt:at(T0),nextAttemptAt:at(T0),lastAttemptAt:null,lastResult:null});
assert.equal(enqueue(v1,[film('a')],ref(2)),false);

// 6. Claim tokens: a late outcome after a reopen is refused, and its attempt stays counted.
q=v2();enqueue(q,[film('c')],ref(1));
assert.equal(fn('claimRemovalEntry')(q,'c',T0,at(T0),'token-1'),true);
assert.equal(fn('removalClaimHeld')(q,'c',at(T0),'token-1'),true);
assert.equal(fn('removalClaimHeld')(q,'c',at(T0),'token-2'),false);
q.films.c={...q.films.c,state:'rated',rating:4,claim:null};
enqueue(q,[film('c')],ref(2,T0+H),T0+H);
assert.equal(fn('applyRemovalOutcome')(q,'c',{status:'saved',rating:5},null,at(T0),T0,'token-1'),false,'a reopened entry refuses the earlier claim');
assert.equal(q.films.c.state,'pending');
q=v2();enqueue(q,[film('m')],ref(1));
for(let n=0;n<3;n++){q.films.m.nextAttemptAt=at(T0);assert.equal(fn('claimRemovalEntry')(q,'m',T0,at(T0),'t'+n),true);fn('applyRemovalOutcome')(q,'m',null,'Rating lookup failed: x',at(T0),T0,'t'+n);}
q.films.m.state='pending';q.films.m.nextAttemptAt=at(T0);
assert.equal(fn('claimRemovalEntry')(q,'m',T0,at(T0),'t3'),false,'at most three attempts per film');

// 7. Settling a rated entry: every unresolved event gets the rating through writeEvent, then its reference is resolved.
// A kill between the event write and `resolved` repeats an idempotent event write; a missing event waits.
const removalEvent=(n,ms,ids)=>({id:'run-'+n+'-watchlist',type:'watchlist',at:at(ms),total:1,baseline:false,added:[],removed:ids.map(id=>({id,title:id,year:2000}))});
await ctx.writeEvent(env,removalEvent(1,T0,['s']));
await ctx.writeEvent(env,removalEvent(2,T0+H,['s','other']));
bucket.set(QUEUE,v2({s:{url:film('s').url,state:'rated',rating:3.5,checkedAt:at(T0+2*H),attempts:1,enqueuedAt:at(T0),claim:null,refs:[{...ref(1),resolved:false},{...ref(2,T0+H),resolved:false},{...ref(7,T0+3*H),resolved:false}]}}));
let killed=0,eventWritten=false;
bucket.hooks.beforePut=key=>{if(key.startsWith('events/items/'))eventWritten=true;else if(key===QUEUE&&eventWritten&&!killed++)throw new Error('killed after the event write');};
await assert.rejects(fn('settleRemovalRefs')(env,{}),/killed/);
bucket.hooks.beforePut=null;
assert.ok([T0,T0+H].some(ms=>bucket.value(eventKeyOf(at(ms),'run-'+(ms===T0?1:2)+'-watchlist')).removed.find(item=>item.id==='s').rating===3.5),'an event was written before the kill');
assert.equal(bucket.value(QUEUE).films.s.refs.filter(item=>item.resolved).length,0,'the reference is not resolved yet');
const writesBefore=bucket.writes().filter(item=>item.key.startsWith('events/items/')).length;
const settled=await fn('settleRemovalRefs')(env,{});
eq(plain(settled),{written:1,resolved:2,waiting:1,mismatched:0,left:0});
assert.equal(bucket.writes().filter(item=>item.key.startsWith('events/items/')).length,writesBefore+1,'the event written before the kill is not written again; the other is written once');
assert.equal(bucket.value(eventKeyOf(at(T0),'run-1-watchlist')).removed[0].rating,3.5);
assert.equal(bucket.value(eventKeyOf(at(T0+H),'run-2-watchlist')).removed.find(item=>item.id==='s').rating,3.5);
assert.equal(bucket.value(eventKeyOf(at(T0+H),'run-2-watchlist')).removed.find(item=>item.id==='other').rating,undefined,'only the film of the entry is rated');
eq(bucket.value(QUEUE).films.s.refs.map(item=>item.resolved),[true,true,false],'the reference to an unwritten event waits');
eq(plain(await fn('settleRemovalRefs')(env,{})),{written:0,resolved:0,waiting:1,mismatched:0,left:0},'settling again is idempotent');
eq(bucket.value(QUEUE).films.s.refs.map(item=>item.issue??null),[null,null,'event_missing'],'the waiting reference says why');

// 7b. A reference is resolved only when its event lists the film as removed with a confirmed rating: an event that
// does not list the film keeps the reference unresolved, with the issue, and writes nothing.
await ctx.writeEvent(env,removalEvent(8,T0+4*H,['someone-else']));
bucket.set(QUEUE,v2({s:{url:film('s').url,state:'rated',rating:3.5,checkedAt:at(T0+2*H),attempts:1,enqueuedAt:at(T0),claim:null,refs:[{...ref(8,T0+4*H),resolved:false}]}}));
const eventWrites=bucket.writes().filter(item=>item.key.startsWith('events/items/')).length;
eq(plain(await fn('settleRemovalRefs')(env,{})),{written:0,resolved:0,waiting:0,mismatched:1,left:0});
eq([bucket.value(QUEUE).films.s.refs[0].resolved,bucket.value(QUEUE).films.s.refs[0].issue],[false,'film_not_in_event']);
assert.equal(bucket.writes().filter(item=>item.key.startsWith('events/items/')).length,eventWrites,'no event write');

// 8. A writer that read version 1 loses its compare-and-swap to the migration and follows version 2 on the retry.
bucket.set(QUEUE,{schemaVersion:1,films:{}});
let migratedOnce=false;
bucket.hooks.beforePut=key=>{if(key===QUEUE&&!migratedOnce){migratedOnce=true;bucket.set(QUEUE,fn('migrateRemovalQueue')(bucket.value(QUEUE),[],at(T0)));}};
await fn('enqueueRemovalRefs')(env,[film('late')],ref(9),T0);
bucket.hooks.beforePut=null;
assert.equal(bucket.value(QUEUE).schemaVersion,2,'the migration is not undone');
eq(bucket.value(QUEUE).films.late.refs.map(item=>item.eventKey),[ref(9).eventKey]);

console.log('Ratings queue v2 (ADR 0060): idempotent enqueue, remove/re-add/remove from every state, the 21st reference, retention past 28 days and past 100 entries, claim tokens and three attempts, settle with a kill between the event write and resolved, a waiting reference, and a version 1 writer that loses to the migration passed');
