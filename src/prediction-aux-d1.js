// AIR-553 / ADR 0194 (Accepted): the batch_v2 auxiliary prediction state in D1: the held stage, the run sources, the persisted manifest and the event outbox.
// DORMANT: nothing here runs until the marker `prediction_aux_authority` reads `d1` (a separate owner activation, AIR-554). While the marker is `r2`, or the schema is
// older than the migration that created it, every function of the Worker that asks `readAuxAuthority` gets a mode of `r2` and keeps its R2 code unchanged.
// This module imports nothing (it is scoped into the Worker bundle like prediction-d1.js) and never touches R2 itself: the Events journal and the deferred-start
// receipts stay R2 objects owned by their existing writers.
export const AUX_CONTRACT=34;
export const AUX_LIMITS={stageItems:10,stageBytes:56*1024,statementBytes:100*1024,bindLimit:100,pieceChars:40000,skippedCap:256,compactMs:14*86400000,compactLimit:20,drainLimit:20,quarantineAfter:8,stageAttempts:5};
const SCOPE=Symbol.for('iptv.requestScope');
export const databaseOf=env=>env?.DB??null;
const TABLES=['prediction_aux_authority','prediction_aux_cas','prediction_batch_stage_head','prediction_batch_stage','prediction_run_source_head','prediction_run_source_revision','prediction_run_source_piece','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox','prediction_event_outbox_counter','prediction_event_outbox_state_count','prediction_event_outbox_diag'];
const encoder=new TextEncoder();

// `guard` names which budget refused. Codes: prediction_aux_unavailable (the authority or the database cannot answer), prediction_aux_cas (a fence or a revision moved: nothing was written),
// prediction_aux_budget (a statement over the byte or bind budget), prediction_aux_conflict (create-only record exists with other bytes), prediction_aux_corrupt (stored bytes fail their digest).
function failed(code,cause,detail){const error=new Error(code);error.code=code;if(cause)error.cause=cause;if(detail)error.detail=detail;return error;}
const binding=db=>typeof db?.prepare==='function';
function literalBytes(value){
 if(value==null)return 4;
 if(typeof value==='number'||typeof value==='boolean')return String(value).length;
 const text=String(value);
 return 2+encoder.encode(text).length+(text.split("'").length-1);
}
function assertStatements(statements){
 for(const [sql,params=[]] of statements){
  if(params.length>AUX_LIMITS.bindLimit)throw failed('prediction_aux_budget',undefined,'bind_limit');
  if(encoder.encode(sql).length+params.reduce((sum,value)=>sum+literalBytes(value),0)>AUX_LIMITS.statementBytes)throw failed('prediction_aux_budget',undefined,'statement_bytes');
 }
}
async function one(db,sql,params=[]){return binding(db)?(await db.prepare(sql).bind(...params).first())??null:(await db.get(sql,params))??null;}
async function many(db,sql,params=[]){return binding(db)?(await db.prepare(sql).bind(...params).all()).results||[]:(await db.all(sql,params))||[];}
function rethrow(error){
 if(error?.code&&String(error.code).startsWith('prediction_aux_'))throw error;
 if(error?.name==='OperatorStop'||error?.kind==='write_uncertain'||error?.kind==='batch_too_large')throw error;
 const message=String(error?.message||error);
 if(/CHECK constraint failed: ok|UNIQUE constraint failed|CHECK constraint failed: active_pending/i.test(message))throw failed('prediction_aux_cas',error);
 if(/prediction_aux_immutable|prediction_aux_outbox/i.test(message))throw failed('prediction_aux_conflict',error);
 throw failed('prediction_aux_unavailable',error);
}
// One D1 batch: every statement, guards first, commits together or not at all.
// Several reads in ONE D1 round trip and one snapshot (a batch of SELECTs); without a batch the same reads run one by one. Returns one array of rows per statement.
async function readBatch(db,list){
 if(binding(db)&&typeof db.batch==='function'){
  let out;try{out=await db.batch(list.map(([sql,params=[]])=>db.prepare(sql).bind(...params)));}catch(error){throw failed('prediction_aux_unavailable',error);}
  if(!Array.isArray(out)||out.length!==list.length)throw failed('prediction_aux_unavailable');
  return out.map(item=>item?.results||[]);
 }
 const rows=[];for(const [sql,params=[]] of list)rows.push(await many(db,sql,params));return rows;
}
export async function runBatch(db,statements){
 if(typeof db?.batch!=='function')throw failed('prediction_aux_unavailable');
 assertStatements(statements);
 let prepared;
 try{prepared=statements.map(([sql,params=[]])=>db.prepare(sql).bind(...params));}catch(error){rethrow(error);}
 try{return await db.batch(prepared);}catch(error){rethrow(error);}
}
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
}
export async function sha256(value){
 const bytes=encoder.encode(typeof value==='string'?value:JSON.stringify(canonical(value)));
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
// Byte-aware pieces (UTF-8 and SQL literal bytes against the statement budget; the character count is only a target) that never split a surrogate pair.
export function splitPieces(text,target=AUX_LIMITS.pieceChars){
 const pieces=[];let start=0;
 const fits=(a,b)=>literalBytes(text.slice(a,b))+400<=AUX_LIMITS.statementBytes;
 while(start<text.length){
  let end=Math.min(text.length,start+target);
  while(end>start&&!fits(start,end))end=start+Math.max(1,Math.floor((end-start)/2));
  if(end<text.length&&end>start+1){const code=text.charCodeAt(end-1);if(code>=0xD800&&code<=0xDBFF)end--;}
  if(!fits(start,end))throw failed('prediction_aux_budget',undefined,'statement_bytes');
  pieces.push(text.slice(start,end));start=end;
 }
 return pieces.length?pieces:[''];
}

// ---- Authority (ADR 0194 decision 1). Four outcomes; an unavailable or incomplete authority is never read as r2. ----
function idle(proof,version){return {mode:'r2',proof,installed:false,generation:0,version:version??null,ready:false};}
export async function readAuxAuthority(db,env,hint={}){
 const required=env?.PREDICTION_DB_REQUIRED==='on';
 const scope=db?.[SCOPE];
 if(scope?.aux)return scope.aux;
 let result;
 if(db==null){
  if(required)throw failed('prediction_aux_unavailable');
  result=idle('not_installed',null);
 }
 else{
  let version=hint.version;
  if(version===undefined||version===null){
   try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
   catch(error){
    if(/no such table/i.test(String(error?.message||error))&&!required)return idle('not_installed',null);
    throw failed('prediction_aux_unavailable',error);
   }
  }
  if(version==null){if(required)throw failed('prediction_aux_unavailable');result=idle('not_installed',null);}
  else if(Number(version)<AUX_CONTRACT)result=idle('not_installed',Number(version));
  else{
   let names,row;
   try{
    if(typeof db.batch==='function'&&binding(db)){
     const out=await db.batch([db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+")").bind(),db.prepare('SELECT mode, generation FROM prediction_aux_authority WHERE id=1').bind()]);
     names=(out[0].results||[]).map(item=>item.name);row=out[1]?.results?.[0]??null;
    }
    else{
     names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+")")).map(item=>item.name);
     row=names.includes('prediction_aux_authority')?await one(db,'SELECT mode, generation FROM prediction_aux_authority WHERE id=1'):null;
    }
   }catch(error){throw failed('prediction_aux_unavailable',error);}
   if(names.length!==TABLES.length||!row||(row.mode!=='r2'&&row.mode!=='closed'&&row.mode!=='d1'))throw failed('prediction_aux_unavailable');
   result={mode:row.mode,proof:row.mode==='d1'?'d1':row.mode==='closed'?'closed':'explicit_r2',installed:true,generation:Number(row.generation),version:Number(version),ready:row.mode==='d1'};
  }
 }
 if(scope)scope.aux=result;
 return result;
}
// ADR 0196. The state an entry point must refuse in: the marker reads `closed` (every legacy writer of the four R2 families is shut out; the R2 objects are still the data and are still read).
export function auxClosed(authority){return authority?.mode==='closed';}
// The gate immediately before an R2 PUT or delete of one of the four families. It reads the marker FRESH (never the request scope: a request that read r2 earlier must not carry that into its
// write) and refuses with a typed error unless the marker proves `r2` or proves the tables are not installed. closed and d1 both refuse (after d1 the Worker never writes these objects
// again); an unavailable marker refuses too (never read as r2). The one residual is a PUT already past this check; it is bounded by one object-store operation (ADR 0196).
export async function guardR2Write(db,env){
 const required=env?.PREDICTION_DB_REQUIRED==='on';
 if(db==null){if(required)throw failed('prediction_aux_unavailable');return {mode:'r2',proof:'not_installed'};}
 let version,row=null,names=[];
 try{
  version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;
  if(version!=null&&Number(version)>=AUX_CONTRACT){
   // One round trip once the schema is at or above 0034: the table inventory and the marker row in one batch (the same shape as readAuxAuthority).
   const inventory="SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+")";
   if(typeof db.batch==='function'&&binding(db)){
    const out=await db.batch([db.prepare(inventory).bind(),db.prepare('SELECT mode, generation FROM prediction_aux_authority WHERE id=1').bind()]);
    names=(out[0].results||[]).map(item=>item.name);row=out[1]?.results?.[0]??null;
   }
   else{
    names=(await many(db,inventory)).map(item=>item.name);
    row=names.includes('prediction_aux_authority')?await one(db,'SELECT mode, generation FROM prediction_aux_authority WHERE id=1'):null;
   }
  }
 }catch(error){
  if(/no such table/i.test(String(error?.message||error))&&!required&&version==null)return {mode:'r2',proof:'not_installed'};
  throw failed('prediction_aux_unavailable',error);
 }
 if(version==null){if(required)throw failed('prediction_aux_unavailable');return {mode:'r2',proof:'not_installed'};}
 if(Number(version)<AUX_CONTRACT)return {mode:'r2',proof:'not_installed'};
 if(names.length!==TABLES.length||!row)throw failed('prediction_aux_unavailable');
 if(row.mode==='r2')return {mode:'r2',proof:'explicit_r2',generation:Number(row.generation)};
 if(row.mode==='closed')throw failed('prediction_aux_closed',undefined,'closed');
 if(row.mode==='d1')throw failed('prediction_aux_closed',undefined,'d1');
 throw failed('prediction_aux_unavailable');
}
// The caller needs the D1 branch: returns the authority when d1, null when proved r2 or closed (the caller runs its R2 code; a closed marker refuses at the entry and at the PUT), throws when unavailable.
export async function auxD1(db,env,hint={}){
 const authority=await readAuxAuthority(db,env,hint);
 return authority.mode==='d1'?authority:null;
}

