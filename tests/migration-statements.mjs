// The shared migration splitter (scripts/published-epg-production.mjs `migrationStatements`): one entry per statement, as D1's REST batch needs it.
// Regression for migration 0030, whose trigger body contains CASE ... END: the END of a CASE is not the END of the trigger. Offline only (sqlite CLI).
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {migrationStatements} from '../scripts/published-epg-production.mjs';
import {migrationSql} from '../scripts/epg-checkpoint-production.mjs';
import {sqliteSync} from './sqlite-session.mjs';

// ---- lexical cases -------------------------------------------------------------------------------------------------------
assert.deepEqual(migrationStatements('SELECT 1; SELECT 2;'),['SELECT 1','SELECT 2']);
assert.deepEqual(migrationStatements('SELECT 1'),['SELECT 1'],'a last statement without a semicolon is kept');
assert.deepEqual(migrationStatements("INSERT INTO t VALUES ('a;b'); SELECT 2;"),["INSERT INTO t VALUES ('a;b')",'SELECT 2'],'a semicolon in a string does not end a statement');
assert.deepEqual(migrationStatements("INSERT INTO t VALUES ('it''s; END'); SELECT 2;"),["INSERT INTO t VALUES ('it''s; END')",'SELECT 2'],"'' escapes and keywords in strings");
assert.deepEqual(migrationStatements("INSERT INTO t VALUES ('BEGIN'); SELECT 2;"),["INSERT INTO t VALUES ('BEGIN')",'SELECT 2'],'BEGIN inside a string opens nothing');
assert.deepEqual(migrationStatements('-- header; BEGIN\nSELECT 1; -- tail; END\nSELECT 2;'),['SELECT 1','SELECT 2'],'line comments are dropped and never searched');
assert.deepEqual(migrationStatements('SELECT 1 /* a; BEGIN */ ; SELECT 2;'),['SELECT 1','SELECT 2'],'block comments are dropped and never searched');
assert.deepEqual(migrationStatements('SELECT 1, -- note; END\n 2; SELECT 3;'),['SELECT 1, \n 2','SELECT 3'].map(s=>s),'an inline comment inside a statement is dropped');
assert.deepEqual(migrationStatements('SELECT "end" FROM t; SELECT 2;'),['SELECT "end" FROM t','SELECT 2'],'a double-quoted identifier named end is not a keyword');
assert.deepEqual(migrationStatements('SELECT end_ms, begin_at, case_id FROM t; SELECT 2;'),['SELECT end_ms, begin_at, case_id FROM t','SELECT 2'],'identifiers that contain keywords are not keywords');
assert.deepEqual(migrationStatements('UPDATE t SET a = CASE WHEN b THEN 1 ELSE 2 END; SELECT 2;'),['UPDATE t SET a = CASE WHEN b THEN 1 ELSE 2 END','SELECT 2'],'a CASE outside a trigger is balanced');
const trigger="CREATE TRIGGER x BEFORE UPDATE ON t FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'a') WHERE (CASE a WHEN 1 THEN 1 ELSE 2 END) > (CASE b WHEN 1 THEN 1 WHEN 2 THEN (CASE c WHEN 1 THEN 1 ELSE 2 END) ELSE 3 END) OR d <> 1; SELECT 9; END";
assert.deepEqual(migrationStatements(trigger+'; SELECT 2;'),[trigger,'SELECT 2'],'CASE ... END (nested too) inside a trigger body does not end the trigger');
assert.deepEqual(migrationStatements("CREATE TRIGGER y AFTER INSERT ON t BEGIN SELECT RAISE(ABORT,'x;y'); END; CREATE TRIGGER z AFTER INSERT ON t BEGIN SELECT 1; END;").length,2,'two triggers in a row');

// ---- migration 0030 ---------------------------------------------------------------------------------------------------
const text30=fs.readFileSync('migrations/0030_epg_checkpoint_authority.sql','utf8');
const statements30=migrationStatements(text30);
assert.equal(statements30.length,15,'0030 has 15 statements (the CASE END used to cut a trigger into 16 fragments)');
assert.equal(statements30.some(statement=>/^END\b/i.test(statement)),false,'no statement is a lone END');
const run_order=statements30.filter(statement=>/CREATE TRIGGER epg_checkpoint_run_order/.test(statement));
assert.equal(run_order.length,1);assert.match(run_order[0],/END$/);assert.match(run_order[0],/CASE OLD\.stage/);
assert.deepEqual(migrationSql(),statements30,'the production operator sends exactly these statements');

// ---- every migration, statement by statement ----------------------------------------------------------------------------
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-splitter-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const run=(file,input)=>{const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input,encoding:'utf8',maxBuffer:1<<26});if(result.status!==0)throw new Error(result.stderr);};
const schema=file=>{const result=sqliteSync(['-json','-bail',file],{input:"SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name;",encoding:'utf8',maxBuffer:1<<26});if(result.status!==0)throw new Error(result.stderr);const rows=result.stdout.trim()?JSON.parse(result.stdout):[];return rows.map(row=>row.type+' '+row.name+' '+String(row.sql).replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim());};
const whole=path.join(root,'whole.sqlite'),parts=path.join(root,'parts.sqlite');
let statementCount=0;
for(const name of names){
 const file=fs.readFileSync('migrations/'+name,'utf8');
 run(whole,file);
 // Each statement is executed on its own, in its own process, exactly as one batch entry of the REST API is: a fragment that is not a complete statement fails here.
 for(const statement of migrationStatements(file)){run(parts,statement+';');statementCount++;}
}
assert.ok(statementCount>300,'the whole chain was executed statement by statement ('+statementCount+')');
assert.deepEqual(schema(parts),schema(whole),'the schema built statement by statement equals the schema built from the whole files');
assert.equal(JSON.parse(sqliteSync(['-json',parts],{input:'SELECT version FROM schema_contract WHERE id=1;',encoding:'utf8'}).stdout)[0].version,30);
console.log('migration statements: '+statementCount+' statements of '+names.length+' migrations execute one by one and build the same schema');
