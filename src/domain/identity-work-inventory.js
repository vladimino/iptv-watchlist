// Identity work inventory (AIR-527, ADR 0170): the pure part of GET /api/admin/identity-work. No I/O, no clock (`nowMs` is passed).
// Three typed lanes over the current owners, source-specific status, a fixed disposition table, trusted Film links only by proof,
// untrusted hints only between rows present in the same response, and lane-sequential cursors with at most one candidate archive per page.
// Nothing here retries, resets, merges or writes; `disposition` is a read-side label, not an action.

export const IDENTITY_WORK_VERSION = 1;
// AIR-599 / ADR 0207 decision 4b: `diary_identity` lists the shared Diary check entries and the backlog (an in-memory lane, paged by index like `film`).
export const IDENTITY_LANES = ['film', 'epg_observation', 'watchlist_admission', 'diary_identity', 'letterboxd_rated_candidate'];
export const IDENTITY_DISPOSITIONS = ['retryable', 'blocked', 'needs_owner_review', 'waiting', 'resolved'];
export const IDENTITY_LIMIT_MAX = 25;
export const IDENTITY_LIMIT_DEFAULT = 25;
export const IDENTITY_DOC_MAX_BYTES = 2 * 1024 * 1024;
export const IDENTITY_LIST_MAX = 1000;
export const IDENTITY_QUERY_MAX = 100;
const HEX64 = /^[0-9a-f]{64}$/;
const MOVIE_ID = /^[1-9]\d{0,11}$/;

const text = (left, right) => String(left ?? '').localeCompare(String(right ?? ''), 'en');
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The query is validated before it is applied: an unknown value is an error, never "everything".
export function identityWorkQuery(params) {
  const get = name => (params.has(name) ? params.get(name) : null);
  const type = get('type');
  if (type !== null && !IDENTITY_LANES.includes(type)) return {error: 'unknown_type'};
  const disposition = get('disposition');
  if (disposition !== null && !IDENTITY_DISPOSITIONS.includes(disposition)) return {error: 'unknown_disposition'};
  const include = get('include');
  if (include !== null && include !== 'resolved') return {error: 'unknown_include'};
  const archive = get('archive');
  if (archive !== null && !HEX64.test(archive)) return {error: 'invalid_archive'};
  const q = get('q');
  if (q !== null && (q.length === 0 || q.length > IDENTITY_QUERY_MAX)) return {error: 'invalid_query'};
  let limit = IDENTITY_LIMIT_DEFAULT;
  if (params.has('limit')) {
    const raw = params.get('limit');
    if (!/^(?:[1-9]|1\d|2[0-5])$/.test(raw)) return {error: 'invalid_limit'};
    limit = Number(raw);
  }
  const includeResolved = include === 'resolved' || disposition === 'resolved';
  const needle = q === null ? null : q.normalize('NFKC').toLowerCase();
  // The key binds a cursor to one filter. Lane order and limit are bound separately by the cursor.
  const key = [type ?? '', disposition ?? '', includeResolved ? 'r' : '', archive ?? '', needle ?? ''].join('|');
  return {type, disposition, includeResolved, archive, q: needle, limit, key};
}

export function laneEnabled(query, lane) {
  return query.type === null || query.type === lane;
}

// A fixed table per lane, derived from the source state. It starts nothing.
const CAUSE_DISPOSITION = {retry_eligible: 'retryable', stalled: 'blocked', stale_projection: 'blocked', manual_review: 'needs_owner_review', backoff: 'waiting', pending: 'waiting', external_archive: 'waiting', unknown: 'waiting'};
export const causeDisposition = cause => CAUSE_DISPOSITION[cause] || 'waiting';

// Candidate: `confirmed` is true only for a D1 admission matching archive and short code with a typed movie id, false when D1 was
// read and holds none, null when it could not be read. A stopped checkpoint blocks work that has not finished.
export function candidateDisposition(item, {confirmed, stopped, retryable}) {
  const state = item?.state;
  if (state === 'removed') return {disposition: 'resolved', reason: item.reason ?? null};
  if (state === 'verified') {
    if (confirmed === true) return {disposition: 'resolved', reason: item.reason ?? null};
    if (confirmed === false) return {disposition: 'needs_owner_review', reason: 'admission_unconfirmed'};
    return {disposition: 'waiting', reason: 'admission_unreadable'};
  }
  if (state === 'needs_review') return {disposition: retryable === true ? 'retryable' : 'needs_owner_review', reason: item.reason ?? null};
  if (state === 'pending' || state === 'admitting') return {disposition: stopped ? 'blocked' : 'waiting', reason: stopped ? String(stopped.code || stopped.reason || stopped) : (item.reason ?? null)};
  return {disposition: 'waiting', reason: item?.reason ?? 'unknown_state'};
}

