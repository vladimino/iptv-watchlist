import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {importDecision,importSnapshot,snapshotProgrammeUpdatedAt} from '../scripts/local-store.mjs';
import {DAY_MS,LOCAL_TIME_ZONE,addCalendarDays,isTimeShifted,shiftDaysToNow,shiftSnapshotObject,timeMover,timeShiftHandler,zoneHour,zoneOffsetMs} from '../scripts/local-timeshift.mjs';
import {MemoryBucket} from './memory-bucket.mjs';

const HOUR=3600000;
const madrid=time=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).format(new Date(time));
const updatedAt='2026-10-18T07:13:41.576Z';
const updatedMs=Date.parse(updatedAt);

// Zone helpers: Madrid is UTC+2 in summer and UTC+1 in winter; 2026 changes on 29 March and 25 October.
assert.equal(LOCAL_TIME_ZONE,'Europe/Madrid');
assert.equal(zoneOffsetMs(Date.parse('2026-10-18T07:13:41.576Z')),2*HOUR);
assert.equal(zoneOffsetMs(Date.parse('2026-10-25T07:13:41.576Z')),1*HOUR,'after the autumn transition');
assert.equal(zoneOffsetMs(Date.parse('2026-03-25T19:00:00Z')),1*HOUR);
assert.equal(zoneOffsetMs(Date.parse('2026-04-01T19:00:00Z')),2*HOUR,'after the spring transition');
assert.equal(zoneOffsetMs(Date.parse('2026-10-18T07:13:41.576Z'),'UTC'),0);
assert.equal(zoneHour(Date.parse('2026-10-18T19:00:00Z')),21);
assert.equal(zoneHour(Date.parse('2026-10-27T20:00:00Z')),21);

// Calendar-day shift keeps the Madrid wall clock across both DST transitions.
const autumnShow=Date.parse('2026-10-20T19:00:00Z');// 21:00 CEST
const autumnShifted=addCalendarDays(autumnShow,7);
assert.equal(new Date(autumnShifted).toISOString(),'2026-10-27T20:00:00.000Z','21:00 CET is 20:00Z after 25 October');
assert.equal(madrid(autumnShifted),madrid(autumnShow));
assert.equal(autumnShifted-autumnShow,7*DAY_MS+HOUR,'the UTC offset grows by the lost hour');
const springShow=Date.parse('2026-03-25T19:00:00Z');// 20:00 CET
const springShifted=addCalendarDays(springShow,7);
assert.equal(new Date(springShifted).toISOString(),'2026-04-01T18:00:00.000Z','20:00 CEST is 18:00Z after 29 March');
assert.equal(madrid(springShifted),madrid(springShow));
assert.equal(springShifted-springShow,7*DAY_MS-HOUR);
const sameRules=Date.parse('2026-10-05T19:00:00Z');
assert.equal(addCalendarDays(sameRules,7)-sameRules,7*DAY_MS,'no transition in between: plain 24-hour days');
assert.equal(addCalendarDays(sameRules,0),sameRules);
assert.equal(addCalendarDays(sameRules,7,'UTC')-sameRules,7*DAY_MS,'UTC has no DST');
// Transition hours themselves: the spring gap moves forward by the gap, the autumn overlap takes the first occurrence.
assert.equal(new Date(addCalendarDays(Date.parse('2026-03-22T01:30:00Z'),7)).toISOString(),'2026-03-29T01:30:00.000Z','02:30 CET on 22 March does not exist on 29 March and becomes 03:30 CEST');
assert.equal(new Date(addCalendarDays(Date.parse('2026-10-18T00:30:00Z'),7)).toISOString(),'2026-10-25T00:30:00.000Z','02:30 CEST on 18 October becomes the first 02:30 of 25 October');
assert.equal(madrid(addCalendarDays(Date.parse('2026-10-18T00:30:00Z'),7)),'02:30');
// Sub-second precision survives.
assert.equal(new Date(addCalendarDays(updatedMs,7)).toISOString(),'2026-10-25T08:13:41.576Z');
// Many instants around both transitions keep their Madrid hour and minute, and order.
for(const [from,days] of [['2026-10-18T00:00:00Z',7],['2026-03-22T00:00:00Z',7],['2026-10-24T00:00:00Z',1],['2026-03-28T00:00:00Z',1]]){
 let previous=-Infinity;
 for(let step=0;step<48;step++){
  const time=Date.parse(from)+step*30*60000;
  const shifted=addCalendarDays(time,days);
  const wallBefore=madrid(time),wallAfter=madrid(shifted);
  // The hour that does not exist (02:xx on the spring transition day) is mapped onto the next hour, like a real clock.
  const skipped=wallBefore.startsWith('02:')&&wallAfter==='03:'+wallBefore.slice(3)&&new Date(shifted).toISOString().startsWith('2026-03-29');
  if(!skipped)assert.equal(wallAfter,wallBefore,`${from}+${step*30}m → ${new Date(shifted).toISOString()}`);
  if(!skipped)assert.ok(shifted>=previous,`order is preserved outside the spring gap (${from}+${step*30}m)`);
  previous=skipped?previous:shifted;
 }
}

