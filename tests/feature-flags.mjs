// AIR-233 / ADR 0039: the feature_flags MCP tool reads the registered Worker feature flags by name and nothing else.
// Absent and set flags, literal values only for known tokens, shape-only reports for anything else, validity, the
// effective mode from the consumer's own function, unmet requirements, no storage, no env enumeration, the Access
// boundary, and parity with docs/reference/feature-flags.md and the governance checker.
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
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/enrichment.js','src/migration-export.js','src/prediction-diagnostics.js','src/feature-flags.js','src/mcp.js','src/continuation.js','src/worker.js']){
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

const REGISTERED=['CANDIDATE_DISCOVERY','LIFECYCLE_LOCALIZATION','PREDICTION_VERSION_OBJECTS','PREDICTION_MATERIALIZATION','CATALOG_POSTER_HYDRATION','LETTERBOXD_FACTS','LETTERBOXD_BASELINE_IMPORT','FINDS_WATCHED_MARK','PREDICTION_PROFILE_COMPATIBILITY','PREDICTION_FINGERPRINT_COMPATIBILITY','FINGERPRINT_VERSION_OBJECTS','DISCOVERY_LEDGER_MODE','REMOVAL_RATING_LOOKUP','SCORED_RESOLUTION','RATINGS_REFRESH','FINDS_TITLE_EXCLUSION'];
const SECRET='SECRET-CANARY-7f3a9c';
// An env that refuses enumeration and storage, and records every name read.
function guarded(values){
 const read=new Set();
 const bucket=new Proxy({},{get(){throw new Error('storage touched');}});
 const target={MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD,BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:SECRET,LETTERBOXD_USERNAME:'owner-'+SECRET,EPG_XML_URL:'https://epg.test/'+SECRET,...values};
 const proxy=new Proxy(target,{get(object,key){if(typeof key==='string')read.add(key);return object[key];},ownKeys(){throw new Error('env enumerated');},getOwnPropertyDescriptor(){throw new Error('env enumerated');},has(object,key){if(typeof key==='string')read.add(key);return key in object;}});
 return {env:proxy,read};
}
async function flags(values,options){
 const guard=guarded(values);
 const {response,body}=await tool(guard.env,'feature_flags',{},options);
 return {response,body,report:body.result?.structuredContent,text:JSON.stringify(body),read:guard.read};
}
const entry=(report,name)=>report.flags.find(item=>item.name===name);

// tools/list: one read-only tool, no arguments.
const listed=await (await context.worker.fetch(new Request(SITE+'/mcp',{method:'POST',headers,body:JSON.stringify(rpc(2,'tools/list',{}))}),env())).json();
const descriptor=listed.result.tools.find(item=>item.name==='feature_flags');
assert.ok(descriptor,'feature_flags is listed');
assert.equal(descriptor.annotations.readOnlyHint,true);
assert.equal(descriptor.annotations.openWorldHint,false);
assert.deepEqual(descriptor.inputSchema,{type:'object',properties:{},additionalProperties:false});

// 1. Nothing set: every registered flag is absent, valid, at its default; nothing else is read or returned.
const empty=await flags({});
assert.equal(empty.response.status,200);
assert.notEqual(empty.body.result.isError,true);
assert.deepEqual(empty.report.flags.map(item=>item.name),REGISTERED,'the registry, in order');
assert.equal(empty.report.registryVersion,1);
assert.equal(empty.report.source,'worker_env_bindings');
assert.equal(empty.report.storage,'not_accessed');
assert.equal(empty.report.sideEffects,'none');
assert.ok(Number.isFinite(Date.parse(empty.report.readAt)));
for(const item of empty.report.flags){
 assert.equal(item.state,'absent',item.name);assert.equal(item.raw,null,item.name);assert.equal(item.redacted,false,item.name);
 assert.equal(item.valid,true,item.name);assert.equal(item.issue,null,item.name);assert.equal(item.effective,item.default,item.name);
}
assert.deepEqual(empty.report.summary,{registered:16,set:0,absent:16,invalid:0,redacted:0});
assert.doesNotMatch(empty.text,new RegExp(SECRET),'no other binding leaks');
const allowedReads=new Set([...REGISTERED,'MCP_ACCESS_TEAM_DOMAIN','MCP_ACCESS_AUD','BUCKET','then']);
for(const key of empty.read)assert.ok(allowedReads.has(key),'env read only by registered name: '+key);
assert.ok(!empty.read.has('TMDB_API_READ_ACCESS_TOKEN')&&!empty.read.has('LETTERBOXD_USERNAME')&&!empty.read.has('EPG_XML_URL'));

