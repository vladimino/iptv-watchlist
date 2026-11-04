// D1 authority for discovery observations, decisions, admission, the lease and
// the continuation (ADR 0085). The marker starts at r2. Mode d1 with cutover
// open is the only authority. Held is not that authority: readers stay on R2
// and writers fail closed. A missing binding, or a contract below version 11,
// stays on R2, including schema v10 with the ratings tables and no discovery
// tables. Version 11 without these tables, a bad marker, a loading transfer,
// or a failed read fails closed and does not serve the R2 ledger.
// Nothing here inserts a film or a person, calls TMDB, or starts a chunk.
const TABLES=['discovery_authority','discovery_cas','discovery_transfer','discovery_lease','discovery_continuation','discovery_status','discovery_checkpoint','discovery_workflow','discovery_observation','discovery_observation_show','discovery_decision','discovery_decision_history','discovery_admission','discovery_segment','discovery_score','discovery_intent'];
export const DISCOVERY_TABLES=TABLES;
const FENCE_SQL='UPDATE discovery_cas SET ok=changes() WHERE id=1';
export const LEASE_TTL_MS=90000;
export const STATEMENT_CAP=40;
const SHOW_CAP=96;
export const INDEX_CAP=3000;
const READ_CAP=20000;
export const LEDGER_PAGE=500;
const GENERATION_KEY=/^epg\/generations\/([^/]+)\/(discovery-latest|discovered-films)\.json$/;
function generationRequest(key){
 const match=GENERATION_KEY.exec(key);
 return match?match[1]:null;
}

function failed(code,cause){const error=new Error(code);error.code=code;if(cause)error.cause=cause;return error;}
function binding(db){return typeof db?.prepare==='function';}
function database(env){return env&&typeof env.prepare==='function'?env:env?.DB;}
async function one(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).first())??null;
 return (await db.get(sql,params))??null;
}
async function many(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).all()).results||[];
 return (await db.all(sql,params))||[];
}
async function commit(db,statements){
 if(statements.length>STATEMENT_CAP)throw failed('discovery_bounded');
 if(typeof db.batch!=='function')throw failed('discovery_unavailable');
 const prepared=statements.map(([sql,params])=>db.prepare(sql).bind(...params));
 try{await db.batch(prepared);}
 catch(error){
  const message=String(error?.message||error);
  if(/CHECK constraint failed/i.test(message))throw failed('discovery_fence',error);
  if(/UNIQUE constraint failed/i.test(message))throw failed('discovery_conflict',error);
  throw failed('discovery_unavailable',error);
 }
}
function canonicalJson(value){
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';
 return JSON.stringify(value??null);
}
export async function decisionHash(value){
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJson(value))));
 return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function digest(text){
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
 return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function closed(){return {ready:false,held:false,tables:false,mode:'r2',cutover:null,version:null,generation:0,programmeRunId:null,publishedProgrammeRunId:null,transfer:'idle'};}
export function ownsKey(key){
 return key==='epg/discovery-latest.json'||key==='epg/discovered-films.json'||key==='epg/discovery-resolution.json'||key==='epg/discovery-status.json'||key==='epg/discovery-score-preview.json'||key==='epg/resolver-continuation.json'||key==='epg/resolver-lease.json'||key==='epg/discovery-workflow.json'||GENERATION_KEY.test(key);
}
function mediaKind(film){
 const id=film?.id==null?'':String(film.id),canon=typeof film?.canonicalIdentity==='string'?film.canonicalIdentity:'';
 if(id.startsWith('tmdb_tv')||canon.startsWith('tmdb_tv:')||film?.mediaType==='tv'||film?.kind==='tv')return 'tv';
 return 'movie';
}
export function evidenceKey(item){
 const shows=[...(item?.shows||[])].map(show=>`${show?.channelId||''}:${show?.start}`).sort();
 const durations=[...(item?.durations||[])].filter(value=>typeof value==='number'&&Number.isFinite(value)).sort((a,b)=>a-b);
 return [item?.normalizedTitle||'',item?.year||'',durations.join(','),shows.join(',')].join('|');
}
function leaseOf(env){const lease=env?.discoveryLease;return lease&&typeof lease.id==='string'&&lease.id?lease:null;}
function nowMs(){return Date.now();}

export async function readAuthority(env){
 const db=database(env);
 if(!db)return closed();
 let version;
 try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error)))return closed();
  throw failed('discovery_unavailable',error);
 }
 const numeric=Number(version);
 if(!Number.isFinite(numeric)||numeric<11)return {...closed(),version:Number.isFinite(numeric)?numeric:null};
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'discovery\\_%' ESCAPE '\\'")).map(row=>row.name);}
 catch(error){throw failed('discovery_unavailable',error);}
 if(!TABLES.every(name=>names.includes(name)))throw failed('discovery_unavailable');
 let row,transfer;
 try{
  row=await one(db,'SELECT mode, cutover, programme_run_id AS programmeRunId, generation, published_programme_run_id AS publishedProgrammeRunId FROM discovery_authority WHERE id=1');
  transfer=await one(db,'SELECT state FROM discovery_transfer WHERE id=1');
 }catch(error){throw failed('discovery_unavailable',error);}
 if(!row||(row.mode!=='r2'&&row.mode!=='d1')||(row.cutover!=='open'&&row.cutover!=='held'))throw failed('discovery_unavailable');
 if(!transfer||!['idle','loading','committed'].includes(transfer.state))throw failed('discovery_unavailable');
 const ready=row.mode==='d1'&&row.cutover==='open',held=row.mode==='d1'&&row.cutover==='held';
 return {ready,held,tables:true,mode:row.mode,cutover:row.cutover,version:numeric,generation:Number(row.generation),programmeRunId:row.programmeRunId??null,publishedProgrammeRunId:row.publishedProgrammeRunId??null,transfer:transfer.state};
}

function assertOpen(gate){
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)throw failed('discovery_not_authoritative');
 if(gate.transfer==='loading')throw failed('discovery_incomplete');
}

