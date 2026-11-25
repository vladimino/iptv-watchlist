// AIR-647 / ADR 0216 (Accepted), delivery graph step 3. FilmAggregateV1: the sections of the unified Film read contract, composed per request over the
// typed resolver of AIR-646 (src/film-aggregate-resolver.js), with the mandatory candidate discovery and coverage of decision 6b (G1).
// DORMANT: nothing in the Worker imports this module or the resolver (neither is bundled; build.mjs does not name them), so no route serves it and no
// consumer is switched. Activation is AIR-648 (its own owner GO, after AIR-667). The internal route handler below exists for the tests and for that card.
// It only reads D1: every statement is a plain SELECT (a write is refused before it reaches the binding), no R2, no network, no repair, no promotion, no cache.
//
// Shape of one request (decision 7): the final identity fence is reserved first (resolver); then each section reserves its after-statement before it reads,
// so a section that has read can always be fenced; the ratings coverage reads come first, then the sections. A section that cannot get its statements is
// `unavailable` `budget_exceeded` and the identity fence still runs. Every section captures its tokens with its reads (one SQL statement = one snapshot) and
// re-reads them after ALL section reads (E1); a difference makes that section `unavailable` `generation_moved`. The identity fence (decision 4) runs last and
// fails the whole answer with 503 `identity_moved` and no section.
//
// Domain markers are read inline in each section's statement with the same served-state rule as the domain's own reader (ratings d1/open, prediction d1,
// published EPG d1/open, Watchlist d1 with open writes for the source): one statement per snapshot keeps the 40-statement budget. A missing table, a
// malformed row or a refused marker makes the section `unavailable`, never a negative.
import {createHash} from 'node:crypto';
import {database} from './film-person-authority.js';
import {loadLocalizationInputs,resolveLocalization} from './localization-sources.js';
import {ownerCandidatesFromEntries} from './canonical-read-model.js';
import {readFilmAggregateIdentity,REQUEST_STATEMENT_BUDGET,FILM_AGGREGATE_CONTRACT} from './film-aggregate-resolver.js';

export {FILM_AGGREGATE_CONTRACT};
// ADR 0216 decision 6b, the work bounds of candidate discovery.
export const LINK_DOCUMENT_MAX_PARTS=40;
export const LINK_DOCUMENT_PART_BYTES=60000;
export const LINK_DOCUMENT_MAX_BYTES=LINK_DOCUMENT_MAX_PARTS*LINK_DOCUMENT_PART_BYTES;
export const LINK_INDEX_MAX_ENTRIES=50000;
export const FACT_RECORDS_MAX=4;
export const CANDIDATES_MAX=8;
// ADR 0216 decision 7.
export const CURRENT_SHOWS_MAX=50;
export const CREDITS_MAX=60;
export const OWNER_ENTRIES_MAX=64;
export const OWNER_ANCESTOR_DEPTH=8;
export const FILM_AGGREGATE_ROUTE='/api/internal/film-aggregate';
const LINKS_KEY='letterboxd/facts/links.json';
const RECORD_PREFIX='letterboxd/facts/films/';
const FACT_KEY=/^[A-Za-z0-9_-]{1,100}$/;
const LID=/^[A-Za-z0-9_-]{1,80}$/,TMDB=/^[1-9]\d{0,11}$/;

const digestOf=value=>'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable=(reason,extra={})=>({status:'unavailable',reason,token:null,tokenStatus:'unavailable',...extra});
const json=text=>{if(text==null)return null;return typeof text==='string'?JSON.parse(text):text;};
const list=text=>{const value=json(text);if(value==null)return [];if(!Array.isArray(value))throw sectionError('malformed');return value;};
function sectionError(code){const error=new Error(code);error.code=code;return error;}
class BudgetExceeded extends Error{constructor(){super('budget_exceeded');this.code='budget_exceeded';}}
// A budget refusal may arrive wrapped by a domain reader (failed(code, cause)).
const overBudget=error=>error instanceof BudgetExceeded||error?.cause instanceof BudgetExceeded;

// The D1 binding seen by the sections: every executed statement is charged to the request budget first (a statement that cannot be paid is never run), and
// only a single plain SELECT may run. It is the same budget object the resolver charges, so the identity reads, the reserved fence and the sections share 40.
const READ_ONLY=/^\s*(with\s+recursive\s+[\s\S]+?\)\s*)?select\b[^;]*;?\s*$/i;
export function countedDatabase(db,budget){
 const guard=sql=>{if(!READ_ONLY.test(sql))throw sectionError('aggregate_write_refused');};
 const wrap=(statement,sql)=>({
  inner:statement,
  bind(...params){return wrap(statement.bind(...params),sql);},
  async first(...args){if(!budget.take(1))throw new BudgetExceeded();return statement.first(...args);},
  async all(...args){if(!budget.take(1))throw new BudgetExceeded();return statement.all(...args);},
  async raw(...args){if(!budget.take(1))throw new BudgetExceeded();return statement.raw(...args);},
  async run(){throw sectionError('aggregate_write_refused');},
 });
 return {
  prepare(sql){guard(sql);return wrap(db.prepare(sql),sql);},
  async batch(statements){
   if(!budget.take(statements.length))throw new BudgetExceeded();
   return db.batch(statements.map(item=>item.inner));
  },
  async exec(){throw sectionError('aggregate_write_refused');},
 };
}
async function row(db,sql,params){
 const rows=(await db.prepare(sql).bind(...params).all()).results||[];
 if(rows.length!==1)throw sectionError('malformed');
 return rows[0];
}
// A section's statement read twice: before (with its data) and after every section read. Its after-statement is reserved before its first read.
function fenceOf(budget,count){
 if(!budget.reserve(count))return null;
 let left=count;
 // redeem() hands the reserved statement back just before the after-statement runs, which the counted binding then charges: paid once, never lost.
 return {redeem(){if(left<1)return false;left--;return budget.release(1);},release(){if(left>0){budget.release(left);left=0;}}};
}

