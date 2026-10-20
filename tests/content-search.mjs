import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ctx=vm.createContext({Date,Intl,Set,Map,URL,URLSearchParams});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
vm.runInContext(fs.readFileSync('src/filter-presets.js','utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);
run(`CUTOFF=1000000000000;WINDOW_START=CUTOFF-72*3600000;WINDOW_END=CUTOFF+24*3600000;const show=channel=>({channel,start:CUTOFF+3600000,offset:1});films=[
 {id:'exact',title:'Побег',original:'Escape',aliases:['Ёжик'],year:2020,runtime:90,genres:['Драма'],directors:[{id:'nolan',name:'Нолан',original:'Nolan',aliases:['Кристофер Нолан']}],actors:[],synopsis:'',shows:[show('Первый')]},
 {id:'prefix',title:'Побег из тюрьмы',original:'Prison',aliases:[],year:2020,runtime:90,genres:['Драма'],directors:[],actors:[{id:'a',name:'Актёр',original:'Café Actor',aliases:['Кристофер']}],synopsis:'',shows:[show('Первый')]},
 {id:'blurb',title:'Другой',original:'Other',aliases:[],year:2020,runtime:90,genres:['Комедия'],directors:[],actors:[],synopsis:'В аннотации есть побег и космос.',shows:[show('Второй')]},
 {id:'bare',title:'Бета',original:'Beta',aliases:[],year:2020,runtime:90,genres:[],shows:[show('Первый')]},
 {id:'quiet',title:'Тихий',original:'Quiet',aliases:[],year:2020,runtime:90,genres:['Фантастика'],shows:[]},
];enrichment={films:{
 exact:{fingerprint:{plotMechanics:['heist'],moodIds:['dark']}},
 prefix:{fingerprint:{plotMechanics:['rescue'],moodIds:['tense']}},
 blurb:{fingerprint:{plotMechanics:[],moodIds:[]}},
}};ratingsLoaded=true`);
const ids=()=>JSON.parse(run('JSON.stringify(visibleFilms().map(film=>film.id))'));
assert.equal(run('normalizeSearch("  Café,  ёжик! ")'),'cafe ежик');
run('state.sort="relevance";state.query="побег"');
assert.deepEqual(ids(),['exact','prefix','blurb'],'exact title, then prefix, then a synopsis mention');
run('state.query="Ёжик"');
assert.deepEqual(ids(),['exact'],'ё and е match a title alias');
run('state.query="cafe"');
assert.deepEqual(ids(),['prefix'],'Latin diacritics fold in a person name');
run('state.query="кристофер нолан"');
assert.deepEqual(ids(),['exact'],'every word must match the same film');
run('state.query="кристофер"');
assert.deepEqual(ids().sort(),['exact','prefix']);
run('state.query="ограб"');
assert.deepEqual(ids(),['exact'],'a mechanic is found by its Russian label');
run('state.query="мрачн"');
assert.deepEqual(ids(),['exact'],'a mood is found by its Russian label');
run('state.query="космос"');
assert.deepEqual(ids(),['blurb']);
run('state.query="фантаст";state.includeUnscheduled=true');
assert.deepEqual(ids(),['quiet'],'search reaches the full watchlist');
run('state.includeUnscheduled=false;state.genres=new Set(["Драма"]);state.query="побег"');
assert.deepEqual(ids(),['exact','prefix'],'search stays AND with the genre');
run('state.genres=new Set();state.channels=new Set(["Второй"]);state.query="побег"');
assert.deepEqual(ids(),['blurb'],'search stays AND with the channel');
run('state.channels=new Set();state.query="бета"');
assert.deepEqual(ids(),['bare'],'a film without synopsis or fingerprint still matches its title');
const first=run('searchCache');
run('enrichment={films:{bare:{fingerprint:{moodIds:["light"]}}}}');
run('state.query="лёгк"');
assert.deepEqual(ids(),['bare'],'replacing enrichment makes the new mood searchable');
assert.notEqual(run('searchCache'),first);
run('state.query="";state.sort="title";state.sortExplicit=false');
run('applySearchInput("нолан")');
assert.equal(run('state.sort'),'relevance');
assert.equal(run('state.sortExplicit'),false);
run('applySearchInput("")');
assert.equal(run('state.sort'),'title');
run('state.sort="personal";state.sortExplicit=true;applySearchInput("нолан")');
assert.equal(run('state.sort'),'personal');
run('state.sort="title";state.sortExplicit=true;state.query="";applySearchInput("нолан")');
assert.equal(run('state.sort'),'title');
run('state.query="нолан";state.sort="relevance";state.sortExplicit=false');
const linked=run('urlForState("https://iptv.example/?campaign=save").search');
assert.match(linked,/q=/);
assert.match(linked,/sort=relevance/);
assert.match(linked,/campaign=save/);
run('state.sort="title";state.sortExplicit=true');
assert.match(run('urlForState("https://iptv.example/").search'),/sort=title/);
const restored=run('readUrlState(new URL("https://iptv.example/?q=нолан&sort=relevance"))');
assert.equal(restored.sort,'relevance');
assert.equal(restored.sortExplicit,false);
const alphabetical=run('readUrlState(new URL("https://iptv.example/?q=нолан&sort=title"))');
assert.equal(alphabetical.sort,'title');
assert.equal(alphabetical.sortExplicit,true);
const saved=new URLSearchParams(run('normalizePresetQuery("q=нолан&sort=relevance&campaign=save")'));
assert.equal(saved.get('q'),'нолан');
assert.equal(saved.get('sort'),'relevance');
assert.equal(saved.get('campaign'),null);
console.log('Content search: folded text, same-film words, relevance order, explicit sort and preset query passed');
