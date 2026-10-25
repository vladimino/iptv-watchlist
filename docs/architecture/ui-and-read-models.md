# UI and read-model projections

This diagram describes **current R2-backed projections**, not a new canonical Film database. The browser reads views assembled by the Worker from published programme data and enrichment records. Sources: [Film/Person read contract](../reference/domain/film-person.md), [enrichment API](../reference/api/enrichment.md), [prediction diagnostics](../reference/api/prediction-diagnostics.md), and [fingerprint/prediction ADR](../adr/0014-fingerprint-prediction-lifecycle.md).

```mermaid
flowchart LR
    subgraph Storage["Authoritative R2 objects"]
        programme["Published programme generation"]
        watchlist["Watchlist and metadata"]
        enrichment["Fingerprints, predictions and actual ratings"]
        index["Derived view index and prediction queue"]
    end
    subgraph Server["Cloudflare Worker read paths"]
        api["Programme and enrichment API"]
        combine["Assemble displayed film and availability"]
        ready["Readiness and prediction freshness"]
    end
    subgraph UI["Private owner browser"]
        shortlist["Programme and filtered film list"]
        details["Film detail page"]
        ratings["Predicted rating and actual rating"]
    end
    programme --> api
    watchlist --> api
    enrichment --> ready
    index --> ready
    api --> combine
    ready --> combine
    combine --> shortlist
    combine --> details
    ready --> ratings
    ratings --> details
```

The currently published programme generation determines which shows are available. A show is not a permanent Film property. The derived view index and prediction queue speed up views and work selection; neither owns Film identity or replaces stored fingerprints, predictions or actual ratings. Prediction freshness depends on fingerprint and taste-profile identity, not on a broadcast slot. Reviewed localization takes precedence over provisional titles, subject to the active read path.

**Important side-effect boundary:** do not assume all HTTP GET requests are pure reads. Some existing view/event handlers can initialize or recover persisted state; consult the [deployment runbook](../runbooks/deployment.md) and [GET side-effect tests](../../tests/get-side-effects.mjs) before operational probing.

**Not depicted as production:** D1 canonical repositories and a future read cutover. The [D1 migration ADR](../adr/0017-staged-d1-migration.md) requires separately approved steps before replacing R2 readers.
