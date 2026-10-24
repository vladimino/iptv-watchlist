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
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/enrichment.js','src/migration-export.js','src/prediction-diagnostics.js','src/mcp.js','src/continuation.js','src/worker.js']){
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
 ['prediction_queue_overview',{key:'enrichment/prediction-queue.json'}],
 ['prediction_film_diagnostics',{filmId:'../secret'}],
 ['prediction_film_diagnostics',{filmId:'film-zz-1',path:'enrichment/films'}],
 ['prediction_pending',{limit:100}],
 ['prediction_pending',{limit:1,cursor:'not-a-cursor'}],
 ['prediction_pending',{limit:1,prefix:'enrichment/'}],
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
assert.equal(mismatch.body.result.isError,true);
const unknown=await tool(env(),'prediction_next',{runId:'missing-run'});
assert.equal(unknown.body.result.structuredContent.httpStatus,404);
assert.equal(unknown.body.result.isError,true);
const started=await tool(env(),'prediction_start',{trigger:'scheduled',capacity:{remainingPercent:40}});
assert.equal(started.body.result.structuredContent.httpStatus,409);
assert.equal(started.body.result.isError,true);
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
for(const name of ['prediction_queue_overview','prediction_film_diagnostics','prediction_pending']){
 assert.equal(tools.find(item=>item.name===name).annotations.readOnlyHint,true,name);
 assert.equal(tools.find(item=>item.name===name).annotations.destructiveHint,false,name);
 assert.equal(tools.find(item=>item.name===name).annotations.openWorldHint,false,name);
}
for(const name of ['epg_sync_start','epg_sync_step','prediction_start','prediction_next','prediction_submit','prediction_heartbeat','prediction_complete']){
 assert.equal(tools.find(item=>item.name===name).annotations.readOnlyHint,false,name);
}
assert.equal(tools.find(item=>item.name==='epg_sync_step').annotations.openWorldHint,true);
const faultSchema=tools.find(item=>item.name==='prediction_complete').inputSchema.properties.fault;
assert.equal(faultSchema.type,'object');
assert.equal(faultSchema.additionalProperties,false);
assert.deepEqual(faultSchema.properties.origin.enum,['worker_http','transport','model_provider','orchestrator','unknown']);

const background=[];
const execution={waitUntil(work){background.push(Promise.resolve(work));},exports:{DiscoveryContinuation:{async fetch(){return Response.json({ok:true});}}}};
const sync=store();
const syncEnv={BUCKET:sync.bucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD,LETTERBOXD_USERNAME:'fixture',EPG_XML_URL:'https://epg.test/guide.xml'};
const syncStart=await tool(syncEnv,'epg_sync_start',{},{execution});
assert.equal(syncStart.body.result.isError,undefined);
assert.equal(syncStart.body.result.structuredContent.stage,'metadata');
assert.equal(syncStart.body.result.structuredContent.remaining,1);
const syncRunId=syncStart.body.result.structuredContent.runId;
assert.equal((await tool(syncEnv,'epg_sync_start',{},{execution})).body.result.structuredContent.runId,syncRunId);
const metadata=await tool(syncEnv,'epg_sync_step',{runId:syncRunId},{execution});
assert.equal(metadata.body.result.isError,undefined,JSON.stringify(metadata.body));
assert.equal(metadata.body.result.structuredContent.stage,'epg');
const committed=await tool(syncEnv,'epg_sync_step',{runId:syncRunId},{execution});
assert.equal(committed.body.result.isError,undefined,JSON.stringify(committed.body));
assert.equal(committed.body.result.structuredContent.stage,'complete');
assert.equal(committed.body.result.structuredContent.discovery.state,'paused');
assert.equal(committed.body.result.structuredContent.discovery.reason,'epg_committed');
assert.equal(committed.body.result.structuredContent.discovery.remainingChunks,12);
assert.equal(committed.body.result.structuredContent.discovery.nextAction,'continue');
assert.equal(background.length,0,'the EPG commit does not dispatch a discovery hop');
const programme=sync.records.get('programme.json');
assert.equal(programme.watchlistCount,1);
assert.equal(programme.films[0].shows.length,1);
assert.ok([...sync.records.keys()].some(key=>key.startsWith('events/items/')));
const letterboxdCalls=fetches.filter(href=>href.includes('letterboxd.com')).length;
const follow=await tool(syncEnv,'epg_sync_step',{runId:syncRunId},{execution});
assert.equal(follow.body.result.isError,undefined,JSON.stringify(follow.body));
assert.equal(follow.body.result.structuredContent.stage,'complete');
assert.equal(follow.body.result.structuredContent.discovery.nextAction,'stop');
assert.equal(follow.body.result.structuredContent.discovery.reason,'missing_secret');
assert.equal(fetches.filter(href=>href.includes('letterboxd.com')).length,letterboxdCalls,'discovery does not retry Letterboxd');
assert.equal(background.length,0);

