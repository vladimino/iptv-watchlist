# AIR-373: the connector tool treats the D1-derived inputs as read-only evidence (offline, 11 Nov 2026)

**Date:** 2026-11-11 (UTC). **Scope:** `runMeasurement` in `scripts/film-person-connector-run.mjs`. **Production access: none** (no R2, no D1, no Cloudflare API or connector, no IPTV MCP). Offline tests only.

## The defect

A diagnostic run on 11 Nov 2026 (the merged capture against a local copy of production D1 and live R2, outside this change) showed that `verifyDerived(manifest, derivedValues)` is `[]` right after `captureProjectorInputs` and `["derived_digest:publishedEpg"]` after `buildExpected`: the reviewed view build adds fields to the published EPG snapshot **in place** (the serialized programme grew from 2,227,875 to 2,228,466 characters and the watchlist from 1,366,450 to 1,366,895). In `runMeasurement` this meant (1) `run.derivedProblems`, computed after `runParity`, always held `derived_digest:publishedEpg` on production-shaped data, so `deriveEvidence` refused every real run, and (2) the tool's own `buildExpected` call ran on data already changed by the one inside `runParity`. The earlier synthetic tests did not show it because their snapshot had nothing for the view build to add.

## The change

- `pristine = structuredClone(cap.derivedValues)` immediately after the capture; `run.derivedProblems = verifyDerived(manifest, pristine)`.
- `runParity` and the tool's own `buildExpected` each get a fresh deep copy of `pristine`; the second one is checked against the manifest before use (`derived_inputs_not_pristine` otherwise).
- `run.derivedInputsMutatedByView` records whether `runParity`'s view build changed its copy. It is a note: it does not affect `verified`.
- `deriveEvidence` is unchanged and still fails closed on a non-empty or missing `derivedProblems` (`tests/film-person-cutover-run.mjs`, mutant `derived payloads verified`). `captureProjectorInputs`, `runParity`, `verifyDerived`, `buildExpected`, the gates, the recorder and the pinned constants are unchanged.

## Offline evidence

- `tests/film-person-connector.mjs`: the fixture now has one owner-reviewed localization on its Film. The test first proves with the merged `buildExpected` alone that the fixture's `publishedEpg` digest changes in place (`verifyDerived` goes from `[]` to `derived_digest:publishedEpg`); then `runMeasurement` end to end gives `ok:true`, `derivedProblems` empty and `derivedInputsMutatedByView:true`, and `seal` still passes, which compares the ledger digest of the tool's own class read with `runParity`'s. Wall time 2.2 s (2.4 s before the change).
- `tests/film-person-connector-mutation.mjs`: 3 new connector mutants (verify from the object `runParity` changed; one object for both view builds; the mutation note dropped), 48 connector mutants in all, plus 64 gate and 6 recorder mutants, every one killed, none broken. Wall time about 27 s alone, 60.1 s inside the full run.
- Full `npm test`: 320 of 320 files, wall 144.3 s (CI gate 180 s per shard; the file list runs in two shards there).

## Not proved

- Not run against production data or the real connector: the effect on a real copy is inferred from the 11 Nov diagnostic, not observed through this tool.
- The `derived_inputs_not_pristine` guard cannot fire with the current copy code, so no test kills its removal; it kills the shared-object mutant only together with the copy line.
- Authorizes no measuring run, baseline record or marker move.

Architecture impact: none - tool-internal copy of in-memory values; no runtime topology, data flow or trust boundary changes.
