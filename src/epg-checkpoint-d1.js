// ADR 0185 (Accepted), AIR-550 stage 2. The EPG run checkpoint (`sync.json`) and the watchlist ingest status (`watchlist-ingest.json`) in D1
// (schema v30, migrations/0030_epg_checkpoint_authority.sql). DORMANT: nothing activates it. The Worker routes the two keys here only while the
// marker is `d1`; with the tables absent or the marker `r2` the R2 objects serve exactly as before. This module is storage only: it never reads
// or writes R2, never decides a stage, never builds an event. The Worker bundle wraps it as `EpgCheckpointD1`; tests load it as an ES module.
//
// Authority (one marker row, epg_checkpoint_authority, independent of every other domain):
//  - `legacy` (the R2 objects serve) only when the database proves it is pre-migration: the tables are absent AND schema_contract answers a
//    version below 30. A missing binding, an unreadable schema_contract or version 30 without the tables is `closed`. The one exception is
//    the explicit local stand-in `EPG_CHECKPOINT_DB_OPTIONAL=standin`, never set in production.
//  - mode r2 -> `r2`: the R2 objects serve (writes `held` is the import fence); mode d1 -> `d1`: the rows serve and R2 is never read or written.
//  - any other state with the tables present, or a storage error -> `closed`. Never R2.
//
// Every checkpoint write is ONE D1 batch: authority fence (mode d1, writes open, the generation read), the EPG mode revision, the step lease (holder,
// mode revision, not released, expiry beyond `leaseBound`) INSIDE the batch, then a compare-and-swap on (run_id, revision) followed by a fence
// statement that aborts the batch when it matched nothing. A write with no step is refused. `completeRun` is the only way to `complete`.

const FENCE='UPDATE epg_checkpoint_cas SET ok=changes() WHERE id=1';
const TABLES=['epg_checkpoint_authority','epg_checkpoint_cas','epg_checkpoint_run','epg_checkpoint_body','epg_checkpoint_film','epg_checkpoint_receipt','epg_ingest_status'];
export const LIMITS={statementChars:90000,bodyChars:900000,filmChars:90000,stageBatch:50,receipts:16,failureCap:1000,gcBatch:200,gcPasses:5};
// The marker read also proves the singleton fence row exists: without it the domain is closed.
const MARKER_SQL='SELECT mode, generation, writes, (SELECT COUNT(*) FROM epg_checkpoint_cas WHERE id=1) AS cas FROM epg_checkpoint_authority WHERE id=1';
// ADR 0185. EVERY guard of a batch is an upsert of the fence row, never an UPDATE of it: an UPDATE that matches no row (the row was deleted by a partial restore or by
// corruption) passes silently, while the upsert re-creates the row and evaluates `CHECK (ok = 1)` on both paths, so a failing condition aborts the batch whatever the table holds.
const GUARD=expression=>'INSERT INTO epg_checkpoint_cas (id, ok) SELECT 1, '+expression+' WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
const RUN_SQL='SELECT run_id, run_key, started_at, stage, seal_phase, queue_attempted, completed_at, has_error, revision, body_chunks, body_chars, body_sha256, watchlist_present, film_count, film_list_sha256 FROM epg_checkpoint_run WHERE id=1';
const STAGES=['metadata','epg','seal','complete'];
// The state of a loaded or created run that the next save compares against. Keyed by the run object the caller holds.
const bases=new WeakMap();

