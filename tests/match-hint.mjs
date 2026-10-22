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
const separated=basis({year:1984,title:'Dune',duration:137,candidates:[film('11','Dune',1984,137),film('438631','Dune',2021,155)]});
assert.equal(separated.basis,'title_year');
assert.equal(separated.hint,false);
const contradicted=basis({year:2002,title:'Resident Evil',duration:180,candidates:[film('1576','Resident Evil',2002,100)]});
assert.equal(contradicted.basis,'title_duration');
assert.equal(contradicted.hint,true);
assert.equal(contradicted.reason,'contradicted_runtime');
const near=basis({year:2021,title:'Dune',duration:155,candidates:[film('438631','Dune',2021,155),film('999','Dune',2022,155)]});
assert.equal(near.basis,'title_duration');
assert.equal(near.hint,true);
assert.equal(near.reason,'ambiguous_collision');
assert.equal(basis({year:null,title:'The Straight Story',duration:111,candidates:[film('21283','The Straight Story',1999,111)]}).basis,'title_unique');
const dune=basis({year:null,title:'Dune',duration:137,candidates:[film('11','Dune',1984,137),film('438631','Dune',2021,155)]});
assert.equal(dune.basis,'title_duration');
assert.equal(dune.hint,true);
assert.equal(dune.reason,'ambiguous_short_title_without_year');

vm.runInContext(fs.readFileSync('src/sources.js','utf8')+';globalThis.scanEPG=scanEPG;',context);
const now=Date.parse('2026-10-02T18:00:00Z');
const xml='<tv><channel id="one"><display-name>Кино</display-name></channel><programme channel="one" start="20261002170000 +0000" stop="20261002185100 +0000"><title>The Straight Story</title></programme><programme channel="one" start="20261002120000 +0000" stop="20261002141700 +0000"><title>Dune</title></programme><programme channel="one" start="20261002100000 +0000" stop="20261002130000 +0000"><title>Resident Evil (2002)</title></programme><programme channel="one" start="20261002080000 +0000" stop="20261002103500 +0000"><title>Dune (2021)</title></programme></tv>';
context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=now;
context.watchlist=[
 {id:'story',title:'The Straight Story',original:'The Straight Story',year:1999,runtime:111,tmdbId:'21283',aliases:['The Straight Story']},
 {id:'d84',title:'Дюна',original:'Dune',year:1984,runtime:137,tmdbId:'11',aliases:['Dune','Дюна']},
 {id:'d21',title:'Дюна: Часть вторая',original:'Dune',year:2021,runtime:180,tmdbId:'438631',aliases:['Dune']},
 {id:'d22',title:'Дюна',original:'Dune',year:2022,runtime:180,tmdbId:'999',aliases:['Dune']},
 {id:'re',title:'Resident Evil',original:'Resident Evil',year:2002,runtime:100,tmdbId:'1576',aliases:['Resident Evil']}
];
const scanned=await vm.runInContext('scanEPG(stream,watchlist,now)',context);
const story=scanned.films.find(film=>film.id==='story');
const old=scanned.films.find(film=>film.id==='d84');
assert.equal(story.shows[0].basis,'title_unique');
assert.equal(story.shows[0].matchReason,null);
assert.equal(old.shows[0].basis,'title_duration');
assert.equal(old.shows[0].matchReason,'ambiguous_short_title_without_year');
const evil=scanned.films.find(film=>film.id==='re');
assert.equal(evil.shows[0].basis,'title_duration');
assert.equal(evil.shows[0].matchReason,'contradicted_runtime');
assert.equal(scanned.films.some(film=>film.id==='d21'||film.id==='d22'),false);
assert.equal(scanned.uncertain.some(item=>item.title==='Dune (2021)'&&item.reason==='ambiguous'),true);
assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/SCORED_RESOLUTION/);
console.log('Match hint: unique yearless title is unmarked, a short collision keeps the warning passed');
