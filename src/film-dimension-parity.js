// AIR-660 / ADR 0218 (Accepted), stage 1. The OFFLINE Film dimension parity reader: one bounded page of Films from a D1-shaped binding (an
// offline SQLite copy through scripts/film-dimension-parity.mjs, or the test stand-in), the domain authorities of their facts, and the
// classification of every film_dimension row by src/domain/film-dimension-parity.js. Read only: SELECT statements and nothing else, no
// receipt, no lease, no repair, no R2 and no network. Nothing in the Worker imports this module, no route or Workflow calls it, and it is not a
// production reader: running it against production D1 would be a new read operation that needs its own authorization.
//
// Bounds: at most PARITY_PAGE_MAX Films per call, ids in chunks of PARITY_CHUNK per statement (no per-Film statement), redirect chains at most
// PARITY_REDIRECT_DEPTH rounds. The marker generation is read before and after; a move refuses the page (film_person_generation_moved).
import {database,failed,many,readMarker} from './film-person-authority.js';
import {ownerCandidatesFromEntries} from './localization-sources.js';
import {classifyRow,identityPassed,identityVerdict,localizationFacts,metadataFacts,predictionFacts,retiredMovieIds,summarize} from './domain/film-dimension-parity.js';

export const PARITY_PAGE_MAX=200;
export const PARITY_PAGE_DEFAULT=100;
export const PARITY_CHUNK=80;
// The redirect depth of the canonical read model (CANONICAL_REDIRECT_DEPTH); not imported, because nothing in src may import that unbundled module.
export const PARITY_REDIRECT_DEPTH=8;
const FILM=/^film:.+/;

const counter=()=>({statements:0,rows:0});
// Every statement of a page, the marker reads included, goes through this wrapper: it refuses anything but a SELECT before the binding sees it
// and counts the statements and the rows returned (the lower bound of D1 rows_read; the offline copy reports no rows_written because none is sent).
function readOnly(db,stats){
 const guard=sql=>{if(!/^\s*SELECT\b/i.test(sql))throw failed('parity_not_read_only');};
 const wrap=statement=>({
  async first(){stats.statements++;const row=await statement.first();if(row)stats.rows++;return row;},
  async all(){stats.statements++;const result=await statement.all();stats.rows+=(result?.results||[]).length;return result;},
 });
 return {prepare(sql){guard(sql);const prepared=db.prepare(sql);return {bind(...params){return wrap(prepared.bind(...params));},first(){return wrap(prepared.bind()).first();},all(){return wrap(prepared.bind()).all();}};}};
}
async function read(db,sql,params=[]){
 try{return await many(db,sql,params);}catch(error){if(error?.code==='parity_not_read_only')throw error;throw failed('parity_read_failed',error);}
}
async function chunked(db,sql,ids,extra=[]){
 const out=[];
 for(let at=0;at<ids.length;at+=PARITY_CHUNK){
  const chunk=ids.slice(at,at+PARITY_CHUNK),marks=sql.split('/*ids*/').length-1;
  out.push(...await read(db,sql.replaceAll('/*ids*/',chunk.map(()=>'?').join(',')),[...Array(marks).fill(chunk).flat(),...extra]));
 }
 return out;
}
const group=(rows,key)=>{const out=new Map();for(const row of rows){if(!out.has(row[key]))out.set(row[key],[]);out.get(row[key]).push(row);}return out;};
async function tableNames(db){return new Set((await read(db,"SELECT name FROM sqlite_master WHERE type='table'")).map(row=>row.name));}

// Domain markers. Film/Person: only `open` proves identity (held, r2 and prepared make identity `unavailable`). Prediction and owner review:
// their facts are proved only at d1 with writes open.
async function markers(env,db,names){
 let film;
 try{film=await readMarker({DB:db});}catch(error){film={state:'unavailable',generation:null,error:error.code||'film_person_unavailable'};}
 const domain=async(table)=>{
  if(!names.has(table))return {available:false,reason:'not_installed'};
  const row=(await read(db,`SELECT mode,writes,generation FROM ${table} WHERE id=1`))[0];
  if(!row)return {available:false,reason:'no_marker'};
  if(row.mode!=='d1')return {available:false,reason:'not_authoritative',generation:row.generation};
  if(row.writes!=='open')return {available:false,reason:'held',generation:row.generation};
  return {available:true,generation:row.generation};
 };
 return {film,prediction:await domain('prediction_domain_authority'),owner:await domain('owner_review_authority')};
}

