// AIR-221 / ADR 0034: offline split of a full discovery ledger into the bounded active ledger and the write-once archive, and
// its rehearsal on a verified production snapshot. No network, no R2, no D1: the snapshot is read only and every write goes
// to a private overlay directory outside the repository.
//
// `plan` reads a `consistent_fenced` snapshot (scripts/r2-snapshot-export.mjs layout) and writes a private, deterministic
// plan: the exact bytes of a write-once copy of the source ledger, every archive segment version, the archive manifest, the
// archive pointer and the new active ledger, each with its precondition (create-only, or the snapshot's ETag and SHA-256 of
// the object it replaces), plus the fence (published generation pointer). The active ledger replaces both copies of the
// ledger: the published generation's copy, which is the one the Worker reads (`loadJSON` pins it), and the shared root key.
// Departing candidates are moved verbatim: no re-merge, no re-key.
//
// `rehearse` applies that plan to a copy-on-write store over the snapshot with `applySplit` and proves, with the Worker's own
// code: payload parity of active ∪ archive with the source ledger (the R2 reconstruction), idempotent replay, resume after a
// kill at each write class, refused stale fences, then the next bounded commit and one discovery chunk against the same scan
// in full mode. `--heap` adds the smallest V8 old space for the commit and the chunk in both modes (relative numbers).
//
// Standard output and report.json carry aggregates only; keys and titles stay in the private output directory.
//
// Usage: node scripts/discovery-ledger-split.mjs plan|rehearse --snapshot /abs/snapshot --output /abs/private/dir [--heap]
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {REPO,layeredBase,loadWorker,overlayStore,snapshotBase} from './discovery-ledger-offline.mjs';
import {verifyProductionSnapshot} from './r2-snapshot-export.mjs';

export class SplitError extends Error{constructor(message,exitCode=1){super(message);this.name='SplitError';this.exitCode=exitCode;}}
const ROOT_LEDGER='epg/discovery-latest.json',SOURCE_COPIES='epg/discovery-archive/v1/sources/',POINTER='epg/published-generation.json',RESOLUTION='epg/discovery-resolution.json';
const sha256=value=>createHash('sha256').update(value).digest('hex');
const uuidFrom=text=>{const h=sha256(text);return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);};
const fileId=key=>sha256(Buffer.from(key,'utf8'));
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const unquote=etag=>etag==null?null:String(etag).replace(/^"(.*)"$/,'$1');
function outside(target,label){
 if(typeof target!=='string'||!path.isAbsolute(target))throw new SplitError(label+' must be an absolute path',2);
 const resolved=path.resolve(target);
 if(resolved===REPO||resolved.startsWith(REPO+path.sep))throw new SplitError(label+' must be outside the Git repository',2);
 return resolved;
}
const bump=(counts,key)=>{counts[key]=(counts[key]||0)+1;};
let peakRss=0;const sampleMemory=()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);};

async function openSnapshot(snapshot){
 const dir=outside(snapshot,'--snapshot'),verified=await verifyProductionSnapshot(dir);
 if(verified.status!=='consistent_fenced')throw new SplitError('The snapshot is not consistent_fenced',3);
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')),byKey=new Map(manifest.objects.map(entry=>[entry.key,entry]));
 const bytesOf=key=>byKey.has(key)?fs.readFileSync(path.join(dir,byKey.get(key).file)):null;
 return {dir,manifest,byKey,bytesOf,verified,base:snapshotBase(dir,manifest)};
}

