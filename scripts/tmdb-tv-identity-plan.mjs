// AIR-290: offline dry-run plan for the four owner-confirmed retired TMDB movie ids of watchlist miniseries. It builds each
// retirement from the private AIR-286 artifact (the saved movie 404, the Letterboxd TMDB link and the saved TV entry),
// applies it to the Film as D1 holds it or as a snapshot projects it, and writes a per-record plan: old and new typed ids,
// trust, collisions, the R2 records that carry the movie id, the R2 retirement entry, the D1 state the correction must
// reach and what must stay untouched. It writes nothing anywhere: D1 follows R2 through the enrichment projector
// (ADR 0056), so the expected D1 state is a readback contract, not a statement list. No TMDB or Letterboxd request. The D1
// read is a local SQLite file, or the D1 HTTP API only when --database-id is given (a production read needs owner approval).
// Only the four Films below are ever planned; nothing is inferred for any other Film.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const REPO_ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
// Confirmed by the owner on 2026-10-30 in the AIR-286 session, who supplied the four TMDB TV links; the Letterboxd pages of
// the same lids show the same links (AIR-286 artifact).
export const CONFIRMED_RETIREMENTS=Object.freeze([
 {filmId:'film:1IUo',lid:'1IUo',movieId:'17266',tvId:'9687',letterboxdUrl:'https://letterboxd.com/film/the-odyssey/'},
 {filmId:'film:3tCe',lid:'3tCe',movieId:'101915',tvId:'8042',letterboxdUrl:'https://letterboxd.com/film/tess-of-the-durbervilles/'},
 {filmId:'film:daU4',lid:'daU4',movieId:'378779',tvId:'64099',letterboxdUrl:'https://letterboxd.com/film/war-and-peace-2016/'},
 {filmId:'film:g97G',lid:'g97G',movieId:'452736',tvId:'1457',letterboxdUrl:'https://letterboxd.com/film/pride-and-prejudice-1995/'}
].map(Object.freeze));
export const OWNER_CONFIRMATION=Object.freeze({by:'owner',at:'2026-10-30',source:'https://trello.com/c/EswNQuv8'});
export const RETIREMENTS_KEY='identity/tmdb-retirements.json';

export class PlanStop extends Error{constructor(reason,details={}){super('Stopped: '+reason);this.name='PlanStop';this.reason=reason;this.details=details;}}

export function loadDomain(){
 const source=['src/domain/film-person.js','src/domain/film-person-reader.js','src/domain/tmdb-tv-identity.js'].map(file=>fs.readFileSync(path.join(REPO_ROOT,file),'utf8')).join('\n');
 const ctx=vm.createContext({Date,Map,Set,JSON,Object,URL,encodeURIComponent});
 vm.runInContext(source+'\nglobalThis.api={readLifecycle,linkFilms,letterboxdTmdbLink,tmdbRetirement,applyTmdbRetirement,tmdbTvCollisions,TMDB_TV_SCHEME,TMDB_RETIRED_STATUS};',ctx);
 return ctx.api;
}
const plain=value=>JSON.parse(JSON.stringify(value));

// The evidence of one retirement, read from the AIR-286 artifact: the movie answered 404, the Film's Letterboxd page showed
// exactly this one TV link, and the TV entry was fetched under the same id. A missing or different piece leaves it unproved.
export function evidenceFromArtifact(dir,confirmed){
 const read=file=>{const full=path.join(dir,'tmdb',file);return fs.existsSync(full)?JSON.parse(fs.readFileSync(full,'utf8')):null;};
 const movie=read(confirmed.movieId+'.json'),tv=read('tv-'+confirmed.tvId+'.json');
 const links=movie?.letterboxd?.links||[];
 return {
  movieStatus:movie?.status===404&&movie.tmdbId===confirmed.movieId?404:null,
  movieCheckedAt:movie?.fetchedAt??null,
  letterboxdUrl:movie?.letterboxd?.url===confirmed.letterboxdUrl?confirmed.letterboxdUrl:null,
  link:links.length===1?links[0]:null,
  linkCheckedAt:movie?.letterboxd?.checkedAt??null,
  tvResponseId:tv?.kind==='tv'&&tv.tmdbId===confirmed.tvId?String(tv.response?.id??''):null,
  tvCheckedAt:tv?.fetchedAt??null,
  tvName:tv?.response?.original_name??null
 };
}

