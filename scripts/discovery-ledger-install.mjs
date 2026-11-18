// AIR-222 stage 2 (retired write path, AIR-537): a READ-ONLY offline re-check of a planned discovery ledger split
// (scripts/discovery-ledger-split.mjs) against a bucket. Discovery is D1-owned (`discovery_authority` d1/open, ADR 0162);
// the legacy R2 ledger objects are a frozen copy and this tool must never write them. The former `--apply
// --approved-production-writes` path (R2 PutObject of the plan plus the resolver lease) is removed: `--apply` is refused with
// exit 2 and no request is built. It sends GET/HEAD only with the read-only snapshot credential (R2_SNAPSHOT_*), and
// standard output carries aggregates only. The shared S3 client lives in scripts/r2-s3-store.mjs.
//
// Usage: node scripts/discovery-ledger-install.mjs --plan /abs/private/plan-dir --output /abs/private/dir [--dry-run]
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {REPO} from './discovery-ledger-offline.mjs';
import {SplitError,loadPlan} from './discovery-ledger-split.mjs';
import {readCredentials} from './r2-snapshot-export.mjs';
import {InstallError,createS3Store} from './r2-s3-store.mjs';

export {InstallError};

const LEASE_KEY='epg/resolver-lease.json',POINTER='epg/published-generation.json';
const sha256=value=>createHash('sha256').update(value).digest('hex');
function outside(target,label){
 if(typeof target!=='string'||!path.isAbsolute(target))throw new InstallError(label+' must be an absolute path',2);
 const resolved=path.resolve(target);
 if(resolved===REPO||resolved.startsWith(REPO+path.sep))throw new InstallError(label+' must be outside the Git repository',2);
 return resolved;
}
// Read-only re-check of a plan against the live bucket: the state of every planned object and the fence.
export async function preflight(store,planned){
 const states={absent:0,done:0,source:0,conflict:0},conflicts=[];
 for(const write of planned.writes){
  const object=await store.get(write.key);
  let state='absent';
  if(object){const text=await object.text();if(sha256(text)===write.sha256)state='done';else if(write.op==='replace'&&object.etag===write.expectedEtag&&sha256(text)===write.expectedSha256)state='source';else state='conflict';}
  if(write.op==='replace'&&state==='absent')state='conflict';
  states[state]++;if(state==='conflict')conflicts.push(write.kind);
 }
 const pointer=await store.get(POINTER),pointerBody=pointer?await pointer.json():null;
 const run=await store.get('sync.json'),runBody=run?await run.json():null;
 const lease=await store.get(LEASE_KEY),leaseBody=lease?await lease.json():null;
 const fence={pointerEtagMatches:(pointer?.etag??null)===planned.fence.pointer.etag,publishedRunMatches:pointerBody?.programmeRunId===planned.fence.pointer.programmeRunId&&pointerBody?.phase==='published',syncStage:runBody?.stage??null,syncNotEpg:runBody?.stage!=='epg',leaseActive:(leaseBody?.expiresAt||0)>Date.now(),archivePointerAbsent:!await store.head('epg/discovery-archive/v1/current.json')};
 const ready=conflicts.length===0&&fence.pointerEtagMatches&&fence.publishedRunMatches&&fence.syncNotEpg&&!fence.leaseActive;
 return {states,conflicts,fence,wouldWrite:states.absent+states.source,ready};
}

export async function run({plan,output,apply=false,env=process.env,fetchImpl=fetch}){
 // The apply path is retired: refuse before any plan is read or any request is built.
 if(apply)throw new InstallError('--apply is retired: Discovery is D1-owned and this tool is read-only (AIR-537)',2);
 const planDir=outside(plan,'--plan'),out=outside(output,'--output');
 const planned=loadPlan(planDir);
 if(planned.stops?.length)throw new InstallError('The plan has stops: '+planned.stops.join(','),3);
 for(const write of planned.writes)if(sha256(write.text)!==write.sha256)throw new InstallError('Planned object does not match its checksum',3);
 const report={mode:'dry-run',plan:{manifestId:planned.manifestId,writes:planned.writes.length,bytes:planned.writes.reduce((n,w)=>n+w.bytes,0),snapshot:planned.snapshot,sourceLedger:planned.sourceLedger},startedAt:new Date().toISOString()};
 fs.mkdirSync(out,{recursive:true,mode:0o700});
 const store=createS3Store({credentials:readCredentials(env),fetchImpl});
 report.preflight=await preflight(store,planned);report.calls=store.calls;report.verdict=report.preflight.wouldWrite===0&&report.preflight.conflicts.length===0?'ALREADY-INSTALLED':report.preflight.ready?'READY':'NOT-READY';
 report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'install-report.json'),JSON.stringify(report,null,1));return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
 try{
  const report=await run({plan:value('--plan'),output:value('--output'),apply:args.includes('--apply')});
  console.log(JSON.stringify(report,null,1));
  process.exit(['READY','INSTALLED','ALREADY-INSTALLED'].includes(report.verdict)?0:3);
 }catch(error){console.error(error instanceof InstallError||error instanceof SplitError?error.message:'Install failed: '+error.message);process.exit(error.exitCode||1);}
}
