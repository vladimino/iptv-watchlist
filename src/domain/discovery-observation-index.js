// The generation-scoped observation index: a bounded projection of the current unresolved discovery observations that
// already have a resolution decision, so that owner reads can explain one observation, or list them, without parsing the
// discovery ledger or the resolution map. Pure and deterministic: no I/O, no clock, no hashing of its own. The resolver
// chunk decides which ledger candidates belong in the index (it owns `candidateActivity` and the title screening) and
// passes them here with their decisions; this module shapes the records, shards them, bounds them, builds the manifest
// and validates what a reader loads back. The adapter supplies the SHA-256 digests (`decisionHash`, shard `revision`).
//
// Layout under the published generation: epg/generations/<run>/discovery-observations/manifest.json and shard-00..15.json.
// The manifest is written last and names the revision of every shard, the etags of the resolution map and of the
// generation ledger it was derived from, and its coverage. A reader that finds another generation, a shard whose revision
// differs from the manifest, or a source etag that moved since, treats the index as not current.

export const OBSERVATION_INDEX_VERSION = 1;
export const OBSERVATION_INDEX_SHARDS = 16;
export const OBSERVATION_INDEX_MAX_ITEMS = 3000;
export const OBSERVATION_INDEX_MAX_SHOWS = 96;
export const OBSERVATION_INDEX_SCOPE = 'current_unresolved_with_decision';
export const OBSERVATION_INDEX_WRITERS = ['resolver_chunk', 'discovery_reconsider'];
export const OBSERVATION_INDEX_STATES = ['fresh', 'stale', 'missing', 'other_generation', 'malformed', 'torn', 'unavailable'];

const INDEX_DIRECTORY = 'discovery-observations';
const KEY_MAX = 200;
const TEXT_MAX = 200;
const DURATIONS_MAX = 24;
const DECISION_TEXT_FIELDS = ['status', 'evidenceKey', 'retryAt', 'terminalReason', 'lastAttemptAt', 'checkedAt'];
const PRIORITY = {terminal: 0, ambiguous: 1, needs_verification: 2, other: 3};

function indexObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function indexText(value, max = TEXT_MAX) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

function indexNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function indexCompare(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

// Canonical JSON: object keys sorted, so the same value always serializes to the same text (and the same digest).
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (indexObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value ?? null);
}

export function observationKeyValid(key) {
  return typeof key === 'string' && key.length >= 1 && key.length <= KEY_MAX && !/[\u0000-\u001f]/.test(key);
}

export function observationIndexPrefix(programmeRunId) {
  return `epg/generations/${programmeRunId}/${INDEX_DIRECTORY}/`;
}

export function observationIndexManifestKey(programmeRunId) {
  return observationIndexPrefix(programmeRunId) + 'manifest.json';
}

export function observationShardName(shard) {
  return String(shard).padStart(2, '0');
}

export function observationIndexShardKey(programmeRunId, shard) {
  return observationIndexPrefix(programmeRunId) + 'shard-' + observationShardName(shard) + '.json';
}

// FNV-1a over the UTF-16 code units of the key. Placement only; nothing compares keys by this value.
export function observationShard(key) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193) >>> 0;
  return hash % OBSERVATION_INDEX_SHARDS;
}

// The decision fields an owner read needs. The full decision is what `decisionHash` covers; this subset is what is shown
// and what the recovery assessment reads.
export function observationDecisionView(decision) {
  if (!indexObject(decision)) return null;
  const view = {};
  for (const field of DECISION_TEXT_FIELDS) view[field] = typeof decision[field] === 'string' ? decision[field] : null;
  view.attempts = Number.isInteger(decision.attempts) && decision.attempts >= 0 ? decision.attempts : null;
  const marker = indexObject(decision.reconsidered) ? decision.reconsidered : null;
  view.reconsidered = marker ? {at: indexText(marker.at, 40), idempotencyKey: indexText(marker.idempotencyKey, 80), previousTerminalReason: indexText(marker.previousTerminalReason, 80)} : null;
  return view;
}

