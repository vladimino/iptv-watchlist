// ADR 0185 stage 2: the EPG checkpoint repository (src/epg-checkpoint-d1.js, schema v30, migrations/0030_epg_checkpoint_authority.sql). Offline only: a sqlite D1
// stand-in with the real migration chain. No production database or bucket is opened. The module is dormant: nothing in the Worker imports it in this file.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import * as Checkpoint from '../src/epg-checkpoint-d1.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-checkpoint-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const refuses=(file,text,pattern)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.notEqual(r.status,0,'must be refused: '+text.slice(0,70));if(pattern)assert.match(r.stderr,pattern);};
const chain=(upTo)=>names.filter(name=>name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const base=path.join(root,'base.sqlite');sqlite(base,chain('9999'));
const T='2026-11-20T10:00:00.000Z';
let copies=0;
const NOW=Date.parse('2026-11-20T10:00:00.000Z');
const LEASE="INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{\"schemaVersion\":1,\"mode\":\"cloudflare\",\"target\":null,\"epoch\":1,\"drain\":null}',1,'"+T+"');INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','{\"holder\":\"h1\",\"kind\":\"executor\",\"modeRevision\":1,\"released\":false,\"expiresAt\":\"2026-11-20T10:05:00.000Z\"}',1,'"+T+"');";
const open=(options={},{marker="UPDATE epg_checkpoint_authority SET mode='d1',generation=1 WHERE id=1;",lease=LEASE}={})=>{const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(base,file);sqlite(file,marker+lease);return {file,db:d1Standin(file,options)};};
const ctx=(extra={})=>({step:{holder:'h1',modeRevision:1},fence:{revision:1},leaseBound:new Date(NOW+15000).toISOString(),now:NOW,...extra});
// A test-only way to move the revision the way a burst of other writers would (the trigger forbids a raw jump, so it is dropped on that scratch copy).
const bump=(file,n)=>sqlite(file,'DROP TRIGGER IF EXISTS epg_checkpoint_run_order;UPDATE epg_checkpoint_run SET revision=revision+'+n+' WHERE id=1');
const attempt=(id='a1',startedAt=T)=>({id,startedAt});
const film=i=>({id:'f'+i,title:'Film '+i,peopleVersion:1,metadata:{synopsis:'S'.repeat(40),credits:['A'+i,'B'+i]}});
const makeRun=(id='run-1',count=3,extra={})=>({runId:id,startedAt:T,runKey:'2026-11-20',updatedAt:T,stage:'metadata',watchlist:Array.from({length:count},(_,i)=>film(i)),pending:['f0','f1'],cursor:0,remaining:2,pages:1,failures:[],...extra});
const counts=file=>rows(file,"SELECT (SELECT COUNT(*) FROM epg_checkpoint_run) AS run,(SELECT COUNT(*) FROM epg_checkpoint_film) AS film,(SELECT COUNT(*) FROM epg_checkpoint_body) AS body,(SELECT COUNT(*) FROM epg_checkpoint_receipt) AS receipt,(SELECT COUNT(*) FROM epg_ingest_status) AS ingest")[0];
const runRow=file=>rows(file,'SELECT * FROM epg_checkpoint_run')[0];
const created=async(count=3,extra={},options={})=>{const made=open(options);const run=makeRun('run-1',count,extra);const out=await Checkpoint.createRun(made.db,run,{...ctx(),attempt:attempt()});assert.equal(out.ok,true,JSON.stringify(out));return {...made,run};};

// ===== 1. the migration =====
{
 const m30='0030_epg_checkpoint_authority.sql';
 assert.ok(names.includes(m30)&&names.indexOf(m30)===names.indexOf('0029_started_authority.sql')+1,'0030 follows 0029');
 const v29=path.join(root,'v29.sqlite');sqlite(v29,chain('0029_started_authority.sql'));
 assert.equal(rows(v29,'SELECT version FROM schema_contract WHERE id=1')[0].version,29);
 const v28=path.join(root,'v28.sqlite');sqlite(v28,chain('0028_filter_preset_authority.sql'));
 refuses(v28,fs.readFileSync('migrations/'+m30,'utf8'),/CHECK|constraint|NOT NULL/i);
 assert.equal(rows(v28,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='epg_checkpoint_run'")[0].n,0,'a refused file leaves no table');
 sqlite(v29,fs.readFileSync('migrations/'+m30,'utf8'));
 assert.equal(rows(v29,'SELECT version FROM schema_contract WHERE id=1')[0].version,30);
 assert.deepEqual(rows(v29,'SELECT mode,generation,writes FROM epg_checkpoint_authority')[0],{mode:'r2',generation:0,writes:'open'});
 assert.equal(rows(v29,'SELECT COUNT(*) AS n FROM epg_checkpoint_run')[0].n+rows(v29,'SELECT COUNT(*) AS n FROM epg_ingest_status')[0].n,0,'it copies and switches nothing');
 refuses(v29,'UPDATE schema_contract SET version=29 WHERE id=1',/schema_contract_downgrade/);
 // the triggers hold against a writer that bypasses the repository
 const raw=open();
 sqlite(raw.file,"INSERT INTO epg_checkpoint_run (id,run_id,run_key,started_at,stage,seal_phase,queue_attempted,completed_at,has_error,revision,last_write_id,body_chunks,body_chars,body_sha256,watchlist_present,film_count,film_list_sha256,updated_at) VALUES (1,'r','2026-11-20','"+T+"','seal','queue',0,NULL,0,1,'w',1,2,'"+'a'.repeat(64)+"',0,NULL,NULL,'"+T+"')");
 refuses(raw.file,"UPDATE epg_checkpoint_run SET stage='epg',seal_phase=NULL,revision=2 WHERE id=1",/epg_checkpoint_regress/);
 refuses(raw.file,"UPDATE epg_checkpoint_run SET seal_phase='publish',revision=2 WHERE id=1",/epg_checkpoint_regress/);
 refuses(raw.file,"UPDATE epg_checkpoint_run SET queue_attempted=1,revision=2 WHERE id=1",/epg_checkpoint_regress|CHECK/);
 refuses(raw.file,"UPDATE epg_checkpoint_run SET stage='complete',seal_phase=NULL,queue_attempted=0,completed_at='"+T+"',revision=2 WHERE id=1",/CHECK/);
 sqlite(raw.file,"UPDATE epg_checkpoint_run SET stage='complete',seal_phase=NULL,queue_attempted=1,completed_at='"+T+"',revision=2 WHERE id=1");
 refuses(raw.file,"UPDATE epg_checkpoint_run SET completed_at='2026-11-21T00:00:00.000Z',revision=3 WHERE id=1",/epg_checkpoint_regress/);
 refuses(raw.file,"UPDATE epg_checkpoint_run SET stage='metadata',seal_phase=NULL,completed_at=NULL,queue_attempted=0,revision=3 WHERE id=1",/epg_checkpoint_regress/);
 refuses(raw.file,"UPDATE epg_checkpoint_run SET revision=9 WHERE id=1",/epg_checkpoint_regress/);
}

// ===== 2. the authority states =====
{
 const legacy=path.join(root,'legacy.sqlite');sqlite(legacy,chain('0029_started_authority.sql'));
 assert.deepEqual(await Checkpoint.readAuthority(d1Standin(legacy)),{state:'legacy'},'tables absent below version 30: the R2 objects serve');
 const noTables=path.join(root,'notables.sqlite');sqlite(noTables,chain('0029_started_authority.sql')+"UPDATE schema_contract SET version=30 WHERE id=1;");
 assert.deepEqual(await Checkpoint.readAuthority(d1Standin(noTables)),{state:'closed'},'version 30 without the tables is closed');
 assert.deepEqual(await Checkpoint.readAuthority({}),{state:'closed'},'a missing binding is closed');
 assert.deepEqual(await Checkpoint.readAuthority({EPG_CHECKPOINT_DB_OPTIONAL:'standin'}),{state:'legacy'},'the explicit local stand-in only');
 assert.deepEqual(await Checkpoint.readAuthority({EPG_CHECKPOINT_DB_OPTIONAL:'on',DB:d1Standin(noTables)}),{state:'closed'},'any other value of the selector is not a stand-in');
 const r2=open({},{marker:''});
 assert.deepEqual(await Checkpoint.readAuthority(r2.db),{state:'r2',writes:'open',generation:0});
 assert.deepEqual(await Checkpoint.readAuthority(open().db),{state:'d1',writes:'open',generation:1});
 const held=open({},{marker:"UPDATE epg_checkpoint_authority SET mode='d1',generation=2,writes='held' WHERE id=1;"});
 assert.deepEqual(await Checkpoint.readAuthority(held.db),{state:'d1',writes:'held',generation:2});
 const gone=open({},{marker:'DELETE FROM epg_checkpoint_authority;'});
 assert.deepEqual(await Checkpoint.readAuthority(gone.db),{state:'closed'},'a deleted marker row is closed');
 // at r2 the repository neither serves nor writes
 assert.deepEqual(await Checkpoint.loadRun(r2.db),{ok:false,reason:'closed'});
 assert.equal((await Checkpoint.createRun(r2.db,makeRun(),{...ctx(),attempt:attempt()})).reason,'closed');
 assert.deepEqual(counts(r2.file),{run:0,film:0,body:0,receipt:0,ingest:0});
}

// ===== 3. create, load, save =====
{
 const empty=open();
 assert.deepEqual(await Checkpoint.loadRun(empty.db),{ok:true,run:null,generation:1},'no run yet: absent, like a missing R2 object');
 const made=await created(120,{removalRefs:[{ref:{eventKey:'k'}}]});
 const first=await Checkpoint.loadRun(made.db);
 assert.equal(first.ok,true);assert.deepEqual(first.run,made.run,'a round trip returns the same object, the 120-entry watchlist included');
 assert.equal(runRow(made.file).revision,1);assert.equal(counts(made.file).film,120);
 assert.deepEqual(rows(made.file,'SELECT last_success_at,failed_at,code,consecutive_failures,success_attempt_id FROM epg_ingest_status')[0],{last_success_at:T,failed_at:null,code:null,consecutive_failures:0,success_attempt_id:'a1'},'run creation records the ingest success in the same batch');
 // a metadata step: 24 entries change, a save writes exactly those rows
 const statements=[];const spy=open({onBatch:async batch=>{statements.push(...batch.map(item=>item.text));}});
 const run=makeRun('run-1',120);assert.equal((await Checkpoint.createRun(spy.db,run,{...ctx(),attempt:attempt()})).ok,true);
 statements.length=0;
 const loaded=(await Checkpoint.loadRun(spy.db)).run;
 for(let i=0;i<24;i++)loaded.watchlist[i].peopleLocalizedAt='2026-11-20T10:01:00.000Z';
 loaded.cursor=24;loaded.stage='epg';loaded.updatedAt='2026-11-20T10:01:00.000Z';
 const saved=await Checkpoint.saveRun(spy.db,loaded,ctx());
 assert.equal(saved.ok,true);assert.equal(saved.revision,2);
 assert.equal(statements.filter(text=>/^UPDATE epg_checkpoint_film/.test(text)).length,24,'only the changed entries are written');
 assert.deepEqual((await Checkpoint.loadRun(spy.db)).run,loaded);
 // the same object is saved again in one request
 loaded.stage='seal';loaded.seal={phase:'ledger',jobId:'j'};
 assert.equal((await Checkpoint.saveRun(spy.db,loaded,ctx())).revision,3);
 assert.equal(runRow(spy.file).seal_phase,'ledger');
 // a save of an object that was never loaded or created is refused; so is a changed identity or watchlist membership
 assert.equal((await Checkpoint.saveRun(spy.db,{...loaded},ctx())).reason,'unbased');
 const other=(await Checkpoint.loadRun(spy.db)).run;
 other.watchlist.pop();assert.equal((await Checkpoint.saveRun(spy.db,other,ctx())).reason,'shape','membership changes only through run creation');
 const renamed=(await Checkpoint.loadRun(spy.db)).run;renamed.runId='other';assert.equal((await Checkpoint.saveRun(spy.db,renamed,ctx())).reason,'identity');
 const dropped=(await Checkpoint.loadRun(spy.db)).run;delete dropped.watchlist;assert.equal((await Checkpoint.saveRun(spy.db,dropped,ctx())).reason,'shape','the watchlist is removed only by completion');
 // the stage order
 const back=(await Checkpoint.loadRun(spy.db)).run;back.stage='epg';delete back.seal;
 const refused=await Checkpoint.saveRun(spy.db,back,ctx());assert.equal(refused.ok,false);assert.equal(refused.reason,'conflict');assert.equal(runRow(spy.file).stage,'seal','a regression writes nothing');
 const jump=(await Checkpoint.loadRun(spy.db)).run;jump.stage='complete';
 assert.equal((await Checkpoint.saveRun(spy.db,jump,ctx())).reason,'complete_route','the generic save never completes a run');
 // an empty watchlist is not an absent one
 const emptyList=open();const none=makeRun('run-e',0);
 assert.equal((await Checkpoint.createRun(emptyList.db,none,{...ctx(),attempt:attempt()})).ok,true);
 assert.deepEqual((await Checkpoint.loadRun(emptyList.db)).run.watchlist,[]);
 assert.deepEqual([runRow(emptyList.file).watchlist_present,runRow(emptyList.file).film_count],[1,0]);
}

// ===== 4. fences: no step, lost lease, moved mode, moved authority =====
{
 const made=await created(5);
 const before=counts(made.file),at=runRow(made.file).revision;
 const loaded=()=>Checkpoint.loadRun(made.db).then(read=>read.run);
 const edit=async()=>{const run=await loaded();run.cursor=7;run.updatedAt='2026-11-20T10:02:00.000Z';return run;};
 assert.equal((await Checkpoint.saveRun(made.db,await edit(),{now:NOW})).reason,'unfenced','no step, no write');
 assert.equal((await Checkpoint.saveRun(made.db,await edit(),{...ctx(),fence:undefined})).reason,'unfenced');
 assert.equal((await Checkpoint.saveRun(made.db,await edit(),ctx({step:{holder:'someone-else',modeRevision:1}}))).reason,'conflict','a step that does not hold the lease is refused inside the batch');
 assert.equal((await Checkpoint.saveRun(made.db,await edit(),ctx({fence:{revision:2}}))).reason,'conflict','a moved mode revision is refused');
 assert.equal((await Checkpoint.saveRun(made.db,await edit(),ctx({leaseBound:'2026-11-20T10:06:00.000Z'}))).reason,'conflict','a lease that expires before the bound is refused');
 sqlite(made.file,"UPDATE epg_orchestration_document SET body=json_set(body,'$.released',json('true')),revision=revision+1 WHERE key='lease'");
 assert.equal((await Checkpoint.saveRun(made.db,await edit(),ctx())).reason,'conflict','a released lease is refused');
 sqlite(made.file,"UPDATE epg_orchestration_document SET body=json_set(body,'$.released',json('false')),revision=revision+1 WHERE key='lease'");
 const stale=await edit();
 sqlite(made.file,"UPDATE epg_checkpoint_authority SET writes='held',generation=2 WHERE id=1");
 assert.equal((await Checkpoint.saveRun(made.db,stale,ctx())).reason,'conflict','a writer that read generation 1 cannot write after a hold');
 assert.equal((await Checkpoint.createRun(made.db,makeRun('run-2'),{...ctx(),attempt:attempt('a2')})).reason,'writes_held');
 sqlite(made.file,"UPDATE epg_checkpoint_authority SET writes='open',generation=3 WHERE id=1");
 assert.equal((await Checkpoint.saveRun(made.db,stale,ctx())).reason,'conflict','a stale generation stays refused after the release');
 assert.deepEqual(counts(made.file),before,'every refusal wrote nothing');assert.equal(runRow(made.file).revision,at);
 assert.equal((await Checkpoint.saveRun(made.db,(await loaded()),ctx())).ok,true,'a fresh read at the new generation writes');
 // a held database serves a load of the run only through the marker it read: not d1 means closed
 sqlite(made.file,"UPDATE epg_checkpoint_authority SET mode='r2' WHERE id=1");
 assert.equal((await Checkpoint.loadRun(made.db)).reason,'closed');
}

// ===== 5. two writers, a stale revision, an unknown outcome =====
{
 const made=await created(4);
 const a=(await Checkpoint.loadRun(made.db)).run,b=(await Checkpoint.loadRun(made.db)).run;
 a.cursor=1;b.cursor=2;
 const winner=await Checkpoint.saveRun(made.db,a,ctx());assert.equal(winner.ok,true);
 const loser=await Checkpoint.saveRun(made.db,b,ctx());
 assert.equal(loser.ok,false);assert.equal(loser.reason,'conflict');
 assert.equal((await Checkpoint.loadRun(made.db)).run.cursor,1,'the loser did not overwrite');
 assert.equal(await Checkpoint.classifyWrite(made.db,{writeId:winner.writeId,expectedRevision:1}),'applied');
 assert.equal(await Checkpoint.classifyWrite(made.db,{writeId:loser.writeId,expectedRevision:1}),'superseded','no receipt, the revision advanced inside the receipt window');
 assert.equal(await Checkpoint.classifyWrite(made.db,{writeId:'never',expectedRevision:2}),'not_applied','the revision did not move');
 // a lost reply: the batch commits and the response is lost
 const lost={...made.db,async batch(statements){await made.db.batch(statements);throw new Error('network connection lost');}};
 const run=(await Checkpoint.loadRun(made.db)).run;run.cursor=3;
 const reply=await Checkpoint.saveRun(lost,run,ctx());
 assert.equal(reply.ok,true,'the receipt proves the lost reply was applied');assert.equal((await Checkpoint.loadRun(made.db)).run.cursor,3);
 // a lost request: nothing was applied
 const dropped={...made.db,async batch(){throw new Error('network connection lost');}};
 const again=(await Checkpoint.loadRun(made.db)).run;again.cursor=4;
 const none=await Checkpoint.saveRun(dropped,again,ctx());
 assert.equal(none.ok,false);assert.equal(none.reason,'unavailable');assert.equal((await Checkpoint.loadRun(made.db)).run.cursor,3);
 // the revision advanced far beyond the receipt window with no receipt of mine: indeterminate, never "not applied"
 bump(made.file,40);
 assert.equal(await Checkpoint.classifyWrite(made.db,{writeId:'mine',expectedRevision:3}),'indeterminate');
 // a gap in the receipt revisions inside the window is indeterminate too
 const gap=await created(2);
 for(let i=0;i<3;i++){const r=(await Checkpoint.loadRun(gap.db)).run;r.cursor=i+1;assert.equal((await Checkpoint.saveRun(gap.db,r,ctx())).ok,true);}
 sqlite(gap.file,'DELETE FROM epg_checkpoint_receipt WHERE revision=3');
 assert.equal(await Checkpoint.classifyWrite(gap.db,{writeId:'mine',expectedRevision:1}),'indeterminate');
 assert.equal(await Checkpoint.classifyWrite(gap.db,{writeId:'mine',expectedRevision:-1}),'indeterminate');
 // an indeterminate result is returned to the caller and never repeated inside the repository
 const lostWithoutReceipt=open();
 assert.equal((await Checkpoint.createRun(lostWithoutReceipt.db,makeRun('r-a',2),{...ctx(),attempt:attempt()})).ok,true);
 const far=(await Checkpoint.loadRun(lostWithoutReceipt.db)).run;far.cursor=9;
 const hostile={...lostWithoutReceipt.db,async batch(statements){if(statements.some(item=>/INSERT INTO epg_checkpoint_receipt/.test(item.text))){bump(lostWithoutReceipt.file,30);throw new Error('network connection lost');}return lostWithoutReceipt.db.batch(statements);}};
 const unknown=await Checkpoint.saveRun(hostile,far,ctx());
 assert.equal(unknown.ok,false);assert.equal(unknown.reason,'indeterminate');
 assert.equal(rows(lostWithoutReceipt.file,'SELECT COUNT(*) AS n FROM epg_checkpoint_receipt WHERE write_id=\''+unknown.writeId+'\'')[0].n,0);
}

// ===== 6. completeness of the watchlist =====
{
 const corrupt=async(sql,label)=>{const made=await created(6);sqlite(made.file,'DROP TRIGGER IF EXISTS epg_checkpoint_run_order;'+sql);assert.deepEqual(await Checkpoint.loadRun(made.db),{ok:false,reason:'malformed'},label);};
 await corrupt("DELETE FROM epg_checkpoint_film WHERE ordinal=3",'a missing row is detected, never a shorter valid-looking list');
 await corrupt("DELETE FROM epg_checkpoint_film WHERE ordinal=5",'the last row missing');
 await corrupt("INSERT INTO epg_checkpoint_film (run_id,ordinal,film_id,body,body_sha256) SELECT run_id,6,'extra',body,body_sha256 FROM epg_checkpoint_film WHERE ordinal=0",'an extra row');
 await corrupt("UPDATE epg_checkpoint_film SET ordinal=ordinal+100 WHERE ordinal IN (1,2); UPDATE epg_checkpoint_film SET ordinal=1 WHERE ordinal=102; UPDATE epg_checkpoint_film SET ordinal=2 WHERE ordinal=101",'two rows swapped');
 await corrupt("UPDATE epg_checkpoint_film SET body='{\"id\":\"f1\",\"title\":\"changed\"}' WHERE ordinal=1",'a changed body under its old digest');
 await corrupt("UPDATE epg_checkpoint_film SET body_sha256='"+'0'.repeat(64)+"' WHERE ordinal=1",'a row digest that does not match');
 await corrupt("UPDATE epg_checkpoint_run SET film_list_sha256='"+'1'.repeat(64)+"'",'an aggregate digest that does not match');
 await corrupt("UPDATE epg_checkpoint_run SET film_count=5",'a count that does not match');
 await corrupt("UPDATE epg_checkpoint_body SET text='{}' WHERE seq=0",'a body that does not match its digest');
 await corrupt("UPDATE epg_checkpoint_run SET stage='epg'",'a typed column that contradicts the body');
 await corrupt("UPDATE epg_checkpoint_run SET body_chunks=2,body_chars=body_chars",'a chunk count that does not match');
 await corrupt("DELETE FROM epg_checkpoint_run",'a body with no run row');
 // orphan rows of another run are ignored by a read
 const withOrphans=await created(3);
 sqlite(withOrphans.file,"INSERT INTO epg_checkpoint_film (run_id,ordinal,film_id,body,body_sha256) VALUES ('ghost',0,'g','{}','"+'2'.repeat(64)+"')");
 assert.equal((await Checkpoint.loadRun(withOrphans.db)).ok,true);
 // creation verifies what it staged before it exposes it: a row removed between the read-back and the switch aborts the switch
 const racing=await created(4);
 const before=counts(racing.file);
 let armed=true;
 const sabotage=d1Standin(racing.file,{onBatch:async batch=>{if(armed&&batch.some(item=>/^UPDATE epg_checkpoint_run SET run_id/.test(item.text))){armed=false;sqlite(racing.file,"DELETE FROM epg_checkpoint_film WHERE run_id='run-2' AND ordinal=1");}}});
 const out=await Checkpoint.createRun(sabotage,makeRun('run-2',4),{...ctx(),attempt:attempt('a2','2026-11-20T10:03:00.000Z')});
 assert.equal(out.ok,false);
 assert.equal(runRow(racing.file).run_id,'run-1','the previous run is still current');
 assert.equal((await Checkpoint.loadRun(racing.db)).run.runId,'run-1');
 assert.equal(counts(racing.file).receipt,before.receipt,'nothing switched');
 // the film rows are removed with the completion; a complete run has no watchlist, and rows found for it are malformed
 const done=await created(3);
 const run=(await Checkpoint.loadRun(done.db)).run;
 run.stage='complete';run.completedAt=T;run.updatedAt=T;delete run.watchlist;delete run.pending;
 const completed=await Checkpoint.completeRun(done.db,run,{...ctx(),queueAttempted:true});
 assert.equal(completed.ok,true);
 assert.equal(counts(done.file).film,0,'the working set is removed in the same transaction');
 const read=(await Checkpoint.loadRun(done.db)).run;
 assert.equal('watchlist' in read,false);assert.equal(read.stage,'complete');
 assert.deepEqual([runRow(done.file).watchlist_present,runRow(done.file).film_count,runRow(done.file).queue_attempted,runRow(done.file).completed_at],[0,null,1,T]);
 sqlite(done.file,"INSERT INTO epg_checkpoint_film (run_id,ordinal,film_id,body,body_sha256) VALUES ('run-1',0,'f0','{}','"+'3'.repeat(64)+"')");
 assert.deepEqual(await Checkpoint.loadRun(done.db),{ok:false,reason:'malformed'},'rows for a run without a watchlist');
}

// ===== 7. completion =====
{
 const made=await created(3);
 const complete=async(run,extra={})=>Checkpoint.completeRun(made.db,run,{...ctx(),queueAttempted:true,...extra});
 const run=(await Checkpoint.loadRun(made.db)).run;
 run.stage='complete';delete run.watchlist;delete run.pending;
 assert.equal((await Checkpoint.completeRun(made.db,run,{...ctx(),queueAttempted:false})).reason,'queue_not_attempted','no route completes before its queue attempt');
 assert.equal((await Checkpoint.completeRun(made.db,run,{now:NOW,queueAttempted:true})).reason,'unfenced');
 assert.equal((await Checkpoint.completeRun(made.db,{...run},{...ctx(),queueAttempted:true})).reason,'unbased');
 const notComplete=(await Checkpoint.loadRun(made.db)).run;
 assert.equal((await Checkpoint.completeRun(made.db,notComplete,{...ctx(),queueAttempted:true})).reason,'shape','the object must say complete');
 assert.equal(runRow(made.file).stage,'metadata','every refusal left the run alone');
 // a certify statement that matches nothing does not stop the completion; one that matches is in the same transaction
 sqlite(made.file,"CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)");
 const noMatch=["UPDATE probe SET v='x' WHERE id=99",[]],match=["INSERT INTO probe (id,v) SELECT 1, run_id FROM epg_checkpoint_run WHERE stage='complete' AND queue_attempted=1",[]];
 const out=await complete(run,{certify:[noMatch,match]});
 assert.equal(out.ok,true);
 assert.deepEqual(rows(made.file,'SELECT id,v FROM probe'),[{id:1,v:'run-1'}],'the certify statement saw the completed checkpoint');
 assert.equal((await complete(run)).reason,'already_complete');
 // post-complete saves are same-stage saves; they cannot change the completion marker
 const after=(await Checkpoint.loadRun(made.db)).run;after.epgEventPending=[{id:'e'}];after.updatedAt='2026-11-21T00:00:00.000Z';
 assert.equal((await Checkpoint.saveRun(made.db,after,ctx())).ok,true);
 assert.equal(runRow(made.file).completed_at,T,'the completion time is immutable');
 assert.equal((await Checkpoint.loadRun(made.db)).run.epgEventPending[0].id,'e');
 const wrong=(await Checkpoint.loadRun(made.db)).run;wrong.stage='epg';
 assert.equal((await Checkpoint.saveRun(made.db,wrong,ctx())).ok,false,'a complete run never leaves complete');
 // a completion whose fence fails writes nothing at all, the certify statements included
 const fenced=await created(2);
 const f=(await Checkpoint.loadRun(fenced.db)).run;f.stage='complete';delete f.watchlist;
 sqlite(fenced.file,"CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)");
 const failed=await Checkpoint.completeRun(fenced.db,f,{...ctx({step:{holder:'lost',modeRevision:1}}),queueAttempted:true,certify:[["INSERT INTO probe (id,v) VALUES (1,'x')",[]]]});
 assert.equal(failed.reason,'conflict');assert.equal(rows(fenced.file,'SELECT COUNT(*) AS n FROM probe')[0].n,0);assert.equal(runRow(fenced.file).stage,'metadata');
}

// ===== 8. the ingest status =====
{
 const made=open();
 const A=(id,at)=>attempt(id,'2026-11-20T10:'+String(at).padStart(2,'0')+':00.000Z');
 assert.deepEqual(await Checkpoint.readIngest(made.db),{ok:true,status:null},'absent until the first write');
 const fail=(a,extra={})=>Checkpoint.recordIngestFailure(made.db,{attempt:a,code:'watchlist_failed',failedAt:'2026-11-20T10:09:00.000Z',lastSuccessAt:null,now:NOW,...extra});
 assert.deepEqual(await fail(A('f1',1)),{ok:true,applied:true});
 assert.deepEqual((await Checkpoint.readIngest(made.db)).status,{schemaVersion:1,code:'watchlist_failed',failedAt:'2026-11-20T10:09:00.000Z',lastSuccessAt:null,consecutiveFailures:1});
 assert.deepEqual(await fail(A('f1',1)),{ok:true,applied:true},'the same attempt repeated is a no-op that is still reported as recorded');
 assert.equal((await Checkpoint.readIngest(made.db)).status.consecutiveFailures,1);
 assert.deepEqual(await fail(A('f0',0)),{ok:true,applied:false},'an older attempt than the stored failure is superseded');
 assert.deepEqual(await fail(A('f2',2),{lastSuccessAt:'2026-11-19T17:30:00.000Z'}),{ok:true,applied:true});
 assert.equal((await Checkpoint.readIngest(made.db)).status.consecutiveFailures,2);assert.equal((await Checkpoint.readIngest(made.db)).status.lastSuccessAt,'2026-11-19T17:30:00.000Z');
 await fail(A('f3',3),{lastSuccessAt:'2026-11-18T00:00:00.000Z'});
 assert.equal((await Checkpoint.readIngest(made.db)).status.lastSuccessAt,'2026-11-19T17:30:00.000Z','the last success is never lowered');
 // a success of a NEWER attempt wins over the failures; a late failure of an older attempt cannot erase it
 const run=makeRun('run-1',2);
 assert.equal((await Checkpoint.createRun(made.db,run,{...ctx(),attempt:A('s4',4)})).ok,true);
 assert.deepEqual((await Checkpoint.readIngest(made.db)).status,{schemaVersion:1,failedAt:null,lastSuccessAt:T,consecutiveFailures:0});
 assert.deepEqual(await fail(A('late',3)),{ok:true,applied:false},'a failure that began before the success is superseded even though it finished after it');
 assert.deepEqual(await fail(A('older-still',1)),{ok:true,applied:false});
 assert.equal((await Checkpoint.readIngest(made.db)).status.failedAt,null);
 assert.deepEqual(await fail(A('f5',5)),{ok:true,applied:true},'a failure of a newer attempt applies');
 assert.equal((await Checkpoint.readIngest(made.db)).status.consecutiveFailures,1);
 // an older success does not replace a newer one
 const older=open();
 sqlite(older.file,"INSERT INTO epg_ingest_status (id,schema_version,last_success_at,consecutive_failures,success_attempt_id,success_attempt_started_at,revision,updated_at) VALUES (1,1,'2026-11-21T00:00:00.000Z',0,'newer','2026-11-20T10:09:00.000Z',1,'"+T+"')");
 assert.equal((await Checkpoint.createRun(older.db,makeRun('run-1',1),{...ctx(),attempt:A('olderSuccess',1)})).ok,true);
 assert.equal((await Checkpoint.readIngest(older.db)).status.lastSuccessAt,'2026-11-21T00:00:00.000Z');
 // the counter is capped
 sqlite(made.file,"UPDATE epg_ingest_status SET consecutive_failures=1000");
 await fail(A('f9',9));assert.equal((await Checkpoint.readIngest(made.db)).status.consecutiveFailures,1000);
 // a failure needs no step lease; a held or closed authority drops it
 sqlite(made.file,"UPDATE epg_orchestration_document SET body=json_set(body,'$.released',json('true')) WHERE key='lease'");
 assert.equal((await fail(A('f10',10))).applied,true,'no step lease is needed for a diagnostic');
 sqlite(made.file,"UPDATE epg_checkpoint_authority SET writes='held' WHERE id=1");
 assert.deepEqual(await fail(A('f11',11)),{ok:false,reason:'writes_held'});
 sqlite(made.file,"UPDATE epg_checkpoint_authority SET mode='r2',writes='open' WHERE id=1");
 assert.deepEqual(await fail(A('f12',12)),{ok:false,reason:'closed'});
 assert.deepEqual(await Checkpoint.readIngest(made.db),{ok:false,reason:'closed'});
 assert.equal((await Checkpoint.recordIngestFailure(made.db,{attempt:{id:'',startedAt:T},code:'x',failedAt:T})).reason,'shape');
}

// ===== 9. orphan staging rows =====
{
 const made=await created(3);
 sqlite(made.file,"WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<1299) INSERT INTO epg_checkpoint_film (run_id,ordinal,film_id,body,body_sha256) SELECT 'orphan-'||(i/100),i%100,'o'||i,'{}','"+'4'.repeat(64)+"' FROM n");
 assert.equal(counts(made.file).film,1303);
 const swept=await Checkpoint.gcOrphans(made.db,ctx());
 assert.deepEqual(swept,{ok:true,removed:1000},'bounded: five passes of 200');
 assert.equal(counts(made.file).film,303);
 assert.equal((await Checkpoint.gcOrphans(made.db,ctx({step:undefined}))).reason,'unfenced');
 assert.equal((await Checkpoint.gcOrphans(made.db,ctx({step:{holder:'lost',modeRevision:1}}))).reason,'conflict','a step that lost its lease sweeps nothing');
 assert.equal(counts(made.file).film,303);
 // a run creation sweeps first and the switch removes the rest; the current run's rows are never touched by a sweep
 assert.equal((await Checkpoint.createRun(made.db,makeRun('run-2',2),{...ctx(),attempt:attempt('a2','2026-11-20T10:05:00.000Z')})).ok,true);
 assert.deepEqual(rows(made.file,'SELECT DISTINCT run_id FROM epg_checkpoint_film'),[{run_id:'run-2'}],'every other run id is gone after the switch');
 // an interrupted creation (staged, never switched) leaves orphans; the next creation cleans them and the read ignored them meanwhile
 const interrupted=await created(2);
 const abort=d1Standin(interrupted.file,{onBatch:async batch=>{if(batch.some(item=>/^UPDATE epg_checkpoint_run SET run_id/.test(item.text)))throw new Error('network connection lost');}});
 const out=await Checkpoint.createRun(abort,makeRun('run-2',4),{...ctx(),attempt:attempt('a2','2026-11-20T10:05:00.000Z')});
 assert.equal(out.ok,false);
 assert.equal(rows(interrupted.file,"SELECT COUNT(*) AS n FROM epg_checkpoint_film WHERE run_id='run-2'")[0].n,4,'staged rows remain after an interrupted creation');
 assert.equal((await Checkpoint.loadRun(interrupted.db)).run.runId,'run-1','and no reader sees them');
 const retry=await Checkpoint.createRun(interrupted.db,makeRun('run-3',2),{...ctx(),attempt:attempt('a3','2026-11-20T10:06:00.000Z')});
 assert.equal(retry.ok,true);assert.deepEqual(rows(interrupted.file,'SELECT DISTINCT run_id FROM epg_checkpoint_film'),[{run_id:'run-3'}]);
 // repeated attempts that never switch do not accumulate beyond the sweep: staged rows of failed attempts are swept at the start of each creation
 const repeated=await created(2);
 for(let i=0;i<4;i++){
  const flaky=d1Standin(repeated.file,{onBatch:async batch=>{if(batch.some(item=>/^UPDATE epg_checkpoint_run SET run_id/.test(item.text)))throw new Error('network connection lost');}});
  await Checkpoint.createRun(flaky,makeRun('try-'+i,3),{...ctx(),attempt:attempt('t'+i,'2026-11-20T10:1'+i+':00.000Z')});
 }
 assert.equal(rows(repeated.file,"SELECT COUNT(DISTINCT run_id) AS n FROM epg_checkpoint_film WHERE run_id<>'run-1'")[0].n,1,'only the latest failed attempt is left');
}

// ===== 10. budgets and text =====
{
 const made=open();
 const big=makeRun('run-big',2);big.watchlist[1].synopsis='x'.repeat(Checkpoint.LIMITS.filmChars);
 assert.equal((await Checkpoint.createRun(made.db,big,{...ctx(),attempt:attempt()})).reason,'budget');
 const huge=makeRun('run-huge',2);huge.blob='y'.repeat(Checkpoint.LIMITS.bodyChars);
 assert.equal((await Checkpoint.createRun(made.db,huge,{...ctx(),attempt:attempt()})).reason,'budget');
 assert.deepEqual(counts(made.file),{run:0,film:0,body:0,receipt:0,ingest:0},'an over-budget document changes nothing');
 const dup=makeRun('run-dup',3);dup.watchlist[2].id=dup.watchlist[0].id;
 assert.equal((await Checkpoint.createRun(made.db,dup,{...ctx(),attempt:attempt()})).reason,'shape','a duplicate film id is refused');
 const idless=makeRun('run-idless',2);delete idless.watchlist[1].id;
 assert.equal((await Checkpoint.createRun(made.db,idless,{...ctx(),attempt:attempt()})).reason,'shape');
 assert.equal((await Checkpoint.createRun(made.db,{...makeRun('run-x'),stage:'complete'},{...ctx(),attempt:attempt()})).reason,'shape','a run is never created complete');
 assert.equal((await Checkpoint.createRun(made.db,makeRun('run-y'),{...ctx(),attempt:{id:'',startedAt:T}})).reason,'shape');
 assert.equal((await Checkpoint.createRun(made.db,makeRun('run-z'),{now:NOW,attempt:attempt()})).reason,'unfenced');
 // a body of several chunks round-trips, with astral characters on the chunk boundaries
 const wide=makeRun('run-wide',2);wide.note=('a'.repeat(Checkpoint.LIMITS.statementChars-1)+'😀').repeat(4)+'é';
 assert.ok(JSON.stringify({...wide,watchlist:undefined}).length>Checkpoint.LIMITS.statementChars*3);
 assert.equal((await Checkpoint.createRun(made.db,wide,{...ctx(),attempt:attempt()})).ok,true);
 assert.ok(counts(made.file).body>=4);
 assert.deepEqual((await Checkpoint.loadRun(made.db)).run,wide,'chunking never splits a surrogate pair');
 // the same run id is never created twice
 assert.equal((await Checkpoint.createRun(made.db,makeRun('run-wide',1),{...ctx(),attempt:attempt('again')})).reason,'shape');
}

console.log('EPG checkpoint repository (ADR 0185): migration and triggers, authority states, create/load/save, fences, receipts and unknown outcomes, watchlist completeness, completion, ingest ordering, orphan sweep, budgets');
