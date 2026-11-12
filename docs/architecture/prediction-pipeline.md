# Prediction pipeline

The external ChatGPT caller performs model generation; the Worker manages the queue, profile and validation. Mutable prediction state is D1-authoritative after the schema v7 marker activation on 3 November 2026 ([ADR 0078](../adr/0078-d1-authoritative-prediction-domain.md)). This diagram reflects the [runner contract](../reference/api/prediction-runner.md), [Film lifecycle](../reference/domain/film-person.md) and [profile ADR](../adr/0013-versioned-taste-profile.md).

```mermaid
sequenceDiagram
    actor Client as ChatGPT runner
    participant MCP as Worker MCP tools
    participant Queue as Prediction queue and lease
    participant R2 as R2 objects
    participant D1 as D1 prediction marker
    Client->>MCP: Read schema, published profile, runner status
    MCP->>R2: Read the profile while the marker is not d1
    Note over MCP,D1: When the schema v7 marker is d1, the profile read is D1 and R2 is the verified body
    R2-->>MCP: Versioned profile data
    MCP-->>Client: Published profile version and hash
    Client->>MCP: prediction_start (queued)
    MCP->>Queue: Write the last run's unconfirmed retries, if any
    alt Retries cannot be written
        MCP-->>Client: blocked, prediction_retry_heal_pending (nothing selected, no lease)
    else Already running
        MCP->>Queue: Acquire or check lease
        Queue-->>MCP: already_running or busy
        MCP-->>Client: Run already active
    else New run
        MCP->>Queue: Acquire lease
        MCP->>R2: Persist interrupted state for the recovered lease and at most one diagnostic list page
        Note over MCP,D1: Settlement resumes from enrichment/run-diagnostics-settle.json. GET /api/enrichment/status, GET /api/enrichment/runs and MCP enrichment_status project an expired lease from the diagnostic row and the clock. They write nothing. Event delivery stays on GET /api/events until AIR-416.
        loop While eligible items remain
            Client->>MCP: prediction_next (one film)
            MCP->>Queue: Select hot first and cold only after hot drained
            Queue-->>MCP: Film and current artifact facts
            MCP-->>Client: One eligible film
            Client->>Client: Reuse valid fingerprint or generate new one
            Client->>Client: Predict using published taste profile
            Client->>MCP: prediction_submit (one result or item failure)
            alt Valid output, marker not d1
                MCP->>R2: Persist mutable fingerprint, prediction and queue
            else Valid output, schema v7 marker is d1
                MCP->>R2: Write and verify the immutable body
                MCP->>D1: Commit the pointer and the queue
                Note over MCP,D1: The written film leaves the stored queue, no catalog read
            else Isolated invalid output
                MCP->>Queue: Record per-film failure and retryAt (conditional write)
            end
            opt Long model call
                Client->>MCP: prediction_heartbeat
                MCP->>Queue: Renew lease
            end
        end
        Client->>MCP: prediction_complete when required
        MCP->>Queue: Record completion in a conditional write of the stored queue, release lease
    end
```

Migration `0007` is applied and the production prediction marker is `d1`. In the historical `r2` mode, the persist step writes the mutable objects in R2. The contract starts at schema version 7 when this domain is installed. A later contract with none of the prediction tables stays on the objects. A partial set of those tables fails the step and does not read the objects. After the marker is `d1` the same step writes the immutable body in R2, checks it, and commits the pointer and the queue in D1 ([ADR 0078](../adr/0078-d1-authoritative-prediction-domain.md)). The `d1` branch is now live; the `r2` branch remains the compatibility/rollback contract.

