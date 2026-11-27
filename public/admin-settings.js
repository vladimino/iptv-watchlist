// /admin/settings (card CU, AIR-611): one GET on open, an explicit POST only from the checkbox (pause or resume) or a retry button, and a read after EVERY answer. Reads and writes are SERIALIZED by one `busy` flag: nothing starts while
// another request (a POST and its mandatory readback included) is in flight, so no response can be superseded. Every control stays disabled until a VALID fresh read succeeds: a failed read keeps the last good snapshot on screen,
// labelled stale with its own read time, and writes nothing. Nothing is stored in the browser and nothing is resubmitted automatically.
const settingsLive={read:null,readAt:null,readFailed:false,writable:false,busy:false};
const settingsEl=selector=>document.querySelector(selector);
function settingsShow(selector,visible){settingsEl(selector).hidden=!visible;}
function settingsOutcomeShow(outcome){
 const node=settingsEl('#settings-outcome');
 node.hidden=!outcome;
 node.textContent=outcome?outcome.text:'';
 node.className='admin-state'+(!outcome||outcome.kind==='applied'?'':outcome.kind==='uncertain'?' admin-state-stale':' admin-state-error');
}
function settingsSnapshotText(){
 const {read,readAt,readFailed}=settingsLive;
 if(read&&!readFailed)return `Прочитано ${catalogSettingsDate(readAt)}.`;
 if(read)return `Данные устарели: последнее успешное чтение ${catalogSettingsDate(readAt)}. Управление заблокировано до успешного чтения.`;
 return readFailed?'Состояние не прочитано. Управление заблокировано.':'Состояние ещё не прочитано.';
}
function settingsRender(){
 const read=settingsLive.read;
 const model=catalogSettingsModel(read);
 const locked=!settingsLive.writable||settingsLive.busy;
 const box=settingsEl('#settings-toggle');
 box.checked=model.checked;
 box.disabled=model.disabled||locked;
 settingsEl('#settings-toggle-label').textContent=model.kind==='active'?'Производитель работает':model.kind==='paused'?'Производитель на паузе':model.kind==='inactive'?'Производитель не активирован':'Состояние неизвестно';
 settingsEl('#settings-toggle-text').textContent=model.text;
 settingsEl('#settings-revision').textContent=model.revision===null?'':`Ревизия управления ${model.revision}`+(read.control.updatedAt?`, изменена ${catalogSettingsDate(read.control.updatedAt)}`:'');
 const now=Date.now();
 settingsEl('#settings-drain').innerHTML=catalogSettingsDrainHtml(read,now);
 settingsEl('#settings-backlog').innerHTML=catalogSettingsBacklogHtml(read);
 settingsEl('#settings-scopes').innerHTML=catalogSettingsScopesHtml(read);
 settingsEl('#settings-cooldowns').innerHTML=catalogSettingsCooldownsHtml(read,now);
 settingsEl('#settings-attention').innerHTML=catalogSettingsAttentionHtml(read);
 for(const button of document.querySelectorAll('.settings-retry'))button.disabled=locked;
 settingsEl('#settings-reread').disabled=settingsLive.busy;
 settingsEl('#settings-snapshot-text').textContent=settingsSnapshotText();
}
// The caller owns `busy`. A snapshot replaces the held one only when it is a recognised state; anything else is a failed read.
async function settingsFetchRead(){
 settingsShow('#settings-loading',true);
 settingsShow('#settings-error',false);
 const result=await loadCatalogSettings();
 settingsShow('#settings-loading',false);
 if(result.ok&&catalogSettingsValidRead(result.body)){
  settingsLive.read=result.body;
  settingsLive.readAt=Date.now();
  settingsLive.readFailed=false;
  settingsLive.writable=true;
  return true;
 }
 settingsLive.readFailed=true;
 settingsLive.writable=false;
 const node=settingsEl('#settings-error');
 node.textContent=result.ok?'Ответ не распознан как состояние. Управление заблокировано.':result.error==='network'?'Сервер недоступен: состояние не прочитано. Управление заблокировано.':'Состояние не прочитано ('+result.error+'). Управление заблокировано.';
 node.hidden=false;
 return false;
}
async function settingsLoad(){
 if(settingsLive.busy)return false;
 settingsLive.busy=true;
 settingsLive.writable=false;
 settingsRender();
 let ok=false;
 try{ok=await settingsFetchRead();}finally{settingsLive.busy=false;}
 settingsRender();
 return ok;
}
// One control action followed by its mandatory read, both inside the same busy window. The outcome line carries only what the POST answer proves; the read status is the separate snapshot line.
async function settingsSend(body){
 if(settingsLive.busy||!settingsLive.writable)return;
 settingsLive.busy=true;
 settingsLive.writable=false;
 settingsRender();
 try{
  const result=await catalogSettingsAction(body);
  settingsOutcomeShow(catalogSettingsOutcome(result,body.action));
  await settingsFetchRead();
 }finally{
  settingsLive.busy=false;
 }
 settingsRender();
}
function onSettingsToggle(){
 const model=catalogSettingsModel(settingsLive.read);
 if(model.disabled||!model.action||!settingsLive.writable||settingsLive.busy){settingsRender();return;}
 settingsSend({action:model.action,expectedRevision:model.revision,requestId:catalogSettingsRequestId()});
}
function onSettingsAttentionClick(event){
 const button=event.target&&event.target.closest?event.target.closest('[data-retry-index]'):null;
 if(!button||settingsLive.busy||!settingsLive.writable)return;
 const body=catalogSettingsRetryBody(settingsLive.read,Number(button.getAttribute('data-retry-index')),catalogSettingsRequestId());
 if(body)settingsSend(body);
}
function startSettings(){
 settingsEl('#settings-toggle').addEventListener('change',onSettingsToggle);
 settingsEl('#settings-reread').addEventListener('click',()=>{if(settingsLive.busy)return;settingsOutcomeShow(null);settingsLoad();});
 settingsEl('#settings-attention').addEventListener('click',onSettingsAttentionClick);
 settingsRender();
 settingsLoad();
}
startSettings();
