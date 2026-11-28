#!/usr/bin/env node
// AIR-653 (ADR 0184, AIR-652): the owner-run operator of the trusted `letterboxd` claims of the HISTORICAL bridge-only pointer cohort. DORMANT: merging it authorizes nothing.
//
// WHAT IT IS: a narrow caller of the EXISTING writer. Every claim goes through `applyLetterboxdClaim` (the fenced `film_external_ids` unit in `addOnly` mode, the receipt protocol of
// `receiptedWrite`, the revision compare-and-swap and the write-time guards) with a fresh proof at write time. It adds no writer and writes no table of its own.
// WHAT IT IS NOT: the published-programme backfill (`letterboxd_claim_backfill` derives only `published_epg_member` candidates and caps a call at 12 pairs, so its pins do not authorize this
// cohort), a cohort discovery (the pairs come from the owner's PRIVATE allowlist, the output of the bounded capture), an admission change or a key renaming. The repository and every output hold
// counts, reasons, digests and generations, never a lid, movie id or Film id.
//
// EVERY READ IS STRICT AND BOUNDED AT THE READ. All reads of this operator, of the writer and of the readback go through one operator-scoped binding (`boundedBinding`) over the strict REST binding
// (a REST answer without its result array is an error, never an empty table): a document read of the planner is replaced by the accepted ATOMIC bounded document statement of the capture (parts,
// bytes and etag measured and the body joined in ONE statement, so a document that grew after any earlier measurement is rejected before its body is materialized); every other read is capped at
// the capture's list cap plus one row and an overflow is an error; the statements, rows and bytes of the whole execution (dry run or apply, capture, writer, readback) are charged to one explicit
// budget derived from the pair count and the AIR-647 document caps, and reported. dry_run reuses the accepted bounded capture on exactly the given pairs (the all-archives witness, one shared budget, the
// unchanged planner only on a private snapshot, a second pass that fences movement; both required indexes verified by their exact definitions). The live planner runs only inside the writer at write time,
// one pair at a time, behind this binding; at most LETTERBOXD_CLAIM_UNIT_CAP pairs per run.
//
// APPROVAL FENCE AND NO REPLAY. The approved pins (Film/Person generation, schema version, owner-review generation and writes) are bound as `approvedPins` of the existing receipt protocol with four
// per-pair conditions asserted ATOMICALLY in the receipt's RESERVATION and in the claim's batch: the frozen Ratings generation, the absence of any admission row of the movie, the captured Film still
// owning the movie as its trusted claim, and no OTHER unresolved receipt of this origin on that Film. The call also carries the captured Film (`expectedFilmId`: a fresh proof that names another Film is
// refused before anything is reserved) and `noReplay` (an id that already has an unsettled receipt is never replayed, settled or retried: it is refused before anything is read or written for it). A prior
// non-applied receipt of this origin on these Films makes the cohort `unsafe` at dry run; a partial or unknown outcome is never retried by this operator, and recovery is a separately approved decision with a new
// dry run. No registered reconciliation path replays these receipts (the reconcilers are origin-scoped and none registers `film_external_ids` for this origin).
//
// dry_run (default, read-only): prints the decision and the seven pins of an apply: Film/Person generation, Ratings generation, schema version, owner-review generation, owner-review writes, count and the
// digest of the sorted `lid:tmdb` lines (the capture's `candidateDigest`).
// apply (`--apply --confirm-go --request-id <id>` plus the seven `--expected-*` pins): derives everything again, refuses with zero writes on any difference, checks the frozen markers before the first write and
// before every pair, writes ONE pair after another and stops at the first that is not proved. Then a STRICT readback of every pair (`verifyPair`, `targetState`); any unreadable or failed proof is `unverified`,
// never `complete`; the final marker fence runs AFTER all reads.
// WRITES ARE TWO KINDS, reported separately: claim rows and receipt rows (`receipts.created`): a pair refused inside the claim batch can still leave its reserved receipt, so a rolled-back claim batch is not
// zero database writes. `writerReportedWritten` is what the writer answered; `claimsVerifiedWritten` is what the readback confirmed (null when the readback is incomplete, never inferred from a lost reply). The
// tracked write state latches uncertainty: a later successful write never hides an earlier unknown one.
// Run it between Ratings Sync slots: the Ratings generation moves with every natural Ratings write, and a moved pin refuses the run with zero writes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LETTERBOXD_CLAIM_UNIT_CAP,LETTERBOXD_CLAIM_ORIGIN,applyLetterboxdClaim,planLetterboxdClaim,claimExternalIds} from '../src/canonical-letterboxd-claim.js';
import {cohortDigest} from '../src/letterboxd-claim-backfill.js';
import {catalogStartedFilm} from '../src/canonical-catalog-reader.js';
import {FILM_EXTERNAL_IDS_OPERATION,filmExternalIdsDigest} from '../src/canonical-film-external-ids-producer.js';
import {producerRequestId} from '../src/canonical-producer-adapters.js';
import {LINK_DOCUMENT_MAX_PARTS,LINK_DOCUMENT_MAX_BYTES,FACT_RECORD_MAX_PARTS,FACT_RECORD_MAX_BYTES} from '../src/film-aggregate.js';
import {database,many,one,readAuthority} from '../src/film-person-authority.js';
import {preflight,DEFAULT_CAPS,BOUNDED_DOCUMENTS_SQL} from './letterboxd-claim-cohort-preflight.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const HISTORICAL_MAX=LETTERBOXD_CLAIM_UNIT_CAP;
export const REQUEST_ID=/^[A-Za-z0-9_-]{8,64}$/;
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const TMDB=/^[1-9]\d{0,11}$/;
const HEX64=/^[0-9a-f]{64}$/;
const LINKS_KEY='letterboxd/facts/links.json';
const FACT_KEY=/^letterboxd\/facts\/films\/[A-Za-z0-9_-]{1,80}\.json$/;
const ALL_ARCHIVES={invariant:'diary_first_lb_record_with_inferred_import_admission',allArchives:true};
const RECEIPT_HISTORY_MAX=20;
export const PIN_NAMES=['filmPersonGeneration','ratingsGeneration','schemaVersion','ownerReviewGeneration','ownerReviewWrites','count','digest'];

