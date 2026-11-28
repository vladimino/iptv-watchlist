#!/usr/bin/env node
// AIR-653: the READ-ONLY, bounded production run of the historical bridge-only cohort preflight (AIR-652 design, scripts/letterboxd-claim-cohort-preflight.mjs).
// It reads production D1 through the AIR-647 counted database only (SELECT statements, charged to ONE shared budget before each statement, a statement the
// guard does not recognise as a single SELECT is refused), judges the captured rows with the UNCHANGED claim planner on a private sqlite snapshot, and
// repeats the capture and the discovery to fence movement. It writes nothing to D1 or R2, makes no Letterboxd or TMDB request, sets no flag, Task or lease
// and authorizes nothing: an `eligible_in_scope` key is not production proof and not a GO.
//
//   node scripts/letterboxd-claim-cohort-preflight-production.mjs --out <fresh private file> (--archive <sha256>... | --witness-all-archives) [--statements n] [--rows n] [--pointer-inspect n] [--candidates n]
//
// Credentials: D1_BACKFILL_ACCOUNT_ID and D1_BACKFILL_API_TOKEN (behind a proxy NODE_USE_ENV_PROXY=1). The target is pinned to the production account and
// database; the identity (uuid and name) is read back before the first statement. The printed report holds counts, reasons and digests only. The exact
// lid-to-movie result (the private allowlist of `eligible_in_scope` pairs) goes ONLY to `--out`, a file outside the repository, mode 600, never to a log.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,productionTarget,OperatorStop,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME} from './published-epg-production.mjs';
import {preflight,scopeDescriptor,DEFAULT_CAPS,WITNESS_INVARIANT} from './letterboxd-claim-cohort-preflight.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
// Hard ceilings: a flag can lower or raise a cap only up to these. They bound the work of one run (REST round trips and rows), not the data.
export const CAP_CEILINGS=Object.freeze({statements:2000,rows:60000,pointerInspect:20000,candidates:512});
const HEX64=/^[0-9a-f]{64}$/;
// Every message that can reach a log is one of OURS: a usage message or a controlled code. Anything else (a SQL or transport message, a JSON body, an id) never leaves the process.
export class UsageError extends Error{constructor(message){super(message);this.name='UsageError';}}
export class ControlledError extends Error{constructor(code){super(code);this.name='ControlledError';this.code=code;}}
const CONTROLLED=/^[a-z0-9_:.-]{1,80}$/;
export const controlled=value=>typeof value==='string'&&CONTROLLED.test(value)?value:'unclassified';
export function describeError(error){
 if(error instanceof UsageError)return error.message;
 if(error instanceof ControlledError)return error.code;
 if(error instanceof D1Error)return 'd1_'+controlled(error.kind);
 if(error instanceof OperatorStop)return 'operator_'+controlled(error.reason);
 return 'unexpected_error';
}

export function parseArgs(argv){
 const out={archives:[],allArchives:false,out:null,caps:{}};
 const number=(name,value,ceiling)=>{const n=Number(value);if(!Number.isInteger(n)||n<1||n>ceiling)throw new UsageError('usage: '+name+' must be an integer from 1 to '+ceiling);return n;};
 for(let i=2;i<argv.length;i++){
  const flag=argv[i],value=argv[i+1];
  if(flag==='--archive'){if(!HEX64.test(String(value)))throw new UsageError('usage: --archive needs a 64-hex sha256');out.archives.push(value);i++;}
  else if(flag==='--witness-all-archives'){out.allArchives=true;}
  else if(flag==='--out'){if(!value||value.startsWith('--'))throw new UsageError('usage: --out needs a path');out.out=value;i++;}
  else if(flag==='--statements'){out.caps.statements=number(flag,value,CAP_CEILINGS.statements);i++;}
  else if(flag==='--rows'){out.caps.rows=number(flag,value,CAP_CEILINGS.rows);i++;}
  else if(flag==='--pointer-inspect'){out.caps.pointerInspect=number(flag,value,CAP_CEILINGS.pointerInspect);i++;}
  else if(flag==='--candidates'){out.caps.candidates=number(flag,value,CAP_CEILINGS.candidates);i++;}
  else throw new UsageError('usage: unknown option '+flag);
 }
 if(!out.out)throw new UsageError('usage: --out <private file outside the repository> is required');
 if(out.allArchives&&out.archives.length)throw new UsageError('usage: --witness-all-archives and --archive are mutually exclusive');
 return out;
}

