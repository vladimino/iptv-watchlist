// AIR-497 / ADR 0141. Bounded Producer Workflow chain. Dormant unless the Film/Person marker is d1/open
// AND env.PRODUCER_WORKFLOW exists. Launched ONLY from hourly reconcileProducerChain. No new cron, flag or Task.
import {database,many,one,readAuthority} from './film-person-authority.js';
import {readDocument,readMembers,readAuthority as readPublished} from './published-epg.js';
import {buildEpgPlan,runEpgProducerPass,retryEpgProducerResults,readCanonicalFreshness} from './canonical-producer-driver.js';
import {reconcileEpgRun} from './canonical-epg-person-producer.js';
import {
 CHAIN_BOUNDARY_MARGIN_MS,CHAIN_CREATE_ATTEMPTS,CHAIN_FLOOR_D1_CALLS,CHAIN_FLOOR_D1_STATEMENTS,CHAIN_LEASE_MS,
 CHAIN_MAX_SLICES,CHAIN_QUIET_MS,CHAIN_REBASE_CAP,CHAIN_SLICE_DEADLINE_MS,CHAIN_SLICE_SIZE,successorDecision,operationCost,admitOperation,
 snapshotLabel,generationOrder,producerInstanceId,requireFence,
} from './canonical-producer-fence.js';
import {
 claimChain,completeChain,handoffChain,launchChain,listNonterminalChains,markWorkEntered,parseReleasePin,pinChainReleases,
 readChain,rebaseChain,recordHeldOutcome,recoverChain,relaunchChain,reopenChain,stopChain,supersedeChain,takeoverChain,yieldChain,
} from './canonical-producer-chain.js';
import {epgRunForGeneration} from './canonical-producer-store.js';
import {drainOutcomes,readOutcomeSchema} from './canonical-producer-events.js';

const iso=ms=>new Date(ms).toISOString();
// AIR-572 delivery hold: a static guard in code. While true, neither Producer entrypoint performs any I/O: the hourly
// `reconcileProducerChain` reads nothing, writes nothing and creates no Workflow instance, and an already existing instance entering
// `runProducerWorkflow` returns before its nonce, claim or any D1 access. It depends on no secret, env, D1 state or Cloudflare setting.
// Production callers never pass `hold`, so the default applies. LIFTED (false) by the owner-approved AIR-572 PR after the Watchlist
// membership writer switched to the Letterboxd Sync (ADR 0203, marker `sync` generation 1, 23 Nov 2026): the Producer now plans and
// writes Film/Person facts without membership. Re-imposing it is a code change too, never a flag. Only an explicit `false` runs.
export const PRODUCER_DELIVERY_HOLD=false;
export const HELD_BY_DELIVERY='held_by_delivery';
function meterD1(db,meter){
 if(!db||typeof db.prepare!=='function')return db;
 return new Proxy(db,{get(target,prop){
  if(prop==='prepare')return sql=>{meter.statements++;meter.calls++;return target.prepare(sql);};
  if(prop==='batch')return statements=>{meter.batches++;meter.calls++;return target.batch(statements);};
  const value=Reflect.get(target,prop,target);
  return typeof value==='function'?value.bind(target):value;
 }});
}
function meteredEnv(env,meter){
 if(!env?.DB)return env;
 return new Proxy(env,{get(target,prop){return prop==='DB'?meterD1(target.DB,meter):Reflect.get(target,prop,target);}});
}
function createError(error){
 const text=String(error?.message||error||'');
 if(/already exists|duplicate/i.test(text))return 'exists';
 return 'uncertain';
}

