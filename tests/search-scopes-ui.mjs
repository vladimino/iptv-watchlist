import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html=fs.readFileSync('public/index.html','utf8');
const css=fs.readFileSync('public/styles.css','utf8');
assert.match(html,/class="search-scopes" role="group" aria-label="Область поиска"/);
for(const id of ['titles','people','plot'])assert.match(html,new RegExp(`type="button"[^>]*data-search-scope="${id}"`));
assert.match(html,/aria-pressed="true" aria-disabled="true"/);
assert.match(html,/placeholder="Найти фильм"/);
assert.doesNotMatch(html,/Название, люди, сюжет/);
assert.match(css,/\.search-scopes\{display:flex;flex-wrap:wrap/);
assert.match(css,/\.search-scopes\{gap:6px\}/);

const nodes=new Map();
const listeners=new Map();
const search={
 value:'',selectionStart:0,selectionEnd:0,ranges:0,
 setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;this.ranges++;},
 setAttribute(){},getAttribute(){return null;},removeAttribute(){},
 dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},
 focus(){document.activeElement=search;},scrollIntoView(){},closest(){return null;},contains(){return false;},
 querySelector(){return null;},querySelectorAll(){return [];},
 addEventListener(type,fn){const list=listeners.get(search)||[];list.push({type,fn});listeners.set(search,list);},
};
function button(id){
 const attrs={'aria-pressed':id==='titles'?'true':'false'};
 if(id==='titles')attrs['aria-disabled']='true';
 const node={dataset:{searchScope:id},setAttribute(key,value){attrs[key]=value;},getAttribute(key){return Object.hasOwn(attrs,key)?attrs[key]:null;},removeAttribute(key){delete attrs[key];},attrs,focus(){document.activeElement=node;},addEventListener(type,fn){const list=listeners.get(node)||[];list.push({type,fn});listeners.set(node,list);}};
 return node;
}
const scopes={titles:button('titles'),people:button('people'),plot:button('plot')};
function element(selector){
 if(selector==='#search')return search;
 if(!nodes.has(selector))nodes.set(selector,{selector,innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,open:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},focus(){},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(type,fn){const list=listeners.get(this)||[];list.push({type,fn});listeners.set(this,list);}});
 return nodes.get(selector);
}
const document={
 activeElement:search,
 documentElement:{classList:{toggle(){}}},
 querySelector:element,
 querySelectorAll(selector){return selector==='[data-search-scope]'?Object.values(scopes):[];},
 addEventListener(){},
};
const stack=[];
let index=-1;
const window={
 addEventListener(){},
 scrollY:0,
 scrollTo(_x,y){window.scrollY=y;},
 location:{href:'https://iptv.example/'},
 history:{
  get state(){return index>=0?stack[index].state:null;},
  pushState(state,_title,url){stack.splice(index+1);stack.push({href:new URL(url,window.location.href).href,state});index++;window.location.href=stack[index].href;},
  replaceState(state,_title,url){const href=new URL(url,window.location.href).href;if(index<0){stack.push({href,state});index=0;}else stack[index]={href,state};window.location.href=href;},
  back(){if(index<=0)return;index--;window.location.href=stack[index].href;run('onHistoryNavigation()');},
  forward(){if(index>=stack.length-1)return;index++;window.location.href=stack[index].href;run('onHistoryNavigation()');},
 },
};
const ctx=vm.createContext({Date,Intl,Set,Map,URL,URLSearchParams,JSON,document,window});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
const run=code=>vm.runInContext(code,ctx);
const now=Date.parse('2026-10-24T12:00:00Z');
run(`viewClock=${now};report={updatedAt:'2026-10-24T12:00:00Z',window:{from:${now}-72*3600000,to:${now}+24*3600000},films:[]};films=[
 {id:'days',title:'28 дней спустя',original:'28 Days Later',year:2002,runtime:113,genres:['Ужасы'],directors:[{id:'boyle',name:'Дэнни Бойл',original:'Danny Boyle',aliases:['Бойл']}],actors:[],synopsis:'Вирус в Лондоне.',shows:[{channel:'Первый',start:${now}+3600000,end:${now}+7200000}]},
 {id:'robocop',title:'Робокоп',original:'RoboCop',year:2014,runtime:117,genres:['Боевик'],directors:[],actors:[{id:'weaver',name:'Сигурни Уивер',original:'Sigourney Weaver',aliases:['Уивер']}],synopsis:'Действие перенесено в 2028 год.',shows:[{channel:'Первый',start:${now}+3600000,end:${now}+7200000}]}
];enrichment={films:{}};urlReady=true;state.query='28';state.sort='relevance';state.sortExplicit=false;state.searchScopes={titles:true,people:false,plot:true}`);
run('render()');
assert.equal(new URL(window.location.href).searchParams.get('searchIn'),'titles,plot');
run('openEventsScreen(document.querySelector("#activity-expand"))');
window.history.back();
assert.equal(new URL(window.location.href).searchParams.get('searchIn'),'titles,plot');
assert.equal(run('JSON.stringify(state.searchScopes)'),JSON.stringify({titles:true,people:false,plot:true}));
window.history.pushState(null,'','/?q=28&sort=relevance');
run('state.searchScopes=defaultSearchScopes()');
window.history.back();
assert.equal(run('JSON.stringify(state.searchScopes)'),JSON.stringify({titles:true,people:false,plot:true}));
assert.equal(run('state.query'),'28');
window.history.forward();
assert.equal(run('JSON.stringify(state.searchScopes)'),JSON.stringify({titles:true,people:false,plot:false}));
assert.equal(new URL(window.location.href).searchParams.has('searchIn'),false);

