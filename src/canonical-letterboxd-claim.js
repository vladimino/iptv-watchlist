// AIR-559 (ADR 0184, Accepted; the producer is ACTIVE from the activation PR on, see LETTERBOXD_CLAIM_ACTIVATED below). The trusted `letterboxd` external-id claim of a canonical Film that the Ratings domain has already tied to one TMDB movie.
// WHY. `admitRatedFilm` keeps the verified Letterboxd short code only as the historical alias `letterboxd_short_code`, never as a trusted `letterboxd` claim (ADR 0166 option B was deferred), so
// `catalogFilmIdentityBridge` / `catalogStartedFilm` answer `absent` for a published lid whose Film exists and whose Ratings alias is unambiguous (the AIR-549 acceptance 404 `Unknown film`).
// WHAT. ONE targeted, fenced claim for an EXISTING Film, and nothing else: no Film is created, no alias, title, rating, membership or Started mark is touched, and no title/year/slug is ever used.
// PROOF (all independent of the caller; every item must hold, otherwise the verdict is `conflict` or `not_proved` and NOTHING is written):
//   1. both authorities are served: the Film/Person marker is `d1`/`open` and the ratings domain is `d1`/`open`, and neither generation moved between the first and the last read;
//   2. the CURRENT, authoritative Ratings link is unambiguous: the facts link index maps `letterboxd:<lid>` and `tmdb:<n>` to the same key, no other alias carries it, and the fact record says the same (this lid, this movie, not redirected, not migrating, not an inferred title/year link); `ratings_view` is only a projection (it keeps an alias after an unlink) and can corroborate, never prove;
//   3. canonical TMDB ownership: exactly one trusted, non-conflicting `tmdb` claim for <n> exists, its Film exists, is not a redirect source and its movie id is not retired (the reader's rule);
//   4. no claim of the lid exists on another Film, no untrusted or conflicting claim of the lid or of the movie id exists anywhere, the Film has no other `letterboxd` claim and no untrusted or conflicting claim of either scheme, and its `canonical_identity` is null or exactly `tmdb:<n>`.
// The proof that lives in this database is asserted AGAIN inside the fenced batch (write-time guards: ratings generation, retirement, competing claims, canonical identity); the link documents are covered by the ratings generation, which every ratings write bumps.
// A Film that already holds the lid as its one trusted claim is `already` (a pass that writes nothing). The write is the EXISTING fenced receipted unit `film_external_ids` in its `addOnly` mode (no pruning),
// so it is one `mutateFilm` batch with the marker generation, the Film revision (CAS) and the applied receipt; a replay with the same request id and content opens no second batch.
// Refusals never write. `planLetterboxdClaim` is read-only (the offline/owner-private mapping and the dry run of the backfill are exactly its verdicts); `applyLetterboxdClaims` is bounded and idempotent.
import {database,failed,many,one,readAuthority} from './film-person-authority.js';
import {applyFilmExternalIds} from './canonical-film-external-ids-producer.js';
import {readOwned} from './ratings-d1.js';
import {claimBridgeEvidence} from './identity-evidence-writer.js';

export const LETTERBOXD_CLAIM_ORIGIN='letterboxd_claim';
export const LETTERBOXD_CLAIM_SOURCE='ratings_alias_bridge';
export const LETTERBOXD_CLAIM_UNIT_CAP=12;
export const VERDICTS=Object.freeze(['pass','conflict','not_proved']);
const LINKS_KEY='letterboxd/facts/links.json';
const FACTS_RECORD_PREFIX='letterboxd/facts/films/';
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const FACT_KEY=/^[A-Za-z0-9_-]{1,100}$/;
const TMDB=/^[1-9]\d{0,11}$/;
const RETIRED_SQL="SELECT 1 AS hit FROM tmdb_retirement_decision r WHERE r.movie_id=? AND r.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq) LIMIT 1";
// AIR-618 (ADR 0215 decision 5, choice 0215-8b = C): the causal root of a bridge evidence row is the page-check digest of the very check that proved the link, handed over EXPLICITLY by the Diary or Watchlist caller that has just verified and linked
// the pair. Exactly 64 lowercase hex characters, or no root: a malformed value is a missing hand-over (the write stays rootless), never a guess and never looked up from a matching `same_work` row or a receipt.
const ROOT=/^[0-9a-f]{64}$/;
const rootOf=value=>typeof value==='string'&&ROOT.test(value)?value:null;
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

