import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,'');
const hour=3600000;
const clock=Date.parse('2026-10-24T12:00:00Z');
const nodes=new Map();
function element(selector){
 return {selector,innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,open:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},focus(){},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){}};
}
function query(selector){if(!nodes.has(selector))nodes.set(selector,element(selector));return nodes.get(selector);}
const fetches=[];
const stack=[];
let index=-1;
const window={
 scrollY:0,
 scrollTo(_x,y){window.scrollY=y;},
 location:{href:'https://iptv.example/film/heat-1995'},
 history:{
  get state(){return index>=0?stack[index].state:null;},
  pushState(state,_title,url){stack.splice(index+1);stack.push({href:new URL(url,window.location.href).href,state});index++;window.location.href=stack[index].href;},
  replaceState(state,_title,url){if(index<0){stack.push({href:new URL(url,window.location.href).href,state});index=0;}else stack[index]={href:new URL(url,window.location.href).href,state};window.location.href=stack[index].href;},
  back(){if(index<=0)return;index--;window.location.href=stack[index].href;run('onHistoryNavigation()');},
  forward(){if(index>=stack.length-1)return;index++;window.location.href=stack[index].href;run('onHistoryNavigation()');},
 },
};
const live=vm.createContext({
 Date,Intl,Set,Map,URL,URLSearchParams,JSON,window,document:{
  documentElement:{classList:{toggle(){},add(){},remove(){}}},
  querySelector:query,
  querySelectorAll(){return [];},
  addEventListener(){},
 },
 fetch(url,options){fetches.push({url:String(url),method:options?.method||'GET'});throw new Error('film page render must not fetch');},
});
vm.runInContext(source,live);
const run=code=>vm.runInContext(code,live);
run(`viewClock=${clock};CUTOFF=${clock};WINDOW_START=${clock-72*hour};WINDOW_END=${clock+24*hour};report={window:{from:${clock-72*hour},to:${clock+24*hour}},updatedAt:'2026-10-24T12:00:00Z',people:{directors:[{id:'d1',name:'Манн'}],actors:[{id:'a1',name:'Де Ниро'}]}};urlReady=true`);
const show=(offset,channel,duration=2)=>({channel,start:clock+offset*hour,end:clock+(offset+duration)*hour});
const full={id:'heat-1995',title:'Жара',original:'Heat',year:1995,runtime:170.4,genres:['Драма','Криминал'],poster:'https://image.example/heat.jpg',url:'https://letterboxd.com/film/heat-1995/',synopsis:'Полный синопсис без сокращения.',directors:[{id:'d1',name:'Манн'}],actors:[{id:'a1',name:'Де Ниро'},{id:'a2',name:'Пакчино'}],shows:[show(-80,'Старый'),show(-72,'Граница'),show(-2,'Архив'),show(3,'Премьера'),show(5,'Вечер')],catalogOnly:false};
const catalog={id:'tmdb_42',title:'Убежище',original:'Refuge',year:2023,runtime:90,genres:['Триллер'],directors:[],actors:[],shows:[show(-70,'Ночной')],catalogOnly:true,synopsis:''};
const partial={id:'bare',title:'Без данных',original:'Без данных',genres:[],directors:[],actors:[],shows:[]};
live.full=full;live.catalog=catalog;live.partial=partial;
run(`films=[full,catalog,partial];enrichment={films:{'heat-1995':{actualRating:4.5,prediction:{predictedRating:4.2,probability4Plus:0.66,confidence:'high',matchSignals:['НЕ ПОКАЗЫВАТЬ'],mainRisk:'НЕ ПОКАЗЫВАТЬ',stale:false}},'tmdb_42':{prediction:{predictedRating:3.5,probability4Plus:0.4,confidence:'low',stale:true}}}};startedIds=new Set(['heat-1995']);filmScreen='heat-1995'`);
run('renderFilmShell()');
assert.equal(fetches.length,0,'rendering the film page does not fetch');
const poster=query('#film-poster').innerHTML;
const score=query('#film-screen-score').innerHTML;
const synopsis=query('#film-screen-synopsis').innerHTML;
const credits=query('#film-screen-credits').innerHTML;
const availability=query('#film-screen-availability').innerHTML;
const actions=query('#film-screen-actions').innerHTML;
assert.equal(query('#film-screen-title').textContent,'Жара');
assert.equal(query('#film-screen-original').textContent,'Heat');
assert.match(query('#film-screen-meta').textContent,/1995 · 170 мин/);
assert.match(query('#film-screen-genres').textContent,/Драма · Криминал/);
assert.match(poster,/src="https:\/\/image\.example\/heat\.jpg"/);
assert.match(poster,/referrerpolicy="no-referrer"/);
assert.equal(synopsis,'<p class="film-page-synopsis">Полный синопсис без сокращения.</p>');
assert.doesNotMatch(synopsis,/details|summary/);
assert.match(credits,/data-credit-kind="directors"/);
assert.match(credits,/data-credit-id="a1"/);
assert.match(credits,/data-credit-id="a2"/);
assert.match(credits,/<button /);
assert.match(score,/Оценка Letterboxd/);
assert.match(score,/>4\.5</);
assert.match(score,/Прогноз/);
assert.match(score,/>4\.2</);
assert.match(score,/66%/);
assert.match(score,/уверенность высокая/);
assert.doesNotMatch(score,/НЕ ПОКАЗЫВАТЬ|matchSignals|mainRisk/);
assert.match(actions,/href="https:\/\/letterboxd\.com\/film\/heat-1995\/"/);
assert.match(actions,/data-started-id="heat-1995"/);
assert.match(actions,/aria-pressed="true"/);
assert.equal(actions.indexOf('letterboxd-link')<actions.indexOf('</a>'),true);
assert.ok(actions.indexOf('data-started-id')>actions.indexOf('</a>'));
assert.doesNotMatch(availability,/<details\b|<summary\b/);
assert.match(availability,/Осталось показов <strong>3<\/strong>/);
assert.match(availability,/Ближайший показ/);
assert.doesNotMatch(availability,/Последний шанс/);
assert.equal((availability.match(/data-channel=/g)||[]).length,4,'nearest summary plus every open showing');
assert.doesNotMatch(availability,/Старый|Граница/);
assert.match(availability,/Архив/);
assert.match(availability,/Доступно до/);
const list=availability.slice(availability.indexOf('film-show-list'));
const rows=[...list.matchAll(/datetime="([^"]+)"/g)].map(match=>match[1]);
assert.deepEqual(rows,[...rows].sort(),'the full list stays in start order');