function database(source){return source&&typeof source.prepare==='function'?source:source?.DB;}
// The D1 binding of an env or of a binding, for callers (the Worker's marker cache) that must not name `env.DB` themselves.
export function bindingOf(source){const db=database(source);return db&&typeof db.prepare==='function'?db:null;}
async function one(db,sql,params=[]){return (await db.prepare(sql).bind(...params).first())??null;}
async function many(db,sql,params=[]){return (await db.prepare(sql).bind(...params).all()).results||[];}
async function sha256(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
const iso=ms=>new Date(ms).toISOString();

// -> {state:'legacy'} | {state:'r2'|'d1',writes,generation} | {state:'closed'}
export async function readAuthority(source){
 const db=database(source);
 const standin=source?.EPG_CHECKPOINT_DB_OPTIONAL==='standin';
 if(!db||typeof db.prepare!=='function')return standin?{state:'legacy'}:{state:'closed'};
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('epg_checkpoint_authority','epg_checkpoint_cas','epg_checkpoint_run','epg_checkpoint_body','epg_checkpoint_film','epg_checkpoint_receipt','epg_ingest_status')")).map(row=>row.name);}
 catch{return {state:'closed'};}
 if(!names.length){
  let version=null;
  try{version=Number((await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version);}catch{return standin?{state:'legacy'}:{state:'closed'};}
  return Number.isFinite(version)&&version<30?{state:'legacy'}:(standin?{state:'legacy'}:{state:'closed'});
 }
 if(TABLES.some(name=>!names.includes(name)))return {state:'closed'};
 let row;
 try{row=await one(db,MARKER_SQL);}catch{return {state:'closed'};}
 if(!row||Number(row.cas)!==1||(row.mode!=='r2'&&row.mode!=='d1')||(row.writes!=='open'&&row.writes!=='held')||!Number.isInteger(Number(row.generation)))return {state:'closed'};
 return {state:row.mode,writes:row.writes,generation:Number(row.generation)};
}

// ---- reading -------------------------------------------------------------------------------------------------------------
function filmRowsOk(rows,count){
 if(rows.length!==count)return false;
 const ids=new Set();
 for(let index=0;index<rows.length;index++){
  if(Number(rows[index].ordinal)!==index)return false;
  if(typeof rows[index].film_id!=='string'||!rows[index].film_id||ids.has(rows[index].film_id))return false;
  ids.add(rows[index].film_id);
 }
 return true;
}
async function listDigest(rows){return sha256(rows.map(row=>row.ordinal+'\t'+row.film_id+'\t'+row.body_sha256+'\n').join(''));}
function chunksOf(text){
 const out=[];let at=0;
 while(at<text.length){
  let end=Math.min(text.length,at+LIMITS.statementChars);
  // Never split a surrogate pair: a lone half is not valid text and would not round-trip.
  if(end<text.length){const code=text.charCodeAt(end-1);if(code>=0xD800&&code<=0xDBFF)end--;}
  out.push(text.slice(at,end));at=end;
 }
 return out;
}

// The current run, assembled and verified. -> {ok:true,run:null} | {ok:true,run,generation} | {ok:false,reason:'closed'|'malformed'|'unavailable'}
// One read batch, so the marker, the run row, the body and the film rows are one snapshot.
export async function loadRun(source){
 const db=database(source);
 if(!db||typeof db.batch!=='function')return {ok:false,reason:'unavailable'};
 let parts;
 try{parts=await db.batch([MARKER_SQL,RUN_SQL,'SELECT seq, text FROM epg_checkpoint_body ORDER BY seq','SELECT run_id, ordinal, film_id, body, body_sha256 FROM epg_checkpoint_film WHERE run_id=(SELECT run_id FROM epg_checkpoint_run WHERE id=1) ORDER BY ordinal'].map(sql=>db.prepare(sql).bind()));}
 catch{return {ok:false,reason:'unavailable'};}
 const [marker,run,bodyRows,filmRows]=parts.map(part=>part.results||[]);
 if(!marker[0]||marker[0].mode!=='d1'||Number(marker[0].cas)!==1)return {ok:false,reason:'closed'};
 const generation=Number(marker[0].generation);
 // Film rows of no run are garbage of an interrupted creation and are ignored; a body with no run row is not.
 if(!run[0]){return bodyRows.length?{ok:false,reason:'malformed'}:{ok:true,run:null,generation};}
 const row=run[0];
 try{
  if(bodyRows.length!==Number(row.body_chunks)||bodyRows.some((chunk,index)=>Number(chunk.seq)!==index))return {ok:false,reason:'malformed'};
  const text=bodyRows.map(chunk=>chunk.text).join('');
  if(text.length!==Number(row.body_chars)||await sha256(text)!==row.body_sha256)return {ok:false,reason:'malformed'};
  const body=JSON.parse(text);
  if(!body||typeof body!=='object'||Array.isArray(body)||'watchlist' in body)return {ok:false,reason:'malformed'};
  if(body.runId!==row.run_id||body.stage!==row.stage||(body.startedAt??null)!==row.started_at||(body.runKey??null)!==(row.run_key??null)||(row.stage==='seal'?body.seal?.phase:null)!==(row.seal_phase??null)||(body.error?1:0)!==Number(row.has_error))return {ok:false,reason:'malformed'};
  // The completion time is stored twice (the typed column and the body) and must be the same value: a complete run whose body says otherwise is not served.
  if(row.stage==='complete'&&body.completedAt!==row.completed_at)return {ok:false,reason:'malformed'};
  const present=Number(row.watchlist_present)===1;
  let films=null;
  if(present){
   if(!filmRowsOk(filmRows,Number(row.film_count))||await listDigest(filmRows)!==row.film_list_sha256)return {ok:false,reason:'malformed'};
   films=[];
   for(const film of filmRows){if(await sha256(film.body)!==film.body_sha256)return {ok:false,reason:'malformed'};films.push(JSON.parse(film.body));}
  }else if(filmRows.length)return {ok:false,reason:'malformed'};
  const loaded=present?{...body,watchlist:films}:body;
  bases.set(loaded,{runId:row.run_id,runKey:row.run_key??null,startedAt:row.started_at,stage:row.stage,revision:Number(row.revision),completedAt:row.completed_at??null,queueAttempted:Number(row.queue_attempted)===1,generation,present,count:present?films.length:null,ids:present?filmRows.map(film=>film.film_id):[],digests:present?filmRows.map(film=>film.body_sha256):[],listSha:row.film_list_sha256??null});
  return {ok:true,run:loaded,generation};
 }catch{return {ok:false,reason:'malformed'};}
}
export function baseOf(run){return bases.get(run)||null;}

// ---- the fenced batch ----------------------------------------------------------------------------------------------------
function stepContext(ctx){
 const step=ctx?.step,fence=ctx?.fence;
 if(!step||typeof step.holder!=='string'||!step.holder||fence==null||typeof ctx.leaseBound!=='string'||!ctx.leaseBound)return null;
 if(!(fence.revision===null||(Number.isInteger(fence.revision)&&fence.revision>=1)))return null;
 return {step,fence,leaseBound:ctx.leaseBound};
}
function guards(sc,generation){
 const rev=sc.fence.revision;
 return [
  [GUARD("(SELECT COUNT(*) FROM epg_checkpoint_authority WHERE id=1 AND mode='d1' AND writes='open' AND generation=?)"),[generation]],
  [GUARD("CASE WHEN (SELECT COUNT(*) FROM epg_orchestration_document WHERE key='mode' AND (? IS NULL OR revision=?))=? THEN 1 ELSE 0 END"),[rev,rev,rev===null?0:1]],
  [GUARD("CASE WHEN (SELECT COUNT(*) FROM epg_orchestration_document WHERE key='lease' AND json_extract(body,'$.holder')=? AND json_extract(body,'$.modeRevision') IS ? AND COALESCE(json_extract(body,'$.released'),0)=0 AND json_extract(body,'$.expiresAt')>?)=1 THEN 1 ELSE 0 END"),[sc.step.holder,sc.step.modeRevision??null,sc.leaseBound]],
 ];
}
async function fenced(db,statements){
 if(typeof db.batch!=='function')return 'unavailable';
 if(statements.some(([,params])=>params.length>100))return 'unavailable';
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));return 'ok';}
 catch(error){
  const message=String(error?.message||error);
  if(/CHECK constraint failed|UNIQUE constraint failed|epg_checkpoint_regress|PRIMARY KEY/i.test(message))return 'conflict';
  return 'unavailable';
 }
}