// The AUTHORITATIVE current link evidence (never the projection): the Ratings facts link index and the fact record it names, both D1-owned documents read through the ratings domain. `ratings_view` is only a projection that
// does not drop an alias on an unlink, so it can corroborate but never prove. Returns {ok:true} or {ok:false,verdict,reason}.
async function linkEvidence(env,lid,tmdb){
 let index,record,key;
 try{
  const links=await readOwned(env,LINKS_KEY);
  if(!links.owned)return {ok:false,verdict:'not_proved',reason:'ratings_not_authoritative'};
  index=links.value;
  if(index===null||index===undefined)return {ok:false,verdict:'not_proved',reason:'ratings_link_absent'};
  if(typeof index!=='object'||Array.isArray(index))return {ok:false,verdict:'not_proved',reason:'ratings_links_unreadable'};
  // The record key is whatever the index says (a Diary-first link keeps `lb-<lid>` and later gains `tmdb:<n>` on the SAME key), never a key built from the movie id.
  key=index['letterboxd:'+lid];
  if(key===undefined)return {ok:false,verdict:'not_proved',reason:'ratings_link_absent'};
  if(typeof key!=='string'||!FACT_KEY.test(key))return {ok:false,verdict:'conflict',reason:'ratings_link_malformed'};
  const movie=index['tmdb:'+tmdb];
  if(movie===undefined)return {ok:false,verdict:'not_proved',reason:'ratings_movie_link_absent'};
  if(movie!==key)return {ok:false,verdict:'conflict',reason:'ratings_link_points_elsewhere'};
  for(const [alias,target] of Object.entries(index))if(target===key&&alias!=='letterboxd:'+lid&&alias!=='tmdb:'+tmdb)return {ok:false,verdict:'conflict',reason:'ratings_link_ambiguous'};
  const doc=await readOwned(env,FACTS_RECORD_PREFIX+key+'.json');
  record=doc.value;
 }catch(error){
  if(error?.code==='ratings_domain_not_authoritative')return {ok:false,verdict:'not_proved',reason:'ratings_not_authoritative'};
  throw error?.code?error:failed('film_person_unavailable',error);
 }
 // The record must say the same thing as the index: this lid and this movie, not redirected and not mid-migration.
 if(!record||typeof record!=='object')return {ok:false,verdict:'not_proved',reason:'ratings_record_absent'};
 if(record.factKey!==undefined&&record.factKey!==key)return {ok:false,verdict:'conflict',reason:'ratings_record_disagrees'};
 if(record.links?.letterboxd!==lid||String(record.links?.tmdb)!==tmdb)return {ok:false,verdict:'conflict',reason:'ratings_record_disagrees'};
 if(record.redirectTo||record.migrating)return {ok:false,verdict:'conflict',reason:'ratings_record_not_settled'};
 // An INFERRED link (ADR 0104: one unique original title and year in a personal export) is a title/year match, not proof that this lid is this movie: it never yields a trusted claim, whichever flow offers it
 // (ADR 0184 decision 2b asks for an authoritative link). The import leaves two durable marks, and only it writes them: `identity` on a record that first received its lid from it, and `inferredPairs` (AIR-559),
 // an append-only list with one entry per exact lid/movie pair it attempted or linked on the record, each written and read back BEFORE the alias. A recorded `identity`, or an entry naming this pair, is refused;
 // an unknown kind or an unreadable list fails closed. Entries naming other pairs (attempts that conflicted) do not concern this link. LIMIT: a pair linked by the import before AIR-559 on a record that already
 // held facts and its lid carries neither mark and is NOT detected here; the producers therefore offer only pairs they verified themselves (see the Diary step), and the backfill needs the owner's decision.
 if(record.identity!=null)return {ok:false,verdict:'not_proved',reason:record.identity?.kind==='inferred'?'ratings_link_inferred':'ratings_link_unverified'};
 const pairs=record.inferredPairs;
 if(pairs!==undefined){
  if(!Array.isArray(pairs))return {ok:false,verdict:'not_proved',reason:'ratings_link_unverified'};
  for(const entry of pairs){
   const readable=!!entry&&typeof entry==='object'&&!Array.isArray(entry)&&typeof entry.letterboxd==='string'&&entry.tmdb!=null;
   if(!readable)return {ok:false,verdict:'not_proved',reason:'ratings_link_unverified'};
   if(entry.letterboxd===lid&&String(entry.tmdb)===tmdb)return {ok:false,verdict:'not_proved',reason:entry.kind==='inferred'?'ratings_link_inferred':'ratings_link_unverified'};
  }
 }
 return {ok:true,factKey:key};
}

