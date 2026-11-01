# ADR 0076: Mutable prediction state is owned by D1 only after its own marker is switched

**Status:** Proposed  
**Original decision date:** 2026-11-01  
**Recorded at:** 2026-11-01  
**Approval source:** Owner GO to implement the domain ([AIR-317](https://trello.com/c/jj45y0JW)). Acceptance of this record, and visual approval of the changed diagrams, are still owner gates. Applying migration `0007`, importing rows, switching the marker, and any other production write are not authorized by that GO.  
**Related work:** [AIR-317](https://trello.com/c/jj45y0JW), [ADR 0073](0073-metadata-cache-d1-authority.md), [ADR 0064](0064-prediction-queue-conditional-writes.md), [ADR 0051](0051-d1-domain-r2-blobs.md), [ADR 0015](0015-queued-prediction-recovery.md)  
**Supersedes:** [ADR 0064](0064-prediction-queue-conditional-writes.md) for the queue fence only while `prediction_domain_authority.mode` is `d1`: the compare-and-swap is the D1 generation, and the object etag is the mirror. [ADR 0002](0002-cloudflare-worker-r2-authority.md) for mutable prediction state only, in that same mode. Immutable fingerprint bodies, prediction version objects and profile version objects stay in R2. The rest of each record stands.  
**Superseded by:** None

## Context

The prediction runner reads and writes a set of R2 objects: the active taste profile, each film's current fingerprint and prediction bundle, the queue (hot and cold work, retries), the runner lease and the writer lease, and the run checkpoint. Immutable bodies already live beside them: `fingerprints/<hash>.json`, `predictions/versions/<sha256>.json` and `profile/versions/<n>.json`. The Worker is the only writer. The hourly ChatGPT Scheduled Task calls the same start, next, submit, heartbeat and complete protocol. That schedule and prompt are not part of this decision.

Schema v1 already has `profile_version`, `fingerprint_payload`, `prediction_current` and `prediction_history`. Those tables are the offline import. Their film id is `film:<lid>`, they have no queue, lease or run, and a foreign key would drop an off-watchlist id and a redirect id that the runner still stores. They are not a runtime marker.

Production schema is v6. The metadata cache marker is `d1`. `D1_ENRICHMENT_WRITE=on`. The cron is `37 * * * *`. A code deploy must not apply a migration, start a prediction run, or add a Worker flag. There is no transaction that covers D1 and R2 together.

## Decision

1. **One domain, keyed as the R2 objects key it.** Migration `0007_prediction_authority.sql` adds the marker, a fence row, and tables for the active profile, the fingerprint pointer, the current prediction, its lineage, the queue document, the runner and writer leases, and run checkpoints. `film_id` is the id in the R2 key. It is not a foreign key and the write does not insert a `film` row. An off-watchlist id and a redirect id stay as stored. The queue, the leases and the run checkpoint are the mutable documents. The profile, fingerprint and prediction rows are pointers. The immutable bodies stay in R2.
2. **One marker, default `r2`.** `prediction_domain_authority` is a single row. `mode` is `r2` or `d1`. The migration inserts `r2` with `generation`, `queue_generation` and `profile_generation` at 0. `prediction_domain_cas` makes a batch fail when the compare-and-swap matches nothing. It is not a switch and not a Worker flag. Applying `0007` does not copy a profile, a fingerprint, a prediction, a queue, a lease or a run, and it does not set `d1`. A contract that is not version 7, including a missing D1 binding, does not query these tables. A version 7 database whose tables are missing, or whose marker is missing or has a mode other than `r2` or `d1`, fails the prediction read or write and does not use the R2 object.
3. **`r2` on version 7 claims the generation before the object put.** A mutable save advances `generation` only when `mode` is still `r2` and the generation is the one just read, and only then puts the object. If that compare-and-swap matches nothing, the put does not run. The queue, the leases, the profile pointer, the fingerprint pointer, the prediction bundle and the run checkpoint all take that claim. The immutable body write is unchanged and stays create-only.
4. **`d1` reads and writes the tables, and does not fall back.** A read of a mutable key returns the row. An empty table is an empty value. A failed read, a payload that is not JSON, or an immutable body that is missing or whose canonical SHA-256 does not match the pointer fails the read. The mirror object is not the fallback. The view index keeps ratings and the other fields it already holds. On a `d1` read its prediction, fingerprint, fingerprint hash and impact facet are replaced from the tables, and a film with no row does not keep those fields from the object. Writes are one fenced batch. The batch advances `generation`, and the queue or profile generation when that document is the one being saved, only when `mode` is `d1` and the generation is the one the step read. The immutable body is written and verified before the pointer moves. If the fence matches nothing, the batch rolls back and the pointer does not move. The mirror put runs after the batch. A crash between them leaves the mirror behind. The next read still uses D1.
5. **The same runner protocol.** Hot before cold, retry growth, the 15-minute runner lease, the writer lease, heartbeat, lost response and `prediction_retry_heal_pending` stay. In `d1` the lease compare-and-swap is the row token. A queue conflict is still five attempts and then `prediction_queue_conflict`. The queue document is at most 900000 characters. One film keeps at most 80 history rows. A larger write fails and changes nothing. The hourly task, its prompt and its schedule do not change. There is no new flag and no new cron.
6. **The projector keeps its job.** On schema v7 it still writes Films, Persons and sync clocks, and it still reads the metadata cache when that marker is `d1`. It does not write the prediction domain. Version 7 without the prediction tables, or without a valid marker, fails that run before a write. Version 6 stays valid when those tables are absent, and its status object does not gain the prediction fields.
7. **Activation is explicit.** `scripts/prediction-domain-authority.mjs` prints status unless asked to write. `--load` with `--confirm load` copies a local snapshot into the tables and leaves `mode` at `r2`. It runs only while every generation is still 0, so an `r2` save that has already claimed a generation makes the load fail. `--activate` with `--confirm activate` sets `d1` only when the generations still match the load. `--revert` with `--confirm r2` sets `r2` again when the generations still match, and it does not delete rows. The script refuses a database path that names production and does not call the network. Running it against production is not authorized by this record. The schema v1 prediction tables are not this load.

Not decided here: applying `0007` to production, importing the live objects, setting the marker to `d1`, reverting it, and any change to the hourly task, the projector flag, or the cron.

## Alternatives considered

- **Reuse `prediction_current` and the other schema v1 tables.** Rejected. They are the offline import, the film id is a different shape, and they cannot hold the queue, the leases or the run.
- **A new Worker flag.** Rejected. The owner asked for one durable marker. A flag would be a second switch.
- **Fall back to the R2 object when D1 fails in `d1` mode.** Rejected. The mirror can be the stale copy the failure just created. The step fails instead.
- **Move only the queue.** Rejected. The profile, the pointers, the leases and the run would still be a second owner of the same domain.

## Consequences

- Until `0007` is applied, production behavior is the schema v6 runner on R2. After it is applied, and while the marker stays `r2`, readers and writers still use the objects. A mutable save on that database advances `generation` before the put and does not write the domain rows. `/api/d1/status` reports `schemaVersion` 7 with `predictionMode` `r2` once the new tables are present, and it still reports the cache fields. Version 6's success object does not gain the prediction fields. The status query reports version 7 without the new tables as `schema: false`. A projection run on that database fails before a write.
- A prediction commit does not write `film`, `film_person_credit` or `film_dimension`. An id with no Film row stays an id.
- Pages that still read the mirror can lag by one failed put. Freshness, the queue and the diagnostics that go through the Worker read the tables in `d1` mode.
- The backfill executor still requires schema version 4. A database at version 5, 6 or 7 stops before a reload write.
- A missing D1 binding is not version 7 and keeps the unconditional object put. Version 7 with a missing table or a missing or invalid marker fails the step and does not read the object.

## Recovery and migration boundary

Code rollback does not drop the tables, does not return the contract version, and does not change the marker. A Worker that only reads the objects, running while the marker is `d1`, would decide from a mirror that may lag. Returning the marker to `r2` is `--revert` with `--confirm r2`, or the equivalent fenced update, and is its own approval. A revert does not delete rows. Unsetting `D1_ENRICHMENT_WRITE` stops the projector, not the runner. Restoring the database is a Time Travel of the whole database and is its own approval. This record does not authorize applying `0007`, importing, activating, reverting, a flag change, a cron change, a task change, or any production R2 or D1 write.

## Evidence

- **Original decision:** [AIR-317](https://trello.com/c/jj45y0JW)
- **Implementation:** this record's pull request
- **Dated verification:** [local contract check, 2026-11-01](../evidence/d1-migration/air-317-prediction-domain-contract-2026-11-01.md). No production migration, import or marker change.
- **Uncertainty:** the history cap and the queue character cap are the contract. This delivery does not remeasure the live queue or the longest history.

## Follow-ups

Applying migration `0007`, the fenced import, and the marker activation are separate owner approvals. None is implied by accepting this record. After a later activation, the next natural scheduled run is the observation that the live queue, profile and pointers follow D1. That observation is not this record.