// ---- the alias sets (decision 6b: authorized aliases only; a TV number is never a storage key) ----
function aliases(resolution){
 const a=resolution.authorized||{tmdb_movie:[],tmdb_tv:[],letterboxd_lid:[]};
 const overflow=(resolution.aliasOverflow||[]).length>0;
 return {
  lids:[...a.letterboxd_lid],movies:[...a.tmdb_movie],overflow,
  // Prediction pointers, published EPG film ids and ratings_view alias ids: the lid itself and tmdb_<n>.
  storageIds:[...a.letterboxd_lid,...a.tmdb_movie.map(n=>'tmdb_'+n)].sort(),
  // The ratings link index form.
  seeds:[...a.letterboxd_lid.map(l=>'letterboxd:'+l),...a.tmdb_movie.map(n=>'tmdb:'+n)].sort(),
 };
}

// ---- ratings evidence: personal facts and candidate coverage (decision 6b) ----
// Statement R1: the ratings marker, the link document's size (checked BEFORE it is materialized) and the ratings_view rows of the authorized aliases.
const RATINGS_HEAD_SQL='SELECT '
 +"(SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'cutover',MAX(cutover),'generation',MAX(generation)) FROM ratings_domain_authority WHERE id=1) AS marker,"
 +'(SELECT json_object(\'parts\',COUNT(*),\'bytes\',COALESCE(SUM(length(CAST(body AS BLOB))),0),\'etags\',COUNT(DISTINCT etag),\'etag\',MAX(etag)) FROM ratings_document WHERE key=?) AS links,'
 +'(SELECT json_group_array(json_array(alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at)) FROM ratings_view WHERE alias_id IN (SELECT value FROM json_each(?))) AS view';
// Statements R2/R3: the parts of one or more owned documents, in part order.
const DOCUMENT_PARTS_SQL='SELECT key,part,body,etag FROM ratings_document WHERE key IN (SELECT value FROM json_each(?)) ORDER BY key,part';
// The ownership proof of the candidates (decision 6b, step 5): every claim row of each candidate (scheme, value), whether its Film is a redirect source, and
// a non-superseded retirement of a candidate movie id. Index use: film_external_id_by_scheme_value, film_redirect PK, tmdb_retirement_decision_movie (AIR-667).
const SETTLEMENT_SQL='SELECT '
 +"(SELECT json_group_array(json_array(e.film_id,e.scheme,e.value,e.trusted,e.conflicting,(SELECT COUNT(*) FROM film_redirect r WHERE r.from_id=e.film_id),(SELECT COUNT(*) FROM film f WHERE f.id=e.film_id))) FROM json_each(?) j INNER JOIN film_external_id e ON e.scheme=json_extract(j.value,'$[0]') AND e.value=json_extract(j.value,'$[1]')) AS claims,"
 // The decisions are read by movie id (tmdb_retirement_decision_movie, AIR-667) and superseded in memory, as the resolver does: supersedes_seq has no index.
 +"(SELECT json_group_array(json_array(seq,kind,movie_id,supersedes_seq)) FROM tmdb_retirement_decision WHERE movie_id IN (SELECT value FROM json_each(?))) AS retired";
// The after-statement of the ratings sections: the marker, the etag of every document read (part 0), the ratings_view rows and the settlement rows.
const RATINGS_AFTER_SQL='SELECT '
 +"(SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'cutover',MAX(cutover),'generation',MAX(generation)) FROM ratings_domain_authority WHERE id=1) AS marker,"
 +'(SELECT json_group_array(json_array(key,etag)) FROM ratings_document WHERE part=0 AND key IN (SELECT value FROM json_each(?))) AS etags,'
 +'(SELECT json_group_array(json_array(alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at)) FROM ratings_view WHERE alias_id IN (SELECT value FROM json_each(?))) AS view,'
 +SETTLEMENT_SQL.slice('SELECT '.length);