export async function routeRead(env,key){
 if(!ownsKey(key))return {handled:false};
 const opened=await readAuthority(env);
 if(!opened.ready)return {handled:false};
 if(opened.transfer==='loading')throw failed('discovery_incomplete');
 const value=await readKey(env,key,opened);
 const closedGate=await readAuthority(env);
 if(!closedGate.ready||closedGate.generation!==opened.generation||closedGate.programmeRunId!==opened.programmeRunId||closedGate.transfer==='loading')throw failed('discovery_fence');
 return {handled:true,value};
}
async function readKey(env,key,gate){
 const requested=generationRequest(key);
 if(requested&&requested!==gate.programmeRunId)return null;
 if(key==='epg/discovery-resolution.json')return readDecisions(env,gate);
 if(key==='epg/discovered-films.json'||requested&&key.endsWith('discovered-films.json'))return readCatalog(env,gate);
 if(key==='epg/discovery-latest.json'||requested&&key.endsWith('discovery-latest.json'))return readLedger(env,gate);
 if(key==='epg/discovery-status.json')return readPayload(env,'discovery_status');
 if(key==='epg/discovery-score-preview.json')return readScores(env,gate);
 if(key==='epg/resolver-continuation.json')return (await readContinuation(env)).record;
 if(key==='epg/resolver-lease.json')return readLeaseValue(env);
 if(key==='epg/discovery-workflow.json')return (await readWorkflow(env)).record;
 return null;
}
export async function routeWrite(env,key,value,context={}){
 if(!ownsKey(key))return {handled:false};
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)return {handled:false};
 if(key==='epg/resolver-lease.json')throw failed('discovery_fence');
 if(gate.transfer==='loading')throw failed('discovery_incomplete');
 const requested=generationRequest(key);
 if(requested&&key.endsWith('discovery-latest.json')){
  const run=typeof value?.programmeRunId==='string'?value.programmeRunId:null;
  if(!run||run!==requested)throw failed('discovery_fence');
  if(gate.programmeRunId&&run!==gate.programmeRunId&&context.handoff!==true)throw failed('discovery_fence');
 }else if(requested&&gate.programmeRunId&&requested!==gate.programmeRunId)throw failed('discovery_fence');
 if(key==='epg/discovery-resolution.json')await writeDecisions(env,value,gate,context);
 else if(key==='epg/discovered-films.json'||requested&&key.endsWith('discovered-films.json'))await replaceCatalog(env,value,context);
 else if(key==='epg/discovery-latest.json'||requested&&key.endsWith('discovery-latest.json'))await replaceLedger(env,value,context);
 else if(key==='epg/discovery-status.json')await writeStatus(env,value,gate,context);
 else if(key==='epg/discovery-score-preview.json')await writeScores(env,value,gate,context);
 else if(key==='epg/resolver-continuation.json')await writeContinuation(env,value,undefined,context);
 else if(key==='epg/discovery-workflow.json')await writeWorkflow(env,value,undefined);
 else throw failed('discovery_fence');
 return {handled:true};
}

function fence(gate,lease,extraSql='',extraParams=[]){
 return ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND lease_id=? AND expires_at>?)'+extraSql,[gate.generation,lease.id,nowMs(),...extraParams]];
}
async function writeDecisions(env,map,gate,context){
 const lease=context.lease||leaseOf(env);
 if(!lease)throw failed('discovery_lease');
 if(!map||typeof map!=='object'||Array.isArray(map))throw failed('discovery_conflict');
 const db=database(env);
 const entries=Object.entries(map).filter(([key])=>key!=='__canonicalizedAt');
 if(entries.length>READ_CAP)throw failed('discovery_bounded');
 if(!entries.length)return;
 const prepared=[];
 for(const [key,decision] of entries){
  if(!decision||typeof decision!=='object'||Array.isArray(decision))throw failed('discovery_conflict');
  const hash=await decisionHash(decision);
  const kind=mediaKind(decision);
  const observation=await one(db,'SELECT evidence_key FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\' AND observation_key=?',[key]);
  if(!observation)throw failed('discovery_fence');
  if(decision.evidenceKey!=null&&observation.evidence_key!=null&&observation.evidence_key!==decision.evidenceKey)throw failed('discovery_fence');
  prepared.push({key,decision,hash,kind});
 }
 if(gate.transfer==='loading')throw failed('discovery_incomplete');
 await commit(db,[
  fence(gate,lease,' AND programme_run_id IS (SELECT programme_run_id FROM discovery_lease WHERE id=1)'),
  [FENCE_SQL,[]],
  ['UPDATE discovery_transfer SET state=\'loading\', batches=batches+1 WHERE id=1',[]],
 ]);
 let pending=[];
 const flush=async()=>{
  if(!pending.length)return;
  const current=await readAuthority(env);
  if(!current.ready||current.transfer!=='loading')throw failed('discovery_incomplete');
  await commit(db,[...loadingFence(current.generation,lease),...pending]);
  pending=[];
 };
 try{
  for(const row of prepared){
   const addition=[
    ['INSERT INTO discovery_decision_history (observation_key, revision, generation, written_at, writer, payload_json) SELECT ?, COALESCE((SELECT MAX(revision)+1 FROM discovery_decision_history WHERE observation_key=?),1), ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM discovery_decision WHERE observation_key=? AND decision_hash=?)',[row.key,row.key,gate.generation,new Date().toISOString(),'resolver_chunk',JSON.stringify(row.decision),row.key,row.hash]],
    ['INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, evidence_key, terminal_reason, retry_at, tmdb_id, media_kind, film_id, decision_hash, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(observation_key) DO UPDATE SET programme_run_id=excluded.programme_run_id, generation=excluded.generation, status=excluded.status, attempts=excluded.attempts, evidence_key=excluded.evidence_key, terminal_reason=excluded.terminal_reason, retry_at=excluded.retry_at, tmdb_id=excluded.tmdb_id, media_kind=excluded.media_kind, film_id=excluded.film_id, decision_hash=excluded.decision_hash, payload_json=excluded.payload_json',[row.key,gate.programmeRunId,gate.generation+1,row.decision.status??null,Number.isInteger(row.decision.attempts)?row.decision.attempts:null,row.decision.evidenceKey??null,row.decision.terminalReason??null,row.decision.retryAt??null,row.decision.tmdbId==null?null:String(row.decision.tmdbId),row.decision.tmdbId==null?null:row.kind,row.decision.filmId??null,row.hash,JSON.stringify(row.decision)]],
   ];
   if(pending.length+addition.length+2>STATEMENT_CAP)await flush();
   pending.push(...addition);
  }
  await flush();
  const end=await readAuthority(env);
  await commit(db,[
   ...loadingFence(end.generation,lease),
   ['UPDATE discovery_transfer SET state=\'committed\', batches=batches+1 WHERE id=1',[]],
  ]);
 }catch(error){throw error.code?error:failed('discovery_unavailable',error);}
}
async function readDecisions(env){
 const rows=await many(database(env),'SELECT observation_key, payload_json, decision_hash FROM discovery_decision ORDER BY observation_key');
 if(rows.length>READ_CAP)throw failed('discovery_bounded');
 const map={};
 for(const row of rows){
  let parsed;try{parsed=JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}
  if(await decisionHash(parsed)!==row.decision_hash)throw failed('discovery_unavailable');
  map[row.observation_key]=parsed;
 }
 return map;
}
async function readPayload(env,table){
 const row=await one(database(env),`SELECT payload_json FROM ${table} WHERE id=1`);
 if(!row?.payload_json)return null;
 try{return JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}
}
async function writeStatus(env,value,gate,context){
 const lease=context.lease||leaseOf(env);
 if(!lease||!value||typeof value!=='object')throw failed('discovery_lease');
 const current=await readAuthority(env);
 assertOpen(current);
 const text=JSON.stringify(value);
 if(text.length>200000)throw failed('discovery_bounded');
 const db=database(env);
 await commit(db,[
  fence(current,lease,' AND programme_run_id IS (SELECT programme_run_id FROM discovery_lease WHERE id=1)'),
  [FENCE_SQL,[]],
  ['UPDATE discovery_status SET programme_run_id=?, generation=?, retry_at=?, payload_json=? WHERE id=1',[value.programmeRunId??current.programmeRunId,current.generation+1,typeof value.retryAt==='string'?value.retryAt:null,text]],
  ['UPDATE discovery_checkpoint SET programme_run_id=?, generation=?, hop_id=?, payload_json=? WHERE id=1',[value.programmeRunId??current.programmeRunId,current.generation+1,value.hopId??null,text]],
 ]);
}
async function readScores(env,gate){
 const rows=await many(database(env),'SELECT payload_json FROM discovery_score WHERE programme_run_id IS ? ORDER BY observation_key',[gate.programmeRunId]);
 const items={};
 for(const row of rows){const parsed=JSON.parse(row.payload_json);if(parsed?.observationKey)items[parsed.observationKey]=parsed;}
 return {schemaVersion:1,mode:'on',programmeRunId:gate.programmeRunId,items};
}
async function writeScores(env,value,gate,context){
 const lease=context.lease||leaseOf(env);
 if(!lease)throw failed('discovery_lease');
 const items=value?.items&&typeof value.items==='object'?Object.values(value.items):[];
 if(items.length>64)throw failed('discovery_bounded');
 const current=await readAuthority(env);
 assertOpen(current);
 const db=database(env);
 const inserts=[];
 for(const item of items){
  if(!item?.observationKey)continue;
  inserts.push(['INSERT INTO discovery_score (observation_key, programme_run_id, generation, outcome, reason, payload_json) VALUES (?,?,?,?,?,?)',[item.observationKey,current.programmeRunId,current.generation+1,item.outcome??null,item.reason??null,JSON.stringify(item)]]);
 }
 const opening=[
  fence(current,lease,' AND programme_run_id IS (SELECT programme_run_id FROM discovery_lease WHERE id=1)'),
  [FENCE_SQL,[]],
  ['DELETE FROM discovery_score WHERE programme_run_id IS ?',[current.programmeRunId]],
 ];
 if(opening.length+inserts.length<=STATEMENT_CAP){await commit(db,[...opening,...inserts]);return;}
 await commit(db,[...opening,['UPDATE discovery_transfer SET state=\'loading\', batches=batches+1 WHERE id=1',[]]]);
 let pending=[];
 const flush=async()=>{
  if(!pending.length)return;
  const opened=await readAuthority(env);
  if(!opened.ready||opened.transfer!=='loading')throw failed('discovery_incomplete');
  await commit(db,[...loadingFence(opened.generation,lease),...pending]);
  pending=[];
 };
 try{
  for(const statement of inserts){
   if(pending.length+3>STATEMENT_CAP)await flush();
   pending.push(statement);
  }
  await flush();
  const end=await readAuthority(env);
  await commit(db,[...loadingFence(end.generation,lease),['UPDATE discovery_transfer SET state=\'committed\', batches=batches+1 WHERE id=1',[]]]);
 }catch(error){throw error.code?error:failed('discovery_unavailable',error);}
}

