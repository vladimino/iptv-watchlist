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
  const row=await one(db,'SELECT mode,cutover,programme_run_id AS run FROM published_epg_authority WHERE id=1');
  return row?{mode:row.mode,cutover:row.cutover,programmeRunId:row.run??null}:null;
 }catch(error){
  if(/no such table/i.test(String(error?.message||error)))return null;
  throw failed('film_person_unavailable',error);
 }
}

// Read-only. {decision:'eligible'|'already_current'|'unsafe'|'unknown', blockers:[{reason,count}], authorities, publication, counts, expect, pairs}. `pairs` is for the caller's own use inside the trusted process and is never put into a response.
export async function deriveBackfillCohort(env){
 const db=database(env);
 const out={decision:'unsafe',blockers:[],authorities:{filmPerson:null,ratings:null},publication:null,counts:{cohort:0,pass:0,conflict:0,not_proved:0,already:0,unresolved:0},expect:null,pairs:[]};
 const reasons={};
 const stop=(decision,reason)=>{out.decision=decision;bump(reasons,reason);out.blockers=blockerList(reasons);return out;};
 if(!db)return stop('unknown','film_person_unavailable');
 let gate;
 try{gate=await readAuthority(env);}
 catch(error){return stop(['film_person_held','film_person_not_open'].includes(error?.code)?'unsafe':'unknown',error?.code||'film_person_unavailable');}
 out.authorities.filmPerson={state:gate.state,generation:Number(gate.generation)};
 if(gate.state!=='open')return stop('unsafe','film_person_not_open');
 let ratings,publication;
 try{ratings=await ratingsMarker(db);publication=await publicationMarker(db);}
 catch(error){return stop('unknown',error?.code||'film_person_unavailable');}
 out.authorities.ratings=ratings;out.publication=publication?{mode:publication.mode,cutover:publication.cutover,programmeRunId:publication.programmeRunId}:null;
 if(!ratings||ratings.mode!=='d1'||ratings.cutover!=='open')return stop('unsafe','ratings_not_authoritative');
 if(!publication||publication.mode!=='d1'||publication.cutover!=='open'||typeof publication.programmeRunId!=='string'||!RUN_ID.test(publication.programmeRunId))return stop('unsafe','publication_not_authoritative');
 let candidates;
 try{candidates=(await many(db,CANDIDATE_SQL,[publication.programmeRunId,BACKFILL_MAX+1])).map(row=>String(row.lid));}
 catch(error){return stop('unknown',error?.code||'film_person_unavailable');}
 out.counts.cohort=candidates.length;
 if(!candidates.length){
  out.decision='already_current';
  out.expect={filmPersonGeneration:out.authorities.filmPerson.generation,ratingsGeneration:ratings.generation,programmeRunId:publication.programmeRunId,count:0,digest:await cohortDigest([])};
  return out;
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
  if(plan.verdict==='pass'&&!plan.already){out.counts.pass++;resolved.push({lid,tmdb:movies[0]});}
  else if(plan.verdict==='pass'){out.counts.already++;bump(reasons,'already_current');}
  else{out.counts[plan.verdict]++;bump(reasons,plan.reason);unsafe=true;}
 }
 out.blockers=blockerList(reasons);
 out.pairs=resolved;
 out.expect={filmPersonGeneration:out.authorities.filmPerson.generation,ratingsGeneration:ratings.generation,programmeRunId:publication.programmeRunId,count:resolved.length,digest:await cohortDigest(resolved)};
 out.decision=unknown?'unknown':unsafe||out.counts.already?'unsafe':'eligible';
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

// args: {mode:'dry_run'|'apply', confirmGo?, requestId?, expectedFilmPersonGeneration?, expectedRatingsGeneration?, expectedProgrammeRunId?, expectedCount?, expectedDigest?}. Returns {status, body}.
export async function handleLetterboxdClaimBackfillTool(env,args={},{now}={}){
 if(!args||typeof args!=='object'||Array.isArray(args))return {status:400,body:{ok:false,reason:'invalid'}};
 if(args.mode!=='dry_run'&&args.mode!=='apply')return {status:400,body:{ok:false,reason:'invalid_mode'}};
 if(args.confirmGo!==undefined&&typeof args.confirmGo!=='boolean')return {status:400,body:{ok:false,reason:'invalid_confirm'}};
 if(args.mode==='dry_run'){
  const cohort=await deriveBackfillCohort(env);
  return {status:200,body:{ok:true,mode:'dry_run',sideEffects:'none',...publicView(cohort)}};
 }
 if(args.confirmGo!==true)return {status:400,body:{ok:false,reason:'confirm_required'}};
 if(typeof args.requestId!=='string'||!BACKFILL_REQUEST_ID.test(args.requestId))return {status:400,body:{ok:false,reason:'invalid_request_id'}};
 if(!Number.isInteger(args.expectedFilmPersonGeneration)||args.expectedFilmPersonGeneration<0)return {status:400,body:{ok:false,reason:'invalid_expected_film_person_generation'}};
 if(!Number.isInteger(args.expectedRatingsGeneration)||args.expectedRatingsGeneration<0)return {status:400,body:{ok:false,reason:'invalid_expected_ratings_generation'}};
 if(typeof args.expectedProgrammeRunId!=='string'||!RUN_ID.test(args.expectedProgrammeRunId))return {status:400,body:{ok:false,reason:'invalid_expected_programme_run_id'}};
 if(!Number.isInteger(args.expectedCount)||args.expectedCount<1||args.expectedCount>BACKFILL_MAX)return {status:400,body:{ok:false,reason:'invalid_expected_count'}};
 if(typeof args.expectedDigest!=='string'||!HEX64.test(args.expectedDigest))return {status:400,body:{ok:false,reason:'invalid_expected_digest'}};
 // The cohort and every proof are derived AGAIN, right now; nothing is written unless it equals the pins.
 const cohort=await deriveBackfillCohort(env);
 if(cohort.decision!=='eligible')return {status:409,body:{ok:false,reason:'not_eligible',writes:0,...publicView(cohort)}};
 const wanted={filmPersonGeneration:args.expectedFilmPersonGeneration,ratingsGeneration:args.expectedRatingsGeneration,programmeRunId:args.expectedProgrammeRunId,count:args.expectedCount,digest:args.expectedDigest};
 const mismatched=Object.keys(wanted).filter(name=>cohort.expect[name]!==wanted[name]);
 if(mismatched.length)return {status:409,body:{ok:false,reason:'pins_mismatch',writes:0,mismatched,...publicView(cohort)}};
 const db=database(env);
 let before;
 try{before=await sideCounts(db);}catch(error){return {status:503,body:{ok:false,reason:error?.code||'film_person_unavailable',writes:0}};}
 // One stable event for this frozen cohort and request: the same request replays idempotently (receipts) and never writes twice.
 const event='backfill:'+args.requestId+':'+cohort.expect.digest.slice(0,16);
 const counts={written:0,already:0,refused:0,unknown:0,deferred:0,failed:0,notAttempted:0};
 const items=[];let stopped=false;
 for(const pair of cohort.pairs){
  if(stopped){counts.notAttempted++;items.push({state:'not_attempted',reason:null});continue;}
  try{
   const result=await applyLetterboxdClaim(env,{event,lid:pair.lid,tmdb:pair.tmdb,now});
   if(result.state==='written')counts.written++;
   else if(result.state==='already')counts.already++;
   else if(result.state==='refused')counts.refused++;
   else if(result.state==='unknown')counts.unknown++;
   else counts.deferred++;
   items.push({state:result.state,reason:result.reason||null});
   // Any outcome that is not a proved claim stops the run: no blind retry, no attempt on the rest.
   if(result.state!=='written'&&result.state!=='already')stopped=true;
  }catch(error){
   counts.failed++;items.push({state:'failed',reason:error?.code||'unclassified'});stopped=true;
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
 return {status:200,body:{ok:complete,mode:'apply',outcome:complete?'complete':'partial',requestId:args.requestId,digest:cohort.expect.digest,counts,items,readback:{found,remaining,delta,unexpectedChange:unexpected},authorities:cohort.authorities,publication:cohort.publication}};
}
