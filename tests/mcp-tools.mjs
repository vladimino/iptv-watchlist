import {installViewIndexFixture} from './view-index-fixture.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import {flowWorld, sql,labelStarts} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {withTaskId,labelledApi} from './prediction-task-id-lib.mjs';
labelStarts();// ADR 0195: the runs of this test are started as a standing Task starts them, with its label

const TEAM='https://probe-team.cloudflareaccess.com';
const AUD='a1'.repeat(32);
const SITE='https://iptv.example';
const signing=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const publicJwk={...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'};
const fetches=[];
const WATCHLIST_HTML='<span class="js-watchlist-count">1</span><div data-component-class="LazyPoster" data-item-name="Heat (1995)" data-item-link="/film/heat-1995/" data-postered-identifier="{&quot;lid&quot;:&quot;film1&quot;}"></div>';
const FILM_HTML='<meta name="description" content="A crew plans a robbery."><span data-tmdb-id="1656"></span><script type="application/ld+json">{"name":"Heat","genre":"Crime","duration":"PT2H50M","director":{"name":"Michael Mann","sameAs":"https://letterboxd.com/director/michael-mann/"},"actor":[{"name":"Al Pacino","sameAs":"https://letterboxd.com/actor/al-pacino/"}]}</script>';
const FILMS_HTML='<span title="1&nbsp;films"></span><li class="griditem"><div data-postered-identifier=\'{&quot;lid&quot;:&quot;film1&quot;}\'></div></li>';
const xmltv=t=>new Date(t).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const epgXml=()=>{const start=Date.now()+10*3600000;return `<tv><channel id="c1"><display-name>Кино</display-name></channel><programme channel="c1" start="${xmltv(start)}" stop="${xmltv(start+170*60000)}"><title>Heat (1995)</title></programme></tv>`;};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,atob,encodeURIComponent,decodeURIComponent,crypto:webcrypto,console,setTimeout,ASSETS:{},
 fetch:async url=>{
  const href=String(url);fetches.push(href);
  if(href===TEAM+'/cdn-cgi/access/certs')return Response.json({keys:[publicJwk]});
  if(href==='https://letterboxd.com/fixture/watchlist/')return new Response(WATCHLIST_HTML);
  if(href==='https://letterboxd.com/film/heat-1995/')return new Response(FILM_HTML);
  if(href==='https://letterboxd.com/fixture/films/')return new Response(FILMS_HTML);
  if(href==='https://epg.test/guide.xml')return new Response(epgXml());
  if(href.startsWith('https://query.wikidata.org/sparql'))return Response.json({results:{bindings:[]}});
  throw new Error('Unexpected network access '+href);
 }});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);vm.runInContext(scoped('src/metadata-cache.js','MetadataCache'),context);for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/mcp.js','src/continuation.js','src/worker.js']){
 vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
}
installViewIndexFixture(context);
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
async function tool(environment,name,args,{assertion=jwt,execution={waitUntil(){}}}={}){
 const requestHeaders={...headers};
 if(assertion)requestHeaders['Cf-Access-Jwt-Assertion']=assertion;else delete requestHeaders['Cf-Access-Jwt-Assertion'];
 const response=await context.worker.fetch(new Request(SITE+'/mcp',{method:'POST',headers:requestHeaders,body:JSON.stringify(rpc(1,'tools/call',{name,arguments:args}))}),environment,execution);
 const body=await response.json();
 return {response,body};
}
function store(){
 const records=new Map(),etags=new Map();let revision=0;
 const bucket={records,async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},async list({prefix=''}={}){return {objects:[...records.keys()].filter(key=>key.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}};
 return {records,bucket};
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
// AIR-430: the pipeline status takes `view`; both values are the HTTP body of the same path, anything else is a tool error and reads nothing.
for(const view of ['operational','detailed']){
 const viaHttp=await http(env(),'/api/enrichment/pipeline/status?view='+view,'GET'),viaMcp=await tool(env(),'epg_pipeline_status',{view});
 assert.equal(viaMcp.response.status,200,view);assert.equal(viaMcp.body.error,undefined,view);
 if(view==='operational'){assert.equal(domain(viaMcp.body.result).body.view,'operational');assert.equal(viaHttp.body.view,'operational');}
 else assert.deepEqual(domain(viaMcp.body.result),await http(env(),'/api/enrichment/pipeline/status','GET'),'detailed is the default body');
}
for(const bad of [{view:'everything'},{view:1},{path:'/api/enrichment/pipeline/status'}])assert.equal((await tool(env(),'epg_pipeline_status',bad)).body.result.isError,true,JSON.stringify(bad));
assert.equal((await tool(env(),'enrichment_profile',{})).body.result.structuredContent.httpStatus,404);
assert.equal((await tool(env(),'enrichment_profile',{})).body.result.isError,true);

const forbidden=[
 ['epg_status',{key:'programme.json'}],
 ['epg_sync_start',{url:'https://evil.example/guide.xml'}],
 ['epg_sync_step',{runId:'run-1',chunks:12}],
 ['prediction_batch_start',{trigger:'scheduled',scope:'watchlist_all',mode:'queued'}],
 ['prediction_batch_start',{trigger:'scheduled',batchSize:100}],
 ['prediction_batch_start',{trigger:'scheduled',key:'enrichment/x'}],
 ['prediction_batch_start',{}],
 ['prediction_batch_start',{trigger:'daily'}],
 ['prediction_batch_start',{trigger:'scheduled',capacity:{remainingPercent:101}}],
 ['prediction_batch_start',{trigger:'scheduled',dryRun:'yes'}],
 ['prediction_batch_start',{trigger:'scheduled',pin:{filmIds:['film-1']}}],
 ['prediction_batch_start',{trigger:'scheduled',dryRun:true,pin:{filmIds:[]}}],
 ['prediction_batch_start',{trigger:'scheduled',dryRun:true,pin:{filmIds:['../secret']}}],
 ['prediction_batch_start',{trigger:'scheduled',dryRun:true,pin:{filmIds:['film-1'],prefix:'enrichment/'}}],
 ['prediction_batch_submit',{runId:'run-1',items:[{filmId:'film-1'}]}],
 ['prediction_batch_submit',{runId:'run-1',epoch:0,items:[{filmId:'film-1'}]}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:[]}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:Array.from({length:11},(_,i)=>({filmId:'film-'+i}))}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:[{filmId:'film-1',key:'enrichment/x'}]}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:[{filmId:'../secret'}]}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:[{filmId:'film-1'},{filmId:'film-1'}]}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:[{filmId:'film-1'}],dryRun:'yes'}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:[{filmId:'film-1'}],manifestHash:'0'.repeat(64)}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:[{filmId:'film-1',inputHash:'0'.repeat(24)}]}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:[{filmId:'film-1'}],dryRun:true,manifestHash:'nothex'}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:[{filmId:'film-1'}],dryRun:true,contract:{path:'x'}}],
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:[{filmId:'film-1'}],path:'/api/enrichment/batch/submit'}],
 // a group over the byte limit of one call (56 KiB, below the 64 KiB transport limit) is refused whole, with nothing submitted
 ['prediction_batch_submit',{runId:'run-1',epoch:1,items:Array.from({length:10},(_,i)=>({filmId:'film-'+i,fingerprint:{strengths:Array.from({length:8},()=>'s'.repeat(380)),risks:Array.from({length:8},()=>'r'.repeat(380))},prediction:{}}))}],
 ['prediction_complete',{runId:'run-1',path:'/api/enrichment/complete'}],
 ['prediction_heartbeat',{runId:'../secret'}],
 ['prediction_queue_overview',{key:'enrichment/prediction-queue.json'}],
 ['prediction_film_diagnostics',{filmId:'../secret'}],
 ['prediction_film_diagnostics',{filmId:'film-zz-1',path:'enrichment/films'}],
 ['prediction_pending',{limit:100}],
 ['prediction_pending',{limit:1,cursor:'not-a-cursor'}],
 ['prediction_pending',{limit:1,prefix:'enrichment/'}],
 ['prediction_hot_parity',{key:'enrichment/prediction-queue.json'}],
 ['prediction_hot_parity',{now:1}],
 ['film_localization_diagnose',{limit:5}],
 ['film_localization_diagnose',{after:'person:x'}],
 ['film_localization_diagnose',{after:'film:'+'x'.repeat(200)}],
 ['film_localization_diagnose',{after:7}],
 ['prediction_batch_manifest',{runId:'../secret'}],
 ['prediction_batch_manifest',{runId:'run-1',part:'all'}],
 ['prediction_batch_manifest',{prefix:'enrichment/'}],
 ['prediction_batch_validate',{}],
 ['prediction_batch_validate',{items:[]}],
 ['prediction_batch_validate',{items:'text'}],
 ['prediction_batch_validate',{items:[{filmId:'f',prediction:{}}],key:'enrichment/x'}],
 ['prediction_batch_validate',{items:Array.from({length:11},(_,i)=>({filmId:'f'+i,prediction:{}}))}],
 ['prediction_batch_validate',{items:[{filmId:'f',prediction:{}},{filmId:'f',prediction:{}}]}],
];
for(const [name,args] of forbidden){
 fetches.length=0;
 const environment=env();
 const outcome=await tool(environment,name,args);
 assert.equal(outcome.body.result.isError,true,name);
 assert.equal(environment.BUCKET.objects.size,0,name);
 assert.deepEqual(fetches.filter(url=>url!==TEAM+'/cdn-cgi/access/certs'),[],name);
}
// AIR-452 (ADR 0167): the retired one-film v5 tools are unknown tools. A call is a JSON-RPC error, not a tool result, and reads or writes nothing, with or without arguments.
const RETIRED_TOOLS=[['prediction_start',{trigger:'scheduled'}],['prediction_next',{runId:'run-1'}],['prediction_submit',{runId:'run-1',items:[{filmId:'film-1',failure:{kind:'parse_error'}}]}],['prediction_validate',{prediction:{}}]];
for(const [name,args] of RETIRED_TOOLS){
 const touched=[],environment={BUCKET:{async get(key){touched.push('get '+key);return null;},async put(key){touched.push('put '+key);return {etag:'1'};},async head(key){touched.push('head '+key);return null;},async list(){touched.push('list');return {objects:[],truncated:false};},async delete(key){touched.push('delete '+key);}},MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD};
 for(const given of [args,{}]){
  fetches.length=0;
  const outcome=await tool(environment,name,given);
  assert.equal(outcome.response.status,200,name);assert.equal(outcome.body.result,undefined,name);
  assert.deepEqual(outcome.body.error,{code:-32602,message:'Unknown tool'},name);
  assert.deepEqual(fetches.filter(url=>url!==TEAM+'/cdn-cgi/access/certs'),[],name);
 }
 assert.deepEqual(touched,[],name+' touches no storage');
 assert.equal((await tool(environment,name,args,{assertion:null})).response.status,403,name+' is still behind the Access JWT');
}
// The retired HTTP routes are gone: 404, and nothing is read or written.
for(const route of ['start','next','submit']){
 const touched=[],environment={BUCKET:{async get(key){touched.push('get '+key);return null;},async put(key){touched.push('put '+key);return {etag:'1'};},async head(key){touched.push('head '+key);return null;},async list(){touched.push('list');return {objects:[],truncated:false};},async delete(key){touched.push('delete '+key);}}};
 const body=route==='start'?{scope:'watchlist_all',mode:'queued',trigger:'scheduled'}:route==='next'?{runId:'run-1',batchSize:1}:{runId:'run-1',items:[{filmId:'film-1',failure:{kind:'parse_error'}}]};
 const answer=await http(environment,'/api/enrichment/'+route,'POST',body);
 assert.deepEqual(answer,{status:404,body:{error:'Not found'}},route);
 assert.deepEqual(touched,[],route+' touches no storage');
}

