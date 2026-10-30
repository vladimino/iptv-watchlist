// AIR-286: TMDB credits for the watchlist Films in D1, the bridge that lets a Letterboxd and a TMDB person be proven the same
// through a shared Film (ADR-0009, AIR-201). Watchlist Films carry only Letterboxd credits and catalog Films only TMDB credits,
// so the coCredit review queue is empty until one Film carries both. This adds TMDB directors and actors, in the id and name
// format discovery stores (tmdb_director/<id>, tmdb_actor/<id>, the ru-RU credit name, the first ten of each), next to the
// existing credits. It merges nothing, matches nothing by name, and leaves Film identity, ratings and predictions alone.
// A Film whose TMDB movie id is retired (a miniseries now living as a TV series) takes its credits from the one TMDB entry its
// Letterboxd page links to.
// Three separate steps: --fetch reads TMDB into a private artifact, --plan diffs that artifact against D1 and writes nothing,
// --apply writes the missing rows through the D1 HTTP API. Every write is idempotent; a repeated --apply changes nothing.
// It never touches R2, a Worker binding or the deploy configuration. Writing to production D1 is a separately approved step.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {D1Error,DEFAULT_ENDPOINT,DEFAULT_MAX_BATCH_BYTES,DEFAULT_MAX_BATCH_STATEMENTS,TARGET_DATABASE_NAME,createD1Adapter,endpointFor} from './d1-backfill.mjs';

const REPO_ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const PEOPLE_PER_ROLE=10;
export const DEFAULT_INTERVAL_MS=200;
export const PERSON_CONTRACT_VERSION=1;
export const ALIAS_PROVENANCE=JSON.stringify({source:'tmdb',task:'AIR-286'});
const TMDB_BASE='https://api.themoviedb.org/3/';
const TRANSIENT=new Set([500,502,503,504]);
const sleepFor=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
export const tmdbPath=tmdbId=>'movie/'+tmdbId+'?language=ru-RU&append_to_response=credits';
// A miniseries is a TV entry at TMDB; its directors are credited per episode, so only aggregate_credits names them.
export const tmdbTvPath=tvId=>'tv/'+tvId+'?language=ru-RU&append_to_response=credits,aggregate_credits';
export const sourceOf=(kind,id)=>kind==='tv'?{kind,id:String(id),path:tmdbTvPath(id),file:'tv-'+id+'.json'}:{kind:'movie',id:String(id),path:tmdbPath(id),file:id+'.json'};
export class CreditsStop extends Error{constructor(reason,details={}){super('Stopped: '+reason);this.name='CreditsStop';this.reason=reason;this.details=details;}}

// Watchlist Films are the Films with a Letterboxd id. A trusted `tmdb_tv` identity (AIR-290) is the Film's TMDB entry and its
// credits are read from the TV entry, never from the retired movie id; otherwise exactly one trusted, non-conflicting TMDB
// movie id is usable. Several trusted ids of one scheme are ambiguous and skipped.
export async function watchlistFilms(db){
 const rows=await db.all(`SELECT l.film_id AS filmId,MIN(t.value) AS tmdbId,COUNT(DISTINCT t.value) AS ids,MIN(v.value) AS tvId,COUNT(DISTINCT v.value) AS tvIds,MIN(m.url) AS letterboxdUrl FROM film_external_id l LEFT JOIN film_external_id t ON t.film_id=l.film_id AND t.scheme='tmdb' AND t.trusted=1 AND t.conflicting=0 LEFT JOIN film_external_id v ON v.film_id=l.film_id AND v.scheme='tmdb_tv' AND v.trusted=1 AND v.conflicting=0 LEFT JOIN film_metadata m ON m.film_id=l.film_id WHERE l.scheme='letterboxd' GROUP BY l.film_id ORDER BY l.film_id`);
 const films=[],skipped=[],number=value=>/^\d+$/.test(String(value));
 for(const row of rows){
  if(row.tvIds===1&&number(row.tvId))films.push({filmId:row.filmId,tmdbId:null,tvId:String(row.tvId),letterboxdUrl:row.letterboxdUrl??null});
  else if(row.tvIds===0&&row.ids===1&&number(row.tmdbId))films.push({filmId:row.filmId,tmdbId:String(row.tmdbId),letterboxdUrl:row.letterboxdUrl??null});
  else skipped.push({filmId:row.filmId,reason:row.tvIds>1?'ambiguous_tmdb_tv_id':row.ids===0?'no_trusted_tmdb_id':'ambiguous_tmdb_id'});
 }
 return {films,skipped};
}
// The entry a Film's credits are read from first: its trusted TV entry, else its movie id.
export const primarySource=film=>film.tvId?sourceOf('tv',film.tvId):sourceOf('movie',film.tmdbId);

