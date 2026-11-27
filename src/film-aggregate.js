// AIR-647 / ADR 0216 (Accepted), delivery graph step 3. FilmAggregateV1: the sections of the unified Film read contract, composed per request over the
// typed resolver of AIR-646 (src/film-aggregate-resolver.js), with the mandatory candidate discovery and coverage of decision 6b (G1).
// DORMANT: nothing in the Worker imports this module or the resolver (neither is bundled; build.mjs does not name them), so no route serves it and no
// consumer is switched. Activation is AIR-648 (its own owner GO and its pre-activation readback of both indexes it needs, tmdb_retirement_decision_movie (0040,
// AIR-667) and film_redirect_by_target (0043, this card): both migrations are delivered offline only and applied together by the AIR-603 M1 chain). The internal route handler below exists for the tests and for that card.
// It only reads D1: every statement is a plain SELECT (a write is refused before it reaches the binding), no R2, no network, no repair, no promotion, no cache.
//
// Shape of one request (decision 7): the final identity fence is reserved first (resolver); then each section reserves its after-statement before it reads,
// so a section that has read can always be fenced; the ratings coverage reads come first, then the sections. A section that cannot get its statements is
// `unavailable` `budget_exceeded` and the identity fence still runs. Every section reads its data AND its tokens in ONE SQL statement (one snapshot), so the
// token names exactly the rows the answer was built from, and re-reads that statement after ALL section reads (E1); a difference makes that section
// `unavailable` `generation_moved`. The identity fence (decision 4) runs last and fails the whole answer with 503 `identity_moved` and no section.
// A section that fails (a read, a parse, a processing error) loses only itself: it is `unavailable` with a typed reason and its reservation is given back;
// a ratings failure degrades coverage (`ratings_evidence_unavailable`) and never erases an independent section.
//
// Work is bounded BEFORE it is materialized: a ratings document is read only by a statement that measures its parts and bytes and returns the parts in the
// same snapshot (a replacement document can never be materialized past the cap), the settlement rows of the candidates are LIMITed in SQL, and every list a
// statement can return is capped (cap + 1 proves an overflow). Every statement is served by a primary key or an existing index.
//
// Domain markers are read inline in each section's statement with the same served-state rule as the domain's own reader (ratings d1/open, prediction d1,
// published EPG d1/open, Watchlist d1 with open writes for the source): one statement per snapshot keeps the 40-statement budget. A missing table, a
// malformed row or a refused marker makes the section `unavailable`, never a negative.
import {createHash} from 'node:crypto';
import {CREDIT_SELECTION_SQL,database} from './film-person-authority.js';
import {localizationInputsFromRows,ownerCandidatesFromEntries,resolveLocalization} from './localization-sources.js';
import {readFilmAggregateIdentity,REQUEST_STATEMENT_BUDGET,FILM_AGGREGATE_CONTRACT} from './film-aggregate-resolver.js';
import {COHORT_SQL,MISSING_LID_ADMISSION,predictionEligibility} from './prediction-lid-only-exclusion.js';