export const normalizeTitle = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// A trusted Film link is a D1 admission row matching BOTH archive and short code with a typed movie id. Nothing else.
export function admissionProof(rows, sha, code) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && row.archive_sha256 === sha && row.source_code === code && MOVIE_ID.test(String(row.tmdb)) && typeof row.film_id === 'string' && row.film_id) {
      return {filmId: row.film_id, proof: 'film_rated_admission', tmdb: String(row.tmdb)};
    }
  }
  return null;
}

const ageOf = (nowMs, iso) => {
  const at = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.max(0, nowMs - at) : null;
};

// One row per candidate of one archive document. `admissions` is the array of D1 rows read for that archive, or null when unreadable.
export function candidateRows(doc, sha, {nowMs, admissions, isRetryable}) {
  const stopped = doc?.checkpoint?.stopped || null;
  const rows = [];
  for (const code of Object.keys(object(doc?.candidates) ? doc.candidates : {}).sort(text)) {
    const item = doc.candidates[code];
    if (!object(item)) continue;
    const link = admissions === null ? null : admissionProof(admissions, sha, code);
    const confirmed = admissions === null ? null : link !== null;
    const verdict = candidateDisposition(item, {confirmed, stopped, retryable: typeof isRetryable === 'function' ? isRetryable(item.reason) : false});
    const observedAt = typeof item.observedAt === 'string' ? item.observedAt : null;
    const lastProgressAt = [item.removedAt, item.retriedAt, item.registeredAt, observedAt].find(value => typeof value === 'string') || null;
    rows.push({
      key: 'lbc:' + sha + ':' + code, type: 'letterboxd_rated_candidate', status: item.state ?? null, reason: verdict.reason, disposition: verdict.disposition,
      title: typeof item.name === 'string' ? item.name : null, year: Number.isInteger(item.year) ? item.year : null, shortCode: code, archiveSha256: sha,
      provenance: [{source: 'letterboxd_archive', ref: sha}, ...(item.chunk !== undefined && item.chunk !== null ? [{source: 'archive_chunk', ref: String(item.chunk)}] : [])],
      observedAt, lastProgressAt, ageMs: ageOf(nowMs, observedAt || item.registeredAt),
      film: confirmed === true && (item.state === 'verified' || item.state === 'removed') ? {filmId: link.filmId, proof: link.proof} : null,
      observedHints: [],
      source: {chunk: item.chunk ?? null, rating: item.rating ?? null, enrichment: item.enrichment ?? null, retryOf: item.retryOf ?? null, historicalTmdb: item.historicalTmdb ?? null, stopped: stopped ? true : false},
    });
  }
  return rows;
}

// Limbo items become rows of their own lanes, unchanged inside `source`. Several issues of one Film are one row.
export function filmRows(items) {
  const byFilm = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.kind !== 'film') continue;
    const id = typeof item.film?.id === 'string' && item.film.id ? item.film.id : item.subjectId;
    if (!id) continue;
    (byFilm.get(id) || byFilm.set(id, []).get(id)).push(item);
  }
  return [...byFilm.entries()].map(([id, issues]) => {
    const head = issues[0];
    const age = issues.map(issue => issue.age?.ms).filter(value => typeof value === 'number');
    return {
      key: 'film:' + id, type: 'film', status: head.cause, reason: head.reason ?? null, disposition: causeDisposition(head.cause),
      title: head.film?.title ?? null, year: head.film?.year ?? null, shortCode: null, archiveSha256: null,
      provenance: [{source: 'limbo_film', ref: id}],
      observedAt: head.evidence?.observedAt ?? null, lastProgressAt: head.age?.lastProgressAt ?? null, ageMs: age.length ? Math.max(...age) : null,
      film: {filmId: id, proof: 'canonical_film'}, observedHints: [], source: {issues},
    };
  });
}

