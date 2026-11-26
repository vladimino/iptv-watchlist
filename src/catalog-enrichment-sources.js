// AIR-605 (card C1; ADR 0211 decision 2 as amended by ADR 0219 decisions 4, 7 and 8). The SOURCE FETCHERS of the Catalog Enrichment Producer: one request round per applicable source (Letterboxd: `boxd.it/<lid>` with at most one
// redirect to the film page; TMDB: `movie/<id>?append_to_response=credits,translations`; Wikidata: one SPARQL query). DORMANT: nothing in the Worker imports it. Each fetcher answers a normalized SourceAnswer and NEVER writes:
//   {status:'ok'|'transport'|'failed'|'disagreement', reason, fields:{year,runtime,synopsis,poster,url,genres}, credits:{status, items:[{role,key,name,nameOnly?}]}, title:{status,value?}, hints:[...], httpStatus?}
// - every request goes through the shared upstream cooldown coordinator (UC1): an active cooldown is a transport outcome that sets no failure and costs no attempt; a 429, a challenge and a 403 are written to the cooldown by the
//   coordinator, a 404 and a 5xx are not;
// - a 404 of an anchored entity is `failed` (repairable: availability, never identity, never a retirement, no fallback); a 403, a challenge, a 429, a 5xx, a timeout and a network error are `transport`;
// - Letterboxd page AGREEMENT (decision 2): the rules of the Diary check applied to the anchor. Any rule failing on a 200 page is `disagreement` (a verified conflict: owner only). A page fetched here only CONFIRMS an existing anchor;
// - the page tools (`parseFilm`, `attr`, `extractYear`) are injected: they live in the Worker's scoped source module and cannot be imported.
import {allowedHop,isFilmPage,isChallenge,pageEvidence} from './letterboxd-identity.js';
import {UpstreamCooldownSkip} from './upstream-cooldown.js';
import {selectRussianTitle} from './catalog-enrichment-plan.js';

export const TIMEOUT_MS=Object.freeze({tmdb:12000,letterboxd:15000,wikidata:15000});
export const POSTER_BASE='https://image.tmdb.org/t/p/w500';
const LID=/^[A-Za-z0-9]{1,16}$/;
const MAX_BODY=3000000;
const transport=(reason,extra={})=>({status:'transport',reason,...extra});
const failedAnswer=(reason,extra={})=>({status:'failed',reason,...extra});

// One request with a timeout and the cooldown coordinator. -> {response} or {answer} (a transport or failed answer to return as is).
async function send({coordinator,fetchImpl,url,init={},timeoutMs}){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await (coordinator?coordinator.fetch(fetchImpl,url,{...init,signal:controller.signal}):fetchImpl(url,{...init,signal:controller.signal}));
  return {response};
 }catch(error){
  if(error instanceof UpstreamCooldownSkip||error?.code==='upstream_cooldown')return {answer:transport('upstream_cooldown',{cooldownUntil:error.until?new Date(error.until).toISOString():null,kind:'cooldown'})};
  if(error?.name==='AbortError')return {answer:transport('timeout',{kind:'timeout'})};
  return {answer:transport('network_error',{kind:'network'})};
 }finally{clearTimeout(timer);}
}
// The status of a non-ok answer to its class. 404/410: availability (repairable). 403, 429, 5xx: transport. Anything else: repairable.
function failureOf(status){
 if(status===404||status===410)return failedAnswer('not_found',{httpStatus:status});
 if(status===403)return transport('forbidden',{httpStatus:status,kind:'challenge'});
 if(status===429)return transport('rate_limited',{httpStatus:status});
 if(status>=500&&status<=599)return transport('upstream_5xx',{httpStatus:status});
 return failedAnswer('unexpected_status',{httpStatus:status});
}
async function textOf(response){
 const text=await response.text();
 if(text.length>MAX_BODY)throw Object.assign(new Error('oversized'),{code:'oversized'});
 return text;
}