// ---- Guards (ADR 0194 decision 2). Every guard is a statement of the SAME batch as the data: ok <> 1 aborts all of it. ----
const FENCE_SQL='UPDATE prediction_aux_cas SET ok=(SELECT count(*) FROM prediction_aux_authority WHERE id=1 AND mode=? AND generation=?) WHERE id=1';
export const markerGuard=(authority,mode='d1')=>[FENCE_SQL,[mode,authority.generation]];
// The runner-lease fence of a run-owned write. With a token (a claimed start, a drain, a submit under its gate) it is the unchanged COMMIT_GUARD predicate; without one (the keyless or
// synchronous path, where the run's own lease is the fence) it checks runId, epoch and expiry. `run` adds the run row's protocol (the row exists once the run was saved).
export function leaseGuard(guard,{run=false,prep=false}={}){
 const token=guard?.token!=null;
 const sql="UPDATE prediction_aux_cas SET ok=(SELECT count(*) FROM prediction_lease WHERE name='runner' AND expires_at>? AND json_extract(document_json,'$.runId')=? AND json_extract(document_json,'$.epoch')=?"+(token?" AND json_extract(document_json,'$.submitGate.token')=?":'')+(prep?" AND json_extract(document_json,'$.prep')=1":'')+")*(SELECT count(*) FROM prediction_domain_authority WHERE id=1 AND mode='d1')"+(run?"*(SELECT count(*) FROM prediction_run WHERE run_id=? AND json_extract(document_json,'$.protocol')='batch_v2')":'')+' WHERE id=1';
 return [sql,[Date.now(),String(guard.runId),Number(guard.epoch),...(token?[String(guard.token)]:[]),...(run?[String(guard.runId)]:[])]];
}
// The writer lease the caller holds (a delivery or recovery under the writer lease of an authorized start).
export const writerGuard=owner=>["UPDATE prediction_aux_cas SET ok=(SELECT count(*) FROM prediction_lease WHERE name='writer' AND expires_at>? AND json_extract(document_json,'$.id')=?) WHERE id=1",[Date.now(),String(owner)]];
// The fence class of a write is EXPLICIT and a missing or incomplete one throws: nothing is ever silently weakened to the marker alone.
//   'run'    a run-owned write (stage, sources, manifest): the runner lease of THAT run (id, epoch, unexpired, gate token where one exists) and the prediction domain marker, in the batch
//   'writer' a delivery or terminal write under the writer lease the caller holds (owner id threaded from the writer lease)
//   'target' a lease-free write or a recovery of an expired predecessor: the caller's own compare-and-swap on the target row (identity, state, attempts) is the fence; named by the caller on purpose
// The prediction domain predicate is the one every D1 prediction writer uses (mode d1, generation); the `writes` column is the import fence of r2 mode and is `held` in production in mode d1 (ADR 0162).
export function guardsFor(authority,guard,options={}){
 const fence=options.fence||(options.guard===false?null:(guard?'run':options.writer?'writer':null));
 const list=[markerGuard(authority)];
 if(fence==='run'){
  if(!guard||typeof guard.runId!=='string'||!guard.runId||!Number.isInteger(guard.epoch))throw failed('prediction_aux_guard',undefined,'run_fence_incomplete');
  list.push(leaseGuard(guard,options));
  if(options.writer)list.push(writerGuard(options.writer));
 }
 else if(fence==='writer'){
  if(typeof options.writer!=='string'||!options.writer)throw failed('prediction_aux_guard',undefined,'writer_fence_incomplete');
  list.push(writerGuard(options.writer));
 }
 else if(fence==='target'){/* the caller's own compare-and-swap on the target row is the fence */}
 else throw failed('prediction_aux_guard',undefined,'no_fence');
 return list;
}
// An outbox write names its fence: the writer lease it holds, or the target row's own state. No default.
const outboxFence=(options)=>options.fence||(options.writer?'writer':null);

