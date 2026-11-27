// AIR-625: migration 0054 retires the three unused 0001 identity tables, on scratch sqlite databases built from the real migrations. Offline; synthetic ids only.
//  - the chain 53 -> 54 on a database whose three tables are empty (the production shape), and the three tables are gone while 0001 stays untouched;
//  - the refusals, each leaving the database byte-identical: wrong predecessor, a second apply, a row in any of the three tables, a view, a trigger or a foreign key of another table that references one of them;
//  - the new identity evidence ledger, representative existing data and every other schema object are unchanged (a dump comparison, not just the presence of the ledger).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const M54=fs.readFileSync('migrations/0054_retire_legacy_identity_assertion_tables.sql','utf8');
const GONE=['identity_assertion','identity_rule_version','identity_application'];
const run=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<28});
const exec=(file,text)=>{const r=run(file,text);if(r.status!==0)throw new Error(r.stderr);};
const seed=(file,text)=>{const r=sqliteSync(['-bail',file],{input:text,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=String(r.stdout).trim();return o?JSON.parse(o):[];};
const version=file=>Number(rows(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const dump=file=>{const r=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<30});if(r.status!==0)throw new Error(r.stderr);return String(r.stdout).split('\n');};
const tables=file=>rows(file,"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row=>row.name);
const T='2026-11-27T10:00:00.000Z';
const refused=(file,why)=>{const before=dump(file);assert.notEqual(run(file,M54).status,0,why);assert.deepEqual(dump(file),before,why+': nothing changed');};
// The parents are not needed: the foreign keys are switched off for the seed only (the rows are synthetic, the check is on the retirement, not on the 0001 parents).
const seedAssertion=file=>seed(file,`INSERT INTO identity_assertion (id,observation_key,programme_run_id,authority,created_at) VALUES ('as-1','a|1','run-a','owner','${T}')`);

// ---- 1. the chain and the result ----
// Everything outside the three tables: every schema object (type, name, table, SQL text) and every row of every other table (schema_contract excluded: its version row is the one intended change).
const NOT_LEGACY="tbl_name NOT IN ('identity_assertion','identity_rule_version','identity_application') AND name NOT LIKE 'sqlite_%'";
const rest=file=>{
 const objects=rows(file,`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE ${NOT_LEGACY} ORDER BY type,name`);
 const data=rows(file,`SELECT name FROM sqlite_master WHERE type='table' AND ${NOT_LEGACY} AND name<>'schema_contract' ORDER BY name`).map(t=>[t.name,rows(file,'SELECT * FROM "'+t.name+'"')]);
 return {objects,data};
};
{
 const f=migrated(53);assert.equal(version(f),53);
 for(const name of GONE)assert.ok(tables(f).includes(name),name+' exists at 53');
 // representative existing, non-legacy data: a Film row and a ledger-adjacent row that must survive untouched
 seed(f,`INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:zz-keep',1,'Keep','${T}')`);
 const before=tables(f).filter(name=>!GONE.includes(name));
 const kept=rest(f);
 assert.ok(JSON.stringify(kept.data).includes('film:zz-keep'),'the representative row is in the snapshot');assert.ok(kept.objects.length>100,'the snapshot is not trivially empty');
 exec(f,M54);assert.equal(version(f),54);
 assert.deepEqual(tables(f),before,'exactly the three tables are gone');
 assert.deepEqual(rest(f),kept,'every other schema object and row is identical (only the three tables and the schema_contract version row differ)');
 assert.deepEqual(rows(f,'SELECT id FROM film'),[{id:'film:zz-keep'}],'the representative Film survives');
 assert.ok(tables(f).includes('film_identity_evidence'),'the ledger is untouched');
 assert.notEqual(run(f,M54).status,0,'a second apply is refused');assert.equal(version(f),54);
 assert.deepEqual(tables(migrated()),before,'the full chain equals the applied result');
}
// ---- 2. refusals leave the database unchanged ----
// The parents are not needed for a row: each legacy table is seeded ALONE (foreign keys off for the seed only), so each emptiness guard is proved independently.
const SEED={
 identity_assertion:`INSERT INTO identity_assertion (id,observation_key,programme_run_id,authority,created_at) VALUES ('as-1','a|1','run-a','owner','${T}')`,
 identity_rule_version:`INSERT INTO identity_rule_version (rule_id,version,predicates_json,created_at) VALUES ('r',1,'[]','${T}')`,
 identity_application:`INSERT INTO identity_application (id,observation_key,programme_run_id,created_at) VALUES ('ap-1','a|1','run-a','${T}')`,
};
{
 const f=migrated(52);refused(f,'on version 52');
}
for(const name of GONE){
 const f=migrated(53);seed(f,SEED[name]);
 for(const other of GONE.filter(n=>n!==name))assert.equal(Number(rows(f,'SELECT COUNT(*) AS n FROM '+other)[0].n),0,other+' stays empty in the '+name+' case');
 refused(f,'a row in '+name+' alone');assert.equal(version(f),53);
}
const DEPENDENTS={
 'a view':'CREATE VIEW zz_view AS SELECT id FROM identity_assertion',
 'a mixed-case view':'CREATE VIEW zz_view AS SELECT * FROM IDENTITY_ASSERTION',
 'a trigger on another table naming a table':"CREATE TRIGGER zz_trigger AFTER INSERT ON film BEGIN SELECT 1 FROM identity_rule_version; END",
 'a mixed-case trigger on another table':"CREATE TRIGGER zz_trigger AFTER INSERT ON film BEGIN SELECT 1 FROM Identity_Rule_Version; END",
 'a foreign key of another table':'CREATE TABLE zz_ref (id TEXT PRIMARY KEY, a TEXT REFERENCES identity_assertion(id)) STRICT',
 'a quoted mixed-case foreign key':'CREATE TABLE zz_ref (id TEXT PRIMARY KEY, a TEXT REFERENCES "Identity_Assertion"(id)) STRICT',
 'a bracketed upper-case reference':'CREATE VIEW zz_view AS SELECT * FROM [IDENTITY_APPLICATION]',
 'an unexpected explicit index on a retired table':'CREATE INDEX zz_index ON identity_assertion (authority)',
 'an unexpected trigger attached to a retired table':"CREATE TRIGGER zz_trigger AFTER INSERT ON identity_application BEGIN SELECT 1; END",
 'an unexpected mixed-case index on a retired table':'CREATE INDEX zz_index ON "Identity_Rule_Version" (confidence)',
};
for(const [why,statement] of Object.entries(DEPENDENTS)){
 const f=migrated(53);exec(f,statement);refused(f,why);assert.equal(version(f),53,why+': version unchanged');
}
{
 const f=migrated(53);exec(f,'DROP TABLE identity_application');refused(f,'a missing table (a partial apply)');
}
console.log('migration 0054 ok');
