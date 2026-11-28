// AIR-646 / ADR 0216 (Accepted) decisions 2, 3, 4 and 7, delivery graph step 2. The read-only typed Film resolver of the future FilmAggregateV1 route,
// with the coherent identity read-set and the reserved final identity fence. Dormant: nothing in the Worker imports this module (it is not bundled and no
// route calls it). It only reads D1: no write, no repair, no R2, no network. catalogFilmIdentityBridge, POST /api/started, recovery and the public permalink
// rules are unchanged; this is a separate function.
//
// Coherent capture (ADR 0216 decision 3), the chosen form: BOUNDED ROUNDS WITH FULL KEYED REVALIDATION, where every round is ONE SQL statement.
// - The read-set is a key set {films, pairs, movies}: the Film ids met (their film row, redirect row, canonical_revision and every external claim they hold), the typed
//   (scheme, value) pairs queried (every film_external_id row of the pair, of any trust and any Film) and every requested or claimed TMDB movie id, read in the
//   owner's retirement ledger (which retires a movie id whatever Film it names). IDENTITY_SNAPSHOT_SQL reads ALL of it, and the Film/Person marker, in one statement, so the rows of one
//   round are one consistent SQLite snapshot (a D1 batch could not do this: its statements are bound before it runs).
// - A round evaluates its snapshot with the pure function `evaluate`. When the evaluation needs a key the snapshot did not read (the owner, the next redirect
//   hop, the survivor's claims, the competing rows of those values), the keys are added and the next round re-reads the WHOLE grown key set. Rounds only discover.
// - The answer is taken only from a round whose snapshot was complete for every key the evaluation needed: that last round is the full keyed capture of the
//   read-set, absence predicates included (a queried pair with no row, a Film with no redirect row, a movie id with no retirement decision are part of the digest
//   as explicit zero counts). An earlier round never contributes a row to the answer.
// - The final fence (decision 4) runs the SAME statement over the SAME key set after every section read and compares the digest. Its statement is reserved from
//   the request budget before any section read. A different digest, a moved marker, or a fence that cannot run is 503 with no section.
import {sha256Hex} from './sha256-sync.js';
import {database,many,readAuthority} from './film-person-authority.js';

export const FILM_AGGREGATE_CONTRACT='film-aggregate/v1';
// ADR 0216 decision 7. Identity rows read in steps 0-5, per request.
export const IDENTITY_MAX_CLAIM_ROWS=64;
export const IDENTITY_MAX_REDIRECT_HOPS=8;
export const IDENTITY_MAX_FILMS=16;
export const AUTHORIZED_ALIASES_PER_SCHEME=8;
export const REQUEST_STATEMENT_BUDGET=40;
// Rounds of the identity capture: request keys, owner, chain hops (at most IDENTITY_MAX_REDIRECT_HOPS), survivor claims, competing rows, closure.
export const IDENTITY_MAX_ROUNDS=IDENTITY_MAX_REDIRECT_HOPS+5;
// The final fence is one statement.
export const IDENTITY_FENCE_STATEMENTS=1;

// Typed input grammar (decision 2). A D1 scheme of film_external_id per typed external scheme; tmdb_movie and tmdb_tv never share a lookup.
const DB_SCHEME={tmdb_movie:'tmdb',tmdb_tv:'tmdb_tv',letterboxd_lid:'letterboxd'};
// The schemes a section reads (decision 5). An unsettled claim of another scheme (letterboxd_slug, ...) is reported and does not fail the request.
const SECTION_SCHEMES=new Set(['tmdb','tmdb_tv','letterboxd']);
const ALIAS_SCHEME={tmdb:'tmdb_movie',tmdb_tv:'tmdb_tv',letterboxd:'letterboxd_lid'};
const MOVIE=/^tmdb_([1-9]\d{0,11})$/,TV=/^tmdb_tv:([1-9]\d{0,11})$/,LID=/^[A-Za-z0-9_-]{1,80}$/,FILM=/^film:[\x21-\x7e]{1,200}$/;

