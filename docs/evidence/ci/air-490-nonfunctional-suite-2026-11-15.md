# AIR-490: core suite and nightly non-functional suite (15 Nov 2026)

**Captured:** 2026-11-15 UTC. **Method:** every `tests/*.mjs` file was classified by the check it asserts, then the registry `scripts/test-classification.mjs` was checked by `node tests/test-classification.mjs` and the runner contract by `node tests/run-tests-runner.mjs`. No Worker, R2, D1, Cloudflare or production call. The nightly GitHub workflow cannot be dispatched until its file is on the default branch, so this record does not claim a GitHub run of `.github/workflows/nonfunctional-tests.yml`.

**Decision:** delivery is blocked by functional correctness and safety. A wall-clock, percentile or throughput threshold on a GitHub-hosted runner is not a merge or deploy gate. The 240-second-per-shard review gate of 13 Nov 2026 is superseded for that purpose. The trigger was post-merge run 43708962610: `Date.now()-at<8000` in `tests/film-person-reader.mjs` failed Deploy after the pull-request CI of #646 had passed.

## How a check is classified

Core: result, contract, integrity, CAS/fence/replay, boundedness, call or SQL counts, timeout semantics, or a resource hard cap a safe deploy needs. Non-functional: real wall-clock, latency, p95, throughput, CPU or heap profile, benchmark, large stress experiment, or mutation testing (whether the functional tests kill a one-rule mutant). A file name that contains budget, memory or mutation is not the criterion. A bound that multiplies a count by a fixed latency model stays in core. Milliseconds that are only logged stay in core.

A file that holds both is split. `nonFunctional(id, fn)` in `tests/suite-gate.mjs` runs `fn` only when the runner sets `IPTV_TEST_SUITE=non-functional`. The core path still runs the functional assertions, including the workload those assertions need. The nightly run repeats the functional assertions of a split file and also runs the gated checks. Wholly core files and wholly non-functional files are disjoint. Split files are the only overlap. Support libraries and the historical fixture files are registered and are not executed.

## Inventory (438 files)

| Suite | Files | What runs |
| --- | ---: | --- |
| core | 391 | `npm test` and the three required CI shards (`--suite core`) |
| split | 7 | both suites; eight checks inside `nonFunctional` run only at night |
| non-functional | 32 | `npm run test:nonfunctional` and the daily workflow |
| support | 2 | not executed; imported by a runnable file |
| fixture | 6 | the historical `FIXTURE_DEPENDENT` exclusions, unchanged |

The union of the core plan and the non-functional plan is every runnable file. A new `tests/*.mjs` file fails `tests/test-classification.mjs` until it is named. That test also refuses a known wall-clock assertion (`Date.now()-`, `performance.now()`, `hrtime`, `p95<`) on a core line, and it requires each gated marker to sit inside its callback and nowhere else.

## Non-functional files

All 32 are mutant-kill checks. Each asserts that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. The functional twin stays in core. `canonical-person-mutation-producer.mjs` is core; `canonical-person-mutation-producer-mutation.mjs` is non-functional.

`canonical-catalog-reader-mutation.mjs`, `canonical-catalog-titles-mutation.mjs`, `canonical-dictionary-producer-mutation.mjs`, `canonical-differential-mutation.mjs`, `canonical-discovery-admission-producer-mutation.mjs`, `canonical-epg-person-producer-mutation.mjs`, `canonical-epg-producer-mutation.mjs`, `canonical-film-external-ids-producer-mutation.mjs`, `canonical-film-writers-mutation.mjs`, `canonical-person-mutation-producer-mutation.mjs`, `canonical-person-state-mutation.mjs`, `canonical-producer-adapters-mutation.mjs`, `canonical-producer-driver-mutation.mjs`, `canonical-producer-driver-mutation-b.mjs`, `canonical-producer-run-mutation.mjs`, `canonical-producer-schema-mutation.mjs`, `canonical-producer-store-mutation.mjs`, `canonical-receipted-writers-mutation.mjs`, `canonical-receipts-mutation.mjs`, `epg-producer-dry-run-mutation.mjs`, `epg-producer-m2b-mutation.mjs`, `epg-producer-m2b-reader-mutation.mjs`, `film-person-0019-preflight-mutation.mjs`, `film-person-0020-preflight-mutation.mjs`, `film-person-capture-mutation.mjs`, `film-person-connector-mutation.mjs`, `film-person-cutover-minimum-mutation.mjs`, `film-person-cutover-record-mutation.mjs`, `film-person-e6-measure-mutation.mjs`, `film-person-h1-verify-mutation.mjs`, `film-person-prepared-loader-mutation.mjs`, `projector-marker-fence-mutation.mjs`.

Support, not executed: `canonical-producer-driver-mutation-lib.mjs` (imported by the two driver part files) and `suite-gate.mjs`.

## Split checks moved out of the required shards

