// Reusable guarded-action panel. It renders the plain-language model of src/admin/actions-presentation.js in a fixed
// order (what is wrong, what will change, who is included and why, who is skipped and why, risks, the exact
// confirmation, the result) and calls the adapter's functions; it never decides eligibility and never executes on its
// own. Rendering a preview writes nothing. The confirm button works only for an eligible preview that the presentation
// layer could fully explain, and only after the owner ticks the scope checkbox. Every text is HTML-escaped; raw codes,
// ids, versions and fingerprints are shown only inside the closed "Технические подробности" disclosure.

function actionEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function actionTechnicalHtml(rows) {
  if (!rows?.length) return '';
  const items = rows.map(([label, value]) => `<div><dt>${actionEscape(label)}</dt><dd>${actionEscape(value)}</dd></div>`).join('');
  return `<details class="action-tech"><summary>Технические подробности</summary><p class="muted">Для диагностики. Внутренние коды и идентификаторы — как их записала система.</p><dl class="action-facts">${items}</dl></details>`;
}

function actionStatusHtml(tone, headline, detail, next) {
  return `<div class="action-status action-tone-${actionEscape(tone)}"><p><b>${actionEscape(headline)}</b>${detail ? ' ' + actionEscape(detail) : ''}</p>${next ? `<p class="action-next">${actionEscape(next)}</p>` : ''}</div>`;
}

function actionPreviewHtml(model) {
  const head = `<h2 class="action-title">${actionEscape(model.title)}</h2>`;
  if (!model.explainable) return `${head}<p class="action-unexplainable" role="alert">${actionEscape(model.message)}</p>${actionTechnicalHtml(model.technical)}`;
  const included = model.included.length
    ? `<ul class="action-items">${model.included.map(item => `<li><b>${actionEscape(item.name)}</b><span>${actionEscape(item.text)}</span></li>`).join('')}</ul>`
    : '<p class="muted">Никого: изменять сейчас нечего.</p>';
  const excluded = model.excluded.length
    ? `<ul class="action-items action-items-excluded">${model.excluded.map(item => `<li><b>${actionEscape(item.name)}</b><span>${actionEscape(item.text)}</span><span class="action-next">Что делать: ${actionEscape(item.next)}</span></li>`).join('')}</ul>`
    : '<p class="muted">Никого не пропускаем.</p>';
  const change = model.change;
  return `${head}${actionStatusHtml(model.status.tone, model.status.headline, model.status.detail, model.status.next)}
    <section class="action-section"><h3>Что не так</h3><p>${actionEscape(model.problem)}</p></section>
    <section class="action-section"><h3>Что мы собираемся изменить</h3><p>${actionEscape(change.summary)}</p><p>Что может измениться: ${actionEscape(change.fields)}. ${actionEscape(change.untouched)}</p><p>${actionEscape(change.effect)}</p>${change.simulation ? `<p class="action-simulation">${actionEscape(change.simulation)}</p>` : ''}</section>
    <section class="action-section"><h3>Кого это затронет (и почему)</h3>${included}</section>
    <section class="action-section"><h3>Кого пропустим (и почему)</h3>${excluded}</section>
    <section class="action-section"><h3>Что может пойти не так / как поступить</h3><ul class="action-risks">${model.risks.map(risk => `<li>${actionEscape(risk)}</li>`).join('')}</ul></section>
    ${actionTechnicalHtml(model.technical)}`;
}

function actionReceiptHtml(model) {
  const head = '<h3 class="action-result-title" tabindex="-1" data-action-result-title>Что получилось</h3>';
  if (!model.explainable) return `${head}${actionStatusHtml(model.tone, model.headline, '', '')}<p class="action-unexplainable" role="alert">${actionEscape(model.message)}</p>${actionTechnicalHtml(model.technical)}`;
  const lines = model.lines.map(line => `<li class="action-outcome-${actionEscape(line.outcome)}"><b>${actionEscape(line.name)}</b><span>${actionEscape(line.text)}</span>${line.next ? `<span class="action-next">Что делать: ${actionEscape(line.next)}</span>` : ''}</li>`).join('');
  return `${head}${actionStatusHtml(model.tone, model.headline, model.summary, model.next)}${model.replay ? `<p class="muted">${actionEscape(model.replay)}</p>` : ''}
    ${lines ? `<ul class="action-items">${lines}</ul>` : ''}${actionTechnicalHtml(model.technical)}`;
}