export class HistoricalStop extends Error{constructor(reason,details={}){super(reason);this.name='HistoricalStop';this.reason=reason;this.details=details;}}
export class ReadStop extends Error{constructor(code){super(code);this.name='ReadStop';this.code=code;}}
const controlled=value=>typeof value==='string'&&/^[a-z0-9_:.-]{1,80}$/.test(value)?value:'unclassified';

// ---- the explicit read budget and the bounded binding ------------------------------------------------------------------------------------------------
// Limits derived from what one run can legitimately read, not product caps: the statements measured for a whole apply (about 145 per pair plus the capture, twice) with a margin; rows and bytes from the
// per-statement row cap and the AIR-647 caps of the two documents the planner reads (three planner passes per pair: the proof, the write-time re-plan and the readback).
export const READ_ROWS_MAX=DEFAULT_CAPS.list;
export const readLimits=pairs=>({statements:1000+250*pairs,rows:20000+1000*pairs,bytes:4*1024*1024+pairs*3*(LINK_DOCUMENT_MAX_BYTES+FACT_RECORD_MAX_BYTES)});
export function newReadBudget(pairs){
 const limits=readLimits(pairs),used={statements:0,rows:0,bytes:0};
 const take=(name,amount)=>{used[name]+=amount;if(used[name]>limits[name])throw new ReadStop('read_budget_exhausted');};
 return {limits,used,statement:amount=>take('statements',amount),rows:amount=>take('rows',amount),bytes:amount=>take('bytes',amount),report:()=>({statements:used.statements,rows:used.rows,bytes:used.bytes,limits})};
}
const BOUND=Symbol.for('iptv.historical.bounded');
const PART_SQL='SELECT part, body, etag FROM ratings_document WHERE key=? ORDER BY part';
const LIMIT_TAIL=/\blimit\s+(?:\?|\d+)\s*;?\s*$/i;
// The planner's document read, replaced by the accepted atomic statement (see BOUNDED_DOCUMENTS_SQL): over the caps the statement itself returns no body, so nothing oversized is ever materialized.
async function readDocumentParts(inner,budget,key){
 const link=key===LINKS_KEY;
 if(!link&&!FACT_KEY.test(String(key)))throw new ReadStop('read_unbounded_document_key');
 const maxParts=link?LINK_DOCUMENT_MAX_PARTS:FACT_RECORD_MAX_PARTS,maxBytes=link?LINK_DOCUMENT_MAX_BYTES:FACT_RECORD_MAX_BYTES;
 const rows=(await inner.prepare(BOUNDED_DOCUMENTS_SQL).bind(JSON.stringify([key]),maxParts,maxBytes).all()).results;
 if(!Array.isArray(rows))throw new ReadStop('read_malformed');
 if(!rows.length)return [];
 const head=rows[0];
 if(Number(head.parts)>maxParts||Number(head.bytes)>maxBytes)throw new ReadStop('read_over_cap');
 if(Number(head.etags)!==1||rows.length!==Number(head.parts)||rows.some((item,index)=>item.part==null||Number(item.part)!==index||item.body==null))throw new ReadStop('read_malformed');
 budget.rows(rows.length);budget.bytes(JSON.stringify(rows).length);
 return rows.map(item=>({part:Number(item.part),body:item.body,etag:item.etag}));
}
export function boundedBinding(inner,budget){
 if(inner&&inner[BOUND])return inner;
 const read=async(sql,params,mode)=>{
  budget.statement(1);
  if(sql===PART_SQL)return readDocumentParts(inner,budget,params[0]);
  const cap=READ_ROWS_MAX+1;
  let text=sql,bind=params;
  if(sql!==BOUNDED_DOCUMENTS_SQL&&!LIMIT_TAIL.test(sql)){text=sql.replace(/;?\s*$/,'')+' LIMIT ?';bind=[...params,mode==='first'?1:cap];}
  const rows=(await inner.prepare(text).bind(...bind).all()).results;
  if(!Array.isArray(rows))throw new ReadStop('read_malformed');
  if(mode==='all'&&sql!==BOUNDED_DOCUMENTS_SQL&&rows.length>cap)throw new ReadStop('read_over_cap');
  budget.rows(rows.length);budget.bytes(JSON.stringify(rows).length);
  return rows;
 };
 return {
  [BOUND]:true,budget,
  batch:async statements=>{budget.statement(statements.length);return inner.batch(statements);},
  prepare(sql){
   const text=String(sql),isRead=/^\s*(?:with|select)\b/i.test(text);
   return {bind(...params){
    if(!isRead){const bound=inner.prepare(text).bind(...params);return {text:bound.text,first:()=>bound.first(),all:()=>bound.all(),run:()=>{budget.statement(1);return bound.run();}};}
    return {
     get text(){return inner.prepare(text).bind(...params).text;},
     async first(){return (await read(text,params,'first'))[0]??null;},
     async all(){return {results:await read(text,params,'all')};},
     run:async()=>{throw new ReadStop('read_cannot_run');},
    };
   }};
  },
 };
}
// Wraps the caller's env once (idempotent): everything below reads through it and is charged to ONE budget.
export function withBounds(env,pairs){
 const db=database(env);
 if(db&&db[BOUND])return {env,budget:db.budget};
 const budget=newReadBudget(pairs);
 return {env:{...env,DB:boundedBinding(db,budget)},budget};
}

