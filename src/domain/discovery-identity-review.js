// Owner correction of one discovery observation's identity. Pure: no I/O, no clock, no network. Two effects, each for
// one numeric TMDB movie id on one observation key: `assign` records that id as the owner-verified film, `reject`
// blocks that id on this decision only. A title match is never a candidate. The caller supplies the index record and,
// for assign, the one catalogue object it already read. This module does not look anything up.

export const DISCOVERY_IDENTITY_CAPABILITY = 'discovery_identity_correct';
export const DISCOVERY_IDENTITY_VERSION = 1;
export const DISCOVERY_IDENTITY_EFFECTS = ['assign', 'reject'];
export const DISCOVERY_IDENTITY_MOVIE_ID = /^[1-9]\d{0,11}$/;
export const DISCOVERY_IDENTITY_REASONS = [
  'eligible', 'index_not_current', 'index_incomplete', 'unknown_authority', 'writer_active', 'series_unknown',
  'target_absent', 'evidence_incomplete', 'identity_ambiguous', 'already_current', 'invalid_effect', 'invalid_movie_id',
  'basis_required', 'not_on_decision', 'ambiguous_needs_stronger', 'film_absent', 'film_year_unknown', 'year_unknown',
  'year_conflict', 'tmdb_tv', 'identity_inconsistent', 'conflicting_identity', 'catalogue_unread', 'title_only',
];

const IDENTITY_UNKNOWN = new Set(['index_not_current', 'series_unknown', 'unknown_authority', 'catalogue_unread', 'evidence_incomplete']);
const BASIS_MAX = 200;

function identityObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// A TMDB movie id. `tmdb_tv` values and anything that is not a positive integer are not movie ids.
export function identityMovieId(value) {
  if (typeof value === 'number' && Number.isInteger(value)) value = String(value);
  return typeof value === 'string' && DISCOVERY_IDENTITY_MOVIE_ID.test(value) ? value : null;
}

export function identityVersion(decisionHash, effect, tmdbId) {
  return decisionHash + ':' + effect + ':' + tmdbId;
}

export function parseIdentityVersion(version) {
  const match = /^([0-9a-f]{64}):(assign|reject):([1-9]\d{0,11})$/.exec(typeof version === 'string' ? version : '');
  return match ? {decisionHash: match[1], effect: match[2], tmdbId: match[3]} : null;
}

// The published generation pointer is the R2 authority marker this route knows. An absent identity/programme marker
// means today's R2 resolution map. Any other marker, or a pointer that is not a published generation, is unknown.
// `publishedEpg` is the caller's read of the published-EPG authority, when a database binding exists. `{supported:false}`
// (mode `d1`, or a schema that claims that store and cannot be read) refuses even when the R2 pointer still looks like
// today's generation. A missing binding is omitted and keeps the R2 rule. This function does not read D1.
export function identityStoreAuthority(generation, publishedEpg = null) {
  if (!identityObject(generation) || generation.phase !== 'published' || typeof generation.programmeRunId !== 'string' || !generation.programmeRunId) {
    return {authority: null, programmeRunId: null, reason: 'unknown_authority'};
  }
  const marker = generation.identityAuthority ?? generation.programmeAuthority ?? null;
  if (marker != null && marker !== 'r2') return {authority: null, programmeRunId: generation.programmeRunId, reason: 'unknown_authority'};
  if (publishedEpg && publishedEpg.supported === false) return {authority: null, programmeRunId: generation.programmeRunId, reason: 'unknown_authority'};
  return {authority: 'r2', programmeRunId: generation.programmeRunId, reason: null};
}

function yearOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d{4}/.test(value)) return Number(value.slice(0, 4));
  return null;
}

function rejectedIds(decision) {
  if (!Array.isArray(decision?.rejectedTmdbIds)) return [];
  const ids = [];
  for (const item of decision.rejectedTmdbIds) {
    const id = identityMovieId(item);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length === 8) break;
  }
  return ids;
}

// A title, however close, is not evidence. Callers that only have a title get this and no candidate.
export function identityFromTitle() {
  return {ok: false, reason: 'title_only', tmdbId: null};
}

