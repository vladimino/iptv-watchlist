// AIR-662 / ADR 0218 decision 3 (D1, Accepted). The projection-aware localization write of ONE canonical Film: the automatic source rows of film_localization_source
// AND the effective localization row (film_dimension 'localization') in ONE fenced D1 batch, so a source that the existing resolver makes effective can no longer stay
// invisible to the display readers (finding F5). DORMANT like the other canonical writers: it reaches the database only after assertWritable (marker d1/open), and only
// the metadata_sync producer calls it (operation kind film_localization_projection). Nothing here reads R2, writes Person rows, owner rows or a reviewed row.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced,MUTATION_STATEMENT_CAP} from './canonical-mutations.js';
import {AUTOMATIC_SOURCE_ORDER,OWNER_PROJECTION,isOwnerProjection,ownerCandidatesFromEntries,resolveLocalization} from './localization-sources.js';
import {canonicalJson,digestOf} from './canonical-receipts.js';
import {LOCALIZATION_ROW,readFilmSnapshot} from './canonical-film-writers.js';

const ROW=LOCALIZATION_ROW;
const SOURCE=/^[a-z][a-z0-9_]{0,39}$/;
const RESERVED=new Set(['owner','dictionary','reviewed']);
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const parse=text=>{if(text==null)return null;try{return JSON.parse(text);}catch{return null;}};
const instant=value=>{if(typeof value!=='string'||!ISO.test(value))return null;const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;};

// One fenced batch writes the automatic source rows AND recomputes the effective localization row (film_dimension 'localization') from the source rows as they
// stand after the write, the stored reviewed/owner row and the verified owner_review_entry values of the Film and its redirect ancestors, through the EXISTING
// resolveLocalization (owner > reviewed > automatic; within automatic the fixed source order, then the newer observation, then the source name). No new precedence.
// Two fences ride in the batch: the Film revision CAS (fenced.head) and the owner-review token (marker generation plus the content of every owner row consumed).
// owner_review_entry is another domain, so the Film CAS alone does not cover it: a change of either fence between plan and commit refuses the batch and the caller replans.
// A lower tier never replaces a higher one: an owner or reviewed effective value is never written by this path (the row keeps it, or owner_review_entry owns it), and the
// SQL guard of dimensionUpsert repeats strong(). Person localization is out of scope (recordLocalizationSources, unchanged).
export const PROJECTION_OWNER_ENTRY_CAP=16;
export const PROJECTION_REDIRECT_DEPTH=8;
export const PROJECTION_ANCESTOR_CAP=32;
// The resolver identity bound into the projection digest: a change of the resolver's order is a different operation content, never a replay of an old one.
export const PROJECTION_RESOLVER=Object.freeze({version:1,order:Object.freeze([...AUTOMATIC_SOURCE_ORDER])});
const OWNER_ENTRY_SQL="SELECT source_key,identity_link,identity_state,payload_json,generation FROM owner_review_entry WHERE kind='film' AND identity_state='verified' AND identity_link IN ";

// Read only. The owner-review token of ONE Film: the marker generation and the verified owner rows of the Film and every id redirected to it. Fails closed with
// `localization_owner_unavailable` when the owner domain is not D1-authoritative (absent tables, mode r2, a writes value other than open/held, a read error): without it
// the precedence cannot be proven. A redirect chain deeper or wider than its bound fails with `film_person_bounded`.
export async function readOwnerReviewToken(env,id){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const filmId=fenced.filmId(id);
 let marker;
 try{marker=await one(db,'SELECT mode,generation,writes FROM owner_review_authority WHERE id=1');}
 catch(error){throw failed('localization_owner_unavailable',error);}
 if(!marker||marker.mode!=='d1'||(marker.writes!=='open'&&marker.writes!=='held'))throw failed('localization_owner_unavailable');
 const links=[filmId];
 try{
  let frontier=[filmId];
  for(let round=0;frontier.length;round++){
   if(round>=PROJECTION_REDIRECT_DEPTH)throw failed('film_person_bounded');
   const rows=await many(db,`SELECT from_id FROM film_redirect WHERE to_film_id IN (${frontier.map(()=>'?').join(',')}) ORDER BY from_id`,frontier);
   frontier=[];
   for(const row of rows){if(links.includes(row.from_id))throw failed('film_person_bounded');links.push(row.from_id);frontier.push(row.from_id);}
   if(links.length>PROJECTION_ANCESTOR_CAP)throw failed('film_person_bounded');
  }
 }catch(error){if(error?.code)throw error;throw failed('film_person_unavailable',error);}
 let entries;
 try{entries=await many(db,`${OWNER_ENTRY_SQL}(${links.map(()=>'?').join(',')}) ORDER BY source_key`,links);}
 catch(error){throw failed('localization_owner_unavailable',error);}
 if(entries.length>PROJECTION_OWNER_ENTRY_CAP)throw failed('film_person_bounded');
 const generation=Number(marker.generation);
 if(entries.some(row=>Number(row.generation)!==generation))throw failed('localization_owner_unavailable');
 const rows=entries.map(row=>({sourceKey:row.source_key,link:row.identity_link,payload:row.payload_json}));
 const byLink=ownerCandidatesFromEntries(entries);
 const values=links.flatMap(link=>byLink.get(link)||[]);
 return {generation,links,rows,values,digest:await digestOf({operation:'owner_review_token',generation,links,rows})};
}

