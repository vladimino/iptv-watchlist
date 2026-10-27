// AIR-168. Staged import of one programme generation (ADR-0021). The Worker does not import this file; R2 stays authoritative.
// A generation is written to the staging tables of migrations/0002 in chunks no larger than the proven batch size, validated by
// counts and read back row by row, and then published by one commit request, the only write to final tables. The caller supplies
// the database adapter (its transaction() sends the buffered statements as one request) and the SHA-256 function.
import {generationProjection,pagedAll,replayGeneration,requireExpected} from './epg-repository.js';

export const STAGE_TABLES=['generation_stage','generation_stage_chunk','stage_film_generation','stage_film_show','stage_candidate','stage_candidate_show'];
// One chunk request stays inside the owner's scratch proof (1,000 statements, about 0.95 MB) with a margin.
export const DEFAULT_CHUNK_STATEMENTS=950;
export const DEFAULT_CHUNK_BYTES=1000000;
// Below the documented D1 limit of 100,000 bytes per statement. A row is never split.
export const MAX_ROW_STATEMENT_BYTES=90000;
// ADR-0021 GO/NO-GO: the commit at 1.25x production size within a third of the 30-second D1 bound.
export const PUBLISH_BUDGET_MS=10000;
// An execution's claim on its stage lasts this long after its last write; only then may another execution take it over. The
// claim's correctness does not rest on clocks: every write is fenced by the claimant's nonce and claim generation.
export const STAGE_CLAIM_TTL_MS=15*60*1000;
export const STAGE_CLAIM_TTL_BOUNDS=[60*1000,60*60*1000];
const CONTROL_STATEMENTS=3,CONTROL_BYTES=4096;

// Every stop is fatal to the run: the importer rethrows it instead of booking a conflict, and the executor reports it as NO-GO.
export class StageStop extends Error{constructor(reason,details={}){super('Staged generation stopped: '+reason);this.name='StageStop';this.reason=reason;this.details=details;this.fatal=true;}}

export const STAGE_COLUMNS={
 stage_film_generation:['film_id'],
 stage_film_show:['film_id','channel_id','channel','start_ms','end_ms','epg_title','basis','match_reason'],
 stage_candidate:['observation_key','title','normalized_title','year','raw_titles_json','durations_json','description','first_airing_ms','last_airing_ms','airings','confirmed_tmdb_id','observation_json','activity','last_seen_at','last_seen_programme_run_id','seen_in_latest','evidence_key'],
 stage_candidate_show:['observation_key','channel_id','channel','start_ms','end_ms','epg_title'],
};
const STAGE_KEYS={stage_film_generation:['film_id'],stage_film_show:['film_id','channel_id','start_ms'],stage_candidate:['observation_key'],stage_candidate_show:['observation_key','channel_id','start_ms','end_ms','epg_title']};

// A guard statement aborts its whole request (its row breaks the state CHECK) unless the stage is in one of the given states and
// still claimed by this execution: same owner, baseline, nonce and claim generation.
const CLAIMED="programme_run_id=:run AND owner_token=:owner AND baseline_sha256=:baseline AND claim_nonce=:nonce AND claim_generation=:fence";
const guard=states=>`INSERT INTO generation_stage (programme_run_id,baseline_sha256,phase,owner_token,state,chunk_count,film_count,film_show_count,candidate_count,candidate_show_count,created_at,updated_at)
SELECT 'guard:'||:run,'-','published','-','refused',0,0,0,0,0,:now,:now
WHERE NOT EXISTS (SELECT 1 FROM generation_stage WHERE ${CLAIMED} AND state IN (${states}))`;

