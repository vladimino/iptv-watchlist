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
2. **Runtime integration** (a separate card): the lifecycle projection applies `identity/tmdb-retirements.json`; `parseFilm` keeps the typed TMDB link through metadata refresh; `tmdb_tv` reaches D1 through the Film projection; movie-only consumers never receive a TV id. **The production correction must not run before this ships**, or the next projection or metadata refresh writes the retired movie id back as trusted.
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
  - a fenced R2 snapshot (`--snapshot`, read-only, via `scripts/snapshot-store.mjs`; a fresh production snapshot needs owner approval).
- The plan is written to `--output` (mode 600). The command prints counts only. It makes no TMDB or Letterboxd request and executes no statement.

For each Film the plan states:
- `old` and `new` typed ids, `before` and `after` (`canonicalIdentity`, the `tmdb` and `tmdb_tv` entries with trust and provenance);
- `collisions`: a trusted `tmdb_tv` already on another Film. This puts the Film into `owner_review`.
- `numericOverlaps`: the same number as a movie id on another Film. This is reported, not a reason to stop.
- a second Film still trusting the retired movie id (only possible in R2): `owner_review`;
- `preserved`: what must not change.
  - credits, split into Letterboxd and AIR-286 TMDB;
  - prediction, rating, watchlist membership, redirects and localization.
- `d1`: the guarded statements of a later run;
- `r2`: with `--snapshot`, every record that carries the movie or TV number. These records are reported, not rewritten.
- `r2Retirements`: the body of `identity/tmdb-retirements.json`, containing only `ready` Films.

`status` is `ready`, `owner_review` (unexpected state, nothing planned) or `refused` (missing evidence, or the Film is missing). `unchanged` counts Films already corrected. A repeated plan after a correct run is all `unchanged`, with no statements.

## Production correction (AIR-291)

Each step needs its own explicit owner approval. A code deploy authorizes none of them.

1. **Read-only preflight.**
   - Confirm the runtime card is deployed and both post-merge jobs passed.
   - Run the dry-run against a fresh fenced R2 snapshot and against production D1 (read).
   - All four Films must be `ready`. Any `owner_review` or `refused` stops the run for review.
2. **Recovery points.**
   - Record the fenced snapshot identity and a D1 Time Travel bookmark.
   - Confirm that no AIR-275 reload, metadata refresh or discovery run is due inside the window.
3. **R2 write.**
   - Write the plan's `r2Retirements.body` to `identity/tmdb-retirements.json`, once, with a conditional put (`onlyIf` absent, or the expected etag).
   - Read it back.
4. **D1.** With the [ADR 0056](../adr/0056-d1-enrichment-write-through.md) enrichment projector active, D1 follows from the R2 entry: let one projector run carry the four Films, and do not run the statements alongside it. Only if the projector is off, write D1 as follows, each step separately approved.
   - Execute each Film's `d1` statements as one batch per Film.
   - Every statement is guarded by the state it expects, so a repeated batch changes nothing.
5. **Readback.**
   - Re-run the dry-run: all four must be `unchanged`, `preserved` must equal the preflight values, and there must be no collisions.
   - Check that the `coCredit` pairs of the four Films are unchanged.

## Rollback

- **R2.** Remove the four entries from `identity/tmdb-retirements.json` (or delete the object if it holds only them). The projection then reads the records' movie ids again.
- **D1.** Either run the inverse guarded statements or restore D1 to the bookmark. The inverse statements are:
  - `canonical_identity` back to `tmdb:<movie>`;
  - the `tmdb` row back to `trusted=1` with its `provenance.previous`;
  - delete the `tmdb_tv` row;
  - the identity `source_version` back to `tmdb:<movie>`.

  A restore also discards any other D1 write made after the bookmark.
- Code rollback restores neither R2 nor D1. The retired movie ids are never deleted, so no rollback needs them back.

## Credits replay

`scripts/tmdb-watchlist-credits.mjs` reads a Film with a trusted `tmdb_tv` from its TV entry. After a D1 reload (and the reapplied correction), the four Films replay their AIR-286 credits from the saved `tv-<id>.json` answers, without asking the retired movie endpoints or Letterboxd. Until the correction is in D1, the script reaches the same TV entries through the saved Letterboxd links ([runbook](tmdb-watchlist-credits.md)).
