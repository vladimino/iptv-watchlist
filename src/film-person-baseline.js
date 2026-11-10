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
export const stable=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
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

// ---------- the ONE value encoding, shared by both sides ----------
// Every class compares a KEY (the primary key columns joined by the separator) and a VALUE: the listed columns, in this order, each coerced by its declared type
// and serialized as a JSON ARRAY by encodeValue. The D1 reader and the expected-side mapper both call encodeValue with a plain array of the class's columns, so
// equal data cannot encode differently. A class with no value column (an alias, a watchlist row) encodes as `[]` on both sides.
//   int  : an integer (a boolean becomes 1 or 0); text : a string (ids and digests are text on both sides); null stays null.
// Per class: film [contract_version, canonical_identity, original_title]; person [role_id]; filmExternalId/personExternalId [trusted, conflicting];
// filmAlias/personAlias []; credit [ordinal]; filmLocalization/personLocalization [status, authority, value]; watchlist []; redirect [to_film_id];
// retirement [state, movie_id, tv_id]; ratedAdmission [tmdb, source_code, archive_sha256]; retention [watchlist]; ownerLink [identity_link, identity_state];
// projectionKey [change_key].
export const VALUE_COLUMNS=Object.freeze({
 film:[['contract_version','int'],['canonical_identity','text'],['original_title','text']],
 person:[['role_id','text']],
 filmExternalId:[['trusted','int'],['conflicting','int']],
 personExternalId:[['trusted','int'],['conflicting','int']],
 filmAlias:[],personAlias:[],
 credit:[['ordinal','int']],
 filmLocalization:[['status','text'],['authority','text'],['value','text']],
 personLocalization:[['status','text'],['authority','text'],['value','text']],
 watchlist:[],
 redirect:[['to_film_id','text']],
 retirement:[['state','text'],['movie_id','text'],['tv_id','text']],
 ratedAdmission:[['tmdb','text'],['source_code','text'],['archive_sha256','text']],
 retention:[['watchlist','int']],
 ownerLink:[['identity_link','text'],['identity_state','text']],
 projectionKey:[['change_key','text']],
});
function coerce(type,value){
 if(value===null||value===undefined)return null;
 if(type==='int'){const number=typeof value==='boolean'?(value?1:0):Number(value);if(!Number.isInteger(number))throw failed('baseline_encoding');return number;}
 return String(value);
}
export function encodeValue(name,values){
 const columns=VALUE_COLUMNS[name];
 if(!columns||!Array.isArray(values)||values.length!==columns.length)throw failed('baseline_encoding');
 return JSON.stringify(values.map((value,index)=>coerce(columns[index][1],value)));
}

// ---------- the expected side: the projector's own view, normalized ----------
// inputs: enrichmentInputs() output {films:[{id,film,watchlist,credits}],people:[{id,person}]}; extra: {class:[[key, [column values...]]]} for the classes the view does not
// carry (retirement, admission, retention, owner links, redirects, projection keys); each value is the plain array of that class's columns and goes through encodeValue.
export function expectedFromInputs(inputs,extra={}){
 const classes={};
 const put=(name,key,values)=>{(classes[name]||(classes[name]=[])).push([key,encodeValue(name,values)]);};
 for(const name of CLASS_NAMES)classes[name]=[];
 const trust=item=>[item.trusted&&!item.conflicting?1:0,item.conflicting?1:0];
 const localization=state=>[state.status,state.provenance?.authority??null,state.value??null];
 for(const entry of inputs?.films||[]){
  const film=entry.film||{},id=entry.id;
  put('film',id,[film.contractVersion??null,film.canonicalIdentity??null,film.originalTitle??null]);
  for(const item of film.externalIds||[])put('filmExternalId',keyOf(id,item.scheme,String(item.value)),trust(item));
  for(const item of film.aliases||[])put('filmAlias',keyOf(id,item.kind||'title',item.value),[]);
  for(const credit of entry.credits||[])put('credit',keyOf(id,credit.personId,credit.role),[credit.ordinal]);
  if(film.localization?.status)put('filmLocalization',id,localization(film.localization));
  if(entry.watchlist===true)put('watchlist',id,[]);
  for(const redirect of film.redirects||[])put('redirect',redirect.from||redirect.id,[redirect.to||redirect.survivor||null]);
 }
 for(const entry of inputs?.people||[]){
  const person=entry.person||{},id=entry.id;
  put('person',id,[person.roleId??null]);
  for(const item of person.externalIds||[])put('personExternalId',keyOf(id,item.scheme,String(item.value)),trust(item));
  for(const item of person.aliases||[])put('personAlias',keyOf(id,item.kind||'name',item.value),[]);
  if(person.localization?.status)put('personLocalization',id,localization(person.localization));
 }
 for(const [name,entries] of Object.entries(extra))if(CLASS_NAMES.includes(name))classes[name]=entries.map(([key,values])=>[key,encodeValue(name,values)]);
 return classes;
}

