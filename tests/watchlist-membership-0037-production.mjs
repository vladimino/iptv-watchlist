// AIR-572 / ADR 0203: the owner-only operator of migration 0037 (scripts/watchlist-membership-0037-production.mjs). Offline only: sqlite stand-ins over the real migration chain and a fake D1 REST transport.
// No production database is opened, no credential is used, nothing is applied anywhere. SYNTHETIC ids only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {migrated,sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {D1Error} from '../scripts/d1-backfill.mjs';
import * as Op from '../scripts/watchlist-membership-0037-production.mjs';

const sha=Op.migrationSha256();
assert.equal(sha,createHash('sha256').update(fs.readFileSync('migrations/0037_watchlist_membership_projection.sql')).digest('hex'),'the pin is the SHA-256 of the exact bytes');
assert.equal(Op.migrationSql().length,15,'every statement of the unchanged file, each with its expected shape');
const stop=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason,String(error.reason));return error;}assert.fail('expected '+reason);};
const tracker=()=>{const states=[];return {states,track:state=>states.push(state)};};
const A=(...args)=>['node','op',...args];
const AT='2026-11-23T10:00:00.000Z';
const H='a'.repeat(64);

// ---- arguments ----
assert.deepEqual(Op.parseArgs(A()),{report:{configured:false,writes:false,writeState:'none'}},'default is a read-only no-op report');
assert.equal(Op.parseArgs(A('--target','iptv')).command,'status');
assert.equal(Op.parseArgs(A('--baseline-dry-run','--target','iptv')).command,'baseline-dry-run');
for(const bad of [A('--apply'),A('--baseline-dry-run'),A('--status','--apply','--target','iptv'),A('--apply','--baseline-dry-run','--target','iptv'),A('--target','other'),A('--target','iptv','--apply'),
 A('--target','iptv','--apply','--confirm','status','--migration-sha256',sha),A('--target','iptv','--apply','--confirm','apply','--migration-sha256','x'),A('--baseline-dry-run','--target','iptv','--confirm','apply'),
 A('--target','iptv','--status','--migration-sha256',sha),A('--target','iptv','--unknown','1')])
 assert.throws(()=>Op.parseArgs(bad),error=>error.name==='OperatorStop',JSON.stringify(bad));
assert.deepEqual(Op.parseArgs(A('--target','iptv','--apply','--confirm','apply','--migration-sha256',sha)),{command:'apply',params:{migrationSha256:sha}});

