import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,migrated,QUEUE,SEPARATE,DAY,eventKeyOf,film,plain,g} from './ratings-harness.mjs';

// ADR 0070: a rated legacy entry is linked to existing removal events of the same film id, one event-list page per
// ratings step, then the stored rating is settled. A removal is not a viewing, and a rating is never invented.
const T0=Date.parse('2026-10-31T12:00:00.000Z');
const FIRST='2026-10-29T17:07:00.000Z',SECOND='2026-10-31T09:55:00.000Z';
const FILM='supergirl-2026',ALIAS='supergirl-2015';
const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
const ctx=loadContext({net,clock,FakeDate,crypto});
const fn=name=>vm.runInContext(name,ctx);
const env=baseEnv(bucket,{...SEPARATE,REMOVAL_RATING_LOOKUP:'off'});
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);
const at=ms=>new Date(ms).toISOString();
const lists=()=>bucket.log.filter(item=>item.op==='list'&&item.prefix==='events/items/').length;
const removal=(id,when,removed)=>({id,type:'watchlist',at:when,total:removed.length,baseline:false,added:[],removed});
const filmRow=(id,title,year,extra)=>({id,title,year,...extra});
const entry=(extra)=>({url:film(FILM).url,state:'rated',rating:4,lastResult:'diary',attempts:2,enqueuedAt:at(T0),checkedAt:FIRST,claim:null,refs:[],legacy:true,...extra});

function putEvent(id,when,removed){const event=removal(id,when,removed);bucket.set(eventKeyOf(when,id),event);return event;}
const ui=vm.createContext({Date,Intl,URL,Set,Map});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ui);
function eventHTML(event){ui.event=event;return vm.runInContext('eventHTML(event)',ui);}

// 1. No rated legacy entry: the removal phase does not list events. A legacy entry without a confirmed half-star
// does not either, and neither does enqueue.
migrated(bucket);
putEvent('other',FIRST,[filmRow('other','Other',1999)]);
const idle=lists();
eq(await fn('linkLegacyRemovalRefs')(env,{now:T0}),{listed:0,linked:0,more:false,done:false,skipped:true,advanced:false,scanning:false});
assert.equal(lists(),idle,'no event list without a rated legacy entry');
bucket.set(QUEUE,{...bucket.value(QUEUE),films:{plain:{...entry(),state:'not_rated',rating:undefined,lastResult:'not_rated',legacy:true},bad:{...entry({rating:4.2}),legacy:true}}});
await fn('linkLegacyRemovalRefs')(env,{now:T0});
assert.equal(lists(),idle,'an unconfirmed rating is not a reason to list');
await fn('enqueueRemovalRefs')(env,[film('fresh')],{eventKey:eventKeyOf(SECOND,'fresh-watchlist'),sourceRunId:'run-fresh',at:SECOND},T0);
assert.equal(lists(),idle,'enqueue does not scan events');
assert.equal(net.fetches.length,0);

