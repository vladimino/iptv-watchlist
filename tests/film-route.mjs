import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,'');
const nodes=new Map();
const focused=[];
function element(selector){
 return {selector,innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,open:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},focus(){focused.push(selector);},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){}};
}
function query(selector){
 if(typeof selector==='string'&&selector.startsWith('a.film-open[data-film-id=')&&!selector.includes('heat-1995')&&!selector.includes('tmdb_42'))return null;
 if(!nodes.has(selector))nodes.set(selector,element(selector));
 return nodes.get(selector);
}
const classes=new Set();
const session=new Map(),local=new Map();
const stack=[];
let index=-1;
const fetches=[];
const window={
 scrollY:720,
 scrollTo(_x,y){window.scrollY=y;},
 location:{href:'https://iptv.example/'},
 history:{
  get state(){return index>=0?stack[index].state:null;},
  pushState(state,_title,url){stack.splice(index+1);stack.push({href:new URL(url,window.location.href).href,state});index++;window.location.href=stack[index].href;},
  replaceState(state,_title,url){if(index<0){stack.push({href:new URL(url,window.location.href).href,state});index=0;}else stack[index]={href:new URL(url,window.location.href).href,state};window.location.href=stack[index].href;},
  back(){if(index<=0)return;index--;window.location.href=stack[index].href;run('onHistoryNavigation()');},
  forward(){if(index>=stack.length-1)return;index++;window.location.href=stack[index].href;run('onHistoryNavigation()');},
 },
};
const document={
 documentElement:{classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},add(name){classes.add(name);},remove(name){classes.delete(name);}}},
 querySelector:query,
 querySelectorAll(){return [];},
 addEventListener(){},
};
const live=vm.createContext({
 Date,Intl,Set,Map,URL,URLSearchParams,JSON,window,document,
 sessionStorage:{getItem:key=>session.has(key)?session.get(key):null,setItem:(key,value)=>session.set(key,value)},
 localStorage:{getItem:key=>local.has(key)?local.get(key):null,setItem:(key,value)=>local.set(key,value)},
 fetch(url,options){fetches.push({url:String(url),method:options?.method||'GET'});return Promise.resolve({ok:false,status:500,json:async()=>({}),headers:{get(){return null;}}});},
});
vm.runInContext(source,live);
const run=code=>vm.runInContext(code,live);
const film={id:'heat-1995',title:'Жара',original:'Heat',year:1995,runtime:170,genres:['Драма'],directors:[{id:'d1',name:'Манн'}],actors:[{id:'a1',name:'Де Ниро'}],shows:[],synopsis:'секретный сюжет',catalogOnly:false};
const catalog={id:'tmdb_42',title:'Жара',original:'Refuge',year:2023,runtime:90,genres:['Драма'],directors:[],actors:[],shows:[],synopsis:'каталожный сюжет',catalogOnly:true};
live.film=film;live.catalog=catalog;
run(`films=[film,catalog];report={people:{directors:[],actors:[]},updatedAt:'2026-10-24T12:00:00Z',window:{from:${Date.parse('2026-10-21T12:00:00Z')},to:${Date.parse('2026-10-25T12:00:00Z')}}};enrichment={films:{}};urlReady=true`);
run(`state.period='archive';state.query='жара';state.sort='personal';state.sortExplicit=true;state.shortlistMode='today';state.genres=new Set(['Драма']);state.channels=new Set(['Первый'])`);
const listHref=run(`urlForState('https://iptv.example/?campaign=save#films').href`);
window.history.replaceState(null,'',listHref);
const listSearch=new URL(listHref).search;
assert.match(listSearch,/period=archive/);
assert.match(listSearch,/q=/);
assert.match(listSearch,/sort=personal/);
assert.match(listSearch,/genre=/);
assert.match(listSearch,/channel=/);
assert.match(listSearch,/shortlist=today/);

