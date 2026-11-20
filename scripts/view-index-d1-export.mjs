// The D1-derived input of the view index for the operator tools (ADR 0183). The Letterboxd operator scripts read a view index from a snapshot of the raw R2
// object, which stays current only while the raw writers run. This script produces the same information from D1, so the tools no longer depend on that object.
//
//   node scripts/view-index-d1-export.mjs --output <abs file outside the repository>
//
// It reads, with SELECT statements only, the film ids of `prediction_pointer` and `prediction_fingerprint` and the rows of `ratings_view`, and writes ONE
// self-describing JSON document (mode 0600, never overwriting): the derived index (every key of the union, with `watched`, `actualRating` and `watchlist` where
// ratings_view holds them; a key that only a prediction table holds is an empty entry, which is all the tools read of it), the D1 identity, the authority
// markers before and after, the counts and the read time. The tools take it through `--view-index-d1 <file>`.
//
// Fail closed, no retry: the prediction domain must be `d1` and the ratings domain `d1` and open, and neither marker generation may move during the read;
// otherwise nothing is written (exit 3). Ids and row contents are never printed. Running it against production is a separately approved action: this module
// grants none, and the environment holds the credential (D1_BACKFILL_ACCOUNT_ID, D1_BACKFILL_API_TOKEN, D1_BACKFILL_DATABASE_ID).
import {mkdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const VIEW_INDEX_D1_SCHEMA='view-index-d1-export@1';
export const SOURCE='d1_derived';
const PAGE=300;
const ROW_CAP=20000;
const READ_ONLY=/^\s*SELECT\b/i;

export class ExportError extends Error{constructor(message,exitCode=1){super(message);this.name='ExportError';this.exitCode=exitCode;}}

// The same rule as RatingsD1.overlayView and the Worker's derived view, for the fields the operator tools read.
const flag=value=>value===0||value===1||value==='0'||value==='1'?Number(value)===1:undefined;
export function deriveViewIndex({pointerIds=[],fingerprintIds=[],ratingsRows=[]}={}){
 const index={};
 for(const id of [...pointerIds,...fingerprintIds].map(String))if(!Object.hasOwn(index,id))index[id]={};
 for(const row of ratingsRows){
  const id=String(row.alias_id),item=Object.hasOwn(index,id)?index[id]:(index[id]={});
  const watched=flag(row.watched),watchlist=flag(row.watchlist);
  if(watched!==undefined)item.watched=watched;
  if(watchlist!==undefined)item.watchlist=watchlist;
  if(Number(row.rating_known)===1)item.actualRating=row.actual_rating==null?null:Number(row.actual_rating);
 }
 // Sorted keys: the file is reproducible for the same D1 state.
 return Object.fromEntries(Object.keys(index).sort().map(id=>[id,index[id]]));
}

// `query(sql, params)` returns the rows of one SELECT. The REST implementation (production) and a D1 binding stand-in (tests) both fit.
export async function exportViewIndex({query,databaseId=null,now=()=>new Date()}){
 const select=async(sql,params=[])=>{
  if(!READ_ONLY.test(sql)||/;\s*\S/.test(sql))throw new ExportError('Only a single SELECT is allowed',2);
  return query(sql,params);
 };
 const markers=async()=>{
  const schema=(await select('SELECT version FROM schema_contract'))[0]?.version??null;
  const prediction=(await select('SELECT mode, writes, generation FROM prediction_domain_authority'))[0]??null;
  const ratings=(await select('SELECT mode, cutover, generation FROM ratings_domain_authority'))[0]??null;
  return {schema,prediction,ratings};
 };
 const before=await markers();
 if(before.prediction?.mode!=='d1')throw new ExportError('The prediction domain is not d1; nothing was written',3);
 if(before.ratings?.mode!=='d1'||before.ratings?.cutover!=='open')throw new ExportError('The ratings domain is not d1 and open; nothing was written',3);
 const pages=async(sql,columns)=>{
  const rows=[];let after='';
  for(;;){
   const page=await select(sql,[after,PAGE]);
   rows.push(...page);
   if(rows.length>ROW_CAP)throw new ExportError('A table exceeds the '+ROW_CAP+' row cap; nothing was written',3);
   if(page.length<PAGE)return rows;
   after=page[page.length-1][columns];
  }
 };
 const readAt=now().toISOString();
 const pointer=await pages('SELECT film_id FROM prediction_pointer WHERE film_id>? ORDER BY film_id LIMIT ?','film_id');
 const fingerprint=await pages('SELECT film_id FROM prediction_fingerprint WHERE film_id>? ORDER BY film_id LIMIT ?','film_id');
 const ratings=await pages('SELECT alias_id, rating_known, actual_rating, watched, watchlist FROM ratings_view WHERE alias_id>? ORDER BY alias_id LIMIT ?','alias_id');
 const afterMarkers=await markers();
 const moved=before.prediction.generation!==afterMarkers.prediction?.generation||before.ratings.generation!==afterMarkers.ratings?.generation||before.schema!==afterMarkers.schema||afterMarkers.ratings?.cutover!=='open'||afterMarkers.prediction?.mode!=='d1';
 if(moved)throw new ExportError('An authority marker moved during the read; the cut is inconclusive and nothing was written',3);
 const index=deriveViewIndex({pointerIds:pointer.map(row=>row.film_id),fingerprintIds:fingerprint.map(row=>row.film_id),ratingsRows:ratings});
 return {
  schema:VIEW_INDEX_D1_SCHEMA,source:SOURCE,readAt,
  database:{id:databaseId},
  markers:{before,after:afterMarkers},
  counts:{pointer:pointer.length,fingerprint:fingerprint.length,ratings:ratings.length,keys:Object.keys(index).length},
  index,
 };
}

// ---- REST query (production): a single SELECT, every answer checked to have written nothing.
export function restQuery({accountId,apiToken,databaseId,fetchImpl=fetch}){
 const url='https://api.cloudflare.com/client/v4/accounts/'+accountId+'/d1/database/'+databaseId+'/query';
 return async(sql,params=[])=>{
  const response=await fetchImpl(url,{method:'POST',headers:{Authorization:'Bearer '+apiToken,'Content-Type':'application/json'},body:JSON.stringify({sql,params})});
  const body=await response.json().catch(()=>null);
  if(!response.ok||!body?.success)throw new ExportError('D1 query failed (HTTP '+response.status+')',3);
  const result=body.result?.[0],meta=result?.meta||{};
  if(meta.changed_db!==false||(meta.rows_written??0)!==0)throw new ExportError('A D1 answer reported a write; stopped',3);
  return result.results||[];
 };
}

async function assertOutsideRepository(target){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),resolved=path.resolve(target);
 if(!path.isAbsolute(target))throw new ExportError('--output must be an absolute path',2);
 if(resolved===root||resolved.startsWith(root+path.sep))throw new ExportError('--output must be outside the repository',2);
 return resolved;
}
export async function writeExport(document,target){
 const file=await assertOutsideRepository(target);
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const text=JSON.stringify(document)+'\n';
 let handle;
 try{handle=await open(file,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw new ExportError('--output already exists; it is never overwritten',2);throw error;}
 try{await handle.writeFile(text);}finally{await handle.close();}
 return {file,sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text)};
}