{
 const big=Array.from({length:10},(_,i)=>({filmId:'film-'+i,fingerprint:{strengths:Array.from({length:8},()=>'s'.repeat(380)),risks:Array.from({length:8},()=>'r'.repeat(380))},prediction:{}}));
 const environment=env(),refused=await tool(environment,'prediction_batch_submit',{taskId:'task00',runId:'run-1',epoch:1,items:big});
 assert.equal(refused.body.result.isError,true);assert.match(refused.body.result.content[0].text,/over the 57344 byte limit of one call/);assert.match(refused.body.result.content[0].text,/Nothing was submitted: split the group/);assert.equal(environment.BUCKET.objects.size,0,'nothing was read or written');
 const fits=await tool(env(),'prediction_batch_submit',{taskId:'task00',runId:'run-1',epoch:1,items:big.slice(0,3)});assert.ok(!/byte limit of one call/.test(JSON.stringify(fits.body.result.content)),'a smaller group passes the size check and reaches the Worker');
}
const mismatch=await tool(env(),'epg_sync_step',{runId:'missing-run'});
assert.deepEqual(domain(mismatch.body.result),{status:409,body:{error:'Run id mismatch'}});
assert.equal(mismatch.body.result.isError,true);
const unknown=await tool(env(),'prediction_complete',{taskId:'task00',runId:'missing-run'});
assert.equal(unknown.body.result.structuredContent.httpStatus,404);
assert.equal(unknown.body.result.isError,true);
// A batch start without the D1 prediction authority (this R2-only environment) refuses and writes nothing: v2 is the only runner (ADR 0167).
{const environment=env(),started=await tool(environment,'prediction_batch_start',{trigger:'scheduled',taskId:'task00',capacity:{remainingPercent:40}});
assert.equal(started.body.result.isError,true);
assert.equal(JSON.parse(started.body.result.content[0].text).httpStatus,409);
assert.match(started.body.result.content[0].text,/batch_runner_requires_d1/);
assert.equal(environment.BUCKET.objects.size,0);}
assert.equal((await tool(env(),'prediction_batch_start',{trigger:'hourly'})).body.result.isError,true);

