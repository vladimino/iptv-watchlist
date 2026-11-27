// AIR-675 / ADR 0217 (Accepted) delivery step 6, schema tests ("Schema tests exact predecessor and replay"): migration 0049 (`lid_recheck_intent`) and migration 0050 (the writer control admits `lid_tmdb_attach`),
// on the sqlite3-CLI D1 stand-in. No Worker, R2, network or production.
// 0049: the refusal of a wrong predecessor (and what a refused file creates), the accepted file (one empty table, version 49), every CHECK, the compare-and-swap discipline (revision +1 on every update, frozen settled
//   row, immutable ids, attach columns written once, link state only owed -> terminal), and no delete.
// 0050: the refusal of a wrong predecessor, the rebuild that keeps every control row and the whole append-only history (own seq, AUTOINCREMENT continues), the same eight triggers and unique index, the sixth writer
//   activated, drained and deactivated through the same compare-and-swap, a seventh writer still refused, and the old guarantees (append-only, stale generation, direct control writes) unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

const INTENT='0049_lid_recheck_intent.sql',WRITER='0050_lid_tmdb_attach_writer.sql',PRE_INTENT='0048_film_lid_admission.sql';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.equal(files[files.indexOf(INTENT)-1],PRE_INTENT,'0049 follows 0048');
assert.equal(files[files.indexOf(WRITER)-1],INTENT,'0050 follows 0049');
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lid-attach-mig-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const ok=(file,text)=>{const r=sqlite(file,text);assert.equal(r.status,0,r.stderr+' <- '+text);};
const refused=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'expected a refusal: '+text);if(pattern)assert.match(r.stderr,pattern,text);};
let n=0;
const copy=source=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(source,file);return file;};
const objects=file=>one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','trigger','index')");
const chainTo=name=>files.slice(0,files.indexOf(name)).map(read).join('\n');

const t48=path.join(root,'t48.sqlite');ok(t48,chainTo(INTENT));
assert.equal(one(t48,'SELECT version FROM schema_contract WHERE id=1'),48);
const t49=path.join(root,'t49.sqlite');fs.copyFileSync(t48,t49);ok(t49,read(INTENT));
const t50=path.join(root,'t50.sqlite');fs.copyFileSync(t49,t50);ok(t50,read(WRITER));

// ===== 0049: the predecessor and what it creates =====
{
 const stale=path.join(root,'t47.sqlite');ok(stale,chainTo(PRE_INTENT));
 const before=objects(stale);
 refused(stale,read(INTENT));
 assert.equal(objects(stale),before,'a refused file creates nothing');
 assert.equal(one(stale,'SELECT version FROM schema_contract WHERE id=1'),47);
 const noWriter=copy(t48);ok(noWriter,'DROP TRIGGER identity_evidence_writer_update;DROP TRIGGER identity_evidence_writer_insert;DROP TRIGGER identity_evidence_writer_change_apply;DROP TABLE identity_evidence_writer');
 refused(noWriter,read(INTENT));
 const taken=copy(t48);ok(taken,'CREATE TABLE lid_recheck_intent_x (a INTEGER)');
 refused(taken,read(INTENT));
 assert.equal(objects(t49),objects(t48)+7,'exactly the table, its two indexes and its four triggers are new');
 assert.equal(one(t49,'SELECT version FROM schema_contract WHERE id=1'),49);
 assert.equal(one(t49,'SELECT COUNT(*) FROM lid_recheck_intent'),0,'empty');
 refused(copy(t49),read(INTENT),/./);
 // the version never goes down
 refused(copy(t49),'UPDATE schema_contract SET version=48 WHERE id=1',/schema_contract_downgrade/);
}