// Mounts the panel into `root`. `adapter`: {descriptors, context() -> {titles, issues}, request?() -> request, preview(request) -> Promise<preview>,
// confirm(preview, accepted) -> confirmation|{error}, execute(confirmation) -> Promise<receipt>}. Returns
// {refresh(request), confirm(), state} for the host page.
function mountActionPanel(root, adapter) {
  root.innerHTML = `<div class="action-panel">
    <div class="action-preview" data-action-preview aria-live="polite"></div>
    <section class="action-section action-confirm" aria-labelledby="action-confirm-title"><h3 id="action-confirm-title">Подтверждение</h3>
      <label class="action-accept"><input type="checkbox" data-action-accept disabled> <span data-action-accept-text>Подтверждение станет доступно, когда проверка покажет, что изменять.</span></label>
      <div class="action-buttons"><button type="button" data-action-confirm disabled>Смоделировать изменение</button><button type="button" data-action-repreview>Проверить заново</button></div>
    </section>
    <div class="action-receipt" data-action-receipt aria-live="polite"></div>
  </div>`;
  const previewNode = root.querySelector('[data-action-preview]'), accept = root.querySelector('[data-action-accept]'), acceptText = root.querySelector('[data-action-accept-text]');
  const confirmButton = root.querySelector('[data-action-confirm]'), repreview = root.querySelector('[data-action-repreview]'), receiptNode = root.querySelector('[data-action-receipt]');
  const state = {request: null, preview: null, model: null, busy: false};
  const sync = () => {
    // Only an eligible preview that was fully explained can be confirmed; anything else keeps both controls off.
    const ready = state.preview?.status === 'eligible' && state.model?.explainable === true && Boolean(state.model.confirm);
    accept.disabled = !ready || state.busy;
    if (!ready) accept.checked = false;
    confirmButton.disabled = !ready || !accept.checked || state.busy;
    acceptText.textContent = ready ? state.model.confirm.label : 'Подтверждать нечего: выполнение недоступно. Причина указана выше.';
    confirmButton.textContent = ready ? state.model.confirm.cta : 'Смоделировать изменение';
  };
  const showReceipt = receipt => {
    receiptNode.innerHTML = actionReceiptHtml(presentReceipt(receipt, adapter.descriptors, adapter.context()));
    receiptNode.querySelector?.('[data-action-result-title]')?.focus?.();
  };
  async function refresh(request) {
    state.request = request ?? state.request;
    state.preview = null;
    state.model = null;
    accept.checked = false;
    previewNode.innerHTML = '<p class="muted">Проверяем данные…</p>';
    receiptNode.innerHTML = '';
    sync();
    state.preview = await adapter.preview(state.request);
    state.model = presentPreview(state.preview, adapter.descriptors, adapter.context());
    previewNode.innerHTML = actionPreviewHtml(state.model);
    sync();
    return state.preview;
  }
  async function confirm() {
    if (confirmButton.disabled) return null;
    const confirmation = adapter.confirm(state.preview, accept.checked);
    if (confirmation.error) {showReceipt({state: 'refused', refusal: confirmation.error, outcomes: []}); return null;}
    state.busy = true;
    sync();
    receiptNode.innerHTML = '<p class="muted">Выполняется…</p>';
    try {
      const receipt = await adapter.execute(confirmation);
      showReceipt(receipt);
      return receipt;
    } finally {
      state.busy = false;
      accept.checked = false;
      sync();
    }
  }
  accept.addEventListener('change', sync);
  confirmButton.addEventListener('click', () => {confirm();});
  // A fresh check asks the adapter for a request over the current data, so a stale preview can recover.
  repreview.addEventListener('click', () => {refresh(adapter.request ? adapter.request() : undefined);});
  return {refresh, confirm, state};
}
