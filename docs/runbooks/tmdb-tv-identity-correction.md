# TMDB TV identity correction for four retired movie ids (owner approval required)

This runbook prepares and later executes the correction of [ADR 0057](../adr/0057-tmdb-tv-identity-and-retired-movie-ids.md). Four watchlist miniseries have a retired TMDB movie id. Each one gets its live TMDB TV entry as a trusted `tmdb_tv` identity. The retired movie id is kept, untrusted, with its evidence.

| Film | Retired movie id | TV entry | Letterboxd permalink |
| --- | --- | --- | --- |
| `film:1IUo` | 17266 | tv/9687 | `https://letterboxd.com/film/the-odyssey/` |
| `film:3tCe` | 101915 | tv/8042 | `https://letterboxd.com/film/tess-of-the-durbervilles/` |
| `film:daU4` | 378779 | tv/64099 | `https://letterboxd.com/film/war-and-peace-2016/` |
| `film:g97G` | 452736 | tv/1457 | `https://letterboxd.com/film/pride-and-prejudice-1995/` |

No other Film is ever planned. A link that disagrees with the attributes on another Film's Letterboxd page is review evidence, not a correction.

## Order and gates

1. **Contract and offline tooling** ([AIR-290](https://trello.com/c/70ldvbUB)): `src/domain/tmdb-tv-identity.js` and `scripts/tmdb-tv-identity-plan.mjs`. Code only.
2. **Runtime integration** ([AIR-297](https://trello.com/c/1q6DkvCu)): the lifecycle projection applies `identity/tmdb-retirements.json`; `parseFilm` keeps the typed TMDB link through metadata refresh; `tmdb_tv` reaches D1 through the enrichment projector; movie-only consumers never receive a TV id ([contract](../reference/domain/film-person.md#runtime-projection), [projector](../reference/data/d1-schema.md#enrichment-projector-schema-v4)). **The production correction must not run before this is deployed** and both post-merge jobs have passed, or the next projection or metadata refresh writes the retired movie id back as trusted.
   - **Inert until the object exists.** The deploy changes no identity: without the object the reader and the projector behave as before, apart from one `GET` of the key per projector run. The only new data is the `tmdbLink` field, which the regular sync's metadata refresh adds to a record when it re-parses that page. No Film view or change key reads the field, so it causes no D1 write. Nothing creates or edits the object.
3. **Production correction** ([AIR-291](https://trello.com/c/OWV3rL9q)): the steps below, each with its own owner approval.

## Offline dry-run

```
node scripts/tmdb-tv-identity-plan.mjs --artifact /private/air286 --output /private/air290 \
  (--d1-sqlite /private/d1.sqlite | --database-id <uuid> | --snapshot /private/snapshot)
```

- `--artifact` is the private AIR-286 directory. Evidence comes only from it:
  - the saved movie `404`;
  - the Letterboxd link list saved with that `404`;
  - the saved TV entry `tv-<id>.json`.
- The Film's current state comes from one of three sources:
  - a local SQLite copy of D1 (`-readonly`);
  - the D1 HTTP API (`--database-id`, with `D1_BACKFILL_*` in the environment; a production read needs owner approval);
  - an existing fenced R2 snapshot (`--snapshot`, read-only, via `scripts/snapshot-store.mjs`) when a broader snapshot is independently needed. **Do not create a full snapshot solely for an additive, single-key correction.** A new production snapshot remains a separate owner-approved read operation.
- The plan is written to `--output` (mode 600). The command prints counts only. It makes no TMDB or Letterboxd request and writes nothing to R2 or D1.

For each Film the plan states:
- `old` and `new` typed ids, `before` and `after` (`canonicalIdentity`, the `tmdb` and `tmdb_tv` entries with trust and provenance);
- `collisions`: a trusted `tmdb_tv` already on another Film. This puts the Film into `owner_review`.
- `numericOverlaps`: the same number as a movie id on another Film. This is reported, not a reason to stop.
- a second Film still trusting the retired movie id (only possible in R2): `owner_review`;
- `preserved`: what must not change.
  - credits, split into Letterboxd and AIR-286 TMDB;
  - prediction, rating, watchlist membership, redirects and localization.
- `d1Before` and `d1Expected`: the Film's D1 identity before the correction and the identity it must have after it: `canonical_identity`, the `tmdb` and `tmdb_tv` rows with trust and full provenance, and the identity dimension's status, `source_version` and provenance. Timestamps are not compared.
- `r2`: with `--snapshot`, every record that carries the movie or TV number. These records are reported, not rewritten.
- `r2Retirements`: the body of `identity/tmdb-retirements.json`, containing only `ready` Films.

`status` is `ready`, `owner_review` (unexpected state, nothing planned) or `refused` (missing evidence, or the Film is missing). `unchanged` counts Films already corrected. A repeated plan after a correct run is all `unchanged`, with the same `d1Expected`.

`d1Readback(db, plan)` compares D1 with a plan and only reads. A Film is `corrected` when it holds exactly `d1Expected`, `pending` when it still holds `d1Before`, and `mismatch` otherwise. A partial or tampered correction is never `corrected`, and a new plan reports it as `owner_review` (`partial_correction`).

## Production correction (AIR-291)

This procedure describes future corrections; it does not retroactively change the historical execution or evidence. Classify each action using [risk-proportional operational safeguards](../process/agent-workflow.md#risk-proportional-operational-safeguards). Creating an absent `identity/tmdb-retirements.json` with four approved entries and a single writer is **lightweight additive**. Overwriting an existing object, changing additional identities or encountering another writer is **not**: stop and use the elevated/high-impact path. The owner must explicitly approve the production write and any separately needed operational call; code deployment is never that approval.

1. **Bounded read-only preflight.**
   - Confirm the relevant runtime and projector code is deployed and both post-merge jobs passed. Check the approved evidence and exact four Film identities against the current authoritative source. A targeted D1 readback/dry-run is sufficient when it establishes the required before-state and no collisions; do not require an unrelated full R2 snapshot merely to prove the new key is absent.
   - Confirm all four targeted Films are `ready` under the applicable plan, with no `owner_review` or `refused`; unexpected identity conflicts stop the operation. For a new key, confirm key absence with a direct target-specific GET immediately before the write, not a bucket-wide snapshot.
2. **Bounded recovery and concurrency.**
   - Record the exact approved body bytes, SHA-256, target key, target absence and the four Films' relevant pre-write identity/readback; identify the simple rollback (remove the newly created key and let the normal projector converge). Keep the complete plan privately where appropriate.
   - Confirm no competing writer for this exact key and no active projector/metadata operation that would invalidate the four Films' identity assumptions. A full fenced R2 snapshot and D1 Time Travel bookmark are **not default prerequisites** for this additive case. Escalate to scoped before-images, fencing, snapshot and bookmark only if an existing object, competing writer, non-reversible change or materially larger blast radius is found.
3. **R2 write.**
   - Write the approved plan's `r2Retirements.body` to `identity/tmdb-retirements.json` once, preferring a conditional put (`onlyIf` absent) when the available writer supports it. Existing-key updates require separate elevated-risk review and an expected-etag conditional write; never treat an existing object as an additive creation.
   - Read it back.
   - **Alternative: the Cloudflare API, unconditionally.** Use this when no S3 writer credential is available. The Cloudflare REST API (`PUT /accounts/{account_id}/r2/buckets/iptv/objects/identity%2Ftmdb-retirements.json`) has no conditional put. It is acceptable only because no Worker, Task or script writes this key. It needs its own owner gate:
     - Before the write, show the owner the exact body, its SHA-256 and byte length, the four Films with their old and new ids, the target key and the **bounded rollback**. The action-specific approval names that SHA-256. It is not a second gate on top of an equivalent approval solely because the Cloudflare API lacks conditional PUT.
     - Immediately before the PUT, `GET` the exact key and require `404`. Confirm single-writer ownership and no conflicting operation; a GET followed by PUT is **not atomic**. If it exists or exclusive ownership cannot be established, stop and choose a conditional-capable/elevated path.
     - Put the approved bytes once, with `content-type: application/json`. Do not retry blindly: after any error, `GET` first.
     - `GET` the key back and require identical bytes (or the same SHA-256 and byte length). On conflict, mismatch or unknown outcome, stop instead of repeating an unconditional PUT.
       - Check the body with `tmdbRetirementSet` (`ok: true`, four retirements) before PUT; read-back integrity and the downstream projector's scoped result complete the normal lightweight checks.
4. **D1.** D1 is not written by hand. The [ADR 0056](../adr/0056-d1-enrichment-write-through.md) enrichment projector owns each Film's identity rows and rewrites them from R2, so one projector run after the R2 write carries the four Films. If the projector is off (`D1_ENRICHMENT_WRITE` unset), D1 stays `pending` until it runs or until a reload replays R2; there is no separate D1 write path.
   - The run's summary (`GET /api/d1/status`, `lastRun.summary`) carries `tmdbRetirements`. Expect `valid: true`, `applied: 4`, `held: []`.
   - `outcome: failed` with `reason: input_invalid` and `inputKey: identity/tmdb-retirements.json` means the object failed its check: nothing was written. Stop, and roll back R2 or correct the object under a new approval.
   - A Film in `held` is owner review. Examples: `link_changed` (the refreshed Letterboxd page shows no TMDB link or another one), `attributes_changed` (its `data-tmdb-*` attributes changed), `film_missing` (no R2 source lists it). The projector neither writes nor releases it, so its D1 rows and watchlist membership stay as they were.
5. **One scoped downstream acceptance.**
   - Once the existing projector has run (do **not** trigger it without separate owner approval), check its targeted `tmdbRetirements` summary and `d1Readback` against the accepted plan: the four Films must be `corrected`; `held` or `mismatch` stops for review. If the projector is inactive, record D1 as `pending` rather than inventing success.
   - Check relevant identity / coCredit preservation in the **same scoped verification** when the plan requires it. Do not automatically re-run the entire dry-run merely to duplicate `d1Readback`; re-run it only if the scoped result is ambiguous, a conflict appears or the plan's assumptions changed.

## Rollback

- **R2.** Remove the four entries from `identity/tmdb-retirements.json` (or delete the object if it holds only them). The projection then reads the records' movie ids again. Through the Cloudflare API this is a `DELETE` of the key, under its own owner approval, followed by a `GET` that must answer `404`.
- **D1.** No hand-written inverse SQL. After the R2 rollback, the next projector run writes the four Films' previous identity back from R2. `d1Readback` against the preflight plan must then show them `pending`.
- **Whole-database restore (exceptional).** A D1 Time Travel restore is not the routine rollback for a single additive R2 key. It requires a separately authorized, high-impact recovery decision and can discard unrelated newer writes. Do not take a D1 bookmark as a prerequisite for every lightweight change.

- Code rollback restores neither R2 nor D1. The retired movie ids are never deleted, so no rollback needs them back.
- A code rollback to a release whose projection does not read the object, while the object exists, is a D1 rollback too. That projector ignores the object, so its next run writes the four Films' movie identity back. The object stays in R2, and redeploying the runtime reapplies it on the next run.

## Credits replay

`scripts/tmdb-watchlist-credits.mjs` reads a Film with a trusted `tmdb_tv` from its TV entry. After a D1 reload (and the reapplied correction), the four Films replay their AIR-286 credits from the saved `tv-<id>.json` answers, without asking the retired movie endpoints or Letterboxd. Until the correction is in D1, the script reaches the same TV entries through the saved Letterboxd links ([runbook](tmdb-watchlist-credits.md)).