// The SQL filter of the ledger lane for a query: pushed into the source BEFORE any page limit, so a filtered work list is complete through paging. `blocked` names no ledger state: no rows, never everything.
export function admissionFilter(query) {
  if (query.disposition === null) return query.includeResolved ? 'all' : 'open';
  return {needs_owner_review: 'owner_review', waiting: 'waiting', retryable: 'retryable', resolved: 'history'}[query.disposition] ?? 'none';
}
// The Watchlist admission ledger (ADR 0186 decision 5): one row per Letterboxd id that still needs a Film, as the Letterboxd Sync keeps it. A terminal row (attempts or age exhausted) needs an owner decision; a pending one
// is retryable once its retry time has come and waiting before; resolved and superseded rows are resolved (history). It carries no Film link: the identity stays a Film fact.
export function admissionDisposition(row, nowMs) {
  if (row?.state === 'terminal') return {disposition: 'needs_owner_review', reason: row.lastReason ?? 'terminal'};
  if (row?.state === 'resolved' || row?.state === 'superseded') return {disposition: 'resolved', reason: row.lastReason ?? row.state};
  const due = row?.nextRetryAt == null || (Number.isFinite(Date.parse(row.nextRetryAt)) && Date.parse(row.nextRetryAt) <= nowMs);
  return {disposition: due ? 'retryable' : 'waiting', reason: row?.lastReason ?? null};
}
// AIR-599: `classify` (the one classifier of the check) and `diary` (the shared Diary document, when read) add each row's class, transport streak and next retry; both are optional.
export function admissionRows(items, {nowMs, classify = null, diary = null}) {
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.lid !== 'string' || !item.lid) continue;
    const verdict = admissionDisposition(item, nowMs);
    rows.push({
      key: 'wla:' + item.lid, type: 'watchlist_admission', status: item.state ?? null, reason: verdict.reason, disposition: verdict.disposition,
      title: typeof item.title === 'string' && item.title ? item.title : null, year: Number.isInteger(item.year) ? item.year : null, shortCode: item.lid, archiveSha256: null,
      provenance: [{source: 'watchlist_snapshot', ref: String(item.firstSeenSnapshotId ?? '')}],
      observedAt: item.firstSeenAt ?? null, lastProgressAt: typeof item.updatedAt === 'string' ? item.updatedAt : null, ageMs: ageOf(nowMs, item.firstSeenAt),
      film: null, observedHints: [], source: {attempts: Number.isInteger(item.attempts) ? item.attempts : null, nextRetryAt: item.nextRetryAt ?? null, firstSeenVersion: item.firstSeenVersion ?? null, resolvedBy: item.resolvedBy ?? null,
        class: item.state === 'terminal' ? 'needs_owner_review' : item.state === 'pending' && typeof classify === 'function' && item.lastReason ? classify(item.lastReason) : null,
        streak: object(diary?.films?.[item.lid]) && Number.isInteger(diary.films[item.lid].streak) ? diary.films[item.lid].streak : null,
        revision: {state: item.state ?? null, attempts: Number.isInteger(item.attempts) ? item.attempts : null, updatedAt: item.updatedAt ?? null}},
    });
  }
  return rows;
}