// What an unknown outcome was, from the write receipt and never from the latest snapshot alone (ADR 0185 decision 6).
// -> 'applied' | 'not_applied' | 'superseded' | 'indeterminate'
export async function classifyWrite(source,{writeId,expectedRevision}){
 const db=database(source);
 if(!db||typeof writeId!=='string'||!Number.isInteger(expectedRevision)||expectedRevision<0)return 'indeterminate';
 try{
  if(await one(db,'SELECT revision FROM epg_checkpoint_receipt WHERE write_id=?',[writeId]))return 'applied';
  const row=await one(db,'SELECT revision FROM epg_checkpoint_run WHERE id=1');
  const current=row?Number(row.revision):0;
  if(current===expectedRevision)return 'not_applied';
  if(current<expectedRevision||current-expectedRevision>LIMITS.receipts)return 'indeterminate';
  const seen=await one(db,'SELECT COUNT(*) AS n FROM epg_checkpoint_receipt WHERE revision>? AND revision<=?',[expectedRevision,current]);
  return Number(seen?.n)===current-expectedRevision?'superseded':'indeterminate';
 }catch{return 'indeterminate';}
}

// The run without its watchlist: body text, chunks, typed columns.
async function bodyOf(run){
 const {watchlist,...rest}=run;
 const text=JSON.stringify(rest);
 if(text.length>LIMITS.bodyChars)return null;
 return {rest,text,chunks:chunksOf(text),sha:await sha256(text)};
}
async function filmsOf(list){
 if(!Array.isArray(list))return null;
 const films=[],ids=new Set();
 for(let ordinal=0;ordinal<list.length;ordinal++){
  const film=list[ordinal];
  if(!film||typeof film!=='object'||film.id==null||String(film.id)===''||ids.has(String(film.id)))return null;
  ids.add(String(film.id));
  const text=JSON.stringify(film);
  if(text.length>LIMITS.filmChars)return {budget:true};
  films.push({ordinal,id:String(film.id),text,sha:await sha256(text)});
 }
 return {films,listSha:await listDigest(films.map(film=>({ordinal:film.ordinal,film_id:film.id,body_sha256:film.sha})))};
}
const writeIdOf=()=>crypto.randomUUID();
function bodyStatements(body,revision,writeId,runId,now){
 const out=[['DELETE FROM epg_checkpoint_body',[]]];
 body.chunks.forEach((text,seq)=>out.push(['INSERT INTO epg_checkpoint_body (seq, text) VALUES (?,?)',[seq,text]]));
 out.push(['INSERT INTO epg_checkpoint_receipt (write_id, run_id, revision, body_sha256, applied_at) VALUES (?,?,?,?,?)',[writeId,runId,revision,body.sha,now]]);
 out.push(['DELETE FROM epg_checkpoint_receipt WHERE revision<=?',[revision-LIMITS.receipts]]);
 return out;
}

