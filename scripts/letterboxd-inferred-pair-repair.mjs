#!/usr/bin/env node
// AIR-559: one-record repair of ONE legacy inferred Letterboxd-to-TMDB pair in the D1 ratings facts, through the EXISTING RatingsD1 write path.
// The read-only audit of 23 Nov 2026 (docs/evidence/d1-migration/air-559-legacy-inferred-pair-audit-2026-11-23.md) detected one pair that the inferred import
// linked on a Diary-first record before the pair mark existed. The owner chose to mark that record so that the claim planner refuses the pair like every
// other inferred pair; this script adds the record's `inferredPairs` entry and changes nothing else.
//
// WHAT IT IS NOT: no generic operator, no new runtime writer, no R2 read, no direct SQL write. The pair (`--lid`, `--tmdb`) and the provenance archive
// (`--archive`) are supplied by the owner from the private audit output; the repository holds no private identifier. The output carries counts, hashes and
// verdicts only, never the lid, the movie id or the record key.
//
// dry_run (default, read-only): reads the ratings marker, the link index, the record, the D1 admission row and the canonical lid claims, and prints the
// decision and the pins of an apply: the ratings generation, the record etag, the link-index etag and the digest of the planned record.
//
// apply (`--apply --confirm-go --request-id <id>` plus the four `--expected-*` pins of a dry_run): re-reads everything, refuses on any pin difference, then
// makes ONE RatingsD1 `putOwned` call (never `casOwned`: no automatic rebase or retry). That one atomic D1 batch carries the existing fences (record etag CAS,
// `changes()` fence, marker `d1/open`, generation bump) and four extra guards asserted INSIDE the batch: the exact ratings generation, the link-index etag,
// the admission row with this lid, movie and archive, and the absence of any canonical `letterboxd` claim of the lid. A guard that no longer holds rolls the
// whole batch back (`refused_in_batch`, writes 0). Outcomes are exact: `applied` only when the batch committed AND every readback check passed;
// `committed_unverified` (writes 1) when the batch committed but a check failed, a later write replaced the record or the readback threw; `unknown`
// (writes unknown) when the batch failed or its response was lost after it was sent. Nothing is ever retried; run dry_run to read back.
// A merge of this script is not a GO: the owner's separate explicit GO on the dry_run pins is the authority for the single apply.
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {putOwned, readOwned, readRatingsAuthority} from '../src/ratings-d1.js';
import {planLetterboxdClaim} from '../src/canonical-letterboxd-claim.js';

export const LINKS_KEY='letterboxd/facts/links.json';
export const INFERRED_BASIS='original_title_exact_year_unique';
export const INFERRED_PAIRS_MAX=8;
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const TMDB=/^[1-9]\d{0,11}$/;
const HEX64=/^[0-9a-f]{64}$/;
const REQUEST_ID=/^[A-Za-z0-9_-]{8,64}$/;
const sha256=text=>createHash('sha256').update(text).digest('hex');
const recordKey=key=>'letterboxd/facts/films/'+key+'.json';
const db=env=>env&&typeof env.prepare==='function'?env:env?.DB;
async function first(env,sql,params=[]){return (await db(env).prepare(sql).bind(...params).first())??null;}
async function count(env,sql,params){return Number((await first(env,sql,params))?.c??0);}
const guard=(condition,params)=>['UPDATE ratings_domain_cas SET ok=CASE WHEN '+condition+' THEN 1 ELSE 0 END WHERE id=1',params];

export class RepairStop extends Error{constructor(reason,details={}){super(reason);this.name='RepairStop';this.reason=reason;this.details=details;}}

export function validateInput({lid,tmdb,archive}={}){
 if(typeof lid!=='string'||!LID.test(lid)||lid.startsWith('tmdb_'))throw new RepairStop('invalid_lid');
 if(typeof tmdb!=='string'||!TMDB.test(tmdb))throw new RepairStop('invalid_tmdb');
 if(typeof archive!=='string'||!HEX64.test(archive))throw new RepairStop('invalid_archive');
 return {lid,tmdb,archive};
}

function entryNames(entry,lid,tmdb){return !!entry&&typeof entry==='object'&&entry.letterboxd===lid&&String(entry.tmdb)===tmdb;}
function readableEntry(entry){return !!entry&&typeof entry==='object'&&!Array.isArray(entry)&&typeof entry.letterboxd==='string'&&entry.tmdb!=null;}