async function sha256Hex(text){return createHash('sha256').update(text).digest('hex');}
// The owned-document check of src/ratings-d1.js (readParts): parts 0..n-1, one etag, the etag is the SHA-256 of the joined text, the text is JSON.
async function assemble(rows){
 const etag=rows[0].etag;
 if(rows.some((item,index)=>Number(item.part)!==index||item.etag!==etag))throw sectionError('ratings_document_malformed');
 const text=rows.map(item=>item.body).join('');
 if(await sha256Hex(text)!==etag)throw sectionError('ratings_document_malformed');
 try{return {value:JSON.parse(text),etag};}catch{throw sectionError('ratings_document_malformed');}
}
async function readDocuments(db,keys){
 const rows=(await db.prepare(DOCUMENT_PARTS_SQL).bind(JSON.stringify(keys)).all()).results||[];
 const byKey=new Map();
 for(const item of rows){if(!byKey.has(item.key))byKey.set(item.key,[]);byKey.get(item.key).push(item);}
 const out=new Map();
 for(const key of keys)out.set(key,byKey.has(key)?await assemble(byKey.get(key)):null);
 return out;
}
const viewRow=r=>({aliasId:String(r[0]),factKey:String(r[1]),watched:r[2]==null?null:Number(r[2]),rating:r[3]==null?null:Number(r[3]),watchlist:r[4]==null?null:Number(r[4]),ratingKnown:Number(r[5])===1,updatedAt:r[6]??null});
const candidatePair=alias=>{
 const at=alias.indexOf(':');
 const scheme=alias.slice(0,at),value=alias.slice(at+1);
 if(scheme==='letterboxd'&&LID.test(value)&&!value.startsWith('tmdb_'))return ['letterboxd',value];
 if(scheme==='tmdb'&&TMDB.test(value))return ['tmdb',value];
 return null;
};
// A movie id is retired while a 'retire' decision of it is named by no restore (the resolver's rule, src/film-aggregate-resolver.js).
function activeRetired(rows){
 const decisions=rows.map(r=>({seq:Number(r[0]),kind:String(r[1]),movie:String(r[2]),supersedes:r[3]==null?null:Number(r[3])}));
 const superseded=new Set(decisions.filter(d=>d.supersedes!=null).map(d=>d.supersedes));
 return [...new Set(decisions.filter(d=>d.kind==='retire'&&!superseded.has(d.seq)).map(d=>d.movie))].sort();
}
function settlementOf(row){
 return {claims:list(row.claims).map(r=>({film:String(r[0]),scheme:String(r[1]),value:String(r[2]),trusted:Number(r[3])===1,conflicting:Number(r[4])===1,redirected:Number(r[5])>0,present:Number(r[6])>0})).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1),retired:activeRetired(list(row.retired))};
}
// A candidate belongs elsewhere only through ANOTHER Film's single trusted, non-conflicting claim: no other row of any trust for that value, the Film exists and
// is not a redirect source, and (for a movie id) no non-superseded retirement. Anything else, including the survivor's own retired movie claim, is unresolved.
function settledElsewhere(pair,settlement,survivor){
 const rows=settlement.claims.filter(r=>r.scheme===pair[0]&&r.value===pair[1]);
 if(rows.length!==1)return false;
 const [owner]=rows;
 if(!owner.trusted||owner.conflicting||!owner.present||owner.redirected||owner.film===survivor)return false;
 return !(pair[0]==='tmdb'&&settlement.retired.includes(pair[1]));
}

