// AIR-70. Local D1 repository for canonical Film and Person records.
// The Worker does not import this file. The caller supplies the database and the domain result.
// R2 stays authoritative. This module does not score a candidate or choose shows.

export function createCanonicalRepository(db){
 return {
  saveFilm:input=>saveFilm(db,input),
  savePerson:input=>savePerson(db,input),
  applyLink:input=>applyLink(db,input),
  readFilm:id=>readFilm(db,id),
  readPerson:id=>readPerson(db,id),
 };
}

async function saveFilm(db,input){
 const plan=await planFilm(db,input);
 await db.transaction(async()=>{await writeFilm(db,plan);});
 return readFilm(db,plan.film.id);
}

async function savePerson(db,input){
 const plan=await planPerson(db,input);
 await db.transaction(async()=>{await writePerson(db,plan);});
 return readPerson(db,plan.person.id);
}

async function applyLink(db,input){
 const survivor=input?.survivor;
 if(!survivor?.id)throw new Error('survivor is required');
 const redirect=input.redirect??null;
 if(redirect&&redirect.to!==survivor.id)throw new Error('Redirect target must be the survivor');
 const survivorListed=await db.get('SELECT 1 AS ok FROM watchlist_film WHERE film_id=?',[survivor.id]);
 const retiredListed=redirect?await db.get('SELECT 1 AS ok FROM watchlist_film WHERE film_id=?',[redirect.from]):null;
 const watchlist=input.watchlist===true?true:input.watchlist===false?false:(survivorListed||retiredListed?true:null);
 const plan=await planFilm(db,{...input,film:survivor,watchlist,releasing:redirect?.from??null});
 const retirement=redirect?await planRetirement(db,redirect):null;
 await db.transaction(async()=>{
  if(retirement?.release)await db.run('DELETE FROM film_external_id WHERE film_id=?',[retirement.from]);
  await writeFilm(db,plan);
  if(retirement?.release)await retireFilm(db,retirement);
 });
 return readFilm(db,plan.film.id);
}

async function planFilm(db,input){
 const film=input?.film;
 const id=requiredFilm(film?.id);
 if(await db.get('SELECT to_film_id FROM film_redirect WHERE from_id=?',[id]))throw new Error('Film id is a redirect');
 const stored=await dimensionRow(db,'film_dimension','film_id',id,'localization');
 const guarded=guardReviewed(film,stored,'title');
 for(const item of guarded.externalIds||[]){
  if(!item?.trusted||item.conflicting)continue;
  const owner=await db.get('SELECT film_id FROM film_external_id WHERE scheme=? AND value=? AND trusted=1 AND conflicting=0',[item.scheme,String(item.value)]);
  if(owner&&owner.film_id!==id&&owner.film_id!==input.releasing)throw new Error('identity_collision');
 }
 const watchlist=input.watchlist===true?true:input.watchlist===false?false:null;
 return {film:guarded,metadata:input.metadata===undefined?undefined:input.metadata,credits:input.credits||[],watchlist,updatedAt:updatedAtOf(guarded)};
}

async function planPerson(db,input){
 const person=input?.person;
 const id=requiredPerson(person?.id);
 const stored=await dimensionRow(db,'person_dimension','person_id',id,'localization');
 const guarded=guardReviewed(person,stored,'name');
 return {person:guarded,updatedAt:updatedAtOf(guarded)};
}

async function planRetirement(db,redirect){
 const from=requiredFilm(redirect?.from),to=requiredFilm(redirect?.to);
 if(from===to)throw new Error('Redirect cannot target itself');
 const current=await db.get('SELECT to_film_id FROM film_redirect WHERE from_id=?',[from]);
 if(current&&current.to_film_id!==to)throw new Error('Redirect target conflicts');
 if(await db.get('SELECT 1 AS ok FROM film_generation WHERE film_id=?',[from]))throw new Error('Redirected film already belongs to a generation');
 if(await db.get('SELECT 1 AS ok FROM film_epg_last_airing WHERE film_id=?',[from]))throw new Error('Redirected film has EPG history');
 return {from,to,at:required(redirect.at,'redirect.at'),release:!current};
}

