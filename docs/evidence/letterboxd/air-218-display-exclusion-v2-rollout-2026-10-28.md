# Finds display-only title exclusion v2: rebuild, preflight and production placement

**Captured:** 2026-10-27 to 2026-10-28, owner's machine and production Worker `iptv`. The list was built with the builder from `main` after [AIR-217](https://trello.com/c/oMmKr9FV) (`c0927bc`). The preflight ran a bundle built from `main` `da71772`.  
**Inputs:**
- Owner's Letterboxd export of 2026-10-26 13:48 UTC.
- The committed [AIR-173](https://trello.com/c/w2bVRb72) baseline plan.
- The snapshot that plan was made from.
- A fresh `consistent_fenced` R2 snapshot: finished 2026-10-28 00:16:29 UTC, 8,533 objects, `--verify` passed. The first attempt was NO-GO `source_changed`, because the prediction queue changed during the export; the rerun resumed it.

**Scope:** the owner approved each step separately:
1. Offline list build.
2. Read-only snapshot and offline preflight.
3. Private owner review of the films the new list hides beyond the old one.
4. Placement:
   - one read-only GET of the object in place, kept as a private rollback copy;
   - upload of the new list by the owner;
   - one read-only GET of the uploaded object.
5. One read-only `GET /api/catalog/available` through the owner's Access session in the built-in browser.

No switch was changed, no Worker write was made, and no Letterboxd or TMDB request was sent.

**Verdict:** the relaxed guards of [ADR-0033](../../adr/0033-finds-exclusion-namesake-relaxation.md) work as specified on real data.
- They hide 10 more films than the strict list, 2 of them strong Finds.
- The owner had watched all 10, so there is no false hide.
- No film hidden by the strict list is shown again.

**Used by:** [AIR-218](https://trello.com/c/lmToHh5p). Design: [ADR-0033](../../adr/0033-finds-exclusion-namesake-relaxation.md). Procedure: [runbook](../../runbooks/finds-display-exclusion.md). Previous rollout: [AIR-198 evidence](air-198-finds-exclusion-rollout-2026-10-27.md).

Aggregates only. Film titles, export codes, the list and per-film results stay in a private directory outside the repository. The list hash is not recorded here, in line with ADR-0028.

## List build

| Count | Strict list (AIR-198) | v2 list |
| --- | --- | --- |
| Watched or rated export films | 2,160 | 2,160 |
| With an accepted identity (left out) | 120 | 120 |
| Dropped: no year / no name | 0 / 0 | 0 / 0 |
| Dropped: name carried twice in the export | 57 | 1 |
| Kept export namesakes (years apart, ADR-0033) | – | 56 |
| Entries | 1,983 (78,702 bytes) | 2,039 (80,735 bytes) |
| `rule` tag | `strict_original_exact_year` | `strict_original_exact_year_v2` |

The builder reproduced the baseline plan from its snapshot, and the source hashes in the list equal those of the plan and the archive. Every entry of the strict list is also in the v2 list. The Worker's list validator accepts the v2 list.

## Preflight

The preflight ran the production bundle's route on the snapshot at its capture time, with an in-memory bucket that refused writes. All three runs answered 200 and made no write.

| Measure | Switch off | Strict list | v2 list |
| --- | --- | --- | --- |
| `displayExclusion` | `off` | `applied`, 476 | `applied`, 486 |
| Eligible films | 1,613 | 1,137 | 1,127 |
| Strong Finds (≥ 4.0, P(4.0+) ≥ 0.70, confidence not low) | 173 | 31 | 29 |

The 10 films the v2 list hides beyond the strict list:

| Cause | Films | Strong |
| --- | --- | --- |
| Export namesake kept because the years are apart | 6 | – |
| Alias-only catalog namesake ignored because its year is at least 2 away | 4 | – |
| Total | 10 | 2 |

The v2 list shows no film again that the strict list hides. The top five strong Finds are the same under both lists. The owner reviewed all 10 films privately and had watched each of them.

Five films that were strong Finds in the AIR-198 rehearsal are absent from both runs. In production they now carry `watched: true`, which fits the owner's «Смотрел» marks under [AIR-215](https://trello.com/c/MC9Ku87Z), so they are hidden by identity. The current code run on the AIR-198 snapshot reproduces the rehearsal.

**Year drift:** every one of the 420 accepted identities has the same year in the export and in TMDB. The matcher accepts an identity only when the years differ by at most one, so this sample cannot show a drift of two or more years. Residual risks B and C of ADR-0033 therefore remain unmeasured.

## Placement and production

| Step | Result |
| --- | --- |
| Object in place before the upload | The strict list, byte-identical to the AIR-198 file (78,702 bytes, uploaded 2026-10-27 20:22 UTC). It is kept privately as the rollback copy |
| Upload by the owner | 2026-10-28 05:16:50 UTC, Cloudflare dashboard |
| Read of the uploaded object | 80,735 bytes; size and SHA-256 equal the local v2 file |
| `FINDS_TITLE_EXCLUSION` | Not changed; `on` since AIR-198 |

The production read was made between 05:17 and 05:22 UTC:

| Measure | Preflight (v2, snapshot 00:16 UTC) | Production GET (about 05:20 UTC) |
| --- | --- | --- |
| `displayExclusion` | `applied`, 486 | `applied`, 486 |
| Eligible films | 1,127 | 1,118 |
| Strong Finds | 29 | 29 |
| Both newly hidden strong Finds absent | yes | yes |
| `watchedMarkEnabled` | – | `true` |

The excluded count matches exactly. The nine fewer eligible films follow from the availability window moving by about five hours. The pinned generation was not recorded in this read.

## Not yet measured

- The owner's visual acceptance of Finds after the placement.
- Residual risks B and C of ADR-0033: a namesake whose export year and TMDB year differ by two or more.

## Rollback

| Goal | Action |
| --- | --- |
| Back to the strict guard | Upload the kept strict list as `letterboxd/display-exclusion.json` |
| Show every film again | Set `FINDS_TITLE_EXCLUSION` to anything other than `on` |
| Hide nothing, switch left on | Delete the object; the rule becomes `unavailable` |

No other data was written.
