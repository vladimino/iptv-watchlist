// Channel admin page (AIR-562). Reads the staged Channel snapshot, edits owner decisions, and imports an M3U that is parsed HERE: only normalized
// {sourceId,name,group} entries go to the server. Policy is staged, not applied to EPG (see the banner). Nothing runs on page open but one read.
const CHANNELS_PAGE_SIZE = 50;
const CHANNELS_ERROR_TEXT = {
  stale_revision: 'Данные изменились после того, как страница их прочитала. Список перечитан: повтори изменение.',
  channel_authority_unavailable: 'Хранилище каналов недоступно или неполное. Ничего не изменено.',
  storage_unavailable: 'Хранилище не подтвердило запись. Итог неизвестен: перечитай список, прежде чем повторять.',
  readback_failed: 'Запись прошла, но перечитать её не удалось. Перечитай список, прежде чем повторять.',
  confirmation_required: 'Нужно явное подтверждение.',
  unknown_channel: 'Такого канала нет. Новые каналы вручную не создаются.',
  unknown_category: 'Такой категории нет.',
  invalid_import: 'Сервер отклонил набор каналов. Ничего не записано.',
  body_too_large: 'Набор слишком большой. Ничего не записано.',
  network: 'Сервер недоступен. Итог неизвестен: перечитай список, прежде чем повторять.',
};
const channelsState = {data: null, items: [], offset: 0, parsed: null, submission: null, sourceSha: null, importRequestId: null, preview: null, busy: false};
const channelsEl = selector => document.querySelector(selector);
function channelsEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}
function channelsDate(value) {
  if (!value) return 'нет';
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value);
  return new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}).format(new Date(parsed)) + ' Madrid';
}
function channelsMessage(text, error) {
  const node = channelsEl('#channels-message');
  node.hidden = !text;
  node.textContent = text || '';
  node.className = 'admin-state' + (error ? ' admin-state-error' : '');
  if (text) node.focus();
}
function channelsErrorText(result) {
  const detail = result.body && Array.isArray(result.body.errors) && result.body.errors.length ? ' Первая причина: ' + result.body.errors[0].code + (result.body.errors[0].index !== undefined ? ' (запись ' + (result.body.errors[0].index + 1) + ')' : '') + '.' : '';
  return (CHANNELS_ERROR_TEXT[result.error] || 'Ошибка ' + result.error + '. Ничего не изменено.') + detail;
}
function channelsCategoryKey(name) {return String(name).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();}
function channelsFilters() {
  return {q: channelsEl('#channels-q').value.trim(), category: channelsEl('#channels-category').value, policy: channelsEl('#channels-policy').value, source: channelsEl('#channels-source').value, queue: channelsEl('#channels-queue').checked ? 'unclassified' : ''};
}

function channelsRenderActivation(activation) {
  const view = EpgChannelAdmin.activationView(activation);
  channelsEl('#channels-eyebrow').textContent = view.eyebrow;
  return view;
}
function channelsSavedClause() {
  return EpgChannelAdmin.activationView(channelsState.data && channelsState.data.activation).saved;
}
function channelsRenderStatus() {
  const data = channelsState.data;
  channelsRenderActivation(data && data.activation);
  const body = channelsEl('#channels-status-body');
  if (!data || !data.available) {
    body.textContent = 'Схема Channel (миграция 0032) ещё не применена в этой базе: чтение и запись отключены, ничего не создаётся неявно. Первое применение и первый импорт — отдельный шаг владельца.';
    channelsEl('#channels-import').hidden = true;
    channelsEl('#channels-list-section').hidden = true;
    return;
  }
  const t = data.totals;
  body.innerHTML = `<b>Ревизия ${data.revision}</b> (последний импорт — ${data.importRevision}${data.empty ? ', данных ещё нет' : ''}). ${EpgChannelAdmin.activationView(data.activation).status}<br>` +
    `Каналов ${t.channels} · неклассифицированных ${t.unclassified} · нет в последнем импорте ${t.unlisted} · ручных политик ${t.overrides} · итог: discover ${t.byPolicy.discover}, deny_all ${t.byPolicy.deny_all}, known_only ${t.byPolicy.known_only}` +
    (data.presence.available ? '' : '<br><span class="muted">Последние показы в EPG сейчас недоступны.</span>');
  channelsEl('#channels-import').hidden = false;
  channelsEl('#channels-list-section').hidden = false;
  const select = channelsEl('#channels-category');
  const current = select.value;
  select.innerHTML = '<option value="">любая</option><option value="none">без категории</option>' + data.categories.map(c => `<option value="${channelsEscape(c.key)}">${channelsEscape(c.name)} · ${c.policy} (${c.channels})</option>`).join('');
  select.value = [...select.options].some(o => o.value === current) ? current : '';
}

