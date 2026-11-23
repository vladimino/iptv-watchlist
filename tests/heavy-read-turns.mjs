// AIR-586 review: the four large reads of the page (programme, view, Finds, footer) take one shared turn wherever they are called from. The first load, a
// live refresh started by focus or visibility while the first load is still running, and the cold-failure retry must never put two of them in flight at
// once: together they land in one Worker isolate and exceed its memory limit. This runs the real `init()` with the first programme read failing, holds the
// first view read open, fires focus, visibility and the cold retry meanwhile, and checks that at most one large read is ever in flight, that a loader
// already waiting is shared (not queued twice), and that the page recovers.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped as scopedAvailability} from '../scripts/bundle-scope.mjs';

const listeners={document:new Map(),window:new Map()};
const add=(map,type,fn)=>{const list=map.get(type)||[];list.push(fn);map.set(type,list);};
const nodes=new Map();
function el(selector){
 if(!nodes.has(selector))nodes.set(selector,{selector,innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,scrollTop:0,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},addEventListener(){},removeEventListener(){},focus(){},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(sel){return el(selector+' '+sel);},querySelectorAll(){return [];}});
 return nodes.get(selector);
}
const document={hidden:false,addEventListener(type,fn){add(listeners.document,type,fn);},removeEventListener(){},querySelector:el,querySelectorAll(){return [];}};
const window={scrollY:0,scrollTo(){},addEventListener(type,fn){add(listeners.window,type,fn);},removeEventListener(){},location:{href:'https://iptv.example/'},history:{state:null,replaceState(_s,_t,url){window.location.href=new URL(url,window.location.href).href;}}};

const HEAVY=new Set(['/api/programme','/api/enrichment/view','/api/catalog/available','/api/enrichment/footer/status']);
const pending=[],calls=[],timers=[];
let heavyInFlight=0,maxHeavyInFlight=0,programmeFailures=1;
const programme={updatedAt:'2026-10-18T12:00:00Z',publishedAt:'2026-10-18T12:00:00Z',window:{from:Date.parse('2026-10-15T12:00:00Z'),to:Date.parse('2026-10-19T12:00:00Z')},films:[{id:'film-1',title:'Первый',original:'First',year:2020,runtime:100,genres:['Драма'],shows:[]}],people:{directors:[],actors:[]}};
function payload(path){
 if(path==='/api/programme')return programme;
 if(path==='/api/enrichment/view')return {profile:null,films:{}};
 if(path==='/api/catalog/available')return {programmeRunId:'run',pinned:true,films:[]};
 if(path==='/api/enrichment/footer/status')return {profile:null,coverage:null,predictions:null};
 if(path==='/api/events')return {events:[],cursor:null};
 if(path==='/api/started')return {ids:[]};
 if(path==='/api/ui/filter-presets')return {presets:[]};
 return {};
}
const context=vm.createContext({
 Date,Intl,URL,URLSearchParams,Set,Map,Promise,JSON,console,document,window,
 setInterval(){return 1;},clearInterval(){},
 setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){},
 fetch(url){
  const path=String(url).split('?')[0];
  calls.push(path);
  const heavy=HEAVY.has(path);
  if(heavy){heavyInFlight++;maxHeavyInFlight=Math.max(maxHeavyInFlight,heavyInFlight);}
  return new Promise(resolve=>pending.push({path,finish(){
   if(heavy)heavyInFlight--;
   const fail=path==='/api/programme'&&programmeFailures>0&&programmeFailures--;
   resolve({ok:!fail,status:fail?503:200,headers:{get(){return null;}},json:async()=>fail?{}:payload(path)});
  }}));
 },
});
vm.runInContext(scopedAvailability('src/domain/film-availability.js','FilmAvailability')+'\n'+fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
const run=code=>vm.runInContext(code,context);
const tickOver=()=>new Promise(resolve=>setImmediate(resolve));
// Answer every open request except the ones `hold` keeps open, then let the page react.
async function step(hold=()=>false){for(const item of pending.splice(0)){if(hold(item.path))pending.push(item);else item.finish();}await tickOver();}

const started=run('init()');
await tickOver();
assert.deepEqual(calls.filter(path=>HEAVY.has(path)),['/api/programme'],'the first load starts with the programme alone');
// The first programme read fails (503): the cold path, which arms the 5 s retry and goes on with the other large reads.
const holdView=path=>path==='/api/enrichment/view';
await step(holdView);
for(let i=0;i<5;i++)await step(holdView);
await started;
assert.equal(el('#result-count').textContent,'Программа временно недоступна');
assert.ok(timers.some(timer=>timer.ms===5000),'a cold failure arms one quick retry');
// Hold the first view read open while the tab gets focus and becomes visible again, and the cold retry fires.
assert.deepEqual(calls.filter(path=>HEAVY.has(path)),['/api/programme','/api/enrichment/view'],'the view is in flight, Finds and the footer wait for their turn');
assert.equal(run('loadCatalog()===loadCatalog()'),true,'a loader already waiting for its turn is shared, not queued twice');
listeners.window.get('focus')[0]();
listeners.document.get('visibilitychange')[0]();
for(const timer of timers.filter(timer=>timer.ms===5000))timer.fn();
for(let i=0;i<5;i++)await step(holdView);
assert.equal(maxHeavyInFlight,1,'the refresh and the retry do not start a large read while the first view read is open');
assert.deepEqual(calls.filter(path=>HEAVY.has(path)),['/api/programme','/api/enrichment/view'],'they wait for the turn');
// Release everything and let both the first load and the refresh settle.
for(let i=0;i<200&&(pending.length||run('heavyActive')>0||run('liveRunning')||run('livePending')||run('liveCoalesced'));i++)await step();
assert.equal(maxHeavyInFlight,1,'never two large reads at once, from the first load to the end of the refresh');
assert.equal(run('programmeReady'),true,'the retry restored the programme');
assert.equal(run('films[0].title'),'Первый');
assert.notEqual(el('#result-count').textContent,'Программа временно недоступна');
const heavy=calls.filter(path=>HEAVY.has(path));
assert.equal(heavy[0],'/api/programme');
assert.ok(heavy.filter(path=>path==='/api/programme').length>=2,'the failed first read and the retry');
assert.ok(heavy.indexOf('/api/catalog/available')>heavy.indexOf('/api/enrichment/view'),'Finds after the view of the first load');
assert.equal(run('heavyActive'),0);
console.log('Heavy read turns: the first load, a focus/visibility refresh and the cold retry share one turn (never two large reads at once), waiting loaders are shared, and the page recovers passed');