// Reads the ratings evidence once for both ratings-dependent sections. -> {state, coverage, personal inputs, after()}
async function readRatings(db,budget,resolution,set){
 const fence=fenceOf(budget,1);
 if(!fence)return {state:'budget'};
 let head;
 try{head=await row(db,RATINGS_HEAD_SQL,[LINKS_KEY,JSON.stringify(set.storageIds)]);}
 catch(error){fence.release();if(overBudget(error))return {state:'budget'};return {state:'unavailable',reason:'ratings_unavailable'};}
 let marker;
 try{marker=json(head.marker);}catch{fence.release();return {state:'unavailable',reason:'ratings_unavailable'};}
 if(Number(marker?.rows)!==1||marker.mode!=='d1'){fence.release();return {state:'unavailable',reason:'ratings_unavailable'};}
 if(marker.cutover!=='open'){fence.release();return {state:'unavailable',reason:'ratings_held'};}
 const generation=Number(marker.generation);
 const view=list(head.view).map(viewRow).sort((a,b)=>a.aliasId<b.aliasId?-1:1);
 const links=json(head.links);
 const reasons=new Set(),documents=new Map(),seedAbsent=[],notes=[];
 let candidates=[],settlement={claims:[],retired:[]},candidatePairs=[];
 const coverageToken=()=>({generation,links:documents.get(LINKS_KEY)??null,records:Object.fromEntries([...documents].filter(([key])=>key!==LINKS_KEY).sort()),seedAbsent:[...seedAbsent],candidates:digestOf({candidates,settlement})});
 // 1. Seeds: the authorized aliases in link-index form. An empty set is never proof of coverage.
 if(!set.seeds.length)reasons.add('seed_absent_unproved');
 // 2. The link document, its limits checked before it is materialized.
 else if(!links||Number(links.parts)===0)reasons.add('ratings_evidence_unavailable');
 else if(Number(links.parts)>LINK_DOCUMENT_MAX_PARTS||Number(links.bytes)>LINK_DOCUMENT_MAX_BYTES)reasons.add('discovery_cap');
 else if(Number(links.etags)!==1)reasons.add('ratings_evidence_unavailable');
 else{
  try{
   const index=(await readDocuments(db,[LINKS_KEY])).get(LINKS_KEY);
   if(!index||!index.value||typeof index.value!=='object'||Array.isArray(index.value))throw sectionError('ratings_document_malformed');
   documents.set(LINKS_KEY,index.etag);
   const entries=Object.entries(index.value);
   if(entries.length>LINK_INDEX_MAX_ENTRIES)reasons.add('discovery_cap');
   else{
    // 3. Each seed's fact key; a seed missing from the index is an absence predicate, not proof.
    const keys=new Set();
    for(const seed of set.seeds){
     const key=index.value[seed];
     if(key===undefined){seedAbsent.push(seed);continue;}
     if(typeof key!=='string'||!FACT_KEY.test(key))throw sectionError('ratings_document_malformed');
     keys.add(key);
    }
    if(seedAbsent.length)reasons.add('seed_absent_unproved');
    // 4. Each fact record reached is read once; one redirect or migration hop is followed and both sides count.
    let read=0;
    const factKeys=new Set(keys);
    const follow=async batch=>{
     if(!batch.length)return [];
     if(read+batch.length>FACT_RECORDS_MAX){reasons.add('discovery_cap');return [];}
     read+=batch.length;
     const records=await readDocuments(db,batch.map(key=>RECORD_PREFIX+key+'.json'));
     const next=[];
     for(const key of batch){
      const record=records.get(RECORD_PREFIX+key+'.json');
      if(!record){reasons.add('ratings_evidence_unavailable');continue;}
      documents.set(RECORD_PREFIX+key+'.json',record.etag);
      const hop=record.value?.redirectTo||record.value?.migrating?.to;
      if(hop!=null){
       if(typeof hop!=='string'||!FACT_KEY.test(hop))throw sectionError('ratings_document_malformed');
       if(!factKeys.has(hop)){factKeys.add(hop);next.push(hop);}
      }
     }
     return next;
    };
    const hops=await follow([...keys].sort());
    if(!reasons.has('discovery_cap')){
     const beyond=await follow(hops.sort());
     // A second hop is not followed: the chain is longer than the bound.
     if(beyond.length)reasons.add('discovery_cap');
    }
    // 4 (walk). The in-memory index is walked once for every other alias of the reached fact keys.
    const seedSet=new Set(set.seeds);
    const found=[];
    for(const [alias,key] of entries)if(factKeys.has(key)&&!seedSet.has(alias))found.push(alias);
    found.sort();
    if(found.length>CANDIDATES_MAX)reasons.add('discovery_cap');
    else candidates=found;
   }
  }catch(error){
   if(overBudget(error)){fence.release();return {state:'budget'};}
   reasons.add('ratings_evidence_unavailable');
  }
 }
 // 5. Settlement of each candidate by another Film's canonical ownership proof, revalidated in the after-statement.
 candidatePairs=candidates.map(candidatePair);
 const proofPairs=candidatePairs.filter(Boolean);
 const proofMovies=proofPairs.filter(p=>p[0]==='tmdb').map(p=>p[1]);
 if(candidates.length&&!reasons.has('discovery_cap')){
  try{settlement=settlementOf(await row(db,SETTLEMENT_SQL,[JSON.stringify(proofPairs),JSON.stringify(proofMovies)]));}
  catch(error){
   if(overBudget(error)){fence.release();return {state:'budget'};}
   reasons.add('ratings_evidence_unavailable');
  }
  const open=candidates.filter((alias,i)=>!(candidatePairs[i]&&settledElsewhere(candidatePairs[i],settlement,resolution.filmId)));
  if(open.length&&!reasons.has('ratings_evidence_unavailable'))reasons.add('unresolved_candidate');
  for(const alias of open)notes.push({candidate:alias,state:'unresolved'});
 }
 const order=['ratings_evidence_unavailable','discovery_cap','seed_absent_unproved','unresolved_candidate'];
 const reason=order.find(item=>reasons.has(item))??null;
 const coverage={status:reason?'incomplete':'complete',...(reason?{reason}:{}),token:coverageToken(),candidates:candidates.length,...(notes.length?{notes}:{})};
 const before={marker,etags:[...documents].sort(),view,settlement};
 const after=async()=>{
  if(!fence.redeem())return false;
  const r=await row(db,RATINGS_AFTER_SQL,[JSON.stringify([...documents.keys()].sort()),JSON.stringify(set.storageIds),JSON.stringify(proofPairs),JSON.stringify(proofMovies)]);
  const now={marker:json(r.marker),etags:list(r.etags).map(e=>[String(e[0]),String(e[1])]).sort(),view:list(r.view).map(viewRow).sort((a,b)=>a.aliasId<b.aliasId?-1:1),settlement:candidates.length&&!reasons.has('discovery_cap')?settlementOf(r):{claims:[],retired:[]}};
  return digestOf(now)===digestOf(before);
 };
 return {state:'open',generation,view,coverage,after};
}

// Decision 6 / C2: values per distinct fact key (one fact reachable through two aliases counts once), a conflict when two fact keys disagree, no winner.
function personalSection(ratings,set){
 const token={generation:ratings.generation,view:digestOf(ratings.view),coverage:ratings.coverage.token};
 if(!set.storageIds.length)return {status:'unknown',reason:'no_authorized_alias',source:'d1:ratings_view',token,coverage:ratings.coverage};
 const complete=ratings.coverage.status==='complete'&&!set.overflow;
 const byFact=new Map();
 for(const item of ratings.view){if(!byFact.has(item.factKey))byFact.set(item.factKey,[]);byFact.get(item.factKey).push(item);}
 const missing=set.storageIds.filter(id=>!ratings.view.some(item=>item.aliasId===id));
 const field=(pick,negative)=>{
  const values=[];
  for(const [factKey,rows] of byFact){
   const distinct=[...new Set(rows.map(pick).map(v=>JSON.stringify(v)))];
   if(distinct.length>1)return {status:'conflict',values:rows.map(r=>({value:pick(r),storageId:r.aliasId,factKey}))};
   values.push({value:pick(rows[0]),storageIds:rows.map(r=>r.aliasId).sort(),factKey});
  }
  const known=values.filter(v=>v.value!==undefined);
  const distinct=[...new Set(known.map(v=>JSON.stringify(v.value)))];
  if(distinct.length>1)return {status:'conflict',values:known};
  if(!known.length)return {status:'unknown'};
  const value=known[0].value;
  // One value is stated as THE current value, and a negative (not watched, no rating) at all, only over every authorized alias with complete coverage.
  if(!complete||missing.length)return {status:'partial',values:known};
  const storageIds=known.flatMap(v=>v.storageIds).sort();
  return negative(value)?{status:'absent',storageIds}:{status:'present',value,storageIds};
 };
 const fields={
  // watched:false is a value (present), proved by watched=0 rows over every alias; it is never inferred from a missing row or a missing Diary entry.
  watched:field(r=>r.watched==null?undefined:r.watched===1,()=>false),
  // A known rating of null is "not rated" (absent), stated only over every alias.
  rating:field(r=>r.ratingKnown?r.rating:undefined,v=>v===null),
 };
 const statuses=Object.values(fields).map(f=>f.status);
 const status=statuses.includes('conflict')?'conflict':!complete||missing.length?'partial':'present';
 return {status,source:'d1:ratings_view',token,fields,...(missing.length?{missingAliases:missing}:{}),...(set.overflow?{reason:'budget_exceeded'}:{}),coverage:ratings.coverage,diary:{status:'unavailable',reason:'history_migration_pending'}};
}