async function writeFilm(db,plan){
 const film=plan.film;
 await db.run('INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET contract_version=excluded.contract_version,canonical_identity=excluded.canonical_identity,original_title=excluded.original_title,updated_at=excluded.updated_at',[film.id,film.contractVersion,film.canonicalIdentity??null,film.originalTitle??null,plan.updatedAt]);
 await db.run('DELETE FROM film_external_id WHERE film_id=?',[film.id]);
 await db.run('DELETE FROM film_alias WHERE film_id=?',[film.id]);
 await db.run('DELETE FROM film_dimension WHERE film_id=?',[film.id]);
 await db.run('DELETE FROM film_person_credit WHERE film_id=?',[film.id]);
 for(const item of film.externalIds||[])await db.run('INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (?,?,?,?,?,?)',[film.id,required(item.scheme,'scheme'),String(item.value),item.trusted&&!item.conflicting?1:0,item.conflicting?1:0,json(item.provenance)]);
 for(const item of film.aliases||[])await db.run('INSERT INTO film_alias (film_id,kind,value,provenance_json) VALUES (?,?,?,?)',[film.id,item.kind||'title',required(item.value,'alias'),json(item.provenance)]);
 for(const dimension of ['identity','metadata','localization','fingerprint','prediction'])await db.run('INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',dimensionParams(film.id,film[dimension]));
 for(const credit of plan.credits){
  if(credit.role!=='director'&&credit.role!=='actor')throw new Error('Credit role is invalid');
  await db.run('INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES (?,?,?,?)',[film.id,requiredPerson(credit.personId),credit.role,credit.ordinal]);
 }
 if(plan.metadata===null)await db.run('DELETE FROM film_metadata WHERE film_id=?',[film.id]);
 if(plan.metadata)await db.run('INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET schema_version=excluded.schema_version,year=excluded.year,runtime=excluded.runtime,synopsis=excluded.synopsis,poster=excluded.poster,url=excluded.url,genres_json=excluded.genres_json,people_version=excluded.people_version,payload_json=excluded.payload_json,r2_key=excluded.r2_key,content_sha256=excluded.content_sha256,updated_at=excluded.updated_at',metadataParams(film.id,plan.metadata));
 if(plan.watchlist===true)await db.run('INSERT INTO watchlist_film (film_id,updated_at) VALUES (?,?) ON CONFLICT(film_id) DO UPDATE SET updated_at=excluded.updated_at',[film.id,plan.updatedAt]);
 if(plan.watchlist===false)await db.run('DELETE FROM watchlist_film WHERE film_id=?',[film.id]);
 for(const conflict of film.localizationConflicts||[])await db.run('INSERT INTO localization_conflict (id,entity_kind,entity_id,value,source,provenance_json,authority,reason,at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',conflictParams('film',film.id,conflict));
}

async function writePerson(db,plan){
 const person=plan.person;
 await db.run('INSERT INTO person (id,role_id,contract_version,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET role_id=excluded.role_id,contract_version=excluded.contract_version,updated_at=excluded.updated_at',[person.id,required(person.roleId,'roleId'),person.contractVersion,plan.updatedAt]);
 await db.run('DELETE FROM person_external_id WHERE person_id=?',[person.id]);
 await db.run('DELETE FROM person_alias WHERE person_id=?',[person.id]);
 await db.run('DELETE FROM person_dimension WHERE person_id=?',[person.id]);
 for(const item of person.externalIds||[])await db.run('INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting,provenance_json) VALUES (?,?,?,?,?,?)',[person.id,required(item.scheme,'scheme'),String(item.value),item.trusted&&!item.conflicting?1:0,item.conflicting?1:0,json(item.provenance)]);
 for(const item of person.aliases||[])await db.run('INSERT INTO person_alias (person_id,kind,value,provenance_json) VALUES (?,?,?,?)',[person.id,item.kind||'name',required(item.value,'alias'),json(item.provenance)]);
 for(const dimension of ['identity','localization'])await db.run('INSERT INTO person_dimension (person_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',dimensionParams(person.id,person[dimension]));
 for(const conflict of person.localizationConflicts||[])await db.run('INSERT INTO localization_conflict (id,entity_kind,entity_id,value,source,provenance_json,authority,reason,at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',conflictParams('person',person.id,conflict));
}