// Whole calendar days that bring updatedAt as late as possible without passing now.
assert.equal(shiftDaysToNow(updatedAt,updatedMs),0);
assert.equal(shiftDaysToNow(updatedAt,updatedMs+DAY_MS-1),0);
assert.equal(shiftDaysToNow(updatedAt,updatedMs+DAY_MS),1);
assert.equal(shiftDaysToNow(updatedAt,updatedMs+7.4*DAY_MS),7);
assert.equal(shiftDaysToNow(updatedMs,updatedMs+7.4*DAY_MS),7);
assert.equal(shiftDaysToNow(updatedAt,updatedMs-3*DAY_MS),0,'a future snapshot is not moved back');
assert.equal(shiftDaysToNow('not a date',updatedMs),0);
assert.equal(shiftDaysToNow(null,updatedMs),0);
// Across the autumn transition the 7th calendar day lands an hour later in UTC; it must not pass now.
const justBefore=Date.parse('2026-10-25T08:13:41.000Z');
assert.equal(shiftDaysToNow(updatedAt,justBefore),6,'08:13:41.576Z CET is still ahead of 08:13:41.000Z');
assert.equal(shiftDaysToNow(updatedAt,justBefore+1000),7);
for(const now of [Date.parse('2026-10-25T09:57:05Z'),Date.parse('2026-10-26T06:00:00Z'),Date.parse('2026-11-30T23:59:00Z'),Date.parse('2027-04-02T07:00:00Z')]){
 const shifted=addCalendarDays(updatedMs,shiftDaysToNow(updatedAt,now));
 assert.ok(shifted<=now&&shifted>now-DAY_MS-HOUR,`shifted updatedAt ${new Date(shifted).toISOString()} is within the last day of ${new Date(now).toISOString()}`);
 assert.equal(madrid(shifted),madrid(updatedMs),'updatedAt keeps its Madrid wall clock');
}

// Movers.
assert.equal(timeMover(0),null);
assert.equal(timeMover({days:0}),null);
assert.equal(timeMover(null),null);
assert.equal(timeMover(5000)(10),5010);
assert.equal(timeMover({days:7})(autumnShow),autumnShifted);
assert.equal(timeMover({days:7,timeZone:'UTC'})(autumnShow),autumnShow+7*DAY_MS);

// Key routing, including staged generations.
assert.equal(timeShiftHandler('programme.json'),'programme');
assert.equal(timeShiftHandler('epg/generations/abc-123/programme.json'),'programme');
assert.equal(timeShiftHandler('epg/discovery-latest.json'),'discoveryLatest');
assert.equal(timeShiftHandler('epg/generations/abc-123/discovery-latest.json'),'discoveryLatest');
assert.equal(timeShiftHandler('epg/discovered-films.json'),'discoveredFilms');
assert.equal(timeShiftHandler('events/items/run-1-epg.json'),'event');
assert.equal(timeShiftHandler('events/bootstrap.json'),null);
for(const key of ['enrichment/view-index.json','enrichment/films/x/fingerprint.json','enrichment/profile/current.json','epg/resolver-lease.json','enrichment/runner-lease.json','started/x.json','titles.json','metadata.json','epg/discovery-resolution.json'])assert.equal(isTimeShifted(key),false,key);