export class FilmAggregateInvalid extends Error{constructor(){super('invalid');this.code='invalid';}}

// One typed id {scheme, value}, or FilmAggregateInvalid (400). The tmdb_ prefix is checked first: a string that starts with it and is not a movie or TV
// spelling is invalid, never a lid. A title, year, slug or letterboxd_slug value is never an input: it matches no row of the grammar or is looked up as a lid only.
export function parseTypedFilmId(input){
 if(typeof input!=='string')throw new FilmAggregateInvalid();
 if(input.startsWith('tmdb_tv:')){const m=TV.exec(input);if(!m)throw new FilmAggregateInvalid();return {scheme:'tmdb_tv',value:m[1]};}
 if(input.startsWith('tmdb_')){const m=MOVIE.exec(input);if(!m)throw new FilmAggregateInvalid();return {scheme:'tmdb_movie',value:m[1]};}
 if(input.startsWith('film:')){if(!FILM.test(input))throw new FilmAggregateInvalid();return {scheme:'film',value:input};}
 if(LID.test(input))return {scheme:'letterboxd_lid',value:input};
 throw new FilmAggregateInvalid();
}

// The request's statement budget (decision 7): the final identity fence is reserved first, so no section read can consume it.
export function createStatementBudget(limit=REQUEST_STATEMENT_BUDGET){
 let used=0,reserved=0;
 return {
  get limit(){return limit;},get used(){return used;},get reserved(){return reserved;},
  get available(){return limit-used-reserved;},
  reserve(n){if(limit-used-reserved<n)return false;reserved+=n;return true;},
  // Spends n free statements; false (nothing spent) when they are not available.
  take(n=1){if(limit-used-reserved<n)return false;used+=n;return true;},
  // Spends n statements of the reservation.
  redeem(n){if(reserved<n)return false;reserved-=n;used+=n;return true;},
  // Returns n reserved statements that will not be spent (AIR-647: a section that did not read gives back its after-statement).
  release(n){if(reserved<n)return false;reserved-=n;return true;},
 };
}

// One statement: the marker and every row of the key set. Each column is one JSON array, so the statement always returns exactly one row.
// Materialization is bounded in SQL: the key lists are capped before a round runs (at most IDENTITY_MAX_FILMS Films, the claim pairs and movie ids of at most
// IDENTITY_MAX_CLAIM_ROWS claim rows), and every row column reads at most its cap + 1 rows (LIMIT), so an overflow is detected from the extra row and no
// column ever aggregates an unbounded set.
// Index use: film(id) PK, film_redirect(from_id) PK, canonical_revision(kind,id) PK, film_external_id PK (film_id,...), film_external_id_by_scheme_value, and
// for the retirement ledger by movie id the non-unique index tmdb_retirement_decision_movie ON tmdb_retirement_decision(movie_id): the owner's decision of
// 25 Nov 2026 (option A, review of PR #1000). The ledger has no Film foreign key and retires a movie id whatever Film it names, so it must be read by movie id.
// That index is migration 0040 (AIR-667); its production apply and readback are a prerequisite of activation (AIR-648). Until it is applied this
// dormant statement would scan the ledger, and it must not be activated before then.
const LIST='(SELECT value FROM json_each(?))';
const capped=(columns,from,inner=columns)=>'(SELECT json_group_array(json_array('+columns+')) FROM (SELECT '+inner+' FROM '+from+' LIMIT ?))';
const DECISION='seq,film_id,kind,movie_id,tv_id,supersedes_seq';
export const IDENTITY_SNAPSHOT_SQL='SELECT '
 +"(SELECT json_object('rows',COUNT(*),'mode',MAX(mode),'cutover',MAX(cutover),'generation',MAX(generation)) FROM film_person_authority WHERE id=1) AS marker,"
 +'(SELECT json_group_array(id) FROM film WHERE id IN '+LIST+') AS films,'
 +'(SELECT json_group_array(json_array(from_id,to_film_id)) FROM film_redirect WHERE from_id IN '+LIST+') AS redirects,'
 +"(SELECT json_group_array(json_array(id,revision)) FROM canonical_revision WHERE kind='film' AND id IN "+LIST+') AS revisions,'
 +capped('film_id,scheme,value,trusted,conflicting','film_external_id WHERE film_id IN '+LIST)+' AS owned,'
 +capped('film_id,scheme,value,trusted,conflicting',"json_each(?) j INNER JOIN film_external_id e ON e.scheme=json_extract(j.value,'$[0]') AND e.value=json_extract(j.value,'$[1]')","e.film_id AS film_id,e.scheme AS scheme,e.value AS value,e.trusted AS trusted,e.conflicting AS conflicting")+' AS claimed,'
 +capped(DECISION,'tmdb_retirement_decision WHERE movie_id IN '+LIST)+' AS decisions_by_movie';
