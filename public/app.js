'use strict';
let CUTOFF = Date.now();
let WINDOW_START=null,WINDOW_END=null;
let MAX_YEAR = Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Madrid',year:'numeric'}).format(new Date()));
let report = null;
let enrichment={profile:null,films:{}};
let ratingsLoaded=false;
const state = { period: 'all', sort: 'title', viewing: 'any', minPrediction: null, minProbability: null, startedOnly: false, lastChanceOnly: false, includeUnscheduled: false, directors: '', actors: '', query: '', genres: new Set(), from: 1900, to: MAX_YEAR, maxRuntime: null };
const APP_QUERY_KEYS = ['view','period','q','sort','genre','from','to','runtime','viewing','started','lastChance','director','actor','prediction','chance'];
let urlReady=false,urlRestoring=false;
function readUrlState(url){
 const p=url.searchParams,defaults={period:'all',sort:'title',viewing:'any',minPrediction:null,minProbability:null,startedOnly:false,lastChanceOnly:false,includeUnscheduled:false,directors:'',actors:'',query:'',genres:new Set(),from:1900,to:MAX_YEAR,maxRuntime:null};
 if(p.get('view')==='watchlist')defaults.includeUnscheduled=true;
 if(['all','archive','future'].includes(p.get('period')))defaults.period=p.get('period');
 if(['title','personal','expiring','time'].includes(p.get('sort')))defaults.sort=p.get('sort');
 if(['any','new','rewatch'].includes(p.get('viewing')))defaults.viewing=p.get('viewing');
 defaults.query=p.get('q')||'';
 defaults.genres=new Set(p.getAll('genre').filter(g=>genres.includes(g)));
 const year=key=>/^\d{4}$/.test(p.get(key)||'')?Number(p.get(key)):null;
 const from=year('from'),to=year('to');
 if(from!==null&&from>=1900&&from<=MAX_YEAR)defaults.from=from;
 if(to!==null&&to>=1900&&to<=MAX_YEAR)defaults.to=to;
 if(defaults.from>defaults.to){defaults.from=1900;defaults.to=MAX_YEAR;}
 const runtime=p.get('runtime');if(/^[1-9]\d*$/.test(runtime||'')&&Number.isSafeInteger(Number(runtime)))defaults.maxRuntime=Number(runtime);
 if(p.get('started')==='1')defaults.startedOnly=true;
 if(p.get('lastChance')==='1')defaults.lastChanceOnly=true;
 for(const [key,param] of [['directors','director'],['actors','actor']]){const id=p.get(param);if(id&&(report.people?.[key]||[]).some(person=>person.id===id))defaults[key]=id;}
 const prediction=Number(p.get('prediction')),chance=Number(p.get('chance'));
 if([3.5,4,4.5].includes(prediction))defaults.minPrediction=prediction;
 if([0.5,0.7,0.85].includes(chance))defaults.minProbability=chance;
 return defaults;
}
function urlForState(current){
 const url=new URL(current);for(const key of APP_QUERY_KEYS)url.searchParams.delete(key);
 const add=(key,value)=>url.searchParams.append(key,String(value));
 if(state.includeUnscheduled)add('view','watchlist');
 if(state.period!=='all')add('period',state.period);
 if(state.query)add('q',state.query);
 if(state.sort!=='title')add('sort',state.sort);
 for(const genre of [...state.genres].sort((a,b)=>a.localeCompare(b,'ru')))add('genre',genre);
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
function syncUrl(){
 if(!urlReady||urlRestoring||!Number.isInteger(state.from)||!Number.isInteger(state.to)||state.from<1900||state.to>MAX_YEAR||state.from>state.to||state.maxRuntime!==null&&(!Number.isInteger(state.maxRuntime)||state.maxRuntime<1))return;
 const next=urlForState(window.location.href);
 if(next.href!==window.location.href)window.history.replaceState(window.history.state,'',next.pathname+next.search+next.hash);
}
function restoreUrl(){
 urlRestoring=true;
 Object.assign(state,readUrlState(new URL(window.location.href)));
 $('#sort').value=state.sort;$('#search').value=state.query;
 $('#include-unscheduled').checked=state.includeUnscheduled;$('#started-only').checked=state.startedOnly;$('#last-chance-only').checked=state.lastChanceOnly;
 $('#year-from').value=state.from;$('#year-to').value=state.to;$('#runtime-max').value=state.maxRuntime??'';
 document.querySelectorAll('#genres input').forEach(input=>input.checked=state.genres.has(input.value));
 for(const key of ['directors','actors']){const input=$('#'+key+'-input');input.value=report.people?.[key]?.find(person=>person.id===state[key])?.name||'';input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');$('#'+key+'-options').hidden=true;}
 render();urlRestoring=false;
}
let films = [];
let eventCursor=null,eventLoading=false;const loadedEvents=new Map();
let startedIds=new Set(),startedReady=false,startedLoading=false;const savingStarted=new Set();
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let genres = ['Боевик','Триллер','Криминал','Фантастика','Ужасы','Приключения','Комедия'];
const isArchive = show => WINDOW_START===null?show.offset>=-72&&show.offset<0:show.start>=WINDOW_START&&show.start<CUTOFF;
const isFuture = show => WINDOW_END===null?show.offset>=0&&show.offset<24:show.start>=CUTOFF&&show.start<=WINDOW_END;
const normalizeTitle = text => text.toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function availabilityTime(film){const time=Date.parse(film.availableUntil||'');return Number.isFinite(time)?time:null;}
function isLastChance(film,now=Date.now()){const until=availabilityTime(film);return until!==null&&until>now&&until-now<8*3600000;}
function hasActualRating(film){const rating=enrichment.films[String(film.id)]?.actualRating;return rating!==null&&rating!==undefined;}
function eligible(film) { const query = normalizeTitle(state.query); const titleMatch = !query || [film.title,film.original,...(film.aliases||[])].some(t => normalizeTitle(t).includes(query)); const prediction=enrichment.films[String(film.id)]?.prediction; return titleMatch && (state.viewing==='any'||ratingsLoaded&&((state.viewing==='rewatch')===hasActualRating(film))) && (state.minPrediction===null||Number.isFinite(prediction?.predictedRating)&&prediction.predictedRating>=state.minPrediction) && (state.minProbability===null||Number.isFinite(prediction?.probability4Plus)&&prediction.probability4Plus>=state.minProbability) && (!state.startedOnly||startedIds.has(String(film.id))) && (!state.lastChanceOnly||isLastChance(film)) && ['directors','actors'].every(key=>!state[key]||(film[key]||[]).some(p=>p.id===state[key])) && ((film.year >= state.from && film.year <= state.to)||(!film.year&&state.from===1900&&state.to===MAX_YEAR)) && (state.maxRuntime===null||(Number(film.runtime)>0&&Number(film.runtime)<=state.maxRuntime)) && (!state.genres.size || film.genres.some(g => state.genres.has(g))); }
function periodShows(film,period=state.period) { return film.shows.filter(s => period==='archive'?isArchive(s):period==='future'?isFuture(s):isArchive(s)||isFuture(s)); }
function inSelectedScope(film,period=state.period){return periodShows(film,period).length>0||(state.includeUnscheduled&&periodShows(film,'all').length===0);}
function filmWord(n){return n%10===1&&n%100!==11?'фильм':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'фильма':'фильмов';}
function showWord(n){return n%10===1&&n%100!==11?'показ':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'показа':'показов';}
function programmeWindow(snapshot){
 const start=Number(snapshot.window?.from),end=Number(snapshot.window?.to);
 if(Number.isFinite(start)&&Number.isFinite(end)&&end-start>=24*3600000)return {start,cutoff:end-24*3600000,end};
 const cutoff=Date.parse(snapshot.updatedAt);
 return {start:cutoff-72*3600000,cutoff,end:cutoff+24*3600000};
}
function dateLabel(offset){ return new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short'}).format(new Date(CUTOFF+offset*3600000)); }

function row(show) { const date=new Date(CUTOFF+show.offset*3600000);const time=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'}).format(date);return `<div class="show-row"><span class="channel">${escapeHTML(show.channel)}${show.basis==='title_duration'?'<span class="match-hint" title="В EPG нет года: совпали название и длительность. Возможна другая версия фильма." aria-label="Предположительное совпадение по названию и длительности"> ≈</span>':''}</span><time class="show-time" datetime="${date.toISOString()}">${dateLabel(show.offset)}<b>${time}</b></time></div>`; }
function group(film,type){const shows=film.shows.filter(type==='archive'?isArchive:isFuture).sort((a,b)=>type==='archive'?b.offset-a.offset:a.offset-b.offset);if(!shows.length)return '';return `<section class="show-group ${type}"><div class="group-title"><span>${type==='archive'?'АРХИВ · 3 ДНЯ':'СЛЕДУЮЩИЕ СУТКИ'}</span><span class="show-count">${shows.length} ${showWord(shows.length)}</span></div>${row(shows[0])}${shows.length>1?`<details class="more"><summary>Ещё ${shows.length-1} ${showWord(shows.length-1)}</summary>${shows.slice(1).map(row).join('')}</details>`:''}</section>`;}
function startedButton(film){
 const id=String(film.id),on=startedIds.has(id),busy=savingStarted.has(id);
 return `<div class="started-action"><button type="button" class="started-button" data-started-id="${escapeHTML(id)}" aria-pressed="${on}" aria-busy="${busy}" aria-label="${on?'Снять отметку «Начал смотреть»':'Начал смотреть'}: ${escapeHTML(film.title)}" title="${on?'Снять отметку «Начал смотреть»':'Отметить начатый просмотр'}" ${!startedReady||busy?'disabled':''}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div>`;
}
function progressError(message){$('#progress-error-text').textContent=message;$('#progress-error').hidden=!message;}
async function loadStarted(){if(startedLoading||savingStarted.size)return;startedLoading=true;try{const r=await fetch('/api/started');if(!r.ok)throw new Error();const data=await r.json();if(!Array.isArray(data.ids))throw new Error();startedIds=new Set(data.ids.map(String));startedReady=true;$('#started-only').disabled=false;progressError('');render();}catch{progressError('Не удалось загрузить отметки просмотра. Повтори попытку.');}finally{startedLoading=false;}}
async function toggleStarted(id){if(!startedReady||startedLoading||savingStarted.has(id))return;const next=!startedIds.has(id);savingStarted.add(id);progressError('');render();try{const r=await fetch('/api/started',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,started:next})});if(!r.ok)throw new Error();const data=await r.json();if(data.id!==id||data.started!==next)throw new Error();next?startedIds.add(id):startedIds.delete(id);loadEvents();}catch{progressError('Не удалось сохранить отметку. Нажми на глаз ещё раз, чтобы повторить.');}finally{savingStarted.delete(id);render();const b=document.querySelector(`[data-started-id="${id}"]`);if(b)b.focus({preventScroll:true});}}
function creditLinks(people,key){return (people||[]).map(p=>`<button type="button" class="credit-link" data-credit-kind="${key}" data-credit-id="${escapeHTML(p.id)}" title="Показать фильмы: ${escapeHTML(p.name)}">${escapeHTML(p.name)}</button>`).join(', ');}
function credits(film){return `<div class="film-credits">${film.directors?.length?`<p><span class="credit-label">${film.directors.length>1?'Режиссёры':'Режиссёр'}</span> ${creditLinks(film.directors,'directors')}</p>`:''}${film.actors?.length?`<p><span class="credit-label">В ролях</span> ${creditLinks(film.actors,'actors')}</p>`:''}</div>`;}
function selectPerson(key,id){const p=report.people?.[key]?.find(p=>p.id===id);if(!p)return;state[key]=id;const input=$('#'+key+'-input');input.value=p.name;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');$('#'+key+'-options').hidden=true;render();}
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
function moodTags(film){const p=enrichment.films[String(film.id)]?.prediction;return p?`<div class="film-moods">${(p.moodLabels||[]).slice(0,4).map(x=>`<span>${escapeHTML(x)}</span>`).join('')}</div>`:'';}
function lastChanceBadge(film){
 if(!isLastChance(film))return '';
 const until=new Date(availabilityTime(film)),label=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(until);
 return `<span class="last-chance-badge" title="До ${escapeHTML(label)}" aria-label="Последний шанс: до ${escapeHTML(label)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Последний шанс</span>`;
}
function card(film){
 const item=enrichment.films[String(film.id)]||{},hasScore=item.actualRating!==null&&item.actualRating!==undefined||!!item.prediction;
 return `<article class="movie-card${startedIds.has(String(film.id))?' is-started':''}${hasScore?' has-score':''}" data-film-id="${escapeHTML(film.id)}" aria-label="${escapeHTML(film.title)}">${recommendation(film)}<div class="film-head">${film.poster?`<img class="poster" src="${escapeHTML(film.poster)}" alt="Постер ${escapeHTML(film.original)}" width="78" height="117" loading="lazy" referrerpolicy="no-referrer">`:`<div class="poster no-poster" aria-label="Постер недоступен">${film.year||"Кино"}</div>`}<div class="film-info"><h3>${escapeHTML(film.title)}</h3><p class="original">${escapeHTML(film.original)}</p><span class="film-year">${film.year}${film.runtime?` · ${Math.round(film.runtime)} мин`:''}</span><div class="film-tags">${film.genres.map(escapeHTML).join(' · ')}</div>${lastChanceBadge(film)}</div></div>${moodTags(film)}${synopsis(film)}${credits(film)}<div class="screenings">${state.period!=='future'?group(film,'archive'):''}${state.period!=='archive'?group(film,'future'):''}</div>${!periodShows(film,'all').length?'<p class="archive-only">Нет показов в текущем окне программы</p>':state.period==='all'&&!film.shows.some(isFuture)?'<p class="archive-only">В следующие сутки показов нет</p>':''}${startedButton(film)}</article>`;
}
function visibleFilms(){const now=Date.now();return films.filter(eligible).filter(f=>inSelectedScope(f)).sort((a,b)=>{const title=a.title.localeCompare(b.title,'ru',{sensitivity:'base'})||String(a.id).localeCompare(String(b.id));if(state.sort==='title')return title;if(state.sort==='personal'){const x=personal(a),y=personal(b);if(x.rating===null)return y.rating===null?title:1;if(y.rating===null)return -1;return y.rating-x.rating||Number(y.actual)-Number(x.actual)||y.probability-x.probability||title;}if(state.sort==='expiring'){const deadline=f=>{const time=availabilityTime(f);return time!==null&&time>now?time:Infinity;};return deadline(a)-deadline(b)||title;}return state.period==='archive'?Math.max(...b.shows.filter(isArchive).map(s=>s.offset))-Math.max(...a.shows.filter(isArchive).map(s=>s.offset)):Math.min(...a.shows.filter(isFuture).map(s=>s.offset),Infinity)-Math.min(...b.shows.filter(isFuture).map(s=>s.offset),Infinity)||title;});}
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
  $('#filter-summary').textContent = state.includeUnscheduled || state.startedOnly || state.lastChanceOnly || state.viewing!=='any' || state.minPrediction!==null || state.minProbability!==null || state.directors || state.actors || state.genres.size || state.from!==1900 || state.to!==MAX_YEAR || state.maxRuntime!==null ? `${state.genres.size ? [...state.genres].join(', ') : 'Все жанры'} · ${state.from}–${state.to}${state.maxRuntime!==null?' · до '+state.maxRuntime+' мин':''}${state.directors?' · Режиссёр':''}${state.actors?' · Актёр':''}${state.startedOnly?' · Начатые':''}${state.lastChanceOnly?' · Последний шанс':''}${state.viewing==='new'?' · Новые':state.viewing==='rewatch'?' · Пересмотр':''}${state.minPrediction!==null?' · Прогноз '+state.minPrediction.toFixed(1)+'+':''}${state.minProbability!==null?' · Шанс '+Math.round(state.minProbability*100)+'%+':''}${state.includeUnscheduled?' · Без показов тоже':''}` : 'Все фильмы';
  ['#year-from','#year-to'].forEach(s=>$(s).setAttribute('aria-invalid',String(!validYear)));
  $('#runtime-max').setAttribute('aria-invalid',String(!validRuntime));
  const filtered=valid?films.filter(eligible):[];
  for(const p of ['all','archive','future'])$(`#count-${p}`).textContent=filtered.filter(f=>inSelectedScope(f,p)).length;
  document.querySelectorAll('[data-period]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.period===state.period)));
  const visible=valid?visibleFilms():[];
  $('#movies').innerHTML=visible.map(card).join('');
  $('#empty').hidden=visible.length>0||!valid;
  const shows=visible.reduce((n,f)=>n+periodShows(f).length,0);
  $('#result-count').textContent=valid?`${visible.length} ${filmWord(visible.length)} · ${shows} ${showWord(shows)}`:!validYear?'Проверь диапазон лет':'Проверь длительность';
  $('#sort-time').textContent=state.period==='archive'?'Свежие показы — сначала':'Ближайшие эфиры — сначала';
  syncUrl();
  return {period:state.period,query:state.query,genres:[...state.genres],years:[state.from,state.to],maxRuntime:state.maxRuntime,minPrediction:state.minPrediction,minProbability:state.minProbability,films:visible.map(f=>({id:f.id,title:f.title,year:f.year,shows:periodShows(f)}))};
}
function reset(){state.viewing='any';state.minPrediction=null;state.minProbability=null;state.includeUnscheduled=false;$('#include-unscheduled').checked=false;state.startedOnly=false;$('#started-only').checked=false;state.lastChanceOnly=false;$('#last-chance-only').checked=false;for(const key of ['directors','actors']){state[key]='';$('#'+key+'-input').value='';$('#'+key+'-options').hidden=true;$('#'+key+'-input').setAttribute('aria-expanded','false');}state.period='all';state.query='';$('#search').value='';state.genres.clear();state.from=1900;state.to=MAX_YEAR;state.maxRuntime=null;$('#year-from').value=1900;$('#year-to').value=MAX_YEAR;$('#runtime-max').value='';document.querySelectorAll('#genres input').forEach(i=>i.checked=false);render();}
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
 const from=input.from??state.from,to=input.to??state.to,maxRuntime=input.maxRuntime===undefined?state.maxRuntime:input.maxRuntime;
 if(!Number.isInteger(from)||!Number.isInteger(to)||from<1900||to>MAX_YEAR||from>to)throw new Error('Invalid year range');
 if(maxRuntime!==null&&(!Number.isInteger(maxRuntime)||maxRuntime<1))throw new Error('Invalid maximum runtime');
 state.includeUnscheduled=input.includeUnscheduled??state.includeUnscheduled;$('#include-unscheduled').checked=state.includeUnscheduled;
 state.lastChanceOnly=input.lastChanceOnly??state.lastChanceOnly;$('#last-chance-only').checked=state.lastChanceOnly;
 state.viewing=input.viewing??state.viewing;
 state.minPrediction=input.minPrediction===undefined?state.minPrediction:input.minPrediction;
 state.minProbability=input.minProbability===undefined?state.minProbability:input.minProbability;
 state.query=input.query??state.query;$('#search').value=state.query;
 state.period=input.period??state.period;state.genres=new Set(input.genres??state.genres);
 state.from=from;state.to=to;state.maxRuntime=maxRuntime;
 $('#year-from').value=from;$('#year-to').value=to;$('#runtime-max').value=maxRuntime??'';
 document.querySelectorAll('#genres input').forEach(i=>i.checked=state.genres.has(i.value));
 return render();
}
async function init(){
 try{$('#year-to').value=MAX_YEAR;$('#year-to').max=MAX_YEAR;$('#year-from').max=MAX_YEAR;$('#year-error').textContent=`Укажи годы от 1900 до ${MAX_YEAR}; «от» не должно быть больше «до».`;const response=await fetch('/api/programme');if(!response.ok)throw new Error('Программа ещё не готова. Попробуй открыть страницу немного позже.');report=await response.json();MAX_YEAR=Math.max(MAX_YEAR,...report.films.map(f=>Number(f.year)||0));state.to=MAX_YEAR;$('#year-to').value=MAX_YEAR;$('#year-to').max=MAX_YEAR;$('#year-from').max=MAX_YEAR;$('#year-error').textContent=`Укажи годы от 1900 до ${MAX_YEAR}; «от» не должно быть больше «до».`;({start:WINDOW_START,cutoff:CUTOFF,end:WINDOW_END}=programmeWindow(report));films=report.films.map(f=>({...f,genres:f.genres?.length?f.genres:['Жанр не указан'],shows:f.shows.map(s=>({...s,offset:(s.start-CUTOFF)/3600000}))}));genres=[...new Set(films.flatMap(f=>f.genres))].sort((a,b)=>a.localeCompare(b,'ru'));updateSourceInfo();initPeopleFilters();
 $('#genres').innerHTML=genres.map(g=>`<label class="genre-label"><input type="checkbox" value="${g}"><span>${g}</span><span class="genre-count">${films.filter(f=>f.genres.includes(g)).length}</span></label>`).join('');
 restoreUrl();urlReady=true;
 window.addEventListener('popstate',restoreUrl);
 $('#include-unscheduled').addEventListener('change',e=>{state.includeUnscheduled=e.target.checked;render();});
 $('#started-only').addEventListener('change',e=>{state.startedOnly=e.target.checked;render();});
 $('#last-chance-only').addEventListener('change',e=>{state.lastChanceOnly=e.target.checked;render();});
 document.querySelectorAll('[data-viewing]').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled){state.viewing=b.dataset.viewing;render();}}));
 document.querySelectorAll('[data-min-prediction]').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled){state.minPrediction=b.dataset.minPrediction==='any'?null:Number(b.dataset.minPrediction);render();}}));
 document.querySelectorAll('[data-min-probability]').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled){state.minProbability=b.dataset.minProbability==='any'?null:Number(b.dataset.minProbability);render();}}));
 $('#progress-retry').addEventListener('click',()=>loadStarted());
 $('#movies').addEventListener('click',e=>{const mark=e.target.closest('[data-started-id]');if(mark){toggleStarted(mark.dataset.startedId);return;}const b=e.target.closest('[data-credit-id]');if(b)selectPerson(b.dataset.creditKind,b.dataset.creditId);});
 $('#sort').addEventListener('change',e=>{state.sort=e.target.value;render();});
 $('#search').addEventListener('input',e=>{state.query=e.target.value;render();});
 $('#genres').addEventListener('change',e=>{const i=e.target;i.checked?state.genres.add(i.value):state.genres.delete(i.value);render();});
 document.querySelectorAll('[data-period]').forEach(b=>b.addEventListener('click',()=>{state.period=b.dataset.period;render();}));
 for(const [selector,key] of [['#year-from','from'],['#year-to','to']])$(selector).addEventListener('input',e=>{state[key]=e.target.value===''?NaN:Number(e.target.value);render();});
 document.querySelectorAll('[data-year-from]').forEach(b=>b.addEventListener('click',()=>applyFilters({from:Number(b.dataset.yearFrom),to:b.dataset.yearTo==='current'?MAX_YEAR:Number(b.dataset.yearTo)})));
 $('#runtime-max').addEventListener('input',e=>{state.maxRuntime=e.target.value===''?null:Number(e.target.value);render();});
 document.querySelectorAll('[data-runtime-max]').forEach(b=>b.addEventListener('click',()=>applyFilters({maxRuntime:b.dataset.runtimeMax==='any'?null:Number(b.dataset.runtimeMax)})));
 $('#filter-toggle').addEventListener('click',()=>{const b=$('#filter-toggle');const open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));$('#filters').dataset.open=String(open);});
 $('#reset').addEventListener('click',reset);$('#empty-reset').addEventListener('click',reset);render();loadStarted();loadEvents();loadEnrichment();loadPredictionQueue();$('#activity-more').addEventListener('click',()=>loadEvents(true));
 window.addEventListener('focus',()=>{if(!savingStarted.size)loadStarted();loadEvents();loadEnrichment();loadPredictionQueue();});
 setInterval(()=>{updateSourceInfo();render();loadEvents();},60000);
 if(document.modelContext?.registerTool){try{await document.modelContext.registerTool({name:'filter_watchlist_programme',title:'Фильтровать кинопрограмму',description:'Apply title search, genre, year, runtime, prediction, probability, last-chance and broadcast period filters to the visible watchlist programme. Multiple genres use OR; other filters use AND. Returns the films and broadcasts shown.',inputSchema:{type:'object',properties:{includeUnscheduled:{type:'boolean',description:'Include watchlist films with no broadcasts in the saved EPG window'},lastChanceOnly:{type:'boolean',description:'Only films with less than eight hours before their last known showing leaves the 72-hour archive window'},viewing:{type:'string',enum:['any','new','rewatch'],description:'Filter by absence or presence of a personal Letterboxd rating'},minPrediction:{type:['number','null'],enum:[null,3.5,4,4.5],description:'Minimum saved predicted rating; null removes the filter'},minProbability:{type:['number','null'],enum:[null,0.5,0.7,0.85],description:'Minimum saved probability of a 4.0+ rating; null removes the filter'},query:{type:'string',description:'Part of the Russian or original title, case insensitive'},period:{type:'string',enum:['all','archive','future']},genres:{type:'array',items:{type:'string',enum:genres}},from:{type:'integer',minimum:1900,maximum:MAX_YEAR},to:{type:'integer',minimum:1900,maximum:MAX_YEAR},maxRuntime:{type:['integer','null'],minimum:1,description:'Maximum film runtime in minutes; null removes the runtime filter'}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:applyFilters});}catch(e){console.info('Browser tools unavailable',e.message);}}
 }catch(e){$('#result-count').textContent='Программа временно недоступна';$('#source-note').textContent=e.message;$('#connection-badge').textContent='Ожидаем обновление';console.error(e);}
}
async function loadEnrichment(){try{const response=await fetch('/api/enrichment/view');if(!response.ok)throw new Error();const data=await response.json();if(!data||typeof data.films!=='object')throw new Error();enrichment=data;ratingsLoaded=true;$('#taste-version').textContent=data.profile?`Модель вкуса: v${data.profile.version} · обновлена ${new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short'}).format(new Date(data.profile.updatedAt))}`:'Модель вкуса: не настроена';render();}catch{if(!ratingsLoaded)render();}}
async function loadPredictionQueue(){try{const [response,discoveryResponse]=await Promise.all([fetch('/api/enrichment/queue/status'),fetch('/api/enrichment/discovery/status')]);if(!response.ok)throw new Error();const queue=await response.json(),discovery=discoveryResponse.ok?await discoveryResponse.json():null,label=$('#prediction-queue-status');if(queue.pendingCount===null){label.textContent='Прогнозы: очередь ещё не создана';return;}const remaining=queue.pendingCount||0,catchUp=(remaining||discovery?.pending)&&queue.nextCatchUpAt?` · следующий проход ${new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(queue.nextCatchUpAt))}`:'';label.textContent=remaining?`Прогнозы: осталось ${remaining}${catchUp}`:discovery?.pending?`Прогнозы: пополняем каталог EPG${catchUp}`:'Прогнозы: очередь пуста';if(discovery?.pending)label.textContent+=` · проверено ${discovery.checked.toLocaleString('ru')} из ${discovery.candidates.toLocaleString('ru')}, отсеяно серий/передач ${(discovery.statuses?.excluded_nonfilm||0).toLocaleString('ru')}, подтверждено фильмов ${discovery.verifiedFilms.toLocaleString('ru')}`;if(queue.lastBatch?.stage==='partial'&&queue.lastBatch.reason)label.textContent+=` · последний пакет прерван: ${queue.lastBatch.reason}`;}catch{$('#prediction-queue-status').textContent='Прогнозы: статус временно недоступен';}}
function updateCoverageDates(){
 const format=ms=>new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(ms));
 const range=(from,to)=>`<time datetime="${new Date(from).toISOString()}">${format(from)}</time><time datetime="${new Date(to).toISOString()}">${format(to)}</time>`;
 $('#archive-range').innerHTML=range(WINDOW_START,CUTOFF);
 $('#future-range').innerHTML=range(CUTOFF,WINDOW_END);
}
function updateSourceInfo(){
 const fmt=t=>new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(t));
 const age=Date.now()-Date.parse(report.updatedAt);$('#snapshot').innerHTML=`<span>Обновлено ${fmt(report.updatedAt)}</span><span class="muted">Время — Europe/Madrid</span>`;
 updateCoverageDates();
 $('#connection-badge').textContent=age>26*3600000?'Данные устарели':'Источники подключены';
 const details=[`${report.watchlistCount} фильмов в watchlist`, `EPG до ${fmt(report.stats.epgEnd)}`];if(report.stats.futureFullChannels<report.stats.channels)details.push('не все каналы дают полные сутки вперёд');if(report.stats.metadataMissing)details.push(`метаданные ${report.stats.metadataMissing} фильмов пока недоступны`);if(report.stats.titleMissing)details.push(`русское название не найдено: ${report.stats.titleMissing}`);if(report.stats.titleProvisional)details.push(`названия требуют проверки: ${report.stats.titleProvisional}`);if(age>26*3600000)details.push('последнее обновление старше суток');
 $('#source-note').textContent=details.join(' · ');$('#source-summary').textContent=`EPG Team · Letterboxd · ${report.stats.scanned.toLocaleString('ru')} передач проверено`;
}
function eventHTML(event){const date=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(event.at));const film=f=>`${escapeHTML(f.title)}${f.year?` (${escapeHTML(f.year)})`:''}`;let body='';
 if(event.type==='started'||event.type==='unstarted')body=`<p>${event.type==='started'?'Начал смотреть':'Снял отметку «Начал»'}: <strong>${film(event.film)}</strong></p>`;
 if(event.type==='epg')body=`<p>Обновлён EPG</p><dl><div><dt>Фильмов с показами</dt><dd>${event.films}</dd></div><div><dt>В архиве</dt><dd>${event.archive}</dd></div><div><dt>В следующие сутки</dt><dd>${event.future}</dd></div><div><dt>Всего показов</dt><dd>${event.broadcasts}</dd></div></dl>`;
 if(event.type==='watchlist'){body=`<p>Обновлён watchlist · ${event.total} ${filmWord(event.total)}</p>`;for(const [key,label] of [['removed','Удалены из watchlist'],['added','Добавлены фильмы']])if(event[key]?.length)body+=`<details open><summary>${label} · ${event[key].length}</summary><ul>${event[key].map(f=>`<li>${film(f)}</li>`).join('')}</ul></details>`;if(!event.added?.length&&!event.removed?.length)body+=`<p class="event-note">${event.baseline?'Исходный сохранённый список':'Состав без изменений'}</p>`;}
 if(event.type==='enrichment'){const added=event.added??event.created??0,updated=event.updated??event.recalculated??0,changed=added+updated;body=`<p>${event.failed||event.pending||event.remaining?'Прогнозы обновлены частично':changed?'Обновлены прогнозы':'Проверены прогнозы'}</p>${changed||event.failed||event.remaining?`<dl><div><dt>Новых прогнозов</dt><dd>${added}</dd></div><div><dt>Пересчитано</dt><dd>${updated}</dd></div>${event.failed?`<div><dt>Не удалось</dt><dd>${event.failed}</dd></div>`:''}${event.remaining?`<div><dt>Осталось в очереди</dt><dd>${event.remaining}</dd></div>`:''}</dl>`:'<p class="event-note">Изменений нет</p>'}${event.remaining&&event.nextCatchUpAt?`<p class="event-note">Следующий проход: ${new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(event.nextCatchUpAt))}</p>`:''}${event.reason?`<p class="event-note">Причина: ${escapeHTML(event.reason)}</p>`:''}`;}
 return `<li class="activity-event"><time datetime="${escapeHTML(event.at)}">${date}</time>${body}</li>`;}
