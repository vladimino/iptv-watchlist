# AIR-450: C3 failure reproduced offline and the derived source fields (12 Nov 2026)

**Status: offline measurement on the real Worker validator; no production read or write, no model call, no Scheduled Task.** It accompanies [ADR 0129](../../adr/0129-fingerprint-source-fields-derived-from-evidence.md). No film id, manifest, profile, fingerprint or prediction of the experiment appears here; the fixtures are synthetic.

## The failure of checkpoint C3

C3 (scheduled, generation size 10, the first ten films of one frozen manifest) made one dry-run submit of ten items and got ten `validation_failure`: five `fingerprint_schema` with `fingerprint.sourceRefs invalid_ref` and five `caller_reported parse_error`. The run reported the shape itself: `sourceBasis` `metadata` with an empty `sourceRefs`.

## Reproduction (synthetic fingerprint, the real `fingerprintIssues`)

| Evidence | Supplied by the caller | Issues |
| --- | --- | --- |
| metadata-only mechanic | `sourceBasis` `metadata`, `sourceRefs` `[]` | `fingerprint.sourceRefs invalid_ref` |
| metadata and model knowledge | `sourceBasis` `mixed`, `sourceRefs` `[]` | `fingerprint.sourceRefs invalid_ref` |
| metadata and model knowledge | `sourceBasis` `metadata`, correct refs | `fingerprint.sourceBasis invalid_enum` |
| metadata and model knowledge | `mixed`, correct refs | none |
| none (legacy) | `metadata`, `[]` | none |

The evidence was valid in every case; the failure is the two derived fields, a step the language model did by hand. The five `parse_error` are not explained by this.

## Behaviour after ADR 0129 (tested)

With a valid map and both fields omitted the Worker derives them, so the first two rows pass when omitted and are still rejected when supplied. `tests/fingerprint-source-derivation.mjs` checks: the C3 shape; walk order, de-duplication, the cap of 8 and `mixed`; that a supplied value is never rewritten and one omitted field is not derived; that eight kinds of invalid evidence derive nothing and are not reported as missing fields on top of their own issue; 300 seeded random maps against an independent reference of the documented rule (and the same maps with one claim corrupted derive nothing); and that `prediction_validate`, the v2 submit, its dry run and the v5 submit agree, with the stored body holding the derived fields and the omitted and spelled-out forms having the same content hash.

## Not established

Whether the model-side causes of the five `parse_error` are missing metadata, missing knowledge or the group size. The private result now carries `failureReason`, counted per size by the report, to tell them apart at the next owner-approved checkpoint (C4: the first group of ten, size 10, on the same frozen manifest). Nothing here shows that the derivation works inside the real ChatGPT Task: that is what C4 is for.
