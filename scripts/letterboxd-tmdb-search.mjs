// AIR-388 B2 (ADR 0105): bounded TMDB title search for the export films the live catalog does not know. Offline except for the search itself.
// node scripts/letterboxd-tmdb-search.mjs --export <abs dir> --catalog-dir <abs dir> --output <abs dir> [--max-requests 1..1500] [--rps >0..4] [--dry-run]
// - Reads the four named CSVs of the extracted export and a catalog directory (see loadCatalogDir), matches with the inferred policy, and
//   asks TMDB once per still-unmatched film (search/movie, page 1, one attempt, never a retry). The first 403 or 429 ends the run.
// - Credential, one of two ways, never printed or written, and this tool creates none. Default: TMDB_READ_TOKEN (a read-only API read access
//   token) from the environment, sent as a bearer header; without it only --dry-run runs. `--auth proxy`: the environment injects the
//   Authorization header itself for api.themoviedb.org (a network secret of the cloud environment), the tool sends none and needs no token.
//   Under a proxy, run it with NODE_USE_ENV_PROXY=1, or Node's fetch ignores the proxy. A 401 ends the run without recording that film.
// - Writes `tmdb-results.json` (private, outside the repository) and prints counts only: no name, code or year reaches standard output.
// node scripts/letterboxd-tmdb-search.mjs rebase --export <abs dir> --catalog-dir <abs dir> --previous <abs tmdb-results.json> --output <abs new dir>
// - Offline, no network, no credential. Re-binds an already searched results file to a NEWER catalog read (ADR 0105): the export digest must be the
//   same, the whole export is matched again against the new catalog, and every recorded decision is re-judged. See rebaseResults.
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EXPORT_FILES,parseExport} from '../src/letterboxd-export.js';
import {buildIndex,matchExport,normTitle} from '../src/letterboxd-match.js';
import {DEFAULT_MAX_REQUESTS,DEFAULT_RPS,MAX_RPS,runSearches,searchUrl} from '../src/letterboxd-tmdb-search.js';
import {ReconcileError,assertOutsideRepository,exportDigest,loadCatalogDir} from './letterboxd-reconcile.mjs';

export async function unmatchedFilms({exportDir,catalogDir}){
 const texts={};
 for(const [kind,name] of Object.entries(EXPORT_FILES)){try{texts[kind]=await readFile(path.join(exportDir,name),'utf8');}catch(error){if(error.code!=='ENOENT')throw new ReconcileError('Export file '+name+' could not be read',2);texts[kind]=null;}}
 if(texts.watched===null)throw new ReconcileError('Export directory has no '+EXPORT_FILES.watched,2);
 const parsed=parseExport(texts),loaded=await loadCatalogDir(catalogDir),index=buildIndex(loaded.objects);
 const matches=matchExport(parsed.films,index,{inferred:true}),byCode=new Map(parsed.films.map(film=>[film.code,film]));
 const films=matches.filter(match=>match.status==='unmatched').map(match=>byCode.get(match.code)).sort((a,b)=>a.code<b.code?-1:1);
 return {films,matches,index,byCode,total:parsed.films.length,exportSha256:exportDigest(texts),status:Object.fromEntries([...new Set(matches.map(match=>match.status))].map(status=>[status,matches.filter(match=>match.status===status).length])),provenance:loaded.baselineIdentity};
}

const sha256=text=>createHash('sha256').update(text).digest('hex');
const TMDB_ID=/^[1-9]\d{0,11}$/;
const bump=(map,key)=>{map[key]=(map[key]||0)+1;};

