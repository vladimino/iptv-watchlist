import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// AIR-151: read-only diagnostics of the MCP/HTTP EPG continuation boundary. Every step leaves one
// bounded entry in epg/resolver-continuation-diagnostics.json and one structured log line, so that
// "the call never arrived" and "the call arrived but saved no chunk" can be told apart.
const TEAM='https://probe-team.cloudflareaccess.com',AUD='a1'.repeat(32),SITE='https://iptv.example';
const KEY='epg/resolver-continuation-diagnostics.json',CONTINUATION='epg/resolver-continuation.json';
const TOKEN='tmdb-secret-token-xyz',RUN='6d1f3f1e-5b7e-4d6a-9c2b-1a2b3c4d5e6f';
const signing=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const publicJwk={...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function accessJwt(){
 const now=Math.floor(Date.now()/1000);
 const input=encode({alg:'RS256',kid:'kid-1',typ:'JWT'})+'.'+encode({aud:[AUD],exp:now+300,iat:now,iss:TEAM,sub:'owner-identity',type:'app'});
 const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',signing.privateKey,new TextEncoder().encode(input));
 return input+'.'+Buffer.from(signature).toString('base64url');
}
const jwt=await accessJwt();

const records=new Map(),etags=new Map();let revision=0,puts=[],putBodies=[],conflictOnce=false;
const failing={get:new Set(),put:new Set()};
const bucket={
 // Storage errors carry a secret and a film title, like a real upstream message could; nothing of them may be recorded.
 async get(key){if(failing.get.has(key))throw new Error('r2 get failed: '+key+' token='+TOKEN+' title=Hot Film');return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  if(failing.put.has(key))throw new Error('r2 put failed: '+key+' token='+TOKEN+' title=Hot Film');
  if(key===KEY&&conflictOnce){conflictOnce=false;return null;}
  const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);if(key===KEY)putBodies.push(JSON.parse(value));return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const logs=[];
const movie={id:42,title:'Горячий фильм',original_title:'Hot Film',release_date:'2020-01-01',runtime:100,genres:[],credits:{crew:[],cast:[]},translations:{translations:[]}};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,atob,encodeURIComponent,decodeURIComponent,crypto:webcrypto,setTimeout,ASSETS:{},
 console:{...console,log:line=>{logs.push(String(line));}},
 fetch:async input=>{
  const href=String(input instanceof Request?input.url:input);
  if(href===TEAM+'/cdn-cgi/access/certs')return Response.json({keys:[publicJwk]});
  if(href.startsWith('https://api.themoviedb.org/'))return new Response(JSON.stringify(href.includes('/search/')?{total_pages:1,results:[movie]}:movie));
  return new Response('unexpected',{status:599});
 }});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/enrichment.js','src/migration-export.js','src/prediction-diagnostics.js','src/mcp.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const worker=context.worker,entrypoint=vm.runInContext('DiscoveryContinuation',context),profileKey=vm.runInContext('profileKey',context),continuationUrl=vm.runInContext('DISCOVERY_CONTINUATION_URL',context);
