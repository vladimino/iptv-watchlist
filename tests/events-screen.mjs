import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const session=new Map(),local=new Map();
const nodes=new Map();
const details={open:true};
const movies={rewritten:false,children:[details],textContent:'',hidden:false,value:'',checked:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},focus(){},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];}};
Object.defineProperty(movies,'innerHTML',{set(value){movies.rewritten=true;movies.children=[];movies._html=value;},get(){return movies._html||'<details open></details>';}});
function element(selector){
 if(selector==='#movies')return movies;
 if(!nodes.has(selector))nodes.set(selector,{selector,innerHTML:'',textContent:'',hidden:selector==='#activity-back',value:'',checked:false,disabled:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},focus(){document.active=selector;},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];}});
 return nodes.get(selector);
}
const document={
 events:false,active:null,
 documentElement:{classList:{toggle(_name,on){document.events=!!on;}}},
 querySelector:element,querySelectorAll(){return [];},addEventListener(){},
};
const filmHref='https://iptv.example/?q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD&sort=relevance&campaign=save';
const stack=[{href:filmHref,state:null}];
let index=0,leftSite=false;
const window={
 scrollY:480,
 scrollTo(_x,y){window.scrollY=y;},
 location:{href:filmHref},
 history:{
  get state(){return stack[index].state;},
  pushState(state,_title,url){stack.splice(index+1);stack.push({href:new URL(url,window.location.href).href,state});index++;window.location.href=stack[index].href;},
  replaceState(state,_title,url){stack[index]={href:new URL(url,window.location.href).href,state};window.location.href=stack[index].href;},
  back(){if(index===0){leftSite=true;return;}index--;window.location.href=stack[index].href;run('onHistoryNavigation()');},
  forward(){if(index>=stack.length-1)return;index++;window.location.href=stack[index].href;run('onHistoryNavigation()');},
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
assert.equal(stack.length,2);
assert.equal(index,1);
assert.equal(stack[1].state.iptvEvents,true);
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
assert.equal(new URLSearchParams(run('normalizePresetQuery("q=нолан&screen=events&campaign=save")')).get('screen'),null);
assert.equal(paints,0,'opening events does not rebuild the catalogue');
assert.doesNotMatch(run('presetQuery()'),/screen|\/events/);
movies.rewritten=false;
run('closeEventsScreen()');
assert.equal(leftSite,false);
assert.equal(index,0);
assert.equal(stack.length,2,'returning uses the existing film entry');
assert.equal(new URL(window.location.href).search,'?q=%D0%BD%D0%BE%D0%BB%D0%B0%D0%BD&sort=relevance&campaign=save');
assert.equal(document.events,false);
assert.equal(window.scrollY,480);
assert.equal(movies.children[0],details);
assert.equal(details.open,true,'an open synopsis survives the return to the film list');
assert.equal(paints,0);
window.history.forward();
assert.equal(new URL(window.location.href).pathname,'/events');
assert.equal(document.events,true);
window.history.back();
assert.equal(new URL(window.location.href).pathname,'/');
assert.equal(document.events,false);
assert.equal(paints,0,'back and forward only switch the screen');
stack.splice(0,stack.length,{href:'https://iptv.example/events',state:null});
index=0;window.location.href=stack[0].href;
session.clear();
local.set('iptv-film-list-query','?q=from-browser');
run('eventsScreen=true');
run('closeEventsScreen()');
assert.equal(leftSite,false,'a bookmarked events page does not leave the site');
assert.equal(index,0);
assert.equal(new URL(window.location.href).search,'?q=from-browser');
assert.equal(run('state.query'),'from-browser');
session.set('iptv-film-list-query','');
stack.splice(0,stack.length,{href:'https://iptv.example/events',state:null});
index=0;window.location.href=stack[0].href;
run('eventsScreen=true');
run('closeEventsScreen()');
assert.equal(new URL(window.location.href).search,'','tab memory of an empty list beats the browser fallback');
const before=[{id:'older',offsetTop:100,offsetHeight:80,dataset:{eventId:'older'}},{id:'visible',offsetTop:180,offsetHeight:90,dataset:{eventId:'visible'}}];
const after=[{id:'fresh',offsetTop:0,offsetHeight:70,dataset:{eventId:'fresh'}},{id:'older',offsetTop:170,offsetHeight:80,dataset:{eventId:'older'}},{id:'visible',offsetTop:250,offsetHeight:90,dataset:{eventId:'visible'}}];
let current=before;
const scroll={scrollTop:210,querySelectorAll:()=>current,querySelector:selector=>{const id=selector.match(/data-event-id="([^"]+)"/)?.[1];return current.find(item=>item.dataset.eventId===id)||null;}};
ctx.scroll=scroll;
const anchor=run('rememberActivityAnchor(scroll)');
assert.equal(anchor.id,'visible');
current=after;
ctx.anchor=anchor;
run('restoreActivityAnchor(scroll, anchor, scroll.scrollTop)');
assert.equal(scroll.scrollTop,250+30,'a new event above the fold keeps the same line in view');
scroll.scrollTop=0;
assert.equal(run('rememberActivityAnchor(scroll)'),null);
assert.match(fs.readFileSync('src/worker.js','utf8'),/pathname==='\/events'\?'\/'/);
const css=fs.readFileSync('public/styles.css','utf8'),html=fs.readFileSync('public/index.html','utf8');
assert.match(html,/id="activity-expand">Развернуть/);
assert.match(html,/id="activity-back" hidden>К фильмам/);
assert.match(css,/html\.events-screen \.results,/);
console.log('Events screen: history back, preserved cards, scroll anchor and browser fallback passed');
