// AIR-273, temporary (cleanup AIR-274): TEST_ORDERED_RATINGS=on turns the sync entry into a diagnostic. A start (HTTP
// or MCP) makes exactly one GET of the owner's diary page 1 and returns a safe summary; steps answer 409. Nothing
// reads or writes storage and no run is created. Any other value keeps the normal sync start.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const TEAM='https://probe-team.cloudflareaccess.com',AUD='c3'.repeat(32),SITE='https://iptv.example',USER='owner-name';
const signing=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const publicJwk={...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'};
const RATED=`https://letterboxd.com/${USER}/films/by/diary/`;
const item=(id,stars)=>`<tr class="diary-entry-row"><td data-postered-identifier="{&quot;lid&quot;:&quot;${id}&quot;}"></td>${stars?`<span class="rating rated-${stars}"></span>`:''}</tr>`;
const PAGE=`<html><title>Films diary</title></html>`+item('ESyU',7)+item('abc',null)+item('xyz',10)+`<a class="next" href="/${USER}/diary/page/2/">Older</a>`;films"></span><li class=" smenu-subselected"><a class="item" href="/${USER}/films/by/diary/">Newest First</a></li>`+item('ESyU',7)+item('abc',null)+item('xyz',10)+`<a class="next" href="/${USER}/films/by/diary/page/2/">Older</a>`;
let reply=()=>new Response(PAGE,{status:200,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','server':'cloudflare'}});
const calls=[],logs=[];
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,atob,encodeURIComponent,decodeURIComponent,crypto:webcrypto,setTimeout,ASSETS:{},
 console:{...console,log:line=>logs.push(String(line))},
 fetch:async(url,init={})=>{
  const href=String(url);
  if(href===TEAM+'/cdn-cgi/access/certs')return Response.json({keys:[publicJwk]});
  calls.push({href,headers:{...init.headers},redirect:init.redirect});
  if(href===RATED)return reply();
  return new Response('unexpected',{status:599});
 }});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/enrichment.js','src/migration-export.js','src/prediction-diagnostics.js','src/feature-flags.js','src/mcp.js','src/continuation.js','src/worker.js']){
 vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
}
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const now=Math.floor(Date.now()/1000);
const input=encode({alg:'RS256',kid:'kid-1',typ:'JWT'})+'.'+encode({aud:[AUD],exp:now+300,iat:now,iss:TEAM,sub:'owner-identity',type:'app'});
const jwt=input+'.'+Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',signing.privateKey,new TextEncoder().encode(input))).toString('base64url');
// A bucket that records every operation; a stored sync run that must stay untouched.
const ops=[],objects=new Map([['sync.json',JSON.stringify({runId:'run-before',stage:'complete',updatedAt:'2026-10-29T17:08:31.690Z'})]]);
const bucket={
 async get(key){ops.push('get '+key);const text=objects.get(key);return text==null?null:{etag:'e',json:async()=>JSON.parse(text),text:async()=>text};},
 async put(key,value){ops.push('put '+key);objects.set(key,String(value));return {etag:'e'};},
 async delete(key){ops.push('delete '+key);objects.delete(key);},
 async list(options){ops.push('list '+(options?.prefix||''));return {objects:[],truncated:false};}
};
const env=flag=>({BUCKET:bucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD,LETTERBOXD_USERNAME:USER,EPG_XML_URL:'https://epg.test/guide.xml',...(flag===undefined?{}:{TEST_ORDERED_RATINGS:flag})});
const post=async(e,path,body={})=>{const response=await context.worker.fetch(new Request(SITE+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),e,{waitUntil(){}});return {status:response.status,data:await response.json()};};
const mcp=async(e,name,args={})=>(await (await context.worker.fetch(new Request(SITE+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','MCP-Protocol-Version':'2025-11-25','Cf-Access-Jwt-Assertion':jwt},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),e,{waitUntil(){}})).json()).result;
const before=objects.get('sync.json');

// 1. On, HTTP start: exactly one GET with the production headers, a safe summary, no storage at all, no run.
let start=await post(env('on'),'/api/sync/start');
assert.equal(start.status,200);
assert.deepEqual(calls.map(call=>call.href),[RATED]);
assert.deepEqual(calls[0].headers,{'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html','Accept-Language':'en-US,en;q=0.9'});
assert.equal(calls[0].redirect,'manual');
assert.deepEqual(ops,[],'no storage read or write');
assert.equal(objects.get('sync.json'),before);
const report=start.data;
assert.equal(report.mode,'test_ordered_ratings');
assert.equal(report.runId,undefined,'no run is created');
assert.deepEqual([report.status,report.challenge,report.validPage,report.next,report.items,report.rated,report.unrated,report.missingId,report.requests],[200,false,true,true,3,2,1,0,1]);
assert.deepEqual(report.order.map(item=>item.rating),[3.5,null,5]);
assert.match(report.order[0].idHash,/^[0-9a-f]{8}$/);
assert.equal(report.headers.cacheControl,'no-store');
assert.ok(Number.isFinite(report.durationMs));
const shown=JSON.stringify(report)+logs.join('');
assert.doesNotMatch(shown,new RegExp(USER),'no username');
assert.doesNotMatch(shown,/ESyU|griditem|<li/,'no raw ids or body');
assert.equal(logs.filter(line=>line.includes('"event":"test_ordered_ratings"')).length,1);

// 2. On, MCP start: the same single request and summary through the existing tool.
calls.length=0;ops.length=0;
const viaMcp=await mcp(env('on'),'epg_sync_start');
assert.deepEqual(calls.map(call=>call.href),[RATED]);
assert.deepEqual(ops,[]);
assert.equal(viaMcp.structuredContent?.mode??JSON.parse(viaMcp.content[0].text).mode,'test_ordered_ratings');

// 3. On, steps (HTTP and MCP): 409, no request, no storage write, no step diagnostics.
calls.length=0;ops.length=0;
for(const path of ['/api/sync/metadata','/api/sync/epg']){const step=await post(env('on'),path,{runId:'run-before'});assert.equal(step.status,409);assert.equal(step.data.mode,'test_ordered_ratings');}
await mcp(env('on'),'epg_sync_step',{runId:'run-before'});
assert.equal(calls.length,0);
assert.deepEqual(ops.filter(op=>!op.startsWith('get ')),[],'steps write nothing');
assert.equal(objects.get('sync.json'),before);

// 4. A 403 challenge is reported, not retried.
calls.length=0;ops.length=0;
reply=()=>new Response('<html><head><title>Just a moment...</title></head></html>',{status:403,headers:{'content-type':'text/html','cf-mitigated':'challenge'}});
start=await post(env('on'),'/api/sync/start');
assert.equal(calls.length,1);
assert.deepEqual([start.data.status,start.data.headers.cfMitigated,start.data.challenge,start.data.validPage,start.data.items],[403,'challenge',true,false,0]);
assert.deepEqual(ops,[]);
// A network error is reported, not retried.
calls.length=0;reply=()=>{throw new Error('connection reset');};
start=await post(env('on'),'/api/sync/start');
assert.deepEqual([calls.length,start.data.error],[1,'connection reset']);

// 5. Off, absent or any other value: the normal sync start, which never asks for the diary page.
for(const flag of [undefined,'off','On',' on','true']){
 calls.length=0;ops.length=0;
 await post(env(flag),'/api/sync/start').catch(()=>{});
 assert.equal(calls.some(call=>call.href===RATED),false,String(flag));
 assert.ok(calls.some(call=>call.href===`https://letterboxd.com/${USER}/watchlist/`),'the normal start reads the watchlist: '+flag);
}
console.log('TEST_ORDERED_RATINGS (AIR-273, temporary): start makes one diary GET with the production headers and returns a safe summary, steps answer 409, no storage, no run, 403/error not retried, off keeps the normal start passed');
