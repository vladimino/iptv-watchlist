// Identity of Letterboxd export codes from the Letterboxd film page the code's shortlink lands on.
// Pure: it receives already parsed ledger rows, imported identities and page observations, and returns decisions; it reads no
// file, storage, network or clock. The page parser (parseFilm of src/sources.js) is passed in, so the film page is read exactly
// as the Worker's metadata cache reads it. A decision is `accepted` only when every independent check agrees; any doubt is
// `owner_review` and any contradiction is `conflict`, because a wrong identity is worse than a missing one.
import {normTitle} from './letterboxd-match.js';

export const DECISIONS=Object.freeze(['accepted','provisional','owner_review','conflict','pending']);
// Queue order: title/year candidates and ambiguous rows first, then unmatched, then any other unresolved status.
export const QUEUE_ORDER=Object.freeze(['candidate','ambiguous','unmatched','provisional','conflict']);
export const CODE=/^[A-Za-z0-9]{1,16}$/;
const TMDB=/^\d{1,10}$/;
const FILM_PATH=/^\/film\/[a-z0-9-]+\/$/;
const yearOf=value=>/^\d{4}$/.test(String(value??''))?Number(value):null;

// ledgerRows: parsed matches.jsonl lines of the reconciliation; importedItems: parsed plan.jsonl items ({lid, tmdb}).
// Returns the ordered queue of unresolved export films and the identities that are already imported.
export function buildQueue(ledgerRows,importedItems){
 const importedCodes=new Set(),importedTmdb=new Set();
 for(const item of importedItems){if(typeof item?.lid==='string')importedCodes.add(item.lid);if(TMDB.test(String(item?.tmdb??'')))importedTmdb.add(String(item.tmdb));}
 const counts={ledgerMatches:0,acceptedInLedger:0,alreadyImported:0,invalidCode:0,duplicateCode:0,queued:0},seen=new Set(),queue=[];
 for(const row of ledgerRows){
  if(row?.type!=='match')continue;
  counts.ledgerMatches++;
  if(row.status==='accepted'){counts.acceptedInLedger++;continue;}
  if(typeof row.code!=='string'||!CODE.test(row.code)){counts.invalidCode++;continue;}
  if(importedCodes.has(row.code)){counts.alreadyImported++;continue;}
  if(seen.has(row.code)){counts.duplicateCode++;continue;}
  seen.add(row.code);
  queue.push({code:row.code,group:QUEUE_ORDER.includes(row.status)?row.status:'other',name:String(row.name??''),year:yearOf(row.year),ledgerTmdbId:TMDB.test(String(row.tmdbId??''))?String(row.tmdbId):null});
 }
 const rank=group=>{const i=QUEUE_ORDER.indexOf(group);return i<0?QUEUE_ORDER.length:i;};
 queue.sort((a,b)=>rank(a.group)-rank(b.group)||(a.code<b.code?-1:a.code>b.code?1:0));
 counts.queued=queue.length;
 return {queue,importedCodes,importedTmdb,counts};
}

// Where a redirect may go: https on boxd.it or letterboxd.com only. Returns the absolute URL or null.
export function allowedHop(location,base){
 let url;try{url=new URL(location,base);}catch{return null;}
 if(url.protocol!=='https:'||!['boxd.it','letterboxd.com'].includes(url.hostname)||url.username||url.password||url.port)return null;
 return url;
}
export const isFilmPage=url=>url?.hostname==='letterboxd.com'&&FILM_PATH.test(url.pathname)&&!url.search;

// A bot-protection or challenge page. It stops the run: the resolver never tries to get past one.
export function isChallenge(status,headers,html=''){
 if(String(headers?.get?.('cf-mitigated')??'').toLowerCase()==='challenge')return true;
 if(status!==200&&status!==404&&/cf-chl|challenge-platform|just a moment\.\.\.|attention required|captcha/i.test(html))return true;
 return status===200&&/\/cdn-cgi\/challenge-platform\/|cf-chl-opt|<title>\s*just a moment/i.test(html);
}