// ---- predictions (decision 5: prediction_pointer of the authorized storage ids; never prediction_current) ----
const PREDICTION_SQL='SELECT '
 +"(SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'generation',MAX(generation)) FROM prediction_domain_authority WHERE id=1) AS marker,"
 +'(SELECT json_group_array(json_array(film_id,predicted_rating,content_sha256,updated_at,r2_key,taste_profile_version,fingerprint_hash,display_json)) FROM prediction_pointer WHERE film_id IN (SELECT value FROM json_each(?))) AS pointers';
const pointerRow=r=>({storageId:String(r[0]),predictedRating:r[1]==null?null:Number(r[1]),contentSha256:String(r[2]),updatedAt:r[3],body:{r2Key:String(r[4]),contentSha256:String(r[2])},tasteProfileVersion:r[5]==null?null:Number(r[5]),fingerprintHash:r[6]??null,display:(()=>{try{return JSON.parse(r[7]);}catch{return null;}})()});
async function predictionsSection(db,budget,set,coverage){
 if(!set.storageIds.length)return {section:{status:'unknown',reason:'no_authorized_alias',source:'d1:prediction_pointer',token:null,tokenStatus:'unavailable',coverage}};
 const fence=fenceOf(budget,1);
 if(!fence)return {section:unavailable('budget_exceeded')};
 let first;
 try{first=await row(db,PREDICTION_SQL,[JSON.stringify(set.storageIds)]);}
 catch(error){fence.release();return {section:unavailable(overBudget(error)?'budget_exceeded':'prediction_unavailable')};}
 const marker=json(first.marker);
 if(Number(marker?.rows)!==1||marker.mode!=='d1'){fence.release();return {section:unavailable('prediction_unavailable')};}
 const current=list(first.pointers).map(pointerRow).sort((a,b)=>a.storageId<b.storageId?-1:1);
 const token={generation:Number(marker.generation),pointers:digestOf(current)};
 const distinct=[...new Set(current.map(p=>JSON.stringify(p.predictedRating)))];
 const complete=coverage.status==='complete'&&!set.overflow;
 let status;
 // A known conflict between authorized keys stays a conflict even with incomplete coverage; incomplete coverage never states none.
 if(distinct.length>1)status='conflict';
 else if(!complete)status='partial';
 else status=current.length?'present':'absent';
 const section={status,source:'d1:prediction_pointer',token,current,coverage,...(status==='absent'?{reason:'none'}:{}),...(set.overflow?{reason:'budget_exceeded'}:{}),lineage:{status:'unavailable',reason:'history_route'}};
 const after=async()=>{if(!fence.redeem())return false;const r=await row(db,PREDICTION_SQL,[JSON.stringify(set.storageIds)]);return digestOf({m:json(r.marker),p:list(r.pointers).map(pointerRow).sort((a,b)=>a.storageId<b.storageId?-1:1)})===digestOf({m:marker,p:current});};
 return {section,after};
}

// ---- Watchlist (decision 5: source authority ADR 0186 vs projection ADR 0203, and the negative proof) ----
const CURRENT_SNAPSHOT='(SELECT snapshot_id FROM watchlist_current WHERE id=1)';
const WATCHLIST_SQL='SELECT '
 +"(SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'generation',MAX(generation),'writes',MAX(writes)) FROM watchlist_authority WHERE id=1) AS source,"
 +"(SELECT json_object('version',version,'snapshotId',snapshot_id,'listSha256',list_sha256,'filmCount',film_count,'drained',effects_drained_version) FROM watchlist_current WHERE id=1) AS pointer,"
 +'(SELECT COUNT(*) FROM watchlist_member WHERE snapshot_id='+CURRENT_SNAPSHOT+') AS members,'
 +'(SELECT json_group_array(lid) FROM watchlist_member WHERE snapshot_id='+CURRENT_SNAPSHOT+' AND lid IN (SELECT value FROM json_each(?))) AS listed,'
 +"(SELECT COUNT(*) FROM watchlist_member m INNER JOIN watchlist_admission_pending p ON p.lid=m.lid WHERE m.snapshot_id="+CURRENT_SNAPSHOT+" AND p.state NOT IN ('resolved','superseded')) AS admissions,"
 +"(SELECT COUNT(*) FROM watchlist_member m INNER JOIN watchlist_membership_handoff h ON h.lid=m.lid WHERE m.snapshot_id="+CURRENT_SNAPSHOT+" AND h.state<>'settled') AS handoffs,"
 +"(SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'generation',MAX(generation)) FROM watchlist_membership_authority WHERE id=1) AS projection,"
 +'(SELECT COUNT(*) FROM watchlist_film WHERE film_id=?) AS projected,'
 +"(SELECT json_object('version',version,'member',member) FROM watchlist_film_fence WHERE film_id=?) AS filmFence";
