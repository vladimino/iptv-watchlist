# Monitor four states and one reminder interval: offline evidence (AIR-592)

Captured 2026-11-24 (UTC) from the repository only, for [ADR 0206](../../adr/0206-monitor-four-states-one-reminder-interval.md) (Proposed). **No production read or write, no Cloudflare setting, no Telegram or webhook call and no network call was made.** The Telegram token and chat id in the tests are fixtures.

| Scenario | Test | Result |
| --- | --- | --- |
| Vocabulary | `tests/monitor-policy.mjs` 5, 7 | `STATES` is `healthy`, `waiting`, `delayed`, `degraded`; no stream, overall or issue severity is `needs_owner` |
| Former `needs_owner` conditions per stream | `tests/monitor-policy.mjs` 1-3, `tests/letterboxd-sync-monitor.mjs`, `tests/catalog-poster-weekly.mjs`, `tests/catalog-poster-monitor.mjs` 3, `tests/monitor-canonical-producer.mjs` 6 | held/unreadable EPG authority, Discovery quarantine, Ratings quarantine and permanent failure, Letterboxd quarantine, failed poster run and a `blocked` Producer stop are `degraded` with `critical: true`; ordinary issues of the same streams (stale EPG, stalled Ratings, stalled poster week, recoverable Producer stop) are not critical |
| Immediate first alert | `tests/monitor-policy.mjs` 6, 7; `tests/monitor-telegram.mjs` 1; `tests/monitor-canonical-producer.mjs` 6 | a critical issue alerts on its first snapshot; an ordinary one is confirmed by a second (one snapshot for `predictions_no_progress`, `canonical_producer_*`) |
| One reminder interval | `tests/monitor-policy.mjs` 7 | a critical issue sends nothing at 1, 2, 3 and 5 hours and one `REMINDER` at 6 hours; an ordinary one-snapshot issue the same; `cooldownMs` is gone, `reminderMs` is 6 h |
| Escalation | `tests/monitor-policy.mjs` 6, 7 | ordinary to critical sends one `ESCALATION` inside the interval (also from a legacy ordinary entry); critical to ordinary sends nothing |
| Recovery, cap | `tests/monitor-policy.mjs` 6, 7; `tests/monitor-telegram.mjs` 13 | one recovery per delivered issue, none for an unconfirmed one; at most eight messages per issue per UTC day |
| Legacy alert state | `tests/monitor-policy.mjs` 7 | an entry stored as `needs_owner` keeps `firstSeenAt`, `seen`, `sendCount`, `lastSentAt`, the daily count and the key; it neither escalates nor recovers because of the rename; its reminder comes 6 hours after its last send; a legacy critical entry now reported as ordinary sends nothing |
| Legacy undelivered outbox and stored document | `tests/monitor-telegram.mjs` 13 | the status read of a document holding `needs_owner` shows `degraded`, critical, and writes nothing; the first tick delivers the one queued legacy message once, with its original id (`Ref`) and the text `REMINDER (degraded, critical)`, sends nothing else, keeps the history, moves the accounting by that delivery and rewrites the document without `needs_owner`; the next reminder is 6 hours after that delivery; one recovery follows |
| Payload | `tests/monitor-runtime.mjs` 3, `tests/monitor-telegram.mjs` 7 | the webhook body gains exactly one fixed field, `critical`; the Telegram first line reads `(degraded, critical)` for a critical issue |

Rollback (stated in the ADR, not executed): code-only; the previous code ignores `critical`, keeps keys and history, and sends one `ESCALATION` per issue that is open and critical at the rollback.

Limitations: no production observation. The first natural tick over the stored production `monitor/state.json` after deployment can be checked read-only through `GET /api/monitor/status`; nothing here proves it.