// The owner-review predicates of the batch (ADR 0218 decision 3): (1) the marker is still d1 at the generation read; (2) every verified Film owner row of the closure carries
// that generation, and exactly the consumed rows (same key, link and payload) are the verified owner rows of the links; (3) the redirect closure is the one read: every
// redirect INTO a link starts from a link, and every ancestor still redirects into the closure. An owner commit between plan and commit moves the generation; a re-link moves
// the count or a row; a merge into the Film or into one of its ancestors moves the closure (the Film revision CAS covers a merge into the Film itself).
export function ownerTokenStatements(token){
 const marks=list=>list.map(()=>'?').join(',');
 const ancestors=token.links.slice(1);
 const out=[[fenced.assertSql("EXISTS (SELECT 1 FROM owner_review_authority WHERE id=1 AND mode='d1' AND generation=?)"),[token.generation]]];
 out.push([fenced.assertSql(`NOT EXISTS (SELECT 1 FROM owner_review_entry WHERE kind='film' AND identity_state='verified' AND identity_link IN (${marks(token.links)}) AND generation<>?)`),[...token.links,token.generation]]);
 out.push([fenced.assertSql(`(SELECT COUNT(*) FROM owner_review_entry WHERE kind='film' AND identity_state='verified' AND identity_link IN (${marks(token.links)}))=?`),[...token.links,token.rows.length]]);
 out.push([fenced.assertSql(`NOT EXISTS (SELECT 1 FROM film_redirect WHERE to_film_id IN (${marks(token.links)}) AND from_id NOT IN (${marks(token.links)}))`),[...token.links,...token.links]]);
 if(ancestors.length)out.push([fenced.assertSql(`(SELECT COUNT(*) FROM film_redirect WHERE from_id IN (${marks(ancestors)}) AND to_film_id IN (${marks(token.links)}))=?`),[...ancestors,...token.links,ancestors.length]]);
 for(const row of token.rows)out.push([fenced.assertSql("EXISTS (SELECT 1 FROM owner_review_entry WHERE kind='film' AND source_key=? AND identity_state='verified' AND identity_link=? AND payload_json=?)"),[row.sourceKey,row.link,row.payload]]);
 return out;
}

// The validated sources of a projection write against the stored source rows. Same rules as recordLocalizationSources: an automatic candidate only, a source version,
// an ISO observation (stored as UTC); a stored row of the SAME request id with the same content is a replay (this request's own committed effect), with other content a
// refusal; an observation that is not newer is stale (another request's newer observation superseded it).
function projectionSources(list,requestId,stored){
 if(!Array.isArray(list)||!list.length||list.length>ROW.sourceCap)throw failed('film_person_invalid');
 const seen=new Set(),known=new Map(stored.map(row=>[row.source,row])),write=[],skipped=[],replays=[],stale=[];
 for(const item of list){
  if(!plain(item)||typeof item.source!=='string'||!SOURCE.test(item.source)||RESERVED.has(item.source)||seen.has(item.source)||typeof item.value!=='string'||!item.value.trim()||typeof item.sourceVersion!=='string'||!item.sourceVersion.trim())throw failed('film_person_invalid');
  const provenance=item.provenance??null;
  if(provenance!==null&&(!plain(provenance)||RESERVED.has(provenance.authority)||provenance.status==='reviewed'))throw failed('film_person_invalid');
  const observedAt=instant(item.observedAt);
  if(!observedAt)throw failed('film_person_invalid');
  seen.add(item.source);
  const value=item.value.trim(),row=known.get(item.source),text=JSON.stringify(provenance);
  if(row&&row.request_id===requestId){
   if(row.value!==value||row.source_version!==item.sourceVersion||JSON.stringify(parse(row.provenance_json))!==text||row.observed_at!==observedAt)throw failed('localization_replay_mismatch');
   skipped.push({field:'source:'+item.source,reason:'replay'});replays.push(item.source);continue;
  }
  if(row&&!(observedAt>row.observed_at)){skipped.push({field:'source:'+item.source,reason:'stale'});stale.push(item.source);continue;}
  write.push({source:item.source,value,sourceVersion:item.sourceVersion,provenance,observedAt});
 }
 return {write,skipped,replays,stale};
}