// The split of one full ledger, deterministic for a given snapshot: ids derive from the source ledger's SHA-256.
export function planSplit({ledgerBytes,ledgerEntry,generationEntry,pointerEntry,pointer,resolution,archivePresent,cutAt,context}){
 const stops=[],P=pointer?.phase==='published'?pointer.programmeRunId||null:null;
 if(!P)stops.push('no_published_generation');
 if(!ledgerBytes)stops.push('no_ledger');
 if(archivePresent)stops.push('already_split');
 if(ledgerEntry&&generationEntry?.sha256!==ledgerEntry.sha256)stops.push('root_differs_from_generation');
 const ledger=ledgerBytes?JSON.parse(ledgerBytes.toString('utf8')):null,items=Array.isArray(ledger?.items)?ledger.items:[];
 if(ledger&&!Array.isArray(ledger.items))stops.push('ledger_without_items');
 if(ledger?.ledgerMode)stops.push('already_split');
 if(ledger&&P&&ledger.programmeRunId!==P)stops.push('ledger_run_mismatch');
 const canonical=vm.runInContext('canonicalDiscoveryCandidate',context),segmentOf=vm.runInContext('ledgerArchiveSegment',context);
 const segmentKey=vm.runInContext('ledgerArchiveSegmentKey',context),manifestKey=vm.runInContext('ledgerArchiveManifestKey',context);
 const count=vm.runInContext('LEDGER_ARCHIVE_SEGMENTS',context),pointerKey=vm.runInContext('LEDGER_ARCHIVE_POINTER',context);
 const keys=new Set(),checks={duplicateKeys:0,noncanonicalKeys:{active:0,archived:0},unmarked:0,activeRunMismatch:0};
 for(const item of items){
  if(keys.has(item.key))checks.duplicateKeys++;keys.add(item.key);
  // Canonicalization is not idempotent for some titles (a trailing year-like number): full mode re-keys such a record at
  // its next commit, the archive keeps it verbatim. A finding, not a stop: the next-commit parity measures its effect.
  if(canonical(item).key!==item.key)checks.noncanonicalKeys[item.seenInLatestSnapshot===true?'active':'archived']++;
  if(typeof item.seenInLatestSnapshot!=='boolean')checks.unmarked++;
  else if(item.seenInLatestSnapshot&&item.lastSeenProgrammeRunId!==P)checks.activeRunMismatch++;
 }
 if(checks.duplicateKeys)stops.push('duplicate_keys');
 if(checks.unmarked)stops.push('unmarked_items');
 if(checks.activeRunMismatch)stops.push('active_run_mismatch');
 // Exact boundary: active = the published scan's keys (seenInLatestSnapshot true); every other record moves verbatim.
 const active=items.filter(item=>item.seenInLatestSnapshot===true),departures=items.filter(item=>item.seenInLatestSnapshot!==true);
 const sourceSha=ledgerEntry?.sha256||sha256(ledgerBytes||''),writeId=uuidFrom('air-221|segments|'+sourceSha+'|'+P),manifestId=uuidFrom('air-221|manifest|'+sourceSha+'|'+P);
 const envelope={archivedAt:cutAt,archivedFromProgrammeRunId:P,archiveWriteId:writeId},bySegment=new Map();
 for(const payload of departures){const segment=segmentOf(payload.key,count);if(!bySegment.has(segment))bySegment.set(segment,{});bySegment.get(segment)[payload.key]={payload,envelope};}
 // A write-once copy of the source ledger comes first: both live copies are replaced, so this is the rollback copy.
 const writes=[{kind:'source',key:SOURCE_COPIES+manifestId+'/discovery-latest.json',op:'create',text:ledgerBytes?ledgerBytes.toString('utf8'):''}],segments=[];
 for(let segment=0;segment<count;segment++){
  const segmentItems=bySegment.get(segment);
  if(!segmentItems){segments.push({segment,object:null,sha256:null,items:0,bytes:0});continue;}
  const text=JSON.stringify({schemaVersion:1,segment,writeId,items:segmentItems}),object=segmentKey(segment,writeId),bytes=Buffer.byteLength(text);
  segments.push({segment,object,sha256:sha256(text),items:Object.keys(segmentItems).length,bytes});
  writes.push({kind:'segment',key:object,op:'create',text});
 }
 const totals={items:segments.reduce((n,entry)=>n+entry.items,0),bytes:segments.reduce((n,entry)=>n+entry.bytes,0)};
 const manifest={schemaVersion:1,manifestId,parentManifestId:null,segmentCount:count,hash:'fnv1a32-utf8',segments,totals,upsertedKeys:departures.map(record=>record.key).sort(),writer:{runId:null,kind:'split',basedOnProgrammeRunId:P,basedOnPointerEtag:unquote(pointerEntry?.metadata?.etag),leaseId:null,writtenAt:cutAt,source:{key:ROOT_LEDGER,sha256:sourceSha}}};
 writes.push({kind:'manifest',key:manifestKey(manifestId),op:'create',text:JSON.stringify(manifest)});
 // The archive pointer moves before the active ledger is replaced: a Worker that meets an archive pointer never takes the
 // legacy full path, so a stop between the two leaves the full ledger plus an archive, which every mode reads losslessly.
 writes.push({kind:'pointer',key:pointerKey,op:'create',text:JSON.stringify({manifestId})});
 const {items:_items,...meta}=ledger||{};
 const activeLedger={...meta,items:active,ledgerMode:'bounded',archive:{version:'v1',manifestId,segments:count,items:totals.items,bytes:totals.bytes,alsoArchived:[],uniqueArchivedItems:totals.items}};
 // The generation copy is what every Worker reader and the next commit load; the root key follows so both stay equal.
 const activeText=JSON.stringify(activeLedger);
 if(generationEntry)writes.push({kind:'active-generation',key:generationEntry.key,op:'replace',expectedEtag:unquote(generationEntry.metadata?.etag),expectedSha256:generationEntry.sha256,text:activeText});
 writes.push({kind:'active-root',key:ROOT_LEDGER,op:'replace',expectedEtag:unquote(ledgerEntry?.metadata?.etag),expectedSha256:ledgerEntry?.sha256||null,text:activeText});
 for(const write of writes){write.sha256=sha256(write.text);write.bytes=Buffer.byteLength(write.text);}
 const fence={pointer:{key:POINTER,etag:unquote(pointerEntry?.metadata?.etag),programmeRunId:P},resolution:resolution?{key:RESOLUTION}:null};
 return {stops:[...new Set(stops)],checks,P,ledger,items,active,departures,manifest,writes,fence,sourceSha,writeId,manifestId};
}