// Offline re-binding of an already searched results file to a newer catalog read (ADR 0105). It never asks TMDB, never lowers the cumulative
// request count and never rewrites the old file: the output is a new file in a new empty directory whose `rebase` block keeps the original
// binding, provenance, request count and file digest. The export must be byte-identical (same digest). The whole export is matched again
// against the new catalog and every recorded code is re-judged, failing closed:
//  - still unmatched: the attempt is kept as recorded (one attempt per film, ever); an `inferred_new` entry must still agree with its export
//    film (original title, exact year) or the rebase stops; one whose TMDB movie is now linked to another Letterboxd code, or whose code is
//    now linked to another movie, becomes `review: tmdb_linked_elsewhere`; a duplicate claim or an already accepted/inferred movie is left to
//    the planner, which sends both to review as before;
//  - the catalog now knows the film (accepted, inferred, provisional, candidate): the search entry leaves `results` for `rebase.superseded`
//    (kept, never used) and the catalog decides;
//  - the film is now ambiguous or in conflict, or a recorded code is no longer in the export: STOP, nothing is written;
//  - unmatched with no recorded attempt: stays pending. Nothing is searched here.
export async function rebaseResults({exportDir,catalogDir,previous,outputDir,now=()=>new Date()}){
 const previousText=await readFile(previous,'utf8');let doc;try{doc=JSON.parse(previousText);}catch{throw new ReconcileError('The previous tmdb-results.json is not readable JSON',2);}
 if(doc?.schemaVersion!==1||!doc.results||typeof doc.results!=='object'||Array.isArray(doc.results)||!doc.binding||!Number.isInteger(doc.requests)||doc.requests<0)throw new ReconcileError('The previous tmdb-results.json has an unknown schema',2);
 const target=path.join(outputDir,'tmdb-results.json');
 if(await access(target).then(()=>true,()=>false))throw new ReconcileError('--output already holds a tmdb-results.json; rebase into a new empty directory',2);
 const {matches,index,byCode,total,exportSha256,provenance}=await unmatchedFilms({exportDir,catalogDir});
 if(doc.binding.exportSha256!==exportSha256)throw new ReconcileError('The previous results were searched for another export: a rebase needs the same export digest',3);
 if(doc.binding.catalogReadAt===provenance.readAt&&doc.binding.catalogFilms===provenance.catalogFilms)throw new ReconcileError('The catalog read is the one the results are already bound to: nothing to rebase',2);
 const statusOf=new Map(matches.map(match=>[match.code,match]));
 const report={exportFilms:total,previousRequests:doc.requests,previousCatalog:{readAt:doc.binding.catalogReadAt,films:doc.binding.catalogFilms},catalog:{readAt:provenance.readAt,films:provenance.catalogFilms},recorded:Object.keys(doc.results).length,kept:{},superseded:{},movedToReview:{tmdb_linked_elsewhere:0},keptInferredNewWithExistingFilm:0,pendingWithoutAttempt:0,stop:{}};
 const results={},superseded={};
 for(const [code,entry] of Object.entries(doc.results)){
  const film=byCode.get(code),match=statusOf.get(code);
  if(!film||!match){bump(report.stop,'code_not_in_export');continue;}
  if(match.status==='ambiguous'||match.status==='conflict'){bump(report.stop,'now_'+match.status);continue;}
  if(match.status!=='unmatched'){superseded[code]={now:match.status,entry};bump(report.superseded,match.status);continue;}
  if(entry?.decision==='inferred_new'){
   if(!TMDB_ID.test(String(entry.tmdb))||!Number.isInteger(entry.year)||typeof entry.title!=='string'||!Number.isInteger(film.year)||entry.year!==film.year||!normTitle(film.name)||normTitle(entry.title)!==normTitle(film.name)){bump(report.stop,'title_or_year_mismatch');continue;}
   const tmdb=String(entry.tmdb),lids=index.linkedLids.get(tmdb),codeTmdb=index.linkedTmdb.get(code);
   if((lids&&[...lids].some(lid=>lid!==code))||(codeTmdb&&[...codeTmdb].some(id=>id!==tmdb))){results[code]={decision:'review',reason:'tmdb_linked_elsewhere'};superseded[code]={now:'unmatched',entry};report.movedToReview.tmdb_linked_elsewhere++;bump(report.kept,'review');continue;}
   if(index.catalogByTmdb.has(tmdb))report.keptInferredNewWithExistingFilm++;
  }
  results[code]=entry;bump(report.kept,entry?.decision==='review'?'review':entry?.decision);
 }
 if(Object.keys(report.stop).length)throw Object.assign(new ReconcileError('The rebase stops, nothing was written: '+JSON.stringify(report.stop),3),{report});
 report.pendingWithoutAttempt=matches.filter(match=>match.status==='unmatched'&&!Object.hasOwn(results,match.code)&&!Object.hasOwn(superseded,match.code)).length;
 const out={schemaVersion:1,binding:{exportSha256,catalogReadAt:provenance.readAt,catalogFilms:provenance.catalogFilms},requests:doc.requests,
  provenance:{searchedAt:doc.provenance?.searchedAt??null,catalog:doc.provenance?.catalog??null},
  rebase:{rebasedAt:now().toISOString(),original:{binding:doc.binding,provenance:doc.provenance??null,requests:doc.requests,resultsSha256:sha256(previousText)},counts:{kept:report.kept,superseded:report.superseded,movedToReview:report.movedToReview},superseded},
  results};
 await mkdir(outputDir,{recursive:true,mode:0o700});
 await writeFile(target,JSON.stringify(out,null,1)+'\n',{mode:0o600,flag:'wx'});
 return {rebased:true,...report,requests:doc.requests};
}

