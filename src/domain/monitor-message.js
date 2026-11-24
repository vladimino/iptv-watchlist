// AIR-592 (ADR 0206, decision 6). The human-facing Telegram text of a monitor notification. Pure: no I/O and no clock of its own; the caller
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
  recovery: {emoji: '✅', label: 'Восстановлено'},
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
  discovery_stalled: 'Находки стоят: очередь без разрешённого прогресса', discovery_executor_stalled: 'Исполнитель Находок (Workflow) остановился',
  discovery_generation_mismatch: 'Очередь Находок относится к другой программе', discovery_quarantined: 'Находки в карантине: попытки исчерпаны',
  discovery_resource_limit: 'Находки упёрлись в лимит Worker',
  ratings_stalled: 'Оценки не обновились за день', ratings_quarantined: 'Оценки в карантине', ratings_failed_permanent: 'Оценки: постоянная ошибка',
  ratings_switch_open: 'Переключение режима Оценок не завершилось', ratings_resource_limit: 'Оценки повторно упёрлись в лимит Worker',
  letterboxd_slot_late: 'Слот Letterboxd не запустился вовремя', letterboxd_slot_stalled: 'Слот Letterboxd завис после окна',
  letterboxd_slot_missed: 'Слот Letterboxd пропущен', letterboxd_slots_failed: 'Последний слот Letterboxd не обновил ни один источник',
  letterboxd_quarantined: 'Letterboxd Sync в карантине', letterboxd_watchlist_stale: 'Watchlist давно не сканировался полностью',
  letterboxd_ratings_failed: 'Слот Letterboxd не обновил оценки', letterboxd_watchlist_failed: 'Слот Letterboxd не обновил Watchlist',
  letterboxd_events_backlog: 'События слотов Letterboxd ждут доставки',
  predictions_no_progress: 'Нет подтверждённого прогресса прогнозов',
  catalog_posters_unknown: 'Состояние недельного повтора постеров не читается', catalog_posters_lost: 'Пропал checkpoint недельного повтора постеров',
  catalog_posters_failed: 'Недельный повтор постеров завершился сбоем', catalog_posters_stalled: 'Недельный повтор постеров завис',
  catalog_posters_overdue: 'Недельный повтор постеров не запустился',
  canonical_producer_no_progress: 'Нет подтверждённого прогресса обогащения каталога', canonical_producer_failed: 'Обогащение каталога остановлено',
});
const OVERALL = Object.freeze({healthy: '✅ всё в порядке', waiting: '⏳ ожидание по расписанию', delayed: '🕓 есть задержки', degraded: '⚠️ есть проблемы'});

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => Number.isInteger(value) && value >= 0 ? value : null;
const stamp = value => { if (typeof value !== 'string' && typeof value !== 'number') return null; const ms = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(ms) ? ms : null; };
// Dynamic text is reduced to printable ASCII (codes and the legacy English detail), so no markup, control or direction character can get in.
export const ascii = (value, max) => String(value ?? '').replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const code = value => typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60) : '';
const line = text => String(text).replace(/[\u0000-\u001F\u007F\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').slice(0, MAX_LINE);

const PARTS = new Map();
function madrid(ms, withSeconds = false) {
  if (ms === null) return 'неизвестно';
  const key = withSeconds ? 's' : 'm';
  if (!PARTS.has(key)) PARTS.set(key, new Intl.DateTimeFormat('en-GB', {timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', ...(withSeconds ? {second: '2-digit'} : {}), hourCycle: 'h23'}));
  const part = Object.fromEntries(PARTS.get(key).formatToParts(ms).map(item => [item.type, item.value]));
  return part.day + '.' + part.month + ' ' + part.hour + ':' + part.minute + (withSeconds ? ':' + part.second : '');
}
export function duration(ms) {
  if (finite(ms) === null || ms < 0) return 'неизвестно';
  if (ms < MIN) return 'меньше минуты';
  const minutes = Math.round(ms / MIN);
  if (minutes < 60) return minutes + ' мин';
  if (ms < 10 * HOUR) { const h = Math.floor(minutes / 60), m = minutes % 60; return h + ' ч' + (m ? ' ' + m + ' мин' : ''); }
  if (ms < 2 * DAY) return Math.round(ms / HOUR) + ' ч';
  const hours = Math.round(ms / HOUR);
  return Math.floor(hours / 24) + ' д' + (hours % 24 ? ' ' + (hours % 24) + ' ч' : '');
}

// Typed metrics of one issue as compact statistic lines. Unknown or malformed values are left out, never shown as 0.
function stats(key, m) {
  const out = [], add = (label, value) => { if (value !== null && value !== '' && value !== undefined) out.push('• ' + label + ': ' + value); };
  if (!m || typeof m !== 'object') return out;
  if (key === 'predictions_no_progress') {
    add('Доступно к прогнозу сейчас', count(m.eligible)); add('В очереди всего', count(m.pending));
    add('Запусков без фильма с последнего прогресса', count(m.orphanStarts));
    if (m.quota === true) out.push('• Последний пакет упёрся в квоту модели');
  } else if (key.startsWith('discovery_')) {
    add('Осталось чанков', count(m.remainingChunks)); add('Исполнитель', code(m.executor));
  } else if (key === 'epg_stale' || key === 'epg_failed') {
    add('Ожидалась к', m.dueAt ? madrid(stamp(m.dueAt)) : null); add('Последняя публикация', m.publishedAt ? madrid(stamp(m.publishedAt)) : null);
    if (m.runError === true) out.push('• Последний запуск записал ошибку');
  } else if (key === 'epg_authority') {
    add('Состояние источника', code(m.authority));
  } else if (key.startsWith('ratings_') || key.startsWith('letterboxd_')) {
    add('Причина', code(m.reason)); add('Слот', code(m.slot)); add('Источник', code(m.outcome)); add('Событий ждёт доставки', count(m.eventsPending));
  } else if (key.startsWith('catalog_posters_')) {
    add('Причина', code(m.detail)); add('Последняя активность', m.freshnessAt ? madrid(stamp(m.freshnessAt)) : null);
    add('Следующая попытка', m.nextExpectedAt ? madrid(stamp(m.nextExpectedAt)) : null);
  } else if (key.startsWith('canonical_producer_')) {
    add('Поколение', code(m.generation)); add('Цепочка', code(m.chain)); add('Проход', code(m.run));
    add('Причина остановки', code(m.stoppedBy));
    if (m.hard === true) out.push('• Автоматически не возобновится');
    else if (m.hard === false) out.push('• Ожидается автоматический повтор');
  }
  return out;
}

// The domain's own no-progress period, when the facts carry it: its onset (last confirmed progress) and its length at the observation.
function idleLine(m, recovered, endMs, observedMs) {
  if (!m || typeof m !== 'object') return null;
  const onset = stamp(m.lastProgressAt ?? m.sinceAt ?? null), idle = finite(m.idleMs);
  if (recovered) {
    if (onset !== null && endMs !== null && endMs >= onset) return '⏱ Без прогресса было: ' + duration(endMs - onset) + ' (с ' + madrid(onset) + ')';
    if (idle !== null) return '⏱ Без прогресса было: не меньше ' + duration(idle);
    return null;
  }
  if (idle === null && onset === null) return null;
  // Without a measured idle the period runs from the known onset to the observation the message describes.
  const span = idle !== null ? idle : onset !== null && observedMs !== null && observedMs >= onset ? observedMs - onset : null;
  return '⏱ Без прогресса: ' + (span !== null ? duration(span) : 'неизвестно') + (onset !== null ? ' (последний подтверждённый прогресс ' + madrid(onset) + ')' : ' (время последнего прогресса неизвестно)');
}
function lateLine(key, m) {
  if ((key === 'epg_stale' || key === 'epg_failed') && finite(m?.lateMs) !== null) return '⏱ Опоздание: ' + duration(m.lateMs);
  return null;
}

export function telegramText(message, {overall = null, now = null} = {}) {
  const kind = typeof message?.kind === 'string' ? message.kind : 'alert';
  const key = code(message?.key) || 'unknown';
  const streamName = code(message?.stream);
  const critical = message?.critical === true || message?.severity === 'needs_owner';
  const recovered = kind === 'recovery';
  const look = kind === 'alert' && critical ? KIND.alertCritical : KIND[kind] || {emoji: 'ℹ️', label: 'Сообщение'};
  const lines = [look.emoji + ' ' + look.label + ' · ' + (STREAM[streamName] || streamName || 'Монитор')];
  if (kind === 'test') {
    lines.push('Проверочное сообщение монитора. Инцидента нет.');
  } else {
    const title = TITLE[key];
    lines.push(recovered ? 'Решено: ' + (title || 'проблема ' + key) : title || 'Проблема ' + key);
    if (!recovered) lines.push(critical ? 'Серьёзность: 🔴 критично (доказанный сбой, без ожидания подтверждения)' : 'Серьёзность: 🟠 деградация (подтверждена)');
    else if (message?.wasCritical === true) lines.push('Была критичной');
    // A recovery does not repeat the counts of the last alert: they describe a moment that is over and would read as current.
    const statLines = recovered ? [] : stats(key, message?.metrics);
    lines.push(...statLines);
    // Frozen times: an alert-type message describes the tick that planned it (`observedAt`, else its queue time); a recovery ends when it was detected.
    const observed = stamp(message?.observedAt ?? message?.queuedAt ?? null);
    const ended = recovered ? stamp(message?.endedAt ?? message?.queuedAt ?? null) : null;
    const opened = stamp(message?.firstSeenAt ?? null);
    const late = lateLine(key, message?.metrics); if (late && !recovered) lines.push(late);
    const idle = idleLine(message?.metrics, recovered, ended, observed); if (idle) lines.push(idle);
    if (recovered) {
      lines.push('🕒 Длительность инцидента: ' + (opened !== null && ended !== null && ended >= opened ? duration(ended - opened) + ' (' + madrid(opened) + ' → ' + madrid(ended) + ')' : 'неизвестно'));
    } else {
      lines.push('🕒 Инцидент открыт: ' + (opened !== null ? madrid(opened) + (observed !== null && observed >= opened ? ' · идёт ' + duration(observed - opened) : '') : 'неизвестно'));
    }
    if (!statLines.length && !idle && !late && message?.message && !/^Recovered$/.test(String(message.message))) lines.push('Детали: ' + ascii(message.message, 200));
    const nowMs = finite(now), at = recovered ? ended : observed;
    if (nowMs !== null && at !== null && nowMs - at > DELAY_NOTE_MS) lines.push('📨 Отправлено с задержкой: обнаружено ' + madrid(at) + ', отправлено ' + madrid(nowMs));
  }
  const level = overall === 'needs_owner' ? 'degraded' : overall, state = OVERALL[level];
  // A recovery is about one issue: while the site is still degraded it says so instead of implying that everything is healthy.
  if (kind !== 'test') lines.push('🌐 ' + (recovered ? 'В целом сейчас: ' + (level === 'degraded' ? '⚠️ остаются другие проблемы (восстановлена только эта)' : state || 'неизвестно') : 'В целом: ' + (state || 'неизвестно')));
  lines.push('Время: ' + madrid(finite(now), true) + ' · Мадрид (Europe/Madrid)');
  const ref = line('Ref: ' + ascii(message?.id, 120));
  const body = lines.map(line).join('\n');
  // The bound never cuts the Ref line: the stable id stays the last line whatever the body holds.
  return (body.length + 1 + ref.length <= MAX_TEXT ? body : body.slice(0, MAX_TEXT - ref.length - 2) + '…') + '\n' + ref;
}
