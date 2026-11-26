// Rated rows of one Letterboxd ZIP (AIR-340). Pure: no storage, network or clock.
// A short boxd.it code is the source key of a candidate. It is not a Letterboxd lid and it does not admit a Film.
// An old private ledger count is not the queue. A historical TMDB id is not an accepted identity.
export const RATED_BATCH = 50;
const CODE = /^[A-Za-z0-9]{1,16}$/;
const TMDB = /^[1-9]\d{0,11}$/;

export function isRatedFilm(film) {
  return !!film && film.inRatings === true && typeof film.rating === 'number' && film.rating >= 0.5 && film.rating <= 5;
}

function row(code, disposition, reason, extra = {}) {
  return {code: code == null ? null : String(code), disposition, reason, tmdb: null, historicalTmdb: null, ...extra};
}

// One export film against the match the existing matcher already computed.
// `historicalAlias` is `{tmdb}` from an old import, or null. It never accepts the row.
export function classifyRow(film, match, historicalAlias) {
  if (!film || !isRatedFilm(film)) return row(film?.code, 'excluded', 'no_rating');
  const code = String(film.code || '');
  if (!CODE.test(code)) return row(code, 'needs_review', 'invalid_code', {rating: film.rating, name: film.name || null, year: film.year ?? null});
  const historicalTmdb = historicalAlias && TMDB.test(String(historicalAlias.tmdb || '')) ? String(historicalAlias.tmdb) : null;
  const base = {rating: film.rating, name: film.name || null, year: film.year ?? null, historicalTmdb};
  const status = match?.status || 'unmatched';
  if (match?.tmdbScheme === 'tmdb_tv' || match?.reason === 'tmdb_tv') return row(code, 'needs_review', 'tmdb_tv', base);
  if (status === 'accepted' && historicalTmdb && match?.tmdbId != null && String(match.tmdbId) !== historicalTmdb) return row(code, 'needs_review', 'historical_alias_conflict', base);
  if (status === 'accepted') return row(code, 'matched', null, {...base, tmdb: match?.tmdbId != null ? String(match.tmdbId) : null});
  if (status === 'conflict' || status === 'ambiguous' || status === 'candidate' || status === 'provisional' || match?.method === 'title_year') return row(code, 'needs_review', match?.reason || status, base);
  return row(code, 'pending', match?.reason || 'unmatched', base);
}

// `historical.counts` is recorded and ignored. Eligibility is this archive plus the matches already made
// against the current films and ratings, not a remembered candidate total.
export function classifyArchive({films = [], matches = [], historical = null} = {}) {
  const byCode = new Map(matches.map(match => [match.code, match]));
  const aliases = historical && historical.aliases && typeof historical.aliases === 'object' ? historical.aliases : {};
  const seen = new Set();
  const rows = [];
  for (const film of films) {
    if (seen.has(film.code)) {rows.push(row(film.code, 'replay', 'duplicate_in_archive')); continue;}
    seen.add(film.code);
    rows.push(classifyRow(film, byCode.get(film.code) || null, aliases[film.code] || null));
  }
  const tally = {matched: 0, pending: 0, needs_review: 0, excluded: 0, replay: 0};
  for (const item of rows) tally[item.disposition] = (tally[item.disposition] || 0) + 1;
  return {
    rows,
    tally,
    pending: rows.filter(item => item.disposition === 'pending'),
    review: rows.filter(item => item.disposition === 'needs_review'),
    historicalCountsIgnored: historical && historical.counts ? historical.counts : null,
  };
}

export function splitPending(rows, offset = 0) {
  const batches = [];
  for (let index = 0; index < rows.length; index += RATED_BATCH) {
    const slice = rows.slice(index, index + RATED_BATCH);
    batches.push({chunk: offset + batches.length, rows: slice});
  }
  return batches;
}

