// AIR-458 / ADR 0135. The pure EPG-priority pause: arming instant, no business TTL, soft-busy versus fail-closed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {madridDayKey, madridMinutes} from '../src/domain/orchestration-policy.js';
import {
  DISCOVERY_EPG_PRIORITY_POLL_MS, EPG_PRIORITY_LEAD_MINUTES, budgetEffect, discoveryAdmission,
  owedDayKey, pauseOpensAt, pauseRowWrite, preferredBusy, publicationDay,
} from '../src/domain/epg-priority-pause.js';

assert.doesNotMatch(fs.readFileSync('src/domain/epg-priority-pause.js', 'utf8'), /\b(fetch|BUCKET|Date\.now|Math\.random|crypto)\b/, 'the contract has no I/O, clock or randomness');
assert.equal(EPG_PRIORITY_LEAD_MINUTES, 5);
assert.equal(DISCOVERY_EPG_PRIORITY_POLL_MS, 60_000);
// The lead has to outlast one paged chunk budget plus one Discovery lease TTL (40 s + 90 s).
assert.ok(EPG_PRIORITY_LEAD_MINUTES * 60_000 > 40_000 + 90_000);

const MIN = 60_000;
const openOf = day => pauseOpensAt(day);
const at = (day, hour, minute) => openOf(day) + ((hour * 60 + minute) - (16 * 60 + 55)) * MIN;

for (const day of ['2026-03-29', '2026-10-25', '2026-11-13', '2026-07-13']) {
  const open = openOf(day);
  assert.equal(madridDayKey(open), day, day);
  assert.equal(madridMinutes(open), 16 * 60 + 55, day);
  assert.equal(madridMinutes(open + 5 * MIN), 17 * 60, day);
}

const published = (day, id = 'prog-'+day) => ({publishedDayKey: day, publishedProgrammeRunId: id, handoffProgrammeRunId: id});
const row = (state, owedDayKey = null, overrideDayKey = null) => ({state, owedDayKey, overrideDayKey});
const base = (extra) => ({tablePresent: true, role: 'discovery', action: 'acquire', row: row('clear'), requestedProgrammeRunId: null, ...extra});

// The owed date steps back one Madrid civil day across the spring-forward and fall-back nights.
assert.equal(owedDayKey(base({nowMs: at('2026-03-29', 10, 0), ...published('2026-03-28')})), null);
assert.equal(owedDayKey(base({nowMs: at('2026-03-30', 10, 0), ...published('2026-03-28')})), '2026-03-29');
assert.equal(owedDayKey(base({nowMs: at('2026-10-25', 10, 0), ...published('2026-10-24')})), null);
assert.equal(owedDayKey(base({nowMs: at('2026-10-26', 10, 0), ...published('2026-10-24')})), '2026-10-25');

// Before 16:55, yesterday published and handed off: Discovery runs.
{
  const nowMs = at('2026-11-13', 16, 54);
  const facts = base({nowMs, ...published('2026-11-12')});
  assert.equal(owedDayKey(facts), null);
  assert.deepEqual(discoveryAdmission(facts), {admit: true, reason: 'clear', owedDayKey: null, budget: 'none', nextCatchUpAt: null});
  assert.equal(pauseRowWrite(facts), null);
}

// 16:55, today not published: refuse, arm the row, do not spend a failure budget. A poll is not an expiry.
{
  const nowMs = at('2026-11-13', 16, 55);
  const facts = base({nowMs, ...published('2026-11-12'), row: row('clear')});
  const decision = discoveryAdmission(facts);
  assert.equal(decision.admit, false);
  assert.equal(decision.reason, 'epg_priority');
  assert.equal(decision.owedDayKey, '2026-11-13');
  assert.equal(decision.budget, 'wait');
  assert.equal(budgetEffect(decision.reason), 'wait');
  assert.equal(Date.parse(decision.nextCatchUpAt) - nowMs, DISCOVERY_EPG_PRIORITY_POLL_MS);
  const write = pauseRowWrite(facts);
  assert.deepEqual(write, {state: 'paused', owedDayKey: '2026-11-13', overrideDayKey: null});
  assert.equal('expiresAt' in write, false);
}