const anonymous=await tool(env(),'prediction_batch_start',{trigger:'scheduled'},{assertion:null});
assert.equal(anonymous.response.status,403);
assert.equal(anonymous.body.error.code,-32001);

const listed=await context.worker.fetch(new Request(SITE+'/mcp',{method:'POST',headers,body:JSON.stringify(rpc(2,'tools/list',{}))}),env());
const PREFLIGHT_ISSUE_SHAPE='"items":{"type":"object","properties":{"path":{"type":"string","maxLength":120},"code":{"type":"string","enum":["required","invalid_type","invalid_version","invalid_enum","too_few","too_many","empty","too_long","out_of_range","invalid_step","invalid_ref","too_large","unknown_field"]}},"required":["path","code"],"additionalProperties":false}';
const tools=(await listed.json()).result.tools;
for(const tool of tools){
 assert.equal(tool.inputSchema.additionalProperties,false,tool.name);
 const properties=JSON.stringify(tool.inputSchema.properties||{});
 assert.doesNotMatch(properties.replace(PREFLIGHT_ISSUE_SHAPE,''),/"url"|"key"|"path"|"prefix"|"bucket"/,tool.name);
 if(tool.name==='prediction_batch_submit'){assert.ok(properties.includes(PREFLIGHT_ISSUE_SHAPE),'the claimed issue shape is published, a validation path and code and nothing else');assert.equal((properties.match(/"path"/g)||[]).length,2,'the only "path" in the schema is the preflight issue shape (properties and required)');assert.ok(JSON.stringify(tool.inputSchema).includes('"required":["kind","reason"]'),'batch v2 failure.reason is required in the MCP schema');}
}
assert.equal(tools.find(item=>item.name==='enrichment_status').annotations.readOnlyHint,true);
// AIR-452: the retired v5 tools are not listed; every batch v2 tool and the shared heartbeat and completion stay.
const toolNames=tools.map(item=>item.name);
for(const name of ['prediction_start','prediction_next','prediction_submit','prediction_validate'])assert.ok(!toolNames.includes(name),name+' is retired');
for(const name of ['prediction_batch_start','prediction_batch_manifest','prediction_batch_validate','prediction_batch_hold','prediction_batch_submit','prediction_heartbeat','prediction_complete','enrichment_schema','enrichment_runner','enrichment_status','prediction_queue_overview','prediction_film_diagnostics','prediction_pending','prediction_hot_parity'])assert.ok(toolNames.includes(name),name+' stays');
assert.equal(new Set(toolNames).size,toolNames.length,'each tool is listed once');
for(const name of ['prediction_queue_overview','prediction_film_diagnostics','prediction_batch_validate','prediction_pending','prediction_hot_parity','prediction_batch_manifest']){
 assert.equal(tools.find(item=>item.name===name).annotations.readOnlyHint,true,name);
 assert.equal(tools.find(item=>item.name===name).annotations.destructiveHint,false,name);
 assert.equal(tools.find(item=>item.name===name).annotations.openWorldHint,false,name);
}
// ADR 0195: the Task label is a closed enum of the four standing Tasks and is required by every run-scoped tool (a dry-run check, validation and the read-only status tools do not need it).
for(const name of ['prediction_batch_manifest','prediction_batch_hold','prediction_batch_submit','prediction_heartbeat','prediction_complete']){
 const schema=tools.find(item=>item.name===name).inputSchema;
 assert.deepEqual(schema.properties.taskId.enum,['task00','task15','task30','task45'],name);assert.ok(schema.required.includes('taskId'),name+' requires taskId');
}
assert.deepEqual(tools.find(item=>item.name==='prediction_batch_start').inputSchema.properties.taskId.enum,['task00','task15','task30','task45']);
assert.ok(!tools.find(item=>item.name==='prediction_batch_start').inputSchema.required.includes('taskId'),'a dry run or the keyed protocols need no label; a real scheduled start does (checked by the handler)');
for(const name of ['prediction_batch_validate','enrichment_runner','enrichment_status','enrichment_queue'])assert.ok(!(tools.find(item=>item.name===name).inputSchema.required||[]).includes('taskId'),name+' does not require ownership');
for(const [name,args] of [
 ['prediction_batch_start',{trigger:'scheduled'}],
 ['prediction_batch_start',{trigger:'scheduled',taskId:'task99'}],
 ['prediction_batch_start',{trigger:'manual',taskId:'task00'}],
 ['prediction_batch_manifest',{runId:'run-1'}],['prediction_heartbeat',{runId:'run-1'}],['prediction_complete',{runId:'run-1'}],
 ['prediction_batch_hold',{runId:'run-1',epoch:1,items:[{filmId:'f1'}]}],['prediction_batch_submit',{runId:'run-1',epoch:1,items:[{filmId:'f1',prediction:{}}]}],
 ['prediction_heartbeat',{taskId:'TASK00',runId:'run-1'}],['enrichment_runner',{taskId:'task99'}],
]){
 const environment=env(),refused=await tool(environment,name,args);
 assert.equal(refused.body.result.isError,true,name+' '+JSON.stringify(args));assert.match(refused.body.result.content[0].text,/taskId/,name);
 assert.equal(environment.BUCKET.objects.size,0,name+' refused before any storage access');
}
assert.ok(!(await tool(env(),'prediction_batch_start',{trigger:'scheduled',dryRun:true})).body.result.content[0].text.includes('"taskId" is required'),'a scheduled dry run needs no label');
for(const name of ['epg_sync_start','epg_sync_step','prediction_batch_start','prediction_batch_submit','prediction_batch_hold','prediction_heartbeat','prediction_complete','discovery_workflow_rollover','epg_workflow_rollover','letterboxd_claim_backfill']){
 assert.equal(tools.find(item=>item.name===name).annotations.readOnlyHint,false,name);
}
// AIR-537: the owner-only Film/Person prepared-to-open operator is retired; neither the listing nor the instructions may name it.
assert.equal(tools.some(item=>item.name==='film_person_open_handoff'),false,'film_person_open_handoff is not listed');
assert.equal(tools.find(item=>item.name==='epg_sync_step').annotations.openWorldHint,true);
const faultSchema=tools.find(item=>item.name==='prediction_complete').inputSchema.properties.fault;
assert.equal(faultSchema.type,'object');
assert.equal(faultSchema.additionalProperties,false);
assert.deepEqual(faultSchema.properties.origin.enum,['worker_http','transport','model_provider','orchestrator','unknown']);

