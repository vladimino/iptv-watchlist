# AIR-559: owner-approved apply of the one-record legacy inferred pair repair

Date: **24 November 2026, 05:39 UTC** (06:39 Madrid). Scope: **one** L3 production write, approved by the owner. Tool: `scripts/letterboxd-inferred-pair-repair.mjs` at `main` `fa9607cdac8ca56c870fa112b933c7b12a76ed51`, delivered by [PR #963](https://github.com/vladimino/iptv-watchlist/pull/963) and deployed by [post-merge run 45332851390](https://github.com/vladimino/iptv-watchlist/actions/runs/45332851390), with all four jobs successful. The operational contract is in the [claim backfill runbook](../../runbooks/letterboxd-claim-backfill.md#one-record-repair-of-the-legacy-inferred-pair-air-559).

**Verdict: `applied`, with every readback check passing. The independent read-only dry run afterwards answers `already_marked`.** The legacy unmarked inferred pair detected by the [audit of 23 November 2026](air-559-legacy-inferred-pair-audit-2026-11-23.md) is now refused by the claim planner (`not_proved` / `ratings_link_inferred`). No producer activation, backfill or other write was made.

## Authorization

The owner approved option 1, the one-record RatingsD1 fenced compare-and-swap repair, on 24 November 2026 ([AIR-559 handoff](https://trello.com/c/733sRAxu#comment-6b04cb87d544eeb1353fe16b)). After the fresh post-deploy dry runs at 05:26 and 05:34 UTC, posted on the card, the owner gave the GO for **one apply under form (b)**:
- the three content pins are fixed by the owner: `recordEtag`, `linksEtag` and `planDigest`;
- the ratings generation is taken from a dry run made immediately before the apply, and only if the three content pins are byte-identical.

The run was a single process: a dry run, the pin comparison, then one apply. Request id: `AIR559_20261124_inferred_pair_01`. No retry was possible or made.

## The run (sanitized)

| Step | Time (UTC) | Result |
| --- | --- | --- |
| Dry run immediately before | 05:39:06 | `eligible`, generation **4370**, 0 existing entries, planner `pass` / `proved`; all three content pins identical to the approved ones |
| Apply, one `putOwned` batch | 05:39:15 | `outcome: applied`, `writes: 1`, tracked `writeState: committed`, exit 0 |
| Independent dry run afterwards | 05:39:30 | `already_marked` / `pair_entry`, generation **4371**, planner `not_proved` / `ratings_link_inferred` |

| Pin | Value |
| --- | --- |
| `generation` (from the 05:39:06 dry run) | `4370` |
| `recordEtag` (approved) | `cdb1ec29302377062416e385cf25646dd734f9b88b5ac5a8aa8c4edc7b004133` |
| `linksEtag` (approved) | `5bec4fb18804c2dd3aabfe0dc1818518a261e2311bac7527cd43376995ba6cc2` |
| `planDigest` (approved) | `ff3a89185064bec21730a4080839addf5f7590c2096471192502735b53de2498` |

The guards asserted inside the one atomic batch, together with the record-etag compare-and-swap and the marker fences:
- the ratings generation 4370;
- the link-index etag;
- the `film_rated_admission` row with this lid, movie and archive;
- no canonical `letterboxd` claim of the lid.

## Readback

Every check of the apply's built-in readback was `true`:

| Check | Result |
| --- | --- |
| `recordEqualsPlan` (stored etag = `planDigest`) | true |
| `otherFieldsUnchanged` (every record field except `inferredPairs`) | true |
| `entryAdded` (exactly one entry naming this pair with the archive as `sourceRef`) | true |
| `generationPlusOne` (4370 to 4371) | true |
| `linksUnchanged` | true |
| `viewUnchanged` (the two `ratings_view` rows) | true |
| `lidClaimsZero` | true |
| `plannerRefuses` (`not_proved` / `ratings_link_inferred`) | true |

The independent read-only checks afterwards, by plain `SELECT` statements:
- ratings `d1`/`open` at generation 4371, and Film/Person `d1`/`open` at generation 2;
- `letterboxd` claims: 415 in total, 9 of them `ratings_alias_bridge`, unchanged from the audit;
- `film_rated_admission` rows: 714, unchanged.

## Limits and what remains

- The marker is append-only. A code rollback does not remove it, and removing it would be a separate, case-specific owner decision.
- This repair closes only the one legacy pair the audit detected, under the audit's stated limits. It is not a historical replay of the deleted import receipts.
- `LETTERBOXD_CLAIM_ACTIVATED` stays `false`. Producer activation and any further backfill need their own plan and owner GO.
- The private pair and the private run outputs stay outside the repository.
