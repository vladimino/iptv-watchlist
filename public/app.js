'use strict';
let CUTOFF = Date.now();
let WINDOW_START=null,WINDOW_END=null;
let MAX_YEAR = Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Madrid',year:'numeric'}).format(new Date()));
let report = null;
let enrichment={profile:null,films:{}};
let ratingsLoaded=false;
const MECHANIC_LABELS={heist:'Ограбление',scam:'Афера',investigation:'Расследование',mystery:'Загадка',puzzle:'Головоломка',chase_escape:'Погоня / побег',rescue:'Спасение',escort_protection:'Защита / сопровождение',survival:'Выживание',siege:'Осада',ticking_clock:'Гонка со временем',expedition_discovery:'Экспедиция / исследование',plan_counterplan:'План / контрплан',multi_party_conflict:'Несколько сторон'};
const normalizeMood=value=>typeof value==='string'?value.normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/g,' ').trim():'';
const MOOD_LABELS={tense:'Напряжённый',dark:'Мрачный',light:'Лёгкий',adventurous:'Приключенческий',dynamic:'Динамичный',epic:'Масштабный',violent:'Жёсткий',funny:'Комедийный',black_humor:'Чёрный юмор',satirical:'Сатирический',absurd:'Абсурдный',romantic:'Романтический',warm:'Тёплый',touching:'Трогательный',inspiring:'Вдохновляющий',melancholic:'Меланхоличный',tragic:'Трагический',contemplative:'Созерцательный',surreal:'Сюрреалистический',eerie:'Мистический / пугающий',paranoid:'Параноидальный',noir:'Нуарный',military:'Военная тема',historical:'Историческая тема',family:'Семья и отношения',friendship:'Дружба и команда',political:'Политика и общество',revenge:'Месть и возмездие'};
const MOOD_GROUPS={tone:['tense','dark','light','adventurous','dynamic','epic','funny','black_humor','satirical','romantic','warm','touching','inspiring','melancholic','tragic','contemplative','paranoid','eerie'],theme:['military','historical','political','family','friendship','revenge'],style:['noir','surreal','absurd'],property:['violent']};
const MOOD_GROUP_ORDER=['tone','theme','style','property'];
const MOOD_GROUP_LABELS={tone:'Настроение',theme:'Темы',style:'Стиль',property:'Особенности'};
const GENERIC_THEME_IDS=new Set(['family','military','political','historical','revenge']);
const moodLabel=id=>MOOD_LABELS[id]||id;
function moodBucket(id){for(const bucket of MOOD_GROUP_ORDER)if(MOOD_GROUPS[bucket].includes(id))return bucket;return '';}
const EXECUTION_FILTERS=[
 {id:'plot_engine',label:'Сюжетный двигатель',values:[['weak','слабый'],['medium','средний'],['strong','сильный']]},
 {id:'pace',label:'Темп',values:[['slow','медленный'],['medium','средний'],['fast','быстрый'],['variable','переменный']]},
 {id:'stakes',label:'Ставки',values:[['low','низкие'],['medium','средние'],['high','высокие']]},
 {id:'decision_logic',label:'Логика решений',values:[['weak','слабая'],['mixed','смешанная'],['strong','сильная']]},
 {id:'protagonist_competence',label:'Компетентность героя',values:[['low','низкая'],['mixed','смешанная'],['high','высокая']]},
 {id:'opposition_competence',label:'Компетентность противника',values:[['low','низкая'],['mixed','смешанная'],['high','высокая']]},
 {id:'problem_solving',label:'Решение задач',values:[['weak','слабое'],['medium','среднее'],['strong','сильное']]},
 {id:'plan_counterplan_strength',label:'План и контрплан',values:[['none','нет'],['weak','слабый'],['medium','средний'],['strong','сильный']]},
 {id:'multi_party_goals',label:'Цели сторон',values:[['none','нет'],['weak','слабые'],['medium','средние'],['strong','сильные']]},
 {id:'chemistry',label:'Химия',values:[['weak','слабая'],['medium','средняя'],['strong','сильная']]},
 {id:'payoff',label:'Отдача',values:[['weak','слабая'],['mixed','смешанная'],['strong','сильная']]},
 {id:'ending_quality',label:'Финал',values:[['weak','слабый'],['mixed','смешанный'],['strong','сильный']]},
 {id:'technical_plausibility',label:'Правдоподобие',values:[['weak','слабое'],['mixed','смешанное'],['strong','сильное']]},
];
const EXECUTION_VALUES=Object.fromEntries(EXECUTION_FILTERS.map(dimension=>[dimension.id,Object.fromEntries(dimension.values)]));
const EXECUTION_RANK={plot_engine:['weak','medium','strong'],decision_logic:['weak','mixed','strong'],protagonist_competence:['low','mixed','high'],problem_solving:['weak','medium','strong'],chemistry:['weak','medium','strong'],payoff:['weak','mixed','strong'],ending_quality:['weak','mixed','strong'],technical_plausibility:['weak','mixed','strong']};
function emptyExecution(){return Object.fromEntries(EXECUTION_FILTERS.map(dimension=>[dimension.id,new Set()]));}
function executionActive(){return EXECUTION_FILTERS.some(dimension=>state.execution[dimension.id]?.size);}
function executionSummary(){const parts=[];for(const dimension of EXECUTION_FILTERS){const selected=state.execution[dimension.id];if(!selected?.size)continue;const labels=dimension.values.filter(([value])=>selected.has(value)).map(([,label])=>label);if(labels.length)parts.push(`${dimension.label}: ${labels.join(', ')}`);}return parts.length?` · Исполнение: ${parts.join('; ')}`:'';}
function facetSummary(labels){if(!labels.length)return 'Любой';if(labels.length===1)return labels[0];return `${labels[0]} +${labels.length-1}`;}
function moodIdsFromUrl(value){const key=normalizeMood(value).replace(/ё/g,"е").replace(/[^\p{L}\p{N}]+/gu," ").trim();if(Object.hasOwn(MOOD_LABELS,value))return [value];const direct=Object.entries(MOOD_LABELS).filter(([,label])=>normalizeMood(label).replace(/ё/g,"е").replace(/[^\p{L}\p{N}]+/gu," ").trim()===key).map(([id])=>id);return direct.length?direct:enrichment.moodVocabulary?.aliases?.[key]||[];}
let mechanics=[],moods=[];
function defaultSearchScopes(){return {titles:true,people:false,plot:false};}
const SEARCH_SCOPE_IDS=['titles','people','plot'];
const state = { shortlistMode:'now', period: 'all', sort: 'personal', sortExplicit:false, viewing: 'any', minPrediction: null, minProbability: null, startedOnly: false, lastChanceOnly: false, includeUnscheduled: false, directors: '', actors: '', query: '', searchScopes:defaultSearchScopes(), genres: new Set(), mechanics:new Set(), moods:new Set(), channels:new Set(), execution:emptyExecution(), from: 1900, to: MAX_YEAR, maxRuntime: null };
const APP_QUERY_KEYS = ['shortlist','view','period','q','searchIn','sort','genre','mechanic','mood','channel','execution','from','to','runtime','viewing','started','lastChance','director','actor','prediction','chance'];
let urlReady=false,urlRestoring=false,viewClock=null,programmeRefreshError=false;
function nowMs(){return viewClock??Date.now();}
function finiteTime(value){const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)?n:null;}
function effectiveWindow(snapshot,now){
 const clock=finiteTime(now);
 if(clock===null)return {basis:'unavailable',now:null,envelope:null,archive:null,future:null,black:true,epgEnd:null};
 const from=finiteTime(snapshot?.window?.from),to=finiteTime(snapshot?.window?.to);
 let envelope=null,basis='snapshot';
 if(from!==null&&to!==null&&from<to)envelope={from,to};
 else{const cutoff=finiteTime(snapshot?.cutoff)??finiteTime(snapshot?.updatedAt);if(cutoff===null)return {basis:'unavailable',now:clock,envelope:null,archive:null,future:null,black:true,epgEnd:finiteTime(snapshot?.stats?.epgEnd)};envelope={from:cutoff-72*3600000,to:cutoff+24*3600000};basis='estimate';}
 // The retained window (up to 168 h ahead) is storage and coverage metadata. What the reader sees stays the rolling [now - 72 h, now + 24 h]:
 // a show further ahead is kept but hidden until the clock reaches 24 h before it, with or without a fresh EPG sync.
 const retained=envelope;envelope={from:retained.from,to:Math.min(retained.to,clock+24*3600000)};
 const archiveFrom=Math.max(envelope.from,clock-72*3600000),archiveTo=Math.min(envelope.to,clock);
 const archive=archiveFrom<archiveTo?{from:archiveFrom,to:archiveTo,fromExclusive:archiveFrom===clock-72*3600000}:null;
 const futureFrom=Math.max(envelope.from,clock);
 const future=futureFrom<envelope.to?{from:futureFrom,to:envelope.to}:null;
 return {basis,now:clock,envelope,retained,archive,future,black:!archive&&!future,epgEnd:finiteTime(snapshot?.stats?.epgEnd)};
}
function viewingClock(){if(viewClock!=null)return viewClock;if(!report&&WINDOW_START!=null&&Number.isFinite(CUTOFF))return CUTOFF;return Date.now();}
function snapshotForClock(now){if(report)return report;if(WINDOW_START!=null&&WINDOW_END!=null)return {window:{from:WINDOW_START,to:WINDOW_END},cutoff:CUTOFF};return {updatedAt:now};}
function viewingWindow(now=viewingClock()){return effectiveWindow(snapshotForClock(now),now);}
function showStart(show){const start=finiteTime(show?.start);if(start!==null)return start;return Number.isFinite(CUTOFF)&&Number.isFinite(Number(show?.offset))?CUTOFF+Number(show.offset)*3600000:null;}
function inEnvelope(model,start){return !!model?.envelope&&start!==null&&start>=model.envelope.from&&start<model.envelope.to;}
function onAir(model,show){const start=showStart(show),end=finiteTime(show?.end);return inEnvelope(model,start)&&start<=model.now&&end!==null&&end>model.now;}
function inArchive(model,show){const start=showStart(show);if(!model?.now||!inEnvelope(model,start)||start>model.now)return false;if(onAir(model,show))return true;return start>model.now-72*3600000&&start+72*3600000>model.now;}
function inFuture(model,show){const start=showStart(show);return !!model?.now&&inEnvelope(model,start)&&start>model.now;}
function blackZone(){const model=viewingWindow();return !!model?.envelope&&model.black;}
function inSelectedScope(film,period=state.period){if(periodShows(film,period).length>0)return true;if(periodShows(film,'all').length>0)return false;if(blackZone()&&!state.lastChanceOnly)return true;return !!state.includeUnscheduled;}
function countedScope(film,period){if(blackZone()&&period!=='all')return periodShows(film,period).length>0;return inSelectedScope(film,period);}
function parseSearchScopes(value){
 if(value==null||!String(value).trim())return defaultSearchScopes();
 const tokens=new Set(String(value).split(',').map(item=>item.trim()).filter(id=>SEARCH_SCOPE_IDS.includes(id)));
 if(!tokens.size)return defaultSearchScopes();
 return {titles:tokens.has('titles'),people:tokens.has('people'),plot:tokens.has('plot')};
}
function activeSearchScopes(scopes){
 const source=scopes&&typeof scopes==='object'?scopes:defaultSearchScopes();
 const next={titles:!!source.titles,people:!!source.people,plot:!!source.plot};
 return SEARCH_SCOPE_IDS.some(id=>next[id])?next:defaultSearchScopes();
}
function searchScopeParam(scopes=activeSearchScopes(state.searchScopes)){
 const ids=SEARCH_SCOPE_IDS.filter(id=>scopes[id]);
 return ids.length===1&&ids[0]==='titles'?'':ids.join(',');
}
function setSearchScope(id,enabled){
 if(!SEARCH_SCOPE_IDS.includes(id))return false;
 const next={...activeSearchScopes(state.searchScopes),[id]:!!enabled};
 if(!SEARCH_SCOPE_IDS.some(key=>next[key]))return false;
 state.searchScopes=next;
 return true;
}
function syncSearchControls(){
 const input=$('#search');
 if(input&&input.value!==state.query){
  const start=input.selectionStart,end=input.selectionEnd,focused=document.activeElement===input;
  input.value=state.query;
  if(focused&&start!=null&&typeof input.setSelectionRange==='function')input.setSelectionRange(Math.min(start,input.value.length),Math.min(end??start,input.value.length));
 }
 const scopes=activeSearchScopes(state.searchScopes),enabled=SEARCH_SCOPE_IDS.filter(id=>scopes[id]);
 document.querySelectorAll('[data-search-scope]').forEach(button=>{
  const on=!!scopes[button.dataset.searchScope];
  button.setAttribute('aria-pressed',String(on));
  if(on&&enabled.length===1)button.setAttribute('aria-disabled','true');
  else button.removeAttribute('aria-disabled');
 });
}
function readUrlState(url){
 const p=url.searchParams,defaults={shortlistMode:'now',period:'all',sort:'personal',sortExplicit:false,viewing:'any',minPrediction:null,minProbability:null,startedOnly:false,lastChanceOnly:false,includeUnscheduled:false,directors:'',actors:'',query:'',searchScopes:parseSearchScopes(p.get('searchIn')),genres:new Set(),mechanics:new Set(),moods:new Set(),channels:new Set(),execution:emptyExecution(),from:1900,to:MAX_YEAR,maxRuntime:null};
 if(p.get('shortlist')==='today')defaults.shortlistMode='today';
 if(p.get('view')==='watchlist')defaults.includeUnscheduled=true;
 if(['all','archive','future'].includes(p.get('period')))defaults.period=p.get('period');
 if(p.get('sort')==='relevance'&&normalizeSearch(p.get('q')||''))defaults.sort='relevance';
 // AIR-382: «Для меня» is the default. The retired `time` sort (an old link) and any unknown value fall back to it, or to relevance while a search is typed.
 else if(['title','personal','expiring'].includes(p.get('sort'))){defaults.sort=p.get('sort');defaults.sortExplicit=true;}
 else if(normalizeSearch(p.get('q')||''))defaults.sort='relevance';
 if(['any','new','rewatch'].includes(p.get('viewing')))defaults.viewing=p.get('viewing');
 defaults.query=p.get('q')||'';
 defaults.genres=new Set(p.getAll('genre').map(genre=>genre.trim()).filter(Boolean));
 defaults.mechanics=new Set(p.getAll('mechanic').filter(m=>Object.hasOwn(MECHANIC_LABELS,m)));
 defaults.moods=new Set(p.getAll('mood').flatMap(moodIdsFromUrl).filter(m=>Object.hasOwn(MOOD_LABELS,m)));
 defaults.channels=new Set(p.getAll('channel').map(channel=>channel.trim()).filter(Boolean));
 for(const item of p.getAll('execution')){const separator=item.indexOf(':');if(separator<1)continue;const dimension=item.slice(0,separator),value=item.slice(separator+1);if(!Object.hasOwn(EXECUTION_VALUES,dimension)||!Object.hasOwn(EXECUTION_VALUES[dimension],value))continue;defaults.execution[dimension].add(value);}
 const year=key=>/^\d{4}$/.test(p.get(key)||'')?Number(p.get(key)):null;
 const from=year('from'),to=year('to');
 if(from!==null&&from>=1900&&from<=MAX_YEAR)defaults.from=from;
 if(to!==null&&to>=1900&&to<=MAX_YEAR)defaults.to=to;
 if(defaults.from>defaults.to){defaults.from=1900;defaults.to=MAX_YEAR;}
 const runtime=p.get('runtime');if(/^[1-9]\d*$/.test(runtime||'')&&Number.isSafeInteger(Number(runtime)))defaults.maxRuntime=Number(runtime);
 if(p.get('started')==='1')defaults.startedOnly=true;
 if(p.get('lastChance')==='1')defaults.lastChanceOnly=true;
 for(const [key,param] of [['directors','director'],['actors','actor']]){const id=p.get(param);if(id&&id.length<=200&&!/[\s#&?]/.test(id))defaults[key]=id;}
 const prediction=Number(p.get('prediction')),chance=Number(p.get('chance'));
 if([3.5,4,4.5].includes(prediction))defaults.minPrediction=prediction;
 if([0.5,0.7,0.85].includes(chance))defaults.minProbability=chance;
 return defaults;
}
function urlForState(current){
 const url=new URL(current);for(const key of APP_QUERY_KEYS)url.searchParams.delete(key);
 const add=(key,value)=>url.searchParams.append(key,String(value));
 if(state.shortlistMode==='today')add('shortlist','today');
 if(state.includeUnscheduled)add('view','watchlist');
 if(state.period!=='all')add('period',state.period);
 if(state.query)add('q',state.query);
 const searchIn=searchScopeParam();if(searchIn)add('searchIn',searchIn);
 if(state.sort!=='personal')add('sort',state.sort);
 else if(state.sortExplicit)add('sort','personal');
 for(const genre of [...state.genres].sort((a,b)=>a.localeCompare(b,'ru')))add('genre',genre);
 for(const mechanic of [...state.mechanics].sort())add('mechanic',mechanic);
 for(const mood of [...state.moods].sort((a,b)=>a.localeCompare(b,'ru')))add('mood',mood);
 for(const channel of [...state.channels].sort((a,b)=>a.localeCompare(b,'ru')))add('channel',channel);
 for(const dimension of EXECUTION_FILTERS){const selected=state.execution[dimension.id];if(!selected)continue;for(const [value] of dimension.values)if(selected.has(value))add('execution',`${dimension.id}:${value}`);}
 if(state.from!==1900)add('from',state.from);
 if(state.to!==MAX_YEAR)add('to',state.to);
 if(state.maxRuntime!==null)add('runtime',state.maxRuntime);
 if(state.viewing!=='any')add('viewing',state.viewing);
 if(state.startedOnly)add('started',1);
 if(state.lastChanceOnly)add('lastChance',1);
 if(state.directors)add('director',state.directors);
 if(state.actors)add('actor',state.actors);
 if(state.minPrediction!==null)add('prediction',state.minPrediction);
 if(state.minProbability!==null)add('chance',state.minProbability);
 return url;
}
function filterStateKey(snapshot=state){
 const execution={};
 for(const dimension of EXECUTION_FILTERS)execution[dimension.id]=[...(snapshot.execution?.[dimension.id]||[])].sort();
 const scopes=activeSearchScopes(snapshot.searchScopes);
 return JSON.stringify({shortlistMode:snapshot.shortlistMode,period:snapshot.period,sort:snapshot.sort,viewing:snapshot.viewing,minPrediction:snapshot.minPrediction,minProbability:snapshot.minProbability,startedOnly:!!snapshot.startedOnly,lastChanceOnly:!!snapshot.lastChanceOnly,includeUnscheduled:!!snapshot.includeUnscheduled,directors:snapshot.directors||'',actors:snapshot.actors||'',query:snapshot.query||'',searchScopes:{titles:scopes.titles,people:scopes.people,plot:scopes.plot},genres:[...(snapshot.genres||[])].sort(),mechanics:[...(snapshot.mechanics||[])].sort(),moods:[...(snapshot.moods||[])].sort(),channels:[...(snapshot.channels||[])].sort(),execution,from:snapshot.from,to:snapshot.to,maxRuntime:snapshot.maxRuntime});
}
function eventsRequested(href=window.location.href){const url=new URL(href);if(url.searchParams.get('screen')==='events')return true;const path=url.pathname.replace(/\/+$/,'')||'/';return path==='/events';}
const FILM_ID=/^[A-Za-z0-9_-]{1,80}$/;
const FILM_CONTROL='a,button,summary,input,select,label,textarea';
function filmIdFromLocation(href=window.location.href){const path=new URL(href,'https://iptv.local').pathname.replace(/\/+$/,'')||'/';const match=path.match(/^\/film\/([^/]+)$/);if(!match)return null;let id;try{id=decodeURIComponent(match[1]);}catch{return null;}return FILM_ID.test(id)?id:null;}
function filmSearchFrom(href){const url=new URL(href);url.searchParams.delete('screen');return url.search;}
// AIR-380: the way back to the programme is the home target carried in the URL of the screen (`return`, see return-home.js), never remembered in
// storage: a bookmark or a deep link goes to the canonical home, and a reload keeps the target.
function currentPathname(){return new URL(window.location.href).pathname.replace(/\/+$/,'')||'/';}
function onHomeScreen(){return currentPathname()==='/'&&!eventsRequested()&&!filmIdFromLocation();}
function homeTarget(){const here=new URL(window.location.href);return onHomeScreen()?ReturnHome.ofHomeLocation(here):ReturnHome.fromSearch(here.search);}
function refreshReturnLinks(){ReturnHome.decorate(document,homeTarget());}
function syncReturnLink(){const link=$('#return-home');if(link)link.hidden=!(filmScreen||eventsScreen);refreshReturnLinks();}
let eventsScreen=false,filmScreen=null,filmReturnId=null,filmFiltersAtOpen=null,filmCompareId=null,filmCompareFilm=null,filmCompareById=new Map(),filmScrollById=new Map(),movieScrollY=0,eventsTrigger=null;
// The feed is a single node: in the sidebar (compact) on the programme and film pages, in the main column on the events screen.
function placeActivity(){
 const activity=document.querySelector('.activity'),host=eventsScreen?$('#events-screen'):$('#filters');
 if(activity&&host&&typeof host.appendChild==='function'&&activity.parentNode!==host)host.appendChild(activity);
}
function syncEventTypeButtons(){
 for(const button of document.querySelectorAll('#events-types [data-event-type]'))button.setAttribute('aria-pressed',String(button.dataset.eventType===eventTypeFilterId));
}
function syncEventTypeFromUrl(){eventTypeFilterId=eventTypeFrom(new URL(window.location.href).search);syncEventTypeButtons();startEventSearch();}
function selectEventType(id){
 if(!EVENT_TYPE_FILTERS.some(item=>item.id===id))return;
 eventTypeFilterId=id;syncEventTypeButtons();
 // The choice lives in the URL of this history entry (no new entry), next to the return target.
 if(eventsRequested()&&currentPathname()==='/events'){const here=new URL(window.location.href);window.history.replaceState(window.history.state,'',withEventType(here.pathname+here.search+here.hash,id));}
 startEventSearch();
}
function applyEventsScreen(on){
 if(on&&!eventsScreen)movieScrollY=window.scrollY||0;
 eventsScreen=!!on;
 document.documentElement?.classList?.toggle('events-screen',eventsScreen);
 const expand=$('#activity-expand');
 if(expand)expand.hidden=eventsScreen;
 const types=$('#events-types'),main=$('#events-screen');
 if(types)types.hidden=!eventsScreen;
 if(main)main.hidden=!eventsScreen;
 placeActivity();
 if(eventsScreen)syncEventTypeFromUrl();else{cancelEventSearch();renderActivity();}
 syncReturnLink();
 if(typeof window.scrollTo==='function')window.scrollTo(0,eventsScreen?0:movieScrollY||0);
}
function openEventsScreen(trigger){
 eventsTrigger=trigger||$('#activity-expand');
 // The film screen hides the workspace with !important, so events opened over it would stay invisible. Leave it first.
 if(filmScreen)applyFilmScreen(null);
 if(!eventsRequested()){const fromHome=onHomeScreen(),target=homeTarget();window.history.pushState({iptvEvents:true,iptvHome:fromHome?target:null},'',ReturnHome.withReturn('/events',target));}
 else if(new URL(window.location.href).searchParams.get('screen')==='events'){window.history.replaceState(window.history.state,'',ReturnHome.withReturn('/events','/'+filmSearchFrom(window.location.href)));}
 applyEventsScreen(true);
 $('#activity-title')?.focus?.({preventScroll:true});
}
function filmHref(id){return '/film/'+encodeURIComponent(String(id));}
// AIR-387. One permanent URL per film: `/film/tmdb_<n>` for a TMDB movie, with the Letterboxd id kept as an alias that opens the same page.
// A watchlist film gets the TMDB permalink only when its record proves a movie: `tmdbLink` resolved to a /movie/ page of the same number as `tmdbId`
// (a TV page, an unresolved, contradictory or missing link, and a number held by two loaded films all keep the Letterboxd id, which always works).
// Nothing is guessed from a title or a year, nothing is stored, and no identity, rating or prediction key changes.
const FILM_TMDB_ROUTE=/^tmdb_([1-9]\d{0,11})$/,TMDB_ROUTE_ID=/^[1-9]\d{0,11}$/;
function routeTmdb(id){const match=FILM_TMDB_ROUTE.exec(String(id??''));return match?match[1]:null;}
function trustedMovieTmdb(film){
 const id=film?.tmdbId==null?'':String(film.tmdbId),link=film?.tmdbLink;
 if(!TMDB_ROUTE_ID.test(id)||link?.status!=='resolved'||link.link?.type!=='movie'||String(link.link.id)!==id)return null;
 return id;
}
function programmeTmdbOwners(){
 const owners=new Map();
 for(const film of films||[]){const tmdb=trustedMovieTmdb(film);if(!tmdb)continue;if(!owners.has(tmdb))owners.set(tmdb,new Set());owners.get(tmdb).add(String(film.id));}
 return owners;
}
function filmPermalinkId(film){
 const id=String(film?.id??'');
 if(!id||routeTmdb(id))return id;
 const tmdb=trustedMovieTmdb(film);
 return tmdb&&programmeTmdbOwners().get(tmdb)?.size===1?'tmdb_'+tmdb:id;
}
function filmPath(film){return filmHref(filmPermalinkId(film));}
// The permanent catalog read for a TMDB route that no loaded source holds. A found film is cached for the session; absent, retired and
// conflict are cached too, a transient failure is not (the next render asks again). A cached film on another generation than the loaded
// programme is refreshed in the background while the old one stays on screen, so the page never blinks "not found" and never mixes two runs.
const catalogFilmReads=new Map(),catalogPageCache=new WeakMap();
function catalogPageFilm(entry){
 let page=catalogPageCache.get(entry);
 if(!page){page={...entry,catalogOnly:true,catalogRoute:true,genres:Array.isArray(entry.genres)?entry.genres:[],directors:entry.directors||[],actors:entry.actors||[],shows:Array.isArray(entry.shows)?entry.shows:[]};catalogPageCache.set(entry,page);}
 return page;
}
async function ensureCatalogFilm(tmdb,{refresh=false}={}){
 const known=catalogFilmReads.get(tmdb);
 if(known?.state==='loading'||known&&!refresh&&known.state!=='unavailable'&&known.state!=='error')return;
 const token=Symbol('catalog-film'),askedRun=report?.runId??null;
 catalogFilmReads.set(tmdb,{...(known?.state==='found'?known:{}),state:known?.state==='found'?'found':'loading',token,refreshing:true,askedRun});
 let next;
 try{
  const response=await fetch('/api/catalog/film/'+encodeURIComponent(tmdb),{headers:{Accept:'application/json'}});
  let body=null;try{body=await response.json();}catch{}
  const status=typeof body?.status==='string'?body.status:'';
  if(response.ok&&status==='found'&&body.film&&String(body.film.tmdbId)===tmdb&&body.film.canonicalIdentity==='tmdb:'+tmdb)next={state:'found',film:body.film,programmeRunId:body.programmeRunId||null};
  else if(response.status===404&&status==='absent')next={state:'absent'};
  else if(response.status===410&&status==='retired')next={state:'retired'};
  else if(response.status===409&&status==='conflict')next={state:'conflict'};
  else if(response.status===503||status==='unavailable')next={state:'unavailable'};
  else next={state:'error'};
 }catch{next={state:'error'};}
 if(catalogFilmReads.get(tmdb)?.token!==token)return;
 // A failed refresh keeps the film already shown.
 const previous=known?.state==='found'?known:null;
 if(next.state==='unavailable'||next.state==='error'){
  if(previous)catalogFilmReads.set(tmdb,{...previous,refreshing:false,token:null,askedRun});
  else catalogFilmReads.set(tmdb,{state:next.state,token:null,transient:true,at:Date.now()});
 }else catalogFilmReads.set(tmdb,{...next,token:null,askedRun});
 if(filmScreen&&routeTmdb(filmScreen)===tmdb)renderFilmShell();
}
// What a film route shows: a loaded programme film (by its own id, or by its TMDB permalink when the record proves it), a catalog film the Finds
// already hold, or the permanent catalog read. `status` is never "missing" while a source is still loading.
function resolveFilm(routeId){
 const id=String(routeId??'');
 const own=(films||[]).find(item=>String(item.id)===id);
 if(own)return {film:own,source:'programme',status:'ready'};
 const tmdb=routeTmdb(id);
 const settled=programmeReady||programmeRefreshError||(films||[]).length>0;
 if(!tmdb)return {film:null,source:null,status:settled?'missing':'loading'};
 const owners=programmeTmdbOwners().get(tmdb);
 if(owners?.size>1)return {film:null,source:null,status:'conflict'};
 if(owners?.size===1){const film=films.find(item=>String(item.id)===[...owners][0]);if(film)return {film,source:'programme',status:'ready',alias:true};}
 const held=(findsSource.films||[]).find(item=>String(item.tmdbId)===tmdb&&item.canonicalIdentity==='tmdb:'+tmdb);
 if(held&&findsFresh())return {film:catalogPageFilm(held),source:'catalog',status:'ready'};
 const cached=catalogFilmReads.get(tmdb);
 if(cached?.state==='found'){
  const run=report?.runId??null;
  // Asked once per loaded generation: an answer pinned to another run than the loaded programme is not asked for again until the programme moves.
  if(run&&cached.programmeRunId&&cached.programmeRunId!==run&&cached.askedRun!==run&&!cached.refreshing&&settled)ensureCatalogFilm(tmdb,{refresh:true});
  return {film:catalogPageFilm(cached.film),source:'catalog',status:'ready'};
 }
 if(cached?.transient){if(settled&&Date.now()-cached.at>15000)ensureCatalogFilm(tmdb);return {film:null,source:null,status:cached.state};}
 if(cached&&cached.state!=='loading')return {film:null,source:null,status:cached.state};
 if(!settled)return {film:null,source:null,status:'loading'};
 ensureCatalogFilm(tmdb);
 return {film:null,source:null,status:'loading'};
}
function currentFilm(){return filmScreen?resolveFilm(filmScreen).film:null;}
// A film opened by its Letterboxd id whose record proves a TMDB movie is moved to the permalink in place: same entry, same `return`, no new history.
function canonicalizeFilmUrl(film){
 if(!film||film.catalogRoute||!filmScreen)return;
 const permalink=filmPermalinkId(film);
 if(permalink===String(filmScreen)||!routeTmdb(permalink)||filmIdFromLocation()!==String(filmScreen))return;
 try{window.history.replaceState(window.history.state,'',ReturnHome.keep(filmHref(permalink),new URL(window.location.href).search));filmScreen=permalink;}catch{}
}
function filmOpener(id){
 if(!id||typeof document.querySelector!=='function')return null;
 return document.querySelector(`a.film-open[data-film-id="${String(id).replace(/"/g,'')}"]`);
}
function focusFilmReturn(id){
 const opener=filmOpener(id||filmReturnId);
 if(opener?.focus){opener.focus({preventScroll:true});return;}
 $('#search')?.focus?.({preventScroll:true});
}
function filmFiltersChanged(){return filmFiltersAtOpen!=null&&filmFiltersAtOpen!==filterStateKey(state);}
function showHome(target){
 // A real navigation to the target: Back returns to the screen that was left.
 const next=ReturnHome.parseTarget(target)||ReturnHome.HOME;
 const leavingFilm=!!filmScreen,returnId=filmReturnId,filtersChanged=filmFiltersChanged();
 window.history.pushState({iptvHome:true},'',next);
 applyEventsScreen(false);
 if(filmScreen)applyFilmScreen(null);
 const incoming=readUrlState(new URL(window.location.href));
 const sameList=filterStateKey(incoming)===filterStateKey(state);
 if(leavingFilm&&filtersChanged)render();
 else if(!sameList)restoreUrl();
 if(leavingFilm)focusFilmReturn(returnId);
 else if(sameList)(eventsTrigger||$('#activity-expand'))?.focus?.({preventScroll:true});
}
const FILM_STATUS_TEXT={
 loading:['Фильм','Загружаем фильм…'],
 missing:['Фильм не найден','В загруженной программе нет фильма с этим идентификатором.'],
 absent:['Фильм не найден','В каталоге нет проверенного фильма с этим идентификатором TMDB.'],
 retired:['Запись каталога снята','Эта запись каталога заменена и больше не действует.'],
 conflict:['Идентичность фильма не подтверждена','Для этого идентификатора в данных есть конфликт, поэтому фильм не показан.'],
 unavailable:['Каталог сейчас недоступен','Не удалось прочитать каталог. Обнови страницу чуть позже.'],
 error:['Не удалось загрузить фильм','Каталог ответил ошибкой. Обнови страницу чуть позже.']
};
function renderFilmShell(){
 const id=filmScreen,screen=$('#film-screen');
 const resolved=id?resolveFilm(id):{film:null,source:null,status:'missing'},film=resolved.film;
 if(film&&resolved.source==='programme')canonicalizeFilmUrl(film);
 if(screen)screen.dataset.filmId=filmScreen||'';
 const title=$('#film-screen-title'),identity=$('#film-screen-identity'),status=$('#film-screen-status');
 const text=FILM_STATUS_TEXT[resolved.status]||FILM_STATUS_TEXT.missing;
 if(title)title.textContent=film?film.title:id?text[0]:'Фильм не найден';
 if(identity)identity.textContent=filmScreen||'';
 if(status)status.textContent=film?(film.catalogOnly?'Только в каталоге':''):id?text[1]:'';
 fillFilmPage(film);
 armSoonTick();
}
function applyFilmScreen(id){
 const next=id||null;
 const previous=filmScreen;
 if(previous&&String(previous)!==String(next||'')){if(filmCompareId)filmCompareById.set(String(previous),String(filmCompareId));else filmCompareById.delete(String(previous));}
 if(next&&String(next)!==String(filmCompareFilm||'')){filmCompareFilm=next;filmCompareId=filmCompareById.get(String(next))||null;const input=$('#film-compare-input'),chosen=filmCompareId?films.find(item=>String(item.id)===String(filmCompareId)):null;if(input)input.value=chosen?filmCompareLabel(chosen):'';}
 if(next&&!filmScreen){movieScrollY=window.scrollY||0;filmFiltersAtOpen=filterStateKey(state);}
 if(!next)filmFiltersAtOpen=null;
 filmScreen=next;
 document.documentElement?.classList?.toggle('film-screen',!!filmScreen);
 const screen=$('#film-screen');
 if(screen)screen.hidden=!filmScreen;
 if(filmScreen)renderFilmShell();
 const remembered=next&&filmScrollById.has(String(next))?filmScrollById.get(String(next)):0;
 if(next)filmScrollById.delete(String(next));
 if(typeof window.scrollTo==='function')window.scrollTo(0,filmScreen?remembered:movieScrollY||0);
 syncReturnLink();
 if(filmScreen)$('#film-screen-title')?.focus?.({preventScroll:true});
}
function openComparedFilm(id){
 const filmId=filmIdFromLocation('https://iptv.local/film/'+encodeURIComponent(String(id??'')));
 if(!filmId||!filmScreen||filmId===String(filmScreen))return;
 filmScrollById.set(String(filmScreen),window.scrollY||0);
 if(filmCompareId)filmCompareById.set(String(filmScreen),String(filmCompareId));
 openFilm(filmId);
}
function openFilm(id){
 const filmId=filmIdFromLocation('https://iptv.local/film/'+encodeURIComponent(String(id??'')));
 if(!filmId)return;
 filmReturnId=filmId;
 if(filmIdFromLocation()===filmId){applyFilmScreen(filmId);return;}
 const fromHome=onHomeScreen(),target=homeTarget();
 window.history.pushState({iptvFilm:filmId,iptvHome:fromHome?target:null},'',ReturnHome.withReturn(filmHref(filmId),target));
 applyFilmScreen(filmId);
}
function plainFilmActivation(event){
 if(!event||event.defaultPrevented||event.button!=null&&event.button!==0)return false;
 return !(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey);
}
// «На главную» on the film and events screens. A screen opened straight from this programme page by this page sits right after exactly that page
// in the history, so Back is the exact way home (scroll included, no new entry). In every other case (deep link, reload, nested navigation, a changed
// target) the link is a plain navigation to the target carried in the URL, or to the canonical home without one.
function returnHome(){
 const target=homeTarget(),state=window.history.state;
 if(state&&(state.iptvFilm||state.iptvEvents)&&state.iptvHome===target){window.history.back();return;}
 showHome(target);
}
function onHistoryNavigation(){
 const filmId=filmIdFromLocation();
 const leavingFilm=!!filmScreen&&!filmId,returnId=filmReturnId,filtersChanged=leavingFilm&&filmFiltersChanged();
 if(filmId){if(eventsScreen)applyEventsScreen(false);applyFilmScreen(filmId);return;}
 if(filmScreen)applyFilmScreen(null);
 const onEvents=eventsRequested();
 if(!onEvents){const next=readUrlState(new URL(window.location.href));if(leavingFilm&&filtersChanged)render();else if(filterStateKey(next)!==filterStateKey(state))restoreUrl();}
 if(onEvents!==eventsScreen)applyEventsScreen(onEvents);else if(onEvents)syncEventTypeFromUrl();
 if(eventsScreen)$('#activity-title')?.focus?.({preventScroll:true});
 else if(leavingFilm)focusFilmReturn(returnId);
 else (eventsTrigger||$('#activity-expand'))?.focus?.({preventScroll:true});
}
// On a film page the sidebar filters are live. Whatever changes them is reflected in the programme state the page will return to.
function syncFilmReturn(){
 const here=new URL(window.location.href),current=ReturnHome.fromSearch(here.search),home=urlForState('https://iptv.local'+current),target=home.pathname+home.search+home.hash;
 const path=here.pathname+here.search+here.hash,next=ReturnHome.withReturn(path,target);
 if(next!==path)window.history.replaceState(window.history.state,'',next);
 refreshReturnLinks();
}
function syncUrl(){
 if(!urlReady||urlRestoring||!Number.isInteger(state.from)||!Number.isInteger(state.to)||state.from<1900||state.to>MAX_YEAR||state.from>state.to||state.maxRuntime!==null&&(!Number.isInteger(state.maxRuntime)||state.maxRuntime<1))return;
 if(filmIdFromLocation()){syncFilmReturn();return;}
 if(eventsRequested())return;
 const next=urlForState(window.location.href);
 const target=next.pathname+next.search+next.hash,current=window.location.pathname+window.location.search+window.location.hash;
 if(target!==current)window.history.replaceState(window.history.state,'',target);
 refreshReturnLinks();
 markCurrentPreset();
}
function restoreUrl(){
 urlRestoring=true;
 Object.assign(state,readUrlState(new URL(window.location.href)));
 $('#sort').value=state.sort;
 $('#include-unscheduled').checked=state.includeUnscheduled;$('#started-only').checked=state.startedOnly;$('#last-chance-only').checked=state.lastChanceOnly;
 $('#year-from').value=state.from;$('#year-to').value=state.to;$('#runtime-max').value=state.maxRuntime??'';
 refreshGenreOptions();
 updateFacetOptions();
 for(const key of ['directors','actors']){const input=$('#'+key+'-input');const known=report?.people?.[key]?.find(person=>person.id===state[key]);input.value=known?.name||state[key]||'';input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');$('#'+key+'-options').hidden=true;}
 render();urlRestoring=false;
}
let films = [];
let eventCursor=null,eventLoading=false;const loadedEvents=new Map();
// AIR-381: the events screen filters the loaded events by the type of event. Pure mapping: «Все события» shows every loaded event, known or not,
// and the other buttons name the stored `type` values they stand for. A chosen type also searches older pages by itself (see startEventSearch).
const EVENT_TYPE_FILTERS=[
 {id:'all',label:'Все события',types:null},
 {id:'watchlist',label:'Watchlist и просмотр',types:['watchlist','started','unstarted']},
 {id:'epg',label:'Программа',types:['epg']},
 {id:'discovery',label:'Находки',types:['discovery']},
 {id:'ratings',label:'Оценки',types:['ratings']},
 {id:'enrichment',label:'Прогнозы',types:['enrichment']},
 {id:'taste_profile',label:'Модель вкуса',types:['taste_profile']},
];
function eventTypeFrom(search){
 let params;try{params=new URLSearchParams(String(search||''));}catch{return 'all';}
 for(const value of params.getAll('type')){const found=EVENT_TYPE_FILTERS.find(item=>item.id===value);if(found)return found.id;}
 return 'all';
}
function eventMatchesType(event,id){
 const filter=EVENT_TYPE_FILTERS.find(item=>item.id===id);
 return !filter||!filter.types||filter.types.includes(event&&event.type);
}
// Replaces only the `type` parameter of an href: every other parameter (the encoded `return` target included) and the fragment stay byte for byte.
function withEventType(href,id){
 const text=String(href),hashAt=text.indexOf('#'),hash=hashAt>=0?text.slice(hashAt):'',noHash=hashAt>=0?text.slice(0,hashAt):text;
 const queryAt=noHash.indexOf('?'),path=queryAt>=0?noHash.slice(0,queryAt):noHash,query=queryAt>=0?noHash.slice(queryAt+1):'';
 const keyOf=pair=>{const name=pair.split('=')[0];try{return decodeURIComponent(name.replace(/\+/g,' '));}catch{return name;}};
 const kept=query?query.split('&').filter(pair=>pair!==''&&keyOf(pair)!=='type'):[];
 if(id!=='all'&&EVENT_TYPE_FILTERS.some(item=>item.id===id))kept.push('type='+encodeURIComponent(id));
 return path+(kept.length?'?'+kept.join('&'):'')+hash;
}
const EVENT_SEARCH_TARGET=10;
let eventTypeFilterId='all',activityNote='Загружаем события…',eventsReady=false;
const eventSearch={token:0,state:'idle',controller:null};
function eventMatchCount(id){let count=0;for(const event of loadedEvents.values())if(eventMatchesType(event,id))count++;return count;}
const eventPause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function cancelEventSearch(){
 eventSearch.token++;
 if(eventSearch.controller){try{eventSearch.controller.abort();}catch{}eventSearch.controller=null;}
 eventSearch.state='idle';
}
// A chosen type looks for its events in the older pages by itself, one request at a time and in cursor order, until 10 events of that type are
// loaded or the cursor is exhausted; a page with no match does not stop it and needs no click. What is already loaded is reused. It stops at once on
// a change of type or screen (the request is aborted), on an API error (shown, with an explicit retry; never retried by itself) and on a cursor that
// repeats or does not advance. «Все события» never scans: it keeps the first page and the manual «Более давние события».
async function startEventSearch(){
 const id=eventTypeFilterId;
 cancelEventSearch();
 if(!eventsScreen||id==='all'||!eventsReady){renderActivity();return;}
 const token=eventSearch.token,controller=typeof AbortController==='function'?new AbortController():null,seen=new Set();
 eventSearch.controller=controller;
 if(eventCursor&&eventMatchCount(id)<EVENT_SEARCH_TARGET)eventSearch.state='searching';
 renderActivity();
 while(token===eventSearch.token&&eventCursor&&eventMatchCount(id)<EVENT_SEARCH_TARGET){
  while(eventLoading&&token===eventSearch.token)await eventPause(25);
  if(token!==eventSearch.token)return;
  const cursor=eventCursor;
  if(seen.has(cursor)){eventSearch.state='stuck';break;}
  seen.add(cursor);
  const result=await loadEvents(true,{quiet:true,auto:true,signal:controller?controller.signal:undefined});
  if(token!==eventSearch.token)return;
  if(result!==true){eventSearch.state='error';break;}
  renderActivity();
  await eventPause(0);
 }
 if(token!==eventSearch.token)return;
 eventSearch.controller=null;
 if(eventSearch.state==='searching')eventSearch.state=eventCursor?'idle':'exhausted';
 else if(eventSearch.state==='idle'&&!eventCursor)eventSearch.state='exhausted';
 renderActivity();
}
function activityStatusText(filter,ordered,shown){
 if(filter==='all')return activityNote;
 const state=eventSearch.state,found='Найдено среди загруженных: '+eventMatchCount(filter)+'.';
 // The state of the search is told first: an empty first page followed by a failure, a repeated cursor or the end of the archive must show.
 if(state==='searching')return 'Ищем более давние события… '+found;
 if(state==='error')return 'Не удалось загрузить события. '+found;
 if(state==='stuck')return 'Архив событий не продвигается дальше. '+found;
 if(!shown.length&&state==='exhausted')return 'Во всём доступном архиве событий этого типа нет.';
 if(!shown.length&&ordered.length)return 'Среди загруженных событий этого типа пока нет.';
 return activityNote;
}
function syncActivityMore(){
 const button=$('#activity-more');
 if(!button)return;
 const filtered=eventsScreen&&eventTypeFilterId!=='all';
 if(filtered&&eventSearch.state==='searching'){button.hidden=true;return;}
 if(filtered&&(eventSearch.state==='error'||eventSearch.state==='stuck')){button.hidden=false;button.disabled=false;button.textContent='Повторить';return;}
 if(!eventLoading&&eventsReady){button.hidden=!eventCursor;button.textContent='Более давние события';}
}
let startedIds=new Set(),startedReady=false,startedLoading=false;const savingStarted=new Set();
const peopleSources={directors:[],actors:[]};
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let genres = ['Боевик','Триллер','Криминал','Фантастика','Ужасы','Приключения','Комедия'];
function isArchive(show){return inArchive(viewingWindow(),show);}
function isFuture(show){return inFuture(viewingWindow(),show);}
const normalizeTitle = text => text.toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function normalizeSearch(value){return String(value??'').replace(/\p{Script=Latin}+/gu,chunk=>chunk.normalize('NFD').replace(/\p{M}+/gu,'')).replace(/ё/gi,'е').toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();}
function searchTokens(query){const normalized=normalizeSearch(query);return {normalized,tokens:normalized?normalized.split(' '):[]};}
function searchTexts(values){const out=[];for(const value of values){if(typeof value!=='string'||!value)continue;const folded=normalizeSearch(value);if(folded)out.push(folded);}return out;}
function searchEntry(film){
 const facets=filmFacets(film),people=[];
 for(const key of ['directors','actors'])for(const person of film[key]||[])people.push(...searchTexts([person?.name,person?.original,...(person?.aliases||[])]));
 return {names:searchTexts([film.title,film.original,...(film.aliases||[])]),people,facets:[...facets.mechanics].flatMap(id=>searchTexts([id,MECHANIC_LABELS[id]])).concat([...facets.moods].flatMap(id=>searchTexts([id,moodLabel(id)]))).concat(searchTexts(film.genres||[])),synopsis:normalizeSearch(film.synopsis||'')};
}
let searchCache=null;
function searchEntries(){if(!searchCache||searchCache.films!==films||searchCache.enrichment!==enrichment){const entries=new Map();for(const film of films)entries.set(String(film.id),searchEntry(film));searchCache={films,enrichment,entries};}return searchCache.entries;}
function searchRank(film,normalized,tokens,scopes=activeSearchScopes(state.searchScopes)){
 if(!tokens.length)return 0;
 return rankSearchEntry(searchEntries().get(String(film.id))||searchEntry(film),normalized,tokens,scopes);
}
function rankSearchEntry(entry,normalized,tokens,scopes){
 const titles=!!scopes.titles,people=!!scopes.people,plot=!!scopes.plot;
 if(titles&&entry.names.some(name=>name===normalized))return 0;
 if(titles&&normalized&&entry.names.some(name=>name.startsWith(normalized)))return 1;
 const ranks=tokens.map(token=>{
  if(titles&&entry.names.some(name=>name.includes(token)))return 2;
  if(people&&entry.people.some(name=>name.includes(token)))return 3;
  if(plot&&entry.facets.some(name=>name.includes(token)))return 4;
  if(plot&&entry.synopsis.includes(token))return 5;
  return null;
 });
 if(ranks.some(rank=>rank===null))return null;
 return Math.max(...ranks);
}
function applySearchInput(value){
 const hadQuery=normalizeSearch(state.query).length>0;
 state.query=value;
 const hasQuery=normalizeSearch(value).length>0;
 if(hasQuery&&!hadQuery&&!state.sortExplicit&&state.sort==='personal')state.sort='relevance';
 if(!hasQuery&&hadQuery&&!state.sortExplicit&&state.sort==='relevance')state.sort='personal';
}
function availabilityTime(film,now=viewingClock()){const model=viewingWindow(now);const starts=(film?.shows||[]).map(show=>inArchive(model,show)||inFuture(model,show)?showStart(show):null).filter(start=>start!==null);return starts.length?Math.max(...starts)+72*3600000:null;}
function isLastChance(film,now=viewingClock()){const until=availabilityTime(film,now);return until!==null&&until>now&&until-now<8*3600000;}
function filmTmdbViewKey(film){const tmdb=String(film?.tmdbId??'');return /^[1-9]\d{0,11}$/.test(tmdb)?'tmdb_'+tmdb:null;}
// Watchlist cards key films by Letterboxd lid; ratings_view also projects the verified tmdb_<n> of the same record. Titles are not compared.
function filmEnrichmentItem(film){
 const films=enrichment.films||{},id=String(film?.id??''),primary=films[id],alias=filmTmdbViewKey(film),secondary=alias&&alias!==id?films[alias]:null;
 if(!secondary||typeof secondary!=='object')return primary&&typeof primary==='object'?primary:{};
 if(!primary||typeof primary!=='object')return secondary;
 const item={...secondary,...primary};
 const primaryRating=Object.hasOwn(primary,'actualRating')?primary.actualRating:undefined,secondaryRating=Object.hasOwn(secondary,'actualRating')?secondary.actualRating:undefined;
 const primaryKnown=primaryRating!==undefined&&primaryRating!==null,secondaryKnown=secondaryRating!==undefined&&secondaryRating!==null;
 if(primaryKnown&&secondaryKnown&&Number(primaryRating)!==Number(secondaryRating))delete item.actualRating;
 else if(!primaryKnown&&secondaryKnown)item.actualRating=secondaryRating;
 if(!(primary.watched===true||primary.watched===false)&&(secondary.watched===true||secondary.watched===false))item.watched=secondary.watched;
 return item;
}
function hasActualRating(film){const rating=filmEnrichmentItem(film).actualRating;return rating!==null&&rating!==undefined;}
function filmFacets(film){const item=filmEnrichmentItem(film),fingerprint=item.fingerprint||{},mechanics=(fingerprint.plotMechanics||[]).filter(m=>Object.hasOwn(MECHANIC_LABELS,m)),moods=(item.moodIds||fingerprint.moodIds||item.prediction?.moodIds||[]).filter(id=>Object.hasOwn(MOOD_LABELS,id));return {mechanics:new Set(mechanics),moods:new Set(moods)};}
function filterMoodOptions(){const search=$('#mood-search'),count=$('#mood-option-count');if(!search||!count)return;const query=normalizeMood(search.value);let visible=0;document.querySelectorAll('#moods label').forEach(label=>{const show=!query||normalizeMood(moodLabel(label.querySelector('input').value)).replace(/ё/g,'е').includes(query.replace(/ё/g,'е'));label.hidden=!show;if(show)visible++;});count.textContent=query?`${visible} из ${moods.length} вариантов`:`${moods.length} вариантов · частые выше`;}
function updateFacetOptions(){
 const counts={mechanics:new Map(),moods:new Map()};
 for(const film of films){const facets=filmFacets(film);for(const key of ['mechanics','moods'])for(const value of facets[key])counts[key].set(value,(counts[key].get(value)||0)+1);}
 const listed=(key,known)=>[...new Set([...counts[key].keys(),...state[key]])].filter(known);
 mechanics=listed('mechanics',value=>Object.hasOwn(MECHANIC_LABELS,value)).sort((a,b)=>MECHANIC_LABELS[a].localeCompare(MECHANIC_LABELS[b],'ru'));
 moods=listed('moods',value=>Object.hasOwn(MOOD_LABELS,value)).sort((a,b)=>(counts.moods.get(b)||0)-(counts.moods.get(a)||0)||a.localeCompare(b,'ru'));
 const options=(values,key,label)=>values.map(value=>`<label class="genre-label"><input type="checkbox" value="${escapeHTML(value)}"><span>${escapeHTML(label(value))}</span><span class="genre-count">${counts[key].get(value)||0}</span></label>`).join('');
 const mechanicsBox=$('#mechanics'),moodsBox=$('#moods');
 if(mechanicsBox)mechanicsBox.innerHTML=options(mechanics,'mechanics',value=>MECHANIC_LABELS[value]);
 if(moodsBox)moodsBox.innerHTML=options(moods,'moods',moodLabel);
 document.querySelectorAll('#mechanics input').forEach(input=>input.checked=state.mechanics.has(input.value));document.querySelectorAll('#moods input').forEach(input=>input.checked=state.moods.has(input.value));
 const mechanicsEmpty=$('#mechanics-empty'),moodsEmpty=$('#moods-empty');
 if(mechanicsEmpty)mechanicsEmpty.hidden=mechanics.length>0;if(moodsEmpty)moodsEmpty.hidden=moods.length>0;filterMoodOptions();updateExecutionOptions();
}
function storedExecution(film){const value=filmEnrichmentItem(film).fingerprint?.execution;return value&&typeof value==='object'?value:null;}
function matchesExecution(film){const stored=storedExecution(film);for(const dimension of EXECUTION_FILTERS){const selected=state.execution[dimension.id];if(!selected?.size)continue;if(!selected.has(stored?.[dimension.id]))return false;}return true;}
function scopedChannels(film){return new Set(periodShows(film).map(show=>show.channel).filter(Boolean));}
function matchesChannels(film){if(!state.channels?.size)return true;const names=scopedChannels(film);return [...state.channels].some(channel=>names.has(channel));}
function filmsMatching(except){
 const backup={genres:state.genres,mechanics:state.mechanics,moods:state.moods,channels:state.channels,execution:state.execution};
 if(except==='genres')state.genres=new Set();
 else if(except==='mechanics')state.mechanics=new Set();
 else if(except==='moods')state.moods=new Set();
 else if(except==='channels')state.channels=new Set();
 else if(except.startsWith('execution:'))state.execution={...backup.execution,[except.slice(10)]:new Set()};
 try{return films.filter(film=>eligible(film)&&inSelectedScope(film));}
 finally{state.genres=backup.genres;state.mechanics=backup.mechanics;state.moods=backup.moods;state.channels=backup.channels;state.execution=backup.execution;}
}
function countedOptions(except,selected,known){
 const counts=new Map();
 for(const film of filmsMatching(except)){
  const values=except==='channels'?scopedChannels(film):except==='genres'?new Set(film.genres||[]):except==='mechanics'?filmFacets(film).mechanics:filmFacets(film).moods;
  for(const value of values)if(known(value))counts.set(value,(counts.get(value)||0)+1);
 }
 return [...new Set([...counts.keys(),...selected])].filter(value=>known(value)&&(counts.get(value)||selected.has(value))).map(value=>({value,count:counts.get(value)||0})).filter(item=>item.count>0||selected.has(item.value));
}
function buildFacetCatalog(){
 const label=(kind,value)=>kind==='mechanics'?MECHANIC_LABELS[value]:kind==='moods'?moodLabel(value):value;
 const flat=(kind,selected,known)=>countedOptions(kind,selected,known).map(item=>({...item,label:label(kind,item.value)})).sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label,'ru'));
 const executionCounts=dimension=>{const counts=new Map();for(const film of filmsMatching('execution:'+dimension.id)){const value=storedExecution(film)?.[dimension.id];if(EXECUTION_VALUES[dimension.id]?.[value])counts.set(value,(counts.get(value)||0)+1);}return counts;};
 return {
  genres:flat('genres',state.genres,value=>typeof value==='string'&&value.length>0),
  mechanics:flat('mechanics',state.mechanics,value=>Object.hasOwn(MECHANIC_LABELS,value)),
  moods:flat('moods',state.moods,value=>Object.hasOwn(MOOD_LABELS,value)),
  channels:flat('channels',state.channels,value=>typeof value==='string'&&value.length>0),
  execution:EXECUTION_FILTERS.map(dimension=>{const counts=executionCounts(dimension);return {id:dimension.id,label:dimension.label,options:dimension.values.map(([value,text])=>({value,label:text,count:counts.get(value)||0})).filter(item=>item.count>0||state.execution[dimension.id].has(item.value))};}).filter(group=>group.options.length),
 };
}
let facetCatalog=buildFacetCatalog(),openFacetName='',facetTrigger=null;
function facetInputKey(input){return `${input.dataset?.execution||''}:${input.value}`;}
function selectedFacetLabels(kind){
 const options=facetCatalog[kind]||[];
 const selected=state[kind];
 return options.filter(item=>selected.has(item.value)).map(item=>item.label);
}
function renderFacetBody(){
 const body=$('#facet-body'),search=$('#facet-search');if(!body||!openFacetName)return;
 const active=document.activeElement;
 const before=typeof body.querySelectorAll==='function'?[...body.querySelectorAll('input')]:[];
 const focused=active&&typeof body.contains==='function'&&body.contains(active)&&active.tagName==='INPUT'?active:null;
 const key=focused?facetInputKey(focused):'',index=focused?before.indexOf(focused):-1;
 const query=normalizeTitle(search?.value||'');
 const show=label=>!query||normalizeTitle(label).includes(query);
 const optionHtml=(item,checked)=>`<label class="genre-label"><input type="checkbox" value="${escapeHTML(item.value)}"${checked?' checked':''}><span>${escapeHTML(item.label)}</span><span class="genre-count">${item.count}</span></label>`;
 const html=openFacetName==='execution'
  ?facetCatalog.execution.map(group=>{const options=group.options.filter(item=>show(item.label)||show(group.label));if(!options.length)return '';return `<section class="execution-facet"><h3 class="execution-name">${escapeHTML(group.label)}</h3>${options.map(item=>`<label class="genre-label"><input type="checkbox" data-execution="${escapeHTML(group.id)}" value="${escapeHTML(item.value)}"${state.execution[group.id].has(item.value)?' checked':''}><span>${escapeHTML(item.label)}</span><span class="genre-count">${item.count}</span></label>`).join('')}</section>`;}).join('')
  :openFacetName==='moods'
  ?MOOD_GROUP_ORDER.map(bucket=>{const heading=MOOD_GROUP_LABELS[bucket],ids=new Set(MOOD_GROUPS[bucket]),options=(facetCatalog.moods||[]).filter(item=>ids.has(item.value)&&(show(item.label)||show(heading)));if(!options.length)return '';return `<section class="mood-facet-group" aria-labelledby="mood-group-${bucket}"><h3 class="mood-group-name" id="mood-group-${bucket}">${escapeHTML(heading)}</h3>${options.map(item=>optionHtml(item,state.moods.has(item.value))).join('')}</section>`;}).join('')
  :(facetCatalog[openFacetName]||[]).filter(item=>show(item.label)).map(item=>optionHtml(item,state[openFacetName].has(item.value))).join('');
 body.innerHTML=html;
 if(!focused||typeof body.querySelectorAll!=='function')return;
 const inputs=[...body.querySelectorAll('input')];
 const next=inputs.find(input=>facetInputKey(input)===key)||inputs[Math.max(0,Math.min(index,inputs.length-1))];
 if(next)next.focus();
}
function syncFacetPickers(){
 facetCatalog=buildFacetCatalog();
 for(const kind of ['genres','mechanics','moods','channels']){const node=$('#summary-'+kind);if(node)node.textContent=facetSummary(selectedFacetLabels(kind));}
 const executionNode=$('#summary-execution');
 if(executionNode){const labels=[];for(const group of facetCatalog.execution)for(const item of group.options)if(state.execution[group.id].has(item.value))labels.push(`${group.label}: ${item.label}`);executionNode.textContent=facetSummary(labels);}
 const chips=$('#filter-chips');
 if(chips){
  const items=[];
  for(const kind of ['genres','mechanics','moods','channels'])for(const option of facetCatalog[kind]||[])if(state[kind].has(option.value))items.push({kind,value:option.value,label:option.label});
  for(const group of facetCatalog.execution)for(const item of group.options)if(state.execution[group.id].has(item.value))items.push({kind:'execution',value:`${group.id}:${item.value}`,label:`${group.label}: ${item.label}`});
  chips.innerHTML=items.map(item=>`<button type="button" class="filter-chip" data-chip-kind="${escapeHTML(item.kind)}" data-chip-value="${escapeHTML(item.value)}">${escapeHTML(item.label)} <span aria-hidden="true">×</span></button>`).join('');
 }
 if(openFacetName)renderFacetBody();
}
function closeFacet(){const trigger=facetTrigger;openFacetName='';facetTrigger=null;const pop=$('#facet-popover');if(pop)pop.hidden=true;if(typeof document.querySelectorAll==='function')document.querySelectorAll('.facet-trigger').forEach(button=>button.setAttribute('aria-expanded','false'));if(trigger)trigger.focus();}
function openFacet(kind,button){
 openFacetName=kind;facetTrigger=button||facetTrigger;syncFacetPickers();
 const pop=$('#facet-popover'),title=$('#facet-title'),search=$('#facet-search');
 if(!pop)return;
 document.querySelectorAll('.facet-trigger').forEach(item=>item.setAttribute('aria-expanded',String(item===button)));
 const names={genres:'Жанры',mechanics:'Механика',moods:'Настроение',channels:'Канал',execution:'Исполнение'};
 if(title)title.textContent=names[kind]||kind;
 if(search){search.value='';search.placeholder=kind==='channels'?'Найти канал':kind==='execution'?'Найти характеристику':'Найти';}
 pop.hidden=false;pop.classList.toggle('sheet',window.matchMedia('(max-width:760px)').matches);
 if(!pop.classList.contains('sheet')&&button){const rect=button.getBoundingClientRect();pop.style.top=`${Math.min(rect.bottom+8,window.innerHeight-280)}px`;pop.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-332))}px`;}
 renderFacetBody();if(search)search.focus();
}
function removeFacetValue(kind,value){
 if(kind==='execution'){const separator=value.indexOf(':');const selected=state.execution[value.slice(0,separator)];if(selected)selected.delete(value.slice(separator+1));}
 else state[kind]?.delete(value);
}
function updateExecutionOptions(){
 const box=$('#execution');if(!box)return;
 const counts=Object.fromEntries(EXECUTION_FILTERS.map(dimension=>[dimension.id,new Map()]));
 for(const film of films){const stored=storedExecution(film);if(!stored)continue;for(const dimension of EXECUTION_FILTERS){const value=stored[dimension.id];if(EXECUTION_VALUES[dimension.id]?.[value])counts[dimension.id].set(value,(counts[dimension.id].get(value)||0)+1);}}
 const sections=[];
 for(const dimension of EXECUTION_FILTERS){const values=dimension.values.filter(([value])=>counts[dimension.id].has(value)||state.execution[dimension.id].has(value));if(!values.length)continue;const options=values.map(([value,label])=>`<label class="genre-label"><input type="checkbox" data-execution="${escapeHTML(dimension.id)}" value="${escapeHTML(value)}"><span>${escapeHTML(label)}</span><span class="genre-count">${counts[dimension.id].get(value)||0}</span></label>`).join('');sections.push(`<section class="execution-facet"><h3 class="execution-name">${escapeHTML(dimension.label)}</h3><div class="facet-list">${options}</div></section>`);}
 box.innerHTML=sections.join('');
 const empty=$('#execution-empty');if(empty)empty.hidden=sections.length>0;
 if(typeof box.querySelectorAll==='function')box.querySelectorAll('input').forEach(input=>{input.checked=!!state.execution[input.dataset.execution]?.has(input.value);});
}
function eligible(film) { const parsed=searchTokens(state.query); const matched=searchRank(film,parsed.normalized,parsed.tokens)!==null; const prediction=enrichment.films[String(film.id)]?.prediction,facets=filmFacets(film); return matched && (state.viewing==='any'||ratingsLoaded&&((state.viewing==='rewatch')===hasActualRating(film))) && (state.minPrediction===null||Number.isFinite(prediction?.predictedRating)&&prediction.predictedRating>=state.minPrediction) && (state.minProbability===null||Number.isFinite(prediction?.probability4Plus)&&prediction.probability4Plus>=state.minProbability) && (!state.startedOnly||startedIds.has(String(film.id))) && (!state.lastChanceOnly||isLastChance(film)) && ['directors','actors'].every(key=>!state[key]||(film[key]||[]).some(p=>p.id===state[key])) && ((film.year >= state.from && film.year <= state.to)||(!film.year&&state.from===1900&&state.to===MAX_YEAR)) && (state.maxRuntime===null||(Number(film.runtime)>0&&Number(film.runtime)<=state.maxRuntime)) && (!state.genres.size || film.genres.some(g => state.genres.has(g))) && (!state.mechanics.size||[...state.mechanics].some(m=>facets.mechanics.has(m))) && (!state.moods.size||[...state.moods].some(m=>facets.moods.has(m))) && matchesChannels(film) && matchesExecution(film); }
function periodShows(film,period=state.period) { return film.shows.filter(s => period==='archive'?isArchive(s):period==='future'?isFuture(s):isArchive(s)||isFuture(s)); }
function filmWord(n){return n%10===1&&n%100!==11?'фильм':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'фильма':'фильмов';}
function showWord(n){return n%10===1&&n%100!==11?'показ':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'показа':'показов';}
function programmeWindow(snapshot){
 const start=Number(snapshot.window?.from),end=Number(snapshot.window?.to);
 if(Number.isFinite(start)&&Number.isFinite(end)&&end-start>=24*3600000){const hot=Number(snapshot.window?.hotTo),saved=Number(snapshot.cutoff);return {start,cutoff:Number.isFinite(hot)?hot-24*3600000:Number.isFinite(saved)?saved:end-24*3600000,end};}
 const cutoff=Date.parse(snapshot.updatedAt);
 return {start:cutoff-72*3600000,cutoff,end:cutoff+24*3600000};
}
function madridStamp(ms,options={day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}){return new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',...options}).format(new Date(ms));}
function madridDay(ms){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));}
function matchHintText(reason){return {ambiguous_short_title_without_year:'Короткое название без года: возможна другая версия.',ambiguous_collision:'Несколько фильмов подходят под это название.',ambiguous_margin:'Совпадение недостаточно уверенное.',contradicted_year:'Год не сходится с известным фильмом.',contradicted_runtime:'Длительность сильно отличается.',no_confident_score:'Нет уверенного совпадения.',no_exact_title:'Название совпало неточно.',no_confident_match:'Нет уверенного совпадения.'}[reason]||'Совпадение неуверенное: возможна другая версия фильма.';}
// AIR-382. A Letterboxd link needs a proven URL. Watchlist films carry it as `url`; a catalog find carries a TMDB `url`, so only the separate read-only `letterboxdUrl` can prove it there.
// AIR-384. One pure resolver for the Letterboxd icon target, in this order:
// 1. a validated canonical Letterboxd film URL (`letterboxdUrl`; for a watchlist/local film also its `url`): always wins;
// 2. only for a catalog-only film (`catalog:true`) with a verified TMDB movie identity (`canonicalIdentity` exactly `tmdb:<n>`, agreeing with `tmdbId`, n a
//    positive integer): Letterboxd's own documented redirect `https://letterboxd.com/tmdb/<n>`. It is a navigation aid, not a Letterboxd id, slug or
//    provenance: it is never stored, never sent to the API, and nothing is fetched to check it. TV, unknown, mismatched or malformed identities get none;
// 3. otherwise no link. A slug is never built from a title.
const LETTERBOXD_FILM_URL=/^https:\/\/letterboxd\.com\/film\/[a-z0-9-]+\/$/,TMDB_MOVIE_ID=/^[1-9]\d{0,11}$/;
function letterboxdTarget(film,{catalog=false}={}){
 const valid=value=>typeof value==='string'&&LETTERBOXD_FILM_URL.test(value)?value:'';
 // A catalog film's `url` is its TMDB page, never Letterboxd provenance: for a catalog-only film only `letterboxdUrl` can be canonical.
 const canonical=valid(film?.letterboxdUrl)||(catalog?'':valid(film?.url));
 if(canonical)return {href:canonical,kind:'canonical'};
 if(!catalog||!film)return null;
 const raw=film.tmdbId,id=typeof raw==='string'||Number.isSafeInteger(raw)?String(raw):'';
 if(!TMDB_MOVIE_ID.test(id)||film.canonicalIdentity!=='tmdb:'+id)return null;
 return {href:'https://letterboxd.com/tmdb/'+id,kind:'tmdb-redirect'};
}
function letterboxdHref(film,options){return letterboxdTarget(film,options)?.href||'';}
function letterboxdLink(film,options){const target=letterboxdTarget(film,options);if(!target)return '';const label=target.kind==='tmdb-redirect'?'Открыть в Letterboxd по TMDB id':'Открыть в Letterboxd';return `<a class="letterboxd-link" href="${escapeHTML(target.href)}" target="_blank" rel="noopener noreferrer" title="${label}" aria-label="${label}"><svg class="letterboxd-mark" width="32" height="15" viewBox="0 0 32 15" aria-hidden="true"><g style="isolation:isolate"><circle cx="7.5" cy="7.5" r="6.6" fill="#ff8000" style="mix-blend-mode:screen"/><circle cx="16" cy="7.5" r="6.6" fill="#00e054" style="mix-blend-mode:screen"/><circle cx="24.5" cy="7.5" r="6.6" fill="#40bcf4" style="mix-blend-mode:screen"/></g></svg></a>`;}
function channelControl(show){const hint=show.basis==='title_duration'?`<span class="match-hint" title="${escapeHTML(matchHintText(show.matchReason))}" aria-label="${escapeHTML(matchHintText(show.matchReason))}"> ≈</span>`:'';const name=typeof show.channel==='string'?show.channel:'';if(!name.trim())return `<span class="channel">${hint}</span>`;return `<span class="channel"><button type="button" class="channel-filter" data-channel="${escapeHTML(name)}" title="Добавить канал «${escapeHTML(name)}» в фильтр" aria-label="Добавить канал «${escapeHTML(name)}» в фильтр">${escapeHTML(name)}</button>${hint}</span>`;}
function row(show){const start=showStart(show),date=new Date(start),time=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'}).format(date);return `<div class="show-row">${channelControl(show)}<time class="show-time" datetime="${date.toISOString()}">${madridStamp(start,{day:'numeric',month:'short'})}<b>${time}</b></time></div>`;}
function compareShows(type){return (a,b)=>{const rank=(state.channels.has(a.channel)?0:1)-(state.channels.has(b.channel)?0:1);if(rank)return rank;return type==='archive'?showStart(b)-showStart(a):showStart(a)-showStart(b);};}
function group(film,type){const shows=film.shows.filter(type==='archive'?isArchive:isFuture).sort(compareShows(type));if(!shows.length)return '';return `<section class="show-group ${type}"><div class="group-title"><span>${type==='archive'?'АРХИВ':'ДАЛЬШЕ'}</span><span class="show-count">${shows.length} ${showWord(shows.length)}</span></div>${row(shows[0])}${shows.length>1?`<details class="more"><summary>Ещё ${shows.length-1} ${showWord(shows.length-1)}</summary>${shows.slice(1).map(row).join('')}</details>`:''}</section>`;}
function startedButton(film,labeled=false){
 const id=String(film.id),on=startedIds.has(id),busy=savingStarted.has(id);
 const caption=on?'Просмотр начат':'Начал просмотр';
 return `<div class="started-action"><button type="button" class="started-button" data-started-id="${escapeHTML(id)}" aria-pressed="${on}" aria-busy="${busy}" aria-label="${labeled?caption:on?'Снять отметку «Начал смотреть»':'Начал смотреть'}: ${escapeHTML(film.title)}" title="${labeled?caption:on?'Снять отметку «Начал смотреть»':'Отметить начатый просмотр'}" ${!startedReady||busy?'disabled':''}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>${labeled?`<span>${caption}</span>`:''}</button></div>`;
}
function progressError(message){const text=$('#progress-error-text'),box=$('#progress-error');if(text)text.textContent=message;if(box)box.hidden=!message;const film=$('#film-screen-progress');if(film){film.textContent=message;film.hidden=!message;}}
async function loadStarted(options={}){if(startedLoading||savingStarted.size)return 'busy';startedLoading=true;try{const r=await fetch('/api/started');if(!r.ok)throw new Error();const data=await r.json();if(!Array.isArray(data.ids))throw new Error();const next=new Set(data.ids.map(String)),wasReady=startedReady,same=next.size===startedIds.size&&[...next].every(id=>startedIds.has(id));startedIds=next;startedReady=true;$('#started-only').disabled=false;progressError('');if(!same||!wasReady)renderPreservingScroll();return true;}catch{if(!options.quiet)progressError('Не удалось загрузить отметки просмотра. Повтори попытку.');return false;}finally{startedLoading=false;}}
function refreshFilmStarted(id){const film=currentFilm(),actions=$('#film-screen-actions');if(!filmScreen||!film||film.catalogRoute||String(film.id)!==String(id))return;if(!film||!actions)return;actions.innerHTML=`${letterboxdLink(film)}${startedButton(film,true)}`;const button=document.querySelector(`#film-screen [data-started-id="${String(id).replace(/"/g,'')}"]`);button?.focus?.({preventScroll:true});}
async function toggleStarted(id){if(!startedReady||startedLoading||savingStarted.has(id))return;const next=!startedIds.has(id);savingStarted.add(id);progressError('');render();refreshFilmStarted(id);try{const r=await fetch('/api/started',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,started:next})});if(!r.ok)throw new Error();const data=await r.json();if(data.id!==id||data.started!==next)throw new Error();next?startedIds.add(id):startedIds.delete(id);loadEvents();}catch{progressError('Не удалось сохранить отметку. Нажми на глаз ещё раз, чтобы повторить.');}finally{savingStarted.delete(id);render();refreshFilmStarted(id);}}
function confidenceText(value){return {low:'низкая',medium:'средняя',high:'высокая'}[value]||'';}
// Optional evidence assessment. Absent on every live DTO today, so the forecast line stays the model
// field. A present object is rendered from this allowlist only; the page does not compute or fetch it.
const EVIDENCE_CONFIDENCE_LEVEL={low:'низкое',medium:'среднее',high:'высокое'};
const EVIDENCE_CONFIDENCE_REASONS={
 legacy_no_evidence:'У отпечатка нет карты доказательств.',
 evidence_unusable:'Карта доказательств не читается.',
 unsupported_schema:'Версия отпечатка не входит в эту таблицу.',
 evidence_shape:'Карта не совпала с заявлением, поэтому качество доказательств не выставлено.',
 metadata_only_execution:'Описания сюжета недостаточно для качества исполнения.',
 metadata_mechanic:'Механика опирается на описание фильма.',
 declared_source_not_verified:'Источник заявлен моделью или ссылкой и отдельно не проверялся.',
 low_item_confidence:'Часть доказательств помечена как слабая.',
 duplicate_ref:'Повторяющиеся ссылки делают карту недостаточной.',
 unknown_gap:'Неизвестное измерение — пробел в доказательствах, а не низкое качество известного исполнения.',
 no_asserted_mechanics:'Заявленных механик нет.',
 partial_mechanic_coverage:'Подтверждены не все заявленные механики.',
 partial_execution_coverage:'Подтверждены не все ключевые измерения.',
 key_coverage_complete:'Ключевые измерения с конкретным значением подтверждены.',
 not_applicable_excluded:'Неприменимые измерения не снижают оценку.',
 genre_optional:'Жанровые измерения учитываются только там, где они есть.'
};
function evidenceConfidenceHtml(value,fingerprintHash){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.assessmentVersion!==1)return '';
 if(typeof value.level!=='string'||!Object.hasOwn(EVIDENCE_CONFIDENCE_LEVEL,value.level))return '';
 if(typeof value.status!=='string'||!['evidenced','legacy','insufficient'].includes(value.status))return '';
 const level=EVIDENCE_CONFIDENCE_LEVEL[value.level];
 if(value.status!=='evidenced'&&value.level!=='low')return '';
 if(!Array.isArray(value.reasonCodes)||!value.coverage||typeof value.coverage!=='object'||Array.isArray(value.coverage))return '';
 for(const key of ['mechanicsAsserted','mechanicsSupported','keyApplicable','keyConcrete','keySupported','keyUnknown','keyNotApplicable','genrePresent','genreSupported']){
  const number=value.coverage[key];
  if(typeof number!=='number'||!Number.isInteger(number)||number<0||number>99)return '';
 }
 const bound=typeof fingerprintHash==='string'&&/^[a-f0-9]{64}$/.test(fingerprintHash)?fingerprintHash:null;
 const assessed=typeof value.fingerprintHash==='string'&&/^[a-f0-9]{64}$/.test(value.fingerprintHash)?value.fingerprintHash:null;
 if(bound&&assessed!==bound)return '';
 const notes=Object.keys(EVIDENCE_CONFIDENCE_REASONS).filter(code=>value.reasonCodes.includes(code)).map(code=>EVIDENCE_CONFIDENCE_REASONS[code]);
 const visible=notes.slice(0,3).join(' '),title=notes.join(' ');
 return `<div class="evidence-confidence" data-level="${value.level}" data-status="${value.status}"${title?` title="${escapeHTML(title)}"`:''}><p class="evidence-confidence-level">Качество доказательств: <strong>${level}</strong></p>${visible?`<p class="evidence-confidence-limits">${escapeHTML(visible)}</p>`:''}</div>`;
}
function filmWhy(prediction){if(!prediction||!Number.isFinite(prediction.predictedRating))return '';const signals=(Array.isArray(prediction.matchSignals)?prediction.matchSignals:[]).filter(item=>typeof item==='string'&&item.trim()).slice(0,3).map(item=>item.trim());const risk=typeof prediction.mainRisk==='string'?prediction.mainRisk.trim():'';if(!signals.length&&!risk)return '';const signalText=signals.length<2?escapeHTML(signals[0]||''):signals.length===2?`${escapeHTML(signals[0])} и ${escapeHTML(signals[1])}`:`${signals.slice(0,-1).map(item=>escapeHTML(item)).join(', ')} и ${escapeHTML(signals.at(-1))}`;return `<div class="film-why">${signals.length?`<p><span>Совпадает со вкусом</span> ${signalText}</p>`:''}${risk?`<p><span>Основной риск</span> ${escapeHTML(risk)}</p>`:''}</div>`;}
function setFilmHtml(id,html){const node=$('#'+id);if(node)node.innerHTML=html;}
function availableShows(film,now=viewingClock()){const model=viewingWindow(now);return (film?.shows||[]).map(show=>({...show,start:showStart(show)})).filter(show=>show.start!==null&&(inArchive(model,show)||inFuture(model,show))).sort((a,b)=>a.start-b.start||String(a.channel||'').localeCompare(String(b.channel||''),'ru'));}
// A catalog page carries its own current prediction and fingerprint (null when none is current); a watchlist film reads the view index.
function filmItem(film){return film?.catalogRoute?{prediction:film.prediction||undefined,fingerprint:film.fingerprint||undefined,moodIds:film.fingerprint?.moodIds}:filmEnrichmentItem(film);}
function filmScore(film){const item=filmItem(film),actual=item.actualRating,prediction=item.prediction;const rating=actual!==null&&actual!==undefined&&Number.isFinite(Number(actual))?`<article class="film-score-card"><span>Оценка Letterboxd</span><strong>${Number(actual).toFixed(1)}</strong></article>`:`<article class="film-score-card is-empty"><span>Оценка Letterboxd</span><p class="film-missing">Оценка Letterboxd не сохранена</p></article>`;const forecast=prediction&&Number.isFinite(prediction.predictedRating)?(()=>{const chance=Number.isFinite(prediction.probability4Plus)?`${Math.round(prediction.probability4Plus*100)}%`:'',confidence=confidenceText(prediction.confidence),assessed=evidenceConfidenceHtml(prediction.confidenceAssessment,prediction.fingerprintHash),model=confidence?(assessed?`уверенность модели ${escapeHTML(confidence)}`:`уверенность ${escapeHTML(confidence)}`):'';return `<article class="film-score-card"><span>Прогноз</span><strong>${Number(prediction.predictedRating).toFixed(1)}</strong><p>${chance?`<span>шанс 4.0+ ${chance}</span>`:''}${model?`<span>${model}</span>`:''}${prediction.stale?'<span>ожидает пересчёта</span>':''}</p>${assessed}</article>`;})():'<article class="film-score-card is-empty"><span>Прогноз</span><p class="film-missing">Прогноз ещё не готов</p></article>';return `<section class="film-score" aria-label="Оценка и прогноз"><div class="film-score-row">${forecast}${film.catalogRoute?'':rating}</div>${filmWhy(prediction)}</section>`;}
function filmSynopsis(film){const text=String(film.synopsis||'').trim();return `<section class="film-section"><h2>Синопсис</h2>${text?`<p class="film-page-synopsis">${escapeHTML(text)}</p>`:'<p class="film-missing">Синопсис не сохранён</p>'}</section>`;}
function filmPeople(label,people,key){if(!people?.length)return '';return `<div class="film-people-row"><h3>${label}</h3><div class="film-people">${creditLinks(people,key)}</div></div>`;}
function filmCredits(film){const directors=filmPeople(film.directors?.length>1?'Режиссёры':'Режиссёр',film.directors,'directors'),actors=filmPeople('В ролях',film.actors,'actors');return `<section class="film-section"><h2>Люди</h2>${directors||actors?directors+actors:'<p class="film-missing">Режиссёр и актёры не указаны</p>'}</section>`;}
function knownFacetIds(values,labels){const seen=new Set(),out=[];for(const value of values||[]){if(typeof value!=='string'||!Object.hasOwn(labels,value)||seen.has(value))continue;seen.add(value);out.push(value);}return out;}
function filmFacetChip(kind,value,label,dimension){return `<button type="button" class="film-chip" data-facet-kind="${kind}" data-facet-value="${escapeHTML(value)}"${dimension?` data-facet-dimension="${escapeHTML(dimension)}"`:''}>${escapeHTML(label)}</button>`;}
function filmFingerprint(film){const item=filmItem(film),fingerprint=item.fingerprint&&typeof item.fingerprint==='object'?item.fingerprint:null,mechanics=knownFacetIds(fingerprint?.plotMechanics,MECHANIC_LABELS),moods=knownFacetIds(fingerprint?.moodIds||item.moodIds,MOOD_LABELS),stored=fingerprint?.execution&&typeof fingerprint.execution==='object'?fingerprint.execution:{},execution=EXECUTION_FILTERS.flatMap(dimension=>{const value=stored[dimension.id];if(value==='unknown'||value==='not_applicable')return [];const label=EXECUTION_VALUES[dimension.id]?.[value];return label?[{id:dimension.id,name:dimension.label,value,label}]:[];});if(!mechanics.length&&!moods.length&&!execution.length)return `<section class="film-section film-fingerprint" aria-label="Характеристики"><h2>Характеристики</h2><p class="film-missing">Характеристики не сохранены</p></section>`;const row=(title,html)=>`<div class="film-facet-row"><h3>${title}</h3><div class="film-chips">${html}</div></div>`;return `<section class="film-section film-fingerprint" aria-label="Характеристики"><h2>Характеристики</h2>${mechanics.length?row('Механика',mechanics.map(id=>filmFacetChip('mechanics',id,MECHANIC_LABELS[id])).join('')):''}${moods.length?row('Настроение',moods.map(id=>filmFacetChip('moods',id,moodLabel(id))).join('')):''}${execution.length?`<div class="film-execution">${execution.map(item=>`<div class="film-execution-item"><h3>${escapeHTML(item.name)}</h3>${filmFacetChip('execution',item.value,item.label,item.id)}</div>`).join('')}</div>`:''}</section>`;}
function selectFacet(kind,value,dimension){if(kind==='mechanics'){if(!Object.hasOwn(MECHANIC_LABELS,value))return;state.mechanics.add(value);}else if(kind==='moods'){if(!Object.hasOwn(MOOD_LABELS,value))return;state.moods.add(value);}else if(kind==='execution'){if(!dimension||!Object.hasOwn(EXECUTION_VALUES,dimension)||!Object.hasOwn(EXECUTION_VALUES[dimension],value))return;state.execution[dimension].add(value);}else return;render();}
function storedComparable(film){const item=enrichment.films?.[String(film?.id)]||{},fingerprint=item.fingerprint&&typeof item.fingerprint==='object'?item.fingerprint:null,mechanics=knownFacetIds(fingerprint?.plotMechanics,MECHANIC_LABELS),moods=knownFacetIds(fingerprint?.moodIds||item.moodIds,MOOD_LABELS),stored=fingerprint?.execution&&typeof fingerprint.execution==='object'?fingerprint.execution:{},execution=new Map();for(const dimension of EXECUTION_FILTERS){const value=stored[dimension.id];if(!value||value==='unknown'||value==='not_applicable'||!EXECUTION_VALUES[dimension.id]?.[value])continue;execution.set(dimension.id,value);}return {mechanics,moods,execution,empty:!mechanics.length&&!moods.length&&!execution.size};}
function filmCompareLabel(film){const title=normalizeTitle(film.title||'');const ambiguous=films.some(other=>String(other.id)!==String(film.id)&&normalizeTitle(other.title||'')===title);return `${film.title||'Фильм'}${film.year?` · ${film.year}`:''}${ambiguous?` · ${film.id}`:''}`;}
function showFacetValue(text){const value=String(text||'');return value?value.charAt(0).toLocaleUpperCase('ru')+value.slice(1):'';}
function savedForecast(film){const prediction=enrichment.films?.[String(film?.id)]?.prediction;if(!prediction||!Number.isFinite(prediction.predictedRating))return null;const chance=Number.isFinite(prediction.probability4Plus)?`${Math.round(prediction.probability4Plus*100)}%`:'';return `${Number(prediction.predictedRating).toFixed(1)}${chance?` · ${chance}`:''}`;}
function filmCompare(film){if(!filmCompareId)return '<p class="film-missing">Выбери другой фильм из загруженной программы. Это сравнение сохранённых характеристик, не подбор похожих.</p>';if(String(filmCompareId)===String(film.id))return '<p class="film-missing">Это тот же фильм. Для сравнения нужен другой.</p>';const other=films.find(item=>String(item.id)===String(filmCompareId));if(!other)return '<p class="film-missing">Этого фильма нет в загруженной программе.</p>';const left=storedComparable(film),right=storedComparable(other);if(left.empty)return '<p class="film-missing">У этого фильма нет сохранённых характеристик для сравнения.</p>';if(right.empty)return `<p class="film-missing">У «${escapeHTML(other.title)}» нет сохранённых характеристик для сравнения.</p>`;const sharedMechanics=left.mechanics.filter(id=>right.mechanics.includes(id)),sharedMoods=left.moods.filter(id=>right.moods.includes(id));const rows=[];for(const dimension of EXECUTION_FILTERS){const a=left.execution.get(dimension.id),b=right.execution.get(dimension.id);if(!a&&!b)continue;const scale=EXECUTION_RANK[dimension.id];let markA='',markB='',kind='is-gap';if(a&&b){kind=a===b?'is-same':'is-diff';if(scale&&a!==b){const higher=scale.indexOf(a)>scale.indexOf(b);if(scale.includes(a)&&scale.includes(b)){markA=higher?'лучше':'хуже';markB=higher?'хуже':'лучше';}}}rows.push({label:dimension.label,a:a?showFacetValue(EXECUTION_VALUES[dimension.id][a]):'',b:b?showFacetValue(EXECUTION_VALUES[dimension.id][b]):'',markA,markB,kind});}const canMechanics=left.mechanics.length&&right.mechanics.length,canMoods=left.moods.length&&right.moods.length,forecastA=savedForecast(film),forecastB=savedForecast(other);if(!canMechanics&&!canMoods&&!rows.length&&!forecastA&&!forecastB)return '<p class="film-missing">Сравнить нельзя: у фильмов нет общих групп сохранённых характеристик. Неизвестные значения не считаются различием.</p>';const chips=(ids,label)=>ids.map(id=>`<span class="film-compare-chip">${escapeHTML(label(id))}</span>`).join('');const blocks=[];if(canMechanics)blocks.push(`<div class="film-compare-block"><h3>Общая механика</h3>${sharedMechanics.length?`<div class="film-chips">${chips(sharedMechanics,id=>MECHANIC_LABELS[id])}</div>`:'<p class="film-missing">Общих механик нет</p>'}</div>`);if(canMoods)blocks.push(`<div class="film-compare-block"><h3>Общее настроение</h3>${sharedMoods.length?`<div class="film-chips">${chips(sharedMoods,moodLabel)}</div>`:'<p class="film-missing">Общих настроений нет</p>'}</div>`);const rankClass=mark=>mark==='лучше'?' is-better':mark==='хуже'?' is-worse':'';const cell=(value,mark)=>`<td>${value?`${escapeHTML(value)}${mark?`<small class="film-compare-rank${rankClass(mark)}">${mark}</small>`:''}`:'нет данных'}</td>`;const forecastCell=value=>value?`<td><strong class="film-compare-score">${escapeHTML(value)}</strong></td>`:'<td class="is-missing">нет данных</td>';const forecast=forecastA||forecastB?`<tr class="film-compare-forecast"><th scope="row">Мой прогноз</th>${forecastCell(forecastA)}${forecastCell(forecastB)}</tr>`:'';const body=rows.map(row=>`<tr class="${row.kind}"><th scope="row">${escapeHTML(row.label)}</th>${cell(row.a,row.markA)}${cell(row.b,row.markB)}</tr>`).join('');const matrix=forecast||body?`<table class="film-compare-matrix"><thead><tr><th scope="col">Характеристика</th><th scope="col">${escapeHTML(filmCompareLabel(film))}</th><th scope="col"><button type="button" class="film-compare-open" data-compare-open="${escapeHTML(String(other.id))}">${escapeHTML(filmCompareLabel(other))}</button></th></tr></thead><tbody>${forecast}${body}</tbody></table>`:'';return `<div class="film-compare-body">${blocks.join('')}${matrix}</div>`;}

