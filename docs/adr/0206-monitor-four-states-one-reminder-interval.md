# ADR 0206: The monitor has four states; a proven hard failure is a critical `degraded` issue that alerts at once and every issue reminds every 6 hours

**Status:** Proposed  
**Original decision date:** 2026-11-24 (owner proposal recorded on the AIR-592 card; the ADR decision itself is pending)  
**Recorded at:** 2026-11-24  
**Approval source:** not yet decided. The owner's proposal to remove `needs_owner` is recorded in the [AIR-592 card](https://trello.com/c/c0d7VD4P) description; creating the card is not acceptance of this ADR.  
**Related work:** [AIR-592](https://trello.com/c/c0d7VD4P); incident [AIR-572](https://trello.com/c/ugyHjnc4) ([RCA](../evidence/d1-migration/air-572-producer-budget-rca-2026-11-24.md)); [ADR 0095](0095-cloudflare-native-production-monitor.md); [ADR 0179](0179-weekly-automatic-catalog-poster-retry.md); [ADR 0097](0097-monitor-telegram-bot-api-transport.md)  
**Supersedes:** [ADR 0095](0095-cloudflare-native-production-monitor.md) in part: the `needs_owner` state of decision 4 and the per-severity confirmation and cooldown of decision 5. [ADR 0179](0179-weekly-automatic-catalog-poster-retry.md) in part: the `needs_owner` Monitor status of the `failed` poster state.  
**Superseded by:** None

## Context

[ADR 0095](0095-cloudflare-native-production-monitor.md) gave the Cloudflare-native monitor five states, `healthy`, `waiting`, `delayed`, `degraded` and `needs_owner`, and two alert rules: a `degraded` issue is confirmed by a second consecutive snapshot and reminds every 6 hours; a `needs_owner` issue alerts at once and reminds every 2 hours. `needs_owner` is raised by a held or unreadable EPG authority, a quarantined Discovery executor, a quarantined or permanently failed Ratings run, a quarantined Letterboxd Sync, a failed weekly poster run ([ADR 0179](0179-weekly-automatic-catalog-poster-retry.md)) and a canonical Producer stop with an identity code or a `terminal`, `fail_closed` or `exhausted` class (AIR-572).

The site is personal: every alert of either severity reaches the same single recipient through the same channel. The extra tier routes nothing differently; it only shortens the reminder interval. In the AIR-572 incident ([RCA](../evidence/d1-migration/air-572-producer-budget-rca-2026-11-24.md)) the monitor reported `needs_owner` for `canonical_producer_failed` at the 03:00 tick and sent the same reminder again at 05:00, while the owner already knew. The owner proposed on the AIR-592 card to drop `needs_owner` and to keep one reminder interval.

What the tier does carry and must not be lost: a proven hard failure is alerted on its first snapshot, without waiting for a confirming second one, and an issue whose cause turns from recoverable to hard escalates once.

## Decision

1. **Four states.** The monitor's stream, overall and issue vocabulary is `healthy`, `waiting`, `delayed`, `degraded`. `needs_owner` is retired from the health and severity contract, the aggregation, `GET /api/monitor/status`, the Telegram text, the webhook payload and the catalog poster projection. `waiting` and `delayed` still never alert.
2. **Critical is a property of a `degraded` issue, not a state.** Every condition that raised `needs_owner` now raises the same issue key as `degraded` with `critical: true`. Every other actionable issue is `degraded` with `critical` false or absent. The conditions themselves, the issue keys, the detection thresholds and the hourly cron are unchanged. The diagnosis is kept: the issue message names the cause (quarantine reason, stop code), and the canonical Producer keeps `facts.status` `blocked` (hard stop) versus `failed` (recoverable).
3. **Confirmation.** A critical issue alerts on its first snapshot. An ordinary `degraded` issue keeps its confirmation: two consecutive snapshots, or one for the keys that are already computed from stored facts (`predictions_no_progress`, `canonical_producer_no_progress`, `canonical_producer_failed`).
4. **One reminder interval.** Every open issue, critical or not, sends at most one `REMINDER` per 6 hours after its last delivered message (`ALERT_POLICY.reminderMs`). The 2-hour interval is removed. "Delivered" means the successful send: a message that waited in the outbox (a failing channel, a 429 hold) is settled at the tick that delivered it, with `lastSentAt` set to that tick and the send counted on that tick's UTC day, never at the time it was queued. Before this ADR the settlement copied the values planned at queue time, so a message delivered late moved the next reminder earlier and could charge the send to the previous UTC day.
5. **Escalation by a real change.** An open issue whose diagnosis turns from ordinary to critical (for example a recoverable Producer stop that becomes `fail_closed`) sends one `ESCALATION` inside the reminder interval. Critical to ordinary sends nothing. A severity rename is not a change.
6. **Otherwise unchanged delivery.** One issue key per condition, at most eight messages per issue per day, one recovery message for an issue whose alert was delivered and none for one that never was, the claim-before-send outbox with stable ids, at-least-once delivery, the per-tick budget and the 429 hold of ADR 0095 and ADR 0097 stay as they are.
7. **Messages.** The webhook payload gains one fixed boolean field, `critical`. The Telegram first line reads `IPTV monitor: <KIND> (degraded, critical)` for a critical issue and `IPTV monitor: <KIND> (degraded)` otherwise; recoveries stay `(healthy)`. `openIssues[]` and the stored stream issues carry `critical`.
8. **Compatibility with the state written before this ADR.** `monitor/state.json` may hold `needs_owner` in its alert entries, stream snapshots, `overall` and outbox messages when this code is deployed. Readers map it at one place (`MonitorPolicy.normalizeSeverity`, `isCritical`, `normalizeMessage`): `needs_owner` reads as `degraded` with `critical: true`. Consequences: an open issue keeps its key, `firstSeenAt`, `seen`, `sendCount`, `lastSentAt` and daily count; it neither escalates nor recovers because of the rename; its next reminder is due 6 hours after its last delivered message; an undelivered message keeps its id and is settled at its own delivery like any other (so a receiver still drops a repeat) and is delivered as `degraded`, critical; `GET /api/monitor/status` shows the stored document normalized and writes nothing; the next hourly tick rewrites the document without `needs_owner`. The schema version of the document is unchanged.

Not decided here: acknowledgement, snooze, a new scheduler or channel, a manual recovery, a production test alert or any change of a detection threshold. Code delivered by AIR-592 is not activation of anything: `MONITOR`, the transport and its secrets are unchanged.

## Alternatives considered

- **Keep `needs_owner` and only change its cooldown to 6 hours.** Keeps a state that routes nothing differently and that every reader still has to handle; the owner asked to remove it. Not chosen.
- **Drop the tier entirely and confirm every issue on two snapshots.** Simpler, but a proven quarantine or fail-closed stop would wait an extra hour for a confirmation it does not need. Rejected by the AIR-592 scope, which requires the immediate first alert.
- **Migrate `monitor/state.json` in place on deploy.** Needs a write outside the hourly tick and a separate approval; the read-side mapping plus the next natural tick reach the same state without one. Not chosen.

## Consequences

- One reminder rhythm for the single recipient: a critical issue reminds three times less often than before (6 hours instead of 2). An unresolved hard failure therefore stays silent for up to 6 hours after its last message; the first alert is still immediate and the daily cap still bounds the total.
- Every reader of the monitor vocabulary is simpler: four states, one boolean. The webhook receiver sees one additional field; its other fields keep their meaning, and `severity` no longer takes the value `needs_owner`.
- The catalog poster projection reports `monitor: degraded` with `critical: true` for a `failed` run; the footer and the Events Log derive from the domain `state` and are unchanged. `GET /api/admin/health` `catalogPosters` gains `critical`.
- The legacy mapping stays in the code as long as a pre-ADR document can exist; it costs one comparison per read.

## Recovery and migration boundary

Code-only, and replayed offline against the previous policy and runtime kept verbatim as test fixtures (`tests/fixtures/monitor-policy-pre-air-592.js`, `tests/fixtures/monitor-pre-air-592.js`). A rollback to the previous code reads a document written by this one without loss: issue keys are unchanged, so no issue recovers or restarts, every entry keeps its history and counters, and the extra `critical` field of entries and outbox messages is ignored. One visible effect is bounded and stated: for each issue that is open **and** critical at the rollback, the old code evaluates it as `needs_owner` against a stored `degraded` entry and sends one `ESCALATION` (within the daily cap; a pending message of that issue is replaced in place and sent once under its own id), then returns to its 2-hour reminders and its queue-time settlement. Ordinary issues keep their 6-hour interval; an issue that cleared recovers once. Rolling forward again reads the old `needs_owner` entries as critical and sends nothing because of the format. Sent messages stay sent and no data is rolled back. This ADR authorizes no flag, secret, channel, schedule, test message or production write.

## Evidence

- **Original decision:** owner proposal on [AIR-592](https://trello.com/c/c0d7VD4P); ADR decision pending
- **Implementation:** the AIR-592 pull request
- **Dated verification:** [offline evidence 2026-11-24](../evidence/monitoring/four-states-air-592-2026-11-24.md); no production observation
- **Uncertainty:** the first natural tick on a stored document that still holds `needs_owner` is observed only after deployment, read-only through `GET /api/monitor/status`.

## Follow-ups

None planned. A change of a detection threshold, an acknowledgement or a snooze would be its own decision.
