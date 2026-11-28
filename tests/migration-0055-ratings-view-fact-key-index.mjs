// AIR-653: migration 0055 (one additive, non-unique lookup index ratings_view_fact_key on ratings_view(fact_key)). Offline only: scratch sqlite databases built from the real
// chain; nothing is applied anywhere.
//  - the chain 53 -> 54 -> 55, and the refusals (wrong predecessor, a missing singleton, a second apply, a missing guarded object, a same-named object of any shape, an explicit
//    index already on the projection, an unretired 0001 identity table);
//  - 0055 changes no data: a full dump of a populated synthetic projection before and after differs only by the index and the schema_contract row;
//  - the exact OR predicate of the Letterboxd claim planner: before, ratings_view is SCANned; after, every term is index-served (MULTI-INDEX OR) and the statement returns the same
//    rows, including a rival alias on the same fact key (the third-alias conflict), an alias that points elsewhere and a lid with no row;
//  - the other readers of the projection keep the primary key, the index is non-unique (many aliases per fact key stay allowed) and the schema version never goes down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const M55=fs.readFileSync('migrations/0055_ratings_view_fact_key_index.sql','utf8');
const INDEX='ratings_view_fact_key';
const PLANNER_SQL='SELECT alias_id,fact_key FROM ratings_view WHERE alias_id=? OR alias_id=? OR fact_key=?';
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
const bind=(sql,values)=>{let i=0;return sql.replace(/\?/g,()=>q(values[i++]));};

// ---- 1. the chain and the refusals ---------------------------------------------------------------------------------------------------------------------
const v53=migrated(53),v54=migrated(54);
assert.equal(version(v53),53);assert.equal(version(v54),54);
assert.ok(!objects(v54).includes('index:'+INDEX),'version 54 has no such index');
const noDowngrade=rows(v54,"SELECT sql FROM sqlite_master WHERE name='schema_contract_no_downgrade'")[0].sql;
const refuse=(file,name)=>{
 const named=/same-named|pre-existing index of the same name|second apply/.test(name);// those cases create the name themselves
 const before=dump(file),result=run(file,M55);
 assert.notEqual(result.status,0,name+': the file aborts');
 assert.deepEqual(dump(file),before,name+': the whole state is unchanged');
 if(!named)assert.ok(!objects(file).includes('index:'+INDEX),name+': no index installed');
};
refuse(copyOf(v53,'on53'),'on version 53 (0054 is not applied)');
for(const [name,statement] of [
 ['an absent schema_contract row','DELETE FROM schema_contract;'],
 ['a missing no-downgrade trigger','DROP TRIGGER schema_contract_no_downgrade;'],
 ['a missing 0040 retirement-ledger index','DROP INDEX tmdb_retirement_decision_movie;'],
 ['a missing projection table','PRAGMA foreign_keys=OFF;ALTER TABLE ratings_view RENAME TO ratings_view_gone;'],
 ['an unretired 0001 identity table','CREATE TABLE identity_assertion (x INTEGER);'],
 ['an explicit index already on the projection','CREATE INDEX other_view_index ON ratings_view (updated_at);'],
 ['every object present at version 53','DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=53 WHERE id=1;'+noDowngrade+';'],
 ['every object present at version 56','UPDATE schema_contract SET version=56 WHERE id=1;'],
 ['a pre-existing index of the same name','CREATE INDEX '+INDEX+' ON ratings_view (fact_key);'],
 ['a same-named index of another shape','CREATE INDEX '+INDEX+' ON ratings_view (updated_at);'],
 ['a same-named table','CREATE TABLE '+INDEX+' (x INTEGER);'],
 ['a same-named view','CREATE VIEW '+INDEX+' AS SELECT 1 AS x;'],
]){const file=copyOf(v54,'bad');exec(file,statement);refuse(file,name);}

// ---- 2. a populated synthetic projection, then the real migration -------------------------------------------------------------------------------------
// 3000 facts with a tmdb alias each, 1500 of them also with a lid alias, plus a rival alias on one fact (the third-alias conflict). Synthetic values only.
const AT='2026-11-28T00:00:00.000Z';
exec(v54,`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<3000)
 INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) SELECT 'tmdb_'||i,'tmdb-'||i,NULL,NULL,0,0,'${AT}' FROM n;
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500)
 INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) SELECT 'lid'||i,'tmdb-'||i,1,3.5,0,1,'${AT}' FROM n;
 INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('rival7','tmdb-7',NULL,NULL,0,0,'${AT}');
 INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('lid2000','tmdb-9',NULL,NULL,0,0,'${AT}');`);
const ROWS=Number(rows(v54,'SELECT COUNT(*) AS n FROM ratings_view')[0].n);
assert.equal(ROWS,4502);

