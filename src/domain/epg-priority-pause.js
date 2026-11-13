// AIR-458 / ADR 0135. Pure admission contract for the EPG-priority Discovery pause.
// No I/O, no clock and no randomness: callers pass the instant and the facts one D1 batch can see.
// Nothing in the Worker imports this module. It does not arm a pause, take a lease or authorize a production write.
// `tablePresent: false` is a verified absence. Any other non-true value is unreadable and fails closed.

import {EPG_SCHEDULE, madridDayKey, madridInstant} from './orchestration-policy.js';

// Five minutes before the EPG due instant (17:00 Europe/Madrid, so 16:55). Longer than one paged chunk
// budget (40 s) plus one Discovery lease TTL (90 s), and shorter than the hour the cron already has.
export const EPG_PRIORITY_LEAD_MINUTES = 5;
// How soon a refused Discovery caller looks again. This is not a deadline: the pause has no expiry.
export const DISCOVERY_EPG_PRIORITY_POLL_MS = 60_000;

const SOFT_WAIT = new Set(['epg_priority', 'projector_window', 'lease_held', 'lost_race']);
const FAIL_CLOSED = new Set([
  'd1_unavailable', 'authority_held', 'authority_loading',
  'evidence_unreadable', 'evidence_contradictory',
  'stale_generation', 'generation_mismatch',
]);

// `wait`: the caller sleeps and tries again; failure budgets stay put.
// `fail_closed`: a real D1, authority or generation fault, counted or quarantined by the existing contract.
export function budgetEffect(reason) {
  if (SOFT_WAIT.has(reason)) return 'wait';
  if (FAIL_CLOSED.has(reason)) return 'fail_closed';
  throw new Error('unknown admission reason');
}