// The generic save of the run the caller loaded or created. It never completes a run, never changes the membership of the watchlist and never
// changes the identity of the run. -> {ok:true,revision,writeId} | {ok:false,reason}
export async function saveRun(source,run,ctx){
 const db=database(source);
 const base=run&&typeof run==='object'?bases.get(run):null;
 if(!db)return {ok:false,reason:'unavailable'};
 const sc=stepContext(ctx);
 if(!sc)return {ok:false,reason:'unfenced'};
 if(!base)return {ok:false,reason:'unbased'};
 if(run.runId!==base.runId||(run.startedAt??null)!==base.startedAt||(run.runKey??null)!==base.runKey)return {ok:false,reason:'identity'};
 if(run.stage==='complete'&&base.stage!=='complete')return {ok:false,reason:'complete_route'};
 if(base.stage==='complete'&&run.completedAt!==base.completedAt)return {ok:false,reason:'completion_time'};
 if(!STAGES.includes(run.stage)||(run.stage==='seal'&&typeof run.seal?.phase!=='string'))return {ok:false,reason:'shape'};
 const body=await bodyOf(run);
 if(!body)return {ok:false,reason:'budget'};
 let films=null;
 if(base.present){
  films=await filmsOf(run.watchlist);
  if(!films)return {ok:false,reason:'shape'};
  if(films.budget)return {ok:false,reason:'budget'};
  if(films.films.length!==base.count||films.films.some((film,index)=>film.id!==base.ids[index]))return {ok:false,reason:'shape'};
 }else if('watchlist' in run&&run.watchlist!==undefined)return {ok:false,reason:'shape'};
 const now=iso(ctx.now??Date.now()),writeId=writeIdOf(),revision=base.revision+1;
 const changed=films?films.films.filter((film,index)=>film.sha!==base.digests[index]):[];
 const statements=[
  ...guards(sc,base.generation),
  ['UPDATE epg_checkpoint_run SET stage=?, seal_phase=?, has_error=?, revision=revision+1, last_write_id=?, body_chunks=?, body_chars=?, body_sha256=?, watchlist_present=?, film_count=?, film_list_sha256=?, updated_at=? WHERE id=1 AND run_id=? AND revision=?',[run.stage,run.stage==='seal'?run.seal.phase:null,run.error?1:0,writeId,body.chunks.length,body.text.length,body.sha,base.present?1:0,base.present?base.count:null,base.present?films.listSha:null,now,base.runId,base.revision]],
  [FENCE,[]],
  ...changed.flatMap(film=>[['UPDATE epg_checkpoint_film SET body=?, body_sha256=? WHERE run_id=? AND ordinal=? AND film_id=?',[film.text,film.sha,base.runId,film.ordinal,film.id]],[FENCE,[]]]),
  ...bodyStatements(body,revision,writeId,base.runId,now),
 ];
 const outcome=await fenced(db,statements);
 if(outcome==='ok'){
  bases.set(run,{...base,stage:run.stage,revision,digests:films?films.films.map(film=>film.sha):[],listSha:films?films.listSha:null});
  return {ok:true,revision,writeId};
 }
 const kind=await classifyWrite(db,{writeId,expectedRevision:base.revision});
 if(kind==='applied'){bases.set(run,{...base,stage:run.stage,revision,digests:films?films.films.map(film=>film.sha):[],listSha:films?films.listSha:null});return {ok:true,revision,writeId};}
 if(kind==='indeterminate')return {ok:false,reason:'indeterminate',writeId};
 return {ok:false,reason:outcome==='conflict'||kind==='superseded'?'conflict':'unavailable',writeId};
}