// Read-only. {verdict:'pass'|'conflict'|'not_proved', reason, lid, tmdb, filmId?, already?, generation?, guards?}. Typed infrastructure failures (a held or unreadable marker, a read error) THROW and are never a verdict.
// `guards` are the write-time conditions of the proof that live in this database (see `guardsOf` in canonical-mutations.js): the writer asserts them again INSIDE its fenced batch.
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
  // 1. The Ratings side: a served domain, the authoritative link evidence, and the projection as corroboration only.
  const ratings=await ratingsGate(db);
  if(!ratings.open)return await done(out('not_proved','ratings_not_authoritative'));
  const evidence=await linkEvidence(env,l,t);
  if(!evidence.ok)return await done(out(evidence.verdict,evidence.reason));
  const after=await ratingsGate(db);
  if(!after.open||after.generation!==ratings.generation)throw failed('ratings_generation_moved');
  const key=evidence.factKey;
  // The projection corroborates and never proves: a row that exists must carry the authoritative key (both aliases), and no other alias may carry it; a missing row is not a conflict and not proof.
  const views=await many(db,'SELECT alias_id,fact_key FROM ratings_view WHERE alias_id=? OR alias_id=? OR fact_key=?',[l,'tmdb_'+t,key]);
  if(views.some(row=>(row.alias_id===l||row.alias_id==='tmdb_'+t)&&row.fact_key!==key))return await done(out('conflict','ratings_alias_points_elsewhere'));
  if(views.some(row=>row.fact_key===key&&row.alias_id!==l&&row.alias_id!=='tmdb_'+t))return await done(out('conflict','ratings_alias_ambiguous'));
  // 3. Canonical TMDB ownership of that movie id.
  const movie=await many(db,"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value=?",[t]);
  if(!movie.length)return await done(out('not_proved','film_absent'));
  const owner=movie.find(isOwn)?.film_id??null;
  if(!owner||movie.some(row=>!(isOwn(row)&&row.film_id===owner)))return await done(out('conflict','tmdb_claim_not_unique_trusted'));
  const film=await one(db,'SELECT id,canonical_identity FROM film WHERE id=?',[owner]);
  if(!film)return await done(out('conflict','film_row_missing',{filmId:owner}));
  // The Film's own recorded identity must be this movie (or none): another one makes the reader answer `conflict` after the write.
  if(film.canonical_identity!=null&&film.canonical_identity!=='tmdb:'+t)return await done(out('conflict','canonical_identity_mismatch',{filmId:owner}));
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
  const guards=[
   {sql:"EXISTS (SELECT 1 FROM ratings_domain_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)",params:[ratings.generation]},
   {sql:"NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision r WHERE r.movie_id=? AND r.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq))",params:[t]},
   {sql:"NOT EXISTS (SELECT 1 FROM film_external_id WHERE scheme='letterboxd' AND value=? AND film_id<>?)",params:[l,owner]},
   {sql:"NOT EXISTS (SELECT 1 FROM film_external_id WHERE scheme='tmdb' AND value=? AND NOT (film_id=? AND trusted=1 AND conflicting=0))",params:[t,owner]},
   {sql:"EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0)",params:[owner,t]},
   {sql:"(SELECT COUNT(*) FROM film_external_id WHERE film_id=? AND scheme='tmdb')=1",params:[owner]},
   {sql:"NOT EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme IN ('tmdb','letterboxd') AND NOT (trusted=1 AND conflicting=0))",params:[owner]},
   {sql:"(SELECT COUNT(*) FROM film_external_id WHERE film_id=? AND scheme='letterboxd')=0",params:[owner]},
   {sql:"COALESCE((SELECT canonical_identity FROM film WHERE id=?),?)=?",params:[owner,'tmdb:'+t,'tmdb:'+t]},
  ];
  return await done(out('pass','proved',{filmId:owner,already:false,generation:gate.generation,guards}));
 }catch(error){
  if(error?.code)throw error;
  throw failed('film_person_unavailable',error);
 }
}

