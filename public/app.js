'use strict';
let CUTOFF = Date.now();
const MAX_YEAR = Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Madrid',year:'numeric'}).format(new Date()));
let report = null;
const state = { period: 'all', query: '', genres: new Set(), from: 1900, to: MAX_YEAR };
let films = [];
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let genres = ['Боевик','Триллер','Криминал','Фантастика','Ужасы','Приключения','Комедия'];
const isArchive = show => show.offset >= -72 && show.offset < 0;
const isFuture = show => show.offset >= 0 && show.offset < 24;
const normalizeTitle = text => text.toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function eligible(film) { const query = normalizeTitle(state.query); const titleMatch = !query || [film.title,film.original,...(film.aliases||[])].some(t => normalizeTitle(t).includes(query)); return titleMatch && film.year >= state.from && film.year <= state.to && (!state.genres.size || film.genres.some(g => state.genres.has(g))); }
function periodShows(film,period=state.period) { return film.shows.filter(s => period==='archive'?isArchive(s):period==='future'?isFuture(s):isArchive(s)||isFuture(s)); }
function filmWord(n){return n%10===1&&n%100!==11?'фильм':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'фильма':'фильмов';}
function showWord(n){return n%10===1&&n%100!==11?'показ':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'показа':'показов';}
function dateLabel(offset){ const date = new Date(CUTOFF+offset*3600000);const key=d=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);const today=key(new Date(CUTOFF));const target=key(date);return target===today?'Сегодня':target===key(new Date(CUTOFF+86400000))?'Завтра':target===key(new Date(CUTOFF-86400000))?'Вчера':new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short'}).format(date); }

