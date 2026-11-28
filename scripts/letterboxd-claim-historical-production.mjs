#!/usr/bin/env node
// AIR-653 (ADR 0184, AIR-652): the owner-run operator of the trusted `letterboxd` claims of the HISTORICAL bridge-only pointer cohort. DORMANT: merging it authorizes nothing.
//
// WHAT IT IS: a narrow caller of the EXISTING writer. Every claim goes through `applyLetterboxdClaim` (the fenced `film_external_ids` unit in `addOnly` mode with its receipt,
// revision compare-and-swap and write-time guards) with a fresh proof from the stores at write time. It adds no writer and writes no table of its own.
// WHAT IT IS NOT: the published-programme backfill (`letterboxd_claim_backfill` derives only `published_epg_member` candidates and caps a call at 12 pairs, so its pins do not authorize
// this cohort), a cohort discovery (the pairs come from the owner's PRIVATE allowlist, the output of the bounded capture `letterboxd-claim-cohort-preflight-production.mjs`), an admission
// change or a key renaming. The repository and every output hold counts, reasons, digests and generations, never a lid, movie id or Film id.
//
// dry_run (default, read-only): validates the allowlist, reads the two authority markers, verifies the two required indexes, proves every pair again (the unchanged planner, plus the
// all-archives witness: ANY admission row of the movie blocks) and prints the decision and the pins of an apply: the Film/Person generation, the Ratings generation, the count and the
// digest of the sorted `lid:tmdb` lines.
// apply (`--apply --confirm-go --request-id <id>` plus the four `--expected-*` pins of a dry_run): derives everything AGAIN, refuses with zero writes on any difference, checks the frozen
// markers once more before the first write and before every pair, then writes ONE pair after another. Inside each fenced batch the writer asserts its own guards PLUS three of ours:
// the frozen Film/Person generation, the frozen Ratings generation and the absence of any admission row of that movie. The run stops at the first pair that is not proved: no retry, no
// attempt on the rest. A repeat of the same request finds the claims stored and writes nothing. Then it reads back: the reader that answered `404 Unknown film` finds each proved pair,
// nothing else is still missing, and the rows that must not move did not move.
// At most LETTERBOXD_CLAIM_UNIT_CAP pairs (the writer's own unit cap) per run; a larger cohort is several runs, each with its own allowlist file, pins and request id under the owner's GO.
// Run it between Ratings Sync slots: the Ratings generation moves with every natural Ratings write, and a moved pin refuses the run with zero writes.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LETTERBOXD_CLAIM_UNIT_CAP,applyLetterboxdClaim,planLetterboxdClaim} from '../src/canonical-letterboxd-claim.js';
import {cohortDigest,findDuplicateTargets} from '../src/letterboxd-claim-backfill.js';
import {catalogStartedFilm} from '../src/canonical-catalog-reader.js';
import {database,failed,many,one,readAuthority} from '../src/film-person-authority.js';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const HISTORICAL_MAX=LETTERBOXD_CLAIM_UNIT_CAP;
export const REQUEST_ID=/^[A-Za-z0-9_-]{8,64}$/;
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const TMDB=/^[1-9]\d{0,11}$/;
const HEX64=/^[0-9a-f]{64}$/;
const COUNT_TABLES=['film_external_id','film_alias','ratings_view','started_mark'];
const REQUIRED_INDEXES=['ratings_view_fact_key','tmdb_retirement_decision_movie'];
export const PIN_NAMES=['filmPersonGeneration','ratingsGeneration','count','digest'];

export class HistoricalStop extends Error{constructor(reason,details={}){super(reason);this.name='HistoricalStop';this.reason=reason;this.details=details;}}
const controlled=value=>typeof value==='string'&&/^[a-z0-9_:.-]{1,80}$/.test(value)?value:'unclassified';

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

async function ratingsMarker(db){
 const row=await one(db,'SELECT mode,cutover,generation FROM ratings_domain_authority WHERE id=1');
 return row?{mode:row.mode,cutover:row.cutover,generation:Number(row.generation)}:null;
}
// The two authorities of the frozen snapshot, read as one record.
async function readMarkers(env,db){
 const gate=await readAuthority(env);
 return {filmPerson:{state:gate.state,generation:Number(gate.generation)},ratings:await ratingsMarker(db)};
}
const sameMarkers=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const guardsOf=(markers,movie)=>[
 {sql:"EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)",params:[markers.filmPerson.generation]},
 {sql:"EXISTS (SELECT 1 FROM ratings_domain_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)",params:[markers.ratings.generation]},
 // The conservative all-archives witness, asserted INSIDE the writer's fenced batch: any admission row of this movie, under any lid and any archive, refuses the write.
 {sql:'NOT EXISTS (SELECT 1 FROM film_rated_admission WHERE tmdb=?)',params:[movie]},
];

