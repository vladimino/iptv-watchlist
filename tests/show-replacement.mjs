import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ctx=vm.createContext({Date,Map,Set,JSON});
vm.runInContext(fs.readFileSync('src/sources.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('src/discovery.js','utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);
const now=Date.parse('2026-06-15T12:00:00Z');
const oldShow={channelId:'x',channel:'X',start:now-3600000,end:now};
const nextShow={channelId:'y',channel:'Y',start:now+3600000,end:now+7200000};
const duplicate={channelId:'y',channel:'Y',start:now+3600000,end:now+7200000,epgTitle:'again'};
ctx.oldShow=oldShow;ctx.nextShow=nextShow;ctx.duplicate=duplicate;ctx.now=now;
const merged=run(`mergeDiscoveryCandidates([
 {key:'alpha|',title:'Alpha',firstAiring:${now}-86400000,lastAiring:${now}-3600000,airings:2,description:'kept',confirmedTmdbId:'99',shows:[oldShow]},
 {key:'beta|',title:'Beta',firstAiring:${now}-86400000,lastAiring:${now}-7200000,airings:1,description:'memory',shows:[oldShow]}
],[
 {key:'alpha|',title:'Alpha',firstAiring:${now},lastAiring:${now}+3600000,airings:1,shows:[nextShow,duplicate]},
 {key:'gamma|',title:'Gamma',firstAiring:${now},lastAiring:${now},airings:1,shows:[nextShow]}
],{replaceShows:true})`);
const alpha=merged.find(item=>item.key==='alpha|'),beta=merged.find(item=>item.key==='beta|'),gamma=merged.find(item=>item.key==='gamma|');
assert.equal(merged.length,3);
assert.deepEqual(JSON.parse(JSON.stringify(alpha.shows.map(show=>show.channelId))),['y']);
assert.equal(alpha.firstAiring,now-86400000);
assert.equal(alpha.lastAiring,now+3600000);
assert.equal(alpha.description,'kept');
assert.equal(alpha.confirmedTmdbId,'99');
assert.deepEqual(JSON.parse(JSON.stringify(beta.shows)),[]);
assert.equal(beta.lastAiring,now-7200000);
assert.equal(beta.description,'memory');
assert.equal(gamma.shows.length,1);
ctx.alpha=alpha;
const again=run(`mergeDiscoveryCandidates([alpha],[
 {key:'alpha|',title:'Alpha',firstAiring:${now},lastAiring:${now}+3600000,airings:1,confirmedTmdbId:'99',shows:[oldShow]}
],{replaceShows:true})`);
assert.equal(again[0].confirmedTmdbId,'99');
assert.deepEqual(JSON.parse(JSON.stringify(again[0].shows.map(show=>show.start))),[oldShow.start]);
const touched=run(`touchCanonicalFilm({tmdbId:'99',aliases:['Old'],shows:[oldShow],epgLastAiring:${now}-86400000,fingerprint:{ok:true}},{title:'Alpha',rawTitles:['Alpha'],lastAiring:${now}+3600000,shows:[nextShow]})`);
assert.equal(touched.tmdbId,'99');
assert.equal(touched.fingerprint.ok,true);
assert.deepEqual(JSON.parse(JSON.stringify(touched.shows.map(show=>show.channelId))),['y']);
assert.equal(touched.epgLastAiring,now+3600000);
assert.ok(touched.aliases.includes('Old')&&touched.aliases.includes('Alpha'));
ctx.touched=touched;
const cleared=run(`touchCanonicalFilm(touched,{title:'Alpha',lastAiring:${now}-86400000,shows:[]})`);
assert.deepEqual(JSON.parse(JSON.stringify(cleared.shows)),[]);
assert.equal(cleared.epgLastAiring,now+3600000);
assert.equal(run(`filmIsHot({shows:[],epgLastAiring:${now}},${now})`),false);
assert.equal(run(`filmIsHot({epgLastAiring:${now}},${now})`),true,'a cache with no show list can still use its stored airing');
const both=run(`touchCanonicalFilm(touchCanonicalFilm({tmdbId:'99',shows:[oldShow],showsProgrammeRunId:'run-a',epgLastAiring:1,aliases:[]},{title:'Чужой',shows:[{channelId:'x',channel:'X',start:${now},end:${now}+1}],lastAiring:${now}},'run-b'),{title:'Alien',shows:[{channelId:'y',channel:'Y',start:${now}+10,end:${now}+20}],lastAiring:${now}},'run-b')`);
assert.deepEqual(JSON.parse(JSON.stringify(both.shows.map(show=>show.channelId))).sort(),['x','y']);
assert.equal(both.showsProgrammeRunId,'run-b');
const replaced=run(`replaceCatalogAvailability({
 tmdb_99:{id:'tmdb_99',tmdbId:'99',title:'Alpha',shows:[oldShow],epgLastAiring:${now}-86400000,prediction:{rating:4}},
 tmdb_100:{id:'tmdb_100',tmdbId:'100',title:'Beta',shows:[oldShow],epgLastAiring:${now}-7200000,prediction:{rating:3}}
},[{confirmedTmdbId:'99',shows:[nextShow,duplicate]}])`);
assert.equal(replaced.changed,true);
assert.deepEqual(JSON.parse(JSON.stringify(replaced.catalog.tmdb_99.shows.map(show=>show.channelId))),['y']);
assert.equal(replaced.catalog.tmdb_99.prediction.rating,4);
assert.deepEqual(JSON.parse(JSON.stringify(replaced.catalog.tmdb_100.shows)),[]);
assert.equal(replaced.catalog.tmdb_100.prediction.rating,3);
assert.equal(replaced.catalog.tmdb_100.epgLastAiring,now-7200000);
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/previous\?\.films/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/replaceShows:true/);

