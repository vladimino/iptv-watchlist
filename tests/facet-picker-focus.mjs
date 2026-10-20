import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
const ids=new Map();
const document={activeElement:null,listeners:new Map()};
function datasetKey(name){return name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());}
function remember(node){if(node.id)ids.set(node.id,node);for(const child of node.childNodes)remember(child);}
function forget(node){if(node.id&&ids.get(node.id)===node)ids.delete(node.id);for(const child of node.childNodes)forget(child);}
function parseAttributes(raw){
 const attrs={};
 for(const match of raw.matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))attrs[match[1].toLowerCase()]=match[2]??match[3]??match[4]??'';
 return attrs;
}
class Element{
 constructor(tag,attrs={}){
  this.tagName=tag.toUpperCase();
  this.attrs={...attrs};
  this.childNodes=[];
  this.parentNode=null;
  this.listeners=new Map();
  this.style={};
  this.dataset={};
  this.className=attrs.class||'';
  this.id=attrs.id||'';
  this.value=attrs.value||'';
  this.checked=Object.hasOwn(attrs,'checked');
  this.disabled=Object.hasOwn(attrs,'disabled');
  this.hidden=Object.hasOwn(attrs,'hidden');
  this.open=false;
  for(const [name,value] of Object.entries(attrs))if(name.startsWith('data-'))this.dataset[datasetKey(name)]=value;
 }
 get classList(){
  const node=this;
  return {contains(name){return node.className.split(/\s+/).includes(name);},toggle(name,force){const names=new Set(node.className.split(/\s+/).filter(Boolean));const on=force===undefined?!names.has(name):!!force;on?names.add(name):names.delete(name);node.className=[...names].join(' ');return on;},add(name){this.toggle(name,true);},remove(name){this.toggle(name,false);}};
 }
 set innerHTML(html){forget(this);this.childNodes=[];const nodes=parseHTML(html);for(const node of nodes){node.parentNode=this;this.childNodes.push(node);}remember(this);}
 matches(selector){
  const match=/^(?:([a-zA-Z][\w-]*)|\*)?(?:#([\w-]+))?((?:\.[-\w]+)*)((?:\[[^\]]+\])*)$/.exec(selector);
  if(!match)return false;
  if(match[1]&&match[1].toLowerCase()!==this.tagName.toLowerCase())return false;
  if(match[2]&&match[2]!==this.id)return false;
  for(const name of match[3].split('.').filter(Boolean))if(!this.className.split(/\s+/).includes(name))return false;
  for(const attr of match[4].matchAll(/\[([^\]]+)\]/g)){const [,name,value]=/^([^\s=~|^$*]+)(?:="([^"]*)")?$/.exec(attr[1])||[];if(!name||!Object.hasOwn(this.attrs,name))return false;if(value!==undefined&&this.attrs[name]!==value)return false;}
  return true;
 }
 querySelectorAll(selector){
  const steps=selector.trim().split(/\s+/);
  let current=[this];
  for(const step of steps){const next=[];for(const node of current)for(const found of walk(node))if(found!==node&&found.matches?.(step))next.push(found);current=next;}
  return current;
 }
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 contains(node){for(let current=node;current;current=current.parentNode)if(current===this)return true;return false;}
 closest(selector){for(let node=this;node&&node.tagName;node=node.parentNode)if(node.matches(selector))return node;return null;}
 addEventListener(type,fn){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list);}
 setAttribute(name,value){this.attrs[name]=String(value);if(name==='class')this.className=String(value);if(name==='id'){ids.delete(this.id);this.id=String(value);ids.set(this.id,this);}if(name.startsWith('data-'))this.dataset[datasetKey(name)]=String(value);}
 getAttribute(name){return Object.hasOwn(this.attrs,name)?this.attrs[name]:null;}
 removeAttribute(name){delete this.attrs[name];}
 focus(){document.activeElement=this;}
 scrollIntoView(){}
 getBoundingClientRect(){return {bottom:40,left:16,top:0,right:0,width:0,height:0};}
 dispatchEvent(event){const path=[];for(let node=this;node;node=node.parentNode)path.push(node);event.target??=this;for(const node of path){for(const fn of [...(node.listeners?.get(event.type)||[])])fn(event);if(event.cancelBubble)break;}return true;}
}
function walk(node){const out=[node];for(const child of node.childNodes||[])out.push(...walk(child));return out;}
function parseHTML(html){
 const roots=[],stack=[];
 let i=0;
 while(i<html.length){
  if(html[i]!=='<'){const next=html.indexOf('<',i);i=next<0?html.length:next;continue;}
  if(html.startsWith('<!',i)){const end=html.indexOf('>',i);i=end<0?html.length:end+1;continue;}
  const token=/^<(\/?)([a-zA-Z][\w:-]*)\s*([^>]*)>/.exec(html.slice(i));
  if(!token){i++;continue;}
  i+=token[0].length;
  const closing=token[1]==='/',name=token[2].toLowerCase(),raw=token[3].replace(/\/$/,'');
  if(closing){while(stack.length&&stack.at(-1).tagName.toLowerCase()!==name)stack.pop();stack.pop();continue;}
  const node=new Element(name,parseAttributes(raw));
  const parent=stack.at(-1);
  if(parent){node.parentNode=parent;parent.childNodes.push(node);}else roots.push(node);
  if(!VOID.has(name)&&!token[3].trimEnd().endsWith('/'))stack.push(node);
 }
 return roots;
}
const roots=parseHTML(fs.readFileSync('public/index.html','utf8'));
const html=roots.find(node=>node.tagName==='HTML');
html.parentNode=document;
for(const node of roots)remember(node);
document.documentElement=html;
document.body=html.querySelector('body');
document.activeElement=document.body;
document.addEventListener=(type,fn)=>{const list=document.listeners.get(type)||[];list.push(fn);document.listeners.set(type,list);};
document.removeEventListener=()=>{};
document.querySelector=selector=>selector.startsWith('#')&&!selector.includes(' ')?ids.get(selector.slice(1))||null:html.querySelector(selector);
document.querySelectorAll=selector=>html.querySelectorAll(selector);
document.dispatchEvent=event=>html.dispatchEvent(event);
const window={
 innerWidth:1200,innerHeight:800,scrollY:0,
 matchMedia(){return {matches:false};},
 scrollTo(_x,y){window.scrollY=y;},
 addEventListener(){},removeEventListener(){},
 location:{href:'https://iptv.example/'},
 history:{state:null,replaceState(_state,_title,url){window.location.href=new URL(url,window.location.href).href;}},
};
const context=vm.createContext({Date,Intl,URL,Set,Map,document,window,requestAnimationFrame(fn){fn();}});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
const run=code=>vm.runInContext(code,context);
run(`CUTOFF=1000000000000;WINDOW_START=CUTOFF-72*3600000;WINDOW_END=CUTOFF+24*3600000;const show=(channel,start)=>({channel,start,offset:(start-CUTOFF)/3600000});films=[
 {id:'a',title:'Альфа',original:'A',aliases:[],year:2020,runtime:90,genres:['Драма'],directors:[],actors:[],shows:[show('Первый',CUTOFF-3600000)]},
 {id:'b',title:'Бета',original:'B',aliases:[],year:2020,runtime:100,genres:['Комедия'],directors:[],actors:[],shows:[show('Второй',CUTOFF-1800000)]},
 {id:'c',title:'Гамма',original:'C',aliases:[],year:2020,runtime:80,genres:['Драма'],directors:[],actors:[],shows:[show('Первый',CUTOFF+2*3600000)]},
];enrichment={films:{a:{fingerprint:{execution:{pace:'fast',decision_logic:'strong'}}},b:{fingerprint:{execution:{pace:'slow',decision_logic:'mixed'}}},c:{fingerprint:{execution:{pace:'fast',decision_logic:'weak'}}}}};`);
run('bindControls()');
const body=()=>document.querySelector('#facet-body');
const checkbox=(dimension,value)=>[...body().querySelectorAll('input')].find(input=>input.dataset.execution===dimension&&input.value===value);
function press(input){const previous=input;input.focus();input.checked=!input.checked;input.dispatchEvent({type:'change',preventDefault(){}});return previous;}
const trigger=document.querySelector('[data-facet="execution"]');
trigger.dispatchEvent({type:'click',preventDefault(){}});
assert.equal(document.activeElement,document.querySelector('#facet-search'),'opening a picker moves focus into it');
assert.equal(document.querySelector('#facet-popover').hidden,false);
const first=checkbox('pace','fast');
const replaced=press(first);
const kept=document.activeElement;
assert.notEqual(kept,replaced,'the checkbox is recreated');
assert.equal(body().contains(kept),true,'focus stays inside the open picker');
assert.equal(kept.dataset.execution,'pace');
assert.equal(kept.value,'fast');
assert.equal(kept.checked,true);
assert.equal(run('state.execution.pace.has("fast")'),true);
const second=checkbox('decision_logic','strong');
press(second);
assert.equal(document.activeElement.dataset.execution,'decision_logic');
assert.equal(document.activeElement.value,'strong');
assert.equal(body().contains(document.activeElement),true,'a second keyboard choice does not send focus back to the page');
const search=document.querySelector('#facet-search');
search.focus();search.value='сил';search.dispatchEvent({type:'input',preventDefault(){}});
assert.equal(document.activeElement,search,'typing in the picker search keeps the caret there');
document.dispatchEvent({type:'keydown',key:'Escape',preventDefault(){}});
assert.equal(document.querySelector('#facet-popover').hidden,true);
assert.equal(document.activeElement,trigger,'closing the picker returns focus to the trigger that opened it');
trigger.dispatchEvent({type:'click',preventDefault(){}});
document.querySelector('#facet-close').dispatchEvent({type:'click',preventDefault(){}});
assert.equal(document.activeElement,trigger,'the close button also returns focus to the trigger');
console.log('Facet picker focus: keyboard selection, search, Escape and close passed');
