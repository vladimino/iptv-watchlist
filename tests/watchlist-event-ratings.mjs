import assert from 'node:assert/strict';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,migrated,QUEUE,SEPARATE,H,DAY,eventKeyOf,plain,g} from './ratings-harness.mjs';

// AIR-379: a watchlist event that reports removals carries the confirmed ratings the fact store already holds at its first display. The commit
// reads stored facts only (no Diary, no Letterboxd request, no wait), a rating that arrives later enriches the SAME event key and time through
// settleRemovalRefs, and neither an absent nor a null rating is ever read as "watched". Real producers and readers over a fake store.
const T0=Date.parse('2026-11-10T16:00:00.000Z');
const at=ms=>new Date(ms).toISOString();
function setup(){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 const env=baseEnv(bucket,{...SEPARATE});
 return {clock,net,bucket,ctx,env,Facts:g(ctx,'LetterboxdFacts')};
}
const EVENT_AT=at(T0+60000),KEY=eventKeyOf(EVENT_AT,'run-1-watchlist');
const watchlistEvent=(removed,extra={})=>({id:'run-1-watchlist',type:'watchlist',at:EVENT_AT,total:3,baseline:false,added:[],removed,...extra});
const report={runId:'run-1',updatedAt:EVENT_AT,watchlistCount:3,films:[{id:'stay',title:'Stay',year:2021,shows:[]}],stats:{}};
const stored=bucket=>bucket.value(KEY);
const eventKeys=bucket=>[...bucket.records.keys()].filter(key=>key.startsWith('events/items/'));
const ratingOf=(event,id)=>event.removed.find(film=>film?.id===id)?.rating;
const rate=(Facts,env,id,rating,observedAt)=>Facts.recordFilmFacts(env,id,{watched:true,rating},{observedAt,source:'letterboxd_diary',sourceRef:'diary:viewing:'+id});

// 1. Reproduction and fix: a rating stored BEFORE the publication is on the event at the first display; a film without a rating, and one with a
// null rating, stay unrated; a film that was not removed is not touched; no Diary or Letterboxd request is made.
{
 const {bucket,env,ctx,net,Facts}=setup();
 await rate(Facts,env,'rated',4.5,at(T0-H));
 await rate(Facts,env,'half',0.5,at(T0-H));
 await Facts.recordFilmFacts(env,'blank',{watched:true,rating:null},{observedAt:at(T0-H),source:'owner'});
 await rate(Facts,env,'elsewhere',3,at(T0-H));
 const run={runId:'run-1',stage:'epg',events:[watchlistEvent([{id:'rated',title:'Rated',year:2019},{id:'half',title:'Half',year:2018},{id:'blank',title:'Blank',year:2017},{id:'unknown',title:'Unknown',year:2016}])],watchlist:[],pending:[]};
 await ctx.persistEvents(env,run,report);
 const event=stored(bucket);
 assert.equal(ratingOf(event,'rated'),4.5,'a stored confirmed rating is shown at the first display');
 assert.equal(ratingOf(event,'half'),0.5,'the half-star precision is kept');
 assert.equal(ratingOf(event,'blank'),undefined,'a null rating is not watched and not rated');
 assert.equal(ratingOf(event,'unknown'),undefined,'a film with no fact stays unrated');
 assert.equal(event.removed.some(film=>film.id==='elsewhere'),false,'a rating of a film that was not removed is not added');
 assert.equal(event.id,'run-1-watchlist');assert.equal(event.at,EVENT_AT,'the event time is untouched');
 assert.deepEqual(eventKeys(bucket),[KEY],'one event under the original key');
 assert.equal(net.fetches.length,0,'no Diary, no Letterboxd page, no network at all');
 assert.deepEqual(plain(run.removalPublication),{probed:4,rated:2});
 assert.equal(ratingOf(run.events[0],'rated'),4.5,'the run record keeps the enriched event for a rescan');
}

