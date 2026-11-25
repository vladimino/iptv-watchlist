// AIR-647: migration 0042 (one additive lookup index film_redirect_by_target on film_redirect(to_film_id)). Offline only: scratch sqlite databases built from the
// real chain; nothing is applied anywhere.
//  - the chain 40 -> 41 -> 42, and the refusals (wrong predecessor, inconsistent 41, a missing singleton, a second apply, a same-named object of any shape);
//  - 0042 changes no data: a full dump of a populated synthetic redirect forest before and after differs only by the index and the schema_contract row;
//  - the real ancestry statement of the FilmAggregateV1 display section (DISPLAY_SQL): before, film_redirect is read without the index; after, it is SEARCHed by it;
//    the statement returns the same rows, for survivors with and without ancestors and for ids that are not Films at all;
//  - the other readers of the redirect table by target (the AIR-372 read model, the merge retarget) are index-served after, and change the same rows;
//  - the readers by `from_id` keep the primary key, the foreign key and the uniqueness of the table, and the schema version never goes down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {DISPLAY_SQL,OWNER_ANCESTOR_DEPTH,OWNER_ANCESTORS_MAX,OWNER_ENTRIES_MAX} from '../src/film-aggregate.js';

const M42=fs.readFileSync('migrations/0042_film_redirect_by_target.sql','utf8');
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
const v40=migrated(40);
assert.equal(version(v40),40);
const refuse=(file,reason)=>{
 const before=dump(file),result=run(file,M42);
 assert.notEqual(result.status,0,reason+': the file aborts');
 assert.deepEqual(dump(file),before,reason+': the whole state is unchanged');
};
refuse(copyOf(v40,'on40'),'on version 40 (0041 is not applied)');
const v41=migrated(41);
assert.equal(version(v41),41);
assert.ok(!objects(v41).includes('index:'+INDEX),'version 41 has no redirect target index');
assert.ok(objects(v41).includes('index:tmdb_retirement_decision_movie'),'version 41 carries the 0040 index');
const noDowngrade=rows(v41,"SELECT sql FROM sqlite_master WHERE name='schema_contract_no_downgrade'")[0].sql;
for(const [name,statement] of [
 ['an absent schema_contract row','DELETE FROM schema_contract;'],
 ['a missing 0040 retirement-ledger index','DROP INDEX tmdb_retirement_decision_movie;'],
 ['a missing 0041 append-only no-update trigger','DROP TRIGGER film_identity_evidence_no_update;'],
 ['a missing 0041 append-only no-delete trigger','DROP TRIGGER film_identity_evidence_no_delete;'],
 ['a missing no-downgrade trigger','DROP TRIGGER schema_contract_no_downgrade;'],
 ['a missing identity evidence ledger','DROP TABLE film_identity_evidence;'],
 ['a missing redirect table','PRAGMA foreign_keys=OFF;ALTER TABLE film_redirect RENAME TO film_redirect_gone;'],
 ['a missing retirement ledger table','PRAGMA foreign_keys=OFF;ALTER TABLE tmdb_retirement_decision RENAME TO tmdb_retirement_decision_gone;'],
 // Every object present, only the version differs (the no-downgrade trigger is put back exactly as it was).
 ['every object present at version 40','DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=40 WHERE id=1;'+noDowngrade+';'],
 ['every object present at version 43','UPDATE schema_contract SET version=43 WHERE id=1;'],
]){
 const file=copyOf(v41,'bad');
 exec(file,statement);
 const before=dump(file),result=run(file,M42);
 assert.notEqual(result.status,0,name+': the file aborts');
 assert.deepEqual(dump(file),before,name+': the whole state is unchanged');
 assert.ok(!objects(file).includes('index:'+INDEX),name+': no index installed');
}
{
 const early=copyOf(v41,'early');exec(early,'CREATE INDEX '+INDEX+' ON film_redirect (to_film_id);');refuse(early,'a pre-existing index of the same name');
 const shape=copyOf(v41,'shape');exec(shape,'CREATE INDEX '+INDEX+' ON film_redirect (at);');refuse(shape,'a same-named index of another shape');
 const table=copyOf(v41,'table');exec(table,'CREATE TABLE '+INDEX+' (x INTEGER);');refuse(table,'a same-named table');
 const view=copyOf(v41,'view');exec(view,'CREATE VIEW '+INDEX+' AS SELECT 1 AS x;');refuse(view,'a same-named view');
}