function showsOf(item){
 const shows=Array.isArray(item?.shows)?item.shows:[];
 if(shows.length>SHOW_CAP)throw failed('discovery_bounded');
 return shows.map((show,ordinal)=>({ordinal,channelId:show?.channelId??null,channel:show?.channel??null,start:Number.isFinite(Number(show?.start))?Number(show.start):null,end:Number.isFinite(Number(show?.end))?Number(show.end):null}));
}
function validateItems(items){
 if(!Array.isArray(items))throw failed('discovery_conflict');
 const seen=new Set();
 for(const item of items){
  if(!item||typeof item.key!=='string'||!item.key||item.key.length>200||/[\u0000-\u001f]/.test(item.key)||seen.has(item.key))throw failed('discovery_conflict');
  seen.add(item.key);
  showsOf(item);
 }
}
function itemStatements(item,run){
 const shows=showsOf(item);
 const payload={...item};delete payload.shows;
 const statements=[['INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES (\'active\',?,\'active\',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key, observation_key) DO UPDATE SET residence=\'active\', programme_run_id=excluded.programme_run_id, normalized_title=excluded.normalized_title, title=excluded.title, year=excluded.year, evidence_key=excluded.evidence_key, seen_in_latest=excluded.seen_in_latest, last_seen_at=excluded.last_seen_at, last_airing=excluded.last_airing, confirmed_tmdb_id=excluded.confirmed_tmdb_id, payload_json=excluded.payload_json',[item.key,run,item.normalizedTitle??null,item.title??null,Number.isInteger(item.year)?item.year:null,evidenceKey(item),item.seenInLatestSnapshot===true?1:item.seenInLatestSnapshot===false?0:null,item.lastSeenAt??null,Number.isFinite(Number(item.lastAiring))?Number(item.lastAiring):null,item.confirmedTmdbId==null?null:String(item.confirmedTmdbId),JSON.stringify(payload)]],['DELETE FROM discovery_observation_show WHERE source_key=\'active\' AND observation_key=?',[item.key]]];
 for(const show of shows)statements.push(['INSERT INTO discovery_observation_show (source_key, observation_key, ordinal, channel_id, channel, start_ms, end_ms) VALUES (\'active\',?,?,?,?,?,?)',[item.key,show.ordinal,show.channelId,show.channel,show.start,show.end]]);
 return statements;
}
function loadingFence(generation,lease){
 return [
  ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND lease_id=? AND expires_at>?) AND EXISTS (SELECT 1 FROM discovery_transfer WHERE id=1 AND state=\'loading\')',[generation,lease.id,nowMs()]],
  [FENCE_SQL,[]],
 ];
}
async function beginLedgerSeal(env,run,lease){
  if(!lease)throw failed('discovery_lease');
  const gate=await readAuthority(env);
  const db=database(env);
  if(gate.transfer==='loading'){
   const holder=await one(db,'SELECT lease_id FROM discovery_lease WHERE id=1 AND lease_id=? AND expires_at>?',[lease.id,nowMs()]);
   if(!holder)throw failed('discovery_incomplete');
  }else assertOpen(gate);
  await commit(db,[
   ['UPDATE discovery_lease SET expires_at=?, programme_run_id=COALESCE(programme_run_id,?) WHERE id=1 AND lease_id=? AND expires_at>?',[nowMs()+LEASE_TTL_MS,gate.programmeRunId,lease.id,nowMs()]],
   ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND changes()=1',[gate.generation]],
   [FENCE_SQL,[]],
   ['UPDATE discovery_transfer SET state=\'loading\', programme_run_id=?, batches=batches+1 WHERE id=1',[run]],
   ['UPDATE discovery_observation SET residence=\'retiring\' WHERE source_key=\'active\' AND residence=\'active\'',[]],
  ]);
  let pending=[];
  const flush=async()=>{
   if(!pending.length)return;
   const current=await readAuthority(env);
   if(current.transfer!=='loading')throw failed('discovery_incomplete');
   await commit(db,[...loadingFence(current.generation,lease),...pending]);
   pending=[];
  };
  return {
   async push(item){
    for(const statement of itemStatements(item,run)){
     if(pending.length+3>STATEMENT_CAP)await flush();
     pending.push(statement);
    }
   },
   async finish(){
    await flush();
    const end=await readAuthority(env);
    await commit(db,[
     ...loadingFence(end.generation,lease),
     ['UPDATE discovery_observation_show SET source_key=\'archive:\'||(SELECT programme_run_id||\':\'||(SELECT generation FROM discovery_authority WHERE id=1)||\':\'||observation_key FROM discovery_observation o WHERE o.source_key=\'active\' AND o.residence=\'retiring\' AND o.observation_key=discovery_observation_show.observation_key) WHERE source_key=\'active\' AND observation_key IN (SELECT observation_key FROM discovery_observation WHERE source_key=\'active\' AND residence=\'retiring\')',[]],
     ['UPDATE discovery_observation SET residence=\'archive\', source_key=\'archive:\'||programme_run_id||\':\'||(SELECT generation FROM discovery_authority WHERE id=1)||\':\'||observation_key WHERE source_key=\'active\' AND residence=\'retiring\'',[]],
     ['UPDATE discovery_lease SET programme_run_id=? WHERE id=1 AND lease_id=?',[run,lease.id]],
     ['UPDATE discovery_authority SET programme_run_id=?, published_programme_run_id=? WHERE id=1',[run,run]],
     ['UPDATE discovery_transfer SET state=\'committed\', programme_run_id=?, batches=batches+1 WHERE id=1',[run]],
    ]);
   },
  };
}
export async function replaceLedger(env,document,context={}){
 const lease=context.lease||leaseOf(env);
 if(!document||typeof document!=='object'||!Array.isArray(document.items))throw failed('discovery_conflict');
 const run=typeof document.programmeRunId==='string'?document.programmeRunId:null;
 if(!run)throw failed('discovery_fence');
 validateItems(document.items);
 const seal=await beginLedgerSeal(env,run,lease);
 try{
  for(const item of document.items)await seal.push(item);
  await seal.finish();
 }catch(error){throw error.code?error:failed('discovery_unavailable',error);}
 return {handled:true,items:document.items.length};
}
// One item at a time. The caller is the publish handoff: it already holds the lease, and the
// programme moves only inside the seal. A killed seal stays `loading` until that lease retries it.
export async function ingestLedger(env,spec){
 if(!spec||spec.handoff!==true)throw failed('discovery_fence');
 const run=typeof spec.programmeRunId==='string'?spec.programmeRunId:null;
 if(!run||!spec.items||typeof spec.items[Symbol.asyncIterator]!=='function')throw failed('discovery_fence');
 const lease=spec.lease||leaseOf(env);
 const seal=await beginLedgerSeal(env,run,lease);
 const seen=new Set();
 let count=0;
 try{
  for await(const item of spec.items){
   if(!item||typeof item.key!=='string'||!item.key||item.key.length>200||/[\u0000-\u001f]/.test(item.key)||seen.has(item.key))throw failed('discovery_conflict');
   seen.add(item.key);
   showsOf(item);
   await seal.push(item);
   count++;
  }
  await seal.finish();
 }catch(error){throw error.code?error:failed('discovery_unavailable',error);}
 return {handled:true,items:count};
}
async function readLedger(env,gate){
 const counted=await one(database(env),'SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\'');
 const itemCount=Number(counted?.n||0);
 if(itemCount>READ_CAP)return {programmeRunId:gate.programmeRunId,paged:true,itemCount,items:null,ledgerMode:gate.programmeRunId?'bounded':null};
 const rows=await many(database(env),'SELECT observation_key, payload_json, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\' ORDER BY observation_key');
 const showRows=await many(database(env),'SELECT observation_key, ordinal, channel_id, channel, start_ms, end_ms FROM discovery_observation_show WHERE source_key=\'active\' ORDER BY observation_key, ordinal');
 const shows=new Map();
 for(const show of showRows){const list=shows.get(show.observation_key)||[];list.push({channelId:show.channel_id,channel:show.channel,start:show.start_ms,end:show.end_ms});shows.set(show.observation_key,list);}
 const items=rows.map(row=>{let payload;try{payload=JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}return {...payload,key:row.observation_key,shows:shows.get(row.observation_key)||[]};});
 const archive=await one(database(env),'SELECT COUNT(*) AS n FROM discovery_observation WHERE residence=\'archive\' AND observation_key NOT IN (SELECT observation_key FROM discovery_observation WHERE residence=\'active\')');
 const unreferenced=await one(database(env),'SELECT COUNT(*) AS n FROM discovery_observation WHERE residence=\'unreferenced\'');
 const segments=await one(database(env),'SELECT COUNT(*) AS n FROM discovery_segment WHERE residence=\'archive\'');
 return {programmeRunId:gate.programmeRunId,items,ledgerMode:gate.programmeRunId?'bounded':null,archive:{uniqueArchivedItems:Number(archive?.n||0),unreferencedItems:Number(unreferenced?.n||0),segments:Number(segments?.n||0)}};
}
function observationFromRow(row,shows){
 let payload;try{payload=JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}
 return {...payload,key:row.observation_key,shows:shows||[]};
}
export async function readObservationPage(env,options={}){
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)throw failed('discovery_not_authoritative');
 if(gate.transfer==='loading')throw failed('discovery_incomplete');
 const limit=Math.min(LEDGER_PAGE,Number.isInteger(options.limit)&&options.limit>0?options.limit:LEDGER_PAGE);
 const after=typeof options.after==='string'?options.after:'';
 const rows=await many(database(env),'SELECT observation_key, payload_json FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\' AND observation_key>? ORDER BY observation_key LIMIT ?',[after,limit+1]);
 const more=rows.length>limit;
 const page=more?rows.slice(0,limit):rows;
 const shows=new Map();
 if(page.length){
  const marks=page.map(()=>'?').join(',');
  const showRows=await many(database(env),`SELECT observation_key, channel_id, channel, start_ms, end_ms FROM discovery_observation_show WHERE source_key='active' AND observation_key IN (${marks}) ORDER BY observation_key, ordinal`,page.map(row=>row.observation_key));
  for(const show of showRows){const list=shows.get(show.observation_key)||[];list.push({channelId:show.channel_id,channel:show.channel,start:show.start_ms,end:show.end_ms});shows.set(show.observation_key,list);}
 }
 return {programmeRunId:gate.programmeRunId,items:page.map(row=>observationFromRow(row,shows.get(row.observation_key)||[])),more,after:page.length?page[page.length-1].observation_key:after};
}

