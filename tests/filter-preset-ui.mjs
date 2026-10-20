import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const nodes=new Map();
function el(selector){
 if(!nodes.has(selector))nodes.set(selector,{selector,innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},addEventListener(){},focus(){},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];}});
 return nodes.get(selector);
}
const calls=[];
const document={
 hidden:false,addEventListener(){},removeEventListener(){},
 querySelector:selector=>el(selector),
 querySelectorAll:()=>[],
};
const window={
 scrollY:0,scrollTo(){},addEventListener(){},removeEventListener(){},
 location:{href:'https://iptv.example/?genre=%D0%94%D1%80%D0%B0%D0%BC%D0%B0&ref=keep'},
 history:{state:null,replaceState(_state,_title,url){window.location.href=new URL(url,window.location.href).href;}},
 matchMedia(){return {matches:false};},innerWidth:1200,innerHeight:800,
};
let mode='ok',etag='"none"';
const context=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,document,window,console,fetch(url,options){
 calls.push({url:String(url),method:options?.method||'GET',headers:options?.headers||{},body:options?.body||''});
 if(mode==='conflict'&&options?.method!=='GET'&&options?.method){mode='ok';etag='"2"';return new Response(JSON.stringify({error:'Filter presets changed',presets:[]}),{status:412,headers:{ETag:'"2"'}});}
 if(String(url)==='/api/ui/filter-presets'&&(!options?.method||options.method==='GET'))return new Response(JSON.stringify({schemaVersion:1,presets:[{id:'11111111-1111-4111-8111-111111111111',name:'С сервера',query:'started=1'}]}),{status:200,headers:{ETag:etag}});
 const saved=JSON.parse(options.body);
 return new Response(JSON.stringify({schemaVersion:1,presets:[{id:'22222222-2222-4222-8222-222222222222',name:saved.name,query:saved.query}]}),{status:201,headers:{ETag:'"1"'}});
}});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
const run=code=>vm.runInContext(code,context);
run('urlReady=true;state.viewing="rewatch";state.minPrediction=4;state.execution.pace.add("fast");state.execution.decision_logic.add("unknown")');
assert.equal(run('presetQuery()'),'execution=pace%3Afast&viewing=rewatch&prediction=4');
calls.length=0;
await run('createPreset("Пересмотр 4.0+")');
assert.equal(calls[0].method,'POST');
assert.equal(calls[0].headers['If-Match'],'"none"');
assert.deepEqual(JSON.parse(calls[0].body),{name:'Пересмотр 4.0+',query:'execution=pace%3Afast&viewing=rewatch&prediction=4'});
assert.equal(run('presetsEtag'),'"1"');
run('applyPresetQuery("started=1&execution=pace:unknown&execution=pace:fast&token=secret")');
assert.equal(run('state.startedOnly'),true);
assert.equal(run('state.viewing'),'any');
assert.equal(run('state.minPrediction'),null);
assert.equal(run('state.genres.size'),0);
assert.equal(run('state.execution.pace.has("fast")'),true);
assert.equal(run('state.execution.pace.has("unknown")'),false);
assert.match(window.location.href,/ref=keep/);
assert.match(window.location.href,/started=1/);
assert.doesNotMatch(window.location.href,/genre=/);
assert.doesNotMatch(window.location.href,/unknown/);
assert.doesNotMatch(window.location.href,/token=/);
const before=run('state.minPrediction');
mode='conflict';
calls.length=0;
assert.equal(await run('updatePreset("22222222-2222-4222-8222-222222222222")'),false);
assert.equal(calls[0].method,'PATCH');
assert.equal(calls[1].url,'/api/ui/filter-presets');
assert.equal(run('state.minPrediction'),before);
assert.match(run('presetStatus'),/другом устройстве/);
run('presets=[{id:"11111111-1111-4111-8111-111111111111",name:"Старый <b>",query:"started=1"}];presetPrompt={id:presets[0].id,action:"delete"};renderPresets()');
assert.match(el('#preset-list').innerHTML,/Старый &lt;b&gt;/);
assert.match(el('#preset-list').innerHTML,/Удалить этот сценарий\?/);
assert.doesNotMatch(el('#preset-list').innerHTML,/<b>/);
console.log('Filter preset UI: canonical query, full replacement, conflict and escaped names passed');