function click(resolver){
 fetches.length=0;
 run(`onMovieClick({target:{closest(selector){return (${resolver})(selector);}},preventDefault(){},stopPropagation(){this.stopped=true;}})`);
}
click(`selector=>selector==='article.movie-card'?{dataset:{filmId:'heat-1995'}}:null`);
assert.equal(fetches.length,0,'opening a film does not fetch');
assert.equal(new URL(window.location.href).pathname,'/film/heat-1995');
assert.equal(run('window.history.state.iptvFilm'),'heat-1995');
assert.equal(query('#film-screen-title').textContent,'Жара');
assert.equal(query('#film-screen-identity').textContent,'heat-1995');
assert.equal(query('#film-screen').dataset.filmId,'heat-1995');
assert.equal(query('#film-screen-status').textContent,'');
assert.doesNotMatch(query('#film-screen-title').textContent+query('#film-screen-identity').textContent+query('#film-screen-status').textContent,/секретный|каталожный|прогноз|показ/i);
assert.equal(classes.has('film-screen'),true);
assert.equal(window.scrollY,0);
assert.equal(run('movieScrollY'),720);
// AIR-380: the way home is carried in the film's own URL, not remembered in storage.
const homeTargetOfList='/'+listSearch+'#films';
assert.equal(run('ReturnHome.fromSearch(new URL(window.location.href).search)'),homeTargetOfList,'the film URL names the exact programme state it was opened from');
assert.equal(run('window.history.state.iptvHome'),homeTargetOfList,'an entry opened from the programme remembers that it follows it directly');
assert.equal(session.has('iptv-film-list-query')||local.has('iptv-film-list-query'),false,'nothing is remembered in storage any more');
assert.equal(run('state.period'),'archive');
assert.equal(run('state.sort'),'personal');
assert.equal(run('state.query'),'жара');

window.history.back();
assert.equal(window.location.href,listHref);
assert.equal(window.scrollY,720);
assert.equal(focused.at(-1),'a.film-open[data-film-id="heat-1995"]');
assert.notEqual(focused.at(-1),'#activity-expand');
assert.equal(classes.has('film-screen'),false);
assert.equal(run('state.period'),'archive');
assert.equal(run("state.genres.has('Драма')"),true);
assert.equal(run("state.channels.has('Первый')"),true);
assert.equal(fetches.length,0,'returning to the list does not fetch');
window.history.forward();
assert.equal(new URL(window.location.href).pathname,'/film/heat-1995');
assert.equal(window.scrollY,0);
assert.equal(query('#film-screen-identity').textContent,'heat-1995');
assert.equal(fetches.length,0,'forward does not fetch');
window.history.back();

const beforeControls=stack.length;
click(`selector=>selector==='a,button,summary,input,select,label,textarea'?{tag:'a'}:selector==='article.movie-card'?{dataset:{filmId:'heat-1995'}}:null`);
assert.equal(stack.length,beforeControls,'a nested link does not open the film');
assert.equal(window.location.href,listHref);
click(`selector=>selector==='[data-channel]'?{dataset:{channel:'Второй'}}:null`);
assert.equal(new URL(window.location.href).pathname,'/');
assert.equal(run("state.channels.has('Второй')"),true);
assert.equal(fetches.length,0);
click(`selector=>selector==='[data-credit-id]'?{dataset:{creditKind:'actors',creditId:'missing'}}:selector==='article.movie-card'?{dataset:{filmId:'heat-1995'}}:null`);
assert.equal(new URL(window.location.href).pathname,'/');
click(`selector=>selector==='a,button,summary,input,select,label,textarea'?{tag:'summary'}:null`);
assert.equal(new URL(window.location.href).pathname,'/');
click(`selector=>selector==='[data-started-id]'?{dataset:{startedId:'heat-1995'}}:selector==='article.movie-card'?{dataset:{filmId:'heat-1995'}}:null`);
assert.equal(new URL(window.location.href).pathname,'/','the started control keeps its own action');
assert.equal(fetches.some(item=>String(item.url).includes('/film/')),false);

window.history.replaceState(null,'',listHref);
run(`state.channels=new Set(['Первый'])`);
fetches.length=0;
click(`selector=>selector==='article.movie-card'?{dataset:{filmId:'tmdb_42'}}:null`);
assert.equal(new URL(window.location.href).pathname,'/film/tmdb_42');
assert.equal(query('#film-screen-identity').textContent,'tmdb_42');
assert.equal(query('#film-screen-status').textContent,'Только в каталоге');
assert.equal(query('#film-screen-title').textContent,'Жара');
assert.doesNotMatch(query('#film-screen-identity').textContent,/heat-1995/);
assert.equal(fetches.length,0);
run('render()');
assert.equal(new URL(window.location.href).pathname,'/film/tmdb_42','a list refresh does not replace the film address');
assert.equal(fetches.length,0);