function row(show) { const date=new Date(CUTOFF+show.offset*3600000);const time=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'}).format(date);return `<div class="show-row"><span class="channel">${escapeHTML(show.channel)}${show.basis==='title_duration'?'<span class="match-hint" title="В EPG нет года: совпали название и длительность. Возможна другая версия фильма." aria-label="Предположительное совпадение по названию и длительности"> ≈</span>':''}</span><time class="show-time" datetime="${date.toISOString()}">${dateLabel(show.offset)}<b>${time}</b></time></div>`; }
function group(film,type){const shows=film.shows.filter(type==='archive'?isArchive:isFuture).sort((a,b)=>type==='archive'?b.offset-a.offset:a.offset-b.offset);if(!shows.length)return '';return `<section class="show-group ${type}"><div class="group-title"><span>${type==='archive'?'АРХИВ · 3 ДНЯ':'СЛЕДУЮЩИЕ СУТКИ'}</span><span class="show-count">${shows.length} ${showWord(shows.length)}</span></div>${row(shows[0])}${shows.length>1?`<details class="more"><summary>Ещё ${shows.length-1} ${showWord(shows.length-1)}</summary>${shows.slice(1).map(row).join('')}</details>`:''}</section>`;}
function card(film){return `<article class="movie-card" data-film-id="${film.id}" aria-label="${escapeHTML(film.title)}"><div class="film-head">${film.poster?`<img class="poster" src="${escapeHTML(film.poster)}" alt="Постер ${escapeHTML(film.original)}" width="78" height="117" loading="lazy" referrerpolicy="no-referrer">`:`<div class="poster no-poster" aria-label="Постер недоступен">${film.year||"Кино"}</div>`}<div class="film-info"><h3>${escapeHTML(film.title)}</h3><p class="original">${escapeHTML(film.original)}</p><span class="film-year">${film.year}</span><div class="film-tags">${film.genres.map(escapeHTML).join(' · ')}</div></div></div><div class="screenings">${state.period!=='future'?group(film,'archive'):''}${state.period!=='archive'?group(film,'future'):''}</div>${state.period==='all'&&!film.shows.some(isFuture)?'<p class="archive-only">В следующие сутки показов нет</p>':''}</article>`;}
function visibleFilms(){return films.filter(eligible).filter(f=>periodShows(f).length).sort((a,b)=>state.period==='archive'?Math.max(...b.shows.filter(isArchive).map(s=>s.offset))-Math.max(...a.shows.filter(isArchive).map(s=>s.offset)):Math.min(...a.shows.filter(isFuture).map(s=>s.offset),Infinity)-Math.min(...b.shows.filter(isFuture).map(s=>s.offset),Infinity)||a.title.localeCompare(b.title,'ru'));}
function render(){
  const valid = Number.isInteger(state.from)&&Number.isInteger(state.to)&&state.from>=1900&&state.to<=MAX_YEAR&&state.from<=state.to;
  $('#year-error').hidden=valid;
  document.querySelectorAll('[data-year-from]').forEach(b=>b.setAttribute('aria-pressed',String(valid&&state.from===Number(b.dataset.yearFrom)&&state.to===(b.dataset.yearTo==='current'?MAX_YEAR:Number(b.dataset.yearTo)))));
  $('#filter-summary').textContent = state.genres.size || state.from!==1900 || state.to!==MAX_YEAR ? `${state.genres.size ? [...state.genres].join(', ') : 'Все жанры'} · ${state.from}–${state.to}` : 'Все фильмы';
  ['#year-from','#year-to'].forEach(s=>$(s).setAttribute('aria-invalid',String(!valid)));
  const filtered=valid?films.filter(eligible):[];
  for(const p of ['all','archive','future'])$(`#count-${p}`).textContent=filtered.filter(f=>periodShows(f,p).length).length;
  document.querySelectorAll('[data-period]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.period===state.period)));
  const visible=valid?visibleFilms():[];
  $('#movies').innerHTML=visible.map(card).join('');
  $('#empty').hidden=visible.length>0||!valid;
  const shows=visible.reduce((n,f)=>n+periodShows(f).length,0);
  $('#result-count').textContent=valid?`${visible.length} ${filmWord(visible.length)} · ${shows} ${showWord(shows)}`:'Проверь диапазон лет';
  $('#sort-label').textContent=state.period==='archive'?'Свежие показы — сначала':'Ближайшие эфиры — сначала';
  return {period:state.period,query:state.query,genres:[...state.genres],years:[state.from,state.to],films:visible.map(f=>({id:f.id,title:f.title,year:f.year,shows:periodShows(f)}))};
}
function reset(){state.period='all';state.query='';$('#search').value='';state.genres.clear();state.from=1900;state.to=MAX_YEAR;$('#year-from').value=1900;$('#year-to').value=MAX_YEAR;document.querySelectorAll('#genres input').forEach(i=>i.checked=false);render();}
function applyFilters(input){if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Expected a filters object');if(input.query!==undefined&&typeof input.query!=='string')throw new Error('Invalid search query');if(input.period!==undefined&&!['all','archive','future'].includes(input.period))throw new Error('Invalid period');if(input.genres!==undefined&&(!Array.isArray(input.genres)||input.genres.some(g=>!genres.includes(g))))throw new Error('Invalid genre');const from=input.from??state.from,to=input.to??state.to;if(!Number.isInteger(from)||!Number.isInteger(to)||from<1900||to>MAX_YEAR||from>to)throw new Error('Invalid year range');state.query=input.query??state.query;$('#search').value=state.query;state.period=input.period??state.period;state.genres=new Set(input.genres??state.genres);state.from=from;state.to=to;$('#year-from').value=from;$('#year-to').value=to;document.querySelectorAll('#genres input').forEach(i=>i.checked=state.genres.has(i.value));return render();}
async function init(){
 try{$('#year-to').value=MAX_YEAR;$('#year-to').max=MAX_YEAR;$('#year-from').max=MAX_YEAR;$('#year-error').textContent=`Укажи годы от 1900 до ${MAX_YEAR}; «от» не должно быть больше «до».`;const response=await fetch('/api/programme');if(!response.ok)throw new Error('Программа ещё не готова. Попробуй открыть страницу немного позже.');report=await response.json();CUTOFF=Date.now();films=report.films.map(f=>({...f,genres:f.genres?.length?f.genres:['Жанр не указан'],shows:f.shows.map(s=>({...s,offset:(s.start-CUTOFF)/3600000}))}));genres=[...new Set(films.flatMap(f=>f.genres))].sort((a,b)=>a.localeCompare(b,'ru'));updateSourceInfo();
 $('#genres').innerHTML=genres.map(g=>`<label class="genre-label"><input type="checkbox" value="${g}"><span>${g}</span><span class="genre-count">${films.filter(f=>f.genres.includes(g)).length}</span></label>`).join('');
 $('#search').addEventListener('input',e=>{state.query=e.target.value;render();});
 $('#genres').addEventListener('change',e=>{const i=e.target;i.checked?state.genres.add(i.value):state.genres.delete(i.value);render();});
 document.querySelectorAll('[data-period]').forEach(b=>b.addEventListener('click',()=>{state.period=b.dataset.period;render();}));
 for(const [selector,key] of [['#year-from','from'],['#year-to','to']])$(selector).addEventListener('input',e=>{state[key]=e.target.value===''?NaN:Number(e.target.value);render();});
 document.querySelectorAll('[data-year-from]').forEach(b=>b.addEventListener('click',()=>applyFilters({from:Number(b.dataset.yearFrom),to:b.dataset.yearTo==='current'?MAX_YEAR:Number(b.dataset.yearTo)})));
 $('#filter-toggle').addEventListener('click',()=>{const b=$('#filter-toggle');const open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));$('#filters').dataset.open=String(open);});
 $('#reset').addEventListener('click',reset);$('#empty-reset').addEventListener('click',reset);render();
 setInterval(()=>{CUTOFF=Date.now();films.forEach(f=>f.shows.forEach(s=>s.offset=(s.start-CUTOFF)/3600000));updateSourceInfo();render();},60000);
 if(document.modelContext?.registerTool){try{await document.modelContext.registerTool({name:'filter_watchlist_programme',title:'Фильтровать кинопрограмму',description:'Apply Russian/original title search, genre, release year and broadcast period filters to the visible watchlist programme. Multiple genres use OR. Returns the films and broadcasts shown.',inputSchema:{type:'object',properties:{query:{type:'string',description:'Part of the Russian or original title, case insensitive'},period:{type:'string',enum:['all','archive','future']},genres:{type:'array',items:{type:'string',enum:genres}},from:{type:'integer',minimum:1900,maximum:MAX_YEAR},to:{type:'integer',minimum:1900,maximum:MAX_YEAR}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:applyFilters});}catch(e){console.info('Browser tools unavailable',e.message);}}
 }catch(e){$('#result-count').textContent='Программа временно недоступна';$('#source-note').textContent=e.message;$('#connection-badge').textContent='Ожидаем обновление';console.error(e);}
}
function updateSourceInfo(){
 const fmt=t=>new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(t));
 const age=Date.now()-Date.parse(report.updatedAt);$('#snapshot').innerHTML=`<span>Обновлено ${fmt(report.updatedAt)}</span><span class="muted">Время — Europe/Madrid</span>`;
 $('#connection-badge').textContent=age>26*3600000?'Данные устарели':'Источники подключены';
 const details=[`${report.watchlistCount} фильмов в watchlist`, `EPG до ${fmt(report.stats.epgEnd)}`];if(report.stats.futureFullChannels<report.stats.channels)details.push('не все каналы дают полные сутки вперёд');if(report.stats.metadataMissing)details.push(`метаданные ${report.stats.metadataMissing} фильмов пока недоступны`);if(age>26*3600000)details.push('последнее обновление старше суток');
 $('#source-note').textContent=details.join(' · ');$('#source-summary').textContent=`EPG Team · Letterboxd · ${report.stats.scanned.toLocaleString('ru')} передач проверено`;
}
init();