// TMDB retires the movie entry of a miniseries once it lives as a TV series, and Letterboxd's data-tmdb-* attributes can keep
// the retired movie id while the TMDB link it shows already points at the live entry. The link is used only when the page
// shows exactly one TMDB entry and it differs from the retired one. It is a credits source for this run only: Film identity
// and external ids stay as they are.
const LETTERBOXD_FILM=/^https:\/\/letterboxd\.com\/film\/[a-z0-9-]+\/$/;
export function letterboxdTmdbLinks(html){return [...new Set([...String(html).matchAll(/https?:\/\/(?:www\.)?themoviedb\.org\/(movie|tv)\/(\d+)/g)].map(m=>m[1]+'/'+m[2]))].sort();}
export function resolvedSource(film,saved){
 const links=saved?.letterboxd?.links||[];
 if(links.length!==1||links[0]==='movie/'+film.tmdbId)return null;
 const [kind,id]=links[0].split('/');return sourceOf(kind,id);
}

// Requests run at the discovery pace. A transient network or 5xx failure is retried at most twice; 429, a refused token or any
// other status but 404 stops the run.
async function request(url,headers,{fetchImpl,intervalMs,sleep,retries,report}){
 let response=null;
 for(let attempt=0;;attempt++){
  if(intervalMs>0)await sleep(intervalMs);
  report.requests++;
  try{response=await fetchImpl(url,{headers,signal:AbortSignal.timeout(12000)});}
  catch{response=null;}
  if((response===null||TRANSIENT.has(response.status))&&attempt<retries)continue;
  return response;
 }
}
const stopReason=response=>response===null?'network':response.status===429?'rate_limited':'http_'+response.status;
const stopDetails=response=>response?.status===429?{retryAfter:response.headers.get('Retry-After')}:{};

// One TMDB request per Film. A movie 404 is saved, then the Film's Letterboxd page is read once for its TMDB link and the
// entry it names is fetched. Every answer is saved and reused, so a stopped run resumes where it stopped and no Film is
// asked twice.
export async function fetchCredits({films,dir,token,fetchImpl=fetch,intervalMs=DEFAULT_INTERVAL_MS,sleep=sleepFor,retries=2,now=()=>new Date()}){
 if(!token)throw new CreditsStop('configuration',{message:'TMDB_API_READ_ACCESS_TOKEN is required in the environment'});
 const store=path.join(dir,'tmdb');fs.mkdirSync(store,{recursive:true,mode:0o700});
 const report={fetched:0,reused:0,notFound:[],letterboxdResolved:0,requests:0,stopped:null},options={fetchImpl,intervalMs,sleep,retries,report};
 const write=(file,value)=>fs.writeFileSync(path.join(store,file),JSON.stringify(value),{mode:0o600});
 const tmdb=async source=>{
  const response=await request(TMDB_BASE+source.path,{Authorization:'Bearer '+token,Accept:'application/json'},options);
  if(response?.status===404){write(source.file,{tmdbId:source.id,kind:source.kind,path:source.path,fetchedAt:now().toISOString(),status:404});return 'not_found';}
  if(!response?.ok){report.stopDetails=stopDetails(response);return stopReason(response);}
  const body=await response.json();
  if(String(body?.id)!==source.id)return 'unexpected_entry';
  write(source.file,{tmdbId:source.id,kind:source.kind,path:source.path,fetchedAt:now().toISOString(),response:body});report.fetched++;return 'saved';
 };
 for(const film of films){
  const movie=primarySource(film),movieFile=path.join(store,movie.file);
  if(fs.existsSync(movieFile))report.reused++;
  else{const result=await tmdb(movie);if(!['saved','not_found'].includes(result)){report.stopped={reason:result,filmId:film.filmId,...report.stopDetails};break;}}
  let saved=JSON.parse(fs.readFileSync(movieFile,'utf8'));
  if(saved.status!==404)continue;
  // Only a retired movie id is looked up on Letterboxd; a missing TV identity is reported, not guessed around.
  if(movie.kind!=='movie'){report.notFound.push(film);continue;}
  if(!saved.letterboxd){
   if(!LETTERBOXD_FILM.test(String(film.letterboxdUrl||''))){saved={...saved,letterboxd:{url:film.letterboxdUrl,status:'no_url',links:[]}};}
   else{
    const response=await request(film.letterboxdUrl,{Accept:'text/html','User-Agent':'Mozilla/5.0'},options);
    if(response?.status===404)saved={...saved,letterboxd:{url:film.letterboxdUrl,checkedAt:now().toISOString(),status:404,links:[]}};
    else if(!response?.ok){report.stopped={reason:'letterboxd_'+stopReason(response),filmId:film.filmId,...stopDetails(response)};break;}
    else saved={...saved,letterboxd:{url:film.letterboxdUrl,checkedAt:now().toISOString(),status:200,links:letterboxdTmdbLinks(await response.text())}};
   }
   write(movie.file,saved);
  }
  const source=resolvedSource(film,saved);
  if(!source){report.notFound.push(film);continue;}
  report.letterboxdResolved++;
  if(fs.existsSync(path.join(store,source.file)))continue;
  const result=await tmdb(source);
  if(result==='not_found'){report.notFound.push(film);continue;}
  if(result!=='saved'){report.stopped={reason:result,filmId:film.filmId,...report.stopDetails};break;}
 }
 delete report.stopDetails;
 return report;
}

