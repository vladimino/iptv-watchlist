// ADR 0178 / AIR-132: the pure view of the owner revoke workflow. No I/O. Every stored value is escaped; the page never
// shows a payload, a title or a film body, only ids, short codes, times and the owner's own basis text.
const REVOKE_REASON_COPY = {
  eligible: 'Можно отозвать.',
  intent_missing: 'Такого действия нет: проверьте идентификатор запроса.',
  intent_not_applied: 'Это действие не было записано до конца, отзывать нечего.',
  not_identity_action: 'Это не коррекция идентичности (assign или reject).',
  wrong_observation: 'Это действие относится к другому наблюдению.',
  provenance_unproven: 'Не удаётся доказать по истории, что именно это действие записало решение. Ничего не меняется.',
  provenance_ambiguous: 'Этот id уже был исключён до действия. Отзыв сохранил бы чужое исключение или снял бы его, поэтому отказ.',
  old_action_not_effective: 'Это действие уже не действует: позже решение заменили или оно изменилось. Ничего не меняется.',
  already_revoked: 'Это действие уже отозвано.',
  not_authoritative: 'Discovery сейчас не в режиме D1: отзыв недоступен, запасного пути через R2 нет.',
  basis_required: 'Укажите основание (до 200 знаков).',
  invalid_request: 'Проверьте ключ наблюдения и идентификатор запроса.',
  stale_pin: 'Данные изменились после показа. Покажите превью заново.',
  confirmation_missing: 'Подтверждение не найдено.',
  confirmation_expired: 'Подтверждение истекло. Покажите превью заново.',
  confirmation_mismatch: 'Подтверждение не совпадает с действием.',
  idempotency_conflict: 'Этот ключ уже использован.',
  revoke_schema_not_ready: 'Схема D1 ещё не готова для отзыва: нужна отдельно применённая миграция.',
  record_changed: 'Решение изменилось, пока вы смотрели. Ничего не записано, покажите превью заново.',
  lease_held: 'Сейчас работает другой писатель Discovery. Ничего не записано, повторите позже.',
  in_progress: 'Исход неизвестен: предыдущая отправка с этим ключом не оставила квитанции. Автоповтора нет, перечитайте превью.',
  access_denied: 'Нужен вход владельца.',
  storage_unavailable: 'Хранилище недоступно.',
  network: 'Нет связи. Ничего не повторяется автоматически.',
  not_eligible: 'Отзыв сейчас недопустим.',
};
const REVOKE_SHOWS_COPY = {
  clears_assigned_rows_and_fences_id: 'Снимет назначенные показы этого наблюдения и закроет этот id для него. Новое решение примет обычный чанк Discovery: отсюда он не запускается.',
  removes_this_rejection_only: 'Снимет только это исключение. Остальные исключения остаются. Решение переоценит обычный чанк Discovery: отсюда он не запускается.',
};

function revokeEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function revokeReasonText(reason) {
  return REVOKE_REASON_COPY[reason] || 'Отзыв сейчас недоступен.';
}

function supersedeReasonText(reason) {
  return REVOKE_REASON_COPY[reason] || ('Замена сейчас недопустима (код: ' + String(reason || 'неизвестно') + ').');
}

function revokeEffectText(effect) {
  return effect === 'assign' ? 'назначение фильма' : effect === 'reject' ? 'исключение id' : '—';
}

function revokeVersionsHtml(versions) {
  if (!Array.isArray(versions) || !versions.length) return '<p class="muted">История решения этого наблюдения пуста.</p>';
  const rows = versions.map(row => `<li><b>#${revokeEscape(row.revision)}</b> ${revokeEscape(row.writer)} · ${revokeEscape(row.at || '—')} · статус ${revokeEscape(row.status || '—')}${row.tmdbId ? ' · id ' + revokeEscape(row.tmdbId) : ''}${row.ownerEffect ? ' · ' + revokeEscape(revokeEffectText(row.ownerEffect)) : ''}</li>`);
  return `<ol class="revoke-versions">${rows.join('')}</ol>`;
}

// The read-only preview: the original action, the versions after it, today's decision and what a revoke would do.
function revokePreviewHtml(preview) {
  if (!preview) return '';
  const original = preview.original;
  const head = original ? `<p><b>Исходное действие:</b> ${revokeEscape(revokeEffectText(original.effect))}${original.tmdbId ? ' · id ' + revokeEscape(original.tmdbId) : ''} · запрос <code>${revokeEscape(original.requestId)}</code> · состояние ${revokeEscape(original.state)}${original.basis ? '<br>основание: ' + revokeEscape(original.basis) : ''}</p>` : '<p class="muted">Исходное действие не найдено.</p>';
  const current = preview.current;
  const now = current ? `<p><b>Сейчас:</b> статус ${revokeEscape(current.status || '—')}${current.tmdbId ? ' · id ' + revokeEscape(current.tmdbId) : ''}${current.rejectedTmdbIds && current.rejectedTmdbIds.length ? ' · исключены ' + revokeEscape(current.rejectedTmdbIds.join(', ')) : ''}${current.revokedOwnerAssign ? ' · закрыт id ' + revokeEscape(current.revokedOwnerAssign.tmdbId) : ''}</p>` : '';
  const verdict = `<p class="revoke-verdict" role="status"><b>${preview.available ? 'Можно отозвать.' : 'Отозвать нельзя.'}</b> ${preview.available ? '' : revokeEscape(revokeReasonText(preview.reason))}</p>`;
  const effect = preview.available && preview.application ? `<p>${revokeEscape(REVOKE_SHOWS_COPY[preview.application.shows] || '')}</p>${preview.application.fence ? `<p>Фильм ${revokeEscape(preview.application.fence.tmdbId)} не будет подтверждён заново для этого наблюдения, пока вы сами снова не назначите этот id. Смена названия, года, нового эфира или оценки это не снимает.</p>` : ''}` : '';
  return `${verdict}${head}${now}${effect}<h3>Версии решения</h3>${revokeVersionsHtml(preview.versions)}`;
}

function revokeReceiptText(body) {
  if (!body || !body.receipt) return '';
  const receipt = body.receipt;
  return (body.replayed ? 'Это повтор: ' : '') + 'отзыв записан' + (receipt.decisionHash ? ' · хэш решения ' + String(receipt.decisionHash).slice(0, 12) : '') + '. Решение переоценит обычный чанк Discovery.';
}