// STRICT reads: a REST answer without its result array is an error (D1Error), never an empty result. Writes and batches go through the published binding unchanged (one tracked REST request per statement
// or batch, `retries: 0`). Exported for the tests of the real REST fault paths.
export async function strictBinding(adapter){
 const {createPublishedBinding}=await import('./published-epg-production.mjs');
 const base=createPublishedBinding(adapter);
 return {
  batch:statements=>base.batch(statements),
  prepare(sql){
   const prepared=base.prepare(sql);
   return {bind(...params){
    const bound=prepared.bind(...params);
    return {text:bound.text,
     async first(){return (await adapter.allStrict(sql,params))[0]??null;},
     async all(){return {results:await adapter.allStrict(sql,params)};},
     run:()=>bound.run()};
   }};
  },
 };
}
// The tracked write state LATCHES uncertainty: `trackProductionWrites` records the last attempt only, so a later successful write (a receipt settlement) would hide an earlier unknown one.
export async function trackWrites(adapter,ctx){
 const {trackProductionWrites}=await import('./published-epg-production.mjs');
 const tracked=trackProductionWrites(adapter,ctx);
 const guarded=run=>async(...args)=>{try{return await run(...args);}catch(error){ctx.everUncertain=true;throw error;}};
 return {...tracked,run:guarded(tracked.run),executeRendered:guarded(tracked.executeRendered)};
}
export const writeStateOf=ctx=>ctx?.everUncertain?'unknown':(ctx?.writeState??'none');

// The allowlist: the private result of the bounded capture (`{eligible:[{lid,tmdb}]}`) or a bare list. Pure and strict: one pair per lid and per movie, 1 to HISTORICAL_MAX pairs.
export function parseAllowlist(text){
 let value;
 try{value=JSON.parse(text);}catch{throw new HistoricalStop('allowlist_unreadable');}
 const list=Array.isArray(value)?value:Array.isArray(value?.eligible)?value.eligible:null;
 if(!list)throw new HistoricalStop('allowlist_shape');
 if(list.length<1)throw new HistoricalStop('allowlist_empty');
 if(list.length>HISTORICAL_MAX)throw new HistoricalStop('allowlist_over_limit');
 const lids=new Set(),movies=new Set(),pairs=[];
 for(const item of list){
  if(!item||typeof item!=='object'||typeof item.lid!=='string'||!LID.test(item.lid)||item.lid.startsWith('tmdb_')||typeof item.tmdb!=='string'||!TMDB.test(item.tmdb))throw new HistoricalStop('allowlist_invalid_pair');
  if(lids.has(item.lid)||movies.has(item.tmdb))throw new HistoricalStop('allowlist_duplicate');
  lids.add(item.lid);movies.add(item.tmdb);pairs.push({lid:item.lid,tmdb:item.tmdb});
 }
 return pairs.sort((a,b)=>a.lid<b.lid?-1:a.lid>b.lid?1:0);
}

