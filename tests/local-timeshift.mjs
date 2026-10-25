import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {importDecision,importSnapshot,snapshotProgrammeUpdatedAt} from '../scripts/local-store.mjs';
import {DAY_MS,isTimeShifted,shiftDaysToNow,shiftSnapshotObject,timeShiftHandler} from '../scripts/local-timeshift.mjs';
import {MemoryBucket} from './memory-bucket.mjs';

const updatedAt='2026-10-18T07:13:41.576Z';
const updatedMs=Date.parse(updatedAt);

// Whole days that bring updatedAt into the last 24 hours, never into the future.
assert.equal(shiftDaysToNow(updatedAt,updatedMs),0);
assert.equal(shiftDaysToNow(updatedAt,updatedMs+DAY_MS-1),0);
assert.equal(shiftDaysToNow(updatedAt,updatedMs+DAY_MS),1);
assert.equal(shiftDaysToNow(updatedAt,updatedMs+7.4*DAY_MS),7);
assert.equal(shiftDaysToNow(updatedMs,updatedMs+7.4*DAY_MS),7);
assert.equal(shiftDaysToNow(updatedAt,updatedMs-3*DAY_MS),0,'a future snapshot is not moved back');
assert.equal(shiftDaysToNow('not a date',updatedMs),0);
assert.equal(shiftDaysToNow(null,updatedMs),0);
for(const days of [1,7,30]){
 const now=updatedMs+days*DAY_MS+5*3600000;
 const shifted=updatedMs+shiftDaysToNow(updatedAt,now)*DAY_MS;
 assert.ok(shifted<=now&&shifted>now-DAY_MS,`shifted updatedAt is within the last 24 hours for ${days} days`);
}

// Key routing, including staged generations.
assert.equal(timeShiftHandler('programme.json'),'programme');
assert.equal(timeShiftHandler('epg/generations/abc-123/programme.json'),'programme');
assert.equal(timeShiftHandler('epg/discovery-latest.json'),'discoveryLatest');
assert.equal(timeShiftHandler('epg/generations/abc-123/discovery-latest.json'),'discoveryLatest');
assert.equal(timeShiftHandler('epg/discovered-films.json'),'discoveredFilms');
assert.equal(timeShiftHandler('events/items/run-1-epg.json'),'event');
assert.equal(timeShiftHandler('events/bootstrap.json'),null);
for(const key of ['enrichment/view-index.json','enrichment/films/x/fingerprint.json','enrichment/profile/current.json','epg/resolver-lease.json','enrichment/runner-lease.json','started/x.json','titles.json','metadata.json','epg/discovery-resolution.json'])assert.equal(isTimeShifted(key),false,key);

// programme.json: every time field moves by the same delta; nothing else changes.
const delta=7*DAY_MS;
const programme={
 runId:'run-1',updatedAt,watchlistUpdatedAt:'2026-10-18T07:12:36.360Z',cutoff:1792307621576,
 window:{from:1792048421576,to:1792394021576},watchlistCount:2,
 films:[
  {id:'a',title:'A',availableUntil:'2026-10-21T07:53:24.000Z',shows:[{channelId:'c1',channel:'One',start:1792076295000,end:1792082731000,epgTitle:'A (2026)',basis:'title_year'},{channelId:'c2',channel:'Two',start:1792106734000,end:1792113170000}]},
  {id:'b',title:'B',year:1999},
 ],
 people:{directors:[],actors:[]},
 stats:{scanned:10,epgStart:1792044204000,epgEnd:1792389799000,broadcasts:2},
 sources:{epg:'https://example.test/epg.xml'},
};
const before=JSON.stringify(programme);
const shifted=shiftSnapshotObject('programme.json',programme,delta);
assert.equal(JSON.stringify(programme),before,'the input is not mutated');
assert.equal(shifted.updatedAt,new Date(updatedMs+delta).toISOString());
assert.equal(shifted.watchlistUpdatedAt,'2026-10-25T07:12:36.360Z');
assert.equal(shifted.cutoff,programme.cutoff+delta);
assert.deepEqual(shifted.window,{from:programme.window.from+delta,to:programme.window.to+delta});
assert.equal(shifted.stats.epgStart,programme.stats.epgStart+delta);
assert.equal(shifted.stats.epgEnd,programme.stats.epgEnd+delta);
assert.equal(shifted.stats.scanned,10);
assert.equal(shifted.films[0].availableUntil,'2026-10-28T07:53:24.000Z');
assert.deepEqual(shifted.films[0].shows.map(show=>show.start),programme.films[0].shows.map(show=>show.start+delta));
assert.deepEqual(shifted.films[0].shows.map(show=>show.end),programme.films[0].shows.map(show=>show.end+delta));
assert.equal(shifted.films[0].shows[0].epgTitle,'A (2026)');
assert.equal(shifted.films[0].shows[0].basis,'title_year');
assert.deepEqual(shifted.films[1],programme.films[1],'a film without shows is unchanged');
assert.equal(shifted.runId,'run-1');
assert.deepEqual(shifted.sources,programme.sources);
for(const show of shifted.films[0].shows)for(const field of ['start','end']){
 const was=new Date(programme.films[0].shows[shifted.films[0].shows.indexOf(show)][field]);
 assert.equal(new Date(show[field]).getUTCHours(),was.getUTCHours(),'hour of day is preserved');
}
assert.equal(shiftSnapshotObject('programme.json',programme,0),programme,'zero delta returns the same object');
assert.equal(shiftSnapshotObject('titles.json',{a:1},delta).a,1);

