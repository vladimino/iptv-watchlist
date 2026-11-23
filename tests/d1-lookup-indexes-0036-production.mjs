// AIR-579: the owner-only operator of migration 0036 (scripts/d1-lookup-indexes-0036-production.mjs). Offline only: sqlite stand-ins over the real migration chain and a fake D1 REST transport.
// No production database is opened, no credential is used, nothing is applied anywhere.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {migrated,sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {D1Error} from '../scripts/d1-backfill.mjs';
import * as Op from '../scripts/d1-lookup-indexes-0036-production.mjs';

const sha=Op.migrationSha256();
assert.equal(sha,createHash('sha256').update(fs.readFileSync('migrations/0036_epg_discovery_lookup_indexes.sql')).digest('hex'),'the pin is the SHA-256 of the exact bytes');
assert.equal(Op.migrationSql().length,4,'guard + two CREATE INDEX + version update');
const stop=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason,String(error.reason));return error;}assert.fail('expected '+reason);};
const tracker=()=>{const states=[];return {states,track:state=>states.push(state)};};
const A=(...args)=>['node','op',...args];

// ---- arguments ----
assert.deepEqual(Op.parseArgs(A()),{report:{configured:false,writes:false,writeState:'none'}},'default is a read-only no-op report');
assert.equal(Op.parseArgs(A('--target','iptv')).command,'status','status is the default command');
for(const bad of [A('--apply'),A('--status','--apply','--target','iptv'),A('--target','other'),A('--target','iptv','--apply'),A('--target','iptv','--apply','--confirm','status','--migration-sha256',sha),A('--target','iptv','--apply','--confirm','apply'),A('--target','iptv','--apply','--confirm','apply','--migration-sha256','abc'),A('--target','iptv','--status','--confirm','apply'),A('--target','iptv','--status','--migration-sha256',sha),A('--target','iptv','--apply','--confirm','apply','--migration-sha256',sha,'--sql-file','x'),A('--target','iptv','--target','iptv')])
 assert.throws(()=>Op.parseArgs(bad),error=>error.name==='OperatorStop',JSON.stringify(bad));
assert.deepEqual(Op.parseArgs(A('--target','iptv','--apply','--confirm','apply','--migration-sha256',sha)),{command:'apply',params:{migrationSha256:sha}});

