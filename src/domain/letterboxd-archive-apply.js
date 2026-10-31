// Planning for a confirmed Letterboxd archive apply (ADR 0068). Pure: no storage, network or clock. The Worker hashes
// the texts this module builds and asks the guarded-action library whether one chunk may be confirmed. Nothing here
// writes, and a chunk contains only films the preview fully compared.
export const APPLY_BATCH_SIZE = 50;
export const APPLY_CAPABILITY_ID = 'letterboxd_archive_apply';
export const ROLLBACK_CAPABILITY_ID = 'letterboxd_archive_rollback';

// The baseline commit's item, in the key order `JSON.stringify` must keep so the plan hash matches the import receipt.
export function baselineItem(item) {
  return {lid: item.lid, tmdb: item.tmdb ?? null, facts: item.facts, effectiveOn: item.effectiveOn && Object.keys(item.effectiveOn).length ? item.effectiveOn : {}};
}

// Films the preview compared, in its order. Unverified, conflicting and invalid films are not approvable.
export function comparedFilms(items) {
  return (items || []).filter(item => item && item.state === 'compared' && item.facts && Object.keys(item.facts).length);
}

export function splitBatches(films) {
  const batches = [];
  for (let index = 0; index < films.length; index += APPLY_BATCH_SIZE) {
    const slice = films.slice(index, index + APPLY_BATCH_SIZE);
    batches.push({chunk: batches.length, films: slice, items: slice.map(baselineItem)});
  }
  return batches;
}

export function planText(items) {
  return JSON.stringify(items);
}

// The version of one film binds the plan and the comparison the owner saw. A newer stored fact changes it.
export function versionText(item) {
  const outcome = {}, current = {};
  for (const entry of item.outcomes || []) {
    outcome[entry.fact] = entry.outcome + (entry.tie ? '+tie' : '');
    if (entry.current) current[entry.fact] = {value: entry.current.value, observedAt: entry.current.observedAt, source: entry.current.source};
  }
  return JSON.stringify({lid: item.lid, tmdb: item.tmdb ?? null, facts: item.facts, effectiveOn: item.effectiveOn || {}, outcome, current});
}

export function changeCounts(films) {
  const counts = {new: 0, replaces: 0, unchanged: 0, older: 0, tie: 0};
  for (const film of films) for (const entry of film.outcomes || []) {
    if (Object.prototype.hasOwnProperty.call(counts, entry.outcome)) counts[entry.outcome]++;
    if (entry.tie) counts.tie++;
  }
  return counts;
}

// A synthetic eligibility issue: the preview compared this film, which is the evidence the guarded action requires.
// The issue subject id is the film, so it matches the record; the request subject id is the chunk.
export function applyIssue(lid) {
  return {
    id: 'letterboxd-archive-apply:' + lid,
    subject: {kind: 'letterboxd_archive_chunk', id: lid},
    action: {code: APPLY_CAPABILITY_ID, eligible: true, reason: 'compared'},
    evidence: {completeness: 'complete'},
  };
}

export function rollbackIssue() {
  return {
    id: 'letterboxd-archive-rollback:chunk',
    subject: {kind: 'letterboxd_archive_chunk', id: 'chunk'},
    action: {code: ROLLBACK_CAPABILITY_ID, eligible: true, reason: 'committed'},
    evidence: {completeness: 'complete'},
  };
}
