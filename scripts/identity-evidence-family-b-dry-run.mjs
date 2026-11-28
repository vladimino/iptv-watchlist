#!/usr/bin/env node
// AIR-622: the READ-ONLY dry-run operator of Identity Evidence family (b), the Discovery history reconstruction (ADR 0215 decision 7, Table 4; module src/identity-evidence-family-b.js).
// It acquires the sources, reconstructs and plans the manifest with the UNCHANGED `readFamilyBSources` / `dryRunFamilyB` / `planManifest`, and writes nothing to D1 or R2: D1 goes through a
// transport that refuses anything but one SELECT (the AIR-653 guard), R2 through the read-only S3 store (no write or delete allowlist) with the Object Read credential. It sets no flag,
// Task or lease, runs no sync or import and authorizes nothing: a manifest digest is a candidate for the owner's decision, not a GO.
//
//   node scripts/identity-evidence-family-b-dry-run.mjs --out <fresh private path prefix> [--run-id <id>] [--accept-r2-residual]
//
// RUNNING IT AGAINST PRODUCTION NEEDS THE OWNER'S SEPARATE READ GO (SELECTs, one scoped R2 list of `admin/actions/discovery_identity_correct/v1/` and one get per listed object).
// `--accept-r2-residual` states the owner's acceptance of the R2 residual window and is never implied; without it every R2 record stays an exclusion and the dry run reports it.
//
// Acquisition order (each step fails CLOSED; nothing is certified from a failed or partial read; there is no global pause):
//   1. R2: list the prefix completely, keep `listedAt` (the end of the listing) and the exact {key, etag} set;
//   2. D1: `readFamilyBSources` (paged SELECTs fenced by the Discovery authority marker read before and after; `d1`/`open` and an unmoved generation, or the acquisition is not coherent);
//   3. R2: get every listed object once, require the listed ETag, decode its JSON (a missing object, an ETag change or an undecodable body is a read failure, reported as unresolved);
//   4. R2: list again; the second listing must equal the first (an object created, removed or replaced while the run read is a moved source);
//   5. `cohortAt` is the later of `listedAt` and the D1 `acquiredAt`: the extraction itself, never earlier than either acquisition.
// The printed report holds counts, dispositions and digests only. Observation keys, TMDB ids, receipts and payloads never reach a log. The exact manifest and the raw capture go ONLY to two
// fresh files outside the repository (mode 600), `<out>.manifest.json` and `<out>.capture.json`, kept out of GitHub and Trello.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createD1Adapter} from './d1-backfill.mjs';
import {createPublishedBinding,productionTarget,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME} from './published-epg-production.mjs';
import {readCredentials} from './r2-snapshot-export.mjs';
import {createS3Store,InstallError} from './r2-s3-store.mjs';
import {ControlledError,UsageError,controlled,describeError,privatePath,writePrivate,readOnlyTransport} from './letterboxd-claim-cohort-preflight-production.mjs';
import {readFamilyBSources,dryRunFamilyB,R2_ACTION_PREFIX,FAMILY} from '../src/identity-evidence-family-b.js';
import {planManifest} from '../src/identity-evidence-import.js';

const RUN_ID=/^[\x21-\x7e]{1,150}$/;

export function parseArgs(argv){
 const out={out:null,runId:null,acceptR2Residual:false};
 for(let i=2;i<argv.length;i++){
  const flag=argv[i],value=argv[i+1];
  if(flag==='--out'){if(!value||value.startsWith('--'))throw new UsageError('usage: --out needs a path prefix');out.out=value;i++;}
  else if(flag==='--run-id'){if(!RUN_ID.test(String(value)))throw new UsageError('usage: --run-id needs 1 to 150 printable characters');out.runId=value;i++;}
  else if(flag==='--accept-r2-residual')out.acceptR2Residual=true;
  else throw new UsageError('usage: unknown option '+flag);
 }
 if(!out.out)throw new UsageError('usage: --out <private path prefix outside the repository> is required');
 return out;
}

const sameListing=(a,b)=>a.length===b.length&&a.every((item,index)=>item.key===b[index].key&&item.etag===b[index].etag);
const listingOf=async store=>{
 const listed=await store.list({prefix:R2_ACTION_PREFIX});
 if(listed.truncated!==false||!Array.isArray(listed.objects))throw new ControlledError('r2_listing_incomplete');
 const objects=listed.objects.map(item=>({key:item.key,etag:item.etag}));
 if(objects.some(item=>typeof item.key!=='string'||!item.key.startsWith(R2_ACTION_PREFIX)||typeof item.etag!=='string'||!item.etag))throw new ControlledError('r2_listing_malformed');
 objects.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 if(new Set(objects.map(item=>item.key)).size!==objects.length)throw new ControlledError('r2_listing_duplicate');
 return objects;
};
// One get per listed object. A missing object, a changed ETag or an undecodable body is a READ FAILURE of that object (reported, never a no-row); a refused credential or a transport
// failure is an incomplete acquisition and stops the run.
async function readObjects(store,listing){
 const objects=[];
 for(const item of listing){
  const object=await store.get(item.key);
  if(!object){objects.push({key:item.key,etag:item.etag,record:null,readError:'missing'});continue;}
  if(object.etag!==item.etag){objects.push({key:item.key,etag:object.etag,record:null,readError:'etag_changed'});continue;}
  let record=null,readError=null;
  try{record=await object.json();}catch{readError='undecodable';}
  objects.push({key:item.key,etag:item.etag,record,...(readError?{readError}:{})});
 }
 return objects;
}