// Aggregates of a split: sizes, activity classes, decisions and screening by side. No key or title.
function describe(split,decisions,now,context,sourceBytes){
 const activity=vm.runInContext('candidateActivity',context),screened=vm.runInContext('screenedNonfilmReason',context);
 const side=records=>{
  const out={items:records.length,activity:{},decisions:{},confirmedTmdbId:0,screenedWithoutExclusion:0,returnable:0};
  for(const item of records){
   const decision=decisions?.[item.key],status=decision?.status||'none';bump(out.activity,activity(item,now));bump(out.decisions,status);
   if(item.confirmedTmdbId)out.confirmedTmdbId++;
   const reason=screened(item,decision);if(reason&&status!=='excluded_nonfilm')out.screenedWithoutExclusion++;
   // Returnable: work the resolver would take up again if the candidate re-entered (no decision, or not verified/excluded).
   if(!reason&&status!=='verified'&&status!=='excluded_nonfilm')out.returnable++;
  }
  return out;
 };
 const write=kind=>split.writes.filter(entry=>entry.kind===kind),segmentSizes=write('segment').map(entry=>entry.bytes);
 return {
  source:{...side(split.items),bytes:sourceBytes},
  active:{...side(split.active),bytes:write('active-root')[0]?.bytes||0},
  archived:{...side(split.departures),bytes:split.manifest.totals.bytes,segmentVersions:segmentSizes.length,maxSegmentBytes:Math.max(0,...segmentSizes),manifestBytes:write('manifest')[0]?.bytes||0},
  checks:split.checks
 };
}

export async function plan({snapshot,output}){
 const out=outside(output,'--output'),started=Date.now();
 const snap=await openSnapshot(snapshot),context=loadWorker();sampleMemory();
 const pointerBytes=snap.bytesOf(POINTER),pointer=pointerBytes?JSON.parse(pointerBytes.toString('utf8')):null,P=pointer?.programmeRunId;
 const ledgerBytes=snap.bytesOf(ROOT_LEDGER),resolutionBytes=snap.bytesOf(RESOLUTION),decisions=resolutionBytes?JSON.parse(resolutionBytes.toString('utf8')):{};
 const archivePresent=[...snap.byKey.keys()].some(key=>key.startsWith('epg/discovery-archive/'));
 const split=planSplit({ledgerBytes,ledgerEntry:snap.byKey.get(ROOT_LEDGER),generationEntry:P?snap.byKey.get('epg/generations/'+P+'/discovery-latest.json'):null,pointerEntry:snap.byKey.get(POINTER),pointer,resolution:resolutionBytes,archivePresent,cutAt:snap.manifest.finishedAt,context});sampleMemory();
 const now=Date.parse(snap.manifest.finishedAt)||Date.now(),summary=describe(split,decisions,now,context,ledgerBytes?.length||0);
 fs.mkdirSync(path.join(out,'objects'),{recursive:true,mode:0o700});
 const writes=split.writes.map(({text,...entry})=>{const file='objects/'+fileId(entry.key)+'.json';fs.writeFileSync(path.join(out,file),text);return {...entry,file};});
 const planned={schemaVersion:1,kind:'discovery-ledger-split',createdAt:new Date().toISOString(),snapshot:{aggregateSha256:snap.verified.aggregateSha256,objects:snap.verified.objects,finishedAt:snap.manifest.finishedAt},sourceLedger:{key:ROOT_LEDGER,sha256:split.sourceSha},manifestId:split.manifestId,writeId:split.writeId,stops:split.stops,fence:split.fence,writes};
 fs.writeFileSync(path.join(out,'plan.json'),JSON.stringify(planned,null,1));
 sampleMemory();
 const report={mode:'plan',verdict:split.stops.length?'NO-GO':'READY',stops:split.stops,snapshot:planned.snapshot,writes:{segments:writes.filter(w=>w.kind==='segment').length,total:writes.length,bytes:writes.reduce((n,w)=>n+w.bytes,0)},...summary,memory:{peakRssMB:Math.round(peakRss/1048576)},seconds:Math.round((Date.now()-started)/1000)};
 fs.writeFileSync(path.join(out,'plan-report.json'),JSON.stringify(report,null,1));
 return {plan:planned,report,split,decisions,snap,context};
}