function validateCatalog(films){
 if(!films||typeof films!=='object'||Array.isArray(films))throw failed('discovery_conflict');
 const seen=new Set();
 for(const film of Object.values(films)){
  if(!film||typeof film!=='object'||film.tmdbId==null)throw failed('discovery_conflict');
  const kind=mediaKind(film),id=String(film.tmdbId),expected=(kind==='tv'?'tmdb_tv:':'tmdb:')+id;
  if(film.canonicalIdentity!==expected)throw failed('discovery_conflict');
  const token=kind+':'+id;
  if(seen.has(token))throw failed('discovery_conflict');
  seen.add(token);
 }
}
export async function replaceCatalog(env,films,context={}){
 const lease=context.lease||leaseOf(env);
 if(!lease)throw failed('discovery_lease');
 validateCatalog(films);
 const entries=Object.entries(films);
 if(entries.length>READ_CAP)throw failed('discovery_bounded');
 const gate=await readAuthority(env);
 assertOpen(gate);
 const db=database(env);
 const current=gate;
 await commit(db,[
  fence(current,lease,' AND programme_run_id IS (SELECT programme_run_id FROM discovery_lease WHERE id=1)'),
  [FENCE_SQL,[]],
  ['UPDATE discovery_transfer SET state=\'loading\', batches=batches+1 WHERE id=1',[]],
  ['UPDATE discovery_admission SET state=\'pending\' WHERE state=\'current\'',[]],
 ]);
 let pending=[];
 const flush=async()=>{
  if(!pending.length)return;
  const opened=await readAuthority(env);
  if(!opened.ready||opened.transfer!=='loading')throw failed('discovery_incomplete');
  await commit(db,[...loadingFence(opened.generation,lease),...pending]);
  pending=[];
 };
 try{
  for(const [filmId,film] of entries){
   const kind=mediaKind(film);
   if(pending.length+3>STATEMENT_CAP)await flush();
   pending.push(['INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES (?,?,?,?,?,?,?,\'current\',?) ON CONFLICT(film_id) DO UPDATE SET tmdb_id=excluded.tmdb_id, media_kind=excluded.media_kind, canonical_identity=excluded.canonical_identity, observation_key=excluded.observation_key, programme_run_id=excluded.programme_run_id, generation=excluded.generation, state=\'current\', payload_json=excluded.payload_json WHERE discovery_admission.tmdb_id=excluded.tmdb_id AND discovery_admission.media_kind=excluded.media_kind',[filmId,String(film.tmdbId),kind,film.canonicalIdentity,film.observationKey??null,current.programmeRunId,current.generation+1,JSON.stringify(film)]]);
  }
  await flush();
  const end=await readAuthority(env);
  await commit(db,[
   ...loadingFence(end.generation,lease),
   ['UPDATE discovery_admission SET state=\'superseded\' WHERE state=\'pending\'',[]],
   ['UPDATE discovery_transfer SET state=\'committed\', batches=batches+1 WHERE id=1',[]],
  ]);
 }catch(error){throw error.code?error:failed('discovery_unavailable',error);}
 const stuck=await one(db,'SELECT COUNT(*) AS n FROM discovery_admission WHERE state=\'pending\'');
 if(Number(stuck?.n||0)!==0)throw failed('discovery_conflict');
 return {handled:true};
}
async function readCatalog(env){
 const rows=await many(database(env),'SELECT film_id, payload_json, canonical_identity, tmdb_id, media_kind FROM discovery_admission WHERE state=\'current\' ORDER BY film_id');
 if(rows.length>READ_CAP)throw failed('discovery_bounded');
 const catalog={};
 for(const row of rows){
  let film;try{film=JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}
  if(film.canonicalIdentity!==row.canonical_identity||String(film.tmdbId)!==row.tmdb_id)throw failed('discovery_unavailable');
  catalog[row.film_id]=film;
 }
 return catalog;
}

