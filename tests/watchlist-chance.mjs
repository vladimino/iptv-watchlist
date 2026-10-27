// Watchlist cards show P(4.0+) next to a current forecast, formatted like the Finds badge. Invalid, out-of-range or stale
// probabilities are hidden; an actual rating alone never shows one. Synthetic data only.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const ctx=vm.createContext({Date,Intl,Set,Map,document:{querySelector:()=>({})}});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
ctx.film={id:'one',title:'Фильм',original:'Film',year:2020,runtime:120,genres:['Драма'],shows:[],directors:[],actors:[]};
const card=item=>{ctx.input={profile:null,films:{one:item}};vm.runInContext('enrichment=input',ctx);return vm.runInContext('card(film)',ctx);};
const badge=html=>html.match(/<div class="score-badge score-predicted[^]*?<\/div>/)?.[0]||'';
const chance=(value,rest={})=>badge(card({actualRating:null,prediction:{predictedRating:3,probability4Plus:value,...rest}}));

// The shared helper: whole percent for a finite probability in [0, 1] next to a finite predicted rating.
const helper=value=>vm.runInContext(`chance4Plus(${JSON.stringify(value)})`,ctx);
assert.equal(helper({predictedRating:3,probability4Plus:0}),0);
assert.equal(helper({predictedRating:3,probability4Plus:.374}),37);
assert.equal(helper({predictedRating:3,probability4Plus:.995}),100);
assert.equal(helper({predictedRating:3,probability4Plus:1}),100);
for(const value of [null,undefined,'0.5',-0.01,1.01,{}])assert.equal(helper({predictedRating:3,probability4Plus:value}),null,'invalid '+JSON.stringify(value));
assert.equal(vm.runInContext('chance4Plus({predictedRating:3,probability4Plus:NaN})',ctx),null);
assert.equal(vm.runInContext('chance4Plus({predictedRating:3,probability4Plus:Infinity})',ctx),null);
assert.equal(helper({probability4Plus:.5}),null,'no forecast, no probability');
assert.equal(helper(null),null);

// Watchlist badge: 0, an intermediate value and 1 are shown, weak forecasts included (no Finds threshold).
let html=chance(0);assert.match(html,/<small>0% на 4\.0\+<\/small>/);assert.match(html,/aria-label="Прогноз 3\.0 из 5, шанс оценки 4 и выше 0%"/);
html=chance(.42);assert.match(html,/<small>42% на 4\.0\+<\/small>/);assert.match(html,/шанс оценки 4 и выше 42%/);
html=chance(1);assert.match(html,/<small>100% на 4\.0\+<\/small>/);
for(const value of [null,undefined,-0.2,1.5,'0.5']){html=chance(value);assert.ok(html.includes('score-predicted'),'forecast still shown');assert.doesNotMatch(html,/на 4\.0\+|шанс/,'hidden for '+JSON.stringify(value));}

// Stale: keep the existing label, do not present the probability as current.
html=chance(.8,{stale:true});assert.match(html,/<small>ожидает пересчёта<\/small>/);assert.doesNotMatch(html,/80%|на 4\.0\+/);assert.match(html,/aria-label="Прогноз 3\.0 из 5, ожидает пересчёта"/);

// Actual rating plus forecast: both badges, the probability stays on the forecast badge only.
html=card({actualRating:4.5,prediction:{predictedRating:3.5,probability4Plus:.61}});
const actual=html.match(/<div class="score-badge score-actual[^]*?<\/div>/)[0];
assert.doesNotMatch(actual,/%/);assert.match(badge(html),/<small>61% на 4\.0\+<\/small>/);
// Actual rating without a forecast: no probability anywhere.
html=card({actualRating:4.5,prediction:null});assert.doesNotMatch(html,/на 4\.0\+/);

// Finds uses the same helper and wording.
const finds=fs.readFileSync('public/app.js','utf8').match(/function findsCard[^]*?\n}/)[0];
assert.match(finds,/chance=chance4Plus\(p\)/);assert.match(finds,/\$\{chance\}% на 4\.0\+/);

// Compact badge next to an actual rating keeps room for the extra line.
const css=fs.readFileSync('public/styles.css','utf8');assert.ok(css.includes('.score-badge small{'));
console.log('Watchlist P(4.0+): shared helper, range and stale guards, actual + forecast layout and Finds parity passed');