// The credits discovery would store for this movie: directors from the crew, actors from the cast, the first ten of each in
// TMDB order, one credit per person and role. For a TV entry the actors are its main cast and the directors come from the
// episode crew aggregated over the series.
export function tmdbCredits(movie,kind='movie'){
 const pick=(entries,prefix)=>{const seen=new Set(),out=[];for(const entry of (entries||[]).slice(0,PEOPLE_PER_ROLE)){if(entry?.id==null||seen.has(entry.id))continue;seen.add(entry.id);out.push({roleId:prefix+'/'+entry.id,personId:'person:'+prefix+'/'+entry.id,name:typeof entry.name==='string'&&entry.name.trim()?entry.name:null});}return out;};
 const directors=kind==='tv'?(movie?.aggregate_credits?.crew||[]).filter(entry=>(entry.jobs||[]).some(job=>job.job==='Director')):(movie?.credits?.crew||[]).filter(entry=>entry.job==='Director');
 return {director:pick(directors,'tmdb_director'),actor:pick(movie?.credits?.cast,'tmdb_actor')};
}

const chunks=(items,size)=>{const out=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out;};
const marks=items=>items.map(()=>'?').join(',');
const NAMES_SQL=ids=>`SELECT person_id AS id,value AS name FROM person_alias WHERE kind='name' AND person_id IN (${marks(ids)}) UNION SELECT person_id,value FROM person_dimension WHERE dimension='localization' AND status IN ('reviewed','provisional') AND value IS NOT NULL AND person_id IN (${marks(ids)})`;

