// ADR 0181 (AIR-131): owner-confirmed group assign of up to ten explicitly selected EPG observations to one movie. Pure: no I/O,
// no clock, no network. The caller reads the D1 rows and hands them in. A group is a convenience over single-key owner
// writes: this module never decides that a key is trusted, it only runs the unchanged single-key gate per key and adds the
// group-only refusals, the exact-selection check, the issuance barrier and the drift check.
import {identityCommand, identityMovieId, identityVersion} from './discovery-identity-review.js';

export const GROUP_CAPABILITY = 'discovery_identity_group_assign';
export const GROUP_VERSION = 1;
export const GROUP_MAX_KEYS = 10;
export const GROUP_ANCHOR_MAX = 4;
export const GROUP_ANCHOR_FETCH = 26;
export const GROUP_ANCHOR_USED = GROUP_ANCHOR_FETCH - 1;
export const GROUP_CANDIDATE_MAX = 50;
export const GROUP_KEY_PATTERN = /^[A-Za-z0-9_-]{16,72}$/;
export const GROUP_RUN_BUDGET_MS = 60000;
export const GROUP_RUNTIME_MIN_MINUTES = 10;
export const GROUP_RUNTIME_RATIO = 0.15;
export const GROUP_BASIS_MAX = 200;
export const GROUP_REASONS = [
  'no_decision', 'runtime_conflict', 'revoked_fence', 'other_owner_assignment', 'scorer_other_id', 'proof_torn', 'proof_stale', 'proof_missing',
  'film_absent', 'film_not_movie', 'group_too_large', 'invalid_selection', 'group_selection_changed', 'stale_pin', 'basis_required',
  'writer_active', 'programme_moved', 'generation_moved', 'lease_lost', 'group_incomplete', 'group_mismatch', 'group_running',
  'budget_exhausted', 'expired', 'not_authoritative',
];
export const GROUP_OUTCOMES = ['applied', 'conflict', 'refused', 'skipped', 'expired', 'not_attempted', 'unknown'];

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// The anchors: normalized titles of the catalogue Film, in the caller's order, deduplicated, at most four. Anything beyond is counted.
export function groupAnchors(titles) {
  const distinct = [];
  for (const title of Array.isArray(titles) ? titles : []) {
    if (typeof title !== 'string') continue;
    const anchor = title.trim();
    if (anchor.length >= 2 && !distinct.includes(anchor)) distinct.push(anchor);
  }
  return {anchors: distinct.slice(0, GROUP_ANCHOR_MAX), omitted: Math.max(0, distinct.length - GROUP_ANCHOR_MAX)};
}

// One primary-key prefix range per anchor: `observation_key >= from AND observation_key < to`.
export function groupRange(anchor) {
  return {from: anchor, to: anchor + '￿'};
}

// Merges the rows each anchor returned (each read asked for 26: a 26th row means "more", only 25 are used), by key, ordered by key,
// cut at the candidate cap. Nothing is omitted without a count and a flag.
export function groupMerge(perAnchor, max = GROUP_CANDIDATE_MAX) {
  const byKey = new Map();
  const anchors = [];
  for (const item of Array.isArray(perAnchor) ? perAnchor : []) {
    const rows = Array.isArray(item?.rows) ? item.rows : [];
    const used = rows.slice(0, GROUP_ANCHOR_USED);
    anchors.push({anchor: item.anchor, returned: used.length, more: rows.length > GROUP_ANCHOR_USED});
    for (const row of used) {
      if (!row || typeof row.key !== 'string') continue;
      const entry = byKey.get(row.key);
      if (entry) entry.anchors.push(item.anchor);
      else byKey.set(row.key, {key: row.key, anchors: [item.anchor], row});
    }
  }
  const merged = [...byKey.values()].sort((left, right) => compareText(left.key, right.key));
  const candidates = merged.slice(0, max);
  return {
    candidates, anchors, merged: merged.length, shown: candidates.length, dropped: merged.length - candidates.length,
    truncated: anchors.some(item => item.more) || merged.length > candidates.length,
  };
}

