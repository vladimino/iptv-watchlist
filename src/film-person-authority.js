// AIR-367 / ADR 0099 (Accepted). The canonical Film/Person authority marker, read for the fenced mutations and, later, the readers.
// States: no table (legacy), r2, prepared, open (mode d1, cutover open) and held (mode d1, cutover held). Only `open` lets a
// fenced canonical mutation write. Once the marker table exists, a missing or malformed row, a failed read, `held` and a failed
// baseline gate fail closed: this module never answers "go back to R2" for them. R2 is allowed only in the legacy state (the explicit local stand-in, ADR 0162); readAuthority refuses r2 and prepared, which
// only readMarker and transitionAuthority still see. The Worker bundles it only for `readAuthority` (AIR-409, the catalog film route); nothing here moves the marker on its own or writes a Film or a Person.
export const FILM_PERSON_MIN_VERSION=13;
export const FILM_PERSON_TABLES=['film_person_authority','film_person_cas','film_person_baseline','canonical_revision'];
const STATES=['legacy','r2','prepared','open','held'];
// The states a caller may be in and the single move each allows. The migration's trigger enforces the same table in SQL.
export const FILM_PERSON_TRANSITIONS={r2:['prepared'],prepared:['r2','open'],open:['held'],held:['open']};

// AIR-541 (ADR 0177): a caught storage error is a TEMPORARY outage only when its own text names a transport, timeout or overload failure. An unknown error, a missing table or column,
// a schema, syntax or constraint error is structural and stays a hard refusal. The same function is kept in src/published-epg.js, src/discovery-authority.js and src/film-person-authority.js (tests/mirror-fault-classifier.mjs asserts they agree).
const STRUCTURAL_STORAGE_ERROR=/no such (table|column)|has no column|syntax error|SQLITE_ERROR|SQLITE_CONSTRAINT|constraint failed|datatype mismatch|malformed|no such|not authorized|SQLITE_AUTH|SQLITE_READONLY|SQLITE_CORRUPT/i;
const TRANSIENT_STORAGE_ERROR=/overloaded|timed? ?out|timeout|network connection lost|connection (lost|reset|closed)|temporar|too many requests|try again|SQLITE_BUSY|database is locked|durable object.*(reset|overloaded)|internal error|service unavailable|storage operation exceeded/i;
export function transientStorageCause(cause){
 const text=String(cause?.message??cause??'');
 if(!text||STRUCTURAL_STORAGE_ERROR.test(text))return false;
 return TRANSIENT_STORAGE_ERROR.test(text);
}
export function failed(code,cause){const error=new Error(code);error.code=code;if(cause){error.cause=cause;if(transientStorageCause(cause))error.temporary=true;}return error;}
function binding(db){return typeof db?.prepare==='function';}
export function database(env){return env&&typeof env.prepare==='function'?env:env?.DB;}
export async function one(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).first())??null;
 return (await db.get(sql,params))??null;
}
export async function many(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).all()).results||[];
 return (await db.all(sql,params))||[];
}

function legacy(version=null){return {state:'legacy',r2Allowed:true,open:false,held:false,generation:0,version,baseline:null};}

