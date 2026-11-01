// ADR 0081. Owner-reviewed Film titles and Person names.
// Schema before these tables keeps the R2 object and does not query them.
// Once the tables exist, mode r2 still stores the object and fences generation
// before the put. Mode d1 reads and writes the rows and does not fall back to
// the object. A missing binding is not this marker. This module does not import.
// The Worker bundle wraps it in a scope.

export const OWNER_REVIEWS_KEY='admin/owner-reviews.json';
const FENCE_SQL='UPDATE owner_review_cas SET ok=changes() WHERE id=1';
const JSON_PUT={httpMetadata:{contentType:'application/json'}};
const D1_BOUND_PARAMETERS=100;

function failed(code,cause){const error=new Error(code);error.code=code;if(cause)error.cause=cause;return error;}
function binding(db){return typeof db?.prepare==='function';}
async function one(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).first())??null;
 return (await db.get(sql,params))??null;
}
async function many(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).all()).results||[];
 return (await db.all(sql,params))||[];
}
async function fenced(db,statements){
 if(typeof db.batch!=='function')throw failed('owner_review_unavailable');
 if(statements.some(([,params])=>params.length>D1_BOUND_PARAMETERS))throw failed('owner_review_unavailable');
 const prepared=statements.map(([sql,params])=>db.prepare(sql).bind(...params));
 try{await db.batch(prepared);}
 catch(error){
  const message=String(error?.message||error);
  if(/CHECK constraint failed|schema_contract_downgrade/i.test(message))throw failed('owner_review_cas',error);
  throw failed('owner_review_unavailable',error);
 }
}
function plain(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
export function ownerReviewDocument(body){
 if(!plain(body)||body.contractVersion!==1||!plain(body.films)||!plain(body.people))return null;
 return {contractVersion:1,films:{...body.films},people:{...body.people}};
}
function emptyDocument(){return {contractVersion:1,films:{},people:{}};}
function sameValue(left,right){
 if(left===right)return true;
 if(typeof left!==typeof right||left===null||right===null||Array.isArray(left)!==Array.isArray(right))return false;
 if(Array.isArray(left))return left.length===right.length&&left.every((item,index)=>sameValue(item,right[index]));
 if(typeof left==='object'){const keys=Object.keys(left);return keys.length===Object.keys(right).length&&keys.every(key=>Object.prototype.hasOwnProperty.call(right,key)&&sameValue(left[key],right[key]));}
 return false;
}
function payload(record){return JSON.stringify(record===undefined?null:record);}
function revisionOf(generation){return 'd1:'+generation;}
export function ownerReviewRevision(generation){return revisionOf(generation);}

export async function readAuthority(db){
 if(!binding(db))return {legacy:true,mode:'r2',tables:false,version:null,failClosed:false};
 let version;
 try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error)))return {legacy:true,mode:'r2',tables:false,version:null,failClosed:false};
  return {legacy:false,mode:null,tables:false,version:null,failClosed:true};
 }
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('owner_review_entry','owner_review_authority','owner_review_cas')")).map(row=>row.name);}
 catch{return {legacy:false,mode:null,tables:false,version,failClosed:true};}
 const tables=names.includes('owner_review_entry')&&names.includes('owner_review_authority')&&names.includes('owner_review_cas');
 if(!tables)return Number(version)>=9
  ?{legacy:false,mode:null,tables:false,version,failClosed:true}
  :{legacy:true,mode:'r2',tables:false,version,failClosed:false};
 let row;
 try{row=await one(db,'SELECT mode, generation, mirror_generation AS mirrorGeneration, mirror_etag AS mirrorEtag, writes FROM owner_review_authority WHERE id=1');}
 catch{return {legacy:false,mode:null,tables:true,version,failClosed:true};}
 if(!row||(row.mode!=='r2'&&row.mode!=='d1')||(row.writes!=='open'&&row.writes!=='held'))return {legacy:false,mode:null,tables:true,version,failClosed:true};
 return {legacy:false,mode:row.mode,tables:true,version,failClosed:false,generation:Number(row.generation),mirrorGeneration:Number(row.mirrorGeneration),mirrorEtag:row.mirrorEtag??null,writes:row.writes,revision:row.mode==='d1'?revisionOf(Number(row.generation)):null};
}

