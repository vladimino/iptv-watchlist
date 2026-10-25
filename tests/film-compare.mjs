import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,'');
const listeners=new Map();
const nodes=new Map();
const options=new Map();
const scrolled=[];
const fetches=[];
const pushed=[];
function listen(node,type,fn){const list=listeners.get(node)||[];list.push({type,fn});listeners.set(node,list);}
function fire(node,type,extra={}){for(const item of listeners.get(node)||[])if(item.type===type)item.fn({...extra,preventDefault(){extra.prevented=true;}});}
function classes(){const set=new Set();return {toggle(name,on){if(on)set.add(name);else set.delete(name);return set.has(name);},contains:name=>set.has(name)};}
function option(id,index,text){
 const node={id,text,role:'option',dataset:{index:String(index)},classList:classes(),scrollIntoView(arg){scrolled.push({id,arg});},closest(selector){return selector==='[data-index]'?node:null;}};
 options.set(id,node);
 return node;
}
function parseOptions(html){
 options.clear();
 const found=[];
 for(const match of html.matchAll(/<li role="option" id="([^"]+)" data-index="(\d+)"[^>]*>([\s\S]*?)<\/li>/g))found.push(option(match[1],Number(match[2]),match[3]));
 return found;
}
function field(selector){
 const attrs={};
 return {selector,value:'',hidden:true,dataset:{},classList:classes(),setAttribute(key,value){attrs[key]=value;},getAttribute(key){return Object.hasOwn(attrs,key)?attrs[key]:null;},removeAttribute(key){delete attrs[key];},focus(){},contains(){return false;},addEventListener(type,fn){listen(this,type,fn);},querySelectorAll(selector){return selector==='[role="option"]'?parseOptions(this.innerHTML||''):[];},get innerHTML(){return this._html||'';},set innerHTML(html){this._html=html;this.options=parseOptions(html);}};
}
const input=field('#film-compare-input');
const list=field('#film-compare-options');
const clear=field('#film-compare-clear');
const root=field('#film-compare-combo');
const result=field('#film-compare-result');
root.contains=target=>target===input||target===list||target===clear||target===root;
nodes.set('#film-compare-input',input);
nodes.set('#film-compare-options',list);
nodes.set('#film-compare-clear',clear);
nodes.set('#film-compare-combo',root);
nodes.set('#film-compare-result',result);
const document={
 documentElement:{classList:{toggle(){},add(){},remove(){}}},
 querySelector(selector){if(nodes.has(selector))return nodes.get(selector);if(selector.startsWith('#'))return options.get(selector.slice(1))||null;return null;},
 querySelectorAll(){return [];},
 addEventListener(type,fn){listen(document,type,fn);},
};
const window={
 scrollY:0,scrollTo(){},
 location:{href:'https://iptv.example/film/heat-1995'},
 history:{pushState(){pushed.push('push');},replaceState(){pushed.push('replace');},back(){},forward(){},state:null},
};
const live=vm.createContext({Date,Intl,Set,Map,URL,URLSearchParams,JSON,window,document,fetch(url,options){fetches.push({url:String(url),method:options?.method||'GET'});throw new Error('comparison must not fetch');}});
vm.runInContext(source,live);
const run=code=>vm.runInContext(code,live);
const hour=3600000;
const clock=Date.parse('2026-10-24T12:00:00Z');
run(`viewClock=${clock};CUTOFF=${clock};WINDOW_START=${clock-72*hour};WINDOW_END=${clock+24*hour};report={window:{from:${clock-72*hour},to:${clock+24*hour}},updatedAt:'2026-10-24T12:00:00Z'};urlReady=true;filmScreen='heat-1995'`);
run(`films=[
 {id:'heat-1995',title:'Жара',original:'Heat',year:1995,genres:[],directors:[],actors:[],shows:[]},
 {id:'twin-a',title:'Жара',original:'Heat A',year:1995,genres:[],directors:[],actors:[],shows:[]},
 {id:'twin-b',title:'Жара',original:'Heat B',year:2013,genres:[],directors:[],actors:[],shows:[]},
 {id:'other-1',title:'Другой',original:'Other',year:2001,genres:[],directors:[],actors:[],shows:[]}
];enrichment={films:{
 'heat-1995':{fingerprint:{plotMechanics:['heist'],moodIds:['tense'],execution:{pace:'fast'}}},
 'twin-a':{fingerprint:{plotMechanics:['mystery'],moodIds:[],execution:{pace:'fast'}}},
 'twin-b':{fingerprint:{plotMechanics:['mystery'],moodIds:[],execution:{pace:'slow'}}},
 'other-1':{fingerprint:{plotMechanics:['heist'],moodIds:['tense'],execution:{pace:'fast'}}}
}}`);
run('initFilmCompare()');
const before=run('JSON.stringify({mechanics:[...state.mechanics],moods:[...state.moods],execution:[...state.execution.pace]})');
input.value='жара';
fire(input,'input');
assert.equal(list.hidden,false);
assert.equal(input.getAttribute('aria-expanded'),'true');
assert.match(list.innerHTML,/twin-a/);
assert.match(list.innerHTML,/twin-b/);
assert.equal(list.options.map(item=>item.id).join(','),'film-compare-option-0,film-compare-option-1,film-compare-option-2');
fire(input,'keydown',{key:'ArrowDown'});
fire(input,'keydown',{key:'ArrowDown'});
fire(input,'keydown',{key:'ArrowDown'});
assert.equal(input.getAttribute('aria-activedescendant'),'film-compare-option-2');
assert.equal(JSON.stringify(scrolled.at(-1)),JSON.stringify({id:'film-compare-option-2',arg:{block:'nearest'}}));
assert.equal(options.get('film-compare-option-2').classList.contains('active'),true);
fire(input,'keydown',{key:'Enter'});
assert.equal(run('filmCompareId'),'twin-b');
assert.equal(list.hidden,true);
assert.equal(input.getAttribute('aria-activedescendant'),null);
assert.match(result.innerHTML,/Общих механик нет/);
assert.match(result.innerHTML,/data-compare-open="twin-b"/);
assert.match(result.innerHTML,/Быстрый/);
assert.match(result.innerHTML,/Медленный/);
assert.doesNotMatch(result.innerHTML,/лучше|хуже/);
input.value='жара';
fire(input,'input');
assert.equal(run('filmCompareId'),null);
fire(list,'click',{target:list.options[1]});
assert.equal(run('filmCompareId'),'twin-a');
assert.match(result.innerHTML,/is-same/);
assert.doesNotMatch(result.innerHTML,/Медленный|лучше|хуже/);
input.value='друг';
fire(input,'input');
fire(list,'click',{target:list.options[0]});
assert.equal(run('filmCompareId'),'other-1');
assert.match(result.innerHTML,/Ограбление/);
assert.doesNotMatch(result.innerHTML,/twin-a|twin-b/);
fire(input,'keydown',{key:'ArrowDown'});
fire(input,'keydown',{key:'Escape'});
assert.equal(list.hidden,true);
assert.equal(input.getAttribute('aria-activedescendant'),null);
assert.equal(run('filmCompareId'),'other-1');
fire(input,'keydown',{key:'ArrowDown'});
fire(input,'keydown',{key:'Tab'});
assert.equal(list.hidden,true);
assert.equal(input.getAttribute('aria-activedescendant'),null);
fire(clear,'click');
assert.equal(run('filmCompareId'),null);
assert.match(result.innerHTML,/не подбор похожих/);
assert.equal(run('JSON.stringify({mechanics:[...state.mechanics],moods:[...state.moods],execution:[...state.execution.pace]})'),before);
assert.equal(window.location.href,'https://iptv.example/film/heat-1995');
assert.deepEqual(pushed,[]);
assert.deepEqual(fetches,[]);
console.log('Film compare: typed title, arrows, Enter, click, clear, and canonical id passed');