// The private file must not live in the repository (or any of its subdirectories): the allowlist is never committed.
// The REAL parent directory is resolved (a symlinked parent that points into the repository is the repository), the destination must not exist yet (an existing file would keep
// its permissions and a link would be followed), and the file is created exclusively below. A fresh path in a private directory is all the operator needs; there is no new store.
export function privatePath(file,root=ROOT){
 const resolved=path.resolve(file);
 let realParent,realRoot;
 try{realParent=fs.realpathSync(path.dirname(resolved));realRoot=fs.realpathSync(root);}catch{throw new UsageError('usage: the parent directory of --out must exist');}
 if(realParent===realRoot||realParent.startsWith(realRoot+path.sep))throw new UsageError('usage: --out must be outside the repository');
 const destination=path.join(realParent,path.basename(resolved));
 let present=true;
 try{fs.lstatSync(destination);}catch(error){if(error?.code==='ENOENT')present=false;else throw new UsageError('usage: --out is not usable');}
 if(present)throw new UsageError('usage: --out must not exist yet (a fresh private path is required)');
 return destination;
}
// Exclusive, no-follow creation with mode 600 (and fchmod, so a restrictive umask can never be the only guard). Never truncates, never follows a link.
export function writePrivate(destination,text){
 const flags=fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0);
 let fd;
 try{fd=fs.openSync(destination,flags,0o600);}catch{throw new ControlledError('private_output_unavailable');}
 try{fs.fchmodSync(fd,0o600);fs.writeSync(fd,text);}
 catch{throw new ControlledError('private_output_unavailable');}
 finally{fs.closeSync(fd);}
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
   if(!body||body.batch!==undefined||!/^\s*(?:with\b[\s\S]*?\)\s*)?select\b/i.test(text)||/;/.test(text)||FORBIDDEN.test(text))throw new ControlledError('write_or_unknown_statement_refused');
  }else if(method!=='GET')throw new ControlledError('write_or_unknown_statement_refused');
  stats.requests++;
  const response=await fetchImpl(url,init);
  if(method==='POST'){
   // Read the answer without consuming the caller's copy, and refuse any sign of a write.
   const payload=await response.clone().json().catch(()=>null);
   for(const item of Array.isArray(payload?.result)?payload.result:[]){
    stats.rowsRead+=Number(item?.meta?.rows_read||0);stats.rowsWritten+=Number(item?.meta?.rows_written||0);
    if(item?.meta?.changed_db===true||Number(item?.meta?.rows_written||0)>0)throw new ControlledError('unexpected_write_reported');
   }
  }
  return response;
 };
}

// The sanitized report: counts, reasons and digests. Never a lid, movie, Film id, fact key, rating or document body.
export function sanitize(result,{transport=null}){
 const byClass={};
 for(const item of result.results||[]){const key=controlled(item.state)+' / '+controlled(item.reason);byClass[key]=(byClass[key]||0)+1;}
 return {
  decision:result.decision,reason:result.reason==null?null:controlled(result.reason),coverage:result.coverage==null?null:controlled(result.coverage),moved:Array.isArray(result.moved)?result.moved.map(controlled):null,
  counts:result.counts??null,byClassAndReason:byClass,sources:result.sources??null,multiplicity:result.multiplicity??null,
  work:result.work,readSetDigest:result.readSetDigest,sectionDigests:result.sectionDigests??null,candidateDigest:result.candidateDigest,
  witnessScope:{invariant:WITNESS_INVARIANT,mode:result.scope?.mode??'missing',archives:result.scope?.archives?.length??0},missing:Array.isArray(result.missing)?result.missing.map(controlled):null,
  transport,liveBlockers:Array.isArray(result.liveBlockers)?result.liveBlockers:[],limitations:Array.isArray(result.limitations)?result.limitations:[],
 };
}

export async function run({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,write=writePrivate,log=console.log,preflightImpl=preflight}={}){
 const args=parseArgs(argv);
 const target=privatePath(args.out);
 const transport={requests:0,rowsRead:0,rowsWritten:0};
 const adapter=createD1Adapter({target:productionTarget(env),databaseId:PRODUCTION_DATABASE_ID,fetchImpl:readOnlyTransport(fetchImpl,transport),retries:0});
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new ControlledError('target_identity_mismatch');
 const scope=args.allArchives?{invariant:WITNESS_INVARIANT,allArchives:true}:args.archives.length?{invariant:WITNESS_INVARIANT,archives:args.archives}:null;
 const result=await preflightImpl({DB:createPublishedBinding(adapter)},{scope,caps:{...DEFAULT_CAPS,...args.caps}});
 const report=sanitize({...result,scope:scopeDescriptor(scope)},{transport});
 const eligible=(result.results||[]).filter(item=>item.state==='eligible_in_scope').map(item=>({lid:item.lid,tmdb:item.movie}));
 // Private, exact, mode 600; written even when empty so the run leaves one auditable file. The caller keeps it outside GitHub and Trello.
 write(target,JSON.stringify({generatedAt:new Date().toISOString(),candidateDigest:result.candidateDigest,readSetDigest:result.readSetDigest,eligible,results:result.results||[],detail:result.detail??null},null,1));
 log(JSON.stringify(report,null,1));
 return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 run().catch(error=>{console.error('preflight failed:',describeError(error));process.exitCode=2;});
}
