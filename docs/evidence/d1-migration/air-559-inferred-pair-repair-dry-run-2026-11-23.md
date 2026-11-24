# AIR-559: read-only dry run of the one-record legacy inferred pair repair

Date: **23 November 2026, 23:31 to 23:33 UTC** (24 November 2026, 00:31 to 00:33 Madrid). Scope: read-only.

Tool: `scripts/letterboxd-inferred-pair-repair.mjs` in its default dry-run mode, from the AIR-559 branch that adds it. The operational contract is in the [claim backfill runbook](../../runbooks/letterboxd-claim-backfill.md#one-record-repair-of-the-legacy-inferred-pair-air-559). The cohort is the single pair that the [read-only audit of 23 November 2026](air-559-legacy-inferred-pair-audit-2026-11-23.md) detected. Its lid, movie id and provenance archive were supplied from the audit's private output and do not appear here.

**Verdict: `eligible`. Nothing was written. This is not an apply and not a GO.** The owner's GO of 24 November 2026 ([AIR-559 handoff](https://trello.com/c/733sRAxu#comment-6b04cb87d544eeb1353fe16b)) covers the implementation and read-only dry runs only. The single apply needs a separate owner decision on the pins of a fresh dry run.

## Result (sanitized)

| Field | Value |
| --- | --- |
| `decision` | `eligible` |
| `sideEffects` | `none` |
| Ratings authority | `d1`/`open`, generation **4345** |
| Existing `inferredPairs` entries on the record | 0 |
| Planner verdict today | `pass` / `proved`: the exposure the repair closes |
| Pin `generation` | `4345` |
| Pin `recordEtag` | `cdb1ec29302377062416e385cf25646dd734f9b88b5ac5a8aa8c4edc7b004133` |
| Pin `linksEtag` | `5bec4fb18804c2dd3aabfe0dc1818518a261e2311bac7527cd43376995ba6cc2` |
| Pin `planDigest` | `ff3a89185064bec21730a4080839addf5f7590c2096471192502735b53de2498` |

The pins are SHA-256 digests of document text and the planned record; they identify no film.

`eligible` here means that every condition the script checks held:
- the record states exactly the pair, and the link index agrees and is unambiguous;
- the record is settled and stored in canonical JSON;
- the record has no `identity` and no entry for the pair, and its list is readable and not full;
- exactly one `film_rated_admission` row has this lid, movie and archive;
- the lid has no canonical `letterboxd` claim.

A separate read of the markers right after the dry run returned ratings `d1`/`open` at generation 4345 and Film/Person `d1`/`open` at generation 2, both unchanged.

## What an approved apply would change

| | |
| --- | --- |
| Changes | One `ratings_document` record rewritten, with one appended `inferredPairs` entry naming this pair and the archive; the ratings generation goes to 4346 |
| Unchanged | Facts, link index, `ratings_view` rows, admissions, Films and claims |
| Guards inside the one atomic batch | Generation 4345; link-index etag; the admission row; no lid claim; plus the existing record-etag compare-and-swap and marker fences |
| Readback after commit | Planner `not_proved` / `ratings_link_inferred`; the other readback checks of the runbook |

The pins go stale as soon as any ratings write moves the generation, which the Letterboxd Sync's natural runs do. A fresh dry run is therefore needed immediately before the GO and the apply.

## Limits

- One dry run against live production D1; no apply was attempted.
- The offline tests (`tests/letterboxd-inferred-pair-repair.mjs`) cover the apply, its guards and its outcomes on a sqlite stand-in, not production.
- The private cohort file stays outside the repository.
