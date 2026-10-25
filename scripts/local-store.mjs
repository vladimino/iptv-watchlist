import {createHash} from 'node:crypto';
import {access,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {buildLocalFixtures} from './local-fixtures.mjs';
import {DAY_MS,isTimeShifted,shiftSnapshotObject} from './local-timeshift.mjs';

const general=['plot_engine','pace','stakes','decision_logic','protagonist_competence','opposition_competence','problem_solving','plan_counterplan_strength','multi_party_goals','chemistry','payoff','ending_quality','technical_plausibility'];
const dropped=new Set(['unknown','not_applicable']);

export function storeKey(identity){
 if(identity.snapshot==='fixtures')return 'fixtures';
 return 'snapshot-'+createHash('sha256').update(String(identity.snapshot)).digest('hex').slice(0,16);
}
export function persistDirectory(stateRoot,identity){return path.join(stateRoot,'stores',storeKey(identity));}
export function markerPath(persistDir){return path.join(persistDir,'iptv-snapshot.json');}
export function miniflareDirectory(persistDir){return path.join(persistDir,'v3');}
export function importDecision({refresh,marker,identity,ready}){
 if(refresh||!marker)return 'replace';
 const same=marker.snapshot===identity.snapshot&&marker.manifestBytes===identity.manifestBytes&&marker.manifestMtimeMs===identity.manifestMtimeMs&&(marker.shiftDays??0)===(identity.shiftDays??0);
 return same&&ready?'skip':'replace';
}
function isFilmRecord(item){
 return !!item&&typeof item==='object'&&!Array.isArray(item)&&('actualRating' in item||'fingerprint' in item||'prediction' in item||'fingerprintHash' in item||'moodFacet' in item);
}
export function viewIndexReady(index){
 if(!index||typeof index!=='object'||Array.isArray(index))return false;
 return Object.values(index).every(isFilmRecord);
}
async function readJson(bucket,key){
 const object=await bucket.get(key);
 if(!object)return null;
 try{return await object.json();}catch{return null;}
}
export async function readStoreReady(bucket){
 const programme=await readJson(bucket,'programme.json');
 const watchlist=await readJson(bucket,'watchlist.json');
 const index=await readJson(bucket,'enrichment/view-index.json');
 if(!programme||!Array.isArray(programme.films)||programme.films.length===0)return false;
 if(!watchlist||!Array.isArray(watchlist.films))return false;
 return viewIndexReady(index);
}
export async function fixtureIdentity(root){
 const file=path.join(root,'fixtures/local-site/catalog.json');
 const info=await stat(file);
 return {snapshot:'fixtures',manifestBytes:info.size,manifestMtimeMs:info.mtimeMs};
}
export async function snapshotIdentity(snapshot){
 if(!path.isAbsolute(snapshot))throw new Error('snapshot in .local-dev.json must be an absolute path.');
 try{await access(path.join(snapshot,'manifest.json'));await access(path.join(snapshot,'entries'));await access(path.join(snapshot,'objects'));}
 catch{throw new Error('The snapshot directory is missing manifest.json, entries/, or objects/.');}
 const manifest=await stat(path.join(snapshot,'manifest.json'));
 return {snapshot,manifestBytes:manifest.size,manifestMtimeMs:manifest.mtimeMs};
}
export async function snapshotProgrammeUpdatedAt(snapshot){
 for(const name of await readdir(path.join(snapshot,'entries'))){
  const entry=JSON.parse(await readFile(path.join(snapshot,'entries',name),'utf8'));
  if(entry.key!=='programme.json')continue;
  try{return JSON.parse(await readFile(path.join(snapshot,entry.file),'utf8')).updatedAt??null;}catch{return null;}
 }
 return null;
}
export async function replacePersist(persistDir){await rm(miniflareDirectory(persistDir),{recursive:true,force:true});}
export async function writeMarker(file,identity,extra={}){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify({...identity,...extra}));}
export async function emptyBucket(bucket){
 const keys=[];
 let cursor;
 do{
  const page=await bucket.list({limit:1000,...(cursor?{cursor}:{})});
  for(const object of page.objects)keys.push(object.key);
  cursor=page.truncated?page.cursor:undefined;
 }while(cursor);
 for(const key of keys)await bucket.delete(key);
}
export async function putObjects(bucket,objects){
 for(const item of objects){
  const body=item.body??JSON.stringify(item.json);
  await bucket.put(item.key,body,{httpMetadata:item.httpMetadata||{contentType:'application/json'},...(item.customMetadata?{customMetadata:item.customMetadata}:{})});
 }
}
export async function importFixtures(bucket,catalog){
 await emptyBucket(bucket);
 const objects=buildLocalFixtures(catalog);
 await putObjects(bucket,objects);
 return {objects:objects.length,message:`Imported ${objects.length} dummy objects from fixtures/local-site/catalog.json.`};
}
export async function importSnapshot(bucket,snapshot,{shiftMs=0}={}){
 await emptyBucket(bucket);
 const names=await readdir(path.join(snapshot,'entries'));
 const executions=new Map();
 let written=0,fingerprints=0,patched=0,shifted=0,viewIndex=null;
 for(const name of names){
  const entry=JSON.parse(await readFile(path.join(snapshot,'entries',name),'utf8'));
  let bytes=await readFile(path.join(snapshot,entry.file));
  if(shiftMs&&isTimeShifted(entry.key)){bytes=Buffer.from(JSON.stringify(shiftSnapshotObject(entry.key,JSON.parse(bytes.toString('utf8')),shiftMs)));shifted++;}
  const film=String(entry.key||'').match(/^enrichment\/films\/([^/]+)\/fingerprint\.json$/);
  if(film){fingerprints++;try{executions.set(decodeURIComponent(film[1]),executionOf(JSON.parse(bytes.toString('utf8')).execution));}catch{executions.set(decodeURIComponent(film[1]),{});}}
  if(entry.key==='enrichment/view-index.json'){viewIndex=bytes;continue;}
  await bucket.put(entry.key,new Uint8Array(bytes),{httpMetadata:httpMetadata(entry.metadata),customMetadata:customMetadata(entry.metadata)});
  if(++written%1000===0)console.log(`Imported ${written} objects`);
 }
 if(!viewIndex)throw new Error('Snapshot has no view index');
 const index=JSON.parse(viewIndex.toString('utf8'));
 for(const [id,item] of Object.entries(index)){if(!item?.fingerprint||Object.hasOwn(item.fingerprint,'execution')||!executions.has(id))continue;item.fingerprint.execution=executions.get(id);patched++;}
 await bucket.put('enrichment/view-index.json',JSON.stringify(index),{httpMetadata:{contentType:'application/json'}});
 const shift=shiftMs?` Broadcast times moved forward by ${Math.round(shiftMs/DAY_MS)} days in ${shifted} objects.`:'';
 return {objects:names.length,patched,shifted,message:`Imported ${names.length} objects. Execution values attached for ${patched} of ${fingerprints} fingerprints.${shift}`};
}
export async function prepareLocalStore({refresh=false,identity,persistDir,openBucket,importInto}){
 const markerFile=markerPath(persistDir);
 let marker=null;
 try{marker=JSON.parse(await readFile(markerFile,'utf8'));}catch{}
 let ready=false;
 if(!refresh&&marker){
  let probe;
  try{
   probe=await openBucket();
   ready=await readStoreReady(probe.env.BUCKET);
  }catch(error){
   console.error(`Local store could not be read (${error.message}). Importing again.`);
   ready=false;
  }finally{if(probe)await probe.dispose().catch(()=>{});}
 }
 if(importDecision({refresh,marker,identity,ready})==='skip')return {action:'skip'};
 await rm(markerFile,{force:true});
 await replacePersist(persistDir);
 const proxy=await openBucket();
 let extra;
 try{
  extra=await importInto(proxy.env.BUCKET);
  if(!await readStoreReady(proxy.env.BUCKET))throw new Error('Imported local store is missing programme.json, watchlist.json, or a film view index.');
 }finally{await proxy.dispose();}
 await writeMarker(markerFile,identity,{objects:extra?.objects??null,...(Number.isInteger(extra?.patched)?{patched:extra.patched}:{})});
 return {action:'replace',message:extra?.message||'Imported the local store.',objects:extra?.objects??null};
}
function executionOf(value){const out={};if(!value||typeof value!=='object')return out;for(const key of general){const item=value[key];if(typeof item==='string'&&item&&!dropped.has(item))out[key]=item;}return out;}
function httpMetadata(metadata){const http=metadata?.httpMetadata||{},out={};for(const field of ['contentType','contentLanguage','contentDisposition','contentEncoding','cacheControl'])if(http[field])out[field]=String(http[field]);if(http.cacheExpiry){const time=Date.parse(http.cacheExpiry);if(!Number.isNaN(time))out.cacheExpiry=new Date(time);}return out;}
function customMetadata(metadata){return Object.fromEntries(Object.entries(metadata?.customMetadata||{}).filter(([,value])=>value!==undefined&&value!==null).map(([key,value])=>[key,String(value)]));}
