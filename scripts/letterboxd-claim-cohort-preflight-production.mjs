#!/usr/bin/env node
// AIR-653: the READ-ONLY, bounded production run of the historical bridge-only cohort preflight (AIR-652 design, scripts/letterboxd-claim-cohort-preflight.mjs).
// It reads production D1 through the AIR-647 counted database only (SELECT statements, charged to ONE shared budget before each statement, a statement the
// guard does not recognise as a single SELECT is refused), judges the captured rows with the UNCHANGED claim planner on a private sqlite snapshot, and
// repeats the capture and the discovery to fence movement. It writes nothing to D1 or R2, makes no Letterboxd or TMDB request, sets no flag, Task or lease
// and authorizes nothing: an `eligible_in_scope` key is not production proof and not a GO.
//
//   node scripts/letterboxd-claim-cohort-preflight-production.mjs --out <private file> [--archive <sha256>]... [--statements n] [--rows n] [--pointer-inspect n] [--candidates n]
//
// Credentials: D1_BACKFILL_ACCOUNT_ID and D1_BACKFILL_API_TOKEN (behind a proxy NODE_USE_ENV_PROXY=1). The target is pinned to the production account and
// database; the identity (uuid and name) is read back before the first statement. The printed report holds counts, reasons and digests only. The exact
// lid-to-movie result (the private allowlist of `eligible_in_scope` pairs) goes ONLY to `--out`, a file outside the repository, mode 600, never to a log.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createD1Adapter} from './d1-backfill.mjs';
import {createPublishedBinding,productionTarget,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME} from './published-epg-production.mjs';
import {preflight,DEFAULT_CAPS,WITNESS_INVARIANT} from './letterboxd-claim-cohort-preflight.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
// Hard ceilings: a flag can lower or raise a cap only up to these. They bound the work of one run (REST round trips and rows), not the data.
export const CAP_CEILINGS=Object.freeze({statements:2000,rows:60000,pointerInspect:20000,candidates:512});
const HEX64=/^[0-9a-f]{64}$/;

export function parseArgs(argv){
 const out={archives:[],out:null,caps:{}};
 const number=(name,value,ceiling)=>{const n=Number(value);if(!Number.isInteger(n)||n<1||n>ceiling)throw new Error('usage: '+name+' must be an integer from 1 to '+ceiling);return n;};
 for(let i=2;i<argv.length;i++){
  const flag=argv[i],value=argv[i+1];
  if(flag==='--archive'){if(!HEX64.test(String(value)))throw new Error('usage: --archive needs a 64-hex sha256');out.archives.push(value);i++;}
  else if(flag==='--out'){if(!value||value.startsWith('--'))throw new Error('usage: --out needs a path');out.out=value;i++;}
  else if(flag==='--statements'){out.caps.statements=number(flag,value,CAP_CEILINGS.statements);i++;}
  else if(flag==='--rows'){out.caps.rows=number(flag,value,CAP_CEILINGS.rows);i++;}
  else if(flag==='--pointer-inspect'){out.caps.pointerInspect=number(flag,value,CAP_CEILINGS.pointerInspect);i++;}
  else if(flag==='--candidates'){out.caps.candidates=number(flag,value,CAP_CEILINGS.candidates);i++;}
  else throw new Error('usage: unknown option '+flag);
 }
 if(!out.out)throw new Error('usage: --out <private file outside the repository> is required');
 return out;
}

// The private file must not live in the repository (or any of its subdirectories): the allowlist is never committed.
export function privatePath(file,root=ROOT){
 const resolved=path.resolve(file);
 if(resolved===root||resolved.startsWith(root+path.sep))throw new Error('usage: --out must be outside the repository');
 return resolved;
}

// Defense in depth below the AIR-647 counted database (which already refuses anything but a single SELECT): the TRANSPORT refuses any request body that is not one SELECT
// or WITH ... SELECT, and stops on any answer that reports a write. `stats` counts what actually went over the wire.
const FORBIDDEN=/\b(insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|reindex|pragma|begin|commit|rollback|savepoint|release)\b/i;
export function readOnlyTransport(fetchImpl,stats={requests:0,rowsRead:0,rowsWritten:0}){
 return async(url,init={})=>{
  const method=String(init.method||'GET').toUpperCase();
  if(method==='POST'){
   let body=null;try{body=JSON.parse(init.body);}catch{body=null;}
   const text=String(body?.sql??'').replace(/'(?:[^']|'')*'/g,"''").replace(/;\s*$/,'');
   if(!body||body.batch!==undefined||!/^\s*(?:with\b[\s\S]*?\)\s*)?select\b/i.test(text)||/;/.test(text)||FORBIDDEN.test(text))throw new Error('write_or_unknown_statement_refused');
  }else if(method!=='GET')throw new Error('write_or_unknown_statement_refused');
  stats.requests++;
  const response=await fetchImpl(url,init);
  if(method==='POST'){
   // Read the answer without consuming the caller's copy, and refuse any sign of a write.
   const payload=await response.clone().json().catch(()=>null);
   for(const item of Array.isArray(payload?.result)?payload.result:[]){
    stats.rowsRead+=Number(item?.meta?.rows_read||0);stats.rowsWritten+=Number(item?.meta?.rows_written||0);
    if(item?.meta?.changed_db===true||Number(item?.meta?.rows_written||0)>0)throw new Error('unexpected_write_reported');
   }
  }
  return response;
 };
}

// The sanitized report: counts, reasons and digests. Never a lid, movie, Film id, fact key, rating or document body.
export function sanitize(result,{archives,transport=null}){
 const byClass={};
 for(const item of result.results||[]){const key=item.state+' / '+item.reason;byClass[key]=(byClass[key]||0)+1;}
 return {
  decision:result.decision,reason:result.reason??null,coverage:result.coverage??null,moved:result.moved??null,detail:result.detail??null,
  counts:result.counts??null,byClassAndReason:byClass,sources:result.sources??null,multiplicity:result.multiplicity??null,
  work:result.work,readSetDigest:result.readSetDigest,sectionDigests:result.sectionDigests??null,candidateDigest:result.candidateDigest,
  witnessScope:{invariant:WITNESS_INVARIANT,archives:archives.length},transport,liveBlockers:result.liveBlockers,
 };
}

export async function run({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,write=fs.writeFileSync,log=console.log}={}){
 const args=parseArgs(argv);
 const target=privatePath(args.out);
 const transport={requests:0,rowsRead:0,rowsWritten:0};
 const adapter=createD1Adapter({target:productionTarget(env),databaseId:PRODUCTION_DATABASE_ID,fetchImpl:readOnlyTransport(fetchImpl,transport),retries:0});
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new Error('target_identity_mismatch');
 const scope=args.archives.length?{invariant:WITNESS_INVARIANT,archives:args.archives}:null;
 const result=await preflight({DB:createPublishedBinding(adapter)},{scope,caps:{...DEFAULT_CAPS,...args.caps}});
 const report=sanitize(result,{archives:args.archives,transport});
 const eligible=(result.results||[]).filter(item=>item.state==='eligible_in_scope').map(item=>({lid:item.lid,tmdb:item.movie}));
 // Private, exact, mode 600; written even when empty so the run leaves one auditable file. The caller keeps it outside GitHub and Trello.
 write(target,JSON.stringify({generatedAt:new Date().toISOString(),candidateDigest:result.candidateDigest,readSetDigest:result.readSetDigest,eligible,results:result.results||[]},null,1),{mode:0o600});
 log(JSON.stringify(report,null,1));
 return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 run().catch(error=>{console.error('preflight failed:',String(error?.message||error).slice(0,300));process.exitCode=2;});
}
