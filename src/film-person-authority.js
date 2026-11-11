// AIR-367 / ADR 0099 (Accepted). The canonical Film/Person authority marker, read for the fenced mutations and, later, the readers.
// States: no table (legacy), r2, prepared, open (mode d1, cutover open) and held (mode d1, cutover held). Only `open` lets a
// fenced canonical mutation write. Once the marker table exists, a missing or malformed row, a failed read, `held` and a failed
// baseline gate fail closed: this module never answers "go back to R2" for them. R2 is allowed only in the verified legacy, r2
// and prepared states. The Worker bundles it only for `readAuthority` (AIR-409, the catalog film route); nothing here moves the marker on its own or writes a Film or a Person.
export const FILM_PERSON_MIN_VERSION=13;
export const FILM_PERSON_TABLES=['film_person_authority','film_person_cas','film_person_baseline','canonical_revision'];
const STATES=['legacy','r2','prepared','open','held'];
// The states a caller may be in and the single move each allows. The migration's trigger enforces the same table in SQL.
export const FILM_PERSON_TRANSITIONS={r2:['prepared'],prepared:['r2','open'],open:['held'],held:['open']};

export function failed(code,cause){const error=new Error(code);error.code=code;if(cause)error.cause=cause;return error;}
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

// Reads the marker. A database without the binding, or with a contract below version 13, is `legacy` (before this feature).
// From version 13 on, anything but one well-formed marker row (and its companion rows) throws `film_person_unavailable`.
export async function readAuthority(env){
 const db=database(env);
 if(!db)return legacy();
 let version;
 try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error)))return legacy();
  throw failed('film_person_unavailable',error);
 }
 const numeric=Number(version);
 if(!Number.isFinite(numeric)||numeric<FILM_PERSON_MIN_VERSION)return legacy(Number.isFinite(numeric)?numeric:null);
 let names,row,fence,baseline;
 try{
  names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('film_person_authority','film_person_cas','film_person_baseline','canonical_revision')")).map(item=>item.name);
  if(!FILM_PERSON_TABLES.every(name=>names.includes(name)))throw failed('film_person_unavailable');
  row=await one(db,'SELECT mode, cutover, generation FROM film_person_authority WHERE id=1');
  fence=await one(db,'SELECT ok FROM film_person_cas WHERE id=1');
  baseline=await one(db,'SELECT state, reference FROM film_person_baseline WHERE id=1');
 }catch(error){
  if(error?.code==='film_person_unavailable')throw error;
  throw failed('film_person_unavailable',error);
 }
 const generation=Number(row?.generation);
 const ok=row&&['r2','prepared','d1'].includes(row.mode)&&['open','held'].includes(row.cutover)&&Number.isInteger(generation)&&generation>=0&&(row.mode==='d1'||row.cutover==='open');
 if(!ok||!fence||Number(fence.ok)<1||!baseline||!['empty','loading','verified'].includes(baseline.state))throw failed('film_person_unavailable');
 const state=row.mode==='r2'?'r2':row.mode==='prepared'?'prepared':row.cutover==='held'?'held':'open';
 return {state,r2Allowed:state==='r2'||state==='prepared',open:state==='open',held:state==='held',generation,version:numeric,baseline:baseline.state};
}

// AIR-374 P1 / ADR 0117 (Accepted owner decision 1). The ONE source of the enrichment projector's marker fence. Every SQL batch the projector
// writes asserts, in the same atomic batch, the marker mode, cutover and generation it read BEFORE its diff, whatever flag is set. The
// projector may write only in the states legacy (no marker table: it cannot be asserted in SQL except as "still absent"), `r2` and `prepared`,
// both with cutover `open`. A transition bumps the generation (transitionAuthority), so a batch planned before it fails whole. The Worker
// bundle uses this for the projector (src/d1-enrichment.js); the dormant producer routing module (its `projectorFence`) consumes the same condition.
export const PROJECTOR_MARKER_READ='SELECT mode,cutover,generation FROM film_person_authority WHERE id=1';
export const PROJECTOR_MARKER_CONDITION="EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode=? AND cutover='open' AND generation=?)";
export const PROJECTOR_MARKER_GUARD='INSERT INTO projection_fence (held) SELECT CASE WHEN '+PROJECTOR_MARKER_CONDITION+' THEN 1 ELSE 0 END';
// Legacy (the marker table does not exist): the batch holds only while it still does not, so a migration landing mid-run fails it whole.
export const PROJECTOR_LEGACY_GUARD="INSERT INTO projection_fence (held) SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='film_person_authority') THEN 0 ELSE 1 END";
const PROJECTOR_MODES=['r2','prepared'];
// The marker row the projector may write under, as {mode,cutover:'open',generation}; null for every other row (d1, held, malformed).
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
 const gate=await readAuthority(env);
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
 return readAuthority(env);
}