// The statements ADR-0021 accepted, by name; :name placeholders are bound in order by bind().
export const STAGE_SQL={
 open_stage:[
  `INSERT INTO generation_stage (programme_run_id,baseline_sha256,phase,published_at,expected_programme_run_id,state,owner_token,claim_nonce,claim_generation,claim_expires_at,chunk_count,film_count,film_show_count,candidate_count,candidate_show_count,created_at,updated_at)
VALUES (:run,:baseline,:phase,:published_at,:expected,'new',:owner,:nonce,1,:expires,:chunk_count,:film_count,:film_show_count,:candidate_count,:candidate_show_count,:now,:now)`,
 ],
 // Takes over a stage of this owner and baseline whose claim was released or has expired, raising the claim generation so the
 // previous claimant's next write is refused. A live claim is left alone: the statement then changes nothing.
 claim_stage:[
  `UPDATE generation_stage SET claim_nonce=:nonce,claim_generation=claim_generation+1,claim_expires_at=:expires,updated_at=:now
WHERE programme_run_id=:run AND owner_token=:owner AND baseline_sha256=:baseline AND state IN ('new','loading','validated')
 AND (claim_nonce IS NULL OR claim_expires_at IS NULL OR claim_expires_at<=:now)`,
 ],
 chunk_guard:[guard("'new','loading'")],
 chunk_state:[
  `UPDATE generation_stage SET state='loading',claim_expires_at=:expires,updated_at=:now WHERE ${CLAIMED} AND state IN ('new','loading')`,
 ],
 chunk_receipt:[
  `INSERT INTO generation_stage_chunk (programme_run_id,chunk_index,row_count,content_sha256,received_at) VALUES (:run,:chunk,:row_count,:sha,:now)`,
 ],
 validate:[
  guard("'new','loading'"),
  `UPDATE generation_stage SET state='validated',claim_expires_at=:expires,updated_at=:now
WHERE ${CLAIMED} AND state IN ('new','loading')
 AND (SELECT COUNT(*) FROM generation_stage_chunk WHERE programme_run_id=:run)=chunk_count
 AND (SELECT COALESCE(MIN(chunk_index),0) FROM generation_stage_chunk WHERE programme_run_id=:run)=0
 AND (SELECT COALESCE(MAX(chunk_index),-1) FROM generation_stage_chunk WHERE programme_run_id=:run)=chunk_count-1
 AND (SELECT COUNT(*) FROM stage_film_generation WHERE programme_run_id=:run)=film_count
 AND (SELECT COUNT(*) FROM stage_film_show WHERE programme_run_id=:run)=film_show_count
 AND (SELECT COUNT(*) FROM stage_candidate WHERE programme_run_id=:run)=candidate_count
 AND (SELECT COUNT(*) FROM stage_candidate_show WHERE programme_run_id=:run)=candidate_show_count`,
 ],
 commit_published:[
  `INSERT INTO programme_generation (programme_run_id,phase,published_at)
SELECT :run,'stale',NULL
WHERE NOT (
 EXISTS (SELECT 1 FROM generation_stage WHERE ${CLAIMED} AND state='validated' AND phase='published')
 AND ((:expected IS NULL AND NOT EXISTS (SELECT 1 FROM published_generation WHERE id=1)) OR EXISTS (SELECT 1 FROM published_generation WHERE id=1 AND programme_run_id IS :expected))
)`,
  `INSERT INTO programme_generation (programme_run_id,phase,published_at) SELECT programme_run_id,'published',published_at FROM generation_stage WHERE programme_run_id=:run`,
  `INSERT INTO published_generation (id,programme_run_id) VALUES (1,:run) ON CONFLICT(id) DO UPDATE SET programme_run_id=excluded.programme_run_id`,
  `INSERT INTO film_generation (programme_run_id,film_id) SELECT programme_run_id,film_id FROM stage_film_generation WHERE programme_run_id=:run`,
  `INSERT INTO film_show (programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason)
SELECT programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason FROM stage_film_show WHERE programme_run_id=:run`,
  `INSERT INTO film_epg_last_airing (film_id,airing_ms,programme_run_id)
SELECT film_id,MAX(start_ms),:run FROM stage_film_show WHERE programme_run_id=:run GROUP BY film_id
ON CONFLICT(film_id) DO UPDATE SET
 airing_ms=MAX(film_epg_last_airing.airing_ms,excluded.airing_ms),
 programme_run_id=CASE WHEN excluded.airing_ms>=film_epg_last_airing.airing_ms THEN excluded.programme_run_id ELSE film_epg_last_airing.programme_run_id END`,
  `INSERT INTO candidate (observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,observation_schema_version,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,attempts,last_attempt_at,retry_at,terminal_reason,evidence_key)
SELECT observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,1,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,0,NULL,NULL,NULL,evidence_key
FROM stage_candidate WHERE programme_run_id=:run
ON CONFLICT(observation_key) DO UPDATE SET
 title=excluded.title,normalized_title=excluded.normalized_title,year=excluded.year,raw_titles_json=excluded.raw_titles_json,durations_json=excluded.durations_json,description=excluded.description,first_airing_ms=excluded.first_airing_ms,last_airing_ms=excluded.last_airing_ms,airings=excluded.airings,confirmed_tmdb_id=excluded.confirmed_tmdb_id,observation_schema_version=excluded.observation_schema_version,observation_json=excluded.observation_json,activity=excluded.activity,last_seen_at=excluded.last_seen_at,last_seen_programme_run_id=excluded.last_seen_programme_run_id,seen_in_latest=excluded.seen_in_latest,evidence_key=excluded.evidence_key,
 terminal_reason=CASE WHEN candidate.evidence_key=excluded.evidence_key THEN candidate.terminal_reason ELSE NULL END,
 retry_at=CASE WHEN candidate.evidence_key=excluded.evidence_key THEN candidate.retry_at ELSE NULL END,
 attempts=CASE WHEN candidate.evidence_key=excluded.evidence_key THEN candidate.attempts ELSE 0 END,
 last_attempt_at=CASE WHEN candidate.evidence_key=excluded.evidence_key THEN candidate.last_attempt_at ELSE NULL END`,
  `INSERT INTO candidate_generation (programme_run_id,observation_key,observation_schema_version,observation_json,evidence_key)
SELECT programme_run_id,observation_key,1,observation_json,evidence_key FROM stage_candidate WHERE programme_run_id=:run`,
  `INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title)
SELECT programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title FROM stage_candidate_show WHERE programme_run_id=:run`,
  `UPDATE candidate SET seen_in_latest=0,activity=CASE WHEN activity='current' THEN 'historical' ELSE activity END
WHERE NOT EXISTS (SELECT 1 FROM stage_candidate s WHERE s.programme_run_id=:run AND s.observation_key=candidate.observation_key)`,
  `UPDATE generation_stage SET state='published',updated_at=:now WHERE programme_run_id=:run`,
  `UPDATE generation_stage SET state='superseded',updated_at=:now WHERE state='published' AND programme_run_id<>:run`,
 ],
 commit_withheld:[
  `INSERT INTO programme_generation (programme_run_id,phase,published_at)
SELECT :run,'stale',NULL
WHERE NOT EXISTS (SELECT 1 FROM generation_stage WHERE ${CLAIMED} AND state='validated' AND phase='withheld')`,
  `INSERT INTO programme_generation (programme_run_id,phase,published_at) SELECT programme_run_id,'withheld',published_at FROM generation_stage WHERE programme_run_id=:run`,
  `INSERT INTO film_generation (programme_run_id,film_id) SELECT programme_run_id,film_id FROM stage_film_generation WHERE programme_run_id=:run`,
  `INSERT INTO film_show (programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason)
SELECT programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason FROM stage_film_show WHERE programme_run_id=:run`,
  `INSERT INTO candidate (observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,observation_schema_version,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,attempts,evidence_key)
SELECT observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,1,observation_json,CASE WHEN activity='current' THEN 'historical' ELSE activity END,last_seen_at,last_seen_programme_run_id,0,0,evidence_key
FROM stage_candidate WHERE programme_run_id=:run
ON CONFLICT(observation_key) DO NOTHING`,
  `INSERT INTO candidate_generation (programme_run_id,observation_key,observation_schema_version,observation_json,evidence_key)
SELECT programme_run_id,observation_key,1,observation_json,evidence_key FROM stage_candidate WHERE programme_run_id=:run`,
  `INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title)
SELECT programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title FROM stage_candidate_show WHERE programme_run_id=:run`,
  `UPDATE generation_stage SET state='published',updated_at=:now WHERE programme_run_id=:run`,
 ],
 fail_stage:[
  `UPDATE generation_stage SET state='failed',failure_reason=:reason,updated_at=:now WHERE ${CLAIMED} AND state IN ('new','loading','validated')`,
 ],
 abandon_stage:[
  `UPDATE generation_stage SET state='failed',failure_reason='abandoned_by_owner',updated_at=:now WHERE programme_run_id=:run AND state IN ('new','loading','validated')`,
 ],
 discard_stage:[
  `DELETE FROM stage_candidate_show WHERE rowid IN (SELECT rowid FROM stage_candidate_show WHERE programme_run_id=:run LIMIT :limit)
 AND (SELECT state FROM generation_stage WHERE programme_run_id=:run) IN ('failed','superseded')`,
  `DELETE FROM stage_candidate WHERE rowid IN (SELECT rowid FROM stage_candidate c WHERE programme_run_id=:run
 AND NOT EXISTS (SELECT 1 FROM stage_candidate_show s WHERE s.programme_run_id=c.programme_run_id AND s.observation_key=c.observation_key) LIMIT :limit)
 AND (SELECT state FROM generation_stage WHERE programme_run_id=:run) IN ('failed','superseded')`,
  `DELETE FROM stage_film_show WHERE rowid IN (SELECT rowid FROM stage_film_show WHERE programme_run_id=:run LIMIT :limit)
 AND (SELECT state FROM generation_stage WHERE programme_run_id=:run) IN ('failed','superseded')`,
  `DELETE FROM stage_film_generation WHERE rowid IN (SELECT rowid FROM stage_film_generation f WHERE programme_run_id=:run
 AND NOT EXISTS (SELECT 1 FROM stage_film_show s WHERE s.programme_run_id=f.programme_run_id AND s.film_id=f.film_id) LIMIT :limit)
 AND (SELECT state FROM generation_stage WHERE programme_run_id=:run) IN ('failed','superseded')`,
  `DELETE FROM generation_stage_chunk WHERE programme_run_id=:run
 AND (SELECT state FROM generation_stage WHERE programme_run_id=:run) IN ('failed','superseded')
 AND NOT EXISTS (SELECT 1 FROM stage_film_generation WHERE programme_run_id=:run)
 AND NOT EXISTS (SELECT 1 FROM stage_candidate WHERE programme_run_id=:run)`,
  `DELETE FROM generation_stage WHERE programme_run_id=:run AND state='failed'
 AND NOT EXISTS (SELECT 1 FROM generation_stage_chunk WHERE programme_run_id=:run)`,
 ],
};