async function retireFilm(db,retirement){
 await db.run('DELETE FROM film_person_credit WHERE film_id=?',[retirement.from]);
 await db.run('DELETE FROM film_metadata WHERE film_id=?',[retirement.from]);
 await db.run('DELETE FROM film_alias WHERE film_id=?',[retirement.from]);
 await db.run('DELETE FROM film_dimension WHERE film_id=?',[retirement.from]);
 await db.run('DELETE FROM watchlist_film WHERE film_id=?',[retirement.from]);
 await db.run('DELETE FROM film WHERE id=?',[retirement.from]);
 await db.run('INSERT INTO film_redirect (from_id,to_film_id,at) VALUES (?,?,?)',[retirement.from,retirement.to,retirement.at]);
}

async function readFilm(db,requested){
 const resolved=await resolveFilm(db,requested);
 const row=await db.get('SELECT id,contract_version,canonical_identity,original_title,updated_at FROM film WHERE id=?',[resolved.id]);
 if(!row)return null;
 const [externalIds,aliases,dimensions,conflicts,metadata,credits,watchlist]=await Promise.all([
  db.all('SELECT scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE film_id=? ORDER BY scheme,value',[resolved.id]),
  db.all('SELECT kind,value,provenance_json FROM film_alias WHERE film_id=? ORDER BY kind,value',[resolved.id]),
  db.all('SELECT dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at FROM film_dimension WHERE film_id=?',[resolved.id]),
  db.all("SELECT value,source,provenance_json,authority,reason,at FROM localization_conflict WHERE entity_kind='film' AND entity_id=? ORDER BY id",[resolved.id]),
  db.get('SELECT schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at FROM film_metadata WHERE film_id=?',[resolved.id]),
  db.all('SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id=? ORDER BY role,ordinal',[resolved.id]),
  db.get('SELECT 1 AS ok FROM watchlist_film WHERE film_id=?',[resolved.id]),
 ]);
 return {id:row.id,contractVersion:row.contract_version,canonicalIdentity:row.canonical_identity,originalTitle:row.original_title,updatedAt:row.updated_at,redirectedFrom:resolved.redirectedFrom,externalIds:externalIds.map(external),aliases:aliases.map(alias),dimensions:Object.fromEntries(dimensions.map(item=>[item.dimension,dimensionView(item)])),conflicts:conflicts.map(conflict),metadata:metadata?metadataView(metadata):null,credits:credits.map(item=>({personId:item.person_id,role:item.role,ordinal:item.ordinal})),watchlist:!!watchlist};
}

async function readPerson(db,id){
 const personId=requiredPerson(id);
 const row=await db.get('SELECT id,role_id,contract_version,updated_at FROM person WHERE id=?',[personId]);
 if(!row)return null;
 const [externalIds,aliases,dimensions,conflicts]=await Promise.all([
  db.all('SELECT scheme,value,trusted,conflicting,provenance_json FROM person_external_id WHERE person_id=? ORDER BY scheme,value',[personId]),
  db.all('SELECT kind,value,provenance_json FROM person_alias WHERE person_id=? ORDER BY kind,value',[personId]),
  db.all('SELECT dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at FROM person_dimension WHERE person_id=?',[personId]),
  db.all("SELECT value,source,provenance_json,authority,reason,at FROM localization_conflict WHERE entity_kind='person' AND entity_id=? ORDER BY id",[personId]),
 ]);
 return {id:row.id,roleId:row.role_id,contractVersion:row.contract_version,updatedAt:row.updated_at,externalIds:externalIds.map(external),aliases:aliases.map(alias),dimensions:Object.fromEntries(dimensions.map(item=>[item.dimension,dimensionView(item)])),conflicts:conflicts.map(conflict)};
}

async function resolveFilm(db,requested){
 let current=requiredFilm(requested),guard=0,redirectedFrom=null;
 while(guard++<8){
  const row=await db.get('SELECT to_film_id FROM film_redirect WHERE from_id=?',[current]);
  if(!row)return {id:current,redirectedFrom};
  redirectedFrom=redirectedFrom||requested;
  current=row.to_film_id;
 }
 throw new Error('Redirect cycle');
}

