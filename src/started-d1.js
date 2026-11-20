// AIR-549 stage 2. Started marks storage in D1 (schema v29, migrations/0029_started_authority.sql). This module is storage only: it never
// resolves a Film identity, never builds an event and never writes the event journal (src/worker.js does, in the same order as before), and it
// does not import. The Worker bundle wraps it as `StartedD1`; tests load it as an ES module.
//
// Authority (one marker row, started_authority; independent of filter_preset_authority):
//  - `legacy` (R2 `started/` serves, exactly as before 0029) only when the database itself proves it is pre-migration: the tables are absent AND schema_contract
//    answers a version below 29. A missing binding, an unreadable or absent schema_contract (a wrong or empty database) or version 29 without the tables is `closed`.
//    The one exception is the explicit local stand-in `STARTED_DB_OPTIONAL=standin` (tests and local development), never set in production.
//  - mode r2 -> `r2`: R2 serves; writes `held` makes every mark write answer 503 (the import fence). Nothing here touches R2.
//  - mode d1 -> `d1`: the rows serve; R2 `started/` is never read or written again. There is no fallback.
//  - any other state with the tables present (marker missing, unknown mode, unreadable) or a storage error -> `closed` (503). Never R2.
// A d1 mark commit is one batch: a guard statement proves the marker is still d1/open, the row is inserted (revision 1) or updated with
// `rev = expected` (revision + 1), and a fence statement aborts the whole batch when the row guard changed nothing. Two requests for one id cannot both win; two ids never contend.

const FENCE_SQL='UPDATE started_cas SET ok=changes() WHERE id=1';
const TABLES=['started_mark','started_authority','started_cas'];
const MARKER_SQL='SELECT mode, generation, writes FROM started_authority WHERE id=1';
const ID_PATTERN=/^[a-zA-Z0-9_-]{1,80}$/;
// The R2 listing is ordered by key `started/<id>.json`, not by id: `a-b.json` sorts before `a.json`. Rows are served in that order so a reader sees what it saw.
const ORDER='ORDER BY id||\'.json\'';

function database(source){return source&&typeof source.prepare==='function'?source:source?.DB;}
async function one(db,sql,params=[]){return (await db.prepare(sql).bind(...params).first())??null;}
async function many(db,sql,params=[]){return (await db.prepare(sql).bind(...params).all()).results||[];}

function markOf(row){
 let lastEvent=null;
 if(row.last_event_json!=null){try{lastEvent=JSON.parse(row.last_event_json);}catch{return null;}}
 const started=Number(row.started)===1;
 return {id:row.id,started,startedAt:row.started_at??null,lastEvent,rev:Number(row.rev)};
}