// ===== 0049: the table =====
const HEX='a'.repeat(64);
const AT="'2026-11-27T10:00:00.000Z'";
const fresh=()=>copy(t49);
const open=(id='req-1',lid='Ab1')=>"INSERT INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at) VALUES ('"+id+"','"+lid+"','open',1,"+AT+","+AT+");";
const PROOF="proof_version=1,tmdb='603',final_url='https://letterboxd.com/film/m/',slug='m',canonical_path='/film/m/',title='M',year=1999,tmdb_doc_digest='"+HEX+"',attach_root='"+HEX+"'";
{
 const f=fresh();ok(f,open());
 assert.deepEqual(rows(f,'SELECT request_id,lid,state,outcome,revision,attempt_request_id,link_state FROM lid_recheck_intent'),[{request_id:'req-1',lid:'Ab1',state:'open',outcome:null,revision:1,attempt_request_id:null,link_state:null}]);
 refused(f,open(),/lid_recheck_intent_taken/);
 // inserts start clean
 const insert=(cols,vals)=>"INSERT INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at"+cols+") VALUES ('r9','Ab1','open',1,"+AT+","+AT+vals+")";
 refused(fresh(),"INSERT INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at) VALUES ('r9','Ab1','settled',1,"+AT+","+AT+")",/lid_recheck_intent_insert|CHECK/i);
 refused(fresh(),"INSERT INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at) VALUES ('r9','Ab1','open',2,"+AT+","+AT+")",/lid_recheck_intent_insert/);
 refused(fresh(),insert(",attempt_request_id",",'x'"),/lid_recheck_intent_insert/);
 refused(fresh(),insert(",outcome",",'still_none'"),/lid_recheck_intent_insert/);
 // shape CHECKs
 refused(fresh(),"INSERT INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at) VALUES ('r 9','Ab1','open',1,"+AT+","+AT+")",/CHECK/i);
 refused(fresh(),"INSERT INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at) VALUES ('r9','a b','open',1,"+AT+","+AT+")",/CHECK/i);
 refused(fresh(),"INSERT INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at) VALUES ('r9','Ab1','closed',1,"+AT+","+AT+")",/CHECK/i);
 refused(fresh(),"INSERT INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at) VALUES ('r9','Ab1','open',0,"+AT+","+AT+")",/CHECK/i);
 // proof columns are all-or-none (an insert without a root cannot hold one column)
 refused(f,"UPDATE lid_recheck_intent SET revision=2,tmdb='603' WHERE request_id='req-1'",/CHECK/i);
 refused(f,"UPDATE lid_recheck_intent SET revision=2,"+PROOF.replace("tmdb='603'","tmdb='0603'")+" WHERE request_id='req-1'",/CHECK/i);
 refused(f,"UPDATE lid_recheck_intent SET revision=2,"+PROOF.replace("attach_root='"+HEX+"'","attach_root='"+'A'.repeat(64)+"'")+" WHERE request_id='req-1'",/CHECK/i);
}

