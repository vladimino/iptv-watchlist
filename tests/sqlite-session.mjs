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
import {spawn,spawnSync} from 'node:child_process';
import {statSync} from 'node:fs';
import {Worker,isMainThread,workerData,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';

const MARK='__SQLITE_SESSION_DONE__';
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
  const {args,key,fileKey,input}=message;
  // Keep the number of idle sqlite3 processes small: the oldest session goes first.
  while(sessions.size>=MAX_SESSIONS&&!sessions.has(key))close(sessions.keys().next().value);
  let session=sessions.get(key);
  if(session&&(session.dead||session.fileKey!==fileKey)){close(key);session=null;}
  if(!session)session=open(key,args,fileKey);
  else{sessions.delete(key);sessions.set(key,session);}
  session.chunks=[];session.tail='';session.err='';
  session.waiting=answer;
  try{// Every call starts as a fresh connection did: foreign keys off (SQLite's default) unless this script turns them on.
  session.child.stdin.write('PRAGMA foreign_keys=OFF;\n'+input+'\n;\n.print '+MARK+'\n');}catch(error){const wait=session.waiting;session.waiting=null;if(wait)wait({status:1,stdout:'',stderr:String(error.message||error),signal:null});}
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
 if(/\b(last_insert_rowid|total_changes|changes)\s*\(/i.test(body))return true;
 if(/\bSAVEPOINT\b/i.test(body)&&!/\b(RELEASE|ROLLBACK)\b/i.test(body))return true;
 return false;
}
const fileKeyOf=file=>{try{const stat=statSync(file);return stat.dev+':'+stat.ino;}catch{return 'none';}};

// Same shape as `spawnSync('sqlite3', args, {input, encoding: 'utf8'})`: `{status, stdout, stderr, signal}`.
export function sqliteSync(args,{input='',timeoutMs=300000,...options}={}){
 if(needsOneShot(args,input)){
  // A one-shot call in the usual form (`[-json] -bail file`) also skips the fsync per statement; any other argument list is run as given.
  const usual=args.filter(argument=>argument!=='-json'&&argument!=='-bail').length===1&&!args.some(argument=>argument.startsWith(':'));
  return spawnSync('sqlite3',usual?['-cmd','PRAGMA synchronous=OFF',...args]:args,{input,encoding:'utf8',maxBuffer:1<<30,...options});
 }
 const file=args.find(argument=>argument!=='-json'&&argument!=='-bail');
 ensure();
 const key=file+'|'+(args.includes('-json')?'json':'text');
 Atomics.store(flag,0,0);
 port.postMessage({args:[...args.filter(argument=>argument==='-json'),'-bail',file],key,fileKey:fileKeyOf(file),input:String(input)});
 if(Atomics.wait(flag,0,0,timeoutMs)==='timed-out')throw new Error('sqlite session timed out after '+timeoutMs+' ms');
 // The wake-up flag can be seen a moment before the message itself is readable on the port; wait for the message, never for the flag again.
 let received=receiveMessageOnPort(port);
 for(let attempt=0;!received&&attempt<5000;attempt++){Atomics.wait(pause,0,0,2);received=receiveMessageOnPort(port);}
 if(!received)throw new Error('sqlite session gave no answer');
 return received.message;
}

// `runner` for scripts/offline-import.mjs `openSqlite(file, {runner})`: the same persistent process, with the shape of the spawnSync call it replaces.
export const sqliteRunner=(args,input)=>sqliteSync(args,{input});
