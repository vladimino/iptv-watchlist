import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped as scopedAvailability} from '../scripts/bundle-scope.mjs';
const AVAILABILITY_LIB=scopedAvailability('src/domain/film-availability.js','FilmAvailability')+'\n';

const ctx=vm.createContext({Date,Intl,Set,Map,URL,URLSearchParams});
vm.runInContext(AVAILABILITY_LIB+fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
vm.runInContext(fs.readFileSync('src/filter-presets.js','utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);
run(`CUTOFF=1000000000000;WINDOW_START=CUTOFF-72*3600000;WINDOW_END=CUTOFF+24*3600000;const show=channel=>({channel,start:CUTOFF+3600000,offset:1});films=[
 {id:'exact',title:'Побег',original:'Escape',aliases:['Ёжик'],year:2020,runtime:90,genres:['Драма'],directors:[{id:'nolan',name:'Нолан',original:'Nolan',aliases:['Кристофер Нолан']}],actors:[],synopsis:'',shows:[show('Первый')]},
 {id:'prefix',title:'Побег из тюрьмы',original:'Prison',aliases:[],year:2020,runtime:90,genres:['Драма'],directors:[],actors:[{id:'a',name:'Актёр',original:'Café Actor',aliases:['Кристофер']}],synopsis:'',shows:[show('Первый')]},
 {id:'blurb',title:'Другой',original:'Other',aliases:[],year:2020,runtime:90,genres:['Комедия'],directors:[],actors:[],synopsis:'В аннотации есть побег и космос.',shows:[show('Второй')]},
 {id:'bare',title:'Бета',original:'Beta',aliases:[],year:2020,runtime:90,genres:[],shows:[show('Первый')]},
 {id:'quiet',title:'Тихий',original:'Quiet',aliases:[],year:2020,runtime:90,genres:['Фантастика'],shows:[]},
 {id:'days',title:'28 дней спустя',original:'28 Days Later',aliases:['28 дней спустя'],year:2002,runtime:113,genres:['Ужасы'],directors:[{id:'boyle',name:'Дэнни Бойл',original:'Danny Boyle',aliases:['Бойл']}],actors:[],synopsis:'Вирус в Лондоне.',shows:[show('Первый')]},
 {id:'weeks',title:'28 недель спустя',original:'28 Weeks Later',aliases:[],year:2007,runtime:100,genres:['Ужасы'],directors:[],actors:[],synopsis:'Продолжение.',shows:[show('Первый')]},
 {id:'years',title:'28 лет спустя',original:'28 Years Later',aliases:[],year:2025,runtime:115,genres:['Ужасы'],directors:[],actors:[],synopsis:'Ещё одно продолжение.',shows:[show('Первый')]},
 {id:'robocop',title:'Робокоп',original:'RoboCop',aliases:[],year:2014,runtime:117,genres:['Боевик'],directors:[],actors:[{id:'weaver',name:'Сигурни Уивер',original:'Sigourney Weaver',aliases:['Уивер']}],synopsis:'Действие перенесено в 2028 год.',shows:[show('Первый')]},
];enrichment={films:{
 exact:{fingerprint:{plotMechanics:['heist'],moodIds:['dark']}},
 prefix:{fingerprint:{plotMechanics:['rescue'],moodIds:['tense']}},
 blurb:{fingerprint:{plotMechanics:[],moodIds:[]}},
}};ratingsLoaded=true`);
const ids=()=>JSON.parse(run('JSON.stringify(visibleFilms().map(film=>film.id))'));
assert.equal(run('normalizeSearch("  Café,  ёжик! ")'),'cafe ежик');
assert.equal(run('JSON.stringify(state.searchScopes)'),JSON.stringify({titles:true,people:false,plot:false}));
// AIR-626: the query decides which films are listed; the sort (here «Название · А–Я») only orders them.
run('state.sort="title";state.sortExplicit=true;state.query="побег"');
assert.deepEqual(ids(),['exact','prefix'],'titles are the default and a synopsis mention stays out');
run('state.searchScopes={titles:true,people:false,plot:true}');
assert.deepEqual(ids(),['blurb','exact','prefix'],'plot adds the synopsis match');
run('state.searchScopes={titles:false,people:false,plot:true}');
assert.deepEqual(ids(),['blurb'],'titles off ignores an exact title');
assert.equal(run('searchRank(films.find(film=>film.id==="exact"),"побег",["побег"])'),null);
assert.equal(run('searchRank(films.find(film=>film.id==="blurb"),"побег",["побег"])'),5);
run('state.searchScopes={titles:true,people:false,plot:false};state.query="Ёжик"');
assert.deepEqual(ids(),['exact'],'ё and е match a title alias');
run('state.query="cafe"');
assert.deepEqual(ids(),[],'a person stays hidden while people is off');
run('state.searchScopes={titles:false,people:true,plot:false}');
assert.deepEqual(ids(),['prefix'],'Latin diacritics fold in a person name');
run('state.query="кристофер нолан"');
assert.deepEqual(ids(),['exact'],'every word must match the same film');
run('state.query="кристофер"');
assert.deepEqual(ids().sort(),['exact','prefix']);
run('state.searchScopes={titles:true,people:true,plot:false};state.query="кристофер побег"');
assert.deepEqual(ids(),['exact','prefix'],'words may match different enabled scopes of one film');
run('state.searchScopes={titles:false,people:false,plot:true};state.query="ограб"');
assert.deepEqual(ids(),['exact'],'a mechanic is found by its Russian label');
run('state.query="мрачн"');
assert.deepEqual(ids(),['exact'],'a mood is found by its Russian label');
run('state.query="космос"');
assert.deepEqual(ids(),['blurb']);
run('state.query="фантаст";state.includeUnscheduled=true');
assert.deepEqual(ids(),['quiet'],'search reaches the full watchlist');
run('state.includeUnscheduled=false;state.searchScopes={titles:true,people:false,plot:false};state.genres=new Set(["Драма"]);state.query="побег"');
assert.deepEqual(ids(),['exact','prefix'],'search stays AND with the genre');
run('state.genres=new Set();state.searchScopes={titles:true,people:false,plot:true};state.channels=new Set(["Второй"]);state.query="побег"');
assert.deepEqual(ids(),['blurb'],'search stays AND with the channel');
run('state.channels=new Set();state.searchScopes={titles:true,people:false,plot:false};state.query="бета"');
assert.deepEqual(ids(),['bare'],'a film without synopsis or fingerprint still matches its title');
const first=run('searchCache');
run('enrichment={films:{bare:{fingerprint:{moodIds:["light"]}}}}');
run('state.searchScopes={titles:false,people:false,plot:true};state.query="лёгк"');
assert.deepEqual(ids(),['bare'],'replacing enrichment makes the new mood searchable');
assert.notEqual(run('searchCache'),first);
run('state.searchScopes={titles:true,people:false,plot:false};state.query="28";state.sort="title"');
assert.deepEqual(ids(),['days','years','weeks'],'28 matches the titled series and not a year hidden in a synopsis');
assert.equal(ids().includes('robocop'),false);
run('state.searchScopes={titles:true,people:false,plot:true}');
assert.deepEqual(ids(),['days','years','weeks','robocop'],'plot then includes the synopsis year');
run('state.searchScopes={titles:false,people:true,plot:false};state.query="сигурни"');
assert.deepEqual(ids(),['robocop'],'an actor matches only with people on');
run('state.searchScopes={titles:true,people:false,plot:false}');
assert.deepEqual(ids(),[],'the same actor stays out of titles');
run('state.searchScopes={titles:false,people:true,plot:false};state.query="бойл"');
assert.deepEqual(ids(),['days']);
run('state.query="28 спустя";state.searchScopes={titles:true,people:true,plot:true}');
assert.deepEqual(ids().sort(),['days','weeks','years']);
// AIR-626: typing, changing and clearing the query keep the sort, the implicit default included.
run('state.query="";state.sort="personal";state.sortExplicit=false');
run('applySearchInput("нолан")');
assert.equal(run('state.sort'),'personal');
assert.equal(run('state.sortExplicit'),false);
run('applySearchInput("нолан и")');
assert.equal(run('state.sort'),'personal');
run('applySearchInput("")');
assert.equal(run('state.sort'),'personal');
run('state.sort="personal";state.sortExplicit=true;applySearchInput("нолан")');
assert.equal(run('state.sort'),'personal');
run('state.sort="title";state.sortExplicit=true;state.query="";applySearchInput("нолан")');
assert.equal(run('state.sort'),'title');
run('state.query="нолан";state.sort="personal";state.sortExplicit=false');
run('state.searchScopes={titles:true,people:false,plot:false}');
const linked=run('urlForState("https://iptv.example/?campaign=save").search');
assert.match(linked,/q=/);
assert.doesNotMatch(linked,/sort=/,'a query with the implicit default writes no sort');
assert.match(linked,/campaign=save/);
assert.doesNotMatch(linked,/searchIn=/);
run('state.sort="title";state.sortExplicit=true');
assert.match(run('urlForState("https://iptv.example/").search'),/sort=title/);
// An old link with the retired `sort=relevance` and a query: the default sort, the query kept, the parameter dropped on the next write.
const restored=run('readUrlState(new URL("https://iptv.example/?q=нолан&sort=relevance"))');
assert.equal(restored.sort,'personal');
assert.equal(restored.sortExplicit,false);
assert.equal(restored.query,'нолан');
run('Object.assign(state,readUrlState(new URL("https://iptv.example/?q=нолан&sort=relevance&searchIn=people&genre=Драма&campaign=save")))');
assert.equal(run('urlForState("https://iptv.example/?q=нолан&sort=relevance&searchIn=people&genre=Драма&campaign=save").search'),'?campaign=save&q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD&searchIn=people&genre=%D0%94%D1%80%D0%B0%D0%BC%D0%B0','the retired sort is dropped; the query, scopes, genre and a foreign parameter stay');
run('state.genres=new Set()');
const alphabetical=run('readUrlState(new URL("https://iptv.example/?q=нолан&sort=title"))');
assert.equal(alphabetical.sort,'title');
assert.equal(alphabetical.sortExplicit,true);
const saved=new URLSearchParams(run('normalizePresetQuery("q=нолан&sort=relevance&campaign=save")'));
assert.equal(saved.get('q'),'нолан');
assert.equal(saved.get('sort'),null,'a saved preset with the retired sort opens with the default');
assert.equal(saved.get('campaign'),null);
assert.equal(saved.get('searchIn'),null);
const peoplePreset=new URLSearchParams(run('normalizePresetQuery("q=28&searchIn=people,people,bogus&sort=relevance")'));
assert.equal(peoplePreset.get('searchIn'),'people');
const combinedPreset=new URLSearchParams(run('normalizePresetQuery("searchIn=plot,titles&q=28")'));
assert.equal(combinedPreset.get('searchIn'),'titles,plot');
assert.equal(new URLSearchParams(run('normalizePresetQuery("q=28&searchIn=titles")')).get('searchIn'),null);
assert.equal(peoplePreset.get('sort'),null);
run('state.query="28";state.sort="personal";state.sortExplicit=false;state.searchScopes={titles:false,people:true,plot:false}');
assert.equal(run('presetQuery()'),'q=28&searchIn=people','a new preset with a query does not record a sort');
const titlesOnly=run('readUrlState(new URL("https://iptv.example/?q=28"))');
assert.equal(JSON.stringify(titlesOnly.searchScopes),JSON.stringify({titles:true,people:false,plot:false}));
assert.equal(titlesOnly.sort,'personal','a query alone keeps the default sort');
run('Object.assign(state,readUrlState(new URL("https://iptv.example/?q=28&searchIn=people,plot")))');
assert.equal(run('JSON.stringify(state.searchScopes)'),JSON.stringify({titles:false,people:true,plot:true}));
assert.equal(run('urlForState("https://iptv.example/").search'),'?q=28&searchIn=people%2Cplot');
const titlesKey=run('filterStateKey(readUrlState(new URL("https://iptv.example/?q=28")))');
const plotKey=run('filterStateKey(readUrlState(new URL("https://iptv.example/?q=28&searchIn=titles,plot")))');
assert.notEqual(titlesKey,plotKey);
run('state.searchScopes={titles:true,people:true,plot:false}');
assert.equal(run('setSearchScope("titles",false)'),true);
assert.equal(run('setSearchScope("people",false)'),false);
assert.equal(run('JSON.stringify(state.searchScopes)'),JSON.stringify({titles:false,people:true,plot:false}));
run('state.query="28";state.searchScopes={titles:false,people:true,plot:true};state.sort="personal";state.sortExplicit=true');
assert.equal(run('state.sort'),'personal');

// AIR-626: each of the three sorts lists exactly the films the query matches, in its own order; the search never reorders by match quality.
// Titles: Аврора < Бета < Вега. «Для меня»: Бета 4.5 predicted, Вега 4 own rating, Аврора 3. «Сначала исчезающие»: Вега leaves the
// archive first (aired 70 h ago), then Аврора (40 h), then Бета (10 h). «Гамма» does not match the query.
run(`viewClock=CUTOFF;const aired=hours=>({channel:'Первый',start:CUTOFF-hours*3600000,end:CUTOFF-hours*3600000+2*3600000});const film=(id,title,hours)=>({id,title,original:title,aliases:[],year:2001,runtime:90,genres:['Драма'],directors:[],actors:[],synopsis:'',shows:[aired(hours)]});films=[
 film('a','Аврора 28',40),film('b','Бета 28',10),film('c','Вега 28',70),film('g','Гамма',50),
];enrichment={films:{a:{prediction:{predictedRating:3,probability4Plus:0.3}},b:{prediction:{predictedRating:4.5,probability4Plus:0.9}},c:{actualRating:4}}};
state.genres=new Set();state.channels=new Set();state.mechanics=new Set();state.moods=new Set();state.includeUnscheduled=false;state.period='all';state.searchScopes=defaultSearchScopes();state.query=''`);
const orders={title:['a','b','c'],personal:['b','c','a'],expiring:['c','a','b']};
for(const [sort,order] of Object.entries(orders)){
 run(`state.sort=${JSON.stringify(sort)};state.sortExplicit=${sort!=='personal'};state.query=''`);
 const all=ids();
 assert.deepEqual([...all].sort(),['a','b','c','g'],sort+': no query lists every film');
 run('applySearchInput("28")');
 assert.equal(run('state.sort'),sort,sort+': typing a query keeps the sort');
 assert.deepEqual(ids(),order,sort+': the matches in the order of the chosen sort');
 run('applySearchInput("")');
 assert.equal(run('state.sort'),sort,sort+': clearing the query keeps the sort');
 assert.deepEqual(ids(),all,sort+': clearing restores the same list');
}
console.log('Content search: folded text, same-film words, membership with each of the three sorts, query keeps the sort, retired relevance links and presets passed');
