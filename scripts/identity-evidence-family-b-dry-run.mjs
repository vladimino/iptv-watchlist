#!/usr/bin/env node
// AIR-622: the READ-ONLY dry-run operator of Identity Evidence family (b), the Discovery history reconstruction (ADR 0215 decision 7, Table 4; module src/identity-evidence-family-b.js).
// It acquires the sources, reconstructs and plans the manifest with the UNCHANGED `readFamilyBSources` / `dryRunFamilyB` / `planManifest`, and writes nothing to D1 or R2: D1 goes through a
// transport that refuses anything but one SELECT (the AIR-653 guard), R2 through the read-only S3 store (no write or delete allowlist) with the Object Read credential. It sets no flag,
// Task or lease, runs no sync or import and authorizes nothing: a manifest digest is a candidate for the owner's decision, not a GO.
//
//   node scripts/identity-evidence-family-b-dry-run.mjs --out <fresh private path prefix> [--run-id <id>] [--accept-r2-residual]
//
// RUNNING IT AGAINST PRODUCTION NEEDS THE OWNER'S SEPARATE READ GO. The exact authorized acquisition is: the D1 SELECTs of `readFamilyBSources` (single-statement strict reads, no retry);
// TWO complete listings of the prefix `admin/actions/discovery_identity_correct/v1/` (every page of each, the continuation chain checked); and ONE GET per listed object (If-Match its listed
// ETag, no retry). The R2 target is pinned to the production account, the bucket `iptv` and the canonical account endpoint, and both targets are validated before the first request.
// `--accept-r2-residual` states the owner's acceptance of the R2 residual window and is never implied; without it every R2 record stays an exclusion and the dry run reports it.
//
// Acquisition order (each step fails CLOSED; nothing is certified from a failed or partial read; there is no global pause):
//   1. R2: list the prefix completely (strictly paged), keep `listedAt` (the end of the listing) and the exact {key, etag} set;
//   2. D1: `readFamilyBSources` (paged SELECTs fenced by the Discovery authority marker read before and after; `d1`/`open` and an unmoved generation, or the acquisition is not coherent;
//      a response without a result array, a missing COUNT row, a malformed marker or a non-advancing page is a failed read, never an empty table);
//   3. R2: get every listed object once, requiring the listed ETag, decode its JSON (a missing object, an ETag change or an undecodable body is a read failure, reported as unresolved);
//   4. R2: list again; the second listing must equal the first (an object created, removed or replaced while the run read is a moved source);
//   5. `cohortAt` is the later of `listedAt` and the D1 `acquiredAt`: the extraction itself, never earlier than either acquisition.
// Output. The printed report is `manifest_candidate` or `no_import` and holds counts and closed labels only: no observation key, object key, movie id, payload or unknown source text.
// Exit code: 0 a `manifest_candidate`, 1 a completed run with `no_import`, 2 a failed or refused run (usage, target, credential, read failure, write failure). Files go ONLY to fresh paths outside the
// repository (mode 600), kept out of GitHub and Trello: `<out>.capture.json` (the raw sources and the full coverage, written FIRST and always), then `<out>.manifest.json` (the import artifact,
// written ONLY for a `manifest_candidate`) or `<out>.diagnostic-plan.json` (a plan for a run that is not a candidate: it carries `kind: family_b_diagnostic_plan_not_importable` and no digest,
// and is never a candidate for a GO).
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {productionTarget,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME} from './published-epg-production.mjs';
import {readCredentials,createReadOnlyClient,collectPages} from './r2-snapshot-export.mjs';
import {ExportError} from './migration-export.mjs';
import {ControlledError,UsageError,controlled,describeError,privatePath,writePrivate,readOnlyTransport} from './letterboxd-claim-cohort-preflight-production.mjs';
import {readFamilyBSources,dryRunFamilyB,R2_ACTION_PREFIX,FAMILY,OWNER_WRITERS,NON_IDENTITY_WRITERS} from '../src/identity-evidence-family-b.js';
import {planManifest} from '../src/identity-evidence-import.js';