export async function segmentContentSha(items){return digest(canonicalJson(items.map(item=>({key:item.key,payload:item}))));}
export async function importSegment(env,segment){
 if(!segment||typeof segment.sourceKey!=='string'||!segment.sourceKey.startsWith('archive:')||!Array.isArray(segment.items))throw failed('discovery_conflict');
 validateItems(segment.items);
 const sha=await segmentContentSha(segment.items);
 if(segment.contentSha256!==sha)throw failed('discovery_conflict');
 const gate=await readAuthority(env);
 const db=database(env);
 if(gate.transfer==='loading'){
  const live=await one(db,'SELECT lease_id FROM discovery_lease WHERE id=1 AND lease_id IS NOT NULL AND expires_at>?',[nowMs()]);
  if(live?.lease_id)throw failed('discovery_incomplete');
  const partial=await one(db,'SELECT source_key FROM discovery_segment WHERE residence=\'archive\' ORDER BY rowid DESC LIMIT 1');
  if(!partial||partial.source_key!==segment.sourceKey)throw failed('discovery_incomplete');
  await commit(db,[
   ['DELETE FROM discovery_observation_show WHERE source_key=?',[segment.sourceKey]],
   ['DELETE FROM discovery_observation WHERE source_key=?',[segment.sourceKey]],
   ['DELETE FROM discovery_segment WHERE source_key=?',[segment.sourceKey]],
  ]);
 }else assertOpen(gate);
 const seen=new Set();
 for(const item of segment.items){if(seen.has(item.key))throw failed('discovery_conflict');seen.add(item.key);}
 const run=segment.programmeRunId||gate.programmeRunId;
 if(!run)throw failed('discovery_fence');
 const chunks=[];
 let current=[
  ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND NOT EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND expires_at>?)',[gate.generation,nowMs()]],
  [FENCE_SQL,[]],
  ['UPDATE discovery_transfer SET state=\'loading\', batches=batches+1 WHERE id=1',[]],
  ['INSERT INTO discovery_segment (source_key, programme_run_id, residence, r2_key, content_sha256, item_count) VALUES (?,?,\'archive\',?,?,?)',[segment.sourceKey,run,segment.r2Key??null,sha,segment.items.length]],
 ];
 const push=()=>{chunks.push(current);current=[];};
 for(const item of segment.items){
  const shows=showsOf(item);
  const payload={...item};delete payload.shows;
  const row=['INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES (?,?,\'archive\',?,?,?,?,?,?,?,?,?,?)',[segment.sourceKey,item.key,run,item.normalizedTitle??null,item.title??null,Number.isInteger(item.year)?item.year:null,evidenceKey(item),item.seenInLatestSnapshot===true?1:0,item.lastSeenAt??null,Number.isFinite(Number(item.lastAiring))?Number(item.lastAiring):null,item.confirmedTmdbId??null,JSON.stringify(payload)]];
  const rowStatements=[row];
  for(const show of shows)rowStatements.push(['INSERT INTO discovery_observation_show (source_key, observation_key, ordinal, channel_id, channel, start_ms, end_ms) VALUES (?,?,?,?,?,?,?)',[segment.sourceKey,item.key,show.ordinal,show.channelId,show.channel,show.start,show.end]]);
  for(const statement of rowStatements){
   const room=chunks.length===0?STATEMENT_CAP:STATEMENT_CAP-2;
   if(current.length+1>room)push();
   current.push(statement);
  }
 }
 if(current.length)chunks.push(current);
 let generation=gate.generation;
 for(let index=0;index<chunks.length;index++){
  if(index>0){
   const again=await readAuthority(env);
   chunks[index].unshift([FENCE_SQL,[]]);
   chunks[index].unshift(['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND NOT EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND expires_at>?)',[again.generation,nowMs()]]);
   generation=again.generation;
  }
  await commit(db,chunks[index]);
 }
 const end=await readAuthority(env);
 await commit(db,[
  ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND NOT EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND expires_at>?)',[end.generation,nowMs()]],
  [FENCE_SQL,[]],
  ['UPDATE discovery_transfer SET state=\'committed\', batches=batches+1 WHERE id=1',[]],
 ]);
 return {imported:segment.items.length,sha};
}

