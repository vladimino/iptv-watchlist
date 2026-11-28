// Read-only relational views over the D1 catalog. Retained HTTP views: status and the person identity route. The film, persons list, person detail and review HTTP views are retired with a typed 410 (AIR-689, ADR 0223);
// d1PersonReview stays only because scripts/tmdb-watchlist-credits.mjs loads it through vm.
// The person identity route loads one person's neighborhood and calls the pure projection. Nothing here writes,
// and nothing reads R2. Production serves these views only at `open` (ADR 0162, AIR-374 P4 gates them by the marker); `authoritative` is false only for the explicit local stand-in, which keeps R2 for every existing page.
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
async function d1Status(db,env,authoritative=false){
 const counts=await d1First(db,`select (select count(*) from film) films,(select count(*) from person) persons,(select count(*) from film_person_credit) credits,(select count(*) from candidate) candidates,(select count(*) from prediction_current) predictions,(select count(*) from actual_rating) ratings,(select max(imported_at) from import_receipt) lastImport,(select version from schema_contract where id=1) schemaVersion`);
 return {source:'d1',authoritative,...counts,projector:await d1EnrichmentStatus(db,env)};
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
function d1IdentityBody(recordId,projection,limitations,bounded,authoritative=false){
 const selector={recordId};
 const resolved=PersonIdentity.resolvePersonReference(projection,selector);
 const reference={state:resolved.status,crossSource:resolved.crossSource,humanId:resolved.humanId,formerIds:resolved.formerIds,memberIds:resolved.memberIds,links:resolved.links,reviews:resolved.reviews,externalIds:resolved.externalIds,reversal:resolved.reversal};
 const films={};
 for(const role of ['actor','director']){
  const surfaces=PersonIdentity.personSurfaces(projection,selector,role);
  films[role]={state:surfaces.status,crossSource:surfaces.crossSource,humanId:surfaces.humanId,watchlist:surfaces.watchlist,catalog:surfaces.catalog};
 }
 return {source:'d1',authoritative,recordId,reference,films,limitations,bounded};
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
async function d1PersonIdentity(db,id,authoritative=false){
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
  if(!missing.length)return d1IdentityBody(id,projection,limitations,false,authoritative);
  const grown=await d1HumanIds(db,missing);
  if(core.size+grown.length>IDENTITY_PERSON_CAP)break;
  for(const personId of grown)core.add(personId);
 }
 if(namesakeCut)limitations.push('namesakes_truncated');
 limitations.push('neighborhood_bounded');
 return d1IdentityBody(id,await d1SameKeyProjection(db,[...seed].sort()),limitations,true,authoritative);
}
// AIR-689 (ADR 0223): four operator views are retired with a typed 410. The exact path shapes are matched on the raw pathname, without decoding, so a malformed percent escape is still a 410.
// `persons/<role>/<key>/identity` and `status` are retained and never match here; an unknown path is not retired (it keeps 404/503).
const D1_RETIRED_VIEW=/^(?:persons|persons\/review|persons\/(?:tmdb_)?(?:actor|director)\/[^/]{1,200}|films\/[^/]{1,200})$/;
const d1RetiredViewResponse=()=>json({error:'gone',reason:'d1_operator_view_retired'},410);
async function catalogD1Dispatch(request,env,url,authoritative=false){
 if(request.method!=='GET')return json({error:'Method not allowed'},405);
 if(!env.DB)return json({error:'D1 is not bound to this Worker'},503);
 const path=url.pathname.slice('/api/d1/'.length);
 if(path==='status')return json(await d1Status(env.DB,env,authoritative));
 let match=path.match(/^persons\/((?:tmdb_)?(?:actor|director)\/[^/]{1,200})\/identity$/);
 if(match){let key;try{key=decodeURIComponent(match[1]);}catch{return json({error:'Person not found'},404);}const body=await d1PersonIdentity(env.DB,'person:'+key,authoritative);return body?json(body):json({error:'Person not found'},404);}
 return json({error:'Not found'},404);
}
// AIR-374 P4: the marker gate of the /api/d1/* views (and of the owner-review overlay, which is reachable only through this route). legacy (the explicit local stand-in only; r2 and prepared markers are refused, ADR 0162) answers exactly as
// before (`authoritative:false`); held, an unreadable or malformed marker answer 503 and read nothing; open reads the same D1 rows and says `authoritative:true`.
// A non-GET request is not gated (405 as before). The gate is one set of SELECTs of the marker tables; nothing is written.
async function catalogD1Route(request,env,url){
 // Decided before both authority gates, any D1 read and the owner-review overlay: a retired view reads no storage. Only GET reaches this; HEAD and other methods keep the existing 405.
 if(request.method==='GET'&&D1_RETIRED_VIEW.test(url.pathname.slice('/api/d1/'.length)))return d1RetiredViewResponse();
 let authoritative=false,first=null;
 const refuse=error=>{
  const code=error?.code||'';
  if(code==='film_person_held'||code==='film_person_unavailable'||code==='film_person_generation_moved')return json({error:'storage_unavailable',reason:code},503);
  throw error;
 };
 if(request.method==='GET'){
  try{first=await CanonicalCatalogReader.catalogReaderGate(env);authoritative=first.mode==='d1';}
  catch(error){return refuse(error);}
 }
 let response=await catalogD1Dispatch(request,env,url,authoritative);
 if(typeof OwnerReview!=='undefined'&&typeof OwnerReview.overlayCatalogResponse==='function')response=await OwnerReview.overlayCatalogResponse(env,response);
 if(first){
  // The marker is read again after every D1 and overlay read, immediately before the answer: a view read at `open` is returned only if the marker is still open at the same
  // generation; a move to held, an unreadable marker or a new generation refuses (a response already read is never returned as authoritative).
  try{
   const again=await CanonicalCatalogReader.catalogReaderGate(env);
   if(again.state!==first.state||again.generation!==first.generation)throw Object.assign(new Error('film_person_generation_moved'),{code:'film_person_generation_moved'});
  }catch(error){return refuse(error);}
 }
 return response;
}