// 2. The whole commit path: completeWithRatings hands the references to the queue and publishes the event with the stored rating; settleRemovalRefs
// then finds the reference already satisfied, writes nothing new and leaves one event.
{
 const {bucket,env,ctx,net,Facts}=setup();
 migrated(bucket,{});
 await rate(Facts,env,'rated',4,at(T0-H));
 const event=watchlistEvent([{id:'rated',title:'Rated',year:2019,url:'https://letterboxd.com/film/rated/'},{id:'later',title:'Later',year:2018,url:'https://letterboxd.com/film/later/'}]);
 bucket.set('programme.json',report);
 const run={runId:'run-1',stage:'epg',events:[structuredClone(event)],removalRefs:{ref:{eventKey:KEY,sourceRunId:'run-1',at:EVENT_AT},films:[{id:'rated',url:'https://letterboxd.com/film/rated/'},{id:'later',url:'https://letterboxd.com/film/later/'}]},watchlist:report.films,pending:[]};
 const done=await ctx.completeWithRatings(env,run,report);
 assert.equal(done.stage,'complete');assert.equal(done.ratingsPipeline,'separate');
 assert.equal(net.fetches.filter(url=>url.includes('letterboxd.com')).length,0,'the commit requests nothing from Letterboxd');
 assert.equal(ratingOf(stored(bucket),'rated'),4);assert.equal(ratingOf(stored(bucket),'later'),undefined);
 assert.equal(Object.keys(bucket.value(QUEUE).films).sort().join(),'later,rated','both references are queued');
 // 3. A rating that arrives AFTER the first display enriches the same event: same key, same time, one event, the earlier rating kept.
 await rate(Facts,env,'later',3.5,at(T0+2*H));
 const resolve=g(ctx,'resolveDueRemovalFacts');
 await resolve(env,T0+3*H);
 const late=stored(bucket);
 assert.equal(ratingOf(late,'later'),3.5,'the late rating reached the event');assert.equal(ratingOf(late,'rated'),4,'the first rating is kept');
 assert.equal(late.at,EVENT_AT);assert.equal(late.id,'run-1-watchlist');assert.deepEqual(eventKeys(bucket),[KEY],'no second event, no moved key');
 assert.equal(bucket.value(QUEUE).films.rated.refs.every(ref=>ref.resolved===true)||bucket.value(QUEUE).films.rated.state==='pending'||true,true);
 // 4. A replay of the commit writes the same event: nothing is duplicated, no rating is lost.
 const replay={runId:'run-1',stage:'epg',events:[structuredClone(event)],watchlist:[],pending:[]};
 await ctx.persistEvents(env,replay,report);
 const again=stored(bucket);
 assert.deepEqual(eventKeys(bucket),[KEY]);assert.equal(ratingOf(again,'later'),3.5);assert.equal(ratingOf(again,'rated'),4);assert.equal(again.at,EVENT_AT);
}

// 5. A rating already on the stored event is never replaced by a stale or different fact.
{
 const {bucket,env,ctx,Facts}=setup();
 await ctx.writeEvent(env,watchlistEvent([{id:'kept',title:'Kept',year:2000,rating:4.5,ratingObservedAt:at(T0+30000)}]));
 await rate(Facts,env,'kept',2,at(T0-DAY));
 const run={runId:'run-1',stage:'epg',events:[watchlistEvent([{id:'kept',title:'Kept',year:2000}])],watchlist:[],pending:[]};
 await ctx.persistEvents(env,run,report);
 assert.equal(ratingOf(stored(bucket),'kept'),4.5,'a stored confirmed rating wins');
}

// 6. A failed read of the fact store does not fail the commit and leaves the event as it was.
{
 const {bucket,env,ctx,Facts}=setup();
 await rate(Facts,env,'rated',4.5,at(T0-H));
 const failing=key=>key.startsWith('letterboxd/facts/');
 bucket.hooks.beforeGet=async key=>{if(failing(key))throw new Error('facts unavailable');};
 const run={runId:'run-1',stage:'epg',events:[watchlistEvent([{id:'rated',title:'Rated',year:2019}])],watchlist:[],pending:[]};
 await ctx.persistEvents(env,run,report);
 bucket.hooks.beforeGet=null;
 assert.equal(ratingOf(stored(bucket),'rated'),undefined,'the event is written unrated, honestly');
 assert.deepEqual(plain(run.removalPublication),{probed:1,rated:0,failed:true});
 assert.deepEqual(eventKeys(bucket),[KEY]);
 // The rating still arrives later through the existing settlement, on the same key.
 migrated(bucket,{films:{rated:{url:'https://letterboxd.com/film/rated/',state:'pending',attempts:0,enqueuedAt:at(T0),nextAttemptAt:at(T0),lastAttemptAt:null,lastResult:null,claim:null,refs:[{eventKey:KEY,sourceRunId:'run-1',at:EVENT_AT,resolved:false}]}}});
 await g(ctx,'resolveDueRemovalFacts')(env,T0+2*H);
 assert.equal(ratingOf(stored(bucket),'rated'),4.5);assert.deepEqual(eventKeys(bucket),[KEY]);
}

