// D1 authority for discovery observations, decisions, admission, the lease and
// the continuation (ADR 0085). The marker starts at r2. Mode d1 with cutover
// open is the only authority. Held is not that authority: readers stay on R2
// and writers fail closed. A missing binding, or a contract below version 11,
// stays on R2, including schema v10 with the ratings tables and no discovery
// tables. Version 11 without these tables, a bad marker, a loading transfer,
// or a failed read fails closed and does not serve the R2 ledger.
// Nothing here inserts a film or a person, calls TMDB, or starts a chunk.
import {discoveryAdmission,pauseRowWrite,candidateOwedDay,DISCOVERY_EPG_PRIORITY_POLL_MS} from './domain/epg-priority-pause.js';
const TABLES=['discovery_authority','discovery_cas','discovery_transfer','discovery_lease','discovery_continuation','discovery_status','discovery_checkpoint','discovery_workflow','discovery_observation','discovery_observation_show','discovery_decision','discovery_decision_history','discovery_admission','discovery_segment','discovery_score','discovery_intent'];
export const DISCOVERY_TABLES=TABLES;
const FENCE_SQL='UPDATE discovery_cas SET ok=changes() WHERE id=1';
export const LEASE_TTL_MS=90000;
export const STATEMENT_CAP=40;
export const INDEX_CAP=3000;
const READ_CAP=20000;
export const LEDGER_PAGE=500;
export const BIND_CAP=100;
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
function closed(){return {ready:false,held:false,tables:false,windowTable:false,priorityTable:false,mode:'r2',cutover:null,version:null,generation:0,programmeRunId:null,publishedProgrammeRunId:null,transfer:'idle'};}
// AIR-387. One catalog film by TMDB movie id, for the permanent film page. A bounded read-only lookup: one indexed row
// (media_kind, tmdb_id), no catalog scan, no write. It answers every state of that identity, so the caller can tell a film
// that was never admitted from one that was superseded, and it fails closed like `routeRead`: a held cutover, a catalog or
// decision load in progress, or a mid-read change of the authority throws and is never turned into "absent".
export async function readFilmAdmission(env,tmdbId){
 const id=String(tmdbId);
 if(!/^[1-9]\d{0,11}$/.test(id))throw failed('discovery_conflict');
 const opened=await readAuthority(env);
 if(opened.held)throw failed('discovery_fence');
 if(!opened.ready)return {handled:false};
 let sealing=false;
 if(opened.transfer==='loading'){
  if(!await loadingIsLedgerSeal(env))throw failed('discovery_incomplete');
  sealing=true;
 }
 const rows=await many(database(env),"SELECT film_id, payload_json, canonical_identity, tmdb_id, state FROM discovery_admission WHERE media_kind='movie' AND tmdb_id=? ORDER BY film_id",[id]);
 const closedGate=await readAuthority(env);
 if(sealing){if(!closedGate.ready||closedGate.programmeRunId!==opened.programmeRunId||closedGate.transfer!=='loading')throw failed('discovery_fence');}
 else if(!closedGate.ready||closedGate.generation!==opened.generation||closedGate.programmeRunId!==opened.programmeRunId||closedGate.transfer==='loading')throw failed('discovery_fence');
 const records=[];
 for(const row of rows){
  let film;try{film=JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}
  records.push({filmId:String(row.film_id),state:row.state,canonicalIdentity:row.canonical_identity,tmdbId:String(row.tmdb_id),film});
 }
 return {handled:true,records};
}
// AIR-431. Current admitted films by film id, for the prediction runner. One authority check, then indexed lookups in chunks of
// ADMISSION_IDS_PER_QUERY ids; each statement is atomic, so no generation recheck is needed or wanted: a runner step that needs
// 20 films must not fail because an unrelated Discovery chunk moved the generation between two statements. It fails closed like
// `routeRead` for a held cutover or a catalog/decision load in progress; `{handled:false}` means "not D1 authority" (R2 serves).
export const ADMISSION_IDS_PER_QUERY=80;
export async function readAdmissionsById(env,ids){
 const wanted=[...new Set((ids||[]).map(String).filter(Boolean))];
 const opened=await readAuthority(env);
 if(opened.held)throw failed('discovery_fence');
 if(!opened.ready)return {handled:false};
 if(opened.transfer==='loading'&&!await loadingIsLedgerSeal(env))throw failed('discovery_incomplete');
 const films=new Map();
 for(let at=0;at<wanted.length;at+=ADMISSION_IDS_PER_QUERY){
  const slice=wanted.slice(at,at+ADMISSION_IDS_PER_QUERY);
  const rows=await many(database(env),"SELECT film_id, payload_json FROM discovery_admission WHERE state='current' AND film_id IN ("+slice.map(()=>'?').join(',')+')',slice);
  for(const row of rows){
   let film;try{film=JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}
   films.set(String(row.film_id),film);
  }
 }
 return {handled:true,films};
}
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

// ADR 0103 (AIR-383): the exclusive projector window. The table `projector_window` is optional: with it absent (migration 0018 not
// applied) every statement below is exactly what it was before, so a deploy changes nothing. While the row is `requested`, new lease
// acquisition is refused; while it is `held`, the three writers that move the generation without holding the lease are refused
// too, inside their own statement. One absolute deadline covers both states and is never extended; an expired row is idle.
export const WINDOW_DEADLINE_MS=300000;
export const WINDOW_MIN_RUN_MS=120000;
const WINDOW_HELD_SQL=" AND NOT EXISTS (SELECT 1 FROM projector_window WHERE state='held' AND expires_at>?)";
const WINDOW_ACTIVE_SQL=" AND NOT EXISTS (SELECT 1 FROM projector_window WHERE state IN ('requested','held') AND expires_at>?)";
function windowHeldGuard(gate,now=nowMs()){return gate?.windowTable?[WINDOW_HELD_SQL,[now]]:['',[]];}
function windowError(window){const error=failed('discovery_window');error.window={expiresAt:window?.expiresAt??null,state:window?.state??null};return error;}
export async function readProjectorWindow(env,now=nowMs()){
 const row=await one(database(env),'SELECT state, owner, requested_at AS requestedAt, expires_at AS expiresAt FROM projector_window WHERE id=1');
 if(!row)return {present:false,active:false,state:'idle',owner:null,expiresAt:null};
 const expiresAt=Number(row.expiresAt),active=row.state!=='idle'&&Number.isFinite(expiresAt)&&expiresAt>now;
 return {present:true,active,state:active?row.state:'idle',owner:active?row.owner:null,requestedAt:row.requestedAt==null?null:Number(row.requestedAt),expiresAt:active?expiresAt:null};
}
// A writer whose batch the window refused learns why by re-reading the row: a held window is a soft, typed refusal with its
// expiry (the caller waits); anything else stays the ordinary fence failure.
async function throwIfWindowHeld(env,gate,error){
 if(!gate?.windowTable)return;
 let window;try{window=await readProjectorWindow(env);}catch{return;}
 if(window.active&&window.state==='held')throw Object.assign(windowError(window),{cause:error});
}


// ADR 0135 (AIR-459): the EPG-priority Discovery pause. INERT: the table `discovery_epg_priority` is optional. With it absent (migration 0022 not applied)
// every statement below is exactly what it was before, so a deploy changes nothing and there is no flag. With it present, a NEW Discovery admission
// (an `acquireLease` with no `role`, or any role but `epg`) and the three writers that move the generation without holding the lease are refused inside
// their own statement. `renewLease` and `role: 'epg'` are never refused. The rules live in `src/domain/epg-priority-pause.js`; the SQL only binds its facts.
const PRIORITY_TABLE='discovery_epg_priority';
const PRIORITY_PUBLISHED_SQL="EXISTS (SELECT 1 FROM published_epg_authority e, discovery_authority a WHERE e.id=1 AND a.id=1 AND e.madrid_run_key=? AND e.programme_run_id IS NOT NULL AND e.programme_run_id=a.published_programme_run_id)";
const PRIORITY_ADMIT_SQL="EXISTS (SELECT 1 FROM discovery_epg_priority p WHERE p.id=1 AND p.state IN ('clear','paused') AND ("+PRIORITY_PUBLISHED_SQL+" OR p.override_day_key=?))";
// Admission predicate for a statement: published for the candidate day, or overridden for it. A row that is missing or malformed matches nothing.
function priorityGuard(gate,dayKey,holder){
 if(!gate?.priorityTable)return ['',[]];
 if(holder?.id)return [' AND (EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND lease_id=? AND expires_at>?) OR '+PRIORITY_ADMIT_SQL+')',[holder.id,nowMs(),dayKey,dayKey]];
 return [' AND '+PRIORITY_ADMIT_SQL,[dayKey,dayKey]];
}
// The row arm and the clear. Both carry their own predicate, so they write only where it still holds.
const PRIORITY_ARM_SQL="UPDATE discovery_epg_priority SET state='paused', owed_day_key=?, override_day_key=NULL WHERE id=1 AND NOT ("+PRIORITY_PUBLISHED_SQL+" OR COALESCE(override_day_key=?,0)) AND NOT (state='paused' AND owed_day_key=? AND override_day_key IS NULL)";
const PRIORITY_CLEAR_SQL="UPDATE discovery_epg_priority SET state='clear', owed_day_key=NULL, override_day_key=NULL WHERE id=1 AND "+PRIORITY_PUBLISHED_SQL+" AND (state<>'clear' OR override_day_key IS NOT NULL)";
function priorityRowStatements(write,dayKey){
 if(write?.state==='paused')return [[PRIORITY_ARM_SQL,[dayKey,dayKey,dayKey,dayKey]]];
 if(write?.state==='clear')return [[PRIORITY_CLEAR_SQL,[dayKey]]];
 return [];
}
function priorityError(info){const error=failed('discovery_epg_priority');error.priority=info;return error;}
async function readPriorityFacts(env,nowMs_,context){
 const db=database(env);
 const row=await one(db,'SELECT state, owed_day_key AS owedDayKey, override_day_key AS overrideDayKey FROM discovery_epg_priority WHERE id=1');
 const published=await one(db,'SELECT e.madrid_run_key AS publishedDayKey, e.programme_run_id AS publishedProgrammeRunId, a.published_programme_run_id AS handoffProgrammeRunId FROM published_epg_authority e, discovery_authority a WHERE e.id=1 AND a.id=1');
 return {tablePresent:true,action:'acquire',role:context.role??null,nowMs:nowMs_,row:row||null,...(published||{}),requestedProgrammeRunId:context.programmeRunId??null};
}
// Who holds what, for the answer only (never for a decision): the kind and the expiry. No Film id, no SQL, no continuation body.
async function readPriorityHold(env,gate,now){
 const db=database(env);
 if(gate.windowTable){
  const window=await readProjectorWindow(env,now);
  if(window.active&&window.state==='held')return {ownerKind:'projector',holdExpiresAt:window.expiresAt};
 }
 const lease=await one(db,'SELECT lease_id, expires_at AS expiresAt, holder_kind AS holderKind FROM discovery_lease WHERE id=1');
 const expiresAt=Number(lease?.expiresAt);
 if(lease?.lease_id&&Number.isFinite(expiresAt)&&expiresAt>now)return {ownerKind:lease.holderKind==='epg'?'epg':'discovery',holdExpiresAt:expiresAt};
 return {ownerKind:'none',holdExpiresAt:null};
}
async function priorityBusy(env,gate,decision,now){
 const hold=await readPriorityHold(env,gate,now);
 return {kind:'epg_priority',expiresAt:null,owedDayKey:decision.owedDayKey,nextCatchUpAt:decision.nextCatchUpAt,pollMs:DISCOVERY_EPG_PRIORITY_POLL_MS,...hold};
}
// A lease-free writer whose batch the pause refused learns why by re-asking the pure contract: a soft, typed refusal (the caller waits);
// anything else stays the ordinary fence failure.
async function throwIfPriorityPaused(env,gate,error,context={}){
 if(!gate?.priorityTable)return;
 let decision;
 try{decision=discoveryAdmission(await readPriorityFacts(env,nowMs(),context));}catch{return;}
 if(decision.reason!=='epg_priority')return;
 throw Object.assign(priorityError(await priorityBusy(env,gate,decision,nowMs())),{cause:error});
}

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
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'discovery\\_%' ESCAPE '\\' OR name='projector_window')")).map(row=>row.name);}
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
 return {ready,held,tables:true,windowTable:names.includes('projector_window'),priorityTable:names.includes(PRIORITY_TABLE),mode:row.mode,cutover:row.cutover,version:numeric,generation:Number(row.generation),programmeRunId:row.programmeRunId??null,publishedProgrammeRunId:row.publishedProgrammeRunId??null,transfer:transfer.state};
}