function channelsItemHtml(row) {
  const cats = channelsState.data.categories;
  const owner = row.ownerCategory ? row.ownerCategory.key : '';
  const categoryOptions = '<option value="">— без категории владельца —</option>' + cats.map(c => `<option value="${channelsEscape(c.key)}"${c.key === owner ? ' selected' : ''}>${channelsEscape(c.name)} · ${c.policy}</option>`).join('');
  const policies = ['', 'discover', 'deny_all', 'known_only'].map(p => `<option value="${p}"${(row.overridePolicy || '') === p ? ' selected' : ''}>${p || '— без ручной политики —'}</option>`).join('');
  const presence = row.publishedFilmShows ? `опубликованных показов фильмов: ${row.publishedFilmShows.shows}, последний ${channelsDate(row.publishedFilmShows.lastStartMs)}` : 'нет опубликованных показов фильмов (это не значит, что канал не в эфире)';
  const basis = {override: 'ручная политика', owner_category: 'категория владельца', category: 'категория провайдера', unclassified: 'не классифицирован'}[row.effective.basis];
  return `<li class="channels-item" data-channel="${channelsEscape(row.channelId)}">
    <header><h3>${channelsEscape(row.name || row.channelId)}</h3><span class="muted">${channelsEscape(row.channelId)}${row.sourceId ? ' · ' + channelsEscape(row.sourceId) : ' · только XMLTV'}</span>
      <span class="channels-chip channels-chip-${row.effective.policy}">${row.effective.policy} · ${basis}</span>${row.listed ? '' : '<span class="channels-chip">нет в последнем импорте</span>'}</header>
    <div class="muted">Категория провайдера: ${row.category ? channelsEscape(row.category.name) : 'нет'}${row.ownerCategory ? ' · владельца: ' + channelsEscape(row.ownerCategory.name) : ''} · ${presence}</div>
    <div class="channels-edit">
      <label class="limbo-field">Категория владельца<select data-field="category">${categoryOptions}</select></label>
      <label class="limbo-field">Заметка к категории<input type="text" data-field="category-note" maxlength="500" value="${channelsEscape(row.ownerCategoryNote || '')}"></label>
      <button type="button" class="admin-more" data-action="save-category">Сохранить категорию</button>
      <label class="limbo-field">Ручная политика<select data-field="policy">${policies}</select></label>
      <label class="limbo-field">Заметка к политике<input type="text" data-field="policy-note" maxlength="500" value="${channelsEscape(row.overrideNote || '')}"></label>
      <button type="button" class="admin-more" data-action="save-policy">Сохранить политику</button>
    </div></li>`;
}
function channelsRenderItems() {
  const data = channelsState.data;
  channelsEl('#channels-items').innerHTML = channelsState.items.map(channelsItemHtml).join('');
  channelsEl('#channels-count').textContent = data ? `Найдено ${data.page.total}, показано ${channelsState.items.length}.` : '';
  channelsEl('#channels-more').hidden = !data || data.page.next === null;
}

async function channelsLoad({append = false, keep = 0} = {}) {
  const offset = append ? channelsState.items.length : 0;
  const limit = append ? CHANNELS_PAGE_SIZE : Math.min(Math.max(keep, CHANNELS_PAGE_SIZE), 200);
  const result = await getChannels({...channelsFilters(), offset, limit});
  if (!result.ok) {
    channelsRenderActivation(result.body && result.body.activation);
    channelsEl('#channels-status-body').textContent = channelsErrorText(result);
    return false;
  }
  channelsState.data = result.body;
  channelsState.items = append ? channelsState.items.concat(result.body.channels || []) : (result.body.channels || []);
  channelsRenderStatus();
  if (result.body.available) channelsRenderItems();
  return true;
}

async function channelsSave(node, action) {
  if (channelsState.busy) return;
  const li = node.closest('.channels-item');
  const channelId = li.dataset.channel;
  const note = li.querySelector(action === 'save-policy' ? '[data-field=policy-note]' : '[data-field=category-note]').value.trim() || null;
  const fields = {channelId, note, expectedRevision: channelsState.data.revision, requestId: channelsRequestId()};
  channelsState.busy = true;
  node.disabled = true;
  let result;
  if (action === 'save-policy') result = await saveChannelOverride({...fields, policy: li.querySelector('[data-field=policy]').value || null});
  else result = await saveChannelCategory({...fields, categoryKey: li.querySelector('[data-field=category]').value || null});
  channelsState.busy = false;
  node.disabled = false;
  if (!result.ok) {
    channelsMessage(channelsErrorText(result), true);
    if (result.error === 'stale_revision' || result.error === 'readback_failed' || result.error === 'storage_unavailable' || result.error === 'network') await channelsLoad({keep: channelsState.items.length});
    return;
  }
  channelsMessage((result.body.changed ? 'Сохранено' : 'Уже сохранено в таком виде, запись не понадобилась') + `: ревизия ${result.body.revision}. ${channelsSavedClause()}`, false);
  await channelsLoad({keep: channelsState.items.length});
}