// The read-only proof of one repair. Returns {decision, reason?, pins?, plan?, facts} where decision is `eligible`, `already_marked` or `refused`.
// Throws RepairStop only for an unusable environment (marker not served, unreadable documents); every data condition is a typed decision.
export async function inspectRepair(env,input){
 const {lid,tmdb,archive}=validateInput(input);
 const authority=await readRatingsAuthority(db(env),env);
 if(!authority.ready)throw new RepairStop('ratings_not_open');
 const generation=authority.generation;
 const links=await readOwned(env,LINKS_KEY);
 if(!links.owned||!links.value||typeof links.value!=='object'||Array.isArray(links.value))throw new RepairStop('links_unreadable');
 const index=links.value;
 const refused=(reason,extra={})=>({decision:'refused',reason,generation,...extra});
 const key=index['letterboxd:'+lid];
 if(typeof key!=='string'||!key)return refused('lid_not_linked');
 if(index['tmdb:'+tmdb]!==key)return refused('pair_not_linked');
 for(const [alias,target] of Object.entries(index))if(target===key&&alias!=='letterboxd:'+lid&&alias!=='tmdb:'+tmdb)return refused('link_ambiguous');
 const doc=await readOwned(env,recordKey(key));
 const record=doc.value;
 if(!record||typeof record!=='object'||Array.isArray(record))return refused('record_absent');
 if(record.links?.letterboxd!==lid||String(record.links?.tmdb)!==tmdb)return refused('record_states_other_pair');
 if(record.redirectTo||record.migrating)return refused('record_not_settled');
 // The record must be stored in its canonical JSON form, so the planned document changes this one field and nothing else.
 if(sha256(JSON.stringify(record))!==doc.etag)return refused('record_not_canonical');
 const list=record.inferredPairs;
 if(list!==undefined&&!Array.isArray(list))return refused('inferred_pairs_unreadable');
 if((list||[]).some(entry=>!readableEntry(entry)))return refused('inferred_pairs_unreadable');
 if(record.identity!=null||(list||[]).some(entry=>entryNames(entry,lid,tmdb)))return {decision:'already_marked',reason:record.identity!=null?'record_identity':'pair_entry',generation};
 if((list||[]).length>=INFERRED_PAIRS_MAX)return refused('inferred_pairs_full');
 const admissions=await count(env,'SELECT COUNT(*) AS c FROM film_rated_admission WHERE source_code=? AND tmdb=? AND archive_sha256=?',[lid,tmdb,archive]);
 if(admissions!==1)return refused('admission_not_matched');
 const claims=await count(env,"SELECT COUNT(*) AS c FROM film_external_id WHERE scheme='letterboxd' AND value=?",[lid]);
 if(claims!==0)return refused('lid_claim_exists');
 const next={...record,inferredPairs:[...(list||[]),{kind:'inferred',basis:INFERRED_BASIS,sourceRef:archive,letterboxd:lid,tmdb}]};
 const planDigest=sha256(JSON.stringify(next));
 return {decision:'eligible',generation,pins:{generation,recordEtag:doc.etag,linksEtag:links.etag,planDigest},plan:{key,next,before:record},facts:{priorEntries:(list||[]).length}};
}

async function viewRows(env,lid,tmdb){
 const rows=await db(env).prepare('SELECT alias_id,fact_key,watched,actual_rating,watchlist,rating_known FROM ratings_view WHERE alias_id=? OR alias_id=? ORDER BY alias_id').bind(lid,'tmdb_'+tmdb).all();
 return JSON.stringify(rows.results||[]);
}
async function plannerVerdict(env,lid,tmdb){
 try{const plan=await planLetterboxdClaim(env,{lid,tmdb});return {verdict:plan.verdict,reason:plan.reason};}
 catch(error){return {verdict:'error',reason:error?.code||'unclassified'};}
}

// Sanitized report of a decision: no lid, movie id or record key.
export function reportOf(result){
 const out={decision:result.decision,reason:result.reason??null,ratingsGeneration:result.generation??null};
 if(result.pins)out.expect={...result.pins};
 if(result.facts)out.facts={...result.facts};
 return out;
}

export async function dryRun(env,input){
 const result=await inspectRepair(env,input);
 const {lid,tmdb}=validateInput(input);
 return {mode:'dry_run',sideEffects:'none',...reportOf(result),planner:await plannerVerdict(env,lid,tmdb)};
}

