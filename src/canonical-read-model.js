// AIR-372 / ADR 0099 (Accepted), decisions 3 and 5. The canonical Film/Person BULK READ MODEL over D1, for the future UI, API, Admin, Finds,
// film page and person filmography readers. Inactive: nothing in the Worker imports this module (it is not bundled, no route calls it), so
// while the marker is legacy, r2 or prepared every existing reader is unchanged. It only reads: no write, no repair, no R2 access.
// - canonicalReaderMode is the gate a future route calls: legacy/r2/prepared -> 'existing' (the current runtime answers), open -> 'd1',
//   held, unreadable or malformed -> throws (fail closed, never R2).
// - readFilms/readPersons answer an id SET in a fixed number of queries per chunk of 80 ids (no per-id query), resolve redirects in bounded
//   rounds with cycle detection, resolve every title and name as owner > reviewed dictionary > automatic through src/localization-sources.js
//   (the owner value comes from owner_review_entry, which stays authoritative in its own domain), and re-read the marker generation after
//   the reads so a result that straddles a marker move is refused (film_person_generation_moved).
// - Person grouping stays derived (ADR 0058/0059/0062): a Person is the role-specific record person:<role>/<key>; nothing here merges people.
import {database,failed,many,readAuthority,readSource} from './film-person-authority.js';
import {loadLocalizationInputs,resolveLocalization} from './localization-sources.js';

export const CANONICAL_READ_MAX_IDS=200;
export const CANONICAL_REDIRECT_DEPTH=8;
export const CANONICAL_FILMOGRAPHY_CAP=500;
export const CANONICAL_READ_CHUNK=80;
const FILM=/^film:.+/,PERSON=/^person:[a-z_]+\/.+/;

// legacy, r2 and prepared keep the existing runtime; open reads D1; held and every unreadable state throw (film_person_held / film_person_unavailable).
export async function canonicalReaderMode(env){
 const gate=await readAuthority(env);
 const source=readSource(gate);
 return {mode:source==='d1'?'d1':'existing',generation:gate.generation,state:gate.state};
}

async function gateD1(env){
 const gate=await readAuthority(env);
 if(readSource(gate)!=='d1')throw failed('canonical_read_not_authoritative');
 return gate;
}
async function confirm(env,gate){
 const again=await readAuthority(env);
 if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_generation_moved');
}

function ids(values,pattern){
 if(!Array.isArray(values))throw failed('canonical_read_invalid');
 const list=[...new Set(values)];
 for(const id of list)if(typeof id!=='string'||!pattern.test(id))throw failed('canonical_read_invalid');
 if(list.length>CANONICAL_READ_MAX_IDS)throw failed('canonical_read_bounded');
 return list;
}
// One query per chunk of 80 ids; the /*ids*/ marker is replaced by the placeholders of the chunk (repeated parameters allowed).
async function chunked(db,sql,list,extra=[]){
 if(!list.length)return [];
 const marks=sql.split('/*ids*/').length-1,out=[];
 for(let at=0;at<list.length;at+=CANONICAL_READ_CHUNK){
  const chunk=list.slice(at,at+CANONICAL_READ_CHUNK),place=chunk.map(()=>'?').join(',');
  try{out.push(...await many(db,sql.replaceAll('/*ids*/',place),[...Array(marks).fill(chunk).flat(),...extra]));}
  catch(error){throw failed('canonical_read_unavailable',error);}
 }
 return out;
}
const flag=value=>value===1||value===true;
const group=(rows,key)=>{const out=new Map();for(const row of rows){const id=row[key];if(!out.has(id))out.set(id,[]);out.get(id).push(row);}return out;};

// The owner value of an entity, read from owner_review_entry (verified links only). A missing table or a read error fails closed: without the
// owner domain the precedence cannot be proven. Pure shape: payload.localization reviewed with provenance.authority owner.
export function ownerValuesFromEntries(entries){
 const out={};
 for(const entry of entries||[]){
  if(entry.identity_state!=='verified'||!entry.identity_link)continue;
  let payload;try{payload=typeof entry.payload_json==='string'?JSON.parse(entry.payload_json):entry.payload_json;}catch{continue;}
  const localization=payload?.localization;
  if(localization&&localization.status==='reviewed'&&localization.provenance?.authority==='owner'&&typeof localization.value==='string'&&localization.value.trim())out[entry.identity_link]={value:localization.value,at:localization.updatedAt??null};
 }
 return out;
}
async function ownerValuesFor(db,kind,list){
 if(!list.length)return {};
 const out=[];
 for(let at=0;at<list.length;at+=CANONICAL_READ_CHUNK){
  const chunk=list.slice(at,at+CANONICAL_READ_CHUNK);
  try{out.push(...await many(db,"SELECT identity_link,identity_state,payload_json FROM owner_review_entry WHERE kind=? AND identity_state='verified' AND identity_link IN ("+chunk.map(()=>'?').join(',')+')',[kind,...chunk]));}
  catch(error){throw failed('canonical_read_owner_unavailable',error);}
 }
 return ownerValuesFromEntries(out);
}

