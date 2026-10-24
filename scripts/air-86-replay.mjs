import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';

export const HISTORICAL_EVIDENCE = [
 'docs/evidence/scored-resolver/air-86-replay-manifest.json',
 'docs/evidence/scored-resolver/air-86-replay-results.json',
 'docs/evidence/scored-resolver/air-99-detail.json',
 'docs/evidence/d1-migration/air-73-offline-run.json',
];

function canonicalEvidencePath(file){
 const resolved = path.resolve(file);
 let located = resolved;
 try{located = fs.realpathSync(resolved);}
 catch{
  try{located = path.join(fs.realpathSync(path.dirname(resolved)),path.basename(resolved));}
  catch{located = resolved;}
 }
 return process.platform==='linux'?located:located.toLowerCase();
}

export function historicalEvidenceOutput(raw){
 if(typeof raw!=='string'||raw.trim()==='')return {ok:false,reason:'output path is required'};
 if(HISTORICAL_EVIDENCE.some(file=>canonicalEvidencePath(raw)===canonicalEvidencePath(file)))return {ok:false,reason:'refusing to overwrite historical evidence'};
 return {ok:true,path:path.resolve(raw)};
}

const CAP = 130;
const ROW_CAP = 8;
const RUN_ID = 'cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb';

export function loadProduction(){
 const live = vm.createContext({});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(file,'utf8'),live);
 return live;
}
function invoke(live,name,args){
 live.__args = args;
 return vm.runInContext(`${name}(...__args)`,live);
}
function languageOf(_live,title){
 return /[іїєґ]/i.test(title)?'uk-UA':'ru-RU';
}
function searchPath(variant,language){
 return 'search/movie?'+new URLSearchParams({query:variant.query,language,include_adult:'false',...(variant.year!=null?{year:String(variant.year)}:{})});
}
function detailPath(id,alias){
 const append = alias?'translations,alternative_titles':'credits,translations,alternative_titles';
 return `movie/${id}?language=ru-RU&append_to_response=${append}`;
}
function movieCard(movie){
 const year = Number(String(movie?.release_date||'').slice(0,4))||null;
 return {tmdbId:movie?.id==null?null:String(movie.id),title:movie?.title||'',original:movie?.original_title||'',year,runtime:movie?.runtime??null};
}

