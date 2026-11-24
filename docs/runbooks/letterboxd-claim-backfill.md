# Letterboxd claim backfill: read-only preflight, L3 plan and readback (owner approval required)

Applies to the dormant module `src/canonical-letterboxd-claim.js` ([ADR 0184](../adr/0184-ratings-confirmed-letterboxd-claim-on-existing-film.md), Accepted). Nothing here authorizes a production write: the backfill is an L3 operation under [authorization and escalation](../process/authorization-and-escalation.md) and needs an owner-approved plan before it runs, even for a handful of rows.

## Activation of the producer path

The Ratings flows already offer their durable links to the claim module, which stays inactive until the constant `LETTERBOXD_CLAIM_ACTIVATED` in `src/canonical-letterboxd-claim.js` is changed to `true` in a reviewed change. That change is a production activation: it needs the owner's explicit GO, after the backfill preflight and after the matching tests pass, and it is separate from the backfill. Reverting that line stops new claims; claims already written stay (see Rollback). While inactive, the flows write nothing for claims and store nothing. While active, an unproved id keeps a bounded `claim_pending` entry in the Diary identity document (six attempts, then it stays visible and is no longer served); the baseline import offers verified entries only and a replay of a committed chunk re-offers it. The natural producers after activation are the Diary identity step of the Letterboxd Sync Workflow's ratings and Watchlist admission steps (only pairs that step verified itself: a verified page check, an existing trusted bridge or a confirmed `link_failed` repair, and their `claim_pending` retries) and an owner-driven archive baseline commit (verified items only); the rated-candidate identity step is deliberately not wired, and a marked inferred pair is refused by the planner whichever flow offers it. A zero cohort in the backfill `dry_run` does not by itself show that the producer path is active.

**Legacy inferred pairs (owner decision before activation and before any further backfill).** The production import of 8 to 9 November 2026 ([AIR-388 evidence](../evidence/letterboxd/air-388-full-import-2026-11-10.md)) linked `inferred` pairs before the pair mark existed. A pair it linked on a Diary-first record (facts and lid, no TMDB id) carries no mark, and the planner cannot tell it from a verified pair. The import's chunk receipts were deleted by the AIR-528 cleanup, so the [read-only audit of 23 November 2026](../evidence/d1-migration/air-559-legacy-inferred-pair-audit-2026-11-23.md) reconstructed the current cohort from the fact records, the mutable `letterboxd/admissions/verified-films.json` (`identity: "inferred"` per retained admission), D1 `film_rated_admission` and the canonical claims, under the historical writer invariant. It detected **one** such pair and no claim on it or on any inferred-marked record; this is not a replay of the deleted receipts. The owner chose on 24 November 2026 to mark that one record (the one-record repair below). Until that repair has been applied and read back, a backfill cohort must not be approved on the planner's verdict alone and the activation line must not be switched: a pair's presence in the link index or on its record is not evidence that it was verified.

## One-record repair of the legacy inferred pair (AIR-559)

`scripts/letterboxd-inferred-pair-repair.mjs` appends the missing `inferredPairs` entry to the ONE fact record the audit detected. The claim planner then refuses that pair (`not_proved / ratings_link_inferred`) like every other inferred pair. The script is single-purpose: it is not a generic operator, adds no runtime writer, reads no R2 object and sends no hand-written SQL write. The pair and its provenance archive are owner-private inputs taken from the audit's private output; the repository and every report hold only counts, hashes and verdicts. The owner's GO of 24 November 2026 covers the implementation, the offline tests, the PR and read-only dry runs. **The single apply needs its own owner GO on the pins of a fresh dry run.**

Credentials: the D1 API token variables of the [credential conventions](../../.claude/skills/iptv-credentials/SKILL.md) (`D1_BACKFILL_*`); behind a proxy add `NODE_USE_ENV_PROXY=1`. The script checks the account and the database identity before any read.

1. **Dry run** (default, read-only): `node scripts/letterboxd-inferred-pair-repair.mjs --lid <lid> --tmdb <n> --archive <sha256>`.
   - It reads the ratings marker (`d1/open`), the link index, the record, the D1 `film_rated_admission` row and the canonical `letterboxd` claims of the lid.
   - `decision` is one of:
     - `eligible`: the record states exactly this pair, the index agrees and is unambiguous, and the record is settled and stored in canonical JSON; it has no `identity`, no entry for the pair, a readable list with fewer than 8 entries, exactly one admission row with this lid, movie and archive, and no canonical lid claim;
     - `already_marked`: nothing to do;
     - `refused` with a typed reason.
   - `expect` holds the four pins: `generation`, `recordEtag`, `linksEtag`, `planDigest`. `planner` shows today's verdict, which is `pass` before the repair.
2. **Owner GO** on that dry run's decision and four pins, for one apply.
3. **Apply:** `… --apply --confirm-go --request-id <id> --expected-generation <g> --expected-record-etag <e> --expected-links-etag <l> --expected-plan-digest <d>`.
   - It re-reads everything and refuses with zero writes (`not_attempted`) on any pin difference or on any decision other than `eligible`.
   - It then makes ONE RatingsD1 `putOwned` call. It never uses `casOwned`, so there is no automatic rebase or retry.
   - That call is one atomic D1 batch. It carries the existing fences (the record etag compare-and-swap with the `changes()` fence, the marker `d1/open`, the generation bump) and four guards asserted **inside** the batch: the exact ratings generation, the link-index etag, the admission row (lid, movie, archive) and the absence of any canonical `letterboxd` claim of the lid.