function guardReviewed(entity,stored,kind){
 if(!stored||stored.status!=='reviewed'||reviewedWrite(entity.localization))return entity;
 const incoming=entity.localization||{};
 const conflicts=[...(entity.localizationConflicts||[])];
 const aliases=[...(entity.aliases||[])];
 if(incoming.value&&incoming.value!==stored.value){
  conflicts.push({value:incoming.value,source:incoming.source||null,provenance:incoming.provenance??null,at:incoming.updatedAt||stored.updated_at,reason:'reviewed_kept'});
  aliases.push({kind,value:incoming.value,provenance:incoming.provenance??null});
 }
 return {...entity,localization:dimensionView(stored),localizationConflicts:conflicts,aliases};
}

function reviewedWrite(state){
 if(state?.status!=='reviewed')return false;
 const authority=state.provenance?.authority||state.sourceVersion||state.source;
 return authority==='dictionary'||authority==='owner'||state.source==='dictionary';
}

function dimensionParams(id,state){
 if(!state?.status||!state.updatedAt)throw new Error('Dimension '+state?.dimension+' is incomplete');
 return [id,state.dimension,state.status,state.source??null,state.sourceVersion??null,json(state.provenance),state.value??null,state.provenance?.authority??null,state.lastError??null,state.failureReason??null,state.retryAt??null,state.attempts??0,state.nextAction??'none',state.updatedAt];
}

function metadataParams(id,metadata){
 return [id,metadata.schemaVersion??1,metadata.year??null,metadata.runtime??null,metadata.synopsis??null,metadata.poster??null,metadata.url??null,JSON.stringify(metadata.genres||[]),metadata.peopleVersion??null,JSON.stringify(metadata.payload??{}),metadata.r2Key??null,metadata.contentSha256??null,required(metadata.updatedAt,'metadata.updatedAt')];
}

function conflictParams(kind,id,conflict){
 const reason=required(conflict.reason,'conflict.reason');
 return [kind+':'+id+':'+JSON.stringify({reason,value:conflict.value??null,source:conflict.source??null}),kind,id,conflict.value??null,conflict.source??null,json(conflict.provenance),conflict.provenance?.authority??null,reason,required(conflict.at,'conflict.at')];
}

function dimensionView(row){
 const state={dimension:row.dimension,status:row.status,updatedAt:row.updated_at,source:row.source,sourceVersion:row.source_version,provenance:parseJson(row.provenance_json),lastError:row.last_error,failureReason:row.failure_reason,retryAt:row.retry_at,attempts:row.attempts,nextAction:row.next_action};
 if(row.dimension==='localization')state.value=row.value;
 return state;
}

function external(row){return {scheme:row.scheme,value:row.value,trusted:row.trusted===1,conflicting:row.conflicting===1,provenance:parseJson(row.provenance_json)};}
function alias(row){return {kind:row.kind,value:row.value,provenance:parseJson(row.provenance_json)};}
function conflict(row){return {value:row.value,source:row.source,provenance:parseJson(row.provenance_json),authority:row.authority,reason:row.reason,at:row.at};}
function metadataView(row){return {schemaVersion:row.schema_version,year:row.year,runtime:row.runtime,synopsis:row.synopsis,poster:row.poster,url:row.url,genres:parseJson(row.genres_json)||[],peopleVersion:row.people_version,payload:parseJson(row.payload_json),r2Key:row.r2_key,contentSha256:row.content_sha256,updatedAt:row.updated_at};}
function updatedAtOf(entity){return entity.localization?.updatedAt||entity.identity?.updatedAt;}
function json(value){return value==null?null:JSON.stringify(value);}
function parseJson(value){return value?JSON.parse(value):null;}
async function dimensionRow(db,table,column,id,dimension){return db.get('SELECT dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at FROM '+table+' WHERE '+column+'=? AND dimension=?',[id,dimension]);}

function requiredFilm(value){const id=required(value,'film id');if(!id.startsWith('film:'))throw new Error('Film id must start with film:');return id;}
function requiredPerson(value){const id=required(value,'person id');if(!id.startsWith('person:'))throw new Error('Person id must start with person:');return id;}
function required(value,name){if(value==null||value==='')throw new Error(name+' is required');return value;}
