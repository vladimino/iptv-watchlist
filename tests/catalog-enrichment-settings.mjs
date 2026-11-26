// AIR-605: the authenticated control and readback routes of the Catalog Enrichment Producer (src/admin/settings.js; ADR 0211 decision 6 as amended by ADR 0219). Local vm only, on the real migrated schema through the sqlite3-CLI D1
// stand-in; the Access JWT is verified IN the Worker against `ADMIN_ACCESS_AUD`. Covered: the gates before anything is read or written (method, Origin, action header, JSON content type, an unconfigured verifier, a token of
// another audience, a rogue key, an expired token, not the owner), the pure GET, pause and resume as one compare-and-swap with an applied / rejected / uncertain readback, activation NOT reachable, and the owner retry with its
// own compare-and-swap on the rows the owner saw (no control revision change, epochs raised, no metadata written).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as Store from '../src/catalog-enrichment-store.js';

const TEAM='https://probe-team.cloudflareaccess.com',AUD='b2'.repeat(32),MCP_AUD='a1'.repeat(32),SITE='https://iptv.example';
const RSA={name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'};
const signing=await webcrypto.subtle.generateKey(RSA,true,['sign','verify']),rogue=await webcrypto.subtle.generateKey(RSA,true,['sign','verify']);
const publicJwk={...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'};
const fetch=async url=>{if(String(url)===TEAM+'/cdn-cgi/access/certs')return Response.json({keys:[publicJwk]});throw new Error('unexpected network '+url);};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const adminError=(code,status)=>json({error:code},status);
const kicks=[];
const context=vm.createContext({Response,Request,Headers,URL,Date,Map,Set,JSON,TextEncoder,TextDecoder,AbortSignal,atob,crypto:webcrypto,fetch,console,json,adminError,ISSUE_CODES:[],CatalogEnrichmentStore:Store,CatalogEnrichmentRunner:{kick:async()=>{kicks.push('kick');return {kicked:true};}}});
for(const file of ['src/mcp.js','src/admin/identity-owner-action.js','src/admin/settings.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
const route=vm.runInContext('adminSettingsRoute',context);

const encode=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
async function jwt({claims={},key=signing.privateKey}={}){
 const now=Math.floor(Date.now()/1000);
 const input=encode({alg:'RS256',kid:'kid-1',typ:'JWT'})+'.'+encode({aud:[AUD],email:'Owner@Example.test',exp:now+300,iat:now,iss:TEAM,sub:'owner-identity',...claims});
 return input+'.'+Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(input))).toString('base64url');
}
const good=await jwt();
const baseEnv=extra=>({MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:MCP_AUD,ADMIN_ACCESS_AUD:AUD,ADMIN_OWNER_EMAIL:'owner@example.test',...extra});
const T='2026-11-26T10:00:00.000Z';
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
function world(){const file=migrated();sql(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:a',2,NULL,'A','${T}');`);return {file,env:baseEnv({DB:d1Standin(file)})};}
const activate=file=>sql(file,`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;`);
async function call(env,path,{method='POST',payload,headers={},token=good,origin=SITE,type='application/json',action='catalog_enrichment_settings'}={}){
 const init={method,headers:{...(origin?{Origin:origin}:{}),...(type?{'Content-Type':type}:{}),...(action?{'X-IPTV-Admin-Action':action}:{}),...(token?{'Cf-Access-Jwt-Assertion':token}:{}),...headers}};
 if(payload!==undefined)init.body=typeof payload==='string'?payload:JSON.stringify(payload);
 const request=new Request(SITE+path,init);
 const response=await route(request,env,new URL(request.url));
 return {status:response.status,body:await response.json()};
}
const WRITE='/api/admin/settings/catalog-enrichment';
const req=over=>({action:'pause',expectedRevision:2,requestId:'req-00000001',...over});

// ---- the gates run before anything is read or written ----
{
 const {file,env}=world();activate(file);
 const before=rows(file,'SELECT * FROM catalog_enrichment_control');
 for(const [name,args,status,code] of [
  ['a GET on the write route',{method:'GET',payload:undefined},405,'method_not_allowed'],
  ['another origin',{origin:'https://evil.example',payload:req()},403,'origin_not_allowed'],
  ['no origin',{origin:null,payload:req()},403,'origin_not_allowed'],
  ['no action header',{action:null,payload:req()},403,'action_not_allowed'],
  ['another action header',{action:'letterboxd_check_owner_action',payload:req()},403,'action_not_allowed'],
  ['a form content type',{type:'text/plain',payload:req()},415,'content_type_not_json'],
  ['no token',{token:null,payload:req()},403,'forbidden'],
  ['a rogue key',{token:await jwt({key:rogue.privateKey}),payload:req()},403,'forbidden'],
  ['an expired token',{token:await jwt({claims:{exp:Math.floor(Date.now()/1000)-3600}}),payload:req()},403,'forbidden'],
  ['an IPTV MCP token (another audience)',{token:await jwt({claims:{aud:[MCP_AUD]}}),payload:req()},403,'forbidden'],
  ['a service token (no subject)',{token:await jwt({claims:{sub:''}}),payload:req()},403,'forbidden'],
  ['not the owner',{token:await jwt({claims:{email:'someone@example.test'}}),payload:req()},403,'not_owner'],
 ]){
  const r=await call(env,WRITE,args);
  assert.deepEqual([r.status,r.body.error],[status,code],name);
 }
 assert.equal((await call({...env,ADMIN_OWNER_EMAIL:''},WRITE,{payload:req()})).status,503,'an unconfigured owner is closed');
 assert.equal((await call({...env,ADMIN_ACCESS_AUD:''},WRITE,{payload:req()})).status,503,'an unconfigured audience is closed');
 assert.deepEqual(rows(file,'SELECT * FROM catalog_enrichment_control'),before,'no gate failure touched the control');
 assert.equal((await call(env,'/api/admin/settings/other',{payload:req()})).status,404);
}

// ---- body validation ----
{
 const {file,env}=world();activate(file);
 for(const [payload,code] of [
  ['not json','invalid_json'],[[1],'invalid_json'],
  [req({action:'activate'}),'invalid_action'],[req({action:'nope'}),'invalid_action'],
  [req({requestId:'x'}),'invalid_request_id'],[req({expectedRevision:-1}),'invalid_expected_revision'],[req({expectedRevision:'2'}),'invalid_expected_revision'],
  [req({extra:1}),'unknown_field'],
  [{action:'retry',requestId:'req-00000001',filmId:'nope',expectedRows:[]},'invalid_film'],
  [{action:'retry',requestId:'req-00000001',filmId:'film:a',part:'bogus',expectedRows:[]},'invalid_part'],
  [{action:'retry',requestId:'req-00000001',filmId:'film:a',expectedRows:[]},'invalid_expected_rows'],
 ]){
  const r=await call(env,WRITE,{payload});
  assert.equal(r.body.error,code,JSON.stringify(payload).slice(0,60));
 }
 assert.equal((await call(env,WRITE,{payload:req({action:'activate'})})).status,400,'activation is not reachable from this route');
 assert.equal(rows(file,'SELECT state FROM catalog_enrichment_control')[0].state,'active');
}

// ---- pause and resume: one compare-and-swap, a readback, applied / rejected / uncertain ----
{
 const {file,env}=world();activate(file);
 const paused=await call(env,WRITE,{payload:req()});
 assert.equal(paused.status,200);assert.deepEqual([paused.body.outcome,paused.body.control.state,paused.body.control.generation,paused.body.control.revision],['applied','paused',2,3]);
 const stale=await call(env,WRITE,{payload:req({action:'resume',expectedRevision:2})});
 assert.equal(stale.status,409);assert.deepEqual([stale.body.outcome,stale.body.control.state,stale.body.control.revision],['rejected','paused',3],'a stale revision changes nothing and says so, with the current state');
 const resumed=await call(env,WRITE,{payload:req({action:'resume',expectedRevision:3})});
 assert.deepEqual([resumed.status,resumed.body.outcome,resumed.body.control.state,resumed.body.control.generation],[200,'applied','active',3],'resume raises the generation');
 const again=await call(env,WRITE,{payload:req({action:'resume',expectedRevision:4})});
 assert.equal(again.status,409,'resume of an active control is rejected');
 // inactive: pause and resume never activate
 const inactive=world();
 assert.equal((await call(inactive.env,WRITE,{payload:req({action:'resume',expectedRevision:0})})).status,409,'resume never activates from inactive');
 assert.equal(rows(inactive.file,'SELECT COUNT(*) AS n FROM catalog_enrichment_control')[0].n,0);
 // an unreadable readback is uncertain, never a claim
 const fresh=world();activate(fresh.file);
 let reads=0;
 const flaky={...fresh.env,DB:{prepare:text=>{const real=fresh.env.DB.prepare(text);return {bind:(...p)=>{const s=real.bind(...p);return {...s,first:async()=>{if(/FROM catalog_enrichment_control/.test(text)&&++reads>1)throw new Error('down');return s.first();}};}};},batch:(...a)=>fresh.env.DB.batch(...a)}};
 const unknown=await call(flaky,WRITE,{payload:req()});
 assert.deepEqual([unknown.status,unknown.body.outcome],[503,'unknown'],'a failed readback answers 503 with outcome unknown');
 // a missing schema is closed
 const bare={...baseEnv({DB:d1Standin(migrated(45))})};
 assert.equal((await call(bare,WRITE,{payload:req({expectedRevision:0})})).body.error,'schema_missing');
}

// ---- the effective state: a pure read ----
{
 const bare=await call(baseEnv({DB:d1Standin(migrated(45))}),'/api/admin/settings',{method:'GET',payload:undefined,type:null,action:null,token:null});
 assert.deepEqual(bare.body,{configured:false,reason:'schema_missing',state:'inactive'},'an absent schema reads as inactive, no error');
 const {file,env}=world();
 const open=await call(env,'/api/admin/settings',{method:'GET',payload:undefined,type:null,action:null,token:null,origin:null});
 assert.equal(open.status,200);assert.equal(open.body.control.state,'inactive');assert.equal(open.body.attention.length,0);
 activate(file);
 sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'${T}');
  INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,due_since,updated_at,film_json) VALUES ('film:a','film','*',0,'identity_disagreement',NULL,'${T}','${T}','{"disagreement":{"reasons":["tmdb_differs"]},"fallbackFill":[{"field":"year"}],"unconfirmedAgreement":["year"]}');
  INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,failure_class,failure_signature,failures,due_since,updated_at) VALUES ('film:a','credits','tmdb',0,'deferred_repair','unreadable_credits','repairable','unreadable',6,'${T}','${T}');
  INSERT INTO catalog_enrichment_tick (tick_id,started_at,state,counts_json) VALUES ('run-1','${T}','started','{"films":2}');
  INSERT INTO enrichment_signal (kind,subject,state,version,armed_at) VALUES ('anchor_changed','film:a','pending',1,'${T}');
  INSERT INTO upstream_cooldown (scope,until_at,reason,retry_after_s,set_by,updated_at) VALUES ('tmdb',4102444800000,'rate_limited',120,'x',0);`);
 const active=await call(env,'/api/admin/settings',{method:'GET',payload:undefined,type:null,action:null,token:null,origin:null});
 assert.deepEqual([active.body.control.state,active.body.scopes[0].scope,active.body.lastRun.counts.films,active.body.signals.pending,active.body.draining,active.body.cooldowns[0].scope],['active','rated',2,1,null,'tmdb']);
 const list=active.body.attention;
 assert.deepEqual(list.map(item=>item.part+':'+item.status),['film:identity_disagreement','credits:deferred_repair'].sort((a,b)=>list.findIndex(x=>x.part+':'+x.status===a)-list.findIndex(x=>x.part+':'+x.status===b)));
 const film=list.find(item=>item.part==='film');
 assert.deepEqual([film.lists.fallbackFill.length,film.lists.unconfirmedAgreement,film.lists.disagreement.reasons],[1,['year'],['tmdb_differs']],'the lists kept for owner review, each with a retry action');
 assert.deepEqual(film.retry,{action:'retry',filmId:'film:a',part:undefined,source:undefined}.part===undefined?{action:'retry',filmId:'film:a'}:film.retry);
 // a pause with a run that has not been written as stopped: the drain is displayed
 sql(file,"UPDATE catalog_enrichment_control SET state='paused',generation=generation+1,revision=revision+1");
 assert.notEqual((await call(env,'/api/admin/settings',{method:'GET',payload:undefined,type:null,action:null,token:null,origin:null})).body.draining,null,'still draining after a pause');
 assert.equal((await call(env,'/api/admin/settings',{method:'POST',payload:{},token:null,type:null,action:null})).status,405,'the read route does not write');
 const writesBefore=rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_state')[0].n;
 await call(env,'/api/admin/settings',{method:'GET',payload:undefined,type:null,action:null,token:null,origin:null});
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_state')[0].n,writesBefore);
}

// ---- the owner retry: its own compare-and-swap on the rows the owner saw ----
{
 const {file,env}=world();activate(file);
 sql(file,`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,plan_epoch,due_since,updated_at) VALUES ('film:a','film','*',0,'identity_disagreement',NULL,3,'${T}','${T}');
  INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,refresh_epoch,failures,transport_streak,failure_class,retry_at,due_since,updated_at) VALUES ('film:a','core','letterboxd',0,'needs_attention','x',4,6,2,'repairable','2026-11-27T00:00:00.000Z','${T}','${T}'),('film:a','core','tmdb',0,'complete',NULL,0,0,0,NULL,NULL,'${T}','${T}'),('film:a','credits','tmdb',1,'deferred_repair','y',1,7,0,'repairable',NULL,'${T}','${T}');`);
 const control=()=>rows(file,'SELECT generation,revision FROM catalog_enrichment_control')[0];
 const control0=control();
 const retry=over=>({action:'retry',requestId:'req-00000002',filmId:'film:a',expectedRows:[{part:'core',source:'letterboxd',slot:0,status:'needs_attention',updatedAt:T}],...over});
 const stale=await call(env,WRITE,{payload:retry({expectedRows:[{part:'core',source:'letterboxd',slot:0,status:'needs_attention',updatedAt:'2026-11-26T09:00:00.000Z'}]})});
 assert.deepEqual([stale.status,stale.body.error,stale.body.outcome],[409,'stale_rows','rejected'],'stale expectedRows change nothing');
 assert.equal(rows(file,"SELECT status FROM catalog_enrichment_state WHERE part='core' AND source='letterboxd'")[0].status,'needs_attention');
 const missing=await call(env,WRITE,{payload:retry({filmId:'film:zzz'})});assert.equal(missing.status,409);
 const nothing=await call(env,WRITE,{payload:retry({expectedRows:[{part:'core',source:'tmdb',slot:0,status:'complete',updatedAt:T}]})});
 assert.equal(nothing.body.error,'nothing_to_retry','a complete part is not retried');
 const done=await call(env,WRITE,{payload:retry({part:'core',source:'letterboxd'})});
 assert.deepEqual([done.status,done.body.outcome],[200,'applied']);
 const row=rows(file,"SELECT status,reason,failures,transport_streak,failure_class,retry_at,refresh_epoch,due_since FROM catalog_enrichment_state WHERE part='core' AND source='letterboxd'")[0];
 assert.deepEqual(row,{status:'due',reason:null,failures:0,transport_streak:0,failure_class:null,retry_at:null,refresh_epoch:5,due_since:T},'reset to due, the epoch raised, due_since kept');
 assert.equal(rows(file,"SELECT plan_epoch FROM catalog_enrichment_state WHERE part='film'")[0].plan_epoch,4,'the Film plan epoch is raised: every batch of an older plan fails');
 assert.equal(rows(file,"SELECT status FROM catalog_enrichment_state WHERE part='core' AND source='tmdb'")[0].status,'complete','settled parts are untouched');
 assert.deepEqual(control(),control0,'a retry never changes the control revision, so it cannot race pause or resume');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_metadata')[0].n,0,'a retry writes no metadata');
 // a repeat with the same rows is stale: the owner saw the old token
 assert.equal((await call(env,WRITE,{payload:retry({part:'core',source:'letterboxd'})})).status,409);
 // the Film row: the disagreement is lifted and the anchors are checked again
 const seen=rows(file,"SELECT updated_at FROM catalog_enrichment_state WHERE part='film'")[0].updated_at;
 assert.notEqual(seen,T,'the part retry moved the Film row token, so an old token of that row is stale (the owner reloads)');
 assert.equal((await call(env,WRITE,{payload:retry({expectedRows:[{part:'film',source:'*',slot:0,status:'identity_disagreement',updatedAt:T}]})})).status,409);
 const lift=await call(env,WRITE,{payload:retry({expectedRows:[{part:'film',source:'*',slot:0,status:'identity_disagreement',updatedAt:seen}]})});
 assert.equal(lift.status,200);
 const filmRow=rows(file,"SELECT status,reason,plan_epoch FROM catalog_enrichment_state WHERE part='film'")[0];
 assert.deepEqual(filmRow,{status:'active',reason:'check_anchors',plan_epoch:5});
 // a retry racing the control: pause does not block it, and it does not move the control
 const paused=await call(env,WRITE,{payload:req({expectedRevision:control().revision})});assert.equal(paused.body.outcome,'applied');
 const chunk=await call(env,WRITE,{payload:retry({expectedRows:[{part:'credits',source:'tmdb',slot:1,status:'deferred_repair',updatedAt:T}]})});
 assert.equal(chunk.status,200);assert.equal(rows(file,"SELECT status FROM catalog_enrichment_state WHERE part='credits' AND slot=1")[0].status,'due','a credits chunk is retried by its own slot');
}
// ---- the wake after a successful owner action: a resume or a retry kicks the drainer, a pause or a refusal does not ----
{
 const {file,env}=world();activate(file);
 kicks.length=0;
 await call(env,WRITE,{payload:req()});
 assert.equal(kicks.length,0,'a pause wakes nothing');
 await call(env,WRITE,{payload:req({action:'resume',expectedRevision:2})});
 assert.equal(kicks.length,0,'a rejected resume (stale revision) wakes nothing');
 await call(env,WRITE,{payload:req({action:'resume',expectedRevision:3})});
 assert.equal(kicks.length,1,'an applied resume kicks the drainer once, after the commit');
 sql(file,`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at) VALUES ('film:a','credits','tmdb',0,'deferred_repair','${T}','${T}');`);
 await call(env,WRITE,{payload:{action:'retry',requestId:'req-00000009',filmId:'film:a',expectedRows:[{part:'credits',source:'tmdb',slot:0,status:'deferred_repair',updatedAt:T}]}});
 assert.equal(kicks.length,2,'an applied retry kicks the drainer');
 await call(env,WRITE,{payload:{action:'retry',requestId:'req-00000010',filmId:'film:a',expectedRows:[{part:'credits',source:'tmdb',slot:0,status:'deferred_repair',updatedAt:T}]}});
 assert.equal(kicks.length,2,'a refused (stale) retry wakes nothing');
 // a failing wake never changes the answer
 const quiet=vm.runInContext('CatalogEnrichmentRunner',context);const original=quiet.kick;quiet.kick=async()=>{throw new Error('workflow down');};
 const paused=await call(env,WRITE,{payload:req({expectedRevision:rows(file,'SELECT revision FROM catalog_enrichment_control')[0].revision})});
 const resumed=await call(env,WRITE,{payload:req({action:'resume',expectedRevision:rows(file,'SELECT revision FROM catalog_enrichment_control')[0].revision})});
 assert.deepEqual([paused.body.outcome,resumed.status,resumed.body.outcome],['applied',200,'applied'],'a wake that throws is swallowed: the owner action still answers applied');
 quiet.kick=original;
}
console.log('catalog enrichment settings: ok');
