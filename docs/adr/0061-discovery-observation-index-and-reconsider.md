# ADR 0061: Owner reads of one discovery observation use a generation-scoped index, and one guarded action lifts its terminal fence

**Status:** Proposed  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** owner scope change on PR #267 ([comment](https://github.com/vladimino/iptv-watchlist/pull/267#issuecomment-6540170794)); acceptance of this record is pending  
**Related work:** [AIR-282](https://trello.com/c/YpCzctKo); [PR #267](https://github.com/vladimino/iptv-watchlist/pull/267); [ADR 0006](0006-one-chunk-discovery.md); [ADR 0007](0007-persistent-discovery-evidence.md); [ADR 0034](0034-bounded-discovery-ledger.md)  
**Supersedes:** None. It replaces the NO-GO conclusion of the [dated analysis](../evidence/discovery-targeted-recovery-no-go-2026-10-31.md), which was evidence, not a decision record  
**Superseded by:** None

## Context

The owner could not see or act on one EPG observation that discovery gave up on. The analysis of 31 October 2026 found three obstacles:

- the candidate lives only inside the whole discovery ledger (tens of MB), so an owner read would have to parse it;
- the resolution decisions are one shared object without record versions, rewritten whole by every resolver chunk under the resolver lease;
- the only resolver route, `POST /api/enrichment/discovery/resolve`, runs a chunk over the global pending order and calls TMDB.

Most states need no action: the normal cycle already retries them, or a gate holds them for a reason. One state does not: a decision that became terminal (`repeated_uncertain_match`, `awaiting_confirmation`) on unchanged evidence stays out of the resolver's work until the EPG brings new airings. The owner asked for a production-capable way to send exactly such an observation back to the ordinary queue, with no TMDB call by the action itself.

## Decision

1. **A bounded observation index per published generation.** Each resolver chunk, after its checkpoint and score preview, writes `epg/generations/<run>/discovery-observations/`: sixteen shards (`shard-00` … `shard-15`, placed by FNV-1a of the key) and a `manifest.json` written last. It holds the current, unscreened observations whose decision is neither `verified` nor `excluded_nonfilm`, at most 3,000, terminal ones first. Each record carries the SHA-256 of its full decision (`decisionHash`). The manifest names every shard's revision, its coverage and the R2 etags of the resolution map and the generation ledger it was built from. The writer runs only for the published generation and only under the resolver lease (every put is fenced). It skips a shard whose stored revision is unchanged. Any failure except a lost lease is swallowed, so the chunk keeps its progress.
2. **Owner reads go through the index only.** `/api/admin/limbo` and `GET /api/admin/discovery-recovery` read the pointer, the manifest, the shards they need and the small coordination objects (continuation, status, lease). They compare the map and the ledger only by `head`. They never parse the ledger or the map body and never list the bucket. Their bucket wrapper has only `get` and `head`. An index that is missing, of another generation, malformed or torn makes observations **unavailable**, never "zero problems". When a source etag has moved since the index was written, the index is **stale**: it is shown, but no action is offered.
3. **One guarded write, `discovery_reconsider@1`, on the guarded action contract.** It is the first capability registered in the Worker. For one observation it clears `terminalReason` and `retryAt` of the decision and adds a `reconsidered` marker. `attempts`, `evidenceKey`, `status` and the scoring stay as they were, so the next ordinary chunk takes the observation once. An uncertain outcome on the same evidence makes it terminal again at once. The action is offered only when all of these hold:
   - the verdict is a confirmed `no_more_evidence` with a known terminal reason;
   - the index is fresh;
   - no resolver lease is live;
   - the series is not in a protected wait;
   - there is no TMDB throttle;
   - the identity is not ambiguous;
   - the configuration is not missing.
   
   Every other case names its refusal.
4. **Protection.** The action follows the contract's order:
   - a server-issued confirmation of the exact scope (pin and record digest), valid for 10 minutes and stored as the action record under `admin/actions/discovery_reconsider/v1/<idempotencyKey>.json`, created only if absent;
   - the resolver lease, refused when it is live or unreadable and never taken over when unreadable;
   - a fresh read under the lease, checked against the issued confirmation;
   - the map read with its etag and the decision compared by digest;
   - a `running` intent with the before-image stored before the write, behind a compare-and-swap;
   - a lease renewal as the fence, then the map written by compare-and-swap on the etag;
   - a read-back of the decision, a compare-and-swap refresh of its index shard and manifest, and the final receipt.
   
   A replay returns the stored receipt. A `running` intent without a receipt is reported as unknown and never redone. Nothing is retried automatically.
5. **Access.** The routes sit behind the Worker's existing owner-only Cloudflare Access application. The two POSTs also require the Access assertion header, the Worker's same-origin check, a custom `X-IPTV-Admin-Action` header and a JSON body. The Worker does not verify the assertion's signature: the edge application is the authority, as for every other owner route. No bypass, token or second login is added.

Not decided here:

- a TMDB lookup or a forced chunk by the action;
- an action on more than one observation, or on another decision state;
- an identity review tool;
- automatic compensation;
- writing the index at EPG publish.

Neither the acceptance of this record nor a deploy authorizes a production write. The first real application of the action is the owner's.

## Alternatives considered

- **Use a forced `POST /api/enrichment/discovery/resolve` as the retry.** Rejected: it is a series-level operation over other observations, with TMDB calls, and it still skips the terminal decision.
- **Look the one observation up from the action.** Rejected by the owner's scope: the action must not call TMDB. The ordinary chunk keeps its pacing, throttle and lease rules.
- **Read the ledger and the map on demand in the owner route.** Rejected: it reproduces the memory profile the discovery ledger split was made to escape, and gives no record version.
- **Write the index at EPG publish.** Deferred: the EPG commit is the most memory-constrained step. The chunk already holds the ledger and the decisions in memory and runs under the lease that fences the map.
- **A separate per-observation override object that the resolver honours.** Not chosen: it needs a second read in every chunk and a merge rule. A compare-and-swap on the map under the same lease the resolver writes with gives the same single-record guarantee.

## Consequences

- Each chunk adds one pointer read, up to 16 shard `head`s, two source `head`s, the changed shards and one manifest put. Unchanged shards are not rewritten.
- A new generation has no index until its first chunk, and the owner page says so. An EPG commit (new ledger) or the canonicalize route in `enrichment.js` (which writes the map without the resolver lease) leaves the index stale until the next chunk. The action then refuses: the index is not current, or the map etag differs.
- The index is partial by design. Observations with no decision yet are only counted (`awaitingFirstLookup`), and the coverage says how many were cut by the cap.
- The `reconsidered` marker lives on the decision until the next resolver attempt rewrites it. The action record keeps the history and the before-image.
- Action records accumulate under `admin/actions/`, one small object per confirmation. The offline importer classifies them as run records, and the index objects fall under the generation archive family.

## Recovery and migration boundary

Reverting the code stops both the index writes and the action. Index objects already written stay under their generation and are ignored. A decision that was already reconsidered stays reconsidered, and the next ordinary chunk decides it. Restoring the before-image is a separate owner-approved write; there is no automatic undo. No flag, Scheduled Task, Access policy or D1 object changes. Production use of the action, like any production write, needs the owner's explicit action-specific approval.

## Evidence

- **Original decision:** owner scope change on PR #267, 2026-10-31.
- **Implementation:**
  - `src/domain/discovery-observation-index.js`, `src/discovery.js` (the writer);
  - `src/domain/discovery-recovery.js`, `src/admin/discovery-recovery.js`, `src/admin/limbo.js`;
  - `src/admin/discovery-recovery-view.js`, `public/admin-limbo.js`.
  
  Tests: `tests/discovery-observation-index.mjs`, `tests/discovery-reconsider.mjs`, `tests/admin-discovery-recovery-page.mjs`, `tests/admin-limbo-api.mjs`, `tests/get-side-effects.mjs`.
- **Dated verification:** [analysis of 31 October 2026](../evidence/discovery-targeted-recovery-no-go-2026-10-31.md) for the obstacles; no production observation of the index or the action is recorded.
- **Uncertainty:**
  - how many observations production has in the terminal state;
  - the real size of the index for a production generation;
  - R2's behaviour under a concurrent conditional put, which the tests simulate rather than measure.

## Follow-ups

An identity review page for ambiguous observations. A retention rule for action records, if their number ever matters.
