// AIR-388 B2 (ADR 0105): bounded TMDB title search for the export films the live catalog does not know. Offline except for the search itself.
// node scripts/letterboxd-tmdb-search.mjs --export <abs dir> --catalog-dir <abs dir> --output <abs dir> [--max-requests 1..1500] [--rps >0..4] [--dry-run]
// - Reads the four named CSVs of the extracted export and a catalog directory (see loadCatalogDir), matches with the inferred policy, and
//   asks TMDB once per still-unmatched film (search/movie, page 1, one attempt, never a retry). The first 403 or 429 ends the run.
// - The credential is TMDB_READ_TOKEN (a read-only API read access token) from the environment only; it is sent as a bearer header and is
//   never printed or written. Without it only --dry-run runs. No new credential is created by this tool.
// - Writes `tmdb-results.json` (private, outside the repository) and prints counts only: no name, code or year reaches standard output.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EXPORT_FILES,parseExport} from '../src/letterboxd-export.js';
import {buildIndex,matchExport} from '../src/letterboxd-match.js';
import {DEFAULT_MAX_REQUESTS,DEFAULT_RPS,MAX_RPS,runSearches,searchUrl} from '../src/letterboxd-tmdb-search.js';
import {ReconcileError,assertOutsideRepository,exportDigest,loadCatalogDir} from './letterboxd-reconcile.mjs';

export async function unmatchedFilms({exportDir,catalogDir}){
 const texts={};
 for(const [kind,name] of Object.entries(EXPORT_FILES)){try{texts[kind]=await readFile(path.join(exportDir,name),'utf8');}catch(error){if(error.code!=='ENOENT')throw new ReconcileError('Export file '+name+' could not be read',2);texts[kind]=null;}}
 if(texts.watched===null)throw new ReconcileError('Export directory has no '+EXPORT_FILES.watched,2);
 const parsed=parseExport(texts),loaded=await loadCatalogDir(catalogDir),index=buildIndex(loaded.objects);
 const matches=matchExport(parsed.films,index,{inferred:true}),byCode=new Map(parsed.films.map(film=>[film.code,film]));
 const films=matches.filter(match=>match.status==='unmatched').map(match=>byCode.get(match.code)).sort((a,b)=>a.code<b.code?-1:1);
 return {films,total:parsed.films.length,exportSha256:exportDigest(texts),status:Object.fromEntries([...new Set(matches.map(match=>match.status))].map(status=>[status,matches.filter(match=>match.status===status).length])),provenance:loaded.baselineIdentity};
}

export function tmdbSearchFn({token,fetchImpl=fetch,timeoutMs=20000}){
 return async film=>{
  const response=await fetchImpl(searchUrl(film),{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(response.status!==200){await response.body?.cancel();return {status:response.status};}
  let body;try{body=await response.json();}catch{return {status:502};}
  return {status:200,results:Array.isArray(body?.results)?body.results.map(({id,title,original_title,release_date})=>({id,title,original_title,release_date})):[]};
 };
}

export async function main(argv=process.argv.slice(2),{env=process.env,fetchImpl=fetch,sleep,now}={}){
 const args={};
 for(let i=0;i<argv.length;i++){
  if(argv[i]==='--dry-run'){args.dry=true;continue;}
  const name={'--export':'exportDir','--catalog-dir':'catalogDir','--output':'outputDir','--max-requests':'maxRequests','--rps':'rps'}[argv[i]];
  if(!name||i+1>=argv.length)throw new ReconcileError('Usage: letterboxd-tmdb-search.mjs --export <abs> --catalog-dir <abs> --output <abs> [--max-requests n] [--rps n] [--dry-run]',2);
  args[name]=argv[++i];
 }
 if(!args.exportDir||!args.catalogDir||!args.outputDir)throw new ReconcileError('--export, --catalog-dir and --output are required',2);
 const maxRequests=args.maxRequests===undefined?DEFAULT_MAX_REQUESTS:Number(args.maxRequests),rps=args.rps===undefined?DEFAULT_RPS:Number(args.rps);
 if(!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>DEFAULT_MAX_REQUESTS)throw new ReconcileError('--max-requests must be an integer 1..'+DEFAULT_MAX_REQUESTS,2);
 if(!(rps>0)||rps>MAX_RPS)throw new ReconcileError('--rps must be above 0 and at most '+MAX_RPS,2);
 const exportDir=await assertOutsideRepository(args.exportDir,'--export'),catalogDir=await assertOutsideRepository(args.catalogDir,'--catalog-dir'),outputDir=await assertOutsideRepository(args.outputDir,'--output');
 const {films,total,exportSha256,status,provenance}=await unmatchedFilms({exportDir,catalogDir});
 const binding={exportSha256,catalogReadAt:provenance.readAt,catalogFilms:provenance.catalogFilms};
 const file=path.join(outputDir,'tmdb-results.json');
 // The results file is bound to the export and the catalog read it was made for, and it keeps the cumulative request count: a resume asks
 // only the films with no recorded attempt and can never spend more than the total budget. A file for another input is refused, not reused.
 let state={results:{},requests:0};
 let prior=null;try{prior=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new ReconcileError('The existing tmdb-results.json is not readable JSON',2);}
 if(prior){
  if(prior.schemaVersion!==1||!prior.results||typeof prior.results!=='object'||!prior.binding||prior.binding.exportSha256!==binding.exportSha256||prior.binding.catalogReadAt!==binding.catalogReadAt||prior.binding.catalogFilms!==binding.catalogFilms)throw new ReconcileError('The existing tmdb-results.json belongs to another export or catalog read; use a new --output directory',2);
  state={results:prior.results,requests:Number.isInteger(prior.requests)&&prior.requests>=0?prior.requests:0};
 }
 const pending=films.filter(film=>!Object.hasOwn(state.results,film.code)).length;
 const budgetLeft=Math.max(0,maxRequests-state.requests);
 if(args.dry)return {dryRun:true,exportFilms:total,matchStatus:status,unmatched:films.length,alreadyAttempted:films.length-pending,requestsUsed:state.requests,requestsWouldBeMade:Math.min(pending,budgetLeft),maxRequests,rps,catalog:provenance};
 const token=String(env.TMDB_READ_TOKEN||'').trim();
 if(!token)throw new ReconcileError('TMDB_READ_TOKEN is not set: no TMDB request was made',2);
 let outcome;
 try{outcome=await runSearches({films,search:tmdbSearchFn({token,fetchImpl}),state,maxRequests,rps,...(sleep?{sleep}:{}),...(now?{now}:{})});}
 finally{
  // Whatever happened, what was attempted is on disk before this process ends.
  await mkdir(outputDir,{recursive:true,mode:0o700});
  await writeFile(file,JSON.stringify({schemaVersion:1,binding,requests:state.requests,provenance:{searchedAt:new Date().toISOString(),catalog:provenance},results:state.results},null,1)+'\n',{mode:0o600});
 }
 return {exportFilms:total,unmatched:films.length,requests:outcome.requests,totalRequests:outcome.totalRequests,stopped:outcome.stopped,remaining:outcome.remaining,counts:outcome.counts};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await main()));}
 catch(error){const known=error instanceof ReconcileError||error?.name==='CsvError';console.error(known?error.message:'TMDB search failed');process.exit(error.exitCode||1);}
}