import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,failKey='';
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){if(key===failKey)throw new Error('injected put failure');const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}
};
const live=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async()=>new Response('{}',{status:500})});
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),live);
const env={TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:bucket};
live.env=env;live.records=records;
const clock=Date.now();
const show=(channel,start)=>({channelId:channel,channel,start,end:start+1000});
records.set('programme.json',{runId:'run-b',updatedAt:new Date(clock).toISOString(),films:[]});
records.set('epg/discovered-films.json',{tmdb_42:{id:'tmdb_42',tmdbId:'42',title:'Alien',original:'Alien',year:1979,runtime:117,aliases:['Alien'],shows:[show('old',clock-86400000)],showsProgrammeRunId:'run-a',epgLastAiring:clock-86400000}});
records.set('epg/discovery-resolution.json',{'чужой|1979':{status:'verified',tmdbId:'42',filmId:'tmdb_42'},'alien|1979':{status:'verified',tmdbId:'42',filmId:'tmdb_42'}});
records.set('epg/discovery-latest.json',{programmeRunId:'run-b',items:[
 {key:'чужой|1979',title:'Чужой',normalizedTitle:'чужой',year:1979,duration:117,durations:[117],lastAiring:clock,airings:1,confirmedTmdbId:'42',shows:[show('x',clock)]},
 {key:'alien|1979',title:'Alien',normalizedTitle:'alien',year:1979,duration:117,durations:[117],lastAiring:clock,airings:1,confirmedTmdbId:'42',shows:[show('y',clock+10)]}
]});
const resolved=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-b",films:[]},2)',live);
assert.equal(resolved.touched,2);
assert.deepEqual(records.get('epg/discovered-films.json').tmdb_42.shows.map(item=>item.channelId).sort(),['x','y']);
env.beforeCatalogWrite=async()=>{await bucket.put('epg/published-generation.json',JSON.stringify({programmeRunId:'run-c',phase:'published'}));records.set('epg/discovered-films.json',{tmdb_42:{id:'tmdb_42',tmdbId:'42',shows:[show('z',clock)],showsProgrammeRunId:'run-c'}});};
const stale=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-b",films:[]},2)',live);
assert.equal(stale.stage,'programme_changed');
assert.deepEqual(records.get('epg/discovered-films.json').tmdb_42.shows.map(item=>item.channelId),['z']);
failKey='epg/generations/run-d/discovered-films.json';
const previousProgramme={runId:'run-a',films:[{id:'a',shows:[show('old',clock)]}]};
records.set('programme.json',previousProgramme);
await assert.rejects(vm.runInContext(`publishEpgGeneration(env,'run-d',{'discovery-latest.json':{programmeRunId:'run-d',items:[]},'discovered-films.json':{tmdb_42:{tmdbId:'42',shows:[]}},'programme.json':{runId:'run-d',films:[]}})`,live));
assert.equal(records.has('epg/published-generation.json')&&records.get('epg/published-generation.json').programmeRunId==='run-c',true);
assert.equal(records.get('programme.json').runId,'run-a');
failKey='programme.json';
await vm.runInContext(`publishEpgGeneration(env,'run-e',{'discovery-latest.json':{programmeRunId:'run-e',items:[]},'discovered-films.json':{tmdb_42:{tmdbId:'42',shows:[${JSON.stringify(show('n',clock))}]}},'programme.json':{runId:'run-e',films:[]}})`,live).catch(()=>{});
assert.equal(records.get('epg/published-generation.json').programmeRunId,'run-e');
assert.equal((await vm.runInContext("loadJSON(env,'programme.json')",live)).runId,'run-e');
failKey='';
await vm.runInContext("copyEpgGeneration(env,'run-e')",live);
assert.equal(records.get('programme.json').runId,'run-e');

