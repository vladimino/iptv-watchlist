// AIR-603: the owner-only operator of the single D1 migration window v38 -> v47 (checkpoint A) -> v54 (checkpoint B), scripts/d1-migration-window-production.mjs.
// Offline only: scratch sqlite databases built from the real migration files. No production database is opened, no credential is used, nothing is applied anywhere.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
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
 // only the approved 39..54 slice: a later, legitimate migration must not break this test (the status reports `treeBeyondManifest` for the planner instead)
 const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))>38&&Number(name.slice(0,4))<=54).sort();
 assert.deepEqual(files,Op.MANIFEST.map(item=>path.basename(item.file)),'the manifest names exactly the approved 39..54 slice');
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
 fs.mkdirSync(path.join(root,'scripts'));fs.copyFileSync('scripts/d1-migration-window-reference.json',path.join(root,'scripts/d1-migration-window-reference.json'));
 for(const item of Op.MANIFEST)fs.copyFileSync(item.file,path.join(root,item.file));
 fs.appendFileSync(path.join(root,Op.MANIFEST[3].file),'\n-- edited\n');
 const e=await stop(run(db,params(47,38),{root}),'file_not_pinned');assert.equal(e.details.applied===undefined||e.details.applied.length===0,true);
 assert.deepEqual(master(file),before,'nothing was sent');
 assert.equal((await Op.execute('status',{binding:db,clock:at(MID),root})).filesPinned,false,'the status says so');
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
 // an extra object that is NOT what a later file creates is an unverified schema; one that equals what a later file creates is a started file (partial)
 const early=world(38);sql(early.file,'CREATE TABLE lid_recheck_intent (request_id TEXT)');
 let status=await Op.execute('status',{binding:early.db,clock:at(MID)});assert.equal(status.plan[47].decision,'predecessor_unverified');assert.deepEqual(status.chain.extra,['table:lid_recheck_intent']);
 await stop(run(early.db,params(47,38)),'predecessor_unverified');
 const started=world(38);sql(started.file,Op.stepStatements(Op.stepOf(39)).slice(1,2).map(text=>text+';').join(''));
 status=await Op.execute('status',{binding:started.db,clock:at(MID)});assert.equal(status.plan[47].decision,'partial_schema');assert.ok(status.chain.early.length>0,'the ALTER of 0039 equals the reference of v39');
 await stop(run(started.db,params(47,38)),'partial_schema');
 // an object of the NEXT file with another body exists at 40: not what the file creates, so unverified (a started file is covered below with the real statements)
 const partial=world(40);sql(partial.file,'CREATE TABLE film_identity_evidence (id INTEGER)');
 await stop(run(partial.db,params(47,40)),'predecessor_unverified');
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
 const name=[...Op.loadReference().at.get(40)].find(([n,spec])=>spec[0]==='index'&&n.includes('movie')&&!Op.loadReference().at.get(39).has(n))?.[0];
 assert.ok(name,'0040 creates its movie index');
 const wrong={prepare:s=>db.prepare(s),async batch(statements){await db.batch(statements);sql(file,'DROP INDEX '+name);}};
 await stop(run(wrong,params(47,38)),'write_uncertain');assert.equal(version(file),39,'the first file committed, the check of the second would have caught the damage');
}