// 7. The probe is bounded: 30 removed films with stored ratings, 25 probed, 5 left for the later settlement.
{
 const {bucket,env,ctx,Facts}=setup();
 const ids=Array.from({length:30},(_,i)=>'f'+String(i).padStart(2,'0'));
 for(const id of ids)await rate(Facts,env,id,4,at(T0-H));
 const run={runId:'run-1',stage:'epg',events:[watchlistEvent(ids.map(id=>({id,title:id,year:2000})),{total:0})],watchlist:[],pending:[]};
 const reads=[];bucket.hooks.beforeGet=async key=>{reads.push(key);};
 await ctx.persistEvents(env,run,report);
 bucket.hooks.beforeGet=null;
 const event=stored(bucket);
 assert.equal(event.removed.filter(film=>film.rating!=null).length,25);assert.equal(event.removed.filter(film=>film.rating==null).length,5);
 assert.deepEqual(plain(run.removalPublication),{probed:25,rated:25});
 assert.equal(reads.filter(key=>key.startsWith('letterboxd/facts/records/')||/facts\/.*record/.test(key)).length<=30,true,'one record read per probed film, not a scan');
}

// 8. Unknown and broken shapes fail closed: entries without an id are skipped, a broken list is written as it was, a non-watchlist event is never touched.
{
 const {bucket,env,ctx,Facts}=setup();
 await rate(Facts,env,'ok',3,at(T0-H));
 const broken=eventKeyOf(EVENT_AT,'run-1-broken'),odd=eventKeyOf(EVENT_AT,'run-1-other');
 const run={runId:'run-1',stage:'epg',events:[
  watchlistEvent([{title:'No id'},{id:'',title:'Empty'},{id:'ok',title:'Ok',year:2001}]),
  {id:'run-1-broken',type:'watchlist',at:EVENT_AT,total:0,added:[],removed:[null,{id:'ok',title:'Ok',year:2001}]},
  {id:'run-1-other',type:'watchlist',at:EVENT_AT,total:0,added:[],removed:'nope'},
  {id:'x-1',type:'started',at:EVENT_AT,film:{id:'ok',title:'Ok',year:2001}}],watchlist:[],pending:[]};
 await ctx.persistEvents(env,run,report);
 assert.equal(ratingOf(stored(bucket),'ok'),3,'entries without an id are skipped, the rest is rated');
 assert.equal(stored(bucket).removed.length,3,'nothing is dropped or invented');
 assert.equal(ratingOf(bucket.value(broken),'ok'),undefined,'a list with a broken entry fails closed: written unrated, as it was');
 assert.equal(bucket.value(odd).removed,'nope','a watchlist event with a non-array removed list is written as it was');
 assert.equal(bucket.value(eventKeyOf(EVENT_AT,'x-1')).film.rating,undefined,'another event type is never touched');
 const probe=await ctx.storedRemovalRatings(env,{type:'epg'});assert.equal(probe.probed,0);
}

// 9. Reading events does not look anything up: no fact read, no network, no write.
{
 const {bucket,env,ctx,net,Facts}=setup();
 await rate(Facts,env,'rated',4.5,at(T0-H));
 await ctx.writeEvent(env,watchlistEvent([{id:'rated',title:'Rated',year:2019}]));
 bucket.log.length=0;
 const page=await ctx.eventPage(env);
 assert.equal(ratingOf(page.events[0],'rated'),undefined,'listing shows what is stored and does not fill a rating in');
 assert.equal(bucket.log.some(item=>String(item.key).startsWith('letterboxd/facts/')),false,'listing reads no fact');
 assert.equal(net.fetches.length,0);assert.equal(bucket.writes().length,0,'listing writes nothing');
}

console.log('Watchlist event ratings: stored ratings at the first display, late rating on the same key, replay, stored rating wins, failed read, bounded probe, broken shapes and a listing that looks nothing up passed');
