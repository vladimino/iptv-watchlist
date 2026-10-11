import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

let upstreamStatus=200,seenAuthorization=null;
const fetch=async(url,options)=>{
 assert.equal(url,'https://api.themoviedb.org/3/movie/11?language=en-US');
 seenAuthorization=options.headers.Authorization;
 return new Response(upstreamStatus===200?JSON.stringify({id:11}):'{}',{status:upstreamStatus});
};
const context=vm.createContext({Response,Request,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,fetch,console});
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const request=new Request('https://site.example/api/integrations/tmdb/status');
const bucket={get:async()=>null};
let response=await context.worker.fetch(request,{BUCKET:bucket});
assert.equal(response.status,503);assert.deepEqual(await response.json(),{connected:false,stage:'missing_secret'});
response=await context.worker.fetch(request,{BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test-token'});
assert.equal(response.status,200);assert.deepEqual(await response.json(),{connected:true,stage:'ready'});assert.equal(seenAuthorization,'Bearer test-token');
upstreamStatus=401;response=await context.worker.fetch(request,{BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test-token'});
assert.equal(response.status,502);assert.deepEqual(await response.json(),{connected:false,stage:'tmdb_http',status:401});
console.log('TMDB runtime secret guard and upstream verification passed');