// ===== 0049: the compare-and-swap discipline =====
{
 const f=fresh();ok(f,open());
 // every update raises the revision by exactly one
 refused(f,"UPDATE lid_recheck_intent SET updated_at="+AT+" WHERE request_id='req-1'",/lid_recheck_intent_update/);
 refused(f,"UPDATE lid_recheck_intent SET revision=3 WHERE request_id='req-1'",/lid_recheck_intent_update/);
 refused(f,"UPDATE lid_recheck_intent SET revision=1 WHERE request_id='req-1'",/lid_recheck_intent_update/);
 ok(f,"UPDATE lid_recheck_intent SET revision=2,attempt_request_id='att-1' WHERE request_id='req-1' AND state='open' AND revision=1");
 // a compare-and-swap that read a stale revision matches nothing
 ok(f,"UPDATE lid_recheck_intent SET revision=2,attempt_request_id='att-2' WHERE request_id='req-1' AND state='open' AND revision=1");
 assert.equal(one(f,"SELECT attempt_request_id FROM lid_recheck_intent"),'att-1','the loser changed nothing');
 // ids never change
 refused(f,"UPDATE lid_recheck_intent SET revision=3,lid='Zz9' WHERE request_id='req-1'",/lid_recheck_intent_update/);
 refused(f,"UPDATE lid_recheck_intent SET revision=3,request_id='req-2' WHERE request_id='req-1'",/lid_recheck_intent_update/);
 refused(f,"UPDATE lid_recheck_intent SET revision=3,created_at='2026-11-28T10:00:00.000Z' WHERE request_id='req-1'",/lid_recheck_intent_update/);
 // a new observation replaces the proof inputs while nothing landed
 ok(f,"UPDATE lid_recheck_intent SET revision=3,"+PROOF+" WHERE request_id='req-1'");
 ok(f,"UPDATE lid_recheck_intent SET revision=4,"+PROOF.replace("attach_root='"+HEX+"'","attach_root='"+'b'.repeat(64)+"'")+" WHERE request_id='req-1'");
 // `attached` needs a root, a Film and an owner; the link is owed and the intent stays open
 refused(f,"UPDATE lid_recheck_intent SET revision=5,outcome='attached',link_state='owed' WHERE request_id='req-1'",/CHECK/i);
 refused(f,"UPDATE lid_recheck_intent SET revision=5,outcome='attached',film_id='film:lb:Ab1' WHERE request_id='req-1'",/CHECK/i);
 refused(f,"UPDATE lid_recheck_intent SET revision=5,outcome='attached',film_id='film:lb:Ab1',link_state='linked' WHERE request_id='req-1'",/CHECK|lid_recheck_intent_update/i);
 refused(f,"UPDATE lid_recheck_intent SET revision=5,state='settled',outcome='attached',film_id='film:lb:Ab1',link_state='owed' WHERE request_id='req-1'",/CHECK/i);
 refused(f,"UPDATE lid_recheck_intent SET revision=5,link_state='owed' WHERE request_id='req-1'",/CHECK/i);
 ok(f,"UPDATE lid_recheck_intent SET revision=5,outcome='attached',film_id='film:lb:Ab1',link_state='owed' WHERE request_id='req-1'");
 // once attached the root, the Film, the owner and the outcome are frozen
 for(const set of ["attach_root='"+'c'.repeat(64)+"'","film_id='film:lb:Zz9'","tmdb='604'","outcome='still_none'","attempt_request_id='att-9'","title='N'"])refused(f,"UPDATE lid_recheck_intent SET revision=6,"+set+" WHERE request_id='req-1'",/lid_recheck_intent_update|CHECK/i);
 // the link state moves only owed -> a terminal value, and a terminal value settles the intent
 refused(f,"UPDATE lid_recheck_intent SET revision=6,link_state='bogus' WHERE request_id='req-1'",/CHECK/i);
 refused(f,"UPDATE lid_recheck_intent SET revision=6,state='settled',link_state='owed' WHERE request_id='req-1'",/CHECK/i);
 const g=copy(f);
 ok(g,"UPDATE lid_recheck_intent SET revision=6,state='settled',link_state='linked' WHERE request_id='req-1' AND state='open' AND revision=5 AND link_state='owed'");
 assert.deepEqual(rows(g,'SELECT state,outcome,link_state,revision FROM lid_recheck_intent'),[{state:'settled',outcome:'attached',link_state:'linked',revision:6}]);
 // a settled row is frozen, whatever is written
 refused(g,"UPDATE lid_recheck_intent SET revision=7 WHERE request_id='req-1'",/lid_recheck_intent_update/);
 refused(g,"UPDATE lid_recheck_intent SET revision=7,link_state='alias_conflict' WHERE request_id='req-1'",/lid_recheck_intent_update/);
 for(const terminal of ['alias_conflict','link_blocked']){const h=copy(f);ok(h,"UPDATE lid_recheck_intent SET revision=6,state='settled',link_state='"+terminal+"' WHERE request_id='req-1'");assert.equal(one(h,'SELECT link_state FROM lid_recheck_intent'),terminal);}
 // never deleted
 refused(f,"DELETE FROM lid_recheck_intent WHERE request_id='req-1'",/lid_recheck_intent_keep/);
 refused(f,"INSERT OR REPLACE INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at) VALUES ('req-1','Ab1','open',1,"+AT+","+AT+")",/lid_recheck_intent_taken/);
 // a terminal non-attach outcome settles without a Film
 const s=fresh();ok(s,open('req-s','Cc3'));
 ok(s,"UPDATE lid_recheck_intent SET revision=2,state='settled',outcome='still_none' WHERE request_id='req-s'");
 refused(s,"UPDATE lid_recheck_intent SET revision=3,outcome='tmdb_retired' WHERE request_id='req-s'",/lid_recheck_intent_update/);
}

