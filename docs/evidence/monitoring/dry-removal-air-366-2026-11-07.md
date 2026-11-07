# Monitor: removal of the temporary `dry` mode (AIR-366)

Dated 2026-11-07 (UTC). This records the pre-merge production gate and the offline test evidence for AIR-366. **No production write, flag change, secret change, Task change, cron run or synthetic test was made.**

## Decision

`MONITOR` stays as a permanent emergency gate with two values, `off` and `on`. The temporary `dry` mode of [AIR-349](https://trello.com/c/VUyampoh) existed only for the first observation before real sending and is removed from the code, the flag registry, the API and the evergreen docs. `MONITOR_TRANSPORT`, `MONITOR_HEARTBEAT_URL`, the Telegram token and chat binding, the heartbeat and the outbox are unchanged. ADR 0095 and ADR 0097 are not rewritten: the history of `dry` remains in the [AIR-349 offline evidence](monitor-air-349-2026-11-06.md) and the [activation record](monitor-activation-air-349-2026-11-07.md).

## Pre-merge production gate

| Check | Result |
| --- | --- |
| [AIR-349](https://trello.com/c/VUyampoh) | list `Готово`, `dueComplete: true` (Trello readback, 2026-11-07) |
| Production `MONITOR` | owner-only `feature_flags` read at 2026-11-07 17:57:34 UTC: `MONITOR` `state: set`, `raw: on`, `valid: true`, `effective: on`; `MONITOR_TRANSPORT` `raw: telegram`, `effective: telegram`; `storage: not_accessed`, `sideEffects: none` |

Because production is already `on`, removing the `dry` token does not change the effective production mode. The production binding is not removed or changed by this work.

## Behaviour after the change

| Input | Tick (`Monitor.run`) | `POST /api/monitor/test` | `feature_flags` |
| --- | --- | --- | --- |
| `on` | evaluates, keeps `monitor/state.json`, sends alerts, pings the heartbeat | allowed when a channel is ready | `valid: true`, `effective: on` |
| `off` or absent | `{ran:false, reason:'off'}`: no read, write, send or ping | `{sent:false, reason:'off'}` before any state read or request | `effective: off` |
| any other value, including `dry` | the same as `off` | the same as `off` | `valid: false`, `issue: unrecognized`, `effective: off`; the value is redacted |

## Offline evidence

`tests/monitor-runtime.mjs`, `tests/monitor-telegram.mjs` and `tests/feature-flags.mjs` pass. The `dry` scenarios were replaced by regressions: the retired `dry` token and unknown values leave the tick, the synthetic test, `Monitor.status` and the monitor document inert; `src/monitor.js` contains no `dry` path or comment; the flag registry lists only `off` and `on`. The CAS, outbox, alert, transport and heartbeat tests are unchanged.

## Limits and rollback

A production `MONITOR=dry` would now mean `off`; this is why the gate above was read before the change. A code revert restores the `dry` branch but does not change the production binding or recall sent messages. An emergency `MONITOR=off` needs an owner-authorized change and also stops the dead-man heartbeat. Post-deploy verification is read-only (`feature_flags`, `GET /api/monitor/status` after a natural cron tick) and is recorded separately.
