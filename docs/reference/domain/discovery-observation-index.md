# Discovery observation index

The observation index is a bounded projection of the current unresolved discovery observations of the published generation. It lets owner reads list or explain one observation without parsing the discovery ledger or the resolution map. The resolver chunk writes it. The limbo inventory, the per-observation recovery read and the guarded `discovery_reconsider` action read it. Decision: [ADR 0061](../../adr/0061-discovery-observation-index-and-reconsider.md).

Source: [`src/domain/discovery-observation-index.js`](../../../src/domain/discovery-observation-index.js) (pure: shapes, sharding, bounds, manifest, validation, freshness; bundled as `DiscoveryIndex`); the writer `saveObservationIndex` in [`src/discovery.js`](../../../src/discovery.js); the reader `discoveryIndexRead` in [`src/admin/discovery-recovery.js`](../../../src/admin/discovery-recovery.js). Tests: [`tests/discovery-observation-index.mjs`](../../../tests/discovery-observation-index.mjs).

## Layout

```text
epg/generations/<programmeRunId>/discovery-observations/
  manifest.json        written last
  shard-00.json … shard-15.json
```

An observation key goes to shard `FNV-1a(key) % 16`, computed over the key's UTF-16 code units. The number is used for placement only.

**Shard:** `{schemaVersion: 1, kind: "discovery_observation_shard", programmeRunId, shard: "NN", revision, items}`. `items` are sorted by key. `revision` is the SHA-256 of the canonical JSON of `items`, and the R2 object also carries it as custom metadata `revision`.

**Record:**

- identity and evidence: `key`, `programmeRunId`, `title`, `normalizedTitle`, `year`, `durations`, `shows` (`{channelId, channel, start}`, sorted by start);
- activity: `seenInLatestSnapshot`, `lastSeenAt`, `lastAiring`, `confirmedTmdbId`;
- `decision`: the shown subset `status`, `attempts`, `evidenceKey`, `retryAt`, `terminalReason`, `lastAttemptAt`, `checkedAt` and `reconsidered`;
- `decisionHash`: the SHA-256 of the canonical JSON (keys sorted) of the **full** decision.

`decisionHash` is the record version the guarded action compares.

**Manifest:** `{schemaVersion: 1, kind: "discovery_observation_index", programmeRunId, writtenAt, writer, sources, shardCount: 16, shards, coverage, counts}`.

- `writer`: `{kind, hopId, idempotencyKey}`, where `kind` is `resolver_chunk` or `discovery_reconsider`.
- `sources`: `{resolutionEtag, ledgerEtag}`, the R2 etags of `epg/discovery-resolution.json` and of the generation ledger `epg/generations/<run>/discovery-latest.json`, read by `head` just before the manifest is written.
- `shards`: `[{shard, items, revision}]`.
- `counts`: the discovery counts of the chunk plus `awaitingFirstLookup`.

## What is indexed

The scope is `current_unresolved_with_decision`. A candidate of the generation ledger is indexed when all of these hold:

- it is `current` by the resolver's own activity rule;
- the non-film screening passes for it;
- it has a decision;
- the decision is neither `verified` nor `excluded_nonfilm`.

A current, unscreened candidate with no decision is only counted, in `counts.awaitingFirstLookup`.

Bounds:

- at most 3,000 records;
- when the cap cuts, terminal records come first, then `ambiguous`, then `needs_verification`, then the rest, each in key order;
- a candidate with more than 96 shows, more than 24 durations or an unreadable show is omitted, not trimmed, because a trimmed record would no longer reproduce the resolver's evidence key.

`coverage` is `{scope, eligible, indexed, omitted: {cap, oversized, malformed}, complete, maxItems}`. The index is partial by construction: it never claims that an observation outside its scope is fine.

## Writer

`saveObservationIndex` runs at the end of every resolver chunk, after the status, the checkpoint and the score preview. It uses the decisions the chunk persisted: the in-memory copy, or the stored map when the chunk ended with an error.

1. It reads the generation pointer. It writes only when the pointer is `published` for the chunk's generation; otherwise it returns `generation_not_published`.
2. It builds the records, the digests and the shard revisions.
3. For each shard, it skips the put when a `head` shows the same revision in custom metadata. Otherwise it calls the resolver lease fence and writes the shard. The manifest alone cannot prove a shard current, because a writer may have stopped between a shard and its manifest.
4. It reads the map and the ledger etags with `head`, calls the fence and writes the manifest.

A lost lease (`LeaseLostError`) propagates as in every chunk write. Any other failure is logged as `{"event":"discovery_observation_index","written":false,…}` and swallowed. The chunk keeps its progress, and the previous manifest, whose source etags no longer match, reads as stale.

`discovery_reconsider` refreshes one record after its write. It rewrites the shard by compare-and-swap on the shard etag, then the manifest by compare-and-swap on the manifest etag, both behind the lease, and names the new map etag. When either compare-and-swap fails, the index stays stale until the next chunk.

## Reader states

`discoveryIndexRead(bucket, {key?, cached?})` reads:

- the pointer;
- the manifest;
- with `key`, only that key's shard; without it, every shard whose manifest count is not zero;
- the map and the ledger by `head`.

It never lists the bucket. When the manifest etag has not changed, it reuses an earlier result without `key` and cancels the manifest body.

| `state` | When | Offered to the owner |
| --- | --- | --- |
| `fresh` | Readable and both source etags equal the manifest's | Read and action |
| `stale` | Readable, but the map or the ledger etag moved, or could not be read (`reasons`: `resolution_changed`, `ledger_changed`, `resolution_unread`, `ledger_unread`) | Read as of `writtenAt`; no action |
| `missing` | No manifest for the published generation | Unavailable |
| `other_generation` | The manifest names another generation | Unavailable |
| `malformed` | A manifest or shard this module would not have written | Unavailable |
| `torn` | A shard whose revision or item count differs from the manifest, or a missing shard the manifest counts | Unavailable |
| `unavailable` | No published generation; in the limbo inventory also a storage failure (the recovery read answers 503 instead) | Unavailable |

An unavailable index is never read as "no unresolved observations".
