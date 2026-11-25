// AIR-662 / ADR 0218 decision 3 (D1, Accepted). The projection-aware localization write of ONE canonical Film: the automatic source rows of film_localization_source
// AND the effective localization row (film_dimension 'localization') in ONE fenced D1 batch, so a source that the existing resolver makes effective can no longer stay
// invisible to the display readers (finding F5). DORMANT like the other canonical writers: it reaches the database only after assertWritable (marker d1/open), and only
// the metadata_sync producer calls it (operation kind film_localization_projection). Nothing here reads R2, writes Person rows, owner rows or a reviewed row.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced,MUTATION_STATEMENT_CAP} from './canonical-mutations.js';
import {AUTOMATIC_SOURCE_ORDER,ownerCandidatesFromEntries,resolveLocalization} from './localization-sources.js';
import {digestOf} from './canonical-receipts.js';
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

// The two owner-review predicates of the batch: the marker is still d1 at the generation read, and exactly the consumed rows (same key, link and payload) are the
// verified owner rows of the links. An owner commit between plan and commit moves the generation; a re-link moves the count or a row.
export function ownerTokenStatements(token){
 const out=[[fenced.assertSql("EXISTS (SELECT 1 FROM owner_review_authority WHERE id=1 AND mode='d1' AND generation=?)"),[token.generation]]];
 out.push([fenced.assertSql(`(SELECT COUNT(*) FROM owner_review_entry WHERE kind='film' AND identity_state='verified' AND identity_link IN (${token.links.map(()=>'?').join(',')}))=?`),[...token.links,token.rows.length]]);
 for(const row of token.rows)out.push([fenced.assertSql("EXISTS (SELECT 1 FROM owner_review_entry WHERE kind='film' AND source_key=? AND identity_state='verified' AND identity_link=? AND payload_json=?)"),[row.sourceKey,row.link,row.payload]]);
 return out;
}

// The validated sources of a projection write against the stored source rows. Same rules as recordLocalizationSources: an automatic candidate only, a source version,
// an ISO observation (stored as UTC); a stored row of the SAME request id with the same content is a replay, with other content a refusal; an observation that is not newer is stale.
function projectionSources(list,requestId,stored){
 if(!Array.isArray(list)||!list.length||list.length>ROW.sourceCap)throw failed('film_person_invalid');
 const seen=new Set(),known=new Map(stored.map(row=>[row.source,row])),write=[],skipped=[];
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
   skipped.push({field:'source:'+item.source,reason:'replay'});continue;
  }
  if(row&&!(observedAt>row.observed_at)){skipped.push({field:'source:'+item.source,reason:'stale'});continue;}
  write.push({source:item.source,value,sourceVersion:item.sourceVersion,provenance,observedAt});
 }
 return {write,skipped};
}

// PURE. snapshot: readFilmSnapshot's result; token: readOwnerReviewToken's result; input: {id, at, requestId, sources:[{source,value,sourceVersion,provenance?,observedAt}]}.
// Returns {statements, changes, skipped, noop, effective}. `effective` is the resolver output over the rows as they will stand; `noop` is true when no source row and no
// projection row would change (the readback proof: the stored effective row equals the resolver output on the rows read back).
export function planFilmLocalizationProjection(snapshot,token,input){
 const id=fenced.filmId(input?.id),at=fenced.text(input.at),requestId=fenced.text(input.requestId);
 if(!plain(token)||!Array.isArray(token.values))throw failed('film_person_invalid');
 if(snapshot.redirect)throw failed('film_person_redirect');
 const statements=[],changes=[],skipped=[];
 const {write,skipped:notWritten}=projectionSources(input.sources,requestId,snapshot.sources);
 skipped.push(...notWritten);
 for(const item of write){statements.push([ROW.sourceUpsert,[id,item.source,item.value,item.sourceVersion,JSON.stringify(item.provenance??null),requestId,item.observedAt,at]]);changes.push('source:'+item.source);}
 const owners=[...new Set(token.values.map(item=>item.value))];
 const row=snapshot.dimensions.localization;
 let effective;
 if(owners.length>1){
  // Conflicting owner values: no value is chosen and no lower tier replaces them (the read model's owner_conflict). The source rows are still recorded.
  effective={value:null,tier:'owner_conflict',source:null};
  skipped.push({field:'localization',reason:'owner_conflict'});
 }else{
  // A verified owner value is the owner tier of the same resolver (the read model's overlay); otherwise the stored row and the source rows decide.
  effective=owners.length?resolveLocalization({owner:{value:owners[0]}}):ROW.effective(snapshot,write);
  if(effective.tier==='automatic'){
   const state={dimension:'localization',status:'provisional',source:effective.source,sourceVersion:effective.sourceVersion??null,provenance:effective.provenance??null,value:effective.value,updatedAt:effective.at||at,attempts:0,nextAction:'none'};
   const params=ROW.params(id,state);
   if(ROW.strong(row))skipped.push({field:'localization',reason:row.authority==='owner'?'owner_kept':'reviewed_kept'});
   else if(!ROW.same(row,params)){changes.push('dimension:localization');statements.push([ROW.upsert(),params]);}
  }else if(effective.tier==='owner'||effective.tier==='reviewed')skipped.push({field:'localization',reason:effective.tier==='owner'?'owner_kept':'reviewed_kept'});
 }
 if(statements.length+ownerTokenStatements(token).length+6>MUTATION_STATEMENT_CAP)throw failed('film_person_bounded');
 return {id,statements,changes,skipped,noop:changes.length===0,effective:{value:effective.value??null,tier:effective.tier,source:effective.source??null}};
}

// The fenced projection write. Refuses before the database unless the Film/Person marker is open, the owner-review domain is D1-authoritative and the Film exists
// directly (never created here, never a redirect). A call whose rows are all stored already opens no batch. A lost owner-review token is named
// `localization_owner_moved` (retryable: replan), a lost revision `film_person_revision_conflict`.
// input: {id, expectedRevision, at, requestId, sources, receiptMark?}
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
 if(plan.noop)return {id,revision:snapshot.revision,written:false,reason:'unchanged',skipped:plan.skipped,effective:plan.effective};
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

// Read-only. Does D1 already hold every row the projection write would produce (sources and the effective row)? The readback of the projection-aware receipt.
export async function filmLocalizationProjectionPresent(env,input){
 const snapshot=await readFilmSnapshot(env,input.id);
 if(snapshot.redirect||!snapshot.film)return {present:false,revision:snapshot.revision};
 const token=await readOwnerReviewToken(env,input.id);
 return {present:planFilmLocalizationProjection(snapshot,token,input).noop,revision:snapshot.revision};
}
