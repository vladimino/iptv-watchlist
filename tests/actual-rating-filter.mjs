import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';

// AIR-585: «Моя оценка» filters the grid by the stored Letterboxd rating (actualRating), never by the prediction. «Любая» is no
// constraint; 3.5+ / 4.0+ / 4.5+ keep only a known valid rating at or above the threshold. Synthetic data only.
const html=fs.readFileSync('public/index.html','utf8');
const chanceAt=html.indexOf('<fieldset class="probability-filter">'),ratingAt=html.indexOf('<fieldset class="actual-rating-filter">');
assert.ok(chanceAt>0&&ratingAt>chanceAt,'«Моя оценка» sits after «Шанс 4.0+»');
const fieldset=html.slice(ratingAt,html.indexOf('</fieldset>',ratingAt));
assert.match(fieldset,/<legend>Моя оценка<\/legend>/);
assert.match(fieldset,/class="prediction-options" role="group"/,'the same 2×2 grid as «Прогноз» and «Шанс 4.0+»');
assert.deepEqual([...fieldset.matchAll(/data-min-actual-rating="([^"]+)" aria-pressed="(true|false)">([^<]+)</g)].map(m=>[m[1],m[2],m[3]]),
 [['any','true','Любая'],['3.5','false','3.5+'],['4','false','4.0+'],['4.5','false','4.5+']]);
const between=html.slice(chanceAt,ratingAt);assert.equal((between.match(/<fieldset/g)||[]).length,1,'directly under «Шанс 4.0+»');

const box=(extra={})=>({hidden:false,textContent:'',innerHTML:'',value:'',title:'',checked:false,disabled:false,className:'',classList:{remove(){},add(){},toggle(){},contains(){return false}},style:{},dataset:{},attrs:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k]??null},removeAttribute(){},querySelector(){return box()},querySelectorAll(){return []},addEventListener(){},focus(){},...extra});
const nodes=new Map();
const buttons=['any','3.5','4','4.5'].map(value=>box({dataset:{minActualRating:value}}));
const document={querySelector:selector=>{if(!nodes.has(selector))nodes.set(selector,box());return nodes.get(selector);},querySelectorAll:selector=>selector==='[data-min-actual-rating]'?buttons:[],documentElement:{classList:{toggle(){}}},addEventListener(){}};
const ctx=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,JSON,console,document,window:{history:{state:null,pushState(){},replaceState(){}},location:{href:'https://iptv.local/',pathname:'/',search:'',hash:''}}});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability')+'\n'+fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
const run=code=>vm.runInContext(code,ctx);

const now=Date.now();
const film=(id,title)=>({id,title,original:title,aliases:[],year:2020,runtime:100,genres:['Драма'],directors:[],actors:[],shows:[{start:now,offset:0}]});
ctx.sample=[
 film('r35','Оценка 3.5'),film('r40','Оценка 4.0'),film('r45','Оценка 4.5'),film('r50','Оценка 5'),film('r30','Оценка 3.0'),
 film('none','Без оценки, высокий прогноз'),film('watched','Просмотрен без оценки'),
 film('numeric-string','Строка-число'),film('bad-string','Строка'),film('bad-step','Не полшага'),film('bad-range','Вне диапазона'),film('bad-bool','Булево'),film('missing','Нет записи')
];
ctx.saved={films:{
 r35:{actualRating:3.5,prediction:{predictedRating:3,probability4Plus:.2}},
 r40:{actualRating:4,prediction:{predictedRating:3,probability4Plus:.1}},
 r45:{actualRating:4.5,prediction:null},
 r50:{actualRating:5,prediction:{predictedRating:4.5,probability4Plus:.9}},
 r30:{actualRating:3,prediction:{predictedRating:5,probability4Plus:.99}},
 none:{actualRating:null,prediction:{predictedRating:5,probability4Plus:.99}},
 watched:{actualRating:null,watched:true,prediction:{predictedRating:4.5,probability4Plus:.9}},
 'numeric-string':{actualRating:'4.5'},'bad-string':{actualRating:'abc'},'bad-step':{actualRating:4.2},'bad-range':{actualRating:6},'bad-bool':{actualRating:true}
}};
run('films=sample;enrichment=saved;ratingsLoaded=true;enrichmentUnavailable=false;WINDOW_START=CUTOFF-72*3600000;WINDOW_END=CUTOFF+24*3600000;state.sort="title";state.period="all"');
const ids=()=>Array.from(run('films.filter(eligible).map(f=>f.id)')).sort();
const all=ctx.sample.map(f=>f.id).sort();