async function watchlistSection(db,budget,set,filmId){
 const fence=fenceOf(budget,1);
 if(!fence)return {section:unavailable('budget_exceeded')};
 const params=[JSON.stringify(set.lids),filmId,filmId];
 let r;
 try{r=await row(db,WATCHLIST_SQL,params);}
 catch(error){fence.release();return {section:unavailable(overBudget(error)?'budget_exceeded':'watchlist_unavailable')};}
 const read=x=>({source:json(x.source),pointer:json(x.pointer),members:Number(x.members),listed:list(x.listed).map(String).sort(),admissions:Number(x.admissions),handoffs:Number(x.handoffs),projection:json(x.projection),projected:Number(x.projected),filmFence:json(x.filmFence)});
 const s=read(r);
 if(Number(s.source?.rows)!==1||(s.source.mode!=='d1'&&s.source.mode!=='epg')){fence.release();return {section:unavailable('watchlist_unavailable')};}
 const p=s.pointer;
 const token={generation:Number(s.source.generation),version:p?Number(p.version):null,snapshotId:p?.snapshotId??null,listSha256:p?.listSha256??null,projection:s.projection&&Number(s.projection.rows)===1?{mode:s.projection.mode,generation:Number(s.projection.generation)}:null};
 let member,reason=null;
 if(s.source.mode!=='d1'){member=null;reason='source_epg_mode';}
 else if(s.source.writes!=='open'){member=null;reason='source_held';}
 else if(!p||!p.snapshotId||Number(p.version)===0||s.members!==Number(p.filmCount)){member=null;reason='snapshot_incomplete';}
 else if(s.listed.length)member=true;
 else if(!set.lids.length){member=null;reason='no_verified_alias';}
 // A listed lid that is not settled might be this Film: false is never stated while one exists.
 else if(s.admissions>0||s.handoffs>0){member=null;reason='unresolved_listed_ids';}
 else member=false;
 const source={member:member??'unknown',...(reason?{reason}:{}),lids:s.listed,authority:s.source.mode,generation:token.generation,version:token.version,snapshotId:token.snapshotId,listSha256:token.listSha256};
 const projection=token.projection?{member:s.projected>0,authority:token.projection.mode,generation:token.projection.generation,...(s.filmFence?{fence:{version:Number(s.filmFence.version),member:Number(s.filmFence.member)===1}}:{})}:{member:'unknown',reason:'projection_unavailable'};
 // A difference between the source and the projection, or effects not yet drained for the current version, is lag (never a correction of either).
 const lag=(typeof member==='boolean'&&typeof projection.member==='boolean'&&member!==projection.member)||(p!=null&&Number(p.drained)<Number(p.version));
 const section={status:member==='unknown'||member===null?'unknown':set.overflow?'partial':'present',source,projection,lag,token,...(set.overflow?{reason:'budget_exceeded'}:{})};
 const after=async()=>{if(!fence.redeem())return false;return digestOf(read(await row(db,WATCHLIST_SQL,params)))===digestOf(s);};
 return {section,after};
}

// ---- availability (decision 5: the pinned published EPG generation only) ----
const AVAILABILITY_SQL='SELECT '
 +"(SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'cutover',MAX(cutover),'programmeRunId',MAX(programme_run_id),'generation',MAX(generation)) FROM published_epg_authority WHERE id=1) AS marker,"
 +'(SELECT json_group_array(json_array(film_id,channel_id,channel,start_ms,end_ms,epg_title,basis)) FROM (SELECT film_id,channel_id,channel,start_ms,end_ms,epg_title,basis FROM published_epg_show WHERE programme_run_id=(SELECT programme_run_id FROM published_epg_authority WHERE id=1) AND film_id IN (SELECT value FROM json_each(?)) ORDER BY start_ms,channel_id,film_id LIMIT ?)) AS shows';
async function availabilitySection(db,budget,set){
 if(!set.storageIds.length)return {section:{status:'unknown',reason:'no_authorized_alias',source:'published_epg',token:null,tokenStatus:'unavailable'}};
 const fence=fenceOf(budget,1);
 if(!fence)return {section:unavailable('budget_exceeded')};
 const params=[JSON.stringify(set.storageIds),CURRENT_SHOWS_MAX+1];
 let r;
 try{r=await row(db,AVAILABILITY_SQL,params);}
 catch(error){fence.release();return {section:unavailable(overBudget(error)?'budget_exceeded':'published_epg_unavailable')};}
 const marker=json(r.marker),shows=list(r.shows);
 if(Number(marker?.rows)!==1||marker.mode!=='d1'||marker.cutover!=='open'){fence.release();return {section:unavailable('published_epg_unavailable')};}
 if(!marker.programmeRunId){fence.release();return {section:unavailable('no_published_generation')};}
 const truncated=shows.length>CURRENT_SHOWS_MAX;
 const current=shows.slice(0,CURRENT_SHOWS_MAX).map(s=>({storageId:String(s[0]),channelId:String(s[1]),channel:s[2]??null,startMs:Number(s[3]),endMs:s[4]==null?null:Number(s[4]),epgTitle:s[5]??null,basis:s[6]??null}));
 const token={programmeRunId:marker.programmeRunId,generation:Number(marker.generation),shows:digestOf(shows)};
 const status=truncated||set.overflow?'partial':'present';
 const section={status,source:'published_epg',token,current,...(truncated?{reason:'shows_limit'}:set.overflow?{reason:'budget_exceeded'}:{})};
 // The generation alone does not move when Discovery assigns or revalidates shows of a run (AIR-529): the show rows read are part of the fence.
 const after=async()=>{if(!fence.redeem())return false;const a=await row(db,AVAILABILITY_SQL,params);return digestOf({m:json(a.marker),s:list(a.shows)})===digestOf({m:marker,s:shows});};
 return {section,after};
}

