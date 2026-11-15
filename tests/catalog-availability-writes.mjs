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

const identity=run(`touchCanonicalFilm({tmdbId:'99',aliases:['Old'],shows:[oldShow],hotEnteredAt:'was',epgLastAiring:1,showsProgrammeRunId:'run-a'},{title:'Alpha',rawTitles:['Alpha'],lastAiring:${now}+3600000,shows:[nextShow]},'run-b',false)`);
assert.ok(identity.aliases.includes('Old')&&identity.aliases.includes('Alpha'));
assert.equal(identity.canonicalIdentity,'tmdb:99');
assert.equal(identity.shows[0].channelId,'x');
assert.equal(identity.hotEnteredAt,'was');
assert.equal(identity.epgLastAiring,1);
assert.equal(identity.showsProgrammeRunId,'run-a');

const live={tmdb_1:{id:'tmdb_1',tmdbId:'1',shows:[oldShow],aliases:['Live']}};
ctx.live=live;
const merged=run(`mergeCatalogIdentity({},live,'run-b',{writeAvailability:false})`);
assert.equal(merged.tmdb_1.shows[0].channelId,'x');
const cleared=run(`mergeCatalogIdentity({},live,'run-b')`);
assert.equal(JSON.stringify(cleared.tmdb_1.shows),'[]');

const discovery=fs.readFileSync('src/discovery.js','utf8')+' '+fs.readFileSync('src/discovery-authority.js','utf8')+' '+fs.readFileSync('src/sources.js','utf8');
assert.doesNotMatch(discovery,/\bfilm_alias\b/,'assignment, replay and catalog writers do not name film_alias');

console.log('catalog availability writes: D1 skip, R2 stamp, aliases kept, no film_alias ok');
