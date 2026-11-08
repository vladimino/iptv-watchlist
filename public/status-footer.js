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
 return {profile:profile?`v${profile.version} · обновлена ${date(profile.updatedAt,{day:'numeric',month:'short'})}`:'не настроена',local,windowCoverage,runLabel:active?'Текущий run':'Последний run',runHeading:active?'Текущий запуск':'Последний запуск',runLine,nextLine:`Следующий запуск по расписанию: ${next==='—'?'—':`около ${next}`}`,localDetail:local,windowDetail:windowCoverage,pendingHot:n(p.pendingHot),pendingCold:n(p.pendingCold),cacheOffWindow:n(c.cacheOffWindowTotal),pendingOffWindow:n(p.pendingOffWindow),deferred:deferredLine,currentBatch:p.currentBatch?.size?`${n(p.currentBatch.size)} фильмов`:'нет активного',nextBatch:p.nextBatchSize&&!(Number.isInteger(p.eligibleNow)&&p.eligibleNow===0)?`до ${n(p.nextBatchSize)} ${p.nextBatchSize%10===1&&p.nextBatchSize%100!==11?'фильма':'фильмов'}`:outcome?.state==='drained'?'очередь пуста':outcome?.state==='deferred'?'ждёт повторной попытки':outcome&&outcome.state!=='unknown'?'нет готовых фильмов':'нет данных',epgRecognized:n(epg.recognizedFilms),epgPending:n(epg.pendingRecognition),epgHistory:n(epg.historicalUnresolved),epgConfirmed:n(epg.confirmedMovies),epgCache:n(epg.cacheOffWindow),epgCoverage:epg.epgStart||epg.epgEnd?`${date(epg.epgStart,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} — ${date(epg.epgEnd,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`:'—',epgChannels:n(epg.channels),epgChecked:n(epg.checkedTransmissions),watchlistFilms:n(watchlist.films),watchlistUpdated:date(watchlist.updatedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}),watchlistMetadata:n(watchlist.metadataMissing),watchlistTitles:n((watchlist.titleMissing||0)+(watchlist.titleProvisional||0)),runStarted:date(run?.startedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}),runAdded:n(run?.added),runFailed:n(run?.failed),runResult:`${runStatus}${runReason?` · ${runReason}`:''}`,nextRun:nextDetail==='—'?'—':`около ${nextDetail}`,profileVersion:profile?`v${profile.version}`:'—',profileUpdated:date(profile?.updatedAt,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}),integrationAggregate,integrations:{letterboxd_watchlist:integrationLine(byId.letterboxd_watchlist),letterboxd_ratings:integrationLine(byId.letterboxd_ratings),epg:integrationLine(byId.epg),resolver:integrationLine(byId.resolver),predictions:integrationLine(byId.predictions),metadata:byId.metadata?integrationLine(byId.metadata):''}};
}
function renderFooterStatus(data){const text=footerStatusText(data),values={
 'taste-version':text.profile,'status-local-coverage':text.local,'status-window-coverage':text.windowCoverage,'status-run-label':text.runLabel,'status-last-run':text.runLine,'status-next-run':text.nextLine,'status-run-title':text.runHeading,
 'detail-local-coverage':text.localDetail,'detail-window-coverage':text.windowDetail,'detail-pending-hot':text.pendingHot,'detail-pending-cold':text.pendingCold,'detail-cache-off-window':text.cacheOffWindow,'detail-pending-off-window':text.pendingOffWindow,'detail-deferred':text.deferred,'detail-current-batch':text.currentBatch,'detail-next-batch':text.nextBatch,
 'detail-epg-recognized':text.epgRecognized,'detail-epg-pending':text.epgPending,'detail-epg-history':text.epgHistory,'detail-epg-confirmed':text.epgConfirmed,'detail-epg-cache':text.epgCache,'detail-epg-coverage':text.epgCoverage,'detail-epg-channels':text.epgChannels,'detail-epg-checked':text.epgChecked,
 'detail-watchlist-films':text.watchlistFilms,'detail-watchlist-updated':text.watchlistUpdated,'detail-watchlist-metadata':text.watchlistMetadata,'detail-watchlist-titles':text.watchlistTitles,
 'detail-run-started':text.runStarted,'detail-run-added':text.runAdded,'detail-run-failed':text.runFailed,'detail-run-reason':text.runResult,'detail-run-next':text.nextRun,'detail-profile-version':text.profileVersion,'detail-profile-updated':text.profileUpdated,'status-integrations':text.integrationAggregate,'integration-watchlist':text.integrations.letterboxd_watchlist,'integration-ratings':text.integrations.letterboxd_ratings,'integration-epg':text.integrations.epg,'integration-resolver':text.integrations.resolver,'integration-predictions':text.integrations.predictions,'integration-metadata':text.integrations.metadata};for(const [id,value] of Object.entries(values)){const node=$('#'+id);if(node)node.textContent=value;}
 const metadata=$('[data-integration="metadata"]');if(metadata)metadata.hidden=!text.integrations.metadata;
 for(const [id,key] of [['integration-watchlist','letterboxd_watchlist'],['integration-ratings','letterboxd_ratings'],['integration-epg','epg'],['integration-resolver','resolver'],['integration-predictions','predictions'],['integration-metadata','metadata']]){const node=$('#'+id),source=(data.integrations?.sources||[]).find(item=>item.id===key);if(!node)continue;node.classList.remove('is-failed','is-attention');if(source?.state==='failed')node.classList.add('is-failed');else if(source&&['degraded','stale','unknown'].includes(source.state))node.classList.add('is-attention');}}