// «Любая» is no constraint: films without a rating, with a broken rating or with no enrichment entry stay.
assert.deepEqual(ids(),all);
// Threshold boundaries, inclusive; the prediction never stands in for the rating; watched is not rated; invalid ratings never pass.
const at=threshold=>{ctx.threshold=threshold;run('state.minActualRating=threshold');return ids();};
// A numeric string is the rating the «МОЯ ОЦЕНКА» badge already shows (ratingValue), so it is filtered the same way.
assert.deepEqual(at(3.5),['numeric-string','r35','r40','r45','r50']);
assert.deepEqual(at(4),['numeric-string','r40','r45','r50'],'4.0 passes 4.0+, 3.5 does not');
assert.deepEqual(at(4.5),['numeric-string','r45','r50'],'4.0 fails 4.5+, 4.5 passes every threshold');
for(const t of [3.5,4,4.5]){const kept=at(t);for(const id of ['none','watched','bad-string','bad-step','bad-range','bad-bool','missing','r30'])assert.ok(!kept.includes(id),`${id} is excluded at ${t}+`);}

// Independent of the other filters and combined with AND; nothing is switched or cleared automatically.
run('state.minActualRating=4;state.viewing="rewatch"');assert.deepEqual(ids(),['numeric-string','r40','r45','r50']);
run('state.viewing="new"');assert.deepEqual(ids(),[],'«Новые» + a threshold is the honest empty set');
assert.equal(run('state.viewing'),'new','viewing is not switched by the rating filter');
run('state.viewing="any";state.minPrediction=4.5');assert.deepEqual(ids(),['r50'],'AND with «Прогноз»: the forecast threshold still reads the forecast');
run('state.minPrediction=null;state.minProbability=.85');assert.deepEqual(ids(),['r50'],'AND with «Шанс 4.0+»');
run('state.minProbability=null;state.query="оценка 4"');assert.deepEqual(ids(),['r40','r45'],'AND with search');
run('state.query="";state.minActualRating=null');assert.deepEqual(ids(),all);