// Other objects.
const sync=shiftSnapshotObject('sync.json',{runId:'run-1',startedAt:'2026-10-18T07:12:36.360Z',updatedAt:'2026-10-18T07:14:15.850Z',stage:'complete',events:[{type:'watchlist',at:updatedAt,total:2}]},delta);
assert.equal(sync.startedAt,'2026-10-25T07:12:36.360Z');
assert.equal(sync.updatedAt,'2026-10-25T07:14:15.850Z');
assert.equal(sync.events[0].at,new Date(updatedMs+delta).toISOString());
assert.equal(sync.stage,'complete');
assert.equal(shiftSnapshotObject('watchlist.json',{updatedAt,films:[{id:'a'}]},delta).updatedAt,new Date(updatedMs+delta).toISOString());
const latest=shiftSnapshotObject('epg/discovery-latest.json',{programmeRunId:'run-1',updatedAt,items:[{key:'x|1988',firstAiring:1791258935000,lastAiring:1792323616000,airings:3,shows:[{start:1792300310000,end:1792306561000}]},{key:'y|2000',airings:0}]},delta);
assert.equal(latest.updatedAt,new Date(updatedMs+delta).toISOString());
assert.equal(latest.items[0].firstAiring,1791258935000+delta);
assert.equal(latest.items[0].lastAiring,1792323616000+delta);
assert.equal(latest.items[0].shows[0].end,1792306561000+delta);
assert.equal(latest.items[0].airings,3);
assert.deepEqual(latest.items[1],{key:'y|2000',airings:0});
const catalog=shiftSnapshotObject('epg/discovered-films.json',{tmdb_1:{id:'tmdb_1',title:'T',epgLastAiring:1791768073000,shows:[{start:1791689457000,end:1791697736000}]},tmdb_2:{id:'tmdb_2',title:'U'}},delta);
assert.equal(catalog.tmdb_1.epgLastAiring,1791768073000+delta);
assert.equal(catalog.tmdb_1.shows[0].start,1791689457000+delta);
assert.deepEqual(catalog.tmdb_2,{id:'tmdb_2',title:'U'});
const enrichmentEvent={id:'e',type:'enrichment',at:'2026-10-13T18:05:49.992Z',startedAt:'2026-10-13T18:00:00.000Z',stage:'complete',hotRemaining:0};
assert.equal(shiftSnapshotObject('events/items/run-1-enrichment.json',enrichmentEvent,delta),enrichmentEvent,'prediction history keeps its real time');
assert.equal(shiftSnapshotObject('events/items/started-1.json',{id:'s',type:'started',at:'2026-10-13T16:44:34.511Z',film:{id:'a'}},delta).at,'2026-10-13T16:44:34.511Z');
const epgEvent=shiftSnapshotObject('events/items/run-1-epg.json',{id:'run-1-epg',type:'epg',at:'2026-10-13T15:06:53.509Z',films:275,broadcasts:903},delta);
assert.equal(epgEvent.at,'2026-10-20T15:06:53.509Z');
assert.equal(epgEvent.broadcasts,903);
assert.equal(shiftSnapshotObject('events/items/run-1-watchlist.json',{id:'w',type:'watchlist',at:'2026-10-07T07:44:56.505Z',total:408,added:[]},delta).at,'2026-10-14T07:44:56.505Z');

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
 const result=await importSnapshot(bucket,snapshot,{shiftMs:delta});
 assert.equal(result.shifted,5);
 assert.match(result.message,/Broadcast times moved forward by 7 days in 5 objects/);
 const stored=JSON.parse(bucket.objects.get('programme.json').text);
 assert.equal(stored.updatedAt,new Date(updatedMs+delta).toISOString());
 assert.equal(stored.films[0].shows[1].start,programme.films[0].shows[1].start+delta);
 assert.equal(JSON.parse(bucket.objects.get('watchlist.json').text).updatedAt,new Date(updatedMs+delta).toISOString());
 assert.equal(JSON.parse(bucket.objects.get('sync.json').text).updatedAt,'2026-10-25T07:14:15.850Z');
 assert.equal(JSON.parse(bucket.objects.get('events/items/run-1-epg.json').text).at,new Date(updatedMs+delta).toISOString());
 assert.equal(JSON.parse(bucket.objects.get('events/items/run-1-enrichment.json').text).at,'2026-10-18T19:02:11.432Z','a prediction event is listed but not moved');
 assert.equal(JSON.parse(bucket.objects.get('enrichment/profile/current.json').text).updatedAt,'2026-10-01T00:00:00.000Z','the taste profile keeps its real timestamp');
 assert.equal(JSON.parse(bucket.objects.get('enrichment/films/a/fingerprint.json').text).generatedAt,'2026-10-02T00:00:00.000Z');
 assert.equal(JSON.parse(bucket.objects.get('enrichment/view-index.json').text).a.fingerprint.execution.pace,'fast');
}finally{
 await rm(root,{recursive:true,force:true});
}
console.log('Local time shift: whole-day delta, hour of day preserved, routed keys, untouched enrichment and marker invalidation passed');

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
