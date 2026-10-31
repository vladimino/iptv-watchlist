import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,diaryPages,migrated,RUN,SEPARATE,plain,g} from './ratings-harness.mjs';

// ADR 0060 decision 7: the four owner-only endpoints, over HTTP (behind the Worker's Cloudflare Access) and MCP (which
// also verifies the signed Access JWT).
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
const STATUS='/api/letterboxd/ratings/status',START='/api/letterboxd/ratings/start',STEP='/api/letterboxd/ratings/step',MIGRATE='/api/letterboxd/ratings/migrate';

// 1. HTTP under the default inline switch: the status reads; start and step answer disabled and write nothing.
{
 const {bucket,http,net}=setup();
 const status=await http(STATUS,'GET');
 assert.equal(status.status,200);eq([status.body.switch,status.body.pipeline,status.body.migration,status.body.sideEffects],['inline','inline','none','none']);
 eq((await http(START,'POST',{trigger:'manual'})).body,{runId:null,created:false,nextAction:'stop',reason:'disabled'});
 assert.equal((await http(STEP,'POST',{runId:'00000000-0000-4000-8000-000000000001'})).body.reason,'disabled');
 assert.equal(bucket.writes().length,0);assert.equal(net.fetches.length,0);
}

// 2. Malformed input is a 400 before any read; a foreign Origin is refused; other methods are not routes.
{
 const {bucket,http}=setup(SEPARATE);
 const bad=[[START,'{'],[START,[]],[START,'null'],[START,{}],[START,{trigger:'cron'}],[START,{trigger:'manual',clearIsolation:'yes'}],[START,{trigger:'scheduled',clearIsolation:true}],[START,{trigger:'manual',runId:'x'}],
  [STEP,{}],[STEP,{runId:'../sync.json'}],[STEP,{runId:'a'.repeat(81)}],[STEP,{runId:1}],[STEP,{runId:'x',limit:5}],[MIGRATE,{}],[MIGRATE,{mode:'force'}],[MIGRATE,{mode:'apply',key:'x'}]];
 for(const [path,body] of bad){const reply=await http(path,'POST',body);assert.equal(reply.status,400,path+' '+JSON.stringify(body));assert.equal(typeof reply.body.error,'string');}
 assert.equal(bucket.log.length,0,'a malformed request reads and writes nothing');
 assert.equal((await http(START,'POST',{trigger:'manual'},{Origin:'https://evil.example'})).status,403);
 assert.equal((await http(START,'GET')).status,404);assert.equal((await http(STATUS,'POST',{})).status,404);
 assert.equal(bucket.writes().length,0);
}

// 3. HTTP under separate with migrated storage: a run, a mismatched run, a GET status that writes nothing even with a
// stale run in storage, and a second scheduled start immediately after a finished one.
{
 const {bucket,http,net,clock,R,env}=setup(SEPARATE);
 migrated(bucket);diaryPages(net,{pages:1});
 const started=await http(START,'POST',{trigger:'scheduled'});
 assert.equal(started.body.reason,'started');
 eq((await http(STEP,'POST',{runId:'00000000-0000-4000-8000-0000000000ff'})).body.reason,'run_mismatch');
 let reply;do{reply=await http(STEP,'POST',{runId:started.body.runId});}while(reply.body.nextAction==='continue');
 assert.equal(reply.body.reason,'finished');
 const again=await http(START,'POST',{trigger:'scheduled'});
 assert.equal(again.body.reason,'started');assert.equal(again.body.created,true);assert.notEqual(again.body.runId,started.body.runId);
 bucket.set(RUN,{...bucket.value(RUN),state:'running',lease:{step:'dead',expiresAt:new Date(Date.now()-1).toISOString()}});
 const writes=bucket.writes().length,fetches=net.fetches.length;
 for(let i=0;i<3;i++){const status=await http(STATUS,'GET');assert.equal(status.body.run.stale,'interrupted');assert.equal(status.body.pipeline,'running');}
 assert.equal(bucket.writes().length,writes,'GET status writes nothing');assert.equal(net.fetches.length,fetches,'and requests nothing');
 const dry=await http(MIGRATE,'POST',{mode:'dry_run'});
 eq([dry.status,dry.body.queue.result,dry.body.cursor.result],[200,'already','already']);
 assert.equal(bucket.writes().length,writes,'dry_run writes nothing');
}

