import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {MemoryBucket} from './memory-bucket.mjs';

const TEAM='https://probe-team.cloudflareaccess.com';
const AUD='a1'.repeat(32);
const SITE='https://iptv.example';
const signing=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const publicJwk={...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'};
const fetches=[];
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,atob,crypto:webcrypto,console,setTimeout,ASSETS:{},
 fetch:async url=>{fetches.push(String(url));if(String(url)===TEAM+'/cdn-cgi/access/certs')return Response.json({keys:[publicJwk]});throw new Error('Unexpected network access');}});
for(const file of ['src/sources.js','src/ratings-seed.js','src/discovery.js','src/enrichment.js','src/migration-export.js','src/mcp.js','src/continuation.js','src/worker.js']){
 vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
}
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function accessJwt(){
 const now=Math.floor(Date.now()/1000);
 const input=encode({alg:'RS256',kid:'kid-1',typ:'JWT'})+'.'+encode({aud:[AUD],exp:now+300,iat:now,iss:TEAM,sub:'owner-identity',type:'app'});
 const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',signing.privateKey,new TextEncoder().encode(input));
 return input+'.'+Buffer.from(signature).toString('base64url');
}
const jwt=await accessJwt();
const headers={'Content-Type':'application/json',Accept:'application/json','MCP-Protocol-Version':'2025-11-25','Cf-Access-Jwt-Assertion':jwt};
function env(){return {BUCKET:new MemoryBucket(),MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD};}
const rpc=(id,method,params)=>({jsonrpc:'2.0',id,method,params});
async function tool(environment,name,args,{assertion=jwt}={}){
 const requestHeaders={...headers};
 if(assertion)requestHeaders['Cf-Access-Jwt-Assertion']=assertion;else delete requestHeaders['Cf-Access-Jwt-Assertion'];
 const response=await context.worker.fetch(new Request(SITE+'/mcp',{method:'POST',headers:requestHeaders,body:JSON.stringify(rpc(1,'tools/call',{name,arguments:args}))}),environment,{waitUntil(){}});
 const body=await response.json();
 return {response,body};
}
async function http(environment,path,method,payload){
 const response=await context.worker.fetch(new Request(SITE+path,{method,headers:{'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload)}),environment,{waitUntil(){}});
 return {status:response.status,body:await response.json()};
}
function domain(result){const {httpStatus,...body}=result.structuredContent;return {status:httpStatus,body};}

const readTools=[
 ['epg_status','/api/status','GET'],
 ['epg_pipeline_status','/api/enrichment/pipeline/status','GET'],
 ['enrichment_schema','/api/enrichment/schema','GET'],
 ['enrichment_profile','/api/enrichment/profile','GET'],
 ['enrichment_runner','/api/enrichment/runner','GET'],
 ['enrichment_queue','/api/enrichment/queue/status','GET'],
 ['enrichment_status','/api/enrichment/status','GET'],
];
for(const [name,path,method] of readTools){
 const environment=env();
 const viaHttp=await http(environment,path,method);
 const viaMcp=await tool(env(),name,{});
 assert.equal(viaMcp.response.status,200,name);
 assert.equal(viaMcp.body.error,undefined,name);
 assert.deepEqual(domain(viaMcp.body.result),viaHttp,name);
}
assert.equal((await tool(env(),'enrichment_profile',{})).body.result.structuredContent.httpStatus,404);
assert.equal((await tool(env(),'enrichment_profile',{})).body.result.isError,true);

const forbidden=[
 ['epg_status',{key:'programme.json'}],
 ['epg_sync_start',{url:'https://evil.example/guide.xml'}],
 ['epg_sync_step',{runId:'run-1',chunks:12}],
 ['prediction_start',{trigger:'scheduled',scope:'watchlist_all',mode:'queued'}],
 ['prediction_start',{trigger:'scheduled',batchSize:20}],
 ['prediction_next',{runId:'run-1',batchSize:20}],
 ['prediction_submit',{runId:'run-1',items:[{filmId:'film-1',fingerprint:{},key:'enrichment/x'}]}],
 ['prediction_submit',{runId:'run-1',items:[{filmId:'../secret'},{filmId:'film-2'}]}],
 ['prediction_complete',{runId:'run-1',path:'/api/enrichment/complete'}],
];
for(const [name,args] of forbidden){
 fetches.length=0;
 const environment=env();
 const outcome=await tool(environment,name,args);
 assert.equal(outcome.body.result.isError,true,name);
 assert.equal(environment.BUCKET.objects.size,0,name);
 assert.deepEqual(fetches.filter(url=>url!==TEAM+'/cdn-cgi/access/certs'),[],name);
}

const mismatch=await tool(env(),'epg_sync_step',{runId:'missing-run'});
assert.deepEqual(domain(mismatch.body.result),{status:409,body:{error:'Run id mismatch'}});
assert.equal(mismatch.body.result.isError,undefined);
const unknown=await tool(env(),'prediction_next',{runId:'missing-run'});
assert.equal(unknown.body.result.structuredContent.httpStatus,404);
assert.equal(unknown.body.result.isError,true);
const started=await tool(env(),'prediction_start',{trigger:'scheduled',capacity:{remainingPercent:40}});
assert.equal(started.body.result.structuredContent.httpStatus,409);
assert.match(JSON.stringify(started.body.result.structuredContent),/Taste profile is not configured/);
assert.equal((await tool(env(),'prediction_start',{trigger:'hourly'})).body.result.isError,true);

const anonymous=await tool(env(),'prediction_start',{trigger:'scheduled'},{assertion:null});
assert.equal(anonymous.response.status,403);
assert.equal(anonymous.body.error.code,-32001);

const listed=await context.worker.fetch(new Request(SITE+'/mcp',{method:'POST',headers,body:JSON.stringify(rpc(2,'tools/list',{}))}),env());
const tools=(await listed.json()).result.tools;
for(const tool of tools){
 assert.equal(tool.inputSchema.additionalProperties,false,tool.name);
 const properties=JSON.stringify(tool.inputSchema.properties||{});
 assert.doesNotMatch(properties,/"url"|"key"|"path"|"prefix"|"bucket"/,tool.name);
}
assert.equal(tools.find(item=>item.name==='enrichment_status').annotations.readOnlyHint,false);
for(const name of ['epg_sync_start','epg_sync_step','prediction_start','prediction_next','prediction_submit','prediction_heartbeat','prediction_complete']){
 assert.equal(tools.find(item=>item.name===name).annotations.readOnlyHint,false,name);
}
assert.equal(tools.find(item=>item.name==='epg_sync_step').annotations.openWorldHint,true);
console.log('MCP tools: read tools match the HTTP contracts, rejected arguments do not write or fetch, and write tools stay behind the Access JWT passed');