// Reads the marker. ADR 0162: only `open` (mode d1, cutover open) is served for reading and writing, and `held` (mode d1, cutover held) is the
// fail-closed emergency and forward-fix gate that its callers refuse with `film_person_held`. A marker in mode r2 or prepared, a missing binding, a
// missing schema_contract, a contract below 13, a database without the four tables, a partly installed set, a contract at 13 or later with none of the
// tables, a malformed marker, baseline or fence row and any D1 error throw `film_person_unavailable`, before any R2 read and before any D1 write.
// The explicit local stand-in (FILM_PERSON_DB_OPTIONAL set to standin, never set in the deployed configuration) answers `legacy` (R2 allowed) only for a domain that is not
// installed at all: no binding, no schema_contract, or a contract below 13 with none of the tables.
export async function readAuthority(env){return readState(env,{servedOnly:true});}
// The marker as it is, for the one operation that must move it (`transitionAuthority`) and for operator reports: it still refuses everything that is not
// a well-formed marker, but it does not refuse a well-formed r2 or prepared one.
export async function readMarker(env){return readState(env,{servedOnly:false});}
async function readState(env,{servedOnly}){
 const standin=env?.FILM_PERSON_DB_OPTIONAL==='standin';
 const db=database(env);
 if(!db){
  if(standin)return legacy();
  throw failed('film_person_unavailable');
 }
 // The tables are inventoried first, so that no stand-in path below can serve R2 over a partly installed domain, whatever schema_contract says.
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('film_person_authority','film_person_cas','film_person_baseline','canonical_revision')")).map(item=>item.name);}
 catch(error){throw failed('film_person_unavailable',error);}
 const installed=FILM_PERSON_TABLES.every(name=>names.includes(name));
 if(!installed&&names.length>0)throw failed('film_person_unavailable');
 let version;
 try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(!installed&&standin&&/no such table/i.test(String(error?.message||error)))return legacy();
  throw failed('film_person_unavailable',error);
 }
 const numeric=Number(version);
 if(!installed){
  if(!standin)throw failed('film_person_unavailable');
  if(!Number.isFinite(numeric))return legacy();
  // A contract at 13 or later declares the domain installed: none of its tables is a broken install, not an uninstalled domain.
  if(numeric>=FILM_PERSON_MIN_VERSION)throw failed('film_person_unavailable');
  return legacy(numeric);
 }
 if(!Number.isFinite(numeric)||numeric<FILM_PERSON_MIN_VERSION)throw failed('film_person_unavailable');
 let row,fence,baseline;
 try{
  // AIR-532: the three marker rows come back in ONE statement (the four tables are known to exist here: the inventory above ran first), same rows, same checks below.
  const read=await one(db,"SELECT (SELECT COUNT(*) FROM film_person_authority WHERE id=1) AS marker_rows,(SELECT mode FROM film_person_authority WHERE id=1) AS mode,(SELECT cutover FROM film_person_authority WHERE id=1) AS cutover,(SELECT generation FROM film_person_authority WHERE id=1) AS generation,(SELECT COUNT(*) FROM film_person_cas WHERE id=1) AS fence_rows,(SELECT ok FROM film_person_cas WHERE id=1) AS fence_ok,(SELECT COUNT(*) FROM film_person_baseline WHERE id=1) AS baseline_rows,(SELECT state FROM film_person_baseline WHERE id=1) AS baseline_state,(SELECT reference FROM film_person_baseline WHERE id=1) AS baseline_reference");
  row=Number(read?.marker_rows)>0?{mode:read.mode,cutover:read.cutover,generation:read.generation}:null;
  fence=Number(read?.fence_rows)>0?{ok:read.fence_ok}:null;
  baseline=Number(read?.baseline_rows)>0?{state:read.baseline_state,reference:read.baseline_reference}:null;
 }catch(error){
  throw failed('film_person_unavailable',error);
 }
 const generation=Number(row?.generation);
 const ok=row&&['r2','prepared','d1'].includes(row.mode)&&['open','held'].includes(row.cutover)&&Number.isInteger(generation)&&generation>=0&&(row.mode==='d1'||row.cutover==='open');
 if(!ok||!fence||Number(fence.ok)<1||!baseline||!['empty','loading','verified'].includes(baseline.state))throw failed('film_person_unavailable');
 const state=row.mode==='r2'?'r2':row.mode==='prepared'?'prepared':row.cutover==='held'?'held':'open';
 if(servedOnly&&(state==='r2'||state==='prepared'))throw failed('film_person_unavailable');
 return {state,r2Allowed:state==='r2'||state==='prepared',open:state==='open',held:state==='held',generation,version:numeric,baseline:baseline.state};
}

// AIR-688: a TIME-BOUNDED, OPERATION-SCOPED reuse of the writer gate. A drain (or any other long operation) that creates a scope with `createGateReuse()` and carries it as `env.gateReuse` lets the fenced writers
// skip the four marker, fence, baseline and schema-contract reads at every writer entry while the snapshot is younger than `ttlMs`. What stays authoritative is unchanged and is NOT read from the snapshot: every
// canonical batch still asserts `mode='d1' AND cutover='open' AND generation=?` (and any producer or Letterboxd epoch fence) INSIDE its own transaction, so a marker that moved after the snapshot fails the batch whole
// (the failed CHECK re-reads the marker FRESH, `readAuthority`, and drops the snapshot). Only an `open` state is kept; a non-open, unreadable or failed read keeps nothing, and a snapshot is handed out as a COPY, because
// the writers bind a producer fence onto the gate object. Receipt lookups and the reconcile step are never served from here. Without `env.gateReuse` the behaviour is exactly the fresh read of every call.
export const GATE_REUSE_TTL_MS=5000;
export function createGateReuse({ttlMs=GATE_REUSE_TTL_MS,now=()=>Date.now()}={}){
 if(!Number.isFinite(ttlMs)||ttlMs<0)throw failed('film_person_invalid');
 return {ttlMs,now,gate:null,at:0,facts:new Map(),stats:{hits:0,misses:0,drops:0,factHits:0,factMisses:0}};
}
// The gate of a fenced WRITER (use it where the writer takes its gate; a post-failure re-read, a report or a transition keeps `readAuthority`).
export async function readWriterGate(env){
 const scope=env?.gateReuse;
 if(!scope)return readAuthority(env);
 if(scope.gate&&scope.now()-scope.at<scope.ttlMs){scope.stats.hits++;return {...scope.gate};}
 scope.gate=null;scope.stats.misses++;
 const gate=await readAuthority(env);
 if(gate.state==='open'){scope.gate={...gate};scope.at=scope.now();}
 return {...gate};
}
// Forget the snapshot (a failed batch, a moved marker). Safe to call without a scope.
export function dropGateReuse(env){
 const scope=env?.gateReuse;
 if(!scope)return;
 if(scope.gate||scope.facts.size)scope.stats.drops++;
 scope.gate=null;scope.facts.clear();
}
// A schema fact that only moves FORWARD (a migration is never undone): a POSITIVE answer (`keep(value)` true) is kept for the same bounded time under `key`; every other answer is returned and not kept. Without a scope it just reads.
export async function reuseSchemaFact(env,key,read,keep){
 const scope=env?.gateReuse;
 if(!scope)return read();
 const hit=scope.facts.get(key);
 if(hit&&scope.now()-hit.at<scope.ttlMs){scope.stats.factHits++;return hit.value;}
 scope.stats.factMisses++;// an expired entry is simply read past: it is expired for every later call too, and a positive answer replaces it
 const value=await read();
 if(keep(value))scope.facts.set(key,{value,at:scope.now()});
 return value;
}

