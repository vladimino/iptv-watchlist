import {createHash,createHmac} from 'node:crypto';
import {readFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifySnapshot,ExportError} from './migration-export.mjs';

export const EXPECTED_BUCKET='iptv';
const LEASE_KEYS=new Set(['enrichment/runner-lease.json','enrichment/writer-lease.json','epg/resolver-lease.json']);
const HTTP_FIELDS=['contentType','contentLanguage','contentDisposition','contentEncoding','cacheControl','cacheExpiry'];

export class ImportError extends Error{constructor(kind,message,details={}){super(message);this.name='ImportError';this.kind=kind;this.keyHash=details.keyHash||null;}}
const sha256=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const keyHash=key=>sha256(Buffer.from(key,'utf8')).slice(0,12);
const encodeRfc3986=value=>encodeURIComponent(value).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function isLeaseKey(key){return LEASE_KEYS.has(key)||key.endsWith('-lease.json')||key.endsWith('/lease.json');}
export function portableMetadata(metadata={}){
 const httpMetadata={};
 for(const field of HTTP_FIELDS){const value=metadata.httpMetadata?.[field];if(value!==undefined&&value!==null&&value!=='')httpMetadata[field]=String(value);}
 const customMetadata={};
 for(const [name,value] of Object.entries(metadata.customMetadata||{}))customMetadata[name.toLowerCase()]=String(value);
 return {httpMetadata,customMetadata};
}
const sameMetadata=(left,right)=>stable(portableMetadata(left))===stable(portableMetadata(right));

export function assertTarget(auth){
 if(!auth||auth.bucket!==EXPECTED_BUCKET)throw new ImportError('target','Destination bucket must be iptv');
 if(!/^[a-f0-9]{32}$/.test(auth.accountId||'')||auth.accountId!==auth.confirmAccountId)throw new ImportError('target','Cloudflare account ID is missing or does not match its confirmation');
 if(!auth.accessKeyId||!auth.secretAccessKey)throw new ImportError('authorization','R2 access key is missing');
 return {accountId:auth.accountId,bucket:EXPECTED_BUCKET,endpoint:`https://${auth.accountId}.r2.cloudflarestorage.com`};
}
export function parseAuth(text){
 let value;try{value=JSON.parse(text);}catch{throw new ImportError('authorization','R2 auth file is not JSON');}
 const auth={accountId:value.accountId,confirmAccountId:value.confirmAccountId,bucket:value.bucket,accessKeyId:value.accessKeyId,secretAccessKey:value.secretAccessKey};
 assertTarget(auth);return auth;
}

function canonicalQuery(params){
 return [...params.entries()].map(([key,value])=>[encodeRfc3986(key),encodeRfc3986(value)]).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>`${key}=${value}`).join('&');
}
export function signRequest({method,path:requestPath,query,headers,payloadHash,accessKeyId,secretAccessKey,amzDate,region,service}){
 const normalized=new Map();
 for(const [name,value] of Object.entries(headers))normalized.set(name.toLowerCase(),String(value).trim().replace(/\s+/g,' '));
 const names=[...normalized.keys()].sort();
 const canonicalHeaders=names.map(name=>`${name}:${normalized.get(name)}\n`).join('');
 const canonical=[method,'/'+String(requestPath).split('/').filter(Boolean).map(encodeRfc3986).join('/'),canonicalQuery(query),canonicalHeaders,names.join(';'),payloadHash].join('\n');
 const date=amzDate.slice(0,8),scope=`${date}/${region}/${service}/aws4_request`;
 const stringToSign=['AWS4-HMAC-SHA256',amzDate,scope,sha256(canonical)].join('\n');
 let key=Buffer.from(`AWS4${secretAccessKey}`);
 for(const part of [date,region,service,'aws4_request'])key=hmac(key,part);
 const signature=createHmac('sha256',key).update(stringToSign).digest('hex');
 return {...headers,authorization:`AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`};
}

