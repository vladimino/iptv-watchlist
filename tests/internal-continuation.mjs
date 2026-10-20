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

// One resolve call processes one chunk. It does not dispatch another hop, and nothing the caller carried is stored.
seed(30);
let response=await call('/api/enrichment/discovery/resolve',{limit:1,chunks:3});
assert.equal(response.status,200);
const first=await response.json();
assert.equal(first.remaining,29);assert.equal(first.discovery.state,'paused');assert.equal(first.discovery.remainingChunks,11);assert.equal(first.discovery.nextAction,'continue');
await drain();assert.deepEqual(hops,[]);
assert.equal(Object.values(records.get('epg/discovery-resolution.json')).filter(d=>d.status==='verified').length,1);
assert.deepEqual(fetches,[],'no TMDB, own-origin or legacy Site request');
assert.doesNotMatch(JSON.stringify([...records]),/legacy-site|browser-session|header\.payload/,'no credential is persisted');
seed(5);let guard=0,last;while((last?.discovery?.state!=='complete')&&guard++<8)last=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();
assert.equal(last.discovery.state,'complete');assert.equal(last.discovery.nextAction,'stop');assert.equal(last.remaining,0);
assert.equal(Object.values(records.get('epg/discovery-resolution.json')).filter(d=>d.status==='verified').length,5);
assert.equal(hops.length,0);assert.equal(records.get('epg/discovery-status.json').error,null);

// Twelve chunks stop the series. A call before nextCatchUpAt does not start another.
seed(20);
for(let i=0;i<12;i++){const step=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();assert.equal(step.discovery.nextAction,i<11?'continue':'wait',String(i));}
assert.equal(continuation().stage,'paused');assert.equal(continuation().reason,'chunk_budget');assert.equal(continuation().remainingChunks,0);assert(continuation().nextCatchUpAt);
const decided=Object.keys(records.get('epg/discovery-resolution.json')).length;
const held=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();
assert.equal(held.discovery.nextAction,'wait');assert.equal(held.discovery.reason,'chunk_budget');assert.equal(held.checked,0);
assert.equal(Object.keys(records.get('epg/discovery-resolution.json')).length,decided);
continuation().nextCatchUpAt=new Date(Date.now()-1000).toISOString();
const resumed=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();
assert.equal(resumed.discovery.nextAction,'continue');assert.equal(Object.keys(records.get('epg/discovery-resolution.json')).length,decided+1);

// A live lease reports busy and does not overwrite continuation or write decisions. An expired lease can start.
seed(5);records.set('epg/resolver-continuation.json',{stage:'paused',reason:'epg_committed',at:new Date().toISOString(),hopId:null,remainingChunks:12});
records.set('epg/resolver-lease.json',{id:'other',expiresAt:Date.now()+60000});
const busy=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();await drain();
assert.equal(busy.stage,'busy');assert.equal(busy.discovery.state,'busy');assert.equal(busy.discovery.nextAction,'wait');assert.equal(busy.discovery.reason,'busy');
assert.equal(hops.length,0);assert.equal(continuation().reason,'epg_committed');assert.equal(continuation().remainingChunks,12);assert.equal(records.has('epg/discovery-resolution.json'),false);
records.get('epg/resolver-lease.json').expiresAt=Date.now()-1000;
const expired=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();
assert.equal(expired.discovery.nextAction,'continue');assert.equal(records.get('epg/resolver-lease.json').expiresAt,0);

// The chunk runs in this request. A missing loopback binding is not an error and does not fetch the public hostname.
seed(5);
const local=await (await call('/api/enrichment/discovery/resolve',{limit:1},{execution:invocation({exports:false})})).json();await drain();
assert.equal(local.discovery.nextAction,'continue');assert.equal(hops.length,0);assert.deepEqual(fetches,[]);assert.notEqual(continuation().reason,'internal_dispatch_unavailable');