// The normalized resolver inputs of a projection write (decision 3: the digest covers the source content AND the resolver inputs): the owner-review token digest (generation,
// redirect closure, every consumed owner row); the stored localization row when it is protected (reviewed/owner) or a projection of an owner decision, with its provenance;
// the stored row of every INCOMING source (a newer same-source observation that arrives after the plan moves the proof: the incoming source is then superseded and nothing is
// written under this identity); every other stored automatic source row; and the legacy provisional candidate with its version and provenance. PURE and deterministic; the
// same function binds the proof at plan time and checks it again at write and readback time, so an input that moved changes the proof and never replays an old effect under
// the old identity.
export function projectionInputs(snapshot,token,incoming){
 const names=new Set((incoming||[]).map(item=>item?.source));
 const row=snapshot.dimensions.localization;
 const sourceOf=item=>({source:item.source,value:item.value,sourceVersion:item.source_version??null,provenance:item.provenance_json??null,observedAt:item.observed_at,requestId:item.request_id??null});
 const byName=(a,b)=>a.source<b.source?-1:a.source>b.source?1:0;
 const stored=ROW.strong(row)?{status:row.status,source:row.source??null,sourceVersion:row.source_version??null,authority:row.authority??null,value:row.value??null,provenance:row.provenance_json??null}:null;
 const same=snapshot.sources.filter(item=>names.has(item.source)).map(sourceOf).sort(byName);
 const others=snapshot.sources.filter(item=>!names.has(item.source)).map(sourceOf).sort(byName);
 const legacy=row&&row.status==='provisional'&&row.value&&row.source&&!RESERVED.has(row.source)&&!snapshot.sources.some(item=>item.source===row.source)&&!names.has(row.source)?{source:row.source,value:row.value,sourceVersion:row.source_version??null,provenance:row.provenance_json??null,observedAt:row.updated_at}:null;
 return {resolver:PROJECTION_RESOLVER,owner:token.digest,stored,same,others,legacy};
}
// Read only. The proof of ONE Film for the sources a producer is about to hand over.
export async function readProjectionInputs(env,id,incoming){
 const snapshot=await readFilmSnapshot(env,id);
 const token=await readOwnerReviewToken(env,id);
 return projectionInputs(snapshot,token,incoming);
}

// An owner projection row (see isOwnerProjection of localization-sources.js, the one definition shared with the resolver input construction and the parity reader): the row this
// writer materialized from a verified owner decision. It is a PROJECTION of the current owner_review_entry, not an independent owner authority: once the decision is revoked or
// changed the row is stale, is never protected by the strong() guard and never counts as an owner input to the resolver, so a new automatic observation replaces it. A genuine legacy
// owner/reviewed row (no marker) keeps its control.
// The upsert of a projection row: the guard of `writeFilmFacts` plus the replacement of an owner projection row (the only reviewed row this writer may replace by itself).
export const PROJECTION_UPSERT=ROW.upsert()+" OR (CASE WHEN json_valid(film_dimension.provenance_json) THEN json_extract(film_dimension.provenance_json,'$.projection') END)='"+OWNER_PROJECTION+"' AND film_dimension.authority='owner'";

// A legacy provisional row of a source that has no source row is an actual resolver candidate (see projectionInputs `legacy`) and the SOLE durable record of that value. Replacing the
// stored row would lose that input silently, so the same batch records it as a source row first (`ON CONFLICT DO NOTHING`, request id of this write, observed_at the row's own clock,
// version and provenance unchanged): the resolver input is identical, now durable. A candidate that cannot be recorded losslessly (no version, an unparseable clock or provenance)
// holds the write conservatively until a separately authorized repair; nothing is lost silently.
export function legacyCandidate(snapshot,names){
 const row=snapshot.dimensions.localization;
 if(!row||row.status!=='provisional'||!row.value||!row.source||RESERVED.has(row.source)||names.has(row.source)||snapshot.sources.some(item=>item.source===row.source))return null;
 const observedAt=instant(row.updated_at),version=typeof row.source_version==='string'?row.source_version.trim():'';
 let provenance=null;
 try{provenance=JSON.stringify(JSON.parse(row.provenance_json??'null'));}catch{return {lossless:false,source:row.source};}
 if(!observedAt||!version)return {lossless:false,source:row.source};
 return {lossless:true,source:row.source,value:row.value.trim(),sourceVersion:version,provenance,observedAt};
}

