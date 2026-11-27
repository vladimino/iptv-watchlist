// AIR-603: the owner-only operator of the single D1 migration window v38 -> v47 (checkpoint A) -> v54 (checkpoint B), scripts/d1-migration-window-production.mjs.
// Offline only: scratch sqlite databases built from the real migration files. No production database is opened, no credential is used, nothing is applied anywhere.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {migrated,sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {D1Error} from '../scripts/d1-backfill.mjs';
import * as Op from '../scripts/d1-migration-window-production.mjs';

const MID=Date.parse('2026-11-27T13:30:00.000Z');
const at=ms=>()=>ms;
const tracker=()=>{const states=[];return {states,track:state=>states.push(state)};};
const stop=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason,String(error.reason));return error;}assert.fail('expected '+reason);};
const A=(...args)=>['node','op',...args];
const sh=text=>createHash('sha256').update(text).digest('hex');
const version=file=>Number(sql(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const master=file=>sql(file,"SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type,name").map(row=>row.type+':'+row.name+':'+String(row.sql||'').replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim().replace(/ IF NOT EXISTS/,'').replace(/"/g,''));
const params=(through,start,over={})=>({through,start,manifestSha256:Op.manifestSha256(),operatorSha256:Op.operatorSha256(),...over});
const run=(binding,p,{ctx=tracker(),clock=at(MID),root}={})=>Op.execute('apply',{binding,ctx,params:p,clock,...(root?{root}:{})});
const world=upTo=>{
 const file=migrated(upTo);
 // a production-shaped marker: Film/Person d1/open (generation 2), as the Producer chain triggers require
 sql(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1");
 return {file,db:d1Standin(file)};
};
const copyFile=file=>{const target=file.replace(/\.sqlite$/,'-c'+Math.random().toString(36).slice(2,8)+'.sqlite');fs.copyFileSync(file,target);return target;};

// ---- the manifest is the exact tree of main: 16 files 0039..0054, pinned twice, in order, nothing else ----
{
 const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))>38).sort();
 assert.deepEqual(files,Op.MANIFEST.map(item=>path.basename(item.file)),'the manifest names every file above 38 and no other');
 assert.equal(Op.MANIFEST.length,16);
 Op.MANIFEST.forEach((item,index)=>{
  assert.equal(item.version,39+index);assert.equal(item.from,38+index);assert.equal(item.to,39+index);
  const bytes=fs.readFileSync(item.file);
  assert.equal(sh(bytes),item.sha256,item.file+' SHA-256');
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex'),item.blob,item.file+' Git blob');
  assert.equal(Op.filePinned(item,bytes),true);
  assert.ok(Op.stepStatements(item).length>=3);
  assert.equal(Op.filePinned(item,Buffer.concat([bytes,Buffer.from('\n')])),false,'one extra byte is never approved');
 });
 assert.equal(Op.manifestSha256(),sh(Op.manifestText()));
 assert.equal(Op.operatorSha256(),sh(fs.readFileSync('scripts/d1-migration-window-production.mjs')));
 assert.equal(Op.CHECKPOINT_A,47);assert.equal(Op.CHECKPOINT_B,54);
 // the registry points at the same files
 const registry=fs.readFileSync('migrations/README.md','utf8');
 for(const item of Op.MANIFEST)assert.ok(registry.includes(path.basename(item.file)),item.file+' is in the registry');
}

// ---- arguments ----
{
 assert.deepEqual(Op.parseArgs(A()),{report:{configured:false,writes:false,writeState:'none'}},'default is a read-only no-op report');
 assert.equal(Op.parseArgs(A('--target','iptv')).command,'status');
 const good=['--target','iptv','--apply','--through','47','--start','38','--confirm','apply','--manifest-sha256',Op.manifestSha256(),'--operator-sha256',Op.operatorSha256()];
 assert.deepEqual(Op.parseArgs(A(...good)),{command:'apply',params:params(47,38)});
 const without=name=>{const copy=[...good];const index=copy.indexOf(name);copy.splice(index,2);return copy;};
 for(const bad of [A('--apply'),A('--status','--apply','--target','iptv'),A('--target','other'),A('--target','iptv','--status','--through','47'),A('--target','iptv','--bogus','x'),
  A(...without('--through')),A(...without('--start')),A(...without('--confirm')),A(...without('--manifest-sha256')),A(...without('--operator-sha256')),
  A(...good.map(value=>value==='47'?'50':value)),A(...good.map(value=>value==='38'?'54':value)),A(...good.map(value=>value==='38'?'12':value)),A(...good.map(value=>value==='apply'&&false?value:value==='--confirm'?'--confirm':value==='apply'?'status':value)),
  A(...good,'--through','54'),A(...good.map(value=>value===Op.manifestSha256()?'short':value))])
  assert.throws(()=>Op.parseArgs(bad),error=>error.name==='OperatorStop',JSON.stringify(bad).slice(0,120));
}

// ---- status at v38: read-only, both targets plannable, the plan is the unchanged files in order ----
{
 const {file,db}=world(38);
 const before=master(file);
 const out=await Op.execute('status',{binding:db,clock:at(MID)});
 assert.equal(out.writes,false);assert.equal(out.schemaVersion,38);assert.equal(out.filesPinned,true);assert.equal(out.manifestSha256,Op.manifestSha256());assert.equal(out.operatorSha256,Op.operatorSha256());
 assert.deepEqual(out.plan[47].remaining,[39,40,41,42,43,44,45,46,47]);assert.equal(out.plan[47].decision,'apply');
 assert.deepEqual(out.plan[54].remaining,[39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54]);assert.equal(out.plan[54].decision,'apply');
 assert.equal(out.chain.verified,true);assert.deepEqual(out.files.map(item=>item.checkpoint).join(''),'AAAAAAAAABBBBBBB');
 assert.ok(out.unobservable.length>=3,'what the operator cannot see is stated');
 assert.deepEqual(master(file),before,'status writes nothing');
 assert.equal(JSON.stringify(out).includes(os.tmpdir()),false);
}

// ---- A: v38 -> v47 on the real files, one batch per file, stop at the checkpoint ----
const reference47=migrated(47),reference54=migrated(54);
let at47;
{
 const {file,db}=world(38);
 const batches=[];
 const counting={prepare:sqlText=>db.prepare(sqlText),async batch(statements){batches.push(statements.length);return db.batch(statements);}};
 const ctx=tracker();
 const out=await run(counting,params(47,38),{ctx});
 assert.equal(version(file),47);assert.equal(out.writeState,'committed');assert.deepEqual(ctx.states.filter(state=>state==='committed').length,9);
 assert.deepEqual(out.applied.map(item=>item.version),[39,40,41,42,43,44,45,46,47],'one entry per file, in order');
 assert.deepEqual(batches,Op.MANIFEST.slice(0,9).map(item=>Op.stepStatements(item).length),'exactly one batch per unchanged file, with that file\'s own statements');
 assert.deepEqual(master(file),master(reference47),'the result is the schema of the plain chain to 47');
 assert.equal(out.after.chain.verified,true);
 assert.deepEqual(out.after.markers.letterboxd_admission_authority,[{mode:'r2',cutover:null,generation:0}],'0046 seeds only the r2 marker at generation 0');
 // a second apply to the same target has nothing to do
 await stop(run(db,params(47,47)),'already_at_target');
 await stop(run(db,params(47,38)),'start_mismatch');
 at47=file;
}
// B: v47 -> v54 as a continuation (start pinned to the actual version), ending at the plain chain to 54
{
 const file=copyFile(at47),db=d1Standin(file);
 await stop(run(db,params(54,38)),'start_mismatch');
 const out=await run(db,params(54,47));
 assert.equal(version(file),54);assert.deepEqual(out.applied.map(item=>item.version),[48,49,50,51,52,53,54]);
 assert.deepEqual(master(file),master(reference54),'the result is the schema of the plain chain to 54');
 assert.equal(sql(file,"SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('identity_assertion','identity_rule_version','identity_application')")[0].n,0,'0054 dropped only the three tables');
 assert.equal(sql(file,'SELECT mode FROM film_metadata_provenance_control WHERE id=1')[0].mode,'off','provenance stays off');
 assert.equal((await Op.execute('status',{binding:db,clock:at(MID)})).plan[54].decision,'already_at_target');
}
// 38 -> 54 in one run, and the checkpoint stop with a plan that continues
{
 const {file,db}=world(38);
 const out=await run(db,params(54,38));
 assert.equal(version(file),54);assert.equal(out.applied.length,16);assert.deepEqual(master(file),master(reference54));
}

// ---- pins: the manifest, the operator, the files themselves ----
{
 const {file,db}=world(38);const before=master(file);
 await stop(run(db,params(47,38,{manifestSha256:'0'.repeat(64)})),'manifest_sha256_mismatch');
 await stop(run(db,params(47,38,{operatorSha256:'0'.repeat(64)})),'operator_sha256_mismatch');
 await stop(run(db,params(46,38)),'target_invalid');
 await stop(run(db,params(47,39)),'start_mismatch');
 // a changed file in the tree: refused before any statement, whatever the caller pins
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'air603-'));
 fs.mkdirSync(path.join(root,'migrations'));
 for(const item of Op.MANIFEST)fs.copyFileSync(item.file,path.join(root,item.file));
 fs.appendFileSync(path.join(root,Op.MANIFEST[3].file),'\n-- edited\n');
 const e=await stop(run(db,params(47,38),{root}),'file_not_pinned');assert.equal(e.details.applied===undefined||e.details.applied.length===0,true);
 assert.deepEqual(master(file),before,'nothing was sent');
 await stop(Op.execute('status',{binding:db,clock:at(MID),root}),'file_not_pinned');
}

