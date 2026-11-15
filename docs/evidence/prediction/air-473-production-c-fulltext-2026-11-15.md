# AIR-473: three-repeat research experiment and production C prompt activation

**Capture:** 15 November 2026, Europe/Madrid. **Owner approval:** [AIR-473](https://trello.com/c/b9oTfOpI). **Authority:** live ChatGPT Scheduled Task registry is executable authority; the versioned prompt is a reviewed snapshot, not a mechanism for updating the Task.

## Question and method

Does an additional per-film audit (B), or an audit plus explicit full-text-first/fallback explanation (C), improve research-depth compared with the existing production research rules (A)? Nine isolated one-shot offline Tasks used the same private five-film input, original Taste Profile v2 and schema. Each variant was run three times with its exact saved prompt unchanged between repeats. Scheduled starts were approximate and on repeat 2 actual B finished before actual A started; use actual run timestamps. No saved actual ratings or previously discovered Controller sources were provided to the experiments. Each Task report is self-reported; there are no raw externally verifiable replay traces of every search/open.

## Reported observations

| Variant | Films with original full-text review across repeats | General concrete execution dimensions per repeat (of 65) | Read-only final schema-valid per repeat | Stable half-star ratings |
| --- | --- | --- | --- | --- |
| A, control | 5/5, 5/5, 5/5 reported | 35, 23, 44 | 1/5, 5/5, 5/5 | 15/15 |
| B, audit | 5/5, 3/5, 5/5 | 56, 34, 37 | 5/5, 5/5, 5/5 | 14/15 |
| C, audit and full-text fallback | 5/5, 5/5, 5/5 | 22, 34, 52 | 5/5, 5/5, 5/5, all first-pass | 14/15 |

The only C rating outlier was *Why Don't You Just Die!* (4.0/68% then 3.5/43%, 3.5/44% P4+). C's full-text audit ended NOT_NEEDED for all five films in every run, so the **final no-full-text fallback reason was never stress-tested**. B's second run recorded CAPTCHA and cache misses for two films, illustrating independent source availability as a confounder. Across A/B/C, third-run predicted ratings matched all five films exactly (with minor P4+ deviations). Claimed concrete execution coverage varies widely even within a variant; it is not independently validated knowledge.

## Owner-approved production change and verification

After reviewing the three repeats the owner chose C for production learning. The existing Task A ID `6af7a2d8369081918b79bb2892bac0fe` was updated **while disabled**, read back for prompt equality, then **enabled** by an explicit separate mutation and read back again. At verification, `is_enabled=true`, saved prompt 31,761 characters, SHA-256 `97e1c54f1eed3a3ba8e40f060b7d135081155fdedfaac19cf5d3d61f00a700ac`, hourly `:00` Europe/Madrid. Next scheduled trigger 15 November 2026 at 14:00 Madrid; **this was a nominal schedule, not execution evidence**. Previous prompt was 28,426 characters, SHA-256 `f65dee1f258eb71013425d4bbd7e573018245f5c2507f8f0c10064a59646388d`. `manifestSize=5`, `generationSize=1`, `submitBatchSize=5`, protocol, lease, Worker preflight/submit and D1/R2 authority were unchanged. No manual run, production model invocation, flag change or other Scheduled Task was made as part of the activation.

Task A's production prompt has been supplemented with (1) per actually processed film audit of real queries, opened/used original reviews, author-count-vs-URL distinction, F/P/S and a beyond-synopsis execution finding; (2) an explicit second targeted query and alternative already-found original URL attempt when the first does not yield genuine full text; and (3) an observed fallback reason and attempt list when full text remains unavailable. Diagnostics belong **only** in the Task's saved report, not Worker `assessment`, `fingerprint` or `prediction`. For early blocked/noop/already_running runs there are no fictitious audit rows.

## Limits and verdict

**GO for owner-authorized live observation, not quality acceptance.** The experiment shows no reproducible causal advantage for B or C over A in this small, source-rich cohort. C reliably reported full-text coverage and first-pass schema validity but also showed varying execution coverage and nonzero forecast variance. Search engine results, reading availability, token/model variability, and task scheduling were not controlled independently; retrospective source access cannot prove the actual text read inside a Scheduled Task. The Worker validates JSON/schema, not research accuracy.

**Next authorized step:** inspect naturally scheduled Task results and source-verifiable research/fallback records; preserve the owner gates. No scaling, automatic additional experiments, lease resets, manual start, cutover or assertion of production acceptance from this document.

Documentation impact: `docs/reference/scheduled-task-prompts/hourly-predictions-batch-v2.md`, `docs/reference/scheduled-tasks.md`, `docs/runbooks/prediction-operations.md`, `docs/architecture/scheduling-and-orchestration.md`, `docs/evidence/prediction/README.md`, this report.
Architecture impact: none; only Task-internal research decision and reporting added, no orchestration flow changed.
