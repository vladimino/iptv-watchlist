import {createHash} from 'node:crypto';
import {access,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {buildLocalFixtures} from './local-fixtures.mjs';
import {canonicalRowsFromBucket,installLocalD1,migrationsIdentity,operatorRowsIdentity,readLocalD1Ready,readOperatorRows,startedRowsFromBucket} from './local-d1.mjs';
import {isTimeShifted,shiftSnapshotObject,timeMover} from './local-timeshift.mjs';

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
 const same=marker.snapshot===identity.snapshot&&marker.manifestBytes===identity.manifestBytes&&marker.manifestMtimeMs===identity.manifestMtimeMs&&(marker.shiftDays??0)===(identity.shiftDays??0)&&(marker.migrations??null)===(identity.migrations??null)&&(marker.d1Sql??null)===(identity.d1Sql??null);
 return same&&ready?'skip':'replace';
}
async function readJson(bucket,key){
 const object=await bucket.get(key);
 if(!object)return null;
 try{return await object.json();}catch{return null;}
}
// A store is reusable only when both halves are whole: the R2 documents of the dashboard and the D1 the Worker reads its domains from (schema at the head of
// the migration chain, every authority marker at d1, a published generation). The raw view index object is not part of it: the Worker never reads it.
export async function readStoreReady(env){
 const bucket=env?.BUCKET;
 if(!bucket)return false;
 const programme=await readJson(bucket,'programme.json');
 const watchlist=await readJson(bucket,'watchlist.json');
 if(!programme||!Array.isArray(programme.films)||programme.films.length===0)return false;
 if(!watchlist||!Array.isArray(watchlist.films))return false;
 return readLocalD1Ready(env);
}
export async function fixtureIdentity(root){
 const file=path.join(root,'fixtures/local-site/catalog.json');
 const info=await stat(file);
 return {snapshot:'fixtures',manifestBytes:info.size,manifestMtimeMs:info.mtimeMs,migrations:await migrationsIdentity()};
}
export async function snapshotIdentity(snapshot,d1Sql=''){
 if(!path.isAbsolute(snapshot))throw new Error('snapshot in .local-dev.json must be an absolute path.');
 try{await access(path.join(snapshot,'manifest.json'));await access(path.join(snapshot,'entries'));await access(path.join(snapshot,'objects'));}
 catch{throw new Error('The snapshot directory is missing manifest.json, entries/, or objects/.');}
 const manifest=await stat(path.join(snapshot,'manifest.json'));
 const rows=await operatorRowsIdentity(d1Sql);
 return {snapshot,manifestBytes:manifest.size,manifestMtimeMs:manifest.mtimeMs,migrations:await migrationsIdentity(),d1Sql:rows};
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
// The whole fixture store: the dummy R2 objects, then the D1 (schema, markers, synthetic rows, published generation) the Worker reads its domains from.
export async function importFixtureStore(env,catalog){
 const r2=await importFixtures(env.BUCKET,catalog);
 const d1=await installLocalD1(env,{catalog});
 return {objects:r2.objects,message:`${r2.message} Local D1 at schema version ${d1.schemaVersion}: ${d1.migrations} migrations, ${d1.rows} synthetic rows, generation ${d1.programmeRunId} published.`};
}
export async function importSnapshot(bucket,snapshot,{shift=null}={}){
 const move=timeMover(shift);
 await emptyBucket(bucket);
 const names=await readdir(path.join(snapshot,'entries'));
 const executions=new Map();
 let written=0,fingerprints=0,patched=0,shifted=0,viewIndex=null;
 for(const name of names){
  const entry=JSON.parse(await readFile(path.join(snapshot,'entries',name),'utf8'));
  let bytes=await readFile(path.join(snapshot,entry.file));
  if(move&&isTimeShifted(entry.key)){bytes=Buffer.from(JSON.stringify(shiftSnapshotObject(entry.key,JSON.parse(bytes.toString('utf8')),move)));shifted++;}
  const film=String(entry.key||'').match(/^enrichment\/films\/([^/]+)\/fingerprint\.json$/);
  if(film){fingerprints++;try{executions.set(decodeURIComponent(film[1]),executionOf(JSON.parse(bytes.toString('utf8')).execution));}catch{executions.set(decodeURIComponent(film[1]),{});}}
  if(entry.key==='enrichment/view-index.json'){viewIndex=bytes;continue;}
  await bucket.put(entry.key,new Uint8Array(bytes),{httpMetadata:httpMetadata(entry.metadata),customMetadata:customMetadata(entry.metadata)});
  if(++written%1000===0)console.log(`Imported ${written} objects`);
 }
 // The raw view index object is a stale operator-tool input, never an authority: it is copied when the snapshot has it and not required (the Worker derives the view from D1).
 if(viewIndex){
  const index=JSON.parse(viewIndex.toString('utf8'));
  for(const [id,item] of Object.entries(index)){if(!item?.fingerprint||Object.hasOwn(item.fingerprint,'execution')||!executions.has(id))continue;item.fingerprint.execution=executions.get(id);patched++;}
  await bucket.put('enrichment/view-index.json',JSON.stringify(index),{httpMetadata:{contentType:'application/json'}});
 }
 const note=move?` Broadcast times moved forward by ${shift?.days??'?'} calendar days (${shift?.timeZone||'Europe/Madrid'}) in ${shifted} objects.`:'';
 return {objects:names.length,patched,shifted,message:`Imported ${names.length} objects. Execution values attached for ${patched} of ${fingerprints} fingerprints.${note}`};
}
// The snapshot store: its R2 objects as exported, and a D1 built from the operator's own local rows (`d1Sql` in .local-dev.json, see docs/runbooks/local-setup.md).
// The snapshot has no D1 of its own and the raw view index object is not an authority, so a store without those rows is refused instead of served empty.
export async function importSnapshotStore(env,snapshot,{shift=null,d1Sql=''}={}){
 const rows=await readOperatorRows(d1Sql);
 const r2=await importSnapshot(env.BUCKET,snapshot,{shift});
 const started=await startedRowsFromBucket(env.BUCKET);
 const canonical=await canonicalRowsFromBucket(env.BUCKET);
 const d1=await installLocalD1(env,{canonical,statements:[...rows.statements,...started]});
 return {objects:r2.objects,patched:r2.patched,message:`${r2.message} Local D1 at schema version ${d1.schemaVersion}: ${canonical.length} canonical Film/Person rows from the snapshot, ${rows.statements.length} operator rows, ${started.length} started marks, generation ${d1.programmeRunId} published.`};
}
export async function prepareLocalStore({refresh=false,identity,persistDir,openStore,importInto}){
 const markerFile=markerPath(persistDir);
 let marker=null;
 try{marker=JSON.parse(await readFile(markerFile,'utf8'));}catch{}
 let ready=false;
 if(!refresh&&marker){
  let probe;
  try{
   probe=await openStore();
   ready=await readStoreReady(probe.env);
  }catch(error){
   console.error(`Local store could not be read (${error.message}). Importing again.`);
   ready=false;
  }finally{if(probe)await probe.dispose().catch(()=>{});}
 }
 if(importDecision({refresh,marker,identity,ready})==='skip')return {action:'skip'};
 await rm(markerFile,{force:true});
 await replacePersist(persistDir);
 const proxy=await openStore();
 let extra;
 try{
  extra=await importInto(proxy.env);
  if(!await readStoreReady(proxy.env))throw new Error('Imported local store is incomplete: it needs programme.json, watchlist.json and a D1 at the head of the migration chain with every domain marker at d1 and a published generation.');
 }finally{await proxy.dispose();}
 await writeMarker(markerFile,identity,{objects:extra?.objects??null,...(Number.isInteger(extra?.patched)?{patched:extra.patched}:{})});
 return {action:'replace',message:extra?.message||'Imported the local store.',objects:extra?.objects??null};
}
function httpMetadata(metadata){const http=metadata?.httpMetadata||{},out={};for(const field of ['contentType','contentLanguage','contentDisposition','contentEncoding','cacheControl'])if(http[field])out[field]=String(http[field]);if(http.cacheExpiry){const time=Date.parse(http.cacheExpiry);if(!Number.isNaN(time))out.cacheExpiry=new Date(time);}return out;}
function customMetadata(metadata){return Object.fromEntries(Object.entries(metadata?.customMetadata||{}).filter(([,value])=>value!==undefined&&value!==null).map(([key,value])=>[key,String(value)]));}
function executionOf(value){const out={};if(!value||typeof value!=='object')return out;for(const key of general){const item=value[key];if(typeof item==='string'&&item&&!dropped.has(item))out[key]=item;}return out;}