// AIR-436: the film page «Показы» block. State and per-show phases come only from the shared lifecycle (ADR 0114): `filmAvail` for the film and
// `FilmAvailability.showPhase` for each show, both with the film runtime. The block lists the shows the programme window still holds (`availableShows`) and reads the
// state of exactly those, so the pill never contradicts its own list. It claims no archive from `start <= now` alone, and the «до» of an archive is the 72 h counted from
// the show START; an expected archive time is a schedule-based calculation, never a provider check.
const FILM_SHOW_CAP=3;
function filmShowInfo(film,show,now){const lib=availabilityLib();return lib?lib.showPhase({start:show.start,end:show.end},now,{runtimeMinutes:film?.runtime}):null;}
function filmShowRow(show,info,{until=false}={}){
 const phase=info?.phase||'',hm={hour:'2-digit',minute:'2-digit'};
 let note='';
 if(phase==='on_air')note=`<span class="show-phase">В эфире${info.end!==null?` до ${madridStamp(info.end,hm)}`:''}</span>`;
 else if(phase==='unknown')note='<span class="show-phase">Окончание неизвестно</span>';
 else if(phase==='archive'&&until)note=`<span class="show-phase">архив до ${madridStamp(show.start+72*3600000)}</span>`;
 return `<div class="show-row${phase?` is-${phase.replace('_','-')}`:''}"${phase?` data-phase="${phase}"`:''}>${channelControl(show)}<time class="show-time" datetime="${new Date(show.start).toISOString()}">${madridStamp(show.start,{day:'numeric',month:'short'})}<b>${madridStamp(show.start,hm)}</b></time>${note}</div>`;
}
function filmShowGroup(title,kind,rows,cap=FILM_SHOW_CAP){
 if(!rows.length)return '';
 const rest=rows.slice(cap);
 return `<section class="film-show-group is-${kind}" aria-label="${title}"><h3>${title}${rows.length>1?` <span>${rows.length}</span>`:''}</h3><div class="film-show-list">${rows.slice(0,cap).join('')}${rest.length?`<details class="more"><summary>Ещё ${rest.length} ${showWord(rest.length)}</summary>${rest.join('')}</details>`:''}</div></section>`;
}
function filmAvailabilityHead(avail,now,count){
 if(!avail)return '';
 const pill=`<span class="film-avail-pill is-${avail.state}">${escapeHTML(avail.label)}</span>`;
 let note='',hint='';
 if(avail.state==='available'){
  const until=avail.archiveUntil,left=until-now;
  note=`<p class="film-fact">Архив доступен до <time datetime="${new Date(until).toISOString()}">${escapeHTML(madridStamp(until))}</time></p>${left>0&&left<8*3600000?lastChanceMark(until):''}`;
 }else if(avail.state==='soon'){
  note=`<p class="film-fact">${escapeHTML(showFacetValue(soonTail(avail)))}</p>`;
  hint='<p class="film-hint">Расчёт по расписанию: наличие записи у провайдера не проверяется.</p>';
 }else note=`<p class="film-fact">${count?'Готового архива нет':'Нет показов в текущем окне программы'}</p>`;
 return `<div class="film-avail-head" data-availability="${avail.state}">${pill}${note}</div>${hint}`;
}
function filmAvailability(film){
 const now=viewingClock(),shows=availableShows(film,now),avail=filmAvail(film,now,shows),infos=shows.map(show=>filmShowInfo(film,show,now));
 const by=phase=>shows.map((show,i)=>({show,info:infos[i]})).filter(item=>(item.info?.phase||'')===phase);
 const archive=by('archive'),future=by('future'),live=[...by('on_air'),...by('unknown')];
 const render=(items,until=false)=>items.map(item=>filmShowRow(item.show,item.info,{until}));
 let body='';
 if(shows.length===1&&avail)body=`<div class="film-show-list">${render(archive.concat(live,future),false).join('')}</div>`;
 else if(!avail)body=shows.length?`<div class="film-show-list">${shows.map(show=>filmShowRow(show,null)).join('')}</div>`:'<p class="film-missing">Нет показов в текущем окне программы</p>';
 else body=filmShowGroup('Архив','archive',render(archive,archive.length>1))+filmShowGroup('В эфире','live',render(live))+filmShowGroup(avail.state==='available'?'Повтор в эфире':'Дальше','future',render(future),avail.state==='available'?1:FILM_SHOW_CAP);
 return `<section class="film-section film-availability" aria-label="Показы"><h2>Показы</h2>${filmAvailabilityHead(avail,now,shows.length)}${body}</section>`;
}
function refreshFilmAvailability(){const node=$('#film-screen-availability'),film=typeof currentFilm==='function'?currentFilm():null;if(node&&film)node.innerHTML=filmAvailability(film);}
// Film timeline: predictions, rating observations and Diary viewings of one film, read on demand from the read-only
// GET /api/enrichment/history (contract: docs/reference/api/film-history.md). The rest of the page renders without it,
// and a failure stays inside this section. Shown in the API's order; nothing is merged, filled or invented here.
const FILM_HISTORY_PAGE=100,FILM_HISTORY_MAX_PAGES=20,FILM_HISTORY_RESTARTS=2,FILM_HISTORY_VISIBLE=8;
let filmHistory={filmId:null,status:'idle',events:[],data:null,error:null,truncated:false,token:0};
const HISTORY_SOURCES={owner:'вручную',letterboxd_export:'экспорт Letterboxd',letterboxd_films_list:'список фильмов Letterboxd',letterboxd_film_page:'страница фильма Letterboxd',letterboxd_member_film:'страница фильма Letterboxd',letterboxd_public_films:'список фильмов Letterboxd',letterboxd_diary:'Diary Letterboxd'};
const HISTORY_NOTES={
 prediction_lineage_unknown:'У части прогнозов не сохранено, каким запуском и версией промпта они сделаны.',
 prediction_without_time:'У части прогнозов нет времени создания — они в конце хронологии.',
 rating_history_starts_after_current_value:'Текущая оценка поставлена до начала записи истории: её более ранние изменения неизвестны.',
 first_observed_is_not_a_rating_date:'«Впервые замечена» — дата наблюдения, а не дата, когда поставлена оценка.',
 diary_absence_is_not_unwatched:'Нет записи в Diary — не значит, что фильм не смотрели; нет истории оценок — не значит, что оценки не было.',
 diary_history_missing:'История Diary ещё не сохранена.',
 diary_history_unreadable:'История Diary не читается — просмотры не показаны.',
 diary_coverage_partial:'Diary прочитан не полностью: более ранние просмотры могут отсутствовать.',
 diary_unlinked:'У фильма нет подтверждённого Letterboxd lid — просмотры Diary не привязаны.',
 diary_identity_disagreement:'Идентификаторы Letterboxd расходятся — просмотры Diary не показаны, чтобы не подставить чужую историю.',
 diary_viewings_lower_bound:'Число просмотров за некоторые дни — нижняя граница.',
 diary_rewatch_unknown:'Для части записей неизвестно, был ли это пересмотр.',
 diary_entry_without_date:'У части записей Diary нет даты — они в конце хронологии.',
 diary_same_day_order_unknown:'Просмотр стоит после событий того же дня: время просмотра неизвестно.',
 diary_entries_may_overlap:'Записи Diary с номером просмотра и без него за один день могут описывать один и тот же просмотр.'};