// The authorities of the frozen snapshot, read as one record (strict, bounded reads; a missing row is a missing authority, never a default).
async function readMarkers(env,db){
 const gate=await readAuthority(env);
 const ratings=await one(db,'SELECT mode,cutover,generation FROM ratings_domain_authority WHERE id=1');
 const schema=await one(db,'SELECT version FROM schema_contract WHERE id=1');
 const review=await one(db,'SELECT mode,generation,writes FROM owner_review_authority WHERE id=1');
 return {
  filmPerson:{state:gate.state,generation:Number(gate.generation)},
  ratings:ratings?{mode:ratings.mode,cutover:ratings.cutover,generation:Number(ratings.generation)}:null,
  schema:schema?{version:Number(schema.version)}:null,
  ownerReview:review?{mode:review.mode,generation:Number(review.generation),writes:review.writes}:null,
 };
}
const sameMarkers=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// The request id and content digest the writer derives for one pair (origin, operation, event, target, content): the same values the receipt is verified against.
async function receiptIdentity({pair,filmId,event}){
 const digest=await filmExternalIdsDigest({id:filmId,schemes:['letterboxd'],addOnly:true,externalIds:claimExternalIds(pair)});
 const requestId=await producerRequestId({origin:LETTERBOXD_CLAIM_ORIGIN,operation:FILM_EXTERNAL_IDS_OPERATION,event,target:{kind:'film',id:filmId},digest});
 return {digest,requestId};
}
// The approved pins of one pair, for the receipt protocol (see approvedPinsOf in src/canonical-mutations.js): the fixed Film/Person, schema and owner-review pins plus four conditions asserted in the SAME
// batches (the receipt's reservation and the claim's batch): the frozen Ratings generation; the conservative all-archives witness (any admission row of this movie refuses); the captured Film still owning the
// movie as its trusted claim; and no OTHER unresolved receipt of this origin on that Film (an atomic no-prior-attempt condition: the pair's own receipt is excluded by its id).
const pinsOf=(markers,{movie,filmId,requestId})=>({
 filmPersonGeneration:markers.filmPerson.generation,schemaVersion:markers.schema.version,ownerReviewGeneration:markers.ownerReview.generation,ownerReviewWrites:markers.ownerReview.writes,
 guards:[
  {sql:"EXISTS (SELECT 1 FROM ratings_domain_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)",params:[markers.ratings.generation]},
  {sql:'NOT EXISTS (SELECT 1 FROM film_rated_admission WHERE tmdb=?)',params:[movie]},
  {sql:"EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0)",params:[filmId,movie]},
  {sql:"NOT EXISTS (SELECT 1 FROM canonical_write_receipt WHERE target_kind='film' AND target_id=? AND origin=? AND state<>'applied' AND request_id<>?)",params:[filmId,LETTERBOXD_CLAIM_ORIGIN,requestId]},
 ],
});
const pinValues=(markers,count,digest)=>({filmPersonGeneration:markers.filmPerson.generation,ratingsGeneration:markers.ratings.generation,schemaVersion:markers.schema.version,ownerReviewGeneration:markers.ownerReview.generation,ownerReviewWrites:markers.ownerReview.writes,count,digest});