// AIR-599 / ADR 0207 decision 4b: the shared Diary check document (`diary-identity.json`) and its bounded backlog, as the `diary_identity` lane. An entry at the attempt cap needs the owner; an owner-dismissed
// entry is resolved; a due entry is retryable, a backed-off one waiting; a backlog id waits for capacity. `version` / `backlogVersion` are the compare-and-swap tokens of the owner actions.
export function diaryDisposition(entry, nowMs, maxAttempts) {
  if (entry?.reason === 'owner_dismissed') return 'resolved';
  if ((Number(entry?.attempts) || 0) >= maxAttempts) return 'needs_owner_review';
  const due = entry?.nextAttemptAt == null || (Number.isFinite(Date.parse(entry.nextAttemptAt)) && Date.parse(entry.nextAttemptAt) <= nowMs);
  return due ? 'retryable' : 'waiting';
}
export function diaryRows(doc, backlog, {nowMs, maxAttempts = 6, classify = null}) {
  const rows = [];
  for (const [lid, entry] of Object.entries(object(doc?.films) ? doc.films : {})) {
    if (!object(entry)) continue;
    const disposition = diaryDisposition(entry, nowMs, maxAttempts);
    const queuedAt = entry.queuedAt || entry.lastAttemptAt || null;
    rows.push({
      key: 'did:' + lid, type: 'diary_identity', status: 'entry', reason: entry.reason ?? null, disposition, title: null, year: null, shortCode: lid, archiveSha256: null,
      provenance: [{source: 'diary_identity', ref: lid}], observedAt: queuedAt, lastProgressAt: entry.lastAttemptAt ?? null, ageMs: ageOf(nowMs, queuedAt), film: null, observedHints: [],
      source: {attempts: Number(entry.attempts) || 0, streak: Number(entry.streak) || 0, nextRetryAt: entry.nextAttemptAt ?? null, class: disposition === 'needs_owner_review' ? 'needs_owner_review' : entry.class || (typeof classify === 'function' ? classify(entry.reason) : null),
        slug: entry.slug ?? null, route: entry.route ?? null, checkId: entry.checkId ?? null, requeued: object(entry.requeued) ? entry.requeued : null, queuedAt},
    });
  }
  for (const [lid, item] of Object.entries(object(backlog?.ids) ? backlog.ids : {})) {
    if (!object(item) || (object(doc?.films) && doc.films[lid])) continue;
    rows.push({
      key: 'dbl:' + lid, type: 'diary_identity', status: 'backlog', reason: 'diary_cap', disposition: 'waiting', title: null, year: null, shortCode: lid, archiveSha256: null,
      provenance: [{source: 'diary_identity_backlog', ref: lid}], observedAt: item.queuedAt ?? null, lastProgressAt: null, ageMs: ageOf(nowMs, item.queuedAt), film: null, observedHints: [],
      source: {attempts: 0, streak: 0, nextRetryAt: null, class: 'not_now', slug: item.slug ?? null, route: null, checkId: null, requeued: object(item.requeued) ? item.requeued : null, queuedAt: item.queuedAt ?? null},
    });
  }
  // Queue order: oldest queue position first (the order the checks serve), then key.
  return rows.sort((left, right) => text(left.source.queuedAt, right.source.queuedAt) || text(left.key, right.key));
}

export function observationRows(items) {
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.kind !== 'observation' || typeof item.subjectId !== 'string') continue;
    rows.push({
      key: 'epg:' + item.subjectId, type: 'epg_observation', status: item.cause, reason: item.reason ?? null, disposition: causeDisposition(item.cause),
      title: item.observation?.title ?? null, year: item.observation?.year ?? null, shortCode: null, archiveSha256: null,
      provenance: [{source: 'discovery_observation', ref: item.subjectId}],
      observedAt: item.evidence?.observedAt ?? null, lastProgressAt: item.age?.lastProgressAt ?? null, ageMs: typeof item.age?.ms === 'number' ? item.age.ms : null,
      // The Limbo reader carries no canonical movie proof for an observation, so no Film link is claimed (a tmdb_tv id never is one).
      film: null, observedHints: [], source: {item},
    });
  }
  return rows;
}

// Lane order inside film and epg_observation: age descending (unknown last), then key.
export function sortLaneRows(rows) {
  return rows.slice().sort((left, right) => (right.ageMs ?? -1) - (left.ageMs ?? -1) || text(left.key, right.key));
}

export function filterRows(rows, query) {
  return rows.filter(row =>
    (query.disposition === null ? (query.includeResolved || row.disposition !== 'resolved') : row.disposition === query.disposition)
    && (query.q === null || [row.title, row.shortCode, row.key].some(value => typeof value === 'string' && value.normalize('NFKC').toLowerCase().includes(query.q))));
}

// Untrusted, best effort, computed only from the rows of this response. Absence means "not observed". Never sets `film`.
export function attachHints(rows) {
  const byCode = new Map(), byTitle = new Map();
  for (const row of rows) {
    if (row.type === 'letterboxd_rated_candidate') (byCode.get(row.shortCode) || byCode.set(row.shortCode, []).get(row.shortCode)).push(row);
    if (row.title && Number.isInteger(row.year)) (byTitle.get(normalizeTitle(row.title) + '|' + row.year) || byTitle.set(normalizeTitle(row.title) + '|' + row.year, []).get(normalizeTitle(row.title) + '|' + row.year)).push(row);
  }
  const hints = new Map(rows.map(row => [row.key, []]));
  for (const group of byCode.values()) {
    for (const row of group) for (const other of group) if (other !== row && other.archiveSha256 !== row.archiveSha256) hints.get(row.key).push({kind: 'same_short_code', trusted: false, ref: other.key});
  }
  for (const group of byTitle.values()) {
    for (const row of group) for (const other of group) {
      if (other === row || row.type === other.type || (row.type !== 'epg_observation' && other.type !== 'epg_observation')) continue;
      hints.get(row.key).push({kind: 'title_year_match', trusted: false, ref: other.key});
    }
  }
  return rows.map(row => ({...row, observedHints: hints.get(row.key).sort((left, right) => text(left.kind + left.ref, right.kind + right.ref))}));
}

