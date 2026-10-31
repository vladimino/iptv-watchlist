// AIR-70. D1 repository for canonical Film and Person records. The caller supplies the database and the domain result.
// The offline import uses it, and since AIR-275 phase 2 (ADR 0056) the Worker bundle carries it for the enrichment projector.
// R2 stays authoritative. This module does not score a candidate or choose shows.

export function createCanonicalRepository(db){
 return {
  saveFilm:input=>saveFilm(db,input),
  savePerson:input=>savePerson(db,input),
  applyLink:input=>applyLink(db,input),
  readFilm:id=>readFilm(db,id),
  readPerson:id=>readPerson(db,id),
  // AIR-275 phase 2 (ADR 0056): the enrichment projector writes inside its own transaction and reads nothing back.
  projectFilm:input=>projectFilm(db,input),
  projectLink:input=>projectLink(db,input),
  projectPerson:input=>projectPerson(db,input),
  releaseFilm:id=>releaseFilm(db,id),
  // Schema v5 only. The projector calls this inside its own batch once film_sync_state exists. It does not read the row back.
  projectFilmSyncState:input=>projectFilmSyncState(db,input),
 };
}

// The enrichment writer owns the identity and metadata dimensions, the Film row, its external ids, aliases, metadata, watchlist
// membership and the credits R2 supplies. It never writes the fingerprint or prediction dimensions, and it keeps the credits
// only D1 holds: TMDB credits added to a watchlist Film (AIR-286) stay, renumbered after the R2 credits of their role, unless the
// R2 roster already lists the same person in that role.
async function projectFilm(db,input){await writeFilm(db,await planFilm(db,{...input,owner:'enrichment'}));}
async function projectPerson(db,input){await writePerson(db,await planPerson(db,input));}
async function projectLink(db,input){const {plan,retirement}=await planLink(db,{...input,owner:'enrichment'});await writeLink(db,plan,retirement);}
// A Film no R2 source lists any more keeps its row, credits and history: they stay true of the Film. Only the membership goes.
async function releaseFilm(db,id){
 const filmId=requiredFilm(id);
 if(await db.get('SELECT to_film_id FROM film_redirect WHERE from_id=?',[filmId]))return;
 await db.run('DELETE FROM watchlist_film WHERE film_id=?',[filmId]);
}
// metadata_at, synopsis_fetched_at and people_localized_at are the strings metadata.json stored, or null when that clock
// is missing. people_names_version is the integer metadata.json stored, or null. people_version stays on film_metadata.
// A null sync deletes the row because the metadata.json entry is gone. Leaving the view does not. The Film row stays,
// and the foreign key is that existing id: this function does not insert a Film.
const FILM_SYNC_UPSERT='INSERT INTO film_sync_state (film_id,metadata_at,synopsis_fetched_at,people_names_version,people_localized_at) VALUES (?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET metadata_at=excluded.metadata_at,synopsis_fetched_at=excluded.synopsis_fetched_at,people_names_version=excluded.people_names_version,people_localized_at=excluded.people_localized_at';
async function projectFilmSyncState(db,input){
 const filmId=requiredFilm(input?.filmId);
 const sync=input?.sync??null;
 if(!sync){await db.run('DELETE FROM film_sync_state WHERE film_id=?',[filmId]);return;}
 await db.run(FILM_SYNC_UPSERT,[filmId,sync.metadataAt??null,sync.synopsisFetchedAt??null,Number.isInteger(sync.peopleNamesVersion)?sync.peopleNamesVersion:null,sync.peopleLocalizedAt??null]);
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
 const {plan,retirement}=await planLink(db,input);
 await db.transaction(async()=>{await writeLink(db,plan,retirement);});
 return readFilm(db,plan.film.id);
}

