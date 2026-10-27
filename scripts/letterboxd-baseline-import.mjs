// Letterboxd baseline import (ADR-0023, contract "Baseline import protocol"). `plan` is offline: it reads the export ZIP in
// memory, binds it in origin.json, matches it against a verified snapshot exactly as the reconciliation does and plans one
// observation set per accepted film. `validate`, `commit` and `rollback` send the planned chunks to the owner-only Worker
// route; each first re-checks the archive and the plan against origin.json. Film names, codes and ratings stay in the
// private output directory; standard output carries counts only.
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EXPORT_FILES,parseExport} from '../src/letterboxd-export.js';
import {buildIndex,matchExport} from '../src/letterboxd-match.js';
import {archiveGeneratedAt,readZip} from '../src/letterboxd-zip.js';
import {ReconcileError,assertOutsideRepository,loadSnapshot} from './letterboxd-reconcile.mjs';

// A plan fixes its chunk size in origin.json, and every remote step re-derives the chunks from it. The Worker does several
// sequential R2 operations per film, so a chunk must finish well inside the client's request limits: new plans default to
// DEFAULT_CHUNK_SIZE and accept at most MAX_CHUNK_SIZE. A schema 1 origin.json has no chunkSize and was planned with
// LEGACY_CHUNK_SIZE; it keeps that chunking for validate, replay and rollback, since receipts are keyed by archive + chunk.
export const DEFAULT_CHUNK_SIZE=50,MAX_CHUNK_SIZE=100,LEGACY_CHUNK_SIZE=200;
const sha256=value=>createHash('sha256').update(value).digest('hex');
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/;
export class ImportError extends Error{constructor(message,exitCode=1){super(message);this.name='ImportError';this.exitCode=exitCode;}}

async function readArchive(zipPath,generatedAtFlag,now){
 const bytes=await readFile(zipPath),{archiveSha256,files}=readZip(bytes,Object.values(EXPORT_FILES));
 if(!files[EXPORT_FILES.watched])throw new ImportError('The archive has no '+EXPORT_FILES.watched,2);
 const named=archiveGeneratedAt(zipPath);
 let generatedAt=named,generatedAtSource='archive_name';
 if(!named){
  if(!generatedAtFlag)throw new ImportError('The archive name is not Letterboxd\'s export name; pass --generated-at <UTC time> to declare the export time',2);
  if(!ISO.test(generatedAtFlag))throw new ImportError('--generated-at must be an ISO UTC time',2);
  generatedAt=new Date(generatedAtFlag).toISOString();generatedAtSource='owner_declared';
 }else if(generatedAtFlag)throw new ImportError('--generated-at is only for an archive without Letterboxd\'s export name',2);
 if(Date.parse(generatedAt)>now)throw new ImportError('The export time is in the future',2);
 return {archiveName:path.basename(zipPath),archiveSha256,generatedAt,generatedAtSource,files};
}

// The facts an accepted export film shows. Absence is not an observation: watchlist: false and watched: false never appear.
export function planItem(film,match){
 const facts={},effectiveOn={};
 if(film.inWatched||film.inRatings){facts.watched=true;if(film.watchedDate)effectiveOn.watched=film.watchedDate;}
 if(film.inRatings)facts.rating=film.rating;else if(film.inWatched)facts.rating=null;
 if(film.inWatchlist)facts.watchlist=true;
 return {lid:match.filmId,tmdb:match.tmdbId??null,facts,effectiveOn};
}

export function checkChunkSize(value){
 if(!Number.isInteger(value)||value<1||value>MAX_CHUNK_SIZE)throw new ImportError('--chunk-size must be an integer 1..'+MAX_CHUNK_SIZE,2);
 return value;
}
async function readOrigin(outputPath){
 let text;try{text=await readFile(path.join(outputPath,'origin.json'),'utf8');}catch{return null;}
 try{return JSON.parse(text);}catch{throw new ImportError('origin.json is not valid JSON',3);}
}
// The chunk size a verified origin.json fixes: schema 1 is the legacy fixed size, schema 2 records its own.
export function originChunkSize(origin){
 if(origin?.schemaVersion===1&&origin.chunkSize===undefined)return LEGACY_CHUNK_SIZE;
 if(origin?.schemaVersion===2&&Number.isInteger(origin.chunkSize)&&origin.chunkSize>=1&&origin.chunkSize<=MAX_CHUNK_SIZE)return origin.chunkSize;
 throw new ImportError('origin.json has an unknown schema or chunk size',3);
}