// A known observation duration within max(10 minutes, 15% of the Film runtime) agrees; none within it conflicts; an unknown runtime
// or no known duration is shown, never a block.
export function runtimeVerdict(durations, runtime) {
  const film = Number(runtime);
  const known = (Array.isArray(durations) ? durations : []).map(Number).filter(value => Number.isFinite(value) && value > 0);
  if (!Number.isFinite(film) || film <= 0 || !known.length) return {state: 'unknown', diffMinutes: null, toleranceMinutes: null};
  const tolerance = Math.max(GROUP_RUNTIME_MIN_MINUTES, GROUP_RUNTIME_RATIO * film);
  const diff = Math.min(...known.map(value => Math.abs(value - film)));
  return {state: diff <= tolerance ? 'ok' : 'conflict', diffMinutes: Math.round(diff), toleranceMinutes: Math.round(tolerance)};
}

function planOf(decision, tmdbId) {
  const prior = plainObject(decision) ? decision : {};
  return {
    before: {status: prior.status ?? null, tmdbId: prior.tmdbId ?? null, rejectedTmdbIds: prior.rejectedTmdbIds || []},
    after: {status: 'verified', tmdbId, filmId: 'tmdb_' + tmdbId, rejectedTmdbIds: (prior.rejectedTmdbIds || []).filter(id => id !== tmdbId)},
  };
}

// One candidate. `proof` is the per-key D1 proof read by the caller: {record: {key, year, durations, confirmedTmdbId, decision},
// decisionHash, hashOk (the stored hash matches the payload), current (the observation belongs to the published run)}. The unchanged single-key gate runs on it; the group-only refusals are added. Fail closed: every reason is
// listed, a key is selectable only with none.
export function groupAssess({tmdbId, film, proof}) {
  const id = identityMovieId(tmdbId);
  const reasons = [];
  const info = [];
  if (!id) return {selectable: false, reasons: ['film_absent'], info, command: null, version: null, plan: null, runtime: null};
  if (!plainObject(proof) || !plainObject(proof.record)) return {selectable: false, reasons: ['proof_missing'], info, command: null, version: null, plan: null, runtime: null};
  const record = proof.record;
  const decision = plainObject(record.decision) ? record.decision : null;
  if (proof.current !== true) reasons.push('proof_stale');
  if (!decision) reasons.push('no_decision');
  else if (proof.hashOk !== true || typeof proof.decisionHash !== 'string') reasons.push('proof_torn');
  const command = identityCommand({...record, decision: decision || {}, decisionHash: proof.decisionHash}, {effect: 'assign', tmdbId: id, basis: 'group review'}, film);
  if (!command.ok && decision) reasons.push(command.reason);
  if (decision?.revokedOwnerAssign && identityMovieId(decision.revokedOwnerAssign.tmdbId) === id) reasons.push('revoked_fence');
  if (decision?.ownerIdentity?.effect === 'assign' && identityMovieId(decision.ownerIdentity.tmdbId) !== id) reasons.push('other_owner_assignment');
  const accepted = identityMovieId(decision?.scoring?.acceptedTmdbId);
  if (accepted && accepted !== id) reasons.push('scorer_other_id');
  const runtime = runtimeVerdict(record.durations, film?.runtime);
  if (runtime.state === 'conflict') reasons.push('runtime_conflict');
  if (runtime.state === 'unknown') info.push('runtime_unknown');
  if (decision?.status === 'verified' && identityMovieId(decision.tmdbId) && identityMovieId(decision.tmdbId) !== id) info.push('replaces_verified');
  const yearGap = Number.isFinite(Number(record.year)) && Number.isFinite(Number(film?.year)) ? Math.abs(Number(record.year) - Number(film.year)) : null;
  return {
    selectable: reasons.length === 0, reasons: [...new Set(reasons)], info, runtime, yearGap,
    command: command.ok ? {effect: 'assign', tmdbId: id} : null,
    version: typeof proof.decisionHash === 'string' ? identityVersion(proof.decisionHash, 'assign', id) : null,
    plan: planOf(decision, id),
  };
}

// The owner's selection: 1 to 10 explicit, unique, textual keys. More than the cap refuses; it never truncates.
export function groupSelection(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || !key || key.length > 300)) return {ok: false, reason: 'invalid_selection', keys: []};
  if (new Set(keys).size !== keys.length) return {ok: false, reason: 'invalid_selection', keys: []};
  if (keys.length > GROUP_MAX_KEYS) return {ok: false, reason: 'group_too_large', keys: []};
  return {ok: true, reason: null, keys: [...keys].sort(compareText)};
}