const before=copyOf(v54,'before'),after=copyOf(v54,'after');
const dumpBefore=dump(before);
exec(after,M55);
assert.equal(version(after),55);
assert.deepEqual(objects(after),[...objects(before),'index:'+INDEX].sort(),'exactly the one index is new');
refuse(copyOf(after,'again'),'a second apply on version 55');
assert.equal(version(migrated(54)),54,'the chain through 0054 ends at version 54');
assert.equal(version(migrated()),55,'the full chain ends at version 55 (0055, AIR-653)');
assert.ok(objects(migrated()).includes('index:'+INDEX),'the full chain carries the index');
const shape=rows(after,"SELECT name,\"unique\" AS uniq,partial FROM pragma_index_list('ratings_view')").find(item=>item.name===INDEX);
assert.equal(shape.uniq,0,'non-unique');assert.equal(shape.partial,0,'not partial');
assert.deepEqual(rows(after,"SELECT name FROM pragma_index_info('"+INDEX+"') ORDER BY seqno").map(item=>item.name),['fact_key']);

const dumpAfter=dump(after);
const strip=lines=>lines.filter(line=>!line.startsWith('INSERT INTO schema_contract')&&!line.includes(INDEX));
assert.deepEqual(strip(dumpAfter),strip(dumpBefore),'every projection row, trigger, marker and authority row is unchanged');
assert.equal(dumpAfter.filter(line=>line.startsWith('INSERT INTO schema_contract')).length,1,'still one schema_contract row');
assert.match(dumpAfter.find(line=>line.startsWith('INSERT INTO schema_contract')),/\b55\b/);
assert.equal(Number(rows(after,'SELECT COUNT(*) AS n FROM ratings_view')[0].n),ROWS,'no projection row was added or removed');

// ---- 3. the exact planner predicate ---------------------------------------------------------------------------------------------------------------------
const cases={
 ordinary:['lid5','tmdb_5','tmdb-5'],
 thirdAliasConflict:['lid7','tmdb_7','tmdb-7'],// 'rival7' shares the fact key: ratings_alias_ambiguous
 aliasPointsElsewhere:['lid2000','tmdb_9','tmdb-9'],// the lid alias names another fact than the one the link names
 noRow:['lid9999','tmdb_9999','tmdb-9999'],
};
for(const [name,values] of Object.entries(cases)){
 const text=bind(PLANNER_SQL,values),b=plan(before,text),a=plan(after,text);
 assert.ok(b.some(d=>/^SCAN ratings_view\b/.test(d)),name+': before 0055 the projection is scanned\n'+b.join('\n'));
 assert.ok(a.some(d=>/^MULTI-INDEX OR/.test(d))&&a.some(d=>/^SEARCH ratings_view USING INDEX ratings_view_fact_key \(fact_key=\?\)/.test(d)),name+': after 0055 the fact_key term is an index SEARCH\n'+a.join('\n'));
 assert.ok(!a.some(d=>/^SCAN ratings_view\b/.test(d)),name+': after 0055 no scan of the projection\n'+a.join('\n'));
 const order=file=>rows(file,text+' ORDER BY alias_id').map(row=>row.alias_id+'|'+row.fact_key);
 assert.deepEqual(order(after),order(before),name+': the statement returns the same rows');
}
assert.equal(rows(after,bind(PLANNER_SQL,cases.thirdAliasConflict)).length,3,'lid, tmdb alias and the rival alias are all returned (conflict is still visible)');
assert.equal(rows(after,bind(PLANNER_SQL,cases.noRow)).length,0);

// ---- 4. the other readers of the projection, the uniqueness and the version -------------------------------------------------------------------------
const BY_ALIAS="SELECT alias_id FROM ratings_view WHERE alias_id IN ('lid1','tmdb_2','nope')";
assert.deepEqual(rows(after,BY_ALIAS),rows(before,BY_ALIAS));
assert.ok(plan(after,BY_ALIAS).every(d=>!/ratings_view_fact_key/.test(d)),'the readers by alias keep the primary key');
assert.notEqual(run(copyOf(after,'pk'),"INSERT INTO ratings_view (alias_id,fact_key,rating_known,updated_at) VALUES ('lid1','tmdb-1',0,"+q(AT)+");").status,0,'a second row of the same alias is still refused');
assert.equal(run(copyOf(after,'many'),"INSERT INTO ratings_view (alias_id,fact_key,rating_known,updated_at) VALUES ('another','tmdb-1',0,"+q(AT)+");").status,0,'many aliases per fact key are still accepted (non-unique)');
assert.equal(run(copyOf(after,'down'),'UPDATE schema_contract SET version=54 WHERE id=1;').status!==0,true,'the version never goes down');

console.log('migration 0055 ratings_view fact_key index: ok');
