// AIR-408: a synchronous `sqlite3` for tests that keeps one CLI process per database file instead of starting one per statement.
//
// The suite's D1 stand-in and several fixtures ran `spawnSync('sqlite3', ...)` for every statement: thousands of process starts per file, most of the
// wall time of the heaviest files. `sqliteSync(args, {input})` has the shape of that call (`status`, `stdout`, `stderr`) but sends the script to a long-lived
// `sqlite3` owned by a worker thread; the caller still blocks until the answer is in (`Atomics.wait` + `receiveMessageOnPort`), so no test became asynchronous.
// Works on Node 20 (CI) as well as later versions; it uses no native module and no `node:sqlite`.
//
// Semantics are kept by construction, not by hope:
//  - The same real SQLite engine and the same `-bail` rule: a failing script makes the CLI exit, the call reports its status and stderr exactly as before, and
//    the next call opens a fresh connection (an unfinished transaction is rolled back by the exit, as it was).
//  - Foreign-key enforcement is per connection and a new process starts with it off, so every call on the shared connection starts with `PRAGMA foreign_keys=OFF` and the script's own `PRAGMA foreign_keys=ON` applies to that call only.
//  - A script that could leave state behind in a shared connection (any PRAGMA other than foreign_keys=ON, ATTACH/DETACH, TEMP objects, VACUUM, dot-commands,
//    `BEGIN` without a `COMMIT`/`END`/`ROLLBACK`, an in-memory or unnamed database) runs in a one-shot process, as before.
//  - A script whose last statement has no `;` (the end of stdin ended it before) is closed with one before the marker, so the marker is never read as part of it.
//  - A database file that was deleted or replaced gets a new connection (checked by device and inode before every call).
//  - Calls on one database are strictly sequential (the caller is blocked), so there is no interleaving to reason about.
//  - AIR-418: the CLI's own JSON writer costs seconds per megabyte of text (it emits a large value character by character: 1.7 MB took 5.9 s, against 0.006 s
//    in quote mode), and quote mode costs a write per value (90 000 small rows: 0.7 s against 0.1 s in JSON mode). So a `-json` call runs in JSON mode unless the
//    same statement shape returned large values before; then it runs as `.mode quote` with headers and the output is turned into the same JSON text here. Quote
//    mode keeps what JSON mode keeps: column names, NULL, numbers as the CLI prints them (copied verbatim) and text. The choice changes the time of a call only.
import {spawn,spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdtempSync,rmSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker,isMainThread,workerData,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';

const MARK='__SQLITE_SESSION_DONE__';
// `-json` for a statement shape that returns large values: the CLI is asked for quote mode with headers.
const cliArgs=args=>args.flatMap(argument=>argument==='-json'?['-quote','-header']:[argument]);
// Statement shapes (the start of the script, literals removed) whose answers were large values. Learned from the answers of this process; see the note above.
const largeShapes=new Set();
// AIR-374: 10 000 and 8 000 (were 50 000 and 20 000). A 36 KB text value (the prediction queue document of 130 films) still took 57 ms per read in JSON mode and never crossed the old thresholds; in quote mode it takes about 1 ms.
const LARGE_ANSWER=10000,LARGE_PER_LINE=8000,SMALL_PER_LINE=2000;
const shapeOf=input=>input.slice(0,400).replace(/'(?:[^']|'')*'?/g,'?').replace(/\d+/g,'?').slice(0,200);
const lineCount=text=>{let count=1;for(let at=text.indexOf('\n');at>=0;at=text.indexOf('\n',at+1))count++;return count;};
// Remembers what this answer says about its shape and returns the result with stdout as JSON text.
function settleJson(shape,quoted,result){
 if(result.status!==0||typeof result.stdout!=='string')return result;
 const perLine=result.stdout.length/lineCount(result.stdout);
 if(!quoted){if(result.stdout.length>LARGE_ANSWER&&perLine>LARGE_PER_LINE)largeShapes.add(shape);return result;}
 if(perLine<SMALL_PER_LINE)largeShapes.delete(shape);
 result.stdout=quoteToJson(result.stdout);
 return result;
}
// The output of `-quote -header` for ONE result set, as the text `-json` prints for it: `[{"name":value,...},\n{...}]\n`, or nothing for no row.
// A text value is quoted with '' for a quote and may span lines; NULL, numbers and X'..' blobs are bare. Numbers are copied as printed (JSON mode prints the
// same digits); the infinities are written as JSON mode writes them. A blob becomes its hex text (JSON mode prints unusable bytes for a blob; no test reads one).
export function quoteToJson(text){
 if(!text)return '';
 const length=text.length,NEEDS_ESCAPE=/["\\\u0000-\u001f\u2028\u2029]/;
 let position=0,names=null,column=0;const out=[];let row='';
 // one value starting at `position`: returns its JSON token and leaves `position` after it
 const value=()=>{
  const first=text.charCodeAt(position);
  if(first===39){
   let from=position+1,end=text.indexOf("'",from);
   if(end<0)throw new Error('sqlite quote output: unterminated text');
   let content;
   if(text.charCodeAt(end+1)!==39){content=text.slice(from,end);position=end+1;}
   else{
    content='';
    for(;;){
     if(text.charCodeAt(end+1)===39){content+=text.slice(from,end+1);from=end+2;end=text.indexOf("'",from);if(end<0)throw new Error('sqlite quote output: unterminated text');continue;}
     content+=text.slice(from,end);position=end+1;break;
    }
   }
   return NEEDS_ESCAPE.test(content)?JSON.stringify(content):'"'+content+'"';
  }
  if(first===88&&text.charCodeAt(position+1)===39){
   const end=text.indexOf("'",position+2);if(end<0)throw new Error('sqlite quote output: unterminated blob');
   const hex=text.slice(position+2,end);position=end+1;return '"'+hex+'"';
  }
  let end=position;
  for(;end<length;end++){const code=text.charCodeAt(end);if(code===44||code===10)break;}
  const bare=text.slice(position,end);position=end;
  return bare==='NULL'?'null':bare==='Inf'?'9.0e+999':bare==='-Inf'?'-9.0e+999':bare;
 };
 while(position<length){
  const fields=[];
  for(;;){
   fields.push(value());
   const next=text.charCodeAt(position);
   if(next===44){position++;continue;}
   if(position<length&&next!==10)throw new Error('sqlite quote output: unexpected character after a value');
   position++;break;
  }
  if(!names){names=fields.map(name=>name+':');continue;}
  row='{';
  for(column=0;column<fields.length;column++)row+=(column?',':'')+names[column]+fields[column];
  out.push(row+'}');
 }
 return out.length?'['+out.join(',\n')+']\n':'';
}
const MAX_SESSIONS=12;

if(!isMainThread&&workerData?.sqliteSession){
 const {port,flag}=workerData;
 const sessions=new Map();
 const answer=message=>{port.postMessage(message);Atomics.store(flag,0,1);Atomics.notify(flag,0);};
 const close=key=>{const session=sessions.get(key);if(!session)return;sessions.delete(key);try{session.child.stdin.end();}catch{}try{session.child.kill('SIGKILL');}catch{}};
 const open=(key,args,fileKey)=>{
  // Durability of a test database is not part of any test: no fsync per statement (a connection setting, not stored in the file).
  const child=spawn('sqlite3',['-cmd','PRAGMA synchronous=OFF',...args],{stdio:['pipe','pipe','pipe']});
  const session={child,fileKey,chunks:[],tail:'',err:'',waiting:null,dead:false};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{session.chunks.push(chunk);session.tail=(session.tail+chunk).slice(-(MARK.length+1));settle(session);});
  child.stderr.on('data',chunk=>{session.err+=chunk;});
  child.stdin.on('error',()=>{});
  child.on('error',error=>{session.dead=true;if(sessions.get(key)===session)sessions.delete(key);const wait=session.waiting;session.waiting=null;if(wait)wait({status:1,stdout:'',stderr:String(error.message||error),signal:null});});
  child.on('close',(code,signal)=>{
   session.dead=true;if(sessions.get(key)===session)sessions.delete(key);
   const wait=session.waiting;session.waiting=null;
   if(wait)wait({status:code??1,stdout:session.chunks.join(''),stderr:session.err,signal:signal||null});
  });
  sessions.set(key,session);
  return session;
 };
 const settle=session=>{
  // Only the last characters are looked at: a long answer is kept as chunks and joined once, never re-scanned.
  if(!session.waiting||session.tail!==MARK+'\n')return;
  const wait=session.waiting;session.waiting=null;
  const stdout=session.chunks.join('').slice(0,-(MARK.length+1)),stderr=session.err;session.chunks=[];session.tail='';session.err='';
  wait({status:0,stdout,stderr,signal:null});
 };
 port.on('message',message=>{
  const {args,key,fileKey,input,prefix}=message;
  // Keep the number of idle sqlite3 processes small: the oldest session goes first.
  while(sessions.size>=MAX_SESSIONS&&!sessions.has(key))close(sessions.keys().next().value);
  let session=sessions.get(key);
  if(session&&(session.dead||session.fileKey!==fileKey)){close(key);session=null;}
  if(!session)session=open(key,args,fileKey);
  else{sessions.delete(key);sessions.set(key,session);}
  session.chunks=[];session.tail='';session.err='';
  session.waiting=answer;
  try{// Every call starts as a fresh connection did: foreign keys off (SQLite's default) unless this script turns them on.
  session.child.stdin.write((prefix||'')+'PRAGMA foreign_keys=OFF;\n'+input+'\n;\n.print '+MARK+'\n');}catch(error){const wait=session.waiting;session.waiting=null;if(wait)wait({status:1,stdout:'',stderr:String(error.message||error),signal:null});}
 });
}