// ---- cursor ----
function encode(payload) {
  const binary = Array.from(new TextEncoder().encode(JSON.stringify(payload)), byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}
function decode(cursor) {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const padded = cursor.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - cursor.length % 4) % 4);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), char => char.charCodeAt(0))));
  } catch {return null;}
}

// A cursor names the pin, the evaluation clock `nowMs` of the first page (every later page is cut from the same evaluation, so causes, ages
// and dispositions cannot move between pages while the source versions stand), the filter key, the limit and a position. In film / epg_observation the position is the index and key of
// the last served row of that lane (`index` -1: nothing served yet). In the candidate lane it is the archive and the last short code
// served ('' : start), plus the document etag read when the cursor was minted (null when the archive was not read yet).
export function encodeCursor(cursor) {
  return encode({v: 1, ...cursor});
}
// The pin is returned, not judged here: a moved pin is `stale_pin` (409), any other mismatch is `stale_cursor` (400).
export function decodeCursor(raw, {key, limit}) {
  const payload = decode(raw);
  if (!object(payload) || payload.v !== 1 || payload.key !== key || payload.limit !== limit || typeof payload.pin !== 'string' || !Number.isInteger(payload.nowMs) || payload.nowMs <= 0 || !IDENTITY_LANES.includes(payload.lane)) return {error: 'stale_cursor'};
  if (payload.lane === 'letterboxd_rated_candidate') {
    if (typeof payload.after !== 'string' || (payload.sha !== null && !HEX64.test(String(payload.sha))) || (payload.etag !== null && typeof payload.etag !== 'string')) return {error: 'stale_cursor'};
    return {pin: payload.pin, nowMs: payload.nowMs, cursor: {lane: payload.lane, sha: payload.sha, after: payload.after, etag: payload.etag}};
  }
  // The Watchlist admission ledger is paged by KEYSET over a mutable D1 source: the position is the (first-seen version, lid) of the last row READ, and `gen` is the Watchlist authority generation of the page that minted it
  // (null before the first read), so a cursor never crosses an authority switch.
  if (payload.lane === 'watchlist_admission') {
    if (!Number.isInteger(payload.version) || payload.version < -1 || typeof payload.lid !== 'string' || (payload.gen !== null && !Number.isInteger(payload.gen))) return {error: 'stale_cursor'};
    return {pin: payload.pin, nowMs: payload.nowMs, cursor: {lane: payload.lane, version: payload.version, lid: payload.lid, gen: payload.gen}};
  }
  if (!Number.isInteger(payload.index) || payload.index < -1 || !Number.isInteger(payload.total) || typeof payload.id !== 'string') return {error: 'stale_cursor'};
  return {pin: payload.pin, nowMs: payload.nowMs, cursor: {lane: payload.lane, index: payload.index, total: payload.total, id: payload.id}};
}

export const START = {lane: 'film', index: -1, total: 0, id: ''};

// Serves the in-memory lanes from `position` until the page is full. Returns the rows, the cursor for the next call (or null when the
// lane list is exhausted and the next lane is not reached) and whether the page is full. A moved lane list is `stale_cursor`.
export function pageMemoryLane(rows, position, room) {
  let start = 0;
  if (position.index >= 0) {
    if (position.total !== rows.length || rows[position.index]?.key !== position.id) return {error: 'stale_cursor'};
    start = position.index + 1;
  }
  const slice = rows.slice(start, start + room);
  const last = start + slice.length - 1;
  const more = start + slice.length < rows.length;
  return {rows: slice, exhausted: !more, last: slice.length ? {index: last, id: rows[last].key, total: rows.length} : null};
}

// The candidate lane: rows of ONE archive after `after`, at most `room`. `rows` are already filtered and in short code order.
export function pageCandidateRows(rows, after, room) {
  const rest = after ? rows.filter(row => text(row.shortCode, after) > 0) : rows;
  const slice = rest.slice(0, room);
  return {rows: slice, exhausted: slice.length >= rest.length, last: slice.length ? slice[slice.length - 1].shortCode : after};
}
