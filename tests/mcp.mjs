import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const TEAM='https://probe-team.cloudflareaccess.com';
const OFFLINE_TEAM='https://offline-team.cloudflareaccess.com';
const EMPTY_TEAM='https://empty-team.cloudflareaccess.com';
const AUD='a1'.repeat(32);
const ALL_WORKERS_AUD='b2'.repeat(32);
const SITE='https://iptv.example';
const RSA={name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'};
const signing=await webcrypto.subtle.generateKey(RSA,true,['sign','verify']);
const rogue=await webcrypto.subtle.generateKey(RSA,true,['sign','verify']);
const publicJwk={...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'};

const certRequests=new Map(),unexpectedRequests=[];
const fetch=async url=>{
 const href=String(url);certRequests.set(href,(certRequests.get(href)||0)+1);
 if(href===TEAM+'/cdn-cgi/access/certs')return Response.json({keys:[{kty:'oct',kid:'ignored',k:'c2VjcmV0'},publicJwk],public_cert:{kid:'kid-1',cert:'unused'}});
 if(href===OFFLINE_TEAM+'/cdn-cgi/access/certs')return new Response('unavailable',{status:500});
 if(href===EMPTY_TEAM+'/cdn-cgi/access/certs')return Response.json({keys:[]});
 unexpectedRequests.push(href);throw new Error('Unexpected network access');
};
const bucketAccess=[];
const BUCKET=new Proxy({},{get(_,property){bucketAccess.push(String(property));throw new Error('MCP must not touch R2');}});
const env={BUCKET,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD};

const context=vm.createContext({Response,Request,Headers,URL,Date,Map,Set,JSON,TextEncoder,TextDecoder,AbortSignal,atob,crypto:webcrypto,fetch,console,ASSETS:{}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/mcp.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);

const encode=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
async function accessJwt({header={},claims={},key=signing.privateKey}={}){
 const now=Math.floor(Date.now()/1000);
 const input=encode({alg:'RS256',kid:'kid-1',typ:'JWT',...header})+'.'+encode({aud:[AUD],email:'owner@example.test',exp:now+300,iat:now,nbf:now,iss:TEAM,sub:'owner-identity',type:'app',...claims});
 const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(input));
 return input+'.'+Buffer.from(signature).toString('base64url');
}
const validJwt=await accessJwt();
const POST_HEADERS={'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'};
function mcp(body,{jwt=validJwt,method='POST',headers={},environment=env,path='/mcp'}={}){
 const merged={...(method==='POST'?POST_HEADERS:{}),...(jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}),...headers};
 for(const [name,value] of Object.entries(merged))if(value===undefined)delete merged[name];
 const init={method,headers:merged};
 if(body!==undefined)init.body=typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body);
 return context.worker.fetch(new Request(SITE+path,init),environment);
}
const rpc=(id,method,params)=>({jsonrpc:'2.0',id,method,...(params===undefined?{}:{params})});
const result=async (...args)=>{const response=await mcp(...args);assert.equal(response.status,200);const body=await response.json();assert.equal(body.error,undefined);return body.result;};
async function expectError(response,status,code){
 assert.equal(response.status,status);
 const body=await response.json();
 assert.equal(body.jsonrpc,'2.0');assert.equal(body.error.code,code);assert.equal(body.result,undefined);
 return body;
}

// Handshake and version negotiation.
let response=await mcp(rpc(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test-client',version:'1.0.0'}}),{headers:{'MCP-Protocol-Version':undefined}});
assert.equal(response.status,200);
assert.match(response.headers.get('Content-Type'),/^application\/json/);
assert.equal(response.headers.get('Cache-Control'),'no-store');
assert.equal(response.headers.get('Mcp-Session-Id'),null);
let body=await response.json();
assert.equal(body.id,1);
assert.equal(body.result.protocolVersion,'2025-11-25');
assert.deepEqual(body.result.capabilities,{tools:{listChanged:true}});
assert.equal(body.result.serverInfo.name,'iptv-watchlist-probe');
assert.match(body.result.instructions,/probe_read and probe_echo/);
assert.match(body.result.instructions,/legacy one-film runner v5 \(prediction_start, prediction_next, prediction_submit, prediction_validate\) is retired \(ADR 0167\)/,'the instructions name the retired tools only as retired');
assert.doesNotMatch(body.result.instructions,/prediction_next returns|then prediction_submit|prediction_start uses/,'no v5 call instruction remains');
assert.equal((await result(rpc(2,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'c',version:'1'}}))).protocolVersion,'2025-06-18');
assert.equal((await result(rpc(3,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'c',version:'1'}}))).protocolVersion,'2025-11-25');
assert.equal((await result(rpc(4,'initialize',{protocolVersion:'2025-11-25'}),{headers:{'MCP-Protocol-Version':'2026-07-28'}})).protocolVersion,'2025-11-25');
await expectError(await mcp(rpc(5,'initialize',{capabilities:{}})),200,-32602);
response=await mcp({jsonrpc:'2.0',method:'notifications/initialized'});
assert.equal(response.status,202);assert.equal(await response.text(),'');
assert.deepEqual(await result(rpc(6,'ping')),{});