function viewingWord(n){return n%10===1&&n%100!==11?'просмотр':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'просмотра':'просмотров';}
const historyRating=value=>Number.isFinite(value)?Number(value).toFixed(1):'без оценки';
// An instant in Madrid time; a Diary calendar day as written, never shifted by a time zone.
function historyInstant(value){const ms=Date.parse(value);return Number.isFinite(ms)?`<time datetime="${escapeHTML(new Date(ms).toISOString())}">${escapeHTML(madridStamp(ms,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}))}</time>`:'';}
function historyDay(value){const day=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);if(!day)return '';return `<time datetime="${escapeHTML(value)}">${escapeHTML(new Intl.DateTimeFormat('ru',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'}).format(new Date(Date.UTC(+day[1],day[2]-1,+day[3]))))}</time>`;}
// A Diary rating observation is dated at the entry's watched date (midnight UTC): shown as that day, not as a time.
const historyObserved=(value,source)=>source==='letterboxd_diary'&&typeof value==='string'?historyDay(value.slice(0,10)):historyInstant(value);
const historySource=value=>value==null?'источник неизвестен':escapeHTML(HISTORY_SOURCES[value]||value);
function historyPredictionEvent(event,current){
 const chance=Number.isFinite(event.probability4Plus)?`шанс 4.0+ ${Math.round(event.probability4Plus*100)}%`:'',confidence=confidenceText(event.confidence);
 const version={linked:'версия подтверждена',none:'без неизменяемой версии',missing:'версия не найдена',mismatch:'версия не совпадает',invalid:'неверная ссылка на версию'}[event.version?.status]||'';
 const signals=(Array.isArray(event.matchSignals)?event.matchSignals:[]).filter(item=>typeof item==='string'&&item.trim());
 const moods=(Array.isArray(event.moodLabels)?event.moodLabels:[]).map(item=>MOOD_LABELS[item]||item);
 const lineage=[event.tasteProfileVersion!=null?`модель вкуса v${event.tasteProfileVersion}`:'',event.fingerprintSchemaVersion!=null?`отпечаток v${event.fingerprintSchemaVersion}`:'',event.predictionPromptVersion!=null?`промпт v${event.predictionPromptVersion}`:'',event.trigger==='scheduled'?'по расписанию':event.trigger==='manual'?'вручную':''].filter(Boolean);
 return `<p class="history-headline"><strong>Прогноз ${Number.isFinite(event.predictedRating)?Number(event.predictedRating).toFixed(1):'—'}</strong>${chance?` · ${chance}`:''}${confidence?` · уверенность ${escapeHTML(confidence)}`:''}</p>`
  +(signals.length?`<p><span class="history-label">Совпадает со вкусом</span> ${signals.map(escapeHTML).join(', ')}</p>`:'')
  +(typeof event.mainRisk==='string'&&event.mainRisk.trim()?`<p><span class="history-label">Основной риск</span> ${escapeHTML(event.mainRisk.trim())}</p>`:'')
  +(moods.length?`<p><span class="history-label">Настроение</span> ${moods.map(escapeHTML).join(', ')}</p>`:'')
  +`<p class="history-meta">${[...lineage.map(escapeHTML),version?`<span class="${['missing','mismatch','invalid'].includes(event.version?.status)?'history-warn':''}">${version}</span>`:'',event.replacedAt?`заменён ${historyInstant(event.replacedAt)}`:'',current&&current.matchesCurrentProfile===false?'<span class="history-warn">сделан для прежней модели вкуса</span>':''].filter(Boolean).join(' · ')}</p>`
  +(Array.isArray(event.missingFields)&&event.missingFields.length?`<p class="history-meta">Не сохранено в этой версии: ${event.missingFields.map(escapeHTML).join(', ')}</p>`:'');
}
function historyRatingEvent(event){
 const observed=event.observedAt?` · ${event.source==='letterboxd_diary'?'дата просмотра':'замечена'} ${historyObserved(event.observedAt,event.source)}`:'';
 if(event.kind==='rolled_back')return `<p class="history-headline"><strong>Наблюдение оценки отменено</strong>${event.restored?` · восстановлена ${historyRating(event.restored.value)} (${historySource(event.restored.source)})`:''}</p>`;
 const head=event.kind==='first_observed'?`Оценка ${historyRating(event.value)} впервые замечена`:event.kind==='changed'&&event.previous?`Оценка ${historyRating(event.previous.value)} → ${historyRating(event.value)}`:`Оценка ${historyRating(event.value)}`;
 return `<p class="history-headline"><strong>${head}</strong></p><p class="history-meta">${historySource(event.source)}${observed}</p>`;
}
// A legacy log entry is what one check saw before and after, not proof of a change: an arrow only for two different values,
// and a missing value is "not found at that check", never "removed" or "not watched".
function historyLegacyEvent(event){
 const before=Number.isFinite(event.before)?event.before:null,after=Number.isFinite(event.after)?event.after:null;
 const head=before===null&&after===null?'При проверке оценка не зафиксирована'
  :before===null?`Зафиксирована оценка ${historyRating(after)} (ранее данных не было)`
  :after===null?`При проверке оценка не обнаружена (ранее ${historyRating(before)})`
  :before===after?`Повторно зафиксирована оценка ${historyRating(after)}`
  :`Оценка ${historyRating(before)} → ${historyRating(after)}`;
 return `<p class="history-headline"><strong>${head}</strong></p><p class="history-meta">старый журнал наблюдений · ${historySource(event.source)}</p>`;
}
function historyDiaryEvent(event){
 const count=Number.isInteger(event.viewings)?event.viewings:null,lower=event.viewingsCertain!==true;
 const title=count>1?`${count}${lower?'+':''} ${viewingWord(count)} за день`:event.rewatch===true?'Пересмотр':'Просмотр';
 const ratings=count>1&&Array.isArray(event.ratingsAtEntry)?`оценки в записях: ${event.ratingsAtEntry.map(historyRating).join(', ')}`:`оценка в записи: ${historyRating(event.ratingAtEntry)}`;
 const rewatch=count>1&&Number.isInteger(event.rewatchRows)?`пересмотров ${event.rewatchRows}${event.rewatchUnknownRows?`, без отметки ${event.rewatchUnknownRows}`:''}`:event.rewatch==='unknown'?'пересмотр: неизвестно':event.rewatch===false?'не пересмотр':'';
 const changes=(Array.isArray(event.changes)?event.changes:[]).filter(change=>change.field==='ratingAtEntry'||change.field==='rewatch'||change.field==='viewings');
 const changeValue=(field,value)=>field==='ratingAtEntry'?historyRating(value):field==='rewatch'?(value===true?'да':value===false?'нет':'неизвестно'):escapeHTML(String(value));
 const changeText=changes.map(change=>`${change.field==='ratingAtEntry'?'оценка':change.field==='rewatch'?'пересмотр':'просмотры'}: ${changeValue(change.field,change.from)} → ${changeValue(change.field,change.to)}${change.observedAt?` (${historyInstant(change.observedAt)})`:''}`);
 const slugs=(Array.isArray(event.slugs)?event.slugs:[]).map(slug=>escapeHTML(slug.value)).filter(Boolean);
 return `<p class="history-headline"><strong>${title}</strong>${lower&&count===1?' · <span class="history-warn">возможно, больше</span>':''}</p>`
  +`<p>${escapeHTML(ratings)}${rewatch?` · ${escapeHTML(rewatch)}`:''}</p>`
  +(changeText.length?`<p class="history-meta">Изменения записи: ${changeText.join('; ')}</p>`:'')
  +`<p class="history-meta">Diary · lid ${escapeHTML(event.lid||'—')}${slugs.length?` · slug ${slugs.join(', ')}`:''}${event.observedAt?` · прочитано ${historyInstant(event.observedAt)}`:''}</p>`;
}
const HISTORY_TYPES={prediction:'Прогноз',rating:'Оценка',legacy_rating:'Оценка',diary_viewing:'Diary'};
function historyEventHTML(event,currentIds,current){
 const when=event.atPrecision==='day'?(historyDay(event.at)||'дата неизвестна'):(historyInstant(event.at)||'время неизвестно');
 const body=event.type==='prediction'?historyPredictionEvent(event,currentIds.has(event.identity)?current.prediction:null):event.type==='rating'?historyRatingEvent(event):event.type==='legacy_rating'?historyLegacyEvent(event):event.type==='diary_viewing'?historyDiaryEvent(event):'';
 if(!body)return '';
 const isCurrent=currentIds.has(event.identity);
 return `<li class="history-event history-${escapeHTML(event.type)}${isCurrent?' is-current':''}"><div class="history-when"><span class="history-type">${HISTORY_TYPES[event.type]}</span>${when}${isCurrent?'<span class="history-current">сейчас</span>':''}</div><div class="history-body">${body}</div></li>`;
}
// The current prediction is the bundle's current record; the current rating is the last event that applied its observation.
function historyCurrentIds(events,current){
 const ids=new Set(),prediction=events.find(event=>event.type==='prediction'&&event.position==='current');if(prediction)ids.add(prediction.identity);
 const observation=current?.rating?.observationId;
 if(observation){const applied=events.filter(event=>event.type==='rating'&&event.kind!=='rolled_back'&&event.observationId===observation).at(-1);if(applied)ids.add(applied.identity);}
 return ids;
}
function historySummary(data,events){
 const current=data.current||{},prediction=events.find(event=>event.type==='prediction'&&event.position==='current'),diary=current.diary,source=data.snapshot?.sources?.diary;
 const forecast=prediction&&Number.isFinite(prediction.predictedRating)?`${Number(prediction.predictedRating).toFixed(1)}${prediction.generatedAt?` · ${historyInstant(prediction.generatedAt)}`:''}`:'не сохранён';
 const rating=current.rating?`${historyRating(current.rating.value)} · ${historySource(current.rating.source)}${current.rating.observedAt?` · ${current.rating.source==='letterboxd_diary'?'дата просмотра':'замечена'} ${historyObserved(current.rating.observedAt,current.rating.source)}`:''}`:'наблюдений нет';
 const diaryText=diary?(diary.viewingCount?`${diary.viewingCount}${diary.viewingCountExact?'':'+'} ${viewingWord(diary.viewingCount)}${diary.lastWatchedAt?` · последний ${historyDay(diary.lastWatchedAt)}`:''}${diary.rewatches||!diary.rewatchesExact?` · пересмотров ${diary.rewatches}${diary.rewatchesExact?'':'+'}`:''}`:'записей нет')
  :source?.status==='missing'?'история Diary не сохранена':source?.status==='unreadable'?'история Diary не читается':source?.link?.status==='ambiguous'?'не показан: идентификаторы расходятся':source?.link?.status==='unlinked'?'не привязан к фильму':'нет данных';
 return `<dl class="history-summary"><div><dt>Прогноз</dt><dd>${forecast}</dd></div><div><dt>Оценка</dt><dd>${rating}</dd></div><div><dt>Diary</dt><dd>${diaryText}</dd></div></dl>`;
}
function filmHistoryBody(){
 const {events,data}=filmHistory,current=data.current||{},currentIds=historyCurrentIds(events,current);
 const items=events.map(event=>historyEventHTML(event,currentIds,current)).filter(Boolean),hidden=Math.max(0,items.length-FILM_HISTORY_VISIBLE);
 const notes=(Array.isArray(data.notes)?data.notes:[]).map(note=>`<li>${escapeHTML(HISTORY_NOTES[note]||note)}</li>`).join('');
 const list=!items.length?'<p class="film-missing">Событий в истории нет</p>'
  :`${hidden?`<details class="history-earlier"><summary>Ранние события · ${hidden}</summary><ol class="history-list">${items.slice(0,hidden).join('')}</ol></details>`:''}<ol class="history-list"${hidden?` start="${hidden+1}"`:''}>${items.slice(hidden).join('')}</ol>`;
 return historySummary(data,events)
  +(data.partial?'<p class="history-warn" role="status">История неполная: часть источников или версий не прочитана.</p>':'')
  +(filmHistory.truncated?'<p class="history-warn" role="status">Показана только начальная часть длинной истории.</p>':'')
  +list+(notes?`<details class="history-notes"><summary>Ограничения данных</summary><ul>${notes}</ul></details>`:'');
}
function filmHistorySection(film){
 const id=String(film.id),valid=/^[a-zA-Z0-9_-]{1,80}$/.test(id),mine=filmHistory.filmId===id;
 const head='<h2 tabindex="-1">История</h2>';
 if(!valid)return `<section class="film-section film-history" aria-label="История">${head}<p class="film-missing">История недоступна для этого идентификатора</p></section>`;
 if(!mine||filmHistory.status==='idle')return `<section class="film-section film-history" aria-label="История">${head}<p class="film-missing">Прогнозы, изменения оценки и просмотры из Diary в одной хронологии.</p><button type="button" class="history-action" data-history-action="open">Показать историю</button></section>`;
 if(filmHistory.status==='loading')return `<section class="film-section film-history" aria-label="История" aria-busy="true">${head}<p class="film-missing" role="status">Загружаем историю…</p></section>`;
 if(filmHistory.status==='error')return `<section class="film-section film-history" aria-label="История">${head}<p class="film-missing" role="alert">${filmHistory.error===409?'История менялась во время чтения.':filmHistory.error===400||filmHistory.error===404?'История для этого фильма недоступна.':'Не удалось загрузить историю.'}</p><button type="button" class="history-action" data-history-action="open">Повторить</button></section>`;
 return `<section class="film-section film-history" aria-label="История">${head}${filmHistoryBody()}<button type="button" class="history-action" data-history-action="close">Скрыть историю</button></section>`;
}
function renderFilmHistory(){const film=currentFilm();if(film)setFilmHtml('film-screen-history',filmHistorySection(film));}
// Reads every page of one consistent version: a 409 (the history changed between pages) restarts from the first page
// and never mixes two versions. Events are kept once per identity. A newer request or another film discards this one.
async function loadFilmHistory(filmId){
 const token=++filmHistory.token;
 filmHistory={...filmHistory,filmId,status:'loading',events:[],data:null,error:null,truncated:false};renderFilmHistory();
 try{
  for(let restarts=0;;restarts++){
   const seen=new Map();let cursor=null,data=null,pages=0,changed=false;
   do{
    const response=await fetch('/api/enrichment/history?filmId='+encodeURIComponent(filmId)+'&limit='+FILM_HISTORY_PAGE+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    if(token!==filmHistory.token)return;
    if(response.status===409&&cursor){changed=true;break;}
    if(!response.ok)throw {status:response.status};
    const page=await response.json();
    if(token!==filmHistory.token)return;
    if(!page||!Array.isArray(page.events)||!page.page)throw {status:null};
    data=data?{...data,notes:page.notes,partial:data.partial||page.partial}:page;
    for(const event of page.events)if(event&&typeof event.identity==='string'&&!seen.has(event.identity))seen.set(event.identity,event);
    cursor=page.page.nextCursor||null;pages++;
   }while(cursor&&pages<FILM_HISTORY_MAX_PAGES);
   if(changed){if(restarts>=FILM_HISTORY_RESTARTS)throw {status:409};continue;}
   filmHistory={...filmHistory,status:'ready',events:[...seen.values()],data,truncated:!!cursor};
   break;
  }
 }catch(error){if(token!==filmHistory.token)return;filmHistory={...filmHistory,status:'error',events:[],data:null,error:error?.status??null};}
 renderFilmHistory();
 // The pressed button is gone: keep keyboard focus in the section, on its heading.
 if(String(currentFilm()?.id??'')===String(filmId))$('#film-screen-history h2')?.focus?.({preventScroll:true});
}
function filmHistoryAction(action){
 if(!filmScreen)return;
 if(action==='open'){const film=currentFilm();return film?loadFilmHistory(String(film.id)):undefined;}
 if(action==='close'){filmHistory={...filmHistory,token:filmHistory.token+1,status:'idle',events:[],data:null};renderFilmHistory();$('#film-screen-history [data-history-action]')?.focus?.({preventScroll:true});}
}
// The film page poster with the shared «Скоро» badge over all of the film's shows; also refreshed on its own when the clock moves a film out of `soon`.
function filmPosterHTML(film){return (film.poster?`<img class="film-page-poster" src="${escapeHTML(film.poster)}" alt="Постер ${escapeHTML(film.original||film.title||'')}" width="220" height="330" referrerpolicy="no-referrer">`:`<div class="film-page-poster no-poster" aria-label="Постер недоступен">${escapeHTML(film.year||'Кино')}</div>`)+soonBadge(film);}
function refreshFilmPoster(){const poster=$('#film-poster'),film=typeof currentFilm==='function'?currentFilm():null;if(poster&&film)poster.innerHTML=filmPosterHTML(film);}
function fillFilmPage(film){const poster=$('#film-poster'),original=$('#film-screen-original'),meta=$('#film-screen-meta'),genres=$('#film-screen-genres'),actions=$('#film-screen-actions');if(!film){for(const id of ['film-poster','film-screen-original','film-screen-meta','film-screen-genres','film-screen-actions','film-screen-score','film-screen-history','film-screen-synopsis','film-screen-credits','film-screen-fingerprint','film-compare-result','film-screen-availability','film-similar-cards'])setFilmHtml(id,'');const similar=$('#film-similar');if(similar)similar.hidden=true;similarMarkup='';{const compare=$('#film-compare');if(compare)compare.hidden=false;}if(original)original.textContent='';if(meta)meta.textContent='';if(genres)genres.textContent='';return;}if(poster)poster.innerHTML=filmPosterHTML(film);if(original)original.textContent=film.original&&film.original!==film.title?film.original:'';const bits=[];if(film.year)bits.push(String(film.year));if(Number(film.runtime)>0)bits.push(`${Math.round(Number(film.runtime))} мин`);if(meta)meta.textContent=bits.join(' · ');if(genres)genres.textContent=(film.genres||[]).filter(Boolean).join(' · ');const catalogRoute=!!film.catalogRoute,compare=$('#film-compare');if(compare)compare.hidden=catalogRoute;if(actions)actions.innerHTML=`${letterboxdLink(film,{catalog:catalogRoute})}${catalogRoute?'':startedButton(film,true)}`;setFilmHtml('film-screen-score',filmScore(film));setFilmHtml('film-screen-history',filmHistorySection(film));setFilmHtml('film-screen-synopsis',catalogRoute?'':filmSynopsis(film));setFilmHtml('film-screen-credits',filmCredits(film));setFilmHtml('film-screen-fingerprint',filmFingerprint(film));setFilmHtml('film-compare-result',catalogRoute?'':filmCompare(film));setFilmHtml('film-screen-availability',filmAvailability(film));renderSimilar();}
function creditLinks(people,key){return (people||[]).map(p=>`<button type="button" class="credit-link" data-credit-kind="${key}" data-credit-id="${escapeHTML(p.id)}" title="Показать фильмы: ${escapeHTML(p.name)}">${escapeHTML(p.name)}</button>`).join(', ');}
function credits(film){return `<div class="film-credits">${film.directors?.length?`<p><span class="credit-label">${film.directors.length>1?'Режиссёры':'Режиссёр'}</span> ${creditLinks(film.directors,'directors')}</p>`:''}${film.actors?.length?`<p><span class="credit-label">В ролях</span> ${creditLinks(film.actors,'actors')}</p>`:''}</div>`;}
function selectPerson(key,id){const p=report.people?.[key]?.find(person=>person.id===id);if(!p)return;const onFilm=filmIdFromLocation();state[key]=id;const input=$('#'+key+'-input');if(input){input.value=p.name;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}const options=$('#'+key+'-options');if(options)options.hidden=true;render();if(onFilm)input?.focus?.({preventScroll:true});}
function synopsis(film){
 const text=String(film.synopsis||'').trim();if(!text)return '';
 const max=280;if(text.length<=max)return `<p class="film-synopsis">${escapeHTML(text)}</p>`;
 const cut=text.slice(0,max).lastIndexOf(' '),short=text.slice(0,cut>180?cut:max).trimEnd();
 return `<details class="film-synopsis"><summary><span>${escapeHTML(short)}…</span><strong>Читать полностью</strong></summary><p>${escapeHTML(text)}</p></details>`;
}
function personal(film){const item=filmEnrichmentItem(film),actual=Number.isFinite(item.actualRating),prediction=item.prediction;return {rating:actual?item.actualRating:Number.isFinite(prediction?.predictedRating)?prediction.predictedRating:null,actual,probability:Number.isFinite(prediction?.probability4Plus)?prediction.probability4Plus:0};}
// P(4.0+) as a whole percent, only for a current forecast with a finite probability in [0, 1]; otherwise null.
function chance4Plus(prediction){const value=prediction?.probability4Plus;return Number.isFinite(prediction?.predictedRating)&&Number.isFinite(value)&&value>=0&&value<=1?Math.round(value*100):null;}
function recommendation(film){
 const item=filmEnrichmentItem(film),p=item.prediction,actual=item.actualRating;
 if(actual===null||actual===undefined){if(!p)return '';}
 const actualBadge=actual===null||actual===undefined?'':`<div class="score-badge score-actual" aria-label="Моя оценка ${Number(actual).toFixed(1)} из 5"><span>МОЯ ОЦЕНКА</span><strong>${Number(actual).toFixed(1)}</strong></div>`;
 const chance=p&&!p.stale?chance4Plus(p):null;
 const predictedBadge=p?`<div class="score-badge score-predicted${p.stale?' is-stale':''}" aria-label="Прогноз ${Number(p.predictedRating).toFixed(1)} из 5${p.stale?', ожидает пересчёта':chance===null?'':`, шанс оценки 4 и выше ${chance}%`}"><span>ПРОГНОЗ</span><strong>${Number(p.predictedRating).toFixed(1)}</strong>${p.stale?'<small>ожидает пересчёта</small>':chance===null?'':`<small>${chance}% на 4.0+</small>`}</div>`:'';
 return `<div class="film-score-badges">${actualBadge}${predictedBadge}</div>`;
}
function presentationGroups(film){const item=filmEnrichmentItem(film);if(Array.isArray(item.moodGroups))return item.moodGroups.filter(group=>Array.isArray(group)).map(group=>group.filter(id=>Object.hasOwn(MOOD_LABELS,id)));return [...filmFacets(film).moods].map(id=>[id]);}
function presentationChips(film){
 const lists={tone:[],theme:[],style:[],property:[]},seen={tone:new Set(),theme:new Set(),style:new Set(),property:new Set()};
 for(const ids of presentationGroups(film)){const same=new Set(ids),list=same.has('funny')&&same.has('black_humor')?ids.filter(id=>id!=='funny'):ids;for(const id of list){const bucket=moodBucket(id);if(!bucket||seen[bucket].has(id))continue;seen[bucket].add(id);lists[bucket].push(id);}}
 const genres=new Set(film.genres||[]);
 let themes=lists.theme;
 if(lists.tone.length)themes=themes.filter(id=>id!=='family');
 if(genres.has('Военный'))themes=themes.filter(id=>id!=='military');
 if(genres.has('Исторический'))themes=themes.filter(id=>id!=='historical');
 const chips=[];
 if(genres.has('Телефильм'))chips.push({bucket:'format',label:'Телефильм'});
 const mechanic=(filmEnrichmentItem(film).fingerprint?.plotMechanics||[]).find(id=>Object.hasOwn(MECHANIC_LABELS,id));
 if(mechanic)chips.push({bucket:'mechanic',id:mechanic,label:MECHANIC_LABELS[mechanic]});
 if(themes[0])chips.push({bucket:'theme',id:themes[0],label:moodLabel(themes[0])});
 if(lists.style[0])chips.push({bucket:'style',id:lists.style[0],label:moodLabel(lists.style[0])});
 if(lists.property[0])chips.push({bucket:'property',id:lists.property[0],label:moodLabel(lists.property[0])});
 if(lists.tone[0])chips.push({bucket:'tone',id:lists.tone[0],label:moodLabel(lists.tone[0])});
 if(chips.length===1&&chips[0].bucket==='theme'&&GENERIC_THEME_IDS.has(chips[0].id))return [];
 return chips.slice(0,3);
}
function moodTags(film){const chips=presentationChips(film);return chips.length?`<div class="film-moods">${chips.map(chip=>`<span data-chip-bucket="${escapeHTML(chip.bucket)}"${chip.id?` data-chip-id="${escapeHTML(chip.id)}"`:''}>${escapeHTML(chip.label)}</span>`).join('')}</div>`:'';}
function lastChanceMark(until){
 const label=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(until));
 return `<span class="last-chance-badge" title="До ${escapeHTML(label)}" aria-label="Последний шанс: до ${escapeHTML(label)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Последний шанс</span>`;
}
function lastChanceBadge(film){
 if(!isLastChance(film))return '';
 return lastChanceMark(availabilityTime(film));
}
function card(film){
 const item=filmEnrichmentItem(film),hasScore=item.actualRating!==null&&item.actualRating!==undefined||!!item.prediction;
 return `<article class="movie-card${startedIds.has(String(film.id))?' is-started':''}${hasScore?' has-score':''}" data-film-id="${escapeHTML(film.id)}">${recommendation(film)}<div class="film-head">${posterFrame(film.poster?`<img class="poster" src="${escapeHTML(film.poster)}" alt="Постер ${escapeHTML(film.original)}" width="78" height="117" loading="lazy" referrerpolicy="no-referrer">`:`<div class="poster no-poster" aria-label="Постер недоступен">${film.year||"Кино"}</div>`,soonBadge(film))}<div class="film-info"><h3><a class="film-open" href="${filmPath(film)}" data-film-id="${escapeHTML(filmPermalinkId(film))}">${escapeHTML(film.title)}</a>${letterboxdLink(film)}</h3><p class="original">${escapeHTML(film.original)}</p><span class="film-year">${film.year}${film.runtime?` · ${Math.round(film.runtime)} мин`:''}</span><div class="film-tags">${film.genres.map(escapeHTML).join(' · ')}</div>${lastChanceBadge(film)}</div></div>${moodTags(film)}${synopsis(film)}${credits(film)}<div class="screenings">${state.period!=='future'?group(film,'archive'):''}${state.period!=='archive'?group(film,'future'):''}</div>${!periodShows(film,'all').length?'<p class="archive-only">Нет показов в текущем окне программы</p>':state.period==='all'&&!film.shows.some(isFuture)?'<p class="archive-only">В следующие сутки показов нет</p>':''}${startedButton(film)}</article>`;
}
function visibleFilms(){const now=nowMs();return films.filter(eligible).filter(f=>inSelectedScope(f)).sort((a,b)=>{const title=a.title.localeCompare(b.title,'ru',{sensitivity:'base'})||String(a.id).localeCompare(String(b.id));if(state.sort==='title')return title;if(state.sort==='relevance'){const parsed=searchTokens(state.query);const rank=item=>{const value=searchRank(item,parsed.normalized,parsed.tokens);return value===null?99:value;};return rank(a)-rank(b)||title;}if(state.sort==='personal'){const x=personal(a),y=personal(b);if(x.rating===null)return y.rating===null?title:1;if(y.rating===null)return -1;return y.rating-x.rating||Number(y.actual)-Number(x.actual)||y.probability-x.probability||title;}if(state.sort==='expiring'){const deadline=f=>{const time=availabilityTime(f);return time!==null&&time>now?time:Infinity;};return deadline(a)-deadline(b)||title;}return title;});}