window.location.href='https://iptv.example/film/tmdb_42';
run(`filmScreen=null;applyFilmScreen(filmIdFromLocation())`);
assert.equal(query('#film-screen').dataset.filmId,'tmdb_42');
assert.equal(query('#film-screen-status').textContent,'Только в каталоге');
assert.notEqual(query('#film-screen').dataset.filmId,'heat-1995');

window.location.href='https://iptv.example/film/tmdb_0';
run(`filmScreen=null;applyFilmScreen(filmIdFromLocation())`);
assert.equal(new URL(window.location.href).pathname,'/film/tmdb_0');
assert.equal(query('#film-screen-title').textContent,'Фильм не найден');
assert.equal(query('#film-screen-identity').textContent,'tmdb_0');
assert.match(query('#film-screen-status').textContent,/нет фильма/);
assert.doesNotMatch(query('#film-screen-title').textContent,/Жара/);
assert.equal(fetches.length,0);

assert.equal(run(`filmIdFromLocation('https://iptv.example/film/${encodeURIComponent('Жара')}')`),null);
assert.equal(run(`filmIdFromLocation('https://iptv.example/film/tmdb_42/title')`),null);
assert.equal(run(`filmIdFromLocation('https://iptv.example/?q=${encodeURIComponent('Жара')}')`),null);
run('openFilm("Жара")');
assert.equal(new URL(window.location.href).pathname,'/film/tmdb_0','a title is not accepted as a film id');

window.history.replaceState(null,'','https://iptv.example/film/tmdb_42');
run(`filmScreen='tmdb_42'`);
// A deep link that carries its target returns to exactly that target.
window.history.replaceState(null,'','https://iptv.example/film/tmdb_42?return='+encodeURIComponent('/'+listSearch));
fetches.length=0;
run('returnHome()');
assert.equal(new URL(window.location.href).pathname+new URL(window.location.href).search,'/'+listSearch,'a deep link with a return target goes to that target');
assert.equal(classes.has('film-screen'),false);
assert.equal(fetches.length,0);
// Without a target (bookmark) or with a rejected one the way home is the canonical home, whatever an old session left in storage.
session.set('iptv-film-list-query','?stale=1');
for(const bad of ['https://iptv.example/film/heat-1995','https://iptv.example/film/heat-1995?return='+encodeURIComponent('//evil.example/'),'https://iptv.example/film/heat-1995?return='+encodeURIComponent('https://evil.example/'),'https://iptv.example/film/heat-1995?return='+encodeURIComponent('javascript:alert(1)')]){
 window.history.replaceState(null,'',bad);
 run(`filmScreen='heat-1995';returnHome()`);
 assert.equal(new URL(window.location.href).origin+new URL(window.location.href).pathname,'https://iptv.example/',bad);
 assert.equal(new URL(window.location.href).search,'',bad+' goes to the canonical home with no query');
}

const cardHtml=run('card(film)');
const openAt=cardHtml.indexOf('class="film-open"');
const openEnd=cardHtml.indexOf('</a>',openAt);
assert.ok(openAt>=0&&openEnd>openAt);
assert.match(cardHtml,/href="\/film\/heat-1995"/);
assert.match(cardHtml,/data-film-id="heat-1995"/);
assert.equal(cardHtml.slice(openAt,openEnd).includes('<a'),false,'the film link does not contain another link');
assert.ok(cardHtml.indexOf('letterboxd-link')===-1||cardHtml.indexOf('letterboxd-link')>openEnd);
assert.ok(cardHtml.indexOf('data-channel')===-1||cardHtml.indexOf('data-channel')>openEnd);
assert.ok(cardHtml.indexOf('data-credit-id')>openEnd);
assert.ok(cardHtml.indexOf('data-started-id')>openEnd);
live.film.url='https://letterboxd.com/film/heat-1995/';
const linked=run('card(film)');
assert.ok(linked.indexOf('letterboxd-link')>linked.indexOf('</a>'));
assert.equal((linked.match(/<a /g)||[]).length,2);

