import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const pushed=[],replaced=[];
const nodes={};
function control(id,hidden=false){return nodes[id]={id,hidden,focus(){document.active=id;}};}
control('activity-expand');
control('activity-back',true);
control('activity-title');
control('status-events-link');
const document={
 documentElement:{classList:{toggle(name,on){document.events=on;}}},
 active:null,
 querySelector(selector){return nodes[selector.slice(1)]||null;},
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
const ctx=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,document,window});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
vm.runInContext(fs.readFileSync('src/filter-presets.js','utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);
let paints=0;
const render=ctx.render;
ctx.render=function(...args){paints++;return render.apply(this,args);};
run(`state.query='нолан';state.sort='relevance';state.sortExplicit=false`);
run('openEventsScreen(document.querySelector("#activity-expand"))');
assert.equal(pushed.length,1);
assert.match(window.location.href,/screen=events/);
assert.match(window.location.href,/campaign=save/);
assert.match(window.location.href,/sort=relevance/);
assert.equal(document.events,true);
assert.equal(nodes['activity-expand'].hidden,true);
assert.equal(nodes['activity-back'].hidden,false);
assert.equal(window.scrollY,0);
assert.equal(run('state.query'),'нолан');
assert.equal(run('movieScrollY'),480);
assert.doesNotMatch(run('presetQuery()'),/screen/);
assert.equal(new URLSearchParams(run('normalizePresetQuery("q=нолан&screen=events&campaign=save")')).get('screen'),null);
assert.equal(paints,0,'opening events does not rebuild the catalogue');
run('closeEventsScreen()');
assert.equal(replaced.length,1);
assert.doesNotMatch(window.location.href,/screen=/);
assert.match(window.location.href,/q=/);
assert.equal(document.events,false);
assert.equal(window.scrollY,480);
assert.equal(document.active,'activity-expand');
window.scrollY=120;
run('openEventsScreen(document.querySelector("#status-events-link"))');
assert.equal(pushed.length,2);
window.location.href=window.location.href.replace(/[?&]screen=events/,'');
run('onHistoryNavigation()');
assert.equal(paints,0,'back to the same filters does not rebuild the catalogue');
assert.equal(document.events,false);
assert.equal(window.scrollY,120);
assert.notEqual(run(`filterStateKey(readUrlState(new URL("https://iptv.example/?q=other")))`),run('filterStateKey()'));
const css=fs.readFileSync('public/styles.css','utf8'),html=fs.readFileSync('public/index.html','utf8');
assert.match(html,/id="activity-expand">Развернуть/);
assert.match(html,/id="activity-back" hidden>К фильмам/);
assert.match(css,/html\.events-screen \.results,/);
assert.match(css,/html\.events-screen \.filters\{display:block!important\}/);
assert.match(css,/html\.events-screen \.activity-scroll\{max-height:calc\(100dvh - 180px\)\}/);
console.log('Events screen: history, preserved filters, scroll and no preset screen passed');