function showView(show) {
  if (!indexObject(show)) return null;
  const start = indexNumber(show.start);
  if (start === null) return null;
  const channelId = typeof show.channelId === 'string' || typeof show.channelId === 'number' ? show.channelId : null;
  return {channelId, channel: indexText(show.channel, 80), start};
}

// One index record, or the reason the candidate cannot be indexed faithfully. A record must reproduce the resolver's
// evidence key exactly, so a show list that is too long or holds an unreadable show is omitted rather than trimmed.
export function observationIndexRecord(candidate, decision, programmeRunId) {
  if (!indexObject(candidate) || !observationKeyValid(candidate.key)) return {omit: 'malformed'};
  if (!indexObject(decision) || typeof decision.status !== 'string' || !decision.status) return {omit: 'malformed'};
  let shows = null;
  if (candidate.shows !== undefined && candidate.shows !== null) {
    if (!Array.isArray(candidate.shows)) return {omit: 'malformed'};
    if (candidate.shows.length > OBSERVATION_INDEX_MAX_SHOWS) return {omit: 'oversized'};
    shows = candidate.shows.map(showView);
    if (shows.some(show => show === null)) return {omit: 'malformed'};
    shows.sort((left, right) => left.start - right.start || indexCompare(left.channelId ?? '', right.channelId ?? ''));
  }
  let durations = null;
  if (candidate.durations !== undefined && candidate.durations !== null) {
    if (!Array.isArray(candidate.durations) || candidate.durations.length > DURATIONS_MAX) return {omit: 'malformed'};
    durations = candidate.durations.filter(value => typeof value === 'number' && Number.isFinite(value));
  }
  const year = typeof candidate.year === 'number' && Number.isFinite(candidate.year) ? candidate.year : typeof candidate.year === 'string' && candidate.year ? candidate.year.slice(0, 8) : null;
  return {record: {
    key: candidate.key,
    programmeRunId,
    title: indexText(candidate.title),
    normalizedTitle: typeof candidate.normalizedTitle === 'string' ? candidate.normalizedTitle.slice(0, KEY_MAX) : null,
    year,
    durations,
    shows,
    seenInLatestSnapshot: typeof candidate.seenInLatestSnapshot === 'boolean' ? candidate.seenInLatestSnapshot : null,
    lastSeenAt: indexNumber(candidate.lastSeenAt),
    lastAiring: indexNumber(candidate.lastAiring),
    confirmedTmdbId: candidate.confirmedTmdbId == null || candidate.confirmedTmdbId === '' ? null : String(candidate.confirmedTmdbId).slice(0, 20),
    decision: observationDecisionView(decision),
  }};
}

function recordPriority(record) {
  const decision = record.decision || {};
  if (decision.terminalReason) return PRIORITY.terminal;
  if (decision.status === 'ambiguous') return PRIORITY.ambiguous;
  if (decision.status === 'needs_verification') return PRIORITY.needs_verification;
  return PRIORITY.other;
}

// The index content from the candidates the resolver selected: `entries` = [{candidate, decision}] (current, unscreened,
// unresolved, with a decision). Records are bounded by OBSERVATION_INDEX_MAX_ITEMS; when the cap cuts, terminal records
// come first, then ambiguous ones, then the rest, each by key, and the coverage says what was left out.
export function buildObservationIndex({programmeRunId, entries}) {
  if (typeof programmeRunId !== 'string' || !programmeRunId) return {error: 'invalid_generation'};
  if (!Array.isArray(entries)) return {error: 'invalid_entries'};
  const records = [], omitted = {cap: 0, oversized: 0, malformed: 0}, seen = new Set();
  for (const entry of entries) {
    const shaped = observationIndexRecord(entry?.candidate, entry?.decision, programmeRunId);
    if (shaped.omit) {omitted[shaped.omit]++; continue;}
    if (seen.has(shaped.record.key)) {omitted.malformed++; continue;}
    seen.add(shaped.record.key);
    records.push(shaped.record);
  }
  records.sort((left, right) => recordPriority(left) - recordPriority(right) || indexCompare(left.key, right.key));
  const kept = records.slice(0, OBSERVATION_INDEX_MAX_ITEMS);
  omitted.cap = records.length - kept.length;
  const shards = Array.from({length: OBSERVATION_INDEX_SHARDS}, () => []);
  for (const record of kept) shards[observationShard(record.key)].push(record);
  for (const shard of shards) shard.sort((left, right) => indexCompare(left.key, right.key));
  const eligible = entries.length;
  return {
    shards,
    coverage: {scope: OBSERVATION_INDEX_SCOPE, eligible, indexed: kept.length, omitted, complete: kept.length === eligible, maxItems: OBSERVATION_INDEX_MAX_ITEMS},
  };
}

