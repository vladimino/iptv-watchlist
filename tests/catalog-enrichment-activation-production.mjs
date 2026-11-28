// AIR-607 (C2): the thin production operator of the rated-scope activation (scripts/catalog-enrichment-activation-production.mjs). Offline only: a sqlite D1 stand-in over the real migration chain, and for the production
// composition a mocked D1 REST fetch over a sqlite file (the strict adapter, the rendered atomic batches, response loss). No production database, no network, no credential.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as Op from '../scripts/catalog-enrichment-activation-production.mjs';
import {PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID} from '../scripts/published-epg-production.mjs';

const AT='2026-11-28T10:00:00.000Z',NOW=Date.parse(AT);
const OLD='2026-10-01T00:00:00.000Z',CUTOFF='2026-11-01T00:00:00.000Z',NEW='2026-11-10T00:00:00.000Z';
const GO='https://trello.com/c/Daq02gYy#comment-owner-go';
const SHA=Op.operatorSha256();
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=String(r.stdout).trim();return o?JSON.parse(o):[];};
const pad=n=>String(n).padStart(4,'0');
const admission=(i,verified)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:r${pad(i)}',2,NULL,'R','${AT}');INSERT INTO film_external_id VALUES ('film:r${pad(i)}','tmdb','${1000+i}',1,0,NULL);INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:r${pad(i)}','${1000+i}','code${i}','${'a'.repeat(64)}','T',2000,'k','tmdb_${1000+i}','${verified}','q','${AT}');`;
// 130 rated admissions: 30 before the cutoff, 100 at or after it
function world({open=true,held=false}={}){
 const file=migrated();
 if(open)sql(file,OPEN);
 if(held)sql(file,"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1;");
 sql(file,Array.from({length:30},(_,i)=>admission(i,OLD)).join('')+Array.from({length:100},(_,i)=>admission(30+i,NEW)).join(''));
 sql(file,'DELETE FROM enrichment_signal;');
 return {file,db:d1Standin(file)};
}
const A=(...a)=>['node','x',...a];
const act=(over={})=>({cutoff:CUTOFF,by:'operator:AIR-607',go:GO,operatorSha256:SHA,...over});
const stopped=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason,String(error.reason));return error;}assert.fail('expected '+reason);};
const controlRow=file=>rows(file,'SELECT state,generation,revision,updated_by FROM catalog_enrichment_control')[0]||null;
const snapshot=file=>JSON.stringify([rows(file,'SELECT * FROM catalog_enrichment_scope'),rows(file,'SELECT * FROM catalog_enrichment_control'),rows(file,'SELECT subject,state,version FROM enrichment_signal ORDER BY subject')]);

// ===== 1. arguments =====
{
 const full=['--activate','--target','iptv','--cutoff',CUTOFF,'--by','operator:AIR-607','--go',GO,'--confirm','activate','--operator-sha256',SHA];
 const without=(...names)=>{const out=[...full];for(const n of names){const i=out.indexOf(n);out.splice(i,2);}return out;};
 assert.deepEqual(Op.parseArgs(A()).report,{configured:false,writes:false,writeState:'none'});
 assert.throws(()=>Op.parseArgs(A('--activate')),e=>e.reason==='target_required');
 assert.throws(()=>Op.parseArgs(A('--status','--target','other')),e=>e.reason==='target_invalid');
 assert.throws(()=>Op.parseArgs(A(...without('--confirm'))),e=>e.reason==='confirm');
 assert.throws(()=>Op.parseArgs(A(...full.map(x=>x==='activate'?'status':x))),e=>e.reason==='confirm','the confirmation word is exact');
 assert.throws(()=>Op.parseArgs(A(...without('--cutoff'))),e=>e.reason==='cutoff_required','the cutoff is never defaulted');
 for(const bad of ['2026-11-01','2026-13-45T00:00:00.000Z','2026-02-31T00:00:00.000Z','now','2026-11-01T00:00:00Z'])assert.throws(()=>Op.parseArgs(A(...full.map(x=>x===CUTOFF?bad:x))),e=>e.reason==='cutoff_invalid',bad);
 assert.throws(()=>Op.parseArgs(A('--status','--target','iptv','--cutoff','2026-13-45T00:00:00.000Z')),e=>e.reason==='cutoff_invalid');
 assert.throws(()=>Op.parseArgs(A(...without('--go'))),e=>e.reason==='go_reference_required');
 assert.throws(()=>Op.parseArgs(A(...full.map(x=>x===GO?'owner said yes':x))),e=>e.reason==='go_reference_required');
 assert.throws(()=>Op.parseArgs(A(...full.map(x=>x===GO?'http://trello.com/c/Daq02gYy#x':x))),e=>e.reason==='go_reference_required','HTTPS only');
 assert.throws(()=>Op.parseArgs(A(...without('--by'))),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A(...full.map(x=>x==='operator:AIR-607'?'op erator':x))),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A(...full.map(x=>x===SHA?'abc':x))),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A(...full,'--cutoff',CUTOFF)),e=>e.reason==='usage','no repeated option');
 assert.throws(()=>Op.parseArgs(A(...full,'--mode','x')),e=>e.reason==='usage','no unknown option');
 assert.throws(()=>Op.parseArgs(A('--status','--activate',...full.slice(1))),e=>e.reason==='usage','one command only');
 assert.throws(()=>Op.parseArgs(A('--status','--target','iptv','--go',GO)),e=>e.reason==='usage','status takes only the target and an optional cutoff');
 assert.deepEqual(Op.parseArgs(A(...full)),{command:'activate',params:{cutoff:CUTOFF,by:'operator:AIR-607',go:GO,operatorSha256:SHA}});
 assert.deepEqual(Op.parseArgs(A('--target','iptv')),{command:'status',params:{cutoff:null}});
 assert.deepEqual(Op.parseArgs(A('--status','--target','iptv','--cutoff',CUTOFF)).params,{cutoff:CUTOFF});
 const r=spawnSync(process.execPath,['scripts/catalog-enrichment-activation-production.mjs'],{encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(r.status,0);
 assert.deepEqual(JSON.parse(r.stdout),{configured:false,writes:false,writeState:'none'});
 // without credentials a configured run stops before any request
 const noCreds=spawnSync(process.execPath,['scripts/catalog-enrichment-activation-production.mjs','--status','--target','iptv'],{encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(noCreds.status,2);assert.equal(JSON.parse(noCreds.stdout).reason,'configuration');
}

// ===== 2. the pinned digest covers the bytes that run =====
{
 const files=Op.fileDigests();
 assert.deepEqual(files.map(f=>f.file),['scripts/catalog-enrichment-activation-production.mjs','src/catalog-enrichment-activation.js','src/catalog-enrichment-bootstrap.js']);
 assert.ok(files.every(f=>/^[0-9a-f]{64}$/.test(f.sha256)));
 assert.match(SHA,/^[0-9a-f]{64}$/);
}

// ===== 3. status is strictly read-only and decides =====
{
 const {file,db}=world();
 const writes=[];
 const spy={prepare:s=>db.prepare(s),batch:async b=>{writes.push(b);return db.batch(b);}};
 const status=await Op.execute('status',{binding:spy,now:NOW,params:{cutoff:CUTOFF}});
 assert.equal(writes.length,0);assert.deepEqual([status.writes,status.writeState,status.decision],[false,'none','ready']);
 assert.equal(status.operatorSha256,SHA);assert.equal(status.files.length,3);assert.deepEqual(status.problems,[]);
 assert.deepEqual([status.facts.schemaVersion>=54,status.facts.filmPersonMarker.state,status.facts.control.state],[true,'open','inactive']);
 assert.equal(status.control.state,'inactive');assert.deepEqual(status.scopes,[]);
 assert.equal(JSON.stringify(status).includes('SECRET'),false);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_scope')[0].n,0,'status writes nothing');
 // without a cutoff the verdict still reads; a held marker is a blocker with its real state
 const held=world({held:true});
 const blocked=await Op.execute('status',{binding:held.db,now:NOW,params:{cutoff:CUTOFF}});
 assert.deepEqual([blocked.decision,blocked.problems],['blocked',['film_person_marker_not_open']]);
 assert.deepEqual(blocked.facts.filmPersonMarker,{state:'held',generation:3});
}

// ===== 4. activate through an injected binding: digest, inputs, exactly the module's writes, readback =====
{
 const {file,db}=world();
 const batches=[];
 const spy={prepare:s=>db.prepare(s),batch:async b=>{batches.push(b.map(x=>x.text));return db.batch(b);}};
 const run=(params,now=NOW)=>Op.execute('activate',{binding:spy,now,ctx:{track(){}},params});
 await stopped(run(act({operatorSha256:'0'.repeat(64)})),'operator_digest_mismatch');
 assert.equal(batches.length,0,'a digest mismatch happens before any read or write');
 const future=await run(act({cutoff:'2026-11-29T00:00:00.000Z'}));
 assert.deepEqual([future.outcome,future.problems],['refused',['cutoff_in_future']]);
 const badGo=await run(act({go:'owner said yes'}));
 assert.deepEqual([badGo.outcome,badGo.problems],['refused',['go_reference_missing']]);
 assert.equal(batches.length,0,'every refusal happens before a write');assert.equal(controlRow(file),null);
 const out=await run(act());
 assert.deepEqual([out.outcome,out.cutoffAt,out.onlyRatedScope,out.control.state],['activated',CUTOFF,true,'active']);
 assert.equal(out.control.updatedBy,'operator:AIR-607 go:'+GO);
 assert.deepEqual([out.qualifyingAdmissions,out.ratedSignals],[100,100]);
 assert.deepEqual(out.wake,{outcome:'deferred',reason:'no_workflow_binding'},'the REST binding has no Workflow: the reconcile starts the work');
 // exactly the module's writes, nothing else, each a single atomic batch
 const allowed=[/^INSERT INTO catalog_enrichment_scope /,/^INSERT INTO enrichment_signal /,/^UPDATE catalog_enrichment_scope SET bootstrap_cursor/,/^INSERT INTO catalog_enrichment_control /,/^UPDATE catalog_enrichment_control SET state='active'/];
 for(const batch of batches)for(const text of batch)assert.ok(allowed.some(re=>re.test(text)),'unexpected statement: '+text.slice(0,80));
 assert.equal(batches[0].length,1,'the scope insert is one statement in one batch');
 assert.equal(batches.length,1+3+1,'scope insert, three bootstrap pages (50, 50, 0 rows) and the control commit');
 assert.equal(batches.at(-1).length,2,'the absent control row is initialized in the same batch as the activation');
 assert.deepEqual(rows(file,'SELECT scope FROM catalog_enrichment_scope'),[{scope:'rated'}]);
 // a repeated call is a noop and writes nothing
 const before=batches.length,snap=snapshot(file);
 const again=await run(act());
 assert.deepEqual([again.outcome,again.reason],['noop','already_active']);
 assert.equal(batches.length,before);assert.equal(snapshot(file),snap);
 // another cutoff over an active configuration is refused and writes nothing
 const other=await run(act({cutoff:OLD}));
 assert.deepEqual([other.outcome,other.problems],['refused',['active_configuration_mismatch']]);assert.equal(snapshot(file),snap);
 // status reads it as active
 assert.equal((await Op.execute('status',{binding:spy,now:NOW,params:{cutoff:CUTOFF}})).decision,'already_active');
}
{
 // exit codes and DOMAIN write states of the outcomes (never a refusal or a partial stop as success; delivery telemetry is separate)
 assert.deepEqual(Op.judge({outcome:'activated'}),{exit:0,writeState:'committed',writes:true});
 assert.deepEqual(Op.judge({outcome:'noop'}),{exit:0,writeState:'none',writes:false});
 assert.deepEqual(Op.judge({outcome:'refused',effects:{scopeInserted:false,bootstrapRows:0,bootstrapPages:0}}),{exit:3,writeState:'none',writes:false});
 assert.deepEqual(Op.judge({outcome:'uncertain',effects:{scopeInserted:true,bootstrapRows:100,bootstrapPages:3}}),{exit:3,writeState:'unknown',writes:null});
 assert.deepEqual(Op.judge({outcome:'stopped',effects:{scopeInserted:true,bootstrapRows:0,bootstrapPages:0}}),{exit:3,writeState:'partial',writes:true,partial:true});
 assert.deepEqual(Op.judge({outcome:'stopped',effects:{scopeInserted:false,bootstrapRows:60,bootstrapPages:2}}),{exit:3,writeState:'partial',writes:true,partial:true});
 assert.deepEqual(Op.judge({outcome:'stopped',effects:{scopeInserted:false,bootstrapRows:0,bootstrapPages:0}}),{exit:3,writeState:'none',writes:false},'a resume that wrote nothing new');
 assert.deepEqual(Op.judge({outcome:'stopped',effects:{scopeInserted:'unknown',bootstrapRows:0,bootstrapPages:0}}),{exit:3,writeState:'unknown',writes:null});
 assert.deepEqual(Op.judge({outcome:'stopped',effects:{scopeInserted:false,bootstrapRows:0,bootstrapPages:1}}),{exit:3,writeState:'partial',writes:true,partial:true},'a zero-row page that changed the bootstrap state is a domain write');
 const {db}=world({held:true});
 const run=await Op.runCatalogEnrichmentActivationProduction({argv:A('--activate','--target','iptv','--cutoff',CUTOFF,'--by','operator:AIR-607','--go',GO,'--confirm','activate','--operator-sha256',SHA),now:()=>NOW,deps:{binding:db}});
 assert.equal(run.exit,3);assert.equal(run.result.outcome,'refused');assert.equal(run.result.writeState,'none');assert.equal(run.result.writes,false);assert.equal(run.result.retry,false);assert.deepEqual(run.result.problems,['film_person_marker_not_open']);
}

// ===== 4b. status: inspection is not readiness; an exact cutoff is judged by the activation's own rules; a changed or unreadable state is never ready =====
{
 const {file,db}=world();
 const ins=await Op.execute('status',{binding:db,now:NOW,params:{cutoff:null}});
 assert.deepEqual([ins.mode,ins.decision],['inspection','inspection'],'no cutoff supplied: an observation that claims no readiness');
 const exact=await Op.execute('status',{binding:db,now:NOW,params:{cutoff:CUTOFF}});
 assert.deepEqual([exact.mode,exact.decision],['exact_cutoff','ready']);
 const future=await Op.execute('status',{binding:db,now:NOW,params:{cutoff:'2026-11-29T00:00:00.000Z'}});
 assert.deepEqual([future.decision,future.problems],['blocked',['cutoff_in_future']],'a future cutoff is never ready');
 // an interrupted activation of the same cutoff resumes; another cutoff is blocked with its reason
 await Op.execute('activate',{binding:db,now:NOW,ctx:{track(){}},params:act({})}).catch(()=>{});
 const active=await Op.execute('status',{binding:db,now:NOW,params:{cutoff:CUTOFF}});
 assert.deepEqual([active.decision,active.problems],['already_active',[]]);
 const wrong=await Op.execute('status',{binding:db,now:NOW,params:{cutoff:OLD}});
 assert.deepEqual([wrong.decision,wrong.problems,wrong.reasons],['blocked',['active_configuration_mismatch'],['scope_cutoff_mismatch']],'a different cutoff over an active control is blocked, never already_active');
 const activeInspection=await Op.execute('status',{binding:db,now:NOW,params:{cutoff:null}});
 assert.deepEqual([activeInspection.decision,activeInspection.reasons],['inspection',[]]);
 sql(file,"UPDATE catalog_enrichment_scope SET enabled=0,revision=revision+1 WHERE scope='rated'");
 const disabled=await Op.execute('status',{binding:db,now:NOW,params:{cutoff:CUTOFF}});
 assert.deepEqual([disabled.decision,disabled.problems,disabled.reasons],['blocked',['active_configuration_mismatch'],['scope_not_enabled']],'a disabled scope over an active control is blocked');
 sql(file,"UPDATE catalog_enrichment_scope SET enabled=1,revision=revision+1 WHERE scope='rated'");
 sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('discovery',1,1,NULL,1,'${AT}')`);
 const another=await Op.execute('status',{binding:db,now:NOW,params:{cutoff:CUTOFF}});
 assert.deepEqual([another.decision,another.reasons],['blocked',['other_scope_present']],'another scope over an active control is blocked');
 sql(file,"UPDATE catalog_enrichment_scope SET enabled=0,revision=revision+1 WHERE scope='rated'");
 // the same verdict as the activation: it refuses exactly these
 const refusal=await Op.execute('activate',{binding:db,now:NOW,ctx:{track(){}},params:act({})});
 assert.deepEqual([refusal.outcome,refusal.problems,refusal.reasons],['refused',['active_configuration_mismatch'],['other_scope_present','scope_not_enabled']]);
}
{
 // the readback envelope changes between the two reads of one status: unstable, not a verdict
 const {file,db}=world();
 await Op.execute('activate',{binding:db,now:NOW,ctx:{track(){}},params:act({})});
 let seen=0;
 const moving={prepare:text=>{if(/FROM catalog_enrichment_scope ORDER BY scope/.test(text)&&++seen===2)sql(file,"UPDATE catalog_enrichment_scope SET revision=revision+1 WHERE scope='rated'");return db.prepare(text);},batch:b=>db.batch(b)};
 const out=await Op.execute('status',{binding:moving,now:NOW,params:{cutoff:CUTOFF}});
 assert.deepEqual([out.decision,out.problems],['unstable',['state_changed_during_read']]);
}
{
 // a missing or unreadable schema is blocked (not an error, never ready)
 const file=migrated(46);
 const out=await Op.execute('status',{binding:d1Standin(file),now:NOW,params:{cutoff:CUTOFF}});
 assert.equal(out.decision,'blocked');assert.ok(out.problems.includes('schema_not_applied'));
 assert.equal(out.writes,false);
}