// Read-only, bounded, strict. {decision:'eligible'|'already_current'|'unsafe'|'unknown', counts, blockers:[{reason,count}], markers, expect, results, work, reads}. `results` and `markers` stay inside the trusted process.
export async function inspect(rawEnv,pairs){
 const {env,budget}=withBounds(rawEnv,pairs.length);
 const db=database(env);
 const out={decision:'unsafe',counts:{pairs:pairs.length,would_write:0,already:0,refused:0,unknown:0,duplicate:0},blockers:[],markers:null,expect:null,results:[],work:null};
 const reasons={};
 const bump=reason=>{reasons[reason]=(reasons[reason]||0)+1;};
 const done=decision=>{out.decision=decision;out.blockers=Object.keys(reasons).sort().map(reason=>({reason,count:reasons[reason]}));out.reads=budget.report();return out;};
 if(!db){bump('film_person_unavailable');return done('unknown');}
 let markers;
 try{markers=await readMarkers(env,db);}
 catch(error){bump(controlled(error?.code||'film_person_unavailable'));return done(['film_person_held','film_person_not_open'].includes(error?.code)?'unsafe':'unknown');}
 out.markers=markers;
 if(markers.filmPerson.state!=='open'){bump('film_person_not_open');return done('unsafe');}
 if(!markers.ratings||markers.ratings.mode!=='d1'||markers.ratings.cutover!=='open'){bump('ratings_not_authoritative');return done('unsafe');}
 if(!markers.schema||!markers.ownerReview||markers.ownerReview.mode!=='d1'||!['open','held'].includes(markers.ownerReview.writes)){bump('authority_unreadable');return done('unsafe');}
 // The bounded capture on exactly the given pairs (the all-archives witness; both required indexes verified by their definitions inside it; one shared budget; a second pass that fences movement).
 let capture;
 try{capture=await preflight(env,{scope:ALL_ARCHIVES,subjects:pairs,caps:{...DEFAULT_CAPS}});}
 catch(error){bump(controlled(error?.code||'capture_failed'));return done('unknown');}
 out.work=capture.work;
 if(capture.decision!=='complete'){bump(controlled(capture.reason||'capture_not_complete'));if(Array.isArray(capture.missing))for(const name of capture.missing)bump('required_index_missing:'+controlled(name));return done('unknown');}
 for(const item of capture.results){
  if(item.state==='eligible_in_scope'){out.counts.would_write++;out.results.push({lid:item.lid,tmdb:item.movie,filmId:item.filmId,state:'would_write'});}
  else if(item.state==='already'){out.counts.already++;bump('already_current');out.results.push({lid:item.lid,tmdb:item.movie,filmId:item.filmId??null,state:'already'});}
  else{out.counts[item.state==='unknown'?'unknown':'refused']++;bump(controlled(item.reason));out.results.push({lid:item.lid,tmdb:item.movie,state:item.state==='unknown'?'unknown':'refused'});}
 }
 // A prior attempt is never replayed here: any receipt of this origin for these Films that is not applied makes the cohort unsafe until a separately approved recovery disposition.
 const filmIds=out.results.map(item=>item.filmId).filter(Boolean);
 if(filmIds.length){
  let prior;
  try{prior=await many(db,"SELECT request_id,state FROM canonical_write_receipt WHERE target_kind='film' AND target_id IN (SELECT value FROM json_each(?)) AND origin=? AND state<>'applied' LIMIT ?",[JSON.stringify(filmIds),LETTERBOXD_CLAIM_ORIGIN,READ_ROWS_MAX+1]);}
  catch(error){bump(controlled(error?.code||'film_person_unavailable'));return done('unknown');}
  for(let at=0;at<prior.length;at++)bump('prior_receipt_unresolved');
 }
 out.expect=pinValues(markers,pairs.length,await cohortDigest(pairs));
 // The snapshot must still be the one read at the start; a moved marker makes every pin stale.
 try{if(!sameMarkers(markers,await readMarkers(env,db))){bump('state_moved_during_read');out.expect=null;return done('unknown');}}
 catch(error){bump(controlled(error?.code||'film_person_unavailable'));out.expect=null;return done('unknown');}
 if(out.counts.unknown)return done('unknown');
 if(reasons.prior_receipt_unresolved)return done('unsafe');
 if(out.counts.would_write===pairs.length)return done('eligible');
 if(out.counts.already===pairs.length)return done('already_current');
 return done('unsafe');
}

const publicView=inspected=>({decision:inspected.decision,counts:inspected.counts,blockers:inspected.blockers,markers:inspected.markers,expect:inspected.expect,work:inspected.work,reads:inspected.reads});

// SCOPED evidence around one pair (indexed, bounded reads only): the Film's revision, its receipts of this origin (history overflow is an error), its row, its external ids, its aliases, the pair's projection rows
// and its started marks (an absent table is proved absent before and after). No table-wide count is read or claimed as evidence.
async function targetState(db,pair,filmId){
 const receiptRows=await many(db,'SELECT request_id,state FROM canonical_write_receipt WHERE target_kind=\'film\' AND target_id=? AND origin=? ORDER BY request_id LIMIT ?',[filmId,LETTERBOXD_CLAIM_ORIGIN,RECEIPT_HISTORY_MAX+1]);
 if(receiptRows.length>RECEIPT_HISTORY_MAX)throw new ReadStop('read_over_cap');
 const startedPresent=await one(db,"SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='started_mark'");
 const stamp=rows=>JSON.stringify(rows);
 return {
  revision:Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?",[filmId]))?.revision??0),
  receiptIds:receiptRows.map(row=>row.request_id),receiptStates:receiptRows.map(row=>row.state),
  film:stamp(await one(db,'SELECT contract_version,canonical_identity,original_title FROM film WHERE id=?',[filmId])),
  externalIds:(await many(db,'SELECT scheme,value,trusted,conflicting FROM film_external_id WHERE film_id=?',[filmId])).map(row=>row.scheme+':'+row.value+':'+row.trusted+':'+row.conflicting).sort(),
  aliases:stamp(await many(db,'SELECT kind,value FROM film_alias WHERE film_id=? ORDER BY kind,value',[filmId])),
  view:stamp(await many(db,'SELECT alias_id,fact_key,watched,actual_rating,watchlist,rating_known FROM ratings_view WHERE alias_id IN (?,?) ORDER BY alias_id',[pair.lid,'tmdb_'+pair.tmdb])),
  started:startedPresent?stamp(await many(db,'SELECT id,started,rev FROM started_mark WHERE id IN (?,?,?) ORDER BY id',[pair.lid,filmId,'tmdb_'+pair.tmdb])):'absent',
 };
}
// Exactly the effects of the existing writer on one target: for a written pair its revision plus one, one more receipt (applied) and the one new external id; for any other pair nothing.
function effectsExact(before,after,{wrote,pair}){
 const claim='letterboxd:'+pair.lid+':1:0';
 const newReceipts=after.receiptIds.filter(id=>!before.receiptIds.includes(id));
 const receiptsOk=wrote?newReceipts.length===1&&after.receiptIds.length===before.receiptIds.length+1&&after.receiptStates[after.receiptIds.indexOf(newReceipts[0])]==='applied':JSON.stringify(after.receiptIds)===JSON.stringify(before.receiptIds)&&JSON.stringify(after.receiptStates)===JSON.stringify(before.receiptStates);
 const idsOk=JSON.stringify(after.externalIds)===JSON.stringify(wrote?[...before.externalIds,claim].sort():before.externalIds);
 return after.revision===before.revision+(wrote?1:0)&&receiptsOk&&idsOk&&after.film===before.film&&after.aliases===before.aliases&&after.view===before.view&&after.started===before.started;
}