run('bindControls()');
search.value='28';
search.selectionStart=1;
search.selectionEnd=1;
search.ranges=0;
document.activeElement=search;
run(`state.query='28';state.searchScopes=defaultSearchScopes()`);
const down={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
for(const item of listeners.get(scopes.plot))if(item.type==='mousedown')item.fn(down);
for(const item of listeners.get(scopes.plot))if(item.type==='click')item.fn({});
assert.equal(down.defaultPrevented,true);
assert.equal(document.activeElement,search);
assert.equal(search.value,'28');
assert.equal(search.selectionStart,1);
assert.equal(search.ranges,0);
assert.equal(run('JSON.stringify(state.searchScopes)'),JSON.stringify({titles:true,people:false,plot:true}));
assert.equal(scopes.plot.attrs['aria-pressed'],'true');
assert.equal(scopes.titles.attrs['aria-disabled'],undefined);
for(const item of listeners.get(scopes.titles))if(item.type==='click')item.fn({});
assert.equal(run('JSON.stringify(state.searchScopes)'),JSON.stringify({titles:false,people:false,plot:true}));
assert.equal(scopes.plot.attrs['aria-disabled'],'true');
for(const item of listeners.get(scopes.plot))if(item.type==='click')item.fn({});
assert.equal(run('state.searchScopes.plot'),true,'the last scope stays on');
run('state.searchScopes={titles:true,people:true,plot:true};state.query="28"');
search.value='28';
run('reset()');
assert.equal(run('state.query'),'');
assert.equal(run('JSON.stringify(state.searchScopes)'),JSON.stringify({titles:true,people:false,plot:false}));
assert.equal(search.value,'');
assert.equal(scopes.titles.attrs['aria-pressed'],'true');
assert.equal(scopes.people.attrs['aria-pressed'],'false');
run(`presets=[{id:'scope',name:'Область',query:'q=28&searchIn=people'}]`);
run('applyPresetQuery(presets[0].query)');
assert.equal(run('JSON.stringify(state.searchScopes)'),JSON.stringify({titles:false,people:true,plot:false}));
assert.equal(run('state.query'),'28');
assert.equal(search.value,'28');
console.log('Search scopes: history, events return, focus, last switch, reset and preset passed');
