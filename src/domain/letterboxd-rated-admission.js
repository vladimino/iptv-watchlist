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

// AIR-675 / ADR 0217 decision 8b: the normalization the agreement check compares in, exported so the attach root hashes the TMDB document fields in exactly that form (no new normalization rule).
export const agreementNorm = norm;

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
// never produced here, so no state is ever downgraded to it. `retryClass` is the class the EXISTING classifier (`LetterboxdDiaryIdentity.classify`, ADR 0207 decision 4b, AIR-599) gives the `outcome`: `transport`
// keeps the queue place and charges no attempt, `definite` and `gone` charge one attempt with the review backoff. The outcomes are chosen so that the existing classifier gives exactly this class; a test checks it.
export const TMDB_STATES = Object.freeze({
  tmdb_movie: {outcome: null, retryClass: null, admits: true}, // reached only by `tmdbCheckState`, after the page AND an agreeing TMDB document
  tmdb_disagrees: {outcome: 'detail_mismatch', retryClass: 'definite', admits: false}, // the outcome is the existing `detail_*` reason of movieDetailAgrees
  tmdb_tv: {outcome: 'tmdb_not_movie', retryClass: 'definite', admits: false},
  tmdb_missing: {outcome: 'tmdb_contradiction', retryClass: 'definite', admits: false},
  tmdb_unavailable: {outcome: 'tmdb_unavailable', retryClass: 'transport', admits: false}, // the outcome is the transport reason itself (rate_limited, upstream_5xx, network_error, ...)
  tmdb_failed: {outcome: 'tmdb_fetch_failed', retryClass: 'definite', admits: false},
  tmdb_unreadable: {outcome: 'page_unreadable', retryClass: 'definite', admits: false},
});
// The transport reasons of the existing classifier (src/letterboxd-diary-identity.js TRANSPORT_REASONS); a test keeps the two in step.
const TRANSPORT_STOPS = new Set(['forbidden', 'challenge', 'rate_limited', 'timeout', 'network_error', 'upstream_5xx', 'tmdb_unavailable', 'upstream_cooldown']);
const typed = (state, extra = {}) => ({state, ...TMDB_STATES[state], ...extra});
// A fetch answer's `network` and `until` ride along with a transport stop, as the live callers read them.
const carried = answer => ({...(answer && answer.network ? {network: true} : {}), ...(answer && answer.until !== undefined ? {until: answer.until} : {})});
const stopReason = answer => (answer.stop === 'fetch_failed' && answer.network ? 'network_error' : answer.stop); // as `pageReason` of the Diary check
// The page's own answer that is not a read page and not TMDB's: the existing reason, class and charge are kept (a 404 or 410 is `not_found`, a 5xx is `upstream_5xx`).
function pageNotRead(reason, answer) {
  const retryClass = reason === 'not_found' ? 'gone' : 'definite';
  return {state: 'page_not_read', outcome: reason, retryClass, admits: false, ...carried(answer)};
}
function unavailable(reason, answer) {
  return typed('tmdb_unavailable', {outcome: reason, ...carried(answer)});
}
// The raw value of every occurrence of an attribute, read from the HTML itself: `pageEvidence` keeps only well-formed numeric ids and lowercase alphabetic types, so a malformed value would otherwise vanish.
const rawValues = (html, name) => [...html.matchAll(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>"\']*))', 'gi'))].map(match => match[1] ?? match[2] ?? match[3] ?? '');

// What the film page says about TMDB: an observation of the page, never an admission. `fetched` is the follow result ({html} or {stop} or {review, status}); `evidence` is pageEvidence of it.
// A page that is incomplete (no closing html tag), not parseable, has no id block, several ids, a malformed or doubled id or type value anywhere in its raw markup, or an unknown type is `tmdb_unreadable`,
// never "no TMDB". A page that names exactly one movie id is `page_movie` (not admitting: the TMDB document still has to agree), one TV id is `tmdb_tv`.
export function pageTmdbObservation(fetched, evidence) {
  if (!fetched) return typed('tmdb_unreadable');
  if (fetched.stop) {
    const reason = stopReason(fetched);
    if (TRANSPORT_STOPS.has(reason)) return unavailable(reason, fetched);
    return reason === 'oversized' ? typed('tmdb_unreadable') : pageNotRead(reason, fetched);
  }
  if (fetched.review) {
    const status = fetched.status;
    const reason = fetched.review === 'fetch_failed' && Number.isInteger(status) ? (status === 404 || status === 410 ? 'not_found' : status >= 500 ? 'upstream_5xx' : 'fetch_failed') : fetched.review;
    return reason === 'upstream_5xx' ? unavailable(reason, fetched) : pageNotRead(reason, fetched);
  }
  const html = typeof fetched.html === 'string' ? fetched.html : '';
  if (!/<\/html\s*>\s*$/i.test(html)) return typed('tmdb_unreadable');
  if (!evidence || evidence.kind !== 'page') return typed('tmdb_unreadable');
  const ids = new Set(rawValues(html, 'data-tmdb-id'));
  const types = new Set(rawValues(html, 'data-tmdb-type'));
  if (ids.size !== 1 || ![...ids].every(id => TMDB.test(id))) return typed('tmdb_unreadable');
  const [id] = ids;
  const parsed = Array.isArray(evidence.tmdbIds) ? evidence.tmdbIds.map(String) : [];
  if (parsed.length !== 1 || parsed[0] !== id) return typed('tmdb_unreadable');
  if (types.size !== 1) return typed('tmdb_unreadable');
  const [type] = types;
  if (type === 'tv') return typed('tmdb_tv', {tmdbId: id});
  if (type !== 'movie') return typed('tmdb_unreadable');
  return {state: 'page_movie', outcome: null, retryClass: null, admits: false, tmdbId: id};
}

// What TMDB says about the movie id: `result` is the movieDetail answer. The answers keep their established classes (AIR-599): a 5xx is the transport reason `upstream_5xx`, a transport stop keeps `network` and `until`,
// a 404 is `tmdb_missing`, any other non-200 or an unparseable or oversized document is `tmdb_failed`. Only a usable document is compared (movieDetailAgrees); its disagreement keeps the existing reason.
function detailTmdbState(result, tmdbId, title, year) {
  if (!result) return typed('tmdb_failed');
  if (result.stop) {
    const reason = stopReason(result);
    return TRANSPORT_STOPS.has(reason) ? unavailable(reason, result) : typed('tmdb_failed');
  }
  if (result.review) {
    const status = result.status;
    if (status === 404 || result.state === 'tmdb_missing') return typed('tmdb_missing');
    return Number.isInteger(status) && status >= 500 ? unavailable('upstream_5xx', result) : typed('tmdb_failed');
  }
  const agree = movieDetailAgrees(result.detail, tmdbId, title, year);
  if (agree.ok) return typed('tmdb_movie');
  return agree.reason === 'tmdb_tv' ? typed('tmdb_tv') : typed('tmdb_disagrees', {outcome: agree.reason});
}

// The one composition of a check: the final state is admitting (`tmdb_movie`) only when the page names one movie id, the page carries the evidence the existing movie path requires, AND the TMDB document for that id
// agrees. The movie path's page evidence is the one `LetterboxdDiaryIdentity.verifyPage` already demands: a non-empty title and exactly one page year (`title_missing`, `page_year_inconsistent`, `page_year_missing`, the
// existing reasons, `definite`). Only a lid-only admission may omit the year (ADR 0217 decision 2), and that is not this function. There is no caller fallback: a title or year the page did not show is never evidence of
// agreement. Such a page is `page_refused` before TMDB is asked, as in the live check; while the document has not been fetched (`detail` undefined) a page that passes is the non-admitting `page_movie`.
export function tmdbCheckState({fetched, evidence, detail}) {
  const page = pageTmdbObservation(fetched, evidence);
  if (page.state !== 'page_movie') return page;
  const years = Array.isArray(evidence.years) ? evidence.years : [];
  const refusal = !evidence.title ? 'title_missing' : years.length !== 1 ? (years.length ? 'page_year_inconsistent' : 'page_year_missing') : null;
  if (refusal) return {state: 'page_refused', outcome: refusal, retryClass: 'definite', admits: false, tmdbId: page.tmdbId};
  if (detail === undefined) return page;
  return {...detailTmdbState(detail, page.tmdbId, evidence.title, years[0]), tmdbId: page.tmdbId};
}

// The Film id is the verified movie id. No watchlist field is stored.
export function admissionFilm({tmdb, sourceCode, archiveSha256, title = null, year = null}) {
  if (!TMDB.test(String(tmdb || '')) || !CODE.test(String(sourceCode || ''))) return null;
  return {filmId: 'tmdb_' + tmdb, tmdb: String(tmdb), sourceCode: String(sourceCode), archiveSha256, title, year: Number.isInteger(year) ? year : null};
}