// Read-only. {decision:'eligible'|'already_current'|'unsafe'|'unknown', counts, blockers:[{reason,count}], markers, expect, results}. `results` and `markers` stay inside the trusted process.
export async function inspect(env,pairs){
 const db=database(env);
 const out={decision:'unsafe',counts:{pairs:pairs.length,would_write:0,already:0,refused:0,unknown:0,duplicate:0},blockers:[],markers:null,expect:null,results:[]};
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
 try{
  const present=await many(db,"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('ratings_view_fact_key','tmdb_retirement_decision_movie') LIMIT 4",[]);
  for(const name of REQUIRED_INDEXES)if(!present.some(row=>row.name===name)){bump('required_index_missing');return done('unsafe');}
 }catch(error){bump(controlled(error?.code||'film_person_unavailable'));return done('unknown');}
 let admitted;
 try{admitted=await many(db,'SELECT tmdb,source_code FROM film_rated_admission WHERE tmdb IN (SELECT value FROM json_each(?)) ORDER BY tmdb LIMIT ?',[JSON.stringify(pairs.map(pair=>pair.tmdb)),pairs.length*4+1]);}
 catch(error){bump(controlled(error?.code||'film_person_unavailable'));return done('unknown');}
 const resolved=[];
 for(const pair of pairs){
  if(admitted.some(row=>String(row.tmdb)===pair.tmdb)){out.counts.refused++;bump('inferred_admission_witness');out.results.push({...pair,state:'refused',reason:'inferred_admission_witness'});continue;}
  let plan;
  try{plan=await planLetterboxdClaim(env,pair);}
  catch(error){out.counts.unknown++;bump(controlled(error?.code||'unclassified'));out.results.push({...pair,state:'unknown',reason:controlled(error?.code||'unclassified')});continue;}
  if(plan.verdict==='pass'&&!plan.already){out.counts.would_write++;resolved.push({...pair,filmId:plan.filmId});out.results.push({...pair,state:'would_write'});}
  else if(plan.verdict==='pass'){out.counts.already++;bump('already_current');out.results.push({...pair,state:'already'});}
  else{out.counts.refused++;bump(plan.reason);out.results.push({...pair,state:'refused',reason:plan.reason});}
 }
 // One Film holds ONE trusted Letterboxd lid: two pairs on one Film (or one movie) cannot both be written, so the run is refused before any GO instead of leaving a partial one.
 const duplicated=findDuplicateTargets(resolved);
 if(duplicated.length){out.counts.duplicate=duplicated.length;bump('cohort_duplicate_target');}
 out.expect={filmPersonGeneration:markers.filmPerson.generation,ratingsGeneration:markers.ratings.generation,count:pairs.length,digest:await cohortDigest(pairs)};
 // The snapshot must still be the one read at the start; a moved marker makes every pin stale.
 try{if(!sameMarkers(markers,await readMarkers(env,db))){bump('state_moved_during_read');out.expect=null;return done('unknown');}}
 catch(error){bump(controlled(error?.code||'film_person_unavailable'));out.expect=null;return done('unknown');}
 if(out.counts.unknown)return done('unknown');
 if(out.counts.would_write===pairs.length&&!duplicated.length)return done('eligible');
 if(out.counts.already===pairs.length)return done('already_current');
 return done('unsafe');
}

const publicView=inspected=>({decision:inspected.decision,counts:inspected.counts,blockers:inspected.blockers,markers:inspected.markers,expect:inspected.expect});

async function sideCounts(db){
 const out={};
 for(const table of COUNT_TABLES){
  try{out[table]=Number((await one(db,'SELECT COUNT(*) AS n FROM '+table))?.n);}
  catch(error){if(/no such table/i.test(String(error?.message||error)))out[table]=null;else throw failed('film_person_unavailable',error);}
 }
 return out;
}