// ---- worlds ----
// A Watchlist at version 2 (two promoted snapshots, every effect done), three current members (one lid-named Film, one claimed by an existing TMDB Film, one with no Film), and a stale `watchlist_film` row.
function seed(file,{pending=false,drained=2}={}){
 sql(file,
  "INSERT INTO watchlist_staging (snapshot_id,attempt_id,expected_count,expected_sha256,started_at) VALUES ('s1','a1',1,'"+H+"','"+AT+"'),('s2','a2',3,'"+H+"','"+AT+"');"+
  "INSERT INTO watchlist_snapshot (snapshot_id,version,scan_id,observed_at,committed_at,film_count,list_sha256,prev_version) VALUES ('s1',1,'scan1','"+AT+"','"+AT+"',1,'"+H+"',0),('s2',2,'scan2','"+AT+"','"+AT+"',3,'"+H+"',1);"+
  "INSERT INTO watchlist_member (snapshot_id,ordinal,lid,title,url) VALUES ('s1',0,'own1','T','https://letterboxd.com/film/own1/'),('s2',0,'own1','T','https://letterboxd.com/film/own1/'),('s2',1,'clm1','T','https://letterboxd.com/film/clm1/'),('s2',2,'nobody1','T','https://letterboxd.com/film/nobody1/');"+
  "UPDATE watchlist_current SET version=1,snapshot_id='s1',list_sha256='"+H+"',film_count=1,revision=revision+1 WHERE id=1;UPDATE watchlist_current SET version=2,snapshot_id='s2',list_sha256='"+H+"',film_count=3,effects_drained_version="+drained+",revision=revision+1 WHERE id=1;"+
  "INSERT INTO watchlist_effect (snapshot_id,effect,status,receipt,attempts,done_at) VALUES ('s1','scan_facts','done','facts:scan1',1,'"+AT+"'),('s1','retention','done','retention:scan1:1',1,'"+AT+"'),('s1','removal_enqueue','done','removal:none:scan1',1,'"+AT+"'),"+
  "('s2','scan_facts','done','facts:scan2',1,'"+AT+"'),('s2','retention','"+(pending?"pending":"done")+"',"+(pending?"NULL":"'retention:scan2:3'")+",1,"+(pending?"NULL":"'"+AT+"'")+"),('s2','removal_enqueue','done','removal:none:scan2',1,'"+AT+"');"+
  "INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:own1',1,'Own','"+AT+"'),('film:tmdb:9',1,'Claimed','"+AT+"'),('film:stale',1,'Stale','"+AT+"');"+
  "INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:9','letterboxd','clm1',1,0);"+
  "INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:own1','"+AT+"'),('film:stale','"+AT+"')");
 return file;
}
const world=(upTo=36,options)=>{const file=seed(migrated(upTo),options);return {file,db:d1Standin(file)};};
const version=file=>Number(sql(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const effects=file=>sql(file,'SELECT snapshot_id,effect,status,receipt,attempts,done_at FROM watchlist_effect ORDER BY snapshot_id,effect');
const objects=file=>sql(file,"SELECT type||':'||name AS o FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1").map(row=>row.o);

// v35 (0036 not yet applied, today's production): status names the missing predecessor, apply sends nothing.
{
 const {file,db}=world(35);
 const out=await Op.execute('status',{binding:db});
 assert.equal(out.decision,'predecessor_0036_not_applied');assert.equal(out.schemaVersion,35);assert.equal(out.writes,false);
 await stop(Op.execute('apply',{binding:db,ctx:tracker(),params:{migrationSha256:sha}}),'predecessor_0036_not_applied');
 assert.equal(db.calls.batches,0);assert.equal(version(file),35);
}

// status on v36: read-only, decision apply, a digest of counts only.
{
 const {file,db}=world();
 const before=objects(file);
 const out=await Op.execute('status',{binding:db});
 assert.equal(out.decision,'apply');assert.equal(out.migrationSha256,sha);assert.equal(out.approvedSha256Match,true);assert.equal(out.statements,15);
 assert.equal(out.predecessorIndexes,'2/2');assert.equal(out.neededTables,'6/6');assert.deepEqual(out.newTables,[]);assert.equal(out.effectAllowsMembership,false);
 assert.deepEqual(out.current,{version:2,drained:2});assert.deepEqual(out.effects,{rows:6,pending:0,byEffect:{scan_facts:2,retention:2,removal_enqueue:2}});assert.equal(out.watchlistFilmRows,2);
 assert.deepEqual(objects(file),before,'status changes nothing');assert.equal(db.calls.batches,0);
 assert.ok(!JSON.stringify(out).includes('own1')&&!JSON.stringify(out).includes('clm1'),'no Letterboxd id is reported');
}

// apply on v36: ONE batch of 15 statements, every effect row carried over unchanged, the marker inert, nothing else changed.
{
 const {file,db}=world();const ctx=tracker();
 const rows=effects(file),film=sql(file,'SELECT film_id FROM watchlist_film ORDER BY 1'),before=objects(file);
 assert.throws(()=>sql(file,"INSERT INTO watchlist_effect (snapshot_id,effect,status,attempts) VALUES ('s2','membership','pending',0)"),/CHECK/,'before 0037 the effect is illegal');
 const out=await Op.execute('apply',{binding:db,ctx,params:{migrationSha256:sha}});
 assert.equal(db.calls.batches,1,'exactly one batch');assert.equal(db.calls.statements,15,'of fifteen statements');
 assert.equal(out.writeState,'committed');assert.deepEqual(ctx.states,['unknown','committed']);
 assert.equal(version(file),37);
 assert.deepEqual(effects(file),rows,'the rebuild copied every effect row unchanged');
 assert.deepEqual(sql(file,'SELECT film_id FROM watchlist_film ORDER BY 1'),film,'watchlist_film untouched');
 assert.deepEqual(sql(file,'SELECT mode,generation,baseline_version FROM watchlist_membership_authority'),[{mode:'producer',generation:0,baseline_version:null}],'the marker is inert');
 assert.deepEqual(out.after.marker,{mode:'producer',generation:0,baselineVersion:null});
 const added=objects(file).filter(item=>!before.includes(item)).sort();
 assert.deepEqual(added,['index:watchlist_membership_handoff_due','table:watchlist_film_fence','table:watchlist_membership_authority','table:watchlist_membership_handoff',
  'trigger:watchlist_film_fence_monotonic','trigger:watchlist_membership_authority_order','trigger:watchlist_membership_authority_required'],'only the 0037 objects are new; watchlist_effect and its trigger are kept');
 sql(file,"INSERT INTO watchlist_effect (snapshot_id,effect,status,attempts) VALUES ('s2','membership','pending',0)");
 assert.throws(()=>sql(file,"UPDATE watchlist_effect SET status='pending',done_at=NULL WHERE snapshot_id='s1' AND effect='scan_facts'"),/watchlist_effect_regress/,'the monotonic trigger is back');
 // a repeated apply is refused and sends nothing
 await stop(Op.execute('apply',{binding:db,ctx:tracker(),params:{migrationSha256:sha}}),'already_applied');
 assert.equal(db.calls.batches,1,'no second batch');
}

// refusals: no batch is sent.
const refused=async(prepare,reason,{params={migrationSha256:sha},options}={})=>{
 const {file,db}=world(36,options);prepare(file);
 await stop(Op.execute('apply',{binding:db,ctx:tracker(),params}),reason);
 assert.equal(db.calls.batches,0,reason+': nothing sent');
};
await refused(()=>{},'migration_sha256_mismatch',{params:{migrationSha256:'0'.repeat(64)}});
await refused(()=>{},'watchlist_effects_pending',{options:{pending:true}});
await refused(()=>{},'watchlist_effects_pending',{options:{drained:1}});
await refused(file=>sql(file,'DROP INDEX film_external_id_by_scheme_value'),'predecessor_incomplete');
await refused(file=>sql(file,'CREATE TABLE watchlist_film_fence (film_id TEXT PRIMARY KEY)'),'partial_schema');
await refused(file=>sql(file,'CREATE TABLE watchlist_effect_v37 (x INTEGER)'),'partial_schema');
await refused(file=>sql(file,'DROP TRIGGER watchlist_effect_monotonic'),'needed_objects_missing');
await refused(file=>sql(file,'UPDATE schema_contract SET version=38 WHERE id=1'),'schema_unexpected');
// The approved bytes are pinned independently of the caller's pin: an altered file cannot authorize itself with its own hash.
{
 const {db}=world();
 const altered=Buffer.from(fs.readFileSync(Op.MIGRATION_PATH,'utf8').replace("'producer', 0, NULL","'sync', 0, NULL"));
 assert.equal(Op.approved(altered),false);
 assert.throws(()=>Op.migrationSql(altered),error=>error.reason==='migration_not_approved');
 const out=await Op.execute('status',{binding:db,bytes:altered});assert.equal(out.decision,'migration_not_approved');
 await stop(Op.execute('apply',{binding:db,ctx:tracker(),params:{migrationSha256:createHash('sha256').update(altered).digest('hex')},bytes:altered}),'migration_not_approved');
 assert.equal(db.calls.batches,0);
}

// ---- an unclear / failed write: no blind retry, state read back ----
{
 const {file,db}=world();const ctx=tracker();
 await stop(Op.execute('apply',{binding:{...db,batch:async()=>{throw new D1Error('statement','rejected');}},ctx,params:{migrationSha256:sha}}),'statement_failed');
 assert.deepEqual(ctx.states,['unknown','none']);assert.equal(version(file),36);
}
{
 const {file,db}=world();const ctx=tracker();let sent=0;
 await stop(Op.execute('apply',{binding:{...db,batch:async statements=>{sent++;await db.batch(statements);throw new D1Error('write_uncertain','lost');}},ctx,params:{migrationSha256:sha}}),'write_uncertain');
 assert.equal(sent,1,'no retry');assert.equal(version(file),37);assert.deepEqual(ctx.states,['unknown','unknown']);
}
{
 const {db}=world();
 await stop(Op.execute('apply',{binding:{...db,batch:async()=>{throw new Error('timeout');}},ctx:tracker(),params:{migrationSha256:sha}}),'write_uncertain');
}
// a committed batch whose readback differs (a Letterboxd slot wrote an effect row in between) is write_uncertain, not success.
{
 const {file,db}=world();const ctx=tracker();
 const drift={...db,batch:async statements=>{await db.batch(statements);sql(file,"UPDATE watchlist_effect SET attempts=attempts WHERE 0;INSERT INTO watchlist_effect (snapshot_id,effect,status,attempts) VALUES ('s2','membership','pending',0)");}};
 const error=await stop(Op.execute('apply',{binding:drift,ctx,params:{migrationSha256:sha}}),'write_uncertain');
 assert.equal(error.details.reason,'readback_mismatch');assert.ok(error.details.problems.includes('effects_changed'));
}

// ---- the baseline dry run: read-only, counts only, the same planner and resolver the Worker uses ----
for(const upTo of [35,36]){
 const {file,db}=world(upTo);
 const before=objects(file),film=sql(file,'SELECT film_id FROM watchlist_film ORDER BY 1');
 const out=await Op.execute('baseline-dry-run',{binding:db});
 assert.equal(out.writes,false);assert.equal(out.version,2);assert.equal(out.decision,'drift');
 assert.deepEqual(out.counts,{current:3,stored:2,add:1,remove:1,keep:1,unresolved:1},'own1 kept, clm1 -> the claimed TMDB Film added, nobody1 unresolved, the stale row removed');
 assert.equal(db.calls.batches,0,'no batch');assert.deepEqual(objects(file),before);assert.deepEqual(sql(file,'SELECT film_id FROM watchlist_film ORDER BY 1'),film);
 assert.ok(!JSON.stringify(out).includes('clm1')&&!JSON.stringify(out).includes('film:'),'counts only');
}
{
 const {file,db}=world(36);
 sql(file,"INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:9','"+AT+"');DELETE FROM watchlist_film WHERE film_id='film:stale'");
 const out=await Op.execute('baseline-dry-run',{binding:db});
 assert.equal(out.decision,'already_current');assert.deepEqual(out.counts,{current:3,stored:2,add:0,remove:0,keep:2,unresolved:1});
}
{
 const {db}=world(36,{drained:1});
 await stop(Op.execute('baseline-dry-run',{binding:db}),'effects_pending');
}

// ---- the runner over a fake REST transport: identity, no automatic retry, no token printed ----
const env={D1_BACKFILL_ACCOUNT_ID:'8d9331889a693d328ef306692adf9d24',D1_BACKFILL_API_TOKEN:'fake-token-not-a-secret'};
const transport=({uuid='3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb',name='iptv'}={})=>{
 const calls=[];
 const fetchImpl=async(url,init)=>{
  calls.push({url:String(url),method:init.method});
  if(String(url).endsWith('/time_travel/bookmark'))return new Response(JSON.stringify({result:{bookmark:'bm-'+calls.length}}),{status:200});
  if(init.method==='GET')return new Response(JSON.stringify({success:true,result:{uuid,name}}),{status:200});
  return new Response(JSON.stringify({success:false,errors:[{message:'offline'}]}),{status:503});
 };
 return {calls,fetchImpl};
};
{
 const t=transport({uuid:'00000000-0000-0000-0000-000000000000'});
 const out=await Op.runWatchlistMembership0037Production({argv:A('--target','iptv','--status'),env,fetchImpl:t.fetchImpl});
 assert.equal(out.result.reason,'target_identity_mismatch');assert.equal(out.result.writeState,'none');
 assert.ok(t.calls.every(call=>call.method==='GET'),'only the identity read was made');
}
{
 const out=await Op.runWatchlistMembership0037Production({argv:A('--target','iptv','--status'),env:{...env,D1_BACKFILL_ACCOUNT_ID:'0'.repeat(32)},fetchImpl:transport().fetchImpl});
 assert.equal(out.result.reason,'account_mismatch');
}
{
 const t=transport();
 const out=await Op.runWatchlistMembership0037Production({argv:A('--baseline-dry-run','--target','iptv'),env,fetchImpl:t.fetchImpl});
 assert.notEqual(out.exit,0);assert.equal(out.result.writeState,'none');
 assert.ok(t.calls.filter(call=>call.method==='POST').length<=1,'a failed read is not retried');
 assert.ok(!t.calls.some(call=>call.url.endsWith('/time_travel/bookmark')),'a dry run takes no bookmark');
 assert.ok(!JSON.stringify(out).includes('fake-token'),'the token is never printed');
}
{
 const {db}=world();
 const status=await Op.runWatchlistMembership0037Production({argv:A('--target','iptv','--status'),deps:{binding:db}});
 assert.equal(status.exit,0);assert.equal(status.result.decision,'apply');
 const out=await Op.runWatchlistMembership0037Production({argv:A('--target','iptv','--apply','--confirm','apply','--migration-sha256',sha),deps:{binding:db}});
 assert.equal(out.exit,0);assert.equal(out.result.writeState,'committed');
}
// Review P2: an apply whose batch IS sent and committed but answered ambiguously (HTTP 503) over the real REST adapter returns write_uncertain WITH the pre-write bookmark, and is never retried.
{
 const {file}=world();
 const {sqliteSync}=await import('./sqlite-session.mjs');
 const run=(text,json=true)=>{const result=sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(result.status!==0)throw new Error(result.stderr);const out=String(result.stdout||'').trim();return out?JSON.parse(out):[];};
 const calls=[];let bookmarks=0,writes=0;
 const ok=result=>new Response(JSON.stringify({success:true,result}),{status:200});
 const fetchImpl=async(url,init)=>{
  calls.push({url:String(url),method:init.method});
  if(String(url).endsWith('/time_travel/bookmark')){bookmarks++;return new Response(JSON.stringify({result:{bookmark:'bm-before-'+bookmarks}}),{status:200});}
  if(init.method==='GET')return new Response(JSON.stringify({success:true,result:{uuid:'3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb',name:'iptv'}}),{status:200});
  const body=JSON.parse(init.body);
  const texts=body.batch?body.batch.map(item=>item.sql):[body.sql];
  if(texts.every(text=>/^\s*select\b/i.test(text)))return ok(texts.map(text=>({success:true,results:run(text.trim().replace(/;*$/,';')),meta:{rows_written:0}})));
  writes++;
  run('BEGIN;\n'+texts.map(text=>text.trim().replace(/;*$/,';')).join('\n')+'\nCOMMIT;',false);
  return new Response(JSON.stringify({success:false,errors:[{message:'unavailable'}]}),{status:503});
 };
 const out=await Op.runWatchlistMembership0037Production({argv:A('--target','iptv','--apply','--confirm','apply','--migration-sha256',sha),env,fetchImpl});
 assert.notEqual(out.exit,0);
 assert.equal(out.result.reason,'write_uncertain');assert.equal(out.result.writeState,'unknown');assert.equal(out.result.retry,false);
 assert.equal(out.result.bookmarkBefore,'bm-before-1','the pre-write bookmark survives the uncertain apply');
 assert.equal(writes,1,'the write was sent exactly once, never retried');
 assert.equal(version(file),37,'the batch did commit: the uncertainty is about the reply, not the effect');
 assert.ok(!JSON.stringify(out).includes('fake-token'),'the token is never printed');
}
// A refused apply before any write (pin mismatch) took no bookmark and reports none.
{
 const {db}=world();
 const out=await Op.runWatchlistMembership0037Production({argv:A('--target','iptv','--apply','--confirm','apply','--migration-sha256','0'.repeat(64)),deps:{binding:db}});
 assert.equal(out.result.reason,'migration_sha256_mismatch');assert.equal(out.result.writeState,'none');assert.equal(out.result.bookmarkBefore,undefined);
}
console.log('watchlist-membership-0037-production: ok');
