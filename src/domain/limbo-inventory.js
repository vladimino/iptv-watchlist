// Limbo inventory: the per-subject view of a data health evaluation. It takes the issues the health model produced
// for films and unresolved observations, names the cause each subject is waiting on, keeps the model's order, and
// filters and pages the list deterministically. No I/O, no clock: the evaluation already carries `now`, and every
// page of one evaluation is cut from the same list. Nothing here retries, resets or writes; `action` is a statement
// about the subject, not a button.

export const LIMBO_INVENTORY_VERSION = 1;
export const LIMBO_KINDS = ['film', 'observation'];
export const LIMBO_SUBSYSTEMS = ['identity', 'metadata', 'localization', 'fingerprint', 'prediction'];
export const LIMBO_CAUSES = ['retry_eligible', 'stalled', 'backoff', 'pending', 'manual_review', 'stale_projection', 'external_archive', 'unknown'];
export const LIMBO_CONTEXT_KINDS = ['generation', 'queue', 'continuation', 'catalog', 'archive'];
export const LIMBO_LIMIT_MAX = 25;
export const LIMBO_AGE_MAX_DAYS = 365;

const LIMBO_DAY = 86400000;
const LIMBO_RETRY_CODES = ['discovery_retry', 'metadata_refresh', 'prediction_retry'];

function limboObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function limboText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'en');
}

// The cause a subject is waiting on, decided in this order so that one issue has one cause.
export function limboCause(issue) {
  const action = issue?.action || {};
  const progress = issue?.progress || {};
  const evidence = issue?.evidence || {};
  const anomalies = Array.isArray(evidence.anomalies) ? evidence.anomalies : [];
  if (action.reason === 'generation_changed' || issue?.reason === 'projection_generation_differs' || anomalies.includes('projection_generation_differs')) return 'stale_projection';
  if (issue?.category === 'external_refresh') return 'external_archive';
  if (issue?.category === 'conflict' || progress.status === 'terminal') return 'manual_review';
  if (evidence.completeness === 'missing' || action.eligible === null || progress.status === 'unknown') return 'unknown';
  if (progress.status === 'due' || progress.status === 'overdue') return 'retry_eligible';
  if (progress.status === 'stalled') return 'stalled';
  if (progress.status === 'waiting') return 'backoff';
  if (action.suggested === 'bounded_action' && action.eligible === true && LIMBO_RETRY_CODES.includes(action.code)) return 'retry_eligible';
  if (progress.status === 'progressing' || progress.status === 'not_applicable') return 'pending';
  return 'unknown';
}

function limboTitle(record) {
  if (!record) return null;
  return record.preferred || record.originalTitle || record.epgTitle || null;
}

function limboIdentity(record) {
  if (!record) return null;
  const externalIds = Array.isArray(record.externalIds) ? record.externalIds : [];
  return {
    status: record.identity?.status ?? null,
    canonicalIdentity: record.canonicalIdentity ?? null,
    trustedExternalIds: externalIds.filter(item => item?.trusted === true && item.conflicting !== true).map(item => `${item.scheme ?? 'id'}:${item.value}`).sort(limboText),
    conflicting: externalIds.some(item => item?.conflicting === true),
  };
}

function limboAge(issue) {
  const progress = issue.progress || {};
  const freshness = issue.freshness || {};
  if (typeof progress.sinceProgressMs === 'number') return {ms: progress.sinceProgressMs, days: Math.floor(progress.sinceProgressMs / LIMBO_DAY), lastProgressAt: issue.lastProgressAt ?? null, basis: 'progress'};
  if (typeof freshness.ageMs === 'number') return {ms: freshness.ageMs, days: Math.floor(freshness.ageMs / LIMBO_DAY), lastProgressAt: issue.lastProgressAt ?? null, basis: 'freshness'};
  return {ms: null, days: null, lastProgressAt: issue.lastProgressAt ?? null, basis: null};
}

const LIMBO_DIAGNOSTIC_KEYS = ['status', 'nextAction', 'failureReason', 'retryScope', 'lastRunId', 'queued', 'terminalReason', 'queueRefreshedAt'];

function limboDiagnostics(issue) {
  const provenance = limboObject(issue.provenance) ? issue.provenance : {};
  const picked = {};
  for (const key of LIMBO_DIAGNOSTIC_KEYS) if (provenance[key] !== undefined) picked[key] = provenance[key];
  picked.attempts = issue.progress?.attempts ?? null;
  picked.rule = provenance.rule ?? null;
  return picked;
}

function limboLinks(kind, record) {
  if (kind === 'film' && record?.id) return {film: '/admin?kind=film&id=' + encodeURIComponent(record.id), identityReview: null};
  return {film: null, identityReview: null};
}

