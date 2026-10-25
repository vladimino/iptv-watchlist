# AIR-73 offline import of the 19 October 2026 archive

> Historical sample. See [evidence registry](../README.md) for context and later decisions. This text is not a current operational authorization.

[AIR-73](https://trello.com/c/gX2xdQAz) imported one verified historical snapshot into a local SQLite file. The snapshot directory, the database, and the raw report stay outside this repository. This note records the aggregate result. It does not authorize a production write. Live backfill remains [AIR-74](https://trello.com/c/5AdAmKPe), after [AIR-69](https://trello.com/c/FlcWZX7W).

The machine-readable counts are [air-73-offline-run.json](air-73-offline-run.json).

## Archive

The directory is the trial export described in [migration-export.md](../../archive/legacy-sites/migration-export.md). `node scripts/migration-export.mjs --output /absolute/private/snapshot-directory --verify` recomputed every object hash and the aggregate checksum locally. It does not contact the legacy Site when `--verify` is present.

| Field | Value |
| --- | --- |
| Manifest schema | 1 |
| Status | `provisional_no_change_detected` |
| `changes` | 0 |
| Listing pages | 66 |
| Started | 2026-10-19 01:31 (GMT+2) |
| Finished | 2026-10-19 02:32 (GMT+2) |
| Objects | 6,520 |
| Bytes | 97,759,255 |
| Aggregate SHA-256 | `8b21c82db0cf8580250f1d8c8ecd51f114eba437a48c3ec4d3b0ca41f1f39ca9` |

All seven importer families are present: watchlist, programme, discovery, profile, fingerprint, prediction, and actual. `complete` is true. `production` is false. The archive is not current production.

## How to repeat the import

Both paths must be absolute and outside this repository. The second command writes only the SQLite file it is given.

```bash
node scripts/migration-export.mjs --output /absolute/private/snapshot-directory --verify
node scripts/offline-import.mjs --snapshot /absolute/private/snapshot-directory --database /absolute/private/import.sqlite
```

Repeat the import command against the same database to check idempotency. Exit 0 is an honest report, including one that refuses full parity. A checksum or snapshot failure exits 1. A missing path, or a database path inside the repository, exits 2.

## Runs on 24 October 2026

The same private database was used for every run below. No new snapshot was taken.

| Run | Clock (GMT+2) | What happened |
| --- | --- | --- |
| First process | 2026-10-24 08:51–10:26 | Wrote 18,411 receipts, then stopped before the report |
| Continuation | 2026-10-24 09:31–09:39 | Applied the one remaining person and wrote the report |
| Repeat | 2026-10-24 09:39–09:46 | Applied nothing and resumed every receipt |
| Streaming reader | 2026-10-24 10:16–10:24 | Applied 0, resumed 18,412, same ledger and parity |

The first process stopped in the person-table read-back. `sqlite3 -json` for `person` is 1,387,031 bytes. `spawnSync` keeps only the first 1,048,576 bytes of a child's output and then fails. The importer replaced that failure with `Import stopped`, so the report file was empty. The rows already committed stayed in the database.

The continuation and the repeat used a local 64MB capture so the report could be written. That cap is not the fix: a larger table would pass 64MB and stop again. The repository reader now consumes the SQLite output as a stream and has no byte cap.

A clean database was not loaded again. The INSERT statements are unchanged; only the multi-row read was failing. The streaming run walks every unit and reads every parity table through that reader. It applied 0 rows, resumed all 18,412 receipts, and reproduced the conflict ledger, the unportable counts, and the parity result. That is the idempotency check for the reader change.

## Import counts

The continuation report is the first complete report. It resumed the 18,411 receipts from the interrupted process and applied 1 person.

| | Continuation | Repeat |
| --- | ---: | ---: |
| Applied | 1 | 0 |
| Resumed | 18,411 | 18,412 |
| Reconciled | 0 | 0 |
| Explained | 0 | 0 |
| Conflicts | 1,591 | 1,591 |
| Unportable | 45,586 | 45,586 |
| Partial | 0 | 0 |
| Uncheckpointed | 0 | 0 |
| Pending | 0 | 0 |

Receipts in the database after the continuation: 18,412. That is 15,874 people, 2,137 films, 399 fingerprints, 1 profile version, and 1 redirect. Prediction rows, actual ratings, and programme generations are 0.

## Coverage

The denominator is every manifest object: 6,520 = 3,987 mapped + 2,533 unmapped + 0 excluded.

Unmapped objects:

| Kind | Count |
| --- | ---: |
| `mood-facet.json` | 1,986 |
| Enrichment run files named by run id | 234 |
| Enrichment run files named by a timestamp and a run id | 95 |
| `view-index.json`, `prediction-queue.json`, `moods.json`, `baseline.json`, `rating-observations.json`, `latest-run.json` | 6 |
| `events/` | 179 |
| `started/` | 25 |
| `discovery-before-canonical.json`, `discovery-resolution-before-canonical.json`, `discovery-status.json`, `resolver-continuation.json` | 4 |
| Lease objects | 3 |
| One other root JSON object | 1 |

## Conflicts

All 1,591 conflicts are `reference_missing`: the fingerprint or rating insert named a Film id that is not a `film` primary key. The lifecycle reader emitted 2,137 films and the database stored 2,137. Nothing emitted was lost on the way into SQLite. The importer did not create the missing ids and did not rewrite one id into another.

Programme and watchlist list the same 399 films. Metadata has 419 records. Discovered films has 1,739 records. The reader emitted 1,738 `film:tmdb:…` ids and 399 other films, 2,137 in total, matching the stored rows. One discovered film was linked onto an existing film, which is the one redirect.

Fingerprints, 1,587 conflicts:

| Films | What the archive contains |
| ---: | --- |
| 1,575 | The discovered-film id is `tmdb_<number>` and the stored primary key is `film:tmdb:<number>`. The fingerprint object is addressed with the legacy spelling `film:tmdb_<number>`. The film is stored. The spellings differ, so the foreign key fails. |
| 1 | That discovered film was linked onto a film already in the catalogue. `film:tmdb:<number>` is the redirect source, and the TMDB identity is stored on the survivor. The fingerprint still uses `film:tmdb_<number>`. |
| 1 | `metadata.json` carries a Letterboxd slug whose TMDB id is already stored as `film:tmdb:<number>`. The reader did not emit the slug, and the fingerprint is keyed by the slug. |
| 10 | `metadata.json` carries the film, including a TMDB id, and that id is absent from programme, watchlist, and discovered films. The reader does not mint a Film from a metadata key alone, so no row exists for the fingerprint to reference. |

Actual ratings, 4 conflicts, all Letterboxd slugs present in metadata and absent from the three film lists:

| Ratings | Films | Relation |
| ---: | ---: | --- |
| 2 | 2 | The metadata TMDB id is already a stored `film:tmdb:<number>` row. One of these slugs is the fingerprint row in the table above. The other rating has no fingerprint conflict. |
| 2 | 2 | These are two of the ten metadata-only films, and each also has a fingerprint conflict. |

The 1,591 units are 1,588 distinct films: 1,576 discovered films stored under the canonical id or the redirect, 2 metadata slugs whose TMDB id is already stored, and 10 metadata-only films with no stored row.

## Unportable units

| Reason | Units | What it is |
| --- | ---: | --- |
| `prediction_version_object_missing` | 1,986 | Every `predictions.json` bundle. The current and history values do not each have their own `r2Key` and `contentSha256`, so none is stored. |
| `observation_fields_missing` | 43,599 | Discovery items. They have a key and titles, and they do not have the evidence key the repository requires. |
| `observation_fields_missing` | 1 | The programme generation. Discovery was not portable, so the generation was not published. |

## Parity

| | Value |
| --- | ---: |
| Denominator | 20,003 |
| Missing | 1,591 |
| Extra | 0 |
| Mismatched fields | 0 |
| Unprojected keys | 2,533 |
| Records mapped | 2,808 |
| Records unportable | 14,467 |
| `parity.ok` | false |
| `claimsFullParity` | false |

Missing rows are the same 1,587 fingerprints and 4 ratings as the conflict ledger. There is no field mismatch and no extra stored row.

`parity.ok` is false because those 1,591 expected rows are absent under the id the source object used. `claimsFullParity` is false for that reason and because the run also has unmapped keys, unprojected records, unportable units, and conflicts. A watchlist-and-programme success would not have been enough either: the claim requires every family, a nonempty denominator, and an empty open ledger.

## What this does not allow AIR-74 to assume

- The run did not write production R2, production D1, Worker config, feature flags, schedules, or prediction data.
- `claimsFullParity` is false. This archive is not a cutover baseline.
- Prediction bundles stay unportable until each version is its own immutable object.
- Discovery items and the programme generation were not imported.
- Ten films exist only as metadata records. Creating rows for them would invent Films the reader did not emit.
- Legacy `tmdb_<number>` fingerprint keys were not rewritten to `film:tmdb:<number>`.
- `mood-facet`, events, started markers, leases, and the other unmapped objects have no importer mapping.
- The snapshot status is provisional. It is the 19 October 2026 historical archive, not a fresh read of production.