4. **Outcomes** (the exit code in brackets; every apply answer also carries the connection's tracked `writeState`: `none`, `unknown` while a write is in flight or after it failed, `committed` once a write was proved):
   - `applied` (0): the batch committed, the record reads back as planned and every readback check passed.
   - `not_attempted` (3): a pin or the decision did not hold at the re-read; nothing was sent.
   - `refused_in_batch` (3): a fence or guard of the batch did not hold (RatingsD1 reports `refused`); the whole batch rolled back and nothing was written.
   - `committed_unverified` (4): the batch **committed** (one write), but a later write replaced the record before the read-back (RatingsD1 reports `committed`), the read-back threw, or a readback check failed. It is never reported as zero writes. Run the dry run, compare, and bring the result to the owner.
   - `unknown` (5): the batch failed or its response was lost after it was sent. Run the dry run, which answers `already_marked` if the batch committed.
   - **Never repeat apply** after any outcome other than `applied`; a new apply needs fresh pins and a new GO.
5. **Readback** (part of the apply answer):
   - the stored record equals the plan, and only `inferredPairs` grew, by this one entry with the archive as `sourceRef`;
   - the ratings generation moved by exactly one;
   - the link index, the two `ratings_view` rows and the lid's canonical claims are unchanged;
   - the planner answers `not_proved / ratings_link_inferred`.

   After the apply, run a fresh dry run (`already_marked`) as the independent read-only check.

**Expected change:** one `ratings_document` record rewritten with one appended list entry, and the ratings generation +1. No fact, link, view row, admission, Film or claim changes.

**Stop rules:** stop on any `refused` or `not_attempted`, on `refused_in_batch`, on `committed_unverified` and on `unknown`. Each needs a fresh dry run and a new owner decision; there is no automatic retry.

**Rollback limits:** the entry is append-only by design, and a code rollback does not remove it. Removing it would be a separate, case-specific owner decision and its own compare-and-swap. The repair does not activate the producer or write any claim.

## The operator: MCP tool `letterboxd_claim_backfill`

The backfill runs through one owner-only MCP tool behind the existing Access and signed-JWT gate (no route, binding, Cron or Task). Merging or listing it is not a GO: `confirmGo` is a technical safeguard, the owner's separate explicit GO on the frozen cohort is the authority. Reference: [MCP contract](../reference/api/mcp.md).

1. **`dry_run`** (the default also when `mode` is omitted; no side effect). The server derives the cohort itself and judges every pair with the real planner. Read `decision`: `eligible` (all pairs pass, 1 to 12 of them), `already_current` (nothing is missing), `unsafe` (a conflict, a pair that is not proved, two candidates for one Film, more than 12 pairs, a held or non-authoritative marker) or `unknown` (a read failed, or the markers or the publication moved while the cohort was being read; no usable pins are returned then). The answer holds counts, reasons, both authority generations, the publication pin, the cohort digest and the `expect` pins, never an identifier. The private lid-to-movie list is prepared separately and stays outside GitHub and Trello.
2. **Owner GO.** The owner is shown that `dry_run` (decision, count, digest, generations, the run pin) and approves that frozen cohort and this operator.
3. **`apply`** with `confirmGo: true`, a `requestId` and the seven pins of that `dry_run` (both authority generations, the programme run id, the publication generation, the watchlist generation, the count and the digest). The publication generation and the watchlist generation matter because a new publication or a watchlist save moves them without changing the run id. It derives the cohort again and refuses with zero writes on any mismatch, any state that is not `eligible`, or a cohort over 12; there is no automatic split and no widening. It checks the frozen markers once more immediately before the first write (`state_moved`, zero writes), asserts them again inside every fenced batch and before every pair, and writes one pair after another through `applyLetterboxdClaim` (the fenced `film_external_ids` unit, `addOnly`, origin `letterboxd_claim`, a stable event of the frozen cohort and request) and stops at the first pair that is not proved.
4. **Reading the answer.** `outcome` is `complete` only when every pair is proved, `catalogStartedFilm` finds each, no pair is still missing and the row deltas are exactly the claims written (`film_external_id` plus the count written; `film_alias`, `ratings_view` and `started_mark` unchanged). Anything else is `partial`: per-pair states (`written`, `already`, `refused`, `unknown`, `deferred`, `failed`, `not_attempted`) are reported, and the run is never retried blindly.
5. **Recovery.** A partial run changes the cohort, so the same pins no longer match: run a new `dry_run`, read the readback, and ask the owner for a new GO with a new `requestId`. A lost response or an `unknown` or `deferred` pair is settled by a `dry_run` (the claim is either stored or still missing), never by repeating `apply`. A repeat of a completed request finds nothing missing and writes nothing.

Synthetic example (fake values; the shapes are real). Request: `{"mode":"dry_run"}`. Answer: `{"ok":true,"mode":"dry_run","sideEffects":"none","decision":"eligible","authorities":{"filmPerson":{"state":"open","generation":2},"ratings":{"mode":"d1","cutover":"open","generation":4000}},"publication":{"mode":"d1","cutover":"open","programmeRunId":"run-example","generation":7,"watchlistGeneration":8},"counts":{"cohort":3,"pass":3,"conflict":0,"not_proved":0,"already":0,"unresolved":0},"blockers":[],"expect":{"filmPersonGeneration":2,"ratingsGeneration":4000,"programmeRunId":"run-example","publicationGeneration":7,"watchlistGeneration":8,"count":3,"digest":"<64 hex>"}}`. The matching `apply` request is `{"mode":"apply","confirmGo":true,"requestId":"example-request-1","expectedFilmPersonGeneration":2,"expectedRatingsGeneration":4000,"expectedProgrammeRunId":"run-example","expectedPublicationGeneration":7,"expectedWatchlistGeneration":8,"expectedCount":3,"expectedDigest":"<64 hex>"}`.

## When this applies

A published programme lid has no trusted `letterboxd` claim in `film_external_id`, so `POST /api/started` answers `404 Unknown film`, while the Ratings projection ties that lid to one TMDB movie whose canonical Film exists. The cohort is whatever a fresh preflight finds; a number seen earlier is only a baseline.

## 1. Read-only preflight (no writes, owner-private output)

1. Read the Film/Person marker (`d1`/`open`, generation) and the ratings authority (`d1`/`open`, generation) and record both.
2. List the published programme lids that lack a trusted `letterboxd` claim, and for each the authoritative Ratings link: the entries `letterboxd:<lid>` and `tmdb:<n>` of the facts link index (both must name the same fact key, `tmdb-<n>` or a Diary-first `lb-<lid>`) and the fact record under that key. The `ratings_view` projection is not evidence (it keeps an alias after an unlink).
3. For each candidate run `planLetterboxdClaim` (or `applyLetterboxdClaims` with `dryRun: true`). The verdict is `pass`, `conflict` or `not_proved` with a typed reason:

| Reason | Verdict | Meaning |
| --- | --- | --- |
| `proved` / `already` | pass | write is allowed / the Film already holds the claim (no-op) |
| `ratings_link_absent`, `ratings_movie_link_absent`, `ratings_record_absent`, `ratings_not_authoritative`, `ratings_link_inferred`, `ratings_link_unverified`, `film_absent`, `invalid_input` | not_proved | not enough provenance; stop this item (`ratings_link_inferred`: the fact record carries an inferred title/year mark, `identity` or an `inferredPairs` entry naming this pair, ADR 0104, which is never proof of the lid) |
| `ratings_link_points_elsewhere`, `ratings_link_ambiguous`, `ratings_record_disagrees`, `ratings_record_not_settled`, `ratings_link_malformed`, `ratings_alias_points_elsewhere`, `ratings_alias_ambiguous`, `canonical_identity_mismatch`, `tmdb_claim_not_unique_trusted`, `film_row_missing`, `film_redirected`, `tmdb_retired`, `lid_claimed_elsewhere`, `film_has_untrusted_claim`, `film_has_other_tmdb_claim`, `film_has_other_lid` | conflict | competing evidence; stop this item, never overwrite, route to owner review |

4. Keep the exact lid-to-movie mapping owner-private. Public records carry only aggregates (counts per verdict and reason).

## 2. L3 plan (owner approval, before any write)

The plan names: the frozen cohort (private list, count and a digest), the preflight timestamp and both authority generations, the writer identity (`applyLetterboxdClaims` through the existing fenced `film_external_ids` unit, origin `letterboxd_claim`, event = the plan's cohort id, at most 12 per call), the fences (marker generation, Film revision CAS, applied receipt), stop rules (any `conflict`, `not_proved`, `unknown` or `deferred` outcome stops the run for that item and is reported, a typed infrastructure failure stops the run), the expected row changes (per item: one `film_external_id` row, one Film revision increment, one applied receipt; nothing else), the event boundary (no Started mark, no Event, no rating or alias is written), and the rollback limits (below).

## 3. Execution and readback

Run only after the owner's exact GO. Re-run the preflight immediately before: a cohort that differs from the frozen one needs a new plan. Replaying the same event with the same cohort adds no rows, revisions or receipts; an item reported `unknown` (for example an applied receipt whose claim is no longer stored) is never a success and needs a new event after a fresh preflight. Read back: every `pass` item now has exactly one trusted, non-conflicting `letterboxd` claim with provenance `ratings_alias_bridge`; `catalogStartedFilm` answers `found`; unrelated Film and Person rows are unchanged. Record aggregates as dated evidence.

## Rollback and recovery

Code rollback does not remove written claims. A claim written by mistake is corrected case by case after a separate owner decision (the baseline `unlink` route is retired, [ADR 0192](../adr/0192-retire-view-index-selector-and-raw-object.md)); the receipt and the fixed provenance are the audit trail. Do not delete rows by hand.
