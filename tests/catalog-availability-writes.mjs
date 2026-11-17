// AIR-480 stage 4c: under D1, catalog writers keep identity/aliases and do not rewrite availability fields (ADR 0142 decision 13).
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
ctx.oldShow=oldShow;ctx.nextShow=nextShow;ctx.now=now;

const skipped=run(`replaceCatalogAvailability({
 tmdb_99:{id:'tmdb_99',tmdbId:'99',title:'Alpha',shows:[oldShow],epgLastAiring:${now}-86400000,hotEnteredAt:'stamped',showsProgrammeRunId:'run-a'}
},[{confirmedTmdbId:'99',shows:[nextShow]}],'run-b',{writeAvailability:false})`);
assert.equal(skipped.changed,false);
assert.equal(skipped.catalog.tmdb_99.shows[0].channelId,'x');
assert.equal(skipped.catalog.tmdb_99.showsProgrammeRunId,'run-a');
assert.equal(skipped.catalog.tmdb_99.hotEnteredAt,'stamped');

const r2=run(`replaceCatalogAvailability({
 tmdb_99:{id:'tmdb_99',tmdbId:'99',title:'Alpha',shows:[oldShow],epgLastAiring:${now}-86400000}
},[{confirmedTmdbId:'99',shows:[nextShow]}],'run-b')`);
assert.equal(r2.changed,true);
assert.equal(r2.catalog.tmdb_99.shows[0].channelId,'y');
assert.equal(r2.catalog.tmdb_99.showsProgrammeRunId,'run-b');

const identity=run(`touchCanonicalFilm({tmdbId:'99',aliases:['Old'],shows:[oldShow],hotEnteredAt:'was',epgLastAiring:1,showsProgrammeRunId:'run-a'},{title:'Alpha',rawTitles:['Alpha'],lastAiring:${now}+3600000,shows:[nextShow]},'run-b',false,true)`);
assert.ok(identity.aliases.includes('Old')&&identity.aliases.includes('Alpha'));
assert.equal(identity.canonicalIdentity,'tmdb:99');
assert.equal(identity.shows,undefined);
assert.equal(identity.hotEnteredAt,undefined);
assert.equal(identity.epgLastAiring,undefined);
assert.equal(identity.showsProgrammeRunId,undefined);
assert.equal(identity.availableUntil,undefined);

const live={
 tmdb_1:{id:'tmdb_1',tmdbId:'1',title:'Live',shows:[oldShow],availableUntil:now,showsProgrammeRunId:'run-a',epgLastAiring:now-1,hotEnteredAt:'was',aliases:['Live']},
 tmdb_2:{id:'tmdb_2',tmdbId:'2',title:'Other',shows:[oldShow],availableUntil:now,showsProgrammeRunId:'run-a',epgLastAiring:now-1,hotEnteredAt:'kept',aliases:['Other']}
};
ctx.live=live;
const merged=run(`mergeCatalogIdentity({},live,'run-b',{writeAvailability:false})`);
assert.equal(merged.tmdb_1.shows[0].channelId,'x','untouched live rows keep leftover availability');
assert.equal(merged.tmdb_1,live.tmdb_1);
const stagedVsLive=run(`mergeCatalogIdentity({tmdb_1:{id:'tmdb_1',tmdbId:'1',title:'Staged',shows:[nextShow],availableUntil:${now}+1,showsProgrammeRunId:'run-staged',epgLastAiring:${now}+2,hotEnteredAt:'staged',aliases:['Staged']},tmdb_2:live.tmdb_2},live,'run-b',{writeAvailability:false})`);
assert.equal(stagedVsLive.tmdb_1.title,'Staged');
assert.ok(stagedVsLive.tmdb_1.aliases.includes('Staged')&&stagedVsLive.tmdb_1.aliases.includes('Live'));
assert.equal(stagedVsLive.tmdb_1.shows,undefined);
assert.equal(stagedVsLive.tmdb_1.showsProgrammeRunId,undefined);
assert.equal(stagedVsLive.tmdb_1.availableUntil,undefined);
assert.equal(stagedVsLive.tmdb_1.hotEnteredAt,undefined);
assert.equal(stagedVsLive.tmdb_1.epgLastAiring,undefined);
assert.equal(stagedVsLive.tmdb_2,live.tmdb_2,'an identity write does not strip other live rows');
assert.deepEqual(Object.keys(stagedVsLive).filter(id=>JSON.stringify(stagedVsLive[id])!==JSON.stringify(live[id])),['tmdb_1']);
const sameIdentity=run(`mergeCatalogIdentity({tmdb_1:{...live.tmdb_1,shows:[nextShow]},tmdb_2:live.tmdb_2},live,'run-b',{writeAvailability:false})`);
assert.equal(sameIdentity.tmdb_1,live.tmdb_1,'availability-only staged bytes are not an identity write');
const stagedOnly=run(`mergeCatalogIdentity({tmdb_3:{id:'tmdb_3',tmdbId:'3',title:'New',shows:[nextShow],availableUntil:${now}+1,showsProgrammeRunId:'run-staged',epgLastAiring:${now}+2,hotEnteredAt:'new',aliases:['New']}},live,'run-b',{writeAvailability:false})`);
assert.equal(stagedOnly.tmdb_3.title,'New');
assert.equal(stagedOnly.tmdb_3.aliases[0],'New');
assert.equal(stagedOnly.tmdb_3.shows,undefined);
assert.equal(stagedOnly.tmdb_3.availableUntil,undefined);
assert.equal(stagedOnly.tmdb_3.showsProgrammeRunId,undefined);
assert.equal(stagedOnly.tmdb_3.epgLastAiring,undefined);
assert.equal(stagedOnly.tmdb_3.hotEnteredAt,undefined);
assert.equal(stagedOnly.tmdb_1,live.tmdb_1);
const cleared=run(`mergeCatalogIdentity({},live,'run-b')`);
assert.equal(JSON.stringify(cleared.tmdb_1.shows),'[]');