// The diff of the artifact against D1. Missing persons get a row and their TMDB name; an existing person is reused as it is.
// New credits follow the Film's existing credits of that role. expectedPairs are the Letterboxd/TMDB pairs that the coCredit
// queue will show for these Films: same Film, same role, same name (compared as the queue does, SQLite ASCII lower()).
export async function buildPlan({db,dir}){
 const {films,skipped}=await watchlistFilms(db);
 const missing=[],notFound=[],planned=[];
 const read=file=>fs.existsSync(path.join(dir,'tmdb',file))?JSON.parse(fs.readFileSync(path.join(dir,'tmdb',file),'utf8')):null;
 for(const film of films){
  let source=primarySource(film),saved=read(source.file);
  if(saved?.status===404&&saved.tmdbId===source.id&&source.kind==='movie'){
   // A retired movie id: the Letterboxd TMDB link names the live entry, or the Film has no TMDB credits in this run.
   if(!saved.letterboxd){missing.push(film);continue;}
   source=resolvedSource(film,saved);
   if(!source){notFound.push({...film,reason:'tmdb_404'});continue;}
   saved=read(source.file);
   if(!saved){missing.push(film);continue;}
   if(saved.status===404&&saved.tmdbId===source.id){notFound.push({...film,reason:'resolved_404'});continue;}
  }
  if(!saved){missing.push(film);continue;}
  if(String(saved?.response?.id)!==source.id)throw new CreditsStop('artifact_mismatch',{filmId:film.filmId});
  planned.push({...film,source:source.kind+'/'+source.id,credits:tmdbCredits(saved.response,source.kind)});
 }
 const credits=[];
 for(const part of chunks(planned.map(film=>film.filmId),100))credits.push(...await db.all(`SELECT film_id AS filmId,person_id AS personId,role,ordinal FROM film_person_credit WHERE film_id IN (${marks(part)})`,part));
 const tmdbIds=[...new Set(planned.flatMap(film=>[...film.credits.director,...film.credits.actor].map(item=>item.personId)))];
 const existing=new Set();
 for(const part of chunks(tmdbIds,200))for(const row of await db.all(`SELECT id FROM person WHERE id IN (${marks(part)})`,part))existing.add(row.id);
 const nameIds=[...new Set([...credits.map(row=>row.personId),...tmdbIds.filter(id=>existing.has(id))])],names=new Map();
 for(const part of chunks(nameIds,200))for(const row of await db.all(NAMES_SQL(part),[...part,...part])){if(!names.has(row.id))names.set(row.id,new Set());names.get(row.id).add(row.name);}
 const fold=value=>String(value).replace(/[A-Z]/g,c=>c.toLowerCase());
 const newPersons=new Map(),pairs=new Map(),out=[];
 const totals={films:films.length,skippedFilms:skipped.length,missingArtifacts:missing.length,notFound:notFound.length,plannedFilms:planned.length,resolvedSources:planned.filter(film=>film.source!==primarySource(film).kind+'/'+primarySource(film).id).length,typedTvSources:planned.filter(film=>film.tvId).length,tmdbCredits:0,existingTmdbCredits:0,newCredits:0,newPersons:0,newAliases:0,reusedPersons:0,unnamedPersons:0,filmsWithoutTmdbCredits:0};
 for(const film of planned){
  const filmCredits=credits.filter(row=>row.filmId===film.filmId),writes=[];
  for(const role of ['director','actor']){
   let next=Math.max(-1,...filmCredits.filter(row=>row.role===role).map(row=>row.ordinal))+1;
   for(const item of film.credits[role]){
    totals.tmdbCredits++;
    if(filmCredits.some(row=>row.personId===item.personId&&row.role===role)){totals.existingTmdbCredits++;continue;}
    const fresh=!existing.has(item.personId);
    if(fresh&&!newPersons.has(item.personId))newPersons.set(item.personId,item);
    // A person left without a name by an interrupted run gets it on the next one.
    writes.push({personId:item.personId,roleId:item.roleId,role,ordinal:next++,name:item.name,newPerson:fresh,needsName:!!item.name&&(fresh||!names.has(item.personId))});
    const tmdbNames=fresh?new Set(item.name?[item.name]:[]):names.get(item.personId)||new Set();
    for(const other of filmCredits.filter(row=>row.role===role&&!row.personId.startsWith('person:tmdb_'))){
     const shared=[...names.get(other.personId)||[]].find(name=>[...tmdbNames].some(value=>fold(value)===fold(name)));
     if(shared){const key=other.personId+' '+item.personId+' '+role;const pair=pairs.get(key)||{letterboxd:other.personId,tmdb:item.personId,role,name:shared,films:[]};pair.films.push(film.filmId);pairs.set(key,pair);}
    }
   }
  }
  if(!film.credits.director.length&&!film.credits.actor.length)totals.filmsWithoutTmdbCredits++;
  totals.newCredits+=writes.length;
  if(writes.length)out.push({filmId:film.filmId,tmdbId:film.tmdbId,...(film.source!=='movie/'+film.tmdbId?{source:film.source}:{}),writes});
 }
 totals.newPersons=newPersons.size;
 totals.newAliases=new Set(out.flatMap(film=>film.writes.filter(write=>write.needsName).map(write=>write.personId))).size;
 totals.unnamedPersons=[...newPersons.values()].filter(item=>!item.name).length;
 totals.reusedPersons=tmdbIds.filter(id=>existing.has(id)).length;
 totals.expectedPairs=pairs.size;
 return {totals,missing,notFound,skipped,films:out,expectedPairs:[...pairs.values()]};
}

