import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html=fs.readFileSync('public/index.html','utf8');
const ratings=vm.runInNewContext(fs.readFileSync('src/ratings-seed.js','utf8')+'\nINITIAL_PERSONAL_RATINGS');
assert.equal(Object.keys(ratings).length,0,'The public seed must not contain personal ratings');
assert.match(html,/data-viewing="any"[^>]*aria-pressed="true"/);
assert.match(html,/data-viewing="new"/);
assert.match(html,/data-viewing="rewatch"/);

const ctx=vm.createContext({Date,Intl,Set,Map});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
ctx.rated={id:'rated',title:'Фильм',original:'Film',aliases:[],year:2020,runtime:100,genres:['Драма'],directors:[],actors:[]};
ctx.unrated={...ctx.rated,id:'unrated'};
ctx.input={profile:null,films:{rated:{actualRating:3.5,prediction:null},unrated:{actualRating:null,prediction:{predictedRating:5}}}};
vm.runInContext('enrichment=input;ratingsLoaded=true;state.viewing="rewatch"',ctx);
assert.equal(vm.runInContext('eligible(rated)',ctx),true);
assert.equal(vm.runInContext('eligible(unrated)',ctx),false,'A predicted rating does not make a rewatch');
vm.runInContext('state.viewing="new"',ctx);
assert.equal(vm.runInContext('eligible(rated)',ctx),false);
assert.equal(vm.runInContext('eligible(unrated)',ctx),true);
vm.runInContext('ratingsLoaded=false',ctx);
assert.equal(vm.runInContext('eligible(unrated)',ctx),false,'Unavailable rating data must not label everything new');
console.log('Viewing: empty public rating seed, three-way filter, prediction isolation and unavailable-data guard passed');
