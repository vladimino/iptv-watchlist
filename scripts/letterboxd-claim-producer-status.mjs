#!/usr/bin/env node
// AIR-559: read-only status and readback of the canonical Letterboxd claim WRITER (ADR 0184), measured on its own, apart from the Ratings workflow.
// It reads D1 only: the two authority markers, the receipts of the claim unit (origin `letterboxd_claim`), the canonical `letterboxd` claims, the Diary
// identity document's `claim_pending` entries, and, for every claim the writer applied since `--since`, an authoritative re-proof (the claim planner must
// still answer `pass`/`already`) and the canonical Started reader (`catalogStartedFilm` must answer `found`). Output: counts and reasons only, never a lid,
// a movie id or a Film id. It sends no batch: the production binding it builds refuses every write before a request.
//
// Use: the activation preflight (baseline, without `--since`) and the readback after a natural producer pass (`--since <activation time, ISO UTC>`).
// The backfill of 21 Nov 2026 used the same origin; it is not repeated, so receipts created after the activation time are the producer's.
import {fileURLToPath} from 'node:url';
import {readOwned, readRatingsAuthority} from '../src/ratings-d1.js';
import {readAuthority} from '../src/film-person-authority.js';
import {LETTERBOXD_CLAIM_ACTIVATED, LETTERBOXD_CLAIM_ORIGIN, LETTERBOXD_CLAIM_SOURCE, planLetterboxdClaim} from '../src/canonical-letterboxd-claim.js';
import {catalogStartedFilm} from '../src/canonical-catalog-reader.js';

export const DIARY_IDENTITY_KEY='letterboxd/facts/scans/diary-identity.json';
export const CLAIM_PENDING='claim_pending';
export const CLAIM_PENDING_MAX_ATTEMPTS=6;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const STATES=['pending','applied','failed','unknown','abandoned'];
const db=env=>env&&typeof env.prepare==='function'?env:env?.DB;
async function all(env,sql,params=[]){return (await db(env).prepare(sql).bind(...params).all()).results||[];}
const bump=(map,key)=>{map[key]=(map[key]||0)+1;};
const source=json=>{try{return JSON.parse(json||'null')?.source??null;}catch{return 'unreadable';}};

export class StatusStop extends Error{constructor(reason){super(reason);this.name='StatusStop';this.reason=reason;}}

async function receiptStates(env,since){
 const rows=await all(env,'SELECT state, COUNT(*) AS c FROM canonical_write_receipt WHERE origin=?'+(since?' AND created_at>=?':'')+' GROUP BY state',since?[LETTERBOXD_CLAIM_ORIGIN,since]:[LETTERBOXD_CLAIM_ORIGIN]);
 const out=Object.fromEntries(STATES.map(state=>[state,0]));
 for(const row of rows)out[row.state]=Number(row.c);
 return out;
}

// For every Film the writer touched since `since`: the claim it holds, whether the claim's proof still holds and whether the Started reader finds it.
async function producerWrites(env,since,now){
 const targets=await all(env,"SELECT DISTINCT target_id FROM canonical_write_receipt WHERE origin=? AND state='applied' AND created_at>=? ORDER BY target_id",[LETTERBOXD_CLAIM_ORIGIN,since]);
 const out={films:targets.length,claimed:0,proofHolds:0,startedFound:0,problems:{}};
 for(const {target_id:filmId} of targets){
  const ids=await all(env,"SELECT scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE film_id=? AND scheme IN ('letterboxd','tmdb')",[filmId]);
  const lid=ids.find(row=>row.scheme==='letterboxd'&&Number(row.trusted)===1&&Number(row.conflicting)===0&&source(row.provenance_json)===LETTERBOXD_CLAIM_SOURCE);
  const tmdb=ids.find(row=>row.scheme==='tmdb'&&Number(row.trusted)===1&&Number(row.conflicting)===0);
  if(!lid){bump(out.problems,'no_bridge_claim_on_target');continue;}
  out.claimed++;
  if(!tmdb){bump(out.problems,'no_trusted_tmdb_claim');continue;}
  let plan;
  try{plan=await planLetterboxdClaim(env,{lid:String(lid.value),tmdb:String(tmdb.value)});}catch(error){bump(out.problems,'planner_'+(error?.code||'error'));continue;}
  if(plan.verdict==='pass'&&plan.already===true&&plan.filmId===filmId)out.proofHolds++;
  else bump(out.problems,'proof_'+plan.verdict+'_'+plan.reason);
  let started;
  try{started=await catalogStartedFilm(env,String(lid.value));}catch(error){bump(out.problems,'started_'+(error?.code||'error'));continue;}
  if(started?.state==='found'&&started.film?.filmId===filmId)out.startedFound++;
  else bump(out.problems,'started_'+(started?.state||'unknown'));
 }
 return out;
}

