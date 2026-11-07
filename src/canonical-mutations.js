// AIR-367 / ADR 0099 (Accepted). Fenced canonical Film/Person mutations over the D1 binding. Every mutation is ONE D1 batch whose first
// statements prove (a) the authority marker is `d1`/`open` at the generation the caller read and (b) the expected revision of every
// entity it touches; a statement that proves false sets film_person_cas.ok to 0, the CHECK fails and the batch rolls back whole. There is
// no partial write and no blind retry: a lost fence or revision is a retryable conflict the caller resolves by reading again.
// While the marker is r2 or prepared (and in legacy, held or unreadable states) no mutation reaches the database: the projector stays
// the only writer. Nothing here is bundled into the Worker, scores a candidate, or writes localization, dimensions, metadata, the
// watchlist link, a fingerprint or a prediction (a reviewed or owner value is never touched). Credits are keyed upserts: an existing
// (film, person, role) keeps its ordinal, a new one is appended or takes a free explicit ordinal, nothing is renumbered, and the
// D1-only TMDB credits (AIR-286) are never deleted by a roster write.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';

export const MUTATION_STATEMENT_CAP=60;
const FILM_ID=/^film:.+/;
const PERSON_ID=/^person:.+/;
const ROLES=new Set(['director','actor']);

// An assertion is an upsert of ok = 1 or 0. Its value also requires the fence row to exist when the statement runs: a deleted row gives
// ok = 0 and the CHECK fails, where a zero-row UPDATE would pass silently and let the batch commit without any proven assertion.
const assertSql=(condition)=>'INSERT INTO film_person_cas (id,ok) VALUES (1,(SELECT CASE WHEN EXISTS (SELECT 1 FROM film_person_cas WHERE id=1) AND ('+condition+') THEN 1 ELSE 0 END)) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
const FENCE=assertSql("EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)");
const REVISION=assertSql('COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0)=?');
const BUMP='INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES (?,?,1,?) ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1, updated_at=excluded.updated_at';

function filmId(value){if(typeof value!=='string'||!FILM_ID.test(value))throw failed('film_person_invalid');return value;}
function personId(value){if(typeof value!=='string'||!PERSON_ID.test(value))throw failed('film_person_invalid');return value;}
function revisionOf(value){if(!Number.isInteger(value)||value<0)throw failed('film_person_invalid');return value;}
function text(value){if(typeof value!=='string'||!value)throw failed('film_person_invalid');return value;}
const json=value=>value===undefined||value===null?null:JSON.stringify(value);
function trustedFlag(item){return item?.trusted&&!item?.conflicting?1:0;}

// AIR-368: the automatic localization source table exists from schema 14. A merge adopts the retired Film's rows only where it can.
async function hasSourceTable(db){return !!(await one(db,"SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='film_localization_source'"));}

async function current(db,kind,id){return Number((await one(db,'SELECT revision FROM canonical_revision WHERE kind=? AND id=?',[kind,id]))?.revision??0);}

// Runs the statements as one batch and names the failure. After a failed batch the marker and the revisions are read again, so the
// error says whether the authority moved, an entity moved, or the data itself refused (a trusted id, an ordinal, a missing person).
async function commit(env,gate,statements,entities){
 const db=database(env);
 if(!db||typeof db.batch!=='function')throw failed('film_person_unavailable');
 if(statements.length>MUTATION_STATEMENT_CAP)throw failed('film_person_bounded');
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));}
 catch(error){
  const message=String(error?.message||error);
  if(/CHECK constraint failed/i.test(message)){
   let again;
   try{again=await readAuthority(env);}catch{throw failed('film_person_unavailable',error);}
   if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_fence',error);
   for(const entity of entities){
    if(await current(db,entity.kind,entity.id)!==entity.expected)throw failed('film_person_revision_conflict',error);
   }
   throw failed('film_person_precondition',error);
  }
  if(/UNIQUE constraint failed: film_external_id/i.test(message))throw failed('identity_collision',error);
  if(/UNIQUE constraint failed: film_person_credit|UNIQUE constraint failed: index 'film_person_credit_order'/i.test(message))throw failed('credit_ordinal_conflict',error);
  if(/UNIQUE constraint failed: person\.role_id/i.test(message))throw failed('person_role_collision',error);
  if(/FOREIGN KEY constraint failed/i.test(message))throw failed('film_person_reference',error);
  throw failed('film_person_unavailable',error);
 }
}

