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
 // AIR-633 (ADR 0214 decision 13): the provenance mode, revision, history, waiting upgrades and the per-field outcome totals, with honest coverage; counts only
 sql(file,`INSERT INTO catalog_enrichment_tick (tick_id,started_at,finished_at,state,counts_json) VALUES ('run-2','2026-11-26T08:00:00.000Z','2026-11-26T08:01:00.000Z','finished','{"films":1,"provenance":{"offered":4,"fills":3,"replacements":2,"history":2,"superseded_kept":1,"refusals":{"language_kept":1,"stored_differs":2}}}'),('run-3','2026-11-26T08:30:00.000Z','2026-11-26T08:31:00.000Z','finished','{"films":1,"provenance":{"replacements":1,"history":1,"refusals":{"language_kept":4}}}'),('run-4','2026-11-26T08:40:00.000Z','2026-11-26T08:41:00.000Z','finished','{"films":0}');
  INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_digest,cause_ref,armed_at,attempts) VALUES ('source_changed','film:a','','core',1,0,'pending','${'a'.repeat(64)}','language_upgrade','${T}',0);`);
 const prov=(await call(env,'/api/admin/settings',{method:'GET',payload:undefined,type:null,action:null,token:null,origin:null})).body.provenance;
 assert.deepEqual([prov.configured,prov.mode,prov.revision,prov.languageUpgradesWaiting,prov.outcomes.fills,prov.outcomes.replacements,prov.outcomes.history,prov.outcomes.offered,prov.outcomes.superseded_kept,prov.outcomes.refusals.language_kept,prov.outcomes.refusals.stored_differs],[true,'off',1,1,3,3,3,4,1,5,2],'the totals are sums of the outbox counts, the mode and revision are read, the waiting upgrades are the pending language signals');
 assert.deepEqual([prov.outcomes.coverage.finishedRunsSummed,prov.outcomes.coverage.runsWithCounts,prov.outcomes.coverage.olderRunsNotSummed],[3,2,false],'the aggregation says how many finished runs it summed, how many carried counts and whether older runs were left out');
 assert.deepEqual([prov.history.capped,prov.history.total],[false,0],'the history read is bounded and says whether it was capped');
 assert.ok(!JSON.stringify(prov).match(/film:|synopsis/),'counts only: no Film id and no field text');
 // a failed read is reported as unavailable, never as zero
 const broken=await call(baseEnv({DB:d1Standin(file,{rewrite:text=>/FROM catalog_enrichment_tick WHERE state IN/.test(text)?'SELECT * FROM no_such_table_x':text})}),'/api/admin/settings',{method:'GET',payload:undefined,type:null,action:null,token:null,origin:null});
 assert.equal(broken.body.provenance?.outcomes?.unavailable,true,'an unreadable outbox is "unavailable", not zeros');
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

