// AIR-286: TMDB credits for the watchlist Films in D1, the bridge that lets a Letterboxd and a TMDB person be proven the same
// through a shared Film (ADR-0009, AIR-201). Watchlist Films carry only Letterboxd credits and catalog Films only TMDB credits,
// so the coCredit review queue is empty until one Film carries both. This adds TMDB directors and actors, in the id and name
// format discovery stores (tmdb_director/<id>, tmdb_actor/<id>, the ru-RU credit name, the first ten of each), next to the
// existing credits. It merges nothing, matches nothing by name, and leaves Film identity, ratings and predictions alone.
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
// Where a Film's credits are read: its D1 TMDB movie id, or an owner-checked TMDB TV id from <dir>/sources.json
// ({"film:…":"tv/<id>"}). The TV id is a credits source for this run only; Film identity and external ids stay as they are.
export function creditSource(film,sources={}){
 const override=sources[film.filmId];
 if(override==null)return {kind:'movie',id:film.tmdbId,path:tmdbPath(film.tmdbId),file:film.tmdbId+'.json'};
 const match=/^tv\/(\d+)$/.exec(String(override));
 if(!match)throw new CreditsStop('configuration',{message:'sources.json values must be tv/<id>',filmId:film.filmId});
 return {kind:'tv',id:match[1],path:tmdbTvPath(match[1]),file:'tv-'+match[1]+'.json'};
}
export function readSources(dir){
 const file=path.join(dir,'sources.json');
 if(!fs.existsSync(file))return {};
 const sources=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!sources||typeof sources!=='object'||Array.isArray(sources))throw new CreditsStop('configuration',{message:'sources.json must map Film ids to tv/<id>'});
 return sources;
}
export class CreditsStop extends Error{constructor(reason,details={}){super('Stopped: '+reason);this.name='CreditsStop';this.reason=reason;this.details=details;}}

// Watchlist Films are the Films with a Letterboxd id; only one trusted, non-conflicting TMDB id per Film is usable.
export async function watchlistFilms(db){
 const rows=await db.all(`SELECT l.film_id AS filmId,MIN(t.value) AS tmdbId,COUNT(t.value) AS ids FROM film_external_id l LEFT JOIN film_external_id t ON t.film_id=l.film_id AND t.scheme='tmdb' AND t.trusted=1 AND t.conflicting=0 WHERE l.scheme='letterboxd' GROUP BY l.film_id ORDER BY l.film_id`);
 return {films:rows.filter(row=>row.ids===1&&/^\d+$/.test(String(row.tmdbId))).map(row=>({filmId:row.filmId,tmdbId:String(row.tmdbId)})),skipped:rows.filter(row=>row.ids!==1||!/^\d+$/.test(String(row.tmdbId))).map(row=>({filmId:row.filmId,reason:row.ids===0?'no_trusted_tmdb_id':'ambiguous_tmdb_id'}))};
}

// One request per Film at the discovery pace. A transient network or 5xx failure is retried at most twice; 429, a refused
// token or any other status stops the run. A 404 is saved as that Film's answer and the run goes on. Saved answers are reused,
// so a stopped run resumes where it stopped and never asks TMDB twice for one Film.
export async function fetchCredits({films,dir,token,sources={},fetchImpl=fetch,intervalMs=DEFAULT_INTERVAL_MS,sleep=sleepFor,retries=2,now=()=>new Date()}){
 if(!token)throw new CreditsStop('configuration',{message:'TMDB_API_READ_ACCESS_TOKEN is required in the environment'});
 const store=path.join(dir,'tmdb');fs.mkdirSync(store,{recursive:true,mode:0o700});
 const report={fetched:0,reused:0,notFound:[],requests:0,stopped:null};
 for(const film of films){
  const source=creditSource(film,sources),file=path.join(store,source.file);
  if(fs.existsSync(file)){report.reused++;continue;}
  let response=null;
  for(let attempt=0;;attempt++){
   if(intervalMs>0)await sleep(intervalMs);
   report.requests++;
   try{response=await fetchImpl(TMDB_BASE+source.path,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(12000)});}
   catch{response=null;}
   if((response===null||TRANSIENT.has(response.status))&&attempt<retries)continue;
   break;
  }
  if(response===null){report.stopped={reason:'network',filmId:film.filmId};break;}
  if(response.status===404){fs.writeFileSync(file,JSON.stringify({tmdbId:source.id,kind:source.kind,path:source.path,fetchedAt:now().toISOString(),status:404}),{mode:0o600});report.notFound.push(film);continue;}
  if(!response.ok){report.stopped={reason:response.status===429?'rate_limited':'http_'+response.status,filmId:film.filmId,retryAfter:response.headers.get('Retry-After')};break;}
  const body=await response.json();
  if(String(body?.id)!==source.id){report.stopped={reason:'unexpected_movie',filmId:film.filmId};break;}
  fs.writeFileSync(file,JSON.stringify({tmdbId:source.id,kind:source.kind,path:source.path,fetchedAt:now().toISOString(),response:body}),{mode:0o600});
  report.fetched++;
 }
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
 const {films,skipped}=await watchlistFilms(db),sources=readSources(dir);
 const missing=[],notFound=[],planned=[];
 for(const film of films){
  const source=creditSource(film,sources),file=path.join(dir,'tmdb',source.file);
  if(!fs.existsSync(file)){missing.push(film);continue;}
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  if(saved?.status===404&&saved.tmdbId===source.id){notFound.push(film);continue;}
  if(String(saved?.response?.id)!==source.id)throw new CreditsStop('artifact_mismatch',{filmId:film.filmId});
  planned.push({...film,source:source.kind==='tv'?'tv/'+source.id:undefined,credits:tmdbCredits(saved.response,source.kind)});
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
 const totals={films:films.length,skippedFilms:skipped.length,missingArtifacts:missing.length,notFound:notFound.length,plannedFilms:planned.length,tvSources:planned.filter(film=>film.source).length,tmdbCredits:0,existingTmdbCredits:0,newCredits:0,newPersons:0,newAliases:0,reusedPersons:0,unnamedPersons:0,filmsWithoutTmdbCredits:0};
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
  if(writes.length)out.push({filmId:film.filmId,tmdbId:film.tmdbId,...(film.source?{source:film.source}:{}),writes});
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
   const report=await fetchCredits({films,dir,token:process.env.TMDB_API_READ_ACCESS_TOKEN,sources:readSources(dir),intervalMs});
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