// ---- Held stage (decision 3): rows + one head row that carries the count and the aggregate serialized cap. ----
// The head and the rows are read in ONE D1 batch (one snapshot), then checked against each other: a head that disagrees with its rows is corruption, never a blend of two moments.
const STAGE_HEAD_SQL='SELECT item_count AS itemCount, total_bytes AS totalBytes, revision, updated_at AS updatedAt FROM prediction_batch_stage_head WHERE id=1';
const STAGE_ROWS_SQL='SELECT film_id AS filmId, position, item_digest AS itemDigest, held_by_run_id AS heldByRunId, body_bytes AS bodyBytes, item_json AS itemJson FROM prediction_batch_stage ORDER BY position';
export async function readStage(db){
 let head,rows;
 if(binding(db)&&typeof db.batch==='function'){
  let out;try{out=await db.batch([db.prepare(STAGE_HEAD_SQL).bind(),db.prepare(STAGE_ROWS_SQL).bind()]);}catch(error){throw failed('prediction_aux_unavailable',error);}
  head=out?.[0]?.results?.[0]??null;rows=out?.[1]?.results||[];
 }
 else[head,rows]=[await one(db,STAGE_HEAD_SQL),await many(db,STAGE_ROWS_SQL)];
 if(!head)throw failed('prediction_aux_unavailable');
 const items=[];
 for(const row of rows){try{items.push(JSON.parse(row.itemJson));}catch(error){throw failed('prediction_aux_corrupt',error,'stage_item');}}
 if(Number(head.itemCount)!==rows.length||Number(head.totalBytes)!==stageDocBytes(rows.map(row=>Number(row.bodyBytes))))throw failed('prediction_aux_corrupt',undefined,'stage_head');
 return {items,updatedAt:head.updatedAt||null,revision:Number(head.revision),itemCount:Number(head.itemCount),totalBytes:Number(head.totalBytes),positions:rows.map(row=>Number(row.position)),observed:rows.map(row=>({filmId:row.filmId,itemDigest:row.itemDigest,heldByRunId:row.heldByRunId||null}))};
}
// Deletes the staged rows a caller OBSERVED, by exact film, digest and holder, never by film id alone: a replacement hold of the same film (another digest or holder) stays. The head is recomputed from the
// rows in the same batch, so count and aggregate bytes are exact whatever else changed.
export async function dropStageRows(db,authority,rows,{guard=null,writer=null,now=Date.now}={}){
 const list=(rows||[]).filter(row=>row&&typeof row.filmId==='string'&&typeof row.itemDigest==='string'&&row.itemDigest);
 if(!list.length)return 0;
 await runBatch(db,[...guardsFor(authority,guard,{fence:'run',writer}),...list.map(row=>['DELETE FROM prediction_batch_stage WHERE film_id=? AND item_digest=? AND held_by_run_id IS ?',[row.filmId,row.itemDigest,row.heldByRunId??null]]),...stageHeadRecompute(now)]);
 return list.length;
}
const stageHeadRecompute=(now)=>[['UPDATE prediction_batch_stage_head SET item_count=(SELECT count(*) FROM prediction_batch_stage), total_bytes=(SELECT CASE WHEN count(*)=0 THEN 0 ELSE 2+sum(body_bytes)+count(*)-1 END FROM prediction_batch_stage), revision=revision+1, updated_at=? WHERE id=1',[new Date(now()).toISOString()]]];
export const stageDocBytes=(sizes)=>sizes.length?2+sizes.reduce((sum,n)=>sum+n,0)+sizes.length-1:0;
// A compare-and-swap merge like mergeStoredJSON: `apply` gets a copy of {items}, returns the next document or null (no change). `measure(item)` is the serialized byte size of the item's
// held body (what the stage cap counts). Contention retries a bounded number of times, then throws the message the hold path already maps to hold_contention.
export async function mergeStage(db,authority,apply,{measure,guard=null,writer=null,now=Date.now}={}){
 for(let attempt=0;attempt<AUX_LIMITS.stageAttempts;attempt++){
  const current=await readStage(db);
  const next=await apply({items:structuredClone(current.items),updatedAt:current.updatedAt});
  if(next==null)return {items:current.items,updatedAt:current.updatedAt};
  const items=Array.isArray(next.items)?next.items:[];
  const sizes=items.map(measure),total=stageDocBytes(sizes);
  if(items.length>AUX_LIMITS.stageItems)throw failed('prediction_aux_budget',undefined,'stage_items');
  if(total>AUX_LIMITS.stageBytes)throw failed('prediction_aux_budget',undefined,'stage_bytes');
  const byId=new Map(current.items.map((item,index)=>[item.filmId,{item,position:current.positions[index]}]));
  const ids=new Set(items.map(item=>item.filmId));
  const stamp=new Date(now()).toISOString();
  const statements=[...guardsFor(authority,guard,{fence:'run',writer}),['UPDATE prediction_aux_cas SET ok=(SELECT count(*) FROM prediction_batch_stage_head WHERE id=1 AND revision=?) WHERE id=1',[current.revision]]];
  for(const [filmId] of byId)if(!ids.has(filmId))statements.push(['DELETE FROM prediction_batch_stage WHERE film_id=?',[filmId]]);
  let position=current.positions.length?Math.max(...current.positions)+1:0;
  items.forEach((item,index)=>{
   const text=JSON.stringify(item),held=byId.get(item.filmId);
   if(!held)statements.push(['INSERT INTO prediction_batch_stage (film_id, position, item_digest, held_by_run_id, held_at, body_bytes, item_json) VALUES (?,?,?,?,?,?,?)',[item.filmId,position++,String(item.itemDigest||''),item.origin?.runId??null,item.stagedAt||stamp,sizes[index],text]]);
   else if(JSON.stringify(held.item)!==text)statements.push(['UPDATE prediction_batch_stage SET item_digest=?, held_by_run_id=?, body_bytes=?, item_json=? WHERE film_id=?',[String(item.itemDigest||''),item.origin?.runId??null,sizes[index],text,item.filmId]]);
  });
  statements.push(['UPDATE prediction_batch_stage_head SET item_count=?, total_bytes=?, revision=revision+1, updated_at=? WHERE id=1',[items.length,total,stamp]]);
  try{await runBatch(db,statements);return {items,updatedAt:next.updatedAt||stamp};}
  catch(error){if(error.code==='prediction_aux_cas'&&attempt<AUX_LIMITS.stageAttempts-1)continue;if(error.code==='prediction_aux_cas')throw new Error('Stored JSON changed during write');throw error;}
 }
 throw new Error('Stored JSON changed during write');
}