export async function readDocument(db){
 let rows;
 try{rows=await many(db,'SELECT kind, source_key, payload_json, identity_link, identity_state FROM owner_review_entry ORDER BY kind, source_key');}
 catch{return null;}
 const films={},people={};
 for(const row of rows){
  let parsed;
  try{parsed=JSON.parse(row.payload_json);}catch{return null;}
  if(row.kind==='film')films[row.source_key]=parsed;
  else if(row.kind==='person')people[row.source_key]=parsed;
  else return null;
 }
 return {contractVersion:1,films,people};
}

async function classify(db,kind,sourceKey){
 const held={identityLink:null,identityState:'held'};
 try{
  if(kind==='person'){
   const role=sourceKey.startsWith('person:')?sourceKey.slice('person:'.length):sourceKey;
   const rows=await many(db,'SELECT id FROM person WHERE id=? OR role_id=?',[sourceKey,role]);
   if(rows.length!==1||typeof rows[0].id!=='string'||!rows[0].id.startsWith('person:'))return held;
   return {identityLink:rows[0].id,identityState:'verified'};
  }
  const found=new Set();
  if(!sourceKey.startsWith('tmdb_tv')){
   for(const row of await many(db,'SELECT id FROM film WHERE id=?',['film:'+sourceKey]))if(typeof row.id==='string')found.add(row.id);
   const redirect=await many(db,'SELECT to_film_id AS id FROM film_redirect WHERE from_id=?',['film:'+sourceKey]);
   for(const row of redirect)if(typeof row.id==='string')found.add(row.id);
   const movie=/^tmdb_(\d+)$/.exec(sourceKey);
   if(movie){
    const links=await many(db,"SELECT film_id AS id FROM film_external_id WHERE scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0",[movie[1]]);
    for(const row of links)if(typeof row.id==='string')found.add(row.id);
   }else if(!sourceKey.startsWith('tmdb_')){
    const links=await many(db,"SELECT film_id AS id FROM film_external_id WHERE scheme='letterboxd' AND value=? AND trusted=1 AND conflicting=0",[sourceKey]);
    for(const row of links)if(typeof row.id==='string')found.add(row.id);
   }
  }
  if(found.size!==1)return held;
  const id=[...found][0];
  if(!id.startsWith('film:'))return held;
  return {identityLink:id,identityState:'verified'};
 }catch(error){
  if(/no such table/i.test(String(error?.message||error)))return held;
  return held;
 }
}

function entriesOf(document){
 const rows=[];
 for(const [sourceKey,slice] of Object.entries(document.films))rows.push(['film',sourceKey,slice]);
 for(const [sourceKey,slice] of Object.entries(document.people))rows.push(['person',sourceKey,slice]);
 return rows;
}
async function replaceStatements(db,document,generation){
 const statements=[['DELETE FROM owner_review_entry',[]]];
 for(const [kind,sourceKey,slice] of entriesOf(document)){
  const link=await classify(db,kind,sourceKey);
  statements.push(['INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES (?,?,?,?,?,?)',[kind,sourceKey,payload(slice),link.identityLink,link.identityState,generation]]);
 }
 return statements;
}

async function publishMirror(db,bucket,document,generation,mode){
 const text=JSON.stringify(document);
 let current=await readAuthority(db);
 if(current.mode!==mode||current.generation!==generation)return {mirrored:false,authority:current};
 const object=await bucket.get(OWNER_REVIEWS_KEY);
 let saved=null;
 if(object&&current.mirrorEtag&&object.etag===current.mirrorEtag){
  let parsed;try{parsed=await object.json();}catch{parsed=undefined;}
  if(sameValue(ownerReviewDocument(parsed),document))saved={etag:object.etag};
 }
 if(!saved){
  current=await readAuthority(db);
  if(current.mode!==mode||current.generation!==generation)return {mirrored:false,authority:current};
  const onlyIf=current.mirrorEtag?{etagMatches:current.mirrorEtag}:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'};
  try{saved=await bucket.put(OWNER_REVIEWS_KEY,text,{...JSON_PUT,onlyIf});}
  catch{return {mirrored:false,authority:await readAuthority(db)};}
 }
 if(!saved?.etag)return {mirrored:false,authority:await readAuthority(db)};
 await db.prepare('UPDATE owner_review_authority SET mirror_generation=?, mirror_etag=? WHERE id=1 AND mode=? AND generation=?').bind(generation,saved.etag,mode,generation).run();
 return {mirrored:true,authority:await readAuthority(db)};
}