export async function acquireLease(env,context={}){
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)return {handled:false,lease:null};
 if(gate.transfer==='loading')throw failed('discovery_incomplete');
 if(gate.programmeRunId&&context.programmeRunId&&gate.programmeRunId!==context.programmeRunId)return {handled:true,lease:null};
 const id=crypto.randomUUID(),expiresAt=nowMs()+LEASE_TTL_MS;
 const db=database(env);
 await commit(db,[['UPDATE discovery_lease SET lease_id=?, expires_at=?, programme_run_id=? WHERE id=1 AND (lease_id IS NULL OR expires_at<=?)',[id,expiresAt,context.programmeRunId??gate.programmeRunId??null,nowMs()]]]);
 const row=await one(db,'SELECT lease_id, expires_at, programme_run_id FROM discovery_lease WHERE id=1');
 if(row?.lease_id!==id)return {handled:true,lease:null};
 return {handled:true,lease:{id,expiresAt:Number(row.expires_at)}};
}
export async function renewLease(env,lease,context={}){
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)return {handled:false,ok:false};
 if(!lease?.id)return {handled:true,ok:false};
 const programme=context.programmeRunId??null;
 if(programme&&gate.programmeRunId&&programme!==gate.programmeRunId)return {handled:true,ok:false};
 const expiresAt=nowMs()+LEASE_TTL_MS;
 await commit(database(env),[['UPDATE discovery_lease SET expires_at=? WHERE id=1 AND lease_id=? AND expires_at>? AND programme_run_id IS ?',[expiresAt,lease.id,nowMs(),gate.programmeRunId]]]);
 const row=await one(database(env),'SELECT expires_at FROM discovery_lease WHERE id=1 AND lease_id=?',[lease.id]);
 const ok=Number(row?.expires_at)===expiresAt;
 if(ok)lease.expiresAt=expiresAt;
 return {handled:true,ok};
}
export async function releaseLease(env,lease){
 const gate=await readAuthority(env);
 if(!gate.ready||!lease?.id)return {handled:!!gate.ready};
 await commit(database(env),[['UPDATE discovery_lease SET expires_at=0 WHERE id=1 AND lease_id=?',[lease.id]]]);
 if(env?.discoveryLease?.id===lease.id)env.discoveryLease=null;
 return {handled:true};
}
async function readLeaseValue(env){
 const row=await one(database(env),'SELECT lease_id, expires_at FROM discovery_lease WHERE id=1');
 if(!row?.lease_id)return null;
 return {id:row.lease_id,expiresAt:Number(row.expires_at)};
}
export async function readLease(env){
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)return {handled:false,lease:null};
 return {handled:true,lease:await readLeaseValue(env)};
}

export async function readContinuation(env){
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)return {handled:false,record:null,etag:null};
 const row=await one(database(env),'SELECT revision, payload_json FROM discovery_continuation WHERE id=1');
 let record=null;
 if(row?.payload_json){try{record=JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}}
 return {handled:true,record,etag:'d1:'+Number(row?.revision||0)};
}
export async function writeContinuation(env,record,etag){
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)return {handled:false,saved:false};
 const expected=etag==null?null:etag.startsWith('d1:')?Number(etag.slice(3)):NaN;
 if(etag!=null&&!Number.isInteger(expected))return {handled:true,saved:false};
 const text=JSON.stringify(record??null);
 const revisionSql=expected==null?'id=1':'id=1 AND revision=?';
 const params=expected==null?[record?.programmeRunId??null,text]:[record?.programmeRunId??null,text,expected];
 try{
  await commit(database(env),[
   [`UPDATE discovery_continuation SET programme_run_id=?, payload_json=?, revision=revision+1 WHERE ${revisionSql}`,params],
   ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND changes()=1',[gate.generation]],
   [FENCE_SQL,[]],
  ]);
 }catch(error){if(error.code==='discovery_fence')return {handled:true,saved:false};throw error;}
 return {handled:true,saved:true};
}
export async function readWorkflow(env){
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)return {handled:false,record:null,etag:null};
 const row=await one(database(env),'SELECT revision, payload_json FROM discovery_workflow WHERE id=1');
 let record=null;
 if(row?.payload_json){try{record=JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}}
 return {handled:true,record,etag:'d1:workflow:'+Number(row?.revision||0)};
}
export async function writeWorkflow(env,record,etag){
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)return {handled:false,saved:false};
 const expected=etag==null?null:String(etag).startsWith('d1:workflow:')?Number(String(etag).slice('d1:workflow:'.length)):NaN;
 if(etag!=null&&!Number.isInteger(expected))return {handled:true,saved:false};
 const text=JSON.stringify(record??null);
 const where=expected==null?'id=1':'id=1 AND revision=?';
 const params=expected==null?[record?.instanceId??null,record?.programmeRunId??null,Number.isInteger(record?.series)?record.series:null,text]:[record?.instanceId??null,record?.programmeRunId??null,Number.isInteger(record?.series)?record.series:null,text,expected];
 try{
  await commit(database(env),[
   [`UPDATE discovery_workflow SET instance_id=?, programme_run_id=?, series=?, payload_json=?, revision=revision+1 WHERE ${where}`,params],
   ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND changes()=1',[gate.generation]],
   [FENCE_SQL,[]],
  ]);
 }catch(error){if(error.code==='discovery_fence')return {handled:true,saved:false};throw error;}
 return {handled:true,saved:true};
}