// The re-plan of a receipt retry: a FRESH proof from the current stores, or null when the source no longer proves exactly this claim for the same Film (the receipt then ends as a moved source, never a write from a stale proof).
// `root` (AIR-618): the hand-over of the first attempt, kept by the in-process retry of the SAME call; a receipt reconciler that re-plans from the receipt alone has no root, so such a write is rootless (the first committed attempt decides).
export async function replanLetterboxdClaim(env,{lid,tmdb,filmId,now,extraGuards=[],root=null}){
 const fresh=await planLetterboxdClaim(env,{lid,tmdb});
 return fresh.verdict==='pass'&&!fresh.already&&fresh.filmId===filmId?claimInput(fresh,(typeof now==='function'?now:()=>now||new Date().toISOString())(),extraGuards,rootOf(root),env):null;
}

// The unit input. `evidence` (a function, not content: the request id and the content digest are the same with or without it) is present only for a rooted write; it adds the bridge row's two statements to the claim's own batch.
// The one external id a claim adds (AIR-653: also the content an operator recomputes to verify the receipt of a written claim; the same shape the unit's digest and request id are derived from).
export const claimExternalIds=({lid,tmdb})=>[{scheme:'letterboxd',value:lid,trusted:true,conflicting:false,provenance:{source:LETTERBOXD_CLAIM_SOURCE,tmdb,adr:'0184'}}];
function claimInput(plan,at,extraGuards=[],root=null,env=null){
 const evidence=root?claimBridgeEvidence(env,{filmId:plan.filmId,lid:plan.lid,root}):undefined;
 return {id:plan.filmId,at,schemes:['letterboxd'],addOnly:true,guards:[...plan.guards,...extraGuards],...(evidence?{evidence}:{}),
  externalIds:claimExternalIds(plan)};
}