// programme.json across the autumn transition: every time field keeps its Madrid wall clock; nothing else changes.
const shift={days:7,timeZone:'Europe/Madrid'};
const move=timeMover(shift);
const programme={
 runId:'run-1',updatedAt,watchlistUpdatedAt:'2026-10-18T07:12:36.360Z',cutoff:1792307621576,
 window:{from:1792048421576,to:1792394021576},watchlistCount:2,
 films:[
  {id:'a',title:'A',availableUntil:'2026-10-21T07:53:24.000Z',shows:[{channelId:'c1',channel:'One',start:1792076295000,end:1792082731000,epgTitle:'A (2026)',basis:'title_year'},{channelId:'c2',channel:'Two',start:1792106734000,end:1792113170000},{channelId:'c3',channel:'Three',start:Date.parse('2026-10-18T19:00:00Z'),end:Date.parse('2026-10-18T21:00:00Z')}]},
  {id:'b',title:'B',year:1999},
 ],
 people:{directors:[],actors:[]},
 stats:{scanned:10,epgStart:1792044204000,epgEnd:1792389799000,broadcasts:2},
 sources:{epg:'https://example.test/epg.xml'},
};
const before=JSON.stringify(programme);
const shifted=shiftSnapshotObject('programme.json',programme,shift);
assert.equal(JSON.stringify(programme),before,'the input is not mutated');
assert.equal(shifted.updatedAt,'2026-10-25T08:13:41.576Z');
assert.equal(madrid(Date.parse(shifted.updatedAt)),madrid(updatedMs));
assert.equal(shifted.watchlistUpdatedAt,new Date(move(Date.parse(programme.watchlistUpdatedAt))).toISOString());
assert.equal(shifted.cutoff,move(programme.cutoff));
assert.deepEqual(shifted.window,{from:move(programme.window.from),to:move(programme.window.to)});
assert.equal(shifted.stats.epgStart,move(programme.stats.epgStart));
assert.equal(shifted.stats.epgEnd,move(programme.stats.epgEnd));
assert.equal(shifted.stats.scanned,10);
assert.equal(shifted.films[0].availableUntil,new Date(move(Date.parse(programme.films[0].availableUntil))).toISOString());
for(const [index,show] of shifted.films[0].shows.entries()){
 const original=programme.films[0].shows[index];
 assert.equal(show.start,move(original.start));
 assert.equal(show.end,move(original.end));
 assert.equal(madrid(show.start),madrid(original.start),'local start time is preserved');
 assert.equal(madrid(show.end),madrid(original.end),'local end time is preserved');
 assert.equal(zoneHour(show.start),zoneHour(original.start));
}
// Shows before 25 October move by exactly seven days; the 18 October 21:00 CEST show lands on 25 October 21:00 CET, an hour later in UTC.
assert.equal(shifted.films[0].shows[0].start-programme.films[0].shows[0].start,7*DAY_MS);
assert.equal(shifted.films[0].shows[2].start-programme.films[0].shows[2].start,7*DAY_MS+HOUR,'a 24-hour multiple would have moved this show to 20:00 Madrid time');
assert.equal(new Date(shifted.films[0].shows[2].start).toISOString(),'2026-10-25T20:00:00.000Z');
assert.equal(Date.parse(shifted.updatedAt)-updatedMs,7*DAY_MS+HOUR);
assert.equal(shifted.films[0].shows[0].epgTitle,'A (2026)');
assert.equal(shifted.films[0].shows[0].basis,'title_year');
assert.deepEqual(shifted.films[1],programme.films[1],'a film without shows is unchanged');
assert.equal(shifted.runId,'run-1');
assert.deepEqual(shifted.sources,programme.sources);
// Internal consistency: the window still encloses the shows and the stats envelope, and updatedAt still sits inside the window.
const starts=shifted.films[0].shows.map(show=>show.start),ends=shifted.films[0].shows.map(show=>show.end);
assert.ok(Math.min(...starts)>=shifted.window.from&&Math.max(...ends)<=shifted.window.to);
assert.ok(shifted.stats.epgStart<=Math.min(...starts)&&shifted.stats.epgEnd>=Math.max(...ends));
assert.ok(Date.parse(shifted.updatedAt)>shifted.window.from&&Date.parse(shifted.updatedAt)<shifted.window.to);
for(const [index,start] of starts.entries()){assert.ok(start<ends[index],'positive duration');if(index)assert.ok(ends[index-1]<start,'show order is preserved');}
assert.equal(shiftSnapshotObject('programme.json',programme,0),programme,'no shift returns the same object');
assert.equal(shiftSnapshotObject('programme.json',programme,{days:0}),programme);
assert.equal(shiftSnapshotObject('titles.json',{a:1},shift).a,1);
// A fixed millisecond shift is still accepted.
assert.equal(shiftSnapshotObject('watchlist.json',{updatedAt},7*DAY_MS).updatedAt,new Date(updatedMs+7*DAY_MS).toISOString());