export function observationShardDocument(programmeRunId, shard, items, revision) {
  return {schemaVersion: OBSERVATION_INDEX_VERSION, kind: 'discovery_observation_shard', programmeRunId, shard: observationShardName(shard), revision, items};
}

// `writer` = {kind, hopId?, idempotencyKey?}; `sources` = {resolutionEtag, ledgerEtag}; `shards` = [{items, revision}].
export function observationIndexManifest({programmeRunId, writtenAt, writer, sources, shards, coverage, counts}) {
  return {
    schemaVersion: OBSERVATION_INDEX_VERSION,
    kind: 'discovery_observation_index',
    programmeRunId,
    writtenAt,
    writer: {kind: writer?.kind ?? null, hopId: writer?.hopId ?? null, idempotencyKey: writer?.idempotencyKey ?? null},
    sources: {resolutionEtag: sources?.resolutionEtag ?? null, ledgerEtag: sources?.ledgerEtag ?? null},
    shardCount: OBSERVATION_INDEX_SHARDS,
    shards: shards.map((shard, index) => ({shard: observationShardName(index), items: shard.items, revision: shard.revision})),
    coverage,
    counts: counts ?? null,
  };
}

function revisionValid(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

// A manifest as a reader loaded it. Anything this module would not have written is `malformed`; a manifest of another
// generation is `other_generation`.
export function readObservationIndexManifest(raw, programmeRunId) {
  if (raw === null || raw === undefined) return {ok: false, state: 'missing'};
  if (!indexObject(raw) || raw.kind !== 'discovery_observation_index' || raw.schemaVersion !== OBSERVATION_INDEX_VERSION) return {ok: false, state: 'malformed'};
  if (typeof raw.programmeRunId !== 'string' || !raw.programmeRunId) return {ok: false, state: 'malformed'};
  if (raw.programmeRunId !== programmeRunId) return {ok: false, state: 'other_generation', programmeRunId: raw.programmeRunId};
  if (typeof raw.writtenAt !== 'string' || !Number.isFinite(Date.parse(raw.writtenAt))) return {ok: false, state: 'malformed'};
  if (!indexObject(raw.writer) || !OBSERVATION_INDEX_WRITERS.includes(raw.writer.kind)) return {ok: false, state: 'malformed'};
  if (!indexObject(raw.sources) || typeof raw.sources.resolutionEtag !== 'string' || !raw.sources.resolutionEtag || typeof raw.sources.ledgerEtag !== 'string' || !raw.sources.ledgerEtag) return {ok: false, state: 'malformed'};
  if (raw.shardCount !== OBSERVATION_INDEX_SHARDS || !Array.isArray(raw.shards) || raw.shards.length !== OBSERVATION_INDEX_SHARDS) return {ok: false, state: 'malformed'};
  for (let index = 0; index < OBSERVATION_INDEX_SHARDS; index++) {
    const shard = raw.shards[index];
    if (!indexObject(shard) || shard.shard !== observationShardName(index) || !Number.isInteger(shard.items) || shard.items < 0 || shard.items > OBSERVATION_INDEX_MAX_ITEMS || !revisionValid(shard.revision)) return {ok: false, state: 'malformed'};
  }
  if (!indexObject(raw.coverage) || raw.coverage.scope !== OBSERVATION_INDEX_SCOPE || !Number.isInteger(raw.coverage.indexed) || typeof raw.coverage.complete !== 'boolean') return {ok: false, state: 'malformed'};
  if (raw.shards.reduce((sum, shard) => sum + shard.items, 0) !== raw.coverage.indexed) return {ok: false, state: 'malformed'};
  return {ok: true, state: 'readable', manifest: raw};
}

function recordValid(record, programmeRunId, shard) {
  if (!indexObject(record) || !observationKeyValid(record.key) || record.programmeRunId !== programmeRunId) return false;
  if (observationShard(record.key) !== shard) return false;
  if (!revisionValid(record.decisionHash)) return false;
  if (!indexObject(record.decision) || typeof record.decision.status !== 'string' || !record.decision.status) return false;
  if (record.shows !== null && !(Array.isArray(record.shows) && record.shows.every(show => indexObject(show) && indexNumber(show.start) !== null))) return false;
  if (record.durations !== null && !Array.isArray(record.durations)) return false;
  return true;
}

// One shard as a reader loaded it, checked against the manifest that names it: same generation, same shard, the same
// revision and item count, and every record valid and placed in this shard. A revision that differs is `torn` (a shard
// written after the manifest, or a manifest written without it).
export function readObservationIndexShard(raw, manifest, shard) {
  const entry = manifest.shards[shard];
  if (raw === null || raw === undefined) return entry.items === 0 ? {ok: true, items: []} : {ok: false, state: 'torn'};
  if (!indexObject(raw) || raw.kind !== 'discovery_observation_shard' || raw.schemaVersion !== OBSERVATION_INDEX_VERSION || raw.programmeRunId !== manifest.programmeRunId || raw.shard !== observationShardName(shard)) return {ok: false, state: 'malformed'};
  if (raw.revision !== entry.revision || !Array.isArray(raw.items) || raw.items.length !== entry.items) return {ok: false, state: 'torn'};
  if (!raw.items.every(record => recordValid(record, manifest.programmeRunId, shard))) return {ok: false, state: 'malformed'};
  return {ok: true, items: raw.items};
}

// Whether a readable manifest still describes the sources: the published generation, the resolution map and the
// generation ledger, compared by the etags the reader saw now.
export function observationIndexFreshness(manifest, current) {
  const reasons = [];
  if (manifest.programmeRunId !== current?.programmeRunId) reasons.push('generation_changed');
  if (current?.resolutionEtag === undefined || current.resolutionEtag === null) reasons.push('resolution_unread');
  else if (manifest.sources.resolutionEtag !== current.resolutionEtag) reasons.push('resolution_changed');
  if (current?.ledgerEtag === undefined || current.ledgerEtag === null) reasons.push('ledger_unread');
  else if (manifest.sources.ledgerEtag !== current.ledgerEtag) reasons.push('ledger_changed');
  return {state: reasons.length ? 'stale' : 'fresh', reasons};
}

// Data health observation entries from index records, observed when the index was written.
export function observationHealthEntries(records, observedAt) {
  return records.map(record => ({
    key: record.key, programmeRunId: record.programmeRunId, observedAt,
    status: record.decision.status, retryAt: record.decision.retryAt, lastAttemptAt: record.decision.lastAttemptAt,
    checkedAt: record.decision.checkedAt, attempts: record.decision.attempts, terminalReason: record.decision.terminalReason,
  }));
}

// The observation as the recovery assessment reads it. `nonfilmReason` is the caller's screening of the title now.
export function observationAssessmentInput(record, nonfilmReason) {
  return {
    key: record.key, programmeRunId: record.programmeRunId, normalizedTitle: record.normalizedTitle, year: record.year,
    durations: record.durations, shows: record.shows, seenInLatestSnapshot: record.seenInLatestSnapshot,
    lastSeenAt: record.lastSeenAt, lastAiring: record.lastAiring, confirmedTmdbId: record.confirmedTmdbId,
    nonfilmReason: nonfilmReason ?? null,
  };
}
