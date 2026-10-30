// Read-only relational views over the D1 catalog (AIR-275 phase 1). Persons are entities here: one row per Letterboxd role
// slug, with their names, external ids and filmography, plus review queues for people stored twice. Nothing here writes,
// and nothing reads R2; R2 stays authoritative for every existing page until a later phase moves it.
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
async function d1Status(db){
 const counts=await d1First(db,`select (select count(*) from film) films,(select count(*) from person) persons,(select count(*) from film_person_credit) credits,(select count(*) from candidate) candidates,(select count(*) from prediction_current) predictions,(select count(*) from actual_rating) ratings,(select max(imported_at) from import_receipt) lastImport,(select version from schema_contract where id=1) schemaVersion`);
 return {source:'d1',authoritative:false,...counts};
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
async function catalogD1Route(request,env,url){
 if(request.method!=='GET')return json({error:'Method not allowed'},405);
 if(!env.DB)return json({error:'D1 is not bound to this Worker'},503);
 const path=url.pathname.slice('/api/d1/'.length),params=url.searchParams;
 if(path==='status')return json(await d1Status(env.DB));
 if(path==='persons')return json(await d1Persons(env.DB,{q:params.get('q'),role:params.get('role'),source:params.get('source'),cursor:params.get('cursor'),limit:params.get('limit')}));
 if(path==='persons/review')return json(await d1PersonReview(env.DB,{limit:params.get('limit')}));
 let match=path.match(/^persons\/((?:tmdb_)?(?:actor|director)\/[^/]{1,200})$/);
 if(match){const person=await d1Person(env.DB,'person:'+decodeURIComponent(match[1]));return person?json(person):json({error:'Person not found'},404);}
 match=path.match(/^films\/([^/]{1,200})$/);
 if(match){const film=await d1Film(env.DB,'film:'+decodeURIComponent(match[1]));return film?json(film):json({error:'Film not found'},404);}
 return json({error:'Not found'},404);
}
