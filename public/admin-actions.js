// Demonstration page of the guarded action panel on synthetic data. Everything runs in this tab: the store, the
// executor and the receipts live in memory and disappear on reload. The page makes no request.
const ACTION_SCENARIOS = {
  eligible: {title: 'Два фильма готовы', seed: () => ({pin: 'demo-pin-1', records: [{id: 'film:north', version: 'v1'}, {id: 'film:quiet', version: 'v1'}, {id: 'film:blank', version: 'v1'}], issues: [actionDemoIssue('film:north', true), actionDemoIssue('film:quiet', true), actionDemoIssue('film:blank', false)]})},
  partial: {title: 'Один сбой посреди выполнения', seed: () => ACTION_SCENARIOS.eligible.seed(), apply: async record => {if (record.id === 'film:quiet') throw Object.assign(new Error('provider'), {code: 'provider_error'}); return {refreshed: true};}},
  unknown: {title: 'Тайм-аут: исход неизвестен', seed: () => ACTION_SCENARIOS.eligible.seed(), apply: async record => {if (record.id === 'film:north') throw Object.assign(new Error('timeout'), {unknown: true, code: 'timeout'}); return {refreshed: true};}},
  stale: {title: 'Снимок сменится после превью', seed: () => ACTION_SCENARIOS.eligible.seed(), afterPreview: store => {store.pin = 'demo-pin-2';}},
  ineligible: {title: 'Ничего не готово', seed: () => ({pin: 'demo-pin-1', records: [{id: 'film:blank', version: 'v1'}, {id: 'film:double', version: 'v1'}], issues: [actionDemoIssue('film:blank', false), actionDemoIssue('film:double', null)]})},
};

function actionDemoIssue(id, eligible) {
  return {id: 'metadata/incomplete/film:' + id, subject: {kind: 'film', id}, evidence: {completeness: eligible === null ? 'partial' : 'complete'}, action: {suggested: eligible ? 'bounded_action' : 'investigate', code: 'metadata_refresh', eligible, reason: eligible === true ? 'eligible' : eligible === false ? 'generation_changed' : 'evidence_incomplete'}};
}

function actionDemoKey() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'demo-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function startActionDemo() {
  const registry = fixtureRegistry();
  const select = document.querySelector('#action-scenario');
  select.innerHTML = Object.entries(ACTION_SCENARIOS).map(([code, item]) => `<option value="${code}">${item.title}</option>`).join('');
  let scenario, store, panel;
  const adapter = {
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
  const request = () => ({capability: FIXTURE_CAPABILITY.id, version: FIXTURE_CAPABILITY.version, subject: {kind: 'film', id: 'metadata'}, pin: store.pin});
  const load = () => {
    scenario = ACTION_SCENARIOS[select.value];
    store = createFixtureStore(scenario.seed());
    document.querySelector('#action-receipt-reset').textContent = '';
    panel.refresh(request());
  };
  panel = mountActionPanel(document.querySelector('#action-root'), adapter);
  select.addEventListener('change', load);
  select.value = 'eligible';
  load();
  return {panel, load, get store() {return store;}};
}

const actionDemo = startActionDemo();