// The evidence one film page carries. tools: {parseFilm, attr, extractYear} loaded from src/sources.js.
// The returned object holds no HTML; it is what the private checkpoint stores.
export function pageEvidence(html,landing,{parseFilm,attr,extractYear}){
 let film;try{film=parseFilm(html,{});}catch{return {kind:'unparsable_page',path:landing.pathname};}
 const linkHref=rel=>{const tag=[...html.matchAll(/<link\b[^>]*>/gi)].map(m=>m[0]).find(tag=>attr(tag,'rel').toLowerCase()===rel);return tag?attr(tag,'href'):null;};
 const shortlink=linkHref('shortlink'),canonical=linkHref('canonical');
 const shortCode=shortlink?.match(/^https:\/\/boxd\.it\/([A-Za-z0-9]+)$/)?.[1]??null;
 let canonicalPath=null;if(canonical){try{const url=new URL(canonical);canonicalPath=url.hostname==='letterboxd.com'?url.pathname:'off_site';}catch{canonicalPath='invalid';}}
 // parseFilm reads the first data-tmdb-id; every one is collected so that a page carrying two different ids is a conflict.
 const tmdbIds=[...new Set([film.tmdbId,...[...html.matchAll(/data-tmdb-id="(\d+)"/g)].map(m=>m[1])].filter(Boolean).map(String))].sort();
 const tmdbTypes=[...new Set([...html.matchAll(/data-tmdb-type="([a-z]+)"/g)].map(m=>m[1]))].sort();
 const ogTag=[...html.matchAll(/<meta\b[^>]*>/gi)].map(m=>m[0]).find(tag=>attr(tag,'property')==='og:title');
 const ogYear=ogTag?extractYear(attr(ogTag,'content')):null;
 let ldYear=null;
 try{
  const raw=html.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1],meta=JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g,''));
  const events=Array.isArray(meta.releasedEvent)?meta.releasedEvent:meta.releasedEvent?[meta.releasedEvent]:[];
  ldYear=yearOf(String(events[0]?.startDate??'').slice(0,4));
 }catch{}
 const years=[...new Set([ogYear,ldYear].filter(Boolean))];
 return {kind:'page',path:landing.pathname,shortCode,shortlinkPresent:!!shortlink,canonicalPath,tmdbIds,tmdbTypes,title:film.original?String(film.original):null,aliases:Array.from(film.aliases||[],String).filter(alias=>alias!==film.original),years};
}

// The checks of one film against its own page observation, without looking at other films.
function ownChecks(entry,obs){
 const conflict=[],review=[];
 if(!obs)return {status:'pending',reasons:['not_fetched']};
 if(obs.kind==='failed')return {status:'pending',reasons:['fetch_failed']};
 if(obs.kind!=='page')return {status:'owner_review',reasons:[obs.kind]};
 if(!obs.shortlinkPresent)review.push('shortlink_missing');
 else if(obs.shortCode!==entry.code)conflict.push('shortlink_mismatch');
 if(obs.canonicalPath&&obs.canonicalPath!==obs.path)conflict.push('canonical_mismatch');
 if(!obs.tmdbIds.length)review.push('tmdb_missing');
 else if(obs.tmdbIds.length>1)conflict.push('tmdb_multiple');
 if(obs.tmdbIds.length&&!(obs.tmdbTypes.length===1&&obs.tmdbTypes[0]==='movie'))review.push(obs.tmdbTypes.length?'tmdb_not_movie':'tmdb_type_missing');
 const name=normTitle(entry.name);
 if(!name||!obs.title)review.push('title_missing');
 else if(normTitle(obs.title)!==name){if(obs.aliases.some(alias=>normTitle(alias)===name))review.push('title_alias_only');else conflict.push('title_differs');}
 if(obs.years.length>1)review.push('page_year_inconsistent');
 else if(!obs.years.length)review.push('page_year_missing');
 else if(!entry.year)review.push('export_year_missing');
 else{const delta=Math.abs(obs.years[0]-entry.year);if(delta===1)review.push('year_off_by_one');else if(delta>1)conflict.push('year_disagrees');}
 // The ledger's title/year candidate pointed at a stored film with another TMDB id: likely a remake or namesake.
 if(entry.ledgerTmdbId&&obs.tmdbIds.length===1&&entry.ledgerTmdbId!==obs.tmdbIds[0])review.push('ledger_candidate_differs');
 if(entry.group==='ambiguous')review.push('ledger_ambiguous');
 return conflict.length?{status:'conflict',reasons:[...conflict,...review]}:review.length?{status:'owner_review',reasons:review}:{status:'accepted',reasons:[]};
}