// ---- TMDB ----
const isoYear=value=>{const match=/^(\d{4})/.exec(String(value||''));return match?Number(match[1]):null;};
export function parseTmdb(json,id){
 if(!json||typeof json!=='object'||Array.isArray(json)||String(json.id)!==String(id))return null;
 const credits=json.credits;
 let creditAnswer={status:'unreadable',items:[]};
 if(credits&&typeof credits==='object'&&Array.isArray(credits.cast)&&Array.isArray(credits.crew)){
  const cast=[...credits.cast].filter(item=>item&&item.id!=null).sort((a,b)=>(a.order??1e9)-(b.order??1e9)).map(item=>({role:'actor',key:String(item.id),name:item.name??null}));
  const directors=credits.crew.filter(item=>item&&item.job==='Director'&&item.id!=null).map(item=>({role:'director',key:String(item.id),name:item.name??null}));
  creditAnswer={status:'ok',items:[...directors,...cast]};
 }
 return {
  fields:{year:isoYear(json.release_date),runtime:Number.isInteger(json.runtime)&&json.runtime>0?json.runtime:null,synopsis:typeof json.overview==='string'&&json.overview.trim()?json.overview.trim():null,
   poster:typeof json.poster_path==='string'&&json.poster_path.startsWith('/')?POSTER_BASE+json.poster_path:null,url:'https://www.themoviedb.org/movie/'+id,
   genres:Array.isArray(json.genres)?json.genres.map(genre=>genre?.name).filter(Boolean):[]},
  credits:creditAnswer,
  title:selectRussianTitle(json.translations),
 };
}
export async function fetchTmdb(env,{id,coordinator=null,fetchImpl=fetch,timeoutMs=TIMEOUT_MS.tmdb}){
 if(!/^[1-9]\d{0,11}$/.test(String(id)))return failedAnswer('invalid_anchor');
 const token=typeof env?.TMDB_API_READ_ACCESS_TOKEN==='string'?env.TMDB_API_READ_ACCESS_TOKEN:'';
 const url='https://api.themoviedb.org/3/movie/'+id+'?append_to_response=credits,translations';
 const sent=await send({coordinator,fetchImpl,url,init:{headers:{accept:'application/json',...(token?{authorization:'Bearer '+token}:{})}},timeoutMs});
 if(sent.answer)return sent.answer;
 const {response}=sent;
 if(!response.ok)return failureOf(response.status);
 let json;
 try{json=JSON.parse(await textOf(response));}catch{return failedAnswer('unparsable_response',{httpStatus:response.status});}
 const parsed=parseTmdb(json,id);
 if(!parsed)return failedAnswer('unexpected_document',{httpStatus:response.status});
 return {status:'ok',httpStatus:response.status,...parsed,hints:[]};
}

// ---- Wikidata (the Russian film title, keyed by the TMDB id P4947) ----
export async function fetchWikidata(env,{tmdbId,coordinator=null,fetchImpl=fetch,timeoutMs=TIMEOUT_MS.wikidata}){
 if(!/^[1-9]\d{0,11}$/.test(String(tmdbId)))return failedAnswer('invalid_anchor');
 const query='SELECT DISTINCT ?label WHERE { ?film wdt:P4947 "'+tmdbId+'". ?film rdfs:label ?label. FILTER(LANG(?label)="ru") } LIMIT 5';
 const url='https://query.wikidata.org/sparql?format=json&query='+encodeURIComponent(query);
 const sent=await send({coordinator,fetchImpl,url,init:{headers:{accept:'application/sparql-results+json'}},timeoutMs});
 if(sent.answer)return sent.answer;
 const {response}=sent;
 if(!response.ok)return failureOf(response.status);
 let json;
 try{json=JSON.parse(await textOf(response));}catch{return failedAnswer('unparsable_response',{httpStatus:response.status});}
 const bindings=json?.results?.bindings;
 if(!Array.isArray(bindings))return failedAnswer('unexpected_document',{httpStatus:response.status});
 const labels=[...new Set(bindings.map(item=>typeof item?.label?.value==='string'?item.label.value.trim():'').filter(Boolean))];
 const title=labels.length===0?{status:'absent'}:labels.length===1?{status:'value',value:labels[0]}:{status:'ambiguous'};
 return {status:'ok',httpStatus:response.status,fields:{},credits:{status:'ok',items:[]},title,hints:[]};
}