// The single apply. `expected` = {generation, recordEtag, linksEtag, planDigest} from the owner-approved dry_run. Exactly one putOwned call, no retry.
export async function applyRepair(env,input,{expected,confirmGo,requestId}={}){
 const {lid,tmdb,archive}=validateInput(input);
 if(confirmGo!==true)throw new RepairStop('confirm_go_required');
 if(typeof requestId!=='string'||!REQUEST_ID.test(requestId))throw new RepairStop('invalid_request_id');
 if(!expected||!Number.isInteger(expected.generation)||![expected.recordEtag,expected.linksEtag,expected.planDigest].every(value=>typeof value==='string'&&HEX64.test(value)))throw new RepairStop('expected_pins_required');
 const result=await inspectRepair(env,input);
 if(result.decision!=='eligible')return {mode:'apply',requestId,outcome:'not_attempted',writes:0,...reportOf(result)};
 const moved=Object.keys(expected).filter(name=>result.pins[name]!==expected[name]);
 if(moved.length)return {mode:'apply',requestId,outcome:'not_attempted',writes:0,decision:'refused',reason:'pins_moved',moved,ratingsGeneration:result.generation};
 const viewBefore=await viewRows(env,lid,tmdb);
 const extra=[
  guard("(SELECT COUNT(*) FROM ratings_domain_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)=1",[expected.generation]),
  guard('(SELECT COUNT(*) FROM ratings_document WHERE key=? AND part=0 AND etag=?)=1',[LINKS_KEY,expected.linksEtag]),
  guard('(SELECT COUNT(*) FROM film_rated_admission WHERE source_code=? AND tmdb=? AND archive_sha256=?)=1',[lid,tmdb,archive]),
  guard("(SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd' AND value=?)=0",[lid]),
 ];
 let saved;
 try{saved=await putOwned(env,recordKey(result.plan.key),expected.recordEtag,result.plan.next,{extra});}
 catch(error){
  // A read-back that threw after a committed batch is a write, not an unknown: never report it as zero writes.
  if(error?.ratingsCommitted===true)return {mode:'apply',requestId,outcome:'committed_unverified',writes:1,reason:'putowned_readback_failed:'+(error.code||'unclassified'),next:'run dry_run to read back; never repeat apply'};
  return {mode:'apply',requestId,outcome:'unknown',writes:null,reason:error?.code||'unclassified',next:'run dry_run to read back; never repeat apply'};
 }
 if(!saved?.owned)return {mode:'apply',requestId,outcome:'unknown',writes:null,reason:'ratings_not_owned',next:'run dry_run to read back; never repeat apply'};
 if(saved.refused===true)return {mode:'apply',requestId,outcome:'refused_in_batch',writes:0,reason:'fence_or_guard',next:'run dry_run; a new apply needs new pins and a new GO'};
 if(saved.committed===true)return {mode:'apply',requestId,outcome:'committed_unverified',writes:1,reason:'record_replaced_after_commit',next:'run dry_run to read back; never repeat apply'};
 if(!saved.saved)return {mode:'apply',requestId,outcome:'unknown',writes:null,reason:'unclassified_save_result',next:'run dry_run to read back; never repeat apply'};
 // The batch committed and the record reads back as planned; `applied` is reported only after every acceptance check holds.
 let checked;
 try{checked=await readback(env,{lid,tmdb,archive,result,viewBefore});}
 catch(error){return {mode:'apply',requestId,outcome:'committed_unverified',writes:1,reason:'readback_failed:'+(error?.code||'unclassified'),next:'run dry_run to read back; never repeat apply'};}
 if(!checked.ok)return {mode:'apply',requestId,outcome:'committed_unverified',writes:1,reason:'readback_check_failed',readback:checked,next:'run dry_run to read back; never repeat apply'};
 return {mode:'apply',requestId,outcome:'applied',writes:1,readback:checked};
}