// ---- display (decision 5: film_metadata, localization sources, owner_review_entry; owner > reviewed > automatic, reusing the AIR-372 read model) ----
// The owner entries are those of the survivor and of every Film that redirects to it (ADR 0081: a merge does not rewrite identity_link), bounded in depth as
// in src/canonical-read-model.js. NOTE: film_redirect has no index on to_film_id, so the ancestor step scans film_redirect (the same read the accepted
// AIR-372 read model makes); it is named in the EQP evidence of the PR.
const DISPLAY_SQL='WITH RECURSIVE anc(id,depth) AS (SELECT ?,0 UNION SELECT r.from_id,a.depth+1 FROM film_redirect r INNER JOIN anc a ON r.to_film_id=a.id WHERE a.depth<?) SELECT '
 +"(SELECT json_object('originalTitle',original_title,'canonicalIdentity',canonical_identity) FROM film WHERE id=?) AS film,"
 +"(SELECT json_object('year',year,'runtime',runtime,'synopsis',synopsis,'poster',poster,'url',url,'genres',genres_json,'contentSha256',content_sha256,'updatedAt',updated_at) FROM film_metadata WHERE film_id=?) AS metadata,"
 +'(SELECT json_group_array(json_array(id,depth)) FROM anc) AS ancestors,'
 +"(SELECT json_group_array(json_array(kind,source_key,identity_link,identity_state,payload_json,generation)) FROM (SELECT kind,source_key,identity_link,identity_state,payload_json,generation FROM owner_review_entry WHERE kind='film' AND identity_state='verified' AND identity_link IN (SELECT id FROM anc) ORDER BY source_key LIMIT ?)) AS owner,"
 +"(SELECT json_group_array(json_array(source,value,source_version,provenance_json,observed_at)) FROM film_localization_source WHERE film_id=?) AS sources,"
 +"(SELECT json_group_array(json_array(status,source,value,authority,updated_at,provenance_json)) FROM film_dimension WHERE film_id=? AND dimension='localization') AS dimension,"
 +'(SELECT json_group_array(json_array(person_id,role,ordinal)) FROM (SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id=? ORDER BY role DESC,ordinal LIMIT ?)) AS credits';
const METADATA_FIELDS=['year','runtime','synopsis','poster','url','genres'];
async function displaySection(db,budget,env,filmId){
 // The display statement is read twice (before and after); the localization inputs once through src/localization-sources.js (two statements).
 const fence=fenceOf(budget,1);
 if(!fence)return {section:unavailable('budget_exceeded')};
 const params=[filmId,OWNER_ANCESTOR_DEPTH,filmId,filmId,OWNER_ENTRIES_MAX+1,filmId,filmId,filmId,CREDITS_MAX+1];
 let r,inputs;
 try{
  r=await row(db,DISPLAY_SQL,params);
  inputs=(await loadLocalizationInputs({DB:db},'film',[filmId])).get(filmId);
 }catch(error){fence.release();return {section:unavailable(overBudget(error)?'budget_exceeded':'display_unavailable')};}
 const read=x=>({film:json(x.film),metadata:json(x.metadata),ancestors:list(x.ancestors).map(a=>[String(a[0]),Number(a[1])]).sort(),owner:list(x.owner),sources:list(x.sources).map(s=>JSON.stringify(s)).sort(),dimension:list(x.dimension).map(s=>JSON.stringify(s)).sort(),credits:list(x.credits)});
 const s=read(r);
 const metadata=s.metadata;
 const token={metadata:metadata?.contentSha256??metadata?.updatedAt??null,ownerReview:digestOf(s.owner),localization:digestOf({sources:s.sources,dimension:s.dimension})};
 // Metadata fields: ADR 0214 per-field provenance is not delivered, so a missing or null value is `unknown`, never `absent` (no explicit-null provenance exists).
 const fields={};
 for(const name of METADATA_FIELDS){
  let value=metadata?metadata[name]:null;
  if(name==='genres'&&value!=null){try{value=JSON.parse(value);}catch{value=null;}if(Array.isArray(value)&&!value.length)value=null;}
  fields[name]=value==null||value===''?{status:'unknown',provenance:'unknown'}:{status:'present',value,provenance:'unknown'};
 }
 fields.originalTitle=s.film?.originalTitle?{status:'present',value:s.film.originalTitle,provenance:'unknown'}:{status:'unknown',provenance:'unknown'};
 // The title: owner (owner_review_entry of the survivor and its redirect ancestors) > reviewed dictionary > automatic, as in readFilms (src/canonical-read-model.js).
 const ancestry=s.ancestors.some(a=>a[1]>=OWNER_ANCESTOR_DEPTH);
 if(ancestry||s.owner.length>OWNER_ENTRIES_MAX)fields.title={status:'unknown',reason:ancestry?'owner_ancestry_bounded':'owner_entries_bounded'};
 else{
  const candidates=ownerCandidatesFromEntries(s.owner.map(o=>({kind:o[0],source_key:o[1],identity_link:o[2],identity_state:o[3],payload_json:o[4]})));
  const owned=s.ancestors.flatMap(a=>candidates.get(a[0])||[]);
  const distinct=[...new Set(owned.map(item=>item.value))];
  if(distinct.length>1)fields.title={status:'conflict',values:owned.map(item=>({value:item.value,sourceKey:item.sourceKey,link:item.link}))};
  else{
   const input={...inputs};
   if(owned.length)input.owner={value:owned[0].value,at:owned.map(item=>item.at).filter(Boolean).sort().at(-1)??null};
   const resolved=resolveLocalization(input);
   fields.title=resolved.value?{status:'present',value:resolved.value,provenance:resolved.tier,source:resolved.source??null}:{status:'unknown'};
  }
 }
 const truncated=s.credits.length>CREDITS_MAX;
 const credits={status:truncated?'partial':s.credits.length?'present':'unknown',items:s.credits.slice(0,CREDITS_MAX).map(c=>({personId:String(c[0]),role:String(c[1]),ordinal:Number(c[2])}))};
 const statuses=[...Object.values(fields).map(f=>f.status),credits.status];
 const status=statuses.includes('conflict')?'conflict':statuses.every(x=>x==='present')?'present':'partial';
 const section={status,source:'d1:film_metadata',token,fields,credits};
 const after=async()=>{if(!fence.redeem())return false;return digestOf(read(await row(db,DISPLAY_SQL,params)))===digestOf(s);};
 return {section,after};
}