const RUN_ID=/^[\x21-\x7e]{1,150}$/;
export const PRODUCTION_R2_BUCKET='iptv';
export const PRODUCTION_R2_ENDPOINT='https://'+PRODUCTION_ACCOUNT_ID+'.r2.cloudflarestorage.com';
const MAX_LIST_PAGES=1000,MAX_OBJECT_BYTES=4*1024*1024;

// The messages below never echo an argument (an unknown option or a bad value may carry private text).
export function parseArgs(argv){
 const out={out:null,runId:null,acceptR2Residual:false};
 for(let i=2;i<argv.length;i++){
  const flag=argv[i],value=argv[i+1];
  if(flag==='--out'){if(!value||value.startsWith('--'))throw new UsageError('usage: --out needs a path prefix');out.out=value;i++;}
  else if(flag==='--run-id'){if(!RUN_ID.test(String(value)))throw new UsageError('usage: --run-id needs 1 to 150 printable characters');out.runId=value;i++;}
  else if(flag==='--accept-r2-residual')out.acceptR2Residual=true;
  else throw new UsageError('usage: unknown option');
 }
 if(!out.out)throw new UsageError('usage: --out <private path prefix outside the repository> is required');
 return out;
}

// ---- the R2 source: strict listing and reads over the existing read-only S3 client (no new store) ----
// `source.list()` returns the complete, strictly paged {key, etag} set of the prefix; `source.read(key, etag)` returns {record} or {readError}. Tests inject their own source.
export function r2Source(client){
 return {
  async list(){
   const records=[];let cursor=null;
   for(let page=0;page<MAX_LIST_PAGES;page++){
    const current=await client.list(cursor,R2_ACTION_PREFIX);
    records.push({requestCursor:cursor,page:current});
    const collected=collectPages(records);   // the cursor chain, a repeated cursor and a duplicate key stop here
    if(collected.complete){
     const objects=collected.objects.map(item=>({key:item.key,etag:item.etag}));
     if(objects.some(item=>!item.key.startsWith(R2_ACTION_PREFIX)))throw new ControlledError('r2_listing_outside_prefix');
     return objects.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    }
    cursor=collected.nextCursor;
   }
   throw new ControlledError('r2_listing_page_limit');
  },
  // 404 is a missing object and 412 a changed one (a read failure of that object, reported); anything else (credential, transport, protocol) stops the run.
  async read(key,etag){
   let object;
   try{object=await client.get(key,{ifMatch:etag});}
   catch(error){if(error instanceof ExportError&&error.kind==='source_changed')return {readError:'etag_changed'};throw error;}
   if(!object)return {readError:'missing'};
   if(object.etag!==etag){await object.body?.cancel();return {readError:'etag_changed'};}
   if(object.size>MAX_OBJECT_BYTES){await object.body?.cancel();return {readError:'too_large'};}
   try{return {record:JSON.parse(await new Response(object.body).text())};}catch{return {readError:'undecodable'};}
  },
 };
}
const sameListing=(a,b)=>a.length===b.length&&a.every((item,index)=>item.key===b[index].key&&item.etag===b[index].etag);

// The acquisition and the dry run over injected D1 binding and R2 source (the production wrapper below builds both read-only; the tests inject stand-ins).
export async function acquireAndPlan({db,source,runId='family-b-dry-run',acceptR2Residual=false,now=()=>new Date(),planImpl=planManifest}={}){
 const first=await source.list();
 const listedAt=now().toISOString();
 const d1=await readFamilyBSources(db);
 const r2Objects=[];
 for(const item of first){
  const read=await source.read(item.key,item.etag);
  r2Objects.push({key:item.key,etag:item.etag,record:read.readError?null:read.record,...(read.readError?{readError:read.readError}:{})});
 }
 const second=await source.list();
 const stable=sameListing(first,second);
 const acquiredAt=d1.acquisition.acquiredAt;
 const cohortAt=new Date(Math.max(Date.parse(listedAt),Date.parse(acquiredAt))).toISOString();
 const sources={...d1,r2Objects,r2Acquisition:{complete:stable,listedAt,objects:first}};
 const result=await dryRunFamilyB({runId,cohortAt,sources,acceptR2Residual,planManifest:planImpl});
 return {result,sources,cohortAt,listedAt,listingStable:stable};
}

