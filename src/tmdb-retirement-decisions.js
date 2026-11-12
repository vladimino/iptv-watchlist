// AIR-370 / ADR 0099 (Accepted), decision 7. The D1-owned, owner-only, append-only history of TMDB retirement decisions (ADR 0057), and the
// prepare-only loader of the existing R2 object identity/tmdb-retirements.json. Inactive: nothing in the Worker imports this module (it is
// not bundled and no route, job or cron calls it), schema 16 is a file only, and while the marker is r2 or prepared the enrichment
// projector stays the only canonical writer, so recordRetirementDecision refuses before it reaches the database.
// - A decision is one owner statement about one Film: 'retire' (the retired TMDB movie id, the live TMDB TV entry, the evidence and the
//   owner's confirmation) or 'restore' (the explicit owner-authored inverse of the latest retire). Rows are never updated or deleted, there is
//   no implicit un-retirement, and the current state of a Film is its latest decision.
// - The ledger holds decisions only. It does not write film_external_id, the canonical identity or the identity dimension: applying a
//   decision belongs to the later producer integration (AIR-371) behind the fenced mutation boundary of AIR-367.
// - prepareRetirementImport is pure: it validates a body of the R2 object exactly like tmdbRetirementSet (src/domain/tmdb-tv-identity.js) and
//   returns decisions with deterministic request ids (so loading the same object twice is a replay). It reads nothing and writes nothing; the
//   R2 object stays an input and an audit artifact and this module never writes it.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';

export const RETIREMENTS_SCHEMA_VERSION=1;
export const RETIREMENTS_KEY='identity/tmdb-retirements.json';
const KINDS=new Set(['retire','restore']);
const ORIGINS=new Set(['owner_request','r2_import']);
const NUMBER=/^[1-9]\d{0,9}$/;
const LID=/^[A-Za-z0-9]{1,16}$/;
const SHA=/^[0-9a-f]{64}$/;
const FILM=/^film:./;

const text=value=>typeof value==='string'&&value.length>0;
const sorted=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(sorted):Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])]))):value;
const stable=value=>JSON.stringify(sorted(value===undefined?null:value));
const number=value=>NUMBER.test(String(value??''))?String(value):null;

// Letterboxd film permalink, as letterboxdSlugFromUrl accepts it (a film page of letterboxd.com).
function letterboxdSlug(url){
 if(typeof url!=='string')return null;
 let link;try{link=new URL(url);}catch{return null;}
 if(link.protocol!=='https:'||!/^(?:www\.)?letterboxd\.com$/.test(link.hostname))return null;
 const match=/^\/film\/([a-z0-9-]+)\/?$/.exec(link.pathname);
 return match?match[1]:null;
}

function confirmationReasons(confirmation){
 const confirmed=confirmation||{};
 return confirmed.by==='owner'&&text(confirmed.at)&&text(confirmed.source)?[]:['owner_confirmation'];
}

// One retirement entry as the R2 object holds it (the AIR-290 contract): every field is checked, nothing is inferred.
export function checkRetirementEntry(entry){
 const reasons=[];
 const lid=String(entry?.lid??'');
 if(!LID.test(lid))reasons.push('lid');
 if(entry?.filmId!=='film:'+lid)reasons.push('film_id');
 const movieId=number(entry?.movieId),tvId=number(entry?.tvId);
 if(!movieId)reasons.push('movie_id');
 if(!tvId)reasons.push('tv_id');
 const evidence=entry?.evidence||{};
 if(evidence.movieStatus!==404||!evidence.movieCheckedAt)reasons.push('movie_404');
 if(!letterboxdSlug(evidence.letterboxdUrl))reasons.push('letterboxd_url');
 if(evidence.link!=='tv/'+tvId||!evidence.linkCheckedAt)reasons.push('letterboxd_link');
 if(String(evidence.tvResponseId??'')!==tvId||!evidence.tvCheckedAt)reasons.push('tv_entry');
 reasons.push(...confirmationReasons(entry?.confirmation));
 if(reasons.length)return {ok:false,reasons};
 return {ok:true,retirement:{filmId:entry.filmId,lid,movieId,tvId,evidence:{...evidence},confirmation:{...entry.confirmation}}};
}