export function bind(statements,values){
 return statements.map(text=>{const params=[];const sql=text.replace(/:([a-z_]+)/g,(match,name)=>{if(!(name in values))throw new Error('Unbound stage parameter '+name);params.push(values[name]);return '?';});return {sql,params};});
}
// The byte size the D1 adapter will send for a statement: the same literal rendering, plus its ';' and the joining newline.
export function renderedBytes(sql,params){let index=0;const text=sql.replace(/\?/g,()=>literal(params[index++]));return utf8Length(text)+2;}
function literal(value){if(value==null)return 'NULL';if(typeof value==='number')return String(value);if(typeof value==='boolean')return value?'1':'0';return "'"+String(value).replaceAll("'","''")+"'";}
function utf8Length(text){let bytes=0;for(const char of text){const code=char.codePointAt(0);bytes+=code<0x80?1:code<0x800?2:code<0x10000?3:4;}return bytes;}
function compareBy(columns){return (a,b)=>{for(const column of columns){const left=a[column],right=b[column];if(left===right)continue;if(left==null)return -1;if(right==null)return 1;return left<right?-1:1;}return 0;};}
// JSON keeps a missing value apart from the text "null".
function keyOf(table,values){return JSON.stringify(STAGE_KEYS[table].map(column=>values[column]??null));}