// ---- history (decision 6a): limited or unavailable, never present in v1 ----
function historySection(resolution,set,coverage){
 const base={reason:'history_migration_pending',token:null,tokenStatus:'unavailable'};
 const requested=resolution.requested;
 const lid=set.lids.length===1?set.lids[0]:null;
 const viaLegacy=lid&&!set.overflow&&coverage.status==='complete'&&(requested.scheme==='tmdb_movie'&&set.movies.includes(requested.value)||requested.scheme==='letterboxd_lid'&&requested.value===lid);
 // The legacy route bridges tmdb_<n> through catalogFilmIdentityBridge (single lid, no redirect source) and takes a lid as it is.
 if(viaLegacy&&resolution.redirectedFrom.length===0)return {status:'limited',...base,href:'/api/enrichment/history?filmId='+encodeURIComponent(requested.scheme==='tmdb_movie'?'tmdb_'+requested.value:lid)};
 return {status:'unavailable',...base};
}

// The sections of one found identity. Called by readFilmAggregateIdentity between the resolution and the final fence, with the shared budget.
export async function readSections(env,resolution,budget){
 const db=countedDatabase(database(env),budget);
 const set=aliases(resolution);
 const out={},afters=[];
 // The ratings coverage reads come first (decision 7), then the sections.
 const ratings=await readRatings(db,budget,resolution,set);
 const ratingsAvailable=ratings.state==='open';
 const coverage=ratingsAvailable?ratings.coverage:{status:'incomplete',reason:'ratings_evidence_unavailable',token:null,tokenStatus:'unavailable'};
 out.display=null;out.watchlist=null;out.availability=null;
 out.personal=ratingsAvailable?personalSection(ratings,set):unavailable(ratings.state==='budget'?'budget_exceeded':ratings.reason);
 const predictions=await predictionsSection(db,budget,set,coverage);
 out.predictions=predictions.section;
 if(predictions.after)afters.push(['predictions',predictions.after]);
 if(ratingsAvailable)afters.push(['ratings',ratings.after]);
 for(const [name,read] of [['watchlist',()=>watchlistSection(db,budget,set,resolution.filmId)],['availability',()=>availabilitySection(db,budget,set)],['display',()=>displaySection(db,budget,env,resolution.filmId)]]){
  const result=await read();
  out[name]=result.section;
  if(result.after)afters.push([name,result.after]);
 }
 out.history=historySection(resolution,set,coverage);
 // The after-reads of every section (E1). A ratings movement degrades both ratings-dependent sections (G1: ratings evidence is not identity).
 for(const [name,after] of afters){
  let same;
  try{same=await after();}catch{same=false;}
  if(same)continue;
  const moved=unavailable('generation_moved');
  if(name==='ratings'){out.personal=moved;if(out.predictions.coverage)out.predictions=moved;}
  else out[name]=moved;
 }
 return {display:out.display,watchlist:out.watchlist,availability:out.availability,personal:out.personal,predictions:out.predictions,history:out.history};
}

// FilmAggregateV1 for one typed id. -> {http, body}. 400/404/409/410/503 carry the identity only; 200 carries every section.
export async function readFilmAggregate(env,input,{budgetLimit=REQUEST_STATEMENT_BUDGET}={}){
 return readFilmAggregateIdentity(env,input,{budgetLimit,sections:(resolution,budget)=>readSections(env,resolution,budget)});
}

// The internal GET route of AIR-648, NOT registered in the Worker (dormant). GET and HEAD only; the typed id is the `id` query parameter. Pure read (ADR 0107).
export async function handleFilmAggregateRequest(request,env){
 const url=new URL(request.url);
 if(url.pathname!==FILM_AGGREGATE_ROUTE)return null;
 const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
 if(request.method!=='GET'&&request.method!=='HEAD')return new Response(JSON.stringify({error:'method_not_allowed'}),{status:405,headers:{...headers,allow:'GET, HEAD'}});
 const id=url.searchParams.getAll('id');
 const result=id.length===1?await readFilmAggregate(env,id[0]):{http:400,body:{contract:FILM_AGGREGATE_CONTRACT,identity:{verdict:'invalid',reason:'not_a_typed_id',requested:null}}};
 return new Response(request.method==='HEAD'?null:JSON.stringify(result.body),{status:result.http,headers});
}