// The STRICT readback of one pair. Every field is read from the store through the bounded binding; a throw is not a pass (the caller reports `unverified`). For a pair this run WROTE the exact applied receipt is checked
// too: the request id and content digest the writer derives, the operation, origin, target, state `applied` and the applied revision (the Film's revision before the run plus one, equal to its revision now).
async function verifyPair(env,db,{pair,filmId,revisionBefore,written,event}){
 const checks={claim:false,receipt:written?false:null,reader:false,reproof:false};
 const claims=await many(db,"SELECT film_id,trusted,conflicting,provenance_json FROM film_external_id WHERE scheme='letterboxd' AND value=? LIMIT 3",[pair.lid]);
 if(claims.length===1){
  let provenance=null;try{provenance=JSON.parse(claims[0].provenance_json);}catch{provenance=null;}
  checks.claim=claims[0].film_id===filmId&&claims[0].trusted===1&&claims[0].conflicting===0&&provenance?.source==='ratings_alias_bridge'&&String(provenance?.tmdb)===pair.tmdb&&provenance?.adr==='0184';
 }
 if(written){
  const {digest,requestId}=await receiptIdentity({pair,filmId,event});
  const receipt=await one(db,'SELECT request_id,operation,origin,target_kind,target_id,content_digest,state,applied_revision,error_class FROM canonical_write_receipt WHERE request_id=?',[requestId]);
  const revisionNow=Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?",[filmId]))?.revision??-1);
  checks.receipt=!!receipt&&receipt.operation===FILM_EXTERNAL_IDS_OPERATION&&receipt.origin===LETTERBOXD_CLAIM_ORIGIN&&receipt.target_kind==='film'&&receipt.target_id===filmId&&receipt.content_digest===digest&&receipt.state==='applied'&&receipt.error_class==null&&Number(receipt.applied_revision)===revisionBefore+1&&revisionNow===revisionBefore+1;
 }
 const found=await catalogStartedFilm(env,pair.lid);
 checks.reader=found?.state==='found'&&found.film?.filmId===filmId&&String(found.film?.tmdb)===pair.tmdb;
 const plan=await planLetterboxdClaim(env,pair);
 checks.reproof=plan.verdict==='pass'&&plan.already===true&&plan.filmId===filmId;
 return checks;
}

