// AIR-592 (ADR 0206, decision 9). The human-facing Telegram text of a monitor notification. Pure: no I/O and no clock of its own; the caller
// passes the send time. It reads only what the message already carries (kind, key, stream, critical, typed `metrics` from facts the monitor
// already collected, `firstSeenAt`, the frozen `observedAt` / `endedAt`, the stable `id`) and never parses the English `message`.
// Plain text: no markup mode, so nothing is interpreted. Labels and emoji are fixed constants; every dynamic value is a number, a time or a
// sanitized ASCII code, and the whole text is bounded far below Telegram's 4096 characters. Times are shown in Europe/Madrid and say so;
// the machine id keeps UTC.

export const TIME_ZONE = 'Europe/Madrid';
const MAX_TEXT = 1800, MAX_LINE = 240, DELAY_NOTE_MS = 15 * 60000;
const MIN = 60000, HOUR = 3600000, DAY = 24 * HOUR;

export const KIND = Object.freeze({
  alert: {emoji: '⚠️', label: 'Проблема'},
  alertCritical: {emoji: '🚨', label: 'Сбой'},
  reminder: {emoji: '🔁', label: 'Напоминание'},
  escalation: {emoji: '⛔', label: 'Ухудшение'},
  recovery: {emoji: '✅', label: 'Проблема снята'},
  test: {emoji: '🧪', label: 'Тест'},
});
// The labels of the Events page and the status footer, so one subsystem has one name everywhere.
export const STREAM = Object.freeze({
  epg: 'Программа', discovery: 'Находки', ratings: 'Оценки', predictions: 'Прогнозы', catalog_posters: 'Постеры',
  letterboxd: 'Letterboxd Sync', canonical_producer: 'Обогащение каталога', monitor: 'Монитор',
});
const TITLE = Object.freeze({
  epg_stale: 'Программа не опубликована вовремя', epg_failed: 'Публикация программы завершилась ошибкой',
  epg_authority: 'Источник опубликованной программы удержан или не читается', epg_resource_limit: 'Публикация программы упёрлась в лимит Worker',
  discovery_stalled: 'Очередь Находок стоит', discovery_executor_stalled: 'Исполнитель (Workflow) остановился',
  discovery_generation_mismatch: 'Очередь Находок относится к другой программе', discovery_quarantined: 'Находки в карантине: попытки исчерпаны',
  discovery_resource_limit: 'Находки упёрлись в лимит Worker', discovery_unconfirmed: 'Состояние очереди Находок не подтверждено',
  ratings_stalled: 'Нет завершённого дня (срок + 2 ч)', ratings_quarantined: 'Оценки в карантине', ratings_failed_permanent: 'Оценки: постоянная ошибка',
  ratings_switch_open: 'Переключение режима Оценок не завершилось', ratings_resource_limit: 'Оценки повторно упёрлись в лимит Worker',
  letterboxd_slot_late: 'Слот Letterboxd не запустился вовремя', letterboxd_slot_stalled: 'Слот Letterboxd завис после окна',
  letterboxd_slot_missed: 'Слот Letterboxd пропущен', letterboxd_slots_failed: 'Последний слот Letterboxd не обновил ни один источник',
  letterboxd_quarantined: 'Letterboxd Sync в карантине', letterboxd_watchlist_stale: 'Watchlist давно не сканировался',
  letterboxd_ratings_failed: 'Слот Letterboxd не обновил оценки', letterboxd_watchlist_failed: 'Слот Letterboxd не обновил Watchlist',
  letterboxd_events_backlog: 'События слотов Letterboxd ждут доставки',
  predictions_no_progress: 'Нет подтверждённого прогресса',
  catalog_posters_unknown: 'Состояние недельного повтора постеров не читается', catalog_posters_lost: 'Пропал checkpoint недельного повтора постеров',
  catalog_posters_failed: 'Недельный повтор завершился сбоем', catalog_posters_stalled: 'Недельный повтор постеров завис',
  catalog_posters_overdue: 'Недельный повтор постеров не запустился',
  canonical_producer_no_progress: 'Нет подтверждённого прогресса', canonical_producer_failed: 'Остановлено',
});
// Fixed Russian wording of the diagnostic `detail` codes the policy attaches (the English messages are never parsed).
const DETAIL = Object.freeze({
  no_day_two_hours_after_due: 'ни дня, ни прогресса к 19:00 (срок 17:00)',
  watchlist_never_succeeded: 'ни одного полного скана с запуска',
  watchlist_stale_24h: 'нет полного скана больше 24 ч',
});

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => Number.isInteger(value) && value >= 0 ? value : null;
// A time outside the ECMAScript date range is unknown, like a malformed one: it must never reach Intl (which would throw a RangeError).
const MAX_TIME = 8.64e15;
const stamp = value => { if (typeof value !== 'string' && typeof value !== 'number') return null; const ms = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME ? ms : null; };
// Dynamic text is reduced to printable ASCII (codes and the legacy English detail), so no markup, control or direction character can get in.
export const ascii = (value, max) => String(value ?? '').replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const code = value => typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60) : '';
const line = text => String(text).replace(/[\u0000-\u001F\u007F\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').slice(0, MAX_LINE);

const PARTS = new Map();
function madrid(ms, withSeconds = false) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || Math.abs(ms) > MAX_TIME) return 'неизвестно';
  const key = withSeconds ? 's' : 'm';
  if (!PARTS.has(key)) PARTS.set(key, new Intl.DateTimeFormat('en-GB', {timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', ...(withSeconds ? {second: '2-digit'} : {}), hourCycle: 'h23'}));
  let part;
  try { part = Object.fromEntries(PARTS.get(key).formatToParts(ms).map(item => [item.type, item.value])); } catch { return 'неизвестно'; }
  return part.day + '.' + part.month + ' ' + part.hour + ':' + part.minute + (withSeconds ? ':' + part.second : '');
}
// `floor` rounds down: a lower bound ("не меньше") must never be shown larger than what was measured (19 h 40 min is "не меньше 19 ч", not 20 h).
export function duration(ms, {floor = false} = {}) {
  if (finite(ms) === null || ms < 0) return 'неизвестно';
  if (ms < MIN) return 'меньше минуты';
  const round = floor ? Math.floor : Math.round;
  const minutes = round(ms / MIN);
  if (minutes < 60) return minutes + ' мин';
  if (ms < 10 * HOUR) { const h = Math.floor(minutes / 60), m = minutes % 60; return h + ' ч' + (m ? ' ' + m + ' мин' : ''); }
  if (ms < 2 * DAY) return round(ms / HOUR) + ' ч';
  const hours = round(ms / HOUR);
  return Math.floor(hours / 24) + ' д' + (hours % 24 ? ' ' + (hours % 24) + ' ч' : '');
}

// AIR-592 follow-up (owner's visual review of the first production message): the text is a few short blocks separated by empty lines, one
// `Метка: значение` per line without a pseudo-list, every duration on its own line with its date on the next one, and the stable id in a technical
// footer. Plain text as before: no markup mode, so Telegram shows exactly these lines and wraps only what is longer than the bubble.

// A count with a non-breaking thousands separator (3 078), so a number never wraps inside itself.
const number = value => { const n = count(value); return n === null ? null : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); };

// AIR-596 (ADR 0210): why an open prediction incident is held instead of confirmed or recovered.
const HELD = {queue_unreadable: 'очередь прогнозов не читается', queue_absent: 'очередь прогнозов отсутствует', split_unknown: 'число доступных не читается',
  progress_unknown: 'время прогресса неизвестно', progress_unconfirmed: 'нового прогресса нет'};

// Typed metrics of one issue as `label: value` lines. Unknown or malformed values are left out, never shown as 0.
function stats(key, m) {
  const out = [], add = (label, value) => { if (value !== null && value !== '' && value !== undefined) out.push(label + ': ' + value); };
  if (!m || typeof m !== 'object') return out;
  if (key === 'predictions_no_progress') {
    // AIR-596: a held incident (the verdict cannot be read or confirmed now) shows why, never the last counts as if they were current.
    if (HELD[m.held]) { out.push('Сейчас: ' + HELD[m.held], 'Инцидент остаётся открытым'); return out; }
    add('Доступно', number(m.eligible)); add('В очереди', number(m.pending));
    add('Запусков без фильма (за 2 ч)', number(m.orphanStarts));
    if (m.activeRun === true) out.push('Lease держит запуск, это не прогресс');
    if (m.quota === true) out.push('Последний пакет упёрся в квоту модели');
  } else if (key.startsWith('discovery_')) {
    add('Осталось чанков', number(m.remainingChunks)); add('Исполнитель', code(m.executor));
    // AIR-598: the shared classification's reason, so an unconfirmed state says what was not proven (never shown as a backlog count).
    if (key === 'discovery_unconfirmed') add('Не подтверждено', code(m.queueReason));
  } else if (key === 'epg_stale' || key === 'epg_failed') {
    if (m.runError === true) out.push('Последний запуск записал ошибку');
  } else if (key === 'epg_authority') {
    add('Источник', code(m.authority));
  } else if (key.startsWith('ratings_') || key.startsWith('letterboxd_')) {
    add('Подробно', DETAIL[m.detail] || null); add('Причина', code(m.reason)); add('Слот', code(m.slot)); add('Источник', code(m.outcome)); add('Событий ждёт доставки', number(m.eventsPending));
  } else if (key.startsWith('catalog_posters_')) {
    add('Причина', code(m.detail)); add('Последняя активность', m.freshnessAt ? madrid(stamp(m.freshnessAt)) : null);
    add('Следующая попытка', m.nextExpectedAt ? madrid(stamp(m.nextExpectedAt)) : null);
  } else if (key.startsWith('canonical_producer_')) {
    add('Поколение', code(m.generation)); add('Цепочка', code(m.chain)); add('Проход', code(m.run));
    add('Причина', code(m.stoppedBy));
    if (m.hard === true) out.push('Автоматически не возобновится');
    else if (m.hard === false) out.push('Ожидается автоматический повтор');
  }
  return out;
}

// The domain's own stall at the observation the message describes: the duration on one line, what it is counted from on the next. Each stream says
// what it measures: confirmed progress (predictions), allowed progress and the last finished chunk (Discovery), a reference that may be the
// publication beside the confirmed progress (Producer), the due time (EPG).
// The predictions and Producer stall is always about CONFIRMED progress: a run may be working without having committed anything yet.
const CONFIRMED = '⏱ Прогресс не подтверждён';
const DISCOVERY_STALL = Object.freeze({discovery_stalled: '⏱ Без разрешённого прогресса', discovery_unconfirmed: '⏱ Без подтверждения'});
function stallBlock(key, m, observedMs) {
  if (!m || typeof m !== 'object') return [];
  const idle = finite(m.idleMs), at = value => madrid(stamp(value ?? null));
  if (key === 'epg_stale' || key === 'epg_failed') {
    const out = [];
    if (finite(m.lateMs) !== null) out.push('⏱ Опоздание: ' + duration(m.lateMs));
    if (m.dueAt) out.push('Ожидалась: ' + at(m.dueAt));
    if (m.publishedAt) out.push('Последняя публикация: ' + at(m.publishedAt));
    return out;
  }
  if (key === 'discovery_stalled' || key === 'discovery_unconfirmed') {
    // A known date stays shown even when the duration is unknown (a partial or legacy metric).
    const span = finite(m.stalledMs);
    if (span === null && !m.allowedAt && !m.lastChunkAt) return [];
    return [DISCOVERY_STALL[key] + ': ' + (span === null ? 'неизвестно' : duration(span)), ...(m.allowedAt ? ['Шаг разрешён с: ' + at(m.allowedAt)] : []), 'Последний чанк: ' + at(m.lastChunkAt)];
  }
  if (key === 'discovery_executor_stalled') {
    // Only a finished chunk is progress here; the continuation record's own update time is not.
    const chunk = stamp(m.lastChunkAt ?? null);
    return [...(chunk !== null && observedMs !== null && observedMs >= chunk ? ['⏱ Без нового чанка: ' + duration(observedMs - chunk)] : []), 'Последний чанк: ' + madrid(chunk)];
  }
  if (key === 'canonical_producer_no_progress') {
    // `sinceAt` is the reference of the window (it may be the publication or the first observation); only `progressAt` is confirmed progress.
    if (idle === null && !m.sinceAt && !m.progressAt) return [];
    return [CONFIRMED + ': ' + (idle === null ? 'неизвестно' : duration(idle)), ...(m.sinceAt ? ['Отсчёт с: ' + at(m.sinceAt)] : []), 'Последний прогресс: ' + (m.progressAt ? at(m.progressAt) : 'не было в этом окне')];
  }
  if (idle === null && !m.lastProgressAt) return [];
  return [CONFIRMED + ': ' + (idle === null ? 'неизвестно' : duration(idle)), 'Последний прогресс: ' + (m.lastProgressAt ? at(m.lastProgressAt) : 'неизвестно')];
}
// A recovery (and a held reminder) only knows the last measured stall, at the last observation that still showed the issue: a proven lower bound
// (rounded down), never the gap up to the tick that noticed the change. It never claims that no progress at all happened since then.
function lastStallBlock(key, m, metricsAt) {
  if (!m || typeof m !== 'object') return [];
  const when = stamp(metricsAt ?? null);
  const span = DISCOVERY_STALL[key] ? finite(m.stalledMs) : finite(m.idleMs);
  if (span === null || when === null) return [];
  return [DISCOVERY_STALL[key] || CONFIRMED, 'Не меньше: ' + duration(span, {floor: true}), 'Последнее наблюдение: ' + madrid(when)];
}
// AIR-598: a Discovery recovery says why it recovered, from the shared queue classification of the tick that recovered it. A queue proven empty is not new progress.
function discoveryRecoveryBlock(reason) {
  if (reason === 'queue_empty') return ['Причина: очередь пуста, это доказано записями той же программы', 'Это не новый прогресс'];
  if (reason === 'epg_priority') return ['Причина: пауза на время обновления программы', 'Это не новый прогресс'];
  return [];
}
// AIR-596 (ADR 0210): a prediction recovery says why it recovered; confirmed progress and an absence of eligible work never read alike.
function recoveryBlock(reason, progressAt) {
  if (reason === 'progress') { const at = stamp(progressAt ?? null); return ['Причина: прогресс снова подтверждён', ...(at !== null ? ['Последний прогресс: ' + madrid(at)] : [])]; }
  if (reason === 'no_eligible_work') return ['Причина: нечего прогнозировать', 'Очередь пуста или повторы исчерпаны', 'Это не подтверждённый прогресс'];
  if (reason === 'retry_wait') return ['Причина: все фильмы ждут повторной попытки', 'Это не подтверждённый прогресс'];
  return [];
}
const OVERALL_LINE = Object.freeze({healthy: 'всё в порядке', waiting: 'ожидание по расписанию', delayed: 'есть задержки', degraded: 'есть проблемы'});

export function telegramText(message, {overall = null, now = null} = {}) {
  const kind = typeof message?.kind === 'string' ? message.kind : 'alert';
  const key = code(message?.key) || 'unknown';
  const streamName = code(message?.stream);
  const critical = message?.critical === true || message?.severity === 'needs_owner';
  const recovered = kind === 'recovery';
  const look = kind === 'alert' && critical ? KIND.alertCritical : KIND[kind] || {emoji: 'ℹ️', label: 'Сообщение'};
  // A recovery stored before ADR 0206 names its stream by the key prefix (`canonical`, `catalog`): the issue key still identifies the real stream.
  const streamKey = STREAM[streamName] ? streamName : Object.keys(STREAM).find(name => streamName && name.startsWith(streamName + '_') && key.startsWith(name + '_')) || streamName;
  const head = [look.emoji + ' ' + look.label + ' · ' + (STREAM[streamKey] || streamKey || 'Монитор')];
  const blocks = [head];
  const nowMs = finite(now);
  let delayed = null;
  if (kind === 'test') {
    head.push('Проверочное сообщение, инцидента нет');
  } else {
    head.push(TITLE[key] || 'Проблема ' + key);
    if (recovered) head.push('Больше не наблюдается' + (message?.wasCritical === true ? ' · была критичной' : ''));
    else head.push(critical ? '🔴 Критичный сбой' : '🟠 Подтверждённая деградация');
    // A recovery does not repeat the counts of the last alert: they describe a moment that is over and would read as current.
    const statLines = recovered ? [] : stats(key, message?.metrics);
    // Frozen times: an alert-type message describes the tick that planned it (`observedAt`, else its queue time); a recovery ends when it was detected.
    const observed = stamp(message?.observedAt ?? message?.queuedAt ?? null);
    const ended = recovered ? stamp(message?.endedAt ?? message?.queuedAt ?? null) : null;
    const opened = stamp(message?.firstSeenAt ?? null);
    // A held prediction incident has no current measurement: its stall is the last one measured, under its own time, as for a recovery.
    const heldNow = !recovered && key === 'predictions_no_progress' && !!HELD[message?.metrics?.held];
    const stall = recovered || heldNow ? lastStallBlock(key, message?.metrics, message?.metricsAt) : stallBlock(key, message?.metrics, observed);
    const why = !recovered ? [] : key === 'predictions_no_progress' ? recoveryBlock(message?.recoveryReason, message?.recoveryProgressAt) : DISCOVERY_STALL[key] ? discoveryRecoveryBlock(message?.recoveryReason) : [];
    if (why.length) blocks.push(why);
    // Without typed metrics (a message written before ADR 0206 decision 9) the stored detail is the only diagnosis: bounded ASCII.
    if (!statLines.length && !stall.length && message?.message && !/^Recovered$/.test(String(message.message))) statLines.push('Детали: ' + ascii(message.message, 200));
    if (statLines.length) blocks.push(statLines);
    if (stall.length) blocks.push(stall);
    // The monitor's own observation of the issue, separate from the domain stall above.
    const end = recovered ? ended : observed;
    blocks.push(['🕒 Инцидент: ' + (opened !== null && end !== null && end >= opened ? duration(end - opened) : 'неизвестно'), 'Открыт: ' + madrid(opened), ...(recovered ? ['Снят: ' + madrid(ended)] : [])]);
    if (nowMs !== null && end !== null && nowMs - end > DELAY_NOTE_MS) delayed = end;
    const level = overall === 'needs_owner' ? 'degraded' : overall;
    // A recovery is about one issue: while the site is still degraded it says so instead of implying that everything is healthy.
    blocks.push(['🌐 ' + (recovered && level === 'degraded' ? 'Остаются другие проблемы' : 'В целом: ' + (OVERALL_LINE[level] || 'неизвестно'))]);
  }
  // Technical footer: a late-send note (the body is built before the Bot API answers, so it says sent, not delivered), the send time in Madrid, the full id.
  const footer = [...(delayed !== null ? ['📨 Отправлено с задержкой', 'Обнаружено: ' + madrid(delayed)] : []), madrid(nowMs, true) + ' · Мадрид'];
  const ref = line('Ref: ' + ascii(message?.id, 200));
  const body = [...blocks, footer].map(block => block.map(line).join('\n')).join('\n\n');
  // The bound never cuts the Ref line: the stable id stays the last line whatever the body holds.
  return (body.length + 1 + ref.length <= MAX_TEXT ? body : body.slice(0, MAX_TEXT - ref.length - 2) + '…') + '\n' + ref;
}