async function planLink(db,input){
 const survivor=input?.survivor;
 if(!survivor?.id)throw new Error('survivor is required');
 const redirect=input.redirect??null;
 if(redirect&&redirect.to!==survivor.id)throw new Error('Redirect target must be the survivor');
 const survivorListed=await db.get('SELECT 1 AS ok FROM watchlist_film WHERE film_id=?',[survivor.id]);
 const retiredListed=redirect?await db.get('SELECT 1 AS ok FROM watchlist_film WHERE film_id=?',[redirect.from]):null;
 const watchlist=input.watchlist===true?true:input.watchlist===false?false:(survivorListed||retiredListed?true:null);
 const plan=await planFilm(db,{...input,film:survivor,watchlist,releasing:redirect?.from??null});
 const retirement=redirect?await planRetirement(db,redirect):null;
 if(retirement&&!retirement.release)plan.keepHistory=true;
 return {plan,retirement};
}

async function writeLink(db,plan,retirement){
 if(retirement?.release)await db.run('DELETE FROM film_external_id WHERE film_id=?',[retirement.from]);
 await writeFilm(db,plan);
 if(retirement?.release){await adoptRetired(db,retirement);await retireFilm(db,retirement);}
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
 const owner=input.owner??null;
 if(owner!==null&&owner!=='enrichment')throw new Error('Unknown write owner');
 const kept=owner==='enrichment'&&input.credits!==undefined&&watchlist===true?await db.all("SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id=? AND person_id LIKE 'person:tmdb!_%' ESCAPE '!' ORDER BY role,ordinal",[id]):[];
 return {film:guarded,metadata:input.metadata===undefined?undefined:input.metadata,credits:input.credits,watchlist,owner,kept,updatedAt:updatedAtOf(guarded)};
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
 if(plan.credits!==undefined&&!plan.keepHistory)await db.run('DELETE FROM film_person_credit WHERE film_id=?',[film.id]);
 for(const item of film.externalIds||[])await db.run('INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (?,?,?,?,?,?)',[film.id,required(item.scheme,'scheme'),String(item.value),item.trusted&&!item.conflicting?1:0,item.conflicting?1:0,json(item.provenance)]);
 for(const item of film.aliases||[])await db.run('INSERT INTO film_alias (film_id,kind,value,provenance_json) VALUES (?,?,?,?) ON CONFLICT(film_id,kind,value) DO NOTHING',[film.id,item.kind||'title',required(item.value,'alias'),json(item.provenance)]);
 await noteHeldLocalization(db,{table:'film_dimension',column:'film_id',id:film.id,kind:'title',entityKind:'film',incoming:film.localization});
 const dimensions=plan.owner==='enrichment'?['identity','metadata']:['identity','metadata','fingerprint','prediction'];
 if(plan.owner==='enrichment')await db.run("DELETE FROM film_dimension WHERE film_id=? AND dimension IN ('identity','metadata')",[film.id]);
 else await db.run("DELETE FROM film_dimension WHERE film_id=? AND dimension<>'localization'",[film.id]);
 for(const dimension of dimensions)await db.run('INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',dimensionParams(film.id,film[dimension]));
 await db.run(localizationUpsert('film_dimension','film_id'),dimensionParams(film.id,film.localization));
 if(plan.credits!==undefined)for(const credit of plan.credits){
  if(credit.role!=='director'&&credit.role!=='actor')throw new Error('Credit role is invalid');
  await db.run('INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES (?,?,?,?)'+(plan.keepHistory?' ON CONFLICT(film_id,person_id,role) DO NOTHING':''),[film.id,requiredPerson(credit.personId),credit.role,credit.ordinal]);
 }
 if(plan.credits!==undefined&&!plan.keepHistory)for(const credit of keptCredits(plan.credits,plan.kept))await db.run('INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES (?,?,?,?)',[film.id,credit.personId,credit.role,credit.ordinal]);
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
 for(const item of person.externalIds||[])await db.run('INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting,provenance_json) VALUES (?,?,?,?,?,?)',[person.id,required(item.scheme,'scheme'),String(item.value),item.trusted&&!item.conflicting?1:0,item.conflicting?1:0,json(item.provenance)]);
 for(const item of person.aliases||[])await db.run('INSERT INTO person_alias (person_id,kind,value,provenance_json) VALUES (?,?,?,?) ON CONFLICT(person_id,kind,value) DO NOTHING',[person.id,item.kind||'name',required(item.value,'alias'),json(item.provenance)]);
 await noteHeldLocalization(db,{table:'person_dimension',column:'person_id',id:person.id,kind:'name',entityKind:'person',incoming:person.localization});
 await db.run("DELETE FROM person_dimension WHERE person_id=? AND dimension<>'localization'",[person.id]);
 await db.run('INSERT INTO person_dimension (person_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',dimensionParams(person.id,person.identity));
 await db.run(localizationUpsert('person_dimension','person_id'),dimensionParams(person.id,person.localization));
 for(const conflict of person.localizationConflicts||[])await db.run('INSERT INTO localization_conflict (id,entity_kind,entity_id,value,source,provenance_json,authority,reason,at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',conflictParams('person',person.id,conflict));
}

