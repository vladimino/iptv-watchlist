# AIR-559: read-only preflight for the canonical Letterboxd claim producer activation

Date: **24 November 2026, 05:52 to 05:53 UTC** (06:52 Madrid). Scope: read-only. This is the baseline of the [activation plan](../../runbooks/letterboxd-claim-backfill.md#activation-plan-owner-go-required-the-gate-stays-false-until-then). Code: `main` `41a7960d` (the producer gate `LETTERBOXD_CLAIM_ACTIVATED` is `false`).

**Verdict: ready to ask for the activation GO.**
- Both authorities are open.
- The claim writer is idle and clean: the only receipts are the 9 applied ones of the 21 November backfill, and nothing is pending.
- The natural producer (Letterboxd Sync) is healthy.
- The backfill cohort is empty.

**Nothing was written, and this is not a GO.**

## Readings

| Source | Reading |
| --- | --- |
| `scripts/letterboxd-claim-producer-status.mjs` (SELECT only; the binding refuses writes) | Ratings `d1`/`open` generation 4371; Film/Person `open` generation 2. Claim unit receipts (origin `letterboxd_claim`): `applied` 9, `pending`, `failed`, `unknown` and `abandoned` 0. `letterboxd` claims: 415, all trusted; by provenance: none 406, `ratings_alias_bridge` 9. `claim_pending` entries: 0 |
| MCP `feature_flags` | 25 registered, 2 set (`MONITOR=on`, `MONITOR_TRANSPORT=telegram`), 0 invalid. No flag gates the claim producer; the gate is the code constant |
| MCP `ratings_sync_status` | Letterboxd Sync mode `cloudflare`, epoch 1, health `healthy`, `missedRecent` 0, `eventsPending` 0. The last slot, `2026-11-24T0430`, finished: ratings finished, watchlist committed, reconciliation done. The next slot is due 2026-11-24 09:30 UTC; four slots a day. Ratings run: Diary `recent_window`, 1 page, 1 film added; identity step considered 0 ids, so it offered no claim |
| MCP `letterboxd_claim_backfill` `dry_run` | `already_current`, `sideEffects: none`, cohort 0, blockers none. Publication `d1`/`open`, generation 518, watchlist generation 21; ratings generation 4371 |

## What the activation would change, and how it is measured

- **The change:** the one constant line, plus the matching test assertion, in a reviewed PR merged only after the owner's GO.
- **The first natural writes:** a new Letterboxd id that the Watchlist admission step verifies, or a Diary id without a Ratings TMDB link that the Diary step verifies. Each needs an admitted Film. The ratings run above shows that most Diary ids are already linked and are therefore not offered.
- **Measurement:** the claim writer alone, through `letterboxd-claim-producer-status.mjs --since T` (T = deploy time), against this baseline (9 applied receipts, 9 `ratings_alias_bridge` claims). Receipts created after T are the producer's, because no backfill runs.
- **Rehearsal:** offline only, in `tests/letterboxd-claim-activation-rehearsal.mjs`. It runs the real module with the gate on over D1, covering the Diary, the baseline import and the Sync's epoch fence.

## Limits

- This is a snapshot; the generations move with every ratings write.
- The legacy audit limits carry over, as recorded in the [audit](air-559-legacy-inferred-pair-audit-2026-11-23.md) and the [repair](air-559-inferred-pair-repair-apply-2026-11-24.md).
- No natural producer event can be forced; if none occurs, acceptance waits in `Верификация`.
