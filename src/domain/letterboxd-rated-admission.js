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

// Requeue only needs_review rows whose stored reason is a proven parser/markup defect.
// A verified, admitting, removed or other-reason row is left alone.
export function planIdentityRetry(doc, {codes = [], expected = {}} = {}) {
  const requested = [...new Set((Array.isArray(codes) ? codes : []).map(code => String(code || '')).filter(Boolean))];
  if (!requested.length || requested.length > RETRY_LIMIT) return {ok: false, refusal: 'invalid_request', requeue: [], outcomes: []};
  const outcomes = [];
  const requeue = [];
  for (const code of requested) {
    if (!CODE.test(code)) {outcomes.push({id: code, outcome: 'failed', error: 'invalid_request'}); continue;}
    const item = doc && doc.candidates && doc.candidates[code];
    const expect = expected && expected[code];
    if (!item) {outcomes.push({id: code, outcome: 'failed', error: 'missing'}); continue;}
    if (expect && (item.state !== expect.state || (item.reason || null) !== (expect.reason || null))) {
      outcomes.push({id: code, outcome: 'skipped_changed'});
      continue;
    }
    if (item.state === 'pending' && item.retryOf && LetterboxdIdentityIsRetryable(item.retryOf)) {
      outcomes.push({id: code, outcome: 'already_applied'});
      continue;
    }
    if (item.state !== 'needs_review' || !LetterboxdIdentityIsRetryable(item.reason)) {
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

// The Film id is the verified movie id. No watchlist field is stored.
export function admissionFilm({tmdb, sourceCode, archiveSha256, title = null, year = null}) {
  if (!TMDB.test(String(tmdb || '')) || !CODE.test(String(sourceCode || ''))) return null;
  return {filmId: 'tmdb_' + tmdb, tmdb: String(tmdb), sourceCode: String(sourceCode), archiveSha256, title, year: Number.isInteger(year) ? year : null};
}
