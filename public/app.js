'use strict';
const CUTOFF = Date.parse('2026-10-02T17:00:00+02:00');
const state = { period: 'all', query: '', genres: new Set(), from: 1970, to: 2026 };
let films = [];
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const genres = ['Боевик','Триллер','Криминал','Фантастика','Ужасы','Приключения','Комедия'];
const isArchive = show => show.offset >= -72 && show.offset < 0;
const isFuture = show => show.offset >= 0 && show.offset < 24;
const normalizeTitle = text => text.toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function eligible(film) { const query = normalizeTitle(state.query); const titleMatch = !query || [film.title,film.original].some(t => normalizeTitle(t).includes(query)); return titleMatch && film.year >= state.from && film.year <= state.to && (!state.genres.size || film.genres.some(g => state.genres.has(g))); }
function periodShows(film,period=state.period) { return film.shows.filter(s => period==='archive'?isArchive(s):period==='future'?isFuture(s):isArchive(s)||isFuture(s)); }
function filmWord(n){return n%10===1&&n%100!==11?'фильм':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'фильма':'фильмов';}
function showWord(n){return n%10===1&&n%100!==11?'показ':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'показа':'показов';}
function dateLabel(offset){ const date = new Date(CUTOFF+offset*3600000);const day=Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Madrid',day:'numeric'}).format(date));return day===2?'Сегодня':day===3?'Завтра':day===1?'Вчера':`${day} сент.`; }
function row(show) { const date=new Date(CUTOFF+show.offset*3600000);const time=new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'}).format(date);return `<div class="show-row"><span class="channel">${escapeHTML(show.channel)}</span><time class="show-time" datetime="${date.toISOString()}">${dateLabel(show.offset)}<b>${time}</b></time></div>`; }
function group(film,type){const shows=film.shows.filter(type==='archive'?isArchive:isFuture).sort((a,b)=>type==='archive'?b.offset-a.offset:a.offset-b.offset);if(!shows.length)return '';return `<section class="show-group ${type}"><div class="group-title"><span>${type==='archive'?'АРХИВ · 3 ДНЯ':'СЛЕДУЮЩИЕ СУТКИ'}</span><span class="show-count">${shows.length} ${showWord(shows.length)}</span></div>${row(shows[0])}${shows.length>1?`<details class="more"><summary>Ещё ${shows.length-1} ${showWord(shows.length-1)}</summary>${shows.slice(1).map(row).join('')}</details>`:''}</section>`;}
function card(film){return `<article class="movie-card" data-film-id="${film.id}" aria-label="${escapeHTML(film.title)}"><div class="film-head"><img class="poster" src="${escapeHTML(film.poster)}" alt="Постер ${escapeHTML(film.original)}" width="78" height="117" loading="lazy" referrerpolicy="no-referrer"><div class="film-info"><h3>${escapeHTML(film.title)}</h3><p class="original">${escapeHTML(film.original)}</p><span class="film-year">${film.year}</span><div class="film-tags">${film.genres.map(escapeHTML).join(' · ')}</div></div></div><div class="screenings">${state.period!=='future'?group(film,'archive'):''}${state.period!=='archive'?group(film,'future'):''}</div>${state.period==='all'&&!film.shows.some(isFuture)?'<p class="archive-only">В следующие сутки показов нет</p>':''}</article>`;}
function visibleFilms(){return films.filter(eligible).filter(f=>periodShows(f).length).sort((a,b)=>state.period==='archive'?Math.max(...b.shows.filter(isArchive).map(s=>s.offset))-Math.max(...a.shows.filter(isArchive).map(s=>s.offset)):Math.min(...a.shows.filter(isFuture).map(s=>s.offset),Infinity)-Math.min(...b.shows.filter(isFuture).map(s=>s.offset),Infinity)||a.title.localeCompare(b.title,'ru'));}
function render(){
  const valid = Number.isInteger(state.from)&&Number.isInteger(state.to)&&state.from>=1900&&state.to<=2026&&state.from<=state.to;
  $('#year-error').hidden=valid;
  $('#filter-summary').textContent = state.genres.size || state.from!==1970 || state.to!==2026 ? `${state.genres.size ? [...state.genres].join(', ') : 'Все жанры'} · ${state.from}–${state.to}` : 'Все фильмы';
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
function reset(){state.period='all';state.query='';$('#search').value='';state.genres.clear();state.from=1970;state.to=2026;$('#year-from').value=1970;$('#year-to').value=2026;document.querySelectorAll('#genres input').forEach(i=>i.checked=false);render();}
function applyFilters(input){if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Expected a filters object');if(input.query!==undefined&&typeof input.query!=='string')throw new Error('Invalid search query');if(input.period!==undefined&&!['all','archive','future'].includes(input.period))throw new Error('Invalid period');if(input.genres!==undefined&&(!Array.isArray(input.genres)||input.genres.some(g=>!genres.includes(g))))throw new Error('Invalid genre');const from=input.from??state.from,to=input.to??state.to;if(!Number.isInteger(from)||!Number.isInteger(to)||from<1900||to>2026||from>to)throw new Error('Invalid year range');state.query=input.query??state.query;$('#search').value=state.query;state.period=input.period??state.period;state.genres=new Set(input.genres??state.genres);state.from=from;state.to=to;$('#year-from').value=from;$('#year-to').value=to;document.querySelectorAll('#genres input').forEach(i=>i.checked=state.genres.has(i.value));return render();}
async function init(){
 try{const response=await fetch('data.json');if(!response.ok)throw new Error('Data unavailable');films=await response.json();
 $('#genres').innerHTML=genres.map(g=>`<label class="genre-label"><input type="checkbox" value="${g}"><span>${g}</span><span class="genre-count">${films.filter(f=>f.genres.includes(g)).length}</span></label>`).join('');
 $('#search').addEventListener('input',e=>{state.query=e.target.value;render();});
 $('#genres').addEventListener('change',e=>{const i=e.target;i.checked?state.genres.add(i.value):state.genres.delete(i.value);render();});
 document.querySelectorAll('[data-period]').forEach(b=>b.addEventListener('click',()=>{state.period=b.dataset.period;render();}));
 for(const [selector,key] of [['#year-from','from'],['#year-to','to']])$(selector).addEventListener('input',e=>{state[key]=e.target.value===''?NaN:Number(e.target.value);render();});
 $('#filter-toggle').addEventListener('click',()=>{const b=$('#filter-toggle');const open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));$('#filters').dataset.open=String(open);});
 $('#reset').addEventListener('click',reset);$('#empty-reset').addEventListener('click',reset);render();
 if(document.modelContext?.registerTool){try{await document.modelContext.registerTool({name:'filter_watchlist_programme',title:'Фильтровать кинопрограмму',description:'Apply Russian/original title search, genre, release year and broadcast period filters to the visible demo programme. Multiple genres use OR. Returns the films and broadcasts shown.',inputSchema:{type:'object',properties:{query:{type:'string',description:'Part of the Russian or original title, case insensitive'},period:{type:'string',enum:['all','archive','future']},genres:{type:'array',items:{type:'string',enum:genres}},from:{type:'integer',minimum:1900,maximum:2026},to:{type:'integer',minimum:1900,maximum:2026}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:applyFilters});}catch(e){console.info('Browser tools unavailable',e.message);}}
 }catch(e){$('#result-count').textContent='Не удалось загрузить демопрограмму. Обнови страницу.';console.error(e);}
}
init();