// The projection decision. `match`: the stored row already is the resolver output (an owner or reviewed row equal in value, or an automatic row equal in every column but its clock).
// `write`: the row is absent, not protected, or a stale owner projection, and differs. `held`: the resolver output cannot be produced under the strong() guard without replacing
// a protected row that differs (a conflicting owner input, a reviewed or owner row of another value, a reviewed row without a value): nothing is written, no review decision is manufactured.
export function projectionOf(snapshot,token,write,at,id){
 const stored=snapshot.dimensions.localization;
 const projected=isOwnerProjection(stored);
 // The stored owner projection is never an input and never protected: the resolver sees the row as absent.
 const row=projected?null:stored;
 const view=projected?{...snapshot,dimensions:{...snapshot.dimensions,localization:null}}:snapshot;
 const owners=[...new Set(token.values.map(item=>item.value))];
 if(owners.length>1)return {kind:'held',reason:'owner_conflict',effective:{value:null,tier:'owner_conflict',source:null}};
 const wanted=(state,effective)=>({kind:'write',effective,params:ROW.params(id,state)});
 if(owners.length){
  const value=owners[0],effective={value,tier:'owner',source:'owner'};
  if(projected&&stored.value===value)return {kind:'match',effective};
  if(ROW.strong(row))return row.value===value?{kind:'match',effective}:{kind:'held',reason:'protected_row_differs',effective};
  const latest=token.values.map(item=>item.at).filter(Boolean).sort().at(-1)||at;
  const entries=token.rows.map(item=>item.sourceKey).sort();
  return wanted({dimension:'localization',status:'reviewed',source:'owner',sourceVersion:'owner_review',provenance:{authority:'owner',projection:OWNER_PROJECTION,entries},value,updatedAt:latest,attempts:0,nextAction:'keep_reviewed'},effective);
 }
 const resolved=ROW.effective(view,write),effective={value:resolved.value??null,tier:resolved.tier,source:resolved.source??null};
 if(resolved.tier==='owner'||resolved.tier==='reviewed')return {kind:'match',effective};
 if(resolved.tier==='none')return projected?{kind:'held',reason:'owner_projection_without_input',effective}:{kind:'match',effective};
 if(ROW.strong(row))return {kind:'held',reason:'protected_row_differs',effective};
 const state={dimension:'localization',status:'provisional',source:resolved.source,sourceVersion:resolved.sourceVersion??null,provenance:resolved.provenance??null,value:resolved.value,updatedAt:resolved.at||at,attempts:0,nextAction:'none'};
 const params=ROW.params(id,state);
 return !projected&&ROW.same(row,params)?{kind:'match',effective}:{kind:'write',effective,params};
}

// PURE. snapshot: readFilmSnapshot's result; token: readOwnerReviewToken's result; input: {id, at, requestId, sources:[{source,value,sourceVersion,provenance?,observedAt}], inputs}
// (`inputs` is projectionInputs as the producer planned it). Returns {state, statements, changes, skipped, effective, held?}:
//   exact  every incoming source is stored with THIS request id and the stored row equals the resolver output: the only positive readback proof;
//   write  statements to run (source rows and/or the projection row);
//   superseded  a newer observation of an incoming source is stored, or nothing of this request is left to write: never a proof, never a projection-only repair;
//   held   the projection cannot be produced under the guard (see projectionOf): nothing is written, never a proof;
//   moved  a resolver input changed since the producer planned it and this request has not committed: the caller replans.
export function planFilmLocalizationProjection(snapshot,token,input){
 const id=fenced.filmId(input?.id),at=fenced.text(input.at),requestId=fenced.text(input.requestId);
 if(!plain(token)||!Array.isArray(token.values)||!plain(input.inputs))throw failed('film_person_invalid');
 if(snapshot.redirect)throw failed('film_person_redirect');
 const {write,skipped,replays,stale}=projectionSources(input.sources,requestId,snapshot.sources);
 const projection=projectionOf(snapshot,token,write,at,id);
 const base={id,changes:[],skipped,effective:projection.effective,statements:[]};
 const exact=replays.length===input.sources.length&&projection.kind==='match';
 if(exact)return {...base,state:'exact'};
 if(canonicalJson(projectionInputs(snapshot,token,input.sources))!==canonicalJson(input.inputs))return {...base,state:'moved'};
 // A write always carries at least one source row of THIS request. A superseded source (a newer observation of the same source is stored) or a request with nothing of its own to
 // write is never a license to repair a different projection under this identity: that is a projection-only operation with its own binding (AIR-663).
 if(stale.length||!write.length)return {...base,state:'superseded'};
 if(projection.kind==='held')return {...base,state:'held',held:{reason:projection.reason}};
 const statements=[],changes=[];
 // A write over the stored row must not lose a legacy resolver candidate: record it in this batch, or hold when it cannot be recorded losslessly.
 const legacy=projection.kind==='write'?legacyCandidate(snapshot,new Set(input.sources.map(item=>item.source))):null;
 if(legacy&&!legacy.lossless)return {...base,state:'held',held:{reason:'legacy_candidate_not_preservable'}};
 if(legacy){statements.push([ROW.legacySourceInsert,[id,legacy.source,legacy.value,legacy.sourceVersion,legacy.provenance,requestId,legacy.observedAt,at]]);changes.push('source:'+legacy.source+':preserved');}
 for(const item of write){statements.push([ROW.sourceUpsert,[id,item.source,item.value,item.sourceVersion,JSON.stringify(item.provenance??null),requestId,item.observedAt,at]]);changes.push('source:'+item.source);}
 if(projection.kind==='write'){statements.push([PROJECTION_UPSERT,projection.params]);changes.push('dimension:localization');}
 if(statements.length+ownerTokenStatements(token).length+6>MUTATION_STATEMENT_CAP)throw failed('film_person_bounded');
 return {...base,state:'write',statements,changes};
}

