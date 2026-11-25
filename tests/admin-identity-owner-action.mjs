// AIR-599 / ADR 0207 decision 4b: POST /api/admin/identity-work/owner-action, the owner `requeue` and `dismiss` of the shared Letterboxd check. Local vm only; the stores are fakes.
// Proves the gates run before anything is read or written: method, the Worker's own Origin, the action header, a JSON content type, an unconfigured verifier (503), the Access JWT verified IN the
// Worker against `ADMIN_ACCESS_AUD` (an `IPTV MCP` token, a rogue key, an expired token are refused) and the owner subject; then the body validation, the CAS refusal (409) and the readback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const TEAM='https://probe-team.cloudflareaccess.com',AUD='b2'.repeat(32),MCP_AUD='a1'.repeat(32),SITE='https://iptv.example';
const RSA={name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'};
const signing=await webcrypto.subtle.generateKey(RSA,true,['sign','verify']),rogue=await webcrypto.subtle.generateKey(RSA,true,['sign','verify']);
const publicJwk={...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'};
const fetch=async url=>{if(String(url)===TEAM+'/cdn-cgi/access/certs')return Response.json({keys:[publicJwk]});throw new Error('unexpected network '+url);};
const calls=[];
// The route plans the ledger rows, then commits the document AND those statements in one `ownerAction` call (the atomic cross-store write is proved on a real D1 in tests/letterboxd-owner-action-atomic.mjs).
const LetterboxdFacts={
 ownerAction:async(env,input)=>{calls.push(['action',input]);
  if(input.expectedVersion==='atomic-off'){throw Object.assign(new Error('x'),{code:'atomic_unavailable'});}
  if(input.expectedVersion==='full')return {state:'backlog_full',results:{a:'backlog_full'}};
  if(input.expectedVersion==='inflight')return {state:'check_in_flight',results:{},ids:['a']};
  if(input.expectedVersion!=='v1')return {state:'stale_revision',results:{}};
  return {state:'applied',results:Object.fromEntries(input.lids.map(l=>[l,'requeued'])),version:'v2',entries:Object.fromEntries(input.lids.map(l=>[l,input.createMissing?null:{attempts:0,reason:input.action==='dismiss'?'owner_dismissed':'owner_requeued'}])),backlog:Object.fromEntries(input.lids.map(l=>[l,input.createMissing&&input.action==='requeue'?{attempts:0}:null]))};},
};
const ledgerRows=new Map([['withEntry',{lid:'withEntry',state:'pending',attempts:0,lastReason:'owner_requeued'}]]);
const WatchlistD1={
 ownerAdmissionPlan:async(env,input)=>{calls.push(['plan',input]);if(env.ledgerClosed)return {ok:false,reason:'closed'};return {ok:true,statements:[['STMT',[]]],tokens:(input.rows||[]).map(r=>({lid:r.lid})),skipped:[]};},
 admissionRowsOf:async(env,lids)=>({ok:true,rows:lids.filter(l=>ledgerRows.has(l)).map(l=>ledgerRows.get(l))}),
};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const adminError=(code,status)=>json({error:code},status);
const context=vm.createContext({Response,Request,Headers,URL,Date,Map,Set,JSON,TextEncoder,TextDecoder,AbortSignal,atob,crypto:webcrypto,fetch,console,LetterboxdFacts,WatchlistD1,json,adminError,ISSUE_CODES:[]});
vm.runInContext(fs.readFileSync('src/mcp.js','utf8'),context);
vm.runInContext(fs.readFileSync('src/admin/identity-owner-action.js','utf8'),context);
const route=vm.runInContext('adminIdentityOwnerActionRoute',context);
const parse=vm.runInContext('identityOwnerRequest',context);

const encode=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
async function jwt({claims={},key=signing.privateKey}={}){
 const now=Math.floor(Date.now()/1000);
 const input=encode({alg:'RS256',kid:'kid-1',typ:'JWT'})+'.'+encode({aud:[AUD],email:'Owner@Example.test',exp:now+300,iat:now,iss:TEAM,sub:'owner-identity',...claims});
 return input+'.'+Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(input))).toString('base64url');
}
const env={MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:MCP_AUD,ADMIN_ACCESS_AUD:AUD,ADMIN_OWNER_EMAIL:'owner@example.test'};
const good=await jwt();
const body={action:'requeue',lane:'diary_identity',lids:['Leg1'],why:'transport exhausted',version:'v1'};
async function post(payload=body,{headers={},environment=env,token=good,method='POST'}={}){
 const request=new Request(SITE+'/api/admin/identity-work/owner-action',{method,headers:{Origin:SITE,'Content-Type':'application/json','X-IPTV-Admin-Action':'letterboxd_check_owner_action',...(token?{'Cf-Access-Jwt-Assertion':token}:{}),...headers},...(method==='POST'?{body:JSON.stringify(payload)}:{})});
 const response=await route(request,environment,new URL(request.url));
 return {status:response.status,body:await response.json()};
}
// gates, before any store is touched
assert.equal((await post(body,{method:'GET'})).status,405);
assert.deepEqual(await post(body,{headers:{Origin:'https://evil.example'}}),{status:403,body:{error:'origin_not_allowed'}});
assert.deepEqual(await post(body,{headers:{'X-IPTV-Admin-Action':'other'}}),{status:403,body:{error:'action_not_allowed'}});
assert.deepEqual(await post(body,{headers:{'Content-Type':'text/plain'}}),{status:415,body:{error:'content_type_not_json'}});
assert.deepEqual(await post(body,{environment:{...env,ADMIN_ACCESS_AUD:undefined}}),{status:503,body:{error:'owner_authorization_not_configured'}},'unconfigured is closed');
assert.deepEqual(await post(body,{environment:{...env,ADMIN_OWNER_EMAIL:''}}),{status:503,body:{error:'owner_authorization_not_configured'}});
assert.equal((await post(body,{token:null})).status,403,'no assertion');
assert.equal((await post(body,{token:await jwt({claims:{aud:[MCP_AUD]}})})).status,403,'a token of IPTV MCP is not a token of this application');
assert.equal((await post(body,{token:await jwt({key:rogue.privateKey})})).status,403,'a rogue signature');
assert.equal((await post(body,{token:await jwt({claims:{exp:Math.floor(Date.now()/1000)-3600}})})).status,403,'expired');
assert.deepEqual(await post(body,{token:await jwt({claims:{email:'someone@example.test'}})}),{status:403,body:{error:'not_owner'}},'another subject');
assert.equal(calls.length,0,'nothing was read or written by a refused request');
// body validation
for(const [bad,code] of [[{...body,action:'reset'},'invalid_action'],[{...body,lane:'film'},'invalid_lane'],[{...body,lids:[]},'invalid_lids'],[{...body,lids:Array.from({length:51},(_,i)=>'a'+i)},'invalid_lids'],[{...body,lids:['a','a']},'invalid_lids'],[{...body,why:''},'invalid_why'],[{action:'requeue',lane:'diary_identity',lids:['a'],why:'w'},'version_required'],[{action:'requeue',lane:'watchlist_admission',lids:['a'],why:'w',version:'v1'},'rows_required'],[{action:'requeue',lane:'watchlist_admission',lids:['a'],why:'w'},'version_required']])assert.equal(parse(bad).error,code,code);
assert.equal((await post({...body,action:'reset'})).status,400);
// the CAS, the atomic commit and the readback of BOTH stores
assert.deepEqual(await post({...body,version:'v0'}),{status:409,body:{error:'stale_revision'}});
let ok=await post();assert.equal(ok.status,200);assert.equal(ok.body.committed,true);assert.equal(ok.body.readback.version,'v2');
assert.equal(calls.at(-1)[1].by,'owner@example.test','the owner subject is recorded');assert.equal(calls.at(-1)[1].why,'transport exhausted');assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)[1].extra)),[['STMT',[]]],'the ledger statements ride in the same write');
assert.equal(ok.body.readback.proven,true,'both sides read back');
// the Watchlist lane: the row tokens go to the plan, the shared document version is the CAS
const rows=[{lid:'withEntry',state:'terminal',attempts:6,updatedAt:'t1'}];
const ledger=await post({action:'requeue',lane:'watchlist_admission',lids:['withEntry'],why:'w',rows,version:'v1'});
assert.equal(ledger.status,200);assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(c=>c[0]==='plan').at(-1)[1].rows)),rows);assert.equal(calls.at(-1)[1].createMissing,false);
// the report lane may create a backlog record for an id found nowhere; every lane commits the same document
const bk=await post({action:'requeue',lane:'diary_backlog',lids:['a'],why:'w',version:'v1'});assert.equal(bk.status,200);assert.equal(calls.at(-1)[1].createMissing,true);assert.equal(bk.body.readback.proven,true);
// a store that cannot batch refuses the whole request, a full backlog is a 409 with nothing committed, a closed ledger plans nothing
assert.deepEqual(await post({...body,version:'atomic-off'}),{status:503,body:{error:'atomic_unavailable'}});
const full=await post({...body,lane:'diary_backlog',version:'full'});assert.equal(full.status,409);assert.equal(full.body.committed,false);
const inflight=await post({...body,version:'inflight'});assert.deepEqual([inflight.status,inflight.body.error,inflight.body.committed,inflight.body.ids],[409,'check_in_flight',false,['a']],'an id with a check in flight refuses the whole action');
const before=calls.length;assert.deepEqual(await post(body,{environment:{...env,ledgerClosed:true}}),{status:503,body:{error:'ledger_closed'}});assert.equal(calls.length,before+1,'only the plan ran');
assert.match(fs.readFileSync('src/worker.js','utf8'),/url\.pathname==='\/api\/admin\/identity-work\/owner-action'\)return await adminIdentityOwnerActionRoute\(request,env,url\)/);
console.log('admin-identity-owner-action: ok');