export async function plan({zip,snapshot,output,generatedAt=null,chunkSize=DEFAULT_CHUNK_SIZE,now=Date.now()}){
 checkChunkSize(chunkSize);
 const zipPath=await assertOutsideRepository(zip,'--zip'),snapshotPath=await assertOutsideRepository(snapshot,'--snapshot'),outputPath=await assertOutsideRepository(output,'--output');
 const archive=await readArchive(zipPath,generatedAt,now);
 // A directory holds one plan: re-planning over another archive or another chunk size would orphan the receipts the
 // earlier plan can still validate, replay or roll back.
 const previous=await readOrigin(outputPath);
 if(previous&&(previous.archiveSha256!==archive.archiveSha256||originChunkSize(previous)!==chunkSize))throw new ImportError('--output already holds a plan of another archive or chunk size; plan into a new directory',2);
 const texts=Object.fromEntries(Object.entries(EXPORT_FILES).map(([kind,name])=>[kind,archive.files[name]?.text??null]));
 const parsed=parseExport(texts),loaded=await loadSnapshot(snapshotPath),matches=matchExport(parsed.films,buildIndex(loaded.objects));
 const films=new Map(parsed.films.map(film=>[film.code,film])),byStatus={},items=[];
 for(const match of matches){byStatus[match.status]=(byStatus[match.status]||0)+1;if(match.status==='accepted')items.push(planItem(films.get(match.code),match));}
 items.sort((a,b)=>a.lid<b.lid?-1:a.lid>b.lid?1:0);
 const lines=items.map((item,i)=>JSON.stringify({chunk:Math.floor(i/chunkSize),item})),planText=lines.join('\n')+(lines.length?'\n':'');
 const origin={schemaVersion:2,archiveName:archive.archiveName,archiveSha256:archive.archiveSha256,generatedAt:archive.generatedAt,generatedAtSource:archive.generatedAtSource,files:Object.fromEntries(Object.entries(archive.files).map(([name,file])=>[name,file.sha256])),planSha256:sha256(planText),chunkSize,chunks:Math.ceil(items.length/chunkSize),snapshot:{status:loaded.status,baselineIdentity:loaded.baselineIdentity,missingKeys:loaded.missing}};
 const count=predicate=>items.filter(predicate).length;
 const report={schemaVersion:1,tool:'letterboxd-baseline-import',privacy:'Aggregate counts only. Per-film rows are in the private plan.jsonl next to this file.',generatedAtSource:origin.generatedAtSource,chunkSize,invalidRows:parsed.invalidRows.length,matchStatus:byStatus,planned:{films:items.length,chunks:origin.chunks,watched:count(item=>item.facts.watched),rated:count(item=>typeof item.facts.rating==='number'),notRated:count(item=>item.facts.rating===null),watchlist:count(item=>item.facts.watchlist)},unresolved:matches.length-items.length};
 await mkdir(outputPath,{recursive:true,mode:0o700});
 await writeFile(path.join(outputPath,'origin.json'),JSON.stringify(origin,null,1)+'\n',{mode:0o600});
 await writeFile(path.join(outputPath,'plan.jsonl'),planText,{mode:0o600});
 await writeFile(path.join(outputPath,'report.json'),JSON.stringify(report,null,1)+'\n',{mode:0o600});
 return report;
}

// Re-reads the archive and the plan and refuses to continue on any difference from origin.json.
export async function loadVerifiedPlan({zip,output,now=Date.now()}){
 const zipPath=await assertOutsideRepository(zip,'--zip'),outputPath=await assertOutsideRepository(output,'--output');
 const origin=await readOrigin(outputPath);if(!origin)throw new ImportError('origin.json is missing; run plan first',2);
 const chunkSize=originChunkSize(origin),declared=origin.generatedAtSource==='owner_declared'?origin.generatedAt:null,archive=await readArchive(zipPath,declared,now);
 if(archive.archiveSha256!==origin.archiveSha256||archive.generatedAt!==origin.generatedAt)throw new ImportError('The archive differs from origin.json',3);
 for(const [name,hash] of Object.entries(origin.files))if(archive.files[name]?.sha256!==hash)throw new ImportError('An export file differs from origin.json',3);
 const planText=await readFile(path.join(outputPath,'plan.jsonl'),'utf8');
 if(sha256(planText)!==origin.planSha256)throw new ImportError('plan.jsonl differs from origin.json',3);
 // Every line must sit in the chunk its position and the recorded size give: one plan never mixes chunk sizes.
 const chunks=[];planText.split('\n').filter(Boolean).forEach((line,i)=>{
  const {chunk,item}=JSON.parse(line);
  if(chunk!==Math.floor(i/chunkSize))throw new ImportError('plan.jsonl chunking differs from the chunk size in origin.json',3);
  (chunks[chunk]||=[]).push(item);
 });
 if(chunks.length!==origin.chunks)throw new ImportError('plan.jsonl chunk count differs from origin.json',3);
 return {origin,chunkSize,chunks,outputPath};
}

function endpointUrl(endpoint,action){
 let url;try{url=new URL(endpoint);}catch{throw new ImportError('--endpoint must be a URL',2);}
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.hostname.endsWith('.localhost');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))throw new ImportError('--endpoint must use HTTPS',2);
 return new URL('/api/letterboxd/baseline/'+action,url.origin).toString();
}
// Cloudflare Access service-token headers come from the environment only and are never printed or written.
function accessHeaders(env){
 const id=env.LETTERBOXD_IMPORT_ACCESS_CLIENT_ID,secret=env.LETTERBOXD_IMPORT_ACCESS_CLIENT_SECRET;
 return id&&secret?{'CF-Access-Client-Id':id,'CF-Access-Client-Secret':secret}:{};
}