function shortlistDay(time){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));}
function shortlistAvailability(film,mode='now',now=viewingClock()){
 const model=viewingWindow(now);
 const selected=(film.shows||[]).map(show=>({...show,start:showStart(show)})).filter(show=>show.start!==null&&(inArchive(model,show)||inFuture(model,show)));
 const current=selected.filter(show=>show.start<=now&&finiteTime(show.end)!==null&&show.end>now).sort((a,b)=>a.start-b.start);
 const catchup=selected.filter(show=>show.start<=now).sort((a,b)=>b.start-a.start);
 const future=selected.filter(show=>show.start>now&&shortlistDay(show.start)===shortlistDay(now)).sort((a,b)=>a.start-b.start);
 const show=current[0]||catchup[0]||(mode==='today'?future[0]:null),kind=current.length?'current':catchup.length?'catchup':mode==='today'&&future.length?'future':'unavailable';
 if(show)return {available:true,kind,show,archiveUntil:catchup.length?Math.max(...catchup.map(s=>s.start))+72*3600000:null,until:availabilityTime(film,now)};
 if(mode==='today'&&state.includeUnscheduled&&!periodShows(film,'all').length)return {available:false,kind:'unavailable',show:null,until:null};
 return null;
}
function shortlistCompare(a,b){const x=personal(a),y=personal(b);return (y.rating??-Infinity)-(x.rating??-Infinity)||Number(y.actual)-Number(x.actual)||(!x.actual&&!y.actual?y.probability-x.probability:0)||a.title.localeCompare(b.title,'ru',{sensitivity:'base'})||String(a.id).localeCompare(String(b.id));}
function buildShortlist(input=visibleFilms(),mode=state.shortlistMode,now=nowMs()){
 const candidates=input.filter(eligible).filter(f=>inSelectedScope(f)).map(f=>({film:f,availability:shortlistAvailability(f,mode,now)})).filter(x=>x.availability&&personal(x.film).rating!==null).sort((a,b)=>shortlistCompare(a.film,b.film));
 const seen=new Set(),unique=candidates.filter(x=>{const id=String(x.film.tmdbId||x.film.id);if(seen.has(id))return false;seen.add(id);return true;});if(!unique.length)return [];
 const best=personal(unique[0].film).rating,strong=Math.max(3.5,best-.5),runtimes=unique.map(x=>Number(x.film.runtime)).filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b),shortLimit=runtimes.length?runtimes[Math.floor((runtimes.length-1)*.25)]:0;
 const roles=[
  {id:'best',accept:()=>true,reason:x=>personal(x.film).actual?'сильный пересмотр':'лучший прогноз'},
  {id:'last_chance',accept:x=>x.availability.available&&x.availability.kind!=='future'&&x.availability.until>now&&x.availability.until-now<8*3600000&&personal(x.film).rating>=3.5,reason:()=> 'последний шанс'},
  {id:'started',accept:x=>startedIds.has(String(x.film.id)),reason:()=> 'продолжить'},
  {id:'short',accept:x=>Number(x.film.runtime)>0&&Number(x.film.runtime)<=shortLimit&&personal(x.film).rating>=strong,reason:()=> 'короткий вариант'},
  {id:'rewatch',accept:x=>personal(x.film).actual&&personal(x.film).rating>=3.5,reason:()=> 'сильный пересмотр'}
 ];
 const output=[],picked=new Map();for(const role of roles){const matches=unique.filter(role.accept);if(!matches.length)continue;const winner=matches[0],identity=x=>String(x.film.tmdbId||x.film.id),existing=picked.get(identity(winner));if(existing){const reason=role.reason(winner);if(existing.reasons.length<2&&!existing.reasons.includes(reason))existing.reasons.push(reason);}
  const next=matches.find(x=>!picked.has(identity(x)));if(next&&output.length<5){const item={...next,score:personal(next.film),role:role.id,reasons:[role.reason(next)]};output.push(item);picked.set(identity(next),item);}}
 return output;
}
function shortlistAvailabilityText(item){const a=item.availability;if(!a.available)return 'Нет показов в текущем окне';const channel=a.show.channel||'Канал не указан',time=t=>new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'}).format(new Date(t));if(a.kind==='current')return `Сейчас · ${channel}`;if(a.kind==='future')return `Сегодня ${time(a.show.start)} · ${channel}`;return `Архив · ${channel} · до ${new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(a.archiveUntil??a.until))}`;}
function renderShortlist(visible,valid=true){const node=$('#shortlist');if(!node)return;const list=valid?buildShortlist(visible):[];$('#shortlist-cards').innerHTML=list.map(item=>{const f=item.film;return `<article class="shortlist-card${item.availability.available?'':' is-unavailable'}"><h3><button type="button" data-shortlist-film="${escapeHTML(f.id)}">${escapeHTML(f.title)}</button>${letterboxdLink(f)}</h3><p class="shortlist-meta">${escapeHTML(f.year||'Год не указан')} · ${Number(f.runtime)>0?Math.round(f.runtime)+' мин':'Длительность неизвестна'}</p><p class="shortlist-score">${item.score.actual?'Твоя оценка':'Прогноз'} <strong>${item.score.rating.toFixed(1)} ★</strong></p><p class="shortlist-availability">${escapeHTML(shortlistAvailabilityText(item))}</p><div class="shortlist-reasons">${item.reasons.map(reason=>`<span>${escapeHTML(reason)}</span>`).join('')}</div></article>`;}).join('');$('#shortlist-empty').hidden=list.length>0;$('#shortlist-empty').textContent=!valid?'Проверь значения фильтров.':!ratingsLoaded?'Загружаем оценки и прогнозы…':'Нет подходящих вариантов с оценкой или прогнозом. Измени фильтры или выбери «Сегодня». Границы фильтров сохранены.';$('#shortlist-caption').textContent=state.includeUnscheduled&&state.shortlistMode==='today'?'Из твоей выборки · варианты без показа отмечены отдельно':'Из твоей выборки · только актуальное окно показов';document.querySelectorAll('[data-shortlist-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.shortlistMode===state.shortlistMode)));}

// Finds: strong catalog films outside the watchlist, read from GET /api/catalog/available. The route decides eligibility; this block only re-checks it against the loaded watchlist and clock, ranks and presents.
// With a channel filter the section becomes channel-scoped: only shows on a selected channel (OR across channels) inside the selected period of the
// effective viewing window count, so a film airing only on another channel, outside the period or in the black zone is not a find.
const FINDS_MIN_RATING=4,FINDS_MIN_PROBABILITY=.7,FINDS_LIMIT=5,FINDS_PERSON_CACHE=8,SIMILAR_LIMIT=8,SIMILAR_WATCHLIST_CAP=4;
let findsSource={films:[],programmeRunId:null,generatedAt:null,ready:false,error:false,watchedMarkEnabled:false},findsLoading=false;
// One identity GET per selected actor or director. The cache keeps a few answers for this programme generation.
// A generation change drops them. An in-flight answer for another generation or another selection is not shown.
let findsPeople={generation:undefined,cache:new Map(),inflight:new Set()};
function findsPersonRoute(field,id){
 const role=field==='directors'?'director':'actor';
 if(typeof id!=='string'||id.length>200||/[\s#&?]/.test(id))return null;
 const match=/^(tmdb_)?(actor|director)\/([^/]+)$/.exec(id);
 if(!match||match[2]!==role)return null;
 return {field,role,id,path:'/api/d1/persons/'+(match[1]||'')+match[2]+'/'+encodeURIComponent(match[3])+'/identity'};
}
function findsPersonLabel(field,id){
 const people=report?.people?.[field];
 const found=Array.isArray(people)?people.find(person=>person&&person.id===id):null;
 const name=typeof found?.name==='string'?found.name.trim():'';
 return name||(field==='directors'?'режиссёр':'актёр');
}
// A confirmed cross-source answer is unbounded, trusted and verified, and carries co_credit for this role.
// Owner decisions and role links are not in D1; a body that does not say so is not applied. Anything else matches no catalog film.
function findsPersonAccepted(body,route){
 if(!body||typeof body!=='object'||Array.isArray(body))return null;
 if(body.source!=='d1'||body.authoritative!==false||body.bounded!==false)return null;
 if(body.recordId!=='person:'+route.id)return null;
 const limitations=body.limitations;
 if(!Array.isArray(limitations)||limitations.includes('neighborhood_bounded')||limitations.includes('namesakes_truncated'))return null;
 if(!limitations.includes('owner_decisions_not_stored')||!limitations.includes('role_links_not_stored'))return null;
 const reference=body.reference;
 if(!reference||reference.state!=='trusted'||reference.crossSource!=='verified'||!Array.isArray(reference.links))return null;
 const evidence=reference.links.filter(link=>link&&link.basis==='co_credit'&&Array.isArray(link.roles)&&link.roles.includes(route.role));
 if(!evidence.length)return null;
 const surface=body.films?.[route.role];
 if(!surface||surface.state!=='trusted'||surface.crossSource!=='verified'||!Array.isArray(surface.catalog))return null;
 const ids=[];
 for(const id of surface.catalog)if(typeof id==='string'&&/^film:tmdb:\d+$/.test(id))ids.push(id);
 return ids;
}
function findsTypedMovie(film){
 const id=typeof film?.id==='string'?film.id:'';
 const match=/^tmdb_(\d+)$/.exec(id);
 if(!match)return null;
 const typed='tmdb:'+match[1];
 return film.canonicalIdentity===typed?typed:null;
}
function findsBindPerson(d1Ids,films){
 const wanted=new Set();
 for(const id of d1Ids||[]){const match=/^film:tmdb:(\d+)$/.exec(id);if(match)wanted.add('tmdb:'+match[1]);}
 const hits=new Map();
 for(const film of films||[]){
  const typed=findsTypedMovie(film);
  if(!typed||!wanted.has(typed))continue;
  const list=hits.get(typed)||[];list.push(String(film.id));hits.set(typed,list);
 }
 const out=new Set();
 for(const list of hits.values())if(list.length===1)out.add(list[0]);
 return out;
}
function findsPersonView(){
 const selected=[];
 for(const field of ['directors','actors']){const id=state[field];if(id)selected.push({field,id,route:findsPersonRoute(field,id)});}
 if(!selected.length)return {active:false,ready:true,pending:false,closed:false,reason:null,people:[],ids:new Set()};
 const generation=report?.runId??null;
 let pending=false,refused=false,failed=false;
 const people=[];
 for(const item of selected){
  if(!item.route){refused=true;continue;}
  const cached=findsPeople.cache.get(generation+'\n'+item.route.path);
  if(!cached||cached.status==='loading'){pending=true;continue;}
  if(cached.status==='error'){failed=true;continue;}
  if(cached.status!=='ready'){refused=true;continue;}
  people.push({label:findsPersonLabel(item.field,item.id),catalogIds:findsBindPerson(cached.ids,findsSource.films)});
 }
 if(failed)return {active:true,ready:false,pending:false,closed:true,reason:'error',people:[],ids:new Set()};
 if(refused)return {active:true,ready:false,pending:false,closed:true,reason:'refused',people:[],ids:new Set()};
 if(pending||people.length!==selected.length)return {active:true,ready:false,pending:true,closed:false,reason:'checking',people:[],ids:new Set()};
 let ids=null;
 for(const item of people){const next=item.catalogIds;ids=ids?new Set([...ids].filter(id=>next.has(id))):new Set(next);}
 return {active:true,ready:true,pending:false,closed:false,reason:'ready',people,ids};
}
function syncFindsPeople(){
 const generation=report?.runId??null;
 if(findsPeople.generation!==generation){findsPeople.generation=generation;findsPeople.cache.clear();}
 const routes=[];
 for(const field of ['directors','actors']){const route=state[field]?findsPersonRoute(field,state[field]):null;if(route)routes.push(route);}
 for(const route of routes){
  const cacheKey=generation+'\n'+route.path;
  if(findsPeople.cache.has(cacheKey)||findsPeople.inflight.has(cacheKey))continue;
  while(findsPeople.cache.size>=FINDS_PERSON_CACHE)findsPeople.cache.delete(findsPeople.cache.keys().next().value);
  findsPeople.cache.set(cacheKey,{status:'loading'});
  findsPeople.inflight.add(cacheKey);
  loadFindsPerson(route,cacheKey,generation);
 }
}
async function loadFindsPerson(route,cacheKey,generation){
 let entry={status:'error'};
 try{
  const response=await fetch(route.path);
  if(response.ok){
   const ids=findsPersonAccepted(await response.json(),route);
   entry=ids?{status:'ready',ids}:{status:'refused'};
  }
 }catch{entry={status:'error'};}
 findsPeople.inflight.delete(cacheKey);
 if(findsPeople.generation!==generation)return;
 findsPeople.cache.set(cacheKey,entry);
 renderFinds();
}
// The owner's «Смотрел» mark (ADR-0032): POST /api/catalog/watched with the card's TMDB id only. A marked film leaves Finds at once,
// before the catalog answer is refreshed; the notice offers an undo, which posts watched: false.
const findsMarks=new Map();let findsNotice=null;
// AIR-435 (ADR 0114): the client reads the film availability lifecycle through the same module the Worker embeds (`/film-availability.js`, loaded before this
// file), so a card, the Finds section and the catalog API never disagree. `filmAvail` is the one reading: the shows given (all of the film's by default),
// the film runtime as the fallback for a show without a valid end, and the clock of the caller. It is computed at render time, so the state changes with the
// clock and needs no new request. Without the module (an isolated test context) it answers `null` and every consumer keeps its previous behavior.
function availabilityLib(){return typeof FilmAvailability==='undefined'?null:FilmAvailability;}
function filmAvail(film,now=viewingClock(),shows=film?.shows){
 const lib=availabilityLib();if(!lib||!film)return null;
 const list=(shows||[]).map(show=>({start:showStart(show),end:show?.end})).filter(show=>show.start!==null);
 return lib.filmAvailability(list,now,{runtimeMinutes:film.runtime});
}
function soonTail(avail){
 if(avail.appearsAt!==null&&avail.appearsAtKnown)return avail.appearsAtEstimated?`архив ожидается около ${madridStamp(avail.appearsAt)} (по длительности фильма)`:`архив появится после ${madridStamp(avail.appearsAt)}`;
 return 'время появления архива неизвестно';
}
// The one «Скоро» indicator: a small hourglass in the corner of a poster. Every poster surface calls `soonBadge` (never its own markup) and wraps the
// poster with `posterFrame`; it answers '' unless the film is `soon`, so a film with a ready archive never shows it, and it disappears when the archive appears.
// Selector contract: `.soon-badge` (role img, aria-label and title carry the text) inside a `position:relative` poster container (`.poster-frame`,
// `.finds-poster`, `.film-similar-poster`, `#film-poster`).
let soonTickAt=null,soonTimer=null,soonArmedAt=null;
function noteSoonTick(at){if(Number.isFinite(at)&&(soonTickAt===null||at<soonTickAt))soonTickAt=at;}
function soonBadge(film,{now=viewingClock(),shows=film?.shows}={}){
 const avail=filmAvail(film,now,shows);if(!avail||avail.state!=='soon')return '';
 noteSoonTick(avail.appearsAt);
 const label=`Скоро: ${soonTail(avail)}`;
 return `<span class="soon-badge" role="img" aria-label="${escapeHTML(label)}" title="${escapeHTML(label)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12M6 21h12M7 3c0 5 3 6 5 9-2 3-5 4-5 9M17 3c0 5-3 6-5 9 2 3 5 4 5 9"/></svg></span>`;
}
function posterFrame(poster,badge){return badge?`<div class="poster-frame">${badge}${poster}</div>`:poster;}
// A live page re-renders at the next moment a hourglass should disappear, with no request; a fixed view clock never changes state, so it arms nothing.
function armSoonTick(){
 const at=soonTickAt;soonTickAt=null;
 if(typeof setTimeout!=='function'||typeof clearTimeout!=='function'||at===null||viewClock!=null||!report)return;
 if(soonTimer&&soonArmedAt!==null&&soonArmedAt<=at)return; // an earlier or equal moment is already pending
 if(soonTimer)clearTimeout(soonTimer);
 soonArmedAt=at;
 const delay=Math.min(Math.max(at-Date.now()+1000,1000),3600000);
 soonTimer=setTimeout(()=>{soonTimer=null;soonArmedAt=null;render();refreshFilmPoster();refreshFilmAvailability();},delay);soonTimer?.unref?.();
}
function findsScope(){return state.channels?.size||state.period!=='all'?{channels:state.channels?.size?new Set(state.channels):null,period:state.period}:null;}
function findsOnChannel(show,channels){const name=typeof show?.channel==='string'?show.channel:'';return !!name&&(channels.has(name)||channels.has(name.trim()));}
function findsInPeriod(model,show,period){return period==='archive'?inArchive(model,show):period==='future'?inFuture(model,show):inArchive(model,show)||inFuture(model,show);}
function findsShows(film,now,scope=findsScope()){
 const from=now-72*3600000,to=now+24*3600000;
 let shows=(film?.shows||[]).map(show=>({...show,start:showStart(show)})).filter(show=>show.start!==null&&show.start>from&&show.start<to);
 if(scope){const model=viewingWindow(now);shows=shows.filter(show=>(!scope.channels||findsOnChannel(show,scope.channels))&&findsInPeriod(model,show,scope.period));}
 return shows.sort((a,b)=>a.start-b.start);
}
// The shows of a film inside the product windows on the selected channels (none in the black zone, where the programme does not cover the clock). The period filter is not applied here: it constrains the lifecycle STATE (below).
function findsWindowShows(film,now,scope=findsScope()){
 if(blackZone())return [];
 const from=now-72*3600000,to=now+24*3600000;
 const shows=(film?.shows||[]).map(show=>({...show,start:showStart(show)})).filter(show=>show.start!==null&&show.start>from&&show.start<to);
 return (scope?.channels?shows.filter(show=>findsOnChannel(show,scope.channels)):shows).sort((a,b)=>a.start-b.start);
}
// The lifecycle of a find over the shows of the selected channels. `null` only when the shared module is absent (an isolated context).
function findsAvail(film,now,scope=findsScope()){return filmAvail(film,now,findsWindowShows(film,now,scope));}
// Archive-first period filter: «Архив» keeps films with a ready archive, «Скоро» (period `future`) keeps films with no ready archive that are on air or ahead.
function findsPeriodAllows(state,period){return period==='archive'?state==='available':period==='future'?state==='soon':state==='available'||state==='soon';}
function findsUntil(film,now,scope=findsScope()){
 const avail=findsAvail(film,now,scope);
 if(avail)return avail.state==='available'?avail.archiveUntil:null;
 const shows=findsShows(film,now,scope);return shows.length?Math.max(...shows.map(show=>show.start))+72*3600000:null;
}
function findsIdentity(film){return String(film.canonicalIdentity||(film.tmdbId?'tmdb:'+film.tmdbId:'')||film.id);}
function watchlistIdentities(){const ids=new Set(),tmdb=new Set();for(const film of films||[]){ids.add(String(film.id));if(film.tmdbId)tmdb.add(String(film.tmdbId));}return {ids,tmdb};}
function effectiveConfidence(prediction){
 if(!prediction||typeof prediction!=='object'||Array.isArray(prediction))return '';
 const model=typeof prediction.confidence==='string'?prediction.confidence:'';
 if(!Object.hasOwn(prediction,'confidenceAssessment'))return model;
 const value=prediction.confidenceAssessment;
 if(!value||typeof value!=='object'||Array.isArray(value)||value.assessmentVersion!==1)return 'low';
 if(typeof value.level!=='string'||!Object.hasOwn(EVIDENCE_CONFIDENCE_LEVEL,value.level))return 'low';
 if(typeof value.status!=='string'||!['evidenced','legacy','insufficient'].includes(value.status))return 'low';
 if(value.status!=='evidenced'&&value.level!=='low')return 'low';
 if(!Array.isArray(value.reasonCodes)||!value.coverage||typeof value.coverage!=='object'||Array.isArray(value.coverage))return 'low';
 for(const key of ['mechanicsAsserted','mechanicsSupported','keyApplicable','keyConcrete','keySupported','keyUnknown','keyNotApplicable','genrePresent','genreSupported']){
  const number=value.coverage[key];
  if(typeof number!=='number'||!Number.isInteger(number)||number<0||number>99)return 'low';
 }
 const bound=typeof prediction.fingerprintHash==='string'&&/^[a-f0-9]{64}$/.test(prediction.fingerprintHash)?prediction.fingerprintHash:null;
 const assessed=typeof value.fingerprintHash==='string'&&/^[a-f0-9]{64}$/.test(value.fingerprintHash)?value.fingerprintHash:null;
 if(!bound||assessed!==bound)return 'low';
 return value.level;
}
function findsStrong(prediction){const confidence=effectiveConfidence(prediction);return !!prediction&&!prediction.stale&&Number.isFinite(prediction.predictedRating)&&prediction.predictedRating>=FINDS_MIN_RATING&&Number.isFinite(prediction.probability4Plus)&&prediction.probability4Plus>=FINDS_MIN_PROBABILITY&&confidence!==''&&confidence!=='low';}
// Contextual finds: every filter a catalog record can answer from its own fields (title search, genres, years, runtime, mechanics,
// moods, execution, prediction thresholds, last chance, channel and period) is a hard constraint, with the same AND/OR rules as the
// watchlist grid. Mechanics, moods and execution come only from the record's current fingerprint and prediction. The people search
// scope is not evaluated on a catalog record. A selected director or actor is a hard constraint too, but only through the identity
// GET: no confirmed cross-source catalog ids means no find. «Только начатые» and «Пересмотр» stay watchlist-only and still leave no
// find. The record carries no synopsis or aliases, so the plot scope reads only genres and facets. The watchlist grid keeps matching
// the stored role id and does not read this answer.
function findsContext(){
 const validYear=Number.isInteger(state.from)&&Number.isInteger(state.to)&&state.from>=1900&&state.to<=MAX_YEAR&&state.from<=state.to,validRuntime=state.maxRuntime===null||(Number.isInteger(state.maxRuntime)&&state.maxRuntime>0);
 const person=!!(state.directors||state.actors);
 return {valid:validYear&&validRuntime,query:searchTokens(state.query),scopes:activeSearchScopes(state.searchScopes),genres:new Set(state.genres),genreKeys:findsGenreKeys(state.genres),mechanics:new Set(state.mechanics),moods:new Set(state.moods),execution:Object.fromEntries(EXECUTION_FILTERS.map(dimension=>[dimension.id,new Set(state.execution[dimension.id]||[])])),from:state.from,to:state.to,maxRuntime:state.maxRuntime,minPrediction:state.minPrediction,minProbability:state.minProbability,viewing:state.viewing,startedOnly:state.startedOnly,lastChanceOnly:state.lastChanceOnly,person,people:person?findsPersonView():null};
}
function findsContextActive(context){return !!context&&(context.query.tokens.length>0||context.genres.size>0||context.mechanics.size>0||context.moods.size>0||Object.values(context.execution).some(selected=>selected.size)||context.from!==1900||context.to!==MAX_YEAR||context.maxRuntime!==null||context.minPrediction!==null||context.minProbability!==null||context.lastChanceOnly||context.viewing!=='any'||context.startedOnly||context.person);}
// Genres are matched by canonical key, not by label: the watchlist carries the Letterboxd labels mapped by GENRE_MAP («Криминал»,
// «Фантастика», «Исторический»), the catalog carries the TMDB ru-RU names («криминал», «фантастика», «история»). FINDS_GENRE_KEYS is a
// copy of PROFILE_GENRE_ALIASES in src/domain/prediction-compatibility.js (a test keeps them equal); a name outside it matches only the
// same name, case-folded, never a different one. Labels and URL parameters stay as they are; only the comparison is canonical.
const FINDS_GENRE_KEYS={
 'боевик':'action','приключения':'adventure','мультфильм':'animation','комедия':'comedy','криминал':'crime','документальный':'documentary','драма':'drama',
 'семейный':'family','фэнтези':'fantasy','история':'history','исторический':'history','ужасы':'horror','музыка':'music','музыкальный':'music','детектив':'mystery',
 'мелодрама':'romance','фантастика':'science_fiction','триллер':'thriller','телевизионный фильм':'tv_movie','телефильм':'tv_movie','военный':'war','вестерн':'western',
 'action':'action','adventure':'adventure','animation':'animation','comedy':'comedy','crime':'crime','documentary':'documentary','drama':'drama','family':'family',
 'fantasy':'fantasy','history':'history','horror':'horror','music':'music','mystery':'mystery','romance':'romance','science fiction':'science_fiction',
 'thriller':'thriller','tv movie':'tv_movie','war':'war','western':'western'
};
function findsGenreKey(name){if(typeof name!=='string')return null;const folded=name.trim().toLocaleLowerCase('ru').replace(/\s+/g,' ');if(!folded)return null;return FINDS_GENRE_KEYS[folded]||'raw:'+folded;}
function findsGenreKeys(names){return new Set(Array.from(names||[],findsGenreKey).filter(Boolean));}
function findsFacets(film){
 const mechanics=(film.fingerprint?.plotMechanics||[]).filter(id=>Object.hasOwn(MECHANIC_LABELS,id));
 const moods=[...(film.fingerprint?.moodIds||[]),...(film.prediction?.moodIds||[])].filter(id=>Object.hasOwn(MOOD_LABELS,id));
 return {mechanics:new Set(mechanics),moods:new Set(moods)};
}
function findsSearchRank(film,context){
 const {normalized,tokens}=context.query;if(!tokens.length)return 0;
 const facets=findsFacets(film);
 const entry={names:searchTexts([film.title,film.original]),people:[],facets:[...facets.mechanics].flatMap(id=>searchTexts([id,MECHANIC_LABELS[id]])).concat([...facets.moods].flatMap(id=>searchTexts([id,moodLabel(id)]))).concat(searchTexts(film.genres||[])),synopsis:''};
 return rankSearchEntry(entry,normalized,tokens,{titles:!!context.scopes.titles,people:false,plot:!!context.scopes.plot});
}
function findsPersonHit(film,context){return !!context?.people?.ready&&context.people.ids.has(String(film.id));}
function findsMatchesContext(film,context,now,scope){
 if(!context)return true;
 if(!context.valid||context.startedOnly||context.viewing==='rewatch')return false;
 if(context.person&&!findsPersonHit(film,context))return false;
 const p=film.prediction,facets=findsFacets(film),year=Number(film.year),runtime=Number(film.runtime);
 if(context.minPrediction!==null&&!(p.predictedRating>=context.minPrediction))return false;
 if(context.minProbability!==null&&!(p.probability4Plus>=context.minProbability))return false;
 if((context.from!==1900||context.to!==MAX_YEAR)&&!(Number.isFinite(year)&&film.year&&year>=context.from&&year<=context.to))return false;
 if(context.maxRuntime!==null&&!(runtime>0&&runtime<=context.maxRuntime))return false;
 if(context.genres.size){const keys=findsGenreKeys(film.genres);if(![...context.genreKeys].some(key=>keys.has(key)))return false;}
 if(context.mechanics.size&&![...context.mechanics].some(id=>facets.mechanics.has(id)))return false;
 if(context.moods.size&&![...context.moods].some(id=>facets.moods.has(id)))return false;
 for(const [dimension,selected] of Object.entries(context.execution))if(selected.size&&!selected.has(film.fingerprint?.execution?.[dimension]))return false;
 if(context.lastChanceOnly){const until=findsUntil(film,now,scope);if(!(until>now&&until-now<8*3600000))return false;}
 return findsSearchRank(film,context)!==null;
}
// What a find matched among the selected genres, mechanics and moods; mechanics and moods weigh above genres in the ranking.
function findsMatched(film,context){
 if(!context)return {people:[],mechanics:[],moods:[],genres:[]};
 const facets=findsFacets(film),keys=findsGenreKeys(film.genres),seen=new Set();
 // The matched genres are the selected labels (as the owner picked them), one per canonical genre the film carries.
 const genres=[...context.genres].filter(genre=>{const key=findsGenreKey(genre);if(!key||!keys.has(key)||seen.has(key))return false;seen.add(key);return true;});
 const people=context.people?.ready?context.people.people.filter(item=>item.catalogIds.has(String(film.id))).map(item=>item.label):[];
 return {people,mechanics:[...context.mechanics].filter(id=>facets.mechanics.has(id)),moods:[...context.moods].filter(id=>facets.moods.has(id)),genres};
}
function findsEligible(film,now=nowMs(),known=watchlistIdentities(),scope=findsScope()){
 if(!film||film.id===undefined||film.id===null)return false;
 if(film.tmdbId&&findsMarks.get(String(film.tmdbId))?.state==='marked')return false;
 if(known.ids.has(String(film.id))||(film.tmdbId&&known.tmdb.has(String(film.tmdbId))))return false;
 const local=enrichment.films?.[String(film.id)];
 if(local&&local.actualRating!==null&&local.actualRating!==undefined)return false;
 if(!findsStrong(film.prediction))return false;
 const avail=findsAvail(film,now,scope);
 if(avail)return findsPeriodAllows(avail.state,scope?.period);
 return findsShows(film,now,scope).length>0;
}
function franchiseKey(film){const base=String(film.original||film.title||'').normalize('NFKC').toLocaleLowerCase('ru').replace(/[:\-–—]/g,' ');return base.replace(/(?:^|\s)(?:part|часть|глава|chapter|episode|эпизод|vol\.?|том)\s*[\divxlc]+(?=\s|$)/gu,' ').replace(/\s(?:\d|[ivxlc]{1,5})\s*$/,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
function findsSignal(film){return `${film.prediction.predictedRating.toFixed(1)}|${film.prediction.probability4Plus.toFixed(2)}`;}
function findsRank(film,now,scope){const avail=findsAvail(film,now,scope);return avail?.state==='available'?0:1;}
function findsCompare(a,b,now,scope=findsScope(),context=null){
 if(context){const ma=findsMatched(a,context),mb=findsMatched(b,context);const person=mb.people.length-ma.people.length;if(person)return person;const facet=(mb.mechanics.length+mb.moods.length)-(ma.mechanics.length+ma.moods.length)||mb.genres.length-ma.genres.length;if(facet)return facet;}
 return b.prediction.predictedRating-a.prediction.predictedRating||b.prediction.probability4Plus-a.prediction.probability4Plus||findsRank(a,now,scope)-findsRank(b,now,scope)||(findsUntil(a,now,scope)??Infinity)-(findsUntil(b,now,scope)??Infinity)||String(a.title||'').localeCompare(String(b.title||''),'ru',{sensitivity:'base'})||String(a.id).localeCompare(String(b.id));}
function buildFinds(input=findsSource.films,now=nowMs(),scope=findsScope(),context=findsContext()){
 const known=watchlistIdentities();
 const candidates=(input||[]).filter(film=>findsEligible(film,now,known,scope)&&findsMatchesContext(film,context,now,scope)).sort((a,b)=>findsCompare(a,b,now,scope,context));
 const picked=[],identities=new Set(),franchises=new Map();
 for(const film of candidates){
  if(picked.length>=FINDS_LIMIT)break;
  const identity=findsIdentity(film);if(identities.has(identity))continue;
  const key=franchiseKey(film),signal=findsSignal(film);
  if(key&&franchises.get(key)===signal)continue;
  identities.add(identity);if(key&&!franchises.has(key))franchises.set(key,signal);
  picked.push(film);
 }
 return picked;
}
function findsChannel(show){return typeof show?.channel==='string'&&show.channel.trim()?show.channel.trim():'Канал не указан';}
function findsAiring(film,now=nowMs(),scope=findsScope()){
 const avail=findsAvail(film,now,scope);
 if(avail)return findsAiringFromLifecycle(film,now,scope,avail);
 const shows=findsShows(film,now,scope);
 const live=shows.find(show=>show.start<=now&&finiteTime(show.end)!==null&&finiteTime(show.end)>now);
 if(live)return {kind:'live',text:`Сейчас в эфире · ${findsChannel(live)}`,show:live};
 const next=shows.find(show=>show.start>now);
 if(next)return {kind:'next',text:`${madridStamp(next.start)} · ${findsChannel(next)}`,show:next};
 const last=shows.filter(show=>show.start<=now).pop();
 if(!last)return {kind:'none',text:'Нет показов в текущем окне',show:null};
 return {kind:'catchup',text:`Архив · ${findsChannel(last)} · до ${madridStamp(findsUntil(film,now,scope))}`,show:last};
}
// A ready archive is always named first, even when a repeat is nearer (`catchup`); with none, a show on air (`live`) or the nearest start inside 24 hours
// (`next`) is named with when the archive is expected, and with no usable end the text says the time is unknown instead of guessing.
function findsAiringFromLifecycle(film,now,scope,avail){
 const shows=findsWindowShows(film,now,scope),lib=availabilityLib(),phase=show=>lib.showPhase({start:show.start,end:show.end},now,{runtimeMinutes:film.runtime}).phase;
 if(avail.state==='available'){
  const ready=shows.filter(show=>phase(show)==='archive'),last=ready.find(show=>show.start===avail.archiveShow.start)||ready.pop();
  return {kind:'catchup',text:`Архив · ${findsChannel(last)} · до ${madridStamp(avail.archiveUntil)}`,show:last,availability:avail};
 }
 if(avail.state==='soon'){
  // With overlapping shows the named show is the one whose effective end is `appearsAt` (the earliest), so the channel and the time always belong together;
  // with no promised hour (an unknown end) the show on air, else the nearest start, is named.
  const options={runtimeMinutes:film.runtime},candidates=shows.filter(show=>['on_air','future'].includes(phase(show)));
  const endOf=show=>lib.showPhase({start:show.start,end:show.end},now,options).end;
  const promised=avail.appearsAtKnown&&avail.appearsAt!==null?candidates.find(show=>endOf(show)===avail.appearsAt):null;
  const live=promised&&phase(promised)==='on_air'?promised:promised?null:shows.find(show=>phase(show)==='on_air'),next=promised&&phase(promised)==='future'?promised:promised?null:shows.find(show=>phase(show)==='future');
  if(live)return {kind:'live',text:`Сейчас в эфире · ${findsChannel(live)} · ${soonTail(avail)}`,show:live,availability:avail};
  if(next)return {kind:'next',text:`${madridStamp(next.start)} · ${findsChannel(next)} · ${soonTail(avail)}`,show:next,availability:avail};
 }
 return {kind:'none',text:'Нет показов в текущем окне',show:null,availability:avail};
}
// Similar films on the open film's page. Two sources already in memory: the loaded watchlist (`films`) and the cached
// catalog answer (`findsSource`). No second reader and no request. List filters, the Finds person check and channel
// scope do not apply. A credit matches only when the id string is the same; a Letterboxd id and a TMDB id are not joined,
// and a shared name is not a match. Unknown and not_applicable execution values are not a match.
// A catalog candidate is eligible only when its own prediction passes findsStrong, before ranking or diversity.
// A shared mechanic, credit or execution value does not waive that floor, and a short catalog tail is not padded.
// A watchlist film is not held to that floor. A rewatch is watched true or an actual rating. started is not watched.
// watched null, absent or any other value is unknown and stays «В watchlist». A stored rating still wins over watched false.
function similarVerifiedIdentity(film){const tmdb=film?.tmdbId==null?'':String(film.tmdbId);return /^\d+$/.test(tmdb)&&film.canonicalIdentity==='tmdb:'+tmdb?'tmdb:'+tmdb:null;}
function similarCreditIds(people){const ids=[];for(const person of people||[]){const id=typeof person?.id==='string'?person.id:'';if(id&&!ids.includes(id))ids.push(id);}return ids;}
function similarKnownExecution(execution){const out=[];if(!execution||typeof execution!=='object')return out;for(const dimension of EXECUTION_FILTERS){const value=execution[dimension.id];if(!value||value==='unknown'||value==='not_applicable'||!EXECUTION_VALUES[dimension.id]?.[value])continue;out.push(dimension.id+':'+value);}return out;}
function similarFacetBundle(fingerprint,prediction){const fresh=prediction&&!prediction.stale?prediction:null;return {mechanics:knownFacetIds(fingerprint?.plotMechanics,MECHANIC_LABELS),moods:knownFacetIds([...(fingerprint?.moodIds||[]),...(fresh?.moodIds||[])],MOOD_LABELS),execution:similarKnownExecution(fingerprint?.execution)};}
function similarNumbers(prediction){if(!prediction||prediction.stale||!Number.isFinite(prediction.predictedRating))return null;const numbers={rating:prediction.predictedRating,probability:Number.isFinite(prediction.probability4Plus)?prediction.probability4Plus:null,confidence:prediction.confidence};if(Object.hasOwn(prediction,'confidenceAssessment'))numbers.confidenceAssessment=prediction.confidenceAssessment;if(typeof prediction.fingerprintHash==='string')numbers.fingerprintHash=prediction.fingerprintHash;return numbers;}
function similarViewItem(id){const item=enrichment.films?.[String(id)];return item&&typeof item==='object'?item:null;}
function similarHasRating(item){return !!item&&item.actualRating!==null&&item.actualRating!==undefined;}
function similarRewatch(item){return !!item&&(item.watched===true||similarHasRating(item));}
function similarWatchlistView(film){const item=similarViewItem(film.id)||{},fingerprint=item.fingerprint&&typeof item.fingerprint==='object'?item.fingerprint:null;return {bundle:similarFacetBundle(fingerprint,item.prediction),prediction:similarNumbers(item.prediction),rewatch:similarRewatch(item)};}
function similarCatalogView(film){return {bundle:similarFacetBundle(film.fingerprint,film.prediction),prediction:similarNumbers(film.prediction)};}
function similarOverlap(left,right,leftPeople,rightPeople){return {mechanics:left.mechanics.filter(id=>right.mechanics.includes(id)),moods:left.moods.filter(id=>right.moods.includes(id)),execution:left.execution.filter(id=>right.execution.includes(id)),directors:leftPeople.directors.filter(id=>rightPeople.directors.includes(id)),actors:leftPeople.actors.filter(id=>rightPeople.actors.includes(id))};}
function similarTheme(overlap){return [overlap.mechanics.length,overlap.mechanics.length&&overlap.moods.length?overlap.moods.length:0,overlap.directors.length?1:0,overlap.actors.length,overlap.execution.length];}
function similarSubstantive(overlap){return overlap.mechanics.length>0||overlap.directors.length>0||overlap.actors.length>0||overlap.execution.length>0;}
function similarExecutionLabel(token){const id=String(token||'').split(':')[0],names={pace:'Похожий темп',plot_engine:'Похожий сюжетный двигатель',stakes:'Похожие ставки',payoff:'Похожая отдача',ending_quality:'Похожий финал'};if(names[id])return names[id];const dimension=EXECUTION_FILTERS.find(item=>item.id===id);return dimension?`Похоже: ${dimension.label}`:'Похожее исполнение';}
// Every option is a real overlap, strongest first. A later label is used only when every stronger tier is unavailable.
function similarOptions(overlap,fallback){
 const options=[];
 if(overlap.mechanics.length){
  const mechanics=overlap.mechanics.slice(0,2),mood=overlap.moods.length?overlap.moods[0]:null,names=mechanics.map(id=>MECHANIC_LABELS[id]).join(' и ');
  options.push(mood
   ?{kind:'mechanic_mood',signature:'mechanic_mood:'+mechanics.join('+')+':'+mood,mechanics,label:`${names} · ${MOOD_LABELS[mood]}`}
   :{kind:'mechanic',signature:'mechanic:'+mechanics.join('+'),mechanics,label:names});
 }
 if(overlap.directors.length)options.push({kind:'director',signature:'director',mechanics:[],label:'Общий режиссёр'});
 if(overlap.actors.length)options.push({kind:'actors',signature:'actors',mechanics:[],label:overlap.actors.length>1?'Общие актёры':'Общий актёр'});
 for(const token of overlap.execution)options.push({kind:'execution',signature:'execution:'+token,mechanics:[],label:similarExecutionLabel(token)});
 if(fallback)options.push({kind:'prediction',signature:'prediction',mechanics:[],label:'Подходит по прогнозу'});
 return options;
}
// Mechanic and mood first, then a person, then a plot engine. Any other execution value, and the prediction
// label, are weaker: they never replace a stronger reason and they are not a second franchise entry.
function similarReasonTier(option){
 if(option.kind==='mechanic'||option.kind==='mechanic_mood')return 0;
 if(option.kind==='director'||option.kind==='actors')return 1;
 if(option.kind==='execution')return String(option.signature).startsWith('execution:plot_engine:')?2:3;
 return 4;
}
function similarFranchiseAllows(kept,option){
 if(!kept.length)return true;
 if(similarReasonTier(option)>=3)return false;
 if(option.mechanics.some(id=>kept.some(item=>item.mechanics.includes(id))))return false;
 return !kept.some(item=>item.signature===option.signature);
}
// Diversity stays inside the strongest tier this film still has. A second mechanic label is kept before a
// director, actors or a plot engine. A generic execution value does not replace any of those, and it does not
// rescue a film whose stronger reason is already capped. The same signature stops at two.
function similarChoose(options,state,kept){
 const franchised=options.filter(option=>similarFranchiseAllows(kept,option));
 if(!franchised.length)return null;
 const grounded=franchised.some(option=>similarReasonTier(option)<=2)?franchised.filter(option=>similarReasonTier(option)<=2):franchised;
 const usable=grounded.filter(option=>(state.signatures.get(option.signature)||0)<2);
 if(!usable.length)return null;
 const best=Math.min(...usable.map(similarReasonTier));
 const tier=usable.filter(option=>similarReasonTier(option)===best);
 const unused=tier.filter(option=>!(state.signatures.get(option.signature)||0));
 return (unused.length?unused:tier)[0];
}
function similarSameFilm(source,candidate){if(String(source.id)===String(candidate.id))return true;const left=similarVerifiedIdentity(source),right=similarVerifiedIdentity(candidate);if(left&&right&&left===right)return true;const sourceTmdb=/^\d+$/.test(String(source.tmdbId||''))?String(source.tmdbId):'',candidateTmdb=/^\d+$/.test(String(candidate.tmdbId||''))?String(candidate.tmdbId):'';if(sourceTmdb&&right==='tmdb:'+sourceTmdb)return true;if(candidateTmdb&&left==='tmdb:'+candidateTmdb)return true;return false;}
function similarCompare(a,b){for(let i=0;i<a.theme.length;i++){const delta=b.theme[i]-a.theme[i];if(delta)return delta;}const rating=(b.prediction?.rating??-1)-(a.prediction?.rating??-1);if(rating)return rating;const probability=(b.prediction?.probability??-1)-(a.prediction?.probability??-1);if(probability)return probability;const until=(a.until??Infinity)-(b.until??Infinity);if(until)return until;return a.key.localeCompare(b.key,'en');}
function similarTake(sorted,limit,state){
 const picked=[];
 for(const row of sorted){
  if(picked.length>=limit)break;
  if(state.seen.has(row.key))continue;
  const franchise=franchiseKey(row.film),group=franchise?state.franchises.get(franchise)||[]:[];
  const chosen=similarChoose(row.options,state,group);
  if(!chosen)continue;
  state.seen.add(row.key);
  state.signatures.set(chosen.signature,(state.signatures.get(chosen.signature)||0)+1);
  for(const id of chosen.mechanics)state.mechanics.set(id,(state.mechanics.get(id)||0)+1);
  const next={...row,reasonKind:chosen.kind,label:chosen.label,signature:chosen.signature,mechanics:chosen.mechanics};
  picked.push(next);
  if(franchise)state.franchises.set(franchise,[...group,next]);
 }
 return picked;
}
function buildSimilar(source,now=nowMs()){
 if(!source)return [];
// A catalog page ranks from its own prediction and fingerprint, a watchlist film from the view index.
 const origin=source.catalogRoute?similarCatalogView(source):similarWatchlistView(source),people={directors:similarCreditIds(source.directors),actors:similarCreditIds(source.actors)};
 const watchlist=[],catalog=[];
 const consider=(film,view,sourceName)=>{
  if(!film||similarSameFilm(source,film))return;
  if(!findsShows(film,now,null).length)return;
  if(sourceName==='catalog'&&!findsStrong(film.prediction))return;
  const overlap=similarOverlap(origin.bundle,view.bundle,{directors:people.directors,actors:people.actors},{directors:similarCreditIds(film.directors),actors:similarCreditIds(film.actors)});
  const fallbackPrediction={predictedRating:view.prediction?.rating,probability4Plus:view.prediction?.probability,confidence:view.prediction?.confidence,stale:false};if(view.prediction&&Object.hasOwn(view.prediction,'confidenceAssessment'))fallbackPrediction.confidenceAssessment=view.prediction.confidenceAssessment;if(typeof view.prediction?.fingerprintHash==='string')fallbackPrediction.fingerprintHash=view.prediction.fingerprintHash;const substantive=similarSubstantive(overlap),fallback=!substantive&&!view.rewatch&&findsStrong(fallbackPrediction);
  if(view.rewatch&&!substantive)return;
  const options=similarOptions(overlap,fallback);if(!options.length)return;
  const verified=similarVerifiedIdentity(film);
  (sourceName==='catalog'?catalog:watchlist).push({film,source:sourceName,theme:similarTheme(overlap),prediction:view.prediction,until:findsUntil(film,now,null),key:verified||'id:'+film.id,options,badge:sourceName==='catalog'?'new':view.rewatch?'rewatch':'watchlist'});
 };
 const consumed=similarConsumedTmdb();
 for(const film of films||[])if(film.catalogOnly!==true)consider(film,similarWatchlistView(film),'watchlist');
 if(findsFresh())for(const film of findsSource.films||[]){if(similarOnWatchlist(film))continue;if(film.tmdbId&&findsMarks.get(String(film.tmdbId))?.state==='marked')continue;if(similarCatalogBlocked(film,consumed))continue;consider(film,similarCatalogView(film),'catalog');}
 watchlist.sort(similarCompare);
 catalog.sort(similarCompare);
 const state={seen:new Set(),signatures:new Map(),mechanics:new Map(),franchises:new Map()},both=watchlist.length>0&&catalog.length>0;
 const watchPicked=similarTake(watchlist,both?SIMILAR_WATCHLIST_CAP:SIMILAR_LIMIT,state);
 const catalogPicked=similarTake(catalog,both?SIMILAR_LIMIT-watchPicked.length:watchlist.length?0:SIMILAR_LIMIT,state);
 return [...watchPicked,...catalogPicked];
}
function similarOnWatchlist(film){const known=watchlistIdentities();return known.ids.has(String(film.id))||!!(film.tmdbId&&known.tmdb.has(String(film.tmdbId)));}
// A catalog row is also dropped when the enrichment view already loaded says that film, or a trusted alias of it, is watched or rated.
// The alias is the view key `tmdb_<n>`, or a Letterboxd id whose loaded programme rows and verified catalog rows agree on one TMDB id.
// Two stored TMDB ids for that Letterboxd id, or none, do not bridge it. A shared title is not an alias. This does not replace the catalog route.
function similarLidBridge(){
 const byLid=new Map(),conflicted=new Set();
 const add=(id,tmdbId)=>{
  if(id==null||tmdbId==null)return;const lid=String(id),tmdb=String(tmdbId);
  if(/^tmdb_[1-9]\d*$/.test(lid)||!/^[1-9]\d*$/.test(tmdb)||conflicted.has(lid))return;
  if(!byLid.has(lid))byLid.set(lid,tmdb);else if(byLid.get(lid)!==tmdb){byLid.delete(lid);conflicted.add(lid);}
 };
 for(const film of films||[])add(film?.id,film?.tmdbId);
 if(findsFresh())for(const film of findsSource.films||[])if(film?.tmdbId&&film.canonicalIdentity==='tmdb:'+String(film.tmdbId))add(film.id,film.tmdbId);
 return {byLid,conflicted};
}
function similarConsumedTmdb(){
 const bridge=similarLidBridge(),consumed=new Set();
 for(const [id,item] of Object.entries(enrichment.films||{})){
  if(!similarRewatch(item))continue;
  const own=/^tmdb_([1-9]\d*)$/.exec(id);
  if(own){consumed.add(own[1]);continue;}
  if(!bridge.conflicted.has(id)){const linked=bridge.byLid.get(id);if(linked)consumed.add(linked);}
 }
 return consumed;
}
function similarCatalogBlocked(film,consumed){if(similarRewatch(similarViewItem(film.id)))return true;const verified=similarVerifiedIdentity(film);return !!verified&&consumed.has(verified.slice(5));}
function similarBadge(kind){if(kind==='new')return '<span class="film-similar-badge is-new" title="Фильм вне watchlist, не новинка проката">NEW</span>';if(kind==='rewatch')return '<span class="film-similar-badge is-rewatch">Пересмотр</span>';return '<span class="film-similar-badge">В watchlist</span>';}
// A title opens the internal film page: a loaded film by its permalink (its own id when no TMDB movie is proven), a catalog-only film by `tmdb_<n>`
// when its identity is verified. Anything else stays plain text. Never a jump to TMDB.
function similarTitle(film){const title=film.title||film.original||'Фильм',loaded=(films||[]).find(item=>String(item.id)===String(film.id)),verified=similarVerifiedIdentity(film),target=loaded?filmPermalinkId(loaded):verified?'tmdb_'+film.tmdbId:null;if(target)return `<button type="button" class="film-similar-open" data-similar-open="${escapeHTML(target)}">${escapeHTML(title)}</button>`;return escapeHTML(title);}
function similarPoster(film){const name=film.original||film.title||'';if(typeof film.poster==='string'&&film.poster)return `<img class="poster" src="${escapeHTML(film.poster)}" alt="Постер ${escapeHTML(name)}" width="78" height="117" loading="lazy" referrerpolicy="no-referrer">`;return `<div class="poster no-poster" aria-label="Постер недоступен">${escapeHTML(String(film.year||'Кино'))}</div>`;}
function similarScoreBadges(row){
 const item=similarViewItem(row.film.id),raw=item?.actualRating,actual=raw!==null&&raw!==undefined&&Number.isFinite(Number(raw))?Number(raw):null,prediction=row.prediction;
 if(actual===null&&!prediction)return '';
 const actualBadge=actual===null?'':`<div class="score-badge score-actual" aria-label="Моя оценка ${actual.toFixed(1)} из 5"><span>МОЯ ОЦЕНКА</span><strong>${actual.toFixed(1)}</strong></div>`;
 const chance=prediction&&Number.isFinite(prediction.probability)?Math.round(prediction.probability*100):null;
 const predictedBadge=prediction?`<div class="score-badge score-predicted" aria-label="Прогноз ${prediction.rating.toFixed(1)} из 5${chance===null?'':`, шанс оценки 4 и выше ${chance}%`}"><span>ПРОГНОЗ</span><strong>${prediction.rating.toFixed(1)}</strong>${chance===null?'':`<small>${chance}% на 4.0+</small>`}</div>`:'';
 return `<div class="film-score-badges">${actualBadge}${predictedBadge}</div>`;
}
function similarCard(row,now){
 const film=row.film,catalog=row.source==='catalog',scores=similarScoreBadges(row),airing=findsAiring(film,now,null);
 const year=film.year?String(film.year):'Год не указан',runtime=Number(film.runtime)>0?` · ${Math.round(Number(film.runtime))} мин`:'';
 const original=film.original&&film.original!==film.title?`<p class="original">${escapeHTML(film.original)}</p>`:'';
 const genres=(film.genres||[]).filter(Boolean);
 const both=scores.includes('score-actual')&&scores.includes('score-predicted');
 return `<article class="film-similar-card ${catalog?'is-catalog':'is-watchlist'}${scores?both?' has-both-scores':' has-score':''}" data-similar-source="${row.source}" data-similar-id="${escapeHTML(String(film.id))}">${scores}<div class="film-head"><div class="film-similar-poster">${catalog?similarBadge('new'):''}${soonBadge(film,{now,shows:findsWindowShows(film,now,null)})}${similarPoster(film)}</div><div class="film-info"><h3>${similarTitle(film)}${letterboxdLink(film,{catalog})}</h3>${original}<span class="film-year">${escapeHTML(year)}${runtime}</span>${genres.length?`<div class="film-tags">${genres.map(escapeHTML).join(' · ')}</div>`:''}${catalog?'':similarBadge(row.badge)}</div></div><p class="film-similar-airing">${escapeHTML(airing.text)}</p><p class="film-similar-reason">${escapeHTML(row.label)}</p></article>`;
}
// The last markup written into #film-similar-cards. An identical refresh keeps that DOM, so a focused title stays focused.
let similarMarkup='';
function similarFocusTarget(node){const card=node?.closest?.('.film-similar-card');if(!card)return null;if(node.dataset?.similarOpen)return {kind:'open',id:node.dataset.similarOpen};return null;}
function similarRestoreFocus(cards,target){if(!target||typeof cards.querySelectorAll!=='function')return;const next=target.kind==='open'?[...cards.querySelectorAll('[data-similar-open]')].find(node=>node.dataset.similarOpen===target.id):null;next?.focus?.();}
function renderSimilar(now=nowMs()){const section=$('#film-similar');if(!section)return [];const film=currentFilm(),picks=film?buildSimilar(film,now):[];section.hidden=picks.length===0;const cards=$('#film-similar-cards');if(cards){const html=picks.map(row=>similarCard(row,now)).join('');if(similarMarkup!==html){const active=document.activeElement,target=active&&cards.contains?.(active)?similarFocusTarget(active):null;cards.innerHTML=html;similarMarkup=html;if(target)similarRestoreFocus(cards,target);}}return picks;}
function findsLabels(film){
 const mechanics=(film.fingerprint?.plotMechanics||[]).filter(id=>MECHANIC_LABELS[id]).map(id=>MECHANIC_LABELS[id]);
 const moods=[...new Set([...(film.prediction?.moodIds||[]),...(film.fingerprint?.moodIds||[])])].filter(id=>MOOD_LABELS[id]).map(moodLabel);
 const out=[];if(mechanics[0])out.push(mechanics[0]);if(moods[0])out.push(moods[0]);if(out.length<2&&mechanics[1])out.push(mechanics[1]);if(out.length<2&&moods[1])out.push(moods[1]);
 return out.slice(0,2);
}
function findsMatchText(film,context){const matched=findsMatched(film,context);const facets=[...matched.mechanics.map(id=>MECHANIC_LABELS[id]),...matched.moods.map(moodLabel),...matched.genres].slice(0,3);return [...matched.people,...facets].join(' · ');}
function findsCard(film,now=nowMs(),scope=findsScope(),context=null){
 const p=film.prediction,airing=findsAiring(film,now,scope),labels=findsLabels(film),match=findsMatchText(film,context),chance=chance4Plus(p),original=film.original&&film.original!==film.title?film.original:'';
 const poster=film.poster?`<img class="poster" src="${escapeHTML(film.poster)}" alt="Постер ${escapeHTML(film.original||film.title||'')}" width="78" height="117" loading="lazy" referrerpolicy="no-referrer">`:`<div class="poster no-poster" aria-label="Постер недоступен">${escapeHTML(String(film.year||'Кино'))}</div>`;
 const label=escapeHTML(film.title||film.original||''),verifiedId=similarVerifiedIdentity(film)?'tmdb_'+film.tmdbId:null,title=verifiedId?`<a class="film-open" href="${filmHref(verifiedId)}" data-film-id="${escapeHTML(verifiedId)}">${label}</a>`:label;
 return `<article class="finds-card" data-finds-film="${escapeHTML(film.id)}"><div class="film-score-badges"><div class="score-badge score-predicted" aria-label="Прогноз ${p.predictedRating.toFixed(1)} из 5, шанс оценки 4 и выше ${chance}%"><span>ПРОГНОЗ</span><strong>${p.predictedRating.toFixed(1)}</strong><small>${chance}% на 4.0+</small></div></div><div class="film-head"><div class="finds-poster"><span class="finds-badge" title="Находка вне твоего watchlist" aria-label="Находка вне watchlist">NEW</span>${airing.availability?.state==='soon'?soonBadge(film,{now,shows:findsWindowShows(film,now,scope)}):''}${poster}</div><div class="film-info"><h3>${title}${letterboxdLink(film,{catalog:true})}</h3>${original?`<p class="original">${escapeHTML(original)}</p>`:''}<span class="film-year">${escapeHTML(String(film.year||'Год не указан'))}${Number(film.runtime)>0?` · ${Math.round(Number(film.runtime))} мин`:''}</span><div class="film-tags">${(film.genres||[]).map(escapeHTML).join(' · ')}</div></div></div>${labels.length?`<div class="film-moods finds-labels">${labels.map(label=>`<span>${escapeHTML(label)}</span>`).join('')}</div>`:''}${match?`<p class="finds-match">Совпадает с фильтрами: ${escapeHTML(match)}</p>`:''}<p class="finds-airing" data-airing="${airing.kind}">${escapeHTML(airing.text)}</p>${findsMarkAction(film)}</article>`;
}
function findsMarkAction(film){
 if(!findsSource.watchedMarkEnabled||!film.tmdbId)return '';
 const mark=findsMarks.get(String(film.tmdbId)),saving=mark?.state==='saving',title=film.title||film.original||'';
 return `<div class="finds-actions"><button type="button" class="finds-watched" data-finds-watched="${escapeHTML(String(film.tmdbId))}" ${saving?'disabled aria-busy="true"':''} aria-label="Отметить «${escapeHTML(title)}» как просмотренный">${saving?'Сохраняю…':'Смотрел'}</button>${mark?.state==='error'?`<span class="finds-mark-error" role="alert">${escapeHTML(mark.message)}</span>`:''}</div>`;
}
function findsNoticeHTML(){
 if(!findsNotice)return '';
 const {tmdbId,title,state,message}=findsNotice;
 if(state==='error')return `<span role="alert">${escapeHTML(message)}</span>`;
 if(state==='undone')return `<span>«${escapeHTML(title)}» снова в «Находках».</span>`;
 return `<span>«${escapeHTML(title)}» отмечен как просмотренный.</span> <button type="button" class="finds-undo" data-finds-undo="${escapeHTML(tmdbId)}" ${state==='saving'?'disabled aria-busy="true"':''}>${state==='saving'?'Отменяю…':'Отменить'}</button>`;
}
async function postWatchedMark(tmdbId,watched){
 const response=await fetch('/api/catalog/watched',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tmdbId,watched})});
 const data=await response.json().catch(()=>null);
 if(!response.ok||!data||typeof data.watched!=='boolean')throw new Error(data?.code==='film_not_in_catalog'?'Фильм уже не в каталоге, обновляю «Находки»':'Не удалось сохранить, попробуй ещё раз');
 return data;
}
async function markFindWatched(tmdbId){
 const film=(findsSource.films||[]).find(item=>String(item.tmdbId)===tmdbId);if(!film||findsMarks.get(tmdbId)?.state==='saving')return;
 const title=film.title||film.original||'';
 findsMarks.set(tmdbId,{state:'saving'});renderFinds();
 try{
  const data=await postWatchedMark(tmdbId,true);
  if(!data.watched)throw new Error('Отметка не сохранилась: более новое значение говорит «не смотрел»');
  findsMarks.set(tmdbId,{state:'marked'});findsNotice={tmdbId,title,state:'marked'};
 }catch(error){findsMarks.set(tmdbId,{state:'error',message:error.message});}
 renderFinds();
 // The marked card is gone, so keyboard focus moves to the undo; after an error it stays on the card's button.
 (findsMarks.get(tmdbId)?.state==='marked'?$('#finds-notice [data-finds-undo]'):document.querySelector(`[data-finds-watched="${tmdbId}"]`))?.focus();
 if(findsMarks.get(tmdbId)?.state==='marked'||/каталоге/.test(findsMarks.get(tmdbId)?.message||''))loadCatalog();
}
async function undoFindWatched(tmdbId){
 if(!findsNotice||findsNotice.tmdbId!==tmdbId||findsNotice.state==='saving')return;
 findsNotice={...findsNotice,state:'saving'};renderFinds();
 try{
  const data=await postWatchedMark(tmdbId,false);
  if(data.watched)throw new Error('Отмена не сохранилась: более новое значение говорит «смотрел»');
  findsMarks.delete(tmdbId);findsNotice={...findsNotice,state:'undone'};
 }catch(error){findsNotice={...findsNotice,state:'error',message:error.message};}
 renderFinds();
 // The undone film comes back with the next catalog answer; focus follows it there.
 await loadCatalog();
 (document.querySelector(`[data-finds-watched="${tmdbId}"]`)||$('#finds-notice [data-finds-undo]'))?.focus();
}
function onFindsClick(event){
 const opener=event.target.closest?.('a.film-open');
 if(opener){if(!plainFilmActivation(event))return;event.preventDefault?.();openFilm(opener.dataset?.filmId||filmIdFromLocation(opener.href||''));return;}
 const mark=event.target.closest('[data-finds-watched]');if(mark&&!mark.disabled){markFindWatched(mark.dataset.findsWatched);return;}
 const undo=event.target.closest('[data-finds-undo]');if(undo&&!undo.disabled)undoFindWatched(undo.dataset.findsUndo);
}
// The cached catalog answer is usable only for the generation the loaded programme is on. A generation change with no catalog
// answer for it yet (or a 409 while the new generation is still copying) hides the section instead of showing the old shows.
function findsFresh(){const run=report?.runId??null;return !!findsSource.ready&&!!findsSource.programmeRunId&&!!run&&findsSource.programmeRunId===run;}
const FINDS_PERIOD_LABELS={archive:'архив',future:'следующие сутки'};
function findsTitle(scope){return !scope?.channels?'Находки':scope.channels.size>1?'Находки на выбранных каналах':'Находки на выбранном канале';}
function findsCaption(count,scope,contextual=false){
 if(!count)return '';
 const filters=contextual?' по выбранным фильтрам':'';
 if(!scope)return contextual?`${count} ${filmWord(count)} вне watchlist по выбранным фильтрам: сильный прогноз и реальный показ`:`${count} ${filmWord(count)} вне watchlist: сильный прогноз и реальный показ`;
 const period=FINDS_PERIOD_LABELS[scope.period];
 if(!scope.channels)return `${count} ${filmWord(count)} вне watchlist${filters}${period?` · ${period}`:''}`;
 const channels=[...scope.channels].sort((a,b)=>a.localeCompare(b,'ru')).join(', ');
 return `${count} ${filmWord(count)} вне watchlist${filters} с показом на ${scope.channels.size>1?'каналах':'канале'} ${channels}${period?` · ${period}`:''}`;
}
// With a channel, period or other filter the finds follow, the watchlist grid and the finds are two sections of one query: the grid
// gets its own heading, an empty section is not shown, and the shared empty state appears only when both sections are empty.
let resultsView={visible:0,valid:true};
function syncResultSections(findsCount,findsExplained){
 const scoped=!!findsScope()||findsContextActive(findsContext());
 const heading=$('#watchlist-title');if(heading)heading.hidden=!(scoped&&resultsView.valid&&resultsView.visible>0);
 const empty=$('#empty');if(empty)empty.hidden=resultsView.visible>0||!resultsView.valid||scoped&&findsCount>0||!!findsExplained;
}
function renderFinds(now=nowMs()){
 const node=$('#finds');if(!node){syncResultSections(0);return [];}
 syncFindsPeople();
 const scope=findsScope(),context=findsContext();
 const list=findsFresh()?buildFinds(findsSource.films,now,scope,context):[];
 const person=context.people,blocked=!context.valid||context.startedOnly||context.viewing==='rewatch';
 const shown=!!(person?.active&&findsFresh()&&!blocked);
 const pending=shown&&person.pending;
 const status=!shown?'':person.reason==='checking'?'<p class="finds-person-status" role="status">Проверяем фильмы этого человека…</p>':person.reason==='error'?'<p class="finds-person-status" role="alert">Не удалось проверить фильмы этого человека. Список watchlist не изменён.</p>':person.reason==='refused'?'<p class="finds-person-status" role="status">Связь этого человека с каталогом не подтверждена. Список watchlist не изменён.</p>':person.ready&&list.length===0?'<p class="finds-person-status" role="status">В «Находках» нет подходящих фильмов этого человека. Список watchlist не изменён.</p>':'';
 // A re-render replaces the buttons; keyboard focus on a mark or undo button is put back on its replacement.
 const active=document.activeElement,refocus=active?.dataset?.findsWatched?`[data-finds-watched="${active.dataset.findsWatched}"]`:active?.dataset?.findsUndo?`[data-finds-undo="${active.dataset.findsUndo}"]`:null;
 const notice=$('#finds-notice');if(notice){const html=findsNoticeHTML();if(notice.innerHTML!==html)notice.innerHTML=html;notice.hidden=!findsNotice;}
 if(typeof node.setAttribute==='function')node.setAttribute('aria-busy',pending?'true':'false');
 node.hidden=list.length===0&&!findsNotice&&!status;
 const title=$('#finds-title');if(title)title.textContent=findsTitle(scope);
 const cards=$('#finds-cards');if(cards)cards.innerHTML=status+list.map(film=>findsCard(film,now,scope,context)).join('');
 const caption=$('#finds-caption');if(caption)caption.textContent=findsCaption(list.length,scope,findsContextActive(context));
 syncResultSections(list.length,!!status);
 if(refocus&&document.activeElement!==active)document.querySelector(refocus)?.focus();
 renderSimilar(now);
 return list;
}
async function loadCatalog(){
 if(findsLoading)return 'busy';
 findsLoading=true;
 try{
  const response=await fetch('/api/catalog/available');
  if(!response.ok)throw new Error();
  const data=await response.json();
  if(!data||!Array.isArray(data.films))throw new Error();
  findsSource={films:data.films,programmeRunId:data.programmeRunId??null,generatedAt:data.generatedAt??null,ready:true,error:false,watchedMarkEnabled:data.watchedMarkEnabled===true};
  renderFinds();
  return true;
 }catch{
  // A failed refresh keeps the previous answer only while the programme stays on that answer's generation (findsFresh); eligibility is never invented on the client.
  findsSource={...findsSource,error:true};
  renderFinds();
  return false;
 }finally{findsLoading=false;}
}

function render(){
  const validYear = Number.isInteger(state.from)&&Number.isInteger(state.to)&&state.from>=1900&&state.to<=MAX_YEAR&&state.from<=state.to;
  const validRuntime = state.maxRuntime===null||(Number.isInteger(state.maxRuntime)&&state.maxRuntime>0);
  const valid=validYear&&validRuntime;
  $('#year-error').hidden=validYear;$('#runtime-error').hidden=validRuntime;
  document.querySelectorAll('[data-year-from]').forEach(b=>b.setAttribute('aria-pressed',String(validYear&&state.from===Number(b.dataset.yearFrom)&&state.to===(b.dataset.yearTo==='current'?MAX_YEAR:Number(b.dataset.yearTo)))));
  document.querySelectorAll('[data-runtime-max]').forEach(b=>b.setAttribute('aria-pressed',String(validRuntime&&state.maxRuntime===(b.dataset.runtimeMax==='any'?null:Number(b.dataset.runtimeMax)))));
  document.querySelectorAll('[data-viewing]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.viewing===state.viewing));b.disabled=b.dataset.viewing!=='any'&&!ratingsLoaded;});
  document.querySelectorAll('[data-min-prediction]').forEach(b=>{b.setAttribute('aria-pressed',String(state.minPrediction===(b.dataset.minPrediction==='any'?null:Number(b.dataset.minPrediction))));b.disabled=b.dataset.minPrediction!=='any'&&!ratingsLoaded;});
  document.querySelectorAll('[data-min-probability]').forEach(b=>{b.setAttribute('aria-pressed',String(state.minProbability===(b.dataset.minProbability==='any'?null:Number(b.dataset.minProbability))));b.disabled=b.dataset.minProbability!=='any'&&!ratingsLoaded;});
  $('#filter-summary').textContent = state.includeUnscheduled || state.startedOnly || state.lastChanceOnly || state.viewing!=='any' || state.minPrediction!==null || state.minProbability!==null || state.directors || state.actors || state.genres.size || state.mechanics.size || state.moods.size || state.channels.size || executionActive() || state.from!==1900 || state.to!==MAX_YEAR || state.maxRuntime!==null ? `${state.genres.size ? [...state.genres].join(', ') : 'Все жанры'} · ${state.from}–${state.to}${state.maxRuntime!==null?' · до '+state.maxRuntime+' мин':''}${state.mechanics.size?' · Механика: '+[...state.mechanics].map(m=>MECHANIC_LABELS[m]).join(', '):''}${state.moods.size?' · Настроение: '+[...state.moods].map(moodLabel).join(', '):''}${state.channels.size?' · Канал: '+[...state.channels].join(', '):''}${executionSummary()}${state.directors?' · Режиссёр':''}${state.actors?' · Актёр':''}${state.startedOnly?' · Начатые':''}${state.lastChanceOnly?' · Последний шанс':''}${state.viewing==='new'?' · Новые':state.viewing==='rewatch'?' · Пересмотр':''}${state.minPrediction!==null?' · Прогноз '+state.minPrediction.toFixed(1)+'+':''}${state.minProbability!==null?' · Шанс '+Math.round(state.minProbability*100)+'%+':''}${state.includeUnscheduled?' · Без показов тоже':''}` : 'Все фильмы';
 if(typeof syncFacetPickers==='function')syncFacetPickers();
  ['#year-from','#year-to'].forEach(s=>$(s).setAttribute('aria-invalid',String(!validYear)));
  $('#runtime-max').setAttribute('aria-invalid',String(!validRuntime));
  const filtered=valid?films.filter(eligible):[];
  for(const p of ['all','archive','future'])$(`#count-${p}`).textContent=filtered.filter(f=>countedScope(f,p)).length;
  document.querySelectorAll('[data-period]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.period===state.period)));
  const visible=valid?visibleFilms():[];
  $('#movies').innerHTML=visible.map(card).join('');
  renderShortlist(visible,valid);
  resultsView={visible:visible.length,valid};
  renderFinds();
  armSoonTick();
  const emptyCopy=$('#empty p');if(emptyCopy)emptyCopy.textContent=blackZone()&&state.lastChanceOnly?'Последний шанс сейчас не к чему применить: доступных показов нет.':'Измени название, выбери другой жанр или расширь диапазон лет.';
  updateProgrammeStatus();
  const shows=visible.reduce((n,f)=>n+periodShows(f).length,0);
  $('#result-count').textContent=valid?`${visible.length} ${filmWord(visible.length)} · ${shows} ${showWord(shows)}`:!validYear?'Проверь диапазон лет':'Проверь длительность';
  const sortBox=$('#sort');if(sortBox)sortBox.value=state.sort;
 syncSearchControls();
  syncUrl();
  if(filmScreen)renderFilmShell();
  noteTimeView(valid?visible:[]);
  return {period:state.period,query:state.query,genres:[...state.genres],mechanics:[...state.mechanics],moods:[...state.moods],years:[state.from,state.to],maxRuntime:state.maxRuntime,minPrediction:state.minPrediction,minProbability:state.minProbability,films:visible.map(f=>({id:f.id,title:f.title,year:f.year,shows:periodShows(f)}))};
}
function reset(){state.shortlistMode='now';state.viewing='any';state.minPrediction=null;state.minProbability=null;state.includeUnscheduled=false;$('#include-unscheduled').checked=false;state.startedOnly=false;$('#started-only').checked=false;state.lastChanceOnly=false;$('#last-chance-only').checked=false;for(const key of ['directors','actors']){state[key]='';$('#'+key+'-input').value='';$('#'+key+'-options').hidden=true;$('#'+key+'-input').setAttribute('aria-expanded','false');}state.period='all';state.sort='personal';state.sortExplicit=false;state.query='';state.searchScopes=defaultSearchScopes();state.genres.clear();state.mechanics.clear();state.moods.clear();state.channels.clear();for(const selected of Object.values(state.execution))selected.clear();closeFacet();state.from=1900;state.to=MAX_YEAR;state.maxRuntime=null;$('#year-from').value=1900;$('#year-to').value=MAX_YEAR;$('#runtime-max').value='';for(const selector of ['#genres input','#mechanics input','#moods input','#execution input'])document.querySelectorAll(selector).forEach(i=>i.checked=false);render();}
function applyFilters(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Expected a filters object');
 if(input.includeUnscheduled!==undefined&&typeof input.includeUnscheduled!=='boolean')throw new Error('Invalid watchlist scope');
 if(input.lastChanceOnly!==undefined&&typeof input.lastChanceOnly!=='boolean')throw new Error('Invalid last-chance filter');
 if(input.viewing!==undefined&&!['any','new','rewatch'].includes(input.viewing))throw new Error('Invalid viewing filter');
 if(input.minPrediction!==undefined&&![null,3.5,4,4.5].includes(input.minPrediction))throw new Error('Invalid prediction threshold');
 if(input.minProbability!==undefined&&![null,0.5,0.7,0.85].includes(input.minProbability))throw new Error('Invalid probability threshold');
 if(input.query!==undefined&&typeof input.query!=='string')throw new Error('Invalid search query');
 if(input.period!==undefined&&!['all','archive','future'].includes(input.period))throw new Error('Invalid period');
 if(input.genres!==undefined&&(!Array.isArray(input.genres)||input.genres.some(g=>!genres.includes(g))))throw new Error('Invalid genre');
 if(input.mechanics!==undefined&&(!Array.isArray(input.mechanics)||input.mechanics.some(m=>!mechanics.includes(m))))throw new Error('Invalid mechanic');
 if(input.moods!==undefined&&(!Array.isArray(input.moods)||input.moods.some(m=>!moods.includes(m))))throw new Error('Invalid mood');
 const from=input.from??state.from,to=input.to??state.to,maxRuntime=input.maxRuntime===undefined?state.maxRuntime:input.maxRuntime;
 if(!Number.isInteger(from)||!Number.isInteger(to)||from<1900||to>MAX_YEAR||from>to)throw new Error('Invalid year range');
 if(maxRuntime!==null&&(!Number.isInteger(maxRuntime)||maxRuntime<1))throw new Error('Invalid maximum runtime');
 state.includeUnscheduled=input.includeUnscheduled??state.includeUnscheduled;$('#include-unscheduled').checked=state.includeUnscheduled;
 state.lastChanceOnly=input.lastChanceOnly??state.lastChanceOnly;$('#last-chance-only').checked=state.lastChanceOnly;
 state.viewing=input.viewing??state.viewing;
 state.minPrediction=input.minPrediction===undefined?state.minPrediction:input.minPrediction;
 state.minProbability=input.minProbability===undefined?state.minProbability:input.minProbability;
 state.query=input.query??state.query;
 state.period=input.period??state.period;state.genres=new Set(input.genres??state.genres);state.mechanics=new Set(input.mechanics??state.mechanics);state.moods=new Set(input.moods??state.moods);
 state.from=from;state.to=to;state.maxRuntime=maxRuntime;
 $('#year-from').value=from;$('#year-to').value=to;$('#runtime-max').value=maxRuntime??'';
 document.querySelectorAll('#genres input').forEach(i=>i.checked=state.genres.has(i.value));
 document.querySelectorAll('#mechanics input').forEach(i=>i.checked=state.mechanics.has(i.value));
 document.querySelectorAll('#moods input').forEach(i=>i.checked=state.moods.has(i.value));
 return render();
}
const LIVE_REFRESH_MS=60000;
let programmeKey='',programmeSeen=false,programmeReady=false,programmeLoading=false;
let enrichmentKey='',enrichmentLoading=false,footerReady=false,footerLoading=false,footerReadAt=0;
let liveTimer=null,liveHandlers=null,liveRunning=false,livePending=false,liveCoalesced=false,controlsReady=false;
function setYearBounds(followValue){
 const yearTo=$('#year-to'),yearFrom=$('#year-from'),yearError=$('#year-error');
 if(yearTo){yearTo.max=MAX_YEAR;if(followValue)yearTo.value=state.to;}
 if(yearFrom)yearFrom.max=MAX_YEAR;
 if(yearError)yearError.textContent=`Укажи годы от 1900 до ${MAX_YEAR}; «от» не должно быть больше «до».`;
}
function syncPeopleSources(){
 for(const key of ['directors','actors']) peopleSources[key]=(report.people?.[key]||[]).slice().sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'ru',{sensitivity:'base'}));
}
function refreshGenreOptions(){
 const box=$('#genres');if(!box)return;
 const counts=new Map();
 for(const film of films) for(const genre of film.genres||[]) counts.set(genre,(counts.get(genre)||0)+1);
 const ordered=[...counts.keys()].sort((a,b)=>a.localeCompare(b,'ru'));
 for(const genre of state.genres) if(!counts.has(genre)) ordered.push(genre);
 genres=ordered;
 box.innerHTML=ordered.map(genre=>`<label class="genre-label"><input type="checkbox" value="${escapeHTML(genre)}"><span>${escapeHTML(genre)}</span><span class="genre-count">${counts.get(genre)||0}</span></label>`).join('');
 document.querySelectorAll('#genres input').forEach(input=>input.checked=state.genres.has(input.value));
}
let gridTimeKey='',shortTimeKey='',statusTimeKey='';
function showBucket(show){return isFuture(show)?'f':isArchive(show)?'a':'x';}
function gridTimeKeyOf(visible){const model=viewingWindow();const counts=['archive','future'].map(period=>films.filter(film=>eligible(film)&&countedScope(film,period)).length).join(',');return visible.map(film=>`${film.id}:${isLastChance(film)?1:0}:${(film.shows||[]).map(show=>`${showStart(show)}:${showBucket(show)}`).join(',')}`).join('|')+`|${model.black?1:0}|${counts}`;}
function shortTimeKeyOf(visible){return ['now','today'].map(mode=>buildShortlist(visible,mode).map(item=>`${item.film.id}:${item.availability.kind}:${item.availability.show?.start??''}:${item.availability.show?.end??''}`).join(',')).join(';');}
function noteTimeView(visible=visibleFilms()){gridTimeKey=gridTimeKeyOf(visible);shortTimeKey=shortTimeKeyOf(visible);statusTimeKey=JSON.stringify(programmeStatus());}
function refreshTimeSensitiveView(){
 if(!report)return;
 const visible=visibleFilms(),grid=gridTimeKeyOf(visible),short=shortTimeKeyOf(visible),status=JSON.stringify(programmeStatus());
 if(grid!==gridTimeKey){renderPreservingScroll();return;}
 if(short!==shortTimeKey){shortTimeKey=short;renderShortlist(visible);}
 if(status!==statusTimeKey){statusTimeKey=status;updateProgrammeStatus();}
}
function installProgramme(data){
 const key=JSON.stringify(data);
 if(programmeSeen&&key===programmeKey)return false;
 const previousMax=MAX_YEAR,followYear=!programmeSeen||state.to===previousMax;
 programmeSeen=true;programmeKey=key;report=data;
 MAX_YEAR=Math.max(previousMax,...report.films.map(f=>Number(f.year)||0));
 if(followYear)state.to=MAX_YEAR;
 setYearBounds(followYear);
 ({start:WINDOW_START,cutoff:CUTOFF,end:WINDOW_END}=programmeWindow(report));
 films=report.films.map(f=>({...f,genres:f.genres?.length?f.genres:['Жанр не указан'],shows:(f.shows||[]).map(s=>({...s,offset:(s.start-CUTOFF)/3600000}))}));
 genres=[...new Set(films.flatMap(f=>f.genres))].sort((a,b)=>a.localeCompare(b,'ru'));
 syncPeopleSources();
 return true;
}
function renderPreservingScroll(){
 const y=window.scrollY||0;
 const activity=document.querySelector('.activity-scroll');
 const top=activity?activity.scrollTop:0;
 const open=typeof document.querySelectorAll==='function'?[...document.querySelectorAll('#movies details[open]')].map(node=>({id:node.closest?.('article')?.dataset?.filmId,kind:String(node.className||'').includes('film-synopsis')?'film-synopsis':'more'})):[];
 render();
 if(activity)activity.scrollTop=top;
 if(typeof window.scrollTo==='function')window.scrollTo(0,y);
 for(const item of open){if(!item.id)continue;const card=document.querySelector(`#movies article[data-film-id="${String(item.id).replace(/"/g,'')}"]`);const node=card?.querySelector?.(`details.${item.kind}`);if(node)node.open=true;}
}
function showProgrammeUnavailable(error){
 $('#result-count').textContent='Программа временно недоступна';
 const updated=$('#snapshot-updated');if(updated)updated.textContent=error.message;else if($('#snapshot'))$('#snapshot').textContent=error.message;
 const badge=$('#connection-badge');if(badge){badge.textContent='Ошибка обновления';badge.title='Программу не удалось загрузить. Это не статус сохранённого окна.';badge.classList?.remove('is-ok','is-warning','is-critical');badge.classList?.add('is-error');}
}
async function registerModelTool(){
 if(document.modelContext?.registerTool){try{await document.modelContext.registerTool({name:'filter_watchlist_programme',title:'Фильтровать кинопрограмму',description:'Apply title search, genre, plot mechanics, mood, year, runtime, prediction, probability, last-chance and broadcast period filters. Values within each multi-select use OR; filter groups combine with AND. Returns the visible films and broadcasts.',inputSchema:{type:'object',properties:{includeUnscheduled:{type:'boolean',description:'Include watchlist films with no broadcasts in the saved EPG window'},lastChanceOnly:{type:'boolean',description:'Only films with less than eight hours before their last known showing leaves the 72-hour archive window'},viewing:{type:'string',enum:['any','new','rewatch'],description:'Filter by absence or presence of a personal Letterboxd rating'},minPrediction:{type:['number','null'],enum:[null,3.5,4,4.5],description:'Minimum saved predicted rating; null removes the filter'},minProbability:{type:['number','null'],enum:[null,0.5,0.7,0.85],description:'Minimum saved probability of a 4.0+ rating; null removes the filter'},query:{type:'string',description:'Text matched only against the search scopes currently selected on the page. Titles are the default.'},period:{type:'string',enum:['all','archive','future']},genres:{type:'array',items:{type:'string',enum:genres}},mechanics:{type:'array',items:{type:'string',enum:Object.keys(MECHANIC_LABELS)}},moods:{type:'array',items:{type:'string'},description:'Canonical mood IDs currently offered by the page'},from:{type:'integer',minimum:1900,maximum:MAX_YEAR},to:{type:'integer',minimum:1900,maximum:MAX_YEAR},maxRuntime:{type:['integer','null'],minimum:1,description:'Maximum film runtime in minutes; null removes the runtime filter'}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:applyFilters});}catch(e){console.info('Browser tools unavailable',e.message);}}
}
let presets=[],presetsEtag='"none"',presetEditor=null,presetPrompt=null,presetStatus='',presetSaving=false;
function presetQuery(){return urlForState('https://iptv.example/').searchParams.toString();}
function applyPresetQuery(query){
 const url=new URL(window.location.href);
 for(const key of APP_QUERY_KEYS)url.searchParams.delete(key);
 for(const [key,value] of new URLSearchParams(String(query||'')))if(APP_QUERY_KEYS.includes(key))url.searchParams.append(key,value);
 window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash);
 restoreUrl();
 syncUrl();
}
// A saved scenario is "current" only when its canonical app parameters equal the filters on screen. A manual change drops the mark.
function presetKey(query){const keys=new Set(APP_QUERY_KEYS);return [...new URLSearchParams(String(query||''))].filter(([key])=>keys.has(key)).map(([key,value])=>key+'='+value).sort().join('&');}
function presetIsCurrent(preset,key){return !!preset&&key!==null&&presetKey(preset.query)===key;}
function currentPresetKey(){try{return presetKey(presetQuery());}catch{return null;}}
function markCurrentPreset(){
 const list=$('#preset-list');if(!list||!presets.length)return;
 const key=currentPresetKey();
 for(const row of list.querySelectorAll?.('.preset-row')||[]){
  const apply=row.querySelector('[data-preset-apply]'),on=presetIsCurrent(presets.find(item=>item.id===apply?.dataset?.presetApply),key);
  row.classList.toggle('is-current',on);
  if(on)apply.setAttribute('aria-current','true');else apply.removeAttribute?.('aria-current');
 }
}
function focusPreset(selector){const node=$(selector);if(node&&node.focus)node.focus();}
function closePresetEditor(returnTo){
 presetEditor=null;presetStatus='';renderPresets();
 focusPreset(returnTo==='save'?'#preset-save':'#preset-list [data-preset-apply="'+String(returnTo).replace(/"/g,'')+'"]');
}
function renderPresets(){
 const list=$('#preset-list'),empty=$('#presets-empty'),status=$('#preset-status'),editor=$('#preset-editor'),add=$('#preset-save');
 if(!list||!empty||!status)return;
 empty.hidden=presets.length>0;
 status.textContent=presetStatus;
 if(editor)editor.hidden=!presetEditor;
 // One "save" call to action at a time: the head button gives way to the editor's own primary button.
 if(add)add.hidden=!!presetEditor;
 const key=currentPresetKey();
 list.innerHTML=presets.map(preset=>{
  const prompt=presetPrompt?.id===preset.id,current=presetIsCurrent(preset,key);
  const actions=prompt?`<p class="preset-confirm">${presetPrompt.action==='delete'?'Удалить этот сценарий?':'Заменить сохранённые условия текущими?'}</p><button type="button" data-preset-confirm="${presetPrompt.action}">Да</button><button type="button" data-preset-dismiss>Нет</button>`:`<button type="button" data-preset-rename>Переименовать</button><button type="button" data-preset-update>Обновить</button><button type="button" data-preset-delete>Удалить</button>`;
  return `<li class="preset-row${current?' is-current':''}"><button type="button" class="preset-apply" data-preset-apply="${escapeHTML(preset.id)}" title="${escapeHTML(preset.name)}"${current?' aria-current="true"':''}>${escapeHTML(preset.name)}</button><details class="preset-actions"${prompt?' open':''}><summary aria-label="Действия: ${escapeHTML(preset.name)}">⋯</summary><div>${actions}</div></details></li>`;
 }).join('');
}
async function loadPresets(){
 try{const response=await fetch('/api/ui/filter-presets');if(!response.ok)throw new Error();const data=await response.json();presets=Array.isArray(data.presets)?data.presets:[];presetsEtag=response.headers.get('ETag')||'"none"';}
 catch{presetStatus='Не удалось загрузить сценарии.';}
 renderPresets();
}
async function sendPreset(method,path,body){
 if(presetSaving)return false;
 presetSaving=true;
 try{
  const headers={'If-Match':presetsEtag},options={method,headers};
  if(body){headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  const response=await fetch(path,options);
  if(response.status===412){await loadPresets();presetStatus='Сценарии изменились на другом устройстве. Список обновлён — повтори действие.';renderPresets();return false;}
  if(!response.ok){presetStatus=response.status===400?'Проверь название или число сценариев: их может быть не больше 30.':'Не удалось сохранить сценарий.';renderPresets();return false;}
  const data=await response.json();
  presets=Array.isArray(data.presets)?data.presets:presets;
  presetsEtag=response.headers.get('ETag')||presetsEtag;
  presetStatus='';presetEditor=null;presetPrompt=null;renderPresets();
  return true;
 }catch{presetStatus='Не удалось сохранить сценарий.';renderPresets();return false;}
 finally{presetSaving=false;}
}
function createPreset(name){return sendPreset('POST','/api/ui/filter-presets',{name,query:presetQuery()});}
function renamePreset(id,name){return sendPreset('PATCH','/api/ui/filter-presets/'+encodeURIComponent(id),{name});}
function updatePreset(id){return sendPreset('PATCH','/api/ui/filter-presets/'+encodeURIComponent(id),{query:presetQuery()});}
function deletePreset(id){return sendPreset('DELETE','/api/ui/filter-presets/'+encodeURIComponent(id));}
function addChannelFilter(name){
 const channel=typeof name==='string'?name:'';
 if(!channel.trim()||state.channels.has(channel))return;
 state.channels.add(channel);
 if(urlReady&&window.history?.pushState&&!filmIdFromLocation()){
  const next=urlForState(window.location.href);
  const target=next.pathname+next.search+next.hash;
  const current=new URL(window.location.href);
  if(target!==current.pathname+current.search+current.hash)window.history.pushState(window.history.state,'',target);
 }
 render();
 const scope=filmIdFromLocation()?'#film-screen [data-channel]':'[data-channel]';
 const button=[...document.querySelectorAll(scope)].find(node=>node.dataset?.channel===channel)||[...document.querySelectorAll('[data-channel]')].find(node=>node.dataset?.channel===channel);
 button?.focus?.({preventScroll:true});
}
function onMovieClick(event){
 const channel=event.target.closest?.('[data-channel]');
 if(channel){event.preventDefault?.();event.stopPropagation?.();addChannelFilter(channel.dataset.channel);return;}
 const mark=event.target.closest?.('[data-started-id]');
 if(mark)return toggleStarted(mark.dataset.startedId);
 const credit=event.target.closest?.('[data-credit-id]');
 if(credit){selectPerson(credit.dataset.creditKind,credit.dataset.creditId);return;}
 const facet=event.target.closest?.('[data-facet-kind]');
 if(facet){selectFacet(facet.dataset.facetKind,facet.dataset.facetValue,facet.dataset.facetDimension);return;}
 const historyAction=event.target.closest?.('[data-history-action]');
 if(historyAction){filmHistoryAction(historyAction.dataset.historyAction);return;}
 const similarOpen=event.target.closest?.('[data-similar-open]');
 if(similarOpen){event.preventDefault?.();openFilm(similarOpen.dataset.similarOpen);return;}
 const compared=event.target.closest?.('[data-compare-open]');
 if(compared){event.preventDefault?.();openComparedFilm(compared.dataset.compareOpen);return;}
 const opener=event.target.closest?.('a.film-open');
 if(opener){if(!plainFilmActivation(event))return;event.preventDefault?.();openFilm(opener.dataset?.filmId||filmIdFromLocation(opener.href||''));return;}
 if(event.target.closest?.(FILM_CONTROL))return;
 const card=event.target.closest?.('article.movie-card');
 if(card?.dataset?.filmId)openFilm(card.dataset.filmId);
}
function bindControls(){
 if(controlsReady)return;
 controlsReady=true;
 window.addEventListener('popstate',onHistoryNavigation);
 $('#include-unscheduled').addEventListener('change',e=>{state.includeUnscheduled=e.target.checked;render();});
 $('#started-only').addEventListener('change',e=>{state.startedOnly=e.target.checked;render();});
 $('#last-chance-only').addEventListener('change',e=>{state.lastChanceOnly=e.target.checked;render();});
 document.querySelectorAll('[data-viewing]').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled){state.viewing=b.dataset.viewing;render();}}));
 document.querySelectorAll('[data-min-prediction]').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled){state.minPrediction=b.dataset.minPrediction==='any'?null:Number(b.dataset.minPrediction);render();}}));
 document.querySelectorAll('[data-min-probability]').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled){state.minProbability=b.dataset.minProbability==='any'?null:Number(b.dataset.minProbability);render();}}));
 $('#progress-retry').addEventListener('click',()=>loadStarted());
 // A film card is a real link: before a new-tab open or a copy it takes the programme's current state as its return target.
 const refreshFilmLink=event=>{const link=event.target.closest?.('a.film-open');if(!link||!onHomeScreen())return;const id=link.dataset?.filmId;if(id)link.setAttribute('href',ReturnHome.withReturn(filmHref(id),homeTarget()));};
 for(const type of ['pointerdown','focusin','contextmenu'])$('#movies').addEventListener(type,refreshFilmLink);
 $('#movies').addEventListener('click',onMovieClick);
 for(const type of ['pointerdown','focusin','contextmenu'])$('#finds')?.addEventListener(type,refreshFilmLink);
 $('#finds')?.addEventListener('click',onFindsClick);
 $('#film-screen')?.addEventListener('click',onMovieClick);
 document.querySelectorAll('[data-shortlist-mode]').forEach(button=>button.addEventListener('click',()=>{state.shortlistMode=button.dataset.shortlistMode;render();}));
 $('#shortlist').addEventListener('click',event=>{const button=event.target.closest('[data-shortlist-film]');if(!button)return;const target=[...document.querySelectorAll('.movie-card')].find(card=>card.dataset.filmId===button.dataset.shortlistFilm);if(target){target.scrollIntoView({behavior:'smooth',block:'start'});target.setAttribute('tabindex','-1');target.focus({preventScroll:true});}});
 $('#sort').addEventListener('change',e=>{state.sort=e.target.value;state.sortExplicit=true;render();});
 $('#search').addEventListener('input',e=>{applySearchInput(e.target.value);render();});
 document.querySelectorAll('[data-search-scope]').forEach(button=>{
  button.addEventListener('mousedown',event=>event.preventDefault());
  button.addEventListener('click',()=>{
   if(button.getAttribute('aria-disabled')==='true')return;
   if(!setSearchScope(button.dataset.searchScope,!activeSearchScopes(state.searchScopes)[button.dataset.searchScope])){syncSearchControls();return;}
   render();
  });
 });
 const genresBox=$('#genres');if(genresBox)genresBox.addEventListener('change',e=>{const i=e.target;i.checked?state.genres.add(i.value):state.genres.delete(i.value);render();});
 for(const [selector,key] of [['#mechanics','mechanics'],['#moods','moods']]){const box=$(selector);if(box)box.addEventListener('change',e=>{const input=e.target;if(input.tagName!=='INPUT')return;input.checked?state[key].add(input.value):state[key].delete(input.value);render();});}
 const executionBox=$('#execution');if(executionBox)executionBox.addEventListener('change',e=>{const input=e.target;if(!input||input.tagName!=='INPUT')return;const selected=state.execution[input.dataset.execution];if(!selected)return;input.checked?selected.add(input.value):selected.delete(input.value);render();});
 const moodSearch=$('#mood-search');if(moodSearch)moodSearch.addEventListener('input',filterMoodOptions);
 document.querySelectorAll('.facet-trigger').forEach(button=>button.addEventListener('click',()=>{if(openFacetName===button.dataset.facet)closeFacet();else openFacet(button.dataset.facet,button);}));
 const facetBody=$('#facet-body');if(facetBody)facetBody.addEventListener('change',event=>{const input=event.target;if(input.tagName!=='INPUT')return;if(input.dataset.execution){const selected=state.execution[input.dataset.execution];if(!selected)return;input.checked?selected.add(input.value):selected.delete(input.value);}else if(state[openFacetName]){input.checked?state[openFacetName].add(input.value):state[openFacetName].delete(input.value);}render();});
 const facetSearch=$('#facet-search');if(facetSearch)facetSearch.addEventListener('input',renderFacetBody);
 const facetClear=$('#facet-clear');if(facetClear)facetClear.addEventListener('click',()=>{if(openFacetName==='execution'){for(const selected of Object.values(state.execution))selected.clear();}else state[openFacetName]?.clear();render();});
 const facetClose=$('#facet-close');if(facetClose)facetClose.addEventListener('click',closeFacet);
 const chips=$('#filter-chips');if(chips)chips.addEventListener('click',event=>{const button=event.target.closest('[data-chip-kind]');if(!button)return;removeFacetValue(button.dataset.chipKind,button.dataset.chipValue);render();});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&openFacetName){event.preventDefault();closeFacet();}});
 document.addEventListener('click',event=>{if(!openFacetName)return;const pop=$('#facet-popover');if(pop&&(pop.contains(event.target)||event.target.closest?.('.facet-trigger')))return;closeFacet();});
 document.querySelectorAll('[data-period]').forEach(b=>b.addEventListener('click',()=>{state.period=b.dataset.period;render();}));
 for(const [selector,key] of [['#year-from','from'],['#year-to','to']])$(selector).addEventListener('input',e=>{state[key]=e.target.value===''?NaN:Number(e.target.value);render();});
 document.querySelectorAll('[data-year-from]').forEach(b=>b.addEventListener('click',()=>applyFilters({from:Number(b.dataset.yearFrom),to:b.dataset.yearTo==='current'?MAX_YEAR:Number(b.dataset.yearTo)})));
 $('#runtime-max').addEventListener('input',e=>{state.maxRuntime=e.target.value===''?null:Number(e.target.value);render();});
 document.querySelectorAll('[data-runtime-max]').forEach(b=>b.addEventListener('click',()=>applyFilters({maxRuntime:b.dataset.runtimeMax==='any'?null:Number(b.dataset.runtimeMax)})));
 $('#filter-toggle').addEventListener('click',()=>{const b=$('#filter-toggle');const open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));$('#filters').dataset.open=String(open);});
 const statusDetails=$('#status-details');statusDetails.addEventListener('toggle',()=>{$('#status-details-label').textContent=statusDetails.open?'Скрыть детали':'Показать детали';});
 // Both footer links are real /events links. A plain click opens the in-page screen; a modified or non-primary click (new tab, copy) keeps native navigation.
 for(const link of [$('#status-integrations-events')])if(link)link.addEventListener('click',event=>{if(!plainFilmActivation(event))return;event.preventDefault();openEventsScreen(link);});
 const typeGroup=$('#events-types');if(typeGroup)typeGroup.addEventListener('click',event=>{const button=event.target.closest?.('[data-event-type]');if(button)selectEventType(button.dataset.eventType);});
 const activityExpand=$('#activity-expand');if(activityExpand)activityExpand.addEventListener('click',()=>openEventsScreen(activityExpand));
 const returnLink=$('#return-home');if(returnLink)returnLink.addEventListener('click',event=>{if(!plainFilmActivation(event))return;event.preventDefault();returnHome();});
 $('#reset').addEventListener('click',reset);$('#empty-reset').addEventListener('click',reset);$('#activity-more').addEventListener('click',()=>{if(eventsScreen&&eventTypeFilterId!=='all'&&(eventSearch.state==='error'||eventSearch.state==='stuck'))startEventSearch();else loadEvents(true);});
 const presetSave=$('#preset-save');if(presetSave)presetSave.addEventListener('click',()=>{presetEditor={mode:'create'};presetPrompt=null;presetStatus='';renderPresets();const input=$('#preset-name');if(input){input.value='';input.focus();}});
 const presetEditorForm=$('#preset-editor');if(presetEditorForm){
  presetEditorForm.addEventListener('submit',async event=>{
   event.preventDefault();
   const input=$('#preset-name'),name=String(input?.value||'').trim(),mode=presetEditor?.mode,id=presetEditor?.id;
   if(!name){presetStatus='Введи название сценария.';renderPresets();if(input)input.focus();return;}
   const saved=mode==='rename'?await renamePreset(id,name):await createPreset(name);
   if(saved)focusPreset(mode==='rename'?'#preset-list [data-preset-apply="'+String(id).replace(/"/g,'')+'"]':'#preset-save');
   else if(input)input.focus();
  });
  presetEditorForm.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closePresetEditor(presetEditor?.mode==='rename'?presetEditor.id:'save');}});
 }
 const presetCancel=$('#preset-cancel');if(presetCancel)presetCancel.addEventListener('click',()=>closePresetEditor(presetEditor?.mode==='rename'?presetEditor.id:'save'));
 const presetList=$('#preset-list');if(presetList)presetList.addEventListener('click',event=>{
  const apply=event.target.closest?.('[data-preset-apply]');
  if(apply){const preset=presets.find(item=>item.id===apply.dataset.presetApply);if(preset){applyPresetQuery(preset.query);markCurrentPreset();}return;}
  const id=event.target.closest?.('.preset-row')?.querySelector('[data-preset-apply]')?.dataset.presetApply;
  if(event.target.closest?.('[data-preset-rename]')){presetEditor={mode:'rename',id};presetPrompt=null;renderPresets();const input=$('#preset-name');if(input){input.value=presets.find(item=>item.id===id)?.name||'';input.focus();}}
  else if(event.target.closest?.('[data-preset-update]')){presetPrompt={id,action:'update'};renderPresets();}
  else if(event.target.closest?.('[data-preset-delete]')){presetPrompt={id,action:'delete'};renderPresets();}
  else if(event.target.closest?.('[data-preset-dismiss]')){presetPrompt=null;renderPresets();}
  else if(event.target.closest?.('[data-preset-confirm="update"]'))updatePreset(id);
  else if(event.target.closest?.('[data-preset-confirm="delete"]'))deletePreset(id);
 });
}
async function finishProgrammeUi(){
 if(programmeReady)return;
 updateSourceInfo();
 initPeopleFilters();
 initFilmCompare();
 refreshGenreOptions();
 const openingFilm=filmIdFromLocation();
 if(openingFilm)applyFilmScreen(openingFilm);
 else restoreUrl();
 urlReady=true;
 programmeReady=true;
 await registerModelTool();
}
async function loadProgramme({quiet}={}){
 if(programmeLoading)return 'busy';
 programmeLoading=true;
 try{
  const response=await fetch('/api/programme');
  if(!response.ok)throw new Error('Программа ещё не готова. Попробуй открыть страницу немного позже.');
  const data=await response.json();
  if(!data||!Array.isArray(data.films))throw new Error('Программа ещё не готова. Попробуй открыть страницу немного позже.');
  programmeRefreshError=false;
  const changed=installProgramme(data);
  if(!programmeReady)await finishProgrammeUi();
  else if(changed){refreshGenreOptions();updateFacetOptions();updateSourceInfo();renderPreservingScroll();if(filmScreen)renderFilmShell();}
  else updateSourceInfo();
  renderFinds();
  return true;
 }catch(error){
  programmeRefreshError=true;
  if(programmeReady)updateProgrammeStatus();
  if(!programmeReady&&!quiet){showProgrammeUnavailable(error);throw error;}
  return false;
 }finally{programmeLoading=false;}
}
function armLiveTimer(){
 if(liveTimer)clearInterval(liveTimer);
 liveTimer=setInterval(()=>{if(!document.hidden)runLiveRefresh();},LIVE_REFRESH_MS);
}
function pauseLiveTimer(){
 if(liveTimer)clearInterval(liveTimer);
 liveTimer=null;
}
function requestLiveRefresh(){
 if(document.hidden)return;
 if(liveCoalesced)return;
 liveCoalesced=true;
 Promise.resolve().then(()=>{
  liveCoalesced=false;
  if(document.hidden)return;
  armLiveTimer();
  return runLiveRefresh();
 });
}
async function runLiveRefresh(followUp=false){
 if(document.hidden)return;
 if(liveRunning){livePending=true;return;}
 liveRunning=true;
 try{
  const done=await Promise.all([
   loadEvents(false,{quiet:true}),
   loadPredictionQueue({quiet:true}),
   loadEnrichment({quiet:true}),
   loadCatalog(),
   loadStarted({quiet:true}),
   loadProgramme({quiet:true})
  ]);
  if(!followUp&&done.some(ok=>ok==='busy'))livePending=true;
  refreshTimeSensitiveView();
 }finally{
  liveRunning=false;
  if(livePending){livePending=false;if(!document.hidden)await runLiveRefresh(true);}
 }
}
function startLiveRefresh(){
 stopLiveRefresh();
 const onFocus=()=>requestLiveRefresh();
 const onVisibility=()=>{if(document.hidden)pauseLiveTimer();else requestLiveRefresh();};
 window.addEventListener('focus',onFocus);
 document.addEventListener('visibilitychange',onVisibility);
 liveHandlers={onFocus,onVisibility};
 if(!document.hidden)armLiveTimer();
}
function stopLiveRefresh(){
 pauseLiveTimer();
 livePending=false;
 liveCoalesced=false;
 if(!liveHandlers)return;
 window.removeEventListener('focus',liveHandlers.onFocus);
 document.removeEventListener('visibilitychange',liveHandlers.onVisibility);
 liveHandlers=null;
}
async function init(){
 bindControls();
 if(eventsRequested()){const here=new URL(window.location.href);if((here.pathname.replace(/\/+$/,'')||'/')!=='/events'){window.history.replaceState(window.history.state,'',ReturnHome.withReturn('/events','/'+filmSearchFrom(here.href)));}applyEventsScreen(true);}
 else{const openingFilm=filmIdFromLocation();if(openingFilm)applyFilmScreen(openingFilm);}
 setYearBounds(true);
 try{await loadProgramme();}
 catch(error){showProgrammeUnavailable(error);console.error(error);}
 loadStarted();
 loadPresets();
 loadEvents();
 loadEnrichment();
 loadCatalog();
 loadPredictionQueue();
 startLiveRefresh();
}