const marks=items=>items.map(()=>'?').join(',');
const parse=text=>{if(text==null)return null;try{return JSON.parse(text);}catch{return text;}};
// The Film as D1 holds it, in the lifecycle view's shape, plus every row the correction must leave untouched.
export async function d1State(db,filmIds){
 const films=new Map();
 for(const row of await db.all(`SELECT id,canonical_identity AS canonicalIdentity FROM film WHERE id IN (${marks(filmIds)})`,filmIds))films.set(row.id,{id:row.id,canonicalIdentity:row.canonicalIdentity,externalIds:[],identity:null});
 for(const row of await db.all(`SELECT film_id AS filmId,scheme,value,trusted,conflicting,provenance_json AS provenance FROM film_external_id WHERE film_id IN (${marks(filmIds)}) ORDER BY film_id,scheme,value`,filmIds))films.get(row.filmId)?.externalIds.push({scheme:row.scheme,value:String(row.value),trusted:row.trusted===1,conflicting:row.conflicting===1,provenance:parse(row.provenance)});
 for(const row of await db.all(`SELECT film_id AS filmId,status,source,source_version AS sourceVersion,provenance_json AS provenance,updated_at AS updatedAt,next_action AS nextAction FROM film_dimension WHERE dimension='identity' AND film_id IN (${marks(filmIds)})`,filmIds)){const film=films.get(row.filmId);if(film)film.identity={dimension:'identity',status:row.status,updatedAt:row.updatedAt,source:row.source,sourceVersion:row.sourceVersion,provenance:parse(row.provenance),lastError:null,failureReason:null,retryAt:null,attempts:0,nextAction:row.nextAction};}
 const preserved={};
 for(const id of filmIds)preserved[id]={credits:{letterboxd:0,tmdb:0},prediction:0,rating:0,watchlist:0,redirectsTo:0,localization:null};
 for(const row of await db.all(`SELECT film_id AS filmId,SUM(person_id NOT LIKE 'person:tmdb!_%' ESCAPE '!') AS letterboxd,SUM(person_id LIKE 'person:tmdb!_%' ESCAPE '!') AS tmdb FROM film_person_credit WHERE film_id IN (${marks(filmIds)}) GROUP BY film_id`,filmIds))preserved[row.filmId].credits={letterboxd:row.letterboxd,tmdb:row.tmdb};
 for(const [table,field] of [['prediction_current','prediction'],['actual_rating','rating'],['watchlist_film','watchlist']])for(const row of await db.all(`SELECT film_id AS filmId,COUNT(*) AS n FROM ${table} WHERE film_id IN (${marks(filmIds)}) GROUP BY film_id`,filmIds))preserved[row.filmId][field]=row.n;
 for(const row of await db.all(`SELECT to_film_id AS filmId,COUNT(*) AS n FROM film_redirect WHERE to_film_id IN (${marks(filmIds)}) GROUP BY to_film_id`,filmIds))preserved[row.filmId].redirectsTo=row.n;
 for(const row of await db.all(`SELECT film_id AS filmId,value FROM film_dimension WHERE dimension='localization' AND film_id IN (${marks(filmIds)})`,filmIds))preserved[row.filmId].localization=row.value;
 return {films,preserved};
}
// Every Film in D1 that holds one of the numbers, under either scheme: the evidence for collisions and numeric overlaps.
export async function d1Holders(db,values){
 const rows=await db.all(`SELECT film_id AS filmId,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme IN ('tmdb','tmdb_tv') AND value IN (${marks(values)})`,values);
 const films=new Map();
 for(const row of rows){const film=films.get(row.filmId)||{id:row.filmId,externalIds:[]};film.externalIds.push({scheme:row.scheme,value:String(row.value),trusted:row.trusted===1,conflicting:row.conflicting===1});films.set(row.filmId,film);}
 return [...films.values()];
}

// The R2 records that carry a planned movie or TV number. They are reported, not rewritten: the records keep the movie id
// Letterboxd still shows, and the retirement entry under RETIREMENTS_KEY is what takes it out of the trusted identity.
export function r2References(store,retirement){
 const refs=[],has=(record,value)=>record&&String(record.tmdbId??'')===value;
 for(const [value,kind] of [[retirement.movieId,'movie'],[retirement.tvId,'tv_number']]){
  for(const [key,list] of [['watchlist.json',store.watchlist?.films],['programme.json',store.programme?.films]])for(const record of list||[])if(has(record,value))refs.push({key,field:'films[].tmdbId',id:String(record.id),value,kind});
  for(const [key,body] of [['metadata.json',store.metadata],['titles.json',store.titles]])for(const [id,record] of Object.entries(body||{}))if(has(record,value))refs.push({key,field:'['+id+'].tmdbId',id,value,kind});
  const catalog=store.discoveredFilms||{};
  for(const record of Array.isArray(catalog)?catalog:Object.values(catalog))if(has(record,value))refs.push({key:'epg/discovered-films.json',field:'tmdbId',id:String(record.id),value,kind});
  for(const [id,decision] of Object.entries(store.discoveryResolution||{}))if(decision&&typeof decision==='object'&&has(decision,value))refs.push({key:'epg/discovery-resolution.json',field:'['+id+'].tmdbId',id,value,kind});
 }
 return refs;
}