// ---- import -------------------------------------------------------------------------------------------------------------------------------------
function channelsStoredPolicy(name) {
  const key = channelsCategoryKey(name);
  const found = (channelsState.data.categories || []).find(c => c.key === key);
  return found ? found.policy : 'known_only';
}
function channelsRenderParsed() {
  const parsed = channelsState.parsed;
  const box = channelsEl('#channels-parsed');
  const preview = channelsEl('#channels-preview');
  preview.hidden = true;
  preview.innerHTML = '';
  if (!parsed) {box.hidden = true; box.innerHTML = ''; return;}
  const blockers = EpgChannelAdmin.importBlockers(parsed);
  const blocking = blockers.length > 0;
  const TEXT = {
    missing_tvg_id: n => `${n} записей #EXTINF без tvg-id`,
    orphan_extinf: n => `${n} записей #EXTINF без строки потока`,
    unsafe_value: n => `${n} записей, где имя или группа похожи на ссылку или секрет`,
    truncated: () => 'файл слишком длинный',
    no_channels: () => 'в файле нет каналов с tvg-id',
    unreadable: () => 'файл не удалось прочитать',
  };
  box.hidden = false;
  box.innerHTML = `<p><b>${parsed.entries.length}</b> каналов, <b>${parsed.groups.length}</b> групп.</p>` +
    (blocking ? `<div class="admin-state admin-state-error" role="alert"><b>Импорт заблокирован: файл неполный или повреждён.</b> Частичный файл нельзя принять за полный: каналы, которых в нём нет, потеряли бы категорию. Исправь файл и выбери его заново.<ul>${blockers.map(b => `<li>${channelsEscape(TEXT[b.code](b.count))}</li>`).join('')}</ul>${parsed.examples.length ? '<p class="muted">Первые строки файла с проблемой: ' + parsed.examples.map(e => e.line).join(', ') + '.</p>' : ''}</div>` : '') +
    (blocking ? '' : `<h3>Политика групп</h3><p class="muted">Новые группы по умолчанию known_only; у известных подставлена сохранённая политика.</p><div class="channels-groups">${parsed.groups.map((g, n) => `<label><span>${channelsEscape(g)}</span><select data-group="${n}">${['known_only', 'discover', 'deny_all'].map(p => `<option value="${p}"${p === channelsStoredPolicy(g) ? ' selected' : ''}>${p}</option>`).join('')}</select></label>`).join('')}</div><button type="button" id="channels-preview-btn" class="admin-refresh">Проверить разницу</button>`);
}
function channelsSubmission() {
  const parsed = channelsState.parsed;
  const groups = parsed.groups.map((name, n) => ({name, policy: channelsEl(`[data-group="${n}"]`).value}));
  return {groups, entries: parsed.entries};
}
function channelsListHtml(title, items, render) {
  if (!items.length) return '';
  return `<h3>${title} (${items.length})</h3><ul>${items.map(render).join('')}</ul>`;
}
function channelsRenderPreview(answer) {
  const p = answer.preview, t = p.totals, it = p.items;
  const box = channelsEl('#channels-preview');
  const idName = x => `${channelsEscape(x.channelId)}${x.name ? ' · ' + channelsEscape(x.name) : ''}`;
  box.hidden = false;
  box.innerHTML = `<div class="channels-diff"><h3>Разница с ревизией ${answer.revision}</h3>` +
    (answer.unchanged ? '<p class="admin-state">Этот набор уже сохранён: запись ничего не изменит.</p>' : '') +
    `<p>Новых ${t.new} · переименованных ${t.renamed} · сменили категорию ${t.changedCategory} · нет в файле ${t.unlisted} · без изменений ${t.unchanged} · итоговая политика изменится у ${t.effectivePolicyChanges} · ручных политик сохранено ${t.overridesKept} · категорий владельца сохранено ${t.ownerCategoriesKept}.</p>` +
    (p.capped ? `<p class="muted">Списки ниже обрезаны до ${p.itemCap} строк на раздел.</p>` : '') +
    channelsListHtml('Новые', it.new, x => `<li>${idName(x)}${x.category ? ' → ' + channelsEscape(x.category) : ''}</li>`) +
    channelsListHtml('Переименованы', it.renamed, x => `<li>${channelsEscape(x.channelId)}: ${channelsEscape(x.from || '—')} → ${channelsEscape(x.to)}</li>`) +
    channelsListHtml('Сменили категорию', it.changedCategory, x => `<li>${idName(x)}: ${channelsEscape(x.from || 'нет')} → ${channelsEscape(x.to || 'нет')}</li>`) +
    channelsListHtml('Нет в файле (не удаляются, категория провайдера снимается)', it.unlisted, x => `<li>${idName(x)}${x.from ? ' (была: ' + channelsEscape(x.from) + ')' : ''}</li>`) +
    channelsListHtml('Конфликты с решениями владельца (решение сохраняется)', it.conflicts, x => `<li>${channelsEscape(x.channelId)}: ${channelsEscape(x.kind)} — ${channelsEscape(x.detail)}</li>`) +
    (p.categories.added.length || p.categories.removed.length || p.categories.policyChanged.length ? `<h3>Категории</h3><ul>${p.categories.added.map(c => `<li>добавлена ${channelsEscape(c.name)} · ${c.policy}</li>`).join('')}${p.categories.policyChanged.map(c => `<li>${channelsEscape(c.name)}: ${c.from} → ${c.to}</li>`).join('')}${p.categories.removed.map(c => `<li>больше не объявлена ${channelsEscape(c.name)}${c.keptForOwner ? ' (остаётся: на неё назначены каналы владельца)' : ''}</li>`).join('')}</ul>` : '') +
    (answer.unchanged ? '' : `<label class="channels-check"><input id="channels-confirm" type="checkbox"> Подтверждаю запись ревизии ${answer.revision + 1}. В EPG это не применяется, ничего не удаляется.</label><button type="button" id="channels-commit-btn" class="admin-refresh" disabled>Записать импорт</button>`) + '</div>';
}