// ADR 0185 decision 4. The one operation that completes a run: stage `complete`, queue_attempted 1, completion time, the film rows removed and
// the caller's certificate statements (a non-aborting conditional update and the pause clear; the caller builds them with PublishedEpg), all in one batch.
// `queueAttempted` must be true: the caller has already attempted the queue refresh (the seal route and the single-call route both do).
export async function completeRun(source,run,ctx){
 const db=database(source);
 const base=run&&typeof run==='object'?bases.get(run):null;
 if(!db)return {ok:false,reason:'unavailable'};
 const sc=stepContext(ctx);
 if(!sc)return {ok:false,reason:'unfenced'};
 if(ctx.queueAttempted!==true)return {ok:false,reason:'queue_not_attempted'};
 if(!base)return {ok:false,reason:'unbased'};
 if(run.runId!==base.runId||(run.startedAt??null)!==base.startedAt||(run.runKey??null)!==base.runKey)return {ok:false,reason:'identity'};
 if(base.stage==='complete')return {ok:false,reason:'already_complete'};
 if(run.stage!=='complete')return {ok:false,reason:'shape'};
 // The completion time lives in the typed column AND in the body, as the same value. A present but malformed `completedAt` is refused; a missing one (the legacy record
 // without the field) takes `updatedAt`, else the clock, and is copied into the body before it is serialized.
 if(run.completedAt!==undefined&&run.completedAt!==null&&(typeof run.completedAt!=='string'||!Number.isFinite(Date.parse(run.completedAt))))return {ok:false,reason:'shape'};
 const completedAt=run.completedAt??(typeof run.updatedAt==='string'&&Number.isFinite(Date.parse(run.updatedAt))?run.updatedAt:iso(ctx.now??Date.now()));
 run.completedAt=completedAt;
 const body=await bodyOf(run);
 if(!body)return {ok:false,reason:'budget'};
 const now=iso(ctx.now??Date.now()),writeId=writeIdOf(),revision=base.revision+1;
 const certify=Array.isArray(ctx.certify)?ctx.certify:[];
 const statements=[
  ...guards(sc,base.generation),
  ['UPDATE epg_checkpoint_run SET stage=\'complete\', seal_phase=NULL, queue_attempted=1, completed_at=?, has_error=?, revision=revision+1, last_write_id=?, body_chunks=?, body_chars=?, body_sha256=?, watchlist_present=0, film_count=NULL, film_list_sha256=NULL, updated_at=? WHERE id=1 AND run_id=? AND revision=?',[completedAt,run.error?1:0,writeId,body.chunks.length,body.text.length,body.sha,now,base.runId,base.revision]],
  [FENCE,[]],
  ['DELETE FROM epg_checkpoint_film WHERE run_id=?',[base.runId]],
  ...bodyStatements(body,revision,writeId,base.runId,now),
  ...certify,
 ];
 const outcome=await fenced(db,statements);
 const done=()=>{bases.set(run,{...base,stage:'complete',revision,completedAt,queueAttempted:true,present:false,count:null,ids:[],digests:[],listSha:null});return {ok:true,revision,writeId};};
 if(outcome==='ok')return done();
 const kind=await classifyWrite(db,{writeId,expectedRevision:base.revision});
 if(kind==='applied')return done();
 if(kind==='indeterminate')return {ok:false,reason:'indeterminate',writeId};
 return {ok:false,reason:outcome==='conflict'||kind==='superseded'?'conflict':'unavailable',writeId};
}

