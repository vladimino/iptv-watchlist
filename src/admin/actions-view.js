// Reusable guarded-action panel: preview, explicit confirmation of the exact scope, receipt. It renders what an
// adapter returns and calls the adapter's two functions; it never decides eligibility and never executes on its own.
// Rendering a preview writes nothing; only the confirm button, enabled after the owner ticks the scope checkbox on an
// eligible preview, calls `adapter.execute`.
const ACTION_PREVIEW_TEXT = {
  eligible: 'Можно подтвердить', ineligible: 'Нельзя выполнить', stale: 'Снимок устарел', unsupported: 'Действие не поддерживается', unknown: 'Недостаточно данных', empty: 'Нечего делать',
};
const ACTION_RUN_TEXT = {
  approved: 'подтверждено', running: 'выполняется', succeeded: 'выполнено', partial: 'выполнено частично', failed: 'не выполнено', aborted: 'прервано', unknown: 'исход неизвестен', refused: 'отказано',
};
const ACTION_OUTCOME_TEXT = {written: 'записано', already_applied: 'уже применено', skipped_changed: 'пропущено: запись изменилась', failed: 'ошибка', unknown: 'неизвестно, записалось ли', not_attempted: 'не выполнялось'};
const ACTION_REFUSAL_TEXT = {
  access_denied: 'Нет доступа владельца.', unsupported_capability: 'Такого действия нет в реестре.', invalid_request: 'Некорректный запрос.',
  confirmation_missing: 'Нет явного подтверждения.', confirmation_expired: 'Подтверждение истекло. Постройте превью заново.', confirmation_mismatch: 'Подтверждение относится к другому объёму.',
  stale_pin: 'Опубликованный снимок изменился после превью.', record_changed: 'Запись изменилась после превью.', eligibility_changed: 'Готовность записей изменилась после превью.',
  not_eligible: 'Превью не допускает подтверждения.', budget_exceeded: 'Объём больше бюджета действия.', idempotency_conflict: 'Этот ключ уже использован для другого объёма.',
  in_progress: 'Такое же действие уже выполняется.', lease_held: 'Другое действие держит lease.',
};

function actionEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function actionPreviewHtml(preview) {
  const status = preview.status;
  const affected = (preview.affected || []).map(item => `<li><span>${actionEscape(item.id)}</span> <small>версия ${actionEscape(item.version)}</small></li>`).join('');
  const excluded = (preview.excluded || []).map(item => `<li><span>${actionEscape(item.id)}</span> <small>${actionEscape(item.status)} · ${actionEscape(item.reason)}</small></li>`).join('');
  const budget = preview.budget ? `записей ${preview.budget.records} из ${preview.budget.maxRecords}, записей в хранилище ${preview.budget.writes}, внешних вызовов ${preview.budget.externalCalls}` : '—';
  return `<p class="action-status action-status-${actionEscape(status)}"><b>${actionEscape(ACTION_PREVIEW_TEXT[status] || status)}</b>${preview.reason && preview.reason !== 'eligible' ? ' · ' + actionEscape(preview.reason) : ''}</p>
    <dl class="action-facts">
      <div><dt>Действие</dt><dd>${actionEscape(preview.capability)} v${actionEscape(preview.version)}</dd></div>
      <div><dt>Снимок</dt><dd>${actionEscape(String(preview.pin || '').slice(0, 40))}${preview.currentPin ? ' · сейчас ' + actionEscape(String(preview.currentPin).slice(0, 40)) : ''}</dd></div>
      <div><dt>Бюджет</dt><dd>${actionEscape(budget)}</dd></div>
      <div><dt>Атомарность</dt><dd>${preview.atomic === false ? 'нет: при сбое возможен частичный результат, он будет виден в квитанции' : '—'}</dd></div>
      <div><dt>Откат</dt><dd>${actionEscape(preview.compensation?.guidance || '—')}</dd></div>
      <div><dt>Объём</dt><dd>${preview.scopeFingerprint ? 'отпечаток ' + actionEscape(preview.scopeFingerprint) : '—'}</dd></div>
    </dl>
    <h4>Будут затронуты</h4>${affected ? `<ul class="action-list">${affected}</ul>` : '<p class="muted">Ничего.</p>'}
    ${excluded ? `<h4>Исключены</h4><ul class="action-list action-list-excluded">${excluded}</ul>` : ''}`;
}