// ---- the sanitized report: an allowlist of fields and CLOSED labels ----
// A label that comes from the source (a writer, a decision status) is mapped to a closed set; an unknown one is aggregated under one fixed label and its exact value stays only in the private capture.
const KNOWN_WRITERS=new Set([...OWNER_WRITERS,...NON_IDENTITY_WRITERS,'resolver_chunk']);
const KNOWN_STATUSES=new Set(['verified','unresolved','ambiguous','rejected','pending','failed','retry','none','unreadable']);
const writerLabel=value=>KNOWN_WRITERS.has(value)?value:'unknown_writer';
const statusLabel=value=>KNOWN_STATUSES.has(value)?value:'other_status';
function closedMap(map,label){const out={};for(const [key,count] of Object.entries(map||{})){const name=label(key);out[name]=(out[name]||0)+Number(count||0);}return out;}
function writerStatusMap(map){const out={};for(const [key,count] of Object.entries(map||{})){const [writer,status]=String(key).split('|');const name=writerLabel(writer)+'|'+statusLabel(status);out[name]=(out[name]||0)+Number(count||0);}return out;}
const number=value=>Number.isFinite(Number(value))?Number(value):0;
// Code-derived label maps (dispositions, exclusions) still pass through `controlled`, so no free text can reach a log.
const labelMap=map=>Object.fromEntries(Object.entries(map||{}).map(([key,count])=>[controlled(key),number(count)]));
const counted=object=>Object.fromEntries(Object.entries(object||{}).filter(([,value])=>typeof value==='number'&&Number.isFinite(value)));

export function sanitize({result,listingStable,cohortAt,listedAt},{transport=null,r2Calls=null}={}){
 const coverage=result.coverage;
 const ready=Boolean(result.manifest)&&coverage.complete===true&&listingStable===true;
 const reasons=[];
 if(!result.manifest)reasons.push(controlled(result.report?.disposition??'no_manifest'));
 if(coverage.complete!==true)reasons.push('coverage_not_complete');
 if(!listingStable)reasons.push('r2_listing_moved');
 const a=coverage.acquisition||{},c=coverage.counts||{};
 return {
  family:FAMILY,decision:ready?'manifest_candidate':'no_import',reasons,cohortAt,listedAt,
  // The candidate digest is published ONLY for a candidate; a run that is not one exposes none.
  digest:ready?result.digest??null:null,
  manifest:result.manifest?{chunks:result.manifest.chunks.length,rows:result.manifest.chunks.reduce((n,chunk)=>n+chunk.rows.length,0),sources:result.manifest.chunks.reduce((n,chunk)=>n+chunk.sources.length,0)}:null,
  plan:result.report?{conflicts:number(result.report.conflicts?.length),excluded:number(result.report.excluded?.length),duplicates:number(result.report.duplicates?.length),r2Residual:number(result.report.r2Residual?.length)}:null,
  coverage:{
   complete:coverage.complete===true,unresolvedCount:number(coverage.unresolvedCount),reconciled:Object.fromEntries(Object.entries(coverage.reconciled||{}).map(([key,value])=>[controlled(key),value===true])),
   acquisition:{d1:{established:a.d1?.established===true,reason:a.d1?.reason==null?null:controlled(a.d1.reason),generationBefore:a.d1?.generationBefore??null,generationAfter:a.d1?.generationAfter??null},
    r2:{established:a.r2?.established===true,reason:a.r2?.reason==null?null:controlled(a.r2.reason),objects:number(a.r2?.objects)}},
   sizes:counted(coverage.sizes),dispositions:Object.fromEntries(Object.entries(coverage.dispositions||{}).map(([key,map])=>[controlled(key),labelMap(map)])),
   unresolved:{...counted(coverage.unresolved),unrecordable:labelMap(coverage.unresolved?.unrecordable)},
   excluded:{noRow:labelMap(coverage.excluded?.noRow)},unknownWriters:closedMap(coverage.unknownWriters,writerLabel),
   counts:{rowsMapped:number(c.rowsMapped),timeUnknown:number(c.timeUnknown),b1:counted(c.b1),b2:Object.fromEntries(Object.entries(c.b2||{}).map(([key,value])=>[controlled(key),counted(value)])),b3:counted(c.b3),otherSource:counted(c.otherSource),
    b4:counted(c.b4),b5:counted(c.b5),b6:{historyByWriterAndStatus:writerStatusMap(c.b6?.historyByWriterAndStatus)},b7:counted(c.b7),
    currentDecisionsWithHistory:{count:number(c.currentDecisionsWithHistory?.count),byStatus:closedMap(c.currentDecisionsWithHistory?.byStatus,statusLabel)}},
   lateArrivals:{history:number(coverage.lateArrivals?.history),intents:number(coverage.lateArrivals?.intents),r2:number(coverage.lateArrivals?.r2)}},
  transport,r2Calls,
  limitations:['A dry run proves nothing about production: the digest of a candidate is for the owner decision, not a GO.','No import until the owner decision naming this digest, an L3 GO, both Discovery writers on, ECM and ERM.'],
 };
}

