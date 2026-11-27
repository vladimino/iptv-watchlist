// /admin/settings (card CU, AIR-611): one GET on open, an explicit POST only from the checkbox (pause or resume) or a retry button, and a re-read after EVERY answer. State lives only in `settingsLive`; nothing is stored in the browser.
const settingsLive={read:null,busy:false};
const settingsEl=selector=>document.querySelector(selector);
function settingsShow(selector,visible){settingsEl(selector).hidden=!visible;}
function settingsOutcomeShow(outcome){
 const node=settingsEl('#settings-outcome');
 node.hidden=!outcome;
 node.textContent=outcome?outcome.text:'';
 node.className='admin-state'+(outcome&&outcome.kind==='applied'?'':outcome&&outcome.kind==='uncertain'?' admin-state-stale':outcome?' admin-state-error':'');
}
function settingsRender(){
 const read=settingsLive.read;
 const model=catalogSettingsModel(read);
 const box=settingsEl('#settings-toggle');
 box.checked=model.checked;
 box.disabled=model.disabled||settingsLive.busy;
 settingsEl('#settings-toggle-label').textContent=model.kind==='active'?'Производитель работает':model.kind==='paused'?'Производитель на паузе':model.kind==='inactive'?'Производитель не активирован':'Состояние неизвестно';
 settingsEl('#settings-toggle-text').textContent=model.text;
 settingsEl('#settings-revision').textContent=model.revision===null?'':`Ревизия управления ${model.revision}`+(read&&read.control&&read.control.updatedAt?`, изменена ${catalogSettingsDate(read.control.updatedAt)}`:'');
 const now=Date.now();
 settingsEl('#settings-drain').innerHTML=catalogSettingsDrainHtml(read,now);
 settingsEl('#settings-backlog').innerHTML=catalogSettingsBacklogHtml(read);
 settingsEl('#settings-scopes').innerHTML=catalogSettingsScopesHtml(read);
 settingsEl('#settings-cooldowns').innerHTML=catalogSettingsCooldownsHtml(read,now);
 settingsEl('#settings-attention').innerHTML=catalogSettingsAttentionHtml(read);
 for(const button of document.querySelectorAll('.settings-retry'))button.disabled=settingsLive.busy;
 settingsEl('#settings-snapshot-text').textContent=read?`Прочитано ${catalogSettingsDate(now)}.`:'Состояние ещё не прочитано.';
}
async function settingsLoad(){
 settingsShow('#settings-loading',true);
 settingsShow('#settings-error',false);
 const result=await loadCatalogSettings();
 settingsShow('#settings-loading',false);
 if(!result.ok){
  const node=settingsEl('#settings-error');
  node.textContent=result.error==='network'?'Сервер недоступен. Показано последнее прочитанное состояние, если оно было.':'Состояние не прочитано ('+result.error+'). Ничего не изменено.';
  node.hidden=false;
  return false;
 }
 settingsLive.read=result.body;
 settingsRender();
 return true;
}
// One control action. A second click while one is in flight is refused; every answer, uncertain ones included, ends in a fresh read.
async function settingsSend(body){
 if(settingsLive.busy)return;
 settingsLive.busy=true;
 settingsRender();
 let outcome;
 try{
  const result=await catalogSettingsAction(body);
  outcome=catalogSettingsOutcome(result,body.action);
 }finally{
  settingsLive.busy=false;
 }
 settingsOutcomeShow(outcome);
 await settingsLoad();
 settingsRender();
}
function onSettingsToggle(){
 const model=catalogSettingsModel(settingsLive.read);
 if(model.disabled||!model.action){settingsRender();return;}
 settingsSend({action:model.action,expectedRevision:model.revision,requestId:catalogSettingsRequestId()});
}
function onSettingsAttentionClick(event){
 const button=event.target&&event.target.closest?event.target.closest('[data-retry-index]'):null;
 if(!button)return;
 const body=catalogSettingsRetryBody(settingsLive.read,Number(button.getAttribute('data-retry-index')),catalogSettingsRequestId());
 if(body)settingsSend(body);
}
function startSettings(){
 settingsEl('#settings-toggle').addEventListener('change',onSettingsToggle);
 settingsEl('#settings-reread').addEventListener('click',()=>{settingsOutcomeShow(null);settingsLoad();});
 settingsEl('#settings-attention').addEventListener('click',onSettingsAttentionClick);
 settingsRender();
 settingsLoad();
}
startSettings();