// One request per Film. Statements run in dependency order and each is a no-op when its row exists, so a write that stops
// halfway is completed by the next run. A credit's ordinal is computed in SQL from what the Film holds at that moment.
export function filmStatements(film,at){
 const statements=[];
 for(const write of film.writes){
  if(write.newPerson)statements.push(['INSERT INTO person (id,role_id,contract_version,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',[write.personId,write.roleId,PERSON_CONTRACT_VERSION,at]]);
  if(write.needsName)statements.push(['INSERT INTO person_alias (person_id,kind,value,provenance_json) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM person_alias WHERE person_id=? AND kind=?) ON CONFLICT(person_id,kind,value) DO NOTHING',[write.personId,'name',write.name,ALIAS_PROVENANCE,write.personId,'name']]);
  statements.push(['INSERT INTO film_person_credit (film_id,person_id,role,ordinal) SELECT ?,?,?,(SELECT COALESCE(MAX(ordinal),-1)+1 FROM film_person_credit WHERE film_id=? AND role=?) WHERE NOT EXISTS (SELECT 1 FROM film_person_credit WHERE film_id=? AND person_id=? AND role=?)',[film.filmId,write.personId,write.role,film.filmId,write.role,film.filmId,write.personId,write.role]]);
 }
 return statements;
}

export async function applyPlan({db,plan,now=()=>new Date()}){
 const at=now().toISOString(),report={films:0,statements:0};
 for(const film of plan.films){
  const statements=filmStatements(film,at);
  await db.transaction(async()=>{for(const [sql,params] of statements)await db.run(sql,params);});
  report.films++;report.statements+=statements.length;
 }
 return report;
}

// The coCredit totals and first pairs exactly as the Worker's /api/d1/persons/review computes them: the route module is loaded
// as the Worker bundle loads it and served through the same adapter.
export async function coCreditReview(db,limit=10){
 const ctx=vm.createContext({JSON,Promise,Number,String,Math});
 vm.runInContext(fs.readFileSync(path.join(REPO_ROOT,'src/catalog-d1.js'),'utf8')+'\nglobalThis.review=d1PersonReview;',ctx);
 const binding={prepare(sql){return {bind(...params){return {all:async()=>({results:await db.all(sql,params)})};}};}};
 const review=await ctx.review(binding,{limit});
 return {totals:{...review.totals},coCredit:review.coCredit.map(row=>({...row}))};
}

export function readTarget(env=process.env,databaseId){
 const accountId=String(env.D1_BACKFILL_ACCOUNT_ID||'').trim(),apiToken=String(env.D1_BACKFILL_API_TOKEN||'').trim();
 if(!/^[0-9a-f]{32}$/.test(accountId))throw new CreditsStop('configuration',{message:'D1_BACKFILL_ACCOUNT_ID must be the 32-character account id'});
 if(!apiToken)throw new CreditsStop('configuration',{message:'D1_BACKFILL_API_TOKEN is required in the environment'});
 if(!/^[0-9a-f-]{36}$/.test(String(databaseId||'')))throw new CreditsStop('configuration',{message:'--database-id must be the database uuid'});
 return {accountId,apiToken,databaseId,endpoint:endpointFor(env.D1_BACKFILL_ENDPOINT)||DEFAULT_ENDPOINT,maxBatchStatements:DEFAULT_MAX_BATCH_STATEMENTS,maxBatchBytes:DEFAULT_MAX_BATCH_BYTES};
}

// The Time Travel bookmark of the database right now: the restore point recorded before any write.
export async function timeTravelBookmark(target,fetchImpl=fetch){
 const response=await fetchImpl(target.endpoint+'/accounts/'+target.accountId+'/d1/database/'+target.databaseId+'/time_travel/bookmark',{headers:{Authorization:'Bearer '+target.apiToken},redirect:'error',signal:AbortSignal.timeout(30000)});
 let payload=null;try{payload=await response.json();}catch{}
 if(!response.ok||!payload?.result?.bookmark)throw new CreditsStop('bookmark_unavailable',{status:response.status});
 return payload.result.bookmark;
}

