#!/usr/bin/env node
// AIR-653 (ADR 0184, AIR-652): the owner-run operator of the trusted `letterboxd` claims of the HISTORICAL bridge-only pointer cohort. DORMANT: merging it authorizes nothing.
//
// WHAT IT IS: a narrow caller of the EXISTING writer. Every claim goes through `applyLetterboxdClaim` (the fenced `film_external_ids` unit in `addOnly` mode, the receipt protocol of
// `receiptedWrite`, the revision compare-and-swap and the write-time guards) with a fresh proof at write time. It adds no writer and writes no table of its own.
// WHAT IT IS NOT: the published-programme backfill (`letterboxd_claim_backfill` derives only `published_epg_member` candidates and caps a call at 12 pairs, so its pins do not authorize this
// cohort), a cohort discovery (the pairs come from the owner's PRIVATE allowlist, the output of the bounded capture), an admission change or a key renaming. The repository and every output hold
// counts, reasons, digests and generations, never a lid, movie id or Film id.
//
// PROOF IS BOUNDED AND STRICT. dry_run reuses the accepted bounded capture (`preflight` of letterboxd-claim-cohort-preflight.mjs, on exactly the given pairs, the all-archives witness, one shared
// budget, the unchanged planner only on a private snapshot, a second pass that fences movement); the two required indexes are verified by their exact definitions. Every read of this operator
// is STRICT (a REST answer without its result array is an error, never an empty table), so an unreadable row can never become a negative proof: it is `unknown` and nothing is written.
// The live planner runs only inside the writer, at write time, for one pair at a time; before each pair the link-index document is measured against the AIR-647 caps, and the run is at most
// LETTERBOXD_CLAIM_UNIT_CAP pairs, so the writer's live reads per run are bounded by (pairs x the writer's planner passes x that capped document), not by the size of the store.
//
// APPROVAL FENCE. The approved pins (Film/Person generation, schema version, owner-review generation and writes, the Ratings generation, and per pair the absence of any admission row of the movie)
// are bound as `approvedPins` of the existing receipt protocol: they are asserted in the RESERVATION of the receipt and in the claim's batch, not only in the latter. A change of any of them before
// the reservation refuses the pair before a receipt exists. Any receipt of this origin for these Films that is not applied (a prior attempt) makes the cohort `unsafe`: a partial or unknown outcome
// is never retried or replayed by this operator; recovery is a separately approved decision with a new dry run.
//
// dry_run (default, read-only): prints the decision and the seven pins of an apply: Film/Person generation, Ratings generation, schema version, owner-review generation, owner-review writes,
// count and the digest of the sorted `lid:tmdb` lines (the capture's `candidateDigest`).
// apply (`--apply --confirm-go --request-id <id>` plus the seven `--expected-*` pins): derives everything again, refuses with zero writes on any difference, checks the frozen markers before the first
// write and before every pair, writes ONE pair after another and stops at the first that is not proved. Then a STRICT readback of every pair (see `verifyPair`); any unreadable proof is `unverified`,
// never `complete`; the final marker fence runs AFTER all reads.
// WRITES ARE TWO KINDS, reported separately: claim rows (`claimsWritten`) and receipt rows (`receipts`): a pair refused inside the claim batch can still leave its reserved receipt.
// At most LETTERBOXD_CLAIM_UNIT_CAP pairs per run (the writer's own unit cap); a larger cohort is several runs, each with its own allowlist file, pins and request id under the owner's GO.
// Run it between Ratings Sync slots: the Ratings generation moves with every natural Ratings write, and a moved pin refuses the run with zero writes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LETTERBOXD_CLAIM_UNIT_CAP,LETTERBOXD_CLAIM_ORIGIN,applyLetterboxdClaim,planLetterboxdClaim,claimExternalIds} from '../src/canonical-letterboxd-claim.js';
import {cohortDigest} from '../src/letterboxd-claim-backfill.js';
import {catalogStartedFilm} from '../src/canonical-catalog-reader.js';
import {FILM_EXTERNAL_IDS_OPERATION,filmExternalIdsDigest} from '../src/canonical-film-external-ids-producer.js';
import {producerRequestId} from '../src/canonical-producer-adapters.js';
import {LINK_DOCUMENT_MAX_PARTS,LINK_DOCUMENT_MAX_BYTES} from '../src/film-aggregate.js';
import {database,many,one,readAuthority} from '../src/film-person-authority.js';
import {preflight,DEFAULT_CAPS} from './letterboxd-claim-cohort-preflight.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const HISTORICAL_MAX=LETTERBOXD_CLAIM_UNIT_CAP;
export const REQUEST_ID=/^[A-Za-z0-9_-]{8,64}$/;
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const TMDB=/^[1-9]\d{0,11}$/;
const HEX64=/^[0-9a-f]{64}$/;
const LINKS_KEY='letterboxd/facts/links.json';
const ALL_ARCHIVES={invariant:'diary_first_lb_record_with_inferred_import_admission',allArchives:true};
const COUNT_TABLES=['film_external_id','film_alias','ratings_view','started_mark'];
export const PIN_NAMES=['filmPersonGeneration','ratingsGeneration','schemaVersion','ownerReviewGeneration','ownerReviewWrites','count','digest'];

