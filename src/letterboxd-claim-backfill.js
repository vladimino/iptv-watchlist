// AIR-559 (ADR 0184, Accepted). The owner-only operator of the bounded backfill of trusted `letterboxd` claims for published lids that lack one. It is the body of the MCP tool `letterboxd_claim_backfill`, reached only through the
// existing owner-only MCP gate (Cloudflare Access plus the signed JWT); it adds no route, binding, Cron or Task and takes no lid, movie id, Film id, SQL, URL, key or list from the caller.
// THE COHORT IS DERIVED BY THE SERVER: the lids of the current published programme/watchlist run that are not tmdb-spelled and hold no trusted, non-conflicting `letterboxd` claim, each paired with the movie id that the AUTHORITATIVE Ratings
// link index gives it (never a title, a year, a slug or `ratings_view`). Every pair is judged by the real read-only `planLetterboxdClaim`. dry_run writes nothing. apply writes only through `applyLetterboxdClaim` (the existing fenced
// `film_external_ids` unit in `addOnly` mode with its receipt, revision CAS and write-time guards) and only when the freshly derived cohort equals the caller's pins. Responses carry counts, reasons, generations and a digest, never a lid-to-movie mapping.
// A merge of this module or the tool listing is NOT a production GO: `confirmGo` is a technical safeguard, the owner's separate explicit GO on a frozen cohort is the authority.
import {database,failed,many,one,readAuthority} from './film-person-authority.js';
import {LETTERBOXD_CLAIM_UNIT_CAP,applyLetterboxdClaim,planLetterboxdClaim} from './canonical-letterboxd-claim.js';
import {readOwned} from './ratings-d1.js';
import {catalogStartedFilm} from './canonical-catalog-reader.js';

export const BACKFILL_MAX=LETTERBOXD_CLAIM_UNIT_CAP;
export const BACKFILL_REQUEST_ID=/^[A-Za-z0-9_-]{8,64}$/;
const LINKS_KEY='letterboxd/facts/links.json';
const HEX64=/^[0-9a-f]{64}$/;
const RUN_ID=/^[A-Za-z0-9_.:-]{1,100}$/;
const CANDIDATE_SQL="SELECT DISTINCT m.film_id AS lid FROM published_epg_member m WHERE m.programme_run_id=? AND m.film_id NOT LIKE 'tmdb\\_%' ESCAPE '\\' AND NOT EXISTS (SELECT 1 FROM film_external_id e WHERE e.scheme='letterboxd' AND e.value=m.film_id AND e.trusted=1 AND e.conflicting=0) ORDER BY m.film_id LIMIT ?";
const COUNT_TABLES=['film_external_id','film_alias','ratings_view','started_mark'];
const bump=(map,key,by=1)=>{map[key]=(map[key]||0)+by;};
const blockerList=map=>Object.keys(map).sort().map(reason=>({reason,count:map[reason]}));