run(`filmScreen='tmdb_42';renderFilmShell()`);
assert.equal(query('#film-screen-title').textContent,'Убежище');
assert.equal(query('#film-screen-status').textContent,'Только в каталоге');
assert.match(query('#film-screen-score').innerHTML,/ожидает пересчёта/);
assert.match(query('#film-screen-score').innerHTML,/уверенность низкая/);
assert.match(query('#film-screen-score').innerHTML,/Оценка Letterboxd не сохранена/);
assert.match(query('#film-screen-synopsis').innerHTML,/Синопсис не сохранён/);
assert.match(query('#film-screen-availability').innerHTML,/Последний шанс/);
assert.match(query('#film-screen-availability').innerHTML,/Осталось показов <strong>1<\/strong>/);
assert.match(query('#film-poster').innerHTML,/no-poster/);
assert.equal(fetches.length,0);

run(`filmScreen='bare';renderFilmShell()`);
assert.equal(query('#film-screen-title').textContent,'Без данных');
assert.match(query('#film-screen-synopsis').innerHTML,/Синопсис не сохранён/);
assert.match(query('#film-screen-credits').innerHTML,/не указаны/);
assert.match(query('#film-screen-score').innerHTML,/Прогноз ещё не готов/);
assert.match(query('#film-screen-score').innerHTML,/Оценка Letterboxd не сохранена/);
assert.match(query('#film-screen-availability').innerHTML,/Нет показов в текущем окне/);
assert.match(query('#film-screen-availability').innerHTML,/Осталось показов <strong>0<\/strong>/);
assert.match(query('#film-screen-availability').innerHTML,/Срок доступности не определён/);
assert.equal(query('#film-screen-original').textContent,'');
assert.equal(fetches.length,0);

run(`filmScreen='missing';renderFilmShell()`);
assert.equal(query('#film-screen-title').textContent,'Фильм не найден');
assert.equal(query('#film-screen-score').innerHTML,'');
assert.equal(query('#film-screen-availability').innerHTML,'');
assert.match(query('#film-screen-status').textContent,/нет фильма/);

window.history.replaceState({iptvFilm:'heat-1995'},'','/film/heat-1995');
run(`filmScreen='heat-1995';filmFiltersAtOpen=filterStateKey(state);state.channels=new Set()`);
const before=stack.length;
run(`onMovieClick({target:{closest(selector){return selector==='[data-channel]'?{dataset:{channel:'Премьера'}}:null;}},preventDefault(){},stopPropagation(){}})`);
assert.equal(new URL(window.location.href).pathname,'/film/heat-1995');
assert.equal(stack.length,before,'a channel on the film page does not add a history entry');
assert.equal(fetches.length,0);
assert.equal(run(`state.channels.has('Премьера')`),true);
stack.splice(0,stack.length,{href:'https://iptv.example/?q=zara',state:null},{href:window.location.href,state:{iptvFilm:'heat-1995'}});
index=1;
window.history.back();
assert.equal(new URL(window.location.href).pathname,'/');
assert.equal(new URL(window.location.href).searchParams.get('channel'),'Премьера');
assert.equal(run(`state.channels.has('Премьера')`),true);

const css=fs.readFileSync('public/styles.css','utf8');
assert.match(css,/@media\(max-width:760px\)\{\.film-page-head\{flex-direction:column/);
assert.match(fs.readFileSync('public/index.html','utf8'),/id="film-screen-availability"/);
console.log('Film page: metadata, scores, full showings, partial data and no render fetch passed');
