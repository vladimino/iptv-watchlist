// Pure view logic of the /admin/settings page (card CU, AIR-611; ADR 0219): no DOM, no network. It turns the EFFECTIVE state read of /api/admin/settings into the checkbox model, the drain and cooldown lines and the problem rows, and
// turns a control answer into one honest outcome. The checkbox is the C1 control only: checked = active, unchecked = paused, disabled when the producer is not activated (activation is a separate owner operation) or the state is unreadable.
// No second flag, no activation and no scope widening exist here, and pause keeps the cutoff and work.
const CATALOG_SETTINGS_STATUS_TEXT={identity_disagreement:'расхождение идентичности',needs_attention:'нужно внимание',deferred_repair:'отложенный ремонт'};
const CATALOG_SETTINGS_OUTCOME_TEXT={
 stale_revision:'Состояние изменилось после чтения. Ничего не записано; ниже уже актуальное состояние.',
 stale_rows:'Строки изменились после чтения. Ничего не записано; список перечитан.',
 nothing_to_retry:'В выбранных строках нечего повторять. Ничего не записано.',
 origin_not_allowed:'Запрос отклонён: чужой источник. Ничего не записано.',
 action_not_allowed:'Запрос отклонён: действие не разрешено. Ничего не записано.',
 schema_missing:'Схема производителя не установлена. Ничего не записано.',
 control_unavailable:'Управление недоступно. Ничего не записано.',
 unavailable:'Хранилище недоступно. Ничего не записано.',
 network:'Сервер недоступен. Итог неизвестен: страница перечитает состояние, прежде чем что-то повторять.',
};
function catalogSettingsEscape(value){
 return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function catalogSettingsDate(value){
 if(value===null||value===undefined||value==='')return 'нет отметки';
 const parsed=typeof value==='number'?value:Date.parse(value);
 if(!Number.isFinite(parsed))return String(value);
 return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(parsed))+' Madrid';
}
function catalogSettingsRequestId(){
 const c=globalThis.crypto;
 if(c&&typeof c.randomUUID==='function')return 'cu:'+c.randomUUID();
 return 'cu:'+Date.now().toString(36)+Math.random().toString(36).slice(2,12);
}
// The checkbox and its explanation from one effective read. `action` is what a click would send (the opposite of what is shown) or null when the box is disabled.
function catalogSettingsModel(read){
 if(!read||read.configured===false){
  const reason=read&&read.reason;
  return {kind:'unavailable',state:read&&read.state||'inactive',checked:false,disabled:true,action:null,revision:null,
   text:reason==='schema_missing'?'Схема производителя ещё не установлена: управлять нечем.':reason==='no_database'?'База недоступна: состояние неизвестно.':'Состояние не прочитано: управлять нечем.'};
 }
 const control=read.control||{state:'inactive',revision:0};
 const revision=Number.isInteger(control.revision)?control.revision:0;
 if(control.state==='active')return {kind:'active',state:'active',checked:true,disabled:false,action:'pause',revision,text:'Производитель работает: события обрабатываются по мере поступления. Снятие галочки ставит его на паузу; отсечка и работа сохраняются.'};
 if(control.state==='paused')return {kind:'paused',state:'paused',checked:false,disabled:false,action:'resume',revision,text:'Производитель на паузе. Включение возобновляет его на прежней области: она не расширяется, отсечка и накопленная работа сохранены.'};
 return {kind:'inactive',state:'inactive',checked:false,disabled:true,action:null,revision,text:'Производитель не активирован. Активация — отдельная операция владельца и отсюда недоступна: галочка заблокирована.'};
}
// Pause and drain: after a pause the last run may still be draining under its lease. The bound shown is the lease's own expiry, not an invented timeout.
function catalogSettingsDrainHtml(read,nowMs){
 if(!read||read.configured===false)return '<p class="muted">Нет данных о прогоне.</p>';
 const last=read.lastRun;
 const parts=[];
 if(read.draining){
  const until=read.draining.leaseUntil;
  const untilMs=typeof until==='number'?until:Date.parse(until);
  const left=Number.isFinite(untilMs)&&Number.isFinite(nowMs)?untilMs-nowMs:null;
  parts.push(`<p class="admin-state admin-state-stale" role="status">Пауза поставлена, но прогон ещё завершается. Предел — срок его аренды: ${until===null||until===undefined?'не прочитан':catalogSettingsEscape(catalogSettingsDate(untilMs))}${left!==null?(left>0?`, осталось около ${Math.ceil(left/1000)} с`:', срок уже вышел: прогон больше не владеет арендой'):''}.</p>`);
 }else if(read.control&&read.control.state==='paused'){
  parts.push('<p class="muted">Пауза: прогон не идёт, ничего не дожидается завершения.</p>');
 }
 if(last){
  parts.push(`<p>Последний прогон: ${catalogSettingsEscape(last.state)}, начат ${catalogSettingsEscape(catalogSettingsDate(last.startedAt))}${last.finishedAt?`, закончен ${catalogSettingsEscape(catalogSettingsDate(last.finishedAt))}`:''}.</p>`);
 }else parts.push('<p class="muted">Прогонов ещё не было.</p>');
 return parts.join('');
}
function catalogSettingsBacklogHtml(read){
 if(!read||read.configured===false)return '<p class="muted">Нет данных об очереди.</p>';
 const items=[];
 const signals=read.signals,due=read.due;
 items.push(['Сигналов ждёт',signals?String(signals.pending):'не прочитано',signals&&signals.oldestArmedAt?'старейший с '+catalogSettingsDate(signals.oldestArmedAt):'']);
 items.push(['Фильмов к обработке',due?String(due.films):'не прочитано',due&&due.oldestDueSince?'старейший с '+catalogSettingsDate(due.oldestDueSince):'']);
 items.push(['Требуют внимания',String((read.attention||[]).length)+(read.attentionTruncated?'+':''),read.attentionTruncated?'показаны не все':'']);
 return '<ul class="settings-kpis">'+items.map(([label,value,note])=>`<li><span class="settings-kpi-value">${catalogSettingsEscape(value)}</span><span class="settings-kpi-label">${catalogSettingsEscape(label)}</span>${note?`<span class="settings-kpi-note">${catalogSettingsEscape(note)}</span>`:''}</li>`).join('')+'</ul>';
}
function catalogSettingsScopesHtml(read){
 const scopes=read&&read.scopes||[];
 if(!scopes.length)return '<p class="muted">Областей нет: производитель ничего не обрабатывает.</p>';
 return '<ul class="settings-scopes">'+scopes.map(scope=>`<li><strong>${catalogSettingsEscape(scope.scope)}</strong>: ${scope.activated?(scope.enabled?'включена':'выключена'):'не активирована'}, отсечка ${catalogSettingsEscape(catalogSettingsDate(scope.cutoffAt))}, начальная загрузка: ${catalogSettingsEscape(scope.bootstrapState??'нет')}</li>`).join('')+'</ul>';
}
function catalogSettingsCooldownsHtml(read,nowMs){
 const list=read&&read.cooldowns||[];
 const active=list.filter(item=>!Number.isFinite(nowMs)||item.untilAt>nowMs);
 if(!active.length)return '<p class="muted">Активных пауз источников нет.</p>';
 return '<ul class="settings-cooldowns">'+active.map(item=>`<li><strong>${catalogSettingsEscape(item.scope)}</strong> до ${catalogSettingsEscape(catalogSettingsDate(item.untilAt))}${item.reason?` — ${catalogSettingsEscape(item.reason)}`:''}</li>`).join('')+'</ul>';
}
// The rows that need the owner. Each retry button carries its row index; the request is built by catalogSettingsRetryBody from the SAME read, so its expected rows are exactly what the owner saw.
function catalogSettingsAttentionHtml(read){
 const rows=read&&read.attention||[];
 if(!rows.length)return '<p class="muted">Строк, требующих внимания, нет.</p>';
 return '<ul class="settings-rows">'+rows.map((row,index)=>{
  const place=[row.part,row.source!=='*'?row.source:null].filter(Boolean).join(' / ');
  const detail=[row.reason?`причина: ${row.reason}`:null,row.failureClass?`сбой: ${row.failureClass}`:null,row.failures?`сбоев: ${row.failures}`:null,row.retryAt?`повтор ${catalogSettingsDate(row.retryAt)}`:null].filter(Boolean).join(' · ');
  return `<li class="settings-row"><div><strong>${catalogSettingsEscape(row.filmId)}</strong> · ${catalogSettingsEscape(place)} · ${catalogSettingsEscape(CATALOG_SETTINGS_STATUS_TEXT[row.status]||row.status)}<br><span class="muted">${catalogSettingsEscape(detail||'без подробностей')} · обновлено ${catalogSettingsEscape(catalogSettingsDate(row.updatedAt))}</span></div><button type="button" class="admin-more settings-retry" data-retry-index="${index}">Повторить</button></li>`;
 }).join('')+'</ul>';
}
function catalogSettingsRetryBody(read,index,requestId){
 const rows=read&&read.attention||[];
 const row=rows[index];
 if(!row)return null;
 const sameFilm=rows.filter(item=>item.filmId===row.filmId);
 return {action:'retry',filmId:row.filmId,...(row.retry&&row.retry.part?{part:row.retry.part}:{}),...(row.retry&&row.retry.source?{source:row.retry.source}:{}),
  expectedRows:sameFilm.map(item=>({part:item.part,source:item.source,slot:item.slot,status:item.status,updatedAt:item.updatedAt})),requestId};
}
// One honest outcome of a control answer. `kind` is applied | rejected | uncertain | error; the page ALWAYS re-reads the state after any of them.
function catalogSettingsOutcome(result,action){
 const verb={pause:'Пауза',resume:'Возобновление',retry:'Повтор'}[action]||'Действие';
 if(result&&result.ok&&result.outcome==='applied')return {kind:'applied',text:`${verb}: применено и подтверждено перечитыванием.`};
 if(result&&(result.outcome==='unknown'||result.error==='network'||result.error==='storage_unavailable'||result.error==='readback_failed'))return {kind:'uncertain',text:`${verb}: итог неизвестен — запись могла пройти, а могла нет. Страница перечитала состояние; повторяйте только после того, как увидите его.`};
 if(result&&result.outcome==='rejected'){
  const code=result.error&&CATALOG_SETTINGS_OUTCOME_TEXT[result.error]?result.error:(result.body&&result.body.control?'stale_revision':null);
  return {kind:'rejected',text:`${verb}: отклонено. ${code?CATALOG_SETTINGS_OUTCOME_TEXT[code]:'Ничего не записано.'}`};
 }
 const known=result&&CATALOG_SETTINGS_OUTCOME_TEXT[result.error];
 return {kind:'error',text:`${verb}: не выполнено. ${known||'Запрос отклонён сервером, ничего не записано.'}`};
}
