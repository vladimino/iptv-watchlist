import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';

const app=fs.readFileSync('public/app.js','utf8');
assert.doesNotMatch(app,/В EPG нет года: совпали название и длительность/);
assert.match(app,/show\.basis==='title_duration'/);
assert.match(app,/ambiguous_short_title_without_year/);
const context=vm.createContext({TextDecoder,Date,Map,Set,Number,String,JSON,Math,RegExp,Error,Promise,AbortSignal,fetch});
vm.runInContext(fs.readFileSync('src/domain/scored-resolution.js','utf8')+'\nglobalThis.showMatchBasis=showMatchBasis;',context);
const film=(tmdbId,title,year,runtime)=>({tmdbId,title,original:title,year,runtime,aliases:[title]});
const observe=(title,year,duration)=>({key:title.toLowerCase()+'|'+(year??''),title,normalizedTitle:title.toLowerCase(),year,duration,durations:[duration]});
context.observe=observe;context.film=film;
const basis=input=>{context.input=input;return vm.runInContext('showMatchBasis(input.year,observe(input.title,input.year,input.duration),input.candidates)',context);};
assert.equal(basis({year:1984,title:'Dune',duration:137,candidates:[film('11','Dune',1984,137),film('438631','Dune',2021,155)]}).basis,'title_year');
assert.equal(basis({year:null,title:'The Straight Story',duration:111,candidates:[film('21283','The Straight Story',1999,111)]}).basis,'title_unique');
const dune=basis({year:null,title:'Dune',duration:137,candidates:[film('11','Dune',1984,137),film('438631','Dune',2021,155)]});
assert.equal(dune.basis,'title_duration');
assert.equal(dune.hint,true);
assert.equal(dune.reason,'ambiguous_short_title_without_year');

vm.runInContext(fs.readFileSync('src/sources.js','utf8')+';globalThis.scanEPG=scanEPG;',context);
const now=Date.parse('2026-10-02T18:00:00Z');
const xml='<tv><channel id="one"><display-name>Кино</display-name></channel><programme channel="one" start="20261002170000 +0000" stop="20261002185100 +0000"><title>The Straight Story</title></programme><programme channel="one" start="20261002120000 +0000" stop="20261002141700 +0000"><title>Dune</title></programme></tv>';
context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=now;
context.watchlist=[
 {id:'story',title:'The Straight Story',original:'The Straight Story',year:1999,runtime:111,tmdbId:'21283',aliases:['The Straight Story']},
 {id:'d84',title:'Дюна',original:'Dune',year:1984,runtime:137,tmdbId:'11',aliases:['Dune','Дюна']},
 {id:'d21',title:'Дюна: Часть вторая',original:'Dune',year:2021,runtime:180,tmdbId:'438631',aliases:['Dune']}
];
const scanned=await vm.runInContext('scanEPG(stream,watchlist,now)',context);
const story=scanned.films.find(film=>film.id==='story');
const old=scanned.films.find(film=>film.id==='d84');
assert.equal(story.shows[0].basis,'title_unique');
assert.equal(story.shows[0].matchReason,null);
assert.equal(old.shows[0].basis,'title_duration');
assert.equal(old.shows[0].matchReason,'ambiguous_short_title_without_year');
assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/SCORED_RESOLUTION/);
console.log('Match hint: unique yearless title is unmarked, a short collision keeps the warning passed');