// 2. A production-like set, including retired tokens and the retired resolver switch.
const live=await flags({PREDICTION_PROFILE_COMPATIBILITY:'selective',PREDICTION_FINGERPRINT_COMPATIBILITY:'selective',PREDICTION_VERSION_OBJECTS:'on',FINGERPRINT_VERSION_OBJECTS:'on',LETTERBOXD_FACTS:'on',FINDS_TITLE_EXCLUSION:'on',FINDS_WATCHED_MARK:'on',LIFECYCLE_LOCALIZATION:'on:programme,on:watchlist,on:epg',SCORED_RESOLUTION:'on',RATINGS_REFRESH:'on',DISCOVERY_LEDGER_MODE:'bounded'});
const l=name=>entry(live.report,name);
assert.deepEqual([l('PREDICTION_PROFILE_COMPATIBILITY').state,l('PREDICTION_PROFILE_COMPATIBILITY').raw,l('PREDICTION_PROFILE_COMPATIBILITY').valid,l('PREDICTION_PROFILE_COMPATIBILITY').effective],['set','selective',true,'selective']);
assert.equal(l('FINGERPRINT_VERSION_OBJECTS').effective,'on');
assert.equal(l('DISCOVERY_LEDGER_MODE').effective,'bounded');
assert.match(l('DISCOVERY_LEDGER_MODE').note,/does not read storage/);
assert.deepEqual([l('FINDS_WATCHED_MARK').effectiveWithRequirements,l('FINDS_WATCHED_MARK').unmetRequirements],['on',[]]);
const localization=l('LIFECYCLE_LOCALIZATION');
assert.deepEqual([localization.raw,localization.valid,localization.issue,localization.effective,localization.scope],['on:programme,on:watchlist,on:epg',false,'retired_tokens','off','metadata'],'retired tokens are shown literally and are inert');
const retired=l('SCORED_RESOLUTION');
assert.deepEqual([retired.state,retired.raw,retired.retired,retired.valid,retired.issue,retired.effective],['set','on',true,false,'retired',null],'a stale retired binding is visible');
const ratings=l('RATINGS_REFRESH');
assert.deepEqual([ratings.state,ratings.raw,ratings.retired,ratings.valid,ratings.issue,ratings.effective],['set','on',true,false,'retired',null],'the retired ratings refresh switch is inert and a stale on is visible (ADR 0040)');
const exclusion=l('FINDS_TITLE_EXCLUSION');
assert.deepEqual([exclusion.state,exclusion.raw,exclusion.retired,exclusion.valid,exclusion.issue,exclusion.effective],['set','on',true,false,'retired',null],'the retired Finds exclusion switch is inert and the production on is visible (ADR 0041)');
assert.equal(l('CANDIDATE_DISCOVERY').state,'absent');
assert.deepEqual(live.report.summary,{registered:16,set:11,absent:5,invalid:4,redacted:0});