async function adoptRetired(db,retirement){
 const from=retirement.from,to=retirement.to;
 await db.run('INSERT INTO film_alias (film_id,kind,value,provenance_json) SELECT ?,kind,value,provenance_json FROM film_alias WHERE film_id=? ON CONFLICT(film_id,kind,value) DO NOTHING',[to,from]);
 await db.run('INSERT INTO film_person_credit (film_id,person_id,role,ordinal) SELECT ?,c.person_id,c.role,CASE WHEN EXISTS (SELECT 1 FROM film_person_credit s WHERE s.film_id=? AND s.role=c.role AND s.ordinal=c.ordinal AND s.person_id<>c.person_id) THEN c.ordinal+(SELECT COALESCE(MAX(s.ordinal),-1)+1 FROM film_person_credit s WHERE s.film_id=? AND s.role=c.role) ELSE c.ordinal END FROM film_person_credit c WHERE c.film_id=? AND NOT EXISTS (SELECT 1 FROM film_person_credit s WHERE s.film_id=? AND s.person_id=c.person_id AND s.role=c.role)',[to,to,to,from,to]);
 await db.run("INSERT INTO localization_conflict (id,entity_kind,entity_id,value,source,provenance_json,authority,reason,at) SELECT 'film:'||?||':'||json_object('reason',reason,'value',value,'source',source),'film',?,value,source,provenance_json,authority,reason,at FROM localization_conflict WHERE entity_kind='film' AND entity_id=? ON CONFLICT(id) DO NOTHING",[to,to,from]);
 await db.run('UPDATE film_redirect SET to_film_id=? WHERE to_film_id=? AND from_id<>?',[to,from,to]);
}