function markFooterUnreadable(){const unavailable='статус недоступен';for(const id of ['status-local-coverage','status-window-coverage','status-last-run','status-integrations','detail-local-coverage','detail-window-coverage']){const node=$('#'+id);if(node)node.textContent=unavailable;}const next=$('#status-next-run');if(next)next.textContent=footerReadAt?`Последнее чтение: ${madridStamp(footerReadAt)}`:'Последнее чтение: —';for(const id of ['integration-watchlist','integration-ratings','integration-epg','integration-resolver','integration-predictions','integration-metadata']){const node=$('#'+id);if(!node)continue;node.classList.remove('is-failed','is-attention');node.classList.add('is-attention');node.textContent=unavailable;}}
async function loadPredictionQueue(options={}){if(footerLoading)return 'busy';footerLoading=true;try{const response=await fetch('/api/enrichment/footer/status');if(!response.ok)throw new Error();renderFooterStatus(await response.json());footerReady=true;footerReadAt=Date.now();return true;}catch{if(footerReady)markFooterUnreadable();else if(!options.quiet){const unavailable='статус недоступен';$('#status-local-coverage').textContent=unavailable;$('#status-window-coverage').textContent=unavailable;$('#status-last-run').textContent=unavailable;$('#status-integrations').textContent=unavailable;}return false;}finally{footerLoading=false;}}
const FOOTER_MARKUP = `<footer class="status-footer" aria-label="Состояние данных и прогнозов">
      <div class="footer-status">
        <div class="status-summary" role="status" aria-live="polite">
          <div class="status-row"><span>Модель вкуса</span><strong id="taste-version">не настроена</strong></div>
          <div class="status-row status-row-coverage"><span>Локальная база</span><strong id="status-local-coverage">загрузка…</strong></div>
          <div class="status-row status-row-coverage"><span>Окно просмотра</span><strong id="status-window-coverage">загрузка…</strong></div>
          <div class="status-row status-run-row"><span id="status-run-label">Последний run</span><div class="status-run-value"><strong id="status-last-run">загрузка…</strong><small id="status-next-run">Следующий запуск по расписанию: —</small></div></div>
          <div class="status-row"><span>Интеграции</span><strong id="status-integrations">загрузка…</strong></div>
        </div>
        <div class="footer-bar">
        <details class="footer-details" id="status-details">
          <summary><span id="status-details-label">Показать детали</span></summary>
          <div class="footer-details-body">
            <section aria-labelledby="status-predictions-title"><h3 id="status-predictions-title">Прогнозы</h3><dl>
              <div><dt>Локальная база</dt><dd id="detail-local-coverage">—</dd></div>
              <div><dt>Окно просмотра</dt><dd id="detail-window-coverage">—</dd></div>
              <div><dt>Ждут в окне</dt><dd id="detail-pending-hot">—</dd></div>
              <div><dt>Холодная очередь</dt><dd id="detail-pending-cold">—</dd></div>
              <div><dt>Вне окна в кеше</dt><dd id="detail-cache-off-window">—</dd></div>
              <div><dt>Ждут фонового прогноза вне окна</dt><dd id="detail-pending-off-window">—</dd></div>
              <div><dt title="Фильмы, чья повторная попытка отложена до указанного времени. Это не время следующего запуска.">Отложены до повтора</dt><dd id="detail-deferred">—</dd></div>
              <div><dt>Текущий пакет</dt><dd id="detail-current-batch">—</dd></div>
              <div><dt>Следующий пакет</dt><dd id="detail-next-batch">—</dd></div>
            </dl></section>
            <section aria-labelledby="status-epg-title"><h3 id="status-epg-title">EPG / TMDB</h3><p class="status-section-help" id="status-epg-help">EPG-показатели относятся к текущему каталогу передач, локальная база — ко всем сохранённым canonical TMDB-фильмам. Эти totals независимы.</p><dl>
              <div><dt title="Уникальные TMDB-фильмы, распознанные среди кандидатов текущего EPG.">Распознано в текущем EPG</dt><dd id="detail-epg-recognized">—</dd></div>
              <div><dt title="Кандидаты текущего эфира, которым ещё нужно сопоставление. Исторический журнал сюда не входит.">Ждут распознавания</dt><dd id="detail-epg-pending">—</dd></div>
              <div><dt title="Кандидаты прошлых эфиров. Они сохранены и не тратят новые запросы.">Исторический журнал</dt><dd id="detail-epg-history">—</dd></div>
              <div><dt title="Уникальные canonical TMDB film identities, подтверждённые как фильмы и сохранённые локально.">Фильмы в локальной базе</dt><dd id="detail-epg-confirmed">—</dd></div>
              <div><dt>Кеш вне окна</dt><dd id="detail-epg-cache">—</dd></div>
              <div><dt>Покрытие EPG</dt><dd id="detail-epg-coverage">—</dd></div>
              <div><dt>Каналы</dt><dd id="detail-epg-channels">—</dd></div>
              <div><dt>Проверено передач</dt><dd id="detail-epg-checked">—</dd></div>
            </dl></section>
            <section aria-labelledby="status-watchlist-title"><h3 id="status-watchlist-title">Watchlist</h3><dl>
              <div><dt>Фильмы</dt><dd id="detail-watchlist-films">—</dd></div>
              <div><dt>Обновлён</dt><dd id="detail-watchlist-updated">—</dd></div>
              <div><dt>Без метаданных</dt><dd id="detail-watchlist-metadata">—</dd></div>
              <div><dt>Названия требуют проверки</dt><dd id="detail-watchlist-titles">—</dd></div>
            </dl></section>
            <section aria-labelledby="status-integrations-title"><h3 id="status-integrations-title">Интеграции</h3><p class="status-section-help" id="status-integrations-help">Состояние заданий. Окно программы показано сверху.</p><dl id="status-integration-list">
              <div data-integration="letterboxd_watchlist"><dt>Watchlist</dt><dd id="integration-watchlist">—</dd></div>
              <div data-integration="letterboxd_ratings"><dt>Оценки</dt><dd id="integration-ratings">—</dd></div>
              <div data-integration="epg"><dt>Загрузка EPG</dt><dd id="integration-epg">—</dd></div>
              <div data-integration="resolver"><dt>Распознавание</dt><dd id="integration-resolver">—</dd></div>
              <div data-integration="predictions"><dt>Прогнозы</dt><dd id="integration-predictions">—</dd></div>
              <div data-integration="metadata" hidden><dt>Метаданные</dt><dd id="integration-metadata">—</dd></div>
            </dl><a class="status-events-link" id="status-integrations-events" href="/events" data-return-carry>История в событиях</a></section>
            <section aria-labelledby="status-run-title"><h3 id="status-run-title">Последний запуск</h3><dl>
              <div><dt>Начат</dt><dd id="detail-run-started">—</dd></div>
              <div><dt>Добавлено</dt><dd id="detail-run-added">—</dd></div>
              <div><dt>Ошибки</dt><dd id="detail-run-failed">—</dd></div>
              <div><dt>Результат</dt><dd id="detail-run-reason">—</dd></div>
              <div><dt>По расписанию</dt><dd id="detail-run-next">—</dd></div>
            </dl><a class="status-events-link" id="status-events-link" href="/events" data-return-carry>Смотреть события</a></section>
            <section aria-labelledby="status-profile-title"><h3 id="status-profile-title">Модель вкуса</h3><dl>
              <div><dt>Версия</dt><dd id="detail-profile-version">—</dd></div>
              <div><dt>Обновлена</dt><dd id="detail-profile-updated">—</dd></div>
            </dl></section>
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