// Redirect chains of the page, in bounded rounds with cycle detection.
async function redirects(db,ids){
 const state=new Map(ids.map(id=>[id,{survivor:id,chain:[],seen:new Set([id]),state:'direct'}]));
 let open=[...state.values()];
 for(let round=0;round<PARITY_REDIRECT_DEPTH&&open.length;round++){
  const rows=await chunked(db,'SELECT from_id,to_film_id FROM film_redirect WHERE from_id IN (/*ids*/)',[...new Set(open.map(item=>item.survivor))]);
  const next=new Map(rows.map(row=>[row.from_id,row.to_film_id])),still=[];
  for(const item of open){
   const target=next.get(item.survivor);
   if(target===undefined)continue;
   if(item.seen.has(target)){item.state='cycle';continue;}
   item.chain.push(item.survivor);item.seen.add(target);item.survivor=target;item.state='redirected';still.push(item);
  }
  open=still;
 }
 if(open.length){
  const deeper=new Set((await chunked(db,'SELECT from_id FROM film_redirect WHERE from_id IN (/*ids*/)',[...new Set(open.map(item=>item.survivor))])).map(row=>row.from_id));
  for(const item of open)if(deeper.has(item.survivor))item.state='too_deep';
 }
 return new Map([...state].map(([id,item])=>[id,{state:item.state,survivor:item.state==='cycle'||item.state==='too_deep'?null:item.survivor,chain:item.chain}]));
}
// Every retired id whose chain ends at a survivor (owner_review_entry links are snapshots a merge does not rewrite), bounded like the read model.
async function ancestors(db,survivors){
 const links=new Map(survivors.map(id=>[id,[id]])),owner=new Map(survivors.map(id=>[id,id]));
 let frontier=[...survivors];
 for(let round=0;frontier.length;round++){
  if(round>=PARITY_REDIRECT_DEPTH)throw failed('parity_owner_redirect');
  const rows=await chunked(db,'SELECT from_id,to_film_id FROM film_redirect WHERE to_film_id IN (/*ids*/) ORDER BY from_id',frontier);
  frontier=[];
  for(const row of rows){const survivor=owner.get(row.to_film_id);if(survivor===undefined||owner.has(row.from_id))continue;owner.set(row.from_id,survivor);links.get(survivor).push(row.from_id);frontier.push(row.from_id);}
 }
 return links;
}

