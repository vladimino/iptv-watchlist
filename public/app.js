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
const moodLabel=id=>MOOD_LABELS[id]||id;
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
function emptyExecution(){return Object.fromEntries(EXECUTION_FILTERS.map(dimension=>[dimension.id,new Set()]));}
function executionActive(){return EXECUTION_FILTERS.some(dimension=>state.execution[dimension.id]?.size);}
function executionSummary(){const parts=[];for(const dimension of EXECUTION_FILTERS){const selected=state.execution[dimension.id];if(!selected?.size)continue;const labels=dimension.values.filter(([value])=>selected.has(value)).map(([,label])=>label);if(labels.length)parts.push(`${dimension.label}: ${labels.join(', ')}`);}return parts.length?` · Исполнение: ${parts.join('; ')}`:'';}
function facetSummary(labels){if(!labels.length)return 'Любой';if(labels.length===1)return labels[0];return `${labels[0]} +${labels.length-1}`;}
function moodIdsFromUrl(value){const key=normalizeMood(value).replace(/ё/g,"е").replace(/[^\p{L}\p{N}]+/gu," ").trim();if(Object.hasOwn(MOOD_LABELS,value))return [value];const direct=Object.entries(MOOD_LABELS).filter(([,label])=>normalizeMood(label).replace(/ё/g,"е").replace(/[^\p{L}\p{N}]+/gu," ").trim()===key).map(([id])=>id);return direct.length?direct:enrichment.moodVocabulary?.aliases?.[key]||[];}
let mechanics=[],moods=[];
function defaultSearchScopes(){return {titles:true,people:false,plot:false};}
const SEARCH_SCOPE_IDS=['titles','people','plot'];
const state = { shortlistMode:'now', period: 'all', sort: 'title', sortExplicit:false, viewing: 'any', minPrediction: null, minProbability: null, startedOnly: false, lastChanceOnly: false, includeUnscheduled: false, directors: '', actors: '', query: '', searchScopes:defaultSearchScopes(), genres: new Set(), mechanics:new Set(), moods:new Set(), channels:new Set(), execution:emptyExecution(), from: 1900, to: MAX_YEAR, maxRuntime: null };
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
 const archiveFrom=Math.max(envelope.from,clock-72*3600000),archiveTo=Math.min(envelope.to,clock);
 const archive=archiveFrom<archiveTo?{from:archiveFrom,to:archiveTo,fromExclusive:archiveFrom===clock-72*3600000}:null;
 const futureFrom=Math.max(envelope.from,clock);
 const future=futureFrom<envelope.to?{from:futureFrom,to:envelope.to}:null;
 return {basis,now:clock,envelope,archive,future,black:!archive&&!future,epgEnd:finiteTime(snapshot?.stats?.epgEnd)};
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
 const p=url.searchParams,defaults={shortlistMode:'now',period:'all',sort:'title',sortExplicit:false,viewing:'any',minPrediction:null,minProbability:null,startedOnly:false,lastChanceOnly:false,includeUnscheduled:false,directors:'',actors:'',query:'',searchScopes:parseSearchScopes(p.get('searchIn')),genres:new Set(),mechanics:new Set(),moods:new Set(),channels:new Set(),execution:emptyExecution(),from:1900,to:MAX_YEAR,maxRuntime:null};
 if(p.get('shortlist')==='today')defaults.shortlistMode='today';
 if(p.get('view')==='watchlist')defaults.includeUnscheduled=true;
 if(['all','archive','future'].includes(p.get('period')))defaults.period=p.get('period');
 if(p.get('sort')==='relevance')defaults.sort='relevance';
 else if(['title','personal','expiring','time'].includes(p.get('sort'))){defaults.sort=p.get('sort');defaults.sortExplicit=true;}
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
 if(state.sort==='relevance'||state.sort!=='title')add('sort',state.sort);
 else if(state.sortExplicit&&normalizeSearch(state.query))add('sort','title');
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
const FILM_QUERY_KEY='iptv-film-list-query';
function eventsRequested(href=window.location.href){const url=new URL(href);if(url.searchParams.get('screen')==='events')return true;const path=url.pathname.replace(/\/+$/,'')||'/';return path==='/events';}
const FILM_ID=/^[A-Za-z0-9_-]{1,80}$/;
const FILM_CONTROL='a,button,summary,input,select,label,textarea';
function filmIdFromLocation(href=window.location.href){const path=new URL(href,'https://iptv.local').pathname.replace(/\/+$/,'')||'/';const match=path.match(/^\/film\/([^/]+)$/);if(!match)return null;let id;try{id=decodeURIComponent(match[1]);}catch{return null;}return FILM_ID.test(id)?id:null;}
function filmSearchFrom(href){const url=new URL(href);url.searchParams.delete('screen');return url.search;}
function filmQueryStore(name){try{return globalThis[name]||null;}catch{return null;}}
function writeFilmQuery(search){for(const name of ['sessionStorage','localStorage']){try{filmQueryStore(name)?.setItem(FILM_QUERY_KEY,search);}catch{}}}
function readFilmQuery(){try{const session=filmQueryStore('sessionStorage');if(session){const value=session.getItem(FILM_QUERY_KEY);if(value!==null)return value;}}catch{}try{return filmQueryStore('localStorage')?.getItem(FILM_QUERY_KEY)||'';}catch{return '';}}
function rememberFilmList(){if(eventsScreen||eventsRequested()||filmIdFromLocation())return;writeFilmQuery(filmSearchFrom(window.location.href));}
let eventsScreen=false,filmScreen=null,filmReturnId=null,filmFiltersAtOpen=null,filmCompareId=null,filmCompareFilm=null,movieScrollY=0,eventsTrigger=null;
function applyEventsScreen(on){
 if(on&&!eventsScreen)movieScrollY=window.scrollY||0;
 eventsScreen=!!on;
 document.documentElement?.classList?.toggle('events-screen',eventsScreen);
 const expand=$('#activity-expand'),back=$('#activity-back');
 if(expand)expand.hidden=eventsScreen;
 if(back)back.hidden=!eventsScreen;
 if(typeof window.scrollTo==='function')window.scrollTo(0,eventsScreen?0:movieScrollY||0);
}
function openEventsScreen(trigger){
 eventsTrigger=trigger||$('#activity-expand');
 if(!eventsRequested()){rememberFilmList();window.history.pushState({iptvEvents:true},'','/events');}
 else if(new URL(window.location.href).searchParams.get('screen')==='events'){writeFilmQuery(filmSearchFrom(window.location.href));window.history.replaceState(window.history.state,'','/events');}
 applyEventsScreen(true);
 $('#activity-title')?.focus?.({preventScroll:true});
}
function filmHref(id){return '/film/'+encodeURIComponent(String(id));}
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
function showFilmList(search){
 const next='/'+(search.startsWith('?')||!search?search:'?'+search);
 const leavingFilm=!!filmScreen,returnId=filmReturnId,filtersChanged=filmFiltersChanged();
 window.history.replaceState(null,'',next);
 applyEventsScreen(false);
 if(filmScreen)applyFilmScreen(null);
 const incoming=readUrlState(new URL(window.location.href));
 const sameList=filterStateKey(incoming)===filterStateKey(state);
 if(leavingFilm&&filtersChanged)render();
 else if(!sameList)restoreUrl();
 if(leavingFilm)focusFilmReturn(returnId);
 else if(sameList)(eventsTrigger||$('#activity-expand'))?.focus?.({preventScroll:true});
}
function renderFilmShell(){
 const id=filmScreen,film=id?films.find(item=>String(item.id)===id):null,screen=$('#film-screen');
 if(screen)screen.dataset.filmId=id||'';
 const title=$('#film-screen-title'),identity=$('#film-screen-identity'),status=$('#film-screen-status');
 if(title)title.textContent=film?film.title:'Фильм не найден';
 if(identity)identity.textContent=id||'';
 if(status)status.textContent=film?(film.catalogOnly?'Только в каталоге':''):id?'В загруженной программе нет фильма с этим идентификатором.':'';
 fillFilmPage(film);
}
function applyFilmScreen(id){
 const next=id||null;
 if(next&&String(next)!==String(filmCompareFilm||'')){filmCompareId=null;filmCompareFilm=next;const input=$('#film-compare-input');if(input)input.value='';}
 if(next&&!filmScreen){movieScrollY=window.scrollY||0;filmFiltersAtOpen=filterStateKey(state);}
 if(!next)filmFiltersAtOpen=null;
 filmScreen=next;
 document.documentElement?.classList?.toggle('film-screen',!!filmScreen);
 const screen=$('#film-screen');
 if(screen)screen.hidden=!filmScreen;
 if(filmScreen)renderFilmShell();
 if(typeof window.scrollTo==='function')window.scrollTo(0,filmScreen?0:movieScrollY||0);
 if(filmScreen)$('#film-screen-title')?.focus?.({preventScroll:true});
}
function openFilm(id){
 const filmId=filmIdFromLocation('https://iptv.local/film/'+encodeURIComponent(String(id??'')));
 if(!filmId)return;
 filmReturnId=filmId;
 if(filmIdFromLocation()===filmId){applyFilmScreen(filmId);return;}
 rememberFilmList();
 window.history.pushState({iptvFilm:filmId},'','/film/'+encodeURIComponent(filmId));
 applyFilmScreen(filmId);
}
function plainFilmActivation(event){
 if(!event||event.defaultPrevented||event.button!=null&&event.button!==0)return false;
 return !(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey);
}
function closeFilm(){
 if(window.history.state?.iptvFilm){window.history.back();return;}
 showFilmList(readFilmQuery());
}
function closeEventsScreen(){
 if(window.history.state?.iptvEvents){window.history.back();return;}
 showFilmList(readFilmQuery());
}
function onHistoryNavigation(){
 const filmId=filmIdFromLocation();
 const leavingFilm=!!filmScreen&&!filmId,returnId=filmReturnId,filtersChanged=leavingFilm&&filmFiltersChanged();
 if(filmId){applyFilmScreen(filmId);return;}
 if(filmScreen)applyFilmScreen(null);
 const onEvents=eventsRequested();
 if(!onEvents){const next=readUrlState(new URL(window.location.href));if(leavingFilm&&filtersChanged)render();else if(filterStateKey(next)!==filterStateKey(state))restoreUrl();}
 if(onEvents!==eventsScreen)applyEventsScreen(onEvents);
 if(eventsScreen)$('#activity-title')?.focus?.({preventScroll:true});
 else if(leavingFilm)focusFilmReturn(returnId);
 else (eventsTrigger||$('#activity-expand'))?.focus?.({preventScroll:true});
}
function syncUrl(){
 if(!urlReady||urlRestoring||eventsRequested()||filmIdFromLocation()||!Number.isInteger(state.from)||!Number.isInteger(state.to)||state.from<1900||state.to>MAX_YEAR||state.from>state.to||state.maxRuntime!==null&&(!Number.isInteger(state.maxRuntime)||state.maxRuntime<1))return;
 const next=urlForState(window.location.href);
 const target=next.pathname+next.search+next.hash,current=window.location.pathname+window.location.search+window.location.hash;
 if(target!==current)window.history.replaceState(window.history.state,'',target);
 writeFilmQuery(next.search);
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
 const entry=searchEntries().get(String(film.id))||searchEntry(film);
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
 if(hasQuery&&!hadQuery&&!state.sortExplicit&&state.sort==='title')state.sort='relevance';
 if(!hasQuery&&hadQuery&&!state.sortExplicit&&state.sort==='relevance')state.sort='title';
}
function availabilityTime(film,now=viewingClock()){const model=viewingWindow(now);const starts=(film?.shows||[]).map(show=>inArchive(model,show)||inFuture(model,show)?showStart(show):null).filter(start=>start!==null);return starts.length?Math.max(...starts)+72*3600000:null;}
function isLastChance(film,now=viewingClock()){const until=availabilityTime(film,now);return until!==null&&until>now&&until-now<8*3600000;}
function hasActualRating(film){const rating=enrichment.films[String(film.id)]?.actualRating;return rating!==null&&rating!==undefined;}
function filmFacets(film){const item=enrichment.films[String(film.id)]||{},fingerprint=item.fingerprint||{},mechanics=(fingerprint.plotMechanics||[]).filter(m=>Object.hasOwn(MECHANIC_LABELS,m)),moods=(item.moodIds||fingerprint.moodIds||item.prediction?.moodIds||[]).filter(id=>Object.hasOwn(MOOD_LABELS,id));return {mechanics:new Set(mechanics),moods:new Set(moods)};}
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
function storedExecution(film){const value=enrichment.films[String(film.id)]?.fingerprint?.execution;return value&&typeof value==='object'?value:null;}
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
 const html=openFacetName==='execution'
  ?facetCatalog.execution.map(group=>{const options=group.options.filter(item=>show(item.label)||show(group.label));if(!options.length)return '';return `<section class="execution-facet"><h3 class="execution-name">${escapeHTML(group.label)}</h3>${options.map(item=>`<label class="genre-label"><input type="checkbox" data-execution="${escapeHTML(group.id)}" value="${escapeHTML(item.value)}"${state.execution[group.id].has(item.value)?' checked':''}><span>${escapeHTML(item.label)}</span><span class="genre-count">${item.count}</span></label>`).join('')}</section>`;}).join('')
  :(facetCatalog[openFacetName]||[]).filter(item=>show(item.label)).map(item=>`<label class="genre-label"><input type="checkbox" value="${escapeHTML(item.value)}"${state[openFacetName].has(item.value)?' checked':''}><span>${escapeHTML(item.label)}</span><span class="genre-count">${item.count}</span></label>`).join('');
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
 if(Number.isFinite(start)&&Number.isFinite(end)&&end-start>=24*3600000)return {start,cutoff:end-24*3600000,end};
 const cutoff=Date.parse(snapshot.updatedAt);
 return {start:cutoff-72*3600000,cutoff,end:cutoff+24*3600000};
}
function madridStamp(ms,options={day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}){return new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',...options}).format(new Date(ms));}
function madridDay(ms){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));}
function matchHintText(reason){return {ambiguous_short_title_without_year:'Короткое название без года: возможна другая версия.',ambiguous_collision:'Несколько фильмов подходят под это название.',ambiguous_margin:'Совпадение недостаточно уверенное.',contradicted_year:'Год не сходится с известным фильмом.',contradicted_runtime:'Длительность сильно отличается.',no_confident_score:'Нет уверенного совпадения.',no_exact_title:'Название совпало неточно.',no_confident_match:'Нет уверенного совпадения.'}[reason]||'Совпадение неуверенное: возможна другая версия фильма.';}
function letterboxdHref(film){const url=typeof film?.url==='string'?film.url:'';return /^https:\/\/letterboxd\.com\/film\/[a-z0-9-]+\/$/.test(url)?url:'';}
function letterboxdLink(film){const href=letterboxdHref(film);if(!href)return '';return `<a class="letterboxd-link" href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer" title="Открыть в Letterboxd" aria-label="Открыть в Letterboxd"><svg class="letterboxd-mark" width="32" height="15" viewBox="0 0 32 15" aria-hidden="true"><g style="isolation:isolate"><circle cx="7.5" cy="7.5" r="6.6" fill="#ff8000" style="mix-blend-mode:screen"/><circle cx="16" cy="7.5" r="6.6" fill="#00e054" style="mix-blend-mode:screen"/><circle cx="24.5" cy="7.5" r="6.6" fill="#40bcf4" style="mix-blend-mode:screen"/></g></svg></a>`;}
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
function refreshFilmStarted(id){if(!filmScreen||String(filmScreen)!==String(id))return;const film=films.find(item=>String(item.id)===String(id)),actions=$('#film-screen-actions');if(!film||!actions)return;actions.innerHTML=`${letterboxdLink(film)}${startedButton(film,true)}`;const button=document.querySelector(`#film-screen [data-started-id="${String(id).replace(/"/g,'')}"]`);button?.focus?.({preventScroll:true});}
async function toggleStarted(id){if(!startedReady||startedLoading||savingStarted.has(id))return;const next=!startedIds.has(id);savingStarted.add(id);progressError('');render();refreshFilmStarted(id);try{const r=await fetch('/api/started',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,started:next})});if(!r.ok)throw new Error();const data=await r.json();if(data.id!==id||data.started!==next)throw new Error();next?startedIds.add(id):startedIds.delete(id);loadEvents();}catch{progressError('Не удалось сохранить отметку. Нажми на глаз ещё раз, чтобы повторить.');}finally{savingStarted.delete(id);render();refreshFilmStarted(id);}}
function confidenceText(value){return {low:'низкая',medium:'средняя',high:'высокая'}[value]||'';}
function filmWhy(prediction){if(!prediction||!Number.isFinite(prediction.predictedRating))return '';const signals=(Array.isArray(prediction.matchSignals)?prediction.matchSignals:[]).filter(item=>typeof item==='string'&&item.trim()).slice(0,3).map(item=>item.trim());const risk=typeof prediction.mainRisk==='string'?prediction.mainRisk.trim():'';if(!signals.length&&!risk)return '';const signalText=signals.length<2?escapeHTML(signals[0]||''):signals.length===2?`${escapeHTML(signals[0])} и ${escapeHTML(signals[1])}`:`${signals.slice(0,-1).map(item=>escapeHTML(item)).join(', ')} и ${escapeHTML(signals.at(-1))}`;return `<div class="film-why">${signals.length?`<p><span>Совпадает со вкусом</span> ${signalText}</p>`:''}${risk?`<p><span>Основной риск</span> ${escapeHTML(risk)}</p>`:''}</div>`;}
function setFilmHtml(id,html){const node=$('#'+id);if(node)node.innerHTML=html;}
function availableShows(film,now=viewingClock()){const model=viewingWindow(now);return (film?.shows||[]).map(show=>({...show,start:showStart(show)})).filter(show=>show.start!==null&&(inArchive(model,show)||inFuture(model,show))).sort((a,b)=>a.start-b.start||String(a.channel||'').localeCompare(String(b.channel||''),'ru'));}
function nearestAvailable(shows,now){const live=shows.find(show=>show.start<=now&&finiteTime(show.end)!==null&&show.end>now),upcoming=shows.find(show=>show.start>now);if(live&&upcoming)return {show:live,also:upcoming,label:'Сейчас в эфире',nextLabel:'Следующий показ'};if(live)return {show:live,label:'Сейчас в эфире'};if(upcoming)return {show:upcoming,label:'Ближайший показ'};return shows.length?{show:shows[shows.length-1],label:'Последний доступный показ'}:null;}
function filmScore(film){const item=enrichment.films?.[String(film.id)]||{},actual=item.actualRating,prediction=item.prediction;const rating=actual!==null&&actual!==undefined&&Number.isFinite(Number(actual))?`<article class="film-score-card"><span>Оценка Letterboxd</span><strong>${Number(actual).toFixed(1)}</strong></article>`:`<article class="film-score-card is-empty"><span>Оценка Letterboxd</span><p class="film-missing">Оценка Letterboxd не сохранена</p></article>`;const forecast=prediction&&Number.isFinite(prediction.predictedRating)?(()=>{const chance=Number.isFinite(prediction.probability4Plus)?`${Math.round(prediction.probability4Plus*100)}%`:'',confidence=confidenceText(prediction.confidence);return `<article class="film-score-card"><span>Прогноз</span><strong>${Number(prediction.predictedRating).toFixed(1)}</strong><p>${chance?`<span>шанс 4.0+ ${chance}</span>`:''}${confidence?`<span>уверенность ${escapeHTML(confidence)}</span>`:''}${prediction.stale?'<span>ожидает пересчёта</span>':''}</p></article>`;})():'<article class="film-score-card is-empty"><span>Прогноз</span><p class="film-missing">Прогноз ещё не готов</p></article>';return `<section class="film-score" aria-label="Оценка и прогноз"><div class="film-score-row">${forecast}${rating}</div>${filmWhy(prediction)}</section>`;}
function filmSynopsis(film){const text=String(film.synopsis||'').trim();return `<section class="film-section"><h2>Синопсис</h2>${text?`<p class="film-page-synopsis">${escapeHTML(text)}</p>`:'<p class="film-missing">Синопсис не сохранён</p>'}</section>`;}
function filmPeople(label,people,key){if(!people?.length)return '';return `<div class="film-people-row"><h3>${label}</h3><div class="film-people">${creditLinks(people,key)}</div></div>`;}
function filmCredits(film){const directors=filmPeople(film.directors?.length>1?'Режиссёры':'Режиссёр',film.directors,'directors'),actors=filmPeople('В ролях',film.actors,'actors');return `<section class="film-section"><h2>Люди</h2>${directors||actors?directors+actors:'<p class="film-missing">Режиссёр и актёры не указаны</p>'}</section>`;}
function knownFacetIds(values,labels){const seen=new Set(),out=[];for(const value of values||[]){if(typeof value!=='string'||!Object.hasOwn(labels,value)||seen.has(value))continue;seen.add(value);out.push(value);}return out;}
function filmFacetChip(kind,value,label,dimension){return `<button type="button" class="film-chip" data-facet-kind="${kind}" data-facet-value="${escapeHTML(value)}"${dimension?` data-facet-dimension="${escapeHTML(dimension)}"`:''}>${escapeHTML(label)}</button>`;}
function filmFingerprint(film){const item=enrichment.films?.[String(film.id)]||{},fingerprint=item.fingerprint&&typeof item.fingerprint==='object'?item.fingerprint:null,mechanics=knownFacetIds(fingerprint?.plotMechanics,MECHANIC_LABELS),moods=knownFacetIds(fingerprint?.moodIds||item.moodIds,MOOD_LABELS),stored=fingerprint?.execution&&typeof fingerprint.execution==='object'?fingerprint.execution:{},execution=EXECUTION_FILTERS.flatMap(dimension=>{const value=stored[dimension.id];if(value==='unknown'||value==='not_applicable')return [];const label=EXECUTION_VALUES[dimension.id]?.[value];return label?[{id:dimension.id,name:dimension.label,value,label}]:[];});if(!mechanics.length&&!moods.length&&!execution.length)return `<section class="film-section film-fingerprint" aria-label="Характеристики"><h2>Характеристики</h2><p class="film-missing">Характеристики не сохранены</p></section>`;const row=(title,html)=>`<div class="film-facet-row"><h3>${title}</h3><div class="film-chips">${html}</div></div>`;return `<section class="film-section film-fingerprint" aria-label="Характеристики"><h2>Характеристики</h2>${mechanics.length?row('Механика',mechanics.map(id=>filmFacetChip('mechanics',id,MECHANIC_LABELS[id])).join('')):''}${moods.length?row('Настроение',moods.map(id=>filmFacetChip('moods',id,moodLabel(id))).join('')):''}${execution.length?`<div class="film-execution">${execution.map(item=>`<div class="film-execution-item"><h3>${escapeHTML(item.name)}</h3>${filmFacetChip('execution',item.value,item.label,item.id)}</div>`).join('')}</div>`:''}</section>`;}
function selectFacet(kind,value,dimension){if(kind==='mechanics'){if(!Object.hasOwn(MECHANIC_LABELS,value))return;state.mechanics.add(value);}else if(kind==='moods'){if(!Object.hasOwn(MOOD_LABELS,value))return;state.moods.add(value);}else if(kind==='execution'){if(!dimension||!Object.hasOwn(EXECUTION_VALUES,dimension)||!Object.hasOwn(EXECUTION_VALUES[dimension],value))return;state.execution[dimension].add(value);}else return;if(!filmIdFromLocation()){render();return;}const list=urlForState('https://iptv.local/'),target=list.pathname+list.search+list.hash;window.history.pushState(null,'',target);applyFilmScreen(null);render();}
function storedComparable(film){const item=enrichment.films?.[String(film?.id)]||{},fingerprint=item.fingerprint&&typeof item.fingerprint==='object'?item.fingerprint:null,mechanics=knownFacetIds(fingerprint?.plotMechanics,MECHANIC_LABELS),moods=knownFacetIds(fingerprint?.moodIds||item.moodIds,MOOD_LABELS),stored=fingerprint?.execution&&typeof fingerprint.execution==='object'?fingerprint.execution:{},execution=new Map();for(const dimension of EXECUTION_FILTERS){const value=stored[dimension.id];if(!value||value==='unknown'||value==='not_applicable'||!EXECUTION_VALUES[dimension.id]?.[value])continue;execution.set(dimension.id,value);}return {mechanics,moods,execution,empty:!mechanics.length&&!moods.length&&!execution.size};}
function filmCompareLabel(film){const title=normalizeTitle(film.title||'');const ambiguous=films.some(other=>String(other.id)!==String(film.id)&&normalizeTitle(other.title||'')===title);return `${film.title||'Фильм'}${film.year?` · ${film.year}`:''}${ambiguous?` · ${film.id}`:''}`;}
function filmCompare(film){if(!filmCompareId)return '<p class="film-missing">Выбери другой фильм из загруженной программы. Это сравнение сохранённых характеристик, не подбор похожих.</p>';if(String(filmCompareId)===String(film.id))return '<p class="film-missing">Это тот же фильм. Для сравнения нужен другой.</p>';const other=films.find(item=>String(item.id)===String(filmCompareId));if(!other)return '<p class="film-missing">Этого фильма нет в загруженной программе.</p>';const left=storedComparable(film),right=storedComparable(other);if(left.empty)return '<p class="film-missing">У этого фильма нет сохранённых характеристик для сравнения.</p>';if(right.empty)return `<p class="film-missing">У «${escapeHTML(other.title)}» нет сохранённых характеристик для сравнения.</p>`;const sharedMechanics=left.mechanics.filter(id=>right.mechanics.includes(id)),sharedMoods=left.moods.filter(id=>right.moods.includes(id)),diffs=[];for(const dimension of EXECUTION_FILTERS){const a=left.execution.get(dimension.id),b=right.execution.get(dimension.id);if(!a||!b||a===b)continue;diffs.push(`<li>${escapeHTML(dimension.label)}: ${escapeHTML(film.title)} — ${escapeHTML(EXECUTION_VALUES[dimension.id][a])}; ${escapeHTML(other.title)} — ${escapeHTML(EXECUTION_VALUES[dimension.id][b])}</li>`);}const canMechanics=left.mechanics.length&&right.mechanics.length,canMoods=left.moods.length&&right.moods.length,canExecution=EXECUTION_FILTERS.some(dimension=>left.execution.has(dimension.id)&&right.execution.has(dimension.id));if(!canMechanics&&!canMoods&&!canExecution)return '<p class="film-missing">Сравнить нельзя: у фильмов нет общих групп сохранённых характеристик. Неизвестные значения не считаются различием.</p>';const chips=(ids,label)=>ids.map(id=>`<span class="film-compare-chip">${escapeHTML(label(id))}</span>`).join('');const blocks=[];if(canMechanics)blocks.push(`<div class="film-compare-block"><h3>Общая механика</h3>${sharedMechanics.length?`<div class="film-chips">${chips(sharedMechanics,id=>MECHANIC_LABELS[id])}</div>`:'<p class="film-missing">Общих механик нет</p>'}</div>`);if(canMoods)blocks.push(`<div class="film-compare-block"><h3>Общее настроение</h3>${sharedMoods.length?`<div class="film-chips">${chips(sharedMoods,moodLabel)}</div>`:'<p class="film-missing">Общих настроений нет</p>'}</div>`);const executionNote=canExecution?(diffs.length?`<ul class="film-compare-diff">${diffs.join('')}</ul>`:'<p class="film-missing">Среди известных характеристик исполнения различий нет</p>'):(left.execution.size||right.execution.size?'<p class="film-missing">Характеристики исполнения сравнить нельзя: неизвестное или отсутствующее значение не считается различием.</p>':'');if(executionNote)blocks.push(`<div class="film-compare-block"><h3>Исполнение</h3>${executionNote}</div>`);return `<div class="film-compare-body"><p class="film-compare-with">С «${escapeHTML(filmCompareLabel(other))}»</p>${blocks.join('')}</div>`;}
function filmShowMark(show,nearest){if(!nearest)return '';if(show.start===nearest.show.start&&show.channel===nearest.show.channel)return nearest.label==='Сейчас в эфире'?' is-live':' is-nearest';if(nearest.also&&show.start===nearest.also.start&&show.channel===nearest.also.channel)return ' is-next';return '';}
function filmShowRow(show,nearest){const time=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'}).format(new Date(show.start));return `<div class="show-row${filmShowMark(show,nearest)}">${channelControl(show)}<time class="show-time" datetime="${new Date(show.start).toISOString()}">${madridStamp(show.start,{day:'numeric',month:'short'})}<b>${time}</b></time></div>`;}
function filmNowLine(kind,show){return `<p class="film-nearest"><span>${kind}</span> ${channelControl(show)}<time datetime="${new Date(show.start).toISOString()}">${escapeHTML(madridStamp(show.start))}</time></p>`;}
function filmAvailability(film){const now=viewingClock(),shows=availableShows(film,now),until=availabilityTime(film,now),nearest=nearestAvailable(shows,now),untilText=until?madridStamp(until):'';const facts=`<div class="film-facts">${isLastChance(film,now)?lastChanceBadge(film):''}<p class="film-fact">Осталось показов <strong>${shows.length}</strong></p>${untilText?`<p class="film-fact">Доступно до <time datetime="${new Date(until).toISOString()}">${escapeHTML(untilText)}</time></p>`:'<p class="film-missing">Срок доступности не определён</p>'}</div>`;const calls=nearest?`<div class="film-callouts">${filmNowLine(nearest.label,nearest.show)}${nearest.also?filmNowLine(nearest.nextLabel,nearest.also):''}</div>`:'';const list=shows.length?`<div class="film-show-list">${shows.map(show=>filmShowRow(show,nearest)).join('')}</div>`:'<p class="film-missing">Нет показов в текущем окне программы</p>';return `<section class="film-section film-availability" aria-label="Показы"><h2>Показы</h2><div class="film-availability-summary">${facts}${calls}</div>${list}</section>`;}
function fillFilmPage(film){const poster=$('#film-poster'),original=$('#film-screen-original'),meta=$('#film-screen-meta'),genres=$('#film-screen-genres'),actions=$('#film-screen-actions');if(!film){for(const id of ['film-poster','film-screen-original','film-screen-meta','film-screen-genres','film-screen-actions','film-screen-score','film-screen-synopsis','film-screen-credits','film-screen-fingerprint','film-compare-result','film-screen-availability'])setFilmHtml(id,'');if(original)original.textContent='';if(meta)meta.textContent='';if(genres)genres.textContent='';return;}if(poster)poster.innerHTML=film.poster?`<img class="film-page-poster" src="${escapeHTML(film.poster)}" alt="Постер ${escapeHTML(film.original||film.title||'')}" width="220" height="330" referrerpolicy="no-referrer">`:`<div class="film-page-poster no-poster" aria-label="Постер недоступен">${escapeHTML(film.year||'Кино')}</div>`;if(original)original.textContent=film.original&&film.original!==film.title?film.original:'';const bits=[];if(film.year)bits.push(String(film.year));if(Number(film.runtime)>0)bits.push(`${Math.round(Number(film.runtime))} мин`);if(meta)meta.textContent=bits.join(' · ');if(genres)genres.textContent=(film.genres||[]).filter(Boolean).join(' · ');if(actions)actions.innerHTML=`${letterboxdLink(film)}${startedButton(film,true)}`;setFilmHtml('film-screen-score',filmScore(film));setFilmHtml('film-screen-synopsis',filmSynopsis(film));setFilmHtml('film-screen-credits',filmCredits(film));setFilmHtml('film-screen-fingerprint',filmFingerprint(film));setFilmHtml('film-compare-result',filmCompare(film));setFilmHtml('film-screen-availability',filmAvailability(film));}
function creditLinks(people,key){return (people||[]).map(p=>`<button type="button" class="credit-link" data-credit-kind="${key}" data-credit-id="${escapeHTML(p.id)}" title="Показать фильмы: ${escapeHTML(p.name)}">${escapeHTML(p.name)}</button>`).join(', ');}
function credits(film){return `<div class="film-credits">${film.directors?.length?`<p><span class="credit-label">${film.directors.length>1?'Режиссёры':'Режиссёр'}</span> ${creditLinks(film.directors,'directors')}</p>`:''}${film.actors?.length?`<p><span class="credit-label">В ролях</span> ${creditLinks(film.actors,'actors')}</p>`:''}</div>`;}
function selectPerson(key,id){const p=report.people?.[key]?.find(person=>person.id===id);if(!p)return;const onFilm=filmIdFromLocation();state[key]=id;const input=$('#'+key+'-input');if(input){input.value=p.name;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}const options=$('#'+key+'-options');if(options)options.hidden=true;if(!onFilm){render();return;}const list=urlForState('https://iptv.local/'),target=list.pathname+list.search+list.hash;window.history.pushState(null,'',target);applyFilmScreen(null);render();input?.focus?.({preventScroll:true});}
function synopsis(film){
 const text=String(film.synopsis||'').trim();if(!text)return '';
 const max=280;if(text.length<=max)return `<p class="film-synopsis">${escapeHTML(text)}</p>`;
 const cut=text.slice(0,max).lastIndexOf(' '),short=text.slice(0,cut>180?cut:max).trimEnd();
 return `<details class="film-synopsis"><summary><span>${escapeHTML(short)}…</span><strong>Читать полностью</strong></summary><p>${escapeHTML(text)}</p></details>`;
}
function personal(film){const item=enrichment.films[String(film.id)]||{},actual=Number.isFinite(item.actualRating),prediction=item.prediction;return {rating:actual?item.actualRating:Number.isFinite(prediction?.predictedRating)?prediction.predictedRating:null,actual,probability:Number.isFinite(prediction?.probability4Plus)?prediction.probability4Plus:0};}
function recommendation(film){
 const item=enrichment.films[String(film.id)]||{},p=item.prediction,actual=item.actualRating;
 if(actual===null||actual===undefined){if(!p)return '';}
 const actualBadge=actual===null||actual===undefined?'':`<div class="score-badge score-actual" aria-label="Моя оценка ${Number(actual).toFixed(1)} из 5"><span>МОЯ ОЦЕНКА</span><strong>${Number(actual).toFixed(1)}</strong></div>`;
 const predictedBadge=p?`<div class="score-badge score-predicted${p.stale?' is-stale':''}" aria-label="Прогноз ${Number(p.predictedRating).toFixed(1)} из 5${p.stale?', ожидает пересчёта':''}"><span>ПРОГНОЗ</span><strong>${Number(p.predictedRating).toFixed(1)}</strong>${p.stale?'<small>ожидает пересчёта</small>':''}</div>`:'';
 return `<div class="film-score-badges">${actualBadge}${predictedBadge}</div>`;
}
function moodTags(film){const ids=[...filmFacets(film).moods];return ids.length?`<div class="film-moods">${ids.slice(0,4).map(id=>`<span>${escapeHTML(moodLabel(id))}</span>`).join('')}</div>`:'';}
function lastChanceBadge(film){
 if(!isLastChance(film))return '';
 const until=new Date(availabilityTime(film)),label=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(until);
 return `<span class="last-chance-badge" title="До ${escapeHTML(label)}" aria-label="Последний шанс: до ${escapeHTML(label)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Последний шанс</span>`;
}
function card(film){
 const item=enrichment.films[String(film.id)]||{},hasScore=item.actualRating!==null&&item.actualRating!==undefined||!!item.prediction;
 return `<article class="movie-card${startedIds.has(String(film.id))?' is-started':''}${hasScore?' has-score':''}" data-film-id="${escapeHTML(film.id)}">${recommendation(film)}<div class="film-head">${film.poster?`<img class="poster" src="${escapeHTML(film.poster)}" alt="Постер ${escapeHTML(film.original)}" width="78" height="117" loading="lazy" referrerpolicy="no-referrer">`:`<div class="poster no-poster" aria-label="Постер недоступен">${film.year||"Кино"}</div>`}<div class="film-info"><h3><a class="film-open" href="${filmHref(film.id)}" data-film-id="${escapeHTML(film.id)}">${escapeHTML(film.title)}</a>${letterboxdLink(film)}</h3><p class="original">${escapeHTML(film.original)}</p><span class="film-year">${film.year}${film.runtime?` · ${Math.round(film.runtime)} мин`:''}</span><div class="film-tags">${film.genres.map(escapeHTML).join(' · ')}</div>${lastChanceBadge(film)}</div></div>${moodTags(film)}${synopsis(film)}${credits(film)}<div class="screenings">${state.period!=='future'?group(film,'archive'):''}${state.period!=='archive'?group(film,'future'):''}</div>${!periodShows(film,'all').length?'<p class="archive-only">Нет показов в текущем окне программы</p>':state.period==='all'&&!film.shows.some(isFuture)?'<p class="archive-only">В следующие сутки показов нет</p>':''}${startedButton(film)}</article>`;
}
function visibleFilms(){const now=nowMs();return films.filter(eligible).filter(f=>inSelectedScope(f)).sort((a,b)=>{const title=a.title.localeCompare(b.title,'ru',{sensitivity:'base'})||String(a.id).localeCompare(String(b.id));if(state.sort==='title')return title;if(state.sort==='relevance'){const parsed=searchTokens(state.query);const rank=item=>{const value=searchRank(item,parsed.normalized,parsed.tokens);return value===null?99:value;};return rank(a)-rank(b)||title;}if(state.sort==='personal'){const x=personal(a),y=personal(b);if(x.rating===null)return y.rating===null?title:1;if(y.rating===null)return -1;return y.rating-x.rating||Number(y.actual)-Number(x.actual)||y.probability-x.probability||title;}if(state.sort==='expiring'){const deadline=f=>{const time=availabilityTime(f);return time!==null&&time>now?time:Infinity;};return deadline(a)-deadline(b)||title;}const extreme=(film,pred,empty,pick)=>{const values=film.shows.filter(pred).map(showStart).filter(start=>start!==null);return values.length?pick(...values):empty;};return state.period==='archive'?extreme(b,isArchive,-Infinity,Math.max)-extreme(a,isArchive,-Infinity,Math.max):extreme(a,isFuture,Infinity,Math.min)-extreme(b,isFuture,Infinity,Math.min)||title;});}

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
  $('#empty').hidden=visible.length>0||!valid;
  const emptyCopy=$('#empty p');if(emptyCopy)emptyCopy.textContent=blackZone()&&state.lastChanceOnly?'Последний шанс сейчас не к чему применить: доступных показов нет.':'Измени название, выбери другой жанр или расширь диапазон лет.';
  updateProgrammeStatus();
  const shows=visible.reduce((n,f)=>n+periodShows(f).length,0);
  $('#result-count').textContent=valid?`${visible.length} ${filmWord(visible.length)} · ${shows} ${showWord(shows)}`:!validYear?'Проверь диапазон лет':'Проверь длительность';
  const sortBox=$('#sort');if(sortBox)sortBox.value=state.sort;
 syncSearchControls();
  $('#sort-time').textContent=state.period==='archive'?'Свежие показы — сначала':'Ближайшие эфиры — сначала';
  syncUrl();
  if(filmScreen)renderFilmShell();
  noteTimeView(valid?visible:[]);
  return {period:state.period,query:state.query,genres:[...state.genres],mechanics:[...state.mechanics],moods:[...state.moods],years:[state.from,state.to],maxRuntime:state.maxRuntime,minPrediction:state.minPrediction,minProbability:state.minProbability,films:visible.map(f=>({id:f.id,title:f.title,year:f.year,shows:periodShows(f)}))};
}
function reset(){state.shortlistMode='now';state.viewing='any';state.minPrediction=null;state.minProbability=null;state.includeUnscheduled=false;$('#include-unscheduled').checked=false;state.startedOnly=false;$('#started-only').checked=false;state.lastChanceOnly=false;$('#last-chance-only').checked=false;for(const key of ['directors','actors']){state[key]='';$('#'+key+'-input').value='';$('#'+key+'-options').hidden=true;$('#'+key+'-input').setAttribute('aria-expanded','false');}state.period='all';state.sort='title';state.sortExplicit=false;state.query='';state.searchScopes=defaultSearchScopes();state.genres.clear();state.mechanics.clear();state.moods.clear();state.channels.clear();for(const selected of Object.values(state.execution))selected.clear();closeFacet();state.from=1900;state.to=MAX_YEAR;state.maxRuntime=null;$('#year-from').value=1900;$('#year-to').value=MAX_YEAR;$('#runtime-max').value='';for(const selector of ['#genres input','#mechanics input','#moods input','#execution input'])document.querySelectorAll(selector).forEach(i=>i.checked=false);render();}
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
let enrichmentKey='',enrichmentLoading=false,footerReady=false,footerLoading=false;
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
function renderPresets(){
 const list=$('#preset-list'),empty=$('#presets-empty'),status=$('#preset-status'),editor=$('#preset-editor');
 if(!list||!empty||!status)return;
 empty.hidden=presets.length>0;
 status.textContent=presetStatus;
 if(editor)editor.hidden=!presetEditor;
 list.innerHTML=presets.map(preset=>{
  const prompt=presetPrompt?.id===preset.id;
  const actions=prompt?`<p class="preset-confirm">${presetPrompt.action==='delete'?'Удалить этот сценарий?':'Заменить сохранённые условия текущими?'}</p><button type="button" data-preset-confirm="${presetPrompt.action}">Да</button><button type="button" data-preset-dismiss>Нет</button>`:`<button type="button" data-preset-rename>Переименовать</button><button type="button" data-preset-update>Обновить</button><button type="button" data-preset-delete>Удалить</button>`;
  return `<li class="preset-row"><button type="button" class="preset-apply" data-preset-apply="${escapeHTML(preset.id)}">${escapeHTML(preset.name)}</button><details class="preset-actions"${prompt?' open':''}><summary aria-label="Действия: ${escapeHTML(preset.name)}">⋯</summary><div>${actions}</div></details></li>`;
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
 if(filmIdFromLocation())writeFilmQuery(urlForState('https://iptv.local/').search);
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
 $('#movies').addEventListener('click',onMovieClick);
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
 $('#status-events-link').addEventListener('click',event=>{event.preventDefault();openEventsScreen($('#status-events-link'));});
 const integrationEvents=$('#status-integrations-events');if(integrationEvents)integrationEvents.addEventListener('click',event=>{event.preventDefault();openEventsScreen(integrationEvents);});
 const activityExpand=$('#activity-expand');if(activityExpand)activityExpand.addEventListener('click',()=>openEventsScreen(activityExpand));
 const activityBack=$('#activity-back');if(activityBack)activityBack.addEventListener('click',closeEventsScreen);
 const filmBack=$('#film-back');if(filmBack)filmBack.addEventListener('click',closeFilm);
 $('#reset').addEventListener('click',reset);$('#empty-reset').addEventListener('click',reset);$('#activity-more').addEventListener('click',()=>loadEvents(true));
 const presetSave=$('#preset-save');if(presetSave)presetSave.addEventListener('click',()=>{presetEditor={mode:'create'};presetPrompt=null;renderPresets();const input=$('#preset-name');if(input){input.value='';input.focus();}});
 const presetEditorForm=$('#preset-editor');if(presetEditorForm)presetEditorForm.addEventListener('submit',event=>{event.preventDefault();const name=$('#preset-name').value;if(presetEditor?.mode==='rename')renamePreset(presetEditor.id,name);else createPreset(name);});
 const presetCancel=$('#preset-cancel');if(presetCancel)presetCancel.addEventListener('click',()=>{presetEditor=null;renderPresets();});
 const presetList=$('#preset-list');if(presetList)presetList.addEventListener('click',event=>{
  const apply=event.target.closest?.('[data-preset-apply]');
  if(apply){const preset=presets.find(item=>item.id===apply.dataset.presetApply);if(preset)applyPresetQuery(preset.query);return;}
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
 if(eventsRequested()){const here=new URL(window.location.href);if((here.pathname.replace(/\/+$/,'')||'/')!=='/events'){writeFilmQuery(filmSearchFrom(here.href));window.history.replaceState(window.history.state,'','/events');}applyEventsScreen(true);}
 else{const openingFilm=filmIdFromLocation();if(openingFilm)applyFilmScreen(openingFilm);}
 setYearBounds(true);
 try{await loadProgramme();}
 catch(error){showProgrammeUnavailable(error);console.error(error);}
 loadStarted();
 loadPresets();
 loadEvents();
 loadEnrichment();
 loadPredictionQueue();
 startLiveRefresh();
}

async function loadEnrichment(options={}){if(enrichmentLoading)return 'busy';enrichmentLoading=true;try{const response=await fetch('/api/enrichment/view');if(!response.ok)throw new Error();const data=await response.json();if(!data||typeof data.films!=='object')throw new Error();const key=JSON.stringify(data);if(key===enrichmentKey)return true;enrichmentKey=key;enrichment=data;ratingsLoaded=true;updateFacetOptions();renderPreservingScroll();return true;}catch{if(!ratingsLoaded&&!options.quiet)render();return false;}finally{enrichmentLoading=false;}}
 const FOOTER_RUN_STATUS={idle:'не запускался',running:'выполняется',completed:'завершён',blocked:'приостановлен',interrupted:'прерван'};
const INTEGRATION_STATE={healthy:'работает',degraded:'требует внимания',failed:'сбой',stale:'давний успех',unknown:'нет данных',off:'выключено',running:'выполняется'};
const INTEGRATION_CODE={ok:'',stale:'последний успех давно',no_data:'',off:'отдельное обновление выключено',running:'',ratings_blocked:'список оценок временно недоступен',ratings_incomplete:'список оценок прочитан не полностью',ratings_rate_limit:'слишком много запросов',ratings_failed:'оценки прочитать не удалось',ratings_pending:'оценки в этом обновлении не прочитаны',watchlist_failed:'watchlist прочитать не удалось',watchlist_stuck:'синхронизация не завершилась',epg_http:'загрузка EPG не удалась',epg_window:'EPG не покрывает текущее окно',epg_parse:'разбор EPG не удался',epg_failed:'обновление EPG не завершилось',resolver_backoff:'распознавание подождёт: слишком много запросов',resolver_unconfigured:'распознавание не настроено',resolver_failed:'распознавание остановилось',prediction_interrupted:'запуск прерван',prediction_blocked:'прогнозы приостановлены',prediction_partial:'часть прогнозов не сохранилась',metadata_attention:'метаданные и локализация требуют внимания'};
const FOOTER_RUN_REASON={queue_empty:'очередь обработана',eligible_queue_empty:'пакет завершён',retry_backoff:'повтор позже',quota:'лимит',time_budget:'лимит времени',parse_error:'ошибка формата',storage_error:'ошибка хранения',model_error:'ошибка модели',model_unavailable:'модель недоступна',api_error:'ошибка API',lease_lost:'сеанс потерян',lease_expired:'сеанс истёк',profile_changed:'модель вкуса обновлена',format_error_storm:'ошибки формата',external_termination:'внешняя остановка',priority_changed:'приоритет обновлён'};
function formatCoveragePercent(value){const number=Number(value);return Number.isFinite(number)?`${number.toLocaleString('ru',{maximumFractionDigits:1})}%`:'';}
function footerStatusText(data){
 const n=value=>(Number.isFinite(Number(value))?Number(value):0).toLocaleString('ru'),pct=value=>Number.isFinite(Number(value))?` · ${formatCoveragePercent(value)}`:'',date=(value,options)=>{const ms=typeof value==='number'?value:Date.parse(value);return Number.isFinite(ms)?new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',...options}).format(new Date(ms)):'—';};
 const c=data.coverage||{},p=data.predictions||{},epg=data.epgTmdb||{},watchlist=data.watchlist||{},run=data.lastRun,profile=data.profile;
 const local=`${n(c.currentPredictionsTotal)}/${n(c.confirmedFilmsTotal)} с актуальным прогнозом${pct(c.localPercent)}`;
 const windowCoverage=`${n(c.windowCurrentPredictions)}/${n(c.windowFilmsTotal)} с актуальным прогнозом${pct(c.windowPercent)}`;
 const active=run?.status==='running',runStatus=run?FOOTER_RUN_STATUS[run.status]||'завершён':'не запускался',runReason=run?.reason?FOOTER_RUN_REASON[run.reason]||'ошибка':'',next=date(p.nextScheduledRun,{hour:'2-digit',minute:'2-digit'}),runLine=`${runStatus}${runReason?` / ${runReason}`:''}`,nextDetail=date(p.nextScheduledRun,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
 const integrations=data.integrations||{},attention=integrations.attentionCount||0,attentionWord=attention%10===1&&attention%100!==11?'требует':'требуют',integrationAggregate=integrations.aggregate==='failed'?'есть сбой':integrations.aggregate==='attention'?`${attention.toLocaleString('ru')} ${attentionWord} внимания`:integrations.aggregate==='healthy'?'всё работает':'нет данных';
 const integrationLine=source=>{if(!source)return 'нет данных';const word=INTEGRATION_STATE[source.state]||'нет данных',detail=INTEGRATION_CODE[source.code]||'',capability=source.manualRefreshEnabled===false?INTEGRATION_CODE.off:'',when=source.lastSuccessAt&&source.state!=='unknown'?`успех ${date(source.lastSuccessAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`:'';return [word,detail&&detail!==word?detail:'',capability,when].filter(Boolean).join(' · ');};
 const byId=Object.fromEntries((integrations.sources||[]).map(source=>[source.id,source]));
 return {profile:profile?`v${profile.version} · обновлена ${date(profile.updatedAt,{day:'numeric',month:'short'})}`:'не настроена',local,windowCoverage,runLabel:active?'Текущий run':'Последний run',runHeading:active?'Текущий запуск':'Последний запуск',runLine,nextLine:`Следующий запуск: ${next==='—'?'—':`около ${next}`}`,localDetail:local,windowDetail:windowCoverage,pendingHot:n(p.pendingHot),pendingCold:n(p.pendingCold),cacheOffWindow:n(c.cacheOffWindowTotal),pendingOffWindow:n(p.pendingOffWindow),currentBatch:p.currentBatch?.size?`${n(p.currentBatch.size)} фильмов`:'нет активного',nextBatch:p.nextBatchSize?`до ${n(p.nextBatchSize)} фильмов`:'очередь пуста',epgRecognized:n(epg.recognizedFilms),epgPending:n(epg.pendingRecognition),epgHistory:n(epg.historicalUnresolved),epgConfirmed:n(epg.confirmedMovies),epgCache:n(epg.cacheOffWindow),epgCoverage:epg.epgStart||epg.epgEnd?`${date(epg.epgStart,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} — ${date(epg.epgEnd,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`:'—',epgChannels:n(epg.channels),epgChecked:n(epg.checkedTransmissions),watchlistFilms:n(watchlist.films),watchlistUpdated:date(watchlist.updatedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}),watchlistMetadata:n(watchlist.metadataMissing),watchlistTitles:n((watchlist.titleMissing||0)+(watchlist.titleProvisional||0)),runStarted:date(run?.startedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}),runAdded:n(run?.added),runFailed:n(run?.failed),runResult:`${runStatus}${runReason?` · ${runReason}`:''}`,nextRun:nextDetail==='—'?'—':`около ${nextDetail}`,profileVersion:profile?`v${profile.version}`:'—',profileUpdated:date(profile?.updatedAt,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}),integrationAggregate,integrations:{letterboxd_watchlist:integrationLine(byId.letterboxd_watchlist),letterboxd_ratings:integrationLine(byId.letterboxd_ratings),epg:integrationLine(byId.epg),resolver:integrationLine(byId.resolver),predictions:integrationLine(byId.predictions),metadata:byId.metadata?integrationLine(byId.metadata):''}};
}
function renderFooterStatus(data){const text=footerStatusText(data),values={
 'taste-version':text.profile,'status-local-coverage':text.local,'status-window-coverage':text.windowCoverage,'status-run-label':text.runLabel,'status-last-run':text.runLine,'status-next-run':text.nextLine,'status-run-title':text.runHeading,
 'detail-local-coverage':text.localDetail,'detail-window-coverage':text.windowDetail,'detail-pending-hot':text.pendingHot,'detail-pending-cold':text.pendingCold,'detail-cache-off-window':text.cacheOffWindow,'detail-pending-off-window':text.pendingOffWindow,'detail-current-batch':text.currentBatch,'detail-next-batch':text.nextBatch,
 'detail-epg-recognized':text.epgRecognized,'detail-epg-pending':text.epgPending,'detail-epg-history':text.epgHistory,'detail-epg-confirmed':text.epgConfirmed,'detail-epg-cache':text.epgCache,'detail-epg-coverage':text.epgCoverage,'detail-epg-channels':text.epgChannels,'detail-epg-checked':text.epgChecked,
 'detail-watchlist-films':text.watchlistFilms,'detail-watchlist-updated':text.watchlistUpdated,'detail-watchlist-metadata':text.watchlistMetadata,'detail-watchlist-titles':text.watchlistTitles,
 'detail-run-started':text.runStarted,'detail-run-added':text.runAdded,'detail-run-failed':text.runFailed,'detail-run-reason':text.runResult,'detail-run-next':text.nextRun,'detail-profile-version':text.profileVersion,'detail-profile-updated':text.profileUpdated,'status-integrations':text.integrationAggregate,'integration-watchlist':text.integrations.letterboxd_watchlist,'integration-ratings':text.integrations.letterboxd_ratings,'integration-epg':text.integrations.epg,'integration-resolver':text.integrations.resolver,'integration-predictions':text.integrations.predictions,'integration-metadata':text.integrations.metadata};for(const [id,value] of Object.entries(values)){const node=$('#'+id);if(node)node.textContent=value;}
 const metadata=$('[data-integration="metadata"]');if(metadata)metadata.hidden=!text.integrations.metadata;
 for(const [id,key] of [['integration-watchlist','letterboxd_watchlist'],['integration-ratings','letterboxd_ratings'],['integration-epg','epg'],['integration-resolver','resolver'],['integration-predictions','predictions'],['integration-metadata','metadata']]){const node=$('#'+id),source=(data.integrations?.sources||[]).find(item=>item.id===key);if(!node)continue;node.classList.remove('is-failed','is-attention');if(source?.state==='failed')node.classList.add('is-failed');else if(source&&['degraded','stale','unknown'].includes(source.state))node.classList.add('is-attention');}}
async function loadPredictionQueue(options={}){if(footerLoading)return 'busy';footerLoading=true;try{const response=await fetch('/api/enrichment/footer/status');if(!response.ok)throw new Error();renderFooterStatus(await response.json());footerReady=true;return true;}catch{if(!footerReady&&!options.quiet){const unavailable='статус недоступен';$('#status-local-coverage').textContent=unavailable;$('#status-window-coverage').textContent=unavailable;$('#status-last-run').textContent=unavailable;$('#status-integrations').textContent=unavailable;}return false;}finally{footerLoading=false;}}
function endedPhrase(at,now){const hours=Math.max(0,Math.floor((now-at)/3600000));let previous=now;const today=madridDay(now);do{previous-=3600000;}while(madridDay(previous)===today);if(madridDay(at)===madridDay(previous))return 'вчера';if(hours<1)return 'только что';return `${hours} ч назад`;}
function programmeStatus(model=viewingWindow()){
 const title='Границы сохранённого снимка. Это не гарантия, что у каждого канала есть передача до конца окна.';
 if(!model?.envelope||model.black)return {level:'critical',badge:'Нет актуального окна',coverage:'Программа и архив недоступны; ждём обновления',title:model?.basis==='estimate'?'У снимка не было окна. Оценка по времени снимка тоже закончилась.':'Сохранённое окно закончилось или его не удалось прочитать.'};
 if(model.basis==='estimate')return {level:'warning',badge:'Окно оценено по снимку',coverage:`Оценка по времени снимка · программа до ${madridStamp(model.envelope.to)}`,title};
 if(!model.future){const span=model.archive.to-model.archive.from;const ended=`Программа закончилась ${endedPhrase(model.envelope.to,model.now)}`;const archive=`Архив с ${madridStamp(model.archive.from)}`;if(span<=3600000)return {level:'warning',badge:'Архив заканчивается',coverage:`${ended} · ${archive} · осталось меньше часа`,title};return {level:'warning',badge:'Будущее закончилось',coverage:`${ended} · ${archive}`,title};}
 const archive=model.archive?`Архив с ${madridStamp(model.archive.from)} · `:'';
 return {level:'ok',badge:'Программа актуальна',coverage:`${archive}Программа до ${madridStamp(model.future.to)}`,title};
}
function updateProgrammeStatus(){
 const badge=$('#connection-badge'),coverage=$('#snapshot-coverage'),updated=$('#snapshot-updated'),note=$('#window-note');
 if(!report){if(badge&&programmeRefreshError){badge.textContent='Ошибка обновления';badge.classList?.remove('is-ok','is-warning','is-critical');badge.classList?.add('is-error');}return;}
 const status=programmeStatus();
 if(updated)updated.textContent=`Обновлено ${madridStamp(Date.parse(report.updatedAt))}`;
 if(coverage){coverage.textContent=status.coverage;coverage.title=status.title;}
 if(badge){badge.classList?.remove('is-ok','is-warning','is-critical','is-error');if(programmeRefreshError){badge.textContent='Ошибка обновления';badge.title='Последний снимок сохранён. Ошибка обновления не заменяет состояние окна.';badge.classList?.add('is-error');}else{badge.textContent=status.badge;badge.title=status.title;badge.classList?.add(status.level==='ok'?'is-ok':status.level==='warning'?'is-warning':'is-critical');}}
 if(note){note.hidden=!blackZone();note.textContent=state.lastChanceOnly?'Последний шанс сейчас не к чему применить: доступных показов нет. Фильтры не изменены.':'Окно программы закончилось. Показаны фильмы из watchlist без расписания. Архив и следующие сутки пусты, пока не придёт новый снимок.';}
}
function updateSourceInfo(){updateProgrammeStatus();}
function eventHTML(event,olderEnrichment=null){const date=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(event.at));const film=f=>`${escapeHTML(f.title)}${f.year?` (${escapeHTML(f.year)})`:''}`;const removal=f=>{const rating=Number(f.rating),known=Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0;return `${film(f)}${known?` · ${rating.toFixed(1)} ★`:''}`;};let body='';
 if(event.type==='started'||event.type==='unstarted')body=`<p>${event.type==='started'?'Начал смотреть':'Снял отметку «Начал»'}: <strong>${film(event.film)}</strong></p>`;
 if(event.type==='epg')body=`<p>Обновлён EPG</p><dl><div><dt>Фильмов с показами</dt><dd>${event.films}</dd></div><div><dt>В архиве</dt><dd>${event.archive}</dd></div><div><dt>В следующие сутки</dt><dd>${event.future}</dd></div><div><dt>Всего показов</dt><dd>${event.broadcasts}</dd></div></dl>`;
 if(event.type==='watchlist'){const half=f=>{const rating=Number(f.rating);return Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0;},group=(title,films,line)=>films.length?`<details class="event-group" open><summary><h3>${title} · ${films.length}</h3></summary><ul>${films.map(f=>`<li>${line(f)}</li>`).join('')}</ul></details>`:'';body=`<p>Обновлён watchlist · ${event.total} ${filmWord(event.total)}</p>`+group('Вероятно просмотрены',(event.removed||[]).filter(half),removal)+group('Остальные удаления',(event.removed||[]).filter(f=>!half(f)),film)+group('Добавлены фильмы',event.added||[],film);if(!event.added?.length&&!event.removed?.length)body+=`<p class="event-note">${event.baseline?'Исходный сохранённый список':'Состав без изменений'}</p>`;}
 if(event.type==='enrichment'&&event.queueSchemaVersion>=6){const delta=event.delta||{added:event.added??0,updated:event.updated??0,failed:event.failed??0},snapshot=event.snapshot||{},coverage=snapshot.coverage||{},queue=snapshot.queue||{},isStart=['started','resumed'].includes(event.stage),stop=event.stopReason||event.reason,reason={queue_empty:'Очередь обработана полностью.',eligible_queue_empty:'Готовая часть очереди обработана; отложенные фильмы будут повторены позже.',retry_backoff:'Следующая попытка начнётся после паузы для отложенных фильмов.',quota:'Достигнут доступный лимит. Сохранённый прогресс продолжится в следующем запуске.',time_budget:'Закончилось время прохода. Прогресс сохранён.',parse_error:'Некоторые ответы не удалось разобрать; фильмы остаются для повторной попытки.',storage_error:'Часть результатов не удалось сохранить. Следующий запуск повторит попытку.',model_error:'Модель не завершила часть прогнозов. Следующий запуск продолжит очередь.',model_unavailable:'Модель временно недоступна. Сохранённый прогресс не потерян.',api_error:'Сервис временно недоступен. Сохранённый прогресс не потерян.',lease_lost:'Запуск потерял право записи и безопасно остановлен.',lease_expired:'Предыдущий запуск оборвался. Сохранённые прогнозы переиспользуются.',runner_aborted:'Запуск оборвался до завершения. Сохранённый прогресс не потерян.',priority_changed:'Очередь изменилась; следующий запуск продолжит с актуального приоритета.',profile_changed:'Модель вкуса изменилась между запусками.',format_error_storm:'Несколько фильмов подряд получили ответы неверного формата. Проход остановлен, результаты сохранены.',external_termination:'Запуск остановлен извне. Сохранённый прогресс не потерян.'}[stop],local=Number.isInteger(coverage.currentPredictionsTotal)&&Number.isInteger(coverage.confirmedFilmsTotal)?`<p class="event-note">Локальная база: ${coverage.currentPredictionsTotal} из ${coverage.confirmedFilmsTotal} · ${formatCoveragePercent(coverage.localPercent)}.</p>`:'',window=Number.isInteger(coverage.windowCurrentPredictions)&&Number.isInteger(coverage.windowFilmsTotal)?`<p class="event-note">Окно просмотра: ${coverage.windowCurrentPredictions} из ${coverage.windowFilmsTotal} · ${formatCoveragePercent(coverage.windowPercent)}.</p>`:'',hot=queue.hotPending??event.hotRemaining??'нет данных',cold=queue.coldPending??event.coldRemaining??'нет данных',gain=Number.isInteger(delta.predictionGain)&&delta.predictionGain!==0?` · ${delta.predictionGain>0?'+':''}${delta.predictionGain} актуальных прогнозов`:'';if(isStart){const title=event.runState==='recovered'?'Прогнозы восстановлены':event.stage==='resumed'?'Прогнозы продолжены':'Прогнозы запущены';body=`<p>${title}</p>${local}${window}<p class="event-note">Очередь: ${hot} в окне · ${cold} вне окна.</p>${snapshot.currentBatchSize||event.currentBatchSize?`<p class="event-note">Текущий пакет: ${snapshot.currentBatchSize||event.currentBatchSize}.</p>`:''}`;}else{const title=event.stage==='running'?'Прогнозы считаются · промежуточный итог':event.stage==='partial'||event.stage==='blocked'?'Прогнозы приостановлены':'Прогнозы обновлены';body=`<p>${title}</p><p class="event-note">С начала запуска: добавлено ${delta.added??0}${delta.updated?` · пересчитано ${delta.updated}`:''} · не удалось ${delta.failed??0}${gain}.</p>${local}${window}<p class="event-note">Осталось: ${hot} в окне · ${cold} вне окна${event.batchesProcessed>1?` · пакетов обработано: ${event.batchesProcessed}`:''}.</p>${stop?`<p class="event-note">Причина: ${escapeHTML(stop)}.</p>`:''}${reason?`<p class="event-note">${reason}</p>`:''}`;}}
 else if(event.type==='enrichment'&&['started','resumed'].includes(event.stage)){body=`<p>${event.stage==='resumed'?'Прогнозы продолжены':'Прогнозы запущены'}</p><p class="event-note">В окне просмотра ждут прогноза: ${event.hotRemaining??'нет данных'} · вне окна: ${event.coldRemaining??'нет данных'}.</p>${event.currentBatchSize?`<p class="event-note">Текущий пакет: ${event.currentBatchSize}.</p>`:''}`;}
 else if(event.type==='enrichment'&&event.queueSchemaVersion>=3){const added=event.added??event.created??0,updated=event.updated??event.recalculated??0,reason={quota:'Достигнут лимит использования. Сохранённый прогресс продолжится в следующем запуске.',time_budget:'Закончилось время прохода. Прогресс сохранён.',parse_error:'Не удалось разобрать часть ответов. Эти фильмы остаются в очереди.',storage_error:'Часть результатов не удалось сохранить. Следующий запуск повторит попытку.',model_error:'Часть прогнозов не рассчитана. Следующий запуск продолжит очередь.',lease_expired:'Предыдущий запуск оборвался. Сохранённые прогнозы переиспользуются.',profile_changed:'Модель вкуса изменилась между запусками.',format_error_storm:'Несколько фильмов подряд получили ответы неверного формата. Проход остановлен, результаты сохранены.'}[event.reason];body=`<p>${event.stage==='running'?'Прогнозы считаются · промежуточный итог':event.stage==='blocked'?'Прогнозы ждут следующего запуска':event.stage==='partial'?(event.queueSchemaVersion>=5?'Прогнозы приостановлены':'Прогнозы сохранены, проход прерван'):'Прогнозы обновлены'}</p><p class="event-note">Добавлено: ${added}${updated?` · пересчитано: ${updated}`:''}${event.failed?` · не удалось: ${event.failed}`:''}.</p><p class="event-note">В окне просмотра ждут прогноза: ${event.hotRemaining??(event.queueSchemaVersion>=5?'нет данных':0)}${event.queueSchemaVersion>=4?` · вне окна: ${event.coldRemaining??(event.queueSchemaVersion>=5?'нет данных':0)}`:''}.</p>${event.queueSchemaVersion>=5&&event.reason?`<p class="event-note">Причина: ${escapeHTML(event.reason)}</p>`:''}${event.stopReason==='eligible_queue_empty'&&event.failed?`<p class="event-note">Фильмы с ошибками сохранены для повторной попытки.</p>`:''}${reason?`<p class="event-note">${reason}</p>`:''}`;}
 else if(event.type==='enrichment'){const added=event.added??event.created??0,updated=event.updated??event.recalculated??0,changed=added+updated,remaining=Number.isInteger(event.remaining)?event.remaining:null,previous=Number.isInteger(olderEnrichment?.remaining)&&(!event.queueSchemaVersion||event.queueSchemaVersion===olderEnrichment.queueSchemaVersion)?olderEnrichment.remaining:null,arrived=previous===null||remaining===null?null:remaining-previous+changed;body=`<p>${event.stage==='partial'||event.failed||event.pending?'Пакет прогнозов прерван':changed?'Прогнозы рассчитаны':'Очередь проверена'}</p><p class="event-note">За проход: ${added} новых${updated?` · ${updated} пересчитано`:''}${event.failed?` · ${event.failed} не удалось`:''}.</p>${remaining!==null?`<p class="event-note">После прохода ждут прогноза: ${remaining}${Number.isInteger(event.hotRemaining)?` (в окне просмотра: ${event.hotRemaining})`:""}.</p>`:''}${arrived>0?`<p class="event-note">Очередь: ${previous} + ${arrived} поступило − ${changed} готово = ${remaining}. Новые задачи появляются при проверке EPG.</p>`:''}${event.reason?`<p class="event-note">Причина: ${escapeHTML(event.reason)}</p>`:''}`;}
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
async function loadEvents(more=false,options={}){if(eventLoading)return 'busy';eventLoading=true;const button=$('#activity-more');button.disabled=true;button.classList.toggle('is-loading',more);if(more){button.setAttribute('aria-busy','true');button.textContent='Загружаем события…';if(!options.quiet)$('#activity-status').textContent='Загружаем более давние события…';}try{const response=await fetch('/api/events'+(more&&eventCursor?'?cursor='+encodeURIComponent(eventCursor):''));if(!response.ok)throw new Error();const data=await response.json();const keepCursor=!more&&loadedEvents.size>20;for(const event of data.events)loadedEvents.set(event.id,event);const scroll=document.querySelector('.activity-scroll'),anchor=rememberActivityAnchor(scroll),position=scroll?scroll.scrollTop:0,ordered=[...loadedEvents.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id)),olderById=new Map();let older=null;for(const event of [...ordered].reverse())if(event.type==='enrichment'){olderById.set(event.id,older);older=event;}$('#activity-list').innerHTML=ordered.map(event=>eventHTML(event,olderById.get(event.id))).join('');restoreActivityAnchor(scroll,anchor,position);if(!keepCursor)eventCursor=data.cursor;$('#activity-status').textContent=!more&&!data.events.length?'Здесь появятся события списка.':'';button.hidden=!eventCursor;button.textContent='Более давние события';return true;}catch{if(!options.quiet){$('#activity-status').textContent='Не удалось загрузить события.';button.hidden=false;button.textContent='Повторить';}return false;}finally{eventLoading=false;button.classList.remove('is-loading');button.removeAttribute('aria-busy');button.disabled=false;}}
function initFilmCompare(){
 const input=$('#film-compare-input'),list=$('#film-compare-options'),clear=$('#film-compare-clear'),root=$('#film-compare-combo');
 if(!input||!list||!clear||!root||typeof input.addEventListener!=='function')return;
 let matches=[],active=-1;
 const showResult=()=>{const current=films.find(item=>String(item.id)===String(filmScreen));if(current)setFilmHtml('film-compare-result',filmCompare(current));};
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