async function resolved(env,db,kind,list){
 if(!list.length)return new Map();
 const [inputs,owners]=await Promise.all([loadLocalizationInputs(env,kind,list),ownerValuesFor(db,kind,list)]);
 const out=new Map();
 for(const id of list){
  const input=inputs.get(id);
  if(owners[id])input.owner=owners[id];
  const value=resolveLocalization(input);
  out.set(id,{value:value.value,tier:value.tier,source:value.source,held:value.held,rejected:value.rejected});
 }
 return out;
}

// Redirects for a set of requested ids, in bounded rounds (one query per chunk per round). A chain that loops or runs past the depth is reported, never followed.
export async function resolveRedirects(env,requested){
 const db=database(env);
 const list=ids(requested,FILM);
 const state=new Map(list.map(id=>[id,{id,chain:[],seen:new Set([id]),state:'direct'}]));
 let open=[...state.values()];
 for(let round=0;round<CANONICAL_REDIRECT_DEPTH&&open.length;round++){
  const rows=await chunked(db,'SELECT from_id,to_film_id FROM film_redirect WHERE from_id IN (/*ids*/)',[...new Set(open.map(item=>item.id))]);
  const next=new Map(rows.map(row=>[row.from_id,row.to_film_id]));
  const still=[];
  for(const item of open){
   const target=next.get(item.id);
   if(target===undefined)continue;
   if(item.seen.has(target)){item.state='cycle';continue;}
   item.chain.push(item.id);item.seen.add(target);item.id=target;item.state='redirected';still.push(item);
  }
  open=still;
 }
 for(const item of open){
  const rows=await chunked(db,'SELECT from_id FROM film_redirect WHERE from_id IN (/*ids*/)',[item.id]);
  if(rows.length)item.state='too_deep';
 }
 return new Map([...state].map(([requestedId,item])=>[requestedId,{id:item.id,chain:item.chain,state:item.state}]));
}

// Films by id set: the canonical record, typed external ids, aliases, metadata, watchlist membership, credits with the resolved name of each Person.
// The result is {generation, items: Map(requestedId -> view | null)}. An id that is a redirect answers its survivor with the chain; a loop or a too
// deep chain answers {state:'cycle'|'too_deep'}; an unknown id answers null.
export async function readFilms(env,requested){
 const gate=await gateD1(env);
 const db=database(env);
 const list=ids(requested,FILM);
 const redirects=await resolveRedirects(env,list);
 const targets=[...new Set([...redirects.values()].filter(item=>item.state==='direct'||item.state==='redirected').map(item=>item.id))];
 const [rows,externals,aliases,metadata,credits,titles]=await Promise.all([
  chunked(db,'SELECT f.id,f.canonical_identity,f.original_title,f.contract_version,COALESCE(r.revision,0) revision,(SELECT 1 FROM watchlist_film w WHERE w.film_id=f.id) in_watchlist FROM film f LEFT JOIN canonical_revision r ON r.kind=\'film\' AND r.id=f.id WHERE f.id IN (/*ids*/)',targets),
  chunked(db,'SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE film_id IN (/*ids*/) ORDER BY film_id,scheme,value',targets),
  chunked(db,'SELECT film_id,kind,value FROM film_alias WHERE film_id IN (/*ids*/) ORDER BY film_id,kind,value',targets),
  chunked(db,'SELECT film_id,year,runtime,genres_json,url FROM film_metadata WHERE film_id IN (/*ids*/)',targets),
  chunked(db,'SELECT film_id,person_id,role,ordinal FROM film_person_credit WHERE film_id IN (/*ids*/) ORDER BY film_id,role DESC,ordinal',targets),
  resolved(env,db,'film',targets),
 ]);
 const people=await resolved(env,db,'person',[...new Set(credits.map(row=>row.person_id))]);
 await confirm(env,gate);
 const byExternal=group(externals,'film_id'),byAlias=group(aliases,'film_id'),byCredit=group(credits,'film_id'),byMeta=new Map(metadata.map(row=>[row.film_id,row]));
 const views=new Map(rows.map(row=>{
  const meta=byMeta.get(row.id);
  let genres=[];try{genres=JSON.parse(meta?.genres_json||'[]');}catch{}
  return [row.id,{
   id:row.id,canonicalIdentity:row.canonical_identity??null,originalTitle:row.original_title??null,contractVersion:row.contract_version,revision:Number(row.revision),
   title:titles.get(row.id),
   externalIds:(byExternal.get(row.id)||[]).map(item=>({scheme:item.scheme,value:String(item.value),trusted:flag(item.trusted),conflicting:flag(item.conflicting)})),
   aliases:(byAlias.get(row.id)||[]).map(item=>({kind:item.kind,value:item.value})),
   metadata:meta?{year:meta.year??null,runtime:meta.runtime??null,genres,url:meta.url??null}:null,
   inWatchlist:flag(row.in_watchlist),
   credits:(byCredit.get(row.id)||[]).map(item=>({personId:item.person_id,role:item.role,ordinal:item.ordinal,name:people.get(item.person_id)})),
  }];
 }));
 const items=new Map();
 for(const id of list){
  const redirect=redirects.get(id);
  if(redirect.state==='cycle'||redirect.state==='too_deep'){items.set(id,{state:redirect.state,chain:redirect.chain});continue;}
  const view=views.get(redirect.id);
  items.set(id,view?{...view,requested:id,redirect:redirect.state==='redirected'?{chain:redirect.chain,to:redirect.id}:null}:null);
 }
 return {generation:gate.generation,items};
}