// The same refusal when the row was already armed, and a second observation does not rewrite it.
{
  const nowMs = at('2026-11-13', 18, 0);
  const facts = base({nowMs, ...published('2026-11-12'), row: row('paused', '2026-11-13')});
  assert.equal(discoveryAdmission(facts).reason, 'epg_priority');
  assert.equal(pauseRowWrite(facts), null);
}

// In-flight renewal is not a new admission. EPG publication is exempt so the seal can take the lease.
{
  const nowMs = at('2026-11-13', 17, 2);
  const held = base({nowMs, ...published('2026-11-12'), row: row('paused', '2026-11-13')});
  assert.equal(discoveryAdmission({...held, action: 'renew'}).reason, 'in_flight');
  assert.equal(discoveryAdmission({...held, role: 'epg'}).reason, 'epg_publication');
}

// Pointer moved, discovery pin not yet equal: the pause stays. Handoff of the owed day releases it in the same facts.
{
  const nowMs = at('2026-11-13', 17, 40);
  const lag = base({nowMs, publishedDayKey: '2026-11-13', publishedProgrammeRunId: 'new', handoffProgrammeRunId: 'old', row: row('paused', '2026-11-13')});
  assert.equal(discoveryAdmission(lag).reason, 'epg_priority');
  assert.equal(pauseRowWrite(lag), null);
  const done = base({nowMs, ...published('2026-11-13', 'new'), row: row('paused', '2026-11-13'), requestedProgrammeRunId: 'new'});
  assert.equal(discoveryAdmission(done).reason, 'published');
  assert.deepEqual(pauseRowWrite(done), {state: 'clear', owedDayKey: null, overrideDayKey: null});
  const stale = base({nowMs, ...published('2026-11-13', 'new'), row: row('clear'), requestedProgrammeRunId: 'old'});
  const stopped = discoveryAdmission(stale);
  assert.equal(stopped.reason, 'stale_generation');
  assert.equal(stopped.budget, 'fail_closed');
  assert.equal(budgetEffect('stale_generation'), 'fail_closed');
}

// A missing row fails closed. An absent table is today's behaviour and writes nothing.
{
  const nowMs = at('2026-11-13', 17, 0);
  const missing = base({nowMs, ...published('2026-11-12'), row: null});
  assert.equal(discoveryAdmission(missing).reason, 'evidence_unreadable');
  assert.equal(discoveryAdmission(missing).budget, 'fail_closed');
  assert.equal(pauseRowWrite(missing), null);
  const inert = base({nowMs, ...published('2026-11-12'), tablePresent: false, row: null});
  assert.equal(discoveryAdmission(inert).reason, 'inert');
  assert.equal(pauseRowWrite(inert), null);
  for (const tablePresent of [undefined, null, 'unknown']) {
    const unread = base({nowMs, ...published('2026-11-12'), tablePresent, row: null});
    assert.equal(discoveryAdmission(unread).reason, 'evidence_unreadable', String(tablePresent));
    assert.equal(discoveryAdmission(unread).admit, false);
  }
  // The publication does not wait on an unreadable pause table.
  assert.equal(discoveryAdmission(base({nowMs, role: 'epg', tablePresent: undefined, row: null})).reason, 'epg_publication');
}

// A late publication keeps the admitted run key. published_at on the next Madrid date is not an input and does not move the day.
{
  const night = at('2026-11-14', 0, 30);
  const late = base({nowMs: night, publishedDayKey: '2026-11-13', publishedProgrammeRunId: 'run-13', handoffProgrammeRunId: 'run-13', row: row('paused', '2026-11-13'), requestedProgrammeRunId: 'run-13'});
  assert.equal(owedDayKey(late), null);
  assert.equal(discoveryAdmission(late).reason, 'clear');
  assert.deepEqual(pauseRowWrite(late), {state: 'clear', owedDayKey: null, overrideDayKey: null});
  const timestamp = base({...late, publishedDayKey: '2026-11-14T00:10:00.000Z'});
  assert.equal(discoveryAdmission(timestamp).reason, 'epg_priority');
  assert.equal(discoveryAdmission(timestamp).owedDayKey, '2026-11-13');
}

