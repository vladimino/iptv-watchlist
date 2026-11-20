// AIR-559 (ADR 0184, PROPOSED: not active until the owner accepts it). The trusted `letterboxd` external-id claim of a canonical Film that the Ratings domain has already tied to one TMDB movie.
// WHY. `admitRatedFilm` keeps the verified Letterboxd short code only as the historical alias `letterboxd_short_code`, never as a trusted `letterboxd` claim (ADR 0166 option B was deferred), so
// `catalogFilmIdentityBridge` / `catalogStartedFilm` answer `absent` for a published lid whose Film exists and whose Ratings alias is unambiguous (the AIR-549 acceptance 404 `Unknown film`).
// WHAT. ONE targeted, fenced claim for an EXISTING Film, and nothing else: no Film is created, no alias, title, rating, membership or Started mark is touched, and no title/year/slug is ever used.
// PROOF (all independent of the caller; every item must hold, otherwise the verdict is `conflict` or `not_proved` and NOTHING is written):
//   1. both authorities are served: the Film/Person marker is `d1`/`open` and the ratings domain is `d1`/`open`, and neither generation moved between the first and the last read;
//   2. the Ratings alias link is unambiguous: `ratings_view` holds the lid with `fact_key = tmdb-<n>` and the movie alias `tmdb_<n>` with the same key, and no other lid-shaped alias carries that key;
//   3. canonical TMDB ownership: exactly one trusted, non-conflicting `tmdb` claim for <n> exists, its Film exists, is not a redirect source and its movie id is not retired (the reader's rule);
//   4. no claim of the lid exists on another Film, no untrusted or conflicting claim of the lid or of the movie id exists anywhere, and the Film has no other `letterboxd` claim and no untrusted or conflicting claim of either scheme.
// A Film that already holds the lid as its one trusted claim is `already` (a pass that writes nothing). The write is the EXISTING fenced receipted unit `film_external_ids` in its `addOnly` mode (no pruning),
// so it is one `mutateFilm` batch with the marker generation, the Film revision (CAS) and the applied receipt; a replay with the same request id and content opens no second batch.
// Refusals never write. `planLetterboxdClaim` is read-only (the offline/owner-private mapping and the dry run of the backfill are exactly its verdicts); `applyLetterboxdClaims` is bounded and idempotent.
import {database,failed,many,one,readAuthority} from './film-person-authority.js';
import {applyFilmExternalIds} from './canonical-film-external-ids-producer.js';

export const LETTERBOXD_CLAIM_ORIGIN='letterboxd_claim';
export const LETTERBOXD_CLAIM_SOURCE='ratings_alias_bridge';
export const LETTERBOXD_CLAIM_UNIT_CAP=12;
export const VERDICTS=Object.freeze(['pass','conflict','not_proved']);
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const TMDB=/^[1-9]\d{0,11}$/;
const RETIRED_SQL="SELECT 1 AS hit FROM tmdb_retirement_decision r WHERE r.movie_id=? AND r.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq) LIMIT 1";
const isOwn=row=>Number(row.trusted)===1&&Number(row.conflicting)===0;
const verdict=(state,reason,extra={})=>({verdict:state,reason,...extra});

async function ratingsGate(db){
 try{
  const row=await one(db,'SELECT mode,cutover,generation FROM ratings_domain_authority WHERE id=1');
  return row&&row.mode==='d1'&&row.cutover==='open'?{open:true,generation:Number(row.generation)}:{open:false,generation:null};
 }catch(error){
  if(/no such table/i.test(String(error?.message||error)))return {open:false,generation:null};
  throw failed('film_person_unavailable',error);
 }
}