// 3. No leakage: a value outside the known tokens is reported by shape only.
const leaky=await flags({CANDIDATE_DISCOVERY:'sk-'+SECRET,PREDICTION_VERSION_OBJECTS:'On',PREDICTION_MATERIALIZATION:{token:SECRET},LIFECYCLE_LOCALIZATION:'on:metadata,'+SECRET,DISCOVERY_LEDGER_MODE:'bounded ',FINGERPRINT_VERSION_OBJECTS:'on'.repeat(150)});
assert.doesNotMatch(leaky.text,new RegExp(SECRET),'a value outside the known tokens never leaves the Worker');
const k=name=>entry(leaky.report,name);
assert.deepEqual([k('CANDIDATE_DISCOVERY').raw,k('CANDIDATE_DISCOVERY').redacted,k('CANDIDATE_DISCOVERY').shape,k('CANDIDATE_DISCOVERY').issue,k('CANDIDATE_DISCOVERY').effective],[null,true,{type:'string',length:('sk-'+SECRET).length},'unrecognized','off']);
assert.deepEqual([k('PREDICTION_VERSION_OBJECTS').raw,k('PREDICTION_VERSION_OBJECTS').redacted,k('PREDICTION_VERSION_OBJECTS').issue,k('PREDICTION_VERSION_OBJECTS').effective],[null,true,'case_or_whitespace','off'],'a near miss is named, not echoed');
assert.deepEqual([k('PREDICTION_MATERIALIZATION').raw,k('PREDICTION_MATERIALIZATION').shape,k('PREDICTION_MATERIALIZATION').issue,k('PREDICTION_MATERIALIZATION').effective],[null,{type:'object'},'not_string','off']);
assert.deepEqual([k('LIFECYCLE_LOCALIZATION').raw,k('LIFECYCLE_LOCALIZATION').issue,k('LIFECYCLE_LOCALIZATION').effective],[null,'unrecognized_tokens','on'],'an unknown token redacts the whole list; the recognized token still decides');
assert.deepEqual([k('DISCOVERY_LEDGER_MODE').raw,k('DISCOVERY_LEDGER_MODE').issue,k('DISCOVERY_LEDGER_MODE').effective],['bounded ','case_or_whitespace','full'],'a padded known token is shown, and it is invalid where the code does not trim');
assert.deepEqual([k('FINGERPRINT_VERSION_OBJECTS').raw,k('FINGERPRINT_VERSION_OBJECTS').shape],[null,{type:'string',length:300}],'an over-long value is shape only');
assert.equal(leaky.report.summary.redacted,5);
// The code trims CANDIDATE_DISCOVERY, so a padded on is known content, valid and on.
const padded=entry((await flags({CANDIDATE_DISCOVERY:' on '})).report,'CANDIDATE_DISCOVERY');
assert.deepEqual([padded.raw,padded.valid,padded.effective],[' on ',true,'on']);

// 4. Requirements on other flags.
const unmet=await flags({FINDS_WATCHED_MARK:'on',LETTERBOXD_BASELINE_IMPORT:'on',PREDICTION_MATERIALIZATION:'on'});
for(const [name,needs] of [['FINDS_WATCHED_MARK','LETTERBOXD_FACTS'],['LETTERBOXD_BASELINE_IMPORT','LETTERBOXD_FACTS'],['PREDICTION_MATERIALIZATION','PREDICTION_VERSION_OBJECTS']]){
 const item=entry(unmet.report,name);
 assert.deepEqual([item.effective,item.effectiveWithRequirements,item.unmetRequirements],['on','off',[needs]],name);
}