async function channelsFile(file) {
  channelsState.parsed = null; channelsState.preview = null; channelsState.importRequestId = null;
  if (!file) return channelsRenderParsed();
  const text = await file.text();
  channelsState.sourceSha = await channelsSha256(text);
  channelsState.parsed = EpgChannelAdmin.parseM3u(text);
  channelsRenderParsed();
}
async function channelsPreview() {
  if (channelsState.busy) return;
  channelsState.busy = true;
  channelsState.submission = channelsSubmission();
  const result = await previewChannelImport(channelsState.submission);
  channelsState.busy = false;
  if (!result.ok) {channelsMessage(channelsErrorText(result), true); return;}
  channelsMessage('', false);
  channelsState.preview = result.body;
  channelsState.importRequestId = channelsState.importRequestId || channelsRequestId();
  channelsRenderPreview(result.body);
}
async function channelsCommit(button) {
  if (channelsState.busy || !channelsState.preview) return;
  channelsState.busy = true;
  button.disabled = true;
  const result = await commitChannelImport(channelsState.submission, {sourceSha256: channelsState.sourceSha, expectedRevision: channelsState.preview.revision, requestId: channelsState.importRequestId});
  channelsState.busy = false;
  if (!result.ok) {
    channelsMessage(channelsErrorText(result), true);
    button.disabled = false;
    if (result.error === 'stale_revision') {channelsState.preview = null; await channelsLoad({}); channelsRenderParsed();}
    return;
  }
  const r = result.body;
  channelsMessage(`${r.idempotent ? 'Этот набор уже был сохранён' : 'Импорт записан'}: ревизия ${r.revision}, каналов ${r.receipt.channels}, категорий ${r.receipt.categories}. Квитанция ${r.receipt.requestId}. ${channelsSavedClause()}`, false);
  channelsState.parsed = null; channelsState.preview = null; channelsState.importRequestId = null;
  channelsEl('#channels-file').value = '';
  channelsRenderParsed();
  await channelsLoad({});
}

function channelsInit() {
  channelsEl('#channels-filters').addEventListener('submit', event => {event.preventDefault(); channelsLoad({});});
  channelsEl('#channels-more').addEventListener('click', () => channelsLoad({append: true}));
  channelsEl('#channels-items').addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (button) channelsSave(button, button.dataset.action);
  });
  channelsEl('#channels-file').addEventListener('change', event => channelsFile(event.target.files && event.target.files[0]));
  channelsEl('#channels-parsed').addEventListener('click', event => {if (event.target.id === 'channels-preview-btn') channelsPreview();});
  channelsEl('#channels-parsed').addEventListener('change', () => {channelsState.preview = null; channelsEl('#channels-preview').hidden = true;});
  channelsEl('#channels-preview').addEventListener('change', event => {
    if (event.target.id === 'channels-confirm') channelsEl('#channels-commit-btn').disabled = !event.target.checked;
  });
  channelsEl('#channels-preview').addEventListener('click', event => {if (event.target.id === 'channels-commit-btn') channelsCommit(event.target);});
  channelsLoad({});
}
channelsInit();