function activate(extra,resolver){
 fetches.length=0;
 const event={button:0,metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,defaultPrevented:false,prevented:false,preventDefault(){this.prevented=true;},stopPropagation(){},target:{closest(selector){return resolver(selector);}},...extra};
 live.activation=event;
 run('onMovieClick(activation)');
 return event;
}
window.history.replaceState(null,'',listHref);
run(`filmScreen=null`);
const entered=activate({},selector=>selector==='a.film-open'?{dataset:{filmId:'heat-1995'},href:'/film/heat-1995'}:null);
assert.equal(entered.prevented,true,'Enter on the film link stays in the page');
assert.equal(new URL(window.location.href).pathname,'/film/heat-1995');
assert.equal(fetches.length,0);
window.history.back();
assert.equal(focused.at(-1),'a.film-open[data-film-id="heat-1995"]');
const modified=activate({metaKey:true},selector=>selector==='a.film-open'?{dataset:{filmId:'tmdb_42'},href:'/film/tmdb_42'}:selector==='article.movie-card'?{dataset:{filmId:'tmdb_42'}}:null);
assert.equal(modified.prevented,false,'a modified click follows the real link');
assert.equal(new URL(window.location.href).pathname,'/','a new-tab click does not replace the list');
const nested=activate({},selector=>selector==='a.film-open'?null:selector==='a,button,summary,input,select,label,textarea'?{tag:'a'}:selector==='article.movie-card'?{dataset:{filmId:'heat-1995'}}:null);
assert.equal(nested.prevented,false);
assert.equal(new URL(window.location.href).pathname,'/');

focused.length=0;
run(`filmReturnId='missing-id';filmScreen='missing-id'`);
window.history.replaceState(null,'','https://iptv.example/film/missing-id');
run('returnHome()');
assert.equal(focused.at(-1),'#search','a missing card falls back to search');
assert.equal(new URL(window.location.href).pathname,'/');

const prior='https://iptv.example/before';
stack.splice(0,stack.length,{href:prior,state:null},{href:'https://iptv.example/film/heat-1995?return='+encodeURIComponent('/'+listSearch),state:null});
index=1;
window.location.href=stack[1].href;
run(`filmScreen='heat-1995';filmReturnId='heat-1995'`);
const lengthBeforeClose=stack.length;
run('returnHome()');
assert.equal(stack.length,lengthBeforeClose+1,'a deep link has no earlier programme entry: the way home is a normal navigation');
assert.equal(index,2);
assert.equal(new URL(window.location.href).pathname,'/');
assert.equal(new URL(window.location.href).search,listSearch);
window.history.back();
assert.equal(new URL(window.location.href).pathname,'/film/heat-1995','Back returns to the film that was left');
window.history.forward();
assert.equal(new URL(window.location.href).pathname,'/');

const worker=fs.readFileSync('src/worker.js','utf8');
assert.match(worker,/pathname==='\/events'\?'\/'/);
assert.equal(worker.includes('/^\\/film\\/[A-Za-z0-9_-]{1,80}$/'),true);
const html=fs.readFileSync('public/index.html','utf8');
const css=fs.readFileSync('public/styles.css','utf8');
assert.match(html,/href="\/styles\.css"/);
assert.match(html,/src="\/app\.js"/);
assert.match(html,/id="film-screen"/);
assert.match(html,/<a class="return-home" id="return-home" data-return-home href="\/" hidden>На главную<\/a>/,'one return link, label «На главную»');
assert.doesNotMatch(html,/film-back|К списку|К фильмам|activity-back/,'the old return controls are gone');
assert.match(css,/html\.film-screen \.page-heading,html\.film-screen \.demo-note,html\.film-screen \.search-panel,html\.film-screen \.results\{display:none!important\}/,'AIR-381: the film page replaces only the programme column');
assert.doesNotMatch(css,/html\.film-screen \.workspace\{display:none/,'the sidebar stays on a film page');
assert.match(css,/\.movie-card\{[^}]*cursor:pointer/);
assert.match(css,/\.film-open::after\{content:"";position:absolute;inset:0\}/);
assert.match(css,/\.movie-card \.letterboxd-link,\.movie-card \.channel-filter,\.movie-card \.credit-link,\.movie-card \.started-button,\.movie-card summary,\.movie-card \.match-hint\{position:relative;z-index:1\}/);
const shell=fs.readFileSync('public/app.js','utf8').match(/function renderFilmShell\(\)\{[\s\S]*?\n\}/)[0];
assert.doesNotMatch(shell,/synopsis|prediction|screenings|shows/);
console.log('Film route: card click, inner controls, reload, history, scroll, catalog id and unknown id passed');
