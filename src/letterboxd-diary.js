// Letterboxd Diary viewing history (AIR-51, ADR 0049; the recent window is ADR 0067): one entry per diary row that
// carries a viewing id, otherwise one entry per film and day that counts its viewings (a lower bound unless one page
// proved it), kept apart from the current actualRating. A run reads the first diary page only, same origin, no retry
// and no challenge handling. A row is never itself the rating fact, and absence from the diary never means "not watched".
// Contract: docs/reference/integrations/letterboxd-diary-history.md.
// Concatenated into the Worker like the other server modules: one global, no exports.
const LetterboxdDiary=(()=>{
 const KEYS={history:'letterboxd/diary/history.json',state:'letterboxd/diary/state.json'};
 const MAX_CHANGES=10;
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
 // What the page just read shows about one film, by lid (ADR 0067). The rows are in Diary display order. The candidate
 // day is the film's latest watched date on that page. Its rating is the first row of that day that shows one, top to
 // bottom; a later row of the same day, an open page edge, a next link or an uncertain viewing count does not hide it
 // and is not a conflict. A day with no visible rating proves a viewing only. An older day on the page does not stand
 // in. `history` is unused: the page is the evidence, and the history merge has already stored every row. The
 // observation time is the watched date, so a newer observation from any source still wins over it. A later read of a
 // different rating on that same date is a newer diary observation by its read time, not by moving `observedAt`.
 function ratingEvidence(history,lids,page=null){
  const rows=Array.isArray(page?.rows)?page.rows:[],wanted=lids instanceof Set?lids:null,byLid=new Map();
  for(const row of rows){
   const lid=row?.lid?String(row.lid):'';
   if(!lid||!row.watchedDate||wanted&&!wanted.has(lid))continue;
   const list=byLid.get(lid)||[];list.push(row);byLid.set(lid,list);
  }
  const out=[];
  for(const [lid,list] of byLid){
   const latest=list.reduce((max,row)=>row.watchedDate>max?row.watchedDate:max,'');
   const day=list.filter(row=>row.watchedDate===latest),chosen=day.find(row=>row.ratingAtEntry!=null)||null;
   out.push({lid,watchedDate:latest,rating:chosen?chosen.ratingAtEntry:null,ratingState:chosen?'rated':'unrated',sourceRef:'diary:'+(chosen?.key||day.map(row=>row.key).filter(Boolean).join(','))});
  }
  return out.sort((a,b)=>a.lid<b.lid?-1:a.lid>b.lid?1:0);
 }
 const outcomeOf=status=>status===403?'blocked':status===429?'rate_limited':'failed';

 // The Diary cursor (`state.json`). Version 1 (no `writer`) is written as before, last writer wins. The merge form
 // (ADR 0060 decision 6, `schemaVersion: 2` with `writer`) exists only once ratings_storage_migrate has converted it:
 // its progress part is a join (newest = later, oldest = earlier, reachedEnd = either, resumePage = the larger, null
 // once reachedEnd; an absent page counts as page 2) and its diagnostic part (lastOutcome, stopReason, counts, writer)
 // is one record, last writer wins by (lastAttemptAt, writer.runId, writer.step, content). Serialization is canonical,
 // so equal states are equal bytes. `resumePage` and `reachedEnd` stay monotone and are not a fetch plan (ADR 0067):
 // a run reads page 1 only and never sets `reachedEnd`. `coverage.window: recent` is kept once either side has it.
 const emptyState=()=>({schemaVersion:1,coverage:{newestWatchedDate:null,oldestWatchedDate:null,reachedEnd:false},resumePage:null});
 const cursorMigrated=state=>state?.schemaVersion===2&&!!state.writer&&typeof state.writer==='object';
 const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
 const later=(a,b)=>a==null?b??null:b==null?a:a>b?a:b,earlier=(a,b)=>a==null?b??null:b==null?a:a<b?a:b;
 const backfillPage=value=>Number.isInteger(value)&&value>=2?value:null;
 function joinProgress(a,b){
  const ca=a?.coverage||{},cb=b?.coverage||{},reachedEnd=ca.reachedEnd===true||cb.reachedEnd===true;
  const pa=backfillPage(a?.resumePage),pb=backfillPage(b?.resumePage);
  // `window: recent` is the page-1 contract (ADR 0067). Once either side has it, the join keeps it: it is not a
  // progress value and it does not clear `reachedEnd` or `resumePage`, which stay monotone and are not a fetch plan.
  const window=ca.window==='recent'||cb.window==='recent'?'recent':null;
  return {coverage:{newestWatchedDate:later(ca.newestWatchedDate??null,cb.newestWatchedDate??null),oldestWatchedDate:earlier(ca.oldestWatchedDate??null,cb.oldestWatchedDate??null),reachedEnd,...(window?{window}:{})},resumePage:reachedEnd||pa==null&&pb==null?null:Math.max(pa??2,pb??2)};
 }
 const diagnosticOrder=state=>[String(state?.lastAttemptAt||''),String(state?.writer?.runId||''),String(state?.writer?.step||''),JSON.stringify(sorted({lastOutcome:state?.lastOutcome??null,stopReason:state?.stopReason??null,counts:state?.counts??null}))];
 function compareDiagnostics(a,b){const x=diagnosticOrder(a),y=diagnosticOrder(b);for(let i=0;i<x.length;i++){if(x[i]<y[i])return -1;if(x[i]>y[i])return 1;}return 0;}
 // Commutative, associative and idempotent over merge-form states; `incoming` without lastAttemptAt (a per-page
 // checkpoint) carries progress only and never wins the diagnostic record.
 function mergeCursor(stored,incoming){
  const winner=compareDiagnostics(incoming,stored)>0?incoming:stored;
  return sorted({schemaVersion:2,...joinProgress(stored,incoming),lastAttemptAt:later(stored?.lastAttemptAt??null,incoming?.lastAttemptAt??null),lastSuccessAt:later(stored?.lastSuccessAt??null,incoming?.lastSuccessAt??null),lastFailureAt:later(stored?.lastFailureAt??null,incoming?.lastFailureAt??null),
   lastOutcome:winner?.lastOutcome??null,stopReason:winner?.stopReason??null,counts:winner?.counts??null,writer:winner?.writer||stored?.writer||incoming?.writer||null});
 }
 // ratings_storage_migrate: the merge form of the current cursor, its progress and diagnostics unchanged.
 const migrateCursor=(state,writer)=>sorted({...emptyState(),...(state||{}),schemaVersion:2,writer});
 async function readCursor(env){const object=await env.BUCKET.get(KEYS.state);return {object,state:object?await object.json():null};}
 const putCursor=(env,object,value)=>env.BUCKET.put(KEYS.state,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
 // Every cursor write is conditional on the version read, and the rule follows the version found at the write: a
 // version 1 cursor gets this run's state as before; a merge-form cursor gets this run's state merged in, with its
 // writer, so no write of this code turns a migrated cursor back into version 1. `progressOnly` (a per-page checkpoint)
 // writes nothing on a version 1 cursor.
 async function commitCursor(env,read,state,writer,{progressOnly=false}={}){
  let {object,state:current}=read;
  for(let attempt=0;attempt<5;attempt++){
   const next=cursorMigrated(current)?mergeCursor(current,{...state,writer}):progressOnly?null:state;
   if(next==null)return current;
   if(await putCursor(env,object,next)!==null)return next;
   ({object,state:current}=await readCursor(env));
  }
  throw new Error('Diary state changed during write');
 }

 // One run reads the first diary page and no other page (ADR 0067). A stored `resumePage`, a next link, a page of
 // entirely new rows and a caller's old checkpoint never select another URL. The page is committed before its facts;
 // the state is written last, so a killed run only repeats the same page. Errors are reported, never thrown, and they
 // do not record a success. `reachedEnd` and `resumePage` are kept as stored: this run never sets the first and never
 // moves the second, and neither one plans a read.
 // AIR-263: `trace(phase, edge, fields)` receives compact phase markers; a failing trace never changes the run.
 // `writer {runId, step}` names the writer in a merge-form cursor. `beforePage()` returning false reads nothing
 // (`stopReason: step_budget`) and `next` asks the caller to try this same page again. `progressWrites` joins the
 // cursor after the page. `onPage` runs after that join; returning false ends the run (`stopReason: lease_lost`)
 // without another request.
 async function syncHistory(env,{now=Date.now(),afterPage=null,trace=null,writer=null,beforePage=null,onPage=null,progressWrites=false}={}){
  const page=1,mark=(phase,edge,fields={})=>{try{trace?.(phase,edge,fields);}catch{}};
  const startedAt=new Date(now).toISOString(),username=sourceConfig(env).letterboxdUsername;
  const stamp={runId:String(writer?.runId||'unknown'),step:String(writer?.step||'inline')};
  mark('diary_state_load','enter');
  const read=await readCursor(env);
  const previous=read.state||emptyState();
  const counts={pages:0,rows:0,unresolved:0,undated:0,overflowSuspected:false};
  const coverage={newestWatchedDate:null,oldestWatchedDate:null,reachedEnd:false,...previous.coverage,window:'recent'};
  const tally={seen:new Set(),added:new Set(),updated:new Set(),conflicts:new Set()};
  const resumePage=Number.isInteger(previous.resumePage)?previous.resumePage:null;
  mark('diary_state_load','exit',{found:previous.lastAttemptAt!=null});
  let outcome=null,stopReason=null,firstRows=[],halted=false,parsed=null;
  const fail=(kind,reason)=>{outcome=kind;stopReason=reason;};
  if(beforePage&&!await beforePage({page,mode:'recent'})){stopReason='step_budget';halted=true;}
  else{
   try{
    mark('diary_page_fetch','enter',{page});
    const response=await fetch(pageUrl(username,page),{headers:HEADERS,redirect:'manual',signal:AbortSignal.timeout(15000)});
    if(response.status!==200){mark('diary_page_fetch','exit',{page,status:response.status});fail(outcomeOf(response.status),'http_'+response.status+'_page_'+page);}
    else{
     let html;try{html=await response.text();}catch(e){mark('diary_page_fetch','error',{page,status:200});fail('failed','read:'+String(e.message).slice(0,120)+'_page_'+page);}
     if(!outcome){
      mark('diary_page_fetch','exit',{page,status:200,bytes:html.length});
      mark('diary_page_parse','enter',{page});
      parsed=parsePage(html);
      mark('diary_page_parse','exit',{page,rows:parsed.rows.length,challenge:parsed.challenge});
     }
    }
   }catch(e){fail('failed','fetch:'+String(e.message).slice(0,120));}
   if(!outcome&&parsed?.challenge)fail('blocked','challenge_page_'+page);
   // A page without rows is never an empty diary: no layout for that is known, so it fails and keeps the coverage.
   if(!outcome&&parsed&&!parsed.rows.length)fail('failed','unrecognized_page_'+page);
   if(!outcome&&parsed){
    const rows=keyRows(parsed.rows);counts.pages++;firstRows=rows;
    counts.rows+=rows.length;counts.unresolved+=rows.filter(row=>!row.lid).length;counts.undated+=rows.filter(row=>!row.watchedDate).length;
    const groups=dayGroups(rows,{page,last:!parsed.next}),pageKeys=new Set(rows.filter(usable).map(row=>row.key));
    const knownBefore=new Set();
    const observedAt=new Date(now).toISOString();
    mark('diary_history_merge','enter',{page});
    const merged=await mergeStoredJSON(env,KEYS.history,emptyHistory(),history=>{
     for(const key of pageKeys)if(history.entries[key])knownBefore.add(key);
     mergeRows(history,rows,groups,observedAt,page,tally);return pageKeys.size?history:null;
    });
    mark('diary_history_merge','exit',{page,entries:Object.keys(merged?.entries||{}).length});
    if(afterPage){mark('diary_facts_apply','enter',{page});try{await afterPage({page,rows,next:parsed.next,history:merged,readAt:startedAt});}catch(e){mark('diary_facts_apply','error',{page});fail('failed','after_page:'+String(e.message).slice(0,120)+'_page_'+page);}mark('diary_facts_apply','exit',{page});}
    if(!outcome){
     for(const row of rows.filter(row=>row.watchedDate)){
      if(!coverage.newestWatchedDate||row.watchedDate>coverage.newestWatchedDate)coverage.newestWatchedDate=row.watchedDate;
      if(!coverage.oldestWatchedDate||row.watchedDate<coverage.oldestWatchedDate)coverage.oldestWatchedDate=row.watchedDate;
     }
     // A full page of rows never stored before, with a next link, is the only overflow fact this page can show.
     counts.overflowSuspected=parsed.next===true&&rows.length>=50&&pageKeys.size>0&&knownBefore.size===0;
     if(progressWrites){mark('diary_state_checkpoint','enter',{page});await commitCursor(env,await readCursor(env),{coverage:{...coverage},resumePage},stamp,{progressOnly:true});mark('diary_state_checkpoint','exit',{page});}
     if(onPage&&!await onPage({page,next:null,pagesRead:counts.pages})){stopReason='lease_lost';halted=true;}
    }
   }
  }
  Object.assign(counts,{added:tally.added.size,updated:tally.updated.size,unchanged:[...tally.seen].filter(key=>!tally.added.has(key)&&!tally.updated.has(key)&&!tally.conflicts.has(key)).length,conflicts:tally.conflicts.size});
  if(!outcome){outcome=counts.pages?'recent_window':'partial';if(!stopReason)stopReason=counts.pages?'recent_window_only':'step_budget';}
  const succeeded=outcome==='recent_window';
  const failed=['failed','blocked','rate_limited'].includes(outcome);
  const state={schemaVersion:1,lastAttemptAt:startedAt,lastSuccessAt:succeeded?startedAt:previous.lastSuccessAt||null,lastFailureAt:failed?startedAt:previous.lastFailureAt||null,
   lastOutcome:outcome,stopReason,counts,coverage,resumePage};
  mark('diary_state_save','enter');
  const saved=await commitCursor(env,read,state,stamp);
  mark('diary_state_save','exit',{outcome});
  // `next` retries this same page when it was not read. A read page, successful or failed, has nothing further to fetch.
  return {...state,historicalCoverage:'incomplete',firstPageRows:firstRows,next:!failed&&counts.pages===0&&halted?{page:1,mode:'recent'}:null,halted,merged:cursorMigrated(saved),cursor:{coverage:saved?.coverage||coverage,resumePage:saved?.resumePage??resumePage}};
 }
 // Read side: state, per-film aggregates and, for one film, its entries. Never writes or fetches.
 async function readHistory(env,{filmId=null}={}){
  const [state,history]=await Promise.all([loadJSON(env,KEYS.state),loadJSON(env,KEYS.history)]);
  const films=summarize(history),entries=Object.values(history?.entries||{});
  const body={schemaVersion:1,enabled:enabled(env),state:state||null,entries:entries.length,unresolvedEntries:entries.filter(entry=>!entry.identity).length,films:Object.keys(films).length};
  if(filmId!=null)body.film={filmId,...(films[filmId]||{viewingCount:0,viewingCountExact:true,lastWatchedAt:null,rewatches:0,rewatchesExact:true}),entries:entries.filter(entry=>entry.identity?.value===filmId).sort((a,b)=>a.watchedDate<b.watchedDate?1:a.watchedDate>b.watchedDate?-1:0)};
  return body;
 }
 return {KEYS,enabled,pageUrl,parsePage,keyRows,mergeRows,summarize,ratingEvidence,syncHistory,readHistory,loadHistory:env=>loadJSON(env,KEYS.history),
  cursorMigrated,joinProgress,mergeCursor,migrateCursor,readCursor,putCursor,emptyState};
})();