// Spring transition on a programme: a 20:00 CET show becomes a 20:00 CEST show.
const spring=shiftSnapshotObject('programme.json',{updatedAt:'2026-03-25T06:00:00.000Z',window:{from:Date.parse('2026-03-22T06:00:00Z'),to:Date.parse('2026-03-26T06:00:00Z')},films:[{id:'s',shows:[{start:springShow,end:springShow+2*HOUR}]}]},shift);
assert.equal(spring.films[0].shows[0].start,springShifted);
assert.equal(madrid(spring.films[0].shows[0].start),'20:00');
assert.equal(madrid(spring.films[0].shows[0].end),'22:00');
assert.equal(madrid(Date.parse(spring.updatedAt)),'07:00');
assert.ok(spring.films[0].shows[0].start>=spring.window.from&&spring.films[0].shows[0].end<=spring.window.to);

// Other objects.
const sync=shiftSnapshotObject('sync.json',{runId:'run-1',startedAt:'2026-10-18T07:12:36.360Z',updatedAt:'2026-10-18T07:14:15.850Z',stage:'complete',events:[{type:'watchlist',at:updatedAt,total:2}]},shift);
assert.equal(sync.startedAt,'2026-10-25T08:12:36.360Z');
assert.equal(sync.updatedAt,'2026-10-25T08:14:15.850Z');
assert.equal(sync.events[0].at,'2026-10-25T08:13:41.576Z');
assert.equal(sync.stage,'complete');
assert.equal(shiftSnapshotObject('watchlist.json',{updatedAt,films:[{id:'a'}]},shift).updatedAt,'2026-10-25T08:13:41.576Z');
const latest=shiftSnapshotObject('epg/discovery-latest.json',{programmeRunId:'run-1',updatedAt,items:[{key:'x|1988',firstAiring:1791258935000,lastAiring:1792323616000,airings:3,shows:[{start:1792300310000,end:1792306561000}]},{key:'y|2000',airings:0}]},shift);
assert.equal(latest.updatedAt,'2026-10-25T08:13:41.576Z');
assert.equal(latest.items[0].firstAiring,move(1791258935000));
assert.equal(latest.items[0].lastAiring,move(1792323616000));
assert.equal(latest.items[0].shows[0].end,move(1792306561000));
assert.equal(madrid(latest.items[0].shows[0].start),madrid(1792300310000));
assert.equal(latest.items[0].airings,3);
assert.deepEqual(latest.items[1],{key:'y|2000',airings:0});
const catalog=shiftSnapshotObject('epg/discovered-films.json',{tmdb_1:{id:'tmdb_1',title:'T',epgLastAiring:1791768073000,shows:[{start:1791689457000,end:1791697736000}]},tmdb_2:{id:'tmdb_2',title:'U'}},shift);
assert.equal(catalog.tmdb_1.epgLastAiring,move(1791768073000));
assert.equal(catalog.tmdb_1.shows[0].start,move(1791689457000));
assert.deepEqual(catalog.tmdb_2,{id:'tmdb_2',title:'U'});
const enrichmentEvent={id:'e',type:'enrichment',at:'2026-10-13T18:05:49.992Z',startedAt:'2026-10-13T18:00:00.000Z',stage:'complete',hotRemaining:0};
assert.equal(shiftSnapshotObject('events/items/run-1-enrichment.json',enrichmentEvent,shift),enrichmentEvent,'prediction history keeps its real time');
assert.equal(shiftSnapshotObject('events/items/started-1.json',{id:'s',type:'started',at:'2026-10-13T16:44:34.511Z',film:{id:'a'}},shift).at,'2026-10-13T16:44:34.511Z');
const epgEvent=shiftSnapshotObject('events/items/run-1-epg.json',{id:'run-1-epg',type:'epg',at:'2026-10-13T15:06:53.509Z',films:275,broadcasts:903},shift);
assert.equal(epgEvent.at,'2026-10-20T15:06:53.509Z','no transition between 13 and 20 October');
assert.equal(epgEvent.broadcasts,903);
assert.equal(shiftSnapshotObject('events/items/run-1-watchlist.json',{id:'w',type:'watchlist',at:'2026-10-07T07:44:56.505Z',total:408,added:[]},shift).at,'2026-10-14T07:44:56.505Z');

// The store marker treats a different shift as a different import.
const identity={snapshot:'/snap',manifestBytes:1,manifestMtimeMs:1};
assert.equal(importDecision({refresh:false,marker:{...identity},identity,ready:true}),'skip');
assert.equal(importDecision({refresh:false,marker:{...identity,shiftDays:7},identity:{...identity,shiftDays:7},ready:true}),'skip');
assert.equal(importDecision({refresh:false,marker:{...identity,shiftDays:7},identity:{...identity,shiftDays:8},ready:true}),'replace');
assert.equal(importDecision({refresh:false,marker:{...identity},identity:{...identity,shiftDays:1},ready:true}),'replace');