// The one apply. `expected` carries the seven pins. Returns {mode:'apply', outcome:'complete'|'partial'|'unverified'|'refused', ...}; never a pair, a lid or a movie.
export async function applyHistorical(rawEnv,pairs,{expected={},confirmGo=false,requestId,now}={}){
 const refuse=(reason,extra={})=>({mode:'apply',outcome:'refused',reason,writerReportedWritten:0,claimsVerifiedWritten:0,receipts:{created:0},...extra});
 if(confirmGo!==true)return refuse('confirm_required');
 if(typeof requestId!=='string'||!REQUEST_ID.test(requestId))return refuse('invalid_request_id');
 const generation=value=>Number.isInteger(value)&&value>=0;
 if(!generation(expected.filmPersonGeneration)||!generation(expected.ratingsGeneration)||!generation(expected.ownerReviewGeneration))return refuse('invalid_expected_generation');
 if(!Number.isInteger(expected.schemaVersion)||expected.schemaVersion<1)return refuse('invalid_expected_schema_version');
 if(!['open','held'].includes(expected.ownerReviewWrites))return refuse('invalid_expected_owner_review_writes');
 if(!Number.isInteger(expected.count)||expected.count<1||expected.count>HISTORICAL_MAX)return refuse('invalid_expected_count');
 if(typeof expected.digest!=='string'||!HEX64.test(expected.digest))return refuse('invalid_expected_digest');
 const {env,budget}=withBounds(rawEnv,pairs.length);
 const db=database(env);
 const first=await inspect(env,pairs);
 if(first.decision!=='eligible')return refuse('not_eligible',publicView(first));
 const mismatched=PIN_NAMES.filter(name=>first.expect[name]!==expected[name]);
 if(mismatched.length)return refuse('pins_mismatch',{mismatched,...publicView(first)});
 const frozen=first.markers;
 const holds=async()=>{try{return sameMarkers(frozen,await readMarkers(env,db));}catch{return false;}};
 if(!(await holds()))return refuse('state_moved',publicView(first));
 const filmIds=first.results.map(item=>item.filmId);
 const event='historical:'+requestId+':'+first.expect.digest.slice(0,16);
 const at=(typeof now==='function'?now:()=>now||new Date().toISOString())();
 const clock=()=>at;
 let before;
 try{before=[];for(const [index,pair] of pairs.entries())before.push(await targetState(db,pair,filmIds[index]));}
 catch(error){return refuse(controlled(error?.code||'film_person_unavailable'));}
 const identities=[];
 for(const [index,pair] of pairs.entries())identities.push(await receiptIdentity({pair,filmId:filmIds[index],event}));
 const counts={written:0,already:0,refused:0,unknown:0,deferred:0,failed:0,notAttempted:0};
 const states=[];let stopped=null;
 for(const [index,pair] of pairs.entries()){
  if(stopped){counts.notAttempted++;states.push('not_attempted');continue;}
  try{
   if(!(await holds())){stopped='state_moved';counts.notAttempted++;states.push('not_attempted');continue;}
  }catch{stopped='fence_unreadable';counts.notAttempted++;states.push('not_attempted');continue;}
  try{
   const result=await applyLetterboxdClaim(env,{event,lid:pair.lid,tmdb:pair.tmdb,now:clock,expectedFilmId:filmIds[index],noReplay:true,approvedPins:pinsOf(frozen,{movie:pair.tmdb,filmId:filmIds[index],requestId:identities[index].requestId})});
   const state=['written','already','refused','unknown'].includes(result.state)?result.state:'deferred';
   counts[state]++;states.push(state);
   if(state!=='written'&&state!=='already')stopped='previous_pair_not_proved';
  }catch(error){counts.failed++;states.push('failed');stopped='previous_pair_failed';}
 }
 // The STRICT readback. Every pair this run proved is verified; the markers are fenced AFTER all reads; any unreadable proof makes the outcome `unverified`.
 let readback='complete';
 const verified=[];
 for(const [index,pair] of pairs.entries()){
  if(states[index]!=='written'&&states[index]!=='already')continue;
  try{verified.push({index,checks:await verifyPair(env,db,{pair,filmId:filmIds[index],revisionBefore:before[index].revision,written:states[index]==='written',event})});}
  catch{readback='incomplete';}
 }
 const after=[];
 try{for(const [index,pair] of pairs.entries())after.push(await targetState(db,pair,filmIds[index]));}catch{readback='incomplete';}
 let markersHold=false;
 try{markersHold=await holds();}catch{readback='incomplete';}
 const proved=counts.written+counts.already;
 // A vacuous pass is no pass: at least one pair must have been proved, every proved pair must have been verified, and every check of every verified pair must hold.
 const allChecks=proved>0&&verified.length===proved&&verified.every(item=>Object.values(item.checks).every(value=>value===null||value===true));
 let collateral=null;
 if(after.length===pairs.length){
  const exact=pairs.every((pair,index)=>effectsExact(before[index],after[index],{wrote:states[index]==='written',pair}));
  const receiptsCreated=pairs.reduce((sum,pair,index)=>sum+(after[index].receiptIds.length-before[index].receiptIds.length),0);
  collateral={scope:'per-target',exact,receiptsCreated};
 }
 const complete=readback==='complete'&&proved===pairs.length&&allChecks&&markersHold&&collateral?.exact===true;
 // `partial`: the run stopped before every pair was proved. `unverified`: every pair was proved by the writer, but the readback is not fully clean (an unreadable read, a failed check, a moved marker, an inexact effect).
 const outcome=complete?'complete':proved===pairs.length?'unverified':'partial';
 const claimsVerifiedWritten=readback==='complete'?verified.filter(item=>states[item.index]==='written'&&item.checks.claim===true&&item.checks.receipt===true).length:null;
 return {mode:'apply',outcome,writerReportedWritten:counts.written,claimsVerifiedWritten,receipts:{created:collateral?.receiptsCreated??null},requestId,digest:first.expect.digest,counts,
  readback:{status:readback,verified:verified.length,expected:proved,checks:verified.length&&proved>0?{claim:verified.every(item=>item.checks.claim),receipt:verified.every(item=>item.checks.receipt!==false),reader:verified.every(item=>item.checks.reader),reproof:verified.every(item=>item.checks.reproof)}:null,markersHold,collateral},
  reads:budget.report(),markers:frozen};
}