// The staged rows of one generation in a deterministic order: films by id, each followed by its shows; then candidates by key,
// each followed by its shows. A repeated key is refused before any write, as the final tables' primary keys would refuse it.
export function stageRows(projection){
 const rows=[],seen=new Set();
 const push=(table,values)=>{const key=table+'\u0000'+keyOf(table,values);if(seen.has(key))throw new Error('Generation rows repeat a key');seen.add(key);rows.push({table,values});};
 for(const film of [...projection.films].sort(compareBy(['filmId']))){
  push('stage_film_generation',{film_id:film.filmId});
  for(const show of [...film.shows].sort(compareBy(['channel_id','start_ms'])))push('stage_film_show',show);
 }
 for(const candidate of [...projection.candidates].sort((a,b)=>compareBy(['observation_key'])(a.row,b.row))){
  push('stage_candidate',candidate.row);
  for(const show of [...candidate.shows].sort(compareBy(['channel_id','start_ms','end_ms','epg_title','channel'])))push('stage_candidate_show',show);
 }
 return rows;
}
function rowStatement(run,row,chunkIndex){
 const columns=STAGE_COLUMNS[row.table];
 return {sql:'INSERT INTO '+row.table+' (programme_run_id,'+columns.join(',')+',chunk_index) VALUES ('+Array(columns.length+2).fill('?').join(',')+')',params:[run,...columns.map(column=>row.values[column]??null),chunkIndex]};
}

// The chunk plan. A chunk closes at whichever limit comes first, counting the guard, state and receipt statements it carries.
// A row whose statement exceeds the per-statement cap stops the unit before anything is written.
export function planGeneration(input,{sha256,maxStatements=DEFAULT_CHUNK_STATEMENTS,maxBytes=DEFAULT_CHUNK_BYTES,maxRowBytes=MAX_ROW_STATEMENT_BYTES}={}){
 if(typeof sha256!=='function')throw new Error('A SHA-256 function is required');
 const projection=generationProjection(input),run=projection.programmeRunId;
 const rows=stageRows(projection);
 const rowLimit=maxStatements-CONTROL_STATEMENTS,byteLimit=maxBytes-CONTROL_BYTES;
 if(rowLimit<1||byteLimit<1)throw new Error('Chunk limits leave no room for rows');
 const chunks=[];let current=null;
 const close=()=>{if(!current)return;current.sha256=sha256(JSON.stringify({programmeRunId:run,chunk:current.index,rows:current.rows.map(row=>[row.table,...STAGE_COLUMNS[row.table].map(column=>row.values[column]??null)])}));chunks.push(current);current=null;};
 let largest=0;
 for(const row of rows){
  if(!current)current={index:chunks.length,rows:[],statements:[],bytes:0};
  let statement=rowStatement(run,row,current.index),bytes=renderedBytes(statement.sql,statement.params);
  if(bytes>maxRowBytes)throw new StageStop('stage_row_too_large',{programmeRunId:run,table:row.table,key:keyOf(row.table,row.values),bytes,limit:maxRowBytes});
  if(current.rows.length&&(current.rows.length+1>rowLimit||current.bytes+bytes>byteLimit)){close();current={index:chunks.length,rows:[],statements:[],bytes:0};statement=rowStatement(run,row,current.index);bytes=renderedBytes(statement.sql,statement.params);}
  current.rows.push(row);current.statements.push(statement);current.bytes+=bytes;largest=Math.max(largest,bytes);
 }
 close();
 const counts={film_count:projection.films.length,film_show_count:projection.films.reduce((sum,film)=>sum+film.shows.length,0),candidate_count:projection.candidates.length,candidate_show_count:projection.candidates.reduce((sum,candidate)=>sum+candidate.shows.length,0)};
 return {projection,rows,chunks,counts,largestRowBytes:largest,limits:{maxStatements,maxBytes,maxRowBytes}};
}

