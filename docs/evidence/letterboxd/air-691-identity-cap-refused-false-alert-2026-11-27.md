# AIR-691: false `letterboxd_identity_cap_refused` alert

Date of observation: 2026-11-27 (UTC). Trello: [AIR-691](https://trello.com/c/q6cNH5Vu); contract [ADR 0207 decision 4b](../../adr/0207-letterboxd-admissions-coordinated-in-d1-only.md) and [ADR 0221](../../adr/0221-shared-letterboxd-check-state-in-one-document.md) are unchanged.

## Observation (read-only, from the card's L0 evidence)

- The Diary check document held 3 of 200 entries and 14 backlog ids, all with `requeued.at` 2026-11-27T07:34:17.523Z (an owner requeue/`createMissing`), while the Monitor opened `letterboxd_identity_cap_refused`. The sync slots were healthy and `capRefused`/`backlogFull` were 0.
- Cause: the policy treated any `backlog > 0` as a full document, but the owner action adds a missing id to the backlog whatever the free room.

## Change

The fact reader adds `capHeld` (entries other than an evictable `owner_dismissed` one, the same count the Diary phase uses for its free slots), `capacity` (200) and `capFull` (`backlog > 0` and `capHeld >= capacity`). The policy raises `letterboxd_identity_cap_refused` only for `capFull`, and keeps `letterboxd_identity_backlog_full` for a backlog at its 2,000 bound. Stale, overdue, unreadable and slot signals are unchanged. No limit, timer, scheduler or write was added.

## Offline proof

`tests/letterboxd-sync-bundle.mjs` section 2c drives the real owner `requeue`/`createMissing` into an empty document and judges the real fact reader together with the policy: backlog 14 with free room raises nothing; 200 non-evictable entries with waiting ids raise `cap_refused`; an evictable `owner_dismissed` entry frees room and the signal clears; a full document without waiting ids is healthy; a 2,000-id backlog raises `backlog_full`. `tests/letterboxd-sync-monitor.mjs` covers the pure policy. The section fails on the previous code.

No production call, write or run was made. Post-deploy, the open incident is expected to recover on the next hourly Monitor tick without manual cleanup; that is checked by an L0 read.