// Whether one catalogue object (or its absence) supports assigning `tmdbId`. `film === undefined` means the catalogue
// was not read. A missing object trusts only the observation's own confirmed movie id, and still refuses when a read
// object says television or disagrees with itself.
export function catalogueFilmTrust(film, tmdbId, observation) {
  const id = identityMovieId(tmdbId);
  if (!id) return {ok: false, reason: 'invalid_movie_id'};
  if (film === undefined) return {ok: false, reason: 'catalogue_unread'};
  const confirmed = identityMovieId(observation?.confirmedTmdbId) === id;
  if (film === null) return confirmed ? {ok: true, reason: 'confirmed_tmdb', catalog: false} : {ok: false, reason: 'film_absent'};
  if (!identityObject(film)) return {ok: false, reason: 'identity_inconsistent'};
  const canon = typeof film.canonicalIdentity === 'string' ? film.canonicalIdentity : '';
  const storedId = film.id == null ? '' : String(film.id);
  if (canon.startsWith('tmdb_tv:') || film.mediaType === 'tv' || film.kind === 'tv' || storedId.startsWith('tmdb_tv')) return {ok: false, reason: 'tmdb_tv'};
  if (identityMovieId(film.tmdbId) !== id || canon !== 'tmdb:' + id) return {ok: false, reason: 'identity_inconsistent'};
  if (Array.isArray(film.conflictingTmdbIds) && film.conflictingTmdbIds.length) return {ok: false, reason: 'conflicting_identity'};
  if (film.identity?.conflicting === true) return {ok: false, reason: 'conflicting_identity'};
  const observedYear = yearOf(observation?.year);
  const filmYear = yearOf(film.year);
  if (observedYear === null && !confirmed) return {ok: false, reason: 'year_unknown'};
  if (filmYear === null && !confirmed) return {ok: false, reason: 'film_year_unknown'};
  if (observedYear !== null && filmYear !== null && Math.abs(observedYear - filmYear) > 1) return {ok: false, reason: 'year_conflict'};
  return {ok: true, reason: 'canonical_film', catalog: true};
}

function showWhen(series) {
  if (!series || series.state === 'unknown' || series.state === 'live_writer') return {when: 'none', at: null};
  if (series.state === 'continuing' || series.state === 'recovering') return {when: 'next_ordinary_chunk', at: null};
  if (series.state === 'waiting') return {when: 'after_series_wait', at: series.at || null};
  return {when: 'next_series', at: null};
}

// What the owner may do with one index record, before any id is chosen. Trusted candidates are only the observation's
// own confirmed movie id. The scorer's accepted id is a hypothesis, never a trusted candidate and never enough to assign.
export function identityOffer(input) {
  const record = identityObject(input?.record) ? input.record : null;
  const decision = identityObject(record?.decision) ? record.decision : null;
  const authority = identityStoreAuthority(input?.generation, input?.publishedEpg ?? null);
  const scope = input?.index?.scope === 'current_verified' ? 'current_verified' : 'current_unresolved_with_decision';
  const series = identityObject(input?.series) ? input.series : null;
  const confirmed = identityMovieId(record?.confirmedTmdbId);
  const hypothesis = identityMovieId(decision?.scoring?.acceptedTmdbId);
  const currentId = identityMovieId(decision?.tmdbId);
  const rejectable = [];
  for (const id of [currentId, hypothesis]) if (id && !rejectable.includes(id)) rejectable.push(id);
  const base = {
    capability: DISCOVERY_IDENTITY_CAPABILITY, version: DISCOVERY_IDENTITY_VERSION,
    trusted: confirmed ? [{tmdbId: confirmed, source: 'confirmed_tmdb'}] : [],
    hypothesis: hypothesis ? {tmdbId: hypothesis, source: 'scoring', trusted: false} : null,
    rejectable, rejectedTmdbIds: rejectedIds(decision),
    current: {status: decision?.status ?? null, tmdbId: currentId, ownerEffect: decision?.ownerIdentity?.effect === 'assign' || decision?.ownerIdentity?.effect === 'reject' ? decision.ownerIdentity.effect : null},
    coverage: {scope, complete: input?.index?.complete === true, awaitsFirstLookup: scope !== 'current_verified'},
    effect: showWhen(series), authority: authority.authority, programmeRunId: authority.programmeRunId,
  };
  const refuse = reason => ({...base, available: false, reason, effect: reason === 'eligible' ? base.effect : showWhen(series)});
  if (!authority.authority) return refuse('unknown_authority');
  if (!input?.index || input.index.state !== 'fresh') return refuse('index_not_current');
  if (input.index.complete !== true) return refuse('index_incomplete');
  if (!record || !decision || typeof record.decisionHash !== 'string') return refuse(record ? 'evidence_incomplete' : 'target_absent');
  if (!series || series.state === 'unknown') return refuse('series_unknown');
  if (series.state === 'live_writer') return refuse('writer_active');
  if (decision.status === 'ambiguous' && !confirmed && !rejectable.length) return refuse('identity_ambiguous');
  return {...base, available: true, reason: 'eligible'};
}

function basisOf(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > BASIS_MAX || /[\u0000-\u001f]/.test(text)) return null;
  return text;
}

function alreadyRejected(decision, tmdbId) {
  const current = identityMovieId(decision?.tmdbId);
  if (current === tmdbId) return false;
  const owner = decision?.ownerIdentity;
  return rejectedIds(decision).includes(tmdbId) && owner?.effect === 'reject' && identityMovieId(owner.tmdbId) === tmdbId;
}