function canonicalFilmId(raw,resolved){
 const s=String(raw||'');
 if(!s)return null;
 if(resolved&&resolved.has(s))return resolved.get(s);
 if(s.startsWith('film:'))return s;
 if(s.startsWith('tmdb_'))return 'film:tmdb:'+s.slice(5);
 if(s.startsWith('tmdb:'))return 'film:'+s;
 return 'film:'+s;
}
function canonicalPersonId(raw){
 const s=String(raw||'');
 if(!s)return null;
 return s.startsWith('person:')?s:'person:'+s;
}
function clockOf(value){return typeof value==='string'&&value.length?value:null;}
function plain(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function sealedDimension(raw,name){
 if(!plain(raw)||raw.dimension!==name||typeof raw.status!=='string'||!clockOf(raw.updatedAt)||!plain(raw.provenance))return null;
 if(!Number.isInteger(raw.attempts)||typeof raw.nextAction!=='string')return null;
 return {
  dimension:name,status:raw.status,source:typeof raw.source==='string'?raw.source:null,sourceVersion:raw.sourceVersion??null,
  provenance:raw.provenance,value:raw.value??null,updatedAt:clockOf(raw.updatedAt),attempts:raw.attempts,nextAction:raw.nextAction,
  lastError:raw.lastError??null,failureReason:raw.failureReason??null,retryAt:raw.retryAt??null,
  ...(typeof raw.authority==='string'?{authority:raw.authority}:{}),
 };
}
export function filmFactsOf(film,watchlisted){
 // ADR 0203: `watchlisted === undefined` plans NO membership at all (the key is absent, not false): the Producer then never sets or clears `watchlist_film`.
 const facts={...(watchlisted===undefined?{}:{watchlist:watchlisted}),film:{contractVersion:1,canonicalIdentity:film?.canonicalIdentity||null,originalTitle:film?.original||film?.title||null}};
 const metadataAt=clockOf(film?.metadataAt);
 if(metadataAt)facts.metadata={schemaVersion:1,year:film.year??null,runtime:film.runtime??null,synopsis:film.synopsis??null,poster:film.poster??null,url:film.url??null,genres:Array.isArray(film.genres)?film.genres:[],peopleVersion:film.peopleVersion??null,payload:{},r2Key:null,contentSha256:null,updatedAt:metadataAt};
 const dimensions={};
 const identity=sealedDimension(film?.dimensions?.identity,'identity');
 const metadataDim=sealedDimension(film?.dimensions?.metadata,'metadata');
 if(identity)dimensions.identity=identity;
 if(metadataDim)dimensions.metadata=metadataDim;
 if(identity||metadataDim)facts.dimensions=dimensions;
 const sync={metadataAt,synopsisFetchedAt:clockOf(film?.synopsisFetchedAt),peopleNamesVersion:Number.isInteger(film?.peopleNamesVersion)?film.peopleNamesVersion:null,peopleLocalizedAt:clockOf(film?.peopleLocalizedAt)};
 if(sync.metadataAt||sync.synopsisFetchedAt||sync.peopleNamesVersion!=null||sync.peopleLocalizedAt)facts.sync=sync;
 return facts;
}
function sourceIdsOf(document,members){
 if(Array.isArray(members)&&members.length)return members.map(row=>String(row.filmId||'')).filter(Boolean);
 return (Array.isArray(document?.films)?document.films:[]).map(film=>String(film?.id||'')).filter(Boolean);
}
function idsOf(document,members,resolved){return sourceIdsOf(document,members).map(id=>canonicalFilmId(id,resolved)).filter(Boolean);}

// AIR-572. Identity resolution of the source film ids BEFORE any target is formed. An id with a `film:`/`tmdb_`/`tmdb:` prefix names its
// Film directly (a one-hop redirect is followed to the survivor). A bare Letterboxd lid is NEVER turned into `film:<lid>` by spelling: it is
// resolved through the one trusted, non-conflicting `film_external_id` (scheme `letterboxd`) claim, else through an EXISTING Film `film:<lid>`.
// A lid with a competing/untrusted claim, a redirect chain longer than one hop, or neither a claim nor an existing Film is refused by name:
// the Producer never creates a second Film from a spelling and never guesses from title or year (a legitimate new Film is admitted by the
// admission paths, not here). Reads are bounded: at most IDENTITY_LOOKUP_CAP distinct lids in IDENTITY_CHUNK-sized, read-only statements.
export const IDENTITY_LOOKUP_CAP=1000;
export const IDENTITY_CHUNK=200;
const DIRECT=/^(film:|tmdb_|tmdb:)/;
// ADR 0217 decision 8d (AIR-671). A TYPED MOVIE REFERENCE of a source (`tmdb_<n>`, `tmdb:<n>`) is an external claim, not a Film key: the Film that holds the movie id today is resolved from `film_external_id`, like a Letterboxd id. An explicit
// canonical Film id (`film:...`) is a permanent entity key and is never reinterpreted, whatever its spelling.
const MOVIE_REF=/^(?:tmdb_|tmdb:)([1-9]\d{0,11})$/;
export const movieOf=raw=>MOVIE_REF.exec(String(raw??''))?.[1]??null;
export function resolveIdentity(raw,{claims=[],films=new Set(),redirects=new Map()}={}){
 // `via` is the provenance of the decision; `guardsOf` turns it into write-time proofs.
 const follow=(id,via)=>{
  if(!redirects.has(id))return {target:id,via,owner:id};
  const next=redirects.get(id);
  return redirects.has(next)?{refused:'producer_identity_redirect_chain'}:{target:next,via,owner:id,redirected:true};
 };
  // A typed movie reference: the one trusted, non-conflicting `tmdb` claim names the Film (a LID-minted Film that was attached keeps its id and is the survivor); any other row of the movie id, of any trust, on any Film, holds the id
 // as ambiguous identity evidence and nothing is written. No row at all: the movie id is unclaimed and the target is its own minting spelling `film:tmdb:<n>`, whose absence of competing claims is asserted at the write.
 const movie=movieOf(raw);
 if(movie!==null){
  const rows=claims.filter(row=>Number(row.trusted)===1&&Number(row.conflicting)===0);
  const found=[...new Set(rows.map(row=>row.film_id))];
  if(found.length>1||(found.length===1&&claims.length>rows.length)||(found.length===0&&claims.length>0))return {refused:'producer_identity_ambiguous'};
  const decided=found.length===1?follow(found[0],'movie_claim'):follow('film:tmdb:'+movie,'movie_unclaimed');
  return decided.refused?decided:{...decided,movie};
 }
 if(DIRECT.test(raw))return follow(canonicalFilmId(raw),'direct');
 const clean=claims.filter(row=>Number(row.trusted)===1&&Number(row.conflicting)===0);
 const other=claims.length-clean.length;
 const owners=[...new Set(clean.map(row=>row.film_id))];
 if(owners.length>1||(owners.length===1&&other>0)||(owners.length===0&&other>0))return {refused:'producer_identity_ambiguous'};
 if(owners.length===1)return follow(owners[0],'claim');
 const own='film:'+raw;
 if(films.has(own))return follow(own,'own');
 return {refused:'producer_identity_unresolved'};
}
// AIR-572. The write-time proofs of one resolution, asserted INSIDE the fenced batch of every Film write to the target (film_facts and credits, replay
// included), so a claim or redirect that changes after the plan fails the batch whole and writes nothing:
//   claim: the owner still holds the lid as its one trusted, non-conflicting claim and no other Film claims the lid;
//   own:   no other Film claims the lid (the Film is addressed by its own name, never because a claim says so);
//   redirected: the redirect owner -> target still exists (the writer itself already asserts no redirect leaves the target).
// A direct (prefixed) id carries only the redirect proof when one was followed.
export function guardsOf(raw,decision){
 const out=[];
 if(!decision||!decision.target)return out;
 // A typed movie reference (ADR 0217 decision 8d): the exact owner proof, asserted INSIDE the fenced batch of every write to the target (replay included). `movie_claim`: the owner still holds the movie id as its one trusted,
 // non-conflicting claim and no other row of the movie id exists on any Film. `movie_unclaimed`: no Film other than the target (or the redirect owner it was followed from) holds any row of the movie id.
 if(decision.movie!==undefined){
  if(decision.via==='movie_claim'){
   out.push({sql:"EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0)",params:[decision.owner,decision.movie]});
   out.push({sql:"NOT EXISTS (SELECT 1 FROM film_external_id WHERE scheme='tmdb' AND value=? AND NOT (film_id=? AND trusted=1 AND conflicting=0))",params:[decision.movie,decision.owner]});
  }else out.push({sql:"NOT EXISTS (SELECT 1 FROM film_external_id WHERE scheme='tmdb' AND value=? AND film_id<>? AND film_id<>?)",params:[decision.movie,decision.owner,decision.target]});
  if(decision.redirected)out.push({sql:'EXISTS (SELECT 1 FROM film_redirect WHERE from_id=? AND to_film_id=?)',params:[decision.owner,decision.target]});
  return out;
 }
 if(decision.via==='claim')out.push({sql:"EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='letterboxd' AND value=? AND trusted=1 AND conflicting=0)",params:[decision.owner,raw]});
 if(decision.via==='claim'||decision.via==='own')out.push({sql:"NOT EXISTS (SELECT 1 FROM film_external_id WHERE scheme='letterboxd' AND value=? AND film_id<>? AND film_id<>?)",params:[raw,decision.owner,decision.target]});
 if(decision.redirected)out.push({sql:'EXISTS (SELECT 1 FROM film_redirect WHERE from_id=? AND to_film_id=?)',params:[decision.owner,decision.target]});
 return out;
}
export async function resolveSourceIdentities(env,rawIds){
 const all=await resolveSourceIdentitiesEach(env,rawIds);
 if(!all.ok)return all;
 const {resolved,guards,refused}=all;
 if(refused.length){
  const code=refused.some(item=>item.code==='producer_identity_ambiguous')?'producer_identity_ambiguous':refused[0].code;
  return {ok:false,code,refused:refused.slice(0,20),refusedCount:refused.length};
 }
 return {ok:true,resolved,guards};
}
// ADR 0203 (AIR-582): the same bounded, read-only resolution, but a refused id does NOT fail the rest: every id is answered on its own (`byId`: {target,guards} or {refused}). The membership projection needs this, because one
// unresolvable Letterboxd id must never hold the other films of a version. Same reads, same decisions and the same write-time proofs as `resolveSourceIdentities`.
export async function resolveSourceIdentitiesEach(env,rawIds){
 const unique=[...new Set(rawIds.filter(Boolean))];
 const lids=unique.filter(id=>!DIRECT.test(id));
 const movies=unique.filter(id=>movieOf(id)!==null);
 if(lids.length+movies.length>IDENTITY_LOOKUP_CAP)return {ok:false,code:'producer_identity_bounded'};
 const claims=new Map(),films=new Set(),redirects=new Map();
 const db=database(env);
 try{
  // The typed movie references: ALL rows of each movie id, of any trust (the resolution must see an untrusted or conflicting claim, not ignore it). One statement per chunk.
  for(let i=0;i<movies.length;i+=IDENTITY_CHUNK){
   const chunk=JSON.stringify([...new Set(movies.slice(i,i+IDENTITY_CHUNK).map(movieOf))]);
   const byMovie=new Map();
   for(const row of await many(db,"SELECT film_id,value,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value IN (SELECT value FROM json_each(?))",[chunk])){
    if(!byMovie.has(row.value))byMovie.set(row.value,[]);
    byMovie.get(row.value).push(row);
   }
   for(const id of movies.slice(i,i+IDENTITY_CHUNK))claims.set(id,byMovie.get(movieOf(id))||[]);
  }
  for(let i=0;i<lids.length;i+=IDENTITY_CHUNK){
   const chunk=JSON.stringify(lids.slice(i,i+IDENTITY_CHUNK));
   for(const row of await many(db,"SELECT film_id,value,trusted,conflicting FROM film_external_id WHERE scheme='letterboxd' AND value IN (SELECT value FROM json_each(?))",[chunk])){
    if(!claims.has(row.value))claims.set(row.value,[]);
    claims.get(row.value).push(row);
   }
   for(const row of await many(db,"SELECT id FROM film WHERE id IN (SELECT 'film:'||value FROM json_each(?))",[chunk]))films.add(row.id);
  }
  const targets=new Set();
  for(const id of unique){
   if(movieOf(id)!==null){targets.add('film:tmdb:'+movieOf(id));for(const row of claims.get(id)||[])targets.add(row.film_id);}
   else if(DIRECT.test(id))targets.add(canonicalFilmId(id));
   else for(const row of claims.get(id)||[])targets.add(row.film_id);
  }
  for(const id of lids)targets.add('film:'+id);
  const list=[...targets];
  for(let i=0;i<list.length;i+=IDENTITY_CHUNK){
   const chunk=JSON.stringify(list.slice(i,i+IDENTITY_CHUNK));
   for(const row of await many(db,"SELECT from_id,to_film_id FROM film_redirect WHERE from_id IN (SELECT value FROM json_each(?))",[chunk]))redirects.set(row.from_id,row.to_film_id);
  }
 }catch{return {ok:false,code:'producer_identity_unreadable'};}
 const resolved=new Map(),refused=[],guards=new Map(),byId=new Map();
 for(const id of unique){
  const out=resolveIdentity(id,{claims:claims.get(id)||[],films,redirects});
  if(out.target){resolved.set(id,out.target);const g=guardsOf(id,out);byId.set(id,{target:out.target,guards:g});if(g.length){if(!guards.has(out.target))guards.set(out.target,[]);guards.get(out.target).push(...g);}}
  else{refused.push({id,code:out.refused});byId.set(id,{refused:out.refused});}
 }
 return {ok:true,resolved,guards,refused,byId};
}
function peopleOf(film){
 const out=[];
 for(const [role,list] of [['director',film?.directors],['actor',film?.actors]]){
  if(!Array.isArray(list))continue;
  for(const person of list){
   const id=canonicalPersonId(person?.id);
   if(!id)continue;
   out.push({id,role,name:typeof person?.name==='string'?person.name:null,original:typeof person?.original==='string'?person.original:null});
  }
 }
 return out;
}
function uniqueGuards(list=[]){
 const seen=new Set(),out=[];
 for(const guard of list){const key=JSON.stringify(guard);if(!seen.has(key)){seen.add(key);out.push(guard);}}
 return out;
}
function planFromSealed({programme,watchlist,watchMembers,previousIds=[],resolved,guards=new Map(),membershipOwned=false}){
 const listed=idsOf(watchlist,watchMembers,resolved);
 const byFilm=new Map();
 for(const film of [...(programme?.films||[]),...(watchlist?.films||[])]){
  const id=canonicalFilmId(film?.id,resolved);
  if(id&&!byFilm.has(id))byFilm.set(id,film);
 }
 const seen=new Set(),films=[];
 for(const id of listed){
  if(seen.has(id))continue;
  seen.add(id);
  const proofs=uniqueGuards(guards.get(id));
  films.push({id,facts:{...filmFactsOf(byFilm.get(id)||{id},membershipOwned?undefined:true),...(proofs.length?{guards:proofs}:{})}});
 }
 const listedSet=new Set(listed);
 // Under the Letterboxd Sync membership projection (ADR 0203) the Producer releases nothing: removal is the Sync's `membership` effect, never a diff of the EPG copy.
 const departed=membershipOwned?[]:[...new Set(previousIds.map(id=>canonicalFilmId(id)).filter(id=>id&&!listedSet.has(id)))].sort();
 const personRows=[],persons=[],credits=[],personSeen=new Set();
 for(const item of films){
  const people=peopleOf(byFilm.get(item.id)||{});
  if(!people.length)continue;
  const unitCredits=[];
  for(const person of people){
   if(!personSeen.has(person.id)){
    personSeen.add(person.id);
    const bare=person.id.slice('person:'.length);
    personRows.push({id:person.id,roleId:bare.includes('/')?bare:person.role+'/'+bare,contractVersion:1});
   }
   unitCredits.push({personId:person.id,role:person.role});
  }
  if(unitCredits.length)credits.push({filmId:item.id,credits:unitCredits,...(item.facts.guards?{guards:item.facts.guards}:{})});
 }
 return {films,departed,persons,credits,personRows};
}

// The membership marker of schema 37: 'producer' (legacy, also when the table is absent) or 'sync'. Read only. Throws on a storage failure other than an absent table.
export async function readMembershipMode(env){
 try{
  const row=await one(database(env),'SELECT mode FROM watchlist_membership_authority WHERE id=1');
  if(!row||(row.mode!=='producer'&&row.mode!=='sync'))throw Object.assign(new Error('membership_marker_invalid'),{code:'membership_marker_invalid'});
  return row.mode;
 }catch(error){
  if(/no such table/i.test(String(error?.cause?.message||error?.message||error)))return 'producer';
  throw error;
 }
}
export async function acquireSealedSnapshot(env,programmeRunId,{previousIds}={}){
 const before=await readPublished(env);
 if(!before?.ready||before.programmeRunId!==programmeRunId)return {ok:false,code:'producer_generation_superseded'};
 const g0=Number(before.generation);
 const programme=await readDocument(env,programmeRunId,'programme');
 const watchlist=await readDocument(env,programmeRunId,'watchlist');
 const members=await readMembers(env,programmeRunId,'watchlist');
 // ADR 0203: who owns membership is read ONCE per snapshot from the marker (schema 37). An absent table is the legacy state; any other read failure fails the snapshot closed, never "legacy".
 let membershipOwned=false;
 try{membershipOwned=(await readMembershipMode(env))==='sync';}catch{return {ok:false,code:'producer_membership_marker_unreadable'};}
 let prior=previousIds;
 if(!membershipOwned&&!Array.isArray(prior)){
  try{prior=(await many(database(env),'SELECT film_id AS filmId FROM watchlist_film',[])).map(row=>row.filmId);}
  catch{return {ok:false,code:'producer_membership_unreadable'};}
 }
 const after=await readPublished(env);
 if(!after?.ready||after.programmeRunId!==programmeRunId||Number(after.generation)!==g0)return {ok:false,code:'producer_input_superseded'};
 // Identity is resolved for the LISTED ids only (programme-only films never become a target); a refusal fails the whole snapshot closed,
 // so a refused id is never silently dropped and then mistaken for a departed Film.
 const identity=await resolveSourceIdentities(env,[...new Set([...sourceIdsOf(watchlist,members)])]);
 if(!identity.ok)return {ok:false,code:identity.code,refused:identity.refused,refusedCount:identity.refusedCount};
 const planned=planFromSealed({programme,watchlist,watchMembers:members,previousIds:prior,resolved:identity.resolved,guards:identity.guards,membershipOwned});
 return {ok:true,generation:g0,programmeRunId,...planned,label:snapshotLabel(programmeRunId,g0),members,watchlist};
}

async function createInstance(env,id,params){
 const binding=env.PRODUCER_WORKFLOW;
 if(!binding||typeof binding.create!=='function')return {ok:false,reason:'workflow_unavailable'};
 for(let attempt=0;attempt<CHAIN_CREATE_ATTEMPTS;attempt++){
  try{await binding.create({id,params});return {ok:true,reason:'started'};}
  catch(error){
   if(createError(error)==='exists')return {ok:true,reason:'attached'};
  }
 }
 return {ok:false,reason:'create_uncertain'};
}

// AIR-572. The Monitor's whole D1 read of the Producer: exactly THREE SQL statements (one authority row joined by primary key to its generation row,
// the chain by primary key, the run of the exact generation by index), no table inventory, no schema read, no scan, no write. Unlike
// `PublishedEpg.readAuthority` (three statements on its own) it does not validate the install; it only names the published (P,g) when the marker row says
// `d1`/`open`. Any failure throws (the Monitor reports `unreadable`).
export async function readProducerMonitorFacts(env){
 const db=database(env);
 const row=await one(db,'SELECT a.mode AS mode,a.cutover AS cutover,a.programme_run_id AS programmeRunId,a.generation AS generation,g.published_at AS publishedAt FROM published_epg_authority a LEFT JOIN published_epg_generation g ON g.programme_run_id=a.programme_run_id WHERE a.id=1',[]);
 if(!row||row.mode!=='d1'||row.cutover!=='open'||!row.programmeRunId)return {ready:false};
 const label=snapshotLabel(row.programmeRunId,Number(row.generation));
 const [chain,run]=await Promise.all([readChain(env,row.programmeRunId),epgRunForGeneration(env,{sourceGeneration:label})]);
 return {ready:true,programmeRunId:row.programmeRunId,generation:Number(row.generation),label,publishedAt:row.publishedAt||null,chain,run};
}

// AIR-594 / ADR 0208 (Accepted, option B). The outcome rows are written by the terminal batches themselves (stop, completion, and here the in-flight supersede and the
// fenced `held`). The reconcile probes the schema ONCE per tick: `absent` (proven) is today's behaviour; an unreadable or inconsistent schema never falls back to writing
// no outcome: the tick then supersedes no in-flight chain, records no `held` and drains nothing (it reports `outcomes` with the code), and the next tick tries again.
// The drain of pending rows to the R2 Events Log runs last; R2 never blocks or fails the Producer.
const producerEventLog=line=>{try{console.log(JSON.stringify(line));}catch{/* a log line is never part of the reconcile */}};

export async function reconcileProducerChain(env,{now=Date.now(),hold=PRODUCER_DELIVERY_HOLD}={}){
 if(hold!==false)return {ran:false,reason:HELD_BY_DELIVERY};
 let outcomes=null,drained=null;
 try{
  if(typeof env?.PRODUCER_WORKFLOW?.create!=='function')return {ran:false,reason:'workflow_unavailable'};
  let marker;
  try{marker=await readAuthority(env);}catch{return {ran:false,reason:'marker_unreadable'};}
  if(marker.state!=='open')return {ran:false,reason:'dormant',marker:marker.state};
  let published;
  try{published=await readPublished(env);}catch{return {ran:false,reason:'authority_unreadable'};}
  if(!published?.ready||!published.programmeRunId)return {ran:false,reason:'epg_not_open'};
  const P=published.programmeRunId,g=Number(published.generation),at=iso(now);
  const counts={launched:0,takeover:0,relaunch:0,reopen:0,recover:0,supersede:0,skipped:0};
  const chain=await readChain(env,P).catch(()=>null);
  const passed=await epgRunForGeneration(env,{sourceGeneration:snapshotLabel(P,g)}).catch(()=>null);
  const rows=await listNonterminalChains(env).catch(()=>[]);
  try{outcomes=await readOutcomeSchema(env);}catch(error){outcomes=error?.code||'producer_outcome_schema_unreadable';}
  const active=outcomes==='active',known=outcomes==='active'||outcomes==='absent';
  for(const row of rows){
   if(row.programme_run_id===P)continue;
   // An in-flight chain's supersede must carry its outcome row; without a proven schema it waits for a tick that can write it.
   if(!known&&['pending','active','released'].includes(row.owner_state)){counts.skipped++;continue;}
   try{await supersedeChain(env,{chain:row,at,outcome:active});counts.supersede++;}catch{counts.skipped++;}
  }
  // ADR 0208 decision 3: the reconcile held an eligible stop at the current revision; the row is fenced and written once.
  const held=async row=>{
   if(!active)return;
   try{const out=await recordHeldOutcome(env,{chain:row,at});if(out.state==='recorded')counts.held=(counts.held||0)+1;}
   catch(error){producerEventLog({event:'canonical_producer_held_failed',code:String(error?.code||'error').slice(0,60)});}
  };
  const start=async(result)=>{
   if(!result||result.state==='skipped'||result.state==='skip'||result.state==='live'||result.state==='wait'||result.state==='held')return;
   const id=result.instanceId||producerInstanceId(P,result.epoch);
   await createInstance(env,id,{programmeRunId:P,epoch:result.epoch});
  };
  if(!chain){
   if(passed?.pass_state==='passed')return {ran:true,reason:'already_current',...counts,outcomes};
   const launched=await launchChain(env,{programmeRunId:P,generation:g,at,nowMs:now});
   if(launched.state==='launched'||launched.state==='exists'){
    counts.launched++;
    await createInstance(env,launched.instanceId||producerInstanceId(P,launched.chain?.owner_epoch||1),{programmeRunId:P,epoch:launched.epoch||launched.chain?.owner_epoch||1});
   }
   return {ran:true,reason:'launch',...counts,outcomes};
  }
  const expired=Date.parse(chain.lease_expires_at)+CHAIN_BOUNDARY_MARGIN_MS<now;
  if((chain.owner_state==='pending'||chain.owner_state==='active')&&expired){
   const t=await takeoverChain(env,{chain,generation:g,at,nowMs:now});counts.takeover++;await start(t);
  }else if(chain.owner_state==='released'){
   const t=await relaunchChain(env,{chain,generation:g,at,nowMs:now});counts.relaunch++;await start(t);
  }else if(chain.owner_state==='complete'||chain.owner_state==='stopped'){
   const quiet=chain.updated_at&&(now-Date.parse(chain.updated_at)>=CHAIN_QUIET_MS);
   if(chain.owner_state==='stopped'&&(chain.recovery_class==='transient'||chain.recovery_class==='receipt'||chain.recovery_class==='authority')){
    const t=await recoverChain(env,{chain,generation:g,at,nowMs:now});if(t.state==='pending'){counts.recover++;await start(t);}
    if(t.state==='held')await held(chain);
   }else{
    const t=await reopenChain(env,{chain,generation:g,at,nowMs:now,quiet});if(t.state==='pending'){counts.reopen++;await start(t);}
    if(t.state==='held'&&chain.owner_state==='stopped')await held(chain);
   }
  }
  return {ran:true,reason:'reconciled',...counts,outcomes};
 }catch(error){
  return {ran:false,reason:error?.code||'error'};
 }finally{
  // After every decision of the tick: deliver at most OUTCOME_DRAIN_MAX pending outcome rows to the Events Log. A failure here changes nothing above.
  if(outcomes==='active'){
   try{drained=await drainOutcomes(env,{nowMs:now});}catch(error){drained={failed:true,code:String(error?.code||'error').slice(0,60)};}
   if(drained&&(drained.taken||drained.failed===true))producerEventLog({event:'canonical_producer_outcomes',...drained});
  }else if(outcomes&&outcomes!=='absent')producerEventLog({event:'canonical_producer_outcomes',schema:String(outcomes).slice(0,60)});
 }
}

const RECEIPT_PAGE=10;
const RECEIPT_PAGES=20;
function receiptsBlockCompletion(summary){
 if(!summary||summary.skipped===true)return true;
 return (summary.failed||[]).length>0||(summary.waiting||[]).length>0||(summary.needsReview||[]).length>0;
}
// The receipt reconcile of ADR 0141 T-10 inside the instance budget (AIR-572): each page is admitted first, at the receipt ceiling per receipt, and is cut to what the budget
// still holds (at least one receipt, at most RECEIPT_PAGE). A page the budget cannot hold ends the drain with {yield:true}: nothing is claimed and the next instance resumes.
async function drainEpgReceipts(env,plan,fence,admit=()=>true,progress=()=>{}){
 if(!plan?.personPlan||!plan?.filmPlan)throw Object.assign(new Error('receipt_state_conflict'),{code:'receipt_state_conflict'});
 const scoped={...env,producerFence:fence};
 for(let page=0;page<RECEIPT_PAGES;page++){
  let limit=RECEIPT_PAGE;
  while(limit>0&&!admit('receipt',{count:limit}))limit--;
  if(limit<1)return {yield:true};
  const summary=await reconcileEpgRun(scoped,{plan:plan.personPlan,filmPlan:plan.filmPlan,limit});
  if(!summary||summary.skipped===true||receiptsBlockCompletion(summary)){
   const error=Object.assign(new Error('receipt_state_conflict'),{code:'receipt_state_conflict'});
   throw error;
  }
  // Acknowledged progress: the reconcile answered and settled at least one receipt.
  if((summary.considered||0)>0)progress();
  if((summary.considered||0)<limit){
   let open=[];
   try{
    open=await many(database(scoped),"SELECT request_id FROM canonical_write_receipt WHERE origin='epg' AND state IN ('pending','failed','unknown') LIMIT 1",[]);
   }catch{throw Object.assign(new Error('receipt_state_conflict'),{code:'receipt_state_conflict'});}
   if(open.length)throw Object.assign(new Error('receipt_state_conflict'),{code:'receipt_state_conflict'});
   return summary;
  }
 }
 throw Object.assign(new Error('receipt_state_conflict'),{code:'receipt_state_conflict'});
}

// Options for tests only (production passes none): `limitCalls` narrows the instance limit to exercise the budget boundaries, `observe(op, detail, spent)` sees every admitted operation.
export async function runProducerWorkflow(env,payload,step,{hold=PRODUCER_DELIVERY_HOLD,limitCalls,observe}={}){
 if(hold!==false)return {state:HELD_BY_DELIVERY};
 const P=payload?.programmeRunId,epoch=Number(payload?.epoch);
 if(typeof P!=='string'||!P||!Number.isInteger(epoch)||epoch<1)return {state:'invalid'};
 // AIR-572: `step` is a Cloudflare RPC stub. Its methods are callable but expose no `.bind`/`.call`/`.apply`, so the method is
 // invoked directly on the stub (`step.do(...)`), never detached or bound. Without a step (an offline run) the callback runs inline.
 const doStep=(name,fn)=>step&&step.do?step.do(name,fn):fn();
 // ADR 0141 D5 (AIR-572): ONE meter for the whole instance, from its first read through the claim, every invocation and the end path. Every Producer operation is admitted
 // first at its a-priori ceiling with the end reserve kept (`admitOperation`), so the instance never leaves its headroom and always has room to stop or hand over.
 const instance={calls:0,statements:0,batches:0};
 const ienv=meteredEnv(env,instance);
 const totals={calls:0,statements:0,invocations:0,maxCalls:0,maxStatements:0,admitted:0,progressed:false};
 const admit=(op,detail)=>{
  const cost=op==='receipt'?operationCost('receipt')*Math.max(1,Number(detail?.count)||1):operationCost(op,detail);
  const ok=admitOperation({spentCalls:instance.calls,spentStatements:instance.statements,cost,...(Number.isFinite(limitCalls)?{limitCalls}:{})});
  if(ok){
   totals.admitted++;
   if(typeof observe==='function')observe(op,detail,{calls:instance.calls,statements:instance.statements});
  }
  return ok;
 };
 const nonce=await doStep('nonce',async()=>crypto.randomUUID());
 let chain=await readChain(ienv,P);
 if(!chain||chain.owner_epoch!==epoch)return {state:'not_owner'};
 let published=await readPublished(ienv);
 if(!published?.ready||published.programmeRunId!==P)return {state:'producer_generation_superseded'};
 const claimed=await doStep('claim',async()=>claimChain(ienv,{programmeRunId:P,epoch,instanceId:producerInstanceId(P,epoch),nonce,generation:Number(published.generation),revision:chain.revision,at:new Date().toISOString(),nowMs:Date.now()}));
 if(claimed.state!=='owned')return {state:'not_owner'};
 chain=claimed.chain;
 // ADR 0208 (AIR-594): ONE schema probe per invocation, metered like every other read, before any work. `active` makes every terminal batch of this instance append its
 // outcome row; a proven `absent` schema writes none (today's batches). An unreadable probe writes nothing at all and returns: the claimed lease lapses and the hourly
 // reconcile takes the chain over (the fenced recovery of any failed terminal batch). An inconsistent schema stops the chain on the record (fail_closed), without an outcome row.
 let outcomes;
 try{outcomes=await readOutcomeSchema(ienv);}catch(error){outcomes=error?.code||'producer_outcome_schema_unreadable';}
 let fence={kind:'chain',programmeRunId:P,epoch,nonce,inputGeneration:Number(chain.input_generation),revision:chain.revision,outcomes:outcomes==='active'};
 if(outcomes==='producer_outcome_schema_unreadable')return {state:'error',code:outcomes};
 if(outcomes!=='active'&&outcomes!=='absent'){
  await stopChain({...ienv,producerFence:fence},{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:'producer_outcome_schema_invalid'}).catch(()=>{});
  return {state:'stopped',code:'producer_outcome_schema_invalid'};
 }
 let rebases=0;
 // Replay safety (ADR 0141 D5, AIR-572). The meter lives in this execution only, so a `work` step that runs a SECOND time for the same epoch (a step retry, or an instance
 // replayed with the cached nonce and claim and fresh memory) cannot know what the failed attempt spent or which revision it reached. Such a re-entry never runs the expensive
 // work: it re-reads the chain, refreshes the fence ONLY under the exact owner proof (epoch, nonce, active, same programme run) and stops the chain `producer_work_replayed`
 // (transient), so the existing hourly `recoverChain` relaunches it into a NEW epoch with a fresh budget after its backoff. A re-entry is recognised by the entry marker,
 // in fresh or in the same memory: the first write of every work step renews the lease (`markWorkEntered`), so a chain revision past the claim's proves an earlier attempt. Without that write a failed attempt can only have spent the entry reads, which the first entry charges up front (`CHAIN_COST.entry`). Total per instance: the
 // failed attempt stayed inside its admissions (spent + ceiling + end reserve within the cap), and the re-entry spends at most the end reserve.
 const claimRevision=Number(chain.revision);
 const replayed=async scoped=>{
  const row=await readChain(scoped,P);
  if(!row||row.owner_epoch!==epoch||row.claim_nonce!==nonce||row.owner_state!=='active')return {state:'not_owner',replayed:true};
  fence.revision=Number(row.revision);fence.inputGeneration=Number(row.input_generation);
  await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:'producer_work_replayed'});
  return {state:'stopped',code:'producer_work_replayed'};
 };
 const enter=async()=>{
  const scoped={...ienv,producerFence:fence};
  const row=await readChain(scoped,P);
  if(row&&row.owner_epoch===epoch&&row.claim_nonce===nonce&&Number(row.revision)!==claimRevision)return replayed(scoped);
  instance.calls+=operationCost('entry');instance.statements+=operationCost('entry');
  await markWorkEntered(scoped,{fence,at:new Date().toISOString()});
  return null;
 };
 // The budget ran out at a durable boundary. An instance that made NO durable progress (no unit, sweep settle, completion or reconciled receipt) cannot progress in any instance:
 // its fixed part plus one operation and the end reserve exceed the headroom. That is `producer_budget_infeasible` (fail_closed). Otherwise the successor resumes at the cursor.
 // A hand-off the epoch cap refuses writes nothing in `handoffChain`; the chain is then STOPPED on the record (`producer_chain_epoch_cap`, fail_closed, visible to the monitor)
 // instead of answering a hand-off without a successor and leaving an active chain to a lapsing lease.
 const handOver=async(scoped,reason)=>{
  const hand=await handoffChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),nowMs:Date.now()});
  if(hand.state==='handed_off'){
   await createInstance(env,hand.instanceId,{programmeRunId:P,epoch:hand.epoch});
   return {state:'handoff',epoch:hand.epoch,...(reason?{reason}:{})};
  }
  if(hand.state==='stopped'){
   await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:hand.code});
   return {state:'stopped',code:hand.code};
  }
  return {state:'dormant'};
 };
 const yieldBudget=async scoped=>{
  if(!totals.progressed){
   await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:'producer_budget_infeasible'});
   return {state:'stopped',code:'producer_budget_infeasible'};
  }
  return handOver(scoped,'budget');
 };
 const work=async()=>{
  const meter={calls:0,statements:0,batches:0};
  const scoped=meteredEnv({...ienv,producerFence:fence},meter);
  if(!admit('invocation'))return yieldBudget(scoped);
  const stored=await readChain(scoped,P);
  const pinned=parseReleasePin(stored?.release_pin);
  const snap=await acquireSealedSnapshot(scoped,P,stored?.release_pin?{previousIds:pinned}:{});
  if(!snap.ok){
   if(snap.code==='producer_input_superseded'||snap.code==='producer_generation_superseded'){
    if(rebases>=CHAIN_REBASE_CAP){await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:'producer_input_unstable'});return {state:'stopped',code:'producer_input_unstable'};}
    published=await readPublished(ienv);
    const rebased=await rebaseChain(ienv,{fence,revision:fence.revision,generation:Number(published.generation),at:new Date().toISOString()});
    if(rebased.state==='rebased'){fence=rebased.fence;rebases++;return work();}
    return {state:'stopped',code:'producer_input_superseded'};
   }
   // A named identity refusal stops the chain on the record (visible to the monitor) instead of leaving a lease to expire.
   if(typeof snap.code==='string'&&snap.code.startsWith('producer_identity_'))await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:snap.code}).catch(()=>{});
   return {state:'stopped',code:snap.code,...(snap.refused?{refused:snap.refused,refusedCount:snap.refusedCount}:{})};
  }
  fence.inputGeneration=snap.generation;
  if(!stored?.release_pin){
   // `pinChainReleases` advances `fence.revision` IN PLACE. The fence must stay the SAME object that `scoped.producerFence` holds: every slice commit renews the lease through that object
   // and moves its revision, so a copy made here would fall behind and the later stop or hand-off would lose its revision CAS (production 24 Nov 2026, epoch 1: `producer_cas_lost`).
   const pinnedAt=await pinChainReleases(scoped,{fence,revision:fence.revision,departed:snap.departed,at:new Date().toISOString()});
   if(pinnedAt.chain)chain=pinnedAt.chain;
  }
  const at=new Date().toISOString();
  const passParams={
   runId:snap.label,sourceGeneration:snap.label,at,films:snap.films,departed:snap.departed,
   persons:snap.persons,credits:snap.credits,personRows:snap.personRows,
   sliceSize:CHAIN_SLICE_SIZE,maxSlicesPerRun:CHAIN_MAX_SLICES,sliceDeadlineMs:CHAIN_SLICE_DEADLINE_MS,
   prerequisites:async()=>({}),generationOrder,inputProvenance:{complete:true,committed:true,sealed:true,publishedGeneration:snap.label},
  };
  const plan=await buildEpgPlan(scoped,passParams);
  let drained;
  const reconciled=()=>{totals.progressed=true;};
  try{drained=await drainEpgReceipts(scoped,plan,fence,admit,reconciled);}
  catch(error){
   const code=error?.code||'receipt_state_conflict';
   await stopChain(scoped,{fence,revision:fence.revision,at,stoppedBy:code}).catch(()=>{});
   return {state:'stopped',code};
  }
  if(drained?.yield===true){totals.invocations++;return yieldBudget(scoped);}
  const pass=await runEpgProducerPass(scoped,{
   ...passParams,
   admit,
   // Durable progress is ACKNOWLEDGED progress: a committed slice, a committed settle, a committed completion (the driver calls this after each commit succeeded).
   onDurable:reconciled,
   beforePassComplete:async()=>{
    const done=await drainEpgReceipts(scoped,plan,fence,admit,reconciled);
    return done?.yield===true?{yield:true}:undefined;
   },
  });
  totals.invocations++;totals.calls+=meter.calls;totals.statements+=meter.statements;
  totals.maxCalls=Math.max(totals.maxCalls,meter.calls);totals.maxStatements=Math.max(totals.maxStatements,meter.statements);
  if(pass.state==='already_complete'){
   const row=await readChain(scoped,P);
   if(row?.owner_state==='complete')return {state:'complete',pass};
   try{await completeChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString()});}
   catch(error){
    const code=error?.code||'producer_not_owner';
    await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:code}).catch(()=>{});
    return {state:'stopped',code,pass};
   }
   return {state:'complete',pass};
  }
  if(pass.state==='complete')return {state:'complete',pass};
  if(pass.state==='skipped')return {state:'dormant',pass};
  if(pass.state==='stopped'||pass.state==='error'){
   await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:pass.code||'unclassified'}).catch(()=>{});
   return {state:'stopped',code:pass.code,pass};
  }
  if(pass.state==='partial'&&(pass.reason==='budget'||pass.detail==='budget'))return yieldBudget(scoped);
  const decision=successorDecision({spentCalls:instance.calls,spentStatements:instance.statements,estimateCalls:totals.maxCalls||CHAIN_FLOOR_D1_CALLS,estimateStatements:totals.maxStatements||CHAIN_FLOOR_D1_STATEMENTS,...(Number.isFinite(limitCalls)?{limitCalls}:{})});
  if(decision.reason==='producer_budget_infeasible'){
   await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:'producer_budget_infeasible'});
   return {state:'stopped',code:'producer_budget_infeasible'};
  }
  if(!decision.continue)return handOver(scoped);
  return work();
 };
 const result=await doStep('work',async()=>(await enter())||work());
 if(typeof observe==='function')observe('end',null,{calls:instance.calls,statements:instance.statements});
 return result;
}

export async function retryEpgProducerResultsFenced(env,params){
 const published=await readPublished(env);
 if(!published?.ready)return {state:'error',code:'producer_generation_superseded'};
 const fence={kind:'retry',programmeRunId:published.programmeRunId,inputGeneration:Number(published.generation)};
 requireFence(fence,['retry']);
 return retryEpgProducerResults({...env,producerFence:fence},{...params,sourceGeneration:snapshotLabel(published.programmeRunId,published.generation)});
}

export {readCanonicalFreshness,CHAIN_LEASE_MS,CHAIN_BOUNDARY_MARGIN_MS};