// One page: Films with id > after, in id order. Returns the classified rows, the derived facts per Film, a summary, the next cursor and the
// statements/rows the page read. options.coverage(filmId, aliases) -> {status, reason} supplies candidate coverage (ADR 0216 decision 6b);
// without it coverage is `incomplete` (ratings_evidence_not_read), so no fingerprint or prediction is ever proved absent.
// options.ids (AIR-666): classify exactly these Films instead of a keyset page (at most `limit`, canonical `film:` ids, no duplicates); an id with no film row is
// simply not in the result. `next` is then null. Everything else, the read-only guard and the marker generation checks included, is unchanged.
export async function readDimensionParity(env,{after='',limit=PARITY_PAGE_DEFAULT,coverage=null,ids=null}={}){
 const raw=database(env);
 if(!raw)throw failed('parity_unavailable');
 const size=Number(limit);
 if(!Number.isInteger(size)||size<1||size>PARITY_PAGE_MAX)throw failed('parity_bounded');
 if(typeof after!=='string'||(after&&!FILM.test(after)))throw failed('parity_invalid');
 const stats=counter(),db=readOnly(raw,stats);
 const names=await tableNames(db);
 const before=await markers(env,db,names);
 if(ids!==null&&(!Array.isArray(ids)||ids.length>size||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!FILM.test(id))))throw failed('parity_invalid');
 const page=ids===null?(await read(db,'SELECT id FROM film WHERE id>? ORDER BY id LIMIT ?',[after,size])).map(row=>row.id):(await chunked(db,'SELECT id FROM film WHERE id IN (/*ids*/)',ids)).map(row=>row.id).sort();
 const routes=await redirects(db,page);
 const survivors=[...new Set([...routes.values()].map(item=>item.survivor).filter(Boolean))];
 const both=[...new Set([...page,...survivors])];
 const has=name=>names.has(name);
 const [dimensions,filmRows,claims]=await Promise.all([
  chunked(db,'SELECT film_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at FROM film_dimension WHERE film_id IN (/*ids*/) ORDER BY film_id,dimension',page),
  chunked(db,'SELECT id,original_title FROM film WHERE id IN (/*ids*/)',both),
  chunked(db,'SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE film_id IN (/*ids*/) ORDER BY film_id,scheme,value',survivors),
 ]);
 const exists=new Set(filmRows.map(row=>row.id));
 const claimsBy=group(claims,'film_id');
 // Competing rows: every row of another Film that claims one of the survivors' section values (tmdb, letterboxd), read by value.
 const wanted=[...new Set(claims.filter(row=>row.scheme==='tmdb'||row.scheme==='letterboxd').map(row=>row.scheme+'\u0000'+row.value))];
 const competing=[];
 for(const scheme of ['tmdb','letterboxd']){
  const values=wanted.filter(key=>key.startsWith(scheme+'\u0000')).map(key=>key.slice(scheme.length+1));
  if(values.length)competing.push(...await chunked(db,'SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE value IN (/*ids*/) AND scheme=? ORDER BY film_id',values,[scheme]));
 }
 const movieIds=[...new Set(claims.filter(row=>row.scheme==='tmdb').map(row=>String(row.value)))];
 const decisions=has('tmdb_retirement_decision')?await chunked(db,'SELECT seq,movie_id,kind,supersedes_seq FROM tmdb_retirement_decision WHERE movie_id IN (/*ids*/) ORDER BY seq',movieIds):[];
 const retired=retiredMovieIds(decisions);
 const identityAvailable=before.film.state==='open';
 const identities=new Map();
 for(const id of page){
  const route=routes.get(id),survivor=route.survivor;
  identities.set(id,identityVerdict({requested:id,available:identityAvailable,reason:before.film.state==='held'?'film_person_held':'film_person_'+before.film.state,filmExists:exists.has(id),redirect:route,survivorExists:!!survivor&&exists.has(survivor),claims:claimsBy.get(survivor)||[],competing:competing.filter(row=>(claimsBy.get(survivor)||[]).some(claim=>claim.scheme===row.scheme&&String(claim.value)===String(row.value))),retired}));
 }
 // Sections are read only for Films whose identity passed the fence (ADR 0218 decision 2: a failed verdict yields no sections).
 const passed=page.filter(id=>identityPassed(identities.get(id)));
 const passedSurvivors=[...new Set(passed.map(id=>identities.get(id).survivor))];
 const [metadata,sources]=await Promise.all([
  chunked(db,'SELECT film_id,year,runtime,synopsis,poster,url,genres_json FROM film_metadata WHERE film_id IN (/*ids*/)',passedSurvivors),
  has('film_localization_source')?chunked(db,'SELECT film_id,source,value,source_version,provenance_json,observed_at FROM film_localization_source WHERE film_id IN (/*ids*/) ORDER BY film_id,source',passed):[],
 ]);
 const storage=[...new Set(passed.map(id=>identities.get(id)).flatMap(item=>item.aliases.storageIds))];
 const prediction=before.prediction;
 const [prints,points]=prediction.available&&storage.length?await Promise.all([
  chunked(db,'SELECT film_id,fingerprint_hash,invalidated_at FROM prediction_fingerprint WHERE film_id IN (/*ids*/)',storage),
  chunked(db,'SELECT film_id,fingerprint_hash,taste_profile_version,r2_key,content_sha256 FROM prediction_pointer WHERE film_id IN (/*ids*/)',storage),
 ]):[[],[]];
 // Owner values from owner_review_entry for every link of each survivor's chain.
 let owners=new Map();
 if(before.owner.available&&passedSurvivors.length){
  const links=await ancestors(db,passedSurvivors);
  const all=[...new Set([...links.values()].flat())];
  const entries=await chunked(db,"SELECT source_key,identity_link,identity_state,payload_json,generation FROM owner_review_entry WHERE kind='film' AND identity_state='verified' AND identity_link IN (/*ids*/) ORDER BY source_key",all);
  // A consumed row stamped with another generation than the stable marker is a torn owner snapshot, not proof (the same refusal as a moved marker).
  if(entries.some(row=>Number(row.generation)!==before.owner.generation))throw failed('owner_review_generation_moved');
  const candidates=ownerCandidatesFromEntries(entries);
  owners=new Map(passedSurvivors.map(id=>[id,links.get(id).flatMap(link=>candidates.get(link)||[])]));
 }
 const after2=await markers(env,db,names);
 if(after2.film.state!==before.film.state||after2.film.generation!==before.film.generation)throw failed('film_person_generation_moved');
 if(after2.prediction.generation!==before.prediction.generation||after2.prediction.available!==before.prediction.available)throw failed('prediction_generation_moved');
 if(after2.owner.generation!==before.owner.generation||after2.owner.available!==before.owner.available)throw failed('owner_review_generation_moved');

 const dimsBy=group(dimensions,'film_id'),metaBy=new Map(metadata.map(row=>[row.film_id,row])),sourcesBy=group(sources,'film_id');
 const facts=new Map(),classified=[];
 for(const id of page){
  const identity=identities.get(id),survivor=identity.survivor;
  const rows=dimsBy.get(id)||[],locRow=rows.find(row=>row.dimension==='localization')||null;
  const ok=identityPassed(identity),blocked='identity_'+identity.verdict;
  const filmFacts={
   identity,
   metadata:ok?metadataFacts(metaBy.get(survivor)||null):{status:'unavailable',reason:blocked},
   localization:ok?localizationFacts({row:locRow,sources:sourcesBy.get(id)||[],ownerValues:owners.get(survivor)||[],ownerAvailable:before.owner.available}):{status:'unavailable',reason:blocked,resolved:null},
   prediction:predictionFacts({available:ok&&prediction.available,reason:ok?'prediction_'+prediction.reason:blocked,storageIds:identity.aliases.storageIds,fingerprints:prints,pointers:points,coverage:coverage&&ok?coverage(id,identity.aliases):undefined}),
  };
  facts.set(id,filmFacts);
  for(const row of rows)classified.push(classifyRow(row,filmFacts));
 }
 return {
  writes:0,
  markers:{filmPerson:before.film.state,prediction:prediction.available?'open':prediction.reason,ownerReview:before.owner.available?'open':before.owner.reason},
  films:page.length,next:ids===null&&page.length===size?page[page.length-1]:null,
  classified,facts,summary:summarize(classified),
  cost:{statements:stats.statements,rowsReturned:stats.rows},
 };
}