async function loadEvents(more=false){if(eventLoading)return;eventLoading=true;const button=$('#activity-more');button.disabled=true;try{const response=await fetch('/api/events'+(more&&eventCursor?'?cursor='+encodeURIComponent(eventCursor):''));if(!response.ok)throw new Error();const data=await response.json();const keepCursor=!more&&loadedEvents.size>20;for(const event of data.events)loadedEvents.set(event.id,event);const scroll=document.querySelector('.activity-scroll'),position=scroll.scrollTop;$('#activity-list').innerHTML=[...loadedEvents.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id)).map(eventHTML).join('');scroll.scrollTop=position;if(!keepCursor)eventCursor=data.cursor;$('#activity-status').textContent=!more&&!data.events.length?'Здесь появятся события списка.':'';button.hidden=!eventCursor;button.textContent='Более давние события';}catch{$('#activity-status').textContent='Не удалось загрузить события.';button.hidden=false;button.textContent='Повторить';}finally{eventLoading=false;button.disabled=false;}}
function initPeopleFilters(){
 for(const key of ['directors','actors']){
  const root=document.querySelector(`[data-person="${key}"]`),input=$('#'+key+'-input'),list=$('#'+key+'-options');
  const people=(report.people?.[key]||[]).slice().sort((a,b)=>a.name.localeCompare(b.name,'ru',{sensitivity:'base'}));
  let matches=[],active=-1;
  const close=()=>{list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;};
  const open=()=>{const q=normalizeTitle(input.value);matches=people.filter(p=>!q||[p.name,p.original,...(p.aliases||[])].some(n=>normalizeTitle(n).includes(q)));active=-1;list.innerHTML=matches.length?matches.map((p,i)=>`<li role="option" id="${key}-option-${i}" data-index="${i}" aria-selected="${p.id===state[key]}">${escapeHTML(p.name)}${p.name!==p.original?`<small>${escapeHTML(p.original)}</small>`:''}</li>`).join(''):'<li class="no-options" role="presentation">Нет совпадений</li>';list.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');};
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
