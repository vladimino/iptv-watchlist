// Pure view of the identity work inventory: strings in, HTML strings out, no DOM, no clock, no request. Every value from the answer is
// escaped. Wording rule: the Letterboxd candidate lane is never called complete or empty; counts are labelled as a registry estimate
// and only the page's own document is called verified. A trusted Film link is shown only when the row carries `film`.
const IW_LANE_LABELS={film:'Фильм каталога',epg_observation:'Наблюдение EPG',watchlist_admission:'Новый фильм Watchlist',diary_identity:'Проверка id Letterboxd',letterboxd_rated_candidate:'Кандидат Letterboxd'};
const IW_LANE_TITLES={film:'Фильмы каталога без прогресса',epg_observation:'Наблюдения EPG без фильма',watchlist_admission:'Новые фильмы Watchlist без подтверждённого фильма',diary_identity:'Проверки id Letterboxd (Diary и Watchlist) и очередь ожидания',letterboxd_rated_candidate:'Кандидаты Letterboxd (рейтинг без фильма)'};
const IW_DISPOSITION_LABELS={retryable:'Можно повторить',blocked:'Заблокировано',needs_owner_review:'Нужен разбор владельца',waiting:'Ожидает',resolved:'Решено'};
const IW_DISPOSITION_TONES={retryable:'provisional',blocked:'conflict',needs_owner_review:'conflict',waiting:'ambiguous',resolved:'verified'};
const IW_STATUS_LABELS={entry:'запись проверки',backlog:'в очереди ожидания',pending:'ожидает проверки',admitting:'идёт admission',needs_review:'нужна проверка',verified:'проверен',removed:'снят',retry_eligible:'можно повторить',stalled:'застряло',backoff:'ждёт по backoff',manual_review:'нужен ручной разбор',stale_projection:'устаревшая проекция',external_archive:'нужен внешний архив',unknown:'неизвестно'};
const IW_REASON_TEXT={diary_cap:'таблица проверок заполнена: id ждёт места в очереди',entry_changed:'запись изменилась во время проверки: попытка не списана',owner_requeued:'возвращено владельцем',owner_dismissed:'закрыто владельцем',not_found:'страница не найдена (404)',admission_unconfirmed:'в D1 нет admission, совпадающего и по архиву, и по короткому коду',admission_unreadable:'admission в D1 прочитать не удалось: итог неизвестен',same_title_year:'то же название и год, что у другого фильма',tmdb_unavailable:'остановка: TMDB недоступен',tmdb_fetch_failed:'не удалось получить страницу фильма'};
const IW_PAGE_TEXT={read_whole:'документ архива прочитан целиком',registry_stale:'документ изменился после записи реестра: счётчики реестра устарели',oversized:'документ архива больше 2 МиБ: строки не показаны',unreadable:'документ архива не удалось прочитать: строки не показаны',absent:'документа кандидатов у архива нет',not_read:'в этом ответе документ архива не читался'};
const IW_ENUMERATION_TEXT={listing_truncated:'листинг префиксов обрезан на 1000',unindexed_archives:'есть архивы, которых нет в реестре',registry_orphans:'в реестре есть архивы, которых нет в хранилище',listing_unavailable:'листинг префиксов не прочитан',registry_unreadable:'реестр не читается',registry_invalid:'реестр неизвестного формата',registry_oversized:'реестр больше допустимого'};
const IW_ERROR_TEXT={unknown_type:'Неизвестный тип.',unknown_disposition:'Неизвестное состояние.',invalid_query:'Запрос поиска не подходит.',invalid_limit:'Недопустимый размер страницы.',storage_unavailable:'Хранилище сейчас недоступно.',network:'Запрос не дошёл до сервера.',method_not_allowed:'Метод не разрешён.',stale_pin:'Данные изменились после первой страницы.',stale_cursor:'Страница больше не соответствует документу.'};