export function loadPlan(output){
 const out=outside(output,'--output'),planned=JSON.parse(fs.readFileSync(path.join(out,'plan.json'),'utf8'));
 if(planned?.kind!=='discovery-ledger-split'||planned.schemaVersion!==1)throw new SplitError('Not a discovery ledger split plan',2);
 return {...planned,writes:planned.writes.map(write=>({...write,text:fs.readFileSync(path.join(out,write.file),'utf8')}))};
}

// Applies a plan to an R2-like store (an R2 binding, or the offline overlay). Every precondition is checked before the
// first write; each write re-checks the fence (published pointer, the discovery lease, no EPG commit in stage `epg`).
// Create-only writes skip an object that already holds the planned bytes and stop on any other; each ledger copy is
// replaced only by a CAS on the source ledger's ETag, or skipped when it already holds the planned bytes. A rerun
// after any stop completes the same state; a rerun after success writes nothing. `failAfter` simulates a kill (tests).
export async function applySplit(env,planned,{context,failAfter=null}={}){
 const store=env.BUCKET,result={applied:0,skipped:0,writes:[]};
 if(planned.stops?.length)throw new SplitError('The plan has stops: '+planned.stops.join(','),3);
 for(const write of planned.writes)if(sha256(write.text)!==write.sha256)throw new SplitError('Planned object does not match its checksum',3);
 const fence=async lease=>{
  const pointer=await store.get(planned.fence.pointer.key);if(unquote(pointer?.etag)!==planned.fence.pointer.etag)throw new SplitError('Fence lost: published generation changed',3);
  const run=await store.get('sync.json'),body=run?await run.json():null;if(body?.stage==='epg')throw new SplitError('Fence lost: an EPG commit is in progress',3);
  if(lease&&!await vm.runInContext('renewDiscoveryLease',context)(env,lease))throw new SplitError('Fence lost: discovery lease',3);
 };
 const state=async write=>{
  const object=await store.get(write.key);if(!object)return 'absent';
  const text=await object.text();if(sha256(text)===write.sha256)return 'done';
  if(write.op==='replace'&&unquote(object.etag)===write.expectedEtag&&sha256(text)===write.expectedSha256)return 'source';
  return 'conflict';
 };
 // Preflight: nothing is written unless every planned object is absent, already done, or (the ledger) still the source.
 await fence(null);
 for(const write of planned.writes){const seen=await state(write);if(seen==='conflict'||write.op==='replace'&&seen==='absent')throw new SplitError('Precondition failed for a planned '+write.kind,3);}
 const lease=await vm.runInContext('acquireDiscoveryLease',context)(env);if(!lease)throw new SplitError('The discovery lease is held',3);
 try{
  for(const write of planned.writes){
   const seen=await state(write);
   if(seen==='done'){result.skipped++;continue;}
   if(seen==='conflict')throw new SplitError('Precondition failed for a planned '+write.kind,3);
   if(failAfter!==null&&result.applied>=failAfter)throw new SplitError('Simulated kill',9);
   await fence(lease);
   const onlyIf=write.op==='create'?{etagDoesNotMatch:'*'}:{etagMatches:write.expectedEtag};
   const saved=await store.put(write.key,write.text,{onlyIf,httpMetadata:{contentType:'application/json'}});
   if(saved===null)throw new SplitError('Conditional write lost for a planned '+write.kind,3);
   result.applied++;result.writes.push(write.kind);
  }
 }finally{await vm.runInContext('releaseDiscoveryLease',context)(env,lease);}
 return result;
}

