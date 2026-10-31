// MCP endpoint (Streamable HTTP, JSON responses, stateless).
// Cloudflare Access application "IPTV MCP" (Managed OAuth) authenticates every
// request before it reaches the Worker. This module re-verifies the signed Access
// JWT. probe_read, probe_echo, feature_flags and prediction_validate do not touch storage. The prediction diagnostic
// tools only read the existing queue and one requested film. The other EPG and
// prediction tools call the existing Worker functions; they do not accept a URL,
// an R2 key, or an API path.
// AIR-58 is the Access prerequisite, AIR-60 is the internal continuation used by the EPG step,
// and AIR-62 is the later decision to enable Scheduled Tasks. This module does not enable them.
const MCP_PROTOCOL_VERSIONS=['2025-11-25','2025-06-18'];
const MCP_SERVER_INFO={name:'iptv-watchlist-probe',title:'IPTV Watchlist MCP',version:'0.3.0'};
const MCP_INSTRUCTIONS='IPTV Watchlist MCP. probe_read and probe_echo only test the connection and do not touch stored data. feature_flags reads the registered feature flags of the deployed Worker and changes nothing. Read epg_status, epg_pipeline_status, enrichment_schema, enrichment_profile, enrichment_runner, enrichment_queue and enrichment_status before writing. epg_sync_start then epg_sync_step use the returned runId and advance one existing step at a time. After stage is complete, read discovery.nextAction: continue means call epg_sync_step again with the same runId; wait means do not call before discovery.nextCatchUpAt (a server gate, not a scheduled run; discovery.nextScheduledRunAt is the hourly Scheduled Task trigger expected after it); stop means discovery is finished until the next EPG commit. ratingsPending does not request a Letterboxd retry. Personal ratings have their own pipeline: ratings_sync_status reads it; ratings_sync_start then ratings_sync_step with the returned runId advance it while nextAction is continue (wait: not before nextCatchUpAt; stop: done). It acts only when RATINGS_PIPELINE is separate and ratings_storage_migrate has completed; call ratings_storage_migrate only with a separate owner approval. Do not enable a ratings Scheduled Task. prediction_start uses trigger scheduled or manual; already_running means stop and do not adopt that runId. prediction_next returns one film; generate the fingerprint and prediction in ChatGPT, call prediction_validate with the complete objects (it checks the enrichment_schema contract and stores nothing), fix every reported issue, then prediction_submit that one film. A submit rejection returns results[].validation.issues with the field path and code; fix that field for the following films. prediction_heartbeat renews the lease. prediction_complete only when the runner says mustComplete or a real quota, model, API or storage failure stops the run. Do not pass URLs, R2 keys or API paths. prediction_queue_overview, prediction_film_diagnostics and prediction_pending only read the existing queue and one requested film. They do not retry, reset or start a run. AIR-98. A formed prediction response is not proof the client received it. prediction_complete may include fault {origin, failedStep, providerErrorCode, httpStatus, receivedRequestId} only with an external or systemic stop reason; those values are caller-reported. Omit fault when the cause is unknown. A fault on a normal completion is rejected. receivedRequestId acknowledges only the matching step. AIR-88. Do not enable Scheduled Tasks; that is AIR-62. Prerequisites: AIR-58 authorization and AIR-60 one-chunk discovery.';
const MCP_ALLOWED_ORIGINS=['https://chatgpt.com'];
const MCP_MAX_BODY_BYTES=64*1024;
const MCP_MAX_JWT_LENGTH=8192;
const MCP_ECHO_MAX_CHARS=200;
const MCP_CLOCK_SKEW_SECONDS=60;
const MCP_JWKS_TTL_MS=60*60*1000;
const MCP_JWKS_RETRY_MS=30*1000;
const mcpJwksCache=new Map();
const MCP_READ={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const MCP_STATUS={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const MCP_WRITE={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false};
const MCP_WRITE_WORLD={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true};
const MCP_RUN_ID={type:'string',minLength:1,maxLength:100,pattern:'^[A-Za-z0-9_-]{1,100}$',description:'runId returned by the matching start tool. Not an R2 key.'};
const MCP_CAPACITY={type:'object',properties:{remainingPercent:{type:'number',minimum:0,maximum:100}},additionalProperties:false,description:'Known remaining model capacity, 0–100. Omit when unknown.'};
const MCP_TOOLS=[
 {name:'probe_read',title:'Probe: read',description:'Use this to check that the IPTV Watchlist MCP connection and Cloudflare Access authorization work. Returns a fixed diagnostic report. It does not read watchlist, programme or any stored data. AIR-58.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'probe_echo',title:'Probe: echo',description:'Use this to test a tool round trip. Returns the given short text unchanged. Nothing is stored. AIR-58.',inputSchema:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:MCP_ECHO_MAX_CHARS,description:`Short test text, 1-${MCP_ECHO_MAX_CHARS} characters.`}},required:['text'],additionalProperties:false},annotations:MCP_READ},
 {name:'feature_flags',title:'Feature flags',description:'Read the registered Worker feature flags from the deployed environment in one call: for each flag whether it is set or absent, its literal value when it is made of known tokens (otherwise only its shape), whether the value is valid, the effective mode the code uses, and unmet requirements on other flags. Only the registered flags are read; no other binding, secret or token is returned. It does not read storage, change a flag or start anything. AIR-233.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'epg_status',title:'EPG sync status',description:'Read the current EPG/watchlist sync stage, runId and remaining count. Same body as GET /api/status. It does not start sync. AIR-58; the following write steps depend on AIR-60, and AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'epg_pipeline_status',title:'EPG pipeline status',description:'Read normalized EPG candidate, resolver and hot/cold queue counts. Same body as GET /api/enrichment/pipeline/status. It does not scan, resolve or write. AIR-58 and AIR-60.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_schema',title:'Prediction schema',description:'Read the taste-profile and fingerprint schema the model must follow, including contract: the exact rules prediction_submit validates with (required fields, enum values, list sizes, lengths) and the issue codes it reports. Check a fingerprint and prediction against contract before prediction_submit. Same body as GET /api/enrichment/schema. Nothing is stored. AIR-58, AIR-152.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_profile',title:'Taste profile',description:'Read the published taste profile. Same body as GET /api/enrichment/profile. A missing profile means stop; this tool does not publish one. AIR-58.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_runner',title:'Prediction runner contract',description:'Read the current prediction runner contract before a run. Same body as GET /api/enrichment/runner. AIR-58. Enabling the hourly task is AIR-62.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_queue',title:'Prediction queue',description:'Read prediction queue counts and the last batch. Same body as GET /api/enrichment/queue/status. It does not reconcile or start a run. AIR-58.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_status',title:'Prediction status',description:'Read prediction runner state. Same body as GET /api/enrichment/status, including its recovery of an undelivered stop event. It does not start a run. AIR-58; schedule enablement is AIR-62.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_STATUS},
 {name:'prediction_queue_overview',title:'Prediction queue overview',description:'Read the existing prediction queue: pending, eligible and deferred counts, the next retry time in UTC, coverage, and whether the queue, profile and published generation agree. A drained queue is distinct from one that is only waiting on retry. This does not refresh, retry or start a run. AIR-98.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_film_diagnostics',title:'Film prediction diagnostics',description:'Read one film already in storage: fingerprint and prediction presence, whether the prediction matches the current profile, queue lane, retry summary, and index agreement. Missing facts stay unknown or not_recorded. This does not create a fingerprint or a prediction. AIR-98.',inputSchema:{type:'object',properties:{filmId:{type:'string',minLength:1,maxLength:80,pattern:'^[A-Za-z0-9_-]{1,80}$',description:'Film id, 1–80 letters, digits, "_" or "-".'}},required:['filmId'],additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_validate',title:'Validate before submit',description:'Check the complete fingerprint and/or prediction you intend to submit against the same contract prediction_submit enforces (required fields, execution dimension enums, list sizes, lengths). Returns success and valid (both true only when every supplied object was checked and has no issue; both false otherwise), contractVersion and, per object, checked and issues[{path, code}] from the closed vocabulary, for example fingerprint.execution.payoff invalid_enum. Nothing is stored and no run, lease, queue or film is read or touched: this is not a submit and does not count as a failure. Fix every issue, then call prediction_submit. AIR-152.',inputSchema:{type:'object',properties:{fingerprint:{type:'object',description:'The complete fingerprint object you intend to submit.'},prediction:{type:'object',description:'The complete prediction object you intend to submit.'}},additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_pending',title:'Prediction pending page',description:'Read one page of outstanding prediction film ids from the existing queue. filter is all, eligible or deferred. limit is 1–20. Pass the returned cursor for the next page of the same snapshot. This does not list storage or start a run. AIR-98.',inputSchema:{type:'object',properties:{filter:{type:'string',enum:['all','eligible','deferred']},limit:{type:'integer',minimum:1,maximum:20},cursor:{type:'string',minLength:1,maxLength:500,description:'Page token returned by the previous pending page.'}},required:['limit'],additionalProperties:false},annotations:MCP_READ},
 {name:'epg_sync_start',title:'Start EPG sync',description:'Start one EPG/watchlist sync, or return the active run when it is still within its freshness window. No arguments: the Worker chooses the Letterboxd and EPG sources. Returns runId, stage and remaining. Then call epg_sync_step. AIR-58. The EPG commit pauses discovery for a later step. AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_WRITE_WORLD},
 {name:'epg_sync_step',title:'Advance EPG sync one step',description:'Advance the runId from epg_sync_start by one existing step: one metadata batch, the single EPG commit, or one discovery chunk. The response discovery object has state, remainingChunks and nextAction. continue: call again now with the same runId. wait: do not call before nextCatchUpAt, a server gate; nextScheduledRunAt is the expected hourly Scheduled Task trigger after it. stop: do not call until the next EPG commit. ratingsPending is not a reason to retry Letterboxd. This tool accepts no URL, R2 key, limit or chunk count. AIR-58 and AIR-60; AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID},required:['runId'],additionalProperties:false},annotations:MCP_WRITE_WORLD},
 {name:'ratings_sync_status',title:'Letterboxd ratings status',description:'Read the separate Letterboxd ratings pipeline in one call: the RATINGS_PIPELINE switch, the effective pipeline (inline, separate_pending_migration, idle, running, isolated), the storage migration state (none, partial, complete, regressed), the run record with its lease and staleness, the Diary cursor and the removal queue counts. Same body as GET /api/letterboxd/ratings/status. It writes nothing: it never closes a stale run, takes a lease or requests Letterboxd.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'ratings_sync_start',title:'Start Letterboxd ratings run',description:'Start one ratings run of the separate pipeline. trigger is scheduled or manual; clearIsolation true is accepted only with manual and only after the owner approved clearing an isolation. Returns runId, created, nextAction and reason: started (call ratings_sync_step with that runId), busy (a run is active; its runId is not returned), isolated, disabled (RATINGS_PIPELINE is not separate) or not_migrated. A scheduled start has no minimum interval after the previous one. It does not request Letterboxd.',inputSchema:{type:'object',properties:{trigger:{type:'string',enum:['scheduled','manual']},clearIsolation:{type:'boolean'}},required:['trigger'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'ratings_sync_step',title:'Advance Letterboxd ratings run',description:'Advance the runId from ratings_sync_start by one bounded step under a 3-minute lease. The Diary phase requests the first Diary page once per run and never requests page 2 or a later page. The removal phase, only while a rated legacy entry still needs its event scan, lists one page of existing removal events and links an exact film id, then writes stored ratings onto referenced events, then makes at most 5 per-film lookups when REMOVAL_RATING_LOOKUP is on. It does not list events on a step with nothing left to link. nextAction continue: call again with the same runId. wait: another step holds the lease; do not call before nextCatchUpAt. stop: the run is finished, error or unknown, or the reply is run_mismatch, not_running, lease_lost, disabled or not_migrated. A 403 or 429 pauses the source; do not retry it. This tool accepts no URL, R2 key, page or limit.',inputSchema:{type:'object',properties:{runId:{...MCP_RUN_ID,maxLength:80,pattern:'^[A-Za-z0-9-]{1,80}$',description:'runId returned by ratings_sync_start. Not an R2 key.'}},required:['runId'],additionalProperties:false},annotations:MCP_WRITE_WORLD},
 {name:'ratings_storage_migrate',title:'Migrate ratings storage',description:'Owner-approved, one-time storage migration of the separate ratings pipeline: the removal queue to schema version 2 and the Diary cursor to its merge form, each by compare-and-swap, recorded in a durable migration witness. mode dry_run reports what apply would convert and writes nothing; apply converts and is idempotent. Refused while a ratings run holds a live record. A code revert after apply is not safe. Call only with a separate owner approval for that mode.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['dry_run','apply']}},required:['mode'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_start',title:'Start prediction run',description:'Start the prediction runner with scope watchlist_all and mode queued. trigger is scheduled or manual. Pass capacity.remainingPercent only when the real value is known. already_running is success: stop and do not adopt that runId. busy means retry later. This does not generate a fingerprint or a prediction. AIR-58. AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{trigger:{type:'string',enum:['scheduled','manual']},capacity:MCP_CAPACITY},required:['trigger'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_next',title:'Next prediction film',description:'Return the next film for an owned run, one film only. Generate its fingerprint or prediction in ChatGPT from the returned profile and schema. Do not invent a batch size. already complete or mustComplete means call prediction_complete instead of generating. AIR-58.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID,capacity:{...MCP_CAPACITY,properties:{...MCP_CAPACITY.properties,quotaAvailable:{type:'boolean'}}}},required:['runId'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_submit',title:'Submit one prediction',description:'Submit exactly one film for the owned run. The Worker validates the fingerprint and prediction with the enrichment_schema contract. A rejected item is a retryable parse_error for that film and carries results[].validation {stage, issues[{path, code}]}, for example fingerprint.execution.payoff invalid_enum or fingerprint.moodLabels required: fix that field for the following films. For a malformed model response send failure.kind parse_error or validation_error and continue; one bad film does not end the run. AIR-58, AIR-152.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID,items:{type:'array',minItems:1,maxItems:1,items:{type:'object',properties:{filmId:{type:'string',minLength:1,maxLength:80},fingerprint:{type:'object'},prediction:{type:'object'},failure:{type:'object',properties:{kind:{type:'string',enum:['parse_error','validation_error']}},required:['kind'],additionalProperties:false}},required:['filmId'],additionalProperties:false}}},required:['runId','items'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_heartbeat',title:'Renew prediction lease',description:'Renew the 15-minute lease for an owned running prediction run. Call it before a long model generation and about every 10 minutes during one. AIR-58.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID},required:['runId'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_complete',title:'Complete prediction run',description:'Finish the owned run. Omit reason when the queue is empty. Otherwise pass a short reason such as quota, model_unavailable, api_error, storage_error or external_termination. Optional fault is caller-reported, only with that external or systemic reason, and does not prove a Worker failure. Omit it when the cause is unknown. A fault on a normal completion is rejected. Repeating a finished run does not create a second event. AIR-58. AIR-88. AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID,reason:{type:'string',minLength:1,maxLength:80},fault:{type:'object',additionalProperties:false,properties:{origin:{type:'string',enum:['worker_http','transport','model_provider','orchestrator','unknown']},failedStep:{type:'string',enum:['start','next','submit','heartbeat','complete']},providerErrorCode:{type:'string',minLength:1,maxLength:40},httpStatus:{type:'integer',minimum:100,maximum:599},receivedRequestId:{type:'string',minLength:1,maxLength:80}}}},required:['runId'],additionalProperties:false},annotations:{...MCP_WRITE,idempotentHint:true}},
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
const mcpRunId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
function mcpCapacity(value,allowQuota){
 if(value===undefined)return true;
 if(!mcpIsObject(value))return false;
 const allowed=allowQuota?['remainingPercent','quotaAvailable']:['remainingPercent'];
 if(Object.keys(value).some(key=>!allowed.includes(key)))return false;
 if('remainingPercent' in value&&(typeof value.remainingPercent!=='number'||!Number.isFinite(value.remainingPercent)||value.remainingPercent<0||value.remainingPercent>100))return false;
 if('quotaAvailable' in value&&typeof value.quotaAvailable!=='boolean')return false;
 return true;
}
function mcpPayload(httpStatus,body){
 const payload=mcpIsObject(body)?{httpStatus,...body}:{httpStatus,result:body};
 const failed=httpStatus>=500||httpStatus===400||httpStatus===404||httpStatus===409||httpStatus===503;
 return {result:{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload,...(failed?{isError:true}:{})}};
}
async function mcpFromResponse(response){
 let body;try{body=await response.json();}catch{body={error:'Unreadable response'};}
 return mcpPayload(response.status,body);
}
async function mcpDomain(work){
 try{return await mcpFromResponse(await work());}catch(e){return {result:mcpToolError(String(e.message).slice(0,160))};}
}
function mcpEnrichment(env,execution,method,path,body){
 const url=new URL('https://iptv.internal'+path),init={method};
 if(body!==undefined){init.body=JSON.stringify(body);init.headers={'Content-Type':'application/json'};}
 return enrichmentRoute(new Request(url,init),env,url,execution);
}
function mcpRejectFields(name,args,allowed){
 if(Object.keys(args).some(key=>!allowed.includes(key)))return {result:mcpToolError(name+' accepts only'+(allowed.length?' '+allowed.join(', '):' no arguments')+'.')};
 return null;
}
function mcpSubmitItem(item){
 if(!mcpIsObject(item)||Object.keys(item).some(key=>!['filmId','fingerprint','prediction','failure'].includes(key)))return 'prediction_submit item accepts only filmId, fingerprint, prediction and failure.';
 if(typeof item.filmId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(item.filmId))return '"filmId" must be 1–80 letters, digits, "_" or "-".';
 if(item.fingerprint!==undefined&&!mcpIsObject(item.fingerprint))return '"fingerprint" must be an object.';
 if(item.prediction!==undefined&&!mcpIsObject(item.prediction))return '"prediction" must be an object.';
 if(item.failure!==undefined&&(!mcpIsObject(item.failure)||Object.keys(item.failure).join()!=='kind'||!['parse_error','validation_error'].includes(item.failure.kind)))return '"failure.kind" must be parse_error or validation_error.';
 return null;
}
async function mcpCallTool(params,protocolVersion,env,execution){
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
 if(!MCP_TOOLS.some(tool=>tool.name===params.name))return {error:'Unknown tool'};
 if(params.name==='feature_flags'){
  // AIR-233: the allowlisted env bindings only, read by name; no storage, so it answers without a bucket binding.
  const rejected=mcpRejectFields(params.name,args,[]);if(rejected)return rejected;
  const report=featureFlagReport(env);
  return {result:{content:[{type:'text',text:JSON.stringify(report)}],structuredContent:report}};
 }
 if(params.name==='prediction_validate'){
  // AIR-152 preflight: the pure contract validators, no storage, no run or lease. Handled before the
  // storage check so that it answers even without a bucket binding.
  const rejected=mcpRejectFields(params.name,args,['fingerprint','prediction']);if(rejected)return rejected;
  if(args.fingerprint===undefined&&args.prediction===undefined)return {result:mcpToolError('prediction_validate needs "fingerprint", "prediction" or both: the complete objects you intend to submit.')};
  if(args.fingerprint!==undefined&&!mcpIsObject(args.fingerprint))return {result:mcpToolError('"fingerprint" must be an object.')};
  if(args.prediction!==undefined&&!mcpIsObject(args.prediction))return {result:mcpToolError('"prediction" must be an object.')};
  const fingerprint=args.fingerprint===undefined?{checked:false,issues:[]}:{checked:true,issues:fingerprintIssues(args.fingerprint)};
  const prediction=args.prediction===undefined?{checked:false,issues:[]}:{checked:true,issues:predictionIssues(args.prediction)};
  const valid=!fingerprint.issues.length&&!prediction.issues.length;
  // success and valid name the same verdict: the preflight succeeded only when every supplied object
  // was checked and no issue was found. A tool error (bad arguments) carries neither field.
  const report={success:valid,valid,contractVersion:schemaContract().version,fingerprint,prediction,storage:'not_accessed',sideEffects:'none'};
  return {result:{content:[{type:'text',text:JSON.stringify(report)}],structuredContent:report}};
 }
 if(!env.BUCKET)return {result:mcpToolError('Storage unavailable')};
 const fields={epg_status:[],epg_pipeline_status:[],enrichment_schema:[],enrichment_profile:[],enrichment_runner:[],enrichment_queue:[],enrichment_status:[],prediction_queue_overview:[],prediction_film_diagnostics:['filmId'],prediction_pending:['filter','limit','cursor'],epg_sync_start:[],epg_sync_step:['runId'],prediction_start:['trigger','capacity'],prediction_next:['runId','capacity'],prediction_submit:['runId','items'],prediction_heartbeat:['runId'],prediction_complete:['runId','reason','fault'],ratings_sync_status:[],ratings_sync_start:['trigger','clearIsolation'],ratings_sync_step:['runId'],ratings_storage_migrate:['mode']};
 const rejected=mcpRejectFields(params.name,args,fields[params.name]);if(rejected)return rejected;
 if(params.name==='prediction_queue_overview'||params.name==='prediction_film_diagnostics'||params.name==='prediction_pending'){
  try{
   const now=Date.now();
   if(params.name==='prediction_film_diagnostics'){
    if(typeof args.filmId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(args.filmId))return {result:mcpToolError('"filmId" must be 1–80 letters, digits, "_" or "-".')};
    return mcpPayload(200,predictionFilmDiagnostic(await loadPredictionDiagnosticSnapshot(env,args.filmId),args.filmId,now));
   }
   if(params.name==='prediction_pending'){
    const query=predictionPendingQuery(args);
    if(query.error)return {result:mcpToolError(query.error)};
    const page=predictionPendingPage(await loadPredictionDiagnosticSnapshot(env),args,now);
    if(page.error)return {result:mcpToolError(page.error)};
    return mcpPayload(200,page);
   }
   return mcpPayload(200,predictionQueueOverview(await loadPredictionDiagnosticSnapshot(env),now));
  }catch{return {result:mcpToolError('Prediction diagnostics unavailable')};}
 }
 if(params.name==='epg_status')return mcpPayload(200,await syncStatus(env));
 if(params.name==='epg_pipeline_status')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/pipeline/status'));
 if(params.name==='enrichment_schema')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/schema'));
 if(params.name==='enrichment_profile')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/profile'));
 if(params.name==='enrichment_runner')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/runner'));
 if(params.name==='enrichment_queue')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/queue/status'));
 if(params.name==='enrichment_status')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/status'));
 if(params.name==='epg_sync_start')return mcpDomain(()=>postSync(env,execution,'/api/sync/start',{}));
 if(params.name==='epg_sync_step'){
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
  const run=await loadJSON(env,'sync.json');
  return mcpDomain(()=>postSync(env,execution,!run||run.stage==='metadata'?'/api/sync/metadata':'/api/sync/epg',{runId:args.runId},'mcp'));
 }
 if(params.name==='ratings_sync_status')return mcpPayload(200,await LetterboxdRatings.status(env));
 if(params.name==='ratings_sync_start'||params.name==='ratings_sync_step'||params.name==='ratings_storage_migrate'){
  try{const reply=await LetterboxdRatings.handle(env,params.name==='ratings_sync_start'?'start':params.name==='ratings_sync_step'?'step':'migrate',args);return reply.status===400?{result:mcpToolError(reply.body.error)}:mcpPayload(reply.status,reply.body);}
  catch(e){return {result:mcpToolError(String(e.message).slice(0,160))};}
 }
 if(params.name==='prediction_start'){
  if(args.trigger!=='scheduled'&&args.trigger!=='manual')return {result:mcpToolError('"trigger" must be scheduled or manual.')};
  if(!mcpCapacity(args.capacity,false))return {result:mcpToolError('"capacity" accepts only remainingPercent from 0 to 100.')};
  const body={scope:'watchlist_all',mode:'queued',trigger:args.trigger};if(args.capacity)body.capacity=args.capacity;
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/start',body));
 }
 if(params.name==='prediction_next'||params.name==='prediction_heartbeat'||params.name==='prediction_complete'){
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
 }
 if(params.name==='prediction_next'){
  if(!mcpCapacity(args.capacity,true))return {result:mcpToolError('"capacity" accepts only remainingPercent and quotaAvailable.')};
  const body={runId:args.runId,batchSize:1};if(args.capacity)body.capacity=args.capacity;
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/next',body));
 }
 if(params.name==='prediction_submit'){
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
  if(!Array.isArray(args.items)||args.items.length!==1)return {result:mcpToolError('prediction_submit accepts exactly one item.')};
  const issue=mcpSubmitItem(args.items[0]);if(issue)return {result:mcpToolError(issue)};
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/submit',{runId:args.runId,items:args.items}));
 }
 if(params.name==='prediction_heartbeat')return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/heartbeat',{runId:args.runId}));
 if(params.name==='prediction_complete'){
  if(args.reason!==undefined&&(typeof args.reason!=='string'||[...args.reason].length<1||[...args.reason].length>80||/[\u0000-\u001f]/.test(args.reason)))return {result:mcpToolError('"reason" must be 1–80 characters without control characters.')};
  if(args.fault!==undefined&&!mcpIsObject(args.fault))return {result:mcpToolError('"fault" must be an object.')};
  if(args.fault!==undefined&&Object.keys(args.fault).some(key=>!['origin','failedStep','providerErrorCode','httpStatus','receivedRequestId'].includes(key)))return {result:mcpToolError('"fault" accepts only origin, failedStep, providerErrorCode, httpStatus and receivedRequestId.')};
  const body={runId:args.runId};if(args.reason!==undefined)body.reason=args.reason;if(args.fault!==undefined)body.fault=args.fault;
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/complete',body));
 }
 return {error:'Unknown tool'};
}
async function mcpDispatch(message,protocolVersion,env,execution){
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
  const outcome=await mcpCallTool(params,protocolVersion,env,execution);
  return outcome.error?fail(-32602,outcome.error):ok(outcome.result);
 }
 return fail(-32601,'Method not found');
}
async function mcpRoute(request,env,execution){
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
  // Without sessions the header is the only record of the negotiated version. A missing
  // header means 2025-03-26 under the 2025-11-25 transport rules, which is unsupported.
  // A plain -32600 (not the 2026-07-28 code -32022) lets dual-era clients fall back to initialize.
  const protocolVersion=request.headers.get('MCP-Protocol-Version');
  if(message.method!=='initialize'&&!MCP_PROTOCOL_VERSIONS.includes(protocolVersion))return mcpError(notification?null:message.id,-32600,(protocolVersion===null?'Missing':'Unsupported')+' MCP-Protocol-Version header. Supported: '+MCP_PROTOCOL_VERSIONS.join(', '),400);
  if(notification)return new Response(null,{status:202,headers:{'Cache-Control':'no-store'}});
  return mcpJson(await mcpDispatch(message,protocolVersion,env,execution));
 }catch{return mcpError(null,-32603,'Internal error',500);}
}