// The statements that settle ONE staged row inside another batch (the drain: the film's prediction commit): the conditional delete (film, digest) and the head recomputed from the rows themselves,
// so the count and the aggregate bytes stay exact whatever else changed. A row whose digest differs (a newer hold) stays.
export function stageSettleStatements(authority,filmId,itemDigest,heldByRunId=null,now=Date.now){
 return [
  markerGuard(authority),
  ['DELETE FROM prediction_batch_stage WHERE film_id=? AND item_digest=? AND held_by_run_id IS ?',[String(filmId),String(itemDigest),heldByRunId??null]],
  ...stageHeadRecompute(now),
 ];
}

// ---- Run sources (decision 4): insert-only revisions, a CAS-advanced head, byte-capped pieces. ----
async function readPieces(db,table,where,params){
 return many(db,'SELECT piece_no AS pieceNo, text FROM '+table+' WHERE '+where+' ORDER BY piece_no',params);
}
// The head is read together with the run's own binding (`sourceRevision`, `sourceHash` in the run document, written in the SAME batch as the revision): a head that does not match the run it belongs to
// is corruption, never input. A run document without a binding is a legacy or imported run and is accepted; a source head whose run row is absent is not.
export async function readSource(db,runId){
 // The head with the run's binding, the revision's metadata and its pieces: one batch, one snapshot, one round trip.
 const [headRows,metaRows,pieceRows]=await readBatch(db,[
  ["SELECT h.current_revision AS revision, h.source_hash AS hash, r.run_id AS runRow, json_extract(r.document_json,'$.sourceRevision') AS boundRevision, json_extract(r.document_json,'$.sourceHash') AS boundHash FROM prediction_run_source_head h LEFT JOIN prediction_run r ON r.run_id=h.run_id WHERE h.run_id=?",[runId]],
  ['SELECT bytes, piece_count AS pieceCount FROM prediction_run_source_revision WHERE run_id=? AND revision=(SELECT current_revision FROM prediction_run_source_head WHERE run_id=?)',[runId,runId]],
  ['SELECT piece_no AS pieceNo, text FROM prediction_run_source_piece WHERE run_id=? AND revision=(SELECT current_revision FROM prediction_run_source_head WHERE run_id=?) ORDER BY piece_no',[runId,runId]],
 ]);
 const head=headRows[0]??null;
 if(!head)return null;
 if(!head.runRow)throw failed('prediction_aux_corrupt',undefined,'source_without_run');
 if((head.boundRevision!==null&&head.boundRevision!==undefined)||(head.boundHash!==null&&head.boundHash!==undefined)){
  if(Number(head.boundRevision)!==Number(head.revision)||head.boundHash!==head.hash)throw failed('prediction_aux_corrupt',undefined,'source_binding');
 }
 const meta=metaRows[0]??null,pieces=pieceRows;
 if(!meta||pieces.length!==Number(meta.pieceCount))throw failed('prediction_aux_corrupt',undefined,'source_pieces');
 const text=pieces.map(piece=>piece.text).join('');
 let value;try{value=JSON.parse(text);}catch(error){throw failed('prediction_aux_corrupt',error,'source_json');}
 if(await sha256(value)!==head.hash)throw failed('prediction_aux_corrupt',undefined,'source_hash');
 return {value,revision:Number(head.revision),hash:head.hash};
}
// Writes the next revision of a run's sources. The first write creates revision 1; a rewrite may only add films or repeat equal entries (a changed entry of an existing film is a
// conflict: the original model input is preserved); an identical document writes nothing. The head moves by compare-and-swap in the same batch as the revision and its pieces.
// The statements of the NEXT revision of a run's sources (its pieces, the compare-and-swap on the head, the head), for composition into the run's own write: the revision and the run's binding commit together.
// `written:false` when the document equals the current revision (nothing to bind). The caller sets `sourceRevision` and `sourceHash` on the run it saves with these statements.
export async function planSource(db,authority,runId,source,{now=Date.now,create=false}={}){
 // `create`: the first write of a run this very request created: there is no head to read; the batch's own check (no head yet) fails closed if one exists.
 if(create)return {...(await sourcePlan(authority,runId,source,null,await sha256(source),now)),written:true};
 const current=await readSource(db,runId).catch(error=>{if(error.code==='prediction_aux_corrupt'&&error.detail==='source_without_run')return readSourceHead(db,runId);throw error;});
 const hash=await sha256(source);
 if(current&&current.hash===hash)return {written:false,revision:current.revision,hash,statements:[]};
 return {...(await sourcePlan(authority,runId,source,current,hash,now)),written:true};
}
async function readSourceHead(db,runId){
 // The run row is not saved yet (the first write of a start): the head can only be absent. A head without a run is reported as corruption by readSource.
 const head=await one(db,'SELECT current_revision AS revision, source_hash AS hash FROM prediction_run_source_head WHERE run_id=?',[runId]);
 if(!head)return null;
 throw failed('prediction_aux_corrupt',undefined,'source_without_run');
}
async function sourcePlan(authority,runId,source,current,hash,now){
 if(current)for(const [filmId,entry] of Object.entries(current.value))if(!(filmId in source)||(filmId in source&&await sha256(source[filmId])!==await sha256(entry)))throw failed('prediction_aux_conflict',undefined,'source_conflict');
 const text=JSON.stringify(source),pieces=splitPieces(text),revision=(current?.revision||0)+1,stamp=new Date(now()).toISOString();
 const statements=[markerGuard(authority),current?['UPDATE prediction_aux_cas SET ok=(SELECT count(*) FROM prediction_run_source_head WHERE run_id=? AND current_revision=?) WHERE id=1',[runId,current.revision]]:['UPDATE prediction_aux_cas SET ok=(SELECT count(*)=0 FROM prediction_run_source_head WHERE run_id=?) WHERE id=1',[runId]]];
 statements.push(['INSERT INTO prediction_run_source_revision (run_id, revision, source_hash, bytes, piece_count, created_at) VALUES (?,?,?,?,?,?)',[runId,revision,hash,encoder.encode(text).length,pieces.length,stamp]]);
 pieces.forEach((piece,index)=>statements.push(['INSERT INTO prediction_run_source_piece (run_id, revision, piece_no, text) VALUES (?,?,?,?)',[runId,revision,index,piece]]));
 statements.push(current?['UPDATE prediction_run_source_head SET current_revision=?, source_hash=? WHERE run_id=? AND current_revision=?',[revision,hash,runId,current.revision]]:['INSERT INTO prediction_run_source_head (run_id, current_revision, source_hash) VALUES (?,?,?)',[runId,revision,hash]]);
 return {revision,hash,statements};
}
export async function writeSource(db,authority,runId,source,{guard=null,writer=null,now=Date.now,extra=[],create=false}={}){
 // `create` (the start's first write of a run it just created): the batch itself proves there is no head yet, so the read is skipped; a refusal falls back to the full path below (a replay).
 if(create){
  try{return await writeSourceAt(db,authority,runId,source,null,{guard,writer,now,extra});}
  catch(error){if(error.code!=='prediction_aux_cas')throw error;}
 }
 const current=await readSource(db,runId);
 const hash=await sha256(source);
 if(current&&current.hash===hash)return {revision:current.revision,hash,written:false};
 return writeSourceAt(db,authority,runId,source,current,{guard,writer,now,extra},hash);
}
async function writeSourceAt(db,authority,runId,source,current,{guard,writer,now,extra},knownHash){
 const hash=knownHash||await sha256(source);
 if(current)for(const [filmId,entry] of Object.entries(current.value))if(filmId in source&&await sha256(source[filmId])!==await sha256(entry))throw failed('prediction_aux_conflict',undefined,'source_conflict');
 if(current)for(const filmId of Object.keys(current.value))if(!(filmId in source))throw failed('prediction_aux_conflict',undefined,'source_conflict');
 const text=JSON.stringify(source),pieces=splitPieces(text),revision=(current?.revision||0)+1,stamp=new Date(now()).toISOString();
 const statements=[...guardsFor(authority,guard,{fence:'run',writer}),current?['UPDATE prediction_aux_cas SET ok=(SELECT count(*) FROM prediction_run_source_head WHERE run_id=? AND current_revision=?) WHERE id=1',[runId,current.revision]]:['UPDATE prediction_aux_cas SET ok=(SELECT count(*)=0 FROM prediction_run_source_head WHERE run_id=?) WHERE id=1',[runId]]];
 statements.push(['INSERT INTO prediction_run_source_revision (run_id, revision, source_hash, bytes, piece_count, created_at) VALUES (?,?,?,?,?,?)',[runId,revision,hash,encoder.encode(text).length,pieces.length,stamp]]);
 pieces.forEach((piece,index)=>statements.push(['INSERT INTO prediction_run_source_piece (run_id, revision, piece_no, text) VALUES (?,?,?,?)',[runId,revision,index,piece]]));
 if(current)statements.push(['UPDATE prediction_run_source_head SET current_revision=?, source_hash=? WHERE run_id=? AND current_revision=?',[revision,hash,runId,current.revision]]);
 else statements.push(['INSERT INTO prediction_run_source_head (run_id, current_revision, source_hash) VALUES (?,?,?)',[runId,revision,hash]]);
 statements.push(...extra);
 await runBatch(db,statements);
 return {revision,hash,written:true};
}
export async function listSourceRevisions(db,runId){return many(db,'SELECT revision, source_hash AS hash, bytes, piece_count AS pieceCount, created_at AS createdAt FROM prediction_run_source_revision WHERE run_id=? ORDER BY revision',[runId]);}

