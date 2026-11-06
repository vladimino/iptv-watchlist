# AIR-357 production recovery: seal items in progress

**Captured:** 2026-11-05, about 21:13 UTC (22:13 Europe/Madrid). **Authorization:** owner standing GO for the remaining `epg_sync_step` calls while `nextAction=continue` on run `5744aef7-990d-4751-bb46-d979d9c5a2cc`.

## Position

| Checkpoint | Cursor | Note |
| --- | --- | --- |
| First authorized seal step | 660 / 38941 | job `0ca62b1d-…` opened |
| After standing GO | 7557 / 38941 | `phase=items`, `nextAction=continue` |

MCP once returned `fetch failed` while the Worker still wrote (cursor advanced; lease later `expires_at=0`). Those calls were not blindly retried: a D1 read-back confirmed progress and a released or expired lease first. A live lease (~88 s remaining at cursor 5457) was waited out.

Transfer is still `loading`. Published generation is still 3 / `7c1eaadb…`. Catalogue/publication has not started.

## Remaining

Items from 7557 to 38941, then archive, catalog and publish. Same stop rules: `wait`/`stop`, unknown outcome without a confirming read-back, a live competing lease, a divergent marker, or a step with no cursor/phase progress.