export class HistoricalStop extends Error{constructor(reason,details={}){super(reason);this.name='HistoricalStop';this.reason=reason;this.details=details;}}
const controlled=value=>typeof value==='string'&&/^[a-z0-9_:.-]{1,80}$/.test(value)?value:'unclassified';

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

// The authorities of the frozen snapshot, read as one record (strict reads; a missing row is a missing authority, never a default).
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
// The approved pins of one pair, for the receipt protocol (see approvedPinsOf in src/canonical-mutations.js): the fixed Film/Person, schema and owner-review pins plus two extra conditions asserted in the SAME
// batches: the frozen Ratings generation and the conservative all-archives witness (any admission row of this movie, under any lid and archive, refuses).
const pinsOf=(markers,movie)=>({
 filmPersonGeneration:markers.filmPerson.generation,schemaVersion:markers.schema.version,ownerReviewGeneration:markers.ownerReview.generation,ownerReviewWrites:markers.ownerReview.writes,
 guards:[
  {sql:"EXISTS (SELECT 1 FROM ratings_domain_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)",params:[markers.ratings.generation]},
  {sql:'NOT EXISTS (SELECT 1 FROM film_rated_admission WHERE tmdb=?)',params:[movie]},
 ],
});
const pinValues=(markers,count,digest)=>({filmPersonGeneration:markers.filmPerson.generation,ratingsGeneration:markers.ratings.generation,schemaVersion:markers.schema.version,ownerReviewGeneration:markers.ownerReview.generation,ownerReviewWrites:markers.ownerReview.writes,count,digest});