// A stored candidate is not registered again. A newer observedAt on the stored row wins. A verified row stays.
export function planRegistration(stored, incoming, generatedAt) {
  const current = stored && stored.candidates || {};
  const add = [], keep = [], skippedNewer = [];
  for (const row of incoming) {
    if (row.disposition !== 'pending' && row.disposition !== 'needs_review') continue;
    const prior = current[row.code];
    const state = row.disposition === 'needs_review' ? 'needs_review' : 'pending';
    if (prior && prior.state === 'verified') {keep.push(row.code); continue;}
    if (prior && prior.observedAt && generatedAt && Date.parse(prior.observedAt) > Date.parse(generatedAt)) {skippedNewer.push(row.code); continue;}
    if (prior && prior.state === state && prior.reason === (row.reason || null) && prior.rating === row.rating) {keep.push(row.code); continue;}
    add.push({...row, state});
  }
  return {add, keep, skippedNewer};
}

// A stop fetches nothing until resume. The next code is an admitting fence, then any still-pending code.
// A cursor is only a progress mark: a later chunk can register a code that sorts before it, and that code stays eligible.
// Enrichment of a verified film waits until no identity work remains.
export const RETRY_LIMIT = 8;

// The observation id is the archive write, not just state:reason. observedAt and registeredAt
// both change when a later import rewrites the same row.
export function retryObservationId(item) {
  return [item && item.observedAt || '', item && item.registeredAt || ''].join('|');
}

export function retryFingerprint(item) {
  if (!item) return 'missing';
  return [item.state || '', item.reason || '', retryObservationId(item)].join('|');
}

export function expectedSnapshot(item) {
  if (!item) return null;
  return {
    state: item.state || null,
    reason: item.reason || null,
    fingerprint: retryFingerprint(item),
    observedAt: item.observedAt || null,
    registeredAt: item.registeredAt || null,
  };
}

export function isCompleteExpected(expect) {
  return !!(expect && typeof expect === 'object' && !Array.isArray(expect)
    && typeof expect.fingerprint === 'string' && expect.fingerprint !== 'missing' && expect.fingerprint.includes('|')
    && typeof expect.state === 'string' && expect.state
    && Object.prototype.hasOwnProperty.call(expect, 'reason'));
}

export function validatedRetryExpected(doc, codes, expected) {
  const requested = [...new Set((Array.isArray(codes) ? codes : []).map(code => String(code || '')).filter(Boolean))];
  if (!requested.length || requested.length > RETRY_LIMIT) return {ok: false, refusal: 'invalid_request', expected: {}};
  const snapshot = {};
  for (const code of requested) {
    if (!CODE.test(code) || !isCompleteExpected(expected && expected[code])) return {ok: false, refusal: 'invalid_request', expected: {}};
    const item = doc && doc.candidates && doc.candidates[code];
    if (!item) return {ok: false, refusal: 'invalid_request', expected: {}};
    if (retryFingerprint(item) !== expected[code].fingerprint) return {ok: false, refusal: 'record_changed', expected: {}};
    snapshot[code] = expectedSnapshot(item);
  }
  return {ok: true, expected: snapshot};
}

function observationIdFromExpect(expect) {
  if (!isCompleteExpected(expect)) return '';
  if (expect.observedAt != null || expect.registeredAt != null) return retryObservationId(expect);
  return String(expect.fingerprint).split('|').slice(2).join('|');
}

function expectedMatches(item, expect) {
  if (!isCompleteExpected(expect)) return false;
  return retryFingerprint(item) === expect.fingerprint;
}

function observationMatches(item, expect) {
  if (!isCompleteExpected(expect)) return false;
  const want = observationIdFromExpect(expect);
  return !!want && retryObservationId(item) === want;
}

