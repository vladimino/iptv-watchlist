import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readdir,readFile,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {Transform,Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const SOURCE_ORIGIN='https://iptv.vladimino.chatgpt.site';
export const SOURCE_SITE_ID='appgprj_6abfed826e148191903dec4175166ff7';
const REPO_ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const sha256=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const fileId=key=>sha256(Buffer.from(key,'utf8'));
const objectPath=(directory,key)=>path.join(directory,'objects',fileId(key)+'.bin');
const entryPath=(directory,key)=>path.join(directory,'entries',fileId(key)+'.json');
const metadataEqual=(a,b)=>stable(a)===stable(b);

export class ExportError extends Error{constructor(kind,message){super(message);this.name='ExportError';this.kind=kind;}}

async function atomicJson(filename,value){
 const temporary=filename+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});
 await rename(temporary,filename);
}
async function jsonIfPresent(filename){try{return JSON.parse(await readFile(filename,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function hashFile(filename){const hash=createHash('sha256');let size=0;for await(const chunk of createReadStream(filename)){hash.update(chunk);size+=chunk.length;}return {sha256:hash.digest('hex'),size};}

function endpoint(baseUrl,name,params={}){
 const url=new URL('/api/migration-export/'+name,baseUrl);
 for(const [key,value] of Object.entries(params))if(value!==null&&value!==undefined)url.searchParams.set(key,value);
 return url;
}
async function request(fetchImpl,url,headers,{retries=3}={}){
 for(let attempt=0;;attempt++){
  let response;
  try{response=await fetchImpl(url,{method:'GET',headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(600000)});}catch(error){if(attempt<retries){await sleep(100*(attempt+1));continue;}throw new ExportError('network','Source request failed after retries');}
  if([429,500,502,503,504].includes(response.status)&&attempt<retries){await response.body?.cancel();await sleep(100*(attempt+1));continue;}
  if(response.status===409)throw new ExportError('source_changed','Source object changed or disappeared during export');
  if(response.status===401||response.status===403||response.status===404)throw new ExportError('authorization','Export endpoint unavailable or owner authorization expired');
  if(!response.ok)throw new ExportError('source_http','Source request failed with HTTP '+response.status);
  return response;
 }
}
async function requestJson(fetchImpl,url,headers){
 const response=await request(fetchImpl,url,headers);
 try{return await response.json();}catch{throw new ExportError('protocol','Invalid source JSON response');}
}
function validatePage(page){
 if(!page||!Array.isArray(page.objects)||typeof page.truncated!=='boolean'||(page.truncated&&(!page.nextCursor||typeof page.nextCursor!=='string'))||(!page.truncated&&page.nextCursor!==null))throw new ExportError('protocol','Incomplete listing page');
 for(const item of page.objects)if(typeof item.key!=='string'||!Number.isSafeInteger(item.size)||item.size<0||typeof item.etag!=='string'||typeof item.version!=='string')throw new ExportError('protocol','Invalid listing metadata');
}
async function sourcePage(fetchImpl,baseUrl,headers,cursor){
 const page=await requestJson(fetchImpl,endpoint(baseUrl,'list',{cursor}),headers);
 validatePage(page);return page;
}
function collectPages(pages){
 const objects=[],keys=new Set(),cursors=new Set();let expectedCursor=null,complete=false;
 for(const [index,record] of pages.entries()){
  if(record.requestCursor!==expectedCursor||complete)throw new ExportError('listing','Broken listing cursor chain');
  validatePage(record.page);
  for(const object of record.page.objects){if(keys.has(object.key))throw new ExportError('listing','Duplicate key in listing');keys.add(object.key);objects.push(object);}
  if(record.page.truncated){
   if(cursors.has(record.page.nextCursor)||record.page.nextCursor===expectedCursor)throw new ExportError('listing','Repeated listing cursor');
   cursors.add(record.page.nextCursor);expectedCursor=record.page.nextCursor;
  }else{complete=true;expectedCursor=null;}
  if(index>1000000)throw new ExportError('listing','Listing page limit exceeded');
 }
 return {objects,nextCursor:expectedCursor,complete};
}
async function initialListing(directory,fetchImpl,baseUrl,headers){
 const pagesDirectory=path.join(directory,'pages');await mkdir(pagesDirectory,{recursive:true,mode:0o700});
 const names=(await readdir(pagesDirectory)).filter(name=>/^\d{8}\.json$/.test(name)).sort();const records=[];
 for(const [index,name] of names.entries()){
  if(name!==String(index).padStart(8,'0')+'.json')throw new ExportError('listing','Missing listing page checkpoint');
  records.push(JSON.parse(await readFile(path.join(pagesDirectory,name),'utf8')));
 }
 let current=collectPages(records);
 while(!current.complete){
  const cursor=current.nextCursor,page=await sourcePage(fetchImpl,baseUrl,headers,cursor);
  records.push({requestCursor:cursor,page});
  current=collectPages(records);
  await atomicJson(path.join(pagesDirectory,String(records.length-1).padStart(8,'0')+'.json'),records.at(-1));
 }
 return {objects:current.objects,pages:records.length};
}
async function freshListing(fetchImpl,baseUrl,headers){
 const records=[];let cursor=null;
 do{const page=await sourcePage(fetchImpl,baseUrl,headers,cursor);records.push({requestCursor:cursor,page});collectPages(records);cursor=page.nextCursor;}while(cursor);
 return collectPages(records).objects;
}
async function sourceHead(fetchImpl,baseUrl,headers,object){
 const result=await requestJson(fetchImpl,endpoint(baseUrl,'head',{key:object.key,etag:object.etag,version:object.version}),headers);
 if(!metadataEqual(result,object))throw new ExportError('source_changed','Source metadata changed during export');
 return result;
}
async function downloadObject(directory,fetchImpl,baseUrl,headers,object){
 const saved=await jsonIfPresent(entryPath(directory,object.key));
 if(saved){
  if(saved.key!==object.key||!metadataEqual(saved.metadata,object))throw new ExportError('source_changed','Checkpoint metadata differs from source listing');
  let actual;try{actual=await hashFile(objectPath(directory,object.key));}catch(error){if(error.code==='ENOENT')throw new ExportError('integrity','Checkpoint data file is missing');throw error;}
  if(actual.sha256!==saved.sha256||actual.size!==saved.size)throw new ExportError('integrity','Checkpoint checksum mismatch');
  await sourceHead(fetchImpl,baseUrl,headers,object);
  return saved;
 }
 await sourceHead(fetchImpl,baseUrl,headers,object);
 for(let attempt=0;attempt<4;attempt++){
  const temporary=objectPath(directory,object.key)+'.'+randomUUID()+'.tmp';
  try{
   const response=await request(fetchImpl,endpoint(baseUrl,'object',{key:object.key,etag:object.etag,version:object.version}),headers);
   if(response.headers.get('X-Migration-Etag')!==object.etag||response.headers.get('X-Migration-Version')!==object.version||Number(response.headers.get('X-Migration-Size'))!==object.size)throw new ExportError('source_changed','Object response differs from listing');
   const hash=createHash('sha256');let size=0;
   const measure=new Transform({transform(chunk,encoding,callback){hash.update(chunk);size+=chunk.length;callback(null,chunk);}});
   await pipeline(Readable.fromWeb(response.body),measure,createWriteStream(temporary,{flags:'wx',mode:0o600}));
   if(size!==object.size)throw new ExportError('integrity','Downloaded object size mismatch');
   await sourceHead(fetchImpl,baseUrl,headers,object);
   const entry={key:object.key,file:'objects/'+fileId(object.key)+'.bin',size,sha256:hash.digest('hex'),metadata:object};
   await rename(temporary,objectPath(directory,object.key));
   await atomicJson(entryPath(directory,object.key),entry);
   return entry;
  }catch(error){
   try{await unlink(temporary);}catch{}
   if(error instanceof ExportError&&['source_changed','integrity','authorization'].includes(error.kind))throw error;
   if(attempt===3)throw new ExportError('network','Object stream failed after retries');
   await sleep(100*(attempt+1));
  }
 }
}
function differences(before,after){
 const left=new Map(before.map(item=>[item.key,item])),right=new Map(after.map(item=>[item.key,item]));const result=[];
 for(const [key,object] of left){if(!right.has(key))result.push({key,reason:'missing_after'});else if(!metadataEqual(object,right.get(key)))result.push({key,reason:'metadata_changed'});}
 for(const key of right.keys())if(!left.has(key))result.push({key,reason:'added_after'});
 return result;
}
export function manifestFor(entries,pages,startedAt,finishedAt,changes){
 const sorted=[...entries].sort((a,b)=>Buffer.compare(Buffer.from(a.key),Buffer.from(b.key)));
 const prefixes={};let totalBytes=0;const aggregate=createHash('sha256');
 for(const entry of sorted){
  const prefix=entry.key.includes('/')?entry.key.split('/')[0]+'/':'(root)';
  prefixes[prefix]??={objects:0,bytes:0};prefixes[prefix].objects++;prefixes[prefix].bytes+=entry.size;totalBytes+=entry.size;
  for(const part of [entry.key,String(entry.size),entry.sha256]){const bytes=Buffer.from(part,'utf8');aggregate.update(String(bytes.length)+':');aggregate.update(bytes);}
 }
 return {schemaVersion:1,sourceSiteId:SOURCE_SITE_ID,sourceOrigin:SOURCE_ORIGIN,startedAt,finishedAt,status:changes.length?'inconsistent':'provisional_no_change_detected',consistencyNote:'R2 listing is not an atomic bucket snapshot; a final consistent cutover requires paused writers and a new export.',listingPages:pages,totals:{objects:sorted.length,bytes:totalBytes,prefixes,aggregateSha256:aggregate.digest('hex')},changes,objects:sorted};
}
export async function verifySnapshot(directory){
 const manifest=await jsonIfPresent(path.join(directory,'manifest.json'));if(!manifest||manifest.schemaVersion!==1)throw new ExportError('integrity','Manifest missing or unsupported');
 const keys=new Set(),verified=[];
 for(const entry of manifest.objects){
  if(keys.has(entry.key)||entry.file!=='objects/'+fileId(entry.key)+'.bin')throw new ExportError('integrity','Duplicate key or unsafe object path');
  keys.add(entry.key);const actual=await hashFile(objectPath(directory,entry.key));
  if(actual.sha256!==entry.sha256||actual.size!==entry.size||entry.metadata.size!==entry.size)throw new ExportError('integrity','Snapshot checksum or size mismatch');
  verified.push(entry);
 }
 const computed=manifestFor(verified,manifest.listingPages,manifest.startedAt,manifest.finishedAt,manifest.changes);
 if(!metadataEqual(computed.totals,manifest.totals))throw new ExportError('integrity','Manifest totals mismatch');
 return {status:manifest.status,objects:verified.length,bytes:computed.totals.bytes,aggregateSha256:computed.totals.aggregateSha256};
}
export async function exportSnapshot({directory,headers,fetchImpl=fetch,baseUrl=SOURCE_ORIGIN}){
 if(new URL(baseUrl).origin!==SOURCE_ORIGIN)throw new ExportError('configuration','Exporter must target the old ChatGPT Site');
 const absolute=path.resolve(directory);
 if(absolute===REPO_ROOT||absolute.startsWith(REPO_ROOT+path.sep))throw new ExportError('configuration','Snapshot directory must be outside the Git repository');
 await mkdir(absolute,{recursive:true,mode:0o700});await mkdir(path.join(absolute,'objects'),{recursive:true,mode:0o700});await mkdir(path.join(absolute,'entries'),{recursive:true,mode:0o700});
 const startedAt=(await jsonIfPresent(path.join(absolute,'run.json')))?.startedAt||new Date().toISOString();
 await atomicJson(path.join(absolute,'run.json'),{schemaVersion:1,startedAt,sourceOrigin:SOURCE_ORIGIN});
 try{
  const {objects,pages}=await initialListing(absolute,fetchImpl,baseUrl,headers);const entries=[];
  for(const object of objects)entries.push(await downloadObject(absolute,fetchImpl,baseUrl,headers,object));
  const after=await freshListing(fetchImpl,baseUrl,headers),changes=differences(objects,after);
  const manifest=manifestFor(entries,pages,startedAt,new Date().toISOString(),changes);
  await atomicJson(path.join(absolute,'manifest.json'),manifest);
  const verified=await verifySnapshot(absolute);
  await atomicJson(path.join(absolute,'report.json'),{status:manifest.status,changes,verified});
  return verified;
 }catch(error){
  await atomicJson(path.join(absolute,'report.json'),{status:'incomplete',errorCategory:error instanceof ExportError?error.kind:'unexpected',message:error instanceof ExportError?error.message:'Export failed'});
  throw error;
 }
}
async function readAuthFile(filename){
 if(!filename)throw new ExportError('configuration','Missing private auth file');
 const info=await stat(filename);if((info.mode&0o077)!==0)throw new ExportError('configuration','Auth file must have mode 0600');
 const headers={};for(const line of (await readFile(filename,'utf8')).split(/\r?\n/)){
  if(!line.trim())continue;const match=line.match(/^([^:]+):\s*(.+)$/);
  if(!match||!['cookie','oai-sites-authorization','x-migration-export-key'].includes(match[1].toLowerCase()))throw new ExportError('configuration','Invalid auth header file');
  headers[match[1]]=match[2];
 }
 if(!Object.keys(headers).some(key=>key.toLowerCase()==='x-migration-export-key'))throw new ExportError('configuration','Missing export authorization header');
 if(!Object.keys(headers).some(key=>['cookie','oai-sites-authorization'].includes(key.toLowerCase())))throw new ExportError('configuration','Missing Sites owner access header');
 return headers;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=flag=>{const index=args.indexOf(flag);return index<0?null:args[index+1];};
 const directory=value('--output');
 if(!directory||!path.isAbsolute(directory)){console.error('Usage: node scripts/migration-export.mjs --output ABSOLUTE_PATH --auth-file PRIVATE_0600_FILE [--verify]');process.exitCode=2;}
 else try{
  const result=args.includes('--verify')?await verifySnapshot(directory):await exportSnapshot({directory,headers:await readAuthFile(value('--auth-file'))});
  console.log(JSON.stringify(result));if(result.status==='inconsistent')process.exitCode=3;
 }catch(error){console.error(error instanceof ExportError?`${error.kind}: ${error.message}`:'Export failed');process.exitCode=1;}
}