// Read-only. {verdict:'pass'|'conflict'|'not_proved', reason, lid, tmdb, filmId?, already?, generation?}. Typed infrastructure failures (a held or unreadable marker, a read error) THROW and are never a verdict.
export async function planLetterboxdClaim(env,{lid,tmdb}={}){
 const l=typeof lid==='string'?lid:'',t=typeof tmdb==='string'||typeof tmdb==='number'?String(tmdb):'';
 if(!LID.test(l)||l.startsWith('tmdb_')||!TMDB.test(t))return verdict('not_proved','invalid_input',{lid:l||null,tmdb:t||null});
 const gate=await readAuthority(env);
 if(gate.state!=='open')throw failed('film_person_not_open');
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const out=(state,reason,extra)=>verdict(state,reason,{lid:l,tmdb:t,...extra});
 const done=async result=>{
  const again=await readAuthority(env);
  if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_generation_moved');
  return result;
 };
 try{
  // 1 + 2. The Ratings side: a served domain and ONE unambiguous alias link.
  const ratings=await ratingsGate(db);
  if(!ratings.open)return await done(out('not_proved','ratings_not_authoritative'));
  const key='tmdb-'+t;
  const views=await many(db,'SELECT alias_id,fact_key FROM ratings_view WHERE alias_id=? OR alias_id=? OR fact_key=?',[l,'tmdb_'+t,key]);
  const lidRow=views.find(row=>row.alias_id===l);
  if(!lidRow)return await done(out('not_proved','ratings_alias_absent'));
  if(lidRow.fact_key!==key)return await done(out('conflict','ratings_alias_points_elsewhere'));
  if(!views.some(row=>row.alias_id==='tmdb_'+t&&row.fact_key===key))return await done(out('not_proved','ratings_movie_alias_absent'));
  const others=views.filter(row=>row.fact_key===key&&row.alias_id!==l&&row.alias_id!=='tmdb_'+t);
  if(others.length)return await done(out('conflict','ratings_alias_ambiguous'));
  // 3. Canonical TMDB ownership of that movie id.
  const movie=await many(db,"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value=?",[t]);
  if(!movie.length)return await done(out('not_proved','film_absent'));
  const owner=movie.find(isOwn)?.film_id??null;
  if(!owner||movie.some(row=>!(isOwn(row)&&row.film_id===owner)))return await done(out('conflict','tmdb_claim_not_unique_trusted'));
  const film=await one(db,'SELECT id FROM film WHERE id=?',[owner]);
  if(!film)return await done(out('conflict','film_row_missing',{filmId:owner}));
  if(await one(db,'SELECT 1 AS hit FROM film_redirect WHERE from_id=? LIMIT 1',[owner]))return await done(out('conflict','film_redirected',{filmId:owner}));
  if(await one(db,RETIRED_SQL,[t]))return await done(out('conflict','tmdb_retired',{filmId:owner}));
  // 4. The lid and the Film hold no competing claim.
  const lidClaims=await many(db,"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='letterboxd' AND value=?",[l]);
  const own=await many(db,"SELECT scheme,value,trusted,conflicting FROM film_external_id WHERE film_id=? AND scheme IN ('tmdb','letterboxd')",[owner]);
  if(lidClaims.some(row=>row.film_id!==owner))return await done(out('conflict','lid_claimed_elsewhere',{filmId:owner}));
  if(own.some(row=>!isOwn(row)))return await done(out('conflict','film_has_untrusted_claim',{filmId:owner}));
  if(own.filter(row=>row.scheme==='tmdb').length!==1)return await done(out('conflict','film_has_other_tmdb_claim',{filmId:owner}));
  const lids=own.filter(row=>row.scheme==='letterboxd').map(row=>String(row.value));
  if(lids.some(value=>value!==l))return await done(out('conflict','film_has_other_lid',{filmId:owner}));
  if(lids.length)return await done(out('pass','already',{filmId:owner,already:true,generation:gate.generation}));
  return await done(out('pass','proved',{filmId:owner,already:false,generation:gate.generation}));
 }catch(error){
  if(error?.code)throw error;
  throw failed('film_person_unavailable',error);
 }
}

function claimInput(plan,at){
 return {id:plan.filmId,at,schemes:['letterboxd'],addOnly:true,
  externalIds:[{scheme:'letterboxd',value:plan.lid,trusted:true,conflicting:false,provenance:{source:LETTERBOXD_CLAIM_SOURCE,tmdb:plan.tmdb,adr:'0184'}}]};
}

// ONE claim: plan, then the fenced unit. {state:'written'|'already'|'refused'|'unknown'|'deferred', verdict, reason, filmId, requestId?}. A refusal (`conflict`, `not_proved`) writes nothing and names its reason.
// `event` is the stable source event (the producer's run or the backfill's frozen cohort id), bound into the request id; the same event, Film and content is the same request (idempotent replay).
export async function applyLetterboxdClaim(env,{event,lid,tmdb,now}={}){
 if(typeof event!=='string'||!event.trim())throw failed('film_person_invalid');
 const clock=typeof now==='function'?now:()=>now||new Date().toISOString();
 const plan=await planLetterboxdClaim(env,{lid,tmdb});
 if(plan.verdict!=='pass')return {state:'refused',...plan};
 if(plan.already)return {state:'already',...plan};
 const input=claimInput(plan,clock());
 const outcome=await applyFilmExternalIds(env,{origin:LETTERBOXD_CLAIM_ORIGIN,event,input,replan:async()=>input,now:clock});
 // `unknown`: the batch outcome is not proved (settled by readback and a replay of the same request, never a blind retry). Any other non-terminal outcome (a failed fence or revision CAS, a waiting receipt) is `deferred`: nothing was written and
 // the receipt stays retryable by the SAME request id (a later call or the origin's own inline reconcile).
 const state=outcome.state==='applied'||outcome.state==='already'?'written':outcome.state==='noop'?'already':outcome.state==='absent'||outcome.state==='skipped'?'refused':outcome.state==='unknown'?'unknown':'deferred';
 return {state,...plan,outcomeState:outcome.state,requestId:outcome.requestId??null,...(outcome.state==='absent'?{verdict:'not_proved',reason:'film_absent'}:{})};
}

// Bounded batch of the same: items [{lid,tmdb}], at most LETTERBOXD_CLAIM_UNIT_CAP, one after another (never in parallel). A typed infrastructure failure stops the batch and propagates; a refusal of one item never stops another.
// {written, already, refused, unknown, deferred, results:[...]}; `dryRun: true` plans only and writes nothing.
export async function applyLetterboxdClaims(env,{event,items=[],now,dryRun=false}={}){
 if(!Array.isArray(items)||items.length>LETTERBOXD_CLAIM_UNIT_CAP)throw failed('film_person_bounded');
 const seen=new Set();
 for(const item of items){
  const key=String(item?.lid);
  if(seen.has(key))throw failed('film_person_invalid');
  seen.add(key);
 }
 const counts={written:0,already:0,refused:0,unknown:0,deferred:0},results=[];
 for(const item of items){
  const result=dryRun?await planLetterboxdClaim(env,item).then(plan=>({state:plan.verdict==='pass'?(plan.already?'already':'would_write'):'refused',...plan})):await applyLetterboxdClaim(env,{event,lid:item.lid,tmdb:item.tmdb,now});
  if(result.state==='written')counts.written++;
  else if(result.state==='already')counts.already++;
  else if(result.state==='unknown')counts.unknown++;
  else if(result.state==='deferred')counts.deferred++;
  else if(result.state==='refused')counts.refused++;
  results.push(result);
 }
 return {dryRun:!!dryRun,...counts,results};
}
