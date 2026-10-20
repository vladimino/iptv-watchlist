import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,puts=[];
const bucket={
 async get(key){if(!records.has(key))return null;const etag=etags.get(key);return {etag,httpEtag:`"${etag}"`,json:async()=>structuredClone(records.get(key))};},
 async put(key,value,options={}){const condition=options.onlyIf||{},current=etags.get(key);if(condition.etagDoesNotMatch==='*'&&records.has(key)||condition.etagMatches&&condition.etagMatches!==current)return null;records.set(key,JSON.parse(value));const etag=String(++revision);etags.set(key,etag);puts.push(key);return {etag,httpEtag:`"${etag}"`};},
 async delete(){},async list(){return {objects:[],truncated:false};},
};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},fetch:async()=>{throw new Error('unexpected fetch');}});
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/migration-export.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const env={BUCKET:bucket};
const execution={waitUntil(){},exports:{}};
async function call(method,path,etag,body,origin){
 const headers={};
 if(etag)headers['If-Match']=etag;
 if(body)headers['Content-Type']='application/json';
 if(origin)headers.Origin=origin;
 const response=await context.worker.fetch(new Request('https://iptv.example'+path,{method,headers,body:body?JSON.stringify(body):undefined}),env,execution);
 return {status:response.status,etag:response.headers.get('ETag'),body:await response.json()};
}
let saved=puts.length;
const empty=await call('GET','/api/ui/filter-presets');
assert.equal(empty.status,200);
assert.equal(empty.etag,'"none"');
assert.deepEqual(empty.body.presets,[]);
assert.equal(puts.length,saved,'reading presets does not write');
assert.equal((await call('POST','/api/ui/filter-presets',null,{name:'Пересмотр 4.0+',query:'viewing=rewatch&prediction=4'})).status,428);
const created=await call('POST','/api/ui/filter-presets','"none"',{name:'  Пересмотр 4.0+  ',query:'viewing=rewatch&prediction=4&execution=pace:unknown&token=secret'});
assert.equal(created.status,201);
assert.equal(created.body.presets.length,1);
assert.equal(created.body.presets[0].name,'Пересмотр 4.0+');
assert.equal(created.body.presets[0].query,'viewing=rewatch&prediction=4');
assert.equal(puts.length,1);
assert.deepEqual([...records.keys()],['ui/filter-presets.json']);
saved=puts.length;
const listed=await call('GET','/api/ui/filter-presets');
assert.equal(listed.etag,created.etag);
assert.equal(listed.body.presets[0].id,created.body.presets[0].id);
assert.equal(puts.length,saved,'a second read still does not write');
const stale=await call('POST','/api/ui/filter-presets','"none"',{name:'Другой',query:'started=1'});
assert.equal(stale.status,412);
assert.equal(records.get('ui/filter-presets.json').presets.length,1);
const id=created.body.presets[0].id;
const renamed=await call('PATCH','/api/ui/filter-presets/'+id,created.etag,{name:'Короткое на вечер'});
assert.equal(renamed.status,200);
assert.equal(renamed.body.presets[0].name,'Короткое на вечер');
assert.equal(renamed.body.presets[0].query,'viewing=rewatch&prediction=4');
const replaced=await call('PATCH','/api/ui/filter-presets/'+id,renamed.etag,{query:'started=1&execution=ending_quality:strong&execution=decision_logic:strong'});
assert.equal(replaced.status,200);
assert.equal(replaced.body.presets[0].name,'Короткое на вечер');
assert.equal(new URLSearchParams(replaced.body.presets[0].query).get('started'),'1');
assert.deepEqual(new URLSearchParams(replaced.body.presets[0].query).getAll('execution'),['decision_logic:strong','ending_quality:strong']);
const conflict=await call('PATCH','/api/ui/filter-presets/'+id,renamed.etag,{query:'q=чужой'});
assert.equal(conflict.status,412);
assert.equal(records.get('ui/filter-presets.json').presets[0].query,replaced.body.presets[0].query);
assert.equal((await call('DELETE','/api/ui/filter-presets/'+id,renamed.etag)).status,412);
assert.equal((await call('PATCH','/api/ui/filter-presets/'+id,replaced.etag,{},'https://evil.example')).status,403);
const removed=await call('DELETE','/api/ui/filter-presets/'+id,replaced.etag);
assert.equal(removed.status,200);
assert.deepEqual(removed.body.presets,[]);
assert.equal((await call('POST','/api/ui/filter-presets',removed.etag,{name:' ',query:''})).status,400);
let etag=removed.etag;
for(let i=0;i<30;i++){const next=await call('POST','/api/ui/filter-presets',etag,{name:'Набор '+i,query:i===0?'channel=Первый&channel=Второй':''});assert.equal(next.status,201);etag=next.etag;}
assert.equal((await call('POST','/api/ui/filter-presets',etag,{name:'Лишний',query:''})).status,400);
assert.equal(records.get('ui/filter-presets.json').presets.length,30);
records.set('ui/filter-presets.json',{schemaVersion:1,presets:[{id:'11111111-1111-4111-8111-111111111111',name:'Старый <b>',query:'execution=pace:unknown&execution=pace:fast&token=secret&viewing=rewatch',createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:00.000Z'}]});
etags.set('ui/filter-presets.json','legacy');
saved=puts.length;
const legacy=await call('GET','/api/ui/filter-presets');
assert.equal(puts.length,saved,'cleaning a legacy preset does not write');
const legacyParams=new URLSearchParams(legacy.body.presets[0].query);
assert.deepEqual(legacyParams.getAll('execution'),['pace:fast']);
assert.equal(legacyParams.get('viewing'),'rewatch');
assert.equal(legacyParams.has('token'),false);
console.log('Filter presets: conditional R2 document, normalization, limit and read-only GET passed');