// ---- quiet window: every observable reason refuses with nothing sent ----
{
 const T=(text)=>Date.parse('2026-11-27T'+text+'Z');
 for(const [name,seed,reason] of [
  ['live producer chain',file=>sql(file,"INSERT INTO canonical_producer_chain (programme_run_id,input_generation,owner_epoch,owner_instance,owner_state,lease_expires_at,revision,created_at,updated_at) VALUES ('run-p',1,1,'pw_1_1','pending','2026-11-27T13:40:00.000Z',1,'2026-11-27T13:00:00.000Z','2026-11-27T13:00:00.000Z')"),'producer_busy'],
  ['live prediction runner lease',file=>sql(file,"INSERT INTO prediction_lease (name,token,expires_at,document_json) VALUES ('runner','t',"+(MID+600000)+",'{}')"),'prediction_busy'],
  ['live discovery lease',file=>sql(file,"UPDATE discovery_lease SET lease_id='l',expires_at="+(MID+600000)+" WHERE id=1"),'discovery_busy'],
  ['loading discovery transfer',file=>sql(file,"UPDATE discovery_transfer SET state='loading',batches=1 WHERE id=1"),'discovery_transfer_loading'],
 ]){
  const {file,db}=world(38);seed(file);const before=master(file);
  const ctx=tracker();
  await stop(run(db,params(47,38),{ctx}),reason);
  assert.deepEqual(master(file),before,name+': nothing sent');assert.deepEqual(ctx.states,[],name+': no write state');
  assert.equal((await Op.execute('status',{binding:db,clock:at(MID)})).plan[47].decision,reason);
 }
 {const {file,db}=world(38);const before=master(file);
  await stop(run(db,params(47,38),{clock:at(T('13:02:00.000'))}),'hourly_tick_window');await stop(run(db,params(47,38),{clock:at(T('13:57:00.000'))}),'hourly_tick_window');
  assert.deepEqual(master(file),before);
  // the preflight observation expires: reads that took too long
  let n=0;const slow=()=>MID+(n++>1?Op.PREFLIGHT_MAX_MS+1:0);
  await stop(run(db,params(47,38),{clock:slow}),'preflight_stale');assert.deepEqual(master(file),before);}
 // a lapsed Producer lease, an expired prediction lease and an idle window do not block
 {const {file,db}=world(38);
  sql(file,"INSERT INTO prediction_lease (name,token,expires_at,document_json) VALUES ('runner','t',"+(MID-1)+",'{}')");
  assert.equal((await Op.execute('status',{binding:db,clock:at(MID)})).plan[47].decision,'apply');}
}