export {FILM_AGGREGATE_CONTRACT};
// ADR 0216 decision 6b, the work bounds of candidate discovery.
export const LINK_DOCUMENT_MAX_PARTS=40;
export const LINK_DOCUMENT_PART_BYTES=60000;
export const LINK_DOCUMENT_MAX_BYTES=LINK_DOCUMENT_MAX_PARTS*LINK_DOCUMENT_PART_BYTES;
export const LINK_INDEX_MAX_ENTRIES=50000;
export const FACT_RECORDS_MAX=4;
export const CANDIDATES_MAX=8;
// The existing reader of a fact record (src/ratings-d1.js readParts) has no size cap, so this card states one: a record is a handful of observations and a
// small rating history, far below it. A larger record is not read (coverage `incomplete`, `discovery_cap`), never materialized.
export const FACT_RECORD_MAX_PARTS=8;
export const FACT_RECORD_MAX_BYTES=FACT_RECORD_MAX_PARTS*LINK_DOCUMENT_PART_BYTES;
// Claim and retirement rows the settlement of the candidates may read (the identity cap of decision 7); one more row proves an overflow.
export const SETTLEMENT_ROWS_MAX=64;
// ADR 0216 decision 7.
export const CURRENT_SHOWS_MAX=50;
export const CREDITS_MAX=60;
export const OWNER_ENTRIES_MAX=64;
export const LOCALIZATION_SOURCES_MAX=10;
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
// only a single plain SELECT (optionally behind a WITH) may be prepared; anything that could write, define or pragma is refused before it reaches D1. It is the
// same budget object the resolver charges, so the identity reads, the reserved fence and the sections share 40.
const FORBIDDEN=/\b(insert|update|delete|replace|create|drop|alter|pragma|attach|detach|vacuum|reindex|analyze)\b/i;
function guardSql(sql){
 const text=String(sql).replace(/'(?:[^']|'')*'/g,"''");
 if(!/^\s*(?:with\b[\s\S]*?\)\s*)?select\b/i.test(text)||/;\s*\S/.test(text)||FORBIDDEN.test(text))throw sectionError('aggregate_write_refused');
}
export function countedDatabase(db,budget){
 const wrap=statement=>({
  inner:statement,
  bind(...params){return wrap(statement.bind(...params));},
  async first(...args){if(!budget.take(1))throw new BudgetExceeded();return statement.first(...args);},
  async all(...args){if(!budget.take(1))throw new BudgetExceeded();return statement.all(...args);},
  async raw(...args){if(!budget.take(1))throw new BudgetExceeded();return statement.raw(...args);},
  async run(){throw sectionError('aggregate_write_refused');},
 });
 return {
  prepare(sql){guardSql(sql);return wrap(db.prepare(sql));},
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
// Runs one section behind its reservation. A failure of any kind (a read, a parse, a processing error) is that section's typed `unavailable` and gives the
// reservation back; it never reaches the resolver's generic section_read_failed path, so the independent sections survive.
async function guarded(budget,reason,run){
 const fence=fenceOf(budget,1);
 if(!fence)return {section:unavailable('budget_exceeded')};
 try{
  const result=await run(fence);
  if(!result.after)fence.release();
  return result;
 }catch(error){
  fence.release();
  return {section:unavailable(overBudget(error)?'budget_exceeded':reason)};
 }
}

// ---- the alias sets (decision 6b: authorized aliases only; a TV number is never a storage key) ----
export function aliases(resolution){
 const a=resolution.authorized||{tmdb_movie:[],tmdb_tv:[],letterboxd_lid:[]};
 const over=new Set(resolution.aliasOverflow||[]);
 // The resolver keeps at most 8 aliases per scheme; the others are not read. Only the schemes a section reads count (a TV number is never a storage key).
 const lidOverflow=over.has('letterboxd_lid'),movieOverflow=over.has('tmdb_movie');
 return {
  lids:[...a.letterboxd_lid],movies:[...a.tmdb_movie],lidOverflow,overflow:lidOverflow||movieOverflow,
  // Prediction pointers, published EPG film ids and ratings_view alias ids: the lid itself and tmdb_<n>.
  storageIds:[...a.letterboxd_lid,...a.tmdb_movie.map(n=>'tmdb_'+n)].sort(),
  // The ratings link index form.
  seeds:[...a.letterboxd_lid.map(l=>'letterboxd:'+l),...a.tmdb_movie.map(n=>'tmdb:'+n)].sort(),
 };
}

// ---- ratings evidence: personal facts and candidate coverage (decision 6b) ----
// R1: the ratings marker and the ratings_view rows of the authorized aliases (primary key lookups).
const RATINGS_HEAD_SQL="SELECT (SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'cutover',MAX(cutover),'generation',MAX(generation)) FROM ratings_domain_authority WHERE id=1) AS marker,"
 +'(SELECT json_group_array(json_array(alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at)) FROM ratings_view WHERE alias_id IN (SELECT value FROM json_each(?))) AS view';
// R2/R3: the parts of owned documents, BOUNDED IN THE SAME STATEMENT that returns them. The CTE measures each key (parts, bytes, distinct etags) over
// ratings_document's primary key; the LEFT JOIN returns the part rows only for a key that is within the caps AND has one etag, evaluated in one snapshot, so a
// document that was replaced by a larger one is never materialized (it answers one row with no body, whose measure shows the overflow). A key with no part
// has no row at all (absent). The measure reads part rows server-side (bounded by the document, never returned).
const BOUNDED_DOCUMENTS_SQL='WITH g AS (SELECT key,COUNT(*) AS parts,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes,COUNT(DISTINCT etag) AS etags,MIN(etag) AS etag FROM ratings_document WHERE key IN (SELECT value FROM json_each(?)) GROUP BY key) '
 +'SELECT g.key AS key,g.parts AS parts,g.bytes AS bytes,g.etags AS etags,g.etag AS etag,d.part AS part,d.body AS body FROM g LEFT JOIN ratings_document d ON d.key=g.key AND g.parts<=? AND g.bytes<=? AND g.etags=1 ORDER BY g.key,d.part';
// The ownership proof of the candidates (decision 6b, step 5): the claim rows of each candidate (scheme, value), whether its Film is a redirect source, and the
// retirement decisions of the candidate movie ids. Both lists are LIMITed (cap + 1) before they are materialized. Index use: film_external_id_by_scheme_value,
// film_redirect and film primary keys, tmdb_retirement_decision_movie (AIR-667).
const SETTLEMENT_COLUMNS="(SELECT json_group_array(json_array(film_id,scheme,value,trusted,conflicting,redirected,present)) FROM (SELECT e.film_id AS film_id,e.scheme AS scheme,e.value AS value,e.trusted AS trusted,e.conflicting AS conflicting,(SELECT COUNT(*) FROM film_redirect r WHERE r.from_id=e.film_id) AS redirected,(SELECT COUNT(*) FROM film f WHERE f.id=e.film_id) AS present FROM json_each(?) j INNER JOIN film_external_id e ON e.scheme=json_extract(j.value,'$[0]') AND e.value=json_extract(j.value,'$[1]') LIMIT ?)) AS claims,"
 // The decisions are read by movie id and superseded in memory, as the resolver does: supersedes_seq has no index.
 +'(SELECT json_group_array(json_array(seq,kind,movie_id,supersedes_seq)) FROM (SELECT seq,kind,movie_id,supersedes_seq FROM tmdb_retirement_decision WHERE movie_id IN (SELECT value FROM json_each(?)) LIMIT ?)) AS retired';
const SETTLEMENT_SQL='SELECT '+SETTLEMENT_COLUMNS;
// The after-statement of the ratings sections: the marker, the etag of every document read (part 0), the ratings_view rows and the settlement rows.
const RATINGS_AFTER_SQL="SELECT (SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'cutover',MAX(cutover),'generation',MAX(generation)) FROM ratings_domain_authority WHERE id=1) AS marker,"
 +'(SELECT json_group_array(json_array(key,etag)) FROM ratings_document WHERE part=0 AND key IN (SELECT value FROM json_each(?))) AS etags,'
 +'(SELECT json_group_array(json_array(alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at)) FROM ratings_view WHERE alias_id IN (SELECT value FROM json_each(?))) AS view,'
 +SETTLEMENT_COLUMNS;

// The owned-document check of src/ratings-d1.js (readParts): parts 0..n-1, one etag, the etag is the SHA-256 of the joined text, the text is JSON.
function assemble(rows){
 const etag=rows[0].etag;
 if(rows.some((item,index)=>Number(item.part)!==index||item.etag!==etag))throw sectionError('ratings_document_malformed');
 const text=rows.map(item=>item.body).join('');
 if(createHash('sha256').update(text).digest('hex')!==etag)throw sectionError('ratings_document_malformed');
 try{return {value:JSON.parse(text),etag};}catch{throw sectionError('ratings_document_malformed');}
}
// -> Map key -> {state:'absent'|'over_cap'|'mixed'|'ok', value?, etag?}. Over-cap and mixed-etag documents are never assembled.
async function readBoundedDocuments(db,keys,maxParts,maxBytes){
 const rows=(await db.prepare(BOUNDED_DOCUMENTS_SQL).bind(JSON.stringify(keys),maxParts,maxBytes).all()).results||[];
 const byKey=new Map();
 for(const item of rows){
  if(!byKey.has(item.key))byKey.set(item.key,{parts:Number(item.parts),bytes:Number(item.bytes),etags:Number(item.etags),rows:[]});
  if(item.part!=null)byKey.get(item.key).rows.push(item);
 }
 const out=new Map();
 for(const key of keys){
  const entry=byKey.get(key);
  if(!entry){out.set(key,{state:'absent'});continue;}
  if(entry.parts>maxParts||entry.bytes>maxBytes){out.set(key,{state:'over_cap'});continue;}
  if(entry.etags!==1){out.set(key,{state:'mixed'});continue;}
  if(entry.rows.length!==entry.parts)throw sectionError('ratings_document_malformed');
  out.set(key,{state:'ok',...assemble(entry.rows)});
 }
 return out;
}
// A fact record must carry the minimum recognized envelope, and then holds at most one outgoing edge (redirectTo or migrating.to), a valid key. -> the edge key or null.
// Envelope (what the records of src/letterboxd-facts.js carry): a plain object; `schemaVersion` 1 when present (the only version there is; an absent one is a legacy
// record); `factKey`, when present, is its own key (an absent one is tolerated exactly as the ADR 0184 planner tolerates it); a `links` object is REQUIRED and names at
// least one valid identity: a Letterboxd id (LID-only), a TMDB movie id (TMDB-only: the owner's watched mark, ADR 0032, writes `letterboxd: null`) or both. Every
// non-null member is validated by its own type (a lid string that is not spelled `tmdb_<n>`; a TMDB id as a positive-integer string or number, never an array or an
// object coerced to a string); both null or absent is no identity. An arbitrary JSON object, `{}` included, is not a fact record and never certifies a traversal.
// This is the shape check G1 needs, not the promotion-grade link proof of ADR 0184. A malformed record is never read as "no edge".
const validLid=value=>typeof value==='string'&&LID.test(value)&&!value.startsWith('tmdb_');
const validMovie=value=>typeof value==='string'?TMDB.test(value):Number.isSafeInteger(value)&&value>0&&TMDB.test(String(value));
function recordEdge(record,key){
 if(!record||typeof record!=='object'||Array.isArray(record))throw sectionError('ratings_document_malformed');
 if(record.schemaVersion!==undefined&&record.schemaVersion!==1)throw sectionError('ratings_document_malformed');
 if(record.factKey!==undefined&&record.factKey!==key)throw sectionError('ratings_document_malformed');
 const links=record.links;
 if(!links||typeof links!=='object'||Array.isArray(links))throw sectionError('ratings_document_malformed');
 const hasLid=links.letterboxd!=null,hasMovie=links.tmdb!=null;
 if(!hasLid&&!hasMovie)throw sectionError('ratings_document_malformed');
 if(hasLid&&!validLid(links.letterboxd))throw sectionError('ratings_document_malformed');
 if(hasMovie&&!validMovie(links.tmdb))throw sectionError('ratings_document_malformed');
 const redirect=record.redirectTo!=null,migrating=record.migrating!=null;
 if(redirect&&migrating)throw sectionError('ratings_document_malformed');
 if(!redirect&&!migrating)return null;
 if(migrating&&(typeof record.migrating!=='object'||Array.isArray(record.migrating)))throw sectionError('ratings_document_malformed');
 const hop=redirect?record.redirectTo:record.migrating.to;
 if(typeof hop!=='string'||!FACT_KEY.test(hop))throw sectionError('ratings_document_malformed');
 return hop;
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
const EMPTY_SETTLEMENT={claims:[],retired:[],overflow:false};
function settlementOf(r){
 const claims=list(r.claims),decisions=list(r.retired);
 const overflow=claims.length>SETTLEMENT_ROWS_MAX||decisions.length>SETTLEMENT_ROWS_MAX;
 return {claims:claims.slice(0,SETTLEMENT_ROWS_MAX).map(c=>({film:String(c[0]),scheme:String(c[1]),value:String(c[2]),trusted:Number(c[3])===1,conflicting:Number(c[4])===1,redirected:Number(c[5])>0,present:Number(c[6])>0})).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1),retired:activeRetired(decisions.slice(0,SETTLEMENT_ROWS_MAX)),overflow};
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

// Reads the ratings evidence once for both ratings-dependent sections. Never throws: -> {state:'open'|'unavailable'|'budget', ...}. A failure to read or parse
// the EVIDENCE (documents, index, records, settlement) is coverage `incomplete`, never a lost section; only the marker and the ratings_view rows decide the state.
export async function readRatings(db,budget,resolution,set){
 const fence=fenceOf(budget,1);
 if(!fence)return {state:'budget'};
 try{
  const head=await row(db,RATINGS_HEAD_SQL,[JSON.stringify(set.storageIds)]);
  const marker=json(head.marker);
  if(Number(marker?.rows)!==1||marker.mode!=='d1'){fence.release();return {state:'unavailable',reason:'ratings_unavailable'};}
  if(marker.cutover!=='open'){fence.release();return {state:'unavailable',reason:'ratings_held'};}
  const generation=Number(marker.generation);
  const view=list(head.view).map(viewRow).sort((a,b)=>a.aliasId<b.aliasId?-1:1);
  const reasons=new Set(),documents=new Map(),seedAbsent=[],notes=[];
  // The bounded G1 evidence a history reader shares (AIR-650): each seed's fact key, the one-hop path walked from it and the records as read (etag and parsed value).
  const evidence={seedRoots:{},paths:{},records:{}};
  let candidates=[],settlement=EMPTY_SETTLEMENT,proofPairs=[],proofMovies=[];
  const coverageToken=()=>({generation,links:documents.get(LINKS_KEY)??null,records:Object.fromEntries([...documents].filter(([key])=>key!==LINKS_KEY).sort()),seedAbsent:[...seedAbsent],candidates:digestOf({candidates,settlement})});
  // Authorized aliases beyond the per-scheme cap are never examined: they are unexamined candidates, so coverage cannot be complete.
  if(set.overflow)reasons.add('discovery_cap');
  // 1. Seeds: the authorized aliases in link-index form. An empty set is never proof of coverage.
  if(!set.seeds.length)reasons.add('seed_absent_unproved');
  else{
   try{
    // 2. The link document, bounded in the statement that reads it.
    const links=(await readBoundedDocuments(db,[LINKS_KEY],LINK_DOCUMENT_MAX_PARTS,LINK_DOCUMENT_MAX_BYTES)).get(LINKS_KEY);
    if(links.state==='over_cap')reasons.add('discovery_cap');
    else if(links.state!=='ok')reasons.add('ratings_evidence_unavailable');
    else if(!links.value||typeof links.value!=='object'||Array.isArray(links.value))throw sectionError('ratings_document_malformed');
    else{
     documents.set(LINKS_KEY,links.etag);
     const index=links.value,entries=Object.entries(index);
     if(entries.length>LINK_INDEX_MAX_ENTRIES)reasons.add('discovery_cap');
     else{
      // 3. Each seed's fact key; a seed missing from the index is an absence predicate, not proof.
      const roots=new Set();
      for(const seed of set.seeds){
       const key=index[seed];
       if(key===undefined){seedAbsent.push(seed);continue;}
       if(typeof key!=='string'||!FACT_KEY.test(key))throw sectionError('ratings_document_malformed');
       roots.add(key);
       evidence.seedRoots[seed]=key;
      }
      if(seedAbsent.length)reasons.add('seed_absent_unproved');
      // 4. Each fact record reached is read once, in a bounded statement; every root is walked on its own: one redirect or migration hop is followed and both
      // sides count, a second hop, a cycle (also through a key another seed reads) and a malformed record are never "no edge".
      const readRecords=async keys=>{
       const out=new Map();
       const read=await readBoundedDocuments(db,keys.map(key=>RECORD_PREFIX+key+'.json'),FACT_RECORD_MAX_PARTS,FACT_RECORD_MAX_BYTES);
       for(const key of keys){
        const record=read.get(RECORD_PREFIX+key+'.json');
        if(record.state==='over_cap'){reasons.add('discovery_cap');continue;}
        if(record.state!=='ok'){reasons.add('ratings_evidence_unavailable');continue;}
        documents.set(RECORD_PREFIX+key+'.json',record.etag);
        out.set(key,{hop:recordEdge(record.value,key),etag:record.etag,value:record.value,kind:record.value.redirectTo!=null?'redirect':record.value.migrating!=null?'migrating':null});
       }
       return out;
      };
      const rootKeys=[...roots].sort(),reached=new Set(rootKeys);
      if(rootKeys.length>FACT_RECORDS_MAX)reasons.add('discovery_cap');
      else if(rootKeys.length){
       const first=await readRecords(rootKeys);
       const targets=[...new Set([...first.values()].map(r=>r.hop).filter(hop=>hop!=null&&!first.has(hop)&&!roots.has(hop)))].sort();
       if(rootKeys.length+targets.length>FACT_RECORDS_MAX)reasons.add('discovery_cap');
       else{
        const all=new Map([...first,...(targets.length?await readRecords(targets):new Map())]);
        for(const [key,item] of all)evidence.records[key]={etag:item.etag,value:item.value,hop:item.hop,kind:item.kind};
        for(const root of rootKeys){
         const path=[root];
         for(let at=root,depth=0;;){
          const record=all.get(at);
          if(!record||record.hop==null)break;
          if(path.includes(record.hop))throw sectionError('ratings_document_cyclic');
          if(++depth>1){reasons.add('discovery_cap');break;}
          path.push(record.hop);at=record.hop;
         }
         for(const key of path)reached.add(key);
         evidence.paths[root]=[...path];
        }
       }
      }
      // 4 (walk). The in-memory index is walked once for every other alias of the reached fact keys.
      const seedSet=new Set(set.seeds);
      const found=[];
      for(const [alias,key] of entries)if(reached.has(key)&&!seedSet.has(alias))found.push(alias);
      found.sort();
      if(found.length>CANDIDATES_MAX)reasons.add('discovery_cap');
      else candidates=found;
     }
    }
   }catch(error){
    if(overBudget(error))throw error;
    reasons.add('ratings_evidence_unavailable');
   }
  }
  // 5. Settlement of each candidate by another Film's canonical ownership proof, revalidated in the after-statement.
  const candidatePairs=candidates.map(candidatePair);
  if(candidates.length&&!reasons.has('discovery_cap')&&!reasons.has('ratings_evidence_unavailable')){
   proofPairs=candidatePairs.filter(Boolean);
   proofMovies=proofPairs.filter(p=>p[0]==='tmdb').map(p=>p[1]);
   try{
    settlement=settlementOf(await row(db,SETTLEMENT_SQL,[JSON.stringify(proofPairs),SETTLEMENT_ROWS_MAX+1,JSON.stringify(proofMovies),SETTLEMENT_ROWS_MAX+1]));
    if(settlement.overflow)reasons.add('discovery_cap');
    else{
     const open=candidates.filter((alias,i)=>!(candidatePairs[i]&&settledElsewhere(candidatePairs[i],settlement,resolution.filmId)));
     if(open.length)reasons.add('unresolved_candidate');
     for(const alias of open)notes.push({candidate:alias,state:'unresolved'});
    }
   }catch(error){
    if(overBudget(error))throw error;
    reasons.add('ratings_evidence_unavailable');
   }
  }
  const order=['ratings_evidence_unavailable','discovery_cap','seed_absent_unproved','unresolved_candidate'];
  const reason=order.find(item=>reasons.has(item))??null;
  const coverage={status:reason?'incomplete':'complete',...(reason?{reason}:{}),token:coverageToken(),candidates:candidates.length,...(set.overflow?{skippedAliases:true}:{}),...(notes.length?{notes}:{})};
  const before={marker,etags:[...documents].sort(),view,settlement};
  const after=async()=>{
   if(!fence.redeem())return false;
   const r=await row(db,RATINGS_AFTER_SQL,[JSON.stringify([...documents.keys()].sort()),JSON.stringify(set.storageIds),JSON.stringify(proofPairs),SETTLEMENT_ROWS_MAX+1,JSON.stringify(proofMovies),SETTLEMENT_ROWS_MAX+1]);
   const now={marker:json(r.marker),etags:list(r.etags).map(e=>[String(e[0]),String(e[1])]).sort(),view:list(r.view).map(viewRow).sort((a,b)=>a.aliasId<b.aliasId?-1:1),settlement:settlementOf(r)};
   return digestOf(now)===digestOf(before);
  };
  return {state:'open',generation,view,coverage,after,evidence};
 }catch(error){
  fence.release();
  return overBudget(error)?{state:'budget'}:{state:'unavailable',reason:'ratings_unavailable'};
 }
}

// Decision 6 / C2: values per distinct fact key (one fact reachable through two aliases counts once), a conflict when two values disagree, no winner.
// An alias whose row says nothing (NULL watched, rating not known) or that has no row is UNKNOWN, never a negative: a value or a negative is stated only when
// every authorized alias is known and coverage is complete; a known conflict is kept whatever else is unknown.
function personalSection(ratings,set){
 const token={generation:ratings.generation,view:digestOf(ratings.view),coverage:ratings.coverage.token};
 if(!set.storageIds.length)return {status:'unknown',reason:'no_authorized_alias',source:'d1:ratings_view',token,coverage:ratings.coverage};
 const complete=ratings.coverage.status==='complete';
 const rows=ratings.view;
 const missing=set.storageIds.filter(id=>!rows.some(item=>item.aliasId===id));
 const field=(pick,negative)=>{
  const known=[],unknown=[];
  for(const item of rows){
   const value=pick(item);
   if(value===undefined)unknown.push(item.aliasId);
   else known.push({value,storageId:item.aliasId,factKey:item.factKey});
  }
  const grouped=new Map();
  for(const item of known){
   const key=item.factKey+'\u0000'+JSON.stringify(item.value);
   if(!grouped.has(key))grouped.set(key,{value:item.value,factKey:item.factKey,storageIds:[]});
   grouped.get(key).storageIds.push(item.storageId);
  }
  const values=[...grouped.values()].map(v=>({...v,storageIds:v.storageIds.sort()}));
  const unknownAliases=[...new Set([...unknown,...missing])].sort();
  if(new Set(known.map(k=>JSON.stringify(k.value))).size>1)return {status:'conflict',values,...(unknownAliases.length?{unknownAliases}:{})};
  if(!known.length)return {status:'unknown',...(unknownAliases.length?{unknownAliases}:{})};
  if(!complete||unknownAliases.length)return {status:'partial',values,...(unknownAliases.length?{unknownAliases}:{})};
  const value=known[0].value,storageIds=known.map(k=>k.storageId).sort();
  return negative(value)?{status:'absent',storageIds}:{status:'present',value,storageIds};
 };
 const fields={
  // watched:false is a value (present), proved by watched=0 rows over every alias; it is never inferred from a missing row or a missing Diary entry.
  watched:field(r=>r.watched==null?undefined:r.watched===1,()=>false),
  // A known rating of null is "not rated" (absent), stated only over every alias.
  rating:field(r=>r.ratingKnown?r.rating:undefined,v=>v===null),
 };
 const statuses=Object.values(fields).map(f=>f.status);
 const status=statuses.includes('conflict')?'conflict':statuses.every(x=>x==='present'||x==='absent')&&complete&&!missing.length?'present':'partial';
 return {status,source:'d1:ratings_view',token,fields,...(missing.length?{missingAliases:missing}:{}),...(set.overflow?{reason:'budget_exceeded'}:{}),coverage:ratings.coverage,diary:{status:'unavailable',reason:'history_migration_pending'}};
}

// ---- predictions (decision 5: prediction_pointer of the authorized storage ids; never prediction_current) ----
const PREDICTION_SQL="SELECT (SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'generation',MAX(generation)) FROM prediction_domain_authority WHERE id=1) AS marker,"
 +'(SELECT json_group_array(json_array(film_id,predicted_rating,content_sha256,updated_at,r2_key,taste_profile_version,fingerprint_hash,display_json)) FROM prediction_pointer WHERE film_id IN (SELECT value FROM json_each(?))) AS pointers';
const pointerRow=r=>({storageId:String(r[0]),predictedRating:r[1]==null?null:Number(r[1]),contentSha256:String(r[2]),updatedAt:r[3],body:{r2Key:String(r[4]),contentSha256:String(r[2])},tasteProfileVersion:r[5]==null?null:Number(r[5]),fingerprintHash:r[6]??null,display:(()=>{try{return JSON.parse(r[7]);}catch{return null;}})()});
async function predictionsSection(db,fence,set,coverage){
 const params=[JSON.stringify(set.storageIds)];
 const readNow=async()=>{const r=await row(db,PREDICTION_SQL,params);return {marker:json(r.marker),current:list(r.pointers).map(pointerRow).sort((a,b)=>a.storageId<b.storageId?-1:1)};};
 const first=await readNow();
 if(Number(first.marker?.rows)!==1||first.marker.mode!=='d1')return {section:unavailable('prediction_unavailable')};
 const {marker,current}=first;
 const token={generation:Number(marker.generation),pointers:digestOf(current)};
 const distinct=[...new Set(current.map(p=>JSON.stringify(p.predictedRating)))];
 const complete=coverage.status==='complete';
 let status;
 // A known conflict between authorized keys stays a conflict even with incomplete coverage; incomplete coverage never states none.
 if(distinct.length>1)status='conflict';
 else if(!complete)status='partial';
 else status=current.length?'present':'absent';
 const section={status,source:'d1:prediction_pointer',token,current,coverage,...(status==='absent'?{reason:'none'}:{}),...(set.overflow?{reason:'budget_exceeded'}:{}),lineage:{status:'unavailable',reason:'history_route'}};
 const after=async()=>{if(!fence.redeem())return false;const now=await readNow();return digestOf(now)===digestOf(first);};
 return {section,after};
}


// ---- predictions.eligibility (AIR-673, ADR 0217 decision 9, choice M1): a SEPARATE field. It is a verdict about eligibility only; it never turns a present or conflicting value into `partial` and never invents incompleteness. ----
// ONE cohort rule with the prediction queue, the manifest and `submit` (`COHORT_SQL`, src/prediction-lid-only-exclusion.js, the SAME statement) on the resolved survivor Film: the survivor is the Film of a `film_lid_admission` row
// (its own or a redirect source's: a merge moves the proof) and holds no current trusted `tmdb` claim (a retired movie is historical evidence, not a current claim). The claim rows decide, never the spelling of an id. The statement is
// spent only for a survivor WITHOUT a current trusted movie claim (an ordinary movie Film is outside the cohort by the rule itself and costs none). Not readable (no budget, a failed read) is `unknown`, never an eligible answer.
// A table not yet applied means no lid-only Film exists.
async function eligibilitySection(db,resolution){
 const claims=Array.isArray(resolution.claims)?resolution.claims:[];
 if(claims.some(c=>c.scheme==='tmdb'&&c.trusted===true&&c.conflicting!==true&&c.retired!==true))return null;
 let inCohort;
 try{inCohort=(await db.prepare(COHORT_SQL).bind(JSON.stringify([resolution.filmId])).all()).results?.length>0;}
 catch(error){
  if(error instanceof BudgetExceeded)return {status:'unknown',reason:'budget_exceeded'};
  if(MISSING_LID_ADMISSION.test(String(error?.message||error?.cause?.message||'')))return null;
  return {status:'unknown',reason:'eligibility_unavailable'};
 }
 return predictionEligibility({inCohort});
}

// ---- Watchlist (decision 5: source authority ADR 0186 vs projection ADR 0203, and the negative proof) ----
const CURRENT_SNAPSHOT='(SELECT snapshot_id FROM watchlist_current WHERE id=1)';
const WATCHLIST_SQL="SELECT (SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'generation',MAX(generation),'writes',MAX(writes)) FROM watchlist_authority WHERE id=1) AS source,"
 +"(SELECT json_object('version',version,'snapshotId',snapshot_id,'listSha256',list_sha256,'filmCount',film_count,'drained',effects_drained_version) FROM watchlist_current WHERE id=1) AS pointer,"
 +'(SELECT COUNT(*) FROM watchlist_member WHERE snapshot_id='+CURRENT_SNAPSHOT+') AS members,'
 +'(SELECT json_group_array(lid) FROM watchlist_member WHERE snapshot_id='+CURRENT_SNAPSHOT+' AND lid IN (SELECT value FROM json_each(?))) AS listed,'
 +"(SELECT COUNT(*) FROM watchlist_member m INNER JOIN watchlist_admission_pending p ON p.lid=m.lid WHERE m.snapshot_id="+CURRENT_SNAPSHOT+" AND p.state NOT IN ('resolved','superseded')) AS admissions,"
 +"(SELECT COUNT(*) FROM watchlist_member m INNER JOIN watchlist_membership_handoff h ON h.lid=m.lid WHERE m.snapshot_id="+CURRENT_SNAPSHOT+" AND h.state<>'settled') AS handoffs,"
 +"(SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'generation',MAX(generation)) FROM watchlist_membership_authority WHERE id=1) AS projection,"
 +'(SELECT COUNT(*) FROM watchlist_film WHERE film_id=?) AS projected,'
 +"(SELECT json_object('version',version,'member',member) FROM watchlist_film_fence WHERE film_id=?) AS filmFence";
async function watchlistSection(db,fence,set,filmId){
 const params=[JSON.stringify(set.lids),filmId,filmId];
 const read=x=>({source:json(x.source),pointer:json(x.pointer),members:Number(x.members),listed:list(x.listed).map(String).sort(),admissions:Number(x.admissions),handoffs:Number(x.handoffs),projection:json(x.projection),projected:Number(x.projected),filmFence:json(x.filmFence)});
 const s=read(await row(db,WATCHLIST_SQL,params));
 if(Number(s.source?.rows)!==1||(s.source.mode!=='d1'&&s.source.mode!=='epg'))return {section:unavailable('watchlist_unavailable')};
 const p=s.pointer;
 const token={generation:Number(s.source.generation),version:p?Number(p.version):null,snapshotId:p?.snapshotId??null,listSha256:p?.listSha256??null,projection:s.projection&&Number(s.projection.rows)===1?{mode:s.projection.mode,generation:Number(s.projection.generation)}:null};
 let member,reason=null;
 if(s.source.mode!=='d1'){member=null;reason='source_epg_mode';}
 else if(s.source.writes!=='open'){member=null;reason='source_held';}
 else if(!p||!p.snapshotId||Number(p.version)===0||s.members!==Number(p.filmCount)){member=null;reason='snapshot_incomplete';}
 else if(s.listed.length)member=true;
 else if(!set.lids.length){member=null;reason='no_verified_alias';}
 // Only the first eight verified lids were checked: a lid that was not is a lid that might be listed, so a negative is never stated.
 else if(set.lidOverflow){member=null;reason='alias_overflow';}
 // A listed lid that is not settled might be this Film: false is never stated while one exists.
 else if(s.admissions>0||s.handoffs>0){member=null;reason='unresolved_listed_ids';}
 else member=false;
 const source={member:member??'unknown',...(reason?{reason}:{}),lids:s.listed,authority:s.source.mode,generation:token.generation,version:token.version,snapshotId:token.snapshotId,listSha256:token.listSha256};
 const projection=token.projection?{member:s.projected>0,authority:token.projection.mode,generation:token.projection.generation,...(s.filmFence?{fence:{version:Number(s.filmFence.version),member:Number(s.filmFence.member)===1}}:{})}:{member:'unknown',reason:'projection_unavailable'};
 // A difference between the source and the projection, or effects not yet drained for the current version, is lag (never a correction of either).
 const lag=(typeof member==='boolean'&&typeof projection.member==='boolean'&&member!==projection.member)||(p!=null&&Number(p.drained)<Number(p.version));
 const section={status:member===null?'unknown':set.lidOverflow?'partial':'present',source,projection,lag,token,...(set.lidOverflow?{reason:'budget_exceeded'}:{})};
 const after=async()=>{if(!fence.redeem())return false;return digestOf(read(await row(db,WATCHLIST_SQL,params)))===digestOf(s);};
 return {section,after};
}

// ---- availability (decision 5: the pinned published EPG generation only) ----
const AVAILABILITY_SQL="SELECT (SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'cutover',MAX(cutover),'programmeRunId',MAX(programme_run_id),'generation',MAX(generation)) FROM published_epg_authority WHERE id=1) AS marker,"
 +'(SELECT json_group_array(json_array(film_id,channel_id,channel,start_ms,end_ms,epg_title,basis)) FROM (SELECT film_id,channel_id,channel,start_ms,end_ms,epg_title,basis FROM published_epg_show WHERE programme_run_id=(SELECT programme_run_id FROM published_epg_authority WHERE id=1) AND film_id IN (SELECT value FROM json_each(?)) ORDER BY start_ms,channel_id,film_id LIMIT ?)) AS shows';
async function availabilitySection(db,fence,set){
 const params=[JSON.stringify(set.storageIds),CURRENT_SHOWS_MAX+1];
 const r=await row(db,AVAILABILITY_SQL,params);
 const marker=json(r.marker),shows=list(r.shows);
 if(Number(marker?.rows)!==1||marker.mode!=='d1'||marker.cutover!=='open')return {section:unavailable('published_epg_unavailable')};
 if(!marker.programmeRunId)return {section:unavailable('no_published_generation')};
 const truncated=shows.length>CURRENT_SHOWS_MAX;
 const current=shows.slice(0,CURRENT_SHOWS_MAX).map(s=>({storageId:String(s[0]),channelId:String(s[1]),channel:s[2]??null,startMs:Number(s[3]),endMs:s[4]==null?null:Number(s[4]),epgTitle:s[5]??null,basis:s[6]??null}));
 const token={programmeRunId:marker.programmeRunId,generation:Number(marker.generation),shows:digestOf(shows)};
 const status=truncated||set.overflow?'partial':'present';
 const section={status,source:'published_epg',token,current,...(truncated?{reason:'shows_limit'}:set.overflow?{reason:'budget_exceeded'}:{})};
 // The generation alone does not move when Discovery assigns or revalidates shows of a run (AIR-529): the show rows read are part of the fence.
 const after=async()=>{if(!fence.redeem())return false;const a=await row(db,AVAILABILITY_SQL,params);return digestOf({m:json(a.marker),s:list(a.shows)})===digestOf({m:marker,s:shows});};
 return {section,after};
}

// ---- display (decision 5: film_metadata, localization sources, owner_review_entry; owner > reviewed > automatic) ----
// ONE statement reads everything the section consumes, including every column the localization mapping reads, so the title is built from the rows the token
// covers (localizationInputsFromRows is the loader's own mapping).
// Owner ancestry (ADR 0081: an owner_review_entry link is a snapshot a Film merge does not rewrite, so the owner values of a Film are those of every link in the redirect
// TREE that ends at it): a recursive CTE walks `film_redirect` BACKWARDS from the survivor through `film_redirect_by_target` (migration 0043), whatever alias the request
// used. It is bounded in depth, in breadth AND IN WORK inside the statement. A recursive step enqueues every row its query returns for a dequeued parent, so a LIMIT on
// the CTE alone would cap the OUTPUT while the queue still took every child of a high-fan-out Film. The step therefore does not join `film_redirect` directly: for each
// dequeued parent it probes the index with its own LIMIT (OWNER_ANCESTORS_MAX + 1 children: more than that under one parent is already an overflow), so the work per parent
// is constant, and the CTE stops at OWNER_ANCESTOR_DEPTH + 1 levels and at OWNER_ANCESTORS_MAX + 2 dequeued rows (the survivor, its ancestors, and one more row that proves
// an overflow). Parents dequeued x children probed is therefore constant whatever the fan-out or the depth of the data. Either overflow is typed (`owner_ancestry_bounded`)
// and never a partial answer. The edges (child, parent, depth)
// are part of the section token and of its after-read, so a new or removed edge anywhere in the tree moves it; a leaf has no child row, so a child that appears under
// it appears in the edges too. The owner entries are then found through owner_review_entry_identity, named in the statement (INDEXED BY) so the plan never falls back to the
// primary-key range of every `film` entry; their order is the planner's, so the section sorts them before it digests or uses them.
export const OWNER_ANCESTOR_DEPTH=8;
export const OWNER_ANCESTORS_MAX=64;
export const DISPLAY_SQL="WITH RECURSIVE anc(id,parent,depth) AS (SELECT ?,NULL,0 UNION ALL SELECT j.value,a.id,a.depth+1 FROM anc a, json_each((SELECT json_group_array(from_id) FROM (SELECT from_id FROM film_redirect WHERE to_film_id=a.id LIMIT ?))) j WHERE a.depth<=? LIMIT ?) "
+"SELECT (SELECT json_object('originalTitle',original_title,'canonicalIdentity',canonical_identity) FROM film WHERE id=?) AS film,"
 +"(SELECT json_object('year',year,'runtime',runtime,'synopsis',synopsis,'poster',poster,'url',url,'genres',genres_json,'contentSha256',content_sha256,'updatedAt',updated_at) FROM film_metadata WHERE film_id=?) AS metadata,"
 +'(SELECT json_group_array(json_array(id,parent,depth)) FROM anc) AS ancestors,'
 +"(SELECT json_group_array(json_array(kind,source_key,identity_link,identity_state,localization,generation)) FROM (SELECT kind,source_key,identity_link,identity_state,CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.localization') END AS localization,generation FROM owner_review_entry INDEXED BY owner_review_entry_identity WHERE kind='film' AND identity_state='verified' AND identity_link IN (SELECT id FROM anc) LIMIT ?)) AS owner,"
 +'(SELECT json_group_array(json_array(source,value,source_version,provenance_json,observed_at)) FROM (SELECT source,value,source_version,provenance_json,observed_at FROM film_localization_source WHERE film_id=? ORDER BY source LIMIT ?)) AS sources,'
 +"(SELECT json_group_array(json_array(status,source,source_version,provenance_json,value,authority,updated_at)) FROM film_dimension WHERE film_id=? AND dimension='localization') AS dimension,"
 +'(SELECT json_group_array(json_array(person_id,role,ordinal,name)) FROM ('+CREDIT_SELECTION_SQL+')) AS credits';
const METADATA_FIELDS=['year','runtime','synopsis','poster','url','genres'];
async function displaySection(db,fence,resolution){
 const filmId=resolution.filmId;
 const params=[filmId,OWNER_ANCESTORS_MAX+1,OWNER_ANCESTOR_DEPTH,OWNER_ANCESTORS_MAX+2,filmId,filmId,OWNER_ENTRIES_MAX+1,filmId,LOCALIZATION_SOURCES_MAX+1,filmId,filmId,CREDITS_MAX+1,filmId,CREDITS_MAX+1];
 const read=x=>({film:json(x.film),metadata:json(x.metadata),ancestors:list(x.ancestors).map(a=>({id:String(a[0]),parent:a[1]==null?null:String(a[1]),depth:Number(a[2])})).sort((l,r)=>l.depth-r.depth||(l.id<r.id?-1:l.id>r.id?1:0)),owner:list(x.owner).sort((l,r)=>JSON.stringify(l)<JSON.stringify(r)?-1:JSON.stringify(l)>JSON.stringify(r)?1:0),sources:list(x.sources),dimension:list(x.dimension),credits:list(x.credits)});
 const s=read(await row(db,DISPLAY_SQL,params));
 const metadata=s.metadata;
 const token={metadata:metadata?.contentSha256??metadata?.updatedAt??null,ancestry:digestOf(s.ancestors),ownerReview:digestOf(s.owner),localization:digestOf({sources:s.sources,dimension:s.dimension})};
 // Metadata fields: ADR 0214 per-field provenance is not delivered, so a missing or null value is `unknown`, never `absent` (no explicit-null provenance exists).
 const fields={};
 for(const name of METADATA_FIELDS){
  let value=metadata?metadata[name]:null;
  if(name==='genres'&&value!=null){try{value=JSON.parse(value);}catch{value=null;}if(Array.isArray(value)&&!value.length)value=null;}
  fields[name]=value==null||value===''?{status:'unknown',provenance:'unknown'}:{status:'present',value,provenance:'unknown'};
 }
 fields.originalTitle=s.film?.originalTitle?{status:'present',value:s.film.originalTitle,provenance:'unknown'}:{status:'unknown',provenance:'unknown'};
 // The owner ancestry is complete only inside both bounds; an overflow of either is never read as "no more ancestors".
 const bounded=s.ancestors.some(a=>a.depth>OWNER_ANCESTOR_DEPTH)||s.ancestors.length>1+OWNER_ANCESTORS_MAX;
 const ancestry={status:bounded?'bounded':'complete',films:Math.max(0,s.ancestors.length-1),depth:s.ancestors.reduce((m,a)=>Math.max(m,a.depth),0)};
 // The title: owner (owner_review_entry of the survivor and every Film of its redirect tree) > reviewed dictionary > automatic, over the rows captured above.
 if(bounded)fields.title={status:'unknown',reason:'owner_ancestry_bounded'};
 else if(s.owner.length>OWNER_ENTRIES_MAX)fields.title={status:'unknown',reason:'owner_entries_bounded'};
 else if(s.sources.length>LOCALIZATION_SOURCES_MAX)fields.title={status:'unknown',reason:'localization_sources_bounded'};
 else{
  const entries=s.owner.map(o=>({kind:o[0],source_key:o[1],identity_link:o[2],identity_state:o[3],payload_json:o[4]==null?'{}':'{"localization":'+o[4]+'}'}));
  const candidates=ownerCandidatesFromEntries(entries);
  const owned=s.ancestors.flatMap(a=>candidates.get(a.id)||[]);
  const distinct=[...new Set(owned.map(item=>item.value))];
  if(distinct.length>1)fields.title={status:'conflict',values:owned.map(item=>({value:item.value,sourceKey:item.sourceKey,link:item.link}))};
  else{
   const dimensions=s.dimension.map(d=>({id:filmId,status:d[0],source:d[1],source_version:d[2],provenance_json:d[3],value:d[4],authority:d[5],updated_at:d[6]}));
   const sources=s.sources.map(x=>({id:filmId,source:x[0],value:x[1],source_version:x[2],provenance_json:x[3],observed_at:x[4]}));
   const input=localizationInputsFromRows([filmId],dimensions,sources).get(filmId);
   if(owned.length)input.owner={value:owned[0].value,at:owned.map(item=>item.at).filter(Boolean).sort().at(-1)??null};
   const resolved=resolveLocalization(input);
   fields.title=resolved.value?{status:'present',value:resolved.value,provenance:resolved.tier,source:resolved.source??null}:{status:'unknown'};
  }
 }
 const truncated=s.credits.length>CREDITS_MAX;
 const credits={status:truncated?'partial':s.credits.length?'present':'unknown',items:s.credits.slice(0,CREDITS_MAX).map(c=>({personId:String(c[0]),role:String(c[1]),ordinal:Number(c[2]),name:typeof c[3]==='string'&&c[3]?c[3]:null}))};
 const statuses=[...Object.values(fields).map(f=>f.status),credits.status];
 const status=statuses.includes('conflict')?'conflict':statuses.every(x=>x==='present')?'present':'partial';
 const section={status,source:'d1:film_metadata',token,fields,credits,ancestry};
 const after=async()=>{if(!fence.redeem())return false;return digestOf(read(await row(db,DISPLAY_SQL,params)))===digestOf(s);};
 return {section,after};
}

// ---- history (decision 6a): limited or unavailable, never present in v1 ----
// The legacy route bridges through catalogFilmIdentityBridge (src/canonical-catalog-reader.js), which accepts a Film only when the owner is not a redirect source,
// none of its tmdb or letterboxd claims is untrusted or conflicting, it holds at most one trusted claim of each scheme and no other Film or untrusted row names
// those values. The eligibility is taken from the SAME fenced identity read-set (the survivor's claims); a retired movie claim, which the bridge still counts, is
// treated as not proved. Anything not proved withholds the href.
function legacyBridgeEligible(resolution){
 if(resolution.verdict!=='found'||resolution.redirectedFrom.length)return false;
 const own=resolution.claims.filter(c=>c.scheme==='tmdb'||c.scheme==='letterboxd');
 if(own.some(c=>!c.trusted||c.conflicting||c.retired||c.competing))return false;
 return own.filter(c=>c.scheme==='tmdb').length<=1&&own.filter(c=>c.scheme==='letterboxd').length<=1;
}
// Computed AFTER every section fence: it depends on the candidate coverage (decision 6a), so a coverage that did not hold gives no href.
function historySection(resolution,set,coverage){
 const base={reason:'history_migration_pending',token:null,tokenStatus:'unavailable'};
 const requested=resolution.requested;
 const lid=set.lids.length===1?set.lids[0]:null;
 const viaLegacy=lid&&!set.overflow&&coverage.status==='complete'&&legacyBridgeEligible(resolution)&&(requested.scheme==='tmdb_movie'&&set.movies.includes(requested.value)||requested.scheme==='letterboxd_lid'&&requested.value===lid);
 if(viaLegacy)return {status:'limited',...base,href:'/api/enrichment/history?filmId='+encodeURIComponent(requested.scheme==='tmdb_movie'?'tmdb_'+requested.value:lid)};
 return {status:'unavailable',...base};
}

// The sections of one found identity. Called by readFilmAggregateIdentity between the resolution and the final fence, with the shared budget. Never throws:
// every section answers for itself.
export async function readSections(env,resolution,budget){
 const db=countedDatabase(database(env),budget);
 const set=aliases(resolution);
 const out={},afters=[];
 // The ratings coverage reads come first (decision 7), then the sections.
 const ratings=await readRatings(db,budget,resolution,set);
 const ratingsAvailable=ratings.state==='open';
 let coverage=ratingsAvailable?ratings.coverage:{status:'incomplete',reason:'ratings_evidence_unavailable',token:null,tokenStatus:'unavailable'};
 if(ratingsAvailable){
  try{out.personal=personalSection(ratings,set);}
  catch{out.personal=unavailable('personal_unavailable');}
 }else out.personal=unavailable(ratings.state==='budget'?'budget_exceeded':ratings.reason);
 if(!set.storageIds.length){
  out.predictions={status:'unknown',reason:'no_authorized_alias',source:'d1:prediction_pointer',token:null,tokenStatus:'unavailable',coverage};
  out.availability={status:'unknown',reason:'no_authorized_alias',source:'published_epg',token:null,tokenStatus:'unavailable'};
 }else{
  const predictions=await guarded(budget,'prediction_unavailable',fence=>predictionsSection(db,fence,set,coverage));
  out.predictions=predictions.section;
  if(predictions.after)afters.push(['predictions',predictions.after]);
  const availability=await guarded(budget,'published_epg_unavailable',fence=>availabilitySection(db,fence,set));
  out.availability=availability.section;
  if(availability.after)afters.push(['availability',availability.after]);
 }
 if(ratingsAvailable)afters.push(['ratings',ratings.after]);
 const watchlist=await guarded(budget,'watchlist_unavailable',fence=>watchlistSection(db,fence,set,resolution.filmId));
 out.watchlist=watchlist.section;
 if(watchlist.after)afters.push(['watchlist',watchlist.after]);
 const display=await guarded(budget,'display_unavailable',fence=>displaySection(db,fence,resolution));
 out.display=display.section;
 if(display.after)afters.push(['display',display.after]);
 // The after-reads of every section (E1). A ratings movement degrades both ratings-dependent sections and the history link (G1: ratings evidence is not identity).
 let ratingsHeld=ratingsAvailable;
 for(const [name,after] of afters){
  let same;
  try{same=await after();}catch{same=false;}
  if(same)continue;
  const moved=unavailable('generation_moved');
  if(name==='ratings'){ratingsHeld=false;out.personal=moved;if(out.predictions.coverage)out.predictions=moved;}
  else out[name]=moved;
 }
 if(!ratingsHeld)coverage={status:'incomplete',reason:'ratings_evidence_unavailable',token:null,tokenStatus:'unavailable'};
 // AIR-673: attached after the after-reads, so a section that moved stays `unavailable` and carries nothing.
 if(out.predictions&&out.predictions.status!=='unavailable'){const eligibility=await eligibilitySection(db,resolution);if(eligibility)out.predictions={...out.predictions,eligibility};}
 out.history=historySection(resolution,set,coverage);
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