// One item per film or observation issue of the inventory subsystems, in the order of the health result. `context.films`
// maps a record id to the Film record the evaluation saw, so an item can name the film and link to it.
export function limboItems(health, context) {
  const issues = Array.isArray(health?.issues) ? health.issues : [];
  const films = context?.films instanceof Map ? context.films : new Map((Array.isArray(context?.films) ? context.films : []).filter(record => record && typeof record.id === 'string').map(record => [record.id, record]));
  const items = [];
  for (const issue of issues) {
    const kind = issue?.subject?.kind;
    if (!LIMBO_KINDS.includes(kind) || !LIMBO_SUBSYSTEMS.includes(issue.subsystem)) continue;
    const record = kind === 'film' ? films.get(issue.subject.id) || null : null;
    const progress = issue.progress || {};
    items.push({
      id: issue.id,
      kind,
      subjectId: issue.subject.id,
      subsystem: issue.subsystem,
      cause: limboCause(issue),
      category: issue.category,
      severity: issue.severity,
      reason: issue.reason,
      film: kind === 'film' ? {id: record?.id ?? issue.subject.id, storedId: record?.storedId ?? null, title: limboTitle(record), year: record?.year ?? null, inProgramme: Boolean(record && record.storedId && record.inProgramme !== false), identity: limboIdentity(record)} : null,
      age: limboAge(issue),
      progress: {status: progress.status ?? 'not_applicable', reason: progress.reason ?? null, retryAt: progress.retryAt ?? null, attempts: progress.attempts ?? null, thresholdMs: progress.thresholdMs ?? null, overdueMs: progress.overdueMs ?? null},
      freshness: issue.freshness ?? null,
      action: issue.action,
      evidence: {...(issue.evidence || {}), observedAt: issue.observedAt ?? null},
      threshold: issue.threshold ?? null,
      diagnostics: limboDiagnostics(issue),
      affected: issue.affected ?? null,
      links: limboLinks(kind, record),
    });
  }
  return items;
}

// Pipeline context beside the items: the whole-object issues of the same evaluation (the published generation, the
// prediction queue and whatever else the caller read) and the subsystems the caller did not read at all.
export function limboContext(health) {
  const issues = (Array.isArray(health?.issues) ? health.issues : []).filter(issue => LIMBO_CONTEXT_KINDS.includes(issue?.subject?.kind));
  const unread = Object.entries(health?.subsystems || {}).filter(([, entry]) => entry?.evidence !== 'observed').map(([name, entry]) => ({subsystem: name, evidence: entry.evidence})).sort((left, right) => limboText(left.subsystem, right.subsystem));
  return {issues, unread};
}

export function limboCounts(items) {
  const counts = {
    total: items.length,
    byCause: Object.fromEntries(LIMBO_CAUSES.map(value => [value, 0])),
    bySubsystem: Object.fromEntries(LIMBO_SUBSYSTEMS.map(value => [value, 0])),
    byKind: Object.fromEntries(LIMBO_KINDS.map(value => [value, 0])),
  };
  for (const item of items) {
    counts.byCause[item.cause]++;
    counts.bySubsystem[item.subsystem]++;
    counts.byKind[item.kind]++;
  }
  return counts;
}

// The filter is validated before it is applied: an unknown value is an error, never "everything". An age filter keeps
// items whose age is at least that many days and items whose age is unknown: a missing clock never proves youth.
export function limboFilter(filter) {
  const kind = filter?.kind ?? null, subsystem = filter?.subsystem ?? null, cause = filter?.cause ?? null, minAgeDays = filter?.minAgeDays ?? null;
  if (kind !== null && !LIMBO_KINDS.includes(kind)) return {error: 'unknown_kind'};
  if (subsystem !== null && !LIMBO_SUBSYSTEMS.includes(subsystem)) return {error: 'unknown_subsystem'};
  if (cause !== null && !LIMBO_CAUSES.includes(cause)) return {error: 'unknown_cause'};
  if (minAgeDays !== null && (!Number.isInteger(minAgeDays) || minAgeDays < 0 || minAgeDays > LIMBO_AGE_MAX_DAYS)) return {error: 'invalid_age'};
  return {kind, subsystem, cause, minAgeDays, key: [kind ?? '', subsystem ?? '', cause ?? '', minAgeDays ?? ''].join('|')};
}

export function filterLimboItems(items, filter) {
  const parsed = limboFilter(filter);
  if (parsed.error) return parsed;
  const kept = items.filter(item =>
    (parsed.kind === null || item.kind === parsed.kind)
    && (parsed.subsystem === null || item.subsystem === parsed.subsystem)
    && (parsed.cause === null || item.cause === parsed.cause)
    && (parsed.minAgeDays === null || item.age.ms === null || item.age.ms >= parsed.minAgeDays * LIMBO_DAY));
  return {items: kept, key: parsed.key};
}

function limboEncode(payload) {
  const binary = Array.from(new TextEncoder().encode(JSON.stringify(payload)), byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function limboDecode(cursor) {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const padded = cursor.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - cursor.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (payload?.v !== 1 || typeof payload.key !== 'string' || typeof payload.id !== 'string' || !Number.isInteger(payload.index) || payload.index < 0 || !Number.isInteger(payload.limit) || !Number.isInteger(payload.total)) return null;
    return payload;
  } catch {
    return null;
  }
}

// One page of an already filtered list. `limit` is required, an integer from 1 to 25. The cursor binds the filter key,
// the limit, the list length and the id at its position, so a cursor from another filter, another limit or another
// evaluation is `stale_cursor`, not a page from the wrong place.
export function pageLimboItems(items, options) {
  if (!Array.isArray(items)) return {error: 'invalid_items'};
  const limit = options?.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMBO_LIMIT_MAX) return {error: 'invalid_limit'};
  const key = typeof options?.key === 'string' ? options.key : '';
  let start = 0;
  if (options?.cursor !== undefined && options.cursor !== null) {
    const payload = limboDecode(options.cursor);
    if (!payload || payload.key !== key || payload.limit !== limit || payload.total !== items.length || items[payload.index]?.id !== payload.id) return {error: 'stale_cursor'};
    start = payload.index + 1;
  }
  const slice = items.slice(start, start + limit);
  const last = start + slice.length - 1;
  const next = items[last + 1];
  return {items: slice, total: items.length, nextCursor: next ? limboEncode({v: 1, key, limit, total: items.length, index: last, id: items[last].id}) : null};
}