// `film` is the catalogue object for assign, null when that object is absent, and ignored for reject.
export function identityCommand(record, command, film) {
  const effect = command?.effect;
  if (effect !== 'assign' && effect !== 'reject') return {ok: false, reason: 'invalid_effect'};
  const tmdbId = identityMovieId(command?.tmdbId);
  if (!tmdbId) return {ok: false, reason: 'invalid_movie_id'};
  const basis = basisOf(command?.basis);
  if (!basis) return {ok: false, reason: 'basis_required'};
  const decision = identityObject(record?.decision) ? record.decision : {};
  if (effect === 'reject') {
    const allowed = [identityMovieId(decision.tmdbId), identityMovieId(decision.scoring?.acceptedTmdbId)].filter(Boolean);
    if (!allowed.includes(tmdbId)) return {ok: false, reason: 'not_on_decision'};
    if (alreadyRejected(decision, tmdbId)) return {ok: false, reason: 'already_current'};
    return {ok: true, reason: 'eligible', effect, tmdbId, basis, catalog: false};
  }
  const confirmed = identityMovieId(record?.confirmedTmdbId);
  if (decision.status === 'ambiguous' && tmdbId !== confirmed) return {ok: false, reason: 'ambiguous_needs_stronger'};
  const trust = catalogueFilmTrust(film, tmdbId, {year: record?.year, confirmedTmdbId: confirmed});
  if (!trust.ok) return {ok: false, reason: trust.reason};
  if (decision.status === 'verified' && identityMovieId(decision.tmdbId) === tmdbId && decision.ownerIdentity?.effect === 'assign') return {ok: false, reason: 'already_current'};
  return {ok: true, reason: 'eligible', effect, tmdbId, basis, catalog: trust.catalog === true};
}

export function identityIssue(key, offer, command) {
  const commandOk = command?.ok === true;
  const reason = commandOk ? 'eligible' : command?.reason || offer?.reason || 'not_eligible';
  const unknown = !commandOk && IDENTITY_UNKNOWN.has(reason);
  const eligible = commandOk && offer?.available ? true : unknown ? null : false;
  return {
    id: DISCOVERY_IDENTITY_CAPABILITY + ':' + key,
    subject: {kind: 'observation', id: key},
    action: {code: DISCOVERY_IDENTITY_CAPABILITY, eligible, reason},
    evidence: {completeness: unknown ? 'partial' : 'complete'},
  };
}

// The next decision object. Assign verifies this id and clears the terminal fence. Reject blocks that one id, clears
// the terminal fence and the retry time so the next ordinary chunk may evaluate a different id, and does not touch
// any other observation. The rejected id itself is not fetched as movie detail.
export function appliedIdentityDecision(previous, command, {at, requestId, programmeRunId}) {
  const prior = identityObject(previous) ? previous : {};
  const rejected = rejectedIds(prior).filter(id => id !== command.tmdbId);
  const ownerIdentity = {
    effect: command.effect, tmdbId: command.tmdbId, basis: command.basis, at, requestId, programmeRunId,
    capability: DISCOVERY_IDENTITY_CAPABILITY + '@' + DISCOVERY_IDENTITY_VERSION,
  };
  if (command.effect === 'assign') {
    return {
      ...prior,
      status: 'verified', tmdbId: command.tmdbId, filmId: 'tmdb_' + command.tmdbId, canonicalIdentity: 'tmdb:' + command.tmdbId,
      identitySource: 'owner', terminalReason: null, retryAt: null, checkedAt: at, ownerIdentity,
      rejectedTmdbIds: rejected,
    };
  }
  const clears = identityMovieId(prior.tmdbId) === command.tmdbId;
  const nextRejected = rejectedIds({rejectedTmdbIds: [...rejectedIds(prior), command.tmdbId]});
  return {
    ...prior,
    status: prior.status === 'verified' || typeof prior.status !== 'string' || !prior.status ? 'needs_verification' : prior.status,
    tmdbId: clears ? null : prior.tmdbId ?? null,
    filmId: clears ? null : prior.filmId ?? null,
    canonicalIdentity: clears ? null : prior.canonicalIdentity ?? null,
    identitySource: clears ? null : prior.identitySource ?? null,
    terminalReason: null, retryAt: null,
    ownerIdentity, rejectedTmdbIds: nextRejected,
  };
}

// What the write itself changes, and what it deliberately leaves to the next ordinary chunk. `catalog` is whether the
// assign target was present as a canonical film at execution.
export function identityApplication(effect, offer, command) {
  if (effect === 'reject') return {decision: 'written', shows: 'not_this_action', catalog: null, consumers: ['resolution_decision']};
  const catalog = command?.catalog === true;
  return {decision: 'written', shows: catalog ? (offer?.effect?.when || 'next_series') : 'awaiting_catalog_film', catalog, consumers: ['resolution_decision']};
}