async function claimPending(env,now){
 const doc=await readOwned(env,DIARY_IDENTITY_KEY);
 if(!doc.owned)throw new StatusStop('ratings_not_owned');
 const films=doc.value?.films&&typeof doc.value.films==='object'?doc.value.films:{};
 const out={entries:0,atAttemptBound:0,due:0,attempts:{}};
 for(const entry of Object.values(films)){
  if(!entry||entry.reason!==CLAIM_PENDING)continue;
  out.entries++;
  const attempts=Number(entry.attempts)||0;
  bump(out.attempts,String(attempts));
  if(attempts>=CLAIM_PENDING_MAX_ATTEMPTS)out.atAttemptBound++;
  else if(Date.parse(entry.nextAttemptAt)<=now)out.due++;
 }
 return out;
}

export async function claimProducerStatus(env,{since=null,now=Date.now()}={}){
 if(since!=null&&(typeof since!=='string'||!ISO.test(since)||Number.isNaN(Date.parse(since))))throw new StatusStop('invalid_since');
 const ratings=await readRatingsAuthority(db(env),env);
 const filmPerson=await readAuthority(env).catch(error=>({state:'unreadable',reason:error?.code||'error'}));
 const claims=await all(env,"SELECT provenance_json, trusted, conflicting FROM film_external_id WHERE scheme='letterboxd'");
 const bySource={};
 let trusted=0;
 for(const row of claims){bump(bySource,source(row.provenance_json)??'(none)');if(Number(row.trusted)===1&&Number(row.conflicting)===0)trusted++;}
 return {
  checkoutGate:LETTERBOXD_CLAIM_ACTIVATED,
  authorities:{ratings:{mode:ratings.mode,cutover:ratings.cutover,generation:ratings.generation},filmPerson:{state:filmPerson.state,generation:filmPerson.generation??null}},
  receipts:{all:await receiptStates(env,null),since:since?await receiptStates(env,since):null},
  claims:{letterboxd:claims.length,trusted,bySource},
  producerWritesSince:since?await producerWrites(env,since,now):null,
  claimPending:await claimPending(env,now),
  since,
 };
}

function parseArgs(argv){
 const args=argv.slice(2);
 for(const arg of args)if(arg.startsWith('--')&&arg!=='--since')throw new StatusStop('unknown_option');
 const at=args.indexOf('--since');
 return {since:at>=0?args[at+1]:null};
}

// The production binding with every write refused before a request (this tool only reads).
async function openReadOnlyBinding(env,fetchImpl){
 const {createD1Adapter}=await import('./d1-backfill.mjs');
 const {createPublishedBinding,productionTarget,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,OperatorStop}=await import('./published-epg-production.mjs');
 const adapter=createD1Adapter({target:productionTarget(env),databaseId:PRODUCTION_DATABASE_ID,fetchImpl});
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
 const refuse=()=>{throw new StatusStop('write_refused');};
 const readOnly={get:(sql,params)=>adapter.get(sql,params),all:(sql,params)=>adapter.all(sql,params),readBatch:statements=>adapter.readBatch(statements),run:refuse,executeRendered:refuse,describe:()=>adapter.describe(),stats:adapter.stats};
 const binding=createPublishedBinding(readOnly);
 const batch=binding.batch.bind(binding);
 binding.batch=async statements=>{if(!statements.every(item=>/^\s*select\b/i.test(String(item?.text||''))))refuse();return batch(statements);};
 return binding;
}

export async function main({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,print=text=>process.stdout.write(text+'\n'),openBinding=openReadOnlyBinding}={}){
 try{
  const {since}=parseArgs(argv);
  if(since!=null&&!ISO.test(since))throw new StatusStop('invalid_since');
  const binding=await openBinding(env,fetchImpl);
  print(JSON.stringify({mode:'status',sideEffects:'none',...await claimProducerStatus({DB:binding},{since})},null,1));
  return 0;
 }catch(error){
  print(JSON.stringify({error:error?.reason||error?.code||'failed'}));
  return error instanceof StatusStop?2:Number.isInteger(error?.exit)?error.exit:1;
 }
}

if(process.argv[1]===fileURLToPath(import.meta.url))main().then(code=>{process.exitCode=code;});
