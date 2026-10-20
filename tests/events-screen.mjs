import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const pushed=[],replaced=[],session=new Map(),local=new Map();
const nodes=new Map();
function element(selector){
 if(!nodes.has(selector))nodes.set(selector,{selector,innerHTML:'',textContent:'',hidden:selector==='#activity-back',value:'',checked:false,disabled:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},focus(){document.active=selector;},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];}});
 return nodes.get(selector);
}
const document={
 events:false,
 active:null,
 documentElement:{classList:{toggle(_name,on){document.events=!!on;}}},
 querySelector:element,
 querySelectorAll(){return [];},
 addEventListener(){},
};
const window={
 scrollY:480,
 scrollTo(_x,y){window.scrollY=y;},
 location:{href:'https://iptv.example/?q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD&sort=relevance&campaign=save'},
 history:{
  state:null,
  pushState(_state,_title,url){pushed.push(url);window.location.href=new URL(url,window.location.href).href;},
  replaceState(_state,_title,url){replaced.push(url);window.location.href=new URL(url,window.location.href).href;},
 },
};
const ctx=vm.createContext({
 Date,Intl,URL,URLSearchParams,Set,Map,JSON,document,window,
 sessionStorage:{getItem:key=>session.has(key)?session.get(key):null,setItem:(key,value)=>session.set(key,value)},
 localStorage:{getItem:key=>local.has(key)?local.get(key):null,setItem:(key,value)=>local.set(key,value)},
});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
vm.runInContext(fs.readFileSync('src/filter-presets.js','utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);
let paints=0;
const render=ctx.render;
ctx.render=function(...args){paints++;return render.apply(this,args);};
run(`state.query='нолан';state.sort='relevance';state.sortExplicit=false`);
run('openEventsScreen(document.querySelector("#activity-expand"))');
assert.deepEqual(pushed,['/events']);
assert.equal(new URL(window.location.href).pathname,'/events');
assert.equal(new URL(window.location.href).search,'');
assert.equal(session.get('iptv-film-list-query'),'?q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD&sort=relevance&campaign=save');
assert.equal(local.get('iptv-film-list-query'),session.get('iptv-film-list-query'));
assert.equal(document.events,true);
assert.equal(element('#activity-expand').hidden,true);
assert.equal(element('#activity-back').hidden,false);
assert.equal(window.scrollY,0);
assert.equal(run('state.query'),'нолан');
assert.equal(run('movieScrollY'),480);
assert.doesNotMatch(run('presetQuery()'),/screen|\/events/);
assert.equal(new URLSearchParams(run('normalizePresetQuery("q=нолан&screen=events&campaign=save")')).get('screen'),null);
assert.equal(paints,0,'opening events does not rebuild the catalogue');
local.set('iptv-film-list-query','?q=local');
run('closeEventsScreen()');
assert.equal(pushed.at(-1),'/?q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD&sort=relevance&campaign=save');
assert.equal(new URL(window.location.href).pathname,'/');
assert.match(window.location.href,/campaign=save/);
assert.equal(document.events,false);
assert.equal(window.scrollY,480);
assert.equal(run('state.query'),'нолан');
session.clear();
local.set('iptv-film-list-query','?q=from-browser');
window.location.href='https://iptv.example/events';
run('eventsScreen=true;document.documentElement.classList.toggle("events-screen",true)');
run('closeEventsScreen()');
assert.equal(new URL(window.location.href).search,'?q=from-browser');
assert.equal(run('state.query'),'from-browser','a bookmarked events page falls back to the browser memory');
session.set('iptv-film-list-query','');
run('eventsScreen=true;window.location.href="https://iptv.example/events"');
run('closeEventsScreen()');
assert.equal(new URL(window.location.href).search,'','an explicit empty tab memory beats the browser fallback');
window.location.href='https://iptv.example/?q=explicit&sort=relevance';
run(`state.query='explicit';state.sort='relevance';state.sortExplicit=false;eventsScreen=false`);
const before=paints;
window.location.href='https://iptv.example/events';
run('onHistoryNavigation()');
assert.equal(paints,before,'moving to events does not rebuild the catalogue');
assert.equal(document.events,true);
assert.equal(run('state.query'),'explicit','the events address does not clear the list filters');
window.location.href='https://iptv.example/?q=explicit&sort=relevance';
run('onHistoryNavigation()');
assert.equal(document.events,false);
assert.equal(paints,before,'returning to the same film address does not rebuild the catalogue');
assert.match(fs.readFileSync('src/worker.js','utf8'),/pathname==='\/events'\?'\/'/);
const css=fs.readFileSync('public/styles.css','utf8'),html=fs.readFileSync('public/index.html','utf8');
assert.match(html,/id="activity-expand">Развернуть/);
assert.match(html,/id="activity-back" hidden>К фильмам/);
assert.match(css,/html\.events-screen \.results,/);
console.log('Events screen: /events slug, tab memory, browser fallback and explicit list address passed');
