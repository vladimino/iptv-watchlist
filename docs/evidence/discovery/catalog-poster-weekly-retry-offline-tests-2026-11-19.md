# Catalog poster weekly retry: offline test evidence

**Date:** 2026-11-19 (UTC). **Scope:** offline tests of the implementation of [ADR 0179](../../adr/0179-weekly-automatic-catalog-poster-retry.md). **Method:** deterministic Node tests with in-memory R2, D1 and TMDB stand-ins, run against the local checkout. **No production observation was made:** no live read, no TMDB request, no D1 or R2 write, no deploy, no cron run. **Verdict:** the contract of the ADR holds in the stand-ins; nothing is shown about production.

## What the tests prove

[`tests/catalog-poster-weekly-d1.mjs`](../../../tests/catalog-poster-weekly-d1.mjs) is the production-path evidence: the actual Worker entry (`worker.scheduled` with the exact cron) over real sqlite as the D1 stand-in, Discovery in `d1` / `open` mode on the full migration chain. It shows positive guarded hydration into `discovery_admission` with no R2 catalog object read or written (only the negative index, the checkpoint and the event reach R2); a zero-due week while Discovery holds the lease takes no lease, writes no lease row, makes no TMDB call (not even a credential is needed) and yields one completed report with two checkpoint writes and one event put; due work under a busy lease or an EPG-priority pause defers with a `deferred` report and resumes on a later firing; an uncertain D1 batch leaves the run `pending`, remembers nothing and converges to one written row on the next firing; a missing, empty or malformed `poster_path` is never remembered as no-poster and an explicit `null` is. The R2-catalog tests below remain as compatibility coverage, not as production proof. The seed ordering (after the committed admission, none for a refused candidate, none for a missing or malformed `poster_path`) is covered in [`tests/discovery-chunk-budget.mjs`](../../../tests/discovery-chunk-budget.mjs).

[`tests/catalog-poster-weekly.mjs`](../../../tests/catalog-poster-weekly.mjs):

- week arithmetic (weeks start Sunday 00:00 UTC), the next 03:24 UTC firing and the stable event id format `catalog_posters-<YYYY-MM-DD>-<deferred|final>`;
- checkpoint validity per status (an incomplete or corrupt record is rejected, never trusted), the `plan` decision and the ordered Monitor projection (`unknown`, `lost`, `failed`, `stalled`, `grace`, `overdue`, `waiting`, `healthy_idle`);
- the bootstrap sweep, and that an idle firing is one read and no write of any kind;
- held and due verdicts; a busy lease that defers and resumes; `429` and `5xx` that never become a no-poster verdict; retry exhaustion at the cap;
- outbox replay with a frozen `at` and payload (a lost put and a crash after the put are replayed without a TMDB call), deferred-then-final, week supersession, a full outbox, a corrupt checkpoint and a compare-and-swap race;
- exact cron routing (the hourly and the two-minute expressions still route as before, the poster expression runs only the poster branch);
- the admission seed (only an explicit `poster_path: null` on a complete, id-verified detail is recorded; incomplete answers are not).

[`tests/catalog-poster-monitor.mjs`](../../../tests/catalog-poster-monitor.mjs): the write-once `catalogPostersBaselineAt` and `catalogPostersSeenAt` in the Monitor state document; that the bootstrap grace is never indefinite; that an absent checkpoint after `SeenAt` is `lost` (degraded) and never a new grace; issues for a corrupt, failed, stalled or full-outbox checkpoint; that `waiting` raises no issue; isolation from the other four streams.

Both files exit 0 on the local checkout. The `tests/cron-schedule-simulation.mjs` test, whose configuration expectation was adapted for the third cron entry, also exits 0.

## Limits

- Stand-ins are not production: real TMDB `poster_path` behaviour, real R2 compare-and-swap timing and real Worker cron delivery are unobserved.
- Positive hydration is unproven until a real `poster_path` appears on a natural weekly run after a separately authorized activation.
- Whether 03:24 UTC is quiet enough against EPG and Discovery, and whether the 26 h, 2 h, 52 h and retry-cap constants fit real scheduling delay, are to be measured on the first natural weeks.
- The footer source `posters`, the Events Log card and filter and the `catalogPosters` health section are specified in the references; their UI checks and rendered-diagram QA belong to the implementation pull request, not to this record.
- The cron `24 3 * * *` is declared in `wrangler.jsonc` and not activated by this record; activation needs a separate explicit owner GO.