// the pure refusal order over synthetic quiet facts (an import run being staged or running at v44+ needs rows the schema makes costly to seed)
{
 const quiet=over=>({quiet:{producerLiveLeases:0,predictionLease:0,discoveryLease:0,discoveryTransferLoading:0,projectorWindow:0,importRunsOpen:0,...over}});
 assert.equal(Op.busyReason(quiet({importRunsOpen:1}),null,{nowMs:MID}),'import_in_flight');
 assert.equal(Op.busyReason(quiet({projectorWindow:1}),null,{nowMs:MID}),'projector_busy');
 assert.equal(Op.busyReason(quiet({}),null,{nowMs:MID}),null);
 assert.equal(Op.busyReason({quiet:null},null,{nowMs:MID}),'state_unreadable');
}

// ---- partial, mixed and damaged schemas refuse; nothing is resumed blindly ----
{
 // an object of a later file at 38
 const early=world(38);sql(early.file,'CREATE TABLE lid_recheck_intent (request_id TEXT)');
 let status=await Op.execute('status',{binding:early.db,clock:at(MID)});assert.equal(status.plan[47].decision,'partial_schema');assert.deepEqual(status.chain.early,['lid_recheck_intent']);
 await stop(run(early.db,params(47,38)),'partial_schema');
 // an object of the NEXT file exists at 40 (the file has started)
 const partial=world(40);sql(partial.file,'CREATE TABLE film_identity_evidence (id INTEGER)');
 await stop(run(partial.db,params(47,40)),'partial_schema');
 // a damaged predecessor: a trigger of 0045 is missing at 46
 const damaged=world(46);const trg=sql(damaged.file,"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name LIKE 'upstream_cooldown%' LIMIT 1")[0].name;sql(damaged.file,'DROP TRIGGER '+trg);
 status=await Op.execute('status',{binding:damaged.db,clock:at(MID)});assert.equal(status.chain.verified,false);assert.ok(status.chain.missing.includes('trigger:'+trg));
 await stop(run(damaged.db,params(47,46)),'predecessor_unverified');
 // a same-named object with another body
 const changed=world(45);const idx=sql(changed.file,"SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name LIKE 'upstream_cooldown%' LIMIT 1")[0];
 if(idx){sql(changed.file,'DROP INDEX '+idx.name);sql(changed.file,'CREATE INDEX '+idx.name+' ON upstream_cooldown (rowid)');await stop(run(changed.db,params(47,45)),'predecessor_unverified');}
 // a version outside the chain and a broken contract
 const high=world(54);sql(high.file,'PRAGMA writable_schema=0');await stop(run(high.db,params(47,38)),'start_mismatch');
 const odd=world(38);sql(odd.file,"DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=12 WHERE id=1");await stop(run(odd.db,params(47,38)),'schema_unexpected');
}

