# AIR-510: batch_start manifest and the Scheduled Task working context (16 Nov 2026)

**Status: offline code change. No production start, no Task edit.**

## What was measured

The live Task B report of 16 Nov 2026 (slot 15:15 Europe/Madrid, run `aae24063-679f-4fc9-9595-6abe8dcb21a1`) says `prediction_batch_start` with `manifestSize=5` created the owned run and the full film manifest did not fit the Task working context. The Worker answered HTTP 200 with `serverFault=null`. `maxManifestBytes` is 262,144 and was not the limit that fired.

On the Worker code, `enrichmentSchemaDocument()` serializes to 14,111 bytes. The card's read-only production profile block is about 13.5 KB. MCP `mcpPayload` sent that answer twice: once as `content[0].text` and once as `structuredContent` (the AIR-450 measurement put the JSON-RPC body at about 2.1 times the HTTP answer).

The installed prompt reads `manifest.profile.body`, `manifest.contract.schema.contract` and each film's `modelMetadata` and stored fingerprint. It does not read the profile-schema, prediction-schema or rules sections of the schema document.

## What changed

A successful `prediction_batch_start` MCP result is the JSON text only. `contract.schema` keeps `contract`, the fingerprint vocabulary and `schemaDigest` (SHA-256 of the full schema document). The manifest hash still hashes the full document. Film inputs and `profile.body` are not shortened. `queue_changed` now includes `cause`: `stale`, `revision` or `manifest`. The 16 Nov 15:14 Madrid Canary refusal (HTTP 409, no `runId`) matches this code path; the Task report does not say which cause it was.

## Not proven

Whether the next natural A/B slot holds five film inputs is not proven here. No Task was edited and no production `prediction_batch_start` was called.

## Reopen, 16 Nov 2026 22:50 Europe/Madrid

Read-only `enrichment_status` after the controller comment: Task C run `6e98e0fa-e4eb-408b-82de-dc289536b46f` start HTTP 200 then `prediction_complete` HTTP 200, `stopReason=external_termination`, `callerFault.failedStep=start`, `firstSubmitAt=null`, added 0. Task D run `cf083134-8093-4064-b4bb-98a4191f8391` `manifest_spent`, added 5, firstSubmitAt set. The controller recorded the same `manifestHash` and `manifestBytes` 42,115 for both. Removing the duplicate `structuredContent` copy was not enough when the client keeps only a prefix of the remaining JSON.

Follow-up change: serialize `films` then `profile` then `contract`; drop `moodVocabulary` and `moodMapping` from the copied `schema.fingerprint`. Offline tests: a prefix that ends at `"contract"` still contains every selected film id; a mid-object slice does not parse. Natural C/D slots after this deploy are the remaining acceptance. No Task edit and no production start in this change.
