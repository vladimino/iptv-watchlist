// ADR 0181 / AIR-131: the pure view of the owner group workflow. No I/O. Every stored value is escaped; the page shows ids, short codes,
// times, titles from the owner's own observations and the owner's basis text, never a payload.
const GROUP_REASON_COPY = {
  no_decision: 'У наблюдения ещё нет решения: нечего подтверждать.',
  runtime_conflict: 'Длительность наблюдения расходится с длительностью фильма больше допуска.',
  revoked_fence: 'Ранее назначение этого фильма на это наблюдение отозвано: вернуть можно только отдельным подтверждением владельца.',
  other_owner_assignment: 'Владелец уже назначил этому наблюдению другой фильм.',
  scorer_other_id: 'Алгоритм считает совпадением другой фильм.',
  proof_torn: 'Решение записано не до конца или не совпадает с хэшем: не доверяем.',
  proof_stale: 'Наблюдение не относится к текущему опубликованному прогону.',
  proof_incomplete: 'Доказательство неполное: у наблюдения слишком много эфиров для проверки. Выбрать нельзя.',
  proof_missing: 'Нет доказательств по этому наблюдению.',
  year_conflict: 'Год наблюдения и год фильма расходятся больше чем на год (ремейк или другое издание).',
  tmdb_tv: 'Это телевизионный id, а не фильм.',
  film_absent: 'Такого фильма нет в каталоге.',
  film_not_movie: 'Это не фильм: выбирать группу можно только для movie.',
  identity_inconsistent: 'Данные каталога об этом фильме противоречивы.',
  conflicting_identity: 'У фильма есть конфликтующие id.',
  already_current: 'Это уже назначено.',
  catalogue_unread: 'Каталог не прочитан.',
  year_unknown: 'Неизвестен год наблюдения.',
  film_year_unknown: 'Неизвестен год фильма.',
  ambiguous_needs_stronger: 'Решение неоднозначно: нужно более сильное доказательство.',
  invalid_movie_id: 'Неверный id фильма.',
  group_too_large: 'В группе не больше 10 наблюдений. Лишние не отбрасываются: уберите их сами.',
  invalid_selection: 'Выберите от 1 до 10 разных наблюдений.',
  group_selection_changed: 'Выбранный набор изменился. Ничего не записано: покажите кандидатов заново.',
  stale_pin: 'Данные изменились после показа. Покажите кандидатов заново.',
  basis_required: 'Укажите основание (до 200 знаков).',
  writer_active: 'Сейчас работает писатель Discovery. Ничего не записано, повторите позже.',
  lease_held: 'Сейчас работает писатель Discovery. Ничего не записано, повторите позже.',
  idempotency_conflict: 'Этот ключ группы уже использован.',
  confirmation_expired: 'Подтверждение истекло. Покажите кандидатов заново.',
  confirmation_mismatch: 'Подтверждение не совпадает с набором.',
  confirmation_missing: 'Подтверждение не найдено.',
  group_incomplete: 'Набор записанных заявок неполон. Ничего не записано и ничего не досоздано.',
  group_mismatch: 'Заявки группы не совпадают с подтверждённым набором. Ничего не записано.',
  in_progress: 'Исход неизвестен: одна из записей не оставила квитанции. Остальное не выполнялось, автоповтора нет.',
  group_running: 'Одна из записей группы ещё не завершена или её исход неизвестен. Ничего не выполнялось, автоповтора нет.',
  programme_moved: 'Опубликованный прогон сменился. Остальное не выполнялось.',
  generation_moved: 'Состояние Discovery изменил кто-то ещё. Остальное не выполнялось.',
  lease_lost: 'Потеряна блокировка писателя. Остальное не выполнялось.',
  budget_exhausted: 'Вышло время запуска. Остальное не выполнялось, его можно довести повтором того же подтверждения.',
  expired: 'Подтверждение истекло до записи этого наблюдения.',
  decision_changed: 'Решение изменилось после подтверждения: не перезаписано.',
  not_authoritative: 'Discovery сейчас не в режиме D1: группа недоступна, запасного пути через R2 нет.',
  not_eligible: 'Сейчас недопустимо.',
  access_denied: 'Нужен вход владельца.',
  storage_unavailable: 'Хранилище недоступно. Если запись шла, исход неизвестен: перечитайте группу.',
  network: 'Нет связи. Ничего не повторяется автоматически.',
  unsupported_capability: 'Это подтверждение не для группового действия.',
  invalid_request: 'Проверьте id фильма и выбор.',
};
const GROUP_OUTCOME_COPY = {
  applied: 'записано', conflict: 'конфликт: не записано', refused: 'отказ: не записано', skipped: 'пропущено', expired: 'срок истёк: не записано',
  not_attempted: 'не выполнялось', unknown: 'исход неизвестен', pending: 'ждёт', missing: 'заявки нет',
};
const GROUP_STATE_COPY = {
  applied: 'Все выбранные наблюдения записаны.', partial: 'Записана только часть набора. Остальное описано ниже.',
  unproven: 'Группа не доказана: выдача или версии не совпадают с сохранённой. Успех не подтверждён, повтор недоступен.',
  refused: 'Ничего не записано.', unknown: 'Исход неизвестен. Ничего не повторялось автоматически.',
};

function groupEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function groupReasonText(code) {
  return GROUP_REASON_COPY[code] || ('Недопустимо (код: ' + String(code || 'неизвестно') + ').');
}

function groupFilmHtml(preview) {
  const film = preview && preview.film;
  if (!film) return '';
  return `<p><b>Фильм:</b> ${groupEscape(film.title || '—')}${film.original && film.original !== film.title ? ' (' + groupEscape(film.original) + ')' : ''} · ${groupEscape(film.year ?? '—')} · ${film.runtime ? groupEscape(film.runtime) + ' мин' : 'длительность не указана'} · TMDB ${groupEscape(film.tmdbId)}</p>`;
}

// Coverage is always partial and says so, with every count.
function groupCoverageHtml(preview) {
  const coverage = preview && preview.coverage;
  if (!coverage) return '';
  const anchors = (coverage.anchors || []).map(item => `«${groupEscape(item.anchor)}»: ${groupEscape(item.returned)}${item.more ? ' (есть ещё)' : ''}`).join('; ');
  const parts = [`Покрытие <b>частичное</b>: поиск по началу названия фильма. Якоря: ${anchors || '—'}.`];
  if (coverage.anchorsOmitted) parts.push(`Не использовано якорей: ${groupEscape(coverage.anchorsOmitted)}.`);
  parts.push(`Найдено ${groupEscape(coverage.merged)}, показано ${groupEscape(coverage.shown)}, отброшено ${groupEscape(coverage.dropped)}.`);
  parts.push('Переводы и другие написания названия этим поиском не находятся: их отсутствие в списке ничего не доказывает.');
  return `<p class="muted" role="note">${parts.join(' ')}</p>`;
}

function groupPlanText(plan) {
  if (!plan) return '';
  const before = plan.before ? (plan.before.status || '—') + (plan.before.tmdbId ? ' · ' + plan.before.tmdbId : '') : '—';
  const after = plan.after ? (plan.after.status || '—') + (plan.after.tmdbId ? ' · ' + plan.after.tmdbId : '') : '—';
  return `${before} → ${after}`;
}

