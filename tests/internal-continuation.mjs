import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,puts=[];
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,EPG_SITE_SERVICE_TOKEN:'legacy-site-secret',EPG_XML_URL:'https://epg.test/guide.xml',LETTERBOXD_USERNAME:'tester'};
const fetches=[];let epgResponse=()=>new Response('unavailable',{status:503});
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},
 fetch:async input=>{const url=String(input instanceof Request?input.url:input);fetches.push(url);return url===env.EPG_XML_URL?epgResponse():new Response('unexpected',{status:599});}});
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const worker=context.worker,entrypoint=vm.runInContext('DiscoveryContinuation',context);

// Every loopback call is a separate invocation with its own waitUntil, as ctx.exports is on Cloudflare.
const background=[],hops=[];
function invocation({exports=true,loopback}={}){
 const execution={waitUntil:p=>{background.push(p);}};
 if(exports)execution.exports={DiscoveryContinuation:{fetch:loopback||(async(input,init)=>{const request=new Request(input,init);hops.push({url:request.url,method:request.method,headers:[...request.headers.keys()],body:await request.clone().json()});return entrypoint.fetch(request,env,invocation());})}};
 return execution;
}
async function drain(){while(background.length)await background.shift();}

const origin='https://iptv.vladimino.workers.dev';
const browserHeaders={'Content-Type':'application/json',Cookie:'CF_Authorization=browser-session','Cf-Access-Jwt-Assertion':'header.payload.signature','OAI-Sites-Authorization':'Bearer legacy-site-token'};
const call=(path,body,{headers=browserHeaders,execution=invocation()}={})=>worker.fetch(new Request(origin+path,{method:'POST',headers,body:JSON.stringify(body)}),env,execution);
const now=Date.now();
function seed(count){
 records.clear();etags.clear();hops.length=0;fetches.length=0;puts=[];
 records.set('programme.json',{runId:'run-1',updatedAt:new Date(now).toISOString(),films:[{id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,shows:[]}]});
 records.set(vm.runInContext('profileKey',context),{version:1,profileHash:'p'});
 records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:Array.from({length:count},(_,i)=>({key:'hot film|2020|'+i,title:'Hot Film',normalizedTitle:'hot film',year:2020,duration:100,durations:[100],firstAiring:now,lastAiring:now,airings:1}))});
}
const continuation=()=>records.get('epg/resolver-continuation.json');

// A browser-started resolve drains the backlog through internal hops; nothing it carried is forwarded or stored.
seed(30);
let response=await call('/api/enrichment/discovery/resolve',{limit:1,chunks:3});
assert.equal(response.status,200);
const first=await response.json();
assert.equal(first.remaining,29);assert.deepEqual(first.continuation,{scheduled:true,remainingChunks:2});
await drain();
assert.deepEqual(hops.map(h=>h.body),[{chunks:2},{chunks:1}]);
for(const hop of hops){assert.equal(hop.url,'https://iptv.internal/discovery/continue');assert.equal(hop.method,'POST');assert.deepEqual(hop.headers,['content-type']);}
assert.equal(Object.values(records.get('epg/discovery-resolution.json')).filter(d=>d.status==='verified').length,30);
assert.equal(continuation().stage,'complete');assert.equal(records.get('epg/discovery-status.json').error,null);
assert.deepEqual(fetches,[],'no TMDB, own-origin or legacy Site request');
assert.doesNotMatch(JSON.stringify([...records]),/legacy-site|browser-session|header\.payload/,'no credential is persisted');

// The chunk budget bounds the chain and leaves the rest to the next catch-up.
seed(60);
await (await call('/api/enrichment/discovery/resolve',{limit:1,chunks:2})).json();await drain();
assert.deepEqual(hops.map(h=>h.body),[{chunks:1},{chunks:0}]);
assert.equal(continuation().stage,'paused');assert.equal(continuation().reason,'chunk_budget');assert.equal(continuation().remaining,11);assert(continuation().nextCatchUpAt);
seed(400);
await (await call('/api/enrichment/discovery/resolve',{limit:24})).json();await drain();
assert.equal(hops.length,12,'one trigger yields at most twelve continuation hops');assert.deepEqual(hops.at(-1).body,{chunks:0});assert.equal(continuation().reason,'chunk_budget');

// A live resolver lease stops the chain without another hop.
seed(5);records.set('epg/resolver-lease.json',{id:'other',expiresAt:Date.now()+60000});
const busy=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();await drain();
assert.equal(busy.stage,'busy');assert.deepEqual(busy.continuation,{scheduled:false,reason:'busy'});assert.equal(hops.length,0);

// Without the loopback binding the chain stops visibly and never falls back to public fetch.
seed(5);
const unavailable=await (await call('/api/enrichment/discovery/resolve',{limit:1},{execution:invocation({exports:false})})).json();await drain();
assert.deepEqual(unavailable.continuation,{scheduled:false,reason:'internal_dispatch_unavailable'});assert.equal(continuation().stage,'error');assert.equal(continuation().reason,'internal_dispatch_unavailable');assert.deepEqual(fetches,[]);

// A failed or timed-out hop is recorded for the hourly catch-up.
seed(5);
await (await call('/api/enrichment/discovery/resolve',{limit:1},{execution:invocation({loopback:async()=>new Response('{}',{status:500})})})).json();await drain();
assert.equal(continuation().stage,'error');assert.equal(continuation().reason,'continuation HTTP 500');
seed(5);
await (await call('/api/enrichment/discovery/resolve',{limit:1},{execution:invocation({loopback:async()=>{throw new Error('The operation was aborted due to timeout');}})})).json();await drain();
assert.equal(continuation().reason,'The operation was aborted due to timeout');