// When both holds are present the pause wins the label, so a projector deadline cannot be read as the end of the pause.
export function preferredBusy(reasons) {
  for (const reason of ['epg_priority', 'projector_window', 'lease_held', 'lost_race']) {
    if (reasons.includes(reason)) return reason;
  }
  return null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The day that may be written on the pointer. `syncRunKey` is frozen on `sync.json` at `beginSync`
// and is never rewritten. `workflowRunKey` is the adopting Workflow's admitted day. It is not a source:
// after midnight that Workflow can resume yesterday's `stage==='seal'` (ADR 0092) under today's key.
// A missing sync key fails closed. A different Workflow key fails closed and does not stamp today.
export function publicationDay({syncRunKey, workflowRunKey} = {}) {
  const frozen = DAY.test(syncRunKey || '') ? syncRunKey : null;
  if (!frozen) return {ok: false, reason: 'evidence_unreadable', dayKey: null};
  if (workflowRunKey != null && workflowRunKey !== frozen) return {ok: false, reason: 'run_key_mismatch', dayKey: null};
  return {ok: true, reason: 'frozen', dayKey: frozen};
}

export function pauseOpensAt(dayKey) {
  return madridInstant(dayKey, EPG_SCHEDULE.hour, EPG_SCHEDULE.minute) - EPG_PRIORITY_LEAD_MINUTES * 60_000;
}

function previousDayKey(dayKey) {
  // Noon minus 24 h stays on the previous Madrid date across both DST transitions.
  return madridDayKey(madridInstant(dayKey, 12, 0) - 24 * 3600000);
}

function programmeId(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

// A paused row must name a real owed date. An override, when present, must be a real date too.
// Anything else is unreadable: it must not be treated as "no override".
function rowUsable(row) {
  if (!row || (row.state !== 'clear' && row.state !== 'paused')) return false;
  if (row.owedDayKey != null && !DAY.test(row.owedDayKey)) return false;
  if (row.state === 'paused' && !DAY.test(row.owedDayKey || '')) return false;
  if (row.overrideDayKey != null && !DAY.test(row.overrideDayKey)) return false;
  return true;
}

function handoffConfirmed(facts) {
  const id = facts.publishedProgrammeRunId;
  // publishedDayKey is published_epg_authority.madrid_run_key, a YYYY-MM-DD run key.
  // A timestamp, a null, or any other string is not that column and does not prove a day.
  return DAY.test(facts.publishedDayKey || '')
    && typeof id === 'string' && id !== ''
    && id === facts.handoffProgrammeRunId;
}

function publishedFor(facts, dayKey) {
  return handoffConfirmed(facts) && facts.publishedDayKey === dayKey;
}

// The Madrid date whose publication this pause is waiting for, or null when Discovery may run.
// At and after today's arming instant the owed date is today, even if yesterday never published.
// Before that, yesterday remains owed only while its publication and handoff are not both confirmed.
export function owedDayKey(facts) {
  const today = madridDayKey(facts.nowMs);
  if (facts.nowMs >= pauseOpensAt(today)) return today;
  const yesterday = previousDayKey(today);
  if (!publishedFor(facts, yesterday)) return yesterday;
  return null;
}

function decide(admit, reason, owedDayKey, budget, nextCatchUpAt = null) {
  return {admit, reason, owedDayKey, budget, nextCatchUpAt};
}

function waitForPublication(owed, nowMs) {
  return decide(false, 'epg_priority', owed, 'wait', new Date(nowMs + DISCOVERY_EPG_PRIORITY_POLL_MS).toISOString());
}

// New Discovery admission (`acquire`: a chunk, a Workflow create, a rollover, a reconcile or an admin/manual lease).
// `renew` is the current holder's own extension and is not a new admission.
// `role: 'epg'` is the publication, which the pause exists to let through.
export function discoveryAdmission(facts) {
  // A missing role is Discovery. Only an explicit `epg` acquire is the publication exemption.
  // Renewal and the EPG acquire do not consult the pause table: an in-flight chunk may finish, and the publication must proceed.
  const role = facts.role == null ? 'discovery' : facts.role;
  if (role === 'epg' && facts.action === 'acquire') return decide(true, 'epg_publication', null, 'none');
  if (facts.action === 'renew') return decide(true, 'in_flight', null, 'none');
  // Verified absence is today's behaviour. Unknown, null or an unreadable introspection is not absence.
  if (facts.tablePresent === false) return decide(true, 'inert', null, 'none');
  if (facts.tablePresent !== true) return decide(false, 'evidence_unreadable', null, 'fail_closed');
  if (role !== 'discovery' || facts.action !== 'acquire') return decide(false, 'evidence_unreadable', null, 'fail_closed');
  if (!rowUsable(facts.row)) return decide(false, 'evidence_unreadable', null, 'fail_closed');
  const owed = owedDayKey(facts);
  const publishedId = programmeId(facts.publishedProgrammeRunId);
  const requested = facts.requestedProgrammeRunId;
  // The published-generation fence is not waived by the pause or by an override.
  if (typeof requested === 'string' && requested !== '' && publishedId && requested !== publishedId) {
    return decide(false, 'stale_generation', owed, 'fail_closed');
  }
  const override = owed != null && facts.row.overrideDayKey === owed;
  const blocking = owed != null && !publishedFor(facts, owed) && !override
    && (facts.row.state === 'paused' || facts.nowMs >= pauseOpensAt(owed));
  if (blocking) return waitForPublication(owed, facts.nowMs);
  if (owed != null && !publishedFor(facts, owed) && override) {
    // Override admits only the programme id the pointer already names. A missing or foreign id stays closed.
    if (!publishedId || requested !== publishedId) return decide(false, 'evidence_unreadable', owed, 'fail_closed');
    return decide(true, 'owner_override', owed, 'none');
  }
  return decide(true, owed && publishedFor(facts, owed) ? 'published' : 'clear', owed, 'none');
}

// The row write that belongs in the same D1 batch as the decision. Null means the batch does not touch the row.
// The result never carries an expiry: a business pause is not a TTL.
export function pauseRowWrite(facts) {
  if (facts.tablePresent !== true || !rowUsable(facts.row)) return null;
  const owed = owedDayKey(facts);
  if (owed && publishedFor(facts, owed)) {
    if (facts.row.state === 'clear' && facts.row.overrideDayKey == null) return null;
    return {state: 'clear', owedDayKey: null, overrideDayKey: null};
  }
  if (owed && facts.row.overrideDayKey === owed) return null;
  if (owed) {
    if (facts.row.state === 'paused' && facts.row.owedDayKey === owed && facts.row.overrideDayKey == null) return null;
    return {state: 'paused', owedDayKey: owed, overrideDayKey: null};
  }
  if (facts.row.state === 'paused' || facts.row.overrideDayKey != null) return {state: 'clear', owedDayKey: null, overrideDayKey: null};
  return null;
}