// Tool discovery keeps the two probes read-only. Domain tools are covered in tests/mcp-tools.mjs.
const {tools}=await result(rpc(7,'tools/list'));
assert.deepEqual(tools.map(tool=>tool.name),['probe_read','probe_echo','feature_flags','epg_status','epg_pipeline_status','enrichment_schema','enrichment_profile','enrichment_runner','enrichment_queue','enrichment_status','prediction_queue_overview','prediction_film_diagnostics','prediction_batch_validate','prediction_pending','prediction_hot_parity','film_localization_diagnose','prediction_batch_key','prediction_batch_manifest','epg_sync_start','epg_sync_step','ratings_sync_status','prediction_batch_start','prediction_batch_submit','prediction_batch_hold','prediction_heartbeat','prediction_complete','discovery_workflow_rollover','epg_workflow_rollover','watchlist_membership_operator','letterboxd_claim_backfill','producer_chain_operator']);
const probes=tools.filter(tool=>tool.name.startsWith('probe_'));
for(const tool of probes){
 assert.equal(tool.inputSchema.type,'object');assert.equal(tool.inputSchema.additionalProperties,false);
 assert.deepEqual(tool.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
}
assert.deepEqual(tools[0].inputSchema.properties,{});
assert.deepEqual(tools[1].inputSchema.required,['text']);
assert.equal(tools[1].inputSchema.properties.text.maxLength,200);

// probe_read returns a fixed diagnostic report without identity data.
let call=await result(rpc(8,'tools/call',{name:'probe_read',arguments:{}}));
const report=call.structuredContent;
assert.equal(report.status,'ok');assert.equal(report.storage,'not_accessed');assert.equal(report.sideEffects,'none');
assert.equal(report.authorization,'cloudflare-access-jwt-verified');assert.equal(report.protocolVersion,'2025-11-25');
assert.ok(Number.isFinite(Date.parse(report.time)));
assert.deepEqual(JSON.parse(call.content[0].text),report);
assert.equal(call.isError,undefined);
assert.doesNotMatch(JSON.stringify(call),/owner@example\.test|owner-identity/);
assert.equal((await result(rpc(9,'tools/call',{name:'probe_read'}))).structuredContent.status,'ok');
assert.equal((await result(rpc(10,'tools/call',{name:'probe_read',arguments:{key:'programme.json'}}))).isError,true);

// probe_echo round-trips through a real MCP HTTP POST.
const sample='Привет, MCP 👋';
call=await result(rpc(11,'tools/call',{name:'probe_echo',arguments:{text:sample}}));
assert.deepEqual(call.content,[{type:'text',text:sample}]);
assert.deepEqual(call.structuredContent,{echo:sample,length:13});
assert.equal((await result(rpc(12,'tools/call',{name:'probe_echo',arguments:{text:'😀'.repeat(200)}}))).structuredContent.length,200);
for(const args of [{},{text:''},{text:'x'.repeat(201)},{text:42},{text:'ok',store:true}]){
 call=await result(rpc(13,'tools/call',{name:'probe_echo',arguments:args}));
 assert.equal(call.isError,true);assert.equal(call.structuredContent,undefined);
}

// JSON-RPC protocol errors.
await expectError(await mcp(rpc(14,'tools/call',{name:'sync_start',arguments:{}})),200,-32602);
await expectError(await mcp(rpc(15,'tools/call',{})),200,-32602);
await expectError(await mcp(rpc(16,'tools/call',{name:'probe_echo',arguments:['x']})),200,-32602);
await expectError(await mcp(rpc(17,'tools/call',['probe_read'])),200,-32602);
body=await expectError(await mcp(rpc(18,'resources/list')),200,-32601);assert.equal(body.id,18);

// Transport-level validation.
await expectError(await mcp('{"jsonrpc":"2.0",'),400,-32700);
await expectError(await mcp(new Uint8Array([0x7b,0xff,0x7d])),400,-32700);
await expectError(await mcp([rpc(19,'ping')]),400,-32600);
for(const invalid of [{jsonrpc:'1.0',id:1,method:'ping'},{jsonrpc:'2.0',id:1},{jsonrpc:'2.0',id:1,result:{}},{jsonrpc:'2.0',id:{},method:'ping'},{jsonrpc:'2.0',id:null,method:'ping'},{jsonrpc:'2.0',id:1,method:''},'"ping"'])await expectError(await mcp(invalid),400,-32600);
await expectError(await mcp(rpc(20,'ping'),{headers:{'Content-Type':'text/plain'}}),415,-32000);
await expectError(await mcp(rpc(21,'ping'),{headers:{Accept:'text/html'}}),406,-32000);
assert.deepEqual(await result(rpc(22,'ping'),{headers:{Accept:'application/json'}}),{});
body=await expectError(await mcp(rpc(23,'tools/list'),{headers:{'MCP-Protocol-Version':'2026-07-28'}}),400,-32600);
assert.equal(body.id,23);assert.match(body.error.message,/2025-11-25, 2025-06-18/);
await expectError(await mcp({jsonrpc:'2.0',method:'notifications/initialized'},{headers:{'MCP-Protocol-Version':'1999-01-01'}}),400,-32600);
for(const message of [rpc(231,'tools/list'),rpc(232,'tools/call',{name:'probe_echo',arguments:{text:'no version'}}),rpc(233,'ping'),{jsonrpc:'2.0',method:'notifications/initialized'}]){
 body=await expectError(await mcp(message,{headers:{'MCP-Protocol-Version':undefined}}),400,-32600);
 assert.equal(body.id,message.id??null);assert.match(body.error.message,/^Missing MCP-Protocol-Version header/);
}
assert.equal((await result(rpc(234,'tools/call',{name:'probe_read'}),{headers:{'MCP-Protocol-Version':'2025-06-18'}})).structuredContent.protocolVersion,'2025-06-18');
await expectError(await mcp(rpc(24,'tools/call',{name:'probe_echo',arguments:{text:'x'.repeat(70*1024)}})),413,-32000);
for(const method of ['GET','DELETE']){
 response=await mcp(undefined,{method});
 await expectError(response,405,-32000);assert.equal(response.headers.get('Allow'),'POST');
}
await expectError(await mcp(rpc(25,'ping'),{headers:{Origin:'https://evil.example'}}),403,-32000);
for(const origin of ['https://chatgpt.com',SITE])assert.deepEqual(await result(rpc(26,'ping'),{headers:{Origin:origin}}),{});

// Access denial: only a valid signed assertion for the IPTV MCP audience passes.
const now=Math.floor(Date.now()/1000);
const [validHeader,validClaims,validSignature]=validJwt.split('.');
const denied=[
 ['missing assertion',{jwt:null}],
 ['unverified identity headers',{jwt:null,headers:{'Cf-Access-Authenticated-User-Email':'owner@example.test','Cf-Access-Authenticated-User-Id':'owner-identity'}}],
 ['cookie instead of header',{jwt:null,headers:{Cookie:'CF_Authorization='+validJwt}}],
 ['bearer instead of header',{jwt:null,headers:{Authorization:'Bearer '+validJwt}}],
 ['opaque OAuth token',{jwt:'oauth:opaque-token'}],
 ['malformed segments',{jwt:'a.b.c'}],
 ['wrong signing key',{jwt:await accessJwt({key:rogue.privateKey})}],
 ['tampered claims',{jwt:validHeader+'.'+encode({...JSON.parse(Buffer.from(validClaims,'base64url')),sub:'attacker'})+'.'+validSignature}],
 ['All Workers audience',{jwt:await accessJwt({claims:{aud:[ALL_WORKERS_AUD]}})}],
 ['foreign issuer',{jwt:await accessJwt({claims:{iss:'https://other-team.cloudflareaccess.com'}})}],
 ['expired',{jwt:await accessJwt({claims:{exp:now-120}})}],
 ['missing expiry',{jwt:await accessJwt({claims:{exp:undefined}})}],
 ['not yet valid',{jwt:await accessJwt({claims:{nbf:now+600}})}],
 ['issued in the future',{jwt:await accessJwt({claims:{iat:now+600}})}],
 ['service token identity',{jwt:await accessJwt({claims:{sub:'',common_name:'service-token-client-id'}})}],
 ['unsigned alg none',{jwt:(await accessJwt({header:{alg:'none'}})).split('.').slice(0,2).join('.')+'.'}],
 ['HS256 algorithm',{jwt:await accessJwt({header:{alg:'HS256'}})}],
 ['unknown key id',{jwt:await accessJwt({header:{kid:'kid-unknown'}})}],
];
for(const [label,options] of denied){
 response=await mcp(rpc(27,'tools/call',{name:'probe_echo',arguments:{text:'must not run'}}),options);
 assert.equal(response.status,403,label);
 assert.deepEqual(await response.json(),{jsonrpc:'2.0',id:null,error:{code:-32001,message:'Forbidden'}},label);
}
assert.equal((await mcp(undefined,{method:'GET',jwt:null})).status,403);
assert.equal((await mcp('{broken',{jwt:null})).status,403);
// AIR-524: the controlled Discovery Workflow rollover is behind the same Access gate; a denied caller never reaches the operator, dry_run or apply.
let rolloverCalls=0;context.handleDiscoveryRolloverTool=async()=>{rolloverCalls++;return {status:200,body:{ok:true}};};
for(const [label,options] of denied){
 for(const args of [{mode:'dry_run'},{mode:'apply',confirmGo:true,requestId:'denied-request-1',expectedProgrammeRunId:'run',expectedInstanceId:'discovery_run_0',expectedSeries:0}]){
  response=await mcp(rpc(28,'tools/call',{name:'discovery_workflow_rollover',arguments:args}),options);
  assert.equal(response.status,403,'rollover '+label);
 }
}
assert.equal(rolloverCalls,0,'no denied rollover call reaches the operator');
assert.equal((await result(rpc(29,'tools/call',{name:'discovery_workflow_rollover',arguments:{mode:'dry_run',instanceId:'x'}}))).isError,true,'an unknown argument is refused before the operator');
assert.equal(rolloverCalls,0);
assert.equal((await result(rpc(30,'tools/call',{name:'discovery_workflow_rollover',arguments:{mode:'dry_run'}}))).structuredContent.ok,true);
assert.equal(rolloverCalls,1,'a valid owner assertion reaches it');
delete context.handleDiscoveryRolloverTool;
assert.match((await result(rpc(31,'tools/call',{name:'discovery_workflow_rollover',arguments:{mode:'dry_run'}}))).content[0].text,/unavailable/);
// ADR 0176: the controlled EPG Workflow rollover sits behind the same Access gate; a denied caller never reaches the operator.
let epgRolloverCalls=0;context.handleEpgRolloverTool=async()=>{epgRolloverCalls++;return {status:200,body:{ok:true}};};
for(const [label,options] of denied){
 for(const args of [{mode:'dry_run'},{mode:'apply',confirmGo:true,requestId:'denied-request-1',expectedRunKey:'2026-11-19',expectedEpoch:1,expectedSeries:2,expectedInstanceId:'epg_20261119_2',expectedRunId:'run',expectedControlRevision:1}]){
  response=await mcp(rpc(28,'tools/call',{name:'epg_workflow_rollover',arguments:args}),options);
  assert.equal(response.status,403,'epg rollover '+label);
 }
}
assert.equal(epgRolloverCalls,0,'no denied EPG rollover call reaches the operator');
assert.equal((await result(rpc(29,'tools/call',{name:'epg_workflow_rollover',arguments:{mode:'dry_run',instanceId:'x'}}))).isError,true,'an unknown argument is refused before the operator');
assert.equal(epgRolloverCalls,0);
assert.equal((await result(rpc(30,'tools/call',{name:'epg_workflow_rollover',arguments:{mode:'dry_run'}}))).structuredContent.ok,true);
assert.equal(epgRolloverCalls,1,'a valid owner assertion reaches it');
delete context.handleEpgRolloverTool;
assert.match((await result(rpc(31,'tools/call',{name:'epg_workflow_rollover',arguments:{mode:'dry_run'}}))).content[0].text,/unavailable/);
// AIR-559: the owner-only Letterboxd claim backfill operator sits behind the same Access gate; a denied caller never reaches it, a foreign argument (a lid, a movie id, SQL, a URL) is refused first, and a missing operator is unavailable.
let claimBackfillCalls=0;context.LetterboxdClaimBackfill={handleLetterboxdClaimBackfillTool:async()=>{claimBackfillCalls++;return {status:200,body:{ok:true}};}};
for(const [label,options] of denied){
 for(const args of [{mode:'dry_run'},{mode:'apply',confirmGo:true,requestId:'denied-request-1',expectedFilmPersonGeneration:2,expectedRatingsGeneration:3,expectedProgrammeRunId:'run',expectedPublicationGeneration:4,expectedWatchlistGeneration:5,expectedCount:1,expectedDigest:'a'.repeat(64)}]){
  response=await mcp(rpc(28,'tools/call',{name:'letterboxd_claim_backfill',arguments:args}),options);
  assert.equal(response.status,403,'claim backfill '+label);
 }
}
assert.equal(claimBackfillCalls,0,'no denied claim backfill call reaches the operator');
for(const foreign of [{lid:'AAA1'},{tmdb:'1'},{filmId:'film:tmdb:1'},{sql:'select 1'},{url:'https://example.com'},{pairs:[{lid:'AAA1',tmdb:'1'}]},{key:'letterboxd/facts/links.json'}])
 assert.equal((await result(rpc(29,'tools/call',{name:'letterboxd_claim_backfill',arguments:{mode:'dry_run',...foreign}}))).isError,true,'a foreign argument is refused before the operator: '+Object.keys(foreign));
assert.equal(claimBackfillCalls,0);
assert.equal((await result(rpc(30,'tools/call',{name:'letterboxd_claim_backfill',arguments:{mode:'dry_run'}}))).structuredContent.ok,true);
assert.equal(claimBackfillCalls,1,'a valid owner assertion reaches it');
assert.equal((await result(rpc(30,'tools/call',{name:'letterboxd_claim_backfill',arguments:{}}))).structuredContent.ok,true,'an omitted mode is valid (the operator answers dry_run)');
assert.equal(claimBackfillCalls,2);
delete context.LetterboxdClaimBackfill;
assert.match((await result(rpc(31,'tools/call',{name:'letterboxd_claim_backfill',arguments:{mode:'dry_run'}}))).content[0].text,/unavailable/);
// AIR-572: the owner-only Watchlist membership operator sits behind the same Access gate: an unauthenticated or wrong caller never reaches it (so it cannot write), a foreign argument (a Film id, a lid, SQL, a URL) is
// refused first, a valid owner call reaches it, and a missing operator is unavailable.
let membershipOperatorCalls=0;context.handleWatchlistMembershipOperatorTool=async()=>{membershipOperatorCalls++;return {status:200,body:{ok:true}};};
for(const [label,options] of denied){
 for(const args of [{mode:'status'},{mode:'baseline_apply',confirmGo:true,expectedVersion:3,expectedMarkerGeneration:0},{mode:'switch',confirmGo:true,expectedVersion:3,expectedMarkerGeneration:0}]){
  response=await mcp(rpc(32,'tools/call',{name:'watchlist_membership_operator',arguments:args}),options);
  assert.equal(response.status,403,'membership operator '+label);
 }
}
assert.equal(membershipOperatorCalls,0,'no denied membership operator call reaches the operator');
for(const foreign of [{filmId:'film:tmdb:1'},{lid:'AAA1'},{sql:'select 1'},{url:'https://example.com'},{limit:100},{epoch:1}])
 assert.equal((await result(rpc(33,'tools/call',{name:'watchlist_membership_operator',arguments:{mode:'status',...foreign}}))).isError,true,'a foreign argument is refused before the operator: '+Object.keys(foreign));
assert.equal(membershipOperatorCalls,0);
assert.equal((await result(rpc(34,'tools/call',{name:'watchlist_membership_operator',arguments:{}}))).structuredContent.ok,true);
assert.equal(membershipOperatorCalls,1,'a valid owner assertion reaches it');
delete context.handleWatchlistMembershipOperatorTool;
assert.match((await result(rpc(35,'tools/call',{name:'watchlist_membership_operator',arguments:{mode:'status'}}))).content[0].text,/unavailable/);
// AIR-572: the owner-only Producer chain operator sits behind the same Access gate: a denied caller never reaches it (so it cannot supersede a chain), a foreign argument (SQL, a URL, a Film id,
// a lease or epoch) is refused first, a valid owner call reaches it, and a missing operator is unavailable.
let chainOperatorCalls=0;context.handleProducerChainOperatorTool=async()=>{chainOperatorCalls++;return {status:200,body:{ok:true}};};
for(const [label,options] of denied){
 for(const args of [{mode:'status'},{mode:'supersede',confirmGo:true,expectedProgrammeRunId:'run-old',expectedRevision:22}]){
  response=await mcp(rpc(36,'tools/call',{name:'producer_chain_operator',arguments:args}),options);
  assert.equal(response.status,403,'producer chain operator '+label);
 }
}
assert.equal(chainOperatorCalls,0,'no denied producer chain operator call reaches the operator');
for(const foreign of [{sql:'select 1'},{url:'https://example.com'},{filmId:'film:tmdb:1'},{ownerState:'superseded'},{epoch:1},{leaseExpiresAt:'2026-11-23T00:00:00.000Z'},{hold:false}])
 assert.equal((await result(rpc(37,'tools/call',{name:'producer_chain_operator',arguments:{mode:'status',...foreign}}))).isError,true,'a foreign argument is refused before the operator: '+Object.keys(foreign));
assert.equal(chainOperatorCalls,0);
assert.equal((await result(rpc(38,'tools/call',{name:'producer_chain_operator',arguments:{}}))).structuredContent.ok,true);
assert.equal(chainOperatorCalls,1,'a valid owner assertion reaches it');
delete context.handleProducerChainOperatorTool;
assert.match((await result(rpc(39,'tools/call',{name:'producer_chain_operator',arguments:{mode:'status'}}))).content[0].text,/unavailable/);
assert.deepEqual(await result(rpc(28,'ping'),{jwt:await accessJwt({claims:{aud:AUD}})}),{});
assert.deepEqual(await result(rpc(29,'ping'),{jwt:await accessJwt({claims:{exp:now-30}})}),{});
assert.deepEqual(await result(rpc(30,'ping'),{environment:{...env,MCP_ACCESS_TEAM_DOMAIN:TEAM+'/'}}),{});

// Missing or invalid configuration and unreachable signing keys fail closed.
for(const environment of [{...env,MCP_ACCESS_AUD:undefined},{...env,MCP_ACCESS_AUD:''},{...env,MCP_ACCESS_TEAM_DOMAIN:undefined},{...env,MCP_ACCESS_TEAM_DOMAIN:'http://probe-team.cloudflareaccess.com'},{...env,MCP_ACCESS_TEAM_DOMAIN:TEAM+'.evil.example'},{...env,MCP_ACCESS_TEAM_DOMAIN:'https://evil.example'}]){
 body=await expectError(await mcp(rpc(31,'ping'),{environment}),503,-32603);
 assert.equal(body.error.message,'MCP authorization is not configured');
}
for(const team of [OFFLINE_TEAM,EMPTY_TEAM]){
 body=await expectError(await mcp(rpc(32,'ping'),{environment:{...env,MCP_ACCESS_TEAM_DOMAIN:team},jwt:await accessJwt({claims:{iss:team}})}),503,-32603);
 assert.equal(body.error.message,'Access signing keys are unavailable');
}

// Exact /mcp only; signing keys are cached; no R2 access or other network calls.
response=await mcp(rpc(33,'ping'),{path:'/mcp/'});
assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'Not found'});
assert.equal(certRequests.get(TEAM+'/cdn-cgi/access/certs'),1);
assert.deepEqual(unexpectedRequests,[]);
assert.deepEqual(bucketAccess,[]);
assert.match(fs.readFileSync('build.mjs','utf8'),/src\/mcp\.js[\s\S]*src\/worker\.js/);
console.log('MCP: initialize negotiation, initialized notification, tools/list, probe_read and probe_echo over HTTP POST, tool and JSON-RPC validation, transport errors, Access JWT signature/audience/issuer/expiry/identity checks, fail-closed configuration, key caching and no R2 or extra network access passed');