// ---- the production wiring: both targets validated BEFORE the first request ----
export function r2Credentials(env){
 let credentials;
 try{credentials=readCredentials(env);}catch{throw new ControlledError('r2_credentials_missing');}
 if(credentials.accountId!==PRODUCTION_ACCOUNT_ID||credentials.bucket!==PRODUCTION_R2_BUCKET)throw new ControlledError('r2_target_identity_mismatch');
 if(credentials.endpoint!==PRODUCTION_R2_ENDPOINT||credentials.endpointOverride)throw new ControlledError('r2_endpoint_refused');
 return credentials;
}
// A strict read binding over the D1 adapter: a response without a result array is an error (the adapter's `all` would turn it into an empty table).
export const strictBinding=adapter=>({prepare(sql){return {bind(...params){return {async all(){return {results:await adapter.allStrict(sql,params)};}};}};}});

export async function run({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,write=writePrivate,log=console.log,now=()=>new Date()}={}){
 const args=parseArgs(argv);
 const manifestPath=privatePath(args.out+'.manifest.json');
 const diagnosticPath=privatePath(args.out+'.diagnostic-plan.json');
 const capturePath=privatePath(args.out+'.capture.json');
 const target=productionTarget(env);
 const credentials=r2Credentials(env);
 const transport={requests:0,rowsRead:0,rowsWritten:0};
 // No retry anywhere: one GET per listed object and two listings, with the actual request counts reported.
 const adapter=createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl:readOnlyTransport(fetchImpl,transport),retries:0});
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new ControlledError('target_identity_mismatch');
 const client=createReadOnlyClient({credentials,fetchImpl,retries:0});
 const acquired=await acquireAndPlan({db:strictBinding(adapter),source:r2Source(client),runId:args.runId||'family-b-'+now().toISOString().replace(/[^0-9]/g,'').slice(0,14),acceptR2Residual:args.acceptR2Residual,now});
 const report=sanitize(acquired,{transport,r2Calls:{...client.calls}});
 // The private capture first and always (raw sources and the full coverage), then the artifact: nothing is exposed as a candidate before the capture is on disk.
 write(capturePath,JSON.stringify({generatedAt:now().toISOString(),cohortAt:acquired.cohortAt,listedAt:acquired.listedAt,coverage:acquired.result.coverage,sources:acquired.sources},null,1));
 if(report.decision==='manifest_candidate')write(manifestPath,JSON.stringify({kind:'family_b_import_manifest',digest:acquired.result.digest,manifest:acquired.result.manifest},null,1));
 else if(acquired.result.manifest)write(diagnosticPath,JSON.stringify({kind:'family_b_diagnostic_plan_not_importable',reasons:report.reasons,manifest:acquired.result.manifest},null,1));
 log(JSON.stringify(report,null,1));
 return report;
}

export function describeFailure(error){
 if(error instanceof ExportError)return 'r2_'+controlled(error.kind);
 if(error instanceof D1Error)return 'd1_'+controlled(error.kind);
 if(error instanceof OperatorStop)return 'operator_'+controlled(error.reason);
 if(error instanceof UsageError||error instanceof ControlledError)return describeError(error);
 return 'unexpected_error';
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 run().then(report=>{process.exitCode=report.decision==='manifest_candidate'?0:1;}).catch(error=>{console.error('family (b) dry run failed:',describeFailure(error));process.exitCode=2;});
}