function assertOpen(gate){
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)throw failed('discovery_not_authoritative');
 if(gate.transfer==='loading')throw failed('discovery_incomplete');
}

// ADR 0091. A ledger seal that stopped before it finished leaves the transfer `loading`. The seal writes only the active
// ledger (observations and their shows), the transfer row, the lease and the generation; it never writes the catalog, the
// status or the continuation. Those three keys stay readable while the loading transfer is a ledger seal, and the answer
// says so. Every other owned key, every write and every ledger-dependent read stays closed.
const SEAL_SAFE_KEYS=new Set(['epg/discovered-films.json','epg/discovery-status.json','epg/resolver-continuation.json']);
function sealSafeKey(key){return SEAL_SAFE_KEYS.has(key)||(generationRequest(key)!==null&&key.endsWith('discovered-films.json'));}
// `loading` is a ledger seal, and not a catalog, decision or segment load in progress, only when the ledger is mid-handoff
// (retiring rows, or a transfer for another programme) and no admission is pending.
async function loadingIsLedgerSeal(env){
 if(!await ledgerSealLoading(env))return false;
 const pending=await one(database(env),"SELECT 1 AS n FROM discovery_admission WHERE state='pending' LIMIT 1");
 return !pending;
}
export async function routeRead(env,key){
 if(!ownsKey(key))return {handled:false};
 const opened=await readAuthority(env);
 if(!opened.ready)return {handled:false};
 let sealing=false;
 if(opened.transfer==='loading'){
  if(!sealSafeKey(key)||!await loadingIsLedgerSeal(env))throw failed('discovery_incomplete');
  sealing=true;
 }
 const requested=generationRequest(key);
 if(sealing&&requested&&requested!==opened.programmeRunId)return {handled:true,value:null,transfer:'loading'};
 const value=await readKey(env,key,opened);
 const closedGate=await readAuthority(env);
 // A seal moves the generation with every batch; that does not touch these keys, so a sealing read is stable while the
 // authority, the programme and the loading state hold, and a finished or restarted seal fails the read.
 if(sealing){
  if(!closedGate.ready||closedGate.programmeRunId!==opened.programmeRunId||closedGate.transfer!=='loading'||!await loadingIsLedgerSeal(env))throw failed('discovery_fence');
  return {handled:true,value,transfer:'loading'};
 }
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
// AIR-386: the whole decisions document is read in keyset pages, never as one unbounded SELECT. A page is DECISION_PAGE rows, so one
// query result and one array stay small however many decisions exist; the Map that old readers still need is the only whole copy,
// and it is bounded by an explicit budget (payload bytes are one component of the heap: the parsed Map costs a small multiple of them, so the byte budget is deliberately well below the Worker's 128 MiB) (rows and UTF-8 payload bytes) instead of the 20000-row READ_CAP that stopped the D1 projector
// once the table reached 20001 rows. Over the budget the read fails closed as `discovery_bounded`; nothing is truncated.
// Consistency: the pages are separate statements, but every decision writer moves the authority generation in the same batch, and
// routeRead compares the generation before and after the read (`discovery_fence` on a change), so a read that raced a writer is
// refused whole and never returns missing, duplicated or mixed pages. Every row is still verified against its decision_hash.
export const DECISION_PAGE=1000;
export const DECISION_READ_ROWS=100000;
export const DECISION_READ_BYTES=16*1024*1024;
const utf8=new TextEncoder();
async function readDecisions(env){
 const db=database(env);
 const map={};
 let after=null,total=0,bytes=0;
 for(;;){
  const rows=after===null
   ?await many(db,'SELECT observation_key, payload_json, decision_hash FROM discovery_decision ORDER BY observation_key LIMIT ?',[DECISION_PAGE])
   :await many(db,'SELECT observation_key, payload_json, decision_hash FROM discovery_decision WHERE observation_key>? ORDER BY observation_key LIMIT ?',[after,DECISION_PAGE]);
  for(const row of rows){
   total++;
   bytes+=utf8.encode(String(row.payload_json??'')).length;
   if(total>DECISION_READ_ROWS||bytes>DECISION_READ_BYTES)throw failed('discovery_bounded');
   let parsed;try{parsed=JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}
   if(await decisionHash(parsed)!==row.decision_hash)throw failed('discovery_unavailable');
   map[row.observation_key]=parsed;
  }
  if(rows.length<DECISION_PAGE)return map;
  after=rows[rows.length-1].observation_key;
 }
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
 // Every show is stored. A long list spans statement batches; it is not trimmed,
 // because the evidence key is the full list. The observation index has its own
 // smaller bound and does not remove these rows.
 const shows=Array.isArray(item?.shows)?item.shows:[];
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
const OBSERVATION_INSERT='INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES ';
const OBSERVATION_ROW='(\'active\',?,\'active\',?,?,?,?,?,?,?,?,?,?)';
const OBSERVATION_ROW_BINDS=11;
const OBSERVATION_CONFLICT=' ON CONFLICT(source_key, observation_key) DO UPDATE SET residence=\'active\', programme_run_id=excluded.programme_run_id, normalized_title=excluded.normalized_title, title=excluded.title, year=excluded.year, evidence_key=excluded.evidence_key, seen_in_latest=excluded.seen_in_latest, last_seen_at=excluded.last_seen_at, last_airing=excluded.last_airing, confirmed_tmdb_id=excluded.confirmed_tmdb_id, payload_json=excluded.payload_json';
function observationUpsert(item,run){
 const shows=showsOf(item);
 const payload={...item};delete payload.shows;
 const values=[item.key,run,item.normalizedTitle??null,item.title??null,Number.isInteger(item.year)?item.year:null,evidenceKey(item),item.seenInLatestSnapshot===true?1:item.seenInLatestSnapshot===false?0:null,item.lastSeenAt??null,Number.isFinite(Number(item.lastAiring))?Number(item.lastAiring):null,item.confirmedTmdbId==null?null:String(item.confirmedTmdbId),JSON.stringify(payload)];
 const upsert=[OBSERVATION_INSERT+OBSERVATION_ROW+OBSERVATION_CONFLICT,values];
 return {upsert,values,shows:shows.map(show=>[item.key,show.ordinal,show.channelId,show.channel,show.start,show.end])};
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
// programme moves only inside the seal. A killed seal stays `loading` and is not
// served. The same live lease may retry it. Once that lease expires or is
// released, the next handoff takes a new lease and replays the seal when the
// in-progress programme differs from the published programme, or retiring rows
// are present. Partial rows stay unserved until that replay commits. The
// interrupted lease cannot commit after the takeover. A catalog, decision or
// segment load is not taken over.
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
async function ledgerArchive(env){
 const archive=await one(database(env),'SELECT COUNT(*) AS n FROM discovery_observation WHERE residence=\'archive\' AND observation_key NOT IN (SELECT observation_key FROM discovery_observation WHERE residence=\'active\')');
 const unreferenced=await one(database(env),'SELECT COUNT(*) AS n FROM discovery_observation WHERE residence=\'unreferenced\'');
 const segments=await one(database(env),'SELECT COUNT(*) AS n FROM discovery_segment WHERE residence=\'archive\'');
 // These are D1 rows only. The immutable archive lives in R2 segments and may never have been imported, so a zero here is not an
 // empty archive: the counts are named for what they are and never stand for the archive as a whole.
 return {source:'d1',d1:{archiveOnlyRows:Number(archive?.n||0),unreferencedRows:Number(unreferenced?.n||0),segmentRows:Number(segments?.n||0)}};
}
// D1 does not store the ledger mode of a generation. The rows of the active ledger are the same whether the generation was written
// `full`, `frozen` or `bounded`, so every D1 read of the ledger answers `unknown`; a reader that needs the mode proves it from the
// generation document (see `sealSource`).
const LEDGER_MODE_UNPROVEN='unknown';
// The completed seal of a generation: which R2 document was sealed, its etag, and the byte offset just past its last item. One read,
// no authority gate (the caller already holds a consistent read of the ledger); null when the table or the row is not there.
export async function sealSource(env){
 const db=database(env);
 if(!db)return null;
 let row;
 try{row=await one(db,'SELECT programme_run_id, source_key, source_etag, item_total, cursor_items, cursor_bytes, phase FROM discovery_seal WHERE id=1');}
 catch(error){
  if(/no such table/i.test(String(error?.message||error)))return null;
  throw failed('discovery_unavailable',error);
 }
 if(!row)return null;
 return {programmeRunId:row.programme_run_id??null,sourceKey:row.source_key??null,sourceEtag:row.source_etag??null,itemTotal:Number(row.item_total||0),cursorItems:Number(row.cursor_items||0),cursorBytes:Number(row.cursor_bytes||0),phase:row.phase};
}
function decisionFromRow(row){
 if(!row?.payload_json)return null;
 let parsed;try{parsed=JSON.parse(row.payload_json);}catch{throw failed('discovery_unavailable');}
 return parsed;
}
function pageKeySet(rows){
 const keys=new Set();
 for(const row of rows)keys.add(row.observation_key);
 return keys;
}
async function loadPageShows(env,after,lastKey,pageKeys){
 const showRows=await many(database(env),'SELECT observation_key, channel_id, channel, start_ms, end_ms FROM discovery_observation_show WHERE source_key=\'active\' AND observation_key>? AND observation_key<=? ORDER BY observation_key, ordinal',[after,lastKey]);
 const shows=new Map();
 for(const show of showRows){
  if(!pageKeys.has(show.observation_key))continue;
  const list=shows.get(show.observation_key)||[];
  list.push({channelId:show.channel_id,channel:show.channel,start:show.start_ms,end:show.end_ms});
  shows.set(show.observation_key,list);
 }
 return shows;
}
async function loadPageDecisions(env,after,lastKey,pageKeys){
 const decisionRows=await many(database(env),'SELECT observation_key, payload_json FROM discovery_decision WHERE observation_key>? AND observation_key<=?',[after,lastKey]);
 const decisions=new Map();
 for(const row of decisionRows){
  if(!pageKeys.has(row.observation_key))continue;
  decisions.set(row.observation_key,decisionFromRow(row));
 }
 return decisions;
}
async function visitActivePage(env,after,limit,visit){
 const rows=await many(database(env),'SELECT observation_key, payload_json FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\' AND observation_key>? ORDER BY observation_key LIMIT ?',[after,limit]);
 if(!rows.length)return {after,count:0};
 const lastKey=rows[rows.length-1].observation_key;
 const pageKeys=pageKeySet(rows);
 const shows=await loadPageShows(env,after,lastKey,pageKeys);
 const decisions=await loadPageDecisions(env,after,lastKey,pageKeys);
 for(const row of rows)await visit(observationFromRow(row,shows.get(row.observation_key)||[]),decisions.get(row.observation_key)||null);
 return {after:lastKey,count:rows.length};
}
// Status and footer count every active observation without holding the ledger
// or the decision map. A page is LEDGER_PAGE rows. Shows and decisions for that
// page are a two-bind key range, then filtered to the page keys, so a query
// stays at or under BIND_CAP (D1's 100 bound parameters). READ_CAP stays the
// bound for a whole-document read; this walk is not that read and does not raise it.
export async function streamActiveLedger(env,visit){
 const opened=await readAuthority(env);
 if(!opened.ready)return {handled:false};
 if(opened.transfer==='loading')throw failed('discovery_incomplete');
 const counted=await one(database(env),'SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\'');
 const itemCount=Number(counted?.n||0);
 const archive=await ledgerArchive(env);
 let after='';
 for(;;){
  const page=await visitActivePage(env,after,LEDGER_PAGE,visit);
  if(!page.count)break;
  after=page.after;
  if(page.count<LEDGER_PAGE)break;
 }
 const closedGate=await readAuthority(env);
 if(!closedGate.ready||closedGate.generation!==opened.generation||closedGate.programmeRunId!==opened.programmeRunId||closedGate.transfer==='loading')throw failed('discovery_fence');
 return {handled:true,programmeRunId:opened.programmeRunId,itemCount,ledgerMode:opened.programmeRunId?LEDGER_MODE_UNPROVEN:null,archive};
}
async function readLedger(env,gate){
 const counted=await one(database(env),'SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\'');
 const itemCount=Number(counted?.n||0);
 if(itemCount>READ_CAP)return {programmeRunId:gate.programmeRunId,paged:true,itemCount,items:null,ledgerMode:gate.programmeRunId?LEDGER_MODE_UNPROVEN:null,archive:await ledgerArchive(env)};
 const rows=await many(database(env),'SELECT observation_key, payload_json, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\' ORDER BY observation_key');
 const showRows=await many(database(env),'SELECT observation_key, ordinal, channel_id, channel, start_ms, end_ms FROM discovery_observation_show WHERE source_key=\'active\' ORDER BY observation_key, ordinal');
 const shows=new Map();
 for(const show of showRows){const list=shows.get(show.observation_key)||[];list.push({channelId:show.channel_id,channel:show.channel,start:show.start_ms,end:show.end_ms});shows.set(show.observation_key,list);}
 const items=rows.map(row=>observationFromRow(row,shows.get(row.observation_key)||[]));
 return {programmeRunId:gate.programmeRunId,items,ledgerMode:gate.programmeRunId?LEDGER_MODE_UNPROVEN:null,archive:await ledgerArchive(env)};
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
  const loaded=await loadPageShows(env,after,page[page.length-1].observation_key,pageKeySet(page));
  for(const [key,list] of loaded)shows.set(key,list);
 }
 return {programmeRunId:gate.programmeRunId,items:page.map(row=>observationFromRow(row,shows.get(row.observation_key)||[])),more,after:page.length?page[page.length-1].observation_key:after};
}
// A chunk's whole-ledger read, in key-range pages that load `concurrency` at a time. The page starts come from one
// query, so a range is exactly LEDGER_PAGE rows and no page waits for its predecessor's last key. Pages reach
// `onPage` in key order. `beforeBatch` runs before each batch of loads, which is where the caller renews its lease
// (a read this long can outlast the lease TTL). `shouldStop` (the caller's budget check) stops it between batches with `complete: false`. The walk reads and writes nothing else; it fails closed when the
// authority marker, the programme or the generation changed while it ran.
export async function walkObservationPages(env,options={}){
 const opened=await readAuthority(env);
 if(opened.held)throw failed('discovery_fence');
 if(!opened.ready)throw failed('discovery_not_authoritative');
 if(opened.transfer==='loading')throw failed('discovery_incomplete');
 const concurrency=Math.max(1,Math.min(6,Number.isInteger(options.concurrency)&&options.concurrency>0?options.concurrency:4));
 const db=database(env);
 const starts=(await many(db,'SELECT observation_key FROM (SELECT observation_key, ROW_NUMBER() OVER (ORDER BY observation_key) AS rn FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\') WHERE (rn-1)%?=0 ORDER BY observation_key',[LEDGER_PAGE])).map(row=>row.observation_key);
 const load=async index=>{
  const from=starts[index],to=index+1<starts.length?starts[index+1]:null;
  const range=to==null?' AND observation_key>=?':' AND observation_key>=? AND observation_key<?',params=to==null?[from]:[from,to];
  const rows=await many(db,'SELECT observation_key, payload_json FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\''+range+' ORDER BY observation_key',params);
  const showRows=await many(db,'SELECT observation_key, channel_id, channel, start_ms, end_ms FROM discovery_observation_show WHERE source_key=\'active\''+range+' ORDER BY observation_key, ordinal',params);
  const shows=new Map();
  for(const show of showRows){
   const list=shows.get(show.observation_key)||[];
   list.push({channelId:show.channel_id,channel:show.channel,start:show.start_ms,end:show.end_ms});
   shows.set(show.observation_key,list);
  }
  return rows.map(row=>observationFromRow(row,shows.get(row.observation_key)||[]));
 };
 let items=0,complete=true;
 for(let index=0;index<starts.length;index+=concurrency){
  // Out of budget: stop between batches. The caller learns the ledger was not fully read and must not select from it.
  if(options.shouldStop&&options.shouldStop()){complete=false;break;}
  if(options.beforeBatch)await options.beforeBatch({page:index,pages:starts.length});
  const batch=await Promise.all(Array.from({length:Math.min(concurrency,starts.length-index)},(_,offset)=>load(index+offset)));
  for(const page of batch){items+=page.length;await options.onPage(page);}
 }
 const closed=await readAuthority(env);
 if(closed.held||!closed.ready||closed.generation!==opened.generation||closed.programmeRunId!==opened.programmeRunId||closed.transfer==='loading')throw failed('discovery_fence');
 return {programmeRunId:opened.programmeRunId,pages:starts.length,items,complete};
}

// Mirrors resolutionActionability except the title non-film screen (JavaScript only). Same-evidence
// excluded_nonfilm rows stay out: a screen-rule change without an evidence_key change is a follow-up.
// A missing decision evidence_key is "same", as in JS. Verified rows are never TMDB-actionable.
const ACTIONABLE_SAME=`(d.evidence_key IS NULL OR d.evidence_key=o.evidence_key)`;
const ACTIONABLE_FROM=`FROM discovery_observation o
LEFT JOIN discovery_decision d ON d.observation_key=o.observation_key
WHERE o.source_key='active' AND o.residence='active'
 AND o.seen_in_latest=1
 AND EXISTS (SELECT 1 FROM discovery_observation_show s WHERE s.source_key='active' AND s.observation_key=o.observation_key AND s.start_ms>=? AND s.start_ms<?)
 AND IFNULL(d.status,'')<>'verified'
 AND (
  d.observation_key IS NULL
  OR NOT ${ACTIONABLE_SAME}
  OR (
   IFNULL(d.status,'')<>'excluded_nonfilm'
   AND (d.terminal_reason IS NULL OR d.terminal_reason='')
   AND (d.retry_at IS NULL OR d.retry_at<=?)
  )
 )`;
const TOUCH_FROM=`FROM discovery_observation o
JOIN discovery_decision d ON d.observation_key=o.observation_key
WHERE o.source_key='active' AND o.residence='active' AND o.seen_in_latest=1 AND d.status='verified'
 AND EXISTS (SELECT 1 FROM discovery_observation_show s WHERE s.source_key='active' AND s.observation_key=o.observation_key AND s.start_ms>=? AND s.start_ms<?)`;
export const ACTIONABLE_COUNT_SQL='SELECT COUNT(*) AS n '+ACTIONABLE_FROM;
export const ACTIONABLE_PAGE_SQL='SELECT o.observation_key, o.payload_json, d.payload_json AS decision_json '+ACTIONABLE_FROM+' AND o.observation_key>? ORDER BY o.observation_key LIMIT ?';
export const TOUCH_PAGE_SQL='SELECT o.observation_key, o.payload_json, d.payload_json AS decision_json '+TOUCH_FROM+' AND o.observation_key>? ORDER BY o.observation_key LIMIT ?';
export const SELECT_PAGE=80;
export const SELECT_QUERIES=6;

// A paged chunk's candidate set: current-window observations that JS would still treat as
// resolution-actionable (without the title screen), as a keyset, never the whole ledger.
// `remaining` is that SQL set's size at selection time. `touches` are a keyset page of current
// verified rows so the cheap pass can copy airings without walking every verified observation.
// `touchAfter` is the last key of that page (wraps once). The same generation fence as the full walk.
export async function selectActionableObservations(env,options={}){
 const opened=await readAuthority(env);
 if(opened.held)throw failed('discovery_fence');
 if(!opened.ready)throw failed('discovery_not_authoritative');
 if(opened.transfer==='loading')throw failed('discovery_incomplete');
 const now=Number.isFinite(options.now)?options.now:Date.now();
 const from=now-72*3600000,to=now+24*3600000,nowIso=new Date(now).toISOString();
 const pageSize=Math.min(LEDGER_PAGE,Math.max(1,Number.isInteger(options.pageSize)&&options.pageSize>0?options.pageSize:SELECT_PAGE));
 const maxQueries=Math.max(1,Math.min(8,Number.isInteger(options.maxQueries)&&options.maxQueries>0?options.maxQueries:SELECT_QUERIES));
 const startAfter=typeof options.after==='string'?options.after:'';
 const db=database(env);
 const windowParams=[from,to,nowIso];
 if(options.beforeQuery)await options.beforeQuery({query:0,after:startAfter,phase:'count'});
 const counted=await one(db,ACTIONABLE_COUNT_SQL,windowParams);
 const remaining=Number(counted?.n||0);
 const items=[];
 let cursor=startAfter,wrapped=false,queries=0,complete=false;
 while(items.length<pageSize&&queries<maxQueries){
  if(options.shouldStop&&options.shouldStop())break;
  if(options.beforeQuery)await options.beforeQuery({query:queries,after:cursor});
  const take=pageSize-items.length;
  const rows=await many(db,ACTIONABLE_PAGE_SQL,[...windowParams,cursor,take]);
  queries++;
  if(!rows.length){
   if(!cursor||wrapped){complete=true;break;}
   cursor='';wrapped=true;continue;
  }
  const shows=await loadPageShows(env,cursor,rows[rows.length-1].observation_key,pageKeySet(rows));
  for(const row of rows){
   cursor=row.observation_key;
   items.push({candidate:observationFromRow(row,shows.get(row.observation_key)||[]),decision:row.decision_json?decisionFromRow({payload_json:row.decision_json}):null});
  }
  if(rows.length<take){
   if(wrapped||!startAfter){complete=true;break;}
   cursor='';wrapped=true;
  }
 }
 if(options.beforeQuery)await options.beforeQuery({query:queries,after:cursor,phase:'touches'});
 const touchLimit=Math.max(0,Number.isInteger(options.touchLimit)?options.touchLimit:0);
 const startTouchAfter=typeof options.touchAfter==='string'?options.touchAfter:'';
 let touchCursor=startTouchAfter,touchWrapped=false,touchRows=[];
 if(touchLimit){
  touchRows=await many(db,TOUCH_PAGE_SQL,[from,to,touchCursor,touchLimit]);
  queries++;
  if(!touchRows.length&&touchCursor){
   touchCursor='';
   touchWrapped=true;
   if(options.beforeQuery)await options.beforeQuery({query:queries,after:touchCursor,phase:'touches'});
   touchRows=await many(db,TOUCH_PAGE_SQL,[from,to,touchCursor,touchLimit]);
   queries++;
  }
 }
 const touches=[];
 if(touchRows.length){
  const shows=await loadPageShows(env,touchCursor,touchRows[touchRows.length-1].observation_key,pageKeySet(touchRows));
  for(const row of touchRows){
   touchCursor=row.observation_key;
   touches.push({candidate:observationFromRow(row,shows.get(row.observation_key)||[]),decision:decisionFromRow({payload_json:row.decision_json})});
  }
 }
 const closed=await readAuthority(env);
 if(closed.held||!closed.ready||closed.generation!==opened.generation||closed.programmeRunId!==opened.programmeRunId||closed.transfer==='loading')throw failed('discovery_fence');
 return {programmeRunId:opened.programmeRunId,items,touches,after:cursor,touchAfter:touchCursor,wrapped,touchWrapped,queries,remaining,complete};
}

// ADR 0092. The ledger seal is a resumable job instead of one request. `discovery_seal` (schema 12) holds its identity
// and cursor; every batch of observation rows moves the cursor in the SAME D1 batch (compare-and-set on `cursor_items`),
// so a request that dies leaves the rows and the cursor agreeing. The batch itself is idempotent (an upsert and a
// delete-and-insert of the shows), so a replay after an unknown outcome is safe. The previous ledger is flipped to
// `retiring` once, when the job begins, and never again for the same job. The ledger stays unpublished until every
// observation is written and every retiring row is archived; the commit is the last batch.
const SEAL_BATCH_OVERHEAD=5;
const SEAL_SHOW_ROWS=16;
const SEAL_KEYS_PER_DELETE=80;
// AIR-420. A batch is one D1 round trip, and the round trip, not the SQL, is what a seal step pays for (on 10 November 2026 a
// batch of about 30 observations cost about 9 round trips of about 200 ms each while its SQL took milliseconds). So the rows of a
// batch are packed: several observations in one upsert statement (11 binds a row under D1's 100) bounded by the size of their
// payloads, and the keys of the show delete in slices of 80. The statement cap of a batch is unchanged.
const SEAL_ROWS_PER_UPSERT=Math.floor(BIND_CAP/OBSERVATION_ROW_BINDS);
const SEAL_UPSERT_BYTES=200000;
const SEAL_ITEMS_PER_BATCH=400;
// A batch of the production ledger is about 190 kB (10 November 2026); the cap keeps a ledger of much larger payloads near that.
const SEAL_BATCH_BYTES=400000;
const SEAL_ENCODER=new TextEncoder();
export async function sealSupported(env){
 try{return !!await one(database(env),"SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='discovery_seal'");}
 catch{return false;}
}
async function readSeal(env){
 return await one(database(env),'SELECT job_id, programme_run_id, source_key, source_etag, item_total, cursor_items, cursor_bytes, phase, updated_at FROM discovery_seal WHERE id=1');
}
export async function sealState(env){
 if(!await sealSupported(env))return {supported:false};
 const row=await readSeal(env);
 const gate=await readAuthority(env);
 if(!row)return {supported:true,phase:'idle',transfer:gate.transfer};
 return {supported:true,phase:row.phase,jobId:row.job_id??null,programmeRunId:row.programme_run_id??null,sourceKey:row.source_key??null,sourceEtag:row.source_etag??null,itemTotal:Number(row.item_total||0),cursorItems:Number(row.cursor_items||0),cursorBytes:Number(row.cursor_bytes||0),transfer:gate.transfer,updatedAt:row.updated_at??null};
}
// Begins a job, or reports that the same job is already running. A job for another source, or a `loading` transfer
// that has no job (the interrupted handoff of the old inline seal), starts over: the previous ledger and whatever an
// earlier attempt wrote are flipped to `retiring` in one batch, together with the job row.
export async function sealBegin(env,spec){
 const lease=spec.lease||leaseOf(env);
 if(!lease)throw failed('discovery_lease');
 if(!await sealSupported(env))throw failed('discovery_unavailable');
 const run=typeof spec.programmeRunId==='string'&&spec.programmeRunId?spec.programmeRunId:null;
 if(!run||typeof spec.jobId!=='string'||!spec.jobId||typeof spec.sourceKey!=='string'||!Number.isInteger(spec.itemTotal)||spec.itemTotal<0)throw failed('discovery_conflict');
 const gate=await readAuthority(env);
 const db=database(env);
 const current=await readSeal(env);
 if(current&&current.job_id===spec.jobId&&(current.phase==='items'||current.phase==='archive')&&gate.transfer==='loading')return {resumed:true,...await sealState(env)};
 if(current&&current.job_id===spec.jobId&&current.phase==='done')return {resumed:true,...await sealState(env)};
 const now=nowMs(),updated=new Date(now).toISOString();
 const fenceStatements=gate.transfer==='loading'?(()=>{return loadingFence(gate.generation,lease);})():(()=>{assertOpen(gate);return [fence(gate,lease,' AND programme_run_id IS (SELECT programme_run_id FROM discovery_lease WHERE id=1)'),[FENCE_SQL,[]]];})();
 if(gate.transfer==='loading'){
  const holder=await one(db,'SELECT lease_id FROM discovery_lease WHERE id=1 AND lease_id=? AND expires_at>?',[lease.id,now]);
  if(!holder)throw failed('discovery_incomplete');
 }
 await commit(db,[
  ...fenceStatements,
  ['UPDATE discovery_lease SET expires_at=?, programme_run_id=COALESCE(programme_run_id,?) WHERE id=1 AND lease_id=? AND expires_at>?',[now+LEASE_TTL_MS,gate.programmeRunId,lease.id,now]],
  ['UPDATE discovery_transfer SET state=\'loading\', programme_run_id=?, batches=batches+1 WHERE id=1',[run]],
  ['UPDATE discovery_observation SET residence=\'retiring\' WHERE source_key=\'active\' AND residence=\'active\'',[]],
  ['UPDATE discovery_seal SET job_id=?, programme_run_id=?, source_key=?, source_etag=?, item_total=?, cursor_items=0, cursor_bytes=?, phase=\'items\', updated_at=? WHERE id=1',[spec.jobId,run,spec.sourceKey,spec.sourceEtag??null,spec.itemTotal,Number.isInteger(spec.startBytes)?spec.startBytes:0,updated]],
 ]);
 return {resumed:false,...await sealState(env)};
}
// One atomic batch: the fence, a lease renewal, the observation rows of as many of `items` as fit, and the cursor move.
// `items` are `{item,bytes}` where `bytes` is the length the item takes in the source document including its separator.
// Returns how many were written. A cursor that is not `expectedCursor` is a lost race and writes nothing.
//
// AIR-420. `spec.carried` is what the previous batch of the SAME step returned in `carried` ({generation, programmeRunId,
// cursorBytes}). With it the batch is sent without reading the authority and the job first: those reads only chose the values the
// batch itself checks, atomically, by compare-and-set (the generation with the lease and the loading transfer, then the job id,
// the phase and the cursor). A carried value that is stale therefore writes nothing, and the batch is then tried once more from
// fresh reads, which is exactly the path without `carried`; a real lost race or a changed job still fails there.
export async function sealWrite(env,spec){
 const lease=spec.lease||leaseOf(env);
 if(!lease)throw failed('discovery_lease');
 const carried=spec.carried&&Number.isInteger(spec.carried.generation)&&typeof spec.carried.programmeRunId==='string'&&spec.carried.programmeRunId&&Number.isFinite(spec.carried.cursorBytes)?spec.carried:null;
 if(carried){
  try{return await sealWriteBatch(env,spec,lease,carried);}
  catch(error){if(error?.code!=='discovery_fence')throw error;}
 }
 const gate=await readAuthority(env);
 if(!gate.ready||gate.transfer!=='loading')throw failed('discovery_incomplete');
 const state=await readSeal(env);
 if(!state||state.job_id!==spec.jobId||state.phase!=='items'||Number(state.cursor_items)!==spec.expectedCursor)throw failed('discovery_fence');
 return await sealWriteBatch(env,spec,lease,{generation:gate.generation,programmeRunId:state.programme_run_id,cursorBytes:Number(state.cursor_bytes)});
}
async function sealWriteBatch(env,spec,lease,known){
 const run=known.programmeRunId;
 // The observations of a batch go out as multi-row upserts, their shows as one delete per 80 keys and multi-row inserts.
 const written=[],groups=[],showRows=[],keys=[];
 let bytes=0,group=null,payloadBytes=0;
 const cost=(upserts,count,rows)=>SEAL_BATCH_OVERHEAD+upserts+Math.ceil(count/SEAL_KEYS_PER_DELETE)+Math.ceil(rows/SEAL_SHOW_ROWS);
 for(const entry of spec.items){
  const built=observationUpsert(entry.item,run);
  // Bytes on the wire, not UTF-16 units: a Cyrillic title is two bytes a letter.
  const size=SEAL_ENCODER.encode(String(built.values[built.values.length-1])).byteLength;
  const joins=!!group&&group.rows.length<SEAL_ROWS_PER_UPSERT&&group.size+size<=SEAL_UPSERT_BYTES;
  const upserts=groups.length+(joins?0:1),rows=showRows.length+built.shows.length;
  if(written.length>0&&(written.length+1>SEAL_ITEMS_PER_BATCH||payloadBytes+size>SEAL_BATCH_BYTES||cost(upserts,written.length+1,rows)>STATEMENT_CAP))break;
  if(cost(1,1,built.shows.length)>STATEMENT_CAP)throw failed('discovery_bounded');
  if(joins){group.rows.push(built.values);group.size+=size;}
  else{group={rows:[built.values],size};groups.push(group);}
  showRows.push(...built.shows);keys.push(entry.item.key);bytes+=entry.bytes;payloadBytes+=size;written.push(entry);
 }
 if(!written.length)return {written:0,cursorItems:spec.expectedCursor,cursorBytes:known.cursorBytes,carried:known};
 const statements=groups.map(item=>[OBSERVATION_INSERT+item.rows.map(()=>OBSERVATION_ROW).join(',')+OBSERVATION_CONFLICT,item.rows.flat()]);
 for(let at=0;at<keys.length;at+=SEAL_KEYS_PER_DELETE){
  const slice=keys.slice(at,at+SEAL_KEYS_PER_DELETE);
  statements.push(['DELETE FROM discovery_observation_show WHERE source_key=\'active\' AND observation_key IN ('+slice.map(()=>'?').join(',')+')',slice]);
 }
 for(let at=0;at<showRows.length;at+=SEAL_SHOW_ROWS){
  const slice=showRows.slice(at,at+SEAL_SHOW_ROWS);
  statements.push(['INSERT INTO discovery_observation_show (source_key, observation_key, ordinal, channel_id, channel, start_ms, end_ms) VALUES '+slice.map(()=>'(\'active\',?,?,?,?,?,?)').join(','),slice.flatMap(row=>row)]);
 }
 const now=nowMs();
 await commit(database(env),[
  ...loadingFence(known.generation,lease),
  ['UPDATE discovery_lease SET expires_at=? WHERE id=1 AND lease_id=? AND expires_at>?',[now+LEASE_TTL_MS,lease.id,now]],
  ...statements,
  ['UPDATE discovery_seal SET cursor_items=cursor_items+?, cursor_bytes=cursor_bytes+?, updated_at=? WHERE id=1 AND job_id=? AND phase=\'items\' AND cursor_items=?',[written.length,bytes,new Date(now).toISOString(),spec.jobId,spec.expectedCursor]],
  [FENCE_SQL,[]],
 ]);
 const cursorBytes=known.cursorBytes+bytes;
 // The fence of this batch moved the generation by exactly one; the next batch of this step may start from that.
 return {written:written.length,cursorItems:spec.expectedCursor+written.length,cursorBytes,statements:statements.length+SEAL_BATCH_OVERHEAD,carried:{generation:known.generation+1,programmeRunId:run,cursorBytes}};
}
// Archives up to `limit` retiring observations (and their shows) in one batch, then commits the seal when none are
// left. The first call moves the job to `archive` only when every observation is written.
export async function sealArchive(env,spec){
 const lease=spec.lease||leaseOf(env);
 if(!lease)throw failed('discovery_lease');
 const limit=Number.isInteger(spec.limit)&&spec.limit>0?Math.min(spec.limit,2000):500;
 const gate=await readAuthority(env);
 if(!gate.ready||gate.transfer!=='loading')throw failed('discovery_incomplete');
 const db=database(env);
 const state=await readSeal(env);
 if(!state||state.job_id!==spec.jobId)throw failed('discovery_fence');
 if(state.phase==='items'&&Number(state.cursor_items)!==Number(state.item_total))throw failed('discovery_incomplete');
 if(state.phase!=='items'&&state.phase!=='archive')throw failed('discovery_fence');
 const run=state.programme_run_id;
 const written=await one(db,'SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\' AND programme_run_id=?',[run]);
 if(Number(written?.n||0)!==Number(state.item_total))throw failed('discovery_incomplete');
 const left=await one(db,'SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key=\'active\' AND residence=\'retiring\'');
 const now=nowMs(),stamp=new Date(now).toISOString();
 const renew=['UPDATE discovery_lease SET expires_at=? WHERE id=1 AND lease_id=? AND expires_at>?',[now+LEASE_TTL_MS,lease.id,now]];
 const phase=['UPDATE discovery_seal SET phase=\'archive\', updated_at=? WHERE id=1 AND job_id=? AND phase IN (\'items\',\'archive\')',[stamp,spec.jobId]];
 if(Number(left?.n||0)>0){
  await commit(db,[
   ...loadingFence(gate.generation,lease),renew,phase,[FENCE_SQL,[]],
   ['UPDATE discovery_observation_show SET source_key=\'archive:\'||(SELECT programme_run_id||\':\'||(SELECT generation FROM discovery_authority WHERE id=1)||\':\'||observation_key FROM discovery_observation o WHERE o.source_key=\'active\' AND o.residence=\'retiring\' AND o.observation_key=discovery_observation_show.observation_key) WHERE source_key=\'active\' AND observation_key IN (SELECT observation_key FROM discovery_observation WHERE source_key=\'active\' AND residence=\'retiring\' ORDER BY observation_key LIMIT ?)',[limit]],
   ['UPDATE discovery_observation SET residence=\'archive\', source_key=\'archive:\'||programme_run_id||\':\'||(SELECT generation FROM discovery_authority WHERE id=1)||\':\'||observation_key WHERE source_key=\'active\' AND residence=\'retiring\' AND observation_key IN (SELECT observation_key FROM discovery_observation WHERE source_key=\'active\' AND residence=\'retiring\' ORDER BY observation_key LIMIT ?)',[limit]],
  ]);
  const after=await one(db,'SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key=\'active\' AND residence=\'retiring\'');
  return {committed:false,retiring:Number(after?.n||0)};
 }
 await commit(db,[
  ...loadingFence(gate.generation,lease),renew,phase,[FENCE_SQL,[]],
  ['UPDATE discovery_lease SET programme_run_id=? WHERE id=1 AND lease_id=?',[run,lease.id]],
  ['UPDATE discovery_authority SET programme_run_id=?, published_programme_run_id=? WHERE id=1',[run,run]],
  ['UPDATE discovery_transfer SET state=\'committed\', programme_run_id=?, batches=batches+1 WHERE id=1',[run]],
  ['UPDATE discovery_seal SET phase=\'done\', updated_at=? WHERE id=1 AND job_id=?',[stamp,spec.jobId]],
 ]);
 return {committed:true,retiring:0};
}

// Films that left the catalog become `superseded`, never deleted, in bounded batches behind the fence.
export async function supersedeAdmissions(env,ids,context={}){
 const lease=context.lease||leaseOf(env);
 if(!lease)throw failed('discovery_lease');
 const list=[...new Set((ids||[]).map(String))];
 let done=0;
 for(let at=0;at<list.length;at+=80){
  const slice=list.slice(at,at+80);
  const gate=await readAuthority(env);
  assertOpen(gate);
  await commit(database(env),[
   fence(gate,lease,' AND programme_run_id IS (SELECT programme_run_id FROM discovery_lease WHERE id=1)'),
   [FENCE_SQL,[]],
   ['UPDATE discovery_admission SET state=\'superseded\', generation=? WHERE state=\'current\' AND film_id IN ('+slice.map(()=>'?').join(',')+')',[gate.generation+1,...slice]],
  ]);
  done+=slice.length;
 }
 return {superseded:done};
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
// A chunk writes the decisions and the admissions it just made, not the whole map. Each key is one atomic batch behind
// the lease and generation fence, and it lands only if the stored decision is still the one the chunk read (`previous`,
// or none): a decision the owner changed in the meantime wins and the chunk skips that key. A batch that fails is
// diagnosed from the stored rows, so a write that landed and lost its response counts as written, not as a conflict.
export const DECISION_DELTA_CAP=64;
export async function writeDecisionDelta(env,changes,context={}){
 const lease=context.lease||leaseOf(env);
 if(!lease)throw failed('discovery_lease');
 const entries=Object.entries(changes&&typeof changes==='object'?changes:{});
 if(entries.length>DECISION_DELTA_CAP)throw failed('discovery_bounded');
 const db=database(env);
 let gate=await readAuthority(env);
 assertOpen(gate);
 const written=[],skipped=[];
 for(const [key,change] of entries){
  const next=change?.next;
  if(!next||typeof next!=='object'||Array.isArray(next))throw failed('discovery_conflict');
  const previous=change.previous&&typeof change.previous==='object'?change.previous:null;
  const expected=previous?await decisionHash(previous):null;
  const hash=await decisionHash(next);
  if(hash===expected){skipped.push({key,reason:'unchanged'});continue;}
  const kind=mediaKind(next),evidence=next.evidenceKey??null;
  const cas=expected==null?'NOT EXISTS (SELECT 1 FROM discovery_decision WHERE observation_key=?)':'EXISTS (SELECT 1 FROM discovery_decision WHERE observation_key=? AND decision_hash=?)';
  const live=' AND programme_run_id IS (SELECT programme_run_id FROM discovery_lease WHERE id=1) AND EXISTS (SELECT 1 FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\' AND observation_key=? AND (? IS NULL OR evidence_key IS NULL OR evidence_key=?)) AND '+cas;
  const generation=gate.generation+1,at=new Date().toISOString();
  try{
   await commit(db,[
    fence(gate,lease,live,[key,evidence,evidence,key,...(expected==null?[]:[expected])]),
    [FENCE_SQL,[]],
    ['INSERT INTO discovery_decision_history (observation_key, revision, generation, written_at, writer, payload_json) SELECT ?, COALESCE((SELECT MAX(revision)+1 FROM discovery_decision_history WHERE observation_key=?),1), ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM discovery_decision WHERE observation_key=? AND decision_hash=?)',[key,key,generation,at,'resolver_chunk',JSON.stringify(next),key,hash]],
    ['INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, evidence_key, terminal_reason, retry_at, tmdb_id, media_kind, film_id, decision_hash, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(observation_key) DO UPDATE SET programme_run_id=excluded.programme_run_id, generation=excluded.generation, status=excluded.status, attempts=excluded.attempts, evidence_key=excluded.evidence_key, terminal_reason=excluded.terminal_reason, retry_at=excluded.retry_at, tmdb_id=excluded.tmdb_id, media_kind=excluded.media_kind, film_id=excluded.film_id, decision_hash=excluded.decision_hash, payload_json=excluded.payload_json',[key,gate.programmeRunId,generation,next.status??null,Number.isInteger(next.attempts)?next.attempts:null,evidence,next.terminalReason??null,next.retryAt??null,next.tmdbId==null?null:String(next.tmdbId),next.tmdbId==null?null:kind,next.filmId??null,hash,JSON.stringify(next)]],
    [FENCE_SQL,[]],
   ]);
   gate={...gate,generation};
   written.push(key);
  }catch(error){
   const after=await readAuthority(env);
   assertOpen(after);
   const stored=await one(db,'SELECT decision_hash FROM discovery_decision WHERE observation_key=?',[key]);
   if(stored?.decision_hash===hash){gate=after;written.push(key);continue;}
   const observation=await one(db,'SELECT evidence_key FROM discovery_observation WHERE source_key=\'active\' AND residence=\'active\' AND observation_key=?',[key]);
   if(!observation){gate=after;skipped.push({key,reason:'observation_gone'});continue;}
   if(evidence!=null&&observation.evidence_key!=null&&observation.evidence_key!==evidence){gate=after;skipped.push({key,reason:'evidence_changed'});continue;}
   if((stored?.decision_hash??null)!==expected){gate=after;skipped.push({key,reason:'conflict'});continue;}
   throw error.code?error:failed('discovery_unavailable',error);
  }
 }
 return {written,skipped};
}
// Admissions the chunk made or touched, in batches. Each batch is behind the lease and generation fence; a film whose
// identity (media kind and TMDB id) already belongs to another film id is refused, never merged. A refusal leaves the
// rows that landed before it in place and names the film ids that did not.
//
// AIR-422. A batch is one D1 round trip. Its films go out as multi-row upserts (as many rows as the bind cap allows), each
// followed by a fence that requires every row of it to have been written, so a row whose identity belongs to another film id
// fails the whole batch exactly as the single-row fence did. The batch is bounded by the statement cap, by the bytes of one
// upsert and by the bytes of the batch; a film larger than either goes alone. The authority is read once: every batch moves
// the generation by exactly one, so the next batch starts from the generation the previous one reached (`carried`), and the
// fence itself re-checks, atomically with the write, everything the read checked (mode d1, cutover open, the generation, the
// live lease of this run and a transfer that is not loading). Any refusal drops the carried generation and reads the
// authority again. A batch that cannot be applied whole is first checked for having landed (a lost response), then halved.
const ADMISSION_ROW_BINDS=8;
export const ADMISSION_ROWS_PER_UPSERT=Math.floor(BIND_CAP/ADMISSION_ROW_BINDS);
export const ADMISSION_UPSERT_BYTES=200000;
export const ADMISSION_BATCH_BYTES=400000;
const ADMISSION_INSERT='INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES ';
const ADMISSION_ROW='(?,?,?,?,?,?,?,\'current\',?)';
const ADMISSION_CONFLICT=' ON CONFLICT(film_id) DO UPDATE SET tmdb_id=excluded.tmdb_id, media_kind=excluded.media_kind, canonical_identity=excluded.canonical_identity, observation_key=excluded.observation_key, programme_run_id=excluded.programme_run_id, generation=excluded.generation, state=\'current\', payload_json=excluded.payload_json WHERE discovery_admission.tmdb_id=excluded.tmdb_id AND discovery_admission.media_kind=excluded.media_kind';
const ADMISSION_COUNT_FENCE='UPDATE discovery_cas SET ok=(changes()=?) WHERE id=1';
const ADMISSION_FENCE_SQL=' AND programme_run_id IS (SELECT programme_run_id FROM discovery_lease WHERE id=1) AND EXISTS (SELECT 1 FROM discovery_transfer WHERE id=1 AND state<>\'loading\')';
const ADMISSION_ENCODER=new TextEncoder();
const carriedGate=value=>value&&Number.isInteger(value.generation)&&(typeof value.programmeRunId==='string'||value.programmeRunId===null)?{generation:value.generation,programmeRunId:value.programmeRunId}:null;
// The films of `entries` from `from` that fit one batch: [{rows:[[filmId,film,json]],size}], and the index after the last one taken.
function admissionGroups(entries,from){
 const groups=[];let group=null,bytes=0,at=from;
 const upsertsPerBatch=Math.max(1,Math.floor((STATEMENT_CAP-2)/2));
 for(;at<entries.length;at++){
  const [filmId,film,json,size]=entries[at];
  const joins=!!group&&group.rows.length<ADMISSION_ROWS_PER_UPSERT&&group.size+size<=ADMISSION_UPSERT_BYTES;
  if(at>from&&(bytes+size>ADMISSION_BATCH_BYTES||(!joins&&groups.length+1>upsertsPerBatch)))break;
  if(joins){group.rows.push([filmId,film,json]);group.size+=size;}
  else{group={rows:[[filmId,film,json]],size};groups.push(group);}
  bytes+=size;
 }
 return {groups,next:at};
}
export async function upsertAdmissions(env,films,context={}){
 const lease=context.lease||leaseOf(env);
 if(!lease)throw failed('discovery_lease');
 const raw=Object.entries(films&&typeof films==='object'?films:{});
 if(raw.length>READ_CAP)throw failed('discovery_bounded');
 for(const [filmId,film] of raw)validateCatalog({[filmId]:film});
 const entries=raw.map(([filmId,film])=>{const json=JSON.stringify(film);return [filmId,film,json,ADMISSION_ENCODER.encode(json).byteLength];});
 const db=database(env);
 const written=[],refused=[];
 let carried=carriedGate(context.carried),batches=0,reads=0;
 const open=async()=>{
  if(carried)return carried;
  const gate=await readAuthority(env);reads++;
  assertOpen(gate);
  return {generation:gate.generation,programmeRunId:gate.programmeRunId};
 };
 const apply=async groups=>{
  const gate=await open();
  carried=null;
  const statements=[fence({generation:gate.generation},lease,ADMISSION_FENCE_SQL),[FENCE_SQL,[]]];
  for(const group of groups){
   statements.push([ADMISSION_INSERT+group.rows.map(()=>ADMISSION_ROW).join(',')+ADMISSION_CONFLICT,group.rows.flatMap(([filmId,film,json])=>[filmId,String(film.tmdbId),mediaKind(film),film.canonicalIdentity,film.observationKey??null,gate.programmeRunId,gate.generation+1,json])]);
   statements.push([ADMISSION_COUNT_FENCE,[group.rows.length]]);
  }
  batches++;
  await commit(db,statements);
  // The fence of this batch moved the generation by exactly one; the next batch may start from that.
  carried={generation:gate.generation+1,programmeRunId:gate.programmeRunId};
 };
 const rowsOf=groups=>groups.flatMap(group=>group.rows);
 // Whether every film of a refused batch is already stored as sent: the write landed and its response was lost.
 const landed=async rows=>{
  for(let at=0;at<rows.length;at+=BIND_CAP){
   const slice=rows.slice(at,at+BIND_CAP);
   const stored=new Map((await many(db,'SELECT film_id, payload_json FROM discovery_admission WHERE state=\'current\' AND film_id IN ('+slice.map(()=>'?').join(',')+')',slice.map(row=>row[0]))).map(row=>[row.film_id,row.payload_json]));
   if(!slice.every(row=>stored.get(row[0])===row[2]))return false;
  }
  return true;
 };
 // One film alone: a write that landed and lost its response is written; an identity owned by another film id is refused.
 const applyOne=async row=>{
  try{await apply([{rows:[row],size:0}]);written.push(row[0]);return;}
  catch(error){
   if(error.code!=='discovery_conflict'&&error.code!=='discovery_fence')throw error.code?error:failed('discovery_unavailable',error);
   const stored=await one(db,'SELECT payload_json FROM discovery_admission WHERE film_id=? AND state=\'current\'',[row[0]]);
   if(stored?.payload_json===row[2]){written.push(row[0]);return;}
   const owner=await one(db,'SELECT film_id FROM discovery_admission WHERE media_kind=? AND tmdb_id=?',[mediaKind(row[1]),String(row[1].tmdbId)]);
   if(owner&&owner.film_id!==row[0]){refused.push({filmId:row[0],reason:'identity_conflict'});return;}
   throw error;
  }
 };
 // A refused batch: landed whole, or halved until the film that cannot be written stands alone, so one refused identity
 // does not hide the rest and a real fence loss surfaces after a logarithmic number of attempts.
 const settle=async rows=>{
  if(rows.length===1)return applyOne(rows[0]);
  const half=Math.ceil(rows.length/2);
  for(const part of [rows.slice(0,half),rows.slice(half)]){
   if(part.length===1){await applyOne(part[0]);continue;}
   const groups=admissionGroups(part.map(row=>[row[0],row[1],row[2],ADMISSION_ENCODER.encode(row[2]).byteLength]),0);
   if(groups.next!==part.length){await settle(part.slice(0,groups.next));await settle(part.slice(groups.next));continue;}
   try{await apply(groups.groups);for(const row of part)written.push(row[0]);}
   catch(error){
    if(error.code!=='discovery_conflict'&&error.code!=='discovery_fence')throw error.code?error:failed('discovery_unavailable',error);
    if(part.length>1&&await landed(part)){for(const row of part)written.push(row[0]);continue;}
    await settle(part);
   }
  }
 };
 const deadline=Number.isFinite(context.deadline)?context.deadline:null;
 let index=0;
 while(index<entries.length){
  const {groups,next}=admissionGroups(entries,index);
  const rows=rowsOf(groups);
  try{await apply(groups);for(const row of rows)written.push(row[0]);}
  catch(error){
   if(error.code!=='discovery_conflict'&&error.code!=='discovery_fence')throw error.code?error:failed('discovery_unavailable',error);
   if(rows.length>1&&await landed(rows)){for(const row of rows)written.push(row[0]);}
   else await settle(rows);
  }
  index=next;
  // At least one batch per call, so a caller whose time is already spent still moves.
  if(deadline!==null&&Date.now()>=deadline)break;
 }
 // AIR-374 P3c: the canonical Film admission of the films this call just wrote, and (with nothing written) the bounded own-origin reconcile and sweep. The module is in the Worker scope only (offline imports of this file have none). Below the
 // marker `open` it is ONE cached marker read and nothing else; at `open` it is bounded, never throws and never changes this call's result. The time budget is the caller's `canonicalDeadline` (the Discovery chunk passes its persist limit minus
 // a write reserve; it is separate from `deadline`, which stops the admission batches themselves), else `deadline`, else none.
 if(typeof CanonicalDiscoveryAdmission!=='undefined'){
  const budget=Number.isFinite(context.canonicalDeadline)?context.canonicalDeadline:Number.isFinite(context.deadline)?context.deadline:null;
  try{await CanonicalDiscoveryAdmission.admitDiscoveryFilms(env,{films:Object.fromEntries(entries.map(row=>[row[0],row[1]])),written,deadline:budget});}catch{/* discovery keeps its own outcome */}
 }
 return {written,refused,batches,reads,remaining:entries.length-index,carried};
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
  ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND NOT EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND expires_at>?)'+windowHeldGuard(gate)[0]+priorityGuard(gate,candidateOwedDay(nowMs()),null)[0],[gate.generation,nowMs(),...windowHeldGuard(gate)[1],...priorityGuard(gate,candidateOwedDay(nowMs()),null)[1]]],
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
   chunks[index].unshift(['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND NOT EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND expires_at>?)'+windowHeldGuard(again)[0]+priorityGuard(again,candidateOwedDay(nowMs()),null)[0],[again.generation,nowMs(),...windowHeldGuard(again)[1],...priorityGuard(again,candidateOwedDay(nowMs()),null)[1]]]);
   generation=again.generation;
  }
  await commit(db,chunks[index]);
 }
 const end=await readAuthority(env);
 await commit(db,[
  ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND NOT EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND expires_at>?)'+windowHeldGuard(end)[0]+priorityGuard(end,candidateOwedDay(nowMs()),null)[0],[end.generation,nowMs(),...windowHeldGuard(end)[1],...priorityGuard(end,candidateOwedDay(nowMs()),null)[1]]],
  [FENCE_SQL,[]],
  ['UPDATE discovery_transfer SET state=\'committed\', batches=batches+1 WHERE id=1',[]],
 ]);
 return {imported:segment.items.length,sha};
}