export function tmdbSearchFn({token,auth='token',fetchImpl=fetch,timeoutMs=20000}){
 return async film=>{
  const headers=auth==='proxy'?{Accept:'application/json'}:{Authorization:'Bearer '+token,Accept:'application/json'};
  const response=await fetchImpl(searchUrl(film),{headers,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(response.status!==200){await response.body?.cancel();return {status:response.status};}
  let body;try{body=await response.json();}catch{return {status:502};}
  return {status:200,results:Array.isArray(body?.results)?body.results.map(({id,title,original_title,release_date})=>({id,title,original_title,release_date})):[]};
 };
}

export async function main(argv=process.argv.slice(2),{env=process.env,fetchImpl=fetch,sleep,now}={}){
 const args={};
 const rebasing=argv[0]==='rebase';if(rebasing)argv=argv.slice(1);
 for(let i=0;i<argv.length;i++){
  if(argv[i]==='--dry-run'){args.dry=true;continue;}
  const name={'--export':'exportDir','--catalog-dir':'catalogDir','--output':'outputDir','--max-requests':'maxRequests','--rps':'rps','--auth':'auth','--previous':'previous'}[argv[i]];
  if(!name||i+1>=argv.length)throw new ReconcileError('Usage: letterboxd-tmdb-search.mjs --export <abs> --catalog-dir <abs> --output <abs> [--max-requests n] [--rps n] [--auth token|proxy] [--dry-run]',2);
  args[name]=argv[++i];
 }
 if(!args.exportDir||!args.catalogDir||!args.outputDir)throw new ReconcileError('--export, --catalog-dir and --output are required',2);
 if(rebasing){
  if(!args.previous||args.dry||args.maxRequests!==undefined||args.rps!==undefined||args.auth!==undefined)throw new ReconcileError('Usage: letterboxd-tmdb-search.mjs rebase --export <abs> --catalog-dir <abs> --previous <abs tmdb-results.json> --output <abs new dir>',2);
  const [exportDir,catalogDir,previous,outputDir]=[await assertOutsideRepository(args.exportDir,'--export'),await assertOutsideRepository(args.catalogDir,'--catalog-dir'),await assertOutsideRepository(args.previous,'--previous'),await assertOutsideRepository(args.outputDir,'--output')];
  return rebaseResults({exportDir,catalogDir,previous,outputDir,...(now?{now:()=>new Date(now())}:{})});
 }
 if(args.previous!==undefined)throw new ReconcileError('--previous belongs to the rebase command',2);
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
 const auth=args.auth===undefined?'token':args.auth;
 if(auth!=='token'&&auth!=='proxy')throw new ReconcileError('--auth must be token or proxy',2);
 const token=String(env.TMDB_READ_TOKEN||'').trim();
 if(auth==='token'&&!token)throw new ReconcileError('TMDB_READ_TOKEN is not set: no TMDB request was made',2);
 let outcome;
 try{outcome=await runSearches({films,search:tmdbSearchFn({token,auth,fetchImpl}),state,maxRequests,rps,...(sleep?{sleep}:{}),...(now?{now}:{})});}
 finally{
  // Whatever happened, what was attempted is on disk before this process ends.
  await mkdir(outputDir,{recursive:true,mode:0o700});
  await writeFile(file,JSON.stringify({schemaVersion:1,binding,requests:state.requests,provenance:{searchedAt:new Date().toISOString(),catalog:provenance},...(prior?.rebase?{rebase:prior.rebase}:{}),results:state.results},null,1)+'\n',{mode:0o600});
 }
 return {auth,exportFilms:total,unmatched:films.length,requests:outcome.requests,totalRequests:outcome.totalRequests,stopped:outcome.stopped,remaining:outcome.remaining,counts:outcome.counts};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await main()));}
 catch(error){const known=error instanceof ReconcileError||error?.name==='CsvError';console.error(known?error.message:'TMDB search failed');process.exit(error.exitCode||1);}
}
