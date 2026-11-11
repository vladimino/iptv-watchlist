// AIR-374 P2b (Accepted owner decisions 1 and 5 of ADR 0117; parent ADR 0099). The fenced PERSON-side canonical state writers: the person_dimension rows (identity and
// the effective localization) with what the projector's noteHeldLocalization does for a Person (the held-value alias and conflict), and the localization_conflict rows of
// one Film or Person outside a merge. Each write is ONE D1 batch through `fenced.commit` of src/canonical-mutations.js: it proves the marker is `d1`/`open` at the
// generation the caller read and the entity revision, and a lost proof rolls the batch back whole. While the marker is r2 or prepared (and legacy, held or unreadable)
// no statement reaches the database (`assertWritable`): the projector stays the only canonical writer. DORMANT: nothing in the Worker imports this module, it is not
// bundled and no route, job or cron calls it; the producer routing module only registers it, and it still dispatches nothing before `open`.
//
// What it writes and never writes
// - recordPersonState: person_dimension (identity, localization), the held-value alias in person_alias (add only), localization_conflict, and one canonical_revision bump.
//   It never touches the person row, person_external_id, film_person_credit, any other alias or any Film (mutatePerson owns the first three).
// - recordLocalizationConflicts: localization_conflict rows of one entity and one revision bump. Rows are keyed by their content, so a repeat is a no-op; nothing here
//   deletes a conflict (the projector clears a Film's conflicts only when it retires the Film, which is mergeFilms' fenced statement).
// - An owner or reviewed localization is never downgraded: guardReviewed (pure, moved here from the projector, same rule) keeps the stored value and records the
//   incoming one as a conflict and an alias, and the SQL upsert carries the same guard again inside the batch, so a state this snapshot did not see cannot be overwritten.
//
// Equivalence: for the same stored state and the same input, the statements below produce the same person_dimension, person_alias and localization_conflict rows as
// the projector's writePerson/noteHeldLocalization (src/canonical-repository.js); tests/canonical-person-state.mjs proves it on shared fixtures and the later
// differential harness runs both on one fixture through the pure planners exported here.
//
// Idempotency (owner decision 5): `requestId` is a required, stable key the caller derives from the source event; it is validated and returned. There is NO table for
// a person-state receipt in schema 16 and this change adds no migration: a replay is recognised by CONTENT instead (the stored rows already equal what the write would
// leave, so the call returns `already:true` with no batch and no revision bump) and the revision CAS refuses a stale concurrent writer. A durable receipt per request id
// (the way film_localization_source carries request_id) needs its own table in a later schema and an owner GO; until then an unknown outcome is settled by replaying the
// same call (a no-op when it had applied) and by readback of the rows.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';

const COLUMNS='dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at';
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const json=value=>value==null?null:JSON.stringify(value);
const parseJson=value=>value?JSON.parse(value):null;
const present=value=>value!==undefined&&value!==null&&value!=='';
const SLOTS=['identity','localization'];

// ---- pure rules (the projector's, moved into the mutation API) ----

// The stored dimension row as the domain state it represents.
export function dimensionView(row){
 const provenance=parseJson(row.provenance_json);
 const state={dimension:row.dimension,status:row.status,updatedAt:row.updated_at,source:row.source,sourceVersion:row.source_version,provenance:provenance?.authority||!row.authority?provenance:{...(provenance||{}),authority:row.authority},lastError:row.last_error,failureReason:row.failure_reason,retryAt:row.retry_at,attempts:row.attempts,nextAction:row.next_action};
 if(row.dimension==='localization')state.value=row.value;
 return state;
}

export function reviewedWrite(state){
 if(state?.status!=='reviewed')return false;
 const authority=state.provenance?.authority||state.sourceVersion||state.source;
 return authority==='dictionary'||authority==='owner'||state.source==='dictionary';
}

// May this incoming state replace the stored reviewed one? An owner value yields only to an owner review; a dictionary value to a dictionary or owner review.
export function replacesStored(stored,incoming){
 if(stored?.authority==='owner')return incoming?.status==='reviewed'&&incoming?.provenance?.authority==='owner';
 return reviewedWrite(incoming);
}

// A reviewed or owner value is never downgraded: the stored state is kept, and an incoming value that differs becomes a conflict and an alias.
// entity: {localization, localizationConflicts?, aliases?}; stored: the stored person_dimension row of the localization (or null).
export function guardReviewed(entity,stored,kind){
 if(!stored||stored.status!=='reviewed'||replacesStored(stored,entity.localization))return entity;
 const incoming=entity.localization||{};
 const conflicts=[...(entity.localizationConflicts||[])];
 const aliases=[...(entity.aliases||[])];
 const reason=stored.authority==='owner'?'owner_kept':'reviewed_kept';
 if(incoming.value&&incoming.value!==stored.value){
  conflicts.push({value:incoming.value,source:incoming.source||null,provenance:incoming.provenance??null,at:incoming.updatedAt||stored.updated_at,reason});
  aliases.push({kind,value:incoming.value,provenance:incoming.provenance??null});
 }
 return {...entity,localization:dimensionView(stored),localizationConflicts:conflicts,aliases};
}