// ---- Persisted manifest (decision 5): create-only, exact payload digest, per-piece digests, segment index for bounded part reads. ----
const SENTINEL={films:'@@films',profile:'@@profile',contract:'@@contract'};
// The answer is cut into segments (envelope with placeholders at the keys' own positions, profile, contract, one per film) and the concatenation is cut into byte-capped pieces; `partIndex`
// records each segment's character range, so a part read fetches only the pieces that cover it.
export async function buildManifestRecord(runId,answer){
 const films=Array.isArray(answer.films)?answer.films:[];
 const envelope={...answer,films:SENTINEL.films,profile:SENTINEL.profile,contract:SENTINEL.contract};
 const segments=[{k:'envelope',text:JSON.stringify(envelope)},{k:'profile',text:JSON.stringify(answer.profile)},{k:'contract',text:JSON.stringify(answer.contract)},...films.map(film=>({k:'film',filmId:film.filmId,text:JSON.stringify(film)}))];
 let offset=0;const index=[];
 for(const segment of segments){index.push({k:segment.k,...(segment.filmId!==undefined?{filmId:segment.filmId}:{}),s:offset,e:offset+segment.text.length});offset+=segment.text.length;}
 const body=segments.map(segment=>segment.text).join(''),pieces=splitPieces(body);
 const digests=await Promise.all(pieces.map(piece=>sha256(piece)));
 const lengths=pieces.map(piece=>piece.length);
 return {runId,manifestHash:String(answer.manifestHash),payloadDigest:await sha256(JSON.stringify(answer)),bytes:encoder.encode(JSON.stringify(answer)).length,pieces,digests,partIndex:JSON.stringify({segments:index,pieces:lengths,meta:{runId,epoch:Number.isInteger(answer.lease?.epoch)?answer.lease.epoch:null}}),selectedIds:JSON.stringify(films.map(film=>film.filmId)),drainedJson:answer.drained===undefined?null:JSON.stringify(answer.drained)};
}
export function manifestStatements(record,stamp){
 return [
  ['INSERT INTO prediction_run_manifest (run_id, manifest_hash, payload_digest, selected_ids, drained_json, bytes, piece_count, part_index, created_at) VALUES (?,?,?,?,?,?,?,?,?)',[record.runId,record.manifestHash,record.payloadDigest,record.selectedIds,record.drainedJson,record.bytes,record.pieces.length,record.partIndex,stamp]],
  ...record.pieces.map((piece,index)=>['INSERT INTO prediction_run_manifest_piece (run_id, piece_no, piece_digest, text) VALUES (?,?,?,?)',[record.runId,index,record.digests[index],piece]]),
 ];
}
export async function existingManifestDigest(db,runId){return (await one(db,'SELECT payload_digest AS digest, manifest_hash AS manifestHash FROM prediction_run_manifest WHERE run_id=?',[runId]))??null;}
// Create-only: the same digest is a no-op (a replay), another digest is a conflict, never an overwrite. `extra` statements (the readiness edit of a deferred start) commit in the SAME batch,
// after the manifest rows and under the same guards, so "ready" is never declared before a durable manifest.
export async function writeManifest(db,authority,runId,answer,{guard=null,writer=null,now=Date.now,extra=[],prep=false}={}){
 const record=await buildManifestRecord(runId,answer);
 const guards=()=>guardsFor(authority,guard,{fence:'run',run:true,writer,prep});
 // Insert first: the primary key refuses a second manifest of the run, so the common case costs one batch; only a refusal reads the stored digest to tell a replay (same bytes: a no-op, the
 // extra statements still commit under the guards) from a conflict (other bytes: never an overwrite).
 try{await runBatch(db,[...guards(),...manifestStatements(record,new Date(now()).toISOString()),...extra]);return {written:true,payloadDigest:record.payloadDigest};}
 catch(error){
  if(error.code!=='prediction_aux_cas')throw error;
  const present=await existingManifestDigest(db,runId);
  if(!present)throw error;
  if(present.digest!==record.payloadDigest)throw failed('prediction_aux_conflict',undefined,'manifest_conflict');
  // A replay is accepted only when the STORED BYTES (every piece against its digest, then the whole payload against its digest) are the same response: metadata alone proves nothing.
  const stored=await readManifest(db,runId);
  if(!stored||await sha256(JSON.stringify(stored))!==record.payloadDigest)throw failed('prediction_aux_corrupt',undefined,'manifest_replay');
  if(extra.length)await runBatch(db,[...guards(),...extra]);
  return {written:false,payloadDigest:record.payloadDigest};
 }
}
const MANIFEST_ROW_SQL='SELECT manifest_hash AS manifestHash, payload_digest AS payloadDigest, selected_ids AS selectedIds, drained_json AS drainedJson, bytes, piece_count AS pieceCount, part_index AS partIndex FROM prediction_run_manifest WHERE run_id=?';
function parseIndex(row){
 let index;try{index=JSON.parse(row.partIndex);}catch(error){throw failed('prediction_aux_corrupt',error,'manifest_index');}
 if(!index||!Array.isArray(index.segments)||!Array.isArray(index.pieces)||index.pieces.length!==Number(row.pieceCount))throw failed('prediction_aux_corrupt',undefined,'manifest_index');
 return index;
}
async function loadIndex(db,runId){
 const row=await one(db,MANIFEST_ROW_SQL,[runId]);
 if(!row)return null;
 return {row,index:parseIndex(row)};
}
// The pieces that cover ONE segment of the stored part index, chosen INSIDE the same statement batch from the row's own index (cumulative piece lengths against the segment's character range): the part
// costs one round trip for the row and its covering pieces, and reads nothing of any other run or segment.
const COVERING_PIECES_SQL="SELECT mp.piece_no AS pieceNo, mp.piece_digest AS digest, mp.text AS text FROM prediction_run_manifest_piece mp JOIN (SELECT CAST(p.key AS INTEGER) AS no, CAST(p.value AS INTEGER) AS len, SUM(CAST(p.value AS INTEGER)) OVER (ORDER BY p.key) AS cum FROM prediction_run_manifest m, json_each(json_extract(m.part_index,'$.pieces')) p WHERE m.run_id=?) pcs ON pcs.no=mp.piece_no JOIN (SELECT CAST(json_extract(s.value,'$.s') AS INTEGER) AS s0, CAST(json_extract(s.value,'$.e') AS INTEGER) AS e0 FROM prediction_run_manifest m2, json_each(json_extract(m2.part_index,'$.segments')) s WHERE m2.run_id=? AND json_extract(s.value,'$.k')=? AND (? IS NULL OR json_extract(s.value,'$.filmId')=?) LIMIT 1) seg ON pcs.cum>seg.s0 AND pcs.cum-pcs.len<seg.e0 WHERE mp.run_id=? ORDER BY mp.piece_no";
async function readRange(db,runId,index,start,end,preloaded=null){
 // The pieces that cover [start,end): each is verified against its own digest before a byte of it is used.
 let at=0,first=-1,last=-1;
 for(let i=0;i<index.pieces.length;i++){const s=at,e=at+index.pieces[i];at=e;if(e>start&&s<end){if(first<0)first=i;last=i;}}
 if(first<0)return '';
 const rows=preloaded||await many(db,'SELECT piece_no AS pieceNo, piece_digest AS digest, text FROM prediction_run_manifest_piece WHERE run_id=? AND piece_no BETWEEN ? AND ? ORDER BY piece_no',[runId,first,last]);
 if(rows.length!==last-first+1)throw failed('prediction_aux_corrupt',undefined,'manifest_piece_missing');
 let text='';
 for(const row of rows){if(await sha256(row.text)!==row.digest||row.text.length!==index.pieces[row.pieceNo])throw failed('prediction_aux_corrupt',undefined,'manifest_piece_digest');text+=row.text;}
 let base=0;for(let i=0;i<first;i++)base+=index.pieces[i];
 return text.slice(start-base,end-base);
}
// One bounded part: 'envelope' (with the film id list, from the index), 'profile', 'contract' or one 'film'. Nothing but the covering pieces of this run is read.
export async function readManifestPart(db,runId,part,filmId){
 const [rows,pieces]=await readBatch(db,[[MANIFEST_ROW_SQL,[runId]],[COVERING_PIECES_SQL,[runId,runId,part,part==='film'?String(filmId):null,part==='film'?String(filmId):null,runId]]]);
 const row=rows[0]??null;
 if(!row)return null;
 const index=parseIndex(row);
 const filmIds=JSON.parse(row.selectedIds);
 if(part==='envelope'){
  const seg=index.segments.find(item=>item.k==='envelope');
  let envelope;try{envelope=JSON.parse(await readRange(db,runId,index,seg.s,seg.e,pieces));}catch(error){if(error.code)throw error;throw failed('prediction_aux_corrupt',error,'manifest_envelope');}
  delete envelope.films;delete envelope.profile;delete envelope.contract;
  return {manifestHash:row.manifestHash,meta:index.meta||null,envelope,filmIds,selectedIds:filmIds,drained:row.drainedJson?JSON.parse(row.drainedJson):undefined};
 }
 const seg=part==='film'?index.segments.find(item=>item.k==='film'&&item.filmId===filmId):index.segments.find(item=>item.k===part);
 if(!seg)return undefined;
 let value;try{value=JSON.parse(await readRange(db,runId,index,seg.s,seg.e,pieces));}catch(error){if(error.code)throw error;throw failed('prediction_aux_corrupt',error,'manifest_part');}
 return {manifestHash:row.manifestHash,meta:index.meta||null,value,filmIds};
}
// The whole answer (a same-key replay, the importer's verification): reassembled in the original key order and checked against the exact payload digest.
export async function readManifest(db,runId){
 const [rows,pieces]=await readBatch(db,[[MANIFEST_ROW_SQL,[runId]],['SELECT piece_no AS pieceNo, piece_digest AS digest, text FROM prediction_run_manifest_piece WHERE run_id=? ORDER BY piece_no',[runId]]]);
 const row=rows[0]??null;
 if(!row)return null;
 const index=parseIndex(row);
 const total=index.segments.length?index.segments[index.segments.length-1].e:0;
 const text=await readRange(db,runId,index,0,total,pieces);
 const take=seg=>{try{return JSON.parse(text.slice(seg.s,seg.e));}catch(error){throw failed('prediction_aux_corrupt',error,'manifest_segment');}};
 const answer=take(index.segments.find(item=>item.k==='envelope'));
 answer.films=index.segments.filter(item=>item.k==='film').map(take);
 answer.profile=take(index.segments.find(item=>item.k==='profile'));
 answer.contract=take(index.segments.find(item=>item.k==='contract'));
 if(await sha256(JSON.stringify(answer))!==row.payloadDigest)throw failed('prediction_aux_corrupt',undefined,'manifest_payload_digest');
 return answer;
}