export async function readObservationIndex(env,options={}){
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)return {handled:false,index:null};
 if(gate.transfer==='loading')throw failed('discovery_incomplete');
 if(!gate.programmeRunId)return {handled:true,index:{programmeRunId:null,manifest:null,manifestEtag:null,records:[],state:'unavailable',reasons:['no_published_generation'],generation:null,indexScope:options.scope||'current_unresolved_with_decision',resolutionEtag:null}};
 if(options.expectedGeneration!=null&&options.expectedGeneration!==gate.generation)return {handled:true,index:{programmeRunId:gate.programmeRunId,manifest:null,manifestEtag:'d1:'+gate.generation,records:[],state:'stale',reasons:['generation_moved'],generation:{phase:'published',programmeRunId:gate.programmeRunId,identityAuthority:'d1'},indexScope:options.scope||'current_unresolved_with_decision',resolutionEtag:'d1:'+gate.generation}};
 const verified=options.scope==='current_verified';
 const keyed=typeof options.key==='string'&&options.key.length>0;
 const limit=Number.isInteger(options.limit)?options.limit:INDEX_CAP;
 const rows=keyed
  ?await many(database(env),`SELECT o.observation_key, o.payload_json, o.evidence_key, d.payload_json AS decision_json, d.decision_hash, d.status, d.terminal_reason FROM discovery_observation o JOIN discovery_decision d ON d.observation_key=o.observation_key WHERE o.source_key='active' AND o.residence='active' AND o.observation_key=? AND d.status IS NOT NULL AND d.status<>'excluded_nonfilm' AND ${verified?'d.status=\'verified\'':'d.status<>\'verified\''}`,[options.key])
  :await many(database(env),`SELECT o.observation_key, o.payload_json, o.evidence_key, d.payload_json AS decision_json, d.decision_hash, d.status, d.terminal_reason FROM discovery_observation o JOIN discovery_decision d ON d.observation_key=o.observation_key WHERE o.source_key='active' AND o.residence='active' AND d.status IS NOT NULL AND d.status<>'excluded_nonfilm' AND ${verified?'d.status=\'verified\'':'d.status<>\'verified\''} ORDER BY CASE WHEN d.terminal_reason IS NOT NULL THEN 0 ELSE 1 END, o.observation_key LIMIT ?`,[limit+1]);
 const capped=!keyed&&rows.length>limit;
 const wanted=keyed?rows:rows.slice(0,limit);
 const records=[];
 for(const row of wanted){
  let payload,decision;try{payload=JSON.parse(row.payload_json);decision=JSON.parse(row.decision_json);}catch{return {handled:true,index:indexShell(gate,'malformed')};}
  if(await decisionHash(decision)!==row.decision_hash)return {handled:true,index:indexShell(gate,'malformed')};
  const shows=await many(database(env),'SELECT channel_id, channel, start_ms, end_ms FROM discovery_observation_show WHERE source_key=\'active\' AND observation_key=? ORDER BY ordinal',[row.observation_key]);
  records.push({...payload,key:row.observation_key,shows:shows.map(show=>({channelId:show.channel_id,channel:show.channel,start:show.start_ms,end:show.end_ms})),decision,decisionHash:row.decision_hash,programmeRunId:gate.programmeRunId});
 }
 const again=await readAuthority(env);
 if(again.generation!==gate.generation)return {handled:true,index:{...indexShell(gate,'stale'),reasons:['generation_moved']}};
 return {handled:true,index:{programmeRunId:gate.programmeRunId,manifest:{programmeRunId:gate.programmeRunId,writtenAt:new Date().toISOString(),writer:{kind:'d1'},coverage:{complete:!capped,scope:verified?'current_verified':'current_unresolved_with_decision'},counts:null},manifestEtag:'d1:'+gate.generation,records,state:'fresh',reasons:[],generation:{phase:'published',programmeRunId:gate.programmeRunId,identityAuthority:'d1'},indexScope:verified?'current_verified':'current_unresolved_with_decision',resolutionEtag:'d1:'+gate.generation}};
}
function indexShell(gate,state){return {programmeRunId:gate.programmeRunId,manifest:null,manifestEtag:'d1:'+gate.generation,records:[],state,reasons:[state],generation:{phase:'published',programmeRunId:gate.programmeRunId,identityAuthority:'d1'},indexScope:'current_unresolved_with_decision',resolutionEtag:'d1:'+gate.generation};}