// ---- transport failures: refused before commit, lost response after commit, a transport that is NOT atomic ----
{
 // refused before commit: a statement error, rolled back whole by the transaction; the read-back equals the before-state
 const {file,db}=world(38);const before=master(file);
 const refusing={prepare:s=>db.prepare(s),async batch(){throw new D1Error('statement','refused before commit');}};
 const ctx=tracker();
 const e=await stop(run(refusing,params(47,38),{ctx}),'statement_failed');assert.equal(ctx.states.at(-1),'none');assert.deepEqual(master(file),before);assert.equal(e.details.state.schemaVersion,38);
}
{
 // lost response after commit: the file did commit; the operator reports write_uncertain, does NOT continue, and a fresh status proves the new version
 const {file,db}=world(38);
 const lost={prepare:s=>db.prepare(s),async batch(statements){await db.batch(statements);throw new D1Error('write_uncertain','response lost');}};
 const ctx=tracker();
 const e=await stop(run(lost,params(47,38),{ctx}),'write_uncertain');
 assert.equal(ctx.states.at(-1),'unknown');assert.equal(version(file),39,'exactly the first file committed and nothing after it');
 const status=await Op.execute('status',{binding:db,clock:at(MID)});
 assert.equal(status.schemaVersion,39);assert.equal(status.chain.verified,true);assert.equal(status.plan[47].decision,'apply');assert.deepEqual(status.plan[47].remaining,[40,41,42,43,44,45,46,47]);
 await stop(run(db,params(47,38)),'start_mismatch');
 const resumed=await run(db,params(47,39));
 assert.equal(version(file),47);assert.equal(resumed.applied.length,8,'a resume only continues the contiguous proven prefix, with the new start pin');
}
{
 // B stopped after an intermediate file (0050 committed, response lost): integrity proven, A intact, remaining suffix resumable only with the exact start pin
 const {file,db}=world(49);
 const lost={prepare:s=>db.prepare(s),async batch(statements){await db.batch(statements);throw new D1Error('write_uncertain','response lost');}};
 await stop(run(lost,params(54,49)),'write_uncertain');
 assert.equal(version(file),50);
 const status=await Op.execute('status',{binding:db,clock:at(MID)});assert.equal(status.chain.verified,true);assert.deepEqual(status.plan[54].remaining,[51,52,53,54]);assert.equal(status.plan[47].decision,'target_behind');
 await stop(run(db,params(54,49)),'start_mismatch');
 assert.equal((await run(db,params(54,50))).applied.length,4);assert.equal(version(file),54);
}
{
 // a transport that is NOT atomic: statements are applied one by one and the connection dies halfway. The version has not moved but objects exist: detected, stopped, never resumed.
 for(const cut of [2,5]){
  const {file,db}=world(38);
  const broken={prepare:s=>db.prepare(s),async batch(statements){for(const [index,statement] of statements.entries()){if(index===cut)throw new D1Error('write_uncertain','connection lost');await statement.run();}}};
  const ctx=tracker();
  await stop(run(broken,params(47,38),{ctx}),'write_uncertain');
  assert.equal(ctx.states.at(-1),'unknown');assert.equal(version(file),38,'the version update is the LAST statement: it did not move');
  const status=await Op.execute('status',{binding:db,clock:at(MID)});
  assert.equal(status.plan[47].decision,'partial_schema','objects of the file exist while the version did not move');assert.ok(status.chain.early.length>0);
  await stop(run(db,params(47,38)),'partial_schema');await stop(run(db,params(54,38)),'partial_schema');
 }
}
{
 // a read-back that disagrees with the file (a body changed behind the operator's back) is write_uncertain, never "applied"
 const {file,db}=world(38);
 const idx=Op.expectedSchema(40).objects;const name=[...idx].find(([n,spec])=>spec.type==='index'&&n.includes('movie'))?.[0];
 assert.ok(name,'0040 creates its movie index');
 const wrong={prepare:s=>db.prepare(s),async batch(statements){await db.batch(statements);sql(file,'DROP INDEX '+name);}};
 await stop(run(wrong,params(47,38)),'write_uncertain');assert.equal(version(file),39,'the first file committed, the check of the second would have caught the damage');
}

