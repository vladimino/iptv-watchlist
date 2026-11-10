// AIR-408: the persistent sqlite3 behind the test stand-ins must behave like the one-process-per-call it replaced: same results, same failures, no state
// that survives a call, a replaced file is a new database. These cases are the contract; the suite's speed rests on them.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {needsOneShot,sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-sqlite-session-'));
const db=name=>path.join(root,name+'.sqlite');
const once=(file,input,json=false)=>spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input,encoding:'utf8'});
const session=(file,input,json=false)=>sqliteSync([...(json?['-json']:[]),'-bail',file],{input,timeoutMs:20000});
const same=(file,input,json=false)=>{
 const a=once(file,input,json),b=session(file,input,json);
 assert.equal(b.status,a.status,'same status: '+input.slice(0,60));assert.equal(b.stdout,a.stdout,'same stdout: '+input.slice(0,60));
 // The CLI counts input lines over the whole life of a connection, so a message may say "near line 24" where a fresh process says "near line 2": the number is not part of the contract.
 const text=value=>value.trim().replace(/near line \d+/g,'near line N');
 assert.equal(text(b.stderr),text(a.stderr),'same stderr: '+input.slice(0,60));
 return b;
};

// 1. Writes and reads give what a process of its own gives, text and JSON, on one database and on a second one.
{
 const file=db('basic');
 session(file,'PRAGMA foreign_keys=ON;\nCREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));INSERT INTO parent VALUES (1);');
 same(file,'SELECT * FROM parent;',true);
 same(file,'PRAGMA foreign_keys=ON;\nSELECT 1 AS one, \'a\' AS text, NULL AS nothing;',true);
 same(file,'SELECT count(*) FROM parent;');
 assert.equal(session(file,'SELECT 1',true).stdout.trim(),'[{"1":1}]','a statement without its final semicolon ends at the end of the script, as before');
 same(file,'SELECT 2 -- comment at the end',true);
 same(file,'SELECT 3 AS three /* block */',true);
 const other=db('other');session(other,'CREATE TABLE t(a);INSERT INTO t VALUES (7);');
 assert.equal(session(other,'SELECT a FROM t;',true).stdout.trim(),'[{"a":7}]');assert.equal(session(file,'SELECT id FROM parent;',true).stdout.trim(),'[{"id":1}]','databases do not mix');
}

// 2. A failing script reports the failure of the first bad statement and nothing after it ran; the next call has a fresh connection.
{
 const file=db('failure');
 session(file,'CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT NOT NULL);INSERT INTO t VALUES (1,\'x\');');
 const bad=session(file,'INSERT INTO t VALUES (2,\'y\');\nINSERT INTO t VALUES (1,\'dup\');\nINSERT INTO t VALUES (3,\'z\');');
 const reference=once(file.replace('failure','failure-ref'),'CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT NOT NULL);INSERT INTO t VALUES (1,\'x\');INSERT INTO t VALUES (2,\'y\');\nINSERT INTO t VALUES (1,\'dup\');\nINSERT INTO t VALUES (3,\'z\');');
 assert.notEqual(bad.status,0);assert.match(bad.stderr,/UNIQUE constraint failed/);assert.equal(reference.status,bad.status);
 assert.equal(session(file,'SELECT a FROM t ORDER BY a;',true).stdout.trim().replace(/\s+/g,''),'[{"a":1},{"a":2}]','what ran before the failure stays, nothing after it ran');
 // A failed transaction leaves no open transaction behind: the next call can write.
 const aborted=session(file,'BEGIN;INSERT INTO t VALUES (10,\'in\');INSERT INTO t VALUES (1,\'dup\');COMMIT;');assert.notEqual(aborted.status,0);
 assert.equal(session(file,'SELECT count(*) AS n FROM t WHERE a=10;',true).stdout.trim(),'[{"n":0}]','the whole transaction was rolled back');
 assert.equal(session(file,'INSERT INTO t VALUES (11,\'after\');').status,0,'the database is not left locked');
 const failure=session(file,'SELECT * FROM missing_table;');assert.notEqual(failure.status,0);assert.match(failure.stderr,/no such table/);
 assert.equal(session(file,'SELECT 1;').status,0,'a failure does not break the following call');
}

