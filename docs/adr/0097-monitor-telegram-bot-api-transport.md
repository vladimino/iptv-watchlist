# ADR 0097: The monitor can deliver directly to the Telegram Bot API through a deliberately selected, fail-closed transport

**Status:** Accepted  
**Original decision date:** 2026-11-07  
**Recorded at:** 2026-11-07  
**Approval source:** the Product Owner explicitly accepted ADR 0097 on 2026-11-07 in the [AIR-365 decision record](https://trello.com/c/7lLwNBbI#comment-6aef0b430718456551e4e3b2), confirming the direct Bot API outbound trust boundary, secret-only configuration (for the chat id this part was amended on 2026-11-07, see decision 3) and at-least-once duplicate risk. This is architecture approval only, not production activation.  
**Related work:** [AIR-365](https://trello.com/c/7lLwNBbI); [AIR-349](https://trello.com/c/VUyampoh); [ADR 0095](0095-cloudflare-native-production-monitor.md)  
**Supersedes:** None (extends ADR 0095 decision 7; ADR 0095 stays Accepted and unchanged)  
**Superseded by:** None

## Context

ADR 0095 delivers monitor alerts to one generic HTTPS webhook. The owner chose to receive them directly in Telegram, with no Make or other intermediary. The bot exists and a local `sendMessage` was checked by the owner; that check authorizes no Cloudflare production write. Telegram is a new outbound trust boundary: a fixed third-party endpoint that receives operational text and requires a bot token, which is a credential.

## Decision

1. **A second transport, chosen only by `MONITOR_TRANSPORT`.** Absent, empty or `webhook` keeps the generic webhook of ADR 0095 unchanged. `telegram` selects the Bot API. Any other value is invalid and delivery fails closed. A chosen transport never falls back to the other one, and having the Telegram secrets present does not select Telegram.
2. **Fixed destination, outbound `sendMessage` only.** The only URL is `https://api.telegram.org/bot<token>/sendMessage`, built in code. There is no inbound webhook, polling, command or `getUpdates`, and no caller-supplied destination.
3. **Secret bot token, chat id as a Worker variable (amended 2026-11-07).** `MONITOR_TELEGRAM_BOT_TOKEN` MUST be a Worker secret (`secret_text`), set by the owner. `MONITOR_TELEGRAM_CHAT_ID` is a destination identifier, not a credential, and is held as a plain Worker variable (`plain_text`); the code reads both from the Worker environment as strings. Both are shape-checked (a bot token `<digits>:<url-safe characters>`; a chat id as a signed integer or `@channel`); a missing or malformed value makes the channel not ready and nothing is sent. The token is never in the repository, wrangler configuration, feature-flag readout, status, state document, log, exception or documentation, and the chat id stays out of logs, public GitHub, Trello and reports even though it is not an authentication credential. Failures are reported as fixed reason codes (`http_401`, `telegram_not_ok`, `network`, `timeout`, `rate_limited`, `malformed_response`, `config_invalid`), never response bodies or URLs.

   *Amendment, 2026-11-07:* the original wording of this decision required **both** values to be Worker secrets. That requirement is **superseded for the chat id only** by the Product Owner's decision of 2026-11-07 (recorded in the [AIR-349](https://trello.com/c/VUyampoh) activation thread) that the chat id is not a secret. The requirement that the bot token be a Worker secret is unchanged. No runtime behavior changes.
4. **Plain, bounded text.** No `parse_mode` is requested, so no markup is interpreted. The text carries the kind (`ALERT`, `REMINDER`, `ESCALATION`, `RECOVERED`, `TEST`), severity, stream, issue key, the short diagnostic of ADR 0095, the overall state, a UTC time and the outbox `Ref` id. Fields are limited to printable ASCII and a fixed length, far below Telegram's 4096 characters. No film, rating, personal datum or secret is included.
5. **Delivery means HTTP success and `ok: true`.** A 200 with `ok: false`, a 401/403, a malformed body, a timeout (10 s) or a network error is a failed delivery: the message stays in the outbox, `sendCount` and the cooldown do not move, and the AIR-349 per-tick budget applies unchanged (five attempts, stop after two consecutive failures, failed messages rotate to the tail).
6. **Telegram 429.** `retry_after` (or the `Retry-After` header; one minute when absent; capped at one hour) becomes a persisted `holdUntil` in `monitor/state.json`. No code sleeps. Ticks before the hold make no attempt, the message is neither lost nor counted, and `POST /api/monitor/test` answers `rate_limited`. With the hourly cron the hold normally ends before the next tick; a longer hold delays delivery to the first tick after it.
7. **At-least-once, stated honestly.** Telegram has no idempotency key, so the stable outbox `id` is shown as `Ref` for the human reader but cannot deduplicate on the receiving side. A crash after Telegram accepted a message and before the state commit can repeat it. Exactly-once is not claimed.
8. **Everything else is unchanged:** `MONITOR=off` and `dry` do nothing outward; the policy, the CAS claim, accounting at delivery, cancellation, supersession of a stale recovery, the status as a pure read and the dead-man heartbeat (`MONITOR_HEARTBEAT_URL`, a different service) are those of ADR 0095.

Not decided: activation. Setting the token secret and the chat id variable, `MONITOR_TRANSPORT=telegram`, `MONITOR=dry` or `on`, the live synthetic message, the owner's receipt and the heartbeat each need a separate action-specific owner approval under [AIR-349](https://trello.com/c/VUyampoh).

## Alternatives considered

- **Make or another intermediary in front of the generic webhook:** rejected by the owner in favor of a direct integration (AIR-365 card). Other trade-offs were not discussed.

## Consequences

A new outbound dependency on `api.telegram.org` and a credential in Worker secrets. The webhook transport remains the fallback by configuration. The retry hold adds two optional fields to `monitor/state.json` (`holdUntil`, `lastDeliveryFailure`; a reason code only). A Telegram outage or revoked token is visible as growing `outbox` and `lastDeliveryFailure` in `GET /api/monitor/status`, and the dead-man heartbeat still shows the monitor itself is alive.

## Recovery and migration boundary

Reversible: set `MONITOR` to `off`, or remove `MONITOR_TRANSPORT` to return to the generic webhook. Code rollback is a revert; it does not delete secrets or retract messages already sent. This ADR authorizes no secret, flag, bot setting, schedule change or production write.

## Evidence

- **Original decision:** the owner's direct-Telegram choice in [AIR-365](https://trello.com/c/7lLwNBbI)
- **Owner acceptance:** [2026-11-07 explicit approval of ADR 0097](https://trello.com/c/7lLwNBbI#comment-6aef0b430718456551e4e3b2)
- **Implementation:** the AIR-365 pull request
- **Dated verification:** [offline evidence 2026-11-07](../evidence/monitoring/telegram-air-365-2026-11-07.md); no production observation and no live Telegram call
- **Uncertainty:** Telegram's real rate-limit behavior, delivery latency and the owner's receipt are unobserved until an authorized activation.

## Follow-ups

Activation, the live synthetic message with the owner's receipt and the heartbeat remain gated by separate owner approval on [AIR-349](https://trello.com/c/VUyampoh).