function decodeXml(value){return value.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g,(_,entity)=>{const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(named[entity])return named[entity];return String.fromCodePoint(parseInt(entity.startsWith('#x')?entity.slice(2):entity.slice(1),entity.startsWith('#x')?16:10));});}
function headerMetadata(headers){
 const httpMetadata={};
 const read=(name,field)=>{const value=headers.get(name);if(value)httpMetadata[field]=value;};
 read('content-type','contentType');read('content-language','contentLanguage');read('content-disposition','contentDisposition');read('content-encoding','contentEncoding');read('cache-control','cacheControl');read('expires','cacheExpiry');
 const customMetadata={};
 for(const [name,value] of headers)if(name.startsWith('x-amz-meta-'))customMetadata[name.slice('x-amz-meta-'.length)]=value;
 return {size:Number(headers.get('content-length')),httpMetadata,customMetadata};
}

export function createR2Client(auth,{fetchImpl=fetch,now=()=>new Date()}={}){
 const target=assertTarget(auth);
 const host=new URL(target.endpoint).host;
 async function call(method,key,query,headers,body){
  const amzDate=now().toISOString().replace(/[:-]|\.\d{3}/g,'');
  const bytes=body?Buffer.from(body):Buffer.alloc(0);
  const payloadHash=sha256(bytes);
  const requestPath='/'+target.bucket+(key===undefined?'':'/'+key);
  const signed=signRequest({method,path:requestPath,query,headers:{host,...headers,'x-amz-date':amzDate,'x-amz-content-sha256':payloadHash},payloadHash,accessKeyId:auth.accessKeyId,secretAccessKey:auth.secretAccessKey,amzDate,region:'auto',service:'s3'});
  const encodedPath='/'+[target.bucket,...(key===undefined?[]:String(key).split('/'))].map(encodeRfc3986).join('/');
  const response=await fetchImpl(target.endpoint+encodedPath+(query.size?'?'+canonicalQuery(query):''),{method,headers:signed,body:method==='GET'||method==='HEAD'?undefined:bytes});
  if(method==='HEAD'&&response.status===404){await response.body?.cancel();return null;}
  if(!response.ok){await response.body?.cancel();throw new ImportError('target',`Destination request failed (${response.status})`);}
  return response;
 }
 return {bucket:target.bucket,endpoint:target.endpoint,writes:0,
  async listAll(){const objects=[];let token='';for(let page=0;page<100000;page++){const query=new URLSearchParams({ 'list-type':'2'});if(token)query.set('continuation-token',token);const response=await call('GET',undefined,query,{});const xml=await response.text();for(const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)){const key=block[1].match(/<Key>([\s\S]*?)<\/Key>/),size=block[1].match(/<Size>(\d+)<\/Size>/);if(!key||!size)throw new ImportError('target','Destination listing is incomplete');objects.push({key:decodeXml(key[1]),size:Number(size[1])});}const truncated=/<IsTruncated>true<\/IsTruncated>/.test(xml);if(!truncated)return objects;const next=xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);if(!next)throw new ImportError('target','Destination listing has no continuation');token=decodeXml(next[1]);}throw new ImportError('target','Destination listing did not finish');},
  async head(key){const response=await call('HEAD',key,new URLSearchParams(),{});return response?headerMetadata(response.headers):null;},
  async get(key){const response=await call('GET',key,new URLSearchParams(),{});return Buffer.from(await response.arrayBuffer());},
  async put(key,bytes,metadata){const headers={};
   const http=portableMetadata(metadata).httpMetadata,custom=portableMetadata(metadata).customMetadata;
   if(http.contentType)headers['content-type']=http.contentType;if(http.contentLanguage)headers['content-language']=http.contentLanguage;if(http.contentDisposition)headers['content-disposition']=http.contentDisposition;if(http.contentEncoding)headers['content-encoding']=http.contentEncoding;if(http.cacheControl)headers['cache-control']=http.cacheControl;if(http.cacheExpiry)headers.expires=http.cacheExpiry;
   for(const [name,value] of Object.entries(custom)){if(/[\r\n]/.test(name+value))throw new ImportError('metadata','Metadata is not portable');headers[`x-amz-meta-${name}`]=value;}
   await call('PUT',key,new URLSearchParams(),headers,bytes);this.writes++;}
 };
}

