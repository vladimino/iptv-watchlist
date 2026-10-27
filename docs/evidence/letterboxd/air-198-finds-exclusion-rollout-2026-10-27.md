# Finds display-only title exclusion: preflight and production rollout

**Captured:** 2026-10-27, owner's machine and production Worker `iptv`. Code is `main` `9089dc4` (implementation) and the bundle built from it for the preflight.  
**Inputs:**
- Owner's Letterboxd export of 2026-10-26 13:48 UTC.
- The committed [AIR-173](https://trello.com/c/w2bVRb72) baseline plan.
- The snapshot that plan was made from.
- A fresh `consistent_fenced` R2 snapshot (finished 2026-10-27 20:08:50 UTC, 8,492 objects, `--verify` passed; the first attempt was NO-GO `source_changed` because the prediction queue changed during the export).

**Scope:** each step was approved separately by the owner:
1. Offline list build.
2. Read-only snapshot and offline preflight.
3. Upload by the owner through the Cloudflare dashboard.
4. One read-only GET of the uploaded object.
5. Switch set by the owner.
6. One read-only GET of `GET /api/catalog/available` through the owner's Access session.

No Worker write, no Letterboxd or TMDB request.

**Verdict:** the switch works as specified, with no false hide found by the owner. The strict rule still leaves watched films at the top of Finds; the rule's limits are listed below.  
**Used by:** [AIR-198](https://trello.com/c/9xpmq2fc); design: [ADR-0028](../../adr/0028-finds-display-only-watched-exclusion.md); procedure: [runbook](../../runbooks/finds-display-exclusion.md).

Aggregates only. Film titles, export codes, the list and per-film results stay in a private directory outside the repository. The list hash is not recorded here, in line with ADR-0028.

## List build

| Count | Value |
| --- | --- |
| Watched or rated export films | 2,160 |
| With an accepted identity (left out) | 120 |
| Dropped: no year / no name | 0 / 0 |
| Dropped: name carried twice in the export | 57 |
| Entries | 1,983 (78,702 bytes) |

The builder reproduced the baseline plan from its snapshot. `source.baselinePlanSha256` equals the plan's hash, and `source.archiveSha256` equals the archive's. The matcher, parser and ZIP reader had not changed since the plan was made.

## Preflight and production

| Measure | Preflight (snapshot 20:08 UTC) | Production GET (20:30 UTC) |
| --- | --- | --- |
| Pinned generation | `b2699929…` | same |
| `displayExclusion` | `applied`, 474 | `applied`, 478 |
| Eligible films, switch off → on | 1,627 → 1,153 | – → 1,162 |
| Strong Finds (≥ 4.0, P(4.0+) ≥ 0.70, confidence not low), off → on | 190 → 49 | – → 49 |
| Owner-reported false Finds hidden | 4 of 5 | 4 of 5 |

The preflight ran the production bundle's route on the snapshot at the capture time, with an in-memory bucket that refused writes; it made no write. The small production differences follow from the 22 minutes the availability window moved. The owner reviewed the 141 hidden strong Finds privately and found none they had not seen.

The uploaded object was read once with the read-only R2 credential; its size and SHA-256 equal the local file.

## Limits seen on real data

After the switch, the owner had watched all five films shown in Finds. None of them was a false hide; each falls outside the strict rule by design:

| Cause | Films |
| --- | --- |
| Matched only through an alias, year differs by one (the known fifth example) | 1 |
| Export year differs from the TMDB year by one | 1 |
| The owner watched two films with the same name in different years, so the name was dropped as an export namesake | 2 |
| Entry present, but an unrelated catalog film carries the same title as an alias, so the catalog namesake guard blocked it | 1 |

Proposed follow-ups, owner-suggested and not yet scheduled:
- an owner "watched" mark on a Finds card, keyed by the catalog TMDB id;
- a superseding ADR that relaxes the export-namesake guard when years differ, and the alias-only catalog namesake guard.

## Rollback

Setting `FINDS_TITLE_EXCLUSION` to anything other than `on` shows every film again. Deleting `letterboxd/display-exclusion.json` makes the rule `unavailable`. No other data was written.