const personRole=id=>id.slice('person:'.length,id.indexOf('/'));
// Persons by id set: the role-specific record, typed external ids, aliases, the resolved name and a bounded filmography (CANONICAL_FILMOGRAPHY_CAP
// credit rows for the whole call, `truncated` says so). The film titles of the filmography are resolved in bulk with the same precedence.
export async function readPersons(env,requested){
 const gate=await gateD1(env);
 const db=database(env);
 const list=ids(requested,PERSON);
 const [rows,externals,aliases,credits,names]=await Promise.all([
  chunked(db,'SELECT p.id,p.role_id,p.contract_version,COALESCE(r.revision,0) revision FROM person p LEFT JOIN canonical_revision r ON r.kind=\'person\' AND r.id=p.id WHERE p.id IN (/*ids*/)',list),
  chunked(db,'SELECT person_id,scheme,value,trusted,conflicting FROM person_external_id WHERE person_id IN (/*ids*/) ORDER BY person_id,scheme,value',list),
  chunked(db,'SELECT person_id,kind,value FROM person_alias WHERE person_id IN (/*ids*/) ORDER BY person_id,kind,value',list),
  boundedCredits(db,list),
  resolved(env,db,'person',list),
 ]);
 const films=await resolved(env,db,'film',[...new Set(credits.rows.map(row=>row.film_id))]);
 await confirm(env,gate);
 const byExternal=group(externals,'person_id'),byAlias=group(aliases,'person_id'),byCredit=group(credits.rows,'person_id');
 const items=new Map(list.map(id=>[id,null]));
 for(const row of rows){
  items.set(row.id,{
   id:row.id,role:personRole(row.id),source:row.id.startsWith('person:tmdb_')?'tmdb':'letterboxd',roleId:row.role_id,contractVersion:row.contract_version,revision:Number(row.revision),
   name:names.get(row.id),
   externalIds:(byExternal.get(row.id)||[]).map(item=>({scheme:item.scheme,value:String(item.value),trusted:flag(item.trusted),conflicting:flag(item.conflicting)})),
   aliases:(byAlias.get(row.id)||[]).map(item=>({kind:item.kind,value:item.value})),
   filmography:(byCredit.get(row.id)||[]).map(item=>({filmId:item.film_id,role:item.role,ordinal:item.ordinal,title:films.get(item.film_id)})),
  });
 }
 return {generation:gate.generation,truncated:credits.truncated,items};
}
async function boundedCredits(db,list){
 if(!list.length)return {rows:[],truncated:false};
 const rows=[];
 for(let at=0;at<list.length;at+=CANONICAL_READ_CHUNK){
  const chunk=list.slice(at,at+CANONICAL_READ_CHUNK),room=CANONICAL_FILMOGRAPHY_CAP+1-rows.length;
  if(room<=0)break;
  try{rows.push(...await many(db,'SELECT person_id,film_id,role,ordinal FROM film_person_credit WHERE person_id IN ('+chunk.map(()=>'?').join(',')+') ORDER BY person_id,role,ordinal,film_id LIMIT ?',[...chunk,room]));}
  catch(error){throw failed('canonical_read_unavailable',error);}
 }
 const truncated=rows.length>CANONICAL_FILMOGRAPHY_CAP;
 return {rows:truncated?rows.slice(0,CANONICAL_FILMOGRAPHY_CAP):rows,truncated};
}
