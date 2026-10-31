// Read-only relational views over the D1 catalog. Persons are entities here: one row per Letterboxd role
// slug, with their names, external ids and filmography, plus review queues for people stored twice.
// The person identity route loads one person's neighborhood and calls the pure projection. Nothing here writes,
// and nothing reads R2; R2 stays authoritative for every existing page.
const D1_LIMIT_DEFAULT=50,D1_LIMIT_MAX=100;
const d1Limit=value=>{const n=Number(value);return Number.isInteger(n)&&n>=1?Math.min(n,D1_LIMIT_MAX):D1_LIMIT_DEFAULT;};
const d1Rows=async(db,sql,params=[])=>(await db.prepare(sql).bind(...params).all()).results||[];
const d1First=async(db,sql,params=[])=>(await d1Rows(db,sql,params))[0]??null;
// A person id is person:<role>/<key>: role actor or director for a Letterboxd slug, tmdb_actor or tmdb_director for a TMDB
// person id. The same key under both roles of one source is almost always one person stored twice. Across sources only
// evidence through a verified Film counts as a match (AIR-201, ADR-0009): a Letterboxd and a TMDB person credited in the
// same role on the same Film under the same name. A name alone is only a candidate for a human look, never a link.
const personSlug=id=>String(id).slice(String(id).indexOf('/')+1);
const personSource=id=>String(id).startsWith('person:tmdb_')?'tmdb':'letterboxd';
const HUMAN_KEY_SQL=col=>`(case when ${col} like 'person:tmdb!_%' escape '!' then 'tmdb:' else 'letterboxd:' end)||substr(${col},instr(${col},'/')+1)`;
// Every name a person is known by: the original alias and an accepted localization.
const PERSON_NAMES_CTE=`names as (select person_id id,value name from person_alias where kind='name' union select person_id,value from person_dimension where dimension='localization' and status in ('reviewed','provisional') and value is not null)`;
const PERSON_NAME_SQL=`(select value from person_alias a where a.person_id=p.id and a.kind='name' order by value limit 1)`;
const PERSON_LOCAL_SQL=`(select value from person_dimension d where d.person_id=p.id and d.dimension='localization' and d.status in ('reviewed','provisional'))`;
const FILM_TITLE_SQL=`coalesce((select value from film_dimension d where d.film_id=f.id and d.dimension='localization' and d.status in ('reviewed','provisional')),f.original_title)`;
async function d1Status(db,env){
 const counts=await d1First(db,`select (select count(*) from film) films,(select count(*) from person) persons,(select count(*) from film_person_credit) credits,(select count(*) from candidate) candidates,(select count(*) from prediction_current) predictions,(select count(*) from actual_rating) ratings,(select max(imported_at) from import_receipt) lastImport,(select version from schema_contract where id=1) schemaVersion`);
 return {source:'d1',authoritative:false,...counts,projector:await d1EnrichmentStatus(db,env)};
}
async function d1Persons(db,{q='',role='',source='',cursor='',limit}){
 const where=['p.id>?'],params=[String(cursor||'')];
 if(role==='actor'||role==='director'){where.push('(p.id like ? or p.id like ?)');params.push('person:'+role+'/%','person:tmdb_'+role+'/%');}
 if(source==='tmdb'){where.push("p.id like 'person:tmdb!_%' escape '!'");}else if(source==='letterboxd'){where.push("p.id not like 'person:tmdb!_%' escape '!'");}
 const text=String(q||'').trim();
 if(text){where.push(`(exists(select 1 from person_alias a where a.person_id=p.id and a.value like ?) or exists(select 1 from person_dimension d where d.person_id=p.id and d.dimension='localization' and d.value like ?) or p.id like ?)`);params.push('%'+text+'%','%'+text+'%','%'+text+'%');}
 const size=d1Limit(limit);
 const rows=await d1Rows(db,`select p.id,${PERSON_NAME_SQL} name,${PERSON_LOCAL_SQL} localName,(select count(*) from film_person_credit c where c.person_id=p.id) films from person p where ${where.join(' and ')} order by p.id limit ?`,[...params,size+1]);
 const page=rows.slice(0,size);
 return {items:page.map(row=>({...row,source:personSource(row.id),key:personSlug(row.id)})),nextCursor:rows.length>size?page.at(-1).id:null};
}
async function d1Person(db,id){
 const person=await d1First(db,`select p.id,p.role_id roleId,p.updated_at updatedAt,${PERSON_NAME_SQL} name,${PERSON_LOCAL_SQL} localName from person p where p.id=?`,[id]);
 if(!person)return null;
 const [aliases,externalIds,films,sameSlug]=await Promise.all([
  d1Rows(db,`select kind,value from person_alias where person_id=? order by kind,value`,[id]),
  d1Rows(db,`select scheme,value,trusted,conflicting from person_external_id where person_id=? order by scheme,value`,[id]),
  d1Rows(db,`select f.id,${FILM_TITLE_SQL} title,f.original_title originalTitle,m.year,c.role,c.ordinal,pc.predicted_rating predicted,r.rating,(select 1 from watchlist_film w where w.film_id=f.id) inWatchlist from film_person_credit c join film f on f.id=c.film_id left join film_metadata m on m.film_id=f.id left join prediction_current pc on pc.film_id=f.id left join actual_rating r on r.film_id=f.id where c.person_id=? order by m.year desc,f.id`,[id]),
  d1Rows(db,`select id from person where id<>? and ${HUMAN_KEY_SQL('id')}=?`,[id,personSource(id)+':'+personSlug(id)])]);
 const otherSource=await d1Rows(db,`with ${PERSON_NAMES_CTE} select distinct o.id from names mine join names o on lower(o.name)=lower(mine.name) where mine.id=? and o.id<>? and (o.id like 'person:tmdb!_%' escape '!')<>(? like 'person:tmdb!_%' escape '!') order by o.id limit 20`,[id,id,id]);
 const coCredited=await d1Rows(db,`with ${PERSON_NAMES_CTE} select o.person_id id,count(distinct o.film_id) films from film_person_credit mine join film_person_credit o on o.film_id=mine.film_id and o.role=mine.role and o.person_id<>mine.person_id join names mn on mn.id=mine.person_id join names onm on onm.id=o.person_id and lower(onm.name)=lower(mn.name) where mine.person_id=? and (o.person_id like 'person:tmdb!_%' escape '!')<>(? like 'person:tmdb!_%' escape '!') group by o.person_id order by films desc,o.person_id`,[id,id]);
 return {...person,source:personSource(id),key:personSlug(id),coCredited,nameOnlyOtherSource:otherSource.map(row=>row.id).filter(other=>!coCredited.some(row=>row.id===other)),aliases,externalIds:externalIds.map(row=>({...row,trusted:row.trusted===1,conflicting:row.conflicting===1})),films:films.map(row=>({...row,inWatchlist:row.inWatchlist===1})),sameSlug:sameSlug.map(row=>row.id)};
}
async function d1Film(db,id){
 const film=await d1First(db,`select f.id,${FILM_TITLE_SQL} title,f.original_title originalTitle,f.canonical_identity canonicalIdentity,m.year,m.runtime,m.genres_json genres,m.url,(select 1 from watchlist_film w where w.film_id=f.id) inWatchlist from film f left join film_metadata m on m.film_id=f.id where f.id=?`,[id]);
 if(!film){const redirect=await d1First(db,`select to_film_id toFilmId from film_redirect where from_id=?`,[id]);return redirect?{redirect:redirect.toFilmId}:null;}
 const [externalIds,credits,prediction,rating]=await Promise.all([
  d1Rows(db,`select scheme,value,trusted,conflicting from film_external_id where film_id=? order by scheme,value`,[id]),
  d1Rows(db,`select c.person_id id,c.role,c.ordinal,${PERSON_NAME_SQL} name,${PERSON_LOCAL_SQL} localName from film_person_credit c join person p on p.id=c.person_id where c.film_id=? order by c.role desc,c.ordinal`,[id]),
  d1First(db,`select predicted_rating predicted,taste_profile_version profileVersion,updated_at updatedAt from prediction_current where film_id=?`,[id]),
  d1First(db,`select rating,source,recorded_at recordedAt from actual_rating where film_id=?`,[id])]);
 let genres=[];try{genres=JSON.parse(film.genres||'[]');}catch{}
 return {...film,genres,inWatchlist:film.inWatchlist===1,externalIds:externalIds.map(row=>({...row,trusted:row.trusted===1,conflicting:row.conflicting===1})),credits,prediction,rating};
}
// Four review queues, strongest evidence first. Nothing here links or merges a person.
// crossRole: one key of one source stored as an actor and as a director, a near-certain single person.
// coCredit: a Letterboxd and a TMDB person credited in the same role on the same Film under the same name, the provable
//   cross-source match of AIR-201; films counts the Films that show it.
// nameOnly: one name held by a Letterboxd and a TMDB person with no shared Film, a weak candidate for a human look.
// sameName: one name under different keys of the same source, namesakes or one person.
// Names compare with SQLite lower(), which folds ASCII only; Cyrillic names compare as stored.
async function d1PersonReview(db,{limit}){
 const size=d1Limit(limit);
 const crossRole=await d1Rows(db,`select ${HUMAN_KEY_SQL('p.id')} human,group_concat(p.id,' ') ids,min(${PERSON_NAME_SQL}) name from person p group by human having count(*)>1 order by human limit ?`,[size]);
 const keyed=`${PERSON_NAMES_CTE},keyed as (select id,lower(name) folded,name,${HUMAN_KEY_SQL('id')} human,(case when id like 'person:tmdb!_%' escape '!' then 'tmdb' else 'letterboxd' end) src from names)`;
 const coCreditSql=`${PERSON_NAMES_CTE},pairs as (select l.person_id letterboxd,t.person_id tmdb,l.role role,min(ln.name) name,count(distinct l.film_id) films from film_person_credit l join film_person_credit t on t.film_id=l.film_id and t.role=l.role and t.person_id like 'person:tmdb!_%' escape '!' join names ln on ln.id=l.person_id join names tn on tn.id=t.person_id and lower(tn.name)=lower(ln.name) where l.person_id not like 'person:tmdb!_%' escape '!' group by l.person_id,t.person_id,l.role)`;
 const coCredit=await d1Rows(db,`with ${coCreditSql} select * from pairs order by films desc,letterboxd limit ?`,[size]);
 const nameOnly=await d1Rows(db,`with ${keyed} select min(name) name,group_concat(distinct case when src='letterboxd' then id end) letterboxd,group_concat(distinct case when src='tmdb' then id end) tmdb from keyed k group by folded having count(distinct src)=2 and not exists(select 1 from keyed x join film_person_credit c on c.person_id=x.id where x.folded=k.folded and x.src='letterboxd' and exists(select 1 from film_person_credit c2 join keyed y on y.id=c2.person_id and y.folded=x.folded and y.src='tmdb' where c2.film_id=c.film_id and c2.role=c.role)) order by folded limit ?`,[size]);
 const sameName=await d1Rows(db,`with ${keyed} select min(name) name,src,group_concat(distinct id) ids,count(distinct human) humans from keyed group by folded,src having humans>1 order by humans desc,folded limit ?`,[size]);
 const totals=await d1First(db,`with ${keyed} select (select count(*) from (select 1 from person group by ${HUMAN_KEY_SQL('id')} having count(*)>1)) crossRole,(select count(*) from (select 1 from keyed group by folded having count(distinct src)=2)) sharedName,(select count(*) from (select 1 from keyed group by folded,src having count(distinct human)>1)) sameName`);
 totals.coCredit=(await d1First(db,`with ${coCreditSql} select count(*) n from pairs`)).n;
 const list=value=>value?String(value).split(','):[];
 return {totals,crossRole:crossRole.map(row=>({human:row.human,name:row.name,ids:row.ids.split(' ')})),coCredit,nameOnly:nameOnly.map(row=>({name:row.name,letterboxd:list(row.letterboxd),tmdb:list(row.tmdb)})),sameName:sameName.map(row=>({name:row.name,source:row.src,ids:list(row.ids),count:row.humans}))};
}
const IDENTITY_PERSON_CAP=400,IDENTITY_FILM_CAP=800,IDENTITY_ROUNDS=6,IDENTITY_NAMESAKES=40;
const d1Json=text=>{if(text==null)return null;try{return JSON.parse(text);}catch{return null;}};
async function d1Chunk(db,sql,ids){
 if(!ids.length)return [];
 const out=[],marks=sql.split('/*ids*/').length-1;
 for(let i=0;i<ids.length;i+=80){
  const chunk=ids.slice(i,i+80),place=chunk.map(()=>'?').join(',');
  out.push(...await d1Rows(db,sql.replaceAll('/*ids*/',place),Array(marks).fill(chunk).flat()));
 }
 return out;
}
// Distinct ids, stopped at the database. Each chunk asks for only the rows still needed, plus one. A full page means
// another row exists past the cap, so the neighborhood is incomplete and the caller must not use a partial list.
async function d1CappedIds(db,sql,ids,cap){
 if(!ids.length)return {ids:[],truncated:false};
 const seen=new Set(),found=[],marks=sql.split('/*ids*/').length-1;
 for(let i=0;i<ids.length;i+=80){
  const room=cap+1-found.length;
  if(room<=0)return {ids:found.slice(0,cap),truncated:true};
  const chunk=ids.slice(i,i+80),place=chunk.map(()=>'?').join(',');
  const rows=await d1Rows(db,sql.replaceAll('/*ids*/',place)+' limit ?',[...Array(marks).fill(chunk).flat(),room]);
  for(const row of rows){
   if(seen.has(row.id))continue;
   seen.add(row.id);found.push(row.id);
  }
  if(rows.length===room)return {ids:found.slice(0,cap),truncated:true};
 }
 return {ids:found,truncated:false};
}
async function d1IdentityCredits(db,filmIds,personIds){
 if(!filmIds.length||!personIds.length)return [];
 const out=[];
 for(let i=0;i<filmIds.length;i+=80){
  const films=filmIds.slice(i,i+80);
  for(let j=0;j<personIds.length;j+=80){
   const people=personIds.slice(j,j+80);
   out.push(...await d1Rows(db,`select film_id filmId,person_id personId,role from film_person_credit where role in ('actor','director') and film_id in (${films.map(()=>'?').join(',')}) and person_id in (${people.map(()=>'?').join(',')}) order by film_id,role,person_id`,[...films,...people]));
  }
 }
 return out;
}
async function d1HumanIds(db,ids){
 const keys=[...new Set(ids.map(id=>personSource(id)+':'+personSlug(id)))];
 const rows=await d1Chunk(db,`select id from person where ${HUMAN_KEY_SQL('id')} in (/*ids*/) order by id`,keys);
 return rows.map(row=>row.id);
}
function d1NameNeedles(value){
 const text=String(value??''),folded=PersonIdentity.personFold(text);
 const variants=new Set([text,text.toLocaleLowerCase('ru'),folded].filter(Boolean));
 for(const item of [...variants]){
  variants.add(item.split('ё').join('е').split('Ё').join('Е'));
  variants.add(item.split('е').join('ё').split('Е').join('Ё'));
 }
 return [...variants].filter(Boolean);
}
async function d1Namesakes(db,ids){
 const own=await d1Chunk(db,`select value name from person_alias where kind='name' and person_id in (/*ids*/) union select value from person_dimension where dimension='localization' and status in ('reviewed','provisional') and value is not null and person_id in (/*ids*/)`,ids);
 const folded=new Set(own.map(row=>PersonIdentity.personFold(row.name)).filter(Boolean));
 if(!folded.size)return {ids:[],truncated:false};
 const needles=[...new Set(own.flatMap(row=>d1NameNeedles(row.name)))];
 const seen=new Set(ids),found=[],exclude=[...ids].sort();
 const names=`select person_id id,value name from person_alias where kind='name' union select person_id,value from person_dimension where dimension='localization' and status in ('reviewed','provisional') and value is not null`;
 for(let i=0;i<needles.length;i+=80){
  const room=IDENTITY_NAMESAKES+1-found.length;
  if(room<=0)return {ids:found.slice(0,IDENTITY_NAMESAKES),truncated:true};
  const chunk=needles.slice(i,i+80);
  const rows=await d1Rows(db,`select id,min(name) name from (${names}) where lower(name) in (${chunk.map(()=>'?').join(',')}) and id not in (${exclude.map(()=>'?').join(',')}) group by id order by id limit ?`,[...chunk,...exclude,room]);
  for(const row of rows){
   if(!folded.has(PersonIdentity.personFold(row.name))||seen.has(row.id))continue;
   seen.add(row.id);found.push(row.id);
  }
  if(rows.length===room)return {ids:found.slice(0,IDENTITY_NAMESAKES),truncated:true};
 }
 return {ids:found,truncated:false};
}
async function d1IdentityPersons(db,ids){
 const aliases=await d1Chunk(db,`select person_id id,kind,value from person_alias where person_id in (/*ids*/) order by person_id,kind,value`,ids);
 const locals=await d1Chunk(db,`select person_id id,status,source,value,provenance_json from person_dimension where dimension='localization' and person_id in (/*ids*/) order by person_id`,ids);
 const conflicts=await d1Chunk(db,`select entity_id id,value,source,reason from localization_conflict where entity_kind='person' and entity_id in (/*ids*/) order by entity_id,value`,ids);
 const byAlias=new Map(),byLocal=new Map(),byConflict=new Map();
 for(const row of aliases){if(!byAlias.has(row.id))byAlias.set(row.id,[]);byAlias.get(row.id).push(row);}
 for(const row of locals)if(!byLocal.has(row.id))byLocal.set(row.id,row);
 for(const row of conflicts){if(!byConflict.has(row.id))byConflict.set(row.id,[]);byConflict.get(row.id).push(row);}
 return ids.slice().sort().map(id=>{
  const names=(byAlias.get(id)||[]).filter(row=>row.kind==='name');
  const local=byLocal.get(id);
  const localization=local&&(local.status==='reviewed'||local.status==='provisional')&&local.value?{status:local.status,value:local.value,source:local.source??null,provenance:d1Json(local.provenance_json)}:null;
  return {id,original:names[0]?.value??null,aliases:names.slice(1).map(row=>({kind:'name',value:row.value})),localization,localizationConflicts:(byConflict.get(id)||[]).map(row=>({value:row.value,source:row.source??null,reason:row.reason})),roleLinks:[]};
 });
}
async function d1IdentityFilms(db,ids){
 const films=await d1Chunk(db,`select f.id,f.canonical_identity canonicalIdentity,(select status from film_dimension d where d.film_id=f.id and d.dimension='identity') identityStatus,(select 1 from watchlist_film w where w.film_id=f.id) inWatchlist from film f where f.id in (/*ids*/) order by f.id`,ids);
 const external=await d1Chunk(db,`select film_id filmId,scheme,value,trusted,conflicting from film_external_id where scheme in ('tmdb','tmdb_tv') and film_id in (/*ids*/) order by film_id,scheme,value`,ids);
 const byFilm=new Map();
 for(const row of external){if(!byFilm.has(row.filmId))byFilm.set(row.filmId,[]);byFilm.get(row.filmId).push({scheme:row.scheme,value:String(row.value),trusted:row.trusted===1,conflicting:row.conflicting===1});}
 return films.map(row=>({id:row.id,surface:row.inWatchlist===1?'watchlist':'catalog',canonicalIdentity:row.canonicalIdentity??null,identity:row.identityStatus?{status:row.identityStatus}:null,externalIds:byFilm.get(row.id)||[]}));
}
function d1IdentityBody(recordId,projection,limitations,bounded){
 const selector={recordId};
 const resolved=PersonIdentity.resolvePersonReference(projection,selector);
 const reference={state:resolved.status,crossSource:resolved.crossSource,humanId:resolved.humanId,formerIds:resolved.formerIds,memberIds:resolved.memberIds,links:resolved.links,reviews:resolved.reviews,externalIds:resolved.externalIds,reversal:resolved.reversal};
 const films={};
 for(const role of ['actor','director']){
  const surfaces=PersonIdentity.personSurfaces(projection,selector,role);
  films[role]={state:surfaces.status,crossSource:surfaces.crossSource,humanId:surfaces.humanId,watchlist:surfaces.watchlist,catalog:surfaces.catalog};
 }
 return {source:'d1',authoritative:false,recordId,reference,films,limitations,bounded};
}
const IDENTITY_FILM_SQL=`select film_id id from film_person_credit where role in ('actor','director') and person_id in (/*ids*/) group by film_id order by film_id`;
const IDENTITY_WITNESS_SQL=`select person_id id from film_person_credit where role in ('actor','director') and film_id in (/*ids*/) group by person_id order by person_id`;
// Same-key records only. Their own films are loaded only when that list itself fits the film cap; a partial credit list
// is not projected, because the omitted film might have been the one that kept a join from looking unique.
async function d1SameKeyProjection(db,personIds){
 const persons=await d1IdentityPersons(db,personIds);
 const loaded=persons.map(person=>person.id);
 const films=await d1CappedIds(db,IDENTITY_FILM_SQL,loaded,IDENTITY_FILM_CAP);
 if(films.truncated||!films.ids.length)return PersonIdentity.projectPersonIdentity({persons,credits:[],films:[],decisions:[]});
 const credits=await d1IdentityCredits(db,films.ids,loaded);
 return PersonIdentity.projectPersonIdentity({persons,credits,films:await d1IdentityFilms(db,films.ids),decisions:[]});
}
// One person, not the catalog. Same-key records stay together. People credited on those films are witnesses,
// so a second person of the same name keeps a coCredit from looking unique. A witness joins the core only when
// the projection says they are the same human, and the next round then loads that human's other films.
// Namesakes are loaded with no extra films. Owner decisions and role links are not stored in D1.
// The film, witness and namesake probes each stop at cap+1 rows. Past a cap the answer is the same-key records
// only, so a partial witness or namesake list cannot add a film.
async function d1PersonIdentity(db,id){
 if(!await d1First(db,`select id from person where id=?`,[id]))return null;
 const seed=new Set(await d1HumanIds(db,[id]));
 seed.add(id);
 const limitations=['owner_decisions_not_stored','role_links_not_stored'];
 let core=new Set(seed),namesakeCut=false;
 for(let round=0;round<IDENTITY_ROUNDS;round++){
  const coreIds=[...core].sort();
  const filmProbe=await d1CappedIds(db,IDENTITY_FILM_SQL,coreIds,IDENTITY_FILM_CAP);
  if(filmProbe.truncated)break;
  const witnessProbe=filmProbe.ids.length?await d1CappedIds(db,IDENTITY_WITNESS_SQL,filmProbe.ids,IDENTITY_PERSON_CAP):{ids:[],truncated:false};
  if(witnessProbe.truncated)break;
  const namesakes=await d1Namesakes(db,coreIds);
  if(namesakes.truncated){namesakeCut=true;break;}
  const personIds=[...new Set([...coreIds,...witnessProbe.ids,...namesakes.ids])].sort();
  if(personIds.length>IDENTITY_PERSON_CAP)break;
  const persons=await d1IdentityPersons(db,personIds);
  const loaded=new Set(persons.map(person=>person.id));
  const credits=(await d1IdentityCredits(db,filmProbe.ids,personIds)).filter(credit=>loaded.has(credit.personId));
  const films=filmProbe.ids.length?await d1IdentityFilms(db,filmProbe.ids):[];
  const projection=PersonIdentity.projectPersonIdentity({persons,credits,films,decisions:[]});
  const members=PersonIdentity.resolvePersonReference(projection,{recordId:id}).memberIds;
  const missing=members.filter(personId=>!core.has(personId));
  if(!missing.length)return d1IdentityBody(id,projection,limitations,false);
  const grown=await d1HumanIds(db,missing);
  if(core.size+grown.length>IDENTITY_PERSON_CAP)break;
  for(const personId of grown)core.add(personId);
 }
 if(namesakeCut)limitations.push('namesakes_truncated');
 limitations.push('neighborhood_bounded');
 return d1IdentityBody(id,await d1SameKeyProjection(db,[...seed].sort()),limitations,true);
}
// The metadata step's Film/Person roster. One bounded SELECT batch for the films whose names that step is already
// localizing. The verdict is proven only when the row is that film's metadata snapshot, the Letterboxd id and the
// typed movie id agree, and the Letterboxd credits are the same people. TMDB-source credits stay off the film.
// A miss returns a reason and the step keeps the credit objects it already holds. No DB binding returns null. This function only reads.
const D1_METADATA_ROSTER_CAP=24;
function d1MetadataLetterboxdId(id){
 const text=String(id??'');
 if(text.startsWith('tmdb_')||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(text))return null;
 return 'film:'+text;
}
function d1MetadataRosterVerdict(film,row){
 if(!row)return {ok:false,reason:'missing'};
 if(row.inWatchlist!==true)return {ok:false,reason:'not_watchlist'};
 if(row.metadataAt!==film?.metadataAt||Number(row.peopleVersion)!==1||film?.peopleVersion!==1)return {ok:false,reason:'lag'};
 const external=row.externalIds||[];
 if(external.some(item=>item.conflicting&&(item.scheme==='letterboxd'||item.scheme==='tmdb'||item.scheme==='tmdb_tv')))return {ok:false,reason:'identity'};
 const letterboxd=external.filter(item=>item.scheme==='letterboxd'&&item.trusted&&!item.conflicting);
 if(letterboxd.length!==1||letterboxd[0].value!==String(film.id))return {ok:false,reason:'identity'};
 const movies=external.filter(item=>item.scheme==='tmdb'&&item.trusted&&!item.conflicting);
 const tv=external.filter(item=>item.scheme==='tmdb_tv'&&item.trusted&&!item.conflicting);
 const canonical=row.canonicalIdentity??null;
 if(typeof canonical==='string'&&canonical.startsWith('tmdb_tv:'))return {ok:false,reason:'tmdb_tv'};
 if(film.tmdbId){
  const tmdbId=String(film.tmdbId);
  if(tv.some(item=>item.value===tmdbId))return {ok:false,reason:'tmdb_tv'};
  if(movies.length!==1||movies[0].value!==tmdbId)return {ok:false,reason:'identity'};
  if(canonical&&canonical!=='tmdb:'+tmdbId)return {ok:false,reason:'identity'};
 }else if(movies.length||tv.length||canonical)return {ok:false,reason:'identity'};
 const byId=new Map();
 for(const person of [...(film.directors||[]),...(film.actors||[])]){
  if(!person?.id||byId.has(person.id))return {ok:false,reason:'credits'};
  byId.set(person.id,person);
 }
 const credits=(row.credits||[]).filter(item=>item?.roleId&&!String(item.roleId).startsWith('tmdb_')&&(item.role==='actor'||item.role==='director'));
 credits.sort((a,b)=>a.role===b.role?Number(a.ordinal)-Number(b.ordinal):(a.role==='director'?-1:1));
 const seen=new Set(),order=[];
 for(const credit of credits){
  if(seen.has(credit.roleId))return {ok:false,reason:'credits'};
  seen.add(credit.roleId);
  const person=byId.get(credit.roleId);
  if(!person)return {ok:false,reason:'credits'};
  if(String(credit.original||'')!==String(person.original||person.name||''))return {ok:false,reason:'credits'};
  order.push(credit.roleId);
 }
 if(seen.size!==byId.size)return {ok:false,reason:'credits'};
 return {ok:true,reason:'proven',order};
}
async function d1MetadataSyncRoster(env,films){
 const db=env&&env.DB;
 if(!db)return null;
 const chosen=[],seenIds=new Set();
 for(const film of films||[]){
  const id=d1MetadataLetterboxdId(film?.id);
  if(!id||seenIds.has(id))continue;
  seenIds.add(id);chosen.push(film);
  if(chosen.length>=D1_METADATA_ROSTER_CAP)break;
 }
 const out=new Map();
 if(!chosen.length)return out;
 const ids=chosen.map(film=>'film:'+film.id);
 const filmRows=await d1Chunk(db,`select f.id,f.canonical_identity canonicalIdentity,m.updated_at metadataAt,m.people_version peopleVersion,(select 1 from watchlist_film w where w.film_id=f.id) inWatchlist from film f left join film_metadata m on m.film_id=f.id where f.id in (/*ids*/) order by f.id`,ids);
 const externalRows=await d1Chunk(db,`select film_id filmId,scheme,value,trusted,conflicting from film_external_id where scheme in ('letterboxd','tmdb','tmdb_tv') and film_id in (/*ids*/) order by film_id,scheme,value`,ids);
 const creditRows=await d1Chunk(db,`select c.film_id filmId,c.role,c.ordinal,p.role_id roleId,(select a.value from person_alias a where a.person_id=p.id and a.kind='name' order by a.value limit 1) original from film_person_credit c join person p on p.id=c.person_id where c.role in ('actor','director') and c.film_id in (/*ids*/) order by c.film_id,c.role,c.ordinal`,ids);
 const byFilm=new Map();
 for(const row of filmRows)byFilm.set(row.id,{id:row.id,canonicalIdentity:row.canonicalIdentity??null,metadataAt:row.metadataAt??null,peopleVersion:row.peopleVersion??null,inWatchlist:row.inWatchlist===1,externalIds:[],credits:[]});
 for(const row of externalRows){const film=byFilm.get(row.filmId);if(film)film.externalIds.push({scheme:row.scheme,value:String(row.value),trusted:row.trusted===1,conflicting:row.conflicting===1});}
 for(const row of creditRows){const film=byFilm.get(row.filmId);if(film)film.credits.push({role:row.role,ordinal:row.ordinal,roleId:row.roleId,original:row.original??''});}
 for(const film of chosen)out.set(String(film.id),d1MetadataRosterVerdict(film,byFilm.get('film:'+film.id)||null));
 return out;
}
async function catalogD1Route(request,env,url){
 if(request.method!=='GET')return json({error:'Method not allowed'},405);
 if(!env.DB)return json({error:'D1 is not bound to this Worker'},503);
 const path=url.pathname.slice('/api/d1/'.length),params=url.searchParams;
 if(path==='status')return json(await d1Status(env.DB,env));
 if(path==='persons')return json(await d1Persons(env.DB,{q:params.get('q'),role:params.get('role'),source:params.get('source'),cursor:params.get('cursor'),limit:params.get('limit')}));
 if(path==='persons/review')return json(await d1PersonReview(env.DB,{limit:params.get('limit')}));
 let match=path.match(/^persons\/((?:tmdb_)?(?:actor|director)\/[^/]{1,200})\/identity$/);
 if(match){let key;try{key=decodeURIComponent(match[1]);}catch{return json({error:'Person not found'},404);}const body=await d1PersonIdentity(env.DB,'person:'+key);return body?json(body):json({error:'Person not found'},404);}
 match=path.match(/^persons\/((?:tmdb_)?(?:actor|director)\/[^/]{1,200})$/);
 if(match){const person=await d1Person(env.DB,'person:'+decodeURIComponent(match[1]));return person?json(person):json({error:'Person not found'},404);}
 match=path.match(/^films\/([^/]{1,200})$/);
 if(match){const film=await d1Film(env.DB,'film:'+decodeURIComponent(match[1]));return film?json(film):json({error:'Film not found'},404);}
 return json({error:'Not found'},404);
}