export function createMemoryBucket(){
 const items=new Map();const calls={list:0,head:0,get:0,put:0,delete:0};
 return {bucket:EXPECTED_BUCKET,writes:0,items,calls,
  async listAll(){calls.list++;return [...items.values()].map(item=>({key:item.key,size:item.bytes.length}));},
  async head(key){calls.head++;const item=items.get(key);return item?{size:item.bytes.length,...portableMetadata(item.metadata)}:null;},
  async get(key){calls.get++;const item=items.get(key);if(!item)throw new ImportError('missing','Destination object is missing',{keyHash:keyHash(key)});return Buffer.from(item.bytes);},
  async put(key,bytes,metadata){calls.put++;items.set(key,{key,bytes:Buffer.from(bytes),metadata:portableMetadata(metadata)});this.writes++;}
 };
}

async function loadSnapshot(directory){
 let verified;try{verified=await verifySnapshot(directory);}catch(error){if(error instanceof ExportError)throw new ImportError('snapshot',error.message);throw error;}
 const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
 const report=JSON.parse(await readFile(path.join(directory,'report.json'),'utf8'));
 if(manifest.status!=='provisional_no_change_detected'||report.status!==manifest.status||manifest.changes?.length)throw new ImportError('snapshot','Snapshot is not a complete provisional export');
 if(verified.objects!==manifest.totals.objects||verified.aggregateSha256!==manifest.totals.aggregateSha256)throw new ImportError('snapshot','Snapshot verification does not match the manifest');
 return manifest;
}
async function objectBytes(directory,entry){
 const bytes=await readFile(path.join(directory,entry.file));
 if(bytes.length!==entry.size||sha256(bytes)!==entry.sha256)throw new ImportError('snapshot','Snapshot file no longer matches its manifest',{keyHash:keyHash(entry.key)});
 return bytes;
}
function summary(operation,manifest,counts){
 return {operation,objects:manifest.totals.objects,bytes:manifest.totals.bytes,upload:counts.upload,unchanged:counts.unchanged,leases:counts.leases,writes:counts.writes};
}
async function classify(directory,client,manifest){
 if(client.bucket!==EXPECTED_BUCKET)throw new ImportError('target','Destination bucket must be iptv');
 const present=new Map((await client.listAll()).map(item=>[item.key,item]));
 const wanted=new Set(manifest.objects.map(entry=>entry.key));
 for(const key of present.keys())if(!wanted.has(key))throw new ImportError('extra','Destination has an object that is not in the snapshot',{keyHash:keyHash(key)});
 const plan=[];
 for(const entry of manifest.objects){
  const current=present.get(entry.key);
  if(!current){plan.push({entry,action:'upload'});continue;}
  if(current.size!==entry.size)throw new ImportError('conflict','Destination object differs from the snapshot',{keyHash:keyHash(entry.key)});
  const bytes=await client.get(entry.key);
  const head=await client.head(entry.key);
  if(sha256(bytes)!==entry.sha256||bytes.length!==entry.size||!sameMetadata(head,entry.metadata))throw new ImportError(sha256(bytes)===entry.sha256?'metadata':'conflict','Destination object does not match the snapshot',{keyHash:keyHash(entry.key)});
  plan.push({entry,action:'unchanged'});
 }
 return plan;
}
export async function dryRun({directory,client,auth}){
 assertTarget(auth);
 const before=client.writes||0,manifest=await loadSnapshot(directory),plan=await classify(directory,client,manifest);
 if((client.writes||0)!==before||client.calls?.put||client.calls?.delete)throw new ImportError('target','Dry-run wrote to the destination');
 return summary('dry-run',manifest,{upload:plan.filter(item=>item.action==='upload').length,unchanged:plan.filter(item=>item.action==='unchanged').length,leases:plan.filter(item=>isLeaseKey(item.entry.key)).length,writes:0});
}
export async function importSnapshot({directory,client,auth}){
 assertTarget(auth);
 const manifest=await loadSnapshot(directory);
 let plan=await classify(directory,client,manifest),uploaded=0;
 for(const item of plan.filter(item=>item.action==='upload')){
  await client.put(item.entry.key,await objectBytes(directory,item.entry),portableMetadata(item.entry.metadata));
  uploaded++;
 }
 const verified=await verifyDestination({directory,client,auth});
 return {...summary('import',manifest,{upload:uploaded,unchanged:manifest.totals.objects-uploaded,leases:verified.leases,writes:uploaded}),verified:verified.objects};
}
export async function verifyDestination({directory,client,auth}){
 assertTarget(auth);
 const before=client.writes||0,manifest=await loadSnapshot(directory);
 const present=new Map((await client.listAll()).map(item=>[item.key,item]));
 const wanted=new Set(manifest.objects.map(entry=>entry.key));
 for(const key of present.keys())if(!wanted.has(key))throw new ImportError('extra','Destination has an object that is not in the snapshot',{keyHash:keyHash(key)});
 let leases=0;
 for(const entry of manifest.objects){
  if(isLeaseKey(entry.key))leases++;
  const current=present.get(entry.key);if(!current)throw new ImportError('missing','Destination object is missing',{keyHash:keyHash(entry.key)});
  const bytes=await client.get(entry.key),head=await client.head(entry.key);
  if(current.size!==entry.size||bytes.length!==entry.size||sha256(bytes)!==entry.sha256)throw new ImportError('conflict','Destination bytes do not match the snapshot',{keyHash:keyHash(entry.key)});
  if(!sameMetadata(head,entry.metadata))throw new ImportError('metadata','Destination metadata does not match the snapshot',{keyHash:keyHash(entry.key)});
 }
 if((client.writes||0)!==before)throw new ImportError('target','Verification wrote to the destination');
 return {operation:'verify',objects:manifest.totals.objects,bytes:manifest.totals.bytes,leases,missing:0,extra:0,writes:0};
}

