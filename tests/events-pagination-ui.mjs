import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const app=fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,'');
const html=fs.readFileSync('public/index.html','utf8');
const css=fs.readFileSync('public/styles.css','utf8');
const attributes=new Map(),classes=new Set();
const button={
 disabled:false,hidden:false,textContent:'Более давние события',
 classList:{
  toggle(name,enabled){if(enabled)classes.add(name);else classes.delete(name);},
  remove(name){classes.delete(name);}
 },
 setAttribute(name,value){attributes.set(name,String(value));},
 removeAttribute(name){attributes.delete(name);}
};
const status={textContent:''},list={innerHTML:''};
const nodes={'#activity-more':button,'#activity-status':status,'#activity-list':list};
const document={querySelector(selector){return nodes[selector]||null;}};
let complete;
const context=vm.createContext({Date,Intl,URL,Set,Map,document,fetch:()=>new Promise(resolve=>{complete=resolve;})});
vm.runInContext(app,context);
vm.runInContext("eventCursor='previous-page';",context);

const loading=vm.runInContext('loadEvents(true)',context);
assert.equal(button.disabled,true,'pagination button is immediately disabled');
assert.equal(button.textContent,'Загружаем события…','user sees a busy label');
assert.equal(attributes.get('aria-busy'),'true','loading state is accessible');
assert(classes.has('is-loading'),'loading class drives the spinner');
assert.match(status.textContent,/Загружаем более давние события/);
assert.equal(await vm.runInContext('loadEvents(true)',context),'busy','a second click cannot trigger another request');
complete({ok:true,json:async()=>({events:[],cursor:'next-page'})});
assert.equal(await loading,true);
assert.equal(button.disabled,false);
assert.equal(button.textContent,'Более давние события');
assert.equal(button.hidden,false);
assert(!classes.has('is-loading'));
assert.equal(attributes.has('aria-busy'),false);
assert.equal(status.textContent,'');

context.fetch=async()=>{throw Error('network unavailable');};
assert.equal(await vm.runInContext('loadEvents(true)',context),false);
assert.equal(button.disabled,false,'failed pagination remains retryable');
assert.equal(button.textContent,'Повторить');
assert.equal(button.hidden,false);
assert(!classes.has('is-loading'),'failure clears the spinner');
assert.equal(attributes.has('aria-busy'),false);
assert.match(status.textContent,/Не удалось загрузить события/);

assert.match(css,/#activity-more\.is-loading::before/,'spinner is visible in the loading state');
assert.match(css,/#activity-more:disabled/,'disabled appearance is intentional');
assert.match(css,/prefers-reduced-motion:reduce/,'spinner supports reduced motion');
assert.match(html,/id="activity-status" role="status"/,'loading feedback is announced to assistive tech');
console.log('Events pagination UI: disabled + spinner + busy label, duplicate prevention, retry and cleanup passed');
