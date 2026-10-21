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
console.log('Show replacement: new EPG replaces shows and keeps candidate knowledge passed');
