// AIR-408: the persistent sqlite3 behind the test stand-ins must behave like the one-process-per-call it replaced: same results, same failures, no state
// that survives a call, a replaced file is a new database. These cases are the contract; the suite's speed rests on them.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {needsOneShot,quoteToJson,sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-sqlite-session-'));
const db=name=>path.join(root,name+'.sqlite');
const once=(file,input,json=false)=>spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input,encoding:'utf8'});
// 60 s, not 20: on CI this file starts with the five heaviest files of its shard (CPU-bound mutation runs and a workerd one) and a call starved for more than 20 s once (run 43193761580); the session itself is unchanged.
const session=(file,input,json=false)=>sqliteSync([...(json?['-json']:[]),'-bail',file],{input,timeoutMs:60000});
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

// 3b. Foreign-key enforcement is per connection: a call that turns it on must not leave it on for the next call, as a process per call never did.
{
 const make=name=>{const file=db(name);session(file,'PRAGMA foreign_keys=ON;\nCREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));INSERT INTO parent VALUES (1);');return file;};
 const orphan='INSERT INTO child VALUES (100, 99);';
 // Each case is checked against an independent fresh-process baseline on its own database copy: the same sequence of calls, the same status for each.
 const sequences=[
  ['PRAGMA ON then no PRAGMA','PRAGMA foreign_keys=ON;\nINSERT INTO child VALUES (1, 1);',orphan,'accepted: the second call did not ask for foreign keys'],
  ['no PRAGMA then PRAGMA ON',orphan,'PRAGMA foreign_keys=ON;\nINSERT INTO child VALUES (101, 99);','rejected: the second call asked for them'],
  ['PRAGMA ON twice','PRAGMA foreign_keys=ON;\n'+orphan.replace('100','102'),'PRAGMA foreign_keys=ON;\n'+orphan.replace('100','103'),'both rejected'],
  ['PRAGMA ON, no PRAGMA, PRAGMA ON','PRAGMA foreign_keys=ON;\nSELECT 1;',orphan.replace('100','104'),'accepted']
 ];
 for(const [label,first,second] of sequences){
  const viaSession=make('fk-s-'+label.replace(/\W+/g,'-')),viaProcess=make('fk-p-'+label.replace(/\W+/g,'-'));
  const a=[session(viaSession,first).status,session(viaSession,second).status],b=[once(viaProcess,first).status,once(viaProcess,second).status];
  assert.deepEqual(a,b,label+': the same status for each call as a fresh process gives');
  assert.equal(session(viaSession,'SELECT count(*) AS n FROM child;',true).stdout.trim(),once(viaProcess,'SELECT count(*) AS n FROM child;',true).stdout.trim(),label+': the same rows');
 }
 // The shape the review named, spelled out: an orphan child is accepted without the PRAGMA even right after a call that enabled it.
 const file=make('fk-named');session(file,'PRAGMA foreign_keys=ON;\nSELECT 1;');
 assert.equal(session(file,orphan).status,0,'an orphan insert after a PRAGMA-ON call is accepted when the call does not enable foreign keys');
 assert.notEqual(session(file,'PRAGMA foreign_keys=ON;\nINSERT INTO child VALUES (200, 99);').status,0,'and rejected when it does');
 // A savepoint that is not released would stay open in a shared connection: it runs in a process of its own.
 assert.equal(needsOneShot(['-bail',file],'SAVEPOINT a;INSERT INTO parent VALUES (7);'),true);
 assert.equal(needsOneShot(['-bail',file],'SAVEPOINT a;INSERT INTO parent VALUES (8);RELEASE a;'),false);
 // The per-connection counters of a fresh process start at zero, so a script that reads them runs in one.
 for(const script of ['SELECT last_insert_rowid();','SELECT changes();','SELECT total_changes();'])assert.equal(needsOneShot(['-bail',file],script),true,script);
 assert.equal(session(file,'INSERT INTO parent VALUES (50);').status,0);assert.equal(session(file,'SELECT last_insert_rowid() AS id;',true).stdout.trim(),'[{"id":0}]','a later call does not see the rowid of an earlier one');
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

// AIR-418: a `-json` call may be answered in quote mode and converted (the CLI's JSON writer is slow on large values). The conversion must be the JSON text the
// CLI prints: same names (a duplicate name included), NULL, the empty string, numbers digit for digit (large integers, reals, the infinities), text with quotes,
// backslashes, commas, line breaks, tabs and non-ASCII, text that looks like a number or like NULL, and nothing at all for no row.
{
 const TYPED="SELECT 1 AS i, -2.5 AS r, 1e300 AS big, 0.1+0.2 AS f, 9007199254740993 AS huge, NULL AS n, '' AS e, 'it''s \"q\" \\ back, with a comma' AS t, 'line1'||char(10)||'line2'||char(13)||char(9)||'x' AS nl, '12' AS numtext, 1.0 AS one, 'ünï☃' AS u, 'NULL' AS nulltext, 'X''00''' AS blobtext, 1e999 AS inf, -1e999 AS ninf, 'a' AS \"we,ird'col\", 2 AS i UNION ALL SELECT 2,3.25,-1e-300,0.5,-9007199254740993,'n','e','''','','0',2.0,'','null','',0,0,'',3;";
 const viaQuote=spawnSync('sqlite3',['-quote','-header','-bail',':memory:'],{input:TYPED,encoding:'utf8'}),viaJson=spawnSync('sqlite3',['-json','-bail',':memory:'],{input:TYPED,encoding:'utf8'});
 assert.equal(viaQuote.status,0,viaQuote.stderr);assert.equal(viaJson.status,0,viaJson.stderr);
 assert.equal(quoteToJson(viaQuote.stdout),viaJson.stdout,'the converted quote output is the JSON text of the CLI, byte for byte');
 assert.equal(quoteToJson(spawnSync('sqlite3',['-quote','-header',':memory:'],{input:'SELECT 1 AS a WHERE 0;',encoding:'utf8'}).stdout),'','no row is no output, as in JSON mode');
 assert.equal(quoteToJson(''),'');
 assert.throws(()=>quoteToJson("'a'\n'unterminated"),/unterminated/);
 // The adaptive path end to end: a statement shape that returns large values is answered in quote mode from its second call on, with the same parsed rows; a
 // shape with many small rows stays in JSON mode; both agree with a process per call at every call.
 const file=db('large-values');
 const chunk=index=>JSON.stringify({index,text:('it\'s "chunk" '+index+' \\ line\n').repeat(4000)});
 assert.equal(session(file,'CREATE TABLE doc (seq INTEGER PRIMARY KEY, chunk_text TEXT, n INTEGER);'+[0,1,2].map(index=>"INSERT INTO doc VALUES ("+index+",'"+chunk(index).replaceAll("'","''")+"',"+index+");").join('')).status,0);
 const expected=JSON.parse(once(file,'SELECT chunk_text AS chunk, n FROM doc ORDER BY seq;',true).stdout);
 assert.ok(expected[0].chunk.length>90000);
 for(let call=0;call<4;call++){
  const rows=JSON.parse(session(file,'SELECT chunk_text AS chunk, n FROM doc ORDER BY seq;',true).stdout);
  assert.deepEqual(rows,expected,'call '+call+' of a large-value shape');
  // a small answer in between, on the same connection, is unaffected by the mode the large one used
  assert.equal(session(file,'SELECT n FROM doc WHERE seq=1;',true).stdout.trim(),'[{"n":1}]');
  assert.equal(session(file,'SELECT n FROM doc WHERE seq=2;').stdout.trim(),'2','a text-mode call on the same file keeps its own connection and format');
 }
 // the same shape answering small values again (the rows were replaced) is still right, whatever mode it runs in
 assert.equal(session(file,"UPDATE doc SET chunk_text='s'||seq;").status,0);
 for(let call=0;call<3;call++)same(file,'SELECT chunk_text AS chunk, n FROM doc ORDER BY seq;',true);
 // one-shot scripts (here: a PRAGMA) take the same conversion
 const shot=()=>JSON.parse(session(file,"PRAGMA cache_size=100; SELECT printf('%.*c',120000,'z') AS chunk;",true).stdout);
 assert.equal(shot()[0].chunk.length,120000);assert.equal(shot()[0].chunk.length,120000);
}

console.log('sqlite session: same results and failures as a process per call, no state between calls, replaced files, shared files, large answers, many databases and the quote-mode answer of large values passed');
