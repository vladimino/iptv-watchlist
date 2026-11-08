// Admin pages mount the same status footer as the programme. The block from the run-status
// table through loadPredictionQueue is copied from public/app.js and kept identical; the
// programme script stays the one that also paints events. This file never calls the writing reads.
(() => {
const $ = selector => document.querySelector(selector);
function filmWord(n){return n%10===1&&n%100!==11?'фильм':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'фильма':'фильмов';}
function madridStamp(ms,options={day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}){return new Intl.DateTimeFormat('ru',{timeZone:'Europe/Madrid',...options}).format(new Date(ms));}
function madridDay(ms){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));}
let footerReady=false,footerLoading=false,footerReadAt=0;
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
const FOOTER_MARKUP = `<footer class="status-footer" aria-label="Состояние данных и прогнозов">
      <div class="footer-status">
        <div class="status-summary" role="status" aria-live="polite">
          <div class="status-row"><span>Коллекция</span><strong id="summary-collection">загрузка…</strong></div>
          <div class="status-row status-row-coverage"><span>Прогнозы</span><strong id="summary-forecast">загрузка…</strong></div>
          <div class="status-row"><span>Новые 4.0+</span><strong id="summary-new">загрузка…</strong></div>
          <div class="status-row"><span>EPG</span><strong id="summary-epg">загрузка…</strong></div>
          <div class="status-row"><span>Автоматизация</span><strong id="summary-automation">загрузка…</strong></div>
        </div>
        <p class="status-stale-note" id="status-stale-note" hidden></p>
        <div class="footer-bar">
        <details class="footer-details" id="status-details">
          <summary><span id="status-details-label">Показать детали</span></summary>
          <div class="footer-details-body">
            <section aria-labelledby="status-collection-title"><h3 id="status-collection-title">Моя коллекция</h3><p class="status-section-help">Счётчики пересекаются, а не складываются: один фильм может быть и в watchlist, и просмотренным, и оценённым.</p><dl>
              <div><dt title="Уникальные фильмы: watchlist, программа, каталог и фильмы с сохранёнными фактами. Один фильм считается один раз.">Всего фильмов</dt><dd id="detail-collection-total">—</dd></div>
              <div><dt title="Фильмы с подтверждённым фактом просмотра. Отсутствие в watchlist или Diary просмотром не считается.">Просмотрено</dt><dd id="detail-collection-watched">—</dd></div>
              <div><dt title="Фильмы с сохранённой оценкой.">Оценено</dt><dd id="detail-collection-rated">—</dd></div>
              <div><dt>В watchlist</dt><dd id="detail-collection-watchlist">—</dd></div>
            </dl></section>
            <section aria-labelledby="status-forecast-title"><h3 id="status-forecast-title">Рекомендации</h3><p class="status-section-help">Новые: фильмы каталога вне watchlist, которые ты не смотрел и не оценивал, с актуальным прогнозом, шансом 4+ не ниже 70% и неснижённой уверенностью.</p><dl>
              <div><dt title="Фильмы всей локальной базы с прогнозом, актуальным для текущей модели вкуса.">Прогнозы · вся база</dt><dd id="detail-forecast-local">—</dd></div>
              <div><dt title="Фильмы, которые идут в окне просмотра, с актуальным прогнозом.">Прогнозы · окно просмотра</dt><dd id="detail-forecast-window">—</dd></div>
              <div><dt>Новые · 4.5 и выше</dt><dd id="detail-new-45">—</dd></div>
              <div><dt>Новые · от 4.0 до 4.4</dt><dd id="detail-new-40">—</dd></div>
              <div><dt>Модель вкуса</dt><dd id="detail-taste">—</dd></div>
            </dl></section>
            <section aria-labelledby="status-programme-title"><h3 id="status-programme-title">Кинопрограмма</h3><p class="status-section-help">Распознанные фильмы и кандидаты считаются по-разному: кандидат — передача из EPG, которая ещё не опознана как фильм.</p><dl>
              <div><dt title="Последняя подтверждённая загрузка EPG, а не время открытия страницы.">Обновление EPG</dt><dd id="detail-epg-updated">—</dd></div>
              <div><dt title="Конец горизонта передач, известных на сейчас.">Известные передачи</dt><dd id="detail-epg-horizon">—</dd></div>
              <div><dt title="Уникальные фильмы TMDB, распознанные среди кандидатов текущего EPG.">Распознано фильмов</dt><dd id="detail-epg-recognized">—</dd></div>
              <div><dt title="Кандидаты текущего эфира, которым ещё нужно сопоставление. Это не фильмы.">Ждут распознавания</dt><dd id="detail-epg-pending">—</dd></div>
            </dl></section>
            <section aria-labelledby="status-integrations-title"><h3 id="status-integrations-title">Автоматизация</h3><p class="status-section-help" id="status-integrations-help">«Нет данных» не значит сбой, а ожидание повторной попытки не авария. Подробности: события и диагностика.</p><dl id="status-integration-list">
              <div data-integration="letterboxd_watchlist"><dt>Watchlist</dt><dd id="integration-watchlist">—</dd></div>
              <div data-integration="letterboxd_ratings"><dt>Оценки</dt><dd id="integration-ratings">—</dd></div>
              <div data-integration="epg"><dt>Загрузка EPG</dt><dd id="integration-epg">—</dd></div>
              <div data-integration="resolver"><dt>Распознавание</dt><dd id="integration-resolver">—</dd></div>
              <div data-integration="predictions"><dt>Прогнозы</dt><dd id="integration-predictions">—</dd></div>
              <div data-integration="metadata" hidden><dt>Метаданные</dt><dd id="integration-metadata">—</dd></div>
            </dl><a class="status-events-link" id="status-integrations-events" href="/events" data-return-carry>События</a><a class="status-events-link" id="status-health-link" href="/admin/health" data-return-carry>Диагностика</a></section>
          </div>
        </details>
        <a class="footer-admin-link" href="/admin" data-return-carry>Админка</a>
        </div>
      </div>
    </footer>`;
function mountStatusFooter(){
  const shell=document.querySelector('main.admin-shell');
  if(!shell||document.querySelector('.status-footer'))return;
  shell.insertAdjacentHTML('beforeend', FOOTER_MARKUP);
  if(typeof ReturnHome!=='undefined')ReturnHome.init();
  const statusDetails=$('#status-details');
  if(!statusDetails||statusDetails.dataset.footerBound)return;
  statusDetails.dataset.footerBound='1';
  statusDetails.addEventListener('toggle',()=>{$('#status-details-label').textContent=statusDetails.open?'Скрыть детали':'Показать детали';});
}
function refreshStatusFooter(){
  if(document.visibilityState==='hidden')return;
  loadPredictionQueue({quiet:true});
}
mountStatusFooter();
if(document.body?.classList.contains('admin-page')&&document.querySelector('.status-footer')){
  loadPredictionQueue();
  setInterval(refreshStatusFooter,60000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')loadPredictionQueue({quiet:true});});
}
})();
