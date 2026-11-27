# Film dimension parity: offline classification of `film_dimension` rows

Stage 1 of [ADR 0218](../adr/0218-film-lifecycle-dimensions-revision.md) ([AIR-660](https://trello.com/c/daGePESx)). The reader derives each Film's facts from their domain authorities (ADR 0218 decision 2) and classifies every stored `film_dimension` row under the per-column matrix of decision 1. It is offline and read only. **This page authorizes no operation**: no production read, retirement, reconciliation, import, schema apply, flag or Task.

## What it is

| Part | Path | Role |
| --- | --- | --- |
| Pure classifier | `src/domain/film-dimension-parity.js` | derived facts and the class of one row; no I/O |
| Page reader | `src/film-dimension-parity.js` | one bounded page of Films (or exactly the Films named by the option `ids`) from a D1-shaped binding; SELECT only |
| Offline report | `scripts/film-dimension-parity.mjs` | pages through a private SQLite copy opened with `sqlite3 -readonly` |
| Tests | `tests/film-dimension-parity.mjs` | real SQLite fixtures built from every migration |

Nothing in the Worker imports these modules. No route, MCP tool, Workflow or cron calls them. The only importer in `src` is the dormant stage-6 [retirement](film-dimension-retirement.md), which classifies the Films of an exact allowlist through the `ids` option.

## Classes

| Class | Meaning | Later stages |
| --- | --- | --- |
| `control` | the row may be the only durable record of a decision: an `owner` authority or `reviewed` identity row, an identity `titleSource`, a metadata row matching the ADR 0214 lock (`status='reviewed' OR authority='owner'`), an applied reviewed/owner localization, or a provisional localization whose source has no `film_localization_source` row (`projection_sole_record`) | kept |
| `agree` | a provisional localization projection equal to the existing resolver's output over its authorities | kept |
| `stale_copy` | a copy whose truth lives elsewhere (identity/metadata without control state, fingerprint, prediction), or a localization projection the resolver would now choose differently (`projection_stale`, ADR 0218 F5) | only fingerprint, prediction and unlocked metadata rows can become stage-6 candidates, and only with their own L3 GO |
| `unknown_legacy` | a value no writer produces: a `status` outside the AIR-42 lifecycle enums plus `reviewed` (and, for identity, the ADR 0216 verdict words), on any dimension; an unknown `authority`; an `owner` or `dictionary` authority on a localization row that is not `reviewed` (never treated as an automatic candidate); a `reviewed` or authority-carrying fingerprint/prediction row; a `titleSource` outside identity; an unreadable or non-object `provenance_json` on any dimension; conflicting owner titles. A metadata row matching the lock predicate stays `control` even when it is odd | retained and reported |

A copy's stored status is never compared as truth. The difference with the derived fact is reported as `diverges` for information only. Every row carries `proof`: `complete` only when the derived fact of its dimension is fully proved; `incomplete` when it was read but not proved (candidate coverage incomplete, a partial, unknown or conflicting prediction state, a missing metadata row or an unproved null field); `unavailable` when it could not be read (Film/Person held, prediction `r2` or held, owner review not `d1`/`open`, or an identity verdict that did not pass the fence). `stale_copy` alone never means safe to retire: a later stage also needs proof `complete`. An identity row created by a ranked title write (status `unresolved`, `provenance_json` `{titleSource}` only; [ADR 0220](../adr/0220-identity-row-created-by-ranked-title-write-is-a-titlesource-carrier.md), AIR-662) is a `control` row (`title_source`) whatever the derived verdict is; `unresolved` is a known AIR-42 status, so it is never `unknown_legacy`. A **marked owner projection** (`provenance_json.projection='owner_review'`, the localization row the projection-aware writer materializes from an owner decision, AIR-662) is read as a copy of `owner_review_entry`, not an independent owner authority: `agree` (`owner_projection`) while the current decision resolves to its value; `control` with `owner_projection_stale` after the decision is removed or changed (the note `expected_<tier>` and `expected` give the resolver output); `control` with `owner_projection_unproved` when the owner evidence is unavailable or conflicting (never read as a proved revocation). None of them is `stale_copy`, so none is retirement-eligible; a stale one is the handoff to the separate reconciler (AIR-663). An unmarked owner/reviewed row stays `control` (`owner_applied`).

## Derived facts and their limits

- **Identity and the fatal fence:** the ADR 0216 decision 3 verdict for a canonical `film:` id: `found`, `redirected`, `absent`, `conflict`, `cycle` or `unavailable` (a redirect to a missing survivor is `unavailable`, not `absent`). Only `found` and `redirected` pass: for every other verdict no alias is authorized, no metadata, localization or prediction section is read, those facts are `unavailable`, and copy rows carry proof `unavailable`. Control and unknown-legacy classifications do not depend on the fence. A settled tmdb retirement is removed from the alias set before conflict evaluation; an unsettled claim on a scheme no section reads (for example a slug) does not fail identity. `retired` and `unverified` describe external requests and are not produced for `film:` ids.
- **Aliases (G1):** the survivor's trusted, non-conflicting, non-retired `tmdb` and `letterboxd` claims; storage ids are `tmdb_<n>` and each lid. A `tmdb_tv`-only Film has no stable alias.
- **Metadata:** presence and usability are separate axes. A stored non-null value is `present` whatever its type, with `usable` and a diagnostic (`malformed`, `wrong_type`, `empty`, `not_positive`) under the ADR 0218 decision 4 rules; a null is `unknown` (`null_unproved`). `film_metadata_field` (ADR 0214 PV1) is not live, so no field is ever proved `absent`. Confidence is `unattributed`; no provenance record is trusted to raise it. Freshness is `unknown`.
- **Localization:** the existing `resolveLocalization` over `owner_review_entry` (the Film and its redirect ancestors), the applied reviewed row and the source rows; the stored provisional row is a legacy candidate of its own source, exactly as at runtime.
- **Fingerprint and prediction:** read under authorized storage ids only. The reader does **not** read the ratings link index, so candidate coverage is `incomplete` (`ratings_evidence_not_read`) and nothing is ever proved absent or `none`. A known conflict between storage ids stays `conflict`. Compatibility is `incompatible` only for a pointer bound to another fingerprint hash or an invalidated fingerprint; otherwise `unknown` (the ADR-0035 registry and the profile rule are not read).
- The marker generations of Film/Person, prediction and owner review are read before and after each page; a move refuses the page. The result also returns them as `pins` (numbers, not labels), the tokens a later writer must assert inside its own batch to keep a classification from outliving the state it judged.

## Running it on an offline copy

```bash
node scripts/film-dimension-parity.mjs --d1-sqlite /absolute/private/copy.sqlite
```

Options: `--page N` (1 to 200, default 100), `--max-films N` (stop after N Films; the report says `truncated`), `--detail` (adds every classified row with ids and values to stdout; keep that output private and out of GitHub, Trello and logs). Without `--detail` the report holds counts only.

The copy is whatever the owner already holds. This page does not authorize making a new production export, and a report describes that copy only, never live production.

## Cost (measurement, not a threshold)

Measured on the SQLite stand-in with one row per dimension per Film, 25 November 2026: a page of 1 Film read 24 statements and 194 rows; 100 Films, 36 statements and 1 382 rows; 200 Films, 48 statements and 2 582 rows; zero rows written in every case. About 180 of the rows are the fixed table inventory and marker reads. Statements grow with the number of 80-id chunks per page, not with the number of Films. Rows returned are a lower bound of D1 `rows_read`.

## Not done here

No live census, no retirement run (the stage-6 code is dormant: [retirement runbook](film-dimension-retirement.md)), no projection reconciliation (stage 4), and no readiness predicates (stage 5, [AIR-665](https://trello.com/c/EgOYnLRE)). The import change of stage 2 is delivered separately ([AIR-661](https://trello.com/c/1Rv634jd); [D1 schema contract](../reference/data/d1-schema.md)): it keeps every `control` and `unknown_legacy` row this reader reports and every `stale_copy` metadata, fingerprint and prediction row, so a parity run before and after an offline import sees the same classes for them.