// ---- Event outbox (decisions 6 and 7). One row per delivery record; the journal stays R2. ----
export const outboxKey=(kind,identity)=>kind+':'+identity;
const OUTBOX_COLUMNS='event_key AS eventKey, kind, event_id AS eventId, at, journal_key AS journalKey, run_id AS runId, state, attempts, since, last_attempt_at AS lastAttemptAt, settled_at AS settledAt, payload_digest AS payloadDigest, payload_compacted AS payloadCompacted, event_json AS eventJson';
export function parseOutboxRow(row){
 if(!row)return null;
 let event=null;if(row.eventJson){try{event=JSON.parse(row.eventJson);}catch(error){throw failed('prediction_aux_corrupt',error,'outbox_event');}}
 return {eventKey:row.eventKey,kind:row.kind,eventId:row.eventId,at:row.at,journalKey:row.journalKey,runId:row.runId||null,state:row.state,attempts:Number(row.attempts),since:row.since,lastAttemptAt:row.lastAttemptAt||null,settledAt:row.settledAt||null,payloadDigest:row.payloadDigest,compacted:Number(row.payloadCompacted)===1,event};
}
export async function readOutboxRow(db,eventKey){return parseOutboxRow(await one(db,'SELECT '+OUTBOX_COLUMNS+' FROM prediction_event_outbox WHERE event_key=?',[eventKey]));}
// Inserts one record, `ON CONFLICT(event_key) DO NOTHING` on the identity (never OR IGNORE: that would also swallow the cap's CHECK inside the counter trigger): a replay (also at capacity, also after compaction) is a no-op that returns the stored row, with the first `at` and journal key.
// `guard` is the lease fence of a run-owned record (a stop row); a lease-free record (a skipped request) carries only the marker guard. A skipped row beyond the cap of 256 active pending aborts
// that one insert (the counter CHECK); the refusal is counted, bounded, and the caller keeps its original answer.
export async function admitOutbox(db,authority,{kind,identity,event,journalKey,runId=null,guard=null,writer=null,fence=null,now=Date.now}){
 const eventKey=outboxKey(kind,identity);
 // No read first: `ON CONFLICT DO NOTHING` on the identity inserts nothing (and fires no counter trigger) for an existing record, so a replay, also at capacity, costs the same one batch.
 const stamp=new Date(now()).toISOString();
 const at=typeof event?.at==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(event.at)&&event.at.length===24?event.at:stamp;
 const text=JSON.stringify(event),digest=await sha256(event);
 const statements=[...guardsFor(authority,guard,{fence:outboxFence({fence,writer}),writer}),['INSERT INTO prediction_event_outbox (event_key, kind, event_id, at, journal_key, run_id, state, attempts, since, last_attempt_at, settled_at, payload_digest, payload_compacted, event_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING',[eventKey,kind,String(event.id),at,journalKey,runId,'pending',0,stamp,null,null,digest,0,text]]];
 try{await runBatch(db,statements);}
 catch(error){
  if(error.code==='prediction_aux_cas'&&kind==='skipped'&&await countsAsCapRefusal(db,eventKey)){await noteCapRefusal(db,authority,stamp);return {admitted:false,refused:'cap',row:null};}
  throw error;
 }
 // `admitted` is a best-effort signal (the stored row carries this call's own stamp); the row itself is the truth, and a concurrent identical identity resolves in the database to ONE row.
 const row=await readOutboxRow(db,eventKey);
 return {admitted:!!row&&row.since===stamp&&row.payloadDigest===digest,row};
}
async function countsAsCapRefusal(db,eventKey){
 const counter=await one(db,"SELECT active_pending AS n FROM prediction_event_outbox_counter WHERE kind='skipped'");
 return Number(counter?.n)>=AUX_LIMITS.skippedCap&&!await one(db,'SELECT 1 AS present FROM prediction_event_outbox WHERE event_key=?',[eventKey]);
}
async function noteCapRefusal(db,authority,stamp){
 try{await runBatch(db,[markerGuard(authority),['UPDATE prediction_event_outbox_diag SET cap_refusals=cap_refusals+1, last_refusal_at=? WHERE id=1',[stamp]]]);}catch{/* best effort: a refusal count never changes an answer */}
}
// The statements that register a terminal Event, for composition into the run's own transition (one batch: the run is never terminal without its durable outbox identity). Insert-or-nothing on the identity.
export async function outboxAdmission(authority,{kind,identity,event,journalKey,runId=null,writer=null,now=Date.now}){
 const eventKey=outboxKey(kind,identity),stamp=new Date(now()).toISOString();
 const at=typeof event?.at==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(event.at)&&event.at.length===24?event.at:stamp;
 return {eventKey,statements:[...guardsFor(authority,null,{fence:writer?'writer':'target',writer}),['INSERT INTO prediction_event_outbox (event_key, kind, event_id, at, journal_key, run_id, state, attempts, since, last_attempt_at, settled_at, payload_digest, payload_compacted, event_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING',[eventKey,kind,String(event.id),at,journalKey,runId,'pending',0,stamp,null,null,await sha256(event),0,JSON.stringify(event)]]]};
}
// The target run must not have been recovered by a successor in the meantime: a compare-and-swap on the run's OWN row, in the same batch as its terminal write.
export const runNotSupersededGuard=runId=>["UPDATE prediction_aux_cas SET ok=(SELECT count(*)=0 FROM prediction_run WHERE run_id=? AND json_extract(document_json,'$.recoveredByRunId') IS NOT NULL) WHERE id=1",[String(runId)]];
// Settles a record after the journal proved the write (or a recovering run superseded it). Monotone and idempotent: a settled row stays as it is.
export async function settleOutbox(db,authority,eventKey,state,{guard=null,writer=null,fence=null,supersededRun=null,now=Date.now}={}){
 if(state!=='delivered'&&state!=='superseded')throw failed('prediction_aux_conflict',undefined,'settle_state');
 const stamp=new Date(now()).toISOString();
 // A supersession is decided against the TARGET run's own state in the same snapshot (it carries `recoveredByRunId`), never against an earlier unfenced read.
 const target=state==='superseded'?" AND EXISTS (SELECT 1 FROM prediction_run WHERE run_id=? AND json_extract(document_json,'$.recoveredByRunId') IS NOT NULL)":'';
 if(state==='superseded'&&!supersededRun)throw failed('prediction_aux_conflict',undefined,'supersession_needs_target');
 await runBatch(db,[...guardsFor(authority,guard,{fence:outboxFence({fence,writer}),writer}),["UPDATE prediction_event_outbox SET state=?, settled_at=?, last_attempt_at=COALESCE(last_attempt_at,?) WHERE event_key=? AND state IN ('pending','quarantined')"+target,[state,stamp,stamp,eventKey,...(target?[supersededRun]:[])]]]);
}
// A failed delivery: attempts + 1 on a pending row (target compare-and-swap on the attempts read), quarantine at the 8th.
export async function failOutbox(db,authority,row,{guard=null,writer=null,fence=null,now=Date.now}={}){
 const attempts=row.attempts+1,stamp=new Date(now()).toISOString(),state=attempts>=AUX_LIMITS.quarantineAfter?'quarantined':'pending';
 await runBatch(db,[...guardsFor(authority,guard,{fence:outboxFence({fence,writer}),writer}),["UPDATE prediction_event_outbox SET attempts=?, state=?, last_attempt_at=? WHERE event_key=? AND state='pending' AND attempts=?",[attempts,state,stamp,row.eventKey,row.attempts]]]);
 return state;
}
// The drain order: the records of the latest run first, then pending oldest-first by (since, key); quarantined rows never take a slot. Bounded by an index, never a listing of history.
export async function pendingOutbox(db,{runId=null,limit=AUX_LIMITS.drainLimit}={}){
 const first=runId?await many(db,"SELECT "+OUTBOX_COLUMNS+" FROM prediction_event_outbox WHERE run_id=? AND state='pending' ORDER BY event_key LIMIT ?",[runId,limit]):[];
 const rest=await many(db,"SELECT "+OUTBOX_COLUMNS+" FROM prediction_event_outbox WHERE state='pending'"+(first.length?" AND event_key NOT IN ("+first.map(()=>'?').join(',')+")":'')+" ORDER BY since, event_key LIMIT ?",[...first.map(row=>row.eventKey),Math.max(0,limit-first.length)]);
 return [...first,...rest].slice(0,limit).map(parseOutboxRow);
}
// Bounded whatever the history holds: four counter rows, two single-row counters and one indexed row; never a walk of the retained outbox.
// The drain's reads in one batch: the latest run's pending rows, the oldest pending rows, and the settled rows whose payload is old enough to compact. Deduplicated, ordered and bounded by indexes.
export async function drainSnapshot(db,{runId=null,limit=AUX_LIMITS.drainLimit,now=Date.now}={}){
 const cutoff=new Date(now()-AUX_LIMITS.compactMs).toISOString();
 const [first,rest,compactable]=await readBatch(db,[
  runId?["SELECT "+OUTBOX_COLUMNS+" FROM prediction_event_outbox WHERE run_id=? AND state='pending' ORDER BY event_key LIMIT ?",[runId,limit]]:["SELECT "+OUTBOX_COLUMNS+" FROM prediction_event_outbox WHERE 0",[]],
  ["SELECT "+OUTBOX_COLUMNS+" FROM prediction_event_outbox WHERE state='pending' ORDER BY since, event_key LIMIT ?",[limit+4]],
  ["SELECT event_key AS eventKey FROM prediction_event_outbox WHERE payload_compacted=0 AND settled_at IS NOT NULL AND settled_at<? ORDER BY settled_at, event_key LIMIT ?",[cutoff,AUX_LIMITS.compactLimit]],
 ]);
 const seen=new Set(),pending=[];
 for(const row of [...first,...rest]){if(seen.has(row.eventKey))continue;seen.add(row.eventKey);pending.push(parseOutboxRow(row));if(pending.length>=limit)break;}
 return {pending,compactable:compactable.map(row=>row.eventKey)};
}
export async function outboxStatus(db){
 const [counts,diag,skipped,oldest]=await Promise.all([many(db,'SELECT state, n FROM prediction_event_outbox_state_count'),one(db,'SELECT cap_refusals AS capRefusals, last_refusal_at AS lastRefusalAt FROM prediction_event_outbox_diag WHERE id=1'),one(db,"SELECT active_pending AS n FROM prediction_event_outbox_counter WHERE kind='skipped'"),one(db,"SELECT since FROM prediction_event_outbox WHERE state='pending' ORDER BY since, event_key LIMIT 1")]);
 return {oldestPendingSince:oldest?.since||null,states:Object.fromEntries(counts.map(row=>[row.state,Number(row.n)])),skippedActivePending:Number(skipped?.n||0),skippedCap:AUX_LIMITS.skippedCap,capRefusals:Number(diag?.capRefusals||0),lastCapRefusalAt:diag?.lastRefusalAt||null};
}
// Compaction (decision 8): the payload of a record settled for 14 days or more, by an indexed bounded scan on settled_at. Identity, original `at`, journal key and digest stay; the record is never rebuilt.
export async function compactSettled(db,authority,{now=Date.now,limit=AUX_LIMITS.compactLimit,keys=null}={}){
 const cutoff=new Date(now()-AUX_LIMITS.compactMs).toISOString();
 const rows=keys?keys.slice(0,limit).map(eventKey=>({eventKey})):await many(db,"SELECT event_key AS eventKey FROM prediction_event_outbox WHERE payload_compacted=0 AND settled_at IS NOT NULL AND settled_at<? ORDER BY settled_at, event_key LIMIT ?",[cutoff,limit]);
 if(!rows.length)return 0;
 await runBatch(db,[markerGuard(authority),...rows.map(row=>["UPDATE prediction_event_outbox SET payload_compacted=1, event_json=NULL WHERE event_key=? AND state IN ('delivered','superseded') AND payload_compacted=0",[row.eventKey]])]);
 return rows.length;
}
