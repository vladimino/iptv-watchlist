// AIR-222 stage 2: installs a planned discovery ledger split (scripts/discovery-ledger-split.mjs) into an R2 bucket through
// the S3 API, with the Worker's own `applySplit` and its fences. R2 evaluates `If-None-Match: *` and `If-Match` on PutObject
// atomically, so every planned write keeps its create-once or compare-and-swap semantics.
//
// `--dry-run` (default) needs the read-only snapshot credential only: it re-checks the plan against the live bucket (every
// planned object absent, already done, or still the source version; the published pointer, sync.json and the leases) and
// reports what an apply would write. It sends GET/HEAD only. `--apply` requires `--approved-production-writes`, a separate
// write credential (R2_INSTALL_ACCESS_KEY_ID / R2_INSTALL_SECRET_ACCESS_KEY) and writes exactly the plan's keys plus the
// discovery lease; any other key is refused before a request exists. Receipts (key, ETag, SHA-256) go to the private
// output directory; standard output carries aggregates only.
//
// Usage: node scripts/discovery-ledger-install.mjs --plan /abs/private/plan-dir --output /abs/private/dir [--dry-run|--apply --approved-production-writes]
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {REPO,loadWorker} from './discovery-ledger-offline.mjs';
import {SplitError,applySplit,loadPlan} from './discovery-ledger-split.mjs';
import {parseListing,readCredentials,signRequest} from './r2-snapshot-export.mjs';

const LEASE_KEY='epg/resolver-lease.json',POINTER='epg/published-generation.json';
const sha256=value=>createHash('sha256').update(value).digest('hex');
const unquote=etag=>etag==null?null:String(etag).trim().replace(/^"(.*)"$/,'$1');
const quote=etag=>/^".*"$/.test(etag)?etag:'"'+etag+'"';
const TRANSIENT=new Set([429,500,502,503,504]);
export class InstallError extends Error{constructor(message,exitCode=1){super(message);this.name='InstallError';this.exitCode=exitCode;}}
function outside(target,label){
 if(typeof target!=='string'||!path.isAbsolute(target))throw new InstallError(label+' must be an absolute path',2);
 const resolved=path.resolve(target);
 if(resolved===REPO||resolved.startsWith(REPO+path.sep))throw new InstallError(label+' must be outside the Git repository',2);
 return resolved;
}
// The write credential is separate from the snapshot one and is read only for --apply.
export function readInstallCredentials(env=process.env){
 if(!String(env.R2_INSTALL_ACCESS_KEY_ID||'').trim()||!String(env.R2_INSTALL_SECRET_ACCESS_KEY||'').trim())throw new InstallError('R2_INSTALL_ACCESS_KEY_ID and R2_INSTALL_SECRET_ACCESS_KEY are required for --apply',2);
 return readCredentials({...env,R2_SNAPSHOT_ACCESS_KEY_ID:env.R2_INSTALL_ACCESS_KEY_ID,R2_SNAPSHOT_SECRET_ACCESS_KEY:env.R2_INSTALL_SECRET_ACCESS_KEY,R2_SNAPSHOT_ACCOUNT_ID:env.R2_INSTALL_ACCOUNT_ID||env.R2_SNAPSHOT_ACCOUNT_ID});
}

