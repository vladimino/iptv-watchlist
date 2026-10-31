# Prediction pipeline

The external ChatGPT caller performs model generation; the Worker manages the queue, profile, validation and R2 persistence. This diagram reflects the [runner contract](../reference/api/prediction-runner.md), [Film lifecycle](../reference/domain/film-person.md) and [profile ADR](../adr/0013-versioned-taste-profile.md).

```mermaid
sequenceDiagram
    actor Client as ChatGPT runner
    participant MCP as Worker MCP tools
    participant Queue as Prediction queue and lease
    participant R2 as Authoritative R2
    Client->>MCP: Read schema, published profile, runner status
    MCP->>R2: Read current profile version and hash
    R2-->>MCP: Versioned profile data
    MCP-->>Client: Published profile version and hash
    Client->>MCP: prediction_start (queued)
    MCP->>Queue: Acquire or check lease
    alt Already running
        Queue-->>MCP: already_running or busy
        MCP-->>Client: Run already active
    else New run
        loop While eligible items remain
            Client->>MCP: prediction_next (one film)
            MCP->>Queue: Select hot first and cold only after hot drained
            Queue-->>MCP: Film and current artifact facts
            MCP-->>Client: One eligible film
            Client->>Client: Reuse valid fingerprint or generate new one
            Client->>Client: Predict using published taste profile
            Client->>MCP: prediction_submit (one result or item failure)
            alt Valid output
                MCP->>R2: Persist fingerprint and prediction with provenance
                MCP->>Queue: Checkpoint completed item (conditional write)
            else Isolated invalid output
                MCP->>Queue: Record per-film failure and retryAt (conditional write)
            end
            opt Long model call
                Client->>MCP: prediction_heartbeat
                MCP->>Queue: Renew lease
            end
        end
        Client->>MCP: prediction_complete when required
        MCP->>Queue: Record completion in the rebuild's conditional write, release lease
    end
```

The fingerprint schema/hash tracks the film independently from a personal prediction, which also requires the current profile version/hash and prompt version. A profile change makes predictions stale without forcing a fingerprint regeneration; EPG showtimes do not invalidate either. The persist step writes the immutable content body and generation record first and then `fingerprint.json` as a pointer with provenance ([fingerprint compatibility](../reference/domain/fingerprint-compatibility.md#storage)); a declared fingerprint schema or prompt transition re-queues only the films it reaches, bounded within each batch, under the transition rule ([ADR-0035](../adr/0035-selective-fingerprint-transition-compatibility.md); no switch since [ADR 0047](../adr/0047-retire-fingerprint-compatibility-switch.md)), and a run ends when the Worker's versions change under it. One malformed film output is deferred with exponential backoff rather than discarding successes. This diagram is a conceptual view of the runner protocol, not an assertion that every branch occurs on each invocation.

The "Read schema" step and the "Isolated invalid output" branch share [one validation contract](../reference/api/enrichment.md#submit-validation-contract): the schema the client reads carries the exact rules the Worker validates with, and a rejected submit returns the violated field and code from that closed vocabulary alongside the per-film failure and `retryAt`. The Worker remains the only validator and the only writer; the client's preflight is a convenience that cannot admit a payload the Worker would reject.

## Queue writes

The prediction runner is one of several writers of the queue object `enrichment/prediction-queue.json`. Every writer, with or without a lease, goes through the same conditional write ([ADR 0061](../adr/0061-prediction-queue-conditional-writes.md), Proposed).

```mermaid
flowchart TD
    runner["Prediction runner: start, next, submit, complete"]
    epg["EPG commit tail and EPG scan"]
    profile["Taste profile publication"]
    resolver["Discovery resolver checkpoint"]
    reconcile["Owner queue reconcile"]
    read["Read the queue and its etag"]
    kind{"Rebuild, or record one change?"}
    inputs["Read profile, view index and catalogue; the published programme when the queue names another generation"]
    build["Rebuild membership; carry retries, last batch and counters from the queue just read"]
    amend["Apply the run's bookkeeping, if any"]
    change["Apply the change to the queue just read; retry records only grow"]
    fence["Renew the caller's lease, if it holds one"]
    put{"Conditional put: is the etag unchanged?"}
    done["Queue written"]
    conflict["prediction_queue_conflict: this caller writes nothing"]
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
    kind -->|retry record or idle check| change
    change --> put
    fence --> put
    put -->|yes| done
    put -->|no, attempts left| read
    put -->|no, after 5 attempts| conflict
```

A conflict means another writer committed after this one read the queue. The writer starts again from the stored queue, so no retry record, batch summary or counter is lost. A writer holding an older programme or profile cannot overwrite a newer queue. A put that throws has an unknown outcome and is not repeated. Each caller's handling of `prediction_queue_conflict` is in the [runner reference](../reference/api/prediction-runner.md#queue-writes). Leases still serialize runs; they are not what keeps the queue consistent.

The [queue ADR](../adr/0015-queued-prediction-recovery.md) specifies hot priority, lease and retry limits. [Actual ratings](../reference/api/enrichment.md) remain independent evidence, not an answer passed into model prompts. No prediction run was started to draw this diagram.