export async function main(argv=process.argv.slice(2),{env=process.env,fetchImpl=fetch,now}={}){
 try{
  if(argv.length!==2||argv[0]!=='--output')throw new ExportError('Usage: view-index-d1-export.mjs --output <abs file outside the repository>',2);
  const accountId=String(env.D1_BACKFILL_ACCOUNT_ID||'').trim(),apiToken=String(env.D1_BACKFILL_API_TOKEN||'').trim(),databaseId=String(env.D1_BACKFILL_DATABASE_ID||'').trim();
  if(!/^[0-9a-f]{32}$/.test(accountId)||!apiToken||!/^[0-9a-f-]{36}$/.test(databaseId))throw new ExportError('D1_BACKFILL_ACCOUNT_ID, D1_BACKFILL_API_TOKEN and D1_BACKFILL_DATABASE_ID are required in the environment',2);
  const output=await assertOutsideRepository(argv[1]);
  const document=await exportViewIndex({query:restQuery({accountId,apiToken,databaseId,fetchImpl}),databaseId,...(now?{now}:{})});
  const written=await writeExport(document,output);
  const summary={schema:document.schema,counts:document.counts,readAt:document.readAt,sha256:written.sha256,bytes:written.bytes};
  console.log(JSON.stringify(summary));
  return summary;
 }catch(error){
  if(error instanceof ExportError){console.error(error.message);process.exitCode=error.exitCode;return null;}
  throw error;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