const predictionFields=Object.fromEntries(Object.entries(vm.runInContext('EXECUTION',context)).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution:predictionFields,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
const now=Date.now();
const happy=store();
happy.records.set('enrichment/profile/current.json',{version:1,schemaVersion:1,profileHash:'profile-hash',profile:{ratingScale:'Half stars'}});
happy.records.set('programme.json',{runId:'programme-1',updatedAt:new Date(now).toISOString(),films:[{id:'film1',title:'Heat',original:'Heat',year:1995,tmdbId:'1656',genres:[],directors:[],actors:[],shows:[{start:now}]}],watchlistCount:1});
happy.records.set('sync.json',{runId:'programme-1',stage:'complete'});
const happyEnv={BUCKET:happy.bucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD};
const happyStart=await tool(happyEnv,'prediction_start',{trigger:'scheduled'});
assert.equal(happyStart.body.result.isError,undefined,JSON.stringify(happyStart.body));
assert.equal(happyStart.body.result.structuredContent.status,'running');
const happyRunId=happyStart.body.result.structuredContent.runId;
const happyNext=await tool(happyEnv,'prediction_next',{runId:happyRunId});
assert.equal(happyNext.body.result.structuredContent.items.length,1);
assert.equal(happyNext.body.result.structuredContent.items[0].filmId,'film1');
const happySubmit=await tool(happyEnv,'prediction_submit',{runId:happyRunId,items:[{filmId:'film1',fingerprint,prediction}]});
assert.equal(happySubmit.body.result.isError,undefined,JSON.stringify(happySubmit.body));
assert.equal(happySubmit.body.result.structuredContent.results[0].status,'created');
assert.equal(happy.records.get('enrichment/films/film1/predictions.json').current.predictedRating,3.5);
const happyDone=await tool(happyEnv,'prediction_complete',{runId:happyRunId});
assert.equal(happyDone.body.result.isError,undefined,JSON.stringify(happyDone.body));
assert.equal(happyDone.body.result.structuredContent.status,'complete');
assert.equal((await tool(happyEnv,'prediction_complete',{runId:happyRunId})).body.result.structuredContent.status,'complete');
assert.ok([...happy.records.keys()].some(key=>key.startsWith('events/items/')&&key.includes('enrichment')));

const conflicts=store();
conflicts.records.set('enrichment/profile/current.json',{version:1,schemaVersion:1,profileHash:'profile-hash',profile:{ratingScale:'Half stars'}});
conflicts.records.set('programme.json',structuredClone(happy.records.get('programme.json')));
conflicts.records.set('sync.json',{runId:'programme-1',stage:'complete'});
conflicts.records.set('enrichment/writer-lease.json',{id:'held',expiresAt:Date.now()+60000});
const conflictEnv={BUCKET:conflicts.bucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD};
const busy=await tool(conflictEnv,'prediction_start',{trigger:'manual'});
assert.equal(busy.body.result.isError,true);
assert.equal(busy.body.result.structuredContent.httpStatus,409);
assert.equal(busy.body.result.structuredContent.status,'busy');
conflicts.records.delete('enrichment/writer-lease.json');
const conflictStart=await tool(conflictEnv,'prediction_start',{trigger:'manual'});
assert.equal(conflictStart.body.result.structuredContent.status,'running');
const conflictRunId=conflictStart.body.result.structuredContent.runId;
const adopted=await tool(conflictEnv,'prediction_start',{trigger:'manual'});
assert.equal(adopted.body.result.isError,undefined);
assert.equal(adopted.body.result.structuredContent.httpStatus,200);
assert.equal(adopted.body.result.structuredContent.status,'already_running');
assert.equal(adopted.body.result.structuredContent.runId,conflictRunId);
const queued=await tool(conflictEnv,'prediction_complete',{runId:conflictRunId});
assert.equal(queued.body.result.isError,true);
assert.equal(queued.body.result.structuredContent.httpStatus,409);
assert.match(queued.body.result.structuredContent.error,/Queue not empty/);
conflicts.records.get('enrichment/runner-lease.json').expiresAt=0;
const lost=await tool(conflictEnv,'prediction_heartbeat',{runId:conflictRunId});
assert.equal(lost.body.result.isError,true);
assert.equal(lost.body.result.structuredContent.httpStatus,409);
assert.match(JSON.stringify(lost.body.result.structuredContent),/lease_lost/);
const restarted=await tool(conflictEnv,'prediction_start',{trigger:'manual'});
assert.equal(restarted.body.result.structuredContent.status,'running',JSON.stringify(restarted.body.result.structuredContent));
const restartedId=restarted.body.result.structuredContent.runId;
await tool(conflictEnv,'prediction_next',{runId:restartedId});
conflicts.records.get('enrichment/profile/current.json').profileHash='changed';
const changed=await tool(conflictEnv,'prediction_next',{runId:restartedId});
assert.equal(changed.body.result.isError,true);
assert.equal(changed.body.result.structuredContent.httpStatus,409);
assert.match(JSON.stringify(changed.body.result.structuredContent),/Profile changed/);

const diagnosticNow=Date.now();
const diagnosticIds=['film-zz-1','film-zz-2','film-zz-3','film-zz-4','film-zz-5'];
const diagnosticRetries=Object.fromEntries(diagnosticIds.map(id=>[id,{kind:id==='film-zz-2'?'Error: Bearer CANARY-TOKEN stack':'validation_error',scope:'item',attempts:2,failedAt:diagnosticNow-1000,retryAt:diagnosticNow+3600000,lastRunId:'run-zz-retry'}]));
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
const diagnosticOverview=await tool(diagnosticEnv,'prediction_queue_overview',{});
assert.equal(diagnosticOverview.body.result.isError,undefined);
assert.equal(diagnosticOverview.body.result.structuredContent.state,'temporarily_ineligible');
assert.equal(diagnosticOverview.body.result.structuredContent.pending.total,5);
assert.equal(diagnosticOverview.body.result.structuredContent.pending.eligibleNow,0);
assert.equal(diagnosticOverview.body.result.structuredContent.pending.hot,5);
assert.equal(diagnosticOverview.body.result.structuredContent.pending.cold,0);
assert.equal(diagnosticOverview.body.result.structuredContent.pending.deferredByRetry,5);
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
const diagnosticSecret=await tool(diagnosticEnv,'prediction_film_diagnostics',{filmId:'film-zz-2'});
assert.equal(diagnosticSecret.body.result.structuredContent.retry.classification,'model_error');
const diagnosticPage=await tool(diagnosticEnv,'prediction_pending',{filter:'eligible',limit:20});
assert.deepEqual(diagnosticPage.body.result.structuredContent.items,[]);
const diagnosticDeferred=await tool(diagnosticEnv,'prediction_pending',{filter:'deferred',limit:2});
assert.deepEqual(diagnosticDeferred.body.result.structuredContent.items.map(item=>item.filmId),['film-zz-1','film-zz-2']);
const diagnosticNext=await tool(diagnosticEnv,'prediction_pending',{filter:'deferred',limit:2,cursor:diagnosticDeferred.body.result.structuredContent.nextCursor});
assert.deepEqual(diagnosticNext.body.result.structuredContent.items.map(item=>item.filmId),['film-zz-3','film-zz-4']);
const diagnosticReport=JSON.stringify([diagnosticOverview.body.result.structuredContent,diagnosticFilm.body.result.structuredContent,diagnosticSecret.body.result.structuredContent,diagnosticDeferred.body.result.structuredContent]);
assert.doesNotMatch(diagnosticReport,/CANARY|Bearer|plotMechanics|mainRisk|enrichment\/|\.json/);
assert.ok(diagnosticReport.length<8000);
assert.equal(diagnosticPuts.length,0);
assert.equal(diagnosticLists.length,0);
assert.ok(diagnosticGets.length<=70,diagnosticGets.join(','));
assert.ok(diagnosticGets.every(key=>/^(enrichment\/prediction-queue\.json|enrichment\/profile\/current\.json|enrichment\/view-index\.json|programme\.json|epg\/discovered-films\.json|epg\/published-generation\.json|epg\/generations\/run-zz\/(?:programme|discovered-films)\.json|enrichment\/films\/film-zz-[1-5]\/(?:fingerprint|predictions)\.json)$/.test(key)),diagnosticGets.join(','));

const rejectedFault=await tool(env(),'prediction_complete',{runId:'run-1',fault:{url:'https://evil.example'}});
assert.equal(rejectedFault.body.result.isError,true);
const faultStore=store();
faultStore.records.set('enrichment/profile/current.json',{version:1,schemaVersion:1,profileHash:'profile-hash',profile:{ratingScale:'Half stars'}});
faultStore.records.set('programme.json',{runId:'programme-1',updatedAt:new Date().toISOString(),films:[{id:'film-zz-9',title:'Fixture',original:'Fixture',year:1995,tmdbId:'8809',genres:[],directors:[],actors:[],shows:[{start:Date.now()}]}],watchlistCount:1});
faultStore.records.set('sync.json',{runId:'programme-1',stage:'complete'});
const faultEnvironment={BUCKET:faultStore.bucket,MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD};
const faultStart=await tool(faultEnvironment,'prediction_start',{trigger:'manual'});
assert.equal(faultStart.body.result.isError,undefined,JSON.stringify(faultStart.body));
const faultRunId=faultStart.body.result.structuredContent.runId;
const faultNext=await tool(faultEnvironment,'prediction_next',{runId:faultRunId});
assert.equal(faultNext.body.result.structuredContent.items.length,1);
const faultDone=await tool(faultEnvironment,'prediction_complete',{runId:faultRunId,reason:'api_error',fault:{origin:'model_provider',failedStep:'next',providerErrorCode:'provider_timeout',httpStatus:503,receivedRequestId:faultNext.body.result.structuredContent.requestId}});
assert.equal(faultDone.body.result.isError,undefined,JSON.stringify(faultDone.body));
assert.equal(faultDone.body.result.structuredContent.stopReason,'api_error');
const faultRow=[...faultStore.records.values()].find(value=>value?.runId===faultRunId&&Array.isArray(value.steps));
assert.equal(faultRow.callerFault.reportedBy,'caller');
assert.equal(faultRow.callerFault.origin,'model_provider');
assert.equal(faultRow.serverFault,null);

console.log('MCP tools: read tools match the HTTP contracts, rejected arguments do not write or fetch, write tools stay behind the Access JWT, and local EPG and prediction lifecycles pass');