// Read-only, bounded, strict. {decision:'eligible'|'already_current'|'unsafe'|'unknown', counts, blockers:[{reason,count}], markers, expect, results, work}. `results` and `markers` stay inside the trusted process.
export async function inspect(env,pairs){
 const db=database(env);
 const out={decision:'unsafe',counts:{pairs:pairs.length,would_write:0,already:0,refused:0,unknown:0,duplicate:0},blockers:[],markers:null,expect:null,results:[],work:null};
 const reasons={};
 const bump=reason=>{reasons[reason]=(reasons[reason]||0)+1;};
 const done=decision=>{out.decision=decision;out.blockers=Object.keys(reasons).sort().map(reason=>({reason,count:reasons[reason]}));return out;};
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
  try{prior=await many(db,"SELECT request_id,state FROM canonical_write_receipt WHERE target_kind='film' AND target_id IN (SELECT value FROM json_each(?)) AND origin=? AND state<>'applied' LIMIT ?",[JSON.stringify(filmIds),LETTERBOXD_CLAIM_ORIGIN,pairs.length*4+1]);}
  catch(error){bump(controlled(error?.code||'film_person_unavailable'));return done('unknown');}
  if(prior.length)for(let at=0;at<prior.length;at++)bump('prior_receipt_unresolved');
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

const publicView=inspected=>({decision:inspected.decision,counts:inspected.counts,blockers:inspected.blockers,markers:inspected.markers,expect:inspected.expect,work:inspected.work});

// Per-target and per-table state around the run. Counts are a coarse tripwire; the exact evidence is the per-target state and the per-pair verification below.
async function sideState(db,filmIds){
 const tables={};
 for(const table of COUNT_TABLES){
  const present=await one(db,"SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?",[table]);
  tables[table]=present?Number((await one(db,'SELECT COUNT(*) AS n FROM '+table))?.n):'absent';
 }
 const revisions={},receipts={};
 for(const id of filmIds){
  revisions[id]=Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?",[id]))?.revision??0);
  receipts[id]=(await many(db,"SELECT state FROM canonical_write_receipt WHERE target_kind='film' AND target_id=? AND origin=? LIMIT 20",[id,LETTERBOXD_CLAIM_ORIGIN])).map(row=>row.state).sort().join(',');
 }
 return {tables,revisions,receipts};
}

// The STRICT readback of one pair. Every field is read from the store; a throw is not a pass (the caller reports `unverified`). For a pair this run WROTE the exact applied receipt is checked too: the request id
// the writer derives from (origin, operation, event, target, content digest), the operation, origin, target, the content digest, state `applied` and the applied revision (the Film's revision before the run plus one, equal to its
// revision now).
async function verifyPair(env,db,{pair,filmId,revisionBefore,written,event,at}){
 const checks={claim:false,receipt:written?false:null,reader:false,reproof:false};
 const claims=await many(db,"SELECT film_id,trusted,conflicting,provenance_json FROM film_external_id WHERE scheme='letterboxd' AND value=? LIMIT 3",[pair.lid]);
 if(claims.length===1){
  let provenance=null;try{provenance=JSON.parse(claims[0].provenance_json);}catch{provenance=null;}
  checks.claim=claims[0].film_id===filmId&&claims[0].trusted===1&&claims[0].conflicting===0&&provenance?.source==='ratings_alias_bridge'&&String(provenance?.tmdb)===pair.tmdb&&provenance?.adr==='0184';
 }
 if(written){
  const content=await filmExternalIdsDigest({id:filmId,at,schemes:['letterboxd'],addOnly:true,externalIds:claimExternalIds({lid:pair.lid,tmdb:pair.tmdb})});
  const requestId=await producerRequestId({origin:LETTERBOXD_CLAIM_ORIGIN,operation:FILM_EXTERNAL_IDS_OPERATION,event,target:{kind:'film',id:filmId},digest:content});
  const receipt=await one(db,'SELECT request_id,operation,origin,target_kind,target_id,content_digest,state,applied_revision,error_class FROM canonical_write_receipt WHERE request_id=?',[requestId]);
  const revisionNow=Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?",[filmId]))?.revision??-1);
  checks.receipt=!!receipt&&receipt.operation===FILM_EXTERNAL_IDS_OPERATION&&receipt.origin===LETTERBOXD_CLAIM_ORIGIN&&receipt.target_kind==='film'&&receipt.target_id===filmId&&receipt.content_digest===content&&receipt.state==='applied'&&receipt.error_class==null&&Number(receipt.applied_revision)===revisionBefore+1&&revisionNow===revisionBefore+1;
 }
 const found=await catalogStartedFilm(env,pair.lid);
 checks.reader=found?.state==='found'&&found.film?.filmId===filmId&&String(found.film?.tmdb)===pair.tmdb;
 const plan=await planLetterboxdClaim(env,pair);
 checks.reproof=plan.verdict==='pass'&&plan.already===true&&plan.filmId===filmId;
 return checks;
}

// The link-index document measured against the AIR-647 caps BEFORE each pair's live planner reads: strict, one statement.
export async function linkIndexWithinCaps(db){
 const row=await one(db,'SELECT COUNT(*) AS parts,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM ratings_document WHERE key=?',[LINKS_KEY]);
 return !!row&&Number(row.parts)>=1&&Number(row.parts)<=LINK_DOCUMENT_MAX_PARTS&&Number(row.bytes)<=LINK_DOCUMENT_MAX_BYTES;
}

// The one apply. `expected` carries the seven pins. Returns {mode:'apply', outcome:'complete'|'partial'|'unverified'|'refused', ...}; never a pair, a lid or a movie.
export async function applyHistorical(env,pairs,{expected={},confirmGo=false,requestId,now}={}){
 const refuse=(reason,extra={})=>({mode:'apply',outcome:'refused',reason,claimsWritten:0,receipts:{created:0},...extra});
 if(confirmGo!==true)return refuse('confirm_required');
 if(typeof requestId!=='string'||!REQUEST_ID.test(requestId))return refuse('invalid_request_id');
 const generation=value=>Number.isInteger(value)&&value>=0;
 if(!generation(expected.filmPersonGeneration)||!generation(expected.ratingsGeneration)||!generation(expected.ownerReviewGeneration))return refuse('invalid_expected_generation');
 if(!Number.isInteger(expected.schemaVersion)||expected.schemaVersion<1)return refuse('invalid_expected_schema_version');
 if(!['open','held'].includes(expected.ownerReviewWrites))return refuse('invalid_expected_owner_review_writes');
 if(!Number.isInteger(expected.count)||expected.count<1||expected.count>HISTORICAL_MAX)return refuse('invalid_expected_count');
 if(typeof expected.digest!=='string'||!HEX64.test(expected.digest))return refuse('invalid_expected_digest');
 const db=database(env);
 const first=await inspect(env,pairs);
 if(first.decision!=='eligible')return refuse('not_eligible',publicView(first));
 const mismatched=PIN_NAMES.filter(name=>first.expect[name]!==expected[name]);
 if(mismatched.length)return refuse('pins_mismatch',{mismatched,...publicView(first)});
 const frozen=first.markers;
 const holds=async()=>{try{return sameMarkers(frozen,await readMarkers(env,db));}catch{return false;}};
 if(!(await holds()))return refuse('state_moved',publicView(first));
 const filmIds=first.results.map(item=>item.filmId);
 let before;
 try{before=await sideState(db,filmIds);}catch(error){return refuse(controlled(error?.code||'film_person_unavailable'));}
 const event='historical:'+requestId+':'+first.expect.digest.slice(0,16);
 const at=(typeof now==='function'?now:()=>now||new Date().toISOString())();
 const clock=()=>at;
 const counts={written:0,already:0,refused:0,unknown:0,deferred:0,failed:0,notAttempted:0};
 const states=[];let stopped=null;
 for(const [index,pair] of pairs.entries()){
  if(stopped){counts.notAttempted++;states.push('not_attempted');continue;}
  try{
   if(!(await holds())){stopped='state_moved';counts.notAttempted++;states.push('not_attempted');continue;}
   if(!(await linkIndexWithinCaps(db))){stopped='link_index_over_caps';counts.notAttempted++;states.push('not_attempted');continue;}
  }catch{stopped='fence_unreadable';counts.notAttempted++;states.push('not_attempted');continue;}
  try{
   const result=await applyLetterboxdClaim(env,{event,lid:pair.lid,tmdb:pair.tmdb,now:clock,approvedPins:pinsOf(frozen,pair.tmdb)});
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
  try{verified.push({index,checks:await verifyPair(env,db,{pair,filmId:filmIds[index],revisionBefore:before.revisions[filmIds[index]],written:states[index]==='written',event,at})});}
  catch{readback='incomplete';}
 }
 let after=null;
 try{after=await sideState(db,filmIds);}catch{readback='incomplete';}
 let markersHold=false;
 try{markersHold=await holds();}catch{readback='incomplete';}
 const proved=counts.written+counts.already;
 const allChecks=verified.length===proved&&verified.every(item=>Object.values(item.checks).every(value=>value===null||value===true));
 let collateral=null;
 if(after){
  const tableDelta={};
  for(const table of COUNT_TABLES)tableDelta[table]=typeof before.tables[table]==='number'&&typeof after.tables[table]==='number'?after.tables[table]-before.tables[table]:before.tables[table]===after.tables[table]?0:null;
  // Exactly the effects of the existing writer, per target Film: for a written pair its revision +1 and one applied receipt; for every other Film of the run nothing.
  const targetsExact=pairs.every((pair,index)=>{
   const id=filmIds[index],wrote=states[index]==='written';
   const revisionOk=after.revisions[id]===before.revisions[id]+(wrote?1:0);
   const receiptsOk=wrote?after.receipts[id].split(',').filter(Boolean).length===before.receipts[id].split(',').filter(Boolean).length+1&&after.receipts[id].includes('applied'):after.receipts[id]===before.receipts[id];
   return revisionOk&&receiptsOk;
  });
  collateral={tableDelta,targetsExact,receiptsCreated:pairs.reduce((sum,pair,index)=>sum+(after.receipts[filmIds[index]].split(',').filter(Boolean).length-before.receipts[filmIds[index]].split(',').filter(Boolean).length),0)};
  collateral.exact=targetsExact&&tableDelta.film_external_id===counts.written&&tableDelta.film_alias===0&&tableDelta.ratings_view===0&&tableDelta.started_mark===0;
 }
 const complete=readback==='complete'&&proved===pairs.length&&allChecks&&markersHold&&collateral?.exact===true;
 // `partial`: the run stopped before every pair was proved. `unverified`: every pair was proved by the writer, but the readback is not fully clean (an unreadable read, a failed check, a moved marker, an inexact effect).
 const outcome=complete?'complete':proved===pairs.length?'unverified':'partial';
 return {mode:'apply',outcome,claimsWritten:counts.written,receipts:{created:collateral?.receiptsCreated??null},requestId,digest:first.expect.digest,counts,readback:{status:readback,verified:verified.length,expected:proved,checks:{claim:verified.every(item=>item.checks.claim),receipt:verified.every(item=>item.checks.receipt!==false),reader:verified.every(item=>item.checks.reader),reproof:verified.every(item=>item.checks.reproof)},markersHold,collateral},markers:frozen};
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
 const {productionTarget,trackProductionWrites,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,OperatorStop}=await import('./published-epg-production.mjs');
 const ctx={writeState:'none'};
 const adapter=trackProductionWrites(createD1Adapter({target:productionTarget(env),databaseId:PRODUCTION_DATABASE_ID,fetchImpl,retries:0}),ctx);
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
  if(options.apply)out.writeState=ctx?.writeState??null;
  print(JSON.stringify(out,null,1));
  if(out.mode!=='apply'||out.outcome==='complete')return EXIT.ok;
  if(out.outcome==='refused')return EXIT.notWritten;
  return out.outcome==='unverified'||ctx?.writeState==='unknown'?EXIT.unknown:EXIT.partial;
 }catch(error){
  const state=ctx?.writeState??'none';
  print(JSON.stringify({error:controlled(error?.reason||error?.code),writeState:state,next:state==='none'?null:'run dry_run to read back; never repeat apply'}));
  if(state==='none')return error instanceof HistoricalStop?EXIT.input:Number.isInteger(error?.exit)?error.exit:EXIT.failed;
  return state==='committed'?EXIT.partial:state==='unknown'?EXIT.unknown:EXIT.failed;
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(code=>{process.exitCode=code;});