// 2. Two removals of one film, one confirmed diary rating. Both events receive it. A same-title different id does not.
// A rating already on an event is kept. A missing event is not invented.
bucket.set(QUEUE,{schemaVersion:2,films:{[FILM]:entry()},droppedRefs:0,migratedAt:at(T0)});
putEvent('remove-29',FIRST,[filmRow(FILM,'Supergirl',2026)]);
putEvent('remove-31',SECOND,[filmRow(FILM,'Supergirl',2026)]);
putEvent('alias-2015',at(T0-DAY),[filmRow(ALIAS,'Supergirl',2015)]);
putEvent('kept-rating',at(T0-2*DAY),[filmRow(FILM,'Supergirl',2026,{rating:5,ratingObservedAt:SECOND})]);
const goneKey=eventKeyOf(at(T0-3*DAY),'gone');
bucket.set(goneKey,removal('gone',at(T0-3*DAY),[filmRow(FILM,'Supergirl',2026)]));
let killed=false;
bucket.hooks.beforePut=key=>{if(!killed&&key===QUEUE){killed=true;throw new Error('killed before the cursor');}};
await assert.rejects(fn('linkLegacyRemovalRefs')(env,{limit:1,now:T0}),/killed before the cursor/);
bucket.hooks.beforePut=null;
assert.equal((bucket.value(QUEUE).films[FILM].refs||[]).length,0,'a killed page writes no reference');
assert.equal(bucket.value(QUEUE).films[FILM].state,'rated','the entry is not reopened');
const page=await fn('linkLegacyRemovalRefs')(env,{limit:1,now:T0});
assert.equal(page.more,true);assert.equal(page.linked,1);assert.equal(page.scanning,true);
const mid=bucket.value(QUEUE).films[FILM];
assert.equal(mid.legacy,true,'legacy stays until the scan finishes');
assert.equal(mid.state,'rated');assert.equal(mid.attempts,2);assert.equal(mid.rating,4);assert.equal(mid.lastResult,'diary');assert.equal(mid.claim,null);
assert.equal(mid.refs.length,1);assert.equal(mid.refs[0].resolved,false);
const again=await fn('linkLegacyRemovalRefs')(env,{limit:1,now:T0});
assert.equal(again.linked,0,'the interrupted page is not applied twice');
assert.equal(bucket.value(QUEUE).films[FILM].refs.length,1);
const rest=await fn('linkLegacyRemovalRefs')(env,{limit:20,now:T0});
assert.equal(rest.done,true);assert.equal(rest.more,false);
const linked=bucket.value(QUEUE).films[FILM];
assert.equal(linked.legacy,undefined,'a match drops legacy once the scan is done');
assert.equal(linked.legacyLink.done,true);
assert.equal(linked.state,'rated');assert.equal(linked.attempts,2);assert.equal(linked.rating,4);
const keys=linked.refs.map(ref=>ref.eventKey).sort();
assert.deepEqual(keys,[eventKeyOf(FIRST,'remove-29'),eventKeyOf(SECOND,'remove-31'),eventKeyOf(at(T0-2*DAY),'kept-rating'),goneKey].sort());
assert.ok(linked.refs.every(ref=>ref.resolved===false));
assert.equal(lists()>0,true);
const listed=lists();
eq(await fn('linkLegacyRemovalRefs')(env,{now:T0}),{listed:0,linked:0,more:false,done:false,skipped:true,advanced:false,scanning:false},'a finished scan does not list again');
assert.equal(lists(),listed);
bucket.records.delete(goneKey);bucket.etags.delete(goneKey);
const settled=await fn('settleRemovalRefs')(env,{now:T0});
assert.equal(settled.resolved,3);assert.equal(settled.waiting,1);assert.equal(settled.mismatched,0);
assert.equal(bucket.records.has(goneKey),false,'a missing event is not created');
assert.equal(bucket.value(QUEUE).films[FILM].refs.find(ref=>ref.eventKey===goneKey).issue,'event_missing');
for(const eventId of ['remove-29','remove-31']){
 const stored=bucket.value(eventKeyOf(eventId==='remove-29'?FIRST:SECOND,eventId));
 assert.equal(stored.removed[0].rating,4);
 const html=eventHTML(stored);
 assert.match(html,/Вероятно просмотрены · 1/);
 assert.match(html,/Supergirl \(2026\) · 4\.0 ★/);
 assert.doesNotMatch(html,/Остальные удаления/);
}
assert.equal(bucket.value(eventKeyOf(at(T0-2*DAY),'kept-rating')).removed[0].rating,5,'a newer confirmed rating already on the event stays');
assert.equal(bucket.value(eventKeyOf(at(T0-DAY),'alias-2015')).removed[0].rating,undefined,'a different film id is not the same film');
assert.equal(linked.refs.some(ref=>ref.eventKey===eventKeyOf(at(T0-DAY),'alias-2015')),false);
assert.equal(net.fetches.length,0,'linking requests nothing');