// 4. MCP: four tools with their annotations and closed schemas; owner-only through the signed Access JWT; the same
// bodies as HTTP; argument errors are tool errors that write nothing.
{
 const {bucket,mcp,http}=setup(SEPARATE);
 const list=(await mcp('tools/list')).body.result.tools;
 const tools=Object.fromEntries(list.filter(tool=>tool.name.startsWith('ratings_')).map(tool=>[tool.name,tool]));
 eq(Object.keys(tools),['ratings_sync_status','ratings_sync_start','ratings_sync_step','ratings_storage_migrate']);
 eq(tools.ratings_sync_status.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
 eq([tools.ratings_sync_start.annotations.readOnlyHint,tools.ratings_sync_start.annotations.openWorldHint],[false,false]);
 eq([tools.ratings_sync_step.annotations.readOnlyHint,tools.ratings_sync_step.annotations.openWorldHint],[false,true]);
 eq([tools.ratings_storage_migrate.annotations.readOnlyHint,tools.ratings_storage_migrate.annotations.destructiveHint],[false,false]);
 for(const tool of Object.values(tools)){assert.equal(tool.inputSchema.additionalProperties,false);assert.doesNotMatch(JSON.stringify(tool.inputSchema.properties),/"url"|"key"|"path"|"prefix"|"bucket"|"limit"|"page"/,tool.name);}
 eq(tools.ratings_storage_migrate.inputSchema.properties.mode.enum,['dry_run','apply']);
 // Without a valid Access JWT nothing is read or written.
 for(const assertion of [null,'not-a-jwt',token.slice(0,-4)+'AAAA']){
  const reply=await mcp('ratings_sync_status',{},assertion);
  assert.ok(reply.status===401||reply.status===403,'rejected without a valid JWT');
  assert.equal((await mcp('ratings_storage_migrate',{mode:'apply'},assertion)).status>=401,true);
 }
 assert.equal(bucket.log.length,0,'a rejected MCP call touches no storage');
 const status=(await mcp('ratings_sync_status',{})).body.result.structuredContent;
 const {httpStatus,...body}=status;
 assert.equal(httpStatus,200);eq({...body,readAt:null},{...(await http(STATUS,'GET')).body,readAt:null},'the same body as GET');
 for(const [name,args] of [['ratings_sync_start',{trigger:'manual',extra:1}],['ratings_sync_start',{}],['ratings_sync_step',{runId:'x/y'}],['ratings_storage_migrate',{mode:'apply',bucket:'iptv'}],['ratings_sync_status',{x:1}]]){
  const reply=(await mcp(name,args)).body.result;assert.equal(reply.isError,true,name+' '+JSON.stringify(args));
 }
 assert.equal(bucket.writes().length,0);
 eq((await mcp('ratings_sync_start',{trigger:'manual'})).body.result.structuredContent.reason,'not_migrated');
 const dry=(await mcp('ratings_storage_migrate',{mode:'dry_run'})).body.result.structuredContent;
 eq([dry.queue.result,dry.cursor.result,dry.writes],['would_migrate','would_migrate',0]);
 assert.equal(bucket.writes().length,0,'dry_run over MCP writes nothing');
}

console.log('Ratings API (ADR 0060, ADR 0069): HTTP disabled under inline, malformed input refused before any read, foreign Origin refused, a run with run_mismatch and a second scheduled start with no minimum interval, GET status side-effect free with a stale run, dry_run writes nothing, and MCP tools with closed schemas and annotations behind the signed Access JWT with the HTTP bodies passed');