// 5. Parity: the effective mode is what each consumer computes, for every value shape.
const consumer={
 CANDIDATE_DISCOVERY:'candidateDiscoveryMode(env)',LIFECYCLE_LOCALIZATION:'metadataLocalizationMode(env)',PREDICTION_VERSION_OBJECTS:"predictionVersionsEnabled(env)?'on':'off'",
 PREDICTION_MATERIALIZATION:"predictionMaterializationEnabled(env)?'on':'off'",CATALOG_POSTER_HYDRATION:"catalogPosterHydrationEnabled(env)?'on':'off'",
 PREDICTION_PROFILE_COMPATIBILITY:'predictionCompatibilityMode(env)',PREDICTION_FINGERPRINT_COMPATIBILITY:'fingerprintCompatibilityMode(env)',FINGERPRINT_VERSION_OBJECTS:"fingerprintVersionsEnabled(env)?'on':'off'",DISCOVERY_LEDGER_MODE:'discoveryLedgerMode(env)',REMOVAL_RATING_LOOKUP:"removalLookupEnabled(env)?'on':'off'",
};
const samples=[undefined,'',' ','on',' on','on ','On','ON','off','selective','Selective','strict','bounded','frozen','full','x',1,true,null,{},'on:metadata','shadow:metadata','on:metadata,shadow:metadata','shadow:metadata,on:metadata','on:epg','on:metadata,on:epg'];
const reportOf=vm.runInContext('featureFlagReport',context);
for(const [name,expression] of Object.entries(consumer)){
 const compute=vm.runInContext('env=>'+expression,context);
 for(const value of samples){const environment={[name]:value};assert.equal(entry(reportOf(environment),name).effective,compute(environment),name+' = '+JSON.stringify(value));}
}
// Consumers without a named reader compare the exact string on.
const enrichment=fs.readFileSync('src/enrichment.js','utf8'),facts=fs.readFileSync('src/letterboxd-facts.js','utf8'),worker=fs.readFileSync('src/worker.js','utf8');
for(const [source,name] of [[enrichment,'LETTERBOXD_FACTS'],[facts,'LETTERBOXD_BASELINE_IMPORT'],[worker,'FINDS_WATCHED_MARK']]){
 const uses=[...source.matchAll(new RegExp('env\\??\\.'+name+'([!=]==?)\'([a-z]+)\'','g'))];
 assert.ok(uses.length>0,name+' is read');
 for(const use of uses)assert.equal(use[2],'on',name+' compares the exact on');
}
for(const value of samples){const item=entry(reportOf({LETTERBOXD_FACTS:value}),'LETTERBOXD_FACTS');assert.equal(item.effective,value==='on'?'on':'off');}

// 6. Registry parity with the maintained reference and the governance checker.
const reference=fs.readFileSync('docs/reference/feature-flags.md','utf8');
const contract=reference.slice(reference.indexOf('## Configuration contract'),reference.indexOf('### Interactions'));
const documented=[...contract.matchAll(/^\| `([A-Z_]+)` \|/gm)].map(match=>match[1]);
const RETIRED=['SCORED_RESOLUTION','RATINGS_REFRESH','FINDS_TITLE_EXCLUSION'];
assert.deepEqual(documented,REGISTERED.filter(name=>!RETIRED.includes(name)),'every active registered flag is in the contract table, in order');
for(const name of RETIRED)assert.match(reference,new RegExp('`'+name+'`[^\\n]*retired'),name+' is documented as retired');
assert.match(reference,/`feature_flags`/,'the reference names the readout tool');
const checker=fs.readFileSync('scripts/check-documentation-governance.mjs','utf8');
for(const name of JSON.parse(checker.match(/const flagNames\s*=\s*(\[[^\]]*\])/)[1].replace(/'/g,'"')))assert.ok(REGISTERED.includes(name),'checker flag '+name+' is registered');
assert.match(fs.readFileSync('docs/reference/api/mcp.md','utf8'),/\| `feature_flags` \| no \|/);

// 7. Boundary: arguments refused, Access JWT required, works without a bucket binding.
const withArgs=await tool(guarded({}).env,'feature_flags',{name:'TMDB_API_READ_ACCESS_TOKEN'});
assert.equal(withArgs.body.result.isError,true);
assert.match(withArgs.body.result.content[0].text,/no arguments/);
assert.doesNotMatch(JSON.stringify(withArgs.body),new RegExp(SECRET));
assert.equal((await tool(guarded({}).env,'feature_flags',{},{assertion:null})).response.status,403,'behind the Access JWT');
const bare=await tool({MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD,PREDICTION_VERSION_OBJECTS:'on'},'feature_flags',{});
assert.equal(entry(bare.body.result.structuredContent,'PREDICTION_VERSION_OBJECTS').effective,'on','answers without a bucket binding');
assert.doesNotMatch(fs.readFileSync('src/feature-flags.js','utf8'),/Object\.(keys|entries|getOwnPropertyNames)\(env|for\s*\(\s*const\s+\w+\s+in\s+env/,'the readout never enumerates env');

console.log('Feature flags (ADR 0039): feature_flags lists the registered flags absent and set, literal values only for known tokens, shape-only reports for secrets, near misses, objects and over-long values, retired tokens and the retired switch, unmet requirements, effective modes equal to every consumer, registry parity with the reference and the checker, no storage, no env enumeration, arguments refused and the Access JWT required passed');