export async function dryRun(env,pairs){
 const inspected=await inspect(env,pairs);
 return {mode:'dry_run',sideEffects:'none',...publicView(inspected)};
}

// The allowlist file is private: a regular file (not a link) outside the repository.
export function readAllowlistFile(file,root=ROOT){
 const resolved=path.resolve(file);
 let real;
 try{real=fs.realpathSync(resolved);}catch{throw new HistoricalStop('allowlist_unreadable');}
 const realRoot=fs.realpathSync(root);
 if(real===realRoot||real.startsWith(realRoot+path.sep))throw new HistoricalStop('allowlist_inside_repository');
 if(fs.lstatSync(resolved).isSymbolicLink()||!fs.statSync(real).isFile())throw new HistoricalStop('allowlist_not_a_regular_file');
 return fs.readFileSync(real,'utf8');
}

function parseArgs(argv){
 const args=argv.slice(2),value=name=>{const at=args.indexOf(name);return at>=0?args[at+1]:undefined;};
 const known=new Set(['--allowlist','--apply','--confirm-go','--request-id','--expected-film-person-generation','--expected-ratings-generation','--expected-schema-version','--expected-owner-review-generation','--expected-owner-review-writes','--expected-count','--expected-digest']);
 for(const arg of args)if(arg.startsWith('--')&&!known.has(arg))throw new HistoricalStop('unknown_option');
 const integer=name=>{const v=value(name);return v!=null&&/^\d+$/.test(v)?Number(v):undefined;};
 return {
  allowlist:value('--allowlist'),apply:args.includes('--apply'),confirmGo:args.includes('--confirm-go'),requestId:value('--request-id'),
  expected:{filmPersonGeneration:integer('--expected-film-person-generation'),ratingsGeneration:integer('--expected-ratings-generation'),schemaVersion:integer('--expected-schema-version'),ownerReviewGeneration:integer('--expected-owner-review-generation'),ownerReviewWrites:value('--expected-owner-review-writes'),count:integer('--expected-count'),digest:value('--expected-digest')},
 };
}

async function openProductionBinding(env,fetchImpl){
 const {createD1Adapter}=await import('./d1-backfill.mjs');
 const {productionTarget,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,OperatorStop}=await import('./published-epg-production.mjs');
 const ctx={writeState:'none'};
 const adapter=await trackWrites(createD1Adapter({target:productionTarget(env),databaseId:PRODUCTION_DATABASE_ID,fetchImpl,retries:0}),ctx);
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
 return {binding:await strictBinding(adapter),ctx};
}

// Exit codes: 0 dry run or `complete`; 2 invalid input; 3 nothing written (`refused`); 4 `partial` (a claim or receipt may be written, the run stopped); 5 `unverified` or write state unknown; 1 any other failure.
export const EXIT={ok:0,input:2,notWritten:3,partial:4,unknown:5,failed:1};
export async function main({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,print=text=>process.stdout.write(text+'\n'),openBinding=openProductionBinding,readFile=readAllowlistFile}={}){
 let options,pairs,ctx=null;
 try{options=parseArgs(argv);if(!options.allowlist)throw new HistoricalStop('allowlist_required');pairs=parseAllowlist(readFile(options.allowlist));}
 catch(error){print(JSON.stringify({error:error instanceof HistoricalStop?error.reason:'invalid_input'}));return EXIT.input;}
 try{
  const opened=await openBinding(env,fetchImpl);
  ctx=opened.ctx;
  const target={DB:opened.binding};
  const out=options.apply?await applyHistorical(target,pairs,options):await dryRun(target,pairs);
  if(options.apply)out.writeState=writeStateOf(ctx);
  print(JSON.stringify(out,null,1));
  if(out.mode!=='apply'||out.outcome==='complete')return EXIT.ok;
  if(out.outcome==='refused')return EXIT.notWritten;
  return out.outcome==='unverified'||writeStateOf(ctx)==='unknown'?EXIT.unknown:EXIT.partial;
 }catch(error){
  const state=writeStateOf(ctx);
  print(JSON.stringify({error:controlled(error?.reason||error?.code),writeState:state,next:state==='none'?null:'run dry_run to read back; never repeat apply'}));
  if(state==='none')return error instanceof HistoricalStop?EXIT.input:Number.isInteger(error?.exit)?error.exit:EXIT.failed;
  return state==='committed'?EXIT.partial:state==='unknown'?EXIT.unknown:EXIT.failed;
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(code=>{process.exitCode=code;});