export function dimensionParams(id,state,slot){
 if(!SLOTS.includes(slot)||!plain(state)||!state.status||!state.updatedAt)throw failed('film_person_invalid');
 if(state.dimension!==undefined&&state.dimension!==slot)throw failed('film_person_invalid');
 return [id,slot,state.status,state.source??null,state.sourceVersion??null,json(state.provenance),state.value??null,state.provenance?.authority??null,state.lastError??null,state.failureReason??null,state.retryAt??null,state.attempts??0,state.nextAction??'none',state.updatedAt];
}

// The conflict row, with the projector's content-derived id.
export function conflictParams(kind,id,conflict){
 if(!plain(conflict)||!present(conflict.reason)||!present(conflict.at))throw failed('film_person_invalid');
 return [kind+':'+id+':'+JSON.stringify({reason:conflict.reason,value:conflict.value??null,source:conflict.source??null}),kind,id,conflict.value??null,conflict.source??null,json(conflict.provenance),conflict.provenance?.authority??null,conflict.reason,conflict.at];
}

const CONFLICT_INSERT='INSERT INTO localization_conflict (id,entity_kind,entity_id,value,source,provenance_json,authority,reason,at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING';
const ALIAS_INSERT='INSERT INTO person_alias (person_id,kind,value,provenance_json) VALUES (?,?,?,?) ON CONFLICT(person_id,kind,value) DO NOTHING';
const LOCALIZATION_UPSERT=`INSERT INTO person_dimension (person_id,${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(person_id,dimension) DO UPDATE SET status=excluded.status,source=excluded.source,source_version=excluded.source_version,provenance_json=excluded.provenance_json,value=excluded.value,authority=excluded.authority,last_error=excluded.last_error,failure_reason=excluded.failure_reason,retry_at=excluded.retry_at,attempts=excluded.attempts,next_action=excluded.next_action,updated_at=excluded.updated_at WHERE person_dimension.status<>'reviewed' OR (person_dimension.authority='owner' AND excluded.status='reviewed' AND excluded.authority='owner') OR (COALESCE(person_dimension.authority,'')<>'owner' AND excluded.status='reviewed' AND (excluded.authority IN ('dictionary','owner') OR excluded.source='dictionary'))`;
const HOLD="status='reviewed' AND NOT (value IS ?) AND NOT ((authority='owner' AND ?='reviewed' AND ?='owner') OR (COALESCE(authority,'')<>'owner' AND ?='reviewed' AND (? IN ('dictionary','owner') OR ?='dictionary')))";

// What the in-batch SQL guard does, evaluated on a stored row: does the upsert overwrite it? params are dimensionParams(...)
export function upsertOverwrites(stored,params){
 if(!stored)return true;
 const status=params[2],source=params[3],authority=params[7];
 if(stored.status!=='reviewed')return true;
 if(stored.authority==='owner')return status==='reviewed'&&authority==='owner';
 return status==='reviewed'&&(authority==='dictionary'||authority==='owner'||source==='dictionary');
}
// What the in-batch held-value statements (the projector's noteHeldLocalization) do for a stored row and the incoming state: the conflict reason, or null.
// SQL three-valued logic is kept on purpose: a NULL incoming authority or source makes the "replaces" test NULL, and a NULL hold does not fire (nothing is recorded).
const and3=(...v)=>v.includes(false)?false:v.includes(null)?null:true;
const or3=(...v)=>v.includes(true)?true:v.includes(null)?null:false;
const not3=v=>v===null?null:!v;
const eq3=(left,right)=>left==null||right==null?null:left===right;
const in3=(value,list)=>value==null?null:list.includes(value);
export function heldReason(stored,incoming){
 if(!stored||stored.status!=='reviewed')return null;
 const status=incoming?.status??null,authority=incoming?.provenance?.authority??null,source=incoming?.source??null;
 const replaced=or3(and3(eq3(stored.authority??null,'owner'),eq3(status,'reviewed'),eq3(authority,'owner')),and3((stored.authority??'')!=='owner',eq3(status,'reviewed'),or3(in3(authority,['dictionary','owner']),eq3(source,'dictionary'))));
 return and3((stored.value??null)!==(incoming?.value??null),not3(replaced))===true?(stored.authority==='owner'?'owner_kept':'reviewed_kept'):null;
}