// `AdminActions.previewAction` is eligible when ANY requested record is, and `affected` is only the eligible subset. A group
// confirmation must bind exactly the owner's selection: the affected ids equal the selected ids, nothing is excluded or unread,
// and each version equals the proof's version. Otherwise the WHOLE confirmation refuses and names the failing keys.
export function groupExactSelection(selected, preview, versions) {
  const failing = [];
  const affected = Array.isArray(preview?.affected) ? preview.affected : [];
  for (const id of selected) {
    const entry = affected.find(item => item.id === id);
    if (!entry) {
      const excluded = (preview?.excluded || []).find(item => item.id === id);
      failing.push({id, reason: excluded?.reason || 'not_affected'});
    } else if (!versions || versions[id] !== entry.version) failing.push({id, reason: 'version_changed'});
  }
  for (const entry of affected) if (!selected.includes(entry.id)) failing.push({id: entry.id, reason: 'not_selected'});
  const ok = failing.length === 0 && preview?.status === 'eligible' && affected.length === selected.length;
  return {ok, failing};
}

export function groupChildKey(groupKey, index) {
  return groupKey + '-' + String(index).padStart(2, '0');
}

// The execution barrier. `group` is {id, tmdbId, programmeRunId, ids (the issued ids in issued order), versions}. `children` are the
// discovery_intent rows read by their derived keys. Every child is checked against the issued member identity, never against the
// current decision: a child that already holds its receipt changed the decision hash on purpose. Anything else refuses with nothing written.
export function groupBarrier({group, children}) {
  const ids = Array.isArray(group?.ids) ? group.ids : [];
  const rows = Array.isArray(children) ? children : [];
  const refuse = (reason, failing = []) => ({ok: false, reason, failing, states: rows.map(child => child?.state ?? null)});
  if (!ids.length || ids.length > GROUP_MAX_KEYS) return refuse('group_incomplete');
  if (rows.length !== ids.length) return refuse('group_incomplete', ids.filter((_, index) => !rows.some(child => child?.idempotencyKey === groupChildKey(group.id, index + 1))).map(id => ({id, reason: 'child_missing'})));
  const failing = [];
  let running = false;
  ids.forEach((id, index) => {
    const child = rows[index];
    const command = plainObject(child?.command) ? child.command : {};
    const member = plainObject(command.group) ? command.group : {};
    const version = group.versions?.[id];
    const expected = typeof version === 'string' ? version.split(':')[0] : null;
    const wrong = child?.idempotencyKey !== groupChildKey(group.id, index + 1) || child?.kind !== 'identity_assign' || child?.observationKey !== id
      || command.effect !== 'assign' || String(command.tmdbId) !== String(group.tmdbId)
      || member.id !== group.id || member.size !== ids.length || member.index !== index + 1 || String(member.anchorTmdbId) !== String(group.tmdbId) || member.programmeRunId !== group.programmeRunId
      || !expected || child?.expectedHash !== expected || (child?.state !== 'approved' && child?.state !== 'receipt' && child?.state !== 'running');
    if (wrong) failing.push({id, reason: 'child_mismatch'});
    if (child?.state === 'running') running = true;
  });
  if (failing.length) return refuse('group_mismatch', failing);
  if (running) return refuse('group_running');
  return {ok: true, reason: null, failing: [], states: rows.map(child => child.state)};
}

// Only the authority movement this run caused itself is allowed between keys: the programme run must be unchanged and the generation
// must equal the value the run observed after its own previous write.
export function groupDrift({baseProgrammeRunId, observed, lastGeneration}) {
  if (!plainObject(observed)) return 'generation_moved';
  if (observed.programmeRunId !== baseProgrammeRunId) return 'programme_moved';
  if (observed.generation !== lastGeneration) return 'generation_moved';
  return null;
}

export function groupOutcomeState(outcomes) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  if (list.some(item => item.outcome === 'unknown')) return 'unknown';
  const applied = list.filter(item => item.outcome === 'applied').length;
  if (applied && applied === list.length) return 'applied';
  return applied ? 'partial' : 'refused';
}

// A preview/confirm helper: the group-only validation of the owner's basis text.
export function groupBasis(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > GROUP_BASIS_MAX || /[\u0000-\u001f]/.test(text)) return null;
  return text;
}

export function groupApplication(application) {
  return plainObject(application) ? application : null;
}
