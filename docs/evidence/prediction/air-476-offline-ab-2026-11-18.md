# AIR-476: offline model A/B of the evidence-aware scoring candidate

**Capture:** 17–18 November 2026, generator calls 23:51:45–00:00:16 UTC. **Card:** [AIR-476](https://trello.com/c/Z4ZP49RG). **Authorization:** owner GO of 18 November 2026 (Trello comment) for 24 isolated offline model calls on the synthetic fixtures only. **Status: executed; independent adjudication pending.** No Scheduled Task, IPTV MCP, Worker, D1/R2, profile or production prediction was read or changed. The candidate is not installed, and neither the candidate text nor the canonical snapshot was changed because of these results.

## Question

On the four blind synthetic cases of [the candidate kit](air-476-evidence-aware-scoring-candidate-2026-11-17.md), does the candidate step 6а remove false `unknown → negative` scoring (cases s2 and s1) without automatic optimism, keep the justified negative (s4), avoid invented minuses (s3), and keep provenance honest?

## Method

| Item | Value |
| --- | --- |
| Base text | installed prompt, SHA-256 `1192b92c…` (canonical snapshot) |
| Candidate text | SHA-256 `1826af6f…` (candidate evidence report) |
| Harness | `scripts/prediction-scoring-ab-harness.mjs`, method fingerprint `7647d808b063bdafe18ef87b533534ac22c4b911f8d05aca755d64d60561aa96`, seed 476 |
| Design | 4 cases × 2 variants × 3 replicates = 24 calls, one fresh context each, order shuffled by the seed (not grouped by case or variant) |
| Generator | an isolated Claude Code subagent per call; every call reported model `claude-opus-5-5`; effort is the subagent default (not configurable or reported per call) |
| Isolation | the subagent was told to make exactly one tool call, reading its own prompt file outside the repository, and to answer with JSON only. Each transcript was checked: **24/24 made exactly one tool call (that Read) and nothing else.** |
| Inputs | generator prompt = adapter preamble + verbatim steps 3а, 3б, 4, 5, 6 of the base (candidate: + its verbatim 6а) + output contract + the synthetic profile + one film's metadata, legacy fingerprint (s2) and closed research corpus |
| Grading | `scripts/prediction-scoring-rubric.mjs` on each parsed answer |

**Adapter, not literal prompt parity.** The production prompt drives the IPTV MCP batch protocol and web search, which an offline run must not touch. Steps 1–3, 3в, 3г and 7–11 (orchestration, audit, reporting) are left out of **both** variants; the closed corpus stands in for the two allowed searches. `tests/prediction-scoring-ab-harness.mjs` proves that each candidate prompt minus its step 6а equals the base prompt of the same case byte for byte, that replicates get identical prompts, and that no prompt contains rubric labels, expectations, another case's corpus or a historical outcome.

**Blindness.** The generator never received `grader-rubric.json`, a case label, a target, a historical prediction, an owner rating or a real fingerprint. The rubric was fixed before the calls and was not changed afterwards.

## Results (aggregates)

Per case and variant, three replicates: predicted rating, P(4+), confidence, number of `against` taste signals, number of high risks.

| Case | Variant | Rating | P(4+) | Confidence | Against | High risks | Grader fail | Heuristic flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1 partial evidence, heist | base | 4 / 4 / 4 | 0.55 / 0.58 / 0.55 | medium, medium, low | 0 / 0 / 0 | 0 | 0 | `unknown_claimed_as_fact` 3 |
| s1 | candidate | 4 / 4 / 4 | 0.55 / 0.60 / 0.55 | low, medium, low | 0 / 0 / 0 | 0 | 0 | `unknown_claimed_as_fact` 1 |
| s2 sparse legacy horror, snippet only | base | 3 / 3 / 3 | 0.20 / 0.20 / 0.20 | low ×3 | 1 / 1 / 1 | 0 | 0 | `unknown_claimed_as_fact` 3, `low_extreme_has_negative` 3 |
| s2 | candidate | 3.5 / 3.5 / 3.5 | 0.30 / 0.35 / 0.35 | low ×3 | 0 / 0 / 0 | 0 | 0 | `unknown_claimed_as_fact` 2 |
| s3 substantive positive evidence | base | 4 / 4 / 4 | 0.62 / 0.66 / 0.65 | medium ×3 | 1 / 1 / 1 | 0 | 0 | `no_unknown_to_negative` 1 |
| s3 | candidate | 4.5 / 4.5 / 4.5 | 0.72 / 0.75 / 0.75 | medium ×3 | 0 / 0 / 0 | 0 | 0 | `high_extreme_has_positive` 3 |
| s4 researched horror, confirmed defects | base | 2 / 2 / 2 | 0.03 / 0.04 / 0.03 | medium ×3 | 4 / 4 / 4 | 2 / 2 / 2 | 0 | `low_extreme_has_negative` 3 |
| s4 | candidate | 2 / 2 / 2 | 0.04 / 0.04 / 0.05 | medium ×3 | 4 / 4 / 4 | 2 / 3 / 3 | 0 | `low_extreme_has_negative` 3 |

Every one of the 24 outputs also carries the mandatory `grounding_review` flag. **No output failed a mechanical check**: all web sources were in the closed corpus at or below the corpus access, research status was consistent, every readable corpus was cited as read, s2 never claimed a read and sent no fingerprint, and s2/s1 never reported high confidence.

## Observations (executor, not adjudicated)

- **s2 (the motivating case).** Base: in all three replicates the search snippet ("noisy creature feature", 2/5) became an `against` signal, and the risks described unconfirmed defects as likely ("characters may make stupid decisions", "weak ending"), giving 3.0 / P(4+) 0.20. Candidate: the snippet was explicitly kept as "not a fact", there was no `against` signal, risks were labelled "не подтверждено", and the score moved to 3.5 / 0.30–0.35 with confidence still low. This is the intended effect of rule 1 of step 6а. Whether 3.5 is the right level, or an automatic raise, is a judgment for the reviewer: the candidate's `ratingBasis` grounds it on the siege premise only and states that no execution plus is confirmed.
- **s1.** Ratings identical (4.0). The candidate wrote unknown payoff/ending as uncertainty more consistently (one heuristic flag against three); the base twice framed the unknown ending as a risk ("weak or contrived ending could undercut").
- **s3.** Base kept 4.0 with one `against` signal on the "deliberate" second act in every replicate, although the read review says it is "never empty". The candidate gave 4.5 / ~0.75 with no `against` signal and named confirmed pluses (fair-play clues, counter-plan, earned reveal). This is a **+0.5 shift on a positive case**. It follows step 6а's self-check (a named confirmed plus) but must be checked against the "no automatic optimism" criterion by the reviewer.
- **s4.** The justified negative was kept in full by both variants: 2.0 / P(4+) ≤0.05 with four grounded `against` signals. The candidate did not soften it.
- **Variance.** Ratings were identical within each case-variant cell; P(4+) moved by at most 0.05. Three replicates cannot measure rarer deviations.

**Executor reading:** the direction of change matches the card's criteria on s2 and s1, s4 is unchanged, and provenance stayed honest. The two +0.5 shifts (s2, s3) are the open question. The heuristic flags have visible false positives (for example a plain premise sentence matched `unknown_claimed_as_fact`), so flag counts are pointers, not scores. **The final verdict belongs to the independent reviewer; until then the result is unadjudicated, not PASS.**

## Limits

- **Different generator from production.** The installed Tasks run in ChatGPT; this A/B used Claude Opus 5.5 subagents, because no other model endpoint is available in the executor's environment. The comparison is between prompt variants on one model, not a prediction of ChatGPT behaviour.
- Subagents may receive the repository's agent instructions as ambient context; that context is identical for both variants and contains no rubric content.
- Adapter, not the literal production prompt; the closed corpus replaces live search, so research depth and latency were not measured.
- Synthetic films and a synthetic profile; four cases × three replicates. No ground truth: nothing here measures accuracy, MAE or the cause of the 14 November drop.
- Effort level is the subagent default and was not reported per call.

## Artifacts

Raw outputs are **not** in this repository, by owner instruction. The executor keeps them in the session's private working directory and handed the bundle to the owner for the independent reviewer: `manifest.json` (run order, prompt SHA-256 per run), `prompts/` (24 exact generator prompts), `raw/` (24 answers with model id, timestamps and tool calls), `graded.json` (per-check verdicts). Bundle files: `manifest.json` SHA-256 `4c59f70fa50958ef83d33dd1d1d54c7a126ebc7c63759715d25f7316ce78d19e`, `graded.json` SHA-256 `c0dcdb194198ecb0aa9a99b50b9ace8acaaea73bebd8a83ffd588ba8e70948ff`. Reproduce the prompts with `node scripts/prediction-scoring-ab-harness.mjs build <dir>` and the grading with `… grade <dir>`.

## Next

1. Independent reviewer (did not take part in generation) adjudicates every `grounding_review` claim against `generator-inputs.json`, with special attention to the s2 and s3 +0.5 shifts.
2. Product Owner decides on the candidate text. Installing it on the four Tasks remains a separate operation-specific GO.

Documentation impact: this report, `docs/evidence/prediction/README.md`, `docs/evidence/prediction/air-476-evidence-aware-scoring-candidate-2026-11-17.md` (link to this run).
Architecture impact: none; offline experiment tooling only.