const statePath=directory=>path.join(directory,'import-state.json');
export async function readAuthFile(filename){
 const info=await stat(filename);if((info.mode&0o777)!==0o600)throw new ImportError('authorization','R2 auth file must be mode 0600');
 return parseAuth(await readFile(filename,'utf8'));
}
async function runCommand(operation,directory,auth,client){
 if(operation==='dry-run')return dryRun({directory,client,auth});
 if(operation==='verify')return verifyDestination({directory,client,auth});
 if(operation==='import'){const result=await importSnapshot({directory,client,auth});await writeFile(statePath(directory),JSON.stringify({schemaVersion:1,bucket:EXPECTED_BUCKET,objects:result.verified})+'\n',{mode:0o600});return result;}
 throw new ImportError('usage','Use dry-run, import, or verify');
}
export async function runCli(argv,{readAuth=readAuthFile,clientFor,stdout=console.log,stderr=console.error}={}){
 const operation=argv[0],snapshotAt=argv.indexOf('--snapshot'),authAt=argv.indexOf('--auth-file');
 const directory=snapshotAt>=0?argv[snapshotAt+1]:'',authFile=authAt>=0?argv[authAt+1]:'';
 if(!['dry-run','import','verify'].includes(operation)||!directory||!authFile)throw new ImportError('usage','Usage: migration-import.mjs <dry-run|import|verify> --snapshot DIR --auth-file FILE [--confirm-import]');
 if(operation==='import'&&!argv.includes('--confirm-import'))throw new ImportError('usage','Import requires --confirm-import and separate owner approval');
 const auth=await readAuth(authFile);
 const client=clientFor?clientFor(auth):createR2Client(auth);
 const result=await runCommand(operation,directory,auth,client);
 stdout(JSON.stringify(result));
 return result;
}

const isDirect=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isDirect)runCli(process.argv.slice(2)).catch(error=>{console.error(`Import refused (${error.kind||'unexpected'}): ${error.message}`);process.exit(1);});
