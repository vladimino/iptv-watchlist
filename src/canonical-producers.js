// AIR-371 / ADR 0099 (Accepted), decomposition C4. Producer adapters and the single-writer routing for canonical Film/Person. INACTIVE:
// nothing in the Worker imports this module (it is not bundled; no route, job or cron calls it), no schema is applied and no marker moves.
// While the marker is legacy, r2 or prepared the enrichment projector is the ONLY canonical writer and every adapter here is dormant
// (dispatch returns without a database statement). From open the adapters are the only writers and the projector is compare-only/off;
// held and every unreadable marker fail closed and never fall back to R2 (AIR-374 owns the real handoff and each production step).
// - writerRoute: the one routing decision. Exactly one of the projector and the canonical adapters may write in any state.
// - projectorFence: the SQL assertion a FUTURE projector batch carries so an in-flight projector batch loses once the marker moves
//   (a generation mismatch or mode d1 fails its CHECK and rolls the batch back whole). It is the proof of "no overlap"; today's projector
//   does not include it and is unchanged.
// - plan* functions are pure: they turn the existing producers' data into fenced AIR-367..370 calls, or say why not.
// - dispatch executes a plan only when the route is canonical; an unknown batch outcome is reported, never blindly retried, and is settled
//   by readback (the entity revision) and a replay with the same request id.
// - shadowCompare / handoffReadiness are read-only and bounded. handoffReadiness stays not ready while GAPS lists a producer write that no
//   fenced mutation covers yet.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced,mutateFilm,mutatePerson} from './canonical-mutations.js';
import {compareLocalization,recordLocalizationSources} from './localization-sources.js';
import {admitRatedFilm,retainFilm,verifiedAdmission} from './film-admission.js';
import {recordRetirementDecision} from './tmdb-retirement-decisions.js';

