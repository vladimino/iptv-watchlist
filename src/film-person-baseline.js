// AIR-373 stage A / ADR 0099 (Accepted), decomposition C6a. OFFLINE baseline tooling for canonical Film/Person: a parity ledger, a keyset D1 reader with a
// consistent-read check, a delta plan, an importer driver with a durable checkpoint, and the baseline gate with its recorder. INACTIVE: nothing in the
// Worker imports this module (it is not bundled; no route, job or cron calls it), it reads no R2, it is run against fixtures and the sqlite stand-in, and
// the production baseline import and the r2 -> prepared move stay separate owner-gated operations.
// - Through r2 and prepared the enrichment projector is the ONLY canonical Film/Person writer. The importer is therefore not a second writer: it applies a unit
//   through an INJECTED writer (the real one is the projector repository under the projector's lease and fence, as scripts/d1-projection-seed.mjs does), in
//   bounded idempotent units, with a write-ahead checkpoint the caller persists. The fenced AIR-367..370 mutations are for the open state and are not used here.
// - The ledger compares an EXPECTED set (derived from R2 by the projector's own view, see expectedFromInputs) with the ACTUAL set read from D1, per class,
//   with counts, order-independent sha256 digests and differences classified missing / extra / differs. A difference is explained only by an explicit rule
//   or an owner-supplied exception; the gate needs zero unexplained differences, a complete and consistent read and a verified source identity.
// - Lists in a ledger name keys only (never a title, name or payload) and are bounded.
import {database,failed,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';

export const LEDGER_VERSION=1;
export const LIST_CAP=200;
export const PAGE_SIZE=500;
export const QUERY_BUDGET=400;
export const UNIT_PEOPLE=25;
const SEP='\u001f';
export const keyOf=(...parts)=>parts.map(String).join(SEP);
const stable=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export async function sha256Hex(text){
 const bytes=new TextEncoder().encode(text);
 return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}

// The compared classes, in the order a ledger lists them. `unit` says how a difference is repaired: through a Film unit, a People unit, or not by the importer.
export const CLASSES=Object.freeze([
 {name:'film',unit:'film'},{name:'person',unit:'people'},
 {name:'filmExternalId',unit:'film'},{name:'personExternalId',unit:'people'},
 {name:'filmAlias',unit:'film'},{name:'personAlias',unit:'people'},
 {name:'credit',unit:'film'},
 {name:'filmLocalization',unit:'film'},{name:'personLocalization',unit:'people'},
 {name:'watchlist',unit:'film'},
 {name:'redirect',unit:'decision'},{name:'retirement',unit:'decision'},
 {name:'ratedAdmission',unit:'decision'},{name:'retention',unit:'decision'},
 {name:'ownerLink',unit:'decision'},{name:'projectionKey',unit:'decision'},
]);
const CLASS_NAMES=CLASSES.map(item=>item.name);
const UNIT_OF=Object.fromEntries(CLASSES.map(item=>[item.name,item.unit]));

// ---------- the expected side: the projector's own view, normalized ----------
// inputs: enrichmentInputs() output {films:[{id,film,watchlist,credits}],people:[{id,person}]}; extra: optional pre-normalized classes (retirement, admission,
// retention, owner links, redirects, projection keys) the caller derives from the same sources.
export function expectedFromInputs(inputs,extra={}){
 const classes={};
 const put=(name,key,value)=>{(classes[name]||(classes[name]=[])).push([key,stable(value)]);};
 for(const name of CLASS_NAMES)classes[name]=[];
 for(const entry of inputs?.films||[]){
  const film=entry.film||{},id=entry.id;
  put('film',id,[film.contractVersion??null,film.canonicalIdentity??null,film.originalTitle??null]);
  for(const item of film.externalIds||[])put('filmExternalId',keyOf(id,item.scheme,String(item.value)),[item.trusted&&!item.conflicting?1:0,item.conflicting?1:0]);
  for(const item of film.aliases||[])put('filmAlias',keyOf(id,item.kind||'title',item.value),null);
  for(const credit of entry.credits||[])put('credit',keyOf(id,credit.personId,credit.role),credit.ordinal);
  if(film.localization?.status)put('filmLocalization',id,[film.localization.status,film.localization.provenance?.authority??null,film.localization.value??null]);
  if(entry.watchlist===true)put('watchlist',id,null);
  for(const redirect of film.redirects||[])put('redirect',redirect.from||redirect.id,redirect.to||redirect.survivor||null);
 }
 for(const entry of inputs?.people||[]){
  const person=entry.person||{},id=entry.id;
  put('person',id,[person.roleId??null]);
  for(const item of person.externalIds||[])put('personExternalId',keyOf(id,item.scheme,String(item.value)),[item.trusted&&!item.conflicting?1:0,item.conflicting?1:0]);
  for(const item of person.aliases||[])put('personAlias',keyOf(id,item.kind||'name',item.value),null);
  if(person.localization?.status)put('personLocalization',id,[person.localization.status,person.localization.provenance?.authority??null,person.localization.value??null]);
 }
 for(const [name,entries] of Object.entries(extra))if(CLASS_NAMES.includes(name))classes[name]=entries.map(([key,value])=>[key,typeof value==='string'?value:stable(value)]);
 return classes;
}

// ---------- explanations ----------
// A rule explains one difference (never a whole class). Context: unkeyedPersons (D1 Persons with no projector key by design), retainedFilms (Films D1 keeps
// through retention or a rated admission). Owner exceptions (class C) must carry a reason and the approving owner; an exception without both is ignored.
const first=key=>key.split(SEP)[0];
export const DEFAULT_EXPLANATIONS=Object.freeze([
 {id:'d1_only_credit',class:'credit',side:'extra',note:'AIR-286: TMDB credits only D1 holds (person:tmdb_*, or a Person without a projector key)',test:({key,context})=>{const person=key.split(SEP)[1]||'';return person.startsWith('person:tmdb_')||context.unkeyedPersons?.has(person)===true;}},
 {id:'d1_only_person',class:'person',side:'extra',note:'a Person D1 holds without a projector key by design',test:({key,context})=>context.unkeyedPersons?.has(key)===true},
 {id:'d1_only_person_row',class:'personExternalId',side:'extra',note:'rows of a Person without a projector key',test:({key,context})=>context.unkeyedPersons?.has(first(key))===true},
 {id:'d1_only_person_alias',class:'personAlias',side:'extra',note:'rows of a Person without a projector key',test:({key,context})=>context.unkeyedPersons?.has(first(key))===true},
 {id:'d1_only_person_localization',class:'personLocalization',side:'extra',note:'rows of a Person without a projector key',test:({key,context})=>context.unkeyedPersons?.has(first(key))===true},
 ...['film','filmExternalId','filmAlias','credit','filmLocalization'].map(name=>({id:'retained_film_'+name,class:name,side:'extra',note:'a Film kept by retention or a rated admission outside the current view',test:({key,context})=>context.retainedFilms?.has(first(key))===true})),
]);
function explain({cls,side,key,expectedValue,actualValue},{explanations,exceptions,context}){
 for(const rule of explanations)if(rule.class===cls&&rule.side===side&&rule.test({key,expected:expectedValue,actual:actualValue,context}))return rule.id;
 for(const item of exceptions)if(item.class===cls&&item.key===key)return 'owner_exception';
 return null;
}
const validException=item=>item&&typeof item.class==='string'&&typeof item.key==='string'&&typeof item.reason==='string'&&item.reason.trim()&&typeof item.approvedBy==='string'&&item.approvedBy.trim();

// ---------- the ledger ----------
const asMap=entries=>entries instanceof Map?entries:new Map(Array.isArray(entries)?entries:Object.entries(entries||{}));
async function classDigest(map){
 const lines=[...map.entries()].map(([key,value])=>key+SEP+value).sort();
 return {count:map.size,digest:await sha256Hex(lines.join('\n'))};
}
// Pure and deterministic. expected / actual: {classes:{name:[[key,value]...]}, unavailable?:[name], complete?:boolean, consistent?:boolean, source?:{aggregateSha256,verified}}.
// Returns the ledger and, with `diffs`, the full difference lists the planner needs (they are not part of the ledger).
export async function buildParityLedger({expected,actual,explanations=DEFAULT_EXPLANATIONS,exceptions=[],context={},source=null,listCap=LIST_CAP}){
 const valid=(Array.isArray(exceptions)?exceptions:[]).filter(validException),invalidExceptions=(Array.isArray(exceptions)?exceptions.length:0)-valid.length;
 const opts={explanations,exceptions:valid,context};
 const classes={},unexplainedList=[],explainedSample=[],diffs=[];
 let complete=actual?.complete!==false&&expected?.complete!==false;
 const totals={missing:0,extra:0,differs:0,explained:0,unexplained:0};
 const unavailable=new Set([...(expected?.unavailable||[]),...(actual?.unavailable||[])]);
 for(const name of CLASS_NAMES){
  if(unavailable.has(name)||!expected?.classes?.[name]||!actual?.classes?.[name]){classes[name]={unavailable:true};complete=false;continue;}
  const e=asMap(expected.classes[name]),a=asMap(actual.classes[name]);
  const entry={expected:await classDigest(e),actual:await classDigest(a),missing:0,extra:0,differs:0,explained:{total:0,byRule:{}},unexplained:{missing:0,extra:0,differs:0,total:0}};
  const keys=[...new Set([...e.keys(),...a.keys()])].sort();
  for(const key of keys){
   const hasE=e.has(key),hasA=a.has(key);
   const side=hasE&&hasA?(e.get(key)===a.get(key)?null:'differs'):hasE?'missing':'extra';
   if(!side)continue;
   entry[side]++;totals[side]++;
   const rule=explain({cls:name,side,key,expectedValue:e.get(key),actualValue:a.get(key)},opts);
   if(rule){entry.explained.total++;entry.explained.byRule[rule]=(entry.explained.byRule[rule]||0)+1;totals.explained++;if(explainedSample.length<listCap)explainedSample.push({class:name,side,key,rule});}
   else{entry.unexplained[side]++;entry.unexplained.total++;totals.unexplained++;if(unexplainedList.length<listCap)unexplainedList.push({class:name,side,key});diffs.push({class:name,side,key});}
  }
  entry.matchedDigest=(await sha256Hex(keys.filter(k=>e.has(k)&&a.has(k)&&e.get(k)===a.get(k)).join('\n')));
  classes[name]=entry;
 }
 const ledger={version:LEDGER_VERSION,classes,totals,complete,readConsistent:actual?.consistent===true,invalidExceptions,source:source||expected?.source||null,unexplainedList,unexplainedTruncated:totals.unexplained>unexplainedList.length,explainedSample,explainedTruncated:totals.explained>explainedSample.length};
 ledger.digest=await ledgerDigest(ledger);
 return {ledger,diffs};
}
export async function ledgerDigest(ledger){
 const core={version:ledger.version,complete:ledger.complete,readConsistent:ledger.readConsistent,totals:ledger.totals,source:ledger.source?{aggregateSha256:ledger.source.aggregateSha256??null,verified:ledger.source.verified===true}:null,classes:Object.fromEntries(Object.entries(ledger.classes).map(([name,c])=>[name,c.unavailable?{unavailable:true}:{expected:c.expected,actual:c.actual,matchedDigest:c.matchedDigest,unexplained:c.unexplained}]))};
 return sha256Hex(stable(core));
}

// ---------- the baseline gate ----------
const HEX64=/^[0-9a-f]{64}$/;
// Pass only when the ledger is complete, the read was consistent, the source identity is a verified digest, every class was compared, nothing is unexplained and
// the ledger's digest still matches its content (a doctored ledger fails).
export async function baselineGate(ledger){
 const reasons=[];
 if(!ledger||ledger.version!==LEDGER_VERSION)return {pass:false,reasons:['ledger_version']};
 if(ledger.complete!==true)reasons.push('incomplete');
 if(ledger.readConsistent!==true)reasons.push('inconsistent_read');
 if(!(ledger.source&&ledger.source.verified===true&&HEX64.test(String(ledger.source.aggregateSha256||''))))reasons.push('source_unverified');
 for(const name of CLASS_NAMES)if(!ledger.classes?.[name]||ledger.classes[name].unavailable)reasons.push('class_unavailable:'+name);
 if(!(ledger.totals?.unexplained===0))reasons.push('unexplained:'+ledger.totals?.unexplained);
 if(typeof ledger.digest!=='string'||ledger.digest!==await ledgerDigest(ledger))reasons.push('digest_mismatch');
 return {pass:reasons.length===0,reasons};
}

// ---------- the D1 reader ----------
// The read interface of the reader over a D1 binding (or the sqlite stand-in): get(sql,params) and all(sql,params).
export function readerOf(binding){
 return {get:async(sql,params=[])=>(await binding.prepare(sql).bind(...params).first())??null,all:async(sql,params=[])=>(await binding.prepare(sql).bind(...params).all()).results||[]};
}
const SPEC=Object.freeze([
 {name:'film',table:'film',key:['id'],value:['contract_version','canonical_identity','original_title']},
 {name:'person',table:'person',key:['id'],value:['role_id']},
 {name:'filmExternalId',table:'film_external_id',key:['film_id','scheme','value'],value:['trusted','conflicting']},
 {name:'personExternalId',table:'person_external_id',key:['person_id','scheme','value'],value:['trusted','conflicting']},
 {name:'filmAlias',table:'film_alias',key:['film_id','kind','value'],value:[]},
 {name:'personAlias',table:'person_alias',key:['person_id','kind','value'],value:[]},
 {name:'credit',table:'film_person_credit',key:['film_id','person_id','role'],value:['ordinal']},
 {name:'filmLocalization',table:'film_dimension',where:"dimension='localization'",key:['film_id'],value:['status','authority','value']},
 {name:'personLocalization',table:'person_dimension',where:"dimension='localization'",key:['person_id'],value:['status','authority','value']},
 {name:'watchlist',table:'watchlist_film',key:['film_id'],value:[]},
 {name:'redirect',table:'film_redirect',key:['from_id'],value:['to_film_id']},
 {name:'retirement',table:'tmdb_retirement_current',key:['film_id'],value:['state','movie_id','tv_id'],optional:true},
 {name:'ratedAdmission',table:'film_rated_admission',key:['film_id'],value:['tmdb','source_code','archive_sha256'],optional:true},
 {name:'retention',table:'film_retention',key:['film_id'],value:['watchlist'],optional:true},
 {name:'ownerLink',table:'owner_review_entry',key:['kind','source_key'],value:['identity_link','identity_state']},
 {name:'projectionKey',table:'projection_state',where:"projection='enrichment'",key:['kind','id'],value:['change_key']},
]);
// The localization value is compared by digest through the ledger and never listed; the reader returns entries as [key,value] pairs of strings.
const noTable=error=>/no such table/i.test(String(error?.message||error))||/no such table/i.test(String(error?.cause?.message||''));

function pageSql(spec,after,limit){
 const key=spec.key,cols=[...key,...spec.value].join(', ');
 const where=[spec.where].filter(Boolean);
 const params=[];
 if(after){where.push(key.length===1?`${key[0]} > ?`:`(${key.join(', ')}) > (${key.map(()=>'?').join(', ')})`);params.push(...after);}
 return {sql:`SELECT ${cols} FROM ${spec.table}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY ${key.join(', ')} LIMIT ?`,params:[...params,limit]};
}
// One bounded read: pages of `pageSize` by keyset, at most `queryBudget` queries, resumable from `state` ({classIndex, after, entries, unavailable}). Returns the
// state; `done` is true when every class was read. An optional table that does not exist makes its class unavailable, never empty.
export async function readD1State(db,{state=null,pageSize=PAGE_SIZE,queryBudget=QUERY_BUDGET}={}){
 const current=state?JSON.parse(JSON.stringify(state)):{classIndex:0,after:null,entries:{},unavailable:[],queries:0};
 let used=0;
 while(current.classIndex<SPEC.length){
  const spec=SPEC[current.classIndex];
  if(used>=queryBudget)return {...current,done:false};
  const {sql,params}=pageSql(spec,current.after,pageSize);
  let rows;
  try{rows=await db.all(sql,params);}
  catch(error){
   if(spec.optional&&noTable(error)){current.unavailable.push(spec.name);current.classIndex++;current.after=null;used++;continue;}
   throw failed('baseline_read_unavailable',error);
  }
  used++;current.queries++;
  const bucket=current.entries[spec.name]||(current.entries[spec.name]=[]);
  for(const row of rows)bucket.push([spec.key.map(col=>String(row[col])).join(SEP),stable(spec.value.map(col=>row[col]??null))]);
  if(rows.length<pageSize){current.classIndex++;current.after=null;}
  else{const last=rows[rows.length-1];current.after=spec.key.map(col=>last[col]);}
 }
 return {...current,done:true};
}

// The marker, the baseline row and the projector lease, for the consistent-read check and the importer's gate.
export async function readGate(db,{now=new Date().toISOString()}={}){
 let marker=null,baseline=null,lease=null;
 try{marker=await db.get('SELECT mode, cutover, generation FROM film_person_authority WHERE id=1');baseline=await db.get('SELECT state, reference FROM film_person_baseline WHERE id=1');}
 catch(error){if(!noTable(error))throw failed('baseline_read_unavailable',error);}
 try{lease=await db.get("SELECT lease_id, lease_until FROM projection_run WHERE projection='enrichment'");}catch(error){if(!noTable(error))throw failed('baseline_read_unavailable',error);}
 const live=!!(lease?.lease_id&&(typeof lease.lease_until!=='string'||lease.lease_until>now));
 return {marker:marker?{mode:marker.mode,cutover:marker.cutover,generation:Number(marker.generation)}:null,baseline:baseline?{state:baseline.state,reference:baseline.reference??null}:null,lease:{id:lease?.lease_id??null,until:lease?.lease_until??null,live}};
}
// A full read bracketed by two gate reads. It is consistent only when the marker did not move, the baseline row did not change and no live lease other than ours
// stood at either end; the reasons name what failed. A budget stop returns done false and the state to resume from.
export async function readConsistently(db,{state=null,ownLeaseId=null,now=()=>new Date().toISOString(),pageSize,queryBudget}={}){
 const before=state?.gateBefore||await readGate(db,{now:now()});
 const read=await readD1State(db,{state,pageSize,queryBudget});
 if(!read.done)return {done:false,state:{...read,gateBefore:before},consistent:null,reasons:[]};
 const after=await readGate(db,{now:now()});
 const reasons=[];
 if(!before.marker||!after.marker)reasons.push('marker_unreadable');
 else if(stable(before.marker)!==stable(after.marker))reasons.push('marker_moved');
 if(stable(before.baseline)!==stable(after.baseline))reasons.push('baseline_changed');
 for(const gate of [before,after])if(gate.lease.live&&gate.lease.id!==ownLeaseId&&!reasons.includes('foreign_lease_live'))reasons.push('foreign_lease_live');
 return {done:true,entries:read.entries,unavailable:read.unavailable,queries:read.queries,consistent:reasons.length===0,reasons,gateBefore:before,gateAfter:after};
}
// Context for the explanation rules, from the actual side of one read.
export function contextFromActual(actual){
 const keyed=new Set((actual.classes.projectionKey||[]).filter(([key])=>key.startsWith('person'+SEP)).map(([key])=>key.split(SEP)[1]));
 const unkeyedPersons=new Set((actual.classes.person||[]).map(([id])=>id).filter(id=>!keyed.has(id)));
 const retainedFilms=new Set([...(actual.classes.retention||[]).map(([id])=>id),...(actual.classes.ratedAdmission||[]).map(([id])=>id)]);
 return {unkeyedPersons,retainedFilms};
}

// ---------- the delta plan ----------
// Work units from the unexplained differences: a missing or differing Film row-set becomes one Film unit (as the projector writes one Film per batch), a missing
// or differing Person row-set joins a People group of `unitPeople`; extras and the classes the projector does not own (redirects, retirements, admissions,
// retention, owner links, projector keys) are listed for an owner decision and are never applied by the importer. Each unit carries the digest of the D1 rows
// it was planned against, so a competing write is detected before the unit is applied.
export async function planReconciliation({diffs,actual,ledgerDigest:digest,unitPeople=UNIT_PEOPLE}){
 const films=new Set(),people=new Set(),manual=[],extras=[];
 for(const diff of diffs){
  const unit=UNIT_OF[diff.class];
  if(diff.side==='extra'){extras.push(diff);continue;}
  if(unit==='film')films.add(first(diff.key));
  else if(unit==='people')people.add(first(diff.key));
  else manual.push(diff);
 }
 const byEntity=(ids,classes)=>{
  const lines=[];
  for(const name of classes)for(const [key,value] of actual.classes[name]||[])if(ids.has(first(key)))lines.push(name+SEP+key+SEP+value);
  return sha256Hex(lines.sort().join('\n'));
 };
 const filmClasses=CLASSES.filter(item=>item.unit==='film').map(item=>item.name),personClasses=CLASSES.filter(item=>item.unit==='people').map(item=>item.name);
 const units=[];
 for(const id of [...films].sort())units.push({kind:'film',ids:[id],d1Digest:await byEntity(new Set([id]),filmClasses)});
 const sortedPeople=[...people].sort();
 for(let at=0;at<sortedPeople.length;at+=unitPeople){const ids=sortedPeople.slice(at,at+unitPeople);units.push({kind:'people',ids,d1Digest:await byEntity(new Set(ids),personClasses)});}
 for(const unit of units)unit.id=(await sha256Hex(unit.kind+SEP+unit.ids.join(SEP))).slice(0,16);
 const plan={version:1,ledgerDigest:digest,units,manual:manual.slice(0,LIST_CAP),manualCount:manual.length,extras:extras.slice(0,LIST_CAP),extraCount:extras.length};
 plan.digest=await sha256Hex(stable({ledgerDigest:digest,units:units.map(u=>[u.id,u.kind,u.ids,u.d1Digest]),manualCount:manual.length,extraCount:extras.length}));
 return plan;
}

// ---------- the importer driver ----------
const leaseLost=error=>error?.code==='lease_lost'||/CHECK constraint failed/i.test(String(error?.message||error)||'');
const stop=(state,reason,extra={})=>({stopped:reason,complete:false,state,...extra});
// writer: {acquire():{leaseId}|null, release(leaseId), currentDigest(unit), apply(unit,{leaseId}), readback(unit):{state:'applied'|'not_applied'|'unknown'}} (the projector repository
// under the projector's lease in production). gate(): {ok,reason?} re-reads the marker and the lease before every unit. save(state): the caller persists the checkpoint;
// it is called BEFORE a unit is applied (inFlight) and after its outcome, so a crash leaves a state that resume settles by readback, never by a blind re-apply.
export async function runImport({plan,checkpoint=null,writer,save,gate,maxUnits=Infinity}){
 if(!plan||!Array.isArray(plan.units)||typeof plan.digest!=='string')throw failed('baseline_plan_invalid');
 if(checkpoint&&checkpoint.planDigest!==plan.digest)throw failed('baseline_plan_changed');
 const state=checkpoint?JSON.parse(JSON.stringify(checkpoint)):{version:1,planDigest:plan.digest,done:[],stale:[],inFlight:null,applied:0};
 const lease=await writer.acquire();
 if(!lease?.leaseId)throw failed('baseline_lease_unavailable');
 const done=new Set(state.done),staleSet=new Set(state.stale);
 const mark=async unit=>{state.done.push(unit.id);done.add(unit.id);state.inFlight=null;state.applied++;await save(state);};
 try{
  if(state.inFlight){
   const unit=plan.units.find(item=>item.id===state.inFlight.unitId);
   if(unit){
    const back=await writer.readback(unit);
    if(back?.state==='applied')await mark(unit);
    else if(back?.state==='not_applied'){state.inFlight=null;await save(state);}
    else return stop(state,'unknown_outcome',{unit:unit.id});
   }else{state.inFlight=null;await save(state);}
  }
  let processed=0;
  for(const unit of plan.units){
   if(done.has(unit.id)||staleSet.has(unit.id))continue;
   if(processed>=maxUnits)break;
   const g=await gate();
   if(!g?.ok)return stop(state,'gate_moved',{reason:g?.reason||'gate'});
   if(await writer.currentDigest(unit)!==unit.d1Digest){state.stale.push(unit.id);staleSet.add(unit.id);await save(state);continue;}
   for(let attempt=1;attempt<=2;attempt++){
    state.inFlight={unitId:unit.id,attempt};await save(state);
    // Only the write itself is inside the try: a failure of the caller's persistence (save) is not a failed write and must stop the run, never be retried.
    let applied=false;
    try{await writer.apply(unit,{leaseId:lease.leaseId});applied=true;}
    catch(error){
     if(leaseLost(error))return stop(state,'lease_lost',{unit:unit.id});
     const back=await writer.readback(unit);
     if(back?.state==='applied')applied=true;
     else if(back?.state==='not_applied'&&attempt<2)continue;
     else return stop(state,back?.state==='not_applied'?'unit_failed':'unknown_outcome',{unit:unit.id});
    }
    if(applied){await mark(unit);break;}
   }
   processed++;
  }
  const remaining=plan.units.filter(unit=>!done.has(unit.id)&&!staleSet.has(unit.id)).length;
  return {complete:remaining===0&&state.stale.length===0,remaining,state,stopped:null};
 }finally{await Promise.resolve(writer.release(lease.leaseId)).catch(()=>{});}
}
// The gate the importer re-reads before every unit: the marker still r2 / open at the expected generation, and the projector lease is the importer's own.
export function makeGate(db,{expectedGeneration,leaseId,now=()=>new Date().toISOString()}){
 return async()=>{
  const g=await readGate(db,{now:now()});
  if(!g.marker)return {ok:false,reason:'marker_unreadable'};
  if(g.marker.mode!=='r2'||g.marker.cutover!=='open')return {ok:false,reason:'marker_not_r2'};
  if(g.marker.generation!==expectedGeneration)return {ok:false,reason:'marker_generation_moved'};
  if(g.lease.id!==leaseId||!g.lease.live)return {ok:false,reason:'lease_not_ours'};
  return {ok:true};
 };
}

// ---------- recording the baseline ----------
const MARKER_R2=generation=>[fenced.assertSql("EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode='r2' AND cutover='open' AND generation=?)"),[generation]];
async function markerR2(env,expectedGeneration){
 const gate=await readAuthority(env);
 if(gate.state!=='r2'||gate.generation!==expectedGeneration)throw failed('baseline_marker_not_r2');
 return gate;
}
async function runBatch(env,statements,expectedGeneration){
 const db=database(env);
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));}
 catch(error){
  if(/CHECK constraint failed/i.test(String(error?.message||error))){
   let again;try{again=await readAuthority(env);}catch{throw failed('film_person_unavailable',error);}
   if(again.state!=='r2'||again.generation!==expectedGeneration)throw failed('baseline_marker_not_r2',error);
   throw failed('baseline_state_changed',error);
  }
  throw failed('film_person_unavailable',error);
 }
}
// Marks the baseline load as started (empty -> loading, or loading -> loading) with a reference (a run id). It refuses unless the marker is r2 at the expected generation.
export async function markBaselineLoading(env,{reference,expectedGeneration,at}){
 if(typeof reference!=='string'||!reference||typeof at!=='string')throw failed('baseline_invalid');
 await markerR2(env,expectedGeneration);
 await runBatch(env,[MARKER_R2(expectedGeneration),
  // A verified baseline may be reopened while the marker is r2 (the trigger of migration 0013 allows exactly that and refuses it from prepared and d1).
  [fenced.assertSql("EXISTS (SELECT 1 FROM film_person_baseline WHERE id=1 AND state IN ('empty','loading','verified'))"),[]],
  ["UPDATE film_person_baseline SET state='loading', reference=?, updated_at=? WHERE id=1",[reference,at]]],expectedGeneration);
 return {state:'loading',reference};
}
// Records the baseline as verified (empty|loading -> verified, reference = the ledger digest) in ONE batch, only when the gate passes and the marker is r2 at the
// expected generation. The moves go through the triggers of migration 0013 (empty -> loading -> verified). It never moves the marker: r2 -> prepared is a separate owner step.
export async function recordBaselineVerified(env,{ledger,expectedGeneration,at}){
 if(typeof at!=='string'||!Number.isInteger(expectedGeneration))throw failed('baseline_invalid');
 const gate=await baselineGate(ledger);
 if(!gate.pass){const error=failed('baseline_gate_failed');error.reasons=gate.reasons;throw error;}
 await markerR2(env,expectedGeneration);
 const db=database(env);
 const row=await one(db,'SELECT state, reference FROM film_person_baseline WHERE id=1');
 if(row?.state==='verified'&&row.reference===ledger.digest)return {state:'verified',reference:ledger.digest,already:true};
 if(row?.state==='verified')throw failed('baseline_state_changed');
 await runBatch(env,[MARKER_R2(expectedGeneration),
  [fenced.assertSql("EXISTS (SELECT 1 FROM film_person_baseline WHERE id=1 AND state IN ('empty','loading'))"),[]],
  ["UPDATE film_person_baseline SET state='loading', reference=?, updated_at=? WHERE id=1",[ledger.digest,at]],
  ["UPDATE film_person_baseline SET state='verified', reference=?, updated_at=? WHERE id=1",[ledger.digest,at]]],expectedGeneration);
 return {state:'verified',reference:ledger.digest,already:false};
}