async function loadEnrichment(options={}){if(enrichmentLoading)return 'busy';enrichmentLoading=true;try{const response=await fetch('/api/enrichment/view');if(!response.ok)throw new Error();const data=await response.json();if(!data||typeof data.films!=='object')throw new Error();const key=JSON.stringify(data);if(key===enrichmentKey)return true;enrichmentKey=key;enrichment=data;ratingsLoaded=true;updateFacetOptions();renderPreservingScroll();return true;}catch{if(!ratingsLoaded&&!options.quiet)render();return false;}finally{enrichmentLoading=false;}}
 const FOOTER_RUN_STATUS={idle:'не запускался',running:'выполняется',completed:'завершён',blocked:'приостановлен',interrupted:'прерван'};
const INTEGRATION_STATE={healthy:'работает',degraded:'требует внимания',failed:'сбой',stale:'давний успех',unknown:'нет данных',off:'выключено',running:'выполняется',waiting:'ожидает'};
const INTEGRATION_CODE={ok:'',stale:'последний успех давно',no_data:'',running:'',ratings_blocked:'список оценок временно недоступен',ratings_incomplete:'список оценок прочитан не полностью',ratings_rate_limit:'слишком много запросов',ratings_failed:'оценки прочитать не удалось',ratings_pending:'чтение оценок не завершилось, причина неизвестна',watchlist_failed:'watchlist прочитать не удалось',watchlist_stuck:'синхронизация не завершилась',epg_http:'загрузка EPG не удалась',epg_window:'EPG не покрывает текущее окно',epg_parse:'разбор EPG не удался',epg_failed:'обновление EPG не завершилось',resolver_waiting:'',resolver_backoff:'распознавание подождёт: слишком много запросов',resolver_unconfigured:'распознавание не настроено',resolver_failed:'распознавание остановилось',resolver_no_recent_progress:'нет подтверждённого выполнения · вероятна внешняя блокировка; проверь Usage',prediction_interrupted:'запуск прерван',prediction_blocked:'прогнозы приостановлены',prediction_partial:'часть прогнозов не сохранилась',metadata_attention:'метаданные и локализация требуют внимания'};
const FOOTER_RUN_REASON={queue_empty:'',eligible_queue_empty:'остались фильмы без прогноза',retry_backoff:'остались фильмы без прогноза',quota:'лимит',time_budget:'лимит времени',parse_error:'ошибка формата',storage_error:'ошибка хранения',model_error:'ошибка модели',model_unavailable:'модель недоступна',api_error:'ошибка API',lease_lost:'сеанс потерян',lease_expired:'сеанс истёк',profile_changed:'модель вкуса обновлена',format_error_storm:'ошибки формата',external_termination:'внешняя остановка',priority_changed:'приоритет обновлён'};
function formatCoveragePercent(value){const number=Number(value);return Number.isFinite(number)?`${number.toLocaleString('ru',{maximumFractionDigits:1})}%`:'';}
const NORMAL_RUN_REASONS=['queue_empty','eligible_queue_empty','retry_backoff'];
function retryStamp(ms,referenceMs){return madridStamp(ms,madridDay(ms)===madridDay(referenceMs)?{hour:'2-digit',minute:'2-digit'}:{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});}
// Queue outcome from stored slices only: a drained queue, films deferred by a retry timestamp, films ready for the next
// run, or a neutral remainder when the record has no slices. Never derived from the stop reason alone. "Drained" needs an
// explicit `outstanding: 0` from the slices and a coverage that does not contradict it; legacy counters, even zeros, are
// not evidence of a drained queue.
function queueOutcomeText(queue,referenceMs=Date.now(),coverage=null){
 const int=value=>Number.isInteger(value)?value:null,hot=int(queue?.hotPending),cold=int(queue?.coldPending),sliced=int(queue?.outstanding),outstanding=sliced??(hot!==null&&cold!==null?hot+cold:null);
 if(outstanding===null)return null;
 const one=n=>n%10===1&&n%100!==11,few=n=>n%10>=2&&n%10<=4&&(n%100<12||n%100>14),count=n=>`${n.toLocaleString('ru')} ${filmWord(n)}`,remained=n=>one(n)?'Остался':few(n)?'Остались':'Осталось',waits=n=>one(n)?'ожидает':'ожидают',ready=n=>one(n)?'готов':'готовы';
 const eligible=int(queue?.eligibleNow),deferred=int(queue?.deferredByRetry),unknown={state:'unknown',short:outstanding>0?`${count(outstanding)} без актуального прогноза`:'данные об очереди неполные',long:outstanding>0?'Остались фильмы без прогноза.':'Остаток очереди в этой записи не сохранён.'};
 if(sliced===null||eligible===null||deferred===null)return unknown;
 const current=int(coverage?.currentPredictionsTotal),total=int(coverage?.confirmedFilmsTotal),coverageIncomplete=current!==null&&total!==null&&current<total;
 if(outstanding===0)return coverageIncomplete?{state:'inconsistent',short:'остались фильмы без прогноза',long:'Остались фильмы без прогноза.'}:{state:'drained',short:'все фильмы с актуальными прогнозами',long:'Все фильмы с актуальными прогнозами.'};
 const retryAt=Date.parse(queue.nextRetryAt),when=Number.isFinite(retryAt)?` не раньше ${retryStamp(retryAt,referenceMs)}`:'',head=`${remained(outstanding)} ${count(outstanding)} без актуального прогноза.`;
 if(deferred>0&&eligible===0){const others=outstanding-deferred;return {state:'deferred',short:`${count(deferred)} ${waits(deferred)} повторной попытки${when}`,long:`${head} ${deferred===outstanding?(one(deferred)?'Ожидает':'Ожидают'):`${count(deferred)} ${waits(deferred)}`} повторной попытки${when}.${others>0?` Ещё ${count(others)} ${one(others)?'ждёт':'ждут'} своей очереди вне окна.`:''}`};}
 if(eligible>0)return {state:'ready',short:`${count(eligible)} ${ready(eligible)} к следующему запуску`,long:`${head} ${count(eligible)} ${ready(eligible)} к следующему запуску${deferred>0?`, ${count(deferred)} ${waits(deferred)} повторной попытки${when}`:''}.`};
 return {state:'waiting',short:`${count(outstanding)} без актуального прогноза`,long:head};
}
function footerStatusText(data){
 const n=value=>(Number.isFinite(Number(value))?Number(value):0).toLocaleString('ru'),finiteCount=value=>typeof value==='number'&&Number.isFinite(value)?value:null,pct=value=>finiteCount(value)===null?'':` · ${formatCoveragePercent(value)}`,coverageLine=(current,total,percent)=>{const left=finiteCount(current),right=finiteCount(total);return left===null||right===null?'нет данных':`${left.toLocaleString('ru')}/${right.toLocaleString('ru')} с актуальным прогнозом${pct(percent)}`;},date=(value,options)=>{const ms=typeof value==='number'?value:Date.parse(value);return Number.isFinite(ms)?new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',...options}).format(new Date(ms)):'—';};
 const c=data.coverage||{},p=data.predictions||{},epg=data.epgTmdb||{},watchlist=data.watchlist||{},run=data.lastRun,profile=data.profile;
 const local=coverageLine(c.currentPredictionsTotal,c.confirmedFilmsTotal,c.localPercent);
 const windowCoverage=coverageLine(c.windowCurrentPredictions,c.windowFilmsTotal,c.windowPercent);
 const active=run?.status==='running',runStatus=run?FOOTER_RUN_STATUS[run.status]||'завершён':'не запускался',outcome=queueOutcomeText({...p,hotPending:p.pendingHot,coldPending:p.pendingCold},Number.isFinite(Date.parse(data.generatedAt))?Date.parse(data.generatedAt):Date.now(),c),normalRun=!!run&&!active&&(!run.reason||NORMAL_RUN_REASONS.includes(run.reason))&&['completed','blocked'].includes(run.status),next=date(p.nextScheduledRun,{hour:'2-digit',minute:'2-digit'}),nextDetail=date(p.nextScheduledRun,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
 let runReason=active||!run?'':normalRun?(outcome?.short??FOOTER_RUN_REASON[run.reason]??''):run.reason?FOOTER_RUN_REASON[run.reason]||'ошибка':'';
 if(!active&&run?.reason==='quota'){const confirmed=date(run.finishedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});runReason=confirmed==='—'?'лимит использования':`лимит использования · подтверждено ${confirmed}`;}
 const runLine=`${runStatus}${runReason?` · ${runReason}`:''}`;
 const deferredLine=Number.isInteger(p.deferredByRetry)?p.deferredByRetry?`${n(p.deferredByRetry)} ${filmWord(p.deferredByRetry)}${p.nextRetryAt?` · не раньше ${date(p.nextRetryAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`:''}`:'нет':'нет данных';
 const integrations=data.integrations||{},attention=integrations.attentionCount||0,attentionWord=attention%10===1&&attention%100!==11?'требует':'требуют',resolverUnconfirmed=(integrations.sources||[]).some(source=>source.id==='resolver'&&source.code==='resolver_no_recent_progress');
 let integrationAggregate=integrations.aggregate==='failed'?'есть сбой':integrations.aggregate==='attention'?`${attention.toLocaleString('ru')} ${attentionWord} внимания`:integrations.aggregate==='healthy'?'всё работает':'нет данных';
 if(resolverUnconfirmed&&integrations.aggregate==='attention')integrationAggregate=attention===1?'распознавание: нет подтверждённого выполнения':`${integrationAggregate} · распознавание без подтверждённого выполнения`;
 const stamp=value=>date(value,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
 // The ratings line shows the routine EPG ratings read; the retired ratings-only refresh appears only as a labelled past attempt.
 const retiredLine=retired=>{if(!retired)return '';const at=retired.lastOutcome==='failed'?retired.lastFailureAt:retired.lastOutcome==='succeeded'?retired.lastSuccessAt:null;return at?`отдельное обновление снято, последн${retired.lastOutcome==='failed'?'ий сбой':'ий успех'} ${stamp(at)}`:'отдельное обновление снято';};
 const integrationLine=source=>{if(!source)return 'нет данных';const word=INTEGRATION_STATE[source.state]||'нет данных',detail=INTEGRATION_CODE[source.code]||'',ratings=source.id==='letterboxd_ratings',since=ratings&&source.code==='ratings_pending'&&source.pendingSince?`синхронизация ${stamp(source.pendingSince)}`:'',failure=ratings&&['failed','degraded'].includes(source.state)&&source.code!=='ratings_pending'&&source.lastFailureAt?`ошибка ${stamp(source.lastFailureAt)}`:'',batch=source.lastBatchAt?`последний пакет ${stamp(source.lastBatchAt)}`:'',gate=source.state==='waiting'&&source.gateAt?`не раньше ${stamp(source.gateAt)}`:'',when=source.lastSuccessAt&&source.state!=='unknown'&&source.lastSuccessAt!==source.lastBatchAt?`успех ${stamp(source.lastSuccessAt)}`:'',history=ratings?retiredLine(source.retiredRefresh):'';return [word,detail&&detail!==word?detail:'',gate,batch,since,failure,when,history].filter(Boolean).join(' · ');};
 const byId=Object.fromEntries((integrations.sources||[]).map(source=>[source.id,source]));
 // AIR-389. The compact footer reads a known count or says "нет данных": an unreadable source is never shown as 0 or as healthy.
 const collection=data.collection||{},unseen=data.recommendations?.newUnseen||{},known=value=>Number.isInteger(value)?value:null,count=value=>known(value)===null?'нет данных':known(value).toLocaleString('ru');
 const collectionOk=collection.state==='ok',unseenOk=unseen.state==='ok',newTotal=unseenOk&&known(unseen.rating40to44)!==null&&known(unseen.rating45plus)!==null?unseen.rating40to44+unseen.rating45plus:null;
 const epgSource=byId.epg,epgUpdated=epgSource?.lastSuccessAt?stamp(epgSource.lastSuccessAt):'нет данных';
 const epgKnown=data.epgTmdb&&typeof data.epgTmdb==='object';
 return {profile:profile?`v${profile.version} · обновлена ${date(profile.updatedAt,{day:'numeric',month:'short'})}`:'не настроена',local,windowCoverage,runLabel:active?'Текущий run':'Последний run',runHeading:active?'Текущий запуск':'Последний запуск',runLine,nextLine:`Следующий запуск по расписанию: ${next==='—'?'—':`около ${next}`}`,localDetail:local,windowDetail:windowCoverage,pendingHot:n(p.pendingHot),pendingCold:n(p.pendingCold),cacheOffWindow:n(c.cacheOffWindowTotal),pendingOffWindow:n(p.pendingOffWindow),deferred:deferredLine,currentBatch:p.currentBatch?.size?`${n(p.currentBatch.size)} фильмов`:'нет активного',nextBatch:p.nextBatchSize&&!(Number.isInteger(p.eligibleNow)&&p.eligibleNow===0)?`до ${n(p.nextBatchSize)} ${p.nextBatchSize%10===1&&p.nextBatchSize%100!==11?'фильма':'фильмов'}`:outcome?.state==='drained'?'очередь пуста':outcome?.state==='deferred'?'ждёт повторной попытки':outcome&&outcome.state!=='unknown'?'нет готовых фильмов':'нет данных',epgRecognized:n(epg.recognizedFilms),epgPending:n(epg.pendingRecognition),epgHistory:n(epg.historicalUnresolved),epgConfirmed:n(epg.confirmedMovies),epgCache:n(epg.cacheOffWindow),epgCoverage:epg.epgStart||epg.epgEnd?`${date(epg.epgStart,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} — ${date(epg.epgEnd,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`:'—',epgChannels:n(epg.channels),epgChecked:n(epg.checkedTransmissions),watchlistFilms:n(watchlist.films),watchlistUpdated:date(watchlist.updatedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}),watchlistMetadata:n(watchlist.metadataMissing),watchlistTitles:n((watchlist.titleMissing||0)+(watchlist.titleProvisional||0)),runStarted:date(run?.startedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}),runAdded:n(run?.added),runFailed:n(run?.failed),runResult:`${runStatus}${runReason?` · ${runReason}`:''}`,nextRun:nextDetail==='—'?'—':`около ${nextDetail}`,profileVersion:profile?`v${profile.version}`:'—',profileUpdated:date(profile?.updatedAt,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}),integrationAggregate,integrations:{letterboxd_watchlist:integrationLine(byId.letterboxd_watchlist),letterboxd_ratings:integrationLine(byId.letterboxd_ratings),epg:integrationLine(byId.epg),resolver:integrationLine(byId.resolver),predictions:integrationLine(byId.predictions),metadata:byId.metadata?integrationLine(byId.metadata):''},
  collectionSummary:collectionOk?`${count(collection.total)} ${filmWord(collection.total)}`:'нет данных',collectionTotal:collectionOk?count(collection.total):'нет данных',collectionWatched:collectionOk?count(collection.watched):'нет данных',collectionRated:collectionOk?count(collection.rated):'нет данных',collectionWatchlist:collectionOk?count(collection.watchlist):'нет данных',
  newSummary:newTotal===null?'нет данных':newTotal===0?'нет':`${newTotal.toLocaleString('ru')} · 4.5+: ${count(unseen.rating45plus)}`,new45:unseenOk?count(unseen.rating45plus):'нет данных',new40:unseenOk?count(unseen.rating40to44):'нет данных',
  epgSummary:epgSource?.lastSuccessAt?(epgSource.state==='stale'?`${epgUpdated} · давно`:epgUpdated):'нет данных',epgUpdated,epgHorizon:epg.epgEnd?`до ${stamp(epg.epgEnd)}`:'нет данных',epgRecognizedText:epgKnown?count(epg.recognizedFilms):'нет данных',epgPendingText:epgKnown?count(epg.pendingRecognition):'нет данных'};
}
const FOOTER_VALUES=[['summary-collection','collectionSummary'],['summary-forecast','local'],['summary-new','newSummary'],['summary-epg','epgSummary'],['summary-automation','integrationAggregate'],
 ['detail-collection-total','collectionTotal'],['detail-collection-watched','collectionWatched'],['detail-collection-rated','collectionRated'],['detail-collection-watchlist','collectionWatchlist'],
 ['detail-forecast-local','local'],['detail-forecast-window','windowCoverage'],['detail-new-45','new45'],['detail-new-40','new40'],['detail-taste','profile'],
 ['detail-epg-updated','epgUpdated'],['detail-epg-horizon','epgHorizon'],['detail-epg-recognized','epgRecognizedText'],['detail-epg-pending','epgPendingText']];
const FOOTER_INTEGRATIONS=[['integration-watchlist','letterboxd_watchlist'],['integration-ratings','letterboxd_ratings'],['integration-epg','epg'],['integration-resolver','resolver'],['integration-predictions','predictions'],['integration-metadata','metadata']];
function renderFooterStatus(data){
 const text=footerStatusText(data);
 for(const [id,key] of FOOTER_VALUES){const node=$('#'+id);if(node)node.textContent=text[key];}
 const metadata=$('[data-integration="metadata"]');if(metadata)metadata.hidden=!text.integrations.metadata;
 for(const [id,key] of FOOTER_INTEGRATIONS){const node=$('#'+id),source=(data.integrations?.sources||[]).find(item=>item.id===key);if(!node)continue;node.textContent=text.integrations[key];node.classList.remove('is-failed','is-attention');if(source?.state==='failed')node.classList.add('is-failed');else if(source&&['degraded','stale','unknown'].includes(source.state))node.classList.add('is-attention');}
 const automation=$('#summary-automation');if(automation){automation.classList.remove('is-failed','is-attention');if(data.integrations?.aggregate==='failed')automation.classList.add('is-failed');else if(data.integrations?.aggregate==='attention')automation.classList.add('is-attention');}
 const stale=$('#status-stale-note');if(stale){stale.hidden=true;stale.textContent='';}
}
// A failed refresh keeps the last confirmed counts on screen as a stale snapshot, says how old it is, and shows health (EPG, automation) as unavailable:
// an old "всё работает" is never presented as the current state.
function markFooterUnreadable(){const unavailable='статус недоступен';const stale=$('#status-stale-note');if(stale){stale.hidden=false;stale.textContent=footerReadAt?`Не удалось обновить. Показаны данные от ${madridStamp(footerReadAt)}.`:'Не удалось обновить.';}for(const id of ['summary-epg','summary-automation']){const node=$('#'+id);if(node){node.classList.remove('is-failed');node.classList.add('is-attention');node.textContent=unavailable;}}for(const id of ['integration-watchlist','integration-ratings','integration-epg','integration-resolver','integration-predictions','integration-metadata']){const node=$('#'+id);if(!node)continue;node.classList.remove('is-failed','is-attention');node.classList.add('is-attention');node.textContent=unavailable;}}
function markFooterUnavailable(){const unavailable='статус недоступен';for(const id of ['summary-collection','summary-forecast','summary-new','summary-epg','summary-automation']){const node=$('#'+id);if(node){node.textContent=unavailable;node.classList.remove('is-failed');node.classList.add('is-attention');}}}
async function loadPredictionQueue(options={}){if(footerLoading)return 'busy';footerLoading=true;try{const response=await fetch('/api/enrichment/footer/status');if(!response.ok)throw new Error();renderFooterStatus(await response.json());footerReady=true;footerReadAt=Date.now();return true;}catch{if(footerReady)markFooterUnreadable();else if(!options.quiet)markFooterUnavailable();return false;}finally{footerLoading=false;}}
function endedPhrase(at,now){const hours=Math.max(0,Math.floor((now-at)/3600000));let previous=now;const today=madridDay(now);do{previous-=3600000;}while(madridDay(previous)===today);if(madridDay(at)===madridDay(previous))return 'вчера';if(hours<1)return 'только что';return `${hours} ч назад`;}
function programmeStatus(model=viewingWindow()){
 const title='Границы сохранённого снимка. Это не гарантия, что у каждого канала есть передача до конца окна.';
 if(!model?.envelope||model.black)return {level:'critical',badge:'Нет актуального окна',coverage:'Программа и архив недоступны; ждём обновления',title:model?.basis==='estimate'?'У снимка не было окна. Оценка по времени снимка тоже закончилась.':'Сохранённое окно закончилось или его не удалось прочитать.'};
 if(model.basis==='estimate')return {level:'warning',badge:'Окно оценено по снимку',coverage:`Оценка по времени снимка · программа до ${madridStamp(model.retained.to)}`,title};
 if(!model.future){const span=model.archive.to-model.archive.from;const ended=`Программа закончилась ${endedPhrase(model.retained.to,model.now)}`;const archive=`Архив с ${madridStamp(model.archive.from)}`;if(span<=3600000)return {level:'warning',badge:'Архив заканчивается',coverage:`${ended} · ${archive} · осталось меньше часа`,title};return {level:'warning',badge:'Будущее закончилось',coverage:`${ended} · ${archive}`,title};}
 const archive=model.archive?`Архив с ${madridStamp(model.archive.from)} · `:'';
 // The retained future runs to the last show the feed really had (never past the saved window); a skipped refresh keeps it until
 // those shows start, with the data age said out loud so an old programme is never passed off as a fresh one.
 const savedAt=finiteTime(report?.publishedAt),age=savedAt===null?null:Math.max(0,model.now-savedAt);
 const ageText=age===null?'':`Обновлено ${ageWords(age)} назад · `,stale=age!==null&&age>PROGRAMME_STALE_MS;
 // Known future programming comes from the feed's real last show, never from the saved window's edge. When that show has already
 // started the schedule ahead is unknown, whatever the window still allows; nothing is extended to the retention edge.
 const feedEnd=model.epgEnd;
 if(Number.isFinite(feedEnd)&&feedEnd<=model.now)return {level:'warning',badge:'Будущей программы нет',coverage:`${archive}${ageText}Лента закончилась ${endedPhrase(feedEnd,model.now)} · расписание дальше неизвестно`,title:'Последний показ в сохранённой ленте уже начался. Показов впереди нет, и расписание не додумывается: ждём нового обновления.'};
 const knownEnd=Number.isFinite(feedEnd)?Math.min(model.retained.to,feedEnd):model.retained.to;
 const left=`осталось ${ageWords(Math.max(0,knownEnd-model.now))}`;
 if(stale)return {level:'warning',badge:'Данные устарели',coverage:`${archive}Обновлено ${ageWords(age)} назад · известные показы до ${madridStamp(knownEnd)} (${left})`,title:'Обновление программы пропущено. Показано расписание последней целостной публикации: изменения и отмены эфира после неё не учтены.'};
 return {level:'ok',badge:'Программа актуальна',coverage:`${archive}Программа до ${madridStamp(knownEnd)}${age===null?'':' · обновлено '+ageWords(age)+' назад'}`,title};
}
const PROGRAMME_STALE_MS=36*3600000;
function ageWords(ms){const hours=Math.floor(ms/3600000);if(hours<1)return 'меньше часа';if(hours<48)return `${hours} ч`;return `${Math.floor(hours/24)} дн`;}
function updateProgrammeStatus(){
 const badge=$('#connection-badge'),coverage=$('#snapshot-coverage'),updated=$('#snapshot-updated'),note=$('#window-note');
 if(!report){if(badge&&programmeRefreshError){badge.textContent='Ошибка обновления';badge.classList?.remove('is-ok','is-warning','is-critical');badge.classList?.add('is-error');}return;}
 const status=programmeStatus();
 if(updated){const published=Date.parse(report.publishedAt);updated.textContent=Number.isFinite(published)?`Обновлено ${madridStamp(published)}`:'Обновлено — нет данных';}
 if(coverage){coverage.textContent=status.coverage;coverage.title=status.title;}
 if(badge){badge.classList?.remove('is-ok','is-warning','is-critical','is-error');if(programmeRefreshError){badge.textContent='Ошибка обновления';badge.title='Последний снимок сохранён. Ошибка обновления не заменяет состояние окна.';badge.classList?.add('is-error');}else{badge.textContent=status.badge;badge.title=status.title;badge.classList?.add(status.level==='ok'?'is-ok':status.level==='warning'?'is-warning':'is-critical');}}
 if(note){note.hidden=!blackZone();note.textContent=state.lastChanceOnly?'Последний шанс сейчас не к чему применить: доступных показов нет. Фильтры не изменены.':'Окно программы закончилось. Показаны фильмы из watchlist без расписания. Архив и следующие сутки пусты, пока не придёт новый снимок.';}
}
function updateSourceInfo(){updateProgrammeStatus();}
// AIR-393: the films a Ratings run changed, as expandable groups like the watchlist event. Only groups that have films are drawn. A film is a local
// link only when the event carries a TMDB id; a film without a stored title reads «Название недоступно», never its technical id.
const RATINGS_DETAIL_GROUPS=[
 ['added','Новые просмотры и оценки'],
 ['updated','Обновлённые оценки'],
 ['rated','Найдена оценка удалённого из watchlist фильма'],
 ['resolved','Оценка записана в событие об удалении']
];
function ratingsDetailsHTML(details){
 if(!details||typeof details!=='object')return '';
 const star=value=>typeof value==='number'&&Number.isFinite(value)&&value>=.5&&value<=5&&value*2%1===0?value.toFixed(1):null;
 const label=f=>{const text=typeof f.title==='string'&&f.title.trim()?`${escapeHTML(f.title)}${Number.isInteger(f.year)?` (${f.year})`:''}`:'Название недоступно',tmdb=/^[1-9]\d{0,11}$/.test(String(f.tmdb??''))?String(f.tmdb):null;return tmdb?`<a href="${escapeHTML(filmHref('tmdb_'+tmdb))}">${text}</a>`:text;};
 const line={
  added:f=>{const r=star(f.rating);return `${label(f)}${r?` · ${r} ★`:' · просмотр без оценки'}`;},
  updated:f=>{const to=star(f.rating),from=star(f.from);return `${label(f)}${to?(from?` · ${from} → ${to} ★`:` · оценка добавлена: ${to} ★`):''}`;},
  rated:f=>{const r=star(f.rating);return `${label(f)}${r?` · ${r} ★`:''}`;},
  resolved:f=>{const r=star(f.rating);return `${label(f)}${r?` · ${r} ★`:''}`;}
 };
 const more=details.more&&typeof details.more==='object'?details.more:{},gap=details.incomplete===true?'<p class="event-note">Часть изменений не удалось назвать: список неполный.</p>':'';
 return gap+RATINGS_DETAIL_GROUPS.map(([key,title])=>{
  const films=Array.isArray(details[key])?details[key].filter(f=>f&&typeof f==='object'):[],rest=Number.isInteger(more[key])&&more[key]>0?more[key]:0;
  if(!films.length&&!rest)return '';
  return `<details class="event-group" open><summary><h3>${title} · ${films.length+rest}</h3></summary><ul>${films.map(f=>`<li>${line[key](f)}</li>`).join('')}</ul>${rest?`<p class="event-note">ещё ${rest} без детализации</p>`:''}</details>`;
 }).join('');
}
function eventHTML(event,olderEnrichment=null){const date=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(event.at));const film=f=>`${escapeHTML(f.title)}${f.year?` (${escapeHTML(f.year)})`:''}`;const removal=f=>{const rating=Number(f.rating),known=Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0;return `${film(f)}${known?` · ${rating.toFixed(1)} ★`:''}`;};let body='';
 if(event.type==='started'||event.type==='unstarted')body=`<p>${event.type==='started'?'Начал смотреть':'Снял отметку «Начал»'}: <strong>${film(event.film)}</strong></p>`;
 if(event.type==='epg')body=`<p>Обновлён EPG</p><dl><div><dt>Фильмов с показами</dt><dd>${event.films}</dd></div><div><dt>В архиве</dt><dd>${event.archive}</dd></div><div><dt>В следующие сутки</dt><dd>${event.future}</dd></div><div><dt>Всего показов</dt><dd>${event.broadcasts}</dd></div></dl>`;
 if(event.type==='ratings'){const n=v=>Number.isInteger(v)&&v>=0?v:0,d=event.diary&&typeof event.diary==='object'?event.diary:null,r=event.removal&&typeof event.removal==='object'?event.removal:{},causes={blocked:'Letterboxd заблокировал запрос',rate_limited:'Letterboxd ограничил частоту запросов',failed:'Diary не удалось прочитать',interrupted:'Выполнение прервано',abandoned:'Выполнение прервано'},title=event.state==='finished'?'Рейтинги обновлены':event.state==='error'?'Проверка рейтингов завершена с ошибкой':'Проверка рейтингов прервана',why=event.state!=='finished'&&causes[event.cause]?`<p class="event-note">${causes[event.cause]}</p>`:'',rows=[];if(d){rows.push(['Diary: записей проверено',n(d.rows)],['Новых фактов',n(d.written)],['Без изменений',n(d.unchanged)+n(d.skipped)]);if(n(d.conflicts))rows.push(['Конфликтов',n(d.conflicts)]);}if(n(r.rated))rows.push(['Оценок удалённых фильмов найдено',n(r.rated)]);rows.push(['Удалений обработано',n(r.resolved)]);body=`<p>${title}</p>${why}<dl>${rows.map(([name,value])=>`<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl>${ratingsDetailsHTML(event.details)}${event.coverage==='recent_window'?'<p class="event-note">Проверена последняя страница Diary, не вся история.</p>':''}`;}
 if(event.type==='watchlist'){const half=f=>{const rating=Number(f.rating);return Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0;},group=(title,films,line)=>films.length?`<details class="event-group" open><summary><h3>${title} · ${films.length}</h3></summary><ul>${films.map(f=>`<li>${line(f)}</li>`).join('')}</ul></details>`:'';body=`<p>Обновлён watchlist · ${event.total} ${filmWord(event.total)}</p>`+group('Просмотрены',(event.removed||[]).filter(half),removal)+group('Остальные удаления',(event.removed||[]).filter(f=>!half(f)),film)+group('Добавлены фильмы',event.added||[],film);if(!event.added?.length&&!event.removed?.length)body+=`<p class="event-note">${event.baseline?'Исходный сохранённый список':'Состав без изменений'}</p>`;}
 if(event.type==='enrichment'&&event.queueSchemaVersion>=6){const delta=event.delta||{added:event.added??0,updated:event.updated??0,failed:event.failed??0},snapshot=event.snapshot||{},coverage=snapshot.coverage||{},queue=snapshot.queue||{},isStart=['started','resumed'].includes(event.stage),stop=event.stopReason||event.reason,outcome=queueOutcomeText({...queue,hotPending:queue.hotPending??event.hotRemaining,coldPending:queue.coldPending??event.coldRemaining},Date.parse(event.at),coverage),reason=NORMAL_RUN_REASONS.includes(stop)?outcome?.long:{quota:'Достигнут доступный лимит. Сохранённый прогресс продолжится в следующем запуске.',time_budget:'Закончилось время прохода. Прогресс сохранён.',parse_error:'Некоторые ответы не удалось разобрать; фильмы остаются для повторной попытки.',storage_error:'Часть результатов не удалось сохранить. Следующий запуск повторит попытку.',model_error:'Модель не завершила часть прогнозов. Следующий запуск продолжит очередь.',model_unavailable:'Модель временно недоступна. Сохранённый прогресс не потерян.',api_error:'Сервис временно недоступен. Сохранённый прогресс не потерян.',lease_lost:'Запуск потерял право записи и безопасно остановлен.',lease_expired:'Предыдущий запуск оборвался. Сохранённые прогнозы переиспользуются.',runner_aborted:'Запуск оборвался до завершения. Сохранённый прогресс не потерян.',priority_changed:'Очередь изменилась; следующий запуск продолжит с актуального приоритета.',profile_changed:'Модель вкуса изменилась между запусками.',format_error_storm:'Несколько фильмов подряд получили ответы неверного формата. Проход остановлен, результаты сохранены.',external_termination:'Запуск остановлен извне. Сохранённый прогресс не потерян.'}[stop],local=Number.isInteger(coverage.currentPredictionsTotal)&&Number.isInteger(coverage.confirmedFilmsTotal)?`<p class="event-note">Локальная база: ${coverage.currentPredictionsTotal} из ${coverage.confirmedFilmsTotal} · ${formatCoveragePercent(coverage.localPercent)}.</p>`:'',window=Number.isInteger(coverage.windowCurrentPredictions)&&Number.isInteger(coverage.windowFilmsTotal)?`<p class="event-note">Окно просмотра: ${coverage.windowCurrentPredictions} из ${coverage.windowFilmsTotal} · ${formatCoveragePercent(coverage.windowPercent)}.</p>`:'',hot=queue.hotPending??event.hotRemaining??'нет данных',cold=queue.coldPending??event.coldRemaining??'нет данных',gain=Number.isInteger(delta.predictionGain)&&delta.predictionGain!==0?` · ${delta.predictionGain>0?'+':''}${delta.predictionGain} актуальных прогнозов`:'';if(isStart){const title=event.runState==='recovered'?'Прогнозы восстановлены':event.stage==='resumed'?'Прогнозы продолжены':'Прогнозы запущены';body=`<p>${title}</p>${local}${window}<p class="event-note">Очередь: ${hot} в окне · ${cold} вне окна${queue.deferredByRetry?` · отложены до повтора: ${queue.deferredByRetry}`:''}.</p>${snapshot.currentBatchSize||event.currentBatchSize?`<p class="event-note">Текущий пакет: ${snapshot.currentBatchSize||event.currentBatchSize}.</p>`:''}`;}else{const title=event.stage==='running'?'Прогнозы считаются · промежуточный итог':event.stage==='partial'||event.stage==='blocked'?'Прогнозы приостановлены':'Прогнозы обновлены';body=`<p>${title}</p><p class="event-note">С начала запуска: добавлено ${delta.added??0}${delta.updated?` · пересчитано ${delta.updated}`:''} · не удалось ${delta.failed??0}${gain}.</p>${local}${window}<p class="event-note">Осталось: ${hot} в окне · ${cold} вне окна${event.batchesProcessed>1?` · пакетов обработано: ${event.batchesProcessed}`:''}.</p>${stop?`<p class="event-note">Причина: ${escapeHTML(stop)}.</p>`:''}${reason?`<p class="event-note">${reason}</p>`:''}`;}}
 else if(event.type==='enrichment'&&['started','resumed'].includes(event.stage)){body=`<p>${event.stage==='resumed'?'Прогнозы продолжены':'Прогнозы запущены'}</p><p class="event-note">В окне просмотра ждут прогноза: ${event.hotRemaining??'нет данных'} · вне окна: ${event.coldRemaining??'нет данных'}.</p>${event.currentBatchSize?`<p class="event-note">Текущий пакет: ${event.currentBatchSize}.</p>`:''}`;}
 else if(event.type==='enrichment'&&event.queueSchemaVersion>=3){const added=event.added??event.created??0,updated=event.updated??event.recalculated??0,reason={quota:'Достигнут лимит использования. Сохранённый прогресс продолжится в следующем запуске.',time_budget:'Закончилось время прохода. Прогресс сохранён.',parse_error:'Не удалось разобрать часть ответов. Эти фильмы остаются в очереди.',storage_error:'Часть результатов не удалось сохранить. Следующий запуск повторит попытку.',model_error:'Часть прогнозов не рассчитана. Следующий запуск продолжит очередь.',lease_expired:'Предыдущий запуск оборвался. Сохранённые прогнозы переиспользуются.',profile_changed:'Модель вкуса изменилась между запусками.',format_error_storm:'Несколько фильмов подряд получили ответы неверного формата. Проход остановлен, результаты сохранены.'}[event.reason];body=`<p>${event.stage==='running'?'Прогнозы считаются · промежуточный итог':event.stage==='blocked'?'Прогнозы ждут следующего запуска':event.stage==='partial'?(event.queueSchemaVersion>=5?'Прогнозы приостановлены':'Прогнозы сохранены, проход прерван'):'Прогнозы обновлены'}</p><p class="event-note">Добавлено: ${added}${updated?` · пересчитано: ${updated}`:''}${event.failed?` · не удалось: ${event.failed}`:''}.</p><p class="event-note">В окне просмотра ждут прогноза: ${event.hotRemaining??(event.queueSchemaVersion>=5?'нет данных':0)}${event.queueSchemaVersion>=4?` · вне окна: ${event.coldRemaining??(event.queueSchemaVersion>=5?'нет данных':0)}`:''}.</p>${event.queueSchemaVersion>=5&&event.reason?`<p class="event-note">Причина: ${escapeHTML(event.reason)}</p>`:''}${event.stopReason==='eligible_queue_empty'&&event.failed?`<p class="event-note">Фильмы с ошибками сохранены для повторной попытки.</p>`:''}${reason?`<p class="event-note">${reason}</p>`:''}`;}
 else if(event.type==='enrichment'){const added=event.added??event.created??0,updated=event.updated??event.recalculated??0,changed=added+updated,remaining=Number.isInteger(event.remaining)?event.remaining:null,previous=Number.isInteger(olderEnrichment?.remaining)&&(!event.queueSchemaVersion||event.queueSchemaVersion===olderEnrichment.queueSchemaVersion)?olderEnrichment.remaining:null,arrived=previous===null||remaining===null?null:remaining-previous+changed;body=`<p>${event.stage==='partial'||event.failed||event.pending?'Пакет прогнозов прерван':changed?'Прогнозы рассчитаны':'Очередь проверена'}</p><p class="event-note">За проход: ${added} новых${updated?` · ${updated} пересчитано`:''}${event.failed?` · ${event.failed} не удалось`:''}.</p>${remaining!==null?`<p class="event-note">После прохода ждут прогноза: ${remaining}${Number.isInteger(event.hotRemaining)?` (в окне просмотра: ${event.hotRemaining})`:""}.</p>`:''}${arrived>0?`<p class="event-note">Очередь: ${previous} + ${arrived} поступило − ${changed} готово = ${remaining}. Новые задачи появляются при проверке EPG.</p>`:''}${event.reason?`<p class="event-note">Причина: ${escapeHTML(event.reason)}</p>`:''}`;}
 // AIR-410 (ADR 0111): one compact card per hourly Discovery report (`kind:'hour'`) and the older per-chain card (any other kind). Every number is
 // read through a strict integer check and every sentence is fixed text chosen by kind and status, so nothing from the stored event reaches the
 // page as markup. A part the report could not read is `null` and is shown as «неизвестно», never as 0. No film, id or error text is shown.
 if(event.type==='discovery'&&event.kind==='hour'){
  const int=v=>Number.isInteger(v)&&v>=0,num=v=>int(v)?String(v):'неизвестно',incomplete=event.incomplete===true||!int(event.checked)||!int(event.added);
  const stamp=value=>{const t=Date.parse(value);return Number.isFinite(t)?new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(t)):null;};
  const empty=event.queueEmpty===true&&!incomplete,queue=empty?'пуста':int(event.remaining)?String(event.remaining):'неизвестно';
  const status=event.status,added=incomplete?null:event.added,checked=incomplete?null:event.checked;
  const title=incomplete?'Отчёт за час неполный'
   :status==='failed'?'Discovery остановлен после повторных ошибок'
   :status==='waiting'?'Discovery ждёт повтора'
   :status==='blocked'?'Discovery не запустился: временный отказ'
   :status==='empty'||empty?'Очередь Discovery пуста'
   :status==='idle'?'Discovery не работает: запуска не требовалось'
   :added>0?`Найдено новых фильмов: ${added}`
   :checked>0?'Новых фильмов не найдено'
   :'Discovery работает, новых результатов за час нет';
  const from=incomplete?null:stamp(event.from);
  body=`<p>${title}</p><dl><div><dt>Новых фильмов</dt><dd>${num(added)}</dd></div><div><dt>Разобрано наблюдений</dt><dd>${num(checked)}</dd></div><div><dt>Осталось в очереди</dt><dd>${queue}</dd></div></dl>`
   +(incomplete?'<p class="event-note">Данные за этот период не удалось прочитать. Найденное войдёт в следующий отчёт.</p>'
    :`<p class="event-note">Повторно использовано: ${num(event.reused)} · отсеяно: ${num(event.screenedOut)} · запросов к TMDB: ${num(event.tmdbCalls)}.</p>${from?`<p class="event-note">Период: с ${from}.</p>`:''}`);
 }
 else if(event.type==='discovery'){
  const n=v=>Number.isInteger(v)&&v>=0?v:0,known=Number.isInteger(event.remaining)&&event.remaining>=0,empty=event.queueEmpty===true,added=n(event.added),checked=n(event.checked);
  const title=event.kind==='empty'?'Очередь Discovery пуста'
   :event.status==='superseded'?'Прогон Discovery прерван: вышла новая программа'
   :event.status==='failed'?'Прогон Discovery остановлен после повторных ошибок'
   :event.status==='stopped'?'Прогон Discovery остановлен'
   :added?`Найдено новых фильмов: ${added}`
   :checked?'Новых фильмов не найдено'
   :empty?'Очередь Discovery пуста':'Новых изменений нет';
  const queue=empty?'пуста':known?String(event.remaining):'неизвестен';
  body=`<p>${title}</p><dl><div><dt>Новых фильмов</dt><dd>${added}</dd></div><div><dt>Разобрано наблюдений</dt><dd>${checked}</dd></div><div><dt>Осталось в очереди</dt><dd>${queue}</dd></div></dl>`
   +(event.kind==='empty'?'<p class="event-note">Новых изменений нет.</p>':`<p class="event-note">Повторно использовано: ${n(event.reused)} · отсеяно: ${n(event.screenedOut)} · запросов к TMDB: ${n(event.tmdbCalls)}.</p>`);
 }
 if(event.type==='taste_profile'){const labels={ratingScale:'Изменена шкала оценок',positiveSignals:'Изменены положительные сигналы',negativeSignals:'Изменены отрицательные сигналы',characterLogic:'Изменена логика персонажей',pace:'Изменён темп',payoffEnding:'Изменены развязка и финал',genrePreferences:'Изменены жанровые предпочтения',comedyPreferences:'Изменены предпочтения для комедий',horrorPreferences:'Изменены предпочтения для хорроров',scifiAdventurePreferences:'Изменены предпочтения для фантастики и приключений',actionPreferences:'Изменены предпочтения для боевиков',anchorFilms:'Изменены опорные фильмы',hardSkips:'Изменены жёсткие исключения',calibration:'Изменена калибровка'},known=Array.isArray(event.changedFields)?event.changedFields.filter(field=>Object.hasOwn(labels,field)):[],phrase=event.scope==='identity'&&!known.length?'Содержание модели не изменилось':known.length===1?labels[known[0]]:known.length>1?'Изменены несколько разделов модели вкуса':'',impact=event.scope==='selective'?'Влияние: выборочное':event.scope==='global'?'Влияние: глобальное':'',from=Number.isInteger(event.fromVersion)?event.fromVersion:null,to=Number.isInteger(event.toVersion)?event.toVersion:null,version=from!==null&&to!==null?`Версия ${from} → ${to}`:to!==null?`Версия ${to}`:'';body=`<p>Модель вкуса обновлена</p>${version?`<p class="event-note">${version}</p>`:''}${phrase?`<p class="event-note">${phrase}</p>`:''}${impact?`<p class="event-note">${impact}</p>`:''}`;}
 return `<li class="activity-event" data-event-id="${escapeHTML(event.id)}"><time datetime="${escapeHTML(event.at)}">${date}</time>${body}</li>`;}
function rememberActivityAnchor(scroll){
 if(!scroll||scroll.scrollTop<=0||typeof scroll.querySelectorAll!=='function')return null;
 const item=[...scroll.querySelectorAll('[data-event-id]')].find(node=>node.offsetTop+node.offsetHeight>scroll.scrollTop);
 if(!item?.dataset?.eventId)return null;
 return {id:item.dataset.eventId,offset:scroll.scrollTop-item.offsetTop};
}
function restoreActivityAnchor(scroll,anchor,fallback){
 if(!scroll)return;
 if(!anchor){scroll.scrollTop=fallback;return;}
 const node=scroll.querySelector?.(`[data-event-id="${String(anchor.id).replace(/"/g,'')}"]`);
 scroll.scrollTop=node?node.offsetTop+anchor.offset:fallback;
}
// One feed, one list, one fetch. The compact feed of the programme and film pages shows every loaded event; on the events screen the same list is
// filtered by the selected type. Only the view changes: loadedEvents and the cursor are never touched here.
function renderActivity(){
 const scroll=document.querySelector('.activity-scroll'),anchor=rememberActivityAnchor(scroll),position=scroll?scroll.scrollTop:0;
 const ordered=[...loadedEvents.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id)),olderById=new Map();
 let older=null;
 for(const event of [...ordered].reverse())if(event.type==='enrichment'){olderById.set(event.id,older);older=event;}
 const filter=eventsScreen?eventTypeFilterId:'all',shown=ordered.filter(event=>eventMatchesType(event,filter));
 $('#activity-list').innerHTML=shown.map(event=>eventHTML(event,olderById.get(event.id))).join('');
 restoreActivityAnchor(scroll,anchor,position);
 const status=$('#activity-status');
 if(status)status.textContent=activityStatusText(filter,ordered,shown);
 syncActivityMore();
}
async function loadEvents(more=false,options={}){if(eventLoading)return 'busy';eventLoading=true;const button=$('#activity-more');if(!options.auto){button.disabled=true;button.classList.toggle('is-loading',more);if(more){button.setAttribute('aria-busy','true');button.textContent='Загружаем события…';if(!options.quiet)$('#activity-status').textContent='Загружаем более давние события…';}}try{const response=await fetch('/api/events'+(more&&eventCursor?'?cursor='+encodeURIComponent(eventCursor):''),options.signal?{signal:options.signal}:undefined);if(!response.ok)throw new Error();const data=await response.json();const keepCursor=!more&&loadedEvents.size>20;for(const event of data.events)loadedEvents.set(event.id,event);if(!keepCursor)eventCursor=data.cursor;eventsReady=true;activityNote=!more&&!data.events.length?'Здесь появятся события списка.':'';button.hidden=!eventCursor;button.textContent='Более давние события';renderActivity();if(!options.auto&&eventsScreen&&eventTypeFilterId!=='all'&&!eventSearch.controller&&eventSearch.state==='idle')startEventSearch();return true;}catch{if(options.signal&&options.signal.aborted)return 'aborted';if(!options.quiet){activityNote='Не удалось загрузить события.';$('#activity-status').textContent=activityNote;button.hidden=false;button.textContent='Повторить';}return false;}finally{eventLoading=false;if(!options.auto){button.classList.remove('is-loading');button.removeAttribute('aria-busy');button.disabled=false;}}}
function initFilmCompare(){
 const input=$('#film-compare-input'),list=$('#film-compare-options'),clear=$('#film-compare-clear'),root=$('#film-compare-combo');
 if(!input||!list||!clear||!root||typeof input.addEventListener!=='function')return;
 let matches=[],active=-1;
 const showResult=()=>{const current=currentFilm();if(current)setFilmHtml('film-compare-result',filmCompare(current));};
 const close=()=>{list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;};
 const open=()=>{const q=normalizeTitle(input.value);const pool=q?films.filter(film=>[film.title,film.original].some(name=>normalizeTitle(name||'').includes(q))):[];matches=pool.slice(0,12);active=-1;const more=pool.length>matches.length;list.innerHTML=matches.length?matches.map((film,i)=>`<li role="option" id="film-compare-option-${i}" data-index="${i}" aria-selected="${String(film.id)===String(filmCompareId)}">${escapeHTML(filmCompareLabel(film))}</li>`).join('')+(more?'<li class="no-options" role="presentation">Уточни название</li>':''):(q?'<li class="no-options" role="presentation">Нет совпадений</li>':'<li class="no-options" role="presentation">Начни вводить название</li>');list.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');};
 const choose=i=>{const film=matches[i];if(!film)return;filmCompareId=String(film.id);input.value=filmCompareLabel(film);close();showResult();};
 input.addEventListener('focus',open);
 input.addEventListener('input',()=>{filmCompareId=null;open();showResult();});
 input.addEventListener('keydown',e=>{if(e.key==='Escape'){close();return;}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(list.hidden)open();if(!matches.length)return;active=(active+(e.key==='ArrowDown'?1:-1)+matches.length)%matches.length;list.querySelectorAll('[role="option"]').forEach((el,i)=>el.classList.toggle('active',i===active));const el=$('#film-compare-option-'+active);input.setAttribute('aria-activedescendant',el.id);el.scrollIntoView({block:'nearest'});}else if(e.key==='Enter'&&!list.hidden){e.preventDefault();choose(active>=0?active:0);}else if(e.key==='Tab')close();});
 list.addEventListener('mousedown',e=>e.preventDefault());
 list.addEventListener('click',e=>{const el=e.target.closest?.('[data-index]');if(el)choose(Number(el.dataset.index));});
 clear.addEventListener('click',()=>{filmCompareId=null;input.value='';close();showResult();input.focus?.();});
 document.addEventListener('click',e=>{if(!root.contains?.(e.target))close();});
}
function initPeopleFilters(){
 for(const key of ['directors','actors']){
  const root=document.querySelector(`[data-person="${key}"]`),input=$('#'+key+'-input'),list=$('#'+key+'-options');
  let matches=[],active=-1;
  const close=()=>{list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;};
  const open=()=>{const people=peopleSources[key];const q=normalizeTitle(input.value);matches=people.filter(p=>!q||[p.name,p.original,...(p.aliases||[])].some(n=>normalizeTitle(n).includes(q)));active=-1;list.innerHTML=matches.length?matches.map((p,i)=>`<li role="option" id="${key}-option-${i}" data-index="${i}" aria-selected="${p.id===state[key]}">${escapeHTML(p.name)}${p.name!==p.original?`<small>${escapeHTML(p.original)}</small>`:''}</li>`).join(''):'<li class="no-options" role="presentation">Нет совпадений</li>';list.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');};
  const choose=i=>{if(!matches[i])return;close();selectPerson(key,matches[i].id);};
  input.addEventListener('focus',open);
  input.addEventListener('input',()=>{state[key]='';render();open();});
  input.addEventListener('keydown',e=>{if(e.key==='Escape'){close();return;}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(list.hidden)open();if(!matches.length)return;active=(active+(e.key==='ArrowDown'?1:-1)+matches.length)%matches.length;list.querySelectorAll('[role="option"]').forEach((el,i)=>el.classList.toggle('active',i===active));const el=$('#'+key+'-option-'+active);input.setAttribute('aria-activedescendant',el.id);el.scrollIntoView({block:'nearest'});}else if(e.key==='Enter'&&!list.hidden){e.preventDefault();choose(active>=0?active:0);}else if(e.key==='Tab')close();});
  list.addEventListener('mousedown',e=>e.preventDefault());list.addEventListener('click',e=>{const el=e.target.closest('[data-index]');if(el)choose(Number(el.dataset.index));});
  root.querySelector('.person-clear').addEventListener('click',()=>{state[key]='';input.value='';render();input.focus();open();});
  root.querySelector('.person-toggle').addEventListener('click',()=>{if(list.hidden){input.focus();open();}else close();});
  document.addEventListener('click',e=>{if(!root.contains(e.target))close();});
 }
}
init();