// ---------- explanations ----------
// A rule explains one difference (never a whole class). Context (see contextFromActual): explainedPersons (unkeyed Persons that are VERIFIED AIR-286 Persons or are
// named by an owner exception: an unkeyed Person alone is not an explanation), watchlistFilms, retainedFilms (Films D1 keeps through retention or a rated admission).
// Owner exceptions (class C) must carry a reason and the approving owner; an exception without both is ignored.
const first=key=>key.split(SEP)[0];
const credited=({key,context})=>{
 const [film,person,role]=key.split(SEP);
 if(context.exceptedPersons?.has(person)===true)return true;
 // The AIR-286 / projector rule: a TMDB credit in the role of its id on a watchlist Film stays in D1 although the R2 view does not carry it.
 const match=/^person:(tmdb_director|tmdb_actor)\//.exec(person||'');
 return !!match&&AIR286_ROLE[match[1]]===role&&context.watchlistFilms?.has(film)===true;
};
const ofExplained=({key,context})=>context.explainedPersons?.has(first(key))===true;
export const DEFAULT_EXPLANATIONS=Object.freeze([
 {id:'d1_only_credit',class:'credit',side:'extra',note:'AIR-286: a TMDB credit in the role of its id on a watchlist Film (or of an owner-excepted Person), which only D1 holds',test:credited},
 {id:'d1_only_person',class:'person',side:'extra',note:'a Person without a projector key whose AIR-286 provenance is verified, or an owner-excepted id',test:({key,context})=>context.explainedPersons?.has(key)===true},
 {id:'d1_only_person_row',class:'personExternalId',side:'extra',note:'rows of an explained Person only',test:ofExplained},
 {id:'d1_only_person_alias',class:'personAlias',side:'extra',note:'rows of an explained Person only',test:ofExplained},
 {id:'d1_only_person_localization',class:'personLocalization',side:'extra',note:'rows of an explained Person only',test:ofExplained},
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
// The interface of the reader over a D1 binding (or the sqlite stand-in): get and all for reads, run for the cut's lease row.
export function readerOf(binding){
 return {
  get:async(sql,params=[])=>(await binding.prepare(sql).bind(...params).first())??null,
  all:async(sql,params=[])=>(await binding.prepare(sql).bind(...params).all()).results||[],
  run:async(sql,params=[])=>{await binding.prepare(sql).bind(...params).run();},
 };
}
// `value` is derived from VALUE_COLUMNS (the one encoding); `witness` is the bounded aggregate of the cut check (see readWitness).
const SPEC=Object.freeze([
 {name:'film',table:'film',key:['id'],witness:'COUNT(*) AS n, MAX(updated_at) AS t'},
 {name:'person',table:'person',key:['id'],witness:'COUNT(*) AS n, MAX(updated_at) AS t'},
 {name:'filmExternalId',table:'film_external_id',key:['film_id','scheme','value'],witness:'COUNT(*) AS n, SUM(trusted) AS a, SUM(conflicting) AS b'},
 {name:'personExternalId',table:'person_external_id',key:['person_id','scheme','value'],witness:'COUNT(*) AS n, SUM(trusted) AS a, SUM(conflicting) AS b'},
 {name:'filmAlias',table:'film_alias',key:['film_id','kind','value'],witness:'COUNT(*) AS n, SUM(length(value)) AS a'},
 {name:'personAlias',table:'person_alias',key:['person_id','kind','value'],witness:'COUNT(*) AS n, SUM(length(value)) AS a'},
 {name:'credit',table:'film_person_credit',key:['film_id','person_id','role'],witness:'COUNT(*) AS n, SUM(ordinal) AS a, SUM(length(person_id)) AS b'},
 {name:'filmLocalization',table:'film_dimension',where:"dimension='localization'",key:['film_id'],witness:'COUNT(*) AS n, MAX(updated_at) AS t'},
 {name:'personLocalization',table:'person_dimension',where:"dimension='localization'",key:['person_id'],witness:'COUNT(*) AS n, MAX(updated_at) AS t'},
 {name:'watchlist',table:'watchlist_film',key:['film_id'],witness:'COUNT(*) AS n, MAX(updated_at) AS t'},
 {name:'redirect',table:'film_redirect',key:['from_id'],witness:'COUNT(*) AS n, SUM(length(to_film_id)) AS a'},
 {name:'retirement',table:'tmdb_retirement_current',key:['film_id'],witness:'COUNT(*) AS n, MAX(seq) AS a',optional:true},
 {name:'ratedAdmission',table:'film_rated_admission',key:['film_id'],witness:'COUNT(*) AS n, MAX(updated_at) AS t',optional:true},
 {name:'retention',table:'film_retention',key:['film_id'],witness:'COUNT(*) AS n, MAX(updated_at) AS t',optional:true},
 {name:'ownerLink',table:'owner_review_entry',key:['kind','source_key'],witness:"COUNT(*) AS n, SUM(generation) AS a, SUM(length(COALESCE(identity_link,''))) AS b"},
 {name:'projectionKey',table:'projection_state',where:"projection='enrichment'",key:['kind','id'],witness:'COUNT(*) AS n, MAX(projected_at) AS t'},
].map(spec=>({...spec,value:VALUE_COLUMNS[spec.name].map(([column])=>column)})));
// Tables the ledger does not compare but whose change shows a writer at work (the revision table of 0013 and the tables of 0014; all optional).
const EXTRA_WITNESS=Object.freeze([
 {name:'canonicalRevision',table:'canonical_revision',witness:'COUNT(*) AS n, SUM(revision) AS a',optional:true},
 {name:'filmLocalizationSource',table:'film_localization_source',witness:'COUNT(*) AS n, MAX(updated_at) AS t',optional:true},
 {name:'personLocalizationSource',table:'person_localization_source',witness:'COUNT(*) AS n, MAX(updated_at) AS t',optional:true},
 {name:'filmMetadata',table:'film_metadata',witness:'COUNT(*) AS n, MAX(updated_at) AS t'},
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
  for(const row of rows)bucket.push([spec.key.map(col=>String(row[col])).join(SEP),encodeValue(spec.name,spec.value.map(col=>row[col]??null))]);
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

// ---------- the stable cut ----------
// D1 has no snapshot isolation across separate queries, so a keyset read is only a CUT of the data when nothing writes while it runs. Two guards, both needed:
//  (a) the read TAKES the projector's own lease (projection_run, the SQL of the projector and of scripts/d1-projection-seed.mjs) before it reads a page, renews it at
//      every page and checks at every page that the row still names us (holder and started_at); a foreign or lost lease aborts the read as `lease_lost`; if a live
//      foreign lease already stands, nothing is read (`lease_unavailable`). The lease is released in a finally.
//  (b) a CONTENT WITNESS: per table, a bounded aggregate (a count plus a maximum timestamp, or sums of the stored flags, ordinals, lengths and revisions) taken at the
//      start, re-taken for the table just read at EVERY page boundary and for every table at the end; any difference refuses the read as `unstable_cut:<table>`.
// What the cut does NOT cover: a writer that takes neither the lease nor changes a witnessed aggregate (an update that keeps every count, sum and maximum, or a change
// that is reverted between two witnesses) and a write by a writer that ignores the lease between the last witness and the end of the read. In r2 the writers are the
// enrichment projector (it takes the lease, so it cannot write during the read) and one-off owner operations such as the AIR-286 credits script, owner-review writes and
// Admin routes, which do not take it and are caught only by the witness; the fenced AIR-367..370 writers are dormant (they refuse unless the marker is open). The
// witness is a fingerprint, not a proof; the ledger digest names one measurement, and a later write makes it stale. A cut is one lease term and is not resumed.
export const LEASE_MS=10*60000;
export const CUT_MAX_PAGES=5000;
const PROJECTION='enrichment';
const ACQUIRE='INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES (?,?,?,?) ON CONFLICT(projection) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until,started_at=excluded.started_at WHERE projection_run.lease_until IS NULL OR projection_run.lease_until<?';
async function witnessOf(db,spec){
 try{return stable(await db.get(`SELECT ${spec.witness} FROM ${spec.table}${spec.where?' WHERE '+spec.where:''}`));}
 catch(error){if(spec.optional&&noTable(error))return null;throw failed('baseline_read_unavailable',error);}
}
export async function readWitness(db,specs=[...SPEC,...EXTRA_WITNESS]){
 const out={};
 for(const spec of specs)out[spec.name]=await witnessOf(db,spec);
 return out;
}
const leaseHeld=async(db,leaseId,startedAt)=>{const row=await db.get("SELECT lease_id, started_at FROM projection_run WHERE projection='enrichment'");return row?.lease_id===leaseId&&row.started_at===startedAt;};
export async function readStableCut(db,{leaseId,ttlMs=LEASE_MS,now=()=>new Date().toISOString(),pageSize=PAGE_SIZE,maxPages=CUT_MAX_PAGES,personExceptions=[]}={}){
 if(typeof leaseId!=='string'||!leaseId)throw failed('baseline_invalid');
 const startedAt=now(),until=new Date(Date.parse(startedAt)+ttlMs).toISOString();
 await db.run(ACQUIRE,[PROJECTION,leaseId,until,startedAt,startedAt]);
 if(!await leaseHeld(db,leaseId,startedAt))return {done:false,consistent:false,reasons:['lease_unavailable'],leaseId,pages:0};
 const reasons=[];
 let state=null,pages=0,verification={verified:[],rejected:[]},gateBefore=null,gateAfter=null;
 try{
  gateBefore=await readGate(db,{now:startedAt});
  const before=await readWitness(db);
  for(;;){
   const previous=state?state.classIndex:0;
   state=await readD1State(db,{state,pageSize,queryBudget:1});
   pages++;
   // The lease is renewed and re-checked at every page: a foreign take (even one released again before the end) changes the row and aborts the read.
   await db.run('UPDATE projection_run SET lease_until=? WHERE projection=? AND lease_id=?',[new Date(Date.parse(now())+ttlMs).toISOString(),PROJECTION,leaseId]);
   if(!await leaseHeld(db,leaseId,startedAt)){reasons.push('lease_lost');break;}
   const spec=SPEC[previous];
   if(spec&&!state.unavailable.includes(spec.name)&&await witnessOf(db,spec)!==before[spec.name]){reasons.push('unstable_cut:'+spec.name);break;}
   if(state.done)break;
   if(pages>=maxPages){reasons.push('budget_exceeded');break;}
  }
  if(!reasons.length){
   const unkeyed=unkeyedPersonIds(state.entries);
   verification=await verifyAir286(db,unkeyed);
   const after=await readWitness(db);
   for(const name of Object.keys(after))if(after[name]!==before[name])reasons.push('unstable_cut:'+name);
   gateAfter=await readGate(db,{now:now()});
   if(!gateBefore.marker||!gateAfter.marker)reasons.push('marker_unreadable');
   else if(stable(gateBefore.marker)!==stable(gateAfter.marker))reasons.push('marker_moved');
   if(stable(gateBefore.baseline)!==stable(gateAfter.baseline))reasons.push('baseline_changed');
   if(!await leaseHeld(db,leaseId,startedAt))reasons.push('lease_lost');
  }
 }finally{
  await db.run('UPDATE projection_run SET lease_id=NULL, lease_until=NULL WHERE projection=? AND lease_id=?',[PROJECTION,leaseId]);
 }
 const done=state?.done===true;
 return {done,entries:state?.entries,unavailable:state?.unavailable,queries:state?.queries,pages,consistent:done&&reasons.length===0,reasons,gateBefore,gateAfter,leaseId,air286:verification};
}
const unkeyedPersonIds=entries=>{
 const keyed=new Set((entries.projectionKey||[]).filter(([key])=>key.startsWith('person'+SEP)).map(([key])=>key.split(SEP)[1]));
 return (entries.person||[]).map(([id])=>id).filter(id=>!keyed.has(id));
};

// ---------- provenance of a Person without a projector key ----------
// A Person the projector did not key is not thereby legitimate: it can be a corrupted or incomplete projection. It is explained only when its AIR-286 provenance is
// VERIFIED from what the AIR-286 writer (scripts/tmdb-watchlist-credits.mjs) actually leaves: id person:tmdb_director/<n> or person:tmdb_actor/<n> with role_id the
// id without its prefix and contract version 1; at most one alias, of kind `name`, whose provenance is exactly {"source":"tmdb","task":"AIR-286"}; no external id and no
// dimension row; at least one credit, each in the role of its id (tmdb_director -> director, tmdb_actor -> actor) on a Film that has a Letterboxd id (a watchlist Film)
// or is a watchlist member. Everything else is rejected with its reasons, stays unexplained and keeps the gate closed, unless the owner lists the id in an exception.
const AIR286_PROVENANCE=stable({source:'tmdb',task:'AIR-286'});
const AIR286_ID=/^person:(tmdb_director|tmdb_actor)\/[1-9]\d{0,11}$/;
const AIR286_ROLE={tmdb_director:'director',tmdb_actor:'actor'};
const group=(rows,column)=>{const out=new Map();for(const row of rows){if(!out.has(row[column]))out.set(row[column],[]);out.get(row[column]).push(row);}return out;};
export async function verifyAir286(db,ids,{chunk=80,cap=LIST_CAP}={}){
 const verified=new Set(),rejected=[];let rejectedCount=0;
 const list=[...new Set(ids)].sort();
 for(let at=0;at<list.length;at+=chunk){
  const part=list.slice(at,at+chunk),marks=part.map(()=>'?').join(',');
  const [people,aliases,externals,dimensions,credits]=await Promise.all([
   db.all(`SELECT id, role_id, contract_version FROM person WHERE id IN (${marks})`,part),
   db.all(`SELECT person_id, kind, provenance_json FROM person_alias WHERE person_id IN (${marks})`,part),
   db.all(`SELECT person_id, COUNT(*) AS n FROM person_external_id WHERE person_id IN (${marks}) GROUP BY person_id`,part),
   db.all(`SELECT person_id, COUNT(*) AS n FROM person_dimension WHERE person_id IN (${marks}) GROUP BY person_id`,part),
   db.all(`SELECT c.person_id, c.role, EXISTS (SELECT 1 FROM film_external_id l WHERE l.film_id=c.film_id AND l.scheme='letterboxd') AS letterboxd, EXISTS (SELECT 1 FROM watchlist_film w WHERE w.film_id=c.film_id) AS listed FROM film_person_credit c WHERE c.person_id IN (${marks})`,part),
  ]);
  const aliasBy=group(aliases,'person_id'),creditBy=group(credits,'person_id');
  const externalBy=new Map(externals.map(row=>[row.person_id,row.n])),dimensionBy=new Map(dimensions.map(row=>[row.person_id,row.n]));
  const personBy=new Map(people.map(row=>[row.id,row]));
  for(const id of part){
   const reasons=[],row=personBy.get(id),match=AIR286_ID.exec(id);
   if(!match)reasons.push('id_shape');
   if(!row)reasons.push('no_person_row');
   else{
    if(match&&row.role_id!==id.slice('person:'.length))reasons.push('role_id');
    if(Number(row.contract_version)!==1)reasons.push('contract_version');
   }
   const own=aliasBy.get(id)||[];
   // Fail closed: the alias with the writer's marker is the only independent proof, so none (an unnamed Person) or several is not proof.
   if(own.length!==1)reasons.push(own.length?'alias_count':'alias_missing');
   for(const alias of own){
    if(alias.kind!=='name')reasons.push('alias_kind');
    let parsed;try{parsed=stable(JSON.parse(alias.provenance_json));}catch{parsed=null;}
    if(parsed!==AIR286_PROVENANCE)reasons.push('alias_provenance');
   }
   if(externalBy.get(id))reasons.push('external_ids');
   if(dimensionBy.get(id))reasons.push('dimensions');
   const own2=creditBy.get(id)||[];
   if(!own2.length)reasons.push('no_credit');
   for(const credit of own2){
    if(match&&credit.role!==AIR286_ROLE[match[1]])reasons.push('credit_role');
    if(!(credit.letterboxd===1||credit.listed===1))reasons.push('credit_film');
   }
   if(reasons.length){rejectedCount++;if(rejected.length<cap)rejected.push({id,reasons:[...new Set(reasons)]});}
   else verified.add(id);
  }
 }
 return {verified:[...verified].sort(),rejected,rejectedCount};
}

// Context for the explanation rules, from the actual side of one cut and its provenance check. explainedPersons are the unkeyed Persons that are VERIFIED AIR-286
// Persons or are listed in a valid owner exception (id, reason, approvedBy); an exception for a keyed Person, or an id that is not in D1, explains nothing, and an
// exception covers the rows of exactly its own id.
export function contextFromActual(actual,{air286=[],personExceptions=[]}={}){
 const unkeyed=new Set(unkeyedPersonIds(actual.classes));
 const exceptedPersons=new Set((Array.isArray(personExceptions)?personExceptions:[]).filter(item=>item&&typeof item.id==='string'&&typeof item.reason==='string'&&item.reason.trim()&&typeof item.approvedBy==='string'&&item.approvedBy.trim()).map(item=>item.id).filter(id=>unkeyed.has(id)));
 const verified=new Set((Array.isArray(air286)?air286:[]).filter(id=>unkeyed.has(id)));
 const retainedFilms=new Set([...(actual.classes.retention||[]).map(([id])=>id),...(actual.classes.ratedAdmission||[]).map(([id])=>id)]);
 const watchlistFilms=new Set((actual.classes.watchlist||[]).map(([id])=>id));
 return {unkeyedPersons:unkeyed,air286Persons:verified,exceptedPersons,explainedPersons:new Set([...verified,...exceptedPersons]),retainedFilms,watchlistFilms};
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