// After midnight the next Workflow may resume yesterday's seal. Its payload key must not label that programme as today.
{
  const adopted = publicationDay({syncRunKey: '2026-11-13', workflowRunKey: '2026-11-14'});
  assert.deepEqual(adopted, {ok: true, reason: 'adopted_seal', dayKey: '2026-11-13', certifyWorkflow: false});
  const nowMs = at('2026-11-14', 17, 10);
  const facts = base({nowMs, publishedDayKey: adopted.dayKey, publishedProgrammeRunId: 'yesterday-seal', handoffProgrammeRunId: 'yesterday-seal', row: row('paused', '2026-11-14'), requestedProgrammeRunId: 'yesterday-seal'});
  assert.equal(discoveryAdmission(facts).reason, 'epg_priority');
  assert.equal(discoveryAdmission(facts).owedDayKey, '2026-11-14');
  const missing = publicationDay({syncRunKey: null, workflowRunKey: '2026-11-14'});
  assert.equal(missing.reason, 'evidence_unreadable');
  assert.equal(missing.dayKey, null);
  const same = publicationDay({syncRunKey: '2026-11-13', workflowRunKey: '2026-11-13'});
  assert.deepEqual(same, {ok: true, reason: 'frozen', dayKey: '2026-11-13', certifyWorkflow: true});
}

// Pointer and pin can name one run and still be the wrong Madrid day, or no day at all.
{
  const nowMs = at('2026-11-13', 17, 10);
  const wrong = base({nowMs, publishedDayKey: '2026-11-12', publishedProgrammeRunId: 'same', handoffProgrammeRunId: 'same', row: row('paused', '2026-11-13'), requestedProgrammeRunId: 'same'});
  assert.equal(discoveryAdmission(wrong).reason, 'epg_priority');
  assert.equal(pauseRowWrite(wrong), null);
  const missing = base({...wrong, publishedDayKey: null});
  assert.equal(discoveryAdmission(missing).reason, 'epg_priority');
}

// The Discovery pin moves in sealArchive, before the published pointer. That lag does not lift the pause.
{
  const nowMs = at('2026-11-13', 17, 20);
  const lag = base({nowMs, publishedDayKey: '2026-11-12', publishedProgrammeRunId: 'old', handoffProgrammeRunId: 'new', row: row('paused', '2026-11-13'), requestedProgrammeRunId: 'old'});
  assert.equal(discoveryAdmission(lag).reason, 'epg_priority');
  assert.equal(pauseRowWrite(lag), null);
  const foreign = base({...lag, requestedProgrammeRunId: 'new'});
  assert.equal(discoveryAdmission(foreign).reason, 'stale_generation');
}

// No EPG instance and a failed day do not open admission: publication of the owed day is simply unconfirmed.
{
  const nowMs = at('2026-11-13', 19, 0);
  const facts = base({nowMs, publishedDayKey: null, publishedProgrammeRunId: null, handoffProgrammeRunId: null, row: row('paused', '2026-11-13')});
  assert.equal(discoveryAdmission(facts).admit, false);
  assert.equal(discoveryAdmission(facts).reason, 'epg_priority');
}

// Midnight keeps yesterday's pause. The next arming instant rolls the owed day and drops yesterday's override.
{
  const night = at('2026-11-14', 0, 30);
  const still = base({nowMs: night, ...published('2026-11-12'), row: row('paused', '2026-11-13')});
  assert.equal(owedDayKey(still), '2026-11-13');
  assert.equal(discoveryAdmission(still).reason, 'epg_priority');
  const released = base({nowMs: night, ...published('2026-11-13', 'new'), row: row('paused', '2026-11-13')});
  assert.equal(owedDayKey(released), null);
  assert.equal(discoveryAdmission(released).admit, true);
  const nextOpen = at('2026-11-14', 16, 55);
  const rolled = base({nowMs: nextOpen, ...published('2026-11-12'), row: row('paused', '2026-11-13', '2026-11-13')});
  assert.equal(discoveryAdmission(rolled).owedDayKey, '2026-11-14');
  assert.equal(discoveryAdmission(rolled).reason, 'epg_priority');
  assert.deepEqual(pauseRowWrite(rolled), {state: 'paused', owedDayKey: '2026-11-14', overrideDayKey: null});
}