// Film identity: the same resolution as «Пересмотр» (filmEnrichmentItem), so a rating that the item drops as conflicting does not pass.
assert.equal(run('ratingValue(filmEnrichmentItem(films.find(f=>f.id==="r40")))'),4);
const app=fs.readFileSync('public/app.js','utf8');
assert.match(app,/function meetsActualRating\(film\)\{[^\n]*ratingValue\(filmEnrichmentItem\(film\)\)/,'reads the stored rating through filmEnrichmentItem and ratingValue');
assert.doesNotMatch(app.match(/function meetsActualRating[^\n]*/)[0],/prediction/,'never reads the prediction');

// Before the ratings load: thresholds are disabled, a restored threshold excludes nothing it cannot prove, and the empty state says it is loading.
run('ratingsLoaded=false;enrichment={films:{}};state.minActualRating=4;render()');
assert.deepEqual(buttons.map(b=>b.disabled),[false,true,true,true],'thresholds are unavailable until the ratings load');
assert.deepEqual(buttons.map(b=>b.attrs['aria-pressed']),['false','false','true','false']);
assert.equal(nodes.get('#empty h2').textContent,'Загружаем оценки и прогнозы…','no false «Таких фильмов не найдено»');
assert.match(nodes.get('#empty p').textContent,/как только они загрузятся/);
run('enrichmentUnavailable=true;render()');assert.equal(nodes.get('#empty h2').textContent,'Таких фильмов не найдено');assert.match(nodes.get('#empty p').textContent,/Прогнозы сейчас недоступны/);
run('enrichmentUnavailable=false;enrichment=saved;ratingsLoaded=true;render()');
assert.deepEqual(buttons.map(b=>b.disabled),[false,false,false,false]);
assert.equal(nodes.get('#empty h2').textContent,'Таких фильмов не найдено');
assert.match(nodes.get('#filter-summary').textContent,/ · Моя оценка 4\.0\+/,'filter summary names the rating threshold');
assert.equal(Number.parseInt(nodes.get('#result-count').textContent),4,'the count reads the same filtered set');
assert.deepEqual(Array.from(run('buildShortlist(visibleFilms(),"available").map(x=>x.film.id)')).every(id=>['numeric-string','r40','r45','r50'].includes(id)),true,'the shortlist is drawn from the same set');

// Reset clears it; the default is «Любая».
run('reset()');assert.equal(run('state.minActualRating'),null);assert.equal(nodes.get('#filter-summary').textContent,'Все фильмы');

// applyFilters / filter_watchlist_programme: same validation as the other numeric thresholds.
for(const bad of [3,5,'4',0.5,Infinity,NaN]){ctx.bad=bad;assert.throws(()=>run('applyFilters({minActualRating:bad})'),/Invalid actual rating threshold/);}
assert.equal(run('state.minActualRating'),null,'a rejected value changes nothing');
let result=run('applyFilters({minActualRating:4.5})');assert.equal(result.minActualRating,4.5);assert.deepEqual(Array.from(result.films.map(f=>f.id)).sort(),['numeric-string','r45','r50']);
result=run('applyFilters({minPrediction:4})');assert.equal(run('state.minActualRating'),4.5,'omitted keeps the current value');
result=run('applyFilters({minActualRating:null,minPrediction:null})');assert.equal(result.minActualRating,null);assert.equal(result.films.length,all.length);
assert.match(app,/minActualRating:\{type:\['number','null'\],enum:\[null,3\.5,4,4\.5\]/,'the browser tool schema exposes the parameter');

// URL: `rating=3.5|4|4.5`, absent for «Любая»; invalid values fall back to «Любая»; other params, prediction and chance survive.
const read=url=>run(`readUrlState(new URL(${JSON.stringify(url)}))`);
const serialize=url=>run(`urlForState(new URL(${JSON.stringify(url)})).href`);
for(const [raw,want] of [['3.5',3.5],['4',4],['4.0',4],['4.5',4.5],['5',null],['3',null],['abc',null],['',null],['-4',null]])assert.equal(read('https://iptv.example/?rating='+raw).minActualRating,want,'rating='+raw);
assert.equal(read('https://iptv.example/').minActualRating,null,'no rating param is «Любая»');
const deep=read('https://iptv.example/?campaign=keep&viewing=rewatch&prediction=4&chance=0.7&rating=4.5#films');
assert.deepEqual([deep.viewing,deep.minPrediction,deep.minProbability,deep.minActualRating],['rewatch',4,.7,4.5]);
ctx.deep=deep;run('Object.assign(state,deep)');
const href=serialize('https://iptv.example/?campaign=keep&rating=bogus#films'),params=new URL(href).searchParams;
assert.deepEqual([params.get('campaign'),params.get('viewing'),params.get('prediction'),params.get('chance'),params.get('rating')],['keep','rewatch','4','0.7','4.5']);
assert.equal(new URL(href).hash,'#films');
assert.equal(serialize(href),href,'round trip is deterministic');
assert.equal(read(href).minActualRating,4.5,'reload / back / forward restore it through readUrlState');
run('state.minActualRating=null');assert.equal(new URL(serialize(href)).searchParams.has('rating'),false,'«Любая» writes nothing');
assert.ok(run('APP_QUERY_KEYS').includes('rating'),'rating is an app-owned key (stripped on reset, part of the preset key)');
// The state key differs, so a back/forward that only changes the rating is a real state change.
ctx.a={...deep,minActualRating:4};ctx.b={...deep,minActualRating:4.5};assert.notEqual(run('filterStateKey(a)'),run('filterStateKey(b)'));

// Presets keep the parameter on the server and compare it canonically on the page.
run('state.minActualRating=4');assert.match(run('presetQuery()'),/(^|&)rating=4(&|$)/);
assert.equal(run('presetKey("rating=4&viewing=rewatch")'),run('presetKey("viewing=rewatch&rating=4")'));
const presets=fs.readFileSync('src/filter-presets.js','utf8');
const normalize=vm.runInContext(presets.replace(/export\s+/g,'')+';normalizePresetQuery',vm.createContext({URL,URLSearchParams,Set,Map,Number,String,Object,Array,JSON,console,crypto:globalThis.crypto}));
assert.equal(normalize('viewing=rewatch&prediction=4&chance=0.7&rating=4.5'),'viewing=rewatch&prediction=4&chance=0.7&rating=4.5');
for(const bad of ['5','3','4.0','abc',''])assert.equal(normalize('rating='+bad),'','preset drops rating='+bad);

// Finds: no find is rated, so a «Моя оценка» threshold leaves the section empty (like «Пересмотр»).
run('reset()');let context=run('findsContext()');assert.equal(context.minActualRating,null);assert.equal(run('findsContextActive(findsContext())'),false);
run('state.minActualRating=3.5');context=run('findsContext()');assert.equal(run('findsContextActive(findsContext())'),true);
assert.equal(run('findsMatchesContext({id:"tmdb_1",title:"Находка",genres:[],prediction:{predictedRating:5,probability4Plus:.99}},findsContext(),Date.now(),null)'),false);

console.log('«Моя оценка»: placement, thresholds and boundaries, invalid and missing ratings, AND with other filters, loading state, summary, applyFilters, URL, presets and finds passed');