export async function runReplay({manifest,context,request,now,cap=CAP,rowCap=ROW_CAP}){
 const live = loadProduction();
 const items = manifest.items;
 if(manifest.strictCohort&&(items.length!==38||manifest.plannedSearches!==87))throw new Error('manifest cohort changed');
 const meter = {total:0,search:0,detail:0,alias:0,errors:0,halted:false,budgetStop:false,calls:[]};
 const rows = [];
 const priors = context?.priors||{};
 const candidates = context?.candidates||{};
 const decisions = context?.decisions||{};
 async function call(row,kind,path){
  if(meter.halted||meter.budgetStop)return {skipped:true};
  if(meter.total>=cap){meter.budgetStop=true;return {skipped:true,reason:'budget'};}
  if(row.http>=rowCap)return {skipped:true,reason:'row_cap'};
  meter.total++;
  row.http++;
  meter[kind]++;
  let status=0,body=null,code='ok';
  try{
   const response = await request(path);
   status = response?.status??0;
   body = response?.json??null;
   if(status===429){meter.halted=true;code='429';}
   else if(status===401||status===403){meter.halted=true;meter.errors++;code='auth';}
   else if(status<200||status>=300){meter.errors++;code='http_'+status;}
  }catch(error){
   meter.errors++;
   code = error?.name==='TimeoutError'?'timeout':'network';
   status = 0;
  }
  meter.calls.push({n:meter.total,key:row.key,kind,status,code});
  return {status,body,code,skipped:false};
 }
 for(const item of items){
  const planned = invoke(live,'candidateSearchVariants',[{title:item.title,year:item.year,normalizedTitle:item.key.split('|')[0]}]);
  if(JSON.stringify(planned.map(({query,year,reason})=>({query,year,reason})))!==JSON.stringify(item.variants))throw new Error('variant drift '+item.key);
  const source = candidates[item.key]||{};
  const candidate = {key:item.key,title:item.title,normalizedTitle:source.normalizedTitle||item.key.slice(0,item.key.lastIndexOf('|')),year:item.year,duration:source.duration??item.durations?.[0]??null,durations:source.durations||item.durations||[],shows:source.shows||[],seenInLatestSnapshot:source.seenInLatestSnapshot!==false,lastSeenAt:source.lastSeenAt??null,lastAiring:source.lastAiring??null};
  const row = {order:item.order,key:item.key,group:item.group,title:item.title,year:item.year,legacyStatus:item.legacyStatus,evidenceState:item.evidenceState,planned:item.variants,sent:[],unsent:[],hits:[],pool:[],http:0,searchCalls:0,detailCalls:0,aliasCalls:0,score:null,liveGate:null,recognitionGate:null,detail:null,aliases:[],evaluation:'not_evaluated',stop:null};
  rows.push(row);
  if(meter.halted||meter.budgetStop){row.stop='not_started';continue;}
  if(!source.found&&context?.requireLedger){row.stop='missing_ledger';row.evaluation='not_evaluated';continue;}
  const language = languageOf(live,candidate.title);
  let exact=false;
  for(let index=0;index<item.variants.length;index++){
   const variant = item.variants[index];
   const response = await call(row,'search',searchPath(variant,language));
   if(response.skipped){row.unsent.push({...variant,reasonSkipped:response.reason||(meter.halted?'halted':'budget')});for(const rest of item.variants.slice(index+1))row.unsent.push({...rest,reasonSkipped:meter.halted?'halted':'budget'});row.stop=response.reason||(meter.halted?'halted':'budget');break;}
   row.searchCalls++;
   row.sent.push(variant);
   if(response.code!=='ok'){if(meter.halted){for(const rest of item.variants.slice(index+1))row.unsent.push({...rest,reasonSkipped:'halted'});row.stop='halted';}continue;}
   for(const movie of response.body?.results||[]){
    const kept = invoke(live,'variantHit',[candidate,movie,variant]);
    if(!kept){if(movie?.id!=null&&!row.pool.some(entry=>entry.tmdbId===String(movie.id)))row.pool.push(movieCard(movie));continue;}
    if(row.hits.some(hit=>hit.tmdbId===String(movie.id)))continue;
    const hit = invoke(live,'searchHitCandidate',[movie]);
    row.hits.push({...hit,query:variant.query,queryYear:variant.year,variantReason:variant.reason});
   }
   exact = row.hits.some(hit=>invoke(live,'norm',[hit.title])===candidate.normalizedTitle||invoke(live,'norm',[hit.original])===candidate.normalizedTitle);
   if(exact){for(const rest of item.variants.slice(index+1))row.unsent.push({...rest,reasonSkipped:'exact_title'});row.stop='exact_title';break;}
  }
  if(!row.stop)row.stop='searched';
  const prior = (priors[candidate.normalizedTitle]||[]).map(film=>({tmdbId:String(film.tmdbId),title:film.title||'',original:film.original||'',aliases:film.aliases||[],year:film.year??null,runtime:film.runtime??null,trusted:film.canonicalIdentity==='tmdb:'+film.tmdbId}));
  const observation = {key:candidate.key,title:candidate.title,normalizedTitle:candidate.normalizedTitle,year:candidate.year,duration:candidate.duration,durations:candidate.durations};
  const score = invoke(live,'scoreFilmResolution',[{observation,candidates:[...prior,...row.hits.map(hit=>({tmdbId:hit.tmdbId,title:hit.title,original:hit.original,year:hit.year,runtime:hit.runtime,trusted:false}))]}]);
  row.score = {status:score.status,reason:score.reason,acceptedTmdbId:score.acceptedTmdbId??null,score:score.score};
  row.knownBefore = !!score.acceptedTmdbId&&prior.some(film=>film.tmdbId===String(score.acceptedTmdbId));
  row.candidate = candidate;
  row.priorCount = prior.length;
  row._score = score;
  row._priorFilms = priors[candidate.normalizedTitle]||[];
 }
 for(const row of rows){
  if(!row._score||row._score.status!=='accepted'||!row._score.acceptedTmdbId)continue;
  if(meter.halted||meter.budgetStop){row.detail={attempted:false,reason:'budget_or_halt'};continue;}
  const response = await call(row,'detail',detailPath(row._score.acceptedTmdbId,false));
  if(response.skipped){row.detail={attempted:false,reason:response.reason||'budget'};continue;}
  row.detailCalls++;
  if(response.code!=='ok'||String(response.body?.id)!==String(row._score.acceptedTmdbId)){row.detail={attempted:true,checked:false,status:response.status,code:response.code};continue;}
  row.detail={attempted:true,checked:true,status:response.status,...movieCard(response.body),runtime:response.body.runtime??null};
  row._detail = invoke(live,'tmdbDetailFromMovie',[response.body]);
 }
 for(const row of rows){
  if(!row._score)continue;
  const decision = decisions[row.key]||null;
  const films = {};
  for(const film of row._priorFilms)if(film?.tmdbId)films['tmdb_'+film.tmdbId]=film;
  const competitors = row._priorFilms.filter(film=>film?.tmdbId&&String(film.tmdbId)!==String(row._score.acceptedTmdbId)).map(film=>({tmdbId:String(film.tmdbId),title:film.title||'',original:film.original||'',aliases:film.aliases||[],year:film.year??null}));
  const gateFor = (decisionMap,extra)=>invoke(live,'gateScoredCandidate',[{epgPin:{programmeRunId:RUN_ID}},{programmeRunId:RUN_ID},row.candidate,row._score,decisionMap,films,now,extra]);
  row.liveGate = gateFor({[row.key]:decision},row._detail?{tmdbDetail:row._detail,competitors}:{competitors});
  row.recognitionGate = gateFor({},row._detail?{tmdbDetail:row._detail,competitors}:{competitors});
  row.liveGate = {outcome:row.liveGate.outcome,reason:row.liveGate.reason};
  row.recognitionGate = {outcome:row.recognitionGate.outcome,reason:row.recognitionGate.reason};
  const searchesDone = row.stop==='searched'||row.stop==='exact_title';
  const needsDetail = row._score.status==='accepted'&&row._score.acceptedTmdbId;
  const detailDone = !needsDetail||row.detail?.checked||row.detail?.attempted;
  row.evaluation = !row.sent.length?'not_evaluated':searchesDone&&detailDone?'evaluated':'partially_evaluated';
  if(row.detail?.attempted&&!row.detail.checked&&needsDetail)row.evaluation='partially_evaluated';
 }
 for(const row of rows){
  if(meter.halted||meter.budgetStop)break;
  if(!row.pool.length)continue;
  const ranked = invoke(live,'variantAliasRank',[row.candidate,row.pool.map(movie=>({id:movie.tmdbId,title:movie.title,original_title:movie.original,release_date:movie.year?String(movie.year)+'-01-01':'',runtime:movie.runtime}))]).slice(0,3);
  for(const entry of ranked){
   if(meter.halted||meter.budgetStop||row.http>=rowCap)break;
   const id = String(entry.movie.id);
   const response = await call(row,'alias',detailPath(id,true));
   if(response.skipped)break;
   row.aliasCalls++;
   const aliases = [...(response.body?.alternative_titles?.titles||[]).map(item=>item?.title),...(response.body?.translations?.translations||[]).map(item=>item?.data?.title)].filter(Boolean);
   const matched = aliases.find(title=>invoke(live,'norm',[title])===row.candidate.normalizedTitle)||null;
   row.aliases.push({tmdbId:id,status:response.status,code:response.code,matched,title:response.body?.title||entry.movie.title||'',year:Number(String(response.body?.release_date||'').slice(0,4))||entry.movie.year||null,feedsScorer:false});
  }
 }
 for(const row of rows){delete row._score;delete row._detail;delete row._priorFilms;delete row.candidate;}
 const groups = {};
 for(const row of rows){
  const bucket = groups[row.group]||(groups[row.group]={rows:0,evaluated:0,partial:0,none:0,search:0,detail:0,alias:0,accepted:0,detailVerified:0});
  bucket.rows++;
  bucket.search+=row.searchCalls;bucket.detail+=row.detailCalls;bucket.alias+=row.aliasCalls;
  if(row.evaluation==='evaluated')bucket.evaluated++;
  else if(row.evaluation==='partially_evaluated')bucket.partial++;
  else bucket.none++;
  if(row.score?.status==='accepted')bucket.accepted++;
  if(row.recognitionGate?.outcome==='detail_verified')bucket.detailVerified++;
 }
 return {cap,rowCap,now:new Date(now).toISOString(),programmeRunId:RUN_ID,http:meter,diagnosticCalls:0,groups,rows};
}