// The two statements of the projector's noteHeldLocalization for a Person (alias of the held incoming value, then the conflict row).
function heldStatements(id,incoming){
 const value=incoming?.value??null,source=incoming?.source??null,status=incoming?.status??null,authority=incoming?.provenance?.authority??null,at=incoming?.updatedAt??null,provenance=json(incoming?.provenance);
 return [
  [`INSERT INTO person_alias (person_id,kind,value,provenance_json) SELECT person_id,?,?,? FROM person_dimension WHERE person_id=? AND dimension='localization' AND ${HOLD} AND ? IS NOT NULL ON CONFLICT(person_id,kind,value) DO NOTHING`,['name',value,provenance,id,value,status,authority,status,authority,source,value]],
  [`INSERT INTO localization_conflict (id,entity_kind,entity_id,value,source,provenance_json,authority,reason,at) SELECT ?||':'||?||':'||json_object('reason',CASE WHEN authority='owner' THEN 'owner_kept' ELSE 'reviewed_kept' END,'value',?,'source',?),?,?,?,?,?,authority,CASE WHEN authority='owner' THEN 'owner_kept' ELSE 'reviewed_kept' END,? FROM person_dimension WHERE person_id=? AND dimension='localization' AND ${HOLD} ON CONFLICT(id) DO NOTHING`,['person',id,value,source,'person',id,value,source,provenance,at,id,value,status,authority,status,authority,source]],
 ];
}

// Pure planner: the statements (without the fence head and the revision bump) the projector's writePerson would run for the Person STATE, given the stored
// localization row. input: {id, person:{identity?, localization?, localizationConflicts?}}; stored: the person_dimension localization row or null.
// Returns {statements, identity, localization, conflicts, aliases} where the last four are the final rows the write leaves (for the replay check and the harness).
export function planPersonState(input,stored=null){
 const id=fenced.personId(input?.id);
 const person=input?.person;
 if(!plain(person)||(!person.identity&&!person.localization))throw failed('film_person_invalid');
 if(person.localizationConflicts!==undefined&&!Array.isArray(person.localizationConflicts))throw failed('film_person_invalid');
 const statements=[[fenced.assertSql('EXISTS (SELECT 1 FROM person WHERE id=?)'),[id]]];
 const out={statements,identity:null,localization:null,conflicts:[],aliases:[],heldIncoming:null};
 let guarded={localization:person.localization,localizationConflicts:person.localizationConflicts||[],aliases:[]};
 if(person.localization){
  guarded=guardReviewed(guarded,stored,'name');
  out.localization=dimensionParams(id,guarded.localization,'localization');
  out.heldIncoming=guarded.localization;
  for(const item of guarded.aliases){
   if(!present(item.value))throw failed('film_person_invalid');
   statements.push([ALIAS_INSERT,[id,item.kind||'name',item.value,json(item.provenance)]]);
   out.aliases.push({kind:item.kind||'name',value:item.value});
  }
  for(const item of heldStatements(id,guarded.localization))statements.push(item);
 }
 if(person.identity){
  out.identity=dimensionParams(id,person.identity,'identity');
  statements.push(["DELETE FROM person_dimension WHERE person_id=? AND dimension<>'localization'",[id]]);
  statements.push(['INSERT INTO person_dimension (person_id,'+COLUMNS+') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',out.identity]);
 }
 if(person.localization)statements.push([LOCALIZATION_UPSERT,out.localization]);
 for(const item of guarded.localizationConflicts){
  const row=conflictParams('person',id,item);
  out.conflicts.push(row[0]);
  statements.push([CONFLICT_INSERT,row]);
 }
 return out;
}

// Pure planner of the standalone conflict rows of one entity. Duplicate ids inside one call are written once.
export function planConflicts(kind,id,conflicts){
 if(kind!=='film'&&kind!=='person')throw failed('film_person_invalid');
 if(kind==='film')fenced.filmId(id);else fenced.personId(id);
 if(!Array.isArray(conflicts)||!conflicts.length)throw failed('film_person_invalid');
 const rows=new Map();
 for(const item of conflicts){const row=conflictParams(kind,id,item);if(!rows.has(row[0]))rows.set(row[0],row);}
 return [...rows.values()];
}

// ---- replay check (content, no receipt table) ----
const same=(row,params)=>!!row&&COLUMNS.split(',').every((key,index)=>{const left=row[key]??null,right=params[index+1]??null;return left===right||(typeof left==='number'&&Number(right)===left);});
const exists=async(db,sql,params)=>!!(await one(db,sql,params));