// ONE claim: plan, then the fenced unit, then an AUTHORITATIVE readback. {state:'written'|'already'|'refused'|'unknown'|'deferred', verdict, reason, filmId, requestId?}. A refusal (`conflict`, `not_proved`) writes nothing and names its reason.
// `event` is the stable source event (the producer's run or the backfill's frozen cohort id), bound into the request id; the same event, Film and content is the same request (idempotent replay). The proof is re-planned from the CURRENT
// stores on every receipt retry (a stale proof is never replayed: a source that no longer proves the claim ends the receipt as a moved source), and the write-time guards are asserted inside the batch. An applied receipt is not evidence of a
// claim: `written` is returned only when the readback finds the trusted claim now stored; an applied receipt without the claim (a lid removed after an earlier run of the same event) is `unknown`, never a success.
// `extraGuards` ([{sql,params}], at most 5) are the caller's frozen-state pins (an operator's approved generations), asserted INSIDE the same fenced batch next to the planner's own guards; one that does not hold writes nothing.
// `root` (AIR-618, ADR 0215 choice 0215-8b = C): the page-check digest handed over by the Diary or Watchlist caller that has just verified and linked this pair. Rooted: the claim batch also carries the `claim_alias_bridge` evidence row
// (inserted only while that writer is `pending` or `on`; absent or `off`: nothing). Rootless (the backfill, a replay, a pre-A2 link, a lost hand-over): the claim write is unchanged and writes no row.
// `approvedPins` (AIR-653, optional): the authority pins an operator froze at its approval (see approvedPinsOf in src/canonical-mutations.js, with optional extra `guards`). They are asserted in the receipt's RESERVATION and in the claim's batch, not only in the claim's batch.
// `expectedFilmId` (AIR-653, optional): the Film an operator's approval selected; a fresh proof that names another Film is refused (`target_moved`) before anything is reserved. `noReplay`: see receiptedWrite.
export async function applyLetterboxdClaim(env,{event,lid,tmdb,now,extraGuards=[],root,approvedPins=null,expectedFilmId,noReplay=false}={}){
 if(typeof event!=='string'||!event.trim())throw failed('film_person_invalid');
 const clock=typeof now==='function'?now:()=>now||new Date().toISOString();
 const plan=await planLetterboxdClaim(env,{lid,tmdb});
 if(plan.verdict!=='pass')return {state:'refused',...plan};
 if(plan.already)return {state:'already',...plan};
 if(expectedFilmId!==undefined&&plan.filmId!==expectedFilmId){const {guards:_ignored,...shown}=plan;return {state:'refused',...shown,verdict:'conflict',reason:'target_moved'};}
 if(!Array.isArray(extraGuards)||extraGuards.length>5)throw failed('film_person_invalid');
 const rooted=rootOf(root);
 const input=claimInput(plan,clock(),extraGuards,rooted,env);
 const replan=()=>replanLetterboxdClaim(env,{lid,tmdb,filmId:plan.filmId,now:clock,extraGuards,root:rooted});
 const outcome=await applyFilmExternalIds(env,{origin:LETTERBOXD_CLAIM_ORIGIN,event,input,replan,now:clock,...(approvedPins?{approvedPins}:{}),...(noReplay?{noReplay:true}:{})});
 const {guards:_guards,...shown}=plan;
 if(outcome.state==='absent'||outcome.state==='skipped')return {state:'refused',...shown,verdict:'not_proved',reason:outcome.state==='absent'?'film_absent':'film_person_route_not_open',outcomeState:outcome.state,requestId:outcome.requestId??null};
 if(outcome.state==='applied'||outcome.state==='already'||outcome.state==='noop'){
  const back=await planLetterboxdClaim(env,{lid,tmdb});
  if(back.verdict==='pass'&&back.already===true&&back.filmId===plan.filmId)return {state:outcome.state==='noop'?'already':'written',...shown,outcomeState:outcome.state,requestId:outcome.requestId??null};
  return {state:'unknown',...shown,reason:'readback_missing_claim',outcomeState:outcome.state,requestId:outcome.requestId??null};
 }
 return {state:outcome.state==='unknown'?'unknown':'deferred',...shown,outcomeState:outcome.state,requestId:outcome.requestId??null};
}

// Bounded batch of the same: items [{lid,tmdb}] (never a root: the owner backfill is rootless by definition), at most LETTERBOXD_CLAIM_UNIT_CAP, one after another (never in parallel). A typed infrastructure failure stops the batch and propagates; a refusal of one item never stops another.
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

// ---- Producer wiring (ADR 0184 decision 5) ----
// ACTIVATION GATE. The call sites of the Ratings flows hand their proven pairs to `ensureLetterboxdClaims`, which does NOTHING while this constant is false. It is an in-code constant, not a Cloudflare variable or flag:
// it was switched on by ONE reviewed line in the AIR-559 activation PR after the owner's explicit GO (runbook docs/runbooks/letterboxd-claim-backfill.md, activation plan). Rollback is the same line set back to
// false in a reviewed PR: it stops new offers; claims already written stay. Tests that are not about the gate pass `enabled` explicitly.
export const LETTERBOXD_CLAIM_ACTIVATED=true;