// Prepare-only: the whole object is valid or nothing is prepared (one invalid entry or a duplicate invalidates all, as in the projector).
// `sha256` is the hex digest of the object's bytes, which the caller computed; it ties every decision to the exact input.
export function prepareRetirementImport(body,{sha256}={}){
 if(!SHA.test(String(sha256||'')))return {ok:false,reasons:['sha256'],decisions:[]};
 if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,reasons:['body'],decisions:[]};
 const reasons=[];
 if(body.schemaVersion!==RETIREMENTS_SCHEMA_VERSION)reasons.push('schema_version');
 if(!Array.isArray(body.retirements))reasons.push('retirements');
 const seen={filmId:new Set(),lid:new Set(),movieId:new Set(),tvId:new Set()};
 const decisions=[];
 for(const [index,entry] of (Array.isArray(body.retirements)?body.retirements:[]).entries()){
  const checked=checkRetirementEntry(entry);
  if(!checked.ok){reasons.push(...checked.reasons.map(reason=>'entry_'+index+':'+reason));continue;}
  for(const field of Object.keys(seen)){if(seen[field].has(checked.retirement[field]))reasons.push('entry_'+index+':duplicate_'+field);seen[field].add(checked.retirement[field]);}
  const item=checked.retirement;
  decisions.push({requestId:'r2-import:'+sha256.slice(0,16)+':'+item.filmId,kind:'retire',filmId:item.filmId,lid:item.lid,movieId:item.movieId,tvId:item.tvId,evidence:item.evidence,confirmation:item.confirmation,origin:'r2_import',inputSha256:sha256});
 }
 return reasons.length?{ok:false,reasons,decisions:[]}:{ok:true,reasons:[],decisions};
}