// The acquisition and the dry run over injected D1 binding and R2 store (the production wrapper below builds both read-only; the tests inject stand-ins).
export async function acquireAndPlan({db,store,runId='family-b-dry-run',acceptR2Residual=false,now=()=>new Date(),planImpl=planManifest}={}){
 const first=await listingOf(store);
 const listedAt=now().toISOString();
 const d1=await readFamilyBSources(db);
 const r2Objects=await readObjects(store,first);
 const second=await listingOf(store);
 const stable=sameListing(first,second);
 const acquiredAt=d1.acquisition.acquiredAt;
 const cohortAt=new Date(Math.max(Date.parse(listedAt),Date.parse(acquiredAt))).toISOString();
 const sources={...d1,r2Objects,r2Acquisition:{complete:stable,listedAt,objects:first}};
 const result=await dryRunFamilyB({runId,cohortAt,sources,acceptR2Residual,planManifest:planImpl});
 return {result,sources,cohortAt,listedAt,listingStable:stable};
}

const COUNT=value=>Number.isFinite(Number(value))?Number(value):0;
// The sanitized report: counts, reasons and digests. Never an observation key, a movie id, a receipt, a payload or an object key (the `lateArrivals.sample` rows are dropped).
export function sanitize({result,listingStable,cohortAt,listedAt},{transport=null,r2Calls=null}={}){
 const coverage=result.coverage;
 const {lateArrivals,...rest}=coverage;
 const ready=Boolean(result.manifest)&&coverage.complete===true;
 const reasons=[];
 if(!result.manifest)reasons.push(controlled(result.report?.disposition??'no_manifest'));
 if(coverage.complete!==true)reasons.push('coverage_not_complete');
 if(!listingStable)reasons.push('r2_listing_moved');
 return {
  family:FAMILY,decision:ready?'manifest_candidate':'no_import',reasons,cohortAt,listedAt,digest:result.digest??null,
  manifest:result.manifest?{chunks:result.manifest.chunks.length,rows:result.manifest.chunks.reduce((n,chunk)=>n+chunk.rows.length,0),sources:result.manifest.chunks.reduce((n,chunk)=>n+chunk.sources.length,0)}:null,
  report:result.report?{disposition:controlled(result.report.disposition??null),conflicts:COUNT(result.report.conflicts?.length),excluded:COUNT(result.report.excluded?.length),duplicates:COUNT(result.report.duplicates?.length),r2Residual:COUNT(result.report.r2Residual?.length)}:null,
  coverage:{...rest,lateArrivals:{history:lateArrivals?.history??0,intents:lateArrivals?.intents??0,r2:lateArrivals?.r2??0}},
  transport,r2Calls,
  limitations:['A dry run proves nothing about production: the digest is a candidate for the owner decision, not a GO.','No import until the owner decision naming this digest, an L3 GO, both Discovery writers on, ECM and ERM.'],
 };
}

export async function run({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,write=writePrivate,log=console.log,now=()=>new Date()}={}){
 const args=parseArgs(argv);
 const manifestPath=privatePath(args.out+'.manifest.json');
 const capturePath=privatePath(args.out+'.capture.json');
 const transport={requests:0,rowsRead:0,rowsWritten:0};
 const adapter=createD1Adapter({target:productionTarget(env),databaseId:PRODUCTION_DATABASE_ID,fetchImpl:readOnlyTransport(fetchImpl,transport),retries:0});
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new ControlledError('target_identity_mismatch');
 // No write or delete allowlist: the store can only list, get and head.
 const store=createS3Store({credentials:readCredentials(env),fetchImpl});
 const acquired=await acquireAndPlan({db:createPublishedBinding(adapter),store,runId:args.runId||'family-b-'+now().toISOString().replace(/[^0-9]/g,'').slice(0,14),acceptR2Residual:args.acceptR2Residual,now});
 const report=sanitize(acquired,{transport,r2Calls:{...store.calls}});
 // Private, exact, mode 600; written even for a no_import so the run leaves its raw capture for review.
 if(acquired.result.manifest)write(manifestPath,JSON.stringify({digest:acquired.result.digest,manifest:acquired.result.manifest},null,1));
 write(capturePath,JSON.stringify({generatedAt:now().toISOString(),cohortAt:acquired.cohortAt,listedAt:acquired.listedAt,sources:acquired.sources},null,1));
 log(JSON.stringify(report,null,1));
 return report;
}

export function describeFailure(error){
 if(error instanceof InstallError)return 'r2_'+(error.exitCode===3?'credential_refused':'request_failed');
 return describeError(error);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 run().catch(error=>{console.error('family (b) dry run failed:',describeFailure(error));process.exitCode=2;});
}