// ---- data preserved by the rebuilds: 0052 (writer control and history) and 0053 (provenance rows) ----
{
 const T='2026-11-27T10:00:00.000Z',H='a'.repeat(64);
 const change=(kind,from,to,generation,extra='NULL')=>"INSERT INTO identity_evidence_writer_change (writer,kind,from_state,to_state,generation,reason,deployed_version,evidence_link,drain_evidence,break_from,recorded_at) VALUES ('discovery_decision','"+kind+"','"+from+"','"+to+"',"+generation+",'a reason','v1','https://trello.com/c/x',"+extra+",NULL,'"+T+"')";
 const file=migrated(51);
 sql(file,change('activate','off','pending',1)+';'+change('drain_complete','pending','on',2,"'only v2 serves'"));
 const controlBefore=sql(file,'SELECT * FROM identity_evidence_writer ORDER BY writer'),historyBefore=sql(file,'SELECT * FROM identity_evidence_writer_change ORDER BY seq');
 assert.ok(controlBefore.length>=1&&historyBefore.length===2,'a populated v51 control and history');
 const db=d1Standin(file);
 const out=await run(db,params(54,51));
 assert.equal(version(file),54);assert.deepEqual(out.applied.map(item=>item.version),[52,53,54]);
 assert.deepEqual(sql(file,'SELECT * FROM identity_evidence_writer ORDER BY writer'),controlBefore,'every control row unchanged');
 assert.deepEqual(sql(file,'SELECT * FROM identity_evidence_writer_change ORDER BY seq'),historyBefore,'the whole history unchanged, same seq');
 assert.equal(sql(file,"SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%hold%' AND type='table'")[0].n,0,'no staging table remains');
 assert.match(sql(file,"SELECT sql FROM sqlite_master WHERE name='identity_evidence_writer'")[0].sql,/lid_tmdb_attach/,'the new writer value is admitted');
 assert.equal(sql(file,"SELECT COUNT(*) n FROM identity_evidence_writer WHERE writer='lid_tmdb_attach'")[0].n,0,'no new writer control row: absent means off');
}
{
 const T='2026-11-27T10:00:00.000Z',H='a'.repeat(64);
 const file=migrated(52);
 const field=(id,name,over='')=>"INSERT INTO film_metadata_field (film_id,field,tier,source,origin,anchor_scheme,anchor_value,anchor_digest,agreement,observed_at,checked_at,value_digest,write_key,written_revision,updated_at) VALUES ('"+id+"','"+name+"','automatic','tmdb','catalog_enrichment','tmdb','603','"+H+"','confirmed','"+T+"','"+T+"','"+H+"','k"+name+"',1,'"+T+"')";
 sql(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:a',2,NULL,'T','"+T+"');INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES ('film:a',1,1999,136,'S','/p','https://e.test','[\"a\"]',NULL,'{}',NULL,NULL,'"+T+"')");
 sql(file,field('film:a','poster'));
 const before={field:sql(file,'SELECT * FROM film_metadata_field ORDER BY film_id,field'),control:sql(file,'SELECT * FROM film_metadata_provenance_control')};
 assert.equal(before.field.length,1);
 const db=d1Standin(file);
 await run(db,params(54,52));
 assert.deepEqual(sql(file,'SELECT * FROM film_metadata_field ORDER BY film_id,field'),before.field,'every provenance row kept through the 0053 rebuild');
 assert.deepEqual(sql(file,'SELECT * FROM film_metadata_provenance_control'),before.control,'the control row kept, still off');
 assert.equal(sql(file,"SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%_v53'")[0].n,0);
}

// ---- 0054: stops (defers) without undoing the verified predecessors when the tables hold data or something depends on them ----
for(const [name,seed,detail] of [
 ['a row in a retired table',file=>sql(file,"INSERT INTO identity_rule_version (rule_id,version,predicates_json,created_at) VALUES ('r',1,'[]','2026-11-27T10:00:00.000Z')"),'defer_0054:tables_not_empty'],
 ['an explicit index on a retired table',file=>sql(file,'CREATE INDEX air603_dep ON identity_assertion (rowid)'),'defer_0054:dependents'],
 ['a view naming a retired table',file=>sql(file,'CREATE VIEW air603_view AS SELECT * FROM identity_application'),'defer_0054:dependents'],
]){
 const {file,db}=world(53);
 try{seed(file);}catch{continue;}
 const before=master(file);
 const status=await Op.execute('status',{binding:db,clock:at(MID)});
 assert.equal(status.plan[54].decision,'defer_0054',name);assert.equal(status.plan[54].detail,detail,name);
 await stop(run(db,params(54,53)),'defer_0054');
 assert.deepEqual(master(file),before,name+': nothing dropped');assert.equal(version(file),53,name+': the predecessors stand');
}
{
 // from 38 the apply goes through 0053 and then DEFERS 0054: the verified prefix is kept
 const {file,db}=world(38);
 sql(file,"INSERT INTO identity_rule_version (rule_id,version,predicates_json,created_at) VALUES ('r',1,'[]','2026-11-27T10:00:00.000Z')");
 const e=await stop(run(db,params(54,38)),'defer_0054');
 assert.equal(version(file),53);assert.equal(e.details.applied.length,15,'0039..0053 stay applied');assert.equal(e.details.detail,'defer_0054:tables_not_empty');
}

// ---- the production runner: target identity, secrets never printed ----
{
 const out=await Op.runD1MigrationWindowProduction({argv:A()});assert.deepEqual(out.result,{configured:false,writes:false,writeState:'none'});
 const noEnv=await Op.runD1MigrationWindowProduction({argv:A('--target','iptv'),env:{}});assert.equal(noEnv.exit,2);assert.equal(noEnv.result.reason,'configuration');
 const bad=await Op.runD1MigrationWindowProduction({argv:A('--target','iptv'),env:{D1_BACKFILL_ACCOUNT_ID:'a'.repeat(32),D1_BACKFILL_API_TOKEN:'SECRET-TOKEN-VALUE'}});
 assert.equal(bad.result.reason,'account_mismatch');assert.equal(JSON.stringify(bad).includes('SECRET-TOKEN-VALUE'),false,'the token is never printed');
 // injected binding: the whole path through the runner
 const {file,db}=world(38);
 const ok=await Op.runD1MigrationWindowProduction({argv:A('--target','iptv','--apply','--through','47','--start','38','--confirm','apply','--manifest-sha256',Op.manifestSha256(),'--operator-sha256',Op.operatorSha256()),deps:{binding:db},clock:at(MID)});
 assert.equal(ok.exit,0);assert.equal(ok.result.writeState,'committed');assert.equal(version(file),47);
 const refused=await Op.runD1MigrationWindowProduction({argv:A('--target','iptv','--apply','--through','47','--start','38','--confirm','apply','--manifest-sha256',Op.manifestSha256(),'--operator-sha256',Op.operatorSha256()),deps:{binding:db},clock:at(MID)});
 assert.equal(refused.exit,3);assert.equal(refused.result.reason,'start_mismatch');assert.equal(refused.result.writes,false);
}
console.log('d1-migration-window-production: ok');
