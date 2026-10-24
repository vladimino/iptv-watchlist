import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,'');
const hour=3600000;
const clock=Date.parse('2026-10-24T12:00:00Z');
const nodes=new Map();
const focused=[];
function element(selector){
 return {selector,innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,open:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},focus(){focused.push(selector);},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){}};
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
assert.match(synopsis,/<h2>Синопсис<\/h2><p class="film-page-synopsis">Полный синопсис без сокращения\.<\/p>/);
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
assert.match(actions,/Просмотр начат/);
assert.doesNotMatch(actions,/Начал просмотр/);
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

const liveNow={id:'live-1',title:'Прямой эфир',original:'Live',year:2024,runtime:100,genres:['Драма'],directors:[],actors:[],shows:[{channel:'Эфир',start:clock-hour,end:clock+hour},{channel:'Повтор',start:clock+4*hour,end:clock+6*hour}]};
live.liveNow=liveNow;
run(`films.push(liveNow);filmScreen='live-1';renderFilmShell()`);
const onAir=query('#film-screen-availability').innerHTML;
assert.match(onAir,/Сейчас в эфире/);
assert.match(onAir,/Следующий показ/);
assert.ok(onAir.indexOf('Сейчас в эфире')<onAir.indexOf('Следующий показ'));
assert.match(onAir,/data-channel="Эфир"/);
assert.match(onAir,/data-channel="Повтор"/);
assert.match(onAir,/is-live/);
assert.match(onAir,/is-next/);
const listed=onAir.slice(onAir.indexOf('film-show-list'));
assert.ok(listed.indexOf('Эфир')>=0&&listed.indexOf('Повтор')>listed.indexOf('Эфир'));

run(`startedReady=true;startedIds=new Set();filmScreen='heat-1995';savingStarted.clear();loadEvents=()=>{}`);
run('renderFilmShell()');
let startedPosts=0;
let releaseStarted;
live.fetch=(url,options)=>{
 const method=options?.method||'GET';
 if(String(url)==='/api/started'&&method==='POST'){startedPosts++;return new Promise(resolve=>{releaseStarted=resolve;});}
 return Promise.resolve({ok:true,json:async()=>({events:[]})});
};
const clickStarted=()=>run(`onMovieClick({target:{closest(selector){return selector==='[data-started-id]'?{dataset:{startedId:'heat-1995'}}:null;}},preventDefault(){},stopPropagation(){}})`);
const firstClick=clickStarted();
assert.match(query('#film-screen-actions').innerHTML,/aria-busy="true"/);
assert.match(query('#film-screen-actions').innerHTML,/disabled/);
assert.match(query('#film-screen-actions').innerHTML,/aria-pressed="false"/);
clickStarted();
assert.equal(startedPosts,1,'a second click does not send another started request');
releaseStarted({ok:true,json:async()=>({id:'heat-1995',started:true})});
await firstClick;
assert.match(query('#film-screen-actions').innerHTML,/aria-pressed="true"/);
assert.doesNotMatch(query('#film-screen-actions').innerHTML,/\sdisabled/);
assert.doesNotMatch(query('#film-screen-actions').innerHTML,/aria-busy="true"/);
assert.equal(run(`startedIds.has('heat-1995')`),true);
assert.equal(focused.at(-1),'#film-screen [data-started-id="heat-1995"]');
live.fetch=async()=>({ok:false,status:500,json:async()=>({})});
await run(`toggleStarted('heat-1995')`);
assert.equal(run(`startedIds.has('heat-1995')`),true,'a failed save does not change the started mark');
assert.match(query('#film-screen-actions').innerHTML,/aria-pressed="true"/);
assert.doesNotMatch(query('#film-screen-actions').innerHTML,/\sdisabled/);
assert.equal(query('#progress-error').hidden,false);
assert.match(query('#progress-error-text').textContent,/Не удалось сохранить/);
assert.equal(focused.at(-1),'#film-screen [data-started-id="heat-1995"]');

function openFromList(){
 stack.splice(0,stack.length,{href:'https://iptv.example/?q=zara',state:null});
 index=0;
 window.location.href=stack[0].href;
 run(`state.query='zara';state.directors='';state.actors='';state.channels=new Set();filmScreen=null;openFilm('heat-1995')`);
}
function choosePerson(kind,id){
 run(`onMovieClick({target:{closest(selector){return selector==='[data-credit-id]'?{dataset:{creditKind:'${kind}',creditId:'${id}'}}:null;}},preventDefault(){},stopPropagation(){}})`);
}
for(const [kind,id,param] of [['directors','d1','director'],['actors','a1','actor']]){
 openFromList();
 const filmEntry=window.location.href;
 choosePerson(kind,id);
 assert.equal(new URL(window.location.href).pathname,'/','a person opens the filtered list');
 assert.equal(new URL(window.location.href).searchParams.get(param),id);
 assert.equal(run('filmScreen'),null);
 assert.equal(stack[0].href,'https://iptv.example/?q=zara');
 window.history.back();
 assert.equal(window.location.href,filmEntry);
 assert.equal(new URL(window.location.href).pathname,'/film/heat-1995');
 window.history.back();
 assert.equal(window.location.href,'https://iptv.example/?q=zara');
 assert.equal(run('state.query'),'zara');
 assert.equal(run('state.directors'),'');
 assert.equal(run('state.actors'),'');
}

const css=fs.readFileSync('public/styles.css','utf8');
const html=fs.readFileSync('public/index.html','utf8');
assert.match(css,/@media\(max-width:760px\)\{\s*\.film-hero\{grid-template-columns:1fr/);
assert.match(css,/\.movie-card \.started-action|\.started-action\{position:absolute;right:18px;bottom:16px/);
assert.match(css,/\.film-screen \.started-action\{position:static/);
assert.match(css,/\.film-screen\{max-width:760px/);
assert.match(css,/\.film-score-card\{[^}]*max-width:240px/);
assert.match(css,/#film-screen-identity\{display:none\}/);
assert.match(css,/html\.film-screen \.workspace\{display:none!important\}/);
assert.match(css,/html\.film-screen \.search-panel\{display:none!important\}/);
assert.match(html,/id="film-screen-availability"/);
assert.match(html,/id="film-screen-identity" hidden/);
const filmMarkup=html.slice(html.indexOf('id="film-screen"'),html.indexOf('class="search-panel"'));
assert.doesNotMatch(filmMarkup,/search-scope|Названия|Люди|Сюжет/);
console.log('Film page: metadata, scores, full showings, partial data and no render fetch passed');
