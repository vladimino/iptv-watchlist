// Demonstration page of the guarded action panel on fictional data. Everything runs in this tab: the store, the
// executor and the receipts live in memory and disappear on reload. The page makes no request. Fictional titles are the
// trusted display metadata of this simulation; the stable ids stay in the action scope and appear only in the
// technical details.
const ACTION_DEMO_TITLES = {'film:north': 'Север', 'film:quiet': 'Тихая гавань', 'film:blank': 'Пустой лист', 'film:double': 'Двойник'};

const ACTION_SCENARIOS = {
  eligible: {
    title: 'Два фильма можно обновить',
    note: 'Имитируем: у двух фильмов устарели метаданные, а сведения о третьем относятся к прошлому обновлению. Увидим: два фильма изменятся, третий пропустим с объяснением.',
    seed: () => ({pin: 'demo-pin-1', records: [{id: 'film:north', version: 'v1'}, {id: 'film:quiet', version: 'v1'}, {id: 'film:blank', version: 'v1'}], issues: [actionDemoIssue('film:north', true, 'metadata_stale'), actionDemoIssue('film:quiet', true, 'metadata_partial'), actionDemoIssue('film:blank', false, 'metadata_stale')]}),
  },
  partial: {
    title: 'Сбой на одном фильме',
    note: 'Имитируем: при обновлении «Тихой гавани» произойдёт ошибка. Увидим: один фильм изменится, другой нет, и что с этим делать.',
    seed: () => ACTION_SCENARIOS.eligible.seed(),
    apply: async record => {if (record.id === 'film:quiet') throw Object.assign(new Error('provider'), {code: 'provider_error'}); return {refreshed: true};},
  },
  unknown: {
    title: 'Неизвестный результат',
    note: 'Имитируем: сохранение «Севера» прервётся без ответа. Увидим: результат по нему неизвестен, и повторять его без проверки нельзя.',
    seed: () => ACTION_SCENARIOS.eligible.seed(),
    apply: async record => {if (record.id === 'film:north') throw Object.assign(new Error('timeout'), {unknown: true, code: 'timeout'}); return {refreshed: true};},
  },
  stale: {
    title: 'Данные обновились после проверки',
    note: 'Имитируем: сразу после проверки на сайте опубликуются новые данные. Увидим: подтверждение будет отклонено, и ничего не изменится.',
    seed: () => ACTION_SCENARIOS.eligible.seed(),
    afterPreview: store => {store.pin = 'demo-pin-2';},
  },
  ineligible: {
    title: 'Изменять нечего',
    note: 'Имитируем: сведения об одном фильме относятся к прошлому обновлению, о другом их недостаточно. Увидим: кнопка недоступна, у каждого фильма — причина и следующий шаг.',
    seed: () => ({pin: 'demo-pin-1', records: [{id: 'film:blank', version: 'v1'}, {id: 'film:double', version: 'v1'}], issues: [actionDemoIssue('film:blank', false, 'metadata_stale'), actionDemoIssue('film:double', null, 'metadata_partial')]}),
  },
};

function actionDemoIssue(id, eligible, reason) {
  return {id: 'metadata/incomplete/' + id, reason, subject: {kind: 'film', id}, evidence: {completeness: eligible === null ? 'partial' : 'complete'}, action: {suggested: eligible ? 'bounded_action' : 'investigate', code: 'metadata_refresh', eligible, reason: eligible === true ? 'eligible' : eligible === false ? 'generation_changed' : 'evidence_incomplete'}};
}

function actionDemoKey() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'demo-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function startActionDemo() {
  const registry = fixtureRegistry(), descriptors = createDescriptorRegistry([FIXTURE_DESCRIPTOR]);
  const select = document.querySelector('#action-scenario'), note = document.querySelector('#action-scenario-note');
  select.innerHTML = Object.entries(ACTION_SCENARIOS).map(([code, item]) => `<option value="${code}">${actionEscape(item.title)}</option>`).join('');
  let scenario, store, panel;
  const request = () => ({capability: FIXTURE_CAPABILITY.id, version: FIXTURE_CAPABILITY.version, subject: {kind: 'film', id: 'metadata'}, pin: store.pin});
  const adapter = {
    descriptors,
    context: () => ({titles: ACTION_DEMO_TITLES, issues: store.issues}),
    request,
    preview: async request => {
      const preview = previewAction(registry, request, store.read(new Date().toISOString()));
      if (scenario.afterPreview) scenario.afterPreview(store);
      return preview;
    },
    confirm: (preview, accepted) => issueFixtureConfirmation(store, preview, {now: new Date().toISOString(), idempotencyKey: actionDemoKey(), accepted}),
    execute: async confirmation => {
      const {receipt, replay} = await executeFixtureAction(store, registry, confirmation, {principal: {owner: true}, now: new Date().toISOString(), apply: scenario.apply});
      return {...receipt, replay};
    },
  };
  const load = () => {
    scenario = ACTION_SCENARIOS[select.value];
    store = createFixtureStore(scenario.seed());
    note.textContent = scenario.note;
    return panel.refresh(request());
  };
  panel = mountActionPanel(document.querySelector('#action-root'), adapter);
  select.addEventListener('change', load);
  select.value = 'eligible';
  load();
  return {panel, load, get store() {return store;}};
}

const actionDemo = startActionDemo();
