# AIR-476: repeat offline model A/B, base vs candidate v2

**Capture:** 18 November 2026, generator calls 07:01:06–07:02:02 UTC. **Card:** [AIR-476](https://trello.com/c/Z4ZP49RG). **Authorization:** owner GO of 18 November 2026 (narrow `matchSignals` fix and one repeat A/B of at most 24 generations) and the independent technical preflight GO on PR #741 exact HEAD `1a9ea317…` ([review 5952057011](https://github.com/vladimino/iptv-watchlist/pull/741#pullrequestreview-5952057011)). **Status: executed and independently adjudicated: semantic PASS** for the narrow synthetic objective (evidence-aware scoring and positive-only `matchSignals`), [review 5952349269](https://github.com/vladimino/iptv-watchlist/pull/741#pullrequestreview-5952349269) on HEAD `abb46358…`, covering all 24 raw outputs. This is not a claim of accuracy, MAE, rollout approval or ChatGPT parity. No Scheduled Task, IPTV MCP, Worker, D1/R2, profile or production prediction was read or changed. Neither candidate nor the canonical snapshot was changed because of these results. The [first A/B](air-476-offline-ab-2026-11-18.md) stays an unchanged historical record.

## Question

Does [candidate v2](air-476-evidence-aware-scoring-candidate-v2-2026-11-18.md) keep the v1 gains (s2 snippet not turned into a negative, s4 justified negative kept, honest provenance) and also keep `prediction.matchSignals` positive-only, with no confirmed defect, refuted aspect or unconfirmed execution claim presented as a taste match?

## Method

| Item | Value |
| --- | --- |
| Base | installed prompt, SHA-256 `1192b92c…` (byte-identical scoring steps to the first A/B's base arm) |
| Candidate | v2, SHA-256 `ccfd5c1cbeb43cfe5b6fba0b173f880d31237eeb04e9dde6d2552e1f000da520` |
| Harness | `scripts/prediction-scoring-ab-harness.mjs` default (v2), seed 4762, method fingerprint `e6731f1397c624ea6cbd5291421973f526b0e1f6a9cd9459314444be25f52024` |
| Design | 4 synthetic cases × 2 arms × 3 replicates = 24 calls, fresh context each, seeded shuffled order |
| Generator | isolated Claude Code subagent per call; every call reported `claude-opus-5-5`; effort is the subagent default (not configurable or reported per call); same settings in both arms and as in the first A/B |
| Isolation | each subagent made exactly one tool call (reading its own prompt file outside the repository). **Executor-verified:** the executor parsed all 24 full subagent transcripts in its own session and found exactly one tool call (the `Read` of that run's prompt) in each. The private bundle carries only the exported `agentTranscript` ID, `toolUses` and `tools` per run, not the full transcripts, so the independent reviewer verified the exported metadata and every raw answer, which is not the same as re-reading the transcripts. |
| Inputs | unchanged `generator-inputs.json`; no rubric, owner rating, historical prediction or earlier raw output in any generator context |
| Grading | `scripts/prediction-scoring-rubric.mjs`, including the new `match_signals_shape` and `match_signal_suspect` checks |

The adapter is the same as in the first A/B (adapter parity, not literal production prompt parity).

## Results (aggregates)

Three replicates per cell. MS = number of `prediction.matchSignals`.

| Case | Arm | Rating | P(4+) | Confidence | Against | High risks | MS | Mechanical fails | Heuristic flags (excluding `grounding_review`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1 partial evidence | base | 4 / 4 / 4 | 0.55 ×3 | medium, low, low | 0 | 0 | 3 / 3 / 3 | 0 | `unknown_claimed_as_fact` 3, `no_unknown_to_negative` 1 |
| s1 | v2 | 4 / 4 / 4 | 0.60 / 0.55 / 0.60 | medium, low, medium | 0 | 0 | 3 / 3 / 3 | 0 | `unknown_claimed_as_fact` 1 |
| s2 sparse, snippet only | base | 3 / 3 / 3 | 0.20 / 0.20 / 0.15 | low ×3 | 1 / 1 / 1 | 0 | 3 / 3 / 3 | 0 | `match_signal_suspect` 2, `unknown_claimed_as_fact` 3, `low_extreme_has_negative` 3, `no_unknown_to_negative` 1 |
| s2 | v2 | 3.5 / 3.5 / 3.5 | 0.35 ×3 | low ×3 | 0 | 0 | 1 / 1 / 1 | 0 | none |
| s3 substantive positive | base | 4 / 4.5 / 4 | 0.64 / 0.75 / 0.64 | medium ×3 | 0 / 1 / 0 | 0 | 3 / 3 / 3 | 0 | `match_signal_suspect` 2 (false positives, below), `high_extreme_has_positive` 1 |
| s3 | v2 | 4.5 / 4.5 / 4.5 | 0.78 / 0.78 / 0.75 | medium ×3 | 0 | 0 | 3 / 3 / 3 | 0 | `high_extreme_has_positive` 3, `match_signal_suspect` 1 (false positive) |
| s4 confirmed defects | base | 2 / 2 / 2 | 0.04 / 0.03 / 0.03 | medium ×3 | 4 / 4 / 4 | 2 / 2 / 2 | 3 / 3 / 3 | 0 | `match_signal_suspect` 3, `low_extreme_has_negative` 3 |
| s4 | v2 | 2 / 2 / 2 | 0.04 / 0.05 / 0.05 | medium ×3 | 4 / 4 / 4 | 3 / 3 / 3 | **0 / 0 / 0** | 0 | `low_extreme_has_negative` 3 |

All 24 outputs carry the mandatory `grounding_review` flag, which now lists the match signals as well. **No output failed a mechanical check**: provenance stayed within the closed corpus at or below its access, research status was consistent, readable corpora were cited, s2 claimed no read and sent no fingerprint, and every `matchSignals` was an array of at most three strings.

## `matchSignals` (executor reading, not adjudicated)

- **s4.** v2 returned an empty list in all three replicates. The confirmed defects stayed in `mainRisk`, four `against` signals and high risks, and the premise appears only as a `supports` taste signal labelled "premise". The base arm repeated the adjudicated P2 in all three replicates, putting defects into `matchSignals`, for example "Ветераны-профессионалы игнорируют вентиляцию…" and "Финал решён неподготовленной спасательной командой за кадром".
- **s2.** v2 gave exactly one signal, labelled as premise ("premise: осада выживших в … башне (siege_survival)"). The base arm filled three, including unconfirmed execution or format claims such as "может дать понятные правила угрозы", "допускает плотный темп" and "снижает риск пустой медлительности".
- **s1 and s3.** Both arms kept three grounded positives taken from the read reviews: plan clarity, the investigator's counter-move and causal improvisation for s1; fair-play clues, the alibi as counter-plan and the earned reveal for s3. The positive-only rule did not strip real pluses.
- **Heuristic false positives.** The three s3 `match_signal_suspect` flags (two base, one v2) all come from the word "преступника" (culprit), which contains the defect stem "туп". They are correct positive signals, and the heuristic should not be read as counting defects.

## Other observations

- **s2.** v2 reproduced the v1 behaviour: no `against` signal from the snippet, risks labelled "не подтверждено", 3.5 / 0.35, low confidence. Base again turned the snippet into an `against` signal (3.0 / 0.15–0.20).
- **s4.** The justified negative is unchanged in both arms (2.0, P(4+) ≤0.05). v2 gave one more high risk per replicate (3 instead of 2), each naming a defect the reviews confirm.
- **s3.** v2 gave 4.5 in 3/3. Base gave 4.0, 4.5, 4.0 and had one `against` signal on the deliberate second act. Base therefore shows variance on this case, and the v2 lift is again +0.5 in two of three replicates. As in the first A/B, this is for the reviewer to judge against the "no automatic optimism" criterion.
- **s1.** No rating change. v2 kept the unknown payoff as uncertainty more consistently (one heuristic flag against three).

## Historical comparison (not a third arm)

These figures come from re-grading the first A/B's raw outputs with this PR's grader. They are a separate experiment with a different seed and are not mixed into the table above.

| Case | v1 candidate (first A/B) | v2 candidate (this run) |
| --- | --- | --- |
| s4 `matchSignals` | 3 per replicate, `match_signal_suspect` 3/3; the independent adjudication confirmed defects in r06/r23 and refuted "veterans/threat rules" claims in r19 | empty in 3/3, no suspect flag |
| s2 `matchSignals` | 3 per replicate, `match_signal_suspect` 3/3 | 1 premise-labelled signal in 3/3, no suspect flag |
| s1/s3 `matchSignals` | 3 grounded positives | 3 grounded positives |
| Ratings | s1 4.0; s2 3.5; s3 4.5; s4 2.0 | s1 4.0; s2 3.5; s3 4.5; s4 2.0 (identical) |

## Limits

- The generator was Claude Opus 5.5, not the ChatGPT model the installed Tasks run on. This compares prompt variants on one model and does not predict ChatGPT behaviour.
- The adapter is not the literal production prompt; the closed corpus replaces live search; effort is the subagent default.
- The fixtures are four synthetic cases × three replicates with no ground truth. Nothing here measures accuracy or MAE or proves the cause of the 14 November drop.
- `match_signal_suspect` and the other pattern checks are heuristics with known false positives (above) and can miss paraphrases. Semantic grounding is decided only by the independent review of the raw bundle.

## Artifacts

As agreed with the owner, the raw outputs are **not** in the repository; the owner receives a private bundle for the independent reviewer. It contains `manifest.json` (SHA-256 `1bec37158e047c0583fe6730f33be9cfceac1148f067c1aec98d2a860a052bca`), `prompts/` (24 exact prompts; their SHA-256 values are in the manifest), `raw/` (24 answers with model id, timestamps and tool calls) and `graded.json` (SHA-256 `0cc88c435d3781d53a30e1f853ee26fb398a9f2783e149a91570c1c2750c8379`). To reproduce the prompts, run `node scripts/prediction-scoring-ab-harness.mjs build <dir>`; to reproduce the grading, run `… grade <dir>`.

## Independent adjudication

The independent reviewer, who did not take part in generation, received the private bundle from the owner and checked:

- the archive, manifest and graded SHA-256 values;
- 24/24 prompt hashes and lengths, and arm symmetry;
- the absence of grader leakage;
- every per-run count against `graded.json`, with no discrepancy;
- provenance against the closed corpus;
- all 24 `grounding_review` items.

Verdict per case:

- **s1:** PASS.
- **s2:** PASS. The +0.5 is removal of unjustified negatives, not a proven accurate rating.
- **s3:** PASS. The +0.5 is defensible on the substantive reviews; it is not proof of real-world accuracy.
- **s4:** PASS. `matchSignals` is empty in 3/3, and every defect is kept in `against`, high risks and `mainRisk`.

The s3 `match_signal_suspect` flags are confirmed lexical false positives. No hidden P1/P2 scoring-policy regression was found. See [review 5952349269](https://github.com/vladimino/iptv-watchlist/pull/741#pullrequestreview-5952349269).

## Next

1. Exact final-head review and CI, then Controller merge.
2. Owner decision on candidate v2. Installing it on the four Tasks is a separate operation-specific GO.

Documentation impact: this report, `docs/evidence/prediction/README.md`.
Architecture impact: none; offline experiment evidence only.
