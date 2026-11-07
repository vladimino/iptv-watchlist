# Monitor production activation: evidence (AIR-349, steps 4 to 6)

Captured 2026-11-07 (UTC). Times are UTC with Europe/Madrid in parentheses where it matters (Madrid is UTC+1 on this date). The records are the Worker `iptv` feature-flag readout, `GET /api/monitor/status`, Workers Observability events, the Cloudflare deployment list (names and types of bindings only) and screenshots the owner supplied in the session chat.

**What was done:** the owner set, in the Cloudflare Dashboard, `MONITOR_TRANSPORT`, `MONITOR` (`dry`, then `on`) and the `MONITOR_HEARTBEAT_URL` secret, each after an action-specific owner approval given in the session chat, and set up the Healthchecks check. The executor changed no Cloudflare setting (its connection has no write scope: two attempts returned HTTP 403 with no change) and read production only through the feature-flag readout, the Access-protected status route and Observability. No secret, token, chat id or address of the owner or of Cloudflare appears here. Cron was never started by hand.

## Timeline

| UTC | Step | Observation |
| --- | --- | --- |
| 11:52 | Base | `feature_flags`: `MONITOR` absent (effective `off`), `MONITOR_TRANSPORT` absent (effective `webhook`). |
| before 12:00 | 1. Telegram bindings | By name and type: `MONITOR_TELEGRAM_BOT_TOKEN` is `secret_text`; `MONITOR_TELEGRAM_CHAT_ID` is `plain_text` (the owner decided the chat id is not a secret; see [ADR 0097](../../adr/0097-monitor-telegram-bot-api-transport.md) decision 3). No webhook and no heartbeat binding. Values were not read. |
| 12:17:14 | 2. Transport | Dashboard deployment `827af4b9` at 100%. At 12:23 `feature_flags`: `MONITOR_TRANSPORT` `telegram`, `MONITOR` still `off`; `GET /api/monitor/status`: `transport: telegram`, `alerting: true` (configuration readiness only), `mode: off`. |
| 12:41:42 | 3. `MONITOR=dry` | Deployment `3ace6aec` at 100%. At 12:41 `feature_flags`: `MONITOR` `dry`; status `mode: dry`, `stored: false`. |
| 13:37:34 | 3. First natural `dry` tick | Scheduled event of the `37 * * * *` trigger, `outcome: ok`. Log: `{"event":"monitor","mode":"dry","overall":"waiting","wouldSend":0}`. Status at 13:46: `mode: dry`, `stored: false`, `heartbeatAt: null`, `outbox: 0`, `lastDeliveryFailure: null`, `deadman: false`, `sideEffects: none`. Nothing was written or sent. The owner confirmed no Telegram message arrived. |
| 14:14:34 | 4. `MONITOR=on` | Deployment `939962a7` at 100%. At 14:15 `feature_flags`: `MONITOR` `on`, `MONITOR_TRANSPORT` `telegram`. |
| 14:37:33 | 4. First natural `on` tick | `outcome: ok`. Log: `{"saved":true,"event":"monitor","mode":"on","overall":"healthy","sent":0,"failed":0,"pending":0,"attempts":0}`. Status at 14:45: `stored: true`, `heartbeatAt` 14:37:30, `overall: healthy`, `openIssues` empty, `outbox: 0`, `lastDeliveryFailure: null`, `holdUntil: null`. Streams: EPG `healthy` (published 2026-11-06 17:57 UTC, due 16:00 UTC, `publishedSinceDue: true`); Discovery `healthy` (executor `workflow`, backlog, 5 chunks remaining); Ratings `healthy` (`cloudflare`, `idle`); Predictions `healthy` (193 pending). No alert was sent and no domain record was written. The owner confirmed no Telegram message arrived. |
| 14:48:04.783 | 5. Synthetic test | One `POST /api/monitor/test` (`MONITOR=on`), answer `{"sent":true,"at":"2026-11-07T14:48:04.783Z"}`. The owner supplied a screenshot of the Telegram message (client time 15:48 Madrid): `IPTV monitor: TEST (test)`, `Stream: monitor`, `Issue: monitor_test`, `Test alert from the IPTV monitor. No incident.`, `Overall: healthy`, `At: 2026-11-07T14:48:04.783Z`, `Ref: monitor_test|2026-11-07T14:48:04.783Z`. Status at 14:48: `overall: healthy`, `outbox: 0`, `lastDeliveryFailure: null`, `sideEffects: none`. |
| 14:51:04 | 6. Heartbeat secret | Deployment `cbbe0234` at 100%. `MONITOR_HEARTBEAT_URL` is `secret_text` (name and type only); status `deadman: true`. |
| 14:53 | 6. Manual ping (deviation) | After the check was enabled it showed `down` (no ping yet). The owner pressed `Ping now` in Healthchecks: event `#7`, an HTTPS `POST` from a browser, `down → up`. This is **not** evidence that the Worker pings and is not counted. |
| 15:37:37.933 | 6. Natural heartbeat | Healthchecks Ping `#8`: an HTTPS `GET` from the Cloudflare network, `OK`, at the natural tick (scheduled event 15:37:38, `{"saved":true,"event":"monitor","mode":"on","overall":"waiting","sent":0,"failed":0,"pending":0,"attempts":0}`). Status at 15:44: `heartbeatAt` 15:37:30, `deadman: true`, `outbox: 0`, `lastDeliveryFailure: null`. Streams: EPG, Ratings and Predictions `healthy`; Discovery `waiting` (backlog, 11 chunks remaining), which is by design and gives no alert. |