// -> {state:'legacy'} | {state:'r2',writes,generation} | {state:'d1',writes,generation} | {state:'closed'}
export async function readAuthority(source){
 const db=database(source);
 const standin=source?.STARTED_DB_OPTIONAL==='standin';
 if(!db||typeof db.prepare!=='function')return standin?{state:'legacy'}:{state:'closed'};
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('started_mark','started_authority','started_cas')")).map(row=>row.name);}
 catch{return {state:'closed'};}
 if(!names.length){
  let version=null;
  try{version=Number((await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version);}catch{return standin?{state:'legacy'}:{state:'closed'};}
  return Number.isFinite(version)&&version<29?{state:'legacy'}:(standin?{state:'legacy'}:{state:'closed'});
 }
 if(TABLES.some(name=>!names.includes(name)))return {state:'closed'};
 let row;
 try{row=await one(db,MARKER_SQL);}catch{return {state:'closed'};}
 if(!row||(row.mode!=='r2'&&row.mode!=='d1')||(row.writes!=='open'&&row.writes!=='held')||!Number.isInteger(Number(row.generation)))return {state:'closed'};
 return {state:row.mode,writes:row.writes,generation:Number(row.generation)};
}

// d1 only: a read that proves the marker was d1 before and after it. -> {ok:true,...}|{ok:false}
async function guardedRead(db,work){
 for(let attempt=0;attempt<2;attempt++){
  let before,value,after;
  try{before=await one(db,MARKER_SQL);value=await work();after=await one(db,MARKER_SQL);}catch{return {ok:false};}
  if(!before||!after||before.mode!=='d1'||after.mode!=='d1')return {ok:false};
  if(Number(before.generation)!==Number(after.generation)||before.writes!==after.writes)continue;
  return {ok:true,value,generation:Number(before.generation),writes:before.writes};
 }
 return {ok:false};
}

// d1 only. The ids of the started marks (`started` true), in R2 key order. -> {ok:true,ids} | {ok:false}
export async function listStartedIds(source){
 const db=database(source);
 if(!db)return {ok:false};
 const read=await guardedRead(db,()=>many(db,'SELECT id FROM started_mark WHERE started=1 '+ORDER));
 return read.ok?{ok:true,ids:read.value.map(row=>row.id)}:{ok:false};
}

// d1 only. Every mark, tombstones included, in R2 key order (the Events bootstrap). -> {ok:true,marks} | {ok:false}
export async function listMarks(source){
 const db=database(source);
 if(!db)return {ok:false};
 const read=await guardedRead(db,()=>many(db,'SELECT id, started, started_at, last_event_json, rev FROM started_mark '+ORDER));
 if(!read.ok)return {ok:false};
 const marks=read.value.map(markOf);
 return marks.some(mark=>!mark)?{ok:false}:{ok:true,marks};
}

// d1 only. One mark or null. -> {ok:true,mark} | {ok:false}
export async function readMark(source,id){
 const db=database(source);
 if(!db||typeof id!=='string'||!ID_PATTERN.test(id))return {ok:false};
 const read=await guardedRead(db,()=>one(db,'SELECT id, started, started_at, last_event_json, rev FROM started_mark WHERE id=?',[id]));
 if(!read.ok)return {ok:false};
 if(!read.value)return {ok:true,mark:null};
 const mark=markOf(read.value);
 return mark?{ok:true,mark}:{ok:false};
}

async function fenced(db,statements){
 if(typeof db.batch!=='function')return 'unavailable';
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));return 'ok';}
 catch(error){return /CHECK constraint failed|UNIQUE constraint failed/i.test(String(error?.message||error))?'conflict':'unavailable';}
}

// d1 only. `mark` = {id, started:boolean, startedAt:string|null, lastEvent:object}; `expectedRev` is the stored revision the decision was made on (0: no row yet).
// -> {ok:true,rev} | {ok:false,reason:'writes_held'|'conflict'|'unavailable'}
export async function commitMark(source,{expectedRev,mark}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!mark||typeof mark.id!=='string'||!ID_PATTERN.test(mark.id)||typeof mark.started!=='boolean'||!mark.lastEvent||typeof mark.lastEvent.id!=='string'||!Number.isInteger(expectedRev)||expectedRev<0)return {ok:false,reason:'unavailable'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'unavailable'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const eventJson=JSON.stringify(mark.lastEvent),flag=mark.started?1:0,rev=expectedRev+1;
 const guard=["UPDATE started_cas SET ok=(SELECT COUNT(*) FROM started_authority WHERE id=1 AND mode='d1' AND writes='open') WHERE id=1",[]];
 const write=expectedRev===0
  ?['INSERT INTO started_mark (id,started,started_at,last_event_json,rev) VALUES (?,?,?,?,1)',[mark.id,flag,mark.startedAt??null,eventJson]]
  :['UPDATE started_mark SET started=?, started_at=?, last_event_json=?, rev=rev+1 WHERE id=? AND rev=?',[flag,mark.startedAt??null,eventJson,mark.id,expectedRev]];
 const outcome=await fenced(db,[guard,write,...(expectedRev===0?[]:[[FENCE_SQL,[]]])]);
 if(outcome==='ok')return {ok:true,rev};
 if(outcome==='conflict')return {ok:false,reason:'conflict'};
 // A lost reply is not a failed write. Success is claimed only when the stored row is exactly this request's mark at the next revision
 // (the event id is unique to the request); anything else is a competitor's commit or no commit.
 const after=await readMark(db,mark.id);
 if(after.ok&&after.mark&&after.mark.rev===rev&&after.mark.lastEvent?.id===mark.lastEvent.id&&after.mark.started===mark.started)return {ok:true,rev};
 if(after.ok&&after.mark&&after.mark.rev>=rev)return {ok:false,reason:'conflict'};
 return {ok:false,reason:'unavailable'};
}