// Requeue only needs_review rows whose stored reason is a proven parser/markup defect.
// A verified, admitting, removed or other-reason row is left alone. Every named code needs a
// complete expected fingerprint; an empty expected map is not a match.
export function planIdentityRetry(doc, {codes = [], expected = {}} = {}) {
  const requested = [...new Set((Array.isArray(codes) ? codes : []).map(code => String(code || '')).filter(Boolean))];
  if (!requested.length || requested.length > RETRY_LIMIT) return {ok: false, refusal: 'invalid_request', requeue: [], outcomes: []};
  if (requested.some(code => CODE.test(code) && !isCompleteExpected(expected && expected[code]))) {
    return {ok: false, refusal: 'invalid_request', requeue: [], outcomes: []};
  }
  const outcomes = [];
  const requeue = [];
  for (const code of requested) {
    if (!CODE.test(code)) {outcomes.push({id: code, outcome: 'failed', error: 'invalid_request'}); continue;}
    const item = doc && doc.candidates && doc.candidates[code];
    const expect = expected && expected[code];
    if (!item) {outcomes.push({id: code, outcome: 'failed', error: 'missing'}); continue;}
    if (item.state === 'pending' && item.retryOf && LetterboxdIdentityIsRetryable(item.retryOf) && observationMatches(item, expect)) {
      outcomes.push({id: code, outcome: 'already_applied'});
      continue;
    }
    if (!expectedMatches(item, expect) || item.state !== 'needs_review' || !LetterboxdIdentityIsRetryable(item.reason)) {
      outcomes.push({id: code, outcome: 'skipped_changed'});
      continue;
    }
    requeue.push(code);
    outcomes.push({id: code, outcome: 'written'});
  }
  return {ok: true, requeue, outcomes};
}

function LetterboxdIdentityIsRetryable(reason) {
  if (typeof LetterboxdIdentity !== 'undefined' && LetterboxdIdentity.isRetryableReason) return LetterboxdIdentity.isRetryableReason(reason);
  return reason === 'shortlink_missing';
}

export function resumePending(checkpoint, candidates) {
  const items = Object.values(candidates || {}).filter(item => item && item.code);
  const admitting = items.filter(item => item.state === 'admitting').map(item => item.code).sort();
  const fresh = items.filter(item => item.state === 'pending').map(item => item.code).sort();
  const pending = [...admitting, ...fresh.filter(code => !admitting.includes(code))];
  const stopped = checkpoint && checkpoint.stopped || null;
  if (stopped) return {pending, next: null, stopped, phase: 'identity'};
  if (admitting.length) return {pending, next: admitting[0], stopped: null, phase: 'identity'};
  if (fresh.length) return {pending, next: fresh[0], stopped: null, phase: 'identity'};
  const enrich = items.filter(item => item.state === 'verified' && item.enrichment !== 'done').map(item => item.code).sort();
  if (enrich.length) return {pending: enrich, next: enrich[0], stopped: null, phase: 'enrich'};
  return {pending: [], next: null, stopped: null, phase: null};
}