// The D1 identity of one corrected Film, as the projector must leave it: canonical identity, the `tmdb` and `tmdb_tv` rows
// with trust and provenance, and the identity dimension. Timestamps are not part of it.
export function d1Expected(film){
 const pick=item=>({scheme:item.scheme,value:item.value,trusted:item.trusted,conflicting:item.conflicting,provenance:item.provenance??null});
 return {canonicalIdentity:film.canonicalIdentity,externalIds:film.externalIds.filter(item=>item.scheme==='tmdb'||item.scheme==='tmdb_tv').map(pick),identity:{status:film.identity.status,sourceVersion:film.identity.sourceVersion,provenance:film.identity.provenance??null}};
}
const stableJson=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
// Reads D1 back against a plan: `corrected` when a Film holds exactly its expected identity, `pending` when it still holds
// the identity the plan started from, `mismatch` for anything else. It only reads.
export async function d1Readback(db,plan){
 const films=plan.films.filter(item=>item.status==='ready'),{films:current}=await d1State(db,films.map(item=>item.filmId));
 return films.map(item=>{
  const film=current.get(item.filmId),now=film?.identity?d1Expected(film):null;
  const state=!now?'mismatch':stableJson(now)===stableJson(item.d1Expected)?'corrected':stableJson(now)===stableJson(item.d1Before)?'pending':'mismatch';
  return {filmId:item.filmId,state};
 });
}

// The plan for the four Films. `films` maps a Film id to its current view (D1 or snapshot), `holders` lists every Film
// holding one of the planned numbers, `store` is the snapshot (optional). Unexpected state is owner review, never a fix.
export function buildPlan({domain,artifactDir,films,holders=[],preserved={},store=null,at}){
 const out=[],entries=[];
 for(const confirmed of CONFIRMED_RETIREMENTS){
  const evidence=evidenceFromArtifact(artifactDir,confirmed);
  const checked=domain.tmdbRetirement({filmId:confirmed.filmId,lid:confirmed.lid,movieId:confirmed.movieId,tvId:confirmed.tvId,evidence:{...evidence,letterboxdUrl:evidence.letterboxdUrl},confirmation:OWNER_CONFIRMATION});
  const film=films.get(confirmed.filmId)||null;
  const record={filmId:confirmed.filmId,lid:confirmed.lid,old:{scheme:'tmdb',value:confirmed.movieId},new:{scheme:'tmdb_tv',value:confirmed.tvId},tvName:evidence.tvName,status:'ready',reasons:[]};
  if(!checked.ok){record.status='refused';record.reasons.push(...checked.reasons.map(reason=>'evidence_'+reason));out.push(record);continue;}
  if(!film){record.status='refused';record.reasons.push('film_missing');out.push(record);continue;}
  const applied=domain.applyTmdbRetirement(plain(film),checked.retirement,at);
  if(!applied.ok){record.status='owner_review';record.reasons.push(applied.reason);record.before=plain(film);out.push(record);continue;}
  const others=holders.filter(holder=>holder.id!==confirmed.filmId);
  const {collisions,numericOverlaps}=domain.tmdbTvCollisions([applied.film,...others]);
  if(collisions.length){record.status='owner_review';record.reasons.push('tmdb_tv_collision');}
  // Another Film still trusting the retired movie id would be the same TMDB entry twice: review, not a silent retirement.
  if(others.some(holder=>holder.externalIds.some(item=>item.scheme==='tmdb'&&item.value===confirmed.movieId&&item.trusted&&!item.conflicting))){record.status='owner_review';record.reasons.push('retired_movie_on_other_film');}
  Object.assign(record,{
   changed:applied.changed,
   before:{canonicalIdentity:film.canonicalIdentity,externalIds:plain(film.externalIds.filter(item=>item.scheme==='tmdb'||item.scheme==='tmdb_tv'))},
   after:{canonicalIdentity:applied.film.canonicalIdentity,externalIds:plain(applied.film.externalIds.filter(item=>item.scheme==='tmdb'||item.scheme==='tmdb_tv'))},
   collisions,numericOverlaps,
   preserved:preserved[confirmed.filmId]??null,
   d1Before:film.identity?d1Expected(film):null,
   d1Expected:d1Expected(applied.film),
   r2:store?r2References(store,checked.retirement):null
  });
  entries.push({...checked.retirement});
  out.push(record);
 }
 const ready=out.filter(item=>item.status==='ready');
 return {
  writes:0,requests:0,at,
  totals:{films:out.length,ready:ready.length,unchanged:ready.filter(item=>item.changed===false).length,ownerReview:out.filter(item=>item.status==='owner_review').length,refused:out.filter(item=>item.status==='refused').length},
  films:out,
  // The one R2 object a later approved run writes; the lifecycle projection applies it (runtime delivery, separate card).
  r2Retirements:{key:RETIREMENTS_KEY,body:{schemaVersion:1,retirements:entries.filter(entry=>ready.some(item=>item.filmId===entry.filmId))}}
 };
}