// ===== 5. the REAL production composition: mocked D1 REST over sqlite, strict reads, atomic rendered batches, response loss =====
const ENV={D1_BACKFILL_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,D1_BACKFILL_API_TOKEN:'SECRET-TOKEN-VALUE',NODE_USE_ENV_PROXY:''};
function rest(file,{loseControlReply=false,blindAfterControl=false,failFirstRead=false,malformed=()=>false,describe={uuid:PRODUCTION_DATABASE_ID,name:'iptv'},status403=false}={}){
 const calls=[];
 const state={blind:false,failed:false};
 const lite=(input,json)=>sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input,encoding:'utf8',maxBuffer:1<<28});
 const answer=(body,code=200)=>({ok:code>=200&&code<300,status:code,json:async()=>body});
 const fetchImpl=async(url,init)=>{
  calls.push({url:String(url),method:init.method,body:init.body});
  if(status403)return answer({success:false,errors:[{message:'forbidden'}]},403);
  if(String(url).endsWith('/time_travel/bookmark'))return answer({success:true,result:{bookmark:'bookmark-'+calls.length}});
  if(init.method==='GET')return answer({success:true,result:describe});
  const body=JSON.parse(init.body);
  if(body.batch){
   const result=lite('BEGIN;\n'+body.batch.map(item=>item.sql).join('\n')+'\nCOMMIT;');
   if(result.status!==0)return answer({success:false,errors:[{message:String(result.stderr).trim()}]},400);
   if(body.batch.some(item=>/^UPDATE catalog_enrichment_control SET state='active'/.test(item.sql))){
    if(blindAfterControl)state.blind=true;
    if(loseControlReply)throw new TypeError('network down');
   }
   return answer({success:true,result:body.batch.map(()=>({success:true,results:[],meta:{rows_written:1}}))});
  }
  const text=String(body.sql);
  if(failFirstRead&&!state.failed&&/FROM catalog_enrichment_control/.test(text)){state.failed=true;return answer({success:false,errors:[{message:'unavailable'}]},503);}
  if(state.blind&&/catalog_enrichment_control/.test(text))return answer({success:false,errors:[{message:'unavailable'}]},500);
  if(malformed(text))return answer({success:true,result:[{success:true}]});
  const result=lite(text,true);
  if(result.status!==0)return answer({success:false,errors:[{message:String(result.stderr).trim()}]},400);
  const out=String(result.stdout).trim();
  return answer({success:true,result:[{success:true,results:out?JSON.parse(out):[],meta:{rows_written:0}}]});
 };
 return {fetchImpl,calls};
}
const ARGV=(...extra)=>A('--activate','--target','iptv','--cutoff',CUTOFF,'--by','operator:AIR-607','--go',GO,'--confirm','activate','--operator-sha256',SHA,...extra);
const production=(argv,file,options={})=>{const mock=rest(file,options);return Op.runCatalogEnrichmentActivationProduction({argv,env:ENV,fetchImpl:mock.fetchImpl,now:()=>NOW}).then(result=>({...result,calls:mock.calls}));};
{
 // status: strict reads only, no write request, no bookmark, no secret in the output
 const {file}=world();
 const out=await production(A('--status','--target','iptv','--cutoff',CUTOFF),file);
 assert.equal(out.exit,0);assert.equal(out.result.decision,'ready');
 assert.equal(out.calls.some(c=>c.body&&JSON.parse(c.body).batch),false,'no {batch} request');
 assert.equal(out.calls.some(c=>c.url.endsWith('/time_travel/bookmark')),false);
 assert.equal(JSON.stringify(out).includes('SECRET-TOKEN-VALUE'),false);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_scope')[0].n,0);
}
{
 // a malformed (no result array) answer to a state read is an error before any write
 const {file}=world();
 const out=await production(ARGV(),file,{malformed:text=>/FROM catalog_enrichment_control/.test(text)});
 assert.notEqual(out.exit,0);assert.equal(out.result.writeState,'none');
 assert.equal(out.calls.some(c=>c.body&&JSON.parse(c.body).batch),false,'nothing was written');
 assert.equal(controlRow(file),null);
}
{
 // zero retries: one transient failure of a state read ends the run before any write, and the request is not repeated
 const {file}=world();
 const out=await production(ARGV(),file,{failFirstRead:true});
 assert.notEqual(out.exit,0);assert.equal(out.result.writeState,'none');
 assert.equal(out.calls.filter(c=>c.body&&/FROM catalog_enrichment_control/.test(c.body)).length,1,'the failed read was not retried');
 assert.equal(out.calls.some(c=>c.body&&JSON.parse(c.body).batch),false,'nothing was written');
 assert.equal(controlRow(file),null);
}
{
 // wrong database identity, a refused credential, a wrong account and a missing credential stop before a write
 const {file}=world();
 const wrong=await production(ARGV(),file,{describe:{uuid:'00000000-0000-0000-0000-000000000000',name:'iptv'}});
 assert.deepEqual([wrong.exit,wrong.result.reason],[3,'target_identity_mismatch']);
 const denied=await production(ARGV(),file,{status403:true});
 assert.deepEqual([denied.exit,denied.result.reason],[3,'authorization']);
 const mock=rest(file);
 const account=await Op.runCatalogEnrichmentActivationProduction({argv:ARGV(),env:{...ENV,D1_BACKFILL_ACCOUNT_ID:'0'.repeat(32)},fetchImpl:mock.fetchImpl,now:()=>NOW});
 assert.deepEqual([account.exit,account.result.reason],[3,'account_mismatch']);
 const none=await Op.runCatalogEnrichmentActivationProduction({argv:ARGV(),env:{},fetchImpl:mock.fetchImpl,now:()=>NOW});
 assert.deepEqual([none.exit,none.result.reason],[2,'configuration']);
 assert.equal(mock.calls.length,0,'no request was made');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_scope')[0].n,0);
}
{
 // the whole activation over the strict REST adapter: the bookmark before and after, one {batch} request per write unit, the rendered literals, no secret
 const {file}=world();
 const out=await production(ARGV(),file);
 assert.equal(out.exit,0,JSON.stringify(out.result));
 assert.deepEqual([out.result.outcome,out.result.writeState,out.result.writes],['activated','committed',true]);
 assert.equal(out.result.transport.lastBatch,'committed');
 assert.equal(out.result.control.updatedBy,'operator:AIR-607 go:'+GO);
 assert.deepEqual([out.result.qualifyingAdmissions,out.result.ratedSignals,out.result.onlyRatedScope],[100,100,true]);
 assert.deepEqual(out.result.wake,{outcome:'deferred',reason:'no_workflow_binding'});
 assert.ok(out.result.bookmarkBefore&&out.result.bookmarkAfter&&out.result.bookmarkBefore!==out.result.bookmarkAfter);
 const posts=out.calls.filter(c=>c.method==='POST'&&c.body).map(c=>JSON.parse(c.body));
 const batches=posts.filter(p=>p.batch);
 assert.equal(batches.length,5,'scope insert, three bootstrap pages and the control commit, each ONE atomic {batch} request');
 assert.equal(batches[0].batch.length,1);assert.equal(batches.at(-1).batch.length,2);
 assert.ok(posts.filter(p=>!p.batch).every(p=>/^\s*(SELECT|WITH)/i.test(p.sql)),'every other request is a read');
 assert.equal(JSON.stringify(out).includes('SECRET-TOKEN-VALUE'),false,'no secret in the output');
 assert.equal(controlRow(file).state,'active');
 // the repeated call is a noop over the same adapter and writes nothing
 const again=await production(ARGV(),file);
 assert.deepEqual([again.exit,again.result.outcome,again.result.writeState],[0,'noop','none']);
 assert.equal(again.calls.some(c=>c.body&&JSON.parse(c.body).batch),false);
}
{
 // the control commit applied and its reply was lost: the adapter never retries it, the module reads it back as this operator's own write
 const {file}=world();
 const out=await production(ARGV(),file,{loseControlReply:true});
 assert.equal(out.exit,0,JSON.stringify(out.result));
 assert.deepEqual([out.result.outcome,out.result.note],['activated','commit_reply_lost']);
 assert.equal(out.calls.filter(c=>c.body&&/UPDATE catalog_enrichment_control SET state='active'/.test(c.body)).length,1,'the lost reply was not retried');
 assert.equal(controlRow(file).state,'active');
}
{
 // lost reply AND an unreadable control table afterwards: uncertain, never activated, never retried
 const {file}=world();
 const out=await production(ARGV(),file,{loseControlReply:true,blindAfterControl:true});
 assert.equal(out.exit,3);
 assert.deepEqual([out.result.outcome,out.result.reason,out.result.writeState,out.result.writes,out.result.retry],['uncertain','control_outcome_unknown','unknown',null,false]);
 assert.deepEqual(out.result.effects,{scopeInserted:true,bootstrapRows:100,bootstrapPages:3},'the confirmed earlier effects are preserved');
 assert.equal(out.result.transport.lastBatch,'unknown');
 assert.equal(controlRow(file).state,'active','the commit did land; only the operator could not see it');
}
{
 // a held marker between the preflight and the first write stops the insert; the run ends refused with nothing written
 const {file}=world();
 const mock=rest(file);
 let fired=false;
 const inner=mock.fetchImpl;
 const fetchImpl=async(url,init)=>{if(!fired&&init.body&&JSON.parse(init.body).batch?.[0]?.sql.startsWith('INSERT INTO catalog_enrichment_scope')){fired=true;sql(file,"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1;");}return inner(url,init);};
 const out=await Op.runCatalogEnrichmentActivationProduction({argv:ARGV(),env:ENV,fetchImpl,now:()=>NOW});
 assert.equal(out.exit,3);assert.deepEqual([out.result.outcome,out.result.problems],['refused',['scope_not_written']]);
 assert.deepEqual([out.result.writeState,out.result.writes],['none',false],'the guarded insert batch was delivered and committed but changed no row: that is not a write');
 assert.equal(out.result.transport.lastBatch,'committed','the delivery telemetry stays separate from the confirmed domain effects');
 assert.deepEqual(out.result.effects,{scopeInserted:false,bootstrapRows:0,bootstrapPages:0});
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_scope')[0].n,0);assert.equal(controlRow(file),null);
}
{
 // a partial stop: the marker is held between bootstrap pages, so only the first page is written. The domain state is `partial` with the confirmed effects; the run ends with exit 3 and no retry
 const {file}=world();
 const mock=rest(file);
 let pages=0;
 const inner=mock.fetchImpl;
 const fetchImpl=async(url,init)=>{
  const body=init.body?JSON.parse(init.body):null;
  if(body?.batch?.[0]?.sql.startsWith('INSERT INTO enrichment_signal')&&++pages===2)sql(file,"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1;");
  return inner(url,init);
 };
 const out=await Op.runCatalogEnrichmentActivationProduction({argv:ARGV(),env:ENV,fetchImpl,now:()=>NOW});
 assert.equal(out.exit,3);
 assert.deepEqual([out.result.outcome,out.result.writeState,out.result.writes,out.result.partial,out.result.retry],['stopped','partial',true,true,false]);
 assert.deepEqual(out.result.effects,{scopeInserted:true,bootstrapRows:50,bootstrapPages:1},'only the first page was written under the held marker');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,50);assert.equal(controlRow(file),null);
}
{
 // an error in the middle of the run (a statement of the second page is rejected): what was confirmed before cannot be re-read from here, so the domain state is unknown, never a guess; the delivery telemetry says the last batch
 const {file}=world();
 const mock=rest(file);
 let pages=0;
 const inner=mock.fetchImpl;
 const fetchImpl=async(url,init)=>{
  const body=init.body?JSON.parse(init.body):null;
  if(body?.batch?.[0]?.sql.startsWith('INSERT INTO enrichment_signal')&&++pages===2)return {ok:false,status:400,json:async()=>({success:false,errors:[{message:'rejected'}]})};
  return inner(url,init);
 };
 const out=await Op.runCatalogEnrichmentActivationProduction({argv:ARGV(),env:ENV,fetchImpl,now:()=>NOW});
 assert.equal(out.exit,3);
 assert.deepEqual([out.result.reason,out.result.writeState,out.result.writes,out.result.retry],['statement_failed','unknown',null,false]);
 assert.equal(out.result.transport.lastBatch,'unknown');
 assert.equal(controlRow(file),null,'the control was never enabled');
}
{
 // a resumed activation whose final page has zero qualifying rows changes the scope's bootstrap state; when the control guard then refuses, that confirmed change is a domain write (partial), never `none`
 const LATE_CUTOFF='2026-11-20T00:00:00.000Z';
 for(const [label,state,expected] of [['incomplete scope, zero rows, control guard refuses','none',{writeState:'partial',writes:true,partial:true,pages:1}],['already done scope, nothing new, control guard refuses','done',{writeState:'none',writes:false,partial:undefined,pages:0}]]){
  const {file}=world();
  sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,bootstrap_state,revision,updated_at) VALUES ('rated',1,1,'${LATE_CUTOFF}','${state}',1,'${AT}')`);
  const mock=rest(file);
  let armed=true;
  const inner=mock.fetchImpl;
  const fetchImpl=async(url,init)=>{
   const body=init.body?JSON.parse(init.body):null;
   if(armed&&body?.batch?.some(item=>/^INSERT INTO catalog_enrichment_control /.test(item.sql))){armed=false;sql(file,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('catalog_enrichment','lease-live-0011','2026-11-28T10:04:00.000Z','2026-11-28T09:59:00.000Z')");}
   return inner(url,init);
  };
  const out=await Op.runCatalogEnrichmentActivationProduction({argv:A('--activate','--target','iptv','--cutoff',LATE_CUTOFF,'--by','operator:AIR-607','--go',GO,'--confirm','activate','--operator-sha256',SHA),env:ENV,fetchImpl,now:()=>NOW});
  assert.equal(out.exit,3,label);
  assert.deepEqual([out.result.outcome,out.result.reason],['stopped','control_guard_failed'],label);
  assert.deepEqual([out.result.writeState,out.result.writes,out.result.partial],[expected.writeState,expected.writes,expected.partial],label);
  assert.deepEqual(out.result.effects,{scopeInserted:false,bootstrapRows:0,bootstrapPages:expected.pages},label);
  assert.equal(rows(file,"SELECT bootstrap_state FROM catalog_enrichment_scope WHERE scope='rated'")[0].bootstrap_state,'done',label);
  assert.equal(controlRow(file),null,label+': the control was never enabled');
 }
}
console.log('catalog enrichment activation production operator: ok');
