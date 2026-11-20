// AIR-549 stage 1. Filter presets storage in D1 (schema v28, migrations/0028_filter_preset_authority.sql). This module is
// storage only: it never validates or normalizes a preset (src/filter-presets.js does that before and after every call) and
// it does not import. The Worker bundle wraps it; tests load it as an ES module.
//
// Authority (one marker row, filter_preset_authority):
//  - no DB binding, or the schema is provably absent (sqlite_master answers and lacks the tables) -> `legacy`: R2 serves, exactly as before 0028.
//  - mode r2 -> `r2`: R2 serves; writes `held` makes every preset write answer 503 (the import fence). Nothing here touches R2.
//  - mode d1 -> `d1`: the rows serve; R2 is never read or written for presets again. There is no fallback.
//  - any other state with the tables present (marker missing, unknown mode, unreadable) or a storage error -> `closed` (503). Never R2.
// A d1 read takes the marker, the rows and the marker again; a disagreement retries once, a second one fails closed.
// A d1 commit is one batch: the marker generation is advanced with a compare-and-swap, a fence statement aborts the whole
// batch when that update changed nothing (so two writers on one generation cannot both win), then the rows are replaced.
// The HTTP ETag is `"none"` at generation 0 and `"d1:<generation>"` after. An R2 ETag is never a valid D1 token.

export const FILTER_PRESET_MAX=30;
const FENCE_SQL='UPDATE filter_preset_cas SET ok=changes() WHERE id=1';
const TABLES=['filter_preset','filter_preset_authority','filter_preset_cas'];
const MARKER_SQL='SELECT mode, generation, writes FROM filter_preset_authority WHERE id=1';
const ROW_SQL='SELECT id, name, query, created_at, updated_at, generation FROM filter_preset ORDER BY position';
const INSERT_SQL='INSERT INTO filter_preset (id,position,name,query,created_at,updated_at,generation) VALUES (?,?,?,?,?,?,?)';

function database(source){return source&&typeof source.prepare==='function'?source:source?.DB;}
async function one(db,sql,params=[]){return (await db.prepare(sql).bind(...params).first())??null;}
async function many(db,sql,params=[]){return (await db.prepare(sql).bind(...params).all()).results||[];}
export function filterPresetEtag(generation){return generation===0?'"none"':'"d1:'+generation+'"';}
export function filterPresetGeneration(token){
 const bare=String(token||'').trim().replace(/^W\//,'').replace(/^"(.*)"$/,'$1');
 if(bare==='none')return 0;
 const match=/^d1:([1-9]\d*)$/.exec(bare);
 return match?Number(match[1]):null;
}
function rowsOf(presets,generation){return presets.map((preset,index)=>[INSERT_SQL,[preset.id,index,preset.name,preset.query,preset.createdAt,preset.updatedAt,generation]]);}
function presetsFrom(rows,generation){
 const presets=[];
 for(const row of rows){
  if(Number(row.generation)!==generation)return null;
  presets.push({id:row.id,name:row.name,schemaVersion:1,query:row.query,createdAt:row.created_at,updatedAt:row.updated_at});
 }
 return presets;
}

// -> {state:'legacy'} | {state:'r2',writes,generation} | {state:'d1',writes,generation} | {state:'closed'}
export async function readAuthority(source){
 const db=database(source);
 if(!db||typeof db.prepare!=='function')return {state:'legacy'};
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('filter_preset','filter_preset_authority','filter_preset_cas')")).map(row=>row.name);}
 catch{return {state:'closed'};}
 if(!names.length)return {state:'legacy'};
 if(TABLES.some(name=>!names.includes(name)))return {state:'closed'};
 let row;
 try{row=await one(db,MARKER_SQL);}catch{return {state:'closed'};}
 if(!row||(row.mode!=='r2'&&row.mode!=='d1')||(row.writes!=='open'&&row.writes!=='held')||!Number.isInteger(Number(row.generation)))return {state:'closed'};
 return {state:row.mode,writes:row.writes,generation:Number(row.generation)};
}

// d1 only. -> {ok:true,generation,presets} | {ok:false}
export async function readPresets(source){
 const db=database(source);
 if(!db)return {ok:false};
 for(let attempt=0;attempt<2;attempt++){
  let before,rows,after;
  try{before=await one(db,MARKER_SQL);rows=await many(db,ROW_SQL);after=await one(db,MARKER_SQL);}catch{return {ok:false};}
  if(!before||!after||before.mode!=='d1'||after.mode!=='d1')return {ok:false};
  if(Number(before.generation)!==Number(after.generation)||before.writes!==after.writes)continue;
  const generation=Number(before.generation);
  const presets=presetsFrom(rows,generation);
  if(!presets||presets.length>FILTER_PRESET_MAX)continue;
  if(generation===0&&presets.length)continue;
  return {ok:true,generation,presets,writes:before.writes};
 }
 return {ok:false};
}

async function fenced(db,statements){
 if(typeof db.batch!=='function')return 'unavailable';
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));return 'ok';}
 catch(error){return /CHECK constraint failed|UNIQUE constraint failed/i.test(String(error?.message||error))?'conflict':'unavailable';}
}