export function sqliteReader(file){
 return {async all(sql,params=[]){let i=0;const text=sql.replace(/\?/g,()=>{const v=params[i++];return v==null?'NULL':typeof v==='number'?String(v):"'"+String(v).replace(/'/g,"''")+"'";});const r=spawnSync('sqlite3',['-readonly','-json',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new PlanStop('sqlite',{message:r.stderr.trim()});const out=r.stdout.trim();return out?JSON.parse(out):[];}};
}

function privateDir(directory){
 if(!directory||!path.isAbsolute(directory))throw new PlanStop('configuration',{message:'paths must be absolute and outside the Git repository'});
 const absolute=path.resolve(directory);
 if(absolute===REPO_ROOT||absolute.startsWith(REPO_ROOT+path.sep))throw new PlanStop('configuration',{message:'paths must be absolute and outside the Git repository'});
 return absolute;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=flag=>{const index=args.indexOf(flag);return index<0?null:args[index+1];};
 if(!value('--artifact')||!value('--output')||(!value('--d1-sqlite')&&!value('--database-id')&&!value('--snapshot'))){console.error('Usage: node scripts/tmdb-tv-identity-plan.mjs --artifact /private/air286 --output /private/out (--d1-sqlite /private/d1.sqlite | --database-id <uuid> | --snapshot /private/snapshot)');process.exit(2);}
 try{
  const domain=loadDomain(),artifactDir=privateDir(value('--artifact')),output=privateDir(value('--output')),at=new Date().toISOString();
  const ids=CONFIRMED_RETIREMENTS.map(item=>item.filmId),numbers=[...new Set(CONFIRMED_RETIREMENTS.flatMap(item=>[item.movieId,item.tvId]))];
  let films=new Map(),holders=[],preserved={},store=null;
  if(value('--snapshot')){
   const {loadLifecycleSnapshot}=await import('./snapshot-store.mjs');
   const snapshot=await loadLifecycleSnapshot(privateDir(value('--snapshot')));
   store=snapshot.store;
   const view=domain.readLifecycle(store,snapshot.now);
   for(const film of view.films)if(ids.includes(film.id))films.set(film.id,film);
   holders=view.films.filter(film=>film.externalIds?.some(item=>(item.scheme==='tmdb'||item.scheme==='tmdb_tv')&&numbers.includes(item.value)));
  }
  let db=null;
  if(value('--d1-sqlite'))db=sqliteReader(privateDir(value('--d1-sqlite')));
  else if(value('--database-id')){const {createD1Adapter,endpointFor}=await import('./d1-backfill.mjs');const target={accountId:String(process.env.D1_BACKFILL_ACCOUNT_ID||''),apiToken:String(process.env.D1_BACKFILL_API_TOKEN||''),endpoint:endpointFor(process.env.D1_BACKFILL_ENDPOINT)};db=createD1Adapter({target,databaseId:value('--database-id')});}
  if(db){const state=await d1State(db,ids);films=state.films;preserved=state.preserved;holders=await d1Holders(db,numbers);}
  const plan=buildPlan({domain,artifactDir,films,holders,preserved,store,at});
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const file=path.join(output,'tmdb-tv-identity-plan-'+at.replace(/[:.]/g,'-')+'.json');
  fs.writeFileSync(file,JSON.stringify(plan,null,1),{mode:0o600});
  console.log(JSON.stringify({source:store?'snapshot':'d1',...plan.totals,films:plan.films.map(item=>({filmId:item.filmId,status:item.status,reasons:item.reasons,old:item.old.value,new:item.new.value,overlaps:item.numericOverlaps?.length??0}))}));
  process.exitCode=plan.totals.ready===plan.totals.films?0:3;
 }catch(error){
  if(error instanceof PlanStop){console.error(error.reason+': '+JSON.stringify(error.details));process.exitCode=error.reason==='configuration'?2:3;}
  else{console.error('Plan failed: '+(error?.name||'Error'));process.exitCode=1;}
 }
}