function norm(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Independent of the Letterboxd page: the TMDB movie document must be that movie id, not a TV id, and must agree on title and year.
export function movieDetailAgrees(detail, tmdbId, title, year) {
  if (!detail || typeof detail !== 'object') return {ok: false, reason: 'detail_missing'};
  if (detail.media_type === 'tv' || detail.kind === 'tv') return {ok: false, reason: 'tmdb_tv'};
  if (String(detail.id) !== String(tmdbId)) return {ok: false, reason: 'detail_id_mismatch'};
  if (detail.media_type && detail.media_type !== 'movie') return {ok: false, reason: 'tmdb_not_movie'};
  const titles = [detail.title, detail.original_title].filter(Boolean).map(norm);
  if (title && !titles.includes(norm(title))) return {ok: false, reason: 'detail_title_mismatch'};
  const release = Number(String(detail.release_date || '').slice(0, 4));
  if (year && Number.isFinite(release) && Math.abs(release - Number(year)) > 1) return {ok: false, reason: 'detail_year_mismatch'};
  return {ok: true};
}

// ADR 0217 decision 3 (AIR-670), pure and dormant: the typed TMDB state of one check and its outcome. Nothing calls it from a live path; `tmdb_none` (H1, lid-only admission) is a later delivery step and is
// never produced here, so no state is ever downgraded to it. `charged` is the existing retry contract (ADR 0207 decision 4b): a charged outcome is `definite` there (one attempt, review backoff, owner review
// at the cap), an uncharged one is `transport` (no attempt, the place in the queue is kept). The outcome names are reasons the existing classifier already treats as `definite`.
export const TMDB_STATES = Object.freeze({
  tmdb_movie: {outcome: null, charged: false, admits: true},
  tmdb_disagrees: {outcome: 'detail_mismatch', charged: true, admits: false},
  tmdb_tv: {outcome: 'tmdb_not_movie', charged: true, admits: false},
  tmdb_missing: {outcome: 'tmdb_contradiction', charged: true, admits: false},
  tmdb_unavailable: {outcome: 'tmdb_unavailable', charged: false, admits: false},
  tmdb_failed: {outcome: 'tmdb_fetch_failed', charged: true, admits: false},
  tmdb_unreadable: {outcome: 'page_unreadable', charged: true, admits: false},
});
const typed = (state, extra = {}) => ({state, ...TMDB_STATES[state], ...extra});

// What the film page says about TMDB. `fetched` is the follow result ({html} or {stop}); `evidence` is pageEvidence of it. A page that is incomplete (no closing html tag), not parseable, carries no id
// (an absence is not proven here), several ids, an id that is not numeric, or no readable movie/tv marker is `tmdb_unreadable`, never "no TMDB".
export function pageTmdbState(fetched, evidence) {
  if (fetched && fetched.stop) return fetched.stop === 'oversized' ? typed('tmdb_unreadable') : typed('tmdb_unavailable', {stop: fetched.stop});
  const html = fetched && typeof fetched.html === 'string' ? fetched.html : '';
  if (!/<\/html\s*>\s*$/i.test(html)) return typed('tmdb_unreadable');
  if (!evidence || evidence.kind !== 'page') return typed('tmdb_unreadable');
  const ids = Array.isArray(evidence.tmdbIds) ? evidence.tmdbIds : [];
  const types = Array.isArray(evidence.tmdbTypes) ? evidence.tmdbTypes : [];
  if (ids.length !== 1 || !TMDB.test(String(ids[0]))) return typed('tmdb_unreadable');
  if (types.length !== 1) return typed('tmdb_unreadable');
  if (types[0] === 'tv') return typed('tmdb_tv', {tmdbId: String(ids[0])});
  if (types[0] !== 'movie') return typed('tmdb_unreadable');
  return typed('tmdb_movie', {tmdbId: String(ids[0])});
}

// What TMDB says about the movie id: `result` is the movieDetail answer. Only a usable document is compared (movieDetailAgrees); its disagreement keeps the existing reason.
export function detailTmdbState(result, tmdbId, title, year) {
  if (!result) return typed('tmdb_failed');
  if (result.stop) return typed('tmdb_unavailable', {stop: result.stop});
  if (result.state === 'tmdb_unavailable' || result.state === 'tmdb_missing' || result.state === 'tmdb_failed') return typed(result.state);
  if (result.review) return typed('tmdb_failed');
  const agree = movieDetailAgrees(result.detail, tmdbId, title, year);
  if (agree.ok) return typed('tmdb_movie');
  return agree.reason === 'tmdb_tv' ? typed('tmdb_tv') : typed('tmdb_disagrees', {outcome: agree.reason});
}

// The Film id is the verified movie id. No watchlist field is stored.
export function admissionFilm({tmdb, sourceCode, archiveSha256, title = null, year = null}) {
  if (!TMDB.test(String(tmdb || '')) || !CODE.test(String(sourceCode || ''))) return null;
  return {filmId: 'tmdb_' + tmdb, tmdb: String(tmdb), sourceCode: String(sourceCode), archiveSha256, title, year: Number.isInteger(year) ? year : null};
}