// Reads back an applied split as an offline reader does (section 4 of ADR 0034): the active ledger, the manifest it names
// and exactly that manifest's segment versions, each checked against its SHA-256.
async function readSplit(store,context){
 const active=await vm.runInContext('loadJSON',context)({BUCKET:store},ROOT_LEDGER),manifestId=active?.archive?.manifestId;
 const manifestObject=await store.get('epg/discovery-archive/v1/manifests/'+manifestId+'.json'),manifest=manifestObject?await manifestObject.json():null;
 if(!manifest)throw new SplitError('Archive manifest missing',3);
 const archived=new Map();
 for(const entry of manifest.segments){
  if(!entry.object)continue;
  const text=await (await store.get(entry.object)).text();if(sha256(text)!==entry.sha256)throw new SplitError('Archive segment checksum mismatch',3);
  for(const [key,value] of Object.entries(JSON.parse(text).items))archived.set(key,value.payload);
 }
 return {active,manifest,archived};
}
// Payload parity of a reconstruction (active wins over archive) against a full ledger, by key.
function parity(expectedItems,activeItems,archived){
 const expected=new Map(expectedItems.map(item=>[item.key,stable(item)])),actual=new Map();
 for(const [key,payload] of archived)actual.set(key,stable(payload));
 let duplicates=0;for(const item of activeItems){if(archived.has(item.key))duplicates++;actual.set(item.key,stable(item));}
 let missing=0,differing=0,extra=0;
 for(const [key,value] of expected){if(!actual.has(key))missing++;else if(actual.get(key)!==value)differing++;}
 for(const key of actual.keys())if(!expected.has(key))extra++;
 return {expected:expected.size,reconstructed:actual.size,missing,differing,extra,activeAlsoArchived:duplicates,exact:missing===0&&differing===0&&extra===0};
}
const plannedState=async(store,planned)=>{const out={};for(const write of planned.writes){const object=await store.get(write.key);out[write.key]=object?sha256(await object.text()):null;}return out;};

// The next day's scan, derived from the published one: every 20th active candidate leaves, every 20th archived one returns,
// and every show moves one day later.
// Shows move so that the snapshot's cut maps to now plus one day, which keeps the scan's window current for the chunk.
function nextScan(split,cutAt,now=Date.now()){
 const offset=now-(Date.parse(cutAt||'')||now)+86400000,shift=item=>({...item,shows:(item.shows||[]).map(show=>({...show,start:Number(show.start)+offset,end:Number(show.end)+offset}))});
 const stay=split.active.filter((_,i)=>i%20!==0).map(shift);
 const back=split.departures.filter((_,i)=>i%20===0).map(item=>({...item,shows:[{channelId:'rehearsal',channel:'rehearsal',start:now+3600000,end:now+9000000,epgTitle:item.title}]}));
 return {items:[...stay,...back],leaving:split.active.length-stay.length,returning:back.length,returningKeys:back.map(item=>item.key)};
}
const runIdNext=planned=>uuidFrom('air-221|next|'+planned.manifestId);