export async function putIntent(env,spec){
 const gate=await readAuthority(env);
 assertOpen(gate);
 if(!spec?.idempotencyKey||!spec.observationKey)throw failed('discovery_conflict');
 const issued=spec.issued&&typeof spec.issued==='object'?JSON.stringify(spec.issued):null;
 const command=spec.command&&typeof spec.command==='object'?JSON.stringify(spec.command):null;
 const expected=typeof spec.expectedHash==='string'?spec.expectedHash:null;
 const expires=Number.isFinite(spec.expiresAt)?spec.expiresAt:null;
 try{
  await commit(database(env),[['INSERT INTO discovery_intent (idempotency_key, kind, state, observation_key, before_json, receipt_json, issued_json, command_json, expected_hash, expires_at, generation) VALUES (?,?,\'approved\',?,NULL,NULL,?,?,?,?,?)',[spec.idempotencyKey,spec.kind,spec.observationKey,issued,command,expected,expires,gate.generation]]]);
 }catch(error){if(error.code==='discovery_conflict')return {saved:false};throw error;}
 return {saved:true};
}
export async function readIntent(env,idempotencyKey){
 const gate=await readAuthority(env);
 if(!gate.ready)return {handled:false,intent:null};
 const row=await one(database(env),'SELECT idempotency_key, kind, state, observation_key, before_json, receipt_json, issued_json, command_json, expected_hash, expires_at, generation FROM discovery_intent WHERE idempotency_key=?',[idempotencyKey]);
 if(!row)return {handled:true,intent:null};
 let issued=null,command=null;
 try{issued=row.issued_json?JSON.parse(row.issued_json):null;command=row.command_json?JSON.parse(row.command_json):null;}catch{throw failed('discovery_unavailable');}
 return {handled:true,intent:{idempotencyKey:row.idempotency_key,kind:row.kind,state:row.state,observationKey:row.observation_key,before:row.before_json?JSON.parse(row.before_json):null,receipt:row.receipt_json?JSON.parse(row.receipt_json):null,issued,command,expectedHash:row.expected_hash??null,expiresAt:row.expires_at==null?null:Number(row.expires_at),generation:row.generation==null?null:Number(row.generation)}};
}
export async function markIntentRunning(env,spec){
 const gate=await readAuthority(env);
 assertOpen(gate);
 const lease=spec.lease||leaseOf(env);
 if(!lease)throw failed('discovery_lease');
 await commit(database(env),[
  ['UPDATE discovery_intent SET state=\'running\', before_json=? WHERE idempotency_key=? AND state=\'approved\'',[JSON.stringify(spec.before??null),spec.idempotencyKey]],
  ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND changes()=1 AND EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND lease_id=? AND expires_at>?)',[gate.generation,lease.id,nowMs()]],
  [FENCE_SQL,[]],
 ]);
 return {running:true};
}
export async function ownerDecision(env,spec){
 const gate=await readAuthority(env);
 assertOpen(gate);
 const existing=await readIntent(env,spec.idempotencyKey);
 if(!existing.handled)throw failed('discovery_not_authoritative');
 if(!existing.intent)return {outcome:'missing'};
 if(existing.intent.receipt)return {outcome:'replay',receipt:existing.intent.receipt};
 if(existing.intent.state==='running')return {outcome:'unknown'};
 const storedExpires=existing.intent.expiresAt;
 if(storedExpires!=null){if(storedExpires<=nowMs())return {outcome:'expired'};}
 else if(spec.expiresAt!=null&&spec.expiresAt<=nowMs())return {outcome:'expired'};
 const key=existing.intent.observationKey;
 if(spec.key&&spec.key!==key)return {outcome:'conflict'};
 if(existing.intent.expectedHash&&spec.expectedHash&&spec.expectedHash!==existing.intent.expectedHash)return {outcome:'conflict'};
 const expectedHash=existing.intent.expectedHash||spec.expectedHash;
 if(existing.intent.command&&spec.next){
  const command=existing.intent.command;
  if(command.effect==='assign'&&(String(spec.next.tmdbId)!==String(command.tmdbId)||spec.next.status!=='verified'))return {outcome:'conflict'};
  if(command.effect==='reject'){
   const ids=Array.isArray(spec.next.rejectedTmdbIds)?spec.next.rejectedTmdbIds.map(String):[];
   if(!ids.includes(String(command.tmdbId)))return {outcome:'conflict'};
  }
 }
 const bound={...spec,key,expectedHash};
 const row=await one(database(env),'SELECT decision_hash, payload_json FROM discovery_decision WHERE observation_key=?',[key]);
 let previous=null;try{previous=row?JSON.parse(row.payload_json):null;}catch{return {outcome:'malformed'};}
 if(!row||await decisionHash(previous)!==row.decision_hash||row.decision_hash!==expectedHash)return {outcome:'conflict'};
 const lease=spec.lease||leaseOf(env);
 if(!lease)return {outcome:'lease'};
 try{await markIntentRunning(env,{idempotencyKey:spec.idempotencyKey,before:previous,lease});}
 catch{return {outcome:'unknown'};}
 try{await commitOwnerWrite(env,bound,previous);}
 catch{return {outcome:'unknown'};}
 const after=await readIntent(env,spec.idempotencyKey);
 return {outcome:'written',receipt:after.intent?.receipt||spec.receipt||null};
}
async function commitOwnerWrite(env,spec,previous){
 const gate=await readAuthority(env);
 const lease=spec.lease||leaseOf(env);
 const nextHash=await decisionHash(spec.next);
 const kind=mediaKind(spec.next);
 const receipt=spec.receipt||{state:'applied',decisionHash:nextHash};
 await commit(database(env),[
  fence(gate,lease,' AND programme_run_id IS (SELECT programme_run_id FROM discovery_lease WHERE id=1) AND EXISTS (SELECT 1 FROM discovery_decision WHERE observation_key=? AND decision_hash=?) AND EXISTS (SELECT 1 FROM discovery_intent WHERE idempotency_key=? AND state=\'running\')',[spec.key,spec.expectedHash,spec.idempotencyKey]),
  [FENCE_SQL,[]],
  ['INSERT INTO discovery_decision_history (observation_key, revision, generation, written_at, writer, payload_json) SELECT ?, COALESCE((SELECT MAX(revision)+1 FROM discovery_decision_history WHERE observation_key=?),1), ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM discovery_decision WHERE observation_key=? AND decision_hash=?)',[spec.key,spec.key,gate.generation,new Date().toISOString(),spec.writer||'owner',JSON.stringify(spec.next),spec.key,spec.expectedHash]],
  ['UPDATE discovery_decision SET programme_run_id=?, generation=?, status=?, attempts=?, evidence_key=?, terminal_reason=?, retry_at=?, tmdb_id=?, media_kind=?, film_id=?, decision_hash=?, payload_json=? WHERE observation_key=? AND decision_hash=?',[gate.programmeRunId,gate.generation+1,spec.next.status??null,Number.isInteger(spec.next.attempts)?spec.next.attempts:null,spec.next.evidenceKey??null,spec.next.terminalReason??null,spec.next.retryAt??null,spec.next.tmdbId==null?null:String(spec.next.tmdbId),spec.next.tmdbId==null?null:kind,spec.next.filmId??null,nextHash,JSON.stringify(spec.next),spec.key,spec.expectedHash]],
  [FENCE_SQL,[]],
  ['UPDATE discovery_intent SET state=\'receipt\', receipt_json=?, generation=? WHERE idempotency_key=? AND state=\'running\'',[JSON.stringify(receipt),gate.generation+1,spec.idempotencyKey]],
  [FENCE_SQL,[]],
 ]);
 if(previous)return;
}