export async function remote({mode,zip,output,endpoint,fromChunk=0,toChunk=null,fetchImpl=fetch,env=process.env,now=Date.now()}){
 if(!['validate','commit','rollback'].includes(mode))throw new ImportError('Unknown mode',2);
 const {origin,chunkSize,chunks,outputPath}=await loadVerifiedPlan({zip,output,now}),url=endpointUrl(endpoint,mode),last=Math.min(toChunk??chunks.length-1,chunks.length-1);
 const order=[];for(let chunk=fromChunk;chunk<=last;chunk++)order.push(chunk);if(mode==='rollback')order.reverse();
 const originBody={archiveSha256:origin.archiveSha256,generatedAt:origin.generatedAt,generatedAtSource:origin.generatedAtSource};
 const results=[],totals={};
 // The result file is rewritten after every chunk, so a run cut short still leaves what it did and where it stopped.
 const report=async()=>{
  const failed=results.find(result=>result.error),summary={schemaVersion:1,mode,archiveSha256:origin.archiveSha256,chunkSize,chunksRequested:order.length,chunksDone:results.filter(result=>!result.error).length,failed:failed||null,totals};
  await writeFile(path.join(outputPath,mode+'.json'),JSON.stringify({...summary,results},null,1)+'\n',{mode:0o600});
  return summary;
 };
 for(const chunk of order){
  const body=mode==='rollback'?{origin:originBody,chunk}:{origin:originBody,chunk,items:chunks[chunk]};
  // A dropped connection or a client timeout leaves the chunk's outcome unknown: the Worker may have written part of it.
  // It is reported like any failure and the run stops; rerunning the same command completes the chunk from its intent.
  let response;
  try{response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json',...accessHeaders(env)},body:JSON.stringify(body),redirect:'error'});}
  catch(error){results.push({chunk,status:null,error:'network_error',cause:networkCause(error)});break;}
  let data=null;try{data=await response.json();}catch(error){if(response.ok){results.push({chunk,status:response.status,error:'response_unreadable',cause:networkCause(error)});break;}}
  if(!response.ok){results.push({chunk,status:response.status,error:data?.code||data?.error||'http_'+response.status});break;}
  const outcomes=data?.outcomes||data?.facts||{};for(const [key,value] of Object.entries(outcomes))totals[key]=(totals[key]||0)+value;
  results.push({chunk,status:response.status,replay:!!data?.replay,conflicts:data?.conflicts??data?.films?.conflict??0,outcomes});
  await report();
 }
 return report();
}
// Only an error code or name leaves the process: messages can quote the URL or headers.
function networkCause(error){
 const code=[error?.cause?.code,error?.code,error?.name].find(value=>typeof value==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(value));
 return code||'unknown';
}

function parseArgs(argv){
 const [mode,...rest]=argv,args={mode},names={'--zip':'zip','--snapshot':'snapshot','--output':'output','--generated-at':'generatedAt','--chunk-size':'chunkSize','--endpoint':'endpoint','--from-chunk':'fromChunk','--to-chunk':'toChunk'};
 for(let i=0;i<rest.length;i++){const name=names[rest[i]];if(!name||i+1>=rest.length)throw new ImportError('Usage: letterboxd-baseline-import.mjs plan --zip <abs> --snapshot <abs> --output <abs> [--generated-at <UTC>] [--chunk-size 1..'+MAX_CHUNK_SIZE+'] | validate|commit|rollback --zip <abs> --output <abs> --endpoint <https://…> [--from-chunk n] [--to-chunk n]',2);args[name]=rest[++i];}
 for(const key of ['fromChunk','toChunk'])if(args[key]!=null){args[key]=Number(args[key]);if(!Number.isInteger(args[key])||args[key]<0)throw new ImportError('Chunk numbers are non-negative integers',2);}
 // The chunk size belongs to the plan; the remote steps read it from origin.json.
 if(args.chunkSize!=null){if(mode!=='plan')throw new ImportError('--chunk-size is a plan option; '+mode+' uses the chunk size in origin.json',2);args.chunkSize=checkChunkSize(/^\d+$/.test(args.chunkSize)?Number(args.chunkSize):NaN);}
 return args;
}
async function main(){
 try{
  const args=parseArgs(process.argv.slice(2));
  if(args.mode==='plan'){if(!args.zip||!args.snapshot||!args.output)throw new ImportError('plan needs --zip, --snapshot and --output',2);console.log(JSON.stringify(await plan(args)));return;}
  if(!args.zip||!args.output||!args.endpoint)throw new ImportError(args.mode+' needs --zip, --output and --endpoint',2);
  const summary=await remote(args);console.log(JSON.stringify(summary));if(summary.failed)process.exit(1);
 }catch(error){
  const known=error instanceof ImportError||error instanceof ReconcileError||error?.name==='ZipError'||error?.name==='CsvError';
  console.error(known?error.message:'Baseline import failed');process.exit(error.exitCode||1);
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