function iwEscape(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function iwErrorText(code){return IW_ERROR_TEXT[code]||'Не удалось прочитать очередь ('+iwEscape(code||'ошибка')+').';}
function iwShort(sha){return typeof sha==='string'&&sha.length>=12?sha.slice(0,8)+'…'+sha.slice(-4):String(sha??'');}
function iwDate(iso){
 const at=typeof iso==='string'?Date.parse(iso):NaN;
 if(!Number.isFinite(at))return null;
 return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Madrid',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}).format(new Date(at))+' (Madrid)';
}
function iwAge(ms){
 if(typeof ms!=='number'||!Number.isFinite(ms))return 'возраст неизвестен';
 const days=Math.floor(ms/86400000);
 if(days>=1)return days+' дн. в этом состоянии';
 const hours=Math.floor(ms/3600000);
 return hours>=1?hours+' ч в этом состоянии':'меньше часа';
}
function iwBadge(tone,text){return '<span class="admin-status admin-status-'+tone+'">'+iwEscape(text)+'</span>';}

// One row. `title` falls back to the short code or the key so a row never shows an empty heading.
const IW_CLASS_TEXT={transport:'временная ошибка источника (попытка не списана)',not_now:'не сейчас (попытка не списана)',gone:'страница не найдена (404)',definite:'источник ответил, но не подтвердил',settled:'решено',intent:'связывание в процессе',needs_owner_review:'нужно решение владельца'};
function iwRowHtml(row){
 const title=row.title||row.shortCode||row.key;
 const meta=[Number.isInteger(row.year)?String(row.year):null,row.shortCode&&row.title?'код '+row.shortCode:null].filter(Boolean).join(' · ');
 const reason=row.reason?(IW_REASON_TEXT[row.reason]||row.reason):null;
 const lines=[];
 lines.push('<p class="iw-state">'+iwBadge(IW_DISPOSITION_TONES[row.disposition]||'ambiguous',IW_DISPOSITION_LABELS[row.disposition]||row.disposition)+' <span class="iw-status">статус источника: '+iwEscape(IW_STATUS_LABELS[row.status]||row.status||'нет')+'</span></p>');
 if(reason)lines.push('<p class="iw-reason"><b>Причина.</b> '+iwEscape(reason)+(IW_REASON_TEXT[row.reason]?' <code>'+iwEscape(row.reason)+'</code>':'')+'</p>');
 const provenance=(row.provenance||[]).map(item=>iwEscape(item.source==='letterboxd_archive'?'архив '+iwShort(item.ref):item.source==='archive_chunk'?'часть '+item.ref:item.ref));
 lines.push('<p class="iw-meta muted">'+[iwAge(row.ageMs),provenance.length?'источник: '+provenance.join(', '):null,iwDate(row.lastProgressAt)?'последний сдвиг: '+iwEscape(iwDate(row.lastProgressAt)):null].filter(Boolean).join(' · ')+'</p>');
 if(row.film&&row.film.filmId){
  const proof=row.film.proof==='film_rated_admission'?'подтверждено admission в D1 по архиву и коду':'канонический фильм';
  lines.push('<p class="iw-film"><b>Фильм.</b> <a class="limbo-link" href="/admin?kind=film&amp;id='+encodeURIComponent(row.film.filmId)+'">'+iwEscape(row.film.filmId)+'</a> <span class="muted">('+proof+')</span></p>');
 const groupId=row.film&&typeof row.film.filmId==='string'?/^tmdb_([1-9]\d{0,11})$/.exec(row.film.filmId):null;
 if(groupId)lines.push('<p class="iw-group"><a class="limbo-link" href="/admin/identity/group?tmdbId='+groupId[1]+'">Подобрать группу наблюдений EPG для этого фильма</a> <span class="muted">(откроется отдельная страница, ничего не записывается)</span></p>');
 }else if(row.type==='letterboxd_rated_candidate'||row.type==='epg_observation')lines.push('<p class="iw-film muted">Фильм не подтверждён: ссылка на каталог не показывается без доказательства.</p>');
 // AIR-599: the retry state of the shared check (class, transport streak, attempts, next retry) on the ledger and Diary rows.
 if(row.type==='watchlist_admission'||row.type==='diary_identity'){
  const src=row.source||{};
  const parts=[src.class?'класс: '+(IW_CLASS_TEXT[src.class]||src.class):null,Number.isInteger(src.attempts)?'попыток: '+src.attempts:null,Number.isInteger(src.streak)&&src.streak>0?'транспортных сбоев подряд: '+src.streak:null,iwDate(src.nextRetryAt)?'следующая проверка: '+iwDate(src.nextRetryAt):null].filter(Boolean);
  if(parts.length)lines.push('<p class="iw-retry muted">'+iwEscape(parts.join(' · '))+'</p>');
 }
 const hints=(row.observedHints||[]).map(hint=>'<li>'+iwEscape(hint.kind==='same_short_code'?'тот же короткий код в другом архиве':'то же название и год')+': <code>'+iwEscape(hint.ref)+'</code></li>');
 if(hints.length)lines.push('<div class="iw-hints"><p class="muted">Возможные совпадения среди строк этого ответа. Не доказано, фильм не назначен:</p><ul>'+hints.join('')+'</ul></div>');
 return '<article class="admin-hit iw-row" data-iw-key="'+iwEscape(row.key)+'"><h4 class="iw-title">'+iwEscape(title)+(meta?' <span class="admin-hit-meta">'+iwEscape(meta)+'</span>':'')+'</h4>'+lines.join('')+'</article>';
}
// Consecutive rows of one lane share a heading. Lane order comes from the server and is not re-sorted.
function iwRowsHtml(rows){
 let html='',lane=null;
 for(const row of rows){
  if(row.type!==lane){if(lane!==null)html+='</section>';lane=row.type;html+='<section class="iw-lane" data-iw-lane="'+iwEscape(lane)+'" aria-label="'+iwEscape(IW_LANE_TITLES[lane]||lane)+'"><h3>'+iwEscape(IW_LANE_TITLES[lane]||lane)+'</h3>';}
  html+=iwRowHtml(row);
 }
 return html+(lane!==null?'</section>':'');
}
function iwLaneSummary(name,entry){
 if(!entry)return '';
 const label=name==='film'?'Фильмы':name==='watchlist_admission'?'Новые фильмы Watchlist':'Наблюдения EPG';
 if(name==='watchlist_admission'&&entry.state==='partial')return '<li><b>'+label+':</b> есть ещё страницы; нажмите «Показать ещё» (выборка идёт постранично и полностью, без потери строк)'+(Number.isInteger(entry.observed)?'; на этой странице '+entry.observed:'')+'.</li>';
 if(entry.state==='unavailable')return '<li><b>'+label+':</b> не прочитаны ('+iwEscape(entry.reason||'недоступно')+'). Это не значит, что их нет.</li>';
 return '<li><b>'+label+':</b> '+(entry.state==='partial'?'частичное покрытие: источник перечисляет только записи, которые он уже знает':iwEscape(entry.state))+(Number.isInteger(entry.observed)?'; прочитано '+entry.observed:'')+'.</li>';
}
function iwCandidateSummary(entry){
 if(!entry)return '';
 const lines=[];
 const e=entry.enumeration||{};
 const detail=[Number.isInteger(e.registered)?'в реестре '+e.registered:null,Number.isInteger(e.listed)?'в хранилище '+e.listed:null,e.unindexed?'не в реестре '+e.unindexed:null,e.registryOrphans?'в реестре без архива '+e.registryOrphans:null].filter(Boolean).join(', ');
 lines.push('<li><b>Перечисление архивов:</b> '+(e.state==='complete'?'полное (проверено только наличие префиксов)':e.state==='partial'?'частичное: '+iwEscape(IW_ENUMERATION_TEXT[e.reason]||e.reason||''):'не определено ('+iwEscape(IW_ENUMERATION_TEXT[e.reason]||e.reason||'')+')')+(detail?'; '+iwEscape(detail):'')+'.</li>');
 const c=entry.counts||{};
 const unindexed=Number.isInteger(e.unindexed)&&e.unindexed>0?e.unindexed:0;
 if(c.state==='estimate'&&c.byStatus){
  const by=c.byStatus;
  // The registry only knows the archives it summarized: the counts say nothing about the others.
  const scope=Number.isInteger(e.registered)?' только по архивам, которые есть в реестре ('+e.registered+')':' только по архивам, которые есть в реестре';
  const outside=unindexed?' Архивы вне реестра ('+unindexed+') в эти счётчики не входят, их содержимое неизвестно.':e.state==='complete'?'':' Перечисление архивов частичное: могут быть архивы, о которых счётчики ничего не говорят.';
  lines.push('<li><b>Счётчики — оценка по реестру'+(iwDate(c.summarizedAt)?' на '+iwEscape(iwDate(c.summarizedAt)):'')+', не проверены,'+iwEscape(scope)+':</b> ожидают '+by.pending+', admission '+by.admitting+', нужна проверка '+by.needs_review+', проверено '+by.verified+', снято '+by.removed+'.'+iwEscape(outside)+'</li>');
 }else if(c.state==='absent'){
  lines.push('<li><b>Счётчики:</b> реестр архивов ещё не создан, оценки нет. Нули здесь не показываются: ни один архив не просуммирован'+(unindexed?'; архивов в хранилище, не вошедших в реестр: '+unindexed:'')+'.</li>');
 }else lines.push('<li><b>Счётчики:</b> реестр недоступен ('+iwEscape(c.state||'нет данных')+'), оценки нет.</li>');
 const p=entry.page||{};
 const pageText=IW_PAGE_TEXT[p.state]||p.state||'';
 lines.push('<li><b>Страница'+(p.archiveSha256?' (архив '+iwEscape(iwShort(p.archiveSha256))+(p.indexed===false?', не в реестре':'')+')':'')+':</b> '+iwEscape(pageText)+'. Снимок — по каждому архиву отдельно, не один на всё.</li>');
 if(entry.selected)lines.push('<li><b>Выбран один архив '+iwEscape(iwShort(entry.selected))+'.</b> Это не покрытие всех архивов.</li>');
 return lines.join('');
}
function iwDiarySummary(entry){
 if(!entry)return '';
 if(entry.state==='unavailable')return '<li><b>Проверки id Letterboxd:</b> не прочитаны ('+iwEscape(entry.reason||'недоступно')+'). Это не значит, что их нет.</li>';
 return '<li><b>Проверки id Letterboxd:</b> записей '+iwEscape(String(entry.entries))+' из '+iwEscape(String(entry.cap))+', в очереди ожидания '+iwEscape(String(entry.backlog))+' из '+iwEscape(String(entry.backlogCap))+'.</li>';
}
function iwCoverageHtml(coverage){
 const parts=[iwLaneSummary('film',coverage?.film),iwLaneSummary('epg_observation',coverage?.epg_observation),iwLaneSummary('watchlist_admission',coverage?.watchlist_admission),iwDiarySummary(coverage?.diary_identity),iwCandidateSummary(coverage?.letterboxd_rated_candidate)].join('');
 return parts?'<ul class="iw-coverage-list">'+parts+'</ul>':'<p class="muted">Покрытие не прочитано.</p>';
}
// One honest sentence over the loaded rows. It never says there is no work.
function iwVerdict(view){
 if(view.mode==='error')return 'Очередь не прочитана.';
 const count=view.rows.length;
 const lane=view.coverage?.letterboxd_rated_candidate;
 const partial=lane&&(lane.enumeration?.state!=='complete'||lane.page?.state==='registry_stale'||['oversized','unreadable'].includes(lane.page?.state));
 const more=view.nextCursor?' Есть следующая страница.':'';
 return 'Показано записей: '+count+'.'+more+(partial?' Покрытие частичное, подробности ниже.':'');
}
function iwEmptyText(view){
 const lane=view.coverage?.letterboxd_rated_candidate;
 const unread=['film','epg_observation','watchlist_admission','diary_identity'].filter(name=>view.coverage?.[name]?.state==='unavailable');
 const notes=[];
 if(view.nextCursor)notes.push('В этой странице строк нет, но очередь не закончилась: нажмите «Показать ещё».');
 else notes.push('В прочитанной части записей, подходящих под фильтр, нет.');
 if(lane&&lane.enumeration?.state!=='complete')notes.push('Перечисление архивов частичное, поэтому это не означает, что работы нет.');
 if(unread.length)notes.push('Часть источников не прочитана, пустота не доказана.');
 return notes.join(' ');
}