let worker=null,port=null,flag=null;
const pause=new Int32Array(new SharedArrayBuffer(4));
function ensure(){
 if(worker)return;
 const channel=new MessageChannel();
 flag=new Int32Array(new SharedArrayBuffer(4));
 worker=new Worker(new URL(import.meta.url),{workerData:{sqliteSession:true,port:channel.port2,flag},transferList:[channel.port2]});
 port=channel.port1;
 // Neither the worker nor its port keeps the test process alive; when the process ends the pipes close and each sqlite3 exits on its own.
 worker.unref();port.unref();
}

// A script that may only be run in a process of its own (it could change the state of a connection that is reused).
export function needsOneShot(args,input){
 const rest=args.filter(argument=>argument!=='-json'&&argument!=='-bail');
 if(rest.length!==1||!rest[0]||rest[0].startsWith(':')||rest[0].startsWith('-'))return true;
 const text=String(input??'');
 if(/^\s*\./m.test(text))return true;
 const body=text.replace(/PRAGMA\s+foreign_keys\s*=\s*ON\s*;/gi,'');
 if(/\bPRAGMA\b/i.test(body)||/\b(ATTACH|DETACH|TEMP|TEMPORARY|VACUUM)\b/i.test(body))return true;
 if(/\bBEGIN\b/i.test(body)&&!/\b(COMMIT|END|ROLLBACK)\b/i.test(body))return true;
 // `last_insert_rowid()`, `changes()` and `total_changes()` read per-connection counters that a fresh process starts at zero.
 if(/\b(last_insert_rowid|total_changes)\s*\(/i.test(body))return true;
 // AIR-374: `changes()` is the row count of the last INSERT, UPDATE or DELETE that finished on the connection. A script whose own earlier, complete statement wrote something already sets it
 // (a guarded batch such as `UPDATE ...; UPDATE ... AND changes()=1;`), so the shared connection answers exactly what a fresh process answers (about 15 ms for each of those batches
 // as a process of its own, hundreds per file). A script that reads it before any write of its own would see the previous call's count: that one stays one-shot.
 const used=body.replace(/'(?:[^']|'')*'/g,"''").search(/\bchanges\s*\(/i);
 if(used>=0&&!/\b(INSERT|UPDATE|DELETE|REPLACE)\b[^;]*;/i.test(body.replace(/'(?:[^']|'')*'/g,"''").slice(0,used)))return true;
 if(/\bSAVEPOINT\b/i.test(body)&&!/\b(RELEASE|ROLLBACK)\b/i.test(body))return true;
 return false;
}
const fileKeyOf=file=>{try{const stat=statSync(file);return stat.dev+':'+stat.ino;}catch{return 'none';}};

// Same shape as `spawnSync('sqlite3', args, {input, encoding: 'utf8'})`: `{status, stdout, stderr, signal}`.
// AIR-374: a schema script (`-bail <file>` with an input of at least 2000 characters that starts `PRAGMA foreign_keys=ON;`) run on a database file that does not exist yet builds the same
// database every time. The first run of a given script leaves a copy of its result in a private temporary directory; every later run of the identical script on a new file copies that file instead
// of running the whole migration chain again (dozens of tests build a migrated database per case). Only a script that succeeded without any output is remembered, so the call returns the answer
// the script gave. The directory is removed when the process ends.
const SCHEMA_MIN=2000;
const schemaTemplates=new Map();
let templateDirectory=null;
const forgetTemplates=()=>{if(templateDirectory){try{rmSync(templateDirectory,{recursive:true,force:true});}catch{}}};
export function sqliteSync(args,options={}){
 const input=options.input;
 const schema=args.length===2&&args[0]==='-bail'&&typeof input==='string'&&input.length>=SCHEMA_MIN&&input.startsWith('PRAGMA foreign_keys=ON;')&&!args[1].startsWith(':')&&!args[1].startsWith('file:')&&!existsSync(args[1]);
 if(!schema)return sqliteSync1(args,options);
 const key=createHash('sha256').update(input).digest('hex'),template=schemaTemplates.get(key);
 if(template){copyFileSync(template,args[1]);return {status:0,stdout:'',stderr:'',signal:null};}
 const result=sqliteSync1(args,options);
 if(result.status===0&&!result.stdout&&!result.stderr&&existsSync(args[1])){
  if(!templateDirectory){templateDirectory=mkdtempSync(path.join(tmpdir(),'iptv-sqlite-schema-'));process.on('exit',forgetTemplates);}
  const copy=path.join(templateDirectory,String(schemaTemplates.size)+'.sqlite');
  copyFileSync(args[1],copy);schemaTemplates.set(key,copy);
 }
 return result;
}
function sqliteSync1(args,{input='',timeoutMs=300000,...options}={}){
 const json=args.includes('-json'),shape=json?shapeOf(String(input)):null,quoted=json&&largeShapes.has(shape);
 if(needsOneShot(args,input)){
  // A one-shot call in the usual form (`[-json] -bail file`) also skips the fsync per statement; any other argument list is run as given.
  const usual=args.filter(argument=>argument!=='-json'&&argument!=='-bail').length===1&&!args.some(argument=>argument.startsWith(':'));
  const real=quoted?cliArgs(args):args,result=spawnSync('sqlite3',usual?['-cmd','PRAGMA synchronous=OFF',...real]:real,{input,encoding:'utf8',maxBuffer:1<<30,...options});
  return json?settleJson(shape,quoted,result):result;
 }
 const file=args.find(argument=>argument!=='-json'&&argument!=='-bail');
 ensure();
 const key=file+'|'+(args.includes('-json')?'json':'text');
 Atomics.store(flag,0,0);
 port.postMessage({args:[...args.filter(argument=>argument==='-json'),'-bail',file],prefix:json?(quoted?'.mode quote\n.headers on\n':'.mode json\n'):'',key,fileKey:fileKeyOf(file),input:String(input)});
 if(Atomics.wait(flag,0,0,timeoutMs)==='timed-out')throw new Error('sqlite session timed out after '+timeoutMs+' ms');
 // The wake-up flag can be seen a moment before the message itself is readable on the port; wait for the message, never for the flag again.
 let received=receiveMessageOnPort(port);
 for(let attempt=0;!received&&attempt<5000;attempt++){Atomics.wait(pause,0,0,2);received=receiveMessageOnPort(port);}
 if(!received)throw new Error('sqlite session gave no answer');
 return json?settleJson(shape,quoted,received.message):received.message;
}

// `runner` for scripts/offline-import.mjs `openSqlite(file, {runner})`: the same persistent process, with the shape of the spawnSync call it replaces.
export const sqliteRunner=(args,input)=>sqliteSync(args,{input});