// The one apply. `expected` carries the four pins. Returns {mode:'apply', outcome:'complete'|'partial'|'refused', writes, counts, readback, ...}; never a pair, a lid or a movie.
export async function applyHistorical(env,pairs,{expected={},confirmGo=false,requestId,now}={}){
 const refuse=(reason,extra={})=>({mode:'apply',outcome:'refused',reason,writes:0,...extra});
 if(confirmGo!==true)return refuse('confirm_required');
 if(typeof requestId!=='string'||!REQUEST_ID.test(requestId))return refuse('invalid_request_id');
 const generation=value=>Number.isInteger(value)&&value>=0;
 if(!generation(expected.filmPersonGeneration)||!generation(expected.ratingsGeneration))return refuse('invalid_expected_generation');
 if(!Number.isInteger(expected.count)||expected.count<1||expected.count>HISTORICAL_MAX)return refuse('invalid_expected_count');
 if(typeof expected.digest!=='string'||!HEX64.test(expected.digest))return refuse('invalid_expected_digest');
 const db=database(env);
 const first=await inspect(env,pairs);
 if(first.decision!=='eligible')return refuse('not_eligible',publicView(first));
 const mismatched=PIN_NAMES.filter(name=>first.expect[name]!==expected[name]);
 if(mismatched.length)return refuse('pins_mismatch',{mismatched,...publicView(first)});
 // The pins are checked ONCE MORE immediately before the first write, and asserted again before every pair and (through the extra guards) inside every fenced batch.
 const frozen=first.markers;
 const holds=async()=>{try{return sameMarkers(frozen,await readMarkers(env,db));}catch{return false;}};
 if(!(await holds()))return refuse('state_moved',publicView(first));
 let before;
 try{before=await sideCounts(db);}catch(error){return refuse(controlled(error?.code||'film_person_unavailable'));}
 const event='historical:'+requestId+':'+first.expect.digest.slice(0,16);
 const counts={written:0,already:0,refused:0,unknown:0,deferred:0,failed:0,notAttempted:0};
 const states=[];let stopped=null;
 for(const pair of pairs){
  if(stopped){counts.notAttempted++;states.push('not_attempted');continue;}
  if(!(await holds())){stopped='state_moved';counts.notAttempted++;states.push('not_attempted');continue;}
  try{
   const result=await applyLetterboxdClaim(env,{event,lid:pair.lid,tmdb:pair.tmdb,now,extraGuards:guardsOf(frozen,pair.tmdb)});
   const state=['written','already','refused','unknown'].includes(result.state)?result.state:'deferred';
   counts[state]++;states.push(state);
   if(state!=='written'&&state!=='already')stopped='previous_pair_not_proved';
  }catch(error){counts.failed++;states.push('failed');stopped='previous_pair_failed';}
 }
 // Authoritative readback: the reader that served the 404 finds each proved pair, nothing is still missing, the markers did not move, and only film_external_id grew (by the claims written).
 let found=0;
 for(let at=0;at<pairs.length;at++){
  if(states[at]!=='written'&&states[at]!=='already')continue;
  try{if((await catalogStartedFilm(env,pairs[at].lid)).state==='found')found++;}catch{/* counted as not found */}
 }
 let after=null,remaining=null,markersHold=false;
 try{
  after=await sideCounts(db);
  markersHold=await holds();
  remaining=0;
  for(const pair of pairs){const plan=await planLetterboxdClaim(env,pair);if(!(plan.verdict==='pass'&&plan.already===true))remaining++;}
 }catch{/* reported as not read */}
 const delta={};
 for(const table of COUNT_TABLES)delta[table]=after&&before[table]!=null&&after[table]!=null?after[table]-before[table]:null;
 const proved=counts.written+counts.already;
 const unexpected=delta.film_external_id!==counts.written||delta.film_alias!==0||delta.ratings_view!==0||(delta.started_mark!==null&&delta.started_mark!==0);
 const complete=proved===pairs.length&&found===proved&&remaining===0&&markersHold&&!unexpected;
 return {mode:'apply',outcome:complete?'complete':'partial',writes:counts.written,requestId,digest:first.expect.digest,counts,readback:{found,remaining,markersHold,delta,unexpectedChange:unexpected},markers:frozen};
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
 const known=new Set(['--allowlist','--apply','--confirm-go','--request-id','--expected-film-person-generation','--expected-ratings-generation','--expected-count','--expected-digest']);
 for(const arg of args)if(arg.startsWith('--')&&!known.has(arg))throw new HistoricalStop('unknown_option');
 const integer=name=>{const v=value(name);return v!=null&&/^\d+$/.test(v)?Number(v):undefined;};
 return {
  allowlist:value('--allowlist'),apply:args.includes('--apply'),confirmGo:args.includes('--confirm-go'),requestId:value('--request-id'),
  expected:{filmPersonGeneration:integer('--expected-film-person-generation'),ratingsGeneration:integer('--expected-ratings-generation'),count:integer('--expected-count'),digest:value('--expected-digest')},
 };
}

async function openProductionBinding(env,fetchImpl){
 const {createD1Adapter}=await import('./d1-backfill.mjs');
 const {createPublishedBinding,productionTarget,trackProductionWrites,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,OperatorStop}=await import('./published-epg-production.mjs');
 const ctx={writeState:'none'};
 const adapter=trackProductionWrites(createD1Adapter({target:productionTarget(env),databaseId:PRODUCTION_DATABASE_ID,fetchImpl,retries:0}),ctx);
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
 return {binding:createPublishedBinding(adapter),ctx};
}

// Exit codes: 0 dry run or `complete`; 2 invalid input; 3 nothing written (`refused`); 4 `partial` (some claim written or a readback check failed); 5 write state unknown; 1 any other failure.
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
  return ctx?.writeState==='unknown'?EXIT.unknown:EXIT.partial;
 }catch(error){
  const state=ctx?.writeState??'none';
  print(JSON.stringify({error:controlled(error?.reason||error?.code),writeState:state,next:state==='none'?null:'run dry_run to read back; never repeat apply'}));
  if(state==='none')return error instanceof HistoricalStop?EXIT.input:Number.isInteger(error?.exit)?error.exit:EXIT.failed;
  return state==='committed'?EXIT.partial:state==='unknown'?EXIT.unknown:EXIT.failed;
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(code=>{process.exitCode=code;});