// The pieces the other fenced writers of the canonical domain reuse (the localization source writer); not a second API.
export const fenced={assertSql,FENCE,REVISION,BUMP,head:(gate,entities)=>head(gate,entities),commit:(env,gate,statements,entities)=>commit(env,gate,statements,entities),filmId,personId,revisionOf,text,json};

function head(gate,entities){
 const out=[[FENCE,[gate.generation]]];
 for(const entity of entities)out.push([REVISION,[entity.kind,entity.id,entity.expected]]);
 return out;
}

// One Film: its row, typed external ids, aliases and credits. Absent fields are left as they are.
// input: {id, expectedRevision, at, film:{contractVersion, canonicalIdentity?, originalTitle?, externalIds?, removeExternalIds?, aliases?},
//         credits?:{upsert?:[{personId,role,ordinal?}], remove?:[{personId,role}]}}
export async function mutateFilm(env,input){
 const id=filmId(input?.id),expected=revisionOf(input?.expectedRevision),at=text(input?.at),film=input?.film||{};
 if(!Number.isInteger(film.contractVersion))throw failed('film_person_invalid');
 const gate=assertWritable(await readAuthority(env));
 const db=database(env);
 const redirect=await one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[id]);
 if(redirect)throw failed('film_person_redirect');
 const entities=[{kind:'film',id,expected}];
 const statements=head(gate,entities);
 statements.push([assertSql('NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id]]);
 statements.push(['INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET contract_version=excluded.contract_version,canonical_identity=COALESCE(excluded.canonical_identity,film.canonical_identity),original_title=COALESCE(excluded.original_title,film.original_title),updated_at=excluded.updated_at',[id,film.contractVersion,film.canonicalIdentity??null,film.originalTitle??null,at]]);
 for(const item of film.removeExternalIds||[])statements.push(['DELETE FROM film_external_id WHERE film_id=? AND scheme=? AND value=?',[id,text(item.scheme),String(item.value)]]);
 for(const item of film.externalIds||[])statements.push(['INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (?,?,?,?,?,?) ON CONFLICT(film_id,scheme,value) DO UPDATE SET trusted=excluded.trusted,conflicting=excluded.conflicting,provenance_json=excluded.provenance_json',[id,text(item.scheme),String(item.value),trustedFlag(item),item.conflicting?1:0,json(item.provenance)]]);
 for(const item of film.aliases||[])statements.push(['INSERT INTO film_alias (film_id,kind,value,provenance_json) VALUES (?,?,?,?) ON CONFLICT(film_id,kind,value) DO NOTHING',[id,item.kind||'title',text(item.value),json(item.provenance)]]);
 for(const item of input.credits?.remove||[]){
  if(!ROLES.has(item.role))throw failed('film_person_invalid');
  statements.push(['DELETE FROM film_person_credit WHERE film_id=? AND person_id=? AND role=?',[id,personId(item.personId),item.role]]);
 }
 for(const item of input.credits?.upsert||[]){
  if(!ROLES.has(item.role))throw failed('film_person_invalid');
  const person=personId(item.personId);
  if(item.ordinal!==undefined&&(!Number.isInteger(item.ordinal)||item.ordinal<0))throw failed('film_person_invalid');
  // An existing credit keeps its ordinal. A new one without an ordinal is appended after the highest of its role.
  statements.push(['INSERT INTO film_person_credit (film_id,person_id,role,ordinal) SELECT ?,?,?,COALESCE(?,(SELECT COALESCE(MAX(ordinal),-1)+1 FROM film_person_credit WHERE film_id=? AND role=?)) WHERE NOT EXISTS (SELECT 1 FROM film_person_credit WHERE film_id=? AND person_id=? AND role=?)',[id,person,item.role,item.ordinal??null,id,item.role,id,person,item.role]]);
 }
 statements.push([BUMP,['film',id,at]]);
 await commit(env,gate,statements,entities);
 return {id,revision:expected+1};
}

// One Person: its row, external ids and aliases. A Person has no localization write here (a reviewed or owner name is never touched).
// input: {id, expectedRevision, at, person:{roleId, contractVersion, externalIds?, removeExternalIds?, aliases?}}
export async function mutatePerson(env,input){
 const id=personId(input?.id),expected=revisionOf(input?.expectedRevision),at=text(input?.at),person=input?.person||{};
 if(!Number.isInteger(person.contractVersion))throw failed('film_person_invalid');
 const roleId=text(person.roleId);
 const gate=assertWritable(await readAuthority(env));
 const entities=[{kind:'person',id,expected}];
 const statements=head(gate,entities);
 statements.push(['INSERT INTO person (id,role_id,contract_version,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET role_id=excluded.role_id,contract_version=excluded.contract_version,updated_at=excluded.updated_at',[id,roleId,person.contractVersion,at]]);
 for(const item of person.removeExternalIds||[])statements.push(['DELETE FROM person_external_id WHERE person_id=? AND scheme=? AND value=?',[id,text(item.scheme),String(item.value)]]);
 for(const item of person.externalIds||[])statements.push(['INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting,provenance_json) VALUES (?,?,?,?,?,?) ON CONFLICT(person_id,scheme,value) DO UPDATE SET trusted=excluded.trusted,conflicting=excluded.conflicting,provenance_json=excluded.provenance_json',[id,text(item.scheme),String(item.value),trustedFlag(item),item.conflicting?1:0,json(item.provenance)]]);
 for(const item of person.aliases||[])statements.push(['INSERT INTO person_alias (person_id,kind,value,provenance_json) VALUES (?,?,?,?) ON CONFLICT(person_id,kind,value) DO NOTHING',[id,item.kind||'name',text(item.value),json(item.provenance)]]);
 statements.push([BUMP,['person',id,at]]);
 await commit(env,gate,statements,entities);
 return {id,revision:expected+1};
}

// A merge of one Film into another: a redirect from the retired id to the survivor, with the retired Film's aliases, credits, external ids,
// membership, metadata, dimensions and sync clocks adopted by the survivor or refused, never silently dropped (see `reconcile` below). It touches two entities and proves both revisions, that the survivor is not itself a redirect
// (no chain grows, no cycle forms), that the retired Film is not already redirected and has no generation or EPG history, all in the same
// batch. Different trusted values of one scheme need `evidence.verified === true` (ADR 0009); `tmdb` and `tmdb_tv` are different schemes.
// input: {from, to, expected:{from, to}, at, evidence?:{verified?}, resolve?:{metadata?, identity?, metadataState?, localization?, fingerprint?,
// prediction?, sync?}} where a value is 'survivor' or 'retired' (and 'newest' for sync): the caller's explicit choice when both Films hold
// different data of that kind. A repeated merge of an already
// redirected id is a no-op.
export async function mergeFilms(env,input){
 const from=filmId(input?.from),to=filmId(input?.to),at=text(input?.at);
 if(from===to)throw failed('film_person_invalid');
 const expectedFrom=revisionOf(input?.expected?.from),expectedTo=revisionOf(input?.expected?.to);
 const gate=assertWritable(await readAuthority(env));
 const db=database(env);
 const existing=await one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[from]);
 if(existing){
  if(existing.to_film_id===to)return {merged:false,already:true,from,to};
  throw failed('film_person_redirect_conflict');
 }
 if(await one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[to]))throw failed('film_person_redirect');
 const [fromRow,toRow]=await Promise.all([one(db,'SELECT id FROM film WHERE id=?',[from]),one(db,'SELECT id FROM film WHERE id=?',[to])]);
 if(!fromRow||!toRow)throw failed('film_person_reference');
 const [fromIds,toIds]=await Promise.all([many(db,'SELECT scheme,value FROM film_external_id WHERE film_id=? AND trusted=1 AND conflicting=0',[from]),many(db,'SELECT scheme,value FROM film_external_id WHERE film_id=? AND trusted=1 AND conflicting=0',[to])]);
 for(const left of fromIds)for(const right of toIds){
  if(left.scheme===right.scheme&&String(left.value)!==String(right.value)&&input?.evidence?.verified!==true)throw failed('film_person_identity_conflict');
 }
 const entities=[{kind:'film',id:from,expected:expectedFrom},{kind:'film',id:to,expected:expectedTo}];
 const s=head(gate,entities);
 s.push([assertSql('NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[to]]);
 s.push([assertSql('NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[from]]);
 s.push([assertSql('NOT EXISTS (SELECT 1 FROM film_generation WHERE film_id=?) AND NOT EXISTS (SELECT 1 FROM film_epg_last_airing WHERE film_id=?)'),[from,from]]);
 // External ids move as untrusted copies first, then the retired Film's rows go, then the trusted ones are restored on the survivor, so
 // the one-trusted-owner index is never violated and a different owner of the same trusted value still refuses the batch.
 s.push(['INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) SELECT ?,scheme,value,0,conflicting,provenance_json FROM film_external_id WHERE film_id=? ON CONFLICT(film_id,scheme,value) DO NOTHING',[to,from]]);
 s.push(['DELETE FROM film_external_id WHERE film_id=?',[from]]);
 for(const item of fromIds)s.push(['UPDATE film_external_id SET trusted=1 WHERE film_id=? AND scheme=? AND value=? AND conflicting=0',[to,item.scheme,String(item.value)]]);
 s.push(['INSERT INTO film_alias (film_id,kind,value,provenance_json) SELECT ?,kind,value,provenance_json FROM film_alias WHERE film_id=? ON CONFLICT(film_id,kind,value) DO NOTHING',[to,from]]);
 // The survivor's own credits keep their ordinals; the retired Film's credits follow them in their own order (their ordinal plus the survivor's next free one), so no ordinal collides however the statement is evaluated.
 s.push(['INSERT INTO film_person_credit (film_id,person_id,role,ordinal) SELECT ?,c.person_id,c.role,c.ordinal+(SELECT COALESCE(MAX(s.ordinal),-1)+1 FROM film_person_credit s WHERE s.film_id=? AND s.role=c.role) FROM film_person_credit c WHERE c.film_id=? AND NOT EXISTS (SELECT 1 FROM film_person_credit s WHERE s.film_id=? AND s.person_id=c.person_id AND s.role=c.role)',[to,to,from,to]]);
 s.push(["INSERT INTO localization_conflict (id,entity_kind,entity_id,value,source,provenance_json,authority,reason,at) SELECT 'film:'||?||':'||json_object('reason',reason,'value',value,'source',source),'film',?,value,source,provenance_json,authority,reason,at FROM localization_conflict WHERE entity_kind='film' AND entity_id=? ON CONFLICT(id) DO NOTHING",[to,to,from]]);
 s.push(['INSERT INTO watchlist_film (film_id,updated_at) SELECT ?,updated_at FROM watchlist_film WHERE film_id=? ON CONFLICT(film_id) DO NOTHING',[to,from]]);
 s.push(['UPDATE film_redirect SET to_film_id=? WHERE to_film_id=? AND from_id<>?',[to,from,to]]);
 // Automatic localization sources (schema 14): the survivor keeps its own row per source unless the retired Film observed that source later.
 const sources=await hasSourceTable(db);
 if(sources)s.push(['INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) SELECT ?,source,value,source_version,provenance_json,request_id,observed_at,? FROM film_localization_source WHERE film_id=? ON CONFLICT(film_id,source) DO UPDATE SET value=excluded.value,source_version=excluded.source_version,provenance_json=excluded.provenance_json,request_id=excluded.request_id,observed_at=excluded.observed_at,updated_at=excluded.updated_at WHERE excluded.observed_at>film_localization_source.observed_at',[to,at,from]]);
 const discarded=[];
 for(const item of await reconcile(db,from,to,input?.resolve||{},at,discarded))s.push(item);
 for(const sql of [
  'DELETE FROM film_person_credit WHERE film_id=?',
  'DELETE FROM film_alias WHERE film_id=?',
  ...(sources?['DELETE FROM film_localization_source WHERE film_id=?']:[]),
  'DELETE FROM film_metadata WHERE film_id=?',
  'DELETE FROM film_dimension WHERE film_id=?',
  'DELETE FROM film_sync_state WHERE film_id=?',
  'DELETE FROM watchlist_film WHERE film_id=?',
  "DELETE FROM localization_conflict WHERE entity_kind='film' AND entity_id=?",
  'DELETE FROM film WHERE id=?',
 ])s.push([sql,[from]]);
 s.push(['INSERT INTO film_redirect (from_id,to_film_id,at) VALUES (?,?,?)',[from,to,at]]);
 s.push([BUMP,['film',to,at]]);
 s.push([BUMP,['film',from,at]]);
 await commit(env,gate,s,entities);
 return {merged:true,from,to,revisions:{from:expectedFrom+1,to:expectedTo+1},discarded};
}

// What the retired Film holds that the survivor would lose. Nothing is dropped silently: a difference is moved, shown to be covered, or refused
// until the caller names a side, and a chosen side that discards data is reported in `discarded`.
// - film_metadata: moved when the survivor has none; dropped when identical; otherwise refused unless `resolve.metadata` is 'survivor' or 'retired'.
// - film_dimension: a row the survivor lacks is moved; an identical one is dropped. A different identity, metadata (lifecycle), fingerprint or
//   prediction row is refused unless `resolve.identity`, `.metadataState`, `.fingerprint` or `.prediction` is 'survivor' or 'retired' (the identity
//   row carries the source version and provenance of corrections). A different localization: the survivor keeps its own and a
//   localization_conflict row records the other, except that a reviewed or owner value of the retired Film that the survivor would not keep is
//   refused unless `resolve.localization` chose.
// - film_sync_state: moved when the survivor has none. When both exist and differ the retired row is dropped only if it adds nothing: every one of
//   its clocks is null or covered by the survivor's (equal, or older with the survivor holding one), and the survivor's metadata body stands. A clock
//   the retired row holds that the survivor does not cover (newer, or the survivor's is null), or a body that came from the retired Film, is refused
//   unless `resolve.sync` is 'survivor', 'retired' or 'newest' (the field-wise newest non-null value). A missing row and null clocks differ (ADR 0070).
const SYNC_FIELDS=['metadata_at','synopsis_fetched_at','people_names_version','people_localized_at'];
const SYNC_SELECT='SELECT metadata_at,synopsis_fetched_at,people_names_version,people_localized_at FROM film_sync_state WHERE film_id=?';
function covers(survivor,retired){
 if(retired===null||retired===undefined)return true;
 if(survivor===null||survivor===undefined)return false;
 return survivor>=retired;
}
function newest(left,right){
 if(left===null||left===undefined)return right??null;
 if(right===null||right===undefined)return left;
 return left>=right?left:right;
}
async function reconcile(db,from,to,resolve,at,discarded){
 const out=[];
 const choice=(kind,allowed=['survivor','retired'])=>{const value=resolve?.[kind];if(value!==undefined&&!allowed.includes(value))throw failed('film_person_invalid');return value;};
 const [fromMeta,toMeta]=await Promise.all([one(db,'SELECT payload_json,content_sha256 FROM film_metadata WHERE film_id=?',[from]),one(db,'SELECT payload_json,content_sha256 FROM film_metadata WHERE film_id=?',[to])]);
 let bodyFromRetired=false;
 if(fromMeta){
  if(!toMeta){out.push(['UPDATE film_metadata SET film_id=? WHERE film_id=?',[to,from]]);bodyFromRetired=true;}
  else if(fromMeta.payload_json!==toMeta.payload_json||fromMeta.content_sha256!==toMeta.content_sha256){
   const pick=choice('metadata');
   if(!pick)throw failed('film_person_data_conflict');
   if(pick==='retired'){out.push(['DELETE FROM film_metadata WHERE film_id=?',[to]]);out.push(['UPDATE film_metadata SET film_id=? WHERE film_id=?',[to,from]]);discarded.push('metadata:survivor');bodyFromRetired=true;}
   else discarded.push('metadata:retired');
  }
 }
 const [fromDims,toDims]=await Promise.all([many(db,'SELECT * FROM film_dimension WHERE film_id=?',[from]),many(db,'SELECT * FROM film_dimension WHERE film_id=?',[to])]);
 const held=new Map(toDims.map(row=>[row.dimension,row]));
 const same=(left,right)=>['status','source','source_version','provenance_json','value','authority'].every(key=>(left[key]??null)===(right[key]??null));
 const strong=row=>!!row&&(row.status==='reviewed'||row.authority==='owner');
 const KEY={identity:'identity',metadata:'metadataState',fingerprint:'fingerprint',prediction:'prediction'};
 for(const row of fromDims){
  const other=held.get(row.dimension);
  const move=()=>out.push(['UPDATE film_dimension SET film_id=? WHERE film_id=? AND dimension=?',[to,from,row.dimension]]);
  if(!other){move();continue;}
  if(same(row,other))continue;
  if(row.dimension==='localization'){
   const pick=choice('localization');
   const conflict=(value,source,provenance,authority,reason)=>out.push(["INSERT INTO localization_conflict (id,entity_kind,entity_id,value,source,provenance_json,authority,reason,at) VALUES (?,'film',?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",['film-merge:'+to+':'+from+':'+reason,to,value??null,source??null,provenance??null,authority??null,reason,at]]);
   if(pick==='retired'){out.push(['DELETE FROM film_dimension WHERE film_id=? AND dimension=?',[to,'localization']]);move();conflict(other.value,other.source,other.provenance_json,other.authority,'merge_kept_retired');discarded.push('localization:survivor');continue;}
   // Without a choice the survivor keeps its own value and the other is recorded as a conflict, unless the retired Film's value is reviewed or owner: then it would be lost and the batch is refused.
   if(pick==='survivor'||(!pick&&!strong(row))){conflict(row.value,row.source,row.provenance_json,row.authority,'merge_kept_survivor');if(pick==='survivor')discarded.push('localization:retired');continue;}
   throw failed('film_person_data_conflict');
  }
  const kind=KEY[row.dimension];
  if(!kind)throw failed('film_person_data_conflict');
  const pick=choice(kind);
  if(!pick)throw failed('film_person_data_conflict');
  if(pick==='retired'){out.push(['DELETE FROM film_dimension WHERE film_id=? AND dimension=?',[to,row.dimension]]);move();discarded.push(row.dimension+':survivor');}
  else discarded.push(row.dimension+':retired');
 }
 const [fromSync,toSync]=await Promise.all([one(db,SYNC_SELECT,[from]),one(db,SYNC_SELECT,[to])]);
 if(fromSync){
  if(!toSync)out.push(['UPDATE film_sync_state SET film_id=? WHERE film_id=?',[to,from]]);
  else if(!SYNC_FIELDS.every(key=>(fromSync[key]??null)===(toSync[key]??null))){
   const covered=!bodyFromRetired&&SYNC_FIELDS.every(key=>covers(toSync[key],fromSync[key]));
   if(!covered){
    const pick=choice('sync',['survivor','retired','newest']);
    if(!pick)throw failed('film_person_data_conflict');
    if(pick==='retired'){out.push(['DELETE FROM film_sync_state WHERE film_id=?',[to]]);out.push(['UPDATE film_sync_state SET film_id=? WHERE film_id=?',[to,from]]);discarded.push('sync:survivor');}
    else if(pick==='newest'){out.push(['UPDATE film_sync_state SET metadata_at=?,synopsis_fetched_at=?,people_names_version=?,people_localized_at=? WHERE film_id=?',[...SYNC_FIELDS.map(key=>newest(toSync[key],fromSync[key])),to]]);discarded.push('sync:merged');}
    else discarded.push('sync:retired');
   }
  }
 }
 return out;
}