const execution={waitUntil(){},exports:{DiscoveryContinuation:{async fetch(){return Response.json({ok:true});}}}};
const baseEnv=()=>({BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:TOKEN,TMDB_REQUEST_INTERVAL_MS:0,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD});
async function http(path,method,payload,env=baseEnv()){
 const response=await worker.fetch(new Request(SITE+path,{method,headers:{'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload)}),env,execution);
 return {status:response.status,body:await response.json()};
}
async function mcp(name,args,env=baseEnv()){
 const headers={'Content-Type':'application/json',Accept:'application/json','MCP-Protocol-Version':'2025-11-25','Cf-Access-Jwt-Assertion':jwt};
 const response=await worker.fetch(new Request(SITE+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env,execution);
 return (await response.json()).result;
}
const now=Date.now();
const candidate=()=>({key:'hot film|2020',title:'Hot Film',normalizedTitle:'hot film',year:2020,duration:100,durations:[100],firstAiring:now,lastAiring:now,airings:1,shows:[{channelId:'t',channel:'T',start:now,end:now+7200000}]});
const committed=()=>({stage:'paused',reason:'epg_committed',at:new Date(now).toISOString(),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:null});
function seed({continuation=committed(),lease=null,runStage='complete'}={}){
 records.clear();etags.clear();puts=[];putBodies=[];logs.length=0;failing.get.clear();failing.put.clear();conflictOnce=false;
 records.set('programme.json',{runId:RUN,updatedAt:new Date(now).toISOString(),watchlistCount:1,films:[{id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,shows:[]}],stats:{}});
 records.set('sync.json',{runId:RUN,stage:runStage,updatedAt:new Date(now).toISOString()});
 records.set(profileKey,{version:1,profileHash:'p'});
 records.set('epg/discovery-latest.json',{programmeRunId:RUN,items:[candidate()]});
 if(continuation)records.set(CONTINUATION,continuation);
 if(lease)records.set('epg/resolver-lease.json',lease);
}
const diag=()=>records.get(KEY);
const summary=contract=>({state:contract.state??null,nextAction:contract.nextAction??null,reason:contract.reason??null,remainingChunks:contract.remainingChunks??null,programmeRunId:contract.programmeRunId??null,nextCatchUpAt:contract.nextCatchUpAt??null,retryAt:contract.retryAt??null});
const logged=()=>logs.map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(entry=>entry?.event==='epg_continuation');
const SECRETS=[TOKEN,'Hot Film','Горячий','title=','token=',jwt.slice(0,20)];
function assertSanitized(label){const text=JSON.stringify(diag()??null)+'\n'+logs.join('\n');for(const secret of SECRETS)assert.equal(text.includes(secret),false,label+' must not contain '+secret);}

// 1. After the EPG commit the follow-up step runs one chunk: the response, the stored entry and the log agree.
seed();
const chunk=await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(chunk.status,200,JSON.stringify(chunk.body));
assert.equal(chunk.body.stage,'complete');
assert.equal(chunk.body.diagnostic.branch,'chunk');
assert.deepEqual(chunk.body.diagnostic.entry,{stage:'paused',reason:'epg_committed',remainingChunks:12,programmeRunId:null,at:committed().at,nextCatchUpAt:null,retryAt:null,hopId:null});
assert.equal(chunk.body.diagnostic.lease,'none');
assert.deepEqual(chunk.body.diagnostic.decision,{run:true,budget:12,force:false,hardWait:false,nextAction:null});
assert.equal(typeof chunk.body.diagnostic.hopId,'string');
assert.equal(chunk.body.diagnostic.budget,12);
assert.ok(['complete','partial'].includes(chunk.body.diagnostic.chunk.stage),JSON.stringify(chunk.body.diagnostic.chunk));
assert.equal(chunk.body.diagnostic.chunk.error,null);
assert.equal(chunk.body.diagnostic.saved.owned,true);
assert.equal(chunk.body.diagnostic.saved.stage,records.get(CONTINUATION).stage,'the saved summary is the stored continuation');
assert.equal(chunk.body.diagnostic.saved.hopId,chunk.body.diagnostic.hopId);
assert.notEqual(records.get(CONTINUATION).reason,'epg_committed','the chunk moved the continuation on');
const stored=diag();
assert.equal(stored.schemaVersion,1);
assert.equal(stored.recent.length,1);
const entry=stored.recent[0];
assert.equal(entry.phase,'completed');
assert.equal(entry.caller,'http');
assert.equal(entry.route,'/api/sync/epg');
assert.equal(entry.runId,RUN);
assert.equal(entry.runIdShape,'uuid');
assert.equal(entry.runStage,'complete');
assert.deepEqual(entry.recorded,{entered:true,outcome:null,checkpoint:true},'the stored entry can only know about the writes before its own');
assert.deepEqual(entry.checkpoint,{hopId:chunk.body.diagnostic.hopId,owned:true,write:'saved',stage:records.get(CONTINUATION).stage,remainingChunks:records.get(CONTINUATION).remainingChunks},'the checkpoint the hop stored');
assert.equal(entry.branch,'continuation');
assert.equal(entry.httpStatus,200);
assert.equal(entry.error,null);
assert.equal(typeof entry.durationMs,'number');
assert.deepEqual(entry.discovery,summary(chunk.body.discovery));
assert.deepEqual(entry.diagnostic,chunk.body.diagnostic,'the stored trace is the one the response carried');
assert.equal(stored.updatedAt,entry.at);
// The entry is written three times: `entered` before the work, `checkpointed` right after the hop stored its
// checkpoint (before its trailing writes), the outcome after it.
assert.equal(puts.filter(key=>key===KEY).length,3);
assert.equal(putBodies[0].recent[0].phase,'entered');
assert.equal(putBodies[0].recent[0].id,entry.id);
assert.equal(putBodies[0].recent[0].branch,null);
assert.equal(putBodies[1].recent[0].phase,'checkpointed');
assert.equal(putBodies[1].recent[0].id,entry.id);
assert.equal(putBodies[1].recent[0].checkpoint.owned,true);
assert.equal(putBodies[2].recent[0].phase,'completed');
// Three log lines share the entry id: `entered` before any storage access, `checkpointed`, the outcome after the ring write.
const lines=logged();
assert.equal(lines.length,3);
assert.equal(lines[0].id,entry.id);
assert.equal(lines[0].phase,'entered');
assert.equal(lines[0].branch,null);
assert.equal(lines[1].id,entry.id);
assert.equal(lines[1].phase,'checkpointed');
assert.deepEqual(lines[1].checkpoint,entry.checkpoint);
assert.equal(lines[2].id,entry.id);
assert.equal(lines[2].phase,'completed');
assert.equal(lines[2].branch,'continuation');
assert.equal(lines[2].diagnostic.branch,'chunk');
assert.deepEqual(lines[2].recorded,{entered:true,outcome:true,checkpoint:true});
assertSanitized('chunk step');

// 2. A live resolver lease: busy / wait, the continuation is untouched, and the entry says why.
seed({lease:{id:'other',expiresAt:now+60000}});
const busy=await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(busy.status,200);
assert.equal(busy.body.discovery.state,'busy');
assert.equal(busy.body.discovery.nextAction,'wait');
assert.equal(busy.body.diagnostic.branch,'lease_live');
assert.equal(busy.body.diagnostic.lease,'live');
assert.equal(busy.body.diagnostic.decision,null);
assert.equal(busy.body.diagnostic.saved,null);
assert.deepEqual(records.get(CONTINUATION),committed(),'a busy call does not overwrite the continuation');
assert.equal(diag().recent[0].discovery.state,'busy');
assert.equal(diag().recent[0].discovery.reason,'busy');
assert.equal(diag().recent[0].diagnostic.branch,'lease_live');

// 3. The contract says wait (chunk budget spent, catch-up in the future): no chunk, the decision is recorded.
const future=new Date(now+3600000).toISOString();
seed({continuation:{stage:'paused',reason:'chunk_budget',at:new Date(now).toISOString(),hopId:'h0',remainingChunks:0,nextCatchUpAt:future,retryAt:null,programmeRunId:RUN}});
const wait=await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(wait.body.discovery.nextAction,'wait');
assert.equal(wait.body.diagnostic.branch,'contract');
assert.deepEqual(wait.body.diagnostic.decision,{run:false,budget:null,force:false,hardWait:true,nextAction:'wait'});
assert.equal(wait.body.diagnostic.hopId,null);
assert.equal(diag().recent[0].discovery.nextAction,'wait');
assert.equal(diag().recent[0].discovery.reason,'chunk_budget');
assert.equal(diag().recent[0].diagnostic.entry.hopId,null,'a hop id that is not a UUID is not echoed');
assert.equal(diag().recent[0].diagnostic.entry.programmeRunId,RUN);

// 4. No TMDB secret: the step records the missing_secret branch and the error continuation it wrote.
seed();
const secretless=baseEnv();delete secretless.TMDB_API_READ_ACCESS_TOKEN;
const missing=await http('/api/sync/epg','POST',{runId:RUN},secretless);
assert.equal(missing.body.discovery.reason,'missing_secret');
assert.equal(missing.body.discovery.nextAction,'stop');
assert.equal(missing.body.diagnostic.branch,'missing_secret');
assert.equal(missing.body.diagnostic.saved.reason,'missing_secret');
assert.equal(missing.body.diagnostic.saved.owned,true);
assert.equal(diag().recent[0].diagnostic.branch,'missing_secret');

// 5. The chunk itself fails: the error is kept as a classified code, the continuation is `error`, the step completed.
seed();
failing.get.add('epg/discovery-latest.json');
const failedChunk=await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(failedChunk.status,200);
assert.equal(failedChunk.body.discovery.state,'error');
assert.equal(failedChunk.body.diagnostic.branch,'chunk');
assert.equal(failedChunk.body.diagnostic.chunk.stage,'error');
assert.equal(failedChunk.body.diagnostic.chunk.error,'storage');
assert.equal(failedChunk.body.diagnostic.saved.stage,'error');
assert.equal(failedChunk.body.diagnostic.saved.reason,'storage','the error record keeps the thrown message as its reason; the summary classifies it');
assert.match(records.get(CONTINUATION).reason,/r2 get failed/,'the resolver record itself is unchanged by the diagnostics');
assert.equal(diag().recent[0].phase,'completed');
assert.equal(diag().recent[0].error,null,'a chunk error is an outcome, not a failed step');
assert.equal(diag().recent[0].diagnostic.chunk.stage,'error');
assert.equal(diag().recent[0].discovery.reason,'storage');
assertSanitized('chunk error');

// 6. The step fails before any outcome: the entry stays with phase failed, the error code and the branch reached,
// and the two log lines correlate by id.
seed();
failing.get.add(CONTINUATION);
const broken=await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(broken.status,502);
const failedEntry=diag().recent[0];
assert.equal(failedEntry.phase,'failed');
assert.equal(failedEntry.branch,'continuation');
assert.equal(failedEntry.httpStatus,502);
assert.deepEqual(failedEntry.error,{code:'storage',name:'Error'});
assert.equal(failedEntry.discovery,null);
assert.equal(logged().length,2);
assert.equal(logged()[0].phase,'entered');
assert.equal(logged()[1].phase,'failed');
assert.equal(logged()[0].id,logged()[1].id);
assert.deepEqual(logged()[1].recorded,{entered:true,outcome:true});
assertSanitized('failed step');
// The classifier maps messages to codes and never copies them.
assert.equal(vm.runInContext('diagnosticErrorCode(new Error("TMDB HTTP 401 "+"'+TOKEN+'"))',context),'upstream');
assert.equal(vm.runInContext('diagnosticErrorCode(Object.assign(new Error("The operation was aborted"),{name:"AbortError"}))',context),'timeout');
assert.equal(vm.runInContext('diagnosticErrorCode(new Error("EPG generation changed during publish"))',context),'publish_conflict');
assert.equal(vm.runInContext('diagnosticErrorCode(new Error("Hot Film is not a secret"))',context),'unknown');
assert.equal(JSON.stringify(vm.runInContext('diagnosticError(Object.assign(new Error("x"),{name:"Горячий фильм"}))',context)),'{"code":"unknown","name":"Error"}','an unlisted error name is not echoed');

// 7. The diagnostics write itself fails: the step still runs and answers; both log lines are still emitted and
// the final one says that nothing was persisted, so "no ring entry" is not read as "no call".
seed();
failing.put.add(KEY);
const unrecorded=await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(unrecorded.status,200);
assert.equal(unrecorded.body.diagnostic.branch,'chunk');
assert.equal(diag(),undefined);
assert.equal(logged().length,3);
assert.equal(logged()[0].phase,'entered');
assert.equal(logged()[1].phase,'checkpointed');
assert.deepEqual(logged()[2].recorded,{entered:false,outcome:false,checkpoint:false});
assertSanitized('write failure');
seed();
failing.get.add(KEY);
const unreadable=await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(unreadable.status,200);
assert.deepEqual(logged().at(-1).recorded,{entered:false,outcome:false,checkpoint:false},'a ring read failure is reported the same way');
// A conditional-write conflict is retried once.
seed();conflictOnce=true;
await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(diag().recent.length,1);
assert.deepEqual(logged().at(-1).recorded,{entered:true,outcome:true,checkpoint:true});

// 8. Run id mismatch through MCP: the call reached the Worker, and the entry says so with caller mcp.
seed();
const mismatch=await mcp('epg_sync_step',{runId:'nope'});
assert.equal(mismatch.isError,true);
assert.equal(mismatch.structuredContent.httpStatus,409);
const rejected=diag().recent[0];
assert.equal(rejected.caller,'mcp');
assert.equal(rejected.route,'/api/sync/epg');
assert.equal(rejected.branch,'run_mismatch');
assert.equal(rejected.runId,null,'a runId without the server-generated shape is not echoed');
assert.equal(rejected.runIdShape,'invalid');
assert.equal(rejected.runStage,'complete');
assert.equal(JSON.stringify(diag()).includes('nope'),false);
assert.equal(logs.join('\n').includes('nope'),false);
assert.equal(rejected.httpStatus,409);
assert.equal(rejected.phase,'completed');
assert.equal(rejected.discovery,null);
assert.deepEqual(rejected.diagnostic,{},'nothing reached advanceDiscovery');
assertSanitized('mcp mismatch');

// 9. The same continuation step through MCP carries the diagnostic in structuredContent and records caller mcp.
seed();
const viaMcp=await mcp('epg_sync_step',{runId:RUN});
assert.equal(viaMcp.isError,undefined,JSON.stringify(viaMcp));
assert.equal(viaMcp.structuredContent.diagnostic.branch,'chunk');
assert.equal(diag().recent[0].caller,'mcp');
assert.equal(diag().recent[0].branch,'continuation');
assertSanitized('mcp chunk');

// 10. A metadata step is logged but not persisted: the ring buffer is for the continuation boundary.
seed({runStage:'metadata'});
const metadata=await http('/api/sync/metadata','POST',{runId:RUN});
assert.equal(metadata.status,502,'the fixture has no Letterboxd, so the batch fails');
assert.equal(diag(),undefined);
assert.equal(logged().length,2);
assert.equal(logged()[0].phase,'entered');
assert.equal(logged()[1].route,'/api/sync/metadata');
assert.equal(logged()[1].branch,'metadata');
assert.equal(logged()[1].phase,'failed');
assert.deepEqual(logged()[1].recorded,{entered:null,outcome:null},'not persisted, by design');
assert.ok(['storage','upstream','timeout','publish_conflict','resolver_busy','invalid_input','unknown'].includes(logged()[1].error.code));
assertSanitized('metadata step');

// 11. The ring keeps the newest 20 entries, newest first, each with its own id.
seed({lease:{id:'other',expiresAt:now+60000}});
for(let i=0;i<25;i++)await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(diag().recent.length,20);
assert.equal(new Set(diag().recent.map(item=>item.id)).size,20);
assert.ok(diag().recent.every(item=>item.phase==='completed'&&item.branch==='continuation'));

// 12. Pipeline status exposes the ring and writes nothing.
const before=puts.length;
const status=await http('/api/enrichment/pipeline/status','GET');
assert.equal(status.status,200);
assert.equal(status.body.continuationDiagnostics.recent.length,20);
assert.equal(status.body.continuationDiagnostics.schemaVersion,1);
assert.equal(puts.length,before,'a status read does not write');
const viaTool=await mcp('epg_pipeline_status',{});
assert.equal(viaTool.structuredContent.continuationDiagnostics.recent.length,20);
assert.equal(puts.length,before);
seed();
assert.equal((await http('/api/enrichment/pipeline/status','GET')).body.continuationDiagnostics,null,'no entries yet reads as null');

// 13. The HTTP resolve route and the internal entrypoint record their own callers and routes.
seed();
const resolve=await http('/api/enrichment/discovery/resolve','POST',{});
assert.equal(resolve.status,200);
assert.equal(resolve.body.diagnostic.branch,'chunk');
assert.equal(resolve.body.diagnostic.decision.force,true);
assert.equal(diag().recent[0].caller,'http');
assert.equal(diag().recent[0].route,'/api/enrichment/discovery/resolve');
assert.equal(diag().recent[0].branch,'resolve');
assert.equal(diag().recent[0].runId,null);
assert.equal(diag().recent[0].runIdShape,null);
seed();
const internal=await entrypoint.fetch(new Request(continuationUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chunks:0})}),baseEnv(),execution);
const internalBody=await internal.json();
assert.equal(internal.status,200);
assert.equal(internalBody.diagnostic.branch,'report_only');
assert.equal(diag().recent[0].caller,'internal');
assert.equal(diag().recent[0].branch,'resolve');
assert.deepEqual(records.get(CONTINUATION),committed(),'chunks:0 reports and changes nothing');
seed();
const badLimit=await http('/api/enrichment/discovery/resolve','POST',{limit:99});
assert.equal(badLimit.status,400);
assert.equal(diag().recent[0].branch,'invalid_limit');
assert.equal(diag().recent[0].httpStatus,400);

// 14. Free text already stored in the continuation (an error record keeps the thrown message as its reason)
// is classified, not copied: neither the entry nor the log carries the secret or the title.
seed({continuation:{stage:'error',reason:'TMDB HTTP 401 token='+TOKEN+' title=Hot Film',at:new Date(now).toISOString(),hopId:'h0',remainingChunks:12,nextCatchUpAt:future,retryAt:null,programmeRunId:RUN}});
const poisoned=await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(poisoned.status,200);
assert.equal(poisoned.body.diagnostic.branch,'contract');
assert.equal(poisoned.body.diagnostic.entry.reason,'upstream');
assert.equal(diag().recent[0].discovery.reason,'upstream');
assert.equal(diag().recent[0].diagnostic.entry.stage,'error');
assertSanitized('poisoned reason');
// Values outside the vocabularies become `other`, never the value itself.
seed({continuation:{...committed(),stage:'Hot Film stage'},runStage:'Hot Film'});
const unlisted=await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(unlisted.status,409,'an unknown sync stage is a stage mismatch');
assert.equal(diag().recent[0].runStage,'other');
seed({continuation:{...committed(),stage:'Hot Film stage'}});
await http('/api/sync/epg','POST',{runId:RUN});
assert.equal(diag().recent[0].diagnostic.entry.stage,'other');
assertSanitized('unlisted values');

console.log('Continuation diagnostics: chunk, busy, wait, missing secret, chunk error, failed step, write failure, mismatch, MCP/HTTP/internal callers, ring buffer and read-only status passed');
