// AIR-647: migration 0043 (one additive lookup index film_redirect_by_target on film_redirect(to_film_id)). Offline only: scratch sqlite databases built from the
// real chain; nothing is applied anywhere.
//  - the chain 41 -> 42 -> 43, and the refusals (wrong predecessor, inconsistent 42, a missing singleton, a second apply, a same-named object of any shape);
//  - 0043 changes no data: a full dump of a populated synthetic redirect forest before and after differs only by the index and the schema_contract row;
//  - the real ancestry statement of the FilmAggregateV1 display section (DISPLAY_SQL): before, film_redirect is read without the index; after, it is SEARCHed by it;
//    the statement returns the same rows, for survivors with and without ancestors and for ids that are not Films at all;
//  - the other readers of the redirect table by target (the AIR-372 read model, the merge retarget) are index-served after, and change the same rows;
//  - the readers by `from_id` keep the primary key, the foreign key and the uniqueness of the table, and the schema version never goes down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {DISPLAY_SQL,OWNER_ANCESTOR_DEPTH,OWNER_ANCESTORS_MAX,OWNER_ENTRIES_MAX} from '../src/film-aggregate.js';

const M43=fs.readFileSync('migrations/0043_film_redirect_by_target.sql','utf8');
const INDEX='film_redirect_by_target';
const run=(file,text)=>sqliteSync(['-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<28});
const exec=(file,text)=>{const result=run(file,text);if(result.status!==0)throw new Error(result.stderr);return String(result.stdout);};
const rows=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=String(result.stdout).trim();return out?JSON.parse(out):[];};
const version=file=>Number(rows(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const objects=file=>rows(file,"SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").map(item=>item.type+':'+item.name);
let copies=0;
const copyOf=(file,name)=>{const target=file.replace(/\.sqlite$/,'-'+name+'-'+(copies++)+'.sqlite');fs.copyFileSync(file,target);return target;};
const dump=file=>{const result=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<30});if(result.status!==0)throw new Error(result.stderr);return String(result.stdout).split('\n');};
const plan=(file,text)=>{const out=run(file,'EXPLAIN QUERY PLAN '+text+';');assert.equal(out.status,0,out.stderr);return String(out.stdout).split('\n').map(line=>line.replace(/^[\s|`-]+/,'').trim()).filter(Boolean);};
const q=value=>"'"+String(value).replace(/'/g,"''")+"'";

// ---- 1. the chain and the refusals ---------------------------------------------------------------------------------------------------------------------
const v41=migrated(41);
assert.equal(version(v41),41);
const refuse=(file,reason)=>{
 const before=dump(file),result=run(file,M43);
 assert.notEqual(result.status,0,reason+': the file aborts');
 assert.deepEqual(dump(file),before,reason+': the whole state is unchanged');
};
refuse(copyOf(v41,'on41'),'on version 41 (0042 is not applied)');
const v42=migrated(42);
assert.equal(version(v42),42);
assert.ok(!objects(v42).includes('index:'+INDEX),'version 42 has no redirect target index');
assert.ok(objects(v42).includes('index:tmdb_retirement_decision_movie'),'version 42 carries the 0040 index');
const noDowngrade=rows(v42,"SELECT sql FROM sqlite_master WHERE name='schema_contract_no_downgrade'")[0].sql;
for(const [name,statement] of [
 ['an absent schema_contract row','DELETE FROM schema_contract;'],
 ['a missing 0040 retirement-ledger index','DROP INDEX tmdb_retirement_decision_movie;'],
 ['a missing 0041 append-only no-update trigger','DROP TRIGGER film_identity_evidence_no_update;'],
 ['a missing 0041 append-only no-delete trigger','DROP TRIGGER film_identity_evidence_no_delete;'],
 ['a missing 0042 writer control table','DROP TABLE identity_evidence_writer;'],
 ['a missing 0042 append-only trigger','DROP TRIGGER identity_evidence_writer_change_no_update;'],
 ['a missing 0042 append-only no-delete trigger','DROP TRIGGER identity_evidence_writer_change_no_delete;'],
 ['a missing no-downgrade trigger','DROP TRIGGER schema_contract_no_downgrade;'],
 ['a missing identity evidence ledger','DROP TABLE film_identity_evidence;'],
 ['a missing redirect table','PRAGMA foreign_keys=OFF;ALTER TABLE film_redirect RENAME TO film_redirect_gone;'],
 ['a missing retirement ledger table','PRAGMA foreign_keys=OFF;ALTER TABLE tmdb_retirement_decision RENAME TO tmdb_retirement_decision_gone;'],
 // Every object present, only the version differs (the no-downgrade trigger is put back exactly as it was).
 ['every object present at version 41','DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=41 WHERE id=1;'+noDowngrade+';'],
 ['every object present at version 44','UPDATE schema_contract SET version=44 WHERE id=1;'],
]){
 const file=copyOf(v42,'bad');
 exec(file,statement);
 const before=dump(file),result=run(file,M43);
 assert.notEqual(result.status,0,name+': the file aborts');
 assert.deepEqual(dump(file),before,name+': the whole state is unchanged');
 assert.ok(!objects(file).includes('index:'+INDEX),name+': no index installed');
}
// The guard names the objects of its immediate predecessors (review of 8826e92: removing identity_evidence_writer_change_apply, _current or _conflict left every earlier
// condition true). One refusal per object, with the whole state unchanged: presence checks, not a claim of full schema integrity; 0042 itself is not touched.
const refusal=(file,name)=>{
 const before=dump(file),result=run(file,M43);
 assert.notEqual(result.status,0,name+': the file aborts');
 assert.deepEqual(dump(file),before,name+': the whole state is unchanged');
 assert.ok(!objects(file).includes('index:'+INDEX),name+': no index installed');
};
const GUARDED_INDEXES=['tmdb_retirement_decision_movie','film_identity_evidence_subject','film_identity_evidence_object','film_identity_evidence_scope','film_identity_evidence_superseded_once','film_identity_evidence_scope_ref','identity_evidence_writer_change_writer'];
const GUARDED_TRIGGERS=['film_identity_evidence_insert_open','film_identity_evidence_insert_conflict','film_identity_evidence_no_update','film_identity_evidence_no_delete','film_identity_evidence_insert_shape','film_identity_evidence_film_bound','film_identity_evidence_scope_target','film_identity_evidence_supersedes_target','film_identity_evidence_scope_arrival','film_identity_evidence_source_order','identity_evidence_writer_change_apply','identity_evidence_writer_change_conflict','identity_evidence_writer_change_current','identity_evidence_writer_change_no_delete','identity_evidence_writer_change_no_update','identity_evidence_writer_insert','identity_evidence_writer_update','identity_evidence_writer_no_delete','schema_contract_no_downgrade'];
for(const name of GUARDED_INDEXES){const file=copyOf(v42,'gi');exec(file,'DROP INDEX '+name+';');refusal(file,'a missing index '+name);}
for(const name of GUARDED_TRIGGERS){const file=copyOf(v42,'gt');exec(file,'DROP TRIGGER '+name+';');refusal(file,'a missing trigger '+name);}
// The four ledger triggers that 0042 REPLACED: the 0041 version of each is not a complete 0042.
for(const name of ['film_identity_evidence_insert_shape','film_identity_evidence_insert_open','film_identity_evidence_film_bound','film_identity_evidence_scope_target']){
 const old41=rows(v41,"SELECT sql FROM sqlite_master WHERE name='"+name+"'")[0].sql;
 const file=copyOf(v42,'old');exec(file,'DROP TRIGGER '+name+';'+old41+';');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='"+name+"'")[0].n,1);
 refusal(file,'the 0041 version of the trigger '+name);
}
// The ledger column of 0042: the chain through 0041 plus 0042 without its ALTER TABLE is every named object and no `source_order`.
{
 const m42=fs.readFileSync('migrations/0042_identity_evidence_writer_control.sql','utf8');
 const without=m42.replace(/^ALTER TABLE film_identity_evidence ADD COLUMN source_order.*$/m,'');
 assert.notEqual(without,m42,'the 0042 column statement was found');
 const file=copyOf(v41,'nocol');exec(file,without);
 assert.equal(version(file),42);
 assert.ok(!/source_order/.test(rows(file,"SELECT sql FROM sqlite_master WHERE name='film_identity_evidence'")[0].sql),'the ledger lacks the column');
 for(const name of GUARDED_TRIGGERS)assert.ok(objects(file).includes('trigger:'+name),name+' is present: only the column is missing');
 refusal(file,'a ledger without the 0042 source_order column');
}
{
 const early=copyOf(v42,'early');exec(early,'CREATE INDEX '+INDEX+' ON film_redirect (to_film_id);');refuse(early,'a pre-existing index of the same name');
 const shape=copyOf(v42,'shape');exec(shape,'CREATE INDEX '+INDEX+' ON film_redirect (at);');refuse(shape,'a same-named index of another shape');
 const table=copyOf(v42,'table');exec(table,'CREATE TABLE '+INDEX+' (x INTEGER);');refuse(table,'a same-named table');
 const view=copyOf(v42,'view');exec(view,'CREATE VIEW '+INDEX+' AS SELECT 1 AS x;');refuse(view,'a same-named view');
}

// ---- 2. a populated synthetic redirect forest, then the real migration ---------------------------------------------------------------------------------
// 300 survivors; 2000 Films merged straight into them (level 1), 1500 merged into level 1 (level 2), 800 into level 2 (level 3): a forest with branches and depth.
// Targets must be Film rows (foreign key); the merged ids themselves need none. Synthetic values only.
const AT='2026-11-25T00:00:00.000Z';
exec(v42,`PRAGMA foreign_keys=ON;
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<300)
 INSERT INTO film (id,contract_version,updated_at) SELECT 'film:s:'||i,1,'${AT}' FROM n;
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000)
 INSERT INTO film (id,contract_version,updated_at) SELECT 'film:l1:'||i,1,'${AT}' FROM n;
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500)
 INSERT INTO film (id,contract_version,updated_at) SELECT 'film:l2:'||i,1,'${AT}' FROM n;
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000)
 INSERT INTO film_redirect (from_id,to_film_id,at) SELECT 'film:l1:'||i,'film:s:'||(1+(i%300)),'${AT}' FROM n;
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500)
 INSERT INTO film_redirect (from_id,to_film_id,at) SELECT 'film:l2:'||i,'film:l1:'||(1+(i%2000)),'${AT}' FROM n;
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<800)
 INSERT INTO film_redirect (from_id,to_film_id,at) SELECT 'film:l3:'||i,'film:l2:'||(1+(i%1500)),'${AT}' FROM n;`);
const EDGES=Number(rows(v42,'SELECT COUNT(*) AS n FROM film_redirect')[0].n);
assert.equal(EDGES,4300);

const before=copyOf(v42,'before'),after=copyOf(v42,'after');
const dumpBefore=dump(before);
exec(after,M43);
assert.equal(version(after),43);
assert.deepEqual(objects(after),[...objects(before),'index:'+INDEX].sort(),'exactly the one index is new');
refuse(copyOf(after,'again'),'a second apply on version 43');
assert.equal(version(migrated(42)),42,'the chain through 0042 ends at version 42');
assert.ok(!objects(migrated(42)).includes('index:'+INDEX),'the chain through 0042 has no such index');
assert.equal(version(migrated()),46,'the full chain ends at version 46 (0046, AIR-605, after 0045, AIR-604, which follows 0044, AIR-639 and this 0043)');
assert.ok(objects(migrated()).includes('index:'+INDEX),'the full chain carries the index');
assert.ok(objects(migrated(42)).every(name=>objects(migrated()).includes(name)),'0043 keeps every earlier object');

const shape=rows(after,"SELECT name,\"unique\" AS uniq,partial FROM pragma_index_list('film_redirect')").find(item=>item.name===INDEX);
assert.equal(shape.uniq,0,'non-unique');assert.equal(shape.partial,0,'not partial');
assert.deepEqual(rows(after,"SELECT name FROM pragma_index_info('"+INDEX+"') ORDER BY seqno").map(item=>item.name),['to_film_id']);

const dumpAfter=dump(after);
const strip=lines=>lines.filter(line=>!line.startsWith('INSERT INTO schema_contract')&&!line.includes(INDEX));
assert.deepEqual(strip(dumpAfter),strip(dumpBefore),'every redirect row, Film, claim, trigger, marker and authority row is unchanged');
assert.equal(dumpAfter.filter(line=>line.startsWith('INSERT INTO schema_contract')).length,1,'still one schema_contract row');
assert.match(dumpAfter.find(line=>line.startsWith('INSERT INTO schema_contract')),/\b43\b/);
assert.equal(Number(rows(after,'SELECT COUNT(*) AS n FROM film_redirect')[0].n),EDGES,'no redirect row was added or removed');

// ---- 3. the real ancestry statement of the display section ----------------------------------------------------------------------------------------------
const bind=id=>{
 const params=[id,OWNER_ANCESTORS_MAX+1,OWNER_ANCESTOR_DEPTH,OWNER_ANCESTORS_MAX+2,id,id,OWNER_ENTRIES_MAX+1,id,11,id,id,61];let i=0;
 const text=DISPLAY_SQL.replace(/\?/g,()=>{const v=params[i++];return typeof v==='number'?String(v):q(v);});
 assert.equal(i,params.length,'every parameter is bound');return text;
};
const ancestry=(file,text)=>JSON.parse(rows(file,text)[0].ancestors).map(r=>JSON.stringify(r)).sort();
const readsRedirect=lines=>lines.filter(d=>/^(SCAN|SEARCH) film_redirect\b/.test(d));
const survivors={survivorWithBranches:'film:s:7',leafOnly:'film:l3:5',middle:'film:l1:9',deep:'film:l2:11',notAFilm:'film:none:1'};
for(const [name,id] of Object.entries(survivors)){
 const text=bind(id),b=plan(before,text),a=plan(after,text);
 const stepBefore=readsRedirect(b).join('|'),stepAfter=readsRedirect(a).join('|');
 assert.ok(!/USING INDEX film_redirect_by_target/.test(stepBefore),name+': before 0043 there is no such index\n'+b.join('\n'));
 assert.ok(/SCAN film_redirect\b|AUTOMATIC/.test(stepBefore+'|'+b.join('|')),name+': before 0043 the redirect table is scanned or auto-indexed per query\n'+b.join('\n'));
 assert.ok(a.some(d=>/^SEARCH film_redirect USING INDEX film_redirect_by_target \(to_film_id=\?\)/.test(d)),name+': after 0043 the ancestry step is a SEARCH by the new index\n'+a.join('\n'));
 assert.ok(!a.some(d=>/^SCAN film_redirect\b/.test(d))&&!a.some(d=>/AUTOMATIC/.test(d)),name+': after 0043 no scan and no automatic index of the redirect table\n'+a.join('\n'));
 const scans=a.filter(d=>/^SCAN /.test(d)&&!/json_each|^SCAN j\b|SCAN CONSTANT ROW|^SCAN \(subquery-\d+\)$|^SCAN (a|anc)$/.test(d));
 assert.deepEqual(scans,[],name+': no base-table scan\n'+a.join('\n'));
 assert.deepEqual(ancestry(after,text),ancestry(before,text),name+': the statement returns the same ancestry rows');
}
assert.ok(ancestry(after,bind('film:s:7')).length>5,'a populated survivor has a real tree');
assert.deepEqual(ancestry(after,bind('film:none:1')),[JSON.stringify(['film:none:1',null,0])],'an id that is not a Film is only itself');
// The bounds hold on the populated forest too: a survivor with a long tree stops at the row cap.
const widest=rows(after,'SELECT to_film_id,COUNT(*) AS n FROM film_redirect GROUP BY to_film_id ORDER BY n DESC LIMIT 1')[0];
assert.ok(JSON.parse(rows(after,bind(widest.to_film_id))[0].ancestors).length<=OWNER_ANCESTORS_MAX+2);

// ---- 4. the other readers by target, and the readers by from_id -----------------------------------------------------------------------------------------
const READ_MODEL="SELECT from_id,to_film_id FROM film_redirect WHERE to_film_id IN ('film:s:1','film:s:2','film:l1:1','film:l2:3') ORDER BY from_id LIMIT 301";
const RETARGET="UPDATE film_redirect SET to_film_id='film:s:2' WHERE to_film_id='film:s:1' AND from_id<>'film:s:2'";
assert.deepEqual(rows(after,READ_MODEL),rows(before,READ_MODEL),'the AIR-372 retired-ids reader returns the same rows');
assert.ok(plan(after,READ_MODEL).some(d=>/^SEARCH film_redirect USING (COVERING )?INDEX film_redirect_by_target\b/.test(d)),'the reader by target is index-served after 0043\n'+plan(after,READ_MODEL).join('\n'));
assert.ok(!plan(before,READ_MODEL).some(d=>/film_redirect_by_target/.test(d)));
{
 const b=copyOf(before,'retarget-b'),a=copyOf(after,'retarget-a');
 exec(b,RETARGET+';');exec(a,RETARGET+';');
 assert.deepEqual(strip(dump(a)),strip(dump(b)),'the merge retarget changes the same rows with or without the index');
 assert.ok(plan(after,RETARGET).some(d=>/film_redirect_by_target/.test(d)),'the merge retarget is index-served after 0043\n'+plan(after,RETARGET).join('\n'));
}
const BY_FROM='SELECT to_film_id FROM film_redirect WHERE from_id=\'film:l2:7\'';
assert.deepEqual(rows(after,BY_FROM),rows(before,BY_FROM));
assert.ok(plan(after,BY_FROM).every(d=>!/film_redirect_by_target/.test(d)),'the reader by from_id keeps the primary key');
// The foreign key and the uniqueness of the table are unchanged by the index.
assert.notEqual(run(copyOf(after,'fk'),"PRAGMA foreign_keys=ON;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:z:1','film:missing',"+q(AT)+");").status,0,'a redirect to a missing Film is still refused');
assert.notEqual(run(copyOf(after,'pk'),"PRAGMA foreign_keys=ON;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:l1:1','film:s:2',"+q(AT)+");").status,0,'a second redirect of the same Film is still refused');
assert.equal(run(copyOf(after,'ok'),"PRAGMA foreign_keys=ON;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:z:2','film:s:2',"+q(AT)+");").status,0,'a valid redirect is still accepted');
assert.equal(run(copyOf(after,'down'),'UPDATE schema_contract SET version=42 WHERE id=1;').status!==0,true,'the version never goes down');

console.log('migration 0043 film redirect target index: ok');