async function main(){
 const token = process.env.TMDB_API_READ_ACCESS_TOKEN;
 if(!token){console.error('TMDB_API_READ_ACCESS_TOKEN is unset');process.exit(2);}
 const output = historicalEvidenceOutput(process.argv[2]);
 if(!output.ok){console.error(output.reason);process.exit(2);}
 const manifest = JSON.parse(fs.readFileSync('docs/evidence/scored-resolver/air-86-replay-manifest.json','utf8'));
 const context = JSON.parse(fs.readFileSync(process.env.AIR86_CONTEXT||'.air86-context.json','utf8'));
 const found = Object.values(context.candidates||{}).filter(row=>row.found).length;
 if(found!==38){console.error('ledger context is incomplete');process.exit(2);}
 const result = await runReplay({manifest:{...manifest,strictCohort:true},context,now:Date.parse(manifest.capturedAt),request:async path=>{
  if(process.env.TMDB_REQUEST_INTERVAL_MS!=='0')await new Promise(resolve=>setTimeout(resolve,200));
  const response = await fetch('https://api.themoviedb.org/3/'+path,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(12000)});
  const json = response.status===204?null:await response.json().catch(()=>null);
  return {status:response.status,json};
 }});
 fs.writeFileSync(output.path,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({total:result.http.total,search:result.http.search,detail:result.http.detail,alias:result.http.alias,errors:result.http.errors,halted:result.http.halted,budgetStop:result.http.budgetStop}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