// AIR-374 P1 / ADR 0117 (Accepted owner decision 1). HISTORICAL (the enrichment projector was removed in AIR-537 slice 3; these symbols are retained, pinned by
// tests/projector-marker-guard.mjs). The ONE source of the enrichment projector's marker fence. Every SQL batch the projector
// wrote asserted, in the same atomic batch, the marker mode, cutover and generation it read BEFORE its diff, whatever flag is set. The
// projector could write only in the states legacy (no marker table: it cannot be asserted in SQL except as "still absent"), `r2` and `prepared`,
// both with cutover `open`. A transition bumps the generation (transitionAuthority), so a batch planned before it fails whole. The Worker
// bundle no longer uses this; the dormant producer routing module (its `projectorFence`) consumes the same condition.
export const PROJECTOR_MARKER_READ='SELECT mode,cutover,generation FROM film_person_authority WHERE id=1';
export const PROJECTOR_MARKER_CONDITION="EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode=? AND cutover='open' AND generation=?)";
export const PROJECTOR_MARKER_GUARD='INSERT INTO projection_fence (held) SELECT CASE WHEN '+PROJECTOR_MARKER_CONDITION+' THEN 1 ELSE 0 END';
// Legacy (the marker table does not exist): the batch holds only while it still does not, so a migration landing mid-run fails it whole.
export const PROJECTOR_LEGACY_GUARD="INSERT INTO projection_fence (held) SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='film_person_authority') THEN 0 ELSE 1 END";
const PROJECTOR_MODES=['r2','prepared'];
// The marker row the removed projector could write under, as {mode,cutover:'open',generation}; null for every other row (d1, held, malformed).
export function projectorExpectation(row){
 if(!row||!PROJECTOR_MODES.includes(row.mode)||row.cutover!=='open')return null;
 const generation=Number(row.generation);
 return Number.isInteger(generation)&&generation>=0?{mode:row.mode,cutover:'open',generation}:null;
}
// Whether a freshly read marker row is still exactly what the batch was planned under. A legacy expectation (no marker table) is never
// satisfied by a read that succeeded: the table exists now, empty or not; the caller proves "still absent" by the read failing with `no such table`.
export function projectorHolds(expected,row){
 if(expected?.legacy===true)return false;
 const now=projectorExpectation(row);
 return !!expected&&!!now&&now.mode===expected.mode&&now.generation===expected.generation;
}
// The fence statement {sql,params} for what was read: the legacy guard, the marker guard, or null for a state the projector may not write in.
export function projectorGuard(expected){
 if(expected?.legacy===true)return {sql:PROJECTOR_LEGACY_GUARD,params:[]};
 return expected&&PROJECTOR_MODES.includes(expected.mode)&&Number.isInteger(expected.generation)?{sql:PROJECTOR_MARKER_GUARD,params:[expected.mode,expected.generation]}:null;
}

// The gate for a canonical mutation: only an `open` authority lets one write. Every other state refuses before any statement.
export function assertWritable(gate){
 if(gate?.state==='open')return gate;
 if(gate?.state==='held')throw failed('film_person_held');
 if(STATES.includes(gate?.state))throw failed('film_person_not_open');
 throw failed('film_person_unavailable');
}