async function commit(env,context,runId,scan){
 await env.BUCKET.put('sync.json',JSON.stringify({runId,stage:'epg'}));
 await vm.runInContext('publishGenerationWithLedger',context)(env,runId,scan,{programmeRunId:runId,updatedAt:new Date().toISOString()},{'programme.json':{runId,films:[]}});
 await env.BUCKET.put('sync.json',JSON.stringify({runId,stage:'complete'}));
}
async function chunk(env,context,programmeRunId){
 await env.BUCKET.put('epg/resolver-continuation.json',JSON.stringify({stage:'paused',reason:'epg_committed',at:new Date().toISOString(),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId}));
 const response=await context.worker.fetch(new Request('https://iptv.invalid/api/enrichment/discovery/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:24})}),{...env,TMDB_API_READ_ACCESS_TOKEN:'offline',TMDB_REQUEST_INTERVAL_MS:0},{waitUntil(){}});
 return response.status;
}

export async function rehearse({snapshot,output,heap=false}){
 const out=outside(output,'--output'),started=Date.now();
 const {plan:planned0,report:planReport,split,decisions,snap,context}=await plan({snapshot,output:out});
 const report={mode:'rehearse',plan:planReport,checks:{}};
 if(split.stops.length){report.verdict='NO-GO';report.reasons=['plan_stops'];return finish(out,report,started);}
 const planned=loadPlan(out),work=path.join(out,'work');fs.rmSync(work,{recursive:true,force:true});
 const overlay=name=>{const store=overlayStore(snap.base,path.join(work,name));return {store,env:{BUCKET:store}};};
 const resolutionSha=snap.byKey.get(RESOLUTION)?.sha256||null,resolutionNow=async store=>{const object=await store.get(RESOLUTION);return object?sha256(Buffer.from(await object.arrayBuffer())):null;};
 const checks=report.checks;

 // 1. Install, read back, reconstruct (R2 rollback parity), decisions untouched.
 const installed=overlay('installed'),first=await applySplit(installed.env,planned,{context});sampleMemory();
 const read=await readSplit(installed.store,context),reconstruction=parity(split.items,read.active.items,read.archived);sampleMemory();
 const activeKeys=new Set(read.active.items.map(item=>item.key));
 checks.install={applied:first.applied,skipped:first.skipped,writes:installed.store.writes.filter(key=>key!=='epg/resolver-lease.json').length,activeItems:read.active.items.length,archivedItems:read.archived.size,boundaryExact:read.active.items.length===split.active.length&&split.active.every(item=>activeKeys.has(item.key)),decisionsUntouched:await resolutionNow(installed.store)===resolutionSha,workerReadsActive:read.active.ledgerMode==='bounded',rootEqualsGeneration:await (async()=>{const root=await installed.store.get(ROOT_LEDGER),generation=await installed.store.get('epg/generations/'+planned.fence.pointer.programmeRunId+'/discovery-latest.json');return !!root&&!!generation&&sha256(await root.text())===sha256(await generation.text());})(),sourceCopyExact:await (async()=>{const copy=await installed.store.get(planned.writes[0].key);return !!copy&&sha256(Buffer.from(await copy.arrayBuffer()))===split.sourceSha;})()};
 checks.reconstruction=reconstruction;
 const counts=vm.runInContext('ledgerCounts',context)(read.active,decisions,Date.parse(snap.manifest.finishedAt));
 checks.counts={ledgerTotal:counts.ledgerTotal,sourceItems:split.items.length,exact:counts.ledgerTotal===split.items.length};
 const reference=await plannedState(installed.store,planned);

 // 2. Replay after success: zero writes.
 const before=installed.store.writes.length,replay=await applySplit(installed.env,planned,{context});
 checks.replay={applied:replay.applied,skipped:replay.skipped,plannedWrites:installed.store.writes.slice(before).filter(key=>key!=='epg/resolver-lease.json').length,zeroMutations:replay.applied===0&&installed.store.writes.slice(before).every(key=>key==='epg/resolver-lease.json')};

 // 3. Kills, then resume.
 // Kill after the source copy, a middle segment, the last segment, the manifest, the archive pointer and the generation copy.
 const segmentWrites=planned.writes.filter(write=>write.kind==='segment').length,kills=[...new Set([1,1+Math.max(1,segmentWrites>>1),1+segmentWrites,2+segmentWrites,3+segmentWrites,4+segmentWrites])].filter(n=>n<planned.writes.length);
 checks.resume=[];
 for(const killAfter of kills){
  const run=overlay('kill-'+killAfter);let stopped=false;
  try{await applySplit(run.env,planned,{context,failAfter:killAfter});}catch(error){stopped=error.exitCode===9;}
  const midway=vm.runInContext('ledgerCounts',context)(await vm.runInContext('loadJSON',context)({BUCKET:run.store},ROOT_LEDGER),decisions,Date.parse(snap.manifest.finishedAt));
  const resumed=await applySplit(run.env,planned,{context}),state=await plannedState(run.store,planned);
  checks.resume.push({killAfter,stopped,ledgerTotalWhileStopped:midway.ledgerTotal,resumedApplied:resumed.applied,identical:stable(state)===stable(reference)});
  fs.rmSync(path.join(work,'kill-'+killAfter),{recursive:true,force:true});
 }

 // 4. Refused fences and conflicts: each leaves zero planned writes.
 const negative=async(name,prepare,mutate=planned)=>{
  const run=overlay('neg-'+name);await prepare(run.store);const marker=run.store.writes.length;let refused=false;
  try{await applySplit(run.env,mutate,{context});}catch(error){refused=error instanceof SplitError;}
  const written=run.store.writes.slice(marker).filter(key=>key!=='epg/resolver-lease.json').length;
  fs.rmSync(path.join(work,'neg-'+name),{recursive:true,force:true});
  return {refused,plannedWrites:written};
 };
 const publishedNow=await (await installed.store.get(planned.fence.pointer.key)).json();
 checks.negative={
  publishedGenerationChanged:await negative('pointer',store=>store.put(POINTER,JSON.stringify({...publishedNow,programmeRunId:runIdNext(planned)}))),
  sourceLedgerChanged:await negative('ledger',async store=>store.put(ROOT_LEDGER,JSON.stringify({...split.ledger,updatedAt:'changed'}))),
  epgCommitInProgress:await negative('sync',store=>store.put('sync.json',JSON.stringify({runId:'other',stage:'epg'}))),
  leaseHeld:await negative('lease',store=>store.put('epg/resolver-lease.json',JSON.stringify({id:'other',expiresAt:Date.now()+600000}))),
  conflictingArchiveObject:await negative('conflict',store=>store.put(planned.writes[0].key,'{}')),
  corruptPlannedObject:await negative('corrupt',async()=>{},{...planned,writes:planned.writes.map((write,i)=>i===0?{...write,text:write.text+' '}:write)})
 };

 // 5. The next commit with the same scan: full mode on the untouched snapshot, bounded mode on the installed split.
 const scan=nextScan(split,snap.manifest.finishedAt),S=runIdNext(planned),full=overlay('next-full');
 fs.writeFileSync(path.join(work,'scan.json'),JSON.stringify(scan.items));
 const boundedStore=overlayStore(layeredBase(path.join(work,'installed'),snap.base),path.join(work,'next-bounded'));
 await commit({BUCKET:full.store,DISCOVERY_LEDGER_MODE:'full'},context,S,scan.items);sampleMemory();
 await commit({BUCKET:boundedStore,DISCOVERY_LEDGER_MODE:'bounded'},context,S,scan.items);sampleMemory();
 const fullLedger=await vm.runInContext('loadJSON',context)({BUCKET:full.store},ROOT_LEDGER),after=await readSplit(boundedStore,context),scanKeys=new Set(scan.items.map(item=>vm.runInContext('canonicalDiscoveryCandidate',context)(item).key));
 const afterCounts=vm.runInContext('ledgerCounts',context)(after.active,decisions,Date.now()),activeKeysAfter=new Set(after.active.items.map(item=>item.key));
 checks.nextCommit={scanItems:scan.items.length,leaving:scan.leaving,returning:scan.returning,activeItems:after.active.items.length,boundaryExact:after.active.items.length===scanKeys.size&&after.active.items.every(item=>scanKeys.has(item.key)),parity:parity(fullLedger.items,after.active.items,after.archived),alsoArchived:after.active.archive?.alsoArchived?.length??null,ledgerTotal:afterCounts.ledgerTotal,fullLedgerItems:fullLedger.items.length,countsExact:afterCounts.ledgerTotal===fullLedger.items.length,reentered:scan.returningKeys.filter(key=>activeKeysAfter.has(key)).length,decisionsUntouched:await resolutionNow(boundedStore)===resolutionSha,archiveManifests:(await boundedStore.list({prefix:'epg/discovery-archive/v1/manifests/'})).objects.length};
 // 5b. The same commit with the flag unset (the state right after a production split, before `bounded` is set): a Worker
 // that meets the archive pointer acts as frozen. It must read only the active ledger, archive nothing and lose nothing.
 const frozenStore=overlayStore(layeredBase(path.join(work,'installed'),snap.base),path.join(work,'next-frozen'));
 await commit({BUCKET:frozenStore,DISCOVERY_LEDGER_MODE:'full'},context,S,scan.items);sampleMemory();
 const frozen=await readSplit(frozenStore,context),frozenCounts=vm.runInContext('ledgerCounts',context)(frozen.active,decisions,Date.now());
 checks.frozenCommit={ledgerMode:frozen.active.ledgerMode||null,activeItems:frozen.active.items.length,parity:parity(fullLedger.items,frozen.active.items,frozen.archived),ledgerTotal:frozenCounts.ledgerTotal,countsExact:frozenCounts.ledgerTotal===fullLedger.items.length,readSourceCopy:frozenStore.reads.includes(planned.writes[0].key),archiveWrites:frozenStore.writes.filter(key=>key.startsWith('epg/discovery-archive/')).length,decisionsUntouched:await resolutionNow(frozenStore)===resolutionSha};
 fullLedger.items=null;

 // 6. One discovery chunk after that commit in both modes (TMDB unreachable): decisions of active candidates must agree.
 const chunkReadsFrom=boundedStore.reads.length,fullStatus=await chunk({BUCKET:full.store},context,S),boundedStatus=await chunk({BUCKET:boundedStore},context,S);sampleMemory();
 const decided=async store=>{const object=await store.get(RESOLUTION);return object?await object.json():{};};
 const fullDecisions=await decided(full.store),boundedDecisions=await decided(boundedStore),activeNow=new Set(after.active.items.map(item=>item.key));
 let activeDiffer=0;const archivedDiffer={};
 for(const key of new Set([...Object.keys(fullDecisions),...Object.keys(boundedDecisions)])){const a=fullDecisions[key]?.status||'none',b=boundedDecisions[key]?.status||'none';if(a!==b){if(activeNow.has(key))activeDiffer++;else bump(archivedDiffer,'full:'+a+' bounded:'+b);}}
 checks.chunk={fullHttp:fullStatus,boundedHttp:boundedStatus,activeDecisionsDiffer:activeDiffer,archivedDecisionsDiffer:archivedDiffer,archiveReadsByChunk:boundedStore.reads.slice(chunkReadsFrom).filter(key=>key.startsWith('epg/discovery-archive/')).length};
 if(heap)checks.heap=heapReport(snap.dir,work,S);

 const reasons=[];
 if(!checks.install.boundaryExact)reasons.push('install_boundary');
 if(!checks.install.decisionsUntouched)reasons.push('install_decisions_changed');
 if(!checks.install.workerReadsActive||!checks.install.rootEqualsGeneration)reasons.push('install_not_read_by_worker');
 if(!checks.install.sourceCopyExact)reasons.push('source_copy');
 if(!reconstruction.exact||reconstruction.activeAlsoArchived)reasons.push('reconstruction_parity');
 if(!checks.counts.exact)reasons.push('counts');
 if(!checks.replay.zeroMutations)reasons.push('replay_mutated');
 if(checks.resume.some(entry=>!entry.stopped||!entry.identical||entry.ledgerTotalWhileStopped<split.items.length))reasons.push('resume');
 for(const [name,entry] of Object.entries(checks.negative))if(!entry.refused||entry.plannedWrites)reasons.push('negative_'+name);
 if(!checks.nextCommit.boundaryExact||!checks.nextCommit.parity.exact||!checks.nextCommit.countsExact||!checks.nextCommit.decisionsUntouched)reasons.push('next_commit');
 if(checks.frozenCommit.ledgerMode!=='frozen'||!checks.frozenCommit.parity.exact||!checks.frozenCommit.countsExact||checks.frozenCommit.readSourceCopy||checks.frozenCommit.archiveWrites||!checks.frozenCommit.decisionsUntouched)reasons.push('frozen_commit');
 if(checks.chunk.fullHttp!==200||checks.chunk.boundedHttp!==200||checks.chunk.activeDecisionsDiffer||checks.chunk.archiveReadsByChunk)reasons.push('chunk');
 report.verdict=reasons.length?'NO-GO':'GO';report.reasons=reasons;
 fs.rmSync(work,{recursive:true,force:true});
 return finish(out,report,started);
}
function finish(out,report,started){
 report.memory={peakRssMB:Math.round(peakRss/1048576)};report.seconds=Math.round((Date.now()-started)/1000);
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,1));
 return report;
}