// queue: buildQueue().queue; observations: Map code -> evidence; imported: buildQueue() result.
// Cross-film checks (duplicate TMDB id, same title and year) run over every observed film, so a film observed later can turn
// an earlier clean result into a conflict. A clean result is therefore `accepted` only once every queued film is observed;
// until then, in a run bounded to a wave or stopped early, it is `provisional` (`queue_incomplete`) and carries no TMDB id.
export function decide(queue,observations,{importedTmdb}){
 const own=queue.map(entry=>({entry,obs:observations.get(entry.code)??null,...ownChecks(entry,observations.get(entry.code))}));
 const queueObserved=own.every(item=>item.status!=='pending');
 const tmdbOwners=new Map(),titleYear=new Map();
 for(const item of own){
  const tmdb=item.obs?.kind==='page'&&item.obs.tmdbIds.length===1?item.obs.tmdbIds[0]:null;
  if(tmdb){if(!tmdbOwners.has(tmdb))tmdbOwners.set(tmdb,new Set());tmdbOwners.get(tmdb).add(item.entry.code);}
  const key=normTitle(item.entry.name)+'|'+(item.entry.year??'');
  if(!titleYear.has(key))titleYear.set(key,new Set());titleYear.get(key).add(item.entry.code);
 }
 return own.map(({entry,obs,status,reasons})=>{
  const tmdbId=obs?.kind==='page'&&obs.tmdbIds.length===1?obs.tmdbIds[0]:null,extra=[];
  let final=status;
  if(tmdbId&&importedTmdb.has(tmdbId)){extra.push('tmdb_already_imported');final='conflict';}
  if(tmdbId&&tmdbOwners.get(tmdbId).size>1){extra.push('duplicate_tmdb');final='conflict';}
  // Two export films with one normalized title and year (a remake in the same year, a namesake) are never accepted.
  if(titleYear.get(normTitle(entry.name)+'|'+(entry.year??'')).size>1){extra.push('same_title_year');if(final==='accepted')final='owner_review';}
  if(final==='pending')return {code:entry.code,group:entry.group,decision:'pending',reasons,tmdbId:null,filmPath:null};
  if(final==='accepted'&&!queueObserved)return {code:entry.code,group:entry.group,decision:'provisional',reasons:['queue_incomplete'],tmdbId:null,observedTmdbIds:obs.tmdbIds,filmPath:obs.path,method:null};
  return {code:entry.code,group:entry.group,decision:final,reasons:[...reasons,...extra],tmdbId:final==='accepted'?tmdbId:null,observedTmdbIds:obs?.tmdbIds??[],filmPath:obs?.path??null,method:final==='accepted'?'letterboxd_page':null};
 });
}

// Aggregate counts only: no code, name, path or TMDB id. `progress` tells how far each queue group (wave) is observed;
// `final` is true only when the whole queue is observed, the only state in which decisions are final and `accepted` exists.
export function summarize(decisions,queueCounts){
 const zero=()=>Object.fromEntries(DECISIONS.map(name=>[name,0]));
 const byDecision=zero(),byGroup={},progress={},reasons={};
 for(const row of decisions){
  byDecision[row.decision]++;(byGroup[row.group]||=zero())[row.decision]++;
  const wave=progress[row.group]||={queued:0,observed:0,pending:0};wave.queued++;wave[row.decision==='pending'?'pending':'observed']++;
  for(const reason of row.reasons)reasons[reason]=(reasons[reason]||0)+1;
 }
 for(const wave of Object.values(progress))wave.waveObserved=wave.pending===0;
 return {queue:queueCounts,final:byDecision.pending===0,progress,byDecision,byGroup,reasons:Object.fromEntries(Object.entries(reasons).sort(([a],[b])=>a<b?-1:1))};
}
