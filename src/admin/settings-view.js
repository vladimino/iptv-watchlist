// Pure view logic of the /admin/settings page (card CU, AIR-611; ADR 0219): no DOM, no network. It turns the EFFECTIVE state read of /api/admin/settings into the checkbox model, the drain and cooldown lines and the problem rows, and
// turns a control answer into one honest outcome. The checkbox is the C1 control only: checked = active, unchecked = paused, disabled when the producer is not activated (activation is a separate owner operation) or the state is unreadable.
// No second flag, no activation and no scope widening exist here, and pause keeps the cutoff and work.
const CATALOG_SETTINGS_STATUS_TEXT={identity_disagreement:'расхождение идентичности',needs_attention:'нужно внимание',deferred_repair:'отложенный ремонт'};
const CATALOG_SETTINGS_OUTCOME_TEXT={
 stale_revision:'Состояние изменилось после чтения. Ничего не записано.',
 stale_rows:'Строки изменились после чтения. Ничего не записано.',
 nothing_to_retry:'В выбранных строках нечего повторять. Ничего не записано.',
 origin_not_allowed:'Запрос отклонён: чужой источник. Ничего не записано.',
 action_not_allowed:'Запрос отклонён: действие не разрешено. Ничего не записано.',
 schema_missing:'Схема производителя не установлена. Ничего не записано.',
 control_unavailable:'Управление недоступно. Ничего не записано.',
 unavailable:'Хранилище недоступно. Ничего не записано.',
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
// A read is usable only when its envelope is known: `configured:false` with a reason, or `configured:true` with a control of a known state and integer revision and generation. Anything else is NOT a state and enables nothing.
function catalogSettingsValidRead(body){
 if(!body||typeof body!=='object'||Array.isArray(body))return false;
 if(body.configured===false)return typeof body.reason==='string';
 if(body.configured!==true)return false;
 const control=body.control;
 return !!control&&typeof control==='object'&&['inactive','active','paused'].includes(control.state)&&Number.isInteger(control.revision)&&control.revision>=0&&Number.isInteger(control.generation)&&control.generation>=0;
}
// The checkbox and its explanation from one effective read. `action` is what a click would send (the opposite of what is shown) or null when the box is disabled. The page ANDs this with its own writable flag.
function catalogSettingsModel(read){
 if(!catalogSettingsValidRead(read))return {kind:'unread',state:null,checked:false,disabled:true,action:null,revision:null,text:'Состояние не прочитано или ответ не распознан: управлять нечем, галочка заблокирована.'};
 if(read.configured===false){
  const reason=read.reason;
  return {kind:'unavailable',state:read.state||'inactive',checked:false,disabled:true,action:null,revision:null,
   text:reason==='schema_missing'?'Схема производителя ещё не установлена: управлять нечем.':reason==='no_database'?'База недоступна: состояние неизвестно.':'Состояние недоступно: управлять нечем.'};
 }
 const control=read.control;
 const revision=control.revision;
 if(control.state==='active')return {kind:'active',state:'active',checked:true,disabled:false,action:'pause',revision,text:'Производитель работает: события обрабатываются по мере поступления. Снятие галочки ставит его на паузу; отсечка и работа сохраняются.'};
 if(control.state==='paused')return {kind:'paused',state:'paused',checked:false,disabled:false,action:'resume',revision,text:'Производитель на паузе. Включение возобновляет его на прежней области: она не расширяется, отсечка и накопленная работа сохранены.'};
 return {kind:'inactive',state:'inactive',checked:false,disabled:true,action:null,revision,text:'Производитель не активирован. Активация — отдельная операция владельца и отсюда недоступна: галочка заблокирована.'};
}
const CATALOG_SETTINGS_UNKNOWN='<p class="muted settings-unknown">Неизвестно: состояние не прочитано.</p>';
const catalogSettingsKnown=read=>catalogSettingsValidRead(read)&&read.configured===true;
// Pause and drain: after a pause the last run may still be draining under its lease. The bound shown is the lease's own expiry, not an invented timeout.
function catalogSettingsDrainHtml(read,nowMs){
 if(!catalogSettingsKnown(read))return CATALOG_SETTINGS_UNKNOWN;
 const parts=[];
 if(read.draining===undefined)parts.push('<p class="muted settings-unknown">Неизвестно: завершается ли прогон после паузы.</p>');
 else if(read.draining){
  const until=read.draining.leaseUntil;
  const untilMs=typeof until==='number'?until:Date.parse(until);
  const left=Number.isFinite(untilMs)&&Number.isFinite(nowMs)?untilMs-nowMs:null;
  parts.push(`<p class="admin-state admin-state-stale" role="status">Пауза поставлена, но прогон ещё завершается. Предел — срок его аренды: ${Number.isFinite(untilMs)?catalogSettingsEscape(catalogSettingsDate(untilMs)):'не прочитан'}${left!==null?(left>0?`, осталось около ${Math.ceil(left/1000)} с`:', срок уже вышел: прогон больше не владеет арендой'):''}.</p>`);
 }else if(read.control.state==='paused')parts.push('<p class="muted">Пауза: прогон не идёт, ничего не дожидается завершения.</p>');
 const last=read.lastRun;
 if(last===undefined)parts.push('<p class="muted settings-unknown">Неизвестно: последний прогон не прочитан.</p>');
 else if(last)parts.push(`<p>Последний прогон: ${catalogSettingsEscape(last.state)}, начат ${catalogSettingsEscape(catalogSettingsDate(last.startedAt))}${last.finishedAt?`, закончен ${catalogSettingsEscape(catalogSettingsDate(last.finishedAt))}`:''}.</p>`);
 else parts.push('<p class="muted">Прогонов ещё не было.</p>');
 return parts.join('');
}
function catalogSettingsBacklogHtml(read){
 if(!catalogSettingsKnown(read))return CATALOG_SETTINGS_UNKNOWN;
 const signals=read.signals,due=read.due,attention=Array.isArray(read.attention)?read.attention:null;
 const items=[
  ['Сигналов ждёт',signals?String(signals.pending):'неизвестно',signals&&signals.oldestArmedAt?'старейший с '+catalogSettingsDate(signals.oldestArmedAt):''],
  ['Фильмов к обработке',due?String(due.films):'неизвестно',due&&due.oldestDueSince?'старейший с '+catalogSettingsDate(due.oldestDueSince):''],
  ['Требуют внимания',attention?String(attention.length)+(read.attentionTruncated?'+':''):'неизвестно',attention&&read.attentionTruncated?'показаны не все':''],
 ];
 return '<ul class="settings-kpis">'+items.map(([label,value,note])=>`<li><span class="settings-kpi-value">${catalogSettingsEscape(value)}</span><span class="settings-kpi-label">${catalogSettingsEscape(label)}</span>${note?`<span class="settings-kpi-note">${catalogSettingsEscape(note)}</span>`:''}</li>`).join('')+'</ul>';
}
function catalogSettingsScopesHtml(read){
 if(!catalogSettingsKnown(read)||!Array.isArray(read.scopes))return CATALOG_SETTINGS_UNKNOWN;
 if(!read.scopes.length)return '<p class="muted">Областей нет: производитель ничего не обрабатывает.</p>';
 return '<ul class="settings-scopes">'+read.scopes.map(scope=>`<li><strong>${catalogSettingsEscape(scope.scope)}</strong>: ${scope.activated?(scope.enabled?'включена':'выключена'):'не активирована'}, отсечка ${catalogSettingsEscape(catalogSettingsDate(scope.cutoffAt))}, начальная загрузка: ${catalogSettingsEscape(scope.bootstrapState??'нет')}</li>`).join('')+'</ul>';
}
function catalogSettingsCooldownsHtml(read,nowMs){
 if(!catalogSettingsKnown(read)||!Array.isArray(read.cooldowns))return CATALOG_SETTINGS_UNKNOWN;
 const active=read.cooldowns.filter(item=>!Number.isFinite(nowMs)||item.untilAt>nowMs);
 if(!active.length)return '<p class="muted">Активных пауз источников в ответе нет.</p>';
 return '<ul class="settings-cooldowns">'+active.map(item=>`<li><strong>${catalogSettingsEscape(item.scope)}</strong> до ${catalogSettingsEscape(catalogSettingsDate(item.untilAt))}${item.reason?` — ${catalogSettingsEscape(item.reason)}`:''}</li>`).join('')+'</ul>';
}
// What ONE retry click does, stated from the row the owner sees: only that row (its part, source and slot) goes back to `due`, and the Film's plan epoch rises, so every batch of an older plan fails. Other rows of the Film are not touched.
function catalogSettingsRetryScope(row){
 const film=row.part==='film';
 const target=film?'строка фильма (проверка идентичности), без частей':`часть ${row.part} · источник ${row.source==='*'?'любой':row.source} · слот ${row.slot}`;
 return film?`Охват: только ${target}. Вернёт её в проверку якорей; план фильма обновится, пакеты старого плана будут отброшены. Другие строки не затрагиваются.`:`Охват: только ${target}. Вернёт её в очередь; план фильма обновится, пакеты старого плана будут отброшены. Другие строки фильма не затрагиваются.`;
}
// The rows that need the owner. Each retry button carries its row index; the request is built by catalogSettingsRetryBody from the SAME read and names exactly that one row.
function catalogSettingsAttentionHtml(read){
 if(!catalogSettingsKnown(read)||!Array.isArray(read.attention))return CATALOG_SETTINGS_UNKNOWN;
 if(!read.attention.length)return '<p class="muted">В ответе нет строк, требующих внимания.</p>';
 return '<ul class="settings-rows">'+read.attention.map((row,index)=>{
  const place=[row.part,row.source!=='*'?row.source:null,'слот '+row.slot].filter(Boolean).join(' / ');
  const detail=[row.reason?`причина: ${row.reason}`:null,row.failureClass?`сбой: ${row.failureClass}`:null,row.failures?`сбоев: ${row.failures}`:null,row.retryAt?`повтор ${catalogSettingsDate(row.retryAt)}`:null].filter(Boolean).join(' · ');
  return `<li class="settings-row"><div><strong>${catalogSettingsEscape(row.filmId)}</strong> · ${catalogSettingsEscape(place)} · ${catalogSettingsEscape(CATALOG_SETTINGS_STATUS_TEXT[row.status]||row.status)}<br><span class="muted">${catalogSettingsEscape(detail||'без подробностей')} · обновлено ${catalogSettingsEscape(catalogSettingsDate(row.updatedAt))}</span><br><span class="settings-scope">${catalogSettingsEscape(catalogSettingsRetryScope(row))}</span></div><button type="button" class="admin-more settings-retry" data-retry-index="${index}">Повторить эту строку</button></li>`;
 }).join('')+'</ul>'+(read.attentionTruncated?'<p class="muted">Показаны не все строки: список ограничен сервером.</p>':'');
}
// ONE explicit row. The server selects `expectedRows` filtered by part and source and resets exactly those rows, so naming only the clicked row (with its own slot, status and updatedAt) keeps the click from widening to other rows of the Film.
function catalogSettingsRetryBody(read,index,requestId){
 const rows=catalogSettingsKnown(read)&&Array.isArray(read.attention)?read.attention:[];
 const row=rows[index];
 if(!row)return null;
 return {action:'retry',filmId:row.filmId,...(row.part&&row.part!=='film'?{part:row.part}:{}),...(row.source&&row.source!=='*'?{source:row.source}:{}),
  expectedRows:[{part:row.part,source:row.source,slot:row.slot,status:row.status,updatedAt:row.updatedAt}],requestId};
}
// The POST evidence, and nothing more: whether the state was re-read afterwards is the page's own separate line, and a later state never decides what happened to the command.
function catalogSettingsOutcome(result,action){
 const verb={pause:'Пауза',resume:'Возобновление',retry:'Повтор'}[action]||'Действие';
 const evidence=result&&result.evidence;
 if(evidence==='applied')return {kind:'applied',text:`${verb}: сервер подтвердил запись.${result.readbackUnavailable?' Собственное перечитывание сервером не удалось: показанное ниже состояние может быть и новее этого запроса.':''}`};
 if(evidence==='rejected'){
  const code=result.error&&CATALOG_SETTINGS_OUTCOME_TEXT[result.error]?result.error:(result.body&&result.body.control?'stale_revision':null);
  return {kind:'rejected',text:`${verb}: отклонено. ${code?CATALOG_SETTINGS_OUTCOME_TEXT[code]:'Ничего не записано.'}`};
 }
 if(evidence==='refused')return {kind:'error',text:`${verb}: запрос отклонён до записи. ${CATALOG_SETTINGS_OUTCOME_TEXT[result.error]||'Ничего не записано.'}`};
 return {kind:'uncertain',text:`${verb}: итог неизвестен — запись могла пройти, а могла нет. Автоматического повтора нет; последующее чтение не докажет судьбу именно этого запроса.`};
}
