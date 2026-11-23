import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,diaryPages,migrated,RUN,SEPARATE,plain,g} from './ratings-harness.mjs';

// ADR 0060 decision 7, after the retirement of the writer entry points: the only Ratings endpoints left are the read-only
// status over HTTP (behind the Worker's Cloudflare Access) and MCP (which also verifies the signed Access JWT). The old
// POST start and step routes and the MCP tools ratings_sync_start and ratings_sync_step answer a plain 404 and an unknown tool.
const T0=Date.parse('2026-10-31T08:00:00.000Z');
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);
const TEAM='https://probe-team.cloudflareaccess.com',AUD='a1'.repeat(32),SITE='https://iptv.example';
const signing=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const publicJwk={...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function jwt(){
 const now=Math.floor(Date.now()/1000),input=encode({alg:'RS256',kid:'kid-1',typ:'JWT'})+'.'+encode({aud:[AUD],exp:now+300,iat:now,iss:TEAM,sub:'owner-identity',type:'app'});
 return input+'.'+Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',signing.privateKey,new TextEncoder().encode(input))).toString('base64url');
}
const token=await jwt();
function setup(extra={}){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const letterboxd=net.fetch;net.fetch=async url=>String(url)===TEAM+'/cdn-cgi/access/certs'?Response.json({keys:[publicJwk]}):letterboxd(url);
 // The Access JWT carries real seconds; only the storage clock is fixed.
 const ctx=loadContext({net,clock,FakeDate:undefined,crypto});
 const env=baseEnv(bucket,{MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD,...extra});
 const http=async(path,method,body,headers={})=>{const response=await ctx.worker.fetch(new Request(SITE+path,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)}),env,{waitUntil(){}});return {status:response.status,body:await response.json()};};
 const mcp=async(name,args,assertion=token)=>{
  const headers={'Content-Type':'application/json',Accept:'application/json','MCP-Protocol-Version':'2025-11-25',...(assertion?{'Cf-Access-Jwt-Assertion':assertion}:{})};
  const response=await ctx.worker.fetch(new Request(SITE+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:name==='tools/list'?'tools/list':'tools/call',params:name==='tools/list'?{}:{name,arguments:args}})}),env,{waitUntil(){}});
  return {status:response.status,body:await response.json()};
 };
 return {clock,net,bucket,ctx,env,http,mcp,R:g(ctx,'LetterboxdRatings')};
}


const STATUS='/api/letterboxd/ratings/status',START='/api/letterboxd/ratings/start',STEP='/api/letterboxd/ratings/step',RETIRED='/api/letterboxd/ratings/migrate';

// 1. HTTP with the binding absent, inline, invalid or separate, and unsupported storage: the status reads switch
// separate and pipeline blocked, and writes nothing.
for(const extra of [{},{RATINGS_PIPELINE:'inline'},{RATINGS_PIPELINE:'Separate'},{RATINGS_PIPELINE:'separate'}]){
 const {bucket,http,net}=setup(extra);
 const status=await http(STATUS,'GET');
 assert.equal(status.status,200);eq([status.body.switch,status.body.pipeline,status.body.storage,status.body.sideEffects],['separate','blocked',{supported:false,authority:'open',queueV2:false,cursorV2:false},'none'],JSON.stringify(extra));
 assert.equal(bucket.writes().length,0);assert.equal(net.fetches.length,0);
}

// 2. The retired writer routes are not routes: a plain 404 for every body and method, before any read, write or Letterboxd
// request, on supported and unsupported storage alike. A foreign Origin and the retired conversion route stay refused.
for(const supported of [false,true]){
 const {bucket,http,net}=setup(SEPARATE);
 if(supported){migrated(bucket);diaryPages(net,{pages:1});}
 const before=bucket.log.length;
 for(const path of [START,STEP]){
  for(const body of [undefined,{},{trigger:'manual'},{trigger:'scheduled'},{runId:'00000000-0000-4000-8000-000000000001'},[]]){
   assert.equal((await http(path,'POST',body)).status,404,path+' '+JSON.stringify(body)+' supported='+supported);
  }
  for(const method of ['GET','PUT','DELETE'])assert.equal((await http(path,method)).status,404,path+' '+method);
 }
 assert.equal(bucket.log.length,before,'a retired route reads and writes nothing');assert.equal(bucket.writes().length,0);assert.equal(net.fetches.length,0,'and requests nothing');
}
{
 const {bucket,http}=setup(SEPARATE);
 assert.equal((await http(START,'POST',{trigger:'manual'},{Origin:'https://evil.example'})).status,403);
 assert.equal((await http(STATUS,'POST',{})).status,404);
 // The retired conversion route is gone (ADR 0161): the dispatcher answers its common 404 and reads or writes nothing.
 for(const body of [{mode:'apply'},{mode:'dry_run'},{}])assert.equal((await http(RETIRED,'POST',body)).status,404,RETIRED+JSON.stringify(body));
 assert.equal(bucket.writes().length,0);
}