// ===== 0050: the predecessor and the rebuild =====
const AT2='2026-11-27T12:00:00.000Z';
const change=(writer,kind,from,to,generation,extra={})=>"INSERT INTO identity_evidence_writer_change (writer,kind,from_state,to_state,generation,reason,deployed_version,evidence_link,drain_evidence,break_from,recorded_at) VALUES ('"+writer+"','"+kind+"','"+from+"','"+to+"',"+generation+",'a reason','v1','https://trello.com/c/x',"+(extra.drain?"'"+extra.drain+"'":'NULL')+","+(extra.breakFrom?"'"+extra.breakFrom+"'":'NULL')+",'"+(extra.at||AT2)+"');";
{
 // a database at 49 with real history: a writer that went off -> pending -> on -> off -> pending -> on, another that is pending, and one that is absent
 const base=copy(t49);
 ok(base,change('discovery_decision','activate','off','pending',1,{at:'2026-11-27T10:00:00.000Z'})+change('discovery_decision','drain_complete','pending','on',2,{drain:'only v2 serves',at:'2026-11-27T10:30:00.000Z'})
  +change('discovery_decision','deactivate','on','off',3,{at:'2026-11-27T11:00:00.000Z'})+change('discovery_decision','activate','off','pending',4,{at:'2026-11-27T11:10:00.000Z'})
  +change('discovery_decision','drain_complete','pending','on',5,{drain:'again',at:'2026-11-27T11:20:00.000Z'})
  +change('claim_alias_bridge','activate','off','pending',1,{at:'2026-11-27T11:30:00.000Z'}));
 const before={control:rows(base,'SELECT * FROM identity_evidence_writer ORDER BY writer'),history:rows(base,'SELECT * FROM identity_evidence_writer_change ORDER BY seq'),
  triggers:rows(base,"SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").map(r=>r.name),indexes:rows(base,"SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").map(r=>r.name)};
 assert.equal(before.history.length,6);

 const stale=path.join(root,'t48b.sqlite');fs.copyFileSync(t48,stale);
 const staleBefore=objects(stale);refused(stale,read(WRITER));assert.equal(objects(stale),staleBefore,'a refused file creates nothing');
 const noIndex=copy(t49);ok(noIndex,'DROP INDEX identity_evidence_writer_change_writer');refused(noIndex,read(WRITER));
 const noTrigger=copy(t49);ok(noTrigger,'DROP TRIGGER identity_evidence_writer_change_current');refused(noTrigger,read(WRITER));
 const noIntent=copy(t49);ok(noIntent,'DROP TRIGGER lid_recheck_intent_keep;DROP TABLE lid_recheck_intent');refused(noIntent,read(WRITER));
 const leftover=copy(t49);ok(leftover,'CREATE TABLE identity_evidence_writer_hold (a INTEGER)');refused(leftover,read(WRITER));

 const f=copy(base);ok(f,read(WRITER));
 assert.equal(one(f,'SELECT version FROM schema_contract WHERE id=1'),50);
 assert.deepEqual(rows(f,'SELECT * FROM identity_evidence_writer ORDER BY writer'),before.control,'every control row is unchanged');
 assert.deepEqual(rows(f,'SELECT * FROM identity_evidence_writer_change ORDER BY seq'),before.history,'the append-only history is unchanged, with its own seq values');
 assert.deepEqual(rows(f,"SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").map(r=>r.name),before.triggers,'the same triggers');
 assert.deepEqual(rows(f,"SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").map(r=>r.name),before.indexes,'the same indexes');
 assert.equal(one(f,"SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%_hold'"),0,'no staging table is left');
 assert.equal(one(f,"SELECT seq FROM sqlite_sequence WHERE name='identity_evidence_writer_change'"),6,'AUTOINCREMENT continues after the highest seq');
 refused(copy(f),read(WRITER),/./);
 // replay on an empty control: the same file on a database with no rows
 assert.equal(one(t50,'SELECT COUNT(*) FROM identity_evidence_writer'),0);assert.equal(one(t50,'SELECT version FROM schema_contract WHERE id=1'),50);

 // the sixth writer: the same compare-and-swap, history and coverage as the others
 const g=copy(f);
 ok(g,change('lid_tmdb_attach','activate','off','pending',1,{at:'2026-11-27T13:00:00.000Z'}));
 assert.deepEqual(rows(g,"SELECT state,generation,coverage_from FROM identity_evidence_writer WHERE writer='lid_tmdb_attach'"),[{state:'pending',generation:1,coverage_from:null}]);
 refused(g,change('lid_tmdb_attach','drain_complete','pending','on',3,{drain:'x',at:'2026-11-27T13:05:00.000Z'}),/identity_evidence_writer_change_stale/);
 refused(g,change('lid_tmdb_attach','drain_complete','pending','on',2),/CHECK/i);
 ok(g,change('lid_tmdb_attach','drain_complete','pending','on',2,{drain:'only versions with the attach serve',at:'2026-11-27T13:10:00.000Z'}));
 assert.deepEqual(rows(g,"SELECT state,generation,coverage_from FROM identity_evidence_writer WHERE writer='lid_tmdb_attach'"),[{state:'on',generation:2,coverage_from:'2026-11-27T13:10:00.000Z'}]);
 ok(g,change('lid_tmdb_attach','break','on','off',3,{breakFrom:'2026-11-27T13:20:00.000Z',at:'2026-11-27T13:30:00.000Z'}));
 assert.equal(one(g,"SELECT state FROM identity_evidence_writer WHERE writer='lid_tmdb_attach'"),'off');
 ok(g,change('lid_tmdb_attach','activate','off','pending',4,{at:'2026-11-27T14:00:00.000Z'}));
 ok(g,change('lid_tmdb_attach','deactivate','pending','off',5,{at:'2026-11-27T14:10:00.000Z'}));
 assert.equal(one(g,"SELECT COUNT(*) FROM identity_evidence_writer_change WHERE writer='lid_tmdb_attach'"),5);
 // the other writers are untouched by it
 assert.deepEqual(rows(g,"SELECT state,generation FROM identity_evidence_writer WHERE writer='discovery_decision'"),[{state:'on',generation:5}]);
 // a seventh writer is still refused, in both tables
 refused(copy(f),change('lid_only_attach','activate','off','pending',1),/CHECK/i);
 refused(copy(f),"INSERT INTO identity_evidence_writer (writer,state,generation,coverage_from,updated_at) VALUES ('lid_tmdb_attach','pending',1,NULL,'"+AT2+"')",/identity_evidence_writer_transition/);
 // the old guarantees: append-only, no direct control writes, no stale generation, no delete
 refused(g,"UPDATE identity_evidence_writer_change SET reason='x'",/identity_evidence_writer_change_append_only/);
 refused(g,"DELETE FROM identity_evidence_writer_change",/identity_evidence_writer_change_append_only/);
 refused(g,"INSERT OR REPLACE INTO identity_evidence_writer_change (seq,writer,kind,from_state,to_state,generation,reason,deployed_version,evidence_link,recorded_at) VALUES (1,'discovery_decision','activate','off','pending',1,'r','v','l','"+AT2+"')",/identity_evidence_writer_change_taken|identity_evidence_writer_change_stale|append_only/);
 refused(g,"UPDATE identity_evidence_writer SET state='off' WHERE writer='lid_tmdb_attach'",/identity_evidence_writer_transition/);
 refused(g,"UPDATE identity_evidence_writer SET state='on',generation=99 WHERE writer='lid_tmdb_attach'",/identity_evidence_writer_transition/);
 refused(g,"DELETE FROM identity_evidence_writer",/identity_evidence_writer_no_delete/);
 // a writer of the old five is still activatable after the rebuild (the same triggers)
 ok(g,change('tmdb_retirement_decision','activate','off','pending',1,{at:'2026-11-27T15:00:00.000Z'}));
 // the import-run triggers of 0044 still resolve their writer table
 assert.equal(one(g,"SELECT COUNT(*) FROM identity_evidence_writer WHERE state='on'"),1);
}
console.log('Lid recheck intent and attach writer migrations (AIR-675, 0049 and 0050) passed.');