const background=[];
const execution={waitUntil(work){background.push(Promise.resolve(work));},exports:{DiscoveryContinuation:{async fetch(){return Response.json({ok:true});}}}};
const sync=store();
const syncEnv={BUCKET:sync.bucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD,LETTERBOXD_USERNAME:'fixture',EPG_XML_URL:'https://epg.test/guide.xml',METADATA_CACHE_DB_OPTIONAL:'standin'}; // ADR 0162: no D1 binding here, so the explicit local metadata-cache stand-in
const syncStart=await tool(syncEnv,'epg_sync_start',{},{execution});
assert.equal(syncStart.body.result.isError,undefined);
assert.equal(syncStart.body.result.structuredContent.stage,'metadata');
assert.equal(syncStart.body.result.structuredContent.remaining,1);
const syncRunId=syncStart.body.result.structuredContent.runId;
assert.equal((await tool(syncEnv,'epg_sync_start',{},{execution})).body.result.structuredContent.runId,syncRunId);
const metadata=await tool(syncEnv,'epg_sync_step',{runId:syncRunId},{execution});
assert.equal(metadata.body.result.isError,undefined,JSON.stringify(metadata.body));
assert.equal(metadata.body.result.structuredContent.stage,'epg');
// AIR-558: this world has no D1 ratings domain, and a Letterboxd projection into the view index now refuses unless RatingsD1 owns it; stand in a domain that owns nothing else and accepts the projection.
vm.runInContext("globalThis.RatingsD1={ratingsMutableKey:()=>false,ratingsReady:async()=>false,readOwned:async()=>({owned:false}),casOwned:async()=>({owned:false}),projectView:async()=>({owned:true,changed:0}),putOwned:async()=>({owned:false}),routeRead:async()=>({handled:false}),ratingsGate:async()=>({ok:true}),readRatingsAuthority:async()=>({ready:false,mode:'r2'})}",context);
const committed=await tool(syncEnv,'epg_sync_step',{runId:syncRunId},{execution});
assert.equal(committed.body.result.isError,undefined,JSON.stringify(committed.body));
assert.equal(committed.body.result.structuredContent.stage,'complete');
assert.equal(committed.body.result.structuredContent.discovery.state,'paused');
assert.equal(committed.body.result.structuredContent.discovery.reason,'delegated');
assert.equal(committed.body.result.structuredContent.discovery.remainingChunks,12);
assert.equal(committed.body.result.structuredContent.discovery.nextAction,'wait');
assert.equal(background.length,0,'the EPG commit does not dispatch a discovery hop');
// AIR-151: the commit step leaves a diagnostics entry with the epg_commit branch and the queued contract.
const commitEntry=sync.records.get('epg/resolver-continuation-diagnostics.json').recent[0];
assert.equal(commitEntry.caller,'mcp');
assert.equal(commitEntry.route,'/api/sync/epg');
assert.equal(commitEntry.branch,'epg_commit');
assert.equal(commitEntry.runStage,'epg');
assert.equal(commitEntry.phase,'completed');
assert.equal(commitEntry.discovery.reason,'delegated');
assert.equal(commitEntry.discovery.remainingChunks,12);
assert.equal(commitEntry.discovery.nextAction,'wait');
const programme=sync.records.get('programme.json');
assert.equal(programme.watchlistCount,1);
assert.equal(programme.films[0].shows.length,1);
assert.ok([...sync.records.keys()].some(key=>key.startsWith('events/items/')));
const letterboxdCalls=fetches.filter(href=>href.includes('letterboxd.com')).length;
const follow=await tool(syncEnv,'epg_sync_step',{runId:syncRunId},{execution});
assert.equal(follow.body.result.isError,undefined,JSON.stringify(follow.body));
assert.equal(follow.body.result.structuredContent.stage,'complete');
assert.equal(follow.body.result.structuredContent.discovery.nextAction,'wait');
assert.equal(follow.body.result.structuredContent.discovery.reason,'delegated');
assert.equal(follow.body.result.structuredContent.delegated,true);
assert.equal(fetches.filter(href=>href.includes('letterboxd.com')).length,letterboxdCalls,'discovery does not retry Letterboxd');
assert.equal(background.length,0);
vm.runInContext('delete globalThis.RatingsD1',context);

