# AIR-560: two-hour Predictions S10 trial, research-depth regression and S5 rollback

**Capture:** 20-21 November 2026, Europe/Madrid.  
**Work item:** [AIR-560](https://trello.com/c/NZ70Dzom), follow-up to [AIR-461](https://trello.com/c/a9TdXgNM).  
**Candidate delivery:** [PR #831](https://github.com/vladimino/iptv-watchlist/pull/831), merged as `196a4a4c8d081bf76e2c95c6188d400ae6aa8ba4`.  
**Outcome:** S10 increased committed throughput over the adjacent S5 period but materially reduced the proportion of predictions reporting a full-text research source. The previously authorized quality stop was applied. All four active Scheduled Task prompts were restored to exact canonical S5 with per-Task and final registry readbacks.

## Experimental boundary and source provenance

The only executable change was `manifestSize=5` to `manifestSize=10` at all three occurrences in the four existing Predictions v2 Tasks (`:00/:15/:30/:45`). `generationSize=1`, `submitBatchSize=5`, the research and evidence gates, five-minute heartbeat instruction, Worker protocol, lease TTL, schedules and enabled states were unchanged. The disabled `:48` Task was not modified.

Compare two adjacent, equal 120-minute local windows. Both windows include the same four hourly task schedules; actual Task starts vary because of scheduler drift.

| Cohort | Europe/Madrid | UTC | Intended manifest |
| --- | --- | --- | --- |
| S5 baseline | 20 Nov 20:38 to 22:38 | 20 Nov 19:38 to 21:38 | 5 |
| S10 trial | 20 Nov 22:38 to 21 Nov 00:38 | 20 Nov 21:38 to 23:38 | 10 |

**Read-only evidence:** `enrichment_status` recent run records and lease/terminal states; user-site [Events](https://iptv.vladimino.workers.dev/events) terminal packets with counts and per-film source-access projections; Scheduled Task registry for enabled state, schedule and exact installed prompt. The correlated observations and owner-approved rollback are recorded in the dated AIR-560 Trello comments. No manual model/Prediction runs, lease resets, retry changes, flags, Worker data mutations or new automations were used to collect this evidence.

The source-access categories are **caller-reported** and copied into an Events projection from stored assessments. They do **not** independently establish that an original authored review was actually read or that a substantive film-specific execution finding was established.

## Throughput and reliability

| Metric over 120 minutes | S5 | S10 | Difference |
| --- | ---: | ---: | ---: |
| Completed productive batches | 7 | 6 | -1 |
| Films selected and settled | 35 | 60 | +25 |
| Predictions committed | **33** | **53** | **+20 (+60.6%)** |
| Committed predictions / hour | **16.5** | **26.5** | **+10.0/h** |
| Per-film failures | 2 | 7 | +5 |
| Per-film failure share | 5.7% | 11.7% | +6.0 percentage points |
| Unproductive/contended scheduled slots | 1 | 2 | +1 |

The committed totals count created predictions in completed natural runs, not manifest selection, attempted work or a theoretical `4 × manifestSize` maximum. All six S10 productive batches had `manifest_spent` terminal outcomes. The seven S5 productive batches likewise completed normally. The S5 non-productive slot included a leased run with no submit that later expired; this is not identical to the two S10 `already_running` refusals.

The S10 run that began around 23:28 Madrid processed 10 films until 23:41, overlapping the `:45` Task that actually began at 23:40 because of scheduler drift. The two invocations are different Scheduled Tasks, not proof of a same-client retry. In a separate earlier S5 case, a start followed by an `already_running` response and no heartbeat/submit resembled the historical [AIR-468/AIR-486 investigation](air-486-repeat-start-after-471-2026-11-14.md), but caller correlation remains unresolved.

A seventh S10 batch, **excluded from the strict two-hour window** because it completed at 00:42 Madrid, committed another 9 of 10 selected films. Thus the extended natural observation covers **62 committed / 70 processed** across seven completed S10 batches. A subsequent start was in flight at the time of the read; do not treat it as a terminal outcome.

## Research source quality

The table counts one **highest reported web access level** per committed prediction. For a prediction without a reported web research source, metadata or model knowledge is classified as **no web source**.

| Best reported research access | S5 (33 committed) | S10 (53 committed) |
| --- | ---: | ---: |
| Full text | **14 (42.4%)** | **7 (13.2%)** |
| Partial article text | 9 (27.3%) | 18 (34.0%) |
| Search snippet only | 3 (9.1%) | 9 (17.0%) |
| No web source (metadata/model only) | 7 (21.2%) | 19 (35.8%) |
| **Any reported read article text, full or partial** | **23 (69.7%)** | **25 (47.2%)** |

The full-text share decreased by **29.2 percentage points**, from 42.4% to 13.2%. The share reporting any actually read article text fell **22.5 percentage points**, from 69.7% to 47.2%. No-web-source outputs grew from 21.2% to 35.8%, while per-film failures attributed by the caller to insufficient evidence increased from 2/35 to 7/60.

The extra S10 batch completed at 00:42 does not change the trend: 9 commitments, only 1 reporting full text, 4 search snippets and 4 no-web-source results. Across all seven completed S10 batches, reported full-text use was **8/62 (12.9%)**.

**What could not be audited independently:** The Saved Task report bodies were not available through the permitted automation read surface, although Task run metadata and actual execution times were. Therefore exact search queries, original-review URLs and authors, `gateStatus` (`substantive/limited/blocked`), `executionFinding` attribution, and full-text fallback audits cannot be verified. The caller's declared `full_text` is not proof that the author actually read a complete original review. The Event projection also cannot prove predictive accuracy; no hidden personal ratings or MAE/bias study was performed.

The film cohorts are not identical or randomized. The S10 failures included several older or obscure films, which may influence accessible research depth. Consequently this is **evidence of a substantial research-depth regression in the observed trial**, not a controlled causal estimate of the effect of `manifestSize` alone.

## Verdict and actual rollback

The owner's trial agreement allowed a prompt rollback if the one- and two-hour quality checks found deterioration, with no automatic timed rollback. The later owner request specifically asked for both throughput and research quality. The predeclared early stop condition included loss of substantive/full-text quality.

**Verdict:** S10 is a **throughput success** (+60.6% in committed films per hour over the adjacent baseline), but it does **not meet the requirement to retain research-first quality**. The threefold fall in reported full-text share, decline in any-read-text share, increased metadata-only output and higher insufficient-evidence failure rate justified reverting rather than continuing overnight. This is an early-stop diagnostic verdict, not a statistical A/B or a claim that no S10 configuration can ever preserve quality.

**Rollback actually verified on 21 November 2026 (Europe/Madrid):**

- Restored all four active Tasks `IPTV Predictions v2 00/15/30/45` to the exact executable S5 block in [the canonical prompt](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md): 45,922 JavaScript characters, 69,358 UTF-8 bytes, SHA-256 `54e0e7eeb6bb628ca00a6b6a195eaf984a9483443446cf5f206f0e91b30be860`.
- Per-Task post-update reads and final four-Task registry readback confirmed exact S5, `enabled=true` and original `:00/:15/:30/:45` Europe/Madrid schedules.
- `IPTV Predictions v2 48` remained `disabled` with exact S5 and its existing `:48` schedule.
- Editing stored Task prompts does not cancel an invocation already running on an S10 context. No `run_now`, manual Producer, lease reset, feature-flag, storage, schedule or other Task mutation was performed.

The [S10 candidate snapshot](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2-s10-candidate.md) remains in source control as **historical experiment evidence**, not an installed prompt. [AIR-461](https://trello.com/c/a9TdXgNM) remains open to investigate throughput improvements that preserve independent research. There is no automatic S10 rollout authorization from this report.