// The gate for a reader: it names the source the state authorizes. `held`, an unreadable marker and a failed gate never name R2.
export function readSource(gate){
 if(gate?.r2Allowed===true)return 'r2';
 if(gate?.state==='open')return 'd1';
 if(gate?.state==='held')throw failed('film_person_held');
 throw failed('film_person_unavailable');
}

const MARKER={r2:['r2','open'],prepared:['prepared','open'],open:['d1','open'],held:['d1','held']};
// One move of the marker (a production operation of a later card; nothing calls it in the Worker). It succeeds only for a move
// the state machine allows, from the generation the caller read, and it raises the generation by one. The SQL triggers refuse
// any other move and a move into prepared or open without a verified baseline.
export async function transitionAuthority(env,{from,to,expectedGeneration}){
 const db=database(env);
 if(!db||typeof db.batch!=='function')throw failed('film_person_unavailable');
 if(!(FILM_PERSON_TRANSITIONS[from]||[]).includes(to))throw failed('film_person_transition');
 if(!Number.isInteger(expectedGeneration)||expectedGeneration<0)throw failed('film_person_transition');
 const gate=await readMarker(env);
 if(gate.state!==from||gate.generation!==expectedGeneration)throw failed('film_person_fence');
 const [mode,cutover]=MARKER[to],[fromMode,fromCutover]=MARKER[from];
 const statements=[
  ['UPDATE film_person_authority SET mode=?, cutover=?, generation=generation+1 WHERE id=1 AND mode=? AND cutover=? AND generation=?',[mode,cutover,fromMode,fromCutover,expectedGeneration]],
  // The fence must hold even if the fence row vanished: it is an upsert that fails its CHECK unless the row exists and the move changed one row.
  ['INSERT INTO film_person_cas (id,ok) VALUES (1,(SELECT CASE WHEN EXISTS (SELECT 1 FROM film_person_cas WHERE id=1) AND changes()>=1 THEN 1 ELSE 0 END)) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok',[]],
 ];
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));}
 catch(error){
  const message=String(error?.message||error);
  if(/film_person_baseline_not_verified/.test(message))throw failed('film_person_baseline_not_verified',error);
  if(/film_person_authority_transition|film_person_authority_delete/.test(message))throw failed('film_person_transition',error);
  if(/CHECK constraint failed/i.test(message))throw failed('film_person_fence',error);
  throw failed('film_person_unavailable',error);
 }
 return readMarker(env);
}

// AIR-656. The one bounded credit selection of a Film, shared by the canonical film page (canonical-catalog-reader.js) and the dormant unified-Film display section
// (the AIR-647 aggregate), so no second copy of this SQL exists for AIR-649 to reconcile. The schema has exactly two credit roles and a unique (film_id,role,ordinal) index
// (film_person_credit_order): each role is one indexed range probe `film_id=? AND role=? ORDER BY ordinal LIMIT n`, so the work is bounded by the limits, never by the size
// of the stored cast (a mixed role/ordinal ORDER BY would sort the whole Film range). Parameters: film_id, director limit, film_id, actor limit (limit = budget + 1, so the
// caller can tell a complete role from a truncated one). Rows come back directors first, then actors, each in stored ordinal order, with the Person's usable name: the
// localized/effective value (reviewed over provisional), else the lowest name alias of the SAME Person. A whitespace-only value is not a name and never hides a usable alias.
// No name matching, no Person merge, no write.
const CREDIT_USABLE=value=>`${value} IS NOT NULL AND trim(${value},' '||char(9)||char(10)||char(13))<>''`;
export const CREDIT_NAME_SQL=person=>`COALESCE((SELECT d.value FROM person_dimension d WHERE d.person_id=${person} AND d.dimension='localization' AND d.status IN ('provisional','reviewed') AND ${CREDIT_USABLE('d.value')} ORDER BY CASE d.status WHEN 'reviewed' THEN 0 ELSE 1 END LIMIT 1),(SELECT a.value FROM person_alias a WHERE a.person_id=${person} AND a.kind='name' AND ${CREDIT_USABLE('a.value')} ORDER BY a.value LIMIT 1))`;
const CREDIT_PROBE=(role,rank)=>`SELECT ${rank} AS rank,c.role AS role,c.ordinal AS ordinal,c.person_id AS person_id,p.role_id AS role_id,${CREDIT_NAME_SQL('c.person_id')} AS name FROM (SELECT role,ordinal,person_id FROM film_person_credit WHERE film_id=? AND role='${role}' ORDER BY ordinal LIMIT ?) c INNER JOIN person p ON p.id=c.person_id`;
export const CREDIT_SELECTION_SQL=`SELECT rank,role,ordinal,person_id,role_id,name FROM (${CREDIT_PROBE('director',0)} UNION ALL ${CREDIT_PROBE('actor',1)}) ORDER BY rank,ordinal`;