// Smallest V8 old space (MB) at which each scenario completes, in a child process. The commit runs on the snapshot (full)
// or the installed split (bounded, and frozen: the flag unset after a split) with the rehearsal's next scan; the chunk runs
// after that commit in each mode.
function heapReport(snapshot,work,runId){
 const result={};
 for(const scenario of ['full-commit','frozen-commit','bounded-commit','full-chunk','frozen-chunk','bounded-chunk']){
  const run=mb=>spawnSync(process.execPath,[...(mb?['--max-old-space-size='+mb,'--max-semi-space-size=1']:[]),fileURLToPath(import.meta.url),'--child',scenario,snapshot,work,runId],{stdio:'ignore'}).status===0;
  if(!run(null)){result[scenario]='error';continue;}
  let lo=16,hi=2048;while(hi-lo>4){const mid=(lo+hi)>>1;if(run(mid))hi=mid;else lo=mid;}
  result[scenario]=hi;
 }
 return {minOldSpaceMB:result,note:'Node old space, relative only; not the Workers isolate limit'};
}
async function child(scenario,snapshot,work,runId){
 const [mode,step]=scenario.split('-'),manifest=JSON.parse(fs.readFileSync(path.join(snapshot,'manifest.json'),'utf8')),context=loadWorker();
 const dir=fs.mkdtempSync(path.join(work,'child-')),base=snapshotBase(snapshot,manifest);
 try{
  if(step==='commit'){
   const layer=mode==='full'?base:layeredBase(path.join(work,'installed'),base),store=overlayStore(layer,dir);
   await commit({BUCKET:store,DISCOVERY_LEDGER_MODE:mode==='bounded'?'bounded':'full'},context,runId,JSON.parse(fs.readFileSync(path.join(work,'scan.json'),'utf8')));
  }else{
   const layer=mode==='full'?layeredBase(path.join(work,'next-full'),base):layeredBase(path.join(work,'next-'+mode),layeredBase(path.join(work,'installed'),base));
   if(await chunk({BUCKET:overlayStore(layer,dir),DISCOVERY_LEDGER_MODE:mode==='bounded'?'bounded':'full'},context,runId)!==200)throw new Error('chunk failed');
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
 try{
  if(args[0]==='--child'){await child(args[1],args[2],args[3],args[4]);process.exit(0);}
  if(!['plan','rehearse'].includes(args[0]))throw new SplitError('Usage: node scripts/discovery-ledger-split.mjs plan|rehearse --snapshot /abs/snapshot --output /abs/private/dir [--heap]',2);
  const report=args[0]==='plan'?(await plan({snapshot:value('--snapshot'),output:value('--output')})).report:await rehearse({snapshot:value('--snapshot'),output:value('--output'),heap:args.includes('--heap')});
  console.log(JSON.stringify(report,null,1));
  process.exit(report.verdict==='NO-GO'?3:0);
 }catch(error){console.error(error instanceof SplitError?error.message:'Split failed: '+error.message);process.exit(error.exitCode||1);}
}