export const SHADOW_ITEM_CAP=200;
export const SHADOW_LIST_CAP=200;
export const SHADOW_READ_CHUNK=80;
// Producer writes that today only the projector performs and that no fenced mutation covers (the AIR-371 audit): the handoff is not ready
// until each of these has a fenced writer, which needs its own decision and card.
export const GAPS=Object.freeze([
 'film_metadata rows (synopsis, poster, genres, runtime, payload, people version)',
 'film_dimension rows (identity, metadata lifecycle, effective localization)',
 'film_sync_state clocks',
 'watchlist_film membership (set and clear)',
 'person_dimension rows and Person localization state',
 'localization_conflict rows outside a merge',
 'canonical_identity and original_title overwrite (the fenced write only fills)',
 'projector revision bumps (the projector does not move canonical_revision)',
]);
const ROLES=new Set(['director','actor']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const skipped=(producer,reason)=>({producer,calls:[],skipped:[{reason}]});

// One routing decision from the marker. legacy/r2/prepared: the projector writes, the adapters are dormant. open: the adapters write, the
// projector is compare-only. held and an unreadable marker throw (film_person_held / film_person_unavailable) and name no writer.
export async function writerRoute(env){
 const gate=await readAuthority(env);
 if(gate.r2Allowed===true)return {writer:'projector',projector:'writes',canonical:'dormant',state:gate.state,generation:gate.generation};
 if(gate.state==='open')return {writer:'canonical',projector:'compare_only',canonical:'writes',state:gate.state,generation:gate.generation};
 assertWritable(gate); // throws film_person_held / film_person_unavailable
 throw failed('film_person_unavailable');
}

// The statement a projector batch would add after its own fence. Null when there is no marker (legacy): nothing to prove. Otherwise it
// holds only while the marker is r2 or prepared at the generation the projector read, so a batch that started before a move to open
// (or any generation change) fails whole.
export function projectorFence(gate){
 if(!gate||gate.state==='legacy')return null;
 if(gate.r2Allowed!==true)throw failed('film_person_not_projector');
 return [fenced.assertSql("EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode IN ('r2','prepared') AND cutover='open' AND generation=?)"),[gate.generation]];
}

// EPG identity and the aliases, trusted ids and credits of the projector's Film entity. The credits are upserts only: no removal, no
// ordinal renumbering, so the D1-only TMDB credits survive. `revisions` maps an entity id to the revision the caller read (absent = 0; use
// readRevisions). A credit's Person must be created by this plan (`persons`) or already exist in D1 (`knownPersons`), otherwise the plan is
// refused (`credit_person_unresolved`): film_person_credit references person, so the calls run PERSONS FIRST, then the Film. The plan is NOT
// one atomic batch (`atomic:false`): each call is its own fenced batch, so a later failure leaves the earlier calls applied. Every call is
// idempotent in content (aliases and ids upsert, a credit that exists is kept), so after a partial outcome the caller re-reads the revisions
// (readRevisions), re-plans and dispatches again; the replay converges and never duplicates.
// input: {at, epgGeneration, revisions:{id:n}, knownPersons?:[id], film:{id, contractVersion?, canonicalIdentity?, originalTitle?, externalIds?, aliases?, localization?},
//   credits?:[{personId, role}], persons?:[{id, roleId, contractVersion?, externalIds?, aliases?, localization?}]}
export function planEpgIdentity(input){
 const film=input?.film;
 if(!plain(film)||typeof film.id!=='string'||!film.id.startsWith('film:')||typeof input.at!=='string')return skipped('epg_identity','invalid_input');
 const revisions=plain(input.revisions)?input.revisions:{};
 const rev=id=>Number.isInteger(revisions[id])&&revisions[id]>=0?revisions[id]:0;
 const persons=[];
 for(const person of input.persons||[]){
  if(!plain(person)||typeof person.id!=='string'||typeof person.roleId!=='string')return skipped('epg_identity','invalid_person');
  persons.push(person);
 }
 const resolvable=new Set([...persons.map(person=>person.id),...(Array.isArray(input.knownPersons)?input.knownPersons:[])]);
 const credits=[];
 for(const credit of input.credits||[]){
  if(!credit||!ROLES.has(credit.role)||typeof credit.personId!=='string')return skipped('epg_identity','invalid_credit');
  if(!resolvable.has(credit.personId))return skipped('epg_identity','credit_person_unresolved');
  credits.push({personId:credit.personId,role:credit.role});
 }
 const calls=persons.map(person=>({fn:'mutatePerson',input:{id:person.id,expectedRevision:rev(person.id),at:input.at,person:{roleId:person.roleId,contractVersion:Number.isInteger(person.contractVersion)?person.contractVersion:1,externalIds:person.externalIds||[],aliases:person.aliases||[]}}}));
 calls.push({fn:'mutateFilm',input:{id:film.id,expectedRevision:rev(film.id),at:input.at,film:{contractVersion:Number.isInteger(film.contractVersion)?film.contractVersion:1,canonicalIdentity:film.canonicalIdentity??undefined,originalTitle:film.originalTitle??undefined,externalIds:film.externalIds||[],aliases:film.aliases||[]},credits:credits.length?{upsert:credits}:undefined}});
 return {producer:'epg_identity',atomic:false,epgGeneration:input.epgGeneration??null,calls,skipped:[]};
}

// Automatic localization candidates only: a reviewed or owner value, an empty one or an inconsistent one never becomes a source write.
// input: {kind, id, localization, resolved, revision, at, requestId}
export function planLocalization(input){
 if(!plain(input)||!['film','person'].includes(input.kind)||typeof input.id!=='string'||typeof input.requestId!=='string'||typeof input.at!=='string')return skipped('localization','invalid_input');
 const compared=compareLocalization(input.resolved||{tier:'none',value:null},input.localization);
 if(!compared.candidate)return skipped('localization',compared.outcome);
 return {producer:'localization',outcome:compared.outcome,calls:[{fn:'recordLocalizationSources',input:{kind:input.kind,id:input.id,expectedRevision:Number.isInteger(input.revision)?input.revision:0,at:input.at,requestId:input.requestId,sources:[{source:compared.candidate.source,value:compared.candidate.value,sourceVersion:compared.candidate.sourceVersion||'unknown',provenance:compared.candidate.provenance||{},observedAt:compared.candidate.observedAt}]}}],skipped:[]};
}

// A Discovery catalog admission: a verified movie id (scheme `tmdb`, from a `tmdb_<n>` key) becomes film:tmdb:<n> or lands on the Film that
// already holds it. `tmdb_tv_*` keys, an unverified entry and a held (untrusted or conflicting) typed claim are never admitted.
// input: {key, entry:{verified:true,...}, resolved:{id,revision,held,redirected}, at}
export function planDiscoveryAdmission(input){
 const match=/^tmdb_([1-9]\d{0,11})$/.exec(String(input?.key??''));
 if(!match)return skipped('discovery_admission',/^tmdb_tv_/.test(String(input?.key??''))?'tmdb_tv_is_not_a_film':'invalid_key');
 if(input.entry?.verified!==true)return skipped('discovery_admission','not_verified');
 const resolved=input.resolved;
 if(!plain(resolved)||typeof resolved.id!=='string'||typeof input.at!=='string')return skipped('discovery_admission','invalid_input');
 if(resolved.held)return skipped('discovery_admission','admission_identity_held');
 if(resolved.redirected)return skipped('discovery_admission','redirected');
 return {producer:'discovery_admission',calls:[{fn:'mutateFilm',input:{id:resolved.id,expectedRevision:Number.isInteger(resolved.revision)?resolved.revision:0,at:input.at,film:{contractVersion:1,originalTitle:typeof input.entry.title==='string'&&input.entry.title?input.entry.title:undefined,externalIds:[{scheme:'tmdb',value:match[1],trusted:true,provenance:{source:'discovery',verified:true}}]}}}],skipped:[]};
}

// A verified rated-only admission (the receipt stays the immutable evidence) and the watchlist retention fact.
export function planRatedAdmission(input){
 const checked=verifiedAdmission(input?.receiptKey,input?.receipt);
 if(!checked.ok)return skipped('rated_admission',checked.reason);
 if(typeof input.requestId!=='string'||typeof input.at!=='string')return skipped('rated_admission','invalid_input');
 return {producer:'rated_admission',calls:[{fn:'admitRatedFilm',input:{receiptKey:input.receiptKey,receipt:input.receipt,filmId:input.filmId,expectedRevision:Number.isInteger(input.expectedRevision)?input.expectedRevision:0,at:input.at,requestId:input.requestId}}],skipped:[]};
}
export function planRetention(input){
 if(!plain(input)||typeof input.id!=='string'||typeof input.watchlist!=='boolean'||typeof input.requestId!=='string'||typeof input.at!=='string'||typeof input.observedAt!=='string')return skipped('retention','invalid_input');
 return {producer:'retention',calls:[{fn:'retainFilm',input:{id:input.id,expectedRevision:Number.isInteger(input.expectedRevision)?input.expectedRevision:0,at:input.at,requestId:input.requestId,watchlist:input.watchlist,observedAt:input.observedAt,evidence:input.evidence}}],skipped:[]};
}
// An owner-only TMDB retirement decision (retire or an explicit restore). It is journalled, never applied to identity rows here.
export function planRetirement(input){
 if(!plain(input)||typeof input.requestId!=='string'||typeof input.at!=='string')return skipped('retirement','invalid_input');
 return {producer:'retirement',calls:[{fn:'recordRetirementDecision',input:{...input}}],skipped:[]};
}

// One batch of plans must come from one EPG generation: a plan from another generation is never mixed in.
export function planBatch(plans){
 const generations=new Set(plans.filter(plan=>plan.epgGeneration!==undefined&&plan.epgGeneration!==null).map(plan=>plan.epgGeneration));
 if(generations.size>1)return {ok:false,reason:'mixed_generation',generations:[...generations]};
 return {ok:true,plans};
}

const CALLS={mutateFilm,mutatePerson,recordLocalizationSources,admitRatedFilm,retainFilm,recordRetirementDecision};

// Executes a plan only when the route is canonical. In legacy, r2 and prepared nothing runs and no statement reaches the database; held and
// unreadable markers throw. Each call is one fenced batch. A thrown unknown outcome (film_person_unavailable) is returned as `unknown` and is
// NOT retried: settle it with readback() and then replay with the same request id. A lost fence or revision is a `conflict` to read again.
export async function dispatch(env,plan){
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {executed:false,reason:'projector_is_writer',route,results:[]};
 const results=[];
 for(const call of plan.calls||[]){
  const run=CALLS[call.fn];
  if(!run)throw failed('canonical_producer_invalid');
  try{results.push({fn:call.fn,status:'applied',result:await run(env,call.input)});}
  catch(error){
   if(error?.code==='film_person_unavailable'){results.push({fn:call.fn,status:'unknown',code:error.code,input:call.input});break;}
   if(error?.code==='film_person_fence'||error?.code==='film_person_revision_conflict'){results.push({fn:call.fn,status:'conflict',code:error.code});break;}
   if(error?.code&&/held|identity|collision|conflict|redirect|invalid|not_open|admission|retirement/.test(error.code)){results.push({fn:call.fn,status:'refused',code:error.code});break;}
   throw error;
  }
 }
 const applied=results.filter(item=>item.status==='applied').length;
 return {executed:true,route,results,complete:applied===(plan.calls||[]).length,partial:applied>0&&applied<(plan.calls||[]).length};
}

// What each call kind can settle by itself. A request id makes a replay a no-op (the writer opens no batch for a request it already applied);
// mutateFilm and mutatePerson carry NO request id: they are idempotent in content, not by request id.
const RECONCILE={
 mutateFilm:{kind:()=>'film',id:input=>input.id,byRequestId:false},
 mutatePerson:{kind:()=>'person',id:input=>input.id,byRequestId:false},
 recordLocalizationSources:{kind:input=>input.kind,id:input=>input.id,byRequestId:true},
 admitRatedFilm:{kind:()=>'film',id:input=>input.filmId||(/^tmdb_(\d+)$/.exec(String(input.receiptKey))?'film:tmdb:'+/^tmdb_(\d+)$/.exec(String(input.receiptKey))[1]:null),byRequestId:true},
 retainFilm:{kind:()=>'film',id:input=>input.id,byRequestId:true},
 recordRetirementDecision:{kind:()=>'film',id:input=>input.filmId,byRequestId:true},
};
export async function readRevisions(env,ids){
 const db=database(env);
 const list=[...new Set(ids)];
 const out={};
 for(let at=0;at<list.length;at+=SHADOW_READ_CHUNK){
  const chunk=list.slice(at,at+SHADOW_READ_CHUNK);
  for(const row of await many(db,`SELECT kind,id,revision FROM canonical_revision WHERE id IN (${chunk.map(()=>'?').join(',')})`,chunk))out[row.id]=Number(row.revision);
 }
 for(const id of list)if(!(id in out))out[id]=0;
 return out;
}

// Does D1 hold EXACTLY the state a mutateFilm/mutatePerson call would have left? Every write effect the call advertises is compared: the Film or
// Person row fields it sets (contract version, role id, and canonical identity / original title when given), each external id with its trust,
// conflict flag and provenance, each removal (the row must be absent), each alias and each upserted credit (present), each credit removal (absent).
// Anything that differs, or that cannot be proven equal, is "not present": a competing producer may have changed the entity, and a replay
// through the revision check is then the safe path. Read-only.
const jsonOf=value=>value===undefined||value===null?null:JSON.stringify(value);
async function contentPresent(db,fn,input){
 if(!plain(input))return false;
 const isFilm=fn==='mutateFilm';
 const table=isFilm?'film_external_id':'person_external_id',column=isFilm?'film_id':'person_id',aliasTable=isFilm?'film_alias':'person_alias';
 const body=isFilm?input.film:input.person;
 if(!plain(body))return false;
 if(isFilm){
  const row=await one(db,'SELECT contract_version,canonical_identity,original_title FROM film WHERE id=?',[input.id]);
  if(!row||row.contract_version!==body.contractVersion)return false;
  if(body.canonicalIdentity!==undefined&&body.canonicalIdentity!==null&&row.canonical_identity!==body.canonicalIdentity)return false;
  if(body.originalTitle!==undefined&&body.originalTitle!==null&&row.original_title!==body.originalTitle)return false;
 }else{
  const row=await one(db,'SELECT role_id,contract_version FROM person WHERE id=?',[input.id]);
  if(!row||row.role_id!==body.roleId||row.contract_version!==body.contractVersion)return false;
 }
 for(const item of body.removeExternalIds||[])if(await one(db,`SELECT 1 AS x FROM ${table} WHERE ${column}=? AND scheme=? AND value=?`,[input.id,item.scheme,String(item.value)]))return false;
 for(const item of body.externalIds||[]){
  const row=await one(db,`SELECT trusted,conflicting,provenance_json FROM ${table} WHERE ${column}=? AND scheme=? AND value=?`,[input.id,item.scheme,String(item.value)]);
  if(!row||row.trusted!==(item.trusted&&!item.conflicting?1:0)||row.conflicting!==(item.conflicting?1:0)||(row.provenance_json??null)!==jsonOf(item.provenance))return false;
 }
 for(const item of body.aliases||[])if(!(await one(db,`SELECT 1 AS x FROM ${aliasTable} WHERE ${column}=? AND kind=? AND value=?`,[input.id,item.kind||(isFilm?'title':'name'),item.value])))return false;
 if(isFilm){
  for(const item of input.credits?.remove||[])if(await one(db,'SELECT 1 AS x FROM film_person_credit WHERE film_id=? AND person_id=? AND role=?',[input.id,item.personId,item.role]))return false;
  for(const item of input.credits?.upsert||[])if(!(await one(db,'SELECT 1 AS x FROM film_person_credit WHERE film_id=? AND person_id=? AND role=?',[input.id,item.personId,item.role])))return false;
 }
 return true;
}

// Read-only. After an unknown outcome. A moved revision is NOT proof that THIS call applied (any competing producer moves it), so the verdict is
// never "applied" from the revision alone:
// - not_applied: the revision is still the expected one, the atomic batch left nothing; re-dispatch with the same revision.
// - settle_by_request_id: the writer dedupes by request id; replay the same call (a no-op if it applied; a `conflict` to re-read if it did not).
// - content_present: mutateFilm/mutatePerson only, the revision moved and D1 holds EXACTLY the state the call would have left (every value, trust, provenance, removal); otherwise reread_and_replan.
// - reread_and_replan: the revision moved and the content is missing; read the revisions again (readRevisions), re-plan and dispatch (idempotent in content).
// - unsupported: the call kind or its entity cannot be reconciled; block it, never guess.
export async function readback(env,call){
 const spec=RECONCILE[call?.fn];
 const input=call?.input;
 const kind=spec&&plain(input)?spec.kind(input):null,id=spec&&plain(input)?spec.id(input):null;
 if(!spec||typeof id!=='string'||!['film','person'].includes(kind))return {outcome:'unsupported',applied:null};
 const db=database(env);
 const row=await one(db,'SELECT revision FROM canonical_revision WHERE kind=? AND id=?',[kind,id]);
 const revision=Number(row?.revision??0),expected=Number(input.expectedRevision??0);
 const base={id,kind,revision,expected,moved:revision>expected};
 if(spec.byRequestId)return {...base,outcome:'settle_by_request_id',applied:null,note:'replay the same call: an applied request id is a no-op'};
 if(revision<=expected)return {...base,outcome:'not_applied',applied:false};
 if(await contentPresent(db,call.fn,input))return {...base,outcome:'content_present',applied:null,note:'the wanted content exists; a competing writer may have written it'};
 return {...base,outcome:'reread_and_replan',applied:false};
}

const capped=list=>list.length>SHADOW_LIST_CAP?list.slice(0,SHADOW_LIST_CAP):list;
// Compare-only and bounded: what the projector's Film entities say (external ids, aliases, credits) against the D1 rows. Nothing is written.
// items: [{id, externalIds:[{scheme,value,trusted}], aliases:[{kind,value}], credits:[{personId,role}]}], at most SHADOW_ITEM_CAP per call.
export async function shadowCompare(env,items){
 if(!Array.isArray(items))throw failed('canonical_producer_invalid');
 const truncatedInput=items.length>SHADOW_ITEM_CAP;
 const list=items.slice(0,SHADOW_ITEM_CAP);
 const db=database(env);
 const report={compared:list.length,same:0,missing:[],differs:[],truncated:truncatedInput,agree:true};
 for(let at=0;at<list.length;at+=SHADOW_READ_CHUNK){
  const chunk=list.slice(at,at+SHADOW_READ_CHUNK),ids=chunk.map(item=>item.id),marks=ids.map(()=>'?').join(',');
  const [films,externals,aliases,credits]=await Promise.all([
   many(db,`SELECT id FROM film WHERE id IN (${marks})`,ids),
   many(db,`SELECT film_id,scheme,value,trusted FROM film_external_id WHERE film_id IN (${marks})`,ids),
   many(db,`SELECT film_id,kind,value FROM film_alias WHERE film_id IN (${marks})`,ids),
   many(db,`SELECT film_id,person_id,role FROM film_person_credit WHERE film_id IN (${marks})`,ids),
  ]);
  const have=new Set(films.map(row=>row.id));
  const by=(rows,key)=>{const out=new Map();for(const row of rows){if(!out.has(row.film_id))out.set(row.film_id,new Set());out.get(row.film_id).add(key(row));}return out;};
  const ext=by(externals,row=>row.scheme+':'+row.value+':'+(row.trusted===1?1:0)),ali=by(aliases,row=>row.kind+':'+row.value),cred=by(credits,row=>row.person_id+'/'+row.role);
  for(const item of chunk){
   if(!have.has(item.id)){report.missing.push(item.id);continue;}
   const fields=[];
   const absent=(planned,stored)=>planned.filter(key=>!(stored?.has(key)));
   if(absent((item.externalIds||[]).map(x=>x.scheme+':'+x.value+':'+(x.trusted?1:0)),ext.get(item.id)).length)fields.push('externalIds');
   if(absent((item.aliases||[]).map(x=>(x.kind||'title')+':'+x.value),ali.get(item.id)).length)fields.push('aliases');
   if(absent((item.credits||[]).map(x=>x.personId+'/'+x.role),cred.get(item.id)).length)fields.push('credits');
   // A D1-only credit (AIR-286) is not a difference: only planned values missing from D1 count.
   if(fields.length)report.differs.push({id:item.id,fields});else report.same++;
  }
 }
 report.missing=capped(report.missing);report.differs=capped(report.differs);
 report.agree=!report.missing.length&&!report.differs.length&&!truncatedInput;
 return report;
}

// Read-only readiness for the AIR-374 handoff. It never writes. `ready` is false while the marker, the baseline, the later schemas, the
// projector lease or GAPS say so; it is information for the owner's decision, never a permission.
export async function handoffReadiness(env,{now=new Date().toISOString()}={}){
 const blockers=[];
 let gate=null;
 try{gate=await readAuthority(env);}catch(error){blockers.push('marker_unreadable:'+(error?.code||'error'));}
 if(gate){
  if(gate.state!=='prepared')blockers.push('marker_not_prepared:'+gate.state);
  if(gate.baseline!=='verified')blockers.push('baseline_not_verified:'+String(gate.baseline));
 }
 const db=database(env);
 if(db){
  try{
   const version=Number((await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??0);
   if(version<16)blockers.push('schema_below_16:'+version);
   const lease=await one(db,"SELECT lease_until FROM projection_run WHERE projection='enrichment' AND lease_id IS NOT NULL AND lease_until>?",[now]).catch(()=>null);
   if(lease)blockers.push('projector_lease_live');
  }catch{blockers.push('schema_unreadable');}
 }else blockers.push('no_database');
 for(const gap of GAPS)blockers.push('gap:'+gap);
 return {ready:blockers.length===0,blockers,gaps:[...GAPS]};
}