async function retireFilm(db,retirement){
 await db.run('DELETE FROM film_person_credit WHERE film_id=?',[retirement.from]);
 await db.run('DELETE FROM film_metadata WHERE film_id=?',[retirement.from]);
 await db.run('DELETE FROM film_alias WHERE film_id=?',[retirement.from]);
 await db.run('DELETE FROM film_dimension WHERE film_id=?',[retirement.from]);
 await db.run('DELETE FROM watchlist_film WHERE film_id=?',[retirement.from]);
 await db.run("DELETE FROM localization_conflict WHERE entity_kind='film' AND entity_id=?",[retirement.from]);
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

// The D1-only credits that survive a rewrite, numbered after the highest R2 ordinal of their role in their stored order.
function keptCredits(credits,kept){
 const listed=new Set(credits.map(credit=>credit.personId+'/'+credit.role)),next={};
 for(const credit of credits)next[credit.role]=Math.max(next[credit.role]??0,credit.ordinal+1);
 const out=[];
 for(const row of kept||[]){
  if(listed.has(row.person_id+'/'+row.role))continue;
  const ordinal=next[row.role]??0;
  next[row.role]=ordinal+1;
  out.push({personId:row.person_id,role:row.role,ordinal});
 }
 return out;
}

function guardReviewed(entity,stored,kind){
 if(!stored||stored.status!=='reviewed'||replacesStored(stored,entity.localization))return entity;
 const incoming=entity.localization||{};
 const conflicts=[...(entity.localizationConflicts||[])];
 const aliases=[...(entity.aliases||[])];
 const reason=stored.authority==='owner'?'owner_kept':'reviewed_kept';
 if(incoming.value&&incoming.value!==stored.value){
  conflicts.push({value:incoming.value,source:incoming.source||null,provenance:incoming.provenance??null,at:incoming.updatedAt||stored.updated_at,reason});
  aliases.push({kind,value:incoming.value,provenance:incoming.provenance??null});
 }
 return {...entity,localization:dimensionView(stored),localizationConflicts:conflicts,aliases};
}

function replacesStored(stored,incoming){
 if(stored?.authority==='owner')return incoming?.status==='reviewed'&&incoming?.provenance?.authority==='owner';
 return reviewedWrite(incoming);
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
 const provenance=parseJson(row.provenance_json);
 const state={dimension:row.dimension,status:row.status,updatedAt:row.updated_at,source:row.source,sourceVersion:row.source_version,provenance:provenance?.authority||!row.authority?provenance:{...(provenance||{}),authority:row.authority},lastError:row.last_error,failureReason:row.failure_reason,retryAt:row.retry_at,attempts:row.attempts,nextAction:row.next_action};
 if(row.dimension==='localization')state.value=row.value;
 return state;
}

async function noteHeldLocalization(db,{table,column,id,kind,entityKind,incoming}){
 const value=incoming?.value??null,source=incoming?.source??null,status=incoming?.status??null,authority=incoming?.provenance?.authority??null,at=incoming?.updatedAt??null,provenance=json(incoming?.provenance);
 const aliasTable=kind==='title'?'film_alias':'person_alias';
 const hold="status='reviewed' AND NOT (value IS ?) AND NOT ((authority='owner' AND ?='reviewed' AND ?='owner') OR (COALESCE(authority,'')<>'owner' AND ?='reviewed' AND (? IN ('dictionary','owner') OR ?='dictionary')))";
 await db.run(`INSERT INTO ${aliasTable} (${column},kind,value,provenance_json) SELECT ${column},?,?,? FROM ${table} WHERE ${column}=? AND dimension='localization' AND ${hold} AND ? IS NOT NULL ON CONFLICT(${column},kind,value) DO NOTHING`,[kind,value,provenance,id,value,status,authority,status,authority,source,value]);
 await db.run(`INSERT INTO localization_conflict (id,entity_kind,entity_id,value,source,provenance_json,authority,reason,at) SELECT ?||':'||?||':'||json_object('reason',CASE WHEN authority='owner' THEN 'owner_kept' ELSE 'reviewed_kept' END,'value',?,'source',?),?,?,?,?,?,authority,CASE WHEN authority='owner' THEN 'owner_kept' ELSE 'reviewed_kept' END,? FROM ${table} WHERE ${column}=? AND dimension='localization' AND ${hold} ON CONFLICT(id) DO NOTHING`,[entityKind,id,value,source,entityKind,id,value,source,provenance,at,id,value,status,authority,status,authority,source]);
}

function localizationUpsert(table,column){
 return `INSERT INTO ${table} (${column},dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(${column},dimension) DO UPDATE SET status=excluded.status,source=excluded.source,source_version=excluded.source_version,provenance_json=excluded.provenance_json,value=excluded.value,authority=excluded.authority,last_error=excluded.last_error,failure_reason=excluded.failure_reason,retry_at=excluded.retry_at,attempts=excluded.attempts,next_action=excluded.next_action,updated_at=excluded.updated_at WHERE ${table}.status<>'reviewed' OR (${table}.authority='owner' AND excluded.status='reviewed' AND excluded.authority='owner') OR (COALESCE(${table}.authority,'')<>'owner' AND excluded.status='reviewed' AND (excluded.authority IN ('dictionary','owner') OR excluded.source='dictionary'))`;
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
