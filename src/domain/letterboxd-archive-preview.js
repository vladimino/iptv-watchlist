// The owner's Letterboxd archive preview (ADR 0066): from the parsed export, the matching and the per-fact outcomes the
// Worker computed against R2, one bounded answer the admin page shows. Pure: no storage, network or clock of its own.
// Everything it returns is a proposal; nothing here decides a write. Bundled into the Worker by `scoped` as
// LetterboxdArchivePreview; tests import it directly. Contract: docs/reference/api/admin.md.
export const PREVIEW_SCHEMA_VERSION = 1;
export const PREVIEW_LIMITS = Object.freeze({detailRows: 25, maxRecordReads: 300, recordReadConcurrency: 6});
export const PREVIEW_FILES = Object.freeze({watched: 'watched.csv', ratings: 'ratings.csv', watchlist: 'watchlist.csv', diary: 'diary.csv'});
export const PREVIEW_OUTCOMES = Object.freeze(['new', 'replaces', 'unchanged', 'older', 'tie', 'unverified']);
const FACTS = ['watched', 'rating', 'watchlist'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/;
const EARLIEST = Date.UTC(2011, 0, 1);

// The export time: Letterboxd's archive name, or an owner-declared UTC time for a renamed archive, never both. A time later
// than now or before Letterboxd exports existed is refused, as the baseline route refuses it.
export function resolveGeneratedAt({named, declared, now}) {
  const text = typeof declared === 'string' ? declared.trim() : '';
  let generatedAt, source;
  if (named) {
    if (text) return {error: 'generated_at_conflict'};
    generatedAt = named;
    source = 'archive_name';
  } else {
    if (!text) return {error: 'generated_at_required'};
    if (!ISO.test(text) || !Number.isFinite(Date.parse(text))) return {error: 'generated_at_invalid'};
    generatedAt = new Date(text).toISOString();
    source = 'owner_declared';
  }
  const at = Date.parse(generatedAt);
  if (at > now) return {error: 'generated_at_future'};
  if (at < EARLIEST) return {error: 'generated_at_too_old'};
  return {generatedAt, source};
}

// The facts one accepted export film shows, as the baseline import plans them: absence is not an observation, so
// watched: false and watchlist: false never appear, and a rated film is also watched.
export function proposedFacts(film) {
  const facts = {}, effectiveOn = {};
  if (film.inWatched || film.inRatings) {
    facts.watched = true;
    if (film.watchedDate) effectiveOn.watched = film.watchedDate;
  }
  if (film.inRatings) facts.rating = film.rating;
  else if (film.inWatched) facts.rating = null;
  if (film.inWatchlist) facts.watchlist = true;
  return {facts, effectiveOn};
}

const zero = names => Object.fromEntries(names.map(name => [name, 0]));
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function exportSummary(parsed) {
  const files = {};
  for (const [kind, name] of Object.entries(PREVIEW_FILES)) {
    const stats = parsed.files[kind] || {present: false};
    files[kind] = stats.present ? {name, present: true, records: stats.records, valid: stats.valid, invalid: {...stats.invalid}, duplicates: stats.duplicates, conflicts: stats.conflicts, missingYear: stats.missingYear, auxiliary: kind === 'diary'} : {name, present: false, auxiliary: kind === 'diary'};
  }
  const invalidByReason = {};
  for (const row of parsed.invalidRows) invalidByReason[row.reason] = (invalidByReason[row.reason] || 0) + 1;
  return {files, sets: Object.fromEntries(Object.entries(parsed.sets).map(([name, codes]) => [name, codes.length])), films: parsed.films.length, crossFileMismatches: parsed.crossFileMismatches, invalidRows: parsed.invalidRows.length, invalidByReason};
}

function row(film, match, extra = {}) {
  return {code: film.code, name: film.name, year: film.year, status: match?.status ?? null, method: match?.method ?? null, reason: match?.reason ?? null, ...extra};
}
function bounded(list, limit) {return {total: list.length, rows: list.slice(0, limit)};}

// needsFreshArchive is only a proven reason: the export is older than the threshold, or a compared rating is newer.
// verified also needs the ratings file, a complete match and a complete proposal. A gap is ratings_unconfirmed and
// does not by itself ask for a new archive. object_missing stays evidence of absence: only unavailable opens a gap.
function previewFreshness({ageMs, archiveStaleMs, ratingsNewer, unchecked}) {
  const proven = [];
  if (ageMs > archiveStaleMs) proven.push('archive_stale');
  if (ratingsNewer > 0) proven.push('ratings_newer_in_r2');
  const reasons = unchecked ? [...proven, 'ratings_unconfirmed'] : proven;
  const verdict = proven.length ? 'needs_fresh' : unchecked ? 'inconclusive' : 'verified';
  const freshness = {needsFreshArchive: verdict === 'needs_fresh', verdict, reasons, archiveStaleMs, ageMs};
  if (typeof ratingsNewer === 'number') freshness.ratingsNewerInR2 = ratingsNewer;
  return freshness;
}

// input: {archive, parsed, comparison, now, archiveStaleMs, limits}
//  archive: {sha256, bytes, entries, ignoredEntries, nameStandard, generatedAt, generatedAtSource, files: {<name>: {sha256, bytes}}}
//  parsed: parseExport() of the archive's CSV texts
//  comparison: null when R2 was not read, else {sources, omitted, consistency, receipt, matches, hypothesis, indexSummary, items}
//   items: one per accepted film, {code, lid, tmdb, facts, effectiveOn, state, reason?, outcomes: [{fact, outcome, tie, current}]}
export function buildPreview({archive, parsed, comparison, now, archiveStaleMs, limits = PREVIEW_LIMITS}) {
  const films = new Map(parsed.films.map(film => [film.code, film]));
  const missing = Object.entries(PREVIEW_FILES).filter(([kind]) => !parsed.files[kind]?.present).map(([, name]) => name);
  const ageMs = Math.max(0, now - Date.parse(archive.generatedAt));
  const answer = {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    mode: 'preview',
    writes: false,
    evaluatedAt: new Date(now).toISOString(),
    archive: {sha256: archive.sha256, bytes: archive.bytes, entries: archive.entries, ignoredEntries: archive.ignoredEntries, nameStandard: archive.nameStandard, generatedAt: archive.generatedAt, generatedAtSource: archive.generatedAtSource, ageMs, files: archive.files},
    completeness: {status: missing.length ? 'partial' : 'complete', missing},
    export: exportSummary(parsed),
    baseline: {status: 'unknown', reason: 'no_bounded_summary', confirmedAt: null, sha256: null, thisArchive: comparison?.receipt ?? {status: 'not_read', committedAt: null}},
  };
  if (!comparison) {
    answer.freshness = previewFreshness({ageMs, archiveStaleMs, ratingsNewer: null, unchecked: true});
    answer.matching = {status: 'unavailable'};
    answer.proposal = {status: 'unavailable'};
    answer.status = 'partial';
    answer.details = {limit: limits.detailRows, invalidRows: bounded(parsed.invalidRows, limits.detailRows)};
    return answer;
  }
  const byStatus = zero(['accepted', 'provisional', 'candidate', 'ambiguous', 'conflict', 'unmatched']), byMethod = zero(['lid_exact', 'tmdb_verified', 'title_year']), matchReasons = {};
  for (const match of comparison.matches) {
    byStatus[match.status] = (byStatus[match.status] || 0) + 1;
    if (match.status === 'accepted' && match.method) byMethod[match.method]++;
    if (match.reason) matchReasons[match.reason] = (matchReasons[match.reason] || 0) + 1;
  }
  const failedSources = Object.entries(comparison.sources).filter(([, source]) => source.evidence === 'unavailable').map(([name]) => name);
  answer.matching = {
    status: failedSources.includes('programme') || failedSources.includes('metadata') || failedSources.includes('ratingsGeneration') ? 'partial' : 'complete',
    sources: comparison.sources, omitted: comparison.omitted, index: comparison.indexSummary,
    byStatus, acceptedByMethod: byMethod, reasons: Object.fromEntries(Object.entries(matchReasons).sort(([a], [b]) => a < b ? -1 : 1)),
    lidHypothesis: comparison.hypothesis,
  };
  const facts = zero(PREVIEW_OUTCOMES), byFact = Object.fromEntries(FACTS.map(fact => [fact, zero(PREVIEW_OUTCOMES)]));
  const state = {compared: 0, unverified: 0, alias_conflict: 0, invalid_identity: 0};
  const adds = [], updates = [], heldNewer = [], unverified = [], conflicts = [];
  const matchByCode = new Map(comparison.matches.map(match => [match.code, match]));
  for (const item of comparison.items) {
    state[item.state] = (state[item.state] || 0) + 1;
    const film = films.get(item.code), match = matchByCode.get(item.code);
    const outcomes = {}, current = {};
    for (const entry of item.outcomes) {
      facts[entry.outcome]++;
      byFact[entry.fact][entry.outcome]++;
      if (entry.tie) {facts.tie++; byFact[entry.fact].tie++;}
      outcomes[entry.fact] = entry.outcome;
      if (entry.current) current[entry.fact] = entry.current;
    }
    const detail = row(film, match, {facts: item.facts, outcomes, current});
    if (item.state === 'alias_conflict' || item.state === 'invalid_identity') conflicts.push({...detail, held: item.state});
    else if (item.state === 'unverified') unverified.push({...detail, held: item.reason || 'record_not_read'});
    else {
      if (item.outcomes.some(entry => entry.outcome === 'new')) adds.push(detail);
      if (item.outcomes.some(entry => entry.outcome === 'replaces' && (!entry.current || !sameValue(entry.current.value, item.facts[entry.fact])))) updates.push(detail);
      if (item.outcomes.some(entry => entry.outcome === 'older')) heldNewer.push(detail);
    }
  }
  const identity = comparison.matches.filter(match => match.status !== 'accepted').map(match => row(films.get(match.code), match, {candidates: match.candidates.length}));
  const unstable = comparison.consistency.status !== 'stable';
  const factsFailed = ['links', 'filmsListSummary', 'watchlistSummary'].filter(name => comparison.sources[name]?.evidence === 'unavailable');
  const proposalReasons = [...factsFailed.map(name => 'source_unavailable:' + name), ...(state.unverified ? ['records_not_read'] : []), ...(unstable ? ['facts_changed_during_read'] : [])];
  answer.proposal = {
    status: factsFailed.length === 3 ? 'unavailable' : proposalReasons.length ? 'partial' : 'complete',
    reasons: proposalReasons,
    films: {accepted: byStatus.accepted, compared: state.compared, unverified: state.unverified, aliasConflict: state.alias_conflict, invalidIdentity: state.invalid_identity, heldForIdentity: identity.length},
    facts, byFact,
    recordReads: comparison.recordReads,
  };
  const ratingsNewer = byFact.rating.older;
  const ratingsUnchecked = missing.includes('ratings.csv') || answer.matching.status !== 'complete' || answer.proposal.status !== 'complete';
  answer.freshness = previewFreshness({ageMs, archiveStaleMs, ratingsNewer, unchecked: ratingsUnchecked});
  answer.consistency = comparison.consistency;
  answer.status = answer.completeness.status === 'complete' && answer.matching.status === 'complete' && answer.proposal.status === 'complete' ? 'complete' : 'partial';
  const limit = limits.detailRows;
  answer.details = {
    limit,
    adds: bounded(adds, limit), updates: bounded(updates, limit), heldNewer: bounded(heldNewer, limit),
    unverified: bounded(unverified, limit), conflicts: bounded(conflicts, limit), identity: bounded(identity, limit),
    invalidRows: bounded(parsed.invalidRows, limit),
  };
  return answer;
}
