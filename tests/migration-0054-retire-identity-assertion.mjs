// AIR-625: migration 0054 retires the three unused 0001 identity tables, on scratch sqlite databases built from the real migrations. Offline; synthetic ids only.
//  - the chain 53 -> 54 on a database whose three tables are empty (the production shape), and the three tables are gone while 0001 stays untouched;
//  - the refusals, each leaving the database byte-identical: wrong predecessor, a second apply, a row in any of the three tables, a view, a trigger or a foreign key of another table that references one of them;
//  - the new identity evidence ledger and every other table are unchanged.
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
{
 const f=migrated(53);assert.equal(version(f),53);
 for(const name of GONE)assert.ok(tables(f).includes(name),name+' exists at 53');
 const before=tables(f).filter(name=>!GONE.includes(name));
 exec(f,M54);assert.equal(version(f),54);
 assert.deepEqual(tables(f),before,'exactly the three tables are gone');
 assert.ok(tables(f).includes('film_identity_evidence'),'the ledger is untouched');
 assert.notEqual(run(f,M54).status,0,'a second apply is refused');assert.equal(version(f),54);
 assert.deepEqual(tables(migrated()),before,'the full chain equals the applied result');
}
// ---- 2. refusals leave the database unchanged ----
{
 const f=migrated(52);refused(f,'on version 52');
}
for(const name of GONE){
 const f=migrated(53);
 if(name==='identity_assertion')seedAssertion(f);
 else if(name==='identity_rule_version')seed(f,`INSERT INTO identity_rule_version (rule_id,version,predicates_json,created_at) VALUES ('r',1,'[]','${T}')`);
 else{seedAssertion(f);seed(f,`INSERT INTO identity_application (id,observation_key,programme_run_id,assertion_id,created_at) VALUES ('ap-1','a|1','run-a','as-1','${T}')`);}
 refused(f,'a row in '+name);assert.equal(version(f),53);
}
{
 const f=migrated(53);exec(f,'CREATE VIEW zz_view AS SELECT id FROM identity_assertion');refused(f,'a view over a retired table');
}
{
 const f=migrated(53);exec(f,"CREATE TRIGGER zz_trigger AFTER INSERT ON film BEGIN SELECT 1 FROM identity_rule_version; END");refused(f,'a trigger naming a retired table');
}
{
 const f=migrated(53);exec(f,'CREATE TABLE zz_ref (id TEXT PRIMARY KEY, a TEXT REFERENCES identity_assertion(id)) STRICT');refused(f,'a foreign key of another table');
}
{
 const f=migrated(53);exec(f,'DROP TABLE identity_application');refused(f,'a missing table (a partial apply)');
}
console.log('migration 0054 ok');
