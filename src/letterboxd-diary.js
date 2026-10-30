// Letterboxd Diary viewing history (AIR-51, ADR 0049): one entry per diary row that carries a viewing id, otherwise
// one entry per film and day that counts its viewings (a lower bound unless one page proved it), kept apart from the
// current actualRating. Read incrementally from the owner's public diary pages, a bounded number per
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
 // The entry key. A row with a viewing id is its own entry. A row without one cannot be told apart from another viewing
 // of the same film on the same day, so it belongs to a day entry, `day:<lid:…|slug:…>|<date>`, that counts viewings.
 // Rows without an identity or a date have no key and are not stored.
 function keyRows(rows){
  return rows.map(row=>{
   if(row.viewingId)return {...row,key:'viewing:'+row.viewingId,keyBasis:'viewing_id'};
   const identity=row.lid?'lid:'+row.lid:row.slug?'slug:'+row.slug:null;
   if(!identity||!row.watchedDate)return {...row,key:null,keyBasis:null};
   return {...row,key:'day:'+identity+'|'+row.watchedDate,keyBasis:'identity_date'};
  });
 }
 const usable=row=>row.key!=null;
 // Day groups of one page. Pages are separate requests, not one snapshot: a row added between two requests repeats on
 // the next page and a removed one is skipped, so a count is never summed across pages. The count is certain only when
 // the one page holds the whole day: rows of the same date cannot continue above it (unless it is page 1) or below it
 // (unless it is the last diary page). Otherwise the group may be cut at the edge and its count is a lower bound.
 function dayGroups(rows,{page,last:lastPage}){
  const groups=new Map(),first=rows[0]?.watchedDate,last=rows.at(-1)?.watchedDate;
  for(const row of rows.filter(row=>row.keyBasis==='identity_date')){
   const group=groups.get(row.key)||{key:row.key,lid:row.lid,slug:row.slug,watchedDate:row.watchedDate,count:0,ratings:[],rewatch:[]};
   group.count++;group.ratings.push(row.ratingAtEntry);group.rewatch.push(row.rewatch);if(!group.lid&&row.lid)group.lid=row.lid;groups.set(row.key,group);
  }
  for(const group of groups.values()){
   const top=page===1||first!==group.watchedDate,bottom=lastPage||last!==group.watchedDate;
   group.certain=top&&bottom;
   group.rewatchRows=group.rewatch.filter(value=>value===true).length;group.rewatchUnknownRows=group.rewatch.filter(value=>value==='unknown').length;
   group.rewatchValue=group.rewatch.some(value=>value===true)?true:group.rewatch.every(value=>value===false)?false:'unknown';
  }
  return [...groups.values()];
 }
 const newEntry=(fields,observedAt,page)=>({source:'letterboxd_diary',firstObservedAt:observedAt,observedAt,page,changes:[],...fields});
 function withChanges(stored,changes,observedAt,page){
  const next={...stored,observedAt,page};for(const change of changes)next[change.field]=change.to;
  if(changes.length)next.changes=[...stored.changes,...changes].slice(-MAX_CHANGES);
  return next;
 }
 // Merge into the history. Viewing-id rows: one entry each; a known id keeps its identity and date (a disagreeing row is
 // a conflict and changes nothing); a changed rating or re-watch marker is a recorded change. Day groups: the viewing
 // count only grows (absence proves nothing), a certain count marks the entry certain, and a certain count below the
 // stored one, certain or not, is a conflict that changes nothing. A count grown by an uncertain read is uncertain again.
 // Ratings and the re-watch rows of a day entry follow its latest certain read; an uncertain read only raises the
 // re-watch rows, a lower bound like the count.
 function mergeRows(history,rows,groups,observedAt,page,tally){
  for(const row of rows.filter(row=>row.keyBasis==='viewing_id')){
   tally.seen.add(row.key);const stored=history.entries[row.key];
   if(!stored){history.entries[row.key]=newEntry({key:row.key,keyBasis:'viewing_id',viewingId:row.viewingId,identity:row.lid?{type:'letterboxd_lid',value:row.lid}:null,aliases:row.slug?[{type:'letterboxd_slug',value:row.slug,firstObservedAt:observedAt}]:[],
    watchedDate:row.watchedDate,viewings:1,viewingsCertain:true,ratingAtEntry:row.ratingAtEntry,ratingsAtEntry:[row.ratingAtEntry],rewatch:row.rewatch},observedAt,page);tally.added.add(row.key);continue;}
   if(row.lid&&stored.identity&&stored.identity.value!==row.lid||row.watchedDate&&stored.watchedDate&&stored.watchedDate!==row.watchedDate){tally.conflicts.add(row.key);continue;}
   const changes=[];
   if(row.ratingAtEntry!==stored.ratingAtEntry)changes.push({field:'ratingAtEntry',from:stored.ratingAtEntry,to:row.ratingAtEntry,observedAt},{field:'ratingsAtEntry',from:stored.ratingsAtEntry,to:[row.ratingAtEntry],observedAt});
   if(row.rewatch!=='unknown'&&row.rewatch!==stored.rewatch)changes.push({field:'rewatch',from:stored.rewatch,to:row.rewatch,observedAt});
   const next=withChanges(stored,changes,observedAt,page);
   if(!stored.identity&&row.lid)next.identity={type:'letterboxd_lid',value:row.lid};
   if(row.slug&&!stored.aliases.some(alias=>alias.value===row.slug))next.aliases=[...stored.aliases,{type:'letterboxd_slug',value:row.slug,firstObservedAt:observedAt}];
   if(changes.length)tally.updated.add(row.key);
   history.entries[row.key]=next;
  }
  for(const group of groups){
   tally.seen.add(group.key);const stored=history.entries[group.key];
   const fields={viewings:group.count,viewingsCertain:group.certain,ratingAtEntry:group.count===1?group.ratings[0]:null,ratingsAtEntry:group.ratings,rewatch:group.rewatchValue,rewatchRows:group.rewatchRows,rewatchUnknownRows:group.rewatchUnknownRows};
   if(!stored){history.entries[group.key]=newEntry({key:group.key,keyBasis:'identity_date',viewingId:null,identity:group.lid?{type:'letterboxd_lid',value:group.lid}:null,aliases:group.slug?[{type:'letterboxd_slug',value:group.slug,firstObservedAt:observedAt}]:[],watchedDate:group.watchedDate,...fields},observedAt,page);tally.added.add(group.key);continue;}
   if(group.certain&&group.count<stored.viewings){tally.conflicts.add(group.key);continue;}
   const changes=[];
   if(group.count>stored.viewings)changes.push({field:'viewings',from:stored.viewings,to:group.count,observedAt});
   if(group.certain&&!stored.viewingsCertain)changes.push({field:'viewingsCertain',from:false,to:true,observedAt});
   if(!group.certain&&stored.viewingsCertain&&group.count>stored.viewings)changes.push({field:'viewingsCertain',from:true,to:false,observedAt});
   if(!group.certain&&group.rewatchRows>(stored.rewatchRows||0))changes.push({field:'rewatchRows',from:stored.rewatchRows||0,to:group.rewatchRows,observedAt});
   if(group.certain){
    for(const field of ['rewatchRows','rewatchUnknownRows'])if(fields[field]!==stored[field])changes.push({field,from:stored[field],to:fields[field],observedAt});
    if(fields.ratingAtEntry!==stored.ratingAtEntry)changes.push({field:'ratingAtEntry',from:stored.ratingAtEntry,to:fields.ratingAtEntry,observedAt});
    if(JSON.stringify(fields.ratingsAtEntry)!==JSON.stringify(stored.ratingsAtEntry))changes.push({field:'ratingsAtEntry',from:stored.ratingsAtEntry,to:fields.ratingsAtEntry,observedAt});
    if(fields.rewatch!=='unknown'&&fields.rewatch!==stored.rewatch)changes.push({field:'rewatch',from:stored.rewatch,to:fields.rewatch,observedAt});
   }
   const next=withChanges(stored,changes,observedAt,page);
   if(!stored.identity&&group.lid)next.identity={type:'letterboxd_lid',value:group.lid};
   if(group.slug&&!stored.aliases.some(alias=>alias.value===group.slug))next.aliases=[...stored.aliases,{type:'letterboxd_slug',value:group.slug,firstObservedAt:observedAt}];
   if(changes.some(change=>!['viewingsCertain','rewatchRows','rewatchUnknownRows'].includes(change.field)))tally.updated.add(group.key);
   history.entries[group.key]=next;
  }
 }
 // Per-film aggregates from confirmed entries only: viewings summed over entries, the latest watched date, rows marked as
 // re-watches. A film with an uncertain day count reports `viewingCountExact: false`; with an uncertain count or a row
 // whose re-watch marker is unknown, `rewatchesExact: false`. Either number is then a lower bound.
 function summarize(history){
  const films={};
  for(const entry of Object.values(history?.entries||{})){
   if(!entry.identity)continue;const id=entry.identity.value,film=films[id]||(films[id]={viewingCount:0,viewingCountExact:true,lastWatchedAt:null,rewatches:0,rewatchesExact:true});
   const day=entry.keyBasis==='identity_date';
   film.viewingCount+=entry.viewings||1;if(entry.viewingsCertain===false)film.viewingCountExact=false;
   film.rewatches+=day?entry.rewatchRows||0:entry.rewatch===true?1:0;
   if(entry.viewingsCertain===false||(day?entry.rewatchUnknownRows!==0:entry.rewatch==='unknown'))film.rewatchesExact=false;
   if(!film.lastWatchedAt||entry.watchedDate>film.lastWatchedAt)film.lastWatchedAt=entry.watchedDate;
  }
  return films;
 }
 const emptyHistory=()=>({schemaVersion:1,entries:{}});
 // AIR-287: what the stored diary proves about one film, by lid only. Watched: any entry of the lid. Rating: the rating at
 // the film's latest watched date, and only when that date's rows are all known and agree: one viewing-id entry or day
 // entry per row, every row rated, one value, the day count proved by one page. With `page` (the page just read), the
 // latest date must also lie inside that page: the film has a row of that date on it, and the date touches no open page
 // edge (the top of a page after the first, the bottom of a page with a next one), where the same film's day may go on
 // across a page another request returns. Otherwise the date is `partial`. An unrated, ambiguous or partial latest date
 // proves no rating; an older entry never stands in for it. The observation time is the watched date (the rating held at
 // least from that day), so a newer observation from any source always wins over it.
 function ratingEvidence(history,lids,page=null){
  const open=new Set(),onPage=new Map();
  if(page){
   const dated=page.rows.filter(row=>row.watchedDate);
   if(page.page>1&&dated.length)open.add(dated[0].watchedDate);
   if(page.next&&dated.length)open.add(dated.at(-1).watchedDate);
   for(const row of dated)if(row.lid){const days=onPage.get(row.lid)||new Set();days.add(row.watchedDate);onPage.set(row.lid,days);}
  }
  const byLid=new Map();
  for(const entry of Object.values(history?.entries||{})){
   const lid=entry?.identity?.type==='letterboxd_lid'?String(entry.identity.value||''):'';
   if(!lid||!entry.watchedDate||lids&&!lids.has(lid))continue;
   const list=byLid.get(lid)||[];list.push(entry);byLid.set(lid,list);
  }
  const out=[];
  for(const [lid,entries] of byLid){
   const latest=entries.reduce((max,entry)=>entry.watchedDate>max?entry.watchedDate:max,'');
   const day=entries.filter(entry=>entry.watchedDate===latest).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
   const ratings=day.flatMap(entry=>entry.keyBasis==='viewing_id'?[entry.ratingAtEntry]:Array.isArray(entry.ratingsAtEntry)?entry.ratingsAtEntry:[null]);
   const fenced=!page||onPage.get(lid)?.has(latest)&&!open.has(latest);
   const certain=fenced&&day.every(entry=>entry.viewingsCertain!==false&&(entry.keyBasis==='viewing_id'||(entry.ratingsAtEntry||[]).length===entry.viewings));
   const values=[...new Set(ratings)];
   const state=!certain?'partial':values.length===1&&values[0]!=null?'rated':values.every(value=>value==null)?'unrated':'ambiguous';
   out.push({lid,watchedDate:latest,rating:state==='rated'?values[0]:null,ratingState:state,sourceRef:'diary:'+day.map(entry=>entry.key).join(',')});
  }
  return out.sort((a,b)=>a.lid<b.lid?-1:a.lid>b.lid?1:0);
 }
 const outcomeOf=status=>status===403?'blocked':status===429?'rate_limited':'failed';

 // One bounded run. Page 1 always. While a page is entirely new, the new entries may continue on the next page, so that
 // page is read too. Once a page holds a known entry, the run switches to the pending backfill, resumed one page
 // before where it stopped (overlap), and reads on from there until the page budget or the last page. Each page is
 // committed before the next request; the state is written last, so a killed run only repeats reads. Errors stop the
 // run and are reported, never thrown.
 async function syncHistory(env,{now=Date.now(),maxPages=MAX_PAGES,afterPage=null}={}){
  const startedAt=new Date(now).toISOString(),username=sourceConfig(env).letterboxdUsername;
  const previous=await loadJSON(env,KEYS.state)||{schemaVersion:1,coverage:{newestWatchedDate:null,oldestWatchedDate:null,reachedEnd:false},resumePage:null};
  const counts={pages:0,rows:0,unresolved:0,undated:0};
  const coverage={newestWatchedDate:null,oldestWatchedDate:null,reachedEnd:false,...previous.coverage};
  const tally={seen:new Set(),added:new Set(),updated:new Set(),conflicts:new Set()};
  let page=1,mode='incremental',outcome=null,stopReason=null,moreAfter=null,firstRows=[];
  const fail=(kind,reason)=>{outcome=kind;stopReason=reason;moreAfter=page;};
  while(true){
   if(counts.pages>=maxPages){moreAfter=page;break;}
   // Request, body and parse are one bounded step: any failure of it is a reported outcome, not an exception.
   let parsed;
   try{
    const response=await fetch(pageUrl(username,page),{headers:HEADERS,redirect:'manual',signal:AbortSignal.timeout(15000)});
    if(response.status!==200){fail(outcomeOf(response.status),'http_'+response.status+'_page_'+page);break;}
    let html;try{html=await response.text();}catch(e){fail('failed','read:'+String(e.message).slice(0,120)+'_page_'+page);break;}
    parsed=parsePage(html);
   }catch(e){fail('failed','fetch:'+String(e.message).slice(0,120));break;}
   if(parsed.challenge){fail('blocked','challenge_page_'+page);break;}
   // A page without rows is never read as an empty diary: no layout for that is known, so it is a failure that keeps
   // the coverage and the resume point.
   if(!parsed.rows.length){fail('failed','unrecognized_page_'+page);break;}
   const rows=keyRows(parsed.rows);counts.pages++;
   if(page===1)firstRows=rows;
   counts.rows+=rows.length;counts.unresolved+=rows.filter(row=>!row.lid).length;counts.undated+=rows.filter(row=>!row.watchedDate).length;
   const groups=dayGroups(rows,{page,last:!parsed.next}),pageKeys=new Set(rows.filter(usable).map(row=>row.key));
   const knownBefore=new Set([...pageKeys].filter(key=>!tally.added.has(key)&&tally.seen.has(key)));
   const observedAt=new Date(now).toISOString();
   const merged=await mergeStoredJSON(env,KEYS.history,emptyHistory(),history=>{
    for(const key of pageKeys)if(history.entries[key]&&!tally.added.has(key))knownBefore.add(key);
    mergeRows(history,rows,groups,observedAt,page,tally);return pageKeys.size?history:null;
   });
   // AIR-287: the page's consequences (rating facts) run after its history commit and before the next request. A failure
   // stops the run at this page, so the next run reads it again; the facts writer is idempotent.
   if(afterPage){try{await afterPage({page,rows,next:parsed.next,history:merged});}catch(e){fail('failed','after_page:'+String(e.message).slice(0,120)+'_page_'+page);break;}}
   for(const row of rows.filter(row=>row.watchedDate)){
    if(!coverage.newestWatchedDate||row.watchedDate>coverage.newestWatchedDate)coverage.newestWatchedDate=row.watchedDate;
    if(!coverage.oldestWatchedDate||row.watchedDate<coverage.oldestWatchedDate)coverage.oldestWatchedDate=row.watchedDate;
   }
   if(!parsed.next){coverage.reachedEnd=true;break;}
   if(page>=STOP_PAGE){outcome='partial';stopReason='page_limit';break;}
   const allNew=pageKeys.size>0&&knownBefore.size===0;
   if(mode==='incremental'&&allNew){page++;continue;}
   if(mode==='incremental'&&previous.resumePage){mode='backfill';page=Math.max(page+1,previous.resumePage-1);continue;}
   if(mode==='incremental'&&!coverage.reachedEnd){mode='backfill';page++;continue;}
   if(mode==='backfill'){page++;continue;}
   break;
  }
  Object.assign(counts,{added:tally.added.size,updated:tally.updated.size,unchanged:[...tally.seen].filter(key=>!tally.added.has(key)&&!tally.updated.has(key)&&!tally.conflicts.has(key)).length,conflicts:tally.conflicts.size});
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
  if(filmId!=null)body.film={filmId,...(films[filmId]||{viewingCount:0,viewingCountExact:true,lastWatchedAt:null,rewatches:0,rewatchesExact:true}),entries:entries.filter(entry=>entry.identity?.value===filmId).sort((a,b)=>a.watchedDate<b.watchedDate?1:a.watchedDate>b.watchedDate?-1:0)};
  return body;
 }
 return {KEYS,MAX_PAGES,enabled,pageUrl,parsePage,keyRows,mergeRows,summarize,ratingEvidence,syncHistory,readHistory,loadHistory:env=>loadJSON(env,KEYS.history)};
})();