## Dead-man notification on absence of a ping

- **First attempt, not counted.** The owner shortened the check's period and grace to 5 minutes and 1 minute. The check went `up → down` at 14:55 UTC, which was caused by the schedule edit (the last ping was already late for the new period), not by a missing ping. **No notification was sent by any channel** (Email, Telegram, Trello), although all were enabled: Email notifies on `down` and `up`; Email and Telegram had delivered the `up` notice at 14:53; Trello had never delivered. A Healthchecks test notification at 15:10 reached Telegram and listed the check as also down. The cause of the silence is **not established**; one untested explanation is that Healthchecks does not notify for a flip produced by a schedule edit. Changing the schedule of the real check is therefore not a valid test.
- **Clean test, counted.** The owner created a separate temporary check (period 5 minutes, grace 1 minute), pinged it once by hand and then did nothing. The genuine absence of a ping turned it `down` and Healthchecks sent a Telegram notification at 15:21 UTC: `The check IPTV Monitor Heartbeat TEST is DOWN (success signal did not arrive on time, grace time passed). Period: 5 minutes. Total Pings: 1. Last Ping: Success, 6 minutes ago`. The owner then deleted the temporary check.
- **Recovery of the real check.** The real check stayed `down` after its schedule was restored (a status returns to `up` only on a ping) until the next natural heartbeat; see the section below.

## Recovery of the real check and the second natural heartbeat

At the next natural tick the Worker pinged the real check again, without any action by the owner:

- Healthchecks Ping `#9` at 16:37:35 UTC (17:37 Madrid): an HTTPS `GET` from the Cloudflare network, `OK`; the event list shows `down → up` for the check at 16:37:35 UTC after the `up → down` of 14:55 UTC (downtime 42 minutes 10 seconds, as reported by Healthchecks).
- Healthchecks delivered the `up` notice to **both Telegram and Email** at 17:37 Madrid (owner screenshots: `The check IPTV Watchlist - Monitor Heartbeat is now UP`, `Period: 1 hour`, `Total Pings: 9`, `Last Ping: Success, now`).
- Worker side: scheduled event at 16:37:35 UTC (`outcome: ok`), log `{"saved":true,"event":"monitor","mode":"on","overall":"waiting","sent":0,"failed":0,"pending":0,"attempts":0}`; status at 16:44 UTC: `heartbeatAt` 16:37:30, `overall: waiting`, `openIssues` empty, `outbox: 0`, `lastDeliveryFailure: null`, `holdUntil: null`, `deadman: true`. Two natural heartbeats (`#8` at 15:37 and `#9` at 16:37 UTC) now exist, one hour apart, matching the hourly cron.
- Streams at 16:44 UTC: Ratings and Predictions `healthy`; Discovery `waiting` (11 chunks remaining); **EPG `waiting`**: the daily due time (16:00 UTC, 17:00 Madrid) of 2026-11-07 had passed at 16:37 UTC and the generation published on 2026-11-06 (17:57 UTC) was the latest (`publishedSinceDue: false`). By the policy this is not an alert state: `delayed` begins two hours after the due time (18:00 UTC) and `degraded` five hours after (21:00 UTC), and a degraded issue is confirmed by a second consecutive snapshot before it alerts.

## Observations and deviations

- `MONITOR_TELEGRAM_CHAT_ID` is a plain Worker variable by the owner's decision (documented in ADR 0097 decision 3); the bot token is a Worker secret.
- The Access token issued to the executor's `cloudflared` login appeared in the executor's session transcript (not in GitHub, Trello or the repository) because the login program prints it; the log file was destroyed at once, the token expires after about 24 hours and the owner decided to leave it unrevoked. The [skill](../../../.claude/skills/cloudflare-access-read/SKILL.md) now says never to read that log.
- The same cron tick that runs the monitor also logged `d1_enrichment_projection` with `outcome: failed`, `reason: input_missing` for a `discovered-films.json` of a published generation, at 13:37 and 14:37 UTC. This is the D1 enrichment projector, not the monitor, and was neither investigated nor changed here.
- `heartbeatAt` in the status is the time of the monitor's own snapshot, not proof that the external dead-man service received a ping; the Healthchecks event is that proof.

## Not done or not proven

- The repeat of the synthetic test inside ten minutes (`reason: recent`, no second message) was **not run** on production, by the owner's decision. It is covered offline by `tests/monitor-telegram.mjs` and `tests/monitor-runtime.mjs`.
- A real alert, reminder or recovery message from the monitor was not produced: every observed snapshot was `healthy` or `waiting`, and no incident was provoked.
- The Worker's own heartbeat was never stopped, and neither the Worker nor the cron was disabled. The dead-man test was run against a separate check on the Healthchecks side only.
- The Email and Trello channels were not shown to deliver a `down` notification: only Telegram did so (Email delivered `up` notices; Trello has never delivered).
- The Telegram rate-limit path (`429`) and a revoked token were not exercised on production.
- A `MONITOR=off` rollback was not exercised.