async function ledgerSealLoading(env){
 const row=await one(database(env),'SELECT 1 AS ok FROM discovery_transfer t JOIN discovery_authority a ON a.id=1 WHERE t.id=1 AND t.state=\'loading\' AND (EXISTS (SELECT 1 FROM discovery_observation WHERE source_key=\'active\' AND residence=\'retiring\') OR t.programme_run_id IS NOT a.programme_run_id)');
 return !!row;
}
export async function acquireLease(env,context={}){
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready)return {handled:false,lease:null};
 if(gate.transfer==='loading'){
  const live=await one(database(env),'SELECT lease_id FROM discovery_lease WHERE id=1 AND lease_id IS NOT NULL AND expires_at>?',[nowMs()]);
  if(live?.lease_id||!await ledgerSealLoading(env))throw failed('discovery_incomplete');
 }
 const id=crypto.randomUUID(),expiresAt=nowMs()+LEASE_TTL_MS;
 const db=database(env);
 const refusal=gate.windowTable?[WINDOW_ACTIVE_SQL,[nowMs()]]:['',[]];
 // ADR 0135: only the Discovery side is paused. `role: 'epg'` (the publication, `sealStep` included) is exempt, and a caller that omits `role` is Discovery.
 const paused=gate.priorityTable&&context.role!=='epg';
 let decision=null,priority=['',[]],rowStatements=[],dayKey=null;
 if(paused){
  const now=nowMs();
  dayKey=candidateOwedDay(now);
  const facts=await readPriorityFacts(env,now,context);
  decision=discoveryAdmission(facts);
  // An unreadable row, table or id is fail-closed and writes nothing. A foreign programme id is the existing hard conflict.
  if(decision.reason==='stale_generation')return {handled:true,lease:null,busy:{kind:'generation_mismatch',expiresAt:null}};
  if(!decision.admit&&decision.reason!=='epg_priority')throw failed('discovery_epg_priority_evidence');
  priority=priorityGuard(gate,dayKey,null);
  rowStatements=priorityRowStatements(pauseRowWrite(facts),dayKey);
  // The refused first read is not the end of it: the arm below must still run when the row is `clear`, so the batch always carries it.
  if(!rowStatements.length&&decision.reason==='epg_priority')rowStatements=priorityRowStatements({state:'paused'},dayKey);
 }
 // The programme fence. While the pause names itself, the previous id waits as `epg_priority` (ADR 0135 T34), so the mismatch answer is only the unpaused one.
 if(gate.programmeRunId&&context.programmeRunId&&gate.programmeRunId!==context.programmeRunId&&!(paused&&decision.reason==='epg_priority'))return {handled:true,lease:null,busy:{kind:'generation_mismatch',expiresAt:null}};
 const holder=gate.priorityTable?', holder_kind=?':'';
 await commit(db,[['UPDATE discovery_lease SET lease_id=?, expires_at=?, programme_run_id=?'+holder+' WHERE id=1 AND (lease_id IS NULL OR expires_at<=?)'+refusal[0]+priority[0],[id,expiresAt,context.programmeRunId??gate.programmeRunId??null,...(gate.priorityTable?[context.role==='epg'?'epg':'discovery']:[]),nowMs(),...refusal[1],...priority[1]]],...rowStatements]);
 const row=await one(db,'SELECT lease_id, expires_at, programme_run_id FROM discovery_lease WHERE id=1');
 if(row?.lease_id!==id){
  // ADR 0135: when the pause is why the lease was not taken, it names itself, ahead of the projector window and the holder.
  if(paused){
   let again=decision;
   if(again.admit){try{again=discoveryAdmission(await readPriorityFacts(env,nowMs(),context));}catch{again=null;}}
   if(again&&again.reason==='epg_priority')return {handled:true,lease:null,busy:await priorityBusy(env,gate,again,nowMs())};
  }
  // ADR 0103: a requested or held window is its own, typed, absolute-deadline busy; the caller waits until then.
  if(gate.windowTable){
   const window=await readProjectorWindow(env);
   if(window.active)return {handled:true,lease:null,busy:{kind:'projector_window',expiresAt:window.expiresAt,state:window.state}};
  }
  // AIR-362: say why, and until when, so a caller can wait for the holder instead of guessing. A lease row that is already
  // expired or released (the holder finished between the failed update and this read) is `lost_race`, with no expiry.
  const expiresAt=Number(row?.expires_at);
  const live=!!row?.lease_id&&Number.isFinite(expiresAt)&&expiresAt>nowMs();
  return {handled:true,lease:null,busy:{kind:live?'lease_held':'lost_race',expiresAt:live?expiresAt:null}};
 }
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
// ADR 0103. The projector's side of the window. Each step is one atomic statement or batch; none of them runs unless the
// authority is d1 and open and the table exists, and nothing here is called while the feature flag is off.
// The whole-window bound is enforced here, at the coordination boundary, not trusted from a caller: a finite positive integer number of
// milliseconds no larger than WINDOW_DEADLINE_MS, so no caller can persist an admission closure longer than the accepted 300 s. The
// migration repeats the bound as a CHECK. Anything else is refused before any statement runs.
const windowMillis=value=>Number.isSafeInteger(value)&&value>0;
function validWindowTime(now){return Number.isSafeInteger(now)&&now>0;}
export async function requestProjectorWindow(env,{owner,deadlineMs=WINDOW_DEADLINE_MS,now=nowMs()}={}){
 if(typeof owner!=='string'||!owner)throw failed('discovery_conflict');
 if(!windowMillis(deadlineMs)||deadlineMs>WINDOW_DEADLINE_MS||!validWindowTime(now))throw failed('discovery_window_invalid');
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready||!gate.windowTable)return {outcome:'not_applicable',reason:gate.ready?'no_window_table':'authority_not_d1'};
 const db=database(env),expiresAt=now+deadlineMs;
 await commit(db,[['UPDATE projector_window SET state=\'requested\', owner=?, requested_at=?, expires_at=? WHERE id=1 AND (state=\'idle\' OR expires_at<=?)',[owner,now,expiresAt,now]]]);
 const window=await readProjectorWindow(env,now);
 if(window.owner===owner&&window.state==='requested')return {outcome:'requested',expiresAt:window.expiresAt};
 return {outcome:'busy',reason:window.active?'window_held_by_other':'lost_race',expiresAt:window.expiresAt};
}
// One batch moves the existing discovery_lease to the owner and the row to `held`, only if the row is still this owner's `requested`
// row, unexpired with at least the minimum run time left, the lease is free or expired and no transfer is loading. A refused
// batch changes nothing, so an expired request can never be granted late and never leaves a lease behind.
export async function grantProjectorWindow(env,{owner,minRunMs=WINDOW_MIN_RUN_MS,now=nowMs()}={}){
 if(typeof owner!=='string'||!owner)throw failed('discovery_conflict');
 if(!windowMillis(minRunMs)||minRunMs>WINDOW_DEADLINE_MS||!validWindowTime(now))throw failed('discovery_window_invalid');
 const gate=await readAuthority(env);
 if(gate.held)throw failed('discovery_fence');
 if(!gate.ready||!gate.windowTable)return {outcome:'not_applicable',reason:gate.ready?'no_window_table':'authority_not_d1'};
 const db=database(env);
 try{
  await commit(db,[
   ['UPDATE discovery_lease SET lease_id=?, expires_at=(SELECT expires_at FROM projector_window WHERE id=1), programme_run_id=(SELECT programme_run_id FROM discovery_authority WHERE id=1) WHERE id=1 AND (lease_id IS NULL OR expires_at<=?) AND EXISTS (SELECT 1 FROM projector_window WHERE id=1 AND state=\'requested\' AND owner=? AND expires_at>? AND expires_at-?>=?) AND EXISTS (SELECT 1 FROM discovery_transfer WHERE id=1 AND state<>\'loading\') AND EXISTS (SELECT 1 FROM discovery_authority WHERE id=1 AND mode=\'d1\' AND cutover=\'open\')',[owner,now,owner,now,now,minRunMs]],
   ['UPDATE projector_window SET state=\'held\' WHERE id=1 AND state=\'requested\' AND owner=? AND expires_at>? AND changes()=1',[owner,now]],
   [FENCE_SQL,[]],
  ]);
 }catch(error){
  if(error.code!=='discovery_fence')throw error;
  const window=await readProjectorWindow(env,now);
  if(window.owner!==owner||window.state!=='requested')return {outcome:'lost',reason:window.active?'window_held_by_other':'expired'};
  if(window.expiresAt-now<minRunMs)return {outcome:'too_late',expiresAt:window.expiresAt};
  const lease=await one(db,'SELECT lease_id, expires_at FROM discovery_lease WHERE id=1');
  if(lease?.lease_id&&Number(lease.expires_at)>now)return {outcome:'pending',reason:'lease_live',leaseExpiresAt:Number(lease.expires_at)};
  return {outcome:'pending',reason:'transfer_loading'};
 }
 const after=await readAuthority(env),window=await readProjectorWindow(env,now);
 return {outcome:'granted',expiresAt:window.expiresAt,generation:after.generation};
}
// Frees only this owner's lease and window. A crashed owner releases nothing and both expire by themselves.
export async function releaseProjectorWindow(env,{owner}={}){
 if(typeof owner!=='string'||!owner)return {released:false};
 const gate=await readAuthority(env);
 if(!gate.windowTable)return {released:false};
 await commit(database(env),[
  ['UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1 AND lease_id=?',[owner]],
  ['UPDATE projector_window SET state=\'idle\', owner=NULL, requested_at=NULL, expires_at=0 WHERE id=1 AND owner=?',[owner]],
 ]);
 return {released:true};
}
// The window is the lease row while held; the projector's own batches assert it (src/d1-enrichment.js).
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
 // ADR 0135: the writer that holds the live lease (an in-flight chunk) finishes; a lease-free writer is refused while the pause is open.
 const gatePriority=priorityGuard(gate,candidateOwedDay(nowMs()),leaseOf(env));
 try{
  await commit(database(env),[
   [`UPDATE discovery_continuation SET programme_run_id=?, payload_json=?, revision=revision+1 WHERE ${revisionSql}`,params],
   ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND changes()=1'+windowHeldGuard(gate)[0]+gatePriority[0],[gate.generation,...windowHeldGuard(gate)[1],...gatePriority[1]]],
   [FENCE_SQL,[]],
  ]);
 }catch(error){if(error.code==='discovery_fence'){await throwIfWindowHeld(env,gate,error);await throwIfPriorityPaused(env,gate,error,{programmeRunId:record?.programmeRunId??null});return {handled:true,saved:false};}throw error;}
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
// AIR-430. The small operational records in one consistent snapshot: the authority row, the transfer state, the status and continuation
// payloads, the workflow record, the lease and the projector window. One `batch` of single-row SELECTs, so no two records can come from
// different generations and no generation compare is needed (which is why a Discovery commit cannot make this read fail with `discovery_fence`,
// as it does a whole-ledger scan). Bounded: at most 7 statements whatever the size of the ledger, the decisions or the catalog. Read-only; it
// never touches an observation, a show, a decision, an admission or a segment. A held cutover is reported as `held`, not thrown; a record that
// cannot be parsed is `null` and listed in `unreadable`. `handled: false` means the R2 objects are the authority.
export async function readOperationalSnapshot(env){
 const opened=await readAuthority(env);
 if(!opened.ready&&!opened.held)return {handled:false};
 const publicGate=gate=>({state:gate.held?'held':gate.transfer==='loading'?'loading':'ready',mode:gate.mode,cutover:gate.cutover,transfer:gate.transfer,generation:gate.generation,programmeRunId:gate.programmeRunId,publishedProgrammeRunId:gate.publishedProgrammeRunId});
 if(opened.held)return {handled:true,authority:publicGate(opened),records:null,unreadable:[],statements:0};
 const db=database(env),wanted=[
  ['authority','SELECT mode, cutover, programme_run_id AS programmeRunId, generation, published_programme_run_id AS publishedProgrammeRunId FROM discovery_authority WHERE id=1'],
  ['transfer','SELECT state FROM discovery_transfer WHERE id=1'],
  ['status','SELECT payload_json FROM discovery_status WHERE id=1'],
  ['continuation','SELECT revision, payload_json FROM discovery_continuation WHERE id=1'],
  ['workflow','SELECT revision, payload_json FROM discovery_workflow WHERE id=1'],
  ['lease','SELECT lease_id, expires_at FROM discovery_lease WHERE id=1'],
 ];
 if(opened.windowTable)wanted.push(['window','SELECT state, owner, requested_at AS requestedAt, expires_at AS expiresAt FROM projector_window WHERE id=1']);
 let results;
 try{
  if(binding(db)&&typeof db.batch==='function')results=(await db.batch(wanted.map(([,sql])=>db.prepare(sql).bind()))).map(item=>item.results||[]);
  else{results=[];for(const [,sql] of wanted)results.push(await many(db,sql));}
 }catch(error){throw failed('discovery_unavailable',error);}
 const rows=Object.fromEntries(wanted.map(([name],index)=>[name,results[index]?.[0]??null])),unreadable=[];
 const parse=(name,row)=>{if(!row?.payload_json)return null;try{return JSON.parse(row.payload_json);}catch{unreadable.push(name);return null;}};
 const gate=rows.authority&&rows.transfer?{...opened,mode:rows.authority.mode,cutover:rows.authority.cutover,generation:Number(rows.authority.generation),programmeRunId:rows.authority.programmeRunId??null,publishedProgrammeRunId:rows.authority.publishedProgrammeRunId??null,transfer:rows.transfer.state}:opened;
 // The mode can change between the gate read and the batch; the snapshot's own row decides, and a no-longer-open authority is not served as D1 records.
 if(gate.mode!=='d1'||gate.cutover!=='open')return gate.mode==='d1'&&gate.cutover==='held'?{handled:true,authority:publicGate({...gate,held:true}),records:null,unreadable:[],statements:wanted.length}:{handled:false};
 return {handled:true,authority:publicGate(gate),statements:wanted.length,unreadable,records:{
  status:parse('status',rows.status),continuation:parse('continuation',rows.continuation),workflow:parse('workflow',rows.workflow),
  lease:rows.lease?.lease_id?{id:rows.lease.lease_id,expiresAt:Number(rows.lease.expires_at)}:null,
  window:rows.window?{state:rows.window.state,owner:rows.window.owner,requestedAt:rows.window.requestedAt==null?null:Number(rows.window.requestedAt),expiresAt:rows.window.expiresAt==null?null:Number(rows.window.expiresAt)}:null,
 }};
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
 // ADR 0135: the writer that holds the live lease (an in-flight chunk) finishes; a lease-free writer is refused while the pause is open.
 const gatePriority=priorityGuard(gate,candidateOwedDay(nowMs()),leaseOf(env));
 try{
  await commit(database(env),[
   [`UPDATE discovery_workflow SET instance_id=?, programme_run_id=?, series=?, payload_json=?, revision=revision+1 WHERE ${where}`,params],
   ['UPDATE discovery_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND changes()=1'+windowHeldGuard(gate)[0]+gatePriority[0],[gate.generation,...windowHeldGuard(gate)[1],...gatePriority[1]]],
   [FENCE_SQL,[]],
  ]);
 }catch(error){if(error.code==='discovery_fence'){await throwIfWindowHeld(env,gate,error);await throwIfPriorityPaused(env,gate,error,{programmeRunId:record?.programmeRunId??null});return {handled:true,saved:false};}throw error;}
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