// The entrypoint accepts only a well-formed hop and rejects everything else before touching R2.
seed(5);
const internal=(init,path='/discovery/continue',bindings=env)=>entrypoint.fetch(new Request('https://iptv.internal'+path,init),bindings,invocation());
for(const [init,path,status] of [
 [{method:'GET'},undefined,404],
 [{method:'POST',body:'{"chunks":1}'},'/api/enrichment/discovery/resolve',404],
 [{method:'POST',body:'{'},undefined,400],
 [{method:'POST',body:'[]'},undefined,400],
 [{method:'POST',body:'{}'},undefined,400],
 [{method:'POST',body:'{"chunks":12}'},undefined,400],
 [{method:'POST',body:'{"chunks":-1}'},undefined,400],
 [{method:'POST',body:'{"chunks":1.5}'},undefined,400],
 [{method:'POST',body:'{"chunks":1,"limit":24}'},undefined,400],
])assert.equal((await internal(init,path)).status,status,JSON.stringify([init,path]));
assert.equal((await internal({method:'POST',body:'{"chunks":1}'},undefined,{...env,BUCKET:undefined})).status,503);
assert.deepEqual(puts,[]);await drain();assert.equal(hops.length,0);

// Public HTTP lands on the default export, which has no route to the continuation.
seed(5);
for(const path of ['/discovery/continue','/api/discovery/continue','/api/enrichment/discovery/continue'])assert.equal((await call(path,{chunks:1})).status,404,path);
await drain();assert.deepEqual(puts,[]);assert.equal(hops.length,0);

// Cross-site mutation requests are refused before any write or dispatch; same-origin ones still work.
seed(5);
for(const path of ['/api/enrichment/discovery/resolve','/api/enrichment/discovery/scan','/api/sync/epg'])assert.equal((await call(path,{limit:1},{headers:{...browserHeaders,Origin:'https://evil.example'}})).status,403,path);
await drain();assert.deepEqual(puts,[]);assert.equal(hops.length,0);assert.deepEqual(fetches,[]);
assert.equal((await call('/api/enrichment/discovery/resolve',{limit:1,chunks:0},{headers:{...browserHeaders,Origin:origin}})).status,200);

// Scan reads the configured XMLTV source and starts the chain through the loopback.
seed(5);
response=await call('/api/enrichment/discovery/scan',{});
assert.equal(response.status,502);assert.equal((await response.json()).error,'EPG HTTP 503');assert.deepEqual(fetches,['https://epg.test/guide.xml']);
const xmltv=t=>new Date(t).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
epgResponse=()=>new Response(`<tv><channel id="c1"><display-name>Кино</display-name></channel><programme channel="c1" start="${xmltv(now+9*3600000)}" stop="${xmltv(now+9*3600000+100*60000)}"><title>Новый фильм (2021)</title></programme></tv>`);
fetches.length=0;const scanHops=[];
response=await call('/api/enrichment/discovery/scan',{},{execution:invocation({loopback:async(input,init)=>{scanHops.push({url:input,body:JSON.parse(init.body)});return new Response('{}');}})});
assert.equal(response.status,200);assert.equal((await response.json()).scanned,1);await drain();
assert.deepEqual(scanHops,[{url:'https://iptv.internal/discovery/continue',body:{chunks:11}}]);assert.deepEqual(fetches,['https://epg.test/guide.xml']);
const epgUrl=env.EPG_XML_URL;delete env.EPG_XML_URL;
response=await call('/api/enrichment/discovery/scan',{});assert.equal(response.status,502);assert.match((await response.json()).error,/EPG_XML_URL is not configured/);
env.EPG_XML_URL=epgUrl;

// A committed EPG sync starts the chain with the full hop budget.
seed(5);records.set('sync.json',{runId:'sync-1',stage:'epg',updatedAt:new Date().toISOString()});
vm.runInContext("epgSync=async()=>({runId:'sync-1',stage:'complete'})",context);
const syncHops=[];
response=await call('/api/sync/epg',{runId:'sync-1'},{execution:invocation({loopback:async(input,init)=>{syncHops.push({url:input,body:JSON.parse(init.body),headers:Object.keys(init.headers)});return new Response('{}');}})});
assert.equal(response.status,200);await drain();
assert.deepEqual(syncHops,[{url:'https://iptv.internal/discovery/continue',body:{chunks:11},headers:['Content-Type']}]);assert.deepEqual(fetches,[]);

// Runtime contract: the bundle exports the entrypoint, ctx.exports is on by date, and no Sites credential remains in the Worker.
const build=fs.readFileSync('build.mjs','utf8');
assert(build.indexOf('src/continuation.js')>0&&build.indexOf('src/continuation.js')<build.indexOf('src/worker.js'));
assert.match(fs.readFileSync('src/continuation.js','utf8'),/^export const DiscoveryContinuation=\{async fetch\(/m);
const wrangler=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
assert(wrangler.compatibility_date>='2025-11-17','ctx.exports is enabled by default from 2025-11-17');
assert(!(wrangler.compatibility_flags||[]).includes('disable_ctx_exports'));
for(const file of fs.readdirSync('src'))assert.doesNotMatch(fs.readFileSync('src/'+file,'utf8'),/OAI-Sites-Authorization|EPG_SITE_SERVICE_TOKEN|example\.invalid/,file);

console.log('Internal continuation: loopback hops, hop budget, busy lease, missing binding, hop failures, entrypoint validation, public isolation, Origin checks, scan source and sync trigger passed');