// 3. The run engine itself is unchanged: a GET status that writes nothing even with a stale run in storage, and a
// second scheduled start immediately after a finished one (driven through the module, since no route reaches it).
{
 const {bucket,http,net,R,env}=setup(SEPARATE);
 migrated(bucket);diaryPages(net,{pages:1});
 const started=plain(await R.start(env,{trigger:'scheduled'}));
 assert.equal(started.reason,'started');
 eq(plain(await R.step(env,{runId:'00000000-0000-4000-8000-0000000000ff'})).reason,'run_mismatch');
 let reply;do{reply=plain(await R.step(env,{runId:started.runId}));}while(reply.nextAction==='continue');
 assert.equal(reply.reason,'finished');
 const again=plain(await R.start(env,{trigger:'scheduled'}));
 assert.equal(again.reason,'started');assert.equal(again.created,true);assert.notEqual(again.runId,started.runId);
 bucket.set(RUN,{...bucket.value(RUN),state:'running',lease:{step:'dead',expiresAt:new Date(Date.now()-1).toISOString()}});
 const writes=bucket.writes().length,fetches=net.fetches.length;
 for(let i=0;i<3;i++){const status=await http(STATUS,'GET');assert.equal(status.body.run.stale,'interrupted');assert.equal(status.body.pipeline,'running');}
 assert.equal(bucket.writes().length,writes,'GET status writes nothing');assert.equal(net.fetches.length,fetches,'and requests nothing');
}

// 4. MCP: only the read-only status tool is left, with its annotation and closed schema; owner-only through the signed
// Access JWT; the same body as HTTP. The retired writer tools are not listed and calling them by name is an unknown tool.
{
 const {bucket,net,mcp,http}=setup(SEPARATE);
 const list=(await mcp('tools/list')).body.result.tools;
 const tools=Object.fromEntries(list.filter(tool=>tool.name.startsWith('ratings_')).map(tool=>[tool.name,tool]));
 eq(Object.keys(tools),['ratings_sync_status']);
 eq(tools.ratings_sync_status.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
 for(const tool of Object.values(tools)){assert.equal(tool.inputSchema.additionalProperties,false);assert.doesNotMatch(JSON.stringify(tool.inputSchema.properties),/"url"|"key"|"path"|"prefix"|"bucket"|"limit"|"page"/,tool.name);}
 assert.doesNotMatch(JSON.stringify(list),/ratings_sync_start|ratings_sync_step/,'no listed tool or description advertises the retired writers');
 // Without a valid Access JWT nothing is read or written.
 for(const assertion of [null,'not-a-jwt',token.slice(0,-4)+'AAAA']){
  const reply=await mcp('ratings_sync_status',{},assertion);
  assert.ok(reply.status===401||reply.status===403,'rejected without a valid JWT');
 }
 assert.equal(bucket.log.length,0,'a rejected MCP call touches no storage');
 const status=(await mcp('ratings_sync_status',{})).body.result.structuredContent;
 const {httpStatus,...body}=status;
 assert.equal(httpStatus,200);eq({...body,readAt:null},{...(await http(STATUS,'GET')).body,readAt:null},'the same body as GET');
 assert.equal((await mcp('ratings_sync_status',{x:1})).body.result.isError,true,'an argument on the status tool is a tool error');
 // The retired tools are not tools any more: an unknown tool, with no write, no Letterboxd request and no run.
 for(const [name,args] of [['ratings_sync_start',{trigger:'manual'}],['ratings_sync_start',{}],['ratings_sync_step',{runId:'00000000-0000-4000-8000-000000000001'}],['ratings_sync_step',{}],['ratings_storage_migrate',{mode:'apply'}]]){
  const reply=(await mcp(name,args)).body;
  assert.equal(Boolean(reply.error)||reply.result?.isError===true,true,name+' is refused as an unknown tool');
  assert.notEqual(reply.result?.structuredContent?.reason,'started',name+' starts nothing');
 }
 assert.equal(bucket.writes().length,0,'the retired tools write nothing');assert.equal(net.fetches.length,0,'and request nothing');
}

console.log('Ratings API (ADR 0060, ADR 0069, ADR 0074): the read-only status over HTTP and MCP behind Access, the retired POST start and step routes answering 404 without a read or write on any storage, the retired MCP tools unknown and writing nothing, the run engine and a side-effect-free status with a stale run unchanged');