function groupRowHtml(row, checked, locked) {
  const observation = row.observation || {};
  const decision = row.decision || {};
  const reasons = (row.reasons || []).map(code => `<li>${groupEscape(groupReasonText(code))}</li>`).join('');
  const info = (row.info || []).map(code => code === 'runtime_unknown' ? 'длительность фильма или наблюдения неизвестна: не блокирует' : code === 'replaces_verified' ? 'заменит уже проверенный другой фильм' : code).map(text => `<li class="muted">${groupEscape(text)}</li>`).join('');
  const shows = (row.shows || []).slice(0, 2).map(show => groupEscape(show.channel || show.channelId || '') + ' ' + groupEscape(show.start ? new Date(show.start).toISOString().slice(0, 16).replace('T', ' ') : '')).join('; ');
  const disabled = !row.selectable || locked ? ' disabled' : '';
  const meta = [`год ${groupEscape(observation.year ?? '—')}`, observation.durations && observation.durations.length ? 'длит. ' + groupEscape(observation.durations.join(', ')) + ' мин' : null, row.yearGap != null ? 'разница в годах ' + groupEscape(row.yearGap) : null, row.runtime && row.runtime.diffMinutes != null ? 'разница в минутах ' + groupEscape(row.runtime.diffMinutes) + ' (допуск ' + groupEscape(row.runtime.toleranceMinutes) + ')' : null].filter(Boolean).join(' · ');
  return `<div class="admin-hit group-row" data-group-row="${groupEscape(row.key)}"><label class="iw-check"><input type="checkbox" data-group-key="${groupEscape(row.key)}"${checked ? ' checked' : ''}${disabled}> <b>${groupEscape(observation.title || row.key)}</b></label>`
    + `<p class="iw-meta muted"><code>${groupEscape(row.key)}</code> · ${meta}</p>`
    + `<p class="iw-meta">Решение сейчас: ${groupEscape(decision.status || 'нет')}${decision.tmdbId ? ' · ' + groupEscape(decision.tmdbId) : ''}${decision.ownerEffect ? ' · владелец' : ''}. После: ${groupEscape(groupPlanText(row.plan))}</p>`
    + (shows ? `<p class="iw-meta muted">Эфиры: ${shows}</p>` : '')
    + (reasons ? `<ul class="group-reasons">${reasons}</ul>` : '') + (info ? `<ul>${info}</ul>` : '') + '</div>';
}

function groupRowsHtml(preview, selected, locked) {
  const rows = (preview && preview.rows) || [];
  if (!rows.length) return '<p class="empty" role="status">Подходящих кандидатов не найдено. Это не доказывает, что их нет: покрытие частичное.</p>';
  return rows.map(row => groupRowHtml(row, selected.has(row.key), locked)).join('');
}

// The exact plan the owner confirmed: one line per key with its before and after.
function groupMembersHtml(members) {
  if (!Array.isArray(members) || !members.length) return '';
  return '<ol class="group-members">' + members.map(member => `<li><code>${groupEscape(member.key)}</code>: ${groupEscape(groupPlanText(member.plan))}</li>`).join('') + '</ol>';
}

function groupOutcomesHtml(result) {
  if (!result) return '';
  const state = GROUP_STATE_COPY[result.state] ? `<p role="status"><b>${groupEscape(GROUP_STATE_COPY[result.state])}</b></p>` : '';
  const rows = (result.outcomes || []).map(item => `<li><code>${groupEscape(item.key)}</code>: ${groupEscape(GROUP_OUTCOME_COPY[item.outcome] || item.outcome)}${item.reason ? ' (' + groupEscape(groupReasonText(item.reason)) + ')' : ''}${item.replayed ? ' · повтор, запись не менялась' : ''}</li>`).join('');
  const stored = result.readback && Array.isArray(result.readback.outcomes)
    ? `<p class="muted">Чтение из D1 после записи: ${result.readback.outcomes.map(item => groupEscape(item.index) + ' ' + groupEscape(GROUP_OUTCOME_COPY[item.outcome] || item.outcome)).join('; ')}${result.readback.complete === false ? '. Набор заявок неполон.' : '.'}</p>` : '';
  return state + (rows ? `<ol class="group-outcomes">${rows}</ol>` : '') + stored;
}
