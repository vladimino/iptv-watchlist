# Catalog Enrichment Producer runbook

Operational reference for the [Catalog Enrichment Producer](../reference/domain/catalog-enrichment.md). The producer is **dormant**: this page describes what an operator checks and does, and which steps are separate owner operations. It authorizes none of them. Present runtime state (schema version, control row, scopes, run and lease state, feature flags) is read live, never from this page: use the authorized read-only tools and `GET /api/admin/settings`.

## Operations and their gates

| Operation | Gate |
| --- | --- |
| Apply `migrations/0047_catalog_enrichment.sql` | Owner production operation with its own preflight and readback; follows the operation-key schema apply. A deploy never applies it |
| Activate the control and enable a scope | Owner production operation. Not reachable from the admin route |
| Pause, resume | Owner, through `POST /api/admin/settings/catalog-enrichment` |
| Retry a blocked or deferred part | Owner, through the same route, on the rows the owner saw |
| Deliver the reconcile cron expression (`CatalogEnrichmentRunner.CRON`) | Versioned configuration change under the activation operation; a deploy never adds it |
| Change the upstream coordination mode | Separate owner operation; the producer works at every mode (an absent table or an unreadable mode is `off`) |

## Preflight before any activation

1. The schema version is at least 47 and every table of the [schema section](../reference/data/d1-schema.md#catalog-enrichment-producer-schema-v47-dormant) exists. The producer refuses to run without them.
2. The operation-key schema (`canonical_write_receipt.operation_key`) is applied: every unit is keyed.
3. The Film/Person authority marker is open (`d1`): a closed marker defers every unit; the producer never falls back.
4. The control row is absent or `inactive`, and `enrichment_signal` holds no stale `staged` row.
5. The canonical credit reader can serve a Film with more credits than its current whole-read cap before any Film with more than 200 credits is written.

## Reading the state

- `GET /api/admin/settings`: the control, the newest run and its stop reason, whether a run is still draining after a pause, the pending signals, the due Films, the cooldowns and the Films that need attention.
- A run ends with one of `idle`, `parked` (with the earliest due time), `handover` (the statement budget; the next run continues at once), `paused`, `generation_moved`, `lease_held`, `yield` or `error_backoff`. `yield` means a progressing EPG publication (a loading or validated stage with a live publisher claim, or the EPG-held lease; the held cutover marker is not a hold) holds the writes at a write boundary: the run parks for a short re-check (15 seconds at the latest) and resumes when the publication ends. `error_backoff` means three Films failed on storage or an authority fence in one run; each failed Film is deferred durably with a short backoff, and the run parks by the 1, 5, 15 minute and hourly tiers.
- A part in `deferred_repair` is rechecked after 1, 6 and then every 24 hours and is set runnable again by a new code version, a source recovery or a changed response digest. It is never terminal.

## Pause

A pause raises the control generation. No request starts after it; a request already sent may complete, and **nothing it returns is written**: every write asserts the generation. The newest run reports `draining` until it writes its stop entry. A code revert stops future runs but does not cancel a running one: the pause is the stop control. Resume keeps all pending work and the cutoff.

## Owner retry

Use it for a Film in `identity_disagreement` after the claim is corrected or the page was a transient fault, for a part in `needs_attention` (a verified conflict or an ambiguous translation) after the owner decision, and to hasten a `deferred_repair` part. It writes no metadata. A part that lists `written_under_superseded_anchor` or is held as `superseded_credits` keeps its listed values: correct them through the existing owner routes before releasing the hold.

## Rollback

Written values are valid canonical data under fill-only and add-only and are corrected by the owner and review routes. A code rollback does not revert D1 data, the control row or the scope rows. The stop control is a pause; disabling a scope stops its work and holds its signals while its emitter keeps recording.