async function sha256Hex(text){
 const bytes=new TextEncoder().encode(text);
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
// The digest of the cohort: sha256 of the sorted `lid:tmdb` lines (code-unit order), joined by a newline, no trailing newline.
export async function cohortDigest(pairs){
 return sha256Hex(pairs.map(pair=>pair.lid+':'+pair.tmdb).sort((a,b)=>a<b?-1:a>b?1:0).join('\n'));
}

async function ratingsMarker(db){
 try{
  const row=await one(db,'SELECT mode,cutover,generation FROM ratings_domain_authority WHERE id=1');
  return row?{mode:row.mode,cutover:row.cutover,generation:Number(row.generation)}:null;
 }catch(error){
  if(/no such table/i.test(String(error?.message||error)))return null;
  throw failed('film_person_unavailable',error);
 }
}
async function publicationMarker(db){
 try{
  const row=await one(db,'SELECT mode,cutover,programme_run_id AS run,generation,watchlist_generation AS watchlist FROM published_epg_authority WHERE id=1');
  return row?{mode:row.mode,cutover:row.cutover,programmeRunId:row.run??null,generation:Number(row.generation),watchlistGeneration:Number(row.watchlist)}:null;
 }catch(error){
  if(/no such table/i.test(String(error?.message||error)))return null;
  throw failed('film_person_unavailable',error);
 }
}

// The candidates that share a Film or a movie id with another candidate (pure).
export function findDuplicateTargets(pairs){
 const byFilm=new Map(),byMovie=new Map();
 for(const pair of pairs){byFilm.set(pair.filmId,(byFilm.get(pair.filmId)||0)+1);byMovie.set(pair.tmdb,(byMovie.get(pair.tmdb)||0)+1);}
 return pairs.filter(pair=>byFilm.get(pair.filmId)>1||byMovie.get(pair.tmdb)>1);
}
// The three authorities of the frozen snapshot, read as one record: the Film/Person marker, the Ratings marker and the publication (run id AND both generations: a new publication or a watchlist save moves a generation without changing the run id).
async function readMarkers(env,db){
 const gate=await readAuthority(env);
 const ratings=await ratingsMarker(db),publication=await publicationMarker(db);
 return {filmPerson:{state:gate.state,generation:Number(gate.generation)},ratings,publication};
}
const sameMarkers=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const guardsOf=markers=>[
 {sql:"EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)",params:[markers.filmPerson.generation]},
 {sql:"EXISTS (SELECT 1 FROM ratings_domain_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)",params:[markers.ratings.generation]},
 {sql:"EXISTS (SELECT 1 FROM published_epg_authority WHERE id=1 AND mode='d1' AND cutover='open' AND programme_run_id=? AND generation=? AND watchlist_generation=?)",params:[markers.publication.programmeRunId,markers.publication.generation,markers.publication.watchlistGeneration]},
];

// Read-only. {decision:'eligible'|'already_current'|'unsafe'|'unknown', blockers:[{reason,count}], authorities, publication, counts, expect, pairs, markers}. `pairs` and `markers` are for the caller's own use inside the trusted process and never go into a response.
export async function deriveBackfillCohort(env){
 const db=database(env);
 const out={decision:'unsafe',blockers:[],authorities:{filmPerson:null,ratings:null},publication:null,counts:{cohort:0,pass:0,conflict:0,not_proved:0,already:0,unresolved:0,duplicate:0},expect:null,pairs:[],markers:null};
 const reasons={};
 const stop=(decision,reason)=>{out.decision=decision;bump(reasons,reason);out.blockers=blockerList(reasons);return out;};
 if(!db)return stop('unknown','film_person_unavailable');
 let markers;
 try{markers=await readMarkers(env,db);}
 catch(error){return stop(['film_person_held','film_person_not_open'].includes(error?.code)?'unsafe':'unknown',error?.code||'film_person_unavailable');}
 const {ratings,publication}=markers;
 out.authorities.filmPerson=markers.filmPerson;out.authorities.ratings=ratings;
 out.publication=publication?{mode:publication.mode,cutover:publication.cutover,programmeRunId:publication.programmeRunId,generation:publication.generation,watchlistGeneration:publication.watchlistGeneration}:null;
 if(markers.filmPerson.state!=='open')return stop('unsafe','film_person_not_open');
 if(!ratings||ratings.mode!=='d1'||ratings.cutover!=='open')return stop('unsafe','ratings_not_authoritative');
 if(!publication||publication.mode!=='d1'||publication.cutover!=='open'||typeof publication.programmeRunId!=='string'||!RUN_ID.test(publication.programmeRunId))return stop('unsafe','publication_not_authoritative');
 out.markers=markers;
 const pins=pairs=>({filmPersonGeneration:markers.filmPerson.generation,ratingsGeneration:ratings.generation,programmeRunId:publication.programmeRunId,publicationGeneration:publication.generation,watchlistGeneration:publication.watchlistGeneration,count:pairs.length});
 let candidates;
 try{candidates=(await many(db,CANDIDATE_SQL,[publication.programmeRunId,BACKFILL_MAX+1])).map(row=>String(row.lid));}
 catch(error){return stop('unknown',error?.code||'film_person_unavailable');}
 out.counts.cohort=candidates.length;
 if(!candidates.length){
  out.decision='already_current';
  out.expect={...pins([]),digest:await cohortDigest([])};
  return await settle(out,env,db,markers,reasons);
 }
 if(candidates.length>BACKFILL_MAX)return stop('unsafe','cohort_over_limit');
 // The movie id of each lid comes from the AUTHORITATIVE Ratings link index (the key the lid maps to and the one `tmdb:<n>` alias that maps to the same key); the planner then proves the whole link and the canonical side.
 let index;
 try{const links=await readOwned(env,LINKS_KEY);index=links.owned?links.value:null;}
 catch(error){return stop('unknown',error?.code||'ratings_domain_unavailable');}
 if(!index||typeof index!=='object'||Array.isArray(index))return stop('unsafe','ratings_links_unreadable');
 const resolved=[];let unsafe=false,unknown=false;
 for(const lid of candidates){
  const key=index['letterboxd:'+lid];
  const movies=typeof key==='string'?Object.keys(index).filter(alias=>alias.startsWith('tmdb:')&&index[alias]===key).map(alias=>alias.slice(5)):[];
  if(movies.length!==1){out.counts.unresolved++;bump(reasons,typeof key==='string'?'ratings_movie_link_missing_or_ambiguous':'ratings_link_absent');unsafe=true;continue;}
  let plan;
  try{plan=await planLetterboxdClaim(env,{lid,tmdb:movies[0]});}
  catch(error){bump(reasons,error?.code||'unclassified');unknown=true;continue;}
  if(plan.verdict==='pass'&&!plan.already){out.counts.pass++;resolved.push({lid,tmdb:movies[0],filmId:plan.filmId});}
  else if(plan.verdict==='pass'){out.counts.already++;bump(reasons,'already_current');}
  else{out.counts[plan.verdict]++;bump(reasons,plan.reason);unsafe=true;}
 }
 // One Film holds ONE trusted Letterboxd lid: two candidates that target the same Film (or the same movie id) cannot both be written, so the whole cohort is refused before any GO instead of leaving a partial one.
 const duplicated=findDuplicateTargets(resolved);
 if(duplicated.length){out.counts.duplicate=duplicated.length;bump(reasons,'cohort_duplicate_target',duplicated.length);unsafe=true;}
 out.pairs=resolved.map(({lid,tmdb})=>({lid,tmdb}));
 out.expect={...pins(resolved),digest:await cohortDigest(resolved)};
 out.decision=unknown?'unknown':unsafe||out.counts.already?'unsafe':'eligible';
 return await settle(out,env,db,markers,reasons);
}
// The snapshot must still be the one read at the start: a moved marker or publication during the scan makes every pin stale, so the answer is `unknown` and carries no usable `expect`.
async function settle(out,env,db,markers,reasons){
 let again;
 try{again=await readMarkers(env,db);}
 catch(error){out.decision='unknown';bump(reasons,error?.code||'film_person_unavailable');out.blockers=blockerList(reasons);out.expect=null;out.pairs=[];return out;}
 out.blockers=blockerList(reasons);
 if(!sameMarkers(markers,again)){out.decision='unknown';bump(reasons,'state_moved_during_read');out.blockers=blockerList(reasons);out.expect=null;out.pairs=[];}
 return out;
}

const publicView=cohort=>({decision:cohort.decision,authorities:cohort.authorities,publication:cohort.publication,counts:cohort.counts,blockers:cohort.blockers,expect:cohort.expect});

async function sideCounts(db){
 const out={};
 for(const table of COUNT_TABLES){
  try{out[table]=Number((await one(db,'SELECT COUNT(*) AS n FROM '+table))?.n);}
  catch(error){if(/no such table/i.test(String(error?.message||error)))out[table]=null;else throw failed('film_person_unavailable',error);}
 }
 return out;
}

// args: {mode?:'dry_run'|'apply' (omitted means dry_run: only an explicit 'apply' can write), confirmGo?, requestId?, expectedFilmPersonGeneration?, expectedRatingsGeneration?, expectedProgrammeRunId?, expectedPublicationGeneration?,
// expectedWatchlistGeneration?, expectedCount?, expectedDigest?}. Returns {status, body}.
const PIN_NAMES=['filmPersonGeneration','ratingsGeneration','programmeRunId','publicationGeneration','watchlistGeneration','count','digest'];
export async function handleLetterboxdClaimBackfillTool(env,args={},{now}={}){
 if(!args||typeof args!=='object'||Array.isArray(args))return {status:400,body:{ok:false,reason:'invalid'}};
 const mode=args.mode===undefined?'dry_run':args.mode;
 if(mode!=='dry_run'&&mode!=='apply')return {status:400,body:{ok:false,reason:'invalid_mode'}};
 if(args.confirmGo!==undefined&&typeof args.confirmGo!=='boolean')return {status:400,body:{ok:false,reason:'invalid_confirm'}};
 if(mode==='dry_run'){
  const cohort=await deriveBackfillCohort(env);
  return {status:200,body:{ok:true,mode:'dry_run',sideEffects:'none',...publicView(cohort)}};
 }
 if(args.confirmGo!==true)return {status:400,body:{ok:false,reason:'confirm_required'}};
 if(typeof args.requestId!=='string'||!BACKFILL_REQUEST_ID.test(args.requestId))return {status:400,body:{ok:false,reason:'invalid_request_id'}};
 const generation=value=>Number.isInteger(value)&&value>=0;
 if(!generation(args.expectedFilmPersonGeneration))return {status:400,body:{ok:false,reason:'invalid_expected_film_person_generation'}};
 if(!generation(args.expectedRatingsGeneration))return {status:400,body:{ok:false,reason:'invalid_expected_ratings_generation'}};
 if(typeof args.expectedProgrammeRunId!=='string'||!RUN_ID.test(args.expectedProgrammeRunId))return {status:400,body:{ok:false,reason:'invalid_expected_programme_run_id'}};
 if(!generation(args.expectedPublicationGeneration))return {status:400,body:{ok:false,reason:'invalid_expected_publication_generation'}};
 if(!generation(args.expectedWatchlistGeneration))return {status:400,body:{ok:false,reason:'invalid_expected_watchlist_generation'}};
 if(!Number.isInteger(args.expectedCount)||args.expectedCount<1||args.expectedCount>BACKFILL_MAX)return {status:400,body:{ok:false,reason:'invalid_expected_count'}};
 if(typeof args.expectedDigest!=='string'||!HEX64.test(args.expectedDigest))return {status:400,body:{ok:false,reason:'invalid_expected_digest'}};
 const wanted={filmPersonGeneration:args.expectedFilmPersonGeneration,ratingsGeneration:args.expectedRatingsGeneration,programmeRunId:args.expectedProgrammeRunId,publicationGeneration:args.expectedPublicationGeneration,watchlistGeneration:args.expectedWatchlistGeneration,count:args.expectedCount,digest:args.expectedDigest};
 // The cohort and every proof are derived AGAIN, right now; nothing is written unless it equals the pins.
 const cohort=await deriveBackfillCohort(env);
 if(cohort.decision!=='eligible')return {status:409,body:{ok:false,reason:'not_eligible',writes:0,...publicView(cohort)}};
 const mismatched=PIN_NAMES.filter(name=>cohort.expect[name]!==wanted[name]);
 if(mismatched.length)return {status:409,body:{ok:false,reason:'pins_mismatch',writes:0,mismatched,...publicView(cohort)}};
 const db=database(env);
 // The pins are checked ONCE MORE immediately before the first write (the scan above made several reads): zero writes if any authority or the publication moved since. After the first write the same snapshot is asserted before every pair and,
 // through the extra guards, INSIDE every fenced batch, so a pair never lands under a state the owner did not approve.
 const frozen=cohort.markers;
 const holds=async()=>{try{return sameMarkers(frozen,await readMarkers(env,db));}catch{return false;}};
 if(!(await holds()))return {status:409,body:{ok:false,reason:'state_moved',writes:0,...publicView(cohort)}};
 let before;
 try{before=await sideCounts(db);}catch(error){return {status:503,body:{ok:false,reason:error?.code||'film_person_unavailable',writes:0}};}
 // One stable event for this frozen cohort and request: the same request replays idempotently (receipts) and never writes twice.
 const event='backfill:'+args.requestId+':'+cohort.expect.digest.slice(0,16);
 const extraGuards=guardsOf(frozen);
 const counts={written:0,already:0,refused:0,unknown:0,deferred:0,failed:0,notAttempted:0};
 const items=[];let stopped=null;
 for(const pair of cohort.pairs){
  if(stopped){counts.notAttempted++;items.push({state:'not_attempted',reason:stopped});continue;}
  if(!(await holds())){stopped='state_moved';counts.notAttempted++;items.push({state:'not_attempted',reason:'state_moved'});continue;}
  try{
   const result=await applyLetterboxdClaim(env,{event,lid:pair.lid,tmdb:pair.tmdb,now,extraGuards});
   if(result.state==='written')counts.written++;
   else if(result.state==='already')counts.already++;
   else if(result.state==='refused')counts.refused++;
   else if(result.state==='unknown')counts.unknown++;
   else counts.deferred++;
   items.push({state:result.state,reason:result.reason||null});
   // Any outcome that is not a proved claim stops the run: no blind retry, no attempt on the rest.
   if(result.state!=='written'&&result.state!=='already')stopped='previous_pair_not_proved';
  }catch(error){
   counts.failed++;items.push({state:'failed',reason:error?.code||'unclassified'});stopped='previous_pair_failed';
  }
 }
 // Authoritative readback: the reader that served the 404 now finds each proved pair, the cohort that is still missing, and the rows that must not move.
 let found=0;
 for(let at=0;at<cohort.pairs.length;at++){
  if(items[at].state!=='written'&&items[at].state!=='already')continue;
  try{if((await catalogStartedFilm(env,cohort.pairs[at].lid)).state==='found')found++;}catch{/* counted as not found */}
 }
 let after=null,remaining=null;
 try{after=await sideCounts(db);remaining=(await deriveBackfillCohort(env)).counts.cohort;}catch{/* reported as not read */}
 const delta={};
 for(const table of COUNT_TABLES)delta[table]=after&&before[table]!=null&&after[table]!=null?after[table]-before[table]:null;
 const proved=counts.written+counts.already;
 const unexpected=delta.film_external_id!==counts.written||delta.film_alias!==0||delta.ratings_view!==0||(delta.started_mark!==null&&delta.started_mark!==0);
 const complete=proved===cohort.pairs.length&&found===proved&&remaining===0&&!unexpected;
 return {status:200,body:{ok:complete,mode:'apply',outcome:complete?'complete':'partial',writes:counts.written,requestId:args.requestId,digest:cohort.expect.digest,counts,items,readback:{found,remaining,delta,unexpectedChange:unexpected},authorities:cohort.authorities,publication:cohort.publication}};
}
