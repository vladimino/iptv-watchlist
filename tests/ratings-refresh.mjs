import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// The ratings-only refresh is retired (ADR 0040). Whatever the RATINGS_REFRESH binding, method or body, the route answers
// 410 Gone before reading the body: no Letterboxd request, no bucket read, list or write. Stored ratings stay readable.
const records=new Map(),operations=[],fetches=[];
const bucket={
 async get(key){operations.push(['get',key]);return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value){operations.push(['put',key]);records.set(key,JSON.parse(value));return {etag:'e'};},
 async delete(key){operations.push(['delete',key]);records.delete(key);},
 async list(options){operations.push(['list',options?.prefix]);return {objects:[],truncated:false};}
};
const ctx=vm.createContext({Response,Request,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console,setTimeout,fetch:async url=>{fetches.push(String(url));throw new Error('no network in this test');}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const env={LETTERBOXD_USERNAME:'demo-user',EPG_XML_URL:'https://epg.test/guide.xml',BUCKET:bucket};

const status={schemaVersion:1,state:'blocked',lastSuccessAt:'2026-10-23T18:00:00.000Z',lastFailureAt:'2026-10-28T09:00:00.000Z',nextRetryAt:null,generationId:'g-1',pages:2,watched:120,attempt:{kind:'full',outcome:'failed',cause:'anti_bot'},diary:{state:'unchecked',cause:null,error:null}};
records.set('enrichment/ratings/status.json',status);
records.set('enrichment/ratings/published.json',{generationId:'g-1',projected:true});
records.set('enrichment/ratings/pending.json',{generationId:'g-2',done:false});
records.set('enrichment/ratings/generations/g-1.json',{id:'g-1',ratings:{rated:4.5}});
records.set('enrichment/ratings/lease.json',{id:'stale',expiresAt:0});
records.set('enrichment/view-index.json',{rated:{actualRating:4.5}});
const stored=()=>JSON.stringify([...records.entries()].sort());
const before=stored();

const bodies=[JSON.stringify({}),JSON.stringify({mode:'repair',filmIds:['rated']}),JSON.stringify({mode:'full'}),'not json',null];
for(const flag of [undefined,'on','off','On',' on'])for(const method of ['POST','GET','PUT'])for(const body of bodies){
 if(method==='GET'&&body!==null)continue;
 operations.length=0;fetches.length=0;
 const init={method,headers:{'Content-Type':'application/json'}};if(body!==null)init.body=body;
 const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/ratings/refresh',init),flag===undefined?env:{...env,RATINGS_REFRESH:flag});
 const data=await response.json();
 assert.equal(response.status,410,`${method} with RATINGS_REFRESH=${flag} and body ${body} is gone`);
 assert.equal(data.error,'gone');
 assert.match(data.detail,/retired/);
 assert.deepEqual(operations,[],`${method} with RATINGS_REFRESH=${flag} touches no stored object`);
 assert.deepEqual(fetches,[],`${method} with RATINGS_REFRESH=${flag} sends no Letterboxd request`);
}
assert.equal(stored(),before,'every stored ratings object, the lease and the view index are left as they were');

for(const flag of [undefined,'on']){
 const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/ratings/status'),flag===undefined?env:{...env,RATINGS_REFRESH:flag});
 const data=await response.json();
 assert.equal(response.status,200);
 assert.equal(data.enabled,false,'the status reports the refresh as unavailable even with a stale binding');
 assert.equal(data.state,'blocked');
 assert.equal(data.lastSuccessAt,status.lastSuccessAt);
 assert.equal(data.generationId,'g-1');
 assert.equal(data.pendingGenerationId,'g-2');
 assert.deepEqual(operations.filter(([op])=>op!=='get'),[],'the status read writes nothing');
}
assert.equal(fetches.length,0);
assert.equal(stored(),before);
assert.equal(typeof ctx.ratingsRefresh,'undefined','the refresh entry point is removed');
assert.equal(typeof ctx.ratingsEnabled,'undefined','nothing reads RATINGS_REFRESH');
console.log('Ratings refresh retired (ADR 0040): 410 Gone for every flag value, method and body, no fetch, no bucket access, stored ratings still readable');