| Scenario | File | Marker | Left in core |
| --- | --- | --- | --- |
| `film-person-reader-completed-slots-index` | `film-person-reader.mjs` | `Date.now()-at<8000` | the lifecycle contract, including the 2500-film hot result |
| `catalog-d1-identity-read-latency` | `catalog-d1.mjs` | `elapsed<5000` | the route contract; the twenty identity reads run only at night |
| `prediction-batch-submit-wall` | `prediction-batch-submit.mjs` | `ms<15000` | settlement, the byte cap and `trips<1500` |
| `prediction-batch-validate-p95` | `prediction-batch-validate.mjs` | `p95<100` | verdicts and `req<57344`; one validity call stays in core |
| `prediction-step-timing-overhead` | `prediction-step-timing.mjs` | `timed-base<0.25` | the logical-clock timer contract |
| `footer-resilience-silent-source` | `footer-resilience.mjs` | `took<3000` | status 200, degraded names |
| `footer-resilience-hung-freshness` | `footer-resilience.mjs` | `Date.now()-started<3000` | status 200 and the unknown state |
| `discovery-chunk-budget-concurrent-walk` | `discovery-chunk-budget.mjs` | `concurrentMs<sequentialMs*0.7` | same-key reads, fences and the injected `preChunkMs` gap |

A real hang still fails the core file at the 300000 ms per-file timeout, and the job timeout still fails the job. The footer semantic timeout (`FOOTER_SOURCE_TIMEOUT_MS`) stays asserted by status and degraded names.

## Load checks kept in core, and why

- `discovery-admission-packed.mjs`: the 8,312-film write stays. `newTrips*350<60000` caps round trips at a fixed 350 ms model. `localMs` is only logged.
- `discovery-chunk-memory.mjs`: the chunk must release inputs and keep the same decisions.
- `discovery-seal-throughput.mjs`: the production-sized seal asserts round-trip and statement caps plus crash, fence and replay. `standinWallMs` is only logged.
- `discovery-status-memory.mjs`: operational status must not follow ledger size in statement count.
- `epg-commit-memory.mjs`: the commit must fold a large ledger without holding it.
- `epg-path-a-feasibility.mjs`: the tiny-scale replay must be exact and must refuse bad paths. `heapUsed>0` only proves a sample was recorded.
- `epg-r2-known-length.mjs`: known-length publish asserts sizes, counts and the type error. Timings are only logged.
- `film-person-e6-measure.mjs`: percentile arithmetic and stop rules of the measurement kit. No runner-latency assertion.
- `prediction-batch-profile.mjs`: storage-call counts and byte sizes.
- `prediction-overlay-index.mjs`: query counts and field parity. Wall time is only logged.
- `prediction-queue-budget.mjs`: the encoded queue must fit the character cap.
- `prediction-queue-discovery-independence.mjs`: one settlement per film and a bound on whole-catalog reads.
- `projector-bulk-spike.mjs`: a conflict is refused and the fallback writes the same rows.
- `sqlite-session.mjs`: `LARGE_ANSWER` selects quote mode so large values stay correct.
- `throughput.mjs`: queue admission, idempotency and failure boundaries. The name is not a rate assertion.

Other `*-lib.mjs` files stay in core because executing them asserts something the core suite needs, or a core test imports them. They are not the mutation library above.

## How to run

- `npm test` — core, the same set the three required jobs shard with `--suite core`.
- `npm run test:nonfunctional` — the 32 mutant-kill files plus the seven split files, with the gated checks enabled.
- `npm run test:all` — core, then the non-functional suite. It cannot be combined with `--shard`.
- `.github/workflows/nonfunctional-tests.yml` — daily at 04:00 UTC (05:00 Europe/Madrid while the offset is UTC+1, 06:00 while it is UTC+2) and `workflow_dispatch`. One job, 90 minutes, artifact `nonfunctional-test-report` kept 14 days. No secrets, no Cloudflare environment, no deploy, and not a `needs` of `Deploy to Cloudflare`.

A red nightly is a regression signal. It is not a pass, and it is not a branch-protection required check. A functional failure in a required job still fails that job and blocks deploy.

## Local core timings (not a CI result)

Same commands the three required jobs run, on this machine: 4 CPUs, so the runner's default is 6 jobs, Node.js 22.23.4. GitHub Actions uses Node.js 20 on `ubuntu-latest`. These walls are a health figure. They are not the GitHub `Run tests` durations and they do not gate merge or deploy.

| Run | Files | Wall | Summed file time | Slowest file |
| --- | ---: | ---: | ---: | --- |
| `npm test` (core, unsharded) | 398 | 95.6 s | 485.9 s | `generation-stage.mjs` 26.6 s |
| `--shard 1/3 --suite core` | 119 | 23.4 s | 123.6 s | `generation-stage.mjs` 23.4 s |
| `--shard 2/3 --suite core` | 138 | 35.7 s | 179.5 s | `generation-stage-withheld.mjs` 12.8 s |
| `--shard 3/3 --suite core` | 141 | 33.1 s | 170.0 s | `epg-diagnostic-run.mjs` 9.4 s |

Planned weight of those shards is 334.5, 414.5 and 414.5 (the first shard starts 80 units ahead). All three shard runs passed, and `npm run build` passed after the unsharded run. The non-functional plan is 39 files and weight 836.5; it was not timed here.

## What this record does not prove

It does not prove a green or red run of the nightly workflow on GitHub. `workflow_dispatch` applies only after the workflow file is on the default branch. It does not claim the GitHub `Run tests` duration of any shard: the table above is local. A functional failure in a required job still fails that job.
