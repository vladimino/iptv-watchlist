// AIR-675 / ADR 0217 decision 8b, review of PR #1043: the ACTUAL authenticated owner route `POST /api/admin/letterboxd/lid-recheck` and its REAL source check (`lidRecheckSource`), over the REAL page parser, the REAL accepted movie check
// (`LetterboxdDiaryIdentity.verifyPage` / `verify`, `tmdbCheckState`) and the REAL Letterboxd/TMDB fetch helpers, fed OFFLINE with the sanitized REAL captures of AIR-678 (`tests/fixtures/air-678-letterboxd-real-markup/`: Toy Soldiers is a valid
// TMDB-bearing movie control whose parser evidence has `shortCode: null, shortlinkPresent: false, canonicalPath: null`) and a synthetic agreeing TMDB document. No network, no production, no new page fetched; H1 is neither produced nor relaxed.
// The coordinator is a probe that runs the route's own `reacquire`, so what is asserted is exactly what the route would hand the coordinator. Gates (method, Origin, action header, media type, the Access JWT in the Worker, the owner subject, the body)
// are proved first, with the coordinator never reached.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import {attachRoot} from '../src/domain/letterboxd-attach-root.js';

const TEAM='https://probe-team.cloudflareaccess.com',AUD='b2'.repeat(32),MCP_AUD='a1'.repeat(32),SITE='https://iptv.example';
const RSA={name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'};
const signing=await webcrypto.subtle.generateKey(RSA,true,['sign','verify']);
const publicJwk={...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'};
const DIR='tests/fixtures/air-678-letterboxd-real-markup/';
const html=name=>fs.readFileSync(DIR+name+'.html','utf8');
const headersOf=map=>({get:key=>map[String(key).toLowerCase()]??null});
const http=(status,body,headers={})=>({status,ok:status<300,headers:headersOf(headers),async text(){return body;}});
// the offline "network": boxd.it redirects, one film page, one TMDB movie document; every request is recorded
const world={redirect:null,page:null,pageStatus:200,tmdb:null,tmdbStatus:200,calls:[]};
const fetchImpl=async url=>{
 url=String(url);world.calls.push(url);
 if(url===TEAM+'/cdn-cgi/access/certs')return Response.json({keys:[publicJwk]});
 const boxd=/^https:\/\/boxd\.it\/([A-Za-z0-9]+)$/.exec(url);
 if(boxd)return world.redirect?http(302,'',{location:world.redirect}):http(404,'');
 if(/^https:\/\/letterboxd\.com\/film\//.test(url))return http(world.pageStatus,world.page??'');
 if(/api\.themoviedb\.org\/3\/movie\//.test(url))return http(world.tmdbStatus,JSON.stringify(world.tmdb));
 if(/^https:\/\/letterboxd\.com\//.test(url))return http(404,'');
 throw new Error('unexpected network '+url);
};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const adminError=(code,status)=>json({error:code},status);
const probe={calls:[]};
const LetterboxdLidAttach={lidRecheck:async(env,input)=>{probe.calls.push(input);const source=await input.reacquire();return {outcome:'probe',terminal:true,source};}};
const LetterboxdFacts={linkAttachedPair:async()=>({state:'linked'})};
const context=vm.createContext({Response,Request,Headers,URL,Date,Map,Set,JSON,Object,Number,Promise,TextEncoder,TextDecoder,Uint8Array,AbortSignal,atob,crypto:webcrypto,structuredClone,setTimeout,clearTimeout,fetch:fetchImpl,console:{...console,log:()=>{}},json,adminError,ISSUE_CODES:[],LetterboxdLidAttach,LetterboxdFacts});
vm.runInContext(fs.readFileSync('src/mcp.js','utf8'),context);
for(const file of ['src/domain/tmdb-tv-identity.js','src/sources.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace(/^export default/m,'globalThis.x='),context);
vm.runInContext(scoped('src/letterboxd-match.js','LetterboxdMatch')+'\n'+scopedReplacing('src/letterboxd-identity.js','LetterboxdIdentity','const normTitle=LetterboxdMatch.normTitle;\n')+'\n'+scoped('src/domain/letterboxd-rated-admission.js','LetterboxdRatedAdmission')+'\n'+scoped('src/domain/letterboxd-import-registry.js','LetterboxdImportRegistry'),context);
for(const file of ['src/letterboxd-rated-candidates.js','src/letterboxd-diary-identity.js','src/admin/identity-owner-action.js','src/admin/lid-recheck.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
const route=vm.runInContext('adminLidRecheckRoute',context);
const encode=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
async function jwt({claims={}}={}){
 const now=Math.floor(Date.now()/1000);
 const input=encode({alg:'RS256',kid:'kid-1',typ:'JWT'})+'.'+encode({aud:[AUD],email:'Owner@Example.test',exp:now+300,iat:now,iss:TEAM,sub:'owner-identity',...claims});
 return input+'.'+Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',signing.privateKey,new TextEncoder().encode(input))).toString('base64url');
}
const env={MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:MCP_AUD,ADMIN_ACCESS_AUD:AUD,ADMIN_OWNER_EMAIL:'owner@example.test',TMDB_API_READ_ACCESS_TOKEN:'fixture-token'};
const good=await jwt();
async function post(payload,{headers={},environment=env,token=good,method='POST'}={}){
 const request=new Request(SITE+'/api/admin/letterboxd/lid-recheck',{method,headers:{Origin:SITE,'Content-Type':'application/json','X-IPTV-Admin-Action':'letterboxd_lid_recheck',...(token?{'Cf-Access-Jwt-Assertion':token}:{}),...headers},...(method==='POST'?{body:typeof payload==='string'?payload:JSON.stringify(payload)}:{})});
 const response=await route(request,environment,new URL(request.url));
 return {status:response.status,body:await response.json()};
}

// ===== the gates, before the coordinator and before any source request =====
const body={lid:'1Vuo',requestId:'req-1'};
assert.equal((await post(body,{method:'GET'})).status,405);
assert.deepEqual(await post(body,{headers:{Origin:'https://evil.example'}}),{status:403,body:{error:'origin_not_allowed'}});
assert.deepEqual(await post(body,{headers:{'X-IPTV-Admin-Action':'letterboxd_check_owner_action'}}),{status:403,body:{error:'action_not_allowed'}});
assert.deepEqual(await post(body,{headers:{'Content-Type':'text/plain'}}),{status:415,body:{error:'content_type_not_json'}});
assert.deepEqual(await post(body,{environment:{...env,ADMIN_ACCESS_AUD:undefined}}),{status:503,body:{error:'owner_authorization_not_configured'}});
assert.equal((await post(body,{token:null})).status,403,'no Access assertion');
assert.equal((await post(body,{token:await jwt({claims:{aud:[MCP_AUD]}})})).status,403,'a token of IPTV MCP is not a token of this application');
assert.equal((await post(body,{token:await jwt({claims:{exp:Math.floor(Date.now()/1000)-3600}})})).status,403,'expired');
assert.deepEqual(await post(body,{token:await jwt({claims:{email:'someone@example.test'}})}),{status:403,body:{error:'not_owner'}});
for(const [bad,code] of [['not json','invalid_json'],[{lid:'1Vuo'},'invalid_body'],[{...body,extra:1},'invalid_body'],[{...body,lid:'a b'},'invalid_lid'],[{...body,requestId:'bad id'},'invalid_request_id'],[{...body,lid:7},'invalid_lid']])
 assert.deepEqual(await post(bad),{status:400,body:{error:code}},code);
assert.equal(probe.calls.length,0,'the coordinator was never reached by a refused request');
assert.equal(world.calls.filter(url=>!/cdn-cgi/.test(url)).length,0,'and no source request was made');

// ===== the real movie control through the authenticated route =====
const toy=()=>{
 world.redirect='https://letterboxd.com/film/toy-soldiers/';world.page=html('movie-with-tmdb-id');world.pageStatus=200;world.tmdbStatus=200;
 world.tmdb={id:10750,title:'Toy Soldiers',original_title:'Toy Soldiers',release_date:'1991-04-26'};world.calls.length=0;
};
const source=async(lid='1Vuo')=>{const answer=await post({lid,requestId:'req-1'});assert.equal(answer.status,200,JSON.stringify(answer));assert.equal(answer.body.by,'owner@example.test','the owner subject');return answer.body.source;};
{
 toy();
 const out=await source();
 assert.deepEqual([out.ok,out.state],[true,'tmdb_movie'],JSON.stringify(out));
 assert.deepEqual([out.proof.slug,out.proof.path,out.proof.finalUrl,out.proof.tmdb,out.proof.title,out.proof.year],['toy-soldiers','/film/toy-soldiers/','https://letterboxd.com/film/toy-soldiers/','10750','Toy Soldiers',1991],'identity read from the redirect landing; the missing shortlink and canonical tags refuse nothing');
 const root=await attachRoot({lid:'1Vuo',slug:out.proof.slug,path:out.proof.path,tmdb:out.proof.tmdb,title:out.proof.title,year:out.proof.year,finalUrl:out.proof.finalUrl,detail:out.proof.detail});
 assert.match(root.root,/^[0-9a-f]{64}$/,'the proof makes the common attach root');
 assert.equal(probe.calls.at(-1).lid,'1Vuo');assert.equal(probe.calls.at(-1).requestId,'req-1');
 assert.deepEqual(world.calls,['https://boxd.it/1Vuo','https://letterboxd.com/film/toy-soldiers/','https://api.themoviedb.org/3/movie/10750?language=en-US'],'exactly the bounded redirect, page and movie document; nothing else is fetched');
}
// ===== a PRESENT contradiction still refuses (the accepted rules), a missing tag does not =====
{
 toy();world.page=html('movie-with-tmdb-id').replace('</head>','<link rel="shortlink" href="https://boxd.it/ZZZZ"></head>');
 const out=await source();assert.deepEqual([out.state,out.reason],['page_refused','shortlink_mismatch'],JSON.stringify(out));
 assert.equal(world.calls.some(url=>/themoviedb/.test(url)),false,'TMDB is not asked after a contradictory page');
 toy();world.page=html('movie-with-tmdb-id').replace('</head>','<link rel="canonical" href="https://letterboxd.com/film/another-film/"></head>');
 const canonical=await source();assert.deepEqual([canonical.state,canonical.reason],['page_refused','canonical_mismatch'],JSON.stringify(canonical));
 toy();world.page=html('movie-with-tmdb-id').replace('</head>','<link rel="shortlink" href="https://boxd.it/1Vuo"></head>');
 assert.equal((await source()).state,'tmdb_movie','a present, agreeing shortlink is accepted too');
}
// ===== the redirect binding =====
{
 toy();world.redirect='https://evil.example/film/toy-soldiers/';
 const out=await source();assert.equal(out.state,'page_not_read',JSON.stringify(out));assert.equal(world.calls.some(url=>/evil|letterboxd\.com\/film/.test(url)),false,'a redirect off Letterboxd is never followed');
 toy();world.redirect='https://letterboxd.com/some/other/path/';
 const landing=await source();assert.ok(['page_not_read','page_refused'].includes(landing.state),JSON.stringify(landing));assert.equal(landing.state==='tmdb_movie',false);
 toy();world.redirect=null;
 assert.equal((await source()).state,'page_not_read','an unknown lid (404) is not read');
}
// ===== mismatches, TV and transport fail appropriately =====
{
 toy();world.tmdb={...world.tmdb,title:'A Different Film',original_title:'Another Original'};
 let out=await source();assert.equal(out.state,'tmdb_disagrees',JSON.stringify(out));
 toy();world.tmdb={...world.tmdb,release_date:'1975-04-26'};
 out=await source();assert.equal(out.state,'tmdb_disagrees','a year more than one off disagrees');
 toy();world.tmdb={...world.tmdb,id:99};
 out=await source();assert.equal(out.state,'tmdb_disagrees','a document of another movie id disagrees');
 toy();world.tmdb={...world.tmdb,media_type:'tv'};
 out=await source();assert.equal(out.state,'tmdb_tv',JSON.stringify(out));
 toy();world.tmdbStatus=404;
 out=await source();assert.equal(out.state,'tmdb_missing',JSON.stringify(out));
 toy();world.tmdbStatus=503;
 out=await source();assert.deepEqual([out.ok,out.state],[true,'tmdb_unavailable'],'a TMDB 5xx is transport: non-terminal, no attempt');
 toy();world.pageStatus=429;
 out=await source();assert.deepEqual([out.ok,out.state],[true,'tmdb_unavailable'],'a rate-limited page is transport too: '+JSON.stringify(out));
 // a real TV page is never a movie: the TMDB relation of the page is not a movie id
 for(const [name,lid,slug] of [['tv-empty-body-id','xo7A','the-beatles-get-back'],['tv-zero-empty-body-id','hN9O','twin-peaks-the-return']]){
  toy();world.redirect='https://letterboxd.com/film/'+slug+'/';world.page=html(name);
  out=await source(lid);assert.ok(['tmdb_unreadable','tmdb_tv'].includes(out.state),name+': '+JSON.stringify(out));
  assert.equal(world.calls.some(url=>/themoviedb/.test(url)),false,name+': TMDB is not asked for a page without a movie id');
 }
}
console.log('Owner re-check route (AIR-675: gates, real movie control, accepted verified movie check, typed refusals) passed.');
