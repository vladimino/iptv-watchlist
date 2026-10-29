// Letterboxd Diary viewing history (AIR-51, ADR 0048): one record per confirmed diary row, re-watches included, kept
// apart from the current actualRating. Read incrementally from the owner's public diary pages, a bounded number per
// run, same origin only, no retry and no challenge handling. A row is never a rating fact and absence from the diary
// never means "not watched". Contract: docs/reference/integrations/letterboxd-diary-history.md.
// Concatenated into the Worker like the other server modules: one global, no exports.
const LetterboxdDiary=(()=>{
 const KEYS={history:'letterboxd/diary/history.json',state:'letterboxd/diary/state.json'};
 const MAX_PAGES=3,MAX_CHANGES=10,STOP_PAGE=500;
 const LID=/^[A-Za-z0-9_-]{1,80}$/;
 const enabled=env=>env?.LETTERBOXD_DIARY_HISTORY==='on';
 const HEADERS={'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html','Accept-Language':'en-US,en;q=0.9'};
 const pageUrl=(username,page)=>`https://letterboxd.com/${username}/diary/`+(page>1?`page/${page}/`:'');
 const attr=(tag,name)=>tag.match(new RegExp('\\s'+name+'=(["\'])(.*?)\\1','i'))?.[2]??null;
 const decode=text=>String(text).replaceAll('&quot;','"').replaceAll('&#34;','"').replaceAll('&amp;','&');

 // Calendar date from a /<user>/diary/films/for/YYYY/MM/DD/ link; null unless it is a real date.
 function dayFrom(path){
  const day=path.match(/^\/[A-Za-z0-9_-]+\/diary\/films\/for\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/$/);if(!day)return null;
  const value=day[1]+'-'+day[2].padStart(2,'0')+'-'+day[3].padStart(2,'0'),time=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value?value:null;
 }
 // Re-watch only when the row says so explicitly; otherwise unknown. Never inferred from rating or watchlist.
 function rewatchOf(row){
  const flag=row.match(/\sdata-rewatch=(["'])(true|false)\1/i)?.[2];if(flag)return flag.toLowerCase()==='true';
  const cell=row.match(/<td\b[^>]*class=(["'])([^"']*\btd-rewatch\b[^"']*)\1/i)?.[2];
  if(cell)return /\bicon-status-off\b/.test(cell)?false:/\bicon-rewatch\b/.test(cell)?true:'unknown';
  return 'unknown';
 }
 // One diary page: rows in page order. A row keeps only what it states: lid from the poster identifier, the film slug
 // and the watched date from same-origin links, the star rating at that entry, the re-watch marker, a viewing id.
 function parsePage(html){
  const challenge=/<title>\s*Just a moment/i.test(html),rows=[];
  for(const match of html.matchAll(/<tr\b([^>]*\bclass=(["'])[^"']*\bdiary-entry-row\b[^"']*\2[^>]*)>([\s\S]*?)<\/tr>/gi)){
   const open=match[1],body=match[3],poster=decode(body.match(/data-postered-identifier=(["'])(.*?)\1/i)?.[2]||'');
   let lid=null;try{const value=JSON.parse(poster)?.lid;if(LID.test(String(value||'')))lid=String(value);}catch{}
   let slug=null,watchedDate=null;
   for(const anchor of body.matchAll(/<a\b[^>]*\shref=(["'])(.*?)\1/gi)){
    let link;try{link=new URL(decode(anchor[2]),'https://letterboxd.com');}catch{continue;}
    if(link.origin!=='https://letterboxd.com')continue;
    const film=link.pathname.match(/^\/(?:[A-Za-z0-9_-]+\/)?film\/([a-z0-9][a-z0-9-]*)\/(?:\d+\/)?$/i);
    if(film&&!slug)slug=film[1].toLowerCase();
    if(!watchedDate)watchedDate=dayFrom(link.pathname);
   }
   const stars=body.match(/\brated-(10|[1-9])\b/)?.[1];
   const viewing=attr(open,'data-viewing-id')||decode(attr(open,'data-object-id')||'').match(/^viewing:(\d+)$/)?.[1]||null;
   rows.push({lid,slug,watchedDate,ratingAtEntry:stars?Number(stars)/2:null,rewatch:rewatchOf(match[0]),viewingId:viewing&&/^\d{1,20}$/.test(viewing)?viewing:null});
  }
  return {challenge,rows,next:/<a\b[^>]*\bclass=(["'])[^"']*\bnext\b[^"']*\1/i.test(html)};
 }
 // The entry key. A viewing id when the row carries one; otherwise identity, date and the occurrence of that pair in
 // this read, so two viewings of one film on one day stay two entries and a rescan maps them back to the same keys.
 function keyRows(rows){
  const seen=new Map();
  return rows.map(row=>{
   if(row.viewingId)return {...row,key:'viewing:'+row.viewingId,keyBasis:'viewing_id'};
   const identity=row.lid?'lid:'+row.lid:row.slug?'slug:'+row.slug:null;
   if(!identity||!row.watchedDate)return {...row,key:null,keyBasis:null};
   const base=identity+'|'+row.watchedDate,n=(seen.get(base)||0)+1;seen.set(base,n);
   return {...row,key:'derived:'+base+'|'+n,keyBasis:'derived'};
  });
 }
 const usable=row=>row.key!=null;
 // Merge one page into the history: new keys are added, known keys keep their identity; a changed rating or re-watch
 // marker is recorded as a change, an identity that disagrees with the stored one is a conflict and changes nothing.
 function mergeRows(history,rows,observedAt,page){
  const counts={added:0,unchanged:0,updated:0,conflicts:0};
  for(const row of rows.filter(usable)){
   const stored=history.entries[row.key];
   if(!stored){history.entries[row.key]={key:row.key,keyBasis:row.keyBasis,source:'letterboxd_diary',viewingId:row.viewingId,identity:row.lid?{type:'letterboxd_lid',value:row.lid}:null,
    aliases:row.slug?[{type:'letterboxd_slug',value:row.slug}]:[],watchedDate:row.watchedDate,ratingAtEntry:row.ratingAtEntry,rewatch:row.rewatch,firstObservedAt:observedAt,observedAt,page,changes:[]};counts.added++;continue;}
   if(row.lid&&stored.identity&&stored.identity.value!==row.lid||row.watchedDate&&stored.watchedDate&&stored.watchedDate!==row.watchedDate){counts.conflicts++;continue;}
   const changes=[];
   if(row.ratingAtEntry!==stored.ratingAtEntry)changes.push({field:'ratingAtEntry',from:stored.ratingAtEntry,to:row.ratingAtEntry,observedAt});
   if(row.rewatch!=='unknown'&&row.rewatch!==stored.rewatch)changes.push({field:'rewatch',from:stored.rewatch,to:row.rewatch,observedAt});
   const next={...stored,observedAt,page};
   if(!stored.identity&&row.lid)next.identity={type:'letterboxd_lid',value:row.lid};
   if(row.slug&&!stored.aliases.some(alias=>alias.value===row.slug))next.aliases=[...stored.aliases,{type:'letterboxd_slug',value:row.slug}];
   for(const change of changes)next[change.field]=change.to;
   if(changes.length){next.changes=[...stored.changes,...changes].slice(-MAX_CHANGES);counts.updated++;}else counts.unchanged++;
   history.entries[row.key]=next;
  }
  return counts;
 }
 // Per-film aggregates from confirmed entries only: viewings counted by entry, the latest watched date.
 function summarize(history){
  const films={};
  for(const entry of Object.values(history?.entries||{})){
   if(!entry.identity)continue;const id=entry.identity.value,film=films[id]||(films[id]={viewingCount:0,lastWatchedAt:null,rewatches:0});
   film.viewingCount++;if(entry.rewatch===true)film.rewatches++;if(!film.lastWatchedAt||entry.watchedDate>film.lastWatchedAt)film.lastWatchedAt=entry.watchedDate;
  }
  return films;
 }
 const emptyHistory=()=>({schemaVersion:1,entries:{}});
 const outcomeOf=status=>status===403?'blocked':status===429?'rate_limited':'failed';

 // One bounded run. Page 1 always. While a page is entirely new, the new entries may continue on the next page, so that
 // page is read too. Once a page holds a known entry, the run switches to the pending backfill, resumed one page
 // before where it stopped (overlap), and reads on from there until the page budget or the last page. Each page is
 // committed before the next request; the state is written last, so a killed run only repeats reads. Errors stop the
 // run and are reported, never thrown.
 async function syncHistory(env,{now=Date.now(),maxPages=MAX_PAGES}={}){
  const startedAt=new Date(now).toISOString(),username=sourceConfig(env).letterboxdUsername;
  const previous=await loadJSON(env,KEYS.state)||{schemaVersion:1,coverage:{newestWatchedDate:null,oldestWatchedDate:null,reachedEnd:false},resumePage:null};
  const counts={pages:0,rows:0,added:0,unchanged:0,updated:0,conflicts:0,unresolved:0,undated:0};
  const coverage={newestWatchedDate:null,oldestWatchedDate:null,reachedEnd:false,...previous.coverage};
  let page=1,mode='incremental',outcome=null,stopReason=null,moreAfter=null,firstRows=[];
  while(true){
   if(counts.pages>=maxPages){moreAfter=page;break;}
   let response;
   try{response=await fetch(pageUrl(username,page),{headers:HEADERS,redirect:'manual',signal:AbortSignal.timeout(15000)});}
   catch(e){outcome='failed';stopReason='fetch:'+String(e.message).slice(0,120);moreAfter=page;break;}
   if(response.status!==200){outcome=outcomeOf(response.status);stopReason='http_'+response.status+'_page_'+page;moreAfter=page;break;}
   const parsed=parsePage(await response.text());
   if(parsed.challenge){outcome='blocked';stopReason='challenge_page_'+page;moreAfter=page;break;}
   const rows=keyRows(parsed.rows);counts.pages++;
   if(!rows.length&&page===1&&!parsed.next){coverage.reachedEnd=true;break;}
   if(!rows.length){outcome='failed';stopReason='unrecognized_page_'+page;moreAfter=page;break;}
   if(page===1)firstRows=rows;
   counts.rows+=rows.length;counts.unresolved+=rows.filter(row=>!row.lid).length;counts.undated+=rows.filter(row=>!row.watchedDate).length;
   const observedAt=new Date(now).toISOString();let merged={added:0,unchanged:0,updated:0,conflicts:0};
   await mergeStoredJSON(env,KEYS.history,emptyHistory(),history=>{merged=mergeRows(history,rows,observedAt,page);return rows.some(usable)?history:null;});
   for(const name of ['added','unchanged','updated','conflicts'])counts[name]+=merged[name];
   for(const row of rows.filter(row=>row.watchedDate)){
    if(!coverage.newestWatchedDate||row.watchedDate>coverage.newestWatchedDate)coverage.newestWatchedDate=row.watchedDate;
    if(!coverage.oldestWatchedDate||row.watchedDate<coverage.oldestWatchedDate)coverage.oldestWatchedDate=row.watchedDate;
   }
   if(!parsed.next){coverage.reachedEnd=true;break;}
   if(page>=STOP_PAGE){outcome='partial';stopReason='page_limit';break;}
   const allNew=merged.added>0&&merged.added===rows.filter(usable).length;
   if(mode==='incremental'&&allNew){page++;continue;}
   if(mode==='incremental'&&previous.resumePage){mode='backfill';page=Math.max(page+1,previous.resumePage-1);continue;}
   if(mode==='incremental'&&!coverage.reachedEnd){mode='backfill';page++;continue;}
   if(mode==='backfill'){page++;continue;}
   break;
  }
  // Pages left unread: resume there next time, unless only an incremental pass ran and an older backfill is pending.
  const resumePage=coverage.reachedEnd&&moreAfter==null?null:moreAfter!=null&&(mode==='backfill'||page>1)?moreAfter:previous.resumePage||null;
  if(!outcome)outcome=coverage.reachedEnd&&resumePage==null?'complete':'partial';
  if(outcome==='partial'&&!stopReason)stopReason=moreAfter!=null?'page_budget':'overlap';
  const failed=['failed','blocked','rate_limited'].includes(outcome);
  const state={schemaVersion:1,lastAttemptAt:startedAt,lastSuccessAt:failed?previous.lastSuccessAt||null:startedAt,lastFailureAt:failed?startedAt:previous.lastFailureAt||null,
   lastOutcome:outcome,stopReason,counts,coverage,resumePage};
  await saveJSON(env,KEYS.state,state);
  return {...state,firstPageRows:firstRows};
 }
 // Read side: state, per-film aggregates and, for one film, its entries. Never writes or fetches.
 async function readHistory(env,{filmId=null}={}){
  const [state,history]=await Promise.all([loadJSON(env,KEYS.state),loadJSON(env,KEYS.history)]);
  const films=summarize(history),entries=Object.values(history?.entries||{});
  const body={schemaVersion:1,enabled:enabled(env),state:state||null,entries:entries.length,unresolvedEntries:entries.filter(entry=>!entry.identity).length,films:Object.keys(films).length};
  if(filmId!=null)body.film={filmId,...(films[filmId]||{viewingCount:0,lastWatchedAt:null,rewatches:0}),entries:entries.filter(entry=>entry.identity?.value===filmId).sort((a,b)=>a.watchedDate<b.watchedDate?1:a.watchedDate>b.watchedDate?-1:0)};
  return body;
 }
 return {KEYS,MAX_PAGES,enabled,pageUrl,parsePage,keyRows,mergeRows,summarize,syncHistory,readHistory};
})();
