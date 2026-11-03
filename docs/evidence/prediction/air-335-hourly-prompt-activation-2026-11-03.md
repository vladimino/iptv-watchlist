# AIR-335: live hourly prompt activation (3 November 2026)

**Outcome:** The owner-approved external Hourly Predictions Scheduled Task prompt was updated. This records an operational configuration change, **not** acceptance of evidence-bearing production fingerprints.

**Authorization:** On 3 November 2026 the owner instructed ChatGPT to proceed with the already proposed AIR-335 activation. The approved scope was the external prompt only, preserving fingerprint schema/prompt/prediction prompt version 1/1/1, `FINGERPRINT_TRANSITIONS=[]`, hourly scheduling, and Stage A discovery behavior. See [AIR-335 and its activation comment](https://trello.com/c/aK9UJ8fk#comment-6ae9a94fb46dd27ee81e9cbe) and [preparation PR #340](https://github.com/vladimino/iptv-watchlist/pull/340).

## Recorded live observations

The active task is `Automation_25293680bdb08191818ee2db30438f49`. Before the update, the saved prompt had 15,894 characters and no `fingerprint.evidence` instruction. The last recorded invocation was completed, with `no_update` status. At approximately **10:27 Europe/Madrid** a single Task prompt update succeeded. Readback near **10:28 Europe/Madrid** confirmed:

- Task remained `enabled=true`, hourly at minute `:20` in `Europe/Madrid`, with the prior schedule intact.
- The new prompt had **19,454 characters** and corrected the authority guidance: mutable prediction state is in D1; immutable fingerprint and prediction bodies remain in R2.
- Stage A discovery instructions were compared before the update and remained byte-identical.
- Stage B now requests dimension-level `fingerprint.evidence` on `fingerprint_and_prediction` only. `prediction_only` reuses the existing Worker fingerprint. Metadata is permitted for factual mechanics but is insufficient as the sole basis of execution-quality claims. Unsupported execution values become `unknown`; aggregate source basis and references are derived from the submitted items.
- `prediction_validate` receives the film's `modelMetadata` only when the evidence cites `metadata:*` tokens. The task does not run `assessPredictionConfidence` (AIR-336).
- No version constant, transition registry, task schedule, flag or Worker deployment changed as part of this action.

Before this switch a synthetic read-only connector test confirmed that `prediction_validate` with a factual `metadata:synopsis` citation is valid when the corresponding `metadata` object is supplied, and returns `invalid_ref` when it is omitted. Both calls reported `storage=not_accessed` and `sideEffects=none`. The post-update `probe_read` also returned `status=ok`, Cloudflare Access JWT verified, `storage=not_accessed`, `sideEffects=none`.

The read-only `prediction_queue_overview` was `drained` with 3,011/3,011 coverage, target `1/1/1` and `wouldRequeue=0`. Its last snapshot was refreshed **07:41 Europe/Madrid**, *before* the prompt edit. It is not evidence of a successful later natural prediction.

## Limits, rollout and recovery

**AIR-335 remains In Progress.** No new persisted fingerprint containing valid evidence was observed during this operation. The next eligible natural `fingerprint_and_prediction` must be verified against the immutable R2 body/hash/generation record, D1 mutable pointer, validation diagnostics and queue state. A drained queue is not an authorization for a manual run or backfill. AIR-336 remains blocked.

The owner knowingly accepted that old and new instruction generations use `FINGERPRINT_PROMPT_VERSION=1` to avoid global invalidation. Evidence presence and a new body hash can identify an evidenced body, but the prompt version cannot distinguish instruction revisions. No manual model run, retry, lease reset, migration, EPG/discovery write, production data edit or task pause was performed by the coordinator. Rollback of this external Task prompt is a separate action requiring owner authorization; a code rollback cannot revert it or stored immutable objects.