// ---- data preserved by the rebuilds: 0052 (writer control and history) and 0053 (provenance rows) ----
{
 const T='2026-11-27T10:00:00.000Z',H='a'.repeat(64);
 const change=(kind,from,to,generation,extra='NULL')=>"INSERT INTO identity_evidence_writer_change (writer,kind,from_state,to_state,generation,reason,deployed_version,evidence_link,drain_evidence,break_from,recorded_at) VALUES ('discovery_decision','"+kind+"','"+from+"','"+to+"',"+generation+",'a reason','v1','https://trello.com/c/x',"+extra+",NULL,'"+T+"')";
 const file=migrated(51);
 // the dormant baseline needs every writer off: this one went off -> pending -> on -> off, so a control row and a three-entry history exist
 sql(file,change('activate','off','pending',1)+';'+change('drain_complete','pending','on',2,"'only v2 serves'")+';'+change('deactivate','on','off',3));
 const controlBefore=sql(file,'SELECT * FROM identity_evidence_writer ORDER BY writer'),historyBefore=sql(file,'SELECT * FROM identity_evidence_writer_change ORDER BY seq');
 assert.ok(controlBefore.length>=1&&historyBefore.length===3&&controlBefore[0].state==='off','a populated v51 control and history');
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
 ['an explicit index on a retired table',file=>sql(file,'CREATE INDEX air603_dep ON identity_assertion (observation_key)'),'defer_0054:dependents'],
 ['a view naming a retired table',file=>sql(file,'CREATE VIEW air603_view AS SELECT 1 AS x FROM identity_application'),'defer_0054:dependents'],
]){
 const {file,db}=world(53);
 seed(file);// a seed that fails fails the test: no silent skip
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

// ---- the status is the exact reference, not version + names (review of PR #1056) ----
{
 // the pinned reference is exactly what the unchanged files produce on a scratch SQLite
 const {buildReference,serialize}=await import('../scripts/d1-migration-window-reference.mjs');
 assert.equal(serialize(buildReference()),fs.readFileSync('scripts/d1-migration-window-reference.json','utf8'),'the committed reference equals the regenerated one: run scripts/d1-migration-window-reference.mjs --write after a migration change');
 assert.equal(Op.manifestText().includes('reference '+Op.referenceSha256()),true,'the manifest digest covers the reference');
 // the stored CREATE text is rewritten with the sqlite3 shell's testing switch (the way a damaged or hand-edited database would differ); a rewrite that changes nothing fails the test
 const rewrite=(file,name,from,to)=>{
  const input="PRAGMA writable_schema=1;UPDATE sqlite_master SET sql=replace(sql,'"+from.replace(/'/g,"''")+"','"+to.replace(/'/g,"''")+"') WHERE name='"+name+"';SELECT changes();";
  const result=spawnSync('sqlite3',['-unsafe-testing',file],{input,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const changedBody=sql(file,"SELECT instr(sql,'"+from.replace(/'/g,"''")+"') AS at FROM sqlite_master WHERE name='"+name+"'")[0].at;
  assert.equal(changedBody,0,'the fixture really changed '+name);
 };
 const refusesWithoutWrite=async(w,reason,check)=>{
  const before=master(w.file);
  const out=await Op.execute('status',{binding:w.db,clock:at(MID)});
  assert.equal(out.chain.verified,false);check?.(out.chain);
  const ctx=tracker();
  await stop(run(w.db,params(47,out.schemaVersion),{ctx}),reason);
  assert.deepEqual(ctx.states,[],'no batch was sent');assert.deepEqual(master(w.file),before,'nothing changed');
 };
 // a required v38 base object is missing: the version alone never certifies the predecessor
 {const w=world(38);sql(w.file,'DROP TABLE canonical_producer_outcome');await refusesWithoutWrite(w,'predecessor_unverified',chain=>assert.ok(chain.missing.includes('table:canonical_producer_outcome')));}
 // a base v38 object with another body (a loosened constraint of a base table)
 {const w=world(38);rewrite(w.file,'canonical_producer_outcome',"state TEXT NOT NULL CHECK","state TEXT NOT NULL /*x*/ CHECK (1) CHECK");
  const out=await Op.execute('status',{binding:w.db,clock:at(MID)});assert.equal(out.chain.verified,false,'a changed base table body is detected');}
 // 0039's ALTERed column: its CHECK/body is compared, not a regex for the column name
 {const w=world(40);rewrite(w.file,'canonical_write_receipt',"CHECK ((state IN ('applied', 'abandoned')) = (settled_at IS NOT NULL))","CHECK (1)");
  await refusesWithoutWrite(w,'predecessor_unverified',chain=>assert.deepEqual(chain.changed,['table:canonical_write_receipt']));}
 // 0042's nulled ledger text is no longer accepted blindly: the ALTERed ledger table is compared too
 {const w=world(45);rewrite(w.file,'film_identity_evidence',"source_order INTEGER CHECK (source_order IS NULL OR source_order >= 1)","source_order INTEGER");
  await refusesWithoutWrite(w,'predecessor_unverified',chain=>assert.deepEqual(chain.changed,['table:film_identity_evidence']));}
 // a renamed v53 table with the wrong body, and one with a wrong constraint, are not certified, and cannot advance to 54
 {const w=world(53);rewrite(w.file,'film_metadata_field',"CHECK (field IN ('year', 'runtime', 'synopsis', 'poster', 'url', 'genres'))","CHECK (1)");
  const before=master(w.file);
  await refusesWithoutWrite(w,'predecessor_unverified',chain=>assert.deepEqual(chain.changed,['table:film_metadata_field']));
  await stop(run(w.db,params(54,53)),'predecessor_unverified');assert.deepEqual(master(w.file),before);}
 // a transient table that a later file drops again (the 0053 staging table) left at v47: a started file, reported although the fold of "future objects" would lose it
 {const w=world(47);sql(w.file,'CREATE TABLE film_metadata_field_v53 (film_id TEXT)');
  const out=await Op.execute('status',{binding:w.db,clock:at(MID)});assert.ok(out.chain.extra.includes('table:film_metadata_field_v53'));assert.ok(out.chain.early.includes('table:film_metadata_field_v53'));
  assert.equal(out.plan[54].decision,'partial_schema');await stop(run(w.db,params(54,47)),'partial_schema');}
 // string literals are compared verbatim: a changed case inside an index predicate or CHECK is a different constraint (it accepted two pending rows for one operation key)
 {assert.notEqual(Op.normalizeSql("state IN ('pending', 'failed')"),Op.normalizeSql("state IN ('PENDING', 'failed')"));
  assert.notEqual(Op.normalizeSql("x NOT GLOB '*[^a-z]*'"),Op.normalizeSql("x NOT GLOB '*[^A-Z]*'"));
  assert.equal(Op.normalizeSql('CREATE TABLE IF NOT EXISTS "A_b" (x TEXT -- c\n)'),Op.normalizeSql('create table a_b(x text)'),'harmless formatting (comments, spacing, quoting, case outside literals, IF NOT EXISTS) is still ignored');
  const w=world(40);
  const index=sql(w.file,"SELECT name,sql FROM sqlite_master WHERE type='index' AND name='canonical_write_receipt_operation_unresolved'")[0];
  assert.ok(index&&index.sql.includes("'pending'"),'the real partial index of the operation-key guarantee exists');
  rewrite(w.file,'canonical_write_receipt_operation_unresolved',"'pending'","'PENDING'");
  await refusesWithoutWrite(w,'predecessor_unverified',chain=>assert.deepEqual(chain.changed,['index:canonical_write_receipt_operation_unresolved']));}
 // a known IF NOT EXISTS definition is compared as stored: the downgrade trigger replaced by a weaker body
 {const w=world(40);sql(w.file,"DROP TRIGGER schema_contract_no_downgrade;CREATE TRIGGER schema_contract_no_downgrade BEFORE UPDATE OF version ON schema_contract BEGIN SELECT 1; END");
  await refusesWithoutWrite(w,'predecessor_unverified',chain=>assert.deepEqual(chain.changed,['trigger:schema_contract_no_downgrade']));}
}

// ---- fail closed: missing or malformed facts, and a dormant baseline ----
{
 const mid=Object.fromEntries(Op.REQUIRED_QUIET.map(([key])=>[key,0]));
 assert.equal(Op.busyReason({schemaVersion:47,quiet:mid},null,{nowMs:MID}),null,'all facts present and idle');
 for(const [key,,since] of Op.REQUIRED_QUIET){
  const quiet={...mid};delete quiet[key];
  assert.equal(Op.busyReason({schemaVersion:Math.max(since,38),quiet},null,{nowMs:MID}),'state_unreadable','a missing '+key+' is never idle');
  assert.equal(Op.busyReason({schemaVersion:Math.max(since,38),quiet:{...mid,[key]:null}},null,{nowMs:MID}),'state_unreadable');
 }
 assert.equal(Op.busyReason({schemaVersion:40,quiet:{...mid,importRunsOpen:undefined}},null,{nowMs:MID}),null,'importRunsOpen is required only from 44');
 // a malformed read answer stops as unknown_state, with nothing sent
 const {file,db}=world(38);const before=master(file);
 const malformed=pattern=>({prepare:text=>({bind:(...a)=>{const bound=db.prepare(text).bind(...a);return {...bound,async all(){return pattern.test(text)?{}:bound.all();}};}}),batch:()=>{throw new Error('must not write');}});
 for(const pattern of [/FROM prediction_lease/,/FROM discovery_lease/,/FROM projector_window/,/schema_contract/,/sqlite_master/])await stop(Op.execute('status',{binding:malformed(pattern),clock:at(MID)}),'unknown_state');
 const empty=text=>({prepare:t=>({bind:(...a)=>{const bound=db.prepare(t).bind(...a);return {...bound,async all(){return text.test(t)?{results:[]}:bound.all();}};}}),batch:()=>{throw new Error('must not write');}});
 await stop(Op.execute('status',{binding:empty(/COUNT\(\*\) AS n FROM prediction_lease/),clock:at(MID)}),'unknown_state');
 assert.deepEqual(master(file),before);
}
{
 // an actual state that is not the dormant one is NOT accepted as the start of a file, at A or at B
 for(const [name,upTo,seed,problem] of [
  ['an admission marker that is not r2/0',46,file=>sql(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1"),'letterboxd_admission_authority:not_r2_generation_0'],
  ['an active enrichment scope',47,file=>sql(file,"INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'2026-11-26T10:00:00.000Z','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'2026-11-26T10:00:00.000Z')"),'catalog_enrichment_scope:activated_or_enabled'],
  ['provenance control not off',52,file=>sql(file,"UPDATE film_metadata_provenance_control SET mode='enforce',revision=2"),'film_metadata_provenance_control:not_off'],
 ]){
  const w=world(upTo);
  try{seed(w.file);}catch(error){assert.fail(name+': the fixture seed failed: '+error.message);}
  const before=master(w.file);
  const status=await Op.execute('status',{binding:w.db,clock:at(MID)});
  assert.equal(status.dormantBaseline.ok,false,name);assert.ok(status.dormantBaseline.problems.some(text=>text.startsWith(problem.split(':')[0])),name+' '+JSON.stringify(status.dormantBaseline));
  const e=await stop(run(w.db,params(upTo>=47?54:47,upTo)),'baseline_not_dormant');assert.match(e.details.detail,new RegExp(problem.split(':')[0]),name);
  assert.deepEqual(master(w.file),before,name+': nothing sent');
 }
}
{
 // freshness is measured from when the observation BEGAN: a slow readback of the first file does not make the old lease observations of the next file fresh
 const {file,db}=world(38);
 let slow=false,now=MID;
 const binding={prepare:text=>db.prepare(text),async batch(statements){await db.batch(statements);slow=true;}};
 // the clock advances by 25 s on every call once the first file is written: the second file's own observation and its boundary are then more than 60 s apart
 const clock=()=>{if(slow)now+=25000;return now;};
 const e=await stop(run(binding,params(47,38),{clock}),'preflight_stale');
 assert.equal(version(file),39,'only the first file was applied');assert.equal(e.details.applied.length,1);assert.ok(e.details.elapsedMs>Op.PREFLIGHT_MAX_MS);
}

// ---- every exit reports what already happened (runner level) ----
{
 const bookmarks=['bookmark-before','bookmark-after'];let calls=0;
 const deps=binding=>({binding,bookmark:async()=>bookmarks[Math.min(calls++,1)]});
 const argv=A('--target','iptv','--apply','--through','47','--start','38','--confirm','apply','--manifest-sha256',Op.manifestSha256(),'--operator-sha256',Op.operatorSha256());
 for(const [name,failure,outcome,state] of [
  ['a refusal before commit',()=>{throw new D1Error('statement','refused before commit');},'not_applied','committed'],
  ['a lost response after commit',async(db,statements)=>{await db.batch(statements);throw new D1Error('write_uncertain','response lost');},'unknown','unknown'],
 ]){
  calls=0;
  const {file,db}=world(38);
  let n=0;const sent=[];
  const binding={prepare:text=>db.prepare(text),async batch(statements){sent.push(statements.length);n++;if(n===1)return db.batch(statements);return failure(db,statements);}};
  const {exit,result}=await Op.runD1MigrationWindowProduction({argv,deps:deps(binding),clock:at(MID)});
  assert.equal(exit,3,name);assert.equal(sent.length,2,name+': no later batch after the second');
  assert.notEqual(result.writes,false,name+': writes is never false after a commit');assert.equal(result.writeState,state,name);assert.equal(result.retry,false);
  assert.deepEqual(result.applied.map(item=>item.version),[39],name+': the committed prefix is reported');
  assert.equal(result.failedFile.version,40,name);assert.equal(result.failedFileOutcome,outcome,name);
  assert.equal(result.bookmarkBefore,'bookmark-before',name+': the bookmark survives the failure');assert.equal(result.bookmarkAfter,'bookmark-after',name);
  assert.equal(result.postState.schemaVersion,state==='unknown'?40:39,name+': the verified post-state is attached');
  assert.equal(JSON.stringify(result).includes('SECRET'),false);
 }
 // a failure before any batch reports nothing as written and keeps the bookmark out of the picture
 {const {file,db}=world(38);sql(file,"UPDATE discovery_lease SET lease_id='l',expires_at="+(MID+600000)+" WHERE id=1");calls=0;
  const {exit,result}=await Op.runD1MigrationWindowProduction({argv,deps:deps(db),clock:at(MID)});
  assert.equal(exit,3);assert.equal(result.reason,'discovery_busy');assert.equal(result.writes,false);assert.equal(result.writeState,'none');assert.equal(result.applied,undefined);}
 // a stop AFTER a committed file (the second file refused before it is sent) still reports the prefix
 {const {file,db}=world(38);let n=0;calls=0;
  const binding={prepare:text=>db.prepare(text),async batch(statements){await db.batch(statements);n++;if(n===1)sql(file,"UPDATE discovery_lease SET lease_id='l',expires_at="+(MID+600000)+" WHERE id=1");}};
  const {result}=await Op.runD1MigrationWindowProduction({argv,deps:deps(binding),clock:at(MID)});
  assert.equal(result.reason,'discovery_busy');assert.equal(result.writes,true);assert.equal(result.writeState,'committed');assert.deepEqual(result.applied.map(item=>item.version),[39]);assert.equal(result.failedFile,undefined,'no batch of the second file was sent');assert.equal(version(file),39);}
}

// ---- the production reads are strict: a response without a result array is an error, never an empty table ----
{
 const {createD1Adapter}=await import('../scripts/d1-backfill.mjs');
 const target={accountId:'a'.repeat(32),apiToken:'t',endpoint:'https://example.test/client/v4',maxBatchStatements:2000,maxBatchBytes:8388608};
 const answer=body=>async()=>({ok:true,status:200,json:async()=>body});
 const strict=body=>createD1Adapter({target,databaseId:'d',fetchImpl:answer(body),retries:0}).allStrict('SELECT 1 AS n');
 assert.deepEqual(await strict({success:true,result:[{success:true,results:[{n:1}]}]}),[{n:1}]);
 assert.deepEqual(await strict({success:true,result:[{success:true,results:[]}]}),[],'a real empty answer is an answer');
 for(const bad of [{success:true,result:[]},{success:true,result:[{success:true}]},{success:true}])await assert.rejects(()=>strict(bad),error=>error.kind==='statement','a missing result array is refused: '+JSON.stringify(bad));
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
// ---- the REAL production composition (no deps): mocked fetch for describe, the strict reads, the bookmark and one actual per-file transport path ----
{
 const {PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID}=await import('../scripts/published-epg-production.mjs');
 const {file}=world(38);
 const calls=[];
 const lite=(input,json)=>{const result=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input,encoding:'utf8',maxBuffer:1<<28});return result;};
 // `malformed(sqlText)` true answers that read without a result array
 const makeFetch=({malformed=()=>false}={})=>async(url,init)=>{
  calls.push({url:String(url),method:init.method,body:init.body});
  const answer=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
  if(String(url).endsWith('/time_travel/bookmark'))return answer({success:true,result:{bookmark:'bookmark-'+calls.length}});
  if(init.method==='GET')return answer({success:true,result:{uuid:PRODUCTION_DATABASE_ID,name:'iptv'}});
  const body=JSON.parse(init.body);
  if(body.batch){
   // a {batch} body: one transaction, rolled back whole by a statement error
   const result=lite('BEGIN;\n'+body.batch.map(item=>item.sql).join('\n')+'\nCOMMIT;');
   if(result.status!==0)return answer({success:false,errors:[{message:String(result.stderr).trim()}]},400);
   return answer({success:true,result:body.batch.map(()=>({success:true,results:[],meta:{rows_written:1}}))});
  }
  const text=String(body.sql);
  if(malformed(text))return answer({success:true,result:[{success:true}]});
  const result=lite(text,true);
  if(result.status!==0)return answer({success:false,errors:[{message:String(result.stderr).trim()}]},400);
  const out=String(result.stdout).trim();
  return answer({success:true,result:[{success:true,results:out?JSON.parse(out):[],meta:{rows_written:0}}]});
 };
 const env={D1_BACKFILL_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,D1_BACKFILL_API_TOKEN:'SECRET-TOKEN-VALUE',NODE_USE_ENV_PROXY:''};
 const status=await Op.runD1MigrationWindowProduction({argv:A('--target','iptv'),env,fetchImpl:makeFetch(),clock:at(MID)});
 assert.equal(status.exit,0,JSON.stringify(status.result).slice(0,400));assert.equal(status.result.schemaVersion,38);assert.equal(status.result.plan[47].decision,'apply');
 assert.equal(status.result.chain.verified,true);
 assert.equal(calls.filter(call=>call.method==='POST'&&call.body.includes('"batch"')).length,0,'the status sends no batch');
 // a malformed strict read refuses the status before anything else
 const bad=await Op.runD1MigrationWindowProduction({argv:A('--target','iptv'),env,fetchImpl:makeFetch({malformed:text=>text.includes('FROM prediction_lease')}),clock:at(MID)});
 assert.equal(bad.exit,3);assert.equal(bad.result.reason,'unknown_state');assert.equal(JSON.stringify(bad).includes('SECRET-TOKEN-VALUE'),false);
 // the apply through the real adapter: describe, bookmark before, one {batch} per file with a readback in between, bookmark after
 calls.length=0;
 const applied=await Op.runD1MigrationWindowProduction({argv:A('--target','iptv','--apply','--through','47','--start','38','--confirm','apply','--manifest-sha256',Op.manifestSha256(),'--operator-sha256',Op.operatorSha256()),env,fetchImpl:makeFetch(),clock:at(MID)});
 assert.equal(applied.exit,0,JSON.stringify(applied.result).slice(0,500));assert.equal(applied.result.writeState,'committed');assert.deepEqual(applied.result.applied.map(item=>item.version),[39,40,41,42,43,44,45,46,47]);
 assert.ok(applied.result.bookmarkBefore&&applied.result.bookmarkAfter&&applied.result.bookmarkBefore!==applied.result.bookmarkAfter,'the recovery bookmark is read before and after');
 assert.equal(calls.filter(call=>call.method==='POST'&&call.body.includes('"batch"')).length,9,'one {batch} request per file through the real adapter');
 assert.equal(version(file),47);
 assert.equal(JSON.stringify(applied).includes('SECRET-TOKEN-VALUE'),false);
}

console.log('d1-migration-window-production: ok');
