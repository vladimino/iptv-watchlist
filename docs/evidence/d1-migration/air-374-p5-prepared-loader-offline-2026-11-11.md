# AIR-374 P5: `prepared` loader for rated admission, retention and retirement, offline tests

**Captured:** 2026-11-11, local runs of `node tests/film-person-prepared-loader.mjs` and `node tests/film-person-prepared-loader-mutation.mjs`, then the full `npm test` and `npm run build`. **Method:** a sqlite file plays production D1 (migrations `0001` to `0018`, marker `prepared` over a verified baseline, a held projector lease), the D1 stand-in applies the **emitted** statements as one atomic batch each, a double with `head` and `get` only plays the read-only R2 client; no production D1, R2, connector or network access of any kind. Authority: owner decision 2 of 11 Nov 2026 ([AIR-374](https://trello.com/c/ha7ais3w)); the tool is [`scripts/film-person-prepared-loader.mjs`](../../../scripts/film-person-prepared-loader.mjs), the procedure is the [runbook](../../runbooks/film-person-prepared-loader.md).

This file holds counts only: no id, title or payload.

**Result:** the tool loads exactly the accepted rows into the three tables and nothing else, refuses on every mismatch listed in the runbook, and has no write path of its own. It is **code evidence only**: no live run happened, and a live run needs its own owner GO.

| Check | Result |
| --- | --- |
| Dry run | A plan leaves every table and the database file byte-identical |
| Accepted counts end to end | 708 admissions, 401 retention rows and 4 retirement decisions planned in 30 batches (at most 40 rows each), applied, read back equal, digests of every other table unchanged |
| Re-run | The next plan is a no-op; replaying the emitted batches changes nothing; bound statements and rendered SQL load the same rows |
| Fence in every row | Provoked on fresh databases, each failing the whole batch with nothing written: marker to `d1`, `held`, `r2`; mode-only and generation-only change; baseline reopened or re-referenced; lease expired, released, taken; window not held, other owner, expired; identity moved (untrusted, second claim, redirect, Film removed, Letterboxd id moved or doubled); a class already at its total |
| Plan refusals | Marker, baseline and schema states; source digest, missing and malformed sources; invalid or duplicated retirements; count mismatch; unknown and differing stored rows; ambiguous Letterboxd id; duplicate short code |
| Emit | Refused without `--apply`, without a pinned digest, on a wrong digest, and for an edited or re-digested plan with an out-of-scope or unfenced statement |
| Bounds | Per batch 40 rows (cap 60), per run 40 batches and 1,200 statements; a smaller run defers the rest and the next run completes it |
| Sources | Only `HEAD` and conditional `GET` of three allowlisted keys; a moved ETag, size mismatch and missing object refuse |
| CLI | Dry by default; no file without `--apply` and the right digest; output inside the repository refused |
| Mutation check | 73 mutants, each removing or inverting one guard, all killed; the control copy passes |

**Not proved:** that D1's multi-statement request rolls back like the stand-in's transaction; that the real R2 sources resolve to 708, 401 and 4 (the plan refuses if they do not); anything about production state.