// ---- the owner retry is ONE compare-and-swap for the whole request: a competing write between the first read and the batch ----
{
 const T1='2026-11-26T10:05:00.000Z';
 // a fresh world whose env runs `compete` once, after the route's own read and just before its batch
 const racing=(compete)=>{
  const file=migrated();
  sql(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:a',2,NULL,'A','${T}');`);
  activate(file);
  sql(file,`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,plan_epoch,due_since,updated_at) VALUES ('film:a','film','*',0,'active',3,'${T}','${T}');
   INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,refresh_epoch,failures,due_since,updated_at) VALUES ('film:a','core','tmdb',0,'needs_attention','x',4,6,'${T}','${T}'),('film:a','core','letterboxd',0,'deferred_repair','y',7,3,'${T}','${T}');`);
  let fired=false;
  const env=baseEnv({DB:d1Standin(file,{onBatch:async()=>{if(!fired){fired=true;compete(file);}}})});
  return {file,env};
 };
 const two=[{part:'core',source:'tmdb',slot:0,status:'needs_attention',updatedAt:T},{part:'core',source:'letterboxd',slot:0,status:'deferred_repair',updatedAt:T}];
 const state=file=>JSON.stringify(rows(file,"SELECT part,source,slot,status,refresh_epoch,plan_epoch,updated_at,failures FROM catalog_enrichment_state ORDER BY 1,2,3"));
 const payload={action:'retry',requestId:'req-0000cas1',filmId:'film:a',expectedRows:two};
 // 1. two targets, ONE of them moved by a competing tick: the whole request is refused, the other target does not reset and the Film epoch does not move
 {
  const {file,env}=racing(f=>sql(f,`UPDATE catalog_enrichment_state SET status='deferred_repair',failures=failures+1,updated_at='${T1}' WHERE part='core' AND source='tmdb'`));
  const before=state(file);
  const out=await call(env,WRITE,{payload});
  const after=JSON.parse(state(file));
  assert.deepEqual([out.status,out.body.error,out.body.outcome],[409,'stale_rows','rejected'],'a moved row refuses the whole request');
  const letter=after.find(row=>row.source==='letterboxd'),film=after.find(row=>row.part==='film'),moved=after.find(row=>row.source==='tmdb');
  assert.deepEqual([letter.status,letter.refresh_epoch,letter.failures,letter.updated_at],['deferred_repair',7,3,T],'the OTHER target was not reset by the refused request');
  assert.deepEqual([film.plan_epoch,film.updated_at],[3,T],'the Film epoch did not advance for a refused request');
  assert.deepEqual([moved.status,moved.updated_at],['deferred_repair',T1],'only the competing write changed anything');
  assert.ok(out.body.current.some(row=>row.source==='tmdb'&&row.updatedAt===T1),'the answer carries the current rows for the owner to reload');
  void before;
 }
 // 2. a single target moved after the first read
 {
  const {file,env}=racing(f=>sql(f,`UPDATE catalog_enrichment_state SET updated_at='${T1}' WHERE part='core' AND source='tmdb'`));
  const out=await call(env,WRITE,{payload:{...payload,requestId:'req-0000cas2',expectedRows:[two[0]]}});
  assert.deepEqual([out.status,out.body.outcome],[409,'rejected']);
  const after=JSON.parse(state(file));
  assert.deepEqual([after.find(row=>row.part==='film').plan_epoch,after.find(row=>row.source==='tmdb').refresh_epoch,after.find(row=>row.source==='tmdb').status],[3,4,'needs_attention'],'neither the target nor the Film epoch changed');
 }
 // 3. a competing write to a selected row that is NOT a target (the Film row the owner also saw): still the whole request
 {
  const {file,env}=racing(f=>sql(f,`UPDATE catalog_enrichment_state SET updated_at='${T1}' WHERE part='film'`));
  const out=await call(env,WRITE,{payload:{...payload,requestId:'req-0000cas3',expectedRows:[...two,{part:'film',source:'*',slot:0,status:'active',updatedAt:T}]}});
  assert.deepEqual([out.status,out.body.outcome],[409,'rejected']);
  assert.deepEqual(JSON.parse(state(file)).filter(row=>row.part==='core').map(row=>row.refresh_epoch),[7,4],'no target was reset');
 }
 // 4. no competitor: the request applies, both targets reset, the Film epoch rises exactly once, the commit is correlated to this request
 {
  const {file,env}=racing(()=>{});
  const out=await call(env,WRITE,{payload:{...payload,requestId:'req-0000cas4'}});
  assert.deepEqual([out.status,out.body.outcome],[200,'applied']);
  const after=JSON.parse(state(file));
  assert.deepEqual(after.filter(row=>row.part==='core').map(row=>[row.status,row.refresh_epoch]),[['due',8],['due',5]],'both targets reset');
  assert.equal(after.find(row=>row.part==='film').plan_epoch,4,'the Film epoch rose exactly once');
  const marker=rows(file,"SELECT json_extract(film_json,'$.ownerRetry') AS r FROM catalog_enrichment_state WHERE part='film'")[0].r;
  assert.match(marker,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,'the Film row records a unique server-side attempt token');
  assert.notEqual(marker,'req-0000cas4','and never the client request id, which may be reused');
  // the answer names only this request's rows
  assert.deepEqual(out.body.retried.map(row=>row.source).sort(),['letterboxd','tmdb']);
 }
 // 5. the readback is correlated: a lost answer is `applied` only when THIS request's marker is there, never because another request raised the epoch
 {
  const {file,env}=racing(()=>{});
  // the batch commits but the answer is lost: the route must see its own marker and say applied
  const lossy={...env,DB:new Proxy(env.DB,{get(target,prop){if(prop==='batch')return async list=>{await target.batch(list);throw new Error('network connection lost');};return target[prop];}})};
  const out=await call(lossy,WRITE,{payload:{...payload,requestId:'req-0000cas5'}});
  assert.deepEqual([out.status,out.body.outcome],[200,'applied'],'a commit whose answer was lost is proven by this request\'s own marker');
  // another request raised the Film epoch and the batch of THIS one never committed: not applied
  const other=racing(f=>sql(f,`UPDATE catalog_enrichment_state SET status='deferred_repair',updated_at='${T1}' WHERE part='core' AND source='tmdb';UPDATE catalog_enrichment_state SET plan_epoch=plan_epoch+1,updated_at='${T1}' WHERE part='film'`));
  const failing={...other.env,DB:new Proxy(other.env.DB,{get(target,prop){if(prop==='batch')return async list=>{try{await target.batch(list);}catch{/* the assertion refused it */}throw new Error('network connection lost');};return target[prop];}})};
  const refused=await call(failing,WRITE,{payload:{...payload,requestId:'req-0000cas6'}});
  assert.notEqual(refused.body.outcome,'applied','another request\'s epoch increase is never attributed to this one: '+JSON.stringify(refused.body.outcome));
  assert.deepEqual(JSON.parse(state(other.file)).filter(row=>row.source==='letterboxd').map(row=>[row.status,row.refresh_epoch]),[['deferred_repair',7]],'and the refused request reset nothing');
  void file;
 }
}

// ---- the D1 variable limit and the truthful commit classification of the owner retry ----
{
 const T1='2026-11-26T10:05:00.000Z';
 const build=(rowsCount,{maxBinds=null}={})=>{
  const file=migrated();
  sql(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:a',2,NULL,'A','${T}');`);
  activate(file);
  sql(file,`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,plan_epoch,due_since,updated_at) VALUES ('film:a','film','*',0,'active',3,'${T}','${T}');`+Array.from({length:rowsCount},(_,i)=>`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,refresh_epoch,due_since,updated_at) VALUES ('film:a','credits','tmdb',${i},'deferred_repair','y',2,'${T}','${T}');`).join(''));
  return file;
 };
 const slots=n=>Array.from({length:n},(_,i)=>({part:'credits',source:'tmdb',slot:i,status:'deferred_repair',updatedAt:T}));
 const withDb=(file,wrap,{maxBinds=null}={})=>{const base=d1Standin(file,maxBinds?{maxBinds}:{});return baseEnv({DB:wrap?wrap(base):base});};
 const stateOf=file=>rows(file,"SELECT part,slot,status,refresh_epoch,plan_epoch,updated_at FROM catalog_enrichment_state ORDER BY part,slot");

 // 1. the largest supported request (60 rows) against the D1 variable-limit stand-in: it applies, and a moved token late in the set refuses the whole request
 {
  const file=build(60);
  const env=withDb(file,null,{maxBinds:100});
  const out=await call(env,WRITE,{payload:{action:'retry',requestId:'req-0000lim1',filmId:'film:a',expectedRows:slots(60)}});
  assert.deepEqual([out.status,out.body.outcome],[200,'applied'],'60 selected rows pass the 100-variable limit: '+JSON.stringify(out.body));
  assert.equal(stateOf(file).filter(row=>row.part==='credits'&&row.status==='due'&&row.refresh_epoch===3).length,60,'every row was retried');
  // a token that moved late in the set (row 59) after the first read
  const file2=build(60);
  let fired=false;
  const env2=withDb(file2,base=>new Proxy(base,{get(target,prop){if(prop==='batch')return async list=>{if(!fired){fired=true;sql(file2,`UPDATE catalog_enrichment_state SET updated_at='${T1}' WHERE part='credits' AND slot=59`);}return target.batch(list);};return target[prop];}}),{maxBinds:100});
  const refused=await call(env2,WRITE,{payload:{action:'retry',requestId:'req-0000lim2',filmId:'film:a',expectedRows:slots(60)}});
  assert.deepEqual([refused.status,refused.body.outcome],[409,'rejected']);
  assert.equal(stateOf(file2).filter(row=>row.part==='credits'&&row.status==='deferred_repair'&&row.refresh_epoch===2).length,60,'not one of the 60 targets was reset');
  assert.equal(stateOf(file2).find(row=>row.part==='film').plan_epoch,3,'and the Film epoch did not move');
 }
 // 2. a competing write AFTER the batch committed and BEFORE the readback: the request is `applied` (the commit is known), whatever the rows say now
 {
  const file=build(2);
  const env=withDb(file,base=>new Proxy(base,{get(target,prop){if(prop==='batch')return async list=>{const r=await target.batch(list);sql(file,`UPDATE catalog_enrichment_state SET updated_at='${T1}',film_json='{"ownerRetry":"someone-else"}' WHERE part='film';UPDATE catalog_enrichment_state SET updated_at='${T1}',status='deferred_repair' WHERE part='credits'`);return r;};return target[prop];}}));
  const out=await call(env,WRITE,{payload:{action:'retry',requestId:'req-0000cmt1',filmId:'film:a',expectedRows:slots(2)}});
  assert.deepEqual([out.status,out.body.outcome],[200,'applied'],'a commit that is known stays applied after a later writer moved the rows: '+JSON.stringify(out.body));
  assert.ok(out.body.readback.some(row=>row.updatedAt===T1),'the readback shows the current (newer) state');
 }
 // 3. the batch's answer is LOST and the evidence has been overwritten: unknown, never rejected
 {
  const file=build(2);
  const env=withDb(file,base=>new Proxy(base,{get(target,prop){if(prop==='batch')return async list=>{await target.batch(list);sql(file,`UPDATE catalog_enrichment_state SET updated_at='${T1}',film_json='{"ownerRetry":"someone-else"}' WHERE part='film';UPDATE catalog_enrichment_state SET updated_at='${T1}',status='deferred_repair' WHERE part='credits'`);throw new Error('network connection lost');};return target[prop];}}));
  const out=await call(env,WRITE,{payload:{action:'retry',requestId:'req-0000cmt2',filmId:'film:a',expectedRows:slots(2)}});
  assert.equal(out.body.outcome,'unknown','a lost answer with overwritten evidence proves neither commit nor rollback: '+JSON.stringify(out.body));
  assert.equal(out.status,503);
 }
 // 4. the answer is lost and nothing shows a commit: unknown, never rejected (an ambiguous write can still settle later) and never applied
 {
  const file=build(2);
  const env=withDb(file,base=>new Proxy(base,{get(target,prop){if(prop==='batch')return async()=>{throw new Error('network connection lost');};return target[prop];}}));
  const out=await call(env,WRITE,{payload:{action:'retry',requestId:'req-0000cmt3',filmId:'film:a',expectedRows:slots(2)}});
  assert.deepEqual([out.status,out.body.outcome],[503,'unknown'],'rows as the owner saw them do not prove the write will never settle');
  assert.equal(stateOf(file).filter(row=>row.part==='credits'&&row.status==='deferred_repair').length,2,'and nothing was written');
 }
 // 4b. a REUSED request id never proves a commit: a first retry succeeds with id X, a second retry of different rows with the same X loses its answer before executing; the first request's marker must not be taken for the second's
 {
  const file=build(2);
  sql(file,`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,refresh_epoch,failures,due_since,updated_at) VALUES ('film:a','core','tmdb',0,'needs_attention','x',4,6,'${T}','${T}');`);
  const first=await call(withDb(file,null),WRITE,{payload:{action:'retry',requestId:'req-0000same',filmId:'film:a',part:'core',expectedRows:[{part:'core',source:'tmdb',slot:0,status:'needs_attention',updatedAt:T}]}});
  assert.deepEqual([first.status,first.body.outcome],[200,'applied']);
  const filmToken=rows(file,"SELECT json_extract(film_json,'$.ownerRetry') AS r,updated_at FROM catalog_enrichment_state WHERE part='film'")[0];
  const filmAfterFirst=rows(file,"SELECT updated_at FROM catalog_enrichment_state WHERE part='film'")[0].updated_at;
  const env=withDb(file,base=>new Proxy(base,{get(target,prop){if(prop==='batch')return async()=>{throw new Error('network connection lost');};return target[prop];}}));
  const second=await call(env,WRITE,{payload:{action:'retry',requestId:'req-0000same',filmId:'film:a',part:'credits',expectedRows:[{...slots(1)[0]}].map(row=>({...row}))}});
  assert.notEqual(second.body.outcome,'applied','a reused request id is never proof: '+JSON.stringify(second.body.outcome));
  assert.equal(second.body.outcome,'unknown');
  assert.equal(stateOf(file).filter(row=>row.part==='credits'&&row.status==='deferred_repair').length,2,'the credit rows were never written');
  void filmToken;void filmAfterFirst;
 }
 // 5. the answer is lost but this request's own marker is there (nothing moved afterwards): applied
 {
  const file=build(2);
  const env=withDb(file,base=>new Proxy(base,{get(target,prop){if(prop==='batch')return async list=>{await target.batch(list);throw new Error('network connection lost');};return target[prop];}}));
  const out=await call(env,WRITE,{payload:{action:'retry',requestId:'req-0000cmt4',filmId:'film:a',expectedRows:slots(2)}});
  assert.deepEqual([out.status,out.body.outcome],[200,'applied']);
 }
 // 6. the commit is known but the readback itself is unavailable: still applied
 {
  const file=build(2);
  let batched=false;
  const env=withDb(file,base=>new Proxy(base,{get(target,prop){
   if(prop==='batch')return async list=>{const r=await target.batch(list);batched=true;return r;};
   if(prop==='prepare')return sqlText=>{if(batched&&/FROM catalog_enrichment_state WHERE film_id=\?/.test(sqlText))throw new Error('read failed');return target.prepare(sqlText);};
   return target[prop];}}));
  const out=await call(env,WRITE,{payload:{action:'retry',requestId:'req-0000cmt5',filmId:'film:a',expectedRows:slots(2)}});
  assert.deepEqual([out.status,out.body.outcome,out.body.readback],[200,'applied',null],'a known commit is not downgraded by an unreadable readback');
 }
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