async function send(db,statements){await db.transaction(async()=>{for(const statement of statements)await db.run(statement.sql,statement.params);});}

export async function readStage(db,run){return await db.get('SELECT programme_run_id,baseline_sha256,phase,published_at,expected_programme_run_id,state,owner_token,claim_nonce,claim_generation,claim_expires_at,chunk_count,film_count,film_show_count,candidate_count,candidate_show_count,failure_reason FROM generation_stage WHERE programme_run_id=?',[run]);}
export async function readReceipts(db,run){return await pagedAll(db,'SELECT chunk_index,row_count,content_sha256 FROM generation_stage_chunk WHERE programme_run_id=? ORDER BY chunk_index',[run]);}

// context carries the execution's claim: its nonce, and the claim generation (fence) it holds once the claim is confirmed.
function values(plan,context){
 const {projection,counts,chunks}=plan,now=context.now();
 return {run:projection.programmeRunId,baseline:context.baseline,phase:projection.phase,published_at:projection.publishedAt,expected:projection.expectedProgrammeRunId,owner:context.owner,nonce:context.nonce??null,fence:context.fence??null,now,expires:new Date(Date.parse(now)+(context.claimTtlMs??STAGE_CLAIM_TTL_MS)).toISOString(),chunk_count:chunks.length,...counts};
}

export async function openStage(db,plan,context){await send(db,bind(STAGE_SQL.open_stage,values(plan,context)));}
export async function claimStage(db,plan,context){await send(db,bind(STAGE_SQL.claim_stage,values(plan,context)));}
export function chunkStatements(plan,chunk,context){
 const bound=values(plan,context);
 return [...bind(STAGE_SQL.chunk_guard,bound),...bind(STAGE_SQL.chunk_state,bound),...chunk.statements,...bind(STAGE_SQL.chunk_receipt,{...bound,chunk:chunk.index,row_count:chunk.rows.length,sha:chunk.sha256})];
}
export async function stageChunk(db,plan,chunk,context){await send(db,chunkStatements(plan,chunk,context));}
export async function validateStage(db,plan,context){await send(db,bind(STAGE_SQL.validate,values(plan,context)));}
export function commitStatements(plan,context){return bind(plan.projection.current?STAGE_SQL.commit_published:STAGE_SQL.commit_withheld,values(plan,context));}
export async function commitStage(db,plan,context){await send(db,commitStatements(plan,context));}
export async function failStage(db,run,{owner,baseline,nonce,fence,reason,now}){await send(db,bind(STAGE_SQL.fail_stage,{run,owner,baseline,nonce,fence,reason,now:now()}));}

// Bounded, staging-only cleanup of a failed or superseded stage, repeated until nothing is left. It never touches a final table.
// abandon first fails a stage that never committed (one left by another baseline, for instance); a published stage never is.
export async function discardStage(db,run,{limit=500,abandon=false,now=()=>new Date().toISOString()}={}){
 let stage=await readStage(db,run);
 if(!stage)throw new StageStop('stage_missing',{programmeRunId:run});
 if(abandon&&['new','loading','validated'].includes(stage.state)){await send(db,bind(STAGE_SQL.abandon_stage,{run,now:now()}));stage=await readStage(db,run);}
 if(stage.state!=='failed'&&stage.state!=='superseded')throw new StageStop('stage_not_discardable',{programmeRunId:run,state:stage.state});
 let batches=0,before=await stagedRowCount(db,run);
 const initial=before;
 while(before>0){
  await send(db,bind(STAGE_SQL.discard_stage,{run,limit}));
  batches++;
  const after=await stagedRowCount(db,run);
  if(after>=before)throw new StageStop('stage_cleanup_stalled',{programmeRunId:run,remaining:after});
  before=after;
 }
 return {programmeRunId:run,state:stage.state,batches,deletedRows:initial,stageRowKept:stage.state==='superseded'};
}
async function stagedRowCount(db,run){
 const row=await db.get('SELECT (SELECT COUNT(*) FROM stage_film_generation WHERE programme_run_id=?)+(SELECT COUNT(*) FROM stage_film_show WHERE programme_run_id=?)+(SELECT COUNT(*) FROM stage_candidate WHERE programme_run_id=?)+(SELECT COUNT(*) FROM stage_candidate_show WHERE programme_run_id=?)+(SELECT COUNT(*) FROM generation_stage_chunk WHERE programme_run_id=?)+(SELECT COUNT(*) FROM generation_stage WHERE programme_run_id=? AND state=\'failed\') AS n',[run,run,run,run,run,run]);
 return row?.n??0;
}