// A stored retry and a failed chunk wait until their catch-up time instead of starting TMDB work.
seed(5);records.set('epg/discovery-status.json',{retryAt:new Date(Date.now()+3600000).toISOString(),remaining:5,stage:'partial'});
records.set('epg/resolver-continuation.json',{stage:'paused',reason:'epg_committed',at:new Date().toISOString(),hopId:null,remainingChunks:12});
fetches.length=0;const backoff=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();
assert.equal(backoff.stage,'backoff');assert.equal(backoff.discovery.nextAction,'wait');assert.equal(backoff.discovery.reason,'backoff');
assert.equal(fetches.length,0);assert.equal(continuation().remainingChunks,12);assert.equal(records.has('epg/discovery-resolution.json'),false);
seed(5);const originalGet=bucket.get.bind(bucket);
bucket.get=async key=>{if(key==='epg/discovery-latest.json')throw new Error('catalog read failed');return originalGet(key);};
const failed=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();
assert.equal(failed.discovery.state,'error');assert.equal(failed.discovery.nextAction,'wait');assert.match(failed.discovery.reason,/catalog read failed/);
assert.equal(records.get('epg/resolver-lease.json').expiresAt,0);bucket.get=originalGet;
const waiting=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();
assert.equal(waiting.discovery.nextAction,'wait');assert.equal(waiting.checked,0);

// An old scheduled record with an expired lease is one interrupted chunk, so the next call resumes it.
seed(5);records.set('epg/resolver-continuation.json',{stage:'scheduled',at:new Date(Date.now()-3600000).toISOString(),remainingChunks:11});
records.set('epg/resolver-lease.json',{id:'dead',expiresAt:Date.now()-60000});
const recovered=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();
assert.equal(recovered.discovery.nextAction,'continue');assert.equal(continuation().stage,'paused');assert.equal(continuation().remainingChunks,11);

// Two overlapping calls: the lease holder runs one chunk and the other waits without replacing that continuation.
seed(5);let releaseGate;const gate=new Promise(resolve=>{releaseGate=resolve;});let blockCatalog=false;bucket.get=async key=>{if(key==='epg/discovery-latest.json'&&!blockCatalog){blockCatalog=true;await gate;}return originalGet(key);};
const firstPromise=call('/api/enrichment/discovery/resolve',{limit:1});
for(let i=0;i<50&&continuation()?.stage!=='running';i++)await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(continuation().stage,'running');
const second=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();
assert.equal(second.discovery.state,'busy');assert.equal(second.discovery.nextAction,'wait');assert.equal(continuation().stage,'running');
releaseGate();const overlapped=await (await firstPromise).json();bucket.get=originalGet;
assert.equal(overlapped.discovery.nextAction,'continue');assert.equal(continuation().stage,'paused');

// A programme published while the chunk runs is not treated as this chunk's continuation.
seed(5);let programmeReads=0;bucket.get=async key=>{const object=await originalGet(key);if(key!=='programme.json'||!object)return object;if(++programmeReads<2)return object;const body=await object.json();return {etag:object.etag,json:async()=>({...body,runId:'run-2'})};};
const changed=await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();bucket.get=originalGet;
assert.equal(changed.stage,'programme_changed');assert.equal(changed.discovery.nextAction,'stop');assert.equal(changed.discovery.reason,'programme_changed');
assert.equal(continuation().reason,'programme_changed');assert.equal(records.get('epg/discovery-status.json').programmeRunId,'run-1');
assert.equal(records.has(vm.runInContext('predictionQueueKey',context)),false);