export async function sha256Hex(input){
 const bytes=typeof input==='string'?new TextEncoder().encode(input):input;
 return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

// The checked, normalized form of one decision; throws retirement_invalid before any SQL. A restore carries the same ids as the retire it
// reverses, a reason and the owner's confirmation; a retire carries the full evidence of the AIR-290 contract.
export function normalizeDecision(input){
 const invalid=reason=>{const error=failed('retirement_invalid');error.reason=reason;return error;};
 if(!input||typeof input!=='object')throw invalid('input');
 if(!text(input.requestId)||input.requestId.length>200)throw invalid('request_id');
 if(!KINDS.has(input.kind))throw invalid('kind');
 const origin=input.origin??'owner_request';
 if(!ORIGINS.has(origin))throw invalid('origin');
 if(!FILM.test(String(input.filmId??'')))throw invalid('film_id');
 const lid=String(input.lid??'');
 if(!LID.test(lid)||input.filmId!=='film:'+lid)throw invalid('lid');
 const movieId=number(input.movieId),tvId=number(input.tvId);
 if(!movieId)throw invalid('movie_id');
 if(!tvId)throw invalid('tv_id');
 if(confirmationReasons(input.confirmation).length)throw invalid('owner_confirmation');
 const confirmation={...input.confirmation};
 let evidence,supersedesSeq=null,inputSha256=input.inputSha256??null;
 if(input.kind==='retire'){
  const checked=checkRetirementEntry({filmId:input.filmId,lid,movieId,tvId,evidence:input.evidence,confirmation});
  if(!checked.ok)throw invalid(checked.reasons[0]);
  evidence=checked.retirement.evidence;
  if(input.supersedesSeq!==undefined&&input.supersedesSeq!==null)throw invalid('supersedes');
 }else{
  if(!input.evidence||typeof input.evidence!=='object'||!text(input.evidence.reason))throw invalid('reason');
  evidence={reason:input.evidence.reason};
  if(!Number.isInteger(input.supersedesSeq)||input.supersedesSeq<1)throw invalid('supersedes');
  supersedesSeq=input.supersedesSeq;
  if(origin==='r2_import')throw invalid('origin');
 }
 if(origin==='r2_import'&&!SHA.test(String(inputSha256||'')))throw invalid('input_sha256');
 if(origin!=='r2_import')inputSha256=null;
 const content={kind:input.kind,filmId:input.filmId,lid,movieId,tvId,evidence,confirmation,origin,inputSha256,supersedesSeq};
 return {requestId:input.requestId,...content,payload:stable(content)};
}

// Maps a failure of the batch to a decision-level code; the fence, revision and unavailable codes of AIR-367 pass through.
function decisionFailure(error){
 const message=String(error?.cause?.message||error?.message||'');
 for(const code of ['tmdb_retirement_active','tmdb_retirement_tv_collision','tmdb_restore_invalid'])if(message.includes(code))return failed(code,error);
 return error;
}

// The fenced write of ONE owner decision (a later card calls it; nothing does today). It refuses unless the marker is open, proves the marker
// generation and the Film's revision in one batch, requires the Film to exist and not to be a redirect, and appends exactly one row. A replay
// (the same request id with the same content) opens no batch; the same id with other content is refused. A retire is held, not written, when
// the typed identity on the Film or on another Film conflicts (another Film trusting this TV entry or this retired movie id, this Film trusting
// another TMDB id of either scheme, or no `tmdb` row for the retired movie id); all of these are asserted again inside the batch.
// input: {requestId, kind:'retire'|'restore', filmId, lid, movieId, tvId, expectedRevision, at, evidence, confirmation, supersedesSeq?, origin?, inputSha256?}
export async function recordRetirementDecision(env,input){
 const decision=normalizeDecision(input);
 const expected=fenced.revisionOf(input.expectedRevision),at=fenced.text(input.at);
 const tail=fenced.receiptTail(input.receiptMark,{kind:'film',id:decision.filmId});
 const gate=assertWritable(await readAuthority(env));
 const db=database(env);
 const read=async(sql,params)=>{try{return await one(db,sql,params);}catch(error){throw failed('retirement_unavailable',error);}};
 const readAll=async(sql,params)=>{try{return await many(db,sql,params);}catch(error){throw failed('retirement_unavailable',error);}};
 const known=await read('SELECT seq,payload_json FROM tmdb_retirement_decision WHERE request_id=?',[decision.requestId]);
 if(known){
  if(known.payload_json!==decision.payload)throw failed('retirement_replay_mismatch');
  return {replayed:true,seq:known.seq,requestId:decision.requestId};
 }
 const film=await read('SELECT id FROM film WHERE id=?',[decision.filmId]);
 if(!film)throw failed('film_person_reference');
 if(await read('SELECT to_film_id FROM film_redirect WHERE from_id=?',[decision.filmId]))throw failed('film_person_redirect');
 const entities=[{kind:'film',id:decision.filmId,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[decision.filmId,decision.filmId]]);
 if(decision.kind==='retire'){
  const ids=await readAll('SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE (scheme=? AND value=?) OR (scheme=? AND value=?) OR (film_id=? AND scheme IN (?,?))',['tmdb_tv',decision.tvId,'tmdb',decision.movieId,decision.filmId,'tmdb','tmdb_tv']);
  const trusted=row=>row.trusted===1&&row.conflicting===0;
  const mine=ids.filter(row=>row.film_id===decision.filmId);
  const others=ids.filter(row=>row.film_id!==decision.filmId);
  if(others.some(row=>row.scheme==='tmdb_tv'&&row.value===decision.tvId&&trusted(row)))throw failed('retirement_tv_collision');
  if(others.some(row=>row.scheme==='tmdb'&&row.value===decision.movieId&&trusted(row)))throw failed('retirement_movie_on_other_film');
  if(!mine.some(row=>row.scheme==='tmdb'&&row.value===decision.movieId&&!row.conflicting))throw failed('retirement_movie_missing');
  if(mine.some(row=>row.scheme==='tmdb'&&row.value!==decision.movieId&&trusted(row)))throw failed('retirement_identity_mismatch');
  if(mine.some(row=>row.scheme==='tmdb_tv'&&row.value!==decision.tvId&&trusted(row)))throw failed('retirement_identity_mismatch');
  // The same checks inside the batch, so a Film that changed after the read fails the whole batch: the Film still carries this retired movie
  // id (not conflicting) and trusts no other TMDB id of either scheme, and no other Film trusts the TV entry or the retired movie id.
  statements.push([fenced.assertSql("EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND conflicting=0)"),[decision.filmId,decision.movieId]]);
  statements.push([fenced.assertSql("NOT EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND trusted=1 AND conflicting=0 AND ((scheme='tmdb' AND value<>?) OR (scheme='tmdb_tv' AND value<>?)))"),[decision.filmId,decision.movieId,decision.tvId]]);
  statements.push([fenced.assertSql("NOT EXISTS (SELECT 1 FROM film_external_id WHERE film_id<>? AND trusted=1 AND conflicting=0 AND ((scheme='tmdb_tv' AND value=?) OR (scheme='tmdb' AND value=?)))"),[decision.filmId,decision.tvId,decision.movieId]]);
 }
 statements.push(['INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq,payload_json,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[decision.requestId,decision.filmId,decision.kind,decision.lid,decision.movieId,decision.tvId,stable(decision.evidence),stable(decision.confirmation),decision.origin,decision.inputSha256,decision.supersedesSeq,decision.payload,at]]);
 statements.push([fenced.BUMP,['film',decision.filmId,at]]);
 try{await fenced.commit(env,gate,statements,entities,tail);}
 catch(error){
  // A concurrent writer with the same request id: the same content is a replay, other content is a mismatch (checked before the trigger codes,
  // since the racing row itself can be what the trigger refused).
  const raced=await read('SELECT seq,payload_json FROM tmdb_retirement_decision WHERE request_id=?',[decision.requestId]).catch(()=>null);
  if(raced&&raced.payload_json===decision.payload)return {replayed:true,seq:raced.seq,requestId:decision.requestId};
  if(raced)throw failed('retirement_replay_mismatch',error);
  throw decisionFailure(error);
 }
 const row=await read('SELECT seq FROM tmdb_retirement_decision WHERE request_id=?',[decision.requestId]);
 return {replayed:false,seq:row.seq,requestId:decision.requestId,revision:expected+1};
}

const view=row=>({seq:row.seq,requestId:row.request_id,filmId:row.film_id,kind:row.kind,lid:row.lid,movieId:row.movie_id,tvId:row.tv_id,evidence:JSON.parse(row.evidence_json),confirmation:JSON.parse(row.confirmation_json),origin:row.origin,inputSha256:row.input_sha256,supersedesSeq:row.supersedes_seq,recordedAt:row.recorded_at});

// Read only (compare-only use; no authority gate): the full history of one Film in order, and the current state of many.
export async function retirementHistory(env,filmId){
 const db=database(env);
 try{return (await many(db,'SELECT * FROM tmdb_retirement_decision WHERE film_id=? ORDER BY seq',[filmId])).map(view);}
 catch(error){throw failed('retirement_unavailable',error);}
}
export async function currentRetirements(env,filmIds){
 const db=database(env),out=new Map();
 const list=[...new Set(filmIds||[])];
 for(let at=0;at<list.length;at+=80){
  const chunk=list.slice(at,at+80);
  let rows;
  try{rows=await many(db,`SELECT film_id,seq,state,lid,movie_id,tv_id,request_id FROM tmdb_retirement_current WHERE film_id IN (${chunk.map(()=>'?').join(',')})`,chunk);}
  catch(error){throw failed('retirement_unavailable',error);}
  for(const row of rows)out.set(row.film_id,{seq:row.seq,state:row.state,movieId:row.movie_id,tvId:row.tv_id,lid:row.lid,requestId:row.request_id});
 }
 return out;
}

// Compare-only (inactive): the current D1 state against a prepared import. Neither side is changed.
// same: the Film is retired with the same ids; missing: prepared but not in D1; restored: D1's latest decision reversed it (the owner's
// later decision stands, the R2 object is not re-applied); differs: retired in D1 with other ids; extra: retired in D1 but absent from the object.
export function compareRetirementImport(current,prepared){
 const out={same:[],missing:[],restored:[],differs:[],extra:[]};
 const wanted=new Map((prepared?.decisions||[]).map(item=>[item.filmId,item]));
 for(const [filmId,item] of wanted){
  const state=current.get(filmId);
  if(!state)out.missing.push(filmId);
  else if(state.state==='restore')out.restored.push(filmId);
  else if(state.movieId===item.movieId&&state.tvId===item.tvId)out.same.push(filmId);
  else out.differs.push(filmId);
 }
 for(const [filmId,state] of current)if(state.state==='retire'&&!wanted.has(filmId))out.extra.push(filmId);
 return out;
}