// An override admits only the owed day it names, and only the programme id the pointer already names.
{
  const nowMs = at('2026-11-13', 18, 30);
  const current = 'prog-2026-11-12';
  const open = base({nowMs, ...published('2026-11-12', current), row: row('paused', '2026-11-13', '2026-11-13'), requestedProgrammeRunId: current});
  assert.equal(discoveryAdmission(open).reason, 'owner_override');
  assert.equal(pauseRowWrite(open), null);
  const stale = base({nowMs, ...published('2026-11-12', current), row: row('paused', '2026-11-13', '2026-11-13'), requestedProgrammeRunId: 'foreign'});
  assert.equal(discoveryAdmission(stale).reason, 'stale_generation');
  assert.equal(discoveryAdmission(stale).budget, 'fail_closed');
  for (const requestedProgrammeRunId of [null, '', 0]) {
    const unknown = base({nowMs, ...published('2026-11-12', current), row: row('paused', '2026-11-13', '2026-11-13'), requestedProgrammeRunId});
    assert.equal(discoveryAdmission(unknown).reason, 'evidence_unreadable', String(requestedProgrammeRunId));
  }
  const shut = base({nowMs, ...published('2026-11-12', current), row: row('paused', '2026-11-13', null), requestedProgrammeRunId: current});
  assert.equal(discoveryAdmission(shut).reason, 'epg_priority');
}

// A clear row cannot hide an unpublished yesterday before the next arming instant.
{
  const nowMs = at('2026-11-14', 10, 0);
  const facts = base({nowMs, ...published('2026-11-12'), row: row('clear')});
  assert.equal(discoveryAdmission(facts).reason, 'epg_priority');
  assert.equal(discoveryAdmission(facts).owedDayKey, '2026-11-13');
  assert.deepEqual(pauseRowWrite(facts), {state: 'paused', owedDayKey: '2026-11-13', overrideDayKey: null});
}

// Soft contention never counts. D1 and authority faults still fail closed. The projector deadline does not name the pause.
assert.equal(budgetEffect('projector_window'), 'wait');
assert.equal(budgetEffect('lease_held'), 'wait');
assert.equal(budgetEffect('lost_race'), 'wait');
assert.equal(budgetEffect('d1_unavailable'), 'fail_closed');
assert.equal(budgetEffect('authority_held'), 'fail_closed');
assert.equal(budgetEffect('authority_loading'), 'fail_closed');
assert.throws(() => budgetEffect('step_failed'), /unknown admission reason/);
assert.equal(preferredBusy(['projector_window', 'epg_priority']), 'epg_priority');
assert.equal(preferredBusy(['lease_held']), 'lease_held');
assert.equal(preferredBusy([]), null);

// A malformed row and an unknown caller fail closed rather than admitting.
{
  const nowMs = at('2026-11-13', 12, 0);
  assert.equal(discoveryAdmission(base({nowMs, ...published('2026-11-12'), row: {state: 'held'}})).reason, 'evidence_unreadable');
  assert.equal(discoveryAdmission(base({nowMs, ...published('2026-11-12'), row: {state: 'paused', owedDayKey: '13 Nov', overrideDayKey: null}})).reason, 'evidence_unreadable');
  assert.equal(discoveryAdmission(base({nowMs, ...published('2026-11-12'), row: {state: 'paused', owedDayKey: '2026-11-13', overrideDayKey: 'today'}})).reason, 'evidence_unreadable');
  assert.equal(discoveryAdmission(base({nowMs, ...published('2026-11-12'), role: 'admin'})).reason, 'evidence_unreadable');
  const omitted = base({nowMs: at('2026-11-13', 17, 0), ...published('2026-11-12'), row: row('paused', '2026-11-13')});
  delete omitted.role;
  assert.equal(discoveryAdmission(omitted).reason, 'epg_priority');
}
