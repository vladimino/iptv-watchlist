# Mutation checks cost less work: one section per mutant, schema built once (AIR-374)

Dated 2026-11-12 (UTC). Offline measurements on the repository only. **No production read or write, no Cloudflare setting and no network call was made.** Test infrastructure only: no Worker code, no mutant, no assertion and no section of any test was removed or weakened; every mutant is still applied and still has to be killed.

## Why

The three CI shards run the `*-mutation.mjs` files at the same time as the rest of the suite; on the 4 vCPU runner their time grows with the CPU they use. Nineteen files cost 498 s of CPU (user + system) alone on a quiet machine. Most of that was spent by a mutant running every section of its target test that comes before the section that kills it (a section builds its own databases and writes through the sqlite stand-in).

## What changed

- The numbered sections of the target test of seven mutation checks can be selected with an environment variable (`RECEIPTED_ONLY`, `DICT_ONLY`, `EPGPERSON_ONLY`, `ADAPTER_ONLY`, `EPGPRODUCER_ONLY`, `FENCE_ONLY`, `ACCEPTED_ONLY`; for the receipted-writers test also `RECEIPTED_UNIT`, one writer). Unset, every section runs exactly as before. A failing run prints `LEAN_SECTION <id>` on stderr.
- Each mutation check holds `HINTS`: the section of the target test that killed each mutant when the hints were learned (`<PREFIX>_LEARN=1` runs every mutant against the whole file and prints them). A mutant runs that section first and **a mutant that passes it is run against the whole file before it is called a survivor**, so a stale hint costs time and never hides a survivor. Before any mutant, the unmutated test (or module copy) must pass with every lean selection that is used, so a lean run cannot "kill" for a reason of its own. A hint that names no mutant, or a duplicate mutant name, fails the check.
- `tests/projector-marker-fence.mjs` built the migration chain again for each of its databases; it is built once per process and each database is a file copy, as in the other fixtures. Its own run takes 1.0 s instead of 2.0 s.
- `scripts/run-tests.mjs`: `WEIGHTS` of the seven files whose cost changed, scaled by the measured CPU ratio (not below the lightest listed file, 4, which the shard-balance assertion uses as its tolerance); `canonical-receipted-writers-mutation` had no entry and is now listed. Scaled from the recalibrated weights of the cohort-pressure scheduler: connector 66 to 42, epg-person 41 to 17 (16.4 by the ratio, rounded up so the cohort stays spread by count), dictionary 32 to 14, receipted-writers 31 to 6, fence 29 to 9, producer-adapters 26 to 11, epg-producer 16 to 11.
- Not changed: `film-person-capture-mutation`, `film-person-prepared-loader-mutation` and `canonical-receipts-mutation` (they already run one section per mutant), `film-person-e6-measure-mutation` (its sections share one fixture, and a mutant is killed after about 0.2 s of CPU, of which node start-up and the fixture are most), `film-person-cutover-record-mutation` (one shared run record), and the connector test's own mutants (one sequential lifecycle).

## Mutants killed, before and after

| Mutation check | Mutants killed / total, before | Mutants killed / total, after |
| --- | ---: | ---: |
| `canonical-receipted-writers-mutation` | 41 / 41 | 41 / 41 |
| `canonical-epg-person-producer-mutation` | 80 / 80 | 80 / 80 |
| `canonical-dictionary-producer-mutation` | 116 / 116 | 116 / 116 |
| `canonical-producer-adapters-mutation` | 57 / 57 | 57 / 57 |
| `canonical-epg-producer-mutation` | 52 / 52 | 52 / 52 |
| `projector-marker-fence-mutation` | 17 / 17 | 17 / 17 |
| `film-person-connector-mutation` (68 gate, 7 recorder, 48 connector) | 123 / 123 | 123 / 123 |

No run needed the whole-file fallback after the hints were learned.

## Time of one file alone

Node 22.23.4, 4 CPUs, `TMPDIR` on disk, other sessions running on the same machine, so only the ratios of rows measured together mean anything. Method: the file at `b7f860f` and the changed file alternate, three runs each, median of the three; CPU is user plus system of the whole process tree.

| File | Wall before / after (load 5 to 8) | Wall before / after (load 17 to 26) | CPU before / after |
| --- | ---: | ---: | ---: |
| `canonical-receipted-writers-mutation` | 23.5 s / 6.9 s | 78.9 s / 24.4 s | 56.3 s / 11.6 s |
| `canonical-epg-person-producer-mutation` | 17.0 s / 7.0 s | 58.8 s / 20.6 s | 39.8 s / 15.9 s |
| `canonical-dictionary-producer-mutation` | 16.6 s / 7.9 s | 41.3 s / 24.3 s | 38.9 s / 16.7 s |
| `canonical-producer-adapters-mutation` | 9.5 s / 4.1 s | 14.0 s / 7.4 s | 20.6 s / 8.8 s |
| `canonical-epg-producer-mutation` | 5.3 s / 3.8 s | 16.6 s / 12.9 s | 11.2 s / 7.9 s |
| `projector-marker-fence-mutation` | 14.0 s / 2.9 s | 39.4 s / 13.3 s | 16.1 s / 5.2 s |
| `film-person-connector-mutation` | not measured | 73.2 s / 56.7 s | 74.2 s / 47.2 s |

The wall columns move with the load of the machine; the CPU column is the cost the shards pay.

## Summed over the nineteen mutation files

CPU, one run of each file alone: the twelve files that were not changed (237 s, measured once on a quiet machine) plus the seven above. Before 498 s (261 s for the seven), after 351 s (113 s for the seven): 147 s of CPU less, 30 %.
