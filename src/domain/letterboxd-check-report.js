// AIR-599 / ADR 0207 decision 4b: the read-only LEGACY report of the shared Letterboxd check, the input of the bounded owner recovery (card DR). Pure: no I/O, no clock.
// The old rules charged transport stops as attempts (Diary) and ended ledger rows by age (`age_exceeded`). The stored state keeps only the LAST reason of each entry or row, so the report says which ones
// MAY have been exhausted by transport; it does not claim to know. Nothing here resets anything: recovery is the owner `requeue`, in batches of at most 50 named ids, under an L2 contract.
// Inputs: `diary` the Diary check document {films:{lid:{reason,attempts,...}}}; `ledger` rows {lid,state,attempts,lastReason,onWatchlist}; `maxAttempts` the cap (6).
// Counts are always returned; ids only with `withIds` (ids are private: they go to the owner's L2 contract, never to public evidence).

// The transport reasons of the OLD rules (letterboxd-diary-identity.js before AIR-599): `fetch_failed` then mixed a 404, a 5xx and a network error, and `oversized` was charged as transport.
export const LEGACY_TRANSPORT = ['forbidden', 'rate_limited', 'challenge', 'timeout', 'tmdb_unavailable'];
export const LEGACY_AMBIGUOUS = ['fetch_failed', 'oversized'];
const BATCH = 50;

const countBy = (items, key) => {
  const out = {};
  for (const item of items) out[key(item)] = (out[key(item)] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};
const chunks = ids => {
  const out = [];
  for (let i = 0; i < ids.length; i += BATCH) out.push(ids.slice(i, i + BATCH));
  return out;
};

export function legacyReport({diary, ledger = [], maxAttempts = 6, withIds = false} = {}) {
  const films = diary && typeof diary.films === 'object' && diary.films ? diary.films : {};
  const atCap = Object.entries(films).filter(([, entry]) => entry && entry.reason !== 'owner_dismissed' && (Number(entry.attempts) || 0) >= maxAttempts).map(([lid, entry]) => ({lid, reason: String(entry.reason || 'unknown')}));
  const rows = (Array.isArray(ledger) ? ledger : []).filter(row => row && typeof row.lid === 'string');
  const aged = rows.filter(row => row.state === 'terminal' && row.lastReason === 'age_exceeded');
  const exhaustedTransport = rows.filter(row => row.state === 'terminal' && LEGACY_TRANSPORT.includes(row.lastReason));
  const exhaustedAmbiguous = rows.filter(row => row.state === 'terminal' && LEGACY_AMBIGUOUS.includes(row.lastReason));
  // The bounded recovery set: `age_exceeded` rows whose id is still on the Watchlist, and entries and rows whose last reason is transport. Everything else stays for owner review, one at a time.
  const recoverEntries = atCap.filter(item => LEGACY_TRANSPORT.includes(item.reason)).map(item => item.lid).sort();
  const recoverRows = [...new Set([...aged.filter(row => row.onWatchlist === true).map(row => row.lid), ...exhaustedTransport.map(row => row.lid)])].sort();
  const report = {
    note: 'The stored state keeps only the last reason; these entries and rows MAY have been exhausted by transport. Nothing is reset by this report.',
    diaryAtCap: {count: atCap.length, byLastReason: countBy(atCap, item => item.reason)},
    ledgerAgeExceeded: {count: aged.length, onWatchlist: aged.filter(row => row.onWatchlist === true).length, offWatchlist: aged.filter(row => row.onWatchlist === false).length, unknown: aged.filter(row => typeof row.onWatchlist !== 'boolean').length},
    ledgerExhaustedTransport: {count: exhaustedTransport.length, byLastReason: countBy(exhaustedTransport, row => row.lastReason)},
    ledgerExhaustedAmbiguous: {count: exhaustedAmbiguous.length, byLastReason: countBy(exhaustedAmbiguous, row => row.lastReason)},
    recovery: {entries: recoverEntries.length, rows: recoverRows.length, batches: chunks(recoverEntries).length + chunks(recoverRows).length, batchLimit: BATCH},
  };
  if (withIds) report.ids = {diaryAtCap: atCap.map(item => item.lid).sort(), recoverEntryBatches: chunks(recoverEntries), recoverRowBatches: chunks(recoverRows), ownerReview: [...new Set([...atCap.filter(item => !LEGACY_TRANSPORT.includes(item.reason)).map(item => item.lid), ...exhaustedAmbiguous.map(row => row.lid), ...aged.filter(row => row.onWatchlist !== true).map(row => row.lid)])].sort()};
  return report;
}
