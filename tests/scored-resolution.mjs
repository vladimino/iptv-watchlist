import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync('src/domain/scored-resolution.js','utf8');
assert.doesNotMatch(source,/\b(fetch|import|export|BUCKET|wrangler)\b/);
for(const file of ['src/worker.js','src/discovery.js','src/enrichment.js','src/sources.js','build.mjs'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/scored-resolution|scoreFilmResolution/,file);
const ctx=vm.createContext({Map,Set,JSON});
vm.runInContext(source+'\nglobalThis.scoreFilmResolution=scoreFilmResolution;',ctx);
const film=(tmdbId,title,year,runtime,extra={})=>({tmdbId,title,original:title,year,runtime,...extra});
const observe=(key,title,year,duration,extra={})=>({key,title,normalizedTitle:title.toLowerCase(),year,duration,durations:[duration],...extra});
const run=input=>{ctx.input=input;return vm.runInContext('scoreFilmResolution(input)',ctx);};
const duneOld=film('11','Dune',1984,137,{trusted:true});
const duneNew=film('438631','Dune',2021,155);

let result=run({observation:observe('dune|1984','Dune',1984,137),candidates:[duneNew,duneOld]});
assert.equal(result.status,'accepted');
assert.equal(result.acceptedTmdbId,'11');
assert.equal(result.reason,'accepted_year_separates_remakes');
assert.equal(result.scorerVersion,1);
const reversed=run({observation:observe('dune|1984','Dune',1984,137),candidates:[duneOld,duneNew]});
assert.deepEqual(reversed,result);

result=run({observation:observe('dune|','Dune',null,137),candidates:[duneOld,duneNew]});
assert.equal(result.status,'ambiguous');
assert.equal(result.acceptedTmdbId,null);
assert.equal(result.reason,'ambiguous_short_title_without_year');

result=run({observation:observe('straight-story|','The Straight Story',null,112),candidates:[film('21283','The Straight Story',1999,111)]});
assert.equal(result.status,'accepted');
assert.equal(result.acceptedTmdbId,'21283');
assert.equal(result.reason,'accepted_unique_evidence');
assert.ok(result.confidence>=.82);

result=run({observation:observe('dune|1984','Dune',1984,137),candidates:[duneNew]});
assert.equal(result.status,'contradicted');
assert.equal(result.reason,'contradicted_year');
assert.equal(result.acceptedTmdbId,null);

result=run({observation:observe('stalker|1979','Stalker',1979,162),candidates:[film('2','Stalker',1979,80)]});
assert.equal(result.status,'contradicted');
assert.equal(result.reason,'contradicted_runtime');

const nearA=film('10','Same Title',1999,100);
const nearB=film('20','Same Title',1999,105);
result=run({observation:observe('same|1999','Same Title',1999,102),candidates:[nearB,nearA]});
assert.equal(result.status,'ambiguous');
assert.equal(result.reason,'ambiguous_collision');
assert.equal(result.considered[0].runtime.relation,'runtime_near');
assert.equal(result.considered[1].runtime.relation,'runtime_near');

result=run({observation:observe('dune|','Dune',null,137,{reviewedTitle:'Дюна'}),candidates:[duneOld]});
assert.equal(result.acceptedTmdbId,null);
assert.equal(result.reviewedTitle,undefined);
assert.equal(JSON.stringify(result).includes('Дюна'),false);

result=run({observation:observe('known|1999','Known Film',1999,120),candidates:[film('7','Known Film',1999,120,{trusted:true}),film('8','Known Film',2010,118,{trusted:true})]});
assert.equal(result.status,'accepted');
assert.equal(result.acceptedTmdbId,'7');
assert.equal(result.considered.find(row=>row.tmdbId==='7').trusted,true);
result=run({observation:observe('known|','Known Film',null,120),candidates:[film('7','Known Film',1999,120,{trusted:true}),film('8','Known Film',2010,118,{trusted:true})]});
assert.equal(result.status,'ambiguous');
assert.equal(result.acceptedTmdbId,null);
assert.equal(result.considered.length,2);
assert.equal(result.considered[0].uniqueness.competitors,2);

const story=film('21283','The Straight Story',1999,111);
const once=run({observation:observe('straight-story|','The Straight Story',null,112),candidates:[story]});
const watchlist=film('21283','Прямая история',1999,111,{trusted:true,original:'The Straight Story'});
const catalog={tmdbId:'21283',title:'Другое',original:'Другое',year:1999,runtime:111,aliases:['The Straight Story']};
const doubled=run({observation:observe('straight-story|','The Straight Story',null,112),candidates:[watchlist,catalog]});
const flipped=run({observation:observe('straight-story|','The Straight Story',null,112),candidates:[catalog,watchlist]});
assert.equal(doubled.status,'accepted');
assert.equal(doubled.acceptedTmdbId,once.acceptedTmdbId);
assert.equal(doubled.score,once.score);
assert.deepEqual(doubled,flipped);
assert.equal(doubled.considered.length,1);
assert.equal(doubled.considered[0].sources,2);
assert.equal(doubled.considered[0].uniqueness.competitors,1);
assert.equal(doubled.considered[0].title.source,'original');
const dated=observe('straight-story|1999','The Straight Story',1999,112);
const datedOnce=run({observation:dated,candidates:[story]});
const datedTwice=run({observation:dated,candidates:[story,catalog]});
assert.equal(datedTwice.status,datedOnce.status);
assert.equal(datedTwice.acceptedTmdbId,datedOnce.acceptedTmdbId);
assert.equal(datedTwice.score,datedOnce.score);
assert.equal(datedTwice.considered[0].uniqueness.value,1);

result=run({observation:observe('missing|','No Such Film',null,100),candidates:[film('9','Other Film',2001,100)]});
assert.equal(result.status,'no_confident_match');
assert.equal(result.reason,'no_exact_title');
assert.equal(result.observationKey,'missing|');
assert.equal(result.filmId,undefined);
console.log('Scored resolution: version-1 evidence, remakes, short titles and stable order passed');
