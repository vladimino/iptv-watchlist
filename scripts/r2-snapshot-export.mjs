// Local read-only exporter of the production R2 bucket into the snapshot manifest shape.
// It speaks the S3-compatible API with a scoped credential taken from the local environment only,
// sends GET and HEAD requests and nothing else, and produces the consistency proof decided for the
// live backfill: conditional reads of each listed version, an opening and a closing inventory, and a
// final fence on the coordination objects. An attempt that cannot produce the proof is an explicit NO-GO.
// Running it against production is a separately approved action; this module grants none.
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readdir,readFile,rename,rm,unlink,writeFile} from 'node:fs/promises';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ExportError,manifestFor,verifySnapshot} from './migration-export.mjs';

export const DEFAULT_BUCKET='iptv';
export const SOURCE_KIND='cloudflare-r2-s3';
export const STATUS_CONSISTENT='consistent_fenced';
export const STATUS_NO_GO='no_go';
// Objects every leased or run-scoped writer rewrites: unchanged ETags after the closing listing prove a quiescent interval.
export const FENCE_KEYS=Object.freeze(['epg/resolver-lease.json','enrichment/writer-lease.json','enrichment/runner-lease.json','epg/published-generation.json','sync.json','epg/resolver-continuation.json','enrichment/profile/current.json']);
// Objects whose fields label the cut. They are read from the downloaded bytes, never from extra requests.
export const IDENTITY_KEYS=Object.freeze({publishedGeneration:'epg/published-generation.json',sync:'sync.json',continuation:'epg/resolver-continuation.json',latestEnrichmentRun:'enrichment/latest-run.json'});
const READ_METHODS=new Set(['GET','HEAD']);
const TRANSIENT=new Set([429,500,502,503,504]);
const REPO_ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const PAGE_SIZE=1000;
const sha256=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const EMPTY_SHA256=sha256('');
const fileId=key=>sha256(Buffer.from(key,'utf8'));
const objectPath=(directory,key)=>path.join(directory,'objects',fileId(key)+'.bin');
const entryPath=(directory,key)=>path.join(directory,'entries',fileId(key)+'.json');
const defaultSleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const sameVersion=(a,b)=>a.etag===b.etag&&a.size===b.size;

export class NoGo extends Error{constructor(reasons,details={}){super('Export attempt is NO-GO: '+reasons.join(', '));this.name='NoGo';this.reasons=reasons;this.details=details;}}

// Credentials come from the local environment only and are never written anywhere. A plaintext endpoint is accepted for loopback only.
export function readCredentials(env=process.env){
 const accountId=String(env.R2_SNAPSHOT_ACCOUNT_ID||'').trim(),accessKeyId=String(env.R2_SNAPSHOT_ACCESS_KEY_ID||'').trim(),secretAccessKey=String(env.R2_SNAPSHOT_SECRET_ACCESS_KEY||'').trim();
 const bucket=String(env.R2_SNAPSHOT_BUCKET||DEFAULT_BUCKET).trim();
 if(!/^[0-9a-f]{32}$/.test(accountId))throw new ExportError('configuration','R2_SNAPSHOT_ACCOUNT_ID must be the 32-character account id');
 if(!accessKeyId||!secretAccessKey)throw new ExportError('configuration','R2_SNAPSHOT_ACCESS_KEY_ID and R2_SNAPSHOT_SECRET_ACCESS_KEY are required in the environment');
 if(!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket))throw new ExportError('configuration','R2_SNAPSHOT_BUCKET is not a bucket name');
 const endpoint=endpointFor(accountId,env.R2_SNAPSHOT_ENDPOINT);
 return {accountId,accessKeyId,secretAccessKey,bucket,endpoint,endpointOverride:!!String(env.R2_SNAPSHOT_ENDPOINT||'').trim()};
}
function endpointFor(accountId,override){
 const value=String(override||'').trim();
 if(!value)return 'https://'+accountId+'.r2.cloudflarestorage.com';
 let url;try{url=new URL(value);}catch{throw new ExportError('configuration','R2_SNAPSHOT_ENDPOINT is not a URL');}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))throw new ExportError('configuration','R2_SNAPSHOT_ENDPOINT must be https, or http on loopback for a local test server');
 if(url.pathname!=='/'||url.search||url.hash)throw new ExportError('configuration','R2_SNAPSHOT_ENDPOINT must be an origin without a path');
 return url.origin;
}