// Removes at most `gcBatch` film rows that belong to no current run, per pass and at most `gcPasses` passes, each pass fenced. Orphans exist only
// after an interrupted run creation. -> {ok:true,removed} | {ok:false,reason}
export async function gcOrphans(source,ctx){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 const sc=stepContext(ctx);
 if(!sc)return {ok:false,reason:'unfenced'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1'||gate.writes!=='open')return {ok:false,reason:gate.state==='d1'?'writes_held':'closed'};
 let removed=0;
 for(let pass=0;pass<LIMITS.gcPasses;pass++){
  let before;
  try{before=Number((await one(db,'SELECT COUNT(*) AS n FROM epg_checkpoint_film WHERE run_id NOT IN (SELECT run_id FROM epg_checkpoint_run)'))?.n);}catch{return {ok:false,reason:'unavailable'};}
  if(!before)break;
  const outcome=await fenced(db,[...guards(sc,gate.generation),['DELETE FROM epg_checkpoint_film WHERE rowid IN (SELECT rowid FROM epg_checkpoint_film WHERE run_id NOT IN (SELECT run_id FROM epg_checkpoint_run) LIMIT ?)',[LIMITS.gcBatch]]]);
  if(outcome!=='ok')return {ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
  removed+=Math.min(before,LIMITS.gcBatch);
 }
 return {ok:true,removed};
}

// ADR 0185 decision 3. A new run: stage the film rows (fenced, bounded batches), read them back and verify, then ONE switch batch that replaces the
// previous run (compare-and-swap on its (run_id, revision) or an empty row), carries the body and the completeness fields, records the ingest success and
// removes every other film row. `attempt` = {id, startedAt}. -> {ok:true,revision,writeId} | {ok:false,reason}
export async function createRun(source,run,ctx){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 const sc=stepContext(ctx);
 if(!sc)return {ok:false,reason:'unfenced'};
 const attempt=ctx.attempt;
 if(!attempt||typeof attempt.id!=='string'||!attempt.id||typeof attempt.startedAt!=='string')return {ok:false,reason:'shape'};
 if(!run||typeof run.runId!=='string'||!run.runId||typeof run.startedAt!=='string'||run.stage==='complete'||!STAGES.includes(run.stage)||(run.stage==='seal'&&typeof run.seal?.phase!=='string'))return {ok:false,reason:'shape'};
 const body=await bodyOf(run),films=await filmsOf(run.watchlist);
 if(!body)return {ok:false,reason:'budget'};
 if(!films)return {ok:false,reason:'shape'};
 if(films.budget)return {ok:false,reason:'budget'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 let previous;
 try{previous=await one(db,'SELECT run_id, revision FROM epg_checkpoint_run WHERE id=1');}catch{return {ok:false,reason:'unavailable'};}
 if(previous&&previous.run_id===run.runId)return {ok:false,reason:'shape'};
 const swept=await gcOrphans(db,ctx);
 if(!swept.ok)return swept;
 for(let at=0;at<films.films.length;at+=LIMITS.stageBatch){
  const slice=films.films.slice(at,at+LIMITS.stageBatch);
  const outcome=await fenced(db,[...guards(sc,gate.generation),...slice.map(film=>['INSERT OR REPLACE INTO epg_checkpoint_film (run_id, ordinal, film_id, body, body_sha256) VALUES (?,?,?,?,?)',[run.runId,film.ordinal,film.id,film.text,film.sha]])]);
  if(outcome!=='ok')return {ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
 }
 let staged;
 try{staged=await many(db,'SELECT ordinal, film_id, body_sha256 FROM epg_checkpoint_film WHERE run_id=? ORDER BY ordinal',[run.runId]);}catch{return {ok:false,reason:'unavailable'};}
 const mine=films.films;
 if(!filmRowsOk(staged,mine.length)||staged.some((row,index)=>row.film_id!==mine[index].id||row.body_sha256!==mine[index].sha)||await listDigest(staged)!==films.listSha)return {ok:false,reason:'malformed'};
 const now=iso(ctx.now??Date.now()),writeId=writeIdOf(),expected=previous?Number(previous.revision):0,revision=expected+1;
 const count=mine.length;
 const shape=[GUARD('CASE WHEN (SELECT COUNT(*) FROM epg_checkpoint_film WHERE run_id=?)=? AND (SELECT COALESCE(MIN(ordinal),0) FROM epg_checkpoint_film WHERE run_id=?)=0 AND (SELECT COALESCE(MAX(ordinal),-1) FROM epg_checkpoint_film WHERE run_id=?)=?-1 AND (SELECT COUNT(DISTINCT film_id) FROM epg_checkpoint_film WHERE run_id=?)=? THEN 1 ELSE 0 END'),[run.runId,count,run.runId,run.runId,count,run.runId,count]];
 const columns=[run.runId,run.runKey??null,run.startedAt,run.stage,run.stage==='seal'?run.seal.phase:null,run.error?1:0,revision,writeId,body.chunks.length,body.text.length,body.sha,count,films.listSha,now];
 const write=previous
  ?['UPDATE epg_checkpoint_run SET run_id=?, run_key=?, started_at=?, stage=?, seal_phase=?, queue_attempted=0, completed_at=NULL, has_error=?, revision=?, last_write_id=?, body_chunks=?, body_chars=?, body_sha256=?, watchlist_present=1, film_count=?, film_list_sha256=?, updated_at=? WHERE id=1 AND run_id=? AND revision=?',[...columns,previous.run_id,expected]]
  :['INSERT INTO epg_checkpoint_run (id, run_id, run_key, started_at, stage, seal_phase, queue_attempted, completed_at, has_error, revision, last_write_id, body_chunks, body_chars, body_sha256, watchlist_present, film_count, film_list_sha256, updated_at) VALUES (1,?,?,?,?,?,0,NULL,?,?,?,?,?,?,1,?,?,?)',columns];
 const statements=[
  ...guards(sc,gate.generation),
  write,[FENCE,[]],
  shape,
  ['DELETE FROM epg_checkpoint_film WHERE run_id<>?',[run.runId]],
  ...bodyStatements(body,revision,writeId,run.runId,now),
  // The ingest success of this attempt, ordered by attempt: an older attempt does not replace a newer one.
  ['INSERT INTO epg_ingest_status (id, schema_version, last_success_at, failed_at, code, consecutive_failures, success_attempt_id, success_attempt_started_at, revision, updated_at) VALUES (1,1,?,NULL,NULL,0,?,?,1,?) ON CONFLICT(id) DO UPDATE SET last_success_at=excluded.last_success_at, failed_at=NULL, code=NULL, consecutive_failures=0, success_attempt_id=excluded.success_attempt_id, success_attempt_started_at=excluded.success_attempt_started_at, revision=revision+1, updated_at=excluded.updated_at WHERE (excluded.success_attempt_started_at, excluded.success_attempt_id) > (COALESCE(success_attempt_started_at,\'\'), COALESCE(success_attempt_id,\'\'))',[run.startedAt,attempt.id,attempt.startedAt,now]],
 ];
 const outcome=await fenced(db,statements);
 const done=()=>{bases.set(run,{runId:run.runId,runKey:run.runKey??null,startedAt:run.startedAt,stage:run.stage,revision,completedAt:null,queueAttempted:false,generation:gate.generation,present:true,count,ids:mine.map(film=>film.id),digests:mine.map(film=>film.sha),listSha:films.listSha});return {ok:true,revision,writeId};};
 if(outcome==='ok')return done();
 const kind=await classifyWrite(db,{writeId,expectedRevision:expected});
 if(kind==='applied')return done();
 if(kind==='indeterminate')return {ok:false,reason:'indeterminate',writeId};
 return {ok:false,reason:outcome==='conflict'||kind==='superseded'?'conflict':'unavailable',writeId};
}

// ---- the ingest status ---------------------------------------------------------------------------------------------------
// The document shape the R2 object had: {schemaVersion, failedAt, code?, lastSuccessAt}, plus the bounded counter. -> {ok:true,status:null|object} | {ok:false,reason}
export async function readIngest(source){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 let gate,row;
 try{gate=await one(db,MARKER_SQL);row=await one(db,'SELECT last_success_at, failed_at, code, consecutive_failures FROM epg_ingest_status WHERE id=1');}catch{return {ok:false,reason:'unavailable'};}
 if(!gate||gate.mode!=='d1'||Number(gate.cas)!==1)return {ok:false,reason:'closed'};
 if(!row)return {ok:true,status:null};
 return {ok:true,status:{schemaVersion:1,...(row.code?{code:row.code}:{}),failedAt:row.failed_at??null,lastSuccessAt:row.last_success_at??null,consecutiveFailures:Number(row.consecutive_failures)}};
}

// ADR 0185 decision 3. A failure of one attempt. Guarded by the authority only (not the step lease or the run revision), and applied only when its attempt
// is newer than BOTH the stored success attempt and the stored failure attempt; a late failure of an older attempt is superseded and writes nothing.
// `lastSuccessAt` is the caller's computation (today's rule); the stored value is never lowered. -> {ok:true,applied:boolean} | {ok:false,reason}
export async function recordIngestFailure(source,{attempt,code,failedAt,lastSuccessAt,now}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!attempt||typeof attempt.id!=='string'||!attempt.id||typeof attempt.startedAt!=='string'||typeof code!=='string'||typeof failedAt!=='string')return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const stamp=iso(now??Date.now()),success=lastSuccessAt??null;
 const mine='(excluded.failure_attempt_started_at, excluded.failure_attempt_id)';
 const outcome=await fenced(db,[
  [GUARD("(SELECT COUNT(*) FROM epg_checkpoint_authority WHERE id=1 AND mode='d1' AND writes='open' AND generation=?)"),[gate.generation]],
  ['INSERT INTO epg_ingest_status (id, schema_version, last_success_at, failed_at, code, consecutive_failures, failure_attempt_id, failure_attempt_started_at, revision, updated_at) VALUES (1,1,?,?,?,1,?,?,1,?) ON CONFLICT(id) DO UPDATE SET last_success_at=NULLIF(MAX(COALESCE(last_success_at,\'\'),COALESCE(excluded.last_success_at,\'\')),\'\'), failed_at=excluded.failed_at, code=excluded.code, consecutive_failures=MIN(consecutive_failures+1,'+LIMITS.failureCap+'), failure_attempt_id=excluded.failure_attempt_id, failure_attempt_started_at=excluded.failure_attempt_started_at, revision=revision+1, updated_at=excluded.updated_at WHERE '+mine+' > (COALESCE(success_attempt_started_at,\'\'), COALESCE(success_attempt_id,\'\')) AND '+mine+' > (COALESCE(failure_attempt_started_at,\'\'), COALESCE(failure_attempt_id,\'\'))',[success,failedAt,code.slice(0,60),attempt.id,attempt.startedAt,stamp]],
 ]);
 // A guard that fails means the authority moved (a hold or a flip) between the read and the write: nothing was written.
 if(outcome==='conflict')return {ok:false,reason:'writes_held'};
 if(outcome!=='ok')return {ok:false,reason:'unavailable'};
 let row;
 try{row=await one(db,'SELECT failure_attempt_id FROM epg_ingest_status WHERE id=1');}catch{return {ok:false,reason:'unavailable'};}
 return {ok:true,applied:row?.failure_attempt_id===attempt.id};
}