// An R2-binding-like store over the S3 API: get, head, put with onlyIf, list with prefix. Writes exist only when
// `allowedWrites` names the key; everything else is refused before a request is built.
export function createS3Store({credentials,fetchImpl=fetch,allowedWrites=null,now=()=>new Date(),retries=4,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const calls={list:0,head:0,get:0,put:0,refusedWrites:0},writes=[];
 async function send(method,key,query,headers={},body=null){
  const url=new URL(credentials.endpoint);
  url.pathname='/'+encodeURIComponent(credentials.bucket)+(key==null?'':'/'+key.split('/').map(segment=>encodeURIComponent(segment).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())).join('/'));
  for(const [name,value] of Object.entries(query||{}))if(value!=null)url.searchParams.set(name,value);
  const payloadHash=body==null?sha256(''):sha256(body);
  for(let attempt=0;;attempt++){
   const signed=signRequest({method,url,headers:{'Accept-Encoding':'identity',...headers},payloadHash,credentials,now:now()});
   let response;
   try{response=await fetchImpl(url,{method,headers:signed,body:body??undefined,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(600000)});}
   catch{if(attempt<retries&&method!=='PUT'){await sleep(100*2**attempt);continue;}throw new InstallError('Request failed'+(method==='PUT'?' during a write; the outcome is unknown, re-run the dry-run before any retry':' after retries'));}
   if(TRANSIENT.has(response.status)&&attempt<retries&&method!=='PUT'){await response.body?.cancel();await sleep(100*2**attempt);continue;}
   if(response.status===412){await response.body?.cancel();return null;}
   if(response.status===404&&key!=null&&method!=='PUT'){await response.body?.cancel();return null;}
   if(response.status===401||response.status===403){await response.body?.cancel();throw new InstallError('Credential was refused by the bucket ('+method+')',3);}
   if(!response.ok){await response.body?.cancel();throw new InstallError(method+' failed with HTTP '+response.status);}
   return response;
  }
 }
 const metadata=response=>{const etag=unquote(response.headers.get('etag'));if(!etag||/^W\//.test(String(response.headers.get('etag'))))throw new InstallError('Object response lacks a strong ETag');return {etag,size:Number(response.headers.get('content-length'))};};
 return {
  calls,writes,
  async get(key){calls.get++;const response=await send('GET',key);if(!response)return null;const bytes=Buffer.from(await response.arrayBuffer()),meta=metadata(response);return {...meta,json:async()=>JSON.parse(bytes.toString('utf8')),text:async()=>bytes.toString('utf8'),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)};},
  async head(key){calls.head++;const response=await send('HEAD',key);if(!response)return null;await response.body?.cancel();return metadata(response);},
  async put(key,value,options={}){
   if(!allowedWrites||!allowedWrites.has(key)){calls.refusedWrites++;throw new InstallError('Write refused: '+key+' is not a planned key',3);}
   const c=options.onlyIf||{},headers={'Content-Type':options.httpMetadata?.contentType||'application/json'};
   if(c.etagDoesNotMatch==='*')headers['If-None-Match']='*';
   else if(c.etagMatches)headers['If-Match']=quote(c.etagMatches);
   else throw new InstallError('Write refused: '+key+' has no precondition',3);
   calls.put++;
   const body=Buffer.from(typeof value==='string'?value:value,'utf8'),response=await send('PUT',key,null,headers,body);
   if(!response)return null;
   await response.body?.cancel();
   const meta=metadata(response);writes.push({key,etag:meta.etag,sha256:sha256(body),bytes:body.length,at:now().toISOString()});
   return {etag:meta.etag};
  },
  async list({prefix=''}={}){
   const objects=[];let cursor=null;
   do{calls.list++;const response=await send('GET',null,{'list-type':'2','max-keys':'1000',...(prefix?{prefix}:{}),...(cursor?{'continuation-token':cursor}:{})});const page=parseListing(await response.text());objects.push(...page.objects);cursor=page.truncated?page.nextCursor:null;}while(cursor);
   return {objects:objects.map(o=>({key:o.key,size:o.size,etag:o.etag})),truncated:false};
  },
  async delete(){throw new InstallError('Delete refused: the installer never deletes',3);}
 };
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

export async function run({plan,output,apply=false,approved=false,env=process.env,fetchImpl=fetch}){
 const planDir=outside(plan,'--plan'),out=outside(output,'--output');
 const planned=loadPlan(planDir);
 if(planned.stops?.length)throw new InstallError('The plan has stops: '+planned.stops.join(','),3);
 for(const write of planned.writes)if(sha256(write.text)!==write.sha256)throw new InstallError('Planned object does not match its checksum',3);
 const report={mode:apply?'apply':'dry-run',plan:{manifestId:planned.manifestId,writes:planned.writes.length,bytes:planned.writes.reduce((n,w)=>n+w.bytes,0),snapshot:planned.snapshot,sourceLedger:planned.sourceLedger},startedAt:new Date().toISOString()};
 fs.mkdirSync(out,{recursive:true,mode:0o700});
 const finish=()=>{report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'install-report.json'),JSON.stringify(report,null,1));return report;};
 if(!apply){
  const store=createS3Store({credentials:readCredentials(env),fetchImpl});
  report.preflight=await preflight(store,planned);report.calls=store.calls;report.verdict=report.preflight.wouldWrite===0&&report.preflight.conflicts.length===0?'ALREADY-INSTALLED':report.preflight.ready?'READY':'NOT-READY';
  return finish();
 }
 if(!approved)throw new InstallError('--apply requires --approved-production-writes',2);
 const credentials=readInstallCredentials(env),allowed=new Set([...planned.writes.map(w=>w.key),LEASE_KEY]);
 const store=createS3Store({credentials,fetchImpl,allowedWrites:allowed}),context=loadWorker();
 report.preflight=await preflight(store,planned);
 if(!report.preflight.ready){report.verdict='NOT-READY';report.calls=store.calls;return finish();}
 try{
  const applied=await applySplit({BUCKET:store},planned,{context});
  report.applied={applied:applied.applied,skipped:applied.skipped,kinds:applied.writes};
 }catch(error){
  report.verdict='STOPPED';report.error=error instanceof SplitError||error instanceof InstallError?error.message:'apply failed';report.calls=store.calls;
  fs.writeFileSync(path.join(out,'receipts.json'),JSON.stringify(store.writes,null,1));finish();
  throw new InstallError(report.error,error.exitCode||1);
 }
 fs.writeFileSync(path.join(out,'receipts.json'),JSON.stringify(store.writes,null,1));
 // Post-check through the Worker's own read path: the published generation's ledger is the installed active ledger.
 const active=await vm.runInContext('loadJSON',context)({BUCKET:store},'epg/discovery-latest.json'),root=await store.get('epg/discovery-latest.json');
 const activeWrite=planned.writes.find(w=>w.kind==='active-root');
 report.postCheck={workerReadsActive:active?.ledgerMode==='bounded'&&active?.archive?.manifestId===planned.manifestId,activeItems:active?.items?.length??null,rootSha256Matches:!!root&&sha256(await root.text())===activeWrite?.sha256,archivePointer:!!await store.head('epg/discovery-archive/v1/current.json')};
 report.calls=store.calls;report.receipts=store.writes.length;
 report.verdict=report.postCheck.workerReadsActive&&report.postCheck.rootSha256Matches?'INSTALLED':'INSTALLED-UNVERIFIED';
 return finish();
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
 try{
  const report=await run({plan:value('--plan'),output:value('--output'),apply:args.includes('--apply'),approved:args.includes('--approved-production-writes')});
  console.log(JSON.stringify(report,null,1));
  process.exit(['READY','INSTALLED','ALREADY-INSTALLED'].includes(report.verdict)?0:3);
 }catch(error){console.error(error instanceof InstallError||error instanceof SplitError?error.message:'Install failed: '+error.message);process.exit(error.exitCode||1);}
}