// The fenced projection write. Refuses before the database unless the Film/Person marker is open, the owner-review domain is D1-authoritative and the Film exists
// directly (never created here, never a redirect). A call with nothing to write opens no batch. Named refusals: `localization_inputs_moved` (a resolver input changed since the
// plan: replan, retryable), `localization_owner_moved` (the owner-review token was lost between plan and commit: replan), `film_person_revision_conflict` (the Film CAS).
// A `held` projection writes NOTHING (neither a source row nor the projection) and returns {written:false, held:true, reason}.
// input: {id, expectedRevision, at, requestId, sources, inputs, receiptMark?}
export async function writeFilmLocalizationProjection(env,input){
 const id=fenced.filmId(input?.id),expected=fenced.revisionOf(input.expectedRevision),at=fenced.text(input.at);
 fenced.text(input.requestId);
 const tail=fenced.receiptTail(input.receiptMark,{kind:'film',id});
 const gate=fenced.bindProducerFence(env,assertWritable(await readAuthority(env)));
 const snapshot=await readFilmSnapshot(env,id);
 if(snapshot.redirect)throw failed('film_person_redirect');
 if(!snapshot.film)throw failed('film_person_precondition');
 const token=await readOwnerReviewToken(env,id);
 const plan=planFilmLocalizationProjection(snapshot,token,input);
 if(plan.state==='moved')throw failed('localization_inputs_moved');
 if(plan.state==='held')return {id,revision:snapshot.revision,written:false,held:true,reason:plan.held.reason,skipped:plan.skipped,effective:plan.effective};
 if(plan.state!=='write')return {id,revision:snapshot.revision,written:false,reason:plan.state==='exact'?'unchanged':'superseded',skipped:plan.skipped,effective:plan.effective};
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 statements.push(...ownerTokenStatements(token));
 statements.push(...plan.statements);
 statements.push([fenced.BUMP,['film',id,at]]);
 try{await fenced.commit(env,gate,statements,entities,tail);}
 catch(error){
  if(error?.code==='film_person_precondition'){
   let again=null;
   try{again=await readOwnerReviewToken(env,id);}catch{throw failed('localization_owner_moved',error);}
   if(again.digest!==token.digest)throw failed('localization_owner_moved',error);
  }
  throw error;
 }
 return {id,revision:expected+1,written:true,changes:plan.changes,skipped:plan.skipped,effective:plan.effective};
}

// Read-only. The state of the projection against D1 NOW, for the readback and the revalidation of the projection-aware receipt: {state, revision} with the states of
// planFilmLocalizationProjection, or `absent` for a Film that is missing or a redirect. Only `exact` proves this request's effect.
export async function filmLocalizationProjectionState(env,input){
 const snapshot=await readFilmSnapshot(env,input.id);
 if(snapshot.redirect||!snapshot.film)return {state:'absent',revision:snapshot.revision};
 const token=await readOwnerReviewToken(env,input.id);
 const plan=planFilmLocalizationProjection(snapshot,token,input);
 return {state:plan.state,reason:plan.held?.reason??null,revision:snapshot.revision};
}