// AWS Signature Version 4 for S3-compatible endpoints. Pure functions over the request; no clock other than the one given.
export function rfc3986(value){return encodeURIComponent(value).replace(/[!'()*]/g,character=>'%'+character.charCodeAt(0).toString(16).toUpperCase());}
export function canonicalPath(pathname){return pathname.split('/').map(segment=>rfc3986(decodeURIComponent(segment))).join('/')||'/';}
export function signRequest({method,url,headers={},payloadHash=EMPTY_SHA256,credentials,region='auto',service='s3',now=new Date()}){
 const target=new URL(url);
 const amzDate=now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'),date=amzDate.slice(0,8);
 const signedHeaders={host:target.host,...Object.fromEntries(Object.entries(headers).map(([name,value])=>[name.toLowerCase(),String(value).trim().replace(/\s+/g,' ')])),'x-amz-content-sha256':payloadHash,'x-amz-date':amzDate};
 const names=Object.keys(signedHeaders).sort();
 const query=[...target.searchParams.entries()].map(([name,value])=>[rfc3986(name),rfc3986(value)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0).map(pair=>pair.join('=')).join('&');
 const canonical=[method.toUpperCase(),canonicalPath(target.pathname),query,...names.map(name=>name+':'+signedHeaders[name]),'',names.join(';'),payloadHash].join('\n');
 const scope=date+'/'+region+'/'+service+'/aws4_request';
 const stringToSign=['AWS4-HMAC-SHA256',amzDate,scope,sha256(canonical)].join('\n');
 const signingKey=hmac(hmac(hmac(hmac('AWS4'+credentials.secretAccessKey,date),region),service),'aws4_request');
 const signature=createHmac('sha256',signingKey).update(stringToSign).digest('hex');
 const {host,...sent}=signedHeaders;
 return {...sent,Authorization:'AWS4-HMAC-SHA256 Credential='+credentials.accessKeyId+'/'+scope+', SignedHeaders='+names.join(';')+', Signature='+signature};
}

// A client that can only read. Any other method is refused before a request exists.
export function createReadOnlyClient({credentials,fetchImpl=fetch,retries=4,sleep=defaultSleep,now=()=>new Date(),timeoutMs=600000}){
 const calls={list:0,head:0,get:0};
 async function send(method,key,query,extraHeaders={}){
  if(!READ_METHODS.has(method))throw new ExportError('configuration','Exporter sends read commands only');
  const url=new URL(credentials.endpoint);
  url.pathname='/'+rfc3986(credentials.bucket)+(key==null?'':'/'+key.split('/').map(rfc3986).join('/'));
  for(const [name,value] of Object.entries(query||{}))if(value!=null)url.searchParams.set(name,value);
  for(let attempt=0;;attempt++){
   // identity: Cloudflare otherwise compresses on the fly, weakening the ETag (so If-Match fails) and changing the bytes fetch hashes.
   const headers=signRequest({method,url,headers:{'Accept-Encoding':'identity',...extraHeaders},credentials,now:now()});
   let response;
   try{response=await fetchImpl(url,{method,headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(timeoutMs)});}
   catch{if(attempt<retries){await sleep(100*2**attempt);continue;}throw new ExportError('network','Source request failed after retries');}
   if(TRANSIENT.has(response.status)&&attempt<retries){await response.body?.cancel();await sleep(100*2**attempt);continue;}
   if(response.status===412){await response.body?.cancel();throw new ExportError('source_changed','Listed version of '+key+' is no longer current');}
   if(response.status===404&&key!=null){await response.body?.cancel();return null;}
   if(response.status===401||response.status===403){await response.body?.cancel();throw new ExportError('authorization','Credential was refused by the bucket');}
   if(!response.ok){await response.body?.cancel();throw new ExportError('source_http','Source request failed with HTTP '+response.status);}
   return response;
  }
 }
 return {
  calls,
  async list(cursor){calls.list++;const response=await send('GET',null,{'list-type':'2','max-keys':String(PAGE_SIZE),...(cursor?{'continuation-token':cursor}:{})});const page=parseListing(await response.text());return page;},
  async head(key,{ifMatch}={}){calls.head++;const response=await send('HEAD',key,null,ifMatch?{'If-Match':quoteEtag(ifMatch)}:{});if(!response)return null;await response.body?.cancel();return headMetadata(key,response);},
  async get(key,{ifMatch}={}){calls.get++;const response=await send('GET',key,null,ifMatch?{'If-Match':quoteEtag(ifMatch)}:{});if(!response)return null;return {...headMetadata(key,response),body:response.body};},
 };
}
function quoteEtag(etag){return /^".*"$/.test(etag)?etag:'"'+etag+'"';}
function unquoteEtag(etag){return String(etag||'').trim().replace(/^"(.*)"$/,'$1');}
function headMetadata(key,response){
 const encoding=(response.headers.get('content-encoding')||'identity').trim().toLowerCase();
 if(encoding!=='identity')throw new ExportError('protocol','Object response is content-encoded; raw bytes are required');
 if(/^W\//.test(String(response.headers.get('etag')||'').trim()))throw new ExportError('protocol','Object response carries a weak ETag');
 const size=Number(response.headers.get('content-length'));
 const etag=unquoteEtag(response.headers.get('etag'));
 if(!etag||!Number.isSafeInteger(size)||size<0)throw new ExportError('protocol','Object response lacks ETag or Content-Length');
 return {key,size,etag,lastModified:response.headers.get('last-modified')||null};
}
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
function decodeXml(text){return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g,(match,code)=>code[0]==='#'?String.fromCodePoint(code[1]==='x'?parseInt(code.slice(2),16):parseInt(code.slice(1),10)):entities[code]??match);}
function element(block,name){const match=block.match(new RegExp('<'+name+'>([\\s\\S]*?)</'+name+'>'));return match?decodeXml(match[1]):null;}
export function parseListing(xml){
 if(typeof xml!=='string'||!/<ListBucketResult[\s>]/.test(xml))throw new ExportError('protocol','Listing response is not a bucket listing');
 const truncatedText=element(xml,'IsTruncated');
 if(truncatedText!=='true'&&truncatedText!=='false')throw new ExportError('protocol','Listing page lacks IsTruncated');
 const truncated=truncatedText==='true';
 const nextCursor=element(xml,'NextContinuationToken');
 if(truncated&&!nextCursor)throw new ExportError('protocol','Truncated listing page lacks a continuation token');
 const objects=[];
 for(const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g)||[]){
  const key=element(block,'Key'),size=Number(element(block,'Size')),etag=unquoteEtag(element(block,'ETag')),lastModified=element(block,'LastModified');
  if(!key||!Number.isSafeInteger(size)||size<0||!etag)throw new ExportError('protocol','Invalid listing metadata');
  objects.push({key,size,etag,lastModified});
 }
 return {objects,truncated,nextCursor:truncated?nextCursor:null};
}

async function atomicJson(filename,value){const temporary=filename+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temporary,filename);}
async function jsonIfPresent(filename){try{return JSON.parse(await readFile(filename,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function hashFile(filename){const hash=createHash('sha256');let size=0;for await(const chunk of createReadStream(filename)){hash.update(chunk);size+=chunk.length;}return {sha256:hash.digest('hex'),size};}
function collectPages(records){
 const objects=[],keys=new Set();let expectedCursor=null,complete=false;
 for(const record of records){
  if(record.requestCursor!==expectedCursor||complete)throw new ExportError('listing','Broken listing cursor chain');
  for(const object of record.page.objects){if(keys.has(object.key))throw new ExportError('listing','Duplicate key in listing');keys.add(object.key);objects.push(object);}
  if(record.page.truncated){if(record.page.nextCursor===expectedCursor)throw new ExportError('listing','Repeated listing cursor');expectedCursor=record.page.nextCursor;}
  else{complete=true;expectedCursor=null;}
 }
 return {objects,nextCursor:expectedCursor,complete};
}
// The opening listing is checkpointed page by page so an interrupted attempt resumes from the last durable cursor.
async function openingListing(directory,client){
 const pagesDirectory=path.join(directory,'pages');await mkdir(pagesDirectory,{recursive:true,mode:0o700});
 const names=(await readdir(pagesDirectory)).filter(name=>/^\d{8}\.json$/.test(name)).sort();const records=[];
 for(const [index,name] of names.entries()){
  if(name!==String(index).padStart(8,'0')+'.json')throw new ExportError('listing','Missing listing page checkpoint');
  records.push(JSON.parse(await readFile(path.join(pagesDirectory,name),'utf8')));
 }
 let current=collectPages(records);
 while(!current.complete){
  const cursor=current.nextCursor,page=await client.list(cursor);
  records.push({requestCursor:cursor,page});
  current=collectPages(records);
  await atomicJson(path.join(pagesDirectory,String(records.length-1).padStart(8,'0')+'.json'),records.at(-1));
 }
 return {objects:current.objects,pages:records.length};
}
async function closingListing(client){
 const records=[];let cursor=null;
 do{const page=await client.list(cursor);records.push({requestCursor:cursor,page});collectPages(records);cursor=page.nextCursor;}while(cursor);
 return collectPages(records).objects;
}
async function conditionalHead(client,object){
 const current=await client.head(object.key,{ifMatch:object.etag});
 if(!current)throw new ExportError('source_changed','Listed object '+object.key+' is missing');
 if(!sameVersion(current,object))throw new ExportError('source_changed','Listed version of '+object.key+' is no longer current');
 return current;
}
// Each stored byte sequence is provably the listed version of its key: a conditional HEAD before, a conditional GET whose
// ETag and length are checked, and a conditional HEAD after. A checkpoint of the same version is reused after its hash is re-read.
async function downloadObject(directory,client,object){
 const saved=await jsonIfPresent(entryPath(directory,object.key));
 if(saved&&saved.key===object.key&&sameVersion(saved.metadata,object)){
  let actual=null;try{actual=await hashFile(objectPath(directory,object.key));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(actual&&actual.sha256===saved.sha256&&actual.size===saved.size){await conditionalHead(client,object);return {...saved,resumed:true};}
 }
 if(saved){try{await unlink(entryPath(directory,object.key));}catch{}}
 await conditionalHead(client,object);
 for(let attempt=0;;attempt++){
  const temporary=objectPath(directory,object.key)+'.'+randomUUID()+'.tmp';
  try{
   const response=await client.get(object.key,{ifMatch:object.etag});
   if(!response)throw new ExportError('source_changed','Listed object '+object.key+' is missing');
   if(!sameVersion(response,object))throw new ExportError('source_changed','Object response differs from the listing for '+object.key);
   const hash=createHash('sha256');let size=0;
   const measure=new Transform({transform(chunk,encoding,callback){hash.update(chunk);size+=chunk.length;callback(null,chunk);}});
   await pipeline(Readable.fromWeb(response.body),measure,createWriteStream(temporary,{flags:'wx',mode:0o600}));
   if(size!==object.size)throw new ExportError('integrity','Downloaded size differs from the listing for '+object.key);
   await conditionalHead(client,object);
   const entry={key:object.key,file:'objects/'+fileId(object.key)+'.bin',size,sha256:hash.digest('hex'),metadata:{key:object.key,size:object.size,etag:object.etag,lastModified:object.lastModified??null}};
   await rename(temporary,objectPath(directory,object.key));
   await atomicJson(entryPath(directory,object.key),entry);
   return {...entry,resumed:false};
  }catch(error){
   try{await unlink(temporary);}catch{}
   if(error instanceof ExportError&&['source_changed','integrity','authorization','configuration'].includes(error.kind))throw error;
   if(attempt>=3)throw new ExportError('network','Object stream failed after retries for '+object.key);
   await defaultSleep(100*2**attempt);
  }
 }
}
export function inventoryDelta(before,after){
 const left=new Map(before.map(item=>[item.key,item])),right=new Map(after.map(item=>[item.key,item]));const result=[];
 for(const [key,object] of left){if(!right.has(key))result.push({key,reason:'missing_after'});else if(!sameVersion(object,right.get(key)))result.push({key,reason:'metadata_changed'});}
 for(const key of right.keys())if(!left.has(key))result.push({key,reason:'added_after'});
 return result;
}
// The fence runs after the closing listing has finished and compares each coordination object with the opening listing.
async function fence(client,opening){
 const byKey=new Map(opening.map(item=>[item.key,item]));const keys=[];
 for(const key of FENCE_KEYS){
  const before=byKey.get(key)||null,after=await client.head(key);
  const status=!before&&!after?'absent':!before&&after?'created':before&&!after?'missing_after':before.etag===after.etag?'unchanged':'changed';
  keys.push({key,openingEtag:before?.etag??null,closingEtag:after?.etag??null,status});
 }
 return {ok:keys.every(item=>item.status==='unchanged'||item.status==='absent'),keys};
}
async function baselineIdentity(directory,entries){
 const byKey=new Map(entries.map(entry=>[entry.key,entry]));
 const read=async key=>{const entry=byKey.get(key);if(!entry)return null;try{return JSON.parse(await readFile(path.join(directory,entry.file),'utf8'));}catch{return null;}};
 const published=await read(IDENTITY_KEYS.publishedGeneration),sync=await read(IDENTITY_KEYS.sync),continuation=await read(IDENTITY_KEYS.continuation),latest=await read(IDENTITY_KEYS.latestEnrichmentRun);
 return {publishedProgrammeRunId:published?.programmeRunId??null,syncUpdatedAt:sync?.updatedAt??null,continuationAt:continuation?.at??null,continuationHopId:continuation?.hopId??null,latestEnrichmentRunId:latest?.runId??null};
}
function sourceIdentity(credentials){return {kind:SOURCE_KIND,bucket:credentials.bucket,accountId:credentials.accountId,endpoint:new URL(credentials.endpoint).host,endpointOverride:credentials.endpointOverride,exporter:'scripts/r2-snapshot-export.mjs',readOnly:true};}
function outsideRepository(directory){
 const absolute=path.resolve(directory);
 if(!path.isAbsolute(directory)||absolute===REPO_ROOT||absolute.startsWith(REPO_ROOT+path.sep))throw new ExportError('configuration','Snapshot directory must be an absolute path outside the Git repository');
 return absolute;
}

// One export attempt. Returns the verified result on a fenced consistent cut; throws NoGo (after writing report.json) when the proof fails.
export const MAX_CONCURRENCY=16;
// `--concurrency N` (1..16, default 1): how many objects are verified at once. Each object still gets its own conditional
// HEAD, GET and HEAD; only the waiting overlaps. Listings, the fence and the manifest are unchanged and sequential. The first
// failure stops new work; objects already in flight finish their read-only requests before the attempt ends.
export function parseConcurrency(value){
 if(value==null)return 1;
 const number=Number(value);
 if(!Number.isInteger(number)||number<1||number>MAX_CONCURRENCY)throw new ExportError('configuration','Concurrency must be an integer from 1 to '+MAX_CONCURRENCY);
 return number;
}
export async function eachWithConcurrency(items,concurrency,work){
 const results=new Array(items.length);let next=0,failure=null;
 const worker=async()=>{
  while(failure===null&&next<items.length){const index=next++;try{results[index]=await work(items[index],index);}catch(error){failure??=error;}}
 };
 await Promise.all(Array.from({length:Math.min(concurrency,items.length)},worker));
 if(failure!==null)throw failure;
 return results;
}
export async function exportProductionSnapshot({directory,credentials,fetchImpl=fetch,now=()=>new Date(),sleep=defaultSleep,concurrency=1}){
 const absolute=outsideRepository(directory);
 await mkdir(absolute,{recursive:true,mode:0o700});await mkdir(path.join(absolute,'objects'),{recursive:true,mode:0o700});await mkdir(path.join(absolute,'entries'),{recursive:true,mode:0o700});
 const client=createReadOnlyClient({credentials,fetchImpl,now,sleep});
 const source=sourceIdentity(credentials);
 const startedAt=(await jsonIfPresent(path.join(absolute,'run.json')))?.startedAt||now().toISOString();
 await atomicJson(path.join(absolute,'run.json'),{schemaVersion:1,startedAt,source});
 const report=extra=>atomicJson(path.join(absolute,'report.json'),{source,startedAt,finishedAt:now().toISOString(),calls:client.calls,...extra});
 // A NO-GO ends the attempt: its opening listing is discarded so the next attempt lists afresh; verified object checkpoints stay reusable.
 const discardAttempt=async()=>{await rm(path.join(absolute,'pages'),{recursive:true,force:true});await rm(path.join(absolute,'run.json'),{force:true});};
 try{
  const {objects,pages}=await openingListing(absolute,client);
  const entries=[];let resumed=0;
  const downloaded=await eachWithConcurrency(objects,parseConcurrency(concurrency),object=>downloadObject(absolute,client,object));
  for(const entry of downloaded){if(entry.resumed)resumed++;entries.push({key:entry.key,file:entry.file,size:entry.size,sha256:entry.sha256,metadata:entry.metadata});}
  const closing=await closingListing(client);
  const changes=inventoryDelta(objects,closing);
  const fenced=await fence(client,objects);
  const identity=await baselineIdentity(absolute,entries);
  const reasons=[];
  if(changes.length)reasons.push('inventory_changed');
  if(changes.some(change=>change.reason==='missing_after'))reasons.push('deletion_observed');
  if(!fenced.ok)reasons.push('fence_changed');
  const status=reasons.length?STATUS_NO_GO:STATUS_CONSISTENT;
  const manifest={...manifestFor(entries,pages,startedAt,now().toISOString(),changes),sourceSiteId:null,sourceOrigin:null,source,status,noGoReasons:reasons,consistencyNote:'Paged R2 listings are not an atomic snapshot. This manifest is a verified cut only when every object is the listed version, the closing listing equals the opening listing, and the fence objects kept their ETags; otherwise it is an explicit NO-GO and must not be imported.',fence:fenced,baselineIdentity:identity};
  await atomicJson(path.join(absolute,'manifest.json'),manifest);
  const verified=await verifySnapshot(absolute);
  const result={status,noGoReasons:reasons,objects:verified.objects,bytes:verified.bytes,aggregateSha256:verified.aggregateSha256,resumed,changes,fence:fenced,baselineIdentity:identity,source};
  await report(result);
  if(status===STATUS_NO_GO){await discardAttempt();throw new NoGo(reasons,{changes,fence:fenced});}
  return result;
 }catch(error){
  if(error instanceof NoGo)throw error;
  if(error instanceof ExportError&&error.kind==='source_changed'){await report({status:STATUS_NO_GO,noGoReasons:['source_changed'],message:error.message});await discardAttempt();throw new NoGo(['source_changed'],{message:error.message});}
  await report({status:'incomplete',errorCategory:error instanceof ExportError?error.kind:'unexpected',message:error instanceof ExportError?error.message:'Export failed'});
  throw error;
 }
}

// Re-reads a snapshot directory: bytes against the manifest, then the production source identity, status and fence.
export async function verifyProductionSnapshot(directory){
 const absolute=outsideRepository(directory);
 const verified=await verifySnapshot(absolute);
 const manifest=await jsonIfPresent(path.join(absolute,'manifest.json'));
 if(manifest?.source?.kind!==SOURCE_KIND||manifest.sourceSiteId!==null)throw new ExportError('integrity','Manifest is not a production R2 snapshot');
 if(![STATUS_CONSISTENT,STATUS_NO_GO].includes(manifest.status)||!manifest.fence||!Array.isArray(manifest.fence.keys)||!Array.isArray(manifest.noGoReasons))throw new ExportError('integrity','Manifest lacks the consistency record');
 const consistent=manifest.status===STATUS_CONSISTENT&&manifest.noGoReasons.length===0&&manifest.changes.length===0&&manifest.fence.ok===true;
 return {...verified,status:consistent?STATUS_CONSISTENT:STATUS_NO_GO,noGoReasons:manifest.noGoReasons,fence:{ok:manifest.fence.ok},baselineIdentity:manifest.baselineIdentity??null,source:manifest.source};
}

// A plan needs no credential and sends nothing: it shows what an approved run would request and where it would write.
export function plan({directory,env=process.env}={}){
 const accountId=/^[0-9a-f]{32}$/.test(String(env.R2_SNAPSHOT_ACCOUNT_ID||''))?String(env.R2_SNAPSHOT_ACCOUNT_ID):null;
 const bucket=String(env.R2_SNAPSHOT_BUCKET||DEFAULT_BUCKET);
 let endpoint=null;try{endpoint=new URL(endpointFor(accountId||'0'.repeat(32),env.R2_SNAPSHOT_ENDPOINT)).host;}catch{endpoint=null;}
 return {mode:'plan',network:false,credentialsRead:false,source:{kind:SOURCE_KIND,bucket,accountId:accountId?'present':'missing',endpoint:accountId||env.R2_SNAPSHOT_ENDPOINT?endpoint:'<account>.r2.cloudflarestorage.com'},requests:['ListObjectsV2 paged (opening listing, checkpointed)','HeadObject If-Match before each GetObject','GetObject If-Match with ETag and length check','HeadObject If-Match after each object','ListObjectsV2 paged (closing listing)','HeadObject on each fence key'],fenceKeys:[...FENCE_KEYS],identityKeys:{...IDENTITY_KEYS},writes:'none to the bucket; manifest, entries, pages, run and report files in the output directory only',output:directory?path.resolve(directory):null,outputOutsideRepository:directory?(()=>{try{outsideRepository(directory);return true;}catch{return false;}})():null,exitCodes:{0:STATUS_CONSISTENT,3:STATUS_NO_GO,1:'error',2:'usage or configuration'}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=flag=>{const index=args.indexOf(flag);return index<0?null:args[index+1];};
 const directory=value('--output');
 if(args.includes('--plan')){console.log(JSON.stringify(plan({directory})));process.exitCode=0;}
 else if(!directory||!path.isAbsolute(directory)){console.error('Usage: node scripts/r2-snapshot-export.mjs --output /absolute/private/directory [--verify|--plan] [--concurrency 1..16]');process.exitCode=2;}
 else try{
  const result=args.includes('--verify')?await verifyProductionSnapshot(directory):await exportProductionSnapshot({directory,credentials:readCredentials(process.env),concurrency:parseConcurrency(value('--concurrency'))});
  console.log(JSON.stringify(result));
  process.exitCode=result.status===STATUS_NO_GO?3:0;
 }catch(error){
  if(error instanceof NoGo){console.log(JSON.stringify({status:STATUS_NO_GO,noGoReasons:error.reasons,details:error.details}));process.exitCode=3;}
  else if(error instanceof ExportError){console.error(error.kind+': '+error.message);process.exitCode=error.kind==='configuration'?2:1;}
  else{console.error('Export failed');process.exitCode=1;}
 }
}