// The stage must belong to this baseline and owner and describe exactly this plan; anything else stops the run unwritten.
function checkStage(stage,plan,context){
 const expected=values(plan,context);
 if(stage.baseline_sha256!==context.baseline)throw new StageStop('stage_baseline_changed',{programmeRunId:expected.run,stageBaseline:stage.baseline_sha256,baseline:context.baseline,state:stage.state});
 if(stage.owner_token!==context.owner)throw new StageStop('stage_owned_elsewhere',{programmeRunId:expected.run,state:stage.state});
 if(stage.state==='failed'||stage.state==='superseded')throw new StageStop('stage_'+stage.state,{programmeRunId:expected.run,reason:stage.failure_reason??null});
 const fields=['phase','published_at','chunk_count','film_count','film_show_count','candidate_count','candidate_show_count'];
 const changed=fields.filter(field=>(stage[field]??null)!==(expected[field]??null));
 if((stage.expected_programme_run_id??null)!==(expected.expected??null))changed.push('expected_programme_run_id');
 if(changed.length)throw new StageStop('stage_plan_changed',{programmeRunId:expected.run,fields:changed});
}

// Receipts must form a prefix 0..k-1 of the plan, each with the plan's row count and checksum.
function receivedChunks(receipts,plan){
 receipts.forEach((receipt,position)=>{
  const chunk=plan.chunks[receipt.chunk_index];
  if(!chunk||receipt.content_sha256!==chunk.sha256||receipt.row_count!==chunk.rows.length)throw new StageStop('chunk_conflict',{chunk:receipt.chunk_index,stored:receipt.content_sha256,planned:chunk?.sha256??null});
  if(receipt.chunk_index!==position)throw new StageStop('chunk_receipts_out_of_order',{expected:position,found:receipt.chunk_index});
 });
 return receipts.length;
}

// Field-by-field comparison of every staged row with the plan, read back in bounded pages.
export async function stagedParity(db,plan,{pageRows}={}){
 const run=plan.projection.programmeRunId,result={missing:[],extra:[],mismatched:[],rows:0};
 for(const table of Object.keys(STAGE_COLUMNS)){
  const columns=STAGE_COLUMNS[table];
  const wanted=new Map(plan.rows.filter(row=>row.table===table).map(row=>[keyOf(table,row.values),row.values]));
  const stored=await pagedAll(db,'SELECT '+columns.join(',')+' FROM '+table+' WHERE programme_run_id=? ORDER BY '+STAGE_KEYS[table].join(','),[run],pageRows);
  result.rows+=stored.length;
  for(const row of stored){
   const key=keyOf(table,row),want=wanted.get(key);
   if(!want){result.extra.push({table,key});continue;}
   wanted.delete(key);
   const fields=columns.filter(column=>(row[column]??null)!==(want[column]??null));
   if(fields.length)result.mismatched.push({table,key,fields});
  }
  for(const key of wanted.keys())result.missing.push({table,key});
 }
 result.ok=!result.missing.length&&!result.extra.length&&!result.mismatched.length;
 return result;
}

// After the commit the final tables must hold this generation exactly, and for a published one the shared candidate projection
// must equal the staged rows and nothing absent may still be current. All checks are reads.
async function committedParity(db,plan,input){
 const run=plan.projection.programmeRunId,problems=[];
 const replay=await replayGeneration(db,input).catch(error=>{problems.push(error.message);return null;});
 if(!replay)problems.push('generation_missing');
 const missing=await db.get('SELECT COUNT(*) AS n FROM stage_candidate s WHERE s.programme_run_id=? AND NOT EXISTS (SELECT 1 FROM candidate c WHERE c.observation_key=s.observation_key)',[run]);
 if(missing.n)problems.push('candidate_missing');
 if(plan.projection.current){
  const pointer=await db.get('SELECT programme_run_id FROM published_generation WHERE id=1');
  if(pointer?.programme_run_id!==run)problems.push('pointer_not_moved');
  const same=STAGE_COLUMNS.stage_candidate.filter(column=>column!=='observation_key').map(column=>'c.'+column+' IS s.'+column).join(' AND ');
  const differing=await db.get('SELECT COUNT(*) AS n FROM stage_candidate s JOIN candidate c ON c.observation_key=s.observation_key WHERE s.programme_run_id=? AND NOT ('+same+')',[run]);
  if(differing.n)problems.push('candidate_projection_differs');
  const stale=await db.get("SELECT COUNT(*) AS n FROM candidate c WHERE (c.seen_in_latest=1 OR c.activity='current') AND NOT EXISTS (SELECT 1 FROM stage_candidate s WHERE s.programme_run_id=? AND s.observation_key=c.observation_key)",[run]);
  if(stale.n)problems.push('absent_candidate_still_current');
 }
 return problems;
}