// ---- a v35 world ----
// The sqlite CLI does not print EXPLAIN QUERY PLAN as JSON (D1's REST API returns rows): the stand-in turns its text into {detail} rows, as D1 does.
const withExplain=(file,db)=>({...db,calls:db.calls,batch:statements=>db.batch(statements),prepare:text=>/^\s*EXPLAIN QUERY PLAN/i.test(text)?{bind:()=>({all:async()=>{const out=String(sqliteSync([file],{input:text+';\n',encoding:'utf8'}).stdout);return {results:out.split('\n').filter(line=>/[A-Z]/.test(line)&&!/^QUERY PLAN/.test(line)).map(line=>({detail:line.replace(/^[|`\-\s]+/,'')}))};}})}:db.prepare(text)});
const v35=()=>{const file=migrated(35);return {file,db:withExplain(file,d1Standin(file))};};
const counts=file=>sql(file,"SELECT (SELECT COUNT(*) FROM published_epg_show) a,(SELECT COUNT(*) FROM film_external_id) b")[0];
const version=file=>Number(sql(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const indexes=file=>sql(file,"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('published_epg_show_discovery_by_match','film_external_id_by_scheme_value')").map(row=>row.name);

// status on v35: read-only, decision apply, the full digest.
{
 const {file,db}=v35();
 const before=sql(file,"SELECT group_concat(name) n FROM sqlite_master")[0].n;
 const out=await Op.execute('status',{binding:db});
 assert.equal(out.decision,'apply');assert.equal(out.writes,false);assert.equal(out.migrationSha256,sha);assert.equal(out.schemaVersion,35);
 assert.equal(out.auxTables,'13/13');assert.equal(out.receiptTables,'3/3');assert.equal(out.sealTriggers,'33/33');assert.deepEqual(out.newIndexes,[]);assert.deepEqual(out.auxMarker,{mode:'r2',generation:0});
 assert.equal(sql(file,"SELECT group_concat(name) n FROM sqlite_master")[0].n,before,'status changes nothing');assert.equal(db.calls.batches,0,'status sent no batch');
}

// apply on v35 commits ONE batch of four statements, passes the readback and changes nothing else.
{
 const {file,db}=v35();const c0=counts(file),ctx=tracker();
 const dump0=sql(file,"SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1,2").map(row=>row.type+row.name);
 const out=await Op.execute('apply',{binding:db,ctx,params:{migrationSha256:sha}});
 assert.equal(db.calls.batches,1,'exactly one batch');assert.equal(db.calls.statements,4,'of four statements');
 assert.equal(out.writeState,'committed');assert.deepEqual(ctx.states,['unknown','committed']);
 assert.equal(version(file),36);assert.deepEqual(indexes(file).sort(),Op.NEW_INDEXES.slice().sort());assert.deepEqual(counts(file),c0);
 const added=sql(file,"SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1,2").map(row=>row.type+row.name).filter(item=>!dump0.includes(item));
 assert.deepEqual(added.sort(),Op.NEW_INDEXES.map(name=>'index'+name).sort(),'only the two indexes are new');
 assert.match(out.indexes.deletePlan,/published_epg_show_discovery_by_match/);assert.match(out.indexes.lookupPlan,/film_external_id_by_scheme_value/);
 assert.equal(out.indexes.show.partial,1);assert.equal(out.indexes.show.unique,0);assert.equal(out.indexes.external.partial,0);
 // a repeated apply is refused and sends nothing
 const again=await stop(Op.execute('apply',{binding:db,ctx:tracker(),params:{migrationSha256:sha}}),'already_applied');
 assert.equal(db.calls.batches,1,'no second batch');assert.ok(again);
 assert.equal((await Op.execute('status',{binding:db})).decision,'already_applied');
}

// pin mismatch, wrong versions, partial state: no batch is sent.
const refused=async(prepare,reason,params={migrationSha256:sha},upTo=35)=>{
 const file=migrated(upTo),db=withExplain(file,d1Standin(file));prepare(file);
 await stop(Op.execute('apply',{binding:db,ctx:tracker(),params}),reason);
 assert.equal(db.calls.batches,0,reason+': nothing sent');return file;
};
await refused(()=>{},'migration_sha256_mismatch',{migrationSha256:'0'.repeat(64)});
await refused(()=>{},'schema_unexpected',undefined,34);
await refused(()=>{},'schema_unexpected',undefined,33);
await refused(file=>sql(file,"UPDATE schema_contract SET version=37 WHERE id=1"),'schema_unexpected');
await refused(file=>sql(file,'CREATE INDEX film_external_id_by_scheme_value ON film_external_id (scheme, value)'),'partial_schema');
await refused(file=>sql(file,"CREATE INDEX published_epg_show_discovery_by_match ON published_epg_show (channel_id)"),'partial_schema');
await refused(file=>sql(file,'DROP TABLE prediction_aux_seal'),'predecessor_incomplete');
await refused(file=>sql(file,'DROP INDEX film_external_id_one_trusted'),'predecessor_incomplete');
await refused(file=>{const trigger=sql(file,"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'prediction_aux_sealed_%' LIMIT 1")[0].name;sql(file,'DROP TRIGGER '+trigger);},'predecessor_incomplete');
await refused(file=>sql(file,"CREATE TRIGGER prediction_aux_sealed_extra BEFORE INSERT ON prediction_aux_seal BEGIN SELECT 1; END"),'predecessor_incomplete');
// v36 with a missing index (drift) is partial, never "applied".
{
 const {file,db}=v35();await Op.execute('apply',{binding:db,ctx:tracker(),params:{migrationSha256:sha}});
 sql(file,'DROP INDEX film_external_id_by_scheme_value');
 assert.equal((await Op.execute('status',{binding:db})).decision,'partial_schema');
}
// a changed aux marker (an AIR-554 window is open) stops the apply.
await refused(file=>sql(file,"UPDATE prediction_aux_authority SET mode='closed', generation=1"),'aux_marker_changed');

// ---- an unclear / failed write: no blind retry, state read back ----
// statement rejected by D1 with the state unchanged -> statement_failed, writeState none.
{
 const {file,db}=v35();const ctx=tracker();
 const failing={...db,batch:async()=>{throw new D1Error('statement','rejected');}};
 const error=await stop(Op.execute('apply',{binding:failing,ctx,params:{migrationSha256:sha}}),'statement_failed');assert.ok(error);
 assert.deepEqual(ctx.states,['unknown','none']);assert.equal(version(file),35);
}
// a lost response while the batch DID commit -> write_uncertain, never retried, state reported.
{
 const {file,db}=v35();const ctx=tracker();let sent=0;
 const lost={...db,prepare:sqlText=>db.prepare(sqlText),batch:async statements=>{sent++;await db.batch(statements);throw new D1Error('write_uncertain','lost');}};
 await stop(Op.execute('apply',{binding:lost,ctx,params:{migrationSha256:sha}}),'write_uncertain');
 assert.equal(sent,1,'no retry');assert.equal(version(file),36);assert.deepEqual(ctx.states,['unknown','unknown']);
}
// an unclear error that is not a D1Error stays uncertain even with an unchanged state.
{
 const {db}=v35();const ctx=tracker();
 await stop(Op.execute('apply',{binding:{...db,batch:async()=>{throw new Error('timeout');}},ctx,params:{migrationSha256:sha}}),'write_uncertain');
}
// a committed batch whose readback differs (here: a row count changed) is write_uncertain, not success.
{
 const {file,db}=v35();const ctx=tracker();
 const drift={...db,batch:async statements=>{await db.batch(statements);sql(file,"PRAGMA foreign_keys=OFF;INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('f','tmdb','1',0,0)");}};
 const error=await stop(Op.execute('apply',{binding:drift,ctx,params:{migrationSha256:sha}}),'write_uncertain');
 assert.equal(error.details.reason,'readback_mismatch');assert.ok(error.details.problems.includes('counts'));assert.deepEqual(ctx.states,['unknown','unknown']);
}

// ---- the runner over a fake REST transport: identity, no automatic retry, bookmark ----
const env={D1_BACKFILL_ACCOUNT_ID:'8d9331889a693d328ef306692adf9d24',D1_BACKFILL_API_TOKEN:'fake-token-not-a-secret'};
const transport=({uuid='3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb',name='iptv',status=200}={})=>{
 const calls=[];
 const fetchImpl=async(url,init)=>{
  calls.push({url:String(url),method:init.method,body:init.body});
  if(String(url).endsWith('/time_travel/bookmark'))return new Response(JSON.stringify({result:{bookmark:'bm-'+calls.length}}),{status:200});
  if(init.method==='GET')return new Response(JSON.stringify({success:true,result:{uuid,name}}),{status});
  return new Response(JSON.stringify({success:false,errors:[{message:'offline'}]}),{status:503});
 };
 return {calls,fetchImpl};
};
{
 const t=transport({uuid:'00000000-0000-0000-0000-000000000000'});
 const out=await Op.runLookupIndexes0036Production({argv:A('--target','iptv','--status'),env,fetchImpl:t.fetchImpl});
 assert.equal(out.result.reason,'target_identity_mismatch');assert.equal(out.result.writeState,'none');
 assert.ok(t.calls.every(call=>call.method==='GET'),'only the identity read was made');
}
{
 const out=await Op.runLookupIndexes0036Production({argv:A('--target','iptv','--status'),env:{...env,D1_BACKFILL_ACCOUNT_ID:'0'.repeat(32)},fetchImpl:transport().fetchImpl});
 assert.equal(out.result.reason,'account_mismatch');
 const none=await Op.runLookupIndexes0036Production({argv:A('--target','iptv','--status'),env:{},fetchImpl:transport().fetchImpl});assert.equal(none.result.reason,'configuration');
 const bad=await Op.runLookupIndexes0036Production({argv:A('--target','iptv','--status'),env:{...env,D1_BACKFILL_DATABASE_ID:'1'.repeat(32)},fetchImpl:transport().fetchImpl});assert.equal(bad.result.reason,'database_id_mismatch');
}
// status over the transport with a 503 on every read: the adapter is built with retries 0, so exactly one read request is made after the identity call.
{
 const t=transport();
 const out=await Op.runLookupIndexes0036Production({argv:A('--target','iptv','--status'),env,fetchImpl:t.fetchImpl});
 assert.notEqual(out.exit,0);assert.equal(out.result.writeState,'none');
 assert.equal(t.calls.filter(call=>call.method==='POST').length,1,'a failed read is not retried');
 assert.ok(!JSON.stringify(out).includes('fake-token'),'the token is never printed');
}
// the runner with injected deps: status and apply return the bookmark only for apply.
{
 const {db}=v35();
 const status=await Op.runLookupIndexes0036Production({argv:A('--target','iptv','--status'),deps:{binding:db}});
 assert.equal(status.exit,0);assert.equal(status.result.decision,'apply');
 const out=await Op.runLookupIndexes0036Production({argv:A('--target','iptv','--apply','--confirm','apply','--migration-sha256',sha),deps:{binding:db}});
 assert.equal(out.exit,0);assert.equal(out.result.writeState,'committed');
}
console.log('d1-lookup-indexes-0036-production: ok');