The fingerprint schema/hash tracks the film independently from a personal prediction, which also requires the current profile version/hash and prompt version. A profile change makes predictions stale without forcing a fingerprint regeneration; EPG showtimes do not invalidate either. The persist step writes the immutable content body and generation record first and then `fingerprint.json` as a pointer with provenance ([fingerprint compatibility](../reference/domain/fingerprint-compatibility.md#storage)); a declared fingerprint schema or prompt transition re-queues only the films it reaches, bounded within each batch, under the transition rule ([ADR-0035](../adr/0035-selective-fingerprint-transition-compatibility.md); no switch since [ADR 0047](../adr/0047-retire-fingerprint-compatibility-switch.md)), and a run ends when the Worker's versions change under it. One malformed film output is deferred with exponential backoff rather than discarding successes. This diagram is a conceptual view of the runner protocol, not an assertion that every branch occurs on each invocation.

The "Read schema" step and the "Isolated invalid output" branch share [one validation contract](../reference/api/enrichment.md#submit-validation-contract): the schema the client reads carries the exact rules the Worker validates with, and a rejected submit returns the violated field and code from that closed vocabulary alongside the per-film failure and `retryAt`. The Worker remains the only validator and the only writer; the client's preflight is a convenience that cannot admit a payload the Worker would reject.

**Run events.** The start and the systemic stop of a run each write a durable record and then the Events Log item. A delivery that failed or was interrupted is completed by the next authorized start, inside the writer lease, from the latest run's records and a small index of earlier failures; after eight failed attempts an entry is quarantined and shown in the status read. No read delivers an event ([events](../reference/domain/events.md#delivery-of-prediction-run-events), [AIR-416](https://trello.com/c/f7FX4Elk)). The diagram's start step is unchanged: the delivery is part of it.

## Batch runner v2 (Proposed)

**Accepted design; the start and submit steps are implemented, no caller exists.** [ADR 0122](../adr/0122-prediction-batch-runner-v2-dual-protocol.md) (Accepted) defines a second protocol beside the one above. It shares the queue, the runner lease, the retry records and the D1/R2 persistence; the diagram above is unchanged and stays the live protocol. Contract: [batch runner v2](../reference/api/prediction-runner.md#batch-runner-v2-proposed-contract).

```mermaid
sequenceDiagram
    actor Client as ChatGPT runner v2
    participant MCP as Worker MCP tools
    participant Queue as Prediction queue and lease
    participant Store as D1 pointers and R2 bodies
    Client->>MCP: prediction_batch_start
    MCP->>Queue: Read-only preflight: stored queue and its generation, hot first, up to 100 films, measure the whole answer
    alt A live runner lease exists (v5 or v2 run)
        MCP-->>Client: already_running, names the holder, no manifest, no queue write
    else No live lease
        alt Nothing eligible or capacity 0 on a current queue
            MCP-->>Client: noop or blocked quota, no lease, no run, no stop Event
        else Queue current and the answer is over the byte limit
            MCP-->>Client: manifest_too_large, zero writes, nothing shortened
        else Fits, or the queue needs a refresh
            opt Stale queue, or films already current or without admission
                MCP->>Queue: Refresh and settle, the named effects of batch_start
                MCP->>Queue: Second read-only preflight, the new baseline
                alt Still over the byte limit
                    MCP-->>Client: manifest_too_large, queue refresh is the only effect
                end
            end
            MCP->>Queue: Acquire the one runner lease
            MCP->>Queue: Revalidate queue generation, selection and the exact answer
            alt Changed, or over the limit with real values
                MCP->>Queue: Release the lease
                MCP-->>Client: queue_changed or manifest_too_large, acquire and release only
            else Unchanged
                MCP-->>Client: Manifest: profile, contract, films with metadata and plan, epoch
                loop Until the manifest is spent, at most 100 films
                    opt Model call may be long
                        Client->>MCP: prediction_heartbeat, before the call and at least every 10 minutes
                        MCP->>Queue: Renew lease, same ownership epoch
                        MCP-->>Client: expiresAt and epoch
                    end
                    Client->>Client: Generate up to 10 films from the manifest
                    Client->>MCP: prediction_batch_validate, 1 to 10 candidates, read-only preflight
                    MCP-->>Client: Per-film issues, no storage read or write, no run or lease
                    opt A candidate has issues
                        Client->>Client: Correct only what real knowledge supports, at most one re-preflight, otherwise a failure item
                    end
                    Client->>MCP: prediction_batch_submit, 1 to 10 items, runId and epoch
                    MCP->>Queue: Set the submit gate, an overlapping call gets submit_in_flight
                    MCP->>MCP: Validate each film, compare profile impact
                    loop Each valid film in order
                        MCP->>Store: Immutable body, then one D1 batch guarded by lease epoch and gate, then view index
                        MCP->>MCP: Save the film result in the run record
                    end
                    MCP->>Queue: One queue settlement for the call, clear the gate, renew lease
                    MCP-->>Client: Per-film results, partial success, a replay of the same body recovers a crash
                    opt Profile changed
                        MCP-->>Client: compatible films kept, impacted or unknown films needs_regeneration with no retry record
                    end
                end
                Client->>MCP: prediction_complete
                MCP->>Queue: Record completion, release lease
            end
        end
    end
    Note over Client,Store: A dry run with dryRun true ignores the lease, reads and validates the same way and writes nothing: no lease, run, queue or storage write
```

The `prediction_batch_validate` preflight ([ADR 0131](../adr/0131-batch-candidate-preflight-tool.md)) is a pure read of the contract validators: it touches no storage, run, lease, queue or profile and does not replace the validation of `batch_submit`, which stays authoritative and also checks the manifest, `inputHash` and live profile. The v5 `next` and `submit` refuse a v2 run, and `batch_submit` refuses a v5 run, so one run belongs to one protocol. A `batch_submit` is a sequence of per-film commits and one queue settlement, not an atomic unit; replaying the same body recovers a crash. A v2 run that stops leaves its unsubmitted films in the queue; the next `batch_start` selects them again, and a hot film that arrives mid-run waits for that start. Rollback is to disable the v2 Task and re-enable the v5 Task; no data moves.

## Queue writes

The prediction runner is one of several writers of the queue object `enrichment/prediction-queue.json`. Every writer, with or without a lease, goes through the same conditional write ([ADR 0064](../adr/0064-prediction-queue-conditional-writes.md), Accepted 2026-10-31).

```mermaid
flowchart TD
    runner["Prediction runner:<br/>start rebuilds;<br/>next, submit, complete<br/>advance the stored queue"]
    epg["EPG commit tail<br/>and EPG scan"]
    profile["Taste profile<br/>publication"]
    resolver["Discovery resolver<br/>checkpoint"]
    reconcile["Owner queue<br/>reconcile"]
    read["Read the queue<br/>and its etag"]
    kind{"Rebuild, or<br/>record one change?"}
    inputs["Read profile, view index,<br/>catalogue; published programme<br/>if the queue's generation differs"]
    build["Rebuild membership;<br/>carry retries, last batch<br/>and counters from the queue read"]
    amend["Apply the run's<br/>bookkeeping, if any"]
    change["Apply the change to<br/>the queue read; retry records<br/>only grow; written films<br/>leave the queue"]
    fence["Renew the caller's lease,<br/>if it holds one"]
    put{"Commit the queue:<br/>D1 generation when the schema v7 marker is d1,<br/>otherwise the object etag"}
    done["Queue written"]
    again["Short pause,<br/>start again"]
    conflict["prediction_queue_conflict:<br/>this caller writes nothing"]
    marked["Runner retry: the run record<br/>keeps it marked; the stop, else<br/>the next start, writes it first;<br/>until then no run starts"]
    runner --> read
    epg --> read
    profile --> read
    resolver --> read
    reconcile --> read
    read --> kind
    kind -->|rebuild| inputs
    inputs --> build
    build --> amend
    amend --> fence
    fence --> put
    kind -->|retry record<br/>or idle check| change
    change --> put
    put -->|yes| done
    put -->|no, attempts left| again
    again -.->|re-read| read
    put -->|no, after 5 attempts| conflict
    conflict -.->|runner failure| marked
```

The runner's `next`, `submit` and `complete` take the left branch only when the stored queue fails the advance gate (another programme, profile, contract or registry); otherwise they read the stored queue and record one change, so a Discovery chunk that moves the Discovery generation cannot fail them ([ADR 0113](../adr/0113-prediction-runner-advances-persisted-queue.md)). A conflict means another writer committed after this one read the queue. While the marker is not `d1`, that commit is the object etag. On schema version 7 or newer while this domain is installed and the marker is still `r2`, the writer records an intent with the generation claim and deletes it only after the put returns. A put that throws keeps the intent. A queue or lease head captured before these tables existed does not put after the marker is `d1`; the caller opens the head again. A load or activation that still sees the intent does not copy the snapshot. When the schema v7 marker is `d1`, the condition is the D1 generation, and the object is the mirror. The writer starts again from the stored queue, so no retry record, batch summary or counter is lost. A writer holding an older programme or profile cannot overwrite a newer queue. A put that throws has an unknown outcome and is not repeated. A runner failure is saved on the run record before the queue write, so a write that fails every attempt leaves it marked, not lost. The run's stop writes it again. If that fails too, the next start writes it before acquiring the runner lease, or starts nothing. Each caller's handling of `prediction_queue_conflict` is in the [runner reference](../reference/api/prediction-runner.md#queue-writes). Leases still serialize runs; they are not what keeps the queue consistent.

The [queue ADR](../adr/0015-queued-prediction-recovery.md) specifies hot priority, lease and retry limits. [Actual ratings](../reference/api/enrichment.md) remain independent evidence, not an answer passed into model prompts. The confirmed `watched` and `actualRating` values the catalogue exclusion reads follow the ratings marker ([ADR 0084](../adr/0084-d1-authoritative-ratings.md), Proposed). While migration `0010` is absent, or that marker is not `d1` with cutover `open`, they still come from the R2 view index. After that activation they come from `ratings_view`, and the R2 personal fields on the index do not compete. Prediction and fingerprint fields on the index stay. These diagrams do not change. No prediction run was started to draw this diagram.
