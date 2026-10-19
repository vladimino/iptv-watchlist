// Experimental MCP probe endpoint (Streamable HTTP, JSON responses, stateless).
// Cloudflare Access application "IPTV MCP" (Managed OAuth) authenticates every
// request before it reaches the Worker. This module re-verifies the signed Access
// JWT and exposes two side-effect-free tools. It never reads env.BUCKET.
const MCP_PROTOCOL_VERSIONS=['2025-11-25','2025-06-18'];
const MCP_SERVER_INFO={name:'iptv-watchlist-probe',title:'IPTV Watchlist MCP probe',version:'0.1.0'};
const MCP_INSTRUCTIONS='Experimental connectivity probe for IPTV Watchlist. Only probe_read and probe_echo exist. Neither tool reads or changes watchlist, programme, ratings, settings or any other stored data.';
const MCP_ALLOWED_ORIGINS=['https://chatgpt.com'];
const MCP_MAX_BODY_BYTES=64*1024;
const MCP_MAX_JWT_LENGTH=8192;
const MCP_ECHO_MAX_CHARS=200;
const MCP_CLOCK_SKEW_SECONDS=60;
const MCP_JWKS_TTL_MS=60*60*1000;
const MCP_JWKS_RETRY_MS=30*1000;
const mcpJwksCache=new Map();
const MCP_TOOLS=[
 {name:'probe_read',title:'Probe: read',description:'Use this to check that the IPTV Watchlist MCP connection and Cloudflare Access authorization work. Returns a fixed diagnostic report. It does not read watchlist, programme or any stored data.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'probe_echo',title:'Probe: echo',description:'Use this to test a tool round trip. Returns the given short text unchanged. Nothing is stored.',inputSchema:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:MCP_ECHO_MAX_CHARS,description:`Short test text, 1-${MCP_ECHO_MAX_CHARS} characters.`}},required:['text'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
];
const mcpJson=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const mcpError=(id,code,message,status=200,headers)=>mcpJson({jsonrpc:'2.0',id,error:{code,message}},status,headers);
const mcpIsObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

function mcpBase64UrlBytes(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]*$/.test(value))throw new Error('Invalid base64url');
 const binary=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((value.length+3)%4));
 const bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);return bytes;
}
const mcpBase64UrlJson=value=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(mcpBase64UrlBytes(value)));
function mcpTeamDomain(value){
 if(typeof value!=='string')return null;
 const domain=value.trim().replace(/\/+$/,'');
 return /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(domain)?domain:null;
}
async function mcpFetchAccessKeys(teamDomain){
 const response=await fetch(teamDomain+'/cdn-cgi/access/certs',{headers:{Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw new Error('Access certs HTTP '+response.status);
 const body=await response.json();if(!mcpIsObject(body)||!Array.isArray(body.keys))throw new Error('Invalid Access certs');
 const keys=new Map();
 for(const jwk of body.keys){
  if(!mcpIsObject(jwk)||jwk.kty!=='RSA'||typeof jwk.kid!=='string'||typeof jwk.n!=='string'||typeof jwk.e!=='string')continue;
  if((jwk.alg!==undefined&&jwk.alg!=='RS256')||(jwk.use!==undefined&&jwk.use!=='sig'))continue;
  try{keys.set(jwk.kid,await crypto.subtle.importKey('jwk',{kty:'RSA',n:jwk.n,e:jwk.e,alg:'RS256',ext:true},{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']));}catch{}
 }
 if(!keys.size)throw new Error('No usable Access signing keys');
 return {keys,fetchedAt:Date.now()};
}
async function mcpAccessKey(teamDomain,kid){
 const cached=mcpJwksCache.get(teamDomain),age=cached?Date.now()-cached.fetchedAt:Infinity;
 if(age<MCP_JWKS_TTL_MS&&cached.keys.has(kid))return cached.keys.get(kid);
 // An unknown kid triggers at most one refresh per retry window (key rotation).
 if(age<MCP_JWKS_RETRY_MS)return null;
 const fresh=await mcpFetchAccessKeys(teamDomain);mcpJwksCache.set(teamDomain,fresh);return fresh.keys.get(kid)||null;
}
// Trust only the signed Cf-Access-Jwt-Assertion header. Identity headers, the
// CF_Authorization cookie and the client's opaque OAuth bearer token are ignored.
async function mcpVerifyAccess(request,env){
 const forbidden={ok:false,status:403,message:'Forbidden'};
 const teamDomain=mcpTeamDomain(env.MCP_ACCESS_TEAM_DOMAIN),audience=typeof env.MCP_ACCESS_AUD==='string'?env.MCP_ACCESS_AUD.trim():'';
 if(!teamDomain||!/^[A-Za-z0-9_-]{16,256}$/.test(audience))return {ok:false,status:503,message:'MCP authorization is not configured'};
 const token=request.headers.get('Cf-Access-Jwt-Assertion');
 if(!token||token.length>MCP_MAX_JWT_LENGTH)return forbidden;
 const parts=token.split('.');if(parts.length!==3)return forbidden;
 let header,signature;
 try{header=mcpBase64UrlJson(parts[0]);signature=mcpBase64UrlBytes(parts[2]);}catch{return forbidden;}
 if(!mcpIsObject(header)||header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid||header.kid.length>256||!signature.length)return forbidden;
 let key;
 try{key=await mcpAccessKey(teamDomain,header.kid);}catch{return {ok:false,status:503,message:'Access signing keys are unavailable'};}
 if(!key)return forbidden;
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,signature,new TextEncoder().encode(parts[0]+'.'+parts[1])))return forbidden;
 let claims;try{claims=mcpBase64UrlJson(parts[1]);}catch{return forbidden;}
 if(!mcpIsObject(claims)||claims.iss!==teamDomain)return forbidden;
 if(!(Array.isArray(claims.aud)?claims.aud:[claims.aud]).includes(audience))return forbidden;
 const now=Math.floor(Date.now()/1000);
 if(typeof claims.exp!=='number'||now-MCP_CLOCK_SKEW_SECONDS>=claims.exp)return forbidden;
 if(claims.nbf!==undefined&&(typeof claims.nbf!=='number'||claims.nbf>now+MCP_CLOCK_SKEW_SECONDS))return forbidden;
 if(claims.iat!==undefined&&(typeof claims.iat!=='number'||claims.iat>now+MCP_CLOCK_SKEW_SECONDS))return forbidden;
 // Managed OAuth forwards a user identity. Service-token assertions have an empty sub.
 if(typeof claims.sub!=='string'||!claims.sub)return forbidden;
 return {ok:true};
}

function mcpMediaType(value){return typeof value==='string'?value.split(';')[0].trim().toLowerCase():'';}
function mcpAcceptsJson(value){
 if(!value)return true;
 return value.split(',').map(mcpMediaType).some(type=>['application/json','application/*','*/*'].includes(type));
}
async function mcpReadBody(request){
 const declared=Number(request.headers.get('Content-Length'));
 if(Number.isFinite(declared)&&declared>MCP_MAX_BODY_BYTES)return null;
 if(!request.body)return new Uint8Array();
 const reader=request.body.getReader(),chunks=[];let size=0;
 for(;;){
  const {done,value}=await reader.read();if(done)break;
  size+=value.byteLength;if(size>MCP_MAX_BODY_BYTES){try{await reader.cancel();}catch{}return null;}
  chunks.push(value);
 }
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
const mcpToolError=message=>({content:[{type:'text',text:message}],isError:true});
function mcpCallTool(params,protocolVersion){
 const args=params.arguments===undefined?{}:params.arguments;
 if(!mcpIsObject(args))return {error:'Invalid params: arguments must be an object'};
 if(params.name==='probe_read'){
  if(Object.keys(args).length)return {result:mcpToolError('probe_read takes no arguments.')};
  const report={status:'ok',server:MCP_SERVER_INFO.name,version:MCP_SERVER_INFO.version,transport:'streamable-http',protocolVersion,authorization:'cloudflare-access-jwt-verified',storage:'not_accessed',sideEffects:'none',time:new Date().toISOString()};
  return {result:{content:[{type:'text',text:JSON.stringify(report)}],structuredContent:report}};
 }
 if(params.name==='probe_echo'){
  if(Object.keys(args).some(key=>key!=='text'))return {result:mcpToolError('probe_echo accepts only the "text" argument.')};
  if(typeof args.text!=='string')return {result:mcpToolError('"text" must be a string.')};
  const length=[...args.text].length;
  if(length<1||length>MCP_ECHO_MAX_CHARS)return {result:mcpToolError(`"text" must contain 1-${MCP_ECHO_MAX_CHARS} characters.`)};
  return {result:{content:[{type:'text',text:args.text}],structuredContent:{echo:args.text,length}}};
 }
 return {error:'Unknown tool'};
}
function mcpDispatch(message,protocolVersion){
 const {id,method}=message,params=message.params===undefined?{}:message.params;
 const ok=result=>({jsonrpc:'2.0',id,result}),fail=(code,text)=>({jsonrpc:'2.0',id,error:{code,message:text}});
 if(!mcpIsObject(params))return fail(-32602,'Invalid params');
 if(method==='initialize'){
  if(typeof params.protocolVersion!=='string')return fail(-32602,'Invalid params: protocolVersion is required');
  const negotiated=MCP_PROTOCOL_VERSIONS.includes(params.protocolVersion)?params.protocolVersion:MCP_PROTOCOL_VERSIONS[0];
  return ok({protocolVersion:negotiated,capabilities:{tools:{listChanged:false}},serverInfo:MCP_SERVER_INFO,instructions:MCP_INSTRUCTIONS});
 }
 if(method==='ping')return ok({});
 if(method==='tools/list')return ok({tools:MCP_TOOLS});
 if(method==='tools/call'){
  if(typeof params.name!=='string'||!params.name)return fail(-32602,'Invalid params: tool name is required');
  const outcome=mcpCallTool(params,protocolVersion);
  return outcome.error?fail(-32602,outcome.error):ok(outcome.result);
 }
 return fail(-32601,'Method not found');
}
async function mcpRoute(request,env){
 try{
  // Authorization runs first so that unauthenticated callers learn nothing else.
  const access=await mcpVerifyAccess(request,env);
  if(!access.ok)return mcpError(null,access.status===403?-32001:-32603,access.message,access.status);
  if(request.method!=='POST')return mcpError(null,-32000,'Method not allowed',405,{Allow:'POST'});
  const origin=request.headers.get('Origin');
  if(origin&&origin!==new URL(request.url).origin&&!MCP_ALLOWED_ORIGINS.includes(origin))return mcpError(null,-32000,'Origin not allowed',403);
  if(mcpMediaType(request.headers.get('Content-Type'))!=='application/json')return mcpError(null,-32000,'Content-Type must be application/json',415);
  if(!mcpAcceptsJson(request.headers.get('Accept')))return mcpError(null,-32000,'Accept must allow application/json',406);
  const bytes=await mcpReadBody(request);
  if(bytes===null)return mcpError(null,-32000,'Request body too large',413);
  let message;
  try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return mcpError(null,-32700,'Parse error',400);}
  if(Array.isArray(message))return mcpError(null,-32600,'Batch requests are not supported',400);
  if(!mcpIsObject(message)||message.jsonrpc!=='2.0')return mcpError(null,-32600,'Invalid Request',400);
  if(!('method' in message))return mcpError(null,-32600,('result' in message||'error' in message)?'Unexpected JSON-RPC response':'Invalid Request',400);
  const notification=!('id' in message);
  if(typeof message.method!=='string'||!message.method||(!notification&&!(typeof message.id==='string'||(typeof message.id==='number'&&Number.isFinite(message.id)))))return mcpError(null,-32600,'Invalid Request',400);
  // Clients send the negotiated version on every request after initialize. A plain
  // -32600 (not the 2026-07-28 code -32022) lets dual-era clients fall back to initialize.
  const protocolVersion=request.headers.get('MCP-Protocol-Version');
  if(protocolVersion!==null&&message.method!=='initialize'&&!MCP_PROTOCOL_VERSIONS.includes(protocolVersion))return mcpError(notification?null:message.id,-32600,'Unsupported MCP-Protocol-Version. Supported: '+MCP_PROTOCOL_VERSIONS.join(', '),400);
  if(notification)return new Response(null,{status:202,headers:{'Cache-Control':'no-store'}});
  return mcpJson(mcpDispatch(message,protocolVersion));
 }catch{return mcpError(null,-32603,'Internal error',500);}
}