// The stage is claimed by this execution when it carries this nonce; the claim generation it carries is then the fence.
function confirmClaim(stage,context,reason){
 if(stage?.claim_nonce!==context.nonce)throw new StageStop(reason,{programmeRunId:stage?.programme_run_id??null,claimGeneration:stage?.claim_generation??null,claimExpiresAt:stage?.claim_expires_at??null,state:stage?.state??null});
 return stage.claim_generation;
}

// One generation unit through the stage. Each write request is sent once; a fatal adapter error (an uncertain write) propagates
// unchanged and the next run resolves it by reading the stage, its receipts and the final tables. One execution at a time holds
// the stage: it opens the stage with its claim or takes over a released or expired one, and every later write is fenced by that
// claim, so an execution whose claim was taken over is refused before it writes again (stage_claim_lost).
export async function publishStaged(db,input,{owner,baseline,sha256,nonce=crypto.randomUUID(),claimTtlMs=STAGE_CLAIM_TTL_MS,now=()=>new Date().toISOString(),clock=()=>Date.now(),limits={},pageRows,report=null}={}){
 if(!owner||!baseline)throw new Error('Stage owner and baseline are required');
 if(!nonce)throw new Error('A stage claim nonce is required');
 if(!(Number.isInteger(claimTtlMs)&&claimTtlMs>=STAGE_CLAIM_TTL_BOUNDS[0]&&claimTtlMs<=STAGE_CLAIM_TTL_BOUNDS[1]))throw new Error('Stage claim TTL out of bounds');
 const plan=planGeneration(input,{sha256,...limits});
 const run=plan.projection.programmeRunId,context={owner,baseline,now,nonce,fence:null,claimTtlMs};
 const entry={programmeRunId:run,phase:plan.projection.phase,outcome:null,claim:null,chunks:{planned:plan.chunks.length,sent:0,alreadyReceived:0},rows:plan.rows.length,bytes:plan.chunks.reduce((sum,chunk)=>sum+chunk.bytes,0),largestChunkBytes:Math.max(0,...plan.chunks.map(chunk=>chunk.bytes)),largestRowBytes:plan.largestRowBytes,requests:{writes:0,reads:0},durations:{},commit:null};
 if(report)report.push(entry);
 const timed=async(name,fn)=>{const started=clock();try{return await fn();}finally{entry.durations[name]=(entry.durations[name]||0)+(clock()-started);}};
 const read=async fn=>{entry.requests.reads++;return await fn();};
 const write=async fn=>{entry.requests.writes++;return await fn();};
 const replayed=await read(()=>replayGeneration(db,input));
 if(replayed){entry.outcome='replay';return replayed;}
 requireExpected(input);
 let stage=await read(()=>readStage(db,run)),opened=false;
 if(!stage){
  try{await write(()=>openStage(db,plan,context));opened=true;}
  catch(error){if(error?.fatal)throw error;}
  stage=await read(()=>readStage(db,run));
  if(!stage)throw new StageStop('stage_open_refused',{programmeRunId:run});
 }
 checkStage(stage,plan,context);
 if(stage.state==='published')throw new StageStop('stage_inconsistent',{programmeRunId:run,state:stage.state});
 if(stage.claim_nonce!==nonce){
  const previous={generation:stage.claim_generation,expiresAt:stage.claim_expires_at};
  await write(()=>claimStage(db,plan,context));
  stage=await read(()=>readStage(db,run));
  context.fence=confirmClaim(stage,context,'stage_claimed_elsewhere');
  entry.claim={generation:context.fence,takenOver:previous.generation>0,previous};
 }else{context.fence=confirmClaim(stage,context,'stage_claimed_elsewhere');entry.claim={generation:context.fence,takenOver:false,opened};}
 // Read the stage again after a refused write: a claim taken over by another execution explains the refusal.
 const claimLost=async()=>{const current=await read(()=>readStage(db,run));if(current?.claim_nonce!==nonce||current?.claim_generation!==context.fence)throw new StageStop('stage_claim_lost',{programmeRunId:run,claimGeneration:context.fence,currentGeneration:current?.claim_generation??null,state:current?.state??null});return current;};
 if(stage.state==='new'||stage.state==='loading'){
  let next=receivedChunks(await read(()=>readReceipts(db,run)),plan);
  entry.chunks.alreadyReceived=next;
  await timed('stagingMs',async()=>{
   for(;next<plan.chunks.length;next++){
    const chunk=plan.chunks[next];
    try{await write(()=>stageChunk(db,plan,chunk,context));entry.chunks.sent++;}
    catch(error){
     if(error?.fatal)throw error;
     await claimLost();
     // The chunk was refused as a whole while this execution held the claim. A receipt with the planned checksum means an
     // earlier execution of this baseline sent it.
     const receipt=await read(()=>db.get('SELECT chunk_index,row_count,content_sha256 FROM generation_stage_chunk WHERE programme_run_id=? AND chunk_index=?',[run,chunk.index]));
     if(receipt){
      if(receipt.content_sha256!==chunk.sha256||receipt.row_count!==chunk.rows.length)throw new StageStop('chunk_conflict',{chunk:chunk.index,stored:receipt.content_sha256,planned:chunk.sha256});
      entry.chunks.alreadyReceived++;
      continue;
     }
     const now=await read(()=>readStage(db,run));
     if(!now)throw new StageStop('stage_missing',{programmeRunId:run});
     checkStage(now,plan,context);
     if(now.state!=='new'&&now.state!=='loading')throw new StageStop('stage_not_loading',{programmeRunId:run,state:now.state});
     throw error;
    }
   }
  });
  await timed('validateMs',async()=>{try{await write(()=>validateStage(db,plan,context));}catch(error){if(error?.fatal)throw error;await claimLost();throw error;}});
  stage=await read(()=>readStage(db,run));
  if(stage?.state!=='validated'){
   const counts=await read(()=>db.get('SELECT (SELECT COUNT(*) FROM generation_stage_chunk WHERE programme_run_id=?) AS chunks,(SELECT COUNT(*) FROM stage_film_generation WHERE programme_run_id=?) AS films,(SELECT COUNT(*) FROM stage_film_show WHERE programme_run_id=?) AS film_shows,(SELECT COUNT(*) FROM stage_candidate WHERE programme_run_id=?) AS candidates,(SELECT COUNT(*) FROM stage_candidate_show WHERE programme_run_id=?) AS candidate_shows',[run,run,run,run,run]));
   await write(()=>failStage(db,run,{...context,reason:'stage_counts_mismatch'}));
   throw new StageStop('stage_validation_failed',{programmeRunId:run,stored:counts,planned:{chunks:plan.chunks.length,...plan.counts}});
  }
 }
 const parity=await timed('readbackMs',()=>stagedParity(db,plan,{pageRows}));
 entry.requests.reads+=Math.max(1,Math.ceil(parity.rows/(pageRows||5000)));
 entry.readback={rows:parity.rows,ok:parity.ok};
 if(!parity.ok){
  await write(()=>failStage(db,run,{...context,reason:'stage_parity_mismatch'}));
  throw new StageStop('stage_parity_mismatch',{programmeRunId:run,missing:parity.missing.slice(0,20),extra:parity.extra.slice(0,20),mismatched:parity.mismatched.slice(0,20),counts:{missing:parity.missing.length,extra:parity.extra.length,mismatched:parity.mismatched.length}});
 }
 const statements=commitStatements(plan,context);
 entry.commit={statements:statements.length,bytes:statements.reduce((sum,statement)=>sum+renderedBytes(statement.sql,statement.params),0),ms:null,budgetMs:PUBLISH_BUDGET_MS,withinBudget:null};
 const started=clock();
 try{await write(()=>send(db,statements));}
 catch(error){
  entry.commit.ms=clock()-started;
  if(error?.fatal)throw error;
  await claimLost();
  const pointer=await read(()=>db.get('SELECT programme_run_id FROM published_generation WHERE id=1'));
  if(plan.projection.current&&(pointer?.programme_run_id??null)!==(plan.projection.expectedProgrammeRunId??null)){
   // Another generation was published meanwhile: this stage can never commit, so it is failed and left for an approved cleanup.
   await write(()=>failStage(db,run,{...context,reason:'pointer_moved'}));
   throw new StageStop('pointer_moved',{programmeRunId:run,expected:plan.projection.expectedProgrammeRunId,actual:pointer?.programme_run_id??null});
  }
  throw new StageStop('commit_refused',{programmeRunId:run,message:String(error?.message||'').slice(0,300)});
 }
 entry.commit.ms=clock()-started;
 entry.commit.withinBudget=entry.commit.ms<=PUBLISH_BUDGET_MS;
 entry.durations.commitMs=entry.commit.ms;
 const problems=await timed('verifyMs',()=>committedParity(db,plan,input));
 if(problems.length)throw new StageStop('commit_readback_mismatch',{programmeRunId:run,problems});
 entry.outcome='committed';
 return {programmeRunId:run,phase:plan.projection.phase,pointed:plan.projection.current,replay:false,staged:true};
}