// 3. A script that could leave state in a shared connection runs in a process of its own, so nothing leaks between calls.
{
 const file=db('oneshot');
 for(const script of ['PRAGMA foreign_keys=OFF;SELECT 1;','PRAGMA user_version=3;','ATTACH DATABASE \':memory:\' AS other;','CREATE TEMP TABLE scratch(a);','CREATE TEMPORARY TABLE scratch(a);','VACUUM;','.mode json\nSELECT 1;','BEGIN;SELECT 1;'])
  assert.equal(needsOneShot(['-bail',file],script),true,'one-shot: '+script);
 for(const script of ['PRAGMA foreign_keys=ON;\nSELECT 1;','PRAGMA foreign_keys = ON ;SELECT 1;','BEGIN;SELECT 1;COMMIT;','BEGIN;SELECT 1;ROLLBACK;','SELECT 1'])
  assert.equal(needsOneShot(['-bail',file],script),false,'shared: '+script);
 assert.equal(needsOneShot(['-bail',':memory:'],'SELECT 1;'),true,'an in-memory database is a database of its own per call');
 assert.equal(needsOneShot(['-json',file,'SELECT 1'],''),true,'arguments the session does not model go to a process of their own');
 // The one-shot calls keep their old effect: a temp table does not exist in the next call.
 assert.equal(session(file,'CREATE TEMP TABLE scratch(a);INSERT INTO scratch VALUES (1);').status,0);
 const gone=session(file,'SELECT * FROM scratch;');assert.notEqual(gone.status,0);assert.match(gone.stderr,/no such table/,'no state left by an earlier call');
 // An unfinished transaction is dropped at the end of its process, as before, so it does not hold a lock either.
 assert.equal(session(file,'CREATE TABLE t(a);BEGIN;INSERT INTO t VALUES (1);').status,0);
 assert.equal(session(file,'SELECT count(*) AS n FROM t;',true).stdout.trim(),'[{"n":0}]','the unfinished transaction was rolled back');
 // Foreign keys are enforced on every call that asks for them.
 session(file,'PRAGMA foreign_keys=ON;\nCREATE TABLE p(id INTEGER PRIMARY KEY);CREATE TABLE c(pid INTEGER REFERENCES p(id));');
 const fk=session(file,'PRAGMA foreign_keys=ON;\nINSERT INTO c VALUES (99);');assert.notEqual(fk.status,0);assert.match(fk.stderr,/FOREIGN KEY constraint failed/);
}

// 4. A database file that is deleted or replaced is a new database for the next call, not the old one kept open.
{
 const file=db('replaced');
 session(file,'CREATE TABLE t(a);INSERT INTO t VALUES (1);');assert.equal(session(file,'SELECT count(*) AS n FROM t;',true).stdout.trim(),'[{"n":1}]');
 fs.rmSync(file);
 const fresh=session(file,'SELECT count(*) AS n FROM sqlite_master;',true);assert.equal(fresh.status,0);assert.equal(fresh.stdout.trim(),'[{"n":0}]','the deleted database is gone, an empty one is made');
 session(file,'CREATE TABLE u(b);');fs.renameSync(file,file+'.old');
 const replacement=db('replacement');session(replacement,'CREATE TABLE only_here(x);');fs.renameSync(replacement,file);
 assert.equal(session(file,'SELECT name FROM sqlite_master;',true).stdout.trim(),'[{"name":"only_here"}]','a replaced file is read as the new file');
}

// 5. A change made by another process between two calls is seen by the second call, and the other process is not locked out.
{
 const file=db('shared');
 session(file,'CREATE TABLE t(a);INSERT INTO t VALUES (1);');
 assert.equal(session(file,'SELECT count(*) AS n FROM t;',true).stdout.trim(),'[{"n":1}]');
 assert.equal(once(file,'INSERT INTO t VALUES (2);').status,0,'a process of its own can write while the session is open');
 assert.equal(session(file,'SELECT count(*) AS n FROM t;',true).stdout.trim(),'[{"n":2}]','and the session sees it');
}

// 6. Large answers and scripts pass whole, and many databases at once do not exhaust the processes.
{
 const file=db('large');
 session(file,'CREATE TABLE t(a INTEGER, b TEXT);');
 const rows=Array.from({length:20000},(_,index)=>`(${index},'${'x'.repeat(100)}')`);
 assert.equal(session(file,'INSERT INTO t VALUES '+rows.join(',')+';').status,0,'a script of about 2 MB');
 const answer=session(file,'SELECT a,b FROM t ORDER BY a;',true);assert.equal(answer.status,0);
 const parsed=JSON.parse(answer.stdout);assert.equal(parsed.length,20000);assert.equal(parsed[19999].a,19999,'an answer of about 2.5 MB arrives whole');
 for(let index=0;index<30;index++){const file2=db('many-'+index);session(file2,'CREATE TABLE t(a);INSERT INTO t VALUES ('+index+');');}
 for(let index=0;index<30;index++)assert.equal(session(db('many-'+index),'SELECT a FROM t;',true).stdout.trim(),'[{"a":'+index+'}]','database '+index);
}

console.log('sqlite session: same results and failures as a process per call, no state between calls, replaced files, shared files, large answers and many databases passed');