// wait without a stored timestamp must call nextCatchUpAt(), not the shadowed null.
for(const source of ["{stage:'error',reason:'discovery_failed',remainingChunks:4}","{stage:'paused',reason:'chunk_budget',remainingChunks:0}"]){
 const waiting=vm.runInContext('discoveryContract('+source+')',context);
 assert.equal(waiting.nextAction,'wait');assert.match(waiting.nextCatchUpAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,source);
}
const busyWithoutTime=vm.runInContext("discoveryContract({stage:'paused',remainingChunks:2},{state:'busy',nextAction:'wait',reason:'busy'})",context);
assert.equal(busyWithoutTime.nextAction,'wait');assert.match(busyWithoutTime.nextCatchUpAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

// A cheap pass with nothing to screen or touch still replaces the previous status before TMDB work.
seed(1);records.set('epg/discovery-status.json',{schemaVersion:2,stage:'partial',programmeRunId:'old-programme',checked:5,at:'2026-10-11T20:29:24.482Z'});
const originalPut=bucket.put.bind(bucket);let statusPuts=0;
bucket.put=async(key,value,options)=>{if(key==='epg/discovery-status.json'&&++statusPuts===2)throw new Error('killed before final status');return originalPut(key,value,options);};
try{await (await call('/api/enrichment/discovery/resolve',{limit:1})).json();}finally{bucket.put=originalPut;}
const cheapPass=records.get('epg/discovery-status.json');
assert.equal(cheapPass.checkpoint,'cheap_pass');assert.equal(cheapPass.programmeRunId,'run-1');
assert.equal(cheapPass.touched,0);assert.equal(cheapPass.screenedOut,0);assert.equal(cheapPass.reused,0);assert.equal(cheapPass.checked,0);
assert.notEqual(cheapPass.at,'2026-10-11T20:29:24.482Z');assert.notEqual(cheapPass.programmeRunId,'old-programme');

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
assert.equal(response.status,200);const scanBody=await response.json();assert.equal(scanBody.scanned,1);await drain();
assert.equal(scanBody.discovery.state,'paused');assert.equal(scanBody.discovery.reason,'scan_committed');assert.equal(scanBody.discovery.remainingChunks,12);assert.equal(scanBody.discovery.nextAction,'continue');
assert.deepEqual(scanHops,[]);assert.equal(continuation().reason,'scan_committed');assert.deepEqual(fetches,['https://epg.test/guide.xml']);
const epgUrl=env.EPG_XML_URL;delete env.EPG_XML_URL;
response=await call('/api/enrichment/discovery/scan',{});assert.equal(response.status,502);assert.match((await response.json()).error,/EPG_XML_URL is not configured/);
env.EPG_XML_URL=epgUrl;

// A committed EPG sync queues discovery. The next step runs one chunk and does not retry ratings.
seed(5);records.set('sync.json',{runId:'sync-1',stage:'epg',updatedAt:new Date().toISOString()});
vm.runInContext("epgSync=async()=>({runId:'sync-1',stage:'complete'})",context);
const syncHops=[];
response=await call('/api/sync/epg',{runId:'sync-1'},{execution:invocation({loopback:async(input,init)=>{syncHops.push({url:input,body:JSON.parse(init.body),headers:Object.keys(init.headers)});return new Response('{}');}})});
assert.equal(response.status,200);const syncBody=await response.json();await drain();
assert.equal(syncBody.stage,'complete');assert.equal(syncBody.discovery.state,'paused');assert.equal(syncBody.discovery.reason,'epg_committed');assert.equal(syncBody.discovery.remainingChunks,12);assert.equal(syncBody.discovery.nextAction,'continue');
assert.deepEqual(syncHops,[]);assert.equal(continuation().reason,'epg_committed');assert.deepEqual(fetches,[]);
records.get('sync.json').stage='complete';records.get('sync.json').ratingPending=['public-films-list'];
const discoveryStep=await (await call('/api/sync/epg',{runId:'sync-1'})).json();
assert.equal(discoveryStep.stage,'complete');assert.equal(discoveryStep.ratingsPending,true);assert.equal(discoveryStep.discovery.state,'complete');assert.equal(discoveryStep.discovery.nextAction,'stop');
assert.deepEqual(fetches,[],'a discovery step does not retry Letterboxd');

// Runtime contract: the bundle exports the entrypoint, ctx.exports is on by date, and no Sites credential remains in the Worker.
const build=fs.readFileSync('build.mjs','utf8');
assert(build.indexOf('src/continuation.js')>0&&build.indexOf('src/continuation.js')<build.indexOf('src/worker.js'));
assert.match(fs.readFileSync('src/continuation.js','utf8'),/^export const DiscoveryContinuation=\{async fetch\(/m);
const wrangler=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
assert.equal(wrangler.limits.cpu_ms,120000);assert(wrangler.compatibility_date>='2025-11-17','ctx.exports is enabled by default from 2025-11-17');
assert(!(wrangler.compatibility_flags||[]).includes('disable_ctx_exports'));
for(const file of fs.readdirSync('src'))assert.doesNotMatch(fs.readFileSync('src/'+file,'utf8'),/OAI-Sites-Authorization|EPG_SITE_SERVICE_TOKEN|example\.invalid/,file);

console.log('Internal continuation: one chunk per call, budget, leases, backoff, stale scheduled, overlap, programme change, entrypoint validation, public isolation, Origin checks, scan source and sync trigger passed');