function actionReceiptHtml(receipt) {
  const outcomes = (receipt.outcomes || []).map(entry => `<li><span>${actionEscape(entry.id)}</span> <small>${actionEscape(ACTION_OUTCOME_TEXT[entry.outcome] || entry.outcome)}${entry.error ? ' · ' + actionEscape(entry.error) : ''}</small></li>`).join('');
  const refusal = receipt.refusal ? `<p class="action-refusal">${actionEscape(ACTION_REFUSAL_TEXT[receipt.refusal] || receipt.refusal)}</p>` : '';
  const retry = receipt.state === 'refused' ? 'Ничего не выполнялось. Постройте превью заново.'
    : receipt.state === 'unknown' ? 'Исход части записей неизвестен: сначала перечитайте записи, вслепую не повторяйте.'
    : receipt.retry?.retryable?.length ? `Можно повторить: ${receipt.retry.retryable.map(actionEscape).join(', ')}` : 'Повтор не нужен.';
  return `<p class="action-status action-status-run-${actionEscape(receipt.state)}"><b>Квитанция: ${actionEscape(ACTION_RUN_TEXT[receipt.state] || receipt.state)}</b>${receipt.replay ? ' · повтор того же ключа, ничего не записано заново' : ''}</p>${refusal}
    ${outcomes ? `<ul class="action-list">${outcomes}</ul>` : ''}
    <p class="muted action-retry">${retry}</p>
    <p class="muted">Ключ ${actionEscape(receipt.idempotencyKey || '—')} · объём ${actionEscape(receipt.scopeFingerprint || '—')} · исполнитель: ${actionEscape(receipt.audit?.actor || '—')}</p>`;
}

// Mounts the panel into `root`. `adapter`: {preview(request) -> Promise<preview>, execute(confirmation) -> Promise<receipt>,
// confirm(preview, accepted) -> confirmation|{error}}. Returns {refresh(request)} for the host page.
function mountActionPanel(root, adapter) {
  root.innerHTML = `<div class="action-panel">
    <div class="action-preview" data-action-preview aria-live="polite"></div>
    <label class="action-accept"><input type="checkbox" data-action-accept disabled> <span>Я подтверждаю именно этот объём и понимаю, что результат может быть частичным</span></label>
    <div class="action-buttons"><button type="button" data-action-confirm disabled>Подтвердить и выполнить</button><button type="button" data-action-repreview>Построить превью заново</button></div>
    <div class="action-receipt" data-action-receipt aria-live="polite" role="status"></div>
  </div>`;
  const previewNode = root.querySelector('[data-action-preview]'), accept = root.querySelector('[data-action-accept]');
  const confirmButton = root.querySelector('[data-action-confirm]'), repreview = root.querySelector('[data-action-repreview]'), receiptNode = root.querySelector('[data-action-receipt]');
  const state = {request: null, preview: null, busy: false};
  const sync = () => {
    const eligible = state.preview?.status === 'eligible';
    accept.disabled = !eligible || state.busy;
    if (!eligible) accept.checked = false;
    confirmButton.disabled = !eligible || !accept.checked || state.busy;
  };
  async function refresh(request) {
    state.request = request ?? state.request;
    state.preview = null;
    accept.checked = false;
    previewNode.innerHTML = '<p class="muted">Строим превью…</p>';
    sync();
    state.preview = await adapter.preview(state.request);
    previewNode.innerHTML = actionPreviewHtml(state.preview);
    sync();
    return state.preview;
  }
  async function confirm() {
    if (confirmButton.disabled) return null;
    const confirmation = adapter.confirm(state.preview, accept.checked);
    if (confirmation.error) {receiptNode.innerHTML = actionReceiptHtml({state: 'refused', refusal: confirmation.error, outcomes: []}); return null;}
    state.busy = true;
    sync();
    receiptNode.innerHTML = '<p class="muted">Выполняется…</p>';
    try {
      const receipt = await adapter.execute(confirmation);
      receiptNode.innerHTML = actionReceiptHtml(receipt);
      return receipt;
    } finally {
      state.busy = false;
      accept.checked = false;
      sync();
    }
  }
  accept.addEventListener('change', sync);
  confirmButton.addEventListener('click', () => {confirm();});
  repreview.addEventListener('click', () => {refresh();});
  return {refresh, confirm, state};
}