// ---- Letterboxd: the page agreement contract (decision 2) ----
// 1. request boxd.it/<lid>, at most one redirect to a letterboxd.com/film/<slug>/ page; 2. the page's shortlink code equals the anchor lid, or (no shortlink) the redirect from boxd.it/<lid> is the link;
// 3. the canonical path equals the landing path and the page parses as a film; 4. only when the Film holds a TMDB anchor: exactly one data-tmdb-id, of type movie, equal to that anchor.
// A Letterboxd-only Film's page TMDB id is an identity HINT, never a claim. -> {agreed, reasons:[...]}
export function agreement({lid,evidence,tmdbAnchor}){
 const reasons=[];
 if(evidence.kind!=='page')return {agreed:false,reasons:[evidence.kind]};
 if(evidence.shortlinkPresent){if(evidence.shortCode!==lid)reasons.push('shortlink_mismatch');}
 if(evidence.canonicalPath&&evidence.canonicalPath!==evidence.path)reasons.push('canonical_mismatch');
 if(tmdbAnchor){
  if(evidence.tmdbIds.length!==1)reasons.push(evidence.tmdbIds.length?'tmdb_multiple':'tmdb_missing');
  else if(evidence.tmdbIds[0]!==String(tmdbAnchor))reasons.push('tmdb_differs');
  if(evidence.tmdbIds.length&&!(evidence.tmdbTypes.length===1&&evidence.tmdbTypes[0]==='movie'))reasons.push('tmdb_not_movie');
 }
 return {agreed:reasons.length===0,reasons};
}
export async function fetchLetterboxd(env,{lid,tmdbAnchor=null,coordinator=null,fetchImpl=fetch,tools,timeoutMs=TIMEOUT_MS.letterboxd}){
 if(!LID.test(String(lid||''))||!tools||typeof tools.parseFilm!=='function')return failedAnswer('invalid_anchor');
 const start='https://boxd.it/'+lid;
 const first=await send({coordinator,fetchImpl,url:start,init:{redirect:'manual',headers:{accept:'text/html'}},timeoutMs});
 if(first.answer)return first.answer;
 let response=first.response,landing=new URL(start),redirectCode=lid;
 if(response.status>=300&&response.status<400){
  const location=response.headers?.get?.('location');
  let hop=null;
  try{hop=location?new URL(location,start):null;}catch{hop=null;}
  if(!hop||!allowedHop(location,start)||!isFilmPage(hop))return failedAnswer('unexpected_redirect',{httpStatus:response.status});
  const second=await send({coordinator,fetchImpl,url:hop.href,init:{redirect:'manual',headers:{accept:'text/html'}},timeoutMs});
  if(second.answer)return second.answer;
  response=second.response;landing=hop;
 }
 if(!response.ok)return failureOf(response.status);
 let html;
 try{html=await textOf(response);}catch{return failedAnswer('unparsable_response',{httpStatus:response.status});}
 // a challenge page behind a 200 is a blocked answer, never a page
 if(isChallenge(response.status,response.headers,html)){
  if(coordinator)await coordinator.after('letterboxd',{status:response.status,headers:response.headers,html}).catch(()=>{});
  return transport('challenge',{kind:'challenge',httpStatus:response.status});
 }
 if(!isFilmPage(landing))return failedAnswer('not_a_film_page',{httpStatus:response.status});
 const evidence=pageEvidence(html,landing,tools);
 if(evidence.kind==='page')evidence.redirectCode=redirectCode;
 const verdict=agreement({lid,evidence,tmdbAnchor});
 // A page that does not parse as a film is an invalid page: repairable availability, no fallback; a page that parses but breaks a rule is a verified disagreement.
 if(evidence.kind!=='page')return failedAnswer(evidence.kind,{httpStatus:response.status});
 const hints=[];
 if(!tmdbAnchor&&evidence.tmdbIds.length)hints.push({kind:'page_tmdb_id',values:evidence.tmdbIds});
 if(!verdict.agreed)return {status:'disagreement',reason:verdict.reasons.join(','),reasons:verdict.reasons,httpStatus:response.status,hints,fields:{},credits:{status:'ok',items:[]},title:{status:'absent'},agreed:false};
 let film;
 // every correctly identified credit: the shared parser without its legacy display cap (ADR 0219 decision 8)
 try{film=tools.parseFilm(html,{},{actors:Infinity});}catch{return failedAnswer('unparsable_page',{httpStatus:response.status});}
 const name=value=>typeof value?.name==='string'?value.name:null;
 const person=(role,list)=>(list||[]).map(item=>{
  const slug=typeof item?.id==='string'&&item.id.startsWith(role+'/')?item.id.slice(role.length+1):null;
  // parseFilm falls back to the display name when a person has no profile link: that id is NOT a person slug, so it is a name-only credit
  const nameOnly=!slug||slug===item.name||slug===item.original;
  return {role,key:nameOnly?null:slug,name:name(item)||item?.original||null,nameOnly};
 });
 return {
  status:'ok',httpStatus:response.status,agreed:true,hints,
  fields:{year:Number.isInteger(film.year)?film.year:(evidence.years[0]?Number(evidence.years[0]):null),runtime:Number.isInteger(film.runtime)&&film.runtime>0?film.runtime:null,synopsis:film.synopsis||null,poster:film.poster||null,url:landing.href,genres:Array.isArray(film.genres)?film.genres:[]},
  // an absent or malformed credits section is unreadable, never a complete empty set (a parser that reports no `creditsComplete` flag is read as complete)
  credits:{status:film.creditsComplete===false?'unreadable':'ok',items:film.creditsComplete===false?[]:[...person('director',film.directors),...person('actor',film.actors)]},
  // The Letterboxd page carries no Russian title: the source row is an honest, complete absence until a parser decision says otherwise.
  title:{status:'absent'},
 };
}