async function personStateSatisfied(db,id,plan,stored){
 if(plan.identity){
  const row=await one(db,`SELECT ${COLUMNS} FROM person_dimension WHERE person_id=? AND dimension='identity'`,[id]);
  if(!same(row,plan.identity))return false;
 }
 const conflicts=new Set(plan.conflicts),aliases=[...plan.aliases];
 if(plan.localization){
  // Either the upsert would overwrite the stored row (then the stored row must already equal it) or the guard keeps the stored row (nothing to compare).
  if(upsertOverwrites(stored,plan.localization)&&!same(stored,plan.localization))return false;
  const reason=heldReason(stored,plan.heldIncoming);
  if(reason){
   const value=plan.heldIncoming?.value??null;
   conflicts.add('person:'+id+':'+JSON.stringify({reason,value,source:plan.heldIncoming?.source??null}));
   if(value!==null)aliases.push({kind:'name',value});
  }
 }
 for(const key of conflicts)if(!(await exists(db,'SELECT 1 AS x FROM localization_conflict WHERE id=?',[key])))return false;
 for(const item of aliases)if(!(await exists(db,'SELECT 1 AS x FROM person_alias WHERE person_id=? AND kind=? AND value=?',[id,item.kind,item.value])))return false;
 return true;
}

async function currentRevision(db,kind,id){return Number((await one(db,'SELECT revision FROM canonical_revision WHERE kind=? AND id=?',[kind,id]))?.revision??0);}

// Fenced write of one Person's dimension state. One batch; a replay of an applied write (same content) returns without a batch.
// input: {id, expectedRevision, at, requestId, person:{identity?:{status,source,sourceVersion,provenance,lastError,failureReason,retryAt,attempts,nextAction,updatedAt},
//         localization?:{...same, value}, localizationConflicts?:[{value,source,provenance,at,reason}]}}
export async function recordPersonState(env,input){
 const id=fenced.personId(input?.id),expected=fenced.revisionOf(input?.expectedRevision),at=fenced.text(input?.at),requestId=fenced.text(input?.requestId);
 if(!plain(input?.person))throw failed('film_person_invalid');
 const gate=assertWritable(await readAuthority(env));
 const db=database(env);
 if(!(await one(db,'SELECT 1 AS x FROM person WHERE id=?',[id])))throw failed('film_person_reference');
 const stored=await one(db,`SELECT ${COLUMNS} FROM person_dimension WHERE person_id=? AND dimension='localization'`,[id]);
 const plan=planPersonState({id,person:input.person},stored);
 if(await personStateSatisfied(db,id,plan,stored))return {id,revision:await currentRevision(db,'person',id),already:true,requestId};
 const entities=[{kind:'person',id,expected}];
 const statements=fenced.head(gate,entities);
 for(const item of plan.statements)statements.push(item);
 statements.push([fenced.BUMP,['person',id,at]]);
 await fenced.commit(env,gate,statements,entities);
 return {id,revision:expected+1,already:false,requestId};
}

// Fenced write of localization_conflict rows of one Film or Person (outside a merge). Rows are idempotent by their content id; nothing is deleted.
// input: {kind:'film'|'person', id, expectedRevision, at, requestId, conflicts:[{value,source,provenance,at,reason}]}
export async function recordLocalizationConflicts(env,input){
 const kind=input?.kind;
 const rows=planConflicts(kind,input?.id,input?.conflicts);
 const id=input.id,expected=fenced.revisionOf(input.expectedRevision),at=fenced.text(input.at),requestId=fenced.text(input.requestId);
 const gate=assertWritable(await readAuthority(env));
 const db=database(env);
 if(kind==='film'&&await one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[id]))throw failed('film_person_redirect');
 if(!(await one(db,kind==='film'?'SELECT 1 AS x FROM film WHERE id=?':'SELECT 1 AS x FROM person WHERE id=?',[id])))throw failed('film_person_reference');
 const have=new Set((await many(db,`SELECT id FROM localization_conflict WHERE id IN (${rows.map(()=>'?').join(',')})`,rows.map(row=>row[0]))).map(row=>row.id));
 if(rows.every(row=>have.has(row[0])))return {id,revision:await currentRevision(db,kind,id),already:true,written:0,requestId};
 const entities=[{kind,id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push(kind==='film'?[fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]:[fenced.assertSql('EXISTS (SELECT 1 FROM person WHERE id=?)'),[id]]);
 for(const row of rows)statements.push([CONFLICT_INSERT,row]);
 statements.push([fenced.BUMP,[kind,id,at]]);
 await fenced.commit(env,gate,statements,entities);
 return {id,revision:expected+1,already:false,written:rows.filter(row=>!have.has(row[0])).length,requestId};
}

// The calls and the readback entries the producer routing module registers (it assigns them next to its own tables).
export const PERSON_STATE_CALLS={recordPersonState,recordLocalizationConflicts};
export const PERSON_STATE_RECONCILE={
 recordPersonState:{kind:()=>'person',id:input=>input.id,byRequestId:false,byReplay:true},
 recordLocalizationConflicts:{kind:input=>input.kind,id:input=>input.id,byRequestId:false,byReplay:true},
};
