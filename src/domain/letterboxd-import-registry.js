// Derived archive registry for the Letterboxd rated-candidate queue (AIR-527, ADR 0170 section 5). Pure: no I/O, no clock.
// The registry object `letterboxd/imports/registry.json` is a droppable projection of the per-archive candidate documents. It is
// never an owner: a lost, stale or refused update changes no candidate, Film, receipt or decision.

export const REGISTRY_KEY = 'letterboxd/imports/registry.json';
export const REGISTRY_PREFIX = 'letterboxd/imports/';
export const REGISTRY_SCHEMA_VERSION = 1;
export const REGISTRY_MAX_BYTES = 256 * 1024;
export const REGISTRY_MAX_ARCHIVES = 500;
export const REGISTRY_STATES = ['pending', 'admitting', 'needs_review', 'verified', 'removed'];
const HEX64 = /^[0-9a-f]{64}$/;

export const candidateDocumentKey = sha => 'letterboxd/imports/' + sha + '/rated-candidates.json';
export function archiveOfCandidateKey(key) {
  const match = /^letterboxd\/imports\/([0-9a-f]{64})\/rated-candidates\.json$/.exec(String(key || ''));
  return match ? match[1] : null;
}
export const isArchiveSha = value => typeof value === 'string' && HEX64.test(value);

const bytesOf = value => new TextEncoder().encode(JSON.stringify(value)).length;
const emptyCounts = () => Object.fromEntries(REGISTRY_STATES.map(state => [state, 0]));

// What one candidate document says about itself. A row without a known state is not counted.
export function summarizeDocument(doc, {etag = null, now} = {}) {
  const counts = emptyCounts();
  let first = null;
  for (const item of Object.values(doc?.candidates && typeof doc.candidates === 'object' ? doc.candidates : {})) {
    if (!item || typeof item !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(counts, item.state)) counts[item.state]++;
    if (typeof item.registeredAt === 'string' && (first === null || item.registeredAt < first)) first = item.registeredAt;
  }
  // `revision` is the document's own mutation counter, raised by the compare-and-swap that wrote it: the only proof of mutation order.
  return {registeredAt: first, generatedAt: typeof doc?.generatedAt === 'string' ? doc.generatedAt : null, counts, documentEtag: typeof etag === 'string' && etag ? etag : null, revision: Number.isInteger(doc?.revision) && doc.revision >= 0 ? doc.revision : null, summarizedAt: now};
}

// A registry read from storage, or null when the value is not a registry of this schema. Rows that are not well formed are dropped.
export function parseRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== REGISTRY_SCHEMA_VERSION || !value.archives || typeof value.archives !== 'object' || Array.isArray(value.archives)) return null;
  const archives = {};
  for (const [sha, row] of Object.entries(value.archives)) {
    if (!HEX64.test(sha) || !row || typeof row !== 'object' || !row.counts || typeof row.counts !== 'object') continue;
    const counts = emptyCounts();
    for (const state of REGISTRY_STATES) counts[state] = Number.isInteger(row.counts[state]) && row.counts[state] >= 0 ? row.counts[state] : 0;
    archives[sha] = {registeredAt: typeof row.registeredAt === 'string' ? row.registeredAt : null, generatedAt: typeof row.generatedAt === 'string' ? row.generatedAt : null, counts, documentEtag: typeof row.documentEtag === 'string' ? row.documentEtag : null, revision: Number.isInteger(row.revision) && row.revision >= 0 ? row.revision : null, summarizedAt: typeof row.summarizedAt === 'string' ? row.summarizedAt : null};
  }
  return {schemaVersion: REGISTRY_SCHEMA_VERSION, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null, archives};
}

// The next registry after one archive's summary, or why it was not written. A summary of a document revision that is not newer than
// the row's never replaces it (ordered by the document's mutation revision, never by a clock: a delayed writer cannot overwrite a newer
// document's row, and equal-millisecond summaries are ordered too). A summary without a revision replaces only a row without one; a new archive beyond the cap, or a registry beyond its byte cap, is refused and leaves the archive `unindexed`.
export function applyArchive(registry, sha, summary, now) {
  if (!HEX64.test(String(sha || ''))) return {changed: false, refused: 'invalid_archive'};
  const base = registry ? parseRegistry(registry) : {schemaVersion: REGISTRY_SCHEMA_VERSION, updatedAt: null, archives: {}};
  if (!base) return {changed: false, refused: 'registry_invalid'};
  const prior = base.archives[sha];
  if (!prior && Object.keys(base.archives).length >= REGISTRY_MAX_ARCHIVES) return {changed: false, refused: 'registry_full'};
  if (prior && prior.revision !== null && (summary.revision === null || summary.revision <= prior.revision)) return {changed: false, refused: 'older_summary'};
  const row = {registeredAt: prior?.registeredAt || summary.registeredAt || now, generatedAt: summary.generatedAt, counts: summary.counts, documentEtag: summary.documentEtag, revision: summary.revision, summarizedAt: summary.summarizedAt};
  const next = {schemaVersion: REGISTRY_SCHEMA_VERSION, updatedAt: now, archives: {...base.archives, [sha]: row}};
  if (bytesOf(next) > REGISTRY_MAX_BYTES) return {changed: false, refused: 'registry_too_large'};
  return {changed: true, registry: next};
}

// Archives in the order of the candidate lane: registeredAt (an unknown time last), then sha.
export function orderedArchives(registry) {
  return Object.entries(registry?.archives || {}).map(([sha, row]) => ({sha, ...row})).sort((left, right) => {
    const a = left.registeredAt || '￿', b = right.registeredAt || '￿';
    return a < b ? -1 : a > b ? 1 : left.sha < right.sha ? -1 : left.sha > right.sha ? 1 : 0;
  });
}

// Enumeration is `complete` only when the listing was whole, every listed prefix is registered and every registry row is listed.
// It proves prefix presence only. `listing` is {prefixes: [sha...], truncated} or null when the listing could not be read.
export function enumerate(registry, listing) {
  const registered = registry ? Object.keys(registry.archives).length : 0;
  if (!listing) return {state: 'unknown', reason: 'listing_unavailable', registered, listed: null, unindexed: null, unindexedArchives: [], registryOrphans: null, orphanArchives: []};
  const listed = new Set(listing.prefixes);
  const unindexedArchives = [...listed].filter(sha => !registry || !registry.archives[sha]).sort();
  const orphanArchives = listing.truncated || !registry ? [] : Object.keys(registry.archives).filter(sha => !listed.has(sha)).sort();
  const orphans = listing.truncated ? null : orphanArchives.length;
  let reason = null;
  if (listing.truncated) reason = 'listing_truncated';
  else if (unindexedArchives.length) reason = 'unindexed_archives';
  else if (orphanArchives.length) reason = 'registry_orphans';
  return {state: reason ? 'partial' : 'complete', reason, registered, listed: listed.size, unindexed: unindexedArchives.length, unindexedArchives, registryOrphans: orphans, orphanArchives};
}

// Registry-wide estimate: the sum of the rows, labelled with the newest summary time. Never verified.
export function estimateCounts(registry) {
  const byStatus = emptyCounts();
  let summarizedAt = null;
  for (const row of Object.values(registry?.archives || {})) {
    for (const state of REGISTRY_STATES) byStatus[state] += row.counts[state];
    if (row.summarizedAt && (summarizedAt === null || row.summarizedAt > summarizedAt)) summarizedAt = row.summarizedAt;
  }
  return {basis: 'registry_estimate', summarizedAt, byStatus};
}
