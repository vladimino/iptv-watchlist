# Letterboxd claim backfill: read-only preflight, L3 plan and readback (owner approval required)

Applies to the module `src/canonical-letterboxd-claim.js`, whose producer is active from the AIR-559 activation PR on ([ADR 0184](../adr/0184-ratings-confirmed-letterboxd-claim-on-existing-film.md), Accepted). Nothing here authorizes a production write: the backfill is an L3 operation under [authorization and escalation](../process/authorization-and-escalation.md) and needs an owner-approved plan before it runs, even for a handful of rows.

## Activation of the producer path

The Ratings flows offer their durable links to the claim module. The module acts only while the constant `LETTERBOXD_CLAIM_ACTIVATED` in `src/canonical-letterboxd-claim.js` is `true`; the activation PR sets it to `true`. While inactive, the flows write nothing for claims and store nothing. While active:
- an unproved id keeps a bounded `claim_pending` entry in the Diary identity document; after six attempts it stays visible and is no longer served. Since AIR-599 the document never evicts a `claim_pending` entry to make room (only `owner_dismissed` entries are evictable; a new id waits in the backlog instead), the entry keeps its queue position, and it is listed in the `diary_identity` lane of `/admin/identity` ([contract](../reference/integrations/letterboxd-ratings.md#one-retry-contract-for-both-callers-air-599-adr-0207-decision-4b));
- the baseline import offers verified entries only, and a replay of a committed chunk re-offers it;
- reverting the line stops new claims, but claims already written stay (see Rollback).

A zero cohort in the backfill `dry_run` does not by itself show that the producer path is active.

### Activation plan (owner GO required; the gate stays `false` until then)

1. **Scope.** The producer claims **verified pairs only**:
   - a pair the Diary identity step verified itself (Letterboxd page and TMDB check), an existing trusted bridge, or a confirmed `link_failed` repair, plus their `claim_pending` retries for the same movie. The step runs from the Letterboxd Sync Workflow's ratings (Diary) phase and its Watchlist admission step, inside the Sync's epoch fence;
   - verified items of an owner-driven archive baseline commit.

   A lid that the link index alone ties to a movie is not offered. An inferred link is never offered and is refused by the planner (`identity` or `inferredPairs`). The rated-candidate step is not wired. No backfill is part of the activation.
2. **The change.** Exactly three lines in one reviewed PR, each marked `ACTIVATION DIFF` where it is a test:
   - `src/canonical-letterboxd-claim.js`: `export const LETTERBOXD_CLAIM_ACTIVATED=true;`;
   - `tests/canonical-letterboxd-claim.mjs`: the "ships off" assertion becomes `true` / "ships on";
   - `tests/canonical-film-external-ids-producer.mjs`: the literal check becomes `=true;` / "the activation gate is on".

   Everything else follows the constant or passes `enabled` explicitly, so the explicit disabled coverage stays. The activation PR also carries one small fix of the read-only status tool: a bare, empty or malformed `--since` (missing value, an option in its place, a non-calendar date such as 2026-02-30) is refused before any connection instead of degrading to a baseline. `tests/letterboxd-claim-activation-rehearsal.mjs` already runs the whole producer with the gate on, from a private copy of `src/`. The full suite and the build were also run on the exact gate-on candidate (these three lines on top of this plan's commit): core and non-functional all passed, build passed. The activation PR repeats that on its own HEAD. It is merged only after the owner's GO; the ordinary deploy then activates it.
3. **Preflight, read-only, immediately before the GO:**
   - `feature_flags` (no flag gates this producer; it is the constant);
   - `ratings_sync_status`: Letterboxd Sync mode `cloudflare` and healthy, the next slot due;
   - the backfill `dry_run`: `already_current`, no blockers;
   - `node scripts/letterboxd-claim-producer-status.mjs --baseline`. It reports both authorities, the claim unit's receipts by state, the `letterboxd` claims by provenance and the `claim_pending` queue. The tool requires `--baseline` or `--since`; it never silently reports a baseline for a readback.
   - Record `T` as the **start** of the activation deploy window, in UTC (the merge time, at the latest the start of the `Deploy to Cloudflare` job), so that an early active write cannot fall before it.
4. **Natural producer pass (no artificial trigger).** The first natural event is either a new Letterboxd id that the Watchlist admission step verifies, or a Diary id without a Ratings TMDB link that the Diary step verifies. Each needs a Film the admission creates. The Sync runs four slots a day.
5. **Independent authoritative readback**, measured on the claim writer alone and not through the Ratings workflow: `node scripts/letterboxd-claim-producer-status.mjs --since T`.
   - **Accept** only on a settled natural pass with open authorities: the tool's `acceptance.accepted` is `true`. That requires `authoritiesOpen`, `settled` (every receipt since T `applied`), `natural` (`films ≥ 1`), `allProved` (`claimed = proofHolds = startedFound = films`, no `problems`) and `pendingAtBoundZero`. In addition, `claims.bySource.ratings_alias_bridge` must have grown by exactly `films` against the baseline.
   - Then run the backfill `dry_run` again and confirm it is still `already_current`.
   - The tool re-proves each claim with the planner and resolves it with `catalogStartedFilm`. It prints no identifier and sends no write.
   - **No natural event within the observation window** is not a failure and not an acceptance. The card goes to `Верификация` with this criterion and the readback command.
6. **Stop and rollback.** Revert the constant in a reviewed PR and deploy if any of these appears:
   - a receipt in `failed`, `unknown` or `abandoned` state;
   - any `producerWritesSince.problems` entry, a claim that does not re-prove, or a lid the Started reader does not find;
   - growth of `claim_pending` at the attempt bound;
   - a claim on a pair outside the verified scope.

   The revert stops new offers. Written claims stay and are repaired case by case after a separate owner decision ([ADR 0192](../adr/0192-retire-view-index-selector-and-raw-object.md)). No Started mark, Event, alias or Film is written by the producer, so none needs rollback.
7. **Limits carried into activation.**
   - The legacy audit is a reconstruction of the current state under the historical writer invariant, not a replay of the deleted import receipts. Its one detected pair is marked and refused.
   - An undetected legacy inferred pair would pass the planner, but no producer offers it, because index-only pairs are not offered. It can gain a claim only after a verified flow proves the same pair independently.

**Legacy inferred pairs (owner decision before activation and before any further backfill).** The production import of 8 to 9 November 2026 ([AIR-388 evidence](../evidence/letterboxd/air-388-full-import-2026-11-10.md)) linked `inferred` pairs before the pair mark existed. A pair it linked on a Diary-first record (facts and lid, no TMDB id) carries no mark, and the planner cannot tell it from a verified pair. The import's chunk receipts were deleted by the AIR-528 cleanup, so the [read-only audit of 23 November 2026](../evidence/d1-migration/air-559-legacy-inferred-pair-audit-2026-11-23.md) reconstructed the current cohort from the fact records, the mutable `letterboxd/admissions/verified-films.json` (`identity: "inferred"` per retained admission), D1 `film_rated_admission` and the canonical claims, under the historical writer invariant. It detected **one** such pair and no claim on it or on any inferred-marked record; this is not a replay of the deleted receipts. The owner chose on 24 November 2026 to mark that one record with the one-record repair below, and it was [applied and read back the same day](../evidence/d1-migration/air-559-inferred-pair-repair-apply-2026-11-24.md): the planner now refuses that pair. A pair's presence in the link index or on its record is still not evidence that it was verified. Activation and any further backfill keep their own plan and owner GO.

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

## Current blocker status of the live planner (AIR-653, 28 Nov 2026)

The planner reads the Ratings projection with `alias_id=? OR alias_id=? OR fact_key=?`. Before migration `0055` the `fact_key` term had no index and the statement scanned `ratings_view`; the AIR-652 offline evidence recorded that as a live-run blocker (and it remains the dated historical record). Migration `0055` adds the index ([runbook](ratings-view-fact-key-index-0055-apply.md)); it was **applied to production on 28 Nov 2026** ([evidence](../evidence/d1-migration/air-653-0055-apply-2026-11-28.md)); the former scan is gone and the live read is index-served. The private bounded capture is the requirement of the **AIR-653 historical cohort** (the bridge-only prediction keys of AIR-652), because the unchanged planner is unbounded on a live database; it is not a cancellation of the published-programme operator contract below or of its permitted ordinary use (its `dry_run` and, with its own owner GO, its `apply`). The AIR-653 promotion keeps its own plan, frozen cohort and owner GO.

## Bounded cohort preflight for the AIR-653 historical keys (read-only)

`scripts/letterboxd-claim-cohort-preflight-production.mjs` runs the AIR-652 design against production D1 and writes nothing. Before any other read it verifies from `sqlite_master` that the two indexes the reads rely on exist (`ratings_view_fact_key`, migration 0055, and `tmdb_retirement_decision_movie`, migration 0040); a missing one stops the run as `required_index_missing` and is listed as the blocker of that run. Then it captures exactly the planner's inputs through the AIR-647 counted database (single `SELECT` statements, charged to **one** shared statement and row budget before each statement, over indexed predicates only), runs the **unchanged** planner on a private sqlite snapshot of the captured rows, and repeats the capture and the discovery to fence movement (any difference is `unknown`, no digest). The transport refuses every request that is not one `SELECT` or `WITH ... SELECT` and stops on any answer that reports a write; the identity (uuid and name) of the production target is read first. It makes no Letterboxd or TMDB request and sets no flag, Task or lease. Tests: `tests/letterboxd-claim-cohort-preflight-production.mjs` (offline, stub transport) and `tests/prediction-alias-bridge-cohort.mjs` (the design, importing the same module `scripts/letterboxd-claim-cohort-preflight.mjs`).

```bash
set -a; . ~/.config/iptv/d1-backfill.env; set +a
NODE_USE_ENV_PROXY=1 node scripts/letterboxd-claim-cohort-preflight-production.mjs --out <fresh private path> (--archive <sha256>... | --witness-all-archives)
```

- **Witness scope (exactly one of two).** `--archive <sha256>` (repeatable) names the inferred-import archives of the AIR-559 audit: a witness is positive only for the same lid and movie in a named archive, so an admission of another archive is invisible to it. `--witness-all-archives` is the explicit conservative mode: the witness set is every admission of the movie across all Films and archives, the same lid and movie blocks (`inferred_admission_witness`), an admission of the movie under another lid is never ignored (`unknown / witness_movie_admitted_other_lid`), and only a movie with no admission at all can be `eligible_in_scope`. It is a stronger negative test, not a new identity proof, and does not change ADR 0184. Without either, a planner `pass` is `unknown / witness_scope_missing`. The scope is bound into the proof: a different scope is a different read-set digest. The AIR-652 residual limits remain (a deleted admission row and an inferred link that never had one are not seen).
- **Private output.** `--out` must be a path that does not exist yet, in a directory whose real path is outside the repository (a symlinked parent that resolves into it is refused). The file is created exclusively, without following links, mode 600; an existing file or link is refused, never truncated. It holds the exact result, the `eligible_in_scope` pairs and the raw detail, and stays outside GitHub and Trello. Choose a fresh path for every run.
- **Output and errors.** The printed report holds counts per class and reason, the separate key and distinct-Film counts, the reserved and actual work, the scope, the digests, the transport totals, the live blockers of that run and the standing limitations; never a lid, movie, key or Film id, and never a raw error or detail. A failure prints one controlled code (`unexpected_error`, `d1_<kind>`, `operator_<reason>`, a usage message).
- **Caps.** The AIR-652 defaults (300 statements, 6,000 rows reserved, 2,000 pointer rows per discovery pass, 64 candidates); a flag may change one only up to a fixed ceiling (2,000 statements, 60,000 rows, 20,000 pointer rows, 512 candidates). A cap reached is `unknown` with `coverage: incomplete`, never a partial cohort.
- **What a result is.** `eligible_in_scope` is a planner `pass` plus a negative witness inside the stated scope. It is **not** production eligibility and **not** a GO. A complete capture is a capture decision, not an eligibility decision. The published-programme operator below derives only `published_epg_member` candidates and caps a call at 12 pairs, so its pins do not authorize a historical pointer cohort; a promotion of that cohort uses the existing ADR 0184 writer with an owner-approved exact allowlist, a full re-proof at write time and its own L3 GO.
- First dated capture: [AIR-653 evidence](../evidence/film-person/air-653-cohort-preflight-2026-11-28.md).

## Historical cohort operator for the AIR-653 pointer keys (dormant; its apply needs its own owner L3 GO)

`scripts/letterboxd-claim-historical-production.mjs` writes the trusted `letterboxd` claims of the historical bridge-only pointer cohort through the **existing** ADR 0184 writer (`applyLetterboxdClaim`: the fenced `film_external_ids` unit in `addOnly` mode, the receipt protocol of `receiptedWrite`, the revision compare-and-swap and the write-time guards). It is not the published-programme operator above (that one derives only `published_epg_member` candidates and caps a call at 12 pairs, so its pins do not authorize this cohort), it discovers nothing and it widens no admission and renames no key. The pairs come only from the owner's **private allowlist**: the `eligible` list of the private file that the bounded capture wrote (`letterboxd-claim-cohort-preflight-production.mjs`), outside the repository. Outputs carry counts, reasons, digests and generations, never a lid, movie or Film id.

```bash
set -a; . ~/.config/iptv/d1-backfill.env; set +a
# dry_run (default, read-only)
NODE_USE_ENV_PROXY=1 node scripts/letterboxd-claim-historical-production.mjs --allowlist <private file>
# apply (after the owner's GO on the pins of that dry_run)
NODE_USE_ENV_PROXY=1 node scripts/letterboxd-claim-historical-production.mjs --allowlist <private file> --apply --confirm-go --request-id <id> \
  --expected-film-person-generation <g> --expected-ratings-generation <g> --expected-schema-version <v> \
  --expected-owner-review-generation <g> --expected-owner-review-writes <open|held> --expected-count <n> --expected-digest <sha256>
```

- **Bounded and strict proof.** `dry_run` is the accepted bounded capture on exactly the given pairs (no discovery): one shared statement and row budget, the unchanged planner only on a private snapshot, the all-archives witness (any admission row of the movie, under any lid and archive, blocks), a second pass that fences movement, and both required indexes verified by their exact definitions. Every read of the operator is **strict**: a REST answer without its result array is an error, never an empty table, so an unreadable witness, claim, link or retirement row is `unknown` and nothing is written (tested through the real adapter). The live planner runs only inside the writer at write time, one pair at a time; before each pair the link-index document is measured against the AIR-647 caps, so the writer's live reads per run are bounded by the pair cap and that capped document, not by the size of the store.
- **Decision and pins.** `decision` is `eligible`, `already_current`, `unsafe` or `unknown`. The seven pins: Film/Person generation, Ratings generation, schema version, owner-review generation, owner-review writes, the count and the digest of the sorted `lid:tmdb` lines (the capture's `candidateDigest`). Any receipt of the writer's origin for these Films that is not `applied` (a prior attempt) makes the cohort `unsafe` (`prior_receipt_unresolved`): a partial or unknown outcome is never retried or replayed by this operator, and recovery is a separately approved decision with a new dry run.
- **Approval fence through the receipt lifecycle.** The pins are bound as `approvedPins` of the existing receipt protocol, with two extra conditions (the frozen Ratings generation and, per pair, the absence of any admission row of the movie): they are asserted in the **reservation** of the receipt and in the claim's batch. A pin or a witness that changed before the reservation refuses the pair before any receipt exists; one that changes between the reservation and the claim leaves the reserved receipt and no claim. The frozen markers are also checked before the first write and before every pair.
- **apply** needs `--confirm-go`, a request id and all seven pins; it derives everything again, refuses with zero writes on a decision other than `eligible` or any differing pin, writes one pair after another and stops at the first that is not proved: no retry, no attempt on the rest.
- **Two kinds of write, reported separately:** `claimsWritten` (claim rows) and `receipts.created` (receipt rows). A pair refused inside the claim batch can still leave its reserved receipt, so a rolled-back claim batch is **not** zero database writes.
- **Strict readback (fails closed).** For every proved pair the operator reads: the exact claim row (the planned Film, trusted, not conflicting, the ADR 0184 provenance with the movie); for a written pair the exact applied receipt (the request id the writer derives from origin, operation, event, target and content digest; the operation, origin, target and content digest; state `applied`; the applied revision equal to the Film's revision before the run plus one and to its revision now); the reader that answered `404 Unknown film` agreeing on the **Film and the movie**, not merely `found`; and a fresh proof of the pair saying `already` for that Film. Per target Film the effects are exactly: the revision plus one and one more applied receipt for a written pair, nothing for any other. The table counts (`film_external_id` plus the claims written, `film_alias`, `ratings_view` and `started_mark` unchanged; a table that is absent must stay absent) are a coarse tripwire, not proof of no collateral change. The marker fence runs **after** all reads. Outcome `complete` only when all of it holds; `partial` when the run stopped before every pair was proved; `unverified` when every pair was proved by the writer but any read failed, any check failed, a marker moved or an effect is inexact. Never `complete` on an unreadable proof.
- **Cap and window.** At most 12 pairs per run (the writer's own unit cap): a larger cohort is several runs, each with its own allowlist file, pins and request id, under the owner's GO. Run it between Ratings Sync slots: the Ratings generation moves with every natural Ratings write, and a moved pin refuses the run with zero writes.
- **Exit codes:** 0 dry run or `complete`; 2 invalid input; 3 nothing written (`refused`); 4 `partial`; 5 `unverified` or write state unknown; 1 other failure. Every apply answer carries the tracked `writeState`.
- **Rollback and recovery.** A claim written by mistake is corrected case by case after a separate owner decision (ADR 0192); a code revert does not remove it. A reserved receipt without its claim, or any unknown outcome, is settled by a read-only dry run and an owner decision, never by repeating the apply. Nothing here writes a Started mark, Event, alias, rating or Film row of its own; the writer itself updates the Film's write time and revision and its receipts, as it does for every producer.
- Tests: `tests/letterboxd-claim-historical-production.mjs` (offline: the real writer, receipt protocol and planner over a sqlite world, and the real REST adapter with strict reads over a stub transport).

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

## Bridge evidence row (AIR-618, [ADR 0215](../adr/0215-identity-evidence-full-model.md) choice 0215-8b = C)

The backfill hands over **no page-check root**, so a claim it writes never has a `claim_alias_bridge` evidence row, whatever the writer's state: it is ineligible for bridge evidence by definition, which is neither a refutation nor a coverage failure. The nine historical claims are reported as `bridge_root_unavailable` by the later reconstruction card, not written here. Only the live Diary or Watchlist step that has just page-checked and linked a pair can hand a root over; see the [writer activation runbook](identity-evidence-writer-activation.md). Receipts, request ids and the cohort digest of the backfill are unchanged.

## Rollback and recovery

Code rollback does not remove written claims. A claim written by mistake is corrected case by case after a separate owner decision (the baseline `unlink` route is retired, [ADR 0192](../adr/0192-retire-view-index-selector-and-raw-object.md)); the receipt and the fixed provenance are the audit trail. Do not delete rows by hand.