// ---- 2. a populated synthetic redirect forest, then the real migration ---------------------------------------------------------------------------------
// 300 survivors; 2000 Films merged straight into them (level 1), 1500 merged into level 1 (level 2), 800 into level 2 (level 3): a forest with branches and depth.
// Targets must be Film rows (foreign key); the merged ids themselves need none. Synthetic values only.
const AT='2026-11-25T00:00:00.000Z';
exec(v41,`PRAGMA foreign_keys=ON;
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
const EDGES=Number(rows(v41,'SELECT COUNT(*) AS n FROM film_redirect')[0].n);
assert.equal(EDGES,4300);

const before=copyOf(v41,'before'),after=copyOf(v41,'after');
const dumpBefore=dump(before);
exec(after,M42);
assert.equal(version(after),42);
assert.deepEqual(objects(after),[...objects(before),'index:'+INDEX].sort(),'exactly the one index is new');
refuse(copyOf(after,'again'),'a second apply on version 42');
assert.equal(version(migrated(41)),41,'the chain through 0041 ends at version 41');
assert.ok(!objects(migrated(41)).includes('index:'+INDEX),'the chain through 0041 has no such index');
assert.equal(version(migrated()),42,'the full chain ends at version 42');
assert.ok(objects(migrated()).includes('index:'+INDEX),'the full chain carries the index');
assert.ok(objects(migrated(41)).every(name=>objects(migrated()).includes(name)),'0042 keeps every earlier object');

const shape=rows(after,"SELECT name,\"unique\" AS uniq,partial FROM pragma_index_list('film_redirect')").find(item=>item.name===INDEX);
assert.equal(shape.uniq,0,'non-unique');assert.equal(shape.partial,0,'not partial');
assert.deepEqual(rows(after,"SELECT name FROM pragma_index_info('"+INDEX+"') ORDER BY seqno").map(item=>item.name),['to_film_id']);

const dumpAfter=dump(after);
const strip=lines=>lines.filter(line=>!line.startsWith('INSERT INTO schema_contract')&&!line.includes(INDEX));
assert.deepEqual(strip(dumpAfter),strip(dumpBefore),'every redirect row, Film, claim, trigger, marker and authority row is unchanged');
assert.equal(dumpAfter.filter(line=>line.startsWith('INSERT INTO schema_contract')).length,1,'still one schema_contract row');
assert.match(dumpAfter.find(line=>line.startsWith('INSERT INTO schema_contract')),/\b42\b/);
assert.equal(Number(rows(after,'SELECT COUNT(*) AS n FROM film_redirect')[0].n),EDGES,'no redirect row was added or removed');

// ---- 3. the real ancestry statement of the display section ----------------------------------------------------------------------------------------------
const bind=id=>{
 const params=[id,OWNER_ANCESTOR_DEPTH,OWNER_ANCESTORS_MAX+2,id,id,OWNER_ENTRIES_MAX+1,id,11,id,id,61];let i=0;
 const text=DISPLAY_SQL.replace(/\?/g,()=>{const v=params[i++];return typeof v==='number'?String(v):q(v);});
 assert.equal(i,params.length,'every parameter is bound');return text;
};
const ancestry=(file,text)=>JSON.parse(rows(file,text)[0].ancestors).map(r=>JSON.stringify(r)).sort();
const readsRedirect=lines=>lines.filter(d=>/film_redirect\b|\br\b/.test(d)&&/^(SCAN|SEARCH) r\b/.test(d));
const survivors={survivorWithBranches:'film:s:7',leafOnly:'film:l3:5',middle:'film:l1:9',deep:'film:l2:11',notAFilm:'film:none:1'};
for(const [name,id] of Object.entries(survivors)){
 const text=bind(id),b=plan(before,text),a=plan(after,text);
 const stepBefore=readsRedirect(b).join('|'),stepAfter=readsRedirect(a).join('|');
 assert.ok(!/USING INDEX film_redirect_by_target/.test(stepBefore),name+': before 0042 there is no such index\n'+b.join('\n'));
 assert.ok(/SCAN r\b|AUTOMATIC/.test(stepBefore+'|'+b.join('|')),name+': before 0042 the redirect table is scanned or auto-indexed per query\n'+b.join('\n'));
 assert.ok(a.some(d=>/^SEARCH r USING INDEX film_redirect_by_target \(to_film_id=\?\)/.test(d)),name+': after 0042 the ancestry step is a SEARCH by the new index\n'+a.join('\n'));
 assert.ok(!a.some(d=>/^SCAN r\b/.test(d))&&!a.some(d=>/AUTOMATIC/.test(d)),name+': after 0042 no scan and no automatic index of the redirect table\n'+a.join('\n'));
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
assert.ok(plan(after,READ_MODEL).some(d=>/^SEARCH film_redirect USING (COVERING )?INDEX film_redirect_by_target\b/.test(d)),'the reader by target is index-served after 0042\n'+plan(after,READ_MODEL).join('\n'));
assert.ok(!plan(before,READ_MODEL).some(d=>/film_redirect_by_target/.test(d)));
{
 const b=copyOf(before,'retarget-b'),a=copyOf(after,'retarget-a');
 exec(b,RETARGET+';');exec(a,RETARGET+';');
 assert.deepEqual(strip(dump(a)),strip(dump(b)),'the merge retarget changes the same rows with or without the index');
 assert.ok(plan(after,RETARGET).some(d=>/film_redirect_by_target/.test(d)),'the merge retarget is index-served after 0042\n'+plan(after,RETARGET).join('\n'));
}
const BY_FROM='SELECT to_film_id FROM film_redirect WHERE from_id=\'film:l2:7\'';
assert.deepEqual(rows(after,BY_FROM),rows(before,BY_FROM));
assert.ok(plan(after,BY_FROM).every(d=>!/film_redirect_by_target/.test(d)),'the reader by from_id keeps the primary key');
// The foreign key and the uniqueness of the table are unchanged by the index.
assert.notEqual(run(copyOf(after,'fk'),"PRAGMA foreign_keys=ON;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:z:1','film:missing',"+q(AT)+");").status,0,'a redirect to a missing Film is still refused');
assert.notEqual(run(copyOf(after,'pk'),"PRAGMA foreign_keys=ON;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:l1:1','film:s:2',"+q(AT)+");").status,0,'a second redirect of the same Film is still refused');
assert.equal(run(copyOf(after,'ok'),"PRAGMA foreign_keys=ON;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:z:2','film:s:2',"+q(AT)+");").status,0,'a valid redirect is still accepted');
assert.equal(run(copyOf(after,'down'),'UPDATE schema_contract SET version=41 WHERE id=1;').status!==0,true,'the version never goes down');

console.log('migration 0042 film redirect target index: ok');