// A pair may carry `root`: the page-check digest of the check that verified and linked it, handed over only by a caller that performed that check in this very step (AIR-618). A pair without one is rootless.
// The pairs a flow has JUST made durable on the Ratings side (the fact record and the link index) and, for an admitted Film, the D1 admission. Never throws into the caller: the rating fact, the Diary fact and the Event do not wait
// for the claim and never fail because of it. {state:'inactive'|'complete'|'incomplete'|'skipped', requested, written, already, refused, unknown, deferred, overflow, failed, results?}. At most LETTERBOXD_CLAIM_UNIT_CAP pairs are
// attempted per call; the rest are `overflow` (the next ordinary run of the same flow offers them again, and `already` makes a repeat free). `event` is stable per pair (`link:<lid>:<tmdb>`), never a timestamp.
export const LETTERBOXD_CLAIM_OFFER_MAX=200;
export async function ensureLetterboxdClaims(env,{pairs=[],enabled=LETTERBOXD_CLAIM_ACTIVATED,now}={}){
 if(enabled!==true)return {state:'inactive',requested:0,written:0,already:0,refused:0,unknown:0,deferred:0,overflow:0,failed:0,unattempted:[],results:[]};
 const seen=new Set(),all=[];
 for(const pair of Array.isArray(pairs)?pairs:[]){
  const lid=typeof pair?.lid==='string'?pair.lid:'',tmdb=pair?.tmdb==null?'':String(pair.tmdb);
  if(!LID.test(lid)||lid.startsWith('tmdb_')||!TMDB.test(tmdb))continue;
  // The same lid offered twice for the same movie (a hand-over and a retry of one step): one pair, and a root that one of them carries is kept (an explicit hand-over is never dropped for a retry without one).
  if(seen.has(lid)){const first=all.find(item=>item.lid===lid);if(first&&first.tmdb===tmdb&&!first.root)first.root=rootOf(pair?.root);continue;}
  seen.add(lid);all.push({lid,tmdb,root:rootOf(pair?.root)});
 }
 // The whole call has a fixed budget: ONE ordering read, then at most LETTERBOXD_CLAIM_UNIT_CAP full proofs (each a bounded number of reads and at most one fenced batch). Everything beyond is `overflow` (offered again by the next ordinary run).
 const list=all.slice(0,LETTERBOXD_CLAIM_OFFER_MAX),beyond=all.slice(LETTERBOXD_CLAIM_OFFER_MAX);
 const out={state:'complete',requested:all.length,written:0,already:0,refused:0,unknown:0,deferred:0,overflow:0,failed:0,unattempted:[],results:[]};
 // ONE batched read ORDERS the offer: lids that no trusted claim holds yet go first. It is never evidence and never declares `already`: every attempted pair, held or not, gets the full read-only proof of `planLetterboxdClaim`.
 let held=new Set();
 const db=database(env);
 if(db&&list.length){
  try{held=new Set((await many(db,"SELECT value FROM film_external_id WHERE scheme='letterboxd' AND trusted=1 AND conflicting=0 AND value IN (SELECT value FROM json_each(?))",[JSON.stringify(list.map(pair=>pair.lid))])).map(row=>String(row.value)));}catch{held=new Set();}
 }
 const ordered=[...list.filter(pair=>!held.has(pair.lid)),...list.filter(pair=>held.has(pair.lid))];
 const attempt=ordered.slice(0,LETTERBOXD_CLAIM_UNIT_CAP),rest=ordered.slice(LETTERBOXD_CLAIM_UNIT_CAP);
 // `unattempted`: the lids whose claim was not attempted and may still lack one (a lid already held by a trusted claim that did not fit is not listed: it needs nothing). A caller that keeps a retry state keeps it for these.
 const unattempted=[...rest.filter(pair=>!held.has(pair.lid)),...beyond].map(pair=>pair.lid);
 out.overflow=rest.length+beyond.length;
 let stopped=false;
 for(const pair of attempt){
  if(stopped){unattempted.push(pair.lid);out.overflow++;continue;}
  try{
   const result=await applyLetterboxdClaim(env,{event:'link:'+pair.lid+':'+pair.tmdb,lid:pair.lid,tmdb:pair.tmdb,now,root:pair.root});
   if(result.state==='written')out.written++;
   else if(result.state==='already')out.already++;
   else if(result.state==='refused')out.refused++;
   else if(result.state==='unknown')out.unknown++;
   else out.deferred++;
   out.results.push({lid:pair.lid,state:result.state,verdict:result.verdict||null,reason:result.reason||null});
  }catch(error){
   // A held or unreadable authority, a moved generation or a read failure: nothing was written for this pair, the flow goes on, the next ordinary run offers it again.
   out.failed++;
   out.results.push({lid:pair.lid,state:'failed',verdict:null,reason:error?.code||'unclassified'});
   if(error?.code==='film_person_not_open'||error?.code==='film_person_held'||error?.code==='film_person_unavailable')stopped=true;
  }
 }
 out.unattempted=unattempted;
 if(out.refused||out.unknown||out.deferred||out.failed||out.overflow)out.state='incomplete';
 return out;
}