export async function commit(env,{expectedRevision=null,document}={}){
 const db=env?.DB;
 const gate=await readAuthority(db);
 if(gate.legacy)return null;
 if(gate.failClosed)return {ok:false,reason:'owner_review_unavailable'};
 const next=ownerReviewDocument(document);
 if(!next)return {ok:false,reason:'overlay_invalid'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 if(gate.mode==='d1'){
  if(expectedRevision!==revisionOf(gate.generation))return {ok:false,reason:'version_conflict'};
  const generation=gate.generation+1;
  const statements=[
   ['UPDATE owner_review_authority SET generation=? WHERE id=1 AND mode=\'d1\' AND writes=\'open\' AND generation=?',[generation,gate.generation]],
   [FENCE_SQL,[]],
   ...await replaceStatements(db,next,generation),
  ];
  try{await fenced(db,statements);}catch(error){return {ok:false,reason:error.code==='owner_review_cas'?'version_conflict':'commit_unknown'};}
  const after=await readAuthority(db);
  if(after.generation!==generation||after.mode!=='d1')return {ok:false,reason:'commit_unknown'};
  try{await publishMirror(db,env.BUCKET,next,generation,'d1');}catch{/* the rows are the authority; the mirror may lag */}
  return {ok:true,revision:revisionOf(generation),generation};
 }
 const generation=gate.generation+1;
 try{await fenced(db,[
  ['UPDATE owner_review_authority SET generation=? WHERE id=1 AND mode=\'r2\' AND writes=\'open\' AND generation=?',[generation,gate.generation]],
  [FENCE_SQL,[]],
 ]);}catch(error){return {ok:false,reason:error.code==='owner_review_cas'?'version_conflict':'commit_unknown'};}
 let saved;
 try{
  const onlyIf=expectedRevision?{etagMatches:expectedRevision}:{etagDoesNotMatch:'*'};
  saved=await env.BUCKET.put(OWNER_REVIEWS_KEY,JSON.stringify(next),{...JSON_PUT,onlyIf});
 }catch{return {ok:false,reason:'commit_unknown'};}
 if(!saved)return {ok:false,reason:'version_conflict'};
 try{await db.prepare('UPDATE owner_review_authority SET mirror_generation=?, mirror_etag=? WHERE id=1 AND mode=\'r2\' AND generation=?').bind(generation,saved.etag,generation).run();}catch{return {ok:false,reason:'commit_unknown'};}
 return {ok:true,revision:saved.etag,generation,legacy:false};
}

export async function readBack(env){
 const gate=await readAuthority(env?.DB);
 if(gate.legacy||gate.mode==='r2')return null;
 if(gate.failClosed||gate.mode!=='d1')return {unavailable:true};
 const body=await readDocument(env.DB);
 if(!body)return {unavailable:true};
 return {body};
}

export async function loadSnapshotReviews(env){
 const gate=await readAuthority(env?.DB);
 if(gate.legacy||gate.mode==='r2')return null;
 if(gate.failClosed||gate.mode!=='d1')throw failed('owner_review_unavailable');
 const body=await readDocument(env.DB);
 if(!body)throw failed('owner_review_unavailable');
 const version=revisionOf(gate.generation);
 return {present:true,version,etag:version,uploaded:null,body,reused:false};
}

export async function loadForRead(env){
 const gate=await readAuthority(env?.DB);
 if(gate.failClosed)return {ok:false,unavailable:true,body:null};
 if(gate.legacy||gate.mode==='r2'){
  let object;
  try{object=await env.BUCKET.get(OWNER_REVIEWS_KEY);}catch{return {ok:false,unavailable:true,body:null};}
  if(!object)return {ok:true,unavailable:false,body:null,mode:gate.mode||'r2'};
  try{return {ok:true,unavailable:false,body:await object.json(),mode:gate.mode||'r2'};}
  catch{return {ok:false,unavailable:true,body:null};}
 }
 const body=await readDocument(env.DB);
 if(!body)return {ok:false,unavailable:true,body:null};
 return {ok:true,unavailable:false,body,mode:'d1',revision:revisionOf(gate.generation)};
}

function ownerText(entry){
 const localization=entry?.localization;
 return localization&&localization.status==='reviewed'&&localization.provenance?.authority==='owner'&&localization.value?localization.value:null;
}
function filmMatches(sourceKey,identityLink,filmId){
 if(identityLink&&identityLink===filmId)return true;
 if(filmId==='film:'+sourceKey)return true;
 const movie=/^tmdb_(\d+)$/.exec(sourceKey);
 return !!movie&&filmId==='film:tmdb:'+movie[1];
}
function personMatches(sourceKey,identityLink,personId){
 if(!personId)return false;
 if(identityLink&&identityLink===personId)return true;
 if(sourceKey===personId)return true;
 return sourceKey.startsWith('person:')&&personId===sourceKey;
}
export function overlayCatalogBody(body,document,links=[]){
 if(!body||typeof body!=='object')return body;
 const films=document?.films&&typeof document.films==='object'?document.films:{};
 const people=document?.people&&typeof document.people==='object'?document.people:{};
 const linkOf=new Map(links.map(row=>[row.kind+'\n'+row.sourceKey,row]));
 const filmValue=filmId=>{
  for(const [sourceKey,entry] of Object.entries(films)){
   const link=linkOf.get('film\n'+sourceKey);
   if(filmMatches(sourceKey,link?.identityLink||null,filmId)){const value=ownerText(entry);if(value)return value;}
  }
  return null;
 };
 const personValue=personId=>{
  for(const [sourceKey,entry] of Object.entries(people)){
   const link=linkOf.get('person\n'+sourceKey);
   if(personMatches(sourceKey,link?.identityLink||null,personId)){const value=ownerText(entry);if(value)return value;}
  }
  return null;
 };
 const next={...body};
 if(typeof next.id==='string'&&typeof next.title==='string'){const value=filmValue(next.id);if(value)next.title=value;}
 if(typeof next.id==='string'&&next.id.startsWith('person:')){const value=personValue(next.id);if(value)next.localName=value;}
 if(Array.isArray(next.credits))next.credits=next.credits.map(credit=>{const value=personValue(credit?.id);return value?{...credit,localName:value}:credit;});
 if(Array.isArray(next.films))next.films=next.films.map(film=>{const value=filmValue(film?.id);return value?{...film,title:value}:film;});
 if(Array.isArray(next.items))next.items=next.items.map(item=>{
  if(typeof item?.id==='string'&&item.id.startsWith('person:')){const value=personValue(item.id);return value?{...item,localName:value}:item;}
  if(typeof item?.id==='string'&&item.id.startsWith('film:')){const value=filmValue(item.id);return value?{...item,title:value}:item;}
  return item;
 });
 return next;
}

export async function readLinks(db){
 try{return (await many(db,'SELECT kind, source_key AS sourceKey, identity_link AS identityLink, identity_state AS identityState FROM owner_review_entry')).map(row=>({kind:row.kind,sourceKey:row.sourceKey,identityLink:row.identityLink??null,identityState:row.identityState}));}
 catch{return null;}
}

export async function overlayCatalogResponse(env,response){
 const gate=await readAuthority(env?.DB);
 if(gate.legacy)return response;
 if(gate.failClosed)return jsonUnavailable();
 if(!response||response.status!==200)return response;
 let body;
 try{body=await response.json();}catch{return response;}
 let document,links=[];
 if(gate.mode==='d1'){
  document=await readDocument(env.DB);
  links=await readLinks(env.DB);
  if(!document||!links)return jsonUnavailable();
 }else{
  const loaded=await loadForRead(env);
  if(!loaded.ok)return jsonUnavailable();
  document=ownerReviewDocument(loaded.body)||emptyDocument();
 }
 const headers=new Headers(response.headers);
 headers.set('content-type','application/json; charset=utf-8');
 return new Response(JSON.stringify(overlayCatalogBody(body,document,links)),{status:200,headers});
}
function jsonUnavailable(){return new Response(JSON.stringify({error:'storage_unavailable',reason:'owner_review_unavailable'}),{status:503,headers:{'content-type':'application/json; charset=utf-8'}});}

function filmEntryFor(films,filmId){
 if(!filmId||!films)return null;
 if(films[filmId])return films[filmId];
 if(filmId.startsWith('film:')){
  const stored=filmId.slice('film:'.length);
  if(films[stored])return films[stored];
  if(stored.startsWith('tmdb:')){const key='tmdb_'+stored.slice('tmdb:'.length);if(films[key])return films[key];}
 }
 return null;
}
export function applyViewOverlay(view,document){
 const doc=ownerReviewDocument(document);
 if(!doc||!view)return view;
 for(const film of view.films||[]){
  const entry=filmEntryFor(doc.films,film?.id);
  if(!ownerText(entry))continue;
  film.localization=entry.localization;
  if(Array.isArray(entry.aliases))film.aliases=entry.aliases;
  if(Array.isArray(entry.localizationConflicts))film.localizationConflicts=entry.localizationConflicts;
  if(Array.isArray(entry.titleReviews))film.titleReviews=entry.titleReviews;
 }
 for(const person of view.people||[]){
  const entry=person?.id?doc.people[person.id]||null:null;
  if(!ownerText(entry))continue;
  person.localization=entry.localization;
  if(Array.isArray(entry.aliases))person.aliases=entry.aliases;
  if(Array.isArray(entry.localizationConflicts))person.localizationConflicts=entry.localizationConflicts;
  if(Array.isArray(entry.nameReviews))person.nameReviews=entry.nameReviews;
  if(Array.isArray(entry.roleLinks))person.roleLinks=entry.roleLinks;
 }
 return view;
}
export function stampLocalized(data,document){
 const doc=ownerReviewDocument(document);
 if(!doc)return data;
 const films=doc.films;
 for(const film of data?.films||[]){
  const entry=films[String(film.id)];
  if(!entry)continue;
  const value=ownerText(entry);
  const extra=(entry.aliases||[]).map(alias=>alias&&alias.value).filter(Boolean);
  if(value){
   const kept=extra.filter(alias=>alias!==value);
   const previous=[...(film.aliases||[]),film.title,film.titleRu,film.original,...kept].filter(alias=>alias&&alias!==value);
   film.aliases=[...new Set(previous)];
   film.title=value;film.titleRu=value;film.titleStatus='reviewed';film.titleAuthority='owner';film.titleSources=['owner'];
  }else if(extra.length)film.aliases=[...new Set([...(film.aliases||[]),...extra])];
 }
 const people=doc.people;
 const visit=person=>{
  if(!person||typeof person.id!=='string')return;
  const record=people['person:'+person.id]||people[person.id]||null;
  if(!record)return;
  const value=ownerText(record);
  if(value){
   const previous=[person.name,person.original,...(person.aliases||[]),...(record.aliases||[]).map(alias=>alias?.value)].filter(item=>item&&item!==value);
   person.name=value;person.nameStatus='reviewed';person.nameAuthority='owner';person.nameSource='owner';person.aliases=[...new Set(previous)];
   return;
  }
  const extra=(record.aliases||[]).map(alias=>alias&&alias.value).filter(item=>item&&item!==person.name);
  if(extra.length)person.aliases=[...new Set([...(person.aliases||[]),...extra])];
 };
 for(const film of data?.films||[])for(const person of [...(film.directors||[]),...(film.actors||[])])visit(person);
 for(const key of ['actors','directors'])for(const person of data?.people?.[key]||[])visit(person);
 return data;
}

async function countTable(db,table){
 try{return Number((await one(db,'SELECT COUNT(*) AS n FROM '+table))?.n)||0;}
 catch(error){if(/no such table/i.test(String(error?.message||error)))return null;throw error;}
}
async function prove(db,document){
 const stored=await readDocument(db);
 if(!stored||!sameValue(stored,document))throw failed('owner_review_loss');
 const count=entriesOf(document).length;
 const rows=await one(db,'SELECT COUNT(*) AS n FROM owner_review_entry');
 if(Number(rows?.n)!==count)throw failed('owner_review_loss');
 return {films:await countTable(db,'film'),people:await countTable(db,'person')};
}

export async function importOwnerReviews(db,bucket,{confirm}={}){
 if(confirm!=='load')throw failed('owner_review_confirm');
 const gate=await readAuthority(db);
 if(gate.legacy||gate.failClosed||gate.mode!=='r2'||gate.writes!=='open')throw failed('owner_review_schema');
 let object;
 try{object=await bucket.get(OWNER_REVIEWS_KEY);}catch(error){throw failed('owner_review_unreadable',error);}
 let document;
 if(!object)document=emptyDocument();
 else{
  let body;try{body=await object.json();}catch{throw failed('owner_review_unreadable');}
  document=ownerReviewDocument(body);
  if(!document)throw failed('owner_review_shape');
  const again=await bucket.head(OWNER_REVIEWS_KEY);
  if((again?.etag??null)!==(object.etag??null))throw failed('owner_review_fence');
 }
 const generation=gate.generation+1;
 const statements=[
  ['UPDATE owner_review_authority SET writes=\'held\' WHERE id=1 AND mode=\'r2\' AND writes=\'open\' AND generation=?',[gate.generation]],
  [FENCE_SQL,[]],
  ...await replaceStatements(db,document,generation),
  ['UPDATE owner_review_authority SET generation=?, mirror_generation=?, mirror_etag=?, writes=\'open\' WHERE id=1 AND mode=\'r2\' AND writes=\'held\' AND generation=?',[generation,generation,object?.etag??null,gate.generation]],
  [FENCE_SQL,[]],
 ];
 await fenced(db,statements);
 const after=await readAuthority(db);
 if(after.mode!=='r2'||after.generation!==generation||after.writes!=='open')throw failed('owner_review_cas');
 const proof=await prove(db,document);
 return {mode:'r2',generation,absent:!object,entries:entriesOf(document).length,...proof,writes:false};
}

export async function activateOwnerReviews(db,bucket,{confirm}={}){
 if(confirm!=='activate')throw failed('owner_review_confirm');
 const gate=await readAuthority(db);
 if(gate.legacy||gate.failClosed||gate.mode!=='r2'||gate.writes!=='open'||gate.generation!==gate.mirrorGeneration)throw failed('owner_review_fence');
 let object;try{object=await bucket.get(OWNER_REVIEWS_KEY);}catch{throw failed('owner_review_unreadable');}
 let document;
 if(!object){
  if(gate.mirrorEtag!==null)throw failed('owner_review_fence');
  document=emptyDocument();
 }else{
  if(object.etag!==gate.mirrorEtag)throw failed('owner_review_fence');
  let body;try{body=await object.json();}catch{throw failed('owner_review_unreadable');}
  document=ownerReviewDocument(body);
  if(!document)throw failed('owner_review_shape');
 }
 await prove(db,document);
 const etagSql=gate.mirrorEtag==null?'mirror_etag IS NULL':'mirror_etag=?';
 const etagParams=gate.mirrorEtag==null?[gate.generation,gate.generation]:[gate.generation,gate.generation,gate.mirrorEtag];
 await fenced(db,[
  ['UPDATE owner_review_authority SET mode=\'d1\' WHERE id=1 AND mode=\'r2\' AND writes=\'open\' AND generation=? AND mirror_generation=? AND '+etagSql,etagParams],
  [FENCE_SQL,[]],
 ]);
 const after=await readAuthority(db);
 if(after.mode!=='d1')throw failed('owner_review_cas');
 return {mode:'d1',generation:after.generation,writes:false};
}

export async function revertOwnerReviews(db,bucket,{confirm}={}){
 if(confirm!=='r2')throw failed('owner_review_confirm');
 const gate=await readAuthority(db);
 if(gate.legacy||gate.failClosed||gate.mode!=='d1'||gate.writes!=='open')throw failed('owner_review_schema');
 const document=await readDocument(db);
 if(!document)throw failed('owner_review_unavailable');
 const published=await publishMirror(db,bucket,document,gate.generation,'d1');
 if(!published.mirrored)throw failed('owner_review_fence');
 const mirror=await bucket.get(OWNER_REVIEWS_KEY);
 let body;try{body=mirror?await mirror.json():null;}catch{throw failed('owner_review_unreadable');}
 if(!sameValue(ownerReviewDocument(body),document))throw failed('owner_review_loss');
 await fenced(db,[
  ['UPDATE owner_review_authority SET mode=\'r2\' WHERE id=1 AND mode=\'d1\' AND writes=\'open\' AND generation=? AND mirror_generation=? AND mirror_etag=?',[gate.generation,published.authority.mirrorGeneration,published.authority.mirrorEtag]],
  [FENCE_SQL,[]],
 ]);
 const after=await readAuthority(db);
 if(after.mode!=='r2')throw failed('owner_review_cas');
 return {mode:'r2',generation:after.generation,writes:false};
}