// 3. A ratings step with nothing to link does not list. One with a rated legacy entry walks a page per step, settles,
// and a later run does not walk again. Retention does not delete the entry while the scan is unfinished.
{
 const {clock:runClock,FakeDate:RunDate,crypto:runCrypto}=makeClock(T0),runNet=makeNetwork(),runBucket=makeBucket();
 const runCtx=loadContext({net:runNet,clock:runClock,FakeDate:RunDate,crypto:runCrypto});
 const runEnv=baseEnv(runBucket,{...SEPARATE,LETTERBOXD_DIARY_HISTORY:undefined,REMOVAL_RATING_LOOKUP:'off'});
 const R=g(runCtx,'LetterboxdRatings');
 const runLists=()=>runBucket.log.filter(item=>item.op==='list'&&item.prefix==='events/items/').length;
 migrated(runBucket,{films:{idle:{url:film('idle').url,state:'pending',attempts:0,enqueuedAt:at(T0),nextAttemptAt:at(T0+DAY),claim:null,refs:[{eventKey:eventKeyOf(FIRST,'idle'),sourceRunId:'run',at:FIRST,resolved:false}]}}});
 const quiet=plain(await R.start(runEnv,{trigger:'manual'}));
 const quietStep=plain(await R.step(runEnv,{runId:quiet.runId}));
 assert.equal(quietStep.reason,'finished');assert.equal(runLists(),0,'an ordinary removal step lists no events');
 const films={[FILM]:{url:film(FILM).url,state:'rated',rating:4,lastResult:'diary',attempts:2,enqueuedAt:at(T0-20*DAY),checkedAt:FIRST,claim:null,refs:[],legacy:true}};
 runBucket.set(QUEUE,{schemaVersion:2,films,droppedRefs:0,migratedAt:at(T0)});
 for(let n=0;n<20;n++){const when=at(T0+(40-n)*3600000);runBucket.set(eventKeyOf(when,'noise-'+n),removal('noise-'+n,when,[filmRow('noise-'+n,'Noise',2000)]));}
 runBucket.set(eventKeyOf(SECOND,'remove-31'),removal('remove-31',SECOND,[filmRow(FILM,'Supergirl',2026)]));
 runBucket.set(eventKeyOf(FIRST,'remove-29'),removal('remove-29',FIRST,[filmRow(FILM,'Supergirl',2026)]));
 const started=plain(await R.start(runEnv,{trigger:'manual'}));
 const firstStep=plain(await R.step(runEnv,{runId:started.runId}));
 assert.equal(firstStep.nextAction,'continue');assert.equal(firstStep.summary.removal.lookup.stoppedBy,'legacy_link');
 assert.equal(runLists(),1);
 assert.equal(runBucket.value(eventKeyOf(SECOND,'remove-31')).removed[0].rating,undefined,'the first page is noise and does not rate the film');
 const scanning=runBucket.value(QUEUE).films[FILM];
 assert.ok(scanning,'an old unmatched legacy entry is not pruned mid-scan');
 assert.equal(scanning.legacy,true);assert.equal(scanning.state,'rated');assert.equal(scanning.refs.length,0);assert.equal(scanning.attempts,2);
 assert.equal(runBucket.value('letterboxd/ratings/run.json').checkpoint.legacyPagesLinked,1);
 const queued=runBucket.value(QUEUE);queued.films[FILM].enqueuedAt=at(T0);runBucket.set(QUEUE,queued);
 const secondStep=plain(await R.step(runEnv,{runId:started.runId}));
 assert.equal(secondStep.nextAction,'stop');assert.equal(secondStep.reason,'finished');
 assert.equal(runLists(),2);
 assert.equal(runBucket.value(eventKeyOf(SECOND,'remove-31')).removed[0].rating,4);
 assert.equal(runBucket.value(eventKeyOf(FIRST,'remove-29')).removed[0].rating,4);
 const done=runBucket.value(QUEUE).films[FILM];
 assert.equal(done.legacy,undefined);assert.equal(done.state,'rated');assert.equal(done.attempts,2);assert.equal(done.rating,4);
 assert.ok(done.refs.every(ref=>ref.resolved===true));
 assert.equal(runBucket.value('letterboxd/ratings/run.json').checkpoint.legacyPagesLinked,2);
 assert.equal(runNet.fetches.length,0);
 const later=plain(await R.start(runEnv,{trigger:'manual'}));
 assert.equal(plain(await R.step(runEnv,{runId:later.runId})).reason,'finished');
 assert.equal(runLists(),2,'a later run does not scan events again');
}

console.log('Ratings legacy link: two removals, alias, kept rating, missing event, killed page, no list without a confirmed rating, and a checkpointed ratings step passed');