const seen=new Map(),etags2=new Map();let rev2=0,pointer='A';
const genBucket={
 async get(key){
  if(key==='epg/published-generation.json')return {etag:pointer,json:async()=>({programmeRunId:pointer,phase:'published'})};
  const hit=seen.get(key);return hit?{etag:etags2.get(key)||'1',json:async()=>hit}:null;
 },
 async put(key,value){seen.set(key,JSON.parse(value));etags2.set(key,String(++rev2));return {etag:etags2.get(key)};}
};
seen.set('epg/generations/A/programme.json',{runId:'A',mark:'A'});
seen.set('epg/generations/A/discovery-latest.json',{programmeRunId:'A',mark:'A',items:[{key:'a|',title:'A'}]});
seen.set('epg/generations/A/discovered-films.json',{mark:'A'});
seen.set('epg/generations/B/programme.json',{runId:'B',mark:'B'});
seen.set('epg/generations/B/discovery-latest.json',{programmeRunId:'B',mark:'B',items:[{key:'b|',title:'B'}]});
seen.set('epg/generations/B/discovered-films.json',{mark:'B'});
const pinCtx=vm.createContext({Date,Map,Set,JSON,crypto:webcrypto,console,setTimeout,fetch:async()=>{throw new Error('no fetch');}});
vm.runInContext(fs.readFileSync('src/sources.js','utf8'),pinCtx);
vm.runInContext(fs.readFileSync('src/discovery.js','utf8'),pinCtx);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),pinCtx);
pinCtx.env={BUCKET:genBucket,TMDB_REQUEST_INTERVAL_MS:0};
genBucket.get=async key=>{
 if(key==='epg/published-generation.json'){const id=pointer;pointer='B';return {etag:id,json:async()=>({programmeRunId:id,phase:'published'})};}
 const hit=seen.get(key);return hit?{etag:'1',json:async()=>hit}:null;
};
const shot=await vm.runInContext('loadEpgSnapshot(env)',pinCtx);
assert.equal(shot.programme.mark,'A');
assert.equal(shot.discovery.mark,'A');
assert.equal(shot.catalog.mark,'A');
assert.equal(shot.programmeRunId,'A');

const scanRecords=new Map(),scanEtags=new Map();let scanRev=0,fetches=0;
const scanBucket={
 async get(key){return scanRecords.has(key)?{etag:scanEtags.get(key),json:async()=>structuredClone(scanRecords.get(key))}:null;},
 async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&scanRecords.has(key)||condition?.etagMatches&&condition.etagMatches!==scanEtags.get(key))return null;scanRecords.set(key,JSON.parse(value));scanEtags.set(key,String(++scanRev));return {etag:scanEtags.get(key)};}
};
const stamp=ms=>{const d=new Date(ms),p=n=>String(n).padStart(2,'0');return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;};
const startAt=Date.now()+9*3600000,stopAt=startAt+2*3600000;
const xml=`<?xml version="1.0"?><tv><channel id="c1"><display-name>One</display-name></channel><programme start="${stamp(startAt)}" stop="${stamp(stopAt)}" channel="c1"><title>Новый фильм (2020)</title><desc>Сюжет</desc></programme></tv>`;
const scanEnv={LETTERBOXD_USERNAME:'me',EPG_XML_URL:'https://example.test/epg.xml',TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:scanBucket};
const scanCtx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async()=>{fetches++;return new Response(xml);}});
for(const file of ['src/domain/scored-resolution.js','src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),scanCtx);
scanCtx.env=scanEnv;
await vm.runInContext(`publishEpgGeneration(env,'run-a',{
 'programme.json':{runId:'run-a',updatedAt:new Date().toISOString(),films:[{id:'other',title:'Другой',original:'Other',year:1999,tmdbId:'1',shows:[]}]},
 'discovery-latest.json':{programmeRunId:'run-a',items:[{key:'old|',title:'Old',firstAiring:1,lastAiring:1,airings:1,shows:[]}]},
 'discovered-films.json':{tmdb_1:{id:'tmdb_1',tmdbId:'1',title:'Kept',aliases:['Kept'],shows:[{channelId:'old',channel:'Old',start:1}],epgLastAiring:1,prediction:{rating:4}}}
})`,scanCtx);
const scanned=await scanCtx.worker.fetch(new Request('https://site.example/api/enrichment/discovery/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),scanEnv);
assert.equal(scanned.status,200);
assert.equal(fetches,1);
const after=await vm.runInContext('loadEpgSnapshot(env)',scanCtx);
assert.equal(after.programme.runId,'run-a');
assert.equal(after.discovery.programmeRunId,'run-a');
assert.ok(after.discovery.items.some(item=>item.title==='Новый фильм'));
assert.equal(after.catalog.tmdb_1.prediction.rating,4);
assert.deepEqual(after.catalog.tmdb_1.shows,[]);
const staged=scanRecords.get('epg/generations/run-a/discovery-latest.json');
staged.items.push({key:'х ф новый фильм|2020',title:'х/ф Новый фильм 2020',year:null,duration:120,firstAiring:1,lastAiring:1,airings:1,shows:[]});
scanRecords.set('epg/discovery-resolution.json',{});
const reconciled=await scanCtx.worker.fetch(new Request('https://site.example/api/enrichment/discovery/reconcile',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),scanEnv);
assert.equal(reconciled.status,200);
const reread=await vm.runInContext("loadJSON(env,'epg/discovery-latest.json')",scanCtx);
assert.ok(reread.canonicalizedAt);
assert.equal(reread.programmeRunId,'run-a');
assert.ok(reread.items.filter(item=>item.title==='Новый фильм').length<=1);
console.log('Show replacement: new EPG replaces shows and keeps candidate knowledge passed');