const predictionFields=Object.fromEntries(Object.entries(vm.runInContext('EXECUTION',context)).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution:predictionFields,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
// AIR-452 (ADR 0167): the prediction lifecycle runs on batch runner v2 only, through the real MCP handler, in D1 mode as production runs it
// (sqlite D1 stand-in, in-memory R2; no model, network, Cloudflare or production). The Access JWT of these tools is asserted above over HTTP.
const dumpDb=file=>{const r=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
async function mcpFlow(films){
 const w=await flowWorld({films});assert.equal((await w.api('queue/reconcile',{})).status,200);
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 const call=async(name,args)=>{w.ctx.__a={name,args:withTaskId(name,args)};w.ctx.__env=w.env;const r=await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx);assert.equal(r.error,undefined,name);const res=r.result;return {isError:res.isError,data:JSON.parse(res.content[0].text)};};
 return {w,call};
}
const happyFlow=await mcpFlow(1);
const happyStart=await happyFlow.call('prediction_batch_start',{trigger:'scheduled'});
assert.equal(happyStart.isError,undefined,JSON.stringify(happyStart.data).slice(0,300));
assert.equal(happyStart.data.status,'running');assert.equal(happyStart.data.protocol,'batch_v2');
const happyRunId=happyStart.data.runId,happyEpoch=happyStart.data.lease.epoch,happyFilm=happyStart.data.films[0].filmId;
assert.equal(happyStart.data.films.length,1);
const happySubmit=await happyFlow.call('prediction_batch_submit',{runId:happyRunId,epoch:happyEpoch,items:[{filmId:happyFilm,fingerprint,prediction}]});
assert.equal(happySubmit.isError,undefined,JSON.stringify(happySubmit.data));
assert.equal(happySubmit.data.results[0].status,'created');
assert.deepEqual(sql(happyFlow.w.file,'SELECT film_id FROM prediction_pointer').map(row=>row.film_id),[happyFilm]);
assert.equal((await happyFlow.call('prediction_heartbeat',{runId:happyRunId})).isError,undefined,'the shared heartbeat renews a v2 lease');
const happyDone=await happyFlow.call('prediction_complete',{runId:happyRunId});
assert.equal(happyDone.isError,undefined,JSON.stringify(happyDone.data));
assert.equal(happyDone.data.stage,'complete');
assert.equal((await happyFlow.call('prediction_complete',{runId:happyRunId})).isError,undefined,'repeating a finished completion is a replay');
assert.equal([...happyFlow.w.records.keys()].filter(key=>key.startsWith('events/items/')&&key.includes('enrichment-'+happyRunId)).length,1,'one terminal Event');

// AIR-152: a schema rejection names the field through the MCP result; the contract is published by enrichment_schema.
const schemaTool=await tool(env(),'enrichment_schema',{});
assert.equal(schemaTool.body.result.structuredContent.contract.version,1);
assert.deepEqual(schemaTool.body.result.structuredContent.contract.fingerprint.rules.execution.fields.payoff,['weak','mixed','strong','unknown']);
assert.ok(schemaTool.body.result.structuredContent.contract.issueCodes.includes('invalid_enum'));
assert.doesNotMatch(JSON.stringify(schemaTool.body.result.structuredContent),/prediction_validate|prediction_submit\b|prediction_next|prediction_start\b/,'the schema names no retired tool');
// The runner contract names batch v2 only.
const runnerTool=domain((await tool(env(),'enrichment_runner',{})).body.result).body;
assert.equal(runnerTool.protocol,'batch_v2');assert.deepEqual(runnerTool.retiredProtocols,['v5']);assert.equal(runnerTool.batchRunner.start,'/api/enrichment/batch/start');
assert.doesNotMatch(JSON.stringify(runnerTool),/enrichment\/(?:start|next|submit)\b|next\/submit|maxBatchFilms|modelBatching/,'no retired route or v5 field');
const invalidFlow=await mcpFlow(1);
const invalidStart=(await invalidFlow.call('prediction_batch_start',{trigger:'scheduled'})).data;
const {moodLabels:_noMood,...fingerprintWithoutMood}=fingerprint;
const badFingerprint={...fingerprintWithoutMood,execution:{...predictionFields,payoff:'medium'},strengths:['PAYLOAD-CANARY']};
const rejected=await invalidFlow.call('prediction_batch_submit',{runId:invalidStart.runId,epoch:invalidStart.lease.epoch,items:[{filmId:invalidStart.films[0].filmId,fingerprint:badFingerprint,prediction}]});
assert.equal(rejected.isError,undefined,JSON.stringify(rejected.data));
assert.equal(rejected.data.httpStatus,200);
const rejectedItem=rejected.data.results[0];
assert.equal(rejectedItem.status,'validation_failure');assert.equal(rejectedItem.error,'parse_error');assert.equal(rejectedItem.retryable,true);
assert.deepEqual(rejectedItem.validation,{stage:'fingerprint_schema',reportedBy:'worker',issues:[{path:'fingerprint.execution.payoff',code:'invalid_enum'},{path:'fingerprint.moodLabels',code:'required'}]});
assert.deepEqual(sql(invalidFlow.w.file,'SELECT film_id FROM prediction_fingerprint'),[],'nothing was written for the film');
assert.doesNotMatch(JSON.stringify(rejected.data),/PAYLOAD-CANARY|Invalid fingerprint/);
assert.doesNotMatch(JSON.stringify([...invalidFlow.w.records])+dumpDb(invalidFlow.w.file),/PAYLOAD-CANARY|Invalid fingerprint/);

// prediction_batch_validate over the real HTTP/Access path: the same verdicts for a group, bound to filmId and index, no storage, behind the Access JWT, answers without a bucket.
const validateDenied=[];
const validateSealed={BUCKET:{async get(){validateDenied.push('get');},async put(){validateDenied.push('put');},async list(){validateDenied.push('list');}},MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD};
fetches.length=0;
const evidenced={...fingerprint,plotMechanics:['heist'],evidence:{plotMechanics:{heist:[{basis:'metadata',refs:['metadata:synopsis'],confidence:'medium'}]}},sourceBasis:'metadata',sourceRefs:['metadata:synopsis']};
const batchGood=await tool(validateSealed,'prediction_batch_validate',{items:[{filmId:'f1',fingerprint,prediction},{filmId:'f2',prediction},{filmId:'f3',fingerprint:evidenced,metadata:{synopsis:'A crew plans a robbery.'}},{filmId:'f4',fingerprint:evidenced},{filmId:'f5',fingerprint:badFingerprint,prediction:{...prediction,predictedRating:4.2}}]});
assert.equal(batchGood.body.result.isError,undefined,JSON.stringify(batchGood.body));
const batchOut=batchGood.body.result.structuredContent;
assert.equal(batchOut.success,false);assert.equal(batchOut.contractVersion,1);assert.deepEqual(batchOut.counts,{items:5,valid:3,invalid:2});assert.equal(batchOut.storage,'not_accessed');assert.equal(batchOut.sideEffects,'none');
assert.deepEqual(batchOut.results.map(r=>[r.index,r.filmId,r.valid]),[[0,'f1',true],[1,'f2',true],[2,'f3',true],[3,'f4',false],[4,'f5',false]]);
assert.deepEqual(batchOut.results[0].fingerprint,{checked:true,issues:[]});assert.deepEqual(batchOut.results[1].fingerprint,{checked:false,issues:[]},'a prediction_only candidate leaves the fingerprint unchecked');
assert.deepEqual(batchOut.results[3].fingerprint.issues,[{path:'fingerprint.evidence.plotMechanics.heist',code:'invalid_ref'}],'a metadata ref without the metadata is invalid_ref');
assert.deepEqual(batchOut.results[4].prediction.issues,[{path:'prediction.predictedRating',code:'invalid_step'}]);
assert.doesNotMatch(JSON.stringify(batchGood.body),/PAYLOAD-CANARY/);
// The preflight verdict and the submit verdict agree on the same payload.
assert.deepEqual(batchOut.results[4].fingerprint.issues,rejectedItem.validation.issues);
// The caller contract reads success: it names the same verdict as valid, in structuredContent and in the text content alike.
assert.equal(batchOut.success,batchOut.valid);assert.deepEqual(JSON.parse(batchGood.body.result.content[0].text),batchOut,'text content carries the same report');
assert.equal((await tool({MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD},'prediction_batch_validate',{items:[{filmId:'f1',prediction}]})).body.result.structuredContent.valid,true,'answers without a bucket binding');
assert.equal((await tool(validateSealed,'prediction_batch_validate',{items:[{filmId:'f1',prediction}]},{assertion:null})).response.status,403,'stays behind the Access JWT');
assert.deepEqual(validateDenied,[]);
assert.deepEqual(fetches.filter(url=>url!==TEAM+'/cdn-cgi/access/certs'),[]);

// Overlap, an early completion and a lost lease, on batch v2.
const conflictFlow=await mcpFlow(2);
const conflictStart=(await conflictFlow.call('prediction_batch_start',{trigger:'scheduled'})).data;
assert.equal(conflictStart.status,'running');
const conflictRunId=conflictStart.runId;
const adopted=await conflictFlow.call('prediction_batch_start',{trigger:'scheduled',taskId:'task15'});
assert.equal(adopted.isError,undefined);
assert.equal(adopted.data.httpStatus,200);
assert.equal(adopted.data.status,'already_running');
assert.equal(adopted.data.runId,conflictRunId);
const queued=await conflictFlow.call('prediction_complete',{runId:conflictRunId});
assert.equal(queued.isError,true);
assert.equal(queued.data.httpStatus,409);
assert.match(queued.data.error,/Queue not empty/);
{const row=sql(conflictFlow.w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0],doc=JSON.parse(row.d);doc.expiresAt=0;sql(conflictFlow.w.file,"UPDATE prediction_lease SET expires_at=0, document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");}
const lost=await conflictFlow.call('prediction_heartbeat',{runId:conflictRunId});
assert.equal(lost.isError,true);
assert.equal(lost.data.httpStatus,409);
assert.match(JSON.stringify(lost.data),/lease_lost/);
const restarted=await conflictFlow.call('prediction_batch_start',{trigger:'scheduled'});
assert.equal(restarted.data.status,'running',JSON.stringify(restarted.data).slice(0,300));
assert.notEqual(restarted.data.runId,conflictRunId);assert.ok(restarted.data.lease.epoch>conflictStart.lease.epoch,'a takeover raises the epoch');
{const expired=JSON.parse(sql(conflictFlow.w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+conflictRunId+"'")[0].d);
assert.notEqual(expired.status,'running','the run whose lease expired is not left running');assert.equal(expired.stopReason,'lease_lost',JSON.stringify({status:expired.status,stopReason:expired.stopReason}));}

const diagnosticNow=Date.now();
const diagnosticIds=['film-zz-1','film-zz-2','film-zz-3','film-zz-4','film-zz-5'];
const diagnosticRetries=Object.fromEntries(diagnosticIds.map(id=>[id,{kind:id==='film-zz-2'?'Error: Bearer CANARY-TOKEN stack':'validation_error',scope:'item',attempts:2,failedAt:diagnosticNow-1000,retryAt:diagnosticNow+3600000,lastRunId:'run-zz-retry'}]));
diagnosticRetries['film-zz-3'].validation={stage:'fingerprint_schema',reportedBy:'worker',issues:[{path:'fingerprint.execution.hero_vulnerability',code:'invalid_enum'},{path:'fingerprint.strengths CANARY-TEXT',code:'too_long'},{path:'prediction.mainRisk',code:'CANARY-CODE'}]};
const diagnosticRecords=new Map(Object.entries({
 'enrichment/prediction-queue.json':{schemaVersion:3,profileVersion:3,profileHash:'hash-zz',programmeRunId:'run-zz',refreshedAt:'2026-10-24T08:00:00.000Z',hotPending:diagnosticIds,coldPending:[],pending:diagnosticIds,priorityCount:5,retries:diagnosticRetries},
 'enrichment/profile/current.json':{version:3,profileHash:'hash-zz',updatedAt:'2026-10-24T07:00:00.000Z',profile:'CANARY-PROFILE-TEXT'},
 'enrichment/view-index.json':{},
 'programme.json':{runId:'run-zz',films:[]},
 'epg/discovered-films.json':{},
 'epg/published-generation.json':{programmeRunId:'run-zz',phase:'published'},
 'enrichment/films/film-zz-1/fingerprint.json':{fingerprintSchemaVersion:1,fingerprintHash:'fp-zz',plotMechanics:['CANARY-PLOT'.repeat(2000)]},
 'enrichment/films/film-zz-1/predictions.json':{current:{tasteProfileVersion:2,tasteProfileHash:'old-hash',fingerprintHash:'fp-zz',fingerprintSchemaVersion:1,predictionPromptVersion:1,mainRisk:'CANARY-RISK'}},
}));
const diagnosticGets=[],diagnosticPuts=[],diagnosticLists=[];
const diagnosticBucket={async get(key){diagnosticGets.push(key);const value=diagnosticRecords.get(key);return value?{json:async()=>structuredClone(value)}:null;},async put(key){diagnosticPuts.push(key);},async list(options){diagnosticLists.push(options||{});return {objects:[],truncated:false};}};
const diagnosticEnv={BUCKET:diagnosticBucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD};
const denied=[];
const sealedBucket={async get(){denied.push('get');},async put(){denied.push('put');},async list(){denied.push('list');}};
const anonymousDiagnostic=await tool({BUCKET:sealedBucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD},'prediction_queue_overview',{},{assertion:null});
assert.equal(anonymousDiagnostic.response.status,403);
assert.deepEqual(denied,[]);
// AIR-536: the parity tool is owner-only like its siblings. The fixture queue is a stub without the full queue shape, so it answers `unknown`, never a match and never a count.
const anonymousParity=await tool({BUCKET:sealedBucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD},'prediction_hot_parity',{},{assertion:null});
assert.equal(anonymousParity.response.status,403);assert.deepEqual(denied,[]);
const hotParity=await tool(diagnosticEnv,'prediction_hot_parity',{});
assert.equal(hotParity.body.result.isError,undefined);
assert.equal(hotParity.body.result.structuredContent.verdict,'unknown');
assert.deepEqual(hotParity.body.result.structuredContent.reasons,['queue_shape_invalid']);
// AIR-683: the Film localization diagnosis is owner-only like its siblings and needs D1 only: no R2 read or write, and a missing or unproven Film/Person authority is a tool error, never a report.
const anonymousDiagnose=await tool({BUCKET:sealedBucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD},'film_localization_diagnose',{},{assertion:null});
assert.equal(anonymousDiagnose.response.status,403);assert.deepEqual(denied,[]);
const diagnoseNoDb=await tool({BUCKET:sealedBucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD},'film_localization_diagnose',{});
assert.equal(diagnoseNoDb.body.result.isError,true);assert.match(diagnoseNoDb.body.result.content[0].text,/Film localization diagnosis/);assert.deepEqual(denied,[],'the diagnosis never touches R2');
assert.equal(hotParity.body.result.structuredContent.expected,undefined);
const diagnosticOverview=await tool(diagnosticEnv,'prediction_queue_overview',{});
assert.equal(diagnosticOverview.body.result.isError,undefined);
assert.equal(diagnosticOverview.body.result.structuredContent.state,'temporarily_ineligible');
assert.equal(diagnosticOverview.body.result.structuredContent.pending.total,5);
assert.equal(diagnosticOverview.body.result.structuredContent.pending.eligibleNow,0);
assert.equal(diagnosticOverview.body.result.structuredContent.pending.hot,5);
assert.equal(diagnosticOverview.body.result.structuredContent.pending.cold,0);
assert.equal(diagnosticOverview.body.result.structuredContent.pending.deferredByRetry,5);
assert.equal(diagnosticOverview.body.result.structuredContent.pending.retryExhausted,0);
assert.equal(diagnosticOverview.body.result.structuredContent.atomic,false);
assert.notEqual(diagnosticOverview.body.result.structuredContent.state,'drained');
assert.ok(diagnosticGets.length>0&&diagnosticGets.length<=12,diagnosticGets.join(','));
assert.ok(diagnosticGets.every(key=>!key.includes('/films/')),diagnosticGets.join(','));
diagnosticGets.length=0;
const diagnosticFilm=await tool(diagnosticEnv,'prediction_film_diagnostics',{filmId:'film-zz-1'});
assert.equal(diagnosticFilm.body.result.structuredContent.lane,'hot');
assert.equal(diagnosticFilm.body.result.structuredContent.eligibleNow,false);
assert.equal(diagnosticFilm.body.result.structuredContent.cause,'retry_backoff');
assert.equal(diagnosticFilm.body.result.structuredContent.prediction.cause,'profile_changed');
assert.equal(diagnosticFilm.body.result.structuredContent.prediction.stale,true);
assert.equal(diagnosticFilm.body.result.structuredContent.retry.classification,'validation_error');
assert.equal(diagnosticFilm.body.result.structuredContent.retry.retryAt,new Date(diagnosticNow+3600000).toISOString());
assert.equal(diagnosticFilm.body.result.structuredContent.retry.validation,null);
const diagnosticSecret=await tool(diagnosticEnv,'prediction_film_diagnostics',{filmId:'film-zz-2'});
assert.equal(diagnosticSecret.body.result.structuredContent.retry.classification,'model_error');
const diagnosticValidation=await tool(diagnosticEnv,'prediction_film_diagnostics',{filmId:'film-zz-3'});
assert.deepEqual(diagnosticValidation.body.result.structuredContent.retry.validation,{stage:'fingerprint_schema',reportedBy:'worker',issues:[{path:'fingerprint.execution.hero_vulnerability',code:'invalid_enum'}]});
const diagnosticPage=await tool(diagnosticEnv,'prediction_pending',{filter:'eligible',limit:20});
assert.deepEqual(diagnosticPage.body.result.structuredContent.items,[]);
const diagnosticDeferred=await tool(diagnosticEnv,'prediction_pending',{filter:'deferred',limit:2});
assert.deepEqual(diagnosticDeferred.body.result.structuredContent.items.map(item=>item.filmId),['film-zz-1','film-zz-2']);
const diagnosticNext=await tool(diagnosticEnv,'prediction_pending',{filter:'deferred',limit:2,cursor:diagnosticDeferred.body.result.structuredContent.nextCursor});
assert.deepEqual(diagnosticNext.body.result.structuredContent.items.map(item=>item.filmId),['film-zz-3','film-zz-4']);
const diagnosticReport=JSON.stringify([diagnosticOverview.body.result.structuredContent,diagnosticFilm.body.result.structuredContent,diagnosticSecret.body.result.structuredContent,diagnosticValidation.body.result.structuredContent,diagnosticDeferred.body.result.structuredContent]);
assert.doesNotMatch(diagnosticReport,/CANARY|Bearer|plotMechanics|mainRisk|enrichment\/|\.json/);
assert.ok(diagnosticReport.length<8000);
assert.equal(diagnosticPuts.length,0);
assert.equal(diagnosticLists.length,0);
assert.ok(diagnosticGets.length<=70,diagnosticGets.join(','));
assert.ok(diagnosticGets.every(key=>/^(enrichment\/prediction-queue\.json|enrichment\/profile\/current\.json|enrichment\/view-index\.json|programme\.json|epg\/discovered-films\.json|epg\/published-generation\.json|epg\/generations\/run-zz\/(?:programme|discovered-films)\.json|enrichment\/films\/film-zz-[1-5]\/(?:fingerprint|predictions)\.json)$/.test(key)),diagnosticGets.join(','));

const rejectedFault=await tool(env(),'prediction_complete',{runId:'run-1',fault:{url:'https://evil.example'}});
assert.equal(rejectedFault.body.result.isError,true);
const faultFlow=await mcpFlow(1);
const faultStart=await faultFlow.call('prediction_batch_start',{trigger:'scheduled'});
assert.equal(faultStart.isError,undefined,JSON.stringify(faultStart.data).slice(0,300));
const faultRunId=faultStart.data.runId;
const faultDone=await faultFlow.call('prediction_complete',{runId:faultRunId,reason:'api_error',fault:{origin:'model_provider',failedStep:'submit',providerErrorCode:'provider_timeout',httpStatus:503,receivedRequestId:faultStart.data.requestId}});
assert.equal(faultDone.isError,undefined,JSON.stringify(faultDone.data));
assert.equal(faultDone.data.stopReason,'api_error');
const faultRow=[...faultFlow.w.records.values()].find(value=>value?.runId===faultRunId&&Array.isArray(value.steps));
assert.equal(faultRow.callerFault.reportedBy,'caller');
assert.equal(faultRow.callerFault.origin,'model_provider');
assert.equal(faultRow.callerFault.failedStep,'submit');
assert.equal(faultRow.serverFault,null);

console.log('MCP tools: read tools match the HTTP contracts, rejected arguments do not write or fetch, the retired v5 tools and routes are unknown and touch nothing, write tools stay behind the Access JWT, and local EPG and batch v2 prediction lifecycles pass');