// d1 only. `presets` is already validated and normalized. -> {ok:true,generation} | {ok:false,reason:'writes_held'|'conflict'|'unavailable'|'too_many'}
export async function commitPresets(source,{expectedGeneration,presets}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!Array.isArray(presets)||presets.length>FILTER_PRESET_MAX)return {ok:false,reason:'too_many'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'unavailable'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 if(gate.generation!==expectedGeneration)return {ok:false,reason:'conflict'};
 const generation=expectedGeneration+1;
 const outcome=await fenced(db,[
  ["UPDATE filter_preset_authority SET generation=? WHERE id=1 AND mode='d1' AND writes='open' AND generation=?",[generation,expectedGeneration]],
  [FENCE_SQL,[]],
  ['DELETE FROM filter_preset',[]],
  ...rowsOf(presets,generation),
 ]);
 if(outcome==='conflict')return {ok:false,reason:'conflict'};
 if(outcome!=='ok'){
  // A lost reply is not a failed write: read the marker once. A move to exactly our generation means our batch committed.
  const after=await readAuthority(db);
  if(after.state==='d1'&&after.generation===generation)return {ok:true,generation};
  return {ok:false,reason:'unavailable'};
 }
 return {ok:true,generation};
}

function sameRows(rows,presets){
 if(rows.length!==presets.length)return false;
 return presets.every((preset,index)=>{
  const row=rows[index];
  return row.id===preset.id&&row.name===preset.name&&row.query===preset.query&&row.created_at===preset.createdAt&&row.updated_at===preset.updatedAt;
 });
}

// Import (mode r2 only, writes held, generation 0 or an identical earlier import). The rows are loaded and the generation becomes 1,
// but the marker stays r2: nothing is served from D1 yet. `presets` is the validated content of the R2 object.
// -> {ok:true,generation:1,already:boolean} | {ok:false,reason}
export async function importPresets(source,{presets}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!Array.isArray(presets)||presets.length>FILTER_PRESET_MAX)return {ok:false,reason:'too_many'};
 const gate=await readAuthority(db);
 if(gate.state!=='r2')return {ok:false,reason:gate.state==='d1'?'already_active':'unavailable'};
 if(gate.writes!=='held')return {ok:false,reason:'writes_not_held'};
 if(gate.generation!==0){
  if(gate.generation!==1)return {ok:false,reason:'conflict'};
  let rows;try{rows=await many(db,ROW_SQL);}catch{return {ok:false,reason:'unavailable'};}
  return sameRows(rows,presets)?{ok:true,generation:1,already:true}:{ok:false,reason:'conflict'};
 }
 const outcome=await fenced(db,[
  ["UPDATE filter_preset_authority SET generation=1 WHERE id=1 AND mode='r2' AND writes='held' AND generation=0",[]],
  [FENCE_SQL,[]],
  ['DELETE FROM filter_preset',[]],
  ...rowsOf(presets,1),
 ]);
 if(outcome==='ok')return {ok:true,generation:1,already:false};
 const after=await readAuthority(db);
 if(after.state==='r2'&&after.generation===1){
  let rows;try{rows=await many(db,ROW_SQL);}catch{return {ok:false,reason:'unavailable'};}
  if(sameRows(rows,presets))return {ok:true,generation:1,already:true};
 }
 return {ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
}

// Activation: only from mode r2, writes held, generation 1, with the rows equal to the document the operator proved against R2.
// One guarded UPDATE flips mode to d1 and writes to open. -> {ok:true,generation} | {ok:false,reason}
export async function activatePresets(source,{presets}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 const gate=await readAuthority(db);
 if(gate.state!=='r2'||gate.writes!=='held'||gate.generation!==1)return {ok:false,reason:'not_ready'};
 let rows;try{rows=await many(db,ROW_SQL);}catch{return {ok:false,reason:'unavailable'};}
 if(!sameRows(rows,presets)||rows.some(row=>Number(row.generation)!==1))return {ok:false,reason:'parity'};
 try{await db.prepare("UPDATE filter_preset_authority SET mode='d1', writes='open' WHERE id=1 AND mode='r2' AND writes='held' AND generation=1").bind().run();}
 catch{return {ok:false,reason:'unavailable'};}
 const after=await readAuthority(db);
 return after.state==='d1'&&after.writes==='open'&&after.generation===1?{ok:true,generation:1}:{ok:false,reason:'unavailable'};
}