export async function verifyTarget(db,target){
 const described=await db.describe();
 if(described.uuid!==target.databaseId||described.name!==TARGET_DATABASE_NAME)throw new CreditsStop('wrong_database',{uuid:described.uuid,name:described.name});
}

function privateDir(directory){
 if(!directory||!path.isAbsolute(directory))throw new CreditsStop('configuration',{message:'--dir must be an absolute path outside the Git repository'});
 const absolute=path.resolve(directory);
 if(absolute===REPO_ROOT||absolute.startsWith(REPO_ROOT+path.sep))throw new CreditsStop('configuration',{message:'--dir must be an absolute path outside the Git repository'});
 fs.mkdirSync(absolute,{recursive:true,mode:0o700});
 return absolute;
}
const stamp=date=>date.toISOString().replace(/[:.]/g,'-');
const save=(dir,name,value)=>{const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(value,null,1),{mode:0o600});return file;};

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=flag=>{const index=args.indexOf(flag);return index<0?null:args[index+1];};
 const mode=['--fetch','--plan','--apply','--bookmark'].filter(flag=>args.includes(flag));
 if(mode.length!==1||!value('--dir')||!value('--database-id')){console.error('Usage: node scripts/tmdb-watchlist-credits.mjs --fetch|--plan|--apply|--bookmark --dir /absolute/private/dir --database-id <uuid>');process.exit(2);}
 try{
  const dir=privateDir(value('--dir')),target=readTarget(process.env,value('--database-id'));
  const db=createD1Adapter({target,databaseId:target.databaseId});
  await verifyTarget(db,target);
  const started=new Date();
  if(mode[0]==='--bookmark'){console.log(JSON.stringify({bookmark:await timeTravelBookmark(target),at:started.toISOString()}));}
  if(mode[0]==='--fetch'){
   const {films,skipped}=await watchlistFilms(db);
   const intervalMs=process.env.TMDB_REQUEST_INTERVAL_MS==null||process.env.TMDB_REQUEST_INTERVAL_MS===''?DEFAULT_INTERVAL_MS:Math.max(0,Number(process.env.TMDB_REQUEST_INTERVAL_MS)||0);
   const report=await fetchCredits({films,dir,token:process.env.TMDB_API_READ_ACCESS_TOKEN,intervalMs});
   const summary={mode:'fetch',films:films.length,skipped:skipped.length,...report,notFound:report.notFound.length};
   save(dir,'fetch-'+stamp(started)+'.json',{...summary,notFound:report.notFound,skipped});
   console.log(JSON.stringify(summary));process.exitCode=report.stopped?3:0;
  }
  if(mode[0]==='--plan'){
   const plan=await buildPlan({db,dir}),review=await coCreditReview(db);
   save(dir,'plan-'+stamp(started)+'.json',{...plan,coCreditBefore:review});
   console.log(JSON.stringify({mode:'plan',...plan.totals,coCreditNow:review.totals.coCredit}));
  }
  if(mode[0]==='--apply'){
   const plan=await buildPlan({db,dir});
   if(plan.missing.length)throw new CreditsStop('artifact_incomplete',{missing:plan.missing.length});
   const before=await coCreditReview(db),bookmark=plan.films.length?await timeTravelBookmark(target):null;
   const runFile=save(dir,'apply-'+stamp(started)+'.json',{status:'started',bookmark,totals:plan.totals,coCreditBefore:before.totals});
   const applied=await applyPlan({db,plan});
   const after=await coCreditReview(db,20),again=await buildPlan({db,dir});
   const report={mode:'apply',bookmark,...applied,planned:plan.totals,remainingCredits:again.totals.newCredits,coCreditBefore:before.totals.coCredit,coCreditAfter:after.totals.coCredit};
   save(dir,path.basename(runFile),{status:'completed',...report,coCreditAfter:after});
   console.log(JSON.stringify(report));process.exitCode=again.totals.newCredits===0?0:3;
  }
 }catch(error){
  if(error instanceof CreditsStop){console.error(error.reason+': '+JSON.stringify(error.details));process.exitCode=error.reason==='configuration'?2:3;}
  else if(error instanceof D1Error){console.error('d1 '+error.kind+': '+error.message);process.exitCode=3;}
  else{console.error('Run failed: '+(error?.name||'Error'));process.exitCode=1;}
 }
}
