// AIR-579: one structured log line per authorized MCP `tools/call`, carrying the tool name, the outcome and the elapsed time and nothing else.
// Local vm only; nothing here calls Cloudflare, R2 or production.
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

const lines=[];const capture={log:(...parts)=>lines.push(parts.join(' ')),info(){},warn(){},error(){}};
const context=vm.createContext({Response,Request,Headers,URL,Date,Map,Set,JSON,TextEncoder,TextDecoder,AbortSignal,atob,crypto:webcrypto,fetch,console:capture,ASSETS:{}});
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

const toolLines=()=>lines.filter(line=>line.startsWith('{"event":"mcp_tool_call"')).map(line=>JSON.parse(line));
const CANARY='CANARY-SECRET-ARGUMENT-7731';
const call=async(name,args)=>{lines.length=0;const response=await mcp(rpc(9,'tools/call',{name,arguments:args}));await response.json();return {status:response.status,logged:toolLines(),all:[...lines]};};

// A registered tool that succeeds: exactly one line, exactly these keys, no argument.
let outcome=await call('probe_echo',{text:CANARY});
assert.equal(outcome.logged.length,1);
assert.deepEqual(Object.keys(outcome.logged[0]).sort(),['event','ms','outcome','tool']);
assert.equal(outcome.logged[0].tool,'probe_echo');assert.equal(outcome.logged[0].outcome,'ok');assert.ok(Number.isInteger(outcome.logged[0].ms)&&outcome.logged[0].ms>=0);
assert.ok(outcome.all.every(line=>!line.includes(CANARY)),'the argument is never logged');

// A registered tool that answers a tool error (bad argument): `tool_error`, still no argument.
outcome=await call('probe_echo',{text:CANARY,extra:CANARY});
assert.equal(outcome.logged.length,1);assert.equal(outcome.logged[0].outcome,'tool_error');assert.equal(outcome.logged[0].tool,'probe_echo');
assert.ok(outcome.all.every(line=>!line.includes(CANARY)));
outcome=await call('probe_read',{});
assert.equal(outcome.logged[0].outcome,'ok');assert.equal(outcome.logged[0].tool,'probe_read');

// An unregistered name is `rejected` and the caller's string is never echoed into the log.
outcome=await call('no_such_tool_'+CANARY,{text:CANARY});
assert.equal(outcome.logged.length,1);assert.equal(outcome.logged[0].tool,'unregistered');assert.equal(outcome.logged[0].outcome,'rejected');
assert.ok(outcome.all.every(line=>!line.includes(CANARY)),'a caller-supplied name is never logged');

// Invalid arguments type: rejected, one line, no argument.
lines.length=0;
await (await mcp(rpc(9,'tools/call',{name:'probe_echo',arguments:[CANARY]}))).json();
assert.equal(toolLines().length,1);assert.equal(toolLines()[0].outcome,'rejected');assert.ok(lines.every(line=>!line.includes(CANARY)));

// Nothing else is logged: other methods, a missing name, an unauthenticated call and a malformed request write no tool line.
lines.length=0;
await (await mcp(rpc(1,'tools/list'))).json();
await (await mcp(rpc(2,'ping'))).json();
await (await mcp(rpc(3,'tools/call',{arguments:{text:CANARY}}))).json();
await (await mcp(rpc(4,'tools/call',{name:'probe_echo',arguments:{text:CANARY}}),{jwt:null})).text();
await (await mcp(rpc(5,'tools/call',{name:'probe_echo',arguments:{text:CANARY}}),{jwt:'not-a-jwt'})).text();
await (await mcp('{not json')).text();
assert.equal(toolLines().length,0,'no tool line for other methods, a missing name, an unauthenticated or a malformed request');
assert.ok(lines.every(line=>!line.includes(CANARY)));

// Every registered tool name is logged as itself (the inventory a log read attributes load to).
const listed=(await result(rpc(6,'tools/list'))).tools.map(tool=>tool.name);
assert.ok(listed.length>20);
for(const name of ['probe_read','epg_status','prediction_pending','prediction_queue_overview']){assert.ok(listed.includes(name),name);}

// The log changes no response: a call answers the same with a logger that throws.
const throwing={...capture,log(){throw new Error('log sink down');}};
context.console=throwing;
const answered=await mcp(rpc(7,'tools/call',{name:'probe_echo',arguments:{text:'x'}}));
assert.equal(answered.status,200);assert.equal((await answered.json()).result.structuredContent.echo,'x');
console.log('MCP tool call log: name, outcome and time only, no argument, unregistered names masked, no line for other methods or failed Access, a failing sink changes no response');