// Importing a snapshot with a shift rewrites only time-bearing objects.
const root=await mkdtemp(path.join(tmpdir(),'iptv-local-timeshift-'));
try{
 const snapshot=path.join(root,'snapshot');
 await writeSnapshot(snapshot,programme);
 assert.equal(await snapshotProgrammeUpdatedAt(snapshot),updatedAt);
 const plain=new MemoryBucket();
 const plainResult=await importSnapshot(plain,snapshot);
 assert.equal(plainResult.shifted,0);
 assert.doesNotMatch(plainResult.message,/Broadcast times/);
 assert.equal(JSON.parse(plain.objects.get('programme.json').text).updatedAt,updatedAt);
 const bucket=new MemoryBucket();
 const result=await importSnapshot(bucket,snapshot,{shift});
 assert.equal(result.shifted,5);
 assert.match(result.message,/Broadcast times moved forward by 7 calendar days \(Europe\/Madrid\) in 5 objects/);
 const stored=JSON.parse(bucket.objects.get('programme.json').text);
 assert.equal(stored.updatedAt,'2026-10-25T08:13:41.576Z');
 assert.equal(stored.films[0].shows[1].start,move(programme.films[0].shows[1].start));
 assert.equal(madrid(stored.films[0].shows[1].start),madrid(programme.films[0].shows[1].start));
 assert.equal(JSON.parse(bucket.objects.get('watchlist.json').text).updatedAt,'2026-10-25T08:13:41.576Z');
 assert.equal(JSON.parse(bucket.objects.get('sync.json').text).updatedAt,'2026-10-25T08:14:15.850Z');
 assert.equal(JSON.parse(bucket.objects.get('events/items/run-1-epg.json').text).at,'2026-10-25T08:13:41.576Z');
 assert.equal(JSON.parse(bucket.objects.get('events/items/run-1-enrichment.json').text).at,'2026-10-18T19:02:11.432Z','a prediction event is listed but not moved');
 assert.equal(JSON.parse(bucket.objects.get('enrichment/profile/current.json').text).updatedAt,'2026-10-01T00:00:00.000Z','the taste profile keeps its real timestamp');
 assert.equal(JSON.parse(bucket.objects.get('enrichment/films/a/fingerprint.json').text).generatedAt,'2026-10-02T00:00:00.000Z');
 assert.equal(JSON.parse(bucket.objects.get('enrichment/view-index.json').text).a.fingerprint.execution.pace,'fast');
}finally{
 await rm(root,{recursive:true,force:true});
}
console.log('Local time shift: calendar days in Europe/Madrid across spring and autumn DST, consistent window, routed keys, untouched enrichment and marker invalidation passed');

async function writeSnapshot(dir,report){
 const objects={
  'programme.json':report,
  'watchlist.json':{updatedAt,films:[{id:'a',title:'A'},{id:'b',title:'B'}]},
  'sync.json':{runId:'run-1',startedAt:'2026-10-18T07:12:36.360Z',updatedAt:'2026-10-18T07:14:15.850Z',stage:'complete'},
  'events/items/run-1-epg.json':{id:'run-1-epg',type:'epg',at:updatedAt,films:1,broadcasts:2},
  'events/items/run-1-enrichment.json':{id:'run-1-enrichment',type:'enrichment',at:'2026-10-18T19:02:11.432Z',stage:'complete'},
  'enrichment/profile/current.json':{version:3,profileHash:'p',updatedAt:'2026-10-01T00:00:00.000Z'},
  'enrichment/films/a/fingerprint.json':{generatedAt:'2026-10-02T00:00:00.000Z',execution:{pace:'fast',plot_engine:'unknown'}},
  'enrichment/view-index.json':{a:{actualRating:4,fingerprintHash:'h',fingerprint:{plotMechanics:[],moodLabels:[],fingerprintHash:'h'}}},
 };
 await mkdir(path.join(dir,'entries'),{recursive:true});
 await mkdir(path.join(dir,'objects'),{recursive:true});
 await writeFile(path.join(dir,'manifest.json'),'{}\n');
 let index=0;
 for(const [key,json] of Object.entries(objects)){
  const file=`objects/${String(++index).padStart(4,'0')}.json`;
  await writeFile(path.join(dir,file),JSON.stringify(json));
  await writeFile(path.join(dir,'entries',`${String(index).padStart(4,'0')}.json`),JSON.stringify({key,file,metadata:{httpMetadata:{contentType:'application/json'}}}));
 }
}