// The rows each capped column may return: its cap + 1, so one extra row proves an overflow.
const ROW_LIMIT=IDENTITY_MAX_CLAIM_ROWS+1;

const emptyKeys=()=>({films:new Set(),pairs:new Set(),movies:new Set()});
const pairKey=(scheme,value)=>JSON.stringify([String(scheme),String(value)]);
const sorted=set=>[...set].sort();
function snapshotParams(keys){
 const films=JSON.stringify(sorted(keys.films)),pairs='['+sorted(keys.pairs).join(',')+']',movies=JSON.stringify(sorted(keys.movies));
 return [films,films,films,films,ROW_LIMIT,pairs,ROW_LIMIT,movies,ROW_LIMIT];
}
class ReadFailed extends Error{constructor(cause){super('canonical_read_unavailable');this.code='canonical_read_unavailable';this.cause=cause;}}
function parseColumn(text){
 if(text==null)return [];
 const value=typeof text==='string'?JSON.parse(text):text;
 if(!Array.isArray(value))throw new ReadFailed();
 return value;
}
// Reads one snapshot of the key set; normalized, sorted rows (json_group_array has no defined order).
async function readSnapshot(db,keys){
 let row;
 try{
  const rows=await many(db,IDENTITY_SNAPSHOT_SQL,snapshotParams(keys));
  if(rows.length!==1)throw new ReadFailed();
  row=rows[0];
 }catch(error){throw error instanceof ReadFailed?error:new ReadFailed(error);}
 try{
  const marker=typeof row.marker==='string'?JSON.parse(row.marker):row.marker;
  const claimRow=r=>({film:String(r[0]),scheme:String(r[1]),value:String(r[2]),trusted:Number(r[3])===1,conflicting:Number(r[4])===1});
  const decision=r=>({seq:Number(r[0]),film:String(r[1]),kind:String(r[2]),movie:String(r[3]),tv:String(r[4]),supersedes:r[5]==null?null:Number(r[5])});
  const byText=(a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0;
  const decisions=new Map();
  const ownedRows=parseColumn(row.owned),claimedRows=parseColumn(row.claimed),decisionRows=parseColumn(row.decisions_by_movie);
  for(const d of decisionRows.map(decision))decisions.set(d.seq,d);
  // One extra row in any capped column proves an overflow; the physical claim rows are counted once (a row read both by Film and by pair is one row).
  const physical=new Set([...ownedRows,...claimedRows].map(r=>JSON.stringify([String(r[0]),String(r[1]),String(r[2])])));
  const overflow=ownedRows.length>=ROW_LIMIT||claimedRows.length>=ROW_LIMIT||decisionRows.length>=ROW_LIMIT||physical.size>IDENTITY_MAX_CLAIM_ROWS;
  return {
   marker:{rows:Number(marker?.rows),mode:marker?.mode??null,cutover:marker?.cutover??null,generation:marker?.generation==null?null:Number(marker.generation)},
   films:parseColumn(row.films).map(String).sort(),
   redirects:parseColumn(row.redirects).map(r=>({from:String(r[0]),to:String(r[1])})).sort(byText),
   revisions:parseColumn(row.revisions).map(r=>({film:String(r[0]),revision:Number(r[1])})).sort(byText),
   overflow,
   owned:ownedRows.map(claimRow).sort(byText),
   claimed:claimedRows.map(claimRow).sort(byText),
   decisions:[...decisions.values()].sort((a,b)=>a.seq-b.seq),
  };
 }catch(error){throw error instanceof ReadFailed?error:new ReadFailed(error);}
}

// The identity read-set digest: the marker, the key set and every row read, with an explicit row count per queried pair, per Film (redirect, revision, claims,
// decisions) and per queried movie id, so a vanished row, a new competing claim or a new decision changes it.
export function identityDigest(keys,snapshot){
 const count=(list,pick,key)=>list.filter(item=>pick(item)===key).length;
 const body={
  marker:snapshot.marker,
  films:sorted(keys.films).map(id=>({id,present:snapshot.films.includes(id),redirects:snapshot.redirects.filter(r=>r.from===id),revisions:snapshot.revisions.filter(r=>r.film===id),claims:count(snapshot.owned,r=>r.film,id),decisions:count(snapshot.decisions,d=>d.film,id)})),
  pairs:sorted(keys.pairs).map(key=>({key,rows:snapshot.claimed.filter(r=>pairKey(r.scheme,r.value)===key).length})),
  movies:sorted(keys.movies).map(movie=>({movie,decisions:snapshot.decisions.filter(d=>d.movie===movie).map(d=>d.seq)})),
  owned:snapshot.owned,claimed:snapshot.claimed,decisions:snapshot.decisions,
 };
 return 'sha256:'+sha256Hex(JSON.stringify(body));
}

const isOwn=row=>row.trusted&&!row.conflicting;
// A decision is non-superseded when no restore names it. A Film's current decision is its highest seq (the tmdb_retirement_current view).
function activeRetirements(decisions){
 const superseded=new Set(decisions.filter(d=>d.supersedes!=null).map(d=>d.supersedes));
 return decisions.filter(d=>d.kind==='retire'&&!superseded.has(d.seq));
}

// The pure evaluation of one snapshot. Returns {need} when a key the evaluation depends on was not read in this snapshot, else {result}.
export function evaluate(request,keys,snapshot,generation){
 const need=emptyKeys();
 const missing=()=>({need});
 const fail=(verdict,reason)=>({result:{verdict,reason}});
 const m=snapshot.marker;
 if(m.rows!==1||m.mode!=='d1')return fail('unavailable','film_person_unavailable');
 if(m.cutover!=='open')return fail('unavailable','film_person_held');
 if(m.generation!==generation)return fail('unavailable','identity_moved');
 // Fan-out (decision 7) is decided before any verdict, from the bounded snapshot: an extra row in a capped column or more distinct claim rows than the cap.
 if(snapshot.overflow||keys.films.size>IDENTITY_MAX_FILMS)return fail('conflict','identity_fanout');
 const redirectOf=id=>snapshot.redirects.find(r=>r.from===id)?.to??null;
 const retired=activeRetirements(snapshot.decisions);
 let start;
 // Step 0 / 1: the requested Film or the requested external claim.
 if(request.scheme==='film'){
  if(!keys.films.has(request.value)){need.films.add(request.value);return missing();}
  if(!snapshot.films.includes(request.value)&&redirectOf(request.value)===null)return fail('absent',null);
  start=request.value;
 }else{
  const scheme=DB_SCHEME[request.scheme],key=pairKey(scheme,request.value);
  if(!keys.pairs.has(key)){need.pairs.add(key);if(scheme==='tmdb')need.movies.add(request.value);return missing();}
  if(scheme==='tmdb'&&!keys.movies.has(request.value)){need.movies.add(request.value);return missing();}
  // A requested movie id retired by a non-superseded owner decision is `retired`, before any conflict: a settled retirement is not a conflict.
  if(scheme==='tmdb'&&retired.some(d=>d.movie===request.value))return fail('retired','tmdb_retired');
  const rows=snapshot.claimed.filter(r=>r.scheme===scheme&&r.value===request.value);
  if(!rows.length)return fail('absent',null);
  const owners=[...new Set(rows.filter(isOwn).map(r=>r.film))];
  if(owners.length===0)return rows.some(r=>r.conflicting)?fail('conflict','competing_owner'):fail('unverified','untrusted_only');
  if(owners.length>1||rows.some(r=>!(isOwn(r)&&r.film===owners[0])))return fail('conflict','competing_owner');
  start=owners[0];
 }
 // Step 2: the redirect chain, bounded, with cycle detection.
 const chain=[],seen=new Set([start]);
 let survivor=start;
 for(;;){
  if(!keys.films.has(survivor)){need.films.add(survivor);return missing();}
  const next=redirectOf(survivor);
  if(next===null)break;
  chain.push(survivor);
  if(chain.length>IDENTITY_MAX_REDIRECT_HOPS)return fail('cycle','identity_fanout');
  if(seen.has(next))return fail('cycle','redirect_cycle');
  seen.add(next);survivor=next;
 }
 // A claim or a redirect naming a Film without its row cannot be (foreign keys): the store is inconsistent, not absent.
 if(!snapshot.films.includes(survivor))return fail('unavailable','canonical_read_unavailable');
 // Step 3: the survivor's claims of every scheme, and every row of any Film that claims one of those values.
 const own=snapshot.owned.filter(r=>r.film===survivor);
 for(const row of own){const key=pairKey(row.scheme,row.value);if(!keys.pairs.has(key))need.pairs.add(key);}
 if(need.pairs.size)return missing();
 // Step 5: every Film met on the way is part of the read-set (its revision is fenced).
 for(const row of snapshot.claimed)if(!keys.films.has(row.film))need.films.add(row.film);
 // Step 4: the retirement ledger of every claimed movie id of the survivor (the ledger retires a movie id whatever Film row holds it).
 for(const row of own)if(row.scheme==='tmdb'&&!keys.movies.has(row.value))need.movies.add(row.value);
 if(need.films.size||need.movies.size)return missing();
 // Every Film read has a revision (canonical writers create it with the Film); a missing one is an inconsistent store.
 for(const id of keys.films)if(snapshot.films.includes(id)&&!snapshot.revisions.some(r=>r.film===id))return fail('unavailable','canonical_read_unavailable');
 // A movie claim retired by a non-superseded owner decision (of any Film) is historical evidence: out of every alias set before conflict evaluation.
 const retiredMovies=new Set(retired.map(d=>d.movie));
 const claims=[],authorized={tmdb_movie:[],tmdb_tv:[],letterboxd_lid:[]};
 for(const row of own){
  const isRetired=row.scheme==='tmdb'&&retiredMovies.has(row.value);
  const competing=snapshot.claimed.filter(r=>r.scheme===row.scheme&&r.value===row.value&&!(r.film===survivor&&isOwn(r)));
  claims.push({scheme:row.scheme,value:row.value,trusted:row.trusted,conflicting:row.conflicting,...(isRetired?{retired:true}:{}),...(competing.length&&!isRetired?{competing:true}:{})});
  if(isRetired||!SECTION_SCHEMES.has(row.scheme))continue;
  // An unsettled claim (untrusted, conflicting, or a value another Film also claims) on a scheme a section reads fails the request.
  if(!isOwn(row))return fail('conflict','unsettled_claim');
  if(competing.length)return fail('conflict','competing_owner');
  authorized[ALIAS_SCHEME[row.scheme]].push(row.value);
 }
 for(const list of Object.values(authorized))list.sort();
 const overflow=Object.entries(authorized).filter(([,list])=>list.length>AUTHORIZED_ALIASES_PER_SCHEME).map(([scheme])=>scheme);
 for(const scheme of overflow)authorized[scheme]=authorized[scheme].slice(0,AUTHORIZED_ALIASES_PER_SCHEME);
 // AIR-387: /film/tmdb_<n> for the one trusted TMDB movie, else /film/<lid> for the one verified lid; otherwise no permalink.
 const permalink=authorized.tmdb_movie.length===1?'/film/tmdb_'+authorized.tmdb_movie[0]:authorized.tmdb_movie.length===0&&authorized.letterboxd_lid.length===1?'/film/'+authorized.letterboxd_lid[0]:null;
 claims.sort((a,b)=>a.scheme<b.scheme?-1:a.scheme>b.scheme?1:a.value<b.value?-1:a.value>b.value?1:0);
 return {result:{verdict:chain.length?'redirected':'found',reason:null,filmId:survivor,redirectedFrom:chain,claims,authorized,aliasOverflow:overflow,permalink}};
}

const HTTP={found:200,redirected:200,absent:404,retired:410,conflict:409,unverified:409,cycle:409,unavailable:503,invalid:400};
function requestKeys(request){
 const keys=emptyKeys();
 if(request.scheme==='film')keys.films.add(request.value);
 else{keys.pairs.add(pairKey(DB_SCHEME[request.scheme],request.value));if(request.scheme==='tmdb_movie')keys.movies.add(request.value);}
 return keys;
}
const merge=(keys,need)=>{for(const k of ['films','pairs','movies'])for(const v of need[k])keys[k].add(v);};
// The key set may not grow past the caps: an overflow is decided before the next round queries the excess keys.
const keysOverflow=keys=>keys.films.size>IDENTITY_MAX_FILMS||keys.pairs.size>IDENTITY_MAX_CLAIM_ROWS+1||keys.movies.size>IDENTITY_MAX_CLAIM_ROWS+1;
// readAuthority (film-person-authority.js) runs three statements: the table inventory, schema_contract and the marker/fence/baseline row.
export const IDENTITY_GATE_STATEMENTS=3;

// Resolves one typed id to its survivor with the coherent identity read-set (decision 3). Spends one statement of `budget` per round; the caller reserves the
// fence first. {verdict, reason, http, requested, ...found fields, fence:{keys, digest, generation}}. Never throws for a typed failure.
export async function resolveFilmIdentity(env,input,{budget=createStatementBudget()}={}){
 let request;
 try{request=parseTypedFilmId(input);}catch{return {verdict:'invalid',reason:'not_a_typed_id',http:400,requested:null};}
 const requested={scheme:request.scheme,value:request.value};
 const failure=(verdict,reason)=>({verdict,reason,http:HTTP[verdict],requested});
 // The gate's statements are charged before they run, so a budget never overspends.
 if(!budget.take(IDENTITY_GATE_STATEMENTS))return failure('unavailable','budget_exceeded');
 let gate;
 try{gate=await readAuthority(env);}catch(error){return failure('unavailable',error?.code==='film_person_held'?'film_person_held':'film_person_unavailable');}
 if(gate.state==='held')return failure('unavailable','film_person_held');
 if(gate.state!=='open')return failure('unavailable','film_person_unavailable');
 const db=database(env),keys=requestKeys(request);
 for(let round=0;round<IDENTITY_MAX_ROUNDS;round++){
  if(!budget.take(1))return failure('unavailable','budget_exceeded');
  let snapshot;
  try{snapshot=await readSnapshot(db,keys);}catch{return failure('unavailable','canonical_read_unavailable');}
  const step=evaluate(request,keys,snapshot,gate.generation);
  if(step.need){merge(keys,step.need);if(keysOverflow(keys))return failure('conflict','identity_fanout');continue;}
  const {result}=step;
  if(result.verdict!=='found'&&result.verdict!=='redirected')return failure(result.verdict,result.reason);
  const digest=identityDigest(keys,snapshot);
  return {...result,http:200,requested,token:{generation:gate.generation,readSet:digest},fence:{keys:{films:sorted(keys.films),pairs:sorted(keys.pairs),movies:sorted(keys.movies)},digest,generation:gate.generation}};
 }
 return failure('conflict','identity_fanout');
}

// The final identity fence (decision 4): the same statement over the same key set, after every section read. {ok:true} | {ok:false, reason}.
// It spends the reserved statement; a missing reservation or a failed read is a fence that cannot run, never a pass.
export async function fenceFilmIdentity(env,resolution,budget){
 if(!resolution?.fence)return {ok:false,reason:'canonical_read_unavailable'};
 if(!budget.redeem(IDENTITY_FENCE_STATEMENTS))return {ok:false,reason:'canonical_read_unavailable'};
 const keys={films:new Set(resolution.fence.keys.films),pairs:new Set(resolution.fence.keys.pairs),movies:new Set(resolution.fence.keys.movies)};
 let snapshot;
 try{snapshot=await readSnapshot(database(env),keys);}catch{return {ok:false,reason:'canonical_read_unavailable'};}
 const m=snapshot.marker;
 if(snapshot.overflow||m.rows!==1||m.mode!=='d1'||m.cutover!=='open'||m.generation!==resolution.fence.generation)return {ok:false,reason:'identity_moved'};
 return identityDigest(keys,snapshot)===resolution.fence.digest?{ok:true}:{ok:false,reason:'identity_moved'};
}

// The aggregate envelope of steps 2-3: resolve, reserve the fence, run the section readers, fence, and answer. `sections(resolution, budget)` returns an
// object of sections (step 3 supplies them; the default is none). A non-found identity returns no section. The fence runs on every found path, also when
// the section reader throws (decision 4: independent of any optional read failure); a fence that moved or could not run returns 503 with no section.
// A section reader that throws loses all its sections: the answer carries `sectionsUnavailable: {reason:'section_read_failed'}` and no section value
// (never a manufactured section). The envelope fields `contract` and `identity` cannot be overwritten by a section.
const RESERVED_FIELDS=new Set(['contract','identity','sectionsUnavailable']);
export async function readFilmAggregateIdentity(env,input,{sections=null,budgetLimit=REQUEST_STATEMENT_BUDGET}={}){
 const budget=createStatementBudget(budgetLimit);
 const identityOnly=(r)=>({http:r.http,body:{contract:FILM_AGGREGATE_CONTRACT,identity:publicIdentity(r)}});
 // The final capture is reserved from the request budget before any read.
 if(!budget.reserve(IDENTITY_FENCE_STATEMENTS))return identityOnly({verdict:'unavailable',reason:'budget_exceeded',http:503,requested:null});
 const resolution=await resolveFilmIdentity(env,input,{budget});
 if(resolution.http!==200)return identityOnly(resolution);
 let read={},sectionFailure=false;
 if(typeof sections==='function'){
  try{read=(await sections(resolution,budget))||{};}
  catch{read={};sectionFailure=true;}
 }
 const fence=await fenceFilmIdentity(env,resolution,budget);
 if(!fence.ok)return identityOnly({verdict:'unavailable',reason:fence.reason,http:503,requested:resolution.requested});
 const body={contract:FILM_AGGREGATE_CONTRACT,identity:publicIdentity(resolution)};
 if(sectionFailure)body.sectionsUnavailable={reason:'section_read_failed'};
 else for(const [name,value] of Object.entries(read))if(!RESERVED_FIELDS.has(name))body[name]=value;
 return {http:200,body};
}

function publicIdentity(r){
 if(r.http!==200)return {verdict:r.verdict,reason:r.reason,requested:r.requested};
 return {verdict:r.verdict,filmId:r.filmId,requested:r.requested,redirectedFrom:r.redirectedFrom,claims:r.claims,permalink:r.permalink,token:r.token};
}