const discovery=fs.readFileSync('src/discovery.js','utf8')+' '+fs.readFileSync('src/discovery-authority.js','utf8')+' '+fs.readFileSync('src/sources.js','utf8');
assert.doesNotMatch(discovery,/\bfilm_alias\b/,'assignment, replay and catalog writers do not name film_alias');

const worker=fs.readFileSync('src/worker.js','utf8');
vm.runInContext(worker.slice(worker.indexOf('function completedShowsByTmdb'),worker.indexOf('function catalogAvailable')),ctx);
vm.runInContext('var completedShowsByTmdbCalls=0;const _completedShowsByTmdb=completedShowsByTmdb;completedShowsByTmdb=function(programme){completedShowsByTmdbCalls++;return _completedShowsByTmdb(programme);};',ctx);
const enrichment=fs.readFileSync('src/enrichment.js','utf8');
vm.runInContext(enrichment.slice(enrichment.indexOf('function canonicalCoverageSummary'),enrichment.indexOf('function coveragePercent')),ctx);
ctx.freshness={indexed:()=>false};
const staleCatalog={tmdb_1:{id:'tmdb_1',tmdbId:'1',canonicalIdentity:'tmdb:1',shows:[oldShow],epgLastAiring:now,hotEnteredAt:'stamped'}};
ctx.staleCatalog=staleCatalog;
const emptyCompleted=run(`canonicalCoverageSummary({runId:'run-b',films:[],catalogFilms:[]},staleCatalog,{},{},now,freshness,true)`);
assert.equal(emptyCompleted.windowFilmsTotal,0,'stale catalog shows are not in the D1 coverage window');
assert.equal(emptyCompleted.confirmedFilmsTotal,1);
const assigned=run(`canonicalCoverageSummary({runId:'run-b',films:[],catalogFilms:[{id:'tmdb_1',tmdbId:'1',shows:[oldShow]}]},staleCatalog,{},{},now,freshness,true)`);
assert.equal(assigned.windowFilmsTotal,1,'completed showings put the Film in the coverage window');
const r2Coverage=run(`canonicalCoverageSummary({runId:'run-b',films:[]},staleCatalog,{},{},now,freshness,false)`);
assert.equal(r2Coverage.windowFilmsTotal,1,'R2 coverage still uses catalog shows');
run('completedShowsByTmdbCalls=0');
const many={tmdb_1:{id:'tmdb_1',tmdbId:'1',canonicalIdentity:'tmdb:1',shows:[oldShow]},tmdb_2:{id:'tmdb_2',tmdbId:'2',canonicalIdentity:'tmdb:2',shows:[oldShow]},tmdb_3:{id:'tmdb_3',tmdbId:'3',canonicalIdentity:'tmdb:3',shows:[oldShow]}};
ctx.many=many;
run(`canonicalCoverageSummary({runId:'run-b',films:[{id:'w1',tmdbId:'9',shows:[oldShow]}],catalogFilms:[{id:'tmdb_1',tmdbId:'1',shows:[oldShow]}]},many,{},{},now,freshness,true)`);
assert.equal(run('completedShowsByTmdbCalls'),1,'the completed-showings index is built once per summary');
run('completedShowsByTmdbCalls=0');
run(`canonicalCoverageSummary({runId:'run-b',films:[]},many,{},{},now,freshness,false)`);
assert.equal(run('completedShowsByTmdbCalls'),0,'R2 coverage does not build the completed-showings index');

console.log('catalog availability writes: D1 skip, identity strip, R2 stamp, aliases kept, coverage overlay, no film_alias ok');
