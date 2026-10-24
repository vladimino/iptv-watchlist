import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,'');
const hour=3600000;
const clock=Date.parse('2026-10-24T12:00:00Z');
const confirmed='https://letterboxd.com/film/heat-1995/';

function channelsIn(html,type){
 const start=html.indexOf(`<section class="show-group ${type}">`);
 if(start<0)return [];
 const rest=html.slice(start);
 const next=rest.indexOf('<section class="show-group ',1);
 const body=next<0?rest:rest.slice(0,next);
 return [...body.matchAll(/data-channel="([^"]*)"/g)].map(match=>match[1].replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
}

const plain=vm.createContext({Date,Intl,Set,Map,URL,URLSearchParams,document:{querySelector:()=>({})}});
vm.runInContext(source,plain);
const runPlain=code=>vm.runInContext(code,plain);
runPlain(`viewClock=${clock};CUTOFF=${clock};WINDOW_START=${clock-72*hour};WINDOW_END=${clock+24*hour}`);
plain.shows=[
 {channel:'Альфа',start:clock-4*hour,end:clock-3*hour},
 {channel:'Бета',start:clock-4*hour,end:clock-3*hour},
 {channel:'Первый',start:clock-5*hour,end:clock-4*hour},
 {channel:'Второй',start:clock-hour,end:clock},
 {channel:'Третий',start:clock-3*hour,end:clock-2*hour},
 {channel:'Второй',start:clock+hour,end:clock+2*hour},
 {channel:'Четвёртый',start:clock+2*hour,end:clock+3*hour},
 {channel:'Первый',start:clock+3*hour,end:clock+4*hour},
 {channel:'Старый',start:clock-80*hour,end:clock-79*hour},
 {channel:'Первый',start:clock-72*hour,end:clock-71*hour},
];
plain.film={id:'lid-not-a-slug',title:'Жара',original:'Heat',year:1995,runtime:170,genres:['Драма'],directors:[],actors:[],shows:plain.shows,url:confirmed};
runPlain(`state.channels=new Set(['Первый'])`);
const startsBefore=plain.shows.map(show=>show.start);
let card=runPlain('card(film)');
assert.deepEqual(plain.shows.map(show=>show.start),startsBefore);
assert.equal(plain.shows[0].channel,'Альфа');
assert.match(card,/href="https:\/\/letterboxd\.com\/film\/heat-1995\/"/);
assert.match(card,/target="_blank"/);
assert.match(card,/rel="noopener noreferrer"/);
assert.match(card,/aria-label="Открыть в Letterboxd"/);
assert.match(card,/title="Открыть в Letterboxd"/);
const mark=card.match(/<svg class="letterboxd-mark"[\s\S]*?<\/svg>/);
assert.ok(mark,'the Letterboxd action includes its own mark');
const circles=[...mark[0].matchAll(/<circle\b[^>]*>/g)].map(item=>item[0]);
assert.equal(circles.length,3);
const circleAttr=(tag,name)=>Number(tag.match(new RegExp(`\\b${name}="([\\d.]+)"`))[1]);
const geometry=circles.map(tag=>({cx:circleAttr(tag,'cx'),r:circleAttr(tag,'r'),fill:tag.match(/fill="([^"]+)"/)[1]}));
assert.deepEqual(geometry.map(circle=>circle.fill),['#ff8000','#00e054','#40bcf4']);
assert.ok(geometry.every(circle=>circle.r>0));
assert.ok(Math.abs(geometry[1].cx-geometry[0].cx)<geometry[0].r+geometry[1].r,'the green circle overlaps the orange circle');
assert.ok(Math.abs(geometry[2].cx-geometry[1].cx)<geometry[1].r+geometry[2].r,'the blue circle overlaps the green circle');
assert.ok(Math.abs(geometry[2].cx-geometry[0].cx)>geometry[0].r+geometry[2].r,'the orange and blue circles meet only through the green circle');
assert.match(mark[0],/mix-blend-mode:screen/);
assert.doesNotMatch(mark[0],/currentColor|url\(|@font-face|<text\b/);
const cardCss=fs.readFileSync('public/styles.css','utf8');
assert.match(cardCss,/\.letterboxd-link:focus-visible\{outline:2px solid var\(--lime\);outline-offset:3px\}/);
assert.match(cardCss,/\.letterboxd-link:hover svg\{filter:brightness\(1\.16\)\}/);
assert.doesNotMatch(cardCss,/\.letterboxd-link(?!:)\{[^}]*color:/);
assert.equal(card.match(/letterboxd\.com/g).length,1);
assert.doesNotMatch(card,/letterboxd\.com\/film\/lid-not-a-slug/);
assert.doesNotMatch(card,/letterboxd\.com\/film\/zhara|letterboxd\.com\/film\/жара/i);
assert.deepEqual(channelsIn(card,'archive'),['Первый','Второй','Третий','Альфа','Бета']);
assert.deepEqual(channelsIn(card,'future'),['Первый','Второй','Четвёртый']);
assert.doesNotMatch(card,/Старый/);
assert.equal((card.match(/data-channel="Первый"/g)||[]).length,2,'the exact 72h boundary stays out of both groups');

runPlain('state.channels=new Set()');
card=runPlain('card(film)');
assert.deepEqual(channelsIn(card,'archive'),['Второй','Третий','Альфа','Бета','Первый']);
assert.deepEqual(channelsIn(card,'future'),['Второй','Четвёртый','Первый']);

runPlain(`state.channels=new Set(['Первый','Второй'])`);
card=runPlain('card(film)');
assert.deepEqual(channelsIn(card,'archive'),['Второй','Первый','Третий','Альфа','Бета']);
assert.deepEqual(channelsIn(card,'future'),['Второй','Первый','Четвёртый']);
runPlain(`state.period='archive'`);
card=runPlain('card(film)');
assert.match(card,/АРХИВ/);
assert.doesNotMatch(card,/ДАЛЬШЕ/);
assert.doesNotMatch(card,/Четвёртый/);
runPlain(`state.period='future'`);
card=runPlain('card(film)');
assert.match(card,/ДАЛЬШЕ/);
assert.doesNotMatch(card,/АРХИВ/);
assert.doesNotMatch(card,/Альфа/);
assert.deepEqual(channelsIn(card,'future'),['Второй','Первый','Четвёртый']);
runPlain(`state.period='all';state.channels=new Set()`);

for(const url of [
 'https://letterboxd.com/film/Heat-1995/',
 'https://letterboxd.com/film/heat-1995',
 'https://letterboxd.com/film/heat-1995/?ref=guess',
 'http://letterboxd.com/film/heat-1995/',
 'https://www.letterboxd.com/film/heat-1995/',
 'https://letterboxd.com/vladimino/film/heat-1995/',
 'https://example.com/film/heat-1995/',
]){
 plain.film.url=url;
 assert.equal(runPlain('letterboxdHref(film)'),'');
 assert.doesNotMatch(runPlain('card(film)'),/letterboxd/i);
}
plain.film.url=undefined;
assert.doesNotMatch(runPlain('card(film)'),/letterboxd/i);
plain.film.url=confirmed;
const quoted=runPlain(`row({channel:'Кино "HD"',start:${clock-hour},end:${clock},basis:'title_duration',matchReason:'ambiguous_margin'})`);
assert.match(quoted,/data-channel="Кино &quot;HD&quot;"/);
assert.match(quoted,/class="match-hint"/);
assert.match(quoted,/<button type="button" class="channel-filter"/);

const nodes=new Map();
function element(){
 return {innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,open:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},focus(){},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){}};
}
function query(selector){if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector);}
const stack=[];
let index=0;
const window={
 scrollY:0,
 location:{href:'https://iptv.example/'},
 history:{
  get state(){return stack[index]?.state??null;},
  pushState(state,_title,url){stack.splice(index+1);stack.push({href:new URL(url,window.location.href).href,state});index++;window.location.href=stack[index].href;},
  replaceState(state,_title,url){stack[index]={href:new URL(url,window.location.href).href,state};window.location.href=stack[index].href;},
  back(){if(index===0)return;index--;window.location.href=stack[index].href;run('onHistoryNavigation()');},
  forward(){if(index>=stack.length-1)return;index++;window.location.href=stack[index].href;run('onHistoryNavigation()');},
 },
};
let fetches=0;
const live=vm.createContext({
 Date,Intl,Set,Map,URL,URLSearchParams,JSON,window,document:{
  documentElement:{classList:{toggle(){}}},
  querySelector:query,
  querySelectorAll(){return [];},
  addEventListener(){},
 },
 fetch(){fetches++;throw new Error('unexpected write');},
});
vm.runInContext(source,live);
const run=code=>vm.runInContext(code,live);
run(`viewClock=${clock};CUTOFF=${clock};WINDOW_START=${clock-72*hour};WINDOW_END=${clock+24*hour};report=null`);
live.film={id:'lid-not-a-slug',title:'Жара',original:'Heat',year:1995,runtime:170,genres:['Драма'],directors:[],actors:[],shows:plain.shows.map(show=>({...show})),url:confirmed,synopsis:'Жара в городе'};
run(`films=[film];enrichment={profile:null,films:{'lid-not-a-slug':{actualRating:4.5,fingerprint:{plotMechanics:['heist']}}}};presets=[{id:'evening',name:'Вечер',query:'q=old'}];state.query='жара';state.sort='personal';state.genres=new Set(['Драма']);state.mechanics=new Set(['heist']);state.channels=new Set(['Первый']);urlReady=true`);
const startHref=run(`urlForState('https://iptv.example/?campaign=save#films').href`);
stack.push({href:startHref,state:null});
window.location.href=startHref;
const presetBefore=run('presets.map(item=>item.query)');
run(`onMovieClick({target:{closest(selector){return selector==='[data-channel]'?{dataset:{channel:'Второй'}}:null;}},preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}})`);
assert.equal(fetches,0);
const same=(code,value)=>assert.equal(JSON.stringify(run(code)),JSON.stringify(value));
same('[...state.channels].sort()',['Второй','Первый']);
assert.equal(run('state.query'),'жара');
assert.equal(run('state.sort'),'personal');
same('[...state.genres]',['Драма']);
same('[...state.mechanics]',['heist']);
same('presets.map(item=>item.query)',presetBefore);
const added=new URL(window.location.href);
assert.deepEqual(added.searchParams.getAll('channel'),['Второй','Первый']);
assert.equal(added.searchParams.get('q'),'жара');
assert.equal(added.searchParams.get('sort'),'personal');
assert.deepEqual(added.searchParams.getAll('genre'),['Драма']);
assert.deepEqual(added.searchParams.getAll('mechanic'),['heist']);
assert.equal(added.searchParams.get('campaign'),'save');
assert.equal(added.hash,'#films');
assert.match(nodes.get('#movies').innerHTML,/href="https:\/\/letterboxd\.com\/film\/heat-1995\/"/);
assert.match(nodes.get('#shortlist-cards').innerHTML,/href="https:\/\/letterboxd\.com\/film\/heat-1995\/"/);
assert.deepEqual(channelsIn(nodes.get('#movies').innerHTML,'archive'),['Второй','Первый','Третий','Альфа','Бета']);
assert.equal(run('presetQuery().includes("channel=")&&presetQuery().includes("q=")&&presetQuery().includes("mechanic=heist")'),true);
const lengthAfterAdd=stack.length;
run(`onMovieClick({target:{closest(selector){return selector==='[data-channel]'?{dataset:{channel:'Второй'}}:null;}},preventDefault(){},stopPropagation(){}})`);
assert.equal(stack.length,lengthAfterAdd,'a selected channel is not added again and does not create another history entry');
run(`onMovieClick({target:{closest(){return null;}},preventDefault(){},stopPropagation(){}})`);
assert.equal(fetches,0);
assert.equal(stack.length,lengthAfterAdd);
window.history.back();
same('[...state.channels]',['Первый']);
assert.equal(run('state.query'),'жара');
same('[...state.genres]',['Драма']);
same('[...state.mechanics]',['heist']);
window.history.forward();
same('[...state.channels].sort()',['Второй','Первый']);
assert.equal(run('state.sort'),'personal');
assert.equal(fetches,0);
assert.equal(run('films[0].shows[0].channel'),'Альфа');
console.log('Film card actions: confirmed Letterboxd link, channel OR filter, history and display order passed');