// Authoritative readback after an applied batch: the stored record equals the plan (only `inferredPairs` grew by this entry), the generation moved by one,
// the link index, the view rows and the canonical lid claims are unchanged, and the planner now refuses the pair.
export async function readback(env,{lid,tmdb,archive,result,viewBefore}){
 const doc=await readOwned(env,recordKey(result.plan.key));
 const links=await readOwned(env,LINKS_KEY);
 const authority=await readRatingsAuthority(db(env),env);
 const stored=doc.value||{};
 const {inferredPairs:_after,...restAfter}=stored;
 const {inferredPairs:_before,...restBefore}=result.plan.before;
 const entries=Array.isArray(stored.inferredPairs)?stored.inferredPairs:[];
 const checks={
  recordEqualsPlan:doc.etag===result.pins.planDigest,
  otherFieldsUnchanged:JSON.stringify(restAfter)===JSON.stringify(restBefore),
  entryAdded:entries.length===result.facts.priorEntries+1&&entryNames(entries[entries.length-1],lid,tmdb)&&entries[entries.length-1].sourceRef===archive,
  generationPlusOne:authority.ready&&authority.generation===result.generation+1,
  linksUnchanged:links.etag===result.pins.linksEtag,
  viewUnchanged:(await viewRows(env,lid,tmdb))===viewBefore,
  lidClaimsZero:(await count(env,"SELECT COUNT(*) AS c FROM film_external_id WHERE scheme='letterboxd' AND value=?",[lid]))===0,
 };
 const planner=await plannerVerdict(env,lid,tmdb);
 checks.plannerRefuses=planner.verdict==='not_proved'&&planner.reason==='ratings_link_inferred';
 return {ok:Object.values(checks).every(Boolean),checks,planner};
}

function parseArgs(argv){
 const args=argv.slice(2),value=name=>{const at=args.indexOf(name);return at>=0?args[at+1]:undefined;};
 const known=new Set(['--lid','--tmdb','--archive','--apply','--confirm-go','--request-id','--expected-generation','--expected-record-etag','--expected-links-etag','--expected-plan-digest']);
 for(const arg of args)if(arg.startsWith('--')&&!known.has(arg))throw new RepairStop('unknown_option');
 const generation=value('--expected-generation');
 return {
  input:{lid:value('--lid'),tmdb:value('--tmdb'),archive:value('--archive')},
  apply:args.includes('--apply'),confirmGo:args.includes('--confirm-go'),requestId:value('--request-id'),
  expected:{generation:generation!=null&&/^\d+$/.test(generation)?Number(generation):undefined,recordEtag:value('--expected-record-etag'),linksEtag:value('--expected-links-etag'),planDigest:value('--expected-plan-digest')},
 };
}

async function openProductionBinding(env,fetchImpl){
 const {createD1Adapter}=await import('./d1-backfill.mjs');
 const {createPublishedBinding,productionTarget,trackProductionWrites,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,OperatorStop}=await import('./published-epg-production.mjs');
 const ctx={writeState:'none'};
 const adapter=trackProductionWrites(createD1Adapter({target:productionTarget(env),databaseId:PRODUCTION_DATABASE_ID,fetchImpl}),ctx);
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
 return {binding:createPublishedBinding(adapter),ctx};
}

// Exit codes: 0 dry run or `applied`; 2 invalid input; 3 nothing written (`not_attempted`, `refused_in_batch`); 4 `committed_unverified`; 5 `unknown`;
// 1 any other failure. Every apply answer, and every error after the connection was opened, carries the adapter's tracked `writeState`
// (`none`, `unknown` while a write is in flight or after it failed, `committed` once a write was proved).
export const EXIT={ok:0,input:2,notWritten:3,committedUnverified:4,unknown:5,failed:1};
export async function main({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,print=text=>process.stdout.write(text+'\n'),openBinding=openProductionBinding}={}){
 let options,ctx=null;
 try{options=parseArgs(argv);validateInput(options.input);}
 catch(error){print(JSON.stringify({error:error?.reason||'invalid_input'}));return EXIT.input;}
 try{
  const opened=await openBinding(env,fetchImpl);
  ctx=opened.ctx;
  const target={DB:opened.binding};
  const out=options.apply?await applyRepair(target,options.input,options):await dryRun(target,options.input);
  if(options.apply)out.writeState=ctx?.writeState??null;
  print(JSON.stringify(out,null,1));
  if(out.mode!=='apply'||out.outcome==='applied')return EXIT.ok;
  if(out.outcome==='committed_unverified')return EXIT.committedUnverified;
  if(out.outcome==='unknown')return EXIT.unknown;
  return EXIT.notWritten;
 }catch(error){
  const state=ctx?.writeState??'none';
  print(JSON.stringify({error:error?.reason||error?.code||'failed',writeState:state,next:state==='none'?null:'run dry_run to read back; never repeat apply'}));
  if(state==='none')return error instanceof RepairStop?EXIT.input:Number.isInteger(error?.exit)?error.exit:EXIT.failed;
  return state==='committed'?EXIT.committedUnverified:state==='unknown'?EXIT.unknown:EXIT.failed;
 }
}

if(process.argv[1]===fileURLToPath(import.meta.url))main().then(code=>{process.exitCode=code;});
